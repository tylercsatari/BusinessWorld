#!/usr/bin/env python3
"""Score one Shorts opening with the shared variable-horizon predictor."""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

from context_scoring import score_component_context
from embedding_store import EmbeddingStore, R2_PREFIX, R2Store, json_ready
from hook_score_core import row_unit
from opening_predictor import (
    FEATURE_VERSION,
    PREDICTOR_VERSION,
    apply_scalar_stage,
    build_causal_sequence_feature_stages,
    temporal_attribution,
    views_from_retention5,
)
from sequence import normalize_source, surface, tokenize
from streaming_components import attach_viewer_context, build_streaming_components


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
PARTITION_FILE = "canonical-partition-model.json"
OPENING_MODEL_FILE = "opening-20s-model.json"
OPENING_RETENTION_MODEL_FILE = "opening-retention-model.json"
CONTEXT_STUDY_FILE = "opening-context-study.json"


def _decode_json(payload: bytes) -> dict:
    try:
        payload = gzip.decompress(payload)
    except (gzip.BadGzipFile, OSError):
        pass
    return json.loads(payload.decode("utf-8"))


def load_artifact(filename: str, refresh: bool = False) -> dict:
    local = CACHE / filename
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8"))
    runtime = Path(os.environ.get(
        "PROMISE_HOOK_RUNTIME_CACHE", "/tmp/businessworld-promise-hook",
    ))
    runtime.mkdir(parents=True, exist_ok=True)
    cached = runtime / filename
    if cached.exists() and not refresh and time.time() - cached.stat().st_mtime < 3600:
        return json.loads(cached.read_text(encoding="utf-8"))
    payload = R2Store().get_bytes(f"{R2_PREFIX}/{filename}.gz")
    if not payload:
        raise RuntimeError(f"Promise Lab artifact is unavailable: {filename}")
    value = _decode_json(payload)
    cached.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    return value


def _embedding_cache_path() -> Path:
    if CACHE.exists() and (CACHE / PARTITION_FILE).exists():
        return CACHE / "hook-live-embeddings.sqlite3"
    return Path(os.environ.get(
        "PROMISE_HOOK_EMBED_CACHE", "/tmp/businessworld-promise-hook/embeddings.sqlite3",
    ))




def _variable_prediction_scope(text: str, model: dict,
                               planned_duration_seconds: float | None) -> dict:
    normalized = normalize_source(text)
    tokens = tokenize(normalized)
    lexical = [
        token for token in tokens
        if any(character.isalnum() or character == "_" for character in token.text)
    ]
    if not lexical:
        raise ValueError("an opening needs at least one lexical atom")
    support = model.get("support") or {}
    rate = float(support.get("meanWordsPerSecond") or 0.0)
    if rate <= 0:
        raise RuntimeError("the opening model has no measured speaking-rate support")
    supplied = None
    if planned_duration_seconds is not None:
        supplied = float(planned_duration_seconds)
        if not math.isfinite(supplied) or supplied <= 0:
            raise ValueError("planned spoken duration must be a positive number of seconds")
    duration = supplied if supplied is not None else len(lexical) / rate
    supported = float(
        support.get("semanticModelHorizonSeconds")
        or model.get("analysisHorizonSeconds")
        or 0.0
    )
    if supported <= 0:
        raise RuntimeError("the opening model has no supported temporal horizon")
    forecast_end = min(duration, supported)
    return {
        "inputText": normalized,
        "analyzedText": normalized,
        "structuralText": normalized,
        "inputWasTruncated": False,
        "excludedText": None,
        "plannedSpokenSeconds": supplied,
        "estimatedSpokenSeconds": float(duration),
        "structuralDurationSeconds": float(duration),
        "forecastDurationSeconds": float(forecast_end),
        "forecastStopReason": (
            "supplied sequence endpoint" if duration <= supported + 1e-9 else
            "duration-conditioned cohort risk set falls below the declared model minimum"
        ),
        "timingEstimated": supplied is None,
        "timingSource": (
            "user-supplied planned spoken duration" if supplied is not None else
            f"mean speaking rate across {int(support.get('speakingRateSourceCount') or 0)} source videos"
        ),
        "wordsPerSecond": rate,
        "inputLexicalTokens": len(lexical),
        "analyzedLexicalTokens": len(lexical),
        "structurallyUncapped": True,
        "retentionUnsupportedAfterSeconds": float(supported),
    }


