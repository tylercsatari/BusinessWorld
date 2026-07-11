"""High-throughput placement in the exact frozen Long Quant text manifold."""

from __future__ import annotations

import json
import math
import os
import shutil
import zipfile
from pathlib import Path

import numpy as np

try:
    import faiss
except ImportError:
    faiss = None

from embedding_store import R2Store


EPS = 1e-9
METRICS = ("ctrviews", "ctr", "ret30", "views", "scaled_views", "realviews", "gt10m")


def unit_rows(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, np.float32)
    return values / (np.linalg.norm(values, axis=1, keepdims=True) + EPS)


def percentile(sorted_values: np.ndarray, values: np.ndarray) -> np.ndarray:
    sorted_values = np.asarray(sorted_values, float)
    values = np.asarray(values, float)
    return 100 * np.searchsorted(sorted_values, values, side="left") / max(1, len(sorted_values) - 1)


def weighted_neighbor_average(values, indices: np.ndarray, weights: np.ndarray) -> np.ndarray:
    source = np.asarray(values, float)
    gathered = source[indices]
    valid = np.isfinite(gathered)
    numerator = np.where(valid, gathered * weights, 0).sum(axis=1)
    denominator = np.where(valid, weights, 0).sum(axis=1)
    return np.divide(numerator, denominator, out=np.full(len(indices), np.nan), where=denominator > 0)


def score_neighbor_tables(mapping: dict, indices: np.ndarray, similarities: np.ndarray) -> dict[str, dict[str, np.ndarray]]:
    weights = np.maximum(similarities, 0) ** 8 + 1e-6
    output = {}
    projections = mapping.get("proj") or {}

    def projection_values(name, aliases=()):
        for key in (name,) + tuple(aliases):
            projection = projections.get(key)
            if not isinstance(projection, dict):
                continue
            for field in ("est", "x"):
                values = projection.get(field)
                if isinstance(values, list) and len(values) >= int(indices.max()) + 1:
                    return key, field, np.asarray(values, float)
        return None, None, None

    for name, aliases in (("ctrviews", ()), ("ctr", ()), ("ret30", ("retention",)),
                          ("realviews", ())):
        projection, field, values = projection_values(name, aliases)
        if values is None:
            output[name] = {"estimate": np.full(len(indices), np.nan),
                            "percentile": np.full(len(indices), np.nan),
                            "source": "missing"}
            continue
        estimate = weighted_neighbor_average(values, indices, weights)
        finite = np.sort(values[np.isfinite(values)])
        output[name] = {
            "estimate": estimate,
            "percentile": percentile(finite, estimate),
            "source": f"raw-long text projection {projection}.{field}",
        }

    views = np.asarray(mapping.get("views") or [], float)
    view_estimate = weighted_neighbor_average(views, indices, weights)
    output["views"] = {
        "estimate": view_estimate,
        "percentile": percentile(np.sort(views[np.isfinite(views)]), view_estimate),
        "source": "raw-long text neighbor views",
    }
    outlier = np.asarray(mapping.get("outlier") or [], float)
    outlier_estimate = weighted_neighbor_average(outlier, indices, weights)
    output["scaled_views"] = {
        "estimate": outlier_estimate,
        "percentile": percentile(np.sort(outlier[np.isfinite(outlier)]), outlier_estimate),
        "source": "raw-long text neighbor outlier",
    }
    gt10m = np.where(np.isfinite(views), (views >= 10_000_000).astype(float), np.nan)
    gt_estimate = weighted_neighbor_average(gt10m, indices, weights)
    output["gt10m"] = {
        "estimate": gt_estimate,
        "percentile": gt_estimate * 100,
        "source": "raw-long text neighbor 10M rate",
    }
    return output


