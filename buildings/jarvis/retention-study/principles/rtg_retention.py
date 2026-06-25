#!/usr/bin/env python3
"""
RTG · the REAL validation. No labels (a guide, not truth), no heuristic payoffs. Test every
open-loop signal against the one ground truth that IS truth: actual viewer retention, scraped
per-video from YouTube Studio (relative audience-retention curve — the universal decay shape is
already divided out, so local rises/dips are content-specific: a rise = this moment holds
attention better than a typical video, a dip = people swipe away here).

Falsifiable claim: an open loop HOLDS attention. So where reference-ness is high (a loop is
open), the retention slope should be less negative / rising; where nothing is open (dead zone),
viewers leave faster. We measure this per signal, pooled across all 211 videos, within-video
z-scored so no video dominates. Reported as a real effect size, not a label overlap.
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
byid = {v['id']: v for v in d['videos']}
RT = json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']
curveById = {v['id']: np.array(v['curve'], float) for v in RT if v.get('curve')}

SIGS = d['meta']['signals']


def resample(curve, n):
    return np.interp(np.linspace(0, len(curve) - 1, n), np.arange(len(curve)), curve)


def zc(a):
    a = np.asarray(a, float); s = a.std()
    return (a - a.mean()) / s if s > 1e-9 else a * 0.0


# pool per signal. CONFOUND CONTROL: retention level mean-reverts (high now → falls after) and
# both retention and ref-ness vary with position in the video. So the clean test is a PARTIAL
# correlation of ref-ness with the forward retention slope, residualising BOTH on the current
# retention level R(t) and the position t/n. That isolates "does opening a loop hold attention
# beyond where retention already is", not the artifact that peaks crest afterwards.
pool = {s: {'ref': [], 'slopeNow': [], 'slopeFut': [], 'level': [], 'pos': []} for s in SIGS}
nvid = 0
for vid, rec in byid.items():
    n = rec.get('n_sec', 0)
    if vid not in curveById or n < 8:
        continue
    R = zc(resample(curveById[vid], n))
    slope = np.concatenate([np.diff(R), [0.0]])
    fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0
    pos = np.linspace(0, 1, n)
    has = False
    for s in SIGS:
        sg = rec.get('signals', {}).get(s)
        if not sg or not sg.get('refness') or len(sg['refness']) != n:
            continue
        ref = np.asarray(sg['refness'], float)
        if ref.std() < 1e-9:
            continue
        pool[s]['ref'] += list(zc(ref)); pool[s]['slopeNow'] += list(slope)
        pool[s]['slopeFut'] += list(fut); pool[s]['level'] += list(R); pool[s]['pos'] += list(pos); has = True
    if has:
        nvid += 1


def corr(a, b):
    a, b = np.asarray(a), np.asarray(b)
    if len(a) < 30 or a.std() < 1e-9 or b.std() < 1e-9:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def resid(y, X):
    X = np.column_stack([np.ones(len(y))] + X)
    return np.asarray(y) - X @ np.linalg.lstsq(X, y, rcond=None)[0]


def partial(a, b, ctrl):
    if len(a) < 30:
        return 0.0
    return corr(resid(np.asarray(a, float), ctrl), resid(np.asarray(b, float), ctrl))


print(f"\n=== OPEN LOOPS vs REAL RETENTION ({nvid} videos, per-second, within-video z-scored) ===")
print("pFut = PARTIAL corr(ref-ness, forward 3s retention slope) controlling for level+position.")
print("pFut>0 ⇒ opening a loop HOLDS attention beyond where retention already sits.\n")
res = {}
for s in SIGS:
    p = pool[s]
    if len(p['ref']) < 200:
        continue
    ctrl = [np.asarray(p['level']), np.asarray(p['pos'])]
    pFut = partial(p['ref'], p['slopeFut'], ctrl)
    pNow = partial(p['ref'], p['slopeNow'], ctrl)
    rLvl = corr(p['ref'], p['level'])
    rf = resid(np.asarray(p['slopeFut'], float), ctrl); ra = resid(np.asarray(p['ref'], float), ctrl)
    hi, lo = ra >= np.quantile(ra, 0.75), ra <= np.quantile(ra, 0.25)
    lift = float(rf[hi].mean() - rf[lo].mean())
    res[s] = {'pFut': round(pFut, 3), 'pNow': round(pNow, 3), 'rLvl': round(rLvl, 3), 'lift': round(lift, 4), 'n': len(p['ref'])}

rank = sorted(res, key=lambda s: -res[s]['pFut'])
lab = d['meta'].get('signal_labels', {})
for s in rank:
    r = res[s]
    print(f"  pFut={r['pFut']:+.3f}  pNow={r['pNow']:+.3f}  rLvl={r['rLvl']:+.3f}  lift={r['lift']:+.4f}  {lab.get(s, s)[:34]}")

d['meta']['retention_validation'] = {'n_videos': nvid, 'metric': 'partial corr(reference-ness, forward retention slope | level, position)', 'by_signal': res}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print(f"\nstored retention_validation for {len(res)} signals. best forward-hold: {lab.get(rank[0], rank[0])} (pFut={res[rank[0]]['pFut']:+.3f})")
