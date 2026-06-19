#!/usr/bin/env python3
"""
INTERACTIONS — how the significant features relate to EACH OTHER (not just to the target).

For each target, take its significant features (p<0.05) and build:
  1. a STABILIZED feature-feature correlation matrix (Ledoit-Wolf shrinkage — raw covariance is
     noisy with 211 samples × many features), reordered by hierarchical clustering so redundant
     blocks group together (the "decorrelation" view).
  2. a pairwise SYNERGY matrix toward the target:
       synergy(i,j) = R²(y ~ xi,xj) − ( r²i + r²j )
       > 0  → they explain MORE together than the sum → they AMPLIFY (complementary / suppression)
       ≈ 0  → independent contributors
       < 0  → they overlap → REDUNDANT (step on each other / destructively interfere)
  3. a multiplicative INTERACTION matrix: R²(y ~ xi,xj,xi·xj) − R²(y ~ xi,xj).

All on rank-transformed values (Spearman-consistent). Output: interactions.json
"""
import os, json
import numpy as np
from scipy.stats import rankdata
from scipy.cluster.hierarchy import linkage, leaves_list, fcluster
from scipy.spatial.distance import squareform
from sklearn.covariance import LedoitWolf

HERE = os.path.dirname(os.path.abspath(__file__))
K = 24                          # max features per target (keep the matrix readable)


def r2(cols, y):
    X = np.column_stack(cols + [np.ones(len(y))])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    pred = X @ beta
    ss, stot = ((y - pred) ** 2).sum(), ((y - y.mean()) ** 2).sum()
    return float(1 - ss / stot) if stot > 0 else 0.0


def main():
    CR = json.load(open(os.path.join(HERE, 'correlations.json')))
    fmap = {f['name']: f for f in CR['features']}
    out = {'meta': {'n': CR['meta']['n'], 'K': K}, 'targets': CR['targets'], 'per_target': {}}

    for t in CR['targets']:
        tk = t['key']; yv = CR['target_values'][tk]
        # significant features for this target, top-K by |r|
        sig = [(abs(f['corr'][tk]['r']), f['name']) for f in CR['features'] if tk in f['corr'] and f['corr'][tk]['p'] < 0.05]
        sig.sort(reverse=True)
        names = [nm for _, nm in sig[:K]]
        if len(names) < 3:
            out['per_target'][tk] = {'features': names, 'note': 'too few significant features'}
            continue
        # build value matrix on rows where target is present; impute feature gaps with median
        rows = [i for i in range(len(yv)) if yv[i] is not None]
        y = np.array([yv[i] for i in rows], float)
        cols = []
        for nm in names:
            v = fmap[nm]['values']
            col = np.array([v[i] if (i < len(v) and v[i] is not None) else np.nan for i in rows], float)
            med = np.nanmedian(col)
            col[~np.isfinite(col)] = med
            cols.append(col)
        # rank-transform (Spearman-consistent), z-score
        yr = rankdata(y); yz = (yr - yr.mean()) / (yr.std() + 1e-9)
        Xr = np.column_stack([rankdata(c) for c in cols]).astype(float)
        Xz = (Xr - Xr.mean(0)) / (Xr.std(0) + 1e-9)

        # 1. stabilized correlation matrix
        cov = LedoitWolf().fit(Xz).covariance_
        d = np.sqrt(np.diag(cov)); corr = cov / (np.outer(d, d) + 1e-12)
        np.fill_diagonal(corr, 1.0)
        # cluster order
        dist = 1 - np.abs(corr); np.fill_diagonal(dist, 0.0)
        order = list(range(len(names)))
        clusters = [0] * len(names)
        if len(names) >= 3:
            Z = linkage(squareform(dist, checks=False), method='average')
            order = list(leaves_list(Z))
            clusters = [int(c) for c in fcluster(Z, t=0.5, criterion='distance')]
        on = [names[i] for i in order]
        ocorr = [[round(float(corr[order[a]][order[b]]), 3) for b in range(len(order))] for a in range(len(order))]
        oclus = [clusters[i] for i in order]

        # 2/3. single r², pairwise synergy + interaction (in cluster order)
        single = {i: r2([Xz[:, i]], yz) for i in range(len(names))}
        syn = [[0.0] * len(order) for _ in order]
        inter = [[0.0] * len(order) for _ in order]
        pairs = []
        for a in range(len(order)):
            for b in range(len(order)):
                if a == b:
                    syn[a][b] = round(single[order[a]], 3); continue
                if b < a:
                    continue
                i, j = order[a], order[b]
                rp = r2([Xz[:, i], Xz[:, j]], yz)
                ri = r2([Xz[:, i], Xz[:, j], Xz[:, i] * Xz[:, j]], yz)
                sv = round(rp - (single[i] + single[j]), 3); iv = round(ri - rp, 3)
                syn[a][b] = syn[b][a] = sv; inter[a][b] = inter[b][a] = iv
                pairs.append({'a': names[i], 'b': names[j], 'corr': round(float(corr[i][j]), 3),
                              'r2_pair': round(rp, 3), 'synergy': sv, 'interaction': iv,
                              'ri': round(single[i], 3), 'rj': round(single[j], 3)})
        top_syn = sorted(pairs, key=lambda p: -p['synergy'])[:12]
        top_red = sorted([p for p in pairs if abs(p['corr']) > 0.35], key=lambda p: p['synergy'])[:12]
        top_int = sorted(pairs, key=lambda p: -p['interaction'])[:10]
        out['per_target'][tk] = {'features': on, 'clusters': oclus, 'corr': ocorr, 'synergy': syn, 'interaction': inter,
                                 'single_r2': [round(single[order[i]], 3) for i in range(len(order))],
                                 'top_synergy': top_syn, 'top_redundant': top_red, 'top_interaction': top_int}

    json.dump(out, open(os.path.join(HERE, 'interactions.json'), 'w'))
    for tk, d in out['per_target'].items():
        if 'top_synergy' in d:
            ts = d['top_synergy'][0]
            print(f"{tk:11} · {len(d['features'])} feats · best synergy: {ts['a']} + {ts['b']} = {ts['synergy']:+.3f} (pair R² {ts['r2_pair']})")


if __name__ == '__main__':
    main()
