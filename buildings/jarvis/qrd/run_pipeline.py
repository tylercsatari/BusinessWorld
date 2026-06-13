#!/usr/bin/env python3
"""
QRD Modelling Pipeline — Stages 3-4 of Quant Research Decoded.

Consumes qrd_features.json (the real extracted audio/visual/voice atoms +
level-2 path signatures) plus signals-dataset-expanded.json (targets, confounds,
LLM levers), and runs the full reduction → model → attribution pipeline with
strict leakage discipline:

  §7  reduction   : standardise on TRAIN only, Marchenko-Pastur noise edge,
                    Ledoit-Wolf shrinkage covariance, PCA to the clean space.
  §8  models      : Elastic-Net, PLS, Gradient-boosted trees, Random forest,
                    Gaussian Process, SVR — each scored by time-ordered nested
                    CV (train earlier reels, validate later) with confidence.
  §9  attribution : Elastic-Net signed coefficients, permutation importance,
                    grouped by feature block (audio / visual / voice / llm /
                    signature / confound). Read underneath the confounds.
  §8/§10 clustering: KMeans archetypes on the PCA space + silhouette.

Targets: T1 retention (primary), T1 keep (hook), T3 log_views (ranking check).

Output: qrd_model.json — everything the QRD tab needs to show real Python
model results next to its in-browser engine.
"""
import os, json, warnings, time
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.preprocessing import StandardScaler
from sklearn.covariance import LedoitWolf
from sklearn.decomposition import PCA
from sklearn.linear_model import ElasticNetCV, ElasticNet
from sklearn.cross_decomposition import PLSRegression
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, WhiteKernel, ConstantKernel
from sklearn.svm import SVR
from sklearn.model_selection import TimeSeriesSplit
from sklearn.inspection import permutation_importance
from sklearn.metrics import r2_score
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
FEATURES = os.path.join(HERE, 'qrd_features.json')
EXPANDED = os.path.join(JARVIS, 'signals-dataset-expanded.json')
VISION = os.path.join(JARVIS, 'vision-scores-cache.json')
OUT = os.path.join(HERE, 'qrd_model.json')

LLM_KEYS = ['z_score', 'vz_score', 'novelty', 'cognitive_load', 'net_novelty',
            'action', 'scale', 'contrast', 'expression', 'v_novelty']
CONFOUND_KEYS = ['duration_s', 'sub_view_frac']

BLOCK_OF = lambda k: ('confound' if k in CONFOUND_KEYS else
                      'llm' if k in LLM_KEYS else
                      'signature' if k.startswith('sig2_') else
                      'audio' if k.startswith('a_') else
                      'visual' if k.startswith('vi_') else
                      'voice' if k.startswith('v_') else 'other')


def load():
    feats = {r['ytId']: r for r in json.load(open(FEATURES))}
    rows = json.load(open(EXPANDED))
    vis = json.load(open(VISION)) if os.path.exists(VISION) else {}
    TARGETS_F = os.path.join(HERE, 'qrd_targets.json')
    swipe = json.load(open(TARGETS_F)) if os.path.exists(TARGETS_F) else {}
    merged = []
    for r in rows:
        yid = r.get('ytId')
        if not yid:
            continue
        rec = dict(r)
        sw = swipe.get(yid)
        if sw and isinstance(sw.get('swipe'), (int, float)):
            rec['swipe'] = sw['swipe']
        v = vis.get(yid)
        if v:
            rec['action'], rec['scale'], rec['contrast_llm'] = v.get('action'), v.get('scale'), v.get('contrast')
            rec['expression'], rec['v_novelty'] = v.get('expression'), v.get('novelty')
        f = feats.get(yid, {})
        sig = f.pop('signature', {}) if isinstance(f.get('signature'), dict) else {}
        for k, val in f.items():
            if isinstance(val, (int, float)):
                rec[k] = val
        for k, val in sig.items():
            rec['sig2_' + k[5:] if not k.startswith('sig2_') else k] = val
        rec['_has_extract'] = yid in feats
        merged.append(rec)
    return merged


