"""Dependency-light deterministic scoring primitives shared by training and serving."""

from __future__ import annotations

import math

import numpy as np

from sequence import without


EPS = 1e-9


def row_unit(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, np.float32)
    if values.ndim == 1:
        return values / (np.linalg.norm(values) + EPS)
    return values / (np.linalg.norm(values, axis=1, keepdims=True) + EPS)


def combined_component_features(raw: np.ndarray, influence: np.ndarray) -> np.ndarray:
    """Equal-energy literal and deletion-influence blocks used by train and serve."""
    raw = row_unit(raw)
    influence = row_unit(influence)
    return np.concatenate([raw, influence], axis=1).astype(np.float32) / np.sqrt(2.0)


def apply_linear_model(features: np.ndarray, model: dict) -> np.ndarray:
    """Apply an offline-fitted compact linear model without sklearn at serving time."""
    features = row_unit(np.asarray(features, np.float32))
    if features.ndim == 1:
        features = features[None, :]
    coefficient = np.asarray(model["coefficient"], np.float32)
    if coefficient.ndim == 1:
        coefficient = coefficient[:, None]
    intercept = np.asarray(model["intercept"], np.float32).reshape(-1)
    return features @ coefficient + intercept


def outcome_prediction_payload(feature: np.ndarray, model: dict) -> dict:
    feature = row_unit(np.asarray(feature, np.float32)).reshape(1, -1)
    prediction = float(apply_linear_model(feature, model)[0, 0])
    samples = np.asarray(model.get("trainingPredictionSorted") or [], float)
    return {
        "prediction": prediction,
        "percentile": percentile(samples, prediction) if len(samples) else None,
        "mapX": prediction,
        "mapY": float(feature[0] @ np.asarray(model["mapDirection"], np.float32)),
    }


def interpolate_series(times: np.ndarray, values: np.ndarray, second: float) -> float:
    times = np.asarray(times, float)
    values = np.asarray(values, float)
    valid = np.isfinite(times) & np.isfinite(values)
    if not valid.any():
        return float("nan")
    return float(np.interp(float(second), times[valid], values[valid]))


def duration_baseline_features(response_seconds: np.ndarray) -> np.ndarray:
    seconds = np.maximum(np.asarray(response_seconds, float), 1e-4)
    return np.column_stack([seconds, seconds ** 2, np.log(seconds)]).astype(np.float32)


def apply_duration_baseline(response_seconds: np.ndarray | float,
                            model: dict) -> np.ndarray:
    """Apply the frozen duration adjustment without importing training libraries."""
    scalar = np.ndim(response_seconds) == 0
    values = np.asarray([response_seconds] if scalar else response_seconds, float)
    prediction = (
        duration_baseline_features(values) @ np.asarray(model["coefficient"], float)
        + float(model["intercept"])
    )
    return prediction[0] if scalar else prediction


def estimated_token_timeline(tokens: list[dict], owners: np.ndarray | list[int],
                             times: np.ndarray, prediction: np.ndarray,
                             words_per_second: float, response_lag: float,
                             lower: np.ndarray | None = None,
                             upper: np.ndarray | None = None) -> list[dict]:
    """Time lexical tokens at a measured average speaking rate and sample the curve."""
    owners = np.asarray(owners, int)
    words_per_second = max(float(words_per_second), EPS)
    lexical_position = 0
    output = []
    for index, token in enumerate(tokens):
        text = str(token.get("text") or "")
        if not any(character.isalnum() or character == "_" for character in text):
            continue
        spoken_start = lexical_position / words_per_second
        lexical_position += 1
        spoken_end = lexical_position / words_per_second
        response_second = spoken_end + float(response_lag)
        row = {
            "tokenIndex": int(token.get("index", index)),
            "text": text,
            "component": int(owners[index]),
            "spokenStartSeconds": spoken_start,
            "spokenEndSeconds": spoken_end,
            "responseSeconds": response_second,
            "predictedRetentionPercent": interpolate_series(
                times, prediction, response_second
            ),
        }
        if lower is not None:
            row["predictedRetentionP10"] = interpolate_series(
                times, lower, response_second
            )
        if upper is not None:
            row["predictedRetentionP90"] = interpolate_series(
                times, upper, response_second
            )
        output.append(row)
    return output


