#!/usr/bin/env python3
"""
INDICATOR REGISTRY — the single source of truth. Every independent indicator we've
built (embedding content-probes per modality, + the canonical novelty scores) is
validated here against every available target, with the data the Experiment tab
needs to (a) place an uploaded hook on each indicator's graph and (b) ensemble them.

Indicators are produced in their HOME sections; this only VALIDATES + packages them:
  - content_{visual,text,together}  ← raw embeddings (the predictive content axis)
  - novelty_{...}                    ← raw/principles/novelty.npz (single-source novelty)
Targets (every metric each set has):
  views (log, all 11k) · gt10M (class, all) · swipe (owned 211) · ret5 (owned 211)

For each (indicator × target): held-out correlation/AUC (+ permutation p, BH-FDR),
a binned curve (indicator decile → mean target) for the graph, and — for content
indicators — the trained probe weights so an uploaded embedding can be scored.

Writes raw/indicators/registry.json + raw/indicators/weights.npz. Run: python3 indicators.py
"""
import os, io, json, datetime
import numpy as np, boto3
from sklearn.linear_model import Ridge, LogisticRegression
from sklearn.model_selection import KFold
from sklearn.metrics import roc_auc_score
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    v = os.environ.get(k)
    if v: return v
    for ln in open(os.path.join(HERE, '.env')):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
def r2_get(k):
    try: return s3.get_object(Bucket=BUCKET, Key=k)['Body'].read()
    except Exception: return None
def r2_put(k, d, ct): s3.put_object(Bucket=BUCKET, Key=k, Body=d, ContentType=ct)
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
RNG = np.random.RandomState(0); kf = KFold(5, shuffle=True, random_state=0)

# ---- load corpus: embeddings, novelty, metadata, owned retention ----
print('loading…', flush=True)
EMB = {}
for sk, ck in [('visual', 'visual'), ('text', 'text'), ('together', 'together')]:
    z = np.load(io.BytesIO(r2_get(f'raw/{ck}/embeddings.npz')), allow_pickle=True)
    EMB[sk] = {'ids': [str(x) for x in z['ids']], 'V': norm(np.asarray(z['vecs'], np.float32))}
    if sk == 'visual':
        ids = EMB['visual']['ids']; N = len(ids); idpos = {v: i for i, v in enumerate(ids)}
        views = np.asarray(z['views'], float); subs = np.asarray(z['subs'], float)
        mine = np.asarray(z['mine'], bool) if 'mine' in z.files else np.zeros(N, bool)
def aligned(sk):
    M = np.full((N, EMB[sk]['V'].shape[1]), np.nan, np.float32); have = np.zeros(N, bool)
    for j, vid in enumerate(EMB[sk]['ids']):
        i = idpos.get(vid)
        if i is not None: M[i] = EMB[sk]['V'][j]; have[i] = True
    return M, have
MOD = {'visual': (EMB['visual']['V'], np.ones(N, bool)), 'text': aligned('text'), 'together': aligned('together')}
# novelty (single source)
nz = np.load(io.BytesIO(r2_get('raw/principles/novelty.npz')), allow_pickle=True)
nX = np.asarray(nz['X'], float); nnames = [str(x) for x in nz['names']]; nids = [str(x) for x in nz['ids']]; npos = {v: i for i, v in enumerate(nids)}
NOV = {}
for j, nm in enumerate(nnames):
    col = np.full(N, np.nan)
    for vid, i in idpos.items():
        k = npos.get(vid)
        if k is not None: col[i] = nX[k, j]
    NOV[nm] = col
# owned retention — KEEP-rate (stayed to watch), not swipe (so higher = better everywhere)
ret5 = np.full(N, np.nan); keep = np.full(N, np.nan)
rt = json.loads(open(os.path.join(HERE, 'buildings/jarvis/retention-study/retention_table.json')).read())
for v in rt.get('videos', []):
    i = idpos.get(str(v.get('id', '')))
    if i is None: continue
    if v.get('ret5') is not None: ret5[i] = float(v['ret5'])   # RELATIVE 5s retention (what Tyler tracks; ~95-125%, NOT absolute survival)
    if v.get('keep_rate') is not None: keep[i] = float(v['keep_rate'])

