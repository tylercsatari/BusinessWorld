#!/usr/bin/env python3
"""Rebuild and optionally publish the RTG v2 visualization artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from build_study import Store
from rtg_visualizations import VISUALIZATIONS_KEY, build_visualization_artifact


HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / ".cache"
REPORT_PATH = CACHE_DIR / "research_v2.json"
REGISTRY_PATH = CACHE_DIR / "experiments_v2.jsonl.gz"
MATRICES_PATH = CACHE_DIR / "matrices_v2.npz"
PROGRESS_PATH = CACHE_DIR / "progress_v2.json"
VISUALIZATIONS_PATH = CACHE_DIR / "visualizations_v2.json.gz"

REPORT_KEY = "longform/gratification/v2/report.json"
PROGRESS_KEY = "longform/gratification/v2/progress.json"


def sha_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-publish", action="store_true")
    parser.add_argument("--no-umap", action="store_true")
    args = parser.parse_args()

    report = json.loads(REPORT_PATH.read_text())
    manifest = build_visualization_artifact(
        report,
        MATRICES_PATH,
        REGISTRY_PATH,
        VISUALIZATIONS_PATH,
        include_umap=not args.no_umap,
    )
    report.setdefault("artifacts", {})["visualizations"] = manifest
    report.setdefault("meta", {})["visualizationVersion"] = manifest["version"]
    REPORT_PATH.write_text(json.dumps(report, separators=(",", ":")))

    progress = json.loads(PROGRESS_PATH.read_text()) if PROGRESS_PATH.exists() else {}
    progress["reportSha256"] = sha_file(REPORT_PATH)
    progress["visualizationSha256"] = manifest["sha256"]
    PROGRESS_PATH.write_text(json.dumps(progress, separators=(",", ":")))

    if not args.no_publish:
        store = Store()
        store.s3.upload_file(
            str(VISUALIZATIONS_PATH), store.bucket, VISUALIZATIONS_KEY,
            ExtraArgs={"ContentType": "application/gzip"},
        )
        store.put(REPORT_KEY, REPORT_PATH.read_bytes(), "application/json")
        store.put(PROGRESS_KEY, PROGRESS_PATH.read_bytes(), "application/json")

    print(json.dumps({
        "artifact": str(VISUALIZATIONS_PATH),
        "published": not args.no_publish,
        **manifest,
    }, indent=2))


if __name__ == "__main__":
    main()
