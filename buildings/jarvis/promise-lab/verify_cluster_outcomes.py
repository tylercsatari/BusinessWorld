#!/usr/bin/env python3
"""Hard checks for frozen-cluster outcome-axis artifacts."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
MAP_ID = "0042a54b685d55438242"


def main() -> None:
    summary = json.loads((CACHE / "cluster-outcomes.json").read_text(encoding="utf-8"))
    atlas = json.loads((CACHE / "all-span-atlas.json").read_text(encoding="utf-8"))
    frozen = next(row for row in atlas["maps"] if row["id"] == MAP_ID)
    labels = np.asarray(frozen["labels"], int)
    assert summary["status"] == "complete"
    assert summary["mapId"] == MAP_ID
    assert summary["clusterCount"] == 4
    assert summary["targetFamiliesPerCluster"] == 25
    assert summary["selectedFamilyCount"] == 100
    assert summary["experimentCount"] == 6000
    assert summary["validation"]["labelsChanged"] is False
    assert summary["validation"]["newClusteringFit"] is False
    assert summary["timingAudit"]["exactHooks"] == 203
    assert summary["timingAudit"]["textMismatchHooks"] == 5
    selected_ids = set()
    for cluster in summary["clusters"]:
        label = int(cluster["label"])
        assert cluster["spanInstances"] == int((labels == label).sum())
        assert cluster["sourceVideos"] == 208
        assert len(cluster["targets"]) == 25
        for target in cluster["targets"]:
            selected_ids.add(target["id"])
            assert target["cluster"] == label
            assert target["selectedForClusterTarget"] is True
            assert target["frozenLabelsChanged"] is False
            assert target["n"] > 0
            assert np.isfinite(float(target["heldoutSpearman"]))
            path = CACHE / "cluster-outcomes-details" / str(label) / f"{target['target']}.json.gz"
            assert path.exists()
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                detail = json.load(handle)
            assert detail["mapId"] == MAP_ID
            assert detail["selectedExperiment"]["id"] == target["id"]
            assert len(detail["points"]["x"]) == cluster["spanInstances"]
            assert len(detail["points"]["globalIndices"]) == cluster["spanInstances"]
            assert len(detail["validation"]["predictedOOF"]) > 0
    assert len(selected_ids) == 100
    print(json.dumps({
        "status": "verified",
        "mapId": MAP_ID,
        "clusters": 4,
        "families": len(selected_ids),
        "experiments": summary["experimentCount"],
        "validated": summary["validatedFamilyCount"],
        "timedHooks": summary["timingAudit"]["exactHooks"],
    }, indent=2))


if __name__ == "__main__":
    main()
