#!/usr/bin/env python3
"""Verify every active 20-second Shorts opening artifact."""

from __future__ import annotations

import gzip
import json
from collections import Counter
from pathlib import Path

import numpy as np

from embedding_store import DIMENSIONS, MODEL
from opening_horizon import METHOD_VERSION, OPENING_HORIZON_SECONDS


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
DETAILS = CACHE / "opening-20s"
VECTORS = CACHE / "opening-20s-vectors"
ALLOWED_EDGES = {"containment", "sequence", "semantic", "context"}
ALLOWED_MAPS = {"raw", "context", "influence", "nonadditive"}


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def finite(values) -> bool:
    return bool(np.isfinite(np.asarray(values, float)).all())


def verify_detail(video_id: str) -> dict:
    detail = read_gzip(DETAILS / f"{video_id}.json.gz")
    assert detail["status"] == "complete"
    assert detail["videoId"] == video_id
    assert detail["openingAnalysisMethodVersion"] == METHOD_VERSION
    assert float(detail["analysisHorizonSeconds"]) == OPENING_HORIZON_SECONDS
    token_count = int(detail["tokenCount"])
    expected_spans = token_count * (token_count + 1) // 2
    assert int(detail["spanCount"]) == expected_spans
    assert len(detail["nodes"]) == expected_spans
    assert not detail.get("anchorNodes") and not detail.get("outcomeNodes")
    assert not (detail.get("ideaAnchor") or {}).get("present")
    assert set(detail.get("mapDefinitions") or {}) == ALLOWED_MAPS
    assert set(detail.get("edgeCounts") or {}) == ALLOWED_EDGES
    assert {row["type"] for row in detail["edges"]} <= ALLOWED_EDGES
    assert int(detail["edgeCount"]) == len(detail["edges"])
    assert (detail.get("graphContract") or {}).get(
        "structuralEdgesUseLongFormReferences"
    ) is False
    assert (detail.get("graphContract") or {}).get(
        "structuralEdgesUseOutcomes"
    ) is False
    for node in detail["nodes"]:
        assert set(node.get("maps") or {}) == ALLOWED_MAPS
        assert "globalTitleManifold" not in (node.get("coordinates") or {})
        assert "componentIdeaCosine" not in (node.get("relations") or {})

    partition = detail["partitionContract"]
    components = detail["canonicalComponents"]
    assert components
    assert partition["exactNonoverlappingCover"] is True
    assert partition["selectionUsesOutcomes"] is False
    assert (partition.get("horizonCalibration") or {}).get(
        "activationTokenThreshold"
    ) == -1
    assert partition["tokenOwnership"] == [1] * token_count
    assert int(partition["canonicalComponentCount"]) == len(components)
    owned = np.zeros(token_count, np.int16)
    for component in components:
        start = int(component["startToken"])
        end = int(component["endToken"])
        assert 0 <= start < end <= token_count
        assert 0 <= int(component["category"]) < 4
        assert "opening20sResponse" not in component
        assert set(component.get("maps") or {}) <= ALLOWED_MAPS
        assert 0 <= float(component["spokenStartSeconds"]) <= OPENING_HORIZON_SECONDS
        assert 0 <= float(component["spokenEndSeconds"]) <= OPENING_HORIZON_SECONDS
        owned[start:end] += 1
    assert owned.tolist() == [1] * token_count

    timing = detail["timingContract"]
    assert timing["mediaAligned"] is True
    assert timing["sourceAlignmentTokenCover"] is True
    assert timing["resolvedIntervalsNonoverlapping"] is True
    assert timing["tokenToSourceWordSequenceCover"] is True
    assert timing["exact"] is False
    assert len(detail["tokens"]) == token_count
    assert all(
        float(left["spokenEndSeconds"]) <= float(right["spokenEndSeconds"]) + 1e-9
        for left, right in zip(detail["tokens"][:-1], detail["tokens"][1:])
    )

    retention = detail["retention"]
    times = retention["timesSeconds"]
    assert float(retention["horizonSeconds"]) == OPENING_HORIZON_SECONDS
    assert times[0] == 0.0 and times[-1] == OPENING_HORIZON_SECONDS
    assert finite(times)
    for values in retention["curvesPercent"].values():
        assert len(values) == len(times)
        assert finite(values)

    with np.load(VECTORS / f"{video_id}.npz") as vectors:
        assert vectors["raw"].shape == (len(components), DIMENSIONS)
        assert vectors["influence"].shape == (len(components), DIMENSIONS)
        assert vectors["full"].shape == (DIMENSIONS,)
        assert finite(vectors["raw"])
        assert finite(vectors["influence"])
        assert finite(vectors["full"])
    return {
        "tokens": token_count,
        "components": len(components),
        "spans": expected_spans,
        "edges": len(detail["edges"]),
        "categories": Counter(int(row["category"]) for row in components),
    }


def main() -> None:
    summary = read(CACHE / "opening-20s.json")
    model = read(CACHE / "opening-20s-model.json")
    media = read(CACHE / "media-alignment.json")
    corpus = read(CACHE / "corpus.json")["rows"]
    ids = [str(row["id"]) for row in corpus]

    assert summary["status"] == model["status"] == "complete"
    assert summary["methodVersion"] == model["methodVersion"] == METHOD_VERSION
    assert summary["embeddingModel"] == model["embeddingModel"] == MODEL
    assert int(summary["embeddingDimensions"]) == int(model["embeddingDimensions"]) == DIMENSIONS
    assert int(summary["sourceVideos"]) == len(summary["rows"]) == len(ids) == 208
    assert {row["videoId"] for row in summary["rows"]} == set(ids)
    assert model["longFormReferenceUsed"] is False
    assert model["outcomesUsedForBoundaries"] is False
    assert model["componentOutcomeAxisUsedByHeadline"] is False
    assert model["partitionExtension"]["activationTokenThreshold"] == -1
    assert summary["partitionContract"]["variableComponentCount"] is True
    assert summary["partitionContract"]["exactNonoverlappingCover"] is True
    assert summary["latticeContract"]["longFormReferenceUsed"] is False
    assert summary["retentionContract"]["forecastValues"] == 0
    assert summary["retentionContract"]["primaryFutureFree"] is True
    assert int(media["mediaAlignedVideos"]) == len(ids)

    totals = Counter()
    component_counts = []
    for position, video_id in enumerate(ids, 1):
        result = verify_detail(video_id)
        totals.update({key: value for key, value in result.items() if key != "categories"})
        component_counts.append(result["components"])
        if position % 25 == 0 or position == len(ids):
            print(f"verified {position}/{len(ids)}", flush=True)

    assert totals["tokens"] == int(summary["tokenCount"])
    assert totals["components"] == int(summary["componentCount"])
    assert totals["spans"] == int(summary["spanCount"])
    assert totals["edges"] == int(summary["edgeCount"])
    assert min(component_counts) > 1
    assert max(component_counts) > 4
    print(json.dumps({
        "status": "verified",
        "sources": len(ids),
        "horizonSeconds": OPENING_HORIZON_SECONDS,
        "components": totals["components"],
        "componentCountRange": [min(component_counts), max(component_counts)],
        "spans": totals["spans"],
        "edges": totals["edges"],
        "longFormReferenceUsed": False,
        "outcomeEdges": 0,
    }, indent=2))


if __name__ == "__main__":
    main()
