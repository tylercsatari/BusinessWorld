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

import numpy as np

from cluster_outcomes import exact_token_timings, retention_at
from sequence import normalize_source, tokenize


CAPTION_TIMING_SOURCE = (
    "YouTube source-media automatic caption word offsets; observed outcome "
    "curves are joined only after frozen inference"
)
EVALUATION_VERSION = "promise-pooled-external-evaluation-v3-sealed-blind"


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


def outcome_blind_prediction(analysis: dict) -> dict:
    """Return the serving prediction with every joined outcome removed."""
    target_outcome_keys = {
        "actual", "predictionError", "observedCurves", "comparisons",
        "comparisonsByFamily", "blindPredictionFingerprint",
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


def _evaluation_metrics(details: list[dict], family_name: str) -> dict:
    eligible = [row for row in details if ((row.get("curves") or {}).get(
        family_name) or {}).get("actual")]
    if not eligible:
        return {
            "videos": 0, "status": "no-comparable-videos",
            "metricFamily": family_name,
        }
    endpoint_predicted_values = []
    endpoint_actual_values = []
    per_source_mae = []
    all_errors = []
    band_hits = []
    by_second = defaultdict(lambda: {
        "predicted": [], "actual": [], "lower": [], "upper": [], "videoIds": [],
    })
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
        errors = predicted[valid] - actual[valid]
        endpoint_index = int(np.flatnonzero(valid)[-1])
        endpoint_predicted_values.append(float(predicted[endpoint_index]))
        endpoint_actual_values.append(float(actual[endpoint_index]))
        per_source_mae.append(float(np.mean(np.abs(errors))))
        all_errors.extend(errors.tolist())
        lower = _float_array(family.get("predictionP10") or [])
        upper = _float_array(family.get("predictionP90") or [])
        if len(lower) == len(actual) == len(upper):
            band_valid = valid & np.isfinite(lower) & np.isfinite(upper)
            band_hits.extend(
                ((actual[band_valid] >= lower[band_valid])
                 & (actual[band_valid] <= upper[band_valid])).tolist()
            )
        for position in np.flatnonzero(valid):
            bucket = by_second[float(times[position])]
            bucket["predicted"].append(float(predicted[position]))
            bucket["actual"].append(float(actual[position]))
            bucket["videoIds"].append(str(row.get("videoId") or "unknown"))
            bucket["lower"].append(
                float(lower[position]) if len(lower) == len(actual)
                and np.isfinite(lower[position]) else None
            )
            bucket["upper"].append(
                float(upper[position]) if len(upper) == len(actual)
                and np.isfinite(upper[position]) else None
            )
    if not endpoint_predicted_values:
        return {
            "videos": 0, "status": "no-jointly-supported-videos",
            "metricFamily": family_name,
        }
    endpoint_predicted = np.asarray(endpoint_predicted_values, float)
    endpoint_actual = np.asarray(endpoint_actual_values, float)
    endpoint_errors = endpoint_predicted - endpoint_actual
    all_errors = np.asarray(all_errors, float)
    accuracy_by_second = []
    for second in sorted(by_second):
        predicted = np.asarray(by_second[second]["predicted"], float)
        actual = np.asarray(by_second[second]["actual"], float)
        errors = predicted - actual
        baseline_ss = float(np.sum((actual - actual.mean()) ** 2))
        seed_base = (
            f"{EVALUATION_VERSION}:{family_name}:{second}:"
            + ",".join(by_second[second]["videoIds"])
        )
        predicted_std = float(np.std(predicted, ddof=1)) if len(predicted) > 1 else 0.0
        actual_std = float(np.std(actual, ddof=1)) if len(actual) > 1 else 0.0
        band_rows = [
            (actual_value, lower, upper)
            for actual_value, lower, upper in zip(
                actual, by_second[second]["lower"], by_second[second]["upper"],
            )
            if lower is not None and upper is not None
        ]
        band_successes = sum(
            lower <= actual_value <= upper for actual_value, lower, upper in band_rows
        )
        accuracy_by_second.append({
            "second": second,
            "videos": len(predicted),
            "predictedMeanPercent": float(predicted.mean()),
            "actualMeanPercent": float(actual.mean()),
            "maePercentagePoints": float(np.mean(np.abs(errors))),
            "rmsePercentagePoints": float(np.sqrt(np.mean(errors ** 2))),
            "biasPercentagePoints": float(errors.mean()),
            "maeConfidence95": _bootstrap_mean_interval(
                np.abs(errors), seed_base + ":mae",
            ),
            "rmseConfidence95": _bootstrap_rmse_interval(
                errors, seed_base + ":rmse",
            ),
            "biasConfidence95": _bootstrap_mean_interval(
                errors, seed_base + ":bias",
            ),
            "predictedStandardDeviationPercent": predicted_std,
            "actualStandardDeviationPercent": actual_std,
            "discriminationStatus": (
                "unavailable-constant-prediction"
                if predicted_std < 1e-8 else "estimable"
            ),
            "predictionBandCoverageFraction": (
                band_successes / len(band_rows) if band_rows else None
            ),
            "predictionBandCoverageWilson95": _wilson_interval(
                band_successes, len(band_rows),
            ),
            "predictionBandMeanWidthPoints": (
                float(np.mean([upper - lower for _, lower, upper in band_rows]))
                if band_rows else None
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
        "videos": len(endpoint_predicted),
        "sourceEqualCurveMAEPercentagePoints": float(np.mean(per_source_mae)),
        "sourceEqualCurveMAEConfidence95": _bootstrap_mean_interval(
            per_source_mae,
            f"{EVALUATION_VERSION}:{family_name}:curve-mae:"
            + ",".join(str(row.get("videoId") or "unknown") for row in eligible),
        ),
        "cellWeightedCurveMAEPercentagePoints": float(np.mean(np.abs(all_errors))),
        "cellWeightedCurveRMSEPercentagePoints": float(np.sqrt(np.mean(all_errors ** 2))),
        "cellWeightedCurveBiasPercentagePoints": float(np.mean(all_errors)),
        "endpointMAEPercentagePoints": float(np.mean(np.abs(endpoint_errors))),
        "endpointRMSEPercentagePoints": float(np.sqrt(np.mean(endpoint_errors ** 2))),
        "endpointBiasPercentagePoints": float(np.mean(endpoint_errors)),
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
                "deterministic 2,000-resample source bootstrap; videos are the "
                "resampling unit"
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


def strict_blind_external_selection(details: list[dict]) -> tuple[list[dict], dict]:
    """Remove training-content overlap and collapse exact external reposts."""
    training_fingerprints = {
        row.get("contentFingerprint") for row in details
        if row.get("evaluationKind") == "saved-source-level-oof"
        and row.get("contentFingerprint")
    }
    external = [
        row for row in details
        if str(row.get("evaluationKind") or "").startswith("cross-account-")
    ]
    overlap = [
        row for row in external
        if row.get("contentFingerprint") in training_fingerprints
    ]
    overlap_ids = {str(row.get("videoId")) for row in overlap}
    groups = defaultdict(list)
    for row in external:
        if str(row.get("videoId")) in overlap_ids:
            continue
        key = row.get("contentFingerprint") or f"video:{row.get('videoId')}"
        groups[str(key)].append(row)
    selected = []
    duplicate_groups = []
    duplicate_ids = set()
    for key, rows in sorted(groups.items()):
        rows = sorted(rows, key=lambda row: str(row.get("videoId") or ""))
        selected.append(rows[0])
        if len(rows) > 1:
            duplicate_ids.update(str(row.get("videoId")) for row in rows[1:])
            duplicate_groups.append({
                "contentFingerprint": key,
                "videoIds": [str(row.get("videoId")) for row in rows],
                "accountIds": sorted({str(row.get("accountId")) for row in rows}),
                "count": len(rows),
            })
    selected_ids = [str(row.get("videoId")) for row in selected]
    return selected, {
        "externalVideosBeforeIsolation": len(external),
        "strictBlindUniqueVideos": len(selected),
        "trainingContentOverlapExcluded": len(overlap),
        "trainingContentOverlapVideoIds": sorted(overlap_ids),
        "externalDuplicateGroupsCollapsed": len(duplicate_groups),
        "externalDuplicateVideosCollapsed": len(duplicate_ids),
        "duplicateGroups": duplicate_groups,
        "primaryVideoIds": selected_ids,
        "primaryVideoIdsFingerprint": hashlib.sha256(
            json.dumps(selected_ids, separators=(",", ":")).encode("utf-8")
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


def candidate_vs_baseline(details: list[dict]) -> dict:
    """Evaluate the frozen diagnostic candidate without promoting or refitting it."""
    result = {"status": "diagnostic-only-no-promotion", "families": {}}
    for family_name in ("entryIndexed", "observedAbsolute"):
        rows = []
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
            rows.append({
                "videoId": str(detail.get("videoId")),
                "accountId": str(detail.get("accountId")),
                "candidateStage": candidate_name,
                "baselineMAE": baseline_mae,
                "candidateMAE": candidate_mae,
                "improvement": baseline_mae - candidate_mae,
            })
        improvements = [row["improvement"] for row in rows]
        result["families"][family_name] = {
            "videos": len(rows),
            "candidateStage": rows[0]["candidateStage"] if rows else None,
            "baselineCurveMAEPercentagePoints": (
                float(np.mean([row["baselineMAE"] for row in rows])) if rows else None
            ),
            "candidateCurveMAEPercentagePoints": (
                float(np.mean([row["candidateMAE"] for row in rows])) if rows else None
            ),
            "pairedImprovementPercentagePoints": (
                float(np.mean(improvements)) if improvements else None
            ),
            "pairedImprovementConfidence95": _bootstrap_mean_interval(
                improvements,
                f"{EVALUATION_VERSION}:{family_name}:candidate-v-baseline:"
                + ",".join(row["videoId"] for row in rows),
            ),
            "candidateWinFraction": (
                float(np.mean(np.asarray(improvements) > 0)) if improvements else None
            ),
            "modelStageChanged": False,
        }
    return result
