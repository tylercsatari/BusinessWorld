#!/usr/bin/env python3
"""
QUANT 2 · Phases 3-4 — embedding hazard model + latent discovery + content manifold.

Consumes the frozen DINOv2 embeddings (quant2/emb/<id>.npy) + the manifest's true
labels, and asks the only honest question: do the self-supervised SENSORY features
predict the swipe hazard better than the cheap tabular features, out-of-fold?

Rigor (n≈213 — overfitting is the enemy):
  • Embeddings are 768-d (mean⊕hook). We PCA-reduce to K components, fit on the
    TRAIN fold only inside CV (no leak). K kept small (Marchenko-Pastur edge).
  • Discrete-time logit-hazard, pooled (reel × interval), GROUPED time-split CV by
    real publish date (all intervals of a reel stay together; train earlier reels).
  • We report the embedding model AND the tabular baseline AND embedding+tabular, so
    the lift (if any) is explicit. No lift → say so; don't pretend.

Latent discovery: PLS(embedding-PCA → reel hazard vector) → directions that move
leave-probability, with the example reels at each extreme (named post-hoc, in the UI).

Manifold (the 213 true-label set; corpus added once its frames are pulled): PCA→2D,
k-means archetypes, novelty = mean cosine distance to k nearest neighbours.

Output: quant2_emb_model.json.
"""
import os, json, warnings, datetime
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.linear_model import ElasticNet
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.cross_decomposition import PLSRegression
from sklearn.cluster import KMeans
from sklearn.metrics import r2_score, silhouette_score
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
EMB = os.path.join(HERE, 'emb')
MANIFEST = os.path.join(HERE, 'manifest.json')
OUT = os.path.join(HERE, 'quant2_emb_model.json')

TAB_KEYS = ['z_score', 'vz_score', 'novelty', 'cognitive_load', 'net_novelty', 'action', 'scale',
            'contrast', 'expression', 'v_novelty', 'a_loud_first3_ratio', 'a_loud_slope', 'a_onset_mean',
            'a_centroid_mean', 'a_pitch_slope', 'vi_cut_rate', 'vi_motion_mean', 'vi_bright_slope',
            'vi_sat_mean', 'vi_face_frac', 'vi_face_size', 'vi_text_at0', 'v_speaking_rate',
            'v_time_first_word', 'v_hook_question', 'duration_s']
K_EMB = 16   # PCA components kept from the 768-d embedding


def survival_to_hazard(S):
    return [float(min(1 - 1e-3, max(1e-3, (S[j] - S[j + 1]) / max(S[j], 1e-6)))) for j in range(4)]


