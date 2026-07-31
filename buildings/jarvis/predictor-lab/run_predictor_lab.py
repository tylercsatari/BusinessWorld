#!/usr/bin/env python3
"""Build the Shorts Quant keep-rate and views predictor research artifact.

The two targets deliberately use different validation populations:

* keep rate: private retention labels, with video-held-out rows inside known
  accounts as the operational retrospective test plus unseen-account and
  forward-time stress tests;
* views: freshly rebuilt public views/outlier/10M axes whose complete fit
  manifests prove that evaluation rows were absent; stored 21-output scores are
  retained only as non-promotable diagnostics.

Target-aligned keep/ret5 axes are refit inside every private-data fold. Existing
in-sample steered keep/ret5 estimates are never used as validation features.
Weak title-only duplicate families and unresolved creator identities can never
set a leakage-passed or promotable state.
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
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import boto3
import numpy as np
import scipy
import sklearn
from scipy.stats import rankdata, spearmanr
from sklearn.cross_decomposition import PLSRegression
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from shorts_score_ledger import (  # noqa: E402
    GOVERNANCE as COORDINATE_GOVERNANCE,
    ledger_json_bytes,
    score_record_binding_sha256,
    validate_saved_channel_manifest_row_binding,
    validate_shorts_input_manifest,
    validate_score_ledger,
)

CONTRACT_PATH = ROOT / "buildings" / "jarvis" / "saved-channel-feature-contract.json"
LOCAL_RESULT = HERE / "results.json"
R2_RESULT_KEY = "raw/predictor-lab/results.json"
R2_RESULT_MANIFEST_KEY = "raw/predictor-lab/results.manifest.json"
R2_RELEASE_KEY = "raw/predictor-lab/release-v1.json"
R2_STATUS_KEY = "raw/predictor-lab/status.json"
LOCAL_VISUAL_KEEP_MODEL = HERE / "visual-keep-model-v1.json"
R2_VISUAL_KEEP_MODEL_KEY = "raw/predictor-lab/visual-keep-model-v1.json"
R2_VISUAL_KEEP_MODEL_MANIFEST_KEY = (
    "raw/predictor-lab/visual-keep-model-v1.manifest.json"
)
LOCAL_CREATOR_ADAPTIVE_KEEP_MODEL = HERE / "creator-adaptive-keep-model-v1.json"
CAUSAL_KEEP_MIXTURE_BENCHMARK = (
    HERE / "causal-keep-mixture-benchmark.json"
)
R2_CREATOR_ADAPTIVE_KEEP_MODEL_KEY = (
    "raw/predictor-lab/creator-adaptive-keep-model-v1.json"
)
R2_CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY = (
    "raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json"
)
PREDICTOR_RESULT_SCHEMA_VERSION = 3
VISUAL_KEEP_COORDINATE_ID = (
    COORDINATE_GOVERNANCE["coordinates"][
        "visualKeepForecast"
    ]["id"]
)
VISUAL_KEEP_POOLED_ESTIMATOR_ID = "shorts.visual-keep.pooled-ridge.v1"
VISUAL_KEEP_POOLED_ALPHAS = (0.1, 1.0, 10.0)
VISUAL_KEEP_OUTPUT_TRANSFORM = "clip(linear_prediction, 0, 100)"
VISUAL_KEEP_OUTPUT_BOUNDS = (0.0, 100.0)
CREATOR_ADAPTIVE_KEEP_COORDINATE_ID = (
    COORDINATE_GOVERNANCE["coordinates"][
        "creatorAdaptiveKeepForecast"
    ]["id"]
)
CREATOR_ADAPTIVE_KEEP_SCHEMA_VERSION = 3
CREATOR_ADAPTIVE_KEEP_V1_SPEC = {
    "benchmarkId": "shorts.causal-keep-mixture-benchmark.v1",
    "benchmarkCoordinateId": "shorts.causal-keep-mixture.v1",
    "candidateCount": 43_360,
    "candidateRegistrySha256": (
        "bc7ae80a7afeac82a40648c3ff07e066"
        "cc238d3b27918d5f82bf3bbbd04de3ff"
    ),
    "benchmarkArtifactSha256": (
        "c82a290cd4180974d754e6b1c0afec8"
        "d456d08d0434794925936ffb11ea82747"
    ),
    "resultCoreSha256": (
        "a8dc76db007bc1b158c1e9a04775d1a"
        "e7f32656c19b44e733b0523256a42391a"
    ),
    "historyWindow": 30,
    "minimumHistoryN": 8,
}
EXPERIMENT_COUNT = 50_000
MODALITIES = ("visual", "text", "together")
MODALITY_SHORT = {"visual": "vis", "text": "txt", "together": "tog"}
VIEWS_VALIDATION_AXIS_TARGETS = ("views", "outlier", "gt10M")
VIEWS_VALIDATION_FORBIDDEN_TARGETS = frozenset(("keep", "ret5", "realviews"))
VIEWS_VALIDATION_CONDITIONAL_AXES = ("novelty.views",)
VIEWS_MINIMUM_ROWS = 40
VIEWS_MINIMUM_INDEPENDENT_CHANNELS = 3
VIEWS_MINIMUM_VALID_TRANSFER_FOLDS = 3
EPSILON = 1e-9
READ_PROVENANCE: dict[str, dict[str, Any]] = {}
IMMUTABLE_SOURCE_SNAPSHOTS: list[dict[str, Any]] = []


def env(name: str) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    candidates = [
        Path(os.environ["BUSINESS_WORLD_ENV_FILE"])
        if os.environ.get("BUSINESS_WORLD_ENV_FILE")
        else None,
        ROOT / ".env",
        ROOT.parent.parent / ".env",
    ]
    for env_path in candidates:
        if not env_path or not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith(name + "="):
                return (
                    line.split("=", 1)[1]
                    .strip()
                    .strip('"')
                    .strip("'")
                )
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


def verify_read_snapshot_unchanged(
    fetch_bytes: Any = None,
    fetch_local_bytes: Any = None,
) -> dict[str, Any]:
    """Re-read every fitted input before publishing an artifact."""
    if fetch_bytes is None:
        def fetch_bytes(key: str) -> bytes:
            return S3.get_object(
                Bucket=BUCKET,
                Key=key,
            )["Body"].read()
    if fetch_local_bytes is None:
        def fetch_local_bytes(relative_path: str) -> bytes:
            return (ROOT / relative_path).read_bytes()
    checked: list[dict[str, Any]] = []
    for source_name, expected in sorted(READ_PROVENANCE.items()):
        if source_name.startswith("r2:"):
            source_type = "r2"
            key = source_name[3:]
            reader = fetch_bytes
        elif source_name.startswith("local:"):
            source_type = "local"
            key = source_name[6:]
            reader = fetch_local_bytes
        else:
            raise RuntimeError(
                f"unregistered predictor source scheme: {source_name}"
            )
        try:
            payload = reader(key)
        except Exception as error:
            raise RuntimeError(
                "required source disappeared during predictor run: "
                f"{source_name}"
            ) from error
        actual_sha256 = hashlib.sha256(payload).hexdigest()
        if (
            actual_sha256 != expected["sha256"]
            or len(payload) != expected["bytes"]
        ):
            raise RuntimeError(
                f"source changed during predictor run: {source_name}"
            )
        checked.append({
            "source": source_name,
            "type": source_type,
            "key": key,
            "sha256": actual_sha256,
            "bytes": len(payload),
        })
    return {
        "schema": "predictor-read-snapshot-verification-v1",
        "verified": True,
        "artifactCount": len(checked),
        "r2ArtifactCount": sum(
            row["type"] == "r2"
            for row in checked
        ),
        "localArtifactCount": sum(
            row["type"] == "local"
            for row in checked
        ),
        "artifactsSha256": hashlib.sha256(
            ledger_json_bytes(checked)
        ).hexdigest(),
    }


def verify_local_sources_unchanged(
    fetch_local_bytes: Any = None,
) -> dict[str, Any]:
    """Recheck local code/contracts immediately before publication."""
    if fetch_local_bytes is None:
        def fetch_local_bytes(relative_path: str) -> bytes:
            return (ROOT / relative_path).read_bytes()
    checked = []
    for source_name, expected in sorted(READ_PROVENANCE.items()):
        if not source_name.startswith("local:"):
            continue
        relative_path = source_name[6:]
        try:
            payload = fetch_local_bytes(relative_path)
        except Exception as error:
            raise RuntimeError(
                "required local source disappeared before publication: "
                f"{source_name}"
            ) from error
        actual_sha256 = hashlib.sha256(payload).hexdigest()
        if (
            actual_sha256 != expected["sha256"]
            or len(payload) != expected["bytes"]
        ):
            raise RuntimeError(
                f"local source changed before publication: {source_name}"
            )
        checked.append({
            "source": source_name,
            "sha256": actual_sha256,
            "bytes": len(payload),
        })
    return {
        "schema": "predictor-local-publication-verification-v1",
        "verified": True,
        "artifactCount": len(checked),
        "artifactsSha256": hashlib.sha256(
            ledger_json_bytes(checked)
        ).hexdigest(),
    }


def r2_bytes(key: str) -> bytes | None:
    if key.endswith(".npz"):
        return immutable_r2_bytes_snapshot(
            key,
            (
                "raw/predictor-lab/source-snapshots/"
                "npz/by-sha256"
            ),
            content_type="application/octet-stream",
            extension=".npz",
        )
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


def immutable_source_snapshot_descriptor(
    source_key: str,
    payload: bytes,
    archive_prefix: str,
    extension: str = ".json",
) -> dict[str, Any]:
    source_sha256 = hashlib.sha256(payload).hexdigest()
    prefix = archive_prefix.rstrip("/")
    suffix = extension if extension.startswith(".") else f".{extension}"
    return {
        "schema": "predictor-immutable-source-snapshot-v1",
        "sourceKey": source_key,
        "sourceSha256": source_sha256,
        "bytes": len(payload),
        "snapshotKey": f"{prefix}/{source_sha256}{suffix}",
    }


def immutable_r2_bytes_snapshot(
    source_key: str,
    archive_prefix: str,
    *,
    content_type: str,
    extension: str,
) -> bytes | None:
    """Bind a mutable R2 source to immutable, byte-verified content."""
    try:
        response = S3.get_object(
            Bucket=BUCKET,
            Key=source_key,
        )
        payload = response["Body"].read()
    except Exception:
        return None
    descriptor = immutable_source_snapshot_descriptor(
        source_key,
        payload,
        archive_prefix,
        extension,
    )
    snapshot_key = descriptor["snapshotKey"]
    stored = None
    creation_method = "existing"
    try:
        stored = S3.get_object(
            Bucket=BUCKET,
            Key=snapshot_key,
        )["Body"].read()
    except Exception:
        pass
    if stored is None:
        try:
            S3.copy_object(
                Bucket=BUCKET,
                Key=snapshot_key,
                CopySource={"Bucket": BUCKET, "Key": source_key},
                CopySourceIfMatch=str(response.get("ETag") or ""),
                IfNoneMatch="*",
                MetadataDirective="COPY",
            )
            creation_method = "conditional_server_copy"
        except Exception:
            try:
                stored = S3.get_object(
                    Bucket=BUCKET,
                    Key=snapshot_key,
                )["Body"].read()
            except Exception:
                try:
                    S3.put_object(
                        Bucket=BUCKET,
                        Key=snapshot_key,
                        Body=payload,
                        ContentType=content_type,
                        IfNoneMatch="*",
                    )
                    creation_method = "byte_upload"
                except Exception:
                    # A concurrent create is valid only if the exact
                    # read-after-write comparison below succeeds.
                    pass
        if stored is None:
            try:
                stored = S3.get_object(
                    Bucket=BUCKET,
                    Key=snapshot_key,
                )["Body"].read()
            except Exception as error:
                raise RuntimeError(
                    "immutable predictor source snapshot is unavailable: "
                    f"{snapshot_key}"
                ) from error
    if stored != payload:
        raise RuntimeError(
            f"immutable predictor source snapshot differs: {snapshot_key}"
        )
    record_source(f"r2:{snapshot_key}", stored)
    observation = {
        **descriptor,
        "sourceEtag": str(response.get("ETag") or ""),
        "sourceVersionId": response.get("VersionId"),
        "sourceLastModified": (
            response["LastModified"].isoformat()
            if response.get("LastModified") is not None
            else None
        ),
        "readAfterWriteVerified": True,
        "creationMethod": creation_method,
    }
    if not any(
        row.get("sourceKey") == source_key
        and row.get("snapshotKey") == snapshot_key
        for row in IMMUTABLE_SOURCE_SNAPSHOTS
    ):
        IMMUTABLE_SOURCE_SNAPSHOTS.append(observation)
    return stored


def immutable_r2_json_snapshot(
    source_key: str,
    archive_prefix: str,
    default: Any = None,
) -> Any:
    """Bind a mutable JSON source to immutable bytes before model fitting."""
    stored = immutable_r2_bytes_snapshot(
        source_key,
        archive_prefix,
        content_type="application/json",
        extension=".json",
    )
    if stored is None:
        return default
    try:
        return json.loads(stored)
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
    put_bytes(
        key,
        json.dumps(value, separators=(",", ":"), allow_nan=False).encode(),
        "application/json",
    )


def put_bytes(key: str, payload: bytes, content_type: str) -> None:
    S3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=payload,
        ContentType=content_type,
    )


def finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def validate_private_outcome_units(
    video_id: str,
    keep: Any,
    ret5: Any = None,
) -> None:
    if not finite(keep) or not 0 <= float(keep) <= 100:
        raise RuntimeError(
            f"private retention row {video_id} has keep outside "
            "the governed [0, 100] percent unit"
        )
    if finite(ret5) and float(ret5) < 0:
        raise RuntimeError(
            f"private retention row {video_id} has ret5 outside "
            "the governed nonnegative rewatch-capable percent unit"
        )


def clean_number(value: Any, digits: int = 5) -> float | None:
    if not finite(value):
        return None
    return round(float(value), digits)


def stable_hash(value: str) -> int:
    return int(hashlib.sha256(str(value).encode()).hexdigest()[:16], 16)


def fnv1a_32(value: str) -> int:
    """Match saved-channel-validation.js for cross-runtime fold lineage."""
    output = 2166136261
    for character in str(value):
        output ^= ord(character)
        output = (output * 16777619) & 0xFFFFFFFF
    return output


def stable_json_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def normalized_content_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalized_content_evidence(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().lower()


def exact_sha256(value: Any) -> bool:
    return bool(re.fullmatch(r"[a-f0-9]{64}", str(value or "").strip().lower()))


def validation_content_family_evidence(row: dict[str, Any]) -> dict[str, Any]:
    manifest = row.get("inputManifest") or row.get("input_manifest") or {}
    explicit_family = (
        row.get("contentFamilyId")
        or row.get("content_family_id")
    )
    explicit_source = (
        row.get("sourceContentId")
        or row.get("source_content_id")
        or (
            manifest.get("source_content_id")
            or manifest.get("sourceContentId")
            or manifest.get("source_video_id")
            or manifest.get("sourceVideoId")
            if isinstance(manifest, dict)
            else None
        )
    )
    montage_sha256 = (
        row.get("montageSha256")
        or row.get("montage_sha256")
        or (
            (manifest.get("canonical_montage") or {}).get("montage_sha256")
            if isinstance(manifest, dict)
            else None
        )
    )
    perceptual_hash = (
        row.get("perceptualHash")
        or row.get("perceptual_hash")
        or (
            manifest.get("perceptual_hash")
            or manifest.get("perceptualHash")
            if isinstance(manifest, dict)
            else None
        )
    )
    normalized_family = normalized_content_evidence(explicit_family)
    if normalized_family and not normalized_family.startswith("title:"):
        identity_only = normalized_family.startswith("video:")
        return {
            "familyId": (
                normalized_family
                if identity_only or normalized_family.startswith("declared:")
                else f"declared:{normalized_family}"
            ),
            "source": (
                "explicit_video_identity"
                if identity_only
                else "explicit_content_family"
            ),
            "strength": "identity_only" if identity_only else "strong",
            "strongEvidencePresent": not identity_only,
            "promotionEligible": not identity_only,
            "reason": (
                "A row identity cannot protect against a reupload."
                if identity_only
                else "Explicit source-family lineage."
            ),
        }
    normalized_source = normalized_content_evidence(explicit_source)
    if normalized_source:
        return {
            "familyId": (
                normalized_source
                if normalized_source.startswith("declared:")
                else f"declared:{normalized_source}"
            ),
            "source": "explicit_source_content",
            "strength": "strong",
            "strongEvidencePresent": True,
            "promotionEligible": True,
            "reason": "Exact source-content lineage.",
        }
    if exact_sha256(montage_sha256):
        return {
            "familyId": f"declared:{str(montage_sha256).lower()}",
            "source": "canonical_montage_sha256",
            "strength": "strong",
            "strongEvidencePresent": True,
            "promotionEligible": True,
            "reason": "Byte-identical canonical montage.",
        }
    normalized_perceptual_hash = normalized_content_evidence(
        perceptual_hash
    )
    if normalized_perceptual_hash:
        return {
            "familyId": f"declared:{normalized_perceptual_hash}",
            "source": "perceptual_hash",
            "strength": "moderate",
            "strongEvidencePresent": False,
            "promotionEligible": False,
            "reason": (
                "Exact perceptual-hash equality is useful diagnostically, "
                "but no near-duplicate radius is proven."
            ),
        }
    title = (
        normalized_content_text(normalized_family[6:])
        if normalized_family.startswith("title:")
        else normalized_content_text(row.get("title"))
    )
    if title:
        return {
            "familyId": f"title:{title}",
            "source": "normalized_title_fallback",
            "strength": "weak",
            "strongEvidencePresent": False,
            "promotionEligible": False,
            "reason": (
                "Title equality is a weak diagnostic grouping and cannot "
                "establish duplicate-content separation."
            ),
        }
    return {
        "familyId": f"video:{row.get('id') or ''}",
        "source": "row_identity_fallback",
        "strength": "none",
        "strongEvidencePresent": False,
        "promotionEligible": False,
        "reason": "No duplicate-content lineage is available.",
    }


def validation_content_family_id(row: dict[str, Any]) -> str:
    return str(validation_content_family_evidence(row)["familyId"])


def content_family_evidence_audit(
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    evidence_rows = [
        {
            "id": str(row.get("id") or ""),
            **validation_content_family_evidence(row),
        }
        for row in rows
    ]
    counts = Counter(
        str(evidence["strength"])
        for evidence in evidence_rows
    )
    promotable = [
        evidence
        for evidence in evidence_rows
        if evidence["promotionEligible"]
    ]
    rejected = [
        evidence
        for evidence in evidence_rows
        if not evidence["promotionEligible"]
    ]
    return {
        "rowCount": len(evidence_rows),
        "strengthCounts": dict(sorted(counts.items())),
        "strongRowCount": len(promotable),
        "nonPromotableRowCount": len(rejected),
        "allRowsHaveStrongLineage": (
            bool(evidence_rows)
            and len(promotable) == len(evidence_rows)
        ),
        "promotionEligibleVideoIdSha256": hashlib.sha256(
            "\n".join(sorted(row["id"] for row in promotable)).encode()
        ).hexdigest(),
        "nonPromotableVideoIdSha256": hashlib.sha256(
            "\n".join(sorted(row["id"] for row in rejected)).encode()
        ).hexdigest(),
        "nonPromotableRows": rejected,
        "rule": (
            "Only explicit source-family/source-content lineage or an exact "
            "canonical montage SHA can support a promotable held-out claim. "
            "Title, row-identity, and exact perceptual-hash fallbacks remain "
            "diagnostic only."
        ),
    }


def resolve_external_creator_lineage(
    rows: list[dict[str, Any]],
    group_key: str,
    library: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get(group_key) or "")].append(row)
    groups: list[dict[str, Any]] = []
    for internal_id, group_rows in sorted(
        grouped.items(),
        key=lambda item: stable_hash(item[0]),
    ):
        explicit_ids = {
            str(
                row.get("youtubeChannelId")
                or row.get("youtube_channel_id")
            ).strip()
            for row in group_rows
            if str(
                row.get("youtubeChannelId")
                or row.get("youtube_channel_id")
                or ""
            ).strip()
        }
        joined_ids = {
            str((library.get(str(row.get("id") or "")) or {}).get("channelId")).strip()
            for row in group_rows
            if str(
                (library.get(str(row.get("id") or "")) or {}).get("channelId")
                or ""
            ).strip()
        }
        candidates = explicit_ids | joined_ids
        resolved = len(candidates) == 1
        resolved_id = next(iter(candidates)) if resolved else None
        if not candidates:
            reason = (
                "No explicit YouTube channel ID and no canonical video-ID "
                "join to library/db.json were available."
            )
        elif not resolved:
            reason = (
                "Explicit metadata and/or canonical video-ID joins resolved "
                "to conflicting YouTube channel IDs."
            )
        else:
            reason = (
                "Resolved from explicit YouTube metadata and/or exact video-ID "
                "joins; the internal account/channel ID was not used."
            )
        groups.append(
            {
                "internalId": internal_id,
                "name": str(
                    group_rows[0].get(
                        "accountName"
                        if group_key == "account"
                        else "channelName"
                    )
                    or internal_id
                ),
                "rowCount": len(group_rows),
                "resolved": resolved,
                "promotionEligible": resolved,
                "youtubeChannelId": resolved_id,
                "explicitYoutubeChannelIds": sorted(explicit_ids),
                "videoJoinYoutubeChannelIds": sorted(joined_ids),
                "matchedLibraryVideoCount": sum(
                    str(row.get("id") or "") in library
                    and bool(
                        (library.get(str(row.get("id") or "")) or {}).get(
                            "channelId"
                        )
                    )
                    for row in group_rows
                ),
                "reason": reason,
            }
        )
    resolved_ids = sorted(
        {
            str(group["youtubeChannelId"])
            for group in groups
            if group["resolved"] and group["youtubeChannelId"]
        }
    )
    unresolved = [
        group["internalId"]
        for group in groups
        if not group["resolved"]
    ]
    return {
        "groupKey": group_key,
        "groupCount": len(groups),
        "resolvedGroupCount": len(groups) - len(unresolved),
        "unresolvedGroupCount": len(unresolved),
        "allGroupsResolved": bool(groups) and not unresolved,
        "resolvedYoutubeChannelIds": resolved_ids,
        "resolvedYoutubeChannelIdSha256": hashlib.sha256(
            "\n".join(resolved_ids).encode()
        ).hexdigest(),
        "unresolvedInternalIds": unresolved,
        "groups": groups,
        "rule": (
            "Internal Predictor Lab account/channel IDs are never interpreted "
            "as YouTube channel IDs. Resolution requires explicit YouTube "
            "metadata or an exact video-ID join to library/db.json."
        ),
    }


def purge_content_family_overlap(
    rows: list[dict[str, Any]],
    train_indices: np.ndarray,
    test_indices: np.ndarray,
) -> tuple[np.ndarray, dict[str, Any]]:
    train_indices = np.asarray(train_indices, dtype=int)
    test_indices = np.asarray(test_indices, dtype=int)
    test_families = {
        validation_content_family_id(rows[index])
        for index in test_indices
    }
    kept = np.asarray(
        [
            index
            for index in train_indices
            if validation_content_family_id(rows[index])
            not in test_families
        ],
        dtype=int,
    )
    purged_indices = sorted(set(train_indices) - set(kept))
    purged_families = sorted({
        validation_content_family_id(rows[index])
        for index in purged_indices
    })
    return kept, {
        "originalTrainN": len(train_indices),
        "purgedTrainN": len(purged_indices),
        "retainedTrainN": len(kept),
        "purgedFamilyCount": len(purged_families),
        "purgedFamilyIdSha256": hashlib.sha256(
            "\n".join(purged_families).encode()
        ).hexdigest(),
    }


def purge_content_family_rows(
    train_rows: list[dict[str, Any]],
    test_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    test_families = {
        validation_content_family_id(row)
        for row in test_rows
    }
    retained = [
        row
        for row in train_rows
        if validation_content_family_id(row)
        not in test_families
    ]
    purged = [
        row
        for row in train_rows
        if validation_content_family_id(row)
        in test_families
    ]
    purged_families = sorted(
        {
            validation_content_family_id(row)
            for row in purged
        }
    )
    return retained, {
        "originalTrainN": len(train_rows),
        "purgedTrainN": len(purged),
        "retainedTrainN": len(retained),
        "purgedFamilyCount": len(purged_families),
        "purgedFamilyIdSha256": hashlib.sha256(
            "\n".join(purged_families).encode()
        ).hexdigest(),
    }


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
            if not video_id or not finite(keep):
                continue
            validate_private_outcome_units(video_id, keep, ret5)
            if video_id in seen:
                raise RuntimeError(
                    "private retention population contains duplicate "
                    f"video ID {video_id}"
                )
            seen.add(video_id)
            row = {
                "id": video_id,
                "title": str(video.get("title") or video_id),
                "account": channel_id,
                "accountName": str(channel.get("name") or channel_id),
                "keep": float(keep),
                "ret5": float(ret5) if finite(ret5) else None,
                "views": float(video.get("views")) if finite(video.get("views")) else None,
                "duration": float(video.get("duration_s")) if finite(video.get("duration_s")) else None,
                "publishedAt": parse_date(video.get("published")),
                "contentFamilyId": video.get("contentFamilyId")
                or video.get("content_family_id"),
                "sourceContentId": video.get("sourceContentId")
                or video.get("source_content_id"),
                "montageSha256": video.get("montageSha256")
                or video.get("montage_sha256"),
                "perceptualHash": video.get("perceptualHash")
                or video.get("perceptual_hash"),
                "youtubeChannelId": channel.get("youtubeChannelId")
                or channel.get("youtube_channel_id"),
            }
            row["contentFamilyEvidence"] = (
                validation_content_family_evidence(row)
            )
            row["contentFamilyId"] = row[
                "contentFamilyEvidence"
            ]["familyId"]
            rows.append(row)
    return rows


def feature_values(
    video: dict[str, Any],
    definition: dict[str, Any],
    entries_by_feature: dict[str, dict[str, Any]] | None = None,
) -> tuple[float | None, float | None]:
    if entries_by_feature is None:
        try:
            entries_by_feature = {
                str(entry["feature_key"]): entry
                for entry in validate_score_ledger(
                    video.get("score_ledger")
                )
            }
        except (KeyError, TypeError, ValueError):
            entries_by_feature = {}
    cell = entries_by_feature.get(definition["key"]) or {}
    raw_value = cell.get("value")
    percentile_value = cell.get("percentile")
    raw = float(raw_value) if finite(raw_value) else None
    percentile = (
        float(percentile_value) / 100
        if finite(percentile_value)
        else None
    )
    if raw is not None and definition.get("unit") == "views" and definition.get("source") == "steer":
        raw = math.log10(max(0, raw) + 1)
    return raw, percentile


def saved_channel_feature_names(contract: dict[str, Any]) -> list[str]:
    names = []
    for definition in contract["features"]:
        names.extend([f"{definition['key']}.raw", f"{definition['key']}.percentile"])
    return names + ["text.present", "duration.log", "title.words"]


def saved_channel_manifest_row_valid(video: dict[str, Any]) -> bool:
    return bool(
        validate_saved_channel_manifest_row_binding(video)["valid"]
        and video.get("evidence_state") == "canonical_bound"
        and video.get("canonical") is True
        and video.get("predictor_eligible") is True
    )


def validate_saved_channel_record_artifact(
    channel_id: str,
    video: dict[str, Any],
) -> dict[str, Any]:
    video_id = str(video.get("id") or "")
    artifact_sha256 = str(
        video.get("record_artifact_sha256") or ""
    )
    artifact_length = video.get("record_byte_length")
    errors: list[str] = []
    record_key = (
        f"raw/saved-channels/{channel_id}/video-artifacts/"
        f"by-sha256/{artifact_sha256}.json"
    )
    record_bytes = r2_bytes(record_key)
    if not record_bytes:
        return {
            "valid": False,
            "record": None,
            "recordKey": record_key,
            "errors": ["content-addressed full score record is missing"],
        }
    if hashlib.sha256(record_bytes).hexdigest() != artifact_sha256:
        errors.append("full score record artifact hash differs")
    if (
        not isinstance(artifact_length, int)
        or isinstance(artifact_length, bool)
        or len(record_bytes) != artifact_length
    ):
        errors.append("full score record byte length differs")
    try:
        record = json.loads(record_bytes)
    except Exception:
        return {
            "valid": False,
            "record": None,
            "recordKey": record_key,
            "errors": errors + ["full score record is invalid JSON"],
        }
    record_id = str(
        record.get("id")
        or record.get("savedChannelVideoId")
        or record.get("sourceVideoId")
        or ""
    )
    if record_id != video_id:
        errors.append("full score record video identity differs")
    recorded_score_record_sha256 = str(
        record.get("score_record_sha256") or ""
    )
    row_score_record_sha256 = str(
        video.get("score_record_sha256") or ""
    )
    calculated_score_record_sha256 = (
        score_record_binding_sha256(record)
    )
    if (
        recorded_score_record_sha256
            != calculated_score_record_sha256
        or row_score_record_sha256
            != calculated_score_record_sha256
    ):
        errors.append("score-record binding differs")
    record_ledger = record.get("score_ledger")
    row_ledger = video.get("score_ledger")
    if ledger_json_bytes(record_ledger) != ledger_json_bytes(row_ledger):
        errors.append("full record and manifest score ledgers differ")
    record_manifest = record.get("input_manifest")
    row_manifest = video.get("input_manifest")
    if ledger_json_bytes(record_manifest) != ledger_json_bytes(row_manifest):
        errors.append("full record and manifest input revisions differ")
    montage_key = (
        f"raw/saved-channels/{channel_id}/montages/{video_id}.jpg"
    )
    montage_bytes = r2_bytes(montage_key)
    if not montage_bytes:
        errors.append("canonical saved-channel montage is missing")
        input_validation = {
            "valid": False,
            "errors": ["canonical saved-channel montage is missing"],
        }
    else:
        input_validation = validate_shorts_input_manifest(
            record,
            {
                "montageBytes": montage_bytes,
                "text": (
                    record.get("text")
                    if "text" in record
                    else record.get("transcript") or ""
                ),
                "durationS": (
                    (record_manifest or {}).get("duration_s")
                ),
                "creatorProfile": (
                    (record_manifest or {}).get("creator_profile")
                ),
            },
        )
        errors.extend(input_validation.get("errors") or [])
    return {
        "valid": not errors,
        "record": record,
        "recordKey": record_key,
        "montageKey": montage_key,
        "inputValidation": input_validation,
        "errors": list(dict.fromkeys(errors)),
    }


def load_saved_channel_rows(
    contract: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    index = required_r2_json("raw/saved-channels/index.json")
    if not isinstance(index, dict) or not isinstance(index.get("channels"), list):
        raise RuntimeError("saved-channel index is missing its channels list")
    rows: list[dict[str, Any]] = []
    seen_video_ids: set[str] = set()
    evidence_inventory = {
        "doneRows": 0,
        "canonicalEligibleRows": 0,
        "historicalUnboundRows": 0,
        "invalidBindingRows": 0,
        "invalidLedgerRows": 0,
        "invalidRecordArtifactRows": 0,
        "invalidInputBindingRows": 0,
        "canonicalNonPredictiveRows": 0,
        "excludedSamples": [],
    }
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
            evidence_inventory["doneRows"] += 1
            video_id = str(video.get("id") or "")
            if not video_id:
                continue
            if video_id in seen_video_ids:
                raise RuntimeError(
                    "saved-channel validation population contains duplicate "
                    f"video ID {video_id}"
                )
            seen_video_ids.add(video_id)
            binding_validation = (
                validate_saved_channel_manifest_row_binding(video)
            )
            if not binding_validation["valid"]:
                evidence_inventory["invalidBindingRows"] += 1
                continue
            if video.get("evidence_state") == "historical_unbound_input":
                evidence_inventory["historicalUnboundRows"] += 1
                continue
            if not saved_channel_manifest_row_valid(video):
                evidence_inventory[
                    "canonicalNonPredictiveRows"
                ] += 1
                continue
            record_validation = (
                validate_saved_channel_record_artifact(
                    channel_id,
                    video,
                )
            )
            if not record_validation["valid"]:
                input_errors = (
                    record_validation.get("inputValidation") or {}
                ).get("errors") or []
                if input_errors:
                    evidence_inventory[
                        "invalidInputBindingRows"
                    ] += 1
                else:
                    evidence_inventory[
                        "invalidRecordArtifactRows"
                    ] += 1
                if len(evidence_inventory["excludedSamples"]) < 20:
                    evidence_inventory["excludedSamples"].append({
                        "channel": channel_id,
                        "id": video_id,
                        "errors": record_validation["errors"],
                    })
                continue
            try:
                ledger = video.get("score_ledger")
                entries = validate_score_ledger(ledger)
                ledger_state = "canonical-current"
                entries_by_feature = {
                    str(entry["feature_key"]): entry
                    for entry in entries
                }
            except (KeyError, TypeError, ValueError):
                evidence_inventory["invalidLedgerRows"] += 1
                continue
            pairs = [
                feature_values(
                    video,
                    definition,
                    entries_by_feature,
                )
                for definition in contract["features"]
            ]
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
            row = {
                "id": video_id,
                "title": str(video.get("title") or video_id),
                "channel": channel_id,
                "channelName": str(manifest.get("name") or channel.get("name") or channel_id),
                "youtubeChannelId": (
                    video.get("youtubeChannelId")
                    or video.get("youtube_channel_id")
                    or manifest.get("youtubeChannelId")
                    or manifest.get("youtube_channel_id")
                    or channel.get("youtubeChannelId")
                    or channel.get("youtube_channel_id")
                ),
                "views": float(video["views"]),
                "logViews": math.log10(float(video["views"]) + 1),
                "features": vector,
                "ageDays": age_days,
                "duration": duration,
                "publishedAt": published_at,
                "scoreLedgerSha256": ledger.get("ledger_sha256"),
                "scoreLedgerState": ledger_state,
                "scoreRecordSha256": video.get(
                    "score_record_sha256"
                ),
                "manifestRowSha256": video.get(
                    "manifest_row_sha256"
                ),
                "inputRevisionFingerprint": (
                    (video.get("input_manifest") or {}).get(
                        "revision_fingerprint"
                    )
                ),
                "historicalMaterialized": any(
                    (entry.get("provenance") or {}).get("status")
                    == "historical_materialization"
                    for entry in entries
                ),
                "priorScoreLedgerSha256": (
                    (ledger.get("migration_provenance") or {}).get(
                        "prior_ledger_sha256"
                    )
                ),
            }
            row["contentFamilyEvidence"] = (
                validation_content_family_evidence(video)
            )
            row["contentFamilyId"] = row[
                "contentFamilyEvidence"
            ]["familyId"]
            rows.append(row)
            evidence_inventory["canonicalEligibleRows"] += 1
    evidence_inventory["excludedRows"] = (
        evidence_inventory["doneRows"]
        - evidence_inventory["canonicalEligibleRows"]
    )
    return rows, evidence_inventory


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


class QuantileMappedRegressor:
    """Production-parity latent axis with an outcome-calibrated output scale."""

    def __init__(
        self,
        model: PLSRegression,
        prediction_sorted: np.ndarray,
        outcome_sorted: np.ndarray,
    ) -> None:
        self.model = model
        self.prediction_sorted = np.asarray(prediction_sorted, dtype=float)
        self.outcome_sorted = np.asarray(outcome_sorted, dtype=float)

    @classmethod
    def fit(cls, features: np.ndarray, outcomes: np.ndarray) -> "QuantileMappedRegressor":
        model = PLSRegression(n_components=1).fit(features, outcomes)
        train_prediction = np.asarray(model.predict(features), dtype=float).reshape(-1)
        return cls(model, np.sort(train_prediction), np.sort(np.asarray(outcomes, dtype=float)))

    def ranks(self, features: np.ndarray) -> np.ndarray:
        prediction = np.asarray(self.model.predict(features), dtype=float).reshape(-1)
        denominator = max(1, len(self.prediction_sorted) - 1)
        return np.clip(
            np.searchsorted(self.prediction_sorted, prediction, side="left") / denominator,
            0,
            1,
        )

    def predict(self, features: np.ndarray) -> np.ndarray:
        rank = self.ranks(features)
        indices = np.rint(rank * max(0, len(self.outcome_sorted) - 1)).astype(int)
        return self.outcome_sorted[np.clip(indices, 0, len(self.outcome_sorted) - 1)]


class RankCalibratedBinaryAxis:
    """Production-parity local class rate along a one-component latent rank."""

    def __init__(
        self,
        model: PLSRegression,
        prediction_sorted: np.ndarray,
        outcomes_by_prediction: np.ndarray,
    ) -> None:
        self.model = model
        self.prediction_sorted = np.asarray(prediction_sorted, dtype=float)
        self.outcomes_by_prediction = np.asarray(outcomes_by_prediction, dtype=float)

    @classmethod
    def fit(cls, features: np.ndarray, outcomes: np.ndarray) -> "RankCalibratedBinaryAxis":
        model = PLSRegression(n_components=1).fit(features, outcomes)
        train_prediction = np.asarray(model.predict(features), dtype=float).reshape(-1)
        order = np.argsort(train_prediction)
        return cls(model, train_prediction[order], np.asarray(outcomes, dtype=float)[order])

    def ranks(self, features: np.ndarray) -> np.ndarray:
        prediction = np.asarray(
            self.model.predict(features),
            dtype=float,
        ).reshape(-1)
        denominator = max(1, len(self.prediction_sorted) - 1)
        return np.clip(
            np.searchsorted(
                self.prediction_sorted,
                prediction,
                side="left",
            )
            / denominator,
            0,
            1,
        )

    def predict_proba(self, features: np.ndarray) -> np.ndarray:
        ranks = self.ranks(features)
        count = len(self.outcomes_by_prediction)
        radius = max(1, count // 20)
        probabilities = np.empty(len(ranks), dtype=float)
        for index, rank in enumerate(ranks):
            center = int(round(float(rank) * max(0, count - 1)))
            local = self.outcomes_by_prediction[
                max(0, center - radius) : min(count, center + radius)
            ]
            probabilities[index] = float(local.mean()) if len(local) else float(
                self.outcomes_by_prediction[center]
            )
        probabilities = np.clip(probabilities, 0, 1)
        return np.column_stack([1 - probabilities, probabilities])


def fit_public_axes(
    stores: dict[str, dict[str, Any]],
    excluded_ids: set[str],
    novelty_models: dict[str, np.ndarray],
    library: dict[str, dict[str, Any]],
    excluded_youtube_channel_ids: set[str] | None = None,
    excluded_content_family_ids: set[str] | None = None,
) -> dict[str, dict[str, Any]]:
    excluded_youtube_channel_ids = {
        str(value)
        for value in (excluded_youtube_channel_ids or set())
        if str(value)
    }
    excluded_ids = {str(value) for value in excluded_ids}
    excluded_content_family_ids = {
        str(value)
        for value in (excluded_content_family_ids or set())
        if str(value)
    }
    excluded_video_id_sha256 = hashlib.sha256(
        "\n".join(sorted(excluded_ids)).encode()
    ).hexdigest()
    excluded_creator_id_sha256 = hashlib.sha256(
        "\n".join(sorted(excluded_youtube_channel_ids)).encode()
    ).hexdigest()
    excluded_content_family_id_sha256 = hashlib.sha256(
        "\n".join(sorted(excluded_content_family_ids)).encode()
    ).hexdigest()
    models: dict[str, dict[str, Any]] = {}
    for modality, store in stores.items():
        content_evidence = {
            str(video_id): validation_content_family_evidence(
                {
                    **(library.get(str(video_id)) or {}),
                    "id": str(video_id),
                    "title": (
                        store["titles"][index]
                        if index < len(store["titles"])
                        else (
                            library.get(str(video_id)) or {}
                        ).get("title")
                    ),
                }
            )
            for index, video_id in enumerate(store["ids"])
        }
        unresolved_creator_ids = [
            str(video_id)
            for index, video_id in enumerate(store["ids"])
            if (
                not store["mine"][index]
                and video_id not in excluded_ids
                and not bool((library.get(video_id) or {}).get("channelId"))
                and finite(store["views"][index])
                and store["views"][index] > 0
                and float(np.linalg.norm(store["vectors"][index])) > EPSILON
            )
        ]
        public = np.array(
            [
                not store["mine"][index]
                and video_id not in excluded_ids
                and bool((library.get(video_id) or {}).get("channelId"))
                and str(
                    (library.get(video_id) or {}).get("channelId")
                )
                not in excluded_youtube_channel_ids
                and content_evidence[str(video_id)][
                    "familyId"
                ]
                not in excluded_content_family_ids
                and finite(store["views"][index])
                and store["views"][index] > 0
                and float(np.linalg.norm(store["vectors"][index])) > EPSILON
                for index, video_id in enumerate(store["ids"])
            ],
            dtype=bool,
        )
        X = store["vectors"][public]
        views = store["views"][public]
        outlier = store["outlier"][public]
        valid_outlier = np.isfinite(outlier) & (outlier > 0)
        public_ids = [
            str(video_id)
            for index, video_id in enumerate(store["ids"])
            if bool(public[index])
        ]
        outlier_ids = [
            public_ids[index]
            for index, eligible in enumerate(valid_outlier)
            if bool(eligible)
        ]
        channel_ids = {
            video_id: str((library.get(video_id) or {}).get("channelId") or "")
            for video_id in public_ids
        }
        unresolved_ids = sorted(
            video_id for video_id, channel_id in channel_ids.items()
            if not channel_id
        )
        if unresolved_ids:
            raise RuntimeError(
                f"public {modality} axis has {len(unresolved_ids)} rows without "
                "a canonical YouTube channel ID; creator overlap cannot be audited"
            )

        def fit_manifest(
            target: str,
            ids: list[str],
        ) -> dict[str, Any]:
            rows = sorted(
                (
                    {
                        "id": video_id,
                        "channelId": channel_ids[video_id],
                        "contentFamilyId": content_evidence[
                            video_id
                        ]["familyId"],
                        "contentFamilySource": content_evidence[
                            video_id
                        ]["source"],
                        "contentFamilyStrength": content_evidence[
                            video_id
                        ]["strength"],
                        "strongContentLineage": bool(
                            content_evidence[video_id][
                                "promotionEligible"
                            ]
                        ),
                    }
                    for video_id in ids
                ),
                key=lambda row: (row["id"], row["channelId"]),
            )
            return {
                "schema": "predictor-lab-upstream-axis-fit-v1",
                "axisTarget": target,
                "fitOutcome": (
                    "current public log10 views"
                    if target == "views"
                    else "current public log10 outlier"
                    if target == "outlier"
                    else "current public views strictly greater than 10,000,000"
                ),
                "rows": rows,
                "rowCount": len(rows),
                "rowsSha256": stable_json_sha256(rows),
                "excludedVideoIdCount": len(excluded_ids),
                "excludedVideoIdSha256": excluded_video_id_sha256,
                "excludedYoutubeChannelIdCount": len(
                    excluded_youtube_channel_ids
                ),
                "excludedYoutubeChannelIdSha256": (
                    excluded_creator_id_sha256
                ),
                "excludedContentFamilyIdCount": len(
                    excluded_content_family_ids
                ),
                "excludedContentFamilyIdSha256": (
                    excluded_content_family_id_sha256
                ),
            }

        fit_manifests = {
            "views": fit_manifest("views", public_ids),
            "outlier": fit_manifest("outlier", outlier_ids),
            "gt10M": fit_manifest("gt10M", public_ids),
        }
        population = {
            "creatorResolution": {
                "excludedRowCount": len(unresolved_creator_ids),
                "excludedVideoIdSha256": hashlib.sha256(
                    "\n".join(sorted(unresolved_creator_ids)).encode()
                ).hexdigest(),
                "rule": "Rows without a canonical YouTube channel ID cannot support a creator-exclusion claim and are excluded before fitting.",
            },
            "creatorExclusion": {
                "youtubeChannelIdCount": len(
                    excluded_youtube_channel_ids
                ),
                "youtubeChannelIdSha256": excluded_creator_id_sha256,
                "rule": (
                    "Every raw row whose canonical library YouTube channel ID "
                    "matches a resolved validation creator is excluded before "
                    "any public outcome axis is fit."
                ),
            },
            "contentFamilyExclusion": {
                "contentFamilyIdCount": len(
                    excluded_content_family_ids
                ),
                "contentFamilyIdSha256": (
                    excluded_content_family_id_sha256
                ),
                "weakFitRowCount": sum(
                    not content_evidence[video_id][
                        "promotionEligible"
                    ]
                    for video_id in public_ids
                ),
                "rule": (
                    "Every strongly identified evaluation content family is "
                    "excluded before fitting. Fit rows without strong source "
                    "lineage remain usable only for diagnostics."
                ),
            },
            "views": {
                "rowCount": len(public_ids),
                "videoIdSha256": hashlib.sha256(
                    "\n".join(sorted(public_ids)).encode()
                ).hexdigest(),
                "selectionRule": "non-owned, creator-resolved, creator-excluded, finite positive views, nonzero aligned modality embedding",
            },
            "outlier": {
                "rowCount": len(outlier_ids),
                "videoIdSha256": hashlib.sha256(
                    "\n".join(sorted(outlier_ids)).encode()
                ).hexdigest(),
                "selectionRule": "views-eligible rows with finite positive outlier",
            },
            "gt10M": {
                "rowCount": len(public_ids),
                "videoIdSha256": hashlib.sha256(
                    "\n".join(sorted(public_ids)).encode()
                ).hexdigest(),
                "selectionRule": "same eligible rows as views; label is strictly views > 10,000,000",
            },
        }
        view_model = QuantileMappedRegressor.fit(X, np.log10(views + 1))
        outlier_model = QuantileMappedRegressor.fit(
            X[valid_outlier], np.log10(outlier[valid_outlier] + 1)
        )
        binary = (views > 10_000_000).astype(int)
        if binary.sum() >= 10 and (len(binary) - binary.sum()) >= 10:
            hit_model = RankCalibratedBinaryAxis.fit(X, binary)
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
            "method": "one-component PLS rank mapped to the public outcome distribution",
            "population": population,
            "fitManifests": fit_manifests,
        }
    return models


def leakage_safe_views_feature_names() -> list[str]:
    return [
        f"{modality}.{target}.{variant}"
        for modality in MODALITIES
        for target in VIEWS_VALIDATION_AXIS_TARGETS
        for variant in ("raw", "percentile")
    ]


def leakage_safe_views_feature_definitions() -> list[dict[str, Any]]:
    raw_units = {
        "views": "log10(current public views + 1)",
        "outlier": "log10(current public outlier + 1)",
        "gt10M": "outer-corpus local probability in [0, 1]",
    }
    return [
        {
            "feature": f"{modality}.{target}.{variant}",
            "modality": modality,
            "axisTarget": target,
            "valueRole": variant,
            "unit": (
                raw_units[target]
                if variant == "raw"
                else "fit-population rank in [0, 1]"
            ),
            "preUploadInput": True,
            "upstreamOutcomeFit": True,
            "eligibilityRule": (
                "Eligible only when the upstream fit manifest proves zero "
                "evaluation-video and resolved-creator overlap."
            ),
        }
        for modality in MODALITIES
        for target in VIEWS_VALIDATION_AXIS_TARGETS
        for variant in ("raw", "percentile")
    ]


def audit_public_axis_provenance(
    public_axes: dict[str, dict[str, Any]],
    evaluation_rows: list[dict[str, Any]],
    creator_lineage: dict[str, Any],
) -> dict[str, Any]:
    evaluation_ids = {
        str(row.get("id") or "")
        for row in evaluation_rows
        if str(row.get("id") or "")
    }
    evaluation_creator_ids = {
        str(value)
        for value in creator_lineage.get(
            "resolvedYoutubeChannelIds",
            [],
        )
        if str(value)
    }
    evaluation_content_evidence = [
        validation_content_family_evidence(row)
        for row in evaluation_rows
    ]
    evaluation_strong_family_ids = {
        str(evidence["familyId"])
        for evidence in evaluation_content_evidence
        if evidence["promotionEligible"]
    }
    coordinate_audits: list[dict[str, Any]] = []
    for modality in MODALITIES:
        axes = public_axes.get(modality) or {}
        manifests = axes.get("fitManifests") or {}
        for target in VIEWS_VALIDATION_AXIS_TARGETS:
            blockers: list[str] = []
            manifest = manifests.get(target)
            model_key = "hit10m" if target == "gt10M" else target
            if not isinstance(manifest, dict):
                blockers.append("fit manifest is missing")
                manifest = {}
            rows = manifest.get("rows")
            if not isinstance(rows, list):
                blockers.append("fit-manifest rows are missing")
                rows = []
            if manifest.get("schema") != (
                "predictor-lab-upstream-axis-fit-v1"
            ):
                blockers.append("fit-manifest schema is not canonical")
            if manifest.get("axisTarget") != target:
                blockers.append("fit-manifest target does not match")
            if manifest.get("rowsSha256") != stable_json_sha256(rows):
                blockers.append("fit-manifest row hash does not verify")
            if manifest.get("rowCount") != len(rows):
                blockers.append(
                    "fit-manifest row count does not verify"
                )
            fit_ids = {
                str(row.get("id") or "")
                for row in rows
                if isinstance(row, dict)
                and str(row.get("id") or "")
            }
            fit_creator_ids = {
                str(row.get("channelId") or "")
                for row in rows
                if isinstance(row, dict)
                and str(row.get("channelId") or "")
            }
            fit_strong_family_ids = {
                str(row.get("contentFamilyId") or "")
                for row in rows
                if isinstance(row, dict)
                and row.get("strongContentLineage") is True
                and str(row.get("contentFamilyId") or "")
            }
            weak_fit_row_count = sum(
                not isinstance(row, dict)
                or row.get("strongContentLineage") is not True
                for row in rows
            )
            unresolved_fit_rows = [
                row
                for row in rows
                if not isinstance(row, dict)
                or not str(row.get("id") or "")
                or not str(row.get("channelId") or "")
            ]
            if unresolved_fit_rows:
                blockers.append(
                    "fit manifest contains rows without canonical video "
                    "and YouTube channel IDs"
                )
            video_overlap = sorted(fit_ids & evaluation_ids)
            creator_overlap = sorted(
                fit_creator_ids & evaluation_creator_ids
            )
            content_family_overlap = sorted(
                fit_strong_family_ids
                & evaluation_strong_family_ids
            )
            if video_overlap:
                blockers.append(
                    "evaluation video IDs occur in the upstream fit"
                )
            if creator_overlap:
                blockers.append(
                    "evaluation creators occur in the upstream fit"
                )
            if content_family_overlap:
                blockers.append(
                    "strong evaluation content families occur in the "
                    "upstream fit"
                )
            if not exact_sha256(
                manifest.get("excludedVideoIdSha256")
            ):
                blockers.append(
                    "excluded-video population hash is missing"
                )
            if not exact_sha256(
                manifest.get("excludedYoutubeChannelIdSha256")
            ):
                blockers.append(
                    "excluded-creator population hash is missing"
                )
            if not exact_sha256(
                manifest.get("excludedContentFamilyIdSha256")
            ):
                blockers.append(
                    "excluded-content-family population hash is missing"
                )
            if axes.get(model_key) is None:
                blockers.append("fitted axis model is missing")
            coordinate_audits.append(
                {
                    "featurePrefix": f"{modality}.{target}",
                    "modality": modality,
                    "target": target,
                    "fitRowCount": len(rows),
                    "fitRowsSha256": manifest.get("rowsSha256"),
                    "evaluationVideoOverlapCount": len(
                        video_overlap
                    ),
                    "evaluationCreatorOverlapCount": len(
                        creator_overlap
                    ),
                    "evaluationContentFamilyOverlapCount": len(
                        content_family_overlap
                    ),
                    "weakFitContentLineageRowCount": (
                        weak_fit_row_count
                    ),
                    "strongFitContentLineagePassed": (
                        weak_fit_row_count == 0
                    ),
                    "passed": not blockers,
                    "blockers": blockers,
                }
            )
    required_axes_passed = bool(coordinate_audits) and all(
        coordinate["passed"]
        for coordinate in coordinate_audits
    )
    creator_exclusion_passed = bool(
        creator_lineage.get("allGroupsResolved")
    ) and all(
        coordinate["evaluationCreatorOverlapCount"] == 0
        for coordinate in coordinate_audits
    )
    fit_content_lineage_passed = bool(
        coordinate_audits
    ) and all(
        coordinate["strongFitContentLineagePassed"]
        and coordinate[
            "evaluationContentFamilyOverlapCount"
        ]
        == 0
        for coordinate in coordinate_audits
    )
    conditional_axes = [
        {
            "featurePrefix": axis,
            "eligible": False,
            "reason": (
                "The stored novelty-views coordinate has no producer-readable "
                "fit-population manifest proving that evaluation rows and "
                "creators were absent. It is retained only in diagnostics."
            ),
        }
        for axis in VIEWS_VALIDATION_CONDITIONAL_AXES
    ]
    return {
        "schema": "predictor-lab-upstream-axis-audit-v1",
        "evaluationRowCount": len(evaluation_ids),
        "evaluationVideoIdSha256": hashlib.sha256(
            "\n".join(sorted(evaluation_ids)).encode()
        ).hexdigest(),
        "evaluationCreatorLineage": creator_lineage,
        "requiredCoordinates": coordinate_audits,
        "requiredAxesPassed": required_axes_passed,
        "wholeCreatorExclusionPassed": (
            creator_exclusion_passed
        ),
        "strongFitContentLineagePassed": (
            fit_content_lineage_passed
        ),
        "upstreamLeakagePassed": (
            required_axes_passed
            and creator_exclusion_passed
            and fit_content_lineage_passed
        ),
        "eligibleFeatureNames": (
            leakage_safe_views_feature_names()
            if required_axes_passed
            else []
        ),
        "eligibleFeatureDefinitions": (
            leakage_safe_views_feature_definitions()
            if required_axes_passed
            else []
        ),
        "forbiddenTargets": sorted(
            VIEWS_VALIDATION_FORBIDDEN_TARGETS
        ),
        "conditionalCoordinates": conditional_axes,
        "rule": (
            "Views validation may consume only freshly rebuilt visual, text, "
            "and together views/outlier/gt10M axes whose complete fit-row "
            "manifests prove zero evaluation-video overlap. A promotable "
            "held-out claim additionally requires every evaluation creator to resolve "
            "to a canonical YouTube channel ID with zero creator overlap and "
            "strong source/content lineage across both fit and evaluation rows."
        ),
    }


def leakage_safe_views_rows(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
    axis_audit: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not axis_audit.get("requiredAxesPassed"):
        raise RuntimeError(
            "views validation is closed because upstream axis provenance "
            "did not prove evaluation-row disjointness"
        )
    expected_names = leakage_safe_views_feature_names()
    if axis_audit.get("eligibleFeatureNames") != expected_names:
        raise RuntimeError(
            "views validation allowlist disagrees with the audited feature "
            "contract"
        )
    safe_rows: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for row in rows:
        features: list[float | None] = []
        modality_count = 0
        for modality in MODALITIES:
            store = stores.get(modality) or {}
            vector_index = (store.get("index") or {}).get(row["id"])
            axes = public_axes.get(modality) or {}
            if vector_index is None:
                features.extend([None] * 6)
                continue
            vector = np.asarray(
                store["vectors"][vector_index : vector_index + 1],
                dtype=float,
            )
            modality_count += 1
            views_axis = axes["views"]
            outlier_axis = axes["outlier"]
            hit_axis = axes.get("hit10m")
            features.extend(
                [
                    float(views_axis.predict(vector)[0]),
                    float(views_axis.ranks(vector)[0]),
                    float(outlier_axis.predict(vector)[0]),
                    float(outlier_axis.ranks(vector)[0]),
                    (
                        float(
                            hit_axis.predict_proba(vector)[0, 1]
                        )
                        if hit_axis is not None
                        else None
                    ),
                    (
                        float(hit_axis.ranks(vector)[0])
                        if hit_axis is not None
                        else None
                    ),
                ]
            )
        finite_count = sum(finite(value) for value in features)
        if modality_count == 0 or finite_count < 4:
            excluded.append(
                {
                    "id": row["id"],
                    "reason": (
                        "No aligned raw embedding supplied enough rebuilt "
                        "leakage-safe axis values."
                    ),
                    "finiteFeatureCount": finite_count,
                }
            )
            continue
        safe_row = dict(row)
        safe_row["features"] = features
        safe_row["validationFeatureSource"] = (
            "freshly rebuilt disjoint public axes"
        )
        safe_rows.append(safe_row)
    return safe_rows, excluded


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
        # Target-aligned keep/ret5/realviews axes require at least eight
        # genuinely external training rows. Keep the outcome-independent public
        # axes available, but never fit a row's target back onto itself.
        return private_raw_features([], rows, stores, public_axes)
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


def within_group_folds(
    rows: list[dict[str, Any]],
    group_key: str,
    requested: int = 5,
) -> np.ndarray:
    """Keep exact/declared content families together while balancing creators."""
    assigned = np.zeros(len(rows), dtype=int)
    families: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows):
        family_id = validation_content_family_id(row)
        group_id = str(row.get(group_key) or "unknown")
        family = families.setdefault(
            family_id,
            {
                "familyId": family_id,
                "indices": [],
                "groups": Counter(),
                "hash": fnv1a_32(f"outer:{family_id}"),
            },
        )
        family["indices"].append(index)
        family["groups"][group_id] += 1
    fold_count = max(0, min(int(requested or 5), 5, len(families)))
    if fold_count < 2:
        return assigned
    states = [
        {"rows": 0, "groups": Counter()}
        for _ in range(fold_count)
    ]
    ordered = sorted(
        families.values(),
        key=lambda family: (
            -len(family["indices"]),
            family["hash"],
            family["familyId"],
        ),
    )
    for family in ordered:
        selected = 0
        selected_cost = math.inf
        for fold, state in enumerate(states):
            group_cost = sum(
                state["groups"][group_id] + count
                for group_id, count in family["groups"].items()
            )
            cost = state["rows"] + len(family["indices"]) + group_cost
            if (
                cost < selected_cost
                or (
                    cost == selected_cost
                    and state["rows"] < states[selected]["rows"]
                )
                or (
                    cost == selected_cost
                    and state["rows"] == states[selected]["rows"]
                    and fold < selected
                )
            ):
                selected = fold
                selected_cost = cost
        for index in family["indices"]:
            assigned[index] = selected
        states[selected]["rows"] += len(family["indices"])
        states[selected]["groups"].update(family["groups"])
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
    actual = np.asarray(actual, dtype=float).reshape(-1)
    predicted = np.asarray(predicted, dtype=float).reshape(-1)
    if len(actual) != len(predicted):
        raise ValueError("actual and predicted arrays must have equal length")
    total = len(actual)
    valid = np.isfinite(actual) & np.isfinite(predicted)
    actual = actual[valid]
    predicted = predicted[valid]
    if not len(actual):
        return {
            "n": 0,
            "total": total,
            "missingPairsExcluded": total,
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
        "total": total,
        "missingPairsExcluded": int(total - len(actual)),
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
    valid = np.isfinite(actual) & np.isfinite(predicted)
    actual = actual[valid]
    predicted = predicted[valid]
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
        folds = within_group_folds(
            rows,
            "account",
            min(4, max(2, len(rows) // 8)),
        )
        if len(set(int(value) for value in folds)) < 2:
            # With neither a second creator nor two separable content families,
            # target-aligned features are unidentified. Preserve only
            # outcome-independent inputs and fail closed on the private axes.
            return private_base_features([], rows, stores, public_axes)
        return private_fold_oof(
            rows,
            folds,
            stores,
            public_axes,
        )
    for group in groups:
        train = [row for row in rows if row["account"] != group]
        eval_indices = [index for index, row in enumerate(rows) if row["account"] == group]
        evaluated = [rows[index] for index in eval_indices]
        train, _ = purge_content_family_rows(
            train,
            evaluated,
        )
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
        if split_mode == "group":
            train_rows, _ = purge_content_family_rows(
                train_rows,
                test_rows,
            )
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
        train_rows, family_purge = purge_content_family_rows(
            train_rows,
            test_rows,
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
                "contentFamilyPurge": family_purge,
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
        "description": "Each expanding window fits the private target axes, input selection, weights, and account calibration only on videos published earlier than its test videos. Training rows sharing any available content-family identity with a test window are purged. Present-day public geometry and novelty references stay fixed, so this is a partial forward-time backtest rather than a historical reconstruction of the entire embedding pipeline.",
        "metrics": regression_metrics(actual_array, predicted_array),
        "calibration": calibration_bins(actual_array, predicted_array),
        "folds": fold_results,
        "points": points,
    }


def visual_keep_metrics(
    rows: list[dict[str, Any]],
    actual: np.ndarray,
    predicted: np.ndarray,
    baseline: np.ndarray,
) -> dict[str, Any]:
    valid = np.isfinite(actual) & np.isfinite(predicted) & np.isfinite(baseline)
    actual = np.asarray(actual[valid], dtype=float)
    predicted = np.asarray(predicted[valid], dtype=float)
    baseline = np.asarray(baseline[valid], dtype=float)
    scoped_rows = [row for row, keep in zip(rows, valid) if keep]
    metrics = regression_metrics(actual, predicted)
    absolute_error = np.abs(actual - predicted)
    baseline_sse = float(np.sum((actual - baseline) ** 2))
    model_sse = float(np.sum((actual - predicted) ** 2))
    actual_range = float(np.ptp(actual)) if len(actual) else None
    predicted_range = float(np.ptp(predicted)) if len(predicted) else None
    metrics.update(
        {
            "actualMin": clean_number(actual.min() if len(actual) else None),
            "actualMax": clean_number(actual.max() if len(actual) else None),
            "predictedMin": clean_number(predicted.min() if len(predicted) else None),
            "predictedMax": clean_number(predicted.max() if len(predicted) else None),
            "actualRange": clean_number(actual_range),
            "predictedRange": clean_number(predicted_range),
            "rangeRatio": clean_number(
                predicted_range / actual_range
                if actual_range and predicted_range is not None
                else None
            ),
            "protocolBaselineR2": clean_number(
                1 - model_sse / baseline_sse if baseline_sse > EPSILON else None
            ),
            "baselineMae": clean_number(float(np.mean(np.abs(actual - baseline)))),
            "baselineRmse": clean_number(float(np.sqrt(np.mean((actual - baseline) ** 2)))),
            "maeImprovementVsBaseline": clean_number(
                float(
                    np.mean(np.abs(actual - baseline))
                    - np.mean(np.abs(actual - predicted))
                )
            ),
            "medianAbsoluteError": clean_number(
                float(np.median(absolute_error)) if len(absolute_error) else None
            ),
            "p90AbsoluteError": clean_number(
                float(np.quantile(absolute_error, 0.9))
                if len(absolute_error)
                else None
            ),
            "within10PercentagePoints": clean_number(
                100 * float(np.mean(absolute_error <= 10))
                if len(absolute_error)
                else None
            ),
        }
    )
    per_account = []
    for account in sorted({str(row["account"]) for row in scoped_rows}, key=stable_hash):
        mask = np.asarray([str(row["account"]) == account for row in scoped_rows])
        account_actual = actual[mask]
        account_predicted = predicted[mask]
        account_baseline = baseline[mask]
        account_absolute_error = np.abs(account_actual - account_predicted)
        account_sse = float(np.sum((account_actual - account_predicted) ** 2))
        account_baseline_sse = float(np.sum((account_actual - account_baseline) ** 2))
        account_metrics = regression_metrics(account_actual, account_predicted)
        account_actual_range = float(np.ptp(account_actual)) if len(account_actual) else None
        account_predicted_range = (
            float(np.ptp(account_predicted)) if len(account_predicted) else None
        )
        account_metrics.update(
            {
                "account": account,
                "name": next(
                    str(row.get("accountName") or account)
                    for row in scoped_rows
                    if str(row["account"]) == account
                ),
                "actualMin": clean_number(
                    account_actual.min() if len(account_actual) else None
                ),
                "actualMax": clean_number(
                    account_actual.max() if len(account_actual) else None
                ),
                "predictedMin": clean_number(
                    account_predicted.min() if len(account_predicted) else None
                ),
                "predictedMax": clean_number(
                    account_predicted.max() if len(account_predicted) else None
                ),
                "actualRange": clean_number(account_actual_range),
                "predictedRange": clean_number(account_predicted_range),
                "rangeRatio": clean_number(
                    account_predicted_range / account_actual_range
                    if account_actual_range and account_predicted_range is not None
                    else None
                ),
                "protocolBaselineR2": clean_number(
                    1 - account_sse / account_baseline_sse
                    if account_baseline_sse > EPSILON
                    else None
                ),
                "baselineMae": clean_number(
                    float(np.mean(np.abs(account_actual - account_baseline)))
                ),
                "baselineRmse": clean_number(
                    float(
                        np.sqrt(
                            np.mean((account_actual - account_baseline) ** 2)
                        )
                    )
                ),
                "maeImprovementVsBaseline": clean_number(
                    float(
                        np.mean(np.abs(account_actual - account_baseline))
                        - np.mean(account_absolute_error)
                    )
                ),
                "medianAbsoluteError": clean_number(
                    float(np.median(account_absolute_error))
                    if len(account_absolute_error)
                    else None
                ),
                "p90AbsoluteError": clean_number(
                    float(np.quantile(account_absolute_error, 0.9))
                    if len(account_absolute_error)
                    else None
                ),
                "within10PercentagePoints": clean_number(
                    100 * float(np.mean(account_absolute_error <= 10))
                    if len(account_absolute_error)
                    else None
                ),
            }
        )
        per_account.append(account_metrics)
    metrics["perAccount"] = per_account
    return metrics


def bound_visual_keep_predictions(values: Any) -> np.ndarray:
    return np.clip(
        np.asarray(values, dtype=float),
        VISUAL_KEEP_OUTPUT_BOUNDS[0],
        VISUAL_KEEP_OUTPUT_BOUNDS[1],
    )


def current_predictor_source_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def validate_visual_keep_candidate(candidate: Any) -> None:
    if not isinstance(candidate, dict):
        raise ValueError("visual keep candidate is missing")
    if candidate.get("estimatorId") != VISUAL_KEEP_POOLED_ESTIMATOR_ID:
        raise ValueError("visual keep candidate is not the registered pooled estimator")
    if not finite(candidate.get("accountWeight")):
        raise ValueError("visual keep account weight is missing")
    if float(candidate["accountWeight"]) != 0:
        raise ValueError("the deployed pooled estimator requires accountWeight=0")
    if not finite(candidate.get("pooledAlpha")):
        raise ValueError("visual keep pooled alpha is missing")
    pooled_alpha = float(candidate["pooledAlpha"])
    if pooled_alpha not in VISUAL_KEEP_POOLED_ALPHAS:
        raise ValueError(
            "visual keep pooled alpha is outside the registered candidate set"
        )


def visual_keep_estimator_descriptor() -> dict[str, Any]:
    return {
        "id": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
        "scope": "pooled_global",
        "accountWeight": 0,
        "outputTransform": VISUAL_KEEP_OUTPUT_TRANSFORM,
        "outputBounds": list(VISUAL_KEEP_OUTPUT_BOUNDS),
    }


def visual_keep_formula_from_model(
    pooled_model: Ridge,
    candidate: dict[str, Any],
) -> dict[str, Any]:
    validate_visual_keep_candidate(candidate)
    return {
        "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
        "scope": "pooled_global",
        "input": (
            "L2-normalized 1,536D visual embedding of the canonical "
            "five-frame opening montage"
        ),
        "outputUnit": "keep-rate percentage points",
        "outputTransform": VISUAL_KEEP_OUTPUT_TRANSFORM,
        "outputBounds": list(VISUAL_KEEP_OUTPUT_BOUNDS),
        "selected": {
            "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
            "pooledAlpha": float(candidate["pooledAlpha"]),
            "accountWeight": 0.0,
        },
        "pooled": {
            "intercept": float(pooled_model.intercept_),
            "coefficients": [
                float(value)
                for value in np.asarray(pooled_model.coef_).reshape(-1)
            ],
        },
        "accountInputs": [],
    }


def validate_visual_keep_formula_identity(formula: Any) -> None:
    if not isinstance(formula, dict):
        raise ValueError("visual keep formula is missing")
    if formula.get("estimatorId") != VISUAL_KEEP_POOLED_ESTIMATOR_ID:
        raise ValueError("visual keep formula estimator is not production pooled Ridge")
    if formula.get("scope") != "pooled_global":
        raise ValueError("visual keep formula scope is not pooled_global")
    if formula.get("accountInputs") != []:
        raise ValueError("visual keep production formula cannot use creator inputs")
    validate_visual_keep_candidate(formula.get("selected"))


def score_visual_keep_formula(
    features: np.ndarray,
    formula: dict[str, Any],
) -> np.ndarray:
    validate_visual_keep_formula_identity(formula)
    bounds = tuple(float(value) for value in formula.get("outputBounds") or ())
    if formula.get("outputTransform") != VISUAL_KEEP_OUTPUT_TRANSFORM:
        raise ValueError("visual keep output transform does not match the registry")
    if bounds != VISUAL_KEEP_OUTPUT_BOUNDS:
        raise ValueError("visual keep output bounds do not match the registry")
    pooled = formula.get("pooled") or {}
    coefficients = np.asarray(pooled.get("coefficients"), dtype=float)
    matrix = np.asarray(features, dtype=float)
    if matrix.ndim == 1:
        matrix = matrix.reshape(1, -1)
    if matrix.shape[1] != len(coefficients):
        raise ValueError("visual keep feature dimensions do not match the formula")
    linear_prediction = float(pooled["intercept"]) + matrix @ coefficients
    return bound_visual_keep_predictions(linear_prediction)


def visual_keep_pooled_candidate_registry() -> list[dict[str, Any]]:
    return [
        {
            "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
            "pooledAlpha": pooled_alpha,
            "accountWeight": 0.0,
        }
        for pooled_alpha in VISUAL_KEEP_POOLED_ALPHAS
    ]


def fit_visual_keep_candidate(
    features: np.ndarray,
    outcomes: np.ndarray,
    accounts: np.ndarray,
    train_indices: np.ndarray,
    test_indices: np.ndarray,
    candidate: dict[str, Any],
    return_models: bool = False,
) -> tuple[np.ndarray, dict[str, Any] | None]:
    validate_visual_keep_candidate(candidate)
    pooled_model = Ridge(
        alpha=float(candidate["pooledAlpha"]),
        solver="lsqr",
        tol=1e-6,
    ).fit(features[train_indices], outcomes[train_indices])
    pooled_prediction = np.asarray(
        pooled_model.predict(features[test_indices]),
        dtype=float,
    )
    prediction = bound_visual_keep_predictions(pooled_prediction)
    if not return_models:
        return prediction, None
    return prediction, {
        "pooled": pooled_model,
        "candidate": candidate,
    }


def visual_keep_oof_predictions(
    rows: list[dict[str, Any]],
    features: np.ndarray,
    outcomes: np.ndarray,
    accounts: np.ndarray,
    folds: np.ndarray,
    candidate: dict[str, Any],
) -> np.ndarray:
    predictions = np.full(len(rows), np.nan, dtype=float)
    for fold in sorted(set(int(value) for value in folds)):
        train_indices = np.flatnonzero(folds != fold)
        test_indices = np.flatnonzero(folds == fold)
        if len(train_indices) < 8 or not len(test_indices):
            continue
        predictions[test_indices], _ = fit_visual_keep_candidate(
            features,
            outcomes,
            accounts,
            train_indices,
            test_indices,
            candidate,
        )
    return predictions


def choose_visual_keep_candidate(
    rows: list[dict[str, Any]],
    features: np.ndarray,
    outcomes: np.ndarray,
    accounts: np.ndarray,
    candidates: list[dict[str, Any]],
    requested_folds: int = 4,
) -> tuple[dict[str, Any], list[dict[str, Any]], np.ndarray]:
    folds = within_group_folds(rows, "account", requested_folds)
    leaderboard = []
    predictions_by_key = {}
    for candidate in candidates:
        predictions = visual_keep_oof_predictions(
            rows,
            features,
            outcomes,
            accounts,
            folds,
            candidate,
        )
        valid = np.isfinite(predictions)
        score = (
            float(np.mean((outcomes[valid] - predictions[valid]) ** 2))
            if valid.any()
            else float("inf")
        )
        key = (
            float(candidate["pooledAlpha"]),
            float(candidate["accountWeight"]),
        )
        predictions_by_key[key] = predictions
        leaderboard.append(
            {
                **candidate,
                "rmse": clean_number(math.sqrt(score) if finite(score) else None),
            }
        )
    leaderboard.sort(
        key=lambda row: (
            float(row["rmse"]) if finite(row.get("rmse")) else float("inf"),
            float(row["pooledAlpha"]),
            float(row["accountWeight"]),
        )
    )
    best = {
        "estimatorId": str(leaderboard[0]["estimatorId"]),
        "pooledAlpha": float(leaderboard[0]["pooledAlpha"]),
        "accountWeight": float(leaderboard[0]["accountWeight"]),
    }
    best_key = (
        best["pooledAlpha"],
        best["accountWeight"],
    )
    return best, leaderboard[:10], predictions_by_key[best_key]


def visual_keep_protocol_points(
    rows: list[dict[str, Any]],
    actual: np.ndarray,
    predicted: np.ndarray,
    baseline: np.ndarray,
    folds: list[str],
) -> list[dict[str, Any]]:
    points = []
    for row, truth, estimate, null, fold in zip(
        rows,
        actual,
        predicted,
        baseline,
        folds,
    ):
        if not (finite(truth) and finite(estimate) and finite(null)):
            continue
        points.append(
            {
                "id": row["id"],
                "title": row["title"],
                "account": row["account"],
                "accountName": row["accountName"],
                "publishedAt": clean_number(row.get("publishedAt"), 0),
                "actual": clean_number(truth),
                "predicted": clean_number(estimate),
                "baseline": clean_number(null),
                "error": clean_number(float(estimate) - float(truth)),
                "fold": str(fold),
            }
        )
    return points


def assert_visual_keep_protocol_formula_parity(
    rows: list[dict[str, Any]],
    features: np.ndarray,
    protocol: dict[str, Any],
) -> None:
    estimator = protocol.get("estimator") or {}
    if (
        estimator.get("id") != VISUAL_KEEP_POOLED_ESTIMATOR_ID
        or estimator.get("scope") != "pooled_global"
        or float(estimator.get("accountWeight", 0)) != 0
    ):
        raise RuntimeError(
            "visual keep protocol does not evaluate the production pooled Ridge"
        )
    formulas = {}
    for fold in protocol.get("folds") or []:
        fold_key = str(fold.get("foldKey") or "")
        if not fold_key or fold_key in formulas:
            raise RuntimeError("visual keep protocol fold formula key is invalid")
        formula = fold.get("formula")
        validate_visual_keep_formula_identity(formula)
        selected = fold.get("selected")
        validate_visual_keep_candidate(selected)
        if stable_json_sha256(formula.get("selected")) != stable_json_sha256(
            {
                "estimatorId": selected["estimatorId"],
                "pooledAlpha": float(selected["pooledAlpha"]),
                "accountWeight": 0.0,
            }
        ):
            raise RuntimeError(
                "visual keep fold formula and selected candidate disagree"
            )
        formulas[fold_key] = formula
    feature_by_id = {
        str(row["id"]): np.asarray(feature, dtype=float)
        for row, feature in zip(rows, features)
    }
    for point in protocol.get("points") or []:
        formula = formulas.get(str(point.get("fold") or ""))
        feature = feature_by_id.get(str(point.get("id") or ""))
        if formula is None or feature is None:
            raise RuntimeError(
                "visual keep OOF point is not bound to its fold formula and feature"
            )
        replayed = clean_number(
            float(score_visual_keep_formula(feature, formula)[0])
        )
        if replayed != point.get("predicted"):
            raise RuntimeError(
                "visual keep OOF point does not exactly replay through "
                "score_visual_keep_formula "
                f"(id={point.get('id')}, fold={point.get('fold')}, "
                f"reported={point.get('predicted')}, replayed={replayed})"
            )


def run_visual_keep_video_holdout(
    rows: list[dict[str, Any]],
    features: np.ndarray,
    outcomes: np.ndarray,
    accounts: np.ndarray,
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    outer_folds = within_group_folds(rows, "account", 5)
    predictions = np.full(len(rows), np.nan, dtype=float)
    baselines = np.full(len(rows), np.nan, dtype=float)
    fold_labels = [""] * len(rows)
    fold_results = []
    for fold in sorted(set(int(value) for value in outer_folds)):
        train_indices = np.flatnonzero(outer_folds != fold)
        test_indices = np.flatnonzero(outer_folds == fold)
        train_rows = [rows[index] for index in train_indices]
        best, leaderboard, inner_prediction = choose_visual_keep_candidate(
            train_rows,
            features[train_indices],
            outcomes[train_indices],
            accounts[train_indices],
            candidates,
            requested_folds=4,
        )
        predictions[test_indices], fold_models = fit_visual_keep_candidate(
            features,
            outcomes,
            accounts,
            train_indices,
            test_indices,
            best,
            return_models=True,
        )
        fold_formula = visual_keep_formula_from_model(
            fold_models["pooled"],
            best,
        )
        predictions[test_indices] = score_visual_keep_formula(
            features[test_indices],
            fold_formula,
        )
        training_means = {
            account: float(np.mean(outcomes[train_indices][accounts[train_indices] == account]))
            for account in set(accounts[train_indices])
        }
        global_mean = float(np.mean(outcomes[train_indices]))
        baselines[test_indices] = [
            training_means.get(account, global_mean)
            for account in accounts[test_indices]
        ]
        residuals = outcomes[train_indices] - inner_prediction
        fold_results.append(
            {
                "fold": int(fold) + 1,
                "foldKey": str(int(fold) + 1),
                "trainN": len(train_indices),
                "testN": len(test_indices),
                "selected": best,
                "formula": fold_formula,
                "candidateLeaderboard": leaderboard,
                "innerResidualP10": clean_number(quantile(residuals, 0.1)),
                "innerResidualP90": clean_number(quantile(residuals, 0.9)),
            }
        )
        for index in test_indices:
            fold_labels[index] = str(int(fold) + 1)
    metrics = visual_keep_metrics(rows, outcomes, predictions, baselines)
    full_best, final_leaderboard, _ = choose_visual_keep_candidate(
        rows,
        features,
        outcomes,
        accounts,
        candidates,
        requested_folds=5,
    )
    _, final_models = fit_visual_keep_candidate(
        features,
        outcomes,
        accounts,
        np.arange(len(rows)),
        np.arange(len(rows)),
        full_best,
        return_models=True,
    )
    formula = visual_keep_formula_from_model(final_models["pooled"], full_best)
    protocol = {
        "key": "known_account_video_holdout",
        "label": "Pooled global · balanced video holdout",
        "claim": "Retrospective evaluation of the exact pooled-global estimator class deployed at score time.",
        "description": "Each test video is excluded. The pooled Ridge strength is selected again inside four inner folds. Creator identity and creator-specific coefficients are never inputs; accountWeight is fixed to zero in every inner and outer fold.",
        "estimator": visual_keep_estimator_descriptor(),
        "metrics": metrics,
        "folds": fold_results,
        "points": visual_keep_protocol_points(
            rows,
            outcomes,
            predictions,
            baselines,
            fold_labels,
        ),
        "candidateRegistry": {
            "count": len(candidates),
            "selectionMetric": "inner-fold RMSE",
            "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
            "accountWeight": 0,
            "pooledAlphas": list(VISUAL_KEEP_POOLED_ALPHAS),
            "topFinalCandidates": final_leaderboard,
        },
    }
    assert_visual_keep_protocol_formula_parity(rows, features, protocol)
    protocol["exactFormulaReplayVerified"] = True
    return protocol, formula


def visual_time_windows(
    rows: list[dict[str, Any]],
) -> list[tuple[str, np.ndarray, np.ndarray, str]]:
    accounts = np.asarray([str(row["account"]) for row in rows])
    published = np.asarray(
        [
            float(row["publishedAt"])
            if finite(row.get("publishedAt"))
            else np.nan
            for row in rows
        ],
        dtype=float,
    )
    windows = []
    for account in sorted(set(accounts), key=stable_hash):
        account_indices = np.flatnonzero(
            (accounts == account) & np.isfinite(published)
        )
        account_indices = account_indices[np.argsort(published[account_indices])]
        start = max(8, len(account_indices) // 2)
        boundaries = sorted(
            set(
                int(value)
                for value in np.linspace(start, len(account_indices), 5)
            )
        )
        for left, right in zip(boundaries[:-1], boundaries[1:]):
            test_indices = account_indices[left:right]
            if not len(test_indices):
                continue
            cutoff = float(np.min(published[test_indices]))
            train_indices = account_indices[published[account_indices] < cutoff]
            if len(train_indices) < 8:
                continue
            windows.append(
                (
                    account,
                    train_indices,
                    test_indices,
                    f"{account}:{left}-{right}",
                )
            )
    return windows


def predict_visual_time_candidate(
    features: np.ndarray,
    outcomes: np.ndarray,
    train_indices: np.ndarray,
    test_indices: np.ndarray,
    candidate: dict[str, Any],
) -> np.ndarray:
    recent_n = min(int(candidate["recentN"]), len(train_indices))
    recent_indices = train_indices[-recent_n:]
    if candidate["kind"] == "mean":
        return bound_visual_keep_predictions(
            np.repeat(
                float(np.mean(outcomes[recent_indices])),
                len(test_indices),
            )
        )
    model = Ridge(
        alpha=float(candidate["alpha"]),
        solver="lsqr",
        tol=1e-6,
    ).fit(features[recent_indices], outcomes[recent_indices])
    return bound_visual_keep_predictions(model.predict(features[test_indices]))


def choose_visual_time_candidate(
    rows: list[dict[str, Any]],
    features: np.ndarray,
    outcomes: np.ndarray,
    train_indices: np.ndarray,
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    train_indices = np.asarray(train_indices, dtype=int)
    start = max(8, len(train_indices) // 2)
    boundaries = sorted(
        set(int(value) for value in np.linspace(start, len(train_indices), 4))
    )
    leaderboard = []
    for candidate in candidates:
        actual = []
        predicted = []
        for left, right in zip(boundaries[:-1], boundaries[1:]):
            inner_train = train_indices[:left]
            inner_test = train_indices[left:right]
            inner_train, _ = purge_content_family_overlap(
                rows,
                inner_train,
                inner_test,
            )
            if len(inner_train) < 8 or not len(inner_test):
                continue
            estimate = predict_visual_time_candidate(
                features,
                outcomes,
                inner_train,
                inner_test,
                candidate,
            )
            actual.extend(outcomes[inner_test].tolist())
            predicted.extend(estimate.tolist())
        rmse = (
            float(np.sqrt(np.mean((np.asarray(actual) - np.asarray(predicted)) ** 2)))
            if actual
            else float("inf")
        )
        leaderboard.append({**candidate, "rmse": clean_number(rmse)})
    leaderboard.sort(
        key=lambda row: (
            float(row["rmse"]) if finite(row.get("rmse")) else float("inf"),
            str(row["kind"]),
            int(row["recentN"]),
            float(row.get("alpha") or 0),
        )
    )
    return {
        key: value
        for key, value in leaderboard[0].items()
        if key != "rmse"
    }, leaderboard[:10]


def choose_visual_keep_forward_candidate(
    rows: list[dict[str, Any]],
    features: np.ndarray,
    outcomes: np.ndarray,
    accounts: np.ndarray,
    train_indices: np.ndarray,
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    accounts = np.asarray(accounts)
    published = np.asarray(
        [
            float(row["publishedAt"])
            if finite(row.get("publishedAt"))
            else np.nan
            for row in rows
        ],
        dtype=float,
    )
    ordered = np.asarray(
        sorted(
            (
                int(index)
                for index in train_indices
                if np.isfinite(published[index])
            ),
            key=lambda index: (
                published[index],
                stable_hash(str(rows[index]["id"])),
            ),
        ),
        dtype=int,
    )
    start = max(8, len(ordered) // 2)
    boundaries = sorted(
        set(int(value) for value in np.linspace(start, len(ordered), 4))
    )
    leaderboard = []
    for candidate in candidates:
        validate_visual_keep_candidate(candidate)
        actual = []
        predicted = []
        for left, right in zip(boundaries[:-1], boundaries[1:]):
            inner_test = ordered[left:right]
            if not len(inner_test):
                continue
            inner_cutoff = float(np.min(published[inner_test]))
            inner_train = ordered[published[ordered] < inner_cutoff]
            inner_train, _ = purge_content_family_overlap(
                rows,
                inner_train,
                inner_test,
            )
            if len(inner_train) < 8:
                continue
            estimate, _ = fit_visual_keep_candidate(
                features,
                outcomes,
                accounts,
                inner_train,
                inner_test,
                candidate,
            )
            actual.extend(outcomes[inner_test].tolist())
            predicted.extend(estimate.tolist())
        rmse = (
            float(
                np.sqrt(
                    np.mean(
                        (np.asarray(actual) - np.asarray(predicted)) ** 2
                    )
                )
            )
            if actual
            else float("inf")
        )
        leaderboard.append({**candidate, "rmse": clean_number(rmse)})
    leaderboard.sort(
        key=lambda row: (
            float(row["rmse"])
            if finite(row.get("rmse"))
            else float("inf"),
            float(row["pooledAlpha"]),
        )
    )
    selected = {
        "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
        "pooledAlpha": float(leaderboard[0]["pooledAlpha"]),
        "accountWeight": 0.0,
    }
    return selected, leaderboard


def run_visual_keep_forward_time(
    rows: list[dict[str, Any]],
    features: np.ndarray,
    outcomes: np.ndarray,
    accounts: np.ndarray,
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    production_candidates = (
        candidates
        if candidates is not None
        else visual_keep_pooled_candidate_registry()
    )
    for candidate in production_candidates:
        validate_visual_keep_candidate(candidate)
    diagnostic_candidates = [
        {"kind": "mean", "recentN": recent_n}
        for recent_n in (10, 20, 40, 80)
    ] + [
        {"kind": "ridge", "recentN": recent_n, "alpha": alpha}
        for recent_n in (20, 40, 80, 160)
        for alpha in (0.1, 1.0, 10.0)
    ]
    predictions = np.full(len(rows), np.nan, dtype=float)
    baselines = np.full(len(rows), np.nan, dtype=float)
    fold_labels = [""] * len(rows)
    windows = []
    published = np.asarray(
        [
            float(row["publishedAt"])
            if finite(row.get("publishedAt"))
            else np.nan
            for row in rows
        ],
        dtype=float,
    )
    for account, train_indices, test_indices, label in visual_time_windows(rows):
        del train_indices
        cutoff = float(np.min(published[test_indices]))
        train_indices = np.flatnonzero(
            np.isfinite(published) & (published < cutoff)
        )
        train_indices, family_purge = purge_content_family_overlap(
            rows,
            train_indices,
            test_indices,
        )
        if len(train_indices) < 8:
            continue
        best, leaderboard = choose_visual_keep_forward_candidate(
            rows,
            features,
            outcomes,
            accounts,
            train_indices,
            production_candidates,
        )
        predictions[test_indices], fold_models = fit_visual_keep_candidate(
            features,
            outcomes,
            accounts,
            train_indices,
            test_indices,
            best,
            return_models=True,
        )
        fold_formula = visual_keep_formula_from_model(
            fold_models["pooled"],
            best,
        )
        predictions[test_indices] = score_visual_keep_formula(
            features[test_indices],
            fold_formula,
        )
        global_mean = float(np.mean(outcomes[train_indices]))
        for index in test_indices:
            same_account = train_indices[accounts[train_indices] == accounts[index]]
            same_account = same_account[
                np.argsort(published[same_account], kind="stable")
            ]
            recent_baseline = same_account[-min(20, len(same_account)) :]
            baselines[index] = (
                float(np.mean(outcomes[recent_baseline]))
                if len(recent_baseline)
                else global_mean
            )
        for index in test_indices:
            fold_labels[index] = label
        _, diagnostic_leaderboard = choose_visual_time_candidate(
            rows,
            features,
            outcomes,
            np.asarray(
                sorted(
                    train_indices,
                    key=lambda index: (
                        published[index],
                        stable_hash(str(rows[index]["id"])),
                    ),
                ),
                dtype=int,
            ),
            diagnostic_candidates,
        )
        windows.append(
            {
                "window": label,
                "foldKey": label,
                "account": account,
                "trainN": len(train_indices),
                "testN": len(test_indices),
                "contentFamilyPurge": family_purge,
                "selected": best,
                "formula": fold_formula,
                "candidateLeaderboard": leaderboard,
                "nonPromotableDiagnosticLeaderboard":
                    diagnostic_leaderboard,
                "trainingCutoff": clean_number(
                    max(
                        float(rows[index]["publishedAt"])
                        for index in train_indices
                    ),
                    0,
                ),
                "testStart": clean_number(
                    min(
                        float(rows[index]["publishedAt"])
                        for index in test_indices
                    ),
                    0,
                ),
            }
        )
    metrics = visual_keep_metrics(
        rows,
        outcomes,
        predictions,
        baselines,
    )
    valid = (
        np.isfinite(outcomes)
        & np.isfinite(predictions)
        & np.isfinite(baselines)
    )
    baseline_metrics = regression_metrics(
        outcomes[valid],
        baselines[valid],
    )
    protocol = {
        "key": "forward_time",
        "label": "Future upload simulation",
        "claim": (
            "Retrospective forward-time simulation of the exact pooled-global "
            "Ridge estimator class deployed at score time."
        ),
        "description": (
            "For every test window, the pooled Ridge and its alpha are fit or "
            "selected only from rows published earlier than that window across "
            "all creators. Creator identity and creator-specific coefficients "
            "never enter the production estimator. A creator trailing-20 mean "
            "is retained as a non-promotable null/diagnostic only. Present-day "
            "embeddings are reused, so this remains a retrospective partial "
            "replay rather than prospective confirmation."
        ),
        "estimator": visual_keep_estimator_descriptor(),
        "outputTransform": VISUAL_KEEP_OUTPUT_TRANSFORM,
        "outputBounds": list(VISUAL_KEEP_OUTPUT_BOUNDS),
        "metrics": metrics,
        "folds": windows,
        "points": visual_keep_protocol_points(
            rows,
            outcomes,
            predictions,
            baselines,
            fold_labels,
        ),
        "candidateRegistry": {
            "count": len(production_candidates),
            "selectionMetric": "earlier-window RMSE",
            "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
            "accountWeight": 0,
            "pooledAlphas": list(VISUAL_KEEP_POOLED_ALPHAS),
        },
        "diagnostics": {
            "trailingAccountMean": {
                "promotionEligible": False,
                "role": "null_and_diagnostic_only",
                "metrics": baseline_metrics,
                "beatsProductionByRmse": bool(
                    finite(baseline_metrics.get("rmse"))
                    and finite(metrics.get("rmse"))
                    and baseline_metrics["rmse"] < metrics["rmse"]
                ),
            },
            "candidateFamilies": {
                "promotionEligible": False,
                "description": (
                    "Recent-window means and alternative recent-window Ridge "
                    "models may describe drift, but cannot validate or promote "
                    "the pooled production Ridge."
                ),
            },
        },
    }
    assert_visual_keep_protocol_formula_parity(rows, features, protocol)
    protocol["exactFormulaReplayVerified"] = True
    return protocol


def run_visual_keep_account_holdout(
    rows: list[dict[str, Any]],
    features: np.ndarray,
    outcomes: np.ndarray,
    accounts: np.ndarray,
) -> dict[str, Any]:
    candidates = visual_keep_pooled_candidate_registry()
    predictions = np.full(len(rows), np.nan, dtype=float)
    baselines = np.full(len(rows), np.nan, dtype=float)
    fold_labels = [""] * len(rows)
    folds = []
    for held_account in sorted(set(accounts), key=stable_hash):
        test_indices = np.flatnonzero(accounts == held_account)
        train_indices, family_purge = purge_content_family_overlap(
            rows,
            np.flatnonzero(accounts != held_account),
            test_indices,
        )
        if len(train_indices) < 8:
            continue
        leaderboard = []
        for candidate in candidates:
            validate_visual_keep_candidate(candidate)
            alpha = float(candidate["pooledAlpha"])
            inner_predictions = np.full(len(train_indices), np.nan, dtype=float)
            training_accounts = accounts[train_indices]
            for inner_account in sorted(set(training_accounts), key=stable_hash):
                inner_train_positions = np.flatnonzero(
                    training_accounts != inner_account
                )
                inner_test_positions = np.flatnonzero(
                    training_accounts == inner_account
                )
                inner_train_indices, _ = purge_content_family_overlap(
                    rows,
                    train_indices[inner_train_positions],
                    train_indices[inner_test_positions],
                )
                if (
                    len(inner_train_indices) < 8
                    or not len(inner_test_positions)
                ):
                    continue
                model = Ridge(
                    alpha=alpha,
                    solver="lsqr",
                    tol=1e-6,
                ).fit(
                    features[inner_train_indices],
                    outcomes[inner_train_indices],
                )
                inner_predictions[inner_test_positions] = (
                    bound_visual_keep_predictions(
                        model.predict(
                            features[train_indices[inner_test_positions]]
                        )
                    )
                )
            valid_inner = np.isfinite(inner_predictions)
            leaderboard.append(
                {
                    "alpha": alpha,
                    "rmse": clean_number(
                        float(
                            np.sqrt(
                                np.mean(
                                    (
                                        outcomes[train_indices][valid_inner]
                                        - inner_predictions[valid_inner]
                                    )
                                    ** 2
                                )
                            )
                        )
                    ) if valid_inner.any() else None,
                }
            )
        leaderboard.sort(key=lambda row: (
            float(row["rmse"])
            if finite(row.get("rmse"))
            else float("inf"),
            row["alpha"],
        ))
        if not finite(leaderboard[0].get("rmse")):
            continue
        best_alpha = float(leaderboard[0]["alpha"])
        selected = {
            "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
            "pooledAlpha": best_alpha,
            "accountWeight": 0.0,
        }
        predictions[test_indices], fold_models = fit_visual_keep_candidate(
            features,
            outcomes,
            accounts,
            train_indices,
            test_indices,
            selected,
            return_models=True,
        )
        fold_formula = visual_keep_formula_from_model(
            fold_models["pooled"],
            selected,
        )
        predictions[test_indices] = score_visual_keep_formula(
            features[test_indices],
            fold_formula,
        )
        baselines[test_indices] = float(np.mean(outcomes[train_indices]))
        for index in test_indices:
            fold_labels[index] = str(held_account)
        folds.append(
            {
                "heldOutAccount": str(held_account),
                "foldKey": str(held_account),
                "heldOutName": rows[test_indices[0]]["accountName"],
                "trainN": len(train_indices),
                "testN": len(test_indices),
                "contentFamilyPurge": family_purge,
                "selectedAlpha": best_alpha,
                "selected": selected,
                "formula": fold_formula,
                "candidateLeaderboard": leaderboard,
            }
        )
    protocol = {
        "key": "unseen_account",
        "label": "Entire creator held out",
        "claim": "Cold-start transfer to a creator whose keep-rate labels never fit the model.",
        "description": "The held-out creator is absent from representation fitting, model selection, calibration, and baseline estimation. Any training row sharing a content-family ID with the held-out creator is purged. Alpha is selected by leaving each remaining training creator out in turn with the same family purge.",
        "estimator": visual_keep_estimator_descriptor(),
        "outputTransform": VISUAL_KEEP_OUTPUT_TRANSFORM,
        "outputBounds": list(VISUAL_KEEP_OUTPUT_BOUNDS),
        "metrics": visual_keep_metrics(
            rows,
            outcomes,
            predictions,
            baselines,
        ),
        "folds": folds,
        "points": visual_keep_protocol_points(
            rows,
            outcomes,
            predictions,
            baselines,
            fold_labels,
        ),
        "candidateRegistry": {
            "count": len(candidates),
            "selectionMetric": "inner leave-creator-out RMSE",
            "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
            "accountWeight": 0,
            "pooledAlphas": list(VISUAL_KEEP_POOLED_ALPHAS),
        },
    }
    assert_visual_keep_protocol_formula_parity(rows, features, protocol)
    protocol["exactFormulaReplayVerified"] = True
    return protocol


def visual_keep_protocol_uses_production_estimator(
    protocol: Any,
    require_replay_evidence: bool = False,
) -> bool:
    if not isinstance(protocol, dict):
        return False
    estimator = protocol.get("estimator") or {}
    if (
        estimator.get("id") != VISUAL_KEEP_POOLED_ESTIMATOR_ID
        or estimator.get("scope") != "pooled_global"
        or float(estimator.get("accountWeight", 0)) != 0
    ):
        return False
    if require_replay_evidence and protocol.get(
        "exactFormulaReplayVerified"
    ) is not True:
        return False
    for fold in protocol.get("folds") or []:
        try:
            validate_visual_keep_candidate(fold.get("selected"))
            validate_visual_keep_formula_identity(fold.get("formula"))
        except (TypeError, ValueError):
            return False
    for selected in protocol.get("selectedCandidates") or []:
        try:
            validate_visual_keep_candidate(selected)
        except (TypeError, ValueError):
            return False
    registry = protocol.get("candidateRegistry") or {}
    if registry.get("estimatorId") != VISUAL_KEEP_POOLED_ESTIMATOR_ID:
        return False
    if not finite(registry.get("accountWeight")):
        return False
    if float(registry["accountWeight"]) != 0:
        return False
    if registry.get("count") != len(VISUAL_KEEP_POOLED_ALPHAS):
        return False
    if registry.get("pooledAlphas") != list(VISUAL_KEEP_POOLED_ALPHAS):
        return False
    return True


def visual_keep_promotion_decision(
    forward_time: dict[str, Any],
    account_holdout: dict[str, Any],
) -> bool:
    if not visual_keep_protocol_uses_production_estimator(
        forward_time,
        require_replay_evidence=True,
    ):
        return False
    if not visual_keep_protocol_uses_production_estimator(
        account_holdout,
        require_replay_evidence=True,
    ):
        return False
    forward_skill = (forward_time.get("metrics") or {}).get(
        "protocolBaselineR2"
    )
    account_skill = (account_holdout.get("metrics") or {}).get(
        "protocolBaselineR2"
    )
    return bool(
        finite(forward_skill)
        and finite(account_skill)
        and forward_skill > 0
        and account_skill > 0
    )


def visual_keep_artifact_study(
    artifact: Any,
) -> tuple[dict[str, Any], str | None]:
    if not isinstance(artifact, dict):
        return {}, None
    producer_sha256 = artifact.get("producerSourceSha256")
    if not producer_sha256:
        producer_sha256 = (artifact.get("provenance") or {}).get(
            "producerSourceSha256"
        )
    study = artifact
    targets = artifact.get("targets") or {}
    if isinstance(targets, dict):
        keep = targets.get("keep") or {}
        if isinstance(keep, dict) and isinstance(
            keep.get("visualOnlyStudy"),
            dict,
        ):
            study = keep["visualOnlyStudy"]
    if isinstance(artifact.get("visualOnlyStudy"), dict):
        study = artifact["visualOnlyStudy"]
    return study, str(producer_sha256 or "") or None


def visual_keep_artifact_status(artifact: Any) -> dict[str, Any]:
    study, producer_sha256 = visual_keep_artifact_study(artifact)
    blockers = []
    expected_source_sha256 = current_predictor_source_sha256()
    if producer_sha256 != expected_source_sha256:
        blockers.append(
            "producerSourceSha256 does not match the current predictor source"
        )
    try:
        validate_visual_keep_formula_identity(study.get("formula"))
    except (AttributeError, TypeError, ValueError) as error:
        blockers.append(str(error))
    protocols = (
        (
            study.get("protocols")
            or study.get("validationSummary")
        )
        if isinstance(study, dict)
        else None
    )
    if not isinstance(protocols, dict):
        blockers.append("visual keep validation protocols are missing")
        protocols = {}
    for key in ("videoHoldout", "forwardTime", "accountHoldout"):
        protocol = protocols.get(key)
        if not visual_keep_protocol_uses_production_estimator(
            protocol,
            require_replay_evidence=True,
        ):
            blockers.append(
                f"{key} does not contain exact pooled-Ridge replay evidence"
            )
    return {
        "state": "current" if not blockers else "stale",
        "current": not blockers,
        "validationEligible": not blockers,
        "coordinateId": VISUAL_KEEP_COORDINATE_ID,
        "estimatorId": VISUAL_KEEP_POOLED_ESTIMATOR_ID,
        "producerSourceSha256": producer_sha256,
        "expectedProducerSourceSha256": expected_source_sha256,
        "blockers": blockers,
    }


def require_current_visual_keep_artifact(artifact: Any) -> dict[str, Any]:
    status = visual_keep_artifact_status(artifact)
    if not status["current"]:
        raise RuntimeError(
            "stale visual keep validation artifact: "
            + "; ".join(status["blockers"])
        )
    return status


def load_current_visual_keep_artifact(path: Path) -> dict[str, Any]:
    artifact = json.loads(Path(path).read_text(encoding="utf-8"))
    status = visual_keep_artifact_status(artifact)
    return {
        "status": status,
        "artifact": artifact if status["current"] else None,
    }


def run_visual_keep_study(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    visual_store = stores["visual"]
    eligible = [
        row
        for row in rows
        if row["id"] in visual_store["index"] and finite(row.get("keep"))
    ]
    features = np.asarray(
        [
            visual_store["vectors"][visual_store["index"][row["id"]]]
            for row in eligible
        ],
        dtype=float,
    )
    outcomes = np.asarray([row["keep"] for row in eligible], dtype=float)
    accounts = np.asarray([str(row["account"]) for row in eligible])
    candidates = visual_keep_pooled_candidate_registry()
    video_holdout, formula = run_visual_keep_video_holdout(
        eligible,
        features,
        outcomes,
        accounts,
        candidates,
    )
    forward_time = run_visual_keep_forward_time(
        eligible,
        features,
        outcomes,
        accounts,
    )
    account_holdout = run_visual_keep_account_holdout(
        eligible,
        features,
        outcomes,
        accounts,
    )
    retrospective_threshold_passed = visual_keep_promotion_decision(
        forward_time,
        account_holdout,
    )
    production_points = []
    for row, feature in zip(eligible, features):
        account = str(row["account"])
        pooled_prediction = float(
            score_visual_keep_formula(feature, formula)[0]
        )
        production_points.append(
            {
                "id": row["id"],
                "title": row["title"],
                "account": account,
                "accountName": row["accountName"],
                "publishedAt": clean_number(row.get("publishedAt"), 0),
                "predicted": clean_number(pooled_prediction),
                "pooledPrediction": clean_number(pooled_prediction),
                "calibrationScope": "pooled_global",
            }
        )
    training_ids = sorted(str(row["id"]) for row in eligible)
    training_ids_by_account: dict[str, list[str]] = defaultdict(list)
    for row in eligible:
        training_ids_by_account[str(row["account"])].append(str(row["id"]))
    fit_population_by_account = {
        account: {
            "rowCount": len(account_ids),
            "videoIdSha256": hashlib.sha256(
                "\n".join(sorted(account_ids)).encode()
            ).hexdigest(),
        }
        for account, account_ids in sorted(training_ids_by_account.items())
    }
    return {
        "schemaVersion": 2,
        "label": "Visual-only keep-rate predictor",
        "coordinateId": VISUAL_KEEP_COORDINATE_ID,
        "input": "Only the canonical visual opening montage embedding; no title, transcript, views, duration, or audience outcome enters the predictor.",
        "population": {
            "n": len(eligible),
            "accounts": [
                {
                    "id": account,
                    "name": next(
                        row["accountName"]
                        for row in eligible
                        if row["account"] == account
                    ),
                    "n": int(np.sum(accounts == account)),
                }
                for account in sorted(set(accounts), key=stable_hash)
            ],
            "embeddingModel": "gemini-embedding-2",
            "embeddingDimensions": int(features.shape[1]),
        },
        "protocols": {
            "videoHoldout": video_holdout,
            "forwardTime": forward_time,
            "accountHoldout": account_holdout,
        },
        "formula": formula,
        "production": {
            "coordinateId": VISUAL_KEEP_COORDINATE_ID,
            "valueDefinition": "Raw keep-rate percentage predicted by one frozen pooled visual-only model. Creator identity is not an input, so identical visual embeddings receive identical values in every scoring route.",
            "evaluationWarning": "These final-model values are in-sample diagnostics on the fitting population. The separate protocol predictions are the leakage-controlled evidence and must not be substituted for this raw coordinate.",
            "fitPopulation": {
                "n": len(training_ids),
                "videoIdSha256": hashlib.sha256(
                    "\n".join(training_ids).encode()
                ).hexdigest(),
                "byAccount": fit_population_by_account,
            },
            "points": production_points,
        },
        "promotion": {
            "promoted": False,
            "predictorEligible": False,
            "retrospectiveMetricThresholdPassed":
                retrospective_threshold_passed,
            "status": (
                "retrospective_candidate_for_prospective_test"
                if retrospective_threshold_passed
                else "research_only_not_validated_for_pre_upload_decisions"
            ),
            "rule": (
                "The retrospective candidate threshold requires positive "
                "error reduction versus each "
                "protocol's legitimate null in both forward-time and "
                "whole-creator holdouts, and both protocols must execute the "
                "same pooled-global Ridge class used by serving. Diagnostic "
                "means or creator-local models cannot satisfy that threshold. "
                "Actual promotion additionally requires a preregistered "
                "prospective test and every leakage gate."
            ),
            "plainEnglish": (
                "The visual representation beat both retrospective forward-time and unseen-creator baselines. It is a candidate for a preregistered prospective test, not a promoted predictor."
                if retrospective_threshold_passed
                else "The random video split finds retrospective structure, but that is not enough. Until future uploads and entirely unseen creators both beat their honest baselines, this score remains a diagnostic rather than a dependable pre-upload forecast."
            ),
        },
        "validationNotes": [
            "R-squared is reported together with MAE, rank correlation, predicted range, observed range, and range ratio.",
            "A narrow prediction range is not expanded by force. Quantile stretching was rejected because it worsened held-out error.",
            "Creator-held-out and forward-time results take precedence over random video holdout when judging production use.",
            "Only four independent creators currently have private keep labels. More videos from the same creator cannot replace more independent creators for universal-transfer evidence.",
        ],
    }


def creator_adaptive_point_metrics(
    points: list[dict[str, Any]],
) -> dict[str, Any]:
    if not points:
        return {}
    metric_rows = [
        {
            "account": point["account"],
            "accountName": point["accountName"],
        }
        for point in points
    ]
    return visual_keep_metrics(
        metric_rows,
        np.asarray([point["actual"] for point in points], dtype=float),
        np.asarray([point["predicted"] for point in points], dtype=float),
        np.asarray([point["baseline"] for point in points], dtype=float),
    )


def creator_adaptive_bootstrap_interval(
    absolute_errors: np.ndarray,
    seed_key: str,
    repetitions: int = 5_000,
) -> dict[str, Any]:
    errors = np.asarray(absolute_errors, dtype=float)
    if not len(errors):
        return {"lower": None, "upper": None, "confidence": 0.9}
    seed = stable_hash(seed_key) % (2**32)
    rng = np.random.default_rng(seed)
    block_length = max(1, min(len(errors), int(round(math.sqrt(len(errors))))))
    sampled_means = []
    for _ in range(repetitions):
        sample = []
        while len(sample) < len(errors):
            start = int(rng.integers(0, len(errors)))
            sample.extend(
                errors[
                    np.mod(
                        np.arange(start, start + block_length),
                        len(errors),
                    )
                ].tolist()
            )
        sampled_means.append(float(np.mean(sample[: len(errors)])))
    sampled = np.asarray(sampled_means, dtype=float)
    return {
        "lower": clean_number(np.quantile(sampled, 0.05)),
        "upper": clean_number(np.quantile(sampled, 0.95)),
        "confidence": 0.9,
        "repetitions": repetitions,
        "seed": int(seed),
        "blockLength": block_length,
        "method": "Circular moving-block bootstrap of chronological absolute errors",
        "claimBoundary": "Descriptive uncertainty for this historical error sequence only. The moving blocks preserve short-run dependence, but candidate selection, full model refitting, and future distribution shift are not resampled.",
    }


def creator_adaptive_benchmark_fingerprints(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    ordered = sorted(
        rows,
        key=lambda row: (
            str(row["account"]),
            float(row["publishedAt"]),
            stable_hash(str(row["id"])),
        ),
    )
    visual = np.asarray(
        [
            stores["visual"]["vectors"][
                stores["visual"]["index"][row["id"]]
            ]
            for row in ordered
        ],
        dtype="<f8",
    )
    together = np.asarray(
        [
            stores["together"]["vectors"][
                stores["together"]["index"][row["id"]]
            ]
            for row in ordered
        ],
        dtype="<f8",
    )
    row_manifest = [
        {
            "id": str(row["id"]),
            "account": str(row["account"]),
            "accountName": str(row["accountName"]),
            "keep": float(row["keep"]),
            "publishedAt": float(row["publishedAt"]),
            "title": str(row["title"]),
        }
        for row in ordered
    ]
    canonical_manifest = json.dumps(
        row_manifest,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    row_hash = hashlib.sha256(canonical_manifest).hexdigest()
    visual_hash = hashlib.sha256(
        visual.tobytes(order="C")
    ).hexdigest()
    together_hash = hashlib.sha256(
        together.tobytes(order="C")
    ).hexdigest()
    combined = hashlib.sha256()
    combined.update(bytes.fromhex(row_hash))
    combined.update(bytes.fromhex(visual_hash))
    combined.update(bytes.fromhex(together_hash))
    return ordered, {
        "rowManifestSha256": row_hash,
        "visualMatrixSha256": visual_hash,
        "togetherMatrixSha256": together_hash,
        "combinedSha256": combined.hexdigest(),
        "visualShape": list(visual.shape),
        "togetherShape": list(together.shape),
    }


def load_creator_adaptive_benchmark(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    if not CAUSAL_KEEP_MIXTURE_BENCHMARK.exists():
        raise RuntimeError(
            "The prequential keep benchmark is missing. Run "
            "scripts/benchmark-causal-keep-mixture.py first."
        )
    benchmark_bytes = CAUSAL_KEEP_MIXTURE_BENCHMARK.read_bytes()
    benchmark = json.loads(benchmark_bytes)
    ordered, fingerprints = creator_adaptive_benchmark_fingerprints(
        rows,
        stores,
    )
    registered = CREATOR_ADAPTIVE_KEEP_V1_SPEC
    registry = benchmark.get("candidateRegistry") or {}
    dataset = benchmark.get("dataset") or {}
    coordinate = benchmark.get("coordinate") or {}
    benchmark_sha256 = hashlib.sha256(benchmark_bytes).hexdigest()
    if (
        benchmark.get("schemaVersion") != 1
        or benchmark.get("benchmarkId") != registered["benchmarkId"]
        or benchmark_sha256
        != registered["benchmarkArtifactSha256"]
        or benchmark.get("resultCoreSha256")
        != registered["resultCoreSha256"]
        or coordinate.get("id") != registered["benchmarkCoordinateId"]
        or coordinate.get("modalityClass") != "multimodal"
        or int(registry.get("count") or 0) != registered["candidateCount"]
        or registry.get("sha256")
        != registered["candidateRegistrySha256"]
        or int(dataset.get("n") or 0) != len(ordered)
        or dataset.get("fingerprints") != fingerprints
    ):
        raise RuntimeError(
            "The prequential keep benchmark does not match the current "
            "dataset, embeddings, or registered candidate search."
        )
    frozen = (
        benchmark.get("final", {}).get("frozenTail", {})
    )
    prequential = (
        benchmark.get("final", {}).get("causalPrequentialTail", {})
    )
    if not (
        frozen.get("metrics", {}).get("allAccountsWithin10") is True
        and prequential.get("metrics", {}).get(
            "allAccountsWithin10"
        ) is True
        and frozen.get("metrics", {}).get(
            "allAccountsBeatBaseline"
        ) is True
        and prequential.get("metrics", {}).get(
            "allAccountsBeatBaseline"
        ) is True
    ):
        raise RuntimeError(
            "The registered prequential keep benchmark no longer clears "
            "its retrospective account-level gates."
        )
    return (
        benchmark,
        ordered,
        benchmark_sha256,
    )


def creator_adaptive_points_from_benchmark(
    points_by_account: dict[str, list[dict[str, Any]]],
    row_by_id: dict[str, dict[str, Any]],
    phase: str,
) -> list[dict[str, Any]]:
    points = []
    for account in sorted(points_by_account, key=stable_hash):
        for source in points_by_account[account]:
            video_id = str(source["id"])
            row = row_by_id.get(video_id)
            if row is None:
                raise RuntimeError(
                    f"Prequential keep point {video_id} is absent from "
                    "the current private dataset."
                )
            history_ids = [
                str(value)
                for value in source.get("historyVideoIds") or []
            ]
            history_rows = [
                row_by_id[value]
                for value in history_ids
                if value in row_by_id
            ]
            if len(history_rows) != len(history_ids):
                raise RuntimeError(
                    f"Prequential keep point {video_id} has an unresolved "
                    "history video ID."
                )
            predicted = float(source["predictedKeep"])
            actual = float(source["actualKeep"])
            baseline = float(source["historyBaseline"])
            points.append(
                {
                    "id": video_id,
                    "title": str(row["title"]),
                    "account": str(account),
                    "accountName": str(row["accountName"]),
                    "publishedAt": clean_number(
                        source.get("publishedAt"),
                        0,
                    ),
                    "actual": clean_number(actual),
                    "predicted": clean_number(predicted),
                    "baseline": clean_number(baseline),
                    "error": clean_number(predicted - actual),
                    "absoluteError": clean_number(
                        abs(predicted - actual)
                    ),
                    "baselineAbsoluteError": clean_number(
                        abs(baseline - actual)
                    ),
                    "deltaAbsoluteError": clean_number(
                        abs(predicted - actual)
                        - abs(baseline - actual)
                    ),
                    "componentA": clean_number(
                        source.get("componentA")
                    ),
                    "componentB": clean_number(
                        source.get("componentB")
                    ),
                    "historyN": int(source["historyN"]),
                    "historyVideoIds": history_ids,
                    "historyStart": clean_number(
                        min(
                            float(item["publishedAt"])
                            for item in history_rows
                        )
                        if history_rows
                        else None
                    ),
                    "historyEnd": clean_number(
                        max(
                            float(item["publishedAt"])
                            for item in history_rows
                        )
                        if history_rows
                        else None
                    ),
                    "predictionIntervals": source.get(
                        "predictionIntervals"
                    ),
                    "phase": phase,
                }
            )
    points.sort(
        key=lambda point: (
            float(point["publishedAt"]),
            stable_hash(str(point["id"])),
        )
    )
    return points


def creator_adaptive_profile_registry(
    rows: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    profiles = {}
    history_window = int(
        CREATOR_ADAPTIVE_KEEP_V1_SPEC["historyWindow"]
    )
    accounts = sorted(
        {str(row["account"]) for row in rows},
        key=stable_hash,
    )
    for account in accounts:
        ordered = sorted(
            [
                row
                for row in rows
                if str(row["account"]) == account
            ],
            key=lambda row: (
                float(row["publishedAt"]),
                stable_hash(str(row["id"])),
            ),
        )
        history = ordered[-min(history_window, len(ordered)) :]
        profiles[account] = {
            "historyN": len(history),
            "historyVideoIds": [
                str(row["id"]) for row in history
            ],
            "historyThrough": clean_number(
                history[-1]["publishedAt"] if history else None
            ),
            "historyWindow": history_window,
            "liveScoringStatus": (
                "research_shadow_only_not_served_for_anonymous_uploads"
            ),
        }
    return profiles


def run_creator_adaptive_keep_study(
    rows: list[dict[str, Any]],
    stores: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    eligible = [
        row
        for row in rows
        if finite(row.get("keep"))
        and finite(row.get("publishedAt"))
        and row["id"] in stores["visual"]["index"]
        and row["id"] in stores["together"]["index"]
    ]
    benchmark, ordered, benchmark_sha256 = (
        load_creator_adaptive_benchmark(eligible, stores)
    )
    row_by_id = {
        str(row["id"]): row for row in ordered
    }
    final = benchmark["final"]
    prequential_source = final["causalPrequentialTail"]
    frozen_source = final["frozenTail"]
    selection_source = benchmark["selection"]
    evaluation_points = creator_adaptive_points_from_benchmark(
        prequential_source["pointsByAccount"],
        row_by_id,
        "causal_prequential_final20",
    )
    frozen_points = creator_adaptive_points_from_benchmark(
        frozen_source["pointsByAccount"],
        row_by_id,
        "frozen_final20",
    )
    selection_points = creator_adaptive_points_from_benchmark(
        selection_source["pointsByAccount"],
        row_by_id,
        "selection_middle30",
    )
    evaluation_metrics = creator_adaptive_point_metrics(
        evaluation_points
    )
    frozen_metrics = creator_adaptive_point_metrics(
        frozen_points
    )
    selection_metrics = creator_adaptive_point_metrics(
        selection_points
    )
    frozen_uncertainty = frozen_source.get("uncertainty") or {}
    frozen_uncertainty_by_account = {
        str(item["account"]): item
        for item in frozen_uncertainty.get("perAccount") or []
    }
    confidence_target_passes = 0
    for account_metrics in evaluation_metrics.get("perAccount") or []:
        account = str(account_metrics["account"])
        interval = creator_adaptive_bootstrap_interval(
            np.asarray(
                [
                    abs(float(point["error"]))
                    for point in evaluation_points
                    if str(point["account"]) == account
                ],
                dtype=float,
            ),
            (
                f"{CREATOR_ADAPTIVE_KEEP_COORDINATE_ID}:"
                f"prequential:{account}"
            ),
        )
        account_metrics["maeBootstrap90"] = interval
        account_metrics["frozenTailUncertainty"] = (
            frozen_uncertainty_by_account.get(account)
        )
        if finite(interval.get("upper")) and float(
            interval["upper"]
        ) <= 10:
            confidence_target_passes += 1
    account_metrics = evaluation_metrics.get("perAccount") or []
    account_count = len(
        {str(row["account"]) for row in ordered}
    )
    point_passes = sum(
        finite(item.get("mae")) and float(item["mae"]) <= 10
        for item in account_metrics
    )
    baseline_passes = sum(
        finite(item.get("maeImprovementVsBaseline"))
        and float(item["maeImprovementVsBaseline"]) > 0
        for item in account_metrics
    )
    all_point_pass = (
        point_passes == account_count and account_count > 0
    )
    all_baseline_pass = (
        baseline_passes == account_count and account_count > 0
    )
    locked = selection_source["stages"]["lockedFormula"]
    profiles = creator_adaptive_profile_registry(ordered)
    account_population = [
        {
            "id": account,
            "name": next(
                str(row["accountName"])
                for row in ordered
                if str(row["account"]) == account
            ),
            "n": sum(
                str(row["account"]) == account
                for row in ordered
            ),
        }
        for account in sorted(profiles, key=stable_hash)
    ]
    target = {
        "metric": "per-account mean absolute error",
        "thresholdPercentagePoints": 10,
        "pointEstimatePassCount": point_passes,
        "accountCount": account_count,
        "evaluatedAccountCount": len(account_metrics),
        "allPopulationAccountsEvaluated": (
            len(account_metrics) == account_count
        ),
        "missingEvaluationAccounts": sorted(
            set(profiles)
            - {
                str(item["account"])
                for item in account_metrics
            },
            key=stable_hash,
        ),
        "allAccountsPassPointEstimate": all_point_pass,
        "bootstrap90UpperPassCount": confidence_target_passes,
        "allAccountsPassBootstrap90Upper": (
            confidence_target_passes == account_count
            and account_count > 0
        ),
        "baseline": (
            "Arithmetic mean keep rate of at most the 30 most "
            "recent same-creator uploads with a publication timestamp "
            "strictly earlier than the target upload."
        ),
        "baselineBeatingAccountCount": baseline_passes,
        "allAccountsBeatHonestBaseline": all_baseline_pass,
        "beatsHonestBaselineOverall": (
            finite(
                evaluation_metrics.get(
                    "maeImprovementVsBaseline"
                )
            )
            and float(
                evaluation_metrics[
                    "maeImprovementVsBaseline"
                ]
            )
            > 0
        ),
        "maeImprovementVsBaseline": (
            evaluation_metrics.get(
                "maeImprovementVsBaseline"
            )
        ),
        "squaredErrorSkillVsBaseline": (
            evaluation_metrics.get("protocolBaselineR2")
        ),
        "prospectiveValidated": False,
    }
    return {
        "schemaVersion": CREATOR_ADAPTIVE_KEEP_SCHEMA_VERSION,
        "coordinateId": CREATOR_ADAPTIVE_KEEP_COORDINATE_ID,
        "label": (
            "Known-creator prequential keep-rate mixture"
        ),
        "input": (
            "The canonical 1,536D visual opening embedding, the "
            "canonical 1,536D together visual-plus-text opening "
            "embedding, and up to 30 strictly earlier measured keep "
            "outcomes from the explicit creator profile."
        ),
        "valueDefinition": (
            "A raw predicted stayed-to-watch percentage for a known "
            "creator's next upload. It is a multimodal derived "
            "forecast, not a new embedding space and not a "
            "visual-only score."
        ),
        "population": {
            "n": len(ordered),
            "accounts": account_population,
            "embeddingModel": "gemini-embedding-2",
            "embeddingDimensions": 1536,
            "representations": [
                {
                    "id": (
                        "representation.shorts.visual."
                        "gemini1536.v1"
                    ),
                    "dimensions": 1536,
                },
                {
                    "id": (
                        "representation.shorts.together."
                        "gemini1536.v1"
                    ),
                    "dimensions": 1536,
                },
            ],
            "fingerprints": benchmark["dataset"][
                "fingerprints"
            ],
        },
        "selection": {
            "protocol": (
                "A staged registry of 43,360 prespecified time-ordered "
                "candidates is evaluated only on each creator's "
                "chronological 50%-80% window. The final 20% is never "
                "read by candidate selection. Equal publication "
                "timestamps are one simultaneous batch."
            ),
            "candidateCount": int(
                benchmark["candidateRegistry"]["count"]
            ),
            "candidateRegistrySha256": (
                benchmark["candidateRegistry"]["sha256"]
            ),
            "candidateCountWithAllAccounts": int(
                benchmark["candidateRegistry"]["count"]
            ),
            "selected": {
                "benchmarkId": benchmark["benchmarkId"],
                "modalityClass": "multimodal",
                "formula": locked["formula"],
                "stage1": locked["stage1"],
                "stage2": locked["stage2"],
                "stage3": locked["stage3"],
                "stage4": locked["stage4"],
            },
            "metrics": selection_metrics,
            "benchmarkMetrics": selection_source["metrics"],
        },
        "evaluation": {
            "protocol": (
                "Prequential replay on the final 20% of every "
                "creator. Each equal-time batch is predicted before "
                "any outcome in that batch is revealed; revealed "
                "outcomes may inform only strictly later uploads. "
                "This evaluates temporal prediction, not a causal effect."
            ),
            "claimBoundary": (
                "Retrospective known-creator next-upload evidence "
                "with at least eight earlier labels. The development "
                "tail has now been inspected, so this is not a virgin "
                "prospective confirmation. Cold start and anonymous "
                "upload scoring are unsupported."
            ),
            "metrics": evaluation_metrics,
            "benchmarkMetrics": prequential_source["metrics"],
            "predictionIntervals": (
                prequential_source.get("predictionIntervals")
            ),
            "target": target,
            "points": evaluation_points,
        },
        "batchFreezeStress": {
            "protocol": (
                "The selected formula is frozen before the final 20% "
                "and the entire tail is predicted without consuming "
                "any final-tail outcome."
            ),
            "claimBoundary": (
                "This is the stricter frozen-backlog stress. It is "
                "reported separately from the next-upload replay."
            ),
            "metrics": frozen_metrics,
            "benchmarkMetrics": frozen_source["metrics"],
            "predictionIntervals": (
                frozen_source.get("predictionIntervals")
            ),
            "uncertainty": frozen_uncertainty,
            "points": frozen_points,
        },
        "ablations": {
            "selection": (
                selection_source.get("modalityAblations")
            ),
            "frozenTail": (
                frozen_source.get("modalityAblations")
            ),
            "causalPrequentialTail": (
                prequential_source.get("modalityAblations")
            ),
            "interpretation": (
                "History-only, visual-only, together-only, and the "
                "selection-locked multimodal formula are shown "
                "separately. The final-tail visual-only result is an "
                "ablation, not a post-hoc replacement for the formula "
                "selected before the final tail."
            ),
        },
        "rollingBlockStability": benchmark.get(
            "rollingBlockStability"
        ),
        "equalTimestampAudit": benchmark.get(
            "equalTimestampAudit"
        ),
        "labelAudit": {
            "target": (
                "Cumulative YouTube Studio stayed-to-watch value at "
                "the recorded scrape snapshot."
            ),
            "fixedHorizon": False,
            "warning": (
                "The current labels were observed at different video "
                "ages. This benchmark predicts the recorded snapshot "
                "target; it does not establish a fixed post-upload "
                "horizon."
            ),
        },
        "formula": {
            "modalityClass": "multimodal",
            "visualRepresentation": (
                "L2-normalized canonical 1,536D visual embedding"
            ),
            "togetherRepresentation": (
                "L2-normalized canonical 1,536D together "
                "visual-plus-text embedding"
            ),
            "historyWindow": int(
                CREATOR_ADAPTIVE_KEEP_V1_SPEC[
                    "historyWindow"
                ]
            ),
            "minimumHistoryN": int(
                CREATOR_ADAPTIVE_KEEP_V1_SPEC[
                    "minimumHistoryN"
                ]
            ),
            "model": (
                "Selection-locked prequential 50/50 residual-analog and "
                "semantic-stack mixture"
            ),
            "lockedFormula": locked,
            "outputTransform": (
                "clip(0.5 * centered-together residual analog + "
                "0.5 * visual+together semantic stack, 0, 100)"
            ),
            "outputBounds": [0, 100],
            "accounts": profiles,
            "profileRequirement": (
                "The caller must supply an explicit creator profile "
                "with at least eight strictly earlier measured keep "
                "outcomes. Anonymous scoring must return unavailable."
            ),
            "determinism": (
                "The same pinned visual and together matrices, "
                "creator history, equal-time batches, candidate "
                "registry, locked formula, and source code produce "
                "the same percentage."
            ),
        },
        "benchmark": {
            "benchmarkId": benchmark["benchmarkId"],
            "artifactPath": str(
                CAUSAL_KEEP_MIXTURE_BENCHMARK.relative_to(
                    ROOT
                )
            ),
            "artifactSha256": benchmark_sha256,
            "resultCoreSha256": benchmark[
                "resultCoreSha256"
            ],
            "candidateRegistrySha256": benchmark[
                "candidateRegistry"
            ]["sha256"],
            "datasetFingerprints": benchmark["dataset"][
                "fingerprints"
            ],
        },
        "status": {
            "state": (
                "research_only_retrospective_target_met"
                if all_point_pass and all_baseline_pass
                else "research_only_target_not_met"
            ),
            "plainEnglish": (
                "Every measured creator is below 10 percentage-point "
                "MAE in both the protected frozen tail and the prequential "
                "next-upload replay, and the selected content mixture "
                "beats the matched recent-30 history baseline "
                "descriptively in each account. The improvement is "
                "small for some accounts and the historical tail has "
                "been inspected, so prospective confirmation is "
                "still required."
            ),
            "absoluteTargetMet": all_point_pass,
            "confidenceTargetMet": (
                target["allAccountsPassBootstrap90Upper"]
            ),
            "beatsHonestBaselineOverall": target[
                "beatsHonestBaselineOverall"
            ],
            "beatsHonestBaselineEveryAccount": (
                all_baseline_pass
            ),
            "frozenTailTargetMet": bool(
                frozen_source["metrics"][
                    "allAccountsWithin10"
                ]
            ),
            "frozenTailBeatsBaselineEveryAccount": bool(
                frozen_source["metrics"][
                    "allAccountsBeatBaseline"
                ]
            ),
            "promoted": False,
            "predictorEligible": False,
            "promotionBlocker": (
                "Prospective uploads have not yet confirmed the "
                "locked artifact, and current labels are cumulative "
                "snapshots rather than one fixed post-upload horizon."
            ),
            "confidenceWarning": (
                "Per-account mean MAE below 10, individual predictions "
                "within ±10, bootstrap confidence, and incremental "
                "value over history are different claims. The UI "
                "shows each separately."
            ),
            "coldStart": "unsupported",
            "anonymousUpload": "unsupported",
            "batchBacklog": (
                "supported only as the separately reported frozen "
                "stress; operational updates require observed "
                "intervening outcomes"
            ),
        },
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
        train_rows, family_purge = purge_content_family_rows(
            train_rows,
            test_rows,
        )
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
                "contentFamilyPurge": family_purge,
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
        "description": (
            "An entire account is absent from axis fitting, formula selection, "
            "and calibration. Training rows sharing any available content-family "
            "identity with the held-out account are purged; promotion still "
            "requires strong lineage for every evaluated row."
        ),
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
    visual_only_study = run_visual_keep_study(eligible, stores)
    creator_adaptive_study = run_creator_adaptive_keep_study(eligible, stores)
    full_oof_features = private_fold_oof(
        eligible,
        within_group_folds(eligible, "account", 5),
        stores,
        public_axes,
    )
    unseen_account_features = private_inner_oof(
        eligible,
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
    blind_folds = within_group_folds(eligible, "account", 5)
    blind_rows = [
        {
            "id": row["id"],
            "title": row["title"],
            "account": row["account"],
            "accountName": row["accountName"],
            "publishedAt": clean_number(row.get("publishedAt"), 0),
            "actualKeep": clean_number(row.get("keep")),
            "actualRet5": clean_number(row.get("ret5")),
            "actualViews": clean_number(row.get("views"), 0),
            "duration": clean_number(row.get("duration"), 3),
            "contentFamilyId": validation_content_family_id(row),
            "contentFamilyEvidence": (
                validation_content_family_evidence(row)
            ),
            "promotionEligibleContentLineage": bool(
                validation_content_family_evidence(
                    row
                )["promotionEligible"]
            ),
            "videoFold": int(blind_folds[index]),
            "videoHeldOut": [
                clean_number(value)
                for value in full_oof_features[index]
            ],
            "accountHeldOut": [
                clean_number(value)
                for value in unseen_account_features[index]
            ],
        }
        for index, row in enumerate(eligible)
    ]
    blind_fold_manifest_rows = sorted(
        (
            {
                "id": str(row["id"]),
                "accountId": str(row["account"]),
                "contentFamilyId": str(row["contentFamilyId"]),
                "videoFold": int(row["videoFold"]),
            }
            for row in blind_rows
        ),
        key=lambda row: (row["id"], row["accountId"]),
    )
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
        "visualOnlyStudy": visual_only_study,
        "creatorAdaptiveStudy": creator_adaptive_study,
        "blindInputs": {
            "featureNames": PRIVATE_FEATURE_NAMES,
            "foldAlgorithm": "content-family-grouped-balanced-v1",
            "rowFoldManifestSha256": stable_json_sha256(
                blind_fold_manifest_rows
            ),
            "videoHeldOutProtocol": (
                "Every target-aligned keep, ret5, and realistic-views input is fit "
                "without the evaluated video. Public views, outlier, and 10M inputs "
                "use the production one-component PLS direction and rank-to-outcome "
                "calibration, refit on the public corpus after excluding every private "
                "and saved-channel video ID."
            ),
            "accountHeldOutProtocol": (
                "The evaluated account is absent from keep/ret5 axis fitting and "
                "percentile calibration. Public axes still exclude every private "
                "and saved-channel ID."
            ),
            "rows": blind_rows,
        },
        "stressTests": [transfer_stress] + ([temporal_stress] if temporal_stress else []),
        "warning": "The known-account interpolation score is not a pre-upload forecast. The forward-time test uses current frozen public reference axes and historical private labels, while the unseen-account test remains negative; do not claim a universal keep-rate model.",
    }


def views_channel_selection_datasets(
    rows: list[dict[str, Any]],
    X: np.ndarray,
    y: np.ndarray,
    requested: int = 3,
) -> list[
    tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]
]:
    folds = group_folds(
        [str(row["channel"]) for row in rows],
        requested,
    )
    datasets = []
    for fold in sorted(set(int(value) for value in folds)):
        test_indices = np.flatnonzero(folds == fold)
        candidate_train_indices = np.flatnonzero(
            folds != fold
        )
        test_families = {
            validation_content_family_id(rows[index])
            for index in test_indices
        }
        train_indices = np.asarray(
            [
                index
                for index in candidate_train_indices
                if validation_content_family_id(rows[index])
                not in test_families
            ],
            dtype=int,
        )
        if len(train_indices) < 8 or len(test_indices) < 2:
            continue
        datasets.append(
            (
                X[train_indices],
                y[train_indices],
                X[test_indices],
                y[test_indices],
            )
        )
    return datasets


def views_channel_outer_fold_inputs(
    rows: list[dict[str, Any]],
    X: np.ndarray,
    y: np.ndarray,
    channel: str,
) -> dict[str, Any]:
    test = np.asarray([
        str(row["channel"]) == str(channel)
        for row in rows
    ])
    candidate_train_rows = [
        row
        for row in rows
        if str(row["channel"]) != str(channel)
    ]
    test_rows = [
        row
        for row in rows
        if str(row["channel"]) == str(channel)
    ]
    train_rows, family_purge = purge_content_family_rows(
        candidate_train_rows,
        test_rows,
    )
    retained_ids = {
        str(row["id"])
        for row in train_rows
    }
    train = np.asarray([
        str(row["id"]) in retained_ids
        for row in rows
    ])
    selection_datasets = []
    if train.sum() >= 20 and test.sum() >= 8:
        selection_datasets = views_channel_selection_datasets(
            train_rows,
            X[train],
            y[train],
            requested=3,
        )
    return {
        "channel": str(channel),
        "train": train,
        "test": test,
        "trainRows": train_rows,
        "testRows": test_rows,
        "familyPurge": family_purge,
        "selectionDatasets": selection_datasets,
        "valid": bool(selection_datasets),
    }


def channel_outer_predictions(
    rows: list[dict[str, Any]],
    feature_names: list[str],
    candidates: list[tuple[int, ...]],
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]], Counter, list[dict[str, Any]]]:
    X = np.asarray([row["features"] for row in rows], dtype=float)
    y = np.asarray([row["logViews"] for row in rows], dtype=float)
    channels = sorted(set(row["channel"] for row in rows), key=stable_hash)
    predicted = np.full(len(rows), np.nan)
    fold_results = []
    points: list[dict[str, Any]] = []
    selected: Counter = Counter()
    for channel_position, channel in enumerate(channels, 1):
        update_status(
            "views",
            phase="unseen-channel",
            completed=channel_position - 1,
            total=len(channels),
            message=f"Public views: unseen-channel test {channel_position} of {len(channels)}",
        )
        fold_inputs = views_channel_outer_fold_inputs(
            rows,
            X,
            y,
            channel,
        )
        if not fold_inputs["valid"]:
            continue
        train = fold_inputs["train"]
        test = fold_inputs["test"]
        train_rows = fold_inputs["trainRows"]
        test_rows = fold_inputs["testRows"]
        family_purge = fold_inputs["familyPurge"]
        leaderboard, sparse_alpha = (
            search_datasets_with_sparse_alpha(
                fold_inputs["selectionDatasets"],
                candidates,
                top_n=5,
            )
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
                "contentFamilyPurge": family_purge,
                "features": [feature_names[index] for index in best],
                "sparseAlpha": sparse_alpha,
                "metrics": metric,
            }
        )
        for row, truth, estimate in zip(
            test_rows,
            y[test],
            fold_prediction,
        ):
            points.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "channel": row["channel"],
                    "channelName": row["channelName"],
                    "actualViews": max(0, round(10**truth - 1)),
                    "predictedViews": max(0, round(10**estimate - 1)),
                    "actualLogViews": clean_number(truth),
                    "predictedLogViews": clean_number(estimate),
                    "factorError": clean_number(10 ** abs(estimate - truth)),
                }
            )
    return y, predicted, fold_results, selected, points


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
        train_rows, family_purge = purge_content_family_rows(
            train_rows,
            test_rows,
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
                "contentFamilyPurge": family_purge,
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


def views_single_feature_diagnostics(
    rows: list[dict[str, Any]],
    feature_names: list[str],
) -> list[dict[str, Any]]:
    if not rows:
        return []
    X = np.asarray([row["features"] for row in rows], dtype=float)
    if X.ndim != 2 or X.shape[1] != len(feature_names):
        raise RuntimeError(
            "views diagnostic feature matrix does not match its names"
        )
    target = np.asarray([row["logViews"] for row in rows])
    channel_groups = [str(row["channel"]) for row in rows]
    centered_target = within_source_center(target, channel_groups)
    diagnostics = []
    for index, feature_name in enumerate(feature_names):
        values = X[:, index]
        valid_feature = np.isfinite(values)
        pooled = (
            spearmanr(
                values[valid_feature],
                target[valid_feature],
            )
            if valid_feature.sum() >= 8
            else None
        )
        correlation, p_value = within_source_rank_test(
            values,
            target,
            channel_groups,
            feature_name,
        )
        centered_values = within_source_center(
            values,
            channel_groups,
        )
        diagnostics.append(
            {
                "feature": feature_name,
                "n": int(valid_feature.sum()),
                "spearmanLogViews": clean_number(correlation),
                "withinSourceSpearman": clean_number(
                    correlation
                ),
                "pooledSpearmanLogViews": clean_number(
                    pooled.statistic
                    if pooled is not None
                    else None
                ),
                "pValue": p_value,
                "associationMethod": (
                    "within-source centered rank correlation with "
                    "1,000 within-source target permutations"
                ),
                "relationship": relationship_bins(
                    centered_values,
                    centered_target,
                ),
                "pooledRelationship": relationship_bins(
                    values,
                    target,
                ),
            }
        )
    add_fdr_q_values(diagnostics)
    for row in diagnostics:
        row["pValue"] = clean_number(row.get("pValue"), 8)
    diagnostics.sort(
        key=lambda item: abs(
            item["spearmanLogViews"] or 0
        ),
        reverse=True,
    )
    return diagnostics


def run_views_track(
    rows: list[dict[str, Any]],
    contract: dict[str, Any],
    candidates: list[tuple[int, ...]],
    stores: dict[str, dict[str, Any]],
    public_axes: dict[str, dict[str, Any]],
    axis_audit: dict[str, Any],
    creator_lineage: dict[str, Any],
) -> dict[str, Any]:
    diagnostic_feature_names = saved_channel_feature_names(contract)
    diagnostic_rows = [
        row
        for row in rows
        if row["ageDays"] is None or row["ageDays"] >= 30
    ]
    diagnostic_single_features = (
        views_single_feature_diagnostics(
            diagnostic_rows,
            diagnostic_feature_names,
        )
    )
    feature_names = leakage_safe_views_feature_names()
    if any(
        any(
            f".{forbidden}." in feature_name
            for forbidden in VIEWS_VALIDATION_FORBIDDEN_TARGETS
        )
        for feature_name in feature_names
    ):
        raise RuntimeError(
            "views validation allowlist contains a forbidden "
            "outcome-derived target"
        )
    eligible, excluded_feature_rows = leakage_safe_views_rows(
        diagnostic_rows,
        stores,
        public_axes,
        axis_audit,
    )
    independent_channels = sorted({
        str(row["channel"])
        for row in eligible
    })
    transfer_fold_plan = []
    if eligible:
        preflight_X = np.asarray(
            [row["features"] for row in eligible],
            dtype=float,
        )
        preflight_y = np.asarray(
            [row["logViews"] for row in eligible],
            dtype=float,
        )
        transfer_fold_plan = [
            views_channel_outer_fold_inputs(
                eligible,
                preflight_X,
                preflight_y,
                channel,
            )
            for channel in independent_channels
        ]
    valid_transfer_folds = sum(
        bool(fold["valid"])
        for fold in transfer_fold_plan
    )
    population_blockers = []
    if len(eligible) < VIEWS_MINIMUM_ROWS:
        population_blockers.append(
            f"only {len(eligible)} of {VIEWS_MINIMUM_ROWS} required "
            "proven-disjoint raw-embedding rows are available"
        )
    if (
        len(independent_channels)
        < VIEWS_MINIMUM_INDEPENDENT_CHANNELS
    ):
        population_blockers.append(
            f"only {len(independent_channels)} of "
            f"{VIEWS_MINIMUM_INDEPENDENT_CHANNELS} required independent "
            "channels are available"
        )
    if (
        valid_transfer_folds
        < VIEWS_MINIMUM_VALID_TRANSFER_FOLDS
    ):
        population_blockers.append(
            f"only {valid_transfer_folds} of "
            f"{VIEWS_MINIMUM_VALID_TRANSFER_FOLDS} required nested "
            "unseen-channel folds retain enough rows after content-family "
            "purging"
        )
    if population_blockers:
        empty_metrics = log_view_metrics(
            np.asarray([], dtype=float),
            np.asarray([], dtype=float),
        )
        return {
            "label": "Public views",
            "availability": {
                "state": "blocked_insufficient_validation_population",
                "predictorEligible": False,
                "minimumRows": VIEWS_MINIMUM_ROWS,
                "eligibleRows": len(eligible),
                "diagnosticRows": len(diagnostic_rows),
                "excludedRows": len(excluded_feature_rows),
                "minimumIndependentChannels": (
                    VIEWS_MINIMUM_INDEPENDENT_CHANNELS
                ),
                "independentChannels": len(
                    independent_channels
                ),
                "minimumValidTransferFolds": (
                    VIEWS_MINIMUM_VALID_TRANSFER_FOLDS
                ),
                "validTransferFolds": valid_transfer_folds,
                "blockers": population_blockers,
                "reason": (
                    "The registered public-views validation population is "
                    "not sufficient: "
                    + "; ".join(population_blockers)
                    + ". The bound 21-coordinate ledgers remain available "
                    "only for retrospective association analysis."
                ),
            },
            "population": (
                "Saved-channel Shorts scored only from freshly rebuilt "
                "views/outlier/gt10M axes whose fit manifests prove zero "
                "evaluation-row overlap"
            ),
            "primaryValidation": (
                "Blocked before model selection because the prespecified "
                "row, independent-channel, and valid nested-fold gates were "
                "not all met."
            ),
            "prospectiveValidation": (
                "No forward-time views predictor was fit."
            ),
            "prospectiveMetrics": None,
            "decisionStatus": "validation blocked",
            "n": 0,
            "channels": [],
            "metrics": empty_metrics,
            "contentOnlyMetrics": empty_metrics,
            "withinSourceMetrics": empty_metrics,
            "sourceSummary": {
                "independentSources": len(independent_channels),
                "intervalCaveat": (
                    "No predictor was fit, so no source-level interval "
                    "exists."
                ),
                "perSource": [],
            },
            "allInputsMetrics": empty_metrics,
            "maturitySensitivity": [],
            "calibration": [],
            "tailRisk": [],
            "folds": [],
            "points": [],
            "formula": {
                "targetUnit": "log10 views",
                "intercept": None,
                "terms": [],
                "plainEnglish": (
                    "No views formula was fit because the registered "
                    "validation-population gates were not all met."
                ),
                "alpha": None,
            },
            "allInputsFormula": None,
            "groupCalibration": [],
            "topModels": [],
            "singleFeatures": [],
            "selectionStability": [],
            "blindInputs": {
                "featureNames": feature_names,
                "featureCount": len(feature_names),
                "allowlist": {
                    "requiredTargets": list(
                        VIEWS_VALIDATION_AXIS_TARGETS
                    ),
                    "featureDefinitions": (
                        axis_audit.get(
                            "eligibleFeatureDefinitions"
                        )
                        or []
                    ),
                    "forbiddenTargets": sorted(
                        VIEWS_VALIDATION_FORBIDDEN_TARGETS
                    ),
                    "conditionalCoordinates": (
                        axis_audit.get("conditionalCoordinates")
                        or []
                    ),
                    "rule": axis_audit.get("rule"),
                },
                "upstreamAxisAudit": axis_audit,
                "excludedRows": excluded_feature_rows,
                "contentFamilyEvidence": (
                    content_family_evidence_audit(eligible)
                ),
                "rows": [
                    {
                        "id": row["id"],
                        "channel": row["channel"],
                        "contentFamilyEvidence": (
                            validation_content_family_evidence(row)
                        ),
                        "promotionEligibleContentLineage": bool(
                            validation_content_family_evidence(
                                row
                            )["promotionEligible"]
                        ),
                    }
                    for row in eligible
                ],
            },
            "diagnosticAnalyses": {
                "storedLedgerAllCoordinates": {
                    "predictorEligible": False,
                    "promotionEligible": False,
                    "featureNames": diagnostic_feature_names,
                    "singleFeatures": diagnostic_single_features,
                    "reason": (
                        "The complete bound 21-coordinate ledger remains "
                        "useful for descriptive associations. Its historical "
                        "upstream fit populations are not fully replayable, "
                        "so these associations cannot validate a held-out views "
                        "predictor."
                    ),
                }
            },
            "stressTests": [],
            "warning": (
                "No public-views predictor was fit or published. Backfill "
                "full immutable raw embeddings across enough independent "
                "channels to satisfy every registered population gate "
                "before rerunning this validation."
            ),
        }
    if not candidates or any(
        index >= len(feature_names)
        for candidate in candidates
        for index in candidate
    ):
        raise RuntimeError(
            "views candidate registry does not match the leakage-safe "
            "feature allowlist"
        )
    dated_count = sum(finite(row.get("publishedAt")) for row in eligible)
    X = np.asarray([row["features"] for row in eligible], dtype=float)
    y = np.asarray([row["logViews"] for row in eligible], dtype=float)
    (
        y_transfer,
        predicted_transfer,
        transfer_folds,
        transfer_selected,
        transfer_points,
    ) = channel_outer_predictions(
        eligible, feature_names, candidates
    )
    transfer_valid = np.isfinite(predicted_transfer)
    transfer_metrics = log_view_metrics(
        y_transfer[transfer_valid],
        predicted_transfer[transfer_valid],
    )
    transfer_stress = {
        "label": "Unseen-channel transfer",
        "description": (
            "An entire saved channel is absent from formula selection and "
            "calibration. Training rows sharing any available content-family "
            "identity with the held-out channel are purged; promotion still "
            "requires strong lineage for every evaluated row."
        ),
        "metrics": transfer_metrics,
        "calibration": calibration_bins(y_transfer[transfer_valid], predicted_transfer[transfer_valid]),
        "folds": transfer_folds,
        "sourceSummary": source_level_summary(transfer_folds),
        "points": sorted(
            transfer_points,
            key=lambda point: point["actualViews"],
            reverse=True,
        ),
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
    single_features = views_single_feature_diagnostics(
        eligible,
        feature_names,
    )
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
        "population": (
            "Saved-channel Shorts scored only from freshly rebuilt "
            "views/outlier/gt10M axes whose fit manifests prove zero "
            "evaluation-row overlap"
        ),
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
        "blindInputs": {
            "featureNames": feature_names,
            "featureCount": len(feature_names),
            "allowlist": {
                "requiredTargets": list(
                    VIEWS_VALIDATION_AXIS_TARGETS
                ),
                "featureDefinitions": (
                    axis_audit.get(
                        "eligibleFeatureDefinitions"
                    )
                    or []
                ),
                "forbiddenTargets": sorted(
                    VIEWS_VALIDATION_FORBIDDEN_TARGETS
                ),
                "conditionalCoordinates": (
                    axis_audit.get("conditionalCoordinates") or []
                ),
                "rule": axis_audit.get("rule"),
            },
            "upstreamAxisAudit": axis_audit,
            "excludedRows": excluded_feature_rows,
            "contentFamilyEvidence": (
                content_family_evidence_audit(eligible)
            ),
            "rows": [
                {
                    "id": row["id"],
                    "channel": row["channel"],
                    "contentFamilyEvidence": (
                        validation_content_family_evidence(row)
                    ),
                    "promotionEligibleContentLineage": bool(
                        validation_content_family_evidence(
                            row
                        )["promotionEligible"]
                    ),
                }
                for row in eligible
            ],
        },
        "diagnosticAnalyses": {
            "storedLedgerAllCoordinates": {
                "predictorEligible": False,
                "promotionEligible": False,
                "featureNames": diagnostic_feature_names,
                "singleFeatures": diagnostic_single_features,
                "reason": (
                    "This preserves associations for all materialized ledger "
                    "coordinates, but keep, ret5, realviews, and legacy novelty "
                    "axes do not have producer-verifiable disjoint upstream "
                    "fit populations. They cannot support a held-out views claim."
                ),
            }
        },
        "stressTests": [transfer_stress] + ([temporal_stress] if temporal_stress else []),
        "warning": (
            f"The operational score calibrates to a known channel's historical scale. Publication dates are present for {dated_count:,} of {len(eligible):,} eligible Shorts, "
            "but outcomes are still current-view snapshots rather than fixed 30-day views. The forward-time ordering is retrospective and cannot reconstruct as-of view labels; unseen-channel transfer is also reported separately."
        ),
    }


def apply_validation_promotion_gates(
    target: dict[str, Any],
    rows: list[dict[str, Any]],
    creator_lineage: dict[str, Any],
    axis_audit: dict[str, Any],
) -> dict[str, Any]:
    blind_rows = (
        (target.get("blindInputs") or {}).get("rows")
        if isinstance(target.get("blindInputs"), dict)
        else None
    )
    evaluated_ids = {
        str(row.get("id") or "")
        for row in (blind_rows or [])
        if isinstance(row, dict)
        and str(row.get("id") or "")
    }
    evaluated_rows = (
        [
            row
            for row in rows
            if str(row.get("id") or "") in evaluated_ids
        ]
        if evaluated_ids
        else rows
    )
    content_audit = content_family_evidence_audit(
        evaluated_rows
    )
    blockers: list[str] = []
    availability = target.get("availability")
    if (
        isinstance(availability, dict)
        and availability.get("state") != "ready"
    ):
        blockers.append(
            str(
                availability.get("reason")
                or "the target is not available for validation"
            )
        )
    if not axis_audit.get("requiredAxesPassed"):
        blockers.append(
            "upstream axis fit-population provenance did not prove "
            "evaluation-row disjointness"
        )
    if not creator_lineage.get("allGroupsResolved"):
        blockers.append(
            "one or more internal accounts/channels could not be resolved "
            "to a canonical YouTube channel ID"
        )
    if not axis_audit.get("wholeCreatorExclusionPassed"):
        blockers.append(
            "whole-creator exclusion was not proven for every "
            "evaluation group"
        )
    if not axis_audit.get("strongFitContentLineagePassed"):
        blockers.append(
            "one or more upstream fit rows lack strong source/content "
            "lineage, so different-ID reupload overlap cannot be ruled out"
        )
    if not content_audit.get("allRowsHaveStrongLineage"):
        blockers.append(
            "one or more evaluation rows have only weak, identity-only, "
            "or absent duplicate-family evidence"
        )
    leakage_passed = not blockers
    prospectively_validated = (
        target.get("decisionStatus")
        == "positive prospective validation"
    )
    visual_study = target.get("visualOnlyStudy")
    if isinstance(visual_study, dict):
        visual_promotion = visual_study.get("promotion")
        if isinstance(visual_promotion, dict):
            threshold_passed = bool(
                visual_promotion.get(
                    "retrospectiveMetricThresholdPassed"
                )
            )
            visual_promotion[
                "retrospectiveMetricThresholdPassed"
            ] = threshold_passed
            visual_promotion["leakageGatePassed"] = (
                leakage_passed
            )
            visual_predictor_eligible = bool(
                threshold_passed
                and leakage_passed
                and prospectively_validated
            )
            visual_promotion["promoted"] = (
                visual_predictor_eligible
            )
            visual_promotion["predictorEligible"] = (
                visual_predictor_eligible
            )
            visual_blockers = list(blockers)
            if not prospectively_validated:
                visual_blockers.append(
                    "no preregistered prospective validation"
                )
            if not threshold_passed:
                visual_blockers.append(
                    "retrospective metric threshold was not met"
                )
            visual_promotion["promotionBlockers"] = (
                visual_blockers
            )
            if visual_predictor_eligible:
                visual_promotion["status"] = (
                    "prospectively_validated_predictor"
                )
            elif not leakage_passed:
                visual_promotion["status"] = (
                    "unverified_diagnostic_result"
                )
            elif threshold_passed:
                visual_promotion["status"] = (
                    "retrospective_candidate_for_prospective_test"
                )
            else:
                visual_promotion["status"] = (
                    "research_only_not_validated_for_pre_upload_decisions"
                )
    creator_adaptive_study = target.get(
        "creatorAdaptiveStudy"
    )
    if isinstance(creator_adaptive_study, dict):
        creator_status = creator_adaptive_study.get("status")
        if isinstance(creator_status, dict):
            creator_status["leakageGatePassed"] = (
                leakage_passed
            )
            if not leakage_passed:
                creator_status["promoted"] = False
                creator_status["predictorEligible"] = False
                creator_status["leakageBlockers"] = (
                    list(blockers)
                )
    promotion_blockers = list(blockers)
    if not prospectively_validated:
        promotion_blockers.append(
            "the result is retrospective or only a partial forward-time "
            "backtest, not a preregistered prospective validation"
        )
    target["leakageReview"] = {
        "passed": leakage_passed,
        "upstreamAxisDisjoint": bool(
            axis_audit.get("requiredAxesPassed")
        ),
        "wholeCreatorExclusionResolved": bool(
            creator_lineage.get("allGroupsResolved")
        ),
        "wholeCreatorExclusionPassed": bool(
            axis_audit.get("wholeCreatorExclusionPassed")
        ),
        "strongFitContentLineagePassed": bool(
            axis_audit.get("strongFitContentLineagePassed")
        ),
        "strongContentLineagePassed": bool(
            content_audit.get("allRowsHaveStrongLineage")
        ),
        "blockers": blockers,
        "rule": (
            "Leakage-passed requires all four independent gates: verified "
            "upstream fit-population disjointness, canonical whole-creator "
            "exclusion for every group, strong source/content lineage across "
            "the upstream fit, and strong lineage for every evaluated row."
        ),
    }
    target["validationEligibility"] = {
        "state": (
            "leakage_passed_research_result"
            if leakage_passed
            else "unverified_diagnostic_result"
        ),
        "predictorEligible": (
            leakage_passed and prospectively_validated
        ),
        "creatorLineage": creator_lineage,
        "contentFamilyEvidence": content_audit,
        "upstreamAxisAudit": axis_audit,
    }
    target["promotion"] = {
        "eligible": (
            leakage_passed and prospectively_validated
        ),
        "leakagePassed": leakage_passed,
        "prospectivelyValidated": prospectively_validated,
        "blockers": promotion_blockers,
        "status": (
            "eligible"
            if leakage_passed and prospectively_validated
            else "diagnostic_only_non_promotable"
        ),
    }
    return target


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
    long_library = immutable_r2_json_snapshot(
        "longform/db.json",
        (
            "raw/predictor-lab/source-snapshots/"
            "longform-db/by-sha256"
        ),
        {"videos": {}},
    ).get("videos") or {}
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
    producer_source_path = Path(__file__).resolve()
    producer_source_relative = producer_source_path.relative_to(ROOT)
    producer_source_bytes = producer_source_path.read_bytes()
    producer_source_sha256 = hashlib.sha256(
        producer_source_bytes
    ).hexdigest()
    record_source(
        f"local:{producer_source_relative}",
        producer_source_bytes,
    )
    contract = json.loads(contract_bytes)
    library = load_library()
    stores = load_raw()
    private_rows = load_private_rows()
    saved_rows, saved_channel_evidence_inventory = (
        load_saved_channel_rows(contract)
    )
    saved_score_population_rows = sorted(
        [
            {
                "id": row["id"],
                "channel": row["channel"],
                "scoreLedgerSha256": row["scoreLedgerSha256"],
                "scoreLedgerState": row["scoreLedgerState"],
                "scoreRecordSha256": row["scoreRecordSha256"],
                "manifestRowSha256": row["manifestRowSha256"],
                "inputRevisionFingerprint":
                    row["inputRevisionFingerprint"],
                "historicalMaterialized":
                    row["historicalMaterialized"],
                "priorScoreLedgerSha256":
                    row["priorScoreLedgerSha256"],
            }
            for row in saved_rows
        ],
        key=lambda row: (row["channel"], row["id"]),
    )
    private_ids = {row["id"] for row in private_rows}
    saved_ids = {row["id"] for row in saved_rows}
    private_creator_lineage = resolve_external_creator_lineage(
        private_rows,
        "account",
        library,
    )
    saved_creator_lineage = resolve_external_creator_lineage(
        saved_rows,
        "channel",
        library,
    )
    validation_youtube_channel_ids = set(
        private_creator_lineage[
            "resolvedYoutubeChannelIds"
        ]
    ) | set(
        saved_creator_lineage[
            "resolvedYoutubeChannelIds"
        ]
    )
    validation_content_family_ids = {
        str(evidence["familyId"])
        for evidence in (
            validation_content_family_evidence(row)
            for row in (private_rows + saved_rows)
        )
        if evidence["promotionEligible"]
    }
    validation_creator_video_ids = {
        str(video_id)
        for video_id, video in library.items()
        if str(video.get("channelId") or "") in validation_youtube_channel_ids
    }
    excluded_axis_ids = private_ids | saved_ids | validation_creator_video_ids
    candidate_axis_corpus_ids = {
        video_id
        for store in stores.values()
        for index, video_id in enumerate(store["ids"])
        if not store["mine"][index] and video_id not in private_ids
    }
    removed_saved_axis_overlap = sorted(saved_ids & candidate_axis_corpus_ids)
    removed_creator_axis_overlap = sorted(
        validation_creator_video_ids & candidate_axis_corpus_ids
    )
    axis_corpus_ids = {
        video_id
        for store in stores.values()
        for index, video_id in enumerate(store["ids"])
        if not store["mine"][index] and video_id not in excluded_axis_ids
    }
    saved_axis_overlap = sorted(saved_ids & axis_corpus_ids)
    private_axis_overlap = sorted(private_ids & axis_corpus_ids)
    creator_axis_overlap = sorted(validation_creator_video_ids & axis_corpus_ids)
    if saved_axis_overlap or private_axis_overlap or creator_axis_overlap:
        raise RuntimeError(
            "validation leakage remains in the raw axis corpus "
            f"(saved={len(saved_axis_overlap)}, private={len(private_axis_overlap)}, "
            f"creator={len(creator_axis_overlap)})"
        )
    contract_hash = hashlib.sha256(contract_bytes).hexdigest()
    all_creator_lineage_resolved = bool(
        private_creator_lineage["allGroupsResolved"]
        and saved_creator_lineage["allGroupsResolved"]
    )
    provenance = {
        "featureContractSha256": contract_hash,
        "featureContractVersion": contract.get("version"),
        "producerSourceSha256": producer_source_sha256,
        "artifactPublication": {
            "canonicalKey": R2_RESULT_KEY,
            "manifestKey": R2_RESULT_MANIFEST_KEY,
            "archiveKeyPattern": "raw/predictor-lab/by-sha256/{artifactSha256}.json",
        },
        "scoreLedgerPersistedPerVideo": True,
        "scoreLedgerSemanticsContentAddressed": True,
        "scoreRecordAndManifestBindingsPersisted": True,
        "featureScorerVersionPersistedPerVideo": False,
        "savedScorePopulation": {
            "rowCount": len(saved_score_population_rows),
            "rowsSha256": hashlib.sha256(
                ledger_json_bytes(saved_score_population_rows)
            ).hexdigest(),
            "ledgerStateCounts": dict(sorted(Counter(
                row["scoreLedgerState"]
                for row in saved_score_population_rows
            ).items())),
            "historicalMaterializedCount": sum(
                bool(row["historicalMaterialized"])
                for row in saved_score_population_rows
            ),
            "rowStorage": (
                "hash_and_summary_only; canonical rows remain in the "
                "content-addressed saved-channel record artifacts"
            ),
            "evidenceInventory":
                saved_channel_evidence_inventory,
        },
        "savedChannelVideoCount": len(saved_ids),
        "rawAxisCorpusVideoCount": len(axis_corpus_ids),
        "privateAxisTrainingIdOverlap": len(private_axis_overlap),
        "savedAxisTrainingIdOverlap": len(saved_axis_overlap),
        "validationCreatorAxisTrainingIdOverlap": (
            len(creator_axis_overlap)
            if all_creator_lineage_resolved
            else None
        ),
        "validationCreatorAxisTrainingResolvedSubsetOverlap": len(
            creator_axis_overlap
        ),
        "validationCreatorAxisTrainingOverlapVerified": (
            all_creator_lineage_resolved
        ),
        "validationCreatorChannelIds": sorted(validation_youtube_channel_ids),
        "validationCreatorChannelIdHash": hashlib.sha256(
            "\n".join(sorted(validation_youtube_channel_ids)).encode()
        ).hexdigest(),
        "validationCreatorVideoCountExcluded": len(validation_creator_video_ids),
        "validationContentFamilyCountExcluded": len(
            validation_content_family_ids
        ),
        "validationContentFamilyIdHash": hashlib.sha256(
            "\n".join(
                sorted(validation_content_family_ids)
            ).encode()
        ).hexdigest(),
        "privateCreatorLineage": private_creator_lineage,
        "savedCreatorLineage": saved_creator_lineage,
        "savedAxisCandidateOverlapRemoved": len(removed_saved_axis_overlap),
        "creatorAxisCandidateOverlapRemoved": len(removed_creator_axis_overlap),
        "savedAxisCandidateOverlapRemovedIdsHash": hashlib.sha256(
            "\n".join(removed_saved_axis_overlap).encode()
        ).hexdigest(),
        "publicAxisExcludedVideoCount": len(excluded_axis_ids),
        "publicAxisExcludedVideoIdHash": hashlib.sha256(
            "\n".join(sorted(excluded_axis_ids)).encode()
        ).hexdigest(),
        "publicAxisEstimator": (
            "one-component PLS latent direction; prediction rank quantile-mapped "
            "to the public log-view/outlier outcome distribution; 10M uses the "
            "production local class rate in a +/-5% rank neighborhood"
        ),
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
        "warning": (
            "Every private and saved-channel video ID is explicitly removed "
            "before fitting the replayed public views/outlier/10M axes. Whole "
            "creator removal is separately proven only for accounts/channels "
            "that resolve through explicit YouTube metadata or exact video-ID "
            "joins; unresolved internal IDs make the corresponding result "
            "unverified and non-promotable. Every "
            "eligible saved-channel row now requires a current "
            "content-addressed 21-coordinate ledger, an exact input-bound "
            "evidence declaration, and record plus manifest bindings. "
            "Historical feature/steer copies and prior ledger revisions are "
            "excluded rather than repaired during model construction. "
            "Validation remains retrospective and diagnostic until "
            "prospective, immutable end-to-end scorer runs exist."
        ),
    }
    keep_candidates = candidate_registry(len(PRIVATE_FEATURE_NAMES))
    views_feature_names = leakage_safe_views_feature_names()
    views_candidates = candidate_registry(len(views_feature_names))
    if len(keep_candidates) != EXPERIMENT_COUNT or len(views_candidates) != EXPERIMENT_COUNT:
        raise RuntimeError(
            f"candidate registries have keep={len(keep_candidates)} and views={len(views_candidates)}, expected {EXPERIMENT_COUNT}"
        )
    novelty_models = load_novelty_models()
    public_axes = fit_public_axes(
        stores,
        excluded_axis_ids,
        novelty_models,
        library,
        validation_youtube_channel_ids,
        validation_content_family_ids,
    )
    private_axis_audit = audit_public_axis_provenance(
        public_axes,
        private_rows,
        private_creator_lineage,
    )
    saved_axis_audit = audit_public_axis_provenance(
        public_axes,
        saved_rows,
        saved_creator_lineage,
    )
    provenance["privateUpstreamAxisAudit"] = private_axis_audit
    provenance["savedViewsUpstreamAxisAudit"] = (
        saved_axis_audit
    )
    provenance["publicAxisPopulations"] = {
        modality: axes["population"]
        for modality, axes in public_axes.items()
    }
    public_fit_populations: dict[str, dict[str, Any]] = {}
    public_fit_manifests: dict[str, dict[str, Any]] = {}
    for modality, axes in public_axes.items():
        for target in ("views", "outlier", "gt10M"):
            fit_manifest = axes["fitManifests"][target]
            population_sha256 = fit_manifest["rowsSha256"]
            public_fit_populations.setdefault(
                population_sha256,
                {
                    "rows": fit_manifest["rows"],
                    "rowsSha256": population_sha256,
                },
            )
            public_fit_manifests[f"{modality}.{target}"] = {
                "schema": fit_manifest["schema"],
                "axisTarget": fit_manifest["axisTarget"],
                "populationSha256": population_sha256,
                "rowsSha256": population_sha256,
                "rowCount": len(fit_manifest["rows"]),
                "excludedVideoIdCount": fit_manifest[
                    "excludedVideoIdCount"
                ],
                "excludedVideoIdSha256": fit_manifest[
                    "excludedVideoIdSha256"
                ],
                "excludedYoutubeChannelIdCount": fit_manifest[
                    "excludedYoutubeChannelIdCount"
                ],
                "excludedYoutubeChannelIdSha256": fit_manifest[
                    "excludedYoutubeChannelIdSha256"
                ],
                "excludedContentFamilyIdCount": fit_manifest[
                    "excludedContentFamilyIdCount"
                ],
                "excludedContentFamilyIdSha256": fit_manifest[
                    "excludedContentFamilyIdSha256"
                ],
            }
    provenance["publicAxisFitPopulations"] = public_fit_populations
    provenance["publicAxisFitManifests"] = public_fit_manifests
    update_status(
        "keep",
        message="Running nested known-account keep search plus unseen-account stress test",
        experiments=EXPERIMENT_COUNT,
    )
    keep = run_keep_track(
        private_rows,
        stores,
        public_axes,
        keep_candidates,
    )
    apply_validation_promotion_gates(
        keep,
        private_rows,
        private_creator_lineage,
        private_axis_audit,
    )
    update_status(
        "views",
        message="Running nested known-channel views search plus unseen-channel stress test",
        experiments=EXPERIMENT_COUNT,
    )
    views = run_views_track(
        saved_rows,
        contract,
        views_candidates,
        stores,
        public_axes,
        saved_axis_audit,
        saved_creator_lineage,
    )
    apply_validation_promotion_gates(
        views,
        saved_rows,
        saved_creator_lineage,
        saved_axis_audit,
    )
    corpus = None
    if not args.skip_corpus_benchmark:
        update_status("corpus", message="Running creator-group raw embedding benchmark")
        corpus = raw_corpus_benchmark(stores, library)
    provenance["readSnapshotVerification"] = (
        verify_read_snapshot_unchanged()
    )
    provenance["immutableSourceSnapshots"] = [
        dict(snapshot)
        for snapshot in IMMUTABLE_SOURCE_SNAPSHOTS
    ]
    provenance["sourceArtifacts"] = {
        name: READ_PROVENANCE[name]
        for name in sorted(READ_PROVENANCE)
    }
    result_generated_at = int(time.time() * 1000)
    visual_keep_study = keep.get("visualOnlyStudy") or {}
    registered_visual_keep_formula = visual_keep_study.get("formula") or {}
    visual_keep_evidence_status = require_current_visual_keep_artifact(
        {
            "producerSourceSha256": provenance["producerSourceSha256"],
            "formula": registered_visual_keep_formula,
            "protocols": visual_keep_study.get("protocols"),
        }
    )
    visual_keep_study["evidenceCompatibility"] = (
        visual_keep_evidence_status
    )
    visual_keep_model = {
        "schemaVersion": 1,
        "coordinateId": VISUAL_KEEP_COORDINATE_ID,
        "generatedAt": result_generated_at,
        "status": (visual_keep_study.get("promotion") or {}).get("status"),
        "input": visual_keep_study.get("input"),
        "population": visual_keep_study.get("population"),
        "fitPopulation": (
            visual_keep_study.get("production") or {}
        ).get("fitPopulation"),
        "trainingPredictions": [
            {
                "id": point.get("id"),
                "predicted": point.get("predicted"),
                "pooledPrediction": point.get("pooledPrediction"),
                "calibrationScope": point.get("calibrationScope"),
                "account": point.get("account"),
            }
            for point in (
                (visual_keep_study.get("production") or {}).get("points") or []
            )
        ],
        "formula": {
            key: registered_visual_keep_formula.get(key)
            for key in (
                "estimatorId",
                "scope",
                "input",
                "outputUnit",
                "outputTransform",
                "outputBounds",
                "selected",
                "pooled",
                "accountInputs",
            )
        },
        "validationSummary": {
            key: {
                "key": (protocol or {}).get("key"),
                "label": (protocol or {}).get("label"),
                "estimator": (protocol or {}).get("estimator"),
                "exactFormulaReplayVerified": (protocol or {}).get(
                    "exactFormulaReplayVerified"
                ),
                "selectedCandidates": [
                    fold.get("selected")
                    for fold in (protocol or {}).get("folds") or []
                ],
                "candidateRegistry": (protocol or {}).get(
                    "candidateRegistry"
                ),
                "outputTransform": (protocol or {}).get(
                    "outputTransform",
                ),
                "outputBounds": (protocol or {}).get("outputBounds"),
                "metrics": (protocol or {}).get("metrics"),
            }
            for key, protocol in (
                visual_keep_study.get("protocols") or {}
            ).items()
        },
        "evidenceCompatibility": visual_keep_evidence_status,
        "promotion": visual_keep_study.get("promotion"),
        "producer": "buildings/jarvis/predictor-lab/run_predictor_lab.py",
        "producerSourceSha256": provenance["producerSourceSha256"],
        "featureContractVersion": provenance["featureContractVersion"],
        "featureContractSha256": provenance["featureContractSha256"],
        "sourceArtifacts": provenance["sourceArtifacts"],
    }
    require_current_visual_keep_artifact(visual_keep_model)
    visual_keep_model_bytes = json.dumps(
        visual_keep_model,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    visual_keep_model_sha256 = hashlib.sha256(
        visual_keep_model_bytes
    ).hexdigest()
    visual_keep_model_archive_key = (
        "raw/predictor-lab/visual-keep-model/by-sha256/"
        f"{visual_keep_model_sha256}.json"
    )
    visual_keep_model_manifest = {
        "schemaVersion": 1,
        "coordinateId": VISUAL_KEEP_COORDINATE_ID,
        "artifactSha256": visual_keep_model_sha256,
        "canonicalKey": R2_VISUAL_KEEP_MODEL_KEY,
        "archiveKey": visual_keep_model_archive_key,
        "producer": visual_keep_model["producer"],
        "producerSourceSha256": provenance["producerSourceSha256"],
        "featureContractVersion": provenance["featureContractVersion"],
        "featureContractSha256": provenance["featureContractSha256"],
        "generatedAt": result_generated_at,
        "fitPopulation": visual_keep_model["fitPopulation"],
    }
    visual_keep_study["modelArtifact"] = {
        "artifactSha256": visual_keep_model_sha256,
        "canonicalKey": R2_VISUAL_KEEP_MODEL_KEY,
        "archiveKey": visual_keep_model_archive_key,
        "manifestKey": R2_VISUAL_KEEP_MODEL_MANIFEST_KEY,
        "producerSourceSha256": provenance["producerSourceSha256"],
        "generatedAt": result_generated_at,
    }
    provenance["visualKeepModelArtifact"] = dict(
        visual_keep_study["modelArtifact"]
    )
    creator_adaptive_study = keep.get("creatorAdaptiveStudy") or {}
    selected_creator_spec = (
        creator_adaptive_study.get("selection") or {}
    ).get("selected")
    if not (
        isinstance(selected_creator_spec, dict)
        and selected_creator_spec.get("benchmarkId")
        == CREATOR_ADAPTIVE_KEEP_V1_SPEC["benchmarkId"]
        and selected_creator_spec.get("modalityClass")
        == "multimodal"
        and (
            creator_adaptive_study.get("selection") or {}
        ).get("candidateCount")
        == CREATOR_ADAPTIVE_KEEP_V1_SPEC["candidateCount"]
        and (
            creator_adaptive_study.get("selection") or {}
        ).get("candidateRegistrySha256")
        == CREATOR_ADAPTIVE_KEEP_V1_SPEC[
            "candidateRegistrySha256"
        ]
    ):
        raise RuntimeError(
            f"{CREATOR_ADAPTIVE_KEEP_COORDINATE_ID} is locked to "
            f"{CREATOR_ADAPTIVE_KEEP_V1_SPEC}; candidate selection produced "
            f"{selected_creator_spec}. Publish a new coordinate version "
            "instead of changing v1 in place."
        )
    creator_adaptive_keep_model = {
        "schemaVersion": CREATOR_ADAPTIVE_KEEP_SCHEMA_VERSION,
        "coordinateId": CREATOR_ADAPTIVE_KEEP_COORDINATE_ID,
        "generatedAt": result_generated_at,
        "status": creator_adaptive_study.get("status"),
        "input": creator_adaptive_study.get("input"),
        "valueDefinition": creator_adaptive_study.get("valueDefinition"),
        "population": creator_adaptive_study.get("population"),
        "selection": {
            "protocol": (
                creator_adaptive_study.get("selection") or {}
            ).get("protocol"),
            "candidateCount": (
                creator_adaptive_study.get("selection") or {}
            ).get("candidateCount"),
            "candidateRegistrySha256": (
                creator_adaptive_study.get("selection") or {}
            ).get("candidateRegistrySha256"),
            "candidateCountWithAllAccounts": (
                creator_adaptive_study.get("selection") or {}
            ).get("candidateCountWithAllAccounts"),
            "selected": (
                creator_adaptive_study.get("selection") or {}
            ).get("selected"),
        },
        "evaluation": creator_adaptive_study.get("evaluation"),
        "batchFreezeStress": creator_adaptive_study.get(
            "batchFreezeStress"
        ),
        "ablations": creator_adaptive_study.get("ablations"),
        "rollingBlockStability": creator_adaptive_study.get(
            "rollingBlockStability"
        ),
        "equalTimestampAudit": creator_adaptive_study.get(
            "equalTimestampAudit"
        ),
        "labelAudit": creator_adaptive_study.get("labelAudit"),
        "benchmark": creator_adaptive_study.get("benchmark"),
        "formula": creator_adaptive_study.get("formula"),
        "producer": "buildings/jarvis/predictor-lab/run_predictor_lab.py",
        "producerSourceSha256": provenance["producerSourceSha256"],
        "featureContractVersion": provenance["featureContractVersion"],
        "featureContractSha256": provenance["featureContractSha256"],
        "sourceArtifacts": provenance["sourceArtifacts"],
    }
    creator_adaptive_keep_model_bytes = json.dumps(
        creator_adaptive_keep_model,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    creator_adaptive_keep_model_sha256 = hashlib.sha256(
        creator_adaptive_keep_model_bytes
    ).hexdigest()
    creator_adaptive_keep_model_archive_key = (
        "raw/predictor-lab/creator-adaptive-keep-model/by-sha256/"
        f"{creator_adaptive_keep_model_sha256}.json"
    )
    creator_adaptive_keep_model_manifest = {
        "schemaVersion": CREATOR_ADAPTIVE_KEEP_SCHEMA_VERSION,
        "coordinateId": CREATOR_ADAPTIVE_KEEP_COORDINATE_ID,
        "artifactSha256": creator_adaptive_keep_model_sha256,
        "canonicalKey": R2_CREATOR_ADAPTIVE_KEEP_MODEL_KEY,
        "archiveKey": creator_adaptive_keep_model_archive_key,
        "producer": creator_adaptive_keep_model["producer"],
        "producerSourceSha256": provenance["producerSourceSha256"],
        "featureContractVersion": provenance["featureContractVersion"],
        "featureContractSha256": provenance["featureContractSha256"],
        "generatedAt": result_generated_at,
        "profiles": sorted(
            (
                creator_adaptive_keep_model.get("formula") or {}
            ).get("accounts") or {}
        ),
    }
    creator_adaptive_study["modelArtifact"] = {
        "artifactSha256": creator_adaptive_keep_model_sha256,
        "canonicalKey": R2_CREATOR_ADAPTIVE_KEEP_MODEL_KEY,
        "archiveKey": creator_adaptive_keep_model_archive_key,
        "manifestKey": R2_CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY,
        "producerSourceSha256": provenance["producerSourceSha256"],
        "generatedAt": result_generated_at,
    }
    provenance["creatorAdaptiveKeepModelArtifact"] = dict(
        creator_adaptive_study["modelArtifact"]
    )
    coverage = coverage_payload(stores, library, private_rows, saved_rows)
    artifact_complete = bool(
        corpus is not None
        and int(coverage.get("remainingVisual") or 0) == 0
        and int((coverage.get("embedded") or {}).get("together") or 0)
        >= int(coverage.get("scienceCenterStoredShorts") or 0)
    )
    result = {
        "version": PREDICTOR_RESULT_SCHEMA_VERSION,
        "generatedAt": result_generated_at,
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
            "Views validation uses only freshly rebuilt views, outlier, and 10M axes with complete fit-row manifests; stored keep, ret5, realviews, and unproven novelty-view axes are diagnostic only.",
            "Internal account and saved-channel IDs are never treated as YouTube channel IDs; every private keep account must resolve through explicit YouTube metadata or exact video-ID lineage before a whole-creator claim can pass.",
            "Title-only duplicate families are weak diagnostics. A leakage-passed result requires explicit source/content lineage or an exact canonical montage SHA for every evaluated row.",
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
                "input": "saved-channel keep, ret5, and realviews coordinates in the views predictor",
                "reason": "their upstream axes use private outcomes and are not valid held-out inputs for public-view validation",
            },
            {
                "input": "saved novelty.views coordinate in the views predictor",
                "reason": "its upstream fit population is not materialized with enough lineage to prove evaluation-row and creator disjointness; it remains diagnostic",
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
    artifact_bytes = json.dumps(
        result,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    artifact_sha256 = hashlib.sha256(artifact_bytes).hexdigest()
    archive_key = f"raw/predictor-lab/by-sha256/{artifact_sha256}.json"
    artifact_manifest = {
        "schemaVersion": 1,
        "resultSchemaVersion": PREDICTOR_RESULT_SCHEMA_VERSION,
        "artifactSha256": artifact_sha256,
        "canonicalKey": R2_RESULT_KEY,
        "archiveKey": archive_key,
        "producer": "buildings/jarvis/predictor-lab/run_predictor_lab.py",
        "producerSourceSha256": provenance["producerSourceSha256"],
        "generatedAt": result["generatedAt"],
        "featureContractVersion": provenance["featureContractVersion"],
        "featureContractSha256": provenance["featureContractSha256"],
        "runtime": provenance["runtime"],
        "sourceArtifacts": provenance["sourceArtifacts"],
    }
    visual_keep_manifest_bytes = json.dumps(
        visual_keep_model_manifest,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    creator_adaptive_manifest_bytes = json.dumps(
        creator_adaptive_keep_model_manifest,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    artifact_manifest_bytes = json.dumps(
        artifact_manifest,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    visual_keep_manifest_archive_key = (
        "raw/predictor-lab/visual-keep-model/by-sha256/"
        f"{visual_keep_model_sha256}.manifest.json"
    )
    creator_adaptive_manifest_archive_key = (
        "raw/predictor-lab/creator-adaptive-keep-model/by-sha256/"
        f"{creator_adaptive_keep_model_sha256}.manifest.json"
    )
    artifact_manifest_archive_key = (
        f"raw/predictor-lab/by-sha256/{artifact_sha256}.manifest.json"
    )
    release_manifest = {
        "schemaVersion": 1,
        "resultSchemaVersion": PREDICTOR_RESULT_SCHEMA_VERSION,
        "generatedAt": result["generatedAt"],
        "featureContractVersion": provenance["featureContractVersion"],
        "featureContractSha256": provenance["featureContractSha256"],
        "producerSourceSha256": provenance["producerSourceSha256"],
        "predictor": {
            "artifactSha256": artifact_sha256,
            "artifactKey": archive_key,
            "manifestKey": artifact_manifest_archive_key,
            "manifestSha256": hashlib.sha256(
                artifact_manifest_bytes
            ).hexdigest(),
        },
        "visualKeepModel": {
            "artifactSha256": visual_keep_model_sha256,
            "artifactKey": visual_keep_model_archive_key,
            "manifestKey": visual_keep_manifest_archive_key,
            "manifestSha256": hashlib.sha256(
                visual_keep_manifest_bytes
            ).hexdigest(),
        },
        "creatorAdaptiveKeepModel": {
            "artifactSha256": creator_adaptive_keep_model_sha256,
            "artifactKey": creator_adaptive_keep_model_archive_key,
            "manifestKey": creator_adaptive_manifest_archive_key,
            "manifestSha256": hashlib.sha256(
                creator_adaptive_manifest_bytes
            ).hexdigest(),
        },
    }
    verify_local_sources_unchanged()
    LOCAL_RESULT.write_bytes(artifact_bytes)
    LOCAL_VISUAL_KEEP_MODEL.write_bytes(visual_keep_model_bytes)
    LOCAL_CREATOR_ADAPTIVE_KEEP_MODEL.write_bytes(
        creator_adaptive_keep_model_bytes
    )
    if not args.local_only:
        put_bytes(
            visual_keep_model_archive_key,
            visual_keep_model_bytes,
            "application/json",
        )
        put_bytes(
            visual_keep_manifest_archive_key,
            visual_keep_manifest_bytes,
            "application/json",
        )
        put_bytes(
            creator_adaptive_keep_model_archive_key,
            creator_adaptive_keep_model_bytes,
            "application/json",
        )
        put_bytes(
            creator_adaptive_manifest_archive_key,
            creator_adaptive_manifest_bytes,
            "application/json",
        )
        put_bytes(archive_key, artifact_bytes, "application/json")
        put_bytes(
            artifact_manifest_archive_key,
            artifact_manifest_bytes,
            "application/json",
        )
        put_bytes(R2_RESULT_KEY, artifact_bytes, "application/json")
        put_json(R2_RESULT_MANIFEST_KEY, artifact_manifest)
        put_bytes(
            R2_VISUAL_KEEP_MODEL_KEY,
            visual_keep_model_bytes,
            "application/json",
        )
        put_bytes(
            R2_CREATOR_ADAPTIVE_KEEP_MODEL_KEY,
            creator_adaptive_keep_model_bytes,
            "application/json",
        )
        # This manifest is the release pointer. Publish it only after every
        # immutable model/result object and canonical compatibility artifact.
        put_json(
            R2_VISUAL_KEEP_MODEL_MANIFEST_KEY,
            visual_keep_model_manifest,
        )
        put_json(
            R2_CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY,
            creator_adaptive_keep_model_manifest,
        )
        # One atomic release pointer pins the exact immutable result and both
        # model revisions. Consumers read this last-written object first.
        put_json(R2_RELEASE_KEY, release_manifest)
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
