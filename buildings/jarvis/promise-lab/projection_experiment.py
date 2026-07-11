"""Fixed-label viewing projections for an already-frozen clustering map."""

from __future__ import annotations

import hashlib
import itertools
from pathlib import Path
from typing import Any

import numpy as np
from scipy.linalg import eigh
from sklearn.decomposition import PCA
from sklearn.metrics import (
    balanced_accuracy_score,
    calinski_harabasz_score,
    davies_bouldin_score,
    silhouette_score,
)

from atlas import EPS, row_unit, transform_geometry
from run_all_span_atlas import residualize


PROJECTION_SEED = 20260711


def canonical_qr(matrix: np.ndarray) -> np.ndarray:
    """Return a deterministic orthonormal basis for one or many planes."""
    basis, triangular = np.linalg.qr(np.asarray(matrix, np.float64))
    diagonal = np.diagonal(triangular, axis1=-2, axis2=-1)
    signs = np.where(diagonal < 0, -1.0, 1.0)
    return basis * signs[..., None, :]


def cluster_moments(values: np.ndarray, labels: np.ndarray, cluster_count: int) -> dict:
    means = []
    covariances = []
    counts = np.bincount(labels, minlength=cluster_count).astype(np.int64)
    for label in range(cluster_count):
        selected = np.asarray(values[labels == label], np.float64)
        means.append(selected.mean(axis=0))
        covariances.append(np.cov(selected, rowvar=False, bias=True))
    means = np.asarray(means, np.float64)
    covariances = np.asarray(covariances, np.float64)
    pairs = list(itertools.combinations(range(cluster_count), 2))
    differences = np.asarray([means[left] - means[right] for left, right in pairs])
    pooled = np.asarray([
        (covariances[left] + covariances[right]) / 2.0 for left, right in pairs
    ])
    weights = counts / max(1, counts.sum())
    overall = np.average(means, axis=0, weights=weights)
    within = sum(weights[label] * covariances[label] for label in range(cluster_count))
    between = sum(
        weights[label] * np.outer(means[label] - overall, means[label] - overall)
        for label in range(cluster_count)
    )
    return {
        "means": means,
        "covariances": covariances,
        "counts": counts,
        "pairs": pairs,
        "differences": differences,
        "pooled": pooled,
        "within": within,
        "between": between,
    }


def plane_pair_ratios(bases: np.ndarray, moments: dict) -> np.ndarray:
    """Squared centroid distance divided by pooled within-cluster trace."""
    bases = np.asarray(bases, np.float64)
    if bases.ndim == 2:
        bases = bases[None, :, :]
    projected = np.einsum("bdi,pd->bpi", bases, moments["differences"])
    numerator = np.sum(projected * projected, axis=2)
    denominator = np.einsum(
        "bdi,pde,bei->bp", bases, moments["pooled"], bases
    )
    return numerator / (denominator + EPS)


def fisher_plane(moments: dict) -> np.ndarray:
    dimensions = moments["within"].shape[0]
    ridge = max(EPS, float(np.trace(moments["within"])) / dimensions * 1e-8)
    eigenvalues, eigenvectors = eigh(
        moments["between"], moments["within"] + np.eye(dimensions) * ridge
    )
    selected = eigenvectors[:, np.argsort(eigenvalues)[-2:]]
    return canonical_qr(selected)


