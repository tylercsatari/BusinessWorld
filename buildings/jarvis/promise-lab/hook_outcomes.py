"""Held-out outcome axes and first-seconds retention forecasts for hook text."""

from __future__ import annotations

import numpy as np
from scipy.stats import rankdata
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score
from sklearn.model_selection import GroupKFold, KFold
from sklearn.preprocessing import StandardScaler

from axes import finite_correlation, spearman
from hook_score_core import (
    apply_linear_model,
    outcome_prediction_payload,
    row_unit,
)


EPS = 1e-9
OUTCOME_SEED = 20260718
FIXED_DIMENSIONS = 16
FIXED_ALPHA = 10.0


def _splitter(count: int, groups: np.ndarray | None, folds: int, seed: int):
    indices = np.arange(count)
    if groups is None:
        return KFold(
            n_splits=min(folds, count), shuffle=True, random_state=seed,
        ).split(indices)
    groups = np.asarray(groups).astype(str)
    return GroupKFold(
        n_splits=min(folds, len(set(groups))),
    ).split(indices, groups=groups)


def _fit_direct(features: np.ndarray, target: np.ndarray, train: np.ndarray,
                dimensions: int, alpha: float, seed: int) -> dict:
    features = np.asarray(features, np.float32)
    target = np.asarray(target, np.float32)
    if target.ndim == 1:
        target = target[:, None]
    finite = np.all(np.isfinite(features[train]), axis=1) & np.all(
        np.isfinite(target[train]), axis=1
    )
    fit = train[finite]
    if len(fit) < max(8, min(dimensions, features.shape[1]) + 2):
        raise ValueError("insufficient finite rows for the fixed outcome model")
    dimension = min(int(dimensions), len(fit) - 1, features.shape[1])
    reducer = PCA(
        n_components=max(1, dimension), svd_solver="randomized",
        random_state=seed,
    ).fit(features[fit])
    scores = reducer.transform(features[fit])
    scaler = StandardScaler().fit(scores)
    scaled = scaler.transform(scores)
    model = Ridge(alpha=float(alpha)).fit(scaled, target[fit])
    weight = np.asarray(model.coef_, np.float32)
    if weight.ndim == 1:
        weight = weight[None, :]
    scaled_weight = weight / np.maximum(scaler.scale_[None, :], EPS)
    coefficient = reducer.components_.T @ scaled_weight.T
    intercept = np.asarray(model.intercept_, np.float32).reshape(-1)
    intercept -= reducer.mean_ @ coefficient
    intercept -= scaler.mean_ @ scaled_weight.T
    return {
        "coefficient": coefficient.astype(np.float32),
        "intercept": intercept.astype(np.float32),
        "rows": fit.astype(int),
    }


def crossfit_linear(features: np.ndarray, target: np.ndarray,
                    groups: np.ndarray | None = None, folds: int = 5,
                    dimensions: int = FIXED_DIMENSIONS,
                    alpha: float = FIXED_ALPHA,
                    seed: int = OUTCOME_SEED) -> dict:
    features = row_unit(np.asarray(features, np.float32))
    target = np.asarray(target, np.float32)
    scalar = target.ndim == 1
    if scalar:
        target = target[:, None]
    prediction = np.full_like(target, np.nan, dtype=np.float32)
    baseline = np.full_like(target, np.nan, dtype=np.float32)
    fold_index = np.full(len(features), -1, np.int16)
    directions = []
    for fold, (train, test) in enumerate(
        _splitter(len(features), groups, folds, seed)
    ):
        model = _fit_direct(
            features, target, np.asarray(train, int), dimensions, alpha,
            seed + fold * 101,
        )
        prediction[test] = apply_linear_model(features[test], model)
        baseline[test] = np.nanmean(target[model["rows"]], axis=0)
        fold_index[test] = fold
        if target.shape[1] == 1:
            direction = model["coefficient"][:, 0]
            directions.append(direction / (np.linalg.norm(direction) + EPS))
    cosines = []
    for left in range(len(directions)):
        for right in range(left + 1, len(directions)):
            cosines.append(float(directions[left] @ directions[right]))
    return {
        "prediction": prediction[:, 0] if scalar else prediction,
        "baselinePrediction": baseline[:, 0] if scalar else baseline,
        "foldIndex": fold_index,
        "foldDirectionMedianCosine": float(np.median(cosines)) if cosines else None,
        "foldDirectionPositiveFraction": (
            float(np.mean(np.asarray(cosines) > 0)) if cosines else None
        ),
    }


def _orthogonal_map_direction(features: np.ndarray,
                              coefficient: np.ndarray) -> np.ndarray:
    features = row_unit(np.asarray(features, np.float32))
    direction = np.asarray(coefficient, np.float32).reshape(-1).copy()
    direction /= np.linalg.norm(direction) + EPS
    residual = features - (features @ direction)[:, None] * direction[None, :]
    map_direction = PCA(n_components=1, svd_solver="full").fit(
        residual
    ).components_[0].astype(np.float32)
    background = residual @ map_direction
    pivot = int(np.argmax(np.abs(background)))
    if background[pivot] < 0:
        map_direction = -map_direction
    return map_direction


def fit_full_linear(features: np.ndarray, target: np.ndarray,
                    dimensions: int = FIXED_DIMENSIONS,
                    alpha: float = FIXED_ALPHA,
                    seed: int = OUTCOME_SEED,
                    include_map: bool = False) -> dict:
    features = row_unit(np.asarray(features, np.float32))
    target = np.asarray(target, np.float32)
    model = _fit_direct(
        features, target, np.arange(len(features)), dimensions, alpha, seed,
    )
    prediction = apply_linear_model(features, model)
    output = {
        "coefficient": model["coefficient"],
        "intercept": model["intercept"],
        "trainingPrediction": prediction,
    }
    if include_map:
        if prediction.shape[1] != 1:
            raise ValueError("a map is defined only for a scalar outcome")
        output["mapDirection"] = _orthogonal_map_direction(
            features, model["coefficient"][:, 0]
        )
    return output


