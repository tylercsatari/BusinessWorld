#!/usr/bin/env python3
"""Fit, validate, and publish complete-hook and canonical-component outcomes."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np

from axes import bh_fdr
from cluster_outcomes import (
    exact_token_timings,
    normalized_caption_atom,
    retention_at,
    span_interval,
)
from embedding_store import R2_PREFIX, R2Store, json_ready
from hook_outcomes import (
    FIXED_ALPHA,
    FIXED_DIMENSIONS,
    OUTCOME_SEED,
    apply_duration_baseline,
    apply_rewatch_kernel,
    correlation_audit,
    crossfit_linear,
    curve_validation,
    fit_duration_baseline,
    fit_full_linear,
    fit_rewatch_kernel,
    nested_survival_crossfit,
    per_second_survival,
    response_end_values,
    scalar_validation,
)
from hook_score_core import (
    combined_component_features,
    component_response_windows,
    estimated_token_timeline,
    interpolate_series,
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
METHOD_VERSION = "variable-component-hook-outcome-and-retention-forecast-v3"
CURVE_TIMES = np.arange(0.0, 20.0001, .5, dtype=np.float32)

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
        if end + response_lag > float(CURVE_TIMES[-1]):
            raise RuntimeError(f"hook response extends beyond the 20-second model: {video_id}")
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
                             mean_wps: float, response_lag: float) -> list[dict]:
    tokens = partition.get("tokens") or []
    owners = np.asarray([int(row["owner"]) for row in tokens], int)
    if timing.get("status") != "exact":
        rows = estimated_token_timeline(
            tokens, owners, CURVE_TIMES, predicted_curve, mean_wps,
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
                CURVE_TIMES, predicted_curve, response_second,
            ),
            "predictedRetentionP10": interpolate_series(
                CURVE_TIMES, lower, response_second,
            ),
            "predictedRetentionP90": interpolate_series(
                CURVE_TIMES, upper, response_second,
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
    partitions = read_json(CACHE / "canonical-partitions.json")["rows"]
    quality = read_json(CACHE / "hook-quality.json")
    if [str(row["id"]) for row in corpus] != [str(row["videoId"]) for row in partitions]:
        raise RuntimeError("Promise Lab corpus and canonical partitions differ")

    full_features = row_unit(np.asarray(
        np.load(CACHE / "all-span-vectors" / "full.npy", mmap_mode="r"),
        np.float32,
    ))
    raw_components, influence_components, component_base = component_vector_rows(partitions)
    component_features = combined_component_features(
        raw_components, influence_components,
    )
    source_indices = np.asarray([row["sourceIndex"] for row in component_base], int)
    categories = np.asarray([row["category"] for row in component_base], int)
    groups = np.asarray([row["videoId"] for row in component_base]).astype(str)
    hook_groups = np.asarray([str(row["id"]) for row in corpus])
    targets = outcome_targets(corpus)

    hook_models = {}
    hook_values = {}
    hook_pvalues = []
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
        validation["foldDirectionMedianCosine"] = crossfit["foldDirectionMedianCosine"]
        validation["foldDirectionPositiveFraction"] = crossfit["foldDirectionPositiveFraction"]
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
    for target_name, q in zip(targets, bh_fdr(hook_pvalues)):
        validation = hook_models[target_name]["validation"]
        validation["familyQ"] = q
        validation["status"] = (
            "validated" if q <= .05 and validation["heldoutSpearman"] > 0
            and validation["maeImprovementFraction"] > 0 else "diagnostic-not-validated"
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
        aggregate["status"] = (
            "validated" if q <= .05 and aggregate["heldoutSpearman"] > 0
            and aggregate["maeImprovementFraction"] > 0 else "diagnostic-not-validated"
        )
    category_q = bh_fdr([
        row["rankInference"]["p"] for _, _, row in category_validation_refs
    ])
    for (target_name, category, validation), q in zip(
        category_validation_refs, category_q
    ):
        validation["familyQ"] = q
        validation["status"] = (
            "validated" if q <= .05 and validation["heldoutSpearman"] > 0
            and validation["maeImprovementFraction"] > 0 else "diagnostic-not-validated"
        )
        component_models[target_name]["modelsByCategory"][category][
            "validation"
        ] = validation

    curve_target = np.asarray([
        [
            retention_at(
                row.get("curve") or [], float(row.get("duration_s") or np.nan),
                float(second),
            ) * 100 for second in CURVE_TIMES
        ] for row in corpus
    ], np.float32)
    curve_crossfit = crossfit_linear(
        full_features, curve_target, groups=None,
        seed=OUTCOME_SEED + 7001,
    )
    curve_metrics = curve_validation(
        curve_crossfit["prediction"], curve_target,
        curve_crossfit["baselinePrediction"], CURVE_TIMES,
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 7002,
    )
    curve_metrics["status"] = (
        "validated-rough-forecast"
        if curve_metrics["maeImprovementFraction"] > 0
        and curve_metrics["pairedImprovementInference"]["p"] <= .05
        and curve_metrics["pairedImprovementInference"]["ciLow"] > 0
        else "diagnostic-not-validated"
    )
    curve_fitted = fit_full_linear(
        full_features, curve_target, include_map=False,
        seed=OUTCOME_SEED + 7001,
    )
    curve_model = {
        "coefficient": np.round(curve_fitted["coefficient"], 8),
        "intercept": np.round(curve_fitted["intercept"], 8),
        "timesSeconds": CURVE_TIMES,
        "residualP10ByTime": curve_metrics["residualP10ByTime"],
        "residualP90ByTime": curve_metrics["residualP90ByTime"],
        "validation": curve_metrics,
    }

    timing_records = load_timing_records(manifest["hooks"], args.timing_workers)
    rate, timings = speaking_rate(manifest["hooks"], timing_records)
    response_lag = float(
        ((quality.get("forwardResponse") or {}).get("metricContract") or {}).get(
            "selectedLagSeconds", 1.0,
        )
    )
    spoken_end, response_end = hook_time_windows(
        partitions, timings, rate["meanWordsPerSecond"], response_lag,
    )
    durations = np.asarray([
        float(row.get("duration_s") or np.nan) for row in corpus
    ], np.float32)
    terminal = np.asarray([
        terminal_retention_percent(row) for row in corpus
    ], np.float32)
    nested_survival = nested_survival_crossfit(
        full_features, curve_target, terminal, durations, response_end,
        CURVE_TIMES, seed=OUTCOME_SEED + 9001,
    )
    survival_validation = scalar_validation(
        nested_survival["scorePrediction"], nested_survival["scoreTarget"],
        nested_survival["scoreBaseline"], repeats=args.inference_repeats,
        seed=OUTCOME_SEED + 9002,
    )
    survival_validation.update({
        "foldDirectionMedianCosine": nested_survival["foldDirectionMedianCosine"],
        "foldDirectionPositiveFraction": nested_survival["foldDirectionPositiveFraction"],
        "familyQ": survival_validation["rankInference"]["p"],
    })
    survival_validation["status"] = (
        "validated" if survival_validation["heldoutSpearman"] > 0
        and survival_validation["maeImprovementFraction"] > 0
        and survival_validation["rankInference"]["p"] <= .05
        else "diagnostic-not-validated"
    )
    adjusted_curve_metrics = curve_validation(
        nested_survival["curvePrediction"], nested_survival["curveTarget"],
        nested_survival["curveBaseline"], CURVE_TIMES,
        repeats=args.inference_repeats, seed=OUTCOME_SEED + 9003,
    )
    adjusted_curve_metrics["status"] = (
        "validated-rough-forecast"
        if adjusted_curve_metrics["maeImprovementFraction"] > 0
        and adjusted_curve_metrics["pairedImprovementInference"]["p"] <= .05
        and adjusted_curve_metrics["pairedImprovementInference"]["ciLow"] > 0
        else "diagnostic-not-validated"
    )

    normalization = fit_rewatch_kernel(
        curve_target, terminal, durations, CURVE_TIMES,
    )
    adjusted_curve_target = apply_rewatch_kernel(
        curve_target, normalization["kernel"],
    )
    adjusted_end = response_end_values(
        adjusted_curve_target, CURVE_TIMES, response_end,
    )
    carry_rate = per_second_survival(adjusted_end, response_end)
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
        "trainingOOFPredictionSorted": np.sort(nested_survival["scorePrediction"]),
        "targetContract": {
            "label": "Length-adjusted hook survival",
            "unit": "excess geometric retention carry percentage points per second",
            "higherMeans": (
                "the hook loses less rewatch-adjusted retention than the ordinary "
                "drop for a hook with the same response duration"
            ),
            "formula": (
                "100 * exp(log(R_adjusted(response_end) / 100) / response_end) "
                "minus the out-of-fold duration-only expected carry rate"
            ),
            "responseEnd": "exact spoken hook end plus the validated forward response lag",
        },
    })
    adjusted_curve_fitted = fit_full_linear(
        full_features, adjusted_curve_target, include_map=False,
        seed=OUTCOME_SEED + 9004,
    )
    adjusted_curve_model = {
        "coefficient": np.round(adjusted_curve_fitted["coefficient"], 8),
        "intercept": np.round(adjusted_curve_fitted["intercept"], 8),
        "timesSeconds": CURVE_TIMES,
        "residualP10ByTime": adjusted_curve_metrics["residualP10ByTime"],
        "residualP90ByTime": adjusted_curve_metrics["residualP90ByTime"],
        "validation": adjusted_curve_metrics,
        "normalization": normalization,
    }
    entry_inflation = curve_target[:, 0] - 100.0
    opening_half_second = curve_target[:, 1] - curve_target[:, 0]
    opening_three_seconds = (
        curve_target[:, int(round(3.0 / .5))] - curve_target[:, 0]
    ) / 3.0
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
        "normalization": normalization,
        "foldKernelP10": np.quantile(nested_survival["foldKernels"], .1, axis=0),
        "foldKernelP90": np.quantile(nested_survival["foldKernels"], .9, axis=0),
        "scope": {
            "videos": len(corpus),
            "minimumVideoDurationSeconds": float(np.min(durations)),
            "videosShorterThan20Seconds": int(np.sum(durations < 20.0)),
            "medianSpokenHookEndSeconds": float(np.median(spoken_end)),
            "maximumSpokenHookEndSeconds": float(np.max(spoken_end)),
            "medianResponseEndSeconds": float(np.median(response_end)),
            "maximumResponseEndSeconds": float(np.max(response_end)),
        },
        "claimBoundary": (
            "This is an empirical de-inflation index, not identified first-pass retention. "
            "The observed absolute curve remains available beside it."
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
    adjusted_curve_low[:, 0] = 100.0
    adjusted_curve_high[:, 0] = 100.0

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

    components = []
    for index, base in enumerate(component_base):
        quality_row = quality_components.get((str(base["videoId"]), int(base["component"]))) or {}
        forward_row = dict(quality_row.get("forwardResponse") or {})
        if forward_row:
            forward_row["heldoutSpearmanForCategory"] = forward_category_rho.get(
                str(int(base["category"]))
            )
            forward_row["percentileBasis"] = (
                "predicted unexpected endpoint-normalized slope among training components "
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
        actual_curve = np.asarray(corpus_row.get("curve") or [], float)
        duration = float(corpus_row.get("duration_s") or np.nan)
        words = exact_or_estimated_words(
            partition, timings.get(video_id) or {}, actual_curve, prediction_curve,
            lower_curve, upper_curve, duration, rate["meanWordsPerSecond"],
            response_lag,
        )
        adjusted_prediction_curve = np.asarray(
            nested_survival["curvePrediction"][source_index], float,
        )
        adjusted_actual_curve = np.asarray(
            nested_survival["curveTarget"][source_index], float,
        )
        adjusted_lower_curve = np.asarray(adjusted_curve_low[source_index], float)
        adjusted_upper_curve = np.asarray(adjusted_curve_high[source_index], float)
        for word in words:
            second = float(word["responseSeconds"])
            word["observedAbsolutePredictedRetentionPercent"] = word[
                "predictedRetentionPercent"
            ]
            word["observedAbsoluteActualRetentionPercent"] = word.get(
                "actualRetentionPercent"
            )
            word["predictedRetentionPercent"] = interpolate_series(
                CURVE_TIMES, adjusted_prediction_curve, second,
            )
            word["predictedRetentionP10"] = interpolate_series(
                CURVE_TIMES, adjusted_lower_curve, second,
            )
            word["predictedRetentionP90"] = interpolate_series(
                CURVE_TIMES, adjusted_upper_curve, second,
            )
            word["actualRetentionPercent"] = interpolate_series(
                CURVE_TIMES, adjusted_actual_curve, second,
            )
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
        survival_prediction = float(nested_survival["scorePrediction"][source_index])
        survival_actual = float(nested_survival["scoreTarget"][source_index])
        survival_expected = float(
            nested_survival["expectedCarryPercentPerSecond"][source_index]
        )
        survival_carry = float(
            nested_survival["carryPercentPerSecond"][source_index]
        )
        survival_predicted_carry = survival_expected + survival_prediction
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
                "label": "Length-adjusted hook survival percentile",
                "percentile": percentile(
                    np.asarray(nested_survival["scorePrediction"], float),
                    survival_prediction,
                ),
                "actualPercentile": percentile(
                    np.asarray(nested_survival["scoreTarget"], float),
                    survival_actual,
                ),
                "predictedOOF": survival_prediction,
                "actual": survival_actual,
                "residual": survival_actual - survival_prediction,
                "predictionP10": survival_prediction + survival_validation["residualP10"],
                "predictionP90": survival_prediction + survival_validation["residualP90"],
                "mapX": float(survival_x[source_index]),
                "mapY": float(survival_y[source_index]),
                "fold": int(nested_survival["foldIndex"][source_index]),
                "validationStatus": survival_validation["status"],
                "responseEndSeconds": float(response_end[source_index]),
                "spokenHookEndSeconds": float(spoken_end[source_index]),
                "actualCarryPercentPerSecond": survival_carry,
                "expectedCarryPercentPerSecond": survival_expected,
                "predictedCarryPercentPerSecond": survival_predicted_carry,
                "actualAdjustedRetentionAtResponseEnd": float(
                    100.0 * (survival_carry / 100.0) ** response_end[source_index]
                ),
                "predictedAdjustedRetentionAtResponseEnd": float(
                    100.0 * (max(survival_predicted_carry, 1e-4) / 100.0)
                    ** response_end[source_index]
                ),
                "higherMeans": survival_model["targetContract"]["higherMeans"],
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
                }
                for left in range(component_count)
                for right in range(left + 1, component_count)
            ],
            "retentionForecast": {
                "timesSeconds": CURVE_TIMES,
                "actualPercent": np.asarray([
                    retention_at(actual_curve, duration, float(second)) * 100
                    for second in CURVE_TIMES
                ], np.float32),
                "predictedOOFPercent": prediction_curve,
                "predictionP10": lower_curve,
                "predictionP90": upper_curve,
                "rewatchAdjustedActualPercent": adjusted_actual_curve,
                "rewatchAdjustedPredictedOOFPercent": adjusted_prediction_curve,
                "rewatchAdjustedPredictionP10": adjusted_lower_curve,
                "rewatchAdjustedPredictionP90": adjusted_upper_curve,
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
                "spokenHookEndSeconds": float(spoken_end[source_index]),
                "responseEndSeconds": float(response_end[source_index]),
                "postHookForecastStartSeconds": float(response_end[source_index]),
                "forecastEndSeconds": float(CURVE_TIMES[-1]),
                "forecastScope": (
                    "word and component attribution ends at responseEndSeconds; later points are "
                    "a whole-hook text forecast without additional word/category attribution"
                ),
                "wordTimingPolicy": (
                    "exact captions" if (timings.get(video_id) or {}).get("status") == "exact"
                    else "library-average speaking rate"
                ),
                "words": words,
                "componentWindows": component_response_windows(words, 4, response_lag),
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
        "curveModel": curve_model,
        "survivalModel": survival_model,
        "rewatchAdjustedCurveModel": adjusted_curve_model,
        "rewatchAudit": rewatch_audit,
        "speakingRate": rate,
        "responseLagSeconds": response_lag,
    }
    summary = {
        "version": 2,
        "status": "complete",
        "stage": "held-out hook outcome maps and first-seconds retention forecast",
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
        },
        "curveModel": {
            "timesSeconds": CURVE_TIMES,
            "validation": curve_metrics,
            "rewatchAdjustedValidation": adjusted_curve_metrics,
            "speakingRate": rate,
            "responseLagSeconds": response_lag,
            "definition": (
                "The complete-hook embedding predicts both observed absolute retention and a "
                "rewatch-adjusted curve at 0.5-second steps. Word/category attribution ends at "
                "the exact spoken hook plus the validated forward lag; later points are only a "
                "whole-hook continuation forecast."
            ),
        },
        "rewatchAudit": rewatch_audit,
        "hooks": hooks,
        "audit": {
            "hooks": len(hooks),
            "components": len(components),
            "relationships": relationship_total,
            "outcomeTargets": len(TARGETS),
            "curvePointsPerHook": len(CURVE_TIMES),
            "forecastEndSeconds": float(CURVE_TIMES[-1]),
            "minimumSourceDurationSeconds": float(np.min(durations)),
            "sourcesShorterThanForecast": int(np.sum(durations < CURVE_TIMES[-1])),
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