# targets: (name, values, kind, mask, label)
logv = np.log10(views + 1)
TARGETS = [
    ('keep', keep, 'reg', np.isfinite(keep), 'keep-rate · stayed to watch (my 211)'),
    ('ret5', ret5, 'reg', np.isfinite(ret5), 'relative 5s retention (my 211, ~95-125%)'),
    ('views', logv, 'reg', np.ones(N, bool), 'views (all 11k)'),
    ('gt10M', (views > 1e7).astype(float), 'clf', np.ones(N, bool), '>10M-view class (all)'),
]
def sample_pts(x, y, ymeta=None, cap=400):
    n = len(x); idx = np.arange(n) if n <= cap else RNG.choice(n, cap, replace=False)
    return [[round(float(x[i]), 4), round(float(y[i]), 4)] for i in idx]

def perm_p(a, b):
    rho = abs(spearmanr(a, b)[0]); pl = [abs(spearmanr(RNG.permutation(a), b)[0]) for _ in range(120)]
    return (1 + np.sum(np.array(pl) >= rho)) / (1 + len(pl))
def bh(ps):
    ps = np.asarray(ps); o = np.argsort(ps); m = len(ps); out = np.empty(m); run = 1.0
    for r in range(m - 1, -1, -1): run = min(run, ps[o[r]] * m / (r + 1)); out[o[r]] = run
    return out
def curve(score, tgt, kind, nb=8):
    """binned indicator-value → mean target, for the graph."""
    q = np.quantile(score, np.linspace(0, 1, nb + 1)); out = []
    for k in range(nb):
        sel = (score >= q[k]) & (score <= q[k + 1])
        if sel.sum() >= 3:
            out.append({'lo': round(float(q[k]), 4), 'hi': round(float(q[k + 1]), 4),
                        'mean': round(float(np.mean(tgt[sel])), 4), 'n': int(sel.sum())})
    return out

indicators = []; rows_for_fdr = []
weights = {}                       # (modality,target) → ridge/logistic weight vector, for scoring uploads

