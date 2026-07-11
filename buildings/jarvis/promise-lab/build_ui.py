#!/usr/bin/env python3
"""Assemble browser artifacts and a single provenance manifest."""

from __future__ import annotations

import gzip
import json
import time
from collections import Counter
from pathlib import Path

import numpy as np

from atlas import summarize_map_clusters
from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, R2Store, json_ready


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def load_json(name, default=None):
    path = CACHE / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def load_jsonl_gz(name):
    path = CACHE / name
    if not path.exists():
        return []
    text = gzip.decompress(path.read_bytes()).decode("utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def finite(value):
    try:
        return bool(np.isfinite(float(value)))
    except (TypeError, ValueError):
        return False


def median_field(rows, field):
    values = [float(row[field]) for row in rows if finite(row.get(field))]
    return float(np.median(values)) if values else None


def representation_indicators(atlas):
    grouped = {}
    for row in atlas.get("maps") or []:
        grouped.setdefault(str(row.get("representation") or ""), []).append(row)
    output = []
    for name, rows in sorted(grouped.items()):
        best = max(rows, key=lambda row: float(row.get("qualityForBrowsing") or 0), default={})
        output.append({
            "representation": name,
            "maps": len(rows),
            "medianMarginAboveNull": median_field(rows, "marginAboveNull"),
            "medianHeldoutHookMargin": median_field(rows, "heldoutHookMargin"),
            "medianSeedStabilityARI": median_field(rows, "seedStabilityARI"),
            "medianLengthNMI": median_field(rows, "lengthNMI"),
            "medianPositionNMI": median_field(rows, "positionNMI"),
            "medianCrossHookGenerality": median_field(rows, "crossHookGenerality"),
            "medianCrossScopeARI": median_field(rows, "crossScopeBestARI"),
            "medianBoundarySupportEnrichment": median_field(
                rows, "boundarySupportWeightedEnrichment"
            ),
            "bestMapId": best.get("id"),
            "bestMap": {
                key: best.get(key) for key in (
                    "pcaDimensions", "geometry", "clusterCount", "qualityForBrowsing",
                    "marginAboveNull", "seedStabilityARI", "lengthNMI", "positionNMI",
                    "crossHookGenerality", "crossScopeBestARI",
                )
            },
        })
    return output


def enrich_cluster_summaries(atlas):
    rows = atlas.get("spans") or atlas.get("candidates") or []
    projections = atlas.get("projections") or {}
    changed = False
    for row in atlas.get("maps") or []:
        if row.get("clusterSummaries"):
            for summary in row["clusterSummaries"]:
                if "representativeMethod" not in summary:
                    summary["representativeMethod"] = (
                        "nearest displayed-2D centroid with source-hook diversity first"
                    )
                    changed = True
            continue
        row["clusterSummaries"] = summarize_map_clusters(
            rows, row, projections.get(row.get("representation")) or []
        )
        changed = True
    return changed


def compact_registry_row(row):
    keep = (
        "id", "stage", "videoId", "method", "segmentCount", "objective", "z", "p", "q",
        "representation", "pcaDimensions", "geometry", "clusterCount", "seed", "margin",
        "heldoutHookMargin", "entropy", "minimumClusterFraction", "seedStabilityARI",
        "permutedNullMargin", "marginAboveNull", "qualityForBrowsing", "scope",
        "lengthNMI", "positionNMI", "crossHookGenerality", "lengthIndependence",
        "positionIndependence", "crossScopeARI", "sameRepresentationARI",
        "boundarySupportWeightedEnrichment", "bestCandidateMapId",
        "bestCandidateRepresentation", "confounds", "target",
        "targetChannel", "targetDefinition", "ridgeAlpha", "n", "heldoutSpearman", "heldoutPearson", "heldoutR2",
        "searchWideP", "searchWideQ", "searchWideNull", "selectedForTarget",
        "selectedForClusterTarget", "cluster", "targetLabel", "targetFamily",
        "offsetSeconds", "frozenMapId", "frozenLabelsChanged",
        "nullRepeats", "minimumAttainableP",
        "bestPredictiveForTarget", "validationConfoundsRequired", "targetUnit",
        "multipleTestingFamily", "status", "outcomesUsed",
    )
    return {key: row.get(key) for key in keep if key in row}


def main() -> None:
    corpus = load_json("corpus.json", {"rows": []})
    interventions = load_json("intervention-summary.json", {})
    discovery = load_json("discovery-summary.json", {})
    atlas = load_json("atlas.json", {})
    all_span_atlas = load_json("all-span-atlas.json", {})
    cross_scope = load_json("cross-scope.json", {})
    for name, value in (("atlas.json", atlas), ("all-span-atlas.json", all_span_atlas)):
        if value and enrich_cluster_summaries(value):
            (CACHE / name).write_text(
                json.dumps(json_ready(value), separators=(",", ":"), allow_nan=False),
                encoding="utf-8",
            )
    swaps = load_json("swaps.json", {})
    axes = load_json("axes.json", {})
    manual_probe = load_json("manual-probe.json", {})
    manual_projection = load_json("manual-projection.json", {})
    cluster_outcomes = load_json("cluster-outcomes.json", {})
    latency_study = load_json("latency-study.json", {})
    boundary_registry = load_jsonl_gz("boundary-experiments.jsonl.gz")
    cluster_registry = load_jsonl_gz("cluster-experiments.jsonl.gz")
    all_span_cluster_registry = load_jsonl_gz("all-span-cluster-experiments.jsonl.gz")
    cross_scope_registry = load_jsonl_gz("cross-scope-experiments.jsonl.gz")
    axis_registry = load_jsonl_gz("axis-experiments.jsonl.gz")
    cluster_outcome_registry = load_jsonl_gz("cluster-outcomes-experiments.jsonl.gz")
    metadata_rows = [json.loads(path.read_text(encoding="utf-8"))
                     for path in (CACHE / "metadata").glob("*.json")]
    if len(metadata_rows) > int(interventions.get("hooksComplete") or 0):
        interventions = {
            **interventions,
            "hooksComplete": len(metadata_rows),
            "embeddingTextsMaterialized": sum(int(row.get("uniqueEmbeddingTexts") or 0)
                                                for row in metadata_rows),
            "spansMaterialized": sum(int(row.get("spanCount") or 0) for row in metadata_rows),
            "tokenPairsMaterialized": sum(int(row.get("tokenPairCount") or 0) for row in metadata_rows),
        }
    registry = [compact_registry_row(row) for row in
                boundary_registry + cluster_registry + all_span_cluster_registry
                + cross_scope_registry + axis_registry]
    registry.extend(compact_registry_row(row) for row in cluster_outcome_registry)

    selected = [row.get("selectedSegmentation") or {} for row in discovery.get("rows") or []]
    selected_counts = Counter(int(row.get("segmentCount") or 0) for row in selected)
    supported = sum(row.get("status") == "supported" for row in selected)
    no_evidence = sum(row.get("status") == "no-separable-component-evidence" for row in selected)
    cluster_experiments = cluster_registry
    best_cluster = max(cluster_experiments, key=lambda row: float(row.get("qualityForBrowsing") or 0),
                       default={})
    best_all_span_cluster = max(
        all_span_atlas.get("maps") or [],
        key=lambda row: float(row.get("qualityForBrowsing") or 0),
        default={},
    )
    validated_axes = [row for row in axis_registry if row.get("status") == "validated"]
    selected_axes = [row for row in axis_registry if row.get("selectedForTarget")]
    validated_model_axes = [
        row for row in validated_axes
        if row.get("targetChannel") == "Long Quant model-predicted counterfactual"
    ]
    validated_observed_axes = [
        row for row in validated_axes
        if row.get("targetChannel") == "observed YouTube outcome"
    ]
    observed_span_axes = [
        row for row in validated_observed_axes
        if row.get("representation") in {"raw", "influence", "nonadditive"}
    ]
    selected_model_axes = [
        row for row in selected_axes
        if row.get("targetChannel") == "Long Quant model-predicted counterfactual"
    ]
    selected_observed_axes = [
        row for row in selected_axes
        if row.get("targetChannel") == "observed YouTube outcome"
    ]
    top_transfer = {}
    for metric in swaps.get("metricNames") or []:
        ranked = sorted(
            swaps.get("sourceComponents") or [],
            key=lambda row: float(((row.get("metrics") or {}).get(metric) or {}).get(
                "meanDeltaAcrossContexts") or -1e30),
            reverse=True,
        )[:12]
        top_transfer[metric] = [
            {
                "sourceId": row.get("sourceId"),
                "text": row.get("text"),
                "contextText": row.get("contextText"),
                **((row.get("metrics") or {}).get(metric) or {}),
            }
            for row in ranked
        ]

    findings = {
        "status": "complete" if axes.get("status") == "complete" else "building",
        "boundary": {
            "hooksTested": len(selected),
            "supportedMultiSegmentHooks": supported,
            "noSeparableComponentEvidence": no_evidence,
            "provisionalHooks": max(0, len(selected) - supported - no_evidence),
            "selectedSegmentCountDistribution": dict(sorted(selected_counts.items())),
            "supportedHooks": [
                {
                    "videoId": row.get("videoId"),
                    "text": row.get("text"),
                    "segmentation": row.get("selectedSegmentation"),
                }
                for row in discovery.get("rows") or []
                if (row.get("selectedSegmentation") or {}).get("status") == "supported"
            ],
            "interpretation": "A selected partition is a null-calibrated geometric result, not a named promise component.",
        },
        "cluster": {
            "candidateInstances": atlas.get("candidateInstances", 0),
            "experiments": len(cluster_registry),
            "mapsVisible": atlas.get("mapCount", len(atlas.get("maps") or [])),
            "bestOutcomeBlindConfiguration": compact_registry_row(best_cluster) if best_cluster else None,
            "allContiguousSpanInstances": all_span_atlas.get("spanInstances", 0),
            "allContiguousExperiments": len(all_span_cluster_registry),
            "allContiguousMapsVisible": all_span_atlas.get(
                "mapCount", len(all_span_atlas.get("maps") or [])
            ),
            "bestAllContiguousConfiguration": (
                compact_registry_row(best_all_span_cluster) if best_all_span_cluster else None
            ),
            "crossScope": {
                "consensusAgreement": cross_scope.get("consensusAgreement"),
                "bestARIDistribution": cross_scope.get("bestARIDistribution"),
                "byRepresentation": cross_scope.get("byRepresentation"),
            },
            "candidateRepresentationIndicators": representation_indicators(atlas),
            "allSpanRepresentationIndicators": representation_indicators(all_span_atlas),
            "interpretation": "Two unnamed atlases are retained: evidence-supported boundary candidates and every contiguous span. Position and outcomes were excluded from fitting; length and position leakage are reported for the exhaustive scope.",
        },
        "swap": {
            "sourceComponents": swaps.get("sourceComponentCount", 0),
            "targetHooks": swaps.get("targetHookCount", 0),
            "rows": swaps.get("swapRows", 0),
            "metricNames": swaps.get("metricNames", []),
            "topTransferByMetric": top_transfer,
            "interpretation": "Transfer lift is Long Quant model-predicted counterfactual evidence, not observed viewer behavior.",
        },
        "axis": {
            "experiments": len(axis_registry),
            "validated": len(validated_axes),
            "validatedIds": [row["id"] for row in validated_axes[:100]],
            "selectedByTarget": [compact_registry_row(row) for row in selected_axes],
            "modelTransferTargets": len(selected_model_axes),
            "modelTransferValidated": len(validated_model_axes),
            "observedTargets": len(selected_observed_axes),
            "observedValidated": len(validated_observed_axes),
            "observedSourceSpanValidated": len(observed_span_axes),
            "validatedByChannel": dict(Counter(row.get("targetChannel") for row in validated_axes)),
            "validatedByRepresentation": dict(Counter(
                row.get("representation") for row in validated_axes
            )),
            "validatedModelTransfer": [compact_registry_row(row) for row in validated_model_axes],
            "validatedObserved": [compact_registry_row(row) for row in validated_observed_axes],
            "interpretation": (
                "All model-predicted transfer targets validate on raw source-span semantics. "
                "The corrected observed-outcome signals validate only on retained context; no "
                "raw, influence, or non-additive source-span direction yet validates against "
                "observed YouTube outcomes."
            ),
        },
        "manualProbe": {
            "status": manual_probe.get("status"),
            "policy": manual_probe.get("policy"),
            "counts": manual_probe.get("counts"),
            "winner": manual_probe.get("winner"),
            "interpretation": (
                "A manual post-hoc overfit probe over frozen maps only. It does not enter "
                "discovery, clustering, or outcome-axis fitting."
            ),
        },
        "manualProjection": {
            "status": manual_projection.get("status"),
            "saved": manual_projection.get("saved"),
            "savedName": manual_projection.get("savedName"),
            "mapId": manual_projection.get("mapId"),
            "selectedMethod": manual_projection.get("selectedMethod"),
            "improvementOverPca": manual_projection.get("improvementOverPca"),
            "labelsChanged": manual_projection.get("labelsChanged"),
            "interpretation": (
                "Post-hoc viewing planes for one frozen map. They change displayed coordinates, "
                "never cluster membership."
            ),
        },
        "clusterOutcomes": {
            "status": cluster_outcomes.get("status"),
            "mapId": cluster_outcomes.get("mapId"),
            "clusters": cluster_outcomes.get("clusterCount", 0),
            "targetFamilies": cluster_outcomes.get("selectedFamilyCount", 0),
            "experiments": cluster_outcomes.get("experimentCount", 0),
            "validated": cluster_outcomes.get("validatedFamilyCount", 0),
            "timingAudit": cluster_outcomes.get("timingAudit"),
            "topIndicators": cluster_outcomes.get("topIndicators", [])[:12],
            "interpretation": (
                "Outcome and exact phrase-slope axes fitted only after freezing the four labels; "
                "every reported correlation is held out by source video."
            ),
        },
        "latencyStudy": {
            "status": latency_study.get("status"),
            "mapId": latency_study.get("mapId"),
            "clusters": latency_study.get("clusterCount", 0),
            "lags": len(latency_study.get("lagsSeconds") or []),
            "windows": len(latency_study.get("windows") or []),
            "curveResolution": latency_study.get("curveResolution"),
            "interpretation": (
                "One held-out semantic ruler per fold is shared across every lag and alignment; "
                "text-free natural-drop baselines and negative lags prevent post-hoc latency claims."
            ),
        },
    }
    (CACHE / "findings.json").write_text(json.dumps(json_ready(findings), separators=(",", ":"),
                                                    allow_nan=False),
                                          encoding="utf-8")
    registry_artifact = {
        "version": 4,
        "count": len(registry),
        "stageCounts": dict(Counter(row.get("stage") for row in registry)),
        "rows": registry,
    }
    (CACHE / "registry.json").write_text(json.dumps(json_ready(registry_artifact), separators=(",", ":"),
                                                    allow_nan=False),
                                          encoding="utf-8")

    manifest = {
        "version": 4,
        "status": findings["status"],
        "builtAt": int(time.time() * 1000),
        "title": "Promise Lab: first-principles semantic component discovery",
        "source": "208 complete Shorts hooks already embedded in the Long Quant text space",
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "semanticRules": 0,
        "counts": {
            "hooks": len(corpus.get("rows") or []),
            "embeddingTexts": interventions.get("embeddingTextsMaterialized",
                                                    interventions.get("designedEmbeddingTexts", 0)),
            "spans": interventions.get("spansMaterialized", 0),
            "tokenPairs": interventions.get("tokenPairsMaterialized", 0),
            "boundaryExperiments": len(boundary_registry),
            "componentCandidates": atlas.get("candidateInstances", 0),
            "allContiguousSpans": all_span_atlas.get("spanInstances", 0),
            "clusterExperiments": len(cluster_registry) + len(all_span_cluster_registry),
            "candidateClusterExperiments": len(cluster_registry),
            "allSpanClusterExperiments": len(all_span_cluster_registry),
            "clusterMaps": len(atlas.get("maps") or []),
            "allSpanClusterMaps": len(all_span_atlas.get("maps") or []),
            "crossScopeExperiments": len(cross_scope_registry),
            "swapRows": swaps.get("swapRows", 0),
            "axisExperiments": len(axis_registry),
            "clusterOutcomeExperiments": len(cluster_outcome_registry),
            "clusterOutcomeFamilies": cluster_outcomes.get("selectedFamilyCount", 0),
            "latencyStudyClusters": latency_study.get("clusterCount", 0),
            "latencyStudyLags": len(latency_study.get("lagsSeconds") or []),
            "latencyStudyWindows": len(latency_study.get("windows") or []),
            "manualProbeMapsCompared": (
                (manual_probe.get("counts") or {}).get("frozenMapsCompared", 0)
            ),
            "manualProjectionMethods": len(manual_projection.get("methods") or []),
            "savedEmbeddings": int(bool(manual_projection.get("saved"))),
        },
        "separation": {
            "discoveryInputs": "hook text, token order, Gemini text vectors, exact deletion counterfactuals",
            "discoveryExcludes": "example phrases, connector lists, clause rules, outcomes, retention, views, position",
            "atlasScopes": "boundary-supported candidates and every contiguous span are stored separately",
            "allSpanTransforms": "primitive embeddings, algebraic contrasts, categorical nuisance residuals, and equal-block multiview concatenation",
            "outcomesJoinAfterDiscovery": True,
            "measuredAndPredictedEvidenceSeparated": True,
            "manualProbeSeparated": (
                "manual interpretation is post-hoc, creates zero maps, and never enters discovery"
            ),
            "manualProjectionSeparated": (
                "fixed-label viewing experiment only; labels, maps, outcomes, and discovery are unchanged"
            ),
            "clusterOutcomesSeparated": (
                "outcomes join only after the k=4 labels are frozen; source-video holdout and "
                "search-wide nulls govern every cluster-target axis"
            ),
            "latencyStudySeparated": (
                "one semantic score is shared across every lag within each held-out fold; natural "
                "drop uses timing and curve endpoints only, with negative-lag controls"
            ),
        },
        "artifacts": {
            "findings": "/api/longquant/promise-lab/findings",
            "corpus": "/api/longquant/promise-lab/corpus",
            "discovery": "/api/longquant/promise-lab/discovery",
            "atlas": "/api/longquant/promise-lab/atlas",
            "allSpanAtlas": "/api/longquant/promise-lab/all-span-atlas",
            "manualProbe": "/api/longquant/promise-lab/manual-probe",
            "manualProjection": "/api/longquant/promise-lab/manual-projection",
            "clusterOutcomes": "/api/longquant/promise-lab/cluster-outcomes",
            "latencyStudy": "/api/longquant/promise-lab/latency-study",
            "crossScope": "/api/longquant/promise-lab/cross-scope",
            "swaps": "/api/longquant/promise-lab/swaps",
            "axes": "/api/longquant/promise-lab/axes",
            "registry": "/api/longquant/promise-lab/registry",
        },
    }
    (CACHE / "manifest.json").write_text(json.dumps(json_ready(manifest), separators=(",", ":"),
                                                    allow_nan=False),
                                          encoding="utf-8")

    r2 = R2Store()
    r2.put_json(f"{R2_PREFIX}/manifest.json", manifest)
    r2.put_json(f"{R2_PREFIX}/findings.json.gz", findings, gzip_payload=True)
    r2.put_json(f"{R2_PREFIX}/registry.json.gz", registry_artifact, gzip_payload=True)
    # Re-upload browser-facing artifacts with Content-Encoding: gzip so a
    # signed R2 redirect is transparently decoded by fetch().
    for local_name, remote_name in (
        ("corpus.json", "corpus.json.gz"),
        ("discovery-summary.json", "discovery-summary.json.gz"),
        ("atlas.json", "atlas.json.gz"),
        ("all-span-atlas.json", "all-span-atlas.json.gz"),
        ("manual-probe.json", "manual-probe.json.gz"),
        ("manual-projection.json", "manual-projection.json.gz"),
        ("cluster-outcomes.json", "cluster-outcomes.json.gz"),
        ("latency-study.json", "latency-study.json.gz"),
        ("cross-scope.json", "cross-scope.json.gz"),
        ("swaps.json", "swaps/summary.json.gz"),
        ("axes.json", "axes.json.gz"),
    ):
        value = load_json(local_name)
        if value is not None:
            r2.put_json(f"{R2_PREFIX}/{remote_name}", value, gzip_payload=True)
    print(json.dumps({"status": manifest["status"], "counts": manifest["counts"],
                      "findings": findings}, indent=2))


if __name__ == "__main__":
    main()
