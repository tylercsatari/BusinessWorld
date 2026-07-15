#!/usr/bin/env python3
"""Verify the variable-horizon four-cluster Shorts sequence predictor."""

from __future__ import annotations

import ast
import gzip
import json
import math
from pathlib import Path

from opening_predictor import FEATURE_VERSION, PREDICTOR_VERSION


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STAGES = ("timing", "semantic", "components", "relationships")
CHANNELS = ("baseline", *STAGES)


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def close(left: float, right: float, tolerance: float = 1e-4) -> bool:
    return math.isclose(float(left), float(right), abs_tol=tolerance)


def direct_imports(path: Path) -> set[str]:
    source = ast.parse(path.read_text(encoding="utf-8"))
    imports = set()
    for node in ast.walk(source):
        if isinstance(node, ast.Import):
            imports.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.add(str(node.module or "").split(".")[0])
    return imports


def main() -> None:
    summary = read(CACHE / "opening-predictions.json")
    model = read(CACHE / "opening-retention-model.json")
    context = read(CACHE / "opening-context-study.json")
    measured_source = read(CACHE / "opening-20s.json")

    assert summary["status"] == model["status"] == context["status"] == "complete"
    assert summary["version"] == model["version"] == 3
    assert summary["predictorVersion"] == model["predictorVersion"] == PREDICTOR_VERSION
    assert summary["featureVersion"] == model["featureVersion"] == FEATURE_VERSION
    assert summary["sources"] == model["trainingSources"] == 208
    assert measured_source["sourceVideos"] == 208
    assert len(summary["rows"]) == 208
    assert summary["structurallyUncapped"] is True
    assert model["support"]["structurallyUncapped"] is True
    assert model["support"]["structuralInputTokenLimit"] is None

    method = model["trainingMethod"]
    assert method["candidateStage"] == "relationships"
    assert method["stageOrder"] == list(STAGES)
    assert method["savedPredictionPolicy"] == (
        "source-level out-of-fold at every supported second"
    )
    assert method["typedPredictionPolicy"] == "same frozen per-second full fits"
    assert method["boundaryOutcomesUsed"] is False
    assert method["futureWordsUsedForEarlierPredictions"] is False
    assert method["externalIdeaContextUsed"] is False
    assert model["featureContract"]["sameBuilderForSavedAndTyped"] is True
    assert model["featureContract"]["canonicalCover"].startswith("exact")
    assert set(model["families"]) == {"entryIndexed", "observedAbsolute"}
    assert float(model["support"]["meanWordsPerSecond"]) > 0
    assert model["support"]["speakingRateSourceCount"] == 208

    risk_rows = summary["riskSetBySecond"]
    assert risk_rows
    risk_counts = [int(row["riskSetSources"]) for row in risk_rows]
    assert all(left >= right for left, right in zip(risk_counts, risk_counts[1:]))
    assert risk_counts[0] == 208

    temporal_count = None
    for family in model["families"].values():
        promotion = family["promotion"]
        assert family["candidateStage"] == promotion["candidateStage"] == "relationships"
        assert family["selectedStage"] == family["headlineStage"] == promotion["selectedStage"]
        assert family["selectedStage"] in {"baseline", "relationships"}
        assert promotion["stageShoppingAllowed"] is False
        if not promotion["promoted"]:
            assert family["selectedStage"] == "baseline"
        assert family["stageOrder"] == list(STAGES)
        temporal = family["temporalModels"]
        assert [int(row["second"]) for row in temporal] == list(
            range(1, len(temporal) + 1)
        )
        temporal_count = len(temporal) if temporal_count is None else temporal_count
        assert temporal_count == len(temporal)
        for row in temporal:
            assert row["prefixOnly"] and not row["usesFutureWords"]
            assert row["categories"] == 4
            if row["headlineModelAvailable"]:
                assert row["fullNestedAblationAvailable"]
                assert set(row["stages"]) == set(STAGES)
                assert all(row["stages"][stage]["model"] for stage in STAGES)
                assert row["residualP10"] is not None
                assert row["residualP90"] is not None

    assert context["categoryCount"] == 4
    assert context["categoriesChanged"] is False
    assert set(context["testedForwardLagsSeconds"]) == set(range(6))
    assert {row["category"] for row in context["categories"]} == {0, 1, 2, 3}
    for category in context["categories"]:
        assert category["primaryOutcomePlane"]["points"]
        assert set(category["outcomePlanesByLag"]) == {str(value) for value in range(6)}
        for experiment in category["lagExperiments"]:
            assert experiment["status"] == "complete"
            assert experiment["outcomePlane"]["points"]
            assert experiment["outcomePlane"]["coordinatesOutOfFold"] is False
            assert experiment["outcomePlane"]["pointPredictionsOutOfFold"] is True
            chronological = experiment["stageValidation"]["viewerContext"]["chronological"]
            assert chronological["available"] is True
            assert chronological["rows"] > 0

    observed_chronological = model["families"]["observedAbsolute"][
        "candidateChronologicalValidation"
    ]
    assert observed_chronological["perSecond"][0]["evaluatedSources"] == 0
    assert observed_chronological["evaluatedSources"] < 208

    row_ids = set()
    total_components = 0
    for row in summary["rows"]:
        video_id = str(row["videoId"])
        assert video_id not in row_ids
        row_ids.add(video_id)
        detail = read_gzip(CACHE / "opening-predictions" / f"{video_id}.json.gz")
        assert detail["version"] == 3
        assert detail["sourceKind"] == "saved-full-sequence-variable-horizon-oof"
        assert detail["predictorVersion"] == PREDICTOR_VERSION
        assert detail["featureVersion"] == FEATURE_VERSION
        assert detail["analysisHorizonSeconds"] >= detail["forecastHorizonSeconds"]
        assert detail["modelHorizonSeconds"] == model["analysisHorizonSeconds"]
        assert detail["support"]["structurallyUncapped"] is True
        assert detail["support"]["servedForecastThroughSeconds"] == detail[
            "forecastHorizonSeconds"
        ]
        assert len(row["components"]) == row["componentCount"]
        assert [component["text"] for component in row["components"]] == [
            component["text"] for component in detail["components"]
        ]

        trace = detail["causalPrefixTrace"]
        assert all(not point["usesWordsAfterThisSecond"] for point in trace)
        assert all(trace[index]["tokenCount"] <= trace[index + 1]["tokenCount"]
                   for index in range(len(trace) - 1))
        components = detail["components"]
        total_components += len(components)
        assert detail["componentCount"] == len(components) > 0
        assert components[0]["startToken"] == 0
        assert components[-1]["endToken"] == detail["tokenCount"]
        assert all(left["endToken"] == right["startToken"]
                   for left, right in zip(components, components[1:]))
        assert len(detail["relationships"]) == max(0, len(components) - 1)
        for index, component in enumerate(components):
            assert component["index"] == index
            assert component["category"] in range(4)
            assert len(component["categoryDistribution"]) == 4
            assert len(component["categoryCoordinates4D"]) == 4
            assert component["timelineAttribution"] is not None
            assert component["outcomePlane"] is not None
            assert set(component["outcomePlanesByLag"]) == {
                str(value) for value in range(6)
            }
            viewer = component["viewerContext"]
            assert viewer["position"] == index
            assert viewer["componentsPreviouslyDelivered"] == index
            assert viewer["usesFutureComponents"] is False
            assert viewer["externalIdeaContextUsed"] is False

        attribution = detail["temporalAttribution"]
        assert attribution["fullStageLadderAvailable"] is True
        assert attribution["channelOrder"] == list(CHANNELS)
        assert len(attribution["steps"]) == len(attribution["timesSeconds"]) - 1
        assert len(attribution["componentLedger"]) == len(components)
        for step in attribution["steps"]:
            assert set(step["channelDeltaPoints"]) == set(CHANNELS)
            assert close(
                sum(step["channelDeltaPoints"].values()),
                step["predictedDeltaPoints"],
            )
        totals = attribution["summary"]
        assert close(
            sum(totals["totalChannelDeltaPoints"].values()),
            totals["totalPredictedDeltaPoints"],
        )
        assert detail["orderSensitivity"]["status"] == "complete"
        assert "model sensitivity" in detail["orderSensitivity"]["claimBoundary"]
        assert close(
            sum(item["predictedDeltaPoints"]
                for item in attribution["componentLedger"])
            + totals["unassignedTimeModelDeltaPoints"],
            totals["totalPredictedDeltaPoints"],
        )

        for curve in detail["curves"].values():
            assert curve["selectedStage"] in {"baseline", "relationships"}
            assert set(curve["stages"]) == {"baseline", *STAGES}
            finite = [index for index, value in enumerate(curve["predicted"])
                      if value is not None]
            assert finite and finite[-1] == int(detail["forecastHorizonSeconds"])
            assert all(curve["predicted"][index] is not None for index in finite)
            assert all(curve["predicted"][index] is None
                       for index in range(finite[-1] + 1, len(curve["predicted"])))
            assert all(close(curve["predicted"][index],
                             curve["stages"][curve["selectedStage"]][index])
                       for index in finite)

        assert close(
            detail["outputs"]["retainedAtForecastEndPercent"],
            detail["curves"]["entryIndexed"]["predicted"][
                int(detail["forecastHorizonSeconds"])
            ],
        )
        diagnostic = detail["outputs"].get("viewsDiagnostic")
        if diagnostic:
            assert diagnostic["promoted"] is False
            assert diagnostic["status"] == "diagnostic only"
        assert detail["actual"]["views"] > 0

    for path in ("opening_predictor.py", "score_hook.py", "context_scoring.py"):
        assert "sklearn" not in direct_imports(HERE / path)
    print(json.dumps({
        "status": "verified",
        "sources": len(row_ids),
        "components": total_components,
        "modelHorizonSeconds": model["analysisHorizonSeconds"],
        "temporalModelsPerFamily": temporal_count,
        "selectedStages": {
            name: family["selectedStage"]
            for name, family in model["families"].items()
        },
        "structurallyUncapped": True,
        "durationConditionedRiskSet": True,
        "completeTemporalAttribution": True,
        "categoryLagOutcomePlanes": 24,
        "servingImportsSklearn": False,
    }, indent=2))


if __name__ == "__main__":
    main()
