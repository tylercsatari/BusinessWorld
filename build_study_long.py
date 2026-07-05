#!/usr/bin/env python3
"""
build_study_long.py — LONG-FORM sibling of build_study.py. Recreates the study JSON the Long Quant
analysis tabs (Views/Shape/Drivers/Duration/Predict) read, from a channel's scraped long-form table
(ctr / avg_retention / ret30 / curve / duration / views / impressions).

Feature set is CTR + retention + 30s-retention + duration → views (vs shorts' keep + retention + ret5).
CONFOUNDS: duration is the in-model deconfound (partial-Spearman on log_dur), exactly like shorts;
IMPRESSIONS is the long-form-specific distribution confound shorts never had — quantified separately
(distribution ceiling + content levers' partial effect controlling for BOTH duration and impressions).

Run: python3 build_study_long.py <id>     (id = tyler|brushlabs|creatinganything|hafu, or "all" to pool)
Reads R2 longform/ret_<id>.json ; writes R2 longform/study_<id>.json (+ local copy).
"""
import sys, json, os, numpy as np, warnings; warnings.filterwarnings('ignore')
from scipy.stats import spearmanr, pearsonr
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import KFold
from itertools import combinations
HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    for ln in open(HERE + '/.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
import boto3
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
BUCKET = 'business-world-videos'

def cv_r2(X, y, folds=5):
    X = np.asarray(X, float).reshape(len(y), -1); y = np.asarray(y, float)
    if len(y) < 8: return float('nan')
    kf = KFold(min(folds, len(y)), shuffle=True, random_state=0); oof = np.zeros(len(y))
    for tr, te in kf.split(X): oof[te] = LinearRegression().fit(X[tr], y[tr]).predict(X[te])
    ss = np.sum((y - y.mean()) ** 2)
    return float(1 - np.sum((y - oof) ** 2) / ss) if ss > 0 else 0.0

def resid_mult80(X, y):                       # ×/÷ band: 10–90 pct of log10 residuals
    X = np.asarray(X, float).reshape(len(y), -1)
    r = y - LinearRegression().fit(X, y).predict(X)
    return float(10 ** ((np.percentile(r, 90) - np.percentile(r, 10)) / 2)) if len(r) > 3 else 1.0

def binmed(x, y, nb, unit, fmt=lambda v: v):
    x = np.asarray(x, float); out = []
    ok = np.isfinite(x); xs = np.sort(x[ok])
    if len(xs) == 0: return out
    qs = [np.quantile(xs, i / nb) for i in range(nb + 1)]
    for b in range(nb):
        lo, hi = qs[b], qs[b + 1]
        sel = (x >= lo) & (x <= hi if b == nb - 1 else x < hi) & ok
        if sel.sum() == 0: continue
        out.append({'label': f'{fmt(lo):.0f}-{fmt(hi):.0f}{unit}', 'median': float(np.median(y10[sel])), 'n': int(sel.sum())})
    return out

def partial(a, b, c):                          # partial spearman of a,b controlling c (c can be 1+ columns)
    C = np.asarray(c, float).reshape(len(a), -1)
    ra = a - LinearRegression().fit(C, a).predict(C)
    rb = b - LinearRegression().fit(C, b).predict(C)
    return float(spearmanr(ra, rb)[0])

# ── load the table(s) ──
cid = sys.argv[1] if len(sys.argv) > 1 else 'hafu'
def load_table(key):
    return json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
if cid == 'all':
    reg = load_table('longform/channels.json')
    V, srcs = [], []
    for c in reg['channels']:
        try:
            t = load_table(f"longform/ret_{c['id']}.json"); vv = t.get('videos', [])
            V += vv; srcs.append({'id': c['id'], 'name': c['name'], 'n': len(vv)})
        except Exception: pass
    meta_sources = srcs
else:
    T = load_table(f'longform/ret_{cid}.json'); V = T.get('videos', []); meta_sources = None

V = [v for v in V if v.get('ctr') is not None and v.get('views')]
ctr = np.array([v['ctr'] for v in V], float)
ret = np.array([v.get('avg_retention') if v.get('avg_retention') is not None else np.nan for v in V], float)
ret30 = np.array([v.get('ret30') if v.get('ret30') is not None else np.nan for v in V], float)
dur = np.array([v.get('duration_s') or np.nan for v in V], float)
impr = np.array([v.get('impressions') or np.nan for v in V], float)
views = np.array([v['views'] for v in V], float)
lv = np.log10(views + 1); y10 = views
ldur = np.log10(np.where(dur > 0, dur, np.nan))
limpr = np.log10(np.where(impr > 0, impr, np.nan))
curves = [v.get('curve') for v in V]
n = len(V)
print(f'{cid}: n={n}', flush=True)
if n < 8:
    # too few for any cross-validated model — don't write a study; the tab gates ("not computed yet")
    print(f'{cid}: only {n} usable videos — skipping (analysis sections will gate until it has ≥8).', flush=True)
    sys.exit(0)
# fill missing with medians so models run
for arr in (ret, ret30, ldur, limpr):
    m = np.nanmedian(arr); arr[~np.isfinite(arr)] = m if np.isfinite(m) else 0

def sp(a): return float(spearmanr(a, lv)[0]) if np.isfinite(a).all() and n >= 3 else 0.0
def pe(a): return float(pearsonr(a, lv)[0]) if n >= 3 else 0.0

scatter = [{'id': v['id'], 'name': v.get('title') or v['id'], 'url': v.get('url', ''),
            'ctr': round(float(ctr[i]), 2), 'ret': round(float(ret[i]), 1), 'ret30': round(float(ret30[i]), 1),
            'dur': int(dur[i]) if np.isfinite(dur[i]) else None, 'impressions': int(impr[i]) if np.isfinite(impr[i]) else None,
            'views': int(views[i]), 'lv': round(float(lv[i]), 3),
            'hook': None, 'tail': None, 'pc1': None, 'nonsub_keep': 0, 'share_rate': None}
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
    j = 0
    for i, c in enumerate(curves):
        if c and len(c) == 100: scatter[i]['pc1'] = round(float(sc1[j]), 3); j += 1
    shape_score = np.array([s['pc1'] if s['pc1'] is not None else 0 for s in scatter], float)
    cv_avg = cv_r2(ret, lv); cv_avg_shape = cv_r2(np.c_[ret, shape_score], lv)
else:
    mode1_plus = mode1_minus = mean_curve; shape_score = np.zeros(n); cv_avg = cv_r2(ret, lv); cv_avg_shape = cv_avg

# ── indicators (content levers, duration-deconfounded; impressions flagged distribution-side) ──
IND = [('ctr', 'CTR', '%', ctr), ('retention', 'Avg retention', '%', ret), ('ret30', '30-sec retention', '%', ret30),
       ('log_dur', 'Duration (log)', '', ldur), ('shape_pc1', 'Shape mode 1', '', shape_score)]
inds = []
for k, lab, u, a in IND:
    pk = partial(a, lv, np.c_[ctr, ret]) if k not in ('ctr', 'retention') else None
    inds.append({'key': k, 'label': lab, 'unit': u, 'usable': True, 'spearman': round(sp(a), 3),
                 'partial_kr': round(pk, 3) if pk is not None else None})
# impressions = distribution-side (algorithm push): a driver of raw views, NOT a content lever you set
inds.append({'key': 'impressions', 'label': 'Impressions', 'unit': '', 'usable': False, 'spearman': round(sp(limpr), 3),
             'partial_kr': None, 'note': 'distribution-side: how much YouTube pushed it. Drives raw views but is downstream of the algorithm, not a content lever — excluded from the predictor.'})
# corr matrix (content levers + shape)
mat = [ctr, ret, ret30, ldur, shape_score]; rho = [[round(float(spearmanr(a, b)[0]), 2) for b in mat] for a in mat]
corr_matrix = {'keys': [i[0] for i in IND], 'labels': [i[1] for i in IND], 'rho': rho}

# ── CONFOUNDS: duration (in-model) + impressions (distribution) ──
# distribution ceiling = how much of views is just how-much-it-was-pushed; content levers' partial
# effect controlling for BOTH duration and impressions = does good CTR/retention predict views at
# fixed distribution. impressed_views = impressions × CTR is mechanically part of views, so raw
# CTR→views is partly distribution; this isolates the content signal.
confounds = {
    'distribution_r2': round(cv_r2(limpr, lv), 3),                                  # views ~ log(impressions) alone
    'content_r2': round(cv_r2(np.c_[ctr, ret, ret30, ldur], lv), 3),               # views ~ the 4 content levers
    'content_plus_distribution_r2': round(cv_r2(np.c_[ctr, ret, ret30, ldur, limpr], lv), 3),
    'ctr_given_dur_impr': round(partial(ctr, lv, np.c_[ldur, limpr]), 3),          # content effect at fixed dur+distribution
    'retention_given_dur_impr': round(partial(ret, lv, np.c_[ldur, limpr]), 3),
    'ret30_given_dur_impr': round(partial(ret30, lv, np.c_[ldur, limpr]), 3),
    'ctr_impr_corr': round(float(spearmanr(ctr, limpr)[0]), 3),                    # do better thumbnails get more push?
    'note': 'Raw views are dominated by impressions (distribution). content_r2 vs distribution_r2 shows content-vs-push; the *_given_dur_impr partials are each lever’s pull on views at FIXED duration and distribution.'
}

# ── selection (greedy) ──
base_cv = cv_r2(np.c_[ctr, ret], lv); base_mult = resid_mult80(np.c_[ctr, ret], lv)
def greedy(cands):
    chosen = [ctr, ret]; path = []
    pool = list(cands)
    while pool:
        best = None
        for lab, a in pool:
            r2 = cv_r2(np.c_[tuple(chosen) + (a,)], lv)
            if best is None or r2 > best[1]: best = (lab, r2, a)
        if best[1] <= (path[-1]['cv_r2'] if path else base_cv) + 0.002: break
        chosen.append(best[2]); path.append({'label': best[0], 'cv_r2': round(best[1], 3), 'range_mult': round(resid_mult80(np.c_[tuple(chosen)], lv), 1)})
        pool = [(l, a) for l, a in pool if l != best[0]]
    return path
interp_path = greedy([('Duration', ldur), ('30-sec retention', ret30)])
full_path = greedy([('Duration', ldur), ('30-sec retention', ret30), ('Shape mode 1', shape_score)])
def lastor(path, k, d): return path[-1][k] if path else d
selection = {'baseline_cv_r2': round(base_cv, 3), 'baseline_range_mult': round(base_mult, 1),
             'interp': {'path': interp_path, 'cv_r2': lastor(interp_path, 'cv_r2', round(base_cv, 3)), 'range_mult': lastor(interp_path, 'range_mult', round(base_mult, 1))},
             'full': {'path': full_path, 'cv_r2': lastor(full_path, 'cv_r2', round(base_cv, 3)), 'range_mult': lastor(full_path, 'range_mult', round(base_mult, 1))}}

# ── interaction grid (ctr × retention); key names kept as keep_edges/ret_edges for the heatmap ──
def grid(a, b, nb=3):
    qa = [np.quantile(a, i / nb) for i in range(nb + 1)]; qb = [np.quantile(b, i / nb) for i in range(nb + 1)]
    gm = [[None] * nb for _ in range(nb)]; gn = [[0] * nb for _ in range(nb)]
    for i in range(nb):
        for j in range(nb):
            sel = (a >= qa[i]) & (a <= qa[i + 1]) & (b >= qb[j]) & (b <= qb[j + 1])
            if sel.sum(): gm[i][j] = float(np.median(views[sel])); gn[i][j] = int(sel.sum())
    return qa, qb, gm, gn
qk, qr, gm, gn = grid(ctr, ret)
add_cv = cv_r2(np.c_[ctr, ret], lv); int_cv = cv_r2(np.c_[ctr, ret, ctr * ret], lv)

def feat_meta(a, lab, u, transform='none'):
    return {'label': lab, 'unit': u, 'transform': transform, 'min': round(float(np.nanmin(a)), 1), 'max': round(float(np.nanmax(a)), 1), 'default': round(float(np.nanmedian(a)), 1)}

# every feature-subset model (for the Predict "every model compared" panel)
FEATS = {'ctr': ctr, 'retention': ret, 'ret30': ret30, 'log_dur': ldur}
def fit_subset(names):
    X = np.column_stack([FEATS[f] for f in names]); m = LinearRegression().fit(X, lv); resid = lv - m.predict(X)
    return {'features': list(names), 'coef': {f: round(float(c), 5) for f, c in zip(names, m.coef_)}, 'intercept': round(float(m.intercept_), 5), 'resid_sd_log10': round(float(resid.std()), 5), 'cv_r2': round(cv_r2(X, lv), 3)}
subsets = {}
for r in range(1, 5):
    for combo in combinations(['ctr', 'retention', 'ret30', 'log_dur'], r): subsets['+'.join(combo)] = fit_subset(combo)

nb = min(5, max(2, n // 4))
study = {
    'meta': {'n': n, 'target': 'views', 'metric': 'log10', 'sources': meta_sources,
             'caveat': f'{cid}: {n} videos' + (' — small sample, treat cross-validated numbers as rough' if n < 40 else '')},
    'scatter': scatter, 'curve_mean': [round(x, 4) for x in mean_curve], 'confounds': confounds,
    'Q1': {'lenses': {'ctr': {'spearman': sp(ctr), 'pearson_log': pe(ctr)}, 'retention': {'spearman': sp(ret), 'pearson_log': pe(ret)}, 'ctr_vs_retention': round(float(spearmanr(ctr, ret)[0]), 3)},
           'bins': {'views_by_ctr': binmed(ctr, lv, nb, '%'), 'views_by_retention': binmed(ret, lv, nb, '%')},
           'cv_r2': {'ctr_alone': cv_r2(ctr, lv), 'retention_alone': cv_r2(ret, lv), 'both': base_cv},
           'content_unique_r2': 0.0, 'content_unique_ci90': [0.0, 0.0], 'view_range_mult_80pct': round(base_mult, 1)},
    'Q2': {'mean_curve': [round(x, 4) for x in mean_curve], 'mode1_plus': [round(x, 4) for x in mode1_plus], 'mode1_minus': [round(x, 4) for x in mode1_minus],
           'cv_r2_avg': round(cv_avg, 3), 'cv_r2_avg_plus_shape': round(cv_avg_shape, 3), 'shape_delta': round(cv_avg_shape - cv_avg, 3),
           'mode_level_corr': round(float(spearmanr(shape_score, ret)[0]), 3), 'views_by_shape': binmed(shape_score, lv, nb, '')},
    'Q3': {'ctr_from_retention_cv_r2': round(cv_r2(ret, ctr), 3), 'ctr_resid_sd_pct': round(float(np.std(ctr - LinearRegression().fit(np.c_[ret], ctr).predict(np.c_[ret]))), 1),
           'ctr_adds_for_views': round(base_cv - cv_r2(ret, lv), 3)},
    'Q4': {'views_by_duration': binmed(dur, lv, nb, 's'), 'duration_lens': {'spearman': sp(ldur)},
           'cv_r2_content_only': round(base_cv, 3), 'cv_r2_plus_duration': round(cv_r2(np.c_[ctr, ret, ldur], lv), 3),
           'cv_r2_plus_duration_interactions': round(cv_r2(np.c_[ctr, ret, ldur, ctr * ldur, ret * ldur], lv), 3),
           'duration_unique_r2': round(cv_r2(np.c_[ctr, ret, ldur], lv) - base_cv, 3),
           'partial_ctr_given_dur': round(partial(ctr, lv, np.c_[ldur]), 3), 'partial_retention_given_dur': round(partial(ret, lv, np.c_[ldur]), 3)},
    'interaction': {'keep_edges': [round(float(x), 2) for x in qk], 'ret_edges': [round(float(x), 1) for x in qr], 'grid_median_views': gm, 'grid_n': gn,
                    'additive_cv_r2': round(add_cv, 3), 'with_interaction_cv_r2': round(int_cv, 3), 'interaction_delta_r2': round(int_cv - add_cv, 3)},
    'indicators': inds, 'corr_matrix': corr_matrix, 'selection': selection,
    'predictor': {'order': ['ctr', 'retention', 'ret30', 'log_dur'],
                  'feat_meta': {'ctr': feat_meta(ctr, 'CTR', '%'), 'retention': feat_meta(ret, 'Avg retention', '%'),
                                'ret30': feat_meta(ret30, '30-sec retention', '%'), 'log_dur': {'label': 'Duration', 'unit': 's', 'transform': 'log', 'min': float(np.nanmin(dur)), 'max': float(np.nanmax(dur)), 'default': round(float(np.nanmedian(dur)))}},
                  'ranges': {'ctr': [round(float(ctr.min()), 2), round(float(ctr.max()), 2)], 'retention': [round(float(np.nanmin(ret)), 1), round(float(np.nanmax(ret)), 1)], 'duration': [int(np.nanmin(dur)), int(np.nanmax(dur))]},
                  'medians': {'ctr': round(float(np.median(ctr)), 2), 'retention': round(float(np.nanmedian(ret)), 1), 'duration': int(np.nanmedian(dur))},
                  'subsets': subsets},
}
# aliases so the existing (shorts-named) Views/Shape/Drivers/Duration render fns light up without a JS
# rewire. Predict already uses ctr/ret30. Those 4 tabs' visible labels still read the shorts terms
# ("Keep rate", "5-sec") until the JS is relabelled — the DATA under them is CTR/30s-retention.
for s in study['scatter']:
    s['keep'] = s['ctr']; s['ret5'] = s['ret30']
study['Q1']['lenses']['keep'] = study['Q1']['lenses']['ctr']
study['Q1']['lenses']['keep_vs_retention'] = study['Q1']['lenses']['ctr_vs_retention']
study['Q1']['bins']['views_by_keep'] = study['Q1']['bins']['views_by_ctr']
study['Q1']['cv_r2']['keep_alone'] = study['Q1']['cv_r2']['ctr_alone']
study['Q3']['keep_from_retention_cv_r2'] = study['Q3']['ctr_from_retention_cv_r2']
study['Q3']['keep_resid_sd_pct'] = study['Q3']['ctr_resid_sd_pct']
study['Q3']['keep_adds_for_views'] = study['Q3']['ctr_adds_for_views']
study['Q4']['partial_keep_given_dur'] = study['Q4']['partial_ctr_given_dur']

out = json.dumps(study).encode()
os.makedirs(HERE + '/buildings/jarvis/longform-study/retention', exist_ok=True)
open(HERE + f'/buildings/jarvis/longform-study/retention/study_{cid}.json', 'w').write(out.decode())
s3.put_object(Bucket=BUCKET, Key=f'longform/study_{cid}.json', Body=out, ContentType='application/json')
print(f'{cid}: study built · CTR→views ρ={sp(ctr):.2f} · CTR+ret CV R²={base_cv:.2f} · +dur={selection["interp"]["cv_r2"]} · '
      f'distribution R²={confounds["distribution_r2"]} vs content R²={confounds["content_r2"]} · wrote R2 longform/study_{cid}.json ({len(out)//1024}KB)', flush=True)
