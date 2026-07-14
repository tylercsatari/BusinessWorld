#!/usr/bin/env python3
"""Assemble browser artifacts and a single provenance manifest."""

from __future__ import annotations

import argparse
import gzip
import json
import re
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


def semantic_horizon_contract(hook_outcomes):
    forecasts = [
        row.get("retentionForecast") or {}
        for row in hook_outcomes.get("hooks") or []
    ]
    endpoints = np.asarray([
        float(row["responseEndSeconds"])
        for row in forecasts if finite(row.get("responseEndSeconds"))
    ], float)
    spoken = np.asarray([
        float(row["spokenHookEndSeconds"])
        for row in forecasts if finite(row.get("spokenHookEndSeconds"))
    ], float)
    positions = sorted(set(len(row.get("timesSeconds") or []) for row in forecasts))
    words = sum(len(row.get("words") or []) for row in forecasts)
    return {
        "scope": "exact analyzed hook only",
        "sourceHooks": len(forecasts),
        "responseEndSecondsSorted": np.sort(endpoints).astype(float).tolist(),
        "minimumResponseEndSeconds": float(np.min(endpoints)) if len(endpoints) else None,
        "p10ResponseEndSeconds": float(np.quantile(endpoints, .1)) if len(endpoints) else None,
        "medianResponseEndSeconds": float(np.median(endpoints)) if len(endpoints) else None,
        "p90ResponseEndSeconds": float(np.quantile(endpoints, .9)) if len(endpoints) else None,
        "maximumResponseEndSeconds": float(np.max(endpoints)) if len(endpoints) else None,
        "minimumSpokenEndSeconds": float(np.min(spoken)) if len(spoken) else None,
        "maximumSpokenEndSeconds": float(np.max(spoken)) if len(spoken) else None,
        "outputPositionsPerHook": positions,
        "wordOutputs": words,
        "postHookOutputPoints": int((hook_outcomes.get("audit") or {}).get(
            "postHookOutputPoints", 0
        )),
        "claim": (
            "Every semantic forecast position, word, and component ends at that source's exact "
            "analyzed hook endpoint. Fixed-second outcomes after that endpoint are downstream "
            "labels only; they are never represented as analyzed transcript."
        ),
    }


def axis_target_window(target):
    target = str(target or "")
    if target.startswith("transfer_"):
        return {
            "kind": "counterfactual-no-video-time",
            "label": "Long Quant counterfactual across target hook contexts; no viewer-time window",
            "startSeconds": None, "endSeconds": None, "relativeToHookEnd": False,
        }
    match = re.fullmatch(r"measured_retention_(\d+)s", target)
    if match:
        second = float(match.group(1))
        return {
            "kind": "absolute-video-second-point",
            "label": f"observed retention at video second {second:g}",
            "startSeconds": second, "endSeconds": second, "relativeToHookEnd": False,
        }
    match = re.fullmatch(r"measured_retention_(mean|slope)_(\d+)_(\d+)s", target)
    if match:
        start, end = float(match.group(2)), float(match.group(3))
        measure = "mean retention" if match.group(1) == "mean" else "retention slope"
        return {
            "kind": "absolute-video-second-window",
            "label": f"observed {measure} from video second {start:g} to {end:g}",
            "startSeconds": start, "endSeconds": end, "relativeToHookEnd": False,
        }
    match = re.fullmatch(r"measured_hold_after_hook_(\d+)s", target)
    if match:
        end = float(match.group(1))
        return {
            "kind": "post-hook-relative-window",
            "label": f"observed change from exact hook end to {end:g} seconds after hook end",
            "startSeconds": 0.0, "endSeconds": end, "relativeToHookEnd": True,
        }
    match = re.fullmatch(r"measured_retention_(\d+)pct_duration", target)
    if match:
        percent = int(match.group(1))
        return {
            "kind": "video-duration-relative-point",
            "label": f"observed retention at {percent}% of each source video's duration",
            "startSeconds": None, "endSeconds": None, "relativeToHookEnd": False,
        }
    if target == "measured_retention_hook_end":
        return {
            "kind": "hook-end-point", "label": "observed retention at the exact hook endpoint",
            "startSeconds": None, "endSeconds": None, "relativeToHookEnd": False,
        }
    if target == "measured_drop_entry_to_hook_end":
        return {
            "kind": "within-hook-window", "label": "observed retention change from entry to exact hook end",
            "startSeconds": 0.0, "endSeconds": None, "relativeToHookEnd": False,
        }
    if target == "measured_early_slope_change_0_3_to_3_8s":
        return {
            "kind": "absolute-video-second-comparison",
            "label": "observed 3-8 second slope minus observed 0-3 second slope",
            "startSeconds": 0.0, "endSeconds": 8.0, "relativeToHookEnd": False,
        }
    labels = {
        "measured_keep_rate": "video-level viewed-versus-swiped outcome",
        "measured_avg_retention": "video-level average percentage viewed",
        "measured_log_views": "video-level log10 measured views",
        "measured_entry_rewatch": "observed entry retention above 100% at video start",
    }
    return {
        "kind": "video-level-or-declared-target",
        "label": labels.get(target, "declared target in the axis artifact"),
        "startSeconds": None, "endSeconds": None, "relativeToHookEnd": False,
    }


