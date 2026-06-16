#!/usr/bin/env python3
"""
QUANT 2 · Phase 5 — teacher→student pseudo-labelling + full content manifold.

The IDM→VPT move, done HONESTLY:
  • TEACHER: a swipe-hazard regressor trained on ALL true-label reels (DINOv2 emb,
    PCA-reduced). It learned structure→swipe from the gold set.
  • Run the teacher on every embedded CORPUS video (the 100M-view set, no labels).
  • For each corpus video store the teacher's prediction WITH its honesty metadata:
      - confidence  = how in-distribution it is (cosine NN similarity to the gold set)
      - nearest true examples (so a human can sanity-check)
      - in_distribution flag (NN sim above a percentile of gold↔gold sims)
    Pseudo-labels are TEACHER OPINIONS, never truth. Only high-confidence, in-distribution
    ones may later become weak (0.1–0.3 weight) training signal, validated on real held-out.

  • MANIFOLD: PCA→2D + k-means archetypes over the WHOLE set (gold + corpus), with
    market-relative novelty (NN distance in the full corpus) and per-cluster view stats.

Runs on whatever is embedded so far (idempotent). Output: quant2_corpus.json.
"""
import os, json, warnings
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

HERE = os.path.dirname(os.path.abspath(__file__))
EMB = os.path.join(HERE, 'emb')
MANIFEST = os.path.join(HERE, 'manifest.json')
OUT = os.path.join(HERE, 'quant2_corpus.json')


def survival_to_meanhaz(S):
    hz = [(S[j] - S[j + 1]) / max(S[j], 1e-6) for j in range(4)]
    return float(np.clip(np.mean(hz), 1e-3, 1 - 1e-3))


