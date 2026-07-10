"""Content-addressed batch embedding cache for RTG component texts."""

from __future__ import annotations

import concurrent.futures
import hashlib
import io
import os
import sqlite3
import time
from pathlib import Path
from typing import Iterable

import numpy as np
import requests

from build_study import DIM, MODEL, Store, env, normalize_rows


HERE = Path(__file__).resolve().parent
LOCAL_SQLITE = HERE / ".cache" / "component_embeddings_v2.sqlite3"
LOCAL_NPZ = HERE / ".cache" / "component_embeddings_v2.npz"
R2_KEY = "longform/gratification/v2/component_embeddings.npz"
BATCH_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:batchEmbedContents"


def normalize_text(text: str) -> str:
    return " ".join(str(text or "").split()).strip()


def text_key(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute(
        "CREATE TABLE IF NOT EXISTS embeddings ("
        "key TEXT PRIMARY KEY, text TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL)"
    )
    db.commit()
    return db


def _seed_sqlite_from_npz(db: sqlite3.Connection, path: Path) -> int:
    if not path.exists():
        return 0
    existing = int(db.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0])
    if existing:
        return existing
    try:
        payload = np.load(path, allow_pickle=False)
        keys = [str(value) for value in payload["keys"].tolist()]
        texts = [str(value) for value in payload["texts"].tolist()]
        vectors = np.asarray(payload["vecs"], np.float32)
        rows = [
            (key, texts[idx], MODEL, DIM, np.asarray(vectors[idx], np.float32).tobytes())
            for idx, key in enumerate(keys)
            if vectors[idx].size == DIM
        ]
        db.executemany("INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?,?)", rows)
        db.commit()
        return len(rows)
    except Exception:
        return 0


def download_cache(store: Store, target: Path = LOCAL_NPZ) -> bool:
    if target.exists():
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".download")
    try:
        store.s3.download_file(store.bucket, R2_KEY, str(temporary))
        temporary.replace(target)
        return True
    except Exception:
        temporary.unlink(missing_ok=True)
        return False


def embed_batch(texts: list[str], attempts=8) -> list[np.ndarray]:
    api_key = env("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not configured")
    requests_body = [
        {
            "model": f"models/{MODEL}",
            "content": {"parts": [{"text": text[:500]}]},
            "outputDimensionality": DIM,
        }
        for text in texts
    ]
    last_error = ""
    for attempt in range(attempts):
        try:
            response = requests.post(
                BATCH_URL,
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
                json={"requests": requests_body},
                timeout=90,
            )
            if response.ok:
                embeddings = response.json().get("embeddings") or []
                vectors = [np.asarray(item.get("values") or [], np.float32) for item in embeddings]
                if len(vectors) != len(texts) or any(vector.size != DIM for vector in vectors):
                    raise RuntimeError(f"batch returned {len(vectors)} vectors with invalid dimensions")
                return vectors
            last_error = f"HTTP {response.status_code}: {response.text[:240]}"
            if response.status_code not in (429, 500, 502, 503, 504):
                break
        except Exception as exc:
            last_error = str(exc)
        time.sleep(min(45.0, 1.5 * (attempt + 1) ** 1.7))
    raise RuntimeError("Gemini batch embedding failed: " + last_error)


def export_npz(db: sqlite3.Connection, wanted: dict[str, str], target: Path = LOCAL_NPZ) -> Path:
    keys = sorted(wanted)
    rows = {}
    for start in range(0, len(keys), 900):
        batch = keys[start:start + 900]
        placeholders = ",".join("?" for _ in batch)
        for key, text, vec in db.execute(
            f"SELECT key,text,vec FROM embeddings WHERE key IN ({placeholders})", batch
        ):
            rows[str(key)] = (str(text), np.frombuffer(vec, np.float32).copy())
    missing = [key for key in keys if key not in rows]
    if missing:
        raise RuntimeError(f"cannot export component cache; {len(missing)} vectors are missing")
    vectors = normalize_rows(np.stack([rows[key][1] for key in keys]).astype(np.float32))
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp.npz")
    np.savez_compressed(
        temporary,
        keys=np.asarray(keys),
        texts=np.asarray([wanted[key] for key in keys]),
        vecs=vectors,
        model=np.asarray([MODEL]),
        dimensions=np.asarray([DIM], np.int32),
    )
    temporary.replace(target)
    return target


def upload_cache(store: Store, path: Path = LOCAL_NPZ) -> None:
    store.s3.upload_file(
        str(path),
        store.bucket,
        R2_KEY,
        ExtraArgs={"ContentType": "application/octet-stream"},
    )


def ensure_component_embeddings(
    store: Store,
    texts: Iterable[str],
    workers=4,
    batch_size=40,
    publish=True,
) -> tuple[dict[str, np.ndarray], dict]:
    wanted = {text_key(text): normalize_text(text) for text in texts if normalize_text(text)}
    download_cache(store)
    db = _connect(LOCAL_SQLITE)
    seeded = _seed_sqlite_from_npz(db, LOCAL_NPZ)
    existing = {str(row[0]) for row in db.execute("SELECT key FROM embeddings")}
    missing = [(key, text) for key, text in wanted.items() if key not in existing]
    print(
        f"component embeddings: {len(wanted):,} unique texts, {len(missing):,} missing, {seeded:,} seeded",
        flush=True,
    )

    chunks = [missing[start:start + batch_size] for start in range(0, len(missing), batch_size)]
    completed = 0
    if chunks:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = {
                pool.submit(embed_batch, [text for _, text in chunk]): chunk
                for chunk in chunks
            }
            for future in concurrent.futures.as_completed(futures):
                chunk = futures[future]
                vectors = future.result()
                db.executemany(
                    "INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?,?)",
                    [
                        (key, text, MODEL, DIM, np.asarray(vector, np.float32).tobytes())
                        for (key, text), vector in zip(chunk, vectors)
                    ],
                )
                db.commit()
                completed += len(chunk)
                if completed == len(missing) or completed % max(batch_size, 400) < batch_size:
                    print(f"  embedded {completed:,}/{len(missing):,}", flush=True)

    if not missing and LOCAL_NPZ.exists():
        path = LOCAL_NPZ
    else:
        path = export_npz(db, wanted)
        if publish:
            upload_cache(store, path)
    rows = {}
    payload = np.load(path, allow_pickle=False)
    keys = [str(value) for value in payload["keys"].tolist()]
    vectors = np.asarray(payload["vecs"], np.float32)
    for idx, key in enumerate(keys):
        rows[key] = vectors[idx]
    db.close()
    return rows, {
        "model": MODEL,
        "dimensions": DIM,
        "uniqueTexts": len(wanted),
        "newlyEmbedded": len(missing),
        "localCache": str(path),
        "r2Key": R2_KEY,
        "batchSize": batch_size,
        "workers": workers,
        "contentAddressed": True,
    }
