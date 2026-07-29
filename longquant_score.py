#!/usr/bin/env python3
"""
Score one long-form thumbnail/title candidate against raw-long.

Long Quant is different from the Shorts hook scorer: the object is a thumbnail
plus title, so the comparable Gemini channels are:
  visual   = thumbnail image
  text     = video idea/title
  together = thumbnail + video idea/title

The raw-long maps contain projections and per-video outcomes, not a single
deployable model bundle for every metric. For uploads and live generated
thumbnails, we place the new embedding into the raw-long manifold by nearest
neighbors, then estimate each metric from those neighbors. The primary score
is always the frozen image-only ctrviews ladder used to train the generators.
Text and together channels are diagnostics and never replace that score.
"""
import argparse
import base64
import gc
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import time
import urllib.request
import zipfile
import platform

import boto3
import numpy as np

try:
    import requests
except Exception:
    requests = None

HERE = os.path.dirname(os.path.abspath(__file__))
DIM = 1536
EMB_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent"
CHANS = ("visual", "text", "together")
REL_FLOOR = 0.35
# Exact p10 real-real nearest-neighbor cosine produced by harness_long.py's
# deterministic density calibration over the frozen raw-long visual corpus.
DENSITY_FLOOR = 0.7598260641098022
PROVENANCE_SCHEMA_VERSION = 2
QUERY_FINGERPRINT_GENERATION = "longquant-query-input-v2"
NEIGHBOR_ALGORITHM_GENERATION = "longquant-neighbor-map-v2"
DIRECT_ALGORITHM_GENERATION = "longquant-frozen-visual-ctrviews-v1"
try:
    SCORER_SOURCE_SHA256 = hashlib.sha256(open(__file__, "rb").read()).hexdigest()
except Exception:
    SCORER_SOURCE_SHA256 = None


def env(k):
    v = os.environ.get(k)
    if v:
        return v
    try:
        for ln in open(os.path.join(HERE, ".env")):
            if ln.strip().startswith(k + "="):
                return ln.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return None


KEY = env("GEMINI_API_KEY")
BUCKET = env("R2_BUCKET_NAME") or "business-world-videos"
s3 = boto3.client(
    "s3",
    endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
    aws_access_key_id=env("R2_ACCESS_KEY_ID"),
    aws_secret_access_key=env("R2_SECRET_ACCESS_KEY"),
    region_name="auto",
)


def r2_get(key):
    try:
        return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    except Exception:
        return None


def canonical_json_bytes(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf8")


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def normalize_etag(value):
    return str(value or "").strip().strip('"') or None


def object_revision(key):
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
    except Exception:
        return {
            "key": key,
            "etag": None,
            "version_id": None,
            "content_length": None,
        }
    return {
        "key": key,
        "etag": normalize_etag(head.get("ETag")),
        "version_id": str(head.get("VersionId") or "") or None,
        "content_length": int(head["ContentLength"]) if head.get("ContentLength") is not None else None,
    }


def id_population(values):
    ids = [
        value.decode("utf8", "replace") if isinstance(value, bytes) else str(value)
        for value in values
    ]
    unique = set(ids)
    return {
        "row_count": len(ids),
        "unique_video_id_count": len(unique),
        "duplicate_video_id_count": len(ids) - len(unique),
        "video_id_sha256": sha256_bytes("\n".join(sorted(unique)).encode("utf8")),
        "ordered_video_id_sha256": sha256_bytes(canonical_json_bytes(ids)),
    }


def text_input_revision(value):
    exact_text = str(value or "")
    text_bytes = exact_text.encode("utf8")
    return {
        "present": bool(exact_text),
        "sha256": sha256_bytes(text_bytes),
        "utf8_byte_length": len(text_bytes),
    }


def query_input_manifest(
    image_bytes,
    text,
    text_source="none",
    exact_title=None,
    exact_idea=None,
):
    score_text = str(text or "")
    if exact_title is None and exact_idea is None:
        exact_title = score_text if text_source == "title" else ""
        exact_idea = score_text if text_source == "idea" else ""
    fingerprint_payload = {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "thumbnail": {
            "present": image_bytes is not None,
            "sha256": sha256_bytes(image_bytes) if image_bytes is not None else None,
            "byte_length": len(image_bytes) if image_bytes is not None else 0,
        },
        "title": text_input_revision(exact_title),
        "idea": text_input_revision(exact_idea),
        "score_text": text_input_revision(score_text),
        "selected_text_source": text_source,
    }
    return {
        **fingerprint_payload,
        # Compatibility alias for consumers that predate separate title/idea
        # fingerprints. It is always the exact effective scorer text.
        "text": fingerprint_payload["score_text"],
        "generation": QUERY_FINGERPRINT_GENERATION,
        "fingerprint_sha256": sha256_bytes(canonical_json_bytes(fingerprint_payload)),
        "text_source": text_source,
    }


def scorer_runtime_revision():
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "embedding_model": "gemini-embedding-2",
        "embedding_dimensions": DIM,
        "scorer_source_sha256": SCORER_SOURCE_SHA256,
    }