def rank_signflip(prediction: np.ndarray, target: np.ndarray,
                  repeats: int = 4096, seed: int = OUTCOME_SEED) -> dict:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    valid = np.isfinite(prediction + target)
    prediction = prediction[valid]
    target = target[valid]
    if len(prediction) < 8:
        return {"p": 1.0, "repeats": repeats, "n": len(prediction)}
    left = rankdata(prediction).astype(float)
    right = rankdata(target).astype(float)
    left = (left - left.mean()) / (left.std() + EPS)
    right = (right - right.mean()) / (right.std() + EPS)
    observed = float(left @ right / len(left))
    rng = np.random.default_rng(seed)
    exceed = 0
    batch = 512
    for start in range(0, repeats, batch):
        count = min(batch, repeats - start)
        signs = rng.choice((-1.0, 1.0), size=(count, len(left)))
        null = np.abs((signs * right[None, :]) @ left / len(left))
        exceed += int(np.sum(null >= abs(observed)))
    return {
        "observedSpearman": observed,
        "p": float((1 + exceed) / (repeats + 1)),
        "repeats": repeats,
        "n": len(left),
    }


def scalar_validation(prediction: np.ndarray, target: np.ndarray,
                      baseline: np.ndarray, repeats: int = 4096,
                      seed: int = OUTCOME_SEED) -> dict:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    baseline = np.asarray(baseline, float)
    valid = np.isfinite(prediction + target + baseline)
    residual = target[valid] - prediction[valid]
    mae = float(np.mean(np.abs(residual)))
    baseline_mae = float(np.mean(np.abs(target[valid] - baseline[valid])))
    return {
        "heldoutSpearman": spearman(prediction, target),
        "heldoutPearson": finite_correlation(prediction, target),
        "heldoutR2": float(r2_score(target[valid], prediction[valid])),
        "heldoutMAE": mae,
        "baselineMAE": baseline_mae,
        "maeImprovementFraction": float(1 - mae / max(baseline_mae, EPS)),
        "residualP10": float(np.quantile(residual, .1)),
        "residualMedian": float(np.median(residual)),
        "residualP90": float(np.quantile(residual, .9)),
        "rankInference": rank_signflip(
            prediction, target, repeats=repeats, seed=seed,
        ),
        "rows": int(valid.sum()),
    }


def paired_curve_improvement(prediction: np.ndarray, target: np.ndarray,
                             baseline: np.ndarray, repeats: int = 4096,
                             seed: int = OUTCOME_SEED) -> dict:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    baseline = np.asarray(baseline, float)
    model_error = np.nanmean(np.abs(prediction - target), axis=1)
    baseline_error = np.nanmean(np.abs(baseline - target), axis=1)
    improvement = baseline_error - model_error
    improvement = improvement[np.isfinite(improvement)]
    observed = float(np.mean(improvement))
    rng = np.random.default_rng(seed)
    exceed = 0
    bootstrap = np.empty(repeats, np.float32)
    batch = 512
    for start in range(0, repeats, batch):
        count = min(batch, repeats - start)
        signs = rng.choice((-1.0, 1.0), size=(count, len(improvement)))
        null = np.mean(signs * improvement[None, :], axis=1)
        exceed += int(np.sum(null >= observed))
        samples = rng.integers(0, len(improvement), size=(count, len(improvement)))
        bootstrap[start:start + count] = np.mean(improvement[samples], axis=1)
    return {
        "meanMAEImprovement": observed,
        "p": float((1 + exceed) / (repeats + 1)),
        "ciLow": float(np.quantile(bootstrap, .025)),
        "ciHigh": float(np.quantile(bootstrap, .975)),
        "repeats": repeats,
        "sources": len(improvement),
    }


def curve_validation(prediction: np.ndarray, target: np.ndarray,
                     baseline: np.ndarray, times: np.ndarray,
                     repeats: int = 4096,
                     seed: int = OUTCOME_SEED) -> dict:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    baseline = np.asarray(baseline, float)
    residual = target - prediction
    absolute = np.abs(residual)
    baseline_absolute = np.abs(target - baseline)
    per_time_rho = [
        spearman(prediction[:, index], target[:, index])
        for index in range(target.shape[1])
    ]
    low = np.nanquantile(residual, .1, axis=0)
    high = np.nanquantile(residual, .9, axis=0)
    covered = (target >= prediction + low) & (target <= prediction + high)
    mae = float(np.nanmean(absolute))
    baseline_mae = float(np.nanmean(baseline_absolute))
    return {
        "heldoutMAEPercentagePoints": mae,
        "baselineMAEPercentagePoints": baseline_mae,
        "maeImprovementFraction": float(1 - mae / max(baseline_mae, EPS)),
        "medianSourceMAEPercentagePoints": float(np.nanmedian(np.nanmean(absolute, axis=1))),
        "meanTimewiseSpearman": float(np.mean(per_time_rho)),
        "timewiseSpearman": [float(value) for value in per_time_rho],
        "residualP10ByTime": low.astype(np.float32),
        "residualP90ByTime": high.astype(np.float32),
        "empiricalBandCoverage": float(np.nanmean(covered)),
        "pairedImprovementInference": paired_curve_improvement(
            prediction, target, baseline, repeats=repeats, seed=seed,
        ),
        "timesSeconds": np.asarray(times, float),
        "sources": int(target.shape[0]),
    }


prediction_payload = outcome_prediction_payload
