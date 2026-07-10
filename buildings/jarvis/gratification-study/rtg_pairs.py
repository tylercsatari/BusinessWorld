"""Same-idea matched-difference approximation for the RTG program."""

from __future__ import annotations

from collections import Counter
from typing import Any

import numpy as np
from sklearn.model_selection import GroupKFold

from build_study import normalize_rows


def build_same_idea_pairs(
    rows: list[dict],
    title_vectors: np.ndarray,
    semantic_groups: np.ndarray,
    neighbors_per_video=3,
) -> tuple[list[dict[str, Any]], list[tuple[np.ndarray, np.ndarray]], dict[str, Any]]:
    title = normalize_rows(title_vectors)
    similarity = title @ title.T
    np.fill_diagonal(similarity, -np.inf)
    pairs = {}
    for group in np.unique(semantic_groups):
        indices = np.where(semantic_groups == group)[0]
        if len(indices) < 2:
            continue
        for index in indices:
            candidates = [other for other in indices if other != index]
            candidates.sort(key=lambda other: similarity[index, other], reverse=True)
            for other in candidates[:neighbors_per_video]:
                left, right = sorted((int(index), int(other)))
                pairs[(left, right)] = {
                    "a": left,
                    "b": right,
                    "aId": str(rows[left]["id"]),
                    "bId": str(rows[right]["id"]),
                    "group": int(group),
                    "titleCosine": round(float(similarity[left, right]), 6),
                }
    ordered = sorted(pairs.values(), key=lambda pair: pair["titleCosine"], reverse=True)
    similarities = np.asarray([pair["titleCosine"] for pair in ordered], float)
    if len(similarities):
        thresholds = {str(percentile): float(np.percentile(similarities, percentile)) for percentile in (25, 50, 75, 90)}
        for pair in ordered:
            pair["supportPercentile"] = round(float(np.mean(similarities <= pair["titleCosine"]) * 100.0), 2)
            pair["supportTier"] = "highest" if pair["titleCosine"] >= thresholds["90"] else "high" if pair["titleCosine"] >= thresholds["75"] else "moderate" if pair["titleCosine"] >= thresholds["50"] else "low"
    else:
        thresholds = {}

    pair_groups = np.asarray([pair["group"] for pair in ordered], int)
    unique_groups = np.unique(pair_groups)
    folds = list(GroupKFold(n_splits=min(5, len(unique_groups))).split(np.arange(len(ordered)), groups=pair_groups)) if len(unique_groups) >= 3 else []
    metadata = {
        "pairs": len(ordered),
        "semanticGroups": int(len(unique_groups)),
        "neighborsPerVideo": neighbors_per_video,
        "similarityThresholds": {key: round(value, 6) for key, value in thresholds.items()},
        "supportTiers": dict(Counter(pair.get("supportTier") for pair in ordered)),
        "rule": "Pairs are top title-cosine neighbors inside the same outcome-blind semantic title cluster.",
        "hardLimit": "Same-ish idea is an observational approximation, not proof that the underlying produced idea is identical.",
        "validation": "Entire semantic title clusters are held out, so no video or pair from a test idea cluster trains its predictor.",
    }
    return ordered, folds, metadata


def pair_differences(values: np.ndarray, pairs: list[dict[str, Any]]) -> np.ndarray:
    values = np.asarray(values, float)
    return np.asarray([values[pair["a"]] - values[pair["b"]] for pair in pairs], float)


def pair_representation_matrices(representations: dict[str, np.ndarray], pairs) -> dict[str, np.ndarray]:
    return {key: pair_differences(values, pairs) for key, values in representations.items()}


def pair_adjustment_matrices(adjusted: dict[str, np.ndarray], pairs) -> dict[str, np.ndarray]:
    return {key: pair_differences(values, pairs) for key, values in adjusted.items()}
