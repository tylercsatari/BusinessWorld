#!/usr/bin/env python3
"""
FUSION — phase 2: the quant analysis on the feature table. Everything held-out,
FDR-controlled, confound-aware. Writes raw/fusion/report.json for the UI.

  - Univariate screen: each feature vs target (Spearman + bootstrap CI + permutation
    p + BH-FDR), PARTIAL Spearman controlling confounds, and AUC across view deciles.
  - Redundancy matrix (feature×feature corr) + INDEPENDENCE: partial correlation of
    each feature with the target controlling all others (precision-matrix method) —
    the "incremental information" read.
  - Fusion model: HistGradientBoosting (NaN-native), nested 5-fold CV, vs confounds-
    only and vs best single signal; permutation importance; calibration; per-decile AUC.
  - Consensus/lift: do independent signals AGREE → higher precision at the top.
  - Novelty hypotheses: inverted-U (quadratic) + coherence×novelty interaction.

Run: python3 fusion_analyze.py
"""
import os, io, json
import numpy as np, boto3
from scipy.stats import spearmanr, rankdata
from sklearn.ensemble import HistGradientBoostingRegressor, HistGradientBoostingClassifier
from sklearn.linear_model import Ridge
from sklearn.metrics import roc_auc_score, r2_score
from sklearn.model_selection import KFold
from sklearn.inspection import permutation_importance

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

RNG = np.random.RandomState(0)
z = np.load(io.BytesIO(r2_get('raw/fusion/features.npz') or open(os.path.join(HERE, 'fusion_features.npz'), 'rb').read()), allow_pickle=True)
names = [str(x) for x in z['names']]
X = np.asarray(z['X'], float)                 # N×F (with NaNs)
views = np.asarray(z['views'], float)
outlier = np.asarray(z['outlier'], float)
mine = np.asarray(z['mine'], bool)
# TWO targets: raw views (confound-dominated) and OUTLIER = views/subs (channel-
# controlled "hook overperformance" — the fairer test of what a hook can move).
TARGETS = {'views': np.asarray(z['log_views'], float),
           'outlier': np.asarray(z['log_outlier'], float)}
N, Fn = X.shape
meta = json.loads((r2_get('raw/fusion/features_meta.json') or b'{}').decode())
groups = meta.get('feature_groups', {})
CONF = groups.get('confounds', ['log_subs', 'log_age', 'log_dur', 'silent', 'has_text'])
HOOK = [n for n in names if n not in CONF]
ci = {n: i for i, n in enumerate(names)}
print(f'N={N} features={Fn} hook={len(HOOK)} confounds={len(CONF)}', flush=True)

# median-impute a copy for the LINEAR/correlation analyses (HGB uses raw NaN)
med = np.nanmedian(X, axis=0)
Xi = np.where(np.isfinite(X), X, med)
def col(n): return Xi[:, ci[n]]

def bh_fdr(ps):
    ps = np.asarray(ps); o = np.argsort(ps); m = len(ps); out = np.empty(m)
    run = 1.0
    for r in range(m - 1, -1, -1):
        run = min(run, ps[o[r]] * m / (r + 1)); out[o[r]] = run
    return out

allcols = HOOK + CONF
allidx = [ci[n] for n in allcols]; confidx = [ci[c] for c in CONF]
kf = KFold(5, shuffle=True, random_state=0)
HGB = dict(max_depth=3, learning_rate=0.06, max_iter=300, l2_regularization=1.0, random_state=0)
# shared (target-independent) redundancy matrix
Rmat = np.corrcoef(np.column_stack([rankdata(col(n)) for n in allcols]).T)

