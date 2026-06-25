#!/usr/bin/env python3
"""
RTG · build + validate signals from Gemini-Vision detection (rtg_vision.json). Two on-screen
graphic signals, both far cleaner than the OCR version: a COUNTER (a real changing number Gemini
flagged — sustained run) and a PROGRESS BAR (the non-numeric graphic OCR couldn't see, present +
fraction ramping). Each stored as a selectable signal and validated against real retention
(forward-hold pFut, cluster-bootstrap CI over videos).
"""
import os, json, re
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.RandomState(0)
VIS = json.load(open(os.path.join(HERE, 'rtg_vision.json')))
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
byid = {v['id']: v for v in d['videos']}
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}


def parse_num(s):
    if s is None:
        return None
    s = str(s)
    m = re.search(r'(\d+):(\d{2})', s)
    if m:
        return float(int(m.group(1)) * 60 + int(m.group(2)))
    m = re.search(r'-?\d[\d,]*\.?\d*', s.replace(' ', ''))
    if m:
        try:
            return float(m.group(0).replace(',', ''))
        except Exception:
            return None
    return None


def smooth(a, k=2):
    n = len(a); return np.array([a[max(0, i - k):min(n, i + k + 1)].mean() for i in range(n)])


def longest_run(mask):
    best = (0, -1, -1); s = None
    for t, on in enumerate(list(mask) + [False]):
        if on and s is None:
            s = t
        elif not on and s is not None:
            if t - s > best[0]:
                best = (t - s, s, t - 1)
            s = None
    return best  # (len, start, end)


def build(vid, n):
    persec = VIS.get(vid, {}).get('persec', [])
    cp = np.zeros(n, bool); vals = [None] * n; bp = np.zeros(n, bool); bf = [None] * n
    for p in persec:
        t = p['t']
        if 0 <= t < n:
            cp[t] = p.get('cp'); vals[t] = parse_num(p.get('cv')); bp[t] = p.get('bp'); bf[t] = p.get('bf')
    # COUNTER: present-mask, sustained if a run >=4; value non-constant when parseable
    cl, cs, ce = longest_run(cp)
    counter_ok = cl >= 4 and len({round(v, 1) for v in vals[cs:ce + 1] if v is not None}) >= 2
    cref = smooth(cp.astype(float)); cref = cref / (cref.max() + 1e-9) if cref.max() > 0 else cref
    clinks = [{'i': cs, 'j': ce, 's': 1.0, 'p': 1.0, 'src': 'counter'}] if counter_ok else []
    # PROGRESS BAR: present-mask, sustained if run >=3
    bl, bs, be = longest_run(bp)
    bar_ok = bl >= 3
    bref = smooth(bp.astype(float)); bref = bref / (bref.max() + 1e-9) if bref.max() > 0 else bref
    blinks = [{'i': bs, 'j': be, 's': 1.0, 'p': 1.0, 'src': 'bar'}] if bar_ok else []
    return (cref, clinks, counter_ok), (bref, blinks, bar_ok)


nvid = nc = nb = 0
for vid, rec in byid.items():
    n = rec.get('n_sec', 0)
    if vid not in VIS or not VIS[vid].get('persec') or n < 3:
        continue
    nvid += 1
    (cref, clinks, cok), (bref, blinks, bok) = build(vid, n)
    nc += cok; nb += bok
    rec.setdefault('signals', {})['counter'] = {'refness': [round(float(x), 3) for x in cref],
                                               'payoff': [0.0] * n, 'links': clinks, 'has_counter': bool(cok)}
    rec['signals']['progress'] = {'refness': [round(float(x), 3) for x in bref],
                                  'payoff': [0.0] * n, 'links': blinks, 'has_bar': bool(bok)}
print(f"{nvid} videos (Gemini Vision) · {nc} with a sustained counter · {nb} with a progress bar")


# ---- validate both vs retention ----
def resample(c, m):
    c = np.asarray(c, float); return np.interp(np.linspace(0, len(c) - 1, m), np.arange(len(c)), c)


def zc(a):
    a = np.asarray(a, float); s = a.std(); return (a - a.mean()) / s if s > 1e-9 else a * 0.0


def resid(a, ctrl):
    A = np.column_stack([np.ones(len(a))] + ctrl); return np.asarray(a, float) - A @ np.linalg.lstsq(A, a, rcond=None)[0]


def pcorr(a, b, ctrl):
    ra, rb = resid(a, ctrl), resid(b, ctrl)
    return float(np.corrcoef(ra, rb)[0, 1]) if ra.std() > 1e-9 and rb.std() > 1e-9 else 0.0


def validate(signame):
    ser = []
    for vid, rec in byid.items():
        sg = rec.get('signals', {}).get(signame); rt = RT.get(vid); n = rec.get('n_sec', 0)
        if not sg or not rt or not rt.get('curve') or n < 9 or np.std(sg['refness']) < 1e-9:
            continue
        R = zc(resample(rt['curve'], n)); fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0
        ser.append((zc(sg['refness']), fut, R, np.linspace(0, 1, n)))

    def pooled(idxs):
        a, f, l, p = [], [], [], []
        for i in idxs:
            ref, fut, R, pos = ser[i]; a += list(ref); f += list(fut); l += list(R); p += list(pos)
        return pcorr(np.array(a), np.array(f), [np.array(l), np.array(p)]) if len(a) > 50 else 0.0
    if len(ser) < 8:
        return None
    pf = pooled(range(len(ser)))
    boot = [pooled(rng.randint(0, len(ser), len(ser))) for _ in range(400)]
    lo, hi = np.percentile(boot, [2.5, 97.5])
    return {'n': len(ser), 'pFut': round(pf, 3), 'pFut_ci': [round(float(lo), 3), round(float(hi), 3)]}


cv_val = validate('counter'); bv_val = validate('progress')
print(f"counter  pFut={cv_val}")
print(f"progress pFut={bv_val}")

SIGS = d['meta']['signals']
for s in ['counter', 'progress']:
    if s not in SIGS:
        SIGS.append(s)
d['meta']['signals'] = SIGS
d['meta'].setdefault('signal_labels', {}).update({'counter': '🔢 on-screen counter', 'progress': '📊 progress bar'})
rv = d['meta'].setdefault('retention_validation', {})
rv.setdefault('by_signal', {})
if cv_val:
    rv['by_signal']['counter'] = {'pFut': cv_val['pFut']}
if bv_val:
    rv['by_signal']['progress'] = {'pFut': bv_val['pFut']}
rv['counters'] = {'detector': 'gemini-vision', 'n_videos': nvid, 'n_with_counter': int(nc), 'n_with_bar': int(nb),
                  'counter': cv_val, 'progress': bv_val}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print(f"\nstored counter + progress signals (Gemini Vision) + validation")
