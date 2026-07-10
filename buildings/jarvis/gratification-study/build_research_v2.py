#!/usr/bin/env python3
"""Build the second-generation RTG construct-discovery research artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from build_study import (
    CACHE_KEY,
    INDEX_KEY,
    MODEL,
    Store,
    ensure_embeddings,
    ensure_title_corpus_basis,
    load_records,
)
from rtg_clusters import build_component_clusters
from rtg_components import build_component_lattice
from rtg_embeddings import ensure_component_embeddings, text_key
from rtg_experiments import (
    ConfoundDef,
    RepresentationDef,
    aggregate_experiments,
    build_confound_matrix,
    build_grouped_folds,
    build_representations,
    crossfit_adjustments,
    pairwise_rank_correlation,
    run_experiment_sweep,
    run_null_sweeps,
)
from rtg_geometry import MetricDef, build_geometry_atlas, finite, safe_float
from rtg_pairs import (
    build_same_idea_pairs,
    pair_adjustment_matrices,
    pair_representation_matrices,
)


HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / ".cache"
REPORT_PATH = CACHE_DIR / "research_v2.json"
REGISTRY_PATH = CACHE_DIR / "experiments_v2.jsonl.gz"
COMPONENTS_PATH = CACHE_DIR / "components_v2.json.gz"
MATRICES_PATH = CACHE_DIR / "matrices_v2.npz"
MATRIX_JSON_PATH = CACHE_DIR / "relationship_matrices_v2.json.gz"
PROGRESS_PATH = CACHE_DIR / "progress_v2.json"

REPORT_KEY = "longform/gratification/v2/report.json"
REGISTRY_KEY = "longform/gratification/v2/experiments.jsonl.gz"
COMPONENTS_KEY = "longform/gratification/v2/components.json.gz"
MATRICES_KEY = "longform/gratification/v2/matrices.npz"
MATRIX_JSON_KEY = "longform/gratification/v2/relationship_matrices.json.gz"
PROGRESS_KEY = "longform/gratification/v2/progress.json"


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_progress(store: Store | None, stage: str, status: str, **details: Any) -> None:
    payload = {
        "version": 2,
        "updatedAt": now(),
        "stage": stage,
        "status": status,
        **details,
    }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    PROGRESS_PATH.write_text(json.dumps(payload, indent=2))
    if store is not None:
        store.put(PROGRESS_KEY, json.dumps(payload).encode("utf-8"), "application/json")
    print(f"[{stage}] {status} {details}", flush=True)


def upload_file(store: Store, path: Path, key: str, content_type: str) -> None:
    store.s3.upload_file(
        str(path),
        store.bucket,
        key,
        ExtraArgs={"ContentType": content_type},
    )


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, np.ndarray):
        return json_safe(value.tolist())
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value) if finite(value) else None
    return value


def exclusions(index: dict, rows: list[dict]) -> list[dict[str, Any]]:
    included = {str(row.get("id")) for row in rows}
    output = []
    for row in index.get("rows", []):
        video_id = str(row.get("id") or "")
        if video_id in included:
            continue
        reasons = []
        if not row.get("id"):
            reasons.append("missing video id")
        if not row.get("hookText"):
            reasons.append("missing extracted hook text")
        if not isinstance(row.get("curve"), list) or len(row.get("curve") or []) < 20:
            reasons.append("missing or incomplete retention curve")
        output.append({"id": video_id or None, "title": row.get("title"), "reasons": reasons or ["detail record incomplete"]})
    return output


def component_representation_definitions(features: dict[str, np.ndarray]) -> list[RepresentationDef]:
    output = []
    for key, values in features.items():
        if key == "component_context_interaction":
            output.append(RepresentationDef(
                key,
                "Component/context interaction SVD",
                values.shape[1],
                "outcome-blind SVD of per-video isolated-cluster x context-cluster counts",
                "numeric component and context clusters; no semantic RTG labels",
                basis="outcome_blind_transductive_component_context",
            ))
        else:
            output.append(RepresentationDef(
                key,
                key.replace("component_", "").replace("_", " ").title(),
                values.shape[1],
                "per-video cluster presence, component proportion, and mean position",
                "outcome-blind component clustering; exploratory until train-fold-only clustering repeats it",
                basis="outcome_blind_transductive_component_clusters",
            ))
    return output


def component_feature_definitions(features: dict[str, np.ndarray]) -> dict[str, list[ConfoundDef]]:
    output = {}
    for key, values in features.items():
        definitions = []
        if key == "component_context_interaction":
            for index in range(values.shape[1]):
                definitions.append(ConfoundDef(
                    f"{key}_svd{index + 1}",
                    f"Component/context interaction SVD {index + 1}",
                    key,
                    "outcome-blind SVD coordinate of per-video component x context counts",
                ))
        else:
            clusters = values.shape[1] // 3
            for channel, offset in (("presence", 0), ("proportion", clusters), ("mean_position", clusters * 2)):
                for cluster in range(clusters):
                    definitions.append(ConfoundDef(
                        f"{key}_{channel}_c{cluster:03d}",
                        f"{key} cluster {cluster} {channel.replace('_', ' ')}",
                        key,
                        f"per-video numeric cluster {channel}",
                    ))
        output[key] = definitions
    return output


def build_nuisance_targets(confounds: np.ndarray, confound_defs: list[ConfoundDef], groups: np.ndarray) -> tuple[np.ndarray, list[MetricDef]]:
    columns = [np.asarray(confounds[:, index], float) for index in range(confounds.shape[1])]
    definitions = [
        MetricDef(
            f"nuisance_{definition.id}",
            f"Nuisance prediction: {definition.label}",
            f"nuisance_{definition.family}",
            "falsification_target",
            "source units",
            definition.formula,
            {"sourceConfound": definition.id},
            role="falsification_target",
        )
        for definition in confound_defs
    ]
    for group in np.unique(groups):
        columns.append((groups == group).astype(float))
        definitions.append(MetricDef(
            f"nuisance_semantic_group_{int(group):02d}",
            f"Nuisance prediction: semantic idea group {int(group)}",
            "nuisance_semantic_group",
            "falsification_target",
            "0/1",
            "1[video belongs to outcome-blind semantic title cluster]",
            {"semanticGroup": int(group)},
            role="falsification_target",
        ))
    return np.column_stack(columns), definitions


def family_matrix_summary(matrix: np.ndarray, row_defs, column_defs) -> list[dict[str, Any]]:
    row_families = sorted({definition.family for definition in row_defs})
    column_families = sorted({definition.family for definition in column_defs})
    output = []
    for row_family in row_families:
        row_indices = [idx for idx, definition in enumerate(row_defs) if definition.family == row_family]
        for column_family in column_families:
            column_indices = [idx for idx, definition in enumerate(column_defs) if definition.family == column_family]
            block = matrix[np.ix_(row_indices, column_indices)]
            finite_values = block[np.isfinite(block)]
            if not len(finite_values):
                continue
            max_index = np.unravel_index(int(np.nanargmax(np.abs(block))), block.shape)
            output.append({
                "rowFamily": row_family,
                "columnFamily": column_family,
                "cells": int(np.isfinite(block).sum()),
                "medianAbsRho": round(float(np.nanmedian(np.abs(block))), 6),
                "maxAbsRho": round(float(np.nanmax(np.abs(block))), 6),
                "strongestRow": row_defs[row_indices[max_index[0]]].id,
                "strongestColumn": column_defs[column_indices[max_index[1]]].id,
                "strongestRho": round(float(block[max_index]), 6),
            })
    return output


def write_component_manifest(components, assignments, audit, embedding_manifest) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with gzip.open(COMPONENTS_PATH, "wt", encoding="utf-8", compresslevel=6) as handle:
        handle.write('{"meta":')
        handle.write(json.dumps(json_safe({
            "version": 2,
            "builtAt": now(),
            "count": len(components),
            "audit": audit,
            "embedding": embedding_manifest,
            "rule": "Components are deterministic spans and numeric clusters, not extracted RTG labels.",
        }), separators=(",", ":")))
        handle.write(',"components":[')
        for index, component in enumerate(components):
            if index:
                handle.write(",")
            value = component.json()
            value["componentEmbeddingKey"] = text_key(component.text)
            value["contextEmbeddingKey"] = text_key(component.contextText) if component.contextText else None
            value["clusters"] = assignments.get(component.id, {})
            handle.write(json.dumps(json_safe(value), separators=(",", ":")))
        handle.write("]}")


def write_experiment_registry(results) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with gzip.open(REGISTRY_PATH, "wt", encoding="utf-8", compresslevel=6) as handle:
        for result in results:
            handle.write(json.dumps(result.json(), separators=(",", ":")))
            handle.write("\n")


def write_relationship_matrices(
    outcome_outcome,
    outcome_outcome_n,
    confound_outcome,
    confound_outcome_n,
    confound_confound,
    confound_confound_n,
    component_relationships,
    metric_defs,
    confound_defs,
) -> None:
    payload = {
        "meta": {
            "version": 2,
            "builtAt": now(),
            "formula": "Pair-overlap Pearson correlation of columnwise ranks.",
            "outcomeIds": [definition.id for definition in metric_defs],
            "confoundIds": [definition.id for definition in confound_defs],
        },
        "outcomeOutcome": {
            "rho": np.round(outcome_outcome, 5).tolist(),
            "n": outcome_outcome_n.tolist(),
        },
        "confoundOutcome": {
            "rho": np.round(confound_outcome, 5).tolist(),
            "n": confound_outcome_n.tolist(),
        },
        "confoundConfound": {
            "rho": np.round(confound_confound, 5).tolist(),
            "n": confound_confound_n.tolist(),
        },
        "componentOutcome": {
            key: {
                "featureIds": [definition.id for definition in value["definitions"]],
                "rho": np.round(value["outcome"], 5).tolist(),
                "n": value["outcomeN"].tolist(),
            }
            for key, value in component_relationships.items()
        },
        "componentConfound": {
            key: {
                "featureIds": [definition.id for definition in value["definitions"]],
                "rho": np.round(value["confound"], 5).tolist(),
                "n": value["confoundN"].tolist(),
            }
            for key, value in component_relationships.items()
        },
    }
    with gzip.open(MATRIX_JSON_PATH, "wt", encoding="utf-8", compresslevel=6) as handle:
        json.dump(json_safe(payload), handle, separators=(",", ":"))


def attach_top_predictions(aggregate, predictions, adjusted, target_defs, video_ids, limit=400) -> None:
    target_index = {definition.id: idx for idx, definition in enumerate(target_defs)}
    enriched = []
    for result in aggregate["top"]:
        if len(enriched) >= limit:
            break
        prediction = predictions.get(result["id"])
        if prediction is None:
            continue
        actual = adjusted[result["adjustment"]][:, target_index[result["target"]]]
        value = dict(result)
        value["plot"] = {
            "videoIds": video_ids,
            "oof": prediction,
            "actual": [round(float(item), 6) if finite(item) else None for item in actual],
        }
        enriched.append(value)
    aggregate["topWithPredictions"] = enriched


def compact_video_rows(rows, components, geometry_values) -> list[dict[str, Any]]:
    counts = Counter(component.videoId for component in components)
    selected_metrics = [
        "traditional_keep", "traditional_avg_retention", "traditional_log_views",
        "replay_start_excess", "entry_drop_1s", "entry_drop_3s", "entry_drop_5s",
        "curve_total_variation", "curve_rebound_count", "curve_largest_change_time",
        "hook_slope_change_p3", "hook_slope_change_p5", "hook_slope_change_p10",
        "flat_best_start_p3", "flat_best_slope_p3", "flat_longest_p0d25",
    ]
    output = []
    for row in rows:
        values = geometry_values[str(row["id"])]
        output.append({
            "id": row.get("id"),
            "title": row.get("title"),
            "url": row.get("url"),
            "published": row.get("published"),
            "views": row.get("views"),
            "keep": row.get("keep_rate"),
            "duration": row.get("duration_s"),
            "hookText": row.get("hookText"),
            "hookEndSec": row.get("hookEndSec"),
            "transcriptSource": row.get("transcriptSource"),
            "cutBy": row.get("cutBy"),
            "componentCount": counts[str(row["id"])],
            "curve": row.get("curve"),
            "selectedGeometry": {metric: values.get(metric) for metric in selected_metrics if metric in values},
        })
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=40)
    parser.add_argument("--null-iterations", type=int, default=9)
    parser.add_argument("--skip-component-embeddings", action="store_true")
    parser.add_argument("--no-publish", action="store_true")
    parser.add_argument("--force-hook-embeddings", action="store_true")
    args = parser.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    store = Store()
    publish = not args.no_publish
    write_progress(store if publish else None, "load", "running")
    index, rows = load_records(store)
    hook_vectors, title_vectors, hook_embedding_manifest = ensure_embeddings(
        store, rows, force=args.force_hook_embeddings, workers=args.workers
    )
    title_basis = ensure_title_corpus_basis(store)
    write_progress(store if publish else None, "load", "complete", indexed=len(index.get("rows", [])), included=len(rows))

    write_progress(store if publish else None, "geometry", "running")
    geometry, metric_defs, curve_bases, geometry_values = build_geometry_atlas(rows)
    write_progress(store if publish else None, "geometry", "complete", metrics=len(metric_defs))

    write_progress(store if publish else None, "components", "running")
    components, component_audit = build_component_lattice(rows)
    write_progress(store if publish else None, "components", "complete", components=len(components))

    component_vectors = {}
    component_embedding_manifest = {
        "status": "skipped",
        "reason": "--skip-component-embeddings",
    }
    if not args.skip_component_embeddings:
        write_progress(store if publish else None, "component_embeddings", "running", uniqueTexts="calculating")
        texts = [value for component in components for value in (component.text, component.contextText) if value]
        component_vectors, component_embedding_manifest = ensure_component_embeddings(
            store, texts, workers=args.workers, batch_size=args.batch_size, publish=publish
        )
        write_progress(store if publish else None, "component_embeddings", "complete", uniqueTexts=len(component_vectors))

    groups, folds, fold_meta = build_grouped_folds(title_vectors)
    confounds, confound_defs, _ = build_confound_matrix(rows, hook_vectors, title_vectors, title_basis)
    representations, representation_defs = build_representations(hook_vectors, title_vectors, title_basis)

    cluster_metadata = {
        "status": "not built because component embeddings were skipped",
        "families": {},
    }
    component_features = {}
    assignments = {}
    if component_vectors:
        write_progress(store if publish else None, "clusters", "running")
        component_features, cluster_metadata, assignments = build_component_clusters(
            components, rows, component_vectors, title_basis, hook_vectors, title_vectors, groups
        )
        representations.update(component_features)
        representation_defs.extend(component_representation_definitions(component_features))
        write_progress(store if publish else None, "clusters", "complete", families=len(cluster_metadata.get("families", {})))

    write_progress(store if publish else None, "adjustments", "running", confounds=len(confound_defs))
    adjusted, adjustment_metadata = crossfit_adjustments(
        geometry, metric_defs, confounds, confound_defs, folds
    )
    write_progress(store if publish else None, "adjustments", "complete", regimes=len(adjusted))

    pairs, pair_folds, pair_metadata = build_same_idea_pairs(rows, title_vectors, groups)
    pair_representations = pair_representation_matrices(representations, pairs)
    pair_adjusted = pair_adjustment_matrices(adjusted, pairs)
    nuisance_targets, nuisance_defs = build_nuisance_targets(confounds, confound_defs, groups)

    write_progress(
        store if publish else None,
        "experiments",
        "running",
        planned=len(representations) * len(adjusted) * 4 * len(metric_defs),
    )
    results, prediction_cache = run_experiment_sweep(
        representations,
        adjusted,
        metric_defs,
        folds,
        progress_callback=lambda done, total, tests: write_progress(
            store if publish else None, "experiments", "running", batchesDone=done, batchesTotal=total, testsComplete=tests
        ),
    )
    aggregate = aggregate_experiments(results, metric_defs)
    video_ids = [str(row["id"]) for row in rows]
    attach_top_predictions(aggregate, prediction_cache, adjusted, metric_defs, video_ids)

    pair_results = []
    pair_aggregate = {"top": [], "perTargetBest": {}, "matrixCells": [], "topWithPredictions": []}
    if pair_folds:
        write_progress(
            store if publish else None,
            "same_idea_pairs",
            "running",
            pairs=len(pairs),
            planned=len(pair_representations) * len(pair_adjusted) * 4 * len(metric_defs),
        )
        pair_results, pair_predictions = run_experiment_sweep(
            pair_representations,
            pair_adjusted,
            metric_defs,
            pair_folds,
            scope="same_idea_difference",
            progress_callback=lambda done, total, tests: write_progress(
                store if publish else None, "same_idea_pairs", "running", batchesDone=done, batchesTotal=total, testsComplete=tests
            ),
        )
        pair_aggregate = aggregate_experiments(pair_results, metric_defs)
        pair_ids = [f"{pair['aId']}::{pair['bId']}" for pair in pairs]
        attach_top_predictions(pair_aggregate, pair_predictions, pair_adjusted, metric_defs, pair_ids)
        write_progress(store if publish else None, "same_idea_pairs", "complete", tests=len(pair_results))
    all_results = results + pair_results
    write_progress(
        store if publish else None,
        "nuisance_falsification",
        "running",
        planned=len(representations) * 4 * len(nuisance_defs),
    )
    nuisance_results, nuisance_predictions = run_experiment_sweep(
        representations,
        {"raw_nuisance": nuisance_targets},
        nuisance_defs,
        folds,
        scope="nuisance_prediction",
        progress_callback=lambda done, total, tests: write_progress(
            store if publish else None, "nuisance_falsification", "running", batchesDone=done, batchesTotal=total, testsComplete=tests
        ),
    )
    nuisance_aggregate = aggregate_experiments(nuisance_results, nuisance_defs)
    attach_top_predictions(
        nuisance_aggregate,
        nuisance_predictions,
        {"raw_nuisance": nuisance_targets},
        nuisance_defs,
        video_ids,
    )
    all_results += nuisance_results
    write_progress(store if publish else None, "nuisance_falsification", "complete", tests=len(nuisance_results))
    write_progress(store if publish else None, "experiments", "complete", tests=len(all_results))

    write_progress(store if publish else None, "relationships", "running")
    outcome_outcome, outcome_outcome_n = pairwise_rank_correlation(geometry, geometry)
    confound_outcome, confound_outcome_n = pairwise_rank_correlation(confounds, geometry)
    confound_confound, confound_confound_n = pairwise_rank_correlation(confounds, confounds)
    feature_defs = component_feature_definitions(component_features)
    component_relationships = {}
    component_outcome_summary = []
    component_confound_summary = []
    for key, features in component_features.items():
        feature_outcome, feature_outcome_n = pairwise_rank_correlation(features, geometry)
        feature_confound, feature_confound_n = pairwise_rank_correlation(features, confounds)
        component_relationships[key] = {
            "definitions": feature_defs[key],
            "outcome": feature_outcome,
            "outcomeN": feature_outcome_n,
            "confound": feature_confound,
            "confoundN": feature_confound_n,
        }
        component_outcome_summary.extend(family_matrix_summary(feature_outcome, feature_defs[key], metric_defs))
        component_confound_summary.extend(family_matrix_summary(feature_confound, feature_defs[key], confound_defs))
    relationship_summaries = {
        "outcomeOutcome": family_matrix_summary(outcome_outcome, metric_defs, metric_defs),
        "confoundOutcome": family_matrix_summary(confound_outcome, confound_defs, metric_defs),
        "confoundConfound": family_matrix_summary(confound_confound, confound_defs, confound_defs),
        "componentOutcome": component_outcome_summary,
        "componentConfound": component_confound_summary,
        "formula": "Pair-overlap Pearson correlation of columnwise ranks; matrices store pair counts and exact source IDs.",
    }
    write_progress(store if publish else None, "relationships", "complete")

    nulls = {
        "status": "skipped",
        "reason": "--null-iterations=0",
    }
    if args.null_iterations > 0:
        write_progress(store if publish else None, "nulls", "running", iterations=args.null_iterations)
        nulls = run_null_sweeps(
            representations, adjusted, folds, groups, iterations=args.null_iterations
        )
        write_progress(store if publish else None, "nulls", "complete", iterations=args.null_iterations)

    write_progress(store if publish else None, "artifacts", "running")
    adjusted_arrays = {f"adjusted_{key}": np.asarray(value, np.float32) for key, value in adjusted.items()}
    representation_arrays = {f"representation_{key}": np.asarray(value, np.float32) for key, value in representations.items()}
    component_matrix_arrays = {}
    for key, value in component_relationships.items():
        component_matrix_arrays[f"component_outcome_{key}"] = value["outcome"]
        component_matrix_arrays[f"component_outcome_n_{key}"] = value["outcomeN"]
        component_matrix_arrays[f"component_confound_{key}"] = value["confound"]
        component_matrix_arrays[f"component_confound_n_{key}"] = value["confoundN"]
    np.savez_compressed(
        MATRICES_PATH,
        geometry=np.asarray(geometry, np.float32),
        metric_ids=np.asarray([definition.id for definition in metric_defs]),
        confounds=np.asarray(confounds, np.float32),
        confound_ids=np.asarray([definition.id for definition in confound_defs]),
        outcome_outcome=outcome_outcome,
        outcome_outcome_n=outcome_outcome_n,
        confound_outcome=confound_outcome,
        confound_outcome_n=confound_outcome_n,
        confound_confound=confound_confound,
        confound_confound_n=confound_confound_n,
        semantic_groups=np.asarray(groups, np.int16),
        video_ids=np.asarray(video_ids),
        **adjusted_arrays,
        **representation_arrays,
        **component_matrix_arrays,
    )
    write_experiment_registry(all_results)
    write_component_manifest(components, assignments, component_audit, component_embedding_manifest)
    write_relationship_matrices(
        outcome_outcome,
        outcome_outcome_n,
        confound_outcome,
        confound_outcome_n,
        confound_confound,
        confound_confound_n,
        component_relationships,
        metric_defs,
        confound_defs,
    )

    report = {
        "meta": {
            "version": 2,
            "builtAt": now(),
            "status": "initial broad sweep complete",
            "epistemicStatus": "RTG remains unquantified; this artifact contains candidate relationships and null-calibrated search infrastructure.",
            "indexedVideos": len(index.get("rows", [])),
            "includedVideos": len(rows),
            "excludedVideos": len(exclusions(index, rows)),
            "retentionMetrics": len(metric_defs),
            "confounds": len(confound_defs),
            "components": len(components),
            "representations": len(representations),
            "adjustmentRegimes": len(adjusted),
            "experiments": len(all_results),
            "videoLevelExperiments": len(results),
            "sameIdeaDifferenceExperiments": len(pair_results),
            "nuisanceFalsificationExperiments": len(nuisance_results),
            "fullRegistryKey": REGISTRY_KEY,
            "componentManifestKey": COMPONENTS_KEY,
            "matrixKey": MATRICES_KEY,
            "researchProgram": "buildings/jarvis/gratification-study/RESEARCH_PROGRAM.md",
        },
        "source": {
            "indexKey": INDEX_KEY,
            "hookEmbeddingKey": CACHE_KEY,
            "hookEmbedding": hook_embedding_manifest,
            "titleCorpus": {
                "vectors": title_basis.n_titles,
                "basisDimensions": int(title_basis.components_.shape[0]),
                "sourceVersion": title_basis.source_etag,
                "explainedVariance": round(float(np.sum(title_basis.explained_variance_ratio_)), 6),
            },
            "exclusions": exclusions(index, rows),
        },
        "corpusAudit": component_audit,
        "componentEmbedding": component_embedding_manifest,
        "validation": {
            **fold_meta,
            "outcomeSelection": "No retention geometry is privileged as RTG truth.",
            "componentSelection": "Clusters are outcome-blind numeric structures; transductive component representations are exploratory only.",
            "multipleTesting": "BH q values cover the complete registered ridge sweep. Null sweeps repeat a broad promotion family; 99+ repeats remain required for promotion.",
            "selfControlRule": "An adjustment is invalidated for a target when it contains that exact target as a control.",
        },
        "geometry": {
            "metrics": [definition.json() for definition in metric_defs],
            "curveBases": curve_bases,
            "families": dict(Counter(definition.family for definition in metric_defs)),
        },
        "confounds": {
            "definitions": [definition.json() for definition in confound_defs],
            "families": dict(Counter(definition.family for definition in confound_defs)),
        },
        "adjustments": adjustment_metadata,
        "representations": [definition.json() for definition in representation_defs],
        "clusters": cluster_metadata,
        "experiments": aggregate,
        "sameIdea": {
            "meta": pair_metadata,
            "pairs": pairs,
            "experiments": pair_aggregate,
            "epistemicStatus": "Observed same-ish idea difference, not a randomized same-idea causal comparison.",
        },
        "nuisancePrediction": {
            "targets": [definition.json() for definition in nuisance_defs],
            "experiments": nuisance_aggregate,
            "rule": "These are disqualification diagnostics. A representation that predicts nuisance structure more strongly than retention candidates is not promoted as RTG.",
        },
        "nullCalibration": nulls,
        "relationships": relationship_summaries,
        "artifacts": {
            "report": REPORT_KEY,
            "registry": {"key": REGISTRY_KEY, "sha256": sha_file(REGISTRY_PATH), "bytes": REGISTRY_PATH.stat().st_size},
            "components": {"key": COMPONENTS_KEY, "sha256": sha_file(COMPONENTS_PATH), "bytes": COMPONENTS_PATH.stat().st_size},
            "matrices": {"key": MATRICES_KEY, "sha256": sha_file(MATRICES_PATH), "bytes": MATRICES_PATH.stat().st_size},
            "relationshipMatrices": {"key": MATRIX_JSON_KEY, "sha256": sha_file(MATRIX_JSON_PATH), "bytes": MATRIX_JSON_PATH.stat().st_size},
        },
        "videos": compact_video_rows(rows, components, geometry_values),
        "nextPromotionGates": [
            "Repeat component clustering inside each training fold before treating component-axis performance as inductive evidence.",
            "Run at least 99 selection-repeating null permutations for any promoted family.",
            "Add strict same-idea matched-difference and controlled variant data before causal promise-amplification claims.",
            "Replicate surviving candidates across idea-anchor methods, curve coordinate systems, source splits, and hook-cut sensitivity.",
        ],
    }
    REPORT_PATH.write_text(json.dumps(json_safe(report), separators=(",", ":")))
    if publish:
        upload_file(store, REPORT_PATH, REPORT_KEY, "application/json")
        upload_file(store, REGISTRY_PATH, REGISTRY_KEY, "application/gzip")
        upload_file(store, COMPONENTS_PATH, COMPONENTS_KEY, "application/gzip")
        upload_file(store, MATRICES_PATH, MATRICES_KEY, "application/octet-stream")
        upload_file(store, MATRIX_JSON_PATH, MATRIX_JSON_KEY, "application/gzip")
    write_progress(
        store if publish else None,
        "complete",
        "complete",
        reportKey=REPORT_KEY,
        experiments=len(all_results),
        components=len(components),
        metrics=len(metric_defs),
        reportSha256=sha_file(REPORT_PATH),
    )
    print(json.dumps({
        "report": str(REPORT_PATH),
        "experiments": len(all_results),
        "components": len(components),
        "metrics": len(metric_defs),
        "representations": len(representations),
        "published": publish,
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
