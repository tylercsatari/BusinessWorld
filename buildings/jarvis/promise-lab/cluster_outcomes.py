"""Cluster-conditioned outcome axes and exact retention timing primitives."""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.stats import rankdata
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score
from sklearn.model_selection import GroupKFold, KFold

from axes import bh_fdr, finite_correlation, spearman
from sequence import tokenize


EPS = 1e-9
AXIS_SEED = 20260712


def normalized_caption_atom(value: Any) -> str:
    return re.sub(
        r"[^a-z0-9]+", "", str(value or "").casefold().replace("’", "'")
    )


def exact_token_timings(hook_text: str, words: list[dict]) -> dict[str, Any]:
    """Map source tokens to caption time only when normalized text is an exact prefix."""
    tokens = tokenize(hook_text)
    token_atoms = [normalized_caption_atom(token.text) for token in tokens]
    source_stream = "".join(token_atoms)
    word_atoms = [normalized_caption_atom(word.get("w")) for word in words]
    caption_stream = "".join(word_atoms)
    if not source_stream or not caption_stream.startswith(source_stream):
        return {
            "status": "text-mismatch",
            "tokenStarts": [],
            "tokenEnds": [],
            "sourceCharacters": len(source_stream),
            "captionCharacters": len(caption_stream),
        }

    char_starts = []
    char_ends = []
    for word, atom in zip(words, word_atoms):
        if not atom:
            continue
        start = float(word.get("t") or 0)
        duration = max(0.0, float(word.get("d") or 0))
        for position in range(len(atom)):
            char_starts.append(start + duration * position / len(atom))
            char_ends.append(start + duration * (position + 1) / len(atom))

    token_starts = np.full(len(tokens), np.nan, np.float32)
    token_ends = np.full(len(tokens), np.nan, np.float32)
    cursor = 0
    for index, atom in enumerate(token_atoms):
        if not atom:
            continue
        token_starts[index] = char_starts[cursor]
        token_ends[index] = char_ends[cursor + len(atom) - 1]
        cursor += len(atom)

    for index, atom in enumerate(token_atoms):
        if atom:
            continue
        previous = next(
            (float(token_ends[position]) for position in range(index - 1, -1, -1)
             if np.isfinite(token_ends[position])),
            None,
        )
        following = next(
            (float(token_starts[position]) for position in range(index + 1, len(tokens))
             if np.isfinite(token_starts[position])),
            None,
        )
        boundary = previous if previous is not None else following
        if boundary is not None:
            token_starts[index] = boundary
            token_ends[index] = boundary

    return {
        "status": "exact",
        "tokenStarts": token_starts.astype(float).tolist(),
        "tokenEnds": token_ends.astype(float).tolist(),
        "sourceCharacters": len(source_stream),
        "captionCharacters": len(caption_stream),
    }


def span_interval(timing: dict, start: int, end: int) -> tuple[float, float]:
    starts = np.asarray(timing.get("tokenStarts") or [], float)
    ends = np.asarray(timing.get("tokenEnds") or [], float)
    if start < 0 or end <= start or end > len(starts):
        return float("nan"), float("nan")
    selected_starts = starts[start:end]
    selected_ends = ends[start:end]
    valid_start = selected_starts[np.isfinite(selected_starts)]
    valid_end = selected_ends[np.isfinite(selected_ends)]
    if not len(valid_start) or not len(valid_end):
        return float("nan"), float("nan")
    interval_start = float(valid_start.min())
    interval_end = float(valid_end.max())
    if interval_end - interval_start < 1e-4:
        return float("nan"), float("nan")
    return interval_start, interval_end


def retention_at(curve, duration: float, seconds: float) -> float:
    values = np.asarray(curve if curve is not None else [], float)
    if len(values) < 2 or not duration or duration <= 0 or seconds < 0 or seconds > duration:
        return float("nan")
    position = np.clip(seconds / duration * (len(values) - 1), 0, len(values) - 1)
    lower = int(math.floor(position))
    upper = min(len(values) - 1, lower + 1)
    return float(values[lower] + (values[upper] - values[lower]) * (position - lower))


def retention_window_slope(curve, duration: float, start: float, end: float,
                           samples: int = 21) -> float:
    if not duration or start < 0 or end <= start or end > duration:
        return float("nan")
    seconds = np.linspace(start, end, samples)
    values = np.asarray([retention_at(curve, duration, second) for second in seconds])
    valid = np.isfinite(values)
    if valid.sum() < 3 or np.std(seconds[valid]) < EPS:
        return float("nan")
    return float(np.polyfit(seconds[valid], values[valid], 1)[0])


