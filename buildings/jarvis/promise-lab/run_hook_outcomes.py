#!/usr/bin/env python3
"""Fit, validate, and publish complete-hook and canonical-component outcomes."""

from __future__ import annotations

import argparse
import json
import os
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from axes import bh_fdr
from cluster_outcomes import (
    entry_terminal_diagnostic,
    exact_token_timings,
    normalized_caption_atom,
    retention_at,
    span_interval,
)
from embedding_store import EmbeddingStore, R2_PREFIX, R2Store, json_ready
from hook_outcomes import (
    FIXED_ALPHA,
    FIXED_DIMENSIONS,
    OUTCOME_SEED,
    apply_duration_baseline,
    apply_terminal_conditioned_replay_correction,
    correlation_audit,
    crossfit_linear,
    curve_validation,
    fit_duration_baseline,
    fit_full_linear,
    forward_chain_linear,
    forward_chain_survival,
    per_second_survival,
    scalar_validation,
    survival_crossfit,
    terminal_conditioned_replay_correction,
)
from hook_score_core import (
    apply_linear_model,
    combined_component_features,
    component_response_windows,
    enrich_word_semantics,
    estimated_token_timeline,
    interpolate_series,
    local_counterfactual_texts,
    percentile,
    row_unit,
)
from run_cluster_outcomes import load_timing_records
from run_forward_response import component_vector_rows
from sequence import tokenize


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
OUTPUT_PATH = CACHE / "hook-outcomes.json"
MODEL_PATH = CACHE / "hook-outcome-model.json"
METHOD_VERSION = "variable-component-hook-outcome-and-retention-forecast-v12"
CURVE_PROGRESS = np.linspace(0.0, 1.0, 41, dtype=np.float32)
FORECAST_FORMULA = (
    "y_hat(p_j) = intercept_j + unit(GeminiEmbedding(complete hook)) dot "
    "coefficient_j for 41 normalized positions p_j inside the analyzed hook"
)

TARGETS = {
    "viewed_percent": {
        "label": "Viewed percentage",
        "shortLabel": "Viewed",
        "unit": "% viewed instead of swiped",
        "definition": "measured Shorts viewed-versus-swiped percentage",
        "higherMeans": "more viewers chose to watch rather than swipe",
        "displayTransform": "identity",
    },
    "retention_5s": {
        "label": "Five-second retention",
        "shortLabel": "5s retention",
        "unit": "% of viewers retained at five seconds",
        "definition": "measured audience-retention curve interpolated at five seconds",
        "higherMeans": "more viewers remain at five seconds, including rewatch above 100%",
        "displayTransform": "identity",
    },
    "average_retention": {
        "label": "Average retention",
        "shortLabel": "Avg retention",
        "unit": "% average percentage viewed",
        "definition": "measured average audience retention for the complete Short",
        "higherMeans": "a larger share of the video is watched on average",
        "displayTransform": "identity",
    },
    "log_views": {
        "label": "Observed views",
        "shortLabel": "Views",
        "unit": "log10 observed views",
        "definition": "log10 of the measured view count; displayed predictions are converted back to views",
        "higherMeans": "more measured views, with multiplicative rather than additive errors",
        "displayTransform": "power10",
    },
}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def outcome_targets(corpus: list[dict]) -> dict[str, np.ndarray]:
    return {
        "viewed_percent": np.asarray([
            float(row.get("keep_rate") or np.nan) for row in corpus
        ], np.float32),
        "retention_5s": np.asarray([
            retention_at(
                row.get("curve") or [], float(row.get("duration_s") or np.nan), 5.0,
            ) * 100 for row in corpus
        ], np.float32),
        "average_retention": np.asarray([
            float(row.get("avg_retention") or np.nan) for row in corpus
        ], np.float32),
        "log_views": np.log10(np.asarray([
            max(1.0, float(row.get("views") or np.nan)) for row in corpus
        ], np.float32)),
    }


def compact_model(fitted: dict, validation: dict) -> dict:
    prediction = np.asarray(fitted["trainingPrediction"], np.float32)[:, 0]
    return {
        "coefficient": np.round(fitted["coefficient"][:, 0], 8),
        "intercept": [float(fitted["intercept"][0])],
        "mapDirection": np.round(fitted["mapDirection"], 8),
        "trainingPredictionSorted": np.sort(prediction),
        "validation": validation,
    }


def add_log_view_error_scale(validation: dict) -> None:
    """Expose log-view error in the multiplicative units people actually feel."""
    validation["multiplicativeErrorP50"] = float(10 ** validation["absoluteErrorP50"])
    validation["multiplicativeErrorP80"] = float(10 ** validation["absoluteErrorP80"])
    validation["multiplicativeErrorP90"] = float(10 ** validation["absoluteErrorP90"])


def apply_long_title_prior(features: np.ndarray, prior: dict) -> np.ndarray:
    coefficient = np.asarray(prior.get("coefficient") or [], np.float32)
    if coefficient.shape != (features.shape[1],):
        raise RuntimeError("Long Quant title prior and Promise Lab embedding dimensions differ")
    return (
        row_unit(np.asarray(features, np.float32)) @ coefficient
        + float(prior.get("intercept") or 0)
    ).astype(np.float32)


def map_values(features: np.ndarray, fitted: dict) -> tuple[np.ndarray, np.ndarray]:
    features = row_unit(np.asarray(features, np.float32))
    x = np.asarray(fitted["trainingPrediction"], np.float32)[:, 0]
    y = features @ np.asarray(fitted["mapDirection"], np.float32)
    return x, y.astype(np.float32)


def source_mean(values: np.ndarray, source_indices: np.ndarray,
                source_count: int) -> np.ndarray:
    values = np.asarray(values, float)
    output = np.full(source_count, np.nan, np.float32)
    for source in range(source_count):
        selected = values[source_indices == source]
        if np.isfinite(selected).any():
            output[source] = float(np.nanmean(selected))
    return output


def local_attribution_calibration(partitions: list[dict],
                                  full_features: np.ndarray,
                                  context_store: np.ndarray,
                                  survival_model: dict,
                                  hook_models: dict[str, dict]) -> tuple[dict, dict]:
    """Calibrate frozen-model deletion effects and pair interactions.

    These values describe the fitted model, not causal effects. Component
    deletions use the exact all-span retained-context vectors. Pair deletions
    reuse the same exact counterfactual texts and embedding cache as the broad
    retained-information analysis.
    """
    required = []
    texts_by_video = {}
    for partition in partitions:
        owners = np.asarray([
            int(token["owner"]) for token in partition["tokens"]
        ], int)
        texts = local_counterfactual_texts(
            partition["text"], tokenize(partition["text"]), owners,
            int(partition["componentCount"]),
        )
        texts_by_video[str(partition["videoId"])] = texts
        required.extend(value for value in texts["withoutPair"].values() if value)
    store = EmbeddingStore(CACHE / "hook-quality-embeddings.sqlite3")
    try:
        pair_embeddings = store.embed_many(required)
    finally:
        store.close()

    scalar_models = {"hook_hold": survival_model, **hook_models}
    component_values = {
        metric: defaultdict(list) for metric in scalar_models
    }
    pair_values = {
        metric: defaultdict(list) for metric in scalar_models
    }
    source_attributions = {}
    zero = np.zeros(full_features.shape[1], np.float32)
    for source_index, partition in enumerate(partitions):
        full = row_unit(full_features[source_index])
        chunks = partition["chunks"]
        categories = [int(chunk["category"]) for chunk in chunks]
        contexts = np.asarray([
            row_unit(np.asarray(context_store[int(chunk["globalSpanIndex"])], np.float32))
            for chunk in chunks
        ], np.float32)
        texts = texts_by_video[str(partition["videoId"])]
        pair_contexts = {}
        for left in range(len(chunks)):
            for right in range(left + 1, len(chunks)):
                text = texts["withoutPair"][(left, right)]
                pair_contexts[(left, right)] = (
                    row_unit(pair_embeddings[text]) if text else zero
                )
        source_row = {
            "videoId": str(partition["videoId"]),
            "components": [{
                "index": index,
                "category": categories[index],
                "effects": {},
            } for index in range(len(chunks))],
            "relationships": [{
                "left": left,
                "right": right,
                "categorySequence": f"{categories[left]}->{categories[right]}",
                "interactions": {},
            } for left in range(len(chunks))
              for right in range(left + 1, len(chunks))],
        }
        relationship_lookup = {
            (int(row["left"]), int(row["right"])): row
            for row in source_row["relationships"]
        }
        for metric, model in scalar_models.items():
            full_score = float(apply_linear_model(full, model)[0, 0])
            without_scores = np.asarray([
                float(apply_linear_model(context, model)[0, 0])
                for context in contexts
            ], float)
            for index, category in enumerate(categories):
                effect = full_score - without_scores[index]
                component_values[metric][str(category)].append(effect)
                source_row["components"][index]["effects"][metric] = float(effect)
            for left in range(len(chunks)):
                for right in range(left + 1, len(chunks)):
                    without_pair = float(apply_linear_model(
                        pair_contexts[(left, right)], model,
                    )[0, 0])
                    pair_key = f"{categories[left]}->{categories[right]}"
                    interaction = (
                        full_score - without_scores[left] - without_scores[right]
                        + without_pair
                    )
                    pair_values[metric][pair_key].append(interaction)
                    relationship_lookup[(left, right)]["interactions"][metric] = float(
                        interaction
                    )
        source_attributions[str(partition["videoId"])] = source_row
    calibration = {
        "method": (
            "local effects from the frozen full-fit linear model: component = full minus "
            "without component; pair = full minus without left minus without right plus "
            "without both"
        ),
        "claimBoundary": (
            "model-relative local counterfactual diagnostics; not additive Shapley values, "
            "causal effects, or independently held-out component outcomes"
        ),
        "componentsByCategory": {
            metric: {
                category: np.sort(values).astype(float).tolist()
                for category, values in rows.items()
            } for metric, rows in component_values.items()
        },
        "pairsByCategorySequence": {
            metric: {
                pair: np.sort(values).astype(float).tolist()
                for pair, values in rows.items()
            } for metric, rows in pair_values.items()
        },
    }
    hold_std = max(float(
        (survival_model.get("scoreScale") or {}).get("predictionStd") or 1
    ), 1e-9)
    for source in source_attributions.values():
        for row in source["components"]:
            category = str(int(row["category"]))
            row["effectHoldZ"] = row["effects"]["hook_hold"] / hold_std
            row["percentiles"] = {
                metric: percentile(
                    np.asarray(calibration["componentsByCategory"][metric][category], float),
                    value,
                ) for metric, value in row["effects"].items()
            }
        for row in source["relationships"]:
            sequence = row["categorySequence"]
            row["interactionHoldZ"] = row["interactions"]["hook_hold"] / hold_std
            row["percentiles"] = {
                metric: percentile(
                    np.asarray(
                        calibration["pairsByCategorySequence"][metric][sequence], float,
                    ),
                    value,
                ) for metric, value in row["interactions"].items()
            }
    return calibration, source_attributions


