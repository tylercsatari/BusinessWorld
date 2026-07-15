"""Deterministic full-sequence source extraction for Promise Lab.

This module reads existing source records only. Transcript timing is derived from
the media-aligned opening prefix and timestamped transcript words; analytics and
semantic fields are never inputs to the timing helpers.
"""

from __future__ import annotations

import copy
import gzip
import json
import math
from pathlib import Path

import numpy as np

from cluster_outcomes import retention_at
from deconfounding import NORMALIZATION_CONTRACTS, retention_curve_families
from sequence import normalize_source, tokenize


METHOD_VERSION = "full-sequence-source-data-v1"
OPENING_HORIZON_SECONDS = 20.0
EXPECTED_OPENING_SOURCES = 208
NORMALIZATION_IDS = tuple(NORMALIZATION_CONTRACTS)
EPS = 1e-9

DEFAULT_COVERAGE_THRESHOLDS = {
    "expectedSourceCount": EXPECTED_OPENING_SOURCES,
    "minimumAlignedPrefixCoverageFraction": 1.0,
    "minimumTimedTokenCoverageFraction": 1.0,
    "minimumRetentionCoverageWithinRiskSet": 1.0,
    "minimumRiskSetSources": 10,
    "minimumChronologicalRiskSetSources": 40,
}


def _read_json(path: Path) -> dict:
    with Path(path).open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object in {path}")
    return value


def _read_opening_detail(cache_dir: Path, video_id: str) -> tuple[dict, Path]:
    base = Path(cache_dir) / "opening-20s"
    compressed = base / f"{video_id}.json.gz"
    plain = base / f"{video_id}.json"
    if compressed.exists():
        with gzip.open(compressed, "rt", encoding="utf-8") as handle:
            return json.load(handle), compressed
    if plain.exists():
        return _read_json(plain), plain
    raise FileNotFoundError(f"missing opening-20s detail for {video_id}")


def _finite_float(value, label: str) -> float:
    try:
        output = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} is not numeric") from error
    if not math.isfinite(output):
        raise ValueError(f"{label} is not finite")
    return output


def _word_surface(row: dict) -> str:
    return normalize_source(row.get("word") or row.get("w") or "")


def _lexical_key(value: str) -> str:
    return normalize_source(value).casefold().replace("’", "'")


def load_opening_video_ids(cache_dir: Path, expected_count: int | None =
                           EXPECTED_OPENING_SOURCES) -> tuple[str, ...]:
    """Load the ordered opening-20s source IDs and enforce a closed cohort."""
    summary_path = Path(cache_dir) / "opening-20s.json"
    summary = _read_json(summary_path)
    rows = summary.get("rows")
    if not isinstance(rows, list):
        raise ValueError("opening-20s.json has no rows list")
    video_ids = tuple(str(row.get("videoId") or "").strip() for row in rows)
    if not video_ids or any(not video_id for video_id in video_ids):
        raise ValueError("opening-20s rows contain an empty video ID")
    if len(set(video_ids)) != len(video_ids):
        raise ValueError("opening-20s rows contain duplicate video IDs")
    if expected_count is not None and len(video_ids) != int(expected_count):
        raise ValueError(
            f"opening-20s cohort has {len(video_ids)} IDs; expected {expected_count}"
        )
    declared = summary.get("sourceVideos")
    if declared is not None and int(declared) != len(video_ids):
        raise ValueError("opening-20s sourceVideos does not match its rows")
    return video_ids


