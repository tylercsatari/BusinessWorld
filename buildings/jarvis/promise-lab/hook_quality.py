"""Held-out hook-retention axis for variable non-overlapping components."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import rankdata
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score
from sklearn.model_selection import KFold
from sklearn.preprocessing import StandardScaler

from axes import finite_correlation, spearman
from cluster_outcomes import endpoint_normalize_curve, retention_at
from hook_score_core import percentile, row_unit


EPS = 1e-9
QUALITY_SEED = 20260712
RETENTION_FEATURES = (
    "endpoint_normalized_retention_3s",
    "endpoint_normalized_retention_5s",
    "endpoint_normalized_retention_8s",
    "endpoint_normalized_retention_10s",
    "endpoint_normalized_retention_at_hook_end",
    "mean_endpoint_normalized_retention_hook_end_to_plus_5s",
)
DIMENSIONS = (4, 8, 16, 32, 64)
ALPHAS = (.1, 1.0, 10.0, 100.0)


def retention_inputs(corpus: list[dict], token_counts: np.ndarray) -> dict:
    count = len(corpus)
    matrix = np.full((count, len(RETENTION_FEATURES)), np.nan, np.float32)
    confounds = np.full((count, 7), np.nan, np.float32)
    normalized_curves = []
    meta_rows = []
    for index, row in enumerate(corpus):
        curve, meta = endpoint_normalize_curve(row.get("curve") or [])
        normalized_curves.append(curve)
        meta_rows.append(meta)
        duration = float(row.get("duration_s") or np.nan)
        hook_end = float(row.get("hookEndSec") or np.nan)
        if len(curve):
            for column, second in enumerate((3.0, 5.0, 8.0, 10.0)):
                matrix[index, column] = retention_at(curve, duration, second)
            matrix[index, 4] = retention_at(curve, duration, hook_end)
            if np.isfinite(duration + hook_end) and hook_end + 5 <= duration:
                values = [retention_at(curve, duration, second)
                          for second in np.linspace(hook_end, hook_end + 5, 21)]
                matrix[index, 5] = float(np.mean(values))
        confounds[index] = [
            float(token_counts[index]), duration, hook_end,
            float(row.get("keep_rate") or np.nan),
            float(meta.get("entry", np.nan)), float(meta.get("terminal", np.nan)),
            float(meta.get("amplitude", np.nan)),
        ]
    return {
        "retentionMatrix": matrix,
        "confounds": confounds,
        "normalizedCurves": normalized_curves,
        "curveMeta": meta_rows,
        "confoundNames": [
            "token_count", "video_duration", "hook_end_seconds", "viewed_percentage",
            "entry_retention", "terminal_retention", "entry_terminal_amplitude",
        ],
    }


def _impute(train: np.ndarray, test: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    median = np.nanmedian(np.where(np.isfinite(train), train, np.nan), axis=0)
    median = np.where(np.isfinite(median), median, 0)
    return (
        np.where(np.isfinite(train), train, median),
        np.where(np.isfinite(test), test, median),
        median,
    )


@dataclass
class FittedAxis:
    predictions: np.ndarray
    target_residual: np.ndarray
    direction: np.ndarray
    offset: float
    target_meta: dict


def _fit_axis(train: np.ndarray, test: np.ndarray, features: np.ndarray,
              retention: np.ndarray, confounds: np.ndarray,
              dimensions: int, alpha: float) -> FittedAxis:
    train_retention, test_retention, retention_median = _impute(retention[train], retention[test])
    retention_scaler = StandardScaler().fit(train_retention)
    train_retention_z = retention_scaler.transform(train_retention)
    test_retention_z = retention_scaler.transform(test_retention)
    target_pca = PCA(n_components=1, svd_solver="full").fit(train_retention_z)
    orientation = 1.0 if float(target_pca.components_[0].sum()) >= 0 else -1.0
    train_target = target_pca.transform(train_retention_z)[:, 0] * orientation
    test_target = target_pca.transform(test_retention_z)[:, 0] * orientation

    train_confounds, test_confounds, confound_median = _impute(confounds[train], confounds[test])
    confound_scaler = StandardScaler().fit(train_confounds)
    train_confounds_z = confound_scaler.transform(train_confounds)
    test_confounds_z = confound_scaler.transform(test_confounds)
    confound_model = Ridge(alpha=1.0).fit(train_confounds_z, train_target)
    train_target_residual = train_target - confound_model.predict(train_confounds_z)
    test_target_residual = test_target - confound_model.predict(test_confounds_z)

    dimension = max(1, min(int(dimensions), len(train) - 1, features.shape[1]))
    feature_pca = PCA(n_components=dimension, svd_solver="randomized", random_state=1729)
    train_scores = feature_pca.fit_transform(features[train])
    test_scores = feature_pca.transform(features[test])
    feature_scaler = StandardScaler().fit(train_scores)
    train_scores_z = feature_scaler.transform(train_scores)
    test_scores_z = feature_scaler.transform(test_scores)
    model = Ridge(alpha=float(alpha)).fit(train_scores_z, train_target_residual)
    prediction = model.predict(test_scores_z)
    scaled_coefficient = model.coef_ / (feature_scaler.scale_ + EPS)
    direction = feature_pca.components_.T @ scaled_coefficient
    offset = float(model.intercept_ - (
        feature_pca.mean_ @ feature_pca.components_.T + feature_scaler.mean_
    ) @ scaled_coefficient)
    return FittedAxis(
        prediction.astype(np.float32), test_target_residual.astype(np.float32),
        direction.astype(np.float32), offset,
        {
            "retentionMedian": retention_median.astype(float).tolist(),
            "retentionMean": retention_scaler.mean_.astype(float).tolist(),
            "retentionScale": retention_scaler.scale_.astype(float).tolist(),
            "retentionFactorLoadings": (target_pca.components_[0] * orientation).astype(float).tolist(),
            "retentionFactorExplainedVariance": float(target_pca.explained_variance_ratio_[0]),
            "confoundMedian": confound_median.astype(float).tolist(),
        },
    )


def _inner_score(train: np.ndarray, features: np.ndarray, retention: np.ndarray,
                 confounds: np.ndarray, dimensions: int, alpha: float) -> float:
    predictions = np.full(len(train), np.nan, np.float32)
    targets = np.full(len(train), np.nan, np.float32)
    splitter = KFold(n_splits=4, shuffle=True, random_state=QUALITY_SEED + len(train))
    for inner_train_local, inner_test_local in splitter.split(train):
        inner_train = train[inner_train_local]
        inner_test = train[inner_test_local]
        fitted = _fit_axis(inner_train, inner_test, features, retention, confounds, dimensions, alpha)
        predictions[inner_test_local] = fitted.predictions
        targets[inner_test_local] = fitted.target_residual
    return spearman(predictions, targets)


def select_full_configuration(features: np.ndarray, retention: np.ndarray,
                              confounds: np.ndarray) -> dict:
    """Select the deployable configuration after nested validation is complete."""
    indices = np.arange(len(features))
    rows = []
    for dimensions in DIMENSIONS:
        for alpha in ALPHAS:
            rows.append({
                "dimensions": int(dimensions),
                "alpha": float(alpha),
                "crossvalidatedSpearman": _inner_score(
                    indices, row_unit(features), retention, confounds, dimensions, alpha,
                ),
            })
    selected = max(rows, key=lambda row: (
        row["crossvalidatedSpearman"], -row["dimensions"], -row["alpha"]
    ))
    return {"selected": selected, "configurations": rows}


def nested_axis_validation(features: np.ndarray, retention: np.ndarray,
                           confounds: np.ndarray, folds: int = 5,
                           null_repeats: int = 4096) -> dict:
    features = row_unit(features)
    indices = np.arange(len(features))
    predictions = np.full(len(features), np.nan, np.float32)
    axis_coordinates = np.full(len(features), np.nan, np.float32)
    axis_percentiles = np.full(len(features), np.nan, np.float32)
    targets = np.full(len(features), np.nan, np.float32)
    fold_index = np.full(len(features), -1, np.int16)
    fold_directions = []
    fold_rows = []
    outer = KFold(n_splits=folds, shuffle=True, random_state=QUALITY_SEED)
    for current_fold, (train, test) in enumerate(outer.split(indices)):
        configuration_rows = []
        for dimensions in DIMENSIONS:
            for alpha in ALPHAS:
                configuration_rows.append({
                    "dimensions": dimensions,
                    "alpha": alpha,
                    "innerSpearman": _inner_score(
                        train, features, retention, confounds, dimensions, alpha,
                    ),
                })
        selected = max(configuration_rows, key=lambda row: (
            row["innerSpearman"], -row["dimensions"], -row["alpha"]
        ))
        fitted = _fit_axis(
            train, test, features, retention, confounds,
            selected["dimensions"], selected["alpha"],
        )
        predictions[test] = fitted.predictions
        targets[test] = fitted.target_residual
        fold_index[test] = current_fold
        direction = fitted.direction / (np.linalg.norm(fitted.direction) + EPS)
        train_coordinate = features[train] @ direction
        if spearman(train_coordinate, _fit_axis(
            train, train, features, retention, confounds,
            selected["dimensions"], selected["alpha"],
        ).target_residual) < 0:
            direction = -direction
            train_coordinate = -train_coordinate
        test_coordinate = features[test] @ direction
        sorted_train = np.sort(train_coordinate)
        test_percentile = np.asarray([
            percentile(sorted_train, float(value)) for value in test_coordinate
        ], np.float32)
        axis_coordinates[test] = test_coordinate
        axis_percentiles[test] = test_percentile
        fold_directions.append(direction.astype(np.float32))
        fold_rows.append({
            "fold": current_fold,
            "train": len(train),
            "test": len(test),
            "selectedDimensions": selected["dimensions"],
            "selectedAlpha": selected["alpha"],
            "innerSpearman": selected["innerSpearman"],
            "direction": direction.astype(float).tolist(),
            "trainingProjectionSorted": sorted_train.astype(float).tolist(),
        })
    rho = spearman(axis_percentiles, targets)
    pearson = finite_correlation(axis_percentiles, targets)
    model_rho = spearman(predictions, targets)
    model_pearson = finite_correlation(predictions, targets)
    valid = np.isfinite(axis_percentiles + predictions + targets)
    r2 = float(r2_score(targets[valid], predictions[valid]))
    ranked_prediction = rankdata(axis_percentiles[valid]).astype(float)
    ranked_target = rankdata(targets[valid]).astype(float)
    ranked_prediction = (ranked_prediction - ranked_prediction.mean()) / (ranked_prediction.std() + EPS)
    ranked_target = (ranked_target - ranked_target.mean()) / (ranked_target.std() + EPS)
    rng = np.random.default_rng(QUALITY_SEED)
    signs = rng.choice((-1.0, 1.0), size=(null_repeats, valid.sum()))
    null = np.abs((signs * ranked_target[None, :]) @ ranked_prediction / valid.sum())
    pvalue = float((1 + np.sum(null >= abs(rho))) / (null_repeats + 1))
    cosines = []
    for left in range(len(fold_directions)):
        for right in range(left + 1, len(fold_directions)):
            cosines.append(float(fold_directions[left] @ fold_directions[right]))
    return {
        "predictions": predictions,
        "axisCoordinates": axis_coordinates,
        "axisPercentiles": axis_percentiles,
        "targets": targets,
        "foldIndex": fold_index,
        "folds": fold_rows,
        "heldoutSpearman": rho,
        "heldoutPearson": pearson,
        "ridgeHeldoutSpearman": model_rho,
        "ridgeHeldoutPearson": model_pearson,
        "ridgeHeldoutR2": r2,
        "signFlipP": pvalue,
        "nullRepeats": null_repeats,
        "foldDirectionMedianCosine": float(np.median(cosines)),
        "foldDirectionPositiveFraction": float(np.mean(np.asarray(cosines) > 0)),
    }


def fit_full_axis(features: np.ndarray, retention: np.ndarray, confounds: np.ndarray,
                  dimensions: int, alpha: float) -> dict:
    indices = np.arange(len(features))
    fitted = _fit_axis(indices, indices, row_unit(features), retention, confounds, dimensions, alpha)
    direction = fitted.direction / (np.linalg.norm(fitted.direction) + EPS)
    projections = row_unit(features) @ direction
    if spearman(projections, fitted.target_residual) < 0:
        direction = -direction
        projections = -projections
    return {
        "direction": direction.astype(np.float32),
        "offset": fitted.offset,
        "trainingProjections": projections.astype(np.float32),
        "targetMeta": fitted.target_meta,
    }


def bootstrap_directions(features: np.ndarray, retention: np.ndarray, confounds: np.ndarray,
                         dimensions: int, alpha: float, repeats: int = 128) -> np.ndarray:
    features = row_unit(features)
    full = fit_full_axis(features, retention, confounds, dimensions, alpha)["direction"]
    rng = np.random.default_rng(QUALITY_SEED + 91)
    output = []
    for _ in range(repeats):
        sample = rng.integers(0, len(features), size=len(features))
        fitted = _fit_axis(
            sample, sample, features, retention, confounds, dimensions, alpha,
        )
        direction = fitted.direction / (np.linalg.norm(fitted.direction) + EPS)
        if float(direction @ full) < 0:
            direction = -direction
        output.append(direction.astype(np.float32))
    return np.asarray(output, np.float32)
