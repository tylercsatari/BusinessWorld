#!/usr/bin/env python3
"""Fast one-embedding Market Hold scorer for training and batch generation."""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np

from embedding_store import EmbeddingStore, json_ready
from hook_score_core import row_unit
from score_hook import MARKET_MODEL_FILE, _embedding_cache_path, load_artifact
from market_reward import score_market_vector
from sequence import normalize_source


def score_hook(text: str, seed: str = "", minimum_relevance: float | None = None,
               model: dict | None = None, store: EmbeddingStore | None = None,
               include_diagnostics: bool = False) -> dict:
    text = normalize_source(text)
    seed = normalize_source(seed)
    if not text:
        raise ValueError("type a hook to score")
    model = model or load_artifact(MARKET_MODEL_FILE)
    owned_store = store is None
    store = store or EmbeddingStore(_embedding_cache_path())
    try:
        embedded = store.embed_many([text, seed] if seed else [text])
    finally:
        if owned_store:
            store.close()
    vector = row_unit(embedded[text])
    score = score_market_vector(
        vector, model, include_diagnostics=include_diagnostics,
    )
    relevance = None
    if seed:
        similarity = float(vector @ row_unit(embedded[seed]))
        passes = minimum_relevance is None or similarity >= float(minimum_relevance)
        relevance = {
            "seedText": seed,
            "cosine": similarity,
            "minimum": minimum_relevance,
            "passes": bool(passes),
            "policy": "separate topical constraint; never blended into Market Hold",
        }
        if not passes:
            score["reward"] = None
            score["eligibleForTraining"] = False
    return {
        "version": 1,
        "status": "complete",
        "input": {
            "hookText": text,
            "embeddingModel": model["embeddingModel"],
            "embeddingDimensions": model["embeddingDimensions"],
            "embeddingCalls": 1 + int(bool(seed)),
            "visualInputUsed": False,
            "titleInputUsed": False,
            "retentionCurveUsed": False,
            "generativeLlmUsed": False,
        },
        "trainingReward": score,
        "topicalRelevance": relevance,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--seed", default="")
    parser.add_argument("--minimum-relevance", type=float)
    parser.add_argument("--diagnostics", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    text = sys.stdin.read() if args.stdin else args.text
    try:
        result = score_hook(
            text, args.seed, args.minimum_relevance,
            include_diagnostics=args.diagnostics,
        )
        print(json.dumps(
            json_ready(result), indent=2 if args.pretty else None,
            separators=None if args.pretty else (",", ":"), allow_nan=False,
        ))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