def _validate_prefix(opening_detail: dict, media_alignment: dict,
                     source_words: list[dict], video_id: str) -> tuple[list[dict], int]:
    aligned = media_alignment.get("words") or []
    if not aligned:
        raise ValueError(f"{video_id} has no media-aligned opening words")
    canonical_indices = [
        int(row.get("canonicalIndex", index))
        for index, row in enumerate(aligned)
    ]
    if canonical_indices != list(range(canonical_indices[-1] + 1)):
        raise ValueError(f"{video_id} aligned canonical indices are not contiguous")
    if canonical_indices[-1] >= len(source_words):
        raise ValueError(f"{video_id} alignment extends beyond its source transcript")

    for row, canonical_index in zip(aligned, canonical_indices):
        aligned_text = _word_surface(row)
        source_text = _word_surface(source_words[canonical_index])
        if not aligned_text or _lexical_key(aligned_text) != _lexical_key(source_text):
            raise ValueError(
                f"{video_id} aligned word {canonical_index} differs from the source transcript"
            )
        start = _finite_float(row.get("t", row.get("timestamp")), "aligned word start")
        duration = _finite_float(row.get("d", row.get("duration")), "aligned word duration")
        if start < 0 or duration <= 0 or start + duration > OPENING_HORIZON_SECONDS + 1e-6:
            raise ValueError(f"{video_id} aligned prefix is outside the opening horizon")

    aligned_text = normalize_source(" ".join(_word_surface(row) for row in aligned))
    detail_text = normalize_source(opening_detail.get("text") or "")
    if aligned_text != detail_text:
        raise ValueError(f"{video_id} opening detail does not preserve aligned prefix text")
    return aligned, canonical_indices[-1]


def _positive_median_start_delta(source_words: list[dict], fallback: float = 0.25) -> float:
    starts = []
    for index, row in enumerate(source_words):
        try:
            starts.append((index, float(row.get("timestamp", row.get("t")))))
        except (TypeError, ValueError):
            continue
    deltas = [
        right[1] - left[1]
        for left, right in zip(starts, starts[1:])
        if right[1] - left[1] > EPS
    ]
    return float(np.median(deltas)) if deltas else float(fallback)


def _resolve_appended_words(source_words: list[dict], first_index: int,
                            prefix_end: float, media_duration: float) -> tuple[list[dict], dict]:
    candidates = []
    running_start = float(prefix_end)
    beyond_duration = 0
    for source_index in range(int(first_index), len(source_words)):
        row = source_words[source_index]
        text = _word_surface(row)
        if not text:
            continue
        raw_start = _finite_float(
            row.get("timestamp", row.get("t")),
            f"source transcript word {source_index} start",
        )
        if raw_start < 0:
            raise ValueError("source transcript word starts before the media clock")
        if raw_start >= media_duration - EPS:
            beyond_duration += 1
            continue
        resolved_start = max(float(prefix_end), running_start, raw_start)
        candidates.append({
            "sourceTranscriptIndex": int(source_index),
            "canonicalIndex": int(source_index),
            "text": text,
            "sourceStartTimestampSeconds": float(raw_start),
            "groupStartSeconds": float(resolved_start),
        })
        running_start = resolved_start

    if not candidates:
        return [], {
            "appendedWordCount": 0,
            "timestampCollisionGroups": 0,
            "timestampCollisionWords": 0,
            "backwardTimestampCorrections": 0,
            "wordsAtOrBeyondMediaDurationExcluded": beyond_duration,
        }

    fallback_duration = _positive_median_start_delta(source_words)
    groups = []
    for row in candidates:
        if (
            not groups
            or not math.isclose(
                row["groupStartSeconds"], groups[-1]["start"],
                rel_tol=0.0, abs_tol=EPS,
            )
        ):
            groups.append({"start": row["groupStartSeconds"], "rows": []})
        groups[-1]["rows"].append(row)

    output = []
    collision_groups = 0
    collision_words = 0
    backward_corrections = 0
    for group_index, group in enumerate(groups):
        start = float(group["start"])
        if group_index + 1 < len(groups):
            interval_end = float(groups[group_index + 1]["start"])
            end_source = "next distinct source word start"
        else:
            interval_end = min(media_duration, start + fallback_duration)
            end_source = "median positive source word-start interval"
        if interval_end <= start + EPS:
            raise ValueError("appended transcript word has no positive media interval")
        rows = group["rows"]
        if len(rows) > 1:
            collision_groups += 1
            collision_words += len(rows)
        weights = np.asarray([max(1, len(row["text"])) for row in rows], float)
        cumulative = np.concatenate([[0.0], np.cumsum(weights)])
        span = interval_end - start
        for local_index, row in enumerate(rows):
            resolved_start = start + span * cumulative[local_index] / cumulative[-1]
            resolved_end = start + span * cumulative[local_index + 1] / cumulative[-1]
            backward_corrections += int(
                row["sourceStartTimestampSeconds"] < start - EPS
            )
            output.append({
                **row,
                "startSeconds": float(resolved_start),
                "endSeconds": float(resolved_end),
                "timingSource": "analysis.transcript.words timestamp",
                "timingKind": "timestamped-full-transcript-suffix",
                "acousticallyAligned": False,
                "withinOpening20s": False,
                "startResolution": (
                    "source word-start timestamp"
                    if math.isclose(
                        row["sourceStartTimestampSeconds"], resolved_start,
                        rel_tol=0.0, abs_tol=EPS,
                    ) else
                    "monotonic source-order correction and collision interpolation"
                ),
                "endInferredFrom": end_source,
                "timestampCollisionGroupSize": len(rows),
            })
    return output, {
        "appendedWordCount": len(output),
        "timestampCollisionGroups": collision_groups,
        "timestampCollisionWords": collision_words,
        "backwardTimestampCorrections": backward_corrections,
        "wordsAtOrBeyondMediaDurationExcluded": beyond_duration,
    }


