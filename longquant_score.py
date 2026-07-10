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
import io
import json
import os
import re
import shutil
import tempfile
import time
import urllib.request
import zipfile

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


def cache_vecs(chan):
    cdir = tempfile.gettempdir()
    etag = None
    try:
        etag = s3.head_object(Bucket=BUCKET, Key=f"raw-long/{chan}/embeddings.npz").get("ETag")
    except Exception:
        pass
    tag = cache_tag(etag)
    npy = os.path.join(cdir, f"rawlong_{chan}_{tag}_vecs.npy")
    if not os.path.exists(npy):
        npz = os.path.join(cdir, f"rawlong_{chan}_{tag}.npz")
        if not os.path.exists(npz):
            download_file(f"raw-long/{chan}/embeddings.npz", npz)
        with zipfile.ZipFile(npz) as zf:
            names = zf.namelist()
            vec_name = "vecs.npy" if "vecs.npy" in names else next((n for n in names if n.endswith("/vecs.npy") or n.endswith("vecs.npy")), None)
            if not vec_name:
                raise RuntimeError(f"raw-long/{chan}/embeddings.npz missing vecs.npy")
            tmp = npy + ".tmp"
            with zf.open(vec_name) as src, open(tmp, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            os.replace(tmp, npy)
        try:
            os.remove(npz)
        except Exception:
            pass
    return np.load(npy, mmap_mode="r")


def load_map(chan):
    cdir = tempfile.gettempdir()
    etag = None
    try:
        etag = s3.head_object(Bucket=BUCKET, Key=f"raw-long/{chan}/map.json").get("ETag")
    except Exception:
        pass
    path = os.path.join(cdir, f"rawlong_{chan}_{cache_tag(etag)}_map.json")
    if not os.path.exists(path):
        download_file(f"raw-long/{chan}/map.json", path)
    try:
        return json.load(open(path))
    except Exception:
        b = r2_get(f"raw-long/{chan}/map.json")
        return json.loads(b.decode("utf8")) if b else {}


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
    V = cache_vecs(chan)
    if V is None or not len(V):
        return None, None, None
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
    return order, sims[order], weights


def metric_obj(est, pctile=None, kind="neighbor"):
    if est is None:
        return None
    est = float(est)
    val = round(est, 4) if abs(est) < 100 else round(est)
    return {"est": val, "pctile": pctile, "kind": kind}


def channel_score(chan, emb):
    idx, sims, weights = top_neighbors(chan, emb)
    if idx is None:
        return None
    mp = load_map(chan)
    ids = mp.get("id") or []
    titles = mp.get("title") or []
    views = mp.get("views") or []
    outlier = mp.get("outlier") or []
    proj = mp.get("proj") or {}
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
            gt.append(1.0 if float(v) >= 10_000_000 else 0.0)
        except Exception:
            gt.append(None)
    p10 = wavg(gt, idx, weights)
    metrics["gt10m"] = metric_obj(p10, round(100.0 * p10, 1) if p10 is not None else None, "neighbor_rate")

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
    }


def visual_ctrviews_exact(ev):
    b = r2_get("longform/thumb-rl/scorer_visual.json")
    if not b:
        return None
    sc = json.loads(b.decode("utf8"))
    blend = np.asarray(sc["blend"], np.float32)
    ladder = np.asarray(sc["ladder"], np.float32)
    en = norm(ev)
    proj = float(en @ blend)
    pctile = float(np.searchsorted(ladder, proj) / max(1, len(ladder)))
    return {
        "est": round(pctile * 100, 2),
        "pctile": round(pctile * 100, 1),
        "kind": "visual_ctrviews_ladder",
        "proj": round(proj, 4),
        "p90": sc.get("p90"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--idea", default="")
    ap.add_argument("--emb-json", default="")
    args = ap.parse_args()
    if not os.path.exists(args.image):
        print(json.dumps({"error": "no image"}))
        return
    title = (args.title or args.idea or "").strip()[:500]
    b64 = base64.b64encode(open(args.image, "rb").read()).decode()
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

    channels = {"visual": channel_score("visual", ev)}
    gc.collect()
    if et is not None:
        channels["text"] = channel_score("text", et)
        gc.collect()
        channels["together"] = channel_score("together", eg)
        gc.collect()

    exact = visual_ctrviews_exact(ev)
    if exact and channels.get("visual"):
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
        "embedding_model": "gemini-embedding-2",
        "embedding_dimensions": DIM,
        "score_text": title,
        "display_preference": ["visual", "together", "text"],
        "primary_score": "visual image-only ctrviews percentile on the frozen generator-training ladder",
        "threshold_uses": "visual only",
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
