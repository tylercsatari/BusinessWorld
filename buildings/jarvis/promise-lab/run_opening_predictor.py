#!/usr/bin/env python3
"""Fit the causal, shared 20-second Shorts opening-retention predictor."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
from pathlib import Path

import numpy as np

from embedding_store import EmbeddingStore, R2_PREFIX, R2Store, json_ready
from hook_outcomes import (
    crossfit_linear,
    curve_validation,
    fit_full_linear,
    forward_chain_linear,
    scalar_validation,
)
from opening_predictor import (
    FEATURE_VERSION,
    PREDICTOR_VERSION,
    apply_scalar_stage,
    build_feature_stages,
    views_from_retention5,
)
from sequence import normalize_source


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
SUMMARY_PATH = CACHE / "opening-20s.json"
DETAILS = CACHE / "opening-20s"
VECTORS = CACHE / "opening-20s-vectors"
PREFIX_CACHE = CACHE / "opening-prefix-embeddings.sqlite3"
OUTPUT = CACHE / "opening-predictions.json"
MODEL_OUTPUT = CACHE / "opening-retention-model.json"
PREDICTION_DETAILS = CACHE / "opening-predictions"
RETENTION_STUDY = HERE.parent / "retention-study" / "retention_study.json"
MODEL_SECONDS = np.arange(0.0, 20.0001, 1.0, dtype=np.float32)
R5_INDEX = 5
R20_INDEX = 20
MODEL_DIMENSIONS = 16
RIDGE_ALPHA = 10.0
SEED = 20260714
STAGES = ("semantic", "components", "relationships")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def write_gzip(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as handle:
        json.dump(json_ready(value), handle, separators=(",", ":"),
                  ensure_ascii=False, allow_nan=False)
    os.replace(temporary, path)


def sample_curve(detail: dict, name: str) -> np.ndarray:
    retention = detail["retention"]
    times = np.asarray(retention["timesSeconds"], float)
    values = np.asarray(retention["curvesPercent"][name], float)
    if len(times) != len(values) or float(times[-1]) < 20.0 - 1e-6:
        raise ValueError(f"{detail['videoId']} does not contain a measured 20-second curve")
    return np.interp(MODEL_SECONDS, times, values).astype(np.float32)


def compact_model(value: dict) -> dict:
    coefficient = np.asarray(value["coefficient"], np.float32)
    if coefficient.ndim == 2 and coefficient.shape[1] == 1:
        coefficient = coefficient[:, 0]
    intercept = np.asarray(value["intercept"], np.float32).reshape(-1)
    return {
        "coefficient": coefficient,
        "intercept": float(intercept[0]) if len(intercept) == 1 else intercept,
    }


def compact_scalar_validation(value: dict) -> dict:
    omitted = {"predictionOOF", "targetObserved", "baselineOOF"}
    return {key: row for key, row in value.items() if key not in omitted}


def compact_curve_validation(value: dict) -> dict:
    omitted = {
        "predictionOOF", "targetObserved", "baselineOOF",
        "modelMAEByTimePercentagePoints", "baselineMAEByTimePercentagePoints",
    }
    return {key: row for key, row in value.items() if key not in omitted}


def lexical_token(token: dict) -> bool:
    return any(character.isalnum() or character == "_" for character in str(token.get("text") or ""))


def acoustic_prefixes(detail: dict) -> tuple[list[dict], float]:
    """Return the exact transcript visible at each second on the measured media clock."""
    text = normalize_source(detail.get("text") or "")
    tokens = list(detail.get("tokens") or [])
    if not tokens:
        raise ValueError(f"{detail.get('videoId')} has no timed opening tokens")
    lexical = [row for row in tokens if lexical_token(row)]
    if not lexical:
        raise ValueError(f"{detail.get('videoId')} has no lexical opening tokens")
    first_start = float(lexical[0]["spokenStartSeconds"])
    last_end = float(lexical[-1]["spokenEndSeconds"])
    acoustic_span = max(1e-6, last_end - first_start)
    rate = len(lexical) / acoustic_span
    rows = []
    for second in range(1, 21):
        completed = [
            index for index, token in enumerate(tokens)
            if float(token.get("spokenEndSeconds") or 0.0) <= second + 1e-6
        ]
        # A prefix model always receives at least one completed acoustic atom. In the
        # measured corpus the first atom completes before one second; this fallback is
        # retained only so a malformed source fails visibly rather than producing an
        # empty embedding request.
        token_end = (completed[-1] + 1) if completed else 1
        character_end = int(tokens[token_end - 1]["end"])
        prefix_text = normalize_source(text[:character_end])
        rows.append({
            "second": float(second),
            "prefixText": prefix_text,
            "endToken": int(token_end),
            "tokenCount": int(token_end),
            "lastSpokenEndSeconds": float(tokens[token_end - 1]["spokenEndSeconds"]),
            "usesWordsAfterThisSecond": False,
        })
    return rows, float(rate)


def fold_local_zero_baseline(target: np.ndarray, crossfit: dict) -> np.ndarray:
    output = np.full(len(target), np.nan, np.float32)
    fold_index = np.asarray(crossfit["foldIndex"], int)
    for fold, model in enumerate(crossfit["foldModels"]):
        output[fold_index == fold] = float(np.mean(target[np.asarray(model["rows"], int)]))
    return output


def fit_temporal_family(prefix_tensor: np.ndarray, target: np.ndarray,
                        chronology: np.ndarray, seed: int) -> dict:
    """Fit one independent scalar predictor at each second from that second's prefix."""
    count = len(target)
    prediction = np.full((count, len(MODEL_SECONDS)), np.nan, np.float32)
    baseline = np.full_like(prediction, np.nan)
    chronological_prediction = np.full_like(prediction, np.nan)
    chronological_baseline = np.full_like(prediction, np.nan)
    temporal_models = []
    first_crossfit = None
    first_chronological = None
    for second in range(1, 21):
        features = prefix_tensor[:, second - 1, :]
        values = target[:, second]
        crossfit = crossfit_linear(
            features, values, folds=5, dimensions=MODEL_DIMENSIONS,
            alpha=RIDGE_ALPHA, seed=seed,
        )
        chronological = forward_chain_linear(
            features, values, chronology, dimensions=MODEL_DIMENSIONS,
            alpha=RIDGE_ALPHA, seed=seed,
        )
        validation = scalar_validation(
            crossfit["prediction"], values, crossfit["baselinePrediction"],
            repeats=512, seed=seed + second * 1009,
        )
        chronological_validation = scalar_validation(
            chronological["prediction"], values, chronological["baselinePrediction"],
            repeats=512, seed=seed + second * 2003,
        )
        full = fit_full_linear(
            features, values, dimensions=MODEL_DIMENSIONS,
            alpha=RIDGE_ALPHA, seed=seed,
        )
        prediction[:, second] = np.asarray(crossfit["prediction"], np.float32)
        baseline[:, second] = np.asarray(crossfit["baselinePrediction"], np.float32)
        chronological_prediction[:, second] = np.asarray(
            chronological["prediction"], np.float32,
        )
        chronological_baseline[:, second] = np.asarray(
            chronological["baselinePrediction"], np.float32,
        )
        if first_crossfit is None:
            first_crossfit = crossfit
            first_chronological = chronological
        temporal_models.append({
            "second": float(second),
            "prefixOnly": True,
            "usesFutureWords": False,
            "model": compact_model(full),
            "baselineMean": float(np.mean(values)),
            "randomFoldValidation": compact_scalar_validation(validation),
            "chronologicalValidation": compact_scalar_validation(chronological_validation),
        })

    if np.allclose(target[:, 0], 100.0, atol=1e-5):
        prediction[:, 0] = 100.0
        baseline[:, 0] = 100.0
        chronological_prediction[:, 0] = 100.0
        chronological_baseline[:, 0] = 100.0
        time_zero_mean = 100.0
    else:
        prediction[:, 0] = fold_local_zero_baseline(target[:, 0], first_crossfit)
        baseline[:, 0] = prediction[:, 0]
        chronological_prediction[:, 0] = np.asarray(
            first_chronological["baselinePrediction"], np.float32,
        )
        chronological_baseline[:, 0] = chronological_prediction[:, 0]
        time_zero_mean = float(np.mean(target[:, 0]))

    validation = curve_validation(
        prediction, target, baseline, MODEL_SECONDS / 20.0,
        repeats=1024, seed=seed + 70001,
    )
    chronological_validation = curve_validation(
        chronological_prediction, target, chronological_baseline,
        MODEL_SECONDS / 20.0, repeats=1024, seed=seed + 80001,
    )
    residual = target - prediction
    return {
        "prediction": prediction,
        "baseline": baseline,
        "chronologicalPrediction": chronological_prediction,
        "chronologicalBaseline": chronological_baseline,
        "timeZeroMean": time_zero_mean,
        "temporalModels": temporal_models,
        "residualP10": np.nanquantile(residual, .1, axis=0).astype(np.float32),
        "residualP90": np.nanquantile(residual, .9, axis=0).astype(np.float32),
        "validation": validation,
        "chronologicalValidation": chronological_validation,
    }