def _character_ranges(words: list[dict]) -> str:
    pieces = []
    cursor = 0
    for row in words:
        if pieces:
            cursor += 1
        row["charStart"] = int(cursor)
        pieces.append(row["text"])
        cursor += len(row["text"])
        row["charEnd"] = int(cursor)
    return normalize_source(" ".join(pieces))


def _timed_tokens(full_text: str, words: list[dict], opening_detail: dict,
                  aligned_word_count: int, media_duration: float,
                  video_id: str) -> tuple[list[dict], dict]:
    atoms = tokenize(full_text)
    prefix_tokens = opening_detail.get("tokens") or []
    if not prefix_tokens:
        raise ValueError(f"{video_id} opening detail has no timed tokens")
    if len(prefix_tokens) > len(atoms):
        raise ValueError(f"{video_id} opening token prefix exceeds the full transcript")

    output: list[dict | None] = [None] * len(atoms)
    for token_index, source in enumerate(prefix_tokens):
        atom = atoms[token_index]
        if (
            int(source.get("index", token_index)) != token_index
            or source.get("text") != atom.text
            or int(source.get("start", atom.start)) != atom.start
            or int(source.get("end", atom.end)) != atom.end
        ):
            raise ValueError(f"{video_id} opening token prefix changed")
        start = _finite_float(source.get("spokenStartSeconds"), "opening token start")
        end = _finite_float(source.get("spokenEndSeconds"), "opening token end")
        if start < 0 or end < start or end > OPENING_HORIZON_SECONDS + 1e-6:
            raise ValueError(f"{video_id} opening token timing is outside 20 seconds")
        word_index = int(source.get("sourceWordIndex", -1))
        if word_index < 0:
            word_index = next((
                index for index, word in enumerate(words[:aligned_word_count])
                if atom.start >= word["charStart"] and atom.end <= word["charEnd"]
            ), -1)
        if word_index < 0 or word_index >= aligned_word_count:
            raise ValueError(f"{video_id} opening token has no aligned source word")
        output[token_index] = {
            **copy.deepcopy(source),
            "index": int(atom.index),
            "text": atom.text,
            "start": int(atom.start),
            "end": int(atom.end),
            "wordIndex": word_index,
            "canonicalIndex": int(words[word_index]["canonicalIndex"]),
            "timingKind": "preserved-opening-20s-acoustic-prefix",
            "acousticallyAlignedPrefix": True,
        }

    for word_index, word in enumerate(words[aligned_word_count:], aligned_word_count):
        members = [
            atom for atom in atoms
            if atom.start >= word["charStart"] and atom.end <= word["charEnd"]
        ]
        if not members:
            raise ValueError(f"{video_id} source word {word_index} has no surface tokens")
        weights = np.asarray([max(1, atom.end - atom.start) for atom in members], float)
        cumulative = np.concatenate([[0.0], np.cumsum(weights)])
        duration = float(word["endSeconds"] - word["startSeconds"])
        for local_index, atom in enumerate(members):
            start = word["startSeconds"] + duration * cumulative[local_index] / cumulative[-1]
            end = word["startSeconds"] + duration * cumulative[local_index + 1] / cumulative[-1]
            output[atom.index] = {
                "index": int(atom.index),
                "text": atom.text,
                "start": int(atom.start),
                "end": int(atom.end),
                "spokenStartSeconds": float(start),
                "spokenEndSeconds": float(end),
                "wordIndex": int(word_index),
                "sourceWordIndex": int(word["sourceTranscriptIndex"]),
                "canonicalIndex": int(word["canonicalIndex"]),
                "sourceWord": word["text"],
                "sourceStartTimestampSeconds": float(
                    word["sourceStartTimestampSeconds"]
                ),
                "timingSource": word["timingSource"],
                "timingKind": word["timingKind"],
                "timingEstimatedInsideSourceWord": len(members) > 1,
                "acousticallyAlignedPrefix": False,
            }

    if any(row is None for row in output):
        raise ValueError(f"{video_id} full transcript has untimed tokens")
    typed_output = [row for row in output if row is not None]
    if any(row["spokenEndSeconds"] > media_duration + 1e-6 for row in typed_output):
        raise ValueError(f"{video_id} token timing extends beyond media duration")
    if any(
        typed_output[index]["spokenEndSeconds"]
        > typed_output[index + 1]["spokenStartSeconds"] + 1e-6
        for index in range(len(typed_output) - 1)
    ):
        raise ValueError(f"{video_id} token intervals overlap")
    return typed_output, {
        "tokenCount": len(typed_output),
        "openingAlignedTokenCount": len(prefix_tokens),
        "appendedTokenCount": len(typed_output) - len(prefix_tokens),
        "timedTokenCount": len(typed_output),
        "timedTokenCoverageFraction": 1.0,
        "allTokensTimed": True,
        "openingTokenPrefixPreserved": True,
    }


