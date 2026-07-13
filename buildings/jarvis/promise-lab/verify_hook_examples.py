#!/usr/bin/env python3
"""Verify the frozen holdout example problem and deterministic attribution trace."""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
def main() -> None:
    result = json.loads((CACHE / "hook-example-results.json").read_text(encoding="utf-8"))
    model = json.loads((CACHE / "hook-quality-model.json").read_text(encoding="utf-8"))
    assert result["status"] == "complete"
    assert result["evaluationOnly"] is True and result["examplesUsedForTraining"] is False
    assert result["deterministicReplay"]["identical"] is True
    assert result["deterministicReplay"]["runs"] == 2
    assert len(result["deterministicReplay"]["sha256"]) == 64
    assert len(result["examples"]) == 4 and len(result["pairwise"]) == 6
    machine = [row for row in result["examples"] if row["group"] == "machine-promise-variants"]
    expected_ranking = [row["id"] for row in sorted(
        machine, key=lambda row: (-float(row["summary"]["percentile"]), row["id"]),
    )]
    assert result["machineVariantResult"]["mainAxisRanking"] == expected_ranking
    assert result["machineVariantResult"]["winner"] == expected_ranking[0]
    training_texts = set(model["trainingTexts"])
    for row in result["examples"]:
        assert row["text"] not in training_texts
        score = row["score"]
        assert score["input"]["generativeLlmUsed"] is False
        count = int(score["partition"]["componentCount"])
        assert len(score["components"]) == count >= 1
        assert len(score["pairInteractions"]) == count * (count - 1) // 2
        assert len(score["localCounterfactuals"]["componentDeletions"]) == count
        assert len(score["localCounterfactuals"]["pairDeletions"]) == count * (count - 1) // 2
        assert score["partition"]["coverage"] == 1
        assert score["partition"]["overlapCount"] == 0
        assert all(value["attributionDefinition"] for value in score["components"])
        assert 0 <= float(score["score"]["percentile"]) <= 100
        assert score["score"]["validation"]["status"] == "normalization-and-time-sensitive-diagnostic"
        forward = score["forwardResponse"]
        assert forward["validatedAtComponentLevel"] is False
        assert forward["validationStatus"] == "random-fold-only-conditional-diagnostic"
        assert forward["metric"]["selectedLagSeconds"] >= 0
        assert len(forward["components"]) == count
        assert len(forward["relationships"]) == count * (count - 1) // 2
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
        assert all(value["validation"]["status"] == "random-fold-only-diagnostic"
                   for value in outcomes["hook"].values())
        assert len(outcomes["components"]) == count
        assert all(len(component["outcomePredictions"]) == 4
                   for component in score["components"])
        forecast = outcomes["retentionForecast"]
        assert forecast["status"] == "random-fold-only-diagnostic"
        assert forecast["normalizationAvailable"] is False
        assert "measured audience-retention curve" in forecast[
            "normalizationUnavailableReason"
        ]
        assert len(forecast["timesSeconds"]) == 41
        assert len(forecast["predictedPercent"]) == 41
        assert "rewatchAdjustedPredictedPercent" not in forecast
        assert forecast["responseEndSeconds"] < forecast["forecastEndSeconds"]
        assert forecast["responseLagSeconds"] == 0.0
        assert len(forecast["componentWindows"]) == count
        assert forecast["words"]
    winner_fraction = result["machineVariantResult"]["bootstrapWinnerFractions"]["unexpected-use"]
    assert 0 <= float(winner_fraction) <= 1
    print(json.dumps({
        "status": "verified",
        "ranking": expected_ranking,
        "winnerBootstrapFraction": winner_fraction,
        "deterministicSha256": result["deterministicReplay"]["sha256"],
    }, indent=2))


if __name__ == "__main__":
    main()
