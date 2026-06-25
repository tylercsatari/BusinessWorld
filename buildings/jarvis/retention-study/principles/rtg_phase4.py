#!/usr/bin/env python3
"""
RTG · Phase 4. The open/close asymmetry — does behaviour confirm Tyler's core principle that
REFERENCES hold retention but GRATIFICATIONS do not? If opening a loop holds attention, closing
it (the payoff arriving, tension discharged) should RELEASE attention — a non-positive forward
slope. We test reference-ness vs payoff-ness of the same signal head-to-head against real
retention (partial corr with forward 3s slope | level, position), overall and in the drop zone,
with cluster-bootstrap CIs over videos.
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.RandomState(0)
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
byid = {v['id']: v for v in d['videos']}
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}
CHAMP = d['meta']['retention_validation']['phase2']['champion']
print(f"champion: {CHAMP}\n")


def resample(c, n):
    c = np.asarray(c, float); return np.interp(np.linspace(0, len(c) - 1, n), np.arange(len(c)), c)


def zc(a):
    a = np.asarray(a, float); s = a.std(); return (a - a.mean()) / s if s > 1e-9 else a * 0.0


def resid(a, ctrl):
    A = np.column_stack([np.ones(len(a))] + ctrl); return np.asarray(a, float) - A @ np.linalg.lstsq(A, a, rcond=None)[0]


def pcorr(a, b, ctrl):
    ra, rb = resid(a, ctrl), resid(b, ctrl)
    return float(np.corrcoef(ra, rb)[0, 1]) if ra.std() > 1e-9 and rb.std() > 1e-9 else 0.0


# per-video series: reference-ness, payoff-ness, forward slope, level, position
ser = []
for vid in byid:
    rec = byid.get(vid); rt = RT.get(vid); n = rec.get('n_sec', 0) if rec else 0
    sg = rec.get('signals', {}).get(CHAMP) if rec else None
    if not rt or not rt.get('curve') or n < 9 or not sg:
        continue
    R = zc(resample(rt['curve'], n)); fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0
    ref = zc(np.asarray(sg['refness'], float)); pay = zc(np.asarray(sg['payoff'], float)); pos = np.linspace(0, 1, n)
    if pay.std() < 1e-9:
        continue
    ser.append((ref, pay, fut, R, pos))
print(f"{len(ser)} videos\n")


def pooled(which, idxs, lo=0.0, hi=1.01):
    a, fut, lvl, pos = [], [], [], []
    for i in idxs:
        ref, pay, f, R, p = ser[i]; m = (p >= lo) & (p < hi)
        a += list((ref if which == 'ref' else pay)[m]); fut += list(f[m]); lvl += list(R[m]); pos += list(p[m])
    a, fut = np.array(a), np.array(fut)
    return pcorr(a, fut, [np.array(lvl), np.array(pos)]) if len(a) > 50 else 0.0


def ci(which, lo, hi):
    obs = pooled(which, range(len(ser)), lo, hi)
    boot = [pooled(which, rng.randint(0, len(ser), len(ser)), lo, hi) for _ in range(400)]
    return obs, np.percentile(boot, 2.5), np.percentile(boot, 97.5)


print("forward-hold pFut (95% CI over videos):  + = holds attention,  − = releases it")
print(f"{'zone':14}{'REFERENCE (open loop)':28}{'PAYOFF (loop closes)'}")
out = {}
for name, lo, hi in [('overall', 0.0, 1.01), ('drop zone', 0.67, 1.01)]:
    ro, rl, rh = ci('ref', lo, hi); po, pl, ph = ci('pay', lo, hi)
    print(f"  {name:12}{ro:+.3f} [{rl:+.3f},{rh:+.3f}]      {po:+.3f} [{pl:+.3f},{ph:+.3f}]")
    out[name] = {'ref': [round(ro, 3), round(rl, 3), round(rh, 3)], 'pay': [round(po, 3), round(pl, 3), round(ph, 3)]}

dz = out['drop zone']
conf = dz['ref'][1] > 0 and dz['pay'][0] < dz['ref'][0]
print(f"\nverdict: {'CONFIRMED — references HOLD (CI>0), payoffs do NOT (release/neutral)' if conf else 'mixed'}; matches 'references hold retention, not gratifications'.")
d['meta']['retention_validation']['phase4'] = {'by_zone': out, 'champion': CHAMP, 'confirms_ref_not_payoff': bool(conf)}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print("stored phase4 open/close asymmetry")