def maxmin_plane(
    moments: dict, random_planes: int = 100_000,
    refinement_planes_per_scale: int = 10_000,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Search the 4D Grassmannian for the plane with the best weakest pair."""
    rng = np.random.default_rng(PROJECTION_SEED)
    dimensions = moments["within"].shape[0]
    seeds = [np.eye(dimensions)[:, :2], fisher_plane(moments)]
    seed_ratios = plane_pair_ratios(np.asarray(seeds), moments)
    seed_scores = seed_ratios.min(axis=1)
    best_index = int(np.argmax(seed_scores))
    best_basis = np.asarray(seeds[best_index], np.float64)
    best_score = float(seed_scores[best_index])
    batch_size = 5_000
    searched = len(seeds)
    for offset in range(0, random_planes, batch_size):
        count = min(batch_size, random_planes - offset)
        candidates = canonical_qr(rng.normal(size=(count, dimensions, 2)))
        scores = plane_pair_ratios(candidates, moments).min(axis=1)
        candidate_index = int(np.argmax(scores))
        if scores[candidate_index] > best_score:
            best_score = float(scores[candidate_index])
            best_basis = candidates[candidate_index]
        searched += count
    refinement_scales = (0.30, 0.15, 0.08, 0.04, 0.02, 0.01, 0.005)
    for scale in refinement_scales:
        candidates = canonical_qr(
            best_basis[None, :, :]
            + rng.normal(scale=scale, size=(refinement_planes_per_scale, dimensions, 2))
        )
        scores = plane_pair_ratios(candidates, moments).min(axis=1)
        candidate_index = int(np.argmax(scores))
        if scores[candidate_index] > best_score:
            best_score = float(scores[candidate_index])
            best_basis = candidates[candidate_index]
        searched += refinement_planes_per_scale
    return best_basis, {
        "seed": PROJECTION_SEED,
        "primaryObjective": (
            "maximize the minimum over all six pairwise centroid distances divided by "
            "the pair's pooled within-cluster trace"
        ),
        "orthonormalConstraint": True,
        "randomPlanes": random_planes,
        "refinementPlanesPerScale": refinement_planes_per_scale,
        "refinementScales": list(refinement_scales),
        "planesEvaluated": searched,
        "bestSquaredObjective": best_score,
        "bestWorstPairSeparation": float(np.sqrt(best_score)),
    }


def projection_metrics(
    values: np.ndarray, labels: np.ndarray, basis: np.ndarray, moments: dict,
    silhouette_sample: int = 4_096,
) -> tuple[np.ndarray, dict[str, Any]]:
    points = np.asarray(values @ basis, np.float32)
    points -= points.mean(axis=0, keepdims=True)
    cluster_count = len(moments["counts"])
    projected_centers = np.stack([
        points[labels == label].mean(axis=0) for label in range(cluster_count)
    ])
    distances = np.square(
        points[:, None, :] - projected_centers[None, :, :]
    ).sum(axis=2)
    nearest = distances.argmin(axis=1)
    ratios = plane_pair_ratios(basis, moments)[0]
    separations = np.sqrt(ratios)
    fisher = float(
        np.trace(basis.T @ moments["between"] @ basis)
        / (np.trace(basis.T @ moments["within"] @ basis) + EPS)
    )
    sample_size = min(silhouette_sample, len(points))
    silhouette = silhouette_score(
        points, labels,
        sample_size=sample_size if sample_size < len(points) else None,
        random_state=PROJECTION_SEED,
    )
    pair_rows = []
    for pair, separation in zip(moments["pairs"], separations):
        pair_rows.append({
            "left": int(pair[0]),
            "right": int(pair[1]),
            "standardizedSeparation": float(separation),
        })
    return points, {
        "worstPairSeparation": float(separations.min()),
        "meanPairSeparation": float(separations.mean()),
        "bestPairSeparation": float(separations.max()),
        "pairwise": pair_rows,
        "fisherTraceRatio": fisher,
        "nearestCentroidAgreement": float(np.mean(nearest == labels)),
        "balancedNearestCentroidAgreement": float(
            balanced_accuracy_score(labels, nearest)
        ),
        "silhouetteSampled": float(silhouette),
        "silhouetteSampleSize": sample_size,
        "daviesBouldin": float(davies_bouldin_score(points, labels)),
        "calinskiHarabasz": float(calinski_harabasz_score(points, labels)),
        "globalAxisStd": np.std(points, axis=0).astype(float).tolist(),
    }


def reconstruct_exact_map_input(
    atlas: dict, manifest: dict, store_dir: Path, map_id: str,
) -> tuple[np.ndarray, np.ndarray, dict, dict]:
    map_row = next(row for row in atlas["maps"] if row["id"] == map_id)
    if (
        map_row.get("representation") != "raw-hook-residual"
        or map_row.get("geometry") != "whitened"
    ):
        raise ValueError("this reconstruction currently requires raw-hook-residual + whitened")
    raw = row_unit(np.load(store_dir / "raw.npy", mmap_mode="r"))
    hook_indices = np.asarray([row["hookIndex"] for row in manifest["rows"]], np.int16)
    representation = residualize(raw, hook_indices)
    del raw
    dimensions_computed = int(atlas["pca"][map_row["representation"]]["dimensionsComputed"])
    reducer = PCA(
        n_components=dimensions_computed, svd_solver="randomized", random_state=1729
    )
    scores = reducer.fit_transform(row_unit(representation)).astype(np.float32)
    del representation
    existing = np.asarray(atlas["projections"][map_row["representation"]], np.float32)
    reproduced = np.round(scores[:, :2], 5)
    difference = np.abs(reproduced - existing)
    pca_dimensions = int(map_row["pcaDimensions"])
    cluster_input = transform_geometry(scores[:, :pca_dimensions], "whitened")
    labels = np.asarray(map_row["labels"], np.int32)
    verification = {
        "rows": len(labels),
        "storedProjectionMaxAbsError": float(difference.max()),
        "storedProjectionMeanAbsError": float(difference.mean()),
        "storedProjectionTolerance": 1.1e-5,
        "storedProjectionReproduced": bool(difference.max() <= 1.1e-5),
        "labelsSha256": hashlib.sha256(labels.astype(np.int16).tobytes()).hexdigest(),
        "clusterCounts": np.bincount(
            labels, minlength=int(map_row["clusterCount"])
        ).astype(int).tolist(),
        "clusterInputMeans": cluster_input.mean(axis=0).astype(float).tolist(),
        "clusterInputStd": cluster_input.std(axis=0).astype(float).tolist(),
        "clusterInputCorrelation": np.corrcoef(cluster_input.T).astype(float).tolist(),
    }
    return cluster_input, labels, map_row, verification


def run_projection_experiment(
    atlas: dict, manifest: dict, store_dir: Path, map_id: str,
    random_planes: int = 100_000,
) -> dict[str, Any]:
    values, labels, map_row, verification = reconstruct_exact_map_input(
        atlas, manifest, store_dir, map_id
    )
    moments = cluster_moments(values, labels, int(map_row["clusterCount"]))
    pca_basis = np.eye(values.shape[1], dtype=np.float64)[:, :2]
    lda_basis = fisher_plane(moments)
    maxmin_basis, optimization = maxmin_plane(moments, random_planes=random_planes)
    definitions = [
        (
            "pca12", "PCA axes 1-2", pca_basis, False,
            "The first two of the exact four variance-normalized PCA axes used by clustering. "
            "Labels are used only to evaluate this view.",
        ),
        (
            "fisher", "Fisher LDA", lda_basis, True,
            "An orthonormalized Fisher plane maximizing total between-cluster scatter relative "
            "to within-cluster scatter for the frozen labels.",
        ),
        (
            "maxmin", "Max-min balanced", maxmin_basis, True,
            "An orthonormal plane chosen to maximize the weakest standardized separation "
            "among all six frozen cluster pairs.",
        ),
    ]
    methods = []
    for method_id, label, basis, uses_labels, description in definitions:
        points, metrics = projection_metrics(values, labels, basis, moments)
        methods.append({
            "id": method_id,
            "label": label,
            "usesFrozenLabelsToChoosePlane": uses_labels,
            "description": description,
            "basis4x2": np.round(basis, 9).tolist(),
            "metrics": metrics,
            "points": np.round(points, 5).tolist(),
        })
    selected = max(methods, key=lambda row: row["metrics"]["worstPairSeparation"])
    pca_method = next(row for row in methods if row["id"] == "pca12")
    span_ids = [str(row["id"]) for row in atlas.get("spans", [])]
    if len(span_ids) != len(labels):
        raise ValueError("the frozen projection needs one span ID per cluster label")
    return {
        "version": 1,
        "status": "complete",
        "stage": "fixed-label viewing-plane experiment",
        "saved": True,
        "savedName": "Reference-to-gratification candidate",
        "mapId": map_id,
        "scope": map_row.get("scope"),
        "labelsChanged": False,
        "newClusteringFit": False,
        "outcomesUsed": False,
        "manualPhrasesUsed": False,
        "source": {
            "embedding": "unit-normalized 1536D Gemini span text embedding",
            "representation": "subtract source-hook fixed effect, then unit normalize",
            "pca": (
                f"deterministic PCA computed to {atlas['pca'][map_row['representation']]['dimensionsComputed']} "
                f"dimensions; this map uses the first {map_row['pcaDimensions']}"
            ),
            "geometry": (
                "divide each retained PCA coordinate by its global standard deviation; "
                "PCA axes are already uncorrelated"
            ),
            "clustering": (
                f"frozen MiniBatchKMeans k={map_row['clusterCount']} labels from map {map_id}; "
                f"fit on {map_row['fitInstances']} balanced spans from 80% of source hooks"
            ),
        },
        "reconstruction": verification,
        "frozenPointIndex": {
            "labels": labels.astype(int).tolist(),
            "spanIds": span_ids,
        },
        "optimization": optimization,
        "selectedMethod": selected["id"],
        "selectionRule": "largest worstPairSeparation; no outcome or manual phrase enters selection",
        "improvementOverPca": {
            "worstPairSeparationRelative": (
                selected["metrics"]["worstPairSeparation"]
                / pca_method["metrics"]["worstPairSeparation"] - 1.0
            ),
            "nearestCentroidAgreementDelta": (
                selected["metrics"]["nearestCentroidAgreement"]
                - pca_method["metrics"]["nearestCentroidAgreement"]
            ),
            "silhouetteDelta": (
                selected["metrics"]["silhouetteSampled"]
                - pca_method["metrics"]["silhouetteSampled"]
            ),
            "daviesBouldinRelativeReduction": (
                1.0 - selected["metrics"]["daviesBouldin"]
                / pca_method["metrics"]["daviesBouldin"]
            ),
        },
        "metricDefinitions": {
            "worstPairSeparation": (
                "smallest, across all cluster pairs, centroid distance divided by the square "
                "root of pooled within-cluster trace; higher means the weakest pair is clearer"
            ),
            "nearestCentroidAgreement": (
                "fraction of frozen 4D labels recovered by nearest centroid using only the 2D view"
            ),
            "silhouetteSampled": (
                "sampled mean of within-cluster cohesion versus nearest other-cluster separation; "
                "higher is better"
            ),
            "daviesBouldin": (
                "mean worst-case cluster similarity based on spread and centroid distance; lower is better"
            ),
            "fisherTraceRatio": (
                "total between-cluster scatter divided by total within-cluster scatter; higher is better"
            ),
        },
        "methods": methods,
    }
