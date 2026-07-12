#!/usr/bin/env python3
"""Score one hook with the frozen Promise Lab axis without a generative LLM."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

from embedding_store import EmbeddingStore, R2Store, json_ready
from hook_score_core import (
    apply_linear_model,
    apply_category_transform,
    category_log_probabilities,
    combined_component_features,
    component_response_windows,
    decode_compositional_four_chunks,
    estimated_token_timeline,
    outcome_prediction_payload,
    pair_interactions,
    percentile,
    projection_scores,
    row_unit,
    shapley_values,
    subset_texts,
)
from sequence import all_spans, normalize_source, surface, tokenize, without_span


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
REMOTE_PREFIX = "longform/promise-lab-v4"
MODEL_FILE = "hook-quality-model.json"
PARTITION_FILE = "canonical-partition-model.json"
OUTCOME_MODEL_FILE = "hook-outcome-model.json"
SCORER_VERSION = "deterministic-hook-scorer-v3-outcome-atlas"
MAX_HOOK_TOKENS = 64


def _decode_json(payload: bytes) -> dict:
    try:
        payload = gzip.decompress(payload)
    except (gzip.BadGzipFile, OSError):
        pass
    return json.loads(payload.decode("utf-8"))


def load_artifact(filename: str, refresh: bool = False) -> dict:
    local = CACHE / filename
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8"))
    runtime = Path(os.environ.get("PROMISE_HOOK_RUNTIME_CACHE", "/tmp/businessworld-promise-hook"))
    runtime.mkdir(parents=True, exist_ok=True)
    cached = runtime / filename
    if cached.exists() and not refresh and time.time() - cached.stat().st_mtime < 3600:
        return json.loads(cached.read_text(encoding="utf-8"))
    payload = R2Store().get_bytes(f"{REMOTE_PREFIX}/{filename}.gz")
    if not payload:
        raise RuntimeError(f"Promise Lab artifact is unavailable: {filename}")
    value = _decode_json(payload)
    temporary = cached.with_suffix(cached.suffix + ".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, cached)
    return value


def _embedding_cache_path() -> Path:
    if CACHE.exists() and (CACHE / MODEL_FILE).exists():
        return CACHE / "hook-live-embeddings.sqlite3"
    return Path(os.environ.get(
        "PROMISE_HOOK_EMBED_CACHE", "/tmp/businessworld-promise-hook/embeddings.sqlite3",
    ))


def build_span_primitives(text: str, store: EmbeddingStore) -> dict:
    text = normalize_source(text)
    tokens = tokenize(text)
    if len(tokens) > MAX_HOOK_TOKENS:
        raise ValueError(
            f"a hook can contain at most {MAX_HOOK_TOKENS} tokens; received {len(tokens)}"
        )
    lexical = np.asarray([
        any(character.isalnum() or character == "_" for character in token.text)
        for token in tokens
    ], bool)
    if int(lexical.sum()) < 4:
        raise ValueError("a hook needs at least four lexical atoms for the frozen four-part decoder")
    spans = all_spans(len(tokens))
    span_texts = [surface(tokens, span.start, span.end, source_text=text) for span in spans]
    context_texts = [without_span(tokens, span.start, span.end, source_text=text) for span in spans]
    required = [text, *span_texts, *[value for value in context_texts if value]]
    vectors = store.embed_many(required)
    full = row_unit(vectors[text])
    raw = np.asarray([row_unit(vectors[value]) for value in span_texts], np.float32)
    contexts = np.asarray([
        row_unit(vectors[value]) if value else np.zeros_like(full)
        for value in context_texts
    ], np.float32)
    influence = row_unit(full[None, :] - contexts)
    return {
        "text": text,
        "tokens": tokens,
        "starts": np.asarray([span.start for span in spans], int),
        "ends": np.asarray([span.end for span in spans], int),
        "spanTexts": span_texts,
        "raw": raw,
        "context": contexts,
        "influence": influence,
        "full": full,
        "lexical": lexical,
        "embeddingInputs": len(set(required)),
    }


def decode_partition(primitives: dict, partition_model: dict) -> dict:
    category_values = apply_category_transform(
        primitives["raw"], partition_model["categoryTransform"],
    )
    logp = category_log_probabilities(category_values, partition_model["categoryModel"])
    decoded = decode_compositional_four_chunks(
        primitives["starts"], primitives["ends"], primitives["raw"],
        primitives["influence"], primitives["full"], logp, primitives["lexical"],
    )
    tokens = primitives["tokens"]
    owners = np.full(len(tokens), -1, int)
    chunks = []
    for index, chunk in enumerate(decoded["chunks"]):
        span_index = int(chunk["spanIndex"])
        start = int(chunk["start"]); end = int(chunk["end"])
        owners[start:end] = index
        probability = np.exp(logp[span_index])
        category = int(chunk["category"])
        chunks.append({
            "index": index,
            "start": start, "end": end,
            "text": surface(tokens, start, end, source_text=primitives["text"]),
            "category": category,
            "categoryProbability": float(probability[category]),
            "categoryDistribution": probability.astype(float).tolist(),
        })
    if (owners < 0).any() or any(np.sum(owners == index) == 0 for index in range(4)):
        raise RuntimeError("decoder did not produce one exact non-overlapping owner per token")
    gap_calibration = np.asarray(
        partition_model["partitionCalibration"]["scoreGapsSorted"], float,
    )
    return {
        **{key: decoded[key] for key in (
            "score", "runnerUpScore", "scoreGap", "topTwoPosteriorProxy",
            "rawReconstructionCosine", "influenceReconstructionCosine",
            "partitionsCompared", "objective",
        )},
        "scoreGapPercentile": percentile(gap_calibration, float(decoded["scoreGap"] or 0)),
        "chunks": chunks,
        "owners": owners,
        "tokens": [{
            "index": token.index, "text": token.text,
            "start": token.start, "end": token.end, "owner": int(owners[token.index]),
        } for token in tokens],
        "coverage": 1.0,
        "overlapCount": 0,
    }


def _bootstrap_attribution(vectors: dict[int, np.ndarray], model: dict) -> tuple[np.ndarray, np.ndarray]:
    directions = np.asarray(model.get("bootstrapDirections") or [], np.float32)
    component_rows = []
    pair_rows = []
    for direction in directions:
        scores = projection_scores(vectors, direction)
        component_rows.append(shapley_values(scores, 4))
        pair_rows.append([row["interaction"] for row in pair_interactions(scores, 4)])
    return np.asarray(component_rows, float), np.asarray(pair_rows, float)


def _score_forward_response(primitives: dict, partition: dict,
                            vectors: dict[int, np.ndarray], components: list[dict],
                            interactions: list[dict], model: dict) -> dict | None:
    forward = model.get("forwardResponse") or {}
    if not forward or not forward.get("validated"):
        return None
    component_model = (forward.get("component") or {}).get("modelsByCategory") or {}
    starts = np.asarray(primitives["starts"], int)
    ends = np.asarray(primitives["ends"], int)
    component_percentiles = []
    for index, (chunk, component) in enumerate(zip(partition["chunks"], components)):
        matches = np.flatnonzero(
            (starts == int(chunk["start"])) & (ends == int(chunk["end"]))
        )
        if len(matches) != 1:
            raise RuntimeError("decoded component is missing from the exact span tensor")
        span_index = int(matches[0])
        category = str(int(chunk["category"]))
        category_model = component_model.get(category)
        if not category_model:
            raise RuntimeError(f"forward-response category model is missing: {category}")
        feature = combined_component_features(
            primitives["raw"][span_index:span_index + 1],
            primitives["influence"][span_index:span_index + 1],
        )[0]
        coordinate = float(feature @ np.asarray(category_model["direction"], np.float32))
        map_y = float(feature @ np.asarray(category_model["mapDirection"], np.float32))
        axis_percentile = percentile(
            np.asarray(category_model["trainingProjectionSorted"], float), coordinate,
        )
        validation = category_model.get("validation") or {}
        component["forwardResponse"] = {
            "label": "Predicted forward retention response",
            "axisCoordinate": coordinate,
            "mapY": map_y,
            "percentile": axis_percentile,
            "category": int(category),
            "heldoutSpearmanForCategory": validation.get("heldoutSpearman"),
            "foldDirectionStability": validation.get("foldDirectionStability"),
            "metricId": (forward.get("metricContract") or {}).get("selectedCandidate"),
        }
        component_percentiles.append(axis_percentile)

    subset_features = {}
    full = np.asarray(vectors[15], np.float32)
    for mask in range(1, 16):
        raw = np.asarray(vectors[mask], np.float32)
        complement = 15 ^ mask
        context = (
            np.zeros_like(full) if complement == 0
            else np.asarray(vectors[complement], np.float32)
        )
        influence = row_unit(full - context)
        subset_features[mask] = combined_component_features(
            raw[None, :], influence[None, :]
        )[0]

    relationship = forward.get("relationship") or {}
    calibration = relationship.get("calibrationByCategoryPair") or {}
    interaction_lookup = {
        (int(row["left"]), int(row["right"])): row for row in interactions
    }
    for right in range(1, 4):
        category = str(int(components[right]["category"]))
        direction = np.asarray(component_model[category]["direction"], np.float32)
        scores = {0: 0.0}
        scores.update({
            mask: float(feature @ direction) for mask, feature in subset_features.items()
        })
        for row in pair_interactions(scores, 4):
            left = int(row["left"])
            if int(row["right"]) != right:
                continue
            target = interaction_lookup[(left, right)]
            category_pair = f"{components[left]['category']}->{components[right]['category']}"
            samples = np.asarray(calibration.get(category_pair) or [], float)
            target["forwardResponse"] = {
                "interaction": float(row["interaction"]),
                "percentile": (
                    percentile(samples, float(row["interaction"])) if len(samples) else None
                ),
                "categoryPair": category_pair,
                "definition": relationship.get("definition"),
                "validationSource": relationship.get("validationSource"),
            }

    whole = forward.get("wholeHook") or {}
    standalone = relationship.get("standaloneObservedResidualAudit") or {}
    composite_coordinate = float(np.mean(component_percentiles))
    composite_training = np.asarray(whole.get("trainingCompositeSorted") or [], float)
    return {
        "status": "complete",
        "validatedAtComponentLevel": True,
        "metric": forward.get("metricContract"),
        "componentValidation": (forward.get("component") or {}).get("validation"),
        "components": [row["forwardResponse"] for row in components],
        "relationships": [row.get("forwardResponse") for row in interactions],
        "exploratoryWholeHookComposite": {
            "accepted": False,
            "coordinate": composite_coordinate,
            "percentile": (
                percentile(composite_training, composite_coordinate)
                if len(composite_training) else None
            ),
            "definition": whole.get("definition"),
            "validation": whole.get("validation"),
            "reason": (
                "the four component axes validate individually, but their equal-mean aggregate "
                "did not validate as a separate whole-hook target"
            ),
        },
        "standaloneRelationshipAudit": {
            "accepted": standalone.get("accepted"),
            "selectedRepresentation": standalone.get("selectedRepresentation"),
            "targetDefinition": standalone.get("targetDefinition"),
            "validation": standalone.get("validation"),
        },
    }


def _prediction_interval(payload: dict, model: dict) -> dict:
    validation = model.get("validation") or {}
    prediction = float(payload["prediction"])
    payload.update({
        "predictionP10": prediction + float(validation.get("residualP10") or 0),
        "predictionP90": prediction + float(validation.get("residualP90") or 0),
        "validation": validation,
    })
    return payload


def _score_outcomes(primitives: dict, partition: dict, components: list[dict],
                    outcome_model: dict) -> dict:
    targets = outcome_model.get("targets") or {}
    hook_models = outcome_model.get("hookModels") or {}
    component_models = outcome_model.get("componentModels") or {}
    hook_predictions = {}
    for target_name, target_meta in targets.items():
        model = hook_models[target_name]
        hook_predictions[target_name] = {
            **_prediction_interval(
                outcome_prediction_payload(primitives["full"], model), model,
            ),
            "target": target_name,
            "targetMeta": target_meta,
        }

    starts = np.asarray(primitives["starts"], int)
    ends = np.asarray(primitives["ends"], int)
    component_predictions = []
    for chunk, component in zip(partition["chunks"], components):
        matches = np.flatnonzero(
            (starts == int(chunk["start"])) & (ends == int(chunk["end"]))
        )
        if len(matches) != 1:
            raise RuntimeError("decoded component is missing from the outcome tensor")
        span_index = int(matches[0])
        feature = combined_component_features(
            primitives["raw"][span_index:span_index + 1],
            primitives["influence"][span_index:span_index + 1],
        )[0]
        category = str(int(chunk["category"]))
        outcomes = {}
        for target_name, target_meta in targets.items():
            target_model = component_models[target_name]
            model = target_model["modelsByCategory"][category]
            outcomes[target_name] = {
                **_prediction_interval(
                    outcome_prediction_payload(feature, model), model,
                ),
                "target": target_name,
                "targetMeta": target_meta,
                "category": int(category),
                "sourceAggregateValidation": target_model.get(
                    "sourceAggregateValidation"
                ),
            }
        component["outcomePredictions"] = outcomes
        component_predictions.append({
            "index": int(component["index"]),
            "category": int(category),
            "text": component["text"],
            "outcomes": outcomes,
        })

    curve_model = outcome_model["curveModel"]
    times = np.asarray(curve_model["timesSeconds"], np.float32)
    predicted = apply_linear_model(primitives["full"], curve_model)[0]
    lower = predicted + np.asarray(curve_model["residualP10ByTime"], np.float32)
    upper = predicted + np.asarray(curve_model["residualP90ByTime"], np.float32)
    rate = outcome_model.get("speakingRate") or {}
    response_lag = float(outcome_model.get("responseLagSeconds") or 0)
    words = estimated_token_timeline(
        partition["tokens"], partition["owners"], times, predicted,
        float(rate.get("meanWordsPerSecond") or 1), response_lag, lower, upper,
    )
    return {
        "status": "complete",
        "methodVersion": outcome_model.get("methodVersion"),
        "targets": targets,
        "hook": hook_predictions,
        "components": component_predictions,
        "retentionForecast": {
            "status": (curve_model.get("validation") or {}).get("status"),
            "timesSeconds": times.astype(float).tolist(),
            "predictedPercent": predicted.astype(float).tolist(),
            "predictionP10": lower.astype(float).tolist(),
            "predictionP90": upper.astype(float).tolist(),
            "validation": curve_model.get("validation"),
            "speakingRate": rate,
            "responseLagSeconds": response_lag,
            "wordTimingPolicy": "library-average speaking rate",
            "words": words,
            "componentWindows": component_response_windows(
                words, len(components), response_lag,
            ),
        },
    }


def score_text(text: str, model: dict | None = None, partition_model: dict | None = None,
               store: EmbeddingStore | None = None,
               outcome_model: dict | None = None) -> dict:
    model = model or load_artifact(MODEL_FILE)
    partition_model = partition_model or load_artifact(PARTITION_FILE)
    outcome_model = outcome_model or load_artifact(OUTCOME_MODEL_FILE)
    owned_store = store is None
    store = store or EmbeddingStore(_embedding_cache_path())
    try:
        primitives = build_span_primitives(text, store)
        partition = decode_partition(primitives, partition_model)
        subset_input = subset_texts(
            primitives["text"], primitives["tokens"], partition["owners"], 4,
        )
        missing = [value for mask, value in subset_input.items() if mask != 15 and value]
        embedded = store.embed_many(missing)
        vectors = {
            mask: primitives["full"] if mask == 15 else embedded[value]
            for mask, value in subset_input.items()
        }
    finally:
        if owned_store:
            store.close()

    direction = np.asarray(model["qualityDirection"], np.float32)
    scores = projection_scores(vectors, direction)
    shapley = shapley_values(scores, 4)
    interactions = pair_interactions(scores, 4)
    bootstrap_components, bootstrap_pairs = _bootstrap_attribution(vectors, model)
    training_projection = np.asarray(model["trainingProjectionsSorted"], float)
    full_coordinate = scores[15]
    axis_percentile = percentile(training_projection, full_coordinate)

    bootstrap_directions = np.asarray(model.get("bootstrapDirections") or [], np.float32)
    bootstrap_training = np.asarray(model.get("bootstrapTrainingProjectionsSorted") or [], float)
    bootstrap_coordinates = bootstrap_directions @ primitives["full"] if len(bootstrap_directions) else np.asarray([])
    bootstrap_percentiles = np.asarray([
        percentile(training, value)
        for training, value in zip(bootstrap_training, bootstrap_coordinates)
    ], float)

    training_embeddings = np.asarray(model["trainingFullEmbeddings"], np.float32)
    similarities = training_embeddings @ primitives["full"]
    nearest_order = np.argsort(-similarities, kind="stable")[:5]
    nearest = [{
        "videoId": model["trainingIds"][index],
        "text": model["trainingTexts"][index],
        "cosine": float(similarities[index]),
    } for index in nearest_order]
    nearest_cosine = float(similarities[nearest_order[0]])
    domain_percentile = percentile(
        np.asarray(model["leaveOneOutNearestCosineSorted"], float), nearest_cosine,
    )

    components = []
    for index, (chunk, value) in enumerate(zip(partition["chunks"], shapley)):
        category_key = str(chunk["category"])
        samples = bootstrap_components[:, index] if len(bootstrap_components) else np.asarray([])
        components.append({
            **chunk,
            "shapleyAxisContribution": float(value),
            "categoryContributionPercentile": percentile(
                np.asarray(model["categoryShapleyCalibration"][category_key], float), float(value),
            ),
            "singletonAxisCoordinate": float(scores[1 << index]),
            "deletionEffect": float(scores[15] - scores[15 ^ (1 << index)]),
            "bootstrapP10": float(np.quantile(samples, .1)) if len(samples) else None,
            "bootstrapMedian": float(np.median(samples)) if len(samples) else None,
            "bootstrapP90": float(np.quantile(samples, .9)) if len(samples) else None,
            "bootstrapPositiveFraction": float(np.mean(samples > 0)) if len(samples) else None,
        })

    for pair_index, row in enumerate(interactions):
        left = int(row["left"]); right = int(row["right"])
        pair_key = f"{components[left]['category']}->{components[right]['category']}"
        calibration = np.asarray(model["pairInteractionCalibration"].get(pair_key) or [], float)
        samples = bootstrap_pairs[:, pair_index] if len(bootstrap_pairs) else np.asarray([])
        row.update({
            "categoryPair": pair_key,
            "interactionPercentile": percentile(calibration, row["interaction"]) if len(calibration) else None,
            "bootstrapP10": float(np.quantile(samples, .1)) if len(samples) else None,
            "bootstrapMedian": float(np.median(samples)) if len(samples) else None,
            "bootstrapP90": float(np.quantile(samples, .9)) if len(samples) else None,
            "bootstrapPositiveFraction": float(np.mean(samples > 0)) if len(samples) else None,
        })

    forward_response = _score_forward_response(
        primitives, partition, vectors, components, interactions, model,
    )
    outcomes = _score_outcomes(
        primitives, partition, components, outcome_model,
    )

    validation = model["validation"]
    stable_payload = f"{SCORER_VERSION}\0{model['methodVersion']}\0{primitives['text']}"
    return {
        "version": 1,
        "status": "complete",
        "id": hashlib.sha256(stable_payload.encode("utf-8")).hexdigest()[:20],
        "scorerVersion": SCORER_VERSION,
        "modelVersion": model["methodVersion"],
        "input": {
            "hookText": primitives["text"],
            "embeddingModel": model["embeddingModel"],
            "embeddingDimensions": model["embeddingDimensions"],
            "fullHookEmbeddingInput": primitives["text"],
            "spanEmbeddingInputs": primitives["embeddingInputs"],
            "generativeLlmUsed": False,
        },
        "score": {
            "label": "Hook retained-information percentile",
            "axisCoordinate": full_coordinate,
            "percentile": axis_percentile,
            "higherMeans": model["target"]["higherMeans"],
            "definition": model["scoreDefinition"],
        },
        "confidence": {
            "heldoutSpearman": validation["heldoutSpearman"],
            "heldoutPearson": validation["heldoutPearson"],
            "familyCorrectedSignFlipP": validation["signFlipP"],
            "foldDirectionMedianCosine": validation["foldDirectionMedianCosine"],
            "bootstrapPercentileP10": float(np.quantile(bootstrap_percentiles, .1)) if len(bootstrap_percentiles) else None,
            "bootstrapPercentileMedian": float(np.median(bootstrap_percentiles)) if len(bootstrap_percentiles) else None,
            "bootstrapPercentileP90": float(np.quantile(bootstrap_percentiles, .9)) if len(bootstrap_percentiles) else None,
            "nearestTrainingCosine": nearest_cosine,
            "inDomainSimilarityPercentile": domain_percentile,
            "partitionScoreGap": partition["scoreGap"],
            "partitionScoreGapPercentile": partition["scoreGapPercentile"],
        },
        "map": {
            "x": full_coordinate,
            "y": float(primitives["full"] @ np.asarray(model["mapOrthogonalDirection"], np.float32)),
            "xDefinition": "frozen quality-axis coordinate",
            "yDefinition": "largest remaining semantic direction orthogonal to quality",
        },
        "partition": {
            key: value for key, value in partition.items() if key != "owners"
        },
        "components": components,
        "pairInteractions": interactions,
        "subsets": [{
            "mask": mask,
            "includedComponents": [index for index in range(4) if mask & (1 << index)],
            "embeddingInput": subset_input[mask],
            "axisCoordinate": float(scores[mask]),
        } for mask in range(1, 16)],
        "emptySubsetConvention": {
            "mask": 0, "axisCoordinate": 0.0,
            "reason": "Gemini does not embed empty content; zero is the declared additive origin",
        },
        "nearestTrainingHooks": nearest,
        "target": model["target"],
        "latency": {
            "legacyWholeHookAxisTest": model["latencyDecision"],
            "forwardComponentMetric": (
                forward_response.get("metric") if forward_response else None
            ),
        },
        "forwardResponse": forward_response,
        "outcomes": outcomes,
        "provenance": {
            "outcomeUsedForBoundaries": False,
            "outcomeUsedForQualityAxis": True,
            "examplesUsedForTraining": False,
            "componentAttribution": model["componentDefinition"],
            "forwardResponseOutcomeUsedForTiming": bool(forward_response),
            "forwardResponseBoundariesChanged": False,
            "outcomeModelsUseFrozenBoundaries": True,
            "outcomePredictionsAreHeldoutValidated": True,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--refresh-model", action="store_true")
    args = parser.parse_args()
    text = sys.stdin.read() if args.stdin else args.text
    if not normalize_source(text):
        print(json.dumps({"error": "type a hook to score"}))
        raise SystemExit(2)
    try:
        model = load_artifact(MODEL_FILE, args.refresh_model)
        partition = load_artifact(PARTITION_FILE, args.refresh_model)
        outcomes = load_artifact(OUTCOME_MODEL_FILE, args.refresh_model)
        result = score_text(text, model, partition, outcome_model=outcomes)
        print(json.dumps(json_ready(result), indent=2 if args.pretty else None,
                         separators=None if args.pretty else (",", ":"), allow_nan=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
