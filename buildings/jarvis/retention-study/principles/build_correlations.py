#!/usr/bin/env python3
"""
CORRELATIONS — the SCORES you see when analysing a video, vs the rate targets.

Simplified to exactly the interpretable numbers shown in the per-video panel (so a future
scoring/backtest model produces the same outputs):
  global novelty (whole/concept/visual/text), per-second novelty, niche distance per modality,
  temporal novelty, coherence, combinatorial rarity, scene spread, object counts.
(Abstract derived stats — deltas, trajectory geometry, cluster-membership, slopes — are dropped.)

Targets are ONLY the rates we care about: keep rate (swipe), avg retention, 5-second retention.
Spearman r, p, n + significance (raw p<0.05, Benjamini-Hochberg FDR). Output: correlations.json
"""
import os, json
import numpy as np
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
MODS = ['whole', 'concept', 'visual', 'text']


def main():
    N = json.load(open(os.path.join(HERE, 'novelty.json')))
    T = json.load(open(os.path.join(RS, 'retention_table.json')))
    tby = {v['id']: v for v in T['videos']}
    V = N['videos']; n = len(V)
    H = N['hook']

    # ── targets: the rates only ──
    keep, ret, ret5 = [], [], []
    grid = np.linspace(0, 1, 100)
    for v in V:
        t = tby.get(v['id'], {})
        keep.append(t.get('keep_rate')); ret.append(t.get('avg_retention'))
        cv, d = t.get('curve'), t.get('duration_s')
        ret5.append(float(np.interp(min(1.0, 5.0 / d), grid, cv) / (sum(cv[:3]) / 3) * 100) if cv and d else None)  # 5s survival from opening
    targets = {'keep_rate': keep, 'ret_5s': ret5, 'retention': ret}
    TGT_LABEL = {'keep_rate': 'Keep rate (swipe)', 'ret_5s': '5-sec retention', 'retention': 'Avg retention'}

    # ── features: exactly the panel scores ──
    feats = {}

    def add(name, group, arr):
        feats[name] = (group, arr)

    persec = [sorted(v.get('persec', []), key=lambda p: p['sec']) for v in V]

    def ps(i, sec, get):
        for p in persec[i]:
            if p['sec'] == sec:
                return get(p)
        return None

    for m in MODS:
        add(f'global_nov_{m}', 'global novelty', [H['global'][m]['nov'][i] for i in range(n)])
        add(f'niche_dist_{m}', 'niche', [H['niche'][m]['dist_to_centre'][i] for i in range(n)])
        for s in range(5):
            add(f'nov_s{s}_{m}', 'per-second novelty', [ps(i, s, (lambda mm: lambda p: p['nov'][mm])(m)) for i in range(n)])
    add('temporal_hook', 'temporal', [H['temporal']['nov'][i] for i in range(n)])
    add('coherence_hook', 'coherence', [H['coherent']['coherence'][i] for i in range(n)])
    add('combo_rarity', 'combinatorial', [N['combo']['rarity'][i] for i in range(n)])
    add('scene_spread', 'scene', [H['scene']['spread'][i] for i in range(n)])
    add('nobj_hook', 'objects', [len(v.get('objects_hook', [])) for v in V])
    for s in range(5):
        add(f'coh_s{s}', 'coherence', [ps(i, s, lambda p: p['coh']) for i in range(n)])
        add(f'nobj_s{s}', 'objects', [ps(i, s, lambda p: len(p.get('objects', []))) for i in range(n)])

    def corr(a, b):
        pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None and np.isfinite(x) and np.isfinite(y)]
        if len(pairs) < 12:
            return None
        xa, ya = zip(*pairs)
        if len(set(xa)) < 2 or len(set(ya)) < 2:
            return None
        r, p = spearmanr(xa, ya)
        return {'r': round(float(r), 3), 'p': float(p), 'n': len(pairs)}

    out_feats, pvals = [], []
    for name, (group, arr) in feats.items():
        cd = {}
        for tk, tv in targets.items():
            c = corr(arr, tv)
            if c:
                cd[tk] = c; pvals.append((c['p'], name, tk))
        out_feats.append({'name': name, 'group': group, 'corr': cd,
                          'values': [round(float(x), 4) if x is not None and np.isfinite(x) else None for x in arr]})

    pvals.sort()
    m_tests = len(pvals); q = 0.10; fdr_p = 0.0
    for k, (p, _, _) in enumerate(pvals, 1):
        if p <= q * k / m_tests:
            fdr_p = p
    bonf = 0.05 / m_tests if m_tests else 0

    out = {'meta': {'n': n, 'n_features': len(out_feats), 'n_tests': m_tests, 'bonferroni_p': bonf, 'fdr_p': round(fdr_p, 5)},
           'targets': [{'key': k, 'label': TGT_LABEL[k]} for k in targets],
           'target_values': {k: [round(float(x), 3) if x is not None and np.isfinite(x) else None for x in v] for k, v in targets.items()},
           'features': out_feats}
    json.dump(out, open(os.path.join(HERE, 'correlations.json'), 'w'))

    sig = [(p, nm, tk) for p, nm, tk in pvals if p < 0.05]
    print(f"correlations.json · {len(out_feats)} panel-score features × {len(targets)} rate targets = {m_tests} tests")
    print(f"raw p<0.05: {len(sig)} · FDR(q.10) p≤{fdr_p:.4f}")
    print("strongest (any rate target):")
    allc = sorted([(abs(c['r']), f['name'], tk, c['r'], c['p']) for f in out_feats for tk, c in f['corr'].items()], reverse=True)
    for ar, nm, tk, r, p in allc[:14]:
        print(f"  {nm:22} vs {tk:11} r={r:+.3f} p={p:.4f}")


if __name__ == '__main__':
    main()
