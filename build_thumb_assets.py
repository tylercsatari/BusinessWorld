#!/usr/bin/env python3
"""
Prep the two assets the long-form thumbnail trainer needs:
 1. longform/thumb-rl/scorer_visual.npz — the frozen reward: ctrviews blend direction (1536-d) + the
    curated-set score ladder + the 90th-pctile target. The box scores a new thumbnail embedding by
    projecting onto `blend` and reading its percentile off `ladder`. (No refit on the box.)
 2. longform/thumb-rl/titles.jsonl — a diverse pool of real long-form titles (from the crawled library +
    our own), one {"title": ...} per line. The trainer samples a fresh title each step so it can't overfit
    to one output.
Run: python3 build_thumb_assets.py
"""
import io, json, re, numpy as np, boto3
from sklearn.cross_decomposition import PLSRegression
def env(k):
    for ln in open('.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
B = 'business-world-videos'
def r2(k): return s3.get_object(Bucket=B, Key=k)['Body'].read()
def put(k, b, ct): s3.put_object(Bucket=B, Key=k, Body=b, ContentType=ct)
def nrm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def pls_dir(X, y):
    w = np.asarray(PLSRegression(1).fit(X, y).coef_).reshape(-1); return w / (np.linalg.norm(w) + 1e-9)

# ---- 1. scorer artifact (same math as score_thumb_long.py, frozen to R2) ----
CUR = json.loads(r2('longform/curated/all_visual.json')); kept = set(CUR['keptIds'])
CTR = {}
for c in json.loads(r2('longform/channels.json'))['channels']:
    try:
        for v in json.loads(r2(f"longform/ret_{c['id']}.json")).get('videos', []):
            if v.get('id') and v.get('ctr') is not None: CTR[str(v['id'])] = float(v['ctr'])
    except Exception: pass
z = np.load(io.BytesIO(r2('raw-long/visual/embeddings.npz')), allow_pickle=True)
ids = [str(x) for x in z['ids']]; V = nrm(np.asarray(z['vecs'], np.float32)); views = np.asarray(z['views'], float)
pos = {v: i for i, v in enumerate(ids)}
ci = np.array([pos[k] for k in kept if k in pos]); Vc = V[ci]; lvc = np.log10(views[ci] + 1)
oi = np.array([i for i, v in enumerate(ids) if v in CTR])
w_ctr = pls_dir(V[oi], np.array([CTR[ids[i]] for i in oi])); w_views = pls_dir(Vc, lvc)
blend = 0.3 * w_ctr + 0.7 * w_views; blend /= np.linalg.norm(blend)
ladder = np.sort(Vc @ blend).astype(np.float32)
p90 = float(np.quantile(ladder, 0.90))
buf = io.BytesIO(); np.savez_compressed(buf, blend=blend.astype(np.float32), ladder=ladder,
                                        p90=np.float32(p90), n_curated=np.int32(len(ci)))
put('longform/thumb-rl/scorer_visual.npz', buf.getvalue(), 'application/octet-stream')
print(f"scorer_visual.npz: blend[{blend.shape[0]}] · ladder[{len(ladder)}] · p90={p90:.3f} → R2")

# ---- 2. title corpus (diverse real long-form titles) ----
titles, seen = [], set()
def add(t):
    t = (t or '').strip()
    if not t or len(t) < 8 or len(t) > 160: return
    key = re.sub(r'\W+', '', t.lower())[:80]
    if key in seen: return
    seen.add(key); titles.append(t)
db = json.loads(r2('longform/db.json')).get('videos', {})
for v in db.values(): add(v.get('title'))
for c in json.loads(r2('longform/channels.json'))['channels']:
    try:
        for v in json.loads(r2(f"longform/ret_{c['id']}.json")).get('videos', []): add(v.get('title'))
    except Exception: pass
out = '\n'.join(json.dumps({'title': t}) for t in titles)
put('longform/thumb-rl/titles.jsonl', out.encode(), 'application/x-ndjson')
print(f"titles.jsonl: {len(titles)} unique long-form titles → R2  (sample: {titles[:3]})")
