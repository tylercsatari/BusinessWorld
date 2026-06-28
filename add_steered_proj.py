#!/usr/bin/env python3
"""
Add KEEP-RATE and 5s-RETENTION steered projections to each raw/<channel>/map.json.
The owned 211 (the only videos with retention) act as a REFERENCE to rotate the
embedding space so an axis aligns with keep-rate / retention — then ALL ~11k are
projected the same way (exactly like the views / outlier / >10M projections).
So the keep cluster becomes meaningful for the whole corpus, not just a highlight.

Run: python3 add_steered_proj.py   (updates the 3 map.json in place)
"""
import os, io, json
import numpy as np, boto3
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import KFold
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    v = os.environ.get(k)
    if v: return v
    for ln in open(os.path.join(HERE, '.env')):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
def r2_get(k):
    try: return s3.get_object(Bucket=BUCKET, Key=k)['Body'].read()
    except Exception: return None
def r2_put(k, d, ct): s3.put_object(Bucket=BUCKET, Key=k, Body=d, ContentType=ct)
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def grid(a):
    a = np.asarray(a, float); q1, q9 = np.nanpercentile(a, 1), np.nanpercentile(a, 99)
    return (np.clip((a - q1) / ((q9 - q1) or 1), 0, 1) * 1000).round().astype(int).tolist()

# owned retention
rt = json.loads(open(os.path.join(HERE, 'buildings/jarvis/retention-study/retention_table.json')).read())
KEEP = {}; RET5 = {}
for v in rt.get('videos', []):
    if v.get('keep_rate') is not None: KEEP[str(v['id'])] = float(v['keep_rate'])
    if v.get('ret5_surv') is not None: RET5[str(v['id'])] = float(v['ret5_surv'])
print(f'owned retention: keep={len(KEEP)} ret5={len(RET5)}', flush=True)

kf = KFold(5, shuffle=True, random_state=0)
for ch in ['visual', 'text', 'together']:
    z = np.load(io.BytesIO(r2_get(f'raw/{ch}/embeddings.npz')), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; V = norm(np.asarray(z['vecs'], np.float32))
    mp = json.loads(r2_get(f'raw/{ch}/map.json'))
    mids = [str(x) for x in mp['id']]; mpos = {v: i for i, v in enumerate(mids)}
    # align embeddings to MAP order (map defines the point order the UI draws)
    epos = {v: i for i, v in enumerate(ids)}
    Vm = np.zeros((len(mids), V.shape[1]), np.float32)
    for i, vid in enumerate(mids):
        j = epos.get(vid)
        if j is not None: Vm[i] = V[j]
    for tgt, lab in [('keep', KEEP), ('ret5', RET5)]:
        oi = [i for i, vid in enumerate(mids) if vid in lab]
        if len(oi) < 40:
            print(f'  {ch}/{tgt}: too few owned ({len(oi)})', flush=True); continue
        Xo = Vm[oi]; yo = np.array([lab[mids[i]] for i in oi])
        # held-out alignment of the learned direction with the target (honest cv)
        oof = np.full(len(oi), np.nan)
        for tr, te in kf.split(Xo):
            oof[te] = PLSRegression(1).fit(Xo[tr], yo[tr]).predict(Xo[te]).ravel()
        cv = abs(float(spearmanr(oof, yo)[0]))
        # fit on ALL owned, project EVERY video (the steered 2D layout)
        pls = PLSRegression(2).fit(Xo, yo)
        XY = pls.transform(Vm)                       # (n,2): comp1 ≈ keep axis
        if spearmanr(XY[oi, 0], yo)[0] < 0: XY[:, 0] = -XY[:, 0]   # orient so higher x = higher target
        # EXTRAPOLATE the metric to EVERY video: rank by the model's prediction, then
        # quantile-map onto the owned (actual) distribution so corpus estimates spread
        # above AND below your videos, in real metric units (0-100 organised by KEEP).
        pred_all = pls.predict(Vm).ravel()
        ranks = np.empty(len(pred_all)); ranks[np.argsort(pred_all)] = np.linspace(0, 1, len(pred_all))
        yo_sorted = np.sort(yo)
        est = yo_sorted[np.clip((ranks * (len(yo_sorted) - 1)).round().astype(int), 0, len(yo_sorted) - 1)]
        actual = np.full(len(mids), np.nan)
        for i, vid in enumerate(mids):
            if vid in lab: actual[i] = lab[vid]
        mp['proj'][tgt] = {'x': grid(XY[:, 0]), 'y': grid(XY[:, 1]), 'cv': round(cv, 3), 'co': 0.0, 'owned_only_label': True,
                           'est': [round(float(x), 2) for x in est],
                           'actual': [None if x != x else round(float(x), 2) for x in actual]}
        print(f'  {ch}/{tgt}: held-out align {cv:.3f} (trained on {len(oi)} owned, projected {len(mids)})', flush=True)
    r2_put(f'raw/{ch}/map.json', json.dumps(mp).encode(), 'application/json')
    print(f'  saved raw/{ch}/map.json', flush=True)
print('done — keep/ret5 projections added to all maps', flush=True)
