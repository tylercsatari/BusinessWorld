"""Risk-set causal retention models for variable-length spoken sequences."""

from __future__ import annotations

import math

import numpy as np

from hook_outcomes import (
    crossfit_linear,
    fit_full_linear,
    forward_chain_linear,
    scalar_validation,
)


EPS = 1e-9
MIN_SEMANTIC_SOURCES = 10
MIN_CHRONOLOGICAL_SOURCES = 40
DEFAULT_DIMENSIONS = 16
DEFAULT_ALPHA = 10.0
DEFAULT_STAGE_ORDER = ("timing", "semantic", "components", "relationships")


def _predeclared_candidate_gate(candidate_stage: str, random_validation: dict,
                                chronological_validation: dict) -> dict:
    """Promote only the predeclared full model after two source-level checks.

    The component and semantic ablations remain diagnostics. They cannot become
    the serving headline after looking at their outcomes. This prevents a weak
    full model from being rescued by post-hoc stage shopping.
    """
    random_inference = random_validation.get("pairedSourceImprovementInference") or {}
    chronological_inference = (
        chronological_validation.get("pairedSourceImprovementInference") or {}
    )

    def passes(validation: dict, inference: dict) -> bool:
        gain = validation.get("sourceEqualMAEImprovementFraction")
        mean = inference.get("meanMAEImprovement")
        low = inference.get("ciLow")
        return bool(
            gain is not None and float(gain) > 0
            and mean is not None and float(mean) > 0
            and low is not None and float(low) > 0
        )

    random_passed = passes(random_validation, random_inference)
    chronological_passed = passes(
        chronological_validation, chronological_inference,
    )
    promoted = bool(random_passed and chronological_passed)
    return {
        "policy": (
            "the predeclared full relationship model is promoted only when its "
            "source-equal MAE beats the at-risk mean in both random source folds "
            "and past-to-future folds, with both source-bootstrap 95% lower bounds above zero"
        ),
        "candidateStage": str(candidate_stage),
        "selectedStage": str(candidate_stage) if promoted else "baseline",
        "promoted": promoted,
        "randomGatePassed": random_passed,
        "chronologicalGatePassed": chronological_passed,
        "fallback": None if promoted else "duration-conditioned at-risk population baseline",
        "stageShoppingAllowed": False,
        "selectionScope": "one predeclared decision for the whole normalization family",
    }


def compact_model(value: dict) -> dict:
    coefficient = np.asarray(value["coefficient"], np.float32)
    if coefficient.ndim == 2 and coefficient.shape[1] == 1:
        coefficient = coefficient[:, 0]
    intercept = np.asarray(value["intercept"], np.float32).reshape(-1)
    return {
        "coefficient": coefficient,
        "intercept": float(intercept[0]) if len(intercept) == 1 else intercept,
    }


def compact_scalar_validation(value: dict | None) -> dict | None:
    if value is None:
        return None
    omitted = {"predictionOOF", "targetObserved", "baselineOOF"}
    return {key: row for key, row in value.items() if key not in omitted}


def _fold_mean_baseline(values: np.ndarray, folds: int, seed: int) -> np.ndarray:
    """Cross-fit a mean-only comparator so a row never supplies its own baseline."""
    values = np.asarray(values, np.float32)
    count = len(values)
    output = np.full(count, np.nan, np.float32)
    if count < 2:
        return output
    rng = np.random.default_rng(seed)
    order = rng.permutation(count)
    groups = np.array_split(order, min(max(2, int(folds)), count))
    all_rows = np.arange(count)
    for heldout in groups:
        train = np.setdiff1d(all_rows, heldout, assume_unique=True)
        if len(train):
            output[heldout] = float(np.mean(values[train]))
    return output


def _dimensions_for_random_folds(count: int, maximum: int,
                                 folds: int) -> int:
    smallest_train = count - int(math.ceil(count / min(folds, count)))
    return max(1, min(int(maximum), smallest_train - 2))


def _dimensions_for_chronology(count: int, maximum: int,
                               blocks: int) -> int:
    first_train = int(math.floor(count / min(blocks, count)))
    return max(1, min(int(maximum), first_train - 2))


