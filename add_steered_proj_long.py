#!/usr/bin/env python3
"""
PER-ACCOUNT steered projections for each raw-long/<channel>/map.json — the LONG-FORM sibling of
add_steered_proj.py. Same idea, long-form metrics:
  ctr__<acct>        — rotate the thumbnail/title embedding space toward that account's CLICK-THROUGH RATE
  ret30__<acct>      — toward 30-SECOND RETENTION
  realviews__<acct>  — "realistic views": the long-form predict equation (ctr + ret30 + duration → views,
                       duration-deconfounded, calibrated to real views), projected onto the embedding.
Base keys ctr/ret30/realviews alias Main (tyler). An 'owner' array (account id per point) is written so
the UI can highlight the selected account's own videos. Global views/outlier/rawviews stay single.

Run: python3 add_steered_proj_long.py   (after raw_embed_long.py has embedded the owned videos)
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
def pls_dir(X, y):                          # PLS1 unit direction that best predicts y
    m = PLSRegression(1).fit(X, y); w = np.asarray(m.coef_).reshape(-1); return w / (np.linalg.norm(w) + 1e-9)
CTRVIEWS_ALPHA = 0.3                         # 30% CTR-direction + 70% views-direction (from exp_ctr_views_long.py)

MIN_OWNED = 12   # long-form accounts have far fewer videos than the shorts 211 — lower the bar

# ───── every account's long-form metrics (id → ctr / ret30 / retention / dur / views) ─────
chans = json.loads((r2_get('longform/channels.json') or b'{"channels":[]}')).get('channels', [])
if not any(c.get('id') == 'tyler' for c in chans):
    chans = [{'id': 'tyler', 'name': 'Main'}] + chans
ACC = {}
for c in chans:
    t = json.loads(r2_get(f"longform/ret_{c['id']}.json") or b'{"videos":[]}')
    CT = {}; R30 = {}; RE = {}; D = {}; Vw = {}
    for v in t.get('videos', []):
        vid = str(v.get('id') or '')
        if not vid: continue
        if v.get('ctr') is not None: CT[vid] = float(v['ctr'])
        if v.get('ret30') is not None: R30[vid] = float(v['ret30'])
        if v.get('avg_retention') is not None: RE[vid] = float(v['avg_retention'])
        if v.get('duration_s') is not None: D[vid] = float(v['duration_s'])
        if v.get('views') is not None: Vw[vid] = float(v['views'])
    ACC[c['id']] = {'ctr': CT, 'ret30': R30, 'ret': RE, 'dur': D, 'views': Vw, 'name': c.get('name', c['id'])}
    print(f"  account {c['id']} ({c.get('name')}): ctr={len(CT)} ret30={len(R30)}", flush=True)
# pooled 'all'
aCT = {}; aR30 = {}; aRE = {}; aD = {}; aVw = {}
for cid, a in ACC.items():
    aCT.update(a['ctr']); aR30.update(a['ret30']); aRE.update(a['ret']); aD.update(a['dur']); aVw.update(a['views'])
ACC['all'] = {'ctr': aCT, 'ret30': aR30, 'ret': aRE, 'dur': aD, 'views': aVw, 'name': 'All pooled'}
owner_of = {}
for cid, a in ACC.items():
    if cid == 'all': continue
    for vid in a['ctr']: owner_of[vid] = cid
ACCTS = list(ACC.keys())
print(f"accounts: {ACCTS}", flush=True)

# ───── long-form realistic-views equation (ctr + ret30 + logdur → views, duration-deconfounded) ─────
def _slope(y, x):
    mx = x.mean(); sxx = ((x - mx) ** 2).sum()
    return (((x - mx) * (y - y.mean())).sum() / sxx) if sxx else 0.0
def _resid(y, x):
    return y - (y.mean() + _slope(y, x) * (x - x.mean()))
def fit_view_eq(CT, R30, D, Vw):
    ids = [k for k in CT if k in R30 and k in D and k in Vw]
    if len(ids) < MIN_OWNED: return None
    ctr = np.array([CT[k] for k in ids]); r30 = np.array([R30[k] for k in ids])
    ld = np.log10(np.array([D[k] for k in ids]) + 1); lv = np.log10(np.array([Vw[k] for k in ids]) + 1)
    wc = _slope(_resid(lv, ld), _resid(ctr, ld))      # CTR effect, duration partialled out
    w30 = _slope(_resid(lv, ld), _resid(r30, ld))     # 30s-retention effect, duration partialled out
    wd = _slope(lv, ld)                               # duration's own marginal effect
    score = wc * ctr + w30 * r30 + wd * ld
    beta = _slope(lv, score); alpha = lv.mean() - beta * score.mean()
    return {'wc': float(wc), 'w30': float(w30), 'wd': float(wd), 'alpha': float(alpha), 'beta': float(beta),
            'n': len(ids), 'durmed': float(np.median([D[k] for k in ids]))}
def eq_logviews(eq, ctr, r30, ld):
    return eq['alpha'] + eq['beta'] * (eq['wc'] * ctr + eq['w30'] * r30 + eq['wd'] * ld)

VIEW_EQ = {a: fit_view_eq(ACC[a]['ctr'], ACC[a]['ret30'], ACC[a]['dur'], ACC[a]['views']) for a in ACCTS}
for a in ACCTS:
    e = VIEW_EQ[a]
    if e: print(f"  view-eq[{a}]: logV = {e['wc']:.4f}·ctr + {e['w30']:.4f}·ret30 + {e['wd']:.3f}·logdur scaled β={e['beta']:.3f} (n={e['n']})", flush=True)

db = json.loads((r2_get('longform/db.json') or b'{"videos":{}}'))
LIBDUR = {str(v.get('videoId', '')): float(v['durationSec']) for v in db.get('videos', {}).values() if v.get('durationSec')}
for a in ACCTS:
    LIBDUR.update({k: ACC[a]['dur'][k] for k in ACC[a]['dur']})
DUR_MED = float(np.median(list(ACC['tyler']['dur'].values()) or [300.0]))
kf = KFold(5, shuffle=True, random_state=0)

def steer_metric(Vm, mids, lab):
    oi = [i for i, vid in enumerate(mids) if vid in lab]
    if len(oi) < MIN_OWNED: return None, len(oi)
    Xo = Vm[oi]; yo = np.array([lab[mids[i]] for i in oi])
    oof = np.full(len(oi), np.nan)
    for tr, te in kf.split(Xo):
        oof[te] = PLSRegression(1).fit(Xo[tr], yo[tr]).predict(Xo[te]).ravel()
    cv = abs(float(spearmanr(oof, yo)[0])) if len(oi) >= 8 else 0.0
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
    buf = r2_get(f'raw-long/{ch}/embeddings.npz')
    if not buf:
        print(f'{ch}: no embeddings yet — skip', flush=True); continue
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; V = norm(np.asarray(z['vecs'], np.float32))
    mp = json.loads(r2_get(f'raw-long/{ch}/map.json'))
    mids = [str(x) for x in mp['id']]; epos = {v: i for i, v in enumerate(ids)}
    Vm = np.zeros((len(mids), V.shape[1]), np.float32)
    for i, vid in enumerate(mids):
        j = epos.get(vid)
        if j is not None: Vm[i] = V[j]
    mp['owner'] = [owner_of.get(vid, '') for vid in mids]
    lv_all = np.log10(np.array(mp.get('views', []), float) + 1)
    w_views_ch = pls_dir(Vm, lv_all) if len(lv_all) == len(mids) and float(np.nanstd(lv_all)) > 1e-9 else None

    for acct in ACCTS:
        CTR, RET30 = ACC[acct]['ctr'], ACC[acct]['ret30']
        for tgt, lab in [('ctr', CTR), ('ret30', RET30)]:
            pj, nown = steer_metric(Vm, mids, lab)
            if pj is None:
                print(f'  {ch}/{tgt}__{acct}: too few owned ({nown})', flush=True); continue
            mp['proj'][f'{tgt}__{acct}'] = pj
            print(f'  {ch}/{tgt}__{acct}: held-out align {pj["cv"]:.3f} (owned {nown})', flush=True)
        eq = VIEW_EQ[acct]
        if eq and f'ctr__{acct}' in mp['proj'] and f'ret30__{acct}' in mp['proj']:
            ce = np.array(mp['proj'][f'ctr__{acct}']['est'], float)
            r3 = np.array(mp['proj'][f'ret30__{acct}']['est'], float)
            ld = np.array([np.log10(LIBDUR.get(vid, eq['durmed']) + 1) for vid in mids])
            rvlog = eq_logviews(eq, ce, r3, ld); rv = np.power(10.0, rvlog)
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
        # JOINT CTR+views axis (from exp_ctr_views_long.py) — a blend aligned with BOTH at once
        own = [i for i, vid in enumerate(mids) if vid in ACC[acct]['ctr']]
        if w_views_ch is not None and len(own) >= MIN_OWNED:
            cy = np.array([ACC[acct]['ctr'][mids[i]] for i in own])
            w_ctr = pls_dir(Vm[own], cy)
            blend = CTRVIEWS_ALPHA * w_ctr + (1 - CTRVIEWS_ALPHA) * w_views_ch; blend /= (np.linalg.norm(blend) + 1e-9)
            x = Vm @ blend
            Xc = Vm - Vm.mean(0); pc = np.linalg.svd(Xc, full_matrices=False)[2][0]
            po = pc - (pc @ blend) * blend; po /= (np.linalg.norm(po) + 1e-9); y = Xc @ po
            cvv = abs(float(spearmanr(x, lv_all)[0])); coc = abs(float(spearmanr(x[own], cy)[0]))
            ce = mp['proj'].get(f'ctr__{acct}', {}).get('est')   # per-point CTR estimate (reused from the ctr__ axis) so the trend bands can show CTR too
            mp['proj'][f'ctrviews__{acct}'] = {'x': grid(x), 'y': grid(y), 'cv': round(cvv, 3), 'co': round(coc, 3), 'joint': True, 'ctr_est': ce}
            print(f'  {ch}/ctrviews__{acct}: views r={cvv:.3f} · CTR r={coc:.3f} (owned {len(own)})', flush=True)
    for b in ['ctr', 'ret30', 'realviews', 'ctrviews']:
        if f'{b}__tyler' in mp['proj']: mp['proj'][b] = mp['proj'][f'{b}__tyler']

    # global library-driven rawviews (raw scale) so a corpus-wide views axis exists
    vmap = np.array(mp.get('views', []), float)
    if len(vmap) == len(mids):
        vmap[~np.isfinite(vmap)] = 0.0
        oofv = np.full(len(mids), np.nan)
        for tr, te in kf.split(Vm): oofv[te] = PLSRegression(1).fit(Vm[tr], vmap[tr]).predict(Vm[te]).ravel()
        cvv = abs(float(spearmanr(oofv, vmap)[0])); ch10 = abs(float(spearmanr(oofv, (vmap > 1e7).astype(float))[0]))
        XYv = PLSRegression(2).fit(Vm, vmap).transform(Vm)
        if spearmanr(XYv[:, 0], vmap)[0] < 0: XYv[:, 0] = -XYv[:, 0]
        mp['proj']['rawviews'] = {'x': grid(XYv[:, 0]), 'y': grid(XYv[:, 1]), 'cv': round(cvv, 3), 'co': round(ch10, 3)}

    r2_put(f'raw-long/{ch}/map.json', json.dumps(mp).encode(), 'application/json')
    print(f'  saved raw-long/{ch}/map.json  (proj keys: {len(mp["proj"])})', flush=True)

for a in ACCTS:
    e = VIEW_EQ[a]
    if e: STEER[f'VIEWEQ_{a}'] = np.array([e['wc'], e['w30'], e['wd'], e['alpha'], e['beta'], e['durmed']], np.float32)
bio = io.BytesIO(); np.savez_compressed(bio, **STEER); r2_put('raw-long/steer_models.npz', bio.getvalue(), 'application/octet-stream')
print('done — per-account ctr/ret30/realviews projections + owner tags added to raw-long/*', flush=True)
