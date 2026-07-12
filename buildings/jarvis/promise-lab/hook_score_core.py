"""Dependency-light deterministic scoring primitives shared by training and serving."""

from __future__ import annotations

import itertools
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
            "spokenStartSeconds": start,
            "spokenEndSeconds": end,
            "responseWindowStartSeconds": start + float(response_lag),
            "responseWindowEndSeconds": end + float(response_lag),
        })
    return output


def percentile(sorted_values: np.ndarray, value: float) -> float:
    sorted_values = np.sort(np.asarray(sorted_values, float))
    return float(100 * np.searchsorted(sorted_values, value, side="right") / max(1, len(sorted_values)))


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


def decode_compositional_four_chunks(starts: np.ndarray, ends: np.ndarray,
                                     raw: np.ndarray, influence: np.ndarray,
                                     full: np.ndarray, category_logp: np.ndarray,
                                     lexical_tokens: np.ndarray,
                                     batch_size: int = 1024) -> dict:
    starts = np.asarray(starts, int)
    ends = np.asarray(ends, int)
    raw = row_unit(raw)
    influence = row_unit(influence)
    full = row_unit(np.asarray(full, np.float32))
    category_logp = np.asarray(category_logp, float)
    lexical_tokens = np.asarray(lexical_tokens, bool)
    token_count = int(ends.max())
    if len(lexical_tokens) != token_count:
        raise ValueError("lexical token mask does not match the hook")
    lexical_prefix = np.concatenate([[0], np.cumsum(lexical_tokens.astype(int))])
    lookup = {(int(start), int(end)): index for index, (start, end) in enumerate(zip(starts, ends))}
    partitions = []
    for cuts in itertools.combinations(range(1, token_count), 3):
        boundaries = (0, *cuts, token_count)
        if any(lexical_prefix[boundaries[index + 1]] - lexical_prefix[boundaries[index]] <= 0
               for index in range(4)):
            continue
        partitions.append([lookup[(boundaries[index], boundaries[index + 1])] for index in range(4)])
    if not partitions:
        raise ValueError("no four-part lexical exact cover exists")
    best_rows = []
    for offset in range(0, len(partitions), batch_size):
        indices = np.asarray(partitions[offset:offset + batch_size], int)
        raw_sum = raw[indices].sum(axis=1)
        influence_sum = influence[indices].sum(axis=1)
        raw_score = raw_sum @ full / (np.linalg.norm(raw_sum, axis=1) + EPS)
        influence_score = influence_sum @ full / (np.linalg.norm(influence_sum, axis=1) + EPS)
        score = (raw_score + influence_score) / 2
        for local in np.argsort(-score, kind="stable")[:2]:
            best_rows.append((
                float(score[local]), float(raw_score[local]), float(influence_score[local]),
                indices[local].tolist(),
            ))
    best_rows.sort(key=lambda row: (-row[0], row[3]))
    best = best_rows[0]
    second = next((row for row in best_rows[1:] if row[3] != best[3]), None)
    chunks = [{
        "spanIndex": int(span_index),
        "start": int(starts[span_index]),
        "end": int(ends[span_index]),
        "category": int(np.argmax(category_logp[span_index])),
    } for span_index in best[3]]
    gap = best[0] - second[0] if second else None
    return {
        "score": best[0],
        "rawReconstructionCosine": best[1],
        "influenceReconstructionCosine": best[2],
        "runnerUpScore": float(second[0]) if second else None,
        "scoreGap": float(gap) if gap is not None else None,
        "topTwoPosteriorProxy": (
            float(1 / (1 + math.exp(-min(50, gap)))) if gap is not None else 1.0
        ),
        "chunks": chunks,
        "partitionsCompared": len(partitions),
        "boundarySelectionUsesCategories": False,
        "boundarySelectionUsesOutcomes": False,
        "objective": (
            "mean cosine of the full-hook embedding with (a) the sum of isolated chunk "
            "embeddings and (b) the sum of in-context deletion-influence embeddings"
        ),
        "categoryAssignment": "maximum frozen-category posterior after boundaries are fixed",
    }


def shapley_values(scores: dict[int, float], component_count: int = 4) -> np.ndarray:
    full_mask = (1 << component_count) - 1
    missing = [mask for mask in range(full_mask + 1) if mask not in scores]
    if missing:
        raise ValueError(f"missing subset scores: {missing}")
    output = np.zeros(component_count, float)
    for component in range(component_count):
        bit = 1 << component
        for mask in range(full_mask + 1):
            if mask & bit:
                continue
            size = int(mask.bit_count())
            weight = (
                math.factorial(size) * math.factorial(component_count - size - 1)
                / math.factorial(component_count)
            )
            output[component] += weight * (scores[mask | bit] - scores[mask])
    return output


def pair_interactions(scores: dict[int, float], component_count: int = 4) -> list[dict]:
    output = []
    for left in range(component_count):
        for right in range(left + 1, component_count):
            bits = (1 << left) | (1 << right)
            value = 0.0
            for mask in range(1 << component_count):
                if mask & bits:
                    continue
                size = int(mask.bit_count())
                weight = (
                    math.factorial(size) * math.factorial(component_count - size - 2)
                    / (2 * math.factorial(component_count - 1))
                )
                value += weight * (
                    scores[mask | bits] - scores[mask | (1 << left)]
                    - scores[mask | (1 << right)] + scores[mask]
                )
            output.append({"left": left, "right": right, "interaction": float(value)})
    return output


def projection_scores(vectors_by_mask: dict[int, np.ndarray], direction: np.ndarray) -> dict[int, float]:
    direction = np.asarray(direction, np.float32)
    output = {0: 0.0}
    for mask, vector in vectors_by_mask.items():
        if int(mask) == 0:
            continue
        output[int(mask)] = float(row_unit(np.asarray(vector, np.float32)) @ direction)
    return output


def subset_texts(source_text: str, tokens: list, owners: np.ndarray,
                 component_count: int = 4) -> dict[int, str]:
    owners = np.asarray(owners, int)
    if len(tokens) != len(owners):
        raise ValueError("token ownership does not cover the source sequence")
    output = {}
    for mask in range(1, 1 << component_count):
        removed = [index for index, owner in enumerate(owners) if not mask & (1 << owner)]
        output[mask] = without(tokens, removed, source_text=source_text)
    return output
