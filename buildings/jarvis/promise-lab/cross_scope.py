"""Outcome-blind agreement checks between candidate and exhaustive span atlases."""

from __future__ import annotations

import numpy as np
from scipy.stats import spearmanr
from sklearn.metrics import adjusted_rand_score

from atlas import balanced_sample


EPS = 1e-9


def map_weight(row: dict) -> float:
    return max(0.0, float(row.get("qualityForBrowsing") or 0.0)) + EPS


def normalized_map_weights(maps: list[dict]) -> np.ndarray:
    weights = np.asarray([map_weight(row) for row in maps], np.float64)
    return weights / max(np.finfo(float).eps, weights.sum())


def pairwise_consensus(maps: list[dict], left: np.ndarray, right: np.ndarray,
                       index_projection: np.ndarray | None = None) -> np.ndarray:
    weights = normalized_map_weights(maps)
    result = np.zeros(len(left), np.float32)
    for row, weight in zip(maps, weights):
        labels = np.asarray(row["labels"], np.int32)
        if index_projection is not None:
            labels = labels[index_projection]
        result += (labels[left] == labels[right]).astype(np.float32) * float(weight)
    return result


def compare_maps(candidate_maps: list[dict], all_span_maps: list[dict],
                 all_indices_for_candidates: np.ndarray, groups: np.ndarray,
                 sample_size: int = 4096, candidate_map_limit: int = 0,
                 progress=None) -> list[dict]:
    rng = np.random.RandomState(7727)
    sample = balanced_sample(groups, min(sample_size, len(groups)), rng)
    candidate_maps = sorted(
        candidate_maps,
        key=lambda row: -float(row.get("qualityForBrowsing") or 0),
    )
    if candidate_map_limit:
        candidate_maps = candidate_maps[:candidate_map_limit]
    candidate_labels = [np.asarray(row["labels"], np.int32)[sample] for row in candidate_maps]
    comparisons = []
    for position, all_map in enumerate(all_span_maps, 1):
        all_labels = np.asarray(all_map["labels"], np.int32)[all_indices_for_candidates][sample]
        scores = np.asarray([
            adjusted_rand_score(labels, all_labels) for labels in candidate_labels
        ], np.float64)
        best = int(np.argmax(scores))
        same_view = [index for index, row in enumerate(candidate_maps)
                     if row.get("representation") == all_map.get("representation")]
        same_best = max(same_view, key=lambda index: scores[index]) if same_view else None
        comparisons.append({
            "allSpanMapId": all_map["id"],
            "allSpanRepresentation": all_map.get("representation"),
            "bestCandidateMapId": candidate_maps[best]["id"],
            "bestCandidateRepresentation": candidate_maps[best].get("representation"),
            "bestARI": float(scores[best]),
            "sameRepresentationBestARI": (float(scores[same_best])
                                           if same_best is not None else None),
            "sameRepresentationBestMapId": (candidate_maps[same_best]["id"]
                                              if same_best is not None else None),
            "candidateInstancesCompared": int(len(sample)),
            "candidateMapsCompared": len(candidate_maps),
            "outcomesUsed": False,
        })
        if progress:
            progress(position, len(all_span_maps))
    return comparisons


def consensus_agreement(candidate_maps: list[dict], all_span_maps: list[dict],
                        all_indices_for_candidates: np.ndarray,
                        pair_count: int = 100_000) -> dict:
    rng = np.random.RandomState(99173)
    size = len(all_indices_for_candidates)
    left = rng.randint(0, size, size=pair_count, dtype=np.int32)
    right = rng.randint(0, size, size=pair_count, dtype=np.int32)
    same = left == right
    right[same] = (right[same] + 1) % size
    candidate = pairwise_consensus(candidate_maps, left, right)
    exhaustive = pairwise_consensus(
        all_span_maps, left, right, index_projection=all_indices_for_candidates
    )
    correlation = float(spearmanr(candidate, exhaustive).statistic)
    return {
        "pairSample": int(pair_count),
        "spearman": correlation,
        "meanAbsoluteDifference": float(np.mean(np.abs(candidate - exhaustive))),
        "candidateConsensusMean": float(np.mean(candidate)),
        "allSpanConsensusMean": float(np.mean(exhaustive)),
        "outcomesUsed": False,
    }


def boundary_support_separation(cluster_map: dict, global_fraction: float) -> dict:
    summaries = cluster_map.get("clusterSummaries") or []
    rows = [row for row in summaries if row.get("boundarySupportedFraction") is not None]
    if not rows:
        return {"weightedAbsoluteEnrichment": None, "maximumAbsoluteEnrichment": None}
    total = max(1, sum(int(row.get("size") or 0) for row in rows))
    deviations = [abs(float(row["boundarySupportedFraction"]) - global_fraction) for row in rows]
    return {
        "weightedAbsoluteEnrichment": float(sum(
            deviation * int(row.get("size") or 0) / total
            for row, deviation in zip(rows, deviations)
        )),
        "maximumAbsoluteEnrichment": float(max(deviations)),
    }