def build_full_timeline(opening_detail: dict, media_alignment: dict,
                        transcript: dict, video_id: str = "source") -> dict:
    """Build text timing from source clocks only, without outcome/label inputs."""
    source_words = transcript.get("words") or []
    if not isinstance(source_words, list) or not source_words:
        raise ValueError(f"{video_id} has no timestamped full transcript")
    media_duration = _finite_float(
        (media_alignment.get("source") or {}).get("mediaDurationSeconds"),
        "media duration",
    )
    if media_duration < OPENING_HORIZON_SECONDS:
        raise ValueError(f"{video_id} media does not cover the aligned opening")
    aligned, last_canonical_index = _validate_prefix(
        opening_detail, media_alignment, source_words, video_id,
    )

    words = []
    for word_index, source in enumerate(aligned):
        start = _finite_float(source.get("t", source.get("timestamp")), "aligned start")
        duration = _finite_float(source.get("d", source.get("duration")), "aligned duration")
        canonical_index = int(source.get("canonicalIndex", word_index))
        words.append({
            **copy.deepcopy(source),
            "wordIndex": int(word_index),
            "canonicalIndex": canonical_index,
            "sourceTranscriptIndex": canonical_index,
            "text": _word_surface(source),
            "startSeconds": float(start),
            "endSeconds": float(start + duration),
            "sourceStartTimestampSeconds": _finite_float(
                source_words[canonical_index].get("timestamp", source_words[canonical_index].get("t")),
                "source prefix timestamp",
            ),
            "timingSource": source.get("source") or media_alignment.get("methodVersion"),
            "timingKind": "preserved-opening-20s-acoustic-prefix",
            "acousticallyAligned": True,
            "withinOpening20s": True,
        })
    prefix_end = max(float(row["endSeconds"]) for row in words)
    suffix, suffix_audit = _resolve_appended_words(
        source_words, last_canonical_index + 1, prefix_end, media_duration,
    )
    for row in suffix:
        row["wordIndex"] = len(words)
        words.append(row)
    if any(
        words[index]["endSeconds"] > words[index + 1]["startSeconds"] + 1e-6
        for index in range(len(words) - 1)
    ):
        raise ValueError(f"{video_id} full word intervals overlap")

    full_text = _character_ranges(words)
    tokens, token_audit = _timed_tokens(
        full_text, words, opening_detail, len(aligned), media_duration, video_id,
    )
    timestamped_source_text = normalize_source(" ".join(
        _word_surface(source_words[int(row["sourceTranscriptIndex"])])
        for row in words
    ))
    declared_full_text = normalize_source(transcript.get("fullText") or "")
    return {
        "text": full_text,
        "words": words,
        "tokens": tokens,
        "mediaDurationSeconds": float(media_duration),
        "alignedCanonicalEndIndex": int(last_canonical_index),
        "openingAlignedWordCount": len(aligned),
        "timingContract": {
            "openingPrefix": "existing media-alignment words and opening-20s token times",
            "suffix": "analysis.transcript.words after the last aligned canonical index",
            "suffixEndPolicy": "next distinct start; final word uses median positive start interval",
            "duplicateAndBackwardTimestampPolicy": (
                "preserve source order, retain raw starts, and divide the next positive interval "
                "by surface-character weight"
            ),
            "outcomesUsed": False,
            "semanticLabelsUsed": False,
        },
        "timingAudit": {
            **suffix_audit,
            **token_audit,
            "alignedPrefixPreservedThroughSeconds": OPENING_HORIZON_SECONDS,
            "alignedPrefixCoverageFraction": 1.0,
            "sourceTimestampedWordCount": len(source_words),
            "includedWordCount": len(words),
            "timestampedSourceTextMatchesOutput": timestamped_source_text == full_text,
            "declaredFullTextMatchesTimestampedWords": (
                not declared_full_text or declared_full_text == normalize_source(
                    " ".join(_word_surface(row) for row in source_words)
                )
            ),
        },
    }


