#!/usr/bin/env python3
"""Verify the shared causal 20-second opening-prediction contract."""

from __future__ import annotations

import ast
import gzip
import json
from pathlib import Path

import numpy as np

from opening_predictor import FEATURE_VERSION, PREDICTOR_VERSION, views_from_retention5


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def close(left: float, right: float, tolerance: float = 1e-4) -> bool:
    return abs(float(left) - float(right)) <= tolerance


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
    opening = read(CACHE / "opening-20s.json")
    assert summary["status"] == model["status"] == "complete"
    assert summary["predictorVersion"] == model["predictorVersion"] == PREDICTOR_VERSION
    assert summary["featureVersion"] == model["featureVersion"] == FEATURE_VERSION
    assert summary["sources"] == model["trainingSources"] == opening["sourceVideos"] == 208
    assert len(summary["rows"]) == 208
    method = model["trainingMethod"]
    assert method["savedPredictionPolicy"] == "source-level out-of-fold at every second"
    assert method["typedPredictionPolicy"] == "same frozen per-second full fits"
    assert method["boundaryOutcomesUsed"] is False
    assert method["futureWordsUsedForEarlierPredictions"] is False
    assert set(model["families"]) == {"entryIndexed", "observedAbsolute"}
    assert set(model["endpointCandidates"]) == {"entryIndexed", "observedAbsolute"}
    assert model["viewsContract"]["promotionStatus"] in {"available", "withheld"}

    for family in model["families"].values():
        assert family["selectedStage"] == "semanticPrefix"
        temporal = family["temporalModels"]
        assert [int(row["second"]) for row in temporal] == list(range(1, 21))
        assert all(row["prefixOnly"] and not row["usesFutureWords"] for row in temporal)
        assert len(family["residualP10"]) == len(family["residualP90"]) == 21
    for family in model["endpointCandidates"].values():
        assert family["promotedStage"] is None
        assert set(family["stages"]) == {"semantic", "components", "relationships"}

    row_ids = set()
    for row in summary["rows"]:
        video_id = str(row["videoId"])
        assert video_id not in row_ids
        row_ids.add(video_id)
        detail = read_gzip(CACHE / "opening-predictions" / f"{video_id}.json.gz")
        lattice = read_gzip(CACHE / "opening-20s" / f"{video_id}.json.gz")
        assert len(row["components"]) == row["componentCount"]
        assert [component["text"] for component in row["components"]] == [
            component["text"] for component in detail["components"]
        ]
        assert detail["sourceKind"] == "saved-opening-20s-causal-oof"
        assert detail["predictorVersion"] == PREDICTOR_VERSION
        assert detail["featureVersion"] == FEATURE_VERSION
        assert detail["analysisHorizonSeconds"] == 20.0
        trace = detail["causalPrefixTrace"]
        assert [int(point["second"]) for point in trace] == list(range(1, 21))
        assert all(not point["usesWordsAfterThisSecond"] for point in trace)
        assert all(trace[index]["tokenCount"] <= trace[index + 1]["tokenCount"]
                   for index in range(19))
        assert detail["componentCount"] == len(detail["components"]) > 0
        components = detail["components"]
        assert int(components[0].get("startToken", components[0].get("start"))) == 0
        assert int(components[-1].get("endToken", components[-1].get("end"))) == detail["tokenCount"]
        for left, right in zip(components[:-1], components[1:]):
            assert int(left.get("endToken", left.get("end"))) == int(
                right.get("startToken", right.get("start"))
            )
        assert len(detail["relationships"]) == max(0, len(components) - 1)
        node_by_id = {node["id"]: node for node in lattice["nodes"]}
        attribution = detail["temporalAttribution"]
        assert len(attribution["steps"]) == 20
        assert len(attribution["componentLedger"]) == len(components)
        assert close(
            sum(item["predictedDeltaPoints"]
                for item in attribution["componentLedger"])
            + attribution["summary"]["unassignedTimeModelDeltaPoints"],
            attribution["summary"]["totalPredictedDeltaPoints"],
        )
        for step in attribution["steps"]:
            assert close(
                step["baselineDeltaPoints"] + step["semanticShapeDeltaPoints"],
                step["predictedDeltaPoints"],
            )
            if step["enteredComponents"]:
                assert close(
                    sum(item["predictedDeltaPoints"]
                        for item in step["enteredComponents"]),
                    step["predictedDeltaPoints"],
                )
        for component in components:
            assert len(component["categoryDistribution"]) == 4
            assert len(component["categoryCoordinates4D"]) == 4
            assert component["mapX"] is not None and component["mapY"] is not None
            assert component["timelineAttribution"] == attribution["componentLedger"][
                component["index"]
            ]
            node = node_by_id[component["nodeId"]]
            assert node["text"] == component["text"]
            assert node["representations"] and node["relations"]
        for curve in detail["curves"].values():
            assert curve["selectedStage"] == "semanticPrefix"
            assert set(curve["stages"]) == {"baseline", "semanticPrefix"}
            assert np.allclose(curve["predicted"], curve["stages"]["semanticPrefix"], atol=1e-5)
            assert len(curve["predicted"]) == len(curve["predictionP10"]) == 21
            assert len(curve["actual"]) == 21
        contribution = detail["contributions"]["at20Seconds"]
        assert contribution["selectedStage"] == "semanticPrefix"
        assert contribution["componentAndRelationshipCandidatesApplied"] is False
        assert close(contribution["finalPercent"], detail["outputs"]["retainedAtAnalyzedEndPercent"])
        replay = views_from_retention5(
            detail["outputs"]["absoluteRetention5sPercent"], model["viewsContract"],
        )
        assert close(replay["estimate"], detail["outputs"]["viewsDiagnostic"]["estimate"], 1.0)
        assert detail["outputs"]["viewsDiagnostic"]["promoted"] == bool(
            model["viewsContract"]["individualizedForecastAvailable"]
        )
        assert detail["actual"]["views"] > 0

    assert "sklearn" not in direct_imports(HERE / "opening_predictor.py")
    assert "sklearn" not in direct_imports(HERE / "score_hook.py")
    print(json.dumps({
        "status": "verified",
        "sources": len(row_ids),
        "horizonSeconds": 20,
        "causalTemporalModelsPerFamily": 20,
        "headlineStage": "semanticPrefix",
        "completeTemporalAttribution": True,
        "componentsLinkedToSavedEmbeddingAndLattice": True,
        "viewsPromotionStatus": model["viewsContract"]["promotionStatus"],
        "servingImportsSklearn": False,
    }, indent=2))


if __name__ == "__main__":
    main()
