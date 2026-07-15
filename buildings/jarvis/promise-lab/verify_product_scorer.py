#!/usr/bin/env python3
"""Canary that typed and saved sequences share the variable-horizon contract."""

from __future__ import annotations

import builtins
import gzip
import json
import subprocess
import sys
from pathlib import Path

from score_hook import score_text


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
CHANNELS = {"baseline", "timing", "semantic", "components", "relationships"}


def read(name: str) -> dict:
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def read_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def exact_cover(payload: dict) -> bool:
    owners = [0] * int(payload["tokenCount"])
    for component in payload["components"]:
        start = int(component.get("startToken", component.get("start")))
        end = int(component.get("endToken", component.get("end")))
        for token in range(start, end):
            owners[token] += 1
    return owners == [1] * len(owners)


def verify_attribution(payload: dict) -> None:
    attribution = payload["temporalAttribution"]
    assert attribution["fullStageLadderAvailable"] is True
    assert set(attribution["channelOrder"]) == CHANNELS
    assert len(attribution["steps"]) == len(attribution["timesSeconds"]) - 1
    assert len(attribution["componentLedger"]) == payload["componentCount"]
    for step in attribution["steps"]:
        assert set(step["channelDeltaPoints"]) == CHANNELS
        assert abs(
            sum(step["channelDeltaPoints"].values())
            - step["predictedDeltaPoints"]
        ) < 1e-4
    assert abs(
        sum(row["predictedDeltaPoints"]
            for row in attribution["componentLedger"])
        + attribution["summary"]["unassignedTimeModelDeltaPoints"]
        - attribution["summary"]["totalPredictedDeltaPoints"]
    ) < 1e-4


def main() -> None:
    summary = read("opening-predictions.json")
    source = min(summary["rows"], key=lambda row: (int(row["tokenCount"]), row["videoId"]))
    saved = read_gzip(
        CACHE / "opening-predictions" / f"{source['videoId']}.json.gz"
    )
    typed = score_text(
        saved["text"], planned_duration_seconds=saved["analysisHorizonSeconds"],
    )
    automatic = score_text(saved["text"])

    assert typed["predictorVersion"] == saved["predictorVersion"]
    assert typed["featureVersion"] == saved["featureVersion"]
    assert typed["sourceKind"] == "typed-variable-horizon-four-cluster-full-fit"
    assert saved["sourceKind"] == "saved-full-sequence-variable-horizon-oof"
    assert typed["analysisHorizonSeconds"] == saved["analysisHorizonSeconds"]
    assert typed["forecastHorizonSeconds"] <= typed["analysisHorizonSeconds"]
    assert saved["forecastHorizonSeconds"] <= saved["analysisHorizonSeconds"]
    assert exact_cover(typed) and exact_cover(saved)
    assert typed["componentCount"] == saved["componentCount"]
    assert [row["text"] for row in typed["components"]] == [
        row["text"] for row in saved["components"]
    ]
    assert [row["category"] for row in typed["components"]] == [
        row["category"] for row in saved["components"]
    ]
    for payload in (typed, saved):
        assert payload["provenance"]["futureWordsUsedForEarlierPredictions"] is False
        assert payload["provenance"]["sameTemporalModelFamilyAsSavedLibrary"] is True
        assert payload["provenance"]["externalIdeaContextUsed"] is False
        assert payload["support"]["structurallyUncapped"] is True
        assert payload["support"]["servedForecastThroughSeconds"] == payload[
            "forecastHorizonSeconds"
        ]
        assert len(payload["relationships"]) == max(0, payload["componentCount"] - 1)
        assert payload["orderSensitivity"]["status"] == "complete"
        assert "model sensitivity" in payload["orderSensitivity"]["claimBoundary"]
        verify_attribution(payload)
        for index, component in enumerate(payload["components"]):
            assert component["index"] == index
            assert len(component["categoryDistribution"]) == 4
            assert len(component["categoryCoordinates4D"]) == 4
            assert component["timelineAttribution"] == payload[
                "temporalAttribution"
            ]["componentLedger"][index]
            assert component["outcomePlane"] is not None
            assert set(component["outcomePlanesByLag"]) == {
                str(value) for value in range(6)
            }
            assert component["viewerContext"]["componentsPreviouslyDelivered"] == index
            assert component["viewerContext"]["usesFutureComponents"] is False

    assert typed["componentLattice"]["globalAllSpanRowsMaterialized"] is False
    assert typed["provenance"]["syntheticOrderChangesAreCausalClaims"] is False
    assert typed["temporalAttribution"]["selectedStage"] in {"baseline", "relationships"}
    assert saved["temporalAttribution"]["selectedStage"] in {"baseline", "relationships"}
    diagnostic = typed["outputs"].get("viewsDiagnostic")
    if diagnostic:
        assert diagnostic["status"] == "diagnostic only"
        assert diagnostic["promoted"] is False
    for row in typed["causalPrefixTrace"]:
        assert int(row["tokenCount"]) <= int(typed["tokenCount"])

    mean_rate = float(automatic["input"]["wordsPerSecond"])
    assert automatic["input"]["plannedSpokenSeconds"] is None
    assert automatic["input"]["timingEstimated"] is True
    assert automatic["input"]["inputWasTruncated"] is False
    assert automatic["input"]["structurallyUncapped"] is True
    assert "mean speaking rate across 208 source videos" in automatic["input"][
        "timingSource"
    ]
    assert exact_cover(automatic)

    code = """
import builtins
real_import = builtins.__import__
def blocked(name, *args, **kwargs):
    if name == 'sklearn' or name.startswith('sklearn.'):
        raise ModuleNotFoundError(name)
    return real_import(name, *args, **kwargs)
builtins.__import__ = blocked
import score_hook
print(score_hook.PREDICTOR_VERSION)
"""
    serving = subprocess.run(
        [sys.executable, "-c", code], cwd=HERE, capture_output=True,
        text=True, timeout=30,
    )
    assert serving.returncode == 0, serving.stderr

    print(json.dumps({
        "status": "verified",
        "videoId": source["videoId"],
        "predictorVersion": typed["predictorVersion"],
        "typedForecastPoints": len(typed["predictionTimesSeconds"]),
        "components": typed["componentCount"],
        "sameExactCoverAndCategories": True,
        "sharedTemporalAttribution": True,
        "futureWordsUsedForEarlierPredictions": False,
        "automaticTimingWordsPerSecond": mean_rate,
        "automaticTimingSourceVideos": 208,
        "views": "diagnostic only",
        "servingImportsSklearn": False,
    }, indent=2))


if __name__ == "__main__":
    main()
