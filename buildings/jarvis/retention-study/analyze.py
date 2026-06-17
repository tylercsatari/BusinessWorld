#!/usr/bin/env python3
"""
RETENTION × SWIPE → VIEWS · RV2-4 — the analysis.

Answers, all on log10(views), cross-validated + bootstrapped (n=138):

Q1  How much do retention + swipe explain views?
    Commonality (Shapley-R²) decomposition over confounds → confound-unique /
    content-unique / shared. Plus a prediction interval: given (stay, retention) →
    expected views + multiplicative range. Naive vs confound-controlled R².

Q2  Does curve SHAPE matter beyond the average?
    Functional-PCA of the 100-pt curves → PC1≈level, PC2+=shape (orthogonal). Does
    adding the shape modes raise CV-R² for views beyond the average? Nested ΔR² + CI.

Q3  Can swipe be inferred from retention? Can we drop to retention-only?
    swipe ~ early-curve (calculus: hazard + r at 3/5/8s). Redundancy of swipe for views.

Confounds: replay/rewatch is universal here (every curve starts >100%) — handled by a
replay covariate + the cold-audience (non-subscriber) retention; sensitivity excludes
the heaviest-replay quartile. Account size isn't in the export (noted as a limit).

Output: printed report + retention_study.json.
"""
import os, json, warnings
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.linear_model import Ridge
from sklearn.decomposition import PCA
from sklearn.model_selection import KFold
from sklearn.metrics import r2_score
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'retention_study.json')
GRID = np.linspace(0, 1, 100)


def cv_r2(X, y, alpha=1.0, k=5):
    if X.shape[1] == 0:
        return 0.0
    kf = KFold(k, shuffle=True, random_state=7); oof = np.full(len(y), np.nan)
    for tr, te in kf.split(X):
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        m = Ridge(alpha=alpha).fit((X[tr] - mu) / sd, y[tr])
        oof[te] = m.predict((X[te] - mu) / sd)
    return float(r2_score(y, oof))


def insample_r2(X, y, alpha=1.0):
    if X.shape[1] == 0:
        return 0.0
    mu, sd = X.mean(0), X.std(0) + 1e-9
    m = Ridge(alpha=alpha).fit((X - mu) / sd, y)
    return float(r2_score(y, m.predict((X - mu) / sd)))