def endpoint_normalize_curve(curve, terminal_fraction: float = .05) -> tuple[np.ndarray, dict]:
    values = np.asarray(curve if curve is not None else [], float)
    if len(values) < 4 or not np.isfinite(values).all():
        return np.asarray([], float), {"status": "invalid"}
    terminal_count = max(3, int(math.ceil(len(values) * terminal_fraction)))
    entry = float(values[0])
    terminal = float(np.mean(values[-terminal_count:]))
    amplitude = entry - terminal
    if not np.isfinite(amplitude) or amplitude <= .02:
        return np.asarray([], float), {
            "status": "unstable-amplitude", "entry": entry,
            "terminal": terminal, "amplitude": amplitude,
        }
    return (values - terminal) / amplitude, {
        "status": "complete",
        "entry": entry,
        "terminal": terminal,
        "amplitude": amplitude,
        "terminalPoints": terminal_count,
    }


def balanced_group_positions(groups: np.ndarray, per_group: int = 32,
                             seed: int = AXIS_SEED) -> np.ndarray:
    groups = np.asarray(groups).astype(str)
    rng = np.random.default_rng(seed)
    selected = []
    for group in sorted(set(groups)):
        positions = np.flatnonzero(groups == group)
        if not len(positions):
            continue
        selected.append(rng.choice(
            positions, per_group, replace=len(positions) < per_group
        ))
    return np.concatenate(selected).astype(int) if selected else np.asarray([], int)


def _impute_scale(fit: np.ndarray, *others: np.ndarray) -> tuple[np.ndarray, ...]:
    fit = np.asarray(fit, np.float32)
    median = np.nanmedian(np.where(np.isfinite(fit), fit, np.nan), axis=0)
    median = np.where(np.isfinite(median), median, 0).astype(np.float32)

    def fill(values):
        values = np.asarray(values, np.float32).copy()
        invalid = ~np.isfinite(values)
        if invalid.any():
            values[invalid] = np.broadcast_to(median, values.shape)[invalid]
        return values

    filled = [fill(fit), *(fill(values) for values in others)]
    mean = filled[0].mean(axis=0)
    scale = filled[0].std(axis=0)
    scale = np.where(scale > EPS, scale, 1)
    return tuple((values - mean) / scale for values in filled)


def grouped_baseline_residual(features: np.ndarray, target: np.ndarray,
                              groups: np.ndarray, alpha: float = 0.1,
                              folds: int = 5, per_group: int = 48,
                              seed: int = AXIS_SEED) -> tuple[np.ndarray, np.ndarray, dict]:
    features = np.asarray(features, np.float32)
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    valid = np.isfinite(target) & np.all(np.isfinite(features), axis=1)
    indices = np.flatnonzero(valid)
    unique_groups = sorted(set(groups[indices]))
    if len(unique_groups) < 2:
        return np.full(len(target), np.nan), np.full(len(target), np.nan), {
            "n": int(len(indices)), "groups": len(unique_groups), "status": "insufficient"
        }
    folds = min(folds, len(unique_groups))
    prediction = np.full(len(target), np.nan, float)
    splitter = GroupKFold(n_splits=folds)
    for fold_index, (train_local, test_local) in enumerate(
        splitter.split(indices, target[indices], groups[indices])
    ):
        train = indices[train_local]
        test = indices[test_local]
        balanced = balanced_group_positions(
            groups[train], per_group=per_group, seed=seed + fold_index
        )
        fit_indices = train[balanced]
        fit_x, test_x = _impute_scale(features[fit_indices], features[test])
        model = Ridge(alpha=alpha).fit(fit_x, target[fit_indices])
        prediction[test] = model.predict(test_x)
    residual = target - prediction
    scored = np.isfinite(prediction) & np.isfinite(target)
    return prediction, residual, {
        "status": "complete",
        "n": int(scored.sum()),
        "groups": len(unique_groups),
        "folds": folds,
        "ridgeAlpha": alpha,
        "equalGroupRowsPerFit": per_group,
        "oofPearson": finite_correlation(prediction[scored], target[scored]),
        "oofSpearman": spearman(prediction[scored], target[scored]),
        "oofR2": float(r2_score(target[scored], prediction[scored])),
        "targetMean": float(np.nanmean(target)),
        "residualMean": float(np.nanmean(residual)),
        "targetStd": float(np.nanstd(target)),
        "residualStd": float(np.nanstd(residual)),
    }


