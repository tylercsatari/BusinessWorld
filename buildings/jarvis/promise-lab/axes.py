"""Grouped held-out latent-axis search with foldwise confound residualization."""

from __future__ import annotations

import hashlib

import numpy as np
from scipy.stats import rankdata
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler


EPS = 1e-9


def impute_from_train(train: np.ndarray, *others: np.ndarray) -> tuple[np.ndarray, ...]:
    """Fill non-finite values using training-fold medians only."""
    train = np.asarray(train, np.float32)
    medians = np.nanmedian(np.where(np.isfinite(train), train, np.nan), axis=0)
    medians = np.where(np.isfinite(medians), medians, 0).astype(np.float32)

    def fill(values: np.ndarray) -> np.ndarray:
        values = np.asarray(values, np.float32).copy()
        invalid = ~np.isfinite(values)
        if invalid.any():
            values[invalid] = np.broadcast_to(medians, values.shape)[invalid]
        return values

    return (fill(train), *(fill(values) for values in others))


def finite_correlation(left, right) -> float:
    left = np.asarray(left, float)
    right = np.asarray(right, float)
    valid = np.isfinite(left) & np.isfinite(right)
    if valid.sum() < 4 or np.std(left[valid]) < EPS or np.std(right[valid]) < EPS:
        return 0.0
    return float(np.corrcoef(left[valid], right[valid])[0, 1])


def spearman(left, right) -> float:
    left = np.asarray(left, float)
    right = np.asarray(right, float)
    valid = np.isfinite(left) & np.isfinite(right)
    if valid.sum() < 4:
        return 0.0
    return finite_correlation(rankdata(left[valid]), rankdata(right[valid]))


def bh_fdr(values: list[float]) -> list[float]:
    if not values:
        return []
    p = np.asarray(values, float)
    order = np.argsort(p)
    ranked = p[order]
    q = ranked * len(p) / (np.arange(len(p)) + 1)
    q = np.minimum.accumulate(q[::-1])[::-1]
    out = np.empty_like(q)
    out[order] = np.clip(q, 0, 1)
    return out.tolist()


def foldwise_predictions(features: np.ndarray, target: np.ndarray, groups: np.ndarray,
                         confounds: np.ndarray | None, dimensions: list[int],
                         alphas: list[float], folds: int = 5) -> tuple[dict, np.ndarray]:
    features = np.asarray(features, np.float32)
    target = np.asarray(target, float)
    groups = np.asarray(groups).astype(str)
    valid = np.isfinite(target)
    indices = np.flatnonzero(valid)
    if len(set(groups[indices])) < folds:
        folds = max(2, len(set(groups[indices])))
    predictions = {
        (int(dimension), float(alpha)): np.full(len(target), np.nan, float)
        for dimension in dimensions for alpha in alphas
    }
    residual_target = np.full(len(target), np.nan, float)
    splitter = GroupKFold(n_splits=folds)
    for train_local, test_local in splitter.split(indices, target[indices], groups[indices]):
        train = indices[train_local]
        test = indices[test_local]
        train_features = features[train].copy()
        test_features = features[test].copy()
        train_y = target[train].copy()
        test_y = target[test].copy()
        if confounds is not None and confounds.shape[1]:
            train_c, test_c = impute_from_train(confounds[train], confounds[test])
            confound_scaler = StandardScaler().fit(train_c)
            train_c = confound_scaler.transform(train_c)
            test_c = confound_scaler.transform(test_c)
            feature_confound_model = Ridge(alpha=1.0).fit(train_c, train_features)
            train_features = train_features - feature_confound_model.predict(train_c)
            test_features = test_features - feature_confound_model.predict(test_c)
            confound_model = Ridge(alpha=1.0).fit(train_c, train_y)
            train_y = train_y - confound_model.predict(train_c)
            test_y = test_y - confound_model.predict(test_c)
        max_dim = min(max(dimensions), len(train) - 1, features.shape[1])
        reducer = PCA(n_components=max(1, max_dim), svd_solver="randomized", random_state=1729)
        train_x = reducer.fit_transform(train_features)
        test_x = reducer.transform(test_features)
        scaler = StandardScaler().fit(train_x)
        train_x = scaler.transform(train_x)
        test_x = scaler.transform(test_x)
        residual_target[test] = test_y
        for requested_dimension in dimensions:
            dimension = max(1, min(int(requested_dimension), train_x.shape[1]))
            for alpha in alphas:
                model = Ridge(alpha=float(alpha)).fit(train_x[:, :dimension], train_y)
                predictions[(int(requested_dimension), float(alpha))][test] = model.predict(
                    test_x[:, :dimension]
                )
    return predictions, residual_target