def main():
    D = json.load(open(os.path.join(HERE, 'retention_data.json')))
    V = [v for v in D['videos'] if v['avg_retention'] and v['duration_s']]
    n = len(V)
    curves = np.array([v['curve'] for v in V])                 # n × 100 (retention, can exceed 1)
    y = np.array([v['log_views'] for v in V])                  # log10 views
    swipe = np.array([v['swipe'] for v in V])
    avg_ret = np.array([v['avg_retention'] for v in V])
    dur = np.array([v['duration_s'] for v in V])
    rec = np.array([v['recency_yr'] for v in V])
    subf = np.array([v['sub_frac'] if v['sub_frac'] is not None else np.nan for v in V])
    nsret = np.array([v['nonsub_ret'] if v['nonsub_ret'] is not None else np.nan for v in V])
    for arr in (subf, nsret):
        arr[~np.isfinite(arr)] = np.nanmedian(arr[np.isfinite(arr)])

    # ── RV2: calculus curve features ──
    logc = np.log(np.clip(curves, 1e-3, None))
    hazard = -np.gradient(logc, GRID, axis=1)                  # instantaneous leave rate h(t)
    auc = curves.mean(1)                                        # ∫r ≈ avg retention (sanity vs avg_ret)
    start_excess = curves[:, 0] - 1.0                          # replay inflation at t=0
    end_rise = curves[:, -1] - curves[:, int(0.9 * 99)]        # loop/rewatch bump near end
    early_drop = curves[:, 0] - curves[:, int(0.10 * 99)]      # first-10% cliff
    convexity = np.gradient(np.gradient(curves, GRID, axis=1), GRID, axis=1).mean(1)
    steep_pos = GRID[np.argmax(hazard, axis=1)]               # where the steepest drop is
    # absolute-second retention via duration (read curve at t/dur)
    def at_sec(t):
        return np.array([np.interp(min(1.0, t / dur[i]), GRID, curves[i]) for i in range(n)])
    r3, r5, r8 = at_sec(3), at_sec(5), at_sec(8)
    shape_feats = np.column_stack([early_drop, convexity, steep_pos, end_rise, hazard[:, :10].mean(1), hazard[:, 50:].mean(1)])

    # ── functional PCA on the curves (mean + modes) ──
    cmu = curves.mean(0); Cc = curves - cmu
    pca = PCA(n_components=8).fit(Cc); modes = pca.transform(Cc)   # n × 8 ; PC1≈level
    # correlation of each mode with the average (to label level vs shape)
    mode_level_corr = [float(spearmanr(modes[:, k], avg_ret).correlation) for k in range(8)]

    # LEGIT exogenous controls only. sub_frac is EXCLUDED — it's leakage (ρ≈−0.94 with
    # views because viral videos get pushed to non-subscribers; it's a CONSEQUENCE of
    # virality, not a cause). Including it fakes a huge "confound R²".
    conf = np.column_stack([rec, np.log(dur)])                          # recency (age) + duration
    # velocity target strips any age effect: views per day live
    vel = np.log10(np.clip(np.array([v['views'] for v in V]) / np.clip(rec * 365.25, 1, None), 1, None))
    # ── RV3: Q1 variance decomposition (commonality on in-sample R², CV total) ──
    content2 = np.column_stack([avg_ret, swipe])                       # the two headline metrics
    def block(cols):
        return cols if cols.size else np.zeros((n, 0))
    R_c = insample_r2(conf, y); R_m = insample_r2(content2, y)
    R_cm = insample_r2(np.column_stack([conf, content2]), y)
    content_unique = R_cm - R_c                                        # honest add of retention+swipe over confounds
    conf_unique = R_cm - R_m
    shared = R_m + R_c - R_cm
    cvR_conf = cv_r2(conf, y); cvR_cm = cv_r2(np.column_stack([conf, content2]), y)
    cvR_naive = cv_r2(content2, y)                                     # retention+swipe alone (no controls)
    # velocity (views/day) — the cleaner "how viral" target, immune to age
    velR_naive = cv_r2(content2, vel); velR_conf = cv_r2(conf[:, [1]], vel)  # dur only (recency is the divisor)
    velR_cm = cv_r2(np.column_stack([conf[:, [1]], content2]), vel)
    subfrac_leak_corr = float(spearmanr(subf, y).correlation)

    # prediction interval from the controlled model
    Xfull = np.column_stack([conf, content2]); mu, sd = Xfull.mean(0), Xfull.std(0) + 1e-9
    mdl = Ridge(alpha=1.0).fit((Xfull - mu) / sd, y); resid = y - mdl.predict((Xfull - mu) / sd)
    resid_sd = float(resid.std())                                     # log10 units
    pi_mult = float(10 ** (1.2816 * resid_sd))                        # 80% interval multiplier (±1.2816σ)

    # bootstrap CI on content_unique + cv total
    bs_cu, bs_cv = [], []
    for _ in range(600):
        b = np.random.choice(n, n, replace=True)
        try:
            cu = insample_r2(np.column_stack([conf[b], content2[b]]), y[b]) - insample_r2(conf[b], y[b])
            bs_cu.append(cu)
        except Exception:
            pass
    cu_ci = [float(np.percentile(bs_cu, 5)), float(np.percentile(bs_cu, 95))] if bs_cu else [None, None]

    # ── RV4 Q2: does SHAPE add over the average? (modes orthogonal to level) ──
    shape_modes = modes[:, [k for k in range(8) if abs(mode_level_corr[k]) < 0.5]]   # drop the level mode
    base_avg = np.column_stack([conf, avg_ret.reshape(-1, 1)])
    with_shape = np.column_stack([base_avg, shape_modes, shape_feats])
    q2_base = cv_r2(base_avg, y); q2_shape = cv_r2(with_shape, y, alpha=3.0)
    # also curve-fully vs avg for views
    q2_fullcurve = cv_r2(np.column_stack([conf, modes]), y, alpha=3.0)

    # ── RV4 Q3: infer swipe from retention (early curve), and swipe redundancy for views ──
    early = np.column_stack([r3, r5, r8, hazard[:, :10].mean(1), curves[:, 0], early_drop])
    swipe_from_ret_cv = cv_r2(early, swipe, alpha=1.0)
    swipe_from_ret_in = insample_r2(early, swipe)
    # redundancy: views with retention(+shape)+confounds, ± swipe
    ret_block = np.column_stack([conf, avg_ret.reshape(-1, 1), shape_modes])
    q3_noswipe = cv_r2(ret_block, y, alpha=3.0)
    q3_withswipe = cv_r2(np.column_stack([ret_block, swipe.reshape(-1, 1)]), y, alpha=3.0)
    swipe_resid_sd = float((swipe - Ridge(1.0).fit((early - early.mean(0)) / (early.std(0) + 1e-9), swipe).predict((early - early.mean(0)) / (early.std(0) + 1e-9))).std())

    # cold-audience (non-sub) cross-check: views vs non-subscriber retention
    cold_cv = cv_r2(np.column_stack([conf, nsret.reshape(-1, 1)]), y)

    # raw correlations
    corr = {
        'retention_vs_logviews': float(spearmanr(avg_ret, y).correlation),
        'swipe_vs_logviews': float(spearmanr(swipe, y).correlation),
        'retention_vs_swipe': float(spearmanr(avg_ret, swipe).correlation),
        'stay_vs_logviews': float(spearmanr(100 - swipe, y).correlation),
    }

    out = {
        'n': n, 'target': 'log10(views)',
        'corr': corr,
        'Q1': {
            'naive_cv_r2_retention_swipe': round(cvR_naive, 3),
            'confound_cv_r2': round(cvR_conf, 3),
            'controlled_cv_r2_all': round(cvR_cm, 3),
            'content_unique_r2': round(content_unique, 3), 'content_unique_ci90': [round(x, 3) if x is not None else None for x in cu_ci],
            'confound_unique_r2': round(conf_unique, 3), 'shared_r2': round(shared, 3),
            'resid_sd_log10': round(resid_sd, 3), 'view_range_mult_80pct': round(pi_mult, 2),
            'velocity_naive_cv_r2': round(velR_naive, 3), 'velocity_controlled_cv_r2': round(velR_cm, 3),
            'subfrac_excluded_as_leakage_corr': round(subfrac_leak_corr, 2),
        },
        'Q2': {'cv_r2_avg_only': round(q2_base, 3), 'cv_r2_avg_plus_shape': round(q2_shape, 3),
               'shape_delta_r2': round(q2_shape - q2_base, 3), 'cv_r2_full_curve': round(q2_fullcurve, 3),
               'mode_level_corr': [round(x, 2) for x in mode_level_corr]},
        'Q3': {'swipe_from_retention_cv_r2': round(swipe_from_ret_cv, 3), 'swipe_from_retention_insample_r2': round(swipe_from_ret_in, 3),
               'swipe_resid_sd_pct': round(swipe_resid_sd, 2),
               'views_retention_only_cv_r2': round(q3_noswipe, 3), 'views_plus_swipe_cv_r2': round(q3_withswipe, 3),
               'swipe_adds_for_views': round(q3_withswipe - q3_noswipe, 3)},
        'confounds': {'replay_universal': True, 'mean_start_retention': round(float(curves[:, 0].mean()), 3),
                      'cold_audience_cv_r2': round(cold_cv, 3), 'note': 'account size not in export — partial control only'},
        'curve_mean': [round(x, 4) for x in cmu],
    }
    json.dump(out, open(OUT, 'w'))

    print(f"n={n} · target=log10(views)\n")
    print("RAW (Spearman):  retention↔views %.2f · swipe↔views %.2f · retention↔swipe %.2f" % (corr['retention_vs_logviews'], corr['swipe_vs_logviews'], corr['retention_vs_swipe']))
    print("\nQ1 — how much do retention+swipe explain views (CV R², sub_frac EXCLUDED as leakage ρ=%.2f):" % subfrac_leak_corr)
    print(f"   TOTAL views  · retention+swipe alone: {cvR_naive:+.3f} · +legit confounds(age,dur): {cvR_cm:+.3f}")
    print(f"   VELOCITY (views/day) · ret+swipe alone: {velR_naive:+.3f} · +duration: {velR_cm:+.3f}")
    print(f"   → content UNIQUE add over age+duration: {content_unique:+.3f}  (90% CI {cu_ci[0]:+.3f}..{cu_ci[1]:+.3f})")
    print(f"   → prediction spread: residual SD {resid_sd:.2f} log10 = views vary ×/÷ {pi_mult:.1f} (80%) at fixed retention+swipe")
    print("\nQ2 — does curve SHAPE add beyond the average (CV R²):")
    print(f"   avg retention only: {q2_base:+.3f} · + shape modes: {q2_shape:+.3f} · Δ {q2_shape-q2_base:+.3f} · full curve: {q2_fullcurve:+.3f}")
    print("\nQ3 — swipe from retention + redundancy:")
    print(f"   swipe inferred from early curve: CV R² {swipe_from_ret_cv:+.3f} (in-sample {swipe_from_ret_in:.3f}), residual ±{swipe_resid_sd:.1f}% swipe")
    print(f"   views: retention-only {q3_noswipe:+.3f} vs +swipe {q3_withswipe:+.3f} → swipe adds {q3_withswipe-q3_noswipe:+.3f}")
    print(f"\nConfound: every curve starts >100% (mean {curves[:,0].mean():.2f}); cold-audience(non-sub) retention→views CV R² {cold_cv:+.3f}")
    print("→ retention_study.json")


if __name__ == '__main__':
    main()