def component_response_windows(words: list[dict], component_count: int,
                               response_lag: float) -> list[dict]:
    output = []
    for component in range(int(component_count)):
        selected = [row for row in words if int(row["component"]) == component]
        if not selected:
            output.append({"component": component})
            continue
        start = min(float(row["spokenStartSeconds"]) for row in selected)
        end = max(float(row["spokenEndSeconds"]) for row in selected)
        output.append({
            "component": component,
            "category": int(selected[0]["componentCategory"]),
            "spokenStartSeconds": start,
            "spokenEndSeconds": end,
            "responseWindowStartSeconds": start + float(response_lag),
            "responseWindowEndSeconds": end + float(response_lag),
        })
    return output


def enrich_word_semantics(words: list[dict], tokens: list[dict],
                          chunks: list[dict]) -> list[dict]:
    """Attach the singleton span and exact owner-category trace to timed words."""
    token_by_index = {int(row["index"]): row for row in tokens}
    chunk_by_index = {int(row["index"]): row for row in chunks}
    for word in words:
        token = token_by_index[int(word["tokenIndex"])]
        component = chunk_by_index[int(word["component"])]
        semantic = token.get("semantic") or {}
        word.update({
            "componentCategory": int(component["category"]),
            "componentText": str(component.get("text") or ""),
            "singletonCategory": semantic.get("category"),
            "singletonFrozenAtlasCategory": semantic.get("frozenAtlasCategory"),
            "singletonCategoryProbability": semantic.get("categoryProbability"),
            "singletonCategoryDistribution": semantic.get("categoryDistribution"),
            "singletonCategoryCoordinates4D": semantic.get("categoryCoordinates4D"),
            "singletonEmbeddingX": semantic.get("mapX"),
            "singletonEmbeddingY": semantic.get("mapY"),
            "singletonGlobalSpanIndex": semantic.get("globalSpanIndex"),
            "singletonEmbeddingInput": str(token.get("text") or ""),
            "singletonCategorySource": semantic.get("categorySource"),
        })
    return words


def percentile(sorted_values: np.ndarray, value: float) -> float:
    sorted_values = np.sort(np.asarray(sorted_values, float))
    return float(100 * np.searchsorted(sorted_values, value, side="right") / max(1, len(sorted_values)))


def weighted_percentile(sorted_values: np.ndarray, sorted_weights: np.ndarray,
                        value: float) -> float:
    """Weighted empirical CDF for source-equal calibration coordinates."""
    values = np.asarray(sorted_values, float)
    weights = np.asarray(sorted_weights, float)
    if len(values) != len(weights) or not len(values) or weights.sum() <= 0:
        raise ValueError("percentile values and weights must have equal nonzero support")
    order = np.argsort(values, kind="mergesort")
    values = values[order]
    weights = weights[order]
    finish = int(np.searchsorted(values, float(value), side="right"))
    return float(100.0 * weights[:finish].sum() / weights.sum())


def category_log_probabilities(values: np.ndarray, model: dict) -> np.ndarray:
    values = np.asarray(values, np.float64)
    columns = []
    dimension = values.shape[1]
    constant = dimension * math.log(2 * math.pi)
    for row in model["clusters"]:
        mean = np.asarray(row["mean"], float)
        inverse = np.asarray(row["inverseCovariance"], float)
        delta = values - mean
        mahalanobis = np.einsum("ij,jk,ik->i", delta, inverse, delta)
        columns.append(-.5 * (mahalanobis + float(row["logDeterminant"]) + constant)
                       + math.log(max(EPS, float(row["prior"]))))
    raw = np.column_stack(columns)
    maximum = raw.max(axis=1, keepdims=True)
    raw -= maximum + np.log(np.maximum(np.exp(raw - maximum).sum(axis=1, keepdims=True), EPS))
    return raw.astype(np.float32)