def _retention_values(analysis: dict) -> np.ndarray:
    rows = (analysis.get("analytics") or {}).get("retentionCurve") or []
    values = []
    for row in rows:
        value = row.get("retention") if isinstance(row, dict) else row
        values.append(_finite_float(value, "retention curve value"))
    output = np.asarray(values, float)
    if len(output) < 4 or not np.isfinite(output).all():
        raise ValueError("retention curve is incomplete")
    return output


def sample_retention_families(analysis: dict, media_duration_seconds: float) -> dict:
    """Sample every declared family at at-risk whole seconds, never after censoring."""
    duration = _finite_float(media_duration_seconds, "media duration")
    if duration <= 0:
        raise ValueError("media duration must be positive")
    raw = _retention_values(analysis)
    terminal_count = max(3, int(math.ceil(len(raw) * 0.05)))
    terminal = float(np.mean(raw[-terminal_count:]))
    families = retention_curve_families([raw], np.asarray([terminal], float))
    if tuple(families) != NORMALIZATION_IDS:
        raise RuntimeError("declared retention normalization family changed")
    seconds = list(range(int(math.floor(duration + EPS)) + 1))
    curves_percent: dict[str, list[float | None]] = {}
    for normalization_id in NORMALIZATION_IDS:
        curve = np.asarray(families[normalization_id][0], float)
        sampled = []
        for second in seconds:
            value = retention_at(curve, duration, second) if len(curve) else float("nan")
            sampled.append(float(value * 100.0) if math.isfinite(value) else None)
        curves_percent[normalization_id] = sampled
    per_second = []
    for column, second in enumerate(seconds):
        values = {
            normalization_id: curves_percent[normalization_id][column]
            for normalization_id in NORMALIZATION_IDS
        }
        observed = sum(value is not None for value in values.values())
        per_second.append({
            "second": int(second),
            "atRisk": True,
            "censored": False,
            "censorReason": None,
            "retentionPercent": values,
            "observedNormalizationFamilies": int(observed),
            "allNormalizationFamiliesObserved": observed == len(NORMALIZATION_IDS),
        })
    return {
        "normalizationIds": list(NORMALIZATION_IDS),
        "normalizationContracts": copy.deepcopy(NORMALIZATION_CONTRACTS),
        "wholeSeconds": seconds,
        "curvesPercent": curves_percent,
        "perSecond": per_second,
        "sourceCurvePoints": int(len(raw)),
        "mediaDurationSeconds": float(duration),
        "lastWholeSecondAtRisk": seconds[-1],
        "firstWholeSecondCensored": seconds[-1] + 1,
        "censoringPolicy": (
            "a source is sampled at whole second t only when mediaDurationSeconds >= t; "
            "post-duration values are absent, never imputed"
        ),
        "entryPercent": float(raw[0] * 100.0),
        "terminalPercent": float(terminal * 100.0),
        "terminalPoints": int(terminal_count),
    }


