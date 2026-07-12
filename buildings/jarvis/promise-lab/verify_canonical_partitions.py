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
    assert summary["hooks"] == 208 and summary["chunks"] == 832
    assert summary["outcomesUsed"] is False and model["outcomesUsed"] is False
    assert model["manualPhrasesUsedToFitPartition"] is False
    assert model["constraints"]["completeCoverage"] is True
    assert model["constraints"]["overlapAllowed"] is False
    assert model["constraints"]["categoryQuotaMayChooseBoundaries"] is False
    for row in summary["rows"]:
        tokens = tokenize(row["text"])
        assert len(tokens) == row["tokenCount"] == len(row["tokens"])
        assert len(row["chunks"]) == 4
        owner = np.asarray([int(token["owner"]) for token in row["tokens"]], int)
        assert set(owner.tolist()) == {0, 1, 2, 3}
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
        assert np.isfinite(float(row["score"]))
        assert np.isfinite(float(row["scoreGap"]))
    validation = summary["validation"]
    assert validation["coverageFailures"] == 0 and validation["overlaps"] == 0
    assert validation["boundaryHeldoutAuc"] > .5
    print(json.dumps({
        "status": "verified", "hooks": summary["hooks"], "chunks": summary["chunks"],
        "overlaps": 0, "coverageFailures": 0,
        "boundaryHeldoutAuc": validation["boundaryHeldoutAuc"],
    }, indent=2))


if __name__ == "__main__":
    main()