def speaking_rate(hooks: list[dict], timing_records: dict) -> tuple[dict, dict]:
    rates = []
    timings = {}
    for row in hooks:
        video_id = str(row["videoId"])
        record = timing_records.get(video_id) or {}
        timing = exact_token_timings(
            str(row["text"]), record.get("words") or [],
        ) if record.get("words") else {"status": "missing-words"}
        timings[video_id] = timing
        tokens = tokenize(str(row["text"]))
        start, end = span_interval(timing, 0, len(tokens))
        lexical = sum(bool(normalized_caption_atom(token.text)) for token in tokens)
        if lexical and np.isfinite(start + end) and end > start:
            rates.append(lexical / (end - start))
    values = np.asarray(rates, float)
    return {
        "definition": "source-equal arithmetic mean lexical words per exact aligned spoken second",
        "meanWordsPerSecond": float(np.mean(values)),
        "medianWordsPerSecond": float(np.median(values)),
        "p10WordsPerSecond": float(np.quantile(values, .1)),
        "p90WordsPerSecond": float(np.quantile(values, .9)),
        "exactTimedHooks": len(values),
        "hooks": len(hooks),
    }, timings


def hook_time_windows(partitions: list[dict], timings: dict,
                      mean_wps: float, response_lag: float) -> tuple[np.ndarray, np.ndarray]:
    spoken_end = []
    response_end = []
    for partition in partitions:
        video_id = str(partition["videoId"])
        timing = timings.get(video_id) or {}
        tokens = partition.get("tokens") or []
        if timing.get("status") == "exact":
            _, end = span_interval(timing, 0, len(tokens))
        else:
            lexical = sum(bool(normalized_caption_atom(token.get("text"))) for token in tokens)
            end = lexical / max(float(mean_wps), 1e-4)
        if not np.isfinite(end) or end <= 0:
            raise RuntimeError(f"hook has no usable spoken duration: {video_id}")
        spoken_end.append(float(end))
        response_end.append(float(end + response_lag))
    return np.asarray(spoken_end, np.float32), np.asarray(response_end, np.float32)


def terminal_retention_percent(row: dict) -> float:
    curve = np.asarray(row.get("curve") or [], float) * 100.0
    if len(curve) < 4 or not np.isfinite(curve).all():
        return float("nan")
    count = max(3, int(np.ceil(len(curve) * .05)))
    return float(np.mean(curve[-count:]))


