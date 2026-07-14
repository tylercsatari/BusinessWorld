"""Leakage-safe forward retention-response models for canonical hook components."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler
from sklearn.utils.extmath import randomized_svd, svd_flip

from axes import finite_correlation, spearman
from hook_score_core import combined_component_features


EPS = 1e-9
FORWARD_SEED = 20260712
FIXED_DIMENSIONS = 16
FIXED_SEMANTIC_ALPHA = 10.0
FIXED_BASELINE_ALPHA = 10.0
MIN_CATEGORY_SOURCES = 8


class _WeightedProjection:
    """Small PCA-compatible projection fitted with explicit row weights."""

    def __init__(self, mean: np.ndarray, components: np.ndarray):
        self.mean_ = np.asarray(mean, np.float32)
        self.components_ = np.asarray(components, np.float32)

    def transform(self, values: np.ndarray) -> np.ndarray:
        return (
            (np.asarray(values, np.float32) - self.mean_)
            @ self.components_.T
        ).astype(np.float32)


class _WeightedScaler:
    """StandardScaler-compatible transform with source-weighted moments."""

    def __init__(self, mean: np.ndarray, scale: np.ndarray):
        self.mean_ = np.asarray(mean, np.float32)
        self.scale_ = np.asarray(scale, np.float32)

    def transform(self, values: np.ndarray) -> np.ndarray:
        return (
            (np.asarray(values, np.float32) - self.mean_)
            / np.maximum(self.scale_, EPS)
        ).astype(np.float32)


@dataclass(frozen=True)
class ResponseCandidate:
    id: str
    label: str
    anchor: str
    width: float | None
    lag: float

    @property
    def definition(self) -> str:
        if self.anchor == "phrase":
            return (
                "least-squares slope across the declared resolved component interval, "
                f"shifted forward {self.lag:g}s"
            )
        return (
            f"least-squares slope over {float(self.width or 0):g}s beginning "
            f"{self.lag:g}s after the component ends"
        )


def response_candidates(lags: tuple[float, ...] | None = None) -> list[ResponseCandidate]:
    """Predeclared forward-only candidates; reverse-time lags are controls elsewhere."""
    values = lags or tuple(np.arange(0.0, 5.0001, .5).astype(float))
    output = []
    for lag in values:
        suffix = str(float(lag)).replace(".", "p")
        output.extend([
            ResponseCandidate(f"phrase_lag_{suffix}", f"spoken interval +{lag:g}s", "phrase", None, lag),
            ResponseCandidate(f"after_end_1s_lag_{suffix}", f"1s after end +{lag:g}s", "offset", 1.0, lag),
            ResponseCandidate(f"after_end_2s_lag_{suffix}", f"2s after end +{lag:g}s", "offset", 2.0, lag),
        ])
    return output


def candidate_intervals(starts: np.ndarray, ends: np.ndarray,
                        candidate: ResponseCandidate) -> tuple[np.ndarray, np.ndarray]:
    starts = np.asarray(starts, float)
    ends = np.asarray(ends, float)
    if candidate.anchor == "phrase":
        return starts + candidate.lag, ends + candidate.lag
    if candidate.anchor == "offset":
        left = ends + candidate.lag
        return left, left + float(candidate.width or 0)
    raise ValueError(f"unknown response anchor: {candidate.anchor}")


def row_unit(values: np.ndarray) -> np.ndarray:
    matrix = np.asarray(values, np.float32)
    if matrix.ndim == 1:
        return matrix / (np.linalg.norm(matrix) + EPS)
    return matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + EPS)


def interaction_features(pair: np.ndarray, left: np.ndarray, right: np.ndarray) -> np.ndarray:
    """Non-additive pair geometry after removing the two singleton embeddings."""
    pair = row_unit(pair)
    additive = row_unit(row_unit(left) + row_unit(right))
    residual = pair - additive
    norms = np.linalg.norm(residual, axis=1, keepdims=True)
    return np.where(norms > 1e-6, residual / np.maximum(norms, EPS), 0).astype(np.float32)


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    values = np.asarray(values, float)
    weights = np.asarray(weights, float)
    order = np.argsort(values, kind="mergesort")
    values = values[order]
    weights = weights[order]
    midpoint = float(weights.sum()) / 2.0
    return float(values[min(np.searchsorted(np.cumsum(weights), midpoint), len(values) - 1)])


def _impute_scale(train: np.ndarray, test: np.ndarray,
                  weights: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, dict]:
    train = np.asarray(train, np.float32)
    test = np.asarray(test, np.float32)
    weights = (
        np.ones(len(train), np.float32)
        if weights is None else np.asarray(weights, np.float32)
    )
    if len(weights) != len(train) or not np.isfinite(weights).all() or weights.sum() <= 0:
        raise ValueError("scaling weights do not match the training rows")
    median = np.zeros(train.shape[1], np.float32)
    for column in range(train.shape[1]):
        valid = np.isfinite(train[:, column])
        values = train[valid, column]
        if len(values):
            median[column] = _weighted_median(values, weights[valid])
    train = np.where(np.isfinite(train), train, median)
    test = np.where(np.isfinite(test), test, median)
    normalized_weights = weights / weights.sum()
    mean = np.sum(train * normalized_weights[:, None], axis=0)
    variance = np.sum(
        (train - mean) ** 2 * normalized_weights[:, None], axis=0,
    )
    scaler = _WeightedScaler(mean, np.sqrt(np.maximum(variance, EPS)))
    return scaler.transform(train), scaler.transform(test), {
        "median": median.astype(float).tolist(),
        "mean": scaler.mean_.astype(float).tolist(),
        "scale": scaler.scale_.astype(float).tolist(),
        "rowWeighting": "each source video has equal total weight when groups are supplied",
    }


def _fit_weighted_projection(values: np.ndarray, dimensions: int,
                             weights: np.ndarray | None, seed: int) -> _WeightedProjection:
    values = np.asarray(values, np.float32)
    weights = (
        np.ones(len(values), np.float32)
        if weights is None else np.asarray(weights, np.float32)
    )
    if len(weights) != len(values) or weights.sum() <= 0:
        raise ValueError("projection weights do not match the training rows")
    normalized = weights / weights.sum()
    mean = np.sum(values * normalized[:, None], axis=0)
    centered = values - mean
    requested = max(1, min(int(dimensions), len(values) - 1, values.shape[1]))
    weighted = centered * np.sqrt(normalized[:, None])
    left, _, components = randomized_svd(
        weighted, n_components=requested, random_state=int(seed),
    )
    _, components = svd_flip(left, components)
    return _WeightedProjection(mean, components)


def _fit_weighted_scaler(values: np.ndarray,
                         weights: np.ndarray | None) -> _WeightedScaler:
    values = np.asarray(values, np.float32)
    weights = (
        np.ones(len(values), np.float32)
        if weights is None else np.asarray(weights, np.float32)
    )
    if len(weights) != len(values) or weights.sum() <= 0:
        raise ValueError("score weights do not match the training rows")
    normalized = weights / weights.sum()
    mean = np.sum(values * normalized[:, None], axis=0)
    variance = np.sum(
        (values - mean) ** 2 * normalized[:, None], axis=0,
    )
    return _WeightedScaler(mean, np.sqrt(np.maximum(variance, EPS)))


def source_equal_weights(groups: np.ndarray) -> np.ndarray:
    """Give every source video equal total weight without duplicating rows."""
    groups = np.asarray(groups).astype(str)
    if not len(groups):
        return np.asarray([], np.float32)
    _, inverse, counts = np.unique(groups, return_inverse=True, return_counts=True)
    weights = 1.0 / counts[inverse]
    weights *= len(weights) / max(float(weights.sum()), EPS)
    return weights.astype(np.float32)


def weighted_rankdata(values: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """Weighted mid-distribution ranks so repeated rows cannot move source mass."""
    values = np.asarray(values, float)
    weights = np.asarray(weights, float)
    if len(values) != len(weights) or not len(values):
        raise ValueError("rank values and weights must have the same nonzero length")
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(len(values), float)
    cumulative = 0.0
    cursor = 0
    while cursor < len(order):
        finish = cursor + 1
        while finish < len(order) and values[order[finish]] == values[order[cursor]]:
            finish += 1
        tied = order[cursor:finish]
        mass = float(weights[tied].sum())
        ranks[tied] = cumulative + mass / 2.0
        cumulative += mass
        cursor = finish
    return ranks / max(cumulative, EPS)


def weighted_spearman(prediction: np.ndarray, target: np.ndarray,
                      groups: np.ndarray | None = None) -> float:
    """Spearman correlation with equal total weight per source video."""
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    valid = np.isfinite(prediction + target)
    if valid.sum() < 3:
        return float("nan")
    prediction = prediction[valid]
    target = target[valid]
    if groups is None:
        weights = np.ones(len(prediction), float)
    else:
        weights = source_equal_weights(np.asarray(groups).astype(str)[valid]).astype(float)
    left = weighted_rankdata(prediction, weights)
    right = weighted_rankdata(target, weights)
    weights /= max(float(weights.sum()), EPS)
    left -= float(np.sum(weights * left))
    right -= float(np.sum(weights * right))
    left_scale = math.sqrt(float(np.sum(weights * left ** 2)))
    right_scale = math.sqrt(float(np.sum(weights * right ** 2)))
    if left_scale <= EPS or right_scale <= EPS:
        return float("nan")
    return float(np.sum(weights * left * right) / (left_scale * right_scale))


def _shared_natural_residuals(train: np.ndarray, test: np.ndarray,
                              target: np.ndarray, natural: np.ndarray,
                              groups: np.ndarray,
                              baseline_alpha: float) -> tuple[np.ndarray, np.ndarray, dict]:
    """Fit one category-blind natural-drop model on outer-training sources only."""
    target = np.asarray(target, float)
    natural = np.asarray(natural, np.float32)
    groups = np.asarray(groups).astype(str)
    train = np.asarray(train, int)
    test = np.asarray(test, int)
    if np.intersect1d(train, test).size:
        raise ValueError("natural baseline train and test rows overlap")
    valid_train = np.isfinite(target[train])
    valid_test = np.isfinite(target[test])
    fit = train[valid_train]
    evaluate = test[valid_test]
    train_residual = np.full(len(target), np.nan, np.float32)
    test_residual = np.full(len(target), np.nan, np.float32)
    baseline_prediction = np.full(len(target), np.nan, np.float32)
    if len(fit) < 8 or not len(evaluate):
        return train_residual, test_residual, {
            "prediction": baseline_prediction,
            "fitRows": int(len(fit)),
            "fitSources": int(len(set(groups[fit]))),
            "categoryBlind": True,
            "sourceWeighting": "each source video has equal total weight",
            "trainResidual": train_residual,
            "testResidual": test_residual,
        }
    natural_train, natural_test, transform = _impute_scale(
        natural[fit], natural[evaluate], source_equal_weights(groups[fit]),
    )
    model = Ridge(alpha=float(baseline_alpha)).fit(
        natural_train, target[fit], sample_weight=source_equal_weights(groups[fit]),
    )
    train_prediction = model.predict(natural_train)
    test_prediction = model.predict(natural_test)
    train_residual[fit] = (target[fit] - train_prediction).astype(np.float32)
    test_residual[evaluate] = (target[evaluate] - test_prediction).astype(np.float32)
    baseline_prediction[evaluate] = test_prediction.astype(np.float32)
    return train_residual, test_residual, {
        "prediction": baseline_prediction,
        "fitRows": int(len(fit)),
        "fitSources": int(len(set(groups[fit]))),
        "ridgeAlpha": float(baseline_alpha),
        "sourceWeighting": "each source video has equal total weight",
        "categoryBlind": True,
        "transform": transform,
        "trainResidual": train_residual,
        "testResidual": test_residual,
    }


def _fit_fold(features: np.ndarray, target: np.ndarray, natural: np.ndarray,
              train: np.ndarray, test: np.ndarray, dimensions: int,
              semantic_alpha: float, baseline_alpha: float,
              seed: int) -> dict:
    target = np.asarray(target, float)
    natural = np.asarray(natural, np.float32)
    valid_train = np.isfinite(target[train]) & np.all(np.isfinite(features[train]), axis=1)
    valid_test = np.isfinite(target[test]) & np.all(np.isfinite(features[test]), axis=1)
    fit = train[valid_train]
    evaluate = test[valid_test]
    if len(fit) < max(8, dimensions + 2) or not len(evaluate):
        return {"test": np.asarray([], int), "prediction": np.asarray([]), "target": np.asarray([])}

    natural_train, natural_test, _ = _impute_scale(natural[fit], natural[evaluate])
    baseline = Ridge(alpha=float(baseline_alpha)).fit(natural_train, target[fit])
    train_residual = target[fit] - baseline.predict(natural_train)
    test_residual = target[evaluate] - baseline.predict(natural_test)

    dimension = min(int(dimensions), len(fit) - 1, features.shape[1])
    reducer = PCA(
        n_components=max(1, dimension), svd_solver="randomized", random_state=seed,
    ).fit(features[fit])
    train_scores = reducer.transform(features[fit])
    test_scores = reducer.transform(features[evaluate])
    score_scaler = StandardScaler().fit(train_scores)
    train_scores = score_scaler.transform(train_scores)
    test_scores = score_scaler.transform(test_scores)
    semantic = Ridge(alpha=float(semantic_alpha)).fit(train_scores, train_residual)
    coefficient = reducer.components_.T @ (
        semantic.coef_ / np.maximum(score_scaler.scale_, EPS)
    )
    return {
        "test": evaluate,
        "prediction": semantic.predict(test_scores).astype(np.float32),
        "target": test_residual.astype(np.float32),
        "direction": row_unit(coefficient).astype(np.float32),
    }


def _prepare_category_fold(features: np.ndarray, train: np.ndarray, test: np.ndarray,
                           categories: np.ndarray, dimensions: int,
                           seed: int, groups: np.ndarray | None = None) -> list[dict]:
    """Prepare outcome-blind semantic coordinates once for every candidate ruler."""
    output = []
    for category in sorted(set(categories)):
        fit = train[categories[train] == category]
        evaluate = test[categories[test] == category]
        if len(fit) < max(8, dimensions + 2) or not len(evaluate):
            continue
        dimension = min(int(dimensions), len(fit) - 1, features.shape[1])
        weights = (
            source_equal_weights(np.asarray(groups)[fit])
            if groups is not None else None
        )
        reducer = _fit_weighted_projection(
            features[fit], dimension, weights, seed + int(category),
        )
        train_scores = reducer.transform(features[fit])
        test_scores = reducer.transform(features[evaluate])
        scaler = _fit_weighted_scaler(train_scores, weights)
        output.append({
            "category": int(category),
            "train": fit,
            "test": evaluate,
            "trainScores": scaler.transform(train_scores).astype(np.float32),
            "testScores": scaler.transform(test_scores).astype(np.float32),
            "reducer": reducer,
            "scaler": scaler,
        })
    return output


def _predict_prepared(prepared: list[dict], target: np.ndarray,
                      natural: np.ndarray, semantic_alpha: float,
                      baseline_alpha: float, groups: np.ndarray | None = None,
                      shared_natural_baseline: bool = False,
                      outer_train: np.ndarray | None = None,
                      outer_test: np.ndarray | None = None,
                      ) -> tuple[np.ndarray, np.ndarray, dict]:
    prediction = np.full(len(target), np.nan, np.float32)
    residual = np.full(len(target), np.nan, np.float32)
    baseline_meta = {"categoryBlind": False}
    shared_train = shared_test = None
    if shared_natural_baseline:
        if groups is None:
            raise ValueError("shared natural baseline requires source groups")
        if outer_train is None or outer_test is None:
            if not prepared:
                raise ValueError("shared natural baseline requires a non-empty fold")
            outer_train = np.unique(np.concatenate([
                row["train"] for row in prepared
            ])).astype(int)
            outer_test = np.unique(np.concatenate([
                row["test"] for row in prepared
            ])).astype(int)
        shared_train, shared_test, baseline_meta = _shared_natural_residuals(
            outer_train, outer_test, target, natural, groups, baseline_alpha,
        )
    for row in prepared:
        train = row["train"]
        test = row["test"]
        valid_train = np.isfinite(shared_train[train] if shared_natural_baseline else target[train])
        valid_test = np.isfinite(shared_test[test] if shared_natural_baseline else target[test])
        if valid_train.sum() < 8 or not valid_test.any():
            continue
        fit = train[valid_train]
        evaluate = test[valid_test]
        if shared_natural_baseline:
            train_residual = shared_train[fit]
            test_residual = shared_test[evaluate]
        else:
            natural_train, natural_test, _ = _impute_scale(
                natural[fit], natural[evaluate],
                source_equal_weights(np.asarray(groups)[fit])
                if groups is not None else None,
            )
            baseline = Ridge(alpha=float(baseline_alpha)).fit(
                natural_train, target[fit],
                sample_weight=(
                    source_equal_weights(np.asarray(groups)[fit])
                    if groups is not None else None
                ),
            )
            train_residual = target[fit] - baseline.predict(natural_train)
            test_residual = target[evaluate] - baseline.predict(natural_test)
        semantic_weights = (
            source_equal_weights(np.asarray(groups)[fit])
            if groups is not None else None
        )
        semantic = Ridge(alpha=float(semantic_alpha)).fit(
            row["trainScores"][valid_train], train_residual,
            sample_weight=semantic_weights,
        )
        prediction[evaluate] = semantic.predict(
            row["testScores"][valid_test]
        ).astype(np.float32)
        residual[evaluate] = test_residual.astype(np.float32)
    return prediction, residual, baseline_meta


def category_balanced_spearman(prediction: np.ndarray, target: np.ndarray,
                               categories: np.ndarray,
                               groups: np.ndarray | None = None,
                               minimum_sources: int = 3,
                               required_categories: tuple[int, ...] | None = None,
                               ) -> tuple[float, dict[str, float | None]]:
    """Equal-category Fisher mean with equal total weight per source in each category."""
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    categories = np.asarray(categories, int)
    source_groups = (
        np.arange(len(categories)).astype(str)
        if groups is None else np.asarray(groups).astype(str)
    )
    by_category = {}
    fisher = []
    expected = (
        tuple(sorted(set(categories)))
        if required_categories is None else tuple(required_categories)
    )
    for category in expected:
        selected = categories == category
        finite = selected & np.isfinite(prediction + target)
        if len(set(source_groups[finite])) < int(minimum_sources):
            by_category[str(int(category))] = None
            continue
        value = weighted_spearman(
            prediction[selected], target[selected],
            source_groups[selected],
        )
        by_category[str(int(category))] = float(value) if np.isfinite(value) else None
        if np.isfinite(value):
            fisher.append(np.arctanh(np.clip(value, -.999999, .999999)))
    balanced = (
        float(np.tanh(np.mean(fisher)))
        if len(fisher) == len(expected) and fisher else float("nan")
    )
    return balanced, by_category


def crossfit_category_axis(features: np.ndarray, target: np.ndarray,
                           natural: np.ndarray, groups: np.ndarray,
                           categories: np.ndarray, folds: int = 5,
                           dimensions: int = FIXED_DIMENSIONS,
                           semantic_alpha: float = FIXED_SEMANTIC_ALPHA,
                           baseline_alpha: float = FIXED_BASELINE_ALPHA,
                           seed: int = FORWARD_SEED,
                           outer_splits: list[tuple[np.ndarray, np.ndarray]] | None = None,
                           validation_design: str = "deterministic source-group GroupKFold",
                           shared_natural_baseline: bool = False) -> dict:
    features = np.asarray(features, np.float32)
    groups = np.asarray(groups).astype(str)
    categories = np.asarray(categories, int)
    prediction = np.full(len(groups), np.nan, np.float32)
    residual = np.full(len(groups), np.nan, np.float32)
    fold_index = np.full(len(groups), -1, np.int16)
    direction_rows: dict[str, list[np.ndarray]] = {}
    baseline_prediction = np.full(len(groups), np.nan, np.float32)
    baseline_rows = []
    splits = outer_splits
    if splits is None:
        splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
        splits = list(splitter.split(np.arange(len(groups)), groups=groups))
    for fold, (train, test) in enumerate(splits):
        train = np.asarray(train, int)
        test = np.asarray(test, int)
        prepared = _prepare_category_fold(
            features, train, test, categories, dimensions, seed + fold * 101,
            groups=groups,
        )
        fold_prediction, fold_residual, baseline_meta = _predict_prepared(
            prepared, target, natural, semantic_alpha, baseline_alpha,
            groups=groups, shared_natural_baseline=shared_natural_baseline,
            outer_train=train, outer_test=test,
        )
        selected = np.isfinite(fold_prediction + fold_residual)
        prediction[selected] = fold_prediction[selected]
        residual[selected] = fold_residual[selected]
        fold_index[selected] = fold
        fold_baseline = np.asarray(
            baseline_meta.get("prediction", np.asarray([])), float,
        )
        if fold_baseline.ndim == 1 and len(fold_baseline) == len(groups):
            valid_baseline = np.isfinite(fold_baseline)
            baseline_prediction[valid_baseline] = fold_baseline[valid_baseline]
        baseline_rows.append({
            key: value for key, value in baseline_meta.items()
            if key not in {
                "prediction", "transform", "trainResidual", "testResidual",
            }
        })
        shared_train_residual = baseline_meta.get("trainResidual")
        for row in prepared:
            train_positions = row["train"]
            train_target = (
                np.asarray(shared_train_residual)[train_positions]
                if shared_natural_baseline else target[train_positions]
            )
            valid = np.isfinite(train_target)
            if valid.sum() < 8:
                continue
            if shared_natural_baseline:
                train_residual = train_target[valid]
            else:
                natural_train, _, _ = _impute_scale(
                    natural[train_positions][valid], natural[train_positions][valid],
                    source_equal_weights(groups[train_positions][valid]),
                )
                baseline = Ridge(alpha=float(baseline_alpha)).fit(
                    natural_train, target[train_positions][valid],
                    sample_weight=source_equal_weights(groups[train_positions][valid]),
                )
                train_residual = target[train_positions][valid] - baseline.predict(natural_train)
            semantic = Ridge(alpha=float(semantic_alpha)).fit(
                row["trainScores"][valid], train_residual,
                sample_weight=source_equal_weights(groups[train_positions][valid]),
            )
            coefficient = row["reducer"].components_.T @ (
                semantic.coef_ / np.maximum(row["scaler"].scale_, EPS)
            )
            direction_rows.setdefault(str(row["category"]), []).append(row_unit(coefficient))
    balanced, by_category = category_balanced_spearman(
        prediction, residual, categories, groups,
        minimum_sources=MIN_CATEGORY_SOURCES,
        required_categories=tuple(sorted(set(categories))),
    )
    cosines = {}
    for category, directions in direction_rows.items():
        values = []
        for left in range(len(directions)):
            for right in range(left + 1, len(directions)):
                values.append(float(directions[left] @ directions[right]))
        cosines[category] = {
            "median": float(np.median(values)) if values else None,
            "positiveFraction": float(np.mean(np.asarray(values) > 0)) if values else None,
        }
    return {
        "prediction": prediction,
        "targetResidual": residual,
        "foldIndex": fold_index,
        "heldoutSpearman": balanced,
        "heldoutSpearmanByCategory": by_category,
        "foldDirectionStability": cosines,
        "naturalBaselinePrediction": baseline_prediction,
        "naturalBaselineFolds": baseline_rows,
        "naturalBaselineCategoryBlind": bool(shared_natural_baseline),
        "validationDesign": validation_design,
        "evaluatedRows": int(np.isfinite(prediction + residual).sum()),
        "unevaluatedRows": int((~np.isfinite(prediction + residual)).sum()),
    }


def nested_select_candidate(features: np.ndarray,
                            targets: dict[str, np.ndarray],
                            naturals: dict[str, np.ndarray],
                            groups: np.ndarray, categories: np.ndarray,
                            folds: int = 5, inner_folds: int = 4,
                            seed: int = FORWARD_SEED,
                            outer_splits: list[tuple[np.ndarray, np.ndarray]] | None = None,
                            validation_design: str = "nested deterministic source-group GroupKFold",
                            shared_natural_baseline: bool = False) -> dict:
    """Select the response ruler inside each outer training fold, then test once."""
    features = np.asarray(features, np.float32)
    groups = np.asarray(groups).astype(str)
    categories = np.asarray(categories, int)
    candidate_ids = list(targets)
    prediction = np.full(len(groups), np.nan, np.float32)
    residual = np.full(len(groups), np.nan, np.float32)
    baseline_prediction = np.full(len(groups), np.nan, np.float32)
    fold_index = np.full(len(groups), -1, np.int16)
    selected_candidate_by_row = np.full(len(groups), "", dtype=object)
    selected_rows = []
    splits = outer_splits
    if splits is None:
        splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
        splits = list(splitter.split(np.arange(len(groups)), groups=groups))
    for fold, (train, test) in enumerate(splits):
        train = np.asarray(train, int)
        test = np.asarray(test, int)
        inner_splitter = GroupKFold(n_splits=min(inner_folds, len(set(groups[train]))))
        inner_prepared = []
        for inner_fold, (inner_train, inner_test) in enumerate(
            inner_splitter.split(train, groups=groups[train])
        ):
            inner_train_rows = train[inner_train]
            inner_test_rows = train[inner_test]
            inner_prepared.append({
                "prepared": _prepare_category_fold(
                    features, inner_train_rows, inner_test_rows, categories,
                    FIXED_DIMENSIONS, seed + fold * 1009 + inner_fold * 101,
                    groups=groups,
                ),
                "train": inner_train_rows,
                "test": inner_test_rows,
            })
        inner_scores = []
        for candidate_id in candidate_ids:
            inner_prediction = np.full(len(groups), np.nan, np.float32)
            inner_residual = np.full(len(groups), np.nan, np.float32)
            for inner in inner_prepared:
                prepared = inner["prepared"]
                local_prediction, local_residual, _ = _predict_prepared(
                    prepared, targets[candidate_id], naturals[candidate_id],
                    FIXED_SEMANTIC_ALPHA, FIXED_BASELINE_ALPHA,
                    groups=groups,
                    shared_natural_baseline=shared_natural_baseline,
                    outer_train=inner["train"],
                    outer_test=inner["test"],
                )
                selected = np.isfinite(local_prediction + local_residual)
                inner_prediction[selected] = local_prediction[selected]
                inner_residual[selected] = local_residual[selected]
            inner_score, _ = category_balanced_spearman(
                inner_prediction[train], inner_residual[train], categories[train],
                groups[train],
                minimum_sources=MIN_CATEGORY_SOURCES,
                required_categories=tuple(sorted(set(categories))),
            )
            inner_scores.append((float(inner_score), candidate_id))
        supported_scores = [row for row in inner_scores if np.isfinite(row[0])]
        supported_scores.sort(
            key=lambda row: (-row[0], candidate_ids.index(row[1])),
        )
        if not supported_scores:
            selected_rows.append({
                "fold": fold,
                "selectedCandidate": None,
                "innerCategoryBalancedSpearman": None,
                "runnerUpCandidate": None,
                "runnerUpSpearman": None,
                "trainSources": len(set(groups[train])),
                "testSources": len(set(groups[test])),
                "status": "insufficient-independent-video-support",
            })
            continue
        selected_score, selected_id = supported_scores[0]
        outer_prepared = _prepare_category_fold(
            features, train, test, categories, FIXED_DIMENSIONS, seed + fold * 101,
            groups=groups,
        )
        fold_prediction, fold_residual, baseline_meta = _predict_prepared(
            outer_prepared, targets[selected_id], naturals[selected_id],
            FIXED_SEMANTIC_ALPHA, FIXED_BASELINE_ALPHA,
            groups=groups,
            shared_natural_baseline=shared_natural_baseline,
            outer_train=train, outer_test=test,
        )
        selected = np.isfinite(fold_prediction + fold_residual)
        prediction[selected] = fold_prediction[selected]
        residual[selected] = fold_residual[selected]
        fold_index[selected] = fold
        selected_candidate_by_row[selected] = selected_id
        fold_baseline = np.asarray(
            baseline_meta.get("prediction", np.asarray([])), float,
        )
        if fold_baseline.ndim == 1 and len(fold_baseline) == len(groups):
            valid_baseline = np.isfinite(fold_baseline)
            baseline_prediction[valid_baseline] = fold_baseline[valid_baseline]
        selected_rows.append({
            "fold": fold,
            "selectedCandidate": selected_id,
            "innerCategoryBalancedSpearman": selected_score,
            "runnerUpCandidate": supported_scores[1][1] if len(supported_scores) > 1 else None,
            "runnerUpSpearman": supported_scores[1][0] if len(supported_scores) > 1 else None,
            "trainSources": len(set(groups[train])),
            "testSources": len(set(groups[test])),
            "status": "selected-inside-training-fold",
        })
    balanced, by_category = category_balanced_spearman(
        prediction, residual, categories, groups,
        minimum_sources=MIN_CATEGORY_SOURCES,
        required_categories=tuple(sorted(set(categories))),
    )
    counts = {candidate_id: 0 for candidate_id in candidate_ids}
    for row in selected_rows:
        if row["selectedCandidate"] in counts:
            counts[row["selectedCandidate"]] += 1
    supported_fold_count = sum(counts.values())
    final_id = (
        max(candidate_ids, key=lambda value: (counts[value], -candidate_ids.index(value)))
        if supported_fold_count else None
    )
    return {
        "prediction": prediction,
        "targetResidual": residual,
        "naturalBaselinePrediction": baseline_prediction,
        "foldIndex": fold_index,
        "selectedCandidateByRow": selected_candidate_by_row,
        "heldoutSpearman": balanced,
        "heldoutSpearmanByCategory": by_category,
        "folds": selected_rows,
        "selectionCounts": {key: value for key, value in counts.items() if value},
        "tieBreakPolicy": "predeclared candidate order; forward lags are supplied smallest first",
        "selectedCandidate": final_id,
        "selectedFraction": (
            counts[final_id] / supported_fold_count if final_id is not None else 0.0
        ),
        "supportedSelectionFolds": int(supported_fold_count),
        "unsupportedSelectionFolds": int(len(selected_rows) - supported_fold_count),
        "validationDesign": validation_design,
        "evaluatedRows": int(np.isfinite(prediction + residual).sum()),
        "unevaluatedRows": int((~np.isfinite(prediction + residual)).sum()),
    }


def crossfit_axis(features: np.ndarray, target: np.ndarray, natural: np.ndarray,
                  groups: np.ndarray, folds: int = 5,
                  dimensions: int = FIXED_DIMENSIONS,
                  semantic_alpha: float = FIXED_SEMANTIC_ALPHA,
                  baseline_alpha: float = FIXED_BASELINE_ALPHA,
                  seed: int = FORWARD_SEED) -> dict:
    features = np.asarray(features, np.float32)
    groups = np.asarray(groups).astype(str)
    prediction = np.full(len(groups), np.nan, np.float32)
    residual = np.full(len(groups), np.nan, np.float32)
    directions = []
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    for fold, (train, test) in enumerate(splitter.split(np.arange(len(groups)), groups=groups)):
        result = _fit_fold(
            features, target, natural, train, test, dimensions,
            semantic_alpha, baseline_alpha, seed + fold * 101,
        )
        prediction[result["test"]] = result["prediction"]
        residual[result["test"]] = result["target"]
        if "direction" in result:
            directions.append(result["direction"])
    cosines = []
    for left in range(len(directions)):
        for right in range(left + 1, len(directions)):
            cosines.append(float(directions[left] @ directions[right]))
    return {
        "prediction": prediction,
        "targetResidual": residual,
        "heldoutSpearman": spearman(prediction, residual),
        "heldoutPearson": finite_correlation(prediction, residual),
        "foldDirectionMedianCosine": float(np.median(cosines)) if cosines else None,
        "foldDirectionPositiveFraction": float(np.mean(np.asarray(cosines) > 0)) if cosines else None,
    }


def fit_full_axis(features: np.ndarray, target: np.ndarray, natural: np.ndarray,
                  dimensions: int = FIXED_DIMENSIONS,
                  semantic_alpha: float = FIXED_SEMANTIC_ALPHA,
                  baseline_alpha: float = FIXED_BASELINE_ALPHA,
                  seed: int = FORWARD_SEED) -> dict:
    features = np.asarray(features, np.float32)
    target = np.asarray(target, float)
    natural = np.asarray(natural, np.float32)
    valid = np.isfinite(target) & np.all(np.isfinite(features), axis=1)
    positions = np.flatnonzero(valid)
    if len(positions) < max(8, dimensions + 2):
        raise ValueError("insufficient finite rows to fit the forward-response axis")
    natural_scores, _, natural_meta = _impute_scale(natural[positions], natural[positions])
    baseline = Ridge(alpha=float(baseline_alpha)).fit(natural_scores, target[positions])
    residual = target[positions] - baseline.predict(natural_scores)
    dimension = min(int(dimensions), len(positions) - 1, features.shape[1])
    reducer = PCA(
        n_components=max(1, dimension), svd_solver="randomized", random_state=seed,
    ).fit(features[positions])
    pca_scores = reducer.transform(features[positions])
    scaler = StandardScaler().fit(pca_scores)
    scaled = scaler.transform(pca_scores)
    semantic = Ridge(alpha=float(semantic_alpha)).fit(scaled, residual)
    coefficient = reducer.components_.T @ (
        semantic.coef_ / np.maximum(scaler.scale_, EPS)
    )
    direction = row_unit(coefficient)
    projection = features @ direction
    if spearman(projection[positions], residual) < 0:
        direction = -direction
        projection = -projection
    return {
        "direction": direction.astype(np.float32),
        "projection": projection.astype(np.float32),
        "trainingProjectionSorted": np.sort(projection[positions]).astype(np.float32),
        "observedResidual": residual.astype(np.float32),
        "observedPositions": positions.astype(int),
        "fitSpearman": spearman(projection[positions], residual),
        "naturalModel": {
            "coefficient": baseline.coef_.astype(float).tolist(),
            "intercept": float(baseline.intercept_),
            "transform": natural_meta,
        },
    }


def fit_full_category_axes(features: np.ndarray, target: np.ndarray, natural: np.ndarray,
                           categories: np.ndarray, groups: np.ndarray | None = None,
                           shared_natural_baseline: bool = False) -> dict[str, dict]:
    features = np.asarray(features, np.float32)
    target = np.asarray(target, float)
    natural = np.asarray(natural, np.float32)
    categories = np.asarray(categories, int)
    if not shared_natural_baseline:
        output = {}
        for category in sorted(set(categories)):
            selected = np.flatnonzero(categories == category)
            model = fit_full_axis(
                features[selected], target[selected], natural[selected],
                seed=FORWARD_SEED + int(category),
            )
            projection = np.full(len(categories), np.nan, np.float32)
            projection[selected] = model.pop("projection")
            model["projection"] = projection
            model["rowIndices"] = selected.astype(int)
            output[str(int(category))] = model
        return output

    if groups is None:
        raise ValueError("shared full natural baseline requires source groups")
    groups = np.asarray(groups).astype(str)
    valid = np.isfinite(target) & np.all(np.isfinite(features), axis=1)
    positions = np.flatnonzero(valid)
    if len(positions) < max(8, FIXED_DIMENSIONS + 2):
        raise ValueError("insufficient finite rows for a shared natural baseline")
    natural_scores, _, natural_meta = _impute_scale(
        natural[positions], natural[positions], source_equal_weights(groups[positions]),
    )
    baseline = Ridge(alpha=float(FIXED_BASELINE_ALPHA)).fit(
        natural_scores, target[positions],
        sample_weight=source_equal_weights(groups[positions]),
    )
    residual = np.full(len(target), np.nan, np.float32)
    residual[positions] = (
        target[positions] - baseline.predict(natural_scores)
    ).astype(np.float32)
    shared_model = {
        "coefficient": baseline.coef_.astype(float).tolist(),
        "intercept": float(baseline.intercept_),
        "transform": natural_meta,
        "categoryBlind": True,
        "sourceWeighting": "each source video has equal total weight",
        "fitRows": int(len(positions)),
        "fitSources": int(len(set(groups[positions]))),
    }
    output = {}
    for category in sorted(set(categories)):
        selected = np.flatnonzero(categories == category)
        local_valid = np.isfinite(residual[selected]) & np.all(
            np.isfinite(features[selected]), axis=1,
        )
        local_positions = np.flatnonzero(local_valid)
        fit = selected[local_positions]
        dimension = min(FIXED_DIMENSIONS, len(fit) - 1, features.shape[1])
        if len(fit) < max(8, dimension + 2):
            raise ValueError(f"insufficient category {category} rows for full axis")
        weights = source_equal_weights(groups[fit])
        reducer = _fit_weighted_projection(
            features[fit], dimension, weights, FORWARD_SEED + int(category),
        )
        pca_scores = reducer.transform(features[fit])
        scaler = _fit_weighted_scaler(pca_scores, weights)
        semantic = Ridge(alpha=float(FIXED_SEMANTIC_ALPHA)).fit(
            scaler.transform(pca_scores), residual[fit],
            sample_weight=source_equal_weights(groups[fit]),
        )
        coefficient = reducer.components_.T @ (
            semantic.coef_ / np.maximum(scaler.scale_, EPS)
        )
        direction = row_unit(coefficient)
        category_projection = features[selected] @ direction
        if spearman(category_projection[local_positions], residual[fit]) < 0:
            direction = -direction
            category_projection = -category_projection
        projection = np.full(len(categories), np.nan, np.float32)
        projection[selected] = category_projection.astype(np.float32)
        calibration_order = np.argsort(
            category_projection[local_positions], kind="mergesort",
        )
        calibration_weights = source_equal_weights(groups[fit])[calibration_order]
        output[str(int(category))] = {
            "direction": direction.astype(np.float32),
            "projection": projection,
            "trainingProjectionSorted": np.sort(
                category_projection[local_positions]
            ).astype(np.float32),
            "trainingProjectionWeights": calibration_weights.astype(np.float32),
            "observedResidual": residual[fit].astype(np.float32),
            "observedPositions": local_positions.astype(int),
            "fitSpearman": spearman(
                category_projection[local_positions], residual[fit],
            ),
            "naturalModel": shared_model,
            "rowIndices": selected.astype(int),
        }
    return output


def source_signflip(prediction: np.ndarray, target: np.ndarray, groups: np.ndarray,
                    repeats: int = 4096, seed: int = FORWARD_SEED) -> dict:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    valid = np.isfinite(prediction + target)
    prediction = prediction[valid]
    target = target[valid]
    groups = groups[valid]
    weights = source_equal_weights(groups).astype(float)
    x = weighted_rankdata(prediction, weights)
    y = weighted_rankdata(target, weights)
    weights /= max(float(weights.sum()), EPS)
    x -= float(np.sum(weights * x))
    y -= float(np.sum(weights * y))
    x /= math.sqrt(float(np.sum(weights * x ** 2))) + EPS
    y /= math.sqrt(float(np.sum(weights * y ** 2))) + EPS
    unique = sorted(set(groups))
    contributions = np.asarray([
        np.sum(weights[groups == group] * x[groups == group] * y[groups == group])
        for group in unique
    ], float)
    observed = float(contributions.sum())
    rng = np.random.default_rng(seed)
    null = np.empty(repeats, float)
    for start in range(0, repeats, 256):
        count = min(256, repeats - start)
        signs = rng.choice((-1.0, 1.0), size=(count, len(unique)))
        null[start:start + count] = np.abs(signs @ contributions)
    pvalue = float((1 + np.sum(null >= abs(observed))) / (repeats + 1))
    bootstrap = np.empty(repeats, float)
    group_rows = {group: np.flatnonzero(groups == group) for group in unique}
    for index in range(repeats):
        sample = rng.choice(unique, size=len(unique), replace=True)
        positions = np.concatenate([group_rows[group] for group in sample])
        bootstrap_groups = np.concatenate([
            np.repeat(f"{draw}:{group}", len(group_rows[group]))
            for draw, group in enumerate(sample)
        ])
        bootstrap[index] = weighted_spearman(
            prediction[positions], target[positions], bootstrap_groups,
        )
    return {
        "rho": observed,
        "p": pvalue,
        "ciLow": float(np.quantile(bootstrap, .025)),
        "ciHigh": float(np.quantile(bootstrap, .975)),
        "sourceVideos": len(unique),
        "repeats": int(repeats),
        "policy": (
            "source-video sign flips and source-video bootstrap on source-equal "
            "weighted Spearman ranks"
        ),
    }


def category_balanced_source_inference(prediction: np.ndarray, target: np.ndarray,
                                       groups: np.ndarray, categories: np.ndarray,
                                       repeats: int = 4096,
                                       seed: int = FORWARD_SEED) -> dict:
    """Cluster inference for the exact equal-category Fisher-mean statistic."""
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    categories = np.asarray(categories, int)
    expected_categories = tuple(sorted(set(categories)))
    valid = np.isfinite(prediction + target)
    prediction = prediction[valid]
    target = target[valid]
    groups = groups[valid]
    categories = categories[valid]
    unique = np.asarray(sorted(set(groups)))
    group_index = {group: index for index, group in enumerate(unique)}
    contribution_rows = []
    observed_by_category = {}
    available_categories = []
    for category in expected_categories:
        selected = categories == category
        if len(set(groups[selected])) < MIN_CATEGORY_SOURCES:
            observed_by_category[str(int(category))] = None
            contribution_rows.append(np.zeros(len(unique), float))
            available_categories.append(False)
            continue
        available_categories.append(True)
        category_groups = groups[selected]
        weights = source_equal_weights(category_groups).astype(float)
        x = weighted_rankdata(prediction[selected], weights)
        y = weighted_rankdata(target[selected], weights)
        weights /= max(float(weights.sum()), EPS)
        x -= float(np.sum(weights * x))
        y -= float(np.sum(weights * y))
        x /= math.sqrt(float(np.sum(weights * x ** 2))) + EPS
        y /= math.sqrt(float(np.sum(weights * y ** 2))) + EPS
        contributions = np.zeros(len(unique), float)
        for value, group in zip(weights * x * y, category_groups):
            contributions[group_index[group]] += value
        rho = float(contributions.sum())
        observed_by_category[str(int(category))] = rho
        contribution_rows.append(contributions)
    observed = (
        float(np.tanh(np.mean([
            np.arctanh(np.clip(value, -.999999, .999999))
            for value in observed_by_category.values() if value is not None
        ]))) if all(available_categories) else float("nan")
    )
    if not np.isfinite(observed):
        return {
            "rho": None,
            "rhoByCategory": observed_by_category,
            "p": 1.0,
            "ciLow": None,
            "ciHigh": None,
            "sourceVideos": len(unique),
            "repeats": int(repeats),
            "policy": (
                "unsupported because at least one declared semantic category has fewer "
                f"than {MIN_CATEGORY_SOURCES} independent source videos"
            ),
        }
    rng = np.random.default_rng(seed)
    exceed = 0
    batch = 256
    for start in range(0, repeats, batch):
        count = min(batch, repeats - start)
        signs = rng.choice((-1.0, 1.0), size=(count, len(unique)))
        null_by_category = np.column_stack([
            signs @ contributions for contributions in contribution_rows
        ])
        null = np.tanh(np.mean(np.arctanh(np.clip(
            null_by_category[:, np.asarray(available_categories, bool)],
            -.999999, .999999,
        )), axis=1)) if any(available_categories) else np.zeros(count)
        if np.isfinite(observed):
            exceed += int(np.sum(np.abs(null) >= abs(observed)))
    group_rows = {group: np.flatnonzero(groups == group) for group in unique}
    bootstrap = np.empty(repeats, float)
    for index in range(repeats):
        sample = rng.choice(unique, size=len(unique), replace=True)
        positions = np.concatenate([group_rows[group] for group in sample])
        bootstrap_groups = np.concatenate([
            np.repeat(f"{draw}:{group}", len(group_rows[group]))
            for draw, group in enumerate(sample)
        ])
        bootstrap[index], _ = category_balanced_spearman(
            prediction[positions], target[positions], categories[positions],
            bootstrap_groups,
            minimum_sources=MIN_CATEGORY_SOURCES,
            required_categories=expected_categories,
        )
    finite_bootstrap = bootstrap[np.isfinite(bootstrap)]
    return {
        "rho": observed,
        "rhoByCategory": observed_by_category,
        "p": float((1 + exceed) / (repeats + 1)) if np.isfinite(observed) else 1.0,
        "ciLow": float(np.quantile(finite_bootstrap, .025)) if len(finite_bootstrap) else None,
        "ciHigh": float(np.quantile(finite_bootstrap, .975)) if len(finite_bootstrap) else None,
        "sourceVideos": len(unique),
        "repeats": int(repeats),
        "policy": (
            "source-video wild sign null and source-video bootstrap on the exact "
            "equal-category, source-equal Fisher-mean weighted Spearman statistic"
        ),
    }