def _typed_token_clock(tokens: list, duration: float) -> list[dict]:
    lexical = np.asarray([
        any(character.isalnum() or character == "_" for character in token.text)
        for token in tokens
    ], bool)
    count = int(lexical.sum())
    if count < 1:
        raise ValueError("an opening needs at least one lexical atom")
    output = []
    completed = 0
    for token, is_lexical in zip(tokens, lexical):
        if is_lexical:
            start = duration * completed / count
            completed += 1
            end = duration * completed / count
        else:
            start = end = duration * completed / count
        output.append({
            "index": int(token.index),
            "startSeconds": float(start),
            "endSeconds": float(end),
            "lexical": bool(is_lexical),
        })
    return output


def _attach_typed_component_timing(decomposition: dict, token_clock: list[dict]) -> None:
    blocks = {int(row["index"]): row for row in decomposition["blocks"]}
    for component in decomposition["chunks"]:
        start = int(component["start"])
        end = int(component["end"])
        block = blocks[int(component["blockIndex"])]
        evidence_end = int(block["evidenceWindowEndToken"])
        component.update({
            "startToken": start,
            "endToken": end,
            "spokenStartSeconds": float(token_clock[start]["startSeconds"]),
            "spokenEndSeconds": float(token_clock[end - 1]["endSeconds"]),
            "boundaryEvidenceAvailableSeconds": float(
                token_clock[evidence_end - 1]["endSeconds"]
            ),
            "timingSource": "planned duration distributed over lexical atoms",
            "causalFeaturePolicy": (
                "enters component and relationship features only after its complete "
                "outcome-blind boundary-evidence window is available"
            ),
        })


def _typed_causal_support(opening_model: dict, retention_model: dict) -> dict:
    configured = int(
        (retention_model.get("featureContract") or {}).get(
            "causalBoundaryWindowTokens"
        ) or 0
    )
    measured = opening_model.get("lengthSupport") or {}
    minimum = configured or int(measured.get("fullHookTokenMinimum") or 0)
    if minimum < 2:
        raise RuntimeError("the serving model has no measured causal boundary window")
    return {
        "source": "frozen serving-model causal boundary window",
        "fullHookTokenMinimum": minimum,
        "fullHookTokenMaximum": minimum,
        "causalFixedWindow": True,
    }


def _variable_prefix_features(primitives: dict, decomposition: dict, scope: dict,
                              model: dict, store: EmbeddingStore) -> tuple[dict, list[dict]]:
    tokens = primitives["tokens"]
    clock = primitives["tokenClock"]
    forecast_end = float(scope["forecastDurationSeconds"])
    model_rows = list(((model.get("families") or {}).get("entryIndexed") or {}).get(
        "temporalModels"
    ) or [])
    maximum_model_second = max(int(round(float(row["second"]))) for row in model_rows)
    integer_end = min(maximum_model_second, int(math.ceil(forecast_end)))
    requested = [float(second) for second in range(1, integer_end + 1)]
    if abs(forecast_end - round(forecast_end)) > 1e-6:
        requested.append(forecast_end)
    requested = sorted(set(requested))
    prefix_by_time = {}
    cutoff_by_time = {}
    for second in requested:
        completed = [
            index for index, row in enumerate(clock)
            if float(row["endSeconds"]) <= second + 1e-9
        ]
        cutoff = completed[-1] + 1 if completed else 0
        cutoff_by_time[second] = cutoff
        prefix_by_time[second] = (
            surface(tokens, 0, cutoff, source_text=primitives["text"])
            if cutoff else ""
        )
    embedded = store.embed_many([
        value for value in prefix_by_time.values() if value
    ])
    dimensions = int(store.dimensions)
    features = {}
    trace = []
    for second in requested:
        text = prefix_by_time[second]
        cutoff = cutoff_by_time[second]
        vector = (
            np.asarray(embedded[text], np.float32)
            if text else np.zeros(dimensions, np.float32)
        )
        available = [
            component for component in decomposition["chunks"]
            if float(component["boundaryEvidenceAvailableSeconds"]) <= second + 1e-9
        ]
        lexical_count = sum(row["lexical"] for row in clock[:cutoff])
        features[second] = build_causal_sequence_feature_stages(
            vector, available, second, cutoff,
            lexical_count / max(1.0, second),
        )
        if second <= forecast_end + 1e-9:
            trace.append({
                "second": float(second),
                "prefixText": text,
                "endToken": int(cutoff),
                "tokenCount": int(cutoff),
                "usesWordsAfterThisSecond": False,
                "timingSource": scope["timingSource"],
                "availableComponentIndices": [int(row["index"]) for row in available],
            })
    return features, trace


