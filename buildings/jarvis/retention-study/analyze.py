#!/usr/bin/env python3
"""
RETENTION × KEEP-RATE → VIEWS · analysis on the VERIFIED data (211 videos).

Metrics (confirmed accurate):
  keep_rate = stayedToWatch (Viewed-vs-Swiped-Away, scraped from Studio), 46-87%
  retention = avgPercentViewed
  views, duration, 100-pt retention curve, publish date (→ recency/age)

Questions:
  Q1  How much do keep_rate + retention explain views? (rank + magnitude + CV-R² +
      prediction interval). Establish the relationship between the two and views.
  Q2  Does the retention curve SHAPE matter beyond the average?
  Q3  Can keep_rate be inferred from retention? Is it redundant for views?
  Q4  DURATION — added AFTER Q1: how much does it change things? Lift, interactions,
      magnitude by length.

Target log10(views). n=211 → CV-R² + bootstrap CIs; honest about wide intervals.
Output: retention_study.json.
"""
import os, json, datetime, warnings
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.linear_model import Ridge
from sklearn.decomposition import PCA
from sklearn.model_selection import KFold
from sklearn.metrics import r2_score
from scipy.stats import spearmanr, pearsonr

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'retention_study.json')
TODAY = datetime.date(2026, 6, 17)
GRID = np.linspace(0, 1, 100)


def cvr(X, y, a=1.0, k=5):
    X = np.atleast_2d(X); X = X if X.shape[0] == len(y) else X.T
    if X.shape[1] == 0 or len(y) < 12:
        return 0.0
    kf = KFold(k, shuffle=True, random_state=7); oof = np.full(len(y), np.nan)
    for tr, te in kf.split(X):
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        oof[te] = Ridge(a).fit((X[tr] - mu) / sd, y[tr]).predict((X[te] - mu) / sd)
    return float(r2_score(y, oof))


def insr(X, y, a=1.0):
    X = np.atleast_2d(X); X = X if X.shape[0] == len(y) else X.T
    if X.shape[1] == 0:
        return 0.0
    mu, sd = X.mean(0), X.std(0) + 1e-9
    return float(r2_score(y, Ridge(a).fit((X - mu) / sd, y).predict((X - mu) / sd)))


def binmed(x, v, edges):
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (x >= lo) & (x < hi)
        out.append({'lo': lo, 'hi': hi, 'n': int(m.sum()),
                    'median_views': float(np.median(v[m])) if m.sum() else None,
                    'p25': float(np.percentile(v[m], 25)) if m.sum() else None,
                    'p75': float(np.percentile(v[m], 75)) if m.sum() else None})
    return out


def lens(x, vw, lv):
    return {'spearman': float(spearmanr(x, vw).correlation), 'pearson_log': float(pearsonr(x, lv)[0])}


