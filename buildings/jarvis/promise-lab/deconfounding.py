"""Retention normalization and processing-lag robustness diagnostics.

The primary rule in this module is temporal: a headline target may use only
measurements available no later than the response window. Full-video endpoint
information is retained as an explicitly retrospective sensitivity analysis.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.stats import rankdata
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

from axes import finite_correlation, spearman
from cluster_outcomes import endpoint_normalize_curve, retention_at, retention_window_slope
from hook_outcomes import apply_terminal_conditioned_replay_correction
from latency_study import natural_drop_features


EPS = 1e-9
AUDIT_SEED = 20260731
PRIMARY_BASELINE_ALPHA = 10.0
BASELINE_ALPHA_SENSITIVITY = (1.0, 10.0, 100.0)
EXPECTED_CATEGORIES = (0, 1, 2, 3)
MIN_CATEGORY_SOURCES = 8


NORMALIZATION_CONTRACTS = {
    "observed_absolute": {
        "label": "Observed absolute",
        "formula": "R(t)",
        "futureFree": True,
        "usesTerminalRetention": False,
        "role": "measured-curve sensitivity; retains entry inflation and replay contamination",
    },
    "entry_indexed": {
        "label": "Entry-indexed",
        "formula": "R(t) / R(0)",
        "futureFree": True,
        "usesTerminalRetention": False,
        "role": "primary future-free response target; 100% means the measured entry level",
    },
    "terminal_replay": {
        "label": "Terminal-conditioned replay",
        "formula": "R(t) minus the endpoint-conditioned additive replay envelope",
        "futureFree": False,
        "usesTerminalRetention": True,
        "role": "retrospective sensitivity only; replay counts are not identified",
    },
    "endpoint_affine": {
        "label": "Endpoint-affine",
        "formula": "(R(t) - F) / (R(0) - F)",
        "futureFree": False,
        "usesTerminalRetention": True,
        "role": "retrospective sensitivity only; every point is conditioned on the final anchor F",
    },
}


BASELINE_CONTRACTS = {
    "timing_only": {
        "label": "Timing only",
        "futureFree": True,
        "usesObservedTrajectory": False,
        "usesTerminalRetention": False,
        "features": "window time, width, video duration, and normalized positions only",
    },
    "entry_level": {
        "label": "Timing + measured entry",
        "futureFree": True,
        "usesObservedTrajectory": True,
        "usesTerminalRetention": False,
        "features": "timing-only basis plus measured R(0)",
    },
    "past_trajectory": {
        "label": "Timing + pre-utterance trajectory",
        "futureFree": True,
        "usesObservedTrajectory": True,
        "usesTerminalRetention": False,
        "features": (
            "timing-only basis plus level, 0.5s/1.5s/3s slopes, local change, and "
            "volatility ending one source-native retention sample before the spoken component"
        ),
    },
    "endpoint_conditioned": {
        "label": "Timing + full-video endpoints",
        "futureFree": False,
        "usesObservedTrajectory": True,
        "usesTerminalRetention": True,
        "features": "timing-only basis plus entry, terminal, amplitude, and interactions",
    },
}


def _finite(value):
    value = float(value)
    return value if np.isfinite(value) else None


def source_equal_weights(groups: np.ndarray) -> np.ndarray:
    groups = np.asarray(groups).astype(str)
    if not len(groups):
        return np.asarray([], np.float32)
    _, inverse, counts = np.unique(groups, return_inverse=True, return_counts=True)
    weights = 1.0 / counts[inverse]
    weights *= len(weights) / max(float(weights.sum()), EPS)
    return weights.astype(np.float32)


def weighted_spearman(prediction: np.ndarray, target: np.ndarray,
                      groups: np.ndarray) -> float:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    valid = np.isfinite(prediction + target)
    if valid.sum() < 3:
        return float("nan")
    left = rankdata(prediction[valid]).astype(float)
    right = rankdata(target[valid]).astype(float)
    weights = source_equal_weights(groups[valid]).astype(float)
    weights /= max(float(weights.sum()), EPS)
    left -= float(np.sum(weights * left))
    right -= float(np.sum(weights * right))
    left_scale = math.sqrt(float(np.sum(weights * left ** 2)))
    right_scale = math.sqrt(float(np.sum(weights * right ** 2)))
    if left_scale <= EPS or right_scale <= EPS:
        return float("nan")
    return float(np.sum(weights * left * right) / (left_scale * right_scale))


def retention_curve_families(raw_curves: list[np.ndarray],
                             terminals: np.ndarray) -> dict[str, list[np.ndarray]]:
    """Build all declared normalizations without changing native curve sampling."""
    output = {key: [] for key in NORMALIZATION_CONTRACTS}
    for raw, terminal in zip(raw_curves, np.asarray(terminals, float)):
        values = np.asarray(raw, float)
        if len(values) < 4 or not np.isfinite(values).all() or values[0] <= EPS:
            for key in output:
                output[key].append(np.asarray([], float))
            continue
        output["observed_absolute"].append(values)
        output["entry_indexed"].append(values / values[0])
        replay = apply_terminal_conditioned_replay_correction(
            values * 100.0, float(terminal) * 100.0,
        ) / 100.0
        output["terminal_replay"].append(np.asarray(replay, float))
        endpoint, _ = endpoint_normalize_curve(values)
        output["endpoint_affine"].append(np.asarray(endpoint, float))
    return output


def source_native_sample_seconds(curves: list[np.ndarray],
                                 durations: np.ndarray) -> np.ndarray:
    """Return each source curve's native temporal step without outcome fitting."""
    return np.asarray([
        float(duration) / max(1, len(curve) - 1)
        if np.isfinite(duration) and len(curve) > 1 else np.nan
        for curve, duration in zip(curves, np.asarray(durations, float))
    ], np.float32)


