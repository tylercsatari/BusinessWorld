#!/usr/bin/env python3
"""Publish the four current Promise Lab product surfaces and nothing legacy."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, R2Store, json_ready


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"

PRODUCT_VERSION = "promise-lab-product-v1"

BROWSER_ARTIFACTS = {
    "componentLattice": ("component-lattice.json", "component-lattice.json.gz"),
    "opening20s": ("opening-20s.json", "opening-20s.json.gz"),
    "manualProbe": ("manual-probe.json", "manual-probe.json.gz"),
    "manualProjection": ("manual-projection.json", "manual-projection.json.gz"),
    "clusterOutcomes": ("cluster-outcomes.json", "cluster-outcomes.json.gz"),
    "latencyStudy": ("latency-study.json", "latency-study.json.gz"),
    "canonicalPartitions": ("canonical-partitions.json", "canonical-partitions.json.gz"),
    "hookQuality": ("hook-quality.json", "hook-quality.json.gz"),
    "hookOutcomes": ("hook-outcomes.json", "hook-outcomes.json.gz"),
    "marketReward": ("market-reward.json", "market-reward.json.gz"),
    "hookExamples": ("hook-example-results.json", "hook-example-results.json.gz"),
}

MODEL_ARTIFACTS = (
    "canonical-partition-model.json",
    "hook-quality-model.json",
    "forward-response-model.json",
    "hook-outcome-model.json",
    "market-reward-model.json",
    "component-lattice-model.json",
    "opening-20s-model.json",
)

API_ARTIFACTS = {
    "componentLattice": "/api/longquant/promise-lab/component-lattice",
    "opening20s": "/api/longquant/promise-lab/opening-20s",
    "manualProbe": "/api/longquant/promise-lab/manual-probe",
    "manualProjection": "/api/longquant/promise-lab/manual-projection",
    "clusterOutcomes": "/api/longquant/promise-lab/cluster-outcomes",
    "latencyStudy": "/api/longquant/promise-lab/latency-study",
    "canonicalPartitions": "/api/longquant/promise-lab/canonical-partitions",
    "hookQuality": "/api/longquant/promise-lab/hook-quality",
    "hookOutcomes": "/api/longquant/promise-lab/hook-outcomes",
    "marketReward": "/api/longquant/promise-lab/market-reward",
    "hookExamples": "/api/longquant/promise-lab/hook-example-results",
    "hookScore": "/api/longquant/promise-lab/hook-score",
}


def load_json(name: str) -> dict:
    path = CACHE / name
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def artifact_record(name: str, value: dict) -> dict:
    path = CACHE / name
    return {
        "file": name,
        "status": value.get("status"),
        "methodVersion": value.get("methodVersion"),
        "bytes": path.stat().st_size if path.exists() else 0,
        "sha256": sha256(path),
    }


def validate(artifacts: dict[str, dict], models: dict[str, dict]) -> list[str]:
    errors = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    for key, (name, _) in BROWSER_ARTIFACTS.items():
        value = artifacts.get(key) or {}
        check(bool(value), f"missing product artifact: {name}")
        check(bool(value.get("status")), f"product artifact has no status: {name}")
    for name in MODEL_ARTIFACTS:
        check(bool(models.get(name)), f"missing serving model: {name}")

    partitions = artifacts.get("canonicalPartitions") or {}
    quality = artifacts.get("hookQuality") or {}
    outcomes = artifacts.get("hookOutcomes") or {}
    market = artifacts.get("marketReward") or {}
    lattice = artifacts.get("componentLattice") or {}
    opening = artifacts.get("opening20s") or {}
    probe = artifacts.get("manualProbe") or {}
    projection = artifacts.get("manualProjection") or {}

    hooks = int(partitions.get("hooks") or len(partitions.get("rows") or []))
    check(hooks > 0, "canonical partition artifact has no hooks")
    check(partitions.get("outcomesUsed") is False,
          "canonical partition selection must remain outcome-blind")
    check(str((quality.get("partition") or {}).get("methodVersion") or "")
          == str(partitions.get("methodVersion") or ""),
          "Hook scorer and library partition method versions differ")
    check(str((models.get("canonical-partition-model.json") or {}).get("methodVersion") or "")
          == str(partitions.get("methodVersion") or ""),
          "canonical partition serving model differs from the library artifact")
    check(str((models.get("market-reward-model.json") or {}).get("methodVersion") or "")
          == str(market.get("methodVersion") or ""),
          "Market Hold serving model differs from the library artifact")
    check((market.get("externalTraining") or {}).get(
        "ownedOutcomeLabelsUsedToFitOrSelectAxis") is False,
        "Market Hold headline direction used owned outcome labels")

    check(int(lattice.get("hookCount") or 0) == hooks,
          "component lattice does not cover every library hook")
    check(bool((lattice.get("parityContract") or {}).get("shared")),
          "stored and typed hooks do not share one component lattice builder")
    check(int(opening.get("sourceVideos") or 0) == hooks,
          "20-second analysis does not cover every library hook")
    check(int((outcomes.get("audit") or {}).get("hooks") or 0) == hooks,
          "hook outcome audit does not cover every library hook")
    check(len(market.get("hooks") or []) == hooks,
          "Market Hold library does not cover every library hook")
    check(int((quality.get("model") or {}).get("trainingHooks") or 0) == hooks,
          "hook-quality validation does not cover every library hook")

    selected_map = str(projection.get("mapId") or "")
    probe_map = str((((probe.get("winnerDetail") or {}).get("map") or {}).get("id")) or "")
    check(bool(projection.get("saved")), "saved embedding is not marked persistent")
    check(bool(selected_map) and selected_map == str(partitions.get("mapId") or ""),
          "saved embedding and canonical category overlay use different maps")
    check(bool(probe_map) and probe_map == selected_map,
          "manual probe winner and saved embedding use different maps")
    check(bool((projection.get("frozenPointIndex") or {}).get("labels")),
          "saved embedding has no frozen point index")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    artifacts = {
        key: load_json(local_name)
        for key, (local_name, _) in BROWSER_ARTIFACTS.items()
    }
    models = {name: load_json(name) for name in MODEL_ARTIFACTS}
    errors = validate(artifacts, models)

    partitions = artifacts["canonicalPartitions"]
    quality = artifacts["hookQuality"]
    outcomes = artifacts["hookOutcomes"]
    market = artifacts["marketReward"]
    lattice = artifacts["componentLattice"]
    opening = artifacts["opening20s"]
    projection = artifacts["manualProjection"]
    cluster_outcomes = artifacts["clusterOutcomes"]
    latency = artifacts["latencyStudy"]
    hooks = int(partitions.get("hooks") or len(partitions.get("rows") or []))

    status = "complete" if not errors else "error"
    manifest = {
        "version": 5,
        "productVersion": PRODUCT_VERSION,
        "status": status,
        "errors": errors,
        "builtAt": int(time.time() * 1000),
        "title": "Promise Lab",
        "description": (
            "One frozen hook scorer, its measured hook library, the saved category "
            "embedding used to validate the decomposition, and the same analysis through 20 seconds."
        ),
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "surfaces": [
            {"id": "scorer", "label": "Hook scorer", "role": "score new text"},
            {"id": "library", "label": "Hook library", "role": "audit measured hooks"},
            {"id": "saved", "label": "Saved embedding", "role": "validate the frozen four-category map"},
            {"id": "opening20s", "label": "20s analysis", "role": "extend the same structure through observed opening transcript"},
        ],
        "scoringContract": {
            "primaryScore": "Market Hold",
            "partitionMethodVersion": partitions.get("methodVersion"),
            "marketMethodVersion": market.get("methodVersion"),
            "componentFormula": "score(full) - score(without component)",
            "relationshipFormula": (
                "score(full) - score(without A) - score(without B) + score(without A+B)"
            ),
            "sharedBy": ["typed hook scorer", "stored hook library"],
            "diagnosticsNotBlendedIntoHeadline": [
                "Hook Hold", "direct outcome forecasts", "retention curves",
                "component response lag", "20-second response analysis",
            ],
        },
        "counts": {
            "hooks": hooks,
            "canonicalComponents": int(partitions.get("chunks") or 0),
            "latticeHooks": int(lattice.get("hookCount") or 0),
            "latticeSpans": int(lattice.get("spanCount") or 0),
            "latticeEdges": int(lattice.get("edgeCount") or 0),
            "hookOutcomeComponents": int((outcomes.get("audit") or {}).get("components") or 0),
            "marketRewardHooks": len(market.get("hooks") or []),
            "opening20sVideos": int(opening.get("sourceVideos") or 0),
            "opening20sComponents": int(opening.get("componentCount") or 0),
            "savedProjectionMethods": len(projection.get("methods") or []),
            "savedProjectionPoints": len((projection.get("frozenPointIndex") or {}).get("labels") or []),
            "clusterOutcomeFamilies": int(cluster_outcomes.get("selectedFamilyCount") or 0),
            "latencyClusters": int(latency.get("clusterCount") or 0),
        },
        "validation": {
            "partitionStatus": quality.get("status"),
            "marketRewardStatus": market.get("status"),
            "componentLatticeParity": lattice.get("parityContract"),
            "savedMapId": projection.get("mapId"),
            "allProductChecksPassed": not errors,
        },
        "artifacts": API_ARTIFACTS,
        "artifactMetadata": {
            key: artifact_record(local_name, artifacts[key])
            for key, (local_name, _) in BROWSER_ARTIFACTS.items()
        },
    }
    progress = {
        "version": 5,
        "productVersion": PRODUCT_VERSION,
        "status": status,
        "stage": "current Promise Lab product published" if not errors else "product validation failed",
        "errors": errors,
        "hooksComplete": hooks,
        "surfacesComplete": 4 if not errors else 0,
        "updatedAt": int(time.time() * 1000),
    }

    (CACHE / "manifest.json").write_text(
        json.dumps(json_ready(manifest), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False),
        encoding="utf-8",
    )
    (CACHE / "progress.json").write_text(
        json.dumps(json_ready(progress), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False),
        encoding="utf-8",
    )

    if errors:
        print(json.dumps({"status": status, "errors": errors}, indent=2))
        raise SystemExit(1)
    if args.no_upload:
        print(json.dumps({"status": status, "counts": manifest["counts"]}, indent=2))
        return

    r2 = R2Store()
    r2.put_json(f"{R2_PREFIX}/manifest.json", manifest)
    r2.put_json(f"{R2_PREFIX}/progress.json", progress)
    for key, (local_name, remote_name) in BROWSER_ARTIFACTS.items():
        r2.put_json(f"{R2_PREFIX}/{remote_name}", artifacts[key], gzip_payload=True)
    for name in MODEL_ARTIFACTS:
        r2.put_json(f"{R2_PREFIX}/{name}.gz", models[name], gzip_payload=True)
    print(json.dumps({"status": status, "counts": manifest["counts"]}, indent=2))


if __name__ == "__main__":
    main()
