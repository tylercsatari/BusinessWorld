#!/usr/bin/env python3
"""Verify exhaustive span coverage, exact offsets, vectors, and atlas inclusion."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STORE = CACHE / "all-span-vectors"


def main() -> None:
    manifest = json.loads((CACHE / "all-span-manifest.json").read_text(encoding="utf-8"))
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
        "sampleNormMaximumError": float(np.max(np.abs(norms - 1))),
    }, indent=2))


if __name__ == "__main__":
    main()
