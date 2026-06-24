#!/usr/bin/env python3
"""
RTG · the DEEP sweep. Many algorithm variants, each a different THEORY of what an open loop /
expectation is — grounded in the actual science (information-gap, suspense, Bayesian surprise,
Zeigarnik). All UNSUPERVISED (from Gemini embeddings). Every variant SCORED by how well it
recovers Tyler's hand-labelled loops, PU-style (recall + ranking, NEVER penalised for finding
more than he marked — his labels are a guide, not truth).

OPERATORS (the philosophy of "expecting a specific future"):
  content   strongly matches a specific later moment (centred)
  sharp     that match is PEAKED (one future, not diffuse)
  prod      forwardness × sharpness
  entail    absolute semantic match, uncentred — abstract payoffs ("fittest alive"→a feat)
  novel     matches the FUTURE more than the recent past (forward vs continuity)
  directed  matches the future MORE than it's matched by the past (asymmetry ~ transfer entropy)
  infogap   salient pointer to a REGION of futures, answer not yet pinned (Loewenstein gap)
  suspense  forward UNCERTAINTY among plausible outcomes that a strong future resolves (narratology)
  incomplete doesn't fit its own local neighbourhood — points elsewhere (Zeigarnik incompleteness)
  recur     bidirectional binding — points forward AND is returned to (recurrence)
  tension   like content but the loop strengthens with the GAP it stays open (Zeigarnik duration)
  surprise  payoff weighted by representation CHANGE — an anticipated belief-shift (Bayesian surprise)
DIRECTION cv/vv/cc/vc + cAny/vAny/anyAny (max over modalities) · GAP 1/2/4/6
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TOK = next((f for f in ['rtg_tokens_gemini.npz', 'rtg_tokens_ctx.npz', 'rtg_tokens_siglip.npz'] if os.path.exists(os.path.join(HERE, f))), 'rtg_tokens_siglip.npz')
TOP_K = 30
TOL = 3
DIRS = ['cv', 'vv', 'cc', 'vc', 'cAny', 'vAny', 'anyAny']
OPS = ['content', 'sharp', 'prod', 'entail', 'novel', 'directed', 'infogap', 'suspense', 'incomplete', 'recur', 'tension', 'surprise']
GAPS = [1, 2, 4, 6]


def Mblock(C, V, d):
    cv, vv, cc, vc = C @ V.T, V @ V.T, C @ C.T, V @ C.T
    return {'cv': cv, 'vv': vv, 'cc': cc, 'vc': vc, 'cAny': np.maximum(cv, cc),
            'vAny': np.maximum(vv, vc), 'anyAny': np.maximum(np.maximum(cv, vv), np.maximum(cc, vc))}[d]


def validity(d, hc, n):
    rv = hc.copy() if d[0] == 'c' else np.ones(n, bool)
    pv = hc.copy() if d in ('cc', 'vc') else np.ones(n, bool)
    return rv, pv


def softmax(a):
    a = a - a.max(); e = np.exp(a / 0.1); return e / (e.sum() + 1e-9)


def compute(M, gap, op, rv, pv, change):
    n = M.shape[0]
    Mc = M - M.mean(1, keepdims=True) - M.mean(0, keepdims=True) + M.mean()
    ref = np.zeros(n)
    for i in range(n):
        if not rv[i]:
            continue
        fj = [j for j in range(i + gap, n) if pv[j]]
        if not fj:
            continue
        fc = Mc[i, fj]; mx = float(fc.max())
        if op == 'content':
            r = mx
        elif op == 'sharp':
            r = mx - float(fc.mean())
        elif op == 'prod':
            r = max(0.0, mx) * max(0.0, mx - float(fc.mean()))
        elif op == 'entail':
            r = float(M[i, fj].max())
        elif op == 'novel':
            pj = [j for j in range(max(0, i - 3), i) if pv[j]]; r = mx - (float(Mc[i, pj].max()) if pj else 0.0)
        elif op == 'directed':
            bj = [j for j in range(0, max(0, i - gap + 1)) if rv[j]]; r = mx - (float(Mc[bj, i].max()) if bj else 0.0)
        elif op == 'infogap':
            near = float((fc > mx - 0.04).mean()); r = max(0.0, mx) * near
        elif op == 'suspense':
            p = softmax(fc); H = float(-(p * np.log(p + 1e-12)).sum() / np.log(len(fc) + 1e-9)); r = H * max(0.0, mx)
        elif op == 'incomplete':
            nj = [j for j in range(max(0, i - 2), min(n, i + 3)) if j != i and pv[j]]; r = mx - (float(Mc[i, nj].max()) if nj else 0.0)
        elif op == 'recur':
            r = max((min(float(Mc[i, j]), float(Mc[j, i])) for j in fj), default=0.0)
        elif op == 'tension':
            r = mx
        elif op == 'surprise':
            r = mx
        ref[i] = r
    ref = np.clip(ref, 0, None); ref = ref / (ref.max() + 1e-9)
    pay = np.zeros(n)
    for j in range(n):
        if not pv[j]:
            continue
        cands = [ref[i] * float(Mc[i, j]) for i in range(max(0, j - gap + 1)) if rv[i]]
        v = max(cands) if cands else 0.0
        if op == 'surprise':
            v *= float(change[j])
        pay[j] = v
    pay = np.clip(pay, 0, None); pay = pay / (pay.max() + 1e-9)
    links = []
    for i in range(n):
        if ref[i] > 0.12 and (i == 0 or ref[i] >= ref[i - 1]) and (i == n - 1 or ref[i] >= ref[i + 1]):
            fj = [j for j in range(i + gap, n) if pv[j]]
            if not fj:
                continue
            if op == 'tension':
                bj = max(fj, key=lambda j: float(Mc[i, j]) * min(1.0, (j - i) / 8.0))
            else:
                bj = max(fj, key=lambda j: float(Mc[i, j]))
            links.append((i, int(bj), float(ref[i])))
    return ref, pay, sorted(links, key=lambda l: -l[2])


def main():
    z = np.load(os.path.join(HERE, TOK)); print('tokens:', TOK, flush=True)
    owner, sec = z['owner'], z['sec']
    V = z['clip_img'].astype(np.float64); C = z['clip_txt'].astype(np.float64)
    hasc = z['has_c'].astype(bool)
    V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9); C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
    d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
    meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
    byid = {v['id']: v for v in d['videos']}
    try:
        LBL = {k: v for k, v in json.load(open(os.path.join(HERE, 'rtg_labels.json'))).items() if isinstance(v, dict) and v.get('pairs')}
    except Exception:
        LBL = {}
    print('labelled:', len(LBL), 'videos /', sum(len(v['pairs']) for v in LBL.values()), 'pairs', flush=True)
    seq = {}
    for r in range(len(owner)):
        seq.setdefault(int(owner[r]), []).append(r)
    rowsById = {meta[vi]['id']: np.array(sorted(seq[vi], key=lambda r: sec[r])) for vi in sorted(seq)}

    def change_of(Vv):
        n = len(Vv); return np.array([0.0] + [1 - float(Vv[t - 1] @ Vv[t]) for t in range(1, n)])

    variants = [(D, O, G) for D in DIRS for O in OPS for G in GAPS]
    desc = lambda v: f"{v[0]} · {v[1]} · gap{v[2]}"
    scores = {}
    for var in variants:
        D, O, G = var
        cap = tot = 0; pct = atr = 0.0
        for vid, L in LBL.items():
            rows = rowsById.get(vid)
            if rows is None:
                continue
            n = len(rows); Cc = C[rows]; Vv = V[rows]; hc = hasc[rows]
            rv, pv = validity(D, hc, n)
            ref, pay, links = compute(Mblock(Cc, Vv, D), G, O, rv, pv, change_of(Vv))
            rank = np.argsort(np.argsort(ref))
            for p in L['pairs']:
                r0, g0 = p['r'], p['g']
                if r0 >= n:
                    continue
                tot += 1
                cap += any(abs(i - r0) <= TOL and abs(j - g0) <= TOL for i, j, s in links)
                pct += float(rank[r0]) / max(1, n - 1)
                atr += any(abs(i - r0) <= TOL for i, j, s in links)
        recall = cap / max(1, tot); ppct = pct / max(1, tot); aref = atr / max(1, tot)
        scores[var] = round(0.4 * recall + 0.3 * ppct + 0.3 * aref, 4)
        scores[(var, 'r')] = round(recall, 3)
    ranked = sorted(variants, key=lambda v: -scores[v])

    print('\nTOP 15 (score · recall · desc):')
    for v in ranked[:15]:
        print(f"  {scores[v]:.3f}  rec={scores[(v,'r')]:.2f}  {desc(v)}", flush=True)
    print('\nbest per OPERATOR:')
    for o in OPS:
        bv = max((v for v in variants if v[1] == o), key=lambda v: scores[v]); print(f"  {o:11} {scores[bv]:.3f}  {desc(bv)}", flush=True)
    print('best per DIRECTION:', {Dr: round(max(scores[v] for v in variants if v[0] == Dr), 3) for Dr in DIRS}, flush=True)
    print('best per GAP:', {g: round(max(scores[v] for v in variants if v[2] == g), 3) for g in GAPS}, flush=True)

    top = ranked[:TOP_K]; ids = [f"{v[0]}_{v[1]}_g{v[2]}" for v in top]
    for vid, rec in byid.items():
        rows = rowsById.get(vid)
        if rows is None or len(rows) < 3:
            continue
        n = len(rows); Cc = C[rows]; Vv = V[rows]; hc = hasc[rows]; ch = change_of(Vv)
        sig = {}
        for v in top:
            D, O, G = v; rv, pv = validity(D, hc, n)
            ref, pay, links = compute(Mblock(Cc, Vv, D), G, O, rv, pv, ch)
            sig[f"{D}_{O}_g{G}"] = {'refness': [round(float(x), 3) for x in ref], 'payoff': [round(float(x), 3) for x in pay],
                                    'links': [{'i': i, 'j': j, 's': round(s, 3), 'p': round(float(pay[j]), 3)} for i, j, s in links[:16]]}
        rec['signals'] = sig; dflt = sig[ids[0]]
        rec['refness'] = dflt['refness']; rec['payoff'] = dflt['payoff']; rec['links'] = dflt['links']
    d['meta'].update({'signals': ids, 'signal_default': ids[0],
                      'signal_labels': {f"{v[0]}_{v[1]}_g{v[2]}": f"{desc(v)} ({scores[v]:.2f})" for v in top},
                      'signal_scores': {f"{v[0]}_{v[1]}_g{v[2]}": scores[v] for v in top},
                      'sweep': [{'id': f"{v[0]}_{v[1]}_g{v[2]}", 'desc': desc(v), 'score': scores[v], 'recall': scores[(v, 'r')]} for v in ranked],
                      'sweep_n': len(variants), 'labelled': len(LBL)})
    json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
    print(f"\nrtg_field.json · {len(variants)} variants · top {TOP_K} stored · default {ids[0]}", flush=True)


if __name__ == '__main__':
    main()
