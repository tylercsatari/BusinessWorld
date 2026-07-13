"""Outcome-blind component representations and clustering experiment sweeps."""

from __future__ import annotations

import hashlib
import math
import weakref
from dataclasses import dataclass
from typing import Callable

import numpy as np
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score


EPS = 1e-9
REPRESENTATIONS = ("raw", "influence", "nonadditive", "context")
GEOMETRIES = ("euclidean", "spherical", "whitened")
_GROUP_BUCKET_CACHE: dict[int, tuple[weakref.ReferenceType, list[str], dict[str, np.ndarray]]] = {}


def row_unit(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, np.float32)
    return matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + EPS)


def representation_matrix(name: str, arrays: dict) -> np.ndarray:
    if name == "raw":
        source = arrays["span_raw"]
    elif name == "context":
        source = arrays["span_context"]
    else:
        influence = np.asarray(arrays["full"], np.float32)[None, :] - np.asarray(
            arrays["span_context"], np.float32
        )
        if name == "influence":
            source = influence
        else:
            token_effects = np.asarray(arrays["token_effects"], np.float32)
            prefix = np.vstack([
                np.zeros((1, token_effects.shape[1]), np.float32),
                np.cumsum(token_effects, axis=0),
            ])
            additive = prefix[np.asarray(arrays["span_end"], int)] - prefix[
                np.asarray(arrays["span_start"], int)
            ]
            source = influence - additive
    return row_unit(source)


def component_id(video_id: str, start: int, end: int) -> str:
    return hashlib.sha1(f"{video_id}:{start}:{end}".encode()).hexdigest()[:20]


def transform_geometry(scores: np.ndarray, geometry: str) -> np.ndarray:
    values = np.asarray(scores, np.float32)
    if geometry == "spherical":
        return row_unit(values)
    if geometry == "whitened":
        return values / (values.std(axis=0, keepdims=True) + EPS)
    return values


