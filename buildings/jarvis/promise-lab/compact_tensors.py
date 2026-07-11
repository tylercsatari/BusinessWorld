#!/usr/bin/env python3
"""Remove derivable arrays from v4 tensors without losing any measurement."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
TENSOR_DIR = HERE / ".cache" / "tensors"
KEEP = (
    "full", "token_effects", "pair_norms", "span_start", "span_end",
    "span_raw", "span_context", "span_nonadditive_norm",
)


def main() -> None:
    before = 0
    after = 0
    paths = sorted(TENSOR_DIR.glob("*.npz"))
    for index, path in enumerate(paths, 1):
        original_size = path.stat().st_size
        before += original_size
        with np.load(path, allow_pickle=False) as loaded:
            arrays = {name: loaded[name] for name in KEEP}
        temporary = path.with_suffix(".compact.npz")
        np.savez_compressed(temporary, **arrays)
        os.replace(temporary, path)
        compact_size = path.stat().st_size
        after += compact_size
        print(f"[{index}/{len(paths)}] {path.name}: {original_size / 1048576:.1f} -> "
              f"{compact_size / 1048576:.1f} MiB", flush=True)
    print(f"compacted {len(paths)} tensors: {before / 1048576:.1f} -> {after / 1048576:.1f} MiB")


if __name__ == "__main__":
    main()
