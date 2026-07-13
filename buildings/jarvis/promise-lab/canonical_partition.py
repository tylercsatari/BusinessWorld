"""Deterministic non-overlapping four-category hook decomposition."""

from __future__ import annotations

import math

import numpy as np

from hook_score_core import (
    apply_category_transform,
    category_log_probabilities,
    row_unit,
)


EPS = 1e-9
PARTITION_SEED = 20260712
FEATURE_NAMES = (
    "token_effect_cohesion",
    "left_boundary_contrast",
    "right_boundary_contrast",
    "deletion_influence_magnitude",
    "isolated_influence_alignment",
    "span_context_contrast",
    "nonadditive_influence_alignment",
    "span_full_hook_contrast",
    "context_full_hook_alignment",
    "category_probability",
    "category_margin",
    "category_certainty",
    "nested_semantic_stability",
    "nested_category_stability",
)
BOUNDARY_FEATURE_NAMES = (
    "prefix_suffix_raw_contrast",
    "prefix_suffix_context_contrast",
    "prefix_suffix_influence_contrast",
    "prefix_suffix_nonadditive_contrast",
    "adjacent_token_raw_contrast",
    "adjacent_token_influence_contrast",
    "split_raw_reconstruction",
    "split_influence_reconstruction",
)
REGULARIZATION_GRID = (.001, .01, .1, 1.0, 10.0, 100.0)


def softmax(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, np.float64)
    shifted = values - np.max(values, axis=1, keepdims=True)
    exponent = np.exp(np.clip(shifted, -80, 0))
    return (exponent / np.maximum(exponent.sum(axis=1, keepdims=True), EPS)).astype(np.float32)


def fit_category_model(values: np.ndarray, labels: np.ndarray,
                       cluster_count: int = 4) -> dict:
    """Fit a regularized full-covariance density to the already-frozen labels."""
    values = np.asarray(values, np.float64)
    labels = np.asarray(labels, int)
    rows = []
    for label in range(cluster_count):
        selected = values[labels == label]
        if len(selected) < 3:
            raise ValueError(f"cluster {label} has too few rows")
        mean = selected.mean(axis=0)
        covariance = np.cov(selected, rowvar=False)
        shrinkage = max(1e-5, float(np.trace(covariance)) / len(mean) * 1e-3)
        covariance = covariance + np.eye(len(mean)) * shrinkage
        sign, logdet = np.linalg.slogdet(covariance)
        if sign <= 0:
            raise ValueError(f"cluster {label} covariance is not positive definite")
        rows.append({
            "label": label,
            "count": int(len(selected)),
            "prior": float(len(selected) / len(values)),
            "mean": mean.astype(float).tolist(),
            "covariance": covariance.astype(float).tolist(),
            "inverseCovariance": np.linalg.pinv(covariance).astype(float).tolist(),
            "logDeterminant": float(logdet),
        })
    return {"clusterCount": cluster_count, "dimensions": values.shape[1], "clusters": rows}


