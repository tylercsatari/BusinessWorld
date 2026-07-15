"""Frozen-model evaluation helpers for pooled Shorts accounts.

Observed audience retention is attached only after inference. Nothing in this
module refits, recalibrates, promotes, or otherwise changes the Promise Lab
model.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from collections import defaultdict
from functools import lru_cache

import numpy as np

from cluster_outcomes import exact_token_timings, retention_at
from sequence import normalize_source, tokenize


CAPTION_TIMING_SOURCE = (
    "YouTube source-media automatic caption word offsets; observed outcome "
    "curves are joined only after frozen inference"
)
EVALUATION_VERSION = "promise-pooled-external-evaluation-v4-near-duplicate-audit"
NEAR_DUPLICATE_TRIGRAM_JACCARD = 0.80
NEAR_DUPLICATE_SENSITIVITY_THRESHOLDS = (0.70, 0.80, 0.90)


def _finite(value) -> float | None:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _float_array(values) -> np.ndarray:
    if values is None:
        values = []
    return np.asarray([
        float(value) if _finite(value) is not None else np.nan
        for value in values
    ], float)


def caption_json3_to_timed_words(payload: dict, media_duration: float | None = None) -> dict:
    """Convert YouTube JSON3 rolling-caption events into one monotonic word stream."""
    segments = []
    seen = set()
    for event_index, event in enumerate(payload.get("events") or []):
        if event.get("aAppend") or not event.get("segs"):
            continue
        event_start = max(0.0, float(event.get("tStartMs") or 0.0) / 1000.0)
        for segment_index, segment in enumerate(event.get("segs") or []):
            text = re.sub(r"\s+", " ", str(segment.get("utf8") or "")).strip()
            if not text:
                continue
            start = event_start + max(0.0, float(segment.get("tOffsetMs") or 0.0) / 1000.0)
            key = (round(start, 4), text)
            if key in seen:
                continue
            seen.add(key)
            segments.append({
                "start": start,
                "text": text,
                "eventIndex": event_index,
                "segmentIndex": segment_index,
            })
    segments.sort(key=lambda row: (row["start"], row["eventIndex"], row["segmentIndex"]))
    if not segments:
        return {"text": "", "words": [], "status": "no-spoken-caption-segments"}

    positive_deltas = [
        right["start"] - left["start"]
        for left, right in zip(segments, segments[1:])
        if right["start"] - left["start"] > 1e-4
    ]
    typical_span = float(np.median(positive_deltas)) if positive_deltas else 0.35
    typical_span = min(1.2, max(0.12, typical_span))
    words = []
    for index, segment in enumerate(segments):
        start = float(segment["start"])
        if media_duration is not None and start >= float(media_duration):
            continue
        next_start = (
            float(segments[index + 1]["start"])
            if index + 1 < len(segments) else start + typical_span
        )
        available = max(0.04, next_start - start)
        span = min(available, typical_span * 1.75)
        if media_duration is not None:
            remaining = max(1e-4, float(media_duration) - start)
            span = min(span, remaining)
        atoms = re.findall(r"\S+", segment["text"])
        if not atoms:
            continue
        weights = np.asarray([max(1, len(atom)) for atom in atoms], float)
        edges = np.concatenate([[0.0], np.cumsum(weights)]) / float(weights.sum())
        for atom_index, atom in enumerate(atoms):
            atom_start = start + span * float(edges[atom_index])
            atom_end = start + span * float(edges[atom_index + 1])
            if media_duration is not None:
                atom_start = min(float(media_duration), atom_start)
                atom_end = min(float(media_duration), atom_end)
            if atom_end <= atom_start:
                continue
            words.append({
                "word": atom,
                "timestamp": atom_start,
                "duration": max(1e-4, atom_end - atom_start),
                "source": "youtube-json3-caption-offset",
            })
    return {
        "text": normalize_source(" ".join(row["word"] for row in words)),
        "words": words,
        "status": "complete" if words else "no-spoken-caption-words",
        "captionSegments": len(segments),
        "wordCount": len(words),
        "spokenEndSeconds": max(
            (row["timestamp"] + row["duration"] for row in words), default=0.0,
        ),
    }


def analysis_transcript_to_timed_words(transcript: dict,
                                       media_duration: float | None = None) -> dict:
    source = []
    for row in transcript.get("words") or []:
        text = normalize_source(row.get("word") or row.get("w") or "")
        start = _finite(row.get("timestamp", row.get("t")))
        if not text or start is None or start < 0:
            continue
        if media_duration is not None and start >= float(media_duration):
            continue
        source.append({"word": text, "timestamp": start})
    source.sort(key=lambda row: row["timestamp"])
    deltas = [
        right["timestamp"] - left["timestamp"]
        for left, right in zip(source, source[1:])
        if right["timestamp"] - left["timestamp"] > 1e-4
    ]
    fallback = min(1.0, max(0.12, float(np.median(deltas)) if deltas else 0.3))
    for index, row in enumerate(source):
        next_start = (
            source[index + 1]["timestamp"] if index + 1 < len(source)
            else row["timestamp"] + fallback
        )
        row["duration"] = min(
            max(1e-4, next_start - row["timestamp"]), fallback * 1.75,
        )
        if media_duration is not None:
            row["duration"] = min(
                row["duration"], max(1e-4, float(media_duration) - row["timestamp"]),
            )
        row["source"] = "analysis.transcript.words timestamp"
    declared = normalize_source(transcript.get("fullText") or "")
    joined = normalize_source(" ".join(row["word"] for row in source))
    text = declared if declared and _lexical_stream(declared) == _lexical_stream(joined) else joined
    return {
        "text": text,
        "words": source,
        "status": "complete" if source else "no-timestamped-transcript-words",
        "wordCount": len(source),
        "spokenEndSeconds": max(
            (row["timestamp"] + row["duration"] for row in source), default=0.0,
        ),
    }


def _lexical_stream(value: str) -> str:
    return "".join(
        character.casefold() for character in normalize_source(value)
        if character.isalnum() or character == "_"
    )


def token_clock_from_timed_words(text: str, words: list[dict]) -> list[dict]:
    caption_words = [{
        "w": row.get("word") or row.get("w"),
        "t": float(row.get("timestamp", row.get("t", 0.0))),
        "d": float(row.get("duration", row.get("d", 0.0))),
        "startBoundaryAcoustic": False,
        "endBoundaryAcoustic": False,
    } for row in words]
    timing = exact_token_timings(text, caption_words)
    if not timing.get("normalizedTextCoverageExact"):
        raise ValueError(f"caption text does not map exactly to tokens: {timing.get('status')}")
    tokens = tokenize(text)
    starts = timing.get("tokenStarts") or []
    ends = timing.get("tokenEnds") or []
    if len(starts) != len(tokens) or len(ends) != len(tokens):
        raise ValueError("caption token timing does not cover the source text")
    output = []
    previous = 0.0
    for token, start, end in zip(tokens, starts, ends):
        start = max(previous, float(start))
        end = max(start, float(end))
        output.append({
            "index": int(token.index),
            "startSeconds": start,
            "endSeconds": end,
            "lexical": any(character.isalnum() or character == "_" for character in token.text),
        })
        previous = end
    return output


def model_fingerprint(*artifacts: dict) -> str:
    payload = json.dumps(
        artifacts, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def content_fingerprint(text: str) -> str | None:
    """Hash exact normalized spoken content without video/account identity."""
    normalized = " ".join(re.findall(
        r"[\w']+", normalize_source(text or "").casefold(), flags=re.UNICODE,
    ))
    if len(normalized.split()) < 3:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def prediction_text(analysis: dict) -> str:
    """Return the exact spoken text supplied to the frozen scorer."""
    return normalize_source(
        analysis.get("text")
        or (analysis.get("input") or {}).get("analyzedText")
        or (analysis.get("input") or {}).get("inputText")
        or ""
    )


@lru_cache(maxsize=4096)
def token_trigrams(text: str) -> frozenset[tuple[str, str, str]]:
    tokens = re.findall(
        r"[\w']+", normalize_source(text or "").casefold(), flags=re.UNICODE,
    )
    return frozenset(zip(tokens, tokens[1:], tokens[2:]))


@lru_cache(maxsize=500000)
def trigram_jaccard(left: frozenset, right: frozenset) -> tuple[float, int]:
    if not left or not right:
        return 0.0, 0
    shared = len(left & right)
    return shared / len(left | right), shared


def outcome_blind_prediction(analysis: dict) -> dict:
    """Return the serving prediction with every joined outcome removed."""
    target_outcome_keys = {
        "actual", "predictionError", "observedCurves", "comparisons",
        "comparisonsByFamily", "candidateComparisons",
        "candidateComparisonsByFamily", "candidateAudit",
        "blindPredictionFingerprint",
        "blindEvaluationRole", "strictBlindEligible", "evaluationGenerationId",
        "measurements", "observedSlopePercentagePointsPerSecond",
        "observedDeltaPoints", "totalObservedDeltaPoints",
        "fullObservedDurationSeconds", "pointPredictionStatus",
    }

    def scrub(value):
        if isinstance(value, dict):
            return {
                key: scrub(child) for key, child in value.items()
                if key not in target_outcome_keys
            }
        if isinstance(value, list):
            return [scrub(child) for child in value]
        return copy.deepcopy(value)

    output = scrub(analysis)
    for curve in (output.get("curves") or {}).values():
        curve.pop("actual", None)
    provenance = output.setdefault("provenance", {})
    provenance.pop("blindPredictionFingerprint", None)
    provenance.pop("evaluationGenerationId", None)
    provenance["observedCurveJoinedAfterInference"] = False
    provenance["observedCurveUsedForPrediction"] = False
    provenance["outcomesUsedForPrediction"] = False
    return output


def prediction_fingerprint(analysis: dict) -> str:
    payload = json.dumps(
        outcome_blind_prediction(analysis), sort_keys=True,
        separators=(",", ":"), ensure_ascii=False, allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def blind_manifest_entry(analysis: dict) -> dict:
    """Compact prediction-only record persisted before outcomes are opened."""
    blind = outcome_blind_prediction(analysis)
    return {
        "videoId": blind.get("videoId"),
        "accountId": blind.get("accountId"),
        "evaluationKind": blind.get("evaluationKind"),
        "predictionFitKind": blind.get("predictionFitKind"),
        "modelFingerprint": blind.get("pooledModelFingerprint"),
        "referenceFullFitModelFingerprint": blind.get(
            "referenceFullFitModelFingerprint"
        ),
        "inputFingerprint": blind.get("pooledInputFingerprint"),
        "contentFingerprint": blind.get("contentFingerprint"),
        "blindIsolationPrimary": blind.get("blindIsolationPrimary"),
        "blindIsolationPolicies": blind.get("blindIsolationPolicies"),
        "blindContentComponentId": blind.get("blindContentComponentId"),
        "blindContentComponentSize": blind.get("blindContentComponentSize"),
        "blindContentComponentWeight": blind.get("blindContentComponentWeight"),
        "blindContentComponentMemberIndex": blind.get(
            "blindContentComponentMemberIndex"
        ),
        "blindContentComponentMatchKind": blind.get(
            "blindContentComponentMatchKind"
        ),
        "predictionFingerprint": prediction_fingerprint(blind),
        "forecastHorizonSeconds": blind.get("forecastHorizonSeconds"),
        "curves": {
            family_name: {
                key: family.get(key) for key in (
                    "timesSeconds", "predicted", "predictionP10",
                    "predictionP90", "selectedStage",
                )
            }
            for family_name, family in (blind.get("curves") or {}).items()
        },
        "outputs": blind.get("outputs"),
    }


def _baseline_family(family: dict, forecast_end: float) -> dict:
    selected = str(
        family.get("headlineStage") or family.get("selectedStage") or "relationships"
    )
    if selected != "baseline":
        raise RuntimeError(
            "duration-only fallback is invalid because the frozen production stage "
            f"is {selected!r}, not 'baseline'"
        )
    rows = {
        int(round(float(row["second"]))): row
        for row in family.get("temporalModels") or []
    }
    times = [0.0]
    times.extend(
        float(second) for second in sorted(rows)
        if second <= forecast_end + 1e-9 and rows[second].get("headlineModelAvailable")
    )
    if abs(forecast_end - round(forecast_end)) > 1e-6:
        times.append(float(forecast_end))
    times = sorted(set(times))
    time_zero = float(family.get("timeZeroMean") or 100.0)

    def interpolate(second: float, key: str, default: float = 0.0) -> float:
        if second <= 1e-9:
            return time_zero if key == "baselineMean" else default
        lower = max(1, int(math.floor(second)))
        upper = max(1, int(math.ceil(second)))
        if lower not in rows or upper not in rows:
            raise RuntimeError(f"frozen baseline has no support at {second:.3f}s")
        weight = second - math.floor(second)
        return (
            float(rows[lower].get(key, default)) * (1.0 - weight)
            + float(rows[upper].get(key, default)) * weight
        )

    predicted = [interpolate(second, "baselineMean") for second in times]
    residual_low = [interpolate(second, "residualP10") for second in times]
    residual_high = [interpolate(second, "residualP90") for second in times]
    return {
        "timesSeconds": times,
        "predicted": predicted,
        "predictionP10": [
            value + residual for value, residual in zip(predicted, residual_low)
        ],
        "predictionP90": [
            value + residual for value, residual in zip(predicted, residual_high)
        ],
        "actual": None,
        "stages": {"baseline": predicted},
        "selectedStage": "baseline",
        "candidateStage": str(family.get("candidateStage") or "relationships"),
        "promotion": family.get("promotion") or {},
        "causalPrefixOnly": True,
        "displayStopsAtSuppliedText": True,
        "diagnosticStagesMaterialized": False,
    }


def baseline_only_analysis(video: dict, retention_model: dict, reason: str) -> dict:
    """Emit the exact selected baseline when source speech cannot be recovered.

    This is deliberately unavailable if a future frozen model promotes a semantic
    stage: in that case missing transcript cannot be papered over with duration.
    """
    duration = _finite(video.get("duration_s"))
    support = retention_model.get("support") or {}
    horizon = _finite(
        support.get("semanticModelHorizonSeconds")
        or retention_model.get("analysisHorizonSeconds")
    )
    if duration is None or duration <= 0 or horizon is None or horizon <= 0:
        raise ValueError("duration-only evaluation needs positive media and model horizons")
    forecast_end = min(duration, horizon)
    curves = {
        family_name: _baseline_family(family, forecast_end)
        for family_name, family in (retention_model.get("families") or {}).items()
    }
    entry = curves["entryIndexed"]
    absolute = curves["observedAbsolute"]
    endpoint = float(entry["predicted"][-1])
    absolute_r5 = (
        float(np.interp(5.0, absolute["timesSeconds"], absolute["predicted"]))
        if forecast_end >= 5.0 else None
    )
    return {
        "version": 5,
        "status": "complete-selected-baseline-only",
        "predictorVersion": retention_model.get("predictorVersion"),
        "featureVersion": retention_model.get("featureVersion"),
        "sourceKind": "pooled-duration-only-selected-baseline",
        "text": "",
        "input": {
            "inputText": "",
            "analyzedText": "",
            "plannedSpokenSeconds": None,
            "estimatedSpokenSeconds": duration,
            "structuralDurationSeconds": duration,
            "forecastDurationSeconds": forecast_end,
            "timingEstimated": True,
            "timingSource": "media duration; spoken transcript unavailable",
            "transcriptUnavailableReason": reason,
            "structurallyUncapped": True,
        },
        "analysisHorizonSeconds": duration,
        "modelHorizonSeconds": horizon,
        "forecastHorizonSeconds": forecast_end,
        "predictionTimesSeconds": entry["timesSeconds"],
        "tokenCount": 0,
        "componentCount": 0,
        "components": [],
        "relationships": [],
        "causalPrefixTrace": [],
        "outputs": {
            "retainedAtAnalyzedEndPercent": endpoint,
            "retainedAtForecastEndPercent": endpoint,
            "retainedAtForecastEndP10": float(entry["predictionP10"][-1]),
            "retainedAtForecastEndP90": float(entry["predictionP90"][-1]),
            "forecastEndSeconds": forecast_end,
            "absoluteRetention5sPercent": absolute_r5,
            "normalizedRetention5sPercent": (
                float(np.interp(5.0, entry["timesSeconds"], entry["predicted"]))
                if forecast_end >= 5.0 else None
            ),
            "normalizedDropByAnalyzedEndPoints": 100.0 - endpoint,
            "viewsDiagnostic": None,
        },
        "actual": None,
        "curves": curves,
        "temporalAttribution": None,
        "orderSensitivity": None,
        "componentLattice": None,
        "support": {
            "structurallyUncapped": True,
            "fullInputTokensOwned": 0,
            "structuralDurationSeconds": duration,
            "servedForecastThroughSeconds": forecast_end,
            "retentionAfterForecastUnsupported": duration > forecast_end + 1e-9,
            "forecastStopReason": (
                "media endpoint" if duration <= horizon + 1e-9 else
                "duration-conditioned cohort risk set falls below the declared model minimum"
            ),
            "timingSource": "media duration; spoken transcript unavailable",
            "timingEstimated": True,
            "diagnosticComponentsAvailable": False,
        },
        "validation": {
            family_name: {
                "randomFold": family.get("randomFoldValidation"),
                "chronological": family.get("chronologicalValidation"),
                "candidateRandomFold": family.get("candidateRandomFoldValidation"),
                "candidateChronological": family.get("candidateChronologicalValidation"),
                "promotion": family.get("promotion"),
                "stages": family.get("stageValidations"),
                "chronologicalStages": family.get("chronologicalStageValidations"),
            }
            for family_name, family in (retention_model.get("families") or {}).items()
        },
        "evidence": retention_model.get("evidenceBoundary"),
        "provenance": {
            "sameFrozenSelectedStageAsTypedScorer": True,
            "selectedStage": "baseline",
            "semanticDiagnosticsMaterialized": False,
            "outcomesUsedForPrediction": False,
            "observedCurveJoinedAfterInference": False,
            "pooledEvaluationRefit": False,
            "pooledEvaluationRecalibration": False,
        },
    }


def attach_observed_retention(analysis: dict, video: dict) -> dict:
    """Join the measured curve after inference and calculate uncalibrated errors."""
    output = copy.deepcopy(analysis)
    raw = np.asarray(video.get("curve") or [], float)
    duration = _finite(video.get("duration_s"))
    if len(raw) < 2 or duration is None or duration <= 0 or not np.isfinite(raw).all():
        raise ValueError("video has no finite measured retention curve")
    families = {
        "observedAbsolute": raw,
        "entryIndexed": raw / max(float(raw[0]), 1e-9),
    }
    full_times = np.linspace(0.0, duration, len(raw)).astype(float).tolist()
    output["observedCurves"] = {
        family_name: {
            "timesSeconds": full_times,
            "actual": (100.0 * values).astype(float).tolist(),
            "sourcePoints": len(raw),
            "source": "YouTube Studio audience-retention curve",
        }
        for family_name, values in families.items()
    }
    for family_name, normalized in families.items():
        curve = (output.get("curves") or {}).get(family_name) or {}
        times = curve.get("timesSeconds") or []
        actual = [
            (
                100.0 * retention_at(normalized, duration, float(second))
                if float(second) <= duration + 1e-6 else None
            )
            for second in times
        ]
        curve["actual"] = actual
        output.setdefault("curves", {})[family_name] = curve
    entry = output["curves"]["entryIndexed"]
    absolute = output["curves"]["observedAbsolute"]
    if not entry.get("actual") or not entry.get("predicted"):
        raise ValueError("prediction has no comparable entry-indexed curve")
    predicted = _float_array(entry["predicted"])
    actual = _float_array(entry["actual"])
    times = _float_array(entry["timesSeconds"])
    comparable = np.isfinite(predicted) & np.isfinite(actual) & np.isfinite(times)
    if not comparable.any():
        raise ValueError("prediction and observed curve have no jointly finite cells")
    endpoint_index = int(np.flatnonzero(comparable)[-1])
    endpoint_actual = float(actual[endpoint_index])
    endpoint_predicted = float(predicted[endpoint_index])
    absolute_r5 = (
        100.0 * retention_at(raw, duration, 5.0) if duration >= 5.0 else None
    )
    output["actual"] = {
        "retainedAtForecastEndPercent": endpoint_actual,
        "retainedAtObservedEndPercent": float(100.0 * families["entryIndexed"][-1]),
        "forecastEndSeconds": float(times[endpoint_index]),
        "observedEndSeconds": duration,
        "mediaDurationSeconds": duration,
        "absoluteRetention5sPercent": absolute_r5,
        "views": video.get("views"),
        "curveSource": "YouTube Studio audience-retention curve",
        "curveSourcePoints": len(raw),
        "joinedAfterInference": True,
    }
    errors = predicted[comparable] - actual[comparable]
    output["predictionError"] = {
        "retainedAtForecastEndPoints": endpoint_predicted - endpoint_actual,
        "curveMAEPercentagePoints": float(np.mean(np.abs(errors))),
        "curveRMSEPercentagePoints": float(np.sqrt(np.mean(errors ** 2))),
        "curveBiasPercentagePoints": float(np.mean(errors)),
    }
    output.setdefault("provenance", {}).update({
        "observedCurveJoinedAfterInference": True,
        "observedCurveUsedForPrediction": False,
        "pooledEvaluationRefit": False,
        "pooledEvaluationRecalibration": False,
    })
    return output


def compact_summary(detail: dict) -> dict:
    def comparisons_for(family_name: str) -> dict:
        family = (detail.get("curves") or {}).get(family_name) or {}
        times = family.get("timesSeconds") or []
        predicted = family.get("predicted") or []
        actual = family.get("actual") or []
        comparisons = {}
        for target in (5.0, 10.0, 20.0):
            index = next(
                (position for position, second in enumerate(times)
                 if abs(float(second) - target) <= 1e-6),
                None,
            )
            if index is None or index >= len(predicted) or index >= len(actual):
                continue
            predicted_value = _finite(predicted[index])
            actual_value = _finite(actual[index])
            if predicted_value is None or actual_value is None:
                continue
            comparisons[str(int(target))] = {
                "second": target,
                "predictedPercent": predicted_value,
                "actualPercent": actual_value,
                "errorPoints": predicted_value - actual_value,
            }
        return comparisons

    comparisons_by_family = {
        family_name: comparisons_for(family_name)
        for family_name in ("entryIndexed", "observedAbsolute")
    }

    def candidate_comparisons_for(family_name: str) -> dict:
        family = (detail.get("curves") or {}).get(family_name) or {}
        times = family.get("timesSeconds") or []
        actual = family.get("actual") or []
        stages = family.get("stages") or {}
        candidate_name = str(family.get("candidateStage") or "relationships")
        candidate = stages.get(candidate_name) or []
        baseline = stages.get("baseline") or []
        comparisons = {}
        for target in (5.0, 10.0, 20.0, 30.0):
            index = next(
                (position for position, second in enumerate(times)
                 if abs(float(second) - target) <= 1e-6),
                None,
            )
            if index is None or any(
                index >= len(values) for values in (actual, candidate, baseline)
            ):
                continue
            actual_value = _finite(actual[index])
            candidate_value = _finite(candidate[index])
            baseline_value = _finite(baseline[index])
            if None in (actual_value, candidate_value, baseline_value):
                continue
            comparisons[str(int(target))] = {
                "second": target,
                "candidateStage": candidate_name,
                "candidatePredictedPercent": candidate_value,
                "baselinePredictedPercent": baseline_value,
                "actualPercent": actual_value,
                "candidateErrorPoints": candidate_value - actual_value,
                "baselineErrorPoints": baseline_value - actual_value,
            }
        return comparisons

    candidate_comparisons_by_family = {
        family_name: candidate_comparisons_for(family_name)
        for family_name in ("entryIndexed", "observedAbsolute")
    }
    return {
        "videoId": detail.get("videoId"),
        "accountId": detail.get("accountId"),
        "accountName": detail.get("accountName"),
        "title": detail.get("title"),
        "text": detail.get("text") or ((detail.get("input") or {}).get("analyzedText")),
        "url": detail.get("url"),
        "evaluationKind": detail.get("evaluationKind"),
        "predictionFitKind": detail.get("predictionFitKind"),
        "pooledInputFingerprint": detail.get("pooledInputFingerprint"),
        "contentFingerprint": detail.get("contentFingerprint"),
        "blindPredictionFingerprint": detail.get("blindPredictionFingerprint"),
        "blindEvaluationRole": detail.get("blindEvaluationRole"),
        "strictBlindEligible": bool(detail.get("strictBlindEligible")),
        "blindIsolationPrimary": detail.get("blindIsolationPrimary"),
        "blindContentComponentId": detail.get("blindContentComponentId"),
        "blindContentComponentSize": detail.get("blindContentComponentSize"),
        "blindContentComponentWeight": detail.get("blindContentComponentWeight"),
        "transcriptSource": detail.get("transcriptSource"),
        "tokenCount": detail.get("tokenCount"),
        "componentCount": detail.get("componentCount"),
        "analysisHorizonSeconds": detail.get("analysisHorizonSeconds"),
        "forecastHorizonSeconds": detail.get("forecastHorizonSeconds"),
        "categorySequence": detail.get("categorySequence") or [
            row.get("category") for row in detail.get("components") or []
        ],
        "components": [{
            key: component.get(key) for key in (
                "index", "text", "category", "startToken", "endToken",
                "spokenStartSeconds", "spokenEndSeconds",
            )
        } for component in detail.get("components") or []],
        "outputs": detail.get("outputs"),
        "actual": detail.get("actual"),
        "predictionError": detail.get("predictionError"),
        "comparisons": comparisons_by_family["entryIndexed"],
        "comparisonsByFamily": comparisons_by_family,
        "candidateComparisons": candidate_comparisons_by_family["entryIndexed"],
        "candidateComparisonsByFamily": candidate_comparisons_by_family,
        "support": {
            key: (detail.get("support") or {}).get(key) for key in (
                "riskSetSourcesAtForecastEnd", "servedForecastThroughSeconds",
                "supportTierAtForecastEnd", "timingSource", "timingEstimated",
            )
        },
        "detail": (
            f"/api/shortsquant/promise-lab/opening-prediction/"
            f"{detail.get('videoId')}?scope=all"
        ),
    }


def _rank(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(len(values), float)
    index = 0
    while index < len(order):
        end = index + 1
        while end < len(order) and values[order[end]] == values[order[index]]:
            end += 1
        ranks[order[index:end]] = (index + end - 1) / 2.0
        index = end
    return ranks


def _correlation(left: np.ndarray, right: np.ndarray, ranked: bool = False) -> float | None:
    valid = np.isfinite(left + right)
    if valid.sum() < 3:
        return None
    x = left[valid]
    y = right[valid]
    if ranked:
        x, y = _rank(x), _rank(y)
    if np.std(x) < 1e-9 or np.std(y) < 1e-9:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def _bootstrap_mean_interval(values, seed_material: str,
                             repetitions: int = 2000) -> dict | None:
    values = _float_array(values)
    values = values[np.isfinite(values)]
    if not len(values):
        return None
    if len(values) == 1:
        value = float(values[0])
        return {"lower": value, "upper": value, "repetitions": 0}
    seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:16], 16)
    rng = np.random.default_rng(seed)
    means = np.empty(repetitions, float)
    for start in range(0, repetitions, 200):
        stop = min(repetitions, start + 200)
        sample = rng.integers(0, len(values), size=(stop - start, len(values)))
        means[start:stop] = values[sample].mean(axis=1)
    lower, upper = np.quantile(means, [0.025, 0.975])
    return {
        "lower": float(lower), "upper": float(upper),
        "repetitions": repetitions,
    }


def _bootstrap_rmse_interval(errors, seed_material: str,
                             repetitions: int = 2000) -> dict | None:
    errors = _float_array(errors)
    errors = errors[np.isfinite(errors)]
    if not len(errors):
        return None
    if len(errors) == 1:
        value = float(abs(errors[0]))
        return {"lower": value, "upper": value, "repetitions": 0}
    seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:16], 16)
    rng = np.random.default_rng(seed)
    values = np.empty(repetitions, float)
    for start in range(0, repetitions, 200):
        stop = min(repetitions, start + 200)
        sample = rng.integers(0, len(errors), size=(stop - start, len(errors)))
        values[start:stop] = np.sqrt(np.mean(errors[sample] ** 2, axis=1))
    lower, upper = np.quantile(values, [0.025, 0.975])
    return {
        "lower": float(lower), "upper": float(upper),
        "repetitions": repetitions,
    }


def _bootstrap_sqrt_mean_interval(squared_errors, seed_material: str,
                                  repetitions: int = 2000) -> dict | None:
    squared_errors = _float_array(squared_errors)
    squared_errors = squared_errors[np.isfinite(squared_errors)]
    if not len(squared_errors):
        return None
    if len(squared_errors) == 1:
        value = float(math.sqrt(max(0.0, squared_errors[0])))
        return {"lower": value, "upper": value, "repetitions": 0}
    seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:16], 16)
    rng = np.random.default_rng(seed)
    values = np.empty(repetitions, float)
    for start in range(0, repetitions, 200):
        stop = min(repetitions, start + 200)
        sample = rng.integers(
            0, len(squared_errors), size=(stop - start, len(squared_errors)),
        )
        values[start:stop] = np.sqrt(np.mean(squared_errors[sample], axis=1))
    lower, upper = np.quantile(values, [0.025, 0.975])
    return {
        "lower": float(lower), "upper": float(upper),
        "repetitions": repetitions,
    }


def _wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> dict | None:
    if total <= 0:
        return None
    proportion = successes / total
    denominator = 1.0 + z * z / total
    center = (proportion + z * z / (2.0 * total)) / denominator
    radius = z * math.sqrt(
        proportion * (1.0 - proportion) / total + z * z / (4.0 * total * total)
    ) / denominator
    return {"lower": center - radius, "upper": center + radius, "total": total}


def _content_component_id(row: dict) -> str:
    """Return the sealed outcome-free content unit used for inference."""
    return str(
        row.get("blindContentComponentId")
        or f"video:{row.get('videoId') or 'unknown'}"
    )


def _mean_finite(values) -> float | None:
    array = _float_array(values)
    array = array[np.isfinite(array)]
    return float(array.mean()) if len(array) else None


def _hierarchical_account_bootstrap_interval(
    values_by_account: dict[str, list[float]],
    seed_material: str,
    repetitions: int = 2000,
) -> dict | None:
    """Bootstrap content components inside accounts, then weight accounts equally."""
    groups = {
        str(account): _float_array(values)[np.isfinite(_float_array(values))]
        for account, values in values_by_account.items()
    }
    groups = {account: values for account, values in groups.items() if len(values)}
    if not groups:
        return None
    observed = float(np.mean([values.mean() for values in groups.values()]))
    if all(len(values) == 1 for values in groups.values()):
        return {"lower": observed, "upper": observed, "repetitions": 0}
    seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:16], 16)
    rng = np.random.default_rng(seed)
    estimates = np.empty(repetitions, float)
    ordered = [groups[account] for account in sorted(groups)]
    for repetition in range(repetitions):
        account_means = []
        for values in ordered:
            sample = rng.integers(0, len(values), size=len(values))
            account_means.append(float(values[sample].mean()))
        estimates[repetition] = float(np.mean(account_means))
    lower, upper = np.quantile(estimates, [0.025, 0.975])
    return {
        "lower": float(lower), "upper": float(upper),
        "repetitions": repetitions,
    }


def _equal_account_sign_flip_pvalue(
    values_by_account: dict[str, list[float]],
    seed_material: str,
    repetitions: int = 2000,
) -> float | None:
    """One-sided paired test on account-equal component improvements."""
    groups = {
        str(account): _float_array(values)[np.isfinite(_float_array(values))]
        for account, values in values_by_account.items()
    }
    groups = {account: values for account, values in groups.items() if len(values)}
    if not groups:
        return None
    ordered = [groups[account] for account in sorted(groups)]
    observed = float(np.mean([values.mean() for values in ordered]))
    seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:16], 16)
    rng = np.random.default_rng(seed)
    at_least_observed = 0
    for _ in range(repetitions):
        permuted_account_means = []
        for values in ordered:
            signs = rng.choice(np.asarray([-1.0, 1.0]), size=len(values))
            permuted_account_means.append(float(np.mean(values * signs)))
        permuted = float(np.mean(permuted_account_means))
        if permuted >= observed - 1e-12:
            at_least_observed += 1
    return (at_least_observed + 1.0) / (repetitions + 1.0)


def _holm_adjust(rows: list[dict], source_key: str, output_key: str) -> None:
    """Attach Holm-adjusted p-values for the predeclared fixed horizons."""
    indexed = [
        (index, _finite(row.get(source_key)))
        for index, row in enumerate(rows)
        if _finite(row.get(source_key)) is not None
    ]
    ordered = sorted(indexed, key=lambda pair: pair[1])
    running = 0.0
    total = len(ordered)
    adjusted = {}
    for rank, (index, value) in enumerate(ordered):
        running = max(running, min(1.0, (total - rank) * value))
        adjusted[index] = running
    for index, row in enumerate(rows):
        row[output_key] = adjusted.get(index)


def _evaluation_metrics(details: list[dict], family_name: str) -> dict:
    eligible = [row for row in details if ((row.get("curves") or {}).get(
        family_name) or {}).get("actual")]
    if not eligible:
        return {
            "videos": 0, "status": "no-comparable-videos",
            "metricFamily": family_name,
        }
    source_count = 0
    per_component_curve_mae = defaultdict(list)
    endpoint_by_component = defaultdict(lambda: {"predicted": [], "actual": []})
    error_by_component_second = defaultdict(list)
    by_second_source_count = defaultdict(int)
    by_second_component = defaultdict(lambda: defaultdict(lambda: {
        "predicted": [], "actual": [], "lower": [], "upper": [],
    }))
    for row in eligible:
        family = row["curves"][family_name]
        predicted = _float_array(family["predicted"])
        actual = _float_array(family["actual"])
        times = _float_array(family.get("timesSeconds") or [])
        valid = (
            np.isfinite(predicted) & np.isfinite(actual) & np.isfinite(times)
            & (times > 1e-9)
        )
        if not valid.any():
            continue
        source_count += 1
        component_id = _content_component_id(row)
        errors = predicted[valid] - actual[valid]
        endpoint_index = int(np.flatnonzero(valid)[-1])
        endpoint_by_component[component_id]["predicted"].append(
            float(predicted[endpoint_index])
        )
        endpoint_by_component[component_id]["actual"].append(
            float(actual[endpoint_index])
        )
        per_component_curve_mae[component_id].append(float(np.mean(np.abs(errors))))
        lower = _float_array(family.get("predictionP10") or [])
        upper = _float_array(family.get("predictionP90") or [])
        for position in np.flatnonzero(valid):
            second = float(times[position])
            by_second_source_count[second] += 1
            bucket = by_second_component[second][component_id]
            bucket["predicted"].append(float(predicted[position]))
            bucket["actual"].append(float(actual[position]))
            bucket["lower"].append(
                float(lower[position]) if len(lower) == len(actual)
                and np.isfinite(lower[position]) else None
            )
            bucket["upper"].append(
                float(upper[position]) if len(upper) == len(actual)
                and np.isfinite(upper[position]) else None
            )
            error_by_component_second[(component_id, second)].append(
                float(predicted[position] - actual[position])
            )
    if not endpoint_by_component:
        return {
            "videos": 0, "status": "no-jointly-supported-videos",
            "metricFamily": family_name,
        }
    endpoint_predicted = np.asarray([
        np.mean(endpoint_by_component[key]["predicted"])
        for key in sorted(endpoint_by_component)
    ], float)
    endpoint_actual = np.asarray([
        np.mean(endpoint_by_component[key]["actual"])
        for key in sorted(endpoint_by_component)
    ], float)
    endpoint_component_errors = [
        np.asarray(endpoint_by_component[key]["predicted"], float)
        - np.asarray(endpoint_by_component[key]["actual"], float)
        for key in sorted(endpoint_by_component)
    ]
    endpoint_mae = np.asarray([
        np.mean(np.abs(values)) for values in endpoint_component_errors
    ], float)
    endpoint_mse = np.asarray([
        np.mean(values ** 2) for values in endpoint_component_errors
    ], float)
    endpoint_bias = np.asarray([
        np.mean(values) for values in endpoint_component_errors
    ], float)
    component_curve_mae = np.asarray([
        np.mean(per_component_curve_mae[key])
        for key in sorted(per_component_curve_mae)
    ], float)
    cell_absolute_errors = np.asarray([
        np.mean(np.abs(values))
        for _, values in sorted(error_by_component_second.items())
    ], float)
    cell_squared_errors = np.asarray([
        np.mean(np.asarray(values, float) ** 2)
        for _, values in sorted(error_by_component_second.items())
    ], float)
    cell_biases = np.asarray([
        np.mean(values) for _, values in sorted(error_by_component_second.items())
    ], float)
    band_hits = []
    accuracy_by_second = []
    for second in sorted(by_second_component):
        component_rows = by_second_component[second]
        component_ids = sorted(component_rows)
        predicted = np.asarray([
            np.mean(component_rows[key]["predicted"]) for key in component_ids
        ], float)
        actual = np.asarray([
            np.mean(component_rows[key]["actual"]) for key in component_ids
        ], float)
        errors = predicted - actual
        component_source_errors = [
            np.asarray(component_rows[key]["predicted"], float)
            - np.asarray(component_rows[key]["actual"], float)
            for key in component_ids
        ]
        component_mae = np.asarray([
            np.mean(np.abs(values)) for values in component_source_errors
        ], float)
        component_mse = np.asarray([
            np.mean(values ** 2) for values in component_source_errors
        ], float)
        component_bias = np.asarray([
            np.mean(values) for values in component_source_errors
        ], float)
        baseline_ss = float(np.sum((actual - actual.mean()) ** 2))
        seed_base = (
            f"{EVALUATION_VERSION}:{family_name}:{second}:"
            + ",".join(component_ids)
        )
        predicted_std = float(np.std(predicted, ddof=1)) if len(predicted) > 1 else 0.0
        actual_std = float(np.std(actual, ddof=1)) if len(actual) > 1 else 0.0
        component_coverages = []
        component_band_widths = []
        for component_id in component_ids:
            band_rows = [
                (actual_value, lower, upper)
                for actual_value, lower, upper in zip(
                    component_rows[component_id]["actual"],
                    component_rows[component_id]["lower"],
                    component_rows[component_id]["upper"],
                )
                if lower is not None and upper is not None
            ]
            if band_rows:
                component_coverages.append(float(np.mean([
                    lower <= actual_value <= upper
                    for actual_value, lower, upper in band_rows
                ])))
                component_band_widths.append(float(np.mean([
                    upper - lower for _, lower, upper in band_rows
                ])))
        band_successes = float(np.sum(component_coverages))
        band_hits.extend(component_coverages)
        accuracy_by_second.append({
            "second": second,
            "videos": by_second_source_count[second],
            "sourceVideos": by_second_source_count[second],
            "contentComponents": len(predicted),
            "predictedMeanPercent": float(predicted.mean()),
            "actualMeanPercent": float(actual.mean()),
            "maePercentagePoints": float(np.mean(component_mae)),
            "rmsePercentagePoints": float(np.sqrt(np.mean(component_mse))),
            "biasPercentagePoints": float(np.mean(component_bias)),
            "maeConfidence95": _bootstrap_mean_interval(
                component_mae, seed_base + ":mae",
            ),
            "rmseConfidence95": _bootstrap_sqrt_mean_interval(
                component_mse, seed_base + ":rmse",
            ),
            "biasConfidence95": _bootstrap_mean_interval(
                component_bias, seed_base + ":bias",
            ),
            "predictedStandardDeviationPercent": predicted_std,
            "actualStandardDeviationPercent": actual_std,
            "discriminationStatus": (
                "unavailable-constant-prediction"
                if predicted_std < 1e-8 else "estimable"
            ),
            "predictionBandCoverageFraction": (
                float(np.mean(component_coverages)) if component_coverages else None
            ),
            "predictionBandCoverageWilson95": _wilson_interval(
                band_successes, len(component_coverages),
            ),
            "predictionBandMeanWidthPoints": (
                float(np.mean(component_band_widths))
                if component_band_widths else None
            ),
            "pearson": _correlation(predicted, actual),
            "spearman": _correlation(predicted, actual, ranked=True),
            "r2AgainstSecondMean": (
                1.0 - float(np.sum(errors ** 2)) / baseline_ss
                if baseline_ss > 1e-9 else None
            ),
        })
    fixed_horizons = {
        str(second): next(
            (row for row in accuracy_by_second
             if abs(float(row["second"]) - float(second)) <= 1e-6),
            None,
        )
        for second in (5, 10, 20, 30)
    }
    fixed_20 = fixed_horizons["20"]
    contains_oof = any(
        row.get("evaluationKind") == "saved-source-level-oof" for row in eligible
    )
    all_frozen_full_fit = all(
        row.get("evaluationKind") != "saved-source-level-oof" for row in eligible
    )
    return {
        "status": "complete",
        "metricFamily": family_name,
        "videos": source_count,
        "sourceVideos": source_count,
        "contentComponents": len(component_curve_mae),
        "statisticalUnit": "outcome-free content component",
        "sourceEqualCurveMAEPercentagePoints": float(np.mean(component_curve_mae)),
        "contentComponentEqualCurveMAEPercentagePoints": float(
            np.mean(component_curve_mae)
        ),
        "sourceEqualCurveMAEConfidence95": _bootstrap_mean_interval(
            component_curve_mae,
            f"{EVALUATION_VERSION}:{family_name}:curve-mae:"
            + ",".join(sorted(per_component_curve_mae)),
        ),
        "contentComponentEqualCurveMAEConfidence95": _bootstrap_mean_interval(
            component_curve_mae,
            f"{EVALUATION_VERSION}:{family_name}:curve-mae:"
            + ",".join(sorted(per_component_curve_mae)),
        ),
        "cellWeightedCurveMAEPercentagePoints": float(np.mean(cell_absolute_errors)),
        "cellWeightedCurveRMSEPercentagePoints": float(
            np.sqrt(np.mean(cell_squared_errors))
        ),
        "cellWeightedCurveBiasPercentagePoints": float(np.mean(cell_biases)),
        "endpointMAEPercentagePoints": float(np.mean(endpoint_mae)),
        "endpointRMSEPercentagePoints": float(np.sqrt(np.mean(endpoint_mse))),
        "endpointBiasPercentagePoints": float(np.mean(endpoint_bias)),
        "endpointPearson": None,
        "endpointSpearman": None,
        "endpointR2AgainstPooledMean": None,
        "endpointCorrelationWithheldReason": (
            "endpoints occur at different seconds, so cross-video correlation would "
            "measure horizon variation rather than fixed-horizon predictive skill"
        ),
        "endpointHorizonPolicy": "last jointly supported second per video; horizons vary",
        "fixed20Second": fixed_20,
        "fixedHorizons": fixed_horizons,
        "residualBandCoverageFraction": (
            float(np.mean(band_hits)) if band_hits else None
        ),
        "accuracyBySecond": accuracy_by_second,
        "contract": {
            "modelRefit": False,
            "modelRecalibrated": False,
            "outcomesUsedForPrediction": False,
            "sameFrozenModelAsTypedScorer": all_frozen_full_fit,
            "containsSourceLevelOOFPredictions": contains_oof,
            "timeZeroExcludedFromAccuracy": True,
            "endpointMetricsAreDescriptive": True,
            "residualBandCoverageInterpretation": (
                "descriptive for mixed or saved-OOF rows; residual quantiles were not "
                "nested inside each saved prediction fold"
                if contains_oof else
                "external evaluation of intervals calibrated on the Main training cohort"
            ),
            "uncertaintyMethod": (
                "deterministic 2,000-resample bootstrap; sealed outcome-free "
                "content components are the resampling unit"
            ),
            "duplicateWeighting": (
                "all source rows remain inspectable; exact and near repost members "
                "are averaged inside one outcome-free content-component vote"
            ),
        },
    }


def evaluation_metrics(details: list[dict]) -> dict:
    entry = _evaluation_metrics(details, "entryIndexed")
    absolute = _evaluation_metrics(details, "observedAbsolute")
    return {
        **entry,
        "families": {
            "entryIndexed": entry,
            "observedAbsolute": absolute,
        },
    }


def evaluation_by_account(details: list[dict]) -> dict:
    grouped = defaultdict(list)
    for row in details:
        grouped[str(row.get("accountId") or "unknown")].append(row)
    return {account: evaluation_metrics(rows) for account, rows in sorted(grouped.items())}


def strict_blind_external_selection(
    details: list[dict],
    near_duplicate_threshold: float | None = NEAR_DUPLICATE_TRIGRAM_JACCARD,
    include_sensitivity: bool = True,
) -> tuple[list[dict], dict]:
    """Build one outcome-free content graph and return its external components.

    Development and external rows share the same graph, so a repost chain cannot
    route around the training boundary. Rows with fewer than one token trigram
    remain visible but are explicitly identity-unverifiable. Repost rows are all
    retained and receive fractional component weights; no opaque representative
    outcome is selected for inference.
    """
    development = [
        row for row in details
        if row.get("evaluationKind") == "saved-source-level-oof"
    ]
    external = [
        row for row in details
        if str(row.get("evaluationKind") or "").startswith("cross-account-")
    ]
    development_ids = {str(row.get("videoId")) for row in development}
    external_ids = {str(row.get("videoId")) for row in external}
    all_rows = {
        str(row.get("videoId")): row for row in development + external
    }
    shingles = {
        video_id: token_trigrams(prediction_text(row))
        for video_id, row in all_rows.items()
    }
    unverifiable_ids = {
        str(row.get("videoId")) for row in external
        if not shingles.get(str(row.get("videoId")))
    }
    graph_ids = sorted(
        development_ids | (external_ids - unverifiable_ids)
    )
    parent = {video_id: video_id for video_id in graph_ids}

    def find(video_id: str, parents=parent) -> str:
        while parents[video_id] != video_id:
            parents[video_id] = parents[parents[video_id]]
            video_id = parents[video_id]
        return video_id

    def union(left: str, right: str, parents=parent) -> None:
        left_root, right_root = find(left, parents), find(right, parents)
        if left_root == right_root:
            return
        smaller, larger = sorted((left_root, right_root))
        parents[larger] = smaller

    exact_groups = defaultdict(list)
    for video_id in graph_ids:
        fingerprint = all_rows[video_id].get("contentFingerprint")
        if fingerprint:
            exact_groups[str(fingerprint)].append(video_id)
    exact_edges = []
    for video_ids in exact_groups.values():
        for video_id in video_ids[1:]:
            union(video_ids[0], video_id)
            exact_edges.append((video_ids[0], video_id))

    minimum_near_score = (
        min(NEAR_DUPLICATE_SENSITIVITY_THRESHOLDS)
        if include_sensitivity else
        near_duplicate_threshold
    )
    near_edges = []
    if minimum_near_score is not None:
        for index, left_id in enumerate(graph_ids):
            left = shingles.get(left_id) or frozenset()
            if not left:
                continue
            for right_id in graph_ids[index + 1:]:
                right = shingles.get(right_id) or frozenset()
                score, shared = trigram_jaccard(left, right)
                if score < minimum_near_score:
                    continue
                exact_match = bool(
                    all_rows[left_id].get("contentFingerprint")
                    and all_rows[left_id].get("contentFingerprint")
                    == all_rows[right_id].get("contentFingerprint")
                )
                near_edges.append({
                    "leftVideoId": left_id,
                    "rightVideoId": right_id,
                    "trigramJaccard": score,
                    "sharedTrigrams": shared,
                    "exactContentFingerprint": exact_match,
                })
                if (
                    near_duplicate_threshold is not None
                    and score >= near_duplicate_threshold
                ):
                    union(left_id, right_id)

    def component_rows(parents: dict) -> dict[str, list[str]]:
        components = defaultdict(list)
        for video_id in graph_ids:
            components[find(video_id, parents)].append(video_id)
        return components

    components = component_rows(parent)
    development_roots = {
        find(video_id) for video_id in development_ids if video_id in parent
    }
    exact_training_fingerprints = {
        row.get("contentFingerprint") for row in development
        if row.get("contentFingerprint")
    }
    exact_overlap_ids = {
        video_id for video_id in external_ids - unverifiable_ids
        if all_rows[video_id].get("contentFingerprint")
        in exact_training_fingerprints
    }
    overlap_ids = {
        video_id for video_id in external_ids - unverifiable_ids
        if find(video_id) in development_roots
    }
    near_overlap_ids = overlap_ids - exact_overlap_ids

    strict_components = []
    selected = []
    duplicate_groups = []
    exact_duplicate_ids = set()
    near_duplicate_ids = set()
    for root, component_ids in sorted(components.items()):
        external_component_ids = sorted(
            set(component_ids) & external_ids
        )
        if not external_component_ids or root in development_roots:
            continue
        component_id = hashlib.sha256(
            json.dumps(external_component_ids, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:20]
        component_rows_value = [all_rows[video_id] for video_id in external_component_ids]
        component_size = len(component_rows_value)
        fingerprints = {
            str(row.get("contentFingerprint")) for row in component_rows_value
            if row.get("contentFingerprint")
        }
        match_kind = (
            "unique" if component_size == 1
            else "exact" if len(fingerprints) == 1
            else "near" if len(fingerprints) == component_size
            else "mixed"
        )
        for member_index, row in enumerate(component_rows_value):
            annotated = copy.deepcopy(row)
            annotated["blindContentComponentId"] = component_id
            annotated["blindContentComponentSize"] = component_size
            annotated["blindContentComponentWeight"] = 1.0 / component_size
            annotated["blindContentComponentMemberIndex"] = member_index
            annotated["blindContentComponentMatchKind"] = match_kind
            selected.append(annotated)
            if member_index > 0:
                if match_kind == "exact":
                    exact_duplicate_ids.add(str(row.get("videoId")))
                else:
                    near_duplicate_ids.add(str(row.get("videoId")))
        strict_components.append(component_id)
        if component_size > 1:
            duplicate_groups.append({
                "contentComponentId": component_id,
                "matchKind": match_kind,
                "videoIds": external_component_ids,
                "accountIds": sorted({
                    str(row.get("accountId")) for row in component_rows_value
                }),
                "count": component_size,
                "statisticalVotes": 1,
            })

    nearest_training = []
    for video_id in sorted(near_overlap_ids):
        candidates = []
        for training_id in sorted(development_ids):
            score, shared = trigram_jaccard(
                shingles.get(video_id) or frozenset(),
                shingles.get(training_id) or frozenset(),
            )
            candidates.append((score, shared, training_id))
        best_score, best_shared, best_training_id = max(
            candidates, default=(0.0, 0, None)
        )
        nearest_training.append({
            "videoId": video_id,
            "trainingVideoId": best_training_id,
            "trigramJaccard": best_score,
            "sharedTrigrams": best_shared,
            "connection": (
                "direct" if (
                    near_duplicate_threshold is not None
                    and best_score >= near_duplicate_threshold
                ) else "component-chain"
            ),
        })

    def policy_counts(threshold: float) -> dict:
        policy_parent = {video_id: video_id for video_id in graph_ids}

        def policy_find(video_id: str) -> str:
            while policy_parent[video_id] != video_id:
                policy_parent[video_id] = policy_parent[policy_parent[video_id]]
                video_id = policy_parent[video_id]
            return video_id

        def policy_union(left: str, right: str) -> None:
            left_root, right_root = policy_find(left), policy_find(right)
            if left_root == right_root:
                return
            smaller, larger = sorted((left_root, right_root))
            policy_parent[larger] = smaller

        for left, right in exact_edges:
            policy_union(left, right)
        for edge in near_edges:
            if edge["trigramJaccard"] >= threshold:
                policy_union(edge["leftVideoId"], edge["rightVideoId"])
        policy_development_roots = {
            policy_find(video_id) for video_id in development_ids
            if video_id in policy_parent
        }
        policy_overlap = {
            video_id for video_id in external_ids - unverifiable_ids
            if policy_find(video_id) in policy_development_roots
        }
        policy_component_roots = {
            policy_find(video_id) for video_id in external_ids - unverifiable_ids
            if video_id not in policy_overlap
        }
        near_external_pairs = [
            edge for edge in near_edges
            if not edge["exactContentFingerprint"]
            and edge["leftVideoId"] in external_ids
            and edge["rightVideoId"] in external_ids
            and edge["trigramJaccard"] >= threshold
        ]
        eligible_videos = len(external_ids - unverifiable_ids - policy_overlap)
        return {
            "threshold": threshold,
            "exactTrainingOverlapVideos": len(exact_overlap_ids),
            "nearTrainingOverlapVideos": len(policy_overlap - exact_overlap_ids),
            "combinedTrainingOverlapVideos": len(policy_overlap),
            "identityUnverifiableVideos": len(unverifiable_ids),
            "strictBlindEligibleVideos": eligible_videos,
            "strictBlindComponents": len(policy_component_roots),
            "externalDuplicateVideosConsolidated": (
                eligible_videos - len(policy_component_roots)
            ),
            "nearExternalDuplicatePairs": len(near_external_pairs),
        }

    sensitivity = [
        policy_counts(threshold)
        for threshold in (
            NEAR_DUPLICATE_SENSITIVITY_THRESHOLDS if include_sensitivity else ()
        )
    ]
    selected_ids = sorted(str(row.get("videoId")) for row in selected)
    component_ids = sorted(set(strict_components))
    duplicate_ids = exact_duplicate_ids | near_duplicate_ids
    return selected, {
        "externalVideosBeforeIsolation": len(external),
        "strictBlindEligibleVideos": len(selected),
        "strictBlindContentComponents": len(component_ids),
        "strictBlindUniqueComponents": len(component_ids),
        "strictBlindUniqueVideos": len(selected),
        "identityUnverifiableVideos": len(unverifiable_ids),
        "identityUnverifiableVideoIds": sorted(unverifiable_ids),
        "nearDuplicateDefinition": (
            "Connected components over exact content hashes and Jaccard similarity "
            "of distinct normalized token trigrams; the primary identity threshold "
            + (f"is {near_duplicate_threshold:.2f}" if near_duplicate_threshold is not None
               else "uses exact hashes only")
        ),
        "nearDuplicateThreshold": near_duplicate_threshold,
        "nearDuplicateThresholdSensitivity": sensitivity,
        "trainingContentOverlapExcluded": len(overlap_ids),
        "trainingContentOverlapVideoIds": sorted(overlap_ids),
        "exactTrainingContentOverlapExcluded": len(exact_overlap_ids),
        "exactTrainingContentOverlapVideoIds": sorted(exact_overlap_ids),
        "nearTrainingContentOverlapExcluded": len(near_overlap_ids),
        "nearTrainingContentOverlapVideoIds": sorted(near_overlap_ids),
        "nearTrainingMatches": nearest_training,
        "externalDuplicateGroupsCollapsed": len(duplicate_groups),
        "externalDuplicateVideosCollapsed": len(duplicate_ids),
        "exactExternalDuplicateVideosCollapsed": len(exact_duplicate_ids),
        "exactExternalDuplicateVideoIds": sorted(exact_duplicate_ids),
        "nearExternalDuplicateVideosCollapsed": len(near_duplicate_ids),
        "nearExternalDuplicateVideoIds": sorted(near_duplicate_ids),
        "duplicateGroups": duplicate_groups,
        "primaryVideoIds": selected_ids,
        "primaryComponentIds": component_ids,
        "primaryVideoIdsFingerprint": hashlib.sha256(
            json.dumps(selected_ids, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
        "primaryComponentIdsFingerprint": hashlib.sha256(
            json.dumps(component_ids, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }


def account_balanced_metrics(details: list[dict]) -> dict:
    by_account = evaluation_by_account(details)
    output = {"accountCount": len(by_account), "byAccount": by_account, "families": {}}
    for family_name in ("entryIndexed", "observedAbsolute"):
        account_rows = []
        for account_id, metrics in by_account.items():
            family = (metrics.get("families") or {}).get(family_name) or metrics
            account_rows.append({
                "accountId": account_id,
                "videos": family.get("videos"),
                "contentComponents": family.get("contentComponents"),
                "sourceEqualCurveMAEPercentagePoints": family.get(
                    "sourceEqualCurveMAEPercentagePoints"
                ),
                "sourceEqualCurveMAEConfidence95": family.get(
                    "sourceEqualCurveMAEConfidence95"
                ),
                "fixed20Second": family.get("fixed20Second") or {},
            })
        curve_values = [
            row["sourceEqualCurveMAEPercentagePoints"] for row in account_rows
            if _finite(row["sourceEqualCurveMAEPercentagePoints"]) is not None
        ]
        fixed_mae = [
            row["fixed20Second"].get("maePercentagePoints") for row in account_rows
            if _finite(row["fixed20Second"].get("maePercentagePoints")) is not None
        ]
        fixed_bias = [
            row["fixed20Second"].get("biasPercentagePoints") for row in account_rows
            if _finite(row["fixed20Second"].get("biasPercentagePoints")) is not None
        ]
        output["families"][family_name] = {
            "accounts": account_rows,
            "macroSourceEqualCurveMAEPercentagePoints": (
                float(np.mean(curve_values)) if curve_values else None
            ),
            "bestAccountCurveMAEPercentagePoints": (
                float(np.min(curve_values)) if curve_values else None
            ),
            "worstAccountCurveMAEPercentagePoints": (
                float(np.max(curve_values)) if curve_values else None
            ),
            "macroFixed20MAEPercentagePoints": (
                float(np.mean(fixed_mae)) if fixed_mae else None
            ),
            "macroFixed20BiasPercentagePoints": (
                float(np.mean(fixed_bias)) if fixed_bias else None
            ),
        }
    return output


def _account_stratified_permutation_pvalue(predicted, actual, accounts,
                                           seed_material: str,
                                           repetitions: int = 2000) -> float | None:
    predicted = _float_array(predicted)
    actual = _float_array(actual)
    accounts = np.asarray([str(value) for value in accounts], object)
    observed = _correlation(predicted, actual)
    if observed is None:
        return None
    seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:16], 16)
    rng = np.random.default_rng(seed)
    groups = [np.flatnonzero(accounts == account) for account in sorted(set(accounts))]
    at_least_observed = 0
    for _ in range(repetitions):
        permuted = actual.copy()
        for indexes in groups:
            if len(indexes) > 1:
                permuted[indexes] = actual[rng.permutation(indexes)]
        value = _correlation(predicted, permuted)
        if value is not None and value >= observed - 1e-12:
            at_least_observed += 1
    return (at_least_observed + 1.0) / (repetitions + 1.0)


def _aggregate_candidate_rows(rows: list[dict], by_account: bool = False) -> list[dict]:
    grouped = defaultdict(list)
    for row in rows:
        component_id = str(
            row.get("componentId") or row.get("blindContentComponentId")
            or f"video:{row.get('videoId')}"
        )
        key = (str(row.get("accountId") or "unknown"), component_id) if by_account else component_id
        grouped[key].append(row)
    output = []
    for key, members in sorted(grouped.items(), key=lambda pair: str(pair[0])):
        if by_account:
            account_id, component_id = key
        else:
            account_id, component_id = None, key
        record = {
            "componentId": component_id,
            "sourceVideos": len(members),
            "candidateStage": members[0].get("candidateStage"),
            "accountIds": sorted({str(row.get("accountId") or "unknown") for row in members}),
        }
        if account_id is not None:
            record["accountId"] = account_id
        for field in (
            "baseline", "candidate", "actual", "baselineMAE",
            "candidateMAE", "baselineError", "candidateError", "improvement",
        ):
            values = [row.get(field) for row in members]
            mean = _mean_finite(values)
            if mean is not None:
                record[field] = mean
        output.append(record)
    return output


def _candidate_fixed_metrics(rows: list[dict], family_name: str,
                             second: float, inferential: bool = True) -> dict | None:
    if not rows:
        return None
    loss_rows = []
    for row in rows:
        baseline_error = abs(float(row["baseline"]) - float(row["actual"]))
        candidate_error = abs(float(row["candidate"]) - float(row["actual"]))
        loss_rows.append({
            **row,
            "baselineError": baseline_error,
            "candidateError": candidate_error,
            "improvement": baseline_error - candidate_error,
        })
    component_cells = _aggregate_candidate_rows(loss_rows)
    account_cells = _aggregate_candidate_rows(loss_rows, by_account=True)
    baseline = np.asarray([row["baseline"] for row in component_cells], float)
    candidate = np.asarray([row["candidate"] for row in component_cells], float)
    actual = np.asarray([row["actual"] for row in component_cells], float)
    baseline_errors = np.asarray([
        row["baselineError"] for row in component_cells
    ], float)
    candidate_errors = np.asarray([
        row["candidateError"] for row in component_cells
    ], float)
    improvements = np.asarray([
        row["improvement"] for row in component_cells
    ], float)
    source_wins_by_component = defaultdict(list)
    for row in loss_rows:
        source_improvement = float(row["improvement"])
        component_id = str(
            row.get("componentId") or row.get("blindContentComponentId")
            or f"video:{row.get('videoId')}"
        )
        source_wins_by_component[component_id].append(source_improvement > 0.0)
    component_win_fractions = [
        float(np.mean(values)) for _, values in sorted(source_wins_by_component.items())
    ]
    actual_ss = float(np.sum((actual - actual.mean()) ** 2))
    candidate_std = float(np.std(candidate, ddof=1)) if len(candidate) > 1 else 0.0
    pearson = _correlation(candidate, actual)
    spearman = _correlation(candidate, actual, ranked=True)
    seed_base = (
        f"{EVALUATION_VERSION}:{family_name}:candidate-fixed:{second}:"
        + ",".join(row["componentId"] for row in component_cells)
    )
    improvement_interval = (
        _bootstrap_mean_interval(improvements, seed_base + ":improvement")
        if inferential else None
    )
    account_improvements = defaultdict(list)
    account_baseline_mae = defaultdict(list)
    account_candidate_mae = defaultdict(list)
    for cell in account_cells:
        baseline_error = cell["baselineError"]
        candidate_error = cell["candidateError"]
        account = cell["accountId"]
        account_baseline_mae[account].append(baseline_error)
        account_candidate_mae[account].append(candidate_error)
        account_improvements[account].append(baseline_error - candidate_error)
    macro_baseline = _mean_finite([
        np.mean(values) for values in account_baseline_mae.values()
    ])
    macro_candidate = _mean_finite([
        np.mean(values) for values in account_candidate_mae.values()
    ])
    macro_improvement = _mean_finite([
        np.mean(values) for values in account_improvements.values()
    ])
    macro_interval = (
        _hierarchical_account_bootstrap_interval(
            account_improvements, seed_base + ":hierarchical-account-improvement",
        ) if inferential else None
    )
    paired_sign_flip_p = (
        _equal_account_sign_flip_pvalue(
            account_improvements, seed_base + ":paired-sign-flip",
        ) if inferential else None
    )
    permutation_p = (
        _account_stratified_permutation_pvalue(
            [row["candidate"] for row in account_cells],
            [row["actual"] for row in account_cells],
            [row["accountId"] for row in account_cells],
            seed_base + ":account-stratified-permutation",
        ) if inferential else None
    )
    by_account = []
    for account_id in sorted(account_improvements) if inferential else []:
        cells = [row for row in account_cells if row["accountId"] == account_id]
        account_candidate = np.asarray([row["candidate"] for row in cells], float)
        account_actual = np.asarray([row["actual"] for row in cells], float)
        improvement_values = np.asarray(account_improvements[account_id], float)
        by_account.append({
            "accountId": account_id,
            "videos": sum(row["sourceVideos"] for row in cells),
            "contentComponents": len(cells),
            "candidatePearson": _correlation(account_candidate, account_actual),
            "candidateSpearman": _correlation(
                account_candidate, account_actual, ranked=True,
            ),
            "baselineMAEPercentagePoints": float(np.mean(account_baseline_mae[account_id])),
            "candidateMAEPercentagePoints": float(np.mean(account_candidate_mae[account_id])),
            "pairedImprovementPercentagePoints": float(np.mean(improvement_values)),
        })
    return {
        "second": float(second),
        "videos": len(rows),
        "sourceVideos": len(rows),
        "contentComponents": len(component_cells),
        "accountComponentCells": len(account_cells),
        "statisticalUnit": "outcome-free content component",
        "candidateStage": rows[0]["candidateStage"],
        "baselineMAEPercentagePoints": float(np.mean(baseline_errors)),
        "candidateMAEPercentagePoints": float(np.mean(candidate_errors)),
        "pairedImprovementPercentagePoints": float(np.mean(improvements)),
        "pairedImprovementConfidence95": improvement_interval,
        "candidateWinFraction": float(np.mean(component_win_fractions)),
        "candidatePredictedMeanPercent": float(candidate.mean()),
        "candidatePredictedStandardDeviationPercent": candidate_std,
        "actualMeanPercent": float(actual.mean()),
        "actualStandardDeviationPercent": (
            float(np.std(actual, ddof=1)) if len(actual) > 1 else 0.0
        ),
        "candidatePearson": pearson,
        "candidateSpearman": spearman,
        "candidateR2AgainstSecondMean": (
            1.0 - float(np.sum((candidate - actual) ** 2)) / actual_ss
            if actual_ss > 1e-9 else None
        ),
        "accountStratifiedPositivePearsonPermutationP": permutation_p,
        "pairedPositiveSignFlipP": paired_sign_flip_p,
        "pairedImprovementSignFlipP": paired_sign_flip_p,
        "equalAccountMacro": {
            "accounts": len(account_improvements),
            "baselineMAEPercentagePoints": macro_baseline,
            "candidateMAEPercentagePoints": macro_candidate,
            "pairedImprovementPercentagePoints": macro_improvement,
            "pairedImprovementConfidence95": macro_interval,
            "pairedPositiveSignFlipP": paired_sign_flip_p,
        },
        "passesErrorGate": False,
        "passesRankingGate": False,
        "blindSkillStatus": (
            "descriptive-only" if not inferential
            else "pending-multiplicity-adjustment"
            if candidate_std >= 1e-8 else "unavailable-constant-candidate"
        ),
        "byAccount": by_account,
        "modelStageChanged": False,
    }


def candidate_vs_baseline(details: list[dict]) -> dict:
    """Evaluate the frozen diagnostic candidate without promoting or refitting it."""
    result = {"status": "diagnostic-only-no-promotion", "families": {}}
    for family_name in ("entryIndexed", "observedAbsolute"):
        rows = []
        by_second = defaultdict(list)
        for detail in details:
            family = (detail.get("curves") or {}).get(family_name) or {}
            stages = family.get("stages") or {}
            candidate_name = str(family.get("candidateStage") or "relationships")
            baseline = _float_array(stages.get("baseline") or [])
            candidate = _float_array(stages.get(candidate_name) or [])
            actual = _float_array(family.get("actual") or [])
            times = _float_array(family.get("timesSeconds") or [])
            if not (len(baseline) == len(candidate) == len(actual) == len(times)):
                continue
            valid = (
                np.isfinite(baseline) & np.isfinite(candidate)
                & np.isfinite(actual) & np.isfinite(times) & (times > 1e-9)
            )
            if not valid.any():
                continue
            baseline_mae = float(np.mean(np.abs(baseline[valid] - actual[valid])))
            candidate_mae = float(np.mean(np.abs(candidate[valid] - actual[valid])))
            row = {
                "videoId": str(detail.get("videoId")),
                "accountId": str(detail.get("accountId")),
                "componentId": _content_component_id(detail),
                "candidateStage": candidate_name,
                "baselineMAE": baseline_mae,
                "candidateMAE": candidate_mae,
                "improvement": baseline_mae - candidate_mae,
            }
            rows.append(row)
            for position in np.flatnonzero(valid):
                by_second[float(times[position])].append({
                    "videoId": row["videoId"],
                    "accountId": row["accountId"],
                    "componentId": row["componentId"],
                    "candidateStage": candidate_name,
                    "baseline": float(baseline[position]),
                    "candidate": float(candidate[position]),
                    "actual": float(actual[position]),
                })
        component_rows = _aggregate_candidate_rows(rows)
        account_cells = _aggregate_candidate_rows(rows, by_account=True)
        improvements = [row["improvement"] for row in component_rows]
        account_improvements = defaultdict(list)
        account_baselines = defaultdict(list)
        account_candidates = defaultdict(list)
        for cell in account_cells:
            account = cell["accountId"]
            account_improvements[account].append(cell["improvement"])
            account_baselines[account].append(cell["baselineMAE"])
            account_candidates[account].append(cell["candidateMAE"])
        accuracy_by_second = [
            _candidate_fixed_metrics(
                by_second[second], family_name, second,
                inferential=second in (5.0, 10.0, 20.0, 30.0),
            )
            for second in sorted(by_second)
        ]
        accuracy_by_second = [row for row in accuracy_by_second if row is not None]
        inferential_rows = [
            row for row in accuracy_by_second
            if float(row.get("second") or -1) in (5.0, 10.0, 20.0, 30.0)
        ]
        _holm_adjust(
            inferential_rows, "pairedImprovementSignFlipP",
            "pairedImprovementSignFlipHolmAdjustedP",
        )
        _holm_adjust(
            inferential_rows, "accountStratifiedPositivePearsonPermutationP",
            "accountStratifiedPositivePearsonPermutationHolmAdjustedP",
        )
        for row in inferential_rows:
            row["holmAdjustedPairedPositiveSignFlipP"] = row.get(
                "pairedImprovementSignFlipHolmAdjustedP"
            )
            row["holmAdjustedPositivePearsonPermutationP"] = row.get(
                "accountStratifiedPositivePearsonPermutationHolmAdjustedP"
            )
            macro = row.get("equalAccountMacro") or {}
            lower = _finite((macro.get("pairedImprovementConfidence95") or {}).get("lower"))
            sign_flip_p = _finite(row.get("holmAdjustedPairedPositiveSignFlipP"))
            rank_p = _finite(row.get("holmAdjustedPositivePearsonPermutationP"))
            pearson = _finite(row.get("candidatePearson"))
            row["passesErrorGate"] = bool(
                lower is not None and lower > 0.0
                and sign_flip_p is not None and sign_flip_p < 0.05
            )
            row["passesRankingGate"] = bool(
                pearson is not None and pearson > 0.0
                and rank_p is not None and rank_p < 0.05
            )
            row["blindSkillStatus"] = (
                "passes-error-and-ranking-gates"
                if row["passesErrorGate"] and row["passesRankingGate"]
                else "no-confirmed-positive-skill"
            )
        fixed_horizons = {
            str(second): next(
                (row for row in accuracy_by_second
                 if abs(float(row["second"]) - float(second)) <= 1e-6),
                None,
            )
            for second in (5, 10, 20, 30)
        }
        account_rows = []
        for account_id in sorted(account_improvements):
            group = [row for row in account_cells if row["accountId"] == account_id]
            account_rows.append({
                "accountId": account_id,
                "videos": sum(row["sourceVideos"] for row in group),
                "contentComponents": len(group),
                "baselineCurveMAEPercentagePoints": float(np.mean([
                    row["baselineMAE"] for row in group
                ])),
                "candidateCurveMAEPercentagePoints": float(np.mean([
                    row["candidateMAE"] for row in group
                ])),
                "pairedImprovementPercentagePoints": float(np.mean([
                    row["improvement"] for row in group
                ])),
            })
        result["families"][family_name] = {
            "videos": len(rows),
            "sourceVideos": len(rows),
            "contentComponents": len(component_rows),
            "accountComponentCells": len(account_cells),
            "statisticalUnit": "outcome-free content component",
            "candidateStage": rows[0]["candidateStage"] if rows else None,
            "baselineCurveMAEPercentagePoints": (
                float(np.mean([row["baselineMAE"] for row in component_rows]))
                if component_rows else None
            ),
            "candidateCurveMAEPercentagePoints": (
                float(np.mean([row["candidateMAE"] for row in component_rows]))
                if component_rows else None
            ),
            "pairedImprovementPercentagePoints": (
                float(np.mean(improvements)) if improvements else None
            ),
            "pairedImprovementConfidence95": _bootstrap_mean_interval(
                improvements,
                f"{EVALUATION_VERSION}:{family_name}:candidate-v-baseline:"
                + ",".join(row["componentId"] for row in component_rows),
            ),
            "candidateWinFraction": (
                float(np.mean([
                    np.mean([
                        source["improvement"] > 0.0 for source in rows
                        if source["componentId"] == component["componentId"]
                    ])
                    for component in component_rows
                ])) if component_rows else None
            ),
            "accuracyBySecond": accuracy_by_second,
            "fixedHorizons": fixed_horizons,
            "fixed20Second": fixed_horizons["20"],
            "byAccount": account_rows,
            "equalAccountMacro": {
                "accounts": len(account_improvements),
                "baselineCurveMAEPercentagePoints": _mean_finite([
                    np.mean(values) for values in account_baselines.values()
                ]),
                "candidateCurveMAEPercentagePoints": _mean_finite([
                    np.mean(values) for values in account_candidates.values()
                ]),
                "pairedImprovementPercentagePoints": _mean_finite([
                    np.mean(values) for values in account_improvements.values()
                ]),
                "pairedImprovementConfidence95": _hierarchical_account_bootstrap_interval(
                    account_improvements,
                    f"{EVALUATION_VERSION}:{family_name}:candidate-v-baseline:macro",
                ),
                "pairedPositiveSignFlipP": _equal_account_sign_flip_pvalue(
                    account_improvements,
                    f"{EVALUATION_VERSION}:{family_name}:candidate-v-baseline:sign-flip",
                ),
            },
            "promotionGate": (
                "A diagnostic candidate must lower equal-account error with a positive "
                "hierarchical-bootstrap lower bound and Holm-adjusted paired sign-flip "
                "test, then show positive Holm-adjusted account-stratified fixed-horizon "
                "ranking. This audit cannot promote it."
            ),
            "modelStageChanged": False,
        }
    return result


def candidate_leakage_sensitivity(details: list[dict]) -> dict:
    """Re-report frozen candidate skill under every declared isolation policy.

    Policies are evaluated in full and shown together. Outcomes never select a
    similarity cutoff, and this diagnostic cannot change the deployed stage.
    """
    policies = [
        ("exact-only", "exact only", None),
        ("near-0.90", "near 0.90", 0.90),
        ("near-0.80", "near 0.80 · primary", 0.80),
        ("near-0.70", "near 0.70", 0.70),
    ]
    output = {
        "status": "diagnostic-only-all-predeclared-policies",
        "similarity": "Jaccard similarity of distinct normalized token trigrams",
        "families": {
            "entryIndexed": {"policies": []},
            "observedAbsolute": {"policies": []},
        },
        "modelStageChanged": False,
    }
    for policy_key, label, threshold in policies:
        selected = []
        for detail in details:
            policy = (detail.get("blindIsolationPolicies") or {}).get(policy_key) or {}
            if not policy.get("eligible"):
                continue
            annotated = copy.deepcopy(detail)
            annotated["blindContentComponentId"] = policy.get("contentComponentId")
            annotated["blindContentComponentSize"] = policy.get("contentComponentSize")
            annotated["blindContentComponentWeight"] = policy.get("contentComponentWeight")
            selected.append(annotated)
        diagnostic = candidate_vs_baseline(selected)
        for family_name in ("entryIndexed", "observedAbsolute"):
            family = (diagnostic.get("families") or {}).get(family_name) or {}
            output["families"][family_name]["policies"].append({
                "policyKey": policy_key,
                "label": label,
                "maximumNearDuplicateSimilarity": threshold,
                "strictBlindVideos": family.get("sourceVideos"),
                "strictBlindContentComponents": family.get("contentComponents"),
                "candidateVideos": family.get("videos"),
                "candidateContentComponents": family.get("contentComponents"),
                "candidateStage": family.get("candidateStage"),
                "baselineCurveMAEPercentagePoints": family.get(
                    "baselineCurveMAEPercentagePoints"
                ),
                "candidateCurveMAEPercentagePoints": family.get(
                    "candidateCurveMAEPercentagePoints"
                ),
                "pairedImprovementPercentagePoints": family.get(
                    "pairedImprovementPercentagePoints"
                ),
                "pairedImprovementConfidence95": family.get(
                    "pairedImprovementConfidence95"
                ),
                "candidateWinFraction": family.get("candidateWinFraction"),
                "fixed20Second": family.get("fixed20Second"),
                "equalAccountMacro": family.get("equalAccountMacro"),
                "modelStageChanged": False,
            })
    return output