def _paired_source_improvement(prediction: np.ndarray, target: np.ndarray,
                               baseline: np.ndarray, repeats: int,
                               seed: int) -> dict:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    baseline = np.asarray(baseline, float)
    improvements = []
    for source in range(len(target)):
        valid = np.isfinite(
            prediction[source] + target[source] + baseline[source]
        )
        if valid.any():
            model_error = float(np.mean(np.abs(
                prediction[source, valid] - target[source, valid]
            )))
            baseline_error = float(np.mean(np.abs(
                baseline[source, valid] - target[source, valid]
            )))
            improvements.append(baseline_error - model_error)
    values = np.asarray(improvements, float)
    if not len(values):
        return {"sources": 0, "meanMAEImprovement": None, "p": None}
    rng = np.random.default_rng(seed)
    observed = float(np.mean(values))
    exceed = 0
    bootstrap = np.empty(int(repeats), np.float32)
    for index in range(int(repeats)):
        null = float(np.mean(values * rng.choice((-1.0, 1.0), len(values))))
        exceed += int(null >= observed)
        bootstrap[index] = float(np.mean(values[rng.integers(0, len(values), len(values))]))
    return {
        "sources": int(len(values)),
        "meanMAEImprovement": observed,
        "p": float((1 + exceed) / (int(repeats) + 1)),
        "ciLow": float(np.quantile(bootstrap, .025)),
        "ciHigh": float(np.quantile(bootstrap, .975)),
        "repeats": int(repeats),
        "unit": "one source-level mean absolute error across its observable seconds",
    }


def risk_set_validation(prediction: np.ndarray, target: np.ndarray,
                        baseline: np.ndarray, seconds: np.ndarray,
                        repeats: int = 1024, seed: int = 0) -> dict:
    """Validate an irregular source-by-second matrix without complete-case bias."""
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    baseline = np.asarray(baseline, float)
    seconds = np.asarray(seconds, float)
    if not (prediction.shape == target.shape == baseline.shape):
        raise ValueError("risk-set prediction matrices do not match")
    if prediction.shape[1] != len(seconds):
        raise ValueError("risk-set seconds do not match the prediction matrix")
    valid = np.isfinite(prediction + target + baseline)
    model_error = np.abs(prediction - target)
    baseline_error = np.abs(baseline - target)
    rows = []
    for column, second in enumerate(seconds):
        selected = valid[:, column]
        if not selected.any():
            rows.append({
                "second": float(second), "evaluatedSources": 0,
                "heldoutMAEPercentagePoints": None,
                "baselineMAEPercentagePoints": None,
                "maeImprovementFraction": None,
            })
            continue
        model_mae = float(np.mean(model_error[selected, column]))
        base_mae = float(np.mean(baseline_error[selected, column]))
        rows.append({
            "second": float(second),
            "evaluatedSources": int(selected.sum()),
            "heldoutMAEPercentagePoints": model_mae,
            "baselineMAEPercentagePoints": base_mae,
            "maeImprovementFraction": float(1 - model_mae / max(base_mae, EPS)),
            "residualP10": float(np.quantile(
                target[selected, column] - prediction[selected, column], .1,
            )),
            "residualP90": float(np.quantile(
                target[selected, column] - prediction[selected, column], .9,
            )),
        })
    source_mae = []
    source_baseline_mae = []
    for source in range(len(target)):
        selected = valid[source]
        if selected.any():
            source_mae.append(float(np.mean(model_error[source, selected])))
            source_baseline_mae.append(float(np.mean(
                baseline_error[source, selected]
            )))
    observed = valid.any(axis=0)
    flat_model = model_error[valid]
    flat_baseline = baseline_error[valid]
    return {
        "validationUnit": "source-video by observable whole second",
        "censoringPolicy": (
            "a source contributes at second t only when its measured media and retention "
            "curve cover t; missing future seconds are never imputed"
        ),
        "evaluatedObservationCells": int(valid.sum()),
        "evaluatedSources": int(np.sum(valid.any(axis=1))),
        "evaluatedSeconds": int(observed.sum()),
        "lastEvaluatedSecond": (
            float(seconds[np.flatnonzero(observed)[-1]]) if observed.any() else None
        ),
        "observationWeightedMAEPercentagePoints": (
            float(np.mean(flat_model)) if len(flat_model) else None
        ),
        "observationWeightedBaselineMAEPercentagePoints": (
            float(np.mean(flat_baseline)) if len(flat_baseline) else None
        ),
        "sourceEqualMAEPercentagePoints": (
            float(np.mean(source_mae)) if source_mae else None
        ),
        "sourceEqualBaselineMAEPercentagePoints": (
            float(np.mean(source_baseline_mae)) if source_baseline_mae else None
        ),
        "sourceEqualMAEImprovementFraction": (
            float(1 - np.mean(source_mae) / max(np.mean(source_baseline_mae), EPS))
            if source_mae else None
        ),
        "perSecond": rows,
        "pairedSourceImprovementInference": _paired_source_improvement(
            prediction, target, baseline, repeats, seed,
        ),
    }


