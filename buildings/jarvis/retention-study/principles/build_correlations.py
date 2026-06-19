#!/usr/bin/env python3
"""
CORRELATIONS — every novelty data point vs the indicators + views.

Pulls EVERY measurable feature out of novelty.json (global novelty per modality, per-second
novelty, second-to-second deltas / trajectory geometry, niche distances + cluster membership,
coherence, temporal, combinatorial rarity + cluster membership, objects, scene spread) and
Spearman-correlates each against:
  keep_rate (swipe ratio) · avg_retention · 5-second retention · duration · log10(views)

Univariate for now (each point individually). Reports r, p, n + significance (raw p<0.05 and
Benjamini-Hochberg FDR across all tests, since there are many).

Output: correlations.json
"""
import os, json
import numpy as np
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
MODS = ['whole', 'concept', 'visual', 'text']


def slope(y):
    y = [v for v in y if v is not None]
    if len(y) < 2:
        return 0.0
    x = np.arange(len(y))
    return float(np.polyfit(x, y, 1)[0])


def main():
    N = json.load(open(os.path.join(HERE, 'novelty.json')))
    T = json.load(open(os.path.join(RS, 'retention_table.json')))
    tby = {v['id']: v for v in T['videos']}
    V = N['videos']; n = len(V)
    H, S = N['hook'], N['second']

    # ── targets ──
    keep, ret, ret5, dur, lview = [], [], [], [], []
    grid = np.linspace(0, 1, 100)
    for v in V:
        t = tby.get(v['id'], {})
        keep.append(t.get('keep_rate')); ret.append(t.get('avg_retention')); dur.append(t.get('duration_s'))
        lview.append(np.log10(t['views']) if t.get('views') else None)
        cv = t.get('curve'); d = t.get('duration_s')
        ret5.append(float(np.interp(min(1.0, 5.0 / d), grid, cv) * 100) if cv and d else None)
    targets = {'keep_rate': keep, 'retention': ret, 'ret_5s': ret5, 'duration': dur, 'log_views': lview}
    TGT_LABEL = {'keep_rate': 'Keep rate (swipe)', 'retention': 'Avg retention', 'ret_5s': '5-sec retention', 'duration': 'Duration', 'log_views': 'Views (log)'}

    # ── features ──
    feats = {}                                          # name -> (group, array[n])

    def add(name, group, arr):
        feats[name] = (group, arr)

    # per-video ordered per-second arrays
    persec = [sorted(v.get('persec', []), key=lambda p: p['sec']) for v in V]
    sproj = {m: S['proj'][m] for m in MODS}
    owner, sec = S['owner'], S['sec']
    secrows = {}
    for j, o in enumerate(owner):
        secrows.setdefault(o, []).append(j)
    for o in secrows:
        secrows[o].sort(key=lambda j: sec[j])

    for m in MODS:
        add(f'global_nov_{m}', 'global', [H['global'][m]['nov'][i] for i in range(n)])
        add(f'niche_dist_{m}', 'niche', [H['niche'][m]['dist_to_centre'][i] for i in range(n)])
        # per-second novelty
        for s in range(5):
            add(f'nov_s{s}_{m}', 'per-second', [next((p['nov'][m] for p in persec[i] if p['sec'] == s), None) for i in range(n)])
        add(f'nov_avg_{m}', 'per-second', [float(np.mean([p['nov'][m] for p in persec[i]])) if persec[i] else None for i in range(n)])
        add(f'nov_std_{m}', 'per-second', [float(np.std([p['nov'][m] for p in persec[i]])) if persec[i] else None for i in range(n)])
        add(f'nov_slope_{m}', 'shape', [slope([p['nov'][m] for p in persec[i]]) for i in range(n)])
        add(f'nov_range_{m}', 'shape', [(max(x) - min(x)) if (x := [p['nov'][m] for p in persec[i]]) else None for i in range(n)])
        # second-to-second novelty deltas
        for a, b in [(0, 1), (1, 2), (2, 3), (3, 4)]:
            add(f'nov_d{a}{b}_{m}', 'second-to-second', [(va[b] - va[a]) if len(va := [p['nov'][m] for p in persec[i]]) > b else None for i in range(n)])
        # trajectory geometry in 2D latent space
        tl, disp, mx = [], [], []
        for i in range(n):
            pts = [sproj[m][j] for j in secrows.get(i, [])]
            if len(pts) >= 2:
                steps = [float(np.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])) for k in range(len(pts) - 1)]
                tl.append(sum(steps)); disp.append(float(np.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]))); mx.append(max(steps))
            else:
                tl.append(None); disp.append(None); mx.append(None)
        add(f'traj_len_{m}', 'trajectory', tl)
        add(f'traj_disp_{m}', 'trajectory', disp)
        add(f'traj_maxstep_{m}', 'trajectory', mx)
        # niche switching across seconds
        add(f'niche_switches_{m}', 'niche', [len(set(p['niche'][m] for p in persec[i])) if persec[i] else None for i in range(n)])

    # coherence
    coh = H['coherent']['coherence']
    add('coherence_hook', 'coherence', [coh[i] for i in range(n)])
    for s in range(5):
        add(f'coh_s{s}', 'coherence', [next((p['coh'] for p in persec[i] if p['sec'] == s), None) for i in range(n)])
    add('coh_avg', 'coherence', [float(np.mean([p['coh'] for p in persec[i]])) if persec[i] else None for i in range(n)])
    add('coh_std', 'coherence', [float(np.std([p['coh'] for p in persec[i]])) if persec[i] else None for i in range(n)])
    add('coh_slope', 'coherence', [slope([p['coh'] for p in persec[i]]) for i in range(n)])

    # temporal
    add('temporal_hook', 'temporal', [H['temporal']['nov'][i] for i in range(n)])
    add('temporal_avg', 'temporal', [float(np.mean([x for x in (p['temporal'] for p in persec[i]) if x is not None])) if any(p['temporal'] is not None for p in persec[i]) else None for i in range(n)])

    # combinatorial
    add('combo_rarity', 'combinatorial', [N['combo']['rarity'][i] for i in range(n)])
    add('n_concepts', 'combinatorial', [len(v.get('concepts', [])) for v in V])

    # objects
    add('nobj_hook', 'objects', [len(v.get('objects_hook', [])) for v in V])
    add('nobj_avg', 'objects', [float(np.mean([len(p.get('objects', [])) for p in persec[i]])) if persec[i] else None for i in range(n)])
    for s in range(5):
        add(f'nobj_s{s}', 'objects', [next((len(p.get('objects', [])) for p in persec[i] if p['sec'] == s), None) for i in range(n)])
    add('nobj_slope', 'objects', [slope([len(p.get('objects', [])) for p in persec[i]]) for i in range(n)])

    # scene spread
    add('scene_spread', 'shape', [H['scene']['spread'][i] for i in range(n)])

    # niche cluster MEMBERSHIP (binary) — hook level, per modality
    for m in MODS:
        labs = H['niche'][m]['labels']
        for c in sorted(set(labs)):
            add(f'in_niche_{m}_{c}', 'niche-cluster', [1.0 if labs[i] == c else 0.0 for i in range(n)])
    # concept-cluster membership (binary) — does the hook contain a concept in cluster c
    cl_freq = {cl['id']: cl['freq'] for cl in N['combo']['clusters']}
    hookclusters = [set(c.get('cluster') for c in v.get('concepts', [])) for v in V]
    for c in sorted(cl_freq, key=lambda c: -cl_freq[c]):
        if cl_freq[c] >= 8:                              # only clusters used by ≥8 hooks
            add(f'in_concept_cl_{c}', 'concept-cluster', [1.0 if c in hookclusters[i] else 0.0 for i in range(n)])

    # ── correlate every feature vs every target ──
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

    # Benjamini-Hochberg FDR threshold (q=0.10) across all tests
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
    print(f"correlations.json · {len(out_feats)} features × {len(targets)} targets = {m_tests} tests")
    print(f"raw p<0.05: {len(sig)} · FDR(q.10) p≤{fdr_p:.4f} · Bonferroni p<{bonf:.5f}")
    print("strongest (any target):")
    allc = sorted([(abs(c['r']), f['name'], tk, c['r'], c['p']) for f in out_feats for tk, c in f['corr'].items()], reverse=True)
    for ar, nm, tk, r, p in allc[:14]:
        print(f"  {nm:24} vs {tk:11} r={r:+.3f} p={p:.4f}")


if __name__ == '__main__':
    main()
