#!/usr/bin/env python3
"""Verify a local full-hook tensor against Long Quant's stored vector preview."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from embedding_store import DIMENSIONS, MODEL, EmbeddingStore, R2Store


HERE = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_id", nargs="?", default="0ApFSNYQJ_w")
    args = parser.parse_args()

    record = R2Store().get_json(f"longform/hook-embeds/{args.video_id}.json", {})
    manifest = ((record.get("score") or {}).get("input_manifest") or {})
    stored = np.asarray(((record.get("score") or {}).get("emb_preview") or {}).get("text") or [],
                        float)
    tensor_path = HERE / ".cache" / "tensors" / f"{args.video_id}.npz"
    if tensor_path.exists():
        with np.load(tensor_path, allow_pickle=False) as loaded:
            full = np.asarray(loaded["full"], np.float32)
        local_source = "saved intervention tensor"
    else:
        cache_path = HERE / ".cache" / "embedding-parity.sqlite3"
        store = EmbeddingStore(cache_path)
        try:
            vector = store.embed_many([record.get("hookText") or ""])[record["hookText"]]
            full = vector / (np.linalg.norm(vector) + 1e-9)
            store.clear_and_compact()
        finally:
            store.close()
        for suffix in ("", "-wal", "-shm"):
            Path(str(cache_path) + suffix).unlink(missing_ok=True)
        local_source = "fresh exact-text embedding"
    local = np.round(full.reshape(48, DIMENSIONS // 48).mean(axis=1), 3)
    delta = float(np.max(np.abs(local - stored))) if len(stored) == len(local) else float("inf")
    result = {
        "videoId": args.video_id,
        "exactText": manifest.get("score_text") == record.get("hookText"),
        "model": manifest.get("embedding_model"),
        "dimensions": manifest.get("embedding_dimensions"),
        "localModel": MODEL,
        "localDimensions": DIMENSIONS,
        "localSource": local_source,
        "previewCoordinates": len(stored),
        "maximumAbsoluteDelta": delta,
        "parity": (
            manifest.get("embedding_model") == MODEL
            and int(manifest.get("embedding_dimensions") or 0) == DIMENSIONS
            and manifest.get("score_text") == record.get("hookText")
            and delta <= 0.0005
        ),
    }
    print(json.dumps(result, indent=2))
    if not result["parity"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
