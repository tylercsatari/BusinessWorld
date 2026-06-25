#!/usr/bin/env python3
"""
RTG · taxonomy #3 detector + validation. Turns full-video OCR (ocr_full.json) into a COUNTER
signal: a true counter/timer/score/progress-% is a NUMBER that CHANGES on screen (a static date
or logo doesn't count); a sustained one ramps MONOTONICALLY toward a target — a persistent open
loop spanning many seconds. We mark per-second "counter live", find monotonic spans, store it as
a selectable 'counter' signal, and validate it against real retention (does a live on-screen
counter hold attention, like the theory says a sustained loop should?).
"""
import os, json, re
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OCR = json.load(open(os.path.join(HERE, 'ocr_full.json')))
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
byid = {v['id']: v for v in d['videos']}
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}


def parse_num(tok):
    t = tok.replace('%', '')
    try:
        if ':' in t:
            parts = [int(x) for x in t.split(':')]; return float(sum(p * 60 ** (len(parts) - 1 - i) for i, p in enumerate(parts)))
        return float(t.replace(',', ''))
    except Exception:
        return None


def detect(persec, n, MINLEN=6, STEP=0.4):
    """A REAL counter = a number that moves SMOOTHLY and MONOTONICALLY for >=MINLEN seconds
    (relative step <STEP, spanning a real range). DP longest-smooth-monotonic chain over all
    per-second candidates — robust to OCR noise (random digit strings don't form long smooth runs).
    Returns the per-second live mask of the best counter span + the span itself."""
    vals = [[] for _ in range(n)]
    for p in persec:
        t = p['t']
        if 0 <= t < n:
            vals[t] = [v for v in (parse_num(x) for x in p.get('nums', [])) if v is not None and abs(v) < 1e9]
    # dp[(t,k)] for up/down chains = (length, startT, minVal, maxVal)
    dpu, dpd = {}, {}
    best = None  # (start, end, length)
    for t in range(n):
        for k, v in enumerate(vals[t]):
            dpu[(t, k)] = (1, t, v, v); dpd[(t, k)] = (1, t, v, v)
            for pt in range(max(0, t - 2), t):
                for pk, pv in enumerate(vals[pt]):
                    if abs(v - pv) / max(1.0, abs(pv)) > STEP:
                        continue
                    if v >= pv - 1e-9:
                        L, st, mn, mx = dpu[(pt, pk)]
                        if L + 1 > dpu[(t, k)][0]:
                            dpu[(t, k)] = (L + 1, st, min(mn, v), max(mx, v))
                    if v <= pv + 1e-9:
                        L, st, mn, mx = dpd[(pt, pk)]
                        if L + 1 > dpd[(t, k)][0]:
                            dpd[(t, k)] = (L + 1, st, min(mn, v), max(mx, v))
            for dp in (dpu, dpd):
                L, st, mn, mx = dp[(t, k)]
                if L >= MINLEN and (mx - mn) > 1e-6 and (best is None or (t - st) > best[1] - best[0]):
                    best = (st, t, L)
    live = np.zeros(n)
    if best:
        live[best[0]:best[1] + 1] = 1.0
    return live, best


# smooth a binary live-mask into a reference-ness curve (the loop stays open while it runs)
def smooth(a, k=2):
    n = len(a); out = np.zeros(n)
    for i in range(n):
        out[i] = a[max(0, i - k):min(n, i + k + 1)].mean()
    return out


nvid = ncounter = 0
for vid, rec in byid.items():
    n = rec.get('n_sec', 0)
    o = OCR.get(vid)
    if not o or not o.get('persec') or n < 3:
        continue
    nvid += 1
    live, span = detect(o['persec'], n)
    ref = smooth(live); ref = ref / (ref.max() + 1e-9) if ref.max() > 0 else ref
    links = []
    if span:
        s, e, run = span; ncounter += 1
        links = [{'i': s, 'j': e, 's': 1.0, 'p': 1.0, 'src': 'counter'}]
    pay = np.zeros(n)
    if span:
        pay[span[1]] = 1.0   # payoff = the counter reaching its target / completing
    rec.setdefault('signals', {})['counter'] = {'refness': [round(float(x), 3) for x in ref],
                                                'payoff': [round(float(x), 3) for x in pay], 'links': links,
                                                'has_counter': bool(span)}
print(f"{nvid} videos OCR'd · {ncounter} have a sustained monotonic counter/timer span")

# ---- validate: does a live counter hold attention? (same retention machinery) ----
def resample(c, m):
    c = np.asarray(c, float); return np.interp(np.linspace(0, len(c) - 1, m), np.arange(len(c)), c)


def zc(a):
    a = np.asarray(a, float); s = a.std(); return (a - a.mean()) / s if s > 1e-9 else a * 0.0


def resid(a, ctrl):
    A = np.column_stack([np.ones(len(a))] + ctrl); return np.asarray(a, float) - A @ np.linalg.lstsq(A, a, rcond=None)[0]


def pcorr(a, b, ctrl):
    ra, rb = resid(a, ctrl), resid(b, ctrl)
    return float(np.corrcoef(ra, rb)[0, 1]) if ra.std() > 1e-9 and rb.std() > 1e-9 else 0.0


rng = np.random.RandomState(0)
ser = []
for vid, rec in byid.items():
    sg = rec.get('signals', {}).get('counter'); rt = RT.get(vid); n = rec.get('n_sec', 0)
    if not sg or not rt or not rt.get('curve') or n < 9 or np.std(sg['refness']) < 1e-9:
        continue
    R = zc(resample(rt['curve'], n)); fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0
    ser.append((zc(sg['refness']), fut, R, np.linspace(0, 1, n)))


def pooled(idxs, lo=0.0, hi=1.01):
    a, f, l, p = [], [], [], []
    for i in idxs:
        ref, fut, R, pos = ser[i]; m = (pos >= lo) & (pos < hi)
        a += list(ref[m]); f += list(fut[m]); l += list(R[m]); p += list(pos[m])
    return pcorr(np.array(a), np.array(f), [np.array(l), np.array(p)]) if len(a) > 50 else 0.0


if len(ser) >= 10:
    pf = pooled(range(len(ser))); pf_dz = pooled(range(len(ser)), 0.67, 1.01)
    boot = [pooled(rng.randint(0, len(ser), len(ser))) for _ in range(400)]
    lo, hi = np.percentile(boot, [2.5, 97.5])
    print(f"counter forward-hold pFut={pf:+.3f}  95%CI[{lo:+.3f},{hi:+.3f}]  drop-zone={pf_dz:+.3f}  ({len(ser)} videos with a live counter)")
else:
    pf = pf_dz = lo = hi = 0.0
    print("not enough counter-bearing videos to validate")

SIGS = d['meta']['signals']
if 'counter' not in SIGS:
    SIGS.append('counter')
d['meta']['signals'] = SIGS
d['meta'].setdefault('signal_labels', {})['counter'] = '🔢 on-screen counter'
d['meta'].setdefault('retention_validation', {}).setdefault('by_signal', {})['counter'] = {'pFut': round(pf, 3)}
d['meta']['retention_validation']['counters'] = {'n_videos': nvid, 'n_with_counter': ncounter,
                                                 'pFut': round(pf, 3), 'pFut_ci': [round(float(lo), 3), round(float(hi), 3)],
                                                 'pFut_dropzone': round(pf_dz, 3)}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print(f"stored 'counter' signal ({ncounter}/{nvid} videos) + validation")
