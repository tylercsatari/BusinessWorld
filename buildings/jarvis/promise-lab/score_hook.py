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
    apply_category_transform,
    category_log_probabilities,
    decode_compositional_four_chunks,
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
SCORER_VERSION = "deterministic-hook-scorer-v1"
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


def score_text(text: str, model: dict | None = None, partition_model: dict | None = None,
               store: EmbeddingStore | None = None) -> dict:
    model = model or load_artifact(MODEL_FILE)
    partition_model = partition_model or load_artifact(PARTITION_FILE)
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
        "latency": model["latencyDecision"],
        "provenance": {
            "outcomeUsedForBoundaries": False,
            "outcomeUsedForQualityAxis": True,
            "examplesUsedForTraining": False,
            "componentAttribution": model["componentDefinition"],
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
        result = score_text(text, model, partition)
        print(json.dumps(json_ready(result), indent=2 if args.pretty else None,
                         separators=None if args.pretty else (",", ":"), allow_nan=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
