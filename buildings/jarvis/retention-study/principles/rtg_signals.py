#!/usr/bin/env python3
"""
RTG · signal explorer. Several THEORY-GROUNDED ways to quantify reference→gratification,
all UNSUPERVISED (computed from the Gemini embeddings, never fit to the hand-labels — the
labels are a guide we overlay, not a target we train on). The point is to SEE which signal
naturally lights up where references live, so the structure emerges rather than being forced.

Each signal → continuous reference-ness(t), payoff-ness(t), and links (peaks → best future).
Stored per video as rec['signals'][name]. Directions:
  cv concept→visual · vv visual→visual · cc concept→concept · vc visual→concept
  ent  = concept→visual entailment (forward content match, no sharpness — abstract payoffs)
  pred = the trained JEPA head (already in rec) — for head-to-head comparison
Default rec.refness/payoff/links = the chosen DEFAULT signal.
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = 'cv'
TOK = next((f for f in ['rtg_tokens_gemini.npz', 'rtg_tokens_ctx.npz', 'rtg_tokens_siglip.npz'] if os.path.exists(os.path.join(HERE, f))), 'rtg_tokens_siglip.npz')


MIN_GAP = 2   # a reference points to a moment >=2s later (skip trivial adjacency/self-match)


def field(Mx, My, refMask, payMask, sharp=True):
    n = Mx.shape[0]
    M = Mx @ My.T
    Mc = M - M.mean(1, keepdims=True) - M.mean(0, keepdims=True) + M.mean()   # specificity
    ref = np.zeros(n)
    for i in range(n - MIN_GAP):
        if not refMask[i]:
            continue
        js = [j for j in range(i + MIN_GAP, n) if payMask[j]]
        if not js:
            continue
        vals = Mc[i, js]; mx = float(vals.max())                      # best specific later match (double-centred, >0 = above baseline)
        ref[i] = max(0.0, mx) * (max(0.0, mx - float(vals.mean())) if sharp else 1.0)
    ref /= (ref.max() + 1e-9)
    pay = np.zeros(n)
    for j in range(MIN_GAP, n):
        if not payMask[j]:
            continue
        pay[j] = max((ref[i] * float(Mc[i, j]) for i in range(j - MIN_GAP + 1) if refMask[i]), default=0.0)
    pay = np.clip(pay, 0, None); pay /= (pay.max() + 1e-9)
    links = []
    for i in range(n - MIN_GAP):
        if ref[i] > 0.12 and (i == 0 or ref[i] >= ref[i - 1]) and (i == n - 1 or ref[i] >= ref[i + 1]):
            js = [j for j in range(i + MIN_GAP, n) if payMask[j]]
            if js:
                bj = int(max(js, key=lambda j: Mc[i, j]))
                links.append({'i': i, 'j': bj, 's': round(float(ref[i]), 3), 'p': round(float(pay[bj]), 3)})
    return {'refness': [round(float(x), 3) for x in ref],
            'payoff': [round(float(x), 3) for x in pay],
            'links': sorted(links, key=lambda l: -l['s'])[:14]}


def main():
    z = np.load(os.path.join(HERE, TOK)); print('tokens:', TOK, flush=True)
    owner, sec = z['owner'], z['sec']
    V = z['clip_img'].astype(np.float64); C = z['clip_txt'].astype(np.float64)
    hasc = z['has_c'].astype(bool)
    V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
    C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
    d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
    meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
    byid = {v['id']: v for v in d['videos']}
    seq = {}
    for r in range(len(owner)):
        seq.setdefault(int(owner[r]), []).append(r)

    for vi in sorted(seq):
        rows = np.array(sorted(seq[vi], key=lambda r: sec[r])); n = len(rows)
        rec = byid.get(meta[vi]['id'])
        if rec is None or n < 3:
            continue
        Vv = V[rows]; Cc = C[rows]; hc = hasc[rows]; allm = np.ones(n, bool)
        sig = {}
        sig['cv'] = field(Cc, Vv, hc, allm)
        sig['vv'] = field(Vv, Vv, allm, allm)
        sig['cc'] = field(Cc, Cc, hc, hc)
        sig['vc'] = field(Vv, Cc, allm, hc)
        sig['ent'] = field(Cc, Vv, hc, allm, sharp=False)
        sig['pred'] = {'refness': rec.get('refness', []), 'payoff': rec.get('payoff', []), 'links': rec.get('links', [])}
        rec['signals'] = sig
        rec['refness'] = sig[DEFAULT]['refness']; rec['payoff'] = sig[DEFAULT]['payoff']; rec['links'] = sig[DEFAULT]['links']
        if (vi + 1) % 40 == 0:
            print(f"  {vi+1} videos", flush=True)

    d['meta']['signals'] = ['cv', 'vv', 'cc', 'vc', 'ent', 'pred']
    d['meta']['signal_default'] = DEFAULT
    d['meta']['signal_labels'] = {'cv': 'concept→visual', 'vv': 'visual→visual', 'cc': 'concept→concept',
                                  'vc': 'visual→concept', 'ent': 'semantic entailment', 'pred': 'JEPA head'}
    json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
    print(f"rtg_field.json · {len(d['videos'])} videos · signals {d['meta']['signals']}", flush=True)


if __name__ == '__main__':
    main()
