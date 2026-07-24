#!/usr/bin/env python3
"""Build the Shorts Hook Operations artifact from the durable saved-hook bank.

The extraction model never receives an outcome. Once the frozen descriptions
exist, every downstream operation is deterministic for the recorded corpus,
prompt, model, and random seed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import re
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import boto3
import numpy as np
import requests
from botocore.config import Config
from botocore.exceptions import ClientError
from scipy.stats import spearmanr, ttest_ind
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import adjusted_rand_score, r2_score, roc_auc_score, silhouette_score
from sklearn.model_selection import KFold
from sklearn.linear_model import RidgeCV


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PROMISE_LAB = ROOT / "buildings" / "jarvis" / "promise-lab"
sys.path.insert(0, str(PROMISE_LAB))
from embedding_store import EmbeddingStore  # noqa: E402


PRODUCT_VERSION = "shorts-hook-operations-v1"
R2_PREFIX = "shorts/operations-lab-v1"
STATUS_KEY = f"{R2_PREFIX}/status.json"
ARTIFACT_KEY = f"{R2_PREFIX}/artifact.json"
DESCRIPTION_PREFIX = f"{R2_PREFIX}/descriptions/"
VECTOR_PREFIX = f"{R2_PREFIX}/vectors/"
SOURCE_INDEX_KEY = "raw/saved-hooks/index.json"
SOURCE_PREFIX = "raw/saved-hooks/"
SEED = 20260724
VISION_MODEL = os.environ.get("OPERATIONS_VISION_MODEL", "gemini-2.5-flash")
VISION_MAX_OUTPUT_TOKENS = max(
    8192,
    int(os.environ.get("OPERATIONS_VISION_MAX_OUTPUT_TOKENS", "8192")),
)
EMBED_MODEL = "gemini-embedding-2"
EMBED_DIMENSIONS = int(os.environ.get("OPERATIONS_EMBED_DIMENSIONS", "1536"))
VISION_WORKERS = max(1, int(os.environ.get("OPERATIONS_VISION_WORKERS", "4")))
RETRY_SECONDS = max(15, int(os.environ.get("OPERATIONS_CREDIT_RETRY_SECONDS", "60")))
MAX_RETRIES = max(4, int(os.environ.get("OPERATIONS_REQUEST_RETRIES", "12")))
LOCAL_STATUS = HERE / "status.json"
LOCAL_LOG = HERE / "operations.log"
CACHE_DIR = HERE / ".cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
DESCRIPTIONS_COMPLETE_MARKER = CACHE_DIR / "descriptions-complete.json"


FEATURES = [
    {
        "key": "full_visual",
        "label": "Whole visual narrative",
        "definition": "The complete left-to-right account of what the five opening frames visibly communicate.",
        "source": "visual_description",
    },
    {
        "key": "action",
        "label": "Action",
        "definition": "The concrete physical actions occurring or being prepared.",
    },
    {
        "key": "subjects",
        "label": "Subjects",
        "definition": "Who or what acts, reacts, observes, or receives the action.",
    },
    {
        "key": "objects",
        "label": "Objects and tools",
        "definition": "The salient objects, materials, devices, props, and tools.",
    },
    {
        "key": "quantity_scale",
        "label": "Quantity and scale",
        "definition": "Counts, repetition, relative size, accumulation, and human-scale contrast.",
    },
    {
        "key": "setting",
        "label": "Setting",
        "definition": "The physical environment and situational context visible in the montage.",
    },
    {
        "key": "composition",
        "label": "Composition and camera",
        "definition": "Framing, distance, focal hierarchy, point of view, and subject placement.",
    },
    {
        "key": "motion_progression",
        "label": "Motion and progression",
        "definition": "How state, position, or activity changes across the five frames.",
    },
    {
        "key": "transformation",
        "label": "Transformation and causality",
        "definition": "Any visible before/after, construction, damage, reveal, or cause-and-effect chain.",
    },
    {
        "key": "stakes_risk",
        "label": "Stakes and risk",
        "definition": "Visible danger, fragility, cost, difficulty, constraint, or potential consequence.",
    },
    {
        "key": "curiosity_gap",
        "label": "Information gap",
        "definition": "What remains unresolved after the montage and what outcome the viewer lacks.",
    },
    {
        "key": "novelty_incongruity",
        "label": "Novelty and incongruity",
        "definition": "Unexpected combinations, abnormal scale, rule violations, or unusual use.",
    },
    {
        "key": "proof_result",
        "label": "Proof and result",
        "definition": "Visible evidence, measurement, demonstration, partial payoff, or result state.",
    },
    {
        "key": "emotion_reaction",
        "label": "Emotion and reaction",
        "definition": "Visible affect, facial response, body language, or implied viewer emotion.",
    },
    {
        "key": "clarity_load",
        "label": "Clarity and cognitive load",
        "definition": "How quickly the focal action can be parsed and what competes for attention.",
    },
    {
        "key": "on_screen_text",
        "label": "On-screen text",
        "definition": "Readable overlays, labels, counters, symbols, and their visual role.",
    },
    {
        "key": "hook_language",
        "label": "Hook language",
        "definition": "The durable saved hook text, analyzed independently of the image.",
        "source": "hook_text",
    },
    {
        "key": "combined_semantics",
        "label": "Visual + language semantics",
        "definition": "The frozen visual description and saved hook text embedded together without an outcome.",
        "source": "combined",
    },
]
FEATURE_BY_KEY = {item["key"]: item for item in FEATURES}
EXTRACTED_FEATURE_KEYS = [
    item["key"] for item in FEATURES
    if item["key"] not in {"full_visual", "hook_language", "combined_semantics"}
]
TARGETS = {
    "together_keep": {
        "label": "Combined keep estimate",
        "description": "Existing visual + text keep-rate estimate. This is not an observed YouTube swipe ratio.",
        "steer": "together_keep",
    },
    "visual_keep": {
        "label": "Visual keep estimate",
        "description": "Existing image-only keep-rate estimate.",
        "steer": "visual_keep",
    },
    "text_keep": {
        "label": "Text keep estimate",
        "description": "Existing saved-text-only keep-rate estimate.",
        "steer": "text_keep",
    },
}


def _prompt() -> str:
    feature_lines = "\n".join(
        f'    "{key}": "One to three sentences measuring: {FEATURE_BY_KEY[key]["definition"]}"'
        + ("," if index < len(EXTRACTED_FEATURE_KEYS) - 1 else "")
        for index, key in enumerate(EXTRACTED_FEATURE_KEYS)
    )
    return f"""
You are measuring a five-frame opening montage from a short-form video. Read the
frames from left to right. Describe only what is supported by the pixels. You do
not receive the title, transcript, channel, existing embeddings, keep estimates,
views, or any other outcome.

