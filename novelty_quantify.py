#!/usr/bin/env python3
"""
NOVELTY QUANTIFICATION SWEEP — "distance from typical" is one choice in 1536-d. Try MANY
ways to quantify it × visual/text/whole, and test BOTH a linear and an inverted-U (Tyler's
hypothesis: too-novel = noise, so keep rises then falls) relationship with keep / 5s-ret,
all held-out (70/30 × 40). Writes curves + stats → novelty_quantify.json for visualisation.

Quantifications (all = "how far from the dense centre", measured differently):
  mean        distance to the global mean embedding (single centre)
  knn5/15/50  mean cos-distance to the k nearest corpus hooks (local density; small k = local)
  niche8/25/80 distance to the nearest of K k-means centroids (multi-modal density)
  maha        Mahalanobis distance on PCA-whitened space (covariance-aware "how unusual")
  pcaresid10/50 PCA reconstruction residual (unusual COMBINATION, not just far)
  lowdensity  1 - mean similarity to the whole corpus (global density)
  mode        distance to the single densest corpus point (the most-typical exemplar)
"""
import io, json, numpy as np, boto3, warnings; warnings.filterwarnings('ignore')
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import PCA
from sklearn.linear_model import LinearRegression
from scipy.stats import spearmanr
import os
HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    for ln in open(HERE + '/.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
g = lambda k: s3.get_object(Bucket='business-world-videos', Key=k)['Body'].read()
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def rn(x): return np.linalg.norm(x, axis=1)

rt = json.loads(open(HERE + '/buildings/jarvis/retention-study/retention_table.json').read())
KEEP = {str(v['id']): float(v['keep_rate']) for v in rt['videos'] if v.get('keep_rate') is not None}
RET5 = {str(v['id']): float(v['ret5']) for v in rt['videos'] if v.get('ret5') is not None}

def quantify(Eo, Ec):
    """Eo = owned (n,d) normalised, Ec = corpus (N,d) normalised. Returns {name: novelty[n]}."""
    out = {}
    mu = Ec.mean(0); mu = mu / (np.linalg.norm(mu) + 1e-9)
    out['mean'] = 1 - Eo @ mu
    sims = Eo @ Ec.T                                   # (n, N) cosine sim
    ssrt = np.sort(sims, axis=1)
    for k in [5, 15, 50]: out[f'knn{k}'] = 1 - ssrt[:, -k - 1:-1].mean(1)   # excl self (the max)
    for K in [8, 25, 80]:
        cen = norm(MiniBatchKMeans(K, random_state=0, n_init=3, batch_size=1024).fit(Ec).cluster_centers_)
        out[f'niche{K}'] = 1 - (Eo @ cen.T).max(1)
    pw = PCA(50, whiten=True, random_state=0).fit(Ec); out['maha'] = rn(pw.transform(Eo))
    for n in [10, 50]:
        p = PCA(n, random_state=0).fit(Ec); rec = p.inverse_transform(p.transform(Eo))
        out[f'pcaresid{n}'] = rn(Eo - rec) / (rn(Eo) + 1e-9)
    out['lowdensity'] = 1 - sims.mean(1)
    # densest corpus point = highest mean-sim-to-its-15-NN; distance to it
    sc = np.sort(Ec @ Ec.T, axis=1)[:, -16:-1].mean(1); mode = Ec[int(np.argmax(sc))]
    out['mode'] = 1 - Eo @ mode
    return out

def holdout(x, y, seeds=40):
    """linear held-out rho, and inverted-U test: does adding x^2 help out-of-sample & is it concave?"""
    x = (x - x.mean()) / (x.std() + 1e-9)
    lin, quad_gain, concave = [], [], []
    for s in range(seeds):
        rs = np.random.default_rng(s); idx = rs.permutation(len(x)); c = int(len(x) * 0.7)
        tr, te = idx[:c], idx[c:]
        pl = LinearRegression().fit(x[tr, None], y[tr]).predict(x[te, None])
        lin.append(spearmanr(pl, y[te])[0])
        Xq = np.c_[x, x ** 2]
        mq = LinearRegression().fit(Xq[tr], y[tr]); pq = mq.predict(Xq[te])
        r2l = 1 - np.sum((y[te] - pl) ** 2) / np.sum((y[te] - y[te].mean()) ** 2)
        r2q = 1 - np.sum((y[te] - pq) ** 2) / np.sum((y[te] - y[te].mean()) ** 2)
        quad_gain.append(r2q - r2l); concave.append(mq.coef_[1] < 0)
    return float(np.mean(lin)), float(np.mean(quad_gain)), float(np.mean(concave))

def curve(x, y, nb=8):
    o = np.argsort(x); n = len(x); pts = []
    for b in range(nb):
        sl = o[b * n // nb:(b + 1) * n // nb]
        pts.append({'x': round(float(x[sl].mean()), 4), 'y': round(float(y[sl].mean()), 2), 'n': len(sl)})
    return pts

EMB = {}
for ck in ['visual', 'text', 'together']:
    z = np.load(io.BytesIO(g(f'raw/{ck}/embeddings.npz')), allow_pickle=True)
    EMB[ck] = ([str(x) for x in z['ids']], norm(np.asarray(z['vecs'], np.float32)))

results = []
print(f'{"modality":<9}{"method":<12}{"keep ρ":>8}{"hump?":>7}{"ret5 ρ":>9}')
for ck in ['visual', 'text', 'together']:
    ids, X = EMB[ck]; pos = {v: i for i, v in enumerate(ids)}
    own = [v for v in KEEP if v in RET5 and v in pos]
    Eo = X[[pos[v] for v in own]]
    yk = np.array([KEEP[v] for v in own]); yr = np.array([RET5[v] for v in own])
    Q = quantify(Eo, X)
    for name, nov in Q.items():
        lk, gk, ck2 = holdout(nov, yk); lr, gr, cr = holdout(nov, yr)
        hump = (gk > 0.003 and ck2 > 0.6)
        results.append({'modality': ck, 'method': name,
                        'keep_lin': round(lk, 3), 'keep_quadgain': round(gk, 4), 'keep_concave': round(ck2, 2),
                        'ret5_lin': round(lr, 3), 'ret5_quadgain': round(gr, 4), 'ret5_concave': round(cr, 2),
                        'hump': bool(hump), 'curve_keep': curve(nov, yk), 'curve_ret5': curve(nov, yr)})
        print(f'{ck:<9}{name:<12}{lk:>+8.3f}{("  U " if hump else "   ·"):>7}{lr:>+9.3f}')

results.sort(key=lambda d: -abs(d['keep_lin']))
out = {'n': len(EMB['together'][0]), 'splits': 40, 'results': results,
       'best_keep': results[0], 'note': 'sweep of novelty quantifications; hump=inverted-U held-out (quad gain + concave)'}
open(HERE + '/buildings/jarvis/retention-study/principles/novelty_quantify.json', 'w').write(json.dumps(out))
s3.put_object(Bucket='business-world-videos', Key='raw/principles/novelty_quantify.json', Body=json.dumps(out).encode(), ContentType='application/json')
print(f'\nbest keep linear: {results[0]["modality"]}/{results[0]["method"]} ρ={results[0]["keep_lin"]}')
hk = [r for r in results if r['hump']]
print(f'inverted-U (held-out) found in {len(hk)}/{len(results)}: ' + ', '.join(f"{r['modality']}/{r['method']}" for r in hk[:8]))
print('wrote novelty_quantify.json (served + R2).')
