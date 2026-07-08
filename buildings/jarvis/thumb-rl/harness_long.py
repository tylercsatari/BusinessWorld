"""Core thumbnail-RL engine: render (Replicate FLUX, 16:9) -> embed (Gemini) -> score (ctrviews
percentile) -> R2. ONE thumbnail per candidate (no montage). Reward = percentile of the thumbnail's
Gemini visual embedding projected onto the FROZEN ctrviews blend direction, read off the curated-set
score ladder (scorer_visual.npz). Mirrors the shorts harness.py structure/idioms."""
import os, io, json, time, base64, random, threading, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import boto3

HERE = "/home/ubuntu/thumbrl"
def load_env():
    env = {}
    for line in Path(HERE + "/.env").read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1); env[k] = v.strip().strip('"').strip("'")
    return env
ENV = load_env()
GEMINI, REPL, BUCKET = ENV["GEMINI_API_KEY"], ENV["REPLICATE_API_TOKEN"], ENV["R2_BUCKET_NAME"]
RENDER_MODEL = os.environ.get("LONGQUANT_RENDER_MODEL") or ENV.get("LONGQUANT_RENDER_MODEL") or "black-forest-labs/flux-schnell"
s3 = boto3.client("s3", endpoint_url="https://%s.r2.cloudflarestorage.com" % ENV["R2_ACCOUNT_ID"],
    aws_access_key_id=ENV["R2_ACCESS_KEY_ID"], aws_secret_access_key=ENV["R2_SECRET_ACCESS_KEY"], region_name="auto")

class GeminiHalt(Exception):
    """Gemini credits depleted / persistently unavailable — HALT so we never render (spend) unscoreable images."""

def write_status(state, note=""):
    """Publish trainer state to R2 so the UI + monitors can see it — no silent failure.
    STATUS_KEY env lets the idea trainer publish to its own channel."""
    try:
        s3.put_object(Bucket=BUCKET, Key=os.environ.get("STATUS_KEY", "longform/thumb-rl/status.json"),
                      Body=json.dumps({"state": state, "note": str(note)[:300], "ts": int(time.time() * 1000)}).encode(),
                      ContentType="application/json")
    except Exception:
        pass

EMB_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent"
def _embed_call(body, tries):
    last = ""
    for a in range(tries):
        try:
            req = urllib.request.Request(EMB_URL, data=body, method="POST",
                headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI})
            with urllib.request.urlopen(req, timeout=60) as r:
                return np.array(json.loads(r.read())["embedding"]["values"], np.float32)
        except urllib.error.HTTPError as e:
            try: last = e.read().decode()[:300]
            except Exception: last = "HTTP %s" % e.code
            if "depleted" in last or "RESOURCE_EXHAUSTED" in last:   # credits gone — no point retrying
                raise GeminiHalt("Gemini credits depleted: " + last[:120])
            if a < tries - 1: time.sleep(1.5 * (a + 1)); continue
        except GeminiHalt:
            raise
        except Exception as e:
            last = str(e)[:120]
            if a < tries - 1: time.sleep(1.5 * (a + 1)); continue
    raise GeminiHalt("Gemini embed failed after %d tries: %s" % (tries, last))   # LOUD, never a silent None

def embed_image(jpg_bytes, tries=6):
    b64 = base64.b64encode(jpg_bytes).decode()
    return _embed_call(json.dumps({"content": {"parts": [{"inlineData": {"mimeType": "image/jpeg", "data": b64}}]},
                                   "outputDimensionality": 1536}).encode(), tries)

def gemini_ok():
    """Cheap pre-flight (one tiny text embed). Returns (ok, msg) — gates rendering so we never pay for unscoreable images."""
    try:
        _embed_call(json.dumps({"content": {"parts": [{"text": "ping"}]}, "outputDimensionality": 1536}).encode(), 2)
        return True, ""
    except GeminiHalt as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)[:150]

class BillingHalt(Exception):
    """Replicate billing/quota failure — stop the run cleanly so it can be resumed."""

RENDERS = [0]  # count of successful renders this process (for spend estimate)

# Global rate limiter: space ALL Replicate calls (across every worker thread) >= MIN_INTERVAL apart,
# so concurrency never bursts past Replicate's ~10/sec cap (the real fix for 429 storms — the account
# is funded; the problem was many threads firing in the same instant, not low credit).
_RL_LOCK = threading.Lock(); _RL_LAST = [0.0]
RL_MIN_INTERVAL = float(os.environ.get("REPL_MIN_INTERVAL", "0.18"))  # ~5.5 req/sec sustained
def _rl_gate():
    with _RL_LOCK:
        wait = RL_MIN_INTERVAL - (time.time() - _RL_LAST[0])
        if wait > 0: time.sleep(wait)
        _RL_LAST[0] = time.time()

