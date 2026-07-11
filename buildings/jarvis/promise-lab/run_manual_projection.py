#!/usr/bin/env python3
"""Build and publish fixed-label 2D views of the manual probe's winning map."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from embedding_store import R2_PREFIX, R2Store, json_ready
from projection_experiment import run_projection_experiment


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--random-planes", type=int, default=100_000)
    args = parser.parse_args()
    started = time.time()
    manual_probe = read_json(CACHE / "manual-probe.json")
    atlas = read_json(CACHE / "all-span-atlas.json")
    manifest = read_json(CACHE / "all-span-manifest.json")
    output = run_projection_experiment(
        atlas,
        manifest,
        CACHE / "all-span-vectors",
        str(manual_probe["winner"]["mapId"]),
        random_planes=args.random_planes,
    )
    output["builtAt"] = int(time.time() * 1000)
    output["elapsedSeconds"] = time.time() - started
    output_path = CACHE / "manual-projection.json"
    output_path.write_text(
        json.dumps(json_ready(output), separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )
    if not args.no_upload:
        R2Store().put_json(
            f"{R2_PREFIX}/manual-projection.json.gz", output, gzip_payload=True
        )
    print(json.dumps({
        "status": output["status"],
        "mapId": output["mapId"],
        "selectedMethod": output["selectedMethod"],
        "improvementOverPca": output["improvementOverPca"],
        "methods": [
            {"id": row["id"], **row["metrics"]} for row in output["methods"]
        ],
        "elapsedSeconds": output["elapsedSeconds"],
        "output": str(output_path),
    }, indent=2))


if __name__ == "__main__":
    main()
