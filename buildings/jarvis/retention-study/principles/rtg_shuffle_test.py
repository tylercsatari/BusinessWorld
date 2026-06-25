#!/usr/bin/env python3
"""
RTG · presence validation by the WITHIN-VIDEO SHUFFLE NULL. We never labelled references, so we
can't assume the detector locates them correctly. This tests, label-free, whether each detector
finds REAL directed structure: run it on each video, then on N time-shuffled copies of THAT SAME
video (same content, scrambled order — destroys real ordering, keeps the topic). If the detector's
forward-reference structure on the real timeline beats its own shuffled null, it's detecting
something real (not continuity/noise — the trap that killed v0 CLIP similarity).

Reports, per direction × centring:
  • directed forward-specificity, real vs shuffle, paired z over 211 videos
  • % of videos where real beats shuffle
and per-candidate presence-confidence (what fraction of flagged references beat the null → real,
vs are indistinguishable from noise → false-positive-prone).
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.RandomState(0)
z = np.load(os.path.join(HERE, 'rtg_tokens_gemini.npz'))
owner, sec, hasc = z['owner'].astype(int), z['sec'].astype(int), z['has_c'].astype(bool)
V = z['clip_img'].astype(np.float64); C = z['clip_txt'].astype(np.float64)
V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9); C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
seq = {}
for r in range(len(owner)):
    seq.setdefault(int(owner[r]), []).append(r)
rowsById = {meta[vi]['id']: np.array(sorted(seq[vi], key=lambda r: sec[r])) for vi in sorted(seq)}
NS, GAP = 80, 4
DIRS = ['cc', 'cAny', 'vc', 'anyAny']   # the KEPT (presence-validated) directions, raw — confirm all solid


def Mblock(Cc, Vv, d):
    cv, vv, cc, vc = Cc @ Vv.T, Vv @ Vv.T, Cc @ Cc.T, Vv @ Cc.T
    return {'cv': cv, 'vv': vv, 'cc': cc, 'vc': vc, 'cAny': np.maximum(cv, cc),
            'vAny': np.maximum(vv, vc), 'anyAny': np.maximum(np.maximum(cv, vv), np.maximum(cc, vc))}[d]


def dcenter(M):
    return M - M.mean(1, keepdims=True) - M.mean(0, keepdims=True) + M.mean()


def fwd_spec(M, gap):
    """mean over moments of (best forward match − best backward match): >0 = forward-directed references"""
    n = M.shape[0]; vals = []
    for i in range(n):
        f = M[i, i + gap:]; b = M[i, :max(0, i - gap + 1)]
        if f.size and b.size:
            vals.append(float(f.max()) - float(b.max()))
    return float(np.mean(vals)) if vals else 0.0


print(f"shuffle existence test · {len(rowsById)} videos · {NS} shuffles · gap {GAP}\n")
print(f"{'direction':9} {'centring':9} {'real':>8} {'shuffle':>8} {'z(paired)':>10} {'%real>shuf':>11}")
results = {}
for d in DIRS:
    for cen in ['centred', 'raw']:
        zs, wins, reals, shufs = [], 0, [], []
        for vid, rows in rowsById.items():
            n = len(rows)
            if n < 2 * GAP + 3:
                continue
            Cc, Vv = C[rows], V[rows]
            M = Mblock(Cc, Vv, d); M = dcenter(M) if cen == 'centred' else M
            real = fwd_spec(M, GAP)
            sh = np.empty(NS)
            for k in range(NS):
                p = rng.permutation(n)
                Ms = Mblock(Cc[p], Vv[p], d); Ms = dcenter(Ms) if cen == 'centred' else Ms
                sh[k] = fwd_spec(Ms, GAP)
            zs.append((real - sh.mean()) / (sh.std() + 1e-9)); wins += real > sh.mean()
            reals.append(real); shufs.append(sh.mean())
        zmean = float(np.mean(zs)); pooled_z = zmean * np.sqrt(len(zs))
        results[(d, cen)] = {'real': float(np.mean(reals)), 'shuf': float(np.mean(shufs)), 'z': round(zmean, 3),
                             'pooled_z': round(pooled_z, 1), 'pct_win': round(100 * wins / len(zs), 1), 'n': len(zs)}
        print(f"{d:9} {cen:9} {np.mean(reals):>8.4f} {np.mean(shufs):>8.4f} {zmean:>+10.3f} {100*wins/len(zs):>10.1f}%  (pooled z {pooled_z:+.0f})")

# ---------- per-candidate presence-confidence (cv direction: do flagged references point to a SPECIFIC forward target?) ----------
print("\nper-candidate presence-confidence — is each reference's forward target real, or a random hit?")
for dd, cen in [('cc', 'raw'), ('cAny', 'raw'), ('vc', 'raw'), ('cv', 'centred'), ('cv', 'raw')]:
    ps, ncand = [], 0
    for vid, rows in rowsById.items():
        n = len(rows)
        if n < 2 * GAP + 3:
            continue
        M = Mblock(C[rows], V[rows], dd); M = dcenter(M) if cen == 'centred' else M
        for i in range(n - GAP):
            row = np.delete(M[i], i)                      # i's similarity to every other moment
            fset = M[i, i + GAP:]
            if fset.size < 2:
                continue
            real = float(fset.max())
            # local peak of forward-spec only (candidate references)
            if i > 0 and i < n - GAP - 1:
                prevf = M[i - 1, i - 1 + GAP:]; nextf = M[i + 1, i + 1 + GAP:]
                if not (real >= (prevf.max() if prevf.size else -9) and real >= (nextf.max() if nextf.size else -9)):
                    continue
            ncand += 1
            k = fset.size
            null = np.array([np.random.choice(row, k, replace=False).max() for _ in range(200)])  # random forward set
            ps.append(float((null >= real).mean()))
    ps = np.array(ps)
    sig = float((ps < 0.05).mean())
    print(f"  {dd:5} {cen:7}: {ncand} candidates · {sig*100:.0f}% beat null (p<0.05) · median p {np.median(ps):.3f}")

json.dump({'gap': GAP, 'shuffles': NS, 'by_dir': {f'{d}_{c}': results[(d, c)] for (d, c) in results}},
          open(os.path.join(HERE, 'rtg_shuffle.json'), 'w'))
print("\nstored rtg_shuffle.json")
