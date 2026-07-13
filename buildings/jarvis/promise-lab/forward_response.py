"""Leakage-safe forward retention-response models for canonical hook components."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import rankdata
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

from axes import finite_correlation, spearman
from hook_score_core import combined_component_features


EPS = 1e-9
FORWARD_SEED = 20260712
FIXED_DIMENSIONS = 16
FIXED_SEMANTIC_ALPHA = 10.0
FIXED_BASELINE_ALPHA = 10.0


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
                "least-squares slope across the exact spoken component interval, "
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


def _impute_scale(train: np.ndarray, test: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict]:
    train = np.asarray(train, np.float32)
    test = np.asarray(test, np.float32)
    median = np.nanmedian(np.where(np.isfinite(train), train, np.nan), axis=0)
    median = np.where(np.isfinite(median), median, 0).astype(np.float32)
    train = np.where(np.isfinite(train), train, median)
    test = np.where(np.isfinite(test), test, median)
    scaler = StandardScaler().fit(train)
    return scaler.transform(train), scaler.transform(test), {
        "median": median.astype(float).tolist(),
        "mean": scaler.mean_.astype(float).tolist(),
        "scale": scaler.scale_.astype(float).tolist(),
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
                           seed: int) -> list[dict]:
    """Prepare outcome-blind semantic coordinates once for every candidate ruler."""
    output = []
    for category in sorted(set(categories)):
        fit = train[categories[train] == category]
        evaluate = test[categories[test] == category]
        if len(fit) < max(8, dimensions + 2) or not len(evaluate):
            continue
        dimension = min(int(dimensions), len(fit) - 1, features.shape[1])
        reducer = PCA(
            n_components=max(1, dimension), svd_solver="randomized",
            random_state=seed + int(category),
        ).fit(features[fit])
        train_scores = reducer.transform(features[fit])
        test_scores = reducer.transform(features[evaluate])
        scaler = StandardScaler().fit(train_scores)
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
                      baseline_alpha: float) -> tuple[np.ndarray, np.ndarray]:
    prediction = np.full(len(target), np.nan, np.float32)
    residual = np.full(len(target), np.nan, np.float32)
    for row in prepared:
        train = row["train"]
        test = row["test"]
        valid_train = np.isfinite(target[train])
        valid_test = np.isfinite(target[test])
        if valid_train.sum() < 8 or not valid_test.any():
            continue
        fit = train[valid_train]
        evaluate = test[valid_test]
        natural_train, natural_test, _ = _impute_scale(
            natural[fit], natural[evaluate]
        )
        baseline = Ridge(alpha=float(baseline_alpha)).fit(
            natural_train, target[fit]
        )
        train_residual = target[fit] - baseline.predict(natural_train)
        test_residual = target[evaluate] - baseline.predict(natural_test)
        semantic = Ridge(alpha=float(semantic_alpha)).fit(
            row["trainScores"][valid_train], train_residual,
        )
        prediction[evaluate] = semantic.predict(
            row["testScores"][valid_test]
        ).astype(np.float32)
        residual[evaluate] = test_residual.astype(np.float32)
    return prediction, residual


def category_balanced_spearman(prediction: np.ndarray, target: np.ndarray,
                               categories: np.ndarray) -> tuple[float, dict[str, float]]:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    categories = np.asarray(categories, int)
    by_category = {}
    fisher = []
    for category in sorted(set(categories)):
        selected = categories == category
        value = spearman(prediction[selected], target[selected])
        by_category[str(int(category))] = float(value)
        if np.isfinite(value):
            fisher.append(np.arctanh(np.clip(value, -.999999, .999999)))
    balanced = float(np.tanh(np.mean(fisher))) if fisher else float("nan")
    return balanced, by_category


def crossfit_category_axis(features: np.ndarray, target: np.ndarray,
                           natural: np.ndarray, groups: np.ndarray,
                           categories: np.ndarray, folds: int = 5,
                           dimensions: int = FIXED_DIMENSIONS,
                           semantic_alpha: float = FIXED_SEMANTIC_ALPHA,
                           baseline_alpha: float = FIXED_BASELINE_ALPHA,
                           seed: int = FORWARD_SEED,
                           outer_splits: list[tuple[np.ndarray, np.ndarray]] | None = None,
                           validation_design: str = "grouped random folds") -> dict:
    features = np.asarray(features, np.float32)
    groups = np.asarray(groups).astype(str)
    categories = np.asarray(categories, int)
    prediction = np.full(len(groups), np.nan, np.float32)
    residual = np.full(len(groups), np.nan, np.float32)
    fold_index = np.full(len(groups), -1, np.int16)
    direction_rows: dict[str, list[np.ndarray]] = {}
    splits = outer_splits
    if splits is None:
        splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
        splits = list(splitter.split(np.arange(len(groups)), groups=groups))
    for fold, (train, test) in enumerate(splits):
        train = np.asarray(train, int)
        test = np.asarray(test, int)
        prepared = _prepare_category_fold(
            features, train, test, categories, dimensions, seed + fold * 101,
        )
        fold_prediction, fold_residual = _predict_prepared(
            prepared, target, natural, semantic_alpha, baseline_alpha,
        )
        selected = np.isfinite(fold_prediction + fold_residual)
        prediction[selected] = fold_prediction[selected]
        residual[selected] = fold_residual[selected]
        fold_index[selected] = fold
        for row in prepared:
            train_positions = row["train"]
            valid = np.isfinite(target[train_positions])
            if valid.sum() < 8:
                continue
            natural_train, _, _ = _impute_scale(
                natural[train_positions][valid], natural[train_positions][valid]
            )
            baseline = Ridge(alpha=float(baseline_alpha)).fit(
                natural_train, target[train_positions][valid]
            )
            train_residual = target[train_positions][valid] - baseline.predict(natural_train)
            semantic = Ridge(alpha=float(semantic_alpha)).fit(
                row["trainScores"][valid], train_residual,
            )
            coefficient = row["reducer"].components_.T @ (
                semantic.coef_ / np.maximum(row["scaler"].scale_, EPS)
            )
            direction_rows.setdefault(str(row["category"]), []).append(row_unit(coefficient))
    balanced, by_category = category_balanced_spearman(prediction, residual, categories)
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
                            validation_design: str = "nested grouped random folds") -> dict:
    """Select the response ruler inside each outer training fold, then test once."""
    features = np.asarray(features, np.float32)
    groups = np.asarray(groups).astype(str)
    categories = np.asarray(categories, int)
    candidate_ids = sorted(targets)
    prediction = np.full(len(groups), np.nan, np.float32)
    residual = np.full(len(groups), np.nan, np.float32)
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
            inner_prepared.append(_prepare_category_fold(
                features, train[inner_train], train[inner_test], categories,
                FIXED_DIMENSIONS, seed + fold * 1009 + inner_fold * 101,
            ))
        inner_scores = []
        for candidate_id in candidate_ids:
            inner_prediction = np.full(len(groups), np.nan, np.float32)
            inner_residual = np.full(len(groups), np.nan, np.float32)
            for prepared in inner_prepared:
                local_prediction, local_residual = _predict_prepared(
                    prepared, targets[candidate_id], naturals[candidate_id],
                    FIXED_SEMANTIC_ALPHA, FIXED_BASELINE_ALPHA,
                )
                selected = np.isfinite(local_prediction + local_residual)
                inner_prediction[selected] = local_prediction[selected]
                inner_residual[selected] = local_residual[selected]
            inner_score, _ = category_balanced_spearman(
                inner_prediction[train], inner_residual[train], categories[train],
            )
            inner_scores.append((float(inner_score), candidate_id))
        inner_scores.sort(key=lambda row: (-np.nan_to_num(row[0], nan=-1.0), row[1]))
        selected_score, selected_id = inner_scores[0]
        outer_prepared = _prepare_category_fold(
            features, train, test, categories, FIXED_DIMENSIONS, seed + fold * 101,
        )
        fold_prediction, fold_residual = _predict_prepared(
            outer_prepared, targets[selected_id], naturals[selected_id],
            FIXED_SEMANTIC_ALPHA, FIXED_BASELINE_ALPHA,
        )
        selected = np.isfinite(fold_prediction + fold_residual)
        prediction[selected] = fold_prediction[selected]
        residual[selected] = fold_residual[selected]
        selected_rows.append({
            "fold": fold,
            "selectedCandidate": selected_id,
            "innerCategoryBalancedSpearman": selected_score,
            "runnerUpCandidate": inner_scores[1][1] if len(inner_scores) > 1 else None,
            "runnerUpSpearman": inner_scores[1][0] if len(inner_scores) > 1 else None,
            "trainSources": len(set(groups[train])),
            "testSources": len(set(groups[test])),
        })
    balanced, by_category = category_balanced_spearman(prediction, residual, categories)
    counts = {candidate_id: 0 for candidate_id in candidate_ids}
    for row in selected_rows:
        counts[row["selectedCandidate"]] += 1
    final_id = max(candidate_ids, key=lambda value: (counts[value], -candidate_ids.index(value)))
    return {
        "prediction": prediction,
        "targetResidual": residual,
        "heldoutSpearman": balanced,
        "heldoutSpearmanByCategory": by_category,
        "folds": selected_rows,
        "selectionCounts": {key: value for key, value in counts.items() if value},
        "selectedCandidate": final_id,
        "selectedFraction": counts[final_id] / max(1, len(selected_rows)),
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
                           categories: np.ndarray) -> dict[str, dict]:
    categories = np.asarray(categories, int)
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


def source_signflip(prediction: np.ndarray, target: np.ndarray, groups: np.ndarray,
                    repeats: int = 4096, seed: int = FORWARD_SEED) -> dict:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    valid = np.isfinite(prediction + target)
    prediction = prediction[valid]
    target = target[valid]
    groups = groups[valid]
    x = rankdata(prediction).astype(float)
    y = rankdata(target).astype(float)
    x = (x - x.mean()) / (x.std() + EPS)
    y = (y - y.mean()) / (y.std() + EPS)
    unique = sorted(set(groups))
    contributions = np.asarray([
        np.sum(x[groups == group] * y[groups == group]) / len(x)
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
    for index in range(repeats):
        sample = rng.integers(0, len(unique), size=len(unique))
        bootstrap[index] = contributions[sample].sum()
    return {
        "rho": observed,
        "p": pvalue,
        "ciLow": float(np.quantile(bootstrap, .025)),
        "ciHigh": float(np.quantile(bootstrap, .975)),
        "sourceVideos": len(unique),
        "repeats": int(repeats),
        "policy": "source-video sign flips and source-video bootstrap",
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
    valid = np.isfinite(prediction + target)
    prediction = prediction[valid]
    target = target[valid]
    groups = groups[valid]
    categories = categories[valid]
    unique = np.asarray(sorted(set(groups)))
    group_index = {group: index for index, group in enumerate(unique)}
    contribution_rows = []
    observed_by_category = {}
    for category in sorted(set(categories)):
        selected = categories == category
        x = rankdata(prediction[selected]).astype(float)
        y = rankdata(target[selected]).astype(float)
        x = (x - x.mean()) / (x.std() + EPS)
        y = (y - y.mean()) / (y.std() + EPS)
        contributions = np.zeros(len(unique), float)
        for value, group in zip(x * y / len(x), groups[selected]):
            contributions[group_index[group]] += value
        rho = float(contributions.sum())
        observed_by_category[str(int(category))] = rho
        contribution_rows.append(contributions)
    observed = float(np.tanh(np.mean([
        np.arctanh(np.clip(value, -.999999, .999999))
        for value in observed_by_category.values()
    ])))
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
            null_by_category, -.999999, .999999,
        )), axis=1))
        exceed += int(np.sum(np.abs(null) >= abs(observed)))
    group_rows = {group: np.flatnonzero(groups == group) for group in unique}
    bootstrap = np.empty(repeats, float)
    for index in range(repeats):
        sample = rng.choice(unique, size=len(unique), replace=True)
        positions = np.concatenate([group_rows[group] for group in sample])
        bootstrap[index], _ = category_balanced_spearman(
            prediction[positions], target[positions], categories[positions],
        )
    return {
        "rho": observed,
        "rhoByCategory": observed_by_category,
        "p": float((1 + exceed) / (repeats + 1)),
        "ciLow": float(np.quantile(bootstrap, .025)),
        "ciHigh": float(np.quantile(bootstrap, .975)),
        "sourceVideos": len(unique),
        "repeats": int(repeats),
        "policy": (
            "source-video wild sign null and source-video bootstrap on the exact "
            "equal-category Fisher-mean Spearman statistic"
        ),
    }
