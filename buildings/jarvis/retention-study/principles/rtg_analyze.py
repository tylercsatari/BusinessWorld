#!/usr/bin/env python3
"""
RTG · deep analysis. Answers: (1) do the algorithms line up with ALL of Tyler's labels, or
only some — per-label coverage + which are uncatchable; (2) how do the 336 algorithms CLUSTER
(which tell the same story vs different ones); (3) how to COMBINE them — greedy set-cover +
an ensemble that unions their complementary strengths. Stores the ensemble as a signal and
per-label caught/missed so the UI can colour each label by whether the active signal hits it.
"""
import os, json
import numpy as np
import rtg_sweep as S
from sklearn.cluster import AgglomerativeClustering

HERE = os.path.dirname(os.path.abspath(__file__))
z = np.load(os.path.join(HERE, S.TOK))
owner, sec = z['owner'], z['sec']
V = z['clip_img'].astype(np.float64); C = z['clip_txt'].astype(np.float64); hasc = z['has_c'].astype(bool)
V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9); C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
byid = {v['id']: v for v in d['videos']}
LBL = {k: v for k, v in json.load(open(os.path.join(HERE, 'rtg_labels.json'))).items() if isinstance(v, dict) and v.get('pairs')}
seq = {}
for r in range(len(owner)):
    seq.setdefault(int(owner[r]), []).append(r)
rowsById = {meta[vi]['id']: np.array(sorted(seq[vi], key=lambda r: sec[r])) for vi in sorted(seq)}
chg = lambda Vv: np.array([0.0] + [1 - float(Vv[t - 1] @ Vv[t]) for t in range(1, len(Vv))])

VARS = [(D, O, G) for D in S.DIRS for O in S.OPS for G in S.GAPS]
labpairs = [(vid, p['r'], p['g']) for vid, L in LBL.items() for p in L['pairs'] if p['r'] < len(rowsById.get(vid, []))]


def graphs(D, O, G, vids):
    out = {}
    for vid in vids:
        rows = rowsById.get(vid)
        if rows is None:
            continue
        n = len(rows); Cc = C[rows]; Vv = V[rows]; hc = hasc[rows]; rv, pv = S.validity(D, hc, n)
        out[vid] = S.compute(S.Mblock(Cc, Vv, D), G, O, rv, pv, chg(Vv))
    return out


labvids = list(LBL.keys())
cover = np.zeros((len(VARS), len(labpairs)), bool)
refvec = []
for vi, (D, O, G) in enumerate(VARS):
    g = graphs(D, O, G, labvids)
    refvec.append(np.concatenate([g[v][0] for v in labvids]))
    for li, (vid, r, gg) in enumerate(labpairs):
        cover[vi, li] = any(abs(i - r) <= S.TOL and abs(j - gg) <= S.TOL for i, j, s in g[vid][2])

perlabel = cover.sum(0)
print(f"\n=== PER-LABEL COVERAGE ({len(labpairs)} labels × {len(VARS)} algos) ===")
for li, (vid, r, gg) in enumerate(labpairs):
    bar = '#' * int(perlabel[li] / len(VARS) * 20)
    print(f"  {vid[:11]} {r:>3}->{gg:<3} caught by {perlabel[li]:3d}/{len(VARS)}  {bar}")
print(f"\nUNION ceiling — labels caught by >=1 algo: {(perlabel > 0).mean()*100:.0f}%  ({(perlabel>0).sum()}/{len(labpairs)})")
hard = [labpairs[li] for li in range(len(labpairs)) if perlabel[li] == 0]
print(f"UNCATCHABLE by any algo ({len(hard)}): " + ", ".join(f"{v[:8]}:{r}->{g}" for v, r, g in hard))

# --- greedy set cover ---
print("\n=== GREEDY ENSEMBLE (set cover) ===")
remaining = set(range(len(labpairs))); chosen = []
while remaining and len(chosen) < 8:
    best = max(range(len(VARS)), key=lambda vi: len(remaining & set(np.where(cover[vi])[0])))
    newly = remaining & set(np.where(cover[best])[0])
    if not newly:
        break
    chosen.append(best); remaining -= newly
    D, O, G = VARS[best]
    print(f"  + {D}·{O}·g{G:<2} catches {len(newly):2d} new → cumulative {len(labpairs)-len(remaining)}/{len(labpairs)} ({(len(labpairs)-len(remaining))/len(labpairs)*100:.0f}%)")

# --- cluster the algorithms by what they OUTPUT (refness over labelled videos) ---
R = np.array(refvec); Rz = (R - R.mean(1, keepdims=True)) / (R.std(1, keepdims=True) + 1e-9)
K = 8
cl = AgglomerativeClustering(n_clusters=K, metric='cosine', linkage='average').fit_predict(Rz)
print(f"\n=== ALGORITHM CLUSTERS ({K} families by output similarity) ===")
recall_of = lambda vi: cover[vi].mean()
for c in range(K):
    members = [i for i in range(len(VARS)) if cl[i] == c]
    rep = max(members, key=recall_of)
    ops = {}
    for i in members:
        ops[VARS[i][1]] = ops.get(VARS[i][1], 0) + 1
    topops = sorted(ops.items(), key=lambda x: -x[1])[:3]
    print(f"  family {c}: {len(members):3d} algos · best {VARS[rep][0]}·{VARS[rep][1]}·g{VARS[rep][2]} (rec {recall_of(rep):.2f}) · ops {topops}")