def exact_or_estimated_words(partition: dict, timing: dict, actual_curve: np.ndarray,
                             predicted_curve: np.ndarray, lower: np.ndarray,
                             upper: np.ndarray, duration: float,
                             mean_wps: float, response_lag: float,
                             curve_times: np.ndarray) -> list[dict]:
    tokens = partition.get("tokens") or []
    owners = np.asarray([int(row["owner"]) for row in tokens], int)
    if timing.get("status") != "exact":
        rows = estimated_token_timeline(
            tokens, owners, curve_times, predicted_curve, mean_wps,
            response_lag, lower, upper,
        )
        for row in rows:
            row["actualRetentionPercent"] = retention_at(
                actual_curve, duration, row["responseSeconds"],
            ) * 100
        return rows
    starts = np.asarray(timing.get("tokenStarts") or [], float)
    ends = np.asarray(timing.get("tokenEnds") or [], float)
    output = []
    for index, token in enumerate(tokens):
        if not normalized_caption_atom(token.get("text")):
            continue
        response_second = float(ends[index]) + response_lag
        output.append({
            "tokenIndex": int(token.get("index", index)),
            "text": str(token.get("text") or ""),
            "component": int(owners[index]),
            "spokenStartSeconds": float(starts[index]),
            "spokenEndSeconds": float(ends[index]),
            "responseSeconds": response_second,
            "predictedRetentionPercent": interpolate_series(
                curve_times, predicted_curve, response_second,
            ),
            "predictedRetentionP10": interpolate_series(
                curve_times, lower, response_second,
            ),
            "predictedRetentionP90": interpolate_series(
                curve_times, upper, response_second,
            ),
            "actualRetentionPercent": retention_at(
                actual_curve, duration, response_second,
            ) * 100,
        })
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--timing-workers", type=int, default=16)
    parser.add_argument("--inference-repeats", type=int, default=4096)
    args = parser.parse_args()
    started = time.time()

    corpus = read_json(CACHE / "corpus.json")["rows"]
    manifest = read_json(CACHE / "all-span-manifest.json")
    partition_artifact = read_json(CACHE / "canonical-partitions.json")
    partition_model = read_json(CACHE / "canonical-partition-model.json")
    partitions = partition_artifact["rows"]
    quality = read_json(CACHE / "hook-quality.json")
    if [str(row["id"]) for row in corpus] != [str(row["videoId"]) for row in partitions]:
        raise RuntimeError("Promise Lab corpus and canonical partitions differ")

    full_features = row_unit(np.asarray(
        np.load(CACHE / "all-span-vectors" / "full.npy", mmap_mode="r"),
        np.float32,
    ))
    context_store = np.load(
        CACHE / "all-span-vectors" / "context.npy", mmap_mode="r",
    )

    word_atlas = {
        "points": [], "categories": [], "frozenAtlasCategories": [],
        "globalSpanIndices": [], "videoIds": [], "tokenIndices": [], "texts": [],
    }
    full_hook_atlas = {
        "points": [], "categories": [], "frozenAtlasCategories": [],
        "globalSpanIndices": [], "videoIds": [], "texts": [],
    }
    word_atlas_by_global = {}
    full_atlas_by_global = {}
    for partition in partitions:
        for token in partition.get("tokens") or []:
            if not normalized_caption_atom(token.get("text")):
                continue
            semantic = token["semantic"]
            global_index = int(semantic["globalSpanIndex"])
            word_atlas_by_global[global_index] = len(word_atlas["points"])
            word_atlas["points"].append([semantic["mapX"], semantic["mapY"]])
            word_atlas["categories"].append(int(semantic["category"]))
            word_atlas["frozenAtlasCategories"].append(
                int(semantic["frozenAtlasCategory"])
            )
            word_atlas["globalSpanIndices"].append(global_index)
            word_atlas["videoIds"].append(str(partition["videoId"]))
            word_atlas["tokenIndices"].append(int(token["index"]))
            word_atlas["texts"].append(str(token.get("text") or ""))
        semantic = partition["forecastSemanticInput"]
        global_index = int(semantic["globalSpanIndex"])
        full_atlas_by_global[global_index] = len(full_hook_atlas["points"])
        full_hook_atlas["points"].append([semantic["mapX"], semantic["mapY"]])
        full_hook_atlas["categories"].append(int(semantic["category"]))
        full_hook_atlas["frozenAtlasCategories"].append(
            int(semantic["frozenAtlasCategory"])
        )
        full_hook_atlas["globalSpanIndices"].append(global_index)
        full_hook_atlas["videoIds"].append(str(partition["videoId"]))
        full_hook_atlas["texts"].append(str(partition.get("text") or ""))
    raw_components, influence_components, component_base = component_vector_rows(partitions)
    component_features = combined_component_features(
        raw_components, influence_components,
    )
    source_indices = np.asarray([row["sourceIndex"] for row in component_base], int)
    categories = np.asarray([row["category"] for row in component_base], int)
    groups = np.asarray([row["videoId"] for row in component_base]).astype(str)
    hook_groups = np.asarray([str(row["id"]) for row in corpus])
    chronology = np.asarray([str(row.get("published") or "") for row in corpus])
    targets = outcome_targets(corpus)
    long_title_prior = read_json(CACHE / "long-title-prior.json")
    long_title_prediction = apply_long_title_prior(full_features, long_title_prior)
    long_title_z = (
        long_title_prediction - float(long_title_prior["trainingPredictionMean"])
    ) / max(float(long_title_prior["trainingPredictionStd"]), 1e-9)

    hook_models = {}
    hook_values = {}
    hook_pvalues = []
    hook_temporal_pvalues = []
    for target_index, (target_name, target) in enumerate(targets.items()):
        crossfit = crossfit_linear(
            full_features, target, groups=None,
            seed=OUTCOME_SEED + target_index * 1009,
        )
        validation = scalar_validation(
            crossfit["prediction"], target, crossfit["baselinePrediction"],
            repeats=args.inference_repeats,
            seed=OUTCOME_SEED + target_index * 101,
        )
        if target_name == "log_views":
            add_log_view_error_scale(validation)
        validation["foldDirectionMedianCosine"] = crossfit["foldDirectionMedianCosine"]
        validation["foldDirectionPositiveFraction"] = crossfit["foldDirectionPositiveFraction"]
        temporal = forward_chain_linear(
            full_features, target, chronology,
            seed=OUTCOME_SEED + 12000 + target_index * 101,
        )
        temporal_validation = scalar_validation(
            temporal["prediction"], target, temporal["baselinePrediction"],
            repeats=args.inference_repeats,
            seed=OUTCOME_SEED + 12100 + target_index,
        )
        if target_name == "log_views":
            add_log_view_error_scale(temporal_validation)
        temporal_validation["splits"] = temporal["splits"]
        temporal_validation["evaluatedRows"] = temporal["evaluatedRows"]
        temporal_validation["unevaluatedWarmupRows"] = temporal["unevaluatedWarmupRows"]
        validation["chronologicalValidation"] = temporal_validation
        fitted = fit_full_linear(
            full_features, target, include_map=True,
            seed=OUTCOME_SEED + target_index * 1009,
        )
        x, y = map_values(full_features, fitted)
        hook_models[target_name] = compact_model(fitted, validation)
        hook_values[target_name] = {
            "actual": target,
            "predictionOOF": crossfit["prediction"],
            "baselineOOF": crossfit["baselinePrediction"],
            "foldIndex": crossfit["foldIndex"],
            "mapX": x,
            "mapY": y,
        }
        hook_pvalues.append(validation["rankInference"]["p"])
        hook_temporal_pvalues.append(temporal_validation["rankInference"]["p"])
    random_q = bh_fdr(hook_pvalues)
    temporal_q = bh_fdr(hook_temporal_pvalues)
    for target_name, q, future_q in zip(targets, random_q, temporal_q):
        validation = hook_models[target_name]["validation"]
        validation["familyQ"] = q
        validation["chronologicalValidation"]["familyQ"] = future_q
        temporal_validation = validation["chronologicalValidation"]
        validation["status"] = (
            "validated-random-and-future" if q <= .05
            and validation["heldoutSpearman"] > 0
            and validation["maeImprovementFraction"] > 0
            and future_q <= .05
            and temporal_validation["heldoutSpearman"] > 0
            and temporal_validation["maeImprovementFraction"] > 0
            else "random-fold-only-diagnostic"
        )

    component_models = {}
    component_values = {}
    component_pvalues = []
    category_validation_refs = []
    for target_index, (target_name, target) in enumerate(targets.items()):
        expanded_target = target[source_indices]
        prediction = np.full(len(component_base), np.nan, np.float32)
        baseline = np.full(len(component_base), np.nan, np.float32)
        map_x = np.full(len(component_base), np.nan, np.float32)
        map_y = np.full(len(component_base), np.nan, np.float32)
        fold_index = np.full(len(component_base), -1, np.int16)
        models_by_category = {}
        category_validation = {}
        category_rhos = []
        for category in sorted(set(categories)):
            selected = np.flatnonzero(categories == category)
            crossfit = crossfit_linear(
                component_features[selected], expanded_target[selected],
                groups=groups[selected],
                seed=OUTCOME_SEED + target_index * 1009 + category * 31,
            )
            validation = scalar_validation(
                crossfit["prediction"], expanded_target[selected],
                crossfit["baselinePrediction"],
                repeats=args.inference_repeats,
                seed=OUTCOME_SEED + target_index * 101 + category,
            )
            validation["foldDirectionMedianCosine"] = crossfit["foldDirectionMedianCosine"]
            validation["foldDirectionPositiveFraction"] = crossfit["foldDirectionPositiveFraction"]
            fitted = fit_full_linear(
                component_features[selected], expanded_target[selected],
                include_map=True,
                seed=OUTCOME_SEED + target_index * 1009 + category * 31,
            )
            x, y = map_values(component_features[selected], fitted)
            prediction[selected] = crossfit["prediction"]
            baseline[selected] = crossfit["baselinePrediction"]
            fold_index[selected] = crossfit["foldIndex"]
            map_x[selected] = x
            map_y[selected] = y
            models_by_category[str(category)] = compact_model(fitted, validation)
            category_validation[str(category)] = validation
            category_validation_refs.append((target_name, str(category), validation))
            category_rhos.append(np.arctanh(np.clip(validation["heldoutSpearman"], -.999, .999)))
        source_prediction = source_mean(prediction, source_indices, len(corpus))
        source_baseline = source_mean(baseline, source_indices, len(corpus))
        aggregate = scalar_validation(
            source_prediction, target, source_baseline,
            repeats=args.inference_repeats,
            seed=OUTCOME_SEED + 4000 + target_index,
        )
        aggregate["categoryBalancedSpearman"] = float(np.tanh(np.mean(category_rhos)))
        component_models[target_name] = {
            "modelsByCategory": models_by_category,
            "validationByCategory": category_validation,
            "sourceAggregateValidation": aggregate,
        }
        component_values[target_name] = {
            "actual": expanded_target,
            "predictionOOF": prediction,
            "baselineOOF": baseline,
            "foldIndex": fold_index,
            "mapX": map_x,
            "mapY": map_y,
        }
        component_pvalues.append(aggregate["rankInference"]["p"])
    for target_name, q in zip(targets, bh_fdr(component_pvalues)):
        aggregate = component_models[target_name]["sourceAggregateValidation"]
        aggregate["familyQ"] = q
        aggregate["status"] = "random-fold-only-conditional-diagnostic"
        aggregate["claimBoundary"] = (
            "grouped random-fold association conditional on a post-hoc selected category map; "
            "no chronological component-outcome replication was run"
        )
    category_q = bh_fdr([
        row["rankInference"]["p"] for _, _, row in category_validation_refs
    ])
    for (target_name, category, validation), q in zip(
        category_validation_refs, category_q
    ):
        validation["familyQ"] = q
        validation["status"] = "random-fold-only-conditional-diagnostic"
        validation["claimBoundary"] = (
            "category-specific grouped random-fold association; the category vocabulary was "
            "selected post hoc and no chronological replication was run"
        )
        component_models[target_name]["modelsByCategory"][category][
            "validation"
        ] = validation

    timing_records = load_timing_records(manifest["hooks"], args.timing_workers)
    rate, timings = speaking_rate(manifest["hooks"], timing_records)
    forward_summary = quality.get("forwardResponse") or {}
    selected_response_lag = float(
        (forward_summary.get("metricContract") or {}).get("selectedLagSeconds", 0.0)
    )
    response_lag = selected_response_lag if forward_summary.get("validated") else 0.0
    response_lag_contract = {
        "seconds": response_lag,
        "selectedComponentLagSeconds": selected_response_lag,
        "componentLagValidated": bool(forward_summary.get("validated")),
        "policy": (
            "use the selected component lag only after random-fold and future-only validation; "
            "otherwise use the neutral spoken-hook endpoint with zero added lag"
        ),
    }
    spoken_end, response_end = hook_time_windows(
        partitions, timings, rate["meanWordsPerSecond"], response_lag,
    )
    curve_times = response_end[:, None] * CURVE_PROGRESS[None, :]
    curve_target = np.asarray([
        [
            retention_at(
                row.get("curve") or [], float(row.get("duration_s") or np.nan),
                float(second),
            ) * 100 for second in curve_times[source_index]
        ] for source_index, row in enumerate(corpus)
    ], np.float32)
    curve_crossfit = crossfit_linear(
        full_features, curve_target, groups=None,
        seed=OUTCOME_SEED + 7001,
    )
    curve_metrics = curve_validation(
        curve_crossfit["prediction"], curve_target,
        curve_crossfit["baselinePrediction"], CURVE_PROGRESS,
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 7002,
    )
    chronological_curve = forward_chain_linear(
        full_features, curve_target, chronology, seed=OUTCOME_SEED + 17001,
    )
    chronological_curve_metrics = curve_validation(
        chronological_curve["prediction"], curve_target,
        chronological_curve["baselinePrediction"], CURVE_PROGRESS,
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 17002,
    )
    chronological_curve_metrics["splits"] = chronological_curve["splits"]
    curve_metrics["chronologicalValidation"] = chronological_curve_metrics
    curve_metrics["status"] = (
        "validated-random-and-future-rough-forecast"
        if curve_metrics["maeImprovementFraction"] > 0
        and curve_metrics["pairedImprovementInference"]["p"] <= .05
        and curve_metrics["pairedImprovementInference"]["ciLow"] > 0
        and chronological_curve_metrics["maeImprovementFraction"] > 0
        and chronological_curve_metrics["pairedImprovementInference"]["p"] <= .05
        and chronological_curve_metrics["pairedImprovementInference"]["ciLow"] > 0
        else "random-fold-only-diagnostic"
    )
    curve_fitted = fit_full_linear(
        full_features, curve_target, include_map=False,
        seed=OUTCOME_SEED + 7001,
    )
    curve_model = {
        "coefficient": np.round(curve_fitted["coefficient"], 8),
        "intercept": np.round(curve_fitted["intercept"], 8),
        "progressFractions": CURVE_PROGRESS,
        "residualP10ByTime": curve_metrics["residualP10ByTime"],
        "residualP90ByTime": curve_metrics["residualP90ByTime"],
        "validation": curve_metrics,
    }

    durations = np.asarray([
        float(row.get("duration_s") or np.nan) for row in corpus
    ], np.float32)
    terminal = np.asarray([
        terminal_retention_percent(row) for row in corpus
    ], np.float32)
    replay_correction = terminal_conditioned_replay_correction(
        curve_target, terminal,
    )
    adjusted_curve_target = apply_terminal_conditioned_replay_correction(
        curve_target, terminal,
    )
    entry_normalized_curve_target = (
        100.0 * curve_target / np.maximum(curve_target[:, :1], 1e-6)
    ).astype(np.float32)
    nested_survival = survival_crossfit(
        full_features, adjusted_curve_target, response_end,
        seed=OUTCOME_SEED + 9001,
    )
    entry_survival = survival_crossfit(
        full_features, entry_normalized_curve_target, response_end,
        seed=OUTCOME_SEED + 9001,
    )
    observed_survival = survival_crossfit(
        full_features, curve_target, response_end,
        seed=OUTCOME_SEED + 9001,
    )
    terminal_survival_validation = scalar_validation(
        nested_survival["scorePrediction"], nested_survival["scoreTarget"],
        nested_survival["scoreBaseline"], repeats=args.inference_repeats,
        seed=OUTCOME_SEED + 9002,
    )
    entry_survival_validation = scalar_validation(
        entry_survival["scorePrediction"], entry_survival["scoreTarget"],
        entry_survival["scoreBaseline"], repeats=args.inference_repeats,
        seed=OUTCOME_SEED + 9102,
    )
    observed_survival_validation = scalar_validation(
        observed_survival["scorePrediction"], observed_survival["scoreTarget"],
        observed_survival["scoreBaseline"], repeats=args.inference_repeats,
        seed=OUTCOME_SEED + 9202,
    )
    normalization_q = bh_fdr([
        terminal_survival_validation["rankInference"]["p"],
        entry_survival_validation["rankInference"]["p"],
        observed_survival_validation["rankInference"]["p"],
    ])
    terminal_survival_validation["normalizationFamilyQ"] = normalization_q[0]
    entry_survival_validation["normalizationFamilyQ"] = normalization_q[1]
    observed_survival_validation["normalizationFamilyQ"] = normalization_q[2]
    chronological_terminal_survival = forward_chain_survival(
        full_features, adjusted_curve_target, response_end, chronology,
        seed=OUTCOME_SEED + 19001,
    )
    chronological_terminal_validation = scalar_validation(
        chronological_terminal_survival["prediction"],
        chronological_terminal_survival["target"],
        chronological_terminal_survival["baselinePrediction"],
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 19002,
    )
    chronological_terminal_validation["splits"] = chronological_terminal_survival["splits"]
    chronological_entry_survival = forward_chain_survival(
        full_features, entry_normalized_curve_target, response_end, chronology,
        seed=OUTCOME_SEED + 19101,
    )
    chronological_entry_validation = scalar_validation(
        chronological_entry_survival["prediction"],
        chronological_entry_survival["target"],
        chronological_entry_survival["baselinePrediction"],
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 19102,
    )
    chronological_entry_validation["splits"] = chronological_entry_survival["splits"]
    chronological_block_sensitivity = []
    for blocks in (4, 5, 6, 8, 10):
        if blocks == 5:
            block_validation = chronological_entry_validation
        else:
            block_result = forward_chain_survival(
                full_features, entry_normalized_curve_target, response_end, chronology,
                seed=OUTCOME_SEED + 19001 + blocks, blocks=blocks,
            )
            block_validation = scalar_validation(
                block_result["prediction"], block_result["target"],
                block_result["baselinePrediction"],
                repeats=min(args.inference_repeats, 2048),
                seed=OUTCOME_SEED + 19500 + blocks,
            )
        chronological_block_sensitivity.append({
            "blocks": blocks,
            "evaluatedRows": int(block_validation["rows"]),
            "heldoutSpearman": block_validation["heldoutSpearman"],
            "rankPermutationP": block_validation["rankInference"]["p"],
            "maeImprovementFraction": block_validation["maeImprovementFraction"],
        })
    terminal_survival_validation.update({
        "foldDirectionMedianCosine": nested_survival["foldDirectionMedianCosine"],
        "foldDirectionPositiveFraction": nested_survival["foldDirectionPositiveFraction"],
        "familyQ": terminal_survival_validation["normalizationFamilyQ"],
        "chronologicalValidation": chronological_terminal_validation,
    })
    entry_survival_validation.update({
        "foldDirectionMedianCosine": entry_survival["foldDirectionMedianCosine"],
        "foldDirectionPositiveFraction": entry_survival["foldDirectionPositiveFraction"],
        "familyQ": entry_survival_validation["normalizationFamilyQ"],
        "chronologicalValidation": chronological_entry_validation,
    })
    normalization_sensitivity = {
        "primary": "entryNormalizedNoFutureAnchor",
        "terminalConditioned": terminal_survival_validation,
        "entryNormalizedNoFutureAnchor": entry_survival_validation,
        "observedAbsolute": observed_survival_validation,
        "chronologicalBlockSensitivity": chronological_block_sensitivity,
        "temporalRobustAcrossBlockCounts": bool(all(
            row["heldoutSpearman"] > 0 and row["maeImprovementFraction"] > 0
            for row in chronological_block_sensitivity
        )),
        "terminalVsEntryPrediction": correlation_audit(
            nested_survival["scorePrediction"], entry_survival["scorePrediction"],
        ),
        "terminalVsEntryTarget": correlation_audit(
            nested_survival["scoreTarget"], entry_survival["scoreTarget"],
        ),
        "robustAcrossNormalizationChoices": bool(
            terminal_survival_validation["normalizationFamilyQ"] <= .05
            and terminal_survival_validation["heldoutSpearman"] > 0
            and terminal_survival_validation["maeImprovementFraction"] > 0
            and entry_survival_validation["normalizationFamilyQ"] <= .05
            and entry_survival_validation["heldoutSpearman"] > 0
            and entry_survival_validation["maeImprovementFraction"] > 0
        ),
        "decisionRule": (
            "both terminal-conditioned and future-free entry-normalized targets must have "
            "positive held-out Spearman, positive MAE improvement, and BH q <= 0.05"
        ),
    }
    survival_validation = entry_survival_validation
    survival_validation["status"] = (
        "validated-random-future-and-normalization-robust"
        if survival_validation["heldoutSpearman"] > 0
        and survival_validation["maeImprovementFraction"] > 0
        and survival_validation["normalizationFamilyQ"] <= .05
        and normalization_sensitivity["robustAcrossNormalizationChoices"]
        and normalization_sensitivity["temporalRobustAcrossBlockCounts"]
        and chronological_entry_validation["heldoutSpearman"] > 0
        and chronological_entry_validation["maeImprovementFraction"] > 0
        and chronological_entry_validation["rankInference"]["p"] <= .05
        else "normalization-and-time-sensitive-diagnostic"
    )
    adjusted_curve_metrics = curve_validation(
        nested_survival["curvePrediction"], nested_survival["curveTarget"],
        nested_survival["curveBaseline"], CURVE_PROGRESS,
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 9003,
    )
    chronological_adjusted_curve = forward_chain_linear(
        full_features, adjusted_curve_target, chronology,
        seed=OUTCOME_SEED + 19004,
    )
    chronological_adjusted_curve_metrics = curve_validation(
        chronological_adjusted_curve["prediction"], adjusted_curve_target,
        chronological_adjusted_curve["baselinePrediction"], CURVE_PROGRESS,
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 19005,
    )
    chronological_adjusted_curve_metrics["splits"] = chronological_adjusted_curve["splits"]
    adjusted_curve_metrics["chronologicalValidation"] = chronological_adjusted_curve_metrics
    adjusted_curve_metrics["status"] = (
        "validated-random-and-future-rough-forecast"
        if adjusted_curve_metrics["maeImprovementFraction"] > 0
        and adjusted_curve_metrics["pairedImprovementInference"]["p"] <= .05
        and adjusted_curve_metrics["pairedImprovementInference"]["ciLow"] > 0
        and chronological_adjusted_curve_metrics["maeImprovementFraction"] > 0
        and chronological_adjusted_curve_metrics["pairedImprovementInference"]["p"] <= .05
        and chronological_adjusted_curve_metrics["pairedImprovementInference"]["ciLow"] > 0
        else "random-fold-only-diagnostic"
    )
    entry_curve_metrics = curve_validation(
        entry_survival["curvePrediction"], entry_survival["curveTarget"],
        entry_survival["curveBaseline"], CURVE_PROGRESS,
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 9103,
    )
    chronological_entry_curve = forward_chain_linear(
        full_features, entry_normalized_curve_target, chronology,
        seed=OUTCOME_SEED + 19104,
    )
    chronological_entry_curve_metrics = curve_validation(
        chronological_entry_curve["prediction"], entry_normalized_curve_target,
        chronological_entry_curve["baselinePrediction"], CURVE_PROGRESS,
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 19105,
    )
    chronological_entry_curve_metrics["splits"] = chronological_entry_curve["splits"]
    entry_curve_metrics["chronologicalValidation"] = chronological_entry_curve_metrics
    entry_curve_metrics["status"] = (
        "validated-random-and-future-rough-forecast"
        if entry_curve_metrics["maeImprovementFraction"] > 0
        and entry_curve_metrics["pairedImprovementInference"]["p"] <= .05
        and entry_curve_metrics["pairedImprovementInference"]["ciLow"] > 0
        and chronological_entry_curve_metrics["maeImprovementFraction"] > 0
        and chronological_entry_curve_metrics["pairedImprovementInference"]["p"] <= .05
        and chronological_entry_curve_metrics["pairedImprovementInference"]["ciLow"] > 0
        else "random-fold-only-diagnostic"
    )
    normalization = {
        "methodVersion": "terminal-conditioned-additive-replay-envelope-v1",
        "progressFractions": CURVE_PROGRESS,
        "formula": (
            "for source-specific t = p * analyzed_hook_end: "
            "C(p) = max(R(0)-100, 0) * clip((R(t)-F) / (R(0)-F), 0, 1); "
            "R_normalized(p) = R_observed(t) - C(p)"
        ),
        "inputs": [
            "observed audience-retention curve R(t)",
            "observed entry retention R(0)",
            "robust terminal retention anchor F",
        ],
        "terminalAnchor": (
            "arithmetic mean of the final max(3, 5%) measured retention samples; "
            "this reduces single-point outro noise"
        ),
        "fittedDecayParameters": 0,
        "definition": (
            "An additive endpoint-conditioned replay envelope. Entry excess above 100 is "
            "carried in proportion to the observed curve's remaining distance above its "
            "terminal anchor. No shared time-decay curve is fitted."
        ),
    }
    entry_end = entry_normalized_curve_target[:, -1]
    carry_rate = per_second_survival(entry_end, response_end)
    length_baseline = fit_duration_baseline(response_end, carry_rate)
    expected_carry = apply_duration_baseline(response_end, length_baseline)
    survival_target = carry_rate - expected_carry
    survival_fitted = fit_full_linear(
        full_features, survival_target, include_map=True,
        seed=OUTCOME_SEED + 9001,
    )
    survival_x, survival_y = map_values(full_features, survival_fitted)
    survival_model = compact_model(survival_fitted, survival_validation)
    survival_model.update({
        "pcaDimensions": FIXED_DIMENSIONS,
        "ridgeAlpha": FIXED_ALPHA,
        "lengthBaseline": length_baseline,
        "trainingTargetSorted": np.sort(survival_target),
        "trainingOOFPredictionSorted": np.sort(entry_survival["scorePrediction"]),
        "scoreScale": {
            "label": "Hook Hold z-score",
            "formula": "(predicted excess carry - mean OOF prediction) / SD of OOF predictions",
            "predictionMean": survival_validation["predictionMean"],
            "predictionStd": survival_validation["predictionStd"],
            "residualStd": survival_validation["residualStd"],
            "unit": "standard deviations of out-of-fold predicted excess carry",
            "zeroMeans": (
                f"the mean predicted hold coordinate among the {len(corpus)} measured hooks"
            ),
            "higherMeans": "the model predicts more retention hold than the duration-only expectation",
            "percentileRole": (
                f"secondary rank within the current {len(corpus)}-hook calibration set only"
            ),
        },
        "normalizationSensitivity": normalization_sensitivity,
        "targetContract": {
            "label": "Future-free entry-indexed length-adjusted survival diagnostic",
            "unit": "excess geometric retention carry percentage points per second",
            "higherMeans": (
                "the hook loses less entry-indexed retention than the ordinary "
                "drop for a hook with the same response duration"
            ),
            "formula": (
                "100 * exp(log(R(response_end) / R(0)) / response_end) "
                "minus the out-of-fold duration-only expected carry rate"
            ),
            "responseEnd": (
                "exact spoken hook end plus the component lag only if that lag validates in random "
                "and future-only tests; otherwise exact spoken hook end with zero added lag"
            ),
            "responseLagContract": response_lag_contract,
            "claimBoundary": (
                "future-free with respect to the full-video endpoint, but still observational; "
                "diagnostic unless the direction validates on later videos and across normalizations"
            ),
        },
    })
    attribution_calibration, source_attributions = local_attribution_calibration(
        partitions, full_features, context_store, survival_model, hook_models,
    )
    adjusted_curve_fitted = fit_full_linear(
        full_features, adjusted_curve_target, include_map=False,
        seed=OUTCOME_SEED + 9004,
    )
    adjusted_curve_model = {
        "coefficient": np.round(adjusted_curve_fitted["coefficient"], 8),
        "intercept": np.round(adjusted_curve_fitted["intercept"], 8),
        "progressFractions": CURVE_PROGRESS,
        "residualP10ByTime": adjusted_curve_metrics["residualP10ByTime"],
        "residualP90ByTime": adjusted_curve_metrics["residualP90ByTime"],
        "validation": adjusted_curve_metrics,
        "normalization": normalization,
    }
    entry_normalization = {
        "methodVersion": "future-free-entry-indexed-retention-v1",
        "formula": "R_entry_indexed(t) = 100 * R(t) / R(0)",
        "inputs": [
            "observed audience-retention curve through the analyzed hook R(t)",
            "observed entry retention R(0)",
        ],
        "usesFullVideoTerminal": False,
        "definition": (
            "A future-free scale correction. It removes the absolute entry level but does not "
            "claim to identify replay counts or causal first-pass retention."
        ),
    }
    entry_curve_fitted = fit_full_linear(
        full_features, entry_normalized_curve_target, include_map=False,
        seed=OUTCOME_SEED + 9104,
    )
    entry_curve_model = {
        "coefficient": np.round(entry_curve_fitted["coefficient"], 8),
        "intercept": np.round(entry_curve_fitted["intercept"], 8),
        "progressFractions": CURVE_PROGRESS,
        "residualP10ByTime": entry_curve_metrics["residualP10ByTime"],
        "residualP90ByTime": entry_curve_metrics["residualP90ByTime"],
        "validation": entry_curve_metrics,
        "normalization": entry_normalization,
    }
    entry_inflation = curve_target[:, 0] - 100.0
    opening_half_second = np.asarray([
        retention_at(
            row.get("curve") or [], float(row.get("duration_s") or np.nan),
            min(0.5, float(response_end[source_index])),
        ) * 100.0 - curve_target[source_index, 0]
        for source_index, row in enumerate(corpus)
    ], np.float32)
    opening_three_seconds = np.asarray([
        (
            retention_at(
                row.get("curve") or [], float(row.get("duration_s") or np.nan),
                min(3.0, float(response_end[source_index])),
            ) * 100.0 - curve_target[source_index, 0]
        ) / max(min(3.0, float(response_end[source_index])), 1e-6)
        for source_index, row in enumerate(corpus)
    ], np.float32)
    entry_diagnostic = entry_terminal_diagnostic(
        curve_target[:, 0], terminal, durations, seed=OUTCOME_SEED + 9010,
    )
    entry_prediction = np.asarray(entry_diagnostic["predictedEntryOOF"], float)
    entry_valid = np.isfinite(entry_prediction + curve_target[:, 0])
    entry_diagnostic["oofMAEPercentagePoints"] = float(np.mean(np.abs(
        entry_prediction[entry_valid] - curve_target[entry_valid, 0]
    )))
    raw_delta = np.diff(curve_target, axis=1)
    adjusted_delta = np.diff(adjusted_curve_target, axis=1)
    correction_delta = np.diff(replay_correction, axis=1)
    native_endpoint_correction = []
    for row, anchor in zip(corpus, terminal):
        native_curve = np.asarray(row.get("curve") or [], float) * 100.0
        native_endpoint_correction.append(float(
            terminal_conditioned_replay_correction(native_curve, anchor)[-1]
        ))
    tolerance = 1e-5
    rewatch_audit = {
        "hypothesisStatus": "supported-observationally",
        "entryInflationVsTerminal": correlation_audit(entry_inflation, terminal),
        "entryInflationVsOpeningHalfSecond": correlation_audit(
            entry_inflation, opening_half_second,
        ),
        "entryInflationVsOpeningThreeSecondSlope": correlation_audit(
            entry_inflation, opening_three_seconds,
        ),
        "terminalVsOpeningThreeSecondSlope": correlation_audit(
            terminal, opening_three_seconds,
        ),
        "terminalToEntryModel": entry_diagnostic,
        "normalization": normalization,
        "correctionMedianPercentagePoints": np.median(replay_correction, axis=0),
        "correctionP10PercentagePoints": np.quantile(replay_correction, .1, axis=0),
        "correctionP90PercentagePoints": np.quantile(replay_correction, .9, axis=0),
        "normalizedMedianPercent": np.median(adjusted_curve_target, axis=0),
        "normalizedP10Percent": np.quantile(adjusted_curve_target, .1, axis=0),
        "normalizedP90Percent": np.quantile(adjusted_curve_target, .9, axis=0),
        "geometryValidation": {
            "maximumStartErrorPercentagePoints": float(np.max(np.abs(
                adjusted_curve_target[:, 0] - 100.0
            ))),
            "negativeCorrectionValues": int(np.sum(replay_correction < -tolerance)),
            "observedIncreaseIntervals": int(np.sum(raw_delta > tolerance)),
            "normalizedIncreaseIntervals": int(np.sum(adjusted_delta > tolerance)),
            "correctionIncreaseIntervals": int(np.sum(correction_delta > tolerance)),
            "correctionInducedIncreaseIntervals": int(np.sum(
                (adjusted_delta > tolerance) & (raw_delta <= tolerance)
            )),
            "maximumFullVideoEndpointCorrectionPercentagePoints": float(np.max(
                native_endpoint_correction
            )),
            "medianCorrectionAtAnalyzedHookEndPercentagePoints": float(np.median(
                replay_correction[:, -1]
            )),
            "p90CorrectionAtAnalyzedHookEndPercentagePoints": float(np.quantile(
                replay_correction[:, -1], .9
            )),
        },
        "scope": {
            "videos": len(corpus),
            "minimumVideoDurationSeconds": float(np.min(durations)),
            "medianSpokenHookEndSeconds": float(np.median(spoken_end)),
            "maximumSpokenHookEndSeconds": float(np.max(spoken_end)),
            "minimumResponseEndSeconds": float(np.min(response_end)),
            "medianResponseEndSeconds": float(np.median(response_end)),
            "maximumResponseEndSeconds": float(np.max(response_end)),
            "curveProgressPoints": len(CURVE_PROGRESS),
            "postHookOutputPoints": 0,
            "modelScope": "analyzed hook only",
        },
        "claimBoundary": (
            "This is an endpoint-conditioned replay envelope, not identified replay counts "
            "or causal first-pass retention. A measured curve and measured terminal anchor "
            "are required; text alone cannot be normalized. The observed absolute curve "
            "always remains available beside it."
        ),
    }
    curve_low = curve_crossfit["prediction"] + np.asarray(
        curve_metrics["residualP10ByTime"], np.float32,
    )
    curve_high = curve_crossfit["prediction"] + np.asarray(
        curve_metrics["residualP90ByTime"], np.float32,
    )
    adjusted_curve_low = nested_survival["curvePrediction"] + np.asarray(
        adjusted_curve_metrics["residualP10ByTime"], np.float32,
    )
    adjusted_curve_high = nested_survival["curvePrediction"] + np.asarray(
        adjusted_curve_metrics["residualP90ByTime"], np.float32,
    )
    entry_curve_low = entry_survival["curvePrediction"] + np.asarray(
        entry_curve_metrics["residualP10ByTime"], np.float32,
    )
    entry_curve_high = entry_survival["curvePrediction"] + np.asarray(
        entry_curve_metrics["residualP90ByTime"], np.float32,
    )
    adjusted_curve_low[:, 0] = 100.0
    adjusted_curve_high[:, 0] = 100.0
    entry_curve_low[:, 0] = 100.0
    entry_curve_high[:, 0] = 100.0

    long_title_transfer = {
        "status": "independent-not-blended",
        "prior": {
            key: long_title_prior.get(key) for key in (
                "methodVersion", "embeddingInput", "target", "corpus",
                "validation", "claimBoundary",
            )
        },
        "shortsTransfer": {
            "hookHold": correlation_audit(
                long_title_prediction, entry_survival["scoreTarget"],
            ),
            **{
                target_name: correlation_audit(long_title_prediction, target)
                for target_name, target in targets.items()
            },
        },
        "shortsLogViewsDistribution": {
            "mean": float(np.mean(targets["log_views"])),
            "std": float(np.std(targets["log_views"])),
            "p10": float(np.quantile(targets["log_views"], .1)),
            "p90": float(np.quantile(targets["log_views"], .9)),
        },
        "priorPredictionOnShortsHooks": {
            "mean": float(np.mean(long_title_prediction)),
            "std": float(np.std(long_title_prediction)),
            "p10": float(np.quantile(long_title_prediction, .1)),
            "p90": float(np.quantile(long_title_prediction, .9)),
        },
        "decision": (
            "Keep this long-form title-market direction visible and separate. Its global "
            "transfer to Shorts hold is near zero, so adding it to Hook Hold would reduce "
            "interpretability without held-out evidence."
        ),
    }

    quality_points = {
        str(row["videoId"]): row for row in (quality.get("axis") or {}).get("points") or []
    }
    quality_components = {
        (str(row["videoId"]), int(row["component"])): row
        for row in quality.get("components") or []
    }
    quality_relations = {}
    forward_category_rho = (
        ((quality.get("forwardResponse") or {}).get("componentModel") or {}).get(
            "heldoutSpearmanByCategory"
        ) or {}
    )
    for point in (quality.get("axis") or {}).get("points") or []:
        for relation in point.get("pairInteractions") or []:
            quality_relations[(
                str(point["videoId"]), int(relation["left"]), int(relation["right"]),
            )] = relation
    headline_relations = {
        (str(source["videoId"]), int(row["left"]), int(row["right"])): row
        for source in source_attributions.values()
        for row in source["relationships"]
    }

    components = []
    for index, base in enumerate(component_base):
        quality_row = quality_components.get((str(base["videoId"]), int(base["component"]))) or {}
        local_row = source_attributions[str(base["videoId"])]["components"][
            int(base["component"])
        ]
        forward_row = dict(quality_row.get("forwardResponse") or {})
        if forward_row:
            forward_row["heldoutSpearmanForCategory"] = forward_category_rho.get(
                str(int(base["category"]))
            )
            forward_row["percentileBasis"] = (
                "predicted unexpected entry-indexed slope among training components "
                "in the same frozen category"
            )
            forward_row["higherMeans"] = (
                "flatter loss or a rise beyond the source-held-out text-free expectation"
            )
        row = {
            **base,
            "broadRetainedInformation": {
                "deletionEffect": quality_row.get("deletionEffect"),
                "percentile": quality_row.get("categoryPercentile"),
                "singletonAxisCoordinate": quality_row.get("singletonAxisCoordinate"),
                "definition": quality_row.get("attributionDefinition"),
            },
            "boundaryEvidence": {
                "leftProbability": quality_row.get("leftBoundaryProbability"),
                "rightProbability": quality_row.get("rightBoundaryProbability"),
                "leftRawPosterior": quality_row.get("leftBoundaryPosterior"),
                "rightRawPosterior": quality_row.get("rightBoundaryPosterior"),
                "categoryProbability": quality_row.get("categoryProbability"),
                "definition": (
                    "source-held-out learned cut probability at each selected edge; outer hook "
                    "edges are structural and therefore have no probability"
                ),
            },
            "forwardResponse": forward_row or None,
            "hookHoldContribution": {
                "metric": "Hook Hold",
                "effectRawCarryPointsPerSecond": local_row["effects"]["hook_hold"],
                "effectHoldZ": local_row["effectHoldZ"],
                "categoryPercentile": local_row["percentiles"]["hook_hold"],
                "definition": (
                    "frozen full-fit score(full hook) minus score(exact hook with this "
                    "component removed)"
                ),
                "claimBoundary": attribution_calibration["claimBoundary"],
            },
            "wholeHookOutcomeContributions": {
                target_name: {
                    "effect": local_row["effects"][target_name],
                    "categoryPercentile": local_row["percentiles"][target_name],
                } for target_name in targets
            },
            "outcomes": {},
        }
        for target_name in targets:
            values = component_values[target_name]
            category = str(int(base["category"]))
            samples = np.asarray(
                component_models[target_name]["modelsByCategory"][category][
                    "trainingPredictionSorted"
                ], float,
            )
            prediction = float(values["predictionOOF"][index])
            actual = float(values["actual"][index])
            validation = component_models[target_name]["validationByCategory"][category]
            row["outcomes"][target_name] = {
                "actual": actual,
                "predictedOOF": prediction,
                "residual": actual - prediction,
                "predictionP10": prediction + validation["residualP10"],
                "predictionP90": prediction + validation["residualP90"],
                "mapX": float(values["mapX"][index]),
                "mapY": float(values["mapY"][index]),
                "percentile": percentile(samples, float(values["mapX"][index])),
                "fold": int(values["foldIndex"][index]),
                "validationStatus": validation.get("status", "diagnostic"),
                "heldoutSpearman": validation["heldoutSpearman"],
            }
        components.append(row)

    component_offsets = []
    component_cursor = 0
    relationship_total = 0
    for partition in partitions:
        count = int(partition["componentCount"])
        component_offsets.append(component_cursor)
        component_cursor += count
        relationship_total += count * (count - 1) // 2
    if component_cursor != len(components):
        raise RuntimeError("variable component offsets do not match component outcomes")

    hooks = []
    for source_index, (corpus_row, partition) in enumerate(zip(corpus, partitions)):
        video_id = str(corpus_row["id"])
        prediction_curve = np.asarray(curve_crossfit["prediction"][source_index], float)
        lower_curve = np.asarray(curve_low[source_index], float)
        upper_curve = np.asarray(curve_high[source_index], float)
        source_curve_times = np.asarray(curve_times[source_index], float)
        actual_curve = np.asarray(corpus_row.get("curve") or [], float)
        duration = float(corpus_row.get("duration_s") or np.nan)
        words = exact_or_estimated_words(
            partition, timings.get(video_id) or {}, actual_curve, prediction_curve,
            lower_curve, upper_curve, duration, rate["meanWordsPerSecond"],
            response_lag, source_curve_times,
        )
        enrich_word_semantics(words, partition["tokens"], partition["chunks"])
        adjusted_prediction_curve = np.asarray(
            nested_survival["curvePrediction"][source_index], float,
        )
        adjusted_actual_curve = np.asarray(
            nested_survival["curveTarget"][source_index], float,
        )
        adjusted_lower_curve = np.asarray(adjusted_curve_low[source_index], float)
        adjusted_upper_curve = np.asarray(adjusted_curve_high[source_index], float)
        entry_prediction_curve = np.asarray(
            entry_survival["curvePrediction"][source_index], float,
        )
        entry_actual_curve = np.asarray(
            entry_survival["curveTarget"][source_index], float,
        )
        entry_lower_curve = np.asarray(entry_curve_low[source_index], float)
        entry_upper_curve = np.asarray(entry_curve_high[source_index], float)
        observed_fold = int(curve_crossfit["foldIndex"][source_index])
        observed_fold_model = curve_crossfit["foldModels"][observed_fold]
        adjusted_fold = int(nested_survival["foldIndex"][source_index])
        adjusted_fold_model = nested_survival["curveFoldModels"][adjusted_fold]
        entry_fold = int(entry_survival["foldIndex"][source_index])
        entry_fold_model = entry_survival["curveFoldModels"][entry_fold]
        for word in words:
            second = float(word["responseSeconds"])
            word["observedAbsolutePredictedRetentionPercent"] = word[
                "predictedRetentionPercent"
            ]
            word["observedAbsoluteActualRetentionPercent"] = word.get(
                "actualRetentionPercent"
            )
            word["terminalConditionedPredictedRetentionPercent"] = interpolate_series(
                source_curve_times, adjusted_prediction_curve, second,
            )
            word["terminalConditionedPredictionP10"] = interpolate_series(
                source_curve_times, adjusted_lower_curve, second,
            )
            word["terminalConditionedPredictionP90"] = interpolate_series(
                source_curve_times, adjusted_upper_curve, second,
            )
            word["terminalConditionedActualRetentionPercent"] = interpolate_series(
                source_curve_times, adjusted_actual_curve, second,
            )
            word["entryIndexedPredictedRetentionPercent"] = interpolate_series(
                source_curve_times, entry_prediction_curve, second,
            )
            word["entryIndexedPredictionP10"] = interpolate_series(
                source_curve_times, entry_lower_curve, second,
            )
            word["entryIndexedPredictionP90"] = interpolate_series(
                source_curve_times, entry_upper_curve, second,
            )
            word["entryIndexedActualRetentionPercent"] = interpolate_series(
                source_curve_times, entry_actual_curve, second,
            )
            word["predictedRetentionPercent"] = word[
                "entryIndexedPredictedRetentionPercent"
            ]
            word["predictedRetentionP10"] = word["entryIndexedPredictionP10"]
            word["predictedRetentionP90"] = word["entryIndexedPredictionP90"]
            word["actualRetentionPercent"] = word[
                "entryIndexedActualRetentionPercent"
            ]
            global_index = int(word["singletonGlobalSpanIndex"])
            word["singletonAtlasIndex"] = int(word_atlas_by_global[global_index])
            context_vector = np.asarray(context_store[global_index], np.float32)
            observed_without = apply_linear_model(
                context_vector, observed_fold_model,
            )[0]
            adjusted_without = apply_linear_model(
                context_vector, adjusted_fold_model,
            )[0]
            entry_without = apply_linear_model(
                context_vector, entry_fold_model,
            )[0]
            adjusted_without[0] = 100.0
            entry_without[0] = 100.0
            word["observedForecastDeletionContributionByTime"] = (
                prediction_curve - observed_without
            ).astype(float).tolist()
            word["rewatchAdjustedForecastDeletionContributionByTime"] = (
                adjusted_prediction_curve - adjusted_without
            ).astype(float).tolist()
            word["entryIndexedForecastDeletionContributionByTime"] = (
                entry_prediction_curve - entry_without
            ).astype(float).tolist()
        point = quality_points.get(video_id) or {}
        hook_outcomes = {}
        for target_name in targets:
            values = hook_values[target_name]
            validation = hook_models[target_name]["validation"]
            prediction = float(values["predictionOOF"][source_index])
            actual = float(values["actual"][source_index])
            hook_outcomes[target_name] = {
                "actual": actual,
                "predictedOOF": prediction,
                "residual": actual - prediction,
                "predictionP10": prediction + validation["residualP10"],
                "predictionP90": prediction + validation["residualP90"],
                "mapX": float(values["mapX"][source_index]),
                "mapY": float(values["mapY"][source_index]),
                "percentile": percentile(
                    np.asarray(hook_models[target_name]["trainingPredictionSorted"], float),
                    float(values["mapX"][source_index]),
                ),
                "fold": int(values["foldIndex"][source_index]),
                "validationStatus": validation["status"],
            }
        survival_prediction = float(entry_survival["scorePrediction"][source_index])
        survival_actual = float(entry_survival["scoreTarget"][source_index])
        survival_expected = float(
            entry_survival["expectedCarryPercentPerSecond"][source_index]
        )
        survival_carry = float(
            entry_survival["carryPercentPerSecond"][source_index]
        )
        survival_predicted_carry = survival_expected + survival_prediction
        hold_mean = float(survival_model["scoreScale"]["predictionMean"])
        hold_std = max(float(survival_model["scoreScale"]["predictionStd"]), 1e-9)
        residual_std = max(float(survival_model["scoreScale"]["residualStd"]), 1e-9)
        hold_z = (survival_prediction - hold_mean) / hold_std
        actual_hold_z = (survival_actual - hold_mean) / hold_std
        expected_end = float(100.0 * (
            max(survival_expected, 1e-4) / 100.0
        ) ** response_end[source_index])
        predicted_end = float(100.0 * (
            max(survival_predicted_carry, 1e-4) / 100.0
        ) ** response_end[source_index])
        component_offset = component_offsets[source_index]
        component_count = int(partition["componentCount"])
        hooks.append({
            "sourceIndex": source_index,
            "videoId": video_id,
            "title": str(corpus_row.get("title") or ""),
            "text": str(corpus_row.get("hookText") or ""),
            "url": str(corpus_row.get("url") or ""),
            "views": int(corpus_row.get("views") or 0),
            "overallScore": {
                "axisCoordinate": point.get("axisCoordinate"),
                "percentile": point.get("oofAxisPercentile"),
                "mapX": point.get("axisCoordinate"),
                "mapY": point.get("mapY"),
                "observedResidual": point.get("oofTargetResidual"),
            },
            "survivalScore": {
                "label": "Hook Hold z-score",
                "holdZ": float(hold_z),
                "actualHoldZ": float(actual_hold_z),
                "percentile": percentile(
                    np.asarray(entry_survival["scorePrediction"], float),
                    survival_prediction,
                ),
                "actualPercentile": percentile(
                    np.asarray(entry_survival["scoreTarget"], float),
                    survival_actual,
                ),
                "predictedOOF": survival_prediction,
                "actual": survival_actual,
                "residual": survival_actual - survival_prediction,
                "errorStandardDeviations": float(
                    (survival_actual - survival_prediction) / residual_std
                ),
                "predictionP10": survival_prediction + survival_validation["residualP10"],
                "predictionP90": survival_prediction + survival_validation["residualP90"],
                "mapX": float(survival_x[source_index]),
                "mapY": float(survival_y[source_index]),
                "fold": int(entry_survival["foldIndex"][source_index]),
                "validationStatus": survival_validation["status"],
                "responseEndSeconds": float(response_end[source_index]),
                "spokenHookEndSeconds": float(spoken_end[source_index]),
                "actualCarryPercentPerSecond": survival_carry,
                "expectedCarryPercentPerSecond": survival_expected,
                "predictedCarryPercentPerSecond": survival_predicted_carry,
                "actualEntryIndexedRetentionAtResponseEnd": float(
                    100.0 * (survival_carry / 100.0) ** response_end[source_index]
                ),
                "predictedEntryIndexedRetentionAtResponseEnd": float(
                    predicted_end
                ),
                "durationBaselineRetentionAtResponseEnd": expected_end,
                "predictedHoldLiftPercentagePoints": predicted_end - expected_end,
                "scoreScale": survival_model["scoreScale"],
                "higherMeans": survival_model["targetContract"]["higherMeans"],
            },
            "longTitleMarketPrior": {
                "predictedLog10LongFormViews": float(long_title_prediction[source_index]),
                "z": float(long_title_z[source_index]),
                "blendedIntoHookHold": False,
            },
            "outcomes": hook_outcomes,
            "componentOffset": component_offset,
            "componentCount": component_count,
            "components": components[
                component_offset:component_offset + component_count
            ],
            "relationships": [
                {
                    **(quality_relations.get((video_id, left, right)) or {}),
                    "left": left,
                    "right": right,
                    "hookHoldInteraction": {
                        "metric": "Hook Hold",
                        "interactionRawCarryPointsPerSecond": headline_relations[
                            (video_id, left, right)
                        ]["interactions"]["hook_hold"],
                        "interactionHoldZ": headline_relations[
                            (video_id, left, right)
                        ]["interactionHoldZ"],
                        "categorySequencePercentile": headline_relations[
                            (video_id, left, right)
                        ]["percentiles"]["hook_hold"],
                        "definition": (
                            "frozen full-fit score(full) - score(without left) - "
                            "score(without right) + score(without both)"
                        ),
                        "claimBoundary": attribution_calibration["claimBoundary"],
                    },
                    "wholeHookOutcomeInteractions": {
                        target_name: {
                            "interaction": headline_relations[
                                (video_id, left, right)
                            ]["interactions"][target_name],
                            "categorySequencePercentile": headline_relations[
                                (video_id, left, right)
                            ]["percentiles"][target_name],
                        } for target_name in targets
                    },
                }
                for left in range(component_count)
                for right in range(left + 1, component_count)
            ],
            "retentionForecast": {
                "normalizationAvailable": True,
                "availableCurveModes": ["entry", "absolute", "terminal"],
                "measuredCurveAvailable": True,
                "terminalSensitivityAvailable": True,
                "primaryNormalization": "entry-indexed",
                "normalizationMethod": entry_normalization["methodVersion"],
                "normalizationContracts": {
                    "entryIndexed": entry_normalization,
                    "terminalConditioned": normalization,
                    "observedAbsolute": {
                        "formula": "R(t)",
                        "usesFullVideoTerminal": False,
                        "definition": "the measured aggregate audience-retention curve",
                    },
                },
                "terminalRetentionPercent": float(terminal[source_index]),
                "entryIndexedValidation": entry_curve_metrics,
                "observedAbsoluteValidation": curve_metrics,
                "terminalConditionedValidation": adjusted_curve_metrics,
                "progressFractions": CURVE_PROGRESS,
                "timesSeconds": source_curve_times,
                "actualPercent": curve_target[source_index],
                "predictedOOFPercent": prediction_curve,
                "predictionP10": lower_curve,
                "predictionP90": upper_curve,
                "entryIndexedActualPercent": entry_actual_curve,
                "entryIndexedPredictedOOFPercent": entry_prediction_curve,
                "entryIndexedPredictionP10": entry_lower_curve,
                "entryIndexedPredictionP90": entry_upper_curve,
                "terminalConditionedActualPercent": adjusted_actual_curve,
                "terminalConditionedPredictedOOFPercent": adjusted_prediction_curve,
                "terminalConditionedPredictionP10": adjusted_lower_curve,
                "terminalConditionedPredictionP90": adjusted_upper_curve,
                "rewatchAdjustedActualPercent": adjusted_actual_curve,
                "rewatchAdjustedPredictedOOFPercent": adjusted_prediction_curve,
                "rewatchAdjustedPredictionP10": adjusted_lower_curve,
                "rewatchAdjustedPredictionP90": adjusted_upper_curve,
                "replayCorrectionPercent": replay_correction[source_index],
                "sourceMAEPercentagePoints": float(np.mean(np.abs(
                    prediction_curve - curve_target[source_index]
                ))),
                "baselineMAEPercentagePoints": float(np.mean(np.abs(
                    curve_crossfit["baselinePrediction"][source_index]
                    - curve_target[source_index]
                ))),
                "rewatchAdjustedSourceMAEPercentagePoints": float(np.mean(np.abs(
                    adjusted_prediction_curve - adjusted_actual_curve
                ))),
                "rewatchAdjustedBaselineMAEPercentagePoints": float(np.mean(np.abs(
                    nested_survival["curveBaseline"][source_index]
                    - adjusted_actual_curve
                ))),
                "entryIndexedSourceMAEPercentagePoints": float(np.mean(np.abs(
                    entry_prediction_curve - entry_actual_curve
                ))),
                "entryIndexedBaselineMAEPercentagePoints": float(np.mean(np.abs(
                    entry_survival["curveBaseline"][source_index]
                    - entry_actual_curve
                ))),
                "spokenHookEndSeconds": float(spoken_end[source_index]),
                "responseEndSeconds": float(response_end[source_index]),
                "analysisEndSeconds": float(response_end[source_index]),
                "forecastScope": (
                    "all 41 outputs lie between the first analyzed hook word and the final "
                    "analyzed hook response; there are no post-hook outputs"
                ),
                "forecastInput": {
                    **partition["forecastSemanticInput"],
                    "atlasIndex": int(full_atlas_by_global[
                        int(partition["forecastSemanticInput"]["globalSpanIndex"])
                    ]),
                    "embeddingModel": manifest.get("embeddingModel"),
                    "embeddingDimensions": manifest.get("embeddingDimensions"),
                    "formula": FORECAST_FORMULA,
                    "outputCluster": None,
                    "outputClusterReason": (
                        "the 41 within-hook retention values are scalar outputs, not semantic embeddings"
                    ),
                },
                "wordContributionDefinition": (
                    "source-held-out local deletion diagnostic at every time: complete-hook "
                    "forecast minus the same fold model forecast after deleting exactly this "
                    "token; values are not additive Shapley effects"
                ),
                "wordTimingPolicy": (
                    "exact captions" if (timings.get(video_id) or {}).get("status") == "exact"
                    else "library-average speaking rate"
                ),
                "words": words,
                "componentWindows": component_response_windows(
                    words, component_count, response_lag,
                ),
            },
        })

    model = {
        "version": 2,
        "status": "complete",
        "methodVersion": METHOD_VERSION,
        "embeddingModel": manifest.get("embeddingModel"),
        "embeddingDimensions": manifest.get("embeddingDimensions"),
        "generativeLlmUsed": False,
        "fixedConfiguration": {
            "pcaDimensions": FIXED_DIMENSIONS,
            "ridgeAlpha": FIXED_ALPHA,
            "folds": 5,
            "selection": "none; one predeclared configuration for every target",
        },
        "targets": TARGETS,
        "hookModels": hook_models,
        "componentModels": component_models,
        "curveModel": entry_curve_model,
        "observedAbsoluteCurveModel": curve_model,
        "survivalModel": survival_model,
        "localAttributionCalibration": attribution_calibration,
        "longTitlePrior": long_title_prior,
        "longTitleTransfer": long_title_transfer,
        "entryNormalizedCurveModel": entry_curve_model,
        "rewatchAdjustedCurveModel": adjusted_curve_model,
        "semanticProjection": partition_model.get("browseProjection"),
        "rewatchAudit": rewatch_audit,
        "speakingRate": rate,
        "responseLagSeconds": response_lag,
        "responseLagContract": response_lag_contract,
        "deconfoundingAudit": forward_summary.get("deconfoundingAudit"),
    }
    summary = {
        "version": 2,
        "status": "complete",
        "stage": "held-out hook outcome maps and within-hook retention forecast",
        "methodVersion": METHOD_VERSION,
        "targets": TARGETS,
        "hookModels": {
            name: {"validation": row["validation"]}
            for name, row in hook_models.items()
        },
        "componentModels": {
            name: {
                "validationByCategory": row["validationByCategory"],
                "sourceAggregateValidation": row["sourceAggregateValidation"],
            } for name, row in component_models.items()
        },
        "survivalModel": {
            "validation": survival_validation,
            "targetContract": survival_model["targetContract"],
            "lengthBaseline": length_baseline,
            "normalizationSensitivity": normalization_sensitivity,
            "scoreScale": survival_model["scoreScale"],
        },
        "localAttributionCalibration": {
            "method": attribution_calibration["method"],
            "claimBoundary": attribution_calibration["claimBoundary"],
            "componentCalibrationCounts": {
                metric: {
                    category: len(values)
                    for category, values in rows.items()
                }
                for metric, rows in attribution_calibration[
                    "componentsByCategory"
                ].items()
            },
            "pairCalibrationCounts": {
                metric: {
                    pair: len(values) for pair, values in rows.items()
                }
                for metric, rows in attribution_calibration[
                    "pairsByCategorySequence"
                ].items()
            },
        },
        "longTitleTransfer": long_title_transfer,
        "curveModel": {
            "progressFractions": CURVE_PROGRESS,
            "validation": entry_curve_metrics,
            "primaryNormalization": "entry-indexed",
            "entryIndexedValidation": entry_curve_metrics,
            "observedAbsoluteValidation": curve_metrics,
            "rewatchAdjustedValidation": adjusted_curve_metrics,
            "speakingRate": rate,
            "responseLagSeconds": response_lag,
            "responseLagContract": response_lag_contract,
            "definition": (
                "The complete-hook embedding predicts three explicitly separated curves at 41 "
                "positions between the first and last analyzed hook word: future-free entry-indexed "
                "retention (primary), observed absolute retention, and terminal-conditioned replay "
                "sensitivity. No output exists after the analyzed hook endpoint. Text-only inputs "
                "cannot be retrospectively replay-normalized."
            ),
            "formula": FORECAST_FORMULA,
        },
        "semanticProjection": partition_model.get("browseProjection"),
        "semanticTraceValidation": (partition_artifact.get("validation") or {}).get(
            "semanticTrace"
        ),
        "wordEmbeddingAtlas": word_atlas,
        "fullHookEmbeddingAtlas": full_hook_atlas,
        "rewatchAudit": rewatch_audit,
        "deconfoundingAudit": forward_summary.get("deconfoundingAudit"),
        "hooks": hooks,
        "audit": {
            "hooks": len(hooks),
            "components": len(components),
            "relationships": relationship_total,
            "outcomeTargets": len(TARGETS),
            "curvePointsPerHook": len(CURVE_PROGRESS),
            "wordEmbeddingPoints": len(word_atlas["points"]),
            "fullHookEmbeddingPoints": len(full_hook_atlas["points"]),
            "minimumSourceDurationSeconds": float(np.min(durations)),
            "minimumAnalyzedHookSeconds": float(np.min(response_end)),
            "maximumAnalyzedHookSeconds": float(np.max(response_end)),
            "postHookOutputPoints": 0,
            "exactTimedHooks": rate["exactTimedHooks"],
            "componentCoverageFailures": sum(
                int(row.get("coverage", 0) != 1 or row.get("overlapCount", 0) != 0)
                for row in partitions
            ),
            "elapsedSeconds": round(time.time() - started, 3),
        },
    }
    atomic_json(MODEL_PATH, model)
    atomic_json(OUTPUT_PATH, summary)
    if not args.no_upload:
        remote = R2Store()
        remote.put_json(f"{R2_PREFIX}/hook-outcomes.json.gz", summary, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/hook-outcome-model.json.gz", model, gzip_payload=True)
    print(json.dumps(json_ready({
        "status": summary["status"],
        "hookValidation": {
            key: value["validation"] for key, value in hook_models.items()
        },
        "componentValidation": {
            key: value["sourceAggregateValidation"]
            for key, value in component_models.items()
        },
        "curveValidation": curve_metrics,
        "rewatchAdjustedCurveValidation": adjusted_curve_metrics,
        "survivalValidation": survival_validation,
        "rewatchAudit": rewatch_audit,
        "speakingRate": rate,
        "audit": summary["audit"],
    }), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