def _variable_curve_payload(features: dict, model: dict,
                            forecast_end: float) -> dict:
    output = {}
    for family_name, family in (model.get("families") or {}).items():
        rows = {
            int(round(float(row["second"]))): row
            for row in family.get("temporalModels") or []
        }
        stage_order = list(family.get("stageOrder") or [
            "timing", "semantic", "components", "relationships",
        ])
        headline = str(family.get("headlineStage") or family.get("selectedStage") or "relationships")
        candidate = str(family.get("candidateStage") or "relationships")
        time_zero = float(family.get("timeZeroMean") or 100.0)
        display_times = [0.0]
        display_times.extend(
            float(second) for second in sorted(rows)
            if second <= forecast_end + 1e-9 and (
                rows[second].get("headlineModelAvailable")
                if headline == "baseline" else
                (rows[second].get("stages") or {}).get(headline, {}).get("model")
            )
        )
        if abs(forecast_end - round(forecast_end)) > 1e-6:
            display_times.append(float(forecast_end))
        display_times = sorted(set(display_times))
        predicted = []
        emitted_times = []
        baseline = []
        low = []
        high = []
        stage_values = {stage: [] for stage in stage_order}

        def value_at(second: float, stage: str) -> float | None:
            if second <= 1e-9:
                return time_zero
            if stage == "baseline":
                lower = max(1, int(math.floor(second)))
                upper = max(1, int(math.ceil(second)))
                if lower not in rows or upper not in rows:
                    return None
                weight = second - math.floor(second)
                return float(rows[lower]["baselineMean"]) * (1.0 - weight) + float(
                    rows[upper]["baselineMean"]
                ) * weight
            rounded = int(round(second))
            if abs(second - rounded) <= 1e-6:
                stage_model = ((rows.get(rounded) or {}).get("stages") or {}).get(stage, {}).get("model")
                return (
                    apply_scalar_stage(features[float(rounded)][stage], stage_model)
                    if stage_model else None
                )
            lower = int(math.floor(second))
            upper = int(math.ceil(second))
            values = []
            for endpoint in (lower, upper):
                if endpoint == 0:
                    values.append(time_zero)
                    continue
                stage_model = ((rows.get(endpoint) or {}).get("stages") or {}).get(stage, {}).get("model")
                values.append(
                    apply_scalar_stage(features[second][stage], stage_model)
                    if stage_model else None
                )
            if any(value is None for value in values):
                return None
            weight = second - lower
            return float(values[0] * (1.0 - weight) + values[1] * weight)

        for second in display_times:
            value = value_at(second, headline)
            if value is None:
                continue
            emitted_times.append(float(second))
            predicted.append(float(value))
            if second <= 1e-9:
                base = time_zero
                residual_low = residual_high = 0.0
            else:
                lower = max(1, int(math.floor(second)))
                upper = max(1, int(math.ceil(second)))
                lower_row = rows[lower]
                upper_row = rows[upper]
                weight = second - math.floor(second)
                base = float(lower_row["baselineMean"]) * (1.0 - weight) + float(
                    upper_row["baselineMean"]
                ) * weight
                residual_low = float(lower_row.get("residualP10") or 0.0) * (1.0 - weight) + float(
                    upper_row.get("residualP10") or 0.0
                ) * weight
                residual_high = float(lower_row.get("residualP90") or 0.0) * (1.0 - weight) + float(
                    upper_row.get("residualP90") or 0.0
                ) * weight
            baseline.append(base)
            low.append(float(value + residual_low))
            high.append(float(value + residual_high))
            for stage in stage_order:
                stage_values[stage].append(value_at(second, stage))
        output[family_name] = {
            "timesSeconds": emitted_times,
            "predicted": predicted,
            "predictionP10": low,
            "predictionP90": high,
            "actual": None,
            "stages": {"baseline": baseline, **stage_values},
            "selectedStage": headline,
            "candidateStage": candidate,
            "promotion": family.get("promotion") or {},
            "causalPrefixOnly": True,
            "fullModelHorizonSeconds": float(model.get("analysisHorizonSeconds") or 0.0),
            "displayStopsAtSuppliedText": True,
        }
    return output


