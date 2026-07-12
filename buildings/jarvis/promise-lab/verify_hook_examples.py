#!/usr/bin/env python3
"""Verify the frozen holdout example problem and deterministic attribution trace."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
EXPECTED_MACHINE_RANKING = ["unexpected-use", "second-feature", "mechanism-question"]


def main() -> None:
    result = json.loads((CACHE / "hook-example-results.json").read_text(encoding="utf-8"))
    model = json.loads((CACHE / "hook-quality-model.json").read_text(encoding="utf-8"))
    assert result["status"] == "complete"
    assert result["evaluationOnly"] is True and result["examplesUsedForTraining"] is False
    assert result["deterministicReplay"]["identical"] is True
    assert result["deterministicReplay"]["runs"] == 2
    assert len(result["deterministicReplay"]["sha256"]) == 64
    assert len(result["examples"]) == 4 and len(result["pairwise"]) == 6
    assert result["machineVariantResult"]["mainAxisRanking"] == EXPECTED_MACHINE_RANKING
    assert result["machineVariantResult"]["winner"] == EXPECTED_MACHINE_RANKING[0]
    training_texts = set(model["trainingTexts"])
    for row in result["examples"]:
        assert row["text"] not in training_texts
        score = row["score"]
        assert score["input"]["generativeLlmUsed"] is False
        assert len(score["components"]) == 4
        assert len(score["pairInteractions"]) == 6
        assert len(score["subsets"]) == 15
        assert score["partition"]["coverage"] == 1
        assert score["partition"]["overlapCount"] == 0
        contribution = sum(float(value["shapleyAxisContribution"])
                           for value in score["components"])
        assert np.isclose(contribution, float(score["score"]["axisCoordinate"]), atol=1e-7)
        assert 0 <= float(score["score"]["percentile"]) <= 100
        forward = score["forwardResponse"]
        assert forward["validatedAtComponentLevel"] is True
        assert forward["metric"]["selectedLagSeconds"] == 1.0
        assert len(forward["components"]) == 4
        assert len(forward["relationships"]) == 6
        assert all(0 <= float(value["percentile"]) <= 100
                   for value in forward["components"])
        assert all(0 <= float(value["percentile"]) <= 100
                   for value in forward["relationships"])
        assert forward["exploratoryWholeHookComposite"]["accepted"] is False
        outcomes = score["outcomes"]
        assert outcomes["status"] == "complete"
        assert set(outcomes["hook"]) == {
            "viewed_percent", "retention_5s", "average_retention", "log_views",
        }
        assert all(value["validation"]["status"] == "validated"
                   for value in outcomes["hook"].values())
        assert len(outcomes["components"]) == 4
        assert all(len(component["outcomePredictions"]) == 4
                   for component in score["components"])
        forecast = outcomes["retentionForecast"]
        assert forecast["status"] == "validated-rough-forecast"
        assert len(forecast["timesSeconds"]) == 41
        assert len(forecast["predictedPercent"]) == 41
        assert forecast["responseLagSeconds"] == 1.0
        assert len(forecast["componentWindows"]) == 4
        assert forecast["words"]
    winner_fraction = result["machineVariantResult"]["bootstrapWinnerFractions"]["unexpected-use"]
    assert 0 <= float(winner_fraction) <= 1
    print(json.dumps({
        "status": "verified",
        "ranking": EXPECTED_MACHINE_RANKING,
        "winnerBootstrapFraction": winner_fraction,
        "deterministicSha256": result["deterministicReplay"]["sha256"],
    }, indent=2))


if __name__ == "__main__":
    main()