def apply_category_transform(raw_span_vectors: np.ndarray, transform: dict) -> np.ndarray:
    raw = row_unit(raw_span_vectors)
    residual = row_unit(raw - raw.mean(axis=0, keepdims=True))
    mean = np.asarray(transform["pcaMean"], np.float32)
    components = np.asarray(transform["pcaComponents"], np.float32)
    scale = np.asarray(transform["whiteningScale"], np.float32)
    return ((residual - mean) @ components.T / np.maximum(scale, EPS)).astype(np.float32)


def decode_variable_chunks(starts: np.ndarray, ends: np.ndarray,
                           boundary_probability: np.ndarray,
                           category_logp: np.ndarray,
                           lexical_tokens: np.ndarray) -> dict:
    """Decode the maximum-posterior boundary set as a lexical exact cover."""
    starts = np.asarray(starts, int)
    ends = np.asarray(ends, int)
    boundary_probability = np.asarray(boundary_probability, float)
    category_logp = np.asarray(category_logp, float)
    lexical_tokens = np.asarray(lexical_tokens, bool)
    if not (len(starts) == len(ends) == len(category_logp)):
        raise ValueError("variable exact-cover inputs do not have matching rows")
    token_count = int(ends.max())
    if len(lexical_tokens) != token_count:
        raise ValueError("lexical token mask does not match the hook")
    if len(boundary_probability) != max(0, token_count - 1):
        raise ValueError("boundary probabilities must contain one row per token gap")

    lexical_prefix = np.concatenate([[0], np.cumsum(lexical_tokens.astype(int))])
    lookup = {(int(start), int(end)): index
              for index, (start, end) in enumerate(zip(starts, ends))}
    clipped = np.clip(boundary_probability, EPS, 1 - EPS)
    selected_log = np.log(clipped)
    rejected_log = np.log1p(-clipped)
    rejected_prefix = np.concatenate([[0.0], np.cumsum(rejected_log)])

    paths: dict[int, list[tuple[float, tuple[int, ...]]]] = {0: [(0.0, ())]}
    partition_counts = [0] * (token_count + 1)
    partition_counts[0] = 1
    for position in range(token_count):
        current = paths.get(position) or []
        if not current:
            continue
        for finish in range(position + 1, token_count + 1):
            if lexical_prefix[finish] - lexical_prefix[position] <= 0:
                continue
            span_index = lookup[(position, finish)]
            # Every gap inside the segment is rejected; its terminal gap is
            # selected unless this is the final segment.
            increment = float(rejected_prefix[finish - 1] - rejected_prefix[position])
            if finish < token_count:
                increment += float(selected_log[finish - 1])
            partition_counts[finish] += partition_counts[position]
            candidates = paths.setdefault(finish, [])
            candidates.extend((score + increment, selected + (span_index,))
                              for score, selected in current)
            unique = {}
            for score, selected in candidates:
                if selected not in unique or score > unique[selected]:
                    unique[selected] = score
            paths[finish] = sorted(
                ((score, selected) for selected, score in unique.items()),
                key=lambda row: (-row[0], row[1]),
            )[:2]

    finalists = paths.get(token_count) or []
    if not finalists:
        raise ValueError("no lexical variable-length exact cover exists")
    best_score, best_indices = finalists[0]
    second = finalists[1] if len(finalists) > 1 else None
    gap = best_score - second[0] if second else None
    chunks = []
    for span_index in best_indices:
        row = {
            "spanIndex": int(span_index),
            "start": int(starts[span_index]),
            "end": int(ends[span_index]),
            "category": int(np.argmax(category_logp[span_index])),
            "leftBoundaryProbability": (
                float(boundary_probability[int(starts[span_index]) - 1])
                if int(starts[span_index]) > 0 else None
            ),
            "rightBoundaryProbability": (
                float(boundary_probability[int(ends[span_index]) - 1])
                if int(ends[span_index]) < token_count else None
            ),
        }
        chunks.append(row)
    return {
        "score": float(best_score),
        "runnerUpScore": float(second[0]) if second else None,
        "scoreGap": float(gap) if gap is not None else None,
        "topTwoPosteriorProxy": (
            float(1 / (1 + math.exp(-min(50, gap)))) if gap is not None else 1.0
        ),
        "chunks": chunks,
        "componentCount": len(chunks),
        "partitionsCompared": int(partition_counts[token_count]),
        "boundarySelectionUsesCategories": False,
        "boundarySelectionUsesOutcomes": False,
        "componentCountConstraint": None,
        "objective": (
            "maximum Bernoulli posterior over every learned cut versus non-cut decision, "
            "subject only to contiguous complete coverage and lexical content"
        ),
        "complexityControl": (
            "each possible token gap contributes its learned cut or non-cut probability; "
            "there is no chosen k, maximum count, duration rule, significance threshold, "
            "or tuned split penalty"
        ),
        "categoryAssignment": "maximum frozen-category posterior after boundaries are fixed",
    }