def past_trajectory_features(curves: list[np.ndarray], durations: np.ndarray,
                             source_indices: np.ndarray, window_starts: np.ndarray,
                             guard_seconds: float | np.ndarray | None = None) -> np.ndarray:
    """Describe only the curve at least one native sample before a response window."""
    durations = np.asarray(durations, float)
    source_indices = np.asarray(source_indices, int)
    starts = np.asarray(window_starts, float)
    if guard_seconds is None:
        guard_by_source = source_native_sample_seconds(curves, durations)
    elif np.ndim(guard_seconds) == 0:
        guard_by_source = np.full(len(curves), float(guard_seconds), np.float32)
    else:
        guard_by_source = np.asarray(guard_seconds, np.float32)
        if len(guard_by_source) != len(curves):
            raise ValueError("past-trajectory guard must be scalar or one value per source")
    output = np.full((len(starts), 8), np.nan, np.float32)
    for index, source in enumerate(source_indices):
        duration = float(durations[source])
        guard = float(guard_by_source[source])
        cutoff = float(starts[index]) - guard
        curve = np.asarray(curves[source], float)
        output[index, 6] = max(cutoff, 0.0) if np.isfinite(cutoff) else np.nan
        output[index, 7] = 0.0
        if (
            len(curve) < 2 or not np.isfinite(duration + cutoff + guard)
            or guard <= 0 or cutoff < 0
        ):
            continue
        level = retention_at(curve, duration, cutoff)
        slopes = []
        for width in (0.5, 1.5, 3.0):
            slopes.append(retention_window_slope(
                curve, duration, cutoff - width, cutoff,
            ) if cutoff >= width else float("nan"))
        previous = retention_at(curve, duration, max(0.0, cutoff - 1.0))
        sample_start = max(0.0, cutoff - 2.0)
        samples = np.asarray([
            retention_at(curve, duration, second)
            for second in np.linspace(sample_start, cutoff, 9)
        ], float)
        output[index] = [
            level, *slopes,
            level - previous if np.isfinite(level + previous) else np.nan,
            float(np.nanstd(samples)) if np.isfinite(samples).any() else np.nan,
            cutoff,
            1.0,
        ]
    return output


