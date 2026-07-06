#!/usr/bin/env python3
"""
REWARD prototype for the long-form thumbnail RL loop. Scores a thumbnail embedding by its PERCENTILE
on the curated set's ctrviews (CTR+views joint) axis — the target the trainer optimises toward (top 90th).
Mirrors add_steered_proj_long's blend (0.3·CTR-dir + 0.7·views-dir) but restricted to the CURATED ids,
and exposes the direction + percentile lookup a scorer service would use. Run: python3 score_thumb_long.py
"""
import io, json, numpy as np, boto3, warnings; warnings.filterwarnings('ignore')
from sklearn.cross_decomposition import PLSRegression
def env(k):
    for ln in open('.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
B = 'business-world-videos'
def r2(k): return s3.get_object(Bucket=B, Key=k)['Body'].read()
def nrm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def pls_dir(X, y):
    w = np.asarray(PLSRegression(1).fit(X, y).coef_).reshape(-1); return w / (np.linalg.norm(w) + 1e-9)

CURATED = json.loads(r2('longform/curated/all_visual.json'))
kept = set(CURATED['keptIds']); print(f"curated set: {len(kept)} kept (dropped clusters {CURATED['excludedClusters']} @ k={CURATED['k']})")

# owned CTR (for the CTR direction)
CTR = {}
for c in json.loads(r2('longform/channels.json'))['channels']:
    try:
        for v in json.loads(r2(f"longform/ret_{c['id']}.json")).get('videos', []):
            if v.get('id') and v.get('ctr') is not None: CTR[str(v['id'])] = float(v['ctr'])
    except Exception: pass

z = np.load(io.BytesIO(r2('raw-long/visual/embeddings.npz')), allow_pickle=True)
ids = [str(x) for x in z['ids']]; V = nrm(np.asarray(z['vecs'], np.float32)); views = np.asarray(z['views'], float)
pos = {v: i for i, v in enumerate(ids)}
ci = np.array([pos[k] for k in kept if k in pos])                       # curated rows present in the embedding set
Vc = V[ci]; lvc = np.log10(views[ci] + 1)
oi = np.array([i for i, v in enumerate(ids) if v in CTR])
w_ctr = pls_dir(V[oi], np.array([CTR[ids[i]] for i in oi]))
w_views = pls_dir(Vc, lvc)                                              # views direction fit on the CURATED set
blend = 0.3 * w_ctr + 0.7 * w_views; blend /= np.linalg.norm(blend)
np.savez_compressed(io.BytesIO(), blend=blend)                          # (direction is what a scorer service ships)

scores_c = Vc @ blend                                                   # curated-set scores → percentile ladder
ladder = np.sort(scores_c)
def pct(emb):                                                          # percentile of a unit-norm embedding vs curated
    s = float(nrm(emb.reshape(1, -1))[0] @ blend); return float(np.searchsorted(ladder, s) / len(ladder))
p90 = float(np.quantile(scores_c, 0.90))
print(f"blend dim={blend.shape[0]} · curated rows scored={len(Vc)}")
print(f"score range [{ladder[0]:.3f} .. {ladder[-1]:.3f}] · 90th-pctile threshold = {p90:.3f}")

# where do OUR OWN videos currently land on this ladder? (are our thumbnails already good, or is there headroom?)
own_pct = [pct(V[i]) for i in oi]
print(f"our {len(oi)} owned thumbnails: median percentile {np.median(own_pct)*100:.0f}th, "
      f"{sum(p>=0.9 for p in own_pct)} already ≥90th, best {max(own_pct)*100:.0f}th")
# separation sanity: do high-view curated thumbs score higher than low-view ones?
hi = scores_c[lvc >= np.quantile(lvc, 0.8)].mean(); lo = scores_c[lvc <= np.quantile(lvc, 0.2)].mean()
print(f"curated top-20%-views mean score {hi:.3f} vs bottom-20% {lo:.3f}  (gap {hi-lo:+.3f} → axis {'separates' if hi>lo else 'FAILS'})")
