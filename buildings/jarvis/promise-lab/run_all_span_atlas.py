#!/usr/bin/env python3
"""Sweep unlabeled geometries over every contiguous span at multiple resolutions."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import time
from pathlib import Path

import numpy as np
from scipy import sparse

from atlas import MatrixSource, row_unit, run_cluster_sweep, summarize_map_clusters
from embedding_store import R2_PREFIX, R2Store


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STORE_DIR = CACHE / "all-span-vectors"
MANIFEST_PATH = CACHE / "all-span-manifest.json"
ATLAS_PATH = CACHE / "all-span-atlas.json"
EXPERIMENT_PATH = CACHE / "all-span-cluster-experiments.jsonl.gz"
DIMENSION_GRID = [2, 3, 4, 6, 8, 12, 16, 24, 32]
CLUSTER_GRID = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 48, 64]


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                         encoding="utf-8")
    os.replace(temporary, path)


def load_view(name: str) -> np.ndarray:
    return row_unit(np.load(STORE_DIR / f"{name}.npy", mmap_mode="r"))


def difference(left: str, right: str) -> np.ndarray:
    left_values = load_view(left)
    right_values = load_view(right)
    return row_unit(left_values - right_values)


def residualize(matrix: np.ndarray, *categorical: np.ndarray) -> np.ndarray:
    """Project out additive categorical fixed effects without outcome information."""
    matrix = np.asarray(matrix, np.float32)
    row_count = len(matrix)
    columns = []
    offsets = []
    offset = 0
    for values in categorical:
        _, codes = np.unique(np.asarray(values), return_inverse=True)
        columns.append(codes.astype(np.int32) + offset)
        offsets.append(int(codes.max()) + 1)
        offset += offsets[-1]
    row_indices = np.tile(np.arange(row_count, dtype=np.int32), len(columns))
    column_indices = np.concatenate(columns)
    design = sparse.csr_matrix(
        (np.ones(len(row_indices), np.float32), (row_indices, column_indices)),
        shape=(row_count, offset),
    )
    gram = (design.T @ design).toarray().astype(np.float32)
    gram_inverse = np.linalg.pinv(gram, rcond=1e-7).astype(np.float32)
    coefficients = gram_inverse @ np.asarray(design.T @ matrix, np.float32)
    fitted = np.asarray(design @ coefficients, np.float32)
    return row_unit(matrix - fitted)


def hook_relative(hook_indices: np.ndarray) -> np.ndarray:
    raw = load_view("raw")
    full = np.asarray(np.load(STORE_DIR / "full.npy", mmap_mode="r"), np.float32)
    return row_unit(raw - full[hook_indices])


def multiview() -> np.ndarray:
    return np.concatenate([
        load_view("raw"), load_view("influence"), load_view("nonadditive")
    ], axis=1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", type=int, default=5)
    parser.add_argument("--fit-sample", type=int, default=4096)
    parser.add_argument("--eval-sample", type=int, default=1536)
    parser.add_argument("--map-limit", type=int, default=300)
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    rows = manifest["rows"]
    row_count = len(rows)
    dimensions = int(manifest["embeddingDimensions"])
    groups = np.asarray([row["videoId"] for row in rows])
    hook_indices = np.asarray([row["hookIndex"] for row in rows], np.int16)
    lengths = np.asarray([row["tokenCount"] for row in rows], np.int16)
    hook_lengths = np.asarray([hook["tokenCount"] for hook in manifest["hooks"]], np.int16)
    midpoints = np.asarray([(row["start"] + row["end"]) / 2 for row in rows], np.float32)
    positions = np.minimum(
        9,
        np.floor(midpoints / hook_lengths[hook_indices] * 10).astype(np.int16),
    )

    base_shape = (row_count, dimensions)
    raw_loader = lambda: load_view("raw")
    influence_loader = lambda: load_view("influence")
    representations = {
        "raw": MatrixSource(base_shape, raw_loader),
        "influence": MatrixSource(base_shape, influence_loader),
        "nonadditive": MatrixSource(base_shape, lambda: load_view("nonadditive")),
        "context": MatrixSource(base_shape, lambda: load_view("context")),
        "contextualization": MatrixSource(base_shape, lambda: difference("raw", "influence")),
        "span-context-contrast": MatrixSource(base_shape, lambda: difference("raw", "context")),
        "hook-relative": MatrixSource(base_shape, lambda: hook_relative(hook_indices)),
        "raw-length-residual": MatrixSource(
            base_shape, lambda: residualize(load_view("raw"), lengths)
        ),
        "raw-hook-residual": MatrixSource(
            base_shape, lambda: residualize(load_view("raw"), hook_indices)
        ),
        "raw-hook-length-residual": MatrixSource(
            base_shape, lambda: residualize(load_view("raw"), hook_indices, lengths)
        ),
        "influence-hook-length-residual": MatrixSource(
            base_shape, lambda: residualize(load_view("influence"), hook_indices, lengths)
        ),
        "multiview": MatrixSource((row_count, dimensions * 3), multiview),
    }
    formulae = {
        "raw": "unit(E(span))",
        "influence": "unit(E(full hook) - E(full hook without span))",
        "nonadditive": "unit(span influence - sum(single-token influences))",
        "context": "unit(E(full hook without span))",
        "contextualization": "unit(raw span semantics - in-context influence)",
        "span-context-contrast": "unit(raw span semantics - remainder-of-hook semantics)",
        "hook-relative": "unit(raw span semantics - full-hook semantics)",
        "raw-length-residual": "raw after projection orthogonal to exact token-count fixed effects",
        "raw-hook-residual": "raw after projection orthogonal to source-hook fixed effects",
        "raw-hook-length-residual": "raw after joint source-hook and token-count fixed-effect removal",
        "influence-hook-length-residual": "influence after joint source-hook and token-count fixed-effect removal",
        "multiview": "concatenate(raw, influence, nonadditive); equal unit-norm blocks",
    }
    r2 = None if args.no_upload else R2Store()
    started = time.time()
    last_upload = 0

    def progress(value: dict) -> None:
        nonlocal last_upload
        complete = int(value.get("configurationsComplete") or 0)
        payload = {
            "version": 4,
            "status": "running",
            "stage": "all-span multi-resolution unlabeled atlas",
            "scope": "all-contiguous-spans",
            "spanInstances": row_count,
            "boundarySupportedInstances": manifest["boundarySupportedInstances"],
            "representations": len(representations),
            "semanticRules": 0,
            **value,
            "updatedAt": int(time.time() * 1000),
        }
        atomic_json(CACHE / "progress.json", payload)
        if r2 and (complete == int(value.get("configurationsTotal") or -1)
                   or complete - last_upload >= 100):
            r2.put_json(f"{R2_PREFIX}/progress.json", payload)
            last_upload = complete
        if complete and complete % 50 == 0:
            print(
                f"all-span atlas {complete}/{value.get('configurationsTotal')}; "
                f"experiments {value.get('experimentsComplete')}",
                flush=True,
            )

    sweep = run_cluster_sweep(
        representations,
        groups,
        max_dimension=max(DIMENSION_GRID),
        max_clusters=max(CLUSTER_GRID),
        seeds=args.seeds,
        fit_sample=args.fit_sample,
        eval_sample=args.eval_sample,
        map_limit=args.map_limit,
        progress=progress,
        dimensions=DIMENSION_GRID,
        cluster_counts=CLUSTER_GRID,
        nuisance={"length": lengths, "position": positions},
        experiment_namespace="all-contiguous-spans",
        stability_sample=4096,
    )
    for row in sweep.experiments:
        row["scope"] = "all-contiguous-spans"
        row["stage"] = "all-span-cluster"
    for row in sweep.maps:
        row["scope"] = "all-contiguous-spans"
        row["clusterSummaries"] = summarize_map_clusters(
            rows, row, sweep.projections.get(row["representation"]) or []
        )

    registry_raw = "\n".join(
        json.dumps(row, separators=(",", ":")) for row in sweep.experiments
    ).encode("utf-8")
    EXPERIMENT_PATH.write_bytes(gzip.compress(registry_raw, compresslevel=6))
    atlas = {
        "version": 4,
        "status": "complete",
        "stage": "all-span multi-resolution unlabeled atlas",
        "scope": "all-contiguous-spans",
        "hookCount": manifest["hookCount"],
        "spanInstances": row_count,
        "boundarySupportedInstances": manifest["boundarySupportedInstances"],
        "embeddingModel": manifest["embeddingModel"],
        "embeddingDimensions": manifest["embeddingDimensions"],
        "interventionVersion": manifest["interventionVersion"],
        "enumeration": manifest["enumeration"],
        "representations": list(representations),
        "representationFormulae": formulae,
        "geometries": ["euclidean", "spherical", "whitened"],
        "pcaDimensionsTested": DIMENSION_GRID,
        "clusterCountsTested": CLUSTER_GRID,
        "seedsPerConfiguration": args.seeds,
        "seedStabilityAuditInstances": min(4096, row_count),
        "experimentCount": len(sweep.experiments),
        "mapCount": len(sweep.maps),
        "mapSelection": "equal browse quota per representation, then global Pareto/quality fill",
        "outcomesUsed": False,
        "semanticRules": 0,
        "positionAndLengthUsedAsClusterFeatures": False,
        "nuisanceDiagnostics": ["token-count NMI", "relative-position NMI", "cross-hook generality"],
        "nuisanceResidualization": "categorical fixed-effect projection; no outcomes or semantic labels",
        "elapsedSeconds": round(time.time() - started, 2),
        "hooks": manifest["hooks"],
        "spans": rows,
        "pca": sweep.pca_meta,
        "projections": sweep.projections,
        "maps": sweep.maps,
    }
    atomic_json(ATLAS_PATH, atlas)
    complete = {
        "version": 4,
        "status": "running",
        "stage": "all-span atlas complete; cross-scope validation next",
        "scope": "all-contiguous-spans",
        "spanInstances": row_count,
        "boundarySupportedInstances": manifest["boundarySupportedInstances"],
        "experimentCount": len(sweep.experiments),
        "mapCount": len(sweep.maps),
        "semanticRules": 0,
        "updatedAt": int(time.time() * 1000),
    }
    atomic_json(CACHE / "progress.json", complete)
    if r2:
        r2.put_json(f"{R2_PREFIX}/all-span-atlas.json.gz", atlas, gzip_payload=True)
        r2.put_bytes(
            f"{R2_PREFIX}/all-span-cluster-experiments.jsonl.gz",
            EXPERIMENT_PATH.read_bytes(),
            "application/gzip",
        )
        r2.put_json(f"{R2_PREFIX}/progress.json", complete)
    print(json.dumps({
        "spanInstances": row_count,
        "representations": len(representations),
        "experimentCount": len(sweep.experiments),
        "mapCount": len(sweep.maps),
        "elapsedSeconds": atlas["elapsedSeconds"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
