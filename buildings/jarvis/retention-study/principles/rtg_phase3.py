#!/usr/bin/env python3
"""
RTG · Phase 3. De-approximate the retention TARGET. Relative-retention conflates "stayed" with
"rewatched" — rewatch loops show as UPWARD spikes that are not people staying, and they corrupt
the forward-slope (a spike makes slope falsely + before / − after). Hampel-despike upward
outliers only (preserve genuine downward leaving), then re-run the champion's drop-zone hold.
Robustness check: does the single-factor entailment finding survive a cleaner target?
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
byid = {v['id']: v for v in d['videos']}
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}
CHAMP = d['meta']['retention_validation']['phase2']['champion']
print(f"champion: {CHAMP}\n")


def resample(c, n):
    c = np.asarray(c, float); return np.interp(np.linspace(0, len(c) - 1, n), np.arange(len(c)), c)


def zc(a):
    a = np.asarray(a, float); s = a.std(); return (a - a.mean()) / s if s > 1e-9 else a * 0.0


def despike_up(c, w=3, k=3.0):
    c = np.asarray(c, float); out = c.copy(); cnt = 0
    for i in range(len(c)):
        lo, hi = max(0, i - w), min(len(c), i + w + 1)
        seg = c[lo:hi]; med = np.median(seg); mad = np.median(np.abs(seg - med)) + 1e-9
        if c[i] > med + k * 1.4826 * mad:   # upward (rewatch) spike only
            out[i] = med; cnt += 1
    return out, cnt


def resid(a, ctrl):
    A = np.column_stack([np.ones(len(a))] + ctrl); return np.asarray(a, float) - A @ np.linalg.lstsq(A, a, rcond=None)[0]


def pcorr(a, b, ctrl):
    ra, rb = resid(a, ctrl), resid(b, ctrl)
    return float(np.corrcoef(ra, rb)[0, 1]) if ra.std() > 1e-9 and rb.std() > 1e-9 else 0.0


def run(despike):
    REF, FUT, LVL, POS = [], [], [], []
    spikes = 0
    for vid in byid:
        rec = byid.get(vid); rt = RT.get(vid); n = rec.get('n_sec', 0) if rec else 0
        if not rt or not rt.get('curve') or n < 9 or CHAMP not in rec.get('signals', {}):
            continue
        cur = np.asarray(rt['curve'], float)
        if despike:
            cur, c = despike_up(cur); spikes += c
        R = zc(resample(cur, n)); fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0
        ref = zc(np.asarray(rec['signals'][CHAMP]['refness'], float)); pos = np.linspace(0, 1, n)
        REF += list(ref); FUT += list(fut); LVL += list(R); POS += list(pos)
    REF, FUT, LVL, POS = map(np.array, (REF, FUT, LVL, POS))
    ctrl = [LVL, POS]
    overall = pcorr(REF, FUT, ctrl)
    thirds = {}
    for name, lo, hi in [('early', 0, 0.34), ('mid', 0.34, 0.67), ('late', 0.67, 1.01)]:
        m = (POS >= lo) & (POS < hi)
        thirds[name] = round(pcorr(REF[m], FUT[m], [LVL[m], POS[m]]), 3)
    return overall, thirds, spikes


raw_o, raw_t, _ = run(False)
ds_o, ds_t, spikes = run(True)
print(f"upward rewatch spikes removed: {spikes}\n")
print(f"                overall   early    mid     late(drop zone)")
print(f"  raw curve     {raw_o:+.3f}   {raw_t['early']:+.3f}  {raw_t['mid']:+.3f}  {raw_t['late']:+.3f}")
print(f"  de-spiked     {ds_o:+.3f}   {ds_t['early']:+.3f}  {ds_t['mid']:+.3f}  {ds_t['late']:+.3f}")
robust = ds_t['late'] > 0.15 and ds_o > 0.15
print(f"\nverdict: entailment drop-zone hold is {'ROBUST to rewatch de-spiking' if robust else 'WEAKENED by de-spiking'} (late {raw_t['late']:+.3f} → {ds_t['late']:+.3f})")

d['meta']['retention_validation']['phase3'] = {
    'despiked_overall': round(ds_o, 3), 'despiked_by_third': ds_t,
    'raw_overall': round(raw_o, 3), 'spikes_removed': int(spikes), 'robust': bool(robust)}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print("stored phase3 de-spiked validation")
