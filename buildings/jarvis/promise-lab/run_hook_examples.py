#!/usr/bin/env python3
"""Freeze and verify the user's supplied holdout hook comparison."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np

from embedding_store import R2_PREFIX, EmbeddingStore, R2Store, json_ready
from hook_score_core import row_unit
from score_hook import (
    MODEL_FILE,
    PARTITION_FILE,
    _embedding_cache_path,
    load_artifact,
    score_text,
)


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
OUTPUT = CACHE / "hook-example-results.json"
EXAMPLES = (
    {
        "id": "unexpected-use",
        "group": "machine-promise-variants",
        "text": "This machine makes it impossible to spill, but what it's used for might be the last thing you would expect",
    },
    {
        "id": "mechanism-question",
        "group": "machine-promise-variants",
        "text": "This machine makes it impossible to spill, but how does it actually work?",
    },
    {
        "id": "second-feature",
        "group": "machine-promise-variants",
        "text": "This machine makes it impossible to spill, but does one more thing that will blow your mind",
    },
    {
        "id": "lego-dislocation",
        "group": "topic-switch",
        "text": "What happens if you are playing with legos, when all of a sudden you dislocate your shoulder...",
    },
)


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False), encoding="utf-8",
    )
    os.replace(temporary, path)


def stable_hash(value) -> str:
    raw = json.dumps(json_ready(value), separators=(",", ":"), sort_keys=True,
                     ensure_ascii=False, allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()
    model = load_artifact(MODEL_FILE)
    partition = load_artifact(PARTITION_FILE)
    store = EmbeddingStore(_embedding_cache_path())
    try:
        first = [score_text(row["text"], model, partition, store) for row in EXAMPLES]
        second = [score_text(row["text"], model, partition, store) for row in EXAMPLES]
        full_vectors = store.embed_many([row["text"] for row in EXAMPLES])
    finally:
        store.close()
    first_hash = stable_hash(first)
    second_hash = stable_hash(second)
    if first_hash != second_hash:
        raise RuntimeError("the holdout scorer changed across two identical runs")

    vectors = np.asarray([row_unit(full_vectors[row["text"]]) for row in EXAMPLES], np.float32)
    bootstrap = np.asarray(model["bootstrapDirections"], np.float32)
    bootstrap_scores = bootstrap @ vectors.T
    comparisons = []
    for left in range(len(EXAMPLES)):
        for right in range(left + 1, len(EXAMPLES)):
            delta = bootstrap_scores[:, left] - bootstrap_scores[:, right]
            main_delta = first[left]["score"]["axisCoordinate"] - first[right]["score"]["axisCoordinate"]
            comparisons.append({
                "left": EXAMPLES[left]["id"],
                "right": EXAMPLES[right]["id"],
                "mainAxisDeltaLeftMinusRight": float(main_delta),
                "bootstrapLeftHigherFraction": float(np.mean(delta > 0)),
                "bootstrapRightHigherFraction": float(np.mean(delta < 0)),
                "bootstrapDeltaP10": float(np.quantile(delta, .1)),
                "bootstrapDeltaMedian": float(np.median(delta)),
                "bootstrapDeltaP90": float(np.quantile(delta, .9)),
                "bootstrapRepeats": len(bootstrap),
            })

    machine_positions = [index for index, row in enumerate(EXAMPLES)
                         if row["group"] == "machine-promise-variants"]
    machine_bootstrap = bootstrap_scores[:, machine_positions]
    winner_counts = np.bincount(
        np.argmax(machine_bootstrap, axis=1), minlength=len(machine_positions),
    )
    machine_rank = sorted(machine_positions, key=lambda index: (
        -first[index]["score"]["percentile"], EXAMPLES[index]["id"],
    ))
    all_rank = sorted(range(len(EXAMPLES)), key=lambda index: (
        -first[index]["score"]["percentile"], EXAMPLES[index]["id"],
    ))
    example_rows = []
    for spec, result in zip(EXAMPLES, first):
        example_rows.append({
            **spec,
            "score": result,
            "summary": {
                "percentile": result["score"]["percentile"],
                "axisCoordinate": result["score"]["axisCoordinate"],
                "bootstrapP10": result["confidence"]["bootstrapPercentileP10"],
                "bootstrapMedian": result["confidence"]["bootstrapPercentileMedian"],
                "bootstrapP90": result["confidence"]["bootstrapPercentileP90"],
                "inDomainSimilarityPercentile": result["confidence"]["inDomainSimilarityPercentile"],
                "partitionGapPercentile": result["confidence"]["partitionScoreGapPercentile"],
            },
        })
    output = {
        "version": 1,
        "status": "complete",
        "evaluationOnly": True,
        "examplesUsedForTraining": False,
        "deterministicReplay": {
            "runs": 2,
            "identical": True,
            "sha256": first_hash,
        },
        "modelValidation": {
            "heldoutSpearman": model["validation"]["heldoutSpearman"],
            "heldoutPearson": model["validation"]["heldoutPearson"],
            "familyCorrectedSignFlipP": model["validation"]["signFlipP"],
            "bootstrapRepeats": len(bootstrap),
        },
        "machineVariantResult": {
            "mainAxisRanking": [EXAMPLES[index]["id"] for index in machine_rank],
            "winner": EXAMPLES[machine_rank[0]]["id"],
            "bootstrapWinnerFractions": {
                EXAMPLES[index]["id"]: float(winner_counts[local] / len(bootstrap))
                for local, index in enumerate(machine_positions)
            },
            "meaning": (
                "ranking is the frozen axis result; winner fractions are the share of 128 "
                "source-bootstrap refits in which each variant ranks first"
            ),
        },
        "allExampleRanking": [EXAMPLES[index]["id"] for index in all_rank],
        "examples": example_rows,
        "pairwise": comparisons,
        "limits": {
            "causalClaim": False,
            "reason": (
                "the axis has held-out observational validity, but these exact sentences do not "
                "have randomized audience outcomes"
            ),
            "confidencePolicy": (
                "report bootstrap ordering frequencies and domain similarity directly; no invented "
                "high-medium-low confidence threshold is applied"
            ),
        },
    }
    atomic_json(OUTPUT, output)
    if not args.no_upload:
        R2Store().put_json(f"{R2_PREFIX}/hook-example-results.json.gz", output, gzip_payload=True)
    print(json.dumps({
        "machineVariantResult": output["machineVariantResult"],
        "allExampleRanking": output["allExampleRanking"],
        "scores": {row["id"]: row["summary"] for row in example_rows},
        "deterministicReplay": output["deterministicReplay"],
    }, indent=2))


if __name__ == "__main__":
    main()
