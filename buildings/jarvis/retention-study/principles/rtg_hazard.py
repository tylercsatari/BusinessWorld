#!/usr/bin/env python3
"""
RTG · the retention SOURCE OF TRUTH. Builds the normalized retention model everything else gets
measured against, all emergent from the data — no chosen weights:

  1. ABSOLUTE survival, rewatch-decomposed. The curve is absolute %, >100% from replays. Split
     observed O(t) into forward SURVIVAL S(t) (monotone, the real audience decay) + REPLAY(t)
     (the bumps — a positive engagement signal, not noise).
  2. HAZARD h(t) = (S(t)-S(t+1))/S(t) = fraction of the CURRENT audience lost per second. This is
     the fix for "5% at 80% = 6.25% but 5% at 30% = 16.7%", and per-second handles "10% over 10s
     ≠ over 30s". Work in log-hazard λ(t) = -ln(S(t+1)/S(t)).
  3. NATURAL DECAY baseline = mean λ at each position (in % and in absolute seconds) → the mean to
     offset. residual ρ(t) = λ(t) − baseline.
  4. PRIORITY per second, EMERGENT (not chosen): watch-time-marginal value of reducing hazard at t
     = remaining area under survival after t (early compounds → high; "10% early worse than 50%
     late" falls out), plus the views-relevant priority = per-position assoc with log(views).
Writes rtg_hazard.json (population curves + per-video survival/hazard/residual) for the Views UI.
"""
import os, json
import numpy as np
from sklearn.isotonic import IsotonicRegression

HERE = os.path.dirname(os.path.abspath(__file__))
RT = {v['id']: v for v in json.load(open(os.path.join(HERE, '..', 'retention_table.json')))['videos']}
z = np.load(os.path.join(HERE, 'rtg_tokens_gemini.npz'))
owner, sec = z['owner'].astype(int), z['sec'].astype(int)
Vt = z['clip_img'].astype(np.float64); hasc = z['has_c'].astype(bool)
Vt /= (np.linalg.norm(Vt, axis=1, keepdims=True) + 1e-9)
seqrows = {}
for r in range(len(owner)):
    seqrows.setdefault(int(owner[r]), []).append(r)


def to_seconds(curve, dur):
    n = max(8, int(round(dur)))
    return np.interp(np.linspace(0, len(curve) - 1, n), np.arange(len(curve)), np.asarray(curve, float))


def decompose(O):
    iso = IsotonicRegression(increasing=False, out_of_bounds='clip')
    S = iso.fit_transform(np.arange(len(O)), O)          # monotone forward survival (the real decay)
    S = np.clip(S, 1e-4, None); S = S / S[0]              # normalize: everyone present at t=0
    replay = np.clip(O / O[0] - S, 0, None)               # the bumps above the decline = replays
    return S, replay


# ---- per video: survival, hazard, replay ----
vids, data = [], {}
P = 100  # % grid
surv_by_pct, haz_by_pct = [[] for _ in range(P)], [[] for _ in range(P)]
maxT = 0
for vid, rt in RT.items():
    if not rt.get('curve') or (rt.get('duration_s') or 0) < 8:
        continue
    O = to_seconds(rt['curve'], rt['duration_s']); n = len(O)
    S, replay = decompose(O)
    lam = -np.log(np.clip(S[1:] / S[:-1], 1e-6, 1.0)); lam = np.append(lam, lam[-1] if len(lam) else 0)  # per-sec log-hazard
    haz = 1 - np.clip(S[1:] / S[:-1], 0, 1); haz = np.append(haz, haz[-1] if len(haz) else 0)
    vids.append(vid); data[vid] = {'S': S, 'replay': replay, 'lam': lam, 'haz': haz, 'n': n}
    maxT = max(maxT, n)
    pos = (np.arange(n) / max(1, n - 1) * (P - 1)).astype(int)
    for t in range(n):
        surv_by_pct[pos[t]].append(S[t]); haz_by_pct[pos[t]].append(lam[t])

base_lam_pct = np.array([np.mean(v) if v else 0 for v in haz_by_pct])    # NATURAL DECAY (mean log-hazard by %)
mean_surv_pct = np.array([np.mean(v) if v else 0 for v in surv_by_pct])
# baseline by absolute second
base_lam_sec = np.zeros(maxT)
for t in range(maxT):
    vals = [data[v]['lam'][t] for v in vids if t < data[v]['n']]
    base_lam_sec[t] = np.mean(vals) if vals else 0

# ---- EMERGENT priority: watch-time-marginal = remaining area under mean survival after each % ----
prio_watch = np.array([mean_surv_pct[p:].sum() for p in range(P)])
prio_watch = prio_watch / (prio_watch[0] + 1e-9)
print("NATURAL DECAY (mean log-hazard by % of video) — front-loaded as expected:")
for p in [0, 1, 2, 5, 10, 25, 50, 75, 99]:
    print(f"  {p:3d}%  hazard λ={base_lam_pct[p]:.4f}  survival={mean_surv_pct[p]:.3f}  watch-priority={prio_watch[p]:.3f}")

# ---- views-relevant priority: assoc of per-position hazard-residual with log(views), confound-controlled ----
B = 20
def binmean(arr, n):
    out = np.zeros(B)
    for b in range(B):
        s, e = int(b * n / B), max(int(b * n / B) + 1, int((b + 1) * n / B))
        out[b] = arr[s:e].mean()
    return out