def axis_lineage_contract(experiment, semantic_horizon):
    window = axis_target_window(experiment.get("target"))
    endpoints = np.asarray(semantic_horizon.get("responseEndSecondsSorted") or [], float)
    outcome_end = window.get("endSeconds")
    if window.get("relativeToHookEnd"):
        beyond = len(endpoints)
    elif finite(outcome_end) and len(endpoints):
        beyond = int(np.sum(endpoints < float(outcome_end)))
    else:
        beyond = None
    representation = str(experiment.get("representation") or "")
    input_scope = {
        "raw": "exact contiguous component text",
        "influence": "exact component deletion-influence vector inside its source hook",
        "nonadditive": "exact component non-additive semantic vector inside its source hook",
        "context": "retained source-hook context after the exact component is removed",
    }.get(representation, representation or "declared semantic representation")
    return {
        "target": experiment.get("target"),
        "targetDefinition": experiment.get("targetDefinition"),
        "targetChannel": experiment.get("targetChannel"),
        "status": axis_claim_status(experiment),
        "semanticInput": input_scope,
        "semanticInputHorizon": "the exact analyzed source hook only",
        "outcomeWindow": window,
        "sourceHooksWhoseSemanticInputEndsBeforeOutcomeWindow": beyond,
        "sourceHooks": len(endpoints),
        "claim": (
            "The plane embeds hook-derived text only. The outcome window supplies a label for "
            "association testing; it does not imply transcript was analyzed through that time."
        ),
    }


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
            "medianFitExcludedHookMargin": median_field(rows, "heldoutHookMargin"),
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
                    "marginAboveNull", "heldoutHookMargin", "seedStabilityARI", "lengthNMI", "positionNMI",
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
        "multipleTestingFamily", "confoundPreprocessing", "status", "outcomesUsed",
    )
    return {key: row.get(key) for key in keep if key in row}


def axis_claim_status(row):
    """Translate legacy grouped-holdout support into its actual claim level."""
    status = row.get("status")
    if status == "multiplicity-controlled-random-fold-association":
        if row.get("targetChannel") == "observed YouTube outcome":
            return "source-grouped-observed-diagnostic"
        if row.get("targetChannel") == "Long Quant model-predicted counterfactual":
            return "source-grouped-model-transfer-supported"
        return "source-grouped-supported"
    if status != "validated":
        return status
    if row.get("targetChannel") == "observed YouTube outcome":
        return "source-grouped-observed-diagnostic"
    if row.get("targetChannel") == "Long Quant model-predicted counterfactual":
        return "source-grouped-model-transfer-supported"
    return "source-grouped-supported"


