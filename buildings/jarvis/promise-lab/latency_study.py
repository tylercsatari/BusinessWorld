"""Held-out temporal attribution primitives for Promise Lab span embeddings."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import rankdata
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import GroupKFold

from axes import finite_correlation, spearman
from cluster_outcomes import AXIS_SEED, balanced_group_positions, _impute_scale


EPS = 1e-9


@dataclass(frozen=True)
class WindowSpec:
    id: str
    label: str
    anchor: str
    width: float | None
    definition: str


DEFAULT_LAGS = np.round(np.arange(-3.0, 8.0001, 0.5), 2)
DEFAULT_WINDOWS = (
    WindowSpec(
        "phrase", "Whole phrase shifted", "phrase", None,
        "the source-media CTC start-to-end interval, shifted by the tested lag",
    ),
    WindowSpec(
        "onset_1s", "1s after phrase starts", "onset", 1.0,
        "a fixed one-second response window beginning at phrase start plus lag",
    ),
    WindowSpec(
        "offset_1s", "1s after phrase ends", "offset", 1.0,
        "a fixed one-second response window beginning at phrase end plus lag",
    ),
    WindowSpec(
        "onset_2s", "2s after phrase starts", "onset", 2.0,
        "a fixed two-second response window beginning at phrase start plus lag",
    ),
    WindowSpec(
        "offset_2s", "2s after phrase ends", "offset", 2.0,
        "a fixed two-second response window beginning at phrase end plus lag",
    ),
)


def window_intervals(starts: np.ndarray, ends: np.ndarray, lags: np.ndarray,
                     spec: WindowSpec) -> tuple[np.ndarray, np.ndarray]:
    starts = np.asarray(starts, float)
    ends = np.asarray(ends, float)
    lags = np.asarray(lags, float)
    if spec.anchor == "phrase":
        left = starts[:, None] + lags[None, :]
        right = ends[:, None] + lags[None, :]
    elif spec.anchor == "onset":
        left = starts[:, None] + lags[None, :]
        right = left + float(spec.width or 0)
    elif spec.anchor == "offset":
        left = ends[:, None] + lags[None, :]
        right = left + float(spec.width or 0)
    else:
        raise ValueError(f"unknown response-window anchor: {spec.anchor}")
    return left.astype(np.float32), right.astype(np.float32)


def retention_slope_matrix(curves: list[np.ndarray], durations: np.ndarray,
                           starts: np.ndarray, ends: np.ndarray,
                           hook_indices: np.ndarray, lags: np.ndarray,
                           spec: WindowSpec, samples: int = 21) -> tuple[np.ndarray, dict]:
    """Vectorized least-squares slopes for every span and tested response lag."""
    durations = np.asarray(durations, float)
    hook_indices = np.asarray(hook_indices, int)
    left, right = window_intervals(starts, ends, lags, spec)
    output = np.full(left.shape, np.nan, np.float32)
    fractions = np.linspace(0.0, 1.0, max(3, int(samples)), dtype=np.float64)

    for hook_index in range(len(curves)):
        positions = np.flatnonzero(hook_indices == hook_index)
        if not len(positions):
            continue
        curve = np.asarray(curves[hook_index], float)
        duration = float(durations[hook_index])
        if len(curve) < 2 or not np.isfinite(duration) or duration <= 0:
            continue
        curve_seconds = np.linspace(0.0, duration, len(curve), dtype=np.float64)
        for lag_index in range(len(lags)):
            window_start = left[positions, lag_index].astype(float)
            window_end = right[positions, lag_index].astype(float)
            valid = (
                np.isfinite(window_start + window_end)
                & (window_start >= 0)
                & (window_end <= duration)
                & (window_end - window_start > 1e-4)
            )
            if not valid.any():
                continue
            selected = positions[valid]
            local_start = window_start[valid]
            local_end = window_end[valid]
            seconds = local_start[:, None] + (
                local_end - local_start
            )[:, None] * fractions[None, :]
            values = np.interp(seconds.ravel(), curve_seconds, curve).reshape(seconds.shape)
            centered_seconds = seconds - seconds.mean(axis=1, keepdims=True)
            centered_values = values - values.mean(axis=1, keepdims=True)
            denominator = np.sum(centered_seconds ** 2, axis=1)
            slopes = np.sum(centered_seconds * centered_values, axis=1) / np.maximum(
                denominator, EPS
            )
            output[selected, lag_index] = slopes.astype(np.float32)

    return output, {
        "windowStarts": left,
        "windowEnds": right,
        "measured": np.isfinite(output).sum(axis=0).astype(int).tolist(),
        "samplesPerSlope": len(fractions),
    }


def natural_drop_features(window_starts: np.ndarray, window_ends: np.ndarray,
                          video_durations: np.ndarray, entries: np.ndarray,
                          terminals: np.ndarray, amplitudes: np.ndarray,
                          predicted_entries: np.ndarray,
                          include_endpoints: bool = True) -> np.ndarray:
    """Text-free deterministic basis for the natural retention-curve shape."""
    start = np.asarray(window_starts, float)
    end = np.asarray(window_ends, float)
    duration = np.asarray(video_durations, float)
    middle = (start + end) / 2
    width = end - start
    safe_duration = np.maximum(duration, EPS)
    start_fraction = start / safe_duration
    end_fraction = end / safe_duration
    middle_fraction = middle / safe_duration
    width_fraction = width / safe_duration
    base = np.column_stack([
        start, end, middle, width,
        np.log1p(np.maximum(start, 0)),
        np.log1p(np.maximum(middle, 0)),
        np.log1p(np.maximum(width, 0)),
        start_fraction, end_fraction, middle_fraction, width_fraction,
        start_fraction ** 2, end_fraction ** 2,
        middle_fraction ** 2, middle_fraction ** 3,
        duration, np.log1p(np.maximum(duration, 0)),
    ])
    if not include_endpoints:
        return base.astype(np.float32)
    entry = np.asarray(entries, float)
    terminal = np.asarray(terminals, float)
    amplitude = np.asarray(amplitudes, float)
    predicted = np.asarray(predicted_entries, float)
    endpoint = np.column_stack([
        entry, terminal, amplitude, predicted, entry - predicted,
        middle_fraction * entry,
        middle_fraction * terminal,
        width_fraction * amplitude,
    ])
    return np.column_stack([base, endpoint]).astype(np.float32)


def _fit_ridge(train_x: np.ndarray, train_y: np.ndarray, test_x: np.ndarray,
               alpha: float, groups: np.ndarray, per_group: int,
               seed: int) -> tuple[np.ndarray, np.ndarray, Ridge]:
    valid = np.isfinite(train_y) & np.all(np.isfinite(train_x), axis=1)
    positions = np.flatnonzero(valid)
    if len(positions) < 8 or len(set(groups[positions])) < 2:
        raise ValueError("insufficient grouped rows for ridge fit")
    balanced = balanced_group_positions(
        groups[positions], per_group=per_group, seed=seed,
    )
    fit_positions = positions[balanced]
    fit_x, all_train_x, all_test_x = _impute_scale(
        train_x[fit_positions], train_x, test_x,
    )
    model = Ridge(alpha=float(alpha)).fit(fit_x, train_y[fit_positions])
    return model.predict(all_train_x), model.predict(all_test_x), model


def _fold_semantic_scores(features: np.ndarray, fit_positions: np.ndarray,
                          train: np.ndarray, test: np.ndarray,
                          dimensions: int, seed: int) -> tuple[np.ndarray, np.ndarray, PCA, np.ndarray]:
    dimension = min(int(dimensions), features.shape[1], len(fit_positions) - 1)
    pca = PCA(
        n_components=max(1, dimension), svd_solver="randomized", random_state=seed,
    ).fit(features[fit_positions])
    fit_scores = pca.transform(features[fit_positions])
    train_scores = pca.transform(features[train])
    test_scores = pca.transform(features[test])
    fit_scores, train_scores, test_scores = _impute_scale(
        fit_scores, train_scores, test_scores,
    )
    scale = np.std(pca.transform(features[fit_positions]), axis=0)
    scale = np.where(scale > EPS, scale, 1.0)
    return train_scores, test_scores, pca, scale


def shared_lag_semantic_oof(features: np.ndarray, groups: np.ndarray,
                            targets_by_window: dict[str, np.ndarray],
                            intervals_by_window: dict[str, tuple[np.ndarray, np.ndarray]],
                            lags: np.ndarray,
                            video_durations: np.ndarray, entries: np.ndarray,
                            terminals: np.ndarray, amplitudes: np.ndarray,
                            predicted_entries: np.ndarray,
                            primary_window: str = "phrase", dimensions: int = 32,
                            semantic_alpha: float = 1.0, baseline_alpha: float = .1,
                            folds: int = 5, per_group: int = 32,
                            seed: int = AXIS_SEED) -> dict:
    """Fit one semantic direction across every lag/window, always testing held-out videos."""
    features = np.asarray(features, np.float32)
    groups = np.asarray(groups).astype(str)
    lags = np.asarray(lags, float)
    window_ids = list(targets_by_window)
    lag_count = next(iter(targets_by_window.values())).shape[1]
    output_keys = [(window_id, lag_index) for window_id in window_ids for lag_index in range(lag_count)]
    output_count = len(output_keys)
    n = len(groups)
    oof_score = np.full(n, np.nan, np.float32)
    oof_residuals = {name: np.full_like(values, np.nan, np.float32) for name, values in targets_by_window.items()}
    oof_baseline = {name: np.full_like(values, np.nan, np.float32) for name, values in targets_by_window.items()}
    oof_time_only = {name: np.full_like(values, np.nan, np.float32) for name, values in targets_by_window.items()}
    transfer_scores = np.full((lag_count, n), np.nan, np.float32)
    fold_rows = []
    original_axes = []
    splits = list(GroupKFold(n_splits=min(folds, len(set(groups)))).split(np.arange(n), groups=groups))

    for fold_index, (train, test) in enumerate(splits):
        balanced = balanced_group_positions(
            groups[train], per_group=per_group, seed=seed + fold_index,
        )
        fit_positions = train[balanced]
        train_x, test_x, pca, pca_scale = _fold_semantic_scores(
            features, fit_positions, train, test, dimensions, seed + fold_index,
        )
        coefficients = np.zeros((train_x.shape[1], output_count), np.float64)
        intercepts = np.zeros(output_count, np.float64)
        residual_train_by_key = {}

        for output_index, (window_id, lag_index) in enumerate(output_keys):
            target = np.asarray(targets_by_window[window_id], float)
            window_start, window_end = intervals_by_window[window_id]
            train_target = target[train, lag_index]
            test_target = target[test, lag_index]
            endpoint_features = natural_drop_features(
                window_start[:, lag_index], window_end[:, lag_index], video_durations,
                entries, terminals, amplitudes, predicted_entries, True,
            )
            time_features = natural_drop_features(
                window_start[:, lag_index], window_end[:, lag_index], video_durations,
                entries, terminals, amplitudes, predicted_entries, False,
            )
            try:
                baseline_train, baseline_test, _ = _fit_ridge(
                    endpoint_features[train], train_target, endpoint_features[test],
                    baseline_alpha, groups[train], per_group,
                    seed + fold_index * 1000 + output_index,
                )
                _, time_test, _ = _fit_ridge(
                    time_features[train], train_target, time_features[test],
                    baseline_alpha, groups[train], per_group,
                    seed + 200_000 + fold_index * 1000 + output_index,
                )
            except ValueError:
                continue
            train_residual = train_target - baseline_train
            test_residual = test_target - baseline_test
            oof_baseline[window_id][test, lag_index] = baseline_test.astype(np.float32)
            oof_time_only[window_id][test, lag_index] = time_test.astype(np.float32)
            oof_residuals[window_id][test, lag_index] = test_residual.astype(np.float32)
            residual_train_by_key[(window_id, lag_index)] = train_residual

            valid = np.isfinite(train_residual)
            positions = np.flatnonzero(valid)
            if len(positions) < 8:
                continue
            semantic_balanced = balanced_group_positions(
                groups[train][positions], per_group=per_group,
                seed=seed + 400_000 + fold_index * 1000 + output_index,
            )
            fit_local = positions[semantic_balanced]
            mean = float(np.mean(train_residual[fit_local]))
            scale = float(np.std(train_residual[fit_local]))
            if not np.isfinite(scale) or scale <= EPS:
                continue
            model = Ridge(alpha=float(semantic_alpha)).fit(
                train_x[fit_local], (train_residual[fit_local] - mean) / scale,
            )
            coefficients[:, output_index] = model.coef_
            intercepts[output_index] = model.intercept_
            if window_id == primary_window:
                transfer_scores[lag_index, test] = model.predict(test_x).astype(np.float32)

        singular_vectors, singular_values, _ = np.linalg.svd(coefficients, full_matrices=False)
        mode = singular_vectors[:, 0]
        kernel = mode @ coefficients
        primary_causal = [
            index for index, (window_id, lag_index) in enumerate(output_keys)
            if window_id == primary_window and lags[lag_index] >= 0
        ]
        if primary_causal:
            strongest = primary_causal[int(np.argmax(np.abs(kernel[primary_causal])))]
            if kernel[strongest] < 0:
                mode = -mode
                kernel = -kernel
        train_score = train_x @ mode
        test_score = test_x @ mode
        score_mean = float(np.mean(train_score))
        score_scale = float(np.std(train_score)) or 1.0
        oof_score[test] = ((test_score - score_mean) / score_scale).astype(np.float32)
        original_axis = pca.components_[:len(mode)].T @ (mode / pca_scale[:len(mode)])
        original_axis /= np.linalg.norm(original_axis) + EPS
        original_axes.append(original_axis)
        energy = singular_values ** 2
        fold_rows.append({
            "fold": fold_index,
            "trainVideos": len(set(groups[train])),
            "testVideos": len(set(groups[test])),
            "firstModeEnergy": float(energy[0] / max(EPS, energy.sum())),
            "singularValues": singular_values[:5].astype(float).tolist(),
        })

    pairwise_cosines = []
    for left in range(len(original_axes)):
        for right in range(left + 1, len(original_axes)):
            pairwise_cosines.append(float(np.dot(original_axes[left], original_axes[right])))
    return {
        "score": oof_score,
        "residuals": oof_residuals,
        "baseline": oof_baseline,
        "timeOnlyBaseline": oof_time_only,
        "transferScores": transfer_scores,
        "folds": fold_rows,
        "foldAxisCosines": pairwise_cosines,
        "foldAxisMedianCosine": float(np.median(pairwise_cosines)) if pairwise_cosines else None,
        "foldAxisMedianAbsoluteCosine": float(np.median(np.abs(pairwise_cosines))) if pairwise_cosines else None,
        "foldAxisPositivePairFraction": float(np.mean(np.asarray(pairwise_cosines) > 0)) if pairwise_cosines else None,
        "allFoldDirectionsAgree": bool(pairwise_cosines and all(value > 0 for value in pairwise_cosines)),
    }


def natural_baseline_oof(targets: np.ndarray,
                         intervals: tuple[np.ndarray, np.ndarray],
                         groups: np.ndarray, video_durations: np.ndarray,
                         entries: np.ndarray, terminals: np.ndarray,
                         amplitudes: np.ndarray, predicted_entries: np.ndarray,
                         include_endpoints: bool = True, alpha: float = .1,
                         folds: int = 5, per_group: int = 32,
                         seed: int = AXIS_SEED) -> np.ndarray:
    """Source-video-held-out text-free expectation for every response lag."""
    targets = np.asarray(targets, float)
    groups = np.asarray(groups).astype(str)
    window_start, window_end = intervals
    predictions = np.full_like(targets, np.nan, np.float32)
    splits = GroupKFold(n_splits=min(folds, len(set(groups)))).split(
        np.arange(len(groups)), groups=groups,
    )
    for fold_index, (train, test) in enumerate(splits):
        for lag_index in range(targets.shape[1]):
            features = natural_drop_features(
                window_start[:, lag_index], window_end[:, lag_index], video_durations,
                entries, terminals, amplitudes, predicted_entries, include_endpoints,
            )
            try:
                _, test_prediction, _ = _fit_ridge(
                    features[train], targets[train, lag_index], features[test],
                    alpha, groups[train], per_group,
                    seed + fold_index * 1000 + lag_index,
                )
            except ValueError:
                continue
            predictions[test, lag_index] = test_prediction.astype(np.float32)
    return predictions


def _rank_contributions(score: np.ndarray, target: np.ndarray,
                        groups: np.ndarray) -> tuple[float, np.ndarray] | None:
    valid = np.isfinite(score) & np.isfinite(target)
    if valid.sum() < 8:
        return None
    x = rankdata(score[valid]).astype(float)
    y = rankdata(target[valid]).astype(float)
    x = (x - x.mean()) / (x.std() + EPS)
    y = (y - y.mean()) / (y.std() + EPS)
    selected_groups = groups[valid]
    unique = sorted(set(groups))
    lookup = {group: index for index, group in enumerate(unique)}
    contributions = np.zeros(len(unique), float)
    for group in set(selected_groups):
        members = selected_groups == group
        contributions[lookup[group]] = float(np.sum(x[members] * y[members]) / len(x))
    return float(np.sum(contributions)), contributions


def _effect_contributions(score: np.ndarray, target: np.ndarray,
                          groups: np.ndarray) -> tuple[float, np.ndarray] | None:
    valid = np.isfinite(score) & np.isfinite(target)
    if valid.sum() < 8:
        return None
    x = np.asarray(score[valid], float)
    y = np.asarray(target[valid], float)
    x = (x - x.mean()) / (x.std() + EPS)
    y = y - y.mean()
    denominator = float(np.sum(x ** 2)) + EPS
    selected_groups = groups[valid]
    unique = sorted(set(groups))
    lookup = {group: index for index, group in enumerate(unique)}
    contributions = np.zeros(len(unique), float)
    for group in set(selected_groups):
        members = selected_groups == group
        contributions[lookup[group]] = float(np.sum(x[members] * y[members]) / denominator)
    return float(np.sum(contributions)), contributions


def lag_family_inference(score: np.ndarray, targets_by_window: dict[str, np.ndarray],
                         groups: np.ndarray, lags: np.ndarray,
                         repeats: int = 512, per_group: int = 32,
                         seed: int = AXIS_SEED) -> dict:
    """Group sign-flip max-null and source bootstrap intervals across every lag tested."""
    score = np.asarray(score, float)
    groups = np.asarray(groups).astype(str)
    lags = np.asarray(lags, float)
    selected = balanced_group_positions(groups, per_group=per_group, seed=seed)
    score = score[selected]
    selected_groups = groups[selected]
    keys = []
    observed = []
    contribution_rows = []
    effects = []
    effect_contribution_rows = []
    for window_id, matrix in targets_by_window.items():
        matrix = np.asarray(matrix, float)[selected]
        for lag_index, lag in enumerate(lags):
            result = _rank_contributions(score, matrix[:, lag_index], selected_groups)
            effect_result = _effect_contributions(score, matrix[:, lag_index], selected_groups)
            if result is None or effect_result is None:
                continue
            correlation, contributions = result
            effect, effect_contributions = effect_result
            keys.append((window_id, lag_index, float(lag)))
            observed.append(correlation)
            contribution_rows.append(contributions)
            effects.append(effect)
            effect_contribution_rows.append(effect_contributions)
    contribution_matrix = np.asarray(contribution_rows, float)
    effect_contribution_matrix = np.asarray(effect_contribution_rows, float)
    observed = np.asarray(observed, float)
    effects = np.asarray(effects, float)
    rng = np.random.default_rng(seed)
    unique_groups = contribution_matrix.shape[1]
    null_max = np.empty(repeats, float)
    batch = 64
    for start in range(0, repeats, batch):
        count = min(batch, repeats - start)
        signs = rng.choice((-1.0, 1.0), size=(unique_groups, count))
        null = np.abs(contribution_matrix @ signs)
        null_max[start:start + count] = np.max(null, axis=0)
    pvalues = (1 + np.sum(null_max[None, :] >= np.abs(observed)[:, None], axis=1)) / (repeats + 1)

    bootstrap = np.empty((repeats, len(keys)), np.float32)
    effect_bootstrap = np.empty((repeats, len(keys)), np.float32)
    for repeat in range(repeats):
        sample = rng.integers(0, unique_groups, size=unique_groups)
        bootstrap[repeat] = contribution_matrix[:, sample].sum(axis=1)
        effect_bootstrap[repeat] = effect_contribution_matrix[:, sample].sum(axis=1)
    lower = np.quantile(bootstrap, .025, axis=0)
    upper = np.quantile(bootstrap, .975, axis=0)
    effect_lower = np.quantile(effect_bootstrap, .025, axis=0)
    effect_upper = np.quantile(effect_bootstrap, .975, axis=0)
    rows = {}
    for index, (window_id, lag_index, lag) in enumerate(keys):
        rows.setdefault(window_id, {})[str(lag_index)] = {
            "lag": lag,
            "rho": float(observed[index]),
            "ciLow": float(lower[index]),
            "ciHigh": float(upper[index]),
            "effect": float(effects[index]),
            "effectCiLow": float(effect_lower[index]),
            "effectCiHigh": float(effect_upper[index]),
            "maxNullP": float(pvalues[index]),
        }
    peak_bootstrap = {}
    for window_id in targets_by_window:
        positions = [index for index, key in enumerate(keys) if key[0] == window_id and key[2] >= 0]
        if not positions:
            continue
        peak_indices = np.argmax(effect_bootstrap[:, positions], axis=1)
        peak_lags = np.asarray([keys[positions[index]][2] for index in peak_indices], float)
        observed_peak_position = positions[int(np.argmax(effects[positions]))]
        values, counts = np.unique(peak_lags, return_counts=True)
        peak_bootstrap[window_id] = {
            "observedPeakLag": float(keys[observed_peak_position][2]),
            "observedPeakEffect": float(effects[observed_peak_position]),
            "medianLag": float(np.median(peak_lags)),
            "ciLowLag": float(np.quantile(peak_lags, .025)),
            "ciHighLag": float(np.quantile(peak_lags, .975)),
            "counts": {str(value): int(count) for value, count in zip(values, counts)},
        }
    return {
        "rows": rows,
        "peakBootstrap": peak_bootstrap,
        "nullRepeats": repeats,
        "equalRowsPerSource": per_group,
        "sourceVideos": len(set(selected_groups)),
        "nullPolicy": "source-video sign flips; maximum absolute rho across every tested window and lag",
    }


def baseline_audit(observed: np.ndarray, predicted: np.ndarray,
                   groups: np.ndarray, per_group: int = 32,
                   seed: int = AXIS_SEED) -> dict:
    selected = balanced_group_positions(groups, per_group=per_group, seed=seed)
    observed = np.asarray(observed, float)[selected]
    predicted = np.asarray(predicted, float)[selected]
    valid = np.isfinite(observed) & np.isfinite(predicted)
    if valid.sum() < 4:
        return {"n": int(valid.sum()), "status": "insufficient"}
    return {
        "status": "complete",
        "n": int(valid.sum()),
        "sourceVideos": len(set(np.asarray(groups)[selected][valid])),
        "spearman": spearman(predicted[valid], observed[valid]),
        "pearson": finite_correlation(predicted[valid], observed[valid]),
        "r2": float(r2_score(observed[valid], predicted[valid])),
        "mae": float(mean_absolute_error(observed[valid], predicted[valid])),
        "observedMean": float(np.mean(observed[valid])),
        "predictedMean": float(np.mean(predicted[valid])),
        "residualMean": float(np.mean(observed[valid] - predicted[valid])),
        "observedStd": float(np.std(observed[valid])),
        "residualStd": float(np.std(observed[valid] - predicted[valid])),
    }


def transfer_correlation_matrix(scores_by_train_lag: np.ndarray,
                                targets_by_response_lag: np.ndarray,
                                groups: np.ndarray, per_group: int = 32,
                                seed: int = AXIS_SEED) -> np.ndarray:
    selected = balanced_group_positions(groups, per_group=per_group, seed=seed)
    scores = np.asarray(scores_by_train_lag, float)[:, selected]
    targets = np.asarray(targets_by_response_lag, float)[selected]
    output = np.full((scores.shape[0], targets.shape[1]), np.nan, np.float32)
    for train_lag in range(scores.shape[0]):
        for response_lag in range(targets.shape[1]):
            output[train_lag, response_lag] = spearman(
                scores[train_lag], targets[:, response_lag]
            )
    return output


def source_equal_curve_baseline(curves: list[np.ndarray], normalized_curves: list[np.ndarray],
                                durations: np.ndarray, seconds: np.ndarray,
                                width: float = 1.0) -> list[dict]:
    from cluster_outcomes import retention_window_slope

    rows = []
    durations = np.asarray(durations, float)
    for second in np.asarray(seconds, float):
        raw = []
        normalized = []
        for curve, normalized_curve, duration in zip(curves, normalized_curves, durations):
            raw_value = retention_window_slope(curve, duration, second, second + width)
            normalized_value = retention_window_slope(
                normalized_curve, duration, second, second + width
            )
            if np.isfinite(raw_value):
                raw.append(raw_value)
            if np.isfinite(normalized_value):
                normalized.append(normalized_value)
        raw_values = np.asarray(raw, float)
        normalized_values = np.asarray(normalized, float)
        rows.append({
            "second": float(second), "windowSeconds": float(width),
            "videos": int(len(raw_values)),
            "rawMean": float(np.mean(raw_values)) if len(raw_values) else None,
            "rawMedian": float(np.median(raw_values)) if len(raw_values) else None,
            "rawQ25": float(np.quantile(raw_values, .25)) if len(raw_values) else None,
            "rawQ75": float(np.quantile(raw_values, .75)) if len(raw_values) else None,
            "normalizedMean": float(np.mean(normalized_values)) if len(normalized_values) else None,
            "normalizedMedian": float(np.median(normalized_values)) if len(normalized_values) else None,
            "normalizedQ25": float(np.quantile(normalized_values, .25)) if len(normalized_values) else None,
            "normalizedQ75": float(np.quantile(normalized_values, .75)) if len(normalized_values) else None,
        })
    return rows
