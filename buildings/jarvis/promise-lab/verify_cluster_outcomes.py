#!/usr/bin/env python3
"""Hard checks for frozen-cluster outcome-axis artifacts."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def main() -> None:
    summary = json.loads((CACHE / "cluster-outcomes.json").read_text(encoding="utf-8"))
    media_alignment = json.loads(
        (CACHE / "media-alignment.json").read_text(encoding="utf-8")
    )
    atlas = json.loads((CACHE / "all-span-atlas.json").read_text(encoding="utf-8"))
    manual_projection = json.loads(
        (CACHE / "manual-projection.json").read_text(encoding="utf-8")
    )
    map_id = manual_projection["mapId"]
    frozen = next(row for row in atlas["maps"] if row["id"] == map_id)
    labels = np.asarray(frozen["labels"], int)
    corpus_count = len(json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))["rows"])
    target_count = len(summary["targetDefinitions"])
    cluster_count = len(np.unique(labels))
    assert summary["status"] == "complete"
    assert summary["mapId"] == map_id
    assert summary["clusterCount"] == cluster_count
    assert summary["targetFamiliesPerCluster"] == target_count
    assert summary["selectedFamilyCount"] == cluster_count * target_count
    assert summary["experimentCount"] > summary["selectedFamilyCount"]
    assert summary["validatedFamilyCount"] == 0
    assert summary["randomFoldSupportedFamilyCount"] >= 0
    assert summary["validation"]["labelsChanged"] is False
    assert summary["validation"]["newClusteringFit"] is False
    assert summary["timingAudit"]["tokenCoveredHooks"] + summary["timingAudit"]["textMismatchHooks"] \
        + summary["timingAudit"]["missingWordHooks"] == corpus_count
    assert summary["timingAudit"]["tokenCoveredHooks"] == corpus_count
    assert summary["timingAudit"]["mediaAlignedHooks"] == corpus_count
    assert summary["timingAudit"]["textMismatchHooks"] == 0
    assert summary["timingAudit"]["missingWordHooks"] == 0
    assert sum(summary["timingAudit"]["mediaAlignmentConfidenceBands"].values()) \
        == corpus_count
    hook_alignment = summary["timingAudit"]["hookWordAlignment"]
    assert hook_alignment["sourceMediaMappedWords"] > 0
    assert hook_alignment["legacyAnchorInterpolatedWords"] == 0
    assert 0 < hook_alignment["minimumMappedCoverage"] <= 1
    assert hook_alignment["minimumMappedCoverage"] <= hook_alignment["meanMappedCoverage"] <= 1
    assert sum(hook_alignment["canonicalTimingStatusCounts"].values()) == corpus_count
    endpoint_reference = media_alignment["canonicalHookEndCorrectionSeconds"]
    assert np.isclose(
        hook_alignment["medianAbsoluteHookEndCorrectionSeconds"],
        endpoint_reference["medianAbsolute"], atol=1e-12,
    )
    assert np.isclose(
        hook_alignment["p95AbsoluteHookEndCorrectionSeconds"],
        endpoint_reference["p95Absolute"], atol=1e-12,
    )
    assert np.isclose(
        hook_alignment["maximumAbsoluteHookEndCorrectionSeconds"],
        endpoint_reference["maximumAbsolute"], atol=1e-12,
    )
    selected_ids = set()
    for cluster in summary["clusters"]:
        label = int(cluster["label"])
        assert cluster["spanInstances"] == int((labels == label).sum())
        assert cluster["sourceVideos"] == corpus_count
        assert len(cluster["targets"]) == target_count
        for target in cluster["targets"]:
            selected_ids.add(target["id"])
            assert target["cluster"] == label
            assert target["selectedForClusterTarget"] is True
            assert target["frozenLabelsChanged"] is False
            assert target["status"] == "random-fold-only-conditional-diagnostic"
            assert "no chronological" in target["claimBoundary"]
            assert target["n"] > 0
            assert np.isfinite(float(target["heldoutSpearman"]))
            path = CACHE / "cluster-outcomes-details" / str(label) / f"{target['target']}.json.gz"
            assert path.exists()
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                detail = json.load(handle)
            assert detail["mapId"] == map_id
            assert detail["selectedExperiment"]["id"] == target["id"]
            assert len(detail["points"]["x"]) == cluster["spanInstances"]
            assert len(detail["points"]["globalIndices"]) == cluster["spanInstances"]
            assert len(detail["validation"]["predictedOOF"]) > 0
    assert len(selected_ids) == cluster_count * target_count
    print(json.dumps({
        "status": "verified",
        "mapId": map_id,
        "clusters": cluster_count,
        "families": len(selected_ids),
        "experiments": summary["experimentCount"],
        "validated": summary["validatedFamilyCount"],
        "randomFoldSupported": summary["randomFoldSupportedFamilyCount"],
        "timedHooks": summary["timingAudit"]["tokenCoveredHooks"],
    }, indent=2))


if __name__ == "__main__":
    main()
