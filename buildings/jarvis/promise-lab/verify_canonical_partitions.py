#!/usr/bin/env python3
"""Hard integrity checks for the frozen zero-overlap canonical partitions."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from sequence import tokenize


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def main() -> None:
    summary = json.loads((CACHE / "canonical-partitions.json").read_text(encoding="utf-8"))
    model = json.loads((CACHE / "canonical-partition-model.json").read_text(encoding="utf-8"))
    assert summary["status"] == "complete"
    assert summary["hooks"] == 208
    assert summary["chunks"] == sum(int(row["componentCount"]) for row in summary["rows"])
    assert summary["outcomesUsed"] is False and model["outcomesUsed"] is False
    assert model["manualPhrasesUsedToFitPartition"] is False
    assert model["manualPhrasesUsedToFitPartitionBoundaries"] is False
    assert model["manualPhrasesUsedToChooseCategoryMap"] is True
    assert model["constraints"]["categoryFeaturesUsedByBoundaryModel"] is False
    assert len(model["boundaryModel"]["featureNames"]) == 8
    assert all("category" not in name for name in model["boundaryModel"]["featureNames"])
    assert model["constraints"]["completeCoverage"] is True
    assert model["constraints"]["overlapAllowed"] is False
    assert model["constraints"]["chunkCount"] is None
    assert model["constraints"]["maximumComponentCount"] is None
    assert model["constraints"]["manualSplitPenalty"] is None
    assert np.asarray(model["browseProjection"]["basis4x2"]).shape == (4, 2)
    observed_counts = set()
    for row in summary["rows"]:
        tokens = tokenize(row["text"])
        assert len(tokens) == row["tokenCount"] == len(row["tokens"])
        count = int(row["componentCount"])
        observed_counts.add(count)
        assert len(row["chunks"]) == count >= 1
        owner = np.asarray([int(token["owner"]) for token in row["tokens"]], int)
        assert set(owner.tolist()) == set(range(count))
        assert row["coverage"] == 1 and row["overlapCount"] == 0
        cursor = 0
        for index, chunk in enumerate(row["chunks"]):
            assert chunk["index"] == index
            assert chunk["start"] == cursor and chunk["end"] > chunk["start"]
            assert np.all(owner[chunk["start"]:chunk["end"]] == index)
            assert 0 <= int(chunk["category"]) <= 3
            probability = np.asarray(chunk["categoryDistribution"], float)
            assert len(probability) == 4 and np.isclose(probability.sum(), 1, atol=1e-5)
            cursor = int(chunk["end"])
        assert cursor == len(tokens)
        assert len(row["forecastSemanticInput"]["categoryCoordinates4D"]) == 4
        assert 0 <= int(row["forecastSemanticInput"]["category"]) <= 3
        assert all(len(token["semantic"]["categoryCoordinates4D"]) == 4
                   for token in row["tokens"])
        assert np.isfinite(float(row["score"]))
        assert np.isfinite(float(row["scoreGap"]))
    validation = summary["validation"]
    assert validation["coverageFailures"] == 0 and validation["overlaps"] == 0
    assert validation["boundaryHeldoutAuc"] > .5
    assert len(observed_counts) > 1
    assert validation["minimumComponents"] == min(observed_counts)
    assert validation["maximumComponents"] == max(observed_counts)
    trace = validation["semanticTrace"]
    assert trace["singletonCategoryAgreementWithFrozenAtlas"] > .99
    assert trace["fullHookCategoryAgreementWithFrozenAtlas"] > .98
    assert trace["savedProjectionMaximumAbsoluteError"] < 5e-5
    print(json.dumps({
        "status": "verified", "hooks": summary["hooks"], "chunks": summary["chunks"],
        "overlaps": 0, "coverageFailures": 0,
        "boundaryHeldoutAuc": validation["boundaryHeldoutAuc"],
    }, indent=2))


if __name__ == "__main__":
    main()