def support_calibrated_count_prior(token_count: int, extension: dict) -> np.ndarray:
    """Condition the empirical component-length renewal process on exact coverage."""
    n = int(token_count)
    probabilities = np.zeros(n + 1, np.float64)
    for row in extension.get("componentLengthDistribution") or []:
        length = int(row["tokens"])
        if 1 <= length <= n:
            probabilities[length] = float(row["probability"])
    total = float(probabilities.sum())
    if total <= EPS:
        raise ValueError("the horizon extension has no supported component lengths")
    probabilities /= total
    renewal = np.zeros((n + 1, n + 1), np.float64)
    renewal[0, 0] = 1.0
    supported_lengths = np.flatnonzero(probabilities > 0)
    for count in range(1, n + 1):
        for length in supported_lengths:
            if length > n:
                continue
            renewal[count, length:] += (
                renewal[count - 1, :n + 1 - length] * probabilities[length]
            )
    mass = renewal[:, n]
    mass_sum = float(mass.sum())
    if mass_sum <= EPS:
        raise ValueError(f"the learned component-length process cannot cover {n} tokens")
    return (mass / mass_sum).astype(np.float64)


def decode_support_calibrated_chunks(starts: np.ndarray, ends: np.ndarray,
                                     boundary_probability: np.ndarray,
                                     category_logp: np.ndarray,
                                     lexical_tokens: np.ndarray,
                                     extension: dict) -> dict:
    """Extend the exact-cover decoder beyond training length without a chosen k.

    The learned cut/non-cut likelihood is marginalized across every valid cover
    to select a component count. Within that count, the original boundary
    likelihood ranks covers unchanged. The empirical component-length renewal
    distribution is reported only as a sensitivity comparison.
    """
    starts = np.asarray(starts, int)
    ends = np.asarray(ends, int)
    boundary_probability = np.asarray(boundary_probability, float)
    category_logp = np.asarray(category_logp, float)
    lexical_tokens = np.asarray(lexical_tokens, bool)
    if not (len(starts) == len(ends) == len(category_logp)):
        raise ValueError("support-calibrated exact-cover inputs do not have matching rows")
    token_count = int(ends.max())
    if len(lexical_tokens) != token_count:
        raise ValueError("lexical token mask does not match the opening")
    if len(boundary_probability) != max(0, token_count - 1):
        raise ValueError("boundary probabilities must contain one row per token gap")
    maximum_span = int(extension.get("maximumObservedComponentTokens") or 0)
    if maximum_span < 1:
        raise ValueError("the horizon extension has no measured component-length support")

    try:
        renewal_sensitivity = support_calibrated_count_prior(token_count, extension)
    except ValueError:
        renewal_sensitivity = np.zeros(token_count + 1, np.float64)
    lexical_prefix = np.concatenate([[0], np.cumsum(lexical_tokens.astype(int))])
    lookup = {
        (int(start), int(end)): index
        for index, (start, end) in enumerate(zip(starts, ends))
    }
    clipped = np.clip(boundary_probability, EPS, 1 - EPS)
    selected_log = np.log(clipped)
    rejected_log = np.log1p(-clipped)
    rejected_prefix = np.concatenate([[0.0], np.cumsum(rejected_log)])

    best: dict[tuple[int, int], list[tuple[float, tuple[int, ...]]]] = {
        (0, 0): [(0.0, ())],
    }
    boundary_log_mass: dict[tuple[int, int], float] = {(0, 0): 0.0}
    partition_counts: dict[tuple[int, int], int] = {(0, 0): 1}
    for position in range(token_count):
        for count in range(position + 1):
            state = (position, count)
            current = best.get(state)
            if not current:
                continue
            for finish in range(
                position + 1, min(token_count, position + maximum_span) + 1,
            ):
                if lexical_prefix[finish] - lexical_prefix[position] <= 0:
                    continue
                span_index = lookup[(position, finish)]
                increment = float(
                    rejected_prefix[finish - 1] - rejected_prefix[position]
                )
                if finish < token_count:
                    increment += float(selected_log[finish - 1])
                target = (finish, count + 1)
                candidates = best.setdefault(target, [])
                candidates.extend(
                    (score + increment, selected + (span_index,))
                    for score, selected in current
                )
                unique = {}
                for score, selected in candidates:
                    if selected not in unique or score > unique[selected]:
                        unique[selected] = score
                best[target] = sorted(
                    ((score, selected) for selected, score in unique.items()),
                    key=lambda row: (-row[0], row[1]),
                )[:2]
                source_boundary_mass = boundary_log_mass[state] + increment
                boundary_log_mass[target] = float(np.logaddexp(
                    boundary_log_mass.get(target, -np.inf), source_boundary_mass,
                ))
                partition_counts[target] = (
                    partition_counts.get(target, 0) + partition_counts[state]
                )

    supported_counts = []
    for count in range(1, token_count + 1):
        state = (token_count, count)
        paths = best.get(state) or []
        if not paths or not np.isfinite(boundary_log_mass.get(state, np.nan)):
            continue
        supported_counts.append(count)
    if not supported_counts:
        raise ValueError("no support-calibrated lexical exact cover exists")
    count_log_normalizer = float(np.logaddexp.reduce([
        boundary_log_mass[(token_count, count)] for count in supported_counts
    ]))
    boundary_count_posterior = {
        count: float(math.exp(
            boundary_log_mass[(token_count, count)] - count_log_normalizer
        ))
        for count in supported_counts
    }
    count_rows = [{
        "componentCount": count,
        "boundaryCountPosteriorProbability": boundary_count_posterior[count],
        "renewalSensitivityProbability": float(renewal_sensitivity[count]),
        "validBoundaryLogMass": float(boundary_log_mass[(token_count, count)]),
        "validPartitions": int(partition_counts[(token_count, count)]),
    } for count in supported_counts]
    selected_count = max(
        supported_counts, key=lambda count: (boundary_count_posterior[count], -count),
    )
    selected_state = (token_count, selected_count)
    conditional_normalizer = float(boundary_log_mass[selected_state])
    finalists = [
        (
            float(
                boundary_score - conditional_normalizer
                + math.log(boundary_count_posterior[selected_count])
            ),
            boundary_score, selected, selected_count,
        )
        for boundary_score, selected in (best[selected_state] or [])
    ]
    finalists.sort(key=lambda row: (-row[0], row[2]))
    best_score, best_boundary_score, best_indices, _ = finalists[0]
    second = finalists[1] if len(finalists) > 1 else None
    chunks = []
    for span_index in best_indices:
        chunks.append({
            "spanIndex": int(span_index),
            "start": int(starts[span_index]),
            "end": int(ends[span_index]),
            "category": int(np.argmax(category_logp[span_index])),
            "leftBoundaryProbability": (
                float(boundary_probability[int(starts[span_index]) - 1])
                if int(starts[span_index]) > 0 else None
            ),
            "rightBoundaryProbability": (
                float(boundary_probability[int(ends[span_index]) - 1])
                if int(ends[span_index]) < token_count else None
            ),
        })
    return {
        "score": float(best_score),
        "boundaryLogLikelihood": float(best_boundary_score),
        "runnerUpScore": float(second[0]) if second else None,
        "scoreGap": float(best_score - second[0]) if second else None,
        "topTwoPosteriorProxy": (
            float(1 / (1 + math.exp(-min(50, best_score - second[0]))))
            if second else 1.0
        ),
        "chunks": chunks,
        "componentCount": len(chunks),
        "partitionsCompared": int(sum(
            partition_counts.get((token_count, count), 0)
            for count in range(1, token_count + 1)
        )),
        "boundarySelectionUsesCategories": False,
        "boundarySelectionUsesOutcomes": False,
        "componentCountConstraint": None,
        "maximumComponentTokens": maximum_span,
        "maximumComponentTokensSource": "largest measured canonical training component",
        "selectedCountBoundaryPosteriorProbability": float(
            boundary_count_posterior[selected_count]
        ),
        "selectedCountRenewalSensitivityProbability": float(
            renewal_sensitivity[selected_count]
        ),
        "countSelectionPolicy": (
            "posterior mode of the marginalized learned cut/non-cut likelihood first; "
            "maximum original boundary likelihood conditional on that count second"
        ),
        "countPrior": count_rows,
        "objective": (
            "marginalize learned cut/non-cut likelihood over every valid cover to select "
            "component count, then select the maximum-likelihood cover within that count"
        ),
        "complexityControl": (
            "no chosen component count, duration window, or split penalty; count comes from "
            "the learned boundary posterior and maximum span support comes from measured "
            "canonical components"
        ),
        "categoryAssignment": "maximum frozen-category posterior after boundaries are fixed",
        "horizonCalibration": {
            "status": "training-support-calibrated",
            "method": extension.get("method"),
            "activationTokenThreshold": extension.get("activationTokenThreshold"),
            "trainingSources": extension.get("trainingSources"),
            "trainingComponents": extension.get("trainingComponents"),
            "sourceEqualLengthWeights": extension.get("sourceEqualLengthWeights"),
            "boundaryCountValidation": extension.get("boundaryCountValidation"),
            "outcomesUsed": False,
            "categoriesUsedToChooseBoundaries": False,
        },
    }