def embed(parts, tries=4):
    if not KEY:
        raise RuntimeError("GEMINI_API_KEY not set")
    body = {"content": {"parts": parts}, "outputDimensionality": DIM}
    last = ""
    for a in range(tries):
        try:
            if requests is not None:
                r = requests.post(
                    EMB_URL,
                    headers={"Content-Type": "application/json", "x-goog-api-key": KEY},
                    json=body,
                    timeout=35,
                )
                if r.ok:
                    return np.asarray(r.json()["embedding"]["values"], np.float32)
                last = f"http {r.status_code}: {r.text[:120]}"
            else:
                req = urllib.request.Request(
                    EMB_URL,
                    data=json.dumps(body).encode(),
                    method="POST",
                    headers={"Content-Type": "application/json", "x-goog-api-key": KEY},
                )
                with urllib.request.urlopen(req, timeout=35) as r:
                    return np.asarray(json.loads(r.read())["embedding"]["values"], np.float32)
        except Exception as e:
            last = str(e)[:160]
        if a < tries - 1:
            time.sleep(1.2 * (a + 1))
    raise RuntimeError("Gemini embed failed: " + last)


def img_part(b64):
    return {"inlineData": {"mimeType": "image/jpeg", "data": b64}}


def norm(v):
    v = np.asarray(v, np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


def preview(e):
    if e is None:
        return None
    a = np.asarray(e, float)
    if len(a) >= 1536:
        a = a[:1536].reshape(48, 32).mean(1)
    return [round(float(x), 3) for x in a[:64]]


def cache_tag(etag):
    return re.sub(r"[^a-zA-Z0-9_-]+", "", str(etag or "noetag"))[:80] or "noetag"


def download_file(key, path):
    tmp = path + ".tmp"
    try:
        os.remove(tmp)
    except Exception:
        pass
    s3.download_file(BUCKET, key, tmp)
    os.replace(tmp, path)


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def stable_download(key, path, attempts=3):
    last_revision = object_revision(key)
    for _ in range(attempts):
        before = object_revision(key)
        download_file(key, path)
        after = object_revision(key)
        before_etag = before.get("etag")
        after_etag = after.get("etag")
        if before_etag and after_etag and before_etag != after_etag:
            try:
                os.remove(path)
            except Exception:
                pass
            last_revision = after
            continue
        revision = after if after_etag else before
        revision = {
            **revision,
            "sha256": file_sha256(path),
        }
        return revision
    raise RuntimeError(
        f"{key} changed revision while it was being downloaded "
        f"(latest ETag {last_revision.get('etag') or 'unavailable'})"
    )


def cache_arrays_with_revision(chan, names=("vecs",)):
    """Return row-aligned arrays from one immutable raw-long archive revision.

    The map is published separately and can briefly lead or lag the archive.
    Any model that needs labels must therefore read vectors, IDs, and labels
    from the same NPZ object instead of joining by row position against map.json.
    """
    cdir = tempfile.gettempdir()
    key = f"raw-long/{chan}/embeddings.npz"
    head = object_revision(key)
    tag = cache_tag(head.get("etag"))
    requested = tuple(dict.fromkeys(str(name) for name in names))
    if not requested:
        return {}, {
            **head,
            "sha256": None,
            "immutable_key": None,
            "video_id_population": None,
        }
    paths = {
        name: os.path.join(cdir, f"rawlong_{chan}_{tag}_{name}.npy")
        for name in requested
    }
    metadata_path = os.path.join(cdir, f"rawlong_{chan}_{tag}_archive-revision.json")
    missing = [name for name, path in paths.items() if not os.path.exists(path)]
    revision = None
    if os.path.exists(metadata_path):
        try:
            revision = json.load(open(metadata_path))
        except Exception:
            revision = None
    revision_matches = bool(
        revision
        and revision.get("sha256")
        and (
            not head.get("etag")
            or revision.get("etag") == head.get("etag")
        )
    )
    if missing or not revision_matches:
        npz = os.path.join(cdir, f"rawlong_{chan}_{tag}.npz")
        revision = stable_download(key, npz)
        if head.get("etag") and revision.get("etag") and head["etag"] != revision["etag"]:
            try:
                os.remove(npz)
            except Exception:
                pass
            return cache_arrays_with_revision(chan, names)
        if not head.get("etag"):
            missing = list(requested)
            for path in paths.values():
                try:
                    os.remove(path)
                except Exception:
                    pass
        with zipfile.ZipFile(npz) as zf:
            members = zf.namelist()
            for name in missing:
                expected = f"{name}.npy"
                member = expected if expected in members else next(
                    (item for item in members if item.endswith("/" + expected)), None,
                )
                if not member:
                    raise RuntimeError(
                        f"raw-long/{chan}/embeddings.npz missing {expected}"
                    )
                tmp = paths[name] + ".tmp"
                with zf.open(member) as src, open(tmp, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                os.replace(tmp, paths[name])
        revision["immutable_key"] = (
            f"raw-long/{chan}/embeddings/by-sha256/{revision['sha256']}.npz"
        )
        revision["provenance_schema_version"] = PROVENANCE_SCHEMA_VERSION
        with open(metadata_path + ".tmp", "w", encoding="utf8") as handle:
            json.dump(revision, handle, sort_keys=True, separators=(",", ":"))
        os.replace(metadata_path + ".tmp", metadata_path)
        try:
            os.remove(npz)
        except Exception:
            pass
    arrays = {}
    for name, path in paths.items():
        if name == "ids":
            # Historical raw-long bundles store only this small string array as
            # dtype=object. Numeric model inputs remain non-pickle memmaps.
            arrays[name] = np.load(path, allow_pickle=True)
        else:
            arrays[name] = np.load(path, mmap_mode="r", allow_pickle=False)
    lengths = {name: len(value) for name, value in arrays.items()}
    if len(set(lengths.values())) != 1:
        raise RuntimeError(
            f"raw-long/{chan}/embeddings.npz row mismatch: {lengths}"
        )
    revision = dict(revision or {})
    if "ids" in arrays:
        revision["video_id_population"] = id_population(arrays["ids"])
    return arrays, revision


def cache_arrays(chan, names=("vecs",)):
    return cache_arrays_with_revision(chan, names)[0]


def cache_vecs(chan):
    return cache_arrays(chan, ("vecs",))["vecs"]


def map_dataset_lineage(container):
    if not isinstance(container, dict):
        return None
    explicit = container.get("dataset_lineage")
    if explicit:
        return explicit
    lineage = {
        "account_metric_private_fit_populations": container.get(
            "account_metric_private_fit_populations"
        ),
        "label_snapshot_revisions": container.get("label_snapshot_revisions"),
        "source_database_revision": container.get("source_database_revision"),
        "channels_registry_revision": container.get("channels_registry_revision"),
        "frozen_visual_ctrviews_lineage": container.get(
            "frozen_visual_ctrviews_lineage"
        ),
    }
    return lineage if any(value is not None for value in lineage.values()) else None


def load_map_with_revision(chan):
    cdir = tempfile.gettempdir()
    key = f"raw-long/{chan}/map.json"
    head = object_revision(key)
    path = os.path.join(cdir, f"rawlong_{chan}_{cache_tag(head.get('etag'))}_map.json")
    if not os.path.exists(path):
        revision = stable_download(key, path)
    else:
        revision = {
            **head,
            "sha256": file_sha256(path),
        }
    try:
        with open(path, "r", encoding="utf8") as handle:
            mapping = json.load(handle)
    except Exception:
        body = r2_get(key)
        mapping = json.loads(body.decode("utf8")) if body else {}
        revision = {
            **object_revision(key),
            "sha256": sha256_bytes(body) if body else None,
        }
    revision["immutable_key"] = (
        f"raw-long/{chan}/maps/by-sha256/{revision['sha256']}.json"
        if revision.get("sha256") else None
    )
    revision["provenance_schema_version"] = PROVENANCE_SCHEMA_VERSION
    revision["video_id_population"] = id_population(mapping.get("id") or [])
    generation = mapping.get("_provenance") or {}
    revision["generation_id"] = generation.get("generation_id")
    revision["algorithm_generation"] = generation.get("algorithm_generation")
    revision["manifest_key"] = generation.get("manifest_key")
    revision["published_embedding_archive"] = generation.get("embedding_archive")
    revision["published_alignment_population"] = generation.get("video_id_alignment_population")
    revision["published_model_artifact"] = generation.get("model_artifact")
    revision["published_dataset_lineage"] = map_dataset_lineage(generation)
    revision["published_runtime_revision"] = generation.get("runtime_revision")
    manifest_key = revision.get("manifest_key")
    if manifest_key:
        manifest_bytes = r2_get(manifest_key)
        try:
            manifest = json.loads(manifest_bytes.decode("utf8")) if manifest_bytes else None
        except Exception:
            manifest = None
        manifest_map_sha256 = (
            (manifest or {}).get("map_artifact", {}).get("sha256")
        )
        revision["generation_manifest"] = {
            **object_revision(manifest_key),
            "pointer_sha256": sha256_bytes(manifest_bytes) if manifest_bytes else None,
            "manifest_sha256": (manifest or {}).get("manifest_sha256"),
            "immutable_manifest_key": (manifest or {}).get("immutable_manifest_key"),
            "generation_id": (manifest or {}).get("generation_id"),
            "map_sha256": manifest_map_sha256,
            "map_artifact": (manifest or {}).get("map_artifact"),
            "embedding_archive": (manifest or {}).get("embedding_archive"),
            "model_artifact": (manifest or {}).get("model_artifact"),
            "dataset_lineage": map_dataset_lineage(manifest),
            "runtime_revision": (manifest or {}).get("runtime_revision"),
            "matches_loaded_map": (
                manifest_map_sha256 == revision.get("sha256")
                if manifest_map_sha256 and revision.get("sha256")
                else None
            ),
        }
    else:
        revision["generation_manifest"] = None
    return mapping, revision


def load_map(chan):
    return load_map_with_revision(chan)[0]


def rank_pct(vals, x):
    vals = np.asarray([v for v in vals if v is not None and np.isfinite(v)], float)
    if not len(vals) or x is None or not np.isfinite(x):
        return None
    return round(100.0 * float(np.searchsorted(np.sort(vals), x)) / max(1, len(vals) - 1), 1)


def wavg(vals, idx, w):
    arr = []
    ww = []
    for i, wi in zip(idx, w):
        try:
            v = vals[int(i)]
        except Exception:
            continue
        if v is None:
            continue
        try:
            v = float(v)
        except Exception:
            continue
        if np.isfinite(v):
            arr.append(v)
            ww.append(float(wi))
    if not arr:
        return None
    return float(np.average(arr, weights=np.asarray(ww) + 1e-9))


def top_neighbors(chan, q, k=24):
    arrays, archive_revision = cache_arrays_with_revision(chan, ("vecs", "ids"))
    V = arrays["vecs"]
    ids = [
        value.decode("utf8", "replace") if isinstance(value, bytes) else str(value)
        for value in arrays["ids"]
    ]
    if V is None or not len(V):
        return None, None, None, None
    q = norm(q).astype(np.float32)
    sims = np.empty(len(V), np.float32)
    step = max(256, int(os.environ.get("LONGQUANT_SCORE_CHUNK", "2048") or "2048"))
    for i in range(0, len(V), step):
        B = np.asarray(V[i:i + step], np.float32)
        sims[i:i + len(B)] = (B @ q) / (np.linalg.norm(B, axis=1) + 1e-9)
    kk = min(k, len(V))
    part = np.argpartition(-sims, kk - 1)[:kk]
    order = part[np.argsort(-sims[part])]
    weights = np.maximum(sims[order], 0) ** 8 + 1e-6
    archive_revision = {
        **archive_revision,
        "_video_ids": ids,
    }
    return (
        order,
        sims[order],
        weights,
        [ids[int(index)] for index in order],
        archive_revision,
    )


def metric_obj(est, pctile=None, kind="neighbor"):
    if est is None:
        return None
    est = float(est)
    val = round(est, 4) if abs(est) < 100 else round(est)
    return {"est": val, "pctile": pctile, "kind": kind}


def video_id_alignment_population(archive_ids, map_ids, selected_ids, matched_ids):
    archive_ids = [str(value) for value in archive_ids]
    map_ids = [str(value) for value in map_ids]
    archive_set = set(archive_ids)
    map_set = set(map_ids)
    intersection = [video_id for video_id in map_ids if video_id in archive_set]
    map_only = [video_id for video_id in map_ids if video_id not in archive_set]
    archive_only = [video_id for video_id in archive_ids if video_id not in map_set]
    return {
        "method": "exact_video_id",
        "embedding_archive": id_population(archive_ids),
        "map": id_population(map_ids),
        "intersection": id_population(intersection),
        "map_only": id_population(map_only),
        "embedding_archive_only": id_population(archive_only),
        "selected_archive_neighbors": id_population(selected_ids),
        "selected_map_aligned_neighbors": id_population(matched_ids),
    }


def neighbor_metric_provenance(
    chan,
    metric_name,
    metric,
    archive_revision,
    map_revision,
    alignment_population,
    query_input,
):
    map_generation = map_revision.get("algorithm_generation")
    if not map_generation:
        map_generation = {
            "id": "legacy-map-generation-unrecorded",
            "status": "explicitly unavailable in the loaded historical map",
        }
    dataset_lineage = map_revision.get("published_dataset_lineage")
    if not dataset_lineage:
        dataset_lineage = (
            (map_revision.get("generation_manifest") or {}).get("dataset_lineage")
        )
    projection_key = metric.get("projection")
    if not projection_key and metric_name in ("views", "gt10m"):
        projection_key = "map.views"
    elif not projection_key and metric_name == "scaled_views":
        projection_key = "map.outlier"
    metric_dataset_lineage = None
    if dataset_lineage:
        metric_dataset_lineage = (
            (dataset_lineage.get("projection_fits") or {}).get(projection_key)
            or (dataset_lineage.get("map_outcome_populations") or {}).get(projection_key)
        )
        if metric_dataset_lineage is None and projection_key:
            metric_base, separator, account = projection_key.partition("__")
            if not separator:
                account = "tyler"
            metric_dataset_lineage = (
                (
                    (
                        dataset_lineage.get(
                            "account_metric_private_fit_populations"
                        ) or {}
                    ).get(account) or {}
                ).get("metrics") or {}
            ).get(metric_base)
    return {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "coordinate": f"long.output.{chan}.{metric_name}",
        "query_input": query_input,
        "embedding_archive_revision": archive_revision,
        "map_revision": map_revision,
        "video_id_alignment_population": alignment_population,
        "dataset_lineage": dataset_lineage,
        "metric_dataset_lineage": metric_dataset_lineage,
        "runtime_revision": {
            "scorer": scorer_runtime_revision(),
            "map_publisher": map_revision.get("published_runtime_revision")
            or (
                (map_revision.get("generation_manifest") or {})
                .get("runtime_revision")
            ),
        },
        "algorithm_generation": {
            "scorer": NEIGHBOR_ALGORITHM_GENERATION,
            "scorer_source_sha256": SCORER_SOURCE_SHA256,
            "map": map_generation,
            "neighbor_limit": 24,
            "weighting": "max(cosine_similarity, 0)^8 + 1e-6",
            "metric_resolution": metric.get("kind"),
            "projection": metric.get("projection") or metric.get("kind"),
        },
    }


def channel_score(chan, emb, query_input=None):
    neighbor_result = top_neighbors(chan, emb)
    archive_idx, sims, weights, neighbor_ids = neighbor_result[:4]
    archive_revision = dict(neighbor_result[4]) if len(neighbor_result) > 4 else {}
    if archive_idx is None:
        return None
    mp, map_revision = load_map_with_revision(chan)
    ids = mp.get("id") or []
    titles = mp.get("title") or []
    views = mp.get("views") or []
    outlier = mp.get("outlier") or []
    proj = mp.get("proj") or {}
    map_index = {str(video_id): index for index, video_id in enumerate(ids)}
    aligned = [
        (map_index[video_id], float(similarity), float(weight))
        for video_id, similarity, weight in zip(neighbor_ids, sims, weights)
        if video_id in map_index
    ]
    if not aligned:
        raise RuntimeError(
            f"raw-long/{chan} map and embedding archive share no nearest-neighbor video IDs"
        )
    idx = np.asarray([item[0] for item in aligned], dtype=int)
    sims = np.asarray([item[1] for item in aligned], dtype=np.float32)
    weights = np.asarray([item[2] for item in aligned], dtype=np.float32)
    matched_neighbor_ids = [str(ids[int(index)]) for index in idx]
    archive_ids = archive_revision.pop("_video_ids", neighbor_ids)
    alignment_population = video_id_alignment_population(
        archive_ids,
        ids,
        neighbor_ids,
        matched_neighbor_ids,
    )
    archive_revision = {
        **archive_revision,
        "video_id_population": archive_revision.get("video_id_population")
        or id_population(archive_ids),
    }
    published_archive = map_revision.get("published_embedding_archive") or {}
    if (
        archive_revision.get("sha256")
        and archive_revision.get("sha256") == published_archive.get("sha256")
    ):
        archive_revision["immutable_etag"] = published_archive.get("immutable_etag")
        archive_revision["published_generation_id"] = map_revision.get("generation_id")
    alignment_population["published_generation_match"] = {
        "embedding_sha256": (
            archive_revision.get("sha256") == published_archive.get("sha256")
            if archive_revision.get("sha256") and published_archive.get("sha256")
            else None
        ),
        "embedding_etag": (
            archive_revision.get("etag") == published_archive.get("mutable_etag")
            if archive_revision.get("etag") and published_archive.get("mutable_etag")
            else None
        ),
        "intersection_video_id_sha256": (
            alignment_population["intersection"]["video_id_sha256"]
            == (
                (map_revision.get("published_alignment_population") or {})
                .get("intersection", {})
                .get("video_id_sha256")
            )
            if (
                (map_revision.get("published_alignment_population") or {})
                .get("intersection", {})
                .get("video_id_sha256")
            )
            else None
        ),
    }
    metrics = {}

    def from_proj(name, aliases=()):
        for key in (name,) + tuple(aliases):
            p = proj.get(key)
            if isinstance(p, dict) and isinstance(p.get("est"), list):
                est = wavg(p["est"], idx, weights)
                return metric_obj(est, rank_pct(p["est"], est), key)
        return None

    def from_axis(name, aliases=()):
        """Place a new embedding on a stored projection when it has geometry but no scalar estimate."""
        for key in (name,) + tuple(aliases):
            p = proj.get(key)
            if not isinstance(p, dict) or not isinstance(p.get("x"), list):
                continue
            axis_x = wavg(p["x"], idx, weights)
            if axis_x is None:
                continue
            return {
                "est": None,
                "pctile": rank_pct(p["x"], axis_x),
                "kind": "neighbor_axis_percentile",
                "axis_x": round(float(axis_x), 2),
                "projection": key,
            }
        return None

    metrics["ctr"] = from_proj("ctr") or from_axis("ctr")
    metrics["ret30"] = from_proj("ret30", ("retention",)) or from_axis("ret30", ("retention",))
    metrics["realviews"] = from_proj("realviews") or from_axis("realviews")
    metrics["ctrviews"] = from_proj("ctrviews") or from_axis("ctrviews")

    vest = wavg(views, idx, weights)
    metrics["views"] = metric_obj(vest, rank_pct(views, vest), "neighbor_views")
    oest = wavg(outlier, idx, weights)
    metrics["scaled_views"] = metric_obj(oest, rank_pct(outlier, oest), "neighbor_outlier")

    gt = []
    for v in views:
        try:
            gt.append(1.0 if float(v) > 10_000_000 else 0.0)
        except Exception:
            gt.append(None)
    p10 = wavg(gt, idx, weights)
    metrics["gt10m"] = metric_obj(p10, round(100.0 * p10, 1) if p10 is not None else None, "neighbor_rate")
    query_input = query_input or query_input_manifest(None, "", "not-supplied")
    for metric_name, metric in metrics.items():
        if metric:
            metric["provenance"] = neighbor_metric_provenance(
                chan,
                metric_name,
                metric,
                archive_revision,
                map_revision,
                alignment_population,
                query_input,
            )

    neighbors = []
    for i, sim in zip(idx[:12], sims[:12]):
        ii = int(i)
        neighbors.append({
            "id": ids[ii] if ii < len(ids) else "",
            "sim": round(float(sim), 4),
            "title": titles[ii] if ii < len(titles) else "",
            "views": views[ii] if ii < len(views) else None,
        })
    return {
        "metrics": metrics,
        "neighbors": neighbors,
        "nn_cos": round(float(sims[0]), 6) if len(sims) else None,
        "alignment": {
            "method": "video_id",
            "archive_neighbors": len(neighbor_ids),
            "map_neighbors": len(idx),
            "population": alignment_population,
        },
        "embedding_archive_revision": archive_revision,
        "map_revision": map_revision,
        "algorithm_generation": NEIGHBOR_ALGORITHM_GENERATION,
        "scorer_source_sha256": SCORER_SOURCE_SHA256,
        "query_input": query_input,
    }


def visual_ctrviews_exact(ev):
    blend = ladder = None
    p90 = None
    artifact_path = None
    artifact_sha256 = None
    artifact_archive_key = None
    lineage_manifest_sha256 = None
    lineage_schema_version = None
    lineage_manifest = None
    built = r2_get("longform/thumb-rl/scorer_visual.npz")
    if built:
        try:
            sc = np.load(io.BytesIO(built), allow_pickle=False)
            blend = np.asarray(sc["blend"], np.float32)
            ladder = np.asarray(sc["ladder"], np.float32)
            p90 = float(np.asarray(sc["p90"]).reshape(-1)[0]) if "p90" in sc.files else None
            artifact_path = "longform/thumb-rl/scorer_visual.npz"
            artifact_sha256 = hashlib.sha256(built).hexdigest()
            if "LINEAGE_JSON" in sc.files:
                artifact_archive_key = f"longform/thumb-rl/by-sha256/{artifact_sha256}.npz"
                lineage_text = str(np.asarray(sc["LINEAGE_JSON"]).reshape(-1)[0])
                lineage_manifest_sha256 = hashlib.sha256(lineage_text.encode()).hexdigest()
                recorded_lineage_sha = (
                    str(np.asarray(sc["LINEAGE_SHA256"]).reshape(-1)[0])
                    if "LINEAGE_SHA256" in sc.files else None
                )
                if recorded_lineage_sha and recorded_lineage_sha != lineage_manifest_sha256:
                    raise RuntimeError("long visual scorer lineage manifest hash mismatch")
                lineage_manifest = json.loads(lineage_text)
                lineage_schema_version = lineage_manifest.get("schemaVersion")
        except RuntimeError:
            raise
        except Exception:
            blend = ladder = None
    if blend is None or ladder is None:
        legacy = r2_get("longform/thumb-rl/scorer_visual.json")
        if not legacy:
            return None
        sc = json.loads(legacy.decode("utf8"))
        blend = np.asarray(sc["blend"], np.float32)
        ladder = np.asarray(sc["ladder"], np.float32)
        p90 = sc.get("p90")
        artifact_path = "longform/thumb-rl/scorer_visual.json"
        artifact_sha256 = hashlib.sha256(legacy).hexdigest()
    artifact_revision = {
        **object_revision(artifact_path),
        "sha256": artifact_sha256,
        "immutable_key": artifact_archive_key,
        "lineage_manifest_sha256": lineage_manifest_sha256,
        "lineage_schema_version": lineage_schema_version,
    }
    populations = (lineage_manifest or {}).get("populations") or {}
    dataset_lineage = {
        "embedding_store_population": populations.get("embeddingStore"),
        "frozen_ctr_fit_population": populations.get("privateCtrFit"),
        "curated_views_fit_population": populations.get("curatedViewsFit"),
        "calibration_ladder_population": populations.get("calibrationLadder"),
        "source_revisions": (lineage_manifest or {}).get("sourceRevisions"),
        "lineage_manifest": lineage_manifest,
        "lineage_manifest_sha256": lineage_manifest_sha256,
    }
    en = norm(ev)
    proj = float(en @ blend)
    pctile = float(np.searchsorted(ladder, proj) / max(1, len(ladder)))
    return {
        "est": round(pctile * 100, 2),
        "pctile": round(pctile * 100, 1),
        "kind": "visual_ctrviews_ladder",
        "proj": round(proj, 4),
        "p90": p90,
        "artifact": artifact_path,
        "artifact_sha256": artifact_sha256,
        "artifact_archive_key": artifact_archive_key,
        "lineage_manifest_sha256": lineage_manifest_sha256,
        "lineage_schema_version": lineage_schema_version,
        "dataset_lineage": dataset_lineage,
        "artifact_revision": artifact_revision,
        "algorithm_generation": DIRECT_ALGORITHM_GENERATION,
    }


def require_visual_ctrviews_exact(ev):
    exact = visual_ctrviews_exact(ev)
    if not exact:
        raise RuntimeError(
            "frozen visual CTR+views scorer artifact is unavailable; "
            "refusing to substitute the neighbor axis"
        )
    return exact


def attach_direct_query_provenance(metric, query_input):
    metric["provenance"] = {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "coordinate": "long.output.visual.ctrviews",
        "query_input": query_input,
        "artifact_revision": metric.get("artifact_revision"),
        "dataset_lineage": metric.get("dataset_lineage"),
        "runtime_revision": {
            "scorer": scorer_runtime_revision(),
            "artifact": (
                (metric.get("dataset_lineage") or {})
                .get("lineage_manifest", {})
                .get("runtime")
            ),
        },
        "algorithm_generation": {
            "scorer": DIRECT_ALGORITHM_GENERATION,
            "scorer_source_sha256": SCORER_SOURCE_SHA256,
            "projection": "L2-normalized visual embedding dot frozen CTR+views blend",
            "calibration": "rank on immutable visual CTR+views ladder",
        },
    }
    return metric


def dataset_runtime_manifest(channels, query_input, direct_metric=None):
    modalities = {}
    for modality, channel in channels.items():
        if not channel:
            continue
        archive_revision = channel.get("embedding_archive_revision")
        map_revision = channel.get("map_revision")
        modalities[modality] = {
            "embedding_archive_revision": archive_revision,
            "embedding_population": (
                (archive_revision or {}).get("video_id_population")
            ),
            "map_revision": map_revision,
            "map_population": (map_revision or {}).get("video_id_population"),
            "video_id_alignment_population": (
                ((channel.get("alignment") or {}).get("population"))
            ),
            "dataset_lineage": (map_revision or {}).get("published_dataset_lineage")
            or (
                ((map_revision or {}).get("generation_manifest") or {})
                .get("dataset_lineage")
            ),
            "algorithm_generation": {
                "scorer": channel.get("algorithm_generation"),
                "map": (map_revision or {}).get("algorithm_generation"),
            },
            "runtime_revision": {
                "scorer": scorer_runtime_revision(),
                "map_publisher": (map_revision or {}).get("published_runtime_revision")
                or (
                    ((map_revision or {}).get("generation_manifest") or {})
                    .get("runtime_revision")
                ),
            },
        }
    return {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "query_input": query_input,
        "query_input_fingerprint": query_input.get("fingerprint_sha256"),
        "modalities": modalities,
        "frozen_visual_ctrviews": {
            "artifact_revision": (direct_metric or {}).get("artifact_revision"),
            "dataset_lineage": (direct_metric or {}).get("dataset_lineage"),
            "algorithm_generation": (direct_metric or {}).get("algorithm_generation"),
        } if direct_metric else None,
        "runtime_revision": scorer_runtime_revision(),
    }


def text_only_score(
    title,
    emb_json,
    text_source="title",
    exact_title=None,
    exact_idea=None,
):
    """Title-only scoring: embed JUST the text and place it in the raw-long TEXT latent space —
    the same corpus, neighbor placement, and metric projections the visual channel uses, so a
    title can be read on every latent projection with no thumbnail involved."""
    et = None
    if emb_json:
        try:
            ej = json.load(open(emb_json))
            cand = np.asarray(ej.get("text") or [], np.float32)
            if cand.size == DIM:
                et = cand
        except Exception:
            et = None
    if et is None:
        et = embed([{"text": title}])
    query_input = query_input_manifest(
        None,
        title,
        text_source,
        exact_title=exact_title,
        exact_idea=exact_idea,
    )
    ch = channel_score("text", et, query_input=query_input)
    channels = {"text": ch}

    def pick(metric):
        m = ((ch or {}).get("metrics") or {}).get(metric)
        return m if m and m.get("pctile") is not None else None

    headline = pick("ctrviews") or pick("views")
    hp = (headline or {}).get("pctile")
    pctile = round(float(hp) / 100.0, 4) if hp is not None and float(hp) > 1 else (hp or 0)
    out = {
        "title": title,
        "pctile": pctile,
        "text_pctile": pctile,
        "primary_channel": "text",
        "nn_cos": (ch or {}).get("nn_cos"),
        "channel_roles": {
            "text": "title text only — every metric comes from the text latent space; no thumbnail was embedded",
        },
        "metrics": {
            "ctr": pick("ctr"),
            "ret30": pick("ret30"),
            "views": pick("views"),
            "scaled_views": pick("scaled_views"),
            "realviews": pick("realviews"),
            "gt10m": pick("gt10m"),
            "ctrviews": pick("ctrviews"),
        },
        "channels": channels,
        "emb_preview": {"visual": None, "text": preview(et), "together": None},
        "input_manifest": {
            "domain": "longquant",
            "scorer": "longquant_score.py --text-only",
            "scorer_sha256": SCORER_SOURCE_SHA256,
            "embedding_model": "gemini-embedding-2",
            "embedding_dimensions": DIM,
            "display_contract_version": 2,
            "score_text": title,
            "score_text_sha256": query_input["text"]["sha256"],
            "score_text_present": query_input["text"]["present"],
            "thumbnail_sha256": query_input["thumbnail"]["sha256"],
            "thumbnail_present": query_input["thumbnail"]["present"],
            "query_input_fingerprint": query_input["fingerprint_sha256"],
            "query_input": query_input,
            "dataset_runtime_revision": dataset_runtime_manifest(
                channels,
                query_input,
            ),
            "display_preference": ["text"],
            "primary_score": "text-channel ctrviews neighbor percentile in the raw-long text latent space",
            "threshold_uses": "text only",
            "note": "Title text embedded on its own — the same corpus and metric projections as the visual maps, but nothing visual was scored. This never feeds the thumbnail threshold.",
            "channels": {
                "visual": {"present": False, "input": "", "image": "", "text": ""},
                "text": {"present": True, "input": "title or idea text only", "image": "", "text": title},
                "together": {"present": False, "input": "", "image": "", "text": ""},
            },
        },
    }
    print(json.dumps(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--idea", default="")
    ap.add_argument("--emb-json", default="")
    ap.add_argument("--text-only", action="store_true")
    args = ap.parse_args()
    exact_title = str(args.title or "")
    exact_idea = str(args.idea or "")
    text_source = "title" if exact_title else ("idea" if exact_idea else "none")
    title = (exact_title or exact_idea).strip()[:500]
    if args.text_only or not args.image:
        if not title:
            print(json.dumps({"error": "no title"}))
            return
        text_only_score(
            title,
            args.emb_json,
            text_source=text_source,
            exact_title=exact_title,
            exact_idea=exact_idea,
        )
        return
    if not os.path.exists(args.image):
        print(json.dumps({"error": "no image"}))
        return
    with open(args.image, "rb") as image_handle:
        image_bytes = image_handle.read()
    b64 = base64.b64encode(image_bytes).decode()
    query_input = query_input_manifest(
        image_bytes,
        title,
        text_source,
        exact_title=exact_title,
        exact_idea=exact_idea,
    )
    if args.emb_json:
        ej = json.load(open(args.emb_json))
        ev = np.asarray(ej.get("visual") or [], np.float32)
        et = np.asarray(ej.get("text") or [], np.float32) if ej.get("text") is not None else None
        eg = np.asarray(ej.get("together") or [], np.float32) if ej.get("together") is not None else None
        if ev.size != DIM:
            raise RuntimeError("bad visual embedding")
        if et is not None and et.size != DIM:
            et = None
        if eg is not None and eg.size != DIM:
            eg = None
    else:
        ev = embed([img_part(b64)])
        et = embed([{"text": title}]) if title else None
        eg = embed([img_part(b64), {"text": title}]) if title else None

    channels = {"visual": channel_score("visual", ev, query_input=query_input)}
    gc.collect()
    if et is not None:
        channels["text"] = channel_score("text", et, query_input=query_input)
        gc.collect()
        channels["together"] = channel_score("together", eg, query_input=query_input)
        gc.collect()

    exact = attach_direct_query_provenance(
        require_visual_ctrviews_exact(ev),
        query_input,
    )
    if channels.get("visual"):
        channels["visual"]["metrics"]["ctrviews"] = exact

    relevance = None
    if et is not None:
        relevance = float(norm(ev) @ norm(et))

    def pick(metric, order=("visual", "together", "text")):
        for c in order:
            m = ((channels.get(c) or {}).get("metrics") or {}).get(metric)
            if m and m.get("pctile") is not None:
                return m
        return None

    # This is the exact generator-training performance axis. A title can be
    # evaluated beside it, but can never suppress or inflate thumbnail potential.
    headline = pick("ctrviews", ("visual",)) or pick("views", ("visual",))
    hp = (headline or {}).get("pctile")
    pctile = round(float(hp) / 100.0, 4) if hp is not None and float(hp) > 1 else (hp or 0)
    visual_nn = (channels.get("visual") or {}).get("nn_cos")
    relevance_penalty = None if relevance is None else max(0.0, REL_FLOOR - relevance) * 2.0
    density_penalty = None if visual_nn is None else max(0.0, DENSITY_FLOOR - float(visual_nn)) * 1.5
    # Idea validation used visual potential plus only the relevance leash.
    idea_model_reward = None if relevance_penalty is None else float(pctile) - relevance_penalty
    # Thumbnail DPO used the same visual potential, relevance leash, and
    # real-thumbnail-manifold density guard.
    thumbnail_model_reward = None
    if idea_model_reward is not None and density_penalty is not None:
        thumbnail_model_reward = idea_model_reward - density_penalty
    reward = thumbnail_model_reward if thumbnail_model_reward is not None else float(pctile)
    input_manifest = {
        "domain": "longquant",
        "scorer": "longquant_score.py",
        "scorer_sha256": SCORER_SOURCE_SHA256,
        "embedding_model": "gemini-embedding-2",
        "embedding_dimensions": DIM,
        "display_contract_version": 2,
        "score_text": title,
        "score_text_sha256": query_input["text"]["sha256"],
        "score_text_present": query_input["text"]["present"],
        "thumbnail_sha256": query_input["thumbnail"]["sha256"],
        "thumbnail_present": query_input["thumbnail"]["present"],
        "query_input_fingerprint": query_input["fingerprint_sha256"],
        "query_input": query_input,
        "dataset_runtime_revision": dataset_runtime_manifest(
            channels,
            query_input,
            exact,
        ),
        "display_preference": ["visual", "together", "text"],
        "primary_score": "visual image-only ctrviews percentile on the frozen generator-training ladder",
        "threshold_uses": "visual only",
        "visual_ctrviews_artifact": exact.get("artifact"),
        "visual_ctrviews_artifact_sha256": exact.get("artifact_sha256"),
        "visual_ctrviews_artifact_archive_key": exact.get("artifact_archive_key"),
        "visual_ctrviews_lineage_manifest_sha256": exact.get("lineage_manifest_sha256"),
        "visual_ctrviews_lineage_schema_version": exact.get("lineage_schema_version"),
        "note": "Transcript or channel context can guide generation upstream. The threshold score embeds only the thumbnail image. Title text is embedded separately for relevance and diagnostic text/together maps; the together embedding never changes thumbnail potential.",
        "channels": {
            "visual": {
                "present": ev is not None,
                "input": "thumbnail image only",
                "image": "single 16:9 thumbnail image",
                "text": "",
            },
            "text": {
                "present": et is not None,
                "input": "title or idea text only",
                "image": "",
                "text": title,
            },
            "together": {
                "present": eg is not None,
                "input": "thumbnail image plus title or idea text",
                "image": "single 16:9 thumbnail image",
                "text": title,
            },
        },
    }
    out = {
        "title": title,
        "pctile": pctile,
        "visual_pctile": pctile,
        "thumbnail_potential": pctile,
        "reward": round(float(reward), 4),
        "training_reward": round(float(thumbnail_model_reward), 4) if thumbnail_model_reward is not None else None,
        "thumbnail_model_reward": round(float(thumbnail_model_reward), 4) if thumbnail_model_reward is not None else None,
        "idea_model_reward": round(float(idea_model_reward), 4) if idea_model_reward is not None else None,
        "proj": exact.get("proj") if exact else None,
        "p90": exact.get("p90") if exact else None,
        "relevance": round(relevance, 4) if relevance is not None else None,
        "nn_cos": round(float(visual_nn), 6) if visual_nn is not None else None,
        "reward_trace": {
            "visual_pctile": round(float(pctile), 4),
            "relevance": round(relevance, 4) if relevance is not None else None,
            "relevance_floor": REL_FLOOR,
            "relevance_penalty": round(float(relevance_penalty), 4) if relevance_penalty is not None else None,
            "density": round(float(visual_nn), 6) if visual_nn is not None else None,
            "density_floor": round(DENSITY_FLOOR, 6),
            "density_penalty": round(float(density_penalty), 4) if density_penalty is not None else None,
            "idea_model_reward": round(float(idea_model_reward), 4) if idea_model_reward is not None else None,
            "thumbnail_model_reward": round(float(thumbnail_model_reward), 4) if thumbnail_model_reward is not None else None,
            "threshold_score": round(float(pctile), 4),
            "threshold_channel": "visual",
            "together_used_for_threshold": False,
        },
        "channel_roles": {
            "visual": "primary thumbnail-only performance score and default metric maps",
            "text": "title or idea diagnostic only",
            "together": "title plus thumbnail packaging diagnostic only",
        },
        "metrics": {
            "ctr": pick("ctr", ("visual",)),
            "ret30": pick("ret30", ("visual",)),
            "views": pick("views", ("visual",)),
            "scaled_views": pick("scaled_views", ("visual",)),
            "realviews": pick("realviews", ("visual",)),
            "gt10m": pick("gt10m", ("visual",)),
            "ctrviews": pick("ctrviews", ("visual",)),
        },
        "channels": channels,
        "emb_preview": {"visual": preview(ev), "text": preview(et), "together": preview(eg)},
        "input_manifest": input_manifest,
    }
    print(json.dumps(out))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e)[:220], "trace": traceback.format_exc()[-600:]}))
