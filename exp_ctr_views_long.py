#!/usr/bin/env python3
"""
EXPERIMENT: is there a single latent direction in the raw-long embedding that aligns with BOTH
click-through-rate AND views? CTR exists only for our ~47 owned videos; views exist for all ~7k.
So we fit a CTR direction (owned) and a views direction (all), sweep the blend between them, and
measure held-out alignment with CTR (owned, leave-one-out) and views (all, 5-fold) at each blend.
If some blend beats BOTH single-axis baselines on the joint metric, it's a real joint axis worth adding.
Also tries views targets: log-views, 5M+ and 10M+ binary classes.  Run: python3 exp_ctr_views_long.py
"""
import io, json, numpy as np, boto3, warnings; warnings.filterwarnings('ignore')
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import KFold
from scipy.stats import spearmanr
def env(k):
    for ln in open('.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
B = 'business-world-videos'
def r2(k): return s3.get_object(Bucket=B, Key=k)['Body'].read()
def nrm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

# owned CTR by id (from the account tables)
CTR = {}
for c in json.loads(r2('longform/channels.json'))['channels']:
    try:
        for v in json.loads(r2(f"longform/ret_{c['id']}.json")).get('videos', []):
            if v.get('id') and v.get('ctr') is not None: CTR[str(v['id'])] = float(v['ctr'])
    except Exception: pass
print(f"owned CTR labels: {len(CTR)}\n")

def dir_of(X, y, n=1):                      # PLS1 unit direction that best predicts y
    m = PLSRegression(n).fit(X, y); w = np.asarray(m.coef_).reshape(-1)
    return w / (np.linalg.norm(w) + 1e-9)
def cv_corr(X, y, folds=5):                 # honest held-out spearman of a PLS1 axis
    if len(y) < 8: return float('nan')
    kf = KFold(min(folds, len(y)), shuffle=True, random_state=0); oof = np.zeros(len(y))
    for tr, te in kf.split(X): oof[te] = PLSRegression(1).fit(X[tr], y[tr]).predict(X[te]).ravel()
    return abs(float(spearmanr(oof, y)[0]))
def loo_corr(X, y):                         # leave-one-out spearman (tiny n)
    oof = np.zeros(len(y))
    for i in range(len(y)):
        tr = [j for j in range(len(y)) if j != i]
        oof[i] = PLSRegression(1).fit(X[tr], y[tr]).predict(X[i:i+1]).ravel()[0]
    return abs(float(spearmanr(oof, y)[0]))

for ch in ['visual', 'text', 'together']:
    z = np.load(io.BytesIO(r2(f'raw-long/{ch}/embeddings.npz')), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; Xn = nrm(np.asarray(z['vecs'], np.float32))
    views = np.asarray(z['views'], float); lv = np.log10(views + 1)
    oi = np.array([i for i, v in enumerate(ids) if v in CTR])
    ctr = np.array([CTR[ids[i]] for i in oi])
    print(f"═══ {ch}: n={len(ids)}  owned-with-CTR={len(oi)}  (>5M {int((views>5e6).sum())}, >10M {int((views>1e7).sum())}) ═══")

    # single-axis honest baselines
    r_views_cv = cv_corr(Xn, lv)                         # views axis vs views (all)
    w_ctr_full = dir_of(Xn[oi], ctr)
    r_ctr_loo = loo_corr(Xn[oi], ctr)                    # CTR axis vs CTR (owned, LOO)
    # how does each single axis do on the OTHER metric (in-sample geometry)?
    w_views_full = dir_of(Xn, lv)
    r_ctr_on_views = abs(spearmanr((Xn @ w_ctr_full), lv)[0])          # CTR axis vs views (all)
    r_views_on_ctr = abs(spearmanr((Xn[oi] @ w_views_full), ctr)[0])   # views axis vs CTR (owned)
    print(f"  baselines: CTR-axis→CTR(LOO)={r_ctr_loo:.3f} but CTR-axis→views={r_ctr_on_views:.3f}  |  views-axis→views(CV)={r_views_cv:.3f} but views-axis→CTR={r_views_on_ctr:.3f}")

    # blend sweep + alternative views targets
    for tgt_name, ytgt in [('logviews', lv), ('>5M', (views > 5e6).astype(float)), ('>10M', (views > 1e7).astype(float))]:
        if ytgt.std() < 1e-9: continue
        w_v = dir_of(Xn, ytgt)
        best = None
        for a in np.linspace(0, 1, 11):
            blend = a * w_ctr_full + (1 - a) * w_v; blend /= (np.linalg.norm(blend) + 1e-9)
            proj = Xn @ blend
            rc = abs(float(spearmanr(proj[oi], ctr)[0]))            # joint: CTR alignment (owned)
            rv = abs(float(spearmanr(proj, ytgt)[0]))               # views alignment (all)
            joint = min(rc, rv)
            if best is None or joint > best[3]: best = (a, rc, rv, joint)
        a, rc, rv, j = best
        flag = '  ★ beats both single axes' if (j > r_ctr_on_views and j > r_views_on_ctr) else ''
        print(f"    target {tgt_name:9s}: best blend α_ctr={a:.1f} → CTR r={rc:.3f}, views r={rv:.3f}, JOINT(min)={j:.3f}{flag}")
    print()