def _context_from_history(component: dict, position: int, history_raw: np.ndarray,
                          category_counts: np.ndarray,
                          predecessor: dict | None) -> dict:
    raw = row_unit(np.asarray(component["_rawVector"], np.float32))
    history_mean = (
        row_unit(np.mean(history_raw, axis=0)) if len(history_raw) else None
    )
    predecessor_raw = (
        row_unit(np.asarray(predecessor["_rawVector"], np.float32))
        if predecessor is not None else None
    )
    seen = float(category_counts.sum())
    return {
        "definition": "information state formed only by components delivered earlier",
        "position": int(position),
        "predecessorComponentIndex": (
            int(predecessor["index"]) if predecessor is not None else None
        ),
        "predecessorCategory": (
            int(predecessor["category"]) if predecessor is not None else None
        ),
        "transition": (
            f"{predecessor['category']}->{component['category']}"
            if predecessor is not None else f"START->{component['category']}"
        ),
        "componentsPreviouslyDelivered": int(position),
        "categoryCountsBefore": category_counts.astype(int).tolist(),
        "categoryDistributionBefore": (
            (category_counts / seen).astype(float).tolist() if seen else [0.0] * 4
        ),
        "predecessorSemanticSimilarity": (
            float(raw @ predecessor_raw) if predecessor_raw is not None else None
        ),
        "historySemanticSimilarity": (
            float(raw @ history_mean) if history_mean is not None else None
        ),
        "historySemanticChange": (
            float(1.0 - raw @ history_mean) if history_mean is not None else None
        ),
        "usesFutureComponents": False,
        "externalIdeaContextUsed": False,
    }