def foldwise_prediction(features: np.ndarray, target: np.ndarray, groups: np.ndarray,
                        confounds: np.ndarray | None, dimensions: int, alpha: float,
                        folds: int = 5) -> tuple[np.ndarray, np.ndarray]:
    predictions, residual = foldwise_predictions(
        features, target, groups, confounds, [dimensions], [alpha], folds
    )
    return predictions[(int(dimensions), float(alpha))], residual


def search_axes(representations: dict[str, np.ndarray], targets: dict[str, dict], groups: np.ndarray,
                confound_sets: dict[str, np.ndarray], dimensions: list[int], alphas: list[float],
                null_repeats: int = 64, progress=None) -> tuple[list[dict], dict[str, np.ndarray]]:
    groups = np.asarray(groups).astype(str)
    experiments = []
    selected_by_target = {}
    prediction_lookup = {}
    valid_targets = [
        (name, meta) for name, meta in targets.items()
        if np.isfinite(np.asarray(meta["values"], float)).sum() >= 20
    ]
    group_total = len(representations) * len(confound_sets) * len(valid_targets)
    group_complete = 0
    if progress:
        progress({"axisGroupsComplete": 0, "axisGroupsTotal": group_total,
                  "experimentsComplete": 0})

    rng = np.random.RandomState(99173)
    for target_name, target_meta in valid_targets:
        target = np.asarray(target_meta["values"], float)
        target_experiment_indices = []
        target_predictions = []
        target_prediction_confounds = []
        residual_by_confound = {}
        for representation, features in representations.items():
            for confound_name, confounds in confound_sets.items():
                prediction_grid, residual = foldwise_predictions(
                    features, target, groups, confounds, dimensions, alphas
                )
                residual_by_confound.setdefault(confound_name, residual.astype(np.float32))
                for dimension in dimensions:
                    for alpha in alphas:
                        prediction = prediction_grid[(int(dimension), float(alpha))]
                        valid = np.isfinite(prediction) & np.isfinite(residual)
                        rho = spearman(prediction[valid], residual[valid])
                        pearson = finite_correlation(prediction[valid], residual[valid])
                        r2 = float(r2_score(residual[valid], prediction[valid])) if valid.sum() >= 4 else float("nan")
                        row = {
                            "id": hashlib.sha1(
                                f"axis:{representation}:{dimension}:{confound_name}:{target_name}:{alpha}".encode()
                            ).hexdigest()[:20],
                            "stage": "latent-axis",
                            "representation": representation,
                            "pcaDimensions": dimension,
                            "ridgeAlpha": alpha,
                            "confounds": confound_name,
                            "target": target_name,
                            "targetChannel": target_meta["channel"],
                            "targetDefinition": target_meta["definition"],
                            "n": int(valid.sum()),
                            "groupedBy": "source video",
                            "heldoutSpearman": rho,
                            "heldoutPearson": pearson,
                            "heldoutR2": r2,
                            "nullRepeats": int(null_repeats),
                            "minimumAttainableP": 1 / (int(null_repeats) + 1),
                        }
                        target_experiment_indices.append(len(experiments))
                        target_predictions.append(prediction.astype(np.float32))
                        target_prediction_confounds.append(confound_name)
                        experiments.append(row)
                group_complete += 1
                if progress:
                    progress({
                        "axisGroupsComplete": group_complete,
                        "axisGroupsTotal": group_total,
                        "experimentsComplete": len(experiments),
                        "representation": representation,
                        "confounds": confound_name,
                        "target": target_name,
                    })

        prediction_matrix = np.asarray(target_predictions, np.float32)
        valid = np.all(np.isfinite(prediction_matrix), axis=0)
        for residual in residual_by_confound.values():
            valid &= np.isfinite(residual)
        prediction_matrix = prediction_matrix[:, valid]
        group_valid = groups[valid]
        prediction_rank = np.apply_along_axis(rankdata, 1, prediction_matrix)
        prediction_rank -= prediction_rank.mean(axis=1, keepdims=True)
        prediction_rank /= prediction_rank.std(axis=1, keepdims=True) + EPS
        residual_rank = {}
        for confound_name, residual in residual_by_confound.items():
            ranked = rankdata(residual[valid])
            ranked -= ranked.mean()
            ranked /= ranked.std() + EPS
            residual_rank[confound_name] = ranked
        confound_positions = {
            confound_name: np.flatnonzero(
                np.asarray(target_prediction_confounds) == confound_name
            )
            for confound_name in residual_by_confound
        }
        unique_groups = np.asarray(sorted(set(group_valid)))
        group_position = {group: index for index, group in enumerate(unique_groups)}
        row_group_position = np.asarray([group_position[group] for group in group_valid], int)
        group_signs = rng.choice(
            (-1.0, 1.0), size=(null_repeats, len(unique_groups))
        )
        signs = group_signs[:, row_group_position]
        null_rho = np.empty((len(target_predictions), null_repeats), float)
        for confound_name, positions in confound_positions.items():
            null_residual = residual_rank[confound_name][None, :] * signs
            null_residual -= null_residual.mean(axis=1, keepdims=True)
            null_residual /= null_residual.std(axis=1, keepdims=True) + EPS
            null_rho[positions] = (
                prediction_rank[positions] @ null_residual.T / null_residual.shape[1]
            )
        null_maxima = np.max(np.abs(null_rho), axis=0)
        for experiment_index in target_experiment_indices:
            observed = abs(float(experiments[experiment_index]["heldoutSpearman"]))
            experiments[experiment_index]["searchWideP"] = float(
                (1 + np.sum(null_maxima >= observed)) / (len(null_maxima) + 1)
            )
            experiments[experiment_index]["nullMaxMedian"] = float(np.median(null_maxima))
            experiments[experiment_index]["searchWideNull"] = (
                "source-video cluster sign-flip on each configuration's foldwise residual target"
            )

        best_predictive = max(
            target_experiment_indices, key=lambda index: experiments[index]["heldoutSpearman"]
        )
        required_confounds = target_meta.get("requiredConfounds")
        validation_candidates = [
            index for index in target_experiment_indices
            if required_confounds is None
            or experiments[index]["confounds"] == required_confounds
        ]
        if not validation_candidates:
            raise ValueError(
                f"target {target_name} requires missing confound set {required_confounds}"
            )
        selected_by_target[target_name] = max(
            validation_candidates, key=lambda index: experiments[index]["heldoutSpearman"]
        )
        experiments[best_predictive]["bestPredictiveForTarget"] = True
        selected_position = target_experiment_indices.index(selected_by_target[target_name])
        selected = experiments[selected_by_target[target_name]]
        prediction_lookup[selected["id"]] = {
            "prediction": target_predictions[selected_position],
            "observed": residual_by_confound[selected["confounds"]],
        }

    target_names = sorted(selected_by_target)
    target_q_values = bh_fdr([
        experiments[selected_by_target[target]]["searchWideP"] for target in target_names
    ])
    target_q = dict(zip(target_names, target_q_values))
    for index, row in enumerate(experiments):
        selected = selected_by_target[row["target"]] == index
        row["selectedForTarget"] = selected
        row["searchWideQ"] = target_q[row["target"]] if selected else None
        row["validationConfoundsRequired"] = targets[row["target"]].get("requiredConfounds")
        row["targetUnit"] = targets[row["target"]].get("targetUnit", "component instance")
        row["multipleTestingFamily"] = (
            "max-null within target; Benjamini-Hochberg across target families"
        )
        row["status"] = (
            "validated" if selected and row["searchWideQ"] <= .05
            and row["heldoutSpearman"] > 0 else
            "target-selected-not-validated" if selected else "not-selected"
        )

    return experiments, prediction_lookup


