#!/usr/bin/env python3
"""Build the frozen cross-source Market Hold reward and its audit artifact."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from axes import bh_fdr
from cluster_outcomes import retention_at
from embedding_store import (
    DIMENSIONS,
    MODEL,
    EmbeddingStore,
    R2_PREFIX,
    R2Store,
    json_ready,
)
from hook_score_core import local_counterfactual_texts, row_unit
from market_reward import (
    connected_source_groups,
    fit_external_axis,
    fit_monotone_calibration,
    fixed_transfer_validation,
    leave_one_out_nearest,
    local_market_effects,
    score_market_vector,
)
from sequence import tokenize


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
MODEL_OUTPUT = CACHE / "market-reward-model.json"
BROWSER_OUTPUT = CACHE / "market-reward.json"
METHOD_VERSION = "external-shorts-text-market-hold-v2-nested"
TARGET_META = {
    "viewed_percent": {
        "label": "Viewed percentage",
        "unit": "% viewed instead of swiped",
        "locality": "entry decision; visual and semantic content can both contribute",
    },
    "retention_5s": {
        "label": "Five-second retention",
        "unit": "% retained at five seconds",
        "locality": "local first-five-second outcome",
    },
    "average_retention": {
        "label": "Average retention",
        "unit": "% average percentage viewed",
        "locality": "whole-video outcome; positive transfer is supporting, not local causal evidence",
    },
    "log_views": {
        "label": "Observed Shorts views",
        "unit": "log10 observed views",
        "locality": "distribution outcome with many non-hook causes",
    },
}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def source_signature(*arrays) -> str:
    digest = hashlib.sha256()
    for value in arrays:
        if isinstance(value, np.ndarray):
            digest.update(np.ascontiguousarray(value).tobytes())
        else:
            digest.update(json.dumps(value, sort_keys=True).encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def load_external_source(r2: R2Store) -> dict:
    embedding_payload = r2.get_bytes("raw/text/embeddings.npz")
    map_payload = r2.get_bytes("raw/text/map.json")
    database_payload = r2.get_bytes("library/db.json")
    if not embedding_payload or not map_payload or not database_payload:
        raise RuntimeError("Raw Shorts text corpus is unavailable")
    embeddings = np.load(io.BytesIO(embedding_payload), allow_pickle=True)
    ids = [str(value) for value in embeddings["ids"]]
    vectors = row_unit(np.asarray(embeddings["vecs"], np.float32))
    position = {video_id: index for index, video_id in enumerate(ids)}
    mapping = json.loads(map_payload)
    database = json.loads(database_payload).get("videos") or {}
    database_by_id = {
        str(row.get("videoId") or key): row for key, row in database.items()
    }
    mine = mapping.get("mine") or [False] * len(mapping.get("id") or [])
    mine_ids = {
        str(video_id) for video_id, owned in zip(mapping.get("id") or [], mine)
        if bool(owned)
    }
    selected = []
    for map_index, video_id in enumerate(mapping.get("id") or []):
        video_id = str(video_id)
        vector_index = position.get(video_id)
        views = float((mapping.get("views") or [])[map_index] or 0)
        if vector_index is None or bool(mine[map_index]) or not np.isfinite(views) or views <= 0:
            continue
        row = database_by_id.get(video_id) or {}
        selected.append({
            "id": video_id,
            "vectorIndex": vector_index,
            "views": views,
            "transcript": str((mapping.get("txt") or [""] * len(mine))[map_index] or ""),
            "channel": str(row.get("channelId") or row.get("channel") or video_id),
        })
    source_vectors = vectors[[row["vectorIndex"] for row in selected]]
    target = np.log10(np.asarray([row["views"] for row in selected], np.float32) + 1)
    groups = connected_source_groups(
        [row["channel"] for row in selected],
        [row["transcript"] for row in selected],
    )
    return {
        "vectors": source_vectors,
        "target": target,
        "groups": groups,
        "rows": selected,
        "rawRows": len(ids),
        "ownedRowsExcluded": int(sum(bool(value) for value in mine)),
        "ownedIds": mine_ids,
        "sourceSignature": source_signature(
            [row["id"] for row in selected], target, groups,
        ),
    }


def owned_targets(corpus: list[dict]) -> dict[str, np.ndarray]:
    return {
        "viewed_percent": np.asarray([
            float(row.get("keep_rate") or np.nan) for row in corpus
        ], np.float32),
        "retention_5s": np.asarray([
            retention_at(
                row.get("curve") or [], float(row.get("duration_s") or np.nan), 5.0,
            ) * 100 for row in corpus
        ], np.float32),
        "average_retention": np.asarray([
            float(row.get("avg_retention") or np.nan) for row in corpus
        ], np.float32),
        "log_views": np.log10(np.asarray([
            max(1.0, float(row.get("views") or np.nan)) for row in corpus
        ], np.float32)),
    }


def counterfactual_vectors(partitions: list[dict], dimensions: int) -> dict:
    texts_by_video = {}
    required = []
    for partition in partitions:
        owners = np.asarray([int(token["owner"]) for token in partition["tokens"]], int)
        texts = local_counterfactual_texts(
            partition["text"], tokenize(partition["text"]), owners,
            int(partition["componentCount"]),
        )
        texts_by_video[str(partition["videoId"])] = texts
        required.extend(value for value in texts["withoutPair"].values() if value)
    store = EmbeddingStore(CACHE / "hook-quality-embeddings.sqlite3")
    try:
        embedded = store.embed_many(required)
    finally:
        store.close()
    zero = np.zeros(dimensions, np.float32)
    return {
        "texts": texts_by_video,
        "vectors": {text: row_unit(vector) for text, vector in embedded.items()},
        "zero": zero,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()
    started = time.time()
    r2 = R2Store()
    source = load_external_source(r2)
    axis = fit_external_axis(source["vectors"], source["target"], source["groups"])
    coefficient = np.round(np.asarray(axis["coefficient"], np.float32), 8)
    intercept = float(axis["intercept"])
    external_prediction = source["vectors"] @ coefficient + intercept
    ladder = np.sort(external_prediction)
    prediction_mean = float(np.mean(external_prediction))
    prediction_std = float(np.std(external_prediction))

    corpus = read_json(CACHE / "corpus.json")["rows"]
    partitions = read_json(CACHE / "canonical-partitions.json")["rows"]
    if [str(row["id"]) for row in corpus] != [str(row["videoId"]) for row in partitions]:
        raise RuntimeError("Market reward corpus and canonical partitions differ")
    promise_ids = {str(row["id"]) for row in corpus}
    external_ids = {str(row["id"]) for row in source["rows"]}
    leaked_ids = sorted(promise_ids & external_ids)
    missing_owned_flags = sorted(promise_ids - source["ownedIds"])
    if leaked_ids or missing_owned_flags:
        raise RuntimeError(
            "External reward leakage audit failed: "
            f"{len(leaked_ids)} Promise IDs entered fitting and "
            f"{len(missing_owned_flags)} Promise IDs lack the raw-corpus owned flag"
        )
    full = row_unit(np.asarray(
        np.load(CACHE / "all-span-vectors" / "full.npy", mmap_mode="r"),
        np.float32,
    ))
    context_store = np.load(
        CACHE / "all-span-vectors" / "context.npy", mmap_mode="r",
    )
    score_coordinate = (
        full @ coefficient + intercept
    )
    score_z = (
        score_coordinate - prediction_mean
    ) / max(prediction_std, 1e-9)
    chronology = np.asarray([str(row.get("published") or "") for row in corpus])
    targets = owned_targets(corpus)
    transfers = {}
    calibrations = {}
    transfer_pvalues = []
    for index, (target_name, target) in enumerate(targets.items()):
        transfers[target_name] = fixed_transfer_validation(
            score_z, target, chronology, 20260712 + index * 101,
        )
        transfer_pvalues.append(transfers[target_name]["rankPermutationP"])
        calibrations[target_name] = fit_monotone_calibration(
            score_z, target, chronology, 20261712 + index * 101,
        )
    for target_name, q in zip(targets, bh_fdr(transfer_pvalues)):
        row = transfers[target_name]
        row["familyQ"] = float(q)
        row["status"] = (
            "cross-source-transfer-supported"
            if row["heldoutSpearman"] > 0 and q <= .05
            else "not-supported"
        )
        row["target"] = TARGET_META[target_name]

    domain_nearest = leave_one_out_nearest(full)
    domain_floor = float(np.min(domain_nearest))
    domain_caution = float(np.quantile(domain_nearest, .1))
    score_std = max(prediction_std, 1e-9)
    counter = counterfactual_vectors(partitions, full.shape[1])
    component_calibration = defaultdict(list)
    pair_calibration = defaultdict(list)
    local_inputs = []
    for source_index, partition in enumerate(partitions):
        chunks = partition["chunks"]
        categories = [int(chunk["category"]) for chunk in chunks]
        without_one = {
            index: row_unit(np.asarray(
                context_store[int(chunk["globalSpanIndex"])], np.float32,
            )) for index, chunk in enumerate(chunks)
        }
        texts = counter["texts"][str(partition["videoId"])]
        without_pair = {
            key: (
                counter["vectors"][text] if text else counter["zero"]
            ) for key, text in texts["withoutPair"].items()
        }
        full_coordinate = score_coordinate[source_index]
        one_coordinate = {
            index: float(vector @ coefficient + intercept)
            for index, vector in without_one.items()
        }
        pair_coordinate = {
            key: float(vector @ coefficient + intercept)
            for key, vector in without_pair.items()
        }
        for index, category in enumerate(categories):
            component_calibration[str(category)].append(
                float((full_coordinate - one_coordinate[index]) / score_std)
            )
        for left in range(len(categories)):
            for right in range(left + 1, len(categories)):
                value = (
                    full_coordinate - one_coordinate[left] - one_coordinate[right]
                    + pair_coordinate[(left, right)]
                ) / score_std
                pair_calibration[f"{categories[left]}->{categories[right]}"].append(
                    float(value)
                )
        local_inputs.append((categories, without_one, without_pair))

    ret5 = transfers["retention_5s"]
    external_validation = axis["selectedValidation"]
    status = (
        "validated-cross-source-local-retention-proxy"
        if external_validation["heldoutSpearman"] > 0
        and external_validation["heldoutSpearmanP"] <= .05
        and ret5["status"] == "cross-source-transfer-supported"
        and ret5["recentHalfSpearman"] > 0
        and ret5["recentHalfSpearmanP"] <= .05
        else "not-ready-for-training"
    )
    model = {
        "version": 2,
        "status": status,
        "methodVersion": METHOD_VERSION,
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "coefficient": coefficient,
        "intercept": intercept,
        "ladder": np.round(ladder, 8),
        "mapDirection": np.round(axis["mapDirection"], 8),
        "scoreScale": {
            "predictionMean": prediction_mean,
            "predictionStd": prediction_std,
            "zFormula": "(external predicted log10 views - external mean) / external SD",
            "percentileFormula": "rank on the frozen 5,353-video external transcript ladder",
        },
        "externalTraining": {
            "target": "log10 observed views",
            "input": (
                "extracted first-five-second transcript text only; language and "
                "transcription noise are retained"
            ),
            "rawTextRows": source["rawRows"],
            "nonOwnedTrainingRows": len(source["rows"]),
            "ownedRowsExcluded": source["ownedRowsExcluded"],
            "sourceGroups": int(len(set(source["groups"].tolist()))),
            "groupDefinition": "connected components sharing channel or canonical transcript",
            "selectedAlpha": axis["selectedAlpha"],
            "selectionPolicy": (
                "fixed alpha grid; quoted evidence is nested channel-and-copy-grouped OOF, "
                "and the final alpha is selected only from external grouped folds"
            ),
            "selection": axis["selection"],
            "fullDataSelectionValidation": axis["fullDataSelectionValidation"],
            "selectedValidation": axis["selectedValidation"],
            "sourceSignature": source["sourceSignature"],
            "ownedOutcomeLabelsUsedToFitOrSelectAxis": False,
        },
        "transferValidation": transfers,
        "calibrations": {
            target: {
                key: value for key, value in calibration.items()
                if key != "predictionOOF"
            } for target, calibration in calibrations.items()
        },
        "domainGate": {
            "reference": "208 measured Promise Lab complete-hook text embeddings",
            "nearestCosineMinimum": domain_floor,
            "nearestCosineP10": domain_caution,
            "derivation": (
                "hard gate is the exact observed leave-one-out minimum; the 10th "
                "percentile is a visible caution level, never a hidden penalty"
            ),
            "policy": (
                "candidates below every measured training hook's support receive no reward; "
                "candidates below p10 retain reward with an explicit low-support warning"
            ),
            "penaltyWeight": None,
        },
        "domainReferenceEmbeddings": np.round(full, 8),
        "domainReferenceIds": [str(row["id"]) for row in corpus],
        "domainReferenceTexts": [str(row["hookText"]) for row in corpus],
        "domainReferenceNearestCosineSorted": np.sort(domain_nearest),
        "localCalibration": {
            "componentsByCategory": {
                key: sorted(values) for key, values in component_calibration.items()
            },
            "pairsByCategorySequence": {
                key: sorted(values) for key, values in pair_calibration.items()
            },
            "componentDefinition": (
                "MarketHold(full) - MarketHold(without exact component), in frozen score SD"
            ),
            "relationshipDefinition": (
                "full - without left - without right + without both, in frozen score SD"
            ),
        },
        "rewardContract": {
            "name": "Market Hold",
            "primaryInput": "complete hook text only",
            "primaryScore": "percentile on one frozen external transcript-to-views direction",
            "trainingReward": (
                "primary percentile / 100 only when the model validation status and "
                "empirical domain gate both pass"
            ),
            "thresholdUses": "complete-hook text embedding only",
            "visualInputUsed": False,
            "titleInputUsed": False,
            "categoriesUsed": False,
            "retentionCurveUsedAtInference": False,
            "topicalRelevance": (
                "a separate seed-to-candidate cosine constraint; never silently blended into potential"
            ),
            "claimBoundary": (
                "validated cross-source retention proxy, not a causal promise-quality truth; "
                "randomized same-topic hook variants remain the final promotion test"
            ),
        },
    }

    hook_rows = []
    for source_index, (partition, corpus_row, local) in enumerate(
        zip(partitions, corpus, local_inputs)
    ):
        categories, without_one, without_pair = local
        score = score_market_vector(
            full[source_index], model, include_diagnostics=False,
        )
        effects = local_market_effects(
            full[source_index], without_one, without_pair, categories, model,
        )
        hook_rows.append({
            "videoId": str(corpus_row["id"]),
            "title": str(corpus_row.get("title") or ""),
            "text": str(corpus_row.get("hookText") or ""),
            "published": str(corpus_row.get("published") or ""),
            "score": score,
            "outcomes": {
                target: {
                    "actual": float(values[source_index]),
                    "calibratedPredictionOOF": float(
                        calibrations[target]["predictionOOF"][source_index]
                    ),
                } for target, values in targets.items()
            },
            **effects,
        })
    audit = {
        "externalRows": len(source["rows"]),
        "externalGroups": int(len(set(source["groups"].tolist()))),
        "ownedHooks": len(corpus),
        "ownedHooksExcludedFromExternalTraining": len(promise_ids),
        "promiseIdsPresentInExternalTraining": len(leaked_ids),
        "promiseIdsMissingOwnedFlag": len(missing_owned_flags),
        "components": int(sum(len(row["components"]) for row in hook_rows)),
        "relationships": int(sum(len(row["relationships"]) for row in hook_rows)),
        "elapsedSeconds": round(time.time() - started, 3),
    }
    model["audit"] = audit
    browser = {
        "version": model["version"],
        "status": model["status"],
        "methodVersion": model["methodVersion"],
        "embeddingModel": model["embeddingModel"],
        "embeddingDimensions": model["embeddingDimensions"],
        "scoreScale": model["scoreScale"],
        "externalTraining": model["externalTraining"],
        "transferValidation": model["transferValidation"],
        "calibrations": model["calibrations"],
        "domainGate": model["domainGate"],
        "rewardContract": model["rewardContract"],
        "audit": audit,
        "hooks": hook_rows,
    }
    atomic_json(MODEL_OUTPUT, model)
    atomic_json(BROWSER_OUTPUT, browser)
    if not args.no_upload:
        r2.put_json(f"{R2_PREFIX}/market-reward-model.json.gz", model, gzip_payload=True)
        r2.put_json(f"{R2_PREFIX}/market-reward.json.gz", browser, gzip_payload=True)
    print(json.dumps(json_ready({
        "status": status,
        "external": model["externalTraining"],
        "transfer": transfers,
        "domainGate": model["domainGate"],
        "audit": audit,
    }), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
