#!/usr/bin/env python3
"""Verify the persisted forward-response contract and every scored training row."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def read(name: str):
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def main() -> None:
    summary = read("forward-response.json")
    model = read("forward-response-model.json")
    hook_quality = read("hook-quality.json")
    hook_model = read("hook-quality-model.json")
    partitions = read("canonical-partitions.json")
    corpus_count = len(read("corpus.json")["rows"])
    assert summary["status"] == model["status"] == "complete"
    assert summary["validated"] == model["validated"]
    assert summary["validationStatus"] == model["validationStatus"]
    assert summary["validationStatus"] == (
        "validated-random-and-future"
        if summary["validated"] else "random-fold-only-conditional-diagnostic"
    )
    assert "post-hoc manual-probe-selected" in summary["categoryClaimStatus"]
    contract = summary["metricContract"]
    assert contract["selectedLagSeconds"] >= 0
    assert contract["selectedCandidate"] == model["metricContract"]["selectedCandidate"]
    assert contract["anchor"] == "phrase"
    assert contract["causalClaim"] is False
    selection = summary["selection"]
    inference = selection["sourceInference"]
    assert "equal-category Fisher-mean" in inference["policy"]
    assert abs(inference["rho"] - selection["nestedHeldoutCategoryBalancedSpearman"]) < 1e-6
    chronological = selection["chronological"]
    assert chronological["validationDesign"].startswith("expanding-window")
    assert chronological["evaluatedRows"] > 0

    components = summary["components"]
    relationships = summary["relationships"]
    hooks = summary["hooks"]
    assert len(hooks) == corpus_count == len(partitions["rows"])
    assert len(components) == partitions["chunks"]
    assert len(relationships) == sum(
        int(row["componentCount"]) * (int(row["componentCount"]) - 1) // 2
        for row in partitions["rows"]
    )
    counts = Counter(row["videoId"] for row in components)
    assert len(set(counts.values())) > 1
    assert counts == Counter({
        str(row["videoId"]): int(row["componentCount"]) for row in partitions["rows"]
    })
    exact = [row for row in components if row["spokenStartSeconds"] is not None]
    assert len(exact) == summary["timingAudit"]["componentsWithExactPositiveDuration"]
    for row in exact:
        spoken_width = row["spokenEndSeconds"] - row["spokenStartSeconds"]
        response_width = row["responseWindowEndSeconds"] - row["responseWindowStartSeconds"]
        assert abs(spoken_width - response_width) < 1e-5
        assert abs(
            row["responseWindowStartSeconds"] - row["spokenStartSeconds"]
            - contract["selectedLagSeconds"]
        ) < 1e-5
        assert row["unexpectedObservedSlope"] is not None
        assert row["predictedUnexpectedSlopeOOF"] is not None
        assert 0 <= row["axisPercentile"] <= 100

    for category, category_model in model["component"]["modelsByCategory"].items():
        direction = np.asarray(category_model["direction"], float)
        assert len(direction) == 3072
        assert abs(np.linalg.norm(direction) - 1) < 1e-5
        assert np.isfinite(category_model["validation"]["heldoutSpearman"])
    for result in (
        model["wholeHook"], model["directFullHookEmbeddingFalsification"],
        model["relationship"]["standaloneObservedResidualAudit"],
    ):
        assert isinstance(result["accepted"], bool)
    assert all(row["responseAxisInteraction"] is not None for row in relationships)
    assert all(0 <= row["responseInteractionPercentile"] <= 100 for row in relationships)

    assert hook_quality["forwardResponse"]["methodVersion"] == summary["methodVersion"]
    assert hook_model["forwardResponse"]["methodVersion"] == model["methodVersion"]
    assert hook_quality["model"]["scoreLabel"] == "Hook retained-information percentile"
    assert hook_model.get("primaryScore") != "forwardResponse.wholeHook"
    print(json.dumps({
        "selectedLagSeconds": contract["selectedLagSeconds"],
        "nestedHeldoutSpearman": selection["nestedHeldoutCategoryBalancedSpearman"],
        "fixedHeldoutSpearman": selection["fixedSelectedMetricHeldoutSpearman"],
        "categoryBalancedP": inference["p"],
        "validationStatus": summary["validationStatus"],
        "componentRows": len(components),
        "relationshipRows": len(relationships),
        "exactTimedComponents": len(exact),
        "status": "verified",
    }, indent=2))


if __name__ == "__main__":
    main()
