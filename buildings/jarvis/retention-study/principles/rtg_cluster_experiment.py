#!/usr/bin/env python3
"""
RTG · embedding-geometry experiment. The global map collapses onto two ends — test whether that's
the MODALITY GAP (visual vs concept are the dominant axis, not meaning), and whether removing it
(centring each modality) reveals real semantic structure AND gives a more stable reference mapping.

Builds several projections for the UI (raw / modality-aligned / per-modality), clusters in
different-dimensional subspaces with silhouette quality, and — the payoff — re-derives the
entailment cross-modal reference signal RAW vs ALIGNED and re-validates BOTH against real
retention (drop-zone forward-hold). If aligning the modality gap lifts the validated signal,
that's the new, more stable reference mapping.
"""
import os, json
import numpy as np
from sklearn.cluster import MiniBatchKMeans
from sklearn.metrics import silhouette_score

HERE = os.path.dirname(os.path.abspath(__file__))
z = np.load(os.path.join(HERE, 'rtg_tokens_gemini.npz'))
owner, sec, hasc = z['owner'].astype(int), z['sec'].astype(int), z['has_c'].astype(bool)
V = z['clip_img'].astype(np.float64); C = z['clip_txt'].astype(np.float64)
V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9); C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}
meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
rng = np.random.RandomState(0)

# ---------- (1) is the split the modality gap? ----------
mgap = float(np.linalg.norm(V.mean(0) - C.mean(0)))
Xall = np.vstack([V, C]); modlab = np.concatenate([np.zeros(len(V)), np.ones(len(C))])
Xc = Xall - Xall.mean(0); P = np.linalg.svd(Xc, full_matrices=False)[2]
pc1 = Xc @ P[0]
r_pc1_mod = abs(float(np.corrcoef(pc1, modlab)[0, 1]))
print(f"modality gap ||μ_V-μ_C|| = {mgap:.3f}  ·  |corr(PC1, modality)| = {r_pc1_mod:.3f}  (→1 means PC1 IS the modality split)")
xcm = (C * V).sum(1)  # same-second cross-modal cosine, raw vs aligned
Va, Ca = V - V.mean(0), C - C.mean(0)
Va /= (np.linalg.norm(Va, axis=1, keepdims=True) + 1e-9); Ca /= (np.linalg.norm(Ca, axis=1, keepdims=True) + 1e-9)
xcm_a = (Ca[hasc] * Va[hasc]).sum(1)
print(f"same-second concept·visual cosine: raw mean {xcm[hasc].mean():.3f} (sd {xcm[hasc].std():.3f}) → aligned mean {xcm_a.mean():.3f} (sd {xcm_a.std():.3f})")

# ---------- (2) projections + clustering quality at different dims ----------
def project(X):
    Xc = X - X.mean(0); P = np.linalg.svd(Xc, full_matrices=False)[2]
    return Xc @ P[:2].T, Xc @ P[:50].T

raw2, raw50 = project(Xall)
Xaligned = np.vstack([Va, Ca])
al2, al50 = project(Xaligned)
samp = rng.choice(len(Xall), 4000, replace=False)
print("\nclustering silhouette (higher = cleaner separation), MiniBatchKMeans:")
best = {}
for name, X50 in [('raw-50d', raw50), ('aligned-50d', al50)]:
    for K in [8, 16, 24]:
        cl = MiniBatchKMeans(K, random_state=0, n_init=4, batch_size=2048).fit_predict(X50)
        sil = silhouette_score(X50[samp], cl[samp])
        print(f"  {name:12} K={K:<3} silhouette={sil:+.3f}")
        if name == 'aligned-50d':
            best[K] = (sil, cl)
# clusters from the aligned space (the cleaner one) at its best K
bestK = max(best, key=lambda k: best[k][0]); clusters = best[bestK][1]
print(f"→ using aligned K={bestK} for colours")

# ---------- (3) the payoff: does aligning give a more stable reference mapping? ----------
seq = {}
for r in range(len(owner)):
    seq.setdefault(int(owner[r]), []).append(r)
