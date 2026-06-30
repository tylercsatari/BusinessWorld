#!/usr/bin/env python3
"""
PER-ACCOUNT steered projections for each raw/<channel>/map.json.

keep-rate / 5s-retention / realistic-views are ENTIRELY channel-driven, so they are fit PER ACCOUNT
(each account's owned videos rotate the shared embedding space toward that metric, then ALL ~11k+
videos are projected the same way). Stored under suffixed keys: keep__<acct> / ret5__<acct> /
realviews__<acct>, plus a pooled '__all' (every account's videos together). The base keys
keep/ret5/realviews alias Main (tyler) for back-compat. Global, library-driven projections
(views / outlier / rawviews / >10M) stay SINGLE — adding a few hundred owned videos can't skew 11k.

realviews uses the SAME duration-deconfounded additive model as the ⑤ Predict tab (olsFit in
jarvis-retention.js): each input's effect = its slope on log-views with duration partialled out, not
held against the others; the sum is calibrated to real views. So the realistic-views axis a hook
lands on matches the predictor exactly, per account.

An 'owner' array (account id per map point, '' = library-only) is written so the UI can highlight a
selected account's own videos. Run: python3 add_steered_proj.py
"""
import os, io, json
import numpy as np, boto3
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import KFold
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
def grid(a):
    a = np.asarray(a, float); q1, q9 = np.nanpercentile(a, 1), np.nanpercentile(a, 99)
    return (np.clip((a - q1) / ((q9 - q1) or 1), 0, 1) * 1000).round().astype(int).tolist()

# ───── load EVERY account's retention (id → keep / ret5 / dur / views) ─────
def load_table(c):
    if c.get('owner') or c['id'] == 'tyler':
        return json.loads(open(os.path.join(HERE, 'buildings/jarvis/retention-study/retention_table.json')).read())
    return json.loads(r2_get(f"retention/{c['id']}.json") or b'{"videos":[]}')
chans = json.loads((r2_get('retention/channels.json') or b'{"channels":[]}')).get('channels', [])
if not any(c.get('id') == 'tyler' for c in chans):
    chans = [{'id': 'tyler', 'owner': True, 'name': 'Main'}] + chans
ACC = {}                       # acct_id → {keep,ret5,dur,views,name}
for c in chans:
    t = load_table(c); K = {}; R = {}; D = {}; Vw = {}
    for v in t.get('videos', []):
        vid = str(v.get('id') or v.get('videoId') or '')
        if not vid: continue
        if v.get('keep_rate') is not None: K[vid] = float(v['keep_rate'])
        if v.get('ret5') is not None: R[vid] = float(v['ret5'])
        if v.get('duration_s') is not None: D[vid] = float(v['duration_s'])
        if v.get('views') is not None: Vw[vid] = float(v['views'])
    ACC[c['id']] = {'keep': K, 'ret5': R, 'dur': D, 'views': Vw, 'name': c.get('name', c['id'])}
    print(f"  account {c['id']} ({c.get('name')}): keep={len(K)} ret5={len(R)}", flush=True)
# pooled 'all' = union of every account
aK = {}; aR = {}; aD = {}; aVw = {}
for cid, a in ACC.items():
    aK.update(a['keep']); aR.update(a['ret5']); aD.update(a['dur']); aVw.update(a['views'])
ACC['all'] = {'keep': aK, 'ret5': aR, 'dur': aD, 'views': aVw, 'name': 'All pooled'}
owner_of = {}                  # vid → account id (single-account membership; library vids absent)
for cid, a in ACC.items():
    if cid == 'all': continue
    for vid in a['keep']: owner_of[vid] = cid
ACCTS = list(ACC.keys())       # tyler, …, all
print(f"accounts: {ACCTS}", flush=True)

# ───── deconfounded view equation — IDENTICAL to olsFit() in jarvis-retention.js ─────
def _slope(y, x):              # OLS slope of y on x (centered)
    mx = x.mean(); sxx = ((x - mx) ** 2).sum()
    return (((x - mx) * (y - y.mean())).sum() / sxx) if sxx else 0.0
def _resid(y, x):              # residual of y after removing its linear fit on x
    return y - (y.mean() + _slope(y, x) * (x - x.mean()))
