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
    MARKET_MODEL_FILE,
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
    outcome_model = load_artifact("hook-outcome-model.json")
    market_model = load_artifact(MARKET_MODEL_FILE)
    store = EmbeddingStore(_embedding_cache_path())
    try:
        first = [score_text(
            row["text"], model, partition, store, outcome_model, market_model,
        ) for row in EXAMPLES]
        second = [score_text(
            row["text"], model, partition, store, outcome_model, market_model,
        ) for row in EXAMPLES]
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
            main_delta = first[left]["score"]["prediction"] - first[right]["score"]["prediction"]
            comparisons.append({
                "left": EXAMPLES[left]["id"],
                "right": EXAMPLES[right]["id"],
                "survivalLiftDeltaLeftMinusRight": float(main_delta),
                "marketHoldRankPointDeltaLeftMinusRight": float(
                    first[left]["trainingReward"]["percentile"]
                    - first[right]["trainingReward"]["percentile"]
                ),
                "retainedInformationBootstrapLeftHigherFraction": float(np.mean(delta > 0)),
                "retainedInformationBootstrapRightHigherFraction": float(np.mean(delta < 0)),
                "retainedInformationBootstrapDeltaP10": float(np.quantile(delta, .1)),
                "retainedInformationBootstrapDeltaMedian": float(np.median(delta)),
                "retainedInformationBootstrapDeltaP90": float(np.quantile(delta, .9)),
                "bootstrapRepeats": len(bootstrap),
            })

    machine_positions = [index for index, row in enumerate(EXAMPLES)
                         if row["group"] == "machine-promise-variants"]
    machine_bootstrap = bootstrap_scores[:, machine_positions]
    winner_counts = np.bincount(
        np.argmax(machine_bootstrap, axis=1), minlength=len(machine_positions),
    )
    machine_hook_hold_rank = sorted(machine_positions, key=lambda index: (
        -first[index]["score"]["percentile"], EXAMPLES[index]["id"],
    ))
    machine_rank = sorted(machine_positions, key=lambda index: (
        -first[index]["trainingReward"]["percentile"], EXAMPLES[index]["id"],
    ))
    all_rank = sorted(range(len(EXAMPLES)), key=lambda index: (
        -first[index]["trainingReward"]["percentile"], EXAMPLES[index]["id"],
    ))
    example_rows = []
    for spec, result in zip(EXAMPLES, first):
        forward = result.get("forwardResponse") or {}
        forward_components = [
            {
                "index": component["index"],
                "text": component["text"],
                "category": component["category"],
                "percentile": (component.get("forwardResponse") or {}).get("percentile"),
                "axisCoordinate": (component.get("forwardResponse") or {}).get("axisCoordinate"),
                "heldoutSpearmanForCategory": (
                    (component.get("forwardResponse") or {}).get("heldoutSpearmanForCategory")
                ),
            } for component in result.get("components") or []
        ]
        example_rows.append({
            **spec,
            "score": result,
            "summary": {
                "marketHoldPercentile": result["trainingReward"]["percentile"],
                "marketHoldZ": result["trainingReward"]["z"],
                "marketHoldReward": result["trainingReward"]["reward"],
                "marketHoldEligibleForTraining": result["trainingReward"][
                    "eligibleForTraining"
                ],
                "marketHoldDomainNearestCosine": result["trainingReward"][
                    "domainNearestCosine"
                ],
                "holdZ": result["score"]["holdZ"],
                "percentile": result["score"]["percentile"],
                "axisCoordinate": result["score"]["prediction"],
                "predictedHoldLiftPercentagePoints": result["score"][
                    "predictedHoldLiftPercentagePoints"
                ],
                "predictedCarryPercentPerSecond": result["score"][
                    "predictedCarryPercentPerSecond"
                ],
                "responseEndSeconds": result["score"]["responseEndSeconds"],
                "retainedInformationPercentile": (
                    result["retainedInformation"]["score"]["percentile"]
                ),
                "bootstrapP10": result["retainedInformation"]["confidence"][
                    "bootstrapPercentileP10"
                ],
                "bootstrapMedian": result["retainedInformation"]["confidence"][
                    "bootstrapPercentileMedian"
                ],
                "bootstrapP90": result["retainedInformation"]["confidence"][
                    "bootstrapPercentileP90"
                ],
                "inDomainSimilarityPercentile": result["confidence"]["inDomainSimilarityPercentile"],
                "partitionGapPercentile": result["confidence"]["partitionScoreGapPercentile"],
                "forwardComponents": forward_components,
                "forwardRelationships": forward.get("relationships") or [],
                "forwardMetric": forward.get("metric"),
                "exploratoryWholeHookComposite": forward.get(
                    "exploratoryWholeHookComposite"
                ),
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
            "marketHold": {
                "externalNestedGroupedOOFSpearman": market_model["externalTraining"][
                    "selectedValidation"
                ]["heldoutSpearman"],
                "retention5sTransfer": market_model["transferValidation"][
                    "retention_5s"
                ],
                "status": market_model["status"],
            },
            "heldoutSpearman": outcome_model["survivalModel"]["validation"][
                "heldoutSpearman"
            ],
            "heldoutPearson": outcome_model["survivalModel"]["validation"][
                "heldoutPearson"
            ],
            "familyCorrectedRankPermutationP": outcome_model["survivalModel"][
                "validation"
            ]["rankInference"]["p"],
            "bootstrapRepeats": len(bootstrap),
            "forwardResponse": (
                (model.get("forwardResponse") or {}).get("component") or {}
            ).get("validation"),
        },
        "machineVariantResult": {
            "mainAxisRanking": [EXAMPLES[index]["id"] for index in machine_rank],
            "winner": EXAMPLES[machine_rank[0]]["id"],
            "hookHoldDiagnosticRanking": [
                EXAMPLES[index]["id"] for index in machine_hook_hold_rank
            ],
            "bootstrapWinnerFractions": {
                EXAMPLES[index]["id"]: float(winner_counts[local] / len(bootstrap))
                for local, index in enumerate(machine_positions)
            },
            "meaning": (
                "ranking is the frozen cross-source Market Hold percentile; Hook Hold and "
                "retained-information bootstrap orderings remain separate diagnostics"
            ),
        },
        "allExampleRanking": [EXAMPLES[index]["id"] for index in all_rank],
        "examples": example_rows,
        "pairwise": comparisons,
        "limits": {
            "causalClaim": False,
            "reason": (
                "Market Hold transfers to owned retention but these exact sentences do not have "
                "randomized same-topic audience outcomes; the ordering is a training proxy, not "
                "a causal winner claim"
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
