#!/usr/bin/env python3
"""
RTG · consensus ensemble over the PRESENCE-VALIDATED survivors only. Not a blurred average — the
survivors collapse into 3 DISTINCT channels: VERBAL (cc/cAny entail, spoken setup→callback),
VISUAL-REVEAL (vc entail, show-then-explain), GRAPHIC (Gemini-Vision counter/progress). Union them
for the most complete R→G structure, and tag every loop with a CONSENSUS confidence = how many
independent channels flag it (the per-loop presence-confidence the shuffle test couldn't give).
Then validate: does the ensemble predict drop-zone retention flattening better than the champion
alone, or is it (as expected) richer coverage but not a better predictor?
"""
import os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.RandomState(0)
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
byid = {v['id']: v for v in d['videos']}
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}
CHAMP = 'cAny_entail_g4'

VERBAL = ['cc_entail_g2', 'cc_entail_g4', 'cc_entail_g6', 'cAny_entail_g2', 'cAny_entail_g4', 'cAny_entail_g6']
VISUAL = ['vc_entail_g2']
GRAPHIC = ['counter', 'progress']
CHANNELS = [('verbal', VERBAL), ('visual', VISUAL), ('graphic', GRAPHIC)]
TOL = 3


def chan_field(sg, ids, n):
    """elementwise-max reference-ness over a channel's member signals + union of their links"""
    ref = np.zeros(n); links = []
    for sid in ids:
        s = sg.get(sid)
        if not s:
            continue
        r = np.asarray(s.get('refness', []), float)
        if len(r) == n:
            ref = np.maximum(ref, r)
        for l in s.get('links', []):
            links.append((l['i'], l['j']))
    return ref, links


nvid = 0
for vid, rec in byid.items():
    n = rec.get('n_sec', 0); sg = rec.get('signals', {})
    if n < 3:
        continue
    nvid += 1
    chans = {name: chan_field(sg, ids, n) for name, ids in CHANNELS}
    # ensemble reference-ness = union (max across channels); active = >0.3
    ens = np.zeros(n)
    for name, (r, _) in chans.items():
        ens = np.maximum(ens, r)
    # consensus per second = how many distinct channels are active
    cons = np.zeros(n)
    for name, (r, _) in chans.items():
        cons += (r > 0.3).astype(float)
    # union of loops, dedup by proximity, confidence = # distinct channels with a link near (i,j)
    alll = []
    for name, (r, links) in chans.items():
        for (i, j) in links:
            alll.append((i, j, name, float(r[i]) if i < n else 0.0))
    alll.sort(key=lambda x: -x[3]); kept = []
    for i, j, name, s in alll:
        hit = next((k for k in kept if abs(k['i'] - i) <= 2 and abs(k['j'] - j) <= 2), None)
        if hit:
            hit['chs'].add(name)
        else:
            kept.append({'i': i, 'j': j, 's': round(s, 3), 'chs': {name}})
    maxc = len(CHANNELS)
    out = []
    for k in kept[:24]:
        c = len(k['chs']) / maxc
        out.append({'i': k['i'], 'j': k['j'], 's': k['s'], 'c': round(c, 3),
                    'str': round(k['s'] * (0.5 + 0.5 * c), 3), 'src': '+'.join(sorted(k['chs']))})
    pay = np.zeros(n)
    for k in out:
        pay[k['j']] = max(pay[k['j']], k['s'])
    rec['signals']['ensemble'] = {'refness': [round(float(x), 3) for x in (ens / (ens.max() + 1e-9))],
                                  'payoff': [round(float(x), 3) for x in pay],
                                  'consensus': [round(float(x / maxc), 3) for x in cons],
                                  'links': sorted(out, key=lambda l: -l['str'])}
print(f"{nvid} videos · ensemble = verbal ∪ visual ∪ graphic, per-loop consensus confidence")


# ---- validate vs retention (drop-zone forward-hold), ensemble vs champion ----
def resample(c, m):
    c = np.asarray(c, float); return np.interp(np.linspace(0, len(c) - 1, m), np.arange(len(c)), c)


def zc(a):
    a = np.asarray(a, float); s = a.std(); return (a - a.mean()) / s if s > 1e-9 else a * 0.0


def resid(a, ctrl):
    A = np.column_stack([np.ones(len(a))] + ctrl); return np.asarray(a, float) - A @ np.linalg.lstsq(A, a, rcond=None)[0]


def pcorr(a, b, ctrl):
    ra, rb = resid(a, ctrl), resid(b, ctrl)
    return float(np.corrcoef(ra, rb)[0, 1]) if ra.std() > 1e-9 and rb.std() > 1e-9 else 0.0


def dropzone(signame, conf_min=0.0):
    ser = []
    for vid, rec in byid.items():
        sg = rec.get('signals', {}).get(signame); rt = RT.get(vid); n = rec.get('n_sec', 0)
        if not sg or not rt or not rt.get('curve') or n < 9:
            continue
        ref = np.asarray(sg['refness'], float)
        if conf_min > 0 and sg.get('consensus'):
            ref = ref * (np.asarray(sg['consensus'], float) >= conf_min)
        if ref.std() < 1e-9:
            continue
        R = zc(resample(rt['curve'], n)); fut = np.array([R[min(n - 1, t + 3)] - R[t] for t in range(n)]) / 3.0
        pos = np.linspace(0, 1, n); m = pos >= 0.67
        ser.append((zc(ref)[m], fut[m], R[m], pos[m]))

    def pooled(idx):
        a, f, l, p = [], [], [], []
        for i in idx:
            r, fu, R, po = ser[i]; a += list(r); f += list(fu); l += list(R); p += list(po)
        return pcorr(np.array(a), np.array(f), [np.array(l), np.array(p)]) if len(a) > 50 else 0.0
    obs = pooled(range(len(ser)))
    boot = [pooled(rng.randint(0, len(ser), len(ser))) for _ in range(300)]
    return obs, np.percentile(boot, 2.5), np.percentile(boot, 97.5), len(ser)


print("\ndrop-zone forward-hold pFut (95% CI):")
for nm, sig, cm in [('champion cAny_entail_g4', CHAMP, 0), ('ensemble (union)', 'ensemble', 0),
                    ('ensemble · ≥2 channels agree', 'ensemble', 2 / 3)]:
    o, lo, hi, nn = dropzone(sig, cm)
    print(f"  {nm:30} pFut={o:+.3f}  [{lo:+.3f},{hi:+.3f}]  (n={nn})")

m = d['meta']
if 'ensemble' not in m['signals']:
    m['signals'] = ['ensemble'] + m['signals']
m.setdefault('signal_labels', {})['ensemble'] = '⛓ consensus ensemble'
o, lo, hi, nn = dropzone('ensemble', 0)
m.setdefault('retention_validation', {}).setdefault('by_signal', {})['ensemble'] = {'pFut': round(o, 3)}
m['ensemble'] = {'channels': [c[0] for c in CHANNELS], 'members': {c[0]: c[1] for c in CHANNELS},
                 'note': 'union of presence-validated channels; per-loop consensus = # channels agreeing'}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print(f"\nstored 'ensemble' signal (3 channels, consensus confidence)")
