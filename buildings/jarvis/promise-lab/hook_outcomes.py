"""Held-out outcome axes and first-seconds retention forecasts for hook text."""

from __future__ import annotations

import numpy as np
from scipy.stats import pearsonr, rankdata, spearmanr
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


def correlation_audit(left: np.ndarray, right: np.ndarray) -> dict:
    """Return rank and linear association with exact two-sided p-values."""
    left = np.asarray(left, float)
    right = np.asarray(right, float)
    valid = np.isfinite(left + right)
    left = left[valid]
    right = right[valid]
    if len(left) < 4:
        return {"rows": int(len(left))}
    rank = spearmanr(left, right)
    linear = pearsonr(left, right)
    return {
        "rows": int(len(left)),
        "spearman": float(rank.statistic),
        "spearmanP": float(rank.pvalue),
        "pearson": float(linear.statistic),
        "pearsonP": float(linear.pvalue),
    }


def terminal_conditioned_replay_correction(
        curves: np.ndarray, terminal: np.ndarray | float) -> np.ndarray:
    """Return an additive replay envelope anchored by observed endpoints.

    The correction is an endpoint-conditioned index, not an identified count of
    repeat viewers. It attributes the entry excess above 100 proportionally to
    the observed curve's remaining distance above its terminal anchor. Unlike a
    shared time-decay kernel, it cannot create a reversal that is absent from the
    observed curve because both the corrected curve and correction are affine in
    the same observed value between the two anchors.
    """
    values = np.asarray(curves, float)
    scalar_curve = values.ndim == 1
    if scalar_curve:
        values = values[None, :]
    if values.ndim != 2 or values.shape[1] < 2:
        raise ValueError("replay correction requires one or more complete curves")
    anchors = np.asarray(terminal, float)
    if anchors.ndim == 0:
        anchors = np.full(len(values), float(anchors), float)
    anchors = anchors.reshape(-1)
    if len(anchors) != len(values):
        raise ValueError("terminal anchors and retention curves differ")
    if not np.all(np.isfinite(values)) or not np.all(np.isfinite(anchors)):
        raise ValueError("replay correction requires finite curves and terminal anchors")
    amplitude = values[:, 0] - anchors
    if np.any(amplitude <= EPS):
        raise ValueError("entry retention must exceed the terminal anchor")
    entry_excess = np.maximum(values[:, 0] - 100.0, 0.0)
    remaining_fraction = np.clip(
        (values - anchors[:, None]) / amplitude[:, None], 0.0, 1.0,
    )
    correction = entry_excess[:, None] * remaining_fraction
    correction[:, 0] = entry_excess
    result = correction.astype(np.float32)
    return result[0] if scalar_curve else result


def apply_terminal_conditioned_replay_correction(
        curves: np.ndarray, terminal: np.ndarray | float) -> np.ndarray:
    """Subtract the additive endpoint-conditioned replay envelope."""
    values = np.asarray(curves, float)
    correction = terminal_conditioned_replay_correction(values, terminal)
    return (values - correction).astype(np.float32)


def response_end_values(curves: np.ndarray, times: np.ndarray,
                        response_seconds: np.ndarray) -> np.ndarray:
    curves = np.asarray(curves, float)
    times = np.asarray(times, float)
    response_seconds = np.asarray(response_seconds, float)
    return np.asarray([
        np.interp(response_seconds[index], times, curves[index])
        for index in range(len(curves))
    ], np.float32)


def per_second_survival(end_retention: np.ndarray,
                        response_seconds: np.ndarray) -> np.ndarray:
    """Convert end survival to the geometric percent carried through each second."""
    end_retention = np.asarray(end_retention, float)
    response_seconds = np.asarray(response_seconds, float)
    return (
        100.0 * np.exp(
            np.log(np.maximum(end_retention, 1e-4) / 100.0)
            / np.maximum(response_seconds, 1e-4)
        )
    ).astype(np.float32)


def duration_baseline_features(response_seconds: np.ndarray) -> np.ndarray:
    seconds = np.maximum(np.asarray(response_seconds, float), 1e-4)
    return np.column_stack([seconds, seconds ** 2, np.log(seconds)]).astype(np.float32)


