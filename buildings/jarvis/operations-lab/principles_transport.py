#!/usr/bin/env python3
"""Deterministic, outcome-blind transport validation for semantic principles.

The module deliberately separates geometry from outcomes:

* pooled geometry uses only embeddings and frozen saved-hook memberships;
* projected keep is reported only as a circular surrogate association; and
* observed keep is reported as a disjoint-ID, small-tail diagnostic and can
  earn only a directional-consistency label under preregistered criteria.

It performs no file or network I/O and imports no Business World project code.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

import numpy as np


SCHEMA_VERSION = "operations-principles-transport-v1"
EPSILON = 1e-12


@dataclass(frozen=True)
class TransportConfig:
    """Pre-outcome settings for transport geometry and grouped inference."""

    k_values: tuple[int, ...] = (4, 8, 16, 32)
    seeds: tuple[int, ...] = (17, 53, 101)
    algorithms: tuple[str, ...] = (
        "spherical_kmeans",
        "farthest_anchor_voronoi",
    )
    max_iterations: int = 80
    convergence_tolerance: float = 1e-9
    min_match_jaccard: float = 0.35
    min_match_rows: int = 8
    min_match_precision: float = 0.50
    min_match_recall: float = 0.50
    min_robust_partitions: int = 2
    bootstrap_repeats: int = 500
    bootstrap_seed: int = 20260724
    min_effect_rows: int = 8
    min_threshold_events: int = 4
    min_observed_groups: int = 4
    min_observed_folds: int = 3
    min_bootstrap_valid_fraction: float = 0.80
    fold_count: int = 5
    overlap_vector_tolerance: float = 1e-6
    keep_threshold: float = 85.0

    def validate(self) -> None:
        supported = {"spherical_kmeans", "farthest_anchor_voronoi"}
        if not self.k_values or any(int(value) < 2 for value in self.k_values):
            raise ValueError("k_values must contain integers of at least two")
        if not self.seeds:
            raise ValueError("at least one deterministic seed is required")
        if not self.algorithms or any(value not in supported for value in self.algorithms):
            raise ValueError("algorithms contains an unsupported partition method")
        if self.max_iterations < 1:
            raise ValueError("max_iterations must be positive")
        if self.convergence_tolerance < 0:
            raise ValueError("convergence_tolerance must be non-negative")
        if not 0 <= self.min_match_jaccard <= 1:
            raise ValueError("min_match_jaccard must be in [0, 1]")
        if self.min_match_rows < 1:
            raise ValueError("min_match_rows must be positive")
        if not 0 <= self.min_match_precision <= 1:
            raise ValueError("min_match_precision must be in [0, 1]")
        if not 0 <= self.min_match_recall <= 1:
            raise ValueError("min_match_recall must be in [0, 1]")
        if self.min_robust_partitions < 1:
            raise ValueError("min_robust_partitions must be positive")
        if self.bootstrap_repeats < 20:
            raise ValueError("bootstrap_repeats must be at least 20")
        if self.min_effect_rows < 1:
            raise ValueError("min_effect_rows must be positive")
        if self.min_threshold_events < 1:
            raise ValueError("min_threshold_events must be positive")
        if self.min_observed_groups < 4:
            raise ValueError("min_observed_groups must be at least four")
        if self.min_observed_folds < 2:
            raise ValueError("min_observed_folds must be at least two")
        if not 0.5 <= self.min_bootstrap_valid_fraction <= 1:
            raise ValueError("min_bootstrap_valid_fraction must be in [0.5, 1]")
        if self.fold_count < 2:
            raise ValueError("fold_count must be at least two")
        if self.overlap_vector_tolerance < 0:
            raise ValueError("overlap_vector_tolerance must be non-negative")
        if not 0 <= self.keep_threshold <= 100:
            raise ValueError("keep_threshold must be in [0, 100]")


@dataclass
class _GeometryState:
    public: dict[str, Any]
    source_ids: dict[str, np.ndarray]
    source_groups: dict[str, np.ndarray]
    source_orders: dict[str, np.ndarray]
    principle_masks: dict[str, dict[str, np.ndarray]]


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    """Return a finite L2-normalized float64 copy."""

    values = np.asarray(matrix, dtype=np.float64)
    if values.ndim != 2 or values.shape[1] < 1:
        raise ValueError("embedding matrix must have shape (rows, dimensions)")
    if not np.all(np.isfinite(values)):
        raise ValueError("embedding matrix contains non-finite values")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if np.any(norms <= EPSILON):
        raise ValueError("embedding matrix contains a zero-norm row")
    return values / norms


def _array_hash(values: np.ndarray) -> str:
    array = np.ascontiguousarray(np.asarray(values, dtype="<f8"))
    digest = hashlib.sha256()
    digest.update(str(array.shape).encode("ascii"))
    digest.update(array.tobytes())
    return digest.hexdigest()


def _string_hash(values: Sequence[Any]) -> str:
    digest = hashlib.sha256()
    for value in values:
        encoded = str(value).encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def _mask_hash(mask: np.ndarray) -> str:
    values = np.asarray(mask, dtype=np.uint8)
    digest = hashlib.sha256()
    digest.update(str(values.shape).encode("ascii"))
    digest.update(np.packbits(values).tobytes())
    return digest.hexdigest()


def _stable_seed(*parts: Any) -> int:
    payload = "\x1f".join(str(part) for part in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big") % (2**32 - 1)


def _validate_ids(
    values: Sequence[Any] | None,
    n_rows: int,
    source: str,
) -> tuple[np.ndarray, bool]:
    supplied = values is not None
    if values is None:
        result = np.asarray(
            [f"__{source}_row_{index:08d}" for index in range(n_rows)],
            dtype=object,
        )
    else:
        if len(values) != n_rows:
            raise ValueError(f"{source} ID count does not match embedding rows")
        result = np.asarray([str(value).strip() for value in values], dtype=object)
        if any(not value for value in result):
            raise ValueError(f"{source} IDs must be non-empty")
        if len(set(result.tolist())) != n_rows:
            raise ValueError(f"{source} IDs must be unique")
    return result, supplied


def _validate_groups(
    values: Sequence[Any],
    n_rows: int,
    source: str,
) -> np.ndarray:
    if len(values) != n_rows:
        raise ValueError(f"{source} group count does not match embedding rows")
    result = np.asarray([str(value).strip() for value in values], dtype=object)
    if any(not value for value in result):
        raise ValueError(f"{source} group IDs must be non-empty")
    return result


def _validate_keep(
    values: Sequence[float] | np.ndarray,
    n_rows: int,
    name: str,
) -> np.ndarray:
    result = np.asarray(values, dtype=np.float64)
    if result.ndim != 1 or len(result) != n_rows:
        raise ValueError(f"{name} must contain exactly {n_rows} values")
    if not np.all(np.isfinite(result)):
        raise ValueError(f"{name} contains non-finite values")
    if np.any((result < 0) | (result > 100)):
        raise ValueError(f"{name} values must be in [0, 100]")
    return result


def _validate_projected_map(
    values: Mapping[Any, float] | None,
) -> dict[str, float] | None:
    if values is None:
        return None
    if not isinstance(values, Mapping):
        raise ValueError("broad projected keep must be a mapping joined by exact ID")
    result: dict[str, float] = {}
    for raw_id, raw_value in values.items():
        row_id = str(raw_id).strip()
        if not row_id:
            raise ValueError("broad projected keep contains an empty ID")
        if row_id in result:
            raise ValueError("broad projected keep contains duplicate normalized IDs")
        value = float(raw_value)
        if not math.isfinite(value) or value < 0 or value > 100:
            raise ValueError("broad projected keep values must be finite and in [0, 100]")
        result[row_id] = value
    return result


def _canonical_order(ids: np.ndarray) -> np.ndarray:
    return np.asarray(
        sorted(range(len(ids)), key=lambda index: (str(ids[index]), index)),
        dtype=int,
    )


def _membership_mask(
    membership: Any,
    original_saved_ids: np.ndarray,
) -> np.ndarray:
    if isinstance(membership, Mapping):
        keys = [key for key in ("mask", "memberIndices", "memberIds") if key in membership]
        if len(keys) != 1:
            raise ValueError(
                "principle membership mappings need exactly one of "
                "mask, memberIndices, or memberIds"
            )
        membership = membership[keys[0]]

    values = list(membership)
    if len(values) == len(original_saved_ids) and all(
        isinstance(value, (bool, np.bool_)) for value in values
    ):
        mask = np.asarray(values, dtype=bool)
    elif all(isinstance(value, (int, np.integer)) and not isinstance(value, bool) for value in values):
        mask = np.zeros(len(original_saved_ids), dtype=bool)
        indices = np.asarray(values, dtype=int)
        if np.any((indices < 0) | (indices >= len(mask))):
            raise ValueError("principle membership contains an out-of-range saved index")
        mask[indices] = True
    else:
        requested = {str(value).strip() for value in values}
        if "" in requested:
            raise ValueError("principle membership contains an empty saved ID")
        available = set(original_saved_ids.tolist())
        unknown = requested - available
        if unknown:
            example = sorted(unknown)[0]
            raise ValueError(f"principle membership references unknown saved ID {example!r}")
        mask = np.asarray(
            [row_id in requested for row_id in original_saved_ids],
            dtype=bool,
        )
    if not np.any(mask):
        raise ValueError("principle membership must contain at least one saved hook")
    return mask


def _farthest_anchors(values: np.ndarray, k: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    first = int(rng.integers(0, len(values)))
    selected = [first]
    centers = [values[first]]
    while len(selected) < k:
        similarities = values @ np.vstack(centers).T
        nearest_similarity = np.max(similarities, axis=1)
        nearest_similarity[np.asarray(selected, dtype=int)] = np.inf
        chosen = int(np.argmin(nearest_similarity))
        if not math.isfinite(float(nearest_similarity[chosen])):
            raise ValueError("insufficient distinct vectors for requested k")
        selected.append(chosen)
        centers.append(values[chosen])
    return np.asarray(selected, dtype=int)


def _farthest_anchor_voronoi(values: np.ndarray, k: int, seed: int) -> np.ndarray:
    anchors = _farthest_anchors(values, k, seed)
    return np.argmax(values @ values[anchors].T, axis=1).astype(int)


def _spherical_kmeans(
    values: np.ndarray,
    k: int,
    seed: int,
    max_iterations: int,
    tolerance: float,
) -> tuple[np.ndarray, int]:
    anchors = _farthest_anchors(values, k, seed)
    centers = values[anchors].copy()
    labels = np.full(len(values), -1, dtype=int)
    for iteration in range(1, max_iterations + 1):
        similarities = values @ centers.T
        next_labels = np.argmax(similarities, axis=1).astype(int)
        counts = np.bincount(next_labels, minlength=k)
        if np.any(counts == 0):
            confidence = np.max(similarities, axis=1)
            for empty in np.where(counts == 0)[0]:
                candidates = [
                    int(index)
                    for index in np.argsort(confidence, kind="stable")
                    if counts[next_labels[index]] > 1
                ]
                if not candidates:
                    raise ValueError("cannot repair an empty spherical cluster")
                replacement = candidates[0]
                counts[next_labels[replacement]] -= 1
                next_labels[replacement] = int(empty)
                counts[empty] += 1
        next_centers = np.empty_like(centers)
        for cluster_id in range(k):
            center = np.mean(values[next_labels == cluster_id], axis=0)
            norm = float(np.linalg.norm(center))
            if norm <= EPSILON:
                center = values[np.where(next_labels == cluster_id)[0][0]]
                norm = float(np.linalg.norm(center))
            next_centers[cluster_id] = center / norm
        shift = float(np.max(np.linalg.norm(next_centers - centers, axis=1)))
        stable_labels = np.array_equal(labels, next_labels)
        labels = next_labels
        centers = next_centers
        if stable_labels or shift <= tolerance:
            return labels, iteration
    return labels, max_iterations


def _jaccard(left: np.ndarray, right: np.ndarray) -> tuple[float, int, int]:
    intersection = int(np.sum(left & right))
    union = int(np.sum(left | right))
    return (float(intersection / union) if union else 1.0, intersection, union)


def _prevalence(
    membership: np.ndarray,
    groups: np.ndarray,
    repeats: int,
    seed: int,
) -> dict[str, Any]:
    n_rows = len(membership)
    rate = float(np.mean(membership)) if n_rows else None
    unique_groups, inverse = np.unique(groups, return_inverse=True)
    samples: list[float] = []
    if n_rows and len(unique_groups) >= 2:
        group_rows = np.bincount(inverse).astype(np.float64)
        group_members = np.bincount(
            inverse, weights=membership.astype(np.float64)
        )
        rng = np.random.default_rng(seed)
        for _ in range(repeats):
            selected = rng.integers(0, len(unique_groups), size=len(unique_groups))
            samples.append(float(
                np.sum(group_members[selected]) / np.sum(group_rows[selected])
            ))
    return {
        "n": int(n_rows),
        "memberCount": int(np.sum(membership)),
        "prevalence": rate,
        "uniqueGroups": int(len(unique_groups)),
        "ci95GroupedBootstrap": (
            [float(value) for value in np.percentile(samples, [2.5, 97.5])]
            if len(samples) >= 20
            else None
        ),
        "bootstrapValidRepeats": int(len(samples)),
    }


def _balanced_group_folds(groups: np.ndarray, fold_count: int) -> dict[str, int]:
    unique = sorted(
        set(groups.tolist()),
        key=lambda group: (hashlib.sha256(group.encode("utf-8")).hexdigest(), group),
    )
    count = min(fold_count, len(unique))
    return {group: index % count for index, group in enumerate(unique)} if count else {}


def _raw_effect(values: np.ndarray, membership: np.ndarray) -> float | None:
    inside = values[membership]
    outside = values[~membership]
    if not len(inside) or not len(outside):
        return None
    return float(np.mean(inside) - np.mean(outside))


def _fold_sign_consistency(
    values: np.ndarray,
    membership: np.ndarray,
    groups: np.ndarray,
    reference_effect: float,
    fold_count: int,
) -> dict[str, Any]:
    assignments = _balanced_group_folds(groups, fold_count)
    fold_effects: list[dict[str, Any]] = []
    for fold_id in sorted(set(assignments.values())):
        fold_mask = np.asarray(
            [assignments[group] == fold_id for group in groups],
            dtype=bool,
        )
        effect = _raw_effect(values[fold_mask], membership[fold_mask])
        if effect is not None:
            fold_effects.append({
                "fold": int(fold_id),
                "n": int(np.sum(fold_mask)),
                "effect": float(effect),
            })
    if abs(reference_effect) <= EPSILON or not fold_effects:
        consistency = None
    else:
        sign = 1 if reference_effect > 0 else -1
        consistency = float(np.mean([
            (row["effect"] > 0) == (sign > 0) and abs(row["effect"]) > EPSILON
            for row in fold_effects
        ]))
    return {
        "groupAssigned": True,
        "foldsRequested": int(fold_count),
        "foldsUsable": int(len(fold_effects)),
        "referenceSign": (
            "positive" if reference_effect > EPSILON
            else "negative" if reference_effect < -EPSILON
            else "zero"
        ),
        "consistentFraction": consistency,
        "foldEffects": fold_effects,
    }


def _group_bootstrap_effects(
    values: np.ndarray,
    membership: np.ndarray,
    groups: np.ndarray,
    threshold: float,
    repeats: int,
    seed: int,
) -> tuple[list[float], list[float]]:
    unique_groups, inverse = np.unique(groups, return_inverse=True)
    if len(unique_groups) < 2:
        return [], []
    inside = membership.astype(np.float64)
    outside = 1.0 - inside
    event = (values >= threshold).astype(np.float64)
    group_inside_n = np.bincount(inverse, weights=inside)
    group_outside_n = np.bincount(inverse, weights=outside)
    group_inside_sum = np.bincount(inverse, weights=values * inside)
    group_outside_sum = np.bincount(inverse, weights=values * outside)
    group_inside_hits = np.bincount(inverse, weights=event * inside)
    group_outside_hits = np.bincount(inverse, weights=event * outside)
    rng = np.random.default_rng(seed)
    continuous: list[float] = []
    threshold_effects: list[float] = []
    for _ in range(repeats):
        selected = rng.integers(0, len(unique_groups), size=len(unique_groups))
        inside_n = float(np.sum(group_inside_n[selected]))
        outside_n = float(np.sum(group_outside_n[selected]))
        if inside_n <= 0 or outside_n <= 0:
            continue
        continuous.append(float(
            np.sum(group_inside_sum[selected]) / inside_n
            - np.sum(group_outside_sum[selected]) / outside_n
        ))
        threshold_effects.append(float(
            np.sum(group_inside_hits[selected]) / inside_n
            - np.sum(group_outside_hits[selected]) / outside_n
        ))
    return continuous, threshold_effects


def _association(
    values: np.ndarray,
    membership: np.ndarray,
    groups: np.ndarray,
    config: TransportConfig,
    seed_namespace: str,
) -> dict[str, Any]:
    inside = values[membership]
    outside = values[~membership]
    n_inside = len(inside)
    n_outside = len(outside)
    base = {
        "n": int(len(values)),
        "nInside": int(n_inside),
        "nOutside": int(n_outside),
        "uniqueGroups": int(len(set(groups.tolist()))),
    }
    if n_inside < config.min_effect_rows or n_outside < config.min_effect_rows:
        reason = (
            f"need at least {config.min_effect_rows} labeled rows both inside "
            "and outside the transported cluster"
        )
        return {
            **base,
            "status": "insufficient_support",
            "reason": reason,
            "continuous": {"status": "insufficient_support", "reason": reason},
            "keepAtLeast85": {
                "status": "insufficient_support",
                "threshold": float(config.keep_threshold),
                "reason": reason,
            },
        }

    continuous_effect = float(np.mean(inside) - np.mean(outside))
    event = values >= config.keep_threshold
    event_inside = event[membership]
    event_outside = event[~membership]
    rate_inside = float(np.mean(event_inside))
    rate_outside = float(np.mean(event_outside))
    risk_difference = rate_inside - rate_outside
    event_count = int(np.sum(event))
    non_event_count = int(len(event) - event_count)
    continuous_samples, threshold_samples = _group_bootstrap_effects(
        values,
        membership,
        groups,
        config.keep_threshold,
        config.bootstrap_repeats,
        _stable_seed(config.bootstrap_seed, seed_namespace),
    )
    minimum_valid_bootstraps = int(math.ceil(
        config.bootstrap_repeats * config.min_bootstrap_valid_fraction
    ))
    continuous = {
        "status": "ok",
        "meanInside": float(np.mean(inside)),
        "meanOutside": float(np.mean(outside)),
        "meanDifference": continuous_effect,
        "ci95GroupedBootstrap": (
            [float(value) for value in np.percentile(continuous_samples, [2.5, 97.5])]
            if len(continuous_samples) >= minimum_valid_bootstraps
            else None
        ),
        "bootstrapValidRepeats": int(len(continuous_samples)),
        "bootstrapRequiredRepeats": minimum_valid_bootstraps,
        "foldSignConsistency": _fold_sign_consistency(
            values,
            membership,
            groups,
            continuous_effect,
            config.fold_count,
        ),
    }
    if (
        event_count < config.min_threshold_events
        or non_event_count < config.min_threshold_events
    ):
        threshold_result = {
            "status": "insufficient_support",
            "threshold": float(config.keep_threshold),
            "hits": event_count,
            "nonHits": non_event_count,
            "reason": (
                f"need at least {config.min_threshold_events} total hits and "
                "non-hits for threshold inference"
            ),
        }
    else:
        inside_hits = int(np.sum(event_inside))
        outside_hits = int(np.sum(event_outside))
        inside_misses = n_inside - inside_hits
        outside_misses = n_outside - outside_hits
        risk_ratio = (
            float(rate_inside / rate_outside)
            if rate_outside > EPSILON
            else None
        )
        odds_ratio = float(
            ((inside_hits + 0.5) * (outside_misses + 0.5))
            / ((inside_misses + 0.5) * (outside_hits + 0.5))
        )
        threshold_result = {
            "status": "ok",
            "threshold": float(config.keep_threshold),
            "hitsInside": inside_hits,
            "hitsOutside": outside_hits,
            "rateInside": rate_inside,
            "rateOutside": rate_outside,
            "riskDifference": risk_difference,
            "riskRatio": risk_ratio,
            "oddsRatioHaldane": odds_ratio,
            "ci95RiskDifferenceGroupedBootstrap": (
                [float(value) for value in np.percentile(threshold_samples, [2.5, 97.5])]
                if len(threshold_samples) >= minimum_valid_bootstraps
                else None
            ),
            "bootstrapValidRepeats": int(len(threshold_samples)),
            "bootstrapRequiredRepeats": minimum_valid_bootstraps,
            "foldSignConsistency": _fold_sign_consistency(
                event.astype(np.float64),
                membership,
                groups,
                risk_difference,
                config.fold_count,
            ),
        }
    return {
        **base,
        "status": "ok",
        "continuous": continuous,
        "keepAtLeast85": threshold_result,
    }


def _prepare_geometry(
    saved_visual_previews: np.ndarray,
    saved_group_ids: Sequence[Any],
    broad_visual_vectors: np.ndarray,
    broad_ids: Sequence[Any],
    broad_group_ids: Sequence[Any],
    observed_visual_vectors: np.ndarray,
    observed_group_ids: Sequence[Any],
    principle_memberships: Mapping[str, Any],
    saved_ids: Sequence[Any] | None,
    observed_ids: Sequence[Any] | None,
    config: TransportConfig,
) -> _GeometryState:
    saved_raw = np.asarray(saved_visual_previews, dtype=np.float64)
    broad_raw = np.asarray(broad_visual_vectors, dtype=np.float64)
    observed_raw = np.asarray(observed_visual_vectors, dtype=np.float64)
    if saved_raw.ndim != 2 or saved_raw.shape[1] < 1:
        raise ValueError("saved visual previews must have shape (rows, dimensions)")
    dimensions = int(saved_raw.shape[1])
    for name, values in (("broad", broad_raw), ("observed", observed_raw)):
        if values.ndim != 2:
            raise ValueError(f"{name} visual vectors must be two-dimensional")
        if values.shape[1] < dimensions:
            raise ValueError(
                f"{name} visual vectors have {values.shape[1]} dimensions; "
                f"at least {dimensions} are required"
            )
    if not isinstance(principle_memberships, Mapping) or not principle_memberships:
        raise ValueError("at least one frozen semantic principle is required")

    saved_vectors = normalize_rows(saved_raw)
    broad_vectors = normalize_rows(broad_raw[:, :dimensions])
    observed_vectors = normalize_rows(observed_raw[:, :dimensions])
    source_vectors_original = {
        "saved": saved_vectors,
        "broad": broad_vectors,
        "observed": observed_vectors,
    }

    saved_id_values, saved_ids_supplied = _validate_ids(
        saved_ids, len(saved_vectors), "saved"
    )
    broad_id_values, broad_ids_supplied = _validate_ids(
        broad_ids, len(broad_vectors), "broad"
    )
    observed_id_values, observed_ids_supplied = _validate_ids(
        observed_ids, len(observed_vectors), "observed"
    )
    if not broad_ids_supplied:
        raise ValueError("broad IDs are required for exact-ID projected score joins")
    if len(observed_vectors) and (not saved_ids_supplied or not observed_ids_supplied):
        raise ValueError(
            "saved and observed IDs are required to prove diagnostic disjointness"
        )
    saved_observed_overlap = set(saved_id_values.tolist()) & set(
        observed_id_values.tolist()
    )
    if saved_observed_overlap:
        raise ValueError(
            "observed diagnostics must be exact-ID disjoint from discovery hooks"
        )
    source_ids_original = {
        "saved": saved_id_values,
        "broad": broad_id_values,
        "observed": observed_id_values,
    }
    source_groups_original = {
        "saved": _validate_groups(saved_group_ids, len(saved_vectors), "saved"),
        "broad": _validate_groups(broad_group_ids, len(broad_vectors), "broad"),
        "observed": _validate_groups(
            observed_group_ids, len(observed_vectors), "observed"
        ),
    }
    source_orders = {
        source: _canonical_order(ids)
        for source, ids in source_ids_original.items()
    }
    source_ids = {
        source: ids[source_orders[source]]
        for source, ids in source_ids_original.items()
    }
    source_groups = {
        source: groups[source_orders[source]]
        for source, groups in source_groups_original.items()
    }
    source_vectors = {
        source: values[source_orders[source]]
        for source, values in source_vectors_original.items()
    }

    saved_memberships: dict[str, np.ndarray] = {}
    for raw_name in sorted(principle_memberships, key=str):
        name = str(raw_name).strip()
        if not name:
            raise ValueError("semantic principle names must be non-empty")
        if name in saved_memberships:
            raise ValueError("semantic principle names must be unique")
        original_mask = _membership_mask(
            principle_memberships[raw_name],
            source_ids_original["saved"],
        )
        saved_memberships[name] = original_mask[source_orders["saved"]]

    vectors_by_id: dict[str, np.ndarray] = {}
    source_pool_ids: dict[str, list[str]] = {
        "saved": [], "broad": [], "observed": []
    }
    for source in ("saved", "broad", "observed"):
        for row_id, vector in zip(source_ids[source], source_vectors[source]):
            row_id = str(row_id)
            if row_id in vectors_by_id:
                if not np.allclose(
                    vectors_by_id[row_id],
                    vector,
                    rtol=0,
                    atol=config.overlap_vector_tolerance,
                ):
                    raise ValueError(
                        f"overlapping ID {row_id!r} has inconsistent shared vectors"
                    )
            else:
                vectors_by_id[row_id] = vector
            source_pool_ids[source].append(row_id)
    pooled_ids = np.asarray(sorted(vectors_by_id), dtype=object)
    pooled_vectors = np.vstack([vectors_by_id[row_id] for row_id in pooled_ids])
    pooled_lookup = {row_id: index for index, row_id in enumerate(pooled_ids)}
    source_to_pool = {
        source: np.asarray(
            [pooled_lookup[row_id] for row_id in source_pool_ids[source]],
            dtype=int,
        )
        for source in source_pool_ids
    }

    unique_support = int(
        np.unique(np.round(pooled_vectors, decimals=12), axis=0).shape[0]
    )
    partition_states: list[dict[str, Any]] = []
    partition_ledger: list[dict[str, Any]] = []
    for k in sorted(set(int(value) for value in config.k_values)):
        for algorithm in config.algorithms:
            for seed in sorted(set(int(value) for value in config.seeds)):
                partition_id = (
                    f"{algorithm}-k{k}-s{seed}"
                )
                ledger = {
                    "partitionId": partition_id,
                    "algorithm": algorithm,
                    "k": int(k),
                    "seed": int(seed),
                    "outcomeBlind": True,
                }
                if k >= len(pooled_vectors) or k > unique_support:
                    partition_ledger.append({
                        **ledger,
                        "status": "invalid",
                        "reason": "k exceeds pooled row or unique-vector support",
                    })
                    continue
                try:
                    if algorithm == "spherical_kmeans":
                        labels, iterations = _spherical_kmeans(
                            pooled_vectors,
                            k,
                            seed,
                            config.max_iterations,
                            config.convergence_tolerance,
                        )
                    else:
                        labels = _farthest_anchor_voronoi(
                            pooled_vectors, k, seed
                        )
                        iterations = 1
                except (ValueError, FloatingPointError, np.linalg.LinAlgError) as exc:
                    partition_ledger.append({
                        **ledger,
                        "status": "invalid",
                        "reason": str(exc),
                    })
                    continue
                sizes = np.bincount(labels, minlength=k)
                completed = {
                    **ledger,
                    "status": "tested",
                    "clusterCount": int(len(np.unique(labels))),
                    "clusterSizes": [int(value) for value in sizes],
                    "iterations": int(iterations),
                    "labelsHash": _array_hash(labels.reshape(-1, 1)),
                }
                partition_ledger.append(completed)
                partition_states.append({
                    "partitionId": partition_id,
                    "labels": labels,
                    "ledger": completed,
                })
    if not partition_states:
        raise ValueError("no valid outcome-blind partition could be constructed")

    public_principles: dict[str, Any] = {}
    principle_masks: dict[str, dict[str, np.ndarray]] = {}
    for name, target_saved_mask in saved_memberships.items():
        match_ledger: list[dict[str, Any]] = []
        candidates: list[tuple[tuple[Any, ...], dict[str, Any], np.ndarray]] = []
        for partition_index, partition in enumerate(partition_states):
            labels = partition["labels"]
            saved_labels = labels[source_to_pool["saved"]]
            best_for_partition: tuple[tuple[Any, ...], dict[str, Any], np.ndarray] | None = None
            for cluster_id in sorted(int(value) for value in np.unique(labels)):
                cluster_saved_mask = saved_labels == cluster_id
                score, intersection, union = _jaccard(
                    target_saved_mask, cluster_saved_mask
                )
                cluster_saved_n = int(np.sum(cluster_saved_mask))
                precision = (
                    float(intersection / cluster_saved_n)
                    if cluster_saved_n
                    else None
                )
                recall = float(intersection / np.sum(target_saved_mask))
                row = {
                    "partitionId": partition["partitionId"],
                    "algorithm": partition["ledger"]["algorithm"],
                    "k": int(partition["ledger"]["k"]),
                    "seed": int(partition["ledger"]["seed"]),
                    "clusterId": int(cluster_id),
                    "jaccard": score,
                    "intersectionSaved": intersection,
                    "unionSaved": union,
                    "principleSavedSupport": int(np.sum(target_saved_mask)),
                    "clusterSavedSupport": cluster_saved_n,
                    "precisionOnSaved": precision,
                    "recallOnSaved": recall,
                }
                rank = (
                    score,
                    intersection,
                    -abs(cluster_saved_n - int(np.sum(target_saved_mask))),
                    -partition_index,
                    -cluster_id,
                )
                cluster_pool_mask = labels == cluster_id
                candidate = (rank, row, cluster_pool_mask)
                if best_for_partition is None or rank > best_for_partition[0]:
                    best_for_partition = candidate
            assert best_for_partition is not None
            match_ledger.append(best_for_partition[1])
            candidates.append(best_for_partition)
        selected = max(candidates, key=lambda row: row[0])
        selected_row = dict(selected[1])
        selected_pool_mask = selected[2]
        robust_matches = [
            row for row in match_ledger
            if (
                row["jaccard"] >= config.min_match_jaccard
                and row["intersectionSaved"] >= config.min_match_rows
                and (row["precisionOnSaved"] or 0) >= config.min_match_precision
                and (row["recallOnSaved"] or 0) >= config.min_match_recall
            )
        ]
        robust_algorithms = sorted({
            str(row["algorithm"]) for row in robust_matches
        })
        selected_row["transportEligible"] = bool(
            selected_row["jaccard"] >= config.min_match_jaccard
            and selected_row["intersectionSaved"] >= config.min_match_rows
            and (selected_row["precisionOnSaved"] or 0)
            >= config.min_match_precision
            and (selected_row["recallOnSaved"] or 0)
            >= config.min_match_recall
            and len(robust_matches) >= config.min_robust_partitions
            and len(robust_algorithms) >= min(2, len(config.algorithms))
        )
        source_masks = {
            source: selected_pool_mask[source_to_pool[source]]
            for source in ("saved", "broad", "observed")
        }
        principle_masks[name] = {
            "frozenSaved": target_saved_mask,
            **source_masks,
        }
        sorted_jaccards = sorted(
            float(row["jaccard"]) for row in match_ledger
        )
        public_principles[name] = {
            "frozenMembershipHash": _mask_hash(target_saved_mask),
            "frozenSavedSupport": int(np.sum(target_saved_mask)),
            "selectedMatch": {
                **selected_row,
                "transportMembershipHash": _mask_hash(selected_pool_mask),
                "pooledSupport": int(np.sum(selected_pool_mask)),
            },
            "matchRobustness": {
                "partitionsMatched": int(len(match_ledger)),
                "partitionsAtOrAboveMinimumJaccard": int(sum(
                    row["jaccard"] >= config.min_match_jaccard
                    for row in match_ledger
                )),
                "partitionsMeetingFullMatchContract": len(robust_matches),
                "algorithmsMeetingFullMatchContract": robust_algorithms,
                "minimumRequiredJaccard": float(config.min_match_jaccard),
                "minimumRequiredPrecision": float(config.min_match_precision),
                "minimumRequiredRecall": float(config.min_match_recall),
                "minimumRequiredRobustPartitions": int(
                    config.min_robust_partitions
                ),
                "jaccardMin": sorted_jaccards[0],
                "jaccardMedian": float(np.median(sorted_jaccards)),
                "jaccardMax": sorted_jaccards[-1],
            },
            "matchLedger": match_ledger,
            "geometryPrevalence": {
                source: _prevalence(
                    source_masks[source],
                    source_groups[source],
                    config.bootstrap_repeats,
                    _stable_seed(
                        config.bootstrap_seed, "prevalence", name, source
                    ),
                )
                for source in ("saved", "broad", "observed")
            },
        }

    source_id_sets = {
        source: set(values.tolist()) for source, values in source_ids.items()
    }
    overlap_available = {
        "savedBroad": bool(saved_ids_supplied and broad_ids_supplied),
        "savedObserved": bool(saved_ids_supplied and observed_ids_supplied),
        "broadObserved": bool(broad_ids_supplied and observed_ids_supplied),
    }
    overlap_counts = {
        "savedBroad": (
            len(source_id_sets["saved"] & source_id_sets["broad"])
            if overlap_available["savedBroad"] else None
        ),
        "savedObserved": (
            len(source_id_sets["saved"] & source_id_sets["observed"])
            if overlap_available["savedObserved"] else None
        ),
        "broadObserved": (
            len(source_id_sets["broad"] & source_id_sets["observed"])
            if overlap_available["broadObserved"] else None
        ),
    }
    geometry_core = {
        "schemaVersion": SCHEMA_VERSION,
        "outcomeBlind": True,
        "sharedDimensions": dimensions,
        "rawVectorRule": (
            f"the caller supplies every source in the same {dimensions}-dimensional "
            "basis; this module verifies dimensions and L2-normalizes every row"
        ),
        "sources": {
            source: {
                "rows": int(len(source_ids[source])),
                "uniqueGroups": int(len(set(source_groups[source].tolist()))),
                "idsSupplied": bool({
                    "saved": saved_ids_supplied,
                    "broad": broad_ids_supplied,
                    "observed": observed_ids_supplied,
                }[source]),
                "idHash": _string_hash(source_ids[source]),
                "groupHash": _string_hash(source_groups[source]),
                "normalizedSharedVectorHash": _array_hash(source_vectors[source]),
            }
            for source in ("saved", "broad", "observed")
        },
        "pool": {
            "sourceRowsBeforeDeduplication": int(
                sum(len(values) for values in source_ids.values())
            ),
            "uniqueRowsAfterExactIdDeduplication": int(len(pooled_ids)),
            "exactIdOverlapAvailability": overlap_available,
            "exactIdOverlapCounts": overlap_counts,
            "pooledIdHash": _string_hash(pooled_ids),
            "pooledNormalizedVectorHash": _array_hash(pooled_vectors),
        },
        "partitionLedger": partition_ledger,
        "principles": public_principles,
        "config": asdict(config),
    }
    fingerprint_payload = {
        "pooledVectorHash": geometry_core["pool"]["pooledNormalizedVectorHash"],
        "partitionHashes": [
            row.get("labelsHash") for row in partition_ledger
            if row["status"] == "tested"
        ],
        "principles": {
            name: {
                "frozen": row["frozenMembershipHash"],
                "selected": row["selectedMatch"]["transportMembershipHash"],
                "match": row["selectedMatch"]["jaccard"],
            }
            for name, row in public_principles.items()
        },
        "config": asdict(config),
    }
    geometry_core["geometryFingerprint"] = hashlib.sha256(
        json.dumps(
            fingerprint_payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return _GeometryState(
        public=geometry_core,
        source_ids=source_ids,
        source_groups=source_groups,
        source_orders=source_orders,
        principle_masks=principle_masks,
    )


def validate_principle_transport(
    saved_visual_previews: np.ndarray,
    saved_projected_keep: Sequence[float] | np.ndarray,
    saved_group_ids: Sequence[Any],
    broad_visual_vectors: np.ndarray,
    broad_ids: Sequence[Any],
    broad_group_ids: Sequence[Any],
    observed_visual_vectors: np.ndarray,
    observed_actual_keep: Sequence[float] | np.ndarray,
    observed_group_ids: Sequence[Any],
    principle_memberships: Mapping[str, Any],
    *,
    broad_projected_keep_by_id: Mapping[Any, float] | None = None,
    saved_ids: Sequence[Any] | None = None,
    observed_ids: Sequence[Any] | None = None,
    config: TransportConfig | None = None,
) -> dict[str, Any]:
    """Transport frozen principles into broad and observed visual geometry.

    Broad projected scores must be supplied as an exact-ID mapping. They are
    explicitly treated as circular surrogate evidence. Observed scores remain
    a distinct, exact-ID-disjoint small-tail diagnostic layer. No association
    returned by this function is causal or an independently corrected replication.
    """

    settings = config or TransportConfig()
    settings.validate()
    geometry = _prepare_geometry(
        saved_visual_previews,
        saved_group_ids,
        broad_visual_vectors,
        broad_ids,
        broad_group_ids,
        observed_visual_vectors,
        observed_group_ids,
        principle_memberships,
        saved_ids,
        observed_ids,
        settings,
    )
    saved_keep_original = _validate_keep(
        saved_projected_keep,
        len(geometry.source_orders["saved"]),
        "saved projected keep",
    )
    observed_keep_original = _validate_keep(
        observed_actual_keep,
        len(geometry.source_orders["observed"]),
        "observed actual keep",
    )
    saved_keep = saved_keep_original[geometry.source_orders["saved"]]
    observed_keep = observed_keep_original[geometry.source_orders["observed"]]
    projected_map = _validate_projected_map(broad_projected_keep_by_id)
    broad_ids_canonical = geometry.source_ids["broad"]
    if projected_map is None:
        broad_join_mask = np.zeros(len(broad_ids_canonical), dtype=bool)
        broad_keep = np.asarray([], dtype=np.float64)
        broad_join_groups = np.asarray([], dtype=object)
        projected_extra_ids: list[str] = []
    else:
        broad_join_mask = np.asarray(
            [row_id in projected_map for row_id in broad_ids_canonical],
            dtype=bool,
        )
        broad_keep = np.asarray(
            [projected_map[row_id] for row_id in broad_ids_canonical[broad_join_mask]],
            dtype=np.float64,
        )
        broad_join_groups = geometry.source_groups["broad"][broad_join_mask]
        projected_extra_ids = sorted(
            set(projected_map) - set(broad_ids_canonical.tolist())
        )

    evidence: dict[str, Any] = {}
    for name in sorted(geometry.principle_masks):
        masks = geometry.principle_masks[name]
        frozen_saved = _association(
            saved_keep,
            masks["frozenSaved"],
            geometry.source_groups["saved"],
            settings,
            f"{name}:saved:frozen",
        )
        transported_saved = _association(
            saved_keep,
            masks["saved"],
            geometry.source_groups["saved"],
            settings,
            f"{name}:saved:transported",
        )
        match_eligible = bool(
            geometry.public["principles"][name]["selectedMatch"][
                "transportEligible"
            ]
        )
        if not match_eligible:
            transport_reason = (
                "the outcome-blind shared-space match did not meet the "
                "predeclared Jaccard, precision, recall, row, algorithm, and "
                "partition-support contract"
            )
            broad_projected = {
                "status": "transport_ineligible",
                "reason": transport_reason,
                "evidenceTag": "circular_projected_surrogate_transport",
                "causal": False,
            }
            observed = {
                "status": "transport_ineligible",
                "reason": transport_reason,
                "evidenceTag": "observed_actual_keep_diagnostic",
                "causal": False,
            }
        elif projected_map is None:
            broad_projected = {
                "status": "not_supplied",
                "evidenceTag": "circular_projected_surrogate_transport",
                "causal": False,
            }
        else:
            broad_projected = {
                **_association(
                    broad_keep,
                    masks["broad"][broad_join_mask],
                    broad_join_groups,
                    settings,
                    f"{name}:broad:projected",
                ),
                "evidenceTag": "circular_projected_surrogate_transport",
                "causal": False,
            }
        if match_eligible:
            observed = {
                **_association(
                    observed_keep,
                    masks["observed"],
                    geometry.source_groups["observed"],
                    settings,
                    f"{name}:observed:actual",
                ),
                "evidenceTag": "observed_actual_keep_diagnostic",
                "causal": False,
            }
        observed_continuous = observed.get("continuous") or {}
        saved_continuous = (
            (frozen_saved.get("continuous") or {})
            if frozen_saved.get("status") == "ok"
            else {}
        )
        observed_ci = observed_continuous.get("ci95GroupedBootstrap")
        observed_effect = observed_continuous.get("meanDifference")
        saved_effect = saved_continuous.get("meanDifference")
        observed_consistency = (
            (observed_continuous.get("foldSignConsistency") or {})
            .get("consistentFraction")
        )
        observed_folds_usable = int(
            (observed_continuous.get("foldSignConsistency") or {})
            .get("foldsUsable")
            or 0
        )
        observed_bootstraps = int(
            observed_continuous.get("bootstrapValidRepeats") or 0
        )
        observed_bootstraps_required = int(
            observed_continuous.get("bootstrapRequiredRepeats") or 0
        )
        directional_consistency = bool(
            match_eligible
            and observed.get("status") == "ok"
            and observed.get("uniqueGroups", 0) >= settings.min_observed_groups
            and observed_folds_usable >= settings.min_observed_folds
            and observed_bootstraps >= observed_bootstraps_required > 0
            and observed_effect is not None
            and saved_effect is not None
            and observed_effect * saved_effect > 0
            and isinstance(observed_ci, list)
            and len(observed_ci) == 2
            and (
                (observed_effect > 0 and observed_ci[0] > 0)
                or (observed_effect < 0 and observed_ci[1] < 0)
            )
            and observed_consistency is not None
            and observed_consistency >= 0.80
        )
        observed["directionalConsistencyWithSaved"] = {
            "passes": directional_consistency,
            "requires": (
                "eligible transport, at least the configured disjoint observed groups, "
                "same continuous-effect direction, grouped-bootstrap interval "
                "with the configured valid-resample fraction, at least the configured "
                "usable group folds, and at least 80% group-fold sign consistency"
            ),
            "multiplicityCorrected": False,
            "replicationClaim": False,
        }
        if directional_consistency:
            evidence_tier = "observed_directional_consistency"
        elif match_eligible and observed.get("status") == "ok":
            evidence_tier = "observed_diagnostic_available"
        elif (
            match_eligible
            and broad_projected.get("continuous", {}).get("status") == "ok"
        ):
            evidence_tier = "circular_surrogate_transport"
        else:
            evidence_tier = "geometry_only"
        evidence[name] = {
            "evidenceTier": evidence_tier,
            "causal": False,
            "interpretationBoundary": (
                "Associations do not establish causality. Projected keep reuses "
                "the source scoring system and is circular surrogate transport; "
                "observed keep is exact-ID disjoint diagnostic evidence, but no replication claim "
                "is made without corrected independent confirmation."
            ),
            "savedProjectedReference": {
                "evidenceTag": "circular_saved_projected_reference",
                "causal": False,
                "frozenPrincipleMembership": frozen_saved,
                "transportedClusterMembership": transported_saved,
            },
            "broadProjectedSurrogate": broad_projected,
            "observedActualKeep": observed,
        }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "geometry": geometry.public,
        "outcomesAttachedAfterGeometry": True,
        "outcomeSources": {
            "savedProjected": {
                "rows": int(len(saved_keep)),
                "scoreHash": _array_hash(saved_keep.reshape(-1, 1)),
                "evidenceTag": "circular_saved_projected_reference",
            },
            "broadProjected": {
                "supplied": projected_map is not None,
                "mappingRows": int(len(projected_map or {})),
                "joinedByExactIdRows": int(np.sum(broad_join_mask)),
                "missingBroadIds": int(len(broad_ids_canonical) - np.sum(broad_join_mask)),
                "extraMappingIds": int(len(projected_extra_ids)),
                "extraMappingIdHash": _string_hash(projected_extra_ids),
                "scoreHash": (
                    _array_hash(broad_keep.reshape(-1, 1))
                    if len(broad_keep)
                    else None
                ),
                "evidenceTag": "circular_projected_surrogate_transport",
            },
            "observedActual": {
                "rows": int(len(observed_keep)),
                "scoreHash": _array_hash(observed_keep.reshape(-1, 1)),
                "evidenceTag": "observed_actual_keep_diagnostic",
                "tailHitsAt85": int(np.sum(observed_keep >= settings.keep_threshold)),
            },
        },
        "principles": evidence,
        "claims": {
            "causal": False,
            "projectedScoresAreIndependentValidation": False,
            "observedScoresAreExternalDiagnostics": True,
            "observedScoresAreExternalReplication": False,
        },
    }


__all__ = [
    "SCHEMA_VERSION",
    "TransportConfig",
    "normalize_rows",
    "validate_principle_transport",
]