def natural_baseline_features(mode: str, curves: list[np.ndarray],
                              source_indices: np.ndarray,
                              window_starts: np.ndarray, window_ends: np.ndarray,
                              durations: np.ndarray, entries: np.ndarray,
                              terminals: np.ndarray, amplitudes: np.ndarray,
                              history_starts: np.ndarray | None = None) -> np.ndarray:
    if mode not in BASELINE_CONTRACTS:
        raise ValueError(f"unknown natural baseline mode: {mode}")
    source_indices = np.asarray(source_indices, int)
    timing = natural_drop_features(
        window_starts, window_ends, np.asarray(durations)[source_indices],
        np.asarray(entries)[source_indices], np.asarray(terminals)[source_indices],
        np.asarray(amplitudes)[source_indices], np.asarray(entries)[source_indices],
        include_endpoints=False,
    )
    if mode == "timing_only":
        return timing
    if mode == "entry_level":
        entry = np.asarray(entries, float)[source_indices]
        return np.column_stack([timing, entry, entry ** 2]).astype(np.float32)
    if mode == "past_trajectory":
        history_starts = (
            np.asarray(window_starts, float)
            if history_starts is None else np.asarray(history_starts, float)
        )
        if len(history_starts) != len(window_starts):
            raise ValueError("history starts and response windows differ")
        past = past_trajectory_features(
            curves, durations, source_indices, history_starts,
        )
        return np.column_stack([timing, past]).astype(np.float32)
    entry = np.asarray(entries, float)[source_indices]
    terminal = np.asarray(terminals, float)[source_indices]
    amplitude = np.asarray(amplitudes, float)[source_indices]
    midpoint_fraction = (
        (np.asarray(window_starts, float) + np.asarray(window_ends, float)) / 2
        / np.maximum(np.asarray(durations, float)[source_indices], EPS)
    )
    return np.column_stack([
        timing, entry, terminal, amplitude,
        entry * midpoint_fraction, terminal * midpoint_fraction,
        amplitude * midpoint_fraction,
    ]).astype(np.float32)


def response_slopes(curves: list[np.ndarray], durations: np.ndarray,
                    source_indices: np.ndarray, starts: np.ndarray,
                    ends: np.ndarray) -> np.ndarray:
    output = np.full(len(starts), np.nan, np.float32)
    for index, source in enumerate(np.asarray(source_indices, int)):
        if not np.isfinite(float(starts[index]) + float(ends[index])):
            continue
        output[index] = retention_window_slope(
            curves[source], float(np.asarray(durations)[source]),
            float(starts[index]), float(ends[index]),
        )
    return output