def fit_view_eq(K, R, D, Vw):
    ids = [k for k in K if k in R and k in D and k in Vw]
    if len(ids) < 10: return None
    keep = np.array([K[k] for k in ids]); ret = np.array([R[k] for k in ids])
    ld = np.log10(np.array([D[k] for k in ids]) + 1); lv = np.log10(np.array([Vw[k] for k in ids]) + 1)
    wk = _slope(_resid(lv, ld), _resid(keep, ld))     # keep effect, duration partialled out (not held vs ret)
    wr = _slope(_resid(lv, ld), _resid(ret, ld))      # ret5 effect, duration partialled out
    wd = _slope(lv, ld)                               # duration's own marginal effect
    score = wk * keep + wr * ret + wd * ld
    beta = _slope(lv, score); alpha = lv.mean() - beta * score.mean()
    return {'wk': float(wk), 'wr': float(wr), 'wd': float(wd), 'alpha': float(alpha), 'beta': float(beta), 'n': len(ids),
            'durmed': float(np.median([D[k] for k in ids]))}
def eq_logviews(eq, keep, ret, ld):
    return eq['alpha'] + eq['beta'] * (eq['wk'] * keep + eq['wr'] * ret + eq['wd'] * ld)

VIEW_EQ = {a: fit_view_eq(ACC[a]['keep'], ACC[a]['ret5'], ACC[a]['dur'], ACC[a]['views']) for a in ACCTS}
for a in ACCTS:
    e = VIEW_EQ[a]
    if e: print(f"  view-eq[{a}]: logV = {e['wk']:.4f}·keep + {e['wr']:.4f}·ret5 + {e['wd']:.3f}·logdur scaled β={e['beta']:.3f} (n={e['n']})", flush=True)

db = json.loads((r2_get('library/db.json') or b'{"videos":{}}'))
LIBDUR = {str(v.get('videoId', '')): float(v['durationSec']) for v in db.get('videos', {}).values() if v.get('durationSec')}
for a in ACCTS:                # owned durations are authoritative for owned videos
    LIBDUR.update({k: ACC[a]['dur'][k] for k in ACC[a]['dur']})
DUR_MED = float(np.median(list(ACC['tyler']['dur'].values()) or [30.0]))

kf = KFold(5, shuffle=True, random_state=0)

def steer_metric(Vm, mids, lab):
    """Fit a keep/ret5 axis on the owned videos that have `lab`, project ALL, quantile-map to real %.
    Returns proj dict or None if too few owned. Same maths as the original per-target block."""
    oi = [i for i, vid in enumerate(mids) if vid in lab]
    if len(oi) < 40: return None, len(oi)
    Xo = Vm[oi]; yo = np.array([lab[mids[i]] for i in oi])
    oof = np.full(len(oi), np.nan)
    for tr, te in kf.split(Xo):
        oof[te] = PLSRegression(1).fit(Xo[tr], yo[tr]).predict(Xo[te]).ravel()
    cv = abs(float(spearmanr(oof, yo)[0]))
    pls = PLSRegression(2).fit(Xo, yo)
    XY = pls.transform(Vm)
    if spearmanr(XY[oi, 0], yo)[0] < 0: XY[:, 0] = -XY[:, 0]
    pred_all = pls.predict(Vm).ravel()
    ranks = np.empty(len(pred_all)); ranks[np.argsort(pred_all)] = np.linspace(0, 1, len(pred_all))
    yo_sorted = np.sort(yo)
    est = yo_sorted[np.clip((ranks * (len(yo_sorted) - 1)).round().astype(int), 0, len(yo_sorted) - 1)]
    actual = [None if mids[i] not in lab else round(float(lab[mids[i]]), 2) for i in range(len(mids))]
    return {'x': grid(XY[:, 0]), 'y': grid(XY[:, 1]), 'cv': round(cv, 3), 'co': 0.0, 'owned_only_label': True,
            'est': [round(float(x), 2) for x in est], 'actual': actual}, len(oi)

