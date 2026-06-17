#!/usr/bin/env python3
"""
RETENTION × SWIPE → VIEWS · full rerun, era-aware.

Critical data fact: the swipe metric is BIMODAL by era. Videos >~1.5yr old report
~1% swipe (99% "stayed" — implausible, the old/partial metric); videos from the last
~1.5yr report realistic 40-50% swipe. So swipe is only comparable inside the MODERN
cohort. Retention curves are consistent across eras (use all).

Three questions, each through MULTIPLE lenses (not one log-R²): Spearman rank, binned
median-view magnitudes, and confound-controlled CV-R² with duration first-class.
Selection caveat: every video here is a WINNER (60K-285M views) — the videos that died
with high swipe aren't in the dataset, so within-winners effects are attenuated.

Output: retention_study.json (everything the Jarvis tab visualises).
"""
import os, json, warnings
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
GRID = np.linspace(0, 1, 100)
MODERN_MAX_RECENCY = 1.6   # era break: swipe metric is the realistic one for newer videos


def cv_r2(X, y, alpha=1.0, k=5):
    X = np.atleast_2d(X);  X = X if X.shape[0] == len(y) else X.T
    if X.shape[1] == 0 or len(y) < 12:
        return 0.0
    kf = KFold(k, shuffle=True, random_state=7); oof = np.full(len(y), np.nan)
    for tr, te in kf.split(X):
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        m = Ridge(alpha=alpha).fit((X[tr] - mu) / sd, y[tr]); oof[te] = m.predict((X[te] - mu) / sd)
    return float(r2_score(y, oof))


def insample_r2(X, y, alpha=1.0):
    X = np.atleast_2d(X);  X = X if X.shape[0] == len(y) else X.T
    if X.shape[1] == 0:
        return 0.0
    mu, sd = X.mean(0), X.std(0) + 1e-9
    return float(r2_score(y, Ridge(alpha=alpha).fit((X - mu) / sd, y).predict((X - mu) / sd)))


def binned(x, v, edges):
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (x >= lo) & (x < hi)
        out.append({'lo': lo, 'hi': hi, 'n': int(m.sum()),
                    'median_views': float(np.median(v[m])) if m.sum() else None,
                    'p25': float(np.percentile(v[m], 25)) if m.sum() else None,
                    'p75': float(np.percentile(v[m], 75)) if m.sum() else None})
    return out


def lenses(x, vw, logv):
    return {'spearman_views': float(spearmanr(x, vw).correlation),
            'pearson_logviews': float(pearsonr(x, logv)[0])}


