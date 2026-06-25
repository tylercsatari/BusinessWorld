#!/usr/bin/env python3
"""
RTG · Phase 2. Learn a BEHAVIOUR-optimized open-loop signal: the weighting over loop-type
families that best predicts the real drop-zone (back-third) forward retention hold — and prove
it generalises by evaluating ONLY on held-out videos (group 5-fold). The honest test: does a
learned blend beat single entailment out-of-sample, or does parsimony win?

Ridge on per-second reference-ness of the distinct operator families (z-scored per video,
residualised on level+position so we learn what holds attention BEYOND where it already sits).
Held-out score = pooled out-of-fold partial corr of the blend with the forward slope. Stores
the generalising blend as a selectable 'behaviour' signal + its weights.
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.RandomState(0)
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
byid = {v['id']: v for v in d['videos']}
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}
SIGS = d['meta']['signals']

# distinct operator families (one representative each, prefer gap4) + the predictive lenses
WANT = ['entail', 'sharp', 'content', 'infogap', 'suspense', 'incomplete', 'recur', 'tension', 'novel', 'directed', 'surprise']
FEAT = []
for op in WANT:
    s = next((x for x in SIGS if f'_{op}_g4' in x), next((x for x in SIGS if f'_{op}_' in x), None))
    if s and s not in FEAT:
        FEAT.append(s)
for s in ['jepa_anticip', 'jepa']:
    if s in SIGS:
        FEAT.append(s)
ENT = next(x for x in FEAT if 'entail' in x)
print(f"features ({len(FEAT)}): {FEAT}\nentail baseline: {ENT}\n")


def resample(c, n):
    c = np.asarray(c, float); return np.interp(np.linspace(0, len(c) - 1, n), np.arange(len(c)), c)


def zc(a):
    a = np.asarray(a, float); s = a.std(); return (a - a.mean()) / s if s > 1e-9 else a * 0.0


# pooled BACK-THIRD per-second dataset, with video group ids
X, y, lvl, pos, grp = [], [], [], [], []
vids = [v for v in byid if v in RT and RT[v].get('curve') and byid[v].get('n_sec', 0) >= 9 and all(f in byid[v].get('signals', {}) for f in FEAT)]
for gi, vid in enumerate(vids):
    rec = byid[vid]; n = rec['n_sec']
    R = zc(resample(RT[vid]['curve'], n)); fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0
    p = np.linspace(0, 1, n); mask = p >= 0.67
    feats = np.column_stack([zc(np.asarray(rec['signals'][f]['refness'], float)) for f in FEAT])
    X.append(feats[mask]); y.append(fut[mask]); lvl.append(R[mask]); pos.append(p[mask]); grp.append(np.full(mask.sum(), gi))
X = np.vstack(X); y = np.concatenate(y); lvl = np.concatenate(lvl); pos = np.concatenate(pos); grp = np.concatenate(grp)
print(f"{len(vids)} videos · {len(y)} back-third seconds · {X.shape[1]} features")


def resid(a, ctrl):
    A = np.column_stack([np.ones(len(a))] + ctrl); return np.asarray(a, float) - A @ np.linalg.lstsq(A, a, rcond=None)[0]


def pcorr(a, b, ctrl):
    ra, rb = resid(a, ctrl), resid(b, ctrl)
    return float(np.corrcoef(ra, rb)[0, 1]) if ra.std() > 1e-9 and rb.std() > 1e-9 else 0.0


# group 5-fold: learn ridge on train videos, predict held-out → pooled out-of-fold blend score
gids = np.array(sorted(set(grp))); rng.shuffle(gids); folds = np.array_split(gids, 5)
ctrlAll = [lvl, pos]
ent_pfut = pcorr(X[:, FEAT.index(ENT)], y, ctrlAll)


def heldout_blend(LAM):
    oof = np.zeros(len(y))
    for f in range(5):
        te = np.isin(grp, folds[f]); tr = ~te; ctrlTr = [lvl[tr], pos[tr]]
        Xr = np.column_stack([resid(X[tr, k], ctrlTr) for k in range(X.shape[1])]); yr = resid(y[tr], ctrlTr)
        w = np.linalg.solve(Xr.T @ Xr + LAM * np.eye(Xr.shape[1]), Xr.T @ yr)
        oof[te] = X[te] @ w
    return pcorr(oof, y, ctrlAll)


print("\nHELD-OUT drop-zone forward-hold pFut — does ANY blend beat entail across regularisation?")
print(f"  entail alone : {ent_pfut:+.3f}")
sweep = {}
for LAM in [0.5, 1, 2, 5, 20, 50]:
    bp = heldout_blend(LAM); sweep[LAM] = bp
    print(f"  blend λ={LAM:<4}: {bp:+.3f}   (Δ {bp-ent_pfut:+.3f})")
best_blend = max(sweep.values())

# weights at a representative λ (for interpretation only)
LAM = 5.0; Xr = np.column_stack([resid(X[:, k], ctrlAll) for k in range(X.shape[1])]); yr = resid(y, ctrlAll)
W = np.linalg.solve(Xr.T @ Xr + LAM * np.eye(Xr.shape[1]), Xr.T @ yr); order = np.argsort(-np.abs(W))
print("\nlearned weights (interpretation): entail should dominate if it's a single-factor effect")
for k in order:
    print(f"  {W[k]:+.3f}  {FEAT[k]}")

# do NOT promote a blend that doesn't beat the single signal — mark the entail CHAMPION instead
CHAMP = next((x for x in SIGS if x.startswith('cAny_entail')), ENT)
for vid in byid.values():
    vid.get('signals', {}).pop('behaviour', None)   # clean any prior run
d['meta']['signals'] = [s for s in SIGS if s != 'behaviour']
d['meta'].setdefault('signal_labels', {}).pop('behaviour', None)
rv = d['meta'].setdefault('retention_validation', {}).setdefault('by_signal', {})
rv.pop('behaviour', None)
verdict = 'blend generalises' if best_blend > ent_pfut + 0.01 else 'parsimony wins — entailment alone is the retention-optimized signal'
d['meta']['retention_validation']['phase2'] = {
    'entail_pfut': round(ent_pfut, 3), 'best_blend_pfut': round(best_blend, 3),
    'sweep': {str(k): round(v, 3) for k, v in sweep.items()},
    'weights': {FEAT[k]: round(float(W[k]), 3) for k in order},
    'champion': CHAMP, 'n_secs': int(len(y)), 'verdict': verdict}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print(f"\nverdict: {verdict}\nchampion = {CHAMP}")