def prefix_text_at_second(record: dict, second: float) -> str:
    """Return the mechanically completed transcript prefix at one source second."""
    value = _finite_float(second, "prefix second")
    if value < 0 or value > float(record["mediaDurationSeconds"]) + EPS:
        return ""
    completed = [
        row for row in record.get("tokens") or []
        if float(row["spokenEndSeconds"]) <= value + EPS
    ]
    if not completed:
        return ""
    return normalize_source(record["text"][:int(completed[-1]["end"])])


def _attach_per_second_timing(timeline: dict, retention: dict) -> list[dict]:
    rows = []
    for source in retention["perSecond"]:
        second = int(source["second"])
        completed_tokens = sum(
            float(row["spokenEndSeconds"]) <= second + EPS
            for row in timeline["tokens"]
        )
        completed_words = sum(
            float(row["endSeconds"]) <= second + EPS
            for row in timeline["words"]
        )
        rows.append({
            **copy.deepcopy(source),
            "completedTokenCount": int(completed_tokens),
            "completedWordCount": int(completed_words),
            "textTimingCovered": bool(timeline["timingAudit"]["allTokensTimed"]),
        })
    return rows


def extract_full_sequence_record(video_id: str, project_root: Path,
                                 cache_dir: Path) -> dict:
    """Read and combine the three immutable source records for one opening ID."""
    video_id = str(video_id)
    analysis_path = Path(project_root) / "video_data" / video_id / "analysis.json"
    alignment_path = Path(cache_dir) / "media-alignment" / f"{video_id}.json"
    analysis = _read_json(analysis_path)
    opening_detail, opening_path = _read_opening_detail(cache_dir, video_id)
    media_alignment = _read_json(alignment_path)
    for label, payload in (
        ("analysis", analysis),
        ("opening detail", opening_detail),
        ("media alignment", media_alignment),
    ):
        payload_id = str(payload.get("videoId") or video_id)
        if payload_id != video_id:
            raise ValueError(f"{label} video ID differs from {video_id}")

    timeline = build_full_timeline(
        opening_detail,
        media_alignment,
        analysis.get("transcript") or {},
        video_id=video_id,
    )
    retention = sample_retention_families(
        analysis, timeline["mediaDurationSeconds"],
    )
    per_second = _attach_per_second_timing(timeline, retention)
    return {
        "version": 1,
        "methodVersion": METHOD_VERSION,
        "videoId": video_id,
        "text": timeline["text"],
        "words": timeline["words"],
        "tokens": timeline["tokens"],
        "mediaDurationSeconds": timeline["mediaDurationSeconds"],
        "alignedCanonicalEndIndex": timeline["alignedCanonicalEndIndex"],
        "openingAlignedWordCount": timeline["openingAlignedWordCount"],
        "timingContract": timeline["timingContract"],
        "timingAudit": timeline["timingAudit"],
        "retention": retention,
        "perSecond": per_second,
        "censoring": {
            "atRiskThroughSeconds": timeline["mediaDurationSeconds"],
            "lastWholeSecondAtRisk": retention["lastWholeSecondAtRisk"],
            "firstWholeSecondCensored": retention["firstWholeSecondCensored"],
            "policy": retention["censoringPolicy"],
        },
        "sourceRecords": {
            "analysis": str(analysis_path),
            "opening20s": str(opening_path),
            "mediaAlignment": str(alignment_path),
        },
    }