def load():
    man = json.load(open(MANIFEST))
    sig = {r['ytId']: r for r in __import__('json').load(open(os.path.join(os.path.dirname(HERE), 'signals-dataset-expanded.json')))} \
        if os.path.exists(os.path.join(os.path.dirname(HERE), 'signals-dataset-expanded.json')) else {}
    rows = []
    for v in man['videos']:
        if v['tier'] != 'true_label' or not v.get('targets') or not v['targets'].get('survival'):
            continue
        ep = os.path.join(EMB, v['id'] + '.npy')
        if not os.path.exists(ep):
            continue
        e = np.load(ep, allow_pickle=True).item()
        emb = np.concatenate([e['mean'], e['hook']]).astype(np.float32)   # 768
        S = v['targets']['survival']
        dt = None
        try:
            dt = datetime.date.fromisoformat(v['published']) if v.get('published') else None
        except Exception:
            dt = None
        sg = sig.get(v['id'], {})
        tab = [float(sg.get(k)) if isinstance(sg.get(k), (int, float)) and np.isfinite(sg.get(k)) else np.nan for k in TAB_KEYS]
        _root = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))   # project root
        fdir_abs = os.path.join(_root, v['frame_dir'])
        ff = sorted([f for f in os.listdir(fdir_abs) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]) if os.path.isdir(fdir_abs) else []
        rows.append({'id': v['id'], 'name': v.get('name', v['id'])[:48], 'emb': emb, 'S': S,
                     'h': survival_to_hazard(S), 'dt': dt, 'tab': tab, 'frame_dir': v['frame_dir'],
                     'n_frames': v['n_frames'], 'frame0': ff[len(ff) // 4] if ff else None})
    # impute tab medians
    T = np.array([r['tab'] for r in rows])
    for j in range(T.shape[1]):
        col = T[:, j]; med = np.nanmedian(col[np.isfinite(col)]) if np.isfinite(col).any() else 0.0
        col[~np.isfinite(col)] = med; T[:, j] = col
    for i, r in enumerate(rows):
        r['tab'] = T[i]
    # recency confound
    valid = [r['dt'] for r in rows if r['dt']]
    base = min(valid) if valid else None
    for r in rows:
        r['recency'] = ((r['dt'] - base).days / 365.0) if (r['dt'] and base) else 0.0
    rows.sort(key=lambda r: (r['dt'] is None, r['dt'] or datetime.date(1900, 1, 1)))
    return rows, man['stats']


def pooled(rows, feat_fn):
    """Build pooled (reel×interval) design from a per-reel feature function."""
    X, y, grp = [], [], []
    for gi, r in enumerate(rows):
        f = feat_fn(r)
        for j in range(4):
            iv = [1.0 if k == j else 0.0 for k in range(4)]
            X.append(list(f) + iv + [r['recency']])
            y.append(r['h'][j]); grp.append(gi)
    return np.array(X), np.array(y), np.array(grp)


def grouped_cv(rows, feat_fn, model_fn, pca_on=None, n_folds=5):
    """Grouped time-split CV. pca_on: index slice to PCA-reduce on train only."""
    uniq = list(range(len(rows)))   # rows already chronological → group index = time
    ng = len(uniq); start = int(ng * 0.4); step = max(1, (ng - start) // n_folds)
    scores, sp = [], []
    for f in range(n_folds):
        tr_g = set(uniq[:start + f * step]); te_g = set(uniq[start + f * step:start + (f + 1) * step])
        if not te_g or len(tr_g) < 8:
            continue
        Xtr, ytr, gtr = pooled([rows[i] for i in sorted(tr_g)], feat_fn)
        Xte, yte, gte = pooled([rows[i] for i in sorted(te_g)], feat_fn)
        if pca_on is not None:
            a, b = pca_on
            pca = PCA(n_components=min(K_EMB, b - a, len(tr_g) - 1)).fit(StandardScaler().fit_transform(Xtr[:, a:b]))
            scl = StandardScaler().fit(Xtr[:, a:b])
            Xtr = np.concatenate([pca.transform(scl.transform(Xtr[:, a:b])), Xtr[:, b:]], 1)
            Xte = np.concatenate([pca.transform(scl.transform(Xte[:, a:b])), Xte[:, b:]], 1)
        sc = StandardScaler().fit(Xtr)
        m = model_fn().fit(sc.transform(Xtr), np.log(ytr / (1 - ytr)))
        ph = 1 / (1 + np.exp(-m.predict(sc.transform(Xte))))
        if len(yte) > 2:
            scores.append(r2_score(yte, ph)); s = spearmanr(yte, ph).correlation
            if np.isfinite(s):
                sp.append(s)
    return (float(np.mean(scores)) if scores else 0.0, float(np.std(scores)) if len(scores) > 1 else 0.0,
            float(np.mean(sp)) if sp else 0.0)


def main():
    rows, stats = load()
    n = len(rows)
    if n < 20:
        print(f'only {n} embedded true-label videos — wait for embed_frames.py to finish.'); return
    E = np.array([r['emb'] for r in rows]); Tb = np.array([r['tab'] for r in rows])
    print(f'{n} true-label videos with DINOv2 embeddings (768-d) + {Tb.shape[1]} tabular features', flush=True)

    EN = lambda: ElasticNet(alpha=0.05, l1_ratio=0.5, max_iter=5000)
    GB = lambda: GradientBoostingRegressor(n_estimators=80, max_depth=2, subsample=0.7, random_state=7)
    ne = E.shape[1]
    # three models, identical CV protocol
    tab_en = grouped_cv(rows, lambda r: r['tab'], EN)
    emb_en = grouped_cv(rows, lambda r: r['emb'], EN, pca_on=(0, ne))
    both_en = grouped_cv(rows, lambda r: list(r['emb']) + list(r['tab']), EN, pca_on=(0, ne))
    emb_gb = grouped_cv(rows, lambda r: r['emb'], GB, pca_on=(0, ne))
    print(f"hazard OOF R²/ρ  ·  tabular {tab_en[0]:.3f}/{tab_en[2]:.2f}  ·  DINOv2 {emb_en[0]:.3f}/{emb_en[2]:.2f}  ·  "
          f"DINOv2+tab {both_en[0]:.3f}/{both_en[2]:.2f}  ·  DINOv2-GBT {emb_gb[0]:.3f}/{emb_gb[2]:.2f}", flush=True)

    # ── content manifold (descriptive, whole-set) ──
    Es = StandardScaler().fit_transform(E)
    pca = PCA(n_components=min(K_EMB, n - 1)).fit(Es)
    P = pca.transform(Es)
    p2 = PCA(n_components=2).fit_transform(Es)
    bestk, bestsil = 3, -1
    for k in (2, 3, 4, 5, 6):
        try:
            lab = KMeans(n_clusters=k, n_init=10, random_state=7).fit_predict(P)
            s = silhouette_score(P, lab)
            if s > bestsil:
                bestsil, bestk = s, k
        except Exception:
            pass
    km = KMeans(n_clusters=bestk, n_init=10, random_state=7).fit(P)
    # novelty = mean cosine distance to 8 nearest neighbours (embedding space)
    En = E / (np.linalg.norm(E, axis=1, keepdims=True) + 1e-9)
    sims = En @ En.T; np.fill_diagonal(sims, -1)
    knn = np.sort(sims, axis=1)[:, -8:].mean(1)
    novelty = (1 - knn)   # higher = more novel (further from neighbours)

    # ── latent discovery: PLS(embedding-PCA → hazard vector) ──
    Hv = np.array([r['h'] for r in rows])
    npc = min(6, P.shape[1])
    pls = PLSRegression(n_components=npc).fit(P, Hv)
    proj = pls.transform(P)
    latents = []
    mh = Hv.mean(1)
    for c in range(npc):
        sc_c = proj[:, c]
        eff = float(spearmanr(sc_c, mh).correlation)
        order = np.argsort(sc_c)
        ex = lambda i: {'id': rows[i]['id'], 'name': rows[i]['name'], 'frame0': rows[i]['frame0'], 'mean_hazard': round(float(mh[i]), 3)}
        latents.append({'id': c, 'effect_on_hazard_rho': eff,
                        'low_hazard_examples': [ex(i) for i in order[-4:][::-1]],
                        'high_hazard_examples': [ex(i) for i in order[:4]]})

    out = {
        'n': n, 'emb_dim': int(ne), 'emb_model': 'facebook/dinov2-small (frozen)',
        'hazard': {
            'tabular': {'r2': tab_en[0], 'r2_std': tab_en[1], 'rho': tab_en[2]},
            'dinov2': {'r2': emb_en[0], 'r2_std': emb_en[1], 'rho': emb_en[2]},
            'dinov2_plus_tab': {'r2': both_en[0], 'r2_std': both_en[1], 'rho': both_en[2]},
            'dinov2_gbt': {'r2': emb_gb[0], 'r2_std': emb_gb[1], 'rho': emb_gb[2]},
            'lift_rho': round(emb_en[2] - tab_en[2], 3),
        },
        'manifold': {
            'k': bestk, 'silhouette': float(bestsil),
            'pca_var': [float(x) for x in pca.explained_variance_ratio_[:K_EMB]],
            'videos': [{'id': rows[i]['id'], 'name': rows[i]['name'], 'frame0': rows[i]['frame0'],
                        'x': float(p2[i, 0]), 'y': float(p2[i, 1]),
                        'cluster': int(km.labels_[i]), 'novelty': float(novelty[i]),
                        'mean_hazard': float(mh[i])} for i in range(n)],
        },
        'latent_directions': latents,
        'honesty': ('DINOv2 features are frozen self-supervised (no labels). PCA fit on TRAIN fold only. '
                    'At n=%d the embedding model is a calibration scaffold; the lift over tabular is reported '
                    'honestly (lift_rho). The big win needs the corpus manifold + more true labels + per-second curves.' % n),
    }
    json.dump(out, open(OUT, 'w'))
    print(f"manifold: k={bestk} sil={bestsil:.3f}  ·  latent effect ρ: {[round(l['effect_on_hazard_rho'],2) for l in latents]}")
    print(f"embedding lift over tabular (rank ρ): {out['hazard']['lift_rho']:+.3f}")
    print(f"→ quant2_emb_model.json")


if __name__ == '__main__':
    main()