class LongQuantTextSpace:
    def __init__(self, cache_dir: str | Path, neighbors: int = 24):
        if faiss is None:
            raise RuntimeError("FAISS is required for high-throughput Long Quant placement")
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.neighbors = neighbors
        self.r2 = R2Store()
        self.mapping = self._load_map()
        self.vectors = self._load_vectors()
        self.index = self._load_index()

    def _download(self, key: str, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        self.r2.client.download_file(self.r2.bucket, key, str(temp))
        os.replace(temp, path)

    def _load_map(self) -> dict:
        path = self.cache_dir / "map.json"
        if not path.exists():
            self._download("raw-long/text/map.json", path)
        return json.loads(path.read_text(encoding="utf-8"))

    def _load_vectors(self) -> np.ndarray:
        normalized = self.cache_dir / "vectors-unit.npy"
        if normalized.exists():
            # Only the normalized matrix is used after construction. Clean up
            # interrupted-build inputs so the frozen manifold has one local
            # copy instead of three.
            (self.cache_dir / "embeddings.npz").unlink(missing_ok=True)
            (self.cache_dir / "vectors.npy").unlink(missing_ok=True)
            return np.load(normalized, mmap_mode="r")
        archive = self.cache_dir / "embeddings.npz"
        if not archive.exists():
            self._download("raw-long/text/embeddings.npz", archive)
        raw_path = self.cache_dir / "vectors.npy"
        if not raw_path.exists():
            with zipfile.ZipFile(archive) as zipped:
                member = next(name for name in zipped.namelist() if name.endswith("vecs.npy"))
                temp = raw_path.with_suffix(".tmp.npy")
                with zipped.open(member) as source, open(temp, "wb") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                os.replace(temp, raw_path)
        raw = np.load(raw_path, mmap_mode="r")
        target = np.lib.format.open_memmap(normalized, mode="w+", dtype=np.float32, shape=raw.shape)
        for start in range(0, len(raw), 2048):
            target[start:start + 2048] = unit_rows(np.asarray(raw[start:start + 2048], np.float32))
        target.flush()
        del target
        del raw
        archive.unlink(missing_ok=True)
        raw_path.unlink(missing_ok=True)
        return np.load(normalized, mmap_mode="r")

    def _load_index(self):
        path = self.cache_dir / "hnsw.faiss"
        if path.exists():
            index = faiss.read_index(str(path))
        else:
            faiss.omp_set_num_threads(max(1, min(8, os.cpu_count() or 1)))
            index = faiss.IndexHNSWFlat(self.vectors.shape[1], 48, faiss.METRIC_INNER_PRODUCT)
            index.hnsw.efConstruction = 240
            for start in range(0, len(self.vectors), 2048):
                index.add(np.asarray(self.vectors[start:start + 2048], np.float32))
            faiss.write_index(index, str(path))
        index.hnsw.efSearch = 320
        return index

    def validate_recall(self, probes: int = 12) -> dict:
        rng = np.random.RandomState(1729)
        probe_indices = rng.choice(len(self.vectors), min(probes, len(self.vectors)), replace=False)
        queries = np.asarray(self.vectors[probe_indices], np.float32)
        _, approximate = self.index.search(queries, self.neighbors)
        recalls = []
        for query, approximate_row in zip(queries, approximate):
            scores = np.empty(len(self.vectors), np.float32)
            for start in range(0, len(self.vectors), 4096):
                scores[start:start + 4096] = np.asarray(self.vectors[start:start + 4096]) @ query
            exact = np.argpartition(-scores, self.neighbors - 1)[:self.neighbors]
            recalls.append(len(set(exact.tolist()) & set(approximate_row.tolist())) / self.neighbors)
        return {"probes": len(recalls), "recallAt24": float(np.mean(recalls)),
                "minimumRecallAt24": float(np.min(recalls))}

    def score(self, vectors: np.ndarray, batch_size: int = 512) -> dict[str, dict[str, np.ndarray]]:
        vectors = unit_rows(vectors)
        all_indices = []
        all_similarities = []
        for start in range(0, len(vectors), batch_size):
            similarities, indices = self.index.search(np.asarray(vectors[start:start + batch_size], np.float32),
                                                       self.neighbors)
            all_indices.append(indices)
            all_similarities.append(similarities)
        indices = np.vstack(all_indices)
        similarities = np.vstack(all_similarities)
        scored = score_neighbor_tables(self.mapping, indices, similarities)
        scored["neighbor_cosine"] = {
            "estimate": similarities[:, 0],
            "percentile": np.full(len(similarities), np.nan),
            "source": "nearest raw-long text embedding cosine",
        }
        return scored
