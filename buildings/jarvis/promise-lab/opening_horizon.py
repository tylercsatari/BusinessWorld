"""Media-aligned fixed-horizon transcript and retention primitives."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from cluster_outcomes import retention_at, retention_window_slope
from deconfounding import NORMALIZATION_CONTRACTS, retention_curve_families
from media_alignment import (
    MEDIA_ALIGNMENT_VERSION,
    load_media_alignment,
    source_timeline_audit,
)
from sequence import normalize_source, tokenize


OPENING_HORIZON_SECONDS = 20.0
OPENING_SAMPLE_STEP_SECONDS = 0.1
FORWARD_LAGS_SECONDS = tuple(np.arange(0.0, 5.0001, 0.5).astype(float))
REVERSE_CONTROL_LAGS_SECONDS = (-2.0, -1.0, -0.5)
METHOD_VERSION = "media-aligned-opening-20s-v3"


def _word_text(row: dict) -> str:
    return normalize_source(row.get("word") or row.get("w") or "")


def _word_start(row: dict) -> float:
    value = row.get("timestamp", row.get("t"))
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _word_end(row: dict, start: float) -> float:
    value = row.get("end", row.get("e"))
    if value is None:
        duration = row.get("duration", row.get("d"))
        try:
            value = start + float(duration)
        except (TypeError, ValueError):
            return float("nan")
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _positive_median(values: list[float], fallback: float = 0.25) -> float:
    finite = np.asarray([value for value in values if np.isfinite(value) and value > 0], float)
    return float(np.median(finite)) if len(finite) else float(fallback)


def extract_opening_timeline(words: list[dict],
                             horizon_seconds: float = OPENING_HORIZON_SECONDS) -> dict:
    """Build a non-overlapping opening timeline from the best supplied intervals.

    Media-aligned records retain their acoustic start/end estimates. Legacy records
    with starts only retain the deterministic collision/end resolver. No outcome or
    semantic label participates in either operation.
    """
    horizon = float(horizon_seconds)
    observed = []
    for source_index, row in enumerate(words or []):
        text = _word_text(row)
        start = _word_start(row)
        if text and np.isfinite(start) and start >= 0:
            observed.append({
                "sourceIndex": source_index,
                "text": text,
                "sourceStartTimestampSeconds": start,
                "sourceEndTimestampSeconds": _word_end(row, start),
                "timingSource": row.get("source"),
                "alignmentStatus": row.get("status"),
                "alignmentConfidenceScore": row.get("confidenceScore"),
                "acousticPosteriorGeometricMean": row.get(
                    "acousticPosteriorGeometricMean"
                ),
                "freeDecodeCharacterCoverage": row.get(
                    "freeDecodeCharacterCoverage"
                ),
                "startBoundaryAcoustic": row.get("startBoundaryAcoustic"),
                "endBoundaryAcoustic": row.get("endBoundaryAcoustic"),
                "canonicalIndex": row.get("canonicalIndex", source_index),
            })
    if not observed:
        raise ValueError("the video has no timestamped transcript words")
    selected = [
        row for row in observed
        if row["sourceStartTimestampSeconds"] < horizon
    ]
    if not selected:
        raise ValueError("the transcript has no words before the opening horizon")
    if any(
        selected[index]["sourceStartTimestampSeconds"]
        > selected[index + 1]["sourceStartTimestampSeconds"]
           for index in range(len(selected) - 1)):
        raise ValueError("transcript word timestamps before the horizon are not monotonic")

    deltas = [
        observed[index + 1]["sourceStartTimestampSeconds"]
        - observed[index]["sourceStartTimestampSeconds"]
        for index in range(len(observed) - 1)
    ]
    fallback_duration = _positive_median(deltas)
    groups = []
    for row in observed:
        source_start = float(row["sourceStartTimestampSeconds"])
        if (
            not groups
            or not math.isclose(
                source_start, groups[-1]["sourceStartTimestampSeconds"],
                rel_tol=0.0, abs_tol=1e-9,
            )
        ):
            groups.append({
                "sourceStartTimestampSeconds": source_start,
                "rows": [],
            })
        groups[-1]["rows"].append(row)

    selected_source_indices = {row["sourceIndex"] for row in selected}
    collision_groups = 0
    collision_words = 0
    for group_index, group in enumerate(groups):
        group_rows = [
            row for row in group["rows"]
            if row["sourceIndex"] in selected_source_indices
        ]
        if not group_rows:
            continue
        source_start = float(group["sourceStartTimestampSeconds"])
        next_distinct_start = (
            float(groups[group_index + 1]["sourceStartTimestampSeconds"])
            if group_index + 1 < len(groups)
            else source_start + fallback_duration
        )
        resolved_end = min(horizon, next_distinct_start)
        if resolved_end <= source_start:
            raise ValueError(
                "transcript timestamp group has no positive interval before the horizon"
            )
        if len(group_rows) > 1:
            collision_groups += 1
            collision_words += len(group_rows)
        weights = np.asarray([max(1, len(row["text"])) for row in group_rows], float)
        cumulative = np.concatenate([[0.0], np.cumsum(weights)])
        duration = resolved_end - source_start
        for local_index, row in enumerate(group_rows):
            explicit_end = float(row.get("sourceEndTimestampSeconds", float("nan")))
            media_interval = (
                len(group_rows) == 1 and np.isfinite(explicit_end)
                and explicit_end > source_start
            )
            if media_interval:
                resolved_start = source_start
                word_end = min(horizon, resolved_end, explicit_end)
            else:
                resolved_start = source_start + duration * cumulative[local_index] / cumulative[-1]
                word_end = source_start + duration * cumulative[local_index + 1] / cumulative[-1]
            row["resolvedStartSeconds"] = float(resolved_start)
            row["resolvedEndSeconds"] = float(word_end)
            row["start"] = float(resolved_start)
            row["end"] = float(word_end)
            row["startResolution"] = (
                "media-aligned acoustic boundary"
                if media_interval
                else "observed source timestamp"
                if len(group_rows) == 1 or local_index == 0
                else "intra-collision character interpolation"
            )
            row["timestampCollisionGroupSize"] = len(group_rows)
            row["endInferredFrom"] = (
                "media-aligned acoustic boundary"
                if media_interval
                else "next distinct observed word start"
                if group_index + 1 < len(groups)
                else "median positive distinct transcript interval"
            )

    if any(row["end"] <= row["start"] for row in selected):
        raise ValueError("resolved transcript words must have positive durations")
    if any(
        selected[index]["end"] > selected[index + 1]["start"] + 1e-9
        for index in range(len(selected) - 1)
    ):
        raise ValueError("resolved transcript word intervals overlap")

    pieces = []
    character_ranges = []
    cursor = 0
    for row in selected:
        if pieces:
            cursor += 1
        start = cursor
        pieces.append(row["text"])
        cursor += len(row["text"])
        character_ranges.append((start, cursor))
    text = " ".join(pieces)
    tokens = tokenize(text)
    timing_rows = []
    token_word_index = np.full(len(tokens), -1, int)
    for word_index, (row, (char_start, char_end)) in enumerate(
        zip(selected, character_ranges)
    ):
        members = [
            token for token in tokens
            if token.start >= char_start and token.end <= char_end
        ]
        lexical = [
            token for token in members
            if any(character.isalnum() or character == "_" for character in token.text)
        ]
        if not lexical:
            continue
        weights = np.asarray([
            max(1, token.end - token.start) for token in lexical
        ], float)
        cumulative = np.concatenate([[0.0], np.cumsum(weights)])
        duration = float(row["end"] - row["start"])
        for local_index, token in enumerate(lexical):
            token_word_index[token.index] = word_index
            timing_rows.append({
                "tokenIndex": int(token.index),
                "text": token.text,
                "spokenStartSeconds": float(
                    row["start"] + duration * cumulative[local_index] / cumulative[-1]
                ),
                "spokenEndSeconds": float(
                    row["start"] + duration * cumulative[local_index + 1] / cumulative[-1]
                ),
                "sourceWordIndex": int(row["sourceIndex"]),
                "sourceWord": row["text"],
                "sourceStartTimestampSeconds": float(
                    row["sourceStartTimestampSeconds"]
                ),
                "resolvedSourceWordStartSeconds": float(row["start"]),
                "resolvedSourceWordEndSeconds": float(row["end"]),
                "startResolution": row["startResolution"],
                "timestampCollisionGroupSize": int(
                    row["timestampCollisionGroupSize"]
                ),
                "timingSource": row.get("timingSource"),
                "alignmentStatus": row.get("alignmentStatus"),
                "alignmentConfidenceScore": row.get(
                    "alignmentConfidenceScore"
                ),
                "acousticPosteriorGeometricMean": row.get(
                    "acousticPosteriorGeometricMean"
                ),
                "freeDecodeCharacterCoverage": row.get(
                    "freeDecodeCharacterCoverage"
                ),
                "spokenStartBoundaryAcoustic": bool(
                    media_interval and local_index == 0
                ),
                "spokenEndBoundaryAcoustic": bool(
                    media_interval and local_index == len(lexical) - 1
                ),
                "timingEstimatedInsideAcousticWord": bool(
                    not media_interval or len(lexical) > 1
                ),
            })
        for token in members:
            if token_word_index[token.index] < 0:
                token_word_index[token.index] = word_index

    lexical_indices = [
        token.index for token in tokens
        if any(character.isalnum() or character == "_" for character in token.text)
    ]
    supplied = {row["tokenIndex"] for row in timing_rows}
    if supplied != set(lexical_indices):
        missing = sorted(set(lexical_indices) - supplied)
        raise ValueError(f"source transcript timing does not cover lexical tokens: {missing[:8]}")
    if not timing_rows or max(row["spokenEndSeconds"] for row in timing_rows) > horizon + 1e-8:
        raise ValueError("opening timing extends beyond the fixed horizon")
    if any(
        timing_rows[index]["spokenEndSeconds"]
        > timing_rows[index + 1]["spokenStartSeconds"] + 1e-9
        for index in range(len(timing_rows) - 1)
    ):
        raise ValueError("resolved transcript token intervals overlap")
    if any(
        row["spokenEndSeconds"] <= row["spokenStartSeconds"]
        for row in timing_rows
    ):
        raise ValueError("resolved transcript tokens must have positive durations")

    media_aligned_words = sum(
        np.isfinite(float(row.get("sourceEndTimestampSeconds", float("nan"))))
        and row.get("timingSource") == "local-wav2vec2-ctc-forced-alignment"
        for row in selected
    )
    media_aligned = bool(media_aligned_words == len(selected))
    return {
        "version": 2,
        "methodVersion": METHOD_VERSION,
        "horizonSeconds": horizon,
        "text": text,
        "tokens": tokens,
        "timingWords": timing_rows,
        "sourceWords": selected,
        "tokenSourceWordIndices": token_word_index.astype(int).tolist(),
        "tokenCount": len(tokens),
        "lexicalTokenCount": len(lexical_indices),
        "wordCount": len(selected),
        "spokenStartSeconds": float(min(row["start"] for row in selected)),
        "spokenEndSeconds": float(max(row["spokenEndSeconds"] for row in timing_rows)),
        "timingPolicy": (
            "deterministic local CTC word boundaries on source-media PCM; canonical words "
            "unchanged; character-proportional intra-word atoms"
            if media_aligned else
            "observed quantized source starts; equal-start groups resolved within the next "
            "distinct boundary by character length; inferred word ends; character-proportional "
            "intra-word atoms"
        ),
        "timingExact": False,
        "wordStartsSourceSupported": True,
        "mediaAligned": media_aligned,
        "mediaAlignedWordCount": media_aligned_words,
        "sourceWordStartTimestampsObserved": not media_aligned,
        "resolvedWordStartsObserved": (not media_aligned and collision_groups == 0),
        "wordStartsMediaAligned": media_aligned,
        "wordEndsObserved": False,
        "wordEndsMediaAligned": media_aligned,
        "timestampCollisionGroups": collision_groups,
        "timestampCollisionWords": collision_words,
        "resolvedIntervalsNonoverlapping": True,
        "tokenToSourceWordSequenceCover": True,
        "timingExactScope": (
            "Every canonical word is forced onto deterministic acoustic CTC frames on the "
            "source-media clock. These are model-estimated boundaries, not hand-labeled exact "
            "timestamps."
            if media_aligned else
            "Source word-start timestamps and token ownership are observed. Equal source "
            "timestamps do not identify within-group order in time, so those starts are resolved "
            "inside the next distinct timestamp interval. Word ends are inferred."
        ),
        "wordEndPolicy": (
            "Acoustic CTC word ends are retained, clipped at the next canonical start and the "
            "20.0-second analysis boundary."
            if media_aligned else
            "Each distinct timestamp group ends at the next distinct observed timestamp, clipped "
            "to 20.0s. Words sharing a timestamp divide that interval by character length; only "
            "a final group without a successor uses the median positive distinct interval."
        ),
    }


def load_local_opening(video_id: str, project_root: Path,
                       horizon_seconds: float = OPENING_HORIZON_SECONDS) -> dict:
    cache_dir = Path(__file__).resolve().parent / ".cache"
    alignment_path = cache_dir / "media-alignment" / f"{video_id}.json"
    if not alignment_path.exists():
        raise FileNotFoundError(
            f"missing required source-media alignment for {video_id}; "
            "run build_media_alignment.py"
        )
    alignment = load_media_alignment(str(video_id), cache_dir)
    source_path = Path(alignment["source"]["path"])
    if not source_path.is_absolute():
        source_path = project_root / source_path
    timeline_audit = alignment["source"].get("timelineAudit") or source_timeline_audit(
        source_path
    )
    if not timeline_audit["withinAlignmentTolerance"]:
        raise RuntimeError(f"source-media clock origin is not aligned for {video_id}")
    opening = extract_opening_timeline(
        [{
            "word": row["w"],
            "timestamp": row["t"],
            "duration": row["d"],
            "source": row.get("source"),
            "status": row.get("status"),
            "confidenceScore": row.get("confidenceScore"),
            "acousticPosteriorGeometricMean": row.get(
                "acousticPosteriorGeometricMean"
            ),
            "freeDecodeCharacterCoverage": row.get(
                "freeDecodeCharacterCoverage"
            ),
            "canonicalIndex": row.get("canonicalIndex"),
        } for row in alignment["words"]],
        horizon_seconds=horizon_seconds,
    )
    opening.update({
        "sourcePath": str(alignment_path.relative_to(project_root)),
        "sourceRecord": "media-alignment.words",
        "sourceMediaOrigin": alignment["source"].get("origin"),
        "sourceMediaPath": alignment["source"].get("path"),
        "sourceTimelineAudit": timeline_audit,
        "mediaAlignmentMethodVersion": MEDIA_ALIGNMENT_VERSION,
        "mediaDurationSeconds": float(alignment["source"]["mediaDurationSeconds"]),
        "analyticsDurationSeconds": float(
            alignment["source"]["analyticsDurationSeconds"]
        ),
        "durationDeltaSeconds": float(alignment["source"]["durationDeltaSeconds"]),
        "alignmentConfidence": alignment["alignment"]["confidenceBand"],
        "alignmentCharacterErrorRate": float(
            alignment["alignment"]["freeDecodeCharacterErrorRate"]
        ),
        "alignmentReviewWordFraction": float(
            alignment["alignment"]["reviewWordFraction"]
        ),
        "timingResolutionSeconds": float(
            alignment["alignment"]["secondsPerCtcFrame"]
        ),
        "alignmentReferenceAudits": alignment["alignment"].get(
            "referenceAudits"
        ) or {},
    })
    hook_alignment = alignment.get("hookAlignment") or {}
    hook_words = hook_alignment.get("words") or []
    if not hook_words:
        raise RuntimeError(f"canonical hook has no source-media alignment for {video_id}")
    if not (
        hook_words[0].get("startBoundaryAcoustic")
        and hook_words[-1].get("endBoundaryAcoustic")
    ):
        raise RuntimeError(f"canonical hook has no acoustic outer interval for {video_id}")
    opening["alignedHookEndSeconds"] = float(
        hook_alignment["alignedEndSeconds"]
    )
    opening["hookMediaAlignmentAudit"] = {
        "alignmentStrategy": hook_alignment.get("alignmentStrategy"),
        "confidenceBand": hook_alignment.get("confidenceBand"),
        "alignmentCharacterErrorRate": hook_alignment.get(
            "alignmentCharacterErrorRate"
        ),
        "reviewWordFraction": hook_alignment.get("reviewWordFraction"),
        "estimatedBoundaryWords": sum(
            not bool(row.get("boundaryAcoustic")) for row in hook_words
        ),
        "outerBoundariesAcoustic": True,
        "legacyHookEndSeconds": hook_alignment.get("legacyHookEndSeconds"),
        "hookEndCorrectionSeconds": hook_alignment.get("hookEndCorrectionSeconds"),
        "referenceAudits": hook_alignment.get("referenceAudits") or {},
        "outcomesUsed": False,
    }
    opening["hookCanonicalTextTimingAudit"] = hook_alignment.get(
        "projectionAudit"
    ) or {}
    opening["hookAlignmentMethodVersion"] = hook_alignment.get("methodVersion")
    return opening


def curve_payload(curve: list[float], duration_seconds: float,
                  horizon_seconds: float = OPENING_HORIZON_SECONDS,
                  sample_step_seconds: float = OPENING_SAMPLE_STEP_SECONDS) -> dict:
    """Expose measured and declared normalization families on one time grid."""
    raw = np.asarray(curve or [], float)
    duration = float(duration_seconds)
    horizon = float(horizon_seconds)
    if len(raw) < 4 or not np.isfinite(raw).all():
        raise ValueError("retention curve is incomplete")
    if duration < horizon:
        raise ValueError("video duration does not cover the opening horizon")
    terminal_count = max(3, int(math.ceil(len(raw) * 0.05)))
    terminal = float(np.mean(raw[-terminal_count:]))
    families = retention_curve_families([raw], np.asarray([terminal], float))
    times = np.round(
        np.arange(0.0, horizon + sample_step_seconds / 2, sample_step_seconds), 6,
    )
    sampled = {}
    for name, rows in families.items():
        values = np.asarray(rows[0], float)
        sampled[name] = [
            float(retention_at(values, duration, second) * 100.0)
            if len(values) else None
            for second in times
        ]
    native_times = np.linspace(0.0, duration, len(raw))
    native_mask = native_times <= horizon + 1e-9
    return {
        "horizonSeconds": horizon,
        "durationSeconds": duration,
        "sampleStepSeconds": float(sample_step_seconds),
        "timesSeconds": times.astype(float).tolist(),
        "curvesPercent": sampled,
        "normalizationContracts": NORMALIZATION_CONTRACTS,
        "primaryCurve": "entry_indexed",
        "primaryReason": (
            "future-free normalization divides by observed entry only; terminal-conditioned "
            "families remain retrospective sensitivity views"
        ),
        "nativeObservedTimesSeconds": native_times[native_mask].astype(float).tolist(),
        "nativeObservedPercent": (raw[native_mask] * 100.0).astype(float).tolist(),
        "entryPercent": float(raw[0] * 100.0),
        "terminalPercent": float(terminal * 100.0),
        "terminalPoints": terminal_count,
        "measuredThroughSeconds": horizon,
        "forecastValues": 0,
    }


def component_measurements(component: dict, curve: list[float], duration_seconds: float,
                           terminal_fraction: float = 0.05) -> dict:
    """Measure one component at every declared forward lag, plus reverse controls."""
    raw = np.asarray(curve or [], float)
    terminal_count = max(3, int(math.ceil(len(raw) * terminal_fraction)))
    terminal = float(np.mean(raw[-terminal_count:]))
    families = retention_curve_families([raw], np.asarray([terminal], float))
    start = float(component["spokenStartSeconds"])
    end = float(component["spokenEndSeconds"])
    timing_eligible = bool(component.get("outcomeTimingEligible", True))

    def rows_for(lags: tuple[float, ...], kind: str) -> list[dict]:
        rows = []
        for lag in lags:
            left = start + float(lag)
            right = end + float(lag)
            eligible = (
                timing_eligible and left >= 0 and right > left
                and right <= OPENING_HORIZON_SECONDS + 1e-9
                and right <= float(duration_seconds) + 1e-9
            )
            row = {
                "lagSeconds": float(lag),
                "kind": kind,
                "windowStartSeconds": float(left),
                "windowEndSeconds": float(right),
                "measuredWithin20s": bool(eligible),
                "acousticOuterBoundariesSupported": timing_eligible,
                "exclusionReason": (
                    None if timing_eligible
                    else "component outer boundary falls inside an acoustic word interval"
                ),
            }
            for family, curves in families.items():
                values = curves[0]
                slope = retention_window_slope(values, duration_seconds, left, right) if eligible else float("nan")
                begin = retention_at(values, duration_seconds, left) if eligible else float("nan")
                finish = retention_at(values, duration_seconds, right) if eligible else float("nan")
                row[family] = {
                    "slopePercentPerSecond": float(slope * 100.0) if np.isfinite(slope) else None,
                    "startPercent": float(begin * 100.0) if np.isfinite(begin) else None,
                    "endPercent": float(finish * 100.0) if np.isfinite(finish) else None,
                    "dropPercentagePoints": float((finish - begin) * 100.0) if np.isfinite(begin + finish) else None,
                }
            rows.append(row)
        return rows

    return {
        "spokenStartSeconds": start,
        "spokenEndSeconds": end,
        "spokenDurationSeconds": end - start,
        "forward": rows_for(FORWARD_LAGS_SECONDS, "eligible forward response"),
        "reverseControls": rows_for(REVERSE_CONTROL_LAGS_SECONDS, "reverse-time falsification only"),
        "primaryFamily": "entry_indexed",
        "selectionPolicy": (
            "Only forward lags can be selected. Reverse-time rows are falsification controls. "
            "A lag is not promoted from this source video's own measured outcome."
        ),
    }


def component_interval(tokens: list[dict], start: int, end: int) -> tuple[float, float]:
    selected = tokens[int(start):int(end)]
    starts = [float(row["spokenStartSeconds"]) for row in selected]
    ends = [float(row["spokenEndSeconds"]) for row in selected]
    if not starts or not ends:
        raise ValueError("component has no timed source tokens")
    return min(starts), max(ends)


def component_boundary_support(tokens: list[dict], start: int, end: int) -> dict:
    selected = tokens[int(start):int(end)]
    lexical = [
        row for row in selected
        if any(character.isalnum() or character == "_" for character in row["text"])
    ]
    measured = lexical or selected
    if not measured:
        raise ValueError("component has no timed source tokens")
    first = measured[0]
    last = measured[-1]
    return {
        "startBoundaryAcoustic": bool(first.get("spokenStartBoundaryAcoustic")),
        "endBoundaryAcoustic": bool(last.get("spokenEndBoundaryAcoustic")),
        "outcomeTimingEligible": bool(
            first.get("spokenStartBoundaryAcoustic")
            and last.get("spokenEndBoundaryAcoustic")
            and float(last["spokenEndSeconds"]) > float(first["spokenStartSeconds"])
        ),
    }
