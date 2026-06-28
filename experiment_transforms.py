#!/usr/bin/env python3
"""
EXPERIMENT (honest, held-out) — two questions Tyler raised:

A) VIEW TRANSFORM: does orienting the 2D projection toward raw-views vs LOG-views
   vs rank vs sqrt change the structure / predictiveness? (The current 'views'
   projection already steers toward log10(views+1) — this measures whether that
   was the right call and whether a dedicated 'logviews' axis adds anything.)

B) KEEP STABILISATION: can a NON-LINEAR or OWNED-ANCHORED model beat the linear
   PLS we use to extrapolate keep% to the 11k — i.e. let your 211 actually SHAPE
   the corpus estimates instead of just rotating a linear axis? Each model is
   scored by 5-fold held-out Spearman on the 211 (the only ground truth), so the
   number is the real out-of-sample alignment, not a fit.

Prints a table. Does NOT write anything — decide from the numbers, then I wire the
winner into add_steered_proj.py + upload scoring.
Run: python3 experiment_transforms.py
"""
import os, io, json
import numpy as np, boto3
from scipy.stats import spearmanr, rankdata
from sklearn.cross_decomposition import PLSRegression
from sklearn.linear_model import Ridge
from sklearn.kernel_ridge import KernelRidge
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.neighbors import KNeighborsRegressor
from sklearn.decomposition import PCA
from sklearn.model_selection import KFold

HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    v = os.environ.get(k)
    if v: return v
    for ln in open(os.path.join(HERE, '.env')):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
def r2_get(k): return s3.get_object(Bucket=BUCKET, Key=k)['Body'].read()
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

CH = 'together'
z = np.load(io.BytesIO(r2_get(f'raw/{CH}/embeddings.npz')), allow_pickle=True)
ids = [str(x) for x in z['ids']]; V = norm(np.asarray(z['vecs'], np.float32))
views = np.asarray(z['views'], float)
mp = json.loads(r2_get(f'raw/{CH}/map.json')); mids = [str(x) for x in mp['id']]
print(f'{CH}: {len(ids)} embeddings, {len(mids)} map points\n')

# ---------- A) VIEW TRANSFORM ----------
print('A) VIEW-TRANSFORM — held-out r between a PLS axis steered toward each transform')
print('   and (i) its own transform, (ii) >10M membership (a transform-free yardstick).')
vv = views.copy(); vv[~np.isfinite(vv)] = 0
hi10 = (vv > 1e7).astype(float)
transforms = {
    'raw views':  vv,
    'LOG views':  np.log10(vv + 1),
    'rank views': rankdata(vv) / len(vv),
    'sqrt views': np.sqrt(vv),
}
kf = KFold(5, shuffle=True, random_state=0)
print(f'   {"transform":<12} {"held-out r(self)":>16} {"held-out r(>10M)":>17}')
for nm, y in transforms.items():
    oof = np.full(len(y), np.nan)
    for tr, te in kf.split(V): oof[te] = PLSRegression(1).fit(V[tr], y[tr]).predict(V[te]).ravel()
    rs = spearmanr(oof, y).correlation; rh = spearmanr(oof, hi10).correlation
    print(f'   {nm:<12} {rs:>16.3f} {rh:>17.3f}')
print('   → higher r(>10M) = the axis that best separates real hits (transform-agnostic test).\n')

# ---------- B) KEEP STABILISATION ----------
rt = json.loads(open(os.path.join(HERE, 'buildings/jarvis/retention-study/retention_table.json')).read())
KEEP = {str(v['id']): float(v['keep_rate']) for v in rt.get('videos', []) if v.get('keep_rate') is not None}
oi = [i for i, vid in enumerate(ids) if vid in KEEP]
Xo = V[oi]; yo = np.array([KEEP[ids[i]] for i in oi]); n = len(oi)
print(f'B) KEEP STABILISATION — {n} owned videos with real keep%, 5-fold held-out Spearman')
print(f'   (keep range {yo.min():.0f}–{yo.max():.0f}%, mean {yo.mean():.0f}%)\n')

def nw_owned(Xtr, ytr, Xte, bw=0.25):   # Nadaraya-Watson: each test video = RBF-weighted avg of TRAIN owned (owned SHAPE the estimate)
    d = 1 - Xte @ Xtr.T                  # cosine distance
    w = np.exp(-(d / bw) ** 2)
    return (w @ ytr) / (w.sum(1) + 1e-9)

P50 = PCA(50, random_state=0)
def pca50(Xtr, Xte): m = P50.fit(Xtr); return m.transform(Xtr), m.transform(Xte)

models = {
    'PLS(1) [current]':      lambda Xtr, ytr, Xte: PLSRegression(1).fit(Xtr, ytr).predict(Xte).ravel(),
    'Ridge a=50':            lambda Xtr, ytr, Xte: Ridge(50).fit(Xtr, ytr).predict(Xte),
    'KernelRidge RBF':       lambda Xtr, ytr, Xte: KernelRidge(alpha=1.0, kernel='rbf', gamma=2.0).fit(Xtr, ytr).predict(Xte),
    'HistGradBoost':         lambda Xtr, ytr, Xte: HistGradientBoostingRegressor(max_depth=3, max_iter=200, learning_rate=0.05).fit(Xtr, ytr).predict(Xte),
    'kNN k=15 (cos)':        lambda Xtr, ytr, Xte: KNeighborsRegressor(15, metric='cosine', weights='distance').fit(Xtr, ytr).predict(Xte),
    'NadWatson owned-RBF':   lambda Xtr, ytr, Xte: nw_owned(Xtr, ytr, Xte),
}
def pls_pca(Xtr, ytr, Xte):
    m = PCA(50, random_state=0).fit(Xtr); a, b = m.transform(Xtr), m.transform(Xte)
    return PLSRegression(1).fit(a, ytr).predict(b).ravel()
models['PLS on PCA50'] = pls_pca

# logit-target variant of the linear baseline (does squashing the bounded % help?)
def pls_logit(Xtr, ytr, Xte):
    p = np.clip(ytr / 100, 0.01, 0.99); lg = np.log(p / (1 - p))
    return PLSRegression(1).fit(Xtr, lg).predict(Xte).ravel()
models['PLS logit-keep'] = pls_logit

print(f'   {"model":<24} {"held-out ρ":>11}   {"pred-span (p5–p95)":>20}')
best = None
for nm, fn in models.items():
    oof = np.full(n, np.nan)
    for tr, te in kf.split(Xo):
        try: oof[te] = fn(Xo[tr], yo[tr], Xo[te])
        except Exception as e: oof[te] = np.nan
    if np.isnan(oof).all(): print(f'   {nm:<24} {"(failed)":>11}'); continue
    rho = spearmanr(oof, yo).correlation
    span = f'{np.nanpercentile(oof,5):.2f}–{np.nanpercentile(oof,95):.2f}'
    flag = ''
    if best is None or rho > best[1]: best = (nm, rho); flag = ' ←'
    print(f'   {nm:<24} {rho:>11.3f}   {span:>20}{flag}')
print(f'\n   BEST keep model: {best[0]} (held-out ρ={best[1]:.3f}) vs PLS baseline.')
print('   If the winner only ties PLS, keep PLS (simpler). If it beats it by >~0.03, wire it in.')