def _cosine(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    return np.sum(row_unit(left) * row_unit(right), axis=1)


def structural_features(full: np.ndarray, raw: np.ndarray, context: np.ndarray,
                        influence: np.ndarray, nonadditive: np.ndarray,
                        starts: np.ndarray, ends: np.ndarray,
                        category_logp: np.ndarray) -> np.ndarray:
    """Build outcome-blind features for every span in one source hook."""
    full = np.asarray(full, np.float32)
    raw = row_unit(raw)
    context = row_unit(context)
    influence = row_unit(influence)
    nonadditive = row_unit(nonadditive)
    starts = np.asarray(starts, int)
    ends = np.asarray(ends, int)
    category_probability = np.exp(np.asarray(category_logp, float))
    token_count = int(np.max(ends))
    lookup = {(int(start), int(end)): index for index, (start, end) in enumerate(zip(starts, ends))}

    token_effects = np.zeros((token_count, len(full)), np.float32)
    for token in range(token_count):
        index = lookup[(token, token + 1)]
        token_effects[token] = full - context[index]
    prefix = np.vstack([np.zeros((1, len(full)), np.float32), np.cumsum(token_effects, axis=0)])
    prefix_norm = np.concatenate([[0.0], np.cumsum(np.sum(token_effects ** 2, axis=1))])

    lengths = np.maximum(1, ends - starts)
    block_sum = prefix[ends] - prefix[starts]
    block_mean = block_sum / lengths[:, None]
    sse = prefix_norm[ends] - prefix_norm[starts] - np.sum(block_sum ** 2, axis=1) / lengths
    cohesion = 1.0 / (1.0 + np.maximum(0.0, sse) / lengths)
    mean_unit = row_unit(block_mean)

    left_contrast = np.zeros(len(starts), np.float32)
    right_contrast = np.zeros(len(starts), np.float32)
    has_left = starts > 0
    has_right = ends < token_count
    if has_left.any():
        left_contrast[has_left] = 1 - _cosine(
            mean_unit[has_left], token_effects[starts[has_left] - 1]
        )
    if has_right.any():
        right_contrast[has_right] = 1 - _cosine(
            mean_unit[has_right], token_effects[ends[has_right]]
        )

    sorted_probability = np.sort(category_probability, axis=1)
    category_max = sorted_probability[:, -1]
    category_margin = sorted_probability[:, -1] - sorted_probability[:, -2]
    entropy = -np.sum(category_probability * np.log(np.maximum(category_probability, EPS)), axis=1)
    category_certainty = 1 - entropy / math.log(category_probability.shape[1])

    nested_semantic = np.zeros(len(starts), np.float32)
    nested_category = np.zeros(len(starts), np.float32)
    for index, (start, end) in enumerate(zip(starts, ends)):
        neighbors = []
        for pair in ((start + 1, end), (start, end - 1), (start - 1, end), (start, end + 1)):
            neighbor = lookup.get(pair)
            if neighbor is not None and pair[0] < pair[1]:
                neighbors.append(neighbor)
        if neighbors:
            nested_semantic[index] = float(np.mean(raw[neighbors] @ raw[index]))
            nested_category[index] = float(1 - np.mean(
                np.abs(category_probability[neighbors] - category_probability[index]).sum(axis=1) / 2
            ))

    full_rows = np.broadcast_to(full, raw.shape)
    features = np.column_stack([
        cohesion,
        left_contrast,
        right_contrast,
        np.linalg.norm(full_rows - context, axis=1),
        _cosine(raw, influence),
        1 - _cosine(raw, context),
        _cosine(nonadditive, influence),
        1 - _cosine(raw, full_rows),
        _cosine(context, full_rows),
        category_max,
        category_margin,
        category_certainty,
        nested_semantic,
        nested_category,
    ]).astype(np.float32)
    if features.shape[1] != len(FEATURE_NAMES) or not np.isfinite(features).all():
        raise ValueError("canonical partition features are incomplete")
    return features


def boundary_features(full: np.ndarray, raw: np.ndarray, context: np.ndarray,
                      influence: np.ndarray, nonadditive: np.ndarray,
                      starts: np.ndarray, ends: np.ndarray,
                      category_logp: np.ndarray) -> np.ndarray:
    """Outcome- and category-blind semantic contrast at every token gap."""
    full = row_unit(np.asarray(full, np.float32))
    raw = row_unit(raw)
    context = row_unit(context)
    influence = row_unit(influence)
    nonadditive = row_unit(nonadditive)
    starts = np.asarray(starts, int)
    ends = np.asarray(ends, int)
    token_count = int(ends.max())
    lookup = {(int(start), int(end)): index
              for index, (start, end) in enumerate(zip(starts, ends))}
    rows = []
    for boundary in range(1, token_count):
        prefix = lookup[(0, boundary)]
        suffix = lookup[(boundary, token_count)]
        left = lookup[(boundary - 1, boundary)]
        right = lookup[(boundary, boundary + 1)]
        raw_sum = raw[prefix] + raw[suffix]
        influence_sum = influence[prefix] + influence[suffix]
        rows.append([
            1 - float(raw[prefix] @ raw[suffix]),
            1 - float(context[prefix] @ context[suffix]),
            1 - float(influence[prefix] @ influence[suffix]),
            1 - float(nonadditive[prefix] @ nonadditive[suffix]),
            1 - float(raw[left] @ raw[right]),
            1 - float(influence[left] @ influence[right]),
            float(raw_sum @ full / (np.linalg.norm(raw_sum) + EPS)),
            float(influence_sum @ full / (np.linalg.norm(influence_sum) + EPS)),
        ])
    features = np.asarray(rows, np.float32)
    if features.shape != (max(0, token_count - 1), len(BOUNDARY_FEATURE_NAMES)):
        raise ValueError("boundary feature geometry is incomplete")
    if not np.isfinite(features).all():
        raise ValueError("boundary features contain non-finite values")
    return features


def _row_weights(groups: np.ndarray) -> np.ndarray:
    groups = np.asarray(groups).astype(str)
    counts = {group: int(np.sum(groups == group)) for group in set(groups)}
    weights = np.asarray([1 / counts[group] for group in groups], float)
    return weights * len(weights) / weights.sum()


def _operating_point(target: np.ndarray, prediction: np.ndarray,
                     weights: np.ndarray) -> dict:
    """Audit the classifier's natural Bernoulli decision without tuning a threshold."""
    from sklearn.metrics import balanced_accuracy_score, matthews_corrcoef

    threshold = .5
    decision = np.asarray(prediction, float) >= threshold
    return {
        "threshold": threshold,
        "matthewsCorrelation": float(matthews_corrcoef(target, decision)),
        "balancedAccuracy": float(balanced_accuracy_score(target, decision)),
        "predictedPositiveRate": float(np.average(decision, weights=weights)),
    }


def _crossfit_regularization(features: np.ndarray, target: np.ndarray,
                             groups: np.ndarray, weights: np.ndarray,
                             candidates: tuple[float, ...],
                             folds: int = 4) -> tuple[float, list[dict], np.ndarray]:
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import average_precision_score, roc_auc_score
    from sklearn.model_selection import GroupKFold
    from sklearn.preprocessing import StandardScaler

    groups = np.asarray(groups).astype(str)
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    predictions = {
        float(value): np.full(len(target), np.nan, float) for value in candidates
    }
    for train, test in splitter.split(features, target, groups):
        scaler = StandardScaler().fit(features[train], sample_weight=weights[train])
        train_x = scaler.transform(features[train])
        test_x = scaler.transform(features[test])
        for value in candidates:
            model = LogisticRegression(
                C=float(value), max_iter=2000, solver="lbfgs",
                random_state=PARTITION_SEED,
            ).fit(train_x, target[train], sample_weight=weights[train])
            predictions[float(value)][test] = model.predict_proba(test_x)[:, 1]
    rows = [{
        "C": value,
        "sourceWeightedAveragePrecision": float(average_precision_score(
            target, prediction, sample_weight=weights,
        )),
        "sourceWeightedAuc": float(roc_auc_score(
            target, prediction, sample_weight=weights,
        )),
    } for value, prediction in predictions.items()]
    selected = max(rows, key=lambda row: (
        row["sourceWeightedAveragePrecision"], -row["C"],
    ))
    return float(selected["C"]), rows, predictions[float(selected["C"])]


def fit_boundary_model(features: np.ndarray, target: np.ndarray, groups: np.ndarray,
                       folds: int = 5,
                       feature_names: tuple[str, ...] = BOUNDARY_FEATURE_NAMES,
                       regularization_grid: tuple[float, ...] = REGULARIZATION_GRID,
                       ) -> tuple[dict, np.ndarray, np.ndarray]:
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import average_precision_score, roc_auc_score
    from sklearn.model_selection import GroupKFold
    from sklearn.preprocessing import StandardScaler

    features = np.asarray(features, np.float32)
    target = np.asarray(target, int)
    groups = np.asarray(groups).astype(str)
    weights = _row_weights(groups)
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    predictions = np.full(len(target), np.nan, float)
    neutral_predictions = np.full(len(target), np.nan, float)
    fold_models = []
    for fold_index, (train, test) in enumerate(splitter.split(features, target, groups)):
        selected_c, inner_rows, _ = _crossfit_regularization(
            features[train], target[train], groups[train], weights[train],
            regularization_grid,
        )
        scaler = StandardScaler().fit(features[train], sample_weight=weights[train])
        model = LogisticRegression(
            C=selected_c, max_iter=2000, solver="lbfgs",
            random_state=PARTITION_SEED,
        ).fit(scaler.transform(features[train]), target[train], sample_weight=weights[train])
        predictions[test] = model.predict_proba(scaler.transform(features[test]))[:, 1]
        neutral_predictions[test] = predictions[test]
        fold_models.append({
            "fold": fold_index,
            "selectedC": selected_c,
            "regularizationSearch": inner_rows,
            "decisionThreshold": .5,
            "scalerMean": scaler.mean_.astype(float).tolist(),
            "scalerScale": scaler.scale_.astype(float).tolist(),
            "coefficients": model.coef_[0].astype(float).tolist(),
            "intercept": float(model.intercept_[0]),
            "heldoutGroups": sorted(set(groups[test])),
        })
    auc = float(roc_auc_score(target, predictions, sample_weight=weights))
    average_precision = float(average_precision_score(
        target, predictions, sample_weight=weights,
    ))
    positive_rate = float(np.average(target, weights=weights))
    operating_point = _operating_point(target, predictions, weights)
    selected_c, regularization_rows, _ = _crossfit_regularization(
        features, target, groups, weights, regularization_grid,
    )
    scaler = StandardScaler().fit(features, sample_weight=weights)
    model = LogisticRegression(
        C=selected_c, max_iter=2000, solver="lbfgs",
        random_state=PARTITION_SEED,
    ).fit(scaler.transform(features), target, sample_weight=weights)
    artifact = {
        "featureNames": list(feature_names),
        "fitMethod": "L2 logistic regression with nested grouped regularization selection",
        "regularizationGrid": list(regularization_grid),
        "selectedC": selected_c,
        "regularizationSearch": regularization_rows,
        "heldoutAuc": auc,
        "heldoutAveragePrecision": average_precision,
        "heldoutDecisionThreshold": operating_point["threshold"],
        "heldoutDecisionMetric": (
            "fixed Bernoulli posterior threshold 0.5 for audit only; the exact-cover decoder uses "
            "raw probabilities and no tuned operating threshold"
        ),
        "heldoutMatthewsCorrelation": operating_point["matthewsCorrelation"],
        "heldoutBalancedAccuracy": operating_point["balancedAccuracy"],
        "heldoutPredictedPositiveRate": operating_point["predictedPositiveRate"],
        "positiveRate": positive_rate,
        "scalerMean": scaler.mean_.astype(float).tolist(),
        "scalerScale": scaler.scale_.astype(float).tolist(),
        "coefficients": model.coef_[0].astype(float).tolist(),
        "intercept": float(model.intercept_[0]),
        "decisionThreshold": .5,
        "foldModels": fold_models,
        "servingPolicy": (
            "mean raw fold-specific Bernoulli posterior; each fold selects only L2 regularization "
            "without its held-out source hooks; no posterior recentering or cut threshold tuning"
        ),
        "groupedBy": "source hook",
        "sourceEqualWeights": True,
        "outcomesUsed": False,
    }
    return (
        artifact, predictions.astype(np.float32),
        neutral_predictions.astype(np.float32),
    )


def boundary_probabilities(features: np.ndarray, model: dict) -> np.ndarray:
    features = np.asarray(features, np.float64)
    rows = model.get("foldModels") or [model]
    predictions = []
    for row in rows:
        mean = np.asarray(row["scalerMean"], float)
        scale = np.asarray(row["scalerScale"], float)
        coefficients = np.asarray(row["coefficients"], float)
        logits = (
            (features - mean) / np.maximum(scale, EPS)
        ) @ coefficients + float(row["intercept"])
        posterior = 1 / (1 + np.exp(-np.clip(logits, -50, 50)))
        predictions.append(posterior)
    return np.mean(predictions, axis=0).astype(np.float32)