def balanced_sample(groups: np.ndarray, maximum: int, rng: np.random.RandomState,
                    allowed_groups: set[str] | None = None) -> np.ndarray:
    groups = np.asarray(groups)
    cache_key = id(groups)
    cached = _GROUP_BUCKET_CACHE.get(cache_key)
    if cached is None or cached[0]() is not groups:
        unique = sorted(set(str(value) for value in groups))
        buckets = {group: np.flatnonzero(groups == group) for group in unique}
        _GROUP_BUCKET_CACHE[cache_key] = (weakref.ref(groups), unique, buckets)
    else:
        _, unique, buckets = cached
    if allowed_groups is not None:
        unique = [value for value in unique if value in allowed_groups]
    selected_buckets = [buckets[group] for group in unique]
    if sum(len(value) for value in selected_buckets) <= maximum:
        return np.concatenate(selected_buckets) if selected_buckets else np.asarray([], int)
    per_group = max(1, maximum // max(1, len(selected_buckets)))
    selected = []
    leftovers = []
    for indices in selected_buckets:
        shuffled = rng.permutation(indices)
        selected.extend(shuffled[:per_group])
        leftovers.extend(shuffled[per_group:])
    if len(selected) < maximum and leftovers:
        selected.extend(rng.permutation(leftovers)[:maximum - len(selected)])
    return np.asarray(sorted(set(int(value) for value in selected[:maximum])), int)


def centroid_margin(values: np.ndarray, centers: np.ndarray, labels: np.ndarray) -> float:
    if len(values) == 0 or len(centers) < 2:
        return 0.0
    distances = np.square(values[:, None, :] - centers[None, :, :]).sum(axis=2)
    own = distances[np.arange(len(values)), labels]
    distances[np.arange(len(values)), labels] = np.inf
    other = distances.min(axis=1)
    margin = (np.sqrt(other) - np.sqrt(own)) / (np.maximum(np.sqrt(other), np.sqrt(own)) + EPS)
    return float(np.mean(margin))


def cluster_entropy(labels: np.ndarray, cluster_count: int) -> tuple[float, float]:
    counts = np.bincount(labels, minlength=cluster_count).astype(float)
    fractions = counts / max(1, counts.sum())
    nz = fractions[fractions > 0]
    entropy = -float(np.sum(nz * np.log(nz))) / max(EPS, math.log(cluster_count))
    return entropy, float(fractions.min())


def _null_matrix(values: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    null = np.empty_like(values)
    for column in range(values.shape[1]):
        null[:, column] = values[rng.permutation(len(values)), column]
    return null


def pareto_indices(rows: list[dict], fields: tuple[str, ...]) -> set[int]:
    points = np.asarray([[float(row.get(field) or 0) for field in fields] for row in rows], float)
    keep = set()
    for index, point in enumerate(points):
        dominated = np.any(np.all(points >= point, axis=1) & np.any(points > point, axis=1))
        if not dominated:
            keep.add(index)
    return keep


@dataclass
class AtlasSweep:
    experiments: list[dict]
    maps: list[dict]
    projections: dict[str, list[list[float]]]
    pca_meta: dict[str, dict]


@dataclass(frozen=True)
class MatrixSource:
    """Lazy matrix input so large derived views do not coexist in memory."""

    shape: tuple[int, int]
    load: Callable[[], np.ndarray]


def normalized_mutual_information(left: np.ndarray, right: np.ndarray) -> float:
    """Deterministic discrete NMI without materializing a dense contingency table."""
    left = np.asarray(left)
    right = np.asarray(right)
    if len(left) == 0 or len(left) != len(right):
        return 0.0
    _, left_codes = np.unique(left, return_inverse=True)
    _, right_codes = np.unique(right, return_inverse=True)
    right_count = int(right_codes.max()) + 1
    joint = np.bincount(
        left_codes.astype(np.int64) * right_count + right_codes,
        minlength=(int(left_codes.max()) + 1) * right_count,
    ).reshape(int(left_codes.max()) + 1, right_count).astype(np.float64)
    joint /= float(len(left))
    left_prob = joint.sum(axis=1)
    right_prob = joint.sum(axis=0)
    rows, columns = np.nonzero(joint)
    values = joint[rows, columns]
    mutual = float(np.sum(values * np.log(
        values / (left_prob[rows] * right_prob[columns] + EPS) + EPS
    )))
    left_entropy = -float(np.sum(left_prob[left_prob > 0] * np.log(left_prob[left_prob > 0])))
    right_entropy = -float(np.sum(right_prob[right_prob > 0] * np.log(right_prob[right_prob > 0])))
    return float(mutual / (math.sqrt(left_entropy * right_entropy) + EPS))


def cross_group_generality(labels: np.ndarray, groups: np.ndarray) -> float:
    """Weighted fraction of source groups represented inside each cluster."""
    labels = np.asarray(labels, int)
    _, group_codes = np.unique(np.asarray(groups).astype(str), return_inverse=True)
    group_count = int(group_codes.max()) + 1
    cluster_count = int(labels.max()) + 1
    pairs = np.unique(labels.astype(np.int64) * group_count + group_codes)
    represented = np.bincount(pairs // group_count, minlength=cluster_count)
    weights = np.bincount(labels, minlength=cluster_count).astype(float)
    weights /= max(1.0, weights.sum())
    return float(np.sum(weights * represented / max(1, group_count)))


def summarize_map_clusters(rows: list[dict], cluster_map: dict,
                           projection: list[list[float]], representative_count: int = 8) -> list[dict]:
    """Attach browse-only cluster composition after a map has been frozen."""
    labels = np.asarray(cluster_map.get("labels") or [], int)
    points = np.asarray(projection, np.float32)
    if len(labels) != len(rows) or points.shape != (len(rows), 2):
        return []
    summaries = []
    for label in sorted(set(labels.tolist())):
        indices = np.flatnonzero(labels == label)
        cluster_points = points[indices]
        centroid = np.nanmean(cluster_points, axis=0)
        distances = np.nansum(np.square(cluster_points - centroid[None, :]), axis=1)
        order = indices[np.argsort(distances, kind="stable")]
        representatives = []
        represented_hooks = set()
        for index in order:
            video_id = str(rows[int(index)].get("videoId") or "")
            if video_id in represented_hooks and len(represented_hooks) < representative_count:
                continue
            representatives.append(int(index))
            represented_hooks.add(video_id)
            if len(representatives) >= representative_count:
                break
        if len(representatives) < representative_count:
            for index in order:
                if int(index) not in representatives:
                    representatives.append(int(index))
                if len(representatives) >= representative_count:
                    break
        lengths = np.asarray([int(rows[int(index)].get("tokenCount") or 0) for index in indices])
        support_values = [bool(rows[int(index)].get("boundarySupported")) for index in indices
                          if "boundarySupported" in rows[int(index)]]
        summaries.append({
            "label": int(label),
            "size": int(len(indices)),
            "hookCount": len(set(str(rows[int(index)].get("videoId") or "") for index in indices)),
            "medianTokenCount": float(np.median(lengths)) if len(lengths) else None,
            "minimumTokenCount": int(lengths.min()) if len(lengths) else None,
            "maximumTokenCount": int(lengths.max()) if len(lengths) else None,
            "boundarySupportedFraction": (float(np.mean(support_values))
                                           if support_values else None),
            "selectedEvidenceFraction": float(np.mean([
                bool(rows[int(index)].get("selectedPrimary")) for index in indices
            ])) if any("selectedPrimary" in rows[int(index)] for index in indices) else None,
            "representativeIndices": representatives,
            "representativeMethod": "nearest displayed-2D centroid with source-hook diversity first",
            "browseOnly": True,
        })
    return summaries


def run_cluster_sweep(representations: dict[str, np.ndarray | MatrixSource], groups: np.ndarray,
                      max_dimension: int = 12, max_clusters: int = 28,
                      seeds: int = 3, fit_sample: int = 2048,
                      eval_sample: int = 768, map_limit: int = 300,
                      progress=None, dimensions: list[int] | None = None,
                      cluster_counts: list[int] | None = None,
                      nuisance: dict[str, np.ndarray] | None = None,
                      experiment_namespace: str = "candidate",
                      stability_sample: int = 0) -> AtlasSweep:
    groups = np.asarray(groups).astype(str)
    experiments = []
    map_candidates = []
    projections = {}
    pca_meta = {}
    configuration_total = 0
    for source in representations.values():
        shape = source.shape
        rank_cap = min(max_dimension, shape[0] - 1, shape[1])
        cluster_cap = min(max_clusters, max(2, int(math.sqrt(shape[0]))))
        dimension_grid = ([value for value in dimensions if 2 <= value <= rank_cap]
                          if dimensions else list(range(2, rank_cap + 1)))
        cluster_grid = ([value for value in cluster_counts if 2 <= value <= cluster_cap]
                        if cluster_counts else list(range(2, cluster_cap + 1)))
        configuration_total += len(dimension_grid) * len(GEOMETRIES) * len(cluster_grid)
    configuration_complete = 0
    unique_groups = np.asarray(sorted(set(groups)))
    if progress:
        progress({"configurationsComplete": 0, "configurationsTotal": configuration_total,
                  "experimentsComplete": 0})

    for representation, source in representations.items():
        matrix = source.load() if isinstance(source, MatrixSource) else source
        matrix = row_unit(matrix)
        rank_cap = min(max_dimension, matrix.shape[0] - 1, matrix.shape[1])
        if rank_cap < 2:
            continue
        reducer = PCA(n_components=rank_cap, svd_solver="randomized", random_state=1729)
        scores = reducer.fit_transform(matrix).astype(np.float32)
        projections[representation] = np.round(scores[:, :2], 5).tolist()
        pca_meta[representation] = {
            "dimensionsComputed": rank_cap,
            "explainedVarianceRatio": np.round(reducer.explained_variance_ratio_, 7).tolist(),
            "outcomesUsed": False,
            "fitScope": "complete corpus; descriptive atlas geometry",
            "independentHoldout": False,
        }
        cluster_cap = min(max_clusters, max(2, int(math.sqrt(len(matrix)))))

        dimension_grid = ([value for value in dimensions if 2 <= value <= rank_cap]
                          if dimensions else list(range(2, rank_cap + 1)))
        cluster_grid = ([value for value in cluster_counts if 2 <= value <= cluster_cap]
                        if cluster_counts else list(range(2, cluster_cap + 1)))

        for dimension in dimension_grid:
            base = scores[:, :dimension]
            for geometry in GEOMETRIES:
                values = transform_geometry(base, geometry)
                for cluster_count in cluster_grid:
                    labels_by_seed = []
                    rows_for_group = []
                    for seed_index in range(seeds):
                        rng = np.random.RandomState(1729 + seed_index * 1009 + dimension * 37 + cluster_count)
                        train_count = max(2, int(round(len(unique_groups) * .8)))
                        train_groups = set(rng.permutation(unique_groups)[:train_count].tolist())
                        train_indices = balanced_sample(groups, min(fit_sample, len(values)), rng, train_groups)
                        if len(train_indices) < cluster_count:
                            continue
                        model = MiniBatchKMeans(
                            n_clusters=cluster_count,
                            random_state=seed_index,
                            n_init=1,
                            max_iter=30,
                            batch_size=min(512, max(64, len(train_indices))),
                            reassignment_ratio=.01,
                        ).fit(values[train_indices])
                        labels = model.predict(values)
                        labels_by_seed.append(labels)
                        eval_indices = balanced_sample(groups, min(eval_sample, len(values)), rng)
                        eval_labels = labels[eval_indices]
                        margin = centroid_margin(values[eval_indices], model.cluster_centers_, eval_labels)
                        holdout_indices = np.flatnonzero(~np.isin(groups, list(train_groups)))
                        if len(holdout_indices) > eval_sample:
                            holdout_indices = rng.choice(holdout_indices, eval_sample, replace=False)
                        holdout_margin = centroid_margin(
                            values[holdout_indices], model.cluster_centers_, labels[holdout_indices]
                        ) if len(holdout_indices) else margin
                        entropy, min_fraction = cluster_entropy(labels, cluster_count)
                        row = {
                            "id": hashlib.sha1(
                                f"cluster:{experiment_namespace}:{representation}:{dimension}:"
                                f"{geometry}:{cluster_count}:{seed_index}".encode()
                            ).hexdigest()[:20],
                            "stage": "component-cluster",
                            "representation": representation,
                            "pcaDimensions": dimension,
                            "geometry": geometry,
                            "clusterCount": cluster_count,
                            "seed": seed_index,
                            "fitHooksFraction": .8,
                            "fitInstances": int(len(train_indices)),
                            "margin": margin,
                            "heldoutHookMargin": holdout_margin,
                            "fitExcludedHookMargin": holdout_margin,
                            "fitExcludedMetricContract": (
                                "hooks excluded from K-means fitting but not from the full-corpus PCA; "
                                "descriptive, not independent held-out validation"
                            ),
                            "entropy": entropy,
                            "minimumClusterFraction": min_fraction,
                            "outcomesUsed": False,
                        }
                        rows_for_group.append(row)

                    if not rows_for_group:
                        continue
                    stability = 1.0
                    if len(labels_by_seed) > 1:
                        stability_indices = np.arange(len(groups))
                        if stability_sample and len(groups) > stability_sample:
                            stability_indices = balanced_sample(
                                groups, stability_sample,
                                np.random.RandomState(6007 + dimension * 43 + cluster_count * 11),
                            )
                        agreements = []
                        for left in range(len(labels_by_seed)):
                            for right in range(left + 1, len(labels_by_seed)):
                                agreements.append(adjusted_rand_score(
                                    labels_by_seed[left][stability_indices],
                                    labels_by_seed[right][stability_indices],
                                ))
                        stability = float(np.mean(agreements)) if agreements else 1.0

                    rng = np.random.RandomState(991 + dimension * 31 + cluster_count * 7)
                    null_values = _null_matrix(values, rng)
                    null_indices = balanced_sample(groups, min(fit_sample, len(values)), rng)
                    null_model = MiniBatchKMeans(
                        n_clusters=cluster_count,
                        random_state=991,
                        n_init=1,
                        max_iter=30,
                        batch_size=min(512, max(64, len(null_indices))),
                    ).fit(null_values[null_indices])
                    null_eval = balanced_sample(groups, min(eval_sample, len(values)), rng)
                    null_labels = null_model.predict(null_values[null_eval])
                    null_margin = centroid_margin(null_values[null_eval], null_model.cluster_centers_, null_labels)

                    for row in rows_for_group:
                        row["seedStabilityARI"] = stability
                        row["permutedNullMargin"] = null_margin
                        row["marginAboveNull"] = row["margin"] - null_margin
                        row["qualityForBrowsing"] = (
                            max(0.0, row["marginAboveNull"]) *
                            max(0.0, row["fitExcludedHookMargin"]) *
                            max(0.0, stability) *
                            max(0.0, row["entropy"])
                        )
                        experiments.append(row)
                    best_seed = max(range(len(rows_for_group)),
                                    key=lambda index: rows_for_group[index]["qualityForBrowsing"])
                    best_labels = labels_by_seed[best_seed]
                    if nuisance:
                        length_nmi = normalized_mutual_information(
                            best_labels, nuisance.get("length", np.zeros(len(best_labels), int))
                        )
                        position_nmi = normalized_mutual_information(
                            best_labels, nuisance.get("position", np.zeros(len(best_labels), int))
                        )
                        generality = cross_group_generality(best_labels, groups)
                        row = rows_for_group[best_seed]
                        row["lengthNMI"] = length_nmi
                        row["positionNMI"] = position_nmi
                        row["crossHookGenerality"] = generality
                        row["lengthIndependence"] = 1.0 - length_nmi
                        row["positionIndependence"] = 1.0 - position_nmi
                        row["qualityForBrowsing"] *= (
                            max(0.0, generality) ** .5 *
                            max(0.0, 1.0 - length_nmi) *
                            max(0.0, 1.0 - position_nmi) ** .5
                        )
                    map_candidates.append({
                        **rows_for_group[best_seed],
                        "labels": best_labels.astype(np.int16),
                    })
                    configuration_complete += 1
                    if progress:
                        progress({
                            "configurationsComplete": configuration_complete,
                            "configurationsTotal": configuration_total,
                            "experimentsComplete": len(experiments),
                            "representation": representation,
                            "pcaDimensions": dimension,
                            "geometry": geometry,
                            "clusterCount": cluster_count,
                        })

        del matrix

    pareto_fields = ["marginAboveNull", "fitExcludedHookMargin", "seedStabilityARI", "entropy"]
    if nuisance:
        pareto_fields.extend(["crossHookGenerality", "lengthIndependence", "positionIndependence"])
    pareto = pareto_indices(map_candidates, tuple(pareto_fields))
    for index, row in enumerate(map_candidates):
        row["pareto"] = index in pareto
    ranked_maps = sorted(
        map_candidates,
        key=lambda row: (not row["pareto"], -row["qualityForBrowsing"], row["id"]),
    )
    representation_names = sorted(set(row["representation"] for row in ranked_maps))
    selected_maps = []
    selected_ids = set()
    if representation_names:
        quota = max(1, map_limit // len(representation_names))
        for name in representation_names:
            for row in (item for item in ranked_maps if item["representation"] == name):
                if sum(item["representation"] == name for item in selected_maps) >= quota:
                    break
                selected_maps.append(row)
                selected_ids.add(row["id"])
    for row in ranked_maps:
        if len(selected_maps) >= map_limit:
            break
        if row["id"] not in selected_ids:
            selected_maps.append(row)
            selected_ids.add(row["id"])
    maps = [{**row, "labels": row["labels"].astype(int).tolist()} for row in selected_maps]
    return AtlasSweep(experiments=experiments, maps=maps, projections=projections,
                      pca_meta=pca_meta)
