#!/usr/bin/env python3
"""Build the Shorts Quant keep-rate and views predictor research artifact.

The two targets deliberately use different validation populations:

* keep rate: private retention labels, with blind videos inside known accounts
  as the operational test plus unseen-account and forward-time stress tests;
* views: frozen 21-output scores on saved channels that were not used to fit the
  original embedding axes, with blind videos inside known channels as the
  operational test plus an unseen-channel stress test.

Target-aligned keep/ret5 axes are refit inside every private-data fold. Existing
in-sample steered keep/ret5 estimates are never used as validation features.
The persisted JSON is presentation-ready so Render only serves it; no model fit
or large embedding archive is loaded by the web process.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import itertools
import json
import math
import os
import platform
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import boto3
import numpy as np
import scipy
import sklearn
from scipy.stats import rankdata, spearmanr
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CONTRACT_PATH = ROOT / "buildings" / "jarvis" / "saved-channel-feature-contract.json"
LOCAL_RESULT = HERE / "results.json"
R2_RESULT_KEY = "raw/predictor-lab/results.json"
R2_STATUS_KEY = "raw/predictor-lab/status.json"
EXPERIMENT_COUNT = 50_000
MODALITIES = ("visual", "text", "together")
MODALITY_SHORT = {"visual": "vis", "text": "txt", "together": "tog"}
EPSILON = 1e-9
READ_PROVENANCE: dict[str, dict[str, Any]] = {}


def env(name: str) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    env_path = ROOT / ".env"
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


BUCKET = env("R2_BUCKET_NAME") or "business-world-videos"
S3 = boto3.client(
    "s3",
    endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
    aws_access_key_id=env("R2_ACCESS_KEY_ID"),
    aws_secret_access_key=env("R2_SECRET_ACCESS_KEY"),
    region_name="auto",
)


def record_source(name: str, payload: bytes) -> None:
    fingerprint = hashlib.sha256(payload).hexdigest()
    previous = READ_PROVENANCE.get(name)
    if previous and previous["sha256"] != fingerprint:
        raise RuntimeError(f"source changed during predictor run: {name}")
    READ_PROVENANCE[name] = {
        "sha256": fingerprint,
        "bytes": len(payload),
    }


def r2_bytes(key: str) -> bytes | None:
    try:
        payload = S3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    except Exception:
        return None
    record_source(f"r2:{key}", payload)
    return payload


def r2_json(key: str, default: Any = None) -> Any:
    payload = r2_bytes(key)
    if not payload:
        return default
    try:
        return json.loads(payload)
    except Exception:
        return default


def required_r2_json(key: str) -> Any:
    payload = r2_bytes(key)
    if not payload:
        raise RuntimeError(f"missing required R2 artifact: {key}")
    try:
        return json.loads(payload)
    except Exception as error:
        raise RuntimeError(f"invalid JSON in required R2 artifact: {key}") from error


def put_json(key: str, value: Any) -> None:
    S3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(value, separators=(",", ":"), allow_nan=False).encode(),
        ContentType="application/json",
    )


def finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def clean_number(value: Any, digits: int = 5) -> float | None:
    if not finite(value):
        return None
    return round(float(value), digits)


def stable_hash(value: str) -> int:
    return int(hashlib.sha256(str(value).encode()).hexdigest()[:16], 16)


def normalized(vectors: np.ndarray) -> np.ndarray:
    vectors = np.asarray(vectors, dtype=np.float32)
    return vectors / (np.linalg.norm(vectors, axis=1, keepdims=True) + EPSILON)


def parse_date(value: Any) -> float | None:
    if value is None or value == "":
        return None
    text = str(value).strip()
    try:
        if text.isdigit() and len(text) == 8:
            parsed = datetime.strptime(text, "%Y%m%d").replace(tzinfo=timezone.utc)
            return parsed.timestamp() * 1000
        number = float(text)
        if math.isfinite(number) and number > 0:
            return number * 1000 if number < 1e12 else number
    except (ValueError, TypeError):
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def quantile(values: Iterable[float], probability: float) -> float | None:
    data = np.asarray([float(value) for value in values if finite(value)], dtype=float)
    return float(np.quantile(data, probability)) if data.size else None


def load_npz(key: str) -> dict[str, np.ndarray]:
    payload = r2_bytes(key)
    if not payload:
        raise RuntimeError(f"missing R2 artifact: {key}")
    archive = np.load(io.BytesIO(payload), allow_pickle=True)
    return {name: archive[name] for name in archive.files}


def load_library() -> dict[str, dict[str, Any]]:
    local = ROOT / "library-db.json"
    if local.exists():
        raw = local.read_bytes()
        record_source(f"local:{local.relative_to(ROOT)}", raw)
        payload = json.loads(raw)
    else:
        payload = required_r2_json("library/db.json")
    if not isinstance(payload, dict) or not isinstance(payload.get("videos"), dict):
        raise RuntimeError("library dataset is missing its videos object")
    return {
        str(video.get("videoId")): video
        for video in (payload.get("videos") or {}).values()
        if video.get("videoId")
    }


def load_raw() -> dict[str, dict[str, Any]]:
    stores: dict[str, dict[str, Any]] = {}
    for modality in MODALITIES:
        archive = load_npz(f"raw/{modality}/embeddings.npz")
        required = ("ids", "vecs", "views", "outlier", "subs", "title", "txt")
        missing = [name for name in required if name not in archive]
        if missing:
            raise RuntimeError(
                f"raw {modality} archive is missing {', '.join(missing)}"
            )
        row_count = len(archive["ids"])
        lengths = {
            name: len(archive[name])
            for name in required
        }
        if any(length != row_count for length in lengths.values()):
            raise RuntimeError(
                f"raw {modality} archive arrays are misaligned: {lengths}"
            )
        vectors = np.asarray(archive["vecs"])
        if vectors.ndim != 2 or vectors.shape[0] != row_count or vectors.shape[1] < 8:
            raise RuntimeError(
                f"raw {modality} vectors have invalid shape {vectors.shape}"
            )
        ids = [str(value) for value in archive["ids"]]
        if len(set(ids)) != len(ids):
            raise RuntimeError(f"raw {modality} archive contains duplicate video IDs")
        for optional in ("mine", "silent"):
            if optional in archive and len(archive[optional]) != row_count:
                raise RuntimeError(
                    f"raw {modality} {optional} flags do not align with IDs"
                )
        stores[modality] = {
            "ids": ids,
            "index": {video_id: index for index, video_id in enumerate(ids)},
            "vectors": normalized(vectors),
            "views": np.asarray(archive["views"], dtype=float),
            "outlier": np.asarray(archive["outlier"], dtype=float),
            "subs": np.asarray(archive["subs"], dtype=float),
            "titles": [str(value) for value in archive["title"]],
            "texts": [str(value) for value in archive["txt"]],
            "mine": np.asarray(archive.get("mine", np.zeros(len(ids))), dtype=bool),
            "silent": np.asarray(archive.get("silent", np.zeros(len(ids))), dtype=bool),
        }
    return stores


def load_private_rows() -> list[dict[str, Any]]:
    channel_payload = required_r2_json("retention/channels.json")
    if not isinstance(channel_payload, dict) or not isinstance(channel_payload.get("channels"), list):
        raise RuntimeError("retention/channels.json is missing its channels list")
    channels = channel_payload["channels"]
    if not any(channel.get("id") == "tyler" for channel in channels):
        channels.insert(0, {"id": "tyler", "name": "Main", "owner": True})
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for channel in channels:
        channel_id = str(channel.get("id") or "")
        if channel.get("owner") or channel_id == "tyler":
            table_path = ROOT / "buildings" / "jarvis" / "retention-study" / "retention_table.json"
            table_raw = table_path.read_bytes()
            record_source(f"local:{table_path.relative_to(ROOT)}", table_raw)
            table = json.loads(table_raw)
        else:
            table = required_r2_json(f"retention/{channel_id}.json")
            if not isinstance(table, dict) or not isinstance(table.get("videos"), list):
                raise RuntimeError(f"retention/{channel_id}.json is missing its videos list")
        for video in table.get("videos") or []:
            video_id = str(video.get("id") or video.get("videoId") or "")
            keep = video.get("keep_rate", video.get("stayedToWatch"))
            ret5 = video.get("ret5")
            if not video_id or video_id in seen or not finite(keep):
                continue
            seen.add(video_id)
            rows.append(
                {
                    "id": video_id,
                    "title": str(video.get("title") or video_id),
                    "account": channel_id,
                    "accountName": str(channel.get("name") or channel_id),
                    "keep": float(keep),
                    "ret5": float(ret5) if finite(ret5) else None,
                    "views": float(video.get("views")) if finite(video.get("views")) else None,
                    "duration": float(video.get("duration_s")) if finite(video.get("duration_s")) else None,
                    "publishedAt": parse_date(video.get("published")),
                }
            )
    return rows


def feature_values(
    video: dict[str, Any],
    definition: dict[str, Any],
) -> tuple[float | None, float | None]:
    cell = (video.get("features") or {}).get(definition["key"])
    if isinstance(cell, list):
        raw = float(cell[0]) if cell and finite(cell[0]) else None
        percentile = float(cell[1]) / 100 if len(cell) > 1 and finite(cell[1]) else None
    elif isinstance(cell, dict):
        percentile_value = cell.get("p", cell.get("percentile"))
        raw_value = cell.get("v", cell.get("value"))
        raw = float(raw_value) if finite(raw_value) else None
        percentile = float(percentile_value) / 100 if finite(percentile_value) else None
    else:
        raw, percentile = None, None
    if raw is not None and definition.get("unit") == "views" and definition.get("source") == "steer":
        raw = math.log10(max(0, raw) + 1)
    return raw, percentile


def saved_channel_feature_names(contract: dict[str, Any]) -> list[str]:
    names = []
    for definition in contract["features"]:
        names.extend([f"{definition['key']}.raw", f"{definition['key']}.percentile"])
    return names + ["text.present", "duration.log", "title.words"]


def load_saved_channel_rows(contract: dict[str, Any]) -> list[dict[str, Any]]:
    index = required_r2_json("raw/saved-channels/index.json")
    if not isinstance(index, dict) or not isinstance(index.get("channels"), list):
        raise RuntimeError("saved-channel index is missing its channels list")
    rows: list[dict[str, Any]] = []
    for channel in index.get("channels") or []:
        channel_id = str(channel.get("id") or "")
        if not channel_id:
            raise RuntimeError("saved-channel index contains a channel without an ID")
        manifest = required_r2_json(f"raw/saved-channels/{channel_id}/manifest.json")
        if not isinstance(manifest, dict) or not isinstance(manifest.get("videos"), list):
            raise RuntimeError(f"saved-channel manifest {channel_id} is missing its videos list")
        for video in manifest.get("videos") or []:
            if video.get("status") != "done" or not finite(video.get("views")) or float(video["views"]) <= 0:
                continue
            pairs = [feature_values(video, definition) for definition in contract["features"]]
            vector = [value for pair in pairs for value in pair]
            if sum(value is not None for value in vector) < 8:
                continue
            published_at = parse_date(video.get("published"))
            observed_at = float(video.get("viewsObservedAt") or video.get("scoredAt") or time.time() * 1000)
            age_days = (observed_at - published_at) / 86400000 if published_at and observed_at >= published_at else None
            text_present = any(
                any(value is not None for value in pairs[feature_index])
                for feature_index, definition in enumerate(contract["features"])
                if definition.get("group") == "text"
            )
            duration = float(video["duration"]) if finite(video.get("duration")) else None
            vector.extend(
                [
                    1.0 if text_present else 0.0,
                    math.log10(duration + 1) if duration is not None and duration >= 0 else None,
                    float(len(str(video.get("title") or "").split())),
                ]
            )
            rows.append(
                {
                    "id": str(video.get("id")),
                    "title": str(video.get("title") or video.get("id")),
                    "channel": channel_id,
                    "channelName": str(manifest.get("name") or channel.get("name") or channel_id),
                    "views": float(video["views"]),
                    "logViews": math.log10(float(video["views"]) + 1),
                    "features": vector,
                    "ageDays": age_days,
                    "duration": duration,
                    "publishedAt": published_at,
                }
            )
    return rows


def load_novelty_models() -> dict[str, np.ndarray]:
    payload = r2_bytes("raw/novelty_models.npz")
    if not payload:
        return {}
    archive = np.load(io.BytesIO(payload), allow_pickle=True)
    return {name: archive[name] for name in archive.files}


def novelty_primitives(
    modality: str,
    vectors: np.ndarray,
    novelty_models: dict[str, np.ndarray],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    short = MODALITY_SHORT[modality]
    n = len(vectors)
    temporal_distance = np.full(n, np.nan, dtype=float)
    niche_distance = np.full(n, np.nan, dtype=float)
    combinatorial = np.full(n, np.nan, dtype=float)
    centroids = novelty_models.get(f"{short}_centroids")
    recent = novelty_models.get(f"{short}_recent")
    components = novelty_models.get(f"{short}_pca_comp")
    mean = novelty_models.get(f"{short}_pca_mean")
    if centroids is not None:
        niche_distance = 1 - np.max(np.asarray(vectors) @ np.asarray(centroids).T, axis=1)
    if recent is not None:
        temporal_distance = 1 - np.asarray(vectors) @ np.asarray(recent)
    if components is not None and mean is not None:
        centered = np.asarray(vectors) - np.asarray(mean)
        reconstruction = np.asarray(mean) + centered @ np.asarray(components).T @ np.asarray(components)
        combinatorial = np.linalg.norm(np.asarray(vectors) - reconstruction, axis=1)
    return temporal_distance, niche_distance, combinatorial


def fit_public_axes(
    stores: dict[str, dict[str, Any]],
    private_ids: set[str],
    novelty_models: dict[str, np.ndarray],
) -> dict[str, dict[str, Any]]:
    models: dict[str, dict[str, Any]] = {}
    for modality, store in stores.items():
        public = np.array(
            [
                not store["mine"][index]
                and video_id not in private_ids
                and finite(store["views"][index])
                and store["views"][index] > 0
                for index, video_id in enumerate(store["ids"])
            ],
            dtype=bool,
        )
        X = store["vectors"][public]
        views = store["views"][public]
        outlier = store["outlier"][public]
        valid_outlier = np.isfinite(outlier) & (outlier > 0)
        view_model = Ridge(alpha=100.0, solver="lsqr", tol=1e-3).fit(X, np.log10(views + 1))
        outlier_model = Ridge(alpha=100.0, solver="lsqr", tol=1e-3).fit(
            X[valid_outlier], np.log10(outlier[valid_outlier] + 1)
        )
        binary = (views >= 10_000_000).astype(int)
        if binary.sum() >= 10 and (len(binary) - binary.sum()) >= 10:
            hit_model = LogisticRegression(C=0.1, max_iter=400, solver="liblinear").fit(X, binary)
        else:
            hit_model = None
        temporal_novelty, niche_novelty, combinatorial = novelty_primitives(
            modality, store["vectors"], novelty_models
        )
        models[modality] = {
            "views": view_model,
            "outlier": outlier_model,
            "hit10m": hit_model,
            "novelty_temporal": temporal_novelty,
            "novelty_niche": niche_novelty,
            "novelty_combinatorial": combinatorial,
            "trainN": int(public.sum()),
        }
    return models


PRIVATE_SIGNAL_NAMES = [
    f"{modality}.{target}"
    for modality in MODALITIES
    for target in ("keep", "ret5", "views", "realviews", "outlier", "gt10M")
] + [
    "novelty.temporal",
    "novelty.niche",
    "novelty.combinatorial",
]
PRIVATE_RAW_FEATURE_NAMES = PRIVATE_SIGNAL_NAMES + [
    "text.present",
    "duration.log",
    "title.words",
]
PRIVATE_FEATURE_NAMES = [
    variant
    for signal in PRIVATE_SIGNAL_NAMES
    for variant in (f"{signal}.raw", f"{signal}.percentile")
] + ["text.present", "duration.log", "title.words"]


def private_raw_features(
    train_rows: list[dict[str, Any]],
    eval_rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
) -> np.ndarray:
    output = np.full((len(eval_rows), len(PRIVATE_RAW_FEATURE_NAMES)), np.nan, dtype=float)
    novelty_columns: dict[str, list[np.ndarray]] = {
        "temporal": [],
        "niche": [],
        "combinatorial": [],
    }
    column = 0
    for modality in MODALITIES:
        store = stores[modality]
        train = [
            (store["index"][row["id"]], row)
            for row in train_rows
            if row["id"] in store["index"]
        ]
        keep_model = None
        ret5_model = None
        if len(train) >= 8:
            train_vectors = store["vectors"][[item[0] for item in train]]
            keep_model = Ridge(alpha=100.0, solver="lsqr", tol=1e-4).fit(
                train_vectors, [item[1]["keep"] for item in train]
            )
            ret_rows = [item for item in train if finite(item[1].get("ret5"))]
            if len(ret_rows) >= 8:
                ret5_model = Ridge(alpha=100.0, solver="lsqr", tol=1e-4).fit(
                    store["vectors"][[item[0] for item in ret_rows]],
                    [item[1]["ret5"] for item in ret_rows],
                )
        realviews_model = None
        if keep_model is not None and ret5_model is not None:
            train_meta = [item[1] for item in train]
            equation_indices = [
                index
                for index, item in enumerate(train)
                if finite(item[1].get("views"))
                and float(item[1]["views"]) > 0
                and finite(item[1].get("duration"))
            ]
            if len(equation_indices) >= 20:
                oof_keep = np.full(len(train), np.nan)
                oof_ret5 = np.full(len(train), np.nan)
                equation_folds = within_group_folds(
                    train_meta,
                    "account",
                    min(4, len(train_meta)),
                )
                for fold in sorted(set(int(value) for value in equation_folds)):
                    fit_indices = np.flatnonzero(equation_folds != fold)
                    test_indices = np.flatnonzero(equation_folds == fold)
                    if len(fit_indices) < 8 or not len(test_indices):
                        continue
                    fit_keep = Ridge(alpha=100.0, solver="lsqr", tol=1e-4).fit(
                        store["vectors"][[train[index][0] for index in fit_indices]],
                        [train[index][1]["keep"] for index in fit_indices],
                    )
                    ret_fit_indices = [
                        index
                        for index in fit_indices
                        if finite(train[index][1].get("ret5"))
                    ]
                    if len(ret_fit_indices) < 8:
                        continue
                    fit_ret5 = Ridge(alpha=100.0, solver="lsqr", tol=1e-4).fit(
                        store["vectors"][[train[index][0] for index in ret_fit_indices]],
                        [train[index][1]["ret5"] for index in ret_fit_indices],
                    )
                    test_vectors = store["vectors"][
                        [train[index][0] for index in test_indices]
                    ]
                    oof_keep[test_indices] = fit_keep.predict(test_vectors)
                    oof_ret5[test_indices] = fit_ret5.predict(test_vectors)
                valid_equation = [
                    index
                    for index in equation_indices
                    if finite(oof_keep[index]) and finite(oof_ret5[index])
                ]
            else:
                valid_equation = []
            if len(valid_equation) >= 20:
                equation_inputs = np.column_stack(
                    [
                        oof_keep[valid_equation],
                        oof_ret5[valid_equation],
                        np.log10(
                            np.asarray(
                                [
                                    float(train[index][1]["duration"])
                                    for index in valid_equation
                                ]
                            )
                            + 1
                        ),
                    ]
                )
                realviews_model = Ridge(alpha=1.0).fit(
                    equation_inputs,
                    np.log10(
                        np.asarray(
                            [
                                float(train[index][1]["views"])
                                for index in valid_equation
                            ]
                        )
                        + 1
                    ),
                )
        axis = public_axes[modality]
        for row_index, row in enumerate(eval_rows):
            vector_index = store["index"].get(row["id"])
            if vector_index is None:
                continue
            vector = store["vectors"][vector_index : vector_index + 1]
            keep_prediction = float(keep_model.predict(vector)[0]) if keep_model is not None else np.nan
            ret5_prediction = float(ret5_model.predict(vector)[0]) if ret5_model is not None else np.nan
            views_prediction = float(axis["views"].predict(vector)[0])
            outlier_prediction = float(axis["outlier"].predict(vector)[0])
            hit_prediction = (
                float(axis["hit10m"].predict_proba(vector)[0, 1])
                if axis["hit10m"] is not None
                else np.nan
            )
            duration = float(row["duration"]) if finite(row.get("duration")) else 30.0
            realviews = np.nan
            if realviews_model is not None and finite(keep_prediction) and finite(ret5_prediction):
                realviews = float(
                    realviews_model.predict(
                        [[keep_prediction, ret5_prediction, math.log10(duration + 1)]]
                    )[0]
                )
            output[row_index, column : column + 6] = [
                keep_prediction,
                ret5_prediction,
                views_prediction,
                realviews,
                outlier_prediction,
                hit_prediction,
            ]
        for key in novelty_columns:
            values = np.full(len(eval_rows), np.nan, dtype=float)
            source = np.asarray(axis[f"novelty_{key}"])
            for row_index, row in enumerate(eval_rows):
                vector_index = store["index"].get(row["id"])
                if vector_index is not None:
                    values[row_index] = source[vector_index]
            novelty_columns[key].append(values)
        column += 6
    for offset, key in enumerate(("temporal", "niche", "combinatorial")):
        stack = np.column_stack(novelty_columns[key])
        stack[~np.isfinite(stack)] = np.nan
        output[:, 18 + offset] = np.nanmean(stack, axis=1)
    text_store = stores["text"]
    for row_index, row in enumerate(eval_rows):
        output[row_index, 21] = 1.0 if row["id"] in text_store["index"] else 0.0
        output[row_index, 22] = (
            math.log10(float(row["duration"]) + 1) if finite(row.get("duration")) else np.nan
        )
        output[row_index, 23] = float(len(str(row.get("title") or "").split()))
    return output


def private_crossfit_raw_features(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
) -> np.ndarray:
    if len(rows) < 8:
        return private_raw_features(rows, rows, stores, public_axes)
    folds = within_group_folds(rows, "account", min(4, len(rows)))
    output = np.full((len(rows), len(PRIVATE_RAW_FEATURE_NAMES)), np.nan, dtype=float)
    for fold in sorted(set(int(value) for value in folds)):
        train = [row for index, row in enumerate(rows) if folds[index] != fold]
        eval_indices = [index for index in range(len(rows)) if folds[index] == fold]
        evaluated = [rows[index] for index in eval_indices]
        if train and evaluated:
            output[eval_indices] = private_raw_features(
                train,
                evaluated,
                stores,
                public_axes,
            )
    return output


def private_base_features(
    train_rows: list[dict[str, Any]],
    eval_rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
) -> np.ndarray:
    raw_eval = private_raw_features(train_rows, eval_rows, stores, public_axes)
    raw_reference = private_crossfit_raw_features(train_rows, stores, public_axes)
    output = np.full((len(eval_rows), len(PRIVATE_FEATURE_NAMES)), np.nan, dtype=float)
    for signal_index in range(len(PRIVATE_SIGNAL_NAMES)):
        values = raw_eval[:, signal_index]
        reference = np.sort(
            raw_reference[np.isfinite(raw_reference[:, signal_index]), signal_index]
        )
        output[:, signal_index * 2] = values
        if len(reference):
            valid = np.isfinite(values)
            output[valid, signal_index * 2 + 1] = (
                np.searchsorted(reference, values[valid], side="right") / len(reference)
            )
    output[:, len(PRIVATE_SIGNAL_NAMES) * 2 :] = raw_eval[
        :, len(PRIVATE_SIGNAL_NAMES) :
    ]
    return output


def impute_scale(
    train: np.ndarray,
    test: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray, np.ndarray, np.ndarray]:
    train = np.asarray(train, dtype=float)
    medians = np.asarray(
        [
            np.nanmedian(train[:, column])
            if np.isfinite(train[:, column]).any()
            else 0.0
            for column in range(train.shape[1])
        ],
        dtype=float,
    )
    train_filled = np.where(np.isfinite(train), train, medians)
    means = train_filled.mean(axis=0)
    scales = train_filled.std(axis=0)
    scales[scales < 1e-9] = 1
    train_scaled = (train_filled - means) / scales
    test_scaled = None
    if test is not None:
        test_filled = np.where(np.isfinite(test), test, medians)
        test_scaled = (test_filled - means) / scales
    return train_scaled, test_scaled, medians, means, scales


def candidate_registry(feature_count: int, count: int = EXPERIMENT_COUNT) -> list[tuple[int, ...]]:
    candidates: list[tuple[int, ...]] = []
    for size in range(1, feature_count + 1):
        if len(candidates) >= count:
            break
        pool = list(itertools.combinations(range(feature_count), size))
        remaining = count - len(candidates)
        if len(pool) <= remaining:
            candidates.extend(pool)
        else:
            pool.sort(key=lambda item: stable_hash(",".join(map(str, item))))
            candidates.extend(pool[:remaining])
            break
    return candidates


def deterministic_folds(ids: list[str], requested: int = 5) -> np.ndarray:
    folds = max(2, min(requested, len(ids) // 8))
    order = sorted(range(len(ids)), key=lambda index: (stable_hash(ids[index]), index))
    assigned = np.zeros(len(ids), dtype=int)
    for position, index in enumerate(order):
        assigned[index] = position % folds
    return assigned


def group_folds(groups: list[str], requested: int = 5) -> np.ndarray:
    unique = sorted(set(groups), key=stable_hash)
    if len(unique) < 2:
        return deterministic_folds([str(index) for index in range(len(groups))], requested)
    fold_count = min(requested, len(unique))
    mapping = {group: index % fold_count for index, group in enumerate(unique)}
    return np.asarray([mapping[group] for group in groups], dtype=int)


def within_group_folds(rows: list[dict[str, Any]], group_key: str, requested: int = 5) -> np.ndarray:
    assigned = np.zeros(len(rows), dtype=int)
    by_group: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        by_group[str(row[group_key])].append(index)
    for indices in by_group.values():
        indices.sort(key=lambda index: (stable_hash(rows[index]["id"]), index))
        for position, index in enumerate(indices):
            assigned[index] = position % requested
    return assigned


def expanding_time_splits(
    rows: list[dict[str, Any]],
    timestamp_key: str = "publishedAt",
    initial_fraction: float = 0.6,
    windows: int = 4,
) -> list[tuple[list[dict[str, Any]], list[dict[str, Any]]]]:
    dated = sorted(
        [row for row in rows if finite(row.get(timestamp_key))],
        key=lambda row: (float(row[timestamp_key]), stable_hash(row["id"])),
    )
    unique_times = sorted({float(row[timestamp_key]) for row in dated})
    if len(unique_times) < windows + 2:
        return []
    start = max(1, int(len(unique_times) * initial_fraction))
    boundaries = np.linspace(start, len(unique_times), windows + 1).round().astype(int)
    output = []
    for window in range(windows):
        train_position = min(max(1, int(boundaries[window])), len(unique_times) - 1)
        test_position = min(max(train_position + 1, int(boundaries[window + 1])), len(unique_times))
        train_through = unique_times[train_position - 1]
        test_through = unique_times[test_position - 1]
        train_rows = [row for row in dated if float(row[timestamp_key]) <= train_through]
        test_rows = [
            row
            for row in dated
            if train_through < float(row[timestamp_key]) <= test_through
        ]
        if train_rows and test_rows:
            output.append((train_rows, test_rows))
    return output


def search_candidates(
    X: np.ndarray,
    y: np.ndarray,
    folds: np.ndarray,
    candidates: list[tuple[int, ...]],
    top_n: int = 100,
    alpha: float = 2.0,
) -> list[dict[str, Any]]:
    datasets = []
    for fold in sorted(set(int(value) for value in folds)):
        train = folds != fold
        test = ~train
        if train.sum() < 4 or test.sum() < 2:
            continue
        datasets.append((X[train], y[train], X[test], y[test]))
    return search_candidate_datasets(datasets, candidates, top_n, alpha)


def search_candidate_datasets(
    datasets: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]],
    candidates: list[tuple[int, ...]],
    top_n: int = 100,
    alpha: float = 2.0,
) -> list[dict[str, Any]]:
    statistics = []
    baseline_sse = 0.0
    for train_X, train_y, test_X, test_y in datasets:
        if len(train_y) < 4 or len(test_y) < 2:
            continue
        train_scaled, test_scaled, _, _, _ = impute_scale(train_X, test_X)
        train_design = np.column_stack([np.ones(len(train_y)), train_scaled])
        test_design = np.column_stack([np.ones(len(test_y)), test_scaled])
        statistics.append(
            {
                "trainXtX": train_design.T @ train_design,
                "trainXty": train_design.T @ train_y,
                "testXtX": test_design.T @ test_design,
                "testXty": test_design.T @ test_y,
                "testYty": float(test_y @ test_y),
            }
        )
        baseline_sse += float(np.sum((test_y - train_y.mean()) ** 2))
    if not statistics:
        raise RuntimeError("candidate search has no valid training/validation datasets")
    leaderboard: list[tuple[float, tuple[int, ...]]] = []
    for candidate in candidates:
        indices = np.asarray((0,) + tuple(index + 1 for index in candidate), dtype=int)
        sse = 0.0
        for stats in statistics:
            xtx = stats["trainXtX"][np.ix_(indices, indices)].copy()
            xty = stats["trainXty"][indices]
            if len(indices) > 1:
                xtx[1:, 1:] += np.eye(len(indices) - 1) * alpha
            xtx[0, 0] += 1e-8
            try:
                coefficients = np.linalg.solve(xtx, xty)
            except np.linalg.LinAlgError:
                coefficients = np.linalg.pinv(xtx) @ xty
            test_xtx = stats["testXtX"][np.ix_(indices, indices)]
            test_xty = stats["testXty"][indices]
            sse += float(stats["testYty"] - 2 * coefficients @ test_xty + coefficients @ test_xtx @ coefficients)
        score = 1 - sse / baseline_sse if baseline_sse > 0 else -math.inf
        if len(leaderboard) < top_n:
            leaderboard.append((score, candidate))
            if len(leaderboard) == top_n:
                leaderboard.sort(key=lambda item: item[0])
        elif score > leaderboard[0][0]:
            leaderboard[0] = (score, candidate)
            leaderboard.sort(key=lambda item: item[0])
    return [
        {"score": clean_number(score), "indices": list(candidate)}
        for score, candidate in sorted(leaderboard, key=lambda item: item[0], reverse=True)
    ]


def fit_subset(
    X: np.ndarray,
    y: np.ndarray,
    indices: list[int],
    test: np.ndarray | None = None,
    alpha: float = 2.0,
) -> tuple[np.ndarray | None, dict[str, Any]]:
    train_scaled, test_scaled, medians, means, scales = impute_scale(X[:, indices], None if test is None else test[:, indices])
    model = Ridge(alpha=alpha).fit(train_scaled, y)
    prediction = model.predict(test_scaled) if test_scaled is not None else None
    return prediction, {
        "indices": indices,
        "alpha": float(alpha),
        "intercept": float(model.intercept_),
        "coefficients": [float(value) for value in model.coef_],
        "medians": [float(value) for value in medians],
        "means": [float(value) for value in means],
        "scales": [float(value) for value in scales],
    }


def cross_fit_subset(
    X: np.ndarray,
    y: np.ndarray,
    indices: list[int],
    folds: np.ndarray,
    alpha: float = 2.0,
) -> np.ndarray:
    prediction = np.full(len(y), np.nan, dtype=float)
    for fold in sorted(set(int(value) for value in folds)):
        train = folds != fold
        test = ~train
        if train.sum() < 4 or test.sum() < 1:
            continue
        fold_prediction, _ = fit_subset(X[train], y[train], indices, X[test], alpha)
        prediction[test] = fold_prediction
    return prediction


def select_ridge_alpha(
    X: np.ndarray,
    y: np.ndarray,
    indices: list[int],
    folds: np.ndarray,
) -> float:
    best_alpha, best_score = 2.0, -math.inf
    for alpha in (0.1, 1.0, 10.0, 100.0, 1000.0):
        prediction = cross_fit_subset(X, y, indices, folds, alpha)
        valid = np.isfinite(prediction)
        if valid.sum() < 8:
            continue
        score = regression_metrics(y[valid], prediction[valid])["r2"]
        numeric_score = float(score) if finite(score) else -math.inf
        if numeric_score > best_score:
            best_alpha, best_score = alpha, numeric_score
    return best_alpha


def select_ridge_alpha_datasets(
    datasets: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]],
    indices: list[int],
) -> float:
    best_alpha, best_score = 2.0, -math.inf
    for alpha in (0.1, 1.0, 10.0, 100.0, 1000.0):
        actual, predicted = [], []
        for train_X, train_y, test_X, test_y in datasets:
            if len(train_y) < 4 or not len(test_y):
                continue
            estimate, _ = fit_subset(
                train_X,
                train_y,
                indices,
                test_X,
                alpha,
            )
            actual.extend(np.asarray(test_y, dtype=float).tolist())
            predicted.extend(np.asarray(estimate, dtype=float).tolist())
        if len(actual) < 8:
            continue
        score = regression_metrics(
            np.asarray(actual, dtype=float),
            np.asarray(predicted, dtype=float),
        )["r2"]
        numeric_score = float(score) if finite(score) else -math.inf
        if numeric_score > best_score:
            best_alpha, best_score = alpha, numeric_score
    return best_alpha


def select_sparse_ridge_alpha(
    X: np.ndarray,
    y: np.ndarray,
    folds: np.ndarray,
    candidates: list[tuple[int, ...]],
) -> float:
    low_order = [candidate for candidate in candidates if len(candidate) <= 2]
    best_alpha, best_score = 2.0, -math.inf
    for alpha in (0.1, 1.0, 10.0, 100.0, 1000.0):
        row = search_candidates(
            X,
            y,
            folds,
            low_order,
            top_n=1,
            alpha=alpha,
        )[0]
        score = float(row["score"]) if finite(row.get("score")) else -math.inf
        if score > best_score:
            best_alpha, best_score = alpha, score
    return best_alpha


def select_sparse_ridge_alpha_datasets(
    datasets: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]],
    candidates: list[tuple[int, ...]],
) -> float:
    low_order = [candidate for candidate in candidates if len(candidate) <= 2]
    best_alpha, best_score = 2.0, -math.inf
    for alpha in (0.1, 1.0, 10.0, 100.0, 1000.0):
        row = search_candidate_datasets(
            datasets,
            low_order,
            top_n=1,
            alpha=alpha,
        )[0]
        score = float(row["score"]) if finite(row.get("score")) else -math.inf
        if score > best_score:
            best_alpha, best_score = alpha, score
    return best_alpha


def search_with_sparse_alpha(
    X: np.ndarray,
    y: np.ndarray,
    folds: np.ndarray,
    candidates: list[tuple[int, ...]],
    top_n: int,
) -> tuple[list[dict[str, Any]], float]:
    sparse_alpha = select_sparse_ridge_alpha(
        X,
        y,
        folds,
        candidates,
    )
    leaderboard = search_candidates(
        X,
        y,
        folds,
        candidates,
        top_n=top_n,
        alpha=sparse_alpha,
    )
    for row in leaderboard:
        row["alpha"] = sparse_alpha
    return leaderboard, sparse_alpha


def search_datasets_with_sparse_alpha(
    datasets: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]],
    candidates: list[tuple[int, ...]],
    top_n: int,
) -> tuple[list[dict[str, Any]], float]:
    if not datasets:
        raise RuntimeError("nested candidate selection has no valid folds")
    sparse_alpha = select_sparse_ridge_alpha_datasets(
        datasets,
        candidates,
    )
    leaderboard = search_candidate_datasets(
        datasets,
        candidates,
        top_n=top_n,
        alpha=sparse_alpha,
    )
    for row in leaderboard:
        row["alpha"] = sparse_alpha
    return leaderboard, sparse_alpha


def regression_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, Any]:
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    if not len(actual):
        return {
            "n": 0,
            "r2": None,
            "pearson": None,
            "spearman": None,
            "mae": None,
            "rmse": None,
            "calibrationSlope": None,
            "calibrationIntercept": None,
            "residualP10": None,
            "residualP90": None,
        }
    residual = actual - predicted
    baseline_sse = float(np.sum((actual - actual.mean()) ** 2))
    sse = float(residual @ residual)
    correlation = np.corrcoef(actual, predicted)[0, 1] if actual.std() > 0 and predicted.std() > 0 else np.nan
    rank_correlation = (
        spearmanr(actual, predicted).statistic
        if len(actual) >= 3 and actual.std() > 1e-12 and predicted.std() > 1e-12
        else np.nan
    )
    calibration = (
        np.polyfit(predicted, actual, 1)
        if len(actual) >= 2 and predicted.std() > 1e-9
        else [np.nan, np.nan]
    )
    return {
        "n": int(len(actual)),
        "r2": clean_number(1 - sse / baseline_sse if baseline_sse > 0 else None),
        "pearson": clean_number(correlation),
        "spearman": clean_number(rank_correlation),
        "mae": clean_number(np.mean(np.abs(residual))),
        "rmse": clean_number(np.sqrt(np.mean(residual**2))),
        "calibrationSlope": clean_number(calibration[0]),
        "calibrationIntercept": clean_number(calibration[1]),
        "residualP10": clean_number(np.quantile(residual, 0.1)),
        "residualP90": clean_number(np.quantile(residual, 0.9)),
    }


def log_view_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, Any]:
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    metrics = regression_metrics(actual, predicted)
    if not len(actual):
        metrics["medianFactorError"] = None
        metrics["geometricMeanFactorError"] = None
        return metrics
    absolute_log_error = np.abs(actual - predicted)
    metrics["medianFactorError"] = clean_number(
        10 ** float(np.median(absolute_log_error))
    )
    metrics["geometricMeanFactorError"] = clean_number(
        10 ** float(np.mean(absolute_log_error))
    )
    return metrics


def source_level_summary(folds: list[dict[str, Any]]) -> dict[str, Any]:
    metric_keys = ("r2", "spearman", "mae", "medianFactorError")
    source_count = len(folds)
    summary: dict[str, Any] = {
        "independentSources": source_count,
        "intervalCaveat": (
            "Descriptive source bootstrap only; fewer than ten heterogeneous sources cannot support a population-level 95% inference."
            if source_count < 10
            else "Descriptive source bootstrap over observed creators; the channel sample is not a random population sample."
        ),
        "perSource": [
            {
                "source": fold.get("heldOutName")
                or fold.get("heldOutAccount")
                or fold.get("heldOutChannel"),
                "n": (fold.get("metrics") or {}).get("n"),
                **{
                    key: (fold.get("metrics") or {}).get(key)
                    for key in metric_keys
                    if key in (fold.get("metrics") or {})
                },
            }
            for fold in folds
        ],
    }
    for key in metric_keys:
        values = np.asarray(
            [
                float((fold.get("metrics") or {})[key])
                for fold in folds
                if finite((fold.get("metrics") or {}).get(key))
            ],
            dtype=float,
        )
        if not len(values):
            continue
        rng = np.random.default_rng(stable_hash(f"source-bootstrap:{key}") % (2**32))
        bootstrap = np.asarray(
            [
                np.mean(rng.choice(values, size=len(values), replace=True))
                for _ in range(2_000)
            ]
        )
        summary[f"macro{key[0].upper()}{key[1:]}"] = clean_number(np.mean(values))
        summary[f"macro{key[0].upper()}{key[1:]}Low95"] = clean_number(
            np.quantile(bootstrap, 0.025)
        )
        summary[f"macro{key[0].upper()}{key[1:]}High95"] = clean_number(
            np.quantile(bootstrap, 0.975)
        )
    return summary


def prediction_source_summary(
    ids: list[str],
    actual: np.ndarray,
    predicted: np.ndarray,
    library: dict[str, dict[str, Any]],
    minimum_source_rows: int = 8,
) -> dict[str, Any]:
    grouped: dict[str, list[int]] = defaultdict(list)
    for index, video_id in enumerate(ids):
        video = library.get(video_id) or {}
        source = str(
            video.get("channelId")
            or video.get("channel")
            or video.get("channelTitle")
            or ""
        )
        if source:
            grouped[source].append(index)
    folds = []
    for source, indices in grouped.items():
        valid = np.asarray(
            [
                index
                for index in indices
                if finite(actual[index]) and finite(predicted[index])
            ],
            dtype=int,
        )
        if len(valid) < minimum_source_rows:
            continue
        video = library.get(ids[int(valid[0])]) or {}
        folds.append(
            {
                "heldOutChannel": source,
                "heldOutName": str(
                    video.get("channel")
                    or video.get("channelTitle")
                    or source
                ),
                "metrics": log_view_metrics(actual[valid], predicted[valid]),
            }
        )
    summary = source_level_summary(folds)
    summary["allObservedSources"] = len(grouped)
    summary["minimumRowsPerReportedSource"] = minimum_source_rows
    summary["coveredVideos"] = sum(
        int((fold.get("metrics") or {}).get("n") or 0) for fold in folds
    )
    return summary


def prediction_age_cohorts(
    ids: list[str],
    actual: np.ndarray,
    predicted: np.ndarray,
    library: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    now_ms = time.time() * 1000
    ages = np.full(len(ids), np.nan, dtype=float)
    for index, video_id in enumerate(ids):
        video = library.get(video_id) or {}
        published_at = next(
            (
                parsed
                for parsed in (
                    parse_date(video.get("uploadDate")),
                    parse_date(video.get("published")),
                    parse_date(video.get("publishedAt")),
                )
                if finite(parsed)
            ),
            None,
        )
        if finite(published_at) and float(published_at) <= now_ms:
            ages[index] = (now_ms - float(published_at)) / 86400000
    output = []
    for minimum_days in (30, 90, 180, 365):
        cohort = (
            np.isfinite(ages)
            & (ages >= minimum_days)
            & np.isfinite(actual)
            & np.isfinite(predicted)
        )
        if cohort.sum() < 50:
            continue
        output.append(
            {
                "minimumAgeDays": minimum_days,
                "metrics": log_view_metrics(actual[cohort], predicted[cohort]),
            }
        )
    return output


def calibration_bins(actual: np.ndarray, predicted: np.ndarray, bins: int = 10) -> list[dict[str, Any]]:
    if not len(actual):
        return []
    order = np.argsort(predicted)
    output = []
    for index, points in enumerate(np.array_split(order, min(bins, len(order)))):
        if not len(points):
            continue
        output.append(
            {
                "bin": index + 1,
                "n": int(len(points)),
                "predicted": clean_number(np.mean(predicted[points])),
                "actual": clean_number(np.mean(actual[points])),
                "predictedLow": clean_number(np.min(predicted[points])),
                "predictedHigh": clean_number(np.max(predicted[points])),
            }
        )
    return output


def relationship_bins(
    values: np.ndarray,
    target: np.ndarray,
    bins: int = 10,
) -> list[dict[str, Any]]:
    values = np.asarray(values, dtype=float)
    target = np.asarray(target, dtype=float)
    valid = np.isfinite(values) & np.isfinite(target)
    indices = np.flatnonzero(valid)
    if len(indices) < 8:
        return []
    indices = indices[np.argsort(values[indices], kind="mergesort")]
    output = []
    for points in np.array_split(indices, min(bins, len(indices))):
        if not len(points):
            continue
        output.append(
            {
                "n": int(len(points)),
                "inputLow": clean_number(np.min(values[points])),
                "inputMedian": clean_number(np.median(values[points])),
                "inputHigh": clean_number(np.max(values[points])),
                "targetMean": clean_number(np.mean(target[points])),
                "targetMedian": clean_number(np.median(target[points])),
            }
        )
    return output


def within_source_center(
    values: np.ndarray,
    groups: list[str],
) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    if len(values) != len(groups):
        raise ValueError("source labels must align with values")
    centered = np.full(len(values), np.nan, dtype=float)
    group_array = np.asarray([str(group) for group in groups], dtype=object)
    for group in sorted(set(group_array.tolist()), key=stable_hash):
        members = (group_array == group) & np.isfinite(values)
        if members.any():
            centered[members] = values[members] - float(np.mean(values[members]))
    return centered


def within_source_metrics(
    actual: np.ndarray,
    predicted: np.ndarray,
    groups: list[str],
    *,
    log_views: bool = False,
) -> dict[str, Any]:
    actual_centered = within_source_center(actual, groups)
    predicted_centered = within_source_center(predicted, groups)
    valid = np.isfinite(actual_centered) & np.isfinite(predicted_centered)
    metrics = (
        log_view_metrics(actual_centered[valid], predicted_centered[valid])
        if log_views
        else regression_metrics(actual_centered[valid], predicted_centered[valid])
    )
    metrics["groups"] = len(set(str(group) for group in groups))
    metrics["method"] = (
        "OOF predictions and outcomes centered within each observed source; "
        "descriptive video-level lift after removing source means"
    )
    return metrics


def observed_source_summary(
    actual: np.ndarray,
    predicted: np.ndarray,
    groups: list[str],
    names: list[str],
    *,
    log_views: bool = False,
) -> dict[str, Any]:
    if not (len(actual) == len(predicted) == len(groups) == len(names)):
        raise ValueError("source summary inputs must align")
    group_array = np.asarray([str(group) for group in groups], dtype=object)
    folds = []
    for group in sorted(set(group_array.tolist()), key=stable_hash):
        members = np.flatnonzero(group_array == group)
        metric = (
            log_view_metrics(np.asarray(actual)[members], np.asarray(predicted)[members])
            if log_views
            else regression_metrics(np.asarray(actual)[members], np.asarray(predicted)[members])
        )
        folds.append(
            {
                "heldOutName": next(
                    str(names[index]) for index in members if str(names[index])
                ),
                "metrics": metric,
            }
        )
    return source_level_summary(folds)


def within_source_rank_test(
    values: np.ndarray,
    target: np.ndarray,
    groups: list[str],
    seed: str,
    permutations: int = 1_000,
) -> tuple[float | None, float | None]:
    values = np.asarray(values, dtype=float)
    target = np.asarray(target, dtype=float)
    group_array = np.asarray([str(group) for group in groups], dtype=object)
    valid = np.isfinite(values) & np.isfinite(target)
    if valid.sum() < 8 or len(set(group_array[valid].tolist())) < 2:
        return None, None
    value_ranks = rankdata(values[valid])
    target_ranks = rankdata(target[valid])
    valid_groups = group_array[valid]
    value_centered = within_source_center(value_ranks, valid_groups.tolist())
    target_centered = within_source_center(target_ranks, valid_groups.tolist())
    denominator = float(np.linalg.norm(value_centered) * np.linalg.norm(target_centered))
    if denominator <= EPSILON:
        return None, None
    observed = float(value_centered @ target_centered / denominator)
    rng = np.random.default_rng(stable_hash(f"within-source-rank:{seed}") % (2**32))
    members = [
        np.flatnonzero(valid_groups == group)
        for group in sorted(set(valid_groups.tolist()), key=stable_hash)
    ]
    exceed = 0
    shuffled = target_centered.copy()
    for _ in range(permutations):
        for indices in members:
            shuffled[indices] = rng.permutation(target_centered[indices])
        statistic = float(value_centered @ shuffled / denominator)
        if abs(statistic) >= abs(observed) - 1e-12:
            exceed += 1
    return observed, (exceed + 1) / (permutations + 1)


def add_fdr_q_values(rows: list[dict[str, Any]], p_key: str = "pValue") -> None:
    ranked = sorted(
        [
            (index, float(row[p_key]))
            for index, row in enumerate(rows)
            if finite(row.get(p_key))
        ],
        key=lambda item: item[1],
    )
    running = 1.0
    total = len(ranked)
    for reverse_rank in range(total - 1, -1, -1):
        index, p_value = ranked[reverse_rank]
        rank = reverse_rank + 1
        running = min(running, p_value * total / rank)
        rows[index]["fdrQ"] = clean_number(min(1.0, running), 8)


def sampled_view_points(
    ids: list[str],
    actual_log_views: np.ndarray,
    predicted_log_views: np.ndarray,
    library: dict[str, dict[str, Any]],
    limit: int = 600,
) -> list[dict[str, Any]]:
    actual = np.asarray(actual_log_views, dtype=float)
    predicted = np.asarray(predicted_log_views, dtype=float)
    valid = np.flatnonzero(np.isfinite(actual) & np.isfinite(predicted))
    if not len(valid):
        return []
    ordered = valid[np.argsort(actual[valid], kind="mergesort")]
    if len(ordered) > limit:
        ordered = ordered[np.unique(np.linspace(0, len(ordered) - 1, limit).round().astype(int))]
    return [
        {
            "id": ids[index],
            "title": str((library.get(ids[index]) or {}).get("title") or ids[index]),
            "actualViews": max(0, round(10 ** actual[index] - 1)),
            "predictedViews": max(0, round(10 ** predicted[index] - 1)),
            "actualLogViews": clean_number(actual[index]),
            "predictedLogViews": clean_number(predicted[index]),
        }
        for index in ordered
    ]


def binary_metrics(actual: np.ndarray, score: np.ndarray) -> dict[str, Any]:
    actual = np.asarray(actual, dtype=int)
    score = np.asarray(score, dtype=float)
    if actual.sum() == 0 or actual.sum() == len(actual):
        output = {
            "n": int(len(actual)),
            "positives": int(actual.sum()),
            "baseRate": clean_number(actual.mean()),
            "auc": None,
        }
    else:
        output = {
            "n": int(len(actual)),
            "positives": int(actual.sum()),
            "baseRate": clean_number(actual.mean()),
            "auc": clean_number(roc_auc_score(actual, score)),
        }
    clipped = np.clip(score, 1e-6, 1 - 1e-6)
    output["brier"] = clean_number(np.mean((clipped - actual) ** 2))
    output["logLoss"] = clean_number(
        -np.mean(actual * np.log(clipped) + (1 - actual) * np.log(1 - clipped))
    )
    return output


def wilson_interval(positives: int, total: int, z: float = 1.96) -> tuple[float, float]:
    if total <= 0:
        return 0.0, 1.0
    rate = positives / total
    denominator = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / denominator
    margin = (
        z
        * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))
        / denominator
    )
    return max(0.0, center - margin), min(1.0, center + margin)


def clustered_rate_interval(
    actual: np.ndarray,
    groups: list[str],
    points: np.ndarray,
    seed: str,
) -> tuple[float, float] | None:
    point_groups = np.asarray([str(groups[index]) for index in points], dtype=object)
    unique = sorted(set(point_groups.tolist()), key=stable_hash)
    if len(unique) < 2:
        return None
    values = np.asarray(actual, dtype=float)[points]
    by_group = {
        group: values[point_groups == group]
        for group in unique
    }
    rng = np.random.default_rng(stable_hash(seed) % (2**32))
    estimates = []
    for _ in range(2_000):
        sampled = rng.choice(unique, size=len(unique), replace=True)
        draw = np.concatenate([by_group[str(group)] for group in sampled])
        if len(draw):
            estimates.append(float(np.mean(draw)))
    if not estimates:
        return None
    return (
        float(np.quantile(estimates, 0.025)),
        float(np.quantile(estimates, 0.975)),
    )


def threshold_diagnostics(
    actual_views: np.ndarray,
    predicted_log_views: np.ndarray,
    residual_samples: list[np.ndarray | None] | None = None,
    groups: list[str] | None = None,
) -> list[dict[str, Any]]:
    actual_views = np.asarray(actual_views, dtype=float)
    predicted_log_views = np.asarray(predicted_log_views, dtype=float)
    if residual_samples is None:
        raise ValueError(
            "tail probabilities require residuals from a separate outer-training calibration"
        )
    if not len(actual_views):
        return []
    if groups is not None and len(groups) != len(actual_views):
        raise ValueError("tail-probability groups must align with outcomes")
    output = []
    for target in (100_000, 1_000_000, 10_000_000, 50_000_000, 100_000_000):
        target_log = math.log10(target + 1)
        probability = np.zeros(len(actual_views), dtype=float)
        for index, estimate in enumerate(predicted_log_views):
            samples = residual_samples[index]
            samples = np.asarray(samples if samples is not None else [], dtype=float)
            samples = samples[np.isfinite(samples)]
            if not len(samples):
                probability[index] = 0.5
                continue
            hits = int(np.sum(estimate + samples >= target_log))
            probability[index] = (hits + 1) / (len(samples) + 2)
        actual = (actual_views >= target).astype(int)
        metric = binary_metrics(actual, probability)
        base_rate = float(actual.mean())
        null_brier = float(np.mean((base_rate - actual) ** 2))
        metric["brierSkillVsBaseRate"] = clean_number(
            1 - float(metric["brier"]) / null_brier
            if null_brier > EPSILON and finite(metric.get("brier"))
            else None
        )
        bins = []
        weighted_error = 0.0
        for points in np.array_split(np.argsort(probability), min(8, len(probability))):
            if not len(points):
                continue
            positives = int(actual[points].sum())
            video_low, video_high = wilson_interval(positives, len(points))
            clustered = (
                clustered_rate_interval(
                    actual,
                    groups,
                    points,
                    f"tail:{target}:{len(bins)}",
                )
                if groups is not None
                else None
            )
            low, high = clustered or (video_low, video_high)
            predicted_probability = float(probability[points].mean())
            observed_rate = float(actual[points].mean())
            weighted_error += len(points) / len(actual) * abs(
                predicted_probability - observed_rate
            )
            bins.append(
                {
                    "n": int(len(points)),
                    "predictedProbability": clean_number(predicted_probability),
                    "observedHitRate": clean_number(observed_rate),
                    "observedLow95": clean_number(low),
                    "observedHigh95": clean_number(high),
                    "videoWilsonLow95": clean_number(video_low),
                    "videoWilsonHigh95": clean_number(video_high),
                    "independentSources": (
                        len({groups[index] for index in points})
                        if groups is not None
                        else None
                    ),
                    "medianActualViews": clean_number(np.median(actual_views[points]), 0),
                }
            )
        output.append(
            {
                "targetViews": target,
                "method": "fully nested outer-training empirical residual CDF with Laplace smoothing",
                "intervalMethod": (
                    "source-cluster bootstrap; video-level Wilson retained as a descriptive reference"
                    if groups is not None
                    else "video-level Wilson"
                ),
                **metric,
                "expectedCalibrationError": clean_number(weighted_error),
                "calibration": bins,
            }
        )
    return output


def make_formula(model: dict[str, Any], feature_names: list[str], target_unit: str) -> dict[str, Any]:
    terms = []
    for local_index, feature_index in enumerate(model["indices"]):
        terms.append(
            {
                "feature": feature_names[feature_index],
                "weight": clean_number(model["coefficients"][local_index]),
                "median": clean_number(model["medians"][local_index]),
                "mean": clean_number(model["means"][local_index]),
                "scale": clean_number(model["scales"][local_index]),
            }
        )
    formula = {
        "targetUnit": target_unit,
        "intercept": clean_number(model["intercept"]),
        "terms": terms,
        "plainEnglish": "intercept + sum(weight × standardized feature); missing values use the training-fold median",
    }
    if finite(model.get("alpha")):
        formula["alpha"] = clean_number(model["alpha"])
    return formula


def private_inner_oof(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
) -> np.ndarray:
    groups = sorted(set(row["account"] for row in rows), key=stable_hash)
    output = np.full((len(rows), len(PRIVATE_FEATURE_NAMES)), np.nan)
    if len(groups) < 2:
        return private_base_features(rows, rows, stores, public_axes)
    for group in groups:
        train = [row for row in rows if row["account"] != group]
        eval_indices = [index for index, row in enumerate(rows) if row["account"] == group]
        evaluated = [rows[index] for index in eval_indices]
        output[eval_indices] = private_base_features(train, evaluated, stores, public_axes)
    return output


def private_fold_oof(
    rows: list[dict[str, Any]],
    folds: np.ndarray,
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
) -> np.ndarray:
    output = np.full((len(rows), len(PRIVATE_FEATURE_NAMES)), np.nan)
    for fold in sorted(set(int(value) for value in folds)):
        train = [row for index, row in enumerate(rows) if folds[index] != fold]
        eval_indices = [index for index in range(len(rows)) if folds[index] == fold]
        evaluated = [rows[index] for index in eval_indices]
        output[eval_indices] = private_base_features(train, evaluated, stores, public_axes)
    return output


def private_selection_datasets(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
    split_mode: str = "within",
    requested: int = 4,
) -> list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
    if split_mode == "group":
        folds = group_folds([str(row["account"]) for row in rows], requested)
    else:
        folds = within_group_folds(rows, "account", requested)
    datasets = []
    for fold in sorted(set(int(value) for value in folds)):
        train_rows = [row for index, row in enumerate(rows) if folds[index] != fold]
        test_rows = [row for index, row in enumerate(rows) if folds[index] == fold]
        if len(train_rows) < 8 or len(test_rows) < 2:
            continue
        if split_mode == "group":
            train_features = private_inner_oof(
                train_rows,
                stores,
                public_axes,
            )
        else:
            tertiary_folds = within_group_folds(
                train_rows,
                "account",
                min(3, max(2, len(train_rows) // 8)),
            )
            train_features = private_fold_oof(
                train_rows,
                tertiary_folds,
                stores,
                public_axes,
            )
        test_features = private_base_features(
            train_rows,
            test_rows,
            stores,
            public_axes,
        )
        datasets.append(
            (
                train_features,
                np.asarray([row["keep"] for row in train_rows], dtype=float),
                test_features,
                np.asarray([row["keep"] for row in test_rows], dtype=float),
            )
        )
    return datasets


def group_residual_adjustments(
    rows: list[dict[str, Any]],
    actual: np.ndarray,
    predicted: np.ndarray,
    group_key: str,
) -> dict[str, float]:
    residuals: dict[str, list[float]] = defaultdict(list)
    for row, truth, estimate in zip(rows, actual, predicted):
        residuals[str(row[group_key])].append(float(truth - estimate))
    return {group: float(np.mean(values)) for group, values in residuals.items() if values}


def run_keep_known_video(
    eligible: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
    candidates: list[tuple[int, ...]],
) -> dict[str, Any]:
    outer_folds = within_group_folds(eligible, "account", 5)
    actual_all: list[float] = []
    content_all: list[float] = []
    calibrated_all: list[float] = []
    all_input_all: list[float] = []
    points: list[dict[str, Any]] = []
    fold_results = []
    selected: Counter = Counter()
    fold_values = sorted(set(outer_folds.tolist()))
    for fold_position, fold in enumerate(fold_values, 1):
        update_status(
            "keep",
            phase="known-account-interpolation",
            completed=fold_position - 1,
            total=len(fold_values),
            message=f"Keep rate: nested known-account fold {fold_position} of {len(fold_values)}",
        )
        train_rows = [row for index, row in enumerate(eligible) if outer_folds[index] != fold]
        test_rows = [row for index, row in enumerate(eligible) if outer_folds[index] == fold]
        inner_folds = within_group_folds(train_rows, "account", 4)
        inner_features = private_fold_oof(train_rows, inner_folds, stores, public_axes)
        train_target = np.asarray([row["keep"] for row in train_rows], dtype=float)
        selection_datasets = private_selection_datasets(
            train_rows,
            stores,
            public_axes,
            split_mode="within",
            requested=4,
        )
        leaderboard, sparse_alpha = search_datasets_with_sparse_alpha(
            selection_datasets,
            candidates,
            top_n=5,
        )
        best = leaderboard[0]["indices"]
        selected[tuple(best)] += 1
        test_features = private_base_features(train_rows, test_rows, stores, public_axes)
        content_prediction, fitted = fit_subset(
            inner_features,
            train_target,
            best,
            test_features,
            sparse_alpha,
        )
        train_prediction = cross_fit_subset(
            inner_features,
            train_target,
            best,
            inner_folds,
            sparse_alpha,
        )
        adjustments = group_residual_adjustments(train_rows, train_target, train_prediction, "account")
        calibrated = np.asarray(
            [
                estimate + adjustments.get(str(row["account"]), 0)
                for row, estimate in zip(test_rows, content_prediction)
            ]
        )
        content_prediction = np.clip(content_prediction, 0, 100)
        calibrated = np.clip(calibrated, 0, 100)
        all_indices = list(range(inner_features.shape[1]))
        all_alpha = select_ridge_alpha_datasets(
            selection_datasets,
            all_indices,
        )
        all_content, _ = fit_subset(
            inner_features,
            train_target,
            all_indices,
            test_features,
            all_alpha,
        )
        all_train = cross_fit_subset(
            inner_features, train_target, all_indices, inner_folds, all_alpha
        )
        all_adjustments = group_residual_adjustments(
            train_rows, train_target, all_train, "account"
        )
        all_prediction = np.clip(
            np.asarray(
                [
                    estimate + all_adjustments.get(str(row["account"]), 0)
                    for row, estimate in zip(test_rows, all_content)
                ]
            ),
            0,
            100,
        )
        actual = np.asarray([row["keep"] for row in test_rows], dtype=float)
        fold_results.append(
            {
                "heldOutFold": int(fold) + 1,
                "trainN": len(train_rows),
                "testN": len(test_rows),
                "features": [PRIVATE_FEATURE_NAMES[index] for index in best],
                "metrics": regression_metrics(actual, calibrated),
                "contentOnlyMetrics": regression_metrics(actual, content_prediction),
                "allInputsMetrics": regression_metrics(actual, all_prediction),
                "allInputsAlpha": all_alpha,
                "sparseAlpha": sparse_alpha,
            }
        )
        for row, truth, content, estimate, all_estimate in zip(
            test_rows, actual, content_prediction, calibrated, all_prediction
        ):
            points.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "account": row["account"],
                    "accountName": row["accountName"],
                    "actual": clean_number(truth),
                    "predicted": clean_number(estimate),
                    "contentOnlyPredicted": clean_number(content),
                    "groupAdjustment": clean_number(estimate - content),
                    "allInputsPredicted": clean_number(all_estimate),
                    "error": clean_number(estimate - truth),
                    "fold": int(fold) + 1,
                }
            )
        actual_all.extend(actual.tolist())
        content_all.extend(content_prediction.tolist())
        calibrated_all.extend(calibrated.tolist())
        all_input_all.extend(all_prediction.tolist())
    actual_array = np.asarray(actual_all)
    content_array = np.asarray(content_all)
    calibrated_array = np.asarray(calibrated_all)
    all_input_array = np.asarray(all_input_all)
    point_groups = [str(point["account"]) for point in points]
    point_group_names = [str(point["accountName"]) for point in points]
    full_folds = within_group_folds(eligible, "account", 5)
    update_status(
        "keep",
        phase="final-formula",
        completed=len(fold_values),
        total=len(fold_values),
        message="Keep rate: fitting the persisted formula after validation",
    )
    full_oof_features = private_fold_oof(eligible, full_folds, stores, public_axes)
    full_target = np.asarray([row["keep"] for row in eligible], dtype=float)
    final_selection_datasets = private_selection_datasets(
        eligible,
        stores,
        public_axes,
        split_mode="within",
        requested=5,
    )
    leaderboard, final_sparse_alpha = search_datasets_with_sparse_alpha(
        final_selection_datasets,
        candidates,
        top_n=100,
    )
    final_indices = leaderboard[0]["indices"]
    _, final_model = fit_subset(
        full_oof_features,
        full_target,
        final_indices,
        full_oof_features,
        final_sparse_alpha,
    )
    full_prediction = cross_fit_subset(
        full_oof_features,
        full_target,
        final_indices,
        full_folds,
        final_sparse_alpha,
    )
    final_adjustments = group_residual_adjustments(eligible, full_target, full_prediction, "account")
    all_indices = list(range(full_oof_features.shape[1]))
    final_all_alpha = select_ridge_alpha_datasets(
        final_selection_datasets,
        all_indices,
    )
    _, final_all_model = fit_subset(
        full_oof_features,
        full_target,
        all_indices,
        full_oof_features,
        final_all_alpha,
    )
    return {
        "metrics": regression_metrics(actual_array, calibrated_array),
        "contentOnlyMetrics": regression_metrics(actual_array, content_array),
        "withinSourceMetrics": within_source_metrics(
            actual_array,
            content_array,
            point_groups,
        ),
        "sourceSummary": observed_source_summary(
            actual_array,
            content_array,
            point_groups,
            point_group_names,
        ),
        "allInputsMetrics": regression_metrics(actual_array, all_input_array),
        "calibration": calibration_bins(actual_array, calibrated_array),
        "folds": fold_results,
        "points": sorted(points, key=lambda point: point["actual"], reverse=True),
        "formula": make_formula(final_model, PRIVATE_FEATURE_NAMES, "keep-rate percentage points"),
        "allInputsFormula": {
            **make_formula(
                final_all_model,
                PRIVATE_FEATURE_NAMES,
                "keep-rate percentage points",
            ),
            "alpha": final_all_alpha,
        },
        "groupCalibration": [
            {
                "group": account,
                "name": next(row["accountName"] for row in eligible if row["account"] == account),
                "additivePoints": clean_number(adjustment),
            }
            for account, adjustment in sorted(final_adjustments.items(), key=lambda item: stable_hash(item[0]))
        ],
        "topModels": leaderboard,
        "selectionStability": selected,
    }


def run_keep_forward_time(
    eligible: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
    candidates: list[tuple[int, ...]],
) -> dict[str, Any] | None:
    dated_count = sum(finite(row.get("publishedAt")) for row in eligible)
    if dated_count < 100:
        return None
    windows = expanding_time_splits(eligible)
    actual_all: list[float] = []
    predicted_all: list[float] = []
    points: list[dict[str, Any]] = []
    fold_results = []
    for window, (train_rows, test_rows) in enumerate(windows):
        update_status(
            "keep",
            phase="forward-time",
            completed=window,
            total=len(windows),
            message=f"Keep rate: partial forward-time window {window + 1} of {len(windows)}",
        )
        if len(train_rows) < 40 or len(test_rows) < 8:
            continue
        inner_folds = within_group_folds(train_rows, "account", 4)
        inner_features = private_fold_oof(train_rows, inner_folds, stores, public_axes)
        train_target = np.asarray([row["keep"] for row in train_rows], dtype=float)
        selection_datasets = private_selection_datasets(
            train_rows,
            stores,
            public_axes,
            split_mode="within",
            requested=4,
        )
        leaderboard, sparse_alpha = search_datasets_with_sparse_alpha(
            selection_datasets,
            candidates,
            top_n=3,
        )
        best = leaderboard[0]["indices"]
        test_features = private_base_features(train_rows, test_rows, stores, public_axes)
        content_prediction, _ = fit_subset(
            inner_features,
            train_target,
            best,
            test_features,
            sparse_alpha,
        )
        train_prediction = cross_fit_subset(
            inner_features,
            train_target,
            best,
            inner_folds,
            sparse_alpha,
        )
        adjustments = group_residual_adjustments(
            train_rows, train_target, train_prediction, "account"
        )
        prediction = np.clip(
            np.asarray(
                [
                    estimate + adjustments.get(str(row["account"]), 0)
                    for row, estimate in zip(test_rows, content_prediction)
                ]
            ),
            0,
            100,
        )
        actual = np.asarray([row["keep"] for row in test_rows], dtype=float)
        fold_results.append(
            {
                "window": window + 1,
                "trainN": len(train_rows),
                "testN": len(test_rows),
                "trainThrough": datetime.fromtimestamp(
                    float(train_rows[-1]["publishedAt"]) / 1000, tz=timezone.utc
                ).date().isoformat(),
                "testThrough": datetime.fromtimestamp(
                    float(test_rows[-1]["publishedAt"]) / 1000, tz=timezone.utc
                ).date().isoformat(),
                "features": [PRIVATE_FEATURE_NAMES[index] for index in best],
                "sparseAlpha": sparse_alpha,
                "metrics": regression_metrics(actual, prediction),
            }
        )
        for row, truth, estimate in zip(test_rows, actual, prediction):
            points.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "account": row["account"],
                    "accountName": row["accountName"],
                    "publishedAt": clean_number(row["publishedAt"], 0),
                    "actual": clean_number(truth),
                    "predicted": clean_number(estimate),
                    "error": clean_number(estimate - truth),
                }
            )
        actual_all.extend(actual.tolist())
        predicted_all.extend(prediction.tolist())
    if not actual_all:
        return None
    actual_array = np.asarray(actual_all)
    predicted_array = np.asarray(predicted_all)
    return {
        "label": "Forward-time keep-rate transfer",
        "description": "Each expanding window fits the private target axes, input selection, weights, and account calibration only on videos published earlier than its test videos. Present-day public geometry and novelty references stay fixed, so this is a partial forward-time backtest rather than a historical reconstruction of the entire embedding pipeline.",
        "metrics": regression_metrics(actual_array, predicted_array),
        "calibration": calibration_bins(actual_array, predicted_array),
        "folds": fold_results,
        "points": points,
    }


def run_keep_track(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
    candidates: list[tuple[int, ...]],
) -> dict[str, Any]:
    eligible = [row for row in rows if row["id"] in stores["visual"]["index"] and finite(row["keep"])]
    accounts = sorted(set(row["account"] for row in eligible), key=stable_hash)
    actual_all: list[float] = []
    predicted_all: list[float] = []
    points: list[dict[str, Any]] = []
    fold_results = []
    selected = Counter()
    for account_position, account in enumerate(accounts, 1):
        update_status(
            "keep",
            phase="unseen-account",
            completed=account_position - 1,
            total=len(accounts),
            message=f"Keep rate: unseen-account test {account_position} of {len(accounts)}",
        )
        train_rows = [row for row in eligible if row["account"] != account]
        test_rows = [row for row in eligible if row["account"] == account]
        if not train_rows or not test_rows:
            continue
        inner_features = private_inner_oof(train_rows, stores, public_axes)
        train_target = np.asarray([row["keep"] for row in train_rows], dtype=float)
        selection_datasets = private_selection_datasets(
            train_rows,
            stores,
            public_axes,
            split_mode="group",
            requested=3,
        )
        leaderboard, sparse_alpha = search_datasets_with_sparse_alpha(
            selection_datasets,
            candidates,
            top_n=5,
        )
        best = leaderboard[0]["indices"]
        selected[tuple(best)] += 1
        test_features = private_base_features(train_rows, test_rows, stores, public_axes)
        prediction, _ = fit_subset(
            inner_features,
            train_target,
            best,
            test_features,
            sparse_alpha,
        )
        prediction = np.clip(prediction, 0, 100)
        actual = np.asarray([row["keep"] for row in test_rows], dtype=float)
        fold_metric = regression_metrics(actual, prediction)
        fold_results.append(
            {
                "heldOutAccount": account,
                "heldOutName": test_rows[0]["accountName"],
                "trainN": len(train_rows),
                "testN": len(test_rows),
                "features": [PRIVATE_FEATURE_NAMES[index] for index in best],
                "sparseAlpha": sparse_alpha,
                "metrics": fold_metric,
            }
        )
        for row, truth, estimate in zip(test_rows, actual, prediction):
            points.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "account": row["account"],
                    "accountName": row["accountName"],
                    "actual": clean_number(truth),
                    "predicted": clean_number(estimate),
                    "error": clean_number(estimate - truth),
                }
            )
        actual_all.extend(actual.tolist())
        predicted_all.extend(prediction.tolist())
    actual_array = np.asarray(actual_all)
    predicted_array = np.asarray(predicted_all)
    transfer_stress = {
        "label": "Unseen-account transfer",
        "description": "An entire account is absent from axis fitting, formula selection, and calibration.",
        "metrics": regression_metrics(actual_array, predicted_array),
        "calibration": calibration_bins(actual_array, predicted_array),
        "folds": fold_results,
        "sourceSummary": source_level_summary(fold_results),
        "points": sorted(points, key=lambda point: point["actual"], reverse=True),
    }
    update_status(
        "keep",
        phase="known-account-interpolation",
        completed=0,
        total=5,
        message="Keep rate: starting leakage-safe known-account interpolation",
    )
    operational = run_keep_known_video(eligible, stores, public_axes, candidates)
    temporal_stress = run_keep_forward_time(eligible, stores, public_axes, candidates)
    full_oof_features = private_fold_oof(
        eligible,
        within_group_folds(eligible, "account", 5),
        stores,
        public_axes,
    )
    full_target = np.asarray([row["keep"] for row in eligible], dtype=float)
    account_groups = [str(row["account"]) for row in eligible]
    centered_target = within_source_center(full_target, account_groups)
    single_features = []
    for feature_index, feature_name in enumerate(PRIVATE_FEATURE_NAMES):
        values = full_oof_features[:, feature_index]
        valid = np.isfinite(values)
        pooled = spearmanr(values[valid], full_target[valid]) if valid.sum() >= 8 else None
        correlation, p_value = within_source_rank_test(
            values,
            full_target,
            account_groups,
            feature_name,
        )
        centered_values = within_source_center(values, account_groups)
        single_features.append(
            {
                "feature": feature_name,
                "n": int(valid.sum()),
                "spearman": clean_number(correlation),
                "withinSourceSpearman": clean_number(correlation),
                "pooledSpearman": clean_number(
                    pooled.statistic if pooled is not None else None
                ),
                "pValue": p_value,
                "associationMethod": "within-source centered rank correlation with 1,000 within-source target permutations",
                "relationship": relationship_bins(centered_values, centered_target),
                "pooledRelationship": relationship_bins(values, full_target),
            }
        )
    add_fdr_q_values(single_features)
    for row in single_features:
        row["pValue"] = clean_number(row.get("pValue"), 8)
    single_features.sort(key=lambda item: abs(item["spearman"] or 0), reverse=True)
    return {
        "label": "Stayed to watch / keep rate",
        "population": "Private pooled account videos",
        "primaryValidation": "Retrospective five-fold interpolation within known accounts; held-out video labels do not fit the model, but same-account videos published later may be available. The source-calibrated score includes an account prior; withinSourceMetrics isolates video-level lift after removing account means",
        "prospectiveValidation": temporal_stress["description"] if temporal_stress else "No forward-time test is available.",
        "prospectiveMetrics": temporal_stress["metrics"] if temporal_stress else None,
        "decisionStatus": "not prospectively validated",
        "n": len(eligible),
        "accounts": [{"id": account, "n": sum(row["account"] == account for row in eligible)} for account in accounts],
        "metrics": operational["metrics"],
        "contentOnlyMetrics": operational["contentOnlyMetrics"],
        "withinSourceMetrics": operational["withinSourceMetrics"],
        "sourceSummary": operational["sourceSummary"],
        "allInputsMetrics": operational["allInputsMetrics"],
        "calibration": operational["calibration"],
        "folds": operational["folds"],
        "points": operational["points"],
        "formula": operational["formula"],
        "allInputsFormula": operational["allInputsFormula"],
        "groupCalibration": operational["groupCalibration"],
        "topModels": [
            {
                "validationR2": row["score"],
                "features": [PRIVATE_FEATURE_NAMES[index] for index in row["indices"]],
                "alpha": row.get("alpha"),
            }
            for row in operational["topModels"][:25]
        ],
        "singleFeatures": single_features,
        "selectionStability": [
            {
                "features": [PRIVATE_FEATURE_NAMES[index] for index in indices],
                "outerFolds": count,
            }
            for indices, count in operational["selectionStability"].most_common()
        ],
        "stressTests": [transfer_stress] + ([temporal_stress] if temporal_stress else []),
        "warning": "The known-account interpolation score is not a pre-upload forecast. The forward-time test uses current frozen public reference axes and historical private labels, while the unseen-account test remains negative; do not claim a universal keep-rate model.",
    }


def channel_outer_predictions(
    rows: list[dict[str, Any]],
    feature_names: list[str],
    candidates: list[tuple[int, ...]],
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]], Counter]:
    X = np.asarray([row["features"] for row in rows], dtype=float)
    y = np.asarray([row["logViews"] for row in rows], dtype=float)
    channels = sorted(set(row["channel"] for row in rows), key=stable_hash)
    predicted = np.full(len(rows), np.nan)
    fold_results = []
    selected: Counter = Counter()
    for channel_position, channel in enumerate(channels, 1):
        update_status(
            "views",
            phase="unseen-channel",
            completed=channel_position - 1,
            total=len(channels),
            message=f"Public views: unseen-channel test {channel_position} of {len(channels)}",
        )
        train = np.asarray([row["channel"] != channel for row in rows])
        test = ~train
        if train.sum() < 20 or test.sum() < 8:
            continue
        train_rows = [rows[index] for index in np.flatnonzero(train)]
        folds = group_folds([row["channel"] for row in train_rows], 3)
        leaderboard, sparse_alpha = search_with_sparse_alpha(
            X[train],
            y[train],
            folds,
            candidates,
            top_n=5,
        )
        best = leaderboard[0]["indices"]
        selected[tuple(best)] += 1
        fold_prediction, _ = fit_subset(
            X[train],
            y[train],
            best,
            X[test],
            sparse_alpha,
        )
        predicted[test] = fold_prediction
        metric = log_view_metrics(y[test], fold_prediction)
        fold_results.append(
            {
                "heldOutChannel": channel,
                "heldOutName": next(row["channelName"] for row in rows if row["channel"] == channel),
                "trainN": int(train.sum()),
                "testN": int(test.sum()),
                "features": [feature_names[index] for index in best],
                "sparseAlpha": sparse_alpha,
                "metrics": metric,
            }
        )
    return y, predicted, fold_results, selected


def views_nested_calibration_predictions(
    rows: list[dict[str, Any]],
    feature_names: list[str],
    candidates: list[tuple[int, ...]],
) -> np.ndarray:
    X = np.asarray([row["features"] for row in rows], dtype=float)
    y = np.asarray([row["logViews"] for row in rows], dtype=float)
    calibration_folds = within_group_folds(rows, "channel", 4)
    prediction = np.full(len(rows), np.nan)
    for fold in sorted(set(calibration_folds.tolist())):
        train = calibration_folds != fold
        test = ~train
        if train.sum() < 40 or test.sum() < 4:
            continue
        train_rows = [rows[index] for index in np.flatnonzero(train)]
        selection_folds = within_group_folds(train_rows, "channel", 3)
        leaderboard, sparse_alpha = search_with_sparse_alpha(
            X[train],
            y[train],
            selection_folds,
            candidates,
            top_n=1,
        )
        best = leaderboard[0]["indices"]
        test_content, _ = fit_subset(
            X[train],
            y[train],
            best,
            X[test],
            sparse_alpha,
        )
        train_content = cross_fit_subset(
            X[train],
            y[train],
            best,
            selection_folds,
            sparse_alpha,
        )
        adjustments = group_residual_adjustments(
            train_rows,
            y[train],
            train_content,
            "channel",
        )
        test_rows = [rows[index] for index in np.flatnonzero(test)]
        prediction[test] = np.asarray(
            [
                estimate + adjustments.get(str(row["channel"]), 0)
                for row, estimate in zip(test_rows, test_content)
            ]
        )
    return prediction


def run_views_known_video(
    rows: list[dict[str, Any]],
    feature_names: list[str],
    candidates: list[tuple[int, ...]],
) -> dict[str, Any]:
    X = np.asarray([row["features"] for row in rows], dtype=float)
    y = np.asarray([row["logViews"] for row in rows], dtype=float)
    outer_folds = within_group_folds(rows, "channel", 5)
    content_prediction = np.full(len(rows), np.nan)
    calibrated_prediction = np.full(len(rows), np.nan)
    all_input_prediction = np.full(len(rows), np.nan)
    residual_sigma = np.full(len(rows), np.nan)
    residual_samples: list[np.ndarray | None] = [None] * len(rows)
    fold_results = []
    selected: Counter = Counter()
    fold_values = sorted(set(outer_folds.tolist()))
    for fold_position, fold in enumerate(fold_values, 1):
        update_status(
            "views",
            phase="known-channel-interpolation",
            completed=fold_position - 1,
            total=len(fold_values),
            message=f"Public views: nested known-channel fold {fold_position} of {len(fold_values)}",
        )
        train = outer_folds != fold
        test = ~train
        train_rows = [row for index, row in enumerate(rows) if train[index]]
        inner_folds = within_group_folds(train_rows, "channel", 4)
        leaderboard, sparse_alpha = search_with_sparse_alpha(
            X[train],
            y[train],
            inner_folds,
            candidates,
            top_n=5,
        )
        best = leaderboard[0]["indices"]
        selected[tuple(best)] += 1
        test_prediction, _ = fit_subset(
            X[train],
            y[train],
            best,
            X[test],
            sparse_alpha,
        )
        train_prediction = cross_fit_subset(
            X[train],
            y[train],
            best,
            inner_folds,
            sparse_alpha,
        )
        adjustments = group_residual_adjustments(train_rows, y[train], train_prediction, "channel")
        adjusted = np.asarray(
            [
                estimate + adjustments.get(str(row["channel"]), 0)
                for row, estimate in zip(
                    [row for index, row in enumerate(rows) if test[index]],
                    test_prediction,
                )
            ]
        )
        content_prediction[test] = test_prediction
        calibrated_prediction[test] = adjusted
        all_indices = list(range(X.shape[1]))
        all_alpha = select_ridge_alpha(
            X[train],
            y[train],
            all_indices,
            inner_folds,
        )
        all_test_prediction, _ = fit_subset(
            X[train], y[train], all_indices, X[test], all_alpha
        )
        all_train_prediction = cross_fit_subset(
            X[train], y[train], all_indices, inner_folds, all_alpha
        )
        all_adjustments = group_residual_adjustments(
            train_rows, y[train], all_train_prediction, "channel"
        )
        all_adjusted = np.asarray(
            [
                estimate + all_adjustments.get(str(row["channel"]), 0)
                for row, estimate in zip(
                    [row for index, row in enumerate(rows) if test[index]],
                    all_test_prediction,
                )
            ]
        )
        all_input_prediction[test] = all_adjusted
        nested_calibration_prediction = views_nested_calibration_predictions(
            train_rows,
            feature_names,
            candidates,
        )
        calibration_valid = np.isfinite(nested_calibration_prediction)
        fold_residuals = np.sort(
            y[train][calibration_valid]
            - nested_calibration_prediction[calibration_valid]
        )
        if not len(fold_residuals):
            raise RuntimeError(
                "views tail calibration produced no fully nested residuals"
            )
        for index in np.flatnonzero(test):
            residual_samples[index] = fold_residuals
        residual_sigma[test] = max(
            float(np.nanstd(fold_residuals)),
            1e-6,
        )
        adjusted_metrics = log_view_metrics(y[test], adjusted)
        content_metrics = log_view_metrics(y[test], test_prediction)
        all_metrics = log_view_metrics(y[test], all_adjusted)
        fold_results.append(
            {
                "heldOutFold": int(fold) + 1,
                "trainN": int(train.sum()),
                "testN": int(test.sum()),
                "features": [feature_names[index] for index in best],
                "metrics": adjusted_metrics,
                "contentOnlyMetrics": content_metrics,
                "allInputsMetrics": all_metrics,
                "allInputsAlpha": all_alpha,
                "sparseAlpha": sparse_alpha,
            }
        )
    full_folds = within_group_folds(rows, "channel", 5)
    update_status(
        "views",
        phase="final-formula",
        completed=len(fold_values),
        total=len(fold_values),
        message="Public views: fitting the persisted formula after validation",
    )
    leaderboard, final_sparse_alpha = search_with_sparse_alpha(
        X,
        y,
        full_folds,
        candidates,
        top_n=100,
    )
    final_indices = leaderboard[0]["indices"]
    _, final_model = fit_subset(
        X,
        y,
        final_indices,
        X,
        final_sparse_alpha,
    )
    full_prediction = cross_fit_subset(
        X,
        y,
        final_indices,
        full_folds,
        final_sparse_alpha,
    )
    final_adjustments = group_residual_adjustments(rows, y, full_prediction, "channel")
    all_indices = list(range(X.shape[1]))
    final_all_alpha = select_ridge_alpha(
        X,
        y,
        all_indices,
        full_folds,
    )
    _, final_all_model = fit_subset(X, y, all_indices, X, final_all_alpha)
    return {
        "contentPrediction": content_prediction,
        "prediction": calibrated_prediction,
        "allInputsPrediction": all_input_prediction,
        "residualSigma": residual_sigma,
        "residualSamples": residual_samples,
        "folds": fold_results,
        "formula": make_formula(final_model, feature_names, "log10 public views"),
        "allInputsFormula": {
            **make_formula(final_all_model, feature_names, "log10 public views"),
            "alpha": final_all_alpha,
        },
        "groupCalibration": [
            {
                "group": channel,
                "name": next(row["channelName"] for row in rows if row["channel"] == channel),
                "additiveLogViews": clean_number(adjustment),
                "multiplicativeViews": clean_number(10**adjustment),
            }
            for channel, adjustment in sorted(final_adjustments.items(), key=lambda item: stable_hash(item[0]))
        ],
        "topModels": leaderboard,
        "selectionStability": selected,
    }


def run_views_forward_time(
    rows: list[dict[str, Any]],
    feature_names: list[str],
    candidates: list[tuple[int, ...]],
) -> dict[str, Any] | None:
    dated_count = sum(finite(row.get("publishedAt")) for row in rows)
    if dated_count < 100:
        return None
    windows = expanding_time_splits(rows)
    actual_all: list[float] = []
    predicted_all: list[float] = []
    points: list[dict[str, Any]] = []
    fold_results = []
    for window, (train_rows, test_rows) in enumerate(windows):
        update_status(
            "views",
            phase="forward-time",
            completed=window,
            total=len(windows),
            message=f"Public views: partial forward-time window {window + 1} of {len(windows)}",
        )
        if len(train_rows) < 80 or len(test_rows) < 8:
            continue
        train_features = np.asarray([row["features"] for row in train_rows], dtype=float)
        test_features = np.asarray([row["features"] for row in test_rows], dtype=float)
        train_target = np.asarray([row["logViews"] for row in train_rows], dtype=float)
        inner_folds = within_group_folds(train_rows, "channel", 4)
        leaderboard, sparse_alpha = search_with_sparse_alpha(
            train_features,
            train_target,
            inner_folds,
            candidates,
            top_n=3,
        )
        best = leaderboard[0]["indices"]
        content_prediction, _ = fit_subset(
            train_features,
            train_target,
            best,
            test_features,
            sparse_alpha,
        )
        train_prediction = cross_fit_subset(
            train_features,
            train_target,
            best,
            inner_folds,
            sparse_alpha,
        )
        adjustments = group_residual_adjustments(
            train_rows,
            train_target,
            train_prediction,
            "channel",
        )
        prediction = np.asarray(
            [
                estimate + adjustments.get(str(row["channel"]), 0)
                for row, estimate in zip(test_rows, content_prediction)
            ]
        )
        actual = np.asarray([row["logViews"] for row in test_rows], dtype=float)
        metrics = log_view_metrics(actual, prediction)
        fold_results.append(
            {
                "window": window + 1,
                "trainN": len(train_rows),
                "testN": len(test_rows),
                "trainThrough": datetime.fromtimestamp(
                    float(train_rows[-1]["publishedAt"]) / 1000,
                    tz=timezone.utc,
                ).date().isoformat(),
                "testThrough": datetime.fromtimestamp(
                    float(test_rows[-1]["publishedAt"]) / 1000,
                    tz=timezone.utc,
                ).date().isoformat(),
                "features": [feature_names[index] for index in best],
                "sparseAlpha": sparse_alpha,
                "metrics": metrics,
            }
        )
        for row, truth, estimate in zip(test_rows, actual, prediction):
            points.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "channel": row["channel"],
                    "channelName": row["channelName"],
                    "publishedAt": clean_number(row["publishedAt"], 0),
                    "actualViews": round(10**truth - 1),
                    "predictedViews": max(0, round(10**estimate - 1)),
                    "factorError": clean_number(10 ** abs(estimate - truth)),
                }
            )
        actual_all.extend(actual.tolist())
        predicted_all.extend(prediction.tolist())
    if not actual_all:
        return None
    actual_array = np.asarray(actual_all)
    predicted_array = np.asarray(predicted_all)
    metrics = log_view_metrics(actual_array, predicted_array)
    return {
        "label": "Forward-time public-views transfer",
        "description": "Each expanding window selects inputs, weights, and channel calibration only from saved-channel videos published earlier than its test videos. The 21 input scores were produced by the present-day frozen scorer, so this is a partial forward-time backtest rather than a historical reconstruction of every upstream axis.",
        "metrics": metrics,
        "calibration": calibration_bins(actual_array, predicted_array),
        "folds": fold_results,
        "points": sorted(points, key=lambda point: point["actualViews"], reverse=True),
    }


def run_views_track(
    rows: list[dict[str, Any]],
    contract: dict[str, Any],
    candidates: list[tuple[int, ...]],
) -> dict[str, Any]:
    feature_names = saved_channel_feature_names(contract)
    eligible = [row for row in rows if row["ageDays"] is None or row["ageDays"] >= 30]
    dated_count = sum(finite(row.get("publishedAt")) for row in eligible)
    X = np.asarray([row["features"] for row in eligible], dtype=float)
    y = np.asarray([row["logViews"] for row in eligible], dtype=float)
    y_transfer, predicted_transfer, transfer_folds, transfer_selected = channel_outer_predictions(
        eligible, feature_names, candidates
    )
    transfer_valid = np.isfinite(predicted_transfer)
    transfer_metrics = log_view_metrics(
        y_transfer[transfer_valid],
        predicted_transfer[transfer_valid],
    )
    transfer_stress = {
        "label": "Unseen-channel transfer",
        "description": "An entire saved channel is absent from formula selection and calibration.",
        "metrics": transfer_metrics,
        "calibration": calibration_bins(y_transfer[transfer_valid], predicted_transfer[transfer_valid]),
        "folds": transfer_folds,
        "sourceSummary": source_level_summary(transfer_folds),
    }
    temporal_stress = run_views_forward_time(eligible, feature_names, candidates)
    update_status(
        "views",
        phase="known-channel-interpolation",
        completed=0,
        total=5,
        message="Public views: starting nested known-channel interpolation",
    )
    operational = run_views_known_video(eligible, feature_names, candidates)
    predicted = operational["prediction"]
    content_prediction = operational["contentPrediction"]
    residual_sigma = operational["residualSigma"]
    residual_samples = operational["residualSamples"]
    all_input_prediction = operational["allInputsPrediction"]
    valid = np.isfinite(predicted)
    actual_views = np.asarray([row["views"] for row in eligible], dtype=float)[valid]
    predicted_valid = predicted[valid]
    y_valid = y[valid]
    points = []
    for index in np.flatnonzero(valid):
        row = eligible[index]
        truth_log = y[index]
        estimate_log = predicted[index]
        points.append(
            {
                "id": row["id"],
                "title": row["title"],
                "channel": row["channel"],
                "channelName": row["channelName"],
                "actualViews": round(row["views"]),
                "predictedViews": max(0, round(10**estimate_log - 1)),
                "contentOnlyPredictedViews": max(0, round(10 ** content_prediction[index] - 1)),
                "actualLogViews": clean_number(truth_log),
                "predictedLogViews": clean_number(estimate_log),
                "contentOnlyPredictedLogViews": clean_number(content_prediction[index]),
                "groupAdjustment": clean_number(estimate_log - content_prediction[index]),
                "residualSigma": clean_number(residual_sigma[index]),
                "allInputsPredictedViews": max(
                    0, round(10 ** all_input_prediction[index] - 1)
                ),
                "factorError": clean_number(10 ** abs(estimate_log - truth_log)),
                "ageDays": clean_number(row["ageDays"], 1),
            }
        )
    single_features = []
    target = np.asarray([row["logViews"] for row in eligible])
    channel_groups = [str(row["channel"]) for row in eligible]
    centered_target = within_source_center(target, channel_groups)
    for index, feature_name in enumerate(feature_names):
        values = X[:, index]
        valid_feature = np.isfinite(values)
        pooled = (
            spearmanr(values[valid_feature], target[valid_feature])
            if valid_feature.sum() >= 8
            else None
        )
        correlation, p_value = within_source_rank_test(
            values,
            target,
            channel_groups,
            feature_name,
        )
        centered_values = within_source_center(values, channel_groups)
        single_features.append(
            {
                "feature": feature_name,
                "n": int(valid_feature.sum()),
                "spearmanLogViews": clean_number(correlation),
                "withinSourceSpearman": clean_number(correlation),
                "pooledSpearmanLogViews": clean_number(
                    pooled.statistic if pooled is not None else None
                ),
                "pValue": p_value,
                "associationMethod": "within-source centered rank correlation with 1,000 within-source target permutations",
                "relationship": relationship_bins(centered_values, centered_target),
                "pooledRelationship": relationship_bins(values, target),
            }
        )
    add_fdr_q_values(single_features)
    for row in single_features:
        row["pValue"] = clean_number(row.get("pValue"), 8)
    single_features.sort(key=lambda item: abs(item["spearmanLogViews"] or 0), reverse=True)
    metrics = log_view_metrics(y_valid, predicted_valid)
    content_metrics = log_view_metrics(y_valid, content_prediction[valid])
    within_metrics = within_source_metrics(
        y_valid,
        content_prediction[valid],
        [eligible[index]["channel"] for index in np.flatnonzero(valid)],
        log_views=True,
    )
    source_summary = observed_source_summary(
        y_valid,
        content_prediction[valid],
        [eligible[index]["channel"] for index in np.flatnonzero(valid)],
        [eligible[index]["channelName"] for index in np.flatnonzero(valid)],
        log_views=True,
    )
    all_input_metrics = log_view_metrics(y_valid, all_input_prediction[valid])
    valid_indices = np.flatnonzero(valid)
    valid_ages = np.asarray(
        [
            float(eligible[index]["ageDays"])
            if finite(eligible[index].get("ageDays"))
            else np.nan
            for index in valid_indices
        ],
        dtype=float,
    )
    maturity_sensitivity = []
    for minimum_days in (30, 90, 180, 365):
        cohort = np.isfinite(valid_ages) & (valid_ages >= minimum_days)
        if cohort.sum() < 50:
            continue
        maturity_sensitivity.append(
            {
                "minimumAgeDays": minimum_days,
                "metrics": log_view_metrics(
                    y_valid[cohort],
                    predicted_valid[cohort],
                ),
            }
        )
    return {
        "label": "Public views",
        "population": "Saved-channel Shorts with zero ID overlap against the current raw-axis corpus",
        "primaryValidation": "Retrospective five-fold interpolation within known channels; held-out video outcomes do not fit the model, but same-channel videos published later may be available. The source-calibrated score includes a channel prior; withinSourceMetrics isolates video-level lift after removing channel means",
        "prospectiveValidation": temporal_stress["description"] if temporal_stress else "No forward-time test is available.",
        "prospectiveMetrics": temporal_stress["metrics"] if temporal_stress else None,
        "decisionStatus": "not prospectively validated",
        "n": int(valid.sum()),
        "channels": [
            {
                "id": channel,
                "name": next(row["channelName"] for row in eligible if row["channel"] == channel),
                "n": sum(row["channel"] == channel for row in eligible),
            }
            for channel in sorted(set(row["channel"] for row in eligible), key=stable_hash)
        ],
        "metrics": metrics,
        "contentOnlyMetrics": content_metrics,
        "withinSourceMetrics": within_metrics,
        "sourceSummary": source_summary,
        "allInputsMetrics": all_input_metrics,
        "maturitySensitivity": maturity_sensitivity,
        "calibration": calibration_bins(y_valid, predicted_valid),
        "tailRisk": threshold_diagnostics(
            actual_views,
            predicted_valid,
            [residual_samples[index] for index in np.flatnonzero(valid)],
            [eligible[index]["channel"] for index in np.flatnonzero(valid)],
        ),
        "folds": operational["folds"],
        "points": sorted(points, key=lambda point: point["actualViews"], reverse=True),
        "formula": operational["formula"],
        "allInputsFormula": operational["allInputsFormula"],
        "groupCalibration": operational["groupCalibration"],
        "topModels": [
            {
                "validationR2": row["score"],
                "features": [feature_names[index] for index in row["indices"]],
                "alpha": row.get("alpha"),
            }
            for row in operational["topModels"][:25]
        ],
        "singleFeatures": single_features,
        "selectionStability": [
            {
                "features": [feature_names[index] for index in indices],
                "outerFolds": count,
            }
            for indices, count in operational["selectionStability"].most_common()
        ],
        "stressTests": [transfer_stress] + ([temporal_stress] if temporal_stress else []),
        "warning": (
            f"The operational score calibrates to a known channel's historical scale. Publication dates are present for {dated_count:,} of {len(eligible):,} eligible Shorts, "
            "but outcomes are still current-view snapshots rather than fixed 30-day views. The forward-time ordering is retrospective and cannot reconstruct as-of view labels; unseen-channel transfer is also reported separately."
        ),
    }


RAW_RIDGE_ALPHAS = (0.1, 1.0, 10.0, 100.0, 1000.0)


def select_grouped_raw_alpha(
    X: np.ndarray,
    y: np.ndarray,
    groups: list[str],
    sample_limit: int = 20_000,
) -> tuple[float, list[dict[str, Any]]]:
    indices = np.arange(len(y))
    if len(indices) > sample_limit:
        order = np.argsort(
            np.asarray(
                [
                    stable_hash(f"{groups[index]}:{index}")
                    for index in indices
                ],
                dtype=np.uint64,
            ),
            kind="mergesort",
        )
        indices = indices[order[:sample_limit]]
    sampled_groups = [groups[index] for index in indices]
    folds = group_folds(sampled_groups, 3)
    if len(set(folds.tolist())) < 2:
        return 10.0, []
    sensitivity = []
    best_alpha, best_score = 10.0, -math.inf
    for alpha in RAW_RIDGE_ALPHAS:
        prediction = np.full(len(indices), np.nan)
        for fold in sorted(set(folds.tolist())):
            training = folds != fold
            validation = ~training
            if training.sum() < 50 or validation.sum() < 20:
                continue
            model = Ridge(alpha=alpha, solver="lsqr", tol=1e-3).fit(
                X[indices[training]],
                y[indices[training]],
            )
            prediction[validation] = model.predict(X[indices[validation]])
        valid = np.isfinite(prediction)
        metrics = log_view_metrics(y[indices[valid]], prediction[valid])
        score = float(metrics["r2"]) if finite(metrics.get("r2")) else -math.inf
        sensitivity.append({"alpha": alpha, "metrics": metrics})
        if score > best_score:
            best_alpha, best_score = alpha, score
    return best_alpha, sensitivity


def raw_corpus_benchmark(
    stores: dict[str, dict[str, Any]],
    library: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    modality_predictions: dict[str, dict[str, float]] = defaultdict(dict)
    details: dict[str, Any] = {}
    private_ids = {
        video_id
        for store in stores.values()
        for video_id, mine in zip(store["ids"], store["mine"])
        if mine
    }
    for modality_position, modality in enumerate(MODALITIES, 1):
        update_status(
            "corpus",
            phase="shorts-geometry",
            completed=modality_position - 1,
            total=len(MODALITIES),
            message=f"Science Center: creator-group {modality} benchmark {modality_position} of {len(MODALITIES)}",
        )
        store = stores[modality]
        indices = [
            index
            for index, video_id in enumerate(store["ids"])
            if video_id not in private_ids
            and video_id in library
            and finite((library.get(video_id) or {}).get("views"))
            and float(library[video_id]["views"]) > 0
        ]
        if len(indices) < 100:
            continue
        X = store["vectors"][indices]
        ids = [store["ids"][index] for index in indices]
        current_views = np.asarray(
            [float(library[video_id]["views"]) for video_id in ids],
            dtype=float,
        )
        y = np.log10(current_views + 1)
        groups = [
            str(library[video_id].get("channelId") or library[video_id].get("channel") or video_id)
            for video_id in ids
        ]
        unique_groups = sorted(set(groups), key=stable_hash)
        mapping = {group: index % min(5, len(unique_groups)) for index, group in enumerate(unique_groups)}
        folds = np.asarray([mapping[group] for group in groups])
        prediction = np.full(len(y), np.nan)
        selected_alphas = []
        alpha_sensitivity = []
        for fold in sorted(set(folds.tolist())):
            train = folds != fold
            test = ~train
            alpha, sensitivity = select_grouped_raw_alpha(
                X[train],
                y[train],
                [groups[index] for index in np.flatnonzero(train)],
            )
            selected_alphas.append(alpha)
            alpha_sensitivity.append(
                {
                    "outerFold": int(fold) + 1,
                    "selectedAlpha": alpha,
                    "candidates": sensitivity,
                }
            )
            model = Ridge(alpha=alpha, solver="lsqr", tol=1e-3).fit(X[train], y[train])
            prediction[test] = model.predict(X[test])
        valid = np.isfinite(prediction)
        metric = log_view_metrics(y[valid], prediction[valid])
        details[modality] = {
            "n": int(valid.sum()),
            "groups": len(unique_groups),
            "metrics": metric,
            "calibration": calibration_bins(y[valid], prediction[valid]),
            "points": sampled_view_points(ids, y, prediction, library),
            "sourceSummary": prediction_source_summary(
                ids,
                y,
                prediction,
                library,
            ),
            "ageCohorts": prediction_age_cohorts(
                ids,
                y,
                prediction,
                library,
            ),
            "selectedAlphaByFold": selected_alphas,
            "alphaSensitivity": alpha_sensitivity,
        }
        for video_id, estimate in zip(ids, prediction):
            if finite(estimate):
                modality_predictions[video_id][modality] = float(estimate)
    ensemble_ids = [
        video_id
        for video_id, values in modality_predictions.items()
        if all(modality in values for modality in MODALITIES)
    ]
    ensemble_actual = np.asarray([math.log10(float(library[video_id]["views"]) + 1) for video_id in ensemble_ids])
    ensemble_prediction = np.asarray(
        [
            np.mean(
                [
                    modality_predictions[video_id][modality]
                    for modality in MODALITIES
                ]
            )
            for video_id in ensemble_ids
        ]
    )
    for modality in MODALITIES:
        if modality not in details:
            continue
        common_prediction = np.asarray(
            [modality_predictions[video_id][modality] for video_id in ensemble_ids],
            dtype=float,
        )
        details[modality]["commonCohortMetrics"] = log_view_metrics(
            ensemble_actual,
            common_prediction,
        )
    ensemble_metric = log_view_metrics(ensemble_actual, ensemble_prediction)
    cross_domain: dict[str, Any] = {}
    long_library = r2_json("longform/db.json", {"videos": {}}).get("videos") or {}
    for modality_position, modality in enumerate(MODALITIES, 1):
        update_status(
            "corpus",
            phase="long-form-transfer",
            completed=modality_position - 1,
            total=len(MODALITIES),
            message=f"Long Quant transfer: {modality} {modality_position} of {len(MODALITIES)}",
        )
        try:
            long_store = load_npz(f"raw-long/{modality}/embeddings.npz")
            long_vectors = normalized(long_store["vecs"])
            long_views = np.asarray(long_store["views"], dtype=float)
            train = np.isfinite(long_views) & (long_views > 0)
            if train.sum() < 100:
                continue
            long_ids = [str(value) for value in long_store["ids"]]
            long_train_indices = np.flatnonzero(train)
            long_groups = [
                str(
                    (long_library.get(long_ids[index]) or {}).get("channelId")
                    or (long_library.get(long_ids[index]) or {}).get("channel")
                    or long_ids[index]
                )
                for index in long_train_indices
            ]
            selected_alpha, sensitivity = select_grouped_raw_alpha(
                long_vectors[train],
                np.log10(long_views[train] + 1),
                long_groups,
            )
            model = Ridge(alpha=selected_alpha, solver="lsqr", tol=1e-3).fit(
                long_vectors[train], np.log10(long_views[train] + 1)
            )
            short_store = stores[modality]
            indices = [
                index
                for index, video_id in enumerate(short_store["ids"])
                if video_id not in private_ids
                and video_id in library
                and finite((library.get(video_id) or {}).get("views"))
                and float(library[video_id]["views"]) > 0
            ]
            if len(indices) < 100:
                continue
            actual = np.log10(
                np.asarray(
                    [
                        float(library[short_store["ids"][index]]["views"])
                        for index in indices
                    ]
                )
                + 1
            )
            prediction = model.predict(short_store["vectors"][indices])
            metric = log_view_metrics(actual, prediction)
            cross_domain[modality] = {
                "longFormTrainN": int(train.sum()),
                "shortFormTestN": len(indices),
                "metrics": metric,
                "selectedAlpha": selected_alpha,
                "alphaSensitivity": sensitivity,
            }
        except Exception:
            continue
    return {
        "description": "Raw 1,536D Gemini geometry refit inside five creator-group folds; no saved steered views score is reused. Labels are current public-view snapshots, so age-cohort and creator-macro diagnostics are reported separately",
        "modalities": details,
        "ensemble": {
            "n": len(ensemble_ids),
            "cohort": "Videos with valid visual, text, and together predictions; every ensemble row averages exactly three modalities",
            "metrics": ensemble_metric,
            "calibration": calibration_bins(ensemble_actual, ensemble_prediction),
            "points": sampled_view_points(
                ensemble_ids,
                ensemble_actual,
                ensemble_prediction,
                library,
            ),
            "sourceSummary": prediction_source_summary(
                ensemble_ids,
                ensemble_actual,
                ensemble_prediction,
                library,
            ),
            "ageCohorts": prediction_age_cohorts(
                ensemble_ids,
                ensemble_actual,
                ensemble_prediction,
                library,
            ),
        },
        "crossDomainLongForm": {
            "description": "A frozen long-form title/thumbnail views axis is trained only on Long Quant, then transferred directly into the matching Shorts modality without seeing a Short outcome.",
            "modalities": cross_domain,
        },
    }


def coverage_payload(
    stores: dict[str, dict[str, Any]],
    library: dict[str, dict[str, Any]],
    private_rows: list[dict[str, Any]],
    saved_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    stored = [
        video
        for video in library.values()
        if video.get("stored")
        and finite(video.get("width"))
        and finite(video.get("height"))
        and float(video["height"]) > float(video["width"])
        and finite(video.get("durationSec"))
        and float(video["durationSec"]) <= 180
    ]
    stored_ids = {str(video["videoId"]) for video in stored if video.get("videoId")}
    embedded_total = {modality: len(store["ids"]) for modality, store in stores.items()}
    embedded = {
        modality: sum(video_id in stored_ids for video_id in store["ids"])
        for modality, store in stores.items()
    }
    return {
        "scienceCenterStoredShorts": len(stored),
        "embedded": embedded,
        "embeddedTotalIncludingPrivate": embedded_total,
        "visualCoverage": clean_number(embedded["visual"] / len(stored) if stored else 0),
        "remainingVisual": max(0, len(stored) - embedded["visual"]),
        "privateRetentionRows": len(private_rows),
        "savedChannelRows": len(saved_rows),
        "savedChannels": len(set(row["channel"] for row in saved_rows)),
    }


def update_status(stage: str, **extra: Any) -> None:
    status = {
        "version": 2,
        "stage": stage,
        "updatedAt": int(time.time() * 1000),
        **extra,
    }
    try:
        put_json(R2_STATUS_KEY, status)
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local-only", action="store_true")
    parser.add_argument("--skip-corpus-benchmark", action="store_true")
    args = parser.parse_args()
    started = time.time()
    READ_PROVENANCE.clear()
    update_status("loading", message="Loading canonical raw embeddings and labels")
    contract_bytes = CONTRACT_PATH.read_bytes()
    record_source(f"local:{CONTRACT_PATH.relative_to(ROOT)}", contract_bytes)
    record_source(
        f"local:{Path(__file__).resolve().relative_to(ROOT)}",
        Path(__file__).read_bytes(),
    )
    contract = json.loads(contract_bytes)
    library = load_library()
    stores = load_raw()
    private_rows = load_private_rows()
    saved_rows = load_saved_channel_rows(contract)
    private_ids = {row["id"] for row in private_rows}
    saved_ids = {row["id"] for row in saved_rows}
    axis_corpus_ids = {
        video_id
        for store in stores.values()
        for index, video_id in enumerate(store["ids"])
        if not store["mine"][index] and video_id not in private_ids
    }
    saved_axis_overlap = sorted(saved_ids & axis_corpus_ids)
    if saved_axis_overlap:
        raise RuntimeError(
            f"saved-channel validation overlaps the raw axis corpus by {len(saved_axis_overlap)} videos"
        )
    contract_hash = hashlib.sha256(contract_bytes).hexdigest()
    provenance = {
        "featureContractSha256": contract_hash,
        "featureContractVersion": contract.get("version"),
        "featureScorerVersionPersistedPerVideo": False,
        "savedChannelVideoCount": len(saved_ids),
        "rawAxisCorpusVideoCount": len(axis_corpus_ids),
        "savedAxisTrainingIdOverlap": len(saved_axis_overlap),
        "savedVideoIdHash": hashlib.sha256(
            "\n".join(sorted(saved_ids)).encode()
        ).hexdigest(),
        "rawAxisCorpusIdHash": hashlib.sha256(
            "\n".join(sorted(axis_corpus_ids)).encode()
        ).hexdigest(),
        "rawStoreShape": {
            modality: {
                "rows": len(store["ids"]),
                "dimensions": int(store["vectors"].shape[1]),
                "idSha256": hashlib.sha256(
                    "\n".join(store["ids"]).encode()
                ).hexdigest(),
            }
            for modality, store in stores.items()
        },
        "runtime": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "scikitLearn": sklearn.__version__,
            "boto3": boto3.__version__,
        },
        "warning": "Saved-channel rows currently do not persist the exact scorer/model version that generated their 21 outputs. ID disjointness, exact source-content hashes, array alignment, and runtime versions are recorded, but immutable per-video scorer provenance and atomic multi-modality generation IDs must be added before treating future mixed-version rows as one population.",
    }
    keep_candidates = candidate_registry(len(PRIVATE_FEATURE_NAMES))
    views_feature_names = saved_channel_feature_names(contract)
    views_candidates = candidate_registry(len(views_feature_names))
    if len(keep_candidates) != EXPERIMENT_COUNT or len(views_candidates) != EXPERIMENT_COUNT:
        raise RuntimeError(
            f"candidate registries have keep={len(keep_candidates)} and views={len(views_candidates)}, expected {EXPERIMENT_COUNT}"
        )
    novelty_models = load_novelty_models()
    public_axes = fit_public_axes(stores, private_ids, novelty_models)
    update_status(
        "keep",
        message="Running nested known-account keep search plus unseen-account stress test",
        experiments=EXPERIMENT_COUNT,
    )
    keep = run_keep_track(private_rows, stores, public_axes, keep_candidates)
    update_status(
        "views",
        message="Running nested known-channel views search plus unseen-channel stress test",
        experiments=EXPERIMENT_COUNT,
    )
    views = run_views_track(saved_rows, contract, views_candidates)
    corpus = None
    if not args.skip_corpus_benchmark:
        update_status("corpus", message="Running creator-group raw embedding benchmark")
        corpus = raw_corpus_benchmark(stores, library)
    provenance["sourceArtifacts"] = {
        name: READ_PROVENANCE[name]
        for name in sorted(READ_PROVENANCE)
    }
    coverage = coverage_payload(stores, library, private_rows, saved_rows)
    artifact_complete = bool(
        corpus is not None
        and int(coverage.get("remainingVisual") or 0) == 0
        and int((coverage.get("embedded") or {}).get("together") or 0)
        >= int(coverage.get("scienceCenterStoredShorts") or 0)
    )
    result = {
        "version": 2,
        "generatedAt": int(time.time() * 1000),
        "elapsedSeconds": round(time.time() - started, 1),
        "coverage": coverage,
        "artifactState": {
            "state": "complete" if artifact_complete else "partial",
            "complete": artifact_complete,
            "corpusBenchmarkPresent": corpus is not None,
            "canonicalBackfillComplete": int(coverage.get("remainingVisual") or 0) == 0,
            "message": (
                "All canonical Science Center Shorts are embedded and the corpus benchmark is present."
                if artifact_complete
                else "Research results are usable, but the canonical Science Center backfill or corpus benchmark is still incomplete."
            ),
        },
        "provenance": provenance,
        "experimentRegistry": {
            "evaluatedPerSelection": EXPERIMENT_COUNT,
            "candidateHash": hashlib.sha256(json.dumps(keep_candidates).encode()).hexdigest()[:16],
            "subsetSizes": dict(Counter(str(len(candidate)) for candidate in keep_candidates)),
            "featureCount": len(PRIVATE_FEATURE_NAMES),
            "selection": "All lower-order subsets exhaustively, then a deterministic hash-locked sample of the first subset size that would exceed 50,000",
            "targets": {
                "keep": {
                    "candidateHash": hashlib.sha256(json.dumps(keep_candidates).encode()).hexdigest()[:16],
                    "subsetSizes": dict(Counter(str(len(candidate)) for candidate in keep_candidates)),
                    "featureCount": len(PRIVATE_FEATURE_NAMES),
                },
                "views": {
                    "candidateHash": hashlib.sha256(json.dumps(views_candidates).encode()).hexdigest()[:16],
                    "subsetSizes": dict(Counter(str(len(candidate)) for candidate in views_candidates)),
                    "featureCount": len(views_feature_names),
                },
            },
        },
        "validationRules": [
            "No target-aligned keep or ret5 score is evaluated on a video used to fit that axis.",
            "Known-source hash folds measure retrospective interpolation and may use same-source videos published later; they are never described as prospective forecasts.",
            "Forward-time and whole-source tests are separate and take precedence when judging pre-upload generalization; forward-time tests still reuse present-day frozen representation artifacts and are labeled partial backtests.",
            "Science Center raw-embedding benchmarks refit ridge models and choose regularization inside creator-group training folds.",
            "Views are modeled in log10 space; million-view tail probabilities use only outer-training empirical residual distributions and remain descriptive until many more independent channels and fixed-horizon labels exist.",
            "Likes and comments are excluded because they are post-upload outcomes, not pre-upload inputs.",
            "Text-present, duration, and title-length controls are explicit; missing speech is never silently treated as average speech.",
            "Saved-channel publication dates are backfilled, but view outcomes remain current snapshots until fixed-horizon history is available.",
        ],
        "excludedInputs": [
            {
                "input": "likes, comments, shares, and observed audience response",
                "reason": "post-upload outcomes would make a pre-upload score circular",
            },
            {
                "input": "Tribe realviews labels",
                "reason": "the stored field is derived from outcomes and is not an independent pre-upload feature",
            },
            {
                "input": "Promise-lab outcome-selected components",
                "reason": "they cannot enter this benchmark until a frozen or out-of-fold feature export exists for every evaluated video",
            },
        ],
        "targets": {"keep": keep, "views": views},
        "corpusBenchmark": corpus,
    }
    HERE.mkdir(parents=True, exist_ok=True)
    LOCAL_RESULT.write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    if not args.local_only:
        put_json(R2_RESULT_KEY, result)
    update_status(
        "complete" if artifact_complete else "partial",
        message=(
            "Predictor lab artifact and canonical corpus are complete"
            if artifact_complete
            else "Predictor lab research artifact is ready; canonical corpus backfill remains incomplete"
        ),
        artifactState=result["artifactState"],
        generatedAt=result["generatedAt"],
        elapsedSeconds=result["elapsedSeconds"],
        coverage=result["coverage"],
    )
    print(
        json.dumps(
            {
                "ok": True,
                "result": str(LOCAL_RESULT),
                "elapsedSeconds": result["elapsedSeconds"],
                "keep": keep["metrics"],
                "views": views["metrics"],
                "coverage": result["coverage"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        update_status("error", message=str(error)[:500])
        raise