def analyze_target(y, label, raw, thr):
    print(f'\n=== target: {label} ===', flush=True)
    fin = np.isfinite(y)
    def resid_on_conf(v):
        A = np.column_stack([col(c) for c in CONF] + [np.ones(N)])
        beta, *_ = np.linalg.lstsq(A[fin], v[fin], rcond=None)
        r = np.full(N, np.nan); r[fin] = v[fin] - A[fin] @ beta
        return r
    yr = resid_on_conf(y)
    # ---- univariate ----
    print('  univariate…', flush=True)
    uni = []
    for n in HOOK + CONF:
        v = col(n); m = fin & np.isfinite(v)
        rho = spearmanr(v[m], y[m])[0]
        perm = [abs(spearmanr(RNG.permutation(v[m]), y[m])[0]) for _ in range(150)]
        p_perm = (1 + np.sum(np.array(perm) >= abs(rho))) / (1 + len(perm))
        idxm = np.where(m)[0]
        bs = [spearmanr(v[s], y[s])[0] for s in (RNG.choice(idxm, len(idxm), replace=True) for _ in range(150))]
        lo, hi2 = np.nanpercentile(bs, [2.5, 97.5])
        if n in HOOK:
            vr = resid_on_conf(v); mr = np.isfinite(vr) & np.isfinite(yr); prho = spearmanr(vr[mr], yr[mr])[0]
        else: prho = rho
        aucs = {}
        for nm, th in thr.items():
            lab = (raw[m] >= th).astype(int)
            if lab.sum() >= 10 and (len(lab) - lab.sum()) >= 10:
                try: aucs[nm] = round(float(roc_auc_score(lab, v[m])), 3)
                except Exception: aucs[nm] = None
        grp = next((g for g, fs in groups.items() if n in fs), 'other')
        uni.append({'feature': n, 'group': grp, 'spearman': round(float(rho), 3),
                    'ci': [round(float(lo), 3), round(float(hi2), 3)], 'p_perm': round(float(p_perm), 4),
                    'partial_spearman': round(float(prho), 3), 'auc': aucs, 'coverage': round(float(m.mean()), 3)})
    for u, q in zip(uni, bh_fdr([u['p_perm'] for u in uni])): u['fdr'] = round(float(q), 4); u['sig'] = bool(q < 0.05)
    uni.sort(key=lambda u: -abs(u['partial_spearman']))
    # ---- independence (partial corr of each feature w/ target | all others) ----
    print('  independence…', flush=True)
    aug = np.column_stack([rankdata(col(n)) for n in allcols] + [rankdata(y)])
    Cc = np.corrcoef(aug.T); ti = len(allcols)
    try:
        P = np.linalg.pinv(Cc)
        indep = [{'feature': allcols[i], 'partial_with_target': round(float(-P[i, ti] / np.sqrt(P[i, i] * P[ti, ti])), 3)} for i in range(ti)]
    except Exception: indep = []
    indep.sort(key=lambda d: -abs(d['partial_with_target']))
    # ---- fusion model ----
    print('  fusion model…', flush=True)
    Xh = X[fin]; yh = y[fin]; rawh = raw[fin]
    def cv_pred(idx, tgt):
        pred = np.full(len(tgt), np.nan)
        for tr, te in kf.split(Xh):
            e = HistGradientBoostingRegressor(**HGB).fit(Xh[tr][:, idx], tgt[tr]); pred[te] = e.predict(Xh[te][:, idx])
        return pred
    def cv_proba(idx, lab):
        pr = np.full(len(lab), np.nan)
        for tr, te in kf.split(Xh):
            c = HistGradientBoostingClassifier(**HGB).fit(Xh[tr][:, idx], lab[tr]); pr[te] = c.predict_proba(Xh[te][:, idx])[:, 1]
        return pr
    predfull = cv_pred(allidx, yh); predconf = cv_pred(confidx, yh); predhook = cv_pred([ci[n] for n in HOOK], yh)
    r2_full = r2_score(yh, predfull); r2_conf = r2_score(yh, predconf); r2_hook = r2_score(yh, predhook)
    sp_full = spearmanr(predfull, yh)[0]
    model_auc, best_single, hook_auc = {}, {}, {}
    for nm, th in thr.items():
        lab = (rawh >= th).astype(int)
        if lab.sum() < 10 or (len(lab) - lab.sum()) < 10: continue
        model_auc[nm] = round(float(roc_auc_score(lab, cv_proba(allidx, lab))), 3)
        hook_auc[nm] = round(float(roc_auc_score(lab, cv_proba([ci[n] for n in HOOK], lab))), 3)
        best_single[nm] = round(0.5 + max((abs(roc_auc_score(lab, np.nan_to_num(Xh[:, ci[n]], nan=med[ci[n]])) - 0.5) for n in HOOK), default=0), 3)
    tr = RNG.rand(len(yh)) < 0.7
    hgb = HistGradientBoostingRegressor(**HGB).fit(Xh[tr][:, allidx], yh[tr])
    pi = permutation_importance(hgb, Xh[~tr][:, allidx], yh[~tr], n_repeats=8, random_state=0)
    imp = sorted([{'feature': allcols[i], 'importance': round(float(pi.importances_mean[i]), 4), 'std': round(float(pi.importances_std[i]), 4)} for i in range(ti)], key=lambda d: -d['importance'])
    topname = list(thr)[-1]; topth = thr[topname]; labtop = (rawh >= topth).astype(int)
    probatop = cv_proba(allidx, labtop); order = np.argsort(probatop); cal = []
    for b in range(10):
        s = order[b * len(order) // 10:(b + 1) * len(order) // 10]
        cal.append({'bin': b, 'pred': round(float(probatop[s].mean()), 3), 'actual': round(float(labtop[s].mean()), 3), 'n': int(len(s))})
    # ---- consensus / lift (on the HOOK-only signal, top decile of target) ----
    print('  consensus…', flush=True)
    import itertools
    topfeat = [d['feature'] for d in indep if d['feature'] in HOOK][:3]
    def hib(n): v = col(n)[fin]; return v >= np.nanpercentile(v, 75)
    tophit = (rawh >= np.nanpercentile(rawh, 90)).astype(int); base = tophit.mean(); lift = []
    for r in range(1, len(topfeat) + 1):
        for combo in itertools.combinations(topfeat, r):
            msk = np.ones(len(rawh), bool)
            for n in combo: msk &= hib(n)
            if msk.sum() >= 20:
                lift.append({'signals': list(combo), 'n': int(msk.sum()), 'top10pct_rate': round(float(tophit[msk].mean()), 3), 'lift': round(float(tophit[msk].mean() / (base + 1e-9)), 2)})
    # ---- novelty hypotheses ----
    hyp = {}
    for n in [f for f in HOOK if 'nov' in f or f == 'coherence']:
        v = col(n); m = fin & np.isfinite(v); vv = (v[m] - v[m].mean()) / (v[m].std() + 1e-9)
        A = np.column_stack([vv, vv ** 2, np.ones(m.sum())]); beta, *_ = np.linalg.lstsq(A, y[m], rcond=None)
        hyp[n] = {'linear': round(float(beta[0]), 3), 'quad': round(float(beta[1]), 4), 'inverted_u': bool(beta[1] < 0 and abs(beta[1]) > 0.01), 'r2': round(float(r2_score(y[m], A @ beta)), 3)}
    inter = {}
    if 'coherence' in ci and 'vis_glob_nov' in ci:
        cm = fin & np.isfinite(col('coherence')) & np.isfinite(col('vis_glob_nov'))
        a = col('coherence')[cm] - col('coherence')[cm].mean(); b = col('vis_glob_nov')[cm] - col('vis_glob_nov')[cm].mean()
        beta, *_ = np.linalg.lstsq(np.column_stack([a, b, a * b, np.ones(cm.sum())]), y[cm], rcond=None)
        inter['coherence_x_visnov'] = {'interaction_coef': round(float(beta[2]), 4), 'n': int(cm.sum())}
    print(f'  R²full={r2_full:.3f} conf={r2_conf:.3f} hookOnly={r2_hook:.3f} (hook adds {r2_full-r2_conf:+.3f}) · top-AUC model {model_auc.get(topname)} hook {hook_auc.get(topname)} single {best_single.get(topname)}', flush=True)
    return {'thresholds': {k: float(v) for k, v in thr.items()}, 'univariate': uni, 'independence': indep,
            'fusion': {'r2_full': round(float(r2_full), 3), 'r2_confounds_only': round(float(r2_conf), 3), 'r2_hook_only': round(float(r2_hook), 3),
                       'hook_incremental_r2': round(float(r2_full - r2_conf), 3), 'spearman': round(float(sp_full), 3),
                       'model_auc_by_decile': model_auc, 'hook_auc_by_decile': hook_auc, 'best_single_auc_by_decile': best_single, 'importance': imp, 'calibration': cal},
            'consensus': {'base_top10pct': round(float(base), 3), 'lift': sorted(lift, key=lambda d: -d['lift'])},
            'novelty_hypotheses': {'shape': hyp, 'interactions': inter}}

DEC = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
thr_views = {f'top{int((1-q)*100)}': float(np.nanpercentile(views, q * 100)) for q in DEC}; thr_views['gt10M'] = 1e7
thr_out = {f'top{int((1-q)*100)}': float(np.nanpercentile(outlier[outlier > 0], q * 100)) for q in DEC}
results = {'views': analyze_target(TARGETS['views'], 'views', views, thr_views),
           'outlier': analyze_target(TARGETS['outlier'], 'outlier', outlier, thr_out)}

report = {
    'meta': {'n': N, 'n_with_text': int(np.isfinite(col('coherence')).sum()), 'n_mine': int(mine.sum()),
             'features': names, 'hook': HOOK, 'confounds': CONF, 'groups': groups, 'created': meta.get('created', '')},
    'redundancy': {'features': allcols, 'matrix': [[round(float(x), 2) for x in row] for row in Rmat]},
    'targets': results,
}
r2_put('raw/fusion/report.json', json.dumps(report).encode(), 'application/json')

print('\n===== HEADLINE =====', flush=True)
for tn, rr in results.items():
    f = rr['fusion']
    print(f'[{tn}] R²full={f["r2_full"]} conf={f["r2_confounds_only"]} hookOnly={f["r2_hook_only"]} (hook adds {f["hook_incremental_r2"]:+}) · Spearman {f["spearman"]}', flush=True)
    print('   top independent hook signals:', [f'{d["feature"]}={d["partial_with_target"]:+}' for d in rr['independence'] if d['feature'] in HOOK][:5], flush=True)
print('\nsaved → raw/fusion/report.json', flush=True)