def main():
    T = json.load(open(os.path.join(HERE, 'retention_table.json')))
    V = [v for v in T['videos'] if v.get('keep_rate') is not None and v.get('avg_retention') and v.get('duration_s') and v.get('curve')]
    n = len(V)
    keep = np.array([v['keep_rate'] for v in V])
    ret = np.array([v['avg_retention'] for v in V])
    dur = np.array([v['duration_s'] for v in V])
    vw = np.array([float(v['views']) for v in V]); lv = np.log10(vw)
    curves = np.array([v['curve'] for v in V])
    rec = np.array([(TODAY - datetime.date.fromisoformat(v['published'])).days / 365.0 if v.get('published') else np.nan for v in V])
    rec[~np.isfinite(rec)] = np.nanmedian(rec[np.isfinite(rec)])
    ldur = np.log(dur)
    ret5 = np.array([float(np.interp(min(1.0, 5.0 / dur[i]), GRID, curves[i]) * 100) for i in range(n)])  # retention at the 5s mark

    # ── Q1: keep + retention → views ──
    content = np.column_stack([keep, ret])
    age = rec.reshape(-1, 1)            # confound: older videos accumulate more total views
    Q1 = {
        'lenses': {'keep': lens(keep, vw, lv), 'retention': lens(ret, vw, lv),
                   'keep_vs_retention': float(spearmanr(keep, ret).correlation)},
        'bins': {'views_by_keep': binmed(keep, vw, [40, 60, 68, 74, 80, 90]),
                 'views_by_retention': binmed(ret, vw, [50, 70, 80, 85, 90, 110])},
        'cv_r2': {'keep_alone': round(cvr(keep.reshape(-1, 1), lv), 3),
                  'retention_alone': round(cvr(ret.reshape(-1, 1), lv), 3),
                  'both': round(cvr(content, lv), 3),
                  'both_plus_age': round(cvr(np.column_stack([content, age]), lv), 3),
                  'age_alone': round(cvr(age, lv), 3)},
    }
    # content-unique over age + prediction interval
    cu = insr(np.column_stack([content, age]), lv) - insr(age, lv)
    Xf = np.column_stack([content, age]); mu, sd = Xf.mean(0), Xf.std(0) + 1e-9
    rsd = float((lv - Ridge(1).fit((Xf - mu) / sd, lv).predict((Xf - mu) / sd)).std())
    bs = []
    for _ in range(600):
        b = np.random.choice(n, n, replace=True)
        try:
            bs.append(insr(np.column_stack([content[b], age[b]]), lv[b]) - insr(age[b], lv[b]))
        except Exception:
            pass
    Q1['content_unique_r2'] = round(cu, 3)
    Q1['content_unique_ci90'] = [round(np.percentile(bs, 5), 3), round(np.percentile(bs, 95), 3)] if bs else None
    Q1['view_range_mult_80pct'] = round(10 ** (1.2816 * rsd), 2)

    # ── Q2: curve shape beyond average ──
    cmu = curves.mean(0); pca = PCA(n_components=6).fit(curves - cmu); modes = pca.transform(curves - cmu)
    mlvl = [float(spearmanr(modes[:, k], ret).correlation) for k in range(6)]
    shape_idx = [k for k in range(6) if abs(mlvl[k]) < 0.5]
    shape = modes[:, shape_idx]
    Q2 = {'cv_r2_avg': round(cvr(ret.reshape(-1, 1), lv), 3),
          'cv_r2_avg_plus_shape': round(cvr(np.column_stack([ret.reshape(-1, 1), shape]), lv, a=3.0), 3),
          'mode_level_corr': [round(x, 2) for x in mlvl]}
    Q2['shape_delta'] = round(Q2['cv_r2_avg_plus_shape'] - Q2['cv_r2_avg'], 3)
    # shape viz: mode-1 (orthogonal to level) as ± deformations of the mean curve, views by shape,
    # and the most extreme real curves so you can SEE what "shape" means.
    pc1i = shape_idx[0] if shape_idx else 0
    pc2i = shape_idx[1] if len(shape_idx) > 1 else pc1i
    pc1 = modes[:, pc1i]; pc2 = modes[:, pc2i]; comp1 = pca.components_[pc1i]; ssc = 2.0 * float(pc1.std())
    sedg = np.percentile(pc1, [0, 20, 40, 60, 80, 100]).astype(float); sedg[-1] += 1e-6
    Q2['mean_curve'] = [round(float(x), 4) for x in cmu]
    Q2['mode1_plus'] = [round(float(x), 4) for x in (cmu + ssc * comp1)]
    Q2['mode1_minus'] = [round(float(x), 4) for x in (cmu - ssc * comp1)]
    Q2['mode1_view_corr'] = round(float(spearmanr(pc1, vw).correlation), 3)
    Q2['views_by_shape'] = binmed(pc1, vw, [round(float(e), 3) for e in sedg])
    _ord = np.argsort(pc1)
    Q2['shape_examples'] = [{'id': V[i]['id'], 'name': (V[i]['title'] or '')[:40], 'pc1': round(float(pc1[i]), 3),
                             'views': int(vw[i]), 'curve': [round(float(x), 3) for x in curves[i]],
                             'kind': k} for i, k in [(int(_ord[0]), 'front-loaded (early cliff)'), (int(_ord[-1]), 'flat / back-loaded')]]

    # ── Q3: keep from retention + redundancy ──
    def at(t):
        return np.array([np.interp(min(1.0, t / dur[i]), GRID, curves[i]) for i in range(n)])
    early = np.column_stack([at(3), at(5), at(8), curves[:, 0], ret])
    Q3 = {'keep_from_retention_cv_r2': round(cvr(early, keep), 3),
          'keep_resid_sd_pct': round(float((keep - Ridge(1).fit((early - early.mean(0)) / (early.std(0) + 1e-9), keep).predict((early - early.mean(0)) / (early.std(0) + 1e-9))).std()), 2),
          'views_retention_only': round(cvr(np.column_stack([ret.reshape(-1, 1), age]), lv), 3),
          'views_plus_keep': round(cvr(np.column_stack([ret.reshape(-1, 1), keep.reshape(-1, 1), age]), lv), 3)}
    Q3['keep_adds_for_views'] = round(Q3['views_plus_keep'] - Q3['views_retention_only'], 3)

    # ── Q4: DURATION (added after the two metrics) ──
    base = np.column_stack([content, age])
    inter = np.column_stack([keep * ldur, ret * ldur])         # interactions
    Q4 = {
        'duration_lens': lens(dur, vw, lv),
        'views_by_duration': binmed(dur, vw, [30, 45, 55, 70, 200]),
        'cv_r2_content_only': round(cvr(base, lv), 3),
        'cv_r2_plus_duration': round(cvr(np.column_stack([base, ldur.reshape(-1, 1)]), lv), 3),
        'cv_r2_plus_duration_interactions': round(cvr(np.column_stack([base, ldur.reshape(-1, 1), inter]), lv, a=2.0), 3),
        'partial_keep_given_dur': float(spearmanr(keep, lv).correlation),  # placeholder, recompute partial below
    }
    # partial correlation of keep & retention with views, controlling duration (residualize)
    def resid(a_, c_):
        c_ = np.atleast_2d(c_).T if np.ndim(c_) == 1 else c_
        mu2, sd2 = c_.mean(0), c_.std(0) + 1e-9
        return a_ - Ridge(0.1).fit((c_ - mu2) / sd2, a_).predict((c_ - mu2) / sd2)
    Q4['partial_keep_given_dur'] = round(float(spearmanr(resid(keep, ldur), resid(lv, ldur)).correlation), 3)
    Q4['partial_retention_given_dur'] = round(float(spearmanr(resid(ret, ldur), resid(lv, ldur)).correlation), 3)
    Q4['duration_unique_r2'] = round(insr(np.column_stack([base, ldur.reshape(-1, 1)]), lv) - insr(base, lv), 3)

    # ── keep × retention interaction (the synergy when BOTH are high) ──
    from sklearn.linear_model import LinearRegression
    kr_x_ret = (keep * ret).reshape(-1, 1)
    add_r2 = cvr(np.column_stack([keep, ret]), lv)
    int_r2 = cvr(np.column_stack([keep, ret, kr_x_ret]), lv)
    # 2D grid of median views by keep × retention bins
    kedg = [40, 68, 76, 90]; redg = [50, 80, 88, 110]
    grid, gn = [], []
    for klo, khi in zip(kedg[:-1], kedg[1:]):
        rowm, rown = [], []
        for rlo, rhi in zip(redg[:-1], redg[1:]):
            m = (keep >= klo) & (keep < khi) & (ret >= rlo) & (ret < rhi)
            rowm.append(float(np.median(vw[m])) if m.sum() else None); rown.append(int(m.sum()))
        grid.append(rowm); gn.append(rown)
    interaction = {'keep_edges': kedg, 'ret_edges': redg, 'grid_median_views': grid, 'grid_n': gn,
                   'additive_cv_r2': round(add_r2, 3), 'with_interaction_cv_r2': round(int_r2, 3),
                   'interaction_delta_r2': round(int_r2 - add_r2, 3)}

    # ── INDICATOR SWEEP: more candidate drivers, each scored on its own + independence ──
    def atsec(t):
        return np.array([np.interp(min(1.0, t / dur[i]), GRID, curves[i]) for i in range(n)])
    hook = atsec(3); tail = curves[:, -10:].mean(1); replay = curves[:, 0]; decay = hook - tail
    nonsub = np.array([v.get('nonsub_keep') for v in V], dtype=float)
    subk = np.array([v.get('sub_keep') for v in V], dtype=float)
    for arr in (nonsub, subk):
        mm = np.isfinite(arr); arr[~mm] = (np.nanmedian(arr[mm]) if mm.any() else 0.0)
    subgap = subk - nonsub
    likes = np.array([(v.get('likes') or 0) for v in V], float); comments = np.array([(v.get('comments') or 0) for v in V], float); shares = np.array([(v.get('shares') or 0) for v in V], float)
    vsafe = np.maximum(vw, 1.0)
    like_rate = likes / vsafe * 1000; comment_rate = comments / vsafe * 1000; share_rate = shares / vsafe * 1000
    # candidate content / audience-quality signals (legit predictors). interpretable→exposed as a slider.
    RAW = [
        ('keep', keep, 'Keep rate', '%', True), ('retention', ret, 'Retention', '%', True),
        ('log_dur', ldur, 'Duration', 's', True), ('hook', hook, 'Hook (3s held)', '%', True),
        ('tail', tail, 'Ending retention', '%', True), ('nonsub_keep', nonsub, 'Non-sub keep', '%', True),
        ('replay', replay, 'Replay (start)', '', False), ('decay', decay, 'Decay 3s→end', '', False),
        ('sub_gap', subgap, 'Sub loyalty gap', '', False), ('shape_pc1', pc1, 'Shape mode 1', '', False),
        ('shape_pc2', pc2, 'Shape mode 2', '', False), ('age', rec, 'Age (exposure)', 'yr', False)]
    def covered(a):                                            # drop all-missing signals (e.g. sub/non-sub keep, not stored)
        f = np.isfinite(a); return bool(f.mean() > 0.5 and np.nanstd(a[f]) > 1e-9)
    USABLE = [t for t in RAW if covered(t[1])]
    FLAG = [('share_rate', share_rate, 'Shares /1k views'), ('like_rate', like_rate, 'Likes /1k views'), ('comment_rate', comment_rate, 'Comments /1k views')]
    LAB = dict((k, l) for k, _, l, _, _ in USABLE); UNIT = dict((k, u) for k, _, _, u, _ in USABLE)
    SLD = dict((k, s) for k, _, _, _, s in USABLE); feats = {k: a for k, a, *_ in USABLE}
    KR = np.column_stack([keep, ret])
    def partial_kr(x):
        return round(float(spearmanr(resid(x, KR), resid(lv, KR)).correlation), 3)
    indicators = []
    for key, arr, label, unit, slid in USABLE:
        indicators.append({'key': key, 'label': label, 'unit': unit, 'usable': True,
                           'spearman': round(float(spearmanr(arr, vw).correlation), 3),
                           'partial_kr': None if key in ('keep', 'retention') else partial_kr(arr)})
    for key, arr, label in FLAG:
        indicators.append({'key': key, 'label': label, 'unit': '', 'usable': False,
                           'spearman': round(float(spearmanr(arr, vw).correlation), 3), 'partial_kr': partial_kr(arr),
                           'note': 'outcome-side: measured after, partly a consequence of views — not a clean predictor'})
    # correlation matrix among usable indicators (redundancy / which combos are independent)
    uk = [k for k, *_ in USABLE]; ulab = [LAB[k] for k in uk]
    umat = np.column_stack([feats[k] for k in uk])
    rho = [[round(float(spearmanr(umat[:, a], umat[:, b]).correlation), 2) for b in range(len(uk))] for a in range(len(uk))]
    corr_matrix = {'keys': uk, 'labels': ulab, 'rho': rho}
    # greedy forward selection: add the indicator that most lifts CV-R² until it stops paying
    def greedy(pool):
        sel, rem, pth, cur = [], list(pool), [], 0.0
        while rem and len(sel) < 7:
            best = None
            for k in rem:
                r2 = cvr(np.column_stack([feats[s] for s in sel + [k]]), lv)
                if best is None or r2 > best[1]:
                    best = (k, r2)
            if sel and best[1] - cur < 0.004:
                break
            sel.append(best[0]); rem.remove(best[0])
            cols = np.column_stack([feats[s] for s in sel]); mu2, sd2 = cols.mean(0), cols.std(0) + 1e-9
            rsd_k = float((lv - Ridge(1).fit((cols - mu2) / sd2, lv).predict((cols - mu2) / sd2)).std())
            pth.append({'add': best[0], 'label': LAB[best[0]], 'cv_r2': round(best[1], 3),
                        'resid_sd': round(rsd_k, 3), 'range_mult': round(10 ** (1.2816 * rsd_k), 2)})
            cur = best[1]
        return sel, pth
    full_sel, full_path = greedy(uk)
    interp_sel, interp_path = greedy([k for k in uk if SLD[k]])   # drives the calculator (slider-able only)
    base_cols = np.column_stack([keep, ret]); bmu, bsd = base_cols.mean(0), base_cols.std(0) + 1e-9
    base_rsd = float((lv - Ridge(1).fit((base_cols - bmu) / bsd, lv).predict((base_cols - bmu) / bsd)).std())
    selection = {'baseline_cv_r2': round(cvr(base_cols, lv), 3), 'baseline_range_mult': round(10 ** (1.2816 * base_rsd), 2),
                 'full': {'path': full_path, 'features': full_sel, 'cv_r2': full_path[-1]['cv_r2'] if full_path else None, 'range_mult': full_path[-1]['range_mult'] if full_path else None},
                 'interp': {'path': interp_path, 'features': interp_sel, 'cv_r2': interp_path[-1]['cv_r2'] if interp_path else None, 'range_mult': interp_path[-1]['range_mult'] if interp_path else None}}
    selected = interp_sel

    # ── predictor models (raw coefficients so the tab can compute directly) ──
    def fit_raw(Xcols):
        m = LinearRegression().fit(Xcols, lv)
        resid_ = lv - m.predict(Xcols)
        return {'features': None, 'coef': [round(float(c), 5) for c in m.coef_], 'intercept': round(float(m.intercept_), 4),
                'resid_sd_log10': round(float(resid_.std()), 4), 'cv_r2': None}
    p2 = fit_raw(np.column_stack([keep, ret])); p2['features'] = ['keep', 'retention']; p2['cv_r2'] = round(cvr(np.column_stack([keep, ret]), lv), 3)
    p3 = fit_raw(np.column_stack([keep, ret, ldur])); p3['features'] = ['keep', 'retention', 'log_duration']; p3['cv_r2'] = round(cvr(np.column_stack([keep, ret, ldur]), lv), 3)
    # BEST interpretable model from the combination search — the tightest-range driveable predictor
    Xb = np.column_stack([feats[s] for s in selected]); mb = LinearRegression().fit(Xb, lv); rb = lv - mb.predict(Xb)
    natural = {'log_dur': dur}   # log_dur slider is in raw seconds (feature value = ln(seconds))
    sliders = []
    for s in selected:
        nat = natural.get(s, feats[s])
        sliders.append({'key': s, 'label': LAB[s], 'unit': UNIT[s], 'transform': 'ln' if s == 'log_dur' else 'none',
                        'min': round(float(np.percentile(nat, 2)), 1), 'max': round(float(np.percentile(nat, 98)), 1),
                        'default': round(float(np.median(nat)), 1)})
    v_best = {'features': selected, 'labels': [LAB[s] for s in selected],
              'coef': [round(float(c), 6) for c in mb.coef_], 'intercept': round(float(mb.intercept_), 4),
              'resid_sd_log10': round(float(rb.std()), 4), 'cv_r2': round(cvr(Xb, lv), 3),
              'feat_median': {s: round(float(np.median(feats[s])), 4) for s in selected}, 'sliders': sliders}
    # ── toggleable subset models: every combination of keep / retention / 5-sec retention / duration ──
    from itertools import combinations
    FEATS4 = {'keep': keep, 'retention': ret, 'ret5': ret5, 'log_dur': ldur}
    ORDER = ['keep', 'retention', 'ret5', 'log_dur']

    def subset_model(names):
        cols = np.column_stack([FEATS4[f] for f in names]); m = LinearRegression().fit(cols, lv); resid_ = lv - m.predict(cols)
        return {'features': list(names), 'coef': [round(float(c), 6) for c in m.coef_], 'intercept': round(float(m.intercept_), 4),
                'resid_sd_log10': round(float(resid_.std()), 4), 'cv_r2': round(cvr(cols, lv), 3)}
    subsets = {'+'.join(c): subset_model(c) for r in range(1, 5) for c in combinations(ORDER, r)}
    NAT = {'keep': keep, 'retention': ret, 'ret5': ret5, 'log_dur': dur}   # duration slider in seconds (feature = ln s)
    FLAB = {'keep': 'Keep rate', 'retention': 'Retention %', 'ret5': '5-sec retention', 'log_dur': 'Duration'}
    FUNIT = {'keep': '%', 'retention': '%', 'ret5': '%', 'log_dur': 's'}
    feat_meta = {f: {'label': FLAB[f], 'unit': FUNIT[f], 'transform': 'ln' if f == 'log_dur' else 'none',
                     'min': round(float(np.percentile(NAT[f], 2)), 1), 'max': round(float(np.percentile(NAT[f], 98)), 1),
                     'default': round(float(np.median(NAT[f])), 1)} for f in ORDER}

    predictor = {'v2_keep_ret': p2, 'v3_with_duration': p3, 'v_best': v_best,
                 'subsets': subsets, 'feat_meta': feat_meta, 'order': ORDER,
                 'ranges': {'keep': [float(keep.min()), float(keep.max())], 'retention': [float(ret.min()), float(ret.max())], 'duration': [float(dur.min()), float(dur.max())]},
                 'medians': {'keep': float(np.median(keep)), 'retention': float(np.median(ret)), 'duration': float(np.median(dur))}}

    # per-video scatter (which videos drive each finding) — id, title, metrics + extra indicators
    scatter = [{'id': V[i]['id'], 'name': (V[i]['title'] or '')[:42], 'keep': round(float(keep[i]), 1),
                'ret': round(float(ret[i]), 1), 'dur': round(float(dur[i]), 0), 'views': int(vw[i]),
                'lv': round(float(lv[i]), 3), 'url': V[i].get('url'),
                'hook': round(float(hook[i]), 1), 'tail': round(float(tail[i]), 1),
                'nonsub_keep': round(float(nonsub[i]), 1), 'pc1': round(float(pc1[i]), 3),
                'share_rate': round(float(share_rate[i]), 2)} for i in range(n)]

    out = {'meta': {'n': n, 'target': 'log10(views)', 'metric': 'keep_rate = stayedToWatch (verified accurate)',
                    'caveat': 'observational + winners-only (all 60K-285M views); associations not proven causal; account size/impressions not in data'},
           'Q1': Q1, 'Q2': Q2, 'Q3': Q3, 'Q4': Q4,
           'interaction': interaction, 'indicators': indicators, 'corr_matrix': corr_matrix, 'selection': selection,
           'predictor': predictor, 'scatter': scatter, 'curve_mean': [round(x, 4) for x in cmu]}
    json.dump(out, open(OUT, 'w'))

    print(f"n={n} · target log10(views)\n")
    print("Q1 — keep & retention → views:")
    print(f"  Spearman: keep {Q1['lenses']['keep']['spearman']:+.2f} · retention {Q1['lenses']['retention']['spearman']:+.2f} · keep↔retention {Q1['lenses']['keep_vs_retention']:+.2f}")
    print(f"  CV R²: keep {Q1['cv_r2']['keep_alone']:+.3f} · retention {Q1['cv_r2']['retention_alone']:+.3f} · both {Q1['cv_r2']['both']:+.3f} · +age {Q1['cv_r2']['both_plus_age']:+.3f}")
    print(f"  content-unique over age {Q1['content_unique_r2']:+.3f} (CI {Q1['content_unique_ci90']}) · views ×/÷ {Q1['view_range_mult_80pct']}")
    print(f"\nQ2 — shape: avg {Q2['cv_r2_avg']:+.3f} → +shape {Q2['cv_r2_avg_plus_shape']:+.3f} (Δ {Q2['shape_delta']:+.3f})")
    print(f"Q3 — keep from retention CV R² {Q3['keep_from_retention_cv_r2']:+.3f} (±{Q3['keep_resid_sd_pct']:.0f}%) · keep adds for views {Q3['keep_adds_for_views']:+.3f}")
    print(f"\nQ4 — DURATION: lens spearman {Q4['duration_lens']['spearman']:+.2f}")
    print(f"  content only {Q4['cv_r2_content_only']:+.3f} → +duration {Q4['cv_r2_plus_duration']:+.3f} → +interactions {Q4['cv_r2_plus_duration_interactions']:+.3f}")
    print(f"  duration-unique R² {Q4['duration_unique_r2']:+.3f} · partial(keep|dur) {Q4['partial_keep_given_dur']:+.2f} · partial(ret|dur) {Q4['partial_retention_given_dur']:+.2f}")
    print("\nINDICATORS (spearman w/ views · partial | keep+ret):")
    for ind in indicators:
        pk = '—' if ind['partial_kr'] is None else f"{ind['partial_kr']:+.2f}"
        print(f"  {ind['label']:<20} {ind['spearman']:+.2f}  | {pk}{'' if ind['usable'] else '  (outcome-side)'}")
    print(f"\nCOMBINATION SEARCH (baseline keep+ret CV-R² {selection['baseline_cv_r2']:+.3f}, range ×/÷ {selection['baseline_range_mult']}):")
    print("  FULL (any signal):")
    for p in selection['full']['path']:
        print(f"    + {p['label']:<20} → CV-R² {p['cv_r2']:+.3f}  range ×/÷ {p['range_mult']}")
    print(f"    → {' + '.join(selection['full']['features'])}  (CV-R² {selection['full']['cv_r2']:+.3f}, range ×/÷ {selection['full']['range_mult']})")
    print("  INTERPRETABLE (drives the predictor):")
    for p in selection['interp']['path']:
        print(f"    + {p['label']:<20} → CV-R² {p['cv_r2']:+.3f}  range ×/÷ {p['range_mult']}")
    print(f"    → {' + '.join(selection['interp']['features'])}  (CV-R² {selection['interp']['cv_r2']:+.3f}, range ×/÷ {selection['interp']['range_mult']})")
    print("→ retention_study.json")


if __name__ == '__main__':
    main()
