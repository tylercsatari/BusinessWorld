import os, numpy as np, joblib
from pathlib import Path

env = {}
for line in Path("/home/ubuntu/hookrl/.env").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k] = v.strip()

import boto3
s3 = boto3.client("s3",
    endpoint_url="https://%s.r2.cloudflarestorage.com" % env["R2_ACCOUNT_ID"],
    aws_access_key_id=env["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"], region_name="auto")
b = env["R2_BUCKET_NAME"]

local = "/home/ubuntu/hookrl/data/visual_embeddings.npz"
os.makedirs("/home/ubuntu/hookrl/data", exist_ok=True)
if not os.path.exists(local):
    print("downloading embeddings.npz ...", flush=True)
    s3.download_file(b, "raw/visual/embeddings.npz", local)

d = np.load(local, allow_pickle=True)
print("npz keys:", d.files)
vecs = np.asarray(d["vecs"], dtype="float32")
views = np.asarray(d["views"], dtype=float)
mine = np.asarray(d["mine"]) if "mine" in d.files else np.zeros(len(vecs), bool)
print("N=", len(vecs), "dim=", vecs.shape[1], "mine=", int(mine.sum()))

m = np.isfinite(views) & (views > 0)
X = vecs[m]; y = np.log10(views[m])
mu = X.mean(0); sd = X.std(0) + 1e-8
Xs = (X - mu) / sd

rng = np.random.RandomState(0)
idx = rng.permutation(len(Xs)); ntr = int(0.7 * len(Xs))
tr, te = idx[:ntr], idx[ntr:]

from sklearn.cross_decomposition import PLSRegression
pls = PLSRegression(n_components=2).fit(Xs[tr], y[tr])
pred_te = pls.predict(Xs[te]).ravel()
r = float(np.corrcoef(pred_te, y[te])[0, 1])
print("=== HELD-OUT views axis r = %.3f  (R^2=%.3f) ===" % (r, r * r))

pred_all = pls.predict(Xs).ravel()
hi = y >= 7  # >=10M views
print(">10M videos: %d / %d" % (int(hi.sum()), len(y)))
if hi.sum() > 5:
    rhi = float(np.corrcoef(pred_all[hi], y[hi])[0, 1])
    print(">10M-only spread: pred p10=%.2f p50=%.2f p90=%.2f ; within-class r=%.3f" % (
        np.percentile(pred_all[hi], 10), np.percentile(pred_all[hi], 50),
        np.percentile(pred_all[hi], 90), rhi))
# how do MINE (owned) sit vs the far-right?
if mine.sum() > 0:
    ym = mine[m]
    print("MINE pred p50=%.2f vs ALL p90=%.2f p99=%.2f" % (
        np.percentile(pred_all[ym], 50) if ym.sum() else float('nan'),
        np.percentile(pred_all, 90), np.percentile(pred_all, 99)))

joblib.dump({"mu": mu, "sd": sd, "pls": pls,
             "pctile_ref": np.sort(pred_all)}, "/home/ubuntu/hookrl/data/axis_views.joblib")
s3.upload_file("/home/ubuntu/hookrl/data/axis_views.joblib", b, "hooks/axis/axis_views.joblib")
print("saved + uploaded axis to r2 hooks/axis/axis_views.joblib")