def main():
    man = {v['id']: v for v in json.load(open(MANIFEST))['videos']}
    gold_E, gold_y, gold_id = [], [], []
    corp_E, corp_meta = [], []
    for fn in os.listdir(EMB):
        if not fn.endswith('.npy'):
            continue
        vid = fn[:-4]; m = man.get(vid)
        if not m:
            continue
        e = np.load(os.path.join(EMB, fn), allow_pickle=True).item()
        emb = np.concatenate([e['mean'], e['hook']]).astype(np.float32)
        if m['tier'] == 'true_label' and m.get('targets', {}).get('survival'):
            gold_E.append(emb); gold_y.append(survival_to_meanhaz(m['targets']['survival'])); gold_id.append(vid)
        elif m['tier'] == 'corpus':
            corp_E.append(emb); corp_meta.append({'id': vid, 'name': (m.get('name') or vid)[:48],
                                                  'views': m.get('views'), 'frame0': None})
    gold_E = np.array(gold_E); corp_E = np.array(corp_E) if corp_E else np.zeros((0, gold_E.shape[1]))
    print(f'gold {len(gold_E)} · corpus embedded {len(corp_E)}', flush=True)
    if len(gold_E) < 20:
        print('not enough gold embeddings yet'); return

    # ── teacher on gold ──
    scl = StandardScaler().fit(gold_E)
    pca = PCA(n_components=min(16, len(gold_E) - 1)).fit(scl.transform(gold_E))
    Gp = pca.transform(scl.transform(gold_E))
    teacher = GradientBoostingRegressor(n_estimators=120, max_depth=2, subsample=0.7, random_state=7).fit(Gp, np.array(gold_y))

    # gold↔gold cosine sims → in-distribution threshold
    Gn = gold_E / (np.linalg.norm(gold_E, axis=1, keepdims=True) + 1e-9)
    gg = Gn @ Gn.T; np.fill_diagonal(gg, -1)
    gold_nn = np.sort(gg, axis=1)[:, -5:].mean(1)
    indist_thresh = float(np.percentile(gold_nn, 10))   # 10th pct of gold self-similarity

    pseudo = []
    if len(corp_E):
        Cp = pca.transform(scl.transform(corp_E))
        pred = teacher.predict(Cp)
        Cn = corp_E / (np.linalg.norm(corp_E, axis=1, keepdims=True) + 1e-9)
        sims = Cn @ Gn.T                                  # corpus × gold cosine
        nn = np.sort(sims, axis=1)[:, -5:].mean(1)        # mean top-5 sim to gold
        nn_idx = np.argsort(sims, axis=1)[:, -3:]
        for i, m in enumerate(corp_meta):
            conf = float(np.clip((nn[i] - indist_thresh) / (1 - indist_thresh + 1e-6), 0, 1))
            pseudo.append({**m, 'pred_hazard': float(np.clip(pred[i], 0, 1)), 'confidence': conf,
                           'in_distribution': bool(nn[i] >= indist_thresh),
                           'nearest_true': [gold_id[j] for j in nn_idx[i][::-1]]})
        n_use = sum(1 for p in pseudo if p['in_distribution'] and p['confidence'] > 0.5)
        print(f'pseudo-labelled {len(pseudo)} corpus videos · usable (in-dist & conf>0.5): {n_use}', flush=True)

    # ── full manifold (gold + corpus) ──
    allE = np.concatenate([gold_E, corp_E], 0) if len(corp_E) else gold_E
    allMeta = [{'id': gold_id[i], 'tier': 'gold'} for i in range(len(gold_E))] + \
              [{'id': corp_meta[i]['id'], 'tier': 'corpus', 'views': corp_meta[i]['views']} for i in range(len(corp_E))]
    sA = StandardScaler().fit(allE); Pa = PCA(n_components=min(16, len(allE) - 1)).fit(sA.transform(allE))
    Z = Pa.transform(sA.transform(allE)); Z2 = PCA(n_components=2).fit_transform(sA.transform(allE))
    bestk, bestsil = 4, -1
    for k in (3, 4, 5, 6, 8):
        try:
            lab = KMeans(n_clusters=k, n_init=10, random_state=7).fit_predict(Z); s = silhouette_score(Z, lab)
            if s > bestsil:
                bestsil, bestk = s, k
        except Exception:
            pass
    km = KMeans(n_clusters=bestk, n_init=10, random_state=7).fit(Z)
    An = allE / (np.linalg.norm(allE, axis=1, keepdims=True) + 1e-9)
    # novelty via faiss-free cosine (sampled if large)
    sims_all = An @ An.T; np.fill_diagonal(sims_all, -1)
    nov = 1 - np.sort(sims_all, axis=1)[:, -8:].mean(1)
    # per-cluster view stats
    cl_views = {}
    for i, mta in enumerate(allMeta):
        c = int(km.labels_[i]); cl_views.setdefault(c, []).append(mta.get('views') or 0)
    clusters = [{'cluster': c, 'size': int((km.labels_ == c).sum()),
                 'median_views': float(np.median([v for v in cl_views.get(c, [0]) if v])) if any(cl_views.get(c, [])) else 0} for c in range(bestk)]

    # sample for UI (cap points)
    idx = list(range(len(allMeta)))
    if len(idx) > 1200:
        idx = list(np.random.choice(idx, 1200, replace=False))
    pts = [{'id': allMeta[i]['id'], 'tier': allMeta[i]['tier'], 'x': float(Z2[i, 0]), 'y': float(Z2[i, 1]),
            'cluster': int(km.labels_[i]), 'novelty': float(nov[i]), 'views': allMeta[i].get('views')} for i in idx]

    out = {
        'n_gold': int(len(gold_E)), 'n_corpus': int(len(corp_E)),
        'teacher': 'GBT on DINOv2-PCA (gold mean-hazard)', 'indist_threshold': indist_thresh,
        'manifold': {'k': bestk, 'silhouette': float(bestsil), 'clusters': clusters, 'points': pts},
        'pseudo_labels_summary': {
            'n': len(pseudo),
            'usable': sum(1 for p in pseudo if p.get('in_distribution') and p.get('confidence', 0) > 0.5),
            'mean_confidence': float(np.mean([p['confidence'] for p in pseudo])) if pseudo else 0,
            'examples_high_conf': sorted([p for p in pseudo if p.get('in_distribution')], key=lambda p: -p['confidence'])[:12],
            'examples_low_conf': sorted(pseudo, key=lambda p: p['confidence'])[:6],
        },
        'honesty': ('Pseudo-labels are TEACHER OPINIONS, not truth. Confidence = in-distribution cosine '
                    'similarity to the gold set. Only high-confidence in-distribution videos may later be used '
                    'as weak (0.1–0.3 weight) training signal, and ONLY if a student trained with them improves '
                    'real held-out retention. This file is the cautious amplifier, never a source of ground truth.'),
    }
    json.dump(out, open(OUT, 'w'))
    print(f"manifold k={bestk} sil={bestsil:.3f} · clusters {[c['size'] for c in clusters]} · → quant2_corpus.json")


if __name__ == '__main__':
    main()