def local_counterfactual_texts(source_text: str, tokens: list,
                               owners: np.ndarray, component_count: int) -> dict:
    """Materialize exact O(n^2) local deletion and retained-pair texts."""
    owners = np.asarray(owners, int)
    if len(tokens) != len(owners):
        raise ValueError("token ownership does not cover the source sequence")
    if set(owners.tolist()) != set(range(int(component_count))):
        raise ValueError("component owners must be contiguous from zero")
    without_one = {}
    without_pair = {}
    pair_only = {}
    for component in range(int(component_count)):
        removed = [index for index, owner in enumerate(owners) if owner == component]
        without_one[component] = without(tokens, removed, source_text=source_text)
    for left in range(int(component_count)):
        for right in range(left + 1, int(component_count)):
            without_pair[(left, right)] = without(
                tokens,
                [index for index, owner in enumerate(owners) if owner in (left, right)],
                source_text=source_text,
            )
            pair_only[(left, right)] = without(
                tokens,
                [index for index, owner in enumerate(owners) if owner not in (left, right)],
                source_text=source_text,
            )
    return {
        "withoutOne": without_one,
        "withoutPair": without_pair,
        "pairOnly": pair_only,
        "componentCount": int(component_count),
        "definition": (
            "full-context one-component deletions and two-component deletions, plus retained "
            "ordered pairs; source order and every retained source character are preserved"
        ),
    }
