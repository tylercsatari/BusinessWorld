#!/usr/bin/env python3
"""Score one Shorts opening with the shared causal 20-second predictor."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

from atlas import REPRESENTATION_VERSION, span_additive_effects
from canonical_partition import boundary_features, boundary_probabilities
from component_lattice import build_component_lattice
from embedding_store import EmbeddingStore, R2_PREFIX, R2Store, json_ready
from hook_score_core import (
    apply_category_transform,
    category_log_probabilities,
    decode_support_calibrated_chunks,
    decode_variable_chunks,
    percentile,
    row_unit,
)
from opening_predictor import (
    FEATURE_VERSION,
    PREDICTOR_VERSION,
    apply_scalar_stage,
    build_feature_stages,
    prediction_support,
    views_from_retention5,
)
from sequence import all_spans, normalize_source, surface, tokenize, without_span


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
PARTITION_FILE = "canonical-partition-model.json"
LATTICE_MODEL_FILE = "opening-lattice-model.json"
OPENING_MODEL_FILE = "opening-20s-model.json"
OPENING_RETENTION_MODEL_FILE = "opening-retention-model.json"


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
    runtime = Path(os.environ.get(
        "PROMISE_HOOK_RUNTIME_CACHE", "/tmp/businessworld-promise-hook",
    ))
    runtime.mkdir(parents=True, exist_ok=True)
    cached = runtime / filename
    if cached.exists() and not refresh and time.time() - cached.stat().st_mtime < 3600:
        return json.loads(cached.read_text(encoding="utf-8"))
    payload = R2Store().get_bytes(f"{R2_PREFIX}/{filename}.gz")
    if not payload:
        raise RuntimeError(f"Promise Lab artifact is unavailable: {filename}")
    value = _decode_json(payload)
    cached.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    return value


def _embedding_cache_path() -> Path:
    if CACHE.exists() and (CACHE / PARTITION_FILE).exists():
        return CACHE / "hook-live-embeddings.sqlite3"
    return Path(os.environ.get(
        "PROMISE_HOOK_EMBED_CACHE", "/tmp/businessworld-promise-hook/embeddings.sqlite3",
    ))


def build_span_primitives(text: str, store: EmbeddingStore) -> dict:
    """Embed the complete deterministic contiguous-span lattice for one opening."""
    text = normalize_source(text)
    tokens = tokenize(text)
    lexical = np.asarray([
        any(character.isalnum() or character == "_" for character in token.text)
        for token in tokens
    ], bool)
    if int(lexical.sum()) < 1:
        raise ValueError("an opening needs at least one lexical atom")
    spans = all_spans(len(tokens))
    span_texts = [surface(tokens, span.start, span.end, source_text=text) for span in spans]
    context_texts = [without_span(tokens, span.start, span.end, source_text=text) for span in spans]
    required = [text, *span_texts, *[value for value in context_texts if value]]
    vectors = store.embed_many(required)
    full_source = row_unit(vectors[text])
    raw_source = np.asarray([row_unit(vectors[value]) for value in span_texts], np.float32)
    context_source = np.asarray([
        row_unit(vectors[value]) if value else np.zeros_like(full_source)
        for value in context_texts
    ], np.float32)
    starts = np.asarray([span.start for span in spans], int)
    ends = np.asarray([span.end for span in spans], int)
    lookup = {
        (int(start), int(end)): index
        for index, (start, end) in enumerate(zip(starts, ends))
    }

    def stored_precision(values: np.ndarray) -> np.ndarray:
        return np.asarray(values, np.float16).astype(np.float32)

    stored_full = stored_precision(full_source)
    stored_raw = stored_precision(raw_source)
    stored_context = stored_precision(context_source)
    influence_source = row_unit(stored_full[None, :] - stored_context)
    token_effects = np.asarray([
        stored_full - stored_context[lookup[(index, index + 1)]]
        for index in range(len(tokens))
    ], np.float32)
    additive = span_additive_effects(token_effects, starts, ends)
    nonadditive_source = row_unit((stored_full[None, :] - stored_context) - additive)

    def training_storage_precision(values: np.ndarray) -> np.ndarray:
        return row_unit(stored_precision(values))

    return {
        "text": text,
        "tokens": tokens,
        "starts": starts,
        "ends": ends,
        "spanTexts": span_texts,
        "raw": row_unit(stored_raw),
        "context": row_unit(stored_context),
        "influence": training_storage_precision(influence_source),
        "nonadditive": training_storage_precision(nonadditive_source),
        "full": row_unit(stored_full),
        "lexical": lexical,
        "embeddingInputs": len(set(required)),
        "trainingVectorStorageDtype": "float16",
        "representationVersion": REPRESENTATION_VERSION,
        "liveQuantizationMatchesTrainingStore": True,
    }


def decode_partition(primitives: dict, partition_model: dict,
                     horizon_extension: dict | None = None) -> dict:
    """Select one outcome-blind, non-overlapping exact cover of every token."""
    category_values = apply_category_transform(
        primitives["raw"], partition_model["categoryTransform"],
    )
    logp = category_log_probabilities(category_values, partition_model["categoryModel"])
    browse = partition_model.get("browseProjection") or {}
    basis = np.asarray(browse.get("basis4x2") or [], np.float32)
    if basis.shape != (4, 2):
        raise RuntimeError("canonical semantic browse projection is unavailable")
    semantic_points = category_values @ basis
    semantic_categories = np.argmax(logp, axis=1)
    features = boundary_features(
        primitives["full"], primitives["raw"], primitives["context"],
        primitives["influence"], primitives["nonadditive"],
        primitives["starts"], primitives["ends"], logp,
    )
    boundary_model = partition_model["boundaryModel"]
    boundary_probability = boundary_probabilities(features, boundary_model)
    uncalibrated = decode_variable_chunks(
        primitives["starts"], primitives["ends"], boundary_probability,
        logp, primitives["lexical"],
    )
    extension = dict(horizon_extension or {})
    threshold = int(extension.get("activationTokenThreshold", 0))
    decoded = uncalibrated
    if extension and len(primitives["tokens"]) > threshold:
        decoded = decode_support_calibrated_chunks(
            primitives["starts"], primitives["ends"], boundary_probability,
            logp, primitives["lexical"], extension,
        )

    tokens = primitives["tokens"]
    owners = np.full(len(tokens), -1, int)
    chunks = []
    for index, chunk in enumerate(decoded["chunks"]):
        span_index = int(chunk["spanIndex"])
        start = int(chunk["start"])
        end = int(chunk["end"])
        owners[start:end] = index
        probability = np.exp(logp[span_index])
        category = int(chunk["category"])
        chunks.append({
            "index": index,
            "start": start,
            "end": end,
            "text": surface(tokens, start, end, source_text=primitives["text"]),
            "category": category,
            "categoryProbability": float(probability[category]),
            "categoryDistribution": probability.astype(float).tolist(),
            "frozenAtlasCategory": None,
            "categoryCoordinates4D": category_values[span_index].astype(float).tolist(),
            "mapX": float(semantic_points[span_index, 0]),
            "mapY": float(semantic_points[span_index, 1]),
            "categorySource": "serving Gaussian assignment into the frozen four-category vocabulary",
            "leftBoundaryProbability": chunk.get("leftBoundaryProbability"),
            "rightBoundaryProbability": chunk.get("rightBoundaryProbability"),
            "leftBoundaryPosterior": (
                float(boundary_probability[start - 1]) if start > 0 else None
            ),
            "rightBoundaryPosterior": (
                float(boundary_probability[end - 1]) if end < len(tokens) else None
            ),
        })
    component_count = len(chunks)
    if (owners < 0).any() or set(owners.tolist()) != set(range(component_count)):
        raise RuntimeError("decoder did not produce one exact non-overlapping owner per token")

    lookup = {
        (int(start), int(end)): index
        for index, (start, end) in enumerate(zip(primitives["starts"], primitives["ends"]))
    }
    token_rows = []
    for token in tokens:
        span_index = lookup[(int(token.index), int(token.index + 1))]
        probability = np.exp(logp[span_index])
        category = int(semantic_categories[span_index])
        token_rows.append({
            "index": token.index,
            "text": token.text,
            "start": token.start,
            "end": token.end,
            "owner": int(owners[token.index]),
            "semantic": {
                "globalSpanIndex": None,
                "category": category,
                "frozenAtlasCategory": None,
                "categoryProbability": float(probability[category]),
                "categoryDistribution": probability.astype(float).tolist(),
                "categoryCoordinates4D": category_values[span_index].astype(float).tolist(),
                "mapX": float(semantic_points[span_index, 0]),
                "mapY": float(semantic_points[span_index, 1]),
                "categorySource": "serving Gaussian assignment into the frozen four-category vocabulary",
            },
        })
    full_index = lookup[(0, len(tokens))]
    full_probability = np.exp(logp[full_index])
    full_category = int(semantic_categories[full_index])
    gap_calibration = np.asarray(
        partition_model["partitionCalibration"]["scoreGapsSorted"], float,
    )
    return {
        **{key: decoded.get(key) for key in (
            "score", "runnerUpScore", "scoreGap", "topTwoPosteriorProxy",
            "partitionsCompared", "objective", "complexityControl",
        )},
        "scoreGapPercentile": (
            None if decoded.get("horizonCalibration") else
            percentile(gap_calibration, float(decoded.get("scoreGap") or 0))
        ),
        "scoreGapCalibrationEligible": not bool(decoded.get("horizonCalibration")),
        "boundaryEvidenceMode": (
            "support-calibrated opening exact cover"
            if decoded.get("horizonCalibration") else
            "frozen outcome-blind boundary evidence"
        ),
        "horizonCalibration": decoded.get("horizonCalibration"),
        "countPrior": decoded.get("countPrior"),
        "selectedCountBoundaryPosteriorProbability": decoded.get(
            "selectedCountBoundaryPosteriorProbability"
        ),
        "selectedCountRenewalSensitivityProbability": decoded.get(
            "selectedCountRenewalSensitivityProbability"
        ),
        "countSelectionPolicy": decoded.get("countSelectionPolicy"),
        "maximumComponentTokens": decoded.get("maximumComponentTokens"),
        "uncalibratedBoundaryOnlyComponentCount": (
            int(uncalibrated["componentCount"])
            if decoded.get("horizonCalibration") else None
        ),
        "chunks": chunks,
        "componentCount": component_count,
        "boundaryProbabilities": boundary_probability.astype(float).tolist(),
        "boundaryPosteriors": boundary_probability.astype(float).tolist(),
        "boundaryModelValidation": {
            key: boundary_model.get(key) for key in (
                "heldoutAuc", "heldoutAveragePrecision", "heldoutDecisionThreshold",
                "heldoutDecisionMetric", "heldoutMatthewsCorrelation",
                "heldoutBalancedAccuracy", "servingPolicy",
            )
        },
        "owners": owners,
        "tokens": token_rows,
        "forecastSemanticInput": {
            "globalSpanIndex": None,
            "text": primitives["text"],
            "category": full_category,
            "frozenAtlasCategory": None,
            "categoryProbability": float(full_probability[full_category]),
            "categoryDistribution": full_probability.astype(float).tolist(),
            "categoryCoordinates4D": category_values[full_index].astype(float).tolist(),
            "mapX": float(semantic_points[full_index, 0]),
            "mapY": float(semantic_points[full_index, 1]),
            "categorySource": "serving Gaussian assignment into the frozen four-category vocabulary",
        },
        "coverage": 1.0,
        "overlapCount": 0,
    }


def _prediction_text_scope(text: str, model: dict,
                           planned_duration_seconds: float | None = None) -> dict:
    normalized = normalize_source(text)
    tokens = tokenize(normalized)
    support = model.get("support") or {}
    rate = float(support.get("medianWordsPerSecond") or 0.0)
    if rate <= 0:
        raise RuntimeError("the opening model has no measured speaking-rate support")
    horizon = float(model.get("analysisHorizonSeconds") or 20.0)
    lexical_indices = [
        index for index, token in enumerate(tokens)
        if any(character.isalnum() or character == "_" for character in token.text)
    ]
    if not lexical_indices:
        raise ValueError("an opening needs at least one lexical atom")
    supplied_duration = None
    if planned_duration_seconds is not None:
        supplied_duration = float(planned_duration_seconds)
        if not math.isfinite(supplied_duration) or supplied_duration <= 0:
            raise ValueError("planned spoken duration must be a positive number of seconds")
    lexical_count = len(lexical_indices)
    full_duration = supplied_duration if supplied_duration is not None else lexical_count / rate
    if full_duration > horizon:
        lexical_kept = max(1, int(np.floor(lexical_count * horizon / full_duration)))
        cut = lexical_indices[min(lexical_kept, lexical_count) - 1] + 1
        while cut < len(tokens) and not any(
            character.isalnum() or character == "_" for character in tokens[cut].text
        ):
            cut += 1
    else:
        cut = len(tokens)
    analyzed = surface(tokens, 0, cut, source_text=normalized)
    remainder = surface(tokens, cut, len(tokens), source_text=normalized) if cut < len(tokens) else ""
    analyzed_lexical = sum(
        any(character.isalnum() or character == "_" for character in token.text)
        for token in tokens[:cut]
    )
    if supplied_duration is not None:
        analyzed_seconds = min(horizon, supplied_duration)
        timing_source = "user-supplied planned spoken duration"
        timing_estimated = False
    else:
        analyzed_seconds = min(horizon, analyzed_lexical / rate)
        timing_source = "measured corpus median speaking rate"
        timing_estimated = True
    slow_rate = float(support.get("measuredWordsPerSecondP10") or rate)
    fast_rate = float(support.get("measuredWordsPerSecondP90") or rate)
    return {
        "inputText": normalized,
        "analyzedText": analyzed,
        "excludedAfter20Seconds": remainder or None,
        "inputWasLongerThan20Seconds": bool(remainder),
        "estimatedSpokenSeconds": float(analyzed_seconds),
        "plannedSpokenSeconds": supplied_duration,
        "timingEstimated": timing_estimated,
        "timingSource": timing_source,
        "estimatedDurationRangeSeconds": (
            None if supplied_duration is not None else {
                "fasterP90Rate": float(analyzed_lexical / max(fast_rate, 1e-9)),
                "slowerP10Rate": float(analyzed_lexical / max(slow_rate, 1e-9)),
            }
        ),
        "wordsPerSecond": rate,
        "inputLexicalTokens": lexical_count,
        "analyzedLexicalTokens": analyzed_lexical,
        "modelTimingSupport": {
            "p10WordsPerSecond": slow_rate,
            "medianWordsPerSecond": rate,
            "p90WordsPerSecond": fast_rate,
        },
    }


def _selected_component_vectors(primitives: dict,
                                partition: dict) -> tuple[np.ndarray, np.ndarray]:
    starts = np.asarray(primitives["starts"], int)
    ends = np.asarray(primitives["ends"], int)
    indices = []
    for chunk in partition["chunks"]:
        matches = np.flatnonzero(
            (starts == int(chunk["start"])) & (ends == int(chunk["end"]))
        )
        if len(matches) != 1:
            raise RuntimeError("canonical component is missing from the exact span tensor")
        indices.append(int(matches[0]))
    selected = np.asarray(indices, int)
    return primitives["raw"][selected], primitives["influence"][selected]


def _typed_prefix_features(primitives: dict, scope: dict,
                           analysis_end: float) -> tuple[dict[int, np.ndarray], list[dict]]:
    tokens = primitives["tokens"]
    lookup = {
        (int(start), int(end)): index
        for index, (start, end) in enumerate(zip(primitives["starts"], primitives["ends"]))
    }
    lexical = np.asarray([
        any(character.isalnum() or character == "_" for character in token.text)
        for token in tokens
    ], bool)
    lexical_total = int(lexical.sum())
    if scope.get("plannedSpokenSeconds") is not None:
        completion = np.cumsum(lexical) / lexical_total * analysis_end
    else:
        completion = np.cumsum(lexical) / float(scope["wordsPerSecond"])
    completion = np.minimum(completion, analysis_end)
    features = {}
    trace = []
    for second in range(1, 21):
        completed = np.flatnonzero(completion <= second + 1e-9)
        cutoff = int(completed[-1] + 1) if len(completed) else 1
        cutoff = min(len(tokens), max(1, cutoff))
        span_index = lookup[(0, cutoff)]
        features[second] = np.asarray(primitives["raw"][span_index], np.float32)
        trace.append({
            "second": float(second),
            "prefixText": surface(tokens, 0, cutoff, source_text=primitives["text"]),
            "endToken": cutoff,
            "tokenCount": cutoff,
            "usesWordsAfterThisSecond": False,
            "timingSource": scope["timingSource"],
        })
    return features, trace


def _typed_curve_payload(prefix_features: dict[int, np.ndarray], model: dict,
                         analysis_end: float) -> dict:
    model_times = np.asarray(model["predictionTimesSeconds"], np.float32)
    families = {}
    for family_name, family in (model.get("families") or {}).items():
        temporal = list(family.get("temporalModels") or [])
        if len(temporal) != 20:
            raise RuntimeError("the opening model does not contain 20 causal temporal fits")
        semantic = np.full(len(model_times), np.nan, np.float32)
        baseline = np.full(len(model_times), np.nan, np.float32)
        semantic[0] = baseline[0] = float(family["timeZeroMean"])
        for row in temporal:
            second = int(round(float(row["second"])))
            semantic[second] = apply_scalar_stage(prefix_features[second], row["model"])
            baseline[second] = float(row["baselineMean"])
        low = semantic + np.asarray(family["residualP10"], np.float32)
        high = semantic + np.asarray(family["residualP90"], np.float32)
        display_times = model_times[model_times <= analysis_end + 1e-9]
        if not len(display_times) or display_times[-1] < analysis_end - 1e-6:
            display_times = np.append(display_times, analysis_end)

        def sampled(values: np.ndarray) -> list[float]:
            return np.interp(display_times, model_times, values).astype(float).tolist()

        families[family_name] = {
            "timesSeconds": display_times.astype(float).tolist(),
            "predicted": sampled(semantic),
            "predictionP10": sampled(low),
            "predictionP90": sampled(high),
            "actual": None,
            "stages": {
                "baseline": sampled(baseline),
                "semanticPrefix": sampled(semantic),
            },
            "fullModelHorizonSeconds": float(model_times[-1]),
            "displayStopsAtSuppliedText": True,
            "selectedStage": "semanticPrefix",
            "causalPrefixOnly": True,
        }
    return families


def _semantic_contribution(curve: dict, second: float) -> dict:
    times = np.asarray(curve["timesSeconds"], float)
    stages = curve["stages"]
    baseline = float(np.interp(second, times, np.asarray(stages["baseline"], float)))
    semantic = float(np.interp(
        second, times, np.asarray(stages["semanticPrefix"], float),
    ))
    return {
        "baselinePercent": baseline,
        "semanticDeltaPoints": semantic - baseline,
        "componentStructureDeltaPoints": None,
        "relationshipDeltaPoints": None,
        "selectedStage": "semanticPrefix",
        "finalPercent": semantic,
        "componentAndRelationshipCandidatesAvailable": False,
    }


def _typed_local_impacts(full: np.ndarray, raw: np.ndarray, influence: np.ndarray,
                         components: list[dict], token_count: int, model: dict,
                         analysis_end: float) -> tuple[list[dict], list[dict], dict | None]:
    candidates = model.get("endpointCandidates") or {}
    endpoint_eligible = analysis_end >= 19.999
    relationship_models = {
        family_name: (((family.get("stages") or {}).get("relationships") or {}).get("model"))
        for family_name, family in candidates.items()
    }
    endpoint_eligible = endpoint_eligible and all(relationship_models.values())
    full_points = {}
    nested_values = None
    if endpoint_eligible:
        all_features = build_feature_stages(full, raw, influence, components, token_count)
        full_points = {
            family_name: apply_scalar_stage(all_features["relationships"], row)
            for family_name, row in relationship_models.items()
        }
        entry_stages = candidates["entryIndexed"]["stages"]
        nested_values = {
            stage: apply_scalar_stage(all_features[stage], entry_stages[stage]["model"])
            for stage in ("semantic", "components", "relationships")
        }

    component_rows = []
    for component in components:
        value = dict(component)
        if endpoint_eligible and len(components) > 1:
            feature = build_feature_stages(
                full, raw, influence, components, token_count,
                removed_components=[int(component["index"])],
            )["relationships"]
            impact = {
                family_name: {
                    "retention20sPoints": float(
                        full_points[family_name] - apply_scalar_stage(feature, row)
                    ),
                }
                for family_name, row in relationship_models.items()
            }
            value["predictionImpact"] = {
                "available": True,
                "candidateStage": "relationships-at-20s",
                "appliedToHeadline": False,
                "definition": (
                    "candidate 20-second prediction(full exact cover) minus prediction after "
                    "deleting this component and recomputing relationship features"
                ),
                **impact,
            }
        else:
            value["predictionImpact"] = {
                "available": False,
                "appliedToHeadline": False,
                "reason": (
                    "component outcome attribution is fitted only for a complete 20-second opening"
                    if len(components) > 1 else
                    "deleting the only exact-cover component leaves no analyzable opening"
                ),
            }
        component_rows.append(value)

    relationship_rows = []
    for left, right in zip(components[:-1], components[1:]):
        edge = (int(left["index"]), int(right["index"]))
        impact = {}
        if endpoint_eligible:
            feature = build_feature_stages(
                full, raw, influence, components, token_count, disabled_edges=[edge],
            )["relationships"]
            impact = {
                family_name: {
                    "retention20sPoints": float(
                        full_points[family_name] - apply_scalar_stage(feature, row)
                    ),
                }
                for family_name, row in relationship_models.items()
            }
        relationship_rows.append({
            "left": edge[0],
            "right": edge[1],
            "leftCategory": int(left["category"]),
            "rightCategory": int(right["category"]),
            "predictionImpact": {
                **impact,
                "available": endpoint_eligible,
                "candidateStage": "relationships-at-20s",
                "appliedToHeadline": False,
                "reason": None if endpoint_eligible else (
                    "20-second endpoint relationship attribution is unavailable for shorter text"
                ),
            },
        })
    return component_rows, relationship_rows, nested_values


def score_text(text: str, model: dict | None = None,
               partition_model: dict | None = None,
               store: EmbeddingStore | None = None,
               outcome_model: dict | None = None,
               market_model: dict | None = None,
               lattice_model: dict | None = None,
               opening_model: dict | None = None,
               idea_text: str = "",
               opening_retention_model: dict | None = None,
               planned_duration_seconds: float | None = None) -> dict:
    """Score typed text with the exact temporal contract used by the saved library."""
    del model, outcome_model, market_model
    partition_model = partition_model or load_artifact(PARTITION_FILE)
    lattice_model = lattice_model or load_artifact(LATTICE_MODEL_FILE)
    opening_model = opening_model or load_artifact(OPENING_MODEL_FILE)
    retention_model = (
        opening_retention_model or load_artifact(OPENING_RETENTION_MODEL_FILE)
    )
    scope = _prediction_text_scope(text, retention_model, planned_duration_seconds)
    idea_text = normalize_source(idea_text)
    owned_store = store is None
    store = store or EmbeddingStore(_embedding_cache_path())
    try:
        primitives = build_span_primitives(scope["analyzedText"], store)
        extension = dict(opening_model.get("partitionExtension") or {})
        extension["activationTokenThreshold"] = -1
        partition = decode_partition(
            primitives, partition_model, horizon_extension=extension,
        )
        idea_vector = (
            row_unit(store.embed_many([idea_text])[idea_text]) if idea_text else None
        )
    finally:
        if owned_store:
            store.close()

    raw, influence = _selected_component_vectors(primitives, partition)
    components = [{
        **chunk,
        "startToken": int(chunk["start"]),
        "endToken": int(chunk["end"]),
    } for chunk in partition["chunks"]]
    analysis_end = max(.01, float(scope["estimatedSpokenSeconds"]))
    prefix_features, prefix_trace = _typed_prefix_features(
        primitives, scope, analysis_end,
    )
    curves = _typed_curve_payload(prefix_features, retention_model, analysis_end)
    entry = curves["entryIndexed"]
    absolute = curves["observedAbsolute"]
    endpoint = float(entry["predicted"][-1])
    retention5 = None
    views = None
    if analysis_end >= 5.0:
        retention5 = float(np.interp(
            5.0, np.asarray(absolute["timesSeconds"], float),
            np.asarray(absolute["predicted"], float),
        ))
        contract = retention_model["viewsContract"]
        views = views_from_retention5(retention5, contract)
        center_log = math.log10(max(1.0, views["estimate"]))
        if contract.get("stackResidualP10Log10") is not None:
            views["lower80"] = float(10 ** (
                center_log + float(contract["stackResidualP10Log10"])
            ))
            views["upper80"] = float(10 ** (
                center_log + float(contract["stackResidualP90Log10"])
            ))
            views["intervalMethod"] = (
                "10th and 90th percentiles of partially OOF stack residuals"
            )
        views["promoted"] = bool(contract.get("individualizedForecastAvailable"))
        views["status"] = str(contract.get("promotionStatus") or "withheld")

    components, relationships, endpoint_candidates = _typed_local_impacts(
        primitives["full"], raw, influence, components, len(primitives["tokens"]),
        retention_model, analysis_end,
    )
    lattice = build_component_lattice(
        text=primitives["text"],
        tokens=primitives["tokens"],
        starts=primitives["starts"],
        ends=primitives["ends"],
        raw=primitives["raw"],
        context=primitives["context"],
        influence=primitives["influence"],
        nonadditive=primitives["nonadditive"],
        full=primitives["full"],
        partition=partition,
        partition_model=partition_model,
        words_per_second=scope["wordsPerSecond"],
        prefix_transition_null=np.asarray(
            lattice_model.get("prefixTransitionNullSorted") or [], np.float32,
        ),
        idea_text=idea_text or None,
        idea_vector=idea_vector,
        title_manifold=None,
        source_kind="typed-opening-predictor",
    )
    contributions = {
        "atAnalyzedEnd": _semantic_contribution(entry, analysis_end),
        "at5Seconds": _semantic_contribution(entry, 5.0) if analysis_end >= 5.0 else None,
        "definition": (
            "baseline plus one causal prefix-semantic model at every plotted second; component "
            "and relationship endpoint candidates are withheld"
        ),
    }
    if endpoint_candidates is not None:
        at20 = _semantic_contribution(entry, 20.0)
        at20.update({
            "componentStructureDeltaPoints": float(
                endpoint_candidates["components"] - endpoint_candidates["semantic"]
            ),
            "relationshipDeltaPoints": float(
                endpoint_candidates["relationships"] - endpoint_candidates["components"]
            ),
            "semanticCandidatePercent": endpoint_candidates["semantic"],
            "componentsCandidatePercent": endpoint_candidates["components"],
            "relationshipCandidatePercent": endpoint_candidates["relationships"],
            "componentAndRelationshipCandidatesAvailable": True,
            "componentAndRelationshipCandidatesApplied": False,
        })
        contributions["at20Seconds"] = at20

    stable_payload = (
        f"{PREDICTOR_VERSION}\0{FEATURE_VERSION}\0{scope['analyzedText']}\0"
        f"{idea_text}\0{scope.get('plannedSpokenSeconds')}"
    )
    return {
        "version": 4,
        "status": "complete",
        "id": hashlib.sha256(stable_payload.encode("utf-8")).hexdigest()[:20],
        "scorerVersion": PREDICTOR_VERSION,
        "predictorVersion": PREDICTOR_VERSION,
        "featureVersion": FEATURE_VERSION,
        "sourceKind": "typed-opening-causal-full-fit",
        "input": {
            **scope,
            "candidateIdeaAnchor": idea_text or None,
            "generativeLlmUsed": False,
            "forecastBeyondSuppliedText": False,
        },
        "analysisHorizonSeconds": analysis_end,
        "modelHorizonSeconds": float(retention_model["analysisHorizonSeconds"]),
        "predictionTimesSeconds": entry["timesSeconds"],
        "originalHookEndSeconds": analysis_end,
        "tokenCount": len(primitives["tokens"]),
        "componentCount": len(components),
        "components": components,
        "relationships": relationships,
        "causalPrefixTrace": prefix_trace,
        "outputs": {
            "retainedAtAnalyzedEndPercent": endpoint,
            "retainedAtAnalyzedEndP10": float(entry["predictionP10"][-1]),
            "retainedAtAnalyzedEndP90": float(entry["predictionP90"][-1]),
            "retainedAtOriginalHookEndPercent": endpoint,
            "absoluteRetention5sPercent": retention5,
            "normalizedRetention5sPercent": (
                float(np.interp(5.0, entry["timesSeconds"], entry["predicted"]))
                if analysis_end >= 5.0 else None
            ),
            "normalizedDropByAnalyzedEndPoints": 100.0 - endpoint,
            "viewsDiagnostic": views,
        },
        "actual": None,
        "curves": curves,
        "contributions": contributions,
        "partition": {key: value for key, value in partition.items() if key != "owners"},
        "componentLattice": lattice,
        "support": {
            **prediction_support(
                len(primitives["tokens"]), analysis_end, retention_model,
            ),
            "timingSource": scope["timingSource"],
            "timingEstimated": scope["timingEstimated"],
        },
        "validation": {
            family_name: {
                "randomFold": family.get("randomFoldValidation"),
                "chronological": family.get("chronologicalValidation"),
            }
            for family_name, family in (retention_model.get("families") or {}).items()
        },
        "evidence": retention_model.get("evidenceBoundary"),
        "provenance": {
            "sameFeatureBuilderAsSavedLibrary": True,
            "sameTemporalModelFamilyAsSavedLibrary": True,
            "savedRowsUseOutOfFoldPredictions": True,
            "typedRowsUseFrozenFullFitPredictions": True,
            "outcomesUsedForBoundaries": False,
            "componentLiteralEmbeddingsUsedForCandidate": True,
            "componentDeletionInfluenceUsedForCandidate": True,
            "canonicalSequenceRelationshipsUsedForHeadline": False,
            "fullOverlappingLatticeUsedAsIndependentVotes": False,
            "responseLagBlended": False,
            "viewsPromotedAsCalibratedForecast": bool(
                (retention_model.get("viewsContract") or {}).get(
                    "individualizedForecastAvailable"
                )
            ),
            "futureWordsUsedForEarlierPredictions": False,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--json-stdin", action="store_true")
    parser.add_argument("--idea", default="")
    parser.add_argument("--duration-seconds", type=float, default=None)
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--refresh-model", action="store_true")
    args = parser.parse_args()
    idea = args.idea
    duration = args.duration_seconds
    if args.json_stdin:
        request = json.loads(sys.stdin.read() or "{}")
        text = str(request.get("text") or "")
        idea = str(request.get("idea") or "")
        raw_duration = request.get("durationSeconds")
        duration = float(raw_duration) if raw_duration not in (None, "") else None
    else:
        text = sys.stdin.read() if args.stdin else args.text
    if not normalize_source(text):
        print(json.dumps({"error": "type an opening to score"}))
        raise SystemExit(2)
    try:
        result = score_text(
            text,
            partition_model=load_artifact(PARTITION_FILE, args.refresh_model),
            lattice_model=load_artifact(LATTICE_MODEL_FILE, args.refresh_model),
            opening_model=load_artifact(OPENING_MODEL_FILE, args.refresh_model),
            opening_retention_model=load_artifact(
                OPENING_RETENTION_MODEL_FILE, args.refresh_model,
            ),
            idea_text=idea,
            planned_duration_seconds=duration,
        )
        print(json.dumps(
            json_ready(result), indent=2 if args.pretty else None,
            separators=None if args.pretty else (",", ":"), allow_nan=False,
        ))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