def entry_terminal_diagnostic(entries: np.ndarray, terminals: np.ndarray,
                              durations: np.ndarray, seed: int = AXIS_SEED) -> dict:
    entries = np.asarray(entries, float)
    terminals = np.asarray(terminals, float)
    durations = np.asarray(durations, float)
    features = np.column_stack([
        terminals, terminals ** 2, durations, np.log1p(np.maximum(durations, 0)),
        terminals * np.log1p(np.maximum(durations, 0)),
    ])
    valid = np.isfinite(entries) & np.all(np.isfinite(features), axis=1)
    indices = np.flatnonzero(valid)
    predictions = np.full(len(entries), np.nan, float)
    if len(indices) < 2:
        return {
            "definition": (
                "out-of-fold expected entry retention from terminal retention, "
                "terminal squared, duration, log duration, and their interaction"
            ),
            "status": "insufficient",
            "n": 0,
            "oofPearson": 0.0,
            "oofSpearman": 0.0,
            "oofR2": None,
            "entry": np.round(entries, 6).tolist(),
            "terminal": np.round(terminals, 6).tolist(),
            "predictedEntryOOF": np.round(predictions, 6).tolist(),
        }
    splitter = KFold(n_splits=min(5, len(indices)), shuffle=True, random_state=seed)
    for train_local, test_local in splitter.split(indices):
        train = indices[train_local]
        test = indices[test_local]
        train_x, test_x = _impute_scale(features[train], features[test])
        predictions[test] = Ridge(alpha=1.0).fit(train_x, entries[train]).predict(test_x)
    scored = np.isfinite(predictions) & valid
    return {
        "definition": (
            "out-of-fold expected entry retention from terminal retention, "
            "terminal squared, duration, log duration, and their interaction"
        ),
        "status": "complete",
        "n": int(scored.sum()),
        "oofPearson": finite_correlation(predictions[scored], entries[scored]),
        "oofSpearman": spearman(predictions[scored], entries[scored]),
        "oofR2": float(r2_score(entries[scored], predictions[scored])),
        "entry": np.round(entries, 6).tolist(),
        "terminal": np.round(terminals, 6).tolist(),
        "predictedEntryOOF": np.round(predictions, 6).tolist(),
    }


@dataclass
class PreparedFold:
    train: np.ndarray
    test: np.ndarray
    scores: dict[str, tuple[np.ndarray, np.ndarray]]


def grouped_splits(groups: np.ndarray, folds: int = 5) -> list[tuple[np.ndarray, np.ndarray]]:
    groups = np.asarray(groups).astype(str)
    unique_groups = len(set(groups))
    if unique_groups < 2:
        return []
    folds = min(folds, unique_groups)
    indices = np.arange(len(groups))
    return [(indices[train], indices[test]) for train, test in
            GroupKFold(n_splits=folds).split(indices, groups=groups)]


def prepare_representation_folds(features: np.ndarray, groups: np.ndarray,
                                 confound_sets: dict[str, np.ndarray],
                                 splits: list[tuple[np.ndarray, np.ndarray]],
                                 max_dimensions: int = 64,
                                 per_group: int = 32,
                                 seed: int = AXIS_SEED) -> list[PreparedFold]:
    features = np.asarray(features, np.float32)
    groups = np.asarray(groups).astype(str)
    output = []
    for fold_index, (train, test) in enumerate(splits):
        balanced = balanced_group_positions(
            groups[train], per_group=per_group, seed=seed + fold_index
        )
        fit_indices = train[balanced]
        dimensions = min(max_dimensions, len(fit_indices) - 1, features.shape[1])
        reducer = PCA(
            n_components=max(1, dimensions), svd_solver="randomized",
            random_state=seed + fold_index,
        ).fit(features[fit_indices])
        fit_scores = reducer.transform(features[fit_indices])
        train_scores = reducer.transform(features[train])
        test_scores = reducer.transform(features[test])
        fit_scores, train_scores, test_scores = _impute_scale(
            fit_scores, train_scores, test_scores
        )
        by_confound = {}
        for name, confounds in confound_sets.items():
            confounds = np.asarray(confounds, np.float32)
            if not confounds.shape[1]:
                by_confound[name] = (
                    train_scores.astype(np.float32), test_scores.astype(np.float32)
                )
                continue
            fit_c, train_c, test_c = _impute_scale(
                confounds[fit_indices], confounds[train], confounds[test]
            )
            model = Ridge(alpha=10.0).fit(fit_c, fit_scores)
            by_confound[name] = (
                (train_scores - model.predict(train_c)).astype(np.float32),
                (test_scores - model.predict(test_c)).astype(np.float32),
            )
        output.append(PreparedFold(train=train, test=test, scores=by_confound))
    return output


