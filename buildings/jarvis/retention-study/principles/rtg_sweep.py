#!/usr/bin/env python3
"""
RTG · the SWEEP. Many algorithm variants, each a different answer to "what is an open loop /
an expectation?", all UNSUPERVISED (from the Gemini embeddings). Every variant is SCORED by
how well it recovers Tyler's hand-labelled loops — PU-style: recall only, NEVER penalised for
finding MORE loops than he labelled (his labels are confident positives, not complete truth).

Axes (the philosophy):
  DIRECTION  — which channel references which: cv/vv/cc/vc + "any" (max over modalities)
  OPERATOR   — what "expecting a specific future" means:
     content  = strongly matches a specific later moment (centred)
     sharp    = that match is PEAKED (one future, not diffuse)
     prod     = forwardness × sharpness
     entail   = absolute semantic match, uncentred (abstract payoffs — "fittest alive"→a feat)
     novel    = matches the FUTURE more than the recent past (forward-pointing vs continuity)
  GAP        — a reference points >=g seconds ahead (skip adjacency): 1 / 2 / 4

Scores all variants on the labelled videos, ranks, stores the TOP-K full graphs (browsable)
+ the full ranked table. rec.signals[id] = {refness,payoff,links}; meta.signals = ranked ids.
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TOK = next((f for f in ['rtg_tokens_gemini.npz', 'rtg_tokens_ctx.npz', 'rtg_tokens_siglip.npz'] if os.path.exists(os.path.join(HERE, f))), 'rtg_tokens_siglip.npz')
TOP_K = 28
TOL = 3            # a labelled pair is "captured" if a link lands within +-3s of both endpoints
DIRS = ['cv', 'vv', 'cc', 'vc', 'cAny', 'vAny', 'anyAny']
OPS = ['content', 'sharp', 'prod', 'entail', 'novel']
GAPS = [1, 2, 4]


def Mblock(C, V, d):
    cv, vv, cc, vc = C @ V.T, V @ V.T, C @ C.T, V @ C.T
    return {'cv': cv, 'vv': vv, 'cc': cc, 'vc': vc,
            'cAny': np.maximum(cv, cc), 'vAny': np.maximum(vv, vc),
            'anyAny': np.maximum(np.maximum(cv, vv), np.maximum(cc, vc))}[d]


def validity(d, hc, n):
    refC = d[0] == 'c'; payV = d[1:]
    rv = hc.copy() if refC else np.ones(n, bool)
    pv = hc.copy() if d in ('cc', 'vc') else np.ones(n, bool)   # explicit-concept payoff needs speech
    if d in ('cAny', 'vAny', 'anyAny'):
        pv = np.ones(n, bool)
    return rv, pv


def compute(M, gap, op, rv, pv):
    n = M.shape[0]
    raw = M
    Mc = M - M.mean(1, keepdims=True) - M.mean(0, keepdims=True) + M.mean()
    use = Mc if op != 'entail' else raw
    I, J = np.indices((n, n))
    mask = (J >= I + gap) & pv[None, :] & rv[:, None]
    Mm = np.where(mask, use, -np.inf)
    fmax = Mm.max(1); fmax[~np.isfinite(fmax)] = 0.0
    cnt = mask.sum(1); fmean = np.where(mask, use, 0).sum(1) / np.maximum(cnt, 1)
    if op in ('content', 'entail'):
        ref = fmax
    elif op == 'sharp':
        ref = fmax - fmean
    elif op == 'prod':
        ref = np.clip(fmax, 0, None) * np.clip(fmax - fmean, 0, None)
    elif op == 'novel':
        past = np.where((J < I) & (J >= I - 3) & rv[:, None], use, -np.inf)
        pmax = past.max(1); pmax[~np.isfinite(pmax)] = 0.0
        ref = fmax - pmax
    ref = np.clip(ref, 0, None); ref = ref / (ref.max() + 1e-9)
    refcol = ref[:, None] * np.where(mask, use, 0)
    pay = np.clip(refcol.max(0), 0, None); pay = pay / (pay.max() + 1e-9)
    links = []
    for i in range(n):
        if ref[i] > 0.12 and (i == 0 or ref[i] >= ref[i - 1]) and (i == n - 1 or ref[i] >= ref[i + 1]):
            row = np.where(mask[i], use[i], -np.inf)
            if np.isfinite(row).any():
                links.append((i, int(np.argmax(row)), float(ref[i])))
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
        LBL = json.load(open(os.path.join(HERE, 'rtg_labels.json')))
    except Exception:
        LBL = {}
    LBL = {k: v for k, v in LBL.items() if isinstance(v, dict) and v.get('pairs')}
    print('labelled videos:', len(LBL), '· pairs:', sum(len(v['pairs']) for v in LBL.values()), flush=True)

    seq = {}
    for r in range(len(owner)):
        seq.setdefault(int(owner[r]), []).append(r)
    rowsById = {meta[vi]['id']: np.array(sorted(seq[vi], key=lambda r: sec[r])) for vi in sorted(seq)}

    variants = [(d_, o, g) for d_ in DIRS for o in OPS for g in GAPS]
    desc = lambda v: f"{v[0]} · {v[1]} · gap{v[2]}"

    # --- score every variant on the labelled videos (PU recall + refness percentile) ---
    scores = {}
    for var in variants:
        d_, op, g = var
        cap = tot = 0; perc = 0.0
        for vid, L in LBL.items():
            rows = rowsById.get(vid)
            if rows is None:
                continue
            n = len(rows); Cc = C[rows]; Vv = V[rows]; hc = hasc[rows]
            rv, pv = validity(d_, hc, n)
            ref, pay, links = compute(Mblock(Cc, Vv, d_), g, op, rv, pv)
            order = np.argsort(np.argsort(ref))  # rank
            for p in L['pairs']:
                r0, g0 = p['r'], p['g']
                if r0 >= n:
                    continue
                tot += 1
                cap += any(abs(i - r0) <= TOL and abs(j - g0) <= TOL for i, j, s in links)
                perc += float(order[r0]) / max(1, n - 1)
        recall = cap / max(1, tot); ppct = perc / max(1, tot)
        scores[var] = round(0.6 * recall + 0.4 * ppct, 4)
        scores[(var, 'recall')] = round(recall, 3)

    ranked = sorted(variants, key=lambda v: -scores[v])
    print('\nTOP 12 variants (score · recall · desc):')
    for v in ranked[:12]:
        print(f"  {scores[v]:.3f}  r={scores[(v,'recall')]:.2f}  {desc(v)}", flush=True)

    # --- store TOP-K full graphs on ALL videos ---
    top = ranked[:TOP_K]
    sig_ids = [f"{v[0]}_{v[1]}_g{v[2]}" for v in top]
    labels = {f"{v[0]}_{v[1]}_g{v[2]}": f"{desc(v)}  ({scores[v]:.2f})" for v in top}
    sc = {f"{v[0]}_{v[1]}_g{v[2]}": scores[v] for v in top}
    for vid, rec in byid.items():
        rows = rowsById.get(vid)
        if rows is None or len(rows) < 3:
            continue
        n = len(rows); Cc = C[rows]; Vv = V[rows]; hc = hasc[rows]
        sig = {}
        for v in top:
            d_, op, g = v
            rv, pv = validity(d_, hc, n)
            ref, pay, links = compute(Mblock(Cc, Vv, d_), g, op, rv, pv)
            sig[f"{d_}_{op}_g{g}"] = {'refness': [round(float(x), 3) for x in ref],
                                     'payoff': [round(float(x), 3) for x in pay],
                                     'links': [{'i': i, 'j': j, 's': round(s, 3), 'p': round(float(pay[j]), 3)} for i, j, s in links[:16]]}
        rec['signals'] = sig
        dflt = sig[sig_ids[0]]
        rec['refness'] = dflt['refness']; rec['payoff'] = dflt['payoff']; rec['links'] = dflt['links']

    d['meta']['signals'] = sig_ids
    d['meta']['signal_default'] = sig_ids[0]
    d['meta']['signal_labels'] = labels
    d['meta']['signal_scores'] = sc
    d['meta']['sweep'] = [{'id': f"{v[0]}_{v[1]}_g{v[2]}", 'desc': desc(v), 'score': scores[v], 'recall': scores[(v, 'recall')]} for v in ranked]
    d['meta']['sweep_n'] = len(variants); d['meta']['labelled'] = len(LBL)
    json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
    print(f"\nrtg_field.json · {len(variants)} variants scored · top {TOP_K} stored · default {sig_ids[0]}", flush=True)


if __name__ == '__main__':
    main()