def _impute_scale(train: np.ndarray, test: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    train = np.asarray(train, np.float32)
    test = np.asarray(test, np.float32)
    median = np.zeros(train.shape[1], np.float32)
    for column in range(train.shape[1]):
        values = train[np.isfinite(train[:, column]), column]
        if len(values):
            median[column] = float(np.median(values))
    train = np.where(np.isfinite(train), train, median)
    test = np.where(np.isfinite(test), test, median)
    scaler = StandardScaler().fit(train)
    return scaler.transform(train), scaler.transform(test)


def crossfit_natural_baseline(target: np.ndarray, natural: np.ndarray,
                              groups: np.ndarray,
                              splits: list[tuple[np.ndarray, np.ndarray]],
                              alpha: float = 10.0) -> dict:
    """Fit a category-blind, source-equal natural-drop baseline out of fold."""
    target = np.asarray(target, float)
    natural = np.asarray(natural, np.float32)
    groups = np.asarray(groups).astype(str)
    prediction = np.full(len(target), np.nan, np.float32)
    fold_rows = []
    for fold, (train, test) in enumerate(splits):
        train = np.asarray(train, int)
        test = np.asarray(test, int)
        if np.intersect1d(train, test).size:
            raise ValueError("natural baseline fold overlaps")
        fit = train[np.isfinite(target[train])]
        evaluate = test[np.isfinite(target[test])]
        if len(fit) < 8 or not len(evaluate):
            continue
        train_x, test_x = _impute_scale(natural[fit], natural[evaluate])
        model = Ridge(alpha=float(alpha)).fit(
            train_x, target[fit],
            sample_weight=source_equal_weights(groups[fit]),
        )
        prediction[evaluate] = model.predict(test_x).astype(np.float32)
        fold_rows.append({
            "fold": int(fold),
            "trainRows": int(len(fit)),
            "trainSources": int(len(set(groups[fit]))),
            "testRows": int(len(evaluate)),
            "testSources": int(len(set(groups[evaluate]))),
        })
    residual = target - prediction
    valid = np.isfinite(target + prediction)
    source_target = []
    source_prediction = []
    for group in sorted(set(groups[valid])):
        selected = valid & (groups == group)
        source_target.append(float(np.mean(target[selected])))
        source_prediction.append(float(np.mean(prediction[selected])))
    source_target = np.asarray(source_target, float)
    source_prediction = np.asarray(source_prediction, float)
    weights = source_equal_weights(groups[valid])
    weighted_mae = float(np.average(
        np.abs(target[valid] - prediction[valid]), weights=weights,
    )) if valid.any() else None
    return {
        "prediction": prediction,
        "residual": residual.astype(np.float32),
        "audit": {
            "status": "complete" if valid.sum() >= 8 else "insufficient",
            "evaluatedRows": int(valid.sum()),
            "evaluatedSources": int(len(source_target)),
            "sourceEqualMAE": weighted_mae,
            "rowSpearman": _finite(spearman(prediction[valid], target[valid])) if valid.any() else None,
            "sourceMeanSpearman": _finite(spearman(source_prediction, source_target)),
            "sourceMeanPearson": _finite(finite_correlation(source_prediction, source_target)),
            "categoryBlind": True,
            "sourceWeighting": "each source video has equal total weight in every fit",
            "ridgeAlpha": float(alpha),
            "folds": fold_rows,
        },
    }


def category_balanced_spearman(prediction: np.ndarray, target: np.ndarray,
                               categories: np.ndarray, groups: np.ndarray
                               ) -> tuple[float, dict[str, float | None]]:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    categories = np.asarray(categories, int)
    groups = np.asarray(groups).astype(str)
    rows = {}
    fisher = []
    for category in EXPECTED_CATEGORIES:
        selected = categories == category
        finite = selected & np.isfinite(prediction + target)
        if len(set(groups[finite])) < MIN_CATEGORY_SOURCES:
            rows[str(int(category))] = None
            continue
        value = weighted_spearman(
            prediction[selected], target[selected], groups[selected],
        )
        rows[str(int(category))] = _finite(value)
        if np.isfinite(value):
            fisher.append(np.arctanh(np.clip(value, -.999999, .999999)))
    return (
        (
            float(np.tanh(np.mean(fisher)))
            if len(fisher) == len(EXPECTED_CATEGORIES) else float("nan")
        ),
        rows,
    )


def _category_contributions(prediction: np.ndarray, target: np.ndarray,
                            groups: np.ndarray, categories: np.ndarray,
                            unique_groups: np.ndarray,
                            unique_categories: np.ndarray
                            ) -> tuple[float, np.ndarray, np.ndarray]:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    categories = np.asarray(categories, int)
    group_lookup = {group: index for index, group in enumerate(unique_groups)}
    output = np.zeros((len(unique_categories), len(unique_groups)), float)
    available = np.zeros(len(unique_categories), bool)
    values = []
    for category_index, category in enumerate(unique_categories):
        selected = (
            (categories == category)
            & np.isfinite(prediction + target)
        )
        if (
            selected.sum() < 4
            or len(set(groups[selected])) < MIN_CATEGORY_SOURCES
        ):
            values.append(float("nan"))
            continue
        available[category_index] = True
        x = rankdata(prediction[selected]).astype(float)
        y = rankdata(target[selected]).astype(float)
        category_groups = groups[selected]
        weights = source_equal_weights(category_groups).astype(float)
        weights /= max(float(weights.sum()), EPS)
        x -= float(np.sum(weights * x))
        y -= float(np.sum(weights * y))
        x /= math.sqrt(float(np.sum(weights * x ** 2))) + EPS
        y /= math.sqrt(float(np.sum(weights * y ** 2))) + EPS
        for value, group in zip(weights * x * y, category_groups):
            output[category_index, group_lookup[group]] += value
        values.append(float(output[category_index].sum()))
    finite = [value for value in values if np.isfinite(value)]
    observed = (
        float(np.tanh(np.mean(np.arctanh(np.clip(finite, -.999999, .999999)))))
        if len(finite) == len(unique_categories) else float("nan")
    )
    return observed, output, available


def family_max_null(prediction: np.ndarray, residuals: list[np.ndarray],
                    groups: np.ndarray, categories: np.ndarray,
                    repeats: int = 2048, seed: int = AUDIT_SEED) -> dict:
    """Correct every tested normalization/baseline/lag cell as one family."""
    unique_groups = np.asarray(sorted(set(np.asarray(groups).astype(str))))
    unique_categories = np.asarray(sorted(set(np.asarray(categories, int))), int)
    contributions = []
    available_categories = []
    observed = []
    for target in residuals:
        value, row, available = _category_contributions(
            prediction, target, groups, categories,
            unique_groups, unique_categories,
        )
        observed.append(value)
        contributions.append(row)
        available_categories.append(available)
    contribution_matrix = np.asarray(contributions, float)
    available_categories = np.asarray(available_categories, bool)
    observed = np.asarray(observed, float)
    supported = np.all(available_categories, axis=1) & np.isfinite(observed)
    if not supported.any():
        return {
            "pvalues": [1.0] * len(observed),
            "repeats": int(repeats),
            "criticalAbsRho95": None,
            "maximumObservedAbsRho": None,
            "supportedSpecificationCount": 0,
            "policy": (
                "no specification had the minimum independent-video support in every "
                "declared semantic category"
            ),
        }
    supported_contributions = contribution_matrix[supported]
    rng = np.random.default_rng(seed)
    null_max = np.empty(repeats, np.float32)
    for start in range(0, repeats, 64):
        count = min(64, repeats - start)
        signs = rng.choice((-1.0, 1.0), size=(count, len(unique_groups)))
        null_by_category = np.einsum(
            "bg,scg->bsc", signs, supported_contributions, optimize=True,
        )
        transformed = np.arctanh(np.clip(
            null_by_category, -.999999, .999999,
        ))
        null_stats = np.tanh(np.mean(transformed, axis=2))
        null_max[start:start + count] = np.max(np.abs(null_stats), axis=1)
    pvalues = [
        float((1 + np.sum(null_max >= abs(value))) / (repeats + 1))
        if np.isfinite(value) else 1.0
        for value in observed
    ]
    return {
        "pvalues": pvalues,
        "repeats": int(repeats),
        "criticalAbsRho95": float(np.quantile(null_max, .95)),
        "maximumObservedAbsRho": float(np.nanmax(np.abs(observed))),
        "supportedSpecificationCount": int(supported.sum()),
        "policy": (
            "source-video wild sign flips; maximum absolute equal-category, source-equal "
            "Fisher-mean weighted Spearman across every statistically supported normalization, "
            "natural baseline, ridge strength, and lag cell; unsupported cells never enter "
            "the family null"
        ),
    }


def source_equal_curve_bands(families: dict[str, list[np.ndarray]],
                             durations: np.ndarray, hook_ends: np.ndarray,
                             points: int = 41) -> dict:
    progress = np.linspace(0.0, 1.0, points)
    output = {}
    for family_id, curves in families.items():
        rows = []
        for source, curve in enumerate(curves):
            end = min(float(hook_ends[source]), float(durations[source]))
            if len(curve) < 2 or not np.isfinite(end) or end <= 0:
                continue
            rows.append([
                retention_at(curve, float(durations[source]), float(value * end)) * 100.0
                for value in progress
            ])
        values = np.asarray(rows, float)
        output[family_id] = {
            "progressFractions": progress.astype(float).tolist(),
            "medianPercent": np.nanmedian(values, axis=0).astype(float).tolist(),
            "p10Percent": np.nanquantile(values, .1, axis=0).astype(float).tolist(),
            "p90Percent": np.nanquantile(values, .9, axis=0).astype(float).tolist(),
            "sourceVideos": int(len(values)),
        }
    return output


def paired_forward_reverse_inference(semantic_prediction: np.ndarray,
                                     forward: np.ndarray, reverse: np.ndarray,
                                     groups: np.ndarray, categories: np.ndarray,
                                     repeats: int = 2048,
                                     seed: int = AUDIT_SEED) -> dict:
    """Source-bootstrap the exact forward rho minus absolute mirrored reverse rho."""
    semantic_prediction = np.asarray(semantic_prediction, float)
    forward = np.asarray(forward, float)
    reverse = np.asarray(reverse, float)
    groups = np.asarray(groups).astype(str)
    categories = np.asarray(categories, int)
    common = np.isfinite(semantic_prediction + forward + reverse)
    prediction = semantic_prediction[common]
    forward = forward[common]
    reverse = reverse[common]
    groups = groups[common]
    categories = categories[common]
    forward_rho, _ = category_balanced_spearman(
        prediction, forward, categories, groups,
    )
    reverse_rho, _ = category_balanced_spearman(
        prediction, reverse, categories, groups,
    )
    observed = (
        float(forward_rho - abs(reverse_rho))
        if np.isfinite(forward_rho + reverse_rho) else float("nan")
    )
    unique = np.asarray(sorted(set(groups)))
    if not np.isfinite(observed):
        return {
            "commonRows": int(common.sum()),
            "sourceVideos": int(len(unique)),
            "forwardRho": _finite(forward_rho),
            "reverseRho": _finite(reverse_rho),
            "forwardMinusAbsReverse": None,
            "differenceCiLow": None,
            "differenceCiHigh": None,
            "oneSidedBootstrapP": 1.0,
            "repeats": int(repeats),
            "policy": (
                "unsupported because at least one declared semantic category has fewer "
                f"than {MIN_CATEGORY_SOURCES} independent source videos"
            ),
        }
    group_rows = {group: np.flatnonzero(groups == group) for group in unique}
    rng = np.random.default_rng(seed)
    bootstrap = np.full(repeats, np.nan, np.float32)
    for repeat in range(repeats):
        sample = rng.choice(unique, size=len(unique), replace=True)
        positions = np.concatenate([group_rows[group] for group in sample])
        bootstrap_groups = np.concatenate([
            np.repeat(f"{draw}:{group}", len(group_rows[group]))
            for draw, group in enumerate(sample)
        ])
        boot_forward, _ = category_balanced_spearman(
            prediction[positions], forward[positions], categories[positions],
            bootstrap_groups,
        )
        boot_reverse, _ = category_balanced_spearman(
            prediction[positions], reverse[positions], categories[positions],
            bootstrap_groups,
        )
        bootstrap[repeat] = boot_forward - abs(boot_reverse)
    finite = bootstrap[np.isfinite(bootstrap)]
    return {
        "commonRows": int(common.sum()),
        "sourceVideos": int(len(unique)),
        "forwardRho": _finite(forward_rho),
        "reverseRho": _finite(reverse_rho),
        "forwardMinusAbsReverse": _finite(observed),
        "differenceCiLow": _finite(np.quantile(finite, .025)) if len(finite) else None,
        "differenceCiHigh": _finite(np.quantile(finite, .975)) if len(finite) else None,
        "oneSidedBootstrapP": (
            float((1 + np.sum(finite <= 0)) / (len(finite) + 1))
            if len(finite) else 1.0
        ),
        "repeats": int(repeats),
        "policy": (
            "paired source-video bootstrap; each draw receives a distinct source identity; "
            "statistic is forward source-equal rho minus absolute mirrored reverse rho"
        ),
    }


def build_deconfounding_audit(*, semantic_prediction: np.ndarray,
                              raw_curves: list[np.ndarray], durations: np.ndarray,
                              starts: np.ndarray, ends: np.ndarray,
                              source_indices: np.ndarray, groups: np.ndarray,
                              categories: np.ndarray, entries: np.ndarray,
                              terminals: np.ndarray, amplitudes: np.ndarray,
                              selected_lag: float, hook_ends: np.ndarray,
                              repeats: int = 2048) -> dict:
    """Evaluate one frozen OOF semantic axis across every deconfounding choice."""
    semantic_prediction = np.asarray(semantic_prediction, float)
    starts = np.asarray(starts, float)
    ends = np.asarray(ends, float)
    groups = np.asarray(groups).astype(str)
    categories = np.asarray(categories, int)
    lags = np.round(np.arange(-3.0, 5.0001, .5), 2)
    families = retention_curve_families(raw_curves, terminals)
    resolution = source_native_sample_seconds(raw_curves, durations).astype(float)
    finite_resolution = resolution[np.isfinite(resolution) & (resolution > 0)]
    splits = list(GroupKFold(n_splits=min(5, len(set(groups)))).split(
        np.arange(len(groups)), groups=groups,
    ))
    rows = []
    residuals = []
    residual_lookup = {}
    for normalization_id, curves in families.items():
        normalization = NORMALIZATION_CONTRACTS[normalization_id]
        for baseline_id, baseline_contract in BASELINE_CONTRACTS.items():
            for baseline_alpha in BASELINE_ALPHA_SENSITIVITY:
                for lag in lags:
                    left = starts + lag
                    right = ends + lag
                    target = response_slopes(
                        curves, durations, source_indices, left, right,
                    )
                    natural = natural_baseline_features(
                        baseline_id, curves, source_indices, left, right,
                        durations, entries, terminals, amplitudes,
                        history_starts=starts,
                    )
                    baseline = crossfit_natural_baseline(
                        target, natural, groups, splits, alpha=baseline_alpha,
                    )
                    residual = np.asarray(baseline["residual"], float)
                    rho, by_category = category_balanced_spearman(
                        semantic_prediction, residual, categories, groups,
                    )
                    row = {
                        "normalizationId": normalization_id,
                        "normalizationLabel": normalization["label"],
                        "baselineId": baseline_id,
                        "baselineLabel": baseline_contract["label"],
                        "baselineRidgeAlpha": float(baseline_alpha),
                        "lagSeconds": float(lag),
                        "heldoutCategoryBalancedSpearman": _finite(rho),
                        "heldoutSpearmanByCategory": by_category,
                        "evaluatedRows": int(np.isfinite(semantic_prediction + residual).sum()),
                        "futureFree": bool(
                            normalization["futureFree"] and baseline_contract["futureFree"]
                        ),
                        "usesTerminalRetention": bool(
                            normalization["usesTerminalRetention"]
                            or baseline_contract["usesTerminalRetention"]
                        ),
                        "naturalBaselineAudit": baseline["audit"],
                        "supported": bool(np.isfinite(rho)),
                    }
                    rows.append(row)
                    residuals.append(residual)
                    residual_lookup[
                        (normalization_id, baseline_id, float(baseline_alpha), float(lag))
                    ] = residual
    family = family_max_null(
        semantic_prediction, residuals, groups, categories,
        repeats=repeats,
    )
    for row, pvalue in zip(rows, family["pvalues"]):
        row["familyMaxNullP"] = pvalue
    family.pop("pvalues")

    future_free_rows = [row for row in rows if row["futureFree"]]
    consensus = []
    for lag in lags:
        values = np.asarray([
            row["heldoutCategoryBalancedSpearman"]
            for row in future_free_rows
            if row["lagSeconds"] == float(lag)
            and row["heldoutCategoryBalancedSpearman"] is not None
        ], float)
        consensus.append({
            "lagSeconds": float(lag),
            "specifications": int(len(values)),
            "medianRho": _finite(np.median(values)) if len(values) else None,
            "minimumRho": _finite(np.min(values)) if len(values) else None,
            "maximumRho": _finite(np.max(values)) if len(values) else None,
            "positiveFraction": _finite(np.mean(values > 0)) if len(values) else None,
        })

    matched_reverse = []
    available_reverse_lags = set(float(value) for value in lags if value < 0)
    for lag in lags[(lags > 0) & (lags <= abs(min(available_reverse_lags)))]:
        forward = residual_lookup[
            ("entry_indexed", "past_trajectory", PRIMARY_BASELINE_ALPHA, float(lag))
        ]
        reverse = residual_lookup[
            ("entry_indexed", "past_trajectory", PRIMARY_BASELINE_ALPHA, float(-lag))
        ]
        comparison = paired_forward_reverse_inference(
            semantic_prediction, forward, reverse, groups, categories,
            repeats=min(int(repeats), 2048), seed=AUDIT_SEED + int(lag * 100),
        )
        matched_reverse.append({
            "absoluteLagSeconds": float(lag),
            **comparison,
        })

    primary = next(
        row for row in rows
        if row["normalizationId"] == "entry_indexed"
        and row["baselineId"] == "past_trajectory"
        and math.isclose(
            row["baselineRidgeAlpha"], PRIMARY_BASELINE_ALPHA, abs_tol=1e-9,
        )
        and math.isclose(row["lagSeconds"], float(selected_lag), abs_tol=1e-6)
    )
    selected_reverse = next((
        row for row in matched_reverse
        if math.isclose(row["absoluteLagSeconds"], float(selected_lag), abs_tol=1e-6)
    ), None)
    selected_consensus = next(
        row for row in consensus
        if math.isclose(row["lagSeconds"], float(selected_lag), abs_tol=1e-6)
    )
    processing_lag_supported = bool(
        float(selected_lag) > 0
        and primary["heldoutCategoryBalancedSpearman"] is not None
        and primary["heldoutCategoryBalancedSpearman"] > 0
        and primary["familyMaxNullP"] <= .05
        and selected_reverse is not None
        and selected_reverse["differenceCiLow"] is not None
        and selected_reverse["differenceCiLow"] > 0
        and selected_reverse["oneSidedBootstrapP"] <= .05
        and selected_consensus["minimumRho"] is not None
        and selected_consensus["minimumRho"] > 0
    )
    return {
        "status": "complete",
        "methodVersion": "retention-deconfounding-and-lag-robustness-v3",
        "primarySpecification": {
            **{key: value for key, value in primary.items()
               if key != "naturalBaselineAudit"},
            "targetRole": "primary future-free observational response target",
            "trainingBaselineRole": (
                "past-only measured trajectory is used to isolate the training residual; "
                "the deployable semantic axis still scores text embeddings alone"
            ),
        },
        "normalizationContracts": NORMALIZATION_CONTRACTS,
        "baselineContracts": BASELINE_CONTRACTS,
        "specificationRows": rows,
        "futureFreeConsensusByLag": consensus,
        "matchedForwardReverse": matched_reverse,
        "familyInference": family,
        "testedSpecificationCount": int(len(rows)),
        "baselineRidgeAlphaSensitivity": list(BASELINE_ALPHA_SENSITIVITY),
        "processingLagSupported": processing_lag_supported,
        "processingLagDecision": (
            "supported only if the predeclared primary future-free cell survives the full "
            "normalization/baseline/ridge/lag max-null, every future-free specification is "
            "positive, and the paired source-bootstrap forward-minus-absolute-reverse lower "
            "95% bound is above zero"
        ),
        "processingLagConclusion": (
            "No processing delay is identified; use zero added lag for scoring."
            if not processing_lag_supported else
            f"A {selected_lag:g}s forward processing delay passed every gate."
        ),
        "nativeCurveResolution": {
            "medianSampleSeconds": _finite(np.median(finite_resolution)),
            "p10SampleSeconds": _finite(np.quantile(finite_resolution, .1)),
            "p90SampleSeconds": _finite(np.quantile(finite_resolution, .9)),
            "subMedianResolutionClaimAllowed": False,
        },
        "normalizationCurveBands": source_equal_curve_bands(
            families, durations, hook_ends,
        ),
        "leakageAudit": {
            "sourceGroupedOuterFolds": True,
            "categoryBlindNaturalBaseline": True,
            "equalTotalWeightPerSourceVideo": True,
            "primaryTargetUsesFullVideoTerminal": False,
            "primaryPastTrajectoryGuardPolicy": (
                "one native retention sample before each spoken component begins"
            ),
            "primaryPastTrajectoryGuardSecondsP10": _finite(
                np.quantile(finite_resolution, .1)
            ),
            "primaryPastTrajectoryGuardSecondsMedian": _finite(
                np.median(finite_resolution)
            ),
            "primaryPastTrajectoryGuardSecondsP90": _finite(
                np.quantile(finite_resolution, .9)
            ),
            "primaryPastTrajectoryOverlapsResponseWindow": False,
            "primaryPastTrajectoryUsesPostUtteranceMeasurements": False,
            "globallyOOFPredictedEntryUsedInsideOuterFold": False,
            "terminalConditionedResultsRestrictedToSensitivity": True,
        },
        "claimBoundary": (
            "Rewatch counts and first-pass retention are not identifiable from an aggregate "
            "audience-retention curve. Terminal-conditioned views are retrospective indexes, "
            "not recovered causal curves. A positive lag is not a processing delay unless it "
            "beats matched reverse-time controls after family-wise correction and paired "
            "source-bootstrap uncertainty."
        ),
    }
