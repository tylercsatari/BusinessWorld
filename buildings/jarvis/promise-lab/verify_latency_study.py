#!/usr/bin/env python3
"""Hard checks for the Promise Lab held-out latency-study artifacts."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
MAP_ID = "0042a54b685d55438242"


def main() -> None:
    summary = json.loads((CACHE / "latency-study.json").read_text(encoding="utf-8"))
    atlas = json.loads((CACHE / "all-span-atlas.json").read_text(encoding="utf-8"))
    frozen = next(row for row in atlas["maps"] if row["id"] == MAP_ID)
    labels = np.asarray(frozen["labels"], int)
    lags = np.asarray(summary["lagsSeconds"], float)
    assert summary["status"] == "complete"
    assert summary["mapId"] == MAP_ID
    assert summary["clusterCount"] == 4
    assert len(lags) == 23
    assert np.isclose(lags[0], -3) and np.isclose(lags[-1], 8)
    assert np.allclose(np.diff(lags), .5)
    assert len(summary["windows"]) == 5
    assert summary["timingAudit"]["exactHooks"] == 203
    assert len(summary["sourceCurves"]) == 208
    assert len(summary["sourceEqualNaturalDrop"]) == 33
    assert summary["method"]["causalClaim"] is False
    assert summary["curveResolution"]["curvePointsPerVideo"] == 100

    for cluster in summary["clusters"]:
        label = int(cluster["label"])
        expected = int((labels == label).sum())
        assert cluster["spanInstances"] == expected
        assert len(cluster["windows"]) == 5
        assert len(cluster["axisTransfer"]["values"]) == len(lags)
        assert all(len(row) == len(lags) for row in cluster["axisTransfer"]["values"])
        assert len(cluster["sharedAxis"]["firstModeEnergyByFold"]) == 5
        assert len(cluster["sharedAxis"]["foldAxisCosines"]) == 10
        for window in cluster["windows"]:
            assert len(window["rows"]) == len(lags)
            for row in window["rows"]:
                assert np.isfinite(float(row["lag"]))
                assert row["measuredSpans"] >= 0
                if row.get("rho") is not None:
                    assert -1 <= float(row["rho"]) <= 1
                    assert 0 <= float(row["maxNullP"]) <= 1
            assert "latencySupported" in window["peak"]

        path = CACHE / "latency-study-details" / f"{label}.json.gz"
        assert path.exists()
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            detail = json.load(handle)
        assert detail["cluster"] == label
        assert detail["mapId"] == MAP_ID
        assert len(detail["globalIndices"]) == expected
        assert len(detail["sharedSemanticScoreOOF"]) == expected
        for name in (
            "observedRaw", "expectedRawOOF", "unexpectedRaw",
            "observedNormalized", "expectedNormalizedOOF", "unexpectedNormalized",
        ):
            matrix = detail["phrase"][name]
            assert len(matrix) == expected
            assert all(len(row) == len(lags) for row in matrix)

    print(json.dumps({
        "status": "verified",
        "clusters": len(summary["clusters"]),
        "lags": len(lags),
        "windows": len(summary["windows"]),
        "timedHooks": summary["timingAudit"]["exactHooks"],
        "curveResolutionMedianSeconds": summary["curveResolution"]["medianSampleSeconds"],
    }, indent=2))


if __name__ == "__main__":
    main()
