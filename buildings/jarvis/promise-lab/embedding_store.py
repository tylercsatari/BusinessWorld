"""Exact Gemini batch transport and a resumable local vector cache."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
import numpy as np
import requests


MODEL = "gemini-embedding-2"
DIMENSIONS = 1536
API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
R2_PREFIX = "shorts/promise-lab-v1"

_EMBED_RATE_LOCK = threading.Lock()
_EMBED_NEXT_SLOT = 0.0
_EMBED_BLOCKED_UNTIL = 0.0


def _duration_seconds(value) -> float | None:
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*([sm]?)", str(value or ""), re.I)
    if not match:
        return None
    amount = float(match.group(1))
    return amount * (60.0 if match.group(2).lower() == "m" else 1.0)


def _retry_delay_seconds(response, attempt: int) -> float:
    header = _duration_seconds((getattr(response, "headers", {}) or {}).get("retry-after"))
    if header is not None:
        return max(0.25, header)
    try:
        payload = response.json()
    except Exception:
        payload = {}
    details = ((payload.get("error") or {}).get("details") or []) if isinstance(payload, dict) else []
    for detail in details:
        if isinstance(detail, dict) and detail.get("retryDelay") is not None:
            parsed = _duration_seconds(detail.get("retryDelay"))
            if parsed is not None:
                return max(0.25, parsed)
    message = str(((payload.get("error") or {}).get("message") or "") if isinstance(payload, dict) else "")
    match = re.search(r"retry\s+in\s+([0-9]+(?:\.[0-9]+)?)\s*s", message, re.I)
    if match:
        return max(0.25, float(match.group(1)))
    return min(60.0, 1.5 * (2 ** max(0, int(attempt))))


def _wait_for_embedding_quota(request_count: int) -> None:
    """Serialize content requests below the project RPM instead of bursting into 429s."""
    global _EMBED_NEXT_SLOT
    rpm = max(1.0, float(os.environ.get("PROMISE_LAB_EMBED_RPM", "4500")))
    spacing = 60.0 * max(1, int(request_count)) / rpm
    while True:
        with _EMBED_RATE_LOCK:
            now = time.monotonic()
            ready = max(_EMBED_NEXT_SLOT, _EMBED_BLOCKED_UNTIL)
            if now >= ready:
                _EMBED_NEXT_SLOT = now + spacing
                return
            wait = ready - now
        time.sleep(wait)


def _defer_embedding_quota(seconds: float) -> None:
    global _EMBED_BLOCKED_UNTIL
    with _EMBED_RATE_LOCK:
        _EMBED_BLOCKED_UNTIL = max(
            _EMBED_BLOCKED_UNTIL,
            time.monotonic() + max(0.25, float(seconds)),
        )


def json_ready(value):
    if isinstance(value, dict):
        return {str(key): json_ready(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_ready(item) for item in value]
    if isinstance(value, np.ndarray):
        return json_ready(value.tolist())
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def load_env() -> dict[str, str]:
    values = dict(os.environ)
    path = project_root() / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return values


def vector_key(text: str, model: str = MODEL, dimensions: int = DIMENSIONS) -> str:
    return hashlib.sha256(f"{model}\0{dimensions}\0{text}".encode("utf-8")).hexdigest()


class EmbeddingStore:
    def __init__(self, path: str | Path, model: str = MODEL, dimensions: int = DIMENSIONS,
                 batch_size: int | None = None, workers: int | None = None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.model = model
        self.dimensions = int(dimensions)
        self.batch_size = int(batch_size or os.environ.get("PROMISE_LAB_BATCH_SIZE", "100"))
        self.workers = int(workers or os.environ.get("PROMISE_LAB_EMBED_WORKERS", "8"))
        self.env = load_env()
        self.api_key = self.env.get("GEMINI_API_KEY", "")
        self._lock = threading.Lock()
        self.db = sqlite3.connect(self.path, timeout=120, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("""
            CREATE TABLE IF NOT EXISTS vectors (
              key TEXT PRIMARY KEY,
              model TEXT NOT NULL,
              dimensions INTEGER NOT NULL,
              text TEXT NOT NULL,
              vector BLOB NOT NULL,
              created_at REAL NOT NULL
            )
        """)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def count(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM vectors").fetchone()[0])

    def delete_texts(self, texts: list[str]) -> None:
        keys = [vector_key(str(text), self.model, self.dimensions) for text in set(texts)]
        with self._lock:
            for offset in range(0, len(keys), 400):
                chunk = keys[offset:offset + 400]
                if not chunk:
                    continue
                placeholders = ",".join("?" for _ in chunk)
                self.db.execute(f"DELETE FROM vectors WHERE key IN ({placeholders})", chunk)
            self.db.commit()

    def clear_and_compact(self) -> None:
        with self._lock:
            self.db.execute("DELETE FROM vectors")
            self.db.commit()
            self.db.execute("VACUUM")

    def _cached(self, texts: list[str]) -> dict[str, np.ndarray]:
        keys = [vector_key(text, self.model, self.dimensions) for text in texts]
        found: dict[str, np.ndarray] = {}
        for offset in range(0, len(keys), 400):
            chunk = keys[offset:offset + 400]
            if not chunk:
                continue
            q = ",".join("?" for _ in chunk)
            rows = self.db.execute(f"SELECT key, text, vector FROM vectors WHERE key IN ({q})", chunk).fetchall()
            for _, text, blob in rows:
                vec = np.frombuffer(blob, dtype=np.float32).copy()
                if vec.size == self.dimensions:
                    found[text] = vec
        return found

    def _post_batch(self, texts: list[str]) -> list[np.ndarray]:
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY is not configured")
        url = f"{API_ROOT}/{self.model}:batchEmbedContents"
        body = {
            "requests": [
                {
                    "model": f"models/{self.model}",
                    "content": {"parts": [{"text": text}]},
                    "outputDimensionality": self.dimensions,
                }
                for text in texts
            ]
        }
        last_error = ""
        attempts = max(8, int(os.environ.get("PROMISE_LAB_EMBED_RETRIES", "48")))
        for attempt in range(attempts):
            _wait_for_embedding_quota(len(texts))
            try:
                response = requests.post(
                    url,
                    headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
                    json=body,
                    timeout=120,
                )
                if response.status_code == 200:
                    payload = response.json().get("embeddings") or []
                    vectors = [np.asarray(item.get("values") or [], np.float32) for item in payload]
                    if len(vectors) != len(texts) or any(vec.size != self.dimensions for vec in vectors):
                        raise RuntimeError("Gemini batch response shape did not match the request")
                    return vectors
                last_error = f"HTTP {response.status_code}: {response.text[:300]}"
                if response.status_code not in (408, 429, 500, 502, 503, 504):
                    break
                delay = _retry_delay_seconds(response, attempt)
                if response.status_code == 429:
                    _defer_embedding_quota(delay + 1.0)
                    continue
            except Exception as exc:
                last_error = str(exc)
                delay = min(60.0, 1.5 * (2 ** attempt))
            time.sleep(delay)
        raise RuntimeError(f"Gemini batch embedding failed: {last_error}")

    def _save(self, texts: list[str], vectors: list[np.ndarray]) -> None:
        now = time.time()
        rows = []
        for text, vector in zip(texts, vectors):
            arr = np.asarray(vector, np.float32)
            rows.append((vector_key(text, self.model, self.dimensions), self.model,
                         self.dimensions, text, arr.tobytes(), now))
        with self._lock:
            self.db.executemany(
                "INSERT OR REPLACE INTO vectors(key,model,dimensions,text,vector,created_at) VALUES(?,?,?,?,?,?)",
                rows,
            )
            self.db.commit()

    def embed_many(self, texts: list[str]) -> dict[str, np.ndarray]:
        ordered = list(dict.fromkeys(str(text) for text in texts if str(text) != ""))
        found = self._cached(ordered)
        missing = [text for text in ordered if text not in found]
        batches = [missing[i:i + self.batch_size] for i in range(0, len(missing), self.batch_size)]
        if batches:
            with ThreadPoolExecutor(max_workers=max(1, self.workers)) as pool:
                jobs = {pool.submit(self._post_batch, batch): batch for batch in batches}
                for job in as_completed(jobs):
                    batch = jobs[job]
                    vectors = job.result()
                    self._save(batch, vectors)
                    found.update(zip(batch, vectors))
        return found


class R2Store:
    def __init__(self):
        env = load_env()
        self.bucket = env.get("R2_BUCKET_NAME") or "business-world-videos"
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{env.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
            aws_access_key_id=env.get("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=env.get("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
        )

    def get_bytes(self, key: str) -> bytes | None:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except Exception:
            return None

    def get_json(self, key: str, default=None):
        payload = self.get_bytes(key)
        return json.loads(payload) if payload else default

    def put_bytes(self, key: str, payload: bytes, content_type: str,
                  content_encoding: str | None = None) -> None:
        request = {"Bucket": self.bucket, "Key": key, "Body": payload, "ContentType": content_type}
        if content_encoding:
            request["ContentEncoding"] = content_encoding
        self.client.put_object(**request)

    def put_json(self, key: str, value, gzip_payload: bool = False) -> None:
        raw = json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                         allow_nan=False).encode("utf-8")
        if gzip_payload:
            self.put_bytes(key, gzip.compress(raw, compresslevel=6), "application/json", "gzip")
        else:
            self.put_bytes(key, raw, "application/json")

    def put_npz(self, key: str, arrays: dict) -> None:
        bio = io.BytesIO()
        np.savez_compressed(bio, **arrays)
        self.put_bytes(key, bio.getvalue(), "application/octet-stream")

    def list_keys(self, prefix: str) -> list[str]:
        keys = []
        token = None
        while True:
            args = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                args["ContinuationToken"] = token
            response = self.client.list_objects_v2(**args)
            keys.extend(item["Key"] for item in response.get("Contents") or [])
            if not response.get("IsTruncated"):
                return keys
            token = response.get("NextContinuationToken")
