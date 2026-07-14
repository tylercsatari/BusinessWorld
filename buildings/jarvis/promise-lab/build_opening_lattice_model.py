#!/usr/bin/env python3
"""Build the outcome-blind Shorts opening lattice support model."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np

from component_lattice import RESOLUTION_DEFINITIONS, prefix_transition_distances
from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, R2Store, json_ready


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STORE = CACHE / "all-span-vectors"
OUTPUT = CACHE / "opening-lattice-model.json"
METHOD_VERSION = "shorts-opening-lattice-support-v1"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def object_hash(value: dict) -> str:
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    manifest = read_json(CACHE / "all-span-manifest.json")
    store_state = read_json(STORE / "state.json")
    partition_model = read_json(CACHE / "canonical-partition-model.json")
    manifest_rows = manifest["rows"]
    raw = np.load(STORE / "raw.npy", mmap_mode="r")

    transition_null: list[float] = []
    for spec in manifest["hooks"]:
        begin = int(spec["spanOffset"])
        end = begin + int(spec["spanCount"])
        rows = manifest_rows[begin:end]
        transition_null.extend(prefix_transition_distances(
            np.asarray(raw[begin:end], np.float32),
            np.asarray([row["start"] for row in rows], int),
            np.asarray([row["end"] for row in rows], int),
            int(spec["tokenCount"]),
        ).astype(float).tolist())
    ordered = np.sort(np.asarray(transition_null, np.float32))
    artifact = {
        "version": 1,
        "status": "complete",
        "methodVersion": METHOD_VERSION,
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "prefixTransitionNullSorted": ordered.astype(float).tolist(),
        "prefixTransitionNullRows": int(len(ordered)),
        "prefixTransitionNullHash": hashlib.sha256(ordered.tobytes()).hexdigest(),
        "prefixTransitionNullOutcomesUsed": False,
        "allSpanStoreVersion": store_state.get("version"),
        "allSpanRepresentationVersion": store_state.get("representationVersion"),
        "allSpanCorpusFingerprint": store_state.get("corpusFingerprint"),
        "partitionModelHash": object_hash(partition_model),
        "resolutionDefinitions": RESOLUTION_DEFINITIONS,
        "longFormReferenceUsed": False,
        "titleManifoldUsed": False,
        "outcomesUsed": False,
        "parityContract": {
            "builder": "component_lattice.build_component_lattice",
            "savedAnalyzer": "run_opening_horizon.py",
            "typedAnalyzer": "score_hook.py",
            "shared": True,
            "representationVersion": store_state.get("representationVersion"),
            "trainingVectorStorageDtype": "float16",
            "predictorQuantizesBeforeDerivedRepresentations": True,
        },
    }
    atomic_json(OUTPUT, artifact)
    if not args.no_upload:
        R2Store().put_json(
            f"{R2_PREFIX}/opening-lattice-model.json.gz", artifact,
            gzip_payload=True,
        )
    print(json.dumps({
        "status": "complete",
        "prefixTransitionRows": int(len(ordered)),
        "longFormReferenceUsed": False,
        "outcomesUsed": False,
    }, indent=2))


if __name__ == "__main__":
    main()