def coverage_summary(records: list[dict], thresholds: dict | None = None) -> dict:
    """Report cohort completeness and the changing whole-second risk set."""
    values = list(records)
    if not values:
        raise ValueError("coverage summary requires at least one source")
    config = {**DEFAULT_COVERAGE_THRESHOLDS, **(thresholds or {})}
    expected = int(config["expectedSourceCount"])
    total = len(values)
    aligned = sum(
        float(row["timingAudit"].get("alignedPrefixCoverageFraction", 0.0)) >= 1.0
        for row in values
    )
    timed = sum(bool(row["timingAudit"].get("allTokensTimed")) for row in values)
    maximum_second = max(int(row["censoring"]["lastWholeSecondAtRisk"]) for row in values)
    sample_maps = {
        row["videoId"]: {sample["second"]: sample for sample in row["perSecond"]}
        for row in values
    }
    per_second = []
    for second in range(maximum_second + 1):
        at_risk = [
            row for row in values
            if float(row["mediaDurationSeconds"]) + EPS >= second
        ]
        samples = {
            row["videoId"]: sample_maps[row["videoId"]].get(second)
            for row in at_risk
        }
        family_counts = {
            normalization_id: sum(
                sample is not None
                and sample["retentionPercent"].get(normalization_id) is not None
                for sample in samples.values()
            )
            for normalization_id in NORMALIZATION_IDS
        }
        complete = sum(
            sample is not None and sample["allNormalizationFamiliesObserved"]
            for sample in samples.values()
        )
        text_covered = sum(
            sample is not None and sample["textTimingCovered"]
            for sample in samples.values()
        )
        risk_count = len(at_risk)
        retention_fraction = complete / risk_count if risk_count else 0.0
        text_fraction = text_covered / risk_count if risk_count else 0.0
        at_risk_ids = [row["videoId"] for row in at_risk]
        at_risk_id_set = set(at_risk_ids)
        censored_ids = [
            row["videoId"] for row in values
            if row["videoId"] not in at_risk_id_set
        ]
        meets_text = bool(
            risk_count
            and text_fraction >= float(config["minimumTimedTokenCoverageFraction"])
        )
        meets_retention = bool(
            risk_count
            and retention_fraction
            >= float(config["minimumRetentionCoverageWithinRiskSet"])
        )
        meets_minimum_risk = risk_count >= int(config["minimumRiskSetSources"])
        meets_chronological_risk = (
            risk_count >= int(config["minimumChronologicalRiskSetSources"])
        )
        per_second.append({
            "second": int(second),
            "totalSources": int(total),
            "riskSetSources": int(risk_count),
            "censoredSources": int(total - risk_count),
            "riskSetVideoIds": at_risk_ids,
            "censoredVideoIds": censored_ids,
            "riskSetFraction": float(risk_count / total),
            "textTimingCoveredSources": int(text_covered),
            "textTimingCoverageWithinRiskSet": float(text_fraction),
            "retentionSourcesByNormalization": family_counts,
            "allNormalizationFamiliesSources": int(complete),
            "retentionCoverageWithinRiskSet": float(retention_fraction),
            "meetsTextTimingCoverageThreshold": meets_text,
            "meetsRetentionCoverageThreshold": meets_retention,
            "meetsMinimumRiskSetSources": meets_minimum_risk,
            "meetsChronologicalRiskSetSources": meets_chronological_risk,
            "meetsAllCoverageThresholds": bool(
                meets_text and meets_retention and meets_minimum_risk
            ),
            "meetsAllChronologicalCoverageThresholds": bool(
                meets_text and meets_retention and meets_chronological_risk
            ),
        })

    def last_second(predicate) -> int | None:
        selected = [row["second"] for row in per_second if predicate(row)]
        return int(selected[-1]) if selected else None

    checks = {
        "expectedSourceCount": total == expected,
        "alignedPrefixCoverage": (
            aligned / total
            >= float(config["minimumAlignedPrefixCoverageFraction"])
        ),
        "timedTokenCoverage": (
            timed / total
            >= float(config["minimumTimedTokenCoverageFraction"])
        ),
    }
    return {
        "thresholds": config,
        "sourceCount": int(total),
        "expectedSourceCount": int(expected),
        "inputCoverageFraction": float(total / expected) if expected else 1.0,
        "sourcesWithCompleteAlignedPrefix": int(aligned),
        "alignedPrefixCoverageFraction": float(aligned / total),
        "sourcesWithFullTokenTiming": int(timed),
        "timedTokenCoverageFraction": float(timed / total),
        "thresholdChecks": checks,
        "allSourceThresholdsMet": all(checks.values()),
        "lastWholeSecondWithAnySourceAtRisk": int(maximum_second),
        "lastSecondMeetingMinimumRiskSetSources": last_second(
            lambda row: row["meetsMinimumRiskSetSources"]
        ),
        "lastSecondMeetingChronologicalRiskSetSources": last_second(
            lambda row: row["meetsChronologicalRiskSetSources"]
        ),
        "lastSecondMeetingRetentionCoverageThreshold": last_second(
            lambda row: row["meetsRetentionCoverageThreshold"]
        ),
        "lastSecondMeetingAllCoverageThresholds": last_second(
            lambda row: row["meetsAllCoverageThresholds"]
        ),
        "lastSecondMeetingAllChronologicalCoverageThresholds": last_second(
            lambda row: row["meetsAllChronologicalCoverageThresholds"]
        ),
        "perSecond": per_second,
        "censoringPolicy": (
            "riskSetSources counts only records whose measured media duration covers the "
            "whole second; censored cells are absent rather than carried forward"
        ),
    }