Separate observation from interpretation. If a property is absent or cannot be
determined, say "not visibly established" instead of inventing it. Refer to
people and objects generically unless their identity is visibly certain. Treat
the saved text as language evidence, never as proof that an unseen event occurs.

Return one JSON object with exactly:
{{
  "visual_description": "A concrete 140-240 word paragraph explaining the visible subjects, sequence, action, objects, scale, environment, camera, unresolved outcome, and how the five frames change.",
  "sequence": ["one factual sentence for frame 1", "... frame 5"],
  "features": {{
{feature_lines}
  }}
}}

Every feature value must be one to three complete, specific sentences. Keep the
feature keys exactly as supplied. Do not add markdown or additional keys.
""".strip()


PROMPT = _prompt()
PROMPT_HASH = hashlib.sha256(PROMPT.encode("utf-8")).hexdigest()


def load_env() -> dict[str, str]:
    values = dict(os.environ)
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return values


ENV = load_env()


def json_ready(value: Any) -> Any:
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


def canonical_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text


def stable_hash(value: Any) -> str:
    payload = json.dumps(json_ready(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class R2Store:
    def __init__(self):
        self.bucket = ENV.get("R2_BUCKET_NAME") or "business-world-videos"
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{ENV.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
            aws_access_key_id=ENV.get("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=ENV.get("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
            config=Config(
                connect_timeout=10,
                read_timeout=30,
                retries={"max_attempts": 4, "mode": "standard"},
                tcp_keepalive=True,
            ),
        )

    def get_bytes(self, key: str) -> bytes | None:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except ClientError as exc:
            status = (exc.response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
            code = (exc.response.get("Error") or {}).get("Code")
            if status == 404 or code in {"NoSuchKey", "NotFound"}:
                return None
            raise

    def get_json(self, key: str, default=None):
        payload = self.get_bytes(key)
        return json.loads(payload) if payload else default

    def put_bytes(self, key: str, payload: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=payload, ContentType=content_type)

    def put_json(self, key: str, value: Any) -> None:
        payload = json.dumps(
            json_ready(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.put_bytes(key, payload, "application/json")

    def list_objects(self, prefix: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        token = None
        while True:
            args: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                args["ContinuationToken"] = token
            response = self.client.list_objects_v2(**args)
            for item in response.get("Contents") or []:
                rows.append({
                    "key": item["Key"],
                    "size": int(item.get("Size") or 0),
                    "etag": str(item.get("ETag") or "").strip('"'),
                    "modified": item.get("LastModified").timestamp() if item.get("LastModified") else 0,
                })
            if not response.get("IsTruncated"):
                return rows
            token = response.get("NextContinuationToken")


R2 = R2Store()
STATUS_LOCK = threading.Lock()
STATUS_STATE: dict[str, Any] = {}
LAST_STATUS_WRITE = 0.0
STATUS_PENDING: dict[str, Any] | None = None
STATUS_UPLOAD_THREAD: threading.Thread | None = None


def _upload_status_loop() -> None:
    global STATUS_PENDING, STATUS_UPLOAD_THREAD
    while True:
        with STATUS_LOCK:
            snapshot = STATUS_PENDING
            STATUS_PENDING = None
            if snapshot is None:
                STATUS_UPLOAD_THREAD = None
                return
        try:
            R2.put_json(STATUS_KEY, snapshot)
        except Exception as exc:
            print(f"status upload failed: {exc}", flush=True)


def flush_status(timeout: float = 150.0) -> None:
    with STATUS_LOCK:
        thread = STATUS_UPLOAD_THREAD
    if thread and thread.is_alive():
        thread.join(timeout=max(0.0, timeout))


def emit_status(stage: str, force: bool = False, **updates) -> None:
    global LAST_STATUS_WRITE, STATUS_PENDING, STATUS_STATE, STATUS_UPLOAD_THREAD
    now = time.time()
    start_uploader = False
    with STATUS_LOCK:
        STATUS_STATE = {
            **STATUS_STATE,
            "version": 1,
            "productVersion": PRODUCT_VERSION,
            "stage": stage,
            "updatedAt": int(now * 1000),
            "workerPid": os.getpid(),
            "visionModel": VISION_MODEL,
            "embeddingModel": EMBED_MODEL,
            "embeddingDimensions": EMBED_DIMENSIONS,
            "promptHash": PROMPT_HASH,
            "seed": SEED,
            **updates,
        }
        if not force and now - LAST_STATUS_WRITE < 2.5:
            return
        LAST_STATUS_WRITE = now
        snapshot = json_ready(STATUS_STATE)
        LOCAL_STATUS.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        STATUS_PENDING = snapshot
        if STATUS_UPLOAD_THREAD is None or not STATUS_UPLOAD_THREAD.is_alive():
            STATUS_UPLOAD_THREAD = threading.Thread(
                target=_upload_status_loop,
                name="operations-status-uploader",
                daemon=True,
            )
            start_uploader = True
            thread = STATUS_UPLOAD_THREAD
    if start_uploader:
        thread.start()


def classify_provider_error(status: int, message: str) -> dict[str, Any]:
    safe = re.sub(r"(?i)(key=)[^&\s]+", r"\1[redacted]", str(message or ""))
    safe = safe.replace(ENV.get("GEMINI_API_KEY", "") or "\0", "[redacted]")
    low = safe.lower()
    credit_terms = (
        "quota", "billing", "credit", "resource_exhausted", "rate limit",
        "rate_limit", "insufficient", "payment",
    )
    kind = "credits_or_quota_exhausted" if (
        status in {402, 429} or (status == 403 and any(term in low for term in credit_terms))
    ) else "provider_error"
    return {
        "provider": "Gemini",
        "kind": kind,
        "httpStatus": int(status or 0),
        "message": safe[:500] or f"Gemini returned HTTP {status}",
        "retrySeconds": RETRY_SECONDS if kind == "credits_or_quota_exhausted" else None,
    }


def classify_provider_exception(message: str) -> dict[str, Any]:
    low = str(message or "").lower()
    status_match = re.search(r"\b(?:http(?: status)?\s*)?([45]\d\d)\b", low)
    status = int(status_match.group(1)) if status_match else 0
    if any(term in low for term in (
        "quota", "billing", "credit", "resource_exhausted", "rate limit",
        "rate_limit", "insufficient", "payment",
    )):
        status = status or 429
    return classify_provider_error(status or 503, message)


def parse_json_text(text: str) -> dict[str, Any]:
    value = str(text or "").strip()
    if value.startswith("```"):
        value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.I)
        value = re.sub(r"\s*```$", "", value)
    try:
        parsed = json.loads(value)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    start, end = value.find("{"), value.rfind("}")
    if start >= 0 and end > start:
        parsed = json.loads(value[start:end + 1])
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("Gemini did not return a JSON object")


def validate_description(payload: dict[str, Any]) -> dict[str, Any]:
    description = canonical_text(payload.get("visual_description"))
    sequence = [canonical_text(item) for item in payload.get("sequence") or []]
    features = payload.get("features") or {}
    if len(description.split()) < 60:
        raise ValueError("visual_description was too short")
    if len(sequence) != 5 or any(len(item.split()) < 3 for item in sequence):
        raise ValueError("sequence must contain five factual frame descriptions")
    clean_features = {}
    for key in EXTRACTED_FEATURE_KEYS:
        text = canonical_text(features.get(key))
        if len(text.split()) < 3:
            raise ValueError(f"feature {key} was missing or too short")
        clean_features[key] = text
    return {
        "visual_description": description,
        "sequence": sequence,
        "features": clean_features,
    }


class GeminiVisionClient:
    def __init__(self):
        self.api_key = ENV.get("GEMINI_API_KEY", "")
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY is not configured")
        self.url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{VISION_MODEL}:generateContent"
        )
        self._gate = threading.Condition()
        self._blocked_until = 0.0
        self._active_error: dict[str, Any] | None = None

    def _wait_gate(self) -> None:
        while True:
            with self._gate:
                wait = self._blocked_until - time.monotonic()
                if wait <= 0:
                    return
            time.sleep(min(wait, 1.0))

    def _block(self, error: dict[str, Any], seconds: float) -> None:
        with self._gate:
            self._active_error = error
            self._blocked_until = max(self._blocked_until, time.monotonic() + seconds)
        emit_status(
            "blocked",
            force=True,
            providerError=error,
            message=(
                "Gemini credits or quota are blocking description extraction. "
                "The current hook remains pending and will retry automatically."
            ),
        )

    def _clear_error(self) -> None:
        with self._gate:
            had_error = (
                self._active_error is not None
                and time.monotonic() >= self._blocked_until
            )
            if not had_error:
                return
            self._active_error = None
            self._blocked_until = 0.0
        emit_status(
            "describing",
            force=True,
            providerError=None,
            message="Gemini access restored; description extraction resumed on the same hook.",
        )

    def describe(self, image: bytes) -> dict[str, Any]:
        encoded = base64.b64encode(image).decode("ascii")
        body = {
            "contents": [{
                "parts": [
                    {"text": PROMPT},
                    {"inline_data": {"mime_type": "image/jpeg", "data": encoded}},
                ]
            }],
            "generationConfig": {
                "temperature": 0,
                "seed": SEED,
                "responseMimeType": "application/json",
                "maxOutputTokens": VISION_MAX_OUTPUT_TOKENS,
            },
        }
        last_error = ""
        attempt = 0
        while attempt < MAX_RETRIES:
            self._wait_gate()
            try:
                response = requests.post(
                    self.url,
                    headers={
                        "x-goog-api-key": self.api_key,
                        "Content-Type": "application/json",
                    },
                    json=body,
                    timeout=120,
                )
            except requests.RequestException as exc:
                last_error = str(exc)
                emit_status(
                    "degraded",
                    providerError={
                        "provider": "Gemini",
                        "kind": "network_error",
                        "httpStatus": 0,
                        "message": last_error[:500],
                        "retrySeconds": min(60, 2 ** attempt),
                    },
                    message="Gemini could not be reached; retrying the same montage.",
                )
                time.sleep(min(60, 2 ** attempt))
                attempt += 1
                continue
            if response.status_code == 200:
                finish_reason = ""
                try:
                    raw = response.json()
                    candidate = raw["candidates"][0]
                    finish_reason = str(candidate.get("finishReason") or "")
                    text = candidate["content"]["parts"][0]["text"]
                    result = validate_description(parse_json_text(text))
                    self._clear_error()
                    return result
                except Exception as exc:
                    truncated = finish_reason == "MAX_TOKENS"
                    last_error = (
                        f"Gemini output reached the {VISION_MAX_OUTPUT_TOKENS}-token ceiling"
                        if truncated else f"invalid Gemini JSON: {exc}"
                    )
                    emit_status(
                        "degraded",
                        providerError={
                            "provider": "Gemini",
                            "kind": "output_truncated" if truncated else "invalid_response",
                            "httpStatus": 200,
                            "message": last_error[:500],
                            "retrySeconds": min(30, 2 ** attempt),
                        },
                        message=(
                            "Gemini truncated a structured description; retrying the same montage."
                            if truncated else
                            "Gemini returned an invalid structured description; retrying the same montage."
                        ),
                    )
                    time.sleep(min(30, 2 ** attempt))
                    attempt += 1
                    continue
            error = classify_provider_error(response.status_code, response.text)
            last_error = error["message"]
            if error["kind"] == "credits_or_quota_exhausted":
                self._block(error, RETRY_SECONDS)
                continue
            if response.status_code in {408, 500, 502, 503, 504}:
                emit_status(
                    "degraded",
                    providerError=error,
                    message="Gemini returned a transient provider error; retrying the same hook.",
                )
                time.sleep(min(60, 2 ** attempt))
                attempt += 1
                continue
            raise RuntimeError(f"Gemini description failed: {last_error}")
        raise RuntimeError(f"Gemini description failed after retries: {last_error}")


def source_hash(row: dict[str, Any], image_etag: str) -> str:
    return stable_hash({
        "id": row["id"],
        "savedAt": row.get("savedAt"),
        "imageEtag": image_etag,
        "promptHash": PROMPT_HASH,
        "model": VISION_MODEL,
    })


def get_keep(row: dict[str, Any], steer_key: str, field: str = "est") -> float | None:
    value = ((row.get("steer") or {}).get(steer_key) or {}).get(field)
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except Exception:
        return None


def fetch_records(index: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    indexed = sorted(index.get("hooks") or [], key=lambda item: str(item.get("id") or ""))
    if not indexed:
        raise RuntimeError("The saved-hook index is empty")

    def fetch(item):
        hook_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(item.get("id") or ""))
        payload = R2.get_json(f"{SOURCE_PREFIX}{hook_id}.json")
        if not payload:
            raise RuntimeError(f"saved hook {hook_id} has no durable record")
        return hook_id, payload

    records: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch, item): item for item in indexed}
        for future in as_completed(futures):
            hook_id, record = future.result()
            records[hook_id] = record
    rows = [records[item["id"]] for item in indexed]
    return rows, records


def load_description_cache(keys: set[str]) -> dict[str, dict[str, Any]]:
    cached: dict[str, dict[str, Any]] = {}

    def fetch(key):
        return key, R2.get_json(key)

    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(fetch, key) for key in sorted(keys)]
        for future in as_completed(futures):
            key, value = future.result()
            if value and value.get("id"):
                cached[value["id"]] = value
    return cached


def describe_all(
    rows: list[dict[str, Any]],
    image_objects: dict[str, dict[str, Any]],
    existing: dict[str, dict[str, Any]],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    client = GeminiVisionClient()
    selected = rows[:limit] if limit else rows
    ready: dict[str, dict[str, Any]] = {}
    todo: list[tuple[dict[str, Any], str]] = []
    for row in selected:
        hook_id = row["id"]
        image_key = f"{SOURCE_PREFIX}{hook_id}.jpg"
        image_obj = image_objects.get(image_key)
        if not image_obj:
            raise RuntimeError(f"saved hook {hook_id} has no durable montage")
        expected_hash = source_hash(row, image_obj["etag"])
        cached = existing.get(hook_id)
        if (
            cached
            and cached.get("sourceHash") == expected_hash
            and cached.get("promptHash") == PROMPT_HASH
            and cached.get("visionModel") == VISION_MODEL
        ):
            ready[hook_id] = cached
        else:
            todo.append((row, expected_hash))

    emit_status(
        "describing",
        force=True,
        total=len(selected),
        described=len(ready),
        remainingDescriptions=len(todo),
        providerError=None,
        message=f"{len(ready):,} descriptions cached; {len(todo):,} require Gemini vision.",
    )

    progress_lock = threading.Lock()
    done = len(ready)

    def process(item):
        row, expected_hash = item
        hook_id = row["id"]
        image = R2.get_bytes(f"{SOURCE_PREFIX}{hook_id}.jpg")
        if not image:
            raise RuntimeError(f"saved hook {hook_id} montage could not be read")
        result = client.describe(image)
        payload = {
            "version": 1,
            "id": hook_id,
            "visionModel": VISION_MODEL,
            "promptHash": PROMPT_HASH,
            "sourceHash": expected_hash,
            "createdAt": int(time.time() * 1000),
            **result,
        }
        R2.put_json(f"{DESCRIPTION_PREFIX}{hook_id}.json", payload)
        return hook_id, payload

    with ThreadPoolExecutor(max_workers=VISION_WORKERS) as pool:
        futures = {pool.submit(process, item): item[0]["id"] for item in todo}
        for future in as_completed(futures):
            hook_id, payload = future.result()
            ready[hook_id] = payload
            with progress_lock:
                done += 1
                emit_status(
                    "describing",
                    total=len(selected),
                    described=done,
                    remainingDescriptions=len(selected) - done,
                    providerError=None,
                    message=f"Described {done:,} of {len(selected):,} saved hooks.",
                )
                print(f"describe {done}/{len(selected)} {hook_id}", flush=True)

    missing = [row["id"] for row in selected if row["id"] not in ready]
    if missing:
        raise RuntimeError(f"{len(missing)} descriptions are unresolved")
    return [ready[row["id"]] for row in selected]


def feature_texts(rows: list[dict[str, Any]], descriptions: list[dict[str, Any]], feature: str) -> list[str]:
    values = []
    for row, description in zip(rows, descriptions):
        if feature == "full_visual":
            value = description["visual_description"]
        elif feature == "hook_language":
            value = row.get("text") or row.get("title") or "not supplied"
        elif feature == "combined_semantics":
            value = (
                "Visible opening: " + description["visual_description"]
                + " Saved hook language: " + canonical_text(row.get("text") or row.get("title") or "not supplied")
            )
        else:
            value = (description.get("features") or {}).get(feature) or "not visibly established"
        values.append(canonical_text(f"{FEATURE_BY_KEY[feature]['label']}: {value}"))
    return values


def vector_bundle_hash(ids: list[str], texts: list[str]) -> str:
    return stable_hash({
        "ids": ids,
        "textHashes": [hashlib.sha256(text.encode("utf-8")).hexdigest() for text in texts],
        "model": EMBED_MODEL,
        "dimensions": EMBED_DIMENSIONS,
    })


def load_vector_bundle(
    feature: str,
    expected_hash: str,
    ids: list[str],
    vector_prefix: str = VECTOR_PREFIX,
) -> np.ndarray | None:
    manifest = R2.get_json(f"{vector_prefix}{feature}.json")
    if not manifest or manifest.get("bundleHash") != expected_hash:
        return None
    payload = R2.get_bytes(f"{vector_prefix}{feature}.npz")
    if not payload:
        return None
    with np.load(io.BytesIO(payload), allow_pickle=False) as data:
        stored_ids = [str(item) for item in data["ids"]]
        vectors = np.asarray(data["vectors"], np.float32)
    if stored_ids != ids or vectors.shape != (len(ids), EMBED_DIMENSIONS):
        return None
    return vectors


def save_vector_bundle(
    feature: str,
    bundle_hash: str,
    ids: list[str],
    vectors: np.ndarray,
    vector_prefix: str = VECTOR_PREFIX,
) -> None:
    bio = io.BytesIO()
    np.savez_compressed(
        bio,
        ids=np.asarray(ids, dtype=f"<U{max(1, max(map(len, ids)))}"),
        vectors=np.asarray(vectors, np.float32),
    )
    R2.put_bytes(f"{vector_prefix}{feature}.npz", bio.getvalue(), "application/octet-stream")
    R2.put_json(f"{vector_prefix}{feature}.json", {
        "version": 1,
        "feature": feature,
        "bundleHash": bundle_hash,
        "model": EMBED_MODEL,
        "dimensions": EMBED_DIMENSIONS,
        "n": len(ids),
        "createdAt": int(time.time() * 1000),
    })


def embed_all(
    rows: list[dict[str, Any]],
    descriptions: list[dict[str, Any]],
    vector_prefix: str = VECTOR_PREFIX,
) -> dict[str, np.ndarray]:
    ids = [row["id"] for row in rows]

    def report_retry(event: dict[str, Any]) -> None:
        error = classify_provider_error(
            int(event.get("status") or 0),
            str(event.get("message") or ""),
        )
        error["retrySeconds"] = float(event.get("delay") or RETRY_SECONDS)
        blocked = error["kind"] == "credits_or_quota_exhausted"
        emit_status(
            "blocked" if blocked else "degraded",
            force=blocked,
            providerError=error,
            message=(
                "Gemini credits or quota are blocking semantic embedding; cached batches "
                "are preserved and retry automatically."
                if blocked else
                "Gemini embedding returned a transient error; cached batches are preserved "
                "and the current batch is retrying."
            ),
        )

    store = EmbeddingStore(
        CACHE_DIR / "operations-embeddings.sqlite",
        model=EMBED_MODEL,
        dimensions=EMBED_DIMENSIONS,
        batch_size=100,
        workers=max(1, int(os.environ.get("OPERATIONS_EMBED_WORKERS", "2"))),
        on_retry=report_retry,
    )
    bundles: dict[str, np.ndarray] = {}
    try:
        for index, feature in enumerate(FEATURES):
            key = feature["key"]
            texts = feature_texts(rows, descriptions, key)
            bundle_hash = vector_bundle_hash(ids, texts)
            vectors = load_vector_bundle(key, bundle_hash, ids, vector_prefix)
            if vectors is None:
                emit_status(
                    "embedding",
                    force=True,
                    feature=key,
                    featureIndex=index + 1,
                    featureTotal=len(FEATURES),
                    message=f"Embedding {feature['label']} ({index + 1} of {len(FEATURES)}).",
                    providerError=None,
                )
                failures = 0
                while failures < MAX_RETRIES:
                    try:
                        found = store.embed_many(texts)
                        vectors = np.vstack([found[text] for text in texts]).astype(np.float32)
                        break
                    except Exception as exc:
                        message = str(exc)
                        error = classify_provider_exception(message)
                        permanent = getattr(exc, "retryable", True) is False
                        stage = (
                            "error" if permanent else
                            "blocked" if error["kind"] == "credits_or_quota_exhausted" else
                            "degraded"
                        )
                        emit_status(
                            stage,
                            force=True,
                            feature=key,
                            providerError=error,
                            message=(
                                "Gemini embedding configuration or request is not retryable. "
                                "Cached batches remain preserved."
                                if permanent else
                                "Gemini embedding access is blocked. No feature is marked complete; "
                                "cached batches are preserved and this feature will retry."
                            ),
                        )
                        if permanent:
                            raise RuntimeError(
                                "Gemini embedding configuration or request is not retryable: "
                                f"{error['message']}"
                            ) from exc
                        if error["kind"] != "credits_or_quota_exhausted":
                            failures += 1
                            if failures >= MAX_RETRIES:
                                raise RuntimeError(
                                    f"Gemini embedding failed after {MAX_RETRIES} retries: "
                                    f"{error['message']}"
                                ) from exc
                        time.sleep(RETRY_SECONDS)
                if vectors is None:
                    raise RuntimeError(f"Gemini embedding did not produce vectors for {key}")
                save_vector_bundle(key, bundle_hash, ids, vectors, vector_prefix)
            bundles[key] = vectors
            emit_status(
                "embedding",
                feature=key,
                featureIndex=index + 1,
                featureTotal=len(FEATURES),
                embeddedFeatures=index + 1,
                providerError=None,
                message=f"Embedded {index + 1} of {len(FEATURES)} feature families.",
            )
    finally:
        store.close()
    return bundles


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    values = np.asarray(matrix, np.float64)
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.where(norms > 1e-12, norms, 1.0)


def scale_plane(values: np.ndarray) -> tuple[list[int], list[int]]:
    output = []
    for column in range(2):
        data = np.asarray(values[:, column], float)
        lo, hi = np.percentile(data, [1, 99])
        scaled = np.clip((data - lo) / (hi - lo if hi > lo else 1.0), 0, 1)
        output.append(np.rint(scaled * 1000).astype(int).tolist())
    return output[0], output[1]


def candidate_clusters(values: np.ndarray, feature_index: int) -> tuple[np.ndarray, dict[str, Any], np.ndarray]:
    n, dimensions = values.shape
    max_components = min(n - 1, dimensions)
    pca = PCA(n_components=max_components, svd_solver="full")
    reduced_all = pca.fit_transform(values)
    cumulative = np.cumsum(pca.explained_variance_ratio_)
    retained = int(np.searchsorted(cumulative, 0.90) + 1)
    retained = max(2, min(retained, max_components))
    reduced = reduced_all[:, :retained]
    plane = reduced_all[:, :2]

    max_k = max(2, int(math.ceil(math.log2(max(n, 4)))))
    max_k = min(max_k, n - 1)
    resamples = 10
    candidates = []
    labels_by_k: dict[int, np.ndarray] = {}
    for k in range(2, max_k + 1):
        model = KMeans(
            n_clusters=k,
            n_init=20,
            max_iter=500,
            random_state=SEED + feature_index * 101 + k,
        )
        labels = model.fit_predict(reduced)
        labels_by_k[k] = labels
        bootstrap_scores = []
        bootstrap_stability = []
        for repeat in range(resamples):
            rng = np.random.default_rng(SEED + feature_index * 1009 + k * 37 + repeat)
            subset_size = min(n, max(k * 3, int(math.ceil(n * 0.8))))
            subset = np.sort(rng.choice(n, size=subset_size, replace=False))
            boot_model = KMeans(
                n_clusters=k,
                n_init=10,
                max_iter=500,
                random_state=SEED + feature_index * 301 + k * 11 + repeat,
            )
            boot_labels = boot_model.fit_predict(reduced[subset])
            bootstrap_scores.append(float(silhouette_score(reduced[subset], boot_labels, metric="euclidean")))
            bootstrap_stability.append(
                float(adjusted_rand_score(labels, boot_model.predict(reduced)))
            )
        counts = np.bincount(labels, minlength=k)
        candidates.append({
            "k": k,
            "silhouette": float(np.mean(bootstrap_scores)),
            "silhouetteSd": float(np.std(bootstrap_scores, ddof=1)),
            "stability": float(np.mean(bootstrap_stability)),
            "minCluster": int(counts.min()),
            "maxCluster": int(counts.max()),
        })
    best = max(candidates, key=lambda row: row["silhouette"])
    cutoff = best["silhouette"] - best["silhouetteSd"]
    chosen = min(
        (row for row in candidates if row["silhouette"] >= cutoff),
        key=lambda row: row["k"],
    )
    selection = {
        "rule": (
            "smallest k within one resampling standard deviation of the best "
            "mean silhouette across repeated 80% subsamples"
        ),
        "resamples": resamples,
        "candidateMax": max_k,
        "retainedPcaDimensions": retained,
        "retainedVariance": float(cumulative[retained - 1]),
        "chosenK": int(chosen["k"]),
        "bestK": int(best["k"]),
        "cutoff": float(cutoff),
        "candidates": candidates,
    }
    return labels_by_k[chosen["k"]], selection, plane


def bh_adjust(
    rows: list[dict[str, Any]],
    key: str = "p",
    output_key: str = "q",
) -> None:
    valid = [(index, float(row[key])) for index, row in enumerate(rows) if row.get(key) is not None]
    valid.sort(key=lambda item: item[1])
    total = len(valid)
    running = 1.0
    for rank in range(total, 0, -1):
        index, p_value = valid[rank - 1]
        running = min(running, p_value * total / rank)
        rows[index][output_key] = float(min(1.0, running))


def bootstrap_mean_difference(
    inside: np.ndarray,
    outside: np.ndarray,
    seed: int,
    repeats: int = 1000,
) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    diffs = np.empty(repeats, float)
    for index in range(repeats):
        a = inside[rng.integers(0, len(inside), len(inside))]
        b = outside[rng.integers(0, len(outside), len(outside))]
        diffs[index] = float(np.mean(a) - np.mean(b))
    low, high = np.percentile(diffs, [2.5, 97.5])
    return float(low), float(high)


def enriched_terms(texts: list[str], labels: np.ndarray, cluster_id: int) -> list[str]:
    try:
        vectorizer = TfidfVectorizer(
            lowercase=True,
            stop_words="english",
            ngram_range=(1, 3),
            min_df=2,
            max_features=6000,
        )
        matrix = vectorizer.fit_transform(texts)
        names = np.asarray(vectorizer.get_feature_names_out())
    except Exception:
        return []
    inside = np.asarray(matrix[labels == cluster_id].mean(axis=0)).ravel()
    outside = np.asarray(matrix[labels != cluster_id].mean(axis=0)).ravel()
    score = inside - outside
    ordered = np.argsort(score)[::-1]
    selected = []
    for index in ordered:
        term = str(names[index])
        if score[index] <= 0:
            break
        if any(term in previous or previous in term for previous in selected):
            continue
        selected.append(term)
        if len(selected) == 4:
            break
    return selected


def central_examples(values: np.ndarray, labels: np.ndarray, cluster_id: int, ids: list[str], count: int = 5) -> list[str]:
    indices = np.where(labels == cluster_id)[0]
    center = values[indices].mean(axis=0)
    center /= np.linalg.norm(center) or 1.0
    similarity = values[indices] @ center
    ordered = indices[np.argsort(similarity)[::-1][:count]]
    return [ids[index] for index in ordered]


def validate_family(values: np.ndarray, outcomes: dict[str, np.ndarray], feature_index: int) -> dict[str, Any]:
    result = {}
    alphas = np.logspace(-4, 4, 17)
    for target_key, y in outcomes.items():
        valid = np.isfinite(y)
        x_valid, y_valid = values[valid], y[valid]
        oof = np.full(len(y), np.nan, float)
        valid_indices = np.where(valid)[0]
        if len(y_valid) < 5:
            result[target_key] = {
                "n": int(len(y_valid)),
                "r2": None,
                "spearman": None,
                "mae": None,
                "auc80": None,
                "auc85": None,
                "oof": [None] * len(y),
                "protocol": "Unavailable: fewer than five finite outcomes.",
            }
            continue
        kfold = KFold(n_splits=5, shuffle=True, random_state=SEED + feature_index)
        for train, test in kfold.split(x_valid):
            model = RidgeCV(alphas=alphas)
            model.fit(x_valid[train], y_valid[train])
            oof[valid_indices[test]] = model.predict(x_valid[test])
        predicted = oof[valid]
        aucs = {}
        for threshold in (80, 85):
            binary = (y_valid >= threshold).astype(int)
            aucs[f"auc{threshold}"] = (
                float(roc_auc_score(binary, predicted))
                if len(np.unique(binary)) == 2 else None
            )
        rho = spearmanr(y_valid, predicted).statistic if len(y_valid) > 2 else float("nan")
        result[target_key] = {
            "n": int(len(y_valid)),
            "r2": float(r2_score(y_valid, predicted)),
            "spearman": float(rho),
            "mae": float(np.mean(np.abs(y_valid - predicted))),
            **aucs,
            "oof": [round(float(value), 3) if math.isfinite(value) else None for value in oof],
            "protocol": "five-fold out-of-fold ridge; alpha selected inside each training fold",
        }
    return result


def build_family(
    feature: dict[str, Any],
    feature_index: int,
    values: np.ndarray,
    texts: list[str],
    ids: list[str],
    outcomes: dict[str, np.ndarray],
) -> dict[str, Any]:
    normalized = normalize_rows(values)
    labels, selection, plane = candidate_clusters(normalized, feature_index)
    x, y = scale_plane(plane)
    cluster_rows = []
    for cluster_id in range(selection["chosenK"]):
        indices = np.where(labels == cluster_id)[0]
        terms = enriched_terms(texts, labels, cluster_id)
        medoids = central_examples(normalized, labels, cluster_id, ids)
        exemplar_text = texts[ids.index(medoids[0])] if medoids else ""
        cluster = {
            "id": int(cluster_id),
            "label": " / ".join(terms[:3]) if terms else f"Cluster {cluster_id + 1}",
            "definition": exemplar_text,
            "terms": terms,
            "n": int(len(indices)),
            "share": float(len(indices) / len(ids)),
            "medoids": medoids,
            "outcomes": {},
        }
        for target_index, (target_key, target_values) in enumerate(outcomes.items()):
            inside = target_values[indices]
            inside = inside[np.isfinite(inside)]
            outside = target_values[np.setdiff1d(np.arange(len(ids)), indices)]
            outside = outside[np.isfinite(outside)]
            if not len(inside) or not len(outside):
                continue
            test = (
                ttest_ind(inside, outside, equal_var=False, nan_policy="omit")
                if len(inside) > 1 and len(outside) > 1 else None
            )
            pooled = 0.0
            if len(inside) > 1 and len(outside) > 1:
                pooled = math.sqrt(
                    ((len(inside) - 1) * np.var(inside, ddof=1) + (len(outside) - 1) * np.var(outside, ddof=1))
                    / max(1, len(inside) + len(outside) - 2)
                )
            diff = float(np.mean(inside) - np.mean(outside))
            low, high = bootstrap_mean_difference(
                inside,
                outside,
                SEED + feature_index * 10000 + cluster_id * 100 + target_index,
            )
            cluster["outcomes"][target_key] = {
                "n": int(len(inside)),
                "mean": float(np.mean(inside)),
                "median": float(np.median(inside)),
                "difference": diff,
                "ci95": [low, high],
                "effectSize": float(diff / pooled) if pooled > 1e-12 else 0.0,
                "p": float(test.pvalue) if test is not None and math.isfinite(test.pvalue) else None,
            }
        cluster_rows.append(cluster)
    for target_key in outcomes:
        target_rows = []
        for cluster in cluster_rows:
            row = cluster["outcomes"].get(target_key)
            if row:
                target_rows.append(row)
        bh_adjust(target_rows)
    return {
        "key": feature["key"],
        "label": feature["label"],
        "definition": feature["definition"],
        "selection": selection,
        "plane": {"x": x, "y": y},
        "assignments": labels.astype(int).tolist(),
        "clusters": cluster_rows,
        "validation": validate_family(normalized, outcomes, feature_index),
    }


def fisher_exact_p(a: int, b: int, c: int, d: int) -> float:
    from scipy.stats import fisher_exact
    return float(fisher_exact([[a, b], [c, d]], alternative="two-sided").pvalue)


def build_interactions(
    families: list[dict[str, Any]],
    outcomes: dict[str, np.ndarray],
) -> dict[str, list[dict[str, Any]]]:
    all_rows: dict[str, list[dict[str, Any]]] = {}
    cluster_lookup = {
        family["key"]: {cluster["id"]: cluster for cluster in family["clusters"]}
        for family in families
    }
    for target_key, target_values in outcomes.items():
        valid = np.isfinite(target_values)
        if not np.any(valid):
            all_rows[target_key] = []
            continue
        base_hits = {
            threshold: float(np.mean(target_values[valid] >= threshold))
            for threshold in (80, 85)
        }
        rows = []
        for left_index in range(len(families)):
            left = families[left_index]
            left_assign = np.asarray(left["assignments"], int)
            for right_index in range(left_index + 1, len(families)):
                right = families[right_index]
                right_assign = np.asarray(right["assignments"], int)
                pairs: dict[tuple[int, int], list[int]] = {}
                for index, pair in enumerate(zip(left_assign, right_assign)):
                    if valid[index]:
                        pairs.setdefault((int(pair[0]), int(pair[1])), []).append(index)
                for (left_cluster, right_cluster), indices_list in pairs.items():
                    if len(indices_list) < 5:
                        continue
                    indices = np.asarray(indices_list, int)
                    rest = np.setdiff1d(np.where(valid)[0], indices)
                    if not len(rest):
                        continue
                    inside = target_values[indices]
                    outside = target_values[rest]
                    row = {
                        "leftFamily": left["key"],
                        "leftCluster": left_cluster,
                        "leftLabel": cluster_lookup[left["key"]][left_cluster]["label"],
                        "rightFamily": right["key"],
                        "rightCluster": right_cluster,
                        "rightLabel": cluster_lookup[right["key"]][right_cluster]["label"],
                        "n": int(len(inside)),
                        "mean": float(np.mean(inside)),
                        "difference": float(np.mean(inside) - np.mean(outside)),
                    }
                    for threshold in (80, 85):
                        hits = int(np.sum(inside >= threshold))
                        misses = int(len(inside) - hits)
                        rest_hits = int(np.sum(outside >= threshold))
                        rest_misses = int(len(outside) - rest_hits)
                        hit_rate = float(hits / len(inside))
                        row[f"hitRate{threshold}"] = hit_rate
                        row[f"lift{threshold}"] = (
                            float(hit_rate / base_hits[threshold])
                            if base_hits[threshold] > 0 else None
                        )
                        row[f"p{threshold}"] = fisher_exact_p(
                            hits,
                            misses,
                            rest_hits,
                            rest_misses,
                        )
                    rows.append(row)
        all_rows[target_key] = rows

    hypotheses = []
    for target_key, rows in all_rows.items():
        for row in rows:
            for threshold in (80, 85):
                hypotheses.append({
                    "p": row[f"p{threshold}"],
                    "target": target_key,
                    "row": row,
                    "outputKey": f"q{threshold}",
                })
    bh_adjust(hypotheses)
    for hypothesis in hypotheses:
        hypothesis["row"][hypothesis["outputKey"]] = hypothesis["q"]

    output: dict[str, list[dict[str, Any]]] = {}
    for target_key, rows in all_rows.items():
        retained: dict[tuple[Any, ...], dict[str, Any]] = {}
        ranking_rules = [
            lambda row: (row.get("q80", 1.0), -abs(row.get("difference") or 0), -row["n"]),
            lambda row: (row.get("q85", 1.0), -abs(row.get("difference") or 0), -row["n"]),
            lambda row: (-abs(row.get("difference") or 0), -row["n"]),
        ]
        for rule in ranking_rules:
            for row in sorted(rows, key=rule)[:300]:
                key = (
                    row["leftFamily"],
                    row["leftCluster"],
                    row["rightFamily"],
                    row["rightCluster"],
                )
                retained[key] = row
        selected = list(retained.values())
        selected.sort(key=lambda row: (
            min(row.get("q80", 1.0), row.get("q85", 1.0)),
            -abs(row.get("difference") or 0),
            -row["n"],
        ))
        output[target_key] = selected
    return output


def apply_global_cluster_adjustment(families: list[dict[str, Any]]) -> None:
    rows = []
    for target_key in TARGETS:
        for family in families:
            for cluster in family.get("clusters") or []:
                outcome = (cluster.get("outcomes") or {}).get(target_key)
                if not outcome:
                    continue
                outcome["qWithinFamily"] = outcome.get("q")
                rows.append(outcome)
    bh_adjust(rows, key="p", output_key="q")


def build_artifact(
    rows: list[dict[str, Any]],
    descriptions: list[dict[str, Any]],
    bundles: dict[str, np.ndarray],
) -> dict[str, Any]:
    ids = [row["id"] for row in rows]
    outcomes = {
        target_key: np.asarray([
            get_keep(row, target["steer"], "est")
            if get_keep(row, target["steer"], "est") is not None else np.nan
            for row in rows
        ], float)
        for target_key, target in TARGETS.items()
    }
    hook_rows = []
    for index, (row, description) in enumerate(zip(rows, descriptions)):
        targets = {}
        for target_key, target in TARGETS.items():
            targets[target_key] = {
                "estimate": get_keep(row, target["steer"], "est"),
                "percentile": get_keep(row, target["steer"], "pctile"),
            }
        hook_rows.append({
            "id": row["id"],
            "title": canonical_text(row.get("title") or ""),
            "text": canonical_text(row.get("text") or ""),
            "savedAt": row.get("savedAt"),
            "source": row.get("source"),
            "montage": f"/api/raw/saved-montage/{row['id']}",
            "targets": targets,
            "description": description["visual_description"],
            "sequence": description["sequence"],
            "features": {
                **description["features"],
                "hook_language": canonical_text(row.get("text") or row.get("title") or ""),
            },
        })

    families = []
    for index, feature in enumerate(FEATURES):
        emit_status(
            "clustering",
            force=True,
            family=feature["key"],
            familyIndex=index + 1,
            familyTotal=len(FEATURES),
            message=f"Clustering and validating {feature['label']} ({index + 1} of {len(FEATURES)}).",
            providerError=None,
        )
        texts = feature_texts(rows, descriptions, feature["key"])
        families.append(build_family(
            feature,
            index,
            bundles[feature["key"]],
            texts,
            ids,
            outcomes,
        ))
        print(f"cluster {index + 1}/{len(FEATURES)} {feature['key']}", flush=True)

    apply_global_cluster_adjustment(families)
    emit_status(
        "interactions",
        force=True,
        message="Testing cross-family operation combinations at the 80% and 85% keep thresholds.",
    )
    interactions = build_interactions(families, outcomes)
    source_hash_value = stable_hash({
        "ids": ids,
        "descriptions": [item["sourceHash"] for item in descriptions],
    })
    summary_targets = {}
    for target_key, values in outcomes.items():
        valid = values[np.isfinite(values)]
        summary_targets[target_key] = {
            "n": int(len(valid)),
            "mean": float(np.mean(valid)),
            "median": float(np.median(valid)),
            "min": float(np.min(valid)),
            "max": float(np.max(valid)),
            "over80": int(np.sum(valid >= 80)),
            "over80Rate": float(np.mean(valid >= 80)),
            "over85": int(np.sum(valid >= 85)),
            "over85Rate": float(np.mean(valid >= 85)),
        }
    return {
        "version": 1,
        "productVersion": PRODUCT_VERSION,
        "generatedAt": int(time.time() * 1000),
        "source": {
            "key": SOURCE_INDEX_KEY,
            "corpusHash": source_hash_value,
            "n": len(rows),
            "selection": "Durable Shorts Quant saved-hook bank",
            "warning": (
                "This corpus is preselected and the keep values are existing embedding estimates, "
                "not observed YouTube swipe ratios. Associations describe this bank and are not causal proof."
            ),
        },
        "provenance": {
            "visionModel": VISION_MODEL,
            "visionTemperature": 0,
            "visionSeed": SEED,
            "visionMaxOutputTokens": VISION_MAX_OUTPUT_TOKENS,
            "visionOutputPolicy": (
                "The ceiling was raised from 4096 to 8192 after finishReason=MAX_TOKENS "
                "showed hidden thinking tokens truncating otherwise valid JSON. Cached complete "
                "descriptions retain the same model, prompt, and seed."
            ),
            "promptHash": PROMPT_HASH,
            "embeddingModel": EMBED_MODEL,
            "embeddingDimensions": EMBED_DIMENSIONS,
            "randomSeed": SEED,
            "outcomeBlindExtraction": True,
            "outcomeBlindClustering": True,
            "descriptorInput": "Montage pixels only; saved text is a separate feature family.",
            "validation": "Five-fold out-of-fold ridge for each feature family and keep estimator.",
            "multipleTesting": (
                "Cluster q-values use one Benjamini-Hochberg correction across every target, "
                "family, and cluster test. Interaction q-values use one correction across every "
                "target, family pair, cluster pair, and both the 80% and 85% thresholds."
            ),
        },
        "targets": TARGETS,
        "summary": {
            "hooks": len(rows),
            "descriptions": len(descriptions),
            "featureFamilies": len(FEATURES),
            "targetSummaries": summary_targets,
        },
        "hooks": hook_rows,
        "families": families,
        "interactions": interactions,
    }


def run(limit: int | None = None, describe_only: bool = False) -> dict[str, Any] | None:
    emit_status("inventory", force=True, message="Reading the durable saved-hook bank and montage inventory.")
    index = R2.get_json(SOURCE_INDEX_KEY)
    if not index:
        raise RuntimeError("raw/saved-hooks/index.json is unavailable")
    rows, _ = fetch_records(index)
    if limit:
        rows = rows[:limit]
    objects = R2.list_objects(SOURCE_PREFIX)
    image_objects = {item["key"]: item for item in objects if item["key"].endswith(".jpg")}
    description_keys = {
        item["key"] for item in R2.list_objects(DESCRIPTION_PREFIX)
        if item["key"].endswith(".json")
    }
    existing = load_description_cache(description_keys)
    descriptions = describe_all(rows, image_objects, existing, limit=None)
    if describe_only:
        DESCRIPTIONS_COMPLETE_MARKER.write_text(
            json.dumps({
                "version": 1,
                "productVersion": PRODUCT_VERSION,
                "promptHash": PROMPT_HASH,
                "visionModel": VISION_MODEL,
                "total": len(rows),
                "completedAt": int(time.time() * 1000),
            }, indent=2),
            encoding="utf-8",
        )
        emit_status(
            "descriptions_complete",
            force=True,
            total=len(rows),
            described=len(descriptions),
            message="All requested saved hooks have durable outcome-blind descriptions.",
            providerError=None,
        )
        return None
    vector_prefix = f"{R2_PREFIX}/test-vectors/{limit}/" if limit else VECTOR_PREFIX
    bundles = embed_all(rows, descriptions, vector_prefix)
    artifact = build_artifact(rows, descriptions, bundles)
    if limit:
        artifact["source"]["testLimit"] = int(limit)
        test_path = CACHE_DIR / f"test-artifact-{limit}.json"
        test_path.write_text(
            json.dumps(json_ready(artifact), ensure_ascii=False, separators=(",", ":"), allow_nan=False),
            encoding="utf-8",
        )
        emit_status(
            "test_complete",
            force=True,
            total=len(rows),
            described=len(descriptions),
            embeddedFeatures=len(FEATURES),
            testArtifact=str(test_path),
            providerError=None,
            message=(
                f"Operations validation run complete for {len(rows):,} hooks. "
                "The canonical R2 artifact was not replaced."
            ),
        )
        return artifact
    emit_status("publishing", force=True, message="Publishing the complete Operations artifact to R2.")
    R2.put_json(ARTIFACT_KEY, artifact)
    emit_status(
        "complete",
        force=True,
        total=len(rows),
        described=len(descriptions),
        embeddedFeatures=len(FEATURES),
        artifactKey=ARTIFACT_KEY,
        generatedAt=artifact["generatedAt"],
        providerError=None,
        message=(
            f"Operations complete: {len(rows):,} hooks, {len(FEATURES)} feature families, "
            "outcome-blind clusters, and three keep-estimate validations."
        ),
    )
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--describe-only", action="store_true")
    args = parser.parse_args()
    started = time.time()
    try:
        artifact = run(limit=args.limit, describe_only=args.describe_only)
        print(json.dumps({
            "ok": True,
            "seconds": round(time.time() - started, 1),
            "hooks": artifact["summary"]["hooks"] if artifact else args.limit,
            "artifact": (
                str(CACHE_DIR / f"test-artifact-{args.limit}.json")
                if artifact and args.limit else ARTIFACT_KEY if artifact else None
            ),
        }), flush=True)
    except KeyboardInterrupt:
        emit_status(
            "stopped",
            force=True,
            message="Operations worker stopped; completed descriptions and vector bundles remain durable.",
        )
        raise
    except Exception as exc:
        emit_status(
            "error",
            force=True,
            error=str(exc)[:1000],
            message=f"Operations stopped before publication: {str(exc)[:500]}",
        )
        raise
    finally:
        flush_status()


if __name__ == "__main__":
    main()