def compact_axis_registry_row(row):
    compact = compact_registry_row(row)
    compact["status"] = axis_claim_status(row)
    return compact


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()
    corpus = load_json("corpus.json", {"rows": []})
    interventions = load_json("intervention-summary.json", {})
    discovery = load_json("discovery-summary.json", {})
    atlas = load_json("atlas.json", {})
    all_span_atlas = load_json("all-span-atlas.json", {})
    component_lattice = load_json("component-lattice.json", {})
    opening_20s = load_json("opening-20s.json", {})
    research_contract = load_json("research-contract.json", {})
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
    canonical_partitions = load_json("canonical-partitions.json", {})
    hook_quality = load_json("hook-quality.json", {})
    forward_response = hook_quality.get("forwardResponse") or load_json("forward-response.json", {})
    hook_outcomes = load_json("hook-outcomes.json", {})
    market_reward = load_json("market-reward.json", {})
    hook_examples = load_json("hook-example-results.json", {})
    boundary_registry = load_jsonl_gz("boundary-experiments.jsonl.gz")
    cluster_registry = load_jsonl_gz("cluster-experiments.jsonl.gz")
    all_span_cluster_registry = load_jsonl_gz("all-span-cluster-experiments.jsonl.gz")
    cross_scope_registry = load_jsonl_gz("cross-scope-experiments.jsonl.gz")
    axis_registry = load_jsonl_gz("axis-experiments.jsonl.gz")
    cluster_outcome_registry = load_jsonl_gz("cluster-outcomes-experiments.jsonl.gz")
    active_ids = [str(row["id"]) for row in corpus.get("rows") or []]
    metadata_rows = [
        json.loads((CACHE / "metadata" / f"{video_id}.json").read_text(encoding="utf-8"))
        for video_id in active_ids
        if (CACHE / "metadata" / f"{video_id}.json").exists()
    ]
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
                + cross_scope_registry]
    registry.extend(compact_axis_registry_row(row) for row in axis_registry)
    registry.extend(compact_axis_registry_row(row) for row in cluster_outcome_registry)
    if hook_quality.get("status") == "complete":
        quality_model = hook_quality.get("model") or {}
        registry.append({
            "id": hook_quality.get("methodVersion"),
            "stage": "hook-quality-axis",
            "method": "nested held-out retained-information direction",
            "representation": "complete-hook Gemini text embedding",
            "pcaDimensions": quality_model.get("selectedDimensions"),
            "ridgeAlpha": quality_model.get("selectedAlpha"),
            "n": quality_model.get("trainingHooks"),
            "heldoutSpearman": quality_model.get("heldoutSpearman"),
            "heldoutPearson": quality_model.get("heldoutPearson"),
            "searchWideP": quality_model.get("rankPermutationP"),
            "status": quality_model.get("validationStatus", "not-validated"),
            "outcomesUsed": True,
        })
    if forward_response.get("status") == "complete":
        response_model = forward_response.get("componentModel") or {}
        response_inference = response_model.get("sourceInference") or {}
        registry.append({
            "id": forward_response.get("methodVersion"),
            "stage": "forward-component-response-axis",
            "method": "nested source-held-out forward-lag selection and category axes",
            "representation": "exact component plus deletion-influence embeddings",
            "pcaDimensions": 16,
            "ridgeAlpha": 10.0,
            "n": (forward_response.get("audit") or {}).get("components"),
            "heldoutSpearman": response_model.get("heldoutCategoryBalancedSpearman"),
            "searchWideP": response_inference.get("p"),
            "status": forward_response.get(
                "validationStatus", "conditional-diagnostic"
            ),
            "outcomesUsed": True,
        })
    if hook_outcomes.get("status") == "complete":
        survival = hook_outcomes.get("survivalModel") or {}
        survival_validation = survival.get("validation") or {}
        registry.append({
            "id": "hook-hold-entry-indexed",
            "stage": "whole-hook-survival-axis",
            "method": "nested future-free entry-indexed duration-adjusted direct text axis",
            "representation": "complete-hook Gemini text embedding",
            "pcaDimensions": 16,
            "ridgeAlpha": 10.0,
            "n": survival_validation.get("rows"),
            "target": "length_adjusted_hook_survival",
            "targetDefinition": (survival.get("targetContract") or {}).get("formula"),
            "heldoutSpearman": survival_validation.get("heldoutSpearman"),
            "heldoutPearson": survival_validation.get("heldoutPearson"),
            "searchWideP": (survival_validation.get("rankInference") or {}).get("p"),
            "status": survival_validation.get("status"),
            "outcomesUsed": True,
        })
        for target, target_meta in (hook_outcomes.get("targets") or {}).items():
            hook_model = (hook_outcomes.get("hookModels") or {}).get(target) or {}
            hook_validation = hook_model.get("validation") or {}
            registry.append({
                "id": f"hook-outcome-{target}",
                "stage": "whole-hook-outcome-axis",
                "method": "grouped out-of-fold direct text outcome axis",
                "representation": "complete-hook Gemini text embedding",
                "pcaDimensions": hook_model.get("pcaDimensions"),
                "ridgeAlpha": hook_model.get("ridgeAlpha"),
                "n": hook_validation.get("rows"),
                "target": target,
                "targetDefinition": target_meta.get("definition"),
                "heldoutSpearman": hook_validation.get("heldoutSpearman"),
                "heldoutPearson": hook_validation.get("heldoutPearson"),
                "searchWideP": (hook_validation.get("rankInference") or {}).get("p"),
                "searchWideQ": hook_validation.get("familyQ"),
                "status": hook_validation.get("status"),
                "outcomesUsed": True,
            })
            component_model = (hook_outcomes.get("componentModels") or {}).get(target) or {}
            component_validation = component_model.get("sourceAggregateValidation") or {}
            registry.append({
                "id": f"component-outcome-{target}",
                "stage": "component-outcome-axis",
                "method": "category-specific grouped out-of-fold component outcome axis",
                "representation": "exact component plus deletion-influence embedding",
                "pcaDimensions": component_model.get("pcaDimensions"),
                "ridgeAlpha": component_model.get("ridgeAlpha"),
                "n": component_validation.get("rows"),
                "target": target,
                "targetDefinition": target_meta.get("definition"),
                "heldoutSpearman": component_validation.get("heldoutSpearman"),
                "heldoutPearson": component_validation.get("heldoutPearson"),
                "searchWideP": (component_validation.get("rankInference") or {}).get("p"),
                "searchWideQ": component_validation.get("familyQ"),
                "status": component_validation.get("status"),
                "outcomesUsed": True,
            })
    if market_reward.get("status"):
        external = market_reward.get("externalTraining") or {}
        transfer = (market_reward.get("transferValidation") or {}).get(
            "retention_5s", {}
        )
        registry.append({
            "id": market_reward.get("methodVersion"),
            "stage": "hook-market-reward",
            "method": "nested external channel-and-copy-grouped frozen text direction",
            "representation": "complete-hook Gemini text embedding",
            "ridgeAlpha": external.get("selectedAlpha"),
            "n": external.get("nonOwnedTrainingRows"),
            "target": "external log10 views; untouched owned transfer to five-second retention",
            "targetDefinition": (
                "one external-only direction and ladder; owned outcomes calibrate units but "
                "cannot fit or select the reward"
            ),
            "heldoutSpearman": transfer.get("heldoutSpearman"),
            "searchWideQ": transfer.get("familyQ"),
            "status": market_reward.get("status"),
            "outcomesUsed": True,
        })

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
    supported_axes = [
        row for row in axis_registry
        if row.get("status") in {
            "validated", "multiplicity-controlled-random-fold-association",
        }
    ]
    selected_axes = [row for row in axis_registry if row.get("selectedForTarget")]
    validated_model_axes = [
        row for row in supported_axes
        if row.get("targetChannel") == "Long Quant model-predicted counterfactual"
    ]
    validated_observed_axes = [
        row for row in supported_axes
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
    semantic_horizon = semantic_horizon_contract(hook_outcomes)
    axis_lineage = {
        str((row.get("experiment") or {}).get("target") or ""): axis_lineage_contract(
            row.get("experiment") or {}, semantic_horizon,
        )
        for row in axes.get("maps") or []
        if (row.get("experiment") or {}).get("target")
    }
    hook_rows = hook_outcomes.get("hooks") or []
    partition_rows = canonical_partitions.get("rows") or []
    boundary_gaps = sum(max(0, int(row.get("tokenCount") or 0) - 1)
                        for row in partition_rows)
    outcome_axis_maps = len(axes.get("maps") or [])
    hook_components = int((hook_outcomes.get("audit") or {}).get("components") or 0)
    hook_relationships = int((hook_outcomes.get("audit") or {}).get("relationships") or 0)
    visualization_errors = []
    if int(semantic_horizon.get("postHookOutputPoints") or 0) != 0:
        visualization_errors.append("post-hook semantic outputs are present")
    if semantic_horizon.get("outputPositionsPerHook") != [41]:
        visualization_errors.append("retention forecasts do not all expose exactly 41 positions")
    if len(axis_lineage) != outcome_axis_maps:
        visualization_errors.append("one or more outcome-axis maps lack target lineage")
    if partition_rows and any(not row.get("boundaryTrace") for row in partition_rows):
        visualization_errors.append("one or more canonical partitions lack a full boundary trace")
    if partition_rows and any(
        len((row.get("boundaryTrace") or {}).get("gapCutProbabilitiesOOF") or [])
        != max(0, int(row.get("tokenCount") or 0) - 1)
        for row in partition_rows
    ):
        visualization_errors.append("one or more boundary traces omit candidate token gaps")
    if int(component_lattice.get("hookCount") or 0) != len(hook_rows):
        visualization_errors.append("component lattice does not cover every measured hook")
    if not (component_lattice.get("parityContract") or {}).get("shared"):
        visualization_errors.append("corpus and predictor do not share one component-lattice builder")
    if opening_20s and int(opening_20s.get("sourceVideos") or 0) != len(hook_rows):
        visualization_errors.append("20-second opening analysis does not cover every measured video")
    if opening_20s and int(
        opening_20s.get("sourceVideosWithObservedWordStartTimestamps") or 0
    ) != len(hook_rows):
        visualization_errors.append(
            "one or more 20-second openings lack observed transcript word-start timestamps"
        )
    if opening_20s and int(
        opening_20s.get("sourceVideosWithNonoverlappingResolvedIntervals") or 0
    ) != len(hook_rows):
        visualization_errors.append(
            "one or more 20-second openings have overlapping resolved transcript intervals"
        )
    if len(research_contract.get("rows") or []) != 66:
        visualization_errors.append("frozen research contract does not expose all 66 sections")
    visualization_contract = {
        "status": (
            "complete" if hook_rows and outcome_axis_maps and not visualization_errors
            else "incomplete"
        ),
        "errors": visualization_errors,
        "semanticInputHorizon": semantic_horizon,
        "axisTargetLineage": axis_lineage,
        "channels": [
            {
                "id": "partition-boundaries", "label": "Category-blind partition evidence",
                "outputs": boundary_gaps, "graphs": len(partition_rows),
                "visibleAs": "one probability trace plus exact token ownership per hook",
                "view": "Hook scorer / Hook library",
            },
            {
                "id": "complete-hook-planes", "label": "Complete-hook semantic scores",
                "outputs": 7, "graphs": 7,
                "visibleAs": "seven named embedding planes with numeric color scales",
                "view": "Hook scorer / Hook library",
            },
            {
                "id": "market-transfer", "label": "Market Hold transfer",
                "outputs": 4, "graphs": 4,
                "visibleAs": "Market Hold z against each untouched owned outcome",
                "view": "Hook scorer / Hook library",
            },
            {
                "id": "long-title-transfer", "label": "Long-title prior transfer",
                "outputs": 5, "graphs": 5,
                "visibleAs": "long-form title prediction against Hook Hold and four Shorts outcomes",
                "view": "Hook scorer / Hook library",
            },
            {
                "id": "retention-forecast", "label": "Within-hook retention forecast",
                "outputs": sum(len((row.get("retentionForecast") or {}).get("timesSeconds") or [])
                               for row in hook_rows),
                "graphs": len(hook_rows),
                "visibleAs": "seconds and normalized progress, component windows, every word, band, actual",
                "view": "Hook scorer / Hook library",
            },
            {
                "id": "word-semantics", "label": "Word singleton semantics and influence",
                "outputs": int(semantic_horizon.get("wordOutputs") or 0),
                "graphs": int(semantic_horizon.get("wordOutputs") or 0) * 2,
                "visibleAs": "singleton embedding and 41-position deletion trace for every selectable word",
                "view": "Hook scorer / Hook library",
            },
            {
                "id": "component-planes", "label": "Component diagnostics",
                "outputs": hook_components * 8, "graphs": hook_components * 8,
                "visibleAs": "eight named same-category planes for every emergent component",
                "view": "Hook scorer / Hook library",
            },
            {
                "id": "relationship-matrices", "label": "Pair relationships",
                "outputs": hook_relationships * 4, "graphs": len(hook_rows) * 4,
                "visibleAs": "four full component-by-component matrices with formulas",
                "view": "Hook scorer / Hook library",
            },
            {
                "id": "multi-resolution-lattice", "label": "Multi-resolution component lattice",
                "outputs": int(component_lattice.get("spanCount") or 0),
                "graphs": int(component_lattice.get("hookCount") or 0) * (
                    len(component_lattice.get("mapDefinitions") or {}) + 1
                ),
                "visibleAs": "every registered representation plane plus one source-position-by-span-width lattice per hook",
                "view": "Component lattice / Hook scorer / Hook library",
            },
            {
                "id": "attention-relational-graph", "label": "Attention-like relational graph",
                "outputs": int(component_lattice.get("edgeCount") or 0),
                "graphs": int(component_lattice.get("hookCount") or 0) * 6,
                "visibleAs": "containment, sequence, semantic, context, title, and fold-safe outcome edge families",
                "view": "Component lattice / Hook scorer / Hook library",
            },
            {
                "id": "opening-20s", "label": "Measured 20-second opening analysis",
                "outputs": int(opening_20s.get("componentCount") or 0),
                "graphs": (
                    int(opening_20s.get("sourceVideos") or 0)
                    * (len(component_lattice.get("mapDefinitions") or {}) + 3)
                    + int(bool((opening_20s.get("response") or {}).get("forwardCandidates")))
                ),
                "visibleAs": (
                    "source transcript with observed quantized start timestamps, visible collision "
                    "resolution, inferred ends, full multi-resolution lattice, four-category exact "
                    "cover, measured retention, normalization families, and forward-lag response"
                ),
                "view": "20s openings",
            },
            {
                "id": "research-contract", "label": "Frozen research-program implementation ledger",
                "outputs": len(research_contract.get("rows") or []),
                "graphs": 1,
                "visibleAs": "all document sections, source lines, evidence artifacts, status, and definition-of-done boundary",
                "view": "Research contract",
            },
            {
                "id": "legacy-outcome-axes", "label": "Required-confound outcome directions",
                "outputs": outcome_axis_maps, "graphs": outcome_axis_maps * 3,
                "visibleAs": "semantic plane, grouped-source prediction check, and horizon lineage per target",
                "view": "Outcome axes",
            },
        ],
        "assertions": {
            "postHookSemanticOutputs": int(semantic_horizon.get("postHookOutputPoints") or 0),
            "axisTargetsWithLineage": len(axis_lineage),
            "axisTargetsWithMaps": outcome_axis_maps,
            "boundaryHooksWithTraces": sum(bool(row.get("boundaryTrace")) for row in partition_rows),
            "boundaryHooks": len(partition_rows),
            "retentionPositionCounts": semantic_horizon.get("outputPositionsPerHook"),
            "componentLatticeHooks": int(component_lattice.get("hookCount") or 0),
            "componentLatticeSpans": int(component_lattice.get("spanCount") or 0),
            "componentGraphEdges": int(component_lattice.get("edgeCount") or 0),
            "opening20sVideos": int(opening_20s.get("sourceVideos") or 0),
            "opening20sComponents": int(opening_20s.get("componentCount") or 0),
            "opening20sSpans": int(opening_20s.get("spanCount") or 0),
            "researchContractSections": len(research_contract.get("rows") or []),
        },
    }
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
        "status": (
            "complete" if axes.get("status") == "complete"
            and hook_quality.get("status") == "complete"
            and forward_response.get("status") == "complete"
            and hook_outcomes.get("status") == "complete"
            and market_reward.get("status")
            and hook_examples.get("status") == "complete" else "building"
        ),
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
            "highestBrowsingHeuristicConfiguration": (
                compact_registry_row(best_cluster) if best_cluster else None
            ),
            "allContiguousSpanInstances": all_span_atlas.get("spanInstances", 0),
            "allContiguousExperiments": len(all_span_cluster_registry),
            "allContiguousMapsVisible": all_span_atlas.get(
                "mapCount", len(all_span_atlas.get("maps") or [])
            ),
            "highestAllContiguousBrowsingHeuristic": (
                compact_registry_row(best_all_span_cluster) if best_all_span_cluster else None
            ),
            "retentionPolicy": {
                "mapLimitPerScope": 300,
                "selection": (
                    "Pareto-first, then the stored outcome-blind qualityForBrowsing heuristic "
                    "with representation quotas; retained maps are a browsing subset, not an "
                    "exhaustive scientific winner set"
                ),
                "fitExcludedHookMargin": (
                    "centroid margin on hooks excluded from K-means fitting, conditional on a "
                    "PCA basis fitted to the complete corpus; descriptive and not independent "
                    "held-out validation"
                ),
                "qualityFormula": (
                    "positive margin-above-null x fit-excluded margin x seed ARI x entropy; "
                    "all-span maps additionally multiply cross-hook generality^0.5, "
                    "length independence, and position independence^0.5"
                ),
                "manualWinnerConditionalOnRetainedMaps": True,
                "manualWinnerPareto": bool(next((
                    row.get("pareto") for row in all_span_atlas.get("maps") or []
                    if row.get("id") == manual_projection.get("mapId")
                ), False)),
            },
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
            "validated": 0,
            "randomFoldSupported": len(supported_axes),
            "randomFoldSupportedIds": [row["id"] for row in supported_axes[:100]],
            "selectedByTarget": [compact_axis_registry_row(row) for row in selected_axes],
            "modelTransferTargets": len(selected_model_axes),
            "modelTransferValidated": len(validated_model_axes),
            "observedTargets": len(selected_observed_axes),
            "observedValidated": len(validated_observed_axes),
            "observedSourceSpanValidated": len(observed_span_axes),
            "supportedByChannel": dict(Counter(row.get("targetChannel") for row in supported_axes)),
            "supportedByRepresentation": dict(Counter(
                row.get("representation") for row in supported_axes
            )),
            "validatedModelTransfer": [compact_axis_registry_row(row) for row in validated_model_axes],
            "validatedObserved": [compact_axis_registry_row(row) for row in validated_observed_axes],
            "claimLevel": (
                "legacy source-grouped support: observed targets have no chronological "
                "replication and remain diagnostic"
            ),
            "targetLineage": axis_lineage,
            "interpretation": (
                "All model-predicted transfer targets have source-grouped support on raw source-span "
                "semantics. Five observed-outcome targets survive the legacy grouped-random null only "
                "on retained context; without chronological replication they remain diagnostics. No "
                "raw, influence, or non-additive source-span direction is supported against observed "
                "YouTube outcomes."
            ),
        },
        "visualizationContract": visualization_contract,
        "manualProbe": {
            "status": manual_probe.get("status"),
            "policy": manual_probe.get("policy"),
            "counts": manual_probe.get("counts"),
            "winner": manual_probe.get("winner"),
            "interpretation": (
                "A manual post-hoc overfit probe over frozen maps. It does not alter the map or "
                "partition boundaries, but its winning map supplies the conditional four-category "
                "labels used by downstream category-specific outcome axes."
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
            "randomFoldSupported": cluster_outcomes.get("randomFoldSupportedFamilyCount", 0),
            "claimBoundary": cluster_outcomes.get("claimBoundary"),
            "timingAudit": cluster_outcomes.get("timingAudit"),
            "topIndicators": cluster_outcomes.get("topIndicators", [])[:12],
            "interpretation": (
                "Outcome and phrase-slope axes are conditional on the post-hoc four-label map. "
                "Their random-fold correlations are held out by source video, but are not strict "
                "chronological replications."
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
        "hookQuality": {
            "status": hook_quality.get("status"),
            "methodVersion": hook_quality.get("methodVersion"),
            "model": hook_quality.get("model"),
            "components": len(hook_quality.get("components") or []),
            "latencySupported": ((hook_quality.get("latency") or {}).get("latencySupported")),
            "exampleWinner": ((hook_examples.get("machineVariantResult") or {}).get("winner")),
            "deterministicReplay": hook_examples.get("deterministicReplay"),
            "forwardResponse": {
                "validated": forward_response.get("validated"),
                "validationStatus": forward_response.get("validationStatus"),
                "categoryClaimStatus": forward_response.get("categoryClaimStatus"),
                "selectedLagSeconds": (
                    (forward_response.get("metricContract") or {}).get("selectedLagSeconds")
                ),
                "components": len(forward_response.get("components") or []),
                "relationships": len(forward_response.get("relationships") or []),
                "heldoutCategoryBalancedSpearman": (
                    (forward_response.get("componentModel") or {}).get(
                        "heldoutCategoryBalancedSpearman"
                    )
                ),
            },
            "interpretation": (
                "The complete-hook retained-information coordinate is reproducible in random folds "
                "but did not replicate in strict past-to-future validation. Variable-count "
                "full-context deletions attribute that diagnostic coordinate; they are not "
                "independently validated component outcomes."
            ),
        },
        "canonicalPartition": {
            "status": canonical_partitions.get("status"),
            "methodVersion": canonical_partitions.get("methodVersion"),
            "hooks": canonical_partitions.get("hooks", 0),
            "components": canonical_partitions.get("chunks", 0),
            "validation": canonical_partitions.get("validation") or {},
            "interpretation": (
                "Each source-held-out token gap supplies a category-blind cut probability and the "
                "decoder chooses the maximum-posterior non-overlapping cover. The four labels are "
                "a post-hoc manual-probe-conditioned overlay, not a required component count or an "
                "independently discovered semantic taxonomy."
            ),
        },
        "hookOutcomes": {
            "status": hook_outcomes.get("status"),
            "methodVersion": hook_outcomes.get("methodVersion"),
            "audit": hook_outcomes.get("audit"),
            "hookValidation": {
                target: (model.get("validation") or {})
                for target, model in (hook_outcomes.get("hookModels") or {}).items()
            },
            "componentValidation": {
                target: (model.get("sourceAggregateValidation") or {})
                for target, model in (hook_outcomes.get("componentModels") or {}).items()
            },
            "curveValidation": ((hook_outcomes.get("curveModel") or {}).get("validation")),
            "rewatchAdjustedCurveValidation": (
                (hook_outcomes.get("curveModel") or {}).get("rewatchAdjustedValidation")
            ),
            "survivalValidation": (
                (hook_outcomes.get("survivalModel") or {}).get("validation")
            ),
            "normalizationSensitivity": (
                (hook_outcomes.get("survivalModel") or {}).get(
                    "normalizationSensitivity"
                )
            ),
            "scoreScale": (
                (hook_outcomes.get("survivalModel") or {}).get("scoreScale")
            ),
            "longTitleTransfer": hook_outcomes.get("longTitleTransfer"),
            "rewatchAudit": hook_outcomes.get("rewatchAudit"),
            "speakingRate": ((hook_outcomes.get("curveModel") or {}).get("speakingRate")),
            "interpretation": (
                "Hook Hold is exposed as an unbounded z-coordinate with out-of-fold calibration and "
                "empirical error, while its percentile is secondary. It remains diagnostic because "
                "it fails strict past-to-future validation and disagrees with the retrospective "
                "terminal-conditioned sensitivity. The Long Quant title-market prior is visible but remains "
                "independent because it does not transfer to Shorts hold."
            ),
        },
        "marketReward": {
            "status": market_reward.get("status"),
            "methodVersion": market_reward.get("methodVersion"),
            "externalTraining": market_reward.get("externalTraining"),
            "transferValidation": market_reward.get("transferValidation"),
            "calibrations": market_reward.get("calibrations"),
            "domainGate": market_reward.get("domainGate"),
            "rewardContract": market_reward.get("rewardContract"),
            "audit": market_reward.get("audit"),
            "interpretation": (
                "Market Hold is the single frozen training proxy because its direction was "
                "selected on external hooks only and transfers to viewed percentage, five-second "
                "retention, and average retention on the untouched owned corpus. It does not "
                "predict owned raw views and is not a causal promise-quality claim."
                if market_reward.get("status") == "validated-cross-source-local-retention-proxy"
                else
                "Market Hold remains inspectable but the current artifact failed at least one "
                "declared external, transfer, recent-half, or domain gate and emits no reward."
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
        "source": (
            f"{len(corpus.get('rows') or [])} complete Shorts hooks already embedded in the "
            "Long Quant text space"
        ),
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
            "componentLatticeHooks": component_lattice.get("hookCount", 0),
            "componentLatticeSpans": component_lattice.get("spanCount", 0),
            "componentGraphEdges": component_lattice.get("edgeCount", 0),
            "opening20sVideos": opening_20s.get("sourceVideos", 0),
            "opening20sComponents": opening_20s.get("componentCount", 0),
            "opening20sSpans": opening_20s.get("spanCount", 0),
            "researchContractHeadings": len(research_contract.get("rows") or []),
            "crossScopeExperiments": len(cross_scope_registry),
            "swapRows": swaps.get("swapRows", 0),
            "axisExperiments": len(axis_registry),
            "clusterOutcomeExperiments": len(cluster_outcome_registry),
            "clusterOutcomeFamilies": cluster_outcomes.get("selectedFamilyCount", 0),
            "latencyStudyClusters": latency_study.get("clusterCount", 0),
            "latencyStudyLags": len(latency_study.get("lagsSeconds") or []),
            "latencyStudyWindows": len(latency_study.get("windows") or []),
            "canonicalPartitions": canonical_partitions.get("hooks", 0),
            "canonicalComponents": canonical_partitions.get("chunks", 0),
            "hookQualityTrainingHooks": ((hook_quality.get("model") or {}).get("trainingHooks", 0)),
            "hookQualityComponents": len(hook_quality.get("components") or []),
            "forwardResponseComponents": len(forward_response.get("components") or []),
            "forwardResponseRelationships": len(forward_response.get("relationships") or []),
            "hookQualityBootstrapDirections": (
                (hook_examples.get("modelValidation") or {}).get("bootstrapRepeats", 0)
            ),
            "hookEvaluationExamples": len(hook_examples.get("examples") or []),
            "hookOutcomeHooks": (hook_outcomes.get("audit") or {}).get("hooks", 0),
            "hookOutcomeComponents": (hook_outcomes.get("audit") or {}).get("components", 0),
            "hookOutcomeRelationships": (hook_outcomes.get("audit") or {}).get("relationships", 0),
            "hookOutcomeCurvePoints": (hook_outcomes.get("audit") or {}).get("curvePointsPerHook", 0),
            "marketRewardExternalHooks": (
                (market_reward.get("externalTraining") or {}).get("nonOwnedTrainingRows", 0)
            ),
            "marketRewardOwnedTransferHooks": (
                (market_reward.get("audit") or {}).get("ownedHooks", 0)
            ),
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
            "componentLatticeSeparated": (
                "the corpus and typed predictor call one deterministic builder; structural graph edges "
                "use no outcomes, stored outcome edges require a held-out fold, and live outcome edges "
                "are marked inference-only"
            ),
            "outcomesJoinAfterDiscovery": True,
            "measuredAndPredictedEvidenceSeparated": True,
            "manualProbeSeparated": (
                "manual interpretation is post-hoc and creates zero maps; it does choose the "
                "conditional four-label overlay used downstream, but cannot enter boundary features"
            ),
            "manualProjectionSeparated": (
                "fixed-label viewing experiment only; labels, maps, outcomes, and discovery are unchanged"
            ),
            "clusterOutcomesSeparated": (
                "outcomes join only after the k=4 labels are frozen; source-video holdout and "
                "search-wide nulls govern every cluster-target axis, but absent chronological "
                "replication keeps every result conditional and diagnostic"
            ),
            "latencyStudySeparated": (
                "one semantic score is shared across every lag within each held-out fold; natural "
                "drop uses timing and curve endpoints only, with negative-lag controls"
            ),
            "canonicalPartitionSeparated": (
                "variable exact-cover boundaries use eight category-blind source-held-out semantic "
                "contrast features with nested regularization and raw posterior decoding; outcomes, "
                "manual phrases, and category probabilities cannot choose a boundary"
            ),
            "hookQualitySeparated": (
                "the supplied comparison examples are evaluation-only; every reported training "
                "score is out of fold, strict chronological transfer is reported, and failed "
                "future transfer prevents promotion"
            ),
            "forwardResponseSeparated": (
                "entry-indexed retention is primary; terminal-conditioned targets are retrospective "
                "sensitivities; every fit is source-equal, only forward lags can be selected, "
                "reverse-time windows are controls, exact-cover boundaries stay frozen, and "
                "expanding-window validation reruns lag selection using past videos only"
            ),
            "opening20sSeparated": (
                "the same outcome-blind variable exact cover, frozen four-category vocabulary, "
                "multi-resolution lattice, and structural graph are applied to source transcript "
                "words through 20 seconds; source timestamps are observed but quantized, equal-start "
                "collisions are resolved within the next distinct interval, and absent ends are "
                "inferred; entry-indexed retention is primary, terminal-conditioned "
                "normalizations are retrospective, and lag selection is nested by source video"
            ),
            "hookOutcomesSeparated": (
                "whole-hook and category-specific component outcome axes use frozen boundaries, "
                "source-grouped out-of-fold validation, explicit uncertainty, and separate statuses"
            ),
            "marketRewardSeparated": (
                "the reward direction, alpha, and percentile ladder use zero owned outcome "
                "labels; owned outcomes are an untouched transfer test and transparent unit calibration"
            ),
        },
        "artifacts": {
            "findings": "/api/longquant/promise-lab/findings",
            "corpus": "/api/longquant/promise-lab/corpus",
            "discovery": "/api/longquant/promise-lab/discovery",
            "atlas": "/api/longquant/promise-lab/atlas",
            "allSpanAtlas": "/api/longquant/promise-lab/all-span-atlas",
            "componentLattice": "/api/longquant/promise-lab/component-lattice",
            "opening20s": "/api/longquant/promise-lab/opening-20s",
            "researchContract": "/api/longquant/promise-lab/research-contract",
            "manualProbe": "/api/longquant/promise-lab/manual-probe",
            "manualProjection": "/api/longquant/promise-lab/manual-projection",
            "clusterOutcomes": "/api/longquant/promise-lab/cluster-outcomes",
            "latencyStudy": "/api/longquant/promise-lab/latency-study",
            "canonicalPartitions": "/api/longquant/promise-lab/canonical-partitions",
            "hookQuality": "/api/longquant/promise-lab/hook-quality",
            "forwardResponse": "/api/longquant/promise-lab/forward-response",
            "hookExamples": "/api/longquant/promise-lab/hook-example-results",
            "hookOutcomes": "/api/longquant/promise-lab/hook-outcomes",
            "marketReward": "/api/longquant/promise-lab/market-reward",
            "hookScore": "/api/longquant/promise-lab/hook-score",
            "crossScope": "/api/longquant/promise-lab/cross-scope",
            "swaps": "/api/longquant/promise-lab/swaps",
            "axes": "/api/longquant/promise-lab/axes",
            "registry": "/api/longquant/promise-lab/registry",
        },
    }
    (CACHE / "manifest.json").write_text(json.dumps(json_ready(manifest), separators=(",", ":"),
                                                    allow_nan=False),
                                          encoding="utf-8")

    final_progress = {
        "version": 4,
        "status": "complete",
        "stage": "methodology audit complete; all Promise Lab artifacts published",
        "hooksComplete": manifest["counts"]["hooks"],
        "canonicalComponents": manifest["counts"]["canonicalComponents"],
        "experimentsComplete": (
            manifest["counts"]["boundaryExperiments"]
            + manifest["counts"]["clusterExperiments"]
            + manifest["counts"]["axisExperiments"]
            + manifest["counts"]["clusterOutcomeExperiments"]
        ),
        "updatedAt": int(time.time() * 1000),
    }
    (CACHE / "progress.json").write_text(
        json.dumps(final_progress, separators=(",", ":")), encoding="utf-8"
    )

    if args.no_upload:
        print(json.dumps({"status": manifest["status"], "counts": manifest["counts"],
                          "findings": findings}, indent=2))
        return

    r2 = R2Store()
    r2.put_json(f"{R2_PREFIX}/manifest.json", manifest)
    r2.put_json(f"{R2_PREFIX}/progress.json", final_progress)
    r2.put_json(f"{R2_PREFIX}/findings.json.gz", findings, gzip_payload=True)
    r2.put_json(f"{R2_PREFIX}/registry.json.gz", registry_artifact, gzip_payload=True)
    # Re-upload browser-facing artifacts with Content-Encoding: gzip so a
    # signed R2 redirect is transparently decoded by fetch().
    for local_name, remote_name in (
        ("corpus.json", "corpus.json.gz"),
        ("discovery-summary.json", "discovery-summary.json.gz"),
        ("atlas.json", "atlas.json.gz"),
        ("all-span-atlas.json", "all-span-atlas.json.gz"),
        ("component-lattice.json", "component-lattice.json.gz"),
        ("opening-20s.json", "opening-20s.json.gz"),
        ("research-contract.json", "research-contract.json.gz"),
        ("manual-probe.json", "manual-probe.json.gz"),
        ("manual-projection.json", "manual-projection.json.gz"),
        ("cluster-outcomes.json", "cluster-outcomes.json.gz"),
        ("latency-study.json", "latency-study.json.gz"),
        ("canonical-partitions.json", "canonical-partitions.json.gz"),
        ("hook-quality.json", "hook-quality.json.gz"),
        ("forward-response.json", "forward-response.json.gz"),
        ("hook-example-results.json", "hook-example-results.json.gz"),
        ("hook-outcomes.json", "hook-outcomes.json.gz"),
        ("market-reward.json", "market-reward.json.gz"),
        ("cross-scope.json", "cross-scope.json.gz"),
        ("swaps.json", "swaps/summary.json.gz"),
        ("axes.json", "axes.json.gz"),
    ):
        value = load_json(local_name)
        if value is not None:
            r2.put_json(f"{R2_PREFIX}/{remote_name}", value, gzip_payload=True)
    for local_name in (
        "canonical-partition-model.json", "hook-quality-model.json",
        "forward-response-model.json", "hook-outcome-model.json",
        "market-reward-model.json", "component-lattice-model.json",
        "opening-20s-model.json",
    ):
        value = load_json(local_name)
        if value is not None:
            r2.put_json(f"{R2_PREFIX}/{local_name}.gz", value, gzip_payload=True)
    print(json.dumps({"status": manifest["status"], "counts": manifest["counts"],
                      "findings": findings}, indent=2))


if __name__ == "__main__":
    main()