def prepare_target_folds(target: np.ndarray, groups: np.ndarray, confounds: np.ndarray,
                         splits: list[tuple[np.ndarray, np.ndarray]],
                         per_group: int = 32,
                         seed: int = AXIS_SEED) -> tuple[list[tuple[np.ndarray, np.ndarray]], np.ndarray]:
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    confounds = np.asarray(confounds, np.float32)
    output = []
    oof = np.full(len(target), np.nan, float)
    for fold_index, (train, test) in enumerate(splits):
        train_y = target[train].copy()
        test_y = target[test].copy()
        train_valid = np.isfinite(train_y)
        valid_positions = np.flatnonzero(train_valid)
        if len(valid_positions) < 4:
            output.append((np.full(len(train), np.nan), np.full(len(test), np.nan)))
            continue
        balanced_local = balanced_group_positions(
            groups[train][valid_positions], per_group=per_group,
            seed=seed + fold_index,
        )
        fit_positions = valid_positions[balanced_local]
        if confounds.shape[1]:
            fit_c, train_c, test_c = _impute_scale(
                confounds[train][fit_positions], confounds[train], confounds[test]
            )
            model = Ridge(alpha=10.0).fit(fit_c, train_y[fit_positions])
            train_y = train_y - model.predict(train_c)
            test_y = test_y - model.predict(test_c)
        output.append((train_y, test_y))
        oof[test] = test_y
    return output, oof


def _signflip_pvalues(predictions: np.ndarray, residual: np.ndarray,
                      groups: np.ndarray, repeats: int = 1024,
                      seed: int = AXIS_SEED) -> tuple[np.ndarray, np.ndarray, float]:
    predictions = np.asarray(predictions, float)
    residual = np.asarray(residual, float)
    groups = np.asarray(groups).astype(str)
    valid = np.isfinite(residual) & np.all(np.isfinite(predictions), axis=0)
    predictions = predictions[:, valid]
    residual = residual[valid]
    groups = groups[valid]
    if predictions.shape[1] < 4 or not len(set(groups)):
        return (
            np.ones(predictions.shape[0], float),
            np.zeros(predictions.shape[0], float),
            0.0,
        )
    prediction_rank = np.apply_along_axis(rankdata, 1, predictions)
    prediction_rank -= prediction_rank.mean(axis=1, keepdims=True)
    prediction_rank /= prediction_rank.std(axis=1, keepdims=True) + EPS
    residual_rank = rankdata(residual)
    residual_rank -= residual_rank.mean()
    residual_rank /= residual_rank.std() + EPS
    observed = np.abs(prediction_rank @ residual_rank / len(residual_rank))
    unique_groups = np.asarray(sorted(set(groups)))
    lookup = {group: position for position, group in enumerate(unique_groups)}
    group_positions = np.asarray([lookup[group] for group in groups], int)
    group_contributions = np.zeros((len(prediction_rank), len(unique_groups)), float)
    residual_group_sums = np.zeros(len(unique_groups), float)
    for group_index in range(len(unique_groups)):
        members = group_positions == group_index
        group_contributions[:, group_index] = (
            prediction_rank[:, members] @ residual_rank[members]
        )
        residual_group_sums[group_index] = residual_rank[members].sum()
    rng = np.random.default_rng(seed)
    null_max = np.empty(repeats, float)
    batch = 64
    for start in range(0, repeats, batch):
        count = min(batch, repeats - start)
        signs = rng.choice((-1.0, 1.0), size=(count, len(unique_groups)))
        signed_means = signs @ residual_group_sums / len(residual_rank)
        signed_scales = np.sqrt(np.maximum(EPS, 1.0 - signed_means ** 2))
        null_correlations = (
            group_contributions @ signs.T / len(residual_rank)
        ) / signed_scales[None, :]
        null_max[start:start + count] = np.max(np.abs(null_correlations), axis=0)
    pvalues = (1 + np.sum(null_max[None, :] >= observed[:, None], axis=1)) / (repeats + 1)
    return pvalues, observed, float(np.median(null_max))


