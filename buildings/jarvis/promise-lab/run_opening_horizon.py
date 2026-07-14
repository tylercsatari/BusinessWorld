#!/usr/bin/env python3
"""Build and publish source-media-aligned 20-second opening analyses."""

from __future__ import annotations

import argparse
import gc
import gzip
import hashlib
import json
import os
import shutil
import time
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

from cluster_outcomes import retention_at, retention_window_slope
from component_lattice import build_component_lattice
from deconfounding import natural_baseline_features, retention_curve_families
from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, EmbeddingStore, R2Store, json_ready
from forward_response import (
    ResponseCandidate,
    category_balanced_spearman,
    category_balanced_source_inference,
    crossfit_category_axis,
    fit_full_category_axes,
    nested_select_candidate,
)
from hook_score_core import (
    combined_component_features,
    percentile,
    row_unit,
    weighted_percentile,
)
from media_alignment import load_media_alignment, source_timeline_audit
from opening_horizon import (
    FORWARD_LAGS_SECONDS,
    METHOD_VERSION,
    OPENING_HORIZON_SECONDS,
    REVERSE_CONTROL_LAGS_SECONDS,
    component_interval,
    component_boundary_support,
    component_measurements,
    curve_payload,
    load_local_opening,
)
from score_hook import build_span_primitives, decode_partition
from sequence import tokenize


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / ".cache"
DETAILS = CACHE / "opening-20s"
VECTORS = CACHE / "opening-20s-vectors"
EMBED_CACHE = CACHE / "opening-20s-embedding-cache"
SUMMARY_PATH = CACHE / "opening-20s.json"
MODEL_PATH = CACHE / "opening-20s-model.json"
PROGRESS_PATH = CACHE / "opening-20s-progress.json"
RESPONSE_METHOD_VERSION = "opening-20s-nested-common-support-response-v3"


