#!/usr/bin/env python3
"""
Save the corpus NOVELTY MODELS so an uploaded hook can be scored on EVERY novelty
type (not just global) — niche (kmeans centroids), combinatorial (PCA basis),
temporal (recent-corpus centroid). Same definitions as principles_novelty.py, so
an upload's novelty is comparable to the registry curves. → raw/novelty_models.npz
Run: python3 save_novelty_models.py
"""
import os, io, json, datetime
import numpy as np, boto3
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import PCA
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
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

db = json.loads(r2_get('library/db.json') or b'{"videos":{}}')
out = {}
for sk, ck in [('vis', 'visual'), ('txt', 'text'), ('tog', 'together')]:
    z = np.load(io.BytesIO(r2_get(f'raw/{ck}/embeddings.npz')), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; X = norm(np.asarray(z['vecs'], np.float32)); n = len(ids)
    K = min(25, max(2, n // 200))
    cen = norm(MiniBatchKMeans(K, random_state=0, n_init=3, batch_size=1024).fit(X).cluster_centers_)
    npc = min(50, X.shape[1], n - 1); pca = PCA(npc, random_state=0).fit(X)
    # recent-corpus centroid (temporal reference for a "now" upload) = latest 2 months
    if sk == 'vis':
        month = np.full(n, -1, int); idpos = {v: i for i, v in enumerate(ids)}
        for v in db.get('videos', {}).values():
            i = idpos.get(str(v.get('videoId', ''))); ud = str(v.get('uploadDate', '') or '')
            if i is not None and len(ud) == 8 and ud.isdigit(): month[i] = int(ud[:4]) * 12 + int(ud[4:6])
        MONTH = {'vis': month}
    recent = MONTH['vis'][:n] if sk == 'vis' else None
    if sk != 'vis':
        recent = np.full(n, -1, int)
        for v in db.get('videos', {}).values():
            i = ids.index(str(v.get('videoId', ''))) if str(v.get('videoId', '')) in ids else None
        recent = None
    # use the global mean as temporal reference if month unavailable (robust)
    mvals = MONTH['vis'][:n] if sk == 'vis' else np.full(n, -1)
    rc = norm(X[mvals >= (mvals[mvals > 0].max() - 1)].mean(0, keepdims=True))[0] if (mvals > 0).any() else norm(X.mean(0, keepdims=True))[0]
    out[f'{sk}_centroids'] = cen.astype(np.float32)
    out[f'{sk}_pca_comp'] = pca.components_.astype(np.float32)
    out[f'{sk}_pca_mean'] = pca.mean_.astype(np.float32)
    out[f'{sk}_recent'] = rc.astype(np.float32)
    print(f'{sk}: {K} centroids · PCA{npc} · recent-centroid saved', flush=True)
bio = io.BytesIO(); np.savez_compressed(bio, **out)
s3.put_object(Bucket=BUCKET, Key='raw/novelty_models.npz', Body=bio.getvalue(), ContentType='application/octet-stream')
print('saved → raw/novelty_models.npz', flush=True)