def sequence_order_sensitivity(components: list[dict], context_study: dict) -> dict:
    scored = [score_component_context(row, context_study) for row in components]
    if len(components) < 2 or any(value is None for value in scored):
        return {
            "status": "unavailable",
            "available": False,
            "reason": "the frozen category context study is unavailable for one or more components",
            "externalIdeaContextUsed": False,
        }
    raw = np.asarray([row["_rawVector"] for row in components], np.float32)
    prefix_raw = np.vstack([
        np.zeros((1, raw.shape[1]), np.float32), np.cumsum(raw, axis=0),
    ])
    prefix_categories = np.zeros((len(components) + 1, 4), np.float32)
    for index, component in enumerate(components):
        prefix_categories[index + 1] = prefix_categories[index]
        prefix_categories[index + 1, int(component["category"])] += 1.0

    def contribution(component: dict, score: dict) -> float:
        duration = max(0.0, float(component["spokenEndSeconds"]) - float(
            component["spokenStartSeconds"]
        ))
        return duration * float(score["predictedRetentionSlopePercentagePointsPerSecond"])

    swaps = []
    for index in range(len(components) - 1):
        left = components[index]
        right = components[index + 1]
        history_sum = prefix_raw[index]
        history_count = index
        history_rows = (
            np.asarray([history_sum / history_count], np.float32)
            if history_count else np.empty((0, raw.shape[1]), np.float32)
        )
        category_counts = prefix_categories[index].copy()
        predecessor = components[index - 1] if index else None
        right_swapped = copy.deepcopy(right)
        right_swapped.update({
            "index": index,
            "spokenStartSeconds": left["spokenStartSeconds"],
            "spokenEndSeconds": left["spokenEndSeconds"],
        })
        right_swapped["viewerContext"] = _context_from_history(
            right_swapped, index, history_rows, category_counts, predecessor,
        )
        right_score = score_component_context(right_swapped, context_study)
        category_counts[int(right_swapped["category"])] += 1.0
        next_history_sum = history_sum + raw[index + 1]
        next_history = np.asarray([
            next_history_sum / (history_count + 1)
        ], np.float32)
        left_swapped = copy.deepcopy(left)
        left_swapped.update({
            "index": index + 1,
            "spokenStartSeconds": right["spokenStartSeconds"],
            "spokenEndSeconds": right["spokenEndSeconds"],
        })
        left_swapped["viewerContext"] = _context_from_history(
            left_swapped, index + 1, next_history, category_counts, right_swapped,
        )
        left_score = score_component_context(left_swapped, context_study)
        if right_score is None or left_score is None:
            continue
        original = contribution(left, scored[index]) + contribution(right, scored[index + 1])
        swapped = contribution(right_swapped, right_score) + contribution(left_swapped, left_score)
        if index + 2 < len(components):
            following = copy.deepcopy(components[index + 2])
            following["viewerContext"] = _context_from_history(
                following, index + 2,
                np.asarray([(history_sum + raw[index] + raw[index + 1]) / (index + 2)], np.float32),
                prefix_categories[index + 2].copy(), left_swapped,
            )
            following_score = score_component_context(following, context_study)
            if following_score is not None:
                original += contribution(components[index + 2], scored[index + 2])
                swapped += contribution(following, following_score)
        swaps.append({
            "leftComponentIndex": int(left["index"]),
            "rightComponentIndex": int(right["index"]),
            "originalOrder": [str(left["text"]), str(right["text"])],
            "swappedOrder": [str(right["text"]), str(left["text"])],
            "predictedRetentionDeltaChangePoints": float(swapped - original),
            "betterDirection": "higher means less predicted retention loss",
        })
    return {
        "status": "complete",
        "available": bool(swaps),
        "method": "adjacent component swaps with prior-history state recomputed",
        "swaps": swaps,
        "claimBoundary": (
            "model sensitivity only; the dataset does not contain randomized edited-order outcomes"
        ),
        "externalIdeaContextUsed": False,
    }


def _validated_token_clock(tokens: list, token_clock: list[dict]) -> list[dict]:
    if len(token_clock) != len(tokens):
        raise ValueError("observed token clock does not cover every token")
    output = []
    previous_end = 0.0
    for index, (token, row) in enumerate(zip(tokens, token_clock)):
        start = float(row.get("startSeconds"))
        end = float(row.get("endSeconds"))
        lexical = bool(row.get("lexical", any(
            character.isalnum() or character == "_" for character in token.text
        )))
        if not math.isfinite(start + end) or start < 0 or end < start:
            raise ValueError(f"observed token clock has invalid timing at token {index}")
        if start + 1e-6 < previous_end:
            raise ValueError(f"observed token clock moves backward at token {index}")
        output.append({
            "index": int(token.index),
            "startSeconds": float(start),
            "endSeconds": float(end),
            "lexical": lexical,
        })
        previous_end = max(previous_end, end)
    if not any(row["lexical"] for row in output):
        raise ValueError("an opening needs at least one lexical atom")
    return output