def load(name: str) -> dict:
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def atomic_gzip_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps(
        json_ready(value), separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    temporary.write_bytes(gzip.compress(payload, compresslevel=6))
    os.replace(temporary, path)


def read_gzip_json(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def model_hash(value: dict) -> str:
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()


def update_progress(**values) -> None:
    current = {}
    if PROGRESS_PATH.exists():
        try:
            current = json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
        except Exception:
            current = {}
    atomic_json(PROGRESS_PATH, {**current, **values, "updatedAt": time.time()})


def bounded_parallel_results(pool: ThreadPoolExecutor, values, worker,
                             max_in_flight: int):
    """Yield completed work while retaining at most max_in_flight futures."""
    source = iter(values)
    jobs = set()

    def submit_one() -> bool:
        try:
            value = next(source)
        except StopIteration:
            return False
        jobs.add(pool.submit(worker, value))
        return True

    for _ in range(max(1, int(max_in_flight))):
        if not submit_one():
            break
    while jobs:
        completed, _ = wait(jobs, return_when=FIRST_COMPLETED)
        for job in completed:
            jobs.remove(job)
            result = job.result()
            submit_one()
            yield result


def remove_sqlite(path: Path) -> None:
    for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        candidate.unlink(missing_ok=True)


def content_key(source: dict, opening: dict, partition_model: dict,
                lattice_model: dict, horizon_extension: dict) -> str:
    payload = {
        "methodVersion": METHOD_VERSION,
        "horizonSeconds": OPENING_HORIZON_SECONDS,
        "videoId": source["id"],
        "title": source.get("title"),
        "curve": source.get("curve"),
        "durationSeconds": source.get("duration_s"),
        "originalHookEndSeconds": source.get("hookEndSec"),
        "mediaAlignedHookEndSeconds": opening.get("alignedHookEndSeconds"),
        "mediaDurationSeconds": opening.get("mediaDurationSeconds"),
        "analyticsDurationSeconds": opening.get("analyticsDurationSeconds"),
        "sourceTimelineAudit": opening.get("sourceTimelineAudit"),
        "mediaAlignmentMethodVersion": opening.get("mediaAlignmentMethodVersion"),
        "hookAlignmentMethodVersion": opening.get("hookAlignmentMethodVersion"),
        "text": opening["text"],
        "timingWords": opening["timingWords"],
        "partitionModel": model_hash(partition_model),
        "latticeModel": model_hash(lattice_model),
        "horizonPartitionExtension": model_hash(horizon_extension),
    }
    return hashlib.sha256(json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()


def selected_vector_rows(primitives: dict, partition: dict) -> tuple[np.ndarray, np.ndarray]:
    starts = np.asarray(primitives["starts"], int)
    ends = np.asarray(primitives["ends"], int)
    lookup = {
        (int(start), int(end)): index
        for index, (start, end) in enumerate(zip(starts, ends))
    }
    indices = np.asarray([
        lookup[(int(row["start"]), int(row["end"]))]
        for row in partition["chunks"]
    ], int)
    return (
        np.asarray(primitives["raw"][indices], np.float32),
        np.asarray(primitives["influence"][indices], np.float32),
    )


def build_one(source: dict, partition_model: dict, lattice_model: dict,
              horizon_extension: dict,
              rebuild: bool = False, keep_embedding_cache: bool = False,
              embedding_workers: int = 8) -> dict:
    video_id = str(source["id"])
    opening = load_local_opening(video_id, ROOT)
    key = content_key(
        source, opening, partition_model, lattice_model, horizon_extension,
    )
    detail_path = DETAILS / f"{video_id}.json.gz"
    vector_path = VECTORS / f"{video_id}.npz"
    if detail_path.exists() and vector_path.exists() and not rebuild:
        detail = read_gzip_json(detail_path)
        if detail.get("buildContentKey") == key:
            return detail

    embedding_path = EMBED_CACHE / f"{video_id}.sqlite3"
    store = EmbeddingStore(embedding_path, workers=max(1, int(embedding_workers)))
    persisted = False
    try:
        primitives = build_span_primitives(opening["text"], store)
        partition = decode_partition(
            primitives, partition_model, horizon_extension=horizon_extension,
        )
        title = str(source.get("title") or "").strip()
        title_vector = store.embed_many([title]).get(title) if title else None
        lattice = build_component_lattice(
            text=partition["forecastSemanticInput"]["text"],
            tokens=primitives["tokens"],
            starts=primitives["starts"], ends=primitives["ends"],
            raw=primitives["raw"], context=primitives["context"],
            influence=primitives["influence"], nonadditive=primitives["nonadditive"],
            full=primitives["full"], partition=partition,
            partition_model=partition_model,
            timing_words=opening["timingWords"], timing_policy=opening["timingPolicy"],
            timing_metadata={
                "mediaAligned": opening.get("mediaAligned"),
                "timingExact": opening.get("timingExact"),
                "boundaryEstimator": opening.get("mediaAlignmentMethodVersion"),
                "alignmentConfidence": opening.get("alignmentConfidence"),
                "timingResolutionSeconds": opening.get("timingResolutionSeconds"),
                "claimBoundary": opening.get("timingExactScope"),
            },
            prefix_transition_null=np.asarray(
                lattice_model.get("prefixTransitionNullSorted") or [], np.float32,
            ),
            idea_text=title, idea_vector=title_vector,
            title_manifold=lattice_model.get("titleManifold"),
            source_kind="stored-opening-20s", video_id=video_id,
        )
        raw_components, influence_components = selected_vector_rows(primitives, partition)
        VECTORS.mkdir(parents=True, exist_ok=True)
        temporary_vectors = vector_path.with_suffix(".npz.tmp")
        with temporary_vectors.open("wb") as handle:
            np.savez_compressed(
                handle,
                raw=raw_components.astype(np.float16),
                influence=influence_components.astype(np.float16),
                full=np.asarray(primitives["full"], np.float16),
            )
        os.replace(temporary_vectors, vector_path)

        media_duration = float(
            opening.get("mediaDurationSeconds") or source.get("duration_s")
        )
        retention = curve_payload(source.get("curve") or [], media_duration)
        node_lookup = {row["id"]: row for row in lattice["nodes"]}
        components = []
        hook_end_seconds = float(
            opening.get("alignedHookEndSeconds")
            or source.get("hookEndSec") or 0
        )
        for index, chunk in enumerate(partition["chunks"]):
            start, end = component_interval(
                lattice["tokens"], int(chunk["start"]), int(chunk["end"]),
            )
            boundary_support = component_boundary_support(
                lattice["tokens"], int(chunk["start"]), int(chunk["end"]),
            )
            component = {
                "index": index,
                "nodeId": f"span:{int(chunk['start'])}:{int(chunk['end'])}",
                "startToken": int(chunk["start"]),
                "endToken": int(chunk["end"]),
                "text": chunk["text"],
                "category": int(chunk["category"]),
                "categoryProbability": chunk.get("categoryProbability"),
                "categoryDistribution": chunk.get("categoryDistribution"),
                "categoryCoordinates4D": chunk.get("categoryCoordinates4D"),
                "mapX": chunk.get("mapX"),
                "mapY": chunk.get("mapY"),
                "spokenStartSeconds": start,
                "spokenEndSeconds": end,
                **boundary_support,
                "insideOriginalHook": end <= hook_end_seconds + 1e-9,
                "crossesOriginalHookCut": (
                    start < hook_end_seconds < end
                ),
            }
            component["measurements"] = component_measurements(
                component, source.get("curve") or [], media_duration,
            )
            lattice_node = node_lookup.get(component["nodeId"]) or {}
            component["maps"] = lattice_node.get("maps") or {}
            component["descriptiveAttention"] = lattice_node.get("descriptiveAttention") or {}
            components.append(component)

        lattice.update({
            "analysisScope": "source transcript and measured retention from 0.0 through 20.0 seconds",
            "analysisHorizonSeconds": OPENING_HORIZON_SECONDS,
            "originalHookEndSeconds": hook_end_seconds,
            "opening": {
                key_name: opening.get(key_name) for key_name in (
                    "horizonSeconds", "wordCount", "tokenCount", "lexicalTokenCount",
                    "spokenStartSeconds", "spokenEndSeconds", "timingPolicy",
                    "timingExact", "wordEndPolicy", "sourcePath", "sourceRecord",
                    "sourceMediaOrigin", "sourceMediaPath", "sourceTimelineAudit",
                    "sourceWordStartTimestampsObserved", "resolvedWordStartsObserved",
                    "timestampCollisionGroups", "timestampCollisionWords",
                    "resolvedIntervalsNonoverlapping", "wordEndsObserved",
                    "tokenToSourceWordSequenceCover", "timingExactScope",
                    "mediaAligned", "mediaAlignedWordCount", "wordStartsMediaAligned",
                    "wordEndsMediaAligned", "mediaAlignmentMethodVersion",
                    "mediaDurationSeconds", "analyticsDurationSeconds",
                    "durationDeltaSeconds", "alignmentConfidence",
                    "alignmentCharacterErrorRate", "alignmentReviewWordFraction",
                    "timingResolutionSeconds", "alignmentReferenceAudits",
                    "alignedHookEndSeconds", "hookMediaAlignmentAudit",
                    "hookCanonicalTextTimingAudit", "hookAlignmentMethodVersion",
                )
            },
            "retention": retention,
            "canonicalComponents": components,
            "buildContentKey": key,
            "title": source.get("title"),
            "url": source.get("url"),
            "sourceRecord": {
                "views": source.get("views"),
                "viewedPercent": source.get("keep_rate"),
                "averageRetention": source.get("avg_retention"),
                "durationSeconds": source.get("duration_s"),
                "mediaDurationSeconds": media_duration,
                "analyticsDurationSeconds": source.get("duration_s"),
                "originalHookEndSeconds": source.get("hookEndSec"),
                "mediaAlignedHookEndSeconds": hook_end_seconds,
                "published": source.get("published"),
            },
            "horizonContract": {
                "semanticInput": (
                    "the unchanged canonical transcript forced onto source-media acoustic "
                    "frames through 20.0 seconds"
                ),
                "outcomeInput": (
                    "the measured analytics retention curve mapped to actual source-media "
                    "duration and interpolated only through 20.0 seconds"
                ),
                "forecastBeyondSourceText": False,
                "forecastBeyond20Seconds": False,
                "fourCategoryModelReused": True,
                "categoryCount": 4,
                "partitionBuilder": "score_hook.decode_partition",
                "partitionExtension": horizon_extension.get("method"),
                "partitionExtensionActivated": bool(partition.get("horizonCalibration")),
                "latticeBuilder": "component_lattice.build_component_lattice",
                "sameAsHookPipeline": True,
                "headlineHookScoreReused": False,
                "headlineReason": (
                    "the original Hook Hold outcome model was calibrated on hook endpoints, not "
                    "arbitrarily redefined as a 20-second score"
                ),
            },
        })
        lattice["partitionContract"].update({
            "horizonCalibration": partition.get("horizonCalibration"),
            "countPrior": partition.get("countPrior"),
            "selectedCountBoundaryPosteriorProbability": partition.get(
                "selectedCountBoundaryPosteriorProbability"
            ),
            "selectedCountRenewalSensitivityProbability": partition.get(
                "selectedCountRenewalSensitivityProbability"
            ),
            "countSelectionPolicy": partition.get("countSelectionPolicy"),
            "uncalibratedBoundaryOnlyComponentCount": partition.get(
                "uncalibratedBoundaryOnlyComponentCount"
            ),
            "maximumComponentTokens": partition.get("maximumComponentTokens"),
            "countCalibrationUsesOutcomes": False,
            "countCalibrationUsesCategories": False,
        })
        atomic_gzip_json(detail_path, lattice)
        persisted = True
        return lattice
    finally:
        store.close()
        if persisted and not keep_embedding_cache:
            remove_sqlite(embedding_path)
        gc.collect()


def load_cached_source_structures(
    corpus: list[dict], details_dir: Path = DETAILS, vectors_dir: Path = VECTORS,
) -> dict[str, dict]:
    """Load the immutable 20-second structures before response-only refitting."""
    details = {}
    for source in corpus:
        video_id = str(source["id"])
        detail_path = details_dir / f"{video_id}.json.gz"
        vector_path = vectors_dir / f"{video_id}.npz"
        if not detail_path.exists() or not vector_path.exists():
            raise FileNotFoundError(
                f"response-only rebuild requires cached detail and vectors for {video_id}"
            )
        detail = read_gzip_json(detail_path)
        components = detail.get("canonicalComponents") or []
        ownership = (detail.get("partitionContract") or {}).get("tokenOwnership") or []
        if str(detail.get("videoId")) != video_id:
            raise RuntimeError(f"cached detail video id differs from source: {video_id}")
        cached_method = detail.get("openingAnalysisMethodVersion")
        if cached_method not in (None, METHOD_VERSION):
            raise RuntimeError(f"cached opening method is stale for {video_id}")
        if cached_method is None and not bool(
            (detail.get("horizonContract") or {}).get("sameAsHookPipeline")
        ):
            raise RuntimeError(f"cached opening method is unverifiable for {video_id}")
        if float(detail.get("analysisHorizonSeconds") or 0) != OPENING_HORIZON_SECONDS:
            raise RuntimeError(f"cached opening horizon is not 20 seconds for {video_id}")
        if not components or not ownership or any(int(value) != 1 for value in ownership):
            raise RuntimeError(f"cached canonical cover is invalid for {video_id}")
        if not bool((detail.get("partitionContract") or {}).get("exactNonoverlappingCover")):
            raise RuntimeError(f"cached canonical cover overlaps for {video_id}")
        with np.load(vector_path) as vectors:
            raw_shape = tuple(vectors["raw"].shape)
            influence_shape = tuple(vectors["influence"].shape)
            full_shape = tuple(vectors["full"].shape)
        expected = (len(components), DIMENSIONS)
        if raw_shape != expected or influence_shape != expected or full_shape != (DIMENSIONS,):
            raise RuntimeError(f"cached component vectors differ from detail: {video_id}")
        details[video_id] = {
            "canonicalComponents": components,
            "spanCount": int(detail.get("spanCount") or 0),
            "tokenCount": int(detail.get("tokenCount") or 0),
            "mediaDurationSeconds": float(
                (detail.get("opening") or {}).get("mediaDurationSeconds")
                or (detail.get("sourceRecord") or {}).get("mediaDurationSeconds")
                or source.get("duration_s")
            ),
        }
    return details


def response_candidate(lag: float) -> ResponseCandidate:
    suffix = str(float(lag)).replace("-", "m").replace(".", "p")
    return ResponseCandidate(
        id=f"phrase_lag_{suffix}",
        label=f"resolved component interval {lag:+g}s",
        anchor="phrase", width=None, lag=float(lag),
    )


def response_measurement(candidate: ResponseCandidate, curve_families: dict,
                         raw_curves: list[np.ndarray], durations: np.ndarray,
                         starts: np.ndarray, ends: np.ndarray,
                         source_indices: np.ndarray, entries: np.ndarray,
                         terminals: np.ndarray, amplitudes: np.ndarray,
                         baseline_mode: str = "past_trajectory") -> dict:
    left = starts + float(candidate.lag)
    right = ends + float(candidate.lag)
    eligible = (
        np.isfinite(left + right)
        & (left >= 0) & (right > left)
        & (right <= OPENING_HORIZON_SECONDS + 1e-9)
        & (right <= durations[source_indices] + 1e-9)
    )
    target = np.full(len(starts), np.nan, np.float32)
    raw_target = np.full(len(starts), np.nan, np.float32)
    replay_target = np.full(len(starts), np.nan, np.float32)
    entry_curves = curve_families["entry_indexed"]
    replay_curves = curve_families["terminal_replay"]
    for index in np.flatnonzero(eligible):
        source = int(source_indices[index])
        target[index] = retention_window_slope(
            entry_curves[source], float(durations[source]),
            float(left[index]), float(right[index]),
        )
        raw_target[index] = retention_window_slope(
            raw_curves[source], float(durations[source]),
            float(left[index]), float(right[index]),
        )
        replay_target[index] = retention_window_slope(
            replay_curves[source], float(durations[source]),
            float(left[index]), float(right[index]),
        )
    natural = natural_baseline_features(
        baseline_mode, entry_curves, source_indices, left, right,
        durations, entries, terminals, amplitudes,
        history_starts=np.minimum(starts, left),
    )
    return {
        "target": target,
        "raw": raw_target,
        "replay": replay_target,
        "natural": natural,
        "left": left.astype(np.float32),
        "right": right.astype(np.float32),
        "eligible": eligible,
        "measured": int(np.isfinite(target).sum()),
    }


def axis_payload(model: dict, map_direction: np.ndarray, validation: dict) -> dict:
    return {
        "direction": np.round(np.asarray(model["direction"], float), 8).tolist(),
        "mapDirection": np.round(np.asarray(map_direction, float), 8).tolist(),
        "trainingProjectionSorted": np.asarray(
            model["trainingProjectionSorted"], float,
        ).tolist(),
        "trainingProjectionWeights": np.asarray(
            model["trainingProjectionWeights"], float,
        ).tolist(),
        "fitSpearman": model.get("fitSpearman"),
        "naturalModel": model.get("naturalModel"),
        "validation": validation,
    }


def fit_responses(corpus: list[dict], details: dict[str, dict],
                  horizon_extension: dict,
                  inference_repeats: int = 2048) -> tuple[dict, dict]:
    raw_rows = []
    influence_rows = []
    component_rows = []
    starts = []
    ends = []
    source_indices = []
    categories = []
    groups = []
    for source_index, source in enumerate(corpus):
        video_id = str(source["id"])
        detail = details[video_id]
        vectors = np.load(VECTORS / f"{video_id}.npz")
        raw = row_unit(np.asarray(vectors["raw"], np.float32))
        influence = row_unit(np.asarray(vectors["influence"], np.float32))
        components = detail["canonicalComponents"]
        if len(raw) != len(components):
            raise RuntimeError(f"component vectors differ from detail: {video_id}")
        for index, component in enumerate(components):
            raw_rows.append(raw[index])
            influence_rows.append(influence[index])
            component_rows.append((video_id, index))
            starts.append(component["spokenStartSeconds"])
            ends.append(component["spokenEndSeconds"])
            source_indices.append(source_index)
            categories.append(component["category"])
            groups.append(video_id)

    raw_rows = row_unit(np.asarray(raw_rows, np.float32))
    influence_rows = row_unit(np.asarray(influence_rows, np.float32))
    features = combined_component_features(raw_rows, influence_rows)
    starts = np.asarray(starts, np.float32)
    ends = np.asarray(ends, np.float32)
    source_indices = np.asarray(source_indices, int)
    categories = np.asarray(categories, int)
    groups = np.asarray(groups).astype(str)
    durations = np.asarray([
        float(details[str(row["id"])].get("mediaDurationSeconds") or row["duration_s"])
        for row in corpus
    ], np.float32)
    raw_curves = [np.asarray(row.get("curve") or [], float) for row in corpus]
    entries = np.asarray([curve[0] for curve in raw_curves], np.float32)
    terminals = np.asarray([
        float(np.mean(curve[-max(3, int(np.ceil(len(curve) * .05))):]))
        for curve in raw_curves
    ], np.float32)
    amplitudes = entries - terminals
    curve_families = retention_curve_families(raw_curves, terminals)

    candidates = [response_candidate(lag) for lag in FORWARD_LAGS_SECONDS]
    measurements = {
        candidate.id: response_measurement(
            candidate, curve_families, raw_curves, durations, starts, ends,
            source_indices, entries, terminals, amplitudes,
        ) for candidate in candidates
    }
    selection_common = np.logical_and.reduce([
        np.asarray(measurements[candidate.id]["eligible"], bool)
        for candidate in candidates
    ])
    selection_targets = {}
    selection_naturals = {}
    for candidate in candidates:
        measured = measurements[candidate.id]
        target = np.asarray(measured["target"], np.float32).copy()
        natural = np.asarray(measured["natural"], np.float32).copy()
        target[~selection_common] = np.nan
        natural[~selection_common] = np.nan
        selection_targets[candidate.id] = target
        selection_naturals[candidate.id] = natural
    candidate_results = {}
    for candidate in candidates:
        candidate_results[candidate.id] = crossfit_category_axis(
            features, selection_targets[candidate.id],
            selection_naturals[candidate.id], groups, categories,
            shared_natural_baseline=True,
        )
    nested = nested_select_candidate(
        features,
        selection_targets, selection_naturals,
        groups, categories, shared_natural_baseline=True,
    )
    selected_id = nested.get("selectedCandidate") or candidates[0].id
    selected = next(row for row in candidates if row.id == selected_id)
    selected_measurement = measurements[selected_id]
    selected_conditional_result = crossfit_category_axis(
        features, selected_measurement["target"], selected_measurement["natural"],
        groups, categories, shared_natural_baseline=True,
    )
    inference = category_balanced_source_inference(
        nested["prediction"], nested["targetResidual"], groups, categories,
        repeats=inference_repeats, seed=20260801,
    )

    reverse_measurements = {}
    directional_common = selection_common.copy()
    for lag in REVERSE_CONTROL_LAGS_SECONDS:
        candidate = response_candidate(lag)
        measured = response_measurement(
            candidate, curve_families, raw_curves, durations, starts, ends,
            source_indices, entries, terminals, amplitudes,
        )
        reverse_measurements[candidate.id] = (candidate, measured)
        directional_common &= np.asarray(measured["eligible"], bool)
    directional_common &= np.isfinite(
        np.asarray(nested["prediction"], float)
        + np.asarray(nested["targetResidual"], float)
    )

    paired_forward_prediction = np.asarray(nested["prediction"], np.float32).copy()
    paired_forward_target = np.asarray(nested["targetResidual"], np.float32).copy()
    paired_forward_prediction[~directional_common] = np.nan
    paired_forward_target[~directional_common] = np.nan
    paired_forward_rho, paired_forward_by_category = category_balanced_spearman(
        paired_forward_prediction, paired_forward_target, categories, groups,
        minimum_sources=8, required_categories=(0, 1, 2, 3),
    )
    reverse_rows = []
    for candidate, measured in reverse_measurements.values():
        reverse_target = np.asarray(measured["target"], np.float32).copy()
        reverse_natural = np.asarray(measured["natural"], np.float32).copy()
        reverse_target[~directional_common] = np.nan
        reverse_natural[~directional_common] = np.nan
        residualization = crossfit_category_axis(
            features, reverse_target, reverse_natural, groups, categories,
            shared_natural_baseline=True,
        )
        reverse_residual = np.asarray(
            residualization["targetResidual"], np.float32,
        )
        reverse_residual[~directional_common] = np.nan
        control_rho, control_by_category = category_balanced_spearman(
            paired_forward_prediction, reverse_residual, categories, groups,
            minimum_sources=8, required_categories=(0, 1, 2, 3),
        )
        reverse_rows.append({
            "lagSeconds": float(candidate.lag),
            "measuredComponents": measured["measured"],
            "commonComponentsWithSelectedForward": int(directional_common.sum()),
            "heldoutCategoryBalancedSpearman": control_rho,
            "heldoutSpearmanByCategory": control_by_category,
            "semanticPredictionSource": (
                "the unchanged nested forward-lag semantic prediction; no reverse semantic "
                "axis is fitted for this control"
            ),
            "naturalBaselineHistoryBoundary": (
                "one native source sample before the earlier of the component start or "
                "reverse response-window start"
            ),
            "role": (
                "same-row reverse-time falsification of the selected forward model; never "
                "eligible for lag selection"
            ),
        })

    reverse_magnitudes = [
        abs(float(row["heldoutCategoryBalancedSpearman"]))
        for row in reverse_rows
        if row.get("heldoutCategoryBalancedSpearman") is not None
        and np.isfinite(float(row["heldoutCategoryBalancedSpearman"]))
    ]
    source_ci_low = inference.get("ciLow")
    source_p = inference.get("p")
    category_values = [
        value for value in (nested.get("heldoutSpearmanByCategory") or {}).values()
        if value is not None and np.isfinite(float(value))
    ]
    promotion_checks = {
        "selectionAdjustedPBelowPoint05": bool(
            source_p is not None and float(source_p) < .05
        ),
        "selectionAdjustedBootstrapLowerBoundPositive": bool(
            source_ci_low is not None and float(source_ci_low) > 0
        ),
        "allFourCategoryDirectionsPositive": bool(
            len(category_values) == 4 and all(float(value) > 0 for value in category_values)
        ),
        "forwardExceedsEveryReverseMagnitudeOnSameRows": bool(
            np.isfinite(paired_forward_rho)
            and reverse_magnitudes
            and float(paired_forward_rho) > max(reverse_magnitudes)
        ),
        "fullPipelineInductivelyValidated": False,
    }
    promotion = {
        "promoted": bool(all(promotion_checks.values())),
        "checks": promotion_checks,
        "sameRowForwardHeldoutCategoryBalancedSpearman": (
            float(paired_forward_rho) if np.isfinite(paired_forward_rho) else None
        ),
        "sameRowForwardHeldoutSpearmanByCategory": paired_forward_by_category,
        "maximumAbsoluteReverseControlSpearman": (
            max(reverse_magnitudes) if reverse_magnitudes else None
        ),
        "commonComponents": int(directional_common.sum()),
        "decision": (
            "withheld: the 20-second response direction remains an exploratory full-fit "
            "visualization and is not a validated score"
        ),
        "requiredReplication": (
            "later-video or randomized replication with the complete representation and "
            "partition fit inside training folds"
        ),
    }

    fitted = fit_full_category_axes(
        features, selected_measurement["target"], selected_measurement["natural"],
        categories, groups=groups, shared_natural_baseline=True,
    )
    axis = np.full(len(component_rows), np.nan, np.float32)
    map_y = np.full(len(component_rows), np.nan, np.float32)
    models = {}
    for category, model in fitted.items():
        indices = np.asarray(model["rowIndices"], int)
        axis[indices] = np.asarray(model["projection"], np.float32)[indices]
        direction = np.asarray(model["direction"], np.float32)
        residual_geometry = features[indices] - (
            features[indices] @ direction
        )[:, None] * direction[None, :]
        reducer = PCA(n_components=1, svd_solver="full").fit(residual_geometry)
        background_direction = reducer.components_[0].astype(np.float32)
        background = residual_geometry @ background_direction
        pivot = int(np.argmax(np.abs(background)))
        if background[pivot] < 0:
            background_direction = -background_direction
            background = -background
        map_y[indices] = background.astype(np.float32)
        models[category] = axis_payload(model, background_direction, {
            "postSelectionConditionalHeldoutSpearman": (
                selected_conditional_result["heldoutSpearmanByCategory"].get(category)
            ),
            "postSelectionConditionalFoldDirectionStability": (
                selected_conditional_result["foldDirectionStability"].get(category)
            ),
            "rows": int(len(indices)),
            "evaluationEligible": False,
            "reason": (
                "the serving direction is fitted on every eligible source after the lag "
                "selection procedure; use nestedLagSelection for unbiased evaluation"
            ),
        })

    calibration = {
        category: (
            np.asarray(model["trainingProjectionSorted"], float),
            np.asarray(model["trainingProjectionWeights"], float),
        ) for category, model in models.items()
    }
    for global_index, (video_id, component_index) in enumerate(component_rows):
        component = details[video_id]["canonicalComponents"][component_index]
        category = str(component["category"])
        evaluation_id = str(nested["selectedCandidateByRow"][global_index] or "")
        evaluation_measurement = measurements.get(evaluation_id)
        evaluation_candidate = next(
            (row for row in candidates if row.id == evaluation_id), None,
        )
        evaluation_eligible = bool(
            evaluation_measurement is not None
            and np.isfinite(nested["prediction"][global_index])
            and np.isfinite(nested["targetResidual"][global_index])
        )
        evaluation_left = (
            evaluation_measurement["left"][global_index]
            if evaluation_measurement is not None else np.nan
        )
        evaluation_right = (
            evaluation_measurement["right"][global_index]
            if evaluation_measurement is not None else np.nan
        )
        evaluation_raw = (
            evaluation_measurement["raw"][global_index]
            if evaluation_measurement is not None else np.nan
        )
        evaluation_target = (
            evaluation_measurement["target"][global_index]
            if evaluation_measurement is not None else np.nan
        )
        evaluation_replay = (
            evaluation_measurement["replay"][global_index]
            if evaluation_measurement is not None else np.nan
        )
        serving_percentile = weighted_percentile(
            calibration[category][0], calibration[category][1], axis[global_index],
        )
        component["opening20sResponse"] = {
            "metricId": evaluation_id or None,
            "selectedLagSeconds": (
                float(evaluation_candidate.lag) if evaluation_candidate else None
            ),
            "responseWindowStartSeconds": (
                float(evaluation_left) if np.isfinite(evaluation_left) else None
            ),
            "responseWindowEndSeconds": (
                float(evaluation_right) if np.isfinite(evaluation_right) else None
            ),
            "rawObservedSlopePercentPerSecond": (
                float(evaluation_raw * 100.0) if np.isfinite(evaluation_raw) else None
            ),
            "entryIndexedObservedSlopePercentPerSecond": (
                float(evaluation_target * 100.0)
                if np.isfinite(evaluation_target) else None
            ),
            "terminalReplaySensitivitySlopePercentPerSecond": (
                float(evaluation_replay * 100.0)
                if np.isfinite(evaluation_replay) else None
            ),
            "naturalBaselinePredictionPercentPerSecondOOF": (
                float(nested["naturalBaselinePrediction"][global_index] * 100.0)
                if np.isfinite(nested["naturalBaselinePrediction"][global_index]) else None
            ),
            "unexpectedObservedSlopePercentPerSecondOOF": (
                float(nested["targetResidual"][global_index] * 100.0)
                if np.isfinite(nested["targetResidual"][global_index]) else None
            ),
            "semanticPredictionPercentPerSecondOOF": (
                float(nested["prediction"][global_index] * 100.0)
                if np.isfinite(nested["prediction"][global_index]) else None
            ),
            "fold": int(nested["foldIndex"][global_index]),
            "selectionAdjusted": True,
            "selectionCommonSupport": True,
            "servingMetricId": selected_id,
            "servingLagSeconds": float(selected.lag),
            "conditionalSelectedLagNaturalBaselinePercentPerSecondOOF": (
                float(selected_conditional_result["naturalBaselinePrediction"][global_index] * 100.0)
                if np.isfinite(selected_conditional_result["naturalBaselinePrediction"][global_index])
                else None
            ),
            "conditionalSelectedLagUnexpectedSlopePercentPerSecondOOF": (
                float(selected_conditional_result["targetResidual"][global_index] * 100.0)
                if np.isfinite(selected_conditional_result["targetResidual"][global_index])
                else None
            ),
            "conditionalSelectedLagSemanticPredictionPercentPerSecondOOF": (
                float(selected_conditional_result["prediction"][global_index] * 100.0)
                if np.isfinite(selected_conditional_result["prediction"][global_index])
                else None
            ),
            "axisCoordinate": (
                float(axis[global_index]) if promotion["promoted"] else None
            ),
            "axisPercentile": serving_percentile if promotion["promoted"] else None,
            "mapY": float(map_y[global_index]) if promotion["promoted"] else None,
            "servingAxisCoordinateFullFit": float(axis[global_index]),
            "servingAxisPercentileFullFit": serving_percentile,
            "exploratoryFullFitPercentile": serving_percentile,
            "servingMapYFullFit": float(map_y[global_index]),
            "servingAxisEvaluationEligible": False,
            "servingAxisContract": (
                "full-data exploratory coordinate fitted after lag selection; visible for "
                "geometry inspection but withheld as a score because promotion gates failed"
            ),
            "evaluationEligible": evaluation_eligible,
            "evaluationContract": (
                "the lag, natural baseline, and semantic response were selected or fitted "
                "without this outer-fold source; all lag candidates use identical component "
                "support. The outcome-blind partition and frozen four-category representation "
                "were calibrated on the complete corpus, so this is conditional response "
                "evidence rather than full-pipeline inductive validation"
            ),
        }

    candidate_rows = []
    for candidate in candidates:
        result = candidate_results[candidate.id]
        candidate_rows.append({
            "id": candidate.id,
            "lagSeconds": float(candidate.lag),
            "definition": candidate.definition,
            "measuredComponents": measurements[candidate.id]["measured"],
            "selectionCommonComponents": int(selection_common.sum()),
            "heldoutCategoryBalancedSpearman": result.get("heldoutSpearman"),
            "heldoutSpearmanByCategory": result.get("heldoutSpearmanByCategory"),
            "naturalBaselineCategoryBlind": result.get("naturalBaselineCategoryBlind"),
            "validationDesign": result.get("validationDesign"),
        })
    response_summary = {
        "status": "promoted" if promotion["promoted"] else "exploratory-not-promoted",
        "methodVersion": METHOD_VERSION,
        "responseMethodVersion": RESPONSE_METHOD_VERSION,
        "componentRows": len(component_rows),
        "sourceVideos": len(set(groups)),
        "fourCategoryVocabulary": True,
        "categoryCount": 4,
        "selectedCandidate": selected_id,
        "selectedLagSeconds": float(selected.lag),
        "nestedLagSelection": {
            key: json_ready(value) for key, value in nested.items()
            if key not in {
                "prediction", "targetResidual", "naturalBaselinePrediction",
                "foldIndex", "selectedCandidateByRow",
            }
        },
        "forwardCandidates": candidate_rows,
        "reverseTimeControls": reverse_rows,
        "promotion": promotion,
        "heldoutCategoryBalancedSpearman": nested.get("heldoutSpearman"),
        "heldoutSpearmanByCategory": nested.get("heldoutSpearmanByCategory"),
        "postSelectionConditionalHeldoutCategoryBalancedSpearman": (
            selected_conditional_result.get("heldoutSpearman")
        ),
        "postSelectionConditionalHeldoutSpearmanByCategory": (
            selected_conditional_result.get("heldoutSpearmanByCategory")
        ),
        "lagSelectionCommonComponents": int(selection_common.sum()),
        "sourceInference": inference,
        "primaryTarget": "entry-indexed retention slope over the resolved component interval",
        "primaryTargetFutureFree": True,
        "naturalBaseline": (
            "category-blind source-held-out timing plus pre-utterance trajectory; every source "
            "video has equal total weight in imputation, scaling, semantic projection, ridge, "
            "calibration, and correlation"
        ),
        "lagSelectionSupport": (
            "every forward lag is compared on the same components that remain measurable at "
            "all predeclared 0.0-5.0 second lags"
        ),
        "terminalReplayRole": "retrospective sensitivity only",
        "claimBoundary": (
            "Exploratory observational association only. Current significance, category, "
            "reverse-control, and full-pipeline induction gates do not permit a 20-second "
            "promise score or processing-lag claim."
        ),
    }
    model_artifact = {
        "version": 1,
        "status": "promoted" if promotion["promoted"] else "exploratory-not-promoted",
        "methodVersion": METHOD_VERSION,
        "responseMethodVersion": RESPONSE_METHOD_VERSION,
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "analysisHorizonSeconds": OPENING_HORIZON_SECONDS,
        "selectedCandidate": selected_id,
        "selectedLagSeconds": float(selected.lag),
        "modelsByCategory": models,
        "partitionExtension": horizon_extension,
        "validation": response_summary,
        "promotion": promotion,
        "servingContract": (
            "typed text may display the same exploratory component geometry, but no response "
            "percentile is a score unless promotion.promoted is true; no observed retention "
            "curve is fabricated"
        ),
    }
    return response_summary, model_artifact


def attach_outcome_graph(detail: dict) -> None:
    target_id = "outcome:opening-20s-entry-slope"
    detail["outcomeNodes"] = [
        row for row in detail.get("outcomeNodes") or [] if row.get("id") != target_id
    ] + [{
        "id": target_id,
        "type": "outcome",
        "name": "exploratory 20-second opening response",
        "definition": (
            "source-held-out conditional unexpected entry-indexed retention slope; the "
            "outcome-blind representation is fixed corpus-wide and the axis is not promoted"
        ),
    }]
    detail["edges"] = [
        row for row in detail.get("edges") or []
        if not (row.get("type") == "outcome" and row.get("target") == target_id)
    ]
    for component in detail.get("canonicalComponents") or []:
        response = component.get("opening20sResponse") or {}
        detail["edges"].append({
            "type": "outcome",
            "source": component["nodeId"],
            "target": target_id,
            "prediction": response.get("semanticPredictionPercentPerSecondOOF"),
            "actual": response.get("unexpectedObservedSlopePercentPerSecondOOF"),
            "fold": response.get("fold"),
            "evaluationEligible": bool(response.get("evaluationEligible")),
            "provenance": response.get("evaluationContract"),
        })
    counts = Counter(row.get("type") for row in detail.get("edges") or [])
    detail["edgeCounts"] = {
        name: int(counts.get(name, 0))
        for name in ("containment", "sequence", "semantic", "context", "title", "outcome")
    }
    detail["edgeCount"] = len(detail.get("edges") or [])
    detail["graphContract"]["opening20sOutcomeEdges"] = (
        "canonical components only; natural baseline and semantic prediction are source-video "
        "held out conditional on a corpus-wide outcome-blind representation; diagnostic only"
    )


def _bernoulli_component_count(probabilities: list[float]) -> int:
    distribution = np.asarray([1.0], np.float64)
    for probability in probabilities:
        value = float(np.clip(probability, 0.0, 1.0))
        distribution = np.convolve(distribution, [1.0 - value, value])
    return 1 + int(np.argmax(distribution))


def boundary_count_validation(canonical: dict) -> dict:
    """Compare marginal and joint-MAP counts to held-out geometric cut labels."""
    observed = []
    marginalized = []
    joint_map = []
    for row in canonical.get("rows") or []:
        trace = row.get("boundaryTrace") or {}
        probabilities = trace.get("gapCutProbabilitiesOOF") or []
        labels = trace.get("gapAboveNullLabels") or []
        if len(probabilities) != len(labels):
            raise RuntimeError(f"boundary count audit differs: {row.get('videoId')}")
        observed.append(1 + int(sum(int(value) for value in labels)))
        marginalized.append(_bernoulli_component_count(probabilities))
        joint_map.append(1 + sum(float(value) > .5 for value in probabilities))
    observed_values = np.asarray(observed, int)

    def metrics(prediction: list[int]) -> dict:
        values = np.asarray(prediction, int)
        error = values - observed_values
        return {
            "exactCountAccuracy": float(np.mean(values == observed_values)),
            "withinOneComponentAccuracy": float(np.mean(np.abs(error) <= 1)),
            "meanAbsoluteErrorComponents": float(np.mean(np.abs(error))),
            "meanSignedErrorComponents": float(np.mean(error)),
            "meanPredictedComponents": float(np.mean(values)),
            "meanObservedComponents": float(np.mean(observed_values)),
        }

    return {
        "sourceVideos": len(observed),
        "target": (
            "one plus the count of outcome-blind geometric gap labels; each displayed "
            "probability is source-video held out"
        ),
        "marginalizedBoundaryCount": metrics(marginalized),
        "oldJointMapCount": metrics(joint_map),
        "outcomesUsed": False,
        "claimBoundary": (
            "This validates component count against the model's geometric boundary target, "
            "not human semantic truth or retention outcomes."
        ),
    }


def fit_horizon_partition_extension(canonical: dict, corpus: list[dict]) -> dict:
    """Prepare measured span support and an outcome-blind count audit."""
    weighted_lengths: dict[int, float] = {}
    category_lengths: dict[int, list[int]] = {}
    component_rows = 0
    rows = canonical.get("rows") or []
    for row in rows:
        chunks = row.get("chunks") or []
        if not chunks:
            raise RuntimeError(f"canonical partition has no components: {row.get('videoId')}")
        source_weight = 1.0 / len(chunks)
        for chunk in chunks:
            length = int(chunk["end"]) - int(chunk["start"])
            category = int(chunk["category"])
            if length < 1:
                raise RuntimeError("canonical component length is not positive")
            weighted_lengths[length] = weighted_lengths.get(length, 0.0) + source_weight
            category_lengths.setdefault(category, []).append(length)
            component_rows += 1
    total_weight = float(sum(weighted_lengths.values()))
    if not rows or total_weight <= 0:
        raise RuntimeError("canonical partitions cannot define horizon span support")
    full_hook_counts = [
        len(tokenize(str(row.get("hookText") or "")))
        for row in corpus if str(row.get("hookText") or "").strip()
    ]
    extension = {
        "version": 4,
        "status": "complete",
        "method": (
            "marginalized learned boundary-count posterior with measured span support"
        ),
        "decoderVersion": "boundary-count-marginal-then-conditional-map-v4",
        "activationTokenThreshold": int(max(full_hook_counts)),
        "maximumObservedComponentTokens": int(max(weighted_lengths)),
        "trainingSources": len(rows),
        "trainingComponents": component_rows,
        "sourceEqualLengthWeights": True,
        "componentLengthDistribution": [
            {
                "tokens": int(length),
                "sourceEqualWeight": float(weight),
                "probability": float(weight / total_weight),
            }
            for length, weight in sorted(weighted_lengths.items())
        ],
        "categoryLengthSupport": {
            str(category): {
                "minimum": int(min(lengths)),
                "maximum": int(max(lengths)),
                "rows": len(lengths),
            }
            for category, lengths in sorted(category_lengths.items())
        },
        "boundaryCountValidation": boundary_count_validation(canonical),
        "outcomesUsed": False,
        "categoriesUsedToChooseBoundaries": False,
        "claimBoundary": (
            "For text longer than every measured hook, component count is the posterior mode "
            "after marginalizing the learned cut/non-cut likelihood over every supported exact "
            "cover; the same likelihood places cuts conditional on that count. Empirical "
            "component lengths define support and a visible sensitivity only."
        ),
    }
    extension["contentHash"] = model_hash(extension)
    return extension


def measured_length_support(corpus: list[dict],
                            horizon_extension: dict | None = None) -> dict:
    full_hook_counts = sorted(
        len(tokenize(str(row.get("hookText") or "")))
        for row in corpus
        if str(row.get("hookText") or "").strip()
    )
    if not full_hook_counts:
        raise RuntimeError("the measured hook corpus has no token-length support")
    extension = horizon_extension or {}
    return {
        "source": "the exact token counts of the measured Promise Lab hook corpus",
        "measuredHookCount": len(full_hook_counts),
        "fullHookTokenMinimum": int(full_hook_counts[0]),
        "fullHookTokenMaximum": int(full_hook_counts[-1]),
        "fullHookTokenCountsSorted": full_hook_counts,
        "categorySpanTokenMinimum": 1,
        "categorySpanTokenMaximum": int(full_hook_counts[-1]),
        "categoryTokenSupport": extension.get("categoryLengthSupport") or {},
        "claimBoundary": (
            "The same frozen four-category model is applied at 20 seconds. An opening longer "
            "than every measured hook, or a component longer than every span available while "
            "learning those categories, is computed exactly but marked as an extrapolation."
        ),
    }


def attach_length_support(detail: dict, support: dict) -> None:
    token_count = int(detail.get("tokenCount") or 0)
    full_min = int(support["fullHookTokenMinimum"])
    full_max = int(support["fullHookTokenMaximum"])
    span_min = int(support["categorySpanTokenMinimum"])
    span_max = int(support["categorySpanTokenMaximum"])
    detail["lengthSupport"] = {
        **support,
        "openingTokenCount": token_count,
        "openingTrainingLengthPercentile": percentile(
            support["fullHookTokenCountsSorted"], token_count,
        ),
        "openingOutsideMeasuredHookRange": bool(
            token_count < full_min or token_count > full_max
        ),
    }
    for component in detail.get("canonicalComponents") or []:
        component_tokens = int(component["endToken"]) - int(component["startToken"])
        category = str(int(component.get("category", -1)))
        category_support = (support.get("categoryTokenSupport") or {}).get(category) or {
            "minimum": span_min, "maximum": span_max,
        }
        category_min = int(category_support["minimum"])
        category_max = int(category_support["maximum"])
        component["tokenCount"] = component_tokens
        component["categoryLengthSupport"] = {
            "minimum": category_min,
            "maximum": category_max,
            "outsideMeasuredRange": bool(
                component_tokens < category_min or component_tokens > category_max
            ),
        }


def attach_timing_precision(detail: dict, alignment: dict | None = None) -> None:
    opening = detail.setdefault("opening", {})
    video_id = str(detail.get("videoId") or "test-fixture")
    alignment = alignment or load_media_alignment(video_id, CACHE)
    source_path = Path(alignment["source"]["path"])
    if not source_path.is_absolute():
        source_path = ROOT / source_path
    source_timeline = alignment["source"].get("timelineAudit") or source_timeline_audit(
        source_path
    )
    if not source_timeline["withinAlignmentTolerance"]:
        raise RuntimeError(f"source-media clock origin is not aligned for {video_id}")
    opening.update({
        "sourceMediaOrigin": alignment["source"].get("origin"),
        "sourceMediaPath": alignment["source"].get("path"),
        "sourceTimelineAudit": source_timeline,
        "mediaAlignmentMethodVersion": alignment.get("methodVersion"),
        "mediaDurationSeconds": float(alignment["source"]["mediaDurationSeconds"]),
        "analyticsDurationSeconds": float(
            alignment["source"]["analyticsDurationSeconds"]
        ),
        "durationDeltaSeconds": float(alignment["source"]["durationDeltaSeconds"]),
        "alignmentConfidence": alignment["alignment"]["confidenceBand"],
        "alignmentCharacterErrorRate": float(
            alignment["alignment"]["freeDecodeCharacterErrorRate"]
        ),
        "alignmentReviewWordFraction": float(
            alignment["alignment"]["reviewWordFraction"]
        ),
        "timingResolutionSeconds": float(
            alignment["alignment"]["secondsPerCtcFrame"]
        ),
        "alignmentReferenceAudits": alignment["alignment"].get(
            "referenceAudits"
        ) or {},
    })
    detail["openingAnalysisMethodVersion"] = METHOD_VERSION
    opening["methodVersion"] = METHOD_VERSION
    collision_groups = int(opening.get("timestampCollisionGroups") or 0)
    collision_words = int(opening.get("timestampCollisionWords") or 0)
    resolved_starts_observed = bool(
        opening.get("resolvedWordStartsObserved", collision_groups == 0)
    )
    media_aligned = bool(opening.get("mediaAligned"))
    contract = detail.setdefault("timingContract", {})
    if media_aligned:
        contract.update({
            "source": "local-wav2vec2-ctc-forced-alignment-on-source-media-pcm",
            "exact": False,
            "mediaAligned": True,
            "boundaryEstimator": opening.get("mediaAlignmentMethodVersion"),
            "alignmentConfidence": opening.get("alignmentConfidence"),
            "alignmentCharacterErrorRate": opening.get(
                "alignmentCharacterErrorRate"
            ),
            "alignmentReviewWordFraction": opening.get(
                "alignmentReviewWordFraction"
            ),
            "timingResolutionSeconds": opening.get("timingResolutionSeconds"),
            "sourceWordStartTimestampsObserved": False,
            "sourceWordStartsObserved": False,
            "resolvedWordStartsObserved": False,
            "sourceWordStartsMediaAligned": True,
            "sourceWordEndsObserved": False,
            "sourceWordEndsMediaAligned": True,
            "timestampCollisionGroups": collision_groups,
            "timestampCollisionWords": collision_words,
            "resolvedIntervalsNonoverlapping": bool(
                opening.get("resolvedIntervalsNonoverlapping", True)
            ),
            "tokenToSourceWordSequenceCover": True,
            "collisionResolution": "acoustic CTC frames resolve canonical word order directly",
            "endInference": (
                "CTC-estimated word end clipped at the next canonical start and 20.0 seconds"
            ),
            "claimBoundary": opening.get("timingExactScope"),
        })
    else:
        contract.update({
            "source": "observed-quantized-word-starts-with-collision-resolution-and-inferred-ends",
            "exact": False,
            "mediaAligned": False,
            "sourceWordStartTimestampsObserved": True,
            "sourceWordStartsObserved": True,
            "resolvedWordStartsObserved": resolved_starts_observed,
            "sourceWordEndsObserved": False,
            "timestampCollisionGroups": collision_groups,
            "timestampCollisionWords": collision_words,
            "resolvedIntervalsNonoverlapping": bool(
                opening.get("resolvedIntervalsNonoverlapping", True)
            ),
            "tokenToSourceWordSequenceCover": True,
            "collisionResolution": (
                "words sharing one observed timestamp divide the interval to the next distinct "
                "timestamp in source order, weighted by source-character length"
            ),
            "endInference": (
                "each distinct timestamp group ends at the next distinct observed timestamp, "
                "clipped at 20.0s"
            ),
            "claimBoundary": (
                "Transcript words and their quantized source timestamps are observed. Equal "
                "timestamps are resolved deterministically; word ends are inferred."
            ),
        })
    opening.update({
        "timingExact": False,
        "wordStartsSourceSupported": True,
        "sourceWordStartTimestampsObserved": not media_aligned,
        "resolvedWordStartsObserved": resolved_starts_observed if not media_aligned else False,
        "wordStartsMediaAligned": media_aligned,
        "wordEndsObserved": False,
        "wordEndsMediaAligned": media_aligned,
        "timestampCollisionGroups": collision_groups,
        "timestampCollisionWords": collision_words,
        "resolvedIntervalsNonoverlapping": bool(
            opening.get("resolvedIntervalsNonoverlapping", True)
        ),
        "tokenToSourceWordSequenceCover": True,
    })


def summary_row(detail: dict) -> dict:
    opening = detail.get("opening") or {}
    timing = detail.get("timingContract") or {}
    response_values = [
        (row.get("opening20sResponse") or {}).get(
            "servingAxisPercentileFullFit",
            (row.get("opening20sResponse") or {}).get("axisPercentile"),
        )
        for row in detail.get("canonicalComponents") or []
    ]
    response_values = [float(value) for value in response_values if value is not None]
    return {
        "videoId": detail["videoId"],
        "title": detail.get("title"),
        "text": detail.get("text"),
        "url": detail.get("url"),
        "tokenCount": detail.get("tokenCount"),
        "wordCount": opening.get("wordCount"),
        "componentCount": len(detail.get("canonicalComponents") or []),
        "categorySequence": [
            int(row["category"]) for row in detail.get("canonicalComponents") or []
        ],
        "spanCount": detail.get("spanCount"),
        "edgeCount": len(detail.get("edges") or []),
        "timingSource": timing.get("source"),
        "timingExact": timing.get("exact"),
        "mediaAligned": bool(timing.get("mediaAligned")),
        "wordStartsMediaAligned": bool(timing.get("sourceWordStartsMediaAligned")),
        "wordEndsMediaAligned": bool(timing.get("sourceWordEndsMediaAligned")),
        "alignmentConfidence": timing.get("alignmentConfidence"),
        "alignmentCharacterErrorRate": timing.get("alignmentCharacterErrorRate"),
        "alignmentReviewWordFraction": timing.get("alignmentReviewWordFraction"),
        "timingResolutionSeconds": timing.get("timingResolutionSeconds"),
        "mediaDurationSeconds": opening.get("mediaDurationSeconds"),
        "analyticsDurationSeconds": opening.get("analyticsDurationSeconds"),
        "durationDeltaSeconds": opening.get("durationDeltaSeconds"),
        "sourceMediaOrigin": opening.get("sourceMediaOrigin"),
        "sourceClockOffsetSeconds": (
            (opening.get("sourceTimelineAudit") or {}).get(
                "audioMinusReferenceStartSeconds"
            )
        ),
        "sourceClockReference": (
            (opening.get("sourceTimelineAudit") or {}).get("referenceClock")
        ),
        "alignmentReferenceAudits": opening.get("alignmentReferenceAudits") or {},
        "hookAlignmentReferenceAudits": (
            (opening.get("hookMediaAlignmentAudit") or {}).get("referenceAudits")
            or {}
        ),
        "wordStartsSourceSupported": bool(
            timing.get("sourceWordStartTimestampsObserved")
            or timing.get("sourceWordStartsMediaAligned")
        ),
        "sourceWordStartTimestampsObserved": bool(
            timing.get("sourceWordStartTimestampsObserved")
        ),
        "resolvedWordStartsObserved": bool(
            timing.get("resolvedWordStartsObserved")
        ),
        "timestampCollisionGroups": int(
            timing.get("timestampCollisionGroups") or 0
        ),
        "timestampCollisionWords": int(
            timing.get("timestampCollisionWords") or 0
        ),
        "resolvedIntervalsNonoverlapping": bool(
            timing.get("resolvedIntervalsNonoverlapping")
        ),
        "wordEndsObserved": bool(
            timing.get("sourceWordEndsObserved")
        ),
        "originalHookEndSeconds": detail.get("originalHookEndSeconds"),
        "retentionAt5Seconds": retention_at(
            (detail.get("retention") or {}).get("curvesPercent", {}).get("observed_absolute") or [],
            OPENING_HORIZON_SECONDS,
            5.0,
        ),
        "retentionAt20Seconds": (
            ((detail.get("retention") or {}).get("curvesPercent", {}).get("observed_absolute") or [None])[-1]
        ),
        "medianServingComponentResponsePercentileFullFit": (
            float(np.median(response_values)) if response_values else None
        ),
        "medianComponentResponsePercentile": (
            float(np.median(response_values)) if response_values else None
        ),
        "openingOutsideMeasuredHookRange": bool(
            (detail.get("lengthSupport") or {}).get("openingOutsideMeasuredHookRange")
        ),
        "componentsOutsideCategoryLengthRange": sum(
            bool((row.get("categoryLengthSupport") or {}).get("outsideMeasuredRange"))
            for row in detail.get("canonicalComponents") or []
        ),
        "detail": f"/api/longquant/promise-lab/opening-20s/{detail['videoId']}",
        "contentHash": detail.get("contentHash"),
    }


def upload_opening_artifacts(summary: dict, model_artifact: dict | None,
                             upload_workers: int = 8) -> None:
    rows = summary.get("rows") or []
    if not rows:
        raise RuntimeError("the 20-second summary has no detail rows to upload")
    r2 = R2Store()

    def upload_row(row: dict) -> str:
        video_id = str(row["videoId"])
        path = DETAILS / f"{video_id}.json.gz"
        if not path.exists():
            raise FileNotFoundError(f"missing 20-second detail artifact: {path}")
        r2.put_bytes(
            f"{R2_PREFIX}/opening-20s/{video_id}.json.gz",
            path.read_bytes(), "application/json", "gzip",
        )
        return video_id

    workers = max(1, int(upload_workers))
    update_progress(
        status="running", stage="uploading verified 20-second details",
        uploadsComplete=0, uploadsTotal=len(rows),
    )
    completed = 0
    pool = None
    try:
        if workers > 1:
            pool = ThreadPoolExecutor(max_workers=workers)
            uploaded = bounded_parallel_results(
                pool, rows, upload_row, max_in_flight=workers,
            )
        else:
            uploaded = (upload_row(row) for row in rows)
        for video_id in uploaded:
            completed += 1
            update_progress(
                uploadsComplete=completed,
                stage=f"uploaded {video_id} ({completed}/{len(rows)})",
            )
            print(f"[upload {completed}/{len(rows)}] {video_id}", flush=True)
    except BaseException as exc:
        update_progress(
            status="stopped" if isinstance(exc, KeyboardInterrupt) else "error",
            stage="20-second detail upload interrupted" if isinstance(exc, KeyboardInterrupt)
            else "20-second detail upload failed",
            uploadsComplete=completed, error=str(exc),
        )
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
            pool = None
        raise
    finally:
        if pool is not None:
            pool.shutdown(wait=True)

    update_progress(stage="uploading 20-second summary and response model")
    r2.put_json(f"{R2_PREFIX}/opening-20s.json.gz", summary, gzip_payload=True)
    if model_artifact:
        r2.put_json(
            f"{R2_PREFIX}/opening-20s-model.json.gz",
            model_artifact, gzip_payload=True,
        )
    update_progress(
        uploadsComplete=len(rows), uploadsTotal=len(rows),
        stage="verified 20-second artifacts uploaded",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--video-id", default="")
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--keep-embedding-cache", action="store_true")
    parser.add_argument("--skip-response", action="store_true")
    parser.add_argument("--response-only", action="store_true")
    parser.add_argument("--inference-repeats", type=int, default=2048)
    parser.add_argument("--source-workers", type=int, default=1)
    parser.add_argument("--embedding-workers", type=int, default=8)
    parser.add_argument("--upload-workers", type=int, default=8)
    parser.add_argument("--upload-only", action="store_true")
    args = parser.parse_args()
    started = time.time()

    if args.response_only and (
        args.skip_response or args.rebuild or args.video_id or args.limit
    ):
        raise SystemExit(
            "--response-only requires the complete cached corpus and cannot be combined "
            "with --skip-response, --rebuild, --video-id, or --limit"
        )

    if args.upload_only:
        if args.no_upload:
            raise SystemExit("--upload-only cannot be combined with --no-upload")
        if not SUMMARY_PATH.exists() or not MODEL_PATH.exists():
            raise SystemExit("the verified 20-second summary and model must exist before upload")
        upload_summary = load("opening-20s.json")
        upload_model = load("opening-20s-model.json")
        upload_opening_artifacts(
            upload_summary, upload_model, upload_workers=args.upload_workers,
        )
        update_progress(
            status="complete", stage="20-second opening artifact upload complete",
            sourcesComplete=int(upload_summary.get("sourceVideos") or 0),
            sourcesTotal=int(upload_summary.get("sourceVideos") or 0),
            spansMaterialized=int(upload_summary.get("spanCount") or 0),
        )
        print(json.dumps({
            "uploadedSources": int(upload_summary.get("sourceVideos") or 0),
            "uploadedSpans": int(upload_summary.get("spanCount") or 0),
            "elapsedSeconds": round(time.time() - started, 2),
        }, indent=2), flush=True)
        return

    full_corpus = load("corpus.json")["rows"]
    corpus = full_corpus
    if args.video_id:
        corpus = [row for row in corpus if str(row["id"]) == str(args.video_id)]
        if not corpus:
            raise SystemExit(f"video is not in the Promise Lab corpus: {args.video_id}")
    if args.limit:
        corpus = corpus[:args.limit]
    partition_model = load("canonical-partition-model.json")
    canonical_partitions = load("canonical-partitions.json")
    lattice_model = load("component-lattice-model.json")
    horizon_extension = fit_horizon_partition_extension(
        canonical_partitions, full_corpus,
    )
    length_support = measured_length_support(full_corpus, horizon_extension)
    DETAILS.mkdir(parents=True, exist_ok=True)
    VECTORS.mkdir(parents=True, exist_ok=True)
    EMBED_CACHE.mkdir(parents=True, exist_ok=True)
    if args.response_only:
        update_progress(
            status="running", stage="validating cached 20-second source structures",
            sourcesComplete=0, sourcesTotal=len(corpus),
            horizonSeconds=OPENING_HORIZON_SECONDS, error="",
        )
        details = load_cached_source_structures(corpus)
        update_progress(
            sourcesComplete=len(details),
            spansMaterialized=sum(
                int(row.get("spanCount") or 0) for row in details.values()
            ),
            stage="validated cached 20-second source structures",
        )
        print(
            f"[cache] validated {len(details)} source lattices and vector sets",
            flush=True,
        )
    else:
        update_progress(
            status="running", stage="building exact 20-second opening lattices",
            sourcesComplete=0, sourcesTotal=len(corpus),
            horizonSeconds=OPENING_HORIZON_SECONDS, error="",
        )
        details = {}

        def build_source(source: dict) -> tuple[dict, dict]:
            return source, build_one(
                source, partition_model, lattice_model, horizon_extension,
                rebuild=args.rebuild, keep_embedding_cache=args.keep_embedding_cache,
                embedding_workers=args.embedding_workers,
            )

        completed = 0
        if args.source_workers > 1:
            source_workers = max(1, int(args.source_workers))
            pool = ThreadPoolExecutor(max_workers=source_workers)
            iterator = bounded_parallel_results(
                pool, corpus, build_source, max_in_flight=source_workers,
            )
        else:
            pool = None
            iterator = (build_source(source) for source in corpus)
        try:
            for source, detail in iterator:
                completed += 1
                video_id = str(source["id"])
                details[video_id] = {
                    "canonicalComponents": detail["canonicalComponents"],
                    "spanCount": int(detail.get("spanCount") or 0),
                    "tokenCount": int(detail.get("tokenCount") or 0),
                    "mediaDurationSeconds": float(
                        (detail.get("opening") or {}).get("mediaDurationSeconds")
                        or source.get("duration_s")
                    ),
                }
                del detail
                gc.collect()
                update_progress(
                    sourcesComplete=completed,
                    spansMaterialized=sum(
                        int(row.get("spanCount") or 0) for row in details.values()
                    ),
                    stage=f"built {video_id} through 20.0 seconds",
                )
                row = details[video_id]
                print(
                    f"[{completed}/{len(corpus)}] {video_id}: "
                    f"{row['tokenCount']} tokens, "
                    f"{len(row['canonicalComponents'])} components, "
                    f"{row['spanCount']} spans",
                    flush=True,
                )
        except KeyboardInterrupt:
            update_progress(status="stopped", stage="20-second opening build interrupted")
            if pool is not None:
                pool.shutdown(wait=False, cancel_futures=True)
                pool = None
            raise
        except Exception as exc:
            update_progress(
                status="error",
                stage="20-second opening build failed; partial vectors retained",
                error=str(exc),
            )
            if pool is not None:
                pool.shutdown(wait=False, cancel_futures=True)
                pool = None
            raise
        finally:
            if pool is not None:
                pool.shutdown(wait=True)

    response_summary = None
    model_artifact = None
    if not args.skip_response and len(corpus) >= 20:
        update_progress(stage="fitting source-held-out 20-second component response")
        response_summary, model_artifact = fit_responses(
            corpus, details, horizon_extension,
            inference_repeats=args.inference_repeats,
        )
        atomic_json(MODEL_PATH, model_artifact)
        for source in corpus:
            video_id = str(source["id"])
            detail = read_gzip_json(DETAILS / f"{video_id}.json.gz")
            detail["canonicalComponents"] = details[video_id]["canonicalComponents"]
            attach_length_support(detail, length_support)
            attach_timing_precision(detail)
            attach_outcome_graph(detail)
            atomic_gzip_json(DETAILS / f"{video_id}.json.gz", detail)
            del detail

    if not response_summary:
        for source in corpus:
            video_id = str(source["id"])
            detail = read_gzip_json(DETAILS / f"{video_id}.json.gz")
            attach_length_support(detail, length_support)
            attach_timing_precision(detail)
            atomic_gzip_json(DETAILS / f"{video_id}.json.gz", detail)
            del detail

    rows = []
    for source in corpus:
        detail = read_gzip_json(DETAILS / f"{source['id']}.json.gz")
        rows.append(summary_row(detail))
        del detail
    aligned_rows = [row for row in rows if row.get("mediaAligned")]
    confidence_bands = {
        band: sum(row.get("alignmentConfidence") == band for row in aligned_rows)
        for band in ("high", "moderate", "low")
    }
    character_errors = [
        float(row["alignmentCharacterErrorRate"])
        for row in aligned_rows if row.get("alignmentCharacterErrorRate") is not None
    ]
    review_fractions = [
        float(row["alignmentReviewWordFraction"])
        for row in aligned_rows if row.get("alignmentReviewWordFraction") is not None
    ]
    timing_resolutions = [
        float(row["timingResolutionSeconds"])
        for row in aligned_rows if row.get("timingResolutionSeconds") is not None
    ]
    source_clock_offsets = [
        float(row["sourceClockOffsetSeconds"])
        for row in aligned_rows if row.get("sourceClockOffsetSeconds") is not None
    ]
    independent_timing_audits = [
        (row.get("alignmentReferenceAudits") or {}).get(
            "independentWhisperBaseWords"
        )
        for row in aligned_rows
    ]
    independent_timing_audits = [
        audit for audit in independent_timing_audits if audit
    ]
    independent_hook_timing_audits = [
        (row.get("hookAlignmentReferenceAudits") or {}).get(
            "independentWhisperBaseWords"
        )
        for row in aligned_rows
    ]
    independent_hook_timing_audits = [
        audit for audit in independent_hook_timing_audits if audit
    ]
    independent_hook_endpoint_errors = [
        float(audit["finalMatchedWordEndAbsoluteErrorSeconds"])
        for audit in independent_hook_timing_audits
        if audit.get("finalMatchedWordEndAbsoluteErrorSeconds") is not None
    ]
    summary = {
        "version": 1,
        "status": "complete",
        "stage": "media-aligned 20-second opening analysis",
        "methodVersion": METHOD_VERSION,
        "analysisHorizonSeconds": OPENING_HORIZON_SECONDS,
        "sourceVideos": len(rows),
        "sourceVideosWithExactTiming": sum(bool(row["timingExact"]) for row in rows),
        "sourceVideosWithMediaAlignedWordIntervals": len(aligned_rows),
        "sourceMediaOrigins": dict(sorted(Counter(
            str(row.get("sourceMediaOrigin") or "unknown")
            for row in aligned_rows
        ).items())),
        "mediaAlignmentConfidenceBands": confidence_bands,
        "meanMediaAlignmentCharacterErrorRate": (
            float(np.mean(character_errors)) if character_errors else None
        ),
        "meanMediaAlignmentReviewWordFraction": (
            float(np.mean(review_fractions)) if review_fractions else None
        ),
        "mediaTimingResolutionSecondsMedian": (
            float(np.median(timing_resolutions)) if timing_resolutions else None
        ),
        "maximumAbsoluteSourceClockOffsetSeconds": (
            float(np.max(np.abs(source_clock_offsets)))
            if source_clock_offsets else None
        ),
        "independentTimingAudit": {
            "method": "Whisper free-decode word timestamps",
            "auditedVideos": len(independent_timing_audits),
            "medianMappedCoverage": (
                float(np.median([
                    float(audit["mappedCoverage"])
                    for audit in independent_timing_audits
                ])) if independent_timing_audits else None
            ),
            "medianStartAgreementSeconds": (
                float(np.median([
                    float(audit["startMedianAbsoluteErrorSeconds"])
                    for audit in independent_timing_audits
                ])) if independent_timing_audits else None
            ),
            "p95StartAgreementSeconds": (
                float(np.quantile([
                    float(audit["startP95AbsoluteErrorSeconds"])
                    for audit in independent_timing_audits
                ], 0.95)) if independent_timing_audits else None
            ),
            "p95Aggregation": (
                "95th percentile across per-video 95th-percentile absolute word-start errors"
            ),
            "forcedCanonicalTextUsed": False,
            "outcomesUsed": False,
            "referenceIsGroundTruth": False,
        },
        "independentHookEndpointAudit": {
            "method": "Whisper free-decode final matched word end",
            "auditedVideos": len(independent_hook_timing_audits),
            "auditedFinalHookEndpoints": len(independent_hook_endpoint_errors),
            "medianEndAgreementSeconds": (
                float(np.median(independent_hook_endpoint_errors))
                if independent_hook_endpoint_errors else None
            ),
            "p95EndAgreementSeconds": (
                float(np.quantile(independent_hook_endpoint_errors, 0.95))
                if independent_hook_endpoint_errors else None
            ),
            "forcedCanonicalTextUsed": False,
            "outcomesUsed": False,
            "referenceIsGroundTruth": False,
        },
        "sourceVideosWithObservedWordStartTimestamps": sum(
            bool(row["sourceWordStartTimestampsObserved"]) for row in rows
        ),
        "sourceVideosWithSourceSupportedWordStarts": sum(
            bool(row["wordStartsSourceSupported"]) for row in rows
        ),
        "sourceVideosWithFullyObservedResolvedWordStarts": sum(
            bool(row["resolvedWordStartsObserved"]) for row in rows
        ),
        "sourceVideosWithTimestampCollisions": sum(
            int(row["timestampCollisionGroups"] > 0) for row in rows
        ),
        "timestampCollisionGroups": sum(
            int(row["timestampCollisionGroups"]) for row in rows
        ),
        "timestampCollisionWords": sum(
            int(row["timestampCollisionWords"]) for row in rows
        ),
        "sourceVideosWithNonoverlappingResolvedIntervals": sum(
            bool(row["resolvedIntervalsNonoverlapping"]) for row in rows
        ),
        "sourceVideosWithObservedWordEnds": sum(
            bool(row["wordEndsObserved"]) for row in rows
        ),
        "tokenCount": sum(int(row["tokenCount"] or 0) for row in rows),
        "componentCount": sum(int(row["componentCount"] or 0) for row in rows),
        "spanCount": sum(int(row["spanCount"] or 0) for row in rows),
        "edgeCount": sum(int(row["edgeCount"] or 0) for row in rows),
        "categoryCount": 4,
        "categoryVocabulary": "the unchanged frozen four-category Promise Lab model",
        "lengthSupport": length_support,
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "partitionContract": {
            "builder": "score_hook.decode_partition",
            "variableComponentCount": True,
            "exactNonoverlappingCover": True,
            "componentCountConstraint": None,
            "longHorizonCalibration": horizon_extension,
            "outcomesUsedForBoundaries": False,
            "categoryCount": 4,
        },
        "latticeContract": {
            "builder": "component_lattice.build_component_lattice",
            "everyContiguousSpanPresent": True,
            "sameRepresentationMapsAsHooks": True,
            "sameStructuralEdgeFamiliesAsHooks": True,
            "outcomesUsedForStructuralEdges": False,
        },
        "retentionContract": {
            "observedThroughSeconds": OPENING_HORIZON_SECONDS,
            "forecastValues": 0,
            "primaryNormalization": "entry_indexed",
            "primaryFutureFree": True,
            "terminalConditionedViews": "retrospective sensitivity only",
            "forwardLagsSeconds": list(FORWARD_LAGS_SECONDS),
            "reverseControlsSeconds": list(REVERSE_CONTROL_LAGS_SECONDS),
        },
        "response": response_summary,
        "rows": rows,
        "elapsedSeconds": round(time.time() - started, 2),
    }
    atomic_json(SUMMARY_PATH, summary)

    if not args.no_upload:
        upload_opening_artifacts(
            summary, model_artifact, upload_workers=args.upload_workers,
        )

    update_progress(
        status="complete", stage="20-second opening analysis complete",
        sourcesComplete=len(rows), sourcesTotal=len(rows),
        spansMaterialized=summary["spanCount"],
    )
    print(json.dumps({
        "sources": len(rows),
        "tokens": summary["tokenCount"],
        "components": summary["componentCount"],
        "spans": summary["spanCount"],
        "elapsedSeconds": summary["elapsedSeconds"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