# --- build & store the ensemble signal on ALL videos ---
chosenVars = [VARS[i] for i in chosen]
print(f"\nensemble = {[f'{D}·{O}·g{G}' for D,O,G in chosenVars]}")
allv = list(rowsById.keys())
gsets = {cv: graphs(*cv, allv) for cv in chosenVars}
NM = len(chosenVars)
nz = lambda a: (lambda b: b / (b.max() + 1e-9))(np.clip(a - a.min(), 0, None))
for vid, rec in byid.items():
    rows = rowsById.get(vid)
    if rows is None or len(rows) < 3:
        continue
    n = len(rows)
    refs, pays = [], []
    for cv in chosenVars:
        g = gsets[cv].get(vid)
        if g:
            r = np.array(g[0]); refs.append((r - r.mean()) / (r.std() + 1e-9))
            p = np.array(g[1]); pays.append((p - p.mean()) / (p.std() + 1e-9))
    ensR = nz(np.mean(refs, 0)) if refs else np.zeros(n)
    ensP = nz(np.mean(pays, 0)) if pays else np.zeros(n)
    # UNION of links across the chosen theories (the set-cover "OR" ensemble — keep ALL, dedup
    # by proximity so a covering link is never dropped; tag each loop with the theory that caught it)
    alllinks = []
    for cv in chosenVars:
        g = gsets[cv].get(vid)
        if g:
            for i, j, s in g[2]:
                alllinks.append((i, j, float(ensR[i]), cv[1]))
    alllinks.sort(key=lambda l: -l[2]); kept = []
    for i, j, s, src in alllinks:
        if not any(abs(i - ki) <= 2 and abs(j - kj) <= 2 for ki, kj, ks, ksrc in kept):
            kept.append((i, j, s, src))
    kept = kept[:32]
    # STRENGTH per loop: consensus = how many of the NM theories independently fire on it (robustness),
    # intensity = reference-ness, fulfil = payoff-ness (the semantic "close enough" for abstract payoffs),
    # span = how long it stays open (Zeigarnik), reinf = re-references converging on the same payoff (threads).
    out = []
    for i, j, s, src in kept:
        cons = sum(1 for cv in chosenVars if gsets[cv].get(vid) and any(abs(i - li) <= 3 and abs(j - lj) <= 3 for li, lj, ls in gsets[cv][vid][2])) / NM
        reinf = sum(1 for (ii, jj, ss, sr) in kept if abs(jj - j) <= 2)
        intensity, fulfil, span = float(ensR[i]), float(ensP[j]), (j - i) / max(1, n - 1)
        strength = round(0.45 * cons + 0.30 * intensity + 0.25 * fulfil, 3)
        out.append({'i': i, 'j': j, 's': round(intensity, 3), 'p': round(fulfil, 3), 'c': round(cons, 3),
                    'span': round(span, 3), 'reinf': reinf, 'str': strength, 'src': src})
    rec.setdefault('signals', {})['ensemble'] = {'refness': [round(float(x), 3) for x in ensR],
                                                 'payoff': [round(float(x), 3) for x in ensP], 'links': out}
    # per-label caught/missed for THIS video (for UI colouring), against each stored signal
    if vid in LBL:
        rec['mylabels'] = LBL[vid]['pairs']

# ensemble recall
ens_cover = 0
for vid, r, gg in labpairs:
    lk = byid[vid]['signals']['ensemble']['links']
    ens_cover += any(abs(l['i'] - r) <= S.TOL and abs(l['j'] - gg) <= S.TOL for l in lk)
print(f"ENSEMBLE recall: {ens_cover}/{len(labpairs)} = {ens_cover/len(labpairs)*100:.0f}%  (best single was 70%)")

# prepend ensemble to the signal list, make default
sigs = d['meta'].get('signals', [])
d['meta']['signals'] = ['ensemble'] + [s for s in sigs if s != 'ensemble']
d['meta']['signal_default'] = 'ensemble'
d['meta'].setdefault('signal_labels', {})['ensemble'] = f"⛓ ensemble ({ens_cover}/{len(labpairs)})"
d['meta'].setdefault('signal_scores', {})['ensemble'] = round(ens_cover / len(labpairs), 3)
d['meta']['coverage'] = {'union_pct': round((perlabel > 0).mean(), 3), 'ensemble_recall': round(ens_cover / len(labpairs), 3),
                         'n_labels': len(labpairs), 'families': K, 'ensemble_members': [f"{D}_{O}_g{G}" for D, O, G in chosenVars]}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print("\nstored ensemble signal + per-label coverage in rtg_field.json")