def search_target_axes(prepared: dict[str, list[PreparedFold]], target: np.ndarray,
                       target_folds: list[tuple[np.ndarray, np.ndarray]],
                       target_oof: np.ndarray, groups: np.ndarray,
                       confound_name: str, dimensions: list[int], alphas: list[float],
                       target_name: str, cluster_label: int,
                       null_repeats: int = 1024,
                       seed: int = AXIS_SEED) -> tuple[list[dict], dict]:
    groups = np.asarray(groups).astype(str)
    configs = [
        (representation, int(dimension), float(alpha))
        for representation in sorted(prepared)
        for dimension in dimensions for alpha in alphas
    ]
    config_lookup = {config: index for index, config in enumerate(configs)}
    predictions = [np.full(len(target), np.nan, np.float32) for _ in configs]
    for representation in sorted(prepared):
        for fold_index, (fold, (train_y, test_y)) in enumerate(
            zip(prepared[representation], target_folds)
        ):
            train_scores, test_scores = fold.scores[confound_name]
            valid_train = np.isfinite(train_y)
            valid_test = np.isfinite(test_y)
            positions = np.flatnonzero(valid_train)
            if len(positions) < 4 or valid_test.sum() == 0:
                continue
            balanced = balanced_group_positions(
                groups[fold.train][positions], per_group=32,
                seed=seed + fold_index,
            )
            fit_positions = positions[balanced]
            test_positions = np.flatnonzero(valid_test)
            for dimension in dimensions:
                dimension_used = min(int(dimension), train_scores.shape[1])
                fit_x = np.asarray(
                    train_scores[fit_positions, :dimension_used], np.float64
                )
                fit_y = np.asarray(train_y[fit_positions], np.float64)
                mean_x = fit_x.mean(axis=0)
                mean_y = float(fit_y.mean())
                centered_x = fit_x - mean_x
                centered_y = fit_y - mean_y
                gram = centered_x.T @ centered_x
                cross = centered_x.T @ centered_y
                test_x = np.asarray(
                    test_scores[test_positions, :dimension_used], np.float64
                ) - mean_x
                identity = np.eye(dimension_used, dtype=np.float64)
                for alpha in alphas:
                    coefficient = np.linalg.solve(
                        gram + float(alpha) * identity, cross
                    )
                    config_index = config_lookup[
                        (representation, int(dimension), float(alpha))
                    ]
                    predictions[config_index][fold.test[test_positions]] = (
                        test_x @ coefficient + mean_y
                    ).astype(np.float32)

    prediction_matrix = np.asarray(predictions, np.float32)
    evaluation_positions = balanced_group_positions(
        groups, per_group=32,
        seed=seed + cluster_label * 313 + int(
            hashlib.sha1(target_name.encode()).hexdigest()[:6], 16
        ),
    )
    evaluation_predictions = prediction_matrix[:, evaluation_positions]
    evaluation_target = target_oof[evaluation_positions]
    evaluation_groups = groups[evaluation_positions]
    pvalues, _, null_median = _signflip_pvalues(
        evaluation_predictions, evaluation_target, evaluation_groups,
        repeats=null_repeats,
        seed=seed + cluster_label * 1009 + int(hashlib.sha1(target_name.encode()).hexdigest()[:6], 16),
    )
    experiments = []
    for config_index, (representation, dimension, alpha) in enumerate(configs):
        prediction = evaluation_predictions[config_index]
        valid = np.isfinite(prediction) & np.isfinite(evaluation_target)
        row = {
            "id": hashlib.sha1(
                f"cluster-axis:{cluster_label}:{target_name}:{representation}:{confound_name}:"
                f"{dimension}:{alpha}".encode()
            ).hexdigest()[:20],
            "stage": "cluster-conditioned-axis",
            "cluster": int(cluster_label),
            "target": target_name,
            "representation": representation,
            "confounds": confound_name,
            "pcaDimensions": dimension,
            "ridgeAlpha": alpha,
            "n": int(valid.sum()),
            "sourceVideos": len(set(evaluation_groups[valid])),
            "heldoutSpearman": spearman(prediction[valid], evaluation_target[valid]),
            "heldoutPearson": finite_correlation(prediction[valid], evaluation_target[valid]),
            "heldoutR2": (
                float(r2_score(evaluation_target[valid], prediction[valid]))
                if valid.sum() >= 4 else None
            ),
            "searchWideP": float(pvalues[config_index]),
            "nullMaxMedian": null_median,
            "nullRepeats": null_repeats,
            "groupedBy": "source video",
            "equalHookWeighting": True,
            "heldoutRowsPerSourceVideo": 32,
        }
        experiments.append(row)
    selected_index = max(range(len(experiments)), key=lambda index: experiments[index]["heldoutSpearman"])
    for index, row in enumerate(experiments):
        row["selectedForClusterTarget"] = index == selected_index
    selected = experiments[selected_index]
    return experiments, {
        "experiment": selected,
        "predictionOOF": prediction_matrix[selected_index],
        "observedResidualOOF": np.asarray(target_oof, np.float32),
    }


