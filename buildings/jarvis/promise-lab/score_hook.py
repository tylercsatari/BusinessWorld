#!/usr/bin/env python3
"""Score one hook with the frozen Promise Lab axis without a generative LLM."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

from canonical_partition import (
    boundary_features,
    boundary_probabilities,
)
from embedding_store import EmbeddingStore, R2Store, json_ready
from hook_outcomes import apply_duration_baseline
from hook_score_core import (
    apply_linear_model,
    apply_category_transform,
    category_log_probabilities,
    combined_component_features,
    component_response_windows,
    decode_variable_chunks,
    enrich_word_semantics,
    estimated_token_timeline,
    interpolate_series,
    outcome_prediction_payload,
    local_counterfactual_texts,
    percentile,
    row_unit,
)
from market_reward import local_market_effects, score_market_vector
from sequence import all_spans, normalize_source, surface, tokenize, without_span


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
REMOTE_PREFIX = "longform/promise-lab-v4"
MODEL_FILE = "hook-quality-model.json"
PARTITION_FILE = "canonical-partition-model.json"
OUTCOME_MODEL_FILE = "hook-outcome-model.json"
MARKET_MODEL_FILE = "market-reward-model.json"
SCORER_VERSION = "deterministic-variable-hook-scorer-v11"


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
    runtime = Path(os.environ.get("PROMISE_HOOK_RUNTIME_CACHE", "/tmp/businessworld-promise-hook"))
    runtime.mkdir(parents=True, exist_ok=True)
    cached = runtime / filename
    if cached.exists() and not refresh and time.time() - cached.stat().st_mtime < 3600:
        return json.loads(cached.read_text(encoding="utf-8"))
    payload = R2Store().get_bytes(f"{REMOTE_PREFIX}/{filename}.gz")
    if not payload:
        raise RuntimeError(f"Promise Lab artifact is unavailable: {filename}")
    value = _decode_json(payload)
    temporary = cached.with_suffix(cached.suffix + ".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, cached)
    return value


def _embedding_cache_path() -> Path:
    if CACHE.exists() and (CACHE / MODEL_FILE).exists():
        return CACHE / "hook-live-embeddings.sqlite3"
    return Path(os.environ.get(
        "PROMISE_HOOK_EMBED_CACHE", "/tmp/businessworld-promise-hook/embeddings.sqlite3",
    ))


def build_span_primitives(text: str, store: EmbeddingStore) -> dict:
    text = normalize_source(text)
    tokens = tokenize(text)
    lexical = np.asarray([
        any(character.isalnum() or character == "_" for character in token.text)
        for token in tokens
    ], bool)
    if int(lexical.sum()) < 1:
        raise ValueError("a hook needs at least one lexical atom")
    spans = all_spans(len(tokens))
    span_texts = [surface(tokens, span.start, span.end, source_text=text) for span in spans]
    context_texts = [without_span(tokens, span.start, span.end, source_text=text) for span in spans]
    required = [text, *span_texts, *[value for value in context_texts if value]]
    vectors = store.embed_many(required)
    full = row_unit(vectors[text])
    raw = np.asarray([row_unit(vectors[value]) for value in span_texts], np.float32)
    contexts = np.asarray([
        row_unit(vectors[value]) if value else np.zeros_like(full)
        for value in context_texts
    ], np.float32)
    influence = row_unit(full[None, :] - contexts)
    starts = np.asarray([span.start for span in spans], int)
    ends = np.asarray([span.end for span in spans], int)
    lookup = {(int(start), int(end)): index
              for index, (start, end) in enumerate(zip(starts, ends))}
    token_effects = np.asarray([
        full - contexts[lookup[(index, index + 1)]] for index in range(len(tokens))
    ], np.float32)
    prefix = np.vstack([
        np.zeros((1, len(full)), np.float32), np.cumsum(token_effects, axis=0),
    ])
    additive = prefix[ends] - prefix[starts]
    nonadditive = row_unit((full[None, :] - contexts) - additive)
    return {
        "text": text,
        "tokens": tokens,
        "starts": starts,
        "ends": ends,
        "spanTexts": span_texts,
        "raw": raw,
        "context": contexts,
        "influence": influence,
        "nonadditive": nonadditive,
        "full": full,
        "lexical": lexical,
        "embeddingInputs": len(set(required)),
    }


def decode_partition(primitives: dict, partition_model: dict) -> dict:
    category_values = apply_category_transform(
        primitives["raw"], partition_model["categoryTransform"],
    )
    logp = category_log_probabilities(category_values, partition_model["categoryModel"])
    browse = partition_model.get("browseProjection") or {}
    basis = np.asarray(browse.get("basis4x2") or [], np.float32)
    if basis.shape != (4, 2):
        raise RuntimeError("canonical semantic browse projection is unavailable")
    semantic_points = category_values @ basis
    semantic_categories = np.argmax(logp, axis=1)
    features = boundary_features(
        primitives["full"], primitives["raw"], primitives["context"],
        primitives["influence"], primitives["nonadditive"],
        primitives["starts"], primitives["ends"], logp,
    )
    boundary_model = partition_model["boundaryModel"]
    boundary_probability = boundary_probabilities(features, boundary_model)
    decoded = decode_variable_chunks(
        primitives["starts"], primitives["ends"], boundary_probability,
        logp, primitives["lexical"],
    )
    tokens = primitives["tokens"]
    owners = np.full(len(tokens), -1, int)
    chunks = []
    for index, chunk in enumerate(decoded["chunks"]):
        span_index = int(chunk["spanIndex"])
        start = int(chunk["start"]); end = int(chunk["end"])
        owners[start:end] = index
        probability = np.exp(logp[span_index])
        category = int(chunk["category"])
        chunks.append({
            "index": index,
            "start": start, "end": end,
            "text": surface(tokens, start, end, source_text=primitives["text"]),
            "category": category,
            "categoryProbability": float(probability[category]),
            "categoryDistribution": probability.astype(float).tolist(),
            "frozenAtlasCategory": None,
            "categoryCoordinates4D": category_values[span_index].astype(float).tolist(),
            "mapX": float(semantic_points[span_index, 0]),
            "mapY": float(semantic_points[span_index, 1]),
            "categorySource": "serving Gaussian assignment into the frozen four-category vocabulary",
            "leftBoundaryProbability": chunk.get("leftBoundaryProbability"),
            "rightBoundaryProbability": chunk.get("rightBoundaryProbability"),
            "leftBoundaryPosterior": (
                float(boundary_probability[start - 1]) if start > 0 else None
            ),
            "rightBoundaryPosterior": (
                float(boundary_probability[end - 1]) if end < len(tokens) else None
            ),
        })
    component_count = len(chunks)
    if ((owners < 0).any()
            or set(owners.tolist()) != set(range(component_count))):
        raise RuntimeError("decoder did not produce one exact non-overlapping owner per token")
    gap_calibration = np.asarray(
        partition_model["partitionCalibration"]["scoreGapsSorted"], float,
    )
    lookup = {
        (int(start), int(end)): index
        for index, (start, end) in enumerate(zip(primitives["starts"], primitives["ends"]))
    }
    token_rows = []
    for token in tokens:
        span_index = lookup[(int(token.index), int(token.index + 1))]
        probability = np.exp(logp[span_index])
        category = int(semantic_categories[span_index])
        token_rows.append({
            "index": token.index,
            "text": token.text,
            "start": token.start,
            "end": token.end,
            "owner": int(owners[token.index]),
            "semantic": {
                "globalSpanIndex": None,
                "category": category,
                "frozenAtlasCategory": None,
                "categoryProbability": float(probability[category]),
                "categoryDistribution": probability.astype(float).tolist(),
                "categoryCoordinates4D": category_values[span_index].astype(float).tolist(),
                "mapX": float(semantic_points[span_index, 0]),
                "mapY": float(semantic_points[span_index, 1]),
                "categorySource": (
                    "serving Gaussian assignment into the frozen four-category vocabulary"
                ),
            },
        })
    full_index = lookup[(0, len(tokens))]
    full_probability = np.exp(logp[full_index])
    full_category = int(semantic_categories[full_index])
    return {
        **{key: decoded[key] for key in (
            "score", "runnerUpScore", "scoreGap", "topTwoPosteriorProxy",
            "partitionsCompared", "objective", "complexityControl",
        )},
        "scoreGapPercentile": percentile(gap_calibration, float(decoded["scoreGap"] or 0)),
        "chunks": chunks,
        "componentCount": component_count,
        "boundaryProbabilities": boundary_probability.astype(float).tolist(),
        "boundaryPosteriors": boundary_probability.astype(float).tolist(),
        "boundaryModelValidation": {
            key: boundary_model.get(key) for key in (
                "heldoutAuc", "heldoutAveragePrecision", "heldoutDecisionThreshold",
                "heldoutDecisionMetric", "heldoutMatthewsCorrelation",
                "heldoutBalancedAccuracy", "servingPolicy",
            )
        },
        "owners": owners,
        "tokens": token_rows,
        "forecastSemanticInput": {
            "globalSpanIndex": None,
            "text": primitives["text"],
            "category": full_category,
            "frozenAtlasCategory": None,
            "categoryProbability": float(full_probability[full_category]),
            "categoryDistribution": full_probability.astype(float).tolist(),
            "categoryCoordinates4D": category_values[full_index].astype(float).tolist(),
            "mapX": float(semantic_points[full_index, 0]),
            "mapY": float(semantic_points[full_index, 1]),
            "categorySource": (
                "serving Gaussian assignment into the frozen four-category vocabulary"
            ),
        },
        "coverage": 1.0,
        "overlapCount": 0,
    }


def _bootstrap_attribution(full: np.ndarray, singleton: np.ndarray,
                           context: np.ndarray, pair_context: dict[tuple[int, int], np.ndarray],
                           model: dict) -> tuple[np.ndarray, np.ndarray]:
    directions = np.asarray(model.get("bootstrapDirections") or [], np.float32)
    component_rows = []
    pair_rows = []
    for direction in directions:
        full_score = float(full @ direction)
        context_score = context @ direction
        component_rows.append(full_score - context_score)
        pair_rows.append([
            float(full_score - context_score[left] - context_score[right]
                  + pair_context[(left, right)] @ direction)
            for left in range(len(singleton))
            for right in range(left + 1, len(singleton))
        ])
    return np.asarray(component_rows, float), np.asarray(pair_rows, float)


def _score_forward_response(primitives: dict, partition: dict,
                            counter_vectors: dict, components: list[dict],
                            interactions: list[dict], model: dict) -> dict | None:
    forward = model.get("forwardResponse") or {}
    if not forward or forward.get("status") != "complete":
        return None
    component_model = (forward.get("component") or {}).get("modelsByCategory") or {}
    starts = np.asarray(primitives["starts"], int)
    ends = np.asarray(primitives["ends"], int)
    component_percentiles = []
    for index, (chunk, component) in enumerate(zip(partition["chunks"], components)):
        matches = np.flatnonzero(
            (starts == int(chunk["start"])) & (ends == int(chunk["end"]))
        )
        if len(matches) != 1:
            raise RuntimeError("decoded component is missing from the exact span tensor")
        span_index = int(matches[0])
        category = str(int(chunk["category"]))
        category_model = component_model.get(category)
        if not category_model:
            raise RuntimeError(f"forward-response category model is missing: {category}")
        feature = combined_component_features(
            primitives["raw"][span_index:span_index + 1],
            primitives["influence"][span_index:span_index + 1],
        )[0]
        coordinate = float(feature @ np.asarray(category_model["direction"], np.float32))
        map_y = float(feature @ np.asarray(category_model["mapDirection"], np.float32))
        axis_percentile = percentile(
            np.asarray(category_model["trainingProjectionSorted"], float), coordinate,
        )
        validation = category_model.get("validation") or {}
        component["forwardResponse"] = {
            "label": "Predicted forward retention response",
            "axisCoordinate": coordinate,
            "mapY": map_y,
            "percentile": axis_percentile,
            "category": int(category),
            "heldoutSpearmanForCategory": validation.get("heldoutSpearman"),
            "foldDirectionStability": validation.get("foldDirectionStability"),
            "metricId": (forward.get("metricContract") or {}).get("selectedCandidate"),
        }
        component_percentiles.append(axis_percentile)

    relationship = forward.get("relationship") or {}
    calibration = relationship.get("calibrationByCategoryPair") or {}
    interaction_lookup = {
        (int(row["left"]), int(row["right"])): row for row in interactions
    }
    full = primitives["full"]
    full_feature = combined_component_features(full[None, :], full[None, :])[0]
    component_raw = []
    for chunk in partition["chunks"]:
        span_index = int(np.flatnonzero(
            (starts == int(chunk["start"])) & (ends == int(chunk["end"]))
        )[0])
        component_raw.append(primitives["raw"][span_index])
    for right in range(1, len(components)):
        category = str(int(components[right]["category"]))
        direction = np.asarray(component_model[category]["direction"], np.float32)
        for left in range(right):
            without_left_feature = combined_component_features(
                counter_vectors["withoutOne"][left][None, :],
                row_unit(full - component_raw[left])[None, :],
            )[0]
            without_right_feature = combined_component_features(
                counter_vectors["withoutOne"][right][None, :],
                row_unit(full - component_raw[right])[None, :],
            )[0]
            pair_raw = counter_vectors["pairOnly"][(left, right)]
            without_pair_feature = combined_component_features(
                counter_vectors["withoutPair"][(left, right)][None, :],
                row_unit(full - pair_raw)[None, :],
            )[0]
            interaction = float(
                full_feature @ direction
                - without_left_feature @ direction
                - without_right_feature @ direction
                + without_pair_feature @ direction
            )
            target = interaction_lookup[(left, right)]
            category_pair = f"{components[left]['category']}->{components[right]['category']}"
            samples = np.asarray(calibration.get(category_pair) or [], float)
            target["forwardResponse"] = {
                "interaction": interaction,
                "percentile": (
                    percentile(samples, interaction) if len(samples) else None
                ),
                "categoryPair": category_pair,
                "definition": relationship.get("definition"),
                "validationSource": relationship.get("validationSource"),
            }

    whole = forward.get("wholeHook") or {}
    standalone = relationship.get("standaloneObservedResidualAudit") or {}
    composite_coordinate = float(np.mean(component_percentiles))
    composite_training = np.asarray(whole.get("trainingCompositeSorted") or [], float)
    return {
        "status": "complete",
        "validatedAtComponentLevel": bool(forward.get("validated")),
        "validationStatus": forward.get(
            "validationStatus", "conditional-diagnostic"
        ),
        "categoryClaimStatus": forward.get("categoryClaimStatus"),
        "metric": forward.get("metricContract"),
        "componentValidation": (forward.get("component") or {}).get("validation"),
        "components": [row["forwardResponse"] for row in components],
        "relationships": [row.get("forwardResponse") for row in interactions],
        "exploratoryWholeHookComposite": {
            "accepted": False,
            "coordinate": composite_coordinate,
            "percentile": (
                percentile(composite_training, composite_coordinate)
                if len(composite_training) else None
            ),
            "definition": whole.get("definition"),
            "validation": whole.get("validation"),
            "reason": (
                "the category-conditioned component coordinates remain visible as diagnostics, "
                "but their equal-mean aggregate did not validate as a separate whole-hook target"
            ),
        },
        "standaloneRelationshipAudit": {
            "accepted": standalone.get("accepted"),
            "selectedRepresentation": standalone.get("selectedRepresentation"),
            "targetDefinition": standalone.get("targetDefinition"),
            "validation": standalone.get("validation"),
        },
    }


def _prediction_interval(payload: dict, model: dict) -> dict:
    validation = model.get("validation") or {}
    prediction = float(payload["prediction"])
    payload.update({
        "predictionP10": prediction + float(validation.get("residualP10") or 0),
        "predictionP90": prediction + float(validation.get("residualP90") or 0),
        "validation": validation,
    })
    return payload


def _scalar_prediction(feature: np.ndarray, model: dict) -> float:
    return float(apply_linear_model(np.asarray(feature, np.float32), model)[0, 0])


def _score_local_attributions(primitives: dict, partition: dict,
                              counter_vectors: dict, components: list[dict],
                              interactions: list[dict], outcomes: dict,
                              outcome_model: dict) -> dict:
    """Apply the frozen whole-hook models to exact local counterfactuals."""
    calibration = outcome_model.get("localAttributionCalibration") or {}
    component_calibration = calibration.get("componentsByCategory") or {}
    pair_calibration = calibration.get("pairsByCategorySequence") or {}
    survival_model = outcome_model["survivalModel"]
    scale = survival_model.get("scoreScale") or {}
    prediction_std = max(float(scale.get("predictionStd") or 1), 1e-9)
    hold_full = _scalar_prediction(primitives["full"], survival_model)
    hold_without = {
        index: _scalar_prediction(value, survival_model)
        for index, value in counter_vectors["withoutOne"].items()
    }
    hold_without_pair = {
        key: _scalar_prediction(value, survival_model)
        for key, value in counter_vectors["withoutPair"].items()
    }
    direct_models = outcome_model.get("hookModels") or {}
    direct_full = {
        target: _scalar_prediction(primitives["full"], model)
        for target, model in direct_models.items()
    }
    direct_without = {
        target: {
            index: _scalar_prediction(value, model)
            for index, value in counter_vectors["withoutOne"].items()
        } for target, model in direct_models.items()
    }
    direct_without_pair = {
        target: {
            key: _scalar_prediction(value, model)
            for key, value in counter_vectors["withoutPair"].items()
        } for target, model in direct_models.items()
    }
    curve_model = outcome_model["curveModel"]
    curve_full = apply_linear_model(primitives["full"], curve_model)[0]
    curve_without = {
        index: apply_linear_model(value, curve_model)[0]
        for index, value in counter_vectors["withoutOne"].items()
    }
    curve_without_pair = {
        key: apply_linear_model(value, curve_model)[0]
        for key, value in counter_vectors["withoutPair"].items()
    }

    tokens = partition["tokens"]
    owners = np.asarray(partition["owners"], int)
    lexical = np.asarray([
        any(character.isalnum() or character == "_" for character in str(token.get("text") or ""))
        for token in tokens
    ], bool)
    words_per_second = max(float(
        (outcome_model.get("speakingRate") or {}).get("meanWordsPerSecond") or 1
    ), 1e-9)
    response_lag = float(outcome_model.get("responseLagSeconds") or 0)
    full_response_seconds = float(outcomes["survivalScore"]["responseEndSeconds"])

    def response_seconds_without(removed: set[int]) -> float | None:
        retained = int(np.sum(lexical & ~np.isin(owners, list(removed))))
        return retained / words_per_second + response_lag if retained else None

    def endpoint(lift: float, seconds: float | None) -> float | None:
        if seconds is None or seconds <= 0:
            return None
        expected = float(apply_duration_baseline(
            seconds, survival_model["lengthBaseline"],
        ))
        carry = max(expected + float(lift), 1e-4)
        return float(100.0 * (carry / 100.0) ** seconds)

    full_endpoint = endpoint(hold_full, full_response_seconds)
    component_rows = []
    for component in components:
        index = int(component["index"])
        category = str(int(component["category"]))
        effect = hold_full - hold_without[index]
        samples = np.asarray(
            ((component_calibration.get("hook_hold") or {}).get(category) or []),
            float,
        )
        natural_seconds = response_seconds_without({index})
        fixed_without_endpoint = endpoint(hold_without[index], full_response_seconds)
        natural_without_endpoint = endpoint(hold_without[index], natural_seconds)
        direct = {}
        for target, full_value in direct_full.items():
            target_effect = full_value - direct_without[target][index]
            target_samples = np.asarray(
                ((component_calibration.get(target) or {}).get(category) or []),
                float,
            )
            direct[target] = {
                "fullPrediction": full_value,
                "withoutPrediction": direct_without[target][index],
                "effect": target_effect,
                "categoryPercentile": (
                    percentile(target_samples, target_effect)
                    if len(target_samples) else None
                ),
            }
        curve_effect = curve_full - curve_without[index]
        attribution = {
            "metric": "Hook Hold",
            "fullRawCoordinate": hold_full,
            "withoutRawCoordinate": hold_without[index],
            "effectRawCarryPointsPerSecond": effect,
            "effectHoldZ": effect / prediction_std,
            "categoryPercentile": (
                percentile(samples, effect) if len(samples) else None
            ),
            "fixedDurationEndpointEffectPercentagePoints": (
                full_endpoint - fixed_without_endpoint
                if full_endpoint is not None and fixed_without_endpoint is not None else None
            ),
            "naturalDurationEndpointEffectPercentagePoints": (
                full_endpoint - natural_without_endpoint
                if full_endpoint is not None and natural_without_endpoint is not None else None
            ),
            "withoutResponseEndSeconds": natural_seconds,
            "counterfactualLeavesText": natural_seconds is not None,
            "higherMeans": (
                "the frozen whole-hook model predicts less hold after this component is removed"
            ),
            "definition": "score(full hook) minus score(exact hook with this component removed)",
            "claimBoundary": calibration.get("claimBoundary"),
        }
        component["hookHoldContribution"] = attribution
        component["wholeHookOutcomeContributions"] = direct
        component["retentionForecastContribution"] = {
            "progressFractions": curve_model.get("progressFractions"),
            "effectByProgressPercentagePoints": curve_effect.astype(float).tolist(),
            "effectAtAnalyzedEndpointPercentagePoints": float(curve_effect[-1]),
            "meanEffectPercentagePoints": float(np.mean(curve_effect)),
            "definition": (
                "complete-hook forecast minus the same frozen forecast after deleting this component"
            ),
        }
        component_rows.append({
            "index": index,
            "text": component["text"],
            "category": int(category),
            **attribution,
        })

    pair_rows = []
    for row in interactions:
        left = int(row["left"]); right = int(row["right"])
        key = (left, right)
        category_pair = f"{components[left]['category']}->{components[right]['category']}"
        value = (
            hold_full - hold_without[left] - hold_without[right]
            + hold_without_pair[key]
        )
        samples = np.asarray(
            ((pair_calibration.get("hook_hold") or {}).get(category_pair) or []),
            float,
        )
        fixed_pair_endpoint = endpoint(hold_without_pair[key], full_response_seconds)
        fixed_left_endpoint = endpoint(hold_without[left], full_response_seconds)
        fixed_right_endpoint = endpoint(hold_without[right], full_response_seconds)
        natural_pair_seconds = response_seconds_without({left, right})
        natural_left_seconds = response_seconds_without({left})
        natural_right_seconds = response_seconds_without({right})
        natural_pair_endpoint = endpoint(hold_without_pair[key], natural_pair_seconds)
        natural_left_endpoint = endpoint(hold_without[left], natural_left_seconds)
        natural_right_endpoint = endpoint(hold_without[right], natural_right_seconds)
        direct = {}
        for target, full_value in direct_full.items():
            target_value = (
                full_value - direct_without[target][left]
                - direct_without[target][right]
                + direct_without_pair[target][key]
            )
            target_samples = np.asarray(
                ((pair_calibration.get(target) or {}).get(category_pair) or []),
                float,
            )
            direct[target] = {
                "interaction": target_value,
                "categorySequencePercentile": (
                    percentile(target_samples, target_value)
                    if len(target_samples) else None
                ),
            }
        curve_value = (
            curve_full - curve_without[left] - curve_without[right]
            + curve_without_pair[key]
        )
        attribution = {
            "metric": "Hook Hold",
            "interactionRawCarryPointsPerSecond": value,
            "interactionHoldZ": value / prediction_std,
            "categorySequencePercentile": (
                percentile(samples, value) if len(samples) else None
            ),
            "fixedDurationEndpointInteractionPercentagePoints": (
                full_endpoint - fixed_left_endpoint - fixed_right_endpoint
                + fixed_pair_endpoint
                if all(item is not None for item in (
                    full_endpoint, fixed_left_endpoint, fixed_right_endpoint,
                    fixed_pair_endpoint,
                )) else None
            ),
            "naturalDurationEndpointInteractionPercentagePoints": (
                full_endpoint - natural_left_endpoint - natural_right_endpoint
                + natural_pair_endpoint
                if all(item is not None for item in (
                    full_endpoint, natural_left_endpoint, natural_right_endpoint,
                    natural_pair_endpoint,
                )) else None
            ),
            "definition": (
                "score(full) - score(without left) - score(without right) + score(without both)"
            ),
            "claimBoundary": calibration.get("claimBoundary"),
        }
        row["hookHoldInteraction"] = attribution
        row["wholeHookOutcomeInteractions"] = direct
        row["retentionForecastInteraction"] = {
            "interactionAtAnalyzedEndpointPercentagePoints": float(curve_value[-1]),
            "meanInteractionPercentagePoints": float(np.mean(curve_value)),
        }
        pair_rows.append({"left": left, "right": right, **attribution})

    return {
        "status": "complete",
        "headlineMetric": {
            "label": "Hook Hold z-score",
            "value": outcomes["survivalScore"]["holdZ"],
            "validationStatus": (
                (outcomes["survivalScore"].get("validation") or {}).get("status")
            ),
        },
        "componentMetric": (
            "local Hook Hold deletion effect in the same frozen whole-hook coordinate"
        ),
        "relationshipMetric": (
            "local second-order Hook Hold interaction in the same frozen whole-hook coordinate"
        ),
        "components": component_rows,
        "relationships": pair_rows,
        "coverage": {
            "componentsScored": len(component_rows),
            "componentsExpected": len(components),
            "relationshipsScored": len(pair_rows),
            "relationshipsExpected": len(components) * (len(components) - 1) // 2,
            "tokensOwnedExactlyOnce": bool(
                len(owners) == len(tokens) and np.all(owners >= 0)
            ),
        },
        "calibrationMethod": calibration.get("method"),
        "claimBoundary": calibration.get("claimBoundary"),
    }


def _score_outcomes(primitives: dict, partition: dict, components: list[dict],
                    outcome_model: dict) -> dict:
    targets = outcome_model.get("targets") or {}
    hook_models = outcome_model.get("hookModels") or {}
    component_models = outcome_model.get("componentModels") or {}
    hook_predictions = {}
    for target_name, target_meta in targets.items():
        model = hook_models[target_name]
        hook_predictions[target_name] = {
            **_prediction_interval(
                outcome_prediction_payload(primitives["full"], model), model,
            ),
            "target": target_name,
            "targetMeta": target_meta,
        }

    starts = np.asarray(primitives["starts"], int)
    ends = np.asarray(primitives["ends"], int)
    component_predictions = []
    for chunk, component in zip(partition["chunks"], components):
        matches = np.flatnonzero(
            (starts == int(chunk["start"])) & (ends == int(chunk["end"]))
        )
        if len(matches) != 1:
            raise RuntimeError("decoded component is missing from the outcome tensor")
        span_index = int(matches[0])
        feature = combined_component_features(
            primitives["raw"][span_index:span_index + 1],
            primitives["influence"][span_index:span_index + 1],
        )[0]
        category = str(int(chunk["category"]))
        outcomes = {}
        for target_name, target_meta in targets.items():
            target_model = component_models[target_name]
            model = target_model["modelsByCategory"][category]
            outcomes[target_name] = {
                **_prediction_interval(
                    outcome_prediction_payload(feature, model), model,
                ),
                "target": target_name,
                "targetMeta": target_meta,
                "category": int(category),
                "sourceAggregateValidation": target_model.get(
                    "sourceAggregateValidation"
                ),
            }
        component["outcomePredictions"] = outcomes
        component_predictions.append({
            "index": int(component["index"]),
            "category": int(category),
            "text": component["text"],
            "outcomes": outcomes,
        })

    curve_model = outcome_model["curveModel"]
    progress = np.asarray(curve_model["progressFractions"], np.float32)
    rate = outcome_model.get("speakingRate") or {}
    response_lag = float(outcome_model.get("responseLagSeconds") or 0)
    mean_words_per_second = float(rate.get("meanWordsPerSecond") or 1)
    lexical_count = sum(
        any(character.isalnum() or character == "_" for character in str(token.get("text") or ""))
        for token in partition["tokens"]
    )
    if lexical_count < 1:
        raise RuntimeError("a hook must contain at least one lexical token")
    spoken_end = lexical_count / max(mean_words_per_second, 1e-9)
    response_end = spoken_end + response_lag
    times = progress * response_end
    predicted = apply_linear_model(primitives["full"], curve_model)[0]
    lower = predicted + np.asarray(curve_model["residualP10ByTime"], np.float32)
    upper = predicted + np.asarray(curve_model["residualP90ByTime"], np.float32)
    words = estimated_token_timeline(
        partition["tokens"], partition["owners"], times, predicted,
        mean_words_per_second, response_lag,
        lower, upper,
    )
    enrich_word_semantics(words, partition["tokens"], partition["chunks"])
    singleton_lookup = {
        int(token["index"]): int(np.flatnonzero(
            (starts == int(token["index"])) & (ends == int(token["index"]) + 1)
        )[0]) for token in partition["tokens"]
    }
    for word in words:
        second = float(word["responseSeconds"])
        word["observedAbsolutePredictedRetentionPercent"] = interpolate_series(
            times, predicted, second,
        )
        word["observedAbsolutePredictionP10"] = interpolate_series(
            times, lower, second,
        )
        word["observedAbsolutePredictionP90"] = interpolate_series(
            times, upper, second,
        )
        without_word = apply_linear_model(
            primitives["context"][singleton_lookup[int(word["tokenIndex"])]], curve_model,
        )[0]
        word["observedForecastDeletionContributionByTime"] = (
            predicted - without_word
        ).astype(float).tolist()
    spoken_end = max((float(word["spokenEndSeconds"]) for word in words), default=spoken_end)
    response_end = max((float(word["responseSeconds"]) for word in words), default=response_end)
    survival_model = outcome_model["survivalModel"]
    survival_payload = _prediction_interval(
        outcome_prediction_payload(primitives["full"], survival_model),
        survival_model,
    )
    expected_carry = float(apply_duration_baseline(
        response_end, survival_model["lengthBaseline"],
    ))
    predicted_lift = float(survival_payload["prediction"])
    predicted_carry = expected_carry + predicted_lift
    score_scale = survival_model.get("scoreScale") or {}
    hold_z = (
        predicted_lift - float(score_scale.get("predictionMean") or 0)
    ) / max(float(score_scale.get("predictionStd") or 1), 1e-9)
    baseline_end = float(
        100.0 * (max(expected_carry, 1e-4) / 100.0) ** max(response_end, 1e-4)
    )
    predicted_end = float(
        100.0 * (max(predicted_carry, 1e-4) / 100.0) ** max(response_end, 1e-4)
    )
    survival_score = {
        **survival_payload,
        "label": "Hook Hold z-score",
        "holdZ": float(hold_z),
        "higherMeans": survival_model["targetContract"]["higherMeans"],
        "definition": survival_model["targetContract"]["formula"],
        "responseEndSeconds": response_end,
        "spokenHookEndSeconds": spoken_end,
        "expectedCarryPercentPerSecond": expected_carry,
        "predictedCarryPercentPerSecond": predicted_carry,
        "predictedAdjustedRetentionAtResponseEnd": predicted_end,
        "durationBaselineRetentionAtResponseEnd": baseline_end,
        "predictedEndpointHoldLiftPercentagePoints": predicted_end - baseline_end,
        "scoreScale": score_scale,
        "targetContract": survival_model["targetContract"],
    }
    long_prior_model = outcome_model.get("longTitlePrior") or {}
    long_coefficient = np.asarray(long_prior_model.get("coefficient") or [], np.float32)
    long_prior = None
    if long_coefficient.shape == primitives["full"].shape:
        predicted_long_views = float(
            primitives["full"] @ long_coefficient
            + float(long_prior_model.get("intercept") or 0)
        )
        long_prior = {
            "predictedLog10LongFormViews": predicted_long_views,
            "z": float(
                (predicted_long_views - float(long_prior_model.get("trainingPredictionMean") or 0))
                / max(float(long_prior_model.get("trainingPredictionStd") or 1), 1e-9)
            ),
            "blendedIntoHookHold": False,
            "claimBoundary": long_prior_model.get("claimBoundary"),
        }
    return {
        "status": "complete",
        "methodVersion": outcome_model.get("methodVersion"),
        "targets": targets,
        "hook": hook_predictions,
        "components": component_predictions,
        "survivalScore": survival_score,
        "longTitleMarketPrior": long_prior,
        "retentionForecast": {
            "status": (curve_model.get("validation") or {}).get("status"),
            "normalizationAvailable": False,
            "normalizationUnavailableReason": (
                "Replay normalization requires a measured audience-retention curve and "
                "measured terminal retention. Text alone supplies neither input."
            ),
            "progressFractions": progress.astype(float).tolist(),
            "timesSeconds": times.astype(float).tolist(),
            "predictedPercent": predicted.astype(float).tolist(),
            "predictionP10": lower.astype(float).tolist(),
            "predictionP90": upper.astype(float).tolist(),
            "validation": curve_model.get("validation"),
            "observedAbsoluteValidation": curve_model.get("validation"),
            "speakingRate": rate,
            "responseLagSeconds": response_lag,
            "spokenHookEndSeconds": spoken_end,
            "responseEndSeconds": response_end,
            "analysisEndSeconds": response_end,
            "forecastScope": (
                "all 41 outputs lie between the first analyzed hook word and the final "
                "analyzed hook response; there are no post-hook outputs"
            ),
            "forecastInput": {
                **partition["forecastSemanticInput"],
                "embeddingModel": outcome_model.get("embeddingModel"),
                "embeddingDimensions": outcome_model.get("embeddingDimensions"),
                "formula": (
                    "y_hat(p_j) = intercept_j + unit(GeminiEmbedding(complete hook)) "
                    "dot coefficient_j for 41 normalized positions inside the analyzed hook"
                ),
                "outputCluster": None,
                "outputClusterReason": (
                    "the 41 forecast values are scalar retention outputs, not semantic embeddings"
                ),
            },
            "wordContributionDefinition": (
                "local deletion diagnostic at every within-hook position: complete-hook forecast minus the "
                "forecast from the same model after deleting exactly this token; values are "
                "not additive Shapley effects"
            ),
            "wordTimingPolicy": "library-average speaking rate",
            "words": words,
            "componentWindows": component_response_windows(
                words, len(components), response_lag,
            ),
        },
    }


def score_text(text: str, model: dict | None = None, partition_model: dict | None = None,
               store: EmbeddingStore | None = None,
               outcome_model: dict | None = None,
               market_model: dict | None = None) -> dict:
    model = model or load_artifact(MODEL_FILE)
    partition_model = partition_model or load_artifact(PARTITION_FILE)
    outcome_model = outcome_model or load_artifact(OUTCOME_MODEL_FILE)
    market_model = market_model or load_artifact(MARKET_MODEL_FILE)
    owned_store = store is None
    store = store or EmbeddingStore(_embedding_cache_path())
    try:
        primitives = build_span_primitives(text, store)
        partition = decode_partition(primitives, partition_model)
        component_count = int(partition["componentCount"])
        counter_texts = local_counterfactual_texts(
            primitives["text"], primitives["tokens"], partition["owners"],
            component_count,
        )
        required = [
            value for family in ("withoutOne", "withoutPair", "pairOnly")
            for value in counter_texts[family].values() if value
        ]
        embedded = store.embed_many(required)
        zero = np.zeros_like(primitives["full"])

        def counter_vector(value: str) -> np.ndarray:
            return row_unit(embedded[value]) if value else zero

        counter_vectors = {
            family: {key: counter_vector(value) for key, value in counter_texts[family].items()}
            for family in ("withoutOne", "withoutPair", "pairOnly")
        }
    finally:
        if owned_store:
            store.close()

    direction = np.asarray(model["qualityDirection"], np.float32)
    starts = np.asarray(primitives["starts"], int)
    ends = np.asarray(primitives["ends"], int)
    span_indices = np.asarray([
        int(np.flatnonzero(
            (starts == int(chunk["start"])) & (ends == int(chunk["end"]))
        )[0]) for chunk in partition["chunks"]
    ], int)
    singleton_vectors = primitives["raw"][span_indices]
    context_vectors = primitives["context"][span_indices]
    full_coordinate = float(primitives["full"] @ direction)
    singleton_scores = singleton_vectors @ direction
    context_scores = context_vectors @ direction
    deletion_effects = full_coordinate - context_scores
    pair_context = counter_vectors["withoutPair"]
    interactions = []
    for left in range(component_count):
        for right in range(left + 1, component_count):
            interactions.append({
                "left": left,
                "right": right,
                "interaction": float(
                    full_coordinate - context_scores[left] - context_scores[right]
                    + pair_context[(left, right)] @ direction
                ),
                "definition": "full - without left - without right + without both",
            })
    bootstrap_components, bootstrap_pairs = _bootstrap_attribution(
        primitives["full"], singleton_vectors, context_vectors, pair_context, model,
    )
    training_projection = np.asarray(model["trainingProjectionsSorted"], float)
    axis_percentile = percentile(training_projection, full_coordinate)

    bootstrap_directions = np.asarray(model.get("bootstrapDirections") or [], np.float32)
    bootstrap_training = np.asarray(model.get("bootstrapTrainingProjectionsSorted") or [], float)
    bootstrap_coordinates = bootstrap_directions @ primitives["full"] if len(bootstrap_directions) else np.asarray([])
    bootstrap_percentiles = np.asarray([
        percentile(training, value)
        for training, value in zip(bootstrap_training, bootstrap_coordinates)
    ], float)

    training_embeddings = np.asarray(model["trainingFullEmbeddings"], np.float32)
    similarities = training_embeddings @ primitives["full"]
    nearest_order = np.argsort(-similarities, kind="stable")[:5]
    nearest = [{
        "videoId": model["trainingIds"][index],
        "text": model["trainingTexts"][index],
        "cosine": float(similarities[index]),
    } for index in nearest_order]
    nearest_cosine = float(similarities[nearest_order[0]])
    domain_percentile = percentile(
        np.asarray(model["leaveOneOutNearestCosineSorted"], float), nearest_cosine,
    )

    components = []
    for index, (chunk, value) in enumerate(zip(partition["chunks"], deletion_effects)):
        category_key = str(chunk["category"])
        samples = bootstrap_components[:, index] if len(bootstrap_components) else np.asarray([])
        components.append({
            **chunk,
            "retainedInformationDeletionEffect": float(value),
            "categoryContributionPercentile": percentile(
                np.asarray(model["categoryDeletionCalibration"][category_key], float), float(value),
            ),
            "singletonAxisCoordinate": float(singleton_scores[index]),
            "withoutComponentAxisCoordinate": float(context_scores[index]),
            "attributionDefinition": model["componentDefinition"],
            "bootstrapP10": float(np.quantile(samples, .1)) if len(samples) else None,
            "bootstrapMedian": float(np.median(samples)) if len(samples) else None,
            "bootstrapP90": float(np.quantile(samples, .9)) if len(samples) else None,
            "bootstrapPositiveFraction": float(np.mean(samples > 0)) if len(samples) else None,
        })

    for pair_index, row in enumerate(interactions):
        left = int(row["left"]); right = int(row["right"])
        pair_key = f"{components[left]['category']}->{components[right]['category']}"
        calibration = np.asarray(model["pairInteractionCalibration"].get(pair_key) or [], float)
        samples = bootstrap_pairs[:, pair_index] if len(bootstrap_pairs) else np.asarray([])
        row.update({
            "categoryPair": pair_key,
            "interactionPercentile": percentile(calibration, row["interaction"]) if len(calibration) else None,
            "bootstrapP10": float(np.quantile(samples, .1)) if len(samples) else None,
            "bootstrapMedian": float(np.median(samples)) if len(samples) else None,
            "bootstrapP90": float(np.quantile(samples, .9)) if len(samples) else None,
            "bootstrapPositiveFraction": float(np.mean(samples > 0)) if len(samples) else None,
        })

    market_score = score_market_vector(primitives["full"], market_model)
    market_local = local_market_effects(
        primitives["full"], counter_vectors["withoutOne"],
        counter_vectors["withoutPair"],
        [int(component["category"]) for component in components], market_model,
    )
    if len(market_local["components"]) != len(components):
        raise RuntimeError("Market Hold component attribution count differs")
    if len(market_local["relationships"]) != len(interactions):
        raise RuntimeError("Market Hold relationship attribution count differs")
    for component, contribution in zip(components, market_local["components"]):
        component["marketHoldContribution"] = contribution
    for interaction, contribution in zip(interactions, market_local["relationships"]):
        if (int(interaction["left"]), int(interaction["right"])) != (
            int(contribution["left"]), int(contribution["right"]),
        ):
            raise RuntimeError("Market Hold relationship order differs")
        interaction["marketHoldInteraction"] = contribution

    forward_response = _score_forward_response(
        primitives, partition, counter_vectors, components, interactions, model,
    )
    outcomes = _score_outcomes(
        primitives, partition, components, outcome_model,
    )
    scorecard = _score_local_attributions(
        primitives, partition, counter_vectors, components, interactions,
        outcomes, outcome_model,
    )

    validation = model["validation"]
    retained_score = {
        "label": "Hook retained-information percentile",
        "axisCoordinate": full_coordinate,
        "percentile": axis_percentile,
        "higherMeans": model["target"]["higherMeans"],
        "definition": model["scoreDefinition"],
    }
    retained_map = {
        "x": full_coordinate,
        "y": float(primitives["full"] @ np.asarray(
            model["mapOrthogonalDirection"], np.float32,
        )),
        "xDefinition": "frozen retained-information coordinate",
        "yDefinition": "largest remaining semantic direction orthogonal to retained information",
    }
    survival_score = outcomes["survivalScore"]
    survival_validation = survival_score.get("validation") or {}
    token_count = len(primitives["tokens"])
    lexical_token_count = int(np.sum(primitives["lexical"]))
    training_token_counts = np.asarray([
        len(tokenize(str(value))) for value in model.get("trainingTexts") or []
    ], int)
    stable_payload = f"{SCORER_VERSION}\0{model['methodVersion']}\0{primitives['text']}"
    return {
        "version": 2,
        "status": "complete",
        "id": hashlib.sha256(stable_payload.encode("utf-8")).hexdigest()[:20],
        "scorerVersion": SCORER_VERSION,
        "modelVersion": model["methodVersion"],
        "input": {
            "hookText": primitives["text"],
            "embeddingModel": model["embeddingModel"],
            "embeddingDimensions": model["embeddingDimensions"],
            "fullHookEmbeddingInput": primitives["text"],
            "trainingRewardEmbeddingInput": primitives["text"],
            "spanEmbeddingInputs": primitives["embeddingInputs"],
            "localCounterfactualEmbeddingInputs": len(set(required)),
            "emergentComponentCount": component_count,
            "tokenCount": token_count,
            "lexicalTokenCount": lexical_token_count,
            "trainingTokenCountMinimum": (
                int(training_token_counts.min()) if len(training_token_counts) else None
            ),
            "trainingTokenCountMaximum": (
                int(training_token_counts.max()) if len(training_token_counts) else None
            ),
            "trainingTokenCountPercentile": (
                percentile(training_token_counts, token_count)
                if len(training_token_counts) else None
            ),
            "outsideTrainingLengthRange": bool(
                len(training_token_counts)
                and (token_count < training_token_counts.min()
                     or token_count > training_token_counts.max())
            ),
            "generativeLlmUsed": False,
        },
        "primaryScore": market_score,
        "trainingReward": market_score,
        "score": survival_score,
        "confidence": {
            "heldoutSpearman": survival_validation.get("heldoutSpearman"),
            "heldoutPearson": survival_validation.get("heldoutPearson"),
            "familyCorrectedRankPermutationP": (
                (survival_validation.get("rankInference") or {}).get("p")
            ),
            "validationStatus": survival_validation.get("status"),
            "chronologicalHeldoutSpearman": (
                survival_validation.get("chronologicalValidation") or {}
            ).get("heldoutSpearman"),
            "normalizationRobust": (
                (outcome_model.get("survivalModel") or {}).get(
                    "normalizationSensitivity"
                ) or {}
            ).get("robustAcrossNormalizationChoices"),
            "foldDirectionMedianCosine": survival_validation.get(
                "foldDirectionMedianCosine"
            ),
            "nearestTrainingCosine": nearest_cosine,
            "inDomainSimilarityPercentile": domain_percentile,
            "partitionScoreGap": partition["scoreGap"],
            "partitionScoreGapPercentile": partition["scoreGapPercentile"],
        },
        "map": {
            "x": survival_score.get("mapX"),
            "y": survival_score.get("mapY"),
            "xDefinition": "frozen terminal-conditioned hook-survival diagnostic",
            "yDefinition": "largest remaining semantic direction orthogonal to the diagnostic",
        },
        "retainedInformation": {
            "score": retained_score,
            "map": retained_map,
            "confidence": {
                "heldoutSpearman": validation["heldoutSpearman"],
                "heldoutPearson": validation["heldoutPearson"],
                "rankPermutationP": validation["rankPermutationP"],
                "foldDirectionMedianCosine": validation["foldDirectionMedianCosine"],
                "bootstrapPercentileP10": float(np.quantile(bootstrap_percentiles, .1)) if len(bootstrap_percentiles) else None,
                "bootstrapPercentileMedian": float(np.median(bootstrap_percentiles)) if len(bootstrap_percentiles) else None,
                "bootstrapPercentileP90": float(np.quantile(bootstrap_percentiles, .9)) if len(bootstrap_percentiles) else None,
            },
        },
        "partition": {
            key: value for key, value in partition.items() if key != "owners"
        },
        "components": components,
        "pairInteractions": interactions,
        "scorecard": scorecard,
        "trainingScorecard": {
            "headline": "Market Hold",
            "headlineFormula": market_model["rewardContract"]["primaryScore"],
            "componentFormula": market_model["localCalibration"]["componentDefinition"],
            "relationshipFormula": market_model["localCalibration"]["relationshipDefinition"],
            "coverage": {
                "tokensOwnedExactlyOnce": partition["coverage"] == 1
                and partition["overlapCount"] == 0,
                "componentsExpected": component_count,
                "componentsScored": len(market_local["components"]),
                "relationshipsExpected": component_count * (component_count - 1) // 2,
                "relationshipsScored": len(market_local["relationships"]),
            },
        },
        "localCounterfactuals": {
            "definition": counter_texts["definition"],
            "componentDeletions": [{
                "removedComponent": index,
                "embeddingInput": counter_texts["withoutOne"][index],
                "axisCoordinate": float(context_scores[index]),
                "effect": float(deletion_effects[index]),
                "marketHold": market_local["components"][index],
            } for index in range(component_count)],
            "pairDeletions": [{
                "removedComponents": [left, right],
                "embeddingInput": counter_texts["withoutPair"][(left, right)],
                "retainedPairEmbeddingInput": counter_texts["pairOnly"][(left, right)],
                "axisCoordinate": float(pair_context[(left, right)] @ direction),
                "interaction": float(interaction["interaction"]),
                "marketHold": interaction["marketHoldInteraction"],
            } for interaction in interactions
              for left, right in [(int(interaction["left"]), int(interaction["right"]))]],
        },
        "nearestTrainingHooks": nearest,
        "target": survival_score.get("targetContract"),
        "latency": {
            "legacyWholeHookAxisTest": model["latencyDecision"],
            "forwardComponentMetric": (
                forward_response.get("metric") if forward_response else None
            ),
        },
        "forwardResponse": forward_response,
        "outcomes": outcomes,
        "provenance": {
            "outcomeUsedForBoundaries": False,
            "outcomeUsedForQualityAxis": True,
            "marketRewardFitUsesOwnedOutcomes": False,
            "marketRewardUsesVisualInput": False,
            "marketRewardUsesTitleInput": False,
            "marketRewardUsesRetentionAtInference": False,
            "marketRewardModelVersion": market_model["methodVersion"],
            "examplesUsedForTraining": False,
            "componentAttribution": model["componentDefinition"],
            "forwardResponseDiagnosticsComputed": bool(forward_response),
            "forwardResponseLagAdoptedForWholeHook": bool(
                outcome_model.get("responseLagSeconds")
            ),
            "forwardResponseBoundariesChanged": False,
            "outcomeModelsUseFrozenBoundaries": True,
            "outcomePredictionsHaveRandomFoldDiagnostics": True,
            "outcomePredictionsPassPromotionGate": bool(
                all(
                    str((row.get("validation") or {}).get("status") or "").startswith(
                        "validated"
                    )
                    for row in (outcome_model.get("hookModels") or {}).values()
                )
                and str(survival_validation.get("status") or "").startswith("validated")
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--refresh-model", action="store_true")
    args = parser.parse_args()
    text = sys.stdin.read() if args.stdin else args.text
    if not normalize_source(text):
        print(json.dumps({"error": "type a hook to score"}))
        raise SystemExit(2)
    try:
        model = load_artifact(MODEL_FILE, args.refresh_model)
        partition = load_artifact(PARTITION_FILE, args.refresh_model)
        outcomes = load_artifact(OUTCOME_MODEL_FILE, args.refresh_model)
        result = score_text(text, model, partition, outcome_model=outcomes)
        print(json.dumps(json_ready(result), indent=2 if args.pretty else None,
                         separators=None if args.pretty else (",", ":"), allow_nan=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
