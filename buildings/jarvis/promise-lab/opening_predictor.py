"""Dependency-light features and serving for the unified opening predictor.

Training is performed offline.  This module deliberately depends only on NumPy so
the Render scorer can apply the frozen models without importing scikit-learn.
"""

from __future__ import annotations

import math
from typing import Iterable

import numpy as np

from hook_score_core import apply_linear_model, row_unit


FEATURE_VERSION = "opening-retention-features-v3-variable-context"
PREDICTOR_VERSION = "opening-retention-predictor-v3-variable-context"
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


def build_causal_sequence_feature_stages(
        prefix_vector: np.ndarray, components: list[dict], second: float,
        completed_token_count: int, words_per_second: float) -> dict[str, np.ndarray]:
    """Build the shared variable-horizon feature ladder from prior viewer context.

    ``components`` must contain only components whose boundary evidence was
    available by ``second``.  The function never consumes a future component,
    an external idea prompt, or an outcome.  Category geometry stays in the
    frozen four-dimensional space, which keeps variable-horizon training compact.
    """
    second = max(0.0, float(second))
    completed_token_count = max(0, int(completed_token_count))
    words_per_second = max(EPS, float(words_per_second))
    ordered = sorted(
        components,
        key=lambda row: (
            int(row.get("startToken", row.get("start", 0))),
            int(row.get("endToken", row.get("end", 0))),
            int(row.get("index", 0)),
        ),
    )
    timing = np.asarray([
        second,
        math.sqrt(second),
        math.log1p(second),
        float(completed_token_count),
        math.sqrt(float(completed_token_count)),
        math.log1p(float(completed_token_count)),
        float(completed_token_count) / max(second, 1.0),
        words_per_second,
    ], np.float32)
    semantic = row_unit(np.asarray(prefix_vector, np.float32))

    counts = np.zeros(CATEGORY_COUNT, np.float32)
    token_mass = np.zeros(CATEGORY_COUNT, np.float32)
    confidence_sum = np.zeros(CATEGORY_COUNT, np.float32)
    coordinate_sum = np.zeros((CATEGORY_COUNT, CATEGORY_COUNT), np.float32)
    coordinate_count = np.zeros(CATEGORY_COUNT, np.float32)
    history_similarity_sum = np.zeros(CATEGORY_COUNT, np.float32)
    history_similarity_count = np.zeros(CATEGORY_COUNT, np.float32)
    predecessor_similarity_sum = np.zeros(CATEGORY_COUNT, np.float32)
    predecessor_similarity_count = np.zeros(CATEGORY_COUNT, np.float32)
    transitions = np.zeros((CATEGORY_COUNT, CATEGORY_COUNT), np.float32)
    transition_similarity = np.zeros_like(transitions)
    transition_count = np.zeros_like(transitions)
    categories = []
    for position, component in enumerate(ordered):
        category = int(component.get("category", -1))
        if category < 0 or category >= CATEGORY_COUNT:
            raise ValueError(f"component category is outside 0..3: {category}")
        start = int(component.get("startToken", component.get("start", 0)))
        end = int(component.get("endToken", component.get("end", start + 1)))
        length = max(1, end - start)
        counts[category] += 1.0
        token_mass[category] += float(length)
        confidence_sum[category] += float(component.get("categoryProbability") or 0.0)
        coordinates = np.asarray(
            component.get("categoryCoordinates4D") or np.zeros(CATEGORY_COUNT),
            np.float32,
        ).reshape(-1)
        if len(coordinates) != CATEGORY_COUNT:
            raise ValueError("component category coordinates are not four-dimensional")
        coordinate_sum[category] += coordinates
        coordinate_count[category] += 1.0
        context = component.get("viewerContext") or {}
        history_similarity = context.get("historySemanticSimilarity")
        if history_similarity is not None and math.isfinite(float(history_similarity)):
            history_similarity_sum[category] += float(history_similarity)
            history_similarity_count[category] += 1.0
        predecessor_similarity = context.get("predecessorSemanticSimilarity")
        if predecessor_similarity is not None and math.isfinite(float(predecessor_similarity)):
            predecessor_similarity_sum[category] += float(predecessor_similarity)
            predecessor_similarity_count[category] += 1.0
        if position:
            previous = categories[-1]
            transitions[previous, category] += 1.0
            transition_count[previous, category] += 1.0
            if predecessor_similarity is not None:
                transition_similarity[previous, category] += float(predecessor_similarity)
        categories.append(category)

    nonzero = coordinate_count > 0
    coordinate_mean = np.zeros_like(coordinate_sum)
    coordinate_mean[nonzero] = (
        coordinate_sum[nonzero] / coordinate_count[nonzero, None]
    )
    confidence_mean = np.divide(
        confidence_sum, counts, out=np.zeros_like(confidence_sum), where=counts > 0,
    )
    history_similarity_mean = np.divide(
        history_similarity_sum, history_similarity_count,
        out=np.zeros_like(history_similarity_sum), where=history_similarity_count > 0,
    )
    predecessor_similarity_mean = np.divide(
        predecessor_similarity_sum, predecessor_similarity_count,
        out=np.zeros_like(predecessor_similarity_sum),
        where=predecessor_similarity_count > 0,
    )
    transition_similarity = np.divide(
        transition_similarity, transition_count,
        out=np.zeros_like(transition_similarity), where=transition_count > 0,
    )
    first = np.zeros(CATEGORY_COUNT, np.float32)
    last = np.zeros(CATEGORY_COUNT, np.float32)
    if categories:
        first[categories[0]] = 1.0
        last[categories[-1]] = 1.0
    probabilities = counts / max(1.0, float(counts.sum()))
    valid_probabilities = probabilities[probabilities > 0]
    entropy = (
        -float(np.sum(valid_probabilities * np.log(valid_probabilities)))
        / math.log(CATEGORY_COUNT)
        if len(valid_probabilities) else 0.0
    )
    run_count = (
        1 + int(np.sum(np.asarray(categories[1:]) != np.asarray(categories[:-1])))
        if categories else 0
    )
    component_structure = np.concatenate([
        counts / max(1.0, float(counts.sum())),
        token_mass / max(1.0, float(completed_token_count)),
        confidence_mean,
        coordinate_mean.reshape(-1),
        history_similarity_mean,
        predecessor_similarity_mean,
        first,
        last,
        np.asarray([
            len(ordered) / max(1.0, float(completed_token_count)),
            float(token_mass.sum()) / max(1.0, float(completed_token_count)),
        ], np.float32),
    ])
    sequence = np.concatenate([
        transitions.reshape(-1),
        transition_similarity.reshape(-1),
        np.asarray([
            run_count / max(1, len(categories)),
            entropy,
            float(len(categories) > 0),
        ], np.float32),
    ])
    return {
        "timing": _join_blocks([timing]),
        "semantic": _join_blocks([timing, semantic]),
        "components": _join_blocks([timing, semantic, component_structure]),
        "relationships": _join_blocks([
            timing, semantic, component_structure, sequence,
        ]),
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


def temporal_attribution(curve: dict, prefix_trace: list[dict],
                         components: list[dict]) -> dict:
    """Account for every displayed retention transition without inventing causality.

    The temporal predictor is a sequence of separately fitted per-second models.  A
    transition can therefore move because the population time baseline changed,
    because the semantic prefix changed relative to that baseline, or both.  This
    ledger associates newly entered tokens with their exact-cover components and
    allocates the transition by token overlap.  The allocation is exhaustive, but
    it is descriptive accounting rather than an independent deletion intervention.
    """
    times_value = curve.get("timesSeconds")
    predicted_value = curve.get("predicted")
    times = np.asarray([] if times_value is None else times_value, float)
    predicted = np.asarray([] if predicted_value is None else predicted_value, float)
    stages = curve.get("stages") or {}
    baseline_value = stages.get("baseline")
    baseline = np.asarray([] if baseline_value is None else baseline_value, float)
    stage_order = ["baseline", "timing", "semantic", "components", "relationships"]
    stage_arrays = {"baseline": baseline}
    for name in stage_order[1:]:
        value = stages.get(name)
        if value is not None and len(value) == len(times):
            stage_arrays[name] = np.asarray(value, float)
    if "semantic" not in stage_arrays and stages.get("semanticPrefix") is not None:
        value = np.asarray(stages["semanticPrefix"], float)
        if len(value) == len(times):
            stage_arrays["semantic"] = value
    modern_stage_ladder = all(name in stage_arrays for name in stage_order)
    selected_stage = str(curve.get("selectedStage") or "relationships")
    candidate_stage = str(curve.get("candidateStage") or "relationships")
    if selected_stage not in stage_order:
        raise ValueError(f"unknown selected temporal stage: {selected_stage}")
    actual_values = curve.get("actual")
    actual = (
        np.asarray(actual_values, float)
        if actual_values is not None and len(actual_values) == len(times)
        else None
    )
    if not len(times) or len(predicted) != len(times) or len(baseline) != len(times):
        raise ValueError("temporal attribution requires aligned time, prediction, and baseline rows")

    trace = sorted(
        [dict(row) for row in prefix_trace if row.get("second") is not None],
        key=lambda row: float(row["second"]),
    )

    def trace_at(second: float) -> dict:
        eligible = [row for row in trace if float(row["second"]) <= second + 1e-6]
        if eligible:
            return eligible[-1]
        return {"second": 0.0, "endToken": 0, "tokenCount": 0, "prefixText": ""}

    component_rows = []
    ledger_by_index = {}
    for position, component in enumerate(components):
        index = int(component.get("index", position))
        row = {
            "componentIndex": index,
            "category": int(component.get("category", -1)),
            "text": str(component.get("text") or ""),
            "startToken": int(component.get("startToken", component.get("start", 0))),
            "endToken": int(component.get("endToken", component.get("end", 0))),
            "transitionIndices": [],
            "predictedDeltaPoints": 0.0,
            "predictedDropPoints": 0.0,
            "baselineDeltaPoints": 0.0,
            "semanticShapeDeltaPoints": 0.0,
            "channelDeltaPoints": {
                name: 0.0 for name in stage_order
            },
            "observedDeltaPoints": 0.0 if actual is not None else None,
            "allocationRole": "token-overlap accounting; not a deletion counterfactual",
        }
        component_rows.append(row)
        ledger_by_index[index] = row

    steps = []
    time_only_delta = 0.0
    allocated_delta = 0.0
    previous_trace = trace_at(float(times[0]))
    previous_cutoff = int(previous_trace.get("endToken", previous_trace.get("tokenCount", 0)) or 0)
    previous_prefix = str(previous_trace.get("prefixText") or "")
    for step_index in range(1, len(times)):
        second = float(times[step_index])
        current_trace = trace_at(second)
        cutoff = int(current_trace.get("endToken", current_trace.get("tokenCount", 0)) or 0)
        prefix_text = str(current_trace.get("prefixText") or "")
        entered_text = (
            prefix_text[len(previous_prefix):].strip()
            if previous_prefix and prefix_text.startswith(previous_prefix)
            else prefix_text if not previous_prefix else ""
        )
        start_token = min(previous_cutoff, cutoff)
        end_token = max(previous_cutoff, cutoff)
        token_count = max(0, end_token - start_token)
        predicted_delta = float(predicted[step_index] - predicted[step_index - 1])
        baseline_delta = float(baseline[step_index] - baseline[step_index - 1])
        semantic_delta = float(predicted_delta - baseline_delta)
        if modern_stage_ladder:
            candidate_channel_delta = {"baseline": baseline_delta}
            for previous_name, name in zip(stage_order, stage_order[1:]):
                previous = stage_arrays[previous_name]
                current = stage_arrays[name]
                candidate_channel_delta[name] = float(
                    (current[step_index] - previous[step_index])
                    - (current[step_index - 1] - previous[step_index - 1])
                )
            selected_index = stage_order.index(selected_stage)
            channel_delta = {
                name: (
                    candidate_channel_delta[name]
                    if index <= selected_index else 0.0
                )
                for index, name in enumerate(stage_order)
            }
            channel_total = float(sum(channel_delta.values()))
            if not np.isclose(channel_total, predicted_delta, atol=1e-4):
                raise ValueError("temporal stage-channel movements do not reconstruct prediction")
        else:
            candidate_channel_delta = None
            channel_delta = {
                "baseline": baseline_delta,
                "timing": 0.0,
                "semantic": semantic_delta,
                "components": 0.0,
                "relationships": 0.0,
            }
        observed_delta = (
            float(actual[step_index] - actual[step_index - 1])
            if actual is not None else None
        )

        entered_components = []
        for position, component in enumerate(components):
            index = int(component.get("index", position))
            component_start = int(component.get("startToken", component.get("start", 0)))
            component_end = int(component.get("endToken", component.get("end", 0)))
            overlap = max(0, min(end_token, component_end) - max(start_token, component_start))
            if not overlap:
                continue
            weight = float(overlap / max(1, token_count))
            allocation = {
                "componentIndex": index,
                "category": int(component.get("category", -1)),
                "text": str(component.get("text") or ""),
                "overlapTokens": int(overlap),
                "weight": weight,
                "predictedDeltaPoints": float(predicted_delta * weight),
                "predictedDropPoints": float(-predicted_delta * weight),
                "baselineDeltaPoints": float(baseline_delta * weight),
                "semanticShapeDeltaPoints": float(semantic_delta * weight),
                "channelDeltaPoints": {
                    name: float(value * weight)
                    for name, value in channel_delta.items()
                },
                "observedDeltaPoints": (
                    float(observed_delta * weight) if observed_delta is not None else None
                ),
            }
            entered_components.append(allocation)
            ledger = ledger_by_index[index]
            ledger["transitionIndices"].append(step_index - 1)
            for key in (
                "predictedDeltaPoints", "predictedDropPoints",
                "baselineDeltaPoints", "semanticShapeDeltaPoints",
            ):
                ledger[key] = float(ledger[key] + allocation[key])
            for name, value in allocation["channelDeltaPoints"].items():
                ledger["channelDeltaPoints"][name] = float(
                    ledger["channelDeltaPoints"][name] + value
                )
            if observed_delta is not None:
                ledger["observedDeltaPoints"] = float(
                    ledger["observedDeltaPoints"] + allocation["observedDeltaPoints"]
                )

        if entered_components:
            allocated_delta += predicted_delta
        else:
            time_only_delta += predicted_delta
        active = [
            int(component.get("index", position))
            for position, component in enumerate(components)
            if int(component.get("startToken", component.get("start", 0))) < cutoff
        ]
        completed = [
            int(component.get("index", position))
            for position, component in enumerate(components)
            if previous_cutoff < int(component.get("endToken", component.get("end", 0))) <= cutoff
        ]
        steps.append({
            "index": step_index - 1,
            "startSeconds": float(times[step_index - 1]),
            "endSeconds": second,
            "startRetentionPercent": float(predicted[step_index - 1]),
            "endRetentionPercent": float(predicted[step_index]),
            "predictedDeltaPoints": predicted_delta,
            "predictedDropPoints": -predicted_delta,
            "baselineDeltaPoints": baseline_delta,
            "semanticShapeDeltaPoints": semantic_delta,
            "channelDeltaPoints": channel_delta,
            "candidateChannelDeltaPoints": candidate_channel_delta,
            "observedDeltaPoints": observed_delta,
            "startToken": start_token,
            "endToken": end_token,
            "enteredTokenCount": token_count,
            "enteredText": entered_text,
            "prefixText": prefix_text,
            "activeComponentIndices": active,
            "completedComponentIndices": completed,
            "enteredComponents": entered_components,
            "driver": "prefix transition" if entered_components else "time model with unchanged prefix",
            "allocationIsCounterfactual": False,
        })
        previous_cutoff = cutoff
        previous_prefix = prefix_text

    total_predicted_delta = float(predicted[-1] - predicted[0])
    total_baseline_delta = float(baseline[-1] - baseline[0])
    total_observed_delta = float(actual[-1] - actual[0]) if actual is not None else None
    return {
        "version": 2,
        "method": "per-second causal-prefix transition ledger",
        "headlineModel": (
            " + ".join(stage_order[:stage_order.index(selected_stage) + 1])
            if modern_stage_ladder else
            "baseline(t) + individualized-prefix adjustment(t)"
        ),
        "selectedStage": selected_stage,
        "candidateStage": candidate_stage,
        "channelOrder": stage_order,
        "fullStageLadderAvailable": modern_stage_ladder,
        "claimBoundary": (
            "Every predicted transition is exact. Component allocation is exhaustive token-overlap "
            "accounting, not a causal deletion score. Candidate deletion effects are reported separately."
        ),
        "timesSeconds": times.astype(float).tolist(),
        "steps": steps,
        "componentLedger": component_rows,
        "summary": {
            "startRetentionPercent": float(predicted[0]),
            "endRetentionPercent": float(predicted[-1]),
            "totalPredictedDeltaPoints": total_predicted_delta,
            "totalPredictedDropPoints": -total_predicted_delta,
            "totalBaselineDeltaPoints": total_baseline_delta,
            "totalSemanticShapeDeltaPoints": float(total_predicted_delta - total_baseline_delta),
            "totalChannelDeltaPoints": {
                name: float(sum(
                    row["channelDeltaPoints"][name] for row in steps
                ))
                for name in stage_order
            },
            "candidateTotalChannelDeltaPoints": {
                name: float(sum(
                    (row.get("candidateChannelDeltaPoints") or row["channelDeltaPoints"])[name]
                    for row in steps
                ))
                for name in stage_order
            },
            "totalObservedDeltaPoints": total_observed_delta,
            "allocatedPrefixTransitionDeltaPoints": float(allocated_delta),
            "unassignedTimeModelDeltaPoints": float(time_only_delta),
            "transitionCount": len(steps),
            "transitionsWithEnteredText": sum(bool(row["enteredComponents"]) for row in steps),
        },
    }
