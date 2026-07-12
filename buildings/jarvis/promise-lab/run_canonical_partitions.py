#!/usr/bin/env python3
"""Build a frozen zero-overlap four-category partition for every source hook."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

from canonical_partition import (
    apply_category_transform,
    boundary_probabilities,
    category_log_probabilities,
    decode_compositional_four_chunks,
    decode_structural_four_chunks,
    decode_with_constraint_audit,
    fit_boundary_model,
    fit_category_model,
    row_unit,
    structural_features,
)
from embedding_store import R2_PREFIX, R2Store, json_ready
from sequence import tokenize


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STORE = CACHE / "all-span-vectors"
SUMMARY_PATH = CACHE / "canonical-partitions.json"
MODEL_PATH = CACHE / "canonical-partition-model.json"
METHOD_VERSION = "exact-cover-four-category-v1"


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
    features = np.empty((len(rows), 14), np.float32)
    groups = np.empty(len(rows), object)
    boundary_target = np.zeros(len(rows), np.int8)

    for hook in manifest["hooks"]:
        begin = int(hook["spanOffset"])
        end = begin + int(hook["spanCount"])
        selected_rows = rows[begin:end]
        starts = np.asarray([row["start"] for row in selected_rows], int)
        ends = np.asarray([row["end"] for row in selected_rows], int)
        features[begin:end] = structural_features(
            np.asarray(full_store[int(hook["hookIndex"])], np.float32),
            np.asarray(raw_store[begin:end], np.float32),
            np.asarray(context_store[begin:end], np.float32),
            np.asarray(influence_store[begin:end], np.float32),
            np.asarray(nonadditive_store[begin:end], np.float32),
            starts, ends, category_logp[begin:end],
        )
        groups[begin:end] = str(hook["videoId"])
        boundary_target[begin:end] = np.asarray(
            [bool(row.get("boundarySupported")) for row in selected_rows], np.int8
        )

    boundary_model, boundary_oof = fit_boundary_model(features, boundary_target, groups)
    boundary_probability = boundary_probabilities(features, boundary_model)
    decoded = []
    gaps = []
    penalties = []
    for hook in manifest["hooks"]:
        begin = int(hook["spanOffset"])
        end = begin + int(hook["spanCount"])
        selected_rows = rows[begin:end]
        starts = np.asarray([row["start"] for row in selected_rows], int)
        ends = np.asarray([row["end"] for row in selected_rows], int)
        tokens = tokenize(hook["text"])
        partition = decode_compositional_four_chunks(
            starts, ends,
            np.asarray(raw_store[begin:end], np.float32),
            np.asarray(influence_store[begin:end], np.float32),
            np.asarray(full_store[int(hook["hookIndex"])], np.float32),
            category_logp[begin:end],
            np.asarray([any(character.isalnum() or character == "_" for character in token.text)
                        for token in tokens], bool),
        )
        structural_partition = decode_structural_four_chunks(
            starts, ends, boundary_probability[begin:end], category_logp[begin:end]
        )
        quota_partition = decode_with_constraint_audit(
            starts, ends, boundary_probability[begin:end], category_logp[begin:end]
        )
        partition["uniqueCategoryQuotaAudit"] = {
            "score": quota_partition["score"],
            "unconstrainedCategoryScore": quota_partition["unconstrainedCategoryScore"],
            "uniqueCategoryConstraintPenalty": quota_partition["uniqueCategoryConstraintPenalty"],
            "categories": [chunk["category"] for chunk in quota_partition["chunks"]],
            "purpose": "falsification audit only; it is not allowed to choose canonical boundaries",
        }
        partition["structuralBoundaryAudit"] = {
            "score": structural_partition["score"],
            "chunks": [{key: chunk[key] for key in ("start", "end", "category")}
                       for chunk in structural_partition["chunks"]],
            "purpose": "comparison only; the compositional reconstruction chooses canonical boundaries",
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
                "boundaryProbability": float(boundary_probability[global_index]),
                "boundaryProbabilityOOF": float(boundary_oof[global_index]),
                "boundarySupported": bool(row.get("boundarySupported")),
            })
        if (token_owner < 0).any() or len(set(token_owner.tolist())) != 4:
            raise ValueError(f"{hook['videoId']} did not receive an exact four-part cover")
        partition.update({
            "videoId": hook["videoId"],
            "title": hook.get("title") or "",
            "text": hook["text"],
            "tokenCount": len(tokens),
            "tokens": [{"index": token.index, "text": token.text,
                        "start": token.start, "end": token.end,
                        "owner": int(token_owner[token.index])} for token in tokens],
            "chunks": chunks,
            "coverage": 1.0,
            "overlapCount": 0,
            "categoriesUsed": sorted(chunk["category"] for chunk in chunks),
        })
        gaps.append(float(partition["scoreGap"] or 0))
        penalties.append(float(quota_partition["uniqueCategoryConstraintPenalty"]))
        decoded.append(partition)

    gaps_array = np.asarray(gaps, float)
    penalties_array = np.asarray(penalties, float)
    for row in decoded:
        row["scoreGapPercentile"] = percentile(gaps_array, float(row["scoreGap"] or 0))
        row["constraintPenaltyPercentile"] = percentile(
            penalties_array, float(row["uniqueCategoryQuotaAudit"]["uniqueCategoryConstraintPenalty"])
        )

    model = {
        "version": 1,
        "status": "complete",
        "methodVersion": METHOD_VERSION,
        "mapId": winner["mapId"],
        "embeddingModel": manifest["embeddingModel"],
        "embeddingDimensions": manifest["embeddingDimensions"],
        "outcomesUsed": False,
        "manualPhrasesUsedToFitPartition": False,
        "constraints": {
            "chunkCount": 4,
            "categories": [0, 1, 2, 3],
            "eachCategoryExactlyOnce": False,
            "categoryQuotaMayChooseBoundaries": False,
            "punctuationOnlyChunkAllowed": False,
            "contiguous": True,
            "completeCoverage": True,
            "overlapAllowed": False,
        },
        "categoryTransform": transform,
        "categoryModel": category_model,
        "boundaryModel": boundary_model,
        "partitionCalibration": {
            "scoreGapsSorted": np.sort(gaps_array).astype(float).tolist(),
            "constraintPenaltiesSorted": np.sort(penalties_array).astype(float).tolist(),
        },
    }
    summary = {
        "version": 1,
        "status": "complete",
        "stage": "canonical zero-overlap four-category partition",
        "methodVersion": METHOD_VERSION,
        "mapId": winner["mapId"],
        "hooks": len(decoded),
        "chunks": 4 * len(decoded),
        "spanSearchUniverse": len(rows),
        "outcomesUsed": False,
        "validation": {
            "coverageFailures": 0,
            "overlaps": 0,
            "categoryLabelRangeFailures": 0,
            "boundaryHeldoutAuc": boundary_model["heldoutAuc"],
            "boundaryHeldoutAveragePrecision": boundary_model["heldoutAveragePrecision"],
            "medianRawReconstructionCosine": float(np.median([
                row["rawReconstructionCosine"] for row in decoded
            ])),
            "medianInfluenceReconstructionCosine": float(np.median([
                row["influenceReconstructionCosine"] for row in decoded
            ])),
            "medianTopTwoScoreGap": float(np.median(gaps_array)),
            "medianUniqueCategoryConstraintPenalty": float(np.median(penalties_array)),
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