def _score_variable_text(text: str, partition_model: dict, opening_model: dict,
                         retention_model: dict, store: EmbeddingStore,
                         planned_duration_seconds: float | None,
                         token_clock_override: list[dict] | None = None,
                         timing_source: str | None = None,
                         forecast_duration_override: float | None = None) -> dict:
    scope = _variable_prediction_scope(text, retention_model, planned_duration_seconds)
    source_text = scope["analyzedText"]
    tokens = tokenize(source_text)
    token_clock = (
        _validated_token_clock(tokens, token_clock_override)
        if token_clock_override is not None else
        _typed_token_clock(tokens, scope["structuralDurationSeconds"])
    )
    if token_clock_override is not None:
        observed_duration = max(float(row["endSeconds"]) for row in token_clock)
        if observed_duration <= 0:
            raise ValueError("observed token clock has no positive duration")
        sequence_duration = (
            float(forecast_duration_override)
            if forecast_duration_override is not None else observed_duration
        )
        if not math.isfinite(sequence_duration) or sequence_duration <= 0:
            raise ValueError("observed media duration must be a positive number")
        if sequence_duration + 1e-6 < observed_duration:
            raise ValueError("observed token timing extends past the media duration")
        supported = float(scope["retentionUnsupportedAfterSeconds"])
        scope.update({
            "plannedSpokenSeconds": observed_duration,
            "estimatedSpokenSeconds": observed_duration,
            "observedSpokenEndSeconds": observed_duration,
            "structuralDurationSeconds": sequence_duration,
            "forecastDurationSeconds": min(sequence_duration, supported),
            "forecastStopReason": (
                "source-media endpoint"
                if sequence_duration <= supported + 1e-9 else
                "duration-conditioned cohort risk set falls below the declared model minimum"
            ),
            "forecastBeyondSuppliedText": sequence_duration > observed_duration + 1e-6,
            "timingEstimated": False,
            "timingSource": timing_source or "observed source-media caption timestamps",
        })
    support = _typed_causal_support(opening_model, retention_model)
    decomposition = build_streaming_components(
        source_text, store, partition_model, opening_model,
        measured_token_support=support,
    )
    _attach_typed_component_timing(decomposition, token_clock)
    primitives = {"text": source_text, "tokens": tokens, "tokenClock": token_clock}
    prefix_features, prefix_trace = _variable_prefix_features(
        primitives, decomposition, scope, retention_model, store,
    )
    curves = _variable_curve_payload(
        prefix_features, retention_model, scope["forecastDurationSeconds"],
    )
    entry = curves["entryIndexed"]
    absolute = curves["observedAbsolute"]
    context_study = {}
    try:
        context_study = load_artifact(CONTEXT_STUDY_FILE)
    except Exception:
        context_study = {"categories": []}
    for component in decomposition["chunks"]:
        component["outcomePlane"] = score_component_context(component, context_study)
        component["outcomePlanesByLag"] = (
            (component["outcomePlane"] or {}).get("predictionsByLag") or {}
        )
        component["measurements"] = None
        component["measurementStatus"] = (
            "typed text has no observed audience-retention response"
        )
    order_sensitivity = sequence_order_sensitivity(
        decomposition["chunks"], context_study,
    )
    public_components = [
        {key: value for key, value in component.items() if not key.startswith("_")}
        for component in decomposition["chunks"]
    ]
    attribution = temporal_attribution(
        {
            **entry,
            "stages": entry["stages"],
        },
        [{
            "second": 0.0, "prefixText": "", "endToken": 0, "tokenCount": 0,
        }, *prefix_trace],
        public_components,
    )
    attribution_by_component = {
        int(row["componentIndex"]): row
        for row in attribution["componentLedger"]
    }
    for component in public_components:
        component["timelineAttribution"] = attribution_by_component.get(
            int(component["index"])
        )
    forecast_end = float(entry["timesSeconds"][-1])
    endpoint = float(entry["predicted"][-1])
    retention5 = (
        float(np.interp(5.0, absolute["timesSeconds"], absolute["predicted"]))
        if forecast_end >= 5.0 else None
    )
    views = None
    contract = retention_model.get("viewsContract") or {}
    if retention5 is not None and contract:
        views = views_from_retention5(retention5, contract)
        views["promoted"] = False
        views["status"] = "diagnostic only"
    stable_payload = (
        f"{PREDICTOR_VERSION}\0{FEATURE_VERSION}\0{source_text}\0"
        f"{scope.get('plannedSpokenSeconds')}"
    )
    return {
        "version": 5,
        "status": "complete",
        "id": hashlib.sha256(stable_payload.encode("utf-8")).hexdigest()[:20],
        "scorerVersion": PREDICTOR_VERSION,
        "predictorVersion": PREDICTOR_VERSION,
        "featureVersion": FEATURE_VERSION,
        "sourceKind": "typed-variable-horizon-four-cluster-full-fit",
        "input": {
            **scope,
            "candidateIdeaAnchor": None,
            "externalIdeaContextUsed": False,
            "forecastBeyondSuppliedText": bool(scope.get("forecastBeyondSuppliedText")),
        },
        "analysisHorizonSeconds": float(scope["structuralDurationSeconds"]),
        "modelHorizonSeconds": float(
            (retention_model.get("support") or {}).get("semanticModelHorizonSeconds")
            or retention_model.get("analysisHorizonSeconds")
        ),
        "forecastHorizonSeconds": forecast_end,
        "predictionTimesSeconds": entry["timesSeconds"],
        "originalHookEndSeconds": float(
            scope.get("observedSpokenEndSeconds") or scope["structuralDurationSeconds"]
        ),
        "tokenCount": len(tokens),
        "componentCount": len(public_components),
        "components": public_components,
        "relationships": [
            edge for edge in decomposition["graph"]["edges"]
            if edge.get("type") == "next"
        ],
        "causalPrefixTrace": prefix_trace,
        "outputs": {
            "retainedAtAnalyzedEndPercent": endpoint,
            "retainedAtForecastEndPercent": endpoint,
            "retainedAtForecastEndP10": float(entry["predictionP10"][-1]),
            "retainedAtForecastEndP90": float(entry["predictionP90"][-1]),
            "forecastEndSeconds": forecast_end,
            "absoluteRetention5sPercent": retention5,
            "normalizedRetention5sPercent": (
                float(np.interp(5.0, entry["timesSeconds"], entry["predicted"]))
                if forecast_end >= 5.0 else None
            ),
            "normalizedDropByAnalyzedEndPoints": 100.0 - endpoint,
            "viewsDiagnostic": views,
        },
        "actual": None,
        "curves": curves,
        "temporalAttribution": attribution,
        "orderSensitivity": order_sensitivity,
        "partition": {
            "version": decomposition["version"],
            "componentCount": decomposition["componentCount"],
            "coverage": decomposition["coverage"],
            "overlapCount": decomposition["overlapCount"],
            "blocks": decomposition["blocks"],
            "work": decomposition["work"],
            "frozenModel": decomposition["frozenModel"],
        },
        "componentLattice": {
            **decomposition["graph"],
            "materialization": "support-bounded streaming graph",
            "globalAllSpanRowsMaterialized": False,
        },
        "support": {
            "structurallyUncapped": True,
            "fullInputTokensOwned": len(tokens),
            "structuralDurationSeconds": float(scope["structuralDurationSeconds"]),
            "servedForecastThroughSeconds": forecast_end,
            "retentionAfterForecastUnsupported": bool(
                scope["structuralDurationSeconds"] > forecast_end + 1e-9
            ),
            "forecastStopReason": scope["forecastStopReason"],
            "timingSource": scope["timingSource"],
            "timingEstimated": scope["timingEstimated"],
            "streamingWork": decomposition["work"],
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
            "sameFeatureBuilderAsSavedLibrary": True,
            "sameTemporalModelFamilyAsSavedLibrary": True,
            "savedRowsUseOutOfFoldPredictions": True,
            "typedRowsUseFrozenFullFitPredictions": True,
            "outcomesUsedForBoundaries": False,
            "futureWordsUsedForEarlierPredictions": False,
            "viewerContextUsesOnlyPriorComponents": True,
            "externalIdeaContextUsed": False,
            "categoryCount": 4,
            "syntheticOrderChangesAreCausalClaims": False,
        },
    }