def fit_variable_temporal_family(
        features_by_second: dict[int, tuple[np.ndarray, np.ndarray]],
        target: np.ndarray, chronology: np.ndarray, seconds: np.ndarray,
        maximum_dimensions: int = DEFAULT_DIMENSIONS,
        alpha: float = DEFAULT_ALPHA, random_folds: int = 5,
        chronological_blocks: int = 5,
        minimum_semantic_sources: int = MIN_SEMANTIC_SOURCES,
        minimum_chronological_sources: int = MIN_CHRONOLOGICAL_SOURCES,
        seed: int = 0) -> dict:
    """Fit one causal prefix model per second on that second's at-risk sources."""
    target = np.asarray(target, np.float32)
    chronology = np.asarray(chronology).astype(str)
    seconds = np.asarray(seconds, np.float32)
    if target.ndim != 2 or target.shape[1] != len(seconds):
        raise ValueError("variable-horizon target does not match its second grid")
    if len(chronology) != len(target):
        raise ValueError("chronology does not match variable-horizon sources")
    prediction = np.full_like(target, np.nan, np.float32)
    baseline = np.full_like(target, np.nan, np.float32)
    chronological_prediction = np.full_like(target, np.nan, np.float32)
    chronological_baseline = np.full_like(target, np.nan, np.float32)
    temporal_models = []
    semantic_horizon = 0.0
    chronological_horizon = 0.0
    finite_zero = target[np.isfinite(target[:, 0]), 0]
    time_zero_mean = float(np.mean(finite_zero)) if len(finite_zero) else None

    for column, second_value in enumerate(seconds):
        second = int(round(float(second_value)))
        finite_target = np.flatnonzero(np.isfinite(target[:, column]))
        if second == 0:
            if len(finite_target):
                if np.allclose(target[finite_target, column], 100.0, atol=1e-5):
                    prediction[finite_target, column] = 100.0
                    baseline[finite_target, column] = 100.0
                    chronological_prediction[finite_target, column] = 100.0
                    chronological_baseline[finite_target, column] = 100.0
                else:
                    folded = _fold_mean_baseline(
                        target[finite_target, column], random_folds,
                        seed + 17,
                    )
                    prediction[finite_target, column] = folded
                    baseline[finite_target, column] = folded
            continue

        supplied = features_by_second.get(second)
        if supplied is None:
            source_indices = finite_target
            features = None
        else:
            source_indices = np.asarray(supplied[0], int)
            features = np.asarray(supplied[1], np.float32)
            if len(source_indices) != len(features):
                raise ValueError(f"second {second} feature rows do not match source indices")
            keep = np.isfinite(target[source_indices, column])
            source_indices = source_indices[keep]
            features = features[keep]
        values = target[source_indices, column]
        count = len(source_indices)
        folded_baseline = _fold_mean_baseline(
            values, random_folds, seed + second * 37,
        )
        baseline[source_indices, column] = folded_baseline
        support_tier = "empirical-only"
        semantic_validation = None
        chronological_validation = None
        model = None
        dimensions = 0
        chronological_dimensions = 0
        residual_p10 = None
        residual_p90 = None

        if features is not None and count >= int(minimum_semantic_sources):
            dimensions = _dimensions_for_random_folds(
                count, maximum_dimensions, random_folds,
            )
            crossfit = crossfit_linear(
                features, values, folds=random_folds, dimensions=dimensions,
                alpha=alpha, seed=seed + second * 1009,
            )
            prediction[source_indices, column] = np.asarray(
                crossfit["prediction"], np.float32,
            )
            baseline[source_indices, column] = np.asarray(
                crossfit["baselinePrediction"], np.float32,
            )
            semantic_validation = scalar_validation(
                crossfit["prediction"], values,
                crossfit["baselinePrediction"], repeats=512,
                seed=seed + second * 2003,
            )
            full = fit_full_linear(
                features, values, dimensions=dimensions, alpha=alpha,
                seed=seed + second * 3001,
            )
            model = compact_model(full)
            residual = values - np.asarray(crossfit["prediction"], float)
            residual_p10 = float(np.quantile(residual, .1))
            residual_p90 = float(np.quantile(residual, .9))
            semantic_horizon = max(semantic_horizon, float(second))
            support_tier = "random-fold-exploratory"

            if count >= int(minimum_chronological_sources):
                chronological_dimensions = _dimensions_for_chronology(
                    count, dimensions, chronological_blocks,
                )
                chronological = forward_chain_linear(
                    features, values, chronology[source_indices],
                    dimensions=chronological_dimensions, alpha=alpha,
                    seed=seed + second * 4001,
                    blocks=chronological_blocks,
                )
                chronological_prediction[source_indices, column] = np.asarray(
                    chronological["prediction"], np.float32,
                )
                chronological_baseline[source_indices, column] = np.asarray(
                    chronological["baselinePrediction"], np.float32,
                )
                chronological_validation = scalar_validation(
                    chronological["prediction"], values,
                    chronological["baselinePrediction"], repeats=512,
                    seed=seed + second * 5003,
                )
                chronological_horizon = max(
                    chronological_horizon, float(second),
                )
                support_tier = "random-and-chronological"

        temporal_models.append({
            "second": float(second),
            "riskSetSources": int(count),
            "semanticModelAvailable": model is not None,
            "chronologicalValidationAvailable": chronological_validation is not None,
            "supportTier": support_tier,
            "dimensions": int(dimensions),
            "chronologicalDimensions": int(chronological_dimensions),
            "baselineMean": float(np.mean(values)) if count else None,
            "model": model,
            "residualP10": residual_p10,
            "residualP90": residual_p90,
            "randomFoldValidation": compact_scalar_validation(semantic_validation),
            "chronologicalValidation": compact_scalar_validation(
                chronological_validation,
            ),
            "prefixOnly": True,
            "usesFutureWords": False,
            "censoring": "source contributes only while its measured duration covers this second",
        })

    random_validation = risk_set_validation(
        prediction, target, baseline, seconds,
        repeats=1024, seed=seed + 70001,
    )
    chronological_validation = risk_set_validation(
        chronological_prediction, target, chronological_baseline, seconds,
        repeats=1024, seed=seed + 80001,
    )
    return {
        "prediction": prediction,
        "baseline": baseline,
        "chronologicalPrediction": chronological_prediction,
        "chronologicalBaseline": chronological_baseline,
        "temporalModels": temporal_models,
        "timeZeroMean": time_zero_mean,
        "semanticModelHorizonSeconds": float(semantic_horizon),
        "chronologicalValidationHorizonSeconds": float(chronological_horizon),
        "randomFoldValidation": random_validation,
        "chronologicalValidation": chronological_validation,
        "supportPolicy": {
            "minimumSemanticSources": int(minimum_semantic_sources),
            "minimumChronologicalSources": int(minimum_chronological_sources),
            "belowSemanticMinimum": "population baseline only; no individualized text claim",
            "belowObservedSupport": "no retention value is emitted",
        },
    }


