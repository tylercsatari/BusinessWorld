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
    crossfit_linear,
    curve_validation,
    fit_full_linear,
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
METHOD_VERSION = "hook-outcome-and-retention-forecast-v1"
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
    curve_low = curve_crossfit["prediction"] + np.asarray(
        curve_metrics["residualP10ByTime"], np.float32,
    )
    curve_high = curve_crossfit["prediction"] + np.asarray(
        curve_metrics["residualP90ByTime"], np.float32,
    )

    quality_points = {
        str(row["videoId"]): row for row in (quality.get("axis") or {}).get("points") or []
    }
    quality_components = {
        (str(row["videoId"]), int(row["component"])): row
        for row in quality.get("components") or []
    }
    quality_relations = {}
    for point in (quality.get("axis") or {}).get("points") or []:
        for relation in point.get("pairInteractions") or []:
            quality_relations[(
                str(point["videoId"]), int(relation["left"]), int(relation["right"]),
            )] = relation

    components = []
    for index, base in enumerate(component_base):
        quality_row = quality_components.get((str(base["videoId"]), int(base["component"]))) or {}
        row = {
            **base,
            "broadRetainedInformation": {
                "shapley": quality_row.get("shapley"),
                "percentile": quality_row.get("categoryPercentile"),
                "singletonAxisCoordinate": quality_row.get("singletonAxisCoordinate"),
                "deletionEffect": quality_row.get("deletionEffect"),
            },
            "forwardResponse": quality_row.get("forwardResponse"),
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
            "outcomes": hook_outcomes,
            "componentOffset": source_index * 4,
            "componentCount": 4,
            "components": components[source_index * 4:source_index * 4 + 4],
            "relationships": [
                {
                    **(quality_relations.get((video_id, left, right)) or {}),
                    "left": left,
                    "right": right,
                }
                for left in range(4) for right in range(left + 1, 4)
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
                "sourceMAEPercentagePoints": float(np.mean(np.abs(
                    prediction_curve - curve_target[source_index]
                ))),
                "baselineMAEPercentagePoints": float(np.mean(np.abs(
                    curve_crossfit["baselinePrediction"][source_index]
                    - curve_target[source_index]
                ))),
                "wordTimingPolicy": (
                    "exact captions" if (timings.get(video_id) or {}).get("status") == "exact"
                    else "library-average speaking rate"
                ),
                "words": words,
                "componentWindows": component_response_windows(words, 4, response_lag),
            },
        })

    model = {
        "version": 1,
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
        "speakingRate": rate,
        "responseLagSeconds": response_lag,
    }
    summary = {
        "version": 1,
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
        "curveModel": {
            "timesSeconds": CURVE_TIMES,
            "validation": curve_metrics,
            "speakingRate": rate,
            "responseLagSeconds": response_lag,
            "definition": (
                "complete-hook embedding predicts absolute retention at 0.5-second steps; "
                "word response markers use the source-equal mean speaking rate and the validated forward lag"
            ),
        },
        "hooks": hooks,
        "audit": {
            "hooks": len(hooks),
            "components": len(components),
            "relationships": len(hooks) * 6,
            "outcomeTargets": len(TARGETS),
            "curvePointsPerHook": len(CURVE_TIMES),
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
        "speakingRate": rate,
        "audit": summary["audit"],
    }), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