rowsById = {meta[vi]['id']: np.array(sorted(seq[vi], key=lambda r: sec[r])) for vi in sorted(seq)}


def zc(a):
    a = np.asarray(a, float); s = a.std(); return (a - a.mean()) / s if s > 1e-9 else a * 0.0


def resid(a, ctrl):
    A = np.column_stack([np.ones(len(a))] + ctrl); return np.asarray(a, float) - A @ np.linalg.lstsq(A, a, rcond=None)[0]


def pcorr(a, b, ctrl):
    ra, rb = resid(a, ctrl), resid(b, ctrl)
    return float(np.corrcoef(ra, rb)[0, 1]) if ra.std() > 1e-9 and rb.std() > 1e-9 else 0.0


def entail_refness(Cc, Vv, gap=4):
    n = len(Cc); M = Cc @ Vv.T; ref = np.zeros(n)
    for i in range(n):
        fj = list(range(i + gap, n))
        if fj:
            ref[i] = float(M[i, fj].max())   # uncentred forward concept→visual match = entailment
    return ref


def dropzone_pfut(aligned):
    REF, FUT, LVL, POS = [], [], [], []
    for vid in rowsById:
        rt = RT.get(vid); rows = rowsById[vid]; n = len(rows)
        if not rt or not rt.get('curve') or n < 9:
            continue
        Vv, Cc = (Va[rows], Ca[rows]) if aligned else (V[rows], C[rows])
        ref = entail_refness(Cc, Vv)
        cur = np.asarray(rt['curve'], float); R = zc(np.interp(np.linspace(0, len(cur) - 1, n), np.arange(len(cur)), cur))
        fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0; pos = np.linspace(0, 1, n)
        m = pos >= 0.67
        REF += list(zc(ref)[m]); FUT += list(fut[m]); LVL += list(R[m]); POS += list(pos[m])
    return pcorr(REF, FUT, [np.array(LVL), np.array(POS)])


raw_pf = dropzone_pfut(False); al_pf = dropzone_pfut(True)
print(f"\nENTAILMENT reference mapping — drop-zone retention pFut:")
print(f"  raw cross-modal cosine     : {raw_pf:+.3f}")
print(f"  modality-aligned cosine    : {al_pf:+.3f}   ({'MORE stable/valid' if al_pf > raw_pf + 0.005 else 'no improvement'} : Δ {al_pf-raw_pf:+.3f})")

# ---------- write multi-projection embed map ----------
def grid(a):
    lo, hi = np.percentile(a, 1), np.percentile(a, 99); return (np.clip((a - lo) / ((hi - lo) or 1), 0, 1) * 1000).round().astype(int)
mod = np.concatenate([np.zeros(len(V), int), np.ones(len(C), int)])
vid = np.concatenate([owner, owner]); secs = np.concatenate([sec, sec])
keep = np.concatenate([np.ones(len(V), bool), hasc])   # drop concept points with no speech
out = {'meta': {'n': int(keep.sum()), 'n_visual': int(len(V)), 'n_concept': int(hasc.sum()), 'k': int(bestK),
                'n_videos': len(set(owner)), 'encoder': 'gemini', 'modality_gap': round(mgap, 3),
                'pc1_modality_corr': round(r_pc1_mod, 3), 'entail_pfut_raw': round(raw_pf, 3), 'entail_pfut_aligned': round(al_pf, 3)},
       'm': mod[keep].tolist(), 'c': clusters[keep].tolist(), 'v': vid[keep].tolist(), 's': secs[keep].tolist(),
       'proj': {'raw': {'x': grid(raw2[:, 0])[keep].tolist(), 'y': grid(raw2[:, 1])[keep].tolist()},
                'aligned': {'x': grid(al2[:, 0])[keep].tolist(), 'y': grid(al2[:, 1])[keep].tolist()}}}
json.dump(out, open(os.path.join(HERE, 'rtg_embedmap.json'), 'w'))
print(f"\nwrote rtg_embedmap.json · {out['meta']['n']} points · projections: raw + aligned · clusters K={bestK}")