def main():
    D = json.load(open(os.path.join(HERE, 'retention_data.json')))
    V = [v for v in D['videos'] if v['avg_retention'] and v['duration_s']]
    n = len(V)
    curves = np.array([v['curve'] for v in V])
    vw = np.array([float(v['views']) for v in V]); y = np.log10(vw)
    sw = np.array([v['swipe'] for v in V]); ar = np.array([v['avg_retention'] for v in V])
    dur = np.array([v['duration_s'] for v in V]); rec = np.array([v['recency_yr'] for v in V])
    modern = rec < MODERN_MAX_RECENCY                         # consistent-swipe cohort

    # ── era diagnosis ──
    era = {'modern_n': int(modern.sum()), 'legacy_n': int((~modern).sum()),
           'break_recency_yr': MODERN_MAX_RECENCY,
           'modern_swipe_median': float(np.median(sw[modern])), 'legacy_swipe_median': float(np.median(sw[~modern])),
           'note': 'legacy (>%.1fyr) swipe ~1%% is the old/partial metric — NOT comparable to modern 40-50%%.' % MODERN_MAX_RECENCY}

    # ── distributions (for histograms) ──
    dist = {'swipe': sw.tolist(), 'retention': ar.tolist(), 'duration': dur.tolist(), 'log_views': y.tolist(),
            'modern_mask': modern.tolist()}

    # ── Q1 (multiple lenses), retention on ALL, swipe on MODERN ──
    Q1 = {
        'retention_all': lenses(ar, vw, y),
        'swipe_modern': lenses(sw[modern], vw[modern], y[modern]),
        'swipe_pooled_INVALID': lenses(sw, vw, y),                  # shown to demonstrate the era artifact
        'duration_all': lenses(dur, vw, y),
        'stay_modern': lenses(100 - sw[modern], vw[modern], y[modern]),
        'bins': {
            'views_by_retention': binned(ar, vw, [50, 70, 80, 85, 90, 95, 110]),
            'views_by_swipe_modern': binned(sw[modern], vw[modern], [10, 25, 35, 42, 46, 55]),
            'views_by_duration': binned(dur, vw, [30, 45, 55, 70, 200]),
        },
    }
    # confound-controlled variance decomposition on MODERN cohort (swipe valid there)
    ym = y[modern]; arm = ar[modern]; swm = sw[modern]; durm = np.log(dur[modern])
    content = np.column_stack([arm, swm]); confd = durm.reshape(-1, 1)
    naive = cv_r2(content, ym); withdur = cv_r2(np.column_stack([content, confd]), ym); duronly = cv_r2(confd, ym)
    cu_in = insample_r2(np.column_stack([content, confd]), ym) - insample_r2(confd, ym)
    # prediction spread
    Xf = np.column_stack([content, confd]); mu, sd = Xf.mean(0), Xf.std(0) + 1e-9
    resid = ym - Ridge(1.0).fit((Xf - mu) / sd, ym).predict((Xf - mu) / sd); rsd = float(resid.std())
    bs = []
    for _ in range(600):
        b = np.random.choice(modern.sum(), modern.sum(), replace=True)
        try:
            bs.append(insample_r2(np.column_stack([content[b], confd[b]]), ym[b]) - insample_r2(confd[b], ym[b]))
        except Exception:
            pass
    Q1['decomp_modern'] = {'n': int(modern.sum()), 'naive_cv_r2': round(naive, 3), 'duration_only_cv_r2': round(duronly, 3),
                           'content_plus_duration_cv_r2': round(withdur, 3), 'content_unique_insample_r2': round(cu_in, 3),
                           'content_unique_ci90': [round(np.percentile(bs, 5), 3), round(np.percentile(bs, 95), 3)] if bs else None,
                           'resid_sd_log10': round(rsd, 3), 'view_range_mult_80pct': round(10 ** (1.2816 * rsd), 2)}

    # ── Q2: curve shape beyond average (ALL videos; curves consistent across eras) ──
    cmu = curves.mean(0); pca = PCA(n_components=6).fit(curves - cmu); modes = pca.transform(curves - cmu)
    mode_lvl = [float(spearmanr(modes[:, k], ar).correlation) for k in range(6)]
    shape_modes = modes[:, [k for k in range(6) if abs(mode_lvl[k]) < 0.5]]
    base = ar.reshape(-1, 1)
    Q2 = {'cv_r2_avg_only': round(cv_r2(base, y), 3),
          'cv_r2_avg_plus_shape': round(cv_r2(np.column_stack([base, shape_modes]), y, alpha=3.0), 3),
          'cv_r2_full_curve': round(cv_r2(modes, y, alpha=3.0), 3), 'mode_level_corr': [round(x, 2) for x in mode_lvl]}
    Q2['shape_delta_r2'] = round(Q2['cv_r2_avg_plus_shape'] - Q2['cv_r2_avg_only'], 3)

    # ── Q3: infer swipe from retention (MODERN), and redundancy ──
    def at_sec(t):
        return np.array([np.interp(min(1.0, t / dur[i]), GRID, curves[i]) for i in range(n)])
    r3, r5, r8 = at_sec(3), at_sec(5), at_sec(8)
    earlym = np.column_stack([r3[modern], r5[modern], r8[modern], curves[modern, 0], ar[modern]])
    Q3 = {'swipe_from_retention_cv_r2': round(cv_r2(earlym, swm), 3),
          'swipe_from_retention_insample_r2': round(insample_r2(earlym, swm), 3),
          'swipe_resid_sd_pct': round(float((swm - Ridge(1).fit((earlym - earlym.mean(0)) / (earlym.std(0) + 1e-9), swm).predict((earlym - earlym.mean(0)) / (earlym.std(0) + 1e-9))).std()), 2),
          'views_retention_only_cv_r2': round(cv_r2(np.column_stack([arm.reshape(-1, 1), durm.reshape(-1, 1)]), ym), 3),
          'views_plus_swipe_cv_r2': round(withdur, 3)}
    Q3['swipe_adds_for_views'] = round(Q3['views_plus_swipe_cv_r2'] - Q3['views_retention_only_cv_r2'], 3)

    # scatter points for the tab
    scatter = [{'swipe': round(sw[i], 1), 'ret': round(ar[i], 1), 'dur': round(dur[i], 0),
                'lv': round(y[i], 2), 'modern': bool(modern[i]), 'name': (V[i]['name'] or '')[:40]} for i in range(n)]
    # example curves (lowest & highest avg retention)
    o = np.argsort(ar)
    ex_curves = [{'name': (V[i]['name'] or '')[:36], 'ret': round(ar[i], 1), 'views': int(vw[i]), 'curve': V[i]['curve']}
                 for i in list(o[:3]) + list(o[-3:])]

    out = {'meta': {'n': n, 'modern_n': int(modern.sum()), 'target': 'log10(views)',
                    'swipe_def': 'swipe = swipedAwayRate (feed); stay = 100 - swipe',
                    'selection_caveat': 'all videos are winners (60K-285M views) — high-swipe failures are absent, so within-sample effects are attenuated',
                    'replay_universal': True, 'mean_start_retention': round(float(curves[:, 0].mean()), 2)},
           'era': era, 'dist': dist, 'Q1': Q1, 'Q2': Q2, 'Q3': Q3, 'scatter': scatter,
           'curve_mean': [round(x, 4) for x in cmu], 'example_curves': ex_curves}
    json.dump(out, open(OUT, 'w'))

    print(f"n={n} (modern swipe cohort {modern.sum()}) · target log10(views)")
    print(f"\nERA: legacy swipe median {era['legacy_swipe_median']:.1f}% (old metric) vs modern {era['modern_swipe_median']:.1f}% — swipe analysed on modern only")
    print("\nQ1 lenses (Spearman vs views | Pearson vs log-views):")
    print(f"  retention(all):  {Q1['retention_all']['spearman_views']:+.2f} | {Q1['retention_all']['pearson_logviews']:+.2f}")
    print(f"  swipe(modern):   {Q1['swipe_modern']['spearman_views']:+.2f} | {Q1['swipe_modern']['pearson_logviews']:+.2f}   (pooled INVALID: {Q1['swipe_pooled_INVALID']['spearman_views']:+.2f})")
    print(f"  duration(all):   {Q1['duration_all']['spearman_views']:+.2f} | {Q1['duration_all']['pearson_logviews']:+.2f}")
    d = Q1['decomp_modern']
    print(f"  MODERN decomp: ret+swipe alone CV {d['naive_cv_r2']:+.3f} · +duration {d['content_plus_duration_cv_r2']:+.3f} · content-unique {d['content_unique_insample_r2']:+.3f} · views ×/÷ {d['view_range_mult_80pct']:.1f}")
    print(f"\nQ2 shape: avg {Q2['cv_r2_avg_only']:+.3f} → +shape {Q2['cv_r2_avg_plus_shape']:+.3f} (Δ {Q2['shape_delta_r2']:+.3f})")
    print(f"Q3 swipe-from-retention CV R² {Q3['swipe_from_retention_cv_r2']:+.3f} (±{Q3['swipe_resid_sd_pct']:.0f}%) · swipe adds for views {Q3['swipe_adds_for_views']:+.3f}")
    print("→ retention_study.json")


if __name__ == '__main__':
    main()
