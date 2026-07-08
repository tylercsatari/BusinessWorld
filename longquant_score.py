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
neighbors, then estimate each metric from those neighbors. The visual
ctrviews reward still uses the frozen thumbnail scorer ladder exactly.
"""
import argparse
import base64
import io
import json
import os
import tempfile
import time
import urllib.request

import boto3
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DIM = 1536
EMB_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent"
CHANS = ("visual", "text", "together")


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
    body = json.dumps({"content": {"parts": parts}, "outputDimensionality": DIM}).encode()
    last = ""
    for a in range(tries):
        try:
            req = urllib.request.Request(
                EMB_URL,
                data=body,
                method="POST",
                headers={"Content-Type": "application/json", "x-goog-api-key": KEY},
            )
            with urllib.request.urlopen(req, timeout=45) as r:
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


def cache_npz(chan):
    cdir = tempfile.gettempdir()
    npy = os.path.join(cdir, f"rawlong_{chan}.npy")
    meta = os.path.join(cdir, f"rawlong_{chan}.json")
    etag = None
    try:
        etag = s3.head_object(Bucket=BUCKET, Key=f"raw-long/{chan}/embeddings.npz").get("ETag")
    except Exception:
        pass
    if etag and os.path.exists(npy) and os.path.exists(meta):
        try:
            m = json.load(open(meta))
            if m.get("etag") == etag:
                return np.load(npy, mmap_mode="r"), m["ids"], m
        except Exception:
            pass
    buf = r2_get(f"raw-long/{chan}/embeddings.npz")
    if not buf:
        return None, None, None
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    V = np.asarray(z["vecs"], np.float32)
    V = V / (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
    m = {
        "etag": etag,
        "ids": [str(x) for x in z["ids"]],
        "views": [float(x) for x in z["views"]] if "views" in z.files else [],
        "title": [str(x) for x in z["title"]] if "title" in z.files else [],
    }
    try:
        np.save(npy, V)
        json.dump(m, open(meta, "w"))
    except Exception:
        pass
    return np.load(npy, mmap_mode="r"), m["ids"], m


def load_map(chan):
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
    V, ids, meta = cache_npz(chan)
    if V is None or not len(V):
        return None, None, None, None
    q = norm(q)
    sims = np.empty(len(V), np.float32)
    for i in range(0, len(V), 4096):
        sims[i:i + 4096] = np.asarray(V[i:i + 4096]) @ q
    kk = min(k, len(V))
    part = np.argpartition(-sims, kk - 1)[:kk]
    order = part[np.argsort(-sims[part])]
    weights = np.maximum(sims[order], 0) ** 8 + 1e-6
    return order, sims[order], weights, {"ids": ids, **(meta or {})}


def metric_obj(est, pctile=None, kind="neighbor"):
    if est is None:
        return None
    est = float(est)
    val = round(est, 4) if abs(est) < 100 else round(est)
    return {"est": val, "pctile": pctile, "kind": kind}


def channel_score(chan, emb):
    idx, sims, weights, meta = top_neighbors(chan, emb)
    if idx is None:
        return None
    mp = load_map(chan)
    ids = mp.get("id") or meta.get("ids") or []
    titles = mp.get("title") or meta.get("title") or []
    views = mp.get("views") or meta.get("views") or []
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

    metrics["ctr"] = from_proj("ctr")
    metrics["ret30"] = from_proj("ret30", ("retention",))
    metrics["realviews"] = from_proj("realviews")
    metrics["ctrviews"] = from_proj("ctrviews")

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
    return {"metrics": metrics, "neighbors": neighbors}


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
    args = ap.parse_args()
    if not os.path.exists(args.image):
        print(json.dumps({"error": "no image"}))
        return
    title = (args.title or args.idea or "").strip()[:500]
    b64 = base64.b64encode(open(args.image, "rb").read()).decode()
    ev = embed([img_part(b64)])
    et = embed([{"text": title}]) if title else None
    eg = embed([img_part(b64), {"text": title}]) if title else ev

    channels = {"visual": channel_score("visual", ev)}
    if et is not None:
        channels["text"] = channel_score("text", et)
    channels["together"] = channel_score("together", eg)

    exact = visual_ctrviews_exact(ev)
    if exact and channels.get("visual"):
        channels["visual"]["metrics"]["ctrviews"] = exact

    relevance = None
    if et is not None:
        relevance = float(norm(ev) @ norm(et))

    def pick(metric):
        for c in ("together", "text", "visual"):
            m = ((channels.get(c) or {}).get("metrics") or {}).get(metric)
            if m and m.get("pctile") is not None:
                return m
        return None

    headline = pick("ctrviews") or pick("views")
    hp = (headline or {}).get("pctile")
    pctile = round(float(hp) / 100.0, 4) if hp is not None and float(hp) > 1 else (hp or 0)
    out = {
        "title": title,
        "pctile": pctile,
        "proj": exact.get("proj") if exact else None,
        "p90": exact.get("p90") if exact else None,
        "relevance": round(relevance, 4) if relevance is not None else None,
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
        "emb_preview": {"visual": preview(ev), "text": preview(et), "together": preview(eg)},
    }
    print(json.dumps(out))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e)[:220], "trace": traceback.format_exc()[-600:]}))