def extract_full_sequence_dataset(project_root: Path, cache_dir: Path,
                                  expected_source_count: int | None =
                                  EXPECTED_OPENING_SOURCES,
                                  thresholds: dict | None = None) -> dict:
    """Load the closed opening cohort and return source records plus coverage."""
    video_ids = load_opening_video_ids(cache_dir, expected_source_count)
    records = [
        extract_full_sequence_record(video_id, project_root, cache_dir)
        for video_id in video_ids
    ]
    expected = len(video_ids) if expected_source_count is None else int(expected_source_count)
    summary_thresholds = {
        "expectedSourceCount": expected,
        **(thresholds or {}),
    }
    return {
        "version": 1,
        "methodVersion": METHOD_VERSION,
        "sourceCount": len(records),
        "videoIds": list(video_ids),
        "normalizationIds": list(NORMALIZATION_IDS),
        "records": records,
        "coverage": coverage_summary(records, summary_thresholds),
        "contract": {
            "sourceOnly": True,
            "modelsTrained": 0,
            "artifactsWritten": 0,
            "outcomesUsedForTextTiming": False,
            "semanticLabelsUsedForTextTiming": False,
        },
    }


load_full_sequence_record = extract_full_sequence_record
load_full_sequence_dataset = extract_full_sequence_dataset
