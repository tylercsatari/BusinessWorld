#!/usr/bin/env python3
"""
RTG · Phase 1 rigor. Three things the second-level pFut couldn't tell us:
  (A) VIDEO-LEVEL: does sustained entailment STRUCTURE predict a video's overall keep_rate /
      retention / views, CROSS-VALIDATED, beyond confounds (duration, speech density, visual
      novelty)? The real business outcome, out-of-sample.
  (B) CLUSTER BOOTSTRAP: resample VIDEOS (not seconds — they're autocorrelated) to put honest
      95% CIs on the second-level forward-hold pFut.
  (C) PERMUTATION NULL: shuffle which retention curve pairs with which video to get an
      autocorrelation-robust p-value, and confound controls (is entailment just a proxy?).
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.RandomState(0)
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
byid = {v['id']: v for v in d['videos']}
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}
z = np.load(os.path.join(HERE, 'rtg_tokens_gemini.npz'))
owner, sec = z['owner'], z['sec']
V = z['clip_img'].astype(np.float64); hasc = z['has_c'].astype(bool)
V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
seq = {}
for r in range(len(owner)):
    seq.setdefault(int(owner[r]), []).append(r)
rowsById = {meta[vi]['id']: np.array(sorted(seq[vi], key=lambda r: sec[r])) for vi in sorted(seq)}

SIGS = d['meta']['signals']
ENT = next((s for s in SIGS if s.startswith('cAny_entail')), next((s for s in SIGS if 'entail' in s), None))
CON = next((s for s in SIGS if s.startswith('anyAny_content')), None)
ENS = 'ensemble'
print(f"entail signal: {ENT} · content: {CON}")


def resample(c, n):
    c = np.asarray(c, float); return np.interp(np.linspace(0, len(c) - 1, n), np.arange(len(c)), c)


def zc(a):
    a = np.asarray(a, float); s = a.std(); return (a - a.mean()) / s if s > 1e-9 else a * 0.0


def sigfeats(sg, n):
    r = np.asarray(sg['refness'], float)
    cov = float((r > 0.3).mean()); dens = float(r.mean())
    run = mx = 0
    for x in (r > 0.3):
        run = run + 1 if x else 0; mx = max(mx, run)
    sustain = mx / n
    span = sum(l['j'] - l['i'] for l in sg.get('links', [])) / n
    return [dens, cov, sustain, span]


# ---- per-video features, confounds, targets, and per-second series ----
vids, Xent, Xcon, Xcf, keep, ret, lviews = [], [], [], [], [], [], []
series = {ENT: [], ENS: []}   # per video: (ref, futslope, level, pos)
for vid in rowsById:
    rec = byid.get(vid); rt = RT.get(vid); rows = rowsById[vid]; n = len(rows)
    if rec is None or rt is None or not rt.get('curve') or n < 8 or rt.get('keep_rate') is None:
        continue
    se = rec.get('signals', {})
    if ENT not in se or ENS not in se:
        continue
    Vv = V[rows]
    novelty = float(np.mean([1 - Vv[t - 1] @ Vv[t] for t in range(1, n)]))
    speech = float(hasc[rows].mean())
    vids.append(vid)
    Xent.append(sigfeats(se[ENT], n)); Xcon.append(sigfeats(se[CON], n) if CON in se else [0, 0, 0, 0])
    Xcf.append([rt['duration_s'], speech, novelty, n])
    keep.append(rt['keep_rate'] / 100.0); ret.append((rt.get('avg_retention') or 0) / 100.0)
    lviews.append(np.log10((rt.get('views') or 0) + 1))
    R = zc(resample(rt['curve'], n)); fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0
    pos = np.linspace(0, 1, n)
    for s in series:
        ref = np.asarray(se[s]['refness'], float)
        series[s].append((zc(ref) if ref.std() > 1e-9 else ref * 0, fut, R, pos))
Xent, Xcon, Xcf = np.array(Xent), np.array(Xcon), np.array(Xcf)
keep, ret, lviews = np.array(keep), np.array(ret), np.array(lviews)
N = len(vids); print(f"{N} videos with retention + signals\n")


def cvr2(X, y, k=5):
    perm = rng.permutation(len(y)); Xp, yp = X[perm], y[perm]; pred = np.zeros(len(y))
    folds = np.array_split(np.arange(len(y)), k)
    for f in range(k):
        te = np.zeros(len(y), bool); te[folds[f]] = True; tr = ~te
        mu, sd = Xp[tr].mean(0), Xp[tr].std(0) + 1e-9; Xs = (Xp - mu) / sd
        A = np.column_stack([np.ones(tr.sum()), Xs[tr]]); beta = np.linalg.lstsq(A, yp[tr], rcond=None)[0]
        pred[te] = np.column_stack([np.ones(te.sum()), Xs[te]]) @ beta
    return 1 - ((yp - pred) ** 2).sum() / (((yp - yp.mean()) ** 2).sum() + 1e-12)


print("=== (A) VIDEO-LEVEL: out-of-sample R² (5-fold CV), does entailment STRUCTURE add signal? ===")
for tname, y in [('keep_rate', keep), ('avg_retention', ret), ('log_views', lviews)]:
    base = cvr2(Xcf, y); full = cvr2(np.column_stack([Xcf, Xent]), y); con = cvr2(np.column_stack([Xcf, Xcon]), y)
    # bootstrap CI on ΔR² (entailment over confounds)
    Xfull = np.column_stack([Xcf, Xent]); ds = []
    for _ in range(400):
        bi = rng.randint(0, N, N)
        ds.append(cvr2(Xfull[bi], y[bi]) - cvr2(Xcf[bi], y[bi]))
    lo, hi = np.percentile(ds, [2.5, 97.5])
    print(f"  {tname:14} confounds R²={base:+.3f} | +entail R²={full:+.3f} (ΔR²={full-base:+.3f}, 95%CI[{lo:+.3f},{hi:+.3f}]) | +content R²={con:+.3f}")

print("\n=== (B/C) SECOND-LEVEL forward-hold pFut: cluster-bootstrap CI + permutation p ===")


def resid(y, X):
    X = np.column_stack([np.ones(len(y))] + X); return np.asarray(y) - X @ np.linalg.lstsq(X, y, rcond=None)[0]


def pooled_pfut(ser, idxs):
    ref, fut, lvl, pos = [], [], [], []
    for i in idxs:
        a, b, c, p = ser[i]; ref += list(a); fut += list(b); lvl += list(c); pos += list(p)
    ref, fut = np.array(ref), np.array(fut); ctrl = [np.array(lvl), np.array(pos)]
    if len(ref) < 50 or ref.std() < 1e-9:
        return 0.0
    ra, rf = resid(ref, ctrl), resid(fut, ctrl)
    return float(np.corrcoef(ra, rf)[0, 1]) if ra.std() > 1e-9 and rf.std() > 1e-9 else 0.0


for s in series:
    ser = series[s]; idx = list(range(len(ser)))
    obs = pooled_pfut(ser, idx)
    boot = [pooled_pfut(ser, rng.randint(0, len(ser), len(ser))) for _ in range(500)]
    lo, hi = np.percentile(boot, [2.5, 97.5])
    # permutation: pair each video's signal series with ANOTHER video's retention (break the link)
    null = []
    for _ in range(500):
        perm = rng.permutation(len(ser))
        shf = [(ser[i][0], ser[perm[i]][1], ser[perm[i]][2], ser[i][3]) for i in range(len(ser))]
        null.append(pooled_pfut(shf, idx))
    p = (np.sum(np.abs(null) >= abs(obs)) + 1) / (len(null) + 1)
    lab = d['meta']['signal_labels'].get(s, s)
    print(f"  {lab[:30]:30} pFut={obs:+.3f}  95%CI[{lo:+.3f},{hi:+.3f}]  perm-p={p:.3f}")
    d['meta'].setdefault('retention_validation', {}).setdefault('by_signal', {}).setdefault(s, {})
    d['meta']['retention_validation']['by_signal'][s].update({'pFut_ci': [round(lo, 3), round(hi, 3)], 'pFut_p': round(float(p), 4)})

# ---- WHERE does the entailment hold live? by position third (early / mid / late drop zone) ----
print("\n=== entailment forward-hold by video position (does it rescue the back-half drop zone?) ===")
ser = series[ENT]
terc = {}
for name, lo_p, hi_p in [('early', 0.0, 0.34), ('mid', 0.34, 0.67), ('late', 0.67, 1.01)]:
    ref, fut, lvl, pos = [], [], [], []
    for a, b, c, p in ser:
        m = (p >= lo_p) & (p < hi_p)
        ref += list(a[m]); fut += list(b[m]); lvl += list(c[m]); pos += list(p[m])
    ref, fut = np.array(ref), np.array(fut); ctrl = [np.array(lvl), np.array(pos)]
    pf = float(np.corrcoef(resid(ref, ctrl), resid(fut, ctrl))[0, 1]) if len(ref) > 50 and ref.std() > 1e-9 else 0.0
    terc[name] = round(pf, 3); print(f"  {name:6} pFut={pf:+.3f}  ({len(ref)} secs)")

d['meta'].setdefault('retention_validation', {})['video_level'] = {
    'n': N, 'keep_dR2': round(cvr2(np.column_stack([Xcf, Xent]), keep) - cvr2(Xcf, keep), 3),
    'ret_base_r2': round(cvr2(Xcf, ret), 3), 'ret_dR2': round(cvr2(np.column_stack([Xcf, Xent]), ret) - cvr2(Xcf, ret), 3),
    'ent_signal': ENT, 'by_third': terc,
    'scope': 'within-video moment-level effect (robust); NOT a video-level keep-rate predictor'}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print("\nstored CIs, p-values, and video-level ΔR² in rtg_field.json")
