"""Retrain the PROMPT-TEXT proxy scorer from all rendered evidence so far. Measured: prompt embedding
predicts the rendered thumbnail's ctrviews percentile at held-out spearman r=0.85 — so candidates can be
scored by TEXT before paying for a render. Retrained at every harvest round start so it tracks the policy's
prompt distribution (anti-Goodhart: the proxy only FILTERS; DPO pairs always use REAL rendered scores).
Writes data/proxy_prompt.npz {mean, coef, ym} (linear PLS predictor). Refuses to overwrite if held-out r<0.3."""
import glob, json, random
import numpy as np
from concurrent.futures import ThreadPoolExecutor
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import KFold
from scipy.stats import spearmanr
import harness_long as H

rows = []
for pf in glob.glob("/home/ubuntu/thumbrl/runs/thumb*/manifest.jsonl"):
    for l in open(pf):
        try:
            r = json.loads(l)
            if r.get("prompt") and r.get("pctile") is not None: rows.append((r["prompt"], float(r["pctile"])))
        except Exception: pass
random.Random(0).shuffle(rows)
rows = rows[:1500]
print("proxy_train: %d (prompt, real pctile) samples" % len(rows), flush=True)
if len(rows) < 120:
    print("too few samples — keeping existing proxy"); raise SystemExit(0)

def embt(t): return H._embed_call(json.dumps({"content": {"parts": [{"text": t[:1800]}]}, "outputDimensionality": 1536}).encode(), 4)
with ThreadPoolExecutor(max_workers=10) as ex:
    V = list(ex.map(lambda p: embt(p[0]), rows))
X = np.array(V, np.float32); X /= (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
y = np.array([p for _, p in rows], np.float32)

kf = KFold(5, shuffle=True, random_state=0); oof = np.zeros(len(y))
for tr, te in kf.split(X): oof[te] = PLSRegression(2).fit(X[tr], y[tr]).predict(X[te]).ravel()
r = float(spearmanr(oof, y)[0])
print("proxy held-out spearman r=%.3f" % r, flush=True)
if r < 0.3:
    print("proxy too weak (r<0.3) — NOT overwriting; harvest falls back to render-all"); raise SystemExit(0)
import joblib
m = PLSRegression(2).fit(X, y)
joblib.dump({"model": m, "r": r, "n": len(rows)}, "/home/ubuntu/thumbrl/data/proxy_prompt.joblib")
print("=== PROXY_TRAIN_DONE r=%.3f n=%d ===" % (r, len(rows)), flush=True)
