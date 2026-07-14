#!/usr/bin/env python3
"""Hard-gate the measured 20-second opening corpus and serving model."""

from __future__ import annotations

import gzip
import json
import math
from pathlib import Path

import numpy as np

from embedding_store import DIMENSIONS, MODEL
from opening_horizon import (
    FORWARD_LAGS_SECONDS,
    METHOD_VERSION,
    OPENING_HORIZON_SECONDS,
    OPENING_SAMPLE_STEP_SECONDS,
    REVERSE_CONTROL_LAGS_SECONDS,
)


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
DETAILS = CACHE / "opening-20s"
VECTORS = CACHE / "opening-20s-vectors"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_detail(video_id: str) -> dict:
    with gzip.open(DETAILS / f"{video_id}.json.gz", "rt", encoding="utf-8") as handle:
        return json.load(handle)


def finite(values) -> bool:
    return bool(np.isfinite(np.asarray(values, float)).all())


def verify_detail(detail: dict, summary_row: dict, model: dict) -> dict:
    video_id = str(summary_row["videoId"])
    assert str(detail["videoId"]) == video_id
    assert detail["status"] == "complete"
    assert detail["openingAnalysisMethodVersion"] == METHOD_VERSION
    assert detail["opening"]["methodVersion"] == METHOD_VERSION
    assert float(detail["analysisHorizonSeconds"]) == OPENING_HORIZON_SECONDS
    assert detail["sourceKind"] == "stored-opening-20s"

    opening = detail["opening"]
    timing = detail["timingContract"]
    assert opening["mediaAligned"] is True
    assert opening["sourceWordStartTimestampsObserved"] is False
    assert opening["wordStartsMediaAligned"] is True
    assert opening["wordEndsMediaAligned"] is True
    assert opening["wordEndsObserved"] is False
    assert opening["resolvedIntervalsNonoverlapping"] is True
    assert timing["mediaAligned"] is True
    assert timing["sourceWordStartTimestampsObserved"] is False
    assert timing["sourceWordStartsMediaAligned"] is True
    assert timing["sourceWordEndsMediaAligned"] is True
    assert timing["sourceWordEndsObserved"] is False
    assert timing["resolvedIntervalsNonoverlapping"] is True
    assert timing["alignmentConfidence"] in {"high", "moderate", "low"}
    assert 0 < float(timing["timingResolutionSeconds"]) < 0.03
    assert float(opening["mediaDurationSeconds"]) >= OPENING_HORIZON_SECONDS
    source_timeline = opening["sourceTimelineAudit"]
    assert source_timeline["withinAlignmentTolerance"] is True
    assert abs(float(source_timeline["audioMinusReferenceStartSeconds"])) <= 0.03
    assert 0 < float(opening["alignedHookEndSeconds"]) <= OPENING_HORIZON_SECONDS
    if timing["alignmentConfidence"] == "low":
        independent = opening["alignmentReferenceAudits"][
            "independentWhisperBaseWords"
        ]
        assert independent["forcedCanonicalTextUsed"] is False
        assert independent["outcomesUsed"] is False
        assert independent["referenceIsGroundTruth"] is False
        assert 0 < float(independent["mappedCoverage"]) <= 1
        assert float(independent["startMedianAbsoluteErrorSeconds"]) >= 0

    tokens = detail["tokens"]
    token_count = int(detail["tokenCount"])
    assert token_count == len(tokens) == int(summary_row["tokenCount"])
    assert token_count > 0
    assert [int(row["index"]) for row in tokens] == list(range(token_count))
    previous_end = -math.inf
    for token in tokens:
        start = float(token["spokenStartSeconds"])
        end = float(token["spokenEndSeconds"])
        lexical = any(
            character.isalnum() or character == "_"
            for character in str(token.get("text") or "")
        )
        assert 0 <= start <= end <= OPENING_HORIZON_SECONDS + 1e-9
        if lexical:
            assert start < end
            assert token.get("sourceStartTimestampSeconds") is not None
        else:
            assert math.isclose(start, end, rel_tol=0.0, abs_tol=1e-9)
        assert start + 1e-9 >= previous_end
        previous_end = end

    components = detail["canonicalComponents"]
    assert len(components) == int(summary_row["componentCount"])
    assert len(components) > 0
    cursor = 0
    component_counts = {category: 0 for category in range(4)}
    serving_lag = float(model["selectedLagSeconds"])
    for index, component in enumerate(components):
        assert int(component["index"]) == index
        assert int(component["startToken"]) == cursor
        assert int(component["endToken"]) > cursor
        cursor = int(component["endToken"])
        category = int(component["category"])
        assert category in component_counts
        component_counts[category] += 1
        assert float(component["spokenStartSeconds"]) < float(
            component["spokenEndSeconds"]
        )
        response = component["opening20sResponse"]
        assert response["selectionAdjusted"] is True
        assert response["servingMetricId"] == model["selectedCandidate"]
        assert float(response["servingLagSeconds"]) == serving_lag
        if float(component["spokenEndSeconds"]) + serving_lag <= 20.0 + 1e-9:
            assert response["servingAxisCoordinateFullFit"] is not None
            assert response["servingAxisPercentileFullFit"] is not None
            if not model["promotion"]["promoted"]:
                assert response["axisCoordinate"] is None
                assert response["axisPercentile"] is None
    assert cursor == token_count
    assert detail["partitionContract"]["exactNonoverlappingCover"] is True
    assert detail["partitionContract"]["selectionUsesOutcomes"] is False
    assert detail["partitionContract"]["canonicalComponentCount"] == len(components)
    assert detail["partitionContract"]["tokenOwnership"] == [1] * token_count

    expected_spans = token_count * (token_count + 1) // 2
    assert int(detail["spanCount"]) == expected_spans
    assert int(detail["expectedContiguousSpanCount"]) == expected_spans
    assert int(summary_row["spanCount"]) == expected_spans
    assert len(detail["nodes"]) >= expected_spans
    edge_types = {str(row["type"]) for row in detail["edges"]}
    assert {"containment", "sequence", "semantic", "context", "title", "outcome"} <= edge_types
    assert int(detail["edgeCount"]) == len(detail["edges"])
    graph_contract = detail["graphContract"]
    for key in (
        "outcomeUsedForNodes", "outcomeUsedForContainment", "outcomeUsedForSequence",
        "outcomeUsedForSemanticEdges", "outcomeUsedForContextEdges",
        "outcomeUsedForTitleEdges", "descriptiveAttentionUsedForScore",
    ):
        assert graph_contract[key] is False

    retention = detail["retention"]
    times = retention["timesSeconds"]
    expected_points = int(round(20.0 / OPENING_SAMPLE_STEP_SECONDS)) + 1
    assert len(times) == expected_points
    assert finite(times)
    assert abs(float(times[0])) < 1e-9
    assert abs(float(times[-1]) - 20.0) < 1e-9
    assert all(float(right) > float(left) for left, right in zip(times, times[1:]))
    assert retention["forecastValues"] == 0
    assert retention["primaryCurve"] == "entry_indexed"
    assert float(retention["measuredThroughSeconds"]) == 20.0
    native_times = retention["nativeObservedTimesSeconds"]
    native_values = retention["nativeObservedPercent"]
    assert len(native_times) == len(native_values) > 0
    assert finite(native_times) and finite(native_values)
    assert all(0 <= float(second) <= 20.0 + 1e-9 for second in native_times)
    for values in retention["curvesPercent"].values():
        assert len(values) == expected_points
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
        "categories": component_counts,
    }


