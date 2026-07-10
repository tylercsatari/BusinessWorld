#!/usr/bin/env python3
"""Build the Long Quant reference-to-gratification research artifact.

The study treats "reference to gratification" as an unknown latent construct.
It does not manufacture a label. Instead it asks which text-space directions
predict measured retention-curve behavior after progressively removing timing,
entry, and base-idea information.

Inputs (R2):
  longform/hook-embeds/index.json
  longform/hook-embeds/<video-id>.json

Outputs (R2):
  longform/gratification/report.json
  longform/gratification/embeddings.npz

The vectors use the exact model and dimensionality used by Long Quant's text
channel: gemini-embedding-2, outputDimensionality=1536.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

import boto3
import numpy as np
import requests
from scipy.stats import spearmanr
from sklearn.cluster import KMeans
from sklearn.cross_decomposition import PLSRegression
from sklearn.decomposition import IncrementalPCA, PCA
from sklearn.linear_model import Ridge, RidgeCV
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
DIM = 1536
MODEL = "gemini-embedding-2"
EMBED_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:embedContent"
INDEX_KEY = "longform/hook-embeds/index.json"
REPORT_KEY = "longform/gratification/report.json"
CACHE_KEY = "longform/gratification/embeddings.npz"
BASIS_KEY = "longform/gratification/title_corpus_basis.npz"
LOCAL_CACHE = HERE / ".cache" / "embeddings.npz"
LOCAL_BASIS = HERE / ".cache" / "title_corpus_basis.npz"
LOCAL_REPORT = HERE / ".cache" / "report.json"
SEED = 1729


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value:
        return value
    for candidate in (ROOT / ".env", Path.cwd() / ".env"):
        try:
            for line in candidate.read_text().splitlines():
                if line.strip().startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            pass
    return default


class Store:
    def __init__(self) -> None:
        account = env("R2_ACCOUNT_ID")
        self.bucket = env("R2_BUCKET_NAME", "business-world-videos")
        self.s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=env("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=env("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
        )

    def get(self, key: str) -> bytes | None:
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except Exception as exc:
            status = getattr(exc, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
            if status == 404:
                return None
            raise

    def put(self, key: str, payload: bytes, content_type: str) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=payload, ContentType=content_type)

    def etag(self, key: str) -> str:
        try:
            value = self.s3.head_object(Bucket=self.bucket, Key=key).get("ETag") or ""
            return str(value).strip('"')
        except Exception:
            return ""


def sha_text(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()[:20]


def normalize_rows(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, np.float32)
    return values / (np.linalg.norm(values, axis=1, keepdims=True) + 1e-9)


def finite(value) -> bool:
    try:
        return bool(np.isfinite(float(value)))
    except (TypeError, ValueError):
        return False


def safe_float(value, default=np.nan) -> float:
    return float(value) if finite(value) else float(default)


def round_or_none(value, digits=4):
    return round(float(value), digits) if finite(value) else None


def percentile(values: np.ndarray, q: float) -> float:
    vals = values[np.isfinite(values)]
    return float(np.percentile(vals, q)) if len(vals) else float("nan")


def scale_0_100(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, float)
    mask = np.isfinite(values)
    out = np.full(len(values), np.nan)
    if not mask.any():
        return out
    lo, hi = np.percentile(values[mask], [1, 99])
    if hi - lo < 1e-9:
        out[mask] = 50.0
    else:
        out[mask] = np.clip((values[mask] - lo) / (hi - lo) * 100.0, 0, 100)
    return out


def bh_qvalues(pvalues: list[float]) -> list[float | None]:
    valid = [(i, float(p)) for i, p in enumerate(pvalues) if finite(p)]
    out: list[float | None] = [None] * len(pvalues)
    if not valid:
        return out
    ordered = sorted(valid, key=lambda x: x[1])
    running = 1.0
    m = len(ordered)
    for rank in range(m, 0, -1):
        idx, p = ordered[rank - 1]
        running = min(running, p * m / rank)
        out[idx] = min(1.0, running)
    return out


def load_records(store: Store) -> tuple[dict, list[dict]]:
    raw = store.get(INDEX_KEY)
    if not raw:
        raise RuntimeError(f"missing {INDEX_KEY}")
    index = json.loads(raw)
    base = [row for row in index.get("rows", []) if row.get("id") and row.get("hookText")]

    def detail(row: dict) -> dict:
        payload = store.get(f"longform/hook-embeds/{row['id']}.json")
        if not payload:
            return row
        try:
            merged = dict(row)
            merged.update(json.loads(payload))
            return merged
        except Exception:
            return row

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        rows = list(pool.map(detail, base))
    rows = [r for r in rows if isinstance(r.get("curve"), list) and len(r["curve"]) >= 20]
    rows.sort(key=lambda r: str(r.get("id")))
    return index, rows


def cache_from_bytes(payload: bytes | None) -> dict[str, np.ndarray]:
    if not payload:
        return {}
    try:
        z = np.load(io.BytesIO(payload), allow_pickle=False)
        keys = [str(x) for x in z["keys"].tolist()]
        vecs = np.asarray(z["vecs"], np.float32)
        return {key: vecs[i] for i, key in enumerate(keys) if vecs[i].size == DIM}
    except Exception:
        return {}


def cache_to_bytes(cache: dict[str, np.ndarray]) -> bytes:
    keys = sorted(cache)
    vecs = np.stack([cache[k] for k in keys]).astype(np.float32) if keys else np.zeros((0, DIM), np.float32)
    target = io.BytesIO()
    np.savez_compressed(target, keys=np.asarray(keys), vecs=vecs, model=np.asarray([MODEL]))
    return target.getvalue()


def embed_text(text: str, attempts=7) -> np.ndarray:
    key = env("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not configured")
    body = {"content": {"parts": [{"text": text[:500]}]}, "outputDimensionality": DIM}
    last = ""
    for attempt in range(attempts):
        try:
            response = requests.post(
                EMBED_URL,
                headers={"Content-Type": "application/json", "x-goog-api-key": key},
                json=body,
                timeout=45,
            )
            if response.ok:
                vec = np.asarray(response.json()["embedding"]["values"], np.float32)
                if vec.size != DIM:
                    raise RuntimeError(f"expected {DIM} values, got {vec.size}")
                return vec
            last = f"HTTP {response.status_code}: {response.text[:180]}"
            if response.status_code not in (429, 500, 502, 503, 504):
                break
        except Exception as exc:
            last = str(exc)
        time.sleep(min(20, 1.5 * (attempt + 1) ** 1.5))
    raise RuntimeError("Gemini embedding failed: " + last)


def ensure_embeddings(store: Store, rows: list[dict], force=False, workers=5) -> tuple[np.ndarray, np.ndarray, dict]:
    payload = None
    if not force and LOCAL_CACHE.exists():
        payload = LOCAL_CACHE.read_bytes()
    if not payload and not force:
        payload = store.get(CACHE_KEY)
    cache = cache_from_bytes(payload)
    wanted: list[tuple[str, str]] = []
    row_keys = []
    for row in rows:
        hook = re.sub(r"\s+", " ", str(row.get("hookText") or "")).strip()
        title = re.sub(r"\s+", " ", str(row.get("title") or row.get("name") or "")).strip()
        hk = f"hook:{row['id']}:{sha_text(hook)}"
        tk = f"title:{row['id']}:{sha_text(title)}"
        row_keys.append((hk, tk))
        if force or hk not in cache:
            wanted.append((hk, hook))
        if force or tk not in cache:
            wanted.append((tk, title))

    if wanted:
        print(f"embedding {len(wanted)} missing hook/title texts with {MODEL}", flush=True)
        done = 0
        for start in range(0, len(wanted), 20):
            batch = wanted[start:start + 20]
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {pool.submit(embed_text, text): key for key, text in batch}
                for future in concurrent.futures.as_completed(futures):
                    cache[futures[future]] = future.result()
                    done += 1
                    print(f"  embedded {done}/{len(wanted)}", flush=True)
            current = cache_to_bytes(cache)
            LOCAL_CACHE.parent.mkdir(parents=True, exist_ok=True)
            LOCAL_CACHE.write_bytes(current)
            store.put(CACHE_KEY, current, "application/octet-stream")

    hook = normalize_rows(np.stack([cache[hk] for hk, _ in row_keys]))
    title = normalize_rows(np.stack([cache[tk] for _, tk in row_keys]))
    manifest = {
        "model": MODEL,
        "dimensions": DIM,
        "hookVectors": len(hook),
        "titleVectors": len(title),
        "cacheKey": CACHE_KEY,
        "allExact": True,
    }
    return hook, title, manifest


@dataclass
class TitleCorpusBasis:
    components_: np.ndarray
    mean_: np.ndarray
    explained_variance_ratio_: np.ndarray
    n_titles: int
    source_etag: str

    def transform(self, values: np.ndarray) -> np.ndarray:
        return (np.asarray(values, np.float32) - self.mean_) @ self.components_.T


def title_basis_from_bytes(payload: bytes | None) -> TitleCorpusBasis | None:
    if not payload:
        return None
    try:
        z = np.load(io.BytesIO(payload), allow_pickle=False)
        components = np.asarray(z["components"], np.float32)
        mean = np.asarray(z["mean"], np.float32)
        explained = np.asarray(z["explained"], np.float32)
        n_titles = int(np.asarray(z["n_titles"]).reshape(-1)[0])
        if components.shape[1] != DIM or mean.size != DIM or n_titles < 1000:
            return None
        source_etag = str(np.asarray(z["source_etag"]).reshape(-1)[0]) if "source_etag" in z.files else ""
        return TitleCorpusBasis(components, mean, explained, n_titles, source_etag)
    except Exception:
        return None


def title_basis_to_bytes(basis: TitleCorpusBasis) -> bytes:
    target = io.BytesIO()
    np.savez_compressed(
        target,
        components=np.asarray(basis.components_, np.float32),
        mean=np.asarray(basis.mean_, np.float32),
        explained=np.asarray(basis.explained_variance_ratio_, np.float32),
        n_titles=np.asarray([basis.n_titles], np.int64),
        source_etag=np.asarray([basis.source_etag]),
        model=np.asarray([MODEL]),
    )
    return target.getvalue()


def ensure_title_corpus_basis(store: Store, force=False, dimensions=64) -> TitleCorpusBasis:
    source_etag = store.etag("raw-long/text/embeddings.npz")
    payload = None
    if not force and LOCAL_BASIS.exists():
        payload = LOCAL_BASIS.read_bytes()
    if not payload and not force:
        payload = store.get(BASIS_KEY)
    basis = title_basis_from_bytes(payload)
    if basis and basis.components_.shape[0] == dimensions and (not source_etag or basis.source_etag == source_etag):
        return basis

    # Reuse Long Quant's ETag-addressed memory-mapped corpus cache. The basis is
    # fit incrementally so all title vectors define the geometry without holding
    # the 250MB corpus in process memory.
    import sys
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from longquant_score import cache_vecs

    vectors = cache_vecs("text")
    n_titles = len(vectors)
    batch_size = 2048
    model = IncrementalPCA(n_components=dimensions, batch_size=batch_size)
    print(f"fitting {dimensions}d global basis across all {n_titles:,} Long Quant title vectors", flush=True)
    for start in range(0, n_titles, batch_size):
        stop = min(n_titles, start + batch_size)
        if stop - start < dimensions:
            start = max(0, n_titles - batch_size)
            stop = n_titles
        batch = normalize_rows(np.asarray(vectors[start:stop], np.float32))
        model.partial_fit(batch)
        print(f"  title basis {stop:,}/{n_titles:,}", flush=True)
        if stop == n_titles:
            break
    basis = TitleCorpusBasis(
        np.asarray(model.components_, np.float32),
        np.asarray(model.mean_, np.float32),
        np.asarray(model.explained_variance_ratio_, np.float32),
        n_titles,
        source_etag,
    )
    payload = title_basis_to_bytes(basis)
    LOCAL_BASIS.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_BASIS.write_bytes(payload)
    store.put(BASIS_KEY, payload, "application/octet-stream")
    return basis


def ret_at(row: dict, seconds: float) -> float:
    curve = np.asarray(row.get("curve") or [], float)
    duration = safe_float(row.get("duration_s"))
    if len(curve) < 2 or not finite(duration) or duration <= 0 or seconds < 0 or seconds > duration:
        return float("nan")
    x = seconds / duration * (len(curve) - 1)
    lo = int(math.floor(x))
    hi = min(len(curve) - 1, lo + 1)
    value = curve[lo] + (curve[hi] - curve[lo]) * (x - lo)
    return float(value * 100.0)


def auc_relative(row: dict, start: float, width: float, points=21) -> float:
    vals = np.asarray([ret_at(row, start + width * i / (points - 1)) for i in range(points)], float)
    vals = vals[np.isfinite(vals)]
    return float(vals.mean()) if len(vals) >= max(4, points // 2) else float("nan")


def first_crossing(row: dict, start: float, ratio=0.9, horizon=20.0) -> float:
    anchor = ret_at(row, start)
    if not finite(anchor) or anchor <= 0:
        return float("nan")
    max_t = min(safe_float(row.get("duration_s"), start), start + horizon)
    for t in np.linspace(start, max_t, 81)[1:]:
        if ret_at(row, float(t)) < anchor * ratio:
            return float(t - start)
    return float(max_t - start)


@dataclass
class TargetDef:
    id: str
    label: str
    family: str
    description: str
    unit: str


def build_outcomes(rows: list[dict]) -> tuple[dict[str, np.ndarray], list[TargetDef], dict, list[dict]]:
    ids = []
    raw: dict[str, list[float]] = {}
    relative_times = [-3, -2, -1, 0, 1, 2, 3, 5, 8, 10, 15]
    relative_curves = []
    controls = []
    today = dt.date.today()

    def add(name: str, value: float) -> None:
        raw.setdefault(name, []).append(value)

    for row in rows:
        ids.append(row["id"])
        duration = safe_float(row.get("duration_s"))
        hook = safe_float(row.get("hookEndSec"))
        start = ret_at(row, 0)
        r1 = ret_at(row, 1)
        r5 = ret_at(row, 5)
        rh = ret_at(row, hook)
        p3, p5, p10 = ret_at(row, hook + 3), ret_at(row, hook + 5), ret_at(row, hook + 10)
        auc10 = auc_relative(row, hook, 10)
        pre_span = max(1.0, hook - 1.0)
        pre_slope = (rh - r1) / pre_span if finite(rh) and finite(r1) else np.nan
        post_slope = (p10 - rh) / 10.0 if finite(p10) and finite(rh) else np.nan
        add("keep", safe_float(row.get("keep_rate")))
        add("avg_retention", safe_float(row.get("avg_retention")))
        add("log_views", math.log10(max(1.0, safe_float(row.get("views"), 1))))
        add("ret5", r5)
        add("entry_hold_5", 100 * r5 / start if finite(r5) and start > 0 else np.nan)
        add("hold_to_hook", 100 * rh / start if finite(rh) and start > 0 else np.nan)
        add("post_hold_3", 100 * p3 / rh if finite(p3) and rh > 0 else np.nan)
        add("post_hold_5", 100 * p5 / rh if finite(p5) and rh > 0 else np.nan)
        add("post_hold_10", 100 * p10 / rh if finite(p10) and rh > 0 else np.nan)
        add("post_auc_10", 100 * auc10 / rh if finite(auc10) and rh > 0 else np.nan)
        add("post_slope_10", post_slope)
        add("slope_change", post_slope - pre_slope if finite(post_slope) and finite(pre_slope) else np.nan)
        add("hold_horizon_90", first_crossing(row, hook, 0.9, 20))

        rel = []
        for offset in relative_times:
            value = ret_at(row, hook + offset)
            rel.append(100 * value / rh if finite(value) and rh > 0 else np.nan)
        relative_curves.append(rel)

        words = int(row.get("hookWordCount") or len(re.findall(r"[A-Za-z0-9']+", str(row.get("hookText") or ""))))
        published = None
        try:
            published = dt.date.fromisoformat(str(row.get("published"))[:10])
        except Exception:
            pass
        controls.append({
            "duration": duration,
            "log_duration": math.log(max(duration, 1.0)) if finite(duration) else np.nan,
            "hook_seconds": hook,
            "hook_pct": 100 * hook / duration if finite(hook) and finite(duration) and duration > 0 else np.nan,
            "word_count": words,
            "speech_rate": words / max(hook, 0.5) if finite(hook) else np.nan,
            "start_retention": start,
            "keep": safe_float(row.get("keep_rate")),
            "age_days": (today - published).days if published else np.nan,
        })

    outcomes = {key: np.asarray(values, float) for key, values in raw.items()}
    rel_matrix = np.asarray(relative_curves, float)
    med = np.nanmedian(rel_matrix, axis=0)
    rel_filled = np.where(np.isfinite(rel_matrix), rel_matrix, med)
    rel_scaled = StandardScaler().fit_transform(rel_filled)
    curve_pca = PCA(n_components=3, random_state=SEED).fit(rel_scaled)
    curve_scores = curve_pca.transform(rel_scaled)
    for pc in range(3):
        load = curve_pca.components_[pc]
        pivot = int(np.argmax(np.abs(load)))
        if load[pivot] < 0:
            curve_pca.components_[pc] *= -1
            curve_scores[:, pc] *= -1
        outcomes[f"curve_pc{pc + 1}"] = curve_scores[:, pc]

    consensus_keys = ["post_hold_3", "post_hold_5", "post_hold_10", "post_auc_10", "post_slope_10", "hold_horizon_90"]
    consensus_cols = []
    for key in consensus_keys:
        values = outcomes[key]
        mean, sd = np.nanmean(values), np.nanstd(values) + 1e-9
        consensus_cols.append((values - mean) / sd)
    consensus = np.nanmean(np.stack(consensus_cols, axis=1), axis=1)
    outcomes["hold_consensus"] = consensus

    defs = [
        TargetDef("hold_consensus", "Post-hook hold consensus", "candidate", "Equal-weight composite of six measured post-hook hold/shape outcomes; a candidate proxy, not a gratification label.", "z"),
        TargetDef("post_hold_3", "Hold 3s after hook", "hook-aligned", "Retention three seconds after the spoken promise ends, divided by retention at that endpoint.", "% of hook-end"),
        TargetDef("post_hold_5", "Hold 5s after hook", "hook-aligned", "Retention five seconds after hook end, normalized to hook-end retention.", "% of hook-end"),
        TargetDef("post_hold_10", "Hold 10s after hook", "hook-aligned", "Retention ten seconds after hook end, normalized to hook-end retention.", "% of hook-end"),
        TargetDef("post_auc_10", "Next-10s retention area", "hook-aligned", "Mean retention across the ten seconds after hook end, normalized to hook-end retention.", "% of hook-end"),
        TargetDef("post_slope_10", "Post-hook slope", "hook-aligned", "Percentage-point retention slope per second over the ten seconds after hook end; higher is flatter.", "pp/s"),
        TargetDef("slope_change", "Slope change at hook", "hook-aligned", "Post-hook slope minus the pre-hook slope. Positive means the curve flattens after the promise is complete.", "pp/s"),
        TargetDef("hold_horizon_90", "90% hold horizon", "hook-aligned", "Seconds after hook end until retention falls below 90% of hook-end retention, capped at 20 seconds.", "seconds"),
        TargetDef("hold_to_hook", "Entry to hook-end hold", "timing", "Hook-end retention divided by starting retention.", "% of start"),
        TargetDef("entry_hold_5", "Entry to 5s hold", "timing", "Five-second retention divided by starting retention, independent of variable hook cuts.", "% of start"),
        TargetDef("ret5", "Retention at 5s", "traditional", "Absolute audience retention at a fixed five-second mark.", "%"),
        TargetDef("keep", "Viewed vs swiped", "traditional", "YouTube Viewed percentage; included as a diagnostic because opening visuals strongly affect it.", "%"),
        TargetDef("avg_retention", "Average retention", "traditional", "Average percentage viewed across the entire Short.", "%"),
        TargetDef("log_views", "Log views", "traditional", "log10 total views; highly distribution-confounded and never treated as direct gratification truth.", "log10"),
        TargetDef("curve_pc1", "Hook-aligned curve shape 1", "discovered", "First unsupervised component of retention shape from -3s to +15s around hook end.", "PC score"),
        TargetDef("curve_pc2", "Hook-aligned curve shape 2", "discovered", "Second unsupervised component of hook-aligned retention shape.", "PC score"),
        TargetDef("curve_pc3", "Hook-aligned curve shape 3", "discovered", "Third unsupervised component of hook-aligned retention shape.", "PC score"),
    ]
    curve_info = {
        "relativeTimes": relative_times,
        "explainedVariance": [round(float(x), 4) for x in curve_pca.explained_variance_ratio_],
        "loadings": [[round(float(x), 4) for x in row] for row in curve_pca.components_],
        "meaning": "Curves are divided by retention at the exact hook endpoint before PCA; missing tail positions are median-imputed.",
    }
    return outcomes, defs, curve_info, controls


def make_folds(title_vectors: np.ndarray) -> tuple[np.ndarray, list[tuple[np.ndarray, np.ndarray]], dict]:
    n = len(title_vectors)
    pca = PCA(n_components=min(32, n - 1), random_state=SEED).fit_transform(title_vectors)
    n_groups = max(10, min(20, n // 9))
    groups = KMeans(n_clusters=n_groups, random_state=SEED, n_init=25).fit_predict(pca)
    folds = list(GroupKFold(n_splits=5).split(np.arange(n), groups=groups))
    sizes = {str(g): int((groups == g).sum()) for g in np.unique(groups)}
    return groups, folds, {"semanticClusters": n_groups, "clusterSizes": sizes, "folds": len(folds)}


def impute_scale(train: np.ndarray, test: np.ndarray) -> tuple[np.ndarray, np.ndarray, StandardScaler]:
    med = np.nanmedian(train, axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    train = np.where(np.isfinite(train), train, med)
    test = np.where(np.isfinite(test), test, med)
    scaler = StandardScaler().fit(train)
    return scaler.transform(train), scaler.transform(test), scaler


def crossfit_residual(y: np.ndarray, controls: np.ndarray, folds) -> tuple[np.ndarray, float]:
    y = np.asarray(y, float)
    pred = np.full(len(y), np.nan)
    for train_all, test_all in folds:
        train = train_all[np.isfinite(y[train_all])]
        test = test_all[np.isfinite(y[test_all])]
        if len(train) < 25 or not len(test):
            continue
        xtr, xte, _ = impute_scale(controls[train], controls[test])
        model = RidgeCV(alphas=np.logspace(-3, 3, 13)).fit(xtr, y[train])
        pred[test] = model.predict(xte)
    mask = np.isfinite(y) & np.isfinite(pred)
    residual = y - pred
    score = float(r2_score(y[mask], pred[mask])) if mask.sum() > 8 else float("nan")
    return residual, score


def representation_data(hook: np.ndarray, title: np.ndarray) -> dict[str, np.ndarray]:
    dot = np.sum(hook * title, axis=1, keepdims=True)
    orthogonal = hook - dot * title
    return {
        "hook": normalize_rows(hook),
        "title": normalize_rows(title),
        "promise_delta": normalize_rows(hook - title),
        "hook_beyond_title": normalize_rows(orthogonal),
    }


def fit_one_model(model_name: str, original: np.ndarray, features: np.ndarray, y: np.ndarray, folds, pca):
    algorithm = "prototype" if model_name == "prototype" else "ridge" if model_name in ("ridge_axis", "title_corpus_ridge") else "pls"
    pred = np.full(len(y), np.nan)
    fold_rhos = []
    for train_all, test_all in folds:
        train = train_all[np.isfinite(y[train_all])]
        test = test_all[np.isfinite(y[test_all])]
        if len(train) < 30 or len(test) < 3:
            continue
        if algorithm == "prototype":
            lo, hi = np.percentile(y[train], [25, 75])
            axis = original[train][y[train] >= hi].mean(0) - original[train][y[train] <= lo].mean(0)
            axis /= np.linalg.norm(axis) + 1e-9
            train_axis = original[train] @ axis
            calibration = Ridge(alpha=1e-6).fit(train_axis.reshape(-1, 1), y[train])
            pred[test] = calibration.predict((original[test] @ axis).reshape(-1, 1))
        else:
            xtr, xte, _ = impute_scale(features[train], features[test])
            if algorithm == "ridge":
                model = RidgeCV(alphas=np.logspace(-3, 3, 13)).fit(xtr, y[train])
            elif algorithm == "pls":
                model = PLSRegression(n_components=min(4, xtr.shape[1], len(train) - 1), scale=False, max_iter=1000).fit(xtr, y[train])
            else:
                raise ValueError(model_name)
            pred[test] = np.asarray(model.predict(xte)).reshape(-1)
        if len(test) >= 5 and np.nanstd(pred[test]) > 1e-9:
            fold_rho = float(spearmanr(y[test], pred[test]).statistic)
            if finite(fold_rho):
                fold_rhos.append(fold_rho)

    mask = np.isfinite(y) & np.isfinite(pred)
    if mask.sum() < 40 or np.nanstd(pred[mask]) < 1e-9:
        return None

    if algorithm == "prototype":
        lo, hi = np.percentile(y[mask], [25, 75])
        axis = original[mask][y[mask] >= hi].mean(0) - original[mask][y[mask] <= lo].mean(0)
        axis /= np.linalg.norm(axis) + 1e-9
        train_axis = original[mask] @ axis
        calibration = Ridge(alpha=1e-6).fit(train_axis.reshape(-1, 1), y[mask])
        full = calibration.predict((original @ axis).reshape(-1, 1))
    else:
        xfull, _, scaler = impute_scale(features[mask], features)
        xall = scaler.transform(np.where(np.isfinite(features), features, np.nanmedian(features[mask], axis=0)))
        if algorithm == "ridge":
            model = RidgeCV(alphas=np.logspace(-3, 3, 13)).fit(xfull, y[mask])
            coef_pc = np.asarray(model.coef_).reshape(-1) / (scaler.scale_ + 1e-9)
        else:
            model = PLSRegression(n_components=min(4, xfull.shape[1], mask.sum() - 1), scale=False, max_iter=1000).fit(xfull, y[mask])
            coef_pc = np.asarray(model.coef_).reshape(-1) / (scaler.scale_ + 1e-9)
        full = np.asarray(model.predict(xall)).reshape(-1)
        axis = pca.components_.T @ coef_pc
        axis /= np.linalg.norm(axis) + 1e-9

    first = pca.components_[0].copy()
    second_axis = first - axis * float(first @ axis)
    if np.linalg.norm(second_axis) < 1e-6 and len(pca.components_) > 1:
        first = pca.components_[1].copy()
        second_axis = first - axis * float(first @ axis)
    second_axis /= np.linalg.norm(second_axis) + 1e-9
    y2 = original @ second_axis
    rho_result = spearmanr(y[mask], pred[mask])
    rho = float(rho_result.statistic)
    p = float(rho_result.pvalue)
    return {
        "pred": pred,
        "full": full,
        "y2": y2,
        "axis": axis,
        "mask": mask,
        "rho": rho,
        "p": p,
        "r2": float(r2_score(y[mask], pred[mask])),
        "nmae": float(mean_absolute_error(y[mask], pred[mask]) / (np.std(y[mask]) + 1e-9)),
        "fold_rhos": fold_rhos,
    }


def cluster_bootstrap_ci(y, pred, groups, iterations=300) -> list[float | None]:
    mask = np.isfinite(y) & np.isfinite(pred)
    unique = np.unique(groups[mask])
    if len(unique) < 4:
        return [None, None]
    rng = np.random.default_rng(SEED + 41)
    values = []
    for _ in range(iterations):
        chosen = rng.choice(unique, size=len(unique), replace=True)
        idx = np.concatenate([np.where(mask & (groups == group))[0] for group in chosen])
        if len(idx) > 12 and np.std(pred[idx]) > 1e-9:
            values.append(float(spearmanr(y[idx], pred[idx]).statistic))
    if not values:
        return [None, None]
    return [round(float(np.percentile(values, 2.5)), 3), round(float(np.percentile(values, 97.5)), 3)]


def lexical_probes(text: str) -> dict[str, float]:
    text = str(text or "").lower()
    words = re.findall(r"[a-z0-9']+", text)
    joined = " " + " ".join(words) + " "
    patterns = {
        "explicit_question": ["?", " can ", " will ", " does ", " is it ", " what happens ", " how "],
        "test_or_attempt": [" test", " try", "attempt", "see if", "wanted to see"],
        "measurable_goal": ["record", "hours", "days", "steps", "$", "world's", "most ", "fastest", "largest", "hardest"],
        "transformation": ["become", "turn into", "make me", "learn", "master", "professional", "superhuman"],
        "stakes_or_risk": ["survive", "danger", "pain", "destroy", "dead", "kill", "lost", "terrified", "powerful"],
        "social_outcome": ["impress", "friend", "sister", "beat", "win", "people", "undercover", "job"],
        "constraint": ["without", "only", "no ", "using", "in a day", "blind", "randomly"],
        "result_pointer": ["to see", "what happens", "this happens", "did this", "actually", "but can", "ended up"],
        "unresolved_turn": ["but ", "problem", "mistake", "however", "until", "unless"],
        "object_claim": ["claims", "apparently", "viral", "secret", "world's", "supposed to"],
    }
    out = {name: float(any(token in joined or token in text for token in tokens)) for name, tokens in patterns.items()}
    out["word_count"] = float(len(words))
    out["number_count"] = float(sum(bool(re.search(r"\d", word)) for word in words))
    return out


def metric_percentile(metric) -> float:
    if isinstance(metric, dict):
        value = metric.get("pctile")
    else:
        value = metric
    value = safe_float(value)
    if finite(value) and value <= 1.0:
        value *= 100.0
    return value


def build_study(rows: list[dict], hook: np.ndarray, title: np.ndarray, embed_manifest: dict, title_basis: TitleCorpusBasis, permutations=60) -> dict:
    n = len(rows)
    outcomes, target_defs, curve_info, controls = build_outcomes(rows)
    groups, folds, fold_meta = make_folds(title)
    reps = representation_data(hook, title)
    rep_pca = {}
    rep_features = {}
    corpus_features = {}
    for name, values in reps.items():
        pca = PCA(n_components=min(56, n - 5, values.shape[1]), random_state=SEED).fit(values)
        rep_pca[name] = pca
        rep_features[name] = pca.transform(values)
        corpus_features[name] = title_basis.transform(values)

    def model_inputs(rep_name: str, model_name: str):
        if model_name == "title_corpus_ridge":
            return corpus_features[rep_name], title_basis
        return rep_features[rep_name], rep_pca[rep_name]

    embed_manifest = {
        **embed_manifest,
        "titleCorpusVectors": title_basis.n_titles,
        "titleCorpusBasisDimensions": int(title_basis.components_.shape[0]),
        "titleCorpusBasisKey": BASIS_KEY,
        "titleCorpusSourceVersion": title_basis.source_etag[:16],
        "titleCorpusExplainedVariance": round(float(np.sum(title_basis.explained_variance_ratio_)), 4),
    }

    scalar_names = ["log_duration", "hook_seconds", "hook_pct", "word_count", "speech_rate", "start_retention", "age_days"]
    scalar_controls = np.asarray([[safe_float(row.get(k)) for k in scalar_names] for row in controls], float)
    title_pc = PCA(n_components=min(18, n - 5), random_state=SEED).fit_transform(title)
    full_controls = np.column_stack([scalar_controls, np.asarray([safe_float(r.get("keep")) for r in controls]), title_pc])
    adjustment_defs = {
        "raw": "No outcome controls. Use this to see the observed relationship, not to claim isolation.",
        "timing": "Outcome residual after out-of-fold control for hook length, word count, speech rate, video length, start retention, and age.",
        "idea_visual": "Timing controls plus keep rate (except when keep is the target) and 18 title-embedding PCs, removing much of opening visual/distribution and base-idea variation.",
    }
    adjusted: dict[str, dict[str, np.ndarray]] = {}
    adjustment_r2: dict[str, dict[str, float | None]] = {}
    for target in target_defs:
        y = outcomes[target.id]
        timing, timing_r2 = crossfit_residual(y, scalar_controls, folds)
        # Keep is an entry/visual control for other outcomes, but never control
        # keep with itself when keep is the target.
        target_controls = np.column_stack([scalar_controls, title_pc]) if target.id == "keep" else full_controls
        full, full_r2 = crossfit_residual(y, target_controls, folds)
        adjusted[target.id] = {"raw": y, "timing": timing, "idea_visual": full}
        adjustment_r2[target.id] = {
            "timing": round_or_none(timing_r2, 3),
            "idea_visual": round_or_none(full_r2, 3),
        }

    experiments = []
    model_names = ["ridge_axis", "title_corpus_ridge", "prototype", "pls_axis"]
    for rep_name, original in reps.items():
        for target in target_defs:
            for adjustment in adjustment_defs:
                y = adjusted[target.id][adjustment]
                for model_name in model_names:
                    features, basis = model_inputs(rep_name, model_name)
                    fit = fit_one_model(model_name, original, features, y, folds, basis)
                    if not fit:
                        continue
                    fold_rhos = fit["fold_rhos"]
                    sign_stability = float(np.mean(np.asarray(fold_rhos) > 0)) if fold_rhos else 0.0
                    evidence = max(0.0, fit["rho"]) * (0.5 + 0.5 * sign_stability)
                    exp_id = f"{target.id}__{rep_name}__{adjustment}__{model_name}"
                    experiments.append({
                        "id": exp_id,
                        "target": target.id,
                        "family": target.family,
                        "representation": rep_name,
                        "adjustment": adjustment,
                        "model": model_name,
                        "n": int(fit["mask"].sum()),
                        "rho": round(fit["rho"], 4),
                        "r2": round(fit["r2"], 4),
                        "normalizedMae": round(fit["nmae"], 4),
                        "p": fit["p"],
                        "foldRhos": [round(float(x), 3) for x in fold_rhos],
                        "signStability": round(sign_stability, 3),
                        "evidence": round(evidence, 4),
                        "_y": y,
                        "_fit": fit,
                    })

    qvalues = bh_qvalues([exp["p"] for exp in experiments])
    for exp, qvalue in zip(experiments, qvalues):
        exp["q"] = qvalue
    experiments.sort(key=lambda exp: (exp["evidence"], exp["rho"]), reverse=True)

    candidate_pool = [
        exp for exp in experiments
        if exp["family"] in ("candidate", "hook-aligned", "discovered")
        and exp["representation"] in ("promise_delta", "hook_beyond_title")
        and exp["adjustment"] in ("timing", "idea_visual")
        and exp["model"] in ("ridge_axis", "title_corpus_ridge", "prototype")
    ]
    default = max(candidate_pool or experiments, key=lambda exp: (exp["evidence"], exp["rho"]))

    bootstrap_candidates = list(experiments[:60])
    if default not in bootstrap_candidates:
        bootstrap_candidates.append(default)
    for exp in bootstrap_candidates:
        fit = exp["_fit"]
        exp["clusterBootstrap95"] = cluster_bootstrap_ci(exp["_y"], fit["pred"], groups)

    # Audit both the strongest observed directions and the strongest isolated
    # title-residual candidates. Raw hook experiments cannot crowd the actual
    # RTG hypothesis out of the expensive permutation test.
    perm_candidates = []
    seen = set()
    for pool, cap in ((experiments, 5), (candidate_pool, 5)):
        added = 0
        for exp in pool:
            key = (exp["target"], exp["representation"], exp["adjustment"])
            if key in seen or exp["model"] == "pls_axis":
                continue
            seen.add(key)
            perm_candidates.append(exp)
            added += 1
            if added >= cap:
                break
    if default not in perm_candidates:
        perm_candidates.append(default)
    rng = np.random.default_rng(SEED + 99)
    for ci, exp in enumerate(perm_candidates):
        observed = exp["rho"]
        null = []
        finite_mask = np.isfinite(exp["_y"])
        finite_values = exp["_y"][finite_mask].copy()
        for _ in range(max(0, permutations)):
            perm_y = exp["_y"].copy()
            perm_y[finite_mask] = rng.permutation(finite_values)
            features, basis = model_inputs(exp["representation"], exp["model"])
            fit = fit_one_model(
                exp["model"], reps[exp["representation"]], features,
                perm_y, folds, basis,
            )
            if fit:
                null.append(fit["rho"])
        exp["permutationP"] = round((1 + sum(value >= observed for value in null)) / (1 + len(null)), 4) if null else None
        exp["permutations"] = len(null)
        print(f"permutation {ci + 1}/{len(perm_candidates)} {exp['id']} p={exp['permutationP']}", flush=True)

    # The default axis was selected after searching the entire isolated-candidate
    # family. This max-statistic null repeats that search and reports how often a
    # shuffled dataset produces a candidate at least as strong as the winner.
    family_runs = min(39, max(0, permutations))
    family_null = []
    for run in range(family_runs):
        order = rng.permutation(n)
        best_null = -1.0
        for exp in candidate_pool:
            perm_y = exp["_y"][order]
            features, basis = model_inputs(exp["representation"], exp["model"])
            fit = fit_one_model(
                exp["model"], reps[exp["representation"]], features,
                perm_y, folds, basis,
            )
            if fit and finite(fit["rho"]):
                best_null = max(best_null, float(fit["rho"]))
        if best_null >= 0:
            family_null.append(best_null)
        print(f"family permutation {run + 1}/{family_runs} max-rho={best_null:.3f}", flush=True)
    default["selectionFamilySize"] = len(candidate_pool)
    default["familyPermutations"] = len(family_null)
    default["familyPermutationP"] = round(
        (1 + sum(value >= default["rho"] for value in family_null)) / (1 + len(family_null)), 4
    ) if family_null else None

    # Scalar screens: existing Long Quant text placements and transparent language probes.
    scalar_values: dict[str, np.ndarray] = {}
    metric_keys = ["ctrviews", "ctr", "ret30", "views", "realviews", "gt10m", "scaled_views"]
    for metric in metric_keys:
        scalar_values[f"longquant_{metric}"] = np.asarray([metric_percentile((row.get("metrics") or {}).get(metric)) for row in rows], float)
    lexical = [lexical_probes(row.get("hookText") or "") for row in rows]
    for key in sorted({k for item in lexical for k in item}):
        scalar_values[f"language_{key}"] = np.asarray([item.get(key, np.nan) for item in lexical], float)
    scalar_tests = []
    for scalar_name, values in scalar_values.items():
        for target in target_defs:
            y = outcomes[target.id]
            mask = np.isfinite(values) & np.isfinite(y)
            if mask.sum() < 30 or np.std(values[mask]) < 1e-9:
                continue
            result = spearmanr(values[mask], y[mask])
            scalar_tests.append({
                "probe": scalar_name,
                "target": target.id,
                "n": int(mask.sum()),
                "rho": round(float(result.statistic), 4),
                "p": float(result.pvalue),
            })
    scalar_q = bh_qvalues([item["p"] for item in scalar_tests])
    for item, qvalue in zip(scalar_tests, scalar_q):
        item["q"] = qvalue
    scalar_tests.sort(key=lambda item: abs(item["rho"]), reverse=True)

    # Approximate matched comparisons: nearest neighbor in the title anchor space.
    title_sim = title @ title.T
    np.fill_diagonal(title_sim, -np.inf)
    pairs = []
    used = set()
    for i in np.argsort(-np.max(title_sim, axis=1)):
        j = int(np.argmax(title_sim[i]))
        pair_key = tuple(sorted((int(i), j)))
        if pair_key in used:
            continue
        used.add(pair_key)
        pairs.append({
            "a": int(i), "b": j, "titleCosine": round(float(title_sim[i, j]), 4),
            "consensusDelta": round_or_none(outcomes["hold_consensus"][i] - outcomes["hold_consensus"][j], 3),
            "postHold10Delta": round_or_none(outcomes["post_hold_10"][i] - outcomes["post_hold_10"][j], 3),
            "viewsLogDelta": round_or_none(outcomes["log_views"][i] - outcomes["log_views"][j], 3),
        })
        if len(pairs) >= 90:
            break

    # Confound audit is descriptive and kept separate from the supervised axes.
    confound_tests = []
    for cidx, name in enumerate(scalar_names + ["keep"]):
        values = full_controls[:, cidx if name != "keep" else len(scalar_names)]
        for target in target_defs:
            y = outcomes[target.id]
            mask = np.isfinite(values) & np.isfinite(y)
            if mask.sum() < 30 or np.std(values[mask]) < 1e-9:
                continue
            result = spearmanr(values[mask], y[mask])
            confound_tests.append({"confound": name, "target": target.id, "rho": round(float(result.statistic), 3), "p": float(result.pvalue), "n": int(mask.sum())})
    confound_q = bh_qvalues([item["p"] for item in confound_tests])
    for item, qvalue in zip(confound_tests, confound_q):
        item["q"] = qvalue

    videos = []
    default_scores = default["_fit"]["full"]
    axis_rank = np.argsort(np.argsort(default_scores)) / max(1, n - 1) * 100
    for i, row in enumerate(rows):
        values = {key: round_or_none(array[i], 4) for key, array in outcomes.items()}
        metrics = {key: round_or_none(scalar_values[f"longquant_{key}"][i], 2) for key in metric_keys}
        videos.append({
            "index": i,
            "id": row.get("id"),
            "title": row.get("title"),
            "url": row.get("url"),
            "published": row.get("published"),
            "views": row.get("views"),
            "keep": round_or_none(row.get("keep_rate"), 2),
            "duration": round_or_none(row.get("duration_s"), 2),
            "hookText": row.get("hookText"),
            "hookEndSec": round_or_none(row.get("hookEndSec"), 2),
            "hookWordCount": int(controls[i]["word_count"]),
            "curve": [round_or_none(x, 4) for x in row.get("curve", [])],
            "values": values,
            "longQuantText": metrics,
            "languageProbes": lexical[i],
            "defaultAxisPercentile": round(float(axis_rank[i]), 1),
        })

    public_experiments = []
    for exp in experiments:
        fit = exp.pop("_fit")
        y = exp.pop("_y")
        public = dict(exp)
        public["p"] = round_or_none(public.get("p"), 7)
        public["q"] = round_or_none(public.get("q"), 7)
        public["plot"] = {
            "x": [round_or_none(x, 3) for x in scale_0_100(fit["full"])],
            "y": [round_or_none(x, 3) for x in scale_0_100(fit["y2"])],
            "oof": [round_or_none(x, 4) for x in fit["pred"]],
            "actual": [round_or_none(x, 4) for x in y],
        }
        public_experiments.append(public)

    target_json = []
    for target in target_defs:
        values = outcomes[target.id]
        target_json.append({
            "id": target.id, "label": target.label, "family": target.family,
            "description": target.description, "unit": target.unit,
            "n": int(np.isfinite(values).sum()),
            "median": round_or_none(np.nanmedian(values), 3),
            "q10": round_or_none(percentile(values, 10), 3),
            "q90": round_or_none(percentile(values, 90), 3),
            "controlR2": adjustment_r2[target.id],
        })

    default_public = next(exp for exp in public_experiments if exp["id"] == default["id"])
    strength = "no stable evidence yet"
    if default_public["rho"] >= 0.25 and default_public.get("clusterBootstrap95", [None])[0] is not None and default_public["clusterBootstrap95"][0] > 0:
        strength = "promising held-out direction"
    if default_public.get("permutationP") is not None and default_public["permutationP"] <= 0.05:
        strength = "axis-wise permutation signal; cluster-unstable"
    if (default_public.get("familyPermutationP") is not None and default_public["familyPermutationP"] <= 0.05
            and default_public.get("clusterBootstrap95", [None])[0] is not None
            and default_public["clusterBootstrap95"][0] > 0):
        strength = "search-corrected, cluster-stable candidate direction"

    report = {
        "meta": {
            "version": 1,
            "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "n": n,
            "source": INDEX_KEY,
            "reportKey": REPORT_KEY,
            "experimentCount": len(public_experiments),
            "scalarProbeCount": len(scalar_tests),
            "status": "complete",
            "candidateStrength": strength,
            "defaultExperimentId": default["id"],
        },
        "embedding": embed_manifest,
        "validation": {
            **fold_meta,
            "outerSplit": "5-fold leave-semantic-clusters-out",
            "axisScoring": "Every reported rho/R2 uses out-of-fold predictions; full-data axes are used only to draw the map.",
            "multipleTesting": "Benjamini-Hochberg q values across every embedding experiment; top distinct candidates retrain under permutation, and the selected isolated candidate also gets a max-statistic search correction across its full candidate family.",
            "bootstrap": "95% intervals resample semantic title clusters, not individual videos.",
        },
        "methodology": {
            "definition": "Reference to gratification remains an unknown construct. This tab searches for repeatable promise-related text directions without assigning ground-truth RTG labels.",
            "representations": {
                "hook": "Exact spoken hook embedded as text only in Long Quant's title space.",
                "title": "Published Shorts title embedded in the same text space; a noisy base-idea control.",
                "promise_delta": "Normalized hook vector minus normalized title vector; asks what the spoken promise adds beyond its title anchor.",
                "hook_beyond_title": "Hook component orthogonal to that video's title vector; a stricter but imperfect idea-removal view.",
            },
            "adjustments": adjustment_defs,
            "models": {
                "ridge_axis": "Regularized linear rotation over 56 PCs learned only from the 208 hook/title records.",
                "title_corpus_ridge": "Regularized linear rotation over 64 global PCs fit incrementally across every Long Quant title embedding.",
                "prototype": "Cosine direction from the bottom outcome quartile centroid to the top quartile centroid.",
                "pls_axis": "Four-component partial-least-squares rotation, validated on held-out semantic clusters.",
            },
            "hardLimits": [
                "Observational outcomes cannot prove the hook wording caused retention.",
                "The published title is a noisy proxy for the underlying idea, so both raw and residual views must be inspected.",
                "Early and delayed gratifications can create different retention shapes; no single retention target is privileged.",
                "Views and Viewed-vs-Swiped are diagnostic outcomes, not direct RTG labels.",
            ],
        },
        "curveShapes": curve_info,
        "targets": target_json,
        "experiments": public_experiments,
        "scalarProbes": scalar_tests,
        "confoundAudit": confound_tests,
        "pairs": pairs,
        "videos": videos,
    }
    return report


def self_test() -> None:
    rng = np.random.default_rng(SEED)
    n, dim = 90, 64
    title = normalize_rows(rng.normal(size=(n, dim)))
    true_axis = rng.normal(size=dim)
    true_axis /= np.linalg.norm(true_axis)
    hook = normalize_rows(title + 0.4 * rng.normal(size=(n, dim)) + np.outer(np.linspace(-1, 1, n), true_axis))
    y = hook @ true_axis + rng.normal(scale=0.08, size=n)
    groups, folds, meta = make_folds(np.pad(title, ((0, 0), (0, DIM - dim))))
    pca = PCA(n_components=30, random_state=SEED).fit(hook)
    fit = fit_one_model("ridge_axis", hook, pca.transform(hook), y, folds, pca)
    assert fit and fit["rho"] > 0.55, fit
    q = bh_qvalues([0.01, 0.04, 0.8, np.nan])
    assert q[0] <= q[1] and q[3] is None
    fake = {"curve": np.linspace(1.3, 0.7, 100).tolist(), "duration_s": 50}
    assert 95 < ret_at(fake, 25) < 105
    assert meta["folds"] == 5 and len(groups) == n
    print(json.dumps({"ok": True, "rho": round(fit["rho"], 3), "q": q}))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--force-embeddings", action="store_true")
    parser.add_argument("--force-basis", action="store_true")
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--permutations", type=int, default=60)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    store = Store()
    index, rows = load_records(store)
    print(f"loaded {len(rows)} complete hook records (index has {len(index.get('rows', []))})", flush=True)
    hook, title, manifest = ensure_embeddings(store, rows, args.force_embeddings, args.workers)
    title_basis = ensure_title_corpus_basis(store, args.force_basis)
    report = build_study(rows, hook, title, manifest, title_basis, max(0, args.permutations))
    payload = json.dumps(report, separators=(",", ":"), allow_nan=False).encode("utf-8")
    LOCAL_REPORT.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_REPORT.write_bytes(payload)
    if not args.no_upload:
        store.put(REPORT_KEY, payload, "application/json")
    print(json.dumps({
        "ok": True,
        "n": report["meta"]["n"],
        "experiments": report["meta"]["experimentCount"],
        "bytes": len(payload),
        "default": report["meta"]["defaultExperimentId"],
        "strength": report["meta"]["candidateStrength"],
        "uploaded": not args.no_upload,
    }))


if __name__ == "__main__":
    main()