STEER = {}
for ch in ['visual', 'text', 'together']:
    buf = r2_get(f'raw/{ch}/embeddings.npz')
    if not buf:
        print(f'{ch}: no embeddings yet — skip', flush=True); continue
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; V = norm(np.asarray(z['vecs'], np.float32))
    mp = json.loads(r2_get(f'raw/{ch}/map.json'))
    mids = [str(x) for x in mp['id']]; epos = {v: i for i, v in enumerate(ids)}
    Vm = np.zeros((len(mids), V.shape[1]), np.float32)
    for i, vid in enumerate(mids):
        j = epos.get(vid)
        if j is not None: Vm[i] = V[j]
    mp['owner'] = [owner_of.get(vid, '') for vid in mids]   # which account owns each point ('' = library)

    # ── PER-ACCOUNT keep / ret5 / realviews ──
    for acct in ACCTS:
        KEEP, RET5 = ACC[acct]['keep'], ACC[acct]['ret5']
        for tgt, lab in [('keep', KEEP), ('ret5', RET5)]:
            pj, nown = steer_metric(Vm, mids, lab)
            if pj is None:
                print(f'  {ch}/{tgt}__{acct}: too few owned ({nown})', flush=True); continue
            mp['proj'][f'{tgt}__{acct}'] = pj
            print(f'  {ch}/{tgt}__{acct}: held-out align {pj["cv"]:.3f} (owned {nown})', flush=True)
        eq = VIEW_EQ[acct]
        if eq and f'keep__{acct}' in mp['proj'] and f'ret5__{acct}' in mp['proj']:
            ke = np.array(mp['proj'][f'keep__{acct}']['est'], float)
            re = np.array(mp['proj'][f'ret5__{acct}']['est'], float)
            ld = np.array([np.log10(LIBDUR.get(vid, eq['durmed']) + 1) for vid in mids])
            rvlog = eq_logviews(eq, ke, re, ld); rv = np.power(10.0, rvlog)
            mask = np.abs(Vm).sum(1) > 1e-6
            Vmk = Vm[mask]; rvk = rvlog[mask]
            oofr = np.full(int(mask.sum()), np.nan)
            for tr, te in kf.split(Vmk): oofr[te] = PLSRegression(1).fit(Vmk[tr], rvk[tr]).predict(Vmk[te]).ravel()
            cvr = abs(float(spearmanr(oofr, rvk)[0]))
            XYr = PLSRegression(2).fit(Vmk, rvk).transform(Vm)
            if spearmanr(XYr[mask, 0], rvk)[0] < 0: XYr[:, 0] = -XYr[:, 0]
            mp['proj'][f'realviews__{acct}'] = {'x': grid(XYr[:, 0]), 'y': grid(XYr[:, 1]), 'cv': round(cvr, 3), 'co': 0.0,
                                                'est': [round(float(x)) for x in rv], 'predscope': True}
            print(f'  {ch}/realviews__{acct}: held-out r={cvr:.3f} · median {np.median(rv):,.0f}', flush=True)
    # base keys alias Main so the existing UI keeps working if not account-aware
    for b in ['keep', 'ret5', 'realviews']:
        if f'{b}__tyler' in mp['proj']: mp['proj'][b] = mp['proj'][f'{b}__tyler']

    # ── GLOBAL library-driven metrics (single, unchanged): steer models for views/outlier/>10M ──
    vv = np.array(mp.get('views', []), float)
    ov = np.array([np.nan if x is None else x for x in (mp.get('outlier') or [])], float)
    allm = []
    if len(vv) == len(mids):
        allm.append(('views', np.log10(np.where(vv > 0, vv, np.nan) + 1), 'logcount'))
        allm.append(('gt10M', (vv > 1e7).astype(float), 'binary'))
    if len(ov) == len(mids):
        allm.append(('outlier', np.log10(np.where(ov > 0, ov, np.nan) + 1), 'logx'))
    for tgt, yv, kind in allm:
        ok = np.isfinite(yv) & (np.abs(Vm).sum(1) > 0)
        if ok.sum() < 200: continue
        Xo = Vm[ok]; yo = yv[ok]
        pls = PLSRegression(1).fit(Xo, yo); pred_ok = pls.predict(Xo).ravel()
        coef = np.asarray(pls.coef_).reshape(-1)
        if coef.shape[0] != Vm.shape[1]: coef = np.asarray(pls.coef_).T.reshape(-1)
        intercept = float(np.mean(pred_ok - Xo @ coef)); order = np.argsort(pred_ok)
        STEER[f'{ch}_{tgt}_coef'] = coef.astype(np.float32); STEER[f'{ch}_{tgt}_int'] = np.float32(intercept)
        STEER[f'{ch}_{tgt}_psort'] = pred_ok[order].astype(np.float32); STEER[f'{ch}_{tgt}_kind'] = np.array(kind)
        if kind == 'binary': STEER[f'{ch}_{tgt}_ybypred'] = yo[order].astype(np.float32)
        else: STEER[f'{ch}_{tgt}_ysort'] = np.sort(yo).astype(np.float32)
    # global keep/ret5 steer models (Main) so an UPLOAD still scores identically in the Experiment tab
    for tgt, lab in [('keep', ACC['tyler']['keep']), ('ret5', ACC['tyler']['ret5'])]:
        oi = [i for i, vid in enumerate(mids) if vid in lab]
        if len(oi) < 40: continue
        Xo = Vm[oi]; yo = np.array([lab[mids[i]] for i in oi]); pls = PLSRegression(2).fit(Xo, yo)
        pred_all = pls.predict(Vm).ravel(); coef = np.asarray(pls.coef_).reshape(-1)
        if coef.shape[0] != Vm.shape[1]: coef = np.asarray(pls.coef_).T.reshape(-1)
        intercept = float(np.mean(pred_all - Vm @ coef))
        STEER[f'{ch}_{tgt}_coef'] = coef.astype(np.float32); STEER[f'{ch}_{tgt}_int'] = np.float32(intercept)
        STEER[f'{ch}_{tgt}_psort'] = np.sort(pred_all).astype(np.float32); STEER[f'{ch}_{tgt}_ysort'] = np.sort(yo).astype(np.float32)
        STEER[f'{ch}_{tgt}_kind'] = np.array('pct')
    # RAW-VIEWS projection (library scale, raw not log)
    vmap = np.array(mp.get('views', []), float)
    if len(vmap) == len(mids):
        vmap[~np.isfinite(vmap)] = 0.0
        oofv = np.full(len(mids), np.nan)
        for tr, te in kf.split(Vm): oofv[te] = PLSRegression(1).fit(Vm[tr], vmap[tr]).predict(Vm[te]).ravel()
        cvv = abs(float(spearmanr(oofv, vmap)[0])); ch10 = abs(float(spearmanr(oofv, (vmap > 1e7).astype(float))[0]))
        XYv = PLSRegression(2).fit(Vm, vmap).transform(Vm)
        if spearmanr(XYv[:, 0], vmap)[0] < 0: XYv[:, 0] = -XYv[:, 0]
        mp['proj']['rawviews'] = {'x': grid(XYv[:, 0]), 'y': grid(XYv[:, 1]), 'cv': round(cvv, 3), 'co': round(ch10, 3)}

    r2_put(f'raw/{ch}/map.json', json.dumps(mp).encode(), 'application/json')
    print(f'  saved raw/{ch}/map.json  (proj keys: {len(mp["proj"])})', flush=True)

# steer_models.npz: per-account view equations (for upload realviews) + Main keep/ret5 (above)
for a in ACCTS:
    e = VIEW_EQ[a]
    if e: STEER[f'VIEWEQ_{a}'] = np.array([e['wk'], e['wr'], e['wd'], e['alpha'], e['beta'], e['durmed']], np.float32)
STEER['PSCOPE'] = (np.array([VIEW_EQ['tyler']['wk'] * VIEW_EQ['tyler']['beta'], VIEW_EQ['tyler']['wr'] * VIEW_EQ['tyler']['beta'],
                             VIEW_EQ['tyler']['wd'] * VIEW_EQ['tyler']['beta'], VIEW_EQ['tyler']['alpha']], np.float32)
                   if VIEW_EQ.get('tyler') else np.zeros(4, np.float32))   # back-compat [c_keep,c_ret5,c_logdur,intercept]
STEER['PSCOPE_durmed'] = np.float32(DUR_MED)
bio = io.BytesIO(); np.savez_compressed(bio, **STEER); r2_put('raw/steer_models.npz', bio.getvalue(), 'application/octet-stream')
print('done — per-account keep/ret5/realviews projections + owner tags added; steer_models.npz saved', flush=True)
