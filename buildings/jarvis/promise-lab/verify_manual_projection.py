#!/usr/bin/env python3
"""Hard checks for the fixed-label manual projection artifact."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def main() -> None:
    artifact = json.loads((CACHE / "manual-projection.json").read_text(encoding="utf-8"))
    atlas = json.loads((CACHE / "all-span-atlas.json").read_text(encoding="utf-8"))
    cluster_map = next(row for row in atlas["maps"] if row["id"] == artifact["mapId"])
    labels = np.asarray(cluster_map["labels"], np.int16)
    expected_hash = hashlib.sha256(labels.tobytes()).hexdigest()
    assert artifact["status"] == "complete"
    assert artifact["labelsChanged"] is False
    assert artifact["newClusteringFit"] is False
    assert artifact["outcomesUsed"] is False
    assert artifact["manualPhrasesUsed"] is False
    assert artifact["reconstruction"]["storedProjectionReproduced"] is True
    assert artifact["reconstruction"]["labelsSha256"] == expected_hash
    assert artifact["reconstruction"]["clusterCounts"] == np.bincount(
        labels, minlength=int(cluster_map["clusterCount"])
    ).astype(int).tolist()
    methods = artifact["methods"]
    assert {row["id"] for row in methods} == {"pca12", "fisher", "maxmin"}
    for method in methods:
        points = np.asarray(method["points"], np.float64)
        basis = np.asarray(method["basis4x2"], np.float64)
        assert points.shape == (len(labels), 2)
        assert basis.shape == (int(cluster_map["pcaDimensions"]), 2)
        assert np.isfinite(points).all()
        assert np.isfinite(basis).all()
        np.testing.assert_allclose(basis.T @ basis, np.eye(2), atol=2e-8)
        assert len(method["metrics"]["pairwise"]) == 6
        assert all(np.isfinite(float(value)) for value in (
            method["metrics"]["worstPairSeparation"],
            method["metrics"]["nearestCentroidAgreement"],
            method["metrics"]["silhouetteSampled"],
            method["metrics"]["daviesBouldin"],
            method["metrics"]["fisherTraceRatio"],
        ))
    winner = max(methods, key=lambda row: row["metrics"]["worstPairSeparation"])
    assert artifact["selectedMethod"] == winner["id"]
    assert artifact["improvementOverPca"]["worstPairSeparationRelative"] > 0
    print(json.dumps({
        "status": "verified",
        "mapId": artifact["mapId"],
        "labels": len(labels),
        "methods": len(methods),
        "selectedMethod": artifact["selectedMethod"],
        "labelsSha256": expected_hash,
    }, indent=2))


if __name__ == "__main__":
    main()