def _stage_comparison(current: dict, previous: dict | None) -> dict:
    """Describe a predeclared nested-stage OOF contrast on identical rows."""
    if previous is None:
        baseline_mae = current.get("baselineMAEPercentagePoints")
        previous_name = "fold-local at-risk mean"
    else:
        baseline_mae = previous.get("heldoutMAEPercentagePoints")
        previous_name = str(previous.get("stage") or "previous stage")
    current_mae = current.get("heldoutMAEPercentagePoints")
    if current_mae is None or baseline_mae is None:
        improvement = None
        fraction = None
    else:
        improvement = float(baseline_mae) - float(current_mae)
        fraction = float(improvement / max(float(baseline_mae), EPS))
    return {
        "previousStage": previous_name,
        "maeImprovementPercentagePoints": improvement,
        "maeImprovementFraction": fraction,
        "selectionRole": "diagnostic fixed-stage ablation; not used to select this endpoint",
    }


def fit_variable_stage_family(
        features_by_second: dict[int, tuple[np.ndarray, dict[str, np.ndarray]]],
        target: np.ndarray, chronology: np.ndarray, seconds: np.ndarray,
        stage_order: tuple[str, ...] = DEFAULT_STAGE_ORDER,
        headline_stage: str = "relationships",
        maximum_dimensions: int = DEFAULT_DIMENSIONS,
        alpha: float = DEFAULT_ALPHA, random_folds: int = 5,
        chronological_blocks: int = 5,
        minimum_semantic_sources: int = MIN_SEMANTIC_SOURCES,
        minimum_chronological_sources: int = MIN_CHRONOLOGICAL_SOURCES,
        diagnostic_stage_seconds: set[int] | None = None,
        seed: int = 0) -> dict:
    """Fit a fixed nested feature ladder at every observable second.

    Every stage receives the same source rows and deterministic fold seed.  The
    final stage is declared before fitting and is always the headline whenever
    there are enough at-risk sources, preventing endpoint-by-endpoint cherry
    picking.  Earlier stages remain full OOF ablations for the UI.
    """
    stage_order = tuple(str(value) for value in stage_order)
    if not stage_order or headline_stage not in stage_order:
        raise ValueError("the fixed headline stage must be present in stage_order")
    target = np.asarray(target, np.float32)
    chronology = np.asarray(chronology).astype(str)
    seconds = np.asarray(seconds, np.float32)
    if target.ndim != 2 or target.shape[1] != len(seconds):
        raise ValueError("variable-horizon target does not match its second grid")
    if len(chronology) != len(target):
        raise ValueError("chronology does not match variable-horizon sources")

    shape = target.shape
    stage_prediction = {
        stage: np.full(shape, np.nan, np.float32) for stage in stage_order
    }
    stage_chronological = {
        stage: np.full(shape, np.nan, np.float32) for stage in stage_order
    }
    baseline = np.full(shape, np.nan, np.float32)
    chronological_baseline = np.full(shape, np.nan, np.float32)
    temporal_models = []
    semantic_horizon = 0.0
    chronological_horizon = 0.0
    finite_zero = target[np.isfinite(target[:, 0]), 0]
    time_zero_mean = float(np.mean(finite_zero)) if len(finite_zero) else None

    for column, second_value in enumerate(seconds):
        second = int(round(float(second_value)))
        finite_target = np.flatnonzero(np.isfinite(target[:, column]))
        if second == 0:
            if len(finite_target):
                fixed = bool(np.allclose(
                    target[finite_target, column], 100.0, atol=1e-5,
                ))
                values = (
                    np.full(len(finite_target), 100.0, np.float32)
                    if fixed else
                    _fold_mean_baseline(
                        target[finite_target, column], random_folds, seed + 17,
                    )
                )
                baseline[finite_target, column] = values
                for stage in stage_order:
                    stage_prediction[stage][finite_target, column] = values
                if fixed:
                    chronological_baseline[finite_target, column] = 100.0
                    for stage in stage_order:
                        stage_chronological[stage][finite_target, column] = 100.0
            continue

        supplied = features_by_second.get(second)
        if supplied is None:
            source_indices = finite_target
            stage_features = {}
        else:
            source_indices = np.asarray(supplied[0], int)
            stage_features = {
                str(name): np.asarray(values, np.float32)
                for name, values in supplied[1].items()
            }
            if any(len(values) != len(source_indices) for values in stage_features.values()):
                raise ValueError(f"second {second} feature rows do not match source indices")
            keep = np.isfinite(target[source_indices, column])
            source_indices = source_indices[keep]
            stage_features = {
                name: values[keep] for name, values in stage_features.items()
            }
        values = target[source_indices, column]
        count = len(source_indices)
        folded_baseline = _fold_mean_baseline(
            values, random_folds, seed + second * 37,
        )
        baseline[source_indices, column] = folded_baseline
        stage_rows = {}
        previous_random = None
        all_stages_available = bool(count >= int(minimum_semantic_sources))
        all_stages_available = all_stages_available and all(
            stage in stage_features for stage in stage_order
        )
        random_dimensions = _dimensions_for_random_folds(
            count, maximum_dimensions, random_folds,
        ) if all_stages_available else 0
        chronological_available = bool(
            all_stages_available and count >= int(minimum_chronological_sources)
        )
        chronological_dimensions = _dimensions_for_chronology(
            count, random_dimensions, chronological_blocks,
        ) if chronological_available else 0

        fit_full_ladder = (
            diagnostic_stage_seconds is None
            or second in {int(value) for value in diagnostic_stage_seconds}
        )
        stages_to_fit = set(stage_order if fit_full_ladder else (headline_stage,))
        for offset, stage in enumerate(stage_order):
            row = {
                "stage": stage,
                "model": None,
                "randomFoldValidation": None,
                "chronologicalValidation": None,
                "nestedOOFContrast": None,
            }
            if all_stages_available and stage in stages_to_fit:
                features = stage_features[stage]
                fold_seed = seed + second * 1009
                crossfit = crossfit_linear(
                    features, values, folds=random_folds,
                    dimensions=random_dimensions, alpha=alpha, seed=fold_seed,
                )
                stage_prediction[stage][source_indices, column] = np.asarray(
                    crossfit["prediction"], np.float32,
                )
                random_validation = compact_scalar_validation(scalar_validation(
                    crossfit["prediction"], values,
                    crossfit["baselinePrediction"], repeats=512,
                    seed=seed + second * 2003 + offset * 101,
                ))
                random_validation["stage"] = stage
                full = fit_full_linear(
                    features, values, dimensions=random_dimensions, alpha=alpha,
                    seed=seed + second * 3001,
                )
                row["model"] = compact_model(full)
                row["randomFoldValidation"] = random_validation
                row["nestedOOFContrast"] = _stage_comparison(
                    random_validation, previous_random,
                )
                previous_random = random_validation
                if chronological_available:
                    chronological = forward_chain_linear(
                        features, values, chronology[source_indices],
                        dimensions=chronological_dimensions, alpha=alpha,
                        seed=seed + second * 4001,
                        blocks=chronological_blocks,
                    )
                    stage_chronological[stage][source_indices, column] = np.asarray(
                        chronological["prediction"], np.float32,
                    )
                    row["chronologicalValidation"] = compact_scalar_validation(
                        scalar_validation(
                            chronological["prediction"], values,
                            chronological["baselinePrediction"], repeats=512,
                            seed=seed + second * 5003 + offset * 101,
                        )
                    )
            stage_rows[stage] = row

        if all_stages_available:
            headline_crossfit = stage_prediction[headline_stage][source_indices, column]
            headline_residual = values - headline_crossfit
            residual_p10 = float(np.quantile(headline_residual, .1))
            residual_p90 = float(np.quantile(headline_residual, .9))
            semantic_horizon = max(semantic_horizon, float(second))
            support_tier = (
                "random-and-chronological" if chronological_available
                else "random-fold-exploratory"
            )
            if chronological_available:
                chronological_horizon = max(chronological_horizon, float(second))
        else:
            residual_p10 = None
            residual_p90 = None
            support_tier = "empirical-only"
        if chronological_available:
            headline_chronological = stage_chronological[headline_stage][
                source_indices, column
            ]
            valid = np.isfinite(headline_chronological)
            if valid.any():
                chronological_baseline[source_indices[valid], column] = np.asarray(
                    [
                        float((stage_rows[headline_stage]["chronologicalValidation"] or {})
                              .get("baselineMean", np.nan))
                    ] * int(valid.sum()), np.float32,
                )

        # Chronological baselines are stage-independent.  Reconstruct them with
        # the same forward-chain helper used by every stage to avoid relying on
        # compact validation summaries.
        if chronological_available:
            reference = forward_chain_linear(
                stage_features[headline_stage], values, chronology[source_indices],
                dimensions=chronological_dimensions, alpha=alpha,
                seed=seed + second * 4001, blocks=chronological_blocks,
            )
            chronological_baseline[source_indices, column] = np.asarray(
                reference["baselinePrediction"], np.float32,
            )

        temporal_models.append({
            "second": float(second),
            "riskSetSources": int(count),
            "headlineStage": headline_stage,
            "headlineModelAvailable": bool(all_stages_available),
            "chronologicalValidationAvailable": chronological_available,
            "supportTier": support_tier,
            "dimensions": int(random_dimensions),
            "chronologicalDimensions": int(chronological_dimensions),
            "baselineMean": float(np.mean(values)) if count else None,
            "residualP10": residual_p10,
            "residualP90": residual_p90,
            "stages": stage_rows,
            "fullNestedAblationAvailable": bool(fit_full_ladder and all_stages_available),
            "prefixOnly": True,
            "usesFutureWords": False,
            "categories": 4,
            "censoring": "source contributes only while its measured duration covers this second",
        })

    stage_validations = {
        stage: risk_set_validation(
            stage_prediction[stage], target, baseline, seconds,
            repeats=1024, seed=seed + 60001 + index * 1009,
        )
        for index, stage in enumerate(stage_order)
    }
    chronological_stage_validations = {
        stage: risk_set_validation(
            stage_chronological[stage], target, chronological_baseline, seconds,
            repeats=1024, seed=seed + 65001 + index * 1009,
        )
        for index, stage in enumerate(stage_order)
    }
    promotion = _predeclared_candidate_gate(
        headline_stage, stage_validations[headline_stage],
        chronological_stage_validations[headline_stage],
    )
    selected_stage = str(promotion["selectedStage"])
    candidate_available = np.isfinite(stage_prediction[headline_stage])
    chronological_candidate_available = np.isfinite(
        stage_chronological[headline_stage]
    )
    if selected_stage == headline_stage:
        headline_prediction = stage_prediction[headline_stage].copy()
        headline_chronological = stage_chronological[headline_stage].copy()
    else:
        headline_prediction = np.where(
            candidate_available, baseline, np.nan,
        ).astype(np.float32)
        headline_chronological = np.where(
            chronological_candidate_available, chronological_baseline, np.nan,
        ).astype(np.float32)

    for row in temporal_models:
        second = int(round(float(row["second"])))
        column = int(np.argmin(np.abs(seconds - float(second))))
        finite = np.isfinite(headline_prediction[:, column] + target[:, column])
        residual = target[finite, column] - headline_prediction[finite, column]
        row["candidateStage"] = headline_stage
        row["selectedStage"] = selected_stage
        row["headlineStage"] = selected_stage
        row["promotionGatePassed"] = bool(promotion["promoted"])
        row["residualP10"] = (
            float(np.quantile(residual, .1)) if len(residual) else None
        )
        row["residualP90"] = (
            float(np.quantile(residual, .9)) if len(residual) else None
        )

    selected_random_validation = risk_set_validation(
        headline_prediction, target, baseline, seconds,
        repeats=1024, seed=seed + 71001,
    )
    selected_chronological_validation = risk_set_validation(
        headline_chronological, target, chronological_baseline, seconds,
        repeats=1024, seed=seed + 72001,
    )
    return {
        "prediction": headline_prediction,
        "baseline": baseline,
        "chronologicalPrediction": headline_chronological,
        "chronologicalBaseline": chronological_baseline,
        "stagePrediction": stage_prediction,
        "stageChronologicalPrediction": stage_chronological,
        "temporalModels": temporal_models,
        "timeZeroMean": time_zero_mean,
        "headlineStage": selected_stage,
        "selectedStage": selected_stage,
        "candidateStage": headline_stage,
        "promotion": promotion,
        "stageOrder": list(stage_order),
        "semanticModelHorizonSeconds": float(semantic_horizon),
        "chronologicalValidationHorizonSeconds": float(chronological_horizon),
        "randomFoldValidation": selected_random_validation,
        "chronologicalValidation": selected_chronological_validation,
        "candidateRandomFoldValidation": stage_validations[headline_stage],
        "candidateChronologicalValidation": chronological_stage_validations[headline_stage],
        "stageValidations": stage_validations,
        "chronologicalStageValidations": chronological_stage_validations,
        "supportPolicy": {
            "minimumSemanticSources": int(minimum_semantic_sources),
            "minimumChronologicalSources": int(minimum_chronological_sources),
            "belowSemanticMinimum": "population baseline only; no individualized text claim",
            "belowObservedSupport": "no retention value is emitted",
            "headlineSelection": (
                f"{headline_stage} was fixed before fitting; it is served only if the "
                "global predeclared promotion gate passes, otherwise baseline is served"
            ),
            "nestedAblationSeconds": (
                "every fitted second" if diagnostic_stage_seconds is None else
                sorted(int(value) for value in diagnostic_stage_seconds)
            ),
        },
    }
