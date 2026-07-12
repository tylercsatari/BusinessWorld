#!/usr/bin/env python3
"""Build a frozen variable-count exact cover and four-category labels."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

from canonical_partition import (
    BOUNDARY_FEATURE_NAMES,
    apply_category_transform,
    boundary_features,
    boundary_probabilities,
    category_log_probabilities,
    decision_neutral_boundary_probability,
    fit_boundary_model,
    fit_category_model,
    row_unit,
)
from embedding_store import R2_PREFIX, R2Store, json_ready
from hook_score_core import decode_variable_chunks
from sequence import tokenize


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STORE = CACHE / "all-span-vectors"
SUMMARY_PATH = CACHE / "canonical-partitions.json"
MODEL_PATH = CACHE / "canonical-partition-model.json"
METHOD_VERSION = "variable-exact-cover-four-category-v2"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(json_ready(value), separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


def percentile(values: np.ndarray, value: float) -> float:
    values = np.sort(np.asarray(values, float))
    return float(100 * np.searchsorted(values, value, side="right") / max(1, len(values)))


def reconstruction_audit(partition: dict, raw: np.ndarray,
                         influence: np.ndarray, full: np.ndarray) -> dict:
    indices = np.asarray([int(row["spanIndex"]) for row in partition["chunks"]], int)
    full = row_unit(np.asarray(full, np.float32))
    raw_sum = row_unit(np.asarray(raw, np.float32))[indices].sum(axis=0)
    influence_sum = row_unit(np.asarray(influence, np.float32))[indices].sum(axis=0)
    return {
        "rawReconstructionCosine": float(raw_sum @ full / (np.linalg.norm(raw_sum) + 1e-9)),
        "influenceReconstructionCosine": float(
            influence_sum @ full / (np.linalg.norm(influence_sum) + 1e-9)
        ),
        "purpose": "audit only; reconstruction cannot choose boundaries or component count",
    }


def reconstruct_frozen_transform(atlas: dict, manifest: dict, winner: dict) -> tuple[dict, np.ndarray, np.ndarray]:
    map_row = next(row for row in atlas["maps"] if row["id"] == winner["mapId"])
    if (map_row.get("representation"), map_row.get("geometry"), int(map_row.get("pcaDimensions") or 0)) != (
        "raw-hook-residual", "whitened", 4,
    ):
        raise ValueError("the canonical decoder requires the frozen raw-hook-residual whitened 4D map")
    raw_store = np.load(STORE / "raw.npy", mmap_mode="r")
    raw = np.asarray(raw_store, np.float32)
    raw /= np.linalg.norm(raw, axis=1, keepdims=True) + 1e-9
    for hook in manifest["hooks"]:
        begin = int(hook["spanOffset"])
        end = begin + int(hook["spanCount"])
        raw[begin:end] -= raw[begin:end].mean(axis=0, keepdims=True)
        raw[begin:end] /= np.linalg.norm(raw[begin:end], axis=1, keepdims=True) + 1e-9

    dimensions_computed = int(atlas["pca"]["raw-hook-residual"]["dimensionsComputed"])
    reducer = PCA(n_components=dimensions_computed, svd_solver="randomized", random_state=1729)
    scores = reducer.fit_transform(row_unit(raw)).astype(np.float32)
    stored = np.asarray(atlas["projections"]["raw-hook-residual"], np.float32)
    error = np.abs(np.round(scores[:, :2], 5) - stored)
    if float(error.max()) > 1.1e-5:
        raise ValueError(f"frozen raw-hook projection reproduction failed: {float(error.max())}")
    scale = scores[:, :4].std(axis=0)
    values = scores[:, :4] / np.maximum(scale, 1e-9)
    labels = np.asarray(map_row["labels"], np.int16)
    transform = {
        "sourceRepresentation": "unit(raw span) minus its source-hook span mean, then unit normalize",
        "pcaRandomState": 1729,
        "pcaDimensionsComputed": dimensions_computed,
        "pcaDimensionsUsed": 4,
        "pcaMean": reducer.mean_.astype(float).tolist(),
        "pcaComponents": reducer.components_[:4].astype(float).tolist(),
        "whiteningScale": scale.astype(float).tolist(),
        "storedProjectionMaximumAbsoluteError": float(error.max()),
    }
    return transform, values.astype(np.float32), labels


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    manifest = read_json(CACHE / "all-span-manifest.json")
    discovery = read_json(CACHE / "discovery-summary.json")
    atlas = read_json(CACHE / "all-span-atlas.json")
    probe = read_json(CACHE / "manual-probe.json")
    winner = probe["winner"]
    transform, category_values, frozen_labels = reconstruct_frozen_transform(
        atlas, manifest, winner,
    )
    category_model = fit_category_model(category_values, frozen_labels, 4)
    category_logp = category_log_probabilities(category_values, category_model)

    raw_store = np.load(STORE / "raw.npy", mmap_mode="r")
    context_store = np.load(STORE / "context.npy", mmap_mode="r")
    influence_store = np.load(STORE / "influence.npy", mmap_mode="r")
    nonadditive_store = np.load(STORE / "nonadditive.npy", mmap_mode="r")
    full_store = np.load(STORE / "full.npy", mmap_mode="r")
    rows = manifest["rows"]
    discovery_by_video = {str(row["videoId"]): row for row in discovery["rows"]}
    feature_blocks = []
    target_blocks = []
    group_blocks = []
    boundary_slices = {}
    boundary_cursor = 0

    for hook in manifest["hooks"]:
        begin = int(hook["spanOffset"])
        end = begin + int(hook["spanCount"])
        selected_rows = rows[begin:end]
        starts = np.asarray([row["start"] for row in selected_rows], int)
        ends = np.asarray([row["end"] for row in selected_rows], int)
        block = boundary_features(
            np.asarray(full_store[int(hook["hookIndex"])], np.float32),
            np.asarray(raw_store[begin:end], np.float32),
            np.asarray(context_store[begin:end], np.float32),
            np.asarray(influence_store[begin:end], np.float32),
            np.asarray(nonadditive_store[begin:end], np.float32),
            starts, ends, category_logp[begin:end],
        )
        evidence_rows = sorted(
            (discovery_by_video[str(hook["videoId"])].get("boundaries") or []),
            key=lambda row: int(row["index"]),
        )
        if len(evidence_rows) != len(block):
            raise ValueError(f"{hook['videoId']} boundary evidence does not match token gaps")
        target = np.asarray([
            len(row.get("methodAboveNull") or {}) == 3
            and all(float(value) > 0 for value in (row.get("methodAboveNull") or {}).values())
            for row in evidence_rows
        ], np.int8)
        feature_blocks.append(block)
        target_blocks.append(target)
        group_blocks.append(np.full(len(block), str(hook["videoId"]), object))
        boundary_slices[str(hook["videoId"])] = slice(
            boundary_cursor, boundary_cursor + len(block)
        )
        boundary_cursor += len(block)

    features = np.vstack(feature_blocks)
    boundary_target = np.concatenate(target_blocks)
    groups = np.concatenate(group_blocks)
    boundary_model, boundary_oof_posterior = fit_boundary_model(
        features, boundary_target, groups, feature_names=BOUNDARY_FEATURE_NAMES,
    )
    serving_boundary_posterior = boundary_probabilities(features, boundary_model)
    serving_boundary_probability = decision_neutral_boundary_probability(
        serving_boundary_posterior, boundary_model["heldoutDecisionThreshold"],
    )
    boundary_posterior = boundary_oof_posterior
    boundary_probability = decision_neutral_boundary_probability(
        boundary_oof_posterior, boundary_model["heldoutDecisionThreshold"],
    )
    decoded = []
    gaps = []
    component_counts = []
    oof_count_matches = []
    oof_boundary_jaccards = []
    for hook in manifest["hooks"]:
        begin = int(hook["spanOffset"])
        end = begin + int(hook["spanCount"])
        selected_rows = rows[begin:end]
        starts = np.asarray([row["start"] for row in selected_rows], int)
        ends = np.asarray([row["end"] for row in selected_rows], int)
        tokens = tokenize(hook["text"])
        lexical = np.asarray([
            any(character.isalnum() or character == "_" for character in token.text)
            for token in tokens
        ], bool)
        boundary_slice = boundary_slices[str(hook["videoId"])]
        partition = decode_variable_chunks(
            starts, ends, boundary_probability[boundary_slice], category_logp[begin:end], lexical,
        )
        serving_partition = decode_variable_chunks(
            starts, ends, serving_boundary_probability[boundary_slice],
            category_logp[begin:end], lexical,
        )
        partition["reconstructionAudit"] = reconstruction_audit(
            partition,
            np.asarray(raw_store[begin:end], np.float32),
            np.asarray(influence_store[begin:end], np.float32),
            np.asarray(full_store[int(hook["hookIndex"])], np.float32),
        )
        full_boundaries = {int(row["end"]) for row in partition["chunks"][:-1]}
        serving_boundaries = {int(row["end"]) for row in serving_partition["chunks"][:-1]}
        union = full_boundaries | serving_boundaries
        boundary_jaccard = float(
            len(full_boundaries & serving_boundaries) / len(union)
        ) if union else 1.0
        partition["boundaryEvidenceMode"] = "source-held-out fold prediction"
        partition["servingEnsembleAudit"] = {
            "componentCount": int(serving_partition["componentCount"]),
            "boundaries": sorted(serving_boundaries),
            "countMatches": bool(
                serving_partition["componentCount"] == partition["componentCount"]
            ),
            "boundaryJaccard": boundary_jaccard,
            "purpose": "new-text fold-ensemble stability audit; it cannot choose stored covers",
        }
        token_owner = np.full(len(tokens), -1, int)
        chunks = []
        for chunk_index, chunk in enumerate(partition["chunks"]):
            local = int(chunk["spanIndex"])
            global_index = begin + local
            row = selected_rows[local]
            start = int(chunk["start"])
            finish = int(chunk["end"])
            token_owner[start:finish] = chunk_index
            probability = np.exp(category_logp[global_index])
            chunks.append({
                "index": chunk_index,
                "globalSpanIndex": global_index,
                "spanId": row["id"],
                "start": start,
                "end": finish,
                "text": row["text"],
                "category": int(chunk["category"]),
                "categoryProbability": float(probability[int(chunk["category"])]),
                "categoryDistribution": probability.astype(float).tolist(),
                "leftBoundaryProbability": chunk["leftBoundaryProbability"],
                "rightBoundaryProbability": chunk["rightBoundaryProbability"],
                "leftBoundaryProbabilityOOF": (
                    float(boundary_probability[boundary_slice][start - 1])
                    if start > 0 else None
                ),
                "leftBoundaryPosterior": (
                    float(boundary_posterior[boundary_slice][start - 1])
                    if start > 0 else None
                ),
                "rightBoundaryPosterior": (
                    float(boundary_posterior[boundary_slice][finish - 1])
                    if finish < len(tokens) else None
                ),
                "rightBoundaryProbabilityOOF": (
                    float(boundary_probability[boundary_slice][finish - 1])
                    if finish < len(tokens) else None
                ),
                "leftServingBoundaryProbability": (
                    float(serving_boundary_probability[boundary_slice][start - 1])
                    if start > 0 else None
                ),
                "rightServingBoundaryProbability": (
                    float(serving_boundary_probability[boundary_slice][finish - 1])
                    if finish < len(tokens) else None
                ),
            })
        component_count = len(chunks)
        if ((token_owner < 0).any()
                or set(token_owner.tolist()) != set(range(component_count))):
            raise ValueError(f"{hook['videoId']} did not receive a variable exact cover")
        partition.update({
            "videoId": hook["videoId"],
            "title": hook.get("title") or "",
            "text": hook["text"],
            "tokenCount": len(tokens),
            "tokens": [{"index": token.index, "text": token.text,
                        "start": token.start, "end": token.end,
                        "owner": int(token_owner[token.index])} for token in tokens],
            "chunks": chunks,
            "componentCount": component_count,
            "coverage": 1.0,
            "overlapCount": 0,
            "categoriesUsed": sorted(set(chunk["category"] for chunk in chunks)),
        })
        gaps.append(float(partition["scoreGap"] or 0))
        component_counts.append(component_count)
        oof_count_matches.append(partition["servingEnsembleAudit"]["countMatches"])
        oof_boundary_jaccards.append(boundary_jaccard)
        decoded.append(partition)

    gaps_array = np.asarray(gaps, float)
    for row in decoded:
        row["scoreGapPercentile"] = percentile(gaps_array, float(row["scoreGap"] or 0))

    model = {
        "version": 2,
        "status": "complete",
        "methodVersion": METHOD_VERSION,
        "mapId": winner["mapId"],
        "embeddingModel": manifest["embeddingModel"],
        "embeddingDimensions": manifest["embeddingDimensions"],
        "outcomesUsed": False,
        "manualPhrasesUsedToFitPartition": False,
        "constraints": {
            "chunkCount": None,
            "componentCountSelection": (
                "maximum source-held-out learned cut/non-cut posterior across every lexical exact cover"
            ),
            "categories": [0, 1, 2, 3],
            "eachCategoryExactlyOnce": False,
            "categoryLabelsMayChooseBoundaries": False,
            "punctuationOnlyChunkAllowed": False,
            "contiguous": True,
            "completeCoverage": True,
            "overlapAllowed": False,
            "maximumComponentCount": None,
            "manualSplitPenalty": None,
        },
        "categoryTransform": transform,
        "categoryModel": category_model,
        "boundaryModel": boundary_model,
        "boundaryTarget": {
            "positive": (
                "the cut appears above its own permutation-null frequency in all three "
                "outcome-blind geometric segmentation families"
            ),
            "negative": "at least one geometric family does not exceed its null frequency",
            "decision": "maximum Bernoulli posterior over all compatible cut/non-cut decisions",
            "decisionCalibration": (
                "recenter posterior log odds on the source-held-out threshold whose source-equal "
                "cut prevalence matches the unanimous above-null prevalence; Matthews correlation "
                "breaks exact ties, then every compatible cut/non-cut combination is decoded"
            ),
            "manualThreshold": None,
            "outcomesUsed": False,
        },
        "partitionCalibration": {
            "scoreGapsSorted": np.sort(gaps_array).astype(float).tolist(),
            "componentCountsSorted": np.sort(component_counts).astype(int).tolist(),
        },
    }
    summary = {
        "version": 2,
        "status": "complete",
        "stage": "variable-count zero-overlap exact cover with four frozen category labels",
        "methodVersion": METHOD_VERSION,
        "mapId": winner["mapId"],
        "hooks": len(decoded),
        "chunks": int(sum(component_counts)),
        "spanSearchUniverse": len(rows),
        "outcomesUsed": False,
        "validation": {
            "coverageFailures": 0,
            "overlaps": 0,
            "categoryLabelRangeFailures": 0,
            "boundaryHeldoutAuc": boundary_model["heldoutAuc"],
            "boundaryHeldoutAveragePrecision": boundary_model["heldoutAveragePrecision"],
            "boundaryModelRole": (
                "one probability per possible token cut; the exact-cover decoder uses cut and "
                "non-cut probabilities directly"
            ),
            "candidateTokenGaps": int(len(boundary_target)),
            "unanimousAboveNullGaps": int(boundary_target.sum()),
            "medianRawReconstructionCosine": float(np.median([
                row["reconstructionAudit"]["rawReconstructionCosine"] for row in decoded
            ])),
            "medianInfluenceReconstructionCosine": float(np.median([
                row["reconstructionAudit"]["influenceReconstructionCosine"] for row in decoded
            ])),
            "medianTopTwoScoreGap": float(np.median(gaps_array)),
            "minimumComponents": int(np.min(component_counts)),
            "medianComponents": float(np.median(component_counts)),
            "meanComponents": float(np.mean(component_counts)),
            "maximumComponents": int(np.max(component_counts)),
            "componentCountHistogram": {
                str(count): int(component_counts.count(count))
                for count in sorted(set(component_counts))
            },
            "servingEnsembleCountAgreement": float(np.mean(oof_count_matches)),
            "servingEnsembleMedianBoundaryJaccard": float(np.median(oof_boundary_jaccards)),
            "hooksUsingAllFourCategories": int(sum(
                row["categoriesUsed"] == [0, 1, 2, 3] for row in decoded
            )),
        },
        "rows": decoded,
    }
    atomic_json(MODEL_PATH, model)
    atomic_json(SUMMARY_PATH, summary)
    if not args.no_upload:
        remote = R2Store()
        remote.put_json(f"{R2_PREFIX}/canonical-partition-model.json.gz", model, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/canonical-partitions.json.gz", summary, gzip_payload=True)
    print(json.dumps(summary["validation"] | {
        "hooks": summary["hooks"], "chunks": summary["chunks"],
    }, indent=2))


if __name__ == "__main__":
    main()
