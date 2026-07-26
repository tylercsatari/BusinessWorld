#!/usr/bin/env python3
"""Reconstruct outcome-blind geometry directly from frozen raw vectors."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import PCA


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache" / "reconstructed-geometry"
MANIFEST_PATH = HERE / "snapshot-manifest.json"
INTEGRITY_PATH = HERE / "snapshot-integrity.json"
OUTPUT_PATH = HERE / "reconstructed-geometry-summary.json"
CHANNELS = [
    ("shorts", "visual"),
    ("shorts", "text"),
    ("shorts", "together"),
    ("long", "visual"),
    ("long", "text"),
    ("long", "together"),
]
RESOLUTIONS = [6, 10, 16, 24]
PCA_COMPONENTS = 64
BASE_SEED = 20260726


def rounded(value: float | None, digits: int = 6) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return round(float(value), digits)


def stable_seed(format_name: str, modality: str, offset: int = 0) -> int:
    digest = hashlib.sha256(f"{format_name}:{modality}".encode()).digest()
    return BASE_SEED + int.from_bytes(digest[:2], "big") + offset


def scale_coordinate(values: np.ndarray) -> tuple[np.ndarray, dict[str, float]]:
    low = float(np.quantile(values, 0.01))
    high = float(np.quantile(values, 0.99))
    width = max(1e-12, high - low)
    scaled = np.clip((values - low) / width, 0, 1)
    return np.rint(scaled * 1000).astype(np.int16), {
        "p01": rounded(low),
        "p99": rounded(high),
    }


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def representative_indices(
    transformed: np.ndarray,
    labels: np.ndarray,
    centers: np.ndarray,
) -> list[int]:
    representatives = []
    for cluster in range(len(centers)):
        indices = np.flatnonzero(labels == cluster)
        distances = np.sum(
            (transformed[indices] - centers[cluster]) ** 2,
            axis=1,
        )
        representatives.append(int(indices[int(np.argmin(distances))]))
    return representatives


def reconstruct_channel(
    format_name: str,
    modality: str,
    objects: dict[str, dict[str, Any]],
    native_coherence: dict[str, bool],
) -> dict[str, Any]:
    vector_object = objects[f"{format_name}:{modality}:vectors"]
    vector_path = (HERE / vector_object["localObject"]).resolve()
    print(f"reconstructing {format_name}:{modality}", flush=True)
    with np.load(vector_path, allow_pickle=True) as archive:
        ids = archive["ids"].astype(str)
        vectors = archive["vecs"].astype(np.float32, copy=False)
        components = min(PCA_COMPONENTS, vectors.shape[1], len(vectors) - 1)
        pca = PCA(
            n_components=components,
            svd_solver="randomized",
            random_state=stable_seed(format_name, modality),
        )
        transformed = pca.fit_transform(vectors).astype(np.float32, copy=False)
        x, x_scale = scale_coordinate(transformed[:, 0])
        y, y_scale = scale_coordinate(transformed[:, 1])
        clusters: dict[str, list[int]] = {}
        representatives: dict[str, list[dict[str, Any]]] = {}
        inertia: dict[str, float] = {}
        for resolution in RESOLUTIONS:
            model = MiniBatchKMeans(
                n_clusters=resolution,
                init="k-means++",
                n_init=10,
                max_iter=300,
                batch_size=4096,
                reassignment_ratio=0.01,
                random_state=stable_seed(format_name, modality, resolution),
            )
            labels = model.fit_predict(transformed)
            clusters[str(resolution)] = labels.astype(int).tolist()
            inertia[str(resolution)] = rounded(float(model.inertia_))
            representatives[str(resolution)] = [
                {
                    "cluster": cluster,
                    "index": index,
                    "videoId": ids[index],
                }
                for cluster, index in enumerate(
                    representative_indices(
                        transformed,
                        labels,
                        model.cluster_centers_,
                    )
                )
            ]
        geometry = {
            "schema": "outcome-blind-reconstructed-geometry-v1",
            "snapshotRunId": objects[f"{format_name}:{modality}:vectors"].get(
                "snapshotRunId"
            ),
            "format": format_name,
            "modality": modality,
            "vectorHash": vector_object["sha256"],
            "ids": ids.tolist(),
            "pca": {
                "x": x.astype(int).tolist(),
                "y": y.astype(int).tolist(),
                "xScale": x_scale,
                "yScale": y_scale,
                "components": components,
                "varianceExplained": rounded(
                    float(np.sum(pca.explained_variance_ratio_))
                ),
                "firstTwoVarianceExplained": rounded(
                    float(np.sum(pca.explained_variance_ratio_[:2]))
                ),
            },
            "clusters": clusters,
            "representatives": representatives,
            "inertia": inertia,
        }
        serialized = json.dumps(
            geometry,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        geometry["contentHash"] = hashlib.sha256(serialized).hexdigest()
        CACHE.mkdir(parents=True, exist_ok=True)
        output = CACHE / f"{format_name}-{modality}.json.gz"
        with output.open("wb") as raw_target:
            with gzip.GzipFile(
                filename="",
                mode="wb",
                fileobj=raw_target,
                compresslevel=9,
                mtime=0,
            ) as compressed:
                with io.TextIOWrapper(compressed, encoding="utf-8") as target:
                    json.dump(geometry, target, separators=(",", ":"))
        return {
            "id": f"{format_name}:{modality}",
            "vectorRole": f"{format_name}:{modality}:vectors",
            "vectorSha256": vector_object["sha256"],
            "rows": len(ids),
            "dimensions": int(vectors.shape[1]),
            "pcaComponents": components,
            "pcaVarianceExplained": geometry["pca"]["varianceExplained"],
            "firstTwoVarianceExplained": geometry["pca"][
                "firstTwoVarianceExplained"
            ],
            "resolutions": RESOLUTIONS,
            "inertia": inertia,
            "nativeMapVectorCoherent": native_coherence.get(
                f"{format_name}:{modality}",
                False,
            ),
            "geometryPath": str(output.relative_to(HERE)),
            "geometryBytesGzip": output.stat().st_size,
            "geometrySha256": sha256_path(output),
            "geometryContentHash": geometry["contentHash"],
        }


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text())
    integrity = json.loads(INTEGRITY_PATH.read_text())
    objects = {item["role"]: item for item in manifest["objects"]}
    for item in objects.values():
        item["snapshotRunId"] = manifest["runId"]
    native_coherence = {
        item["id"]: bool(item["mapAndVectorIdOrderMatch"])
        for item in integrity["channels"]
    }
    channels = [
        reconstruct_channel(format_name, modality, objects, native_coherence)
        for format_name, modality in CHANNELS
    ]
    output = {
        "schema": "outcome-blind-reconstructed-geometry-summary-v1",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "snapshotRunId": manifest["runId"],
        "snapshotIdentityHash": manifest["identityHash"],
        "method": {
            "input": "frozen unit-normalized 1536-D Gemini vectors",
            "display": "deterministic PCA; coordinates clipped at input-only p01/p99",
            "clustering": "MiniBatchKMeans on PCA64 at k=6,10,16,24",
            "outcomesUsed": False,
            "canonicalPurpose": "discovery and visualization only",
        },
        "channels": channels,
        "claimBoundary": [
            "These clusters organize representation geometry; they are not performance classes.",
            "PCA and KMeans are refit from the immutable vectors and do not use views, subscribers, outlier, retention, likes, or comments.",
            "Predictive directions must be fit inside downstream training folds.",
            "Algorithm, seed, resolution, modality, source, time, and format stability remain separate tests.",
        ],
    }
    serialized = json.dumps(output, sort_keys=True, separators=(",", ":")).encode()
    output["contentHash"] = hashlib.sha256(serialized).hexdigest()
    OUTPUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({
        "output": str(OUTPUT_PATH),
        "channels": [
            {
                "id": channel["id"],
                "rows": channel["rows"],
                "pcaVarianceExplained": channel["pcaVarianceExplained"],
                "nativeMapCoherent": channel["nativeMapVectorCoherent"],
            }
            for channel in channels
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
