#!/usr/bin/env python3
"""Outcome-blind component discovery and grouped surrogate-outcome analysis.

The public entry points deliberately separate discovery from inference:

``discover_components`` never accepts an outcome, while
``analyze_component_outcomes`` accepts only the frozen discovery result.
Everything in this module is deterministic for identical arrays, groups,
folds, text, configuration, and scikit-learn version.  It performs no I/O and
does not call an embedding or language-model provider.
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
import warnings
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

import numpy as np
from scipy.stats import t as student_t
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
)
from sklearn.mixture import GaussianMixture

try:
    from sklearn.cluster import HDBSCAN
except ImportError:  # pragma: no cover - exercised only on older runtimes.
    HDBSCAN = None


SCHEMA_VERSION = "operations-principles-analysis-v1"
DEFAULT_SEED = 20260724
EPSILON = 1e-12


@dataclass(frozen=True)
class PrinciplesConfig:
    """Bounded, pre-outcome analysis settings."""

    k_values: tuple[int, ...] = (2, 3, 4, 5)
    seeds: tuple[int, ...] = (DEFAULT_SEED, DEFAULT_SEED + 101, DEFAULT_SEED + 307)
    min_component_size: int = 8
    max_component_fraction: float = 0.90
    stability_resamples: int = 4
    stability_fraction: float = 0.80
    min_valid_stability_fraction: float = 0.75
    min_stability: float = 0.55
    dedup_jaccard: float = 0.85
    min_algorithm_support: int = 2
    min_resolution_support: int = 1
    max_pca_dimensions: int = 24
    hdbscan_min_cluster_fractions: tuple[float, ...] = (0.05, 0.10)
    bootstrap_repeats: int = 400
    regularization_c: float = 0.5
    calibration_bins: int = 10
    keep_threshold: float = 85.0
    sensitivity_thresholds: tuple[float, ...] = (82.5, 85.0, 87.5)
    phrase_min_tokens: int = 1
    phrase_max_tokens: int = 6
    phrase_min_document_frequency: int = 2

    def validate(self) -> None:
        if not self.k_values or any(int(value) < 2 for value in self.k_values):
            raise ValueError("k_values must contain integers of at least two")
        if not self.seeds:
            raise ValueError("at least one deterministic seed is required")
        if self.min_component_size < 2:
            raise ValueError("min_component_size must be at least two")
        if not 0 < self.max_component_fraction < 1:
            raise ValueError("max_component_fraction must be between zero and one")
        if self.stability_resamples < 1:
            raise ValueError("stability_resamples must be positive")
        if not 0 < self.stability_fraction <= 1:
            raise ValueError("stability_fraction must be in (0, 1]")
        if not 0 < self.min_valid_stability_fraction <= 1:
            raise ValueError("min_valid_stability_fraction must be in (0, 1]")
        if not 0 <= self.min_stability <= 1:
            raise ValueError("min_stability must be in [0, 1]")
        if not 0 < self.dedup_jaccard <= 1:
            raise ValueError("dedup_jaccard must be in (0, 1]")
        if self.min_algorithm_support < 1 or self.min_resolution_support < 1:
            raise ValueError("consensus support minima must be positive")
        if self.max_pca_dimensions < 1:
            raise ValueError("max_pca_dimensions must be positive")
        if self.bootstrap_repeats < 20:
            raise ValueError("bootstrap_repeats must be at least 20")
        if self.regularization_c <= 0:
            raise ValueError("regularization_c must be positive")
        if self.calibration_bins < 2:
            raise ValueError("calibration_bins must be at least two")
        if not 0 <= self.keep_threshold <= 100:
            raise ValueError("keep_threshold must be in [0, 100]")
        if (
            not self.sensitivity_thresholds
            or any(not 0 <= value <= 100 for value in self.sensitivity_thresholds)
        ):
            raise ValueError("sensitivity_thresholds must be within [0, 100]")
        if not 1 <= self.phrase_min_tokens <= self.phrase_max_tokens:
            raise ValueError("phrase token limits are invalid")
        if self.phrase_min_document_frequency < 1:
            raise ValueError("phrase_min_document_frequency must be positive")


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    """Return a finite row-normalized copy."""

    values = np.asarray(matrix, dtype=np.float64)
    if values.ndim != 2:
        raise ValueError("embedding matrix must be two-dimensional")
    if not np.all(np.isfinite(values)):
        raise ValueError("embedding matrix contains non-finite values")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if np.any(norms <= EPSILON):
        raise ValueError("embedding matrix contains a zero-norm row")
    return values / norms


def _stable_seed(*parts: Any) -> int:
    payload = "\x1f".join(str(part) for part in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big") % (2**32 - 1)


def _array_hash(values: np.ndarray) -> str:
    array = np.ascontiguousarray(np.asarray(values, dtype="<f8"))
    digest = hashlib.sha256()
    digest.update(str(array.shape).encode("ascii"))
    digest.update(array.tobytes())
    return digest.hexdigest()


def _indices_hash(indices: Sequence[int], n_rows: int) -> str:
    mask = np.zeros(n_rows, dtype=np.uint8)
    mask[np.asarray(indices, dtype=int)] = 1
    return hashlib.sha256(np.packbits(mask).tobytes()).hexdigest()


def _json_scalar(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    return value


def _normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    return re.sub(r"\s+", " ", text).strip()


def _row_text(row: Any) -> str:
    if isinstance(row, Mapping):
        for key in ("text", "hook", "title"):
            if row.get(key):
                return _normalize_text(row[key])
        return ""
    return _normalize_text(row)


def _validate_embedding_families(
    embedding_families: Mapping[str, np.ndarray],
) -> tuple[dict[str, np.ndarray], int]:
    if not embedding_families:
        raise ValueError("at least one embedding feature family is required")
    clean: dict[str, np.ndarray] = {}
    n_rows: int | None = None
    for family in sorted(embedding_families):
        if not str(family).strip():
            raise ValueError("feature-family names must be non-empty")
        values = np.asarray(embedding_families[family], dtype=np.float64)
        if values.ndim != 2 or values.shape[1] < 1:
            raise ValueError(f"{family}: embeddings must have shape (rows, dimensions)")
        if not np.all(np.isfinite(values)):
            raise ValueError(f"{family}: embeddings contain non-finite values")
        if n_rows is None:
            n_rows = int(values.shape[0])
        elif values.shape[0] != n_rows:
            raise ValueError(f"{family}: row count does not match other families")
        norms = np.linalg.norm(values, axis=1)
        if np.any(norms <= EPSILON):
            raise ValueError(f"{family}: embeddings contain a zero-norm row")
        if not np.allclose(norms, 1.0, rtol=1e-5, atol=1e-6):
            raise ValueError(f"{family}: embeddings must be normalized before discovery")
        clean[str(family)] = values.copy()
    if n_rows is None or n_rows < 4:
        raise ValueError("component discovery requires at least four rows")
    return clean, n_rows


def _validate_groups(group_ids: Sequence[Any], n_rows: int) -> np.ndarray:
    if len(group_ids) != n_rows:
        raise ValueError("group ID count does not match embedding rows")
    groups = np.asarray([str(value) for value in group_ids], dtype=object)
    if any(not value for value in groups):
        raise ValueError("group IDs must be non-empty")
    return groups


def _validate_folds(
    folds: Sequence[Any],
    groups: np.ndarray,
    n_rows: int,
) -> np.ndarray:
    if len(folds) != n_rows:
        raise ValueError("fold count does not match embedding rows")
    fold_array = np.asarray([str(value) for value in folds], dtype=object)
    if any(not value for value in fold_array):
        raise ValueError("fold IDs must be non-empty")
    for group in sorted(set(groups.tolist())):
        group_folds = set(fold_array[groups == group].tolist())
        if len(group_folds) != 1:
            raise ValueError(f"group {group!r} crosses validation folds")
    return fold_array


def _pca_view(values: np.ndarray, max_dimensions: int) -> np.ndarray:
    n_rows, n_dimensions = values.shape
    components = min(max_dimensions, n_dimensions, n_rows - 1)
    if components < 1:
        return values.copy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        transformed = PCA(
            n_components=components,
            whiten=True,
            svd_solver="randomized",
            random_state=DEFAULT_SEED,
        ).fit_transform(values)
    transformed = np.nan_to_num(transformed, nan=0.0, posinf=0.0, neginf=0.0)
    nonconstant = np.std(transformed, axis=0) > EPSILON
    return transformed[:, nonconstant] if np.any(nonconstant) else transformed[:, :1]


def _spherical_kmeans(
    values: np.ndarray,
    k: int,
    seed: int,
    max_iterations: int = 300,
) -> np.ndarray:
    n_rows = len(values)
    if k < 2 or k >= n_rows:
        raise ValueError("spherical KMeans k must be in [2, n_rows)")
    rng = np.random.default_rng(seed)
    first = int(rng.integers(0, n_rows))
    selected = [first]
    centers = [values[first].copy()]
    while len(centers) < k:
        similarities = values @ np.vstack(centers).T
        distance = np.maximum(0.0, 1.0 - np.max(similarities, axis=1))
        distance[np.asarray(selected, dtype=int)] = 0.0
        weights = distance * distance
        if float(weights.sum()) <= EPSILON:
            remaining = [index for index in range(n_rows) if index not in selected]
            if not remaining:
                raise ValueError("insufficient unique support for spherical KMeans")
            chosen = remaining[0]
        else:
            chosen = int(rng.choice(n_rows, p=weights / weights.sum()))
        selected.append(chosen)
        centers.append(values[chosen].copy())
    center_matrix = normalize_rows(np.vstack(centers))
    labels = np.full(n_rows, -1, dtype=int)
    for _ in range(max_iterations):
        similarities = values @ center_matrix.T
        next_labels = np.argmax(similarities, axis=1).astype(int)
        counts = np.bincount(next_labels, minlength=k)
        for empty_cluster in np.where(counts == 0)[0]:
            confidence = np.max(similarities, axis=1)
            replacement = int(np.argmin(confidence))
            next_labels[replacement] = int(empty_cluster)
        next_centers = []
        for cluster_id in range(k):
            members = values[next_labels == cluster_id]
            center = np.mean(members, axis=0)
            norm = float(np.linalg.norm(center))
            if norm <= EPSILON:
                center = values[np.where(next_labels == cluster_id)[0][0]]
                norm = float(np.linalg.norm(center))
            next_centers.append(center / norm)
        next_center_matrix = np.vstack(next_centers)
        if np.array_equal(next_labels, labels):
            center_matrix = next_center_matrix
            labels = next_labels
            break
        labels = next_labels
        center_matrix = next_center_matrix
    return labels


def _partition_specs(n_rows: int, config: PrinciplesConfig) -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []
    for k in sorted(set(int(value) for value in config.k_values)):
        for seed in sorted(set(int(value) for value in config.seeds)):
            specs.append({"algorithm": "spherical_kmeans", "k": k, "seed": seed})
            specs.append({"algorithm": "gaussian_mixture", "k": k, "seed": seed})
        specs.append({"algorithm": "agglomerative_cosine", "k": k})
        specs.append({"algorithm": "agglomerative_ward", "k": k})
    sizes = {
        max(config.min_component_size, int(math.ceil(n_rows * fraction)))
        for fraction in config.hdbscan_min_cluster_fractions
        if fraction > 0
    }
    for size in sorted(sizes):
        specs.append({
            "algorithm": "hdbscan",
            "minClusterSize": int(size),
            "minSamples": max(2, int(math.ceil(math.sqrt(size)))),
        })
    return specs


def _fit_partition(
    values: np.ndarray,
    spec: Mapping[str, Any],
    config: PrinciplesConfig,
) -> np.ndarray:
    algorithm = str(spec["algorithm"])
    k = int(spec.get("k") or 0)
    if k and k >= len(values):
        raise ValueError("requested k exceeds row or unique-vector support")
    if k:
        unique_rows: set[bytes] = set()
        for row in values:
            unique_rows.add(np.round(row, decimals=12).tobytes())
            if len(unique_rows) >= k:
                break
        if len(unique_rows) < k:
            raise ValueError("requested k exceeds row or unique-vector support")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ConvergenceWarning)
        warnings.simplefilter("ignore", RuntimeWarning)
        if algorithm == "spherical_kmeans":
            return _spherical_kmeans(values, k, int(spec["seed"]))
        if algorithm == "gaussian_mixture":
            reduced = _pca_view(values, config.max_pca_dimensions)
            model = GaussianMixture(
                n_components=k,
                covariance_type="diag",
                reg_covar=1e-5,
                n_init=1,
                max_iter=400,
                random_state=int(spec["seed"]),
            )
            return model.fit_predict(reduced).astype(int)
        if algorithm == "agglomerative_cosine":
            model = AgglomerativeClustering(
                n_clusters=k,
                metric="cosine",
                linkage="average",
            )
            return model.fit_predict(values).astype(int)
        if algorithm == "agglomerative_ward":
            reduced = _pca_view(values, config.max_pca_dimensions)
            model = AgglomerativeClustering(
                n_clusters=k,
                metric="euclidean",
                linkage="ward",
            )
            return model.fit_predict(reduced).astype(int)
        if algorithm == "hdbscan":
            if HDBSCAN is None:
                raise RuntimeError("HDBSCAN is unavailable in this scikit-learn runtime")
            model = HDBSCAN(
                min_cluster_size=int(spec["minClusterSize"]),
                min_samples=int(spec["minSamples"]),
                metric="euclidean",
                allow_single_cluster=False,
                n_jobs=1,
                copy=True,
            )
            return model.fit_predict(values).astype(int)
    raise ValueError(f"unsupported clustering algorithm: {algorithm}")


def _candidate_jaccard(left: Sequence[int], right: Sequence[int]) -> float:
    left_set = set(int(value) for value in left)
    right_set = set(int(value) for value in right)
    union = len(left_set | right_set)
    return float(len(left_set & right_set) / union) if union else 1.0


def jaccard_indices(left: Sequence[int], right: Sequence[int]) -> float:
    """Public deterministic Jaccard helper used by the deduplication contract."""

    return _candidate_jaccard(left, right)


def _group_subsample(
    groups: np.ndarray,
    fraction: float,
    seed: int,
) -> np.ndarray:
    unique_groups = np.asarray(sorted(set(groups.tolist())), dtype=object)
    if len(unique_groups) < 2:
        return np.arange(len(groups), dtype=int)
    count = min(
        len(unique_groups),
        max(2, int(math.ceil(len(unique_groups) * fraction))),
    )
    rng = np.random.default_rng(seed)
    selected = set(rng.choice(unique_groups, size=count, replace=False).tolist())
    return np.where(np.asarray([group in selected for group in groups], dtype=bool))[0]


def _partition_stability(
    values: np.ndarray,
    labels: np.ndarray,
    spec: Mapping[str, Any],
    groups: np.ndarray,
    config: PrinciplesConfig,
    family: str,
) -> dict[int, list[float]]:
    cluster_ids = sorted(int(value) for value in np.unique(labels) if value >= 0)
    scores = {cluster_id: [] for cluster_id in cluster_ids}
    for repeat in range(config.stability_resamples):
        indices = _group_subsample(
            groups,
            config.stability_fraction,
            _stable_seed("stability", family, spec, repeat),
        )
        required = max(int(spec.get("k") or 1) + 1, config.min_component_size * 2)
        if len(indices) < required:
            continue
        try:
            subset_labels = _fit_partition(values[indices], spec, config)
        except (ValueError, RuntimeError, FloatingPointError, np.linalg.LinAlgError):
            continue
        subset_cluster_ids = [
            int(value) for value in np.unique(subset_labels) if value >= 0
        ]
        if not subset_cluster_ids:
            continue
        for cluster_id in cluster_ids:
            base_members = np.where(labels[indices] == cluster_id)[0]
            if len(base_members) < 2:
                continue
            best = max(
                _candidate_jaccard(
                    base_members,
                    np.where(subset_labels == candidate_id)[0],
                )
                for candidate_id in subset_cluster_ids
            )
            scores[cluster_id].append(float(best))
    return scores


def _deduplicate_candidates(
    candidates: list[dict[str, Any]],
    embeddings: Mapping[str, np.ndarray],
    n_rows: int,
    config: PrinciplesConfig,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    eligible_indices = [
        index for index, candidate in enumerate(candidates)
        if not candidate["preOutcomeRejectionReasons"]
    ]
    # Build direct-anchor consensus groups. Connected-component chaining can
    # otherwise make A support C merely because A≈B and B≈C even when A and C
    # describe materially different memberships.
    remaining = set(eligible_indices)
    groups: list[list[int]] = []
    while remaining:
        anchor_index = sorted(
            remaining,
            key=lambda index: (
                -float(candidates[index]["stability"]),
                -int(candidates[index]["n"]),
                str(candidates[index]["candidateId"]),
            ),
        )[0]
        anchor = candidates[anchor_index]
        group = [anchor_index]
        for candidate_index in sorted(
            remaining - {anchor_index},
            key=lambda index: str(candidates[index]["candidateId"]),
        ):
            candidate = candidates[candidate_index]
            size_ratio = (
                min(anchor["n"], candidate["n"])
                / max(anchor["n"], candidate["n"])
            )
            if size_ratio + EPSILON < config.dedup_jaccard:
                continue
            if _candidate_jaccard(
                anchor["memberIndices"],
                candidate["memberIndices"],
            ) >= config.dedup_jaccard:
                group.append(candidate_index)
        groups.append(group)
        remaining.difference_update(group)

    components: list[dict[str, Any]] = []
    dedupe_ledger: list[dict[str, Any]] = []
    for group_indices in sorted(
        groups,
        key=lambda values: min(candidates[index]["candidateId"] for index in values),
    ):
        members = [candidates[index] for index in group_indices]
        representative = candidates[group_indices[0]]
        algorithms = sorted({str(row["algorithm"]) for row in members})
        resolutions = sorted({str(row["resolution"]) for row in members})
        stable_members = [
            row for row in members
            if row["stability"] is not None
            and row["stability"] >= config.min_stability
        ]
        component_id = "cmp-" + hashlib.sha256(
            "\x1f".join(sorted(row["candidateId"] for row in members)).encode("utf-8")
        ).hexdigest()[:16]
        group_rejections = []
        if len(algorithms) < config.min_algorithm_support:
            group_rejections.append("insufficient_algorithm_support")
        if len(resolutions) < config.min_resolution_support:
            group_rejections.append("insufficient_resolution_support")
        accepted = not group_rejections
        for row in members:
            row["dedupeComponentId"] = component_id
            row["representative"] = row["candidateId"] == representative["candidateId"]
            row["algorithmSupport"] = len(algorithms)
            row["resolutionSupport"] = len(resolutions)
            row["stabilitySupport"] = len(stable_members)
            if row["representative"] and accepted:
                row["status"] = "accepted"
                row["rejectionReasons"] = []
            elif row["representative"]:
                row["status"] = "rejected"
                row["rejectionReasons"] = group_rejections.copy()
            else:
                row["status"] = "deduplicated"
                row["rejectionReasons"] = ["jaccard_duplicate"]
        dedupe_ledger.append({
            "componentId": component_id,
            "candidateIds": sorted(row["candidateId"] for row in members),
            "representativeCandidateId": representative["candidateId"],
            "algorithmSupport": len(algorithms),
            "resolutionSupport": len(resolutions),
            "stabilitySupport": len(stable_members),
            "algorithms": algorithms,
            "resolutions": resolutions,
            "accepted": accepted,
            "rejectionReasons": group_rejections,
            "consensusContract": (
                "Every supporting candidate directly meets the configured Jaccard "
                "threshold against the representative; transitive chaining is excluded."
            ),
        })
        if not accepted:
            continue
        indices = representative["memberIndices"]
        centroids: dict[str, list[float]] = {}
        for resolution in resolutions:
            center = np.mean(embeddings[resolution][indices], axis=0)
            norm = float(np.linalg.norm(center))
            if norm > EPSILON:
                centroids[resolution] = (center / norm).astype(float).tolist()
        stability_values = [
            float(row["stability"]) for row in members
            if row["stability"] is not None
        ]
        components.append({
            "id": component_id,
            "representativeCandidateId": representative["candidateId"],
            "memberIndices": list(indices),
            "membershipHash": representative["membershipHash"],
            "n": int(representative["n"]),
            "prevalence": float(representative["prevalence"]),
            "algorithmSupport": len(algorithms),
            "resolutionSupport": len(resolutions),
            "stabilitySupport": len(stable_members),
            "algorithms": algorithms,
            "resolutions": resolutions,
            "supportingCandidateIds": sorted(row["candidateId"] for row in members),
            "stability": {
                "representative": representative["stability"],
                "minimum": min(stability_values) if stability_values else None,
                "median": float(np.median(stability_values)) if stability_values else None,
                "maximum": max(stability_values) if stability_values else None,
            },
            "centroidsByResolution": centroids,
        })

    for candidate in candidates:
        if candidate["preOutcomeRejectionReasons"]:
            candidate["dedupeComponentId"] = None
            candidate["representative"] = False
            candidate["algorithmSupport"] = 0
            candidate["resolutionSupport"] = 0
            candidate["stabilitySupport"] = 0
            candidate["status"] = "rejected"
            candidate["rejectionReasons"] = list(candidate["preOutcomeRejectionReasons"])
    components.sort(key=lambda row: row["id"])
    candidates.sort(key=lambda row: row["candidateId"])
    dedupe_ledger.sort(key=lambda row: row["componentId"])
    return components, dedupe_ledger


def discover_components(
    embedding_families: Mapping[str, np.ndarray],
    group_ids: Sequence[Any],
    *,
    config: PrinciplesConfig | None = None,
) -> dict[str, Any]:
    """Discover stable components without accepting or inspecting an outcome."""

    settings = config or PrinciplesConfig()
    settings.validate()
    embeddings, n_rows = _validate_embedding_families(embedding_families)
    groups = _validate_groups(group_ids, n_rows)
    partition_ledger: list[dict[str, Any]] = []
    candidate_ledger: list[dict[str, Any]] = []

    for family in sorted(embeddings):
        values = embeddings[family]
        for spec in _partition_specs(n_rows, settings):
            spec_payload = {
                key: _json_scalar(value)
                for key, value in sorted(spec.items())
            }
            partition_id = "prt-" + hashlib.sha256(
                f"{family}\x1f{spec_payload}".encode("utf-8")
            ).hexdigest()[:16]
            partition = {
                "partitionId": partition_id,
                "resolution": family,
                "algorithm": spec["algorithm"],
                "parameters": spec_payload,
                "status": "tested",
                "failure": None,
                "clusterCount": 0,
                "noiseCount": 0,
                "candidateIds": [],
            }
            try:
                labels = _fit_partition(values, spec, settings)
                cluster_ids = sorted(
                    int(value) for value in np.unique(labels) if value >= 0
                )
                if not cluster_ids:
                    raise ValueError("partition produced no non-noise clusters")
                stability = _partition_stability(
                    values,
                    labels,
                    spec,
                    groups,
                    settings,
                    family,
                )
                partition["clusterCount"] = len(cluster_ids)
                partition["noiseCount"] = int(np.sum(labels < 0))
                for cluster_id in cluster_ids:
                    indices = np.where(labels == cluster_id)[0].astype(int).tolist()
                    membership_hash = _indices_hash(indices, n_rows)
                    candidate_id = "cand-" + hashlib.sha256(
                        (
                            f"{partition_id}\x1f{cluster_id}\x1f{membership_hash}"
                        ).encode("utf-8")
                    ).hexdigest()[:20]
                    scores = stability.get(cluster_id) or []
                    stability_score = float(np.mean(scores)) if scores else None
                    rejections: list[str] = []
                    if len(indices) < settings.min_component_size:
                        rejections.append("component_too_small")
                    if n_rows - len(indices) < settings.min_component_size:
                        rejections.append("complement_too_small")
                    if len(indices) / n_rows > settings.max_component_fraction:
                        rejections.append("component_too_prevalent")
                    if stability_score is None:
                        rejections.append("stability_unavailable")
                    elif stability_score < settings.min_stability:
                        rejections.append("stability_below_threshold")
                    minimum_valid_resamples = max(
                        1,
                        int(math.ceil(
                            settings.stability_resamples
                            * settings.min_valid_stability_fraction
                        )),
                    )
                    if len(scores) < minimum_valid_resamples:
                        rejections.append("insufficient_stability_resamples")
                    candidate_ledger.append({
                        "candidateId": candidate_id,
                        "partitionId": partition_id,
                        "resolution": family,
                        "algorithm": spec["algorithm"],
                        "parameters": spec_payload,
                        "clusterLabel": cluster_id,
                        "memberIndices": indices,
                        "membershipHash": membership_hash,
                        "n": len(indices),
                        "prevalence": float(len(indices) / n_rows),
                        "stability": stability_score,
                        "stabilityResamplesRequested": settings.stability_resamples,
                        "stabilityResamplesValid": len(scores),
                        "stabilityScores": [float(value) for value in scores],
                        "preOutcomeRejectionReasons": rejections,
                    })
                    partition["candidateIds"].append(candidate_id)
            except (
                ValueError,
                RuntimeError,
                FloatingPointError,
                np.linalg.LinAlgError,
            ) as exc:
                partition["status"] = "invalid"
                partition["failure"] = f"{type(exc).__name__}: {exc}"
            partition_ledger.append(partition)

    components, dedupe_ledger = _deduplicate_candidates(
        candidate_ledger,
        embeddings,
        n_rows,
        settings,
    )
    discovery_fingerprint = hashlib.sha256(
        "\x1f".join(
            [
                SCHEMA_VERSION,
                str(asdict(settings)),
                *[
                    f"{family}:{_array_hash(embeddings[family])}"
                    for family in sorted(embeddings)
                ],
                *groups.tolist(),
                *[
                    f"{row['candidateId']}:{row['status']}"
                    for row in sorted(candidate_ledger, key=lambda value: value["candidateId"])
                ],
            ]
        ).encode("utf-8")
    ).hexdigest()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "outcomeBlind": True,
        "n": n_rows,
        "config": asdict(settings),
        "inputHashes": {
            family: _array_hash(embeddings[family])
            for family in sorted(embeddings)
        },
        "partitionLedger": partition_ledger,
        "candidateLedger": candidate_ledger,
        "dedupeLedger": dedupe_ledger,
        "components": components,
        "discoveryFingerprint": discovery_fingerprint,
        "claimBoundary": (
            "Partitions, stability, rejection, Jaccard deduplication, and consensus "
            "support were computed without an outcome."
        ),
    }


def dependency_safe_by(
    rows: list[dict[str, Any]],
    *,
    p_key: str = "p",
    q_key: str = "q",
) -> None:
    """Benjamini-Yekutieli adjustment valid under arbitrary dependence."""

    valid = []
    for index, row in enumerate(rows):
        value = row.get(p_key)
        if value is None:
            continue
        p_value = float(value)
        if not math.isfinite(p_value) or not 0 <= p_value <= 1:
            raise ValueError("p-values must be finite and in [0, 1]")
        valid.append((index, p_value))
    valid.sort(key=lambda item: (item[1], item[0]))
    total = len(valid)
    if not total:
        return
    harmonic = sum(1.0 / rank for rank in range(1, total + 1))
    running = 1.0
    for rank in range(total, 0, -1):
        row_index, p_value = valid[rank - 1]
        running = min(running, p_value * total * harmonic / rank)
        rows[row_index][q_key] = float(min(1.0, running))


def _cluster_robust_difference(
    target: np.ndarray,
    membership: np.ndarray,
    groups: np.ndarray,
) -> tuple[float | None, float | None, float | None]:
    valid = np.isfinite(target)
    y = target[valid].astype(float)
    x = membership[valid].astype(float)
    valid_groups = groups[valid]
    if len(y) < 4 or len(np.unique(x)) < 2:
        return None, None, None
    design = np.column_stack([np.ones(len(y)), x])
    bread = np.linalg.pinv(design.T @ design)
    beta = bread @ design.T @ y
    residual = y - design @ beta
    unique_groups = sorted(set(valid_groups.tolist()))
    if len(unique_groups) < 2:
        return float(beta[1]), None, None
    meat = np.zeros((2, 2), dtype=float)
    for group in unique_groups:
        indices = np.where(valid_groups == group)[0]
        score = design[indices].T @ residual[indices]
        meat += np.outer(score, score)
    covariance = bread @ meat @ bread
    n_rows, parameters = len(y), design.shape[1]
    correction = (
        len(unique_groups) / (len(unique_groups) - 1)
        * (n_rows - 1) / max(1, n_rows - parameters)
    )
    covariance *= correction
    variance = float(max(0.0, covariance[1, 1]))
    standard_error = math.sqrt(variance)
    difference = float(beta[1])
    if standard_error <= EPSILON:
        # A zero sandwich variance is a degenerate estimate, not evidence of
        # certainty. Keep the descriptive difference but exclude it from the
        # inferential family.
        return difference, None, None
    statistic = difference / standard_error
    p_value = float(
        2 * student_t.sf(abs(statistic), df=len(unique_groups) - 1)
    )
    return difference, standard_error, p_value


def _group_bootstrap_differences(
    target: np.ndarray,
    membership: np.ndarray,
    groups: np.ndarray,
    *,
    seed: int,
    repeats: int,
    threshold: float,
) -> tuple[list[float] | None, list[float] | None]:
    valid = np.isfinite(target)
    y = target[valid]
    x = membership[valid]
    valid_groups = groups[valid]
    unique_groups = np.asarray(sorted(set(valid_groups.tolist())), dtype=object)
    if len(unique_groups) < 2:
        return None, None
    by_group = {
        group: np.where(valid_groups == group)[0]
        for group in unique_groups
    }
    continuous: list[float] = []
    binary: list[float] = []
    rng = np.random.default_rng(seed)
    for _ in range(repeats):
        sampled = rng.choice(unique_groups, size=len(unique_groups), replace=True)
        indices = np.concatenate([by_group[group] for group in sampled])
        sampled_x = x[indices]
        if len(np.unique(sampled_x)) < 2:
            continue
        sampled_y = y[indices]
        inside = sampled_y[sampled_x]
        outside = sampled_y[~sampled_x]
        continuous.append(float(np.mean(inside) - np.mean(outside)))
        inside_binary = inside >= threshold
        outside_binary = outside >= threshold
        binary.append(float(np.mean(inside_binary) - np.mean(outside_binary)))
    if len(continuous) < max(10, repeats // 5):
        return None, None
    return (
        [float(value) for value in np.percentile(continuous, [2.5, 97.5])],
        [float(value) for value in np.percentile(binary, [2.5, 97.5])],
    )


def _fold_effects(
    target: np.ndarray,
    membership: np.ndarray,
    folds: np.ndarray,
    *,
    binary: bool,
    pooled_effect: float | None,
    threshold: float,
) -> dict[str, Any]:
    rows = []
    for fold in sorted(set(folds.tolist())):
        valid = (folds == fold) & np.isfinite(target)
        inside = target[valid & membership]
        outside = target[valid & ~membership]
        if not len(inside) or not len(outside):
            continue
        if binary:
            effect = float(
                np.mean(inside >= threshold) - np.mean(outside >= threshold)
            )
        else:
            effect = float(np.mean(inside) - np.mean(outside))
        rows.append({"fold": fold, "effect": effect, "n": int(np.sum(valid))})
    if pooled_effect is None or not rows:
        consistency = None
    elif abs(pooled_effect) <= EPSILON:
        consistency = float(np.mean([abs(row["effect"]) <= EPSILON for row in rows]))
    else:
        direction = math.copysign(1.0, pooled_effect)
        consistency = float(np.mean([
            math.copysign(1.0, row["effect"]) == direction
            if abs(row["effect"]) > EPSILON else False
            for row in rows
        ]))
    return {
        "folds": rows,
        "eligibleFoldCount": len(rows),
        "signConsistency": consistency,
    }


def _calibration_summary(
    actual: np.ndarray,
    predicted: np.ndarray,
    bins: int,
) -> dict[str, Any]:
    order = np.argsort(predicted, kind="mergesort")
    bucket_rows = []
    for bucket_id, indices in enumerate(np.array_split(order, min(bins, len(order)))):
        if not len(indices):
            continue
        bucket_rows.append({
            "bucket": bucket_id,
            "n": int(len(indices)),
            "meanPredicted": float(np.mean(predicted[indices])),
            "observedRate": float(np.mean(actual[indices])),
            "minimumPredicted": float(np.min(predicted[indices])),
            "maximumPredicted": float(np.max(predicted[indices])),
        })
    ece = float(sum(
        row["n"] / len(actual)
        * abs(row["meanPredicted"] - row["observedRate"])
        for row in bucket_rows
    ))
    intercept = slope = None
    if len(np.unique(actual)) == 2 and len(actual) >= 5:
        logits = np.log(
            np.clip(predicted, 1e-6, 1 - 1e-6)
            / np.clip(1 - predicted, 1e-6, 1 - 1e-6)
        ).reshape(-1, 1)
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", ConvergenceWarning)
                warnings.simplefilter("ignore", FutureWarning)
                model = LogisticRegression(
                    penalty=None,
                    solver="lbfgs",
                    max_iter=2000,
                    random_state=DEFAULT_SEED,
                ).fit(logits, actual)
            intercept = float(model.intercept_[0])
            slope = float(model.coef_[0, 0])
        except (ValueError, FloatingPointError):
            pass
    return {
        "intercept": intercept,
        "slope": slope,
        "expectedCalibrationError": ece,
        "bins": bucket_rows,
    }


def _binary_metrics(
    actual: np.ndarray,
    predicted: np.ndarray,
    bins: int,
) -> dict[str, Any]:
    predicted = np.clip(np.asarray(predicted, dtype=float), 1e-6, 1 - 1e-6)
    actual = np.asarray(actual, dtype=int)
    two_classes = len(np.unique(actual)) == 2
    return {
        "n": int(len(actual)),
        "eventRate": float(np.mean(actual)),
        "auc": float(roc_auc_score(actual, predicted)) if two_classes else None,
        "prAuc": (
            float(average_precision_score(actual, predicted))
            if two_classes else None
        ),
        "brier": float(brier_score_loss(actual, predicted)),
        "logLoss": float(log_loss(actual, predicted, labels=[0, 1])),
        "calibration": _calibration_summary(actual, predicted, bins),
    }


def _within_fold_discrimination(
    actual: np.ndarray,
    predicted: np.ndarray,
    folds: np.ndarray,
) -> dict[str, Any]:
    """Aggregate discrimination inside folds so fold base rates cannot rank rows."""

    rows = []
    auc_numerator = 0.0
    auc_denominator = 0.0
    pr_numerator = 0.0
    pr_baseline_numerator = 0.0
    pr_denominator = 0.0
    for fold in sorted(set(folds.tolist())):
        mask = folds == fold
        fold_actual = actual[mask]
        fold_predicted = predicted[mask]
        positives = int(np.sum(fold_actual == 1))
        negatives = int(np.sum(fold_actual == 0))
        if positives < 1 or negatives < 1:
            rows.append({
                "fold": fold,
                "n": int(np.sum(mask)),
                "positives": positives,
                "negatives": negatives,
                "status": "single_class",
            })
            continue
        auc = float(roc_auc_score(fold_actual, fold_predicted))
        pr_auc = float(average_precision_score(fold_actual, fold_predicted))
        event_rate = float(np.mean(fold_actual))
        pair_weight = float(positives * negatives)
        row_weight = float(len(fold_actual))
        auc_numerator += auc * pair_weight
        auc_denominator += pair_weight
        pr_numerator += pr_auc * row_weight
        pr_baseline_numerator += event_rate * row_weight
        pr_denominator += row_weight
        rows.append({
            "fold": fold,
            "n": int(len(fold_actual)),
            "positives": positives,
            "negatives": negatives,
            "status": "ok",
            "auc": auc,
            "prAuc": pr_auc,
            "eventRate": event_rate,
        })
    usable = [row for row in rows if row["status"] == "ok"]
    auc = auc_numerator / auc_denominator if auc_denominator else None
    pr_auc = pr_numerator / pr_denominator if pr_denominator else None
    pr_baseline = (
        pr_baseline_numerator / pr_denominator if pr_denominator else None
    )
    return {
        "protocol": (
            "ROC AUC is weighted by positive-negative pairs inside each held-out "
            "fold. PR AUC and its event-rate baseline are row-weighted inside "
            "held-out folds. Cross-fold base-rate differences cannot create rank skill."
        ),
        "usableFolds": len(usable),
        "totalFolds": len(rows),
        "auc": auc,
        "aucBaseline": 0.5 if auc is not None else None,
        "prAuc": pr_auc,
        "prAucBaseline": pr_baseline,
        "folds": rows,
    }


def _conditional_oof_model(
    component_matrix: np.ndarray,
    target: np.ndarray,
    folds: np.ndarray,
    component_ids: list[str],
    config: PrinciplesConfig,
    target_key: str,
) -> dict[str, Any]:
    valid = np.isfinite(target)
    valid_indices = np.where(valid)[0]
    y = (target[valid] >= config.keep_threshold).astype(int)
    x = component_matrix[valid].astype(float)
    valid_folds = folds[valid]
    unique_folds = sorted(set(valid_folds.tolist()))
    oof = np.full(len(target), np.nan, dtype=float)
    baseline_oof = np.full(len(target), np.nan, dtype=float)
    coefficients: dict[str, list[float]] = {
        component_id: [] for component_id in component_ids
    }
    fold_rows = []
    if len(y) < 5 or len(unique_folds) < 2:
        return {
            "status": "unavailable",
            "reason": "fewer than five finite targets or two populated folds",
            "componentCount": len(component_ids),
            "oofProbability": [None] * len(target),
            "baselineOofProbability": [None] * len(target),
            "metrics": None,
            "baselineMetrics": None,
            "incremental": None,
            "componentEffects": [],
            "folds": [],
        }
    for fold in unique_folds:
        train = np.where(valid_folds != fold)[0]
        test = np.where(valid_folds == fold)[0]
        if not len(train) or not len(test):
            continue
        train_rate = float((np.sum(y[train]) + 0.5) / (len(train) + 1.0))
        baseline_oof[valid_indices[test]] = train_rate
        if x.shape[1] == 0 or len(np.unique(y[train])) < 2:
            prediction = np.full(len(test), train_rate, dtype=float)
            fold_coefficients = np.zeros(x.shape[1], dtype=float)
            mode = "intercept_only"
        else:
            mean = np.mean(x[train], axis=0)
            scale = np.std(x[train], axis=0)
            scale = np.where(scale > EPSILON, scale, 1.0)
            train_x = (x[train] - mean) / scale
            test_x = (x[test] - mean) / scale
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", ConvergenceWarning)
                warnings.simplefilter("ignore", FutureWarning)
                model = LogisticRegression(
                    penalty="l2",
                    C=config.regularization_c,
                    solver="lbfgs",
                    max_iter=2000,
                    random_state=_stable_seed("oof", target_key, fold),
                )
                model.fit(train_x, y[train])
            prediction = model.predict_proba(test_x)[:, 1]
            fold_coefficients = model.coef_[0].astype(float)
            mode = "regularized_components"
        oof[valid_indices[test]] = prediction
        for component_id, coefficient in zip(component_ids, fold_coefficients):
            coefficients[component_id].append(float(coefficient))
        fold_rows.append({
            "fold": fold,
            "trainN": int(len(train)),
            "testN": int(len(test)),
            "trainEventRate": float(np.mean(y[train])),
            "mode": mode,
        })
    predictions = oof[valid]
    baseline_predictions = baseline_oof[valid]
    if not np.all(np.isfinite(predictions)) or not np.all(np.isfinite(baseline_predictions)):
        return {
            "status": "unavailable",
            "reason": "at least one supplied fold could not be predicted",
            "componentCount": len(component_ids),
            "oofProbability": [
                float(value) if math.isfinite(value) else None for value in oof
            ],
            "baselineOofProbability": [
                float(value) if math.isfinite(value) else None for value in baseline_oof
            ],
            "metrics": None,
            "baselineMetrics": None,
            "incremental": None,
            "componentEffects": [],
            "folds": fold_rows,
        }
    metrics = _binary_metrics(y, predictions, config.calibration_bins)
    baseline_metrics = _binary_metrics(
        y,
        baseline_predictions,
        config.calibration_bins,
    )
    discrimination = _within_fold_discrimination(
        y,
        predictions,
        valid_folds,
    )
    effect_rows = []
    for component_id in component_ids:
        values = coefficients[component_id]
        if values:
            mean = float(np.mean(values))
            sign_consistency = float(np.mean([
                math.copysign(1.0, value) == math.copysign(1.0, mean)
                if abs(value) > EPSILON and abs(mean) > EPSILON else False
                for value in values
            ]))
        else:
            mean = None
            sign_consistency = None
        effect_rows.append({
            "componentId": component_id,
            "meanStandardizedLogOddsCoefficient": mean,
            "foldCoefficients": values,
            "foldSignConsistency": sign_consistency,
        })
    return {
        "status": "ok",
        "protocol": (
            "Transductive grouped OOF: outcome-blind geometry is frozen from the "
            "full unlabeled corpus, while L2 model fitting and centering/scaling use "
            "training folds only. No class balancing or outcome-driven feature "
            "selection; this is not prospective deployment validation."
        ),
        "componentCount": len(component_ids),
        "oofProbability": [
            float(value) if math.isfinite(value) else None for value in oof
        ],
        "baselineOofProbability": [
            float(value) if math.isfinite(value) else None for value in baseline_oof
        ],
        "metrics": metrics,
        "baselineMetrics": baseline_metrics,
        "withinFoldDiscrimination": discrimination,
        "incremental": {
            "auc": (
                discrimination["auc"] - discrimination["aucBaseline"]
                if (
                    discrimination["auc"] is not None
                    and discrimination["aucBaseline"] is not None
                )
                else None
            ),
            "prAuc": (
                discrimination["prAuc"] - discrimination["prAucBaseline"]
                if (
                    discrimination["prAuc"] is not None
                    and discrimination["prAucBaseline"] is not None
                )
                else None
            ),
            "brierImprovement": baseline_metrics["brier"] - metrics["brier"],
            "logLossImprovement": baseline_metrics["logLoss"] - metrics["logLoss"],
        },
        "componentEffects": effect_rows,
        "folds": fold_rows,
    }


def _component_matrix(discovery: Mapping[str, Any]) -> tuple[np.ndarray, list[str]]:
    n_rows = int(discovery["n"])
    components = list(discovery.get("components") or [])
    component_ids = [str(component["id"]) for component in components]
    matrix = np.zeros((n_rows, len(components)), dtype=np.uint8)
    for column, component in enumerate(components):
        indices = np.asarray(component["memberIndices"], dtype=int)
        if np.any(indices < 0) or np.any(indices >= n_rows):
            raise ValueError("discovery component contains an invalid member index")
        matrix[indices, column] = 1
    return matrix, component_ids


def analyze_component_outcomes(
    discovery: Mapping[str, Any],
    target_arrays: Mapping[str, Sequence[float]],
    group_ids: Sequence[Any],
    folds: Sequence[Any],
    *,
    config: PrinciplesConfig | None = None,
) -> dict[str, Any]:
    """Estimate grouped effects and conditional OOF models after discovery."""

    if not discovery.get("outcomeBlind"):
        raise ValueError("inference requires a frozen outcome-blind discovery result")
    if discovery.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("unsupported discovery schema")
    settings = config or PrinciplesConfig(**dict(discovery["config"]))
    settings.validate()
    if asdict(settings) != dict(discovery["config"]):
        raise ValueError("inference config must match the frozen discovery config")
    n_rows = int(discovery["n"])
    groups = _validate_groups(group_ids, n_rows)
    fold_array = _validate_folds(folds, groups, n_rows)
    if not target_arrays:
        raise ValueError("at least one target array is required")
    targets: dict[str, np.ndarray] = {}
    for target_key in sorted(target_arrays):
        values = np.asarray(target_arrays[target_key], dtype=float)
        if values.ndim != 1 or len(values) != n_rows:
            raise ValueError(f"{target_key}: target must have one value per row")
        if np.any(np.isinf(values)):
            raise ValueError(f"{target_key}: target contains infinite values")
        targets[str(target_key)] = values.copy()

    matrix, component_ids = _component_matrix(discovery)
    components = {
        str(component["id"]): component
        for component in discovery.get("components") or []
    }
    target_results: dict[str, Any] = {}
    hypothesis_rows: list[dict[str, Any]] = []
    for target_key in sorted(targets):
        target = targets[target_key]
        valid = np.isfinite(target)
        component_rows = []
        for column, component_id in enumerate(component_ids):
            membership = matrix[:, column].astype(bool)
            inside = target[valid & membership]
            outside = target[valid & ~membership]
            if not len(inside) or not len(outside):
                row = {
                    "componentId": component_id,
                    "status": "unavailable",
                    "reason": "no finite target support inside or outside the component",
                }
                component_rows.append(row)
                continue
            continuous_delta, continuous_se, continuous_p = _cluster_robust_difference(
                target,
                membership,
                groups,
            )
            binary_target = np.where(
                np.isfinite(target),
                target >= settings.keep_threshold,
                np.nan,
            )
            risk_delta, risk_se, risk_p = _cluster_robust_difference(
                binary_target.astype(float),
                membership,
                groups,
            )
            continuous_ci, risk_ci = _group_bootstrap_differences(
                target,
                membership,
                groups,
                seed=_stable_seed(
                    "group-bootstrap",
                    discovery["discoveryFingerprint"],
                    target_key,
                    component_id,
                ),
                repeats=settings.bootstrap_repeats,
                threshold=settings.keep_threshold,
            )
            inside_risk = float(np.mean(inside >= settings.keep_threshold))
            outside_risk = float(np.mean(outside >= settings.keep_threshold))
            overall_risk = float(
                np.mean(target[valid] >= settings.keep_threshold)
            )
            pooled_sd = math.sqrt(
                (
                    max(0, len(inside) - 1) * np.var(inside, ddof=1)
                    + max(0, len(outside) - 1) * np.var(outside, ddof=1)
                )
                / max(1, len(inside) + len(outside) - 2)
            ) if len(inside) > 1 and len(outside) > 1 else 0.0
            row = {
                "componentId": component_id,
                "status": "tested",
                "n": int(len(inside)),
                "outsideN": int(len(outside)),
                "support": {
                    "algorithmSupport": components[component_id]["algorithmSupport"],
                    "resolutionSupport": components[component_id]["resolutionSupport"],
                    "stabilitySupport": components[component_id]["stabilitySupport"],
                },
                "continuous": {
                    "insideMean": float(np.mean(inside)),
                    "outsideMean": float(np.mean(outside)),
                    "keepDelta": continuous_delta,
                    "clusterRobustStandardError": continuous_se,
                    "ci95GroupBootstrap": continuous_ci,
                    "standardizedEffect": (
                        float(continuous_delta / pooled_sd)
                        if continuous_delta is not None and pooled_sd > EPSILON
                        else None
                    ),
                    "p": continuous_p,
                    "q": None,
                    "foldValidation": _fold_effects(
                        target,
                        membership,
                        fold_array,
                        binary=False,
                        pooled_effect=continuous_delta,
                        threshold=settings.keep_threshold,
                    ),
                },
                "keepAtLeast85": {
                    "threshold": settings.keep_threshold,
                    "insideRisk": inside_risk,
                    "outsideRisk": outside_risk,
                    "baseRisk": overall_risk,
                    "riskDifference": risk_delta,
                    "clusterRobustStandardError": risk_se,
                    "riskRatio": (
                        float(inside_risk / outside_risk)
                        if outside_risk > 0 else None
                    ),
                    "lift": (
                        float(inside_risk / overall_risk)
                        if overall_risk > 0 else None
                    ),
                    "ci95GroupBootstrap": risk_ci,
                    "p": risk_p,
                    "q": None,
                    "foldValidation": _fold_effects(
                        target,
                        membership,
                        fold_array,
                        binary=True,
                        pooled_effect=risk_delta,
                        threshold=settings.keep_threshold,
                    ),
                },
                "thresholdSensitivity": [],
            }
            for threshold in sorted(set(settings.sensitivity_thresholds)):
                sensitivity_inside = float(np.mean(inside >= threshold))
                sensitivity_outside = float(np.mean(outside >= threshold))
                sensitivity_delta = sensitivity_inside - sensitivity_outside
                row["thresholdSensitivity"].append({
                    "threshold": float(threshold),
                    "insideRisk": sensitivity_inside,
                    "outsideRisk": sensitivity_outside,
                    "riskDifference": sensitivity_delta,
                    "foldValidation": _fold_effects(
                        target,
                        membership,
                        fold_array,
                        binary=True,
                        pooled_effect=sensitivity_delta,
                        threshold=float(threshold),
                    ),
                    "descriptiveOnly": True,
                })
            component_rows.append(row)
            for test_key, section in (
                ("continuous", row["continuous"]),
                ("keepAtLeast85", row["keepAtLeast85"]),
            ):
                if section["p"] is not None:
                    hypothesis_rows.append({
                        "p": section["p"],
                        "target": target_key,
                        "componentId": component_id,
                        "test": test_key,
                        "section": section,
                    })
        target_results[target_key] = {
            "finiteN": int(np.sum(valid)),
            "eventRate85": (
                float(np.mean(target[valid] >= settings.keep_threshold))
                if np.any(valid) else None
            ),
            "components": component_rows,
            "conditionalModel": _conditional_oof_model(
                matrix,
                target,
                fold_array,
                component_ids,
                settings,
                target_key,
            ),
        }

    dependency_safe_by(hypothesis_rows)
    for hypothesis in hypothesis_rows:
        hypothesis["section"]["q"] = hypothesis["q"]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "discoveryFingerprint": discovery["discoveryFingerprint"],
        "threshold": settings.keep_threshold,
        "targets": target_results,
        "multipleTesting": {
            "method": "Benjamini-Yekutieli across every component, target, and effect test",
            "dependencySafe": True,
            "hypothesisCount": len(hypothesis_rows),
        },
        "claimBoundary": (
            "These are associations with supplied target arrays. If a supplied keep "
            "array is projected, every effect and validation metric remains surrogate-only."
        ),
    }


def extract_phrase_candidates(
    text_rows: Sequence[Any],
    *,
    min_tokens: int = 1,
    max_tokens: int = 6,
    min_document_frequency: int = 2,
) -> list[dict[str, Any]]:
    """Extract deterministic contiguous phrase candidates without semantic labels."""

    if not 1 <= min_tokens <= max_tokens:
        raise ValueError("phrase token limits are invalid")
    if min_document_frequency < 1:
        raise ValueError("min_document_frequency must be positive")
    documents: list[list[str]] = []
    token_pattern = re.compile(r"[^\W_]+(?:'[^\W_]+)?", flags=re.UNICODE)
    for row in text_rows:
        text = _row_text(row).lower()
        documents.append(token_pattern.findall(text))
    document_frequency: dict[str, int] = {}
    occurrence_count: dict[str, int] = {}
    for tokens in documents:
        in_document = set()
        for width in range(min_tokens, max_tokens + 1):
            for start in range(0, len(tokens) - width + 1):
                phrase = " ".join(tokens[start:start + width])
                occurrence_count[phrase] = occurrence_count.get(phrase, 0) + 1
                in_document.add(phrase)
        for phrase in in_document:
            document_frequency[phrase] = document_frequency.get(phrase, 0) + 1
    rows = [
        {
            "text": phrase,
            "tokenCount": len(phrase.split()),
            "documentFrequency": document_frequency[phrase],
            "occurrenceCount": occurrence_count[phrase],
        }
        for phrase in document_frequency
        if document_frequency[phrase] >= min_document_frequency
    ]
    rows.sort(key=lambda row: (
        -row["documentFrequency"],
        -row["occurrenceCount"],
        row["tokenCount"],
        row["text"],
    ))
    return rows


def select_component_labels(
    discovery: Mapping[str, Any],
    phrase_candidates: Sequence[str | Mapping[str, Any]],
    phrase_embedding_vectors: Mapping[str, np.ndarray],
    *,
    top_n: int = 3,
) -> dict[str, dict[str, Any]]:
    """Select descriptive labels by centroid cosine in supplied embedding spaces."""

    if top_n < 1:
        raise ValueError("top_n must be positive")
    phrases = [
        _normalize_text(
            candidate.get("text") if isinstance(candidate, Mapping) else candidate
        )
        for candidate in phrase_candidates
    ]
    if not phrases or any(not phrase for phrase in phrases):
        raise ValueError("phrase candidates must be non-empty")
    if len(set(phrases)) != len(phrases):
        raise ValueError("phrase candidates must be unique")
    normalized_phrase_vectors: dict[str, np.ndarray] = {}
    for resolution in sorted(phrase_embedding_vectors):
        vectors = np.asarray(phrase_embedding_vectors[resolution], dtype=float)
        if vectors.ndim != 2 or len(vectors) != len(phrases):
            raise ValueError(
                f"{resolution}: phrase vectors must align one-to-one with candidates"
            )
        normalized_phrase_vectors[str(resolution)] = normalize_rows(vectors)

    labels: dict[str, dict[str, Any]] = {}
    for component in discovery.get("components") or []:
        score_rows = []
        for resolution, center_values in sorted(
            (component.get("centroidsByResolution") or {}).items()
        ):
            if resolution not in normalized_phrase_vectors:
                continue
            center = np.asarray(center_values, dtype=float)
            vectors = normalized_phrase_vectors[resolution]
            if vectors.shape[1] != len(center):
                raise ValueError(
                    f"{resolution}: phrase and component embedding dimensions differ"
                )
            center /= np.linalg.norm(center) or 1.0
            score_rows.append(vectors @ center)
        if not score_rows:
            labels[str(component["id"])] = {
                "label": None,
                "candidates": [],
                "reason": "no supplied phrase embedding space matches this component",
            }
            continue
        scores = np.mean(np.vstack(score_rows), axis=0)
        ordered = sorted(
            range(len(phrases)),
            key=lambda index: (-float(scores[index]), phrases[index]),
        )[:top_n]
        candidates = [
            {"text": phrases[index], "cosine": float(scores[index])}
            for index in ordered
        ]
        labels[str(component["id"])] = {
            "label": candidates[0]["text"],
            "candidates": candidates,
            "resolutionCount": len(score_rows),
            "method": "mean centroid cosine across supplied matching resolutions",
        }
    return labels


def run_principles_analysis(
    embedding_families: Mapping[str, np.ndarray],
    text_rows: Sequence[Any],
    target_arrays: Mapping[str, Sequence[float]],
    group_ids: Sequence[Any],
    folds: Sequence[Any],
    *,
    config: PrinciplesConfig | None = None,
    phrase_candidates: Sequence[str | Mapping[str, Any]] | None = None,
    phrase_embedding_vectors: Mapping[str, np.ndarray] | None = None,
) -> dict[str, Any]:
    """Run the bounded discovery-first pipeline without mutating any input."""

    settings = config or PrinciplesConfig()
    discovery = discover_components(
        embedding_families,
        group_ids,
        config=settings,
    )
    if len(text_rows) != int(discovery["n"]):
        raise ValueError("text row count does not match embedding rows")
    extracted_phrases = extract_phrase_candidates(
        text_rows,
        min_tokens=settings.phrase_min_tokens,
        max_tokens=settings.phrase_max_tokens,
        min_document_frequency=settings.phrase_min_document_frequency,
    )
    labels = {}
    if phrase_embedding_vectors is not None:
        if phrase_candidates is None:
            raise ValueError(
                "phrase_candidates are required when phrase vectors are supplied"
            )
        labels = select_component_labels(
            discovery,
            phrase_candidates,
            phrase_embedding_vectors,
        )
    inference = analyze_component_outcomes(
        discovery,
        target_arrays,
        group_ids,
        folds,
        config=settings,
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "discovery": discovery,
        "phraseCandidates": extracted_phrases,
        "componentLabels": labels,
        "inference": inference,
    }


__all__ = [
    "PrinciplesConfig",
    "SCHEMA_VERSION",
    "analyze_component_outcomes",
    "dependency_safe_by",
    "discover_components",
    "extract_phrase_candidates",
    "jaccard_indices",
    "normalize_rows",
    "run_principles_analysis",
    "select_component_labels",
]