def fit_endpoint_candidates(features: dict[str, np.ndarray], target: np.ndarray,
                            seed: int) -> dict:
    """Audit nested whole-opening channels at 20s without promoting them."""
    stages = {}
    for offset, name in enumerate(STAGES):
        crossfit = crossfit_linear(
            features[name], target, folds=5, dimensions=MODEL_DIMENSIONS,
            alpha=RIDGE_ALPHA, seed=seed,
        )
        validation = scalar_validation(
            crossfit["prediction"], target, crossfit["baselinePrediction"],
            repeats=1024, seed=seed + offset * 1009,
        )
        full = fit_full_linear(
            features[name], target, dimensions=MODEL_DIMENSIONS,
            alpha=RIDGE_ALPHA, seed=seed,
        )
        stages[name] = {
            "crossfit": crossfit,
            "validation": validation,
            "fullModel": compact_model(full),
        }
    return {
        "targetSecond": 20.0,
        "stages": stages,
        "promotedStage": None,
        "promotionReason": (
            "The component and relationship channels were not causally available at earlier "
            "seconds and did not beat the prefix-semantic curve robustly enough to enter the "
            "headline. They remain visible endpoint counterfactual diagnostics."
        ),
    }


def build_views_contract() -> dict:
    study = load_json(RETENTION_STUDY)
    retained = study["predictor"]["subsets"]["ret5"]
    return {
        "version": "shorts-quant-ret5-only-transfer-v2",
        "coefficient": float(retained["coef"][0]),
        "intercept": float(retained["intercept"]),
        "residualSdLog10": float(retained["resid_sd_log10"]),
        "crossValidatedR2": float(retained["cv_r2"]),
        "central80Z": 1.2815515655446004,
        "retentionInput": "absolute retention-curve percentage at 5 seconds",
        "source": "Shorts Quant retention_study.json predictor.subsets.ret5",
        "formula": "log10(views) = intercept + coefficient * absolute retention at 5s",
        "status": "diagnostic transfer pending end-to-end temporal validation",
    }