def main() -> None:
    summary = load_json(CACHE / "opening-20s.json")
    model = load_json(CACHE / "opening-20s-model.json")
    media_alignment = load_json(CACHE / "media-alignment.json")
    corpus = load_json(CACHE / "corpus.json")["rows"]
    rows = summary["rows"]
    expected_ids = {str(row["id"]) for row in corpus}
    actual_ids = {str(row["videoId"]) for row in rows}

    assert summary["status"] == "complete"
    assert model["status"] in {"promoted", "exploratory-not-promoted"}
    assert summary["methodVersion"] == model["methodVersion"] == METHOD_VERSION
    assert float(summary["analysisHorizonSeconds"]) == OPENING_HORIZON_SECONDS
    assert summary["embeddingModel"] == model["embeddingModel"] == MODEL
    assert int(summary["embeddingDimensions"]) == int(model["embeddingDimensions"]) == DIMENSIONS
    assert int(summary["sourceVideos"]) == len(corpus) == len(rows)
    assert actual_ids == expected_ids
    assert media_alignment["status"] == "complete"
    assert int(media_alignment["mediaAlignedVideos"]) == len(rows)
    assert int(media_alignment["canonicalWords"]) > 0
    assert sum(media_alignment["confidenceBands"].values()) == len(rows)
    assert int(summary["sourceVideosWithObservedWordStartTimestamps"]) == 0
    assert int(summary["sourceVideosWithMediaAlignedWordIntervals"]) == len(rows)
    assert summary["sourceMediaOrigins"] == media_alignment["sourceOrigins"]
    assert int(summary["sourceVideosWithSourceSupportedWordStarts"]) == len(rows)
    assert sum(summary["mediaAlignmentConfidenceBands"].values()) == len(rows)
    assert 0 < float(summary["mediaTimingResolutionSecondsMedian"]) < 0.03
    assert float(summary["maximumAbsoluteSourceClockOffsetSeconds"]) <= 0.03
    independent = summary["independentTimingAudit"]
    alignment_independent = media_alignment["independentWhisperAudit"]
    assert int(independent["auditedVideos"]) == int(
        alignment_independent["auditedVideos"]
    )
    assert int(independent["auditedVideos"]) == len(rows)
    assert independent["forcedCanonicalTextUsed"] is False
    assert independent["outcomesUsed"] is False
    assert independent["referenceIsGroundTruth"] is False
    assert "per-video 95th-percentile" in independent["p95Aggregation"]
    hook_endpoint = summary["independentHookEndpointAudit"]
    alignment_hook_endpoint = media_alignment["independentWhisperHookAudit"]
    assert int(hook_endpoint["auditedVideos"]) == int(
        alignment_hook_endpoint["auditedVideos"]
    ) == len(rows)
    assert int(hook_endpoint["auditedFinalHookEndpoints"]) == int(
        alignment_hook_endpoint["auditedFinalHookEndpoints"]
    )
    assert 0 < int(hook_endpoint["auditedFinalHookEndpoints"]) <= len(rows)
    assert np.isclose(
        float(hook_endpoint["medianEndAgreementSeconds"]),
        float(alignment_hook_endpoint["medianFinalHookEndpointAgreementSeconds"]),
        atol=1e-12,
    )
    assert np.isclose(
        float(hook_endpoint["p95EndAgreementSeconds"]),
        float(alignment_hook_endpoint["p95FinalHookEndpointAgreementSeconds"]),
        atol=1e-12,
    )
    assert hook_endpoint["forcedCanonicalTextUsed"] is False
    assert hook_endpoint["outcomesUsed"] is False
    assert hook_endpoint["referenceIsGroundTruth"] is False
    assert int(summary["sourceVideosWithNonoverlappingResolvedIntervals"]) == len(rows)
    assert int(summary["categoryCount"]) == int(model["validation"]["categoryCount"]) == 4
    assert summary["partitionContract"]["variableComponentCount"] is True
    assert summary["partitionContract"]["exactNonoverlappingCover"] is True
    assert summary["retentionContract"]["forecastValues"] == 0
    assert summary["retentionContract"]["primaryFutureFree"] is True

    response = summary["response"]
    assert response["sourceVideos"] == len(rows)
    assert response["selectedCandidate"] == model["selectedCandidate"]
    assert float(response["selectedLagSeconds"]) == float(model["selectedLagSeconds"])
    assert [float(row["lagSeconds"]) for row in response["forwardCandidates"]] == list(
        FORWARD_LAGS_SECONDS
    )
    assert [float(row["lagSeconds"]) for row in response["reverseTimeControls"]] == list(
        REVERSE_CONTROL_LAGS_SECONDS
    )
    assert response["lagSelectionCommonComponents"] > 0
    assert response["promotion"] == model["promotion"]
    assert response["promotion"]["promoted"] is False
    assert all(
        row["semanticPredictionSource"].startswith("the unchanged nested forward")
        for row in response["reverseTimeControls"]
    )
    assert set(model["modelsByCategory"]) == {"0", "1", "2", "3"}

    totals = {"tokens": 0, "components": 0, "spans": 0, "edges": 0}
    category_totals = {category: 0 for category in range(4)}
    component_counts = set()
    media_rows = {
        str(row["videoId"]): row for row in media_alignment["rows"]
    }
    assert set(media_rows) == expected_ids
    for index, row in enumerate(rows, start=1):
        media_row = media_rows[str(row["videoId"])]
        assert math.isclose(
            float(row["mediaDurationSeconds"]),
            float(media_row["mediaDurationSeconds"]),
            rel_tol=0.0, abs_tol=1e-9,
        )
        assert math.isclose(
            float(row["analyticsDurationSeconds"]),
            float(media_row["analyticsDurationSeconds"]),
            rel_tol=0.0, abs_tol=1e-9,
        )
        assert math.isclose(
            float(row["durationDeltaSeconds"]),
            float(media_row["mediaDurationSeconds"])
            - float(media_row["analyticsDurationSeconds"]),
            rel_tol=0.0, abs_tol=1e-9,
        )
        checked = verify_detail(load_detail(str(row["videoId"])), row, model)
        component_counts.add(checked["components"])
        for key in totals:
            totals[key] += int(checked[key])
        for category, count in checked["categories"].items():
            category_totals[category] += count
        print(f"[{index}/{len(rows)}] verified {row['videoId']}", flush=True)

    assert len(component_counts) > 1
    assert all(category_totals[category] > 0 for category in range(4))
    assert totals["tokens"] == int(summary["tokenCount"])
    assert totals["components"] == int(summary["componentCount"])
    assert totals["spans"] == int(summary["spanCount"])
    assert totals["edges"] == int(summary["edgeCount"])
    print(json.dumps({
        "status": "verified",
        "sources": len(rows),
        **totals,
        "componentCountsObserved": sorted(component_counts),
        "categoryTotals": category_totals,
        "forecastValues": 0,
    }, indent=2))


if __name__ == "__main__":
    main()