def prepare_full_scores(features: np.ndarray, groups: np.ndarray,
                        confound_sets: dict[str, np.ndarray],
                        max_dimensions: int = 64, per_group: int = 32,
                        seed: int = AXIS_SEED) -> dict[str, np.ndarray]:
    features = np.asarray(features, np.float32)
    groups = np.asarray(groups).astype(str)
    balanced = balanced_group_positions(groups, per_group=per_group, seed=seed)
    dimensions = min(max_dimensions, len(balanced) - 1, features.shape[1])
    reducer = PCA(
        n_components=max(1, dimensions), svd_solver="randomized", random_state=seed
    ).fit(features[balanced])
    fit_scores = reducer.transform(features[balanced])
    scores = reducer.transform(features)
    fit_scores, scores = _impute_scale(fit_scores, scores)
    output = {}
    for name, confounds in confound_sets.items():
        confounds = np.asarray(confounds, np.float32)
        if not confounds.shape[1]:
            output[name] = scores.astype(np.float32)
            continue
        fit_c, all_c = _impute_scale(confounds[balanced], confounds)
        model = Ridge(alpha=10.0).fit(fit_c, fit_scores)
        output[name] = (scores - model.predict(all_c)).astype(np.float32)
    return output


def fit_full_target_map(scores: np.ndarray, target: np.ndarray, groups: np.ndarray,
                        confounds: np.ndarray, dimension: int, alpha: float,
                        per_group: int = 32, seed: int = AXIS_SEED) -> dict:
    scores = np.asarray(scores, np.float32)
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    confounds = np.asarray(confounds, np.float32)
    valid = np.isfinite(target)
    positions = np.flatnonzero(valid)
    balanced = balanced_group_positions(
        groups[positions], per_group=per_group, seed=seed
    )
    fit_positions = positions[balanced]
    residual = target.copy()
    if confounds.shape[1]:
        fit_c, all_c = _impute_scale(confounds[fit_positions], confounds)
        confound_model = Ridge(alpha=10.0).fit(fit_c, target[fit_positions])
        residual = target - confound_model.predict(all_c)
    dimension = min(int(dimension), scores.shape[1])
    model = Ridge(alpha=float(alpha)).fit(
        scores[fit_positions, :dimension], residual[fit_positions]
    )
    axis = model.predict(scores[:, :dimension])
    if finite_correlation(axis[valid], residual[valid]) < 0:
        axis = -axis
    axis = (axis - np.nanmean(axis)) / (np.nanstd(axis) + EPS)
    background = scores[:, 0].astype(float)
    background -= axis * float(np.dot(axis, background) / (np.dot(axis, axis) + EPS))
    background = (background - np.nanmean(background)) / (np.nanstd(background) + EPS)
    return {
        "x": axis.astype(np.float32),
        "y": background.astype(np.float32),
        "observedResidual": residual.astype(np.float32),
    }


def apply_family_fdr(selected_rows: list[dict]) -> None:
    qvalues = bh_fdr([float(row["searchWideP"]) for row in selected_rows])
    for row, qvalue in zip(selected_rows, qvalues):
        row["searchWideQ"] = float(qvalue)
        row["multipleTestingFamily"] = (
            "max-null over representation, PCA dimension, and ridge alpha within each "
            "cluster-target; Benjamini-Hochberg across all cluster-target families"
        )
        row["randomFoldSupported"] = bool(
            qvalue <= .05 and row["heldoutSpearman"] > 0
        )
        row["status"] = "random-fold-only-conditional-diagnostic"
        row["claimBoundary"] = (
            "source-grouped random-fold association conditional on the post-hoc selected k=4 map; "
            "no chronological replication was run"
        )
