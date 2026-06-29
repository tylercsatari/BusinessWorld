"""Core hook-RL engine: render (Replicate FLUX) -> montage -> embed (Gemini) -> score (views axis) -> R2.
Embedding matches raw_embed.py EXACTLY: 5 frames width-320 tiled 5x1, gemini-embedding-2, 1536-D, visual channel."""
import os, io, json, time, base64, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import numpy as np, joblib
from PIL import Image
import boto3

HERE = "/home/ubuntu/hookrl"
def load_env():
    env = {}
    for line in Path(HERE + "/.env").read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1); env[k] = v.strip().strip('"').strip("'")
    return env
ENV = load_env()
GEMINI, REPL, BUCKET = ENV["GEMINI_API_KEY"], ENV["REPLICATE_API_TOKEN"], ENV["R2_BUCKET_NAME"]
s3 = boto3.client("s3", endpoint_url="https://%s.r2.cloudflarestorage.com" % ENV["R2_ACCOUNT_ID"],
    aws_access_key_id=ENV["R2_ACCESS_KEY_ID"], aws_secret_access_key=ENV["R2_SECRET_ACCESS_KEY"], region_name="auto")

EMB_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent"
def embed_image(jpg_bytes, tries=6):
    b64 = base64.b64encode(jpg_bytes).decode()
    body = json.dumps({"content": {"parts": [{"inlineData": {"mimeType": "image/jpeg", "data": b64}}]},
                       "outputDimensionality": 1536}).encode()
    for a in range(tries):
        try:
            req = urllib.request.Request(EMB_URL, data=body, method="POST",
                headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI})
            with urllib.request.urlopen(req, timeout=60) as r:
                return np.array(json.loads(r.read())["embedding"]["values"], np.float32)
        except Exception:
            if a < tries - 1: time.sleep(1.5 * (a + 1)); continue
            return None

class BillingHalt(Exception):
    """Replicate billing/quota failure — stop the run cleanly so it can be resumed."""

RENDERS = [0]  # count of successful renders this process (for spend estimate)

def flux_schnell(prompt, tries=4):
    body = json.dumps({"input": {"prompt": prompt, "aspect_ratio": "9:16", "output_format": "jpg", "num_outputs": 1}}).encode()
    for a in range(tries):
        try:
            req = urllib.request.Request("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
                data=body, headers={"Authorization": "Bearer " + REPL, "Content-Type": "application/json", "Prefer": "wait"})
            r = json.loads(urllib.request.urlopen(req, timeout=120).read())
            out = r.get("output")
            if isinstance(out, list): out = out[0] if out else None
            if out:
                img = urllib.request.urlopen(out, timeout=60).read()
                RENDERS[0] += 1
                return img
        except urllib.error.HTTPError as e:
            if e.code == 402:                       # payment required -> stop now
                raise BillingHalt("Replicate 402 Payment Required")
            if e.code == 429 and a == tries - 1:    # persistent rate/quota -> stop
                raise BillingHalt("Replicate 429 after %d tries" % tries)
            if a < tries - 1: time.sleep(2 * (a + 1)); continue
        except BillingHalt:
            raise
        except Exception:
            if a < tries - 1: time.sleep(2 * (a + 1)); continue
    return None

def render_frames(prompts, max_workers=5):
    out = [None] * len(prompts)
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(flux_schnell, p): i for i, p in enumerate(prompts)}
        for f in futs: out[futs[f]] = f.result()
    return out

def build_montage(frame_bytes, w=320):
    imgs = [Image.open(io.BytesIO(b)).convert("RGB") for b in frame_bytes]
    h = round(imgs[0].height * w / imgs[0].width)
    imgs = [im.resize((w, h)) for im in imgs]
    canvas = Image.new("RGB", (w * len(imgs), h))
    for i, im in enumerate(imgs): canvas.paste(im, (i * w, 0))
    buf = io.BytesIO(); canvas.save(buf, "JPEG", quality=90); return buf.getvalue()

_AX = [None]; _REAL = [None]
def axis():
    if _AX[0] is None: _AX[0] = joblib.load(HERE + "/data/axis_views.joblib")
    return _AX[0]
def real_vecs():
    if _REAL[0] is None:
        d = np.load(HERE + "/data/visual_embeddings.npz", allow_pickle=True)
        V = np.asarray(d["vecs"], dtype="float32")
        _REAL[0] = V / (np.linalg.norm(V, axis=1, keepdims=True) + 1e-8)
    return _REAL[0]
_MAP = [None]; _ROWXY = [None]; _NIDS = [None]
def _load_map():
    if _MAP[0] is None:
        M = json.loads(s3.get_object(Bucket=BUCKET, Key="raw/visual/map.json")["Body"].read())
        ids = M["id"]; vx = M["proj"]["views"]["x"]; vy = M["proj"]["views"]["y"]
        id2xy = {ids[i]: (vx[i], vy[i]) for i in range(len(ids))}
        d = np.load(HERE + "/data/visual_embeddings.npz", allow_pickle=True)
        nids = [str(x) for x in d["ids"]]
        _NIDS[0] = nids
        _ROWXY[0] = np.array([id2xy.get(nids[i], (np.nan, np.nan)) for i in range(len(nids))], float)
        _MAP[0] = True

def score(emb):
    ax = axis()
    z = ((emb - ax["mu"]) / ax["sd"]).reshape(1, -1)
    pred = float(ax["pls"].predict(z).ravel()[0])
    pctile = float((ax["pctile_ref"] < pred).mean())
    en = emb / (np.linalg.norm(emb) + 1e-8)
    sims = real_vecs() @ en
    _load_map()
    order = np.argsort(sims)
    top = order[-12:][::-1]                      # 12 nearest library hooks, by id+sim
    nbr = [[_NIDS[0][i], round(float(sims[i]), 4)] for i in top]
    xy = _ROWXY[0][order[-12:]]; good = ~np.isnan(xy[:, 0])
    return {"pred": pred, "pctile": pctile, "nn_cos": float(sims.max()),
            "nn10_cos": float(np.sort(sims)[-10:].mean()),
            "x": round(float(np.mean(xy[good, 0])), 1), "y": round(float(np.mean(xy[good, 1])), 1),
            "nbr": nbr}

def render_score_hook(prompts):
    frames = render_frames(prompts)
    if any(f is None for f in frames): return None, None, None
    mont = build_montage(frames)
    emb = embed_image(mont)
    if emb is None: return frames, mont, None
    return frames, mont, score(emb)
