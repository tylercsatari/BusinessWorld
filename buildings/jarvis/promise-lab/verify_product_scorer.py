#!/usr/bin/env python3
"""Canary that typed and saved openings share the current causal contract."""

from __future__ import annotations

import gzip
import json
import subprocess
import sys
from pathlib import Path

from score_hook import score_text


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


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


def main() -> None:
    summary = read("opening-predictions.json")
    source = min(summary["rows"], key=lambda row: (int(row["tokenCount"]), row["videoId"]))
    saved = read_gzip(
        CACHE / "opening-predictions" / f"{source['videoId']}.json.gz"
    )
    typed = score_text(saved["text"], planned_duration_seconds=20.0)

    assert typed["predictorVersion"] == saved["predictorVersion"]
    assert typed["featureVersion"] == saved["featureVersion"]
    assert typed["sourceKind"] == "typed-opening-causal-full-fit"
    assert saved["sourceKind"] == "saved-opening-20s-causal-oof"
    assert typed["analysisHorizonSeconds"] == saved["analysisHorizonSeconds"] == 20.0
    assert typed["predictionTimesSeconds"] == saved["predictionTimesSeconds"] == list(range(21))
    assert exact_cover(typed) and exact_cover(saved)
    assert typed["componentCount"] == saved["componentCount"]
    assert [row["text"] for row in typed["components"]] == [
        row["text"] for row in saved["components"]
    ]
    assert typed["provenance"]["futureWordsUsedForEarlierPredictions"] is False
    assert typed["provenance"]["sameTemporalModelFamilyAsSavedLibrary"] is True
    assert typed["outputs"]["viewsDiagnostic"]["status"] == "withheld"
    assert saved["outputs"]["viewsDiagnostic"]["status"] == "withheld"
    for payload in (typed, saved):
        attribution = payload["temporalAttribution"]
        assert len(attribution["steps"]) == len(
            payload["curves"]["entryIndexed"]["timesSeconds"]
        ) - 1
        assert len(attribution["componentLedger"]) == payload["componentCount"]
        assert abs(
            sum(row["predictedDeltaPoints"]
                for row in attribution["componentLedger"])
            + attribution["summary"]["unassignedTimeModelDeltaPoints"]
            - attribution["summary"]["totalPredictedDeltaPoints"]
        ) < 1e-4
        nodes = {
            row["id"]: row
            for row in (payload.get("componentLattice") or {}).get("nodes", [])
        }
        if payload is saved:
            nodes = {}
        for component in payload["components"]:
            assert len(component["categoryDistribution"]) == 4
            assert len(component["categoryCoordinates4D"]) == 4
            assert component["mapX"] is not None and component["mapY"] is not None
            assert component["timelineAttribution"] == attribution["componentLedger"][
                component["index"]
            ]
            if nodes:
                node = nodes[component["nodeId"]]
                assert node["text"] == component["text"]
                assert node["representations"] and node["relations"]
    for row in typed["causalPrefixTrace"]:
        assert int(row["tokenCount"]) <= int(typed["tokenCount"])

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
        "points": len(typed["predictionTimesSeconds"]),
        "components": typed["componentCount"],
        "samePartition": True,
        "sharedTemporalAttribution": True,
        "typedComponentsLinkedToLattice": True,
        "futureWordsUsedForEarlierPredictions": False,
        "views": "withheld",
        "servingImportsSklearn": False,
    }, indent=2))


if __name__ == "__main__":
    main()