X, lv, conf = [], [], []
for vid in vids:
    rt = RT[vid]; d = data[vid]; n = d['n']
    resid = d['lam'] - base_lam_pct[(np.arange(n) / max(1, n - 1) * (P - 1)).astype(int)]
    X.append(binmean(resid, n)); lv.append(np.log10((rt.get('views') or 0) + 1))
    conf.append([np.log10((rt.get('duration_s') or 1)), (rt.get('avg_retention') or 0) / 100.0])
X = np.array(X); lv = np.array(lv); conf = np.array(conf)
Xz = (X - X.mean(0)) / (X.std(0) + 1e-9); Cz = (conf - conf.mean(0)) / (conf.std(0) + 1e-9)
A = np.column_stack([np.ones(len(lv)), Cz, Xz]); lam_ridge = 5.0
beta = np.linalg.solve(A.T @ A + lam_ridge * np.eye(A.shape[1]), A.T @ lv)
views_prio = beta[1 + Cz.shape[1]:]   # per position-bin coefficient (assoc of lower hazard there with views)
print("\nVIEWS priority by position-bin (−coef: lower hazard there ↔ more views; confound-controlled, associational):")
print("  " + " ".join(f"{-views_prio[b]:+.2f}" for b in range(B)))

# ---- by ABSOLUTE SECOND (the duration confound: 5% of 30s ≠ 5% of 180s) ----
mean_surv_sec = np.zeros(maxT)
for t in range(maxT):
    vals = [data[v]['S'][t] for v in vids if t < data[v]['n']]
    mean_surv_sec[t] = np.mean(vals) if vals else (mean_surv_sec[t - 1] if t > 0 else 1.0)
prio_watch_sec = np.array([mean_surv_sec[t:].sum() for t in range(maxT)]); prio_watch_sec /= (prio_watch_sec[0] + 1e-9)

# DISENTANGLE: do short and long videos overlay by SECONDS (absolute) or by % (fractional)?
med = float(np.median([data[v]['n'] for v in vids]))
groups = {'short': [v for v in vids if data[v]['n'] < med], 'long': [v for v in vids if data[v]['n'] >= med]}


def grpcurves(grp):
    hp, sp = [[] for _ in range(P)], [[] for _ in range(P)]; hs, ss = [[] for _ in range(maxT)], [[] for _ in range(maxT)]
    for v in grp:
        d = data[v]; n = d['n']; pos = (np.arange(n) / max(1, n - 1) * (P - 1)).astype(int)
        for t in range(n):
            hp[pos[t]].append(d['lam'][t]); sp[pos[t]].append(d['S'][t]); hs[t].append(d['lam'][t]); ss[t].append(d['S'][t])
    f = lambda L: [round(float(np.mean(x)), 4) if x else None for x in L]
    return {'haz_pct': f(hp), 'surv_pct': f(sp), 'haz_sec': f(hs), 'surv_sec': f(ss)}


grp = {k: grpcurves(g) for k, g in groups.items()}
# conflation metric: spread between short & long, by SEC vs by % over the first 6 units
def spread(a, b, k):
    aa = [a[i] for i in range(k) if a[i] is not None and b[i] is not None]; bb = [b[i] for i in range(k) if a[i] is not None and b[i] is not None]
    return float(np.mean([abs(x - y) for x, y in zip(aa, bb)])) if aa else 0.0
sp_sec = spread(grp['short']['surv_sec'], grp['long']['surv_sec'], 6)
sp_pct = spread(grp['short']['surv_pct'], grp['long']['surv_pct'], 6)
print(f"\nDURATION CONFOUND — short vs long survival spread over first 6 units: by-second {sp_sec:.3f} vs by-% {sp_pct:.3f}")
print(f"  → early retention is more {'ABSOLUTE-TIME locked (use seconds early)' if sp_sec < sp_pct else 'FRACTION locked (use %)'}")

out = {'P': P, 'maxT': int(maxT), 'median_dur': round(med, 1),
       'mean_survival_sec': [round(float(x), 3) for x in mean_surv_sec],
       'priority_watch_sec': [round(float(x), 3) for x in prio_watch_sec],
       'grp': grp, 'conflation': {'sec_spread': round(sp_sec, 3), 'pct_spread': round(sp_pct, 3)},
       'natural_decay_pct': [round(float(x), 4) for x in base_lam_pct],
       'mean_survival_pct': [round(float(x), 3) for x in mean_surv_pct],
       'natural_decay_sec': [round(float(x), 4) for x in base_lam_sec],
       'priority_watch_pct': [round(float(x), 3) for x in prio_watch],
       'priority_views_bin': [round(float(-x), 3) for x in views_prio],
       'videos': {vid: {'S': [round(float(x), 3) for x in data[vid]['S']],
                        'replay': [round(float(x), 3) for x in data[vid]['replay']],
                        'haz': [round(float(x), 4) for x in data[vid]['haz']]} for vid in vids}}
json.dump(out, open(os.path.join(HERE, 'rtg_hazard.json'), 'w'))
print(f"\nwrote rtg_hazard.json · {len(vids)} videos · population baseline + per-second priority + per-video survival/hazard")
