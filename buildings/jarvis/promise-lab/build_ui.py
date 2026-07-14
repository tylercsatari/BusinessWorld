#!/usr/bin/env python3
"""Publish the current Shorts Promise Lab product and no legacy score surfaces."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import time
from pathlib import Path

from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, R2Store, json_ready


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
PRODUCT_VERSION = "shorts-promise-lab-v4"

BROWSER_ARTIFACTS = {
    "openingPredictions": ("opening-predictions.json", "opening-predictions.json.gz"),
    "opening20s": ("opening-20s.json", "opening-20s.json.gz"),
    "manualProjection": ("manual-projection.json", "manual-projection.json.gz"),
    "canonicalPartitions": ("canonical-partitions.json", "canonical-partitions.json.gz"),
}
MODEL_ARTIFACTS = (
    "canonical-partition-model.json",
    "opening-lattice-model.json",
    "opening-20s-model.json",
    "opening-retention-model.json",
)
API_ARTIFACTS = {
    "openingPredictions": "/api/shortsquant/promise-lab/opening-predictions",
    "opening20s": "/api/shortsquant/promise-lab/opening-20s",
    "manualProjection": "/api/shortsquant/promise-lab/manual-projection",
    "canonicalPartitions": "/api/shortsquant/promise-lab/canonical-partitions",
    "hookScore": "/api/shortsquant/promise-lab/hook-score",
}


def load_json(name: str) -> dict:
    path = CACHE / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def load_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate(artifacts: dict[str, dict], models: dict[str, dict]) -> list[str]:
    errors = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    for key, (name, _) in BROWSER_ARTIFACTS.items():
        check(bool(artifacts.get(key)), f"missing product artifact: {name}")
        check((artifacts.get(key) or {}).get("status") == "complete",
              f"product artifact is not complete: {name}")
    for name in MODEL_ARTIFACTS:
        check(bool(models.get(name)), f"missing serving model: {name}")

    predictions = artifacts.get("openingPredictions") or {}
    opening = artifacts.get("opening20s") or {}
    projection = artifacts.get("manualProjection") or {}
    partitions = artifacts.get("canonicalPartitions") or {}
    retention_model = models.get("opening-retention-model.json") or {}
    lattice_model = models.get("opening-lattice-model.json") or {}
    rows = predictions.get("rows") or []
    sources = int(predictions.get("sources") or 0)
    check(sources > 0 and len(rows) == sources,
          "opening prediction summary does not contain every source")
    check(sources == int(opening.get("sourceVideos") or 0),
          "predictions and measured 20-second openings have different source counts")
    check(sources == int(retention_model.get("trainingSources") or 0),
          "browser predictions and serving model have different training sources")
    check(predictions.get("predictorVersion") == retention_model.get("predictorVersion"),
          "browser and serving predictor versions differ")
    check(predictions.get("featureVersion") == retention_model.get("featureVersion"),
          "browser and serving feature versions differ")
    check(all(int(row.get("componentCount") or 0) > 0 for row in rows),
          "a saved opening has no canonical components")
    check(all(len(row.get("components") or []) == int(row.get("componentCount") or 0)
              for row in rows),
          "the opening library summary does not expose every component phrase")
    check(all((row.get("outputs") or {}).get("retainedAtAnalyzedEndPercent") is not None
              for row in rows), "a saved opening has no endpoint retention prediction")
    check((retention_model.get("trainingMethod") or {}).get("savedPredictionPolicy") == "source-level out-of-fold at every second",
          "saved predictions are not out of fold")
    check((retention_model.get("trainingMethod") or {}).get("typedPredictionPolicy") == "same frozen per-second full fits",
          "typed predictions are not pinned to a frozen full fit")
    check((retention_model.get("trainingMethod") or {}).get("futureWordsUsedForEarlierPredictions") is False,
          "an earlier prediction can consume future opening words")
    check((retention_model.get("trainingMethod") or {}).get("boundaryOutcomesUsed") is False,
          "retention outcomes entered the component-boundary selector")
    check((partitions.get("outcomesUsed") is False),
          "canonical category map no longer has an outcome-blind partition contract")
    check(lattice_model.get("longFormReferenceUsed") is False,
          "the active Shorts lattice still depends on a Long Quant reference")
    check(lattice_model.get("outcomesUsed") is False,
          "the active lattice support model used an outcome")
    check(not lattice_model.get("titleManifoldUsed"),
          "the active Shorts lattice still ships a title manifold")
    check(bool(projection.get("saved")) and bool(projection.get("mapId")),
          "saved four-cluster embedding is not persistent")
    check(set((projection.get("frozenPointIndex") or {}).get("labels") or []) == {0, 1, 2, 3},
          "saved embedding does not contain exactly the frozen four-category vocabulary")
    ui_source = (HERE.parent / "promise-lab-ui.js").read_text(encoding="utf-8")
    for marker in (
        "function renderAnalysis(analysis, lattice)",
        "Where every predicted drop comes from",
        "Selected component inside the saved four-cluster embedding",
        "Component evidence and response timing",
        "Multi-resolution component lattice and edge graph",
        "Analysis data ledger",
    ):
        check(marker in ui_source, f"shared analysis renderer is missing: {marker}")
    for row in rows:
        video_id = str(row.get("videoId") or "")
        detail_path = CACHE / "opening-predictions" / f"{video_id}.json.gz"
        check(detail_path.exists(), f"missing saved prediction detail: {video_id}")
        if not detail_path.exists():
            continue
        detail = load_gzip(detail_path)
        attribution = detail.get("temporalAttribution") or {}
        curve = ((detail.get("curves") or {}).get("entryIndexed") or {})
        components = detail.get("components") or []
        check(len(attribution.get("steps") or []) == max(0, len(curve.get("timesSeconds") or []) - 1),
              f"temporal ledger does not cover every curve transition: {video_id}")
        check(len(attribution.get("componentLedger") or []) == len(components),
              f"temporal ledger does not cover every component: {video_id}")
        check(all(len(component.get("categoryDistribution") or []) == 4
                  and len(component.get("categoryCoordinates4D") or []) == 4
                  and component.get("timelineAttribution") is not None
                  for component in components),
              f"component evidence is incomplete: {video_id}")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()
    artifacts = {
        key: load_json(local_name) for key, (local_name, _) in BROWSER_ARTIFACTS.items()
    }
    models = {name: load_json(name) for name in MODEL_ARTIFACTS}
    errors = validate(artifacts, models)
    predictions = artifacts.get("openingPredictions") or {}
    opening = artifacts.get("opening20s") or {}
    projection = artifacts.get("manualProjection") or {}
    model = models.get("opening-retention-model.json") or {}
    status = "complete" if not errors else "error"
    manifest = {
        "version": 8,
        "productVersion": PRODUCT_VERSION,
        "status": status,
        "errors": errors,
        "builtAt": int(time.time() * 1000),
        "title": "Promise Lab",
        "description": (
            "One causal Shorts opening scorer and its 208-video measured library, using the "
            "same prefix-by-prefix 20-second retention, attribution, component, graph, and "
            "four-cluster embedding contract."
        ),
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "surfaces": [
            {"id": "scorer", "label": "Score opening", "role": "frozen causal temporal inference"},
            {"id": "library", "label": "Opening library", "role": "source-level out-of-fold temporal audit"},
            {"id": "saved", "label": "Saved embedding", "role": "outcome-blind category validation"},
        ],
        "scoringContract": {
            "primaryOutput": "predicted entry-indexed retention at hook end and 20 seconds",
            "analysisHorizonSeconds": 20.0,
            "predictorVersion": predictions.get("predictorVersion"),
            "featureVersion": predictions.get("featureVersion"),
            "selectedStages": {
                name: family.get("selectedStage")
                for name, family in (model.get("families") or {}).items()
            },
            "savedPredictionPolicy": "out-of-fold",
            "typedPredictionPolicy": "frozen full fit",
            "causalTemporalFormula": (
                "at second t, embed only transcript atoms acoustically completed by t and apply "
                "the frozen scalar model for t"
            ),
            "componentFormula": (
                "withheld 20-second candidate prediction(full exact cover) minus prediction after "
                "deleting one component and recomputing component/relationship features"
            ),
            "relationshipFormula": (
                "candidate prediction with adjacent relation minus prediction with that "
                "relation channel disabled"
            ),
            "unvalidatedStagesAppliedToHeadline": False,
            "longFormReferenceUsed": False,
            "viewsRole": (model.get("viewsContract") or {}).get("promotionStatus") or "withheld",
        },
        "visualizationContract": {
            "sharedRenderer": "renderAnalysis(analysis, lattice)",
            "typedAndSavedUseSameRenderer": True,
            "temporalTransitionsVisible": True,
            "everySelectedComponentVisible": True,
            "savedEmbeddingIntegratedPerComponent": True,
            "componentMeasurementsVisibleWhenObserved": True,
            "allLatticeNodesVisible": True,
            "allLatticeEdgeFamiliesSelectable": True,
            "validationBySecondVisible": True,
            "unavailableEvidenceIsExplicit": True,
        },
        "counts": {
            "openings": int(predictions.get("sources") or 0),
            "openingComponents": int(opening.get("componentCount") or 0),
            "latticeSpans": int(opening.get("spanCount") or 0),
            "latticeEdges": int(opening.get("edgeCount") or 0),
            "savedProjectionPoints": len((projection.get("frozenPointIndex") or {}).get("labels") or []),
        },
        "validation": predictions.get("validation"),
        "evidenceBoundary": predictions.get("evidenceBoundary"),
        "artifacts": API_ARTIFACTS,
        "artifactMetadata": {
            key: {
                "file": local_name,
                "status": artifacts[key].get("status"),
                "bytes": (CACHE / local_name).stat().st_size,
                "sha256": sha256(CACHE / local_name),
            }
            for key, (local_name, _) in BROWSER_ARTIFACTS.items()
        },
    }
    progress = {
        "version": 8,
        "productVersion": PRODUCT_VERSION,
        "status": status,
        "stage": "current Shorts Promise Lab published" if not errors else "product validation failed",
        "errors": errors,
        "openingsComplete": int(predictions.get("sources") or 0),
        "surfacesComplete": 3 if not errors else 0,
        "updatedAt": int(time.time() * 1000),
    }
    (CACHE / "manifest.json").write_text(
        json.dumps(json_ready(manifest), separators=(",", ":"), ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    (CACHE / "progress.json").write_text(
        json.dumps(json_ready(progress), separators=(",", ":"), ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    if errors:
        print(json.dumps({"status": status, "errors": errors}, indent=2))
        raise SystemExit(1)
    if args.no_upload:
        print(json.dumps({"status": status, "counts": manifest["counts"]}, indent=2))
        return
    remote = R2Store()
    remote.put_json(f"{R2_PREFIX}/manifest.json", manifest)
    remote.put_json(f"{R2_PREFIX}/progress.json", progress)
    for key, (local_name, remote_name) in BROWSER_ARTIFACTS.items():
        remote.put_json(f"{R2_PREFIX}/{remote_name}", artifacts[key], gzip_payload=True)
    for name in MODEL_ARTIFACTS:
        remote.put_json(f"{R2_PREFIX}/{name}.gz", models[name], gzip_payload=True)
    print(json.dumps({"status": status, "counts": manifest["counts"]}, indent=2))


if __name__ == "__main__":
    main()
