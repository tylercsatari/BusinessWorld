"""Exact fixed-horizon transcript and retention primitives for Promise Lab."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from cluster_outcomes import retention_at, retention_window_slope
from deconfounding import NORMALIZATION_CONTRACTS, retention_curve_families
from sequence import normalize_source, tokenize


OPENING_HORIZON_SECONDS = 20.0
OPENING_SAMPLE_STEP_SECONDS = 0.1
FORWARD_LAGS_SECONDS = tuple(np.arange(0.0, 5.0001, 0.5).astype(float))
REVERSE_CONTROL_LAGS_SECONDS = (-2.0, -1.0, -0.5)
METHOD_VERSION = "exact-opening-20s-v2"


def _word_text(row: dict) -> str:
    return normalize_source(row.get("word") or row.get("w") or "")


def _word_start(row: dict) -> float:
    value = row.get("timestamp", row.get("t"))
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _positive_median(values: list[float], fallback: float = 0.25) -> float:
    finite = np.asarray([value for value in values if np.isfinite(value) and value > 0], float)
    return float(np.median(finite)) if len(finite) else float(fallback)


def extract_opening_timeline(words: list[dict],
                             horizon_seconds: float = OPENING_HORIZON_SECONDS) -> dict:
    """Build a non-overlapping opening timeline from quantized word timestamps.

    Source records contain word starts but not reliable word ends. Equal timestamps
    are source-quantization collisions, so collided words divide the interval to the
    next distinct timestamp by source-character length. Multi-atom source words then
    divide their resolved word interval the same way. No outcome or semantic label
    participates in either timing operation.
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
            resolved_start = source_start + duration * cumulative[local_index] / cumulative[-1]
            word_end = source_start + duration * cumulative[local_index + 1] / cumulative[-1]
            row["resolvedStartSeconds"] = float(resolved_start)
            row["resolvedEndSeconds"] = float(word_end)
            row["start"] = float(resolved_start)
            row["end"] = float(word_end)
            row["startResolution"] = (
                "observed source timestamp"
                if len(group_rows) == 1 or local_index == 0
                else "intra-collision character interpolation"
            )
            row["timestampCollisionGroupSize"] = len(group_rows)
            row["endInferredFrom"] = (
                "next distinct observed word start"
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
        raise ValueError(f"exact transcript timing does not cover lexical tokens: {missing[:8]}")
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
            "observed quantized source starts; equal-start groups resolved within the next "
            "distinct boundary by character length; inferred word ends; character-proportional "
            "intra-word atoms"
        ),
        "timingExact": False,
        "wordStartsAuthentic": True,
        "sourceWordStartTimestampsObserved": True,
        "resolvedWordStartsObserved": collision_groups == 0,
        "wordEndsObserved": False,
        "timestampCollisionGroups": collision_groups,
        "timestampCollisionWords": collision_words,
        "resolvedIntervalsNonoverlapping": True,
        "tokenToSourceWordAlignmentExact": True,
        "timingExactScope": (
            "Source word-start timestamps and token ownership are observed. Equal source "
            "timestamps do not identify within-group order in time, so those starts are resolved "
            "inside the next distinct timestamp interval. Word ends are inferred."
        ),
        "wordEndPolicy": (
            "Each distinct timestamp group ends at the next distinct observed timestamp, clipped "
            "to 20.0s. Words sharing a timestamp divide that interval by character length; only "
            "a final group without a successor uses the median positive distinct interval."
        ),
    }


def load_local_opening(video_id: str, project_root: Path,
                       horizon_seconds: float = OPENING_HORIZON_SECONDS) -> dict:
    import json

    path = project_root / "video_data" / str(video_id) / "analysis.json"
    if not path.exists():
        raise FileNotFoundError(f"missing transcript analysis: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    opening = extract_opening_timeline(
        ((payload.get("transcript") or {}).get("words") or []),
        horizon_seconds=horizon_seconds,
    )
    opening["sourcePath"] = str(path.relative_to(project_root))
    opening["sourceRecord"] = "analysis.json.transcript.words"
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

    def rows_for(lags: tuple[float, ...], kind: str) -> list[dict]:
        rows = []
        for lag in lags:
            left = start + float(lag)
            right = end + float(lag)
            eligible = (
                left >= 0 and right > left
                and right <= OPENING_HORIZON_SECONDS + 1e-9
                and right <= float(duration_seconds) + 1e-9
            )
            row = {
                "lagSeconds": float(lag),
                "kind": kind,
                "windowStartSeconds": float(left),
                "windowEndSeconds": float(right),
                "measuredWithin20s": bool(eligible),
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