def fit_direction(features: np.ndarray, target: np.ndarray, confounds: np.ndarray | None,
                  dimensions: int, alpha: float) -> tuple[np.ndarray, np.ndarray]:
    valid = np.isfinite(target)
    x = np.asarray(features[valid], np.float32)
    all_x = np.asarray(features, np.float32).copy()
    y = np.asarray(target[valid], float)
    if confounds is not None and confounds.shape[1]:
        c, all_c = impute_from_train(confounds[valid], confounds)
        cscale = StandardScaler().fit(c)
        c = cscale.transform(c)
        all_c = cscale.transform(all_c)
        feature_confound_model = Ridge(alpha=1.0).fit(c, x)
        x = x - feature_confound_model.predict(c)
        all_x = all_x - feature_confound_model.predict(all_c)
        y = y - Ridge(alpha=1.0).fit(c, y).predict(c)
    dim = min(dimensions, len(x) - 1, x.shape[1])
    reducer = PCA(n_components=max(1, dim), svd_solver="randomized", random_state=1729).fit(x)
    scores = reducer.transform(x)
    scaler = StandardScaler().fit(scores)
    scores_scaled = scaler.transform(scores)
    model = Ridge(alpha=alpha).fit(scores_scaled, y)
    direction = reducer.components_.T @ (model.coef_ / (scaler.scale_ + EPS))
    direction /= np.linalg.norm(direction) + EPS
    all_scores = all_x @ direction
    if finite_correlation(all_scores[valid], y) < 0:
        direction = -direction
        all_scores = -all_scores
    return direction.astype(np.float32), all_scores.astype(np.float32)