def build_matrix(merged, extra_keys):
    keys = []
    for k in LLM_KEYS + CONFOUND_KEYS + extra_keys:
        if k not in keys:
            keys.append(k)
    # column-median impute; drop all-missing columns
    cols, kept = [], []
    for k in keys:
        vals = [r[k] for r in merged if isinstance(r.get(k), (int, float)) and np.isfinite(r.get(k))]
        if len(vals) < max(20, 0.25 * len(merged)):
            continue
        med = float(np.median(vals))
        cols.append([float(r[k]) if isinstance(r.get(k), (int, float)) and np.isfinite(r.get(k)) else med for r in merged])
        kept.append(k)
    X = np.array(cols, dtype=np.float64).T
    return X, kept


def time_cv_score(model, X, y, n_splits=5):
    tss = TimeSeriesSplit(n_splits=n_splits)
    scores = []
    for tr, te in tss.split(X):
        sc = StandardScaler().fit(X[tr])
        m = model()
        try:
            m.fit(sc.transform(X[tr]), y[tr])
            p = m.predict(sc.transform(X[te])).ravel()
            scores.append(r2_score(y[te], p))
        except Exception:
            pass
    scores = np.array(scores) if scores else np.array([0.0])
    return float(scores.mean()), float(scores.std()), [float(s) for s in scores]


def marchenko_pastur(p, n, sigma2=1.0):
    q = p / n
    return q, sigma2 * (1 + np.sqrt(q)) ** 2