def fit_duration_baseline(response_seconds: np.ndarray, target: np.ndarray,
                          alpha: float = FIXED_ALPHA) -> dict:
    features = duration_baseline_features(response_seconds)
    target = np.asarray(target, float)
    scaler = StandardScaler().fit(features)
    model = Ridge(alpha=float(alpha)).fit(scaler.transform(features), target)
    coefficient = np.asarray(model.coef_, float) / scaler.scale_
    intercept = float(model.intercept_ - scaler.mean_ @ coefficient)
    return {
        "coefficient": coefficient.astype(np.float32),
        "intercept": intercept,
        "ridgeAlpha": float(alpha),
        "features": ["response seconds", "response seconds squared", "log response seconds"],
    }


def apply_duration_baseline(response_seconds: np.ndarray | float,
                            model: dict) -> np.ndarray:
    scalar = np.ndim(response_seconds) == 0
    values = np.asarray([response_seconds] if scalar else response_seconds, float)
    prediction = (
        duration_baseline_features(values) @ np.asarray(model["coefficient"], float)
        + float(model["intercept"])
    )
    return prediction[0] if scalar else prediction


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


def nested_survival_crossfit(features: np.ndarray, curves: np.ndarray,
                             terminal: np.ndarray, response_seconds: np.ndarray,
                             times: np.ndarray,
                             folds: int = 5,
                             seed: int = OUTCOME_SEED) -> dict:
    """Cross-fit normalization, duration correction, and semantic prediction."""
    features = row_unit(np.asarray(features, np.float32))
    curves = np.asarray(curves, np.float32)
    terminal = np.asarray(terminal, np.float32)
    response_seconds = np.asarray(response_seconds, np.float32)
    times = np.asarray(times, np.float32)
    count = len(features)
    score_prediction = np.full(count, np.nan, np.float32)
    score_baseline = np.full(count, np.nan, np.float32)
    score_target = np.full(count, np.nan, np.float32)
    carry = np.full(count, np.nan, np.float32)
    expected_carry = np.full(count, np.nan, np.float32)
    curve_prediction = np.full_like(curves, np.nan, dtype=np.float32)
    curve_baseline = np.full_like(curves, np.nan, dtype=np.float32)
    curve_target = np.full_like(curves, np.nan, dtype=np.float32)
    fold_index = np.full(count, -1, np.int16)
    directions = []
    adjusted = apply_terminal_conditioned_replay_correction(curves, terminal)
    splits = KFold(
        n_splits=min(folds, count), shuffle=True, random_state=seed,
    ).split(np.arange(count))
    for fold, (train, test) in enumerate(splits):
        train = np.asarray(train, int)
        test = np.asarray(test, int)
        fold_carry = per_second_survival(
            response_end_values(adjusted, times, response_seconds),
            response_seconds,
        )
        length_model = fit_duration_baseline(
            response_seconds[train], fold_carry[train],
        )
        fold_expected = apply_duration_baseline(response_seconds, length_model)
        fold_target = fold_carry - fold_expected
        score_model = _fit_direct(
            features, fold_target, train, FIXED_DIMENSIONS, FIXED_ALPHA,
            seed + fold * 101,
        )
        score_prediction[test] = apply_linear_model(
            features[test], score_model,
        )[:, 0]
        score_baseline[test] = float(np.mean(fold_target[train]))
        score_target[test] = fold_target[test]
        carry[test] = fold_carry[test]
        expected_carry[test] = fold_expected[test]
        direction = score_model["coefficient"][:, 0]
        directions.append(direction / (np.linalg.norm(direction) + EPS))

        curve_model = _fit_direct(
            features, adjusted, train, FIXED_DIMENSIONS, FIXED_ALPHA,
            seed + 7001 + fold * 101,
        )
        curve_prediction[test] = apply_linear_model(features[test], curve_model)
        curve_baseline[test] = np.mean(adjusted[train], axis=0)
        curve_target[test] = adjusted[test]
        fold_index[test] = fold

    curve_prediction[:, 0] = 100.0
    curve_baseline[:, 0] = 100.0
    curve_target[:, 0] = 100.0
    cosines = [
        float(directions[left] @ directions[right])
        for left in range(len(directions))
        for right in range(left + 1, len(directions))
    ]
    return {
        "scorePrediction": score_prediction,
        "scoreBaseline": score_baseline,
        "scoreTarget": score_target,
        "carryPercentPerSecond": carry,
        "expectedCarryPercentPerSecond": expected_carry,
        "curvePrediction": curve_prediction,
        "curveBaseline": curve_baseline,
        "curveTarget": curve_target,
        "foldIndex": fold_index,
        "foldDirectionMedianCosine": float(np.median(cosines)) if cosines else None,
        "foldDirectionPositiveFraction": (
            float(np.mean(np.asarray(cosines) > 0)) if cosines else None
        ),
    }


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