def local_endpoint_impacts(record: dict, fold_models: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    components = record["components"]
    full_feature = record["features"]["relationships"]
    full_values = {
        name: apply_scalar_stage(full_feature, model)
        for name, model in fold_models.items()
    }
    component_rows = []
    if len(components) == 1:
        row = dict(components[0])
        row["predictionImpact"] = {
            "available": False,
            "appliedToHeadline": False,
            "reason": "deleting the only exact-cover component leaves no analyzable opening",
        }
        component_rows.append(row)
    else:
        for component in components:
            feature = build_feature_stages(
                record["full"], record["raw"], record["influence"], components,
                record["tokenCount"], removed_components=[int(component["index"])],
            )["relationships"]
            impact = {
                family: {
                    "retention20sPoints": float(
                        full_values[family] - apply_scalar_stage(feature, model)
                    ),
                }
                for family, model in fold_models.items()
            }
            row = dict(component)
            row["predictionImpact"] = {
                "available": True,
                "candidateStage": "relationships-at-20s",
                "appliedToHeadline": False,
                "definition": (
                    "candidate 20-second prediction(full exact cover) minus prediction after "
                    "deleting this component and recomputing the relationship features"
                ),
                **impact,
            }
            component_rows.append(row)

    relationship_rows = []
    for left, right in zip(components[:-1], components[1:]):
        edge = (int(left["index"]), int(right["index"]))
        feature = build_feature_stages(
            record["full"], record["raw"], record["influence"], components,
            record["tokenCount"], disabled_edges=[edge],
        )["relationships"]
        impact = {
            family: {
                "retention20sPoints": float(
                    full_values[family] - apply_scalar_stage(feature, model)
                ),
            }
            for family, model in fold_models.items()
        }
        relationship_rows.append({
            "left": edge[0],
            "right": edge[1],
            "leftCategory": int(left["category"]),
            "rightCategory": int(right["category"]),
            "predictionImpact": {
                "candidateStage": "relationships-at-20s",
                "appliedToHeadline": False,
                "definition": (
                    "candidate 20-second relationship prediction minus the prediction with "
                    "this adjacent edge disabled; component semantics stay present"
                ),
                **impact,
            },
        })
    return component_rows, relationship_rows


def semantic_contribution(baseline: np.ndarray, semantic: np.ndarray,
                          second: float) -> dict:
    base = float(np.interp(second, MODEL_SECONDS, baseline))
    value = float(np.interp(second, MODEL_SECONDS, semantic))
    return {
        "baselinePercent": base,
        "semanticDeltaPoints": value - base,
        "componentStructureDeltaPoints": None,
        "relationshipDeltaPoints": None,
        "selectedStage": "semanticPrefix",
        "finalPercent": value,
        "componentAndRelationshipCandidatesAvailable": False,
    }


def endpoint_contribution(temporal_baseline: np.ndarray, temporal_semantic: np.ndarray,
                          candidates: dict[str, float]) -> dict:
    base = float(temporal_baseline[R20_INDEX])
    semantic = float(temporal_semantic[R20_INDEX])
    component_delta = float(candidates["components"] - candidates["semantic"])
    relationship_delta = float(candidates["relationships"] - candidates["components"])
    return {
        "baselinePercent": base,
        "semanticDeltaPoints": semantic - base,
        "componentStructureDeltaPoints": component_delta,
        "relationshipDeltaPoints": relationship_delta,
        "semanticCandidatePercent": float(candidates["semantic"]),
        "componentsCandidatePercent": float(candidates["components"]),
        "relationshipCandidatePercent": float(candidates["relationships"]),
        "selectedStage": "semanticPrefix",
        "finalPercent": semantic,
        "componentAndRelationshipCandidatesAvailable": True,
        "componentAndRelationshipCandidatesApplied": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--upload-only", action="store_true")
    args = parser.parse_args()
    if args.upload_only:
        if args.no_upload:
            raise SystemExit("--upload-only cannot be combined with --no-upload")
        if not MODEL_OUTPUT.exists() or not OUTPUT.exists():
            raise SystemExit("verified predictor model and browser summary must exist before upload")
        model = load_json(MODEL_OUTPUT)
        browser = load_json(OUTPUT)
        rows = browser.get("rows") or []
        if not rows:
            raise SystemExit("opening-predictions.json has no rows")
        remote = R2Store()
        remote.put_json(f"{R2_PREFIX}/opening-retention-model.json.gz", model, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/opening-predictions.json.gz", browser, gzip_payload=True)
        for index, row in enumerate(rows, 1):
            path = PREDICTION_DETAILS / f"{row['videoId']}.json.gz"
            if not path.exists():
                raise SystemExit(f"missing prediction detail: {path.name}")
            remote.put_bytes(
                f"{R2_PREFIX}/opening-predictions/{row['videoId']}.json.gz",
                path.read_bytes(), "application/json", "gzip",
            )
            if index % 25 == 0 or index == len(rows):
                print(f"[upload {index}/{len(rows)}] {row['videoId']}", flush=True)
        print(json.dumps({"status": "uploaded", "sources": len(rows)}, indent=2))
        return
    summary = load_json(SUMMARY_PATH)
    rows = summary.get("rows") or []
    if not rows:
        raise SystemExit("opening-20s.json has no rows")

    records = []
    prefix_text_rows = []
    speaking_rates = []
    endpoint_features = {name: [] for name in STAGES}
    target_rows = {"entryIndexed": [], "observedAbsolute": []}
    chronology = []
    for row in rows:
        video_id = str(row["videoId"])
        detail = load_gzip(DETAILS / f"{video_id}.json.gz")
        prefixes, rate = acoustic_prefixes(detail)
        prefix_text_rows.append([value["prefixText"] for value in prefixes])
        speaking_rates.append(rate)
        with np.load(VECTORS / f"{video_id}.npz") as vectors:
            raw = np.asarray(vectors["raw"], np.float16).astype(np.float32)
            influence = np.asarray(vectors["influence"], np.float16).astype(np.float32)
            full = np.asarray(vectors["full"], np.float16).astype(np.float32)
        components = [dict(component) for component in detail["canonicalComponents"]]
        features = build_feature_stages(
            full, raw, influence, components, int(detail["tokenCount"]),
        )
        for name in STAGES:
            endpoint_features[name].append(features[name])
        target_rows["entryIndexed"].append(sample_curve(detail, "entry_indexed"))
        target_rows["observedAbsolute"].append(sample_curve(detail, "observed_absolute"))
        chronology.append(str((detail.get("sourceRecord") or {}).get("published") or video_id))
        records.append({
            "videoId": video_id,
            "summary": row,
            "detail": detail,
            "prefixes": prefixes,
            "components": components,
            "tokenCount": int(detail["tokenCount"]),
            "raw": raw,
            "influence": influence,
            "full": full,
            "features": features,
        })

    flat_prefixes = [text for rows_for_source in prefix_text_rows for text in rows_for_source]
    store = EmbeddingStore(PREFIX_CACHE, workers=8)
    try:
        embedded = store.embed_many(flat_prefixes)
    finally:
        store.close()
    prefix_tensor = np.asarray([
        [embedded[text] for text in rows_for_source]
        for rows_for_source in prefix_text_rows
    ], np.float32)
    endpoint_matrices = {
        name: np.asarray(values, np.float32)
        for name, values in endpoint_features.items()
    }
    targets = {
        name: np.asarray(values, np.float32)
        for name, values in target_rows.items()
    }
    chronology_values = np.asarray(chronology, str)
    fitted = {
        "entryIndexed": fit_temporal_family(
            prefix_tensor, targets["entryIndexed"], chronology_values, SEED,
        ),
        "observedAbsolute": fit_temporal_family(
            prefix_tensor, targets["observedAbsolute"], chronology_values, SEED + 101,
        ),
    }
    endpoint_candidates = {
        name: fit_endpoint_candidates(
            endpoint_matrices, target[:, R20_INDEX], SEED + 10001 + index * 1009,
        )
        for index, (name, target) in enumerate(targets.items())
    }

    views_contract = build_views_contract()
    predicted_ret5 = fitted["observedAbsolute"]["prediction"][:, R5_INDEX]
    chronological_ret5 = fitted["observedAbsolute"]["chronologicalPrediction"][:, R5_INDEX]
    baseline_ret5 = fitted["observedAbsolute"]["baseline"][:, R5_INDEX]
    chronological_baseline_ret5 = fitted["observedAbsolute"]["chronologicalBaseline"][:, R5_INDEX]
    actual_views = np.asarray([
        float((record["detail"].get("sourceRecord") or {}).get("views") or np.nan)
        for record in records
    ], float)
    actual_log_views = np.log10(actual_views)
    predicted_log_views = views_contract["intercept"] + views_contract["coefficient"] * predicted_ret5
    baseline_log_views = views_contract["intercept"] + views_contract["coefficient"] * baseline_ret5
    chronological_log_views = (
        views_contract["intercept"] + views_contract["coefficient"] * chronological_ret5
    )
    chronological_baseline_log_views = (
        views_contract["intercept"]
        + views_contract["coefficient"] * chronological_baseline_ret5
    )
    random_views_validation = scalar_validation(
        predicted_log_views, actual_log_views, baseline_log_views,
        repeats=2048, seed=SEED + 70001,
    )
    chronological_views_validation = scalar_validation(
        chronological_log_views, actual_log_views, chronological_baseline_log_views,
        repeats=2048, seed=SEED + 80001,
    )
    individualized_views_available = bool(
        float(random_views_validation["maeImprovementFraction"]) > 0
        and float(random_views_validation["heldoutR2"]) > 0
        and float(chronological_views_validation["maeImprovementFraction"]) > 0
        and float(chronological_views_validation["heldoutR2"]) > 0
    )
    view_residual = actual_log_views - predicted_log_views
    finite_view_residual = view_residual[np.isfinite(view_residual)]
    views_contract.update({
        "individualizedForecastAvailable": individualized_views_available,
        "promotionStatus": "available" if individualized_views_available else "withheld",
        "promotionGate": (
            "both random-fold and past-to-future log-view predictions must beat their "
            "fold-local baselines in MAE and R2"
        ),
        "stackResidualP10Log10": float(np.quantile(finite_view_residual, .1)),
        "stackResidualP90Log10": float(np.quantile(finite_view_residual, .9)),
        "randomFoldValidation": compact_scalar_validation(random_views_validation),
        "chronologicalValidation": compact_scalar_validation(chronological_views_validation),
        "caveat": (
            "The text-to-R5 leg is out of fold, but the transferred Shorts R5-to-views "
            "coefficient was estimated on overlapping channel observations. The range is a "
            "scenario diagnostic, not a calibrated individualized views forecast."
        ),
    })

    model_families = {}
    for family_name, family in fitted.items():
        model_families[family_name] = {
            "selectedStage": "semanticPrefix",
            "timeZeroMean": family["timeZeroMean"],
            "temporalModels": family["temporalModels"],
            "residualP10": family["residualP10"],
            "residualP90": family["residualP90"],
            "randomFoldValidation": compact_curve_validation(family["validation"]),
            "chronologicalValidation": compact_curve_validation(
                family["chronologicalValidation"]
            ),
        }
    endpoint_model_payload = {
        family_name: {
            "targetSecond": 20.0,
            "promotedStage": None,
            "promotionReason": family["promotionReason"],
            "stages": {
                stage_name: {
                    "model": stage["fullModel"],
                    "validation": compact_scalar_validation(stage["validation"]),
                }
                for stage_name, stage in family["stages"].items()
            },
        }
        for family_name, family in endpoint_candidates.items()
    }
    token_counts = np.asarray([record["tokenCount"] for record in records], int)
    speaking_rates_array = np.asarray(speaking_rates, float)
    model = {
        "version": 2,
        "status": "complete",
        "predictorVersion": PREDICTOR_VERSION,
        "featureVersion": FEATURE_VERSION,
        "analysisHorizonSeconds": 20.0,
        "predictionTimesSeconds": MODEL_SECONDS,
        "trainingSources": len(records),
        "trainingMethod": {
            "estimator": "one PCA-plus-ridge scalar model per second, frozen as NumPy coefficients",
            "dimensions": MODEL_DIMENSIONS,
            "ridgeAlpha": RIDGE_ALPHA,
            "randomFolds": 5,
            "chronologicalBlocks": 5,
            "boundaryOutcomesUsed": False,
            "savedPredictionPolicy": "source-level out-of-fold at every second",
            "typedPredictionPolicy": "same frozen per-second full fits",
            "causalPrefixPolicy": (
                "prediction at second t embeds only transcript atoms whose acoustic end time "
                "is at or before t"
            ),
            "futureWordsUsedForEarlierPredictions": False,
        },
        "featureContract": {
            "headline": "causal transcript-prefix embedding at each plotted second",
            "semantic": "the exact text acoustically completed by that prediction second",
            "components": (
                "one non-overlapping exact cover over the analyzed opening; visible as an "
                "outcome-blind explanatory candidate"
            ),
            "relationships": (
                "adjacent exact-cover category transitions and semantic/context geometry; "
                "visible as a withheld 20-second endpoint candidate"
            ),
            "canonicalCover": "non-overlapping; every analyzed token is owned exactly once",
            "multiResolutionLatticeRole": (
                "exhaustive overlapping candidate graph for inspection; only selected exact-cover "
                "nodes appear as components and candidates are never double-counted"
            ),
        },
        "families": model_families,
        "endpointCandidates": endpoint_model_payload,
        "support": {
            "tokenCountMinimum": int(token_counts.min()),
            "tokenCountMedian": float(np.median(token_counts)),
            "tokenCountMaximum": int(token_counts.max()),
            "measuredWordsPerSecondP10": float(np.quantile(speaking_rates_array, .1)),
            "medianWordsPerSecond": float(np.median(speaking_rates_array)),
            "measuredWordsPerSecondP90": float(np.quantile(speaking_rates_array, .9)),
            "speakingRateDefinition": (
                "lexical atoms divided by the acoustic interval from the first word start "
                "through the final word end"
            ),
            "measuredThrough20SecondsSources": len(records),
        },
        "viewsContract": views_contract,
        "evidenceBoundary": {
            "retention": (
                "text-conditioned observational prediction with source-level random-fold and "
                "past-to-future diagnostics; not a causal estimate"
            ),
            "views": (
                "withheld individualized forecast unless the explicit end-to-end promotion gate passes"
            ),
            "responseLag": (
                "no future shift is blended into this forecast; each target is retention measured "
                "at the same media-clock second as its completed transcript prefix"
            ),
        },
    }

    prediction_rows = []
    PREDICTION_DETAILS.mkdir(parents=True, exist_ok=True)
    for index, record in enumerate(records):
        detail = record["detail"]
        family_curves = {}
        for family_name, family in fitted.items():
            semantic = np.asarray(family["prediction"][index], np.float32)
            baseline = np.asarray(family["baseline"][index], np.float32)
            family_curves[family_name] = {
                "timesSeconds": MODEL_SECONDS,
                "predicted": semantic,
                "predictionP10": semantic + family["residualP10"],
                "predictionP90": semantic + family["residualP90"],
                "actual": targets[family_name][index],
                "stages": {
                    "baseline": baseline,
                    "semanticPrefix": semantic,
                },
                "selectedStage": "semanticPrefix",
                "causalPrefixOnly": True,
            }

        fold_models = {}
        endpoint_values = {}
        for family_name, family in endpoint_candidates.items():
            endpoint_values[family_name] = {}
            for stage_name, stage in family["stages"].items():
                crossfit = stage["crossfit"]
                endpoint_values[family_name][stage_name] = float(crossfit["prediction"][index])
            relationship_crossfit = family["stages"]["relationships"]["crossfit"]
            fold = int(relationship_crossfit["foldIndex"][index])
            fold_models[family_name] = relationship_crossfit["foldModels"][fold]
        components, relationships = local_endpoint_impacts(record, fold_models)

        entry = np.asarray(family_curves["entryIndexed"]["predicted"], float)
        absolute = np.asarray(family_curves["observedAbsolute"]["predicted"], float)
        hook_end = min(20.0, float(detail.get("originalHookEndSeconds") or 20.0))
        views = views_from_retention5(float(absolute[R5_INDEX]), views_contract)
        center_log = math.log10(max(1.0, views["estimate"]))
        views.update({
            "lower80": float(10 ** (center_log + views_contract["stackResidualP10Log10"])),
            "upper80": float(10 ** (center_log + views_contract["stackResidualP90Log10"])),
            "intervalMethod": "10th and 90th percentiles of partially OOF stack residuals",
            "promoted": individualized_views_available,
            "status": views_contract["promotionStatus"],
        })
        actual_entry = targets["entryIndexed"][index]
        actual_absolute = targets["observedAbsolute"][index]
        outputs = {
            "retainedAtAnalyzedEndPercent": float(entry[R20_INDEX]),
            "retainedAtAnalyzedEndP10": float(family_curves["entryIndexed"]["predictionP10"][R20_INDEX]),
            "retainedAtAnalyzedEndP90": float(family_curves["entryIndexed"]["predictionP90"][R20_INDEX]),
            "retainedAtOriginalHookEndPercent": float(np.interp(hook_end, MODEL_SECONDS, entry)),
            "absoluteRetention5sPercent": float(absolute[R5_INDEX]),
            "normalizedRetention5sPercent": float(entry[R5_INDEX]),
            "normalizedDropBy20sPoints": float(100.0 - entry[R20_INDEX]),
            "viewsDiagnostic": views,
        }
        actual = {
            "retainedAt20sPercent": float(actual_entry[R20_INDEX]),
            "retainedAtOriginalHookEndPercent": float(np.interp(hook_end, MODEL_SECONDS, actual_entry)),
            "absoluteRetention5sPercent": float(actual_absolute[R5_INDEX]),
            "absoluteRetention20sPercent": float(actual_absolute[R20_INDEX]),
            "views": float(actual_views[index]),
        }
        entry_baseline = np.asarray(family_curves["entryIndexed"]["stages"]["baseline"], float)
        contributions = {
            "at5Seconds": semantic_contribution(entry_baseline, entry, 5.0),
            "atOriginalHookEnd": semantic_contribution(entry_baseline, entry, hook_end),
            "at20Seconds": endpoint_contribution(
                entry_baseline, entry, endpoint_values["entryIndexed"],
            ),
            "definition": (
                "The headline is baseline plus the causal prefix-semantic prediction. Component "
                "and relationship values are visible 20-second counterfactual candidates and "
                "contribute zero because they were not promoted."
            ),
        }
        payload = {
            "version": 2,
            "status": "complete",
            "predictorVersion": PREDICTOR_VERSION,
            "featureVersion": FEATURE_VERSION,
            "sourceKind": "saved-opening-20s-causal-oof",
            "videoId": record["videoId"],
            "title": detail.get("title"),
            "text": detail.get("text"),
            "url": detail.get("url"),
            "analysisHorizonSeconds": 20.0,
            "predictionTimesSeconds": MODEL_SECONDS,
            "originalHookEndSeconds": hook_end,
            "tokenCount": record["tokenCount"],
            "componentCount": len(components),
            "components": components,
            "relationships": relationships,
            "causalPrefixTrace": record["prefixes"],
            "support": {
                "tokenCount": record["tokenCount"],
                "trainingTokenCountMinimum": model["support"]["tokenCountMinimum"],
                "trainingTokenCountMaximum": model["support"]["tokenCountMaximum"],
                "outsideMeasuredTokenRange": False,
                "estimatedSpokenSeconds": 20.0,
                "analysisHorizonSeconds": 20.0,
                "isExtrapolation": False,
                "timingSource": detail.get("timingContract"),
            },
            "outputs": outputs,
            "actual": actual,
            "curves": family_curves,
            "contributions": contributions,
            "validation": {
                family_name: {
                    "randomFold": compact_curve_validation(family["validation"]),
                    "chronological": compact_curve_validation(family["chronologicalValidation"]),
                }
                for family_name, family in fitted.items()
            },
            "evidence": model["evidenceBoundary"],
            "latticeDetail": f"/api/shortsquant/promise-lab/opening-20s/{record['videoId']}",
        }
        write_gzip(PREDICTION_DETAILS / f"{record['videoId']}.json.gz", payload)
        prediction_rows.append({
            "videoId": record["videoId"],
            "title": detail.get("title"),
            "text": detail.get("text"),
            "url": detail.get("url"),
            "tokenCount": record["tokenCount"],
            "componentCount": len(components),
            "categorySequence": [int(row["category"]) for row in components],
            "outputs": outputs,
            "actual": actual,
            "predictionError": {
                "retainedAt20sPoints": outputs["retainedAtAnalyzedEndPercent"] - actual["retainedAt20sPercent"],
                "absoluteRetention5sPoints": outputs["absoluteRetention5sPercent"] - actual["absoluteRetention5sPercent"],
                "viewsRatioDiagnostic": views["estimate"] / max(1.0, actual["views"]),
            },
            "detail": f"/api/shortsquant/promise-lab/opening-prediction/{record['videoId']}",
            "latticeDetail": payload["latticeDetail"],
        })

    browser = {
        "version": 2,
        "status": "complete",
        "stage": "causal prefix-by-prefix 20-second Shorts retention prediction",
        "predictorVersion": PREDICTOR_VERSION,
        "featureVersion": FEATURE_VERSION,
        "analysisHorizonSeconds": 20.0,
        "sources": len(records),
        "predictionTimesSeconds": MODEL_SECONDS,
        "primaryOutput": "predicted entry-indexed retention at the analyzed endpoint",
        "rows": prediction_rows,
        "validation": {
            family_name: {
                "randomFold": compact_curve_validation(family["validation"]),
                "chronological": compact_curve_validation(family["chronologicalValidation"]),
            }
            for family_name, family in fitted.items()
        },
        "viewsContract": views_contract,
        "featureContract": model["featureContract"],
        "support": model["support"],
        "evidenceBoundary": model["evidenceBoundary"],
    }
    write_json(MODEL_OUTPUT, model)
    write_json(OUTPUT, browser)
    if not args.no_upload:
        remote = R2Store()
        remote.put_json(f"{R2_PREFIX}/opening-retention-model.json.gz", model, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/opening-predictions.json.gz", browser, gzip_payload=True)
        for row in prediction_rows:
            path = PREDICTION_DETAILS / f"{row['videoId']}.json.gz"
            remote.put_bytes(
                f"{R2_PREFIX}/opening-predictions/{row['videoId']}.json.gz",
                path.read_bytes(), "application/json", "gzip",
            )
    print(json.dumps({
        "status": "complete",
        "sources": len(records),
        "prefixEmbeddings": int(prefix_tensor.shape[0] * prefix_tensor.shape[1]),
        "entryRandomValidation": compact_curve_validation(fitted["entryIndexed"]["validation"]),
        "entryChronologicalValidation": compact_curve_validation(
            fitted["entryIndexed"]["chronologicalValidation"]
        ),
        "viewsPromotionStatus": views_contract["promotionStatus"],
    }, indent=2, default=lambda value: value.tolist() if isinstance(value, np.ndarray) else value))


if __name__ == "__main__":
    main()
