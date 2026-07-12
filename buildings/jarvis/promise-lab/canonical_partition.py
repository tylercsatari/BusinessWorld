"""Deterministic non-overlapping four-category hook decomposition."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

from hook_score_core import (
    apply_category_transform,
    category_log_probabilities,
    decode_compositional_four_chunks,
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


def _row_weights(groups: np.ndarray) -> np.ndarray:
    groups = np.asarray(groups).astype(str)
    counts = {group: int(np.sum(groups == group)) for group in set(groups)}
    weights = np.asarray([1 / counts[group] for group in groups], float)
    return weights * len(weights) / weights.sum()


def fit_boundary_model(features: np.ndarray, target: np.ndarray, groups: np.ndarray,
                       c_values=(.01, .1, 1.0, 10.0), folds: int = 5) -> tuple[dict, np.ndarray]:
    features = np.asarray(features, np.float32)
    target = np.asarray(target, int)
    groups = np.asarray(groups).astype(str)
    weights = _row_weights(groups)
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    rows = []
    predictions_by_c = {}
    for c_value in c_values:
        predictions = np.full(len(target), np.nan, float)
        for train, test in splitter.split(features, target, groups):
            scaler = StandardScaler().fit(features[train], sample_weight=weights[train])
            model = LogisticRegression(
                C=float(c_value), max_iter=600, solver="lbfgs", random_state=PARTITION_SEED,
            ).fit(scaler.transform(features[train]), target[train], sample_weight=weights[train])
            predictions[test] = model.predict_proba(scaler.transform(features[test]))[:, 1]
        auc = float(roc_auc_score(target, predictions, sample_weight=weights))
        average_precision = float(average_precision_score(target, predictions, sample_weight=weights))
        rows.append({"C": float(c_value), "heldoutAuc": auc,
                     "heldoutAveragePrecision": average_precision})
        predictions_by_c[float(c_value)] = predictions
    selected = max(rows, key=lambda row: (row["heldoutAuc"], row["heldoutAveragePrecision"], -row["C"]))
    scaler = StandardScaler().fit(features, sample_weight=weights)
    model = LogisticRegression(
        C=selected["C"], max_iter=600, solver="lbfgs", random_state=PARTITION_SEED,
    ).fit(scaler.transform(features), target, sample_weight=weights)
    artifact = {
        "featureNames": list(FEATURE_NAMES),
        "selectedC": selected["C"],
        "heldoutAuc": selected["heldoutAuc"],
        "heldoutAveragePrecision": selected["heldoutAveragePrecision"],
        "positiveRate": float(np.average(target, weights=weights)),
        "configurations": rows,
        "scalerMean": scaler.mean_.astype(float).tolist(),
        "scalerScale": scaler.scale_.astype(float).tolist(),
        "coefficients": model.coef_[0].astype(float).tolist(),
        "intercept": float(model.intercept_[0]),
        "groupedBy": "source hook",
        "sourceEqualWeights": True,
        "outcomesUsed": False,
    }
    return artifact, predictions_by_c[selected["C"]].astype(np.float32)


def boundary_probabilities(features: np.ndarray, model: dict) -> np.ndarray:
    features = np.asarray(features, np.float64)
    mean = np.asarray(model["scalerMean"], float)
    scale = np.asarray(model["scalerScale"], float)
    coefficients = np.asarray(model["coefficients"], float)
    logits = ((features - mean) / np.maximum(scale, EPS)) @ coefficients + float(model["intercept"])
    return (1 / (1 + np.exp(-np.clip(logits, -50, 50)))).astype(np.float32)


@dataclass
class _Path:
    score: float
    chunks: list[tuple[int, int, int, int]]


def _keep_two(rows: list[_Path]) -> list[_Path]:
    unique = {}
    for row in rows:
        key = tuple(row.chunks)
        if key not in unique or row.score > unique[key].score:
            unique[key] = row
    return sorted(unique.values(), key=lambda row: row.score, reverse=True)[:2]


def decode_four_chunks(starts: np.ndarray, ends: np.ndarray,
                       boundary_probability: np.ndarray, category_logp: np.ndarray,
                       require_unique_categories: bool = True) -> dict:
    """Decode four exact-cover chunks, optionally using each category exactly once."""
    starts = np.asarray(starts, int)
    ends = np.asarray(ends, int)
    boundary_probability = np.asarray(boundary_probability, float)
    category_logp = np.asarray(category_logp, float)
    token_count = int(ends.max())
    by_start = {}
    for index, start in enumerate(starts):
        by_start.setdefault(int(start), []).append(index)
    states: dict[tuple[int, int], list[_Path]] = {(0, 0): [_Path(0.0, [])]}
    for chunk_number in range(4):
        next_states: dict[tuple[int, int], list[_Path]] = {}
        for (position, mask), paths in states.items():
            remaining_chunks = 4 - chunk_number
            for span_index in by_start.get(position, []):
                finish = int(ends[span_index])
                remaining_tokens = token_count - finish
                if remaining_tokens < remaining_chunks - 1:
                    continue
                structural = math.log(max(EPS, float(boundary_probability[span_index])))
                for category in range(category_logp.shape[1]):
                    bit = 1 << category
                    if require_unique_categories and mask & bit:
                        continue
                    next_mask = mask | bit if require_unique_categories else mask
                    increment = structural + float(category_logp[span_index, category])
                    key = (finish, next_mask)
                    candidates = next_states.setdefault(key, [])
                    for path in paths:
                        candidates.append(_Path(
                            path.score + increment,
                            path.chunks + [(span_index, position, finish, category)],
                        ))
                    next_states[key] = _keep_two(candidates)
        states = next_states
    final_mask = (1 << category_logp.shape[1]) - 1 if require_unique_categories else 0
    finalists = states.get((token_count, final_mask), [])
    if not finalists:
        raise ValueError("no valid four-chunk exact-cover partition")
    best = finalists[0]
    second = finalists[1] if len(finalists) > 1 else None
    return {
        "score": float(best.score),
        "runnerUpScore": float(second.score) if second else None,
        "scoreGap": float(best.score - second.score) if second else None,
        "topTwoPosteriorProxy": (
            float(1 / (1 + math.exp(-min(50, best.score - second.score)))) if second else 1.0
        ),
        "chunks": [{"spanIndex": item[0], "start": item[1], "end": item[2],
                    "category": item[3]} for item in best.chunks],
        "requiresEveryCategoryExactlyOnce": bool(require_unique_categories),
    }

def decode_with_constraint_audit(starts: np.ndarray, ends: np.ndarray,
                                 boundary_probability: np.ndarray,
                                 category_logp: np.ndarray) -> dict:
    unique = decode_four_chunks(starts, ends, boundary_probability, category_logp, True)
    repeated = decode_four_chunks(starts, ends, boundary_probability, category_logp, False)
    unique["unconstrainedCategoryScore"] = repeated["score"]
    unique["uniqueCategoryConstraintPenalty"] = float(repeated["score"] - unique["score"])
    unique["unconstrainedCategories"] = [row["category"] for row in repeated["chunks"]]
    return unique


def decode_structural_four_chunks(starts: np.ndarray, ends: np.ndarray,
                                  boundary_probability: np.ndarray,
                                  category_logp: np.ndarray) -> dict:
    """Choose boundaries from structural evidence, then label each frozen chunk."""
    starts = np.asarray(starts, int)
    ends = np.asarray(ends, int)
    boundary_probability = np.asarray(boundary_probability, float)
    category_logp = np.asarray(category_logp, float)
    token_count = int(ends.max())
    by_start = {}
    for index, start in enumerate(starts):
        by_start.setdefault(int(start), []).append(index)
    states: dict[int, list[_Path]] = {0: [_Path(0.0, [])]}
    for chunk_number in range(4):
        next_states: dict[int, list[_Path]] = {}
        for position, paths in states.items():
            remaining_chunks = 4 - chunk_number
            for span_index in by_start.get(position, []):
                finish = int(ends[span_index])
                if token_count - finish < remaining_chunks - 1:
                    continue
                increment = math.log(max(EPS, float(boundary_probability[span_index])))
                category = int(np.argmax(category_logp[span_index]))
                candidates = next_states.setdefault(finish, [])
                for path in paths:
                    candidates.append(_Path(
                        path.score + increment,
                        path.chunks + [(span_index, position, finish, category)],
                    ))
                next_states[finish] = _keep_two(candidates)
        states = next_states
    finalists = states.get(token_count, [])
    if not finalists:
        raise ValueError("no structural four-chunk exact-cover partition")
    best = finalists[0]
    second = finalists[1] if len(finalists) > 1 else None
    return {
        "score": float(best.score),
        "runnerUpScore": float(second.score) if second else None,
        "scoreGap": float(best.score - second.score) if second else None,
        "topTwoPosteriorProxy": (
            float(1 / (1 + math.exp(-min(50, best.score - second.score)))) if second else 1.0
        ),
        "chunks": [{"spanIndex": item[0], "start": item[1], "end": item[2],
                    "category": item[3]} for item in best.chunks],
        "boundarySelectionUsesCategoryQuota": False,
        "categoryAssignment": "maximum frozen-category posterior after boundaries are fixed",
    }
