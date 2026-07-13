#!/usr/bin/env python3
"""Verify the stored hook outcome and retention forecast contract."""

import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def main() -> None:
    artifact = json.loads((CACHE / "hook-outcomes.json").read_text(encoding="utf-8"))
    model = json.loads((CACHE / "hook-outcome-model.json").read_text(encoding="utf-8"))
    partitions = json.loads((CACHE / "canonical-partitions.json").read_text(encoding="utf-8"))
    assert artifact["status"] == model["status"] == "complete"
    assert artifact["methodVersion"] == model["methodVersion"]
    assert artifact["audit"]["hooks"] == 208
    assert artifact["audit"]["components"] == partitions["chunks"]
    assert artifact["audit"]["relationships"] == sum(
        int(row["componentCount"]) * (int(row["componentCount"]) - 1) // 2
        for row in partitions["rows"]
    )
    assert artifact["audit"]["componentCoverageFailures"] == 0
    assert artifact["audit"]["wordEmbeddingPoints"] == len(
        artifact["wordEmbeddingAtlas"]["points"]
    )
    assert artifact["audit"]["fullHookEmbeddingPoints"] == 208
    assert len(artifact["wordEmbeddingAtlas"]["categories"]) == artifact["audit"][
        "wordEmbeddingPoints"
    ]
    assert len(artifact["targets"]) == 4
    assert len(artifact["hooks"]) == 208
    assert all(len(row["components"]) == int(row["componentCount"])
               for row in artifact["hooks"])
    assert all(len(row["relationships"]) == int(row["componentCount"])
               * (int(row["componentCount"]) - 1) // 2
               for row in artifact["hooks"])
    assert len(set(int(row["componentCount"]) for row in artifact["hooks"])) > 1
    assert all(len(row["retentionForecast"]["timesSeconds"]) == 41
               for row in artifact["hooks"])
    assert all(len(row["outcomes"]) == 4 for row in artifact["hooks"])
    assert all(len(row["outcomes"]) == 4 for hook in artifact["hooks"]
               for row in hook["components"])
    assert artifact["curveModel"]["validation"]["maeImprovementFraction"] > 0
    assert artifact["curveModel"]["validation"]["pairedImprovementInference"]["p"] <= .05
    survival = artifact["survivalModel"]
    validation = survival["validation"]
    sensitivity = survival["normalizationSensitivity"]
    assert validation["status"] == "normalization-and-time-sensitive-diagnostic"
    assert artifact["survivalModel"]["validation"]["heldoutSpearman"] > 0
    assert artifact["survivalModel"]["validation"]["maeImprovementFraction"] > 0
    assert validation["chronologicalValidation"]["heldoutSpearman"] < 0
    assert validation["chronologicalValidation"]["maeImprovementFraction"] < 0
    assert sensitivity["robustAcrossNormalizationChoices"] is False
    assert sensitivity["temporalRobustAcrossBlockCounts"] is False
    assert len(sensitivity["chronologicalBlockSensitivity"]) == 5
    assert artifact["curveModel"]["rewatchAdjustedValidation"]["status"] == "random-fold-only-diagnostic"
    assert all(
        row["validation"]["status"] == "random-fold-only-diagnostic"
        for row in artifact["hookModels"].values()
    )
    for component_model in artifact["componentModels"].values():
        aggregate = component_model["sourceAggregateValidation"]
        assert aggregate["status"] == "random-fold-only-conditional-diagnostic"
        assert "no chronological" in aggregate["claimBoundary"]
        for category_validation in component_model["validationByCategory"].values():
            assert category_validation["status"] == "random-fold-only-conditional-diagnostic"
    assert artifact["rewatchAudit"]["scope"]["videosShorterThan20Seconds"] == 0
    assert artifact["rewatchAudit"]["entryInflationVsTerminal"]["spearman"] > .8
    assert artifact["rewatchAudit"]["normalization"]["fittedDecayParameters"] == 0
    geometry = artifact["rewatchAudit"]["geometryValidation"]
    assert geometry["maximumStartErrorPercentagePoints"] < 1e-5
    assert geometry["negativeCorrectionValues"] == 0
    assert geometry["correctionInducedIncreaseIntervals"] == 0
    assert geometry["maximumFullVideoEndpointCorrectionPercentagePoints"] < .1
    assert all(row["survivalScore"]["validationStatus"]
               == "normalization-and-time-sensitive-diagnostic"
               for row in artifact["hooks"])
    assert all(row["retentionForecast"]["normalizationAvailable"] is True
               for row in artifact["hooks"])
    assert all(abs(row["retentionForecast"]["rewatchAdjustedActualPercent"][0] - 100) < 1e-6
               for row in artifact["hooks"])
    assert all(len(row["retentionForecast"]["replayCorrectionPercent"]) == 41
               for row in artifact["hooks"])
    assert all(len(row["retentionForecast"]["componentWindows"])
               == int(row["componentCount"]) for row in artifact["hooks"])
    assert all(row["retentionForecast"]["forecastInput"]["outputCluster"] is None
               for row in artifact["hooks"])
    assert all(0 <= int(row["retentionForecast"]["forecastInput"]["category"]) <= 3
               for row in artifact["hooks"])
    assert all(0 <= int(window["category"]) <= 3
               for row in artifact["hooks"]
               for window in row["retentionForecast"]["componentWindows"])
    assert all(
        len(word["observedForecastDeletionContributionByTime"]) == 41
        and len(word["rewatchAdjustedForecastDeletionContributionByTime"]) == 41
        and 0 <= int(word["singletonCategory"]) <= 3
        and 0 <= int(word["componentCategory"]) <= 3
        for row in artifact["hooks"] for word in row["retentionForecast"]["words"]
    )
    assert all(row["retentionForecast"]["responseEndSeconds"] < 20
               for row in artifact["hooks"])
    assert artifact["curveModel"]["speakingRate"]["exactTimedHooks"] >= 200
    assert artifact["curveModel"]["responseLagContract"]["componentLagValidated"] is False
    assert artifact["curveModel"]["responseLagSeconds"] == 0
    print(json.dumps({
        "status": "verified",
        "hooks": artifact["audit"]["hooks"],
        "components": artifact["audit"]["components"],
        "relationships": artifact["audit"]["relationships"],
        "curveMAE": artifact["curveModel"]["validation"]["heldoutMAEPercentagePoints"],
        "curveBaselineMAE": artifact["curveModel"]["validation"]["baselineMAEPercentagePoints"],
        "survivalRho": artifact["survivalModel"]["validation"]["heldoutSpearman"],
        "rewatchAdjustedCurveRho": artifact["curveModel"]["rewatchAdjustedValidation"]["meanTimewiseSpearman"],
        "speakingRate": artifact["curveModel"]["speakingRate"]["meanWordsPerSecond"],
    }, indent=2))


if __name__ == "__main__":
    main()