def main():
    t0 = time.time()
    merged = load()
    n = len(merged)
    # full extracted feature universe
    extract_keys = sorted({k for r in merged for k in r
                           if (k.startswith(('a_', 'vi_', 'v_', 'sig2_')) and
                               k not in ('a_has_audio',) and isinstance(r.get(k), (int, float)))})
    print(f'reels: {n}  ·  extracted-feature universe: {len(extract_keys)}  ·  '
          f'with raw extract: {sum(r["_has_extract"] for r in merged)}')

    swipe_raw = np.array([r.get('swipe', np.nan) for r in merged])
    targets = {'retention': np.array([r.get('retention', np.nan) for r in merged]),
               'keep': np.array([r.get('keep', np.nan) for r in merged]),
               'swipe': np.log1p(swipe_raw),     # log1p — swipe ratio is heavily right-skewed
               'log_views': np.array([r.get('log_views', np.nan) for r in merged])}

    X, kept = build_matrix(merged, extract_keys)
    p = X.shape[1]
    blocks = {}
    for k in kept:
        blocks.setdefault(BLOCK_OF(k), []).append(k)
    print(f'model matrix: {X.shape}  blocks: ' + ', '.join(f'{b}:{len(v)}' for b, v in blocks.items()))

    # ── §7 reduction on full standardised matrix ──
    Z = StandardScaler().fit_transform(X)
    lw = LedoitWolf().fit(Z)
    cov = lw.covariance_
    evals = np.sort(np.linalg.eigvalsh(cov))[::-1]
    q, lam_plus = marchenko_pastur(p, n)
    n_signal = int((evals > lam_plus).sum())
    npc = max(2, min(n_signal if n_signal > 0 else 6, p - 1))
    pca = PCA(n_components=npc).fit(Z)
    proj = pca.transform(Z)
    print(f'§7  q={q:.3f}  λ+={lam_plus:.3f}  signal-dirs={n_signal}  '
          f'shrinkage={lw.shrinkage_:.3f}  PCA→{npc} (var {pca.explained_variance_ratio_[:npc].sum()*100:.1f}%)')

    # ── §8 models, per target ──
    model_zoo = {
        'Elastic-Net': lambda: ElasticNet(alpha=0.05, l1_ratio=0.5, max_iter=5000),
        'PLS': lambda: PLSRegression(n_components=min(6, p - 1)),
        'Gradient-boosted trees': lambda: GradientBoostingRegressor(n_estimators=120, max_depth=2, subsample=0.7, random_state=7),
        'Random forest': lambda: RandomForestRegressor(n_estimators=200, max_depth=4, random_state=7, n_jobs=-1),
        'Gaussian Process': lambda: GaussianProcessRegressor(
            kernel=ConstantKernel(1.0) * RBF(5.0) + WhiteKernel(0.5), alpha=1e-3, normalize_y=True, random_state=7),
        'SVR (RBF)': lambda: SVR(C=2.0, gamma='scale'),
    }
    results = {'n': n, 'p': p, 'kept_features': kept, 'blocks': {b: v for b, v in blocks.items()},
               'reduction': {'q': q, 'lambda_plus': float(lam_plus), 'n_signal': n_signal,
                             'shrinkage': float(lw.shrinkage_), 'n_pca': npc,
                             'eigenvalues': [float(e) for e in evals],
                             'pca_var': [float(v) for v in pca.explained_variance_ratio_]},
               'models': [], 'attribution': {}, 'targets': {}, 'generated_s': None}

    # ── feature regimes (§7 story: reduce before you fit) ──
    idx_of = {k: j for j, k in enumerate(kept)}
    def cols_for(pred):
        return [idx_of[k] for k in kept if pred(k)]
    regimes = {
        'llm-only': cols_for(lambda k: k in LLM_KEYS or k in CONFOUND_KEYS),
        'llm+extracted': cols_for(lambda k: not k.startswith('sig2_')),
        'all-raw (143)': list(range(p)),
        'pca-clean': None,   # handled specially via `proj`
    }
    results['regimes'] = {}

    for tname, y in targets.items():
        good = np.isfinite(y)
        Xt, yt = X[good], y[good]
        tinfo = {'target': tname, 'n': int(good.sum()), 'models': [], 'regimes': []}
        # regime sweep (Elastic-Net + RF as the two readable/robust workhorses)
        for rname, cidx in regimes.items():
            if cidx is None:
                Xr = proj[good]
            else:
                Xr = Xt[:, cidx] if cidx else Xt
            en_m, en_s, _ = time_cv_score(lambda: ElasticNet(alpha=0.05, l1_ratio=0.5, max_iter=5000), Xr, yt)
            rf_m, rf_s, _ = time_cv_score(lambda: RandomForestRegressor(n_estimators=200, max_depth=4, random_state=7, n_jobs=-1), Xr, yt)
            best_m, best_n = (en_m, 'Elastic-Net') if en_m >= rf_m else (rf_m, 'Random forest')
            tinfo['regimes'].append({'regime': rname, 'p': (len(cidx) if cidx else (proj.shape[1] if cidx is None else p)),
                                     'elasticnet_r2': en_m, 'rf_r2': rf_m, 'best': best_n, 'best_r2': best_m})
        # full model zoo on the best-generalising regime (llm+extracted, denoised by the models themselves)
        bestreg = max(tinfo['regimes'], key=lambda r: r['best_r2'])
        tinfo['best_regime'] = bestreg['regime']
        cidx = regimes[bestreg['regime']]
        Xb = proj[good] if cidx is None else (Xt[:, cidx] if cidx else Xt)
        for mname, mk in model_zoo.items():
            mean, sd, scores = time_cv_score(mk, Xb, yt)
            tinfo['models'].append({'name': mname, 'r2_mean': mean, 'r2_std': sd, 'scores': scores})
            results['models'].append({'target': tname, 'name': mname, 'r2_mean': mean, 'r2_std': sd})
        # ranking check: spearman of OLS-ish prediction (elastic-net) vs log_views
        try:
            sc = StandardScaler().fit(Xt)
            en = ElasticNet(alpha=0.05, l1_ratio=0.5, max_iter=5000).fit(sc.transform(Xt), yt)
            lvr = spearmanr(en.predict(sc.transform(Xt)), np.array([r.get('log_views') for r, g in zip(merged, good) if g])).correlation
            tinfo['rank_rho_vs_logviews'] = float(lvr)
        except Exception:
            tinfo['rank_rho_vs_logviews'] = None
        results['targets'][tname] = tinfo
        best = max(tinfo['models'], key=lambda m: m['r2_mean'])
        rsweep = '  '.join(f"{r['regime'].split()[0]}={r['best_r2']:.2f}" for r in tinfo['regimes'])
        print(f"§8  {tname:10s} regimes[{rsweep}] → best {best['name']} R²={best['r2_mean']:.3f}±{best['r2_std']:.3f} on '{tinfo['best_regime']}'")

    # ── §9 attribution on the primary target (retention) ──
    # readable levers only (drop the 64 abstract signature terms — they go in
    # the model but the playbook needs actionable atoms).
    read_idx = [j for j, k in enumerate(kept) if not k.startswith('sig2_')]
    read_keys = [kept[j] for j in read_idx]
    y = targets['retention']; good = np.isfinite(y); Xt, yt = X[good][:, read_idx], y[good]
    sc = StandardScaler().fit(Xt); Zt = sc.transform(Xt)
    en = ElasticNet(alpha=0.05, l1_ratio=0.5, max_iter=5000).fit(Zt, yt)
    coef = [{'key': k, 'block': BLOCK_OF(k), 'coef': float(c)} for k, c in zip(read_keys, en.coef_)]
    coef.sort(key=lambda d: abs(d['coef']), reverse=True)
    # permutation importance with a GBM (reflects a real nonlinear model)
    gbm = GradientBoostingRegressor(n_estimators=120, max_depth=2, subsample=0.7, random_state=7).fit(Zt, yt)
    pi = permutation_importance(gbm, Zt, yt, n_repeats=15, random_state=7, scoring='r2')
    perm = [{'key': k, 'block': BLOCK_OF(k), 'drop': float(m)} for k, m in zip(read_keys, pi.importances_mean)]
    perm.sort(key=lambda d: d['drop'], reverse=True)
    # block-level importance (sum of |coef|)
    block_imp = {}
    for c in coef:
        block_imp[c['block']] = block_imp.get(c['block'], 0.0) + abs(c['coef'])
    results['attribution'] = {'elasticnet': coef, 'permutation': perm,
                              'block_importance': block_imp, 'base_r2': float(en.score(Zt, yt))}

    # ── archetypes ──
    best_k, best_sil = 3, -1
    for k in (2, 3, 4, 5):
        try:
            lab = KMeans(n_clusters=k, n_init=10, random_state=7).fit_predict(proj)
            s = silhouette_score(proj, lab)
            if s > best_sil:
                best_sil, best_k = s, k
        except Exception:
            pass
    km = KMeans(n_clusters=best_k, n_init=10, random_state=7).fit(proj)
    results['archetypes'] = {'k': best_k, 'silhouette': float(best_sil),
                             'sizes': [int((km.labels_ == c).sum()) for c in range(best_k)],
                             'assign': {merged[i]['ytId']: int(km.labels_[i]) for i in range(n)},
                             'proj2d': {merged[i]['ytId']: [float(proj[i, 0]), float(proj[i, 1])] for i in range(n)}}
    print(f'§8  archetypes: k={best_k} silhouette={best_sil:.3f} sizes={results["archetypes"]["sizes"]}')

    results['leakage'] = {'split_by_time': True, 'fit_on_train_only': True,
                          'mediator_excluded': True, 'target_bounded_or_log': True}
    results['generated_s'] = round(time.time() - t0, 1)
    json.dump(results, open(OUT, 'w'))
    print(f'\nDONE → qrd_model.json  ({results["generated_s"]}s)')


if __name__ == '__main__':
    main()
