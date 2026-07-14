"""Dependency-light features and serving for the unified opening predictor.

Training is performed offline.  This module deliberately depends only on NumPy so
the Render scorer can apply the frozen models without importing scikit-learn.
"""

from __future__ import annotations

import math
from typing import Iterable

import numpy as np

from hook_score_core import apply_linear_model, row_unit


FEATURE_VERSION = "opening-retention-features-v2"
PREDICTOR_VERSION = "opening-retention-predictor-v2"
CATEGORY_COUNT = 4
EPS = 1e-9


def _unit_block(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, np.float32).reshape(-1)
    norm = float(np.linalg.norm(values))
    if norm <= EPS:
        return np.zeros_like(values)
    return values / norm


def _join_blocks(blocks: Iterable[np.ndarray]) -> np.ndarray:
    normalized = [_unit_block(block) for block in blocks]
    if not normalized:
        raise ValueError("at least one feature block is required")
    return np.concatenate(normalized).astype(np.float32) / math.sqrt(len(normalized))


def _component_rows(components: list[dict], raw: np.ndarray,
                    influence: np.ndarray, removed: set[int]) -> list[dict]:
    if len(components) != len(raw) or len(components) != len(influence):
        raise ValueError("component metadata and vectors differ")
    rows = []
    for position, component in enumerate(components):
        original = int(component.get("index", position))
        if original in removed:
            continue
        start = int(component.get("startToken", component.get("start", 0)))
        end = int(component.get("endToken", component.get("end", start + 1)))
        category = int(component.get("category", -1))
        if category < 0 or category >= CATEGORY_COUNT:
            raise ValueError(f"component category is outside 0..3: {category}")
        rows.append({
            "original": original,
            "start": start,
            "end": end,
            "length": max(1, end - start),
            "category": category,
            "raw": row_unit(np.asarray(raw[position], np.float32)),
            "influence": row_unit(np.asarray(influence[position], np.float32)),
        })
    if not rows:
        raise ValueError("a prediction cannot remove every component")
    rows.sort(key=lambda row: (row["start"], row["end"], row["original"]))
    return rows


def _mean_vectors(rows: list[dict], key: str, category: int | None = None) -> np.ndarray:
    selected = [row[key] for row in rows if category is None or row["category"] == category]
    if not selected:
        return np.zeros_like(rows[0][key])
    return row_unit(np.mean(np.asarray(selected, np.float32), axis=0))


def _component_blocks(rows: list[dict], token_count: int) -> list[np.ndarray]:
    token_count = max(1, int(token_count))
    lengths = np.asarray([row["length"] for row in rows], np.float32)
    categories = np.asarray([row["category"] for row in rows], int)
    counts = np.asarray([(categories == category).sum() for category in range(CATEGORY_COUNT)], np.float32)
    token_mass = np.asarray([
        lengths[categories == category].sum() for category in range(CATEGORY_COUNT)
    ], np.float32)
    mean_length = np.asarray([
        lengths[categories == category].mean() if np.any(categories == category) else 0.0
        for category in range(CATEGORY_COUNT)
    ], np.float32)
    maximum_length = np.asarray([
        lengths[categories == category].max() if np.any(categories == category) else 0.0
        for category in range(CATEGORY_COUNT)
    ], np.float32)
    structure = np.concatenate([
        counts / max(1, len(rows)),
        token_mass / token_count,
        mean_length / token_count,
        maximum_length / token_count,
        np.asarray([len(rows) / token_count], np.float32),
    ])
    return [
        _mean_vectors(rows, "raw"),
        _mean_vectors(rows, "influence"),
        *[_mean_vectors(rows, "raw", category) for category in range(CATEGORY_COUNT)],
        *[_mean_vectors(rows, "influence", category) for category in range(CATEGORY_COUNT)],
        structure,
    ]


def _relation_blocks(rows: list[dict], disabled_edges: set[tuple[int, int]]) -> list[np.ndarray]:
    transitions = np.zeros((CATEGORY_COUNT, CATEGORY_COUNT), np.float32)
    raw_cosine = np.zeros_like(transitions)
    influence_cosine = np.zeros_like(transitions)
    context_cross = np.zeros_like(transitions)
    pair_counts = np.zeros_like(transitions)
    for left, right in zip(rows[:-1], rows[1:]):
        key = (int(left["original"]), int(right["original"]))
        if key in disabled_edges:
            continue
        a = int(left["category"]); b = int(right["category"])
        transitions[a, b] += 1.0
        pair_counts[a, b] += 1.0
        raw_cosine[a, b] += float(left["raw"] @ right["raw"])
        influence_cosine[a, b] += float(left["influence"] @ right["influence"])
        context_cross[a, b] += float(left["raw"] @ right["influence"])
    valid = pair_counts > 0
    raw_cosine[valid] /= pair_counts[valid]
    influence_cosine[valid] /= pair_counts[valid]
    context_cross[valid] /= pair_counts[valid]

    categories = np.asarray([row["category"] for row in rows], int)
    positions = np.linspace(0.0, 1.0, len(rows), dtype=np.float32)
    mean_position = np.asarray([
        positions[categories == category].mean() if np.any(categories == category) else 0.0
        for category in range(CATEGORY_COUNT)
    ], np.float32)
    first = np.zeros(CATEGORY_COUNT, np.float32); first[categories[0]] = 1.0
    last = np.zeros(CATEGORY_COUNT, np.float32); last[categories[-1]] = 1.0
    probabilities = np.bincount(categories, minlength=CATEGORY_COUNT).astype(np.float32)
    probabilities /= max(1.0, probabilities.sum())
    entropy = -float(np.sum(probabilities[probabilities > 0] * np.log(probabilities[probabilities > 0])))
    run_count = 1 + int(np.sum(categories[1:] != categories[:-1])) if len(categories) else 0
    sequence = np.concatenate([
        mean_position, first, last,
        np.asarray([run_count / max(1, len(rows)), entropy / math.log(CATEGORY_COUNT)], np.float32),
    ])
    raw_influence = np.asarray([
        np.mean([
            float(row["raw"] @ row["influence"])
            for row in rows if row["category"] == category
        ]) if np.any(categories == category) else 0.0
        for category in range(CATEGORY_COUNT)
    ], np.float32)
    return [
        transitions.reshape(-1), raw_cosine.reshape(-1),
        influence_cosine.reshape(-1), context_cross.reshape(-1),
        sequence, raw_influence,
    ]


