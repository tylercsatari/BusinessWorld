#!/usr/bin/env python3
"""Verify exhaustive span coverage, exact offsets, vectors, and atlas inclusion."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from atlas import REPRESENTATION_VERSION, representation_matrix

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STORE = CACHE / "all-span-vectors"


def main() -> None:
    manifest = json.loads((CACHE / "all-span-manifest.json").read_text(encoding="utf-8"))
    state = json.loads((STORE / "state.json").read_text(encoding="utf-8"))
    candidate_atlas = json.loads((CACHE / "atlas.json").read_text(encoding="utf-8"))
    rows = manifest["rows"]
    hooks = manifest["hooks"]
    expected = sum(int(hook["tokenCount"]) * (int(hook["tokenCount"]) + 1) // 2
                   for hook in hooks)
    if len(rows) != expected or int(manifest["spanInstances"]) != expected:
        raise RuntimeError("all-span count is not the complete contiguous lattice")
    ids = [row["id"] for row in rows]
    if len(set(ids)) != len(ids):
        raise RuntimeError("all-span component IDs are not unique")
    all_ids = set(ids)
    candidate_ids = {row["id"] for row in candidate_atlas["candidates"]}
    if not candidate_ids.issubset(all_ids):
        raise RuntimeError("the evidence-supported atlas is not a subset of all spans")
    supported_ids = {row["id"] for row in rows if row.get("boundarySupported")}
    if supported_ids != candidate_ids:
        raise RuntimeError("boundary-supported flags do not exactly match the candidate atlas")

    hook_text = {int(row["hookIndex"]): row["text"] for row in hooks}
    bad_offsets = 0
    bad_spacing = 0
    for row in rows:
        source = hook_text[int(row["hookIndex"])]
        exact = source[int(row["charStart"]):int(row["charEnd"])].strip()
        bad_offsets += exact != row["text"]
        bad_spacing += "10, 000" in row["text"] or "50, 000" in row["text"]
    if bad_offsets or bad_spacing:
        raise RuntimeError(f"exact-text invariant failed: offsets={bad_offsets}, spacing={bad_spacing}")

    arrays = {
        name: np.load(STORE / f"{name}.npy", mmap_mode="r")
        for name in ("raw", "influence", "nonadditive", "context")
    }
    expected_shape = (expected, int(manifest["embeddingDimensions"]))
    if state.get("representationVersion") != REPRESENTATION_VERSION:
        raise RuntimeError("all-span representation formula version is stale")
    if manifest.get("representationVersion") != REPRESENTATION_VERSION:
        raise RuntimeError("all-span manifest does not identify the active representation formula")
    for name, values in arrays.items():
        if values.shape != expected_shape:
            raise RuntimeError(f"{name} has shape {values.shape}, expected {expected_shape}")
        for start in range(0, expected, 4096):
            if not np.isfinite(values[start:start + 4096]).all():
                raise RuntimeError(f"{name} contains non-finite values")
    full = np.asarray(np.load(STORE / "full.npy", mmap_mode="r"), np.float32)
    full_row_indices = np.asarray([
        int(hook["spanOffset"]) + int(hook["tokenCount"]) - 1 for hook in hooks
    ])
    raw_error = float(np.max(np.abs(np.asarray(arrays["raw"][full_row_indices], np.float32) - full)))
    influence_error = float(np.max(
        np.abs(np.asarray(arrays["influence"][full_row_indices], np.float32) - full)
    ))
    if raw_error > .002 or influence_error > .002:
        raise RuntimeError("full-span vectors do not reproduce the exact full-hook embedding")
    singleton_nonadditive_max = 0.0
    influence_formula_error = 0.0
    nonadditive_formula_error = 0.0
    for hook in hooks:
        begin = int(hook["spanOffset"])
        finish = begin + int(hook["spanCount"])
        selected_rows = rows[begin:finish]
        starts = np.asarray([row["start"] for row in selected_rows], int)
        ends = np.asarray([row["end"] for row in selected_rows], int)
        context = np.asarray(arrays["context"][begin:finish], np.float32)
        hook_full = np.asarray(full[int(hook["hookIndex"])], np.float32)
        lookup = {
            (int(start), int(end)): index
            for index, (start, end) in enumerate(zip(starts, ends))
        }
        token_effects = np.asarray([
            hook_full - context[lookup[(token, token + 1)]]
            for token in range(int(hook["tokenCount"]))
        ], np.float32)
        tensor = {
            "full": hook_full, "span_context": context,
            "span_start": starts, "span_end": ends,
            "token_effects": token_effects,
        }
        expected_influence = representation_matrix("influence", tensor).astype(
            np.float16
        ).astype(np.float32)
        expected_nonadditive = representation_matrix("nonadditive", tensor).astype(
            np.float16
        ).astype(np.float32)
        observed_influence = np.asarray(arrays["influence"][begin:finish], np.float32)
        observed_nonadditive = np.asarray(arrays["nonadditive"][begin:finish], np.float32)
        influence_formula_error = max(
            influence_formula_error,
            float(np.max(np.abs(observed_influence - expected_influence))),
        )
        nonadditive_formula_error = max(
            nonadditive_formula_error,
            float(np.max(np.abs(observed_nonadditive - expected_nonadditive))),
        )
        singleton_indices = np.flatnonzero(ends - starts == 1)
        singleton_nonadditive_max = max(
            singleton_nonadditive_max,
            float(np.max(np.linalg.norm(observed_nonadditive[singleton_indices], axis=1))),
        )
    if influence_formula_error != 0 or nonadditive_formula_error != 0:
        raise RuntimeError(
            "persisted derived vectors do not exactly reproduce from stored source vectors: "
            f"influence={influence_formula_error}, nonadditive={nonadditive_formula_error}"
        )
    if singleton_nonadditive_max != 0:
        raise RuntimeError(
            "singleton nonadditive vectors must be exactly zero; "
            f"maximum norm={singleton_nonadditive_max}"
        )
    norms = np.linalg.norm(np.asarray(arrays["raw"][::97], np.float32), axis=1)
    if float(np.max(np.abs(norms - 1))) > .003:
        raise RuntimeError("stored primitive vectors are not unit-normalized")

    print(json.dumps({
        "status": "verified",
        "hooks": len(hooks),
        "spanInstances": expected,
        "boundarySupportedInstances": len(supported_ids),
        "uniqueIds": len(set(ids)),
        "badOffsets": bad_offsets,
        "badCommaSpacing": bad_spacing,
        "fullSpanRawMaxError": raw_error,
        "fullSpanInfluenceMaxError": influence_error,
        "influenceFormulaMaximumAbsoluteError": influence_formula_error,
        "nonadditiveFormulaMaximumAbsoluteError": nonadditive_formula_error,
        "singletonNonadditiveMaximumNorm": singleton_nonadditive_max,
        "representationVersion": REPRESENTATION_VERSION,
        "sampleNormMaximumError": float(np.max(np.abs(norms - 1))),
    }, indent=2))


if __name__ == "__main__":
    main()
