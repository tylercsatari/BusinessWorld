#!/usr/bin/env python3
"""Build the variable-horizon, four-cluster Shorts opening predictor."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

from context_scoring import score_component_context
from embedding_store import EmbeddingStore, R2_PREFIX, R2Store, json_ready
from full_sequence_data import (
    NORMALIZATION_IDS,
    extract_full_sequence_dataset,
    prefix_text_at_second,
)
from hook_score_core import row_unit
from opening_predictor import (
    FEATURE_VERSION,
    PREDICTOR_VERSION,
    build_causal_sequence_feature_stages,
    temporal_attribution,
    views_from_retention5,
)
from sequence import normalize_source
from sequence_context_experiments import (
    build_component_response_rows,
    run_sequence_context_study,
)
from score_hook import sequence_order_sensitivity
from streaming_components import (
    STREAMING_COMPONENT_VERSION,
    build_streaming_components,
)
from variable_horizon_predictor import fit_variable_stage_family


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / ".cache"
COMPONENT_CACHE = CACHE / "full-sequence-components"
PREFIX_CACHE = CACHE / "full-sequence-prefix-embeddings.sqlite3"
OUTPUT = CACHE / "opening-predictions.json"
MODEL_OUTPUT = CACHE / "opening-retention-model.json"
CONTEXT_OUTPUT = CACHE / "opening-context-study.json"
PREDICTION_DETAILS = CACHE / "opening-predictions"
PARTITION_MODEL = CACHE / "canonical-partition-model.json"
OPENING_MODEL = CACHE / "opening-20s-model.json"
CORPUS = CACHE / "corpus.json"
MODEL_FAMILIES = {
    "entryIndexed": "entry_indexed",
    "observedAbsolute": "observed_absolute",
}
RETROSPECTIVE_FAMILIES = ("terminal_replay", "endpoint_affine")
SEED = 20260714
RANDOM_FOLDS = 5
CHRONOLOGICAL_BLOCKS = 5
MINIMUM_MODEL_SOURCES = 10
MINIMUM_CHRONOLOGICAL_SOURCES = 40


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(
            json_ready(value), separators=(",", ":"), ensure_ascii=False,
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def write_gzip(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as handle:
        json.dump(
            json_ready(value), handle, separators=(",", ":"),
            ensure_ascii=False, allow_nan=False,
        )
    os.replace(temporary, path)


def load_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def content_hash(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("ascii")).hexdigest()


def compact_validation(value: dict) -> dict:
    return json_ready(value)


def metadata_by_video() -> dict[str, dict]:
    rows = (load_json(CORPUS).get("rows") or [])
    return {str(row["id"]): row for row in rows}


def _causal_support(opening_model: dict) -> dict:
    measured = opening_model.get("lengthSupport") or {}
    minimum = int(measured.get("fullHookTokenMinimum") or 0)
    if minimum < 2:
        raise RuntimeError("measured hook support cannot form a causal boundary window")
    return {
        "source": (
            "minimum measured full-hook token count; this is the fixed causal lookahead "
            "window and was not selected from retention outcomes"
        ),
        "fullHookTokenMinimum": minimum,
        "fullHookTokenMaximum": minimum,
        "causalFixedWindow": True,
    }


def _component_cache_key(record: dict, partition_model: dict,
                         opening_model: dict, causal_support: dict) -> str:
    return content_hash({
        "version": STREAMING_COMPONENT_VERSION,
        "text": record["text"],
        "partitionMapId": partition_model.get("mapId"),
        "partitionMethod": partition_model.get("methodVersion"),
        "partitionExtension": opening_model.get("partitionExtension"),
        "causalSupport": causal_support,
        "timingMethod": record.get("methodVersion"),
    })


def _strip_vectors(value: dict) -> dict:
    output = dict(value)
    output["chunks"] = [
        {key: item for key, item in chunk.items() if not key.startswith("_")}
        for chunk in value.get("chunks") or []
    ]
    return output


def _attach_component_timing(decomposition: dict, record: dict) -> None:
    tokens = record["tokens"]
    blocks = {int(row["index"]): row for row in decomposition["blocks"]}
    for component in decomposition["chunks"]:
        start = int(component["start"])
        end = int(component["end"])
        if start < 0 or end <= start or end > len(tokens):
            raise RuntimeError("streaming component is outside its timed source tokens")
        block = blocks[int(component["blockIndex"])]
        evidence_end = int(block["evidenceWindowEndToken"])
        if evidence_end <= 0 or evidence_end > len(tokens):
            raise RuntimeError("component boundary evidence is outside its timed source tokens")
        component.update({
            "startToken": start,
            "endToken": end,
            "spokenStartSeconds": float(tokens[start]["spokenStartSeconds"]),
            "spokenEndSeconds": float(tokens[end - 1]["spokenEndSeconds"]),
            "boundaryEvidenceAvailableSeconds": float(
                tokens[evidence_end - 1]["spokenEndSeconds"]
            ),
            "timingSource": (
                "acoustic forced alignment" if bool(tokens[end - 1].get(
                    "acousticallyAlignedPrefix"
                )) else "timestamped transcript suffix interval"
            ),
            "causalFeaturePolicy": (
                "enters component and relationship features only after the complete "
                "outcome-blind boundary-evidence window has been spoken"
            ),
        })


def build_or_load_components(record: dict, store: EmbeddingStore,
                             partition_model: dict, opening_model: dict,
                             causal_support: dict, rebuild: bool = False) -> dict:
    COMPONENT_CACHE.mkdir(parents=True, exist_ok=True)
    path = COMPONENT_CACHE / f"{record['videoId']}.json.gz"
    expected_key = _component_cache_key(
        record, partition_model, opening_model, causal_support,
    )
    if path.exists() and not rebuild:
        cached = load_gzip(path)
        if cached.get("inputKey") == expected_key:
            return cached
    value = build_streaming_components(
        record["text"], store, partition_model, opening_model,
        measured_token_support=causal_support,
    )
    _attach_component_timing(value, record)
    value = _strip_vectors(value)
    value.update({
        "inputKey": expected_key,
        "videoId": record["videoId"],
        "timingContract": record["timingContract"],
        "causalWindowTokens": int(causal_support["fullHookTokenMaximum"]),
        "externalIdeaContextUsed": False,
    })
    write_gzip(path, value)
    return value


def completed_token_count(record: dict, second: int) -> int:
    return int(sum(
        float(token["spokenEndSeconds"]) <= float(second) + 1e-9
        for token in record["tokens"]
    ))


def available_components(decomposition: dict, second: int) -> list[dict]:
    return [
        component for component in decomposition["chunks"]
        if float(component["boundaryEvidenceAvailableSeconds"]) <= second + 1e-9
    ]


def build_targets(records: list[dict], maximum_second: int) -> dict[str, np.ndarray]:
    output = {
        family: np.full((len(records), maximum_second + 1), np.nan, np.float32)
        for family in NORMALIZATION_IDS
    }
    for source, record in enumerate(records):
        for family in NORMALIZATION_IDS:
            values = record["retention"]["curvesPercent"][family]
            count = min(len(values), maximum_second + 1)
            output[family][source, :count] = np.asarray(values[:count], np.float32)
    return output


def build_prefix_features(records: list[dict], decompositions: dict[str, dict],
                          maximum_second: int, store: EmbeddingStore) -> tuple[dict, dict]:
    texts_by_source: list[list[str]] = []
    trace_by_source: dict[str, list[dict]] = {}
    embedding_inputs = []
    for record in records:
        last = min(
            maximum_second,
            int(record["censoring"]["lastWholeSecondAtRisk"]),
        )
        source_texts = []
        trace = []
        for second in range(1, last + 1):
            text = prefix_text_at_second(record, second)
            source_texts.append(text)
            if text:
                embedding_inputs.append(text)
            count = completed_token_count(record, second)
            trace.append({
                "second": float(second),
                "prefixText": text,
                "endToken": count,
                "tokenCount": count,
                "usesWordsAfterThisSecond": False,
                "timingTier": (
                    "acoustic-forced-alignment" if second <= 20
                    else "timestamped-transcript-suffix"
                ),
                "availableComponentIndices": [
                    int(row["index"])
                    for row in available_components(
                        decompositions[record["videoId"]], second,
                    )
                ],
            })
        texts_by_source.append(source_texts)
        trace_by_source[record["videoId"]] = trace
    embedded = store.embed_many(embedding_inputs)
    features_by_second = {}
    dimensions = int(store.dimensions)
    for second in range(1, maximum_second + 1):
        indices = []
        stage_rows = {name: [] for name in (
            "timing", "semantic", "components", "relationships",
        )}
        for source, record in enumerate(records):
            if int(record["censoring"]["lastWholeSecondAtRisk"]) < second:
                continue
            text = texts_by_source[source][second - 1]
            vector = (
                np.asarray(embedded[text], np.float32)
                if text else np.zeros(dimensions, np.float32)
            )
            count = completed_token_count(record, second)
            rate = count / max(1.0, float(second))
            stages = build_causal_sequence_feature_stages(
                vector,
                available_components(decompositions[record["videoId"]], second),
                second, count, rate,
            )
            indices.append(source)
            for name in stage_rows:
                stage_rows[name].append(stages[name])
        features_by_second[second] = (
            np.asarray(indices, int),
            {name: np.asarray(values, np.float32) for name, values in stage_rows.items()},
        )
    return features_by_second, trace_by_source


def _risk_rows(coverage: dict) -> list[dict]:
    return [{
        key: row.get(key) for key in (
            "second", "totalSources", "riskSetSources", "censoredSources",
            "riskSetFraction", "textTimingCoveredSources",
            "textTimingCoverageWithinRiskSet", "allNormalizationFamiliesSources",
            "retentionCoverageWithinRiskSet", "meetsMinimumRiskSetSources",
            "meetsChronologicalRiskSetSources", "meetsAllCoverageThresholds",
            "meetsAllChronologicalCoverageThresholds",
        )
    } for row in coverage["perSecond"]]


def _compact_fitted_family(value: dict) -> dict:
    return {
        "selectedStage": value["selectedStage"],
        "headlineStage": value["headlineStage"],
        "candidateStage": value["candidateStage"],
        "promotion": value["promotion"],
        "stageOrder": value["stageOrder"],
        "timeZeroMean": value["timeZeroMean"],
        "temporalModels": value["temporalModels"],
        "semanticModelHorizonSeconds": value["semanticModelHorizonSeconds"],
        "chronologicalValidationHorizonSeconds": value[
            "chronologicalValidationHorizonSeconds"
        ],
        "randomFoldValidation": compact_validation(value["randomFoldValidation"]),
        "chronologicalValidation": compact_validation(
            value["chronologicalValidation"]
        ),
        "candidateRandomFoldValidation": compact_validation(
            value["candidateRandomFoldValidation"]
        ),
        "candidateChronologicalValidation": compact_validation(
            value["candidateChronologicalValidation"]
        ),
        "stageValidations": compact_validation(value["stageValidations"]),
        "chronologicalStageValidations": compact_validation(
            value["chronologicalStageValidations"]
        ),
        "supportPolicy": value["supportPolicy"],
    }


def _residual_bounds(fitted: dict, source: int, target: np.ndarray) -> tuple[list, list]:
    prediction = np.asarray(fitted["prediction"][source], float)
    low = np.full(len(prediction), np.nan, np.float32)
    high = np.full(len(prediction), np.nan, np.float32)
    by_second = {
        int(round(float(row["second"]))): row
        for row in fitted["temporalModels"]
    }
    for second in range(1, len(prediction)):
        row = by_second.get(second) or {}
        if math.isfinite(prediction[second]) and row.get("residualP10") is not None:
            low[second] = prediction[second] + float(row["residualP10"])
            high[second] = prediction[second] + float(row["residualP90"])
    if math.isfinite(prediction[0]):
        low[0] = prediction[0]
        high[0] = prediction[0]
    return low, high


def _plane_lookup(study: dict) -> dict[tuple[str, int], dict]:
    output = {}
    for category in study.get("categories") or []:
        plane = category.get("primaryOutcomePlane") or {}
        for point in plane.get("points") or []:
            output[(str(point["videoId"]), int(point["componentIndex"]))] = point
    return output


def _planes_by_lag_lookup(study: dict) -> dict[tuple[str, int], dict]:
    output: dict[tuple[str, int], dict] = {}
    for category in study.get("categories") or []:
        for experiment in category.get("lagExperiments") or []:
            plane = experiment.get("outcomePlane") or {}
            lag = str(int(experiment.get("lagSeconds", 0)))
            for point in plane.get("points") or []:
                key = (str(point["videoId"]), int(point["componentIndex"]))
                output.setdefault(key, {})[lag] = {
                    **point,
                    "lagSeconds": int(lag),
                    "xAxis": plane.get("xAxis"),
                    "yAxis": plane.get("yAxis"),
                    "directionStatus": plane.get("directionStatus"),
                }
    return output


def _complete_component_planes(component: dict, context_study: dict,
                               measured: dict | None,
                               evaluated: dict[str, dict] | None) -> dict[str, dict]:
    """Project every component at every lag, even when its observed target is censored."""
    scored = score_component_context(component, context_study) or {}
    projected = scored.get("predictionsByLag") or {}
    evaluated = evaluated or {}
    measured = measured or {}
    output = {}
    for lag in map(str, context_study.get("testedForwardLagsSeconds") or range(6)):
        row = dict(projected.get(lag) or {})
        held_out = evaluated.get(lag) or {}
        observation = measured.get(lag) or {}
        row.update({
            "videoId": component.get("videoId"),
            "componentIndex": int(component["index"]),
            "text": component["text"],
            "observedSlopePercentagePointsPerSecond": observation.get(
                "slopePercentagePointsPerSecond"
            ),
            "oofPredictedSlopePercentagePointsPerSecond": held_out.get(
                "oofPredictedSlopePercentagePointsPerSecond"
            ),
            "pointPredictionStatus": (
                "source-grouped out-of-fold and observed" if held_out else
                "full-fit descriptive projection; observed lag target is censored"
            ),
            "coordinatesOutOfFold": False,
            "pointPredictionOutOfFold": bool(held_out),
        })
        if held_out:
            row.update({
                key: value for key, value in held_out.items()
                if key not in {"observedSlopePercentagePointsPerSecond"}
            })
        output[lag] = row
    return output


def _response_lookup(rows: list[dict]) -> dict[tuple[str, int], dict]:
    return {
        (str(row["videoId"]), int(row["componentIndex"])): row["responseByLag"]
        for row in rows
    }


def _order_sensitivity_components(components: list[dict],
                                  store: EmbeddingStore) -> list[dict]:
    """Rehydrate private span vectors only while evaluating synthetic order swaps."""
    texts = [str(row["text"]) for row in components]
    embedded = store.embed_many(texts)
    output = []
    for component, text in zip(components, texts):
        source = row_unit(np.asarray(embedded[text], np.float32))
        stored = row_unit(np.asarray(source, np.float16).astype(np.float32))
        output.append({**component, "_rawVector": stored.astype(float).tolist()})
    return output


def _support_tier(second: int, model_rows: dict[int, dict], coverage_rows: list[dict]) -> dict:
    model = model_rows.get(second)
    if model is not None:
        return {
            "second": second,
            "riskSetSources": int(model["riskSetSources"]),
            "supportTier": model["supportTier"],
            "individualizedPredictionAvailable": bool(model["headlineModelAvailable"]),
            "chronologicalValidationAvailable": bool(
                model["chronologicalValidationAvailable"]
            ),
            "fullNestedAblationAvailable": bool(
                model.get("fullNestedAblationAvailable")
            ),
        }
    coverage = coverage_rows[second] if second < len(coverage_rows) else None
    return {
        "second": second,
        "riskSetSources": int((coverage or {}).get("riskSetSources") or 0),
        "supportTier": "empirical-only" if coverage else "unsupported",
        "individualizedPredictionAvailable": False,
        "chronologicalValidationAvailable": False,
        "fullNestedAblationAvailable": False,
    }


def _safe_views_contract() -> dict:
    existing = load_json(MODEL_OUTPUT) if MODEL_OUTPUT.exists() else {}
    contract = dict(existing.get("viewsContract") or {})
    if contract:
        contract["status"] = "diagnostic transfer; not retrained by variable-horizon build"
    return contract


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--rebuild-components", action="store_true")
    parser.add_argument("--components-only", action="store_true")
    parser.add_argument("--component-workers", type=int, default=4)
    args = parser.parse_args()

    partition_model = load_json(PARTITION_MODEL)
    opening_model = load_json(OPENING_MODEL)
    metadata = metadata_by_video()
    dataset = extract_full_sequence_dataset(ROOT, CACHE)
    records = dataset["records"]
    for record in records:
        source = metadata.get(record["videoId"]) or {}
        record.update({
            "published": source.get("published") or record["videoId"],
            "title": source.get("title"),
            "url": source.get("url"),
            "views": source.get("views"),
        })
    coverage = dataset["coverage"]
    causal_support = _causal_support(opening_model)
    store = EmbeddingStore(PREFIX_CACHE, workers=8)
    try:
        decompositions = {}
        with ThreadPoolExecutor(max_workers=max(1, args.component_workers)) as pool:
            jobs = {
                pool.submit(
                    build_or_load_components, record, store, partition_model,
                    opening_model, causal_support, args.rebuild_components,
                ): record
                for record in records
            }
            for index, job in enumerate(as_completed(jobs), 1):
                record = jobs[job]
                decompositions[record["videoId"]] = job.result()
                if index % 10 == 0 or index == len(records):
                    print(
                        f"[components {index}/{len(records)}] {record['videoId']}",
                        flush=True,
                    )
        if args.components_only:
            print(json.dumps({
                "status": "components-complete",
                "sources": len(records),
                "components": sum(
                    row["componentCount"] for row in decompositions.values()
                ),
            }, indent=2))
            return

        maximum_second = int(coverage["lastSecondMeetingMinimumRiskSetSources"])
        seconds = np.arange(maximum_second + 1, dtype=np.float32)
        features_by_second, trace_by_source = build_prefix_features(
            records, decompositions, maximum_second, store,
        )
    finally:
        store.close()

    targets = build_targets(records, maximum_second)
    chronology = np.asarray([record["published"] for record in records], str)
    fitted = {}
    for offset, (public_name, normalization_id) in enumerate(MODEL_FAMILIES.items()):
        print(f"[fit] {public_name}", flush=True)
        fitted[public_name] = fit_variable_stage_family(
            features_by_second, targets[normalization_id], chronology, seconds,
            maximum_dimensions=16, alpha=10.0,
            random_folds=RANDOM_FOLDS,
            chronological_blocks=CHRONOLOGICAL_BLOCKS,
            minimum_semantic_sources=MINIMUM_MODEL_SOURCES,
            minimum_chronological_sources=MINIMUM_CHRONOLOGICAL_SOURCES,
            diagnostic_stage_seconds=None,
            seed=SEED + offset * 100003,
        )

    response_rows = build_component_response_rows(records, decompositions)
    context_study = run_sequence_context_study(
        response_rows, permutation_repeats=64, seed=SEED,
    )
    write_json(CONTEXT_OUTPUT, context_study)
    response_lookup = _response_lookup(response_rows)
    planes_by_lag_lookup = _planes_by_lag_lookup(context_study)
    risk_rows = _risk_rows(coverage)
    primary_model_rows = {
        int(round(float(row["second"]))): row
        for row in fitted["entryIndexed"]["temporalModels"]
    }
    views_contract = _safe_views_contract()

    component_counts = np.asarray([
        decomposition["componentCount"] for decomposition in decompositions.values()
    ], int)
    model = {
        "version": 3,
        "status": "complete",
        "predictorVersion": PREDICTOR_VERSION,
        "featureVersion": FEATURE_VERSION,
        "structuralLengthPolicy": "uncapped streaming exact cover",
        "analysisHorizonSeconds": float(maximum_second),
        "predictionTimesSeconds": seconds,
        "trainingSources": len(records),
        "categoryCount": 4,
        "categoriesChanged": False,
        "trainingMethod": {
            "estimator": "one source-grouped PCA-plus-ridge model per at-risk whole second",
            "candidateStage": "relationships",
            "familySelectedStages": {
                name: value["selectedStage"] for name, value in fitted.items()
            },
            "promotionPolicy": fitted["entryIndexed"]["promotion"]["policy"],
            "stageOrder": ["timing", "semantic", "components", "relationships"],
            "randomFolds": RANDOM_FOLDS,
            "chronologicalBlocks": CHRONOLOGICAL_BLOCKS,
            "savedPredictionPolicy": "source-level out-of-fold at every supported second",
            "typedPredictionPolicy": "same frozen per-second full fits",
            "boundaryOutcomesUsed": False,
            "futureWordsUsedForEarlierPredictions": False,
            "externalIdeaContextUsed": False,
            "viewerContextDefinition": (
                "only components delivered earlier, their order, category history, and "
                "semantic change relative to that accumulated history"
            ),
            "nestedAblationSeconds": "every supported second",
        },
        "featureContract": {
            "timing": "elapsed source seconds and completed-token cadence",
            "semantic": "timing plus the transcript prefix completed by that second",
            "components": (
                "semantic plus frozen four-category counts, token mass, coordinates, "
                "confidence, and accumulated context similarity"
            ),
            "relationships": (
                "components plus ordered 4x4 transitions, predecessor similarity, "
                "run structure, and category-history entropy"
            ),
            "canonicalCover": "exact, non-overlapping, every source token owned once",
            "causalBoundaryWindowTokens": int(causal_support["fullHookTokenMaximum"]),
            "causalBoundaryWindowSource": causal_support["source"],
            "sameBuilderForSavedAndTyped": True,
        },
        "families": {
            name: _compact_fitted_family(value) for name, value in fitted.items()
        },
        "support": {
            "sourceVideos": len(records),
            "structuralInputTokenLimit": None,
            "structurallyUncapped": True,
            "semanticModelHorizonSeconds": float(
                fitted["entryIndexed"]["semanticModelHorizonSeconds"]
            ),
            "chronologicalValidationHorizonSeconds": float(
                fitted["entryIndexed"]["chronologicalValidationHorizonSeconds"]
            ),
            "lastObservedSecond": int(coverage["lastWholeSecondWithAnySourceAtRisk"]),
            "minimumModelSources": MINIMUM_MODEL_SOURCES,
            "minimumChronologicalSources": MINIMUM_CHRONOLOGICAL_SOURCES,
            "componentCountMinimum": int(component_counts.min()),
            "componentCountMedian": float(np.median(component_counts)),
            "componentCountMaximum": int(component_counts.max()),
            "speakingRateSourceCount": len(records),
            "meanWordsPerSecond": float(np.mean([
                sum(any(character.isalnum() for character in token["text"])
                    for token in record["tokens"])
                / max(record["mediaDurationSeconds"], 1e-9)
                for record in records
            ])),
            "timingTiers": {
                "through20Seconds": "acoustic forced alignment",
                "suffix": "timestamped transcript interval reconstruction",
            },
            "riskSetBySecond": risk_rows,
            "censoringPolicy": coverage["censoringPolicy"],
        },
        "contextStudy": {
            "artifact": "opening-context-study.json",
            "version": context_study["version"],
            "categoryCount": 4,
            "primaryLagSeconds": context_study["primaryLagSeconds"],
            "testedForwardLagsSeconds": context_study["testedForwardLagsSeconds"],
            "claimBoundary": context_study["claimBoundary"],
        },
        "viewsContract": views_contract,
        "evidenceBoundary": {
            "retention": (
                "observational source-grouped OOF prediction on the duration-conditioned "
                "risk set at each second; not a causal estimate"
            ),
            "context": context_study["claimBoundary"],
            "timing": (
                "acoustic through 20 seconds; suffix uses separately labeled timestamped "
                "transcript intervals until full acoustic alignment is rebuilt"
            ),
            "unsupported": (
                "components continue for arbitrary text, but a served retention forecast is "
                "not emitted below the minimum observed risk set"
            ),
        },
    }

    prediction_rows = []
    order_store = EmbeddingStore(PREFIX_CACHE, workers=8)
    PREDICTION_DETAILS.mkdir(parents=True, exist_ok=True)
    for source, record in enumerate(records):
        decomposition = decompositions[record["videoId"]]
        component_rows = []
        for component in decomposition["chunks"]:
            key = (record["videoId"], int(component["index"]))
            measurements = response_lookup.get(key)
            complete_planes = _complete_component_planes(
                {**component, "videoId": record["videoId"]}, context_study,
                measurements, planes_by_lag_lookup.get(key),
            )
            component_rows.append({
                **component,
                "measurements": measurements,
                "outcomePlane": complete_planes.get("0"),
                "outcomePlanesByLag": complete_planes,
            })
        family_curves = {}
        for public_name, normalization_id in MODEL_FAMILIES.items():
            family = fitted[public_name]
            observed_times = np.asarray(
                record["retention"]["wholeSeconds"], np.float32,
            )
            predicted = np.full(len(observed_times), np.nan, np.float32)
            baseline = np.full(len(observed_times), np.nan, np.float32)
            stages = {
                name: np.full(len(observed_times), np.nan, np.float32)
                for name in family["stageOrder"]
            }
            count = min(len(observed_times), family["prediction"].shape[1])
            predicted[:count] = family["prediction"][source, :count]
            baseline[:count] = family["baseline"][source, :count]
            for name in stages:
                stages[name][:count] = family["stagePrediction"][name][source, :count]
            low, high = _residual_bounds(
                family, source, targets[normalization_id],
            )
            prediction_low = np.full(len(observed_times), np.nan, np.float32)
            prediction_high = np.full(len(observed_times), np.nan, np.float32)
            prediction_low[:count] = low[:count]
            prediction_high[:count] = high[:count]
            family_curves[public_name] = {
                "timesSeconds": observed_times,
                "predicted": predicted,
                "predictionP10": prediction_low,
                "predictionP90": prediction_high,
                "actual": np.asarray(
                    record["retention"]["curvesPercent"][normalization_id],
                    np.float32,
                ),
                "stages": {"baseline": baseline, **stages},
                "selectedStage": family["selectedStage"],
                "candidateStage": family["candidateStage"],
                "promotion": family["promotion"],
                "causalPrefixOnly": True,
            }

        entry = family_curves["entryIndexed"]
        finite_prediction = np.flatnonzero(np.isfinite(entry["predicted"]))
        if not len(finite_prediction):
            raise RuntimeError(f"{record['videoId']} has no OOF retention predictions")
        forecast_index = int(finite_prediction[-1])
        forecast_second = int(entry["timesSeconds"][forecast_index])
        absolute = family_curves["observedAbsolute"]
        retention5 = (
            float(absolute["predicted"][5])
            if len(absolute["predicted"]) > 5 and math.isfinite(absolute["predicted"][5])
            else None
        )
        views = None
        if retention5 is not None and views_contract:
            views = views_from_retention5(retention5, views_contract)
            views["promoted"] = False
            views["status"] = "diagnostic only"
        trace = [{
            "second": 0.0,
            "prefixText": "",
            "endToken": 0,
            "tokenCount": 0,
            "usesWordsAfterThisSecond": False,
            "timingTier": "source-media origin",
            "availableComponentIndices": [],
        }, *trace_by_source[record["videoId"]]]
        trace = [row for row in trace if float(row["second"]) <= forecast_second]
        attribution_curve = {
            "timesSeconds": entry["timesSeconds"][:forecast_index + 1],
            "predicted": entry["predicted"][:forecast_index + 1],
            "actual": entry["actual"][:forecast_index + 1],
            "stages": {
                name: values[:forecast_index + 1]
                for name, values in entry["stages"].items()
            },
            "selectedStage": entry["selectedStage"],
            "candidateStage": entry["candidateStage"],
        }
        attribution = temporal_attribution(
            attribution_curve, trace, component_rows,
        )
        attribution_by_component = {
            int(row["componentIndex"]): row
            for row in attribution["componentLedger"]
        }
        for component in component_rows:
            component["timelineAttribution"] = attribution_by_component.get(
                int(component["index"])
            )
        order_sensitivity = sequence_order_sensitivity(
            _order_sensitivity_components(component_rows, order_store),
            context_study,
        )
        support_by_second = [
            _support_tier(second, primary_model_rows, risk_rows)
            for second in record["retention"]["wholeSeconds"]
        ]
        endpoint_prediction = float(entry["predicted"][forecast_index])
        endpoint_actual = float(entry["actual"][forecast_index])
        endpoint_low = float(entry["predictionP10"][forecast_index])
        endpoint_high = float(entry["predictionP90"][forecast_index])
        if float(record["mediaDurationSeconds"]) < float(forecast_second + 1):
            forecast_stop_reason = "source ends before the next whole-second model point"
        elif forecast_second >= int(fitted["entryIndexed"]["semanticModelHorizonSeconds"]):
            forecast_stop_reason = (
                "duration-conditioned cohort risk set falls below the declared model minimum"
            )
        else:
            forecast_stop_reason = "source-specific measured retention support ends"
        payload = {
            "version": 3,
            "status": "complete",
            "predictorVersion": PREDICTOR_VERSION,
            "featureVersion": FEATURE_VERSION,
            "sourceKind": "saved-full-sequence-variable-horizon-oof",
            "videoId": record["videoId"],
            "title": record.get("title"),
            "text": record["text"],
            "url": record.get("url"),
            "analysisHorizonSeconds": float(record["mediaDurationSeconds"]),
            "modelHorizonSeconds": float(maximum_second),
            "forecastHorizonSeconds": float(forecast_second),
            "predictionTimesSeconds": entry["timesSeconds"],
            "tokenCount": len(record["tokens"]),
            "componentCount": len(component_rows),
            "components": component_rows,
            "relationships": [
                edge for edge in decomposition["graph"]["edges"]
                if edge.get("type") == "next"
            ],
            "causalPrefixTrace": trace_by_source[record["videoId"]],
            "supportBySecond": support_by_second,
            "support": {
                "structurallyUncapped": True,
                "fullObservedDurationSeconds": float(record["mediaDurationSeconds"]),
                "servedForecastThroughSeconds": float(forecast_second),
                "riskSetSourcesAtForecastEnd": int(
                    support_by_second[forecast_second]["riskSetSources"]
                ),
                "supportTierAtForecastEnd": support_by_second[forecast_second][
                    "supportTier"
                ],
                "forecastStopReason": forecast_stop_reason,
                "timingContract": record["timingContract"],
                "timingAudit": record["timingAudit"],
                "censoring": record["censoring"],
            },
            "outputs": {
                "retainedAtAnalyzedEndPercent": endpoint_prediction,
                "retainedAtForecastEndPercent": endpoint_prediction,
                "retainedAtForecastEndP10": endpoint_low,
                "retainedAtForecastEndP90": endpoint_high,
                "forecastEndSeconds": float(forecast_second),
                "absoluteRetention5sPercent": retention5,
                "normalizedRetention5sPercent": (
                    float(entry["predicted"][5]) if forecast_second >= 5 else None
                ),
                "normalizedDropByAnalyzedEndPoints": 100.0 - endpoint_prediction,
                "viewsDiagnostic": views,
            },
            "actual": {
                "retainedAtForecastEndPercent": endpoint_actual,
                "retainedAtObservedEndPercent": float(entry["actual"][-1]),
                "forecastEndSeconds": float(forecast_second),
                "observedEndSeconds": float(record["retention"]["wholeSeconds"][-1]),
                "absoluteRetention5sPercent": (
                    float(absolute["actual"][5]) if len(absolute["actual"]) > 5 else None
                ),
                "views": record.get("views"),
            },
            "predictionError": {
                "retainedAtForecastEndPoints": endpoint_prediction - endpoint_actual,
            },
            "curves": family_curves,
            "temporalAttribution": attribution,
            "orderSensitivity": order_sensitivity,
            "componentGraph": decomposition["graph"],
            "streamingBlocks": decomposition["blocks"],
            "streamingWork": decomposition["work"],
            "validation": {
                name: {
                    "randomFold": value["randomFoldValidation"],
                    "chronological": value["chronologicalValidation"],
                    "candidateRandomFold": value["candidateRandomFoldValidation"],
                    "candidateChronological": value["candidateChronologicalValidation"],
                    "promotion": value["promotion"],
                    "stages": value["stageValidations"],
                    "chronologicalStages": value["chronologicalStageValidations"],
                }
                for name, value in fitted.items()
            },
            "evidence": model["evidenceBoundary"],
            "provenance": {
                "sameFeatureBuilderAsSavedLibrary": True,
                "sameTemporalModelFamilyAsSavedLibrary": True,
                "savedRowsUseOutOfFoldPredictions": True,
                "typedRowsUseFrozenFullFitPredictions": True,
                "outcomesUsedForBoundaries": False,
                "futureWordsUsedForEarlierPredictions": False,
                "externalIdeaContextUsed": False,
                "viewerContextUsesOnlyPriorComponents": True,
                "categoryCount": 4,
            },
        }
        write_gzip(PREDICTION_DETAILS / f"{record['videoId']}.json.gz", payload)
        prediction_rows.append({
            "videoId": record["videoId"],
            "title": record.get("title"),
            "text": record["text"],
            "url": record.get("url"),
            "tokenCount": len(record["tokens"]),
            "componentCount": len(component_rows),
            "analysisHorizonSeconds": float(record["mediaDurationSeconds"]),
            "forecastHorizonSeconds": float(forecast_second),
            "categorySequence": [int(row["category"]) for row in component_rows],
            "components": [{
                key: component.get(key) for key in (
                    "index", "text", "category", "startToken", "endToken",
                    "spokenStartSeconds", "spokenEndSeconds",
                    "boundaryEvidenceAvailableSeconds", "mapX", "mapY",
                    "categoryProbability", "viewerContext", "outcomePlane",
                    "outcomePlanesByLag",
                )
            } for component in component_rows],
            "outputs": payload["outputs"],
            "actual": payload["actual"],
            "predictionError": payload["predictionError"],
            "support": payload["support"],
            "detail": f"/api/shortsquant/promise-lab/opening-prediction/{record['videoId']}",
        })

    order_store.close()

    browser = {
        "version": 3,
        "status": "complete",
        "stage": "variable-horizon causal four-cluster Shorts retention prediction",
        "predictorVersion": PREDICTOR_VERSION,
        "featureVersion": FEATURE_VERSION,
        "analysisHorizonSeconds": float(maximum_second),
        "structurallyUncapped": True,
        "sources": len(records),
        "predictionTimesSeconds": seconds,
        "primaryOutput": "OOF entry-indexed retention at each source's supported endpoint",
        "rows": prediction_rows,
        "validation": {
            name: {
                "randomFold": value["randomFoldValidation"],
                "chronological": value["chronologicalValidation"],
                "candidateRandomFold": value["candidateRandomFoldValidation"],
                "candidateChronological": value["candidateChronologicalValidation"],
                "promotion": value["promotion"],
                "stages": value["stageValidations"],
                "chronologicalStages": value["chronologicalStageValidations"],
            }
            for name, value in fitted.items()
        },
        "riskSetBySecond": risk_rows,
        "contextStudy": context_study,
        "viewsContract": views_contract,
        "featureContract": model["featureContract"],
        "support": model["support"],
        "evidenceBoundary": model["evidenceBoundary"],
    }
    write_json(MODEL_OUTPUT, model)
    write_json(OUTPUT, browser)
    if not args.no_upload:
        remote = R2Store()
        remote.put_json(f"{R2_PREFIX}/opening-retention-model.json.gz", model, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/opening-predictions.json.gz", browser, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/opening-context-study.json.gz", context_study, gzip_payload=True)
        for index, row in enumerate(prediction_rows, 1):
            path = PREDICTION_DETAILS / f"{row['videoId']}.json.gz"
            remote.put_bytes(
                f"{R2_PREFIX}/opening-predictions/{row['videoId']}.json.gz",
                path.read_bytes(), "application/json", "gzip",
            )
            if index % 25 == 0 or index == len(prediction_rows):
                print(f"[upload {index}/{len(prediction_rows)}] {row['videoId']}", flush=True)
    print(json.dumps({
        "status": "complete",
        "sources": len(records),
        "components": int(component_counts.sum()),
        "structurallyUncapped": True,
        "semanticModelHorizonSeconds": model["support"]["semanticModelHorizonSeconds"],
        "chronologicalValidationHorizonSeconds": model["support"][
            "chronologicalValidationHorizonSeconds"
        ],
        "lastObservedSecond": model["support"]["lastObservedSecond"],
    }, indent=2))


if __name__ == "__main__":
    main()
