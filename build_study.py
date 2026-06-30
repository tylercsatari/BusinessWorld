#!/usr/bin/env python3
"""
build_study.py — recreate retention_study.json for ANY channel from its retention table
(keep / avg_retention / ret5 / curve / duration / views). The Retention→Views analysis tabs
(Views/Shape/Drivers/Duration/Predict) read this. NO embeddings — content-dependent fields
are left null/safe so the UI renders. Run: python3 build_study.py <id>  (id = R2 retention/<id>)
Writes R2 retention/study_<id>.json (+ local copy).
"""
import sys, io, json, os, numpy as np, warnings; warnings.filterwarnings('ignore')
from scipy.stats import spearmanr, pearsonr
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import KFold
HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    for ln in open(HERE + '/.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
import boto3
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')

def cv_r2(X, y, folds=5):
    X = np.asarray(X, float).reshape(len(y), -1); y = np.asarray(y, float)
    if len(y) < 8: return float('nan')
    kf = KFold(min(folds, len(y)), shuffle=True, random_state=0); oof = np.zeros(len(y))
    for tr, te in kf.split(X): oof[te] = LinearRegression().fit(X[tr], y[tr]).predict(X[te])
    ss = np.sum((y - y.mean()) ** 2)
    return float(1 - np.sum((y - oof) ** 2) / ss) if ss > 0 else 0.0

def resid_mult80(X, y):                       # ×/÷ band: 10–90 pct of residuals in log10
    X = np.asarray(X, float).reshape(len(y), -1)
    r = y - LinearRegression().fit(X, y).predict(X)
    return float(10 ** (np.percentile(r, 90) - np.percentile(r, 10)) ** 0.5) if len(r) > 3 else 1.0

def binmed(x, y, nb, label, unit, fmt=lambda v: v):
    x = np.asarray(x, float); out = []
    ok = np.isfinite(x); xs = np.sort(x[ok])
    qs = [np.quantile(xs, i / nb) for i in range(nb + 1)]
    for b in range(nb):
        lo, hi = qs[b], qs[b + 1]
        sel = (x >= lo) & (x <= hi if b == nb - 1 else x < hi) & ok
        if sel.sum() == 0: continue
        out.append({'label': f'{fmt(lo):.0f}-{fmt(hi):.0f}{unit}', 'median': float(np.median(y10[sel])), 'n': int(sel.sum())})
    return out

def partial(a, b, c):                          # partial spearman of a,b controlling c
    ra = a - LinearRegression().fit(np.c_[c], a).predict(np.c_[c])
    rb = b - LinearRegression().fit(np.c_[c], b).predict(np.c_[c])
    return float(spearmanr(ra, rb)[0])

cid = sys.argv[1] if len(sys.argv) > 1 else 'brushlabs'
T = json.loads(s3.get_object(Bucket='business-world-videos', Key=f'retention/{cid}.json')['Body'].read())
V = [v for v in T['videos'] if v.get('keep_rate') is not None and v.get('views')]
keep = np.array([v['keep_rate'] for v in V], float)
ret = np.array([v.get('avg_retention') if v.get('avg_retention') is not None else np.nan for v in V], float)
ret5 = np.array([v.get('ret5') if v.get('ret5') is not None else np.nan for v in V], float)
dur = np.array([v.get('duration_s') or np.nan for v in V], float)
views = np.array([v['views'] for v in V], float)
lv = np.log10(views + 1); y10 = views; ldur = np.log10(np.where(dur > 0, dur, np.nan))
curves = [v.get('curve') for v in V]
n = len(V)
print(f'{cid}: n={n}', flush=True)
# fill missing ret/ret5/dur with medians so models run
for arr in (ret, ret5, ldur):
    m = np.nanmedian(arr); arr[~np.isfinite(arr)] = m if np.isfinite(m) else 0

def sp(a): return float(spearmanr(a, lv)[0]) if np.isfinite(a).all() else 0.0
def pe(a): return float(pearsonr(a, lv)[0])

scatter = [{'id': v['id'], 'name': v.get('title') or v['id'], 'url': v.get('url', ''),
            'keep': round(float(keep[i]), 1), 'ret': round(float(ret[i]), 1), 'ret5': round(float(ret5[i]), 1),
            'dur': int(dur[i]) if np.isfinite(dur[i]) else None, 'views': int(views[i]), 'lv': round(float(lv[i]), 3),
            'hook': None, 'tail': None, 'pc1': None, 'nonsub_keep': v.get('nonsub_keep') or 0, 'share_rate': None}
           for i, v in enumerate(V)]

# ── shape: PCA on the 100-pt curves ──
C = np.array([c for c in curves if c and len(c) == 100], float)
mean_curve = C.mean(0).tolist() if len(C) else [1] * 100
if len(C) >= 8:
    Cc = C - C.mean(0); U, Sg, Wt = np.linalg.svd(Cc, full_matrices=False)
    pc1 = Wt[0]; sc1 = Cc @ pc1
    if np.corrcoef(sc1, [np.mean(c[60:]) for c in C])[0, 1] < 0: pc1 = -pc1; sc1 = -sc1
    sd = sc1.std()
    mode1_plus = (C.mean(0) + 1.5 * sd * pc1).tolist(); mode1_minus = (C.mean(0) - 1.5 * sd * pc1).tolist()
    # attach pc1 score to scatter
    j = 0
    for i, c in enumerate(curves):
        if c and len(c) == 100: scatter[i]['pc1'] = round(float(sc1[j]), 3); j += 1
    shape_score = np.array([s['pc1'] if s['pc1'] is not None else 0 for s in scatter], float)
    cv_avg = cv_r2(ret, lv); cv_avg_shape = cv_r2(np.c_[ret, shape_score], lv)
else:
    mode1_plus = mode1_minus = mean_curve; shape_score = np.zeros(n); cv_avg = cv_r2(ret, lv); cv_avg_shape = cv_avg

# ── indicators (retention-side only; content left out) ──
IND = [('keep', 'Keep rate', '%', keep), ('retention', 'Avg retention', '%', ret), ('ret5', '5-sec retention', '%', ret5),
       ('log_dur', 'Duration (log)', '', ldur), ('shape_pc1', 'Shape mode 1', '', shape_score)]
inds = []
for k, lab, u, a in IND:
    pk = partial(a, lv, np.c_[keep, ret]) if k not in ('keep', 'retention') else None
    inds.append({'key': k, 'label': lab, 'unit': u, 'usable': True, 'spearman': round(sp(a), 3),
                 'partial_kr': round(pk, 3) if pk is not None else None})
# corr matrix
mat = [keep, ret, ret5, ldur, shape_score]; rho = [[round(float(spearmanr(a, b)[0]), 2) for b in mat] for a in mat]
corr_matrix = {'keys': [i[0] for i in IND], 'labels': [i[1] for i in IND], 'rho': rho}

# ── selection (greedy) ──
base_cv = cv_r2(np.c_[keep, ret], lv); base_mult = resid_mult80(np.c_[keep, ret], lv)
def greedy(cands):
    chosen = [keep, ret]; chosen_lab = []; path = []
    pool = list(cands)
    while pool:
        best = None
        for lab, a in pool:
            r2 = cv_r2(np.c_[tuple(chosen) + (a,)], lv)
            if best is None or r2 > best[1]: best = (lab, r2, a)
        if best[1] <= (path[-1]['cv_r2'] if path else base_cv) + 0.002: break
        chosen.append(best[2]); chosen_lab.append(best[0]); path.append({'label': best[0], 'cv_r2': round(best[1], 3), 'range_mult': round(resid_mult80(np.c_[tuple(chosen)], lv), 1)})
        pool = [(l, a) for l, a in pool if l != best[0]]
    return path
interp_path = greedy([('Duration', ldur), ('5-sec retention', ret5)])
full_path = greedy([('Duration', ldur), ('5-sec retention', ret5), ('Shape mode 1', shape_score)])
def lastor(path, k, d): return path[-1][k] if path else d
selection = {'baseline_cv_r2': round(base_cv, 3), 'baseline_range_mult': round(base_mult, 1),
             'interp': {'path': interp_path, 'cv_r2': lastor(interp_path, 'cv_r2', round(base_cv, 3)), 'range_mult': lastor(interp_path, 'range_mult', round(base_mult, 1))},
             'full': {'path': full_path, 'cv_r2': lastor(full_path, 'cv_r2', round(base_cv, 3)), 'range_mult': lastor(full_path, 'range_mult', round(base_mult, 1))}}

# ── interaction grid (keep × retention) ──
def grid(a, b, nb=3):
    qa = [np.quantile(a, i / nb) for i in range(nb + 1)]; qb = [np.quantile(b, i / nb) for i in range(nb + 1)]
    gm = [[None] * nb for _ in range(nb)]; gn = [[0] * nb for _ in range(nb)]
    for i in range(nb):
        for j in range(nb):
            sel = (a >= qa[i]) & (a <= qa[i + 1]) & (b >= qb[j]) & (b <= qb[j + 1])
            if sel.sum(): gm[i][j] = float(np.median(views[sel])); gn[i][j] = int(sel.sum())
    return qa, qb, gm, gn
qk, qr, gm, gn = grid(keep, ret)
add_cv = cv_r2(np.c_[keep, ret], lv); int_cv = cv_r2(np.c_[keep, ret, keep * ret], lv)

def feat_meta(a, lab, u, transform='none'):
    return {'label': lab, 'unit': u, 'transform': transform, 'min': round(float(np.nanmin(a)), 1), 'max': round(float(np.nanmax(a)), 1), 'default': round(float(np.nanmedian(a)), 1)}

# every feature-subset model (for the Predict tab's "every model compared" panel)
from itertools import combinations
FEATS = {'keep': keep, 'retention': ret, 'ret5': ret5, 'log_dur': ldur}
def fit_subset(names):
    X = np.column_stack([FEATS[f] for f in names]); m = LinearRegression().fit(X, lv); resid = lv - m.predict(X)
    return {'features': list(names), 'coef': {f: round(float(c), 5) for f, c in zip(names, m.coef_)}, 'intercept': round(float(m.intercept_), 5), 'resid_sd_log10': round(float(resid.std()), 5), 'cv_r2': round(cv_r2(X, lv), 3)}
subsets = {}
for r in range(1, 5):
    for combo in combinations(['keep', 'retention', 'ret5', 'log_dur'], r): subsets['+'.join(combo)] = fit_subset(combo)

study = {
    'meta': {'n': n, 'target': 'views', 'metric': 'log10', 'caveat': f'{cid}: {n} videos' + (' — small sample, treat cross-validated numbers as rough' if n < 40 else '')},
    'scatter': scatter, 'curve_mean': [round(x, 4) for x in mean_curve],
    'Q1': {'lenses': {'keep': {'spearman': sp(keep), 'pearson_log': pe(keep)}, 'retention': {'spearman': sp(ret), 'pearson_log': pe(ret)}, 'keep_vs_retention': round(float(spearmanr(keep, ret)[0]), 3)},
           'bins': {'views_by_keep': binmed(keep, lv, min(5, max(2, n // 4)), 'keep', '%'), 'views_by_retention': binmed(ret, lv, min(5, max(2, n // 4)), 'ret', '%')},
           'cv_r2': {'keep_alone': cv_r2(keep, lv), 'retention_alone': cv_r2(ret, lv), 'both': base_cv},
           'content_unique_r2': 0.0, 'content_unique_ci90': [0.0, 0.0], 'view_range_mult_80pct': round(base_mult, 1)},
    'Q2': {'mean_curve': [round(x, 4) for x in mean_curve], 'mode1_plus': [round(x, 4) for x in mode1_plus], 'mode1_minus': [round(x, 4) for x in mode1_minus],
           'cv_r2_avg': round(cv_avg, 3), 'cv_r2_avg_plus_shape': round(cv_avg_shape, 3), 'shape_delta': round(cv_avg_shape - cv_avg, 3),
           'mode_level_corr': round(float(spearmanr(shape_score, ret)[0]), 3), 'views_by_shape': binmed(shape_score, lv, min(5, max(2, n // 4)), 'shape', '')},
    'Q3': {'keep_from_retention_cv_r2': round(cv_r2(ret, keep), 3), 'keep_resid_sd_pct': round(float(np.std(keep - LinearRegression().fit(np.c_[ret], keep).predict(np.c_[ret]))), 1),
           'keep_adds_for_views': round(base_cv - cv_r2(ret, lv), 3)},
    'Q4': {'views_by_duration': binmed(dur, lv, min(5, max(2, n // 4)), 'dur', 's'), 'duration_lens': {'spearman': sp(ldur)},
           'cv_r2_content_only': round(base_cv, 3), 'cv_r2_plus_duration': round(cv_r2(np.c_[keep, ret, ldur], lv), 3),
           'cv_r2_plus_duration_interactions': round(cv_r2(np.c_[keep, ret, ldur, keep * ldur, ret * ldur], lv), 3),
           'duration_unique_r2': round(cv_r2(np.c_[keep, ret, ldur], lv) - base_cv, 3),
           'partial_keep_given_dur': round(partial(keep, lv, np.c_[ldur]), 3), 'partial_retention_given_dur': round(partial(ret, lv, np.c_[ldur]), 3)},
    'interaction': {'keep_edges': [round(float(x), 1) for x in qk], 'ret_edges': [round(float(x), 1) for x in qr], 'grid_median_views': gm, 'grid_n': gn,
                    'additive_cv_r2': round(add_cv, 3), 'with_interaction_cv_r2': round(int_cv, 3), 'interaction_delta_r2': round(int_cv - add_cv, 3)},
    'indicators': inds, 'corr_matrix': corr_matrix, 'selection': selection,
    'predictor': {'order': ['keep', 'retention', 'ret5', 'log_dur'],
                  'feat_meta': {'keep': feat_meta(keep, 'Keep rate', '%'), 'retention': feat_meta(ret, 'Avg retention', '%'),
                                'ret5': feat_meta(ret5, '5-sec retention', '%'), 'log_dur': {'label': 'Duration', 'unit': 's', 'transform': 'log', 'min': float(np.nanmin(dur)), 'max': float(np.nanmax(dur)), 'default': round(float(np.nanmedian(dur)))}},
                  'ranges': {'keep': [round(float(keep.min()), 1), round(float(keep.max()), 1)], 'retention': [round(float(np.nanmin(ret)), 1), round(float(np.nanmax(ret)), 1)], 'duration': [int(np.nanmin(dur)), int(np.nanmax(dur))]},
                  'medians': {'keep': round(float(np.median(keep)), 1), 'retention': round(float(np.nanmedian(ret)), 1), 'duration': int(np.nanmedian(dur))},
                  'subsets': subsets},
}
out = json.dumps(study).encode()
open(HERE + f'/buildings/jarvis/retention-study/retention/study_{cid}.json', 'w').write(out.decode())
s3.put_object(Bucket='business-world-videos', Key=f'retention/study_{cid}.json', Body=out, ContentType='application/json')
print(f'{cid}: study built · keep→views ρ={sp(keep):.2f} · keep+ret CV R²={base_cv:.2f} · +dur={selection["interp"]["cv_r2"]} · wrote R2 retention/study_{cid}.json ({len(out)//1024}KB)', flush=True)