def score_text(text: str, partition_model: dict | None = None,
               store: EmbeddingStore | None = None,
               opening_model: dict | None = None,
               opening_retention_model: dict | None = None,
               planned_duration_seconds: float | None = None) -> dict:
    """Score typed text with the exact temporal contract used by the saved library."""
    partition_model = partition_model or load_artifact(PARTITION_FILE)
    opening_model = opening_model or load_artifact(OPENING_MODEL_FILE)
    retention_model = (
        opening_retention_model or load_artifact(OPENING_RETENTION_MODEL_FILE)
    )
    if int(retention_model.get("version") or 0) < 3:
        raise RuntimeError(
            "legacy opening-retention artifacts are unsupported; rebuild the v3 variable-horizon model"
        )
    owned_store = store is None
    store = store or EmbeddingStore(_embedding_cache_path())
    try:
        return _score_variable_text(
            text, partition_model, opening_model, retention_model, store,
            planned_duration_seconds,
        )
    finally:
        if owned_store:
            store.close()


def score_timed_text(text: str, token_clock: list[dict],
                     timing_source: str = "observed source-media caption timestamps",
                     media_duration_seconds: float | None = None,
                     partition_model: dict | None = None,
                     store: EmbeddingStore | None = None,
                     opening_model: dict | None = None,
                     opening_retention_model: dict | None = None) -> dict:
    """Score observed spoken timing with the unchanged frozen model."""
    partition_model = partition_model or load_artifact(PARTITION_FILE)
    opening_model = opening_model or load_artifact(OPENING_MODEL_FILE)
    retention_model = (
        opening_retention_model or load_artifact(OPENING_RETENTION_MODEL_FILE)
    )
    if int(retention_model.get("version") or 0) < 3:
        raise RuntimeError(
            "legacy opening-retention artifacts are unsupported; rebuild the v3 variable-horizon model"
        )
    owned_store = store is None
    store = store or EmbeddingStore(_embedding_cache_path())
    try:
        return _score_variable_text(
            text, partition_model, opening_model, retention_model, store,
            None, token_clock_override=token_clock, timing_source=timing_source,
            forecast_duration_override=media_duration_seconds,
        )
    finally:
        if owned_store:
            store.close()



def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--json-stdin", action="store_true")
    parser.add_argument("--duration-seconds", type=float, default=None)
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--refresh-model", action="store_true")
    args = parser.parse_args()
    duration = args.duration_seconds
    if args.json_stdin:
        request = json.loads(sys.stdin.read() or "{}")
        text = str(request.get("text") or "")
        raw_duration = request.get("durationSeconds")
        duration = float(raw_duration) if raw_duration not in (None, "") else None
    else:
        text = sys.stdin.read() if args.stdin else args.text
    if not normalize_source(text):
        print(json.dumps({"error": "type an opening to score"}))
        raise SystemExit(2)
    try:
        result = score_text(
            text,
            partition_model=load_artifact(PARTITION_FILE, args.refresh_model),
            opening_model=load_artifact(OPENING_MODEL_FILE, args.refresh_model),
            opening_retention_model=load_artifact(
                OPENING_RETENTION_MODEL_FILE, args.refresh_model,
            ),
            planned_duration_seconds=duration,
        )
        print(json.dumps(
            json_ready(result), indent=2 if args.pretty else None,
            separators=None if args.pretty else (",", ":"), allow_nan=False,
        ))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
