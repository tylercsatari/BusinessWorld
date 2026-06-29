import json, io, numpy as np
from pathlib import Path
import boto3

REPO = "/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld"
env = {}
for l in Path(REPO + "/.env").read_text().splitlines():
    if "=" in l and not l.strip().startswith("#"):
        k, v = l.split("=", 1); env[k] = v.strip().strip('"').strip("'")
s3 = boto3.client("s3", endpoint_url="https://%s.r2.cloudflarestorage.com" % env["R2_ACCOUNT_ID"],
    aws_access_key_id=env["R2_ACCESS_KEY_ID"], aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"], region_name="auto")
print("downloading visual embeddings.npz ...", flush=True)
buf = s3.get_object(Bucket=env["R2_BUCKET_NAME"], Key="raw/visual/embeddings.npz")["Body"].read()
d = np.load(io.BytesIO(buf), allow_pickle=True)
ids = [str(x) for x in d["ids"]]; vecs = np.asarray(d["vecs"], float)

rt = json.load(open(REPO + "/buildings/jarvis/retention-study/retention_table.json"))
keep = {v["id"]: v.get("keep_rate") for v in rt.get("videos", []) if v.get("keep_rate") is not None}
ret5 = {v["id"]: v.get("ret5") for v in rt.get("videos", []) if v.get("ret5") is not None}
idx = [i for i, vid in enumerate(ids) if vid in keep]
X = vecs[idx]; ykeep = np.array([keep[ids[i]] for i in idx])
yret = np.array([ret5.get(ids[i], np.nan) for i in idx])
print("owned videos with keep_rate:", len(idx), "| keep range %.0f-%.0f median %.0f" % (ykeep.min(), ykeep.max(), np.median(ykeep)))

mu = X.mean(0); sd = X.std(0) + 1e-8; Xs = (X - mu) / sd
from sklearn.cross_decomposition import PLSRegression
from sklearn.decomposition import PCA
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.metrics import roc_auc_score

def evalaxis(y, name):
    m = np.isfinite(y); Xm = Xs[m]; ym = y[m]
    rng = np.random.RandomState(0); p = rng.permutation(len(Xm)); ntr = int(0.7 * len(Xm)); tr, te = p[:ntr], p[ntr:]
    pls = PLSRegression(2).fit(Xm[tr], ym[tr])
    r = float(np.corrcoef(pls.predict(Xm[te]).ravel(), ym[te])[0, 1])
    # LDA: top vs bottom 40%
    lo, hi = np.percentile(ym, [40, 60]); cls = np.where(ym >= hi, 1, np.where(ym <= lo, 0, -1))
    pca = PCA(n_components=min(30, len(tr) - 2)).fit(Xm)
    Xp = pca.transform(Xm)
    trm = tr[cls[tr] >= 0]; tem = te[cls[te] >= 0]
    auc = float("nan")
    if len(set(cls[trm])) == 2 and len(set(cls[tem])) == 2:
        lda = LinearDiscriminantAnalysis().fit(Xp[trm], cls[trm])
        auc = roc_auc_score(cls[tem], lda.decision_function(Xp[tem]))
    print("%-10s n=%d  PLS held-out r=%.3f (R^2=%.3f)  LDA hi/lo held-out AUC=%.3f" % (name, len(ym), r, r * r, auc))

evalaxis(ykeep, "keep_rate")
evalaxis(yret, "ret5")
print("(reference: views axis on 11k = held-out r 0.36 / R^2 0.13)")
