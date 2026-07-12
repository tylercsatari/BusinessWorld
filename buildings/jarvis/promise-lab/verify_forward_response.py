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
    assert summary["status"] == model["status"] == "complete"
    assert summary["validated"] is True and model["validated"] is True
    contract = summary["metricContract"]
    assert contract["selectedLagSeconds"] >= 0
    assert contract["selectedCandidate"] == model["metricContract"]["selectedCandidate"]
    assert contract["anchor"] == "phrase"
    assert contract["causalClaim"] is False
    selection = summary["selection"]
    inference = selection["sourceInference"]
    assert inference["p"] <= .05 and inference["ciLow"] > 0
    assert selection["fixedSelectedMetricHeldoutSpearman"] > selection["maximumReverseTimeControlAbsRho"]
    assert all(value > 0 for value in selection["fixedSelectedMetricByCategory"].values())
    assert selection["lagBootstrap"]["medianLagSeconds"] == contract["selectedLagSeconds"]

    components = summary["components"]
    relationships = summary["relationships"]
    hooks = summary["hooks"]
    assert len(hooks) == 208 and len(components) == 832 and len(relationships) == 1248
    counts = Counter(row["videoId"] for row in components)
    assert set(counts.values()) == {4}
    exact = [row for row in components if row["spokenStartSeconds"] is not None]
    assert len(exact) == 812
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
        assert category_model["validation"]["heldoutSpearman"] > 0
    assert model["wholeHook"]["accepted"] is False
    assert model["directFullHookEmbeddingFalsification"]["accepted"] is False
    assert model["relationship"]["standaloneObservedResidualAudit"]["accepted"] is False
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
        "sourceSignFlipP": inference["p"],
        "componentRows": len(components),
        "relationshipRows": len(relationships),
        "exactTimedComponents": len(exact),
        "status": "verified",
    }, indent=2))


if __name__ == "__main__":
    main()