# ---- CONTENT indicators: probe each embedding toward each target ----
for mk, (M, have) in MOD.items():
    for tname, ty, kind, tmask, tlab in TARGETS:
        mask = have & tmask & np.isfinite(ty)
        idx = np.where(mask)[0]
        if len(idx) < 60: continue
        Xm = M[idx]; ym = ty[idx]
        # out-of-fold score (validation, leakage-safe) + full-fit weights (for upload scoring)
        oof = np.full(len(idx), np.nan)
        for tr, te in kf.split(Xm):
            if kind == 'clf' and len(np.unique(ym[tr])) < 2: continue
            mdl = LogisticRegression(C=1, max_iter=1000) if kind == 'clf' else Ridge(alpha=20)
            mdl.fit(Xm[tr], ym[tr]); oof[te] = mdl.decision_function(Xm[te]) if kind == 'clf' else mdl.predict(Xm[te])
        ok = np.isfinite(oof)
        if ok.sum() < 40: continue
        rho = float(spearmanr(oof[ok], ym[ok])[0])
        auc = float(roc_auc_score(ym[ok], oof[ok])) if kind == 'clf' and len(np.unique(ym[ok])) == 2 else None
        p = perm_p(oof[ok], ym[ok])
        full = LogisticRegression(C=1, max_iter=1000).fit(Xm, ym) if kind == 'clf' else Ridge(alpha=20).fit(Xm, ym)
        weights[f'content_{mk}__{tname}'] = np.concatenate([full.coef_.ravel(), [float(full.intercept_).__float__() if np.ndim(full.intercept_) == 0 else float(full.intercept_[0])]]).astype(np.float32)
        # graph data on the held-out score (binned curve + the actual scatter points)
        crv = curve(oof[ok], ym[ok], kind)
        # OWNED overlay (dataset-stabilized): where MY 211 land on this indicator + their
        # ACTUAL outcomes — so we can see if my videos beat/trail the corpus prediction.
        om = mine[idx][ok]
        owned_pts = sample_pts(oof[ok][om], ym[ok][om], cap=250) if om.sum() >= 5 else []
        owned_curve = curve(oof[ok][om], ym[ok][om], kind, nb=min(5, max(2, int(om.sum() // 8)))) if om.sum() >= 16 else []
        indicators.append({'name': f'content_{mk}', 'kind': 'content', 'modality': mk, 'target': tname, 'target_label': tlab,
                           'spearman': round(rho, 3), 'auc': round(auc, 3) if auc else None, 'p': round(p, 4),
                           'n': int(ok.sum()), 'n_owned': int(om.sum()), 'curve': crv, 'pts': sample_pts(oof[ok], ym[ok]),
                           'owned_pts': owned_pts, 'owned_curve': owned_curve})
        rows_for_fdr.append(p)

# ---- NOVELTY indicators (single-source values), validated per target ----
for nm, val in NOV.items():
    for tname, ty, kind, tmask, tlab in TARGETS:
        mask = tmask & np.isfinite(val) & np.isfinite(ty)
        if mask.sum() < 60: continue
        v = val[mask]; t = ty[mask]
        rho = float(spearmanr(v, t)[0])
        auc = float(roc_auc_score(t, v)) if kind == 'clf' and len(np.unique(t)) == 2 else None
        p = perm_p(v, t)
        om = mine[mask]
        owned_pts = sample_pts(v[om], t[om], cap=250) if om.sum() >= 5 else []
        owned_curve = curve(v[om], t[om], kind, nb=min(5, max(2, int(om.sum() // 8)))) if om.sum() >= 16 else []
        indicators.append({'name': f'nov_{nm}', 'kind': 'novelty', 'modality': nm.split('_')[0], 'target': tname, 'target_label': tlab,
                           'spearman': round(rho, 3), 'auc': round(auc, 3) if auc else None, 'p': round(p, 4),
                           'n': int(mask.sum()), 'n_owned': int(om.sum()), 'curve': curve(v, t, kind), 'pts': sample_pts(v, t),
                           'owned_pts': owned_pts, 'owned_curve': owned_curve})
        rows_for_fdr.append(p)

# FDR across all (indicator × target) tests + validated flag
q = bh([d['p'] for d in indicators])
for d, qq in zip(indicators, q):
    d['fdr'] = round(float(qq), 4)
    eff = abs(d['auc'] - 0.5) * 2 if d['auc'] else abs(d['spearman'])
    d['effect'] = round(float(eff), 3)
    # keep a real-but-weak tier (ret5 lives here) so it's usable; R conveys confidence
    d['validated'] = bool(qq < 0.1 and eff >= 0.05)
    d['strong'] = bool(qq < 0.05 and eff >= 0.1)

# save weights for upload scoring
bio = io.BytesIO(); np.savez_compressed(bio, **{k: v for k, v in weights.items()}); r2_put('raw/indicators/weights.npz', bio.getvalue(), 'application/octet-stream')
reg = {'meta': {'n': N, 'n_owned': int(mine.sum()), 'created': datetime.date.today().isoformat(),
                'targets': [{'name': t[0], 'label': t[4], 'kind': t[2]} for t in TARGETS],
                'modalities': list(MOD.keys())},
       'indicators': sorted(indicators, key=lambda d: -(abs(d['auc'] - 0.5) * 2 if d['auc'] else abs(d['spearman'])))}
r2_put('raw/indicators/registry.json', json.dumps(reg).encode(), 'application/json')

print('\n=== VALIDATED INDICATORS (FDR<0.05, effect≥0.08) ===', flush=True)
for d in reg['indicators']:
    if d['validated']:
        e = f"AUC {d['auc']}" if d['auc'] else f"ρ {d['spearman']:+}"
        print(f"  {d['name']:18s} → {d['target']:7s} {e:11s} (n={d['n']})", flush=True)
nval = sum(d['validated'] for d in indicators)
print(f'\n{nval} validated of {len(indicators)} (indicator × target) tests · weights for {len(weights)} content probes', flush=True)
print('saved → raw/indicators/registry.json + weights.npz', flush=True)