def flux_schnell(prompt, tries=7):
    # 16:9 horizontal — long-form thumbnails (shorts used 9:16 vertical).
    body = json.dumps({"input": {"prompt": prompt, "aspect_ratio": "16:9", "output_format": "jpg", "num_outputs": 1}}).encode()
    for a in range(tries):
        try:
            _rl_gate()
            req = urllib.request.Request("https://api.replicate.com/v1/models/%s/predictions" % RENDER_MODEL,
                data=body, headers={"Authorization": "Bearer " + REPL, "Content-Type": "application/json", "Prefer": "wait"})
            r = json.loads(urllib.request.urlopen(req, timeout=120).read())
            out = r.get("output")
            if isinstance(out, list): out = out[0] if out else None
            if out:
                img = urllib.request.urlopen(out, timeout=60).read()
                RENDERS[0] += 1
                return img
        except urllib.error.HTTPError as e:
            if e.code == 402:                       # genuine payment-required -> stop the run
                raise BillingHalt("Replicate 402 Payment Required")
            # 429 = transient burst/rate cap on a FUNDED account: back off with jitter, never halt.
            if a < tries - 1: time.sleep(min(20, 1.5 * (a + 1)) + random.uniform(0, 1.5)); continue
        except BillingHalt:
            raise
        except Exception:
            if a < tries - 1: time.sleep(min(20, 1.5 * (a + 1)) + random.uniform(0, 1.5)); continue
    return None

# ---- FROZEN reward: ctrviews blend direction + curated-set percentile ladder (built off-box) ----
_SC = [None]
def scorer():
    if _SC[0] is None:
        d = np.load(HERE + "/data/scorer_visual.npz", allow_pickle=True)
        _SC[0] = {"blend": np.asarray(d["blend"], np.float32),
                  "ladder": np.asarray(d["ladder"], np.float32),
                  "p90": float(d["p90"]), "n": int(d["n_curated"])}
    return _SC[0]

# ---- real thumbnail manifold (for the off-manifold density guard + Guesses-map neighbor positions) ----
_REAL = [None]; _RIDS = [None]
def real_vecs():
    if _REAL[0] is None:
        d = np.load(HERE + "/data/visual_long_embeddings.npz", allow_pickle=True)
        V = np.asarray(d["vecs"], dtype="float32")
        _REAL[0] = V / (np.linalg.norm(V, axis=1, keepdims=True) + 1e-8)
        _RIDS[0] = [str(x) for x in d["ids"]]
    return _REAL[0]

_MAP = [None]; _XY = [None]
def _load_map():
    if _MAP[0] is None:
        real_vecs()
        M = json.loads(s3.get_object(Bucket=BUCKET, Key="raw-long/visual/map.json")["Body"].read())
        ids = [str(x) for x in M["id"]]; P = M["proj"]
        pj = P.get("ctrviews") or P.get("views") or {}
        px, py = pj.get("x", []), pj.get("y", [])
        id2xy = {ids[i]: (px[i], py[i]) for i in range(min(len(ids), len(px), len(py)))}
        _XY[0] = np.array([id2xy.get(rid, (np.nan, np.nan)) for rid in _RIDS[0]], float)
        _MAP[0] = True

DENSITY_FLOOR = [None]  # real-real nn_cos p10 — below this a thumbnail is off the real-thumbnail manifold
def _density_floor():
    if DENSITY_FLOOR[0] is None:
        V = real_vecs(); rng = np.random.default_rng(0)
        idx = rng.choice(len(V), size=min(400, len(V)), replace=False)
        floors = []
        for i in idx:
            sims = V @ V[i]; sims[i] = -1
            floors.append(float(sims.max()))
        DENSITY_FLOOR[0] = float(np.percentile(floors, 10))
    return DENSITY_FLOOR[0]

def score_thumb(emb):
    """Reward axis = ctrviews (CTR+views joint). Score = percentile of the thumbnail's projection onto
    the frozen blend direction, read off the curated-set ladder. Plus nn_cos density + map neighbors."""
    sc = scorer()
    en = emb / (np.linalg.norm(emb) + 1e-8)
    proj = float(en @ sc["blend"])
    pctile = float(np.searchsorted(sc["ladder"], proj) / len(sc["ladder"]))
    _load_map()
    sims = real_vecs() @ en
    order = np.argsort(sims); top = order[-12:][::-1]
    nbr = [[_RIDS[0][i], round(float(sims[i]), 4)] for i in top]
    xy = _XY[0][order[-12:]]; good = ~np.isnan(xy[:, 0])
    return {"pctile": round(pctile, 4), "proj": round(proj, 4), "nn_cos": float(sims.max()),
            "x": round(float(np.mean(xy[good, 0])), 1) if good.any() else 0.0,
            "y": round(float(np.mean(xy[good, 1])), 1) if good.any() else 0.0, "nbr": nbr}

def render_score(prompt):
    """Render ONE thumbnail, embed, score. Returns (jpg_bytes, embedding, score_dict) — any may be None."""
    jpg = flux_schnell(prompt)
    if jpg is None: return None, None, None
    emb = embed_image(jpg)
    if emb is None: return jpg, None, None
    return jpg, emb, score_thumb(emb)

def reward_of(sc):
    """Density-guarded ctrviews reward: percentile minus an off-manifold penalty so the model can't
    game the axis by leaving the real-thumbnail embedding manifold."""
    pen = max(0.0, _density_floor() - sc["nn_cos"])
    return sc["pctile"] - 1.5 * pen