def build_feature_stages(full: np.ndarray, raw: np.ndarray, influence: np.ndarray,
                         components: list[dict], token_count: int,
                         removed_components: Iterable[int] = (),
                         disabled_edges: Iterable[tuple[int, int]] = ()) -> dict[str, np.ndarray]:
    """Return nested semantic, component, and relational feature vectors.

    The canonical components are an exact non-overlapping cover.  The component
    stage includes literal phrase vectors and deletion-influence vectors; the
    relationship stage adds order, transitions, semantic similarity, and
    context-cross similarity for adjacent canonical components.
    """
    removed = {int(value) for value in removed_components}
    disabled = {(int(left), int(right)) for left, right in disabled_edges}
    rows = _component_rows(
        components, np.asarray(raw, np.float32), np.asarray(influence, np.float32), removed,
    )
    semantic_blocks = [row_unit(np.asarray(full, np.float32))]
    component_blocks = [*semantic_blocks, *_component_blocks(rows, token_count)]
    relation_blocks = [*component_blocks, *_relation_blocks(rows, disabled)]
    return {
        "semantic": _join_blocks(semantic_blocks),
        "components": _join_blocks(component_blocks),
        "relationships": _join_blocks(relation_blocks),
    }


def apply_curve_stage(feature: np.ndarray, model: dict) -> np.ndarray:
    return np.asarray(apply_linear_model(np.asarray(feature, np.float32), model)[0], np.float32)


def apply_scalar_stage(feature: np.ndarray, model: dict) -> float:
    """Apply one frozen scalar model without a training-time dependency."""
    unit = row_unit(np.asarray(feature, np.float32)).reshape(1, -1)
    coefficient = np.asarray(model["coefficient"], np.float32).reshape(-1)
    intercept = float(np.asarray(model["intercept"], np.float32).reshape(-1)[0])
    if unit.shape[1] != len(coefficient):
        raise ValueError("serving feature and frozen scalar model dimensions differ")
    return float(unit[0] @ coefficient + intercept)


def apply_curve_points(feature: np.ndarray, model: dict,
                       indices: Iterable[int]) -> np.ndarray:
    indices = np.asarray(list(indices), int)
    unit = row_unit(np.asarray(feature, np.float32)).reshape(1, -1)
    coefficient = np.asarray(model["coefficient"], np.float32)
    if coefficient.ndim == 1:
        coefficient = coefficient[:, None]
    intercept = np.asarray(model["intercept"], np.float32).reshape(-1)
    return (unit @ coefficient[:, indices] + intercept[indices])[0]


def views_from_retention5(retention5_percent: float, contract: dict) -> dict:
    coefficient = float(contract["coefficient"])
    intercept = float(contract["intercept"])
    residual_sd = float(contract["residualSdLog10"])
    center_log = intercept + coefficient * float(retention5_percent)
    z80 = float(contract.get("central80Z") or 1.2815515655446004)
    lower_log = center_log - z80 * residual_sd
    upper_log = center_log + z80 * residual_sd
    return {
        "estimate": float(10 ** center_log),
        "lower80": float(10 ** lower_log),
        "upper80": float(10 ** upper_log),
        "log10Estimate": float(center_log),
        "rangeMultiplier80": float(10 ** (z80 * residual_sd)),
        "evidenceClass": "ret5-only observational diagnostic",
        "inputRetention5Percent": float(retention5_percent),
        "formula": "10^(intercept + coefficient * predicted absolute retention at 5s)",
        "limitations": (
            "This reuses the Shorts Quant ret5-only relationship. It does not know the "
            "visual stay rate, whole-video average retention, or duration."
        ),
    }


def prediction_support(token_count: int, estimated_seconds: float, model: dict) -> dict:
    support = model.get("support") or {}
    minimum = int(support.get("tokenCountMinimum") or 0)
    maximum = int(support.get("tokenCountMaximum") or 0)
    token_count = int(token_count)
    outside = bool(minimum and maximum and not minimum <= token_count <= maximum)
    return {
        "tokenCount": token_count,
        "trainingTokenCountMinimum": minimum or None,
        "trainingTokenCountMaximum": maximum or None,
        "outsideMeasuredTokenRange": outside,
        "estimatedSpokenSeconds": float(estimated_seconds),
        "analysisHorizonSeconds": float(model.get("analysisHorizonSeconds") or 20.0),
        "isExtrapolation": outside,
    }
