#!/usr/bin/env python3
"""
Add KEEP-RATE and 5s-RETENTION steered projections to each raw/<channel>/map.json.
The owned 211 (the only videos with retention) act as a REFERENCE to rotate the
embedding space so an axis aligns with keep-rate / retention — then ALL ~11k are
projected the same way (exactly like the views / outlier / >10M projections).
So the keep cluster becomes meaningful for the whole corpus, not just a highlight.

Run: python3 add_steered_proj.py   (updates the 3 map.json in place)
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

# owned retention
rt = json.loads(open(os.path.join(HERE, 'buildings/jarvis/retention-study/retention_table.json')).read())
KEEP = {}; RET5 = {}; DURO = {}; VIEWSO = {}
for v in rt.get('videos', []):
    if v.get('keep_rate') is not None: KEEP[str(v['id'])] = float(v['keep_rate'])
    if v.get('ret5') is not None: RET5[str(v['id'])] = float(v['ret5'])   # RELATIVE 5s retention (Tyler's tracked metric, ~95-125%)
    if v.get('duration_s') is not None: DURO[str(v['id'])] = float(v['duration_s'])
    if v.get('views') is not None: VIEWSO[str(v['id'])] = float(v['views'])
print(f'owned retention: keep={len(KEEP)} ret5={len(RET5)}', flush=True)

# PREDICT-SCOPE: the 211's OWN retention→views relationship (their real view scale, not the
# library's inflated one). log10(views) ~ keep + ret5 + log_dur. We later feed the steered
# keep/ret5 ESTIMATES (from the embedding) through this to get realistic, channel-scaled views.
ps_ids = [k for k in KEEP if k in RET5 and k in DURO and k in VIEWSO]
Xs = np.array([[KEEP[k], RET5[k], np.log10(DURO[k] + 1)] for k in ps_ids])
ys = np.array([np.log10(VIEWSO[k] + 1) for k in ps_ids])
PS = np.linalg.lstsq(np.c_[Xs, np.ones(len(Xs))], ys, rcond=None)[0]   # [c_keep, c_ret5, c_logdur, intercept]
DUR_MED = float(np.median(list(DURO.values())))
print(f'predict-scope on {len(ps_ids)} owned: logV = {PS[0]:.3f}·keep + {PS[1]:.3f}·ret5 + {PS[2]:.3f}·logdur + {PS[3]:.2f} (dur median {DUR_MED:.0f}s)', flush=True)
db = json.loads((r2_get('library/db.json') or b'{"videos":{}}'))
LIBDUR = {str(v.get('videoId', '')): float(v['durationSec']) for v in db.get('videos', {}).values() if v.get('durationSec')}

kf = KFold(5, shuffle=True, random_state=0)
STEER = {}   # per-(channel,target) linear predictor + quantile map, so an UPLOAD can be scored identically
for ch in ['visual', 'text', 'together']:
    z = np.load(io.BytesIO(r2_get(f'raw/{ch}/embeddings.npz')), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; V = norm(np.asarray(z['vecs'], np.float32))
    mp = json.loads(r2_get(f'raw/{ch}/map.json'))
    mids = [str(x) for x in mp['id']]; mpos = {v: i for i, v in enumerate(mids)}
    # align embeddings to MAP order (map defines the point order the UI draws)
    epos = {v: i for i, v in enumerate(ids)}
    Vm = np.zeros((len(mids), V.shape[1]), np.float32)
    for i, vid in enumerate(mids):
        j = epos.get(vid)
        if j is not None: Vm[i] = V[j]
    for tgt, lab in [('keep', KEEP), ('ret5', RET5)]:
        oi = [i for i, vid in enumerate(mids) if vid in lab]
        if len(oi) < 40:
            print(f'  {ch}/{tgt}: too few owned ({len(oi)})', flush=True); continue
        Xo = Vm[oi]; yo = np.array([lab[mids[i]] for i in oi])
        # held-out alignment of the learned direction with the target (honest cv)
        oof = np.full(len(oi), np.nan)
        for tr, te in kf.split(Xo):
            oof[te] = PLSRegression(1).fit(Xo[tr], yo[tr]).predict(Xo[te]).ravel()
        cv = abs(float(spearmanr(oof, yo)[0]))
        # fit on ALL owned, project EVERY video (the steered 2D layout)
        pls = PLSRegression(2).fit(Xo, yo)
        XY = pls.transform(Vm)                       # (n,2): comp1 ≈ keep axis
        if spearmanr(XY[oi, 0], yo)[0] < 0: XY[:, 0] = -XY[:, 0]   # orient so higher x = higher target
        # EXTRAPOLATE the metric to EVERY video: rank by the model's prediction, then
        # quantile-map onto the owned (actual) distribution so corpus estimates spread
        # above AND below your videos, in real metric units (0-100 organised by KEEP).
        pred_all = pls.predict(Vm).ravel()
        ranks = np.empty(len(pred_all)); ranks[np.argsort(pred_all)] = np.linspace(0, 1, len(pred_all))
        yo_sorted = np.sort(yo)
        est = yo_sorted[np.clip((ranks * (len(yo_sorted) - 1)).round().astype(int), 0, len(yo_sorted) - 1)]
        actual = np.full(len(mids), np.nan)
        for i, vid in enumerate(mids):
            if vid in lab: actual[i] = lab[vid]
        mp['proj'][tgt] = {'x': grid(XY[:, 0]), 'y': grid(XY[:, 1]), 'cv': round(cv, 3), 'co': 0.0, 'owned_only_label': True,
                           'est': [round(float(x), 2) for x in est],
                           'actual': [None if x != x else round(float(x), 2) for x in actual]}
        # serialise the linear predictor so an upload gets the SAME extrapolated estimate.
        # pls.predict(X) == X @ coef + intercept; recover both empirically (version-proof).
        coef = np.asarray(pls.coef_).reshape(-1)
        if coef.shape[0] != Vm.shape[1]: coef = np.asarray(pls.coef_).T.reshape(-1)
        intercept = float(np.mean(pred_all - Vm @ coef))
        err = float(np.max(np.abs((Vm @ coef + intercept) - pred_all)))
        STEER[f'{ch}_{tgt}_coef'] = coef.astype(np.float32)
        STEER[f'{ch}_{tgt}_int'] = np.float32(intercept)
        STEER[f'{ch}_{tgt}_psort'] = np.sort(pred_all).astype(np.float32)   # corpus prediction distribution
        STEER[f'{ch}_{tgt}_ysort'] = yo_sorted.astype(np.float32)           # owned actual distribution (quantile target)
        STEER[f'{ch}_{tgt}_kind'] = np.array('pct')                         # est read directly as a % (keep / 5s-retention)
        print(f'  {ch}/{tgt}: held-out align {cv:.3f} (trained on {len(oi)} owned, projected {len(mids)}) · lin-recon err {err:.2e}', flush=True)
    # ── steer models for the ALL-VIDEO metrics too (views / outlier / >10M-class) so an upload
    #    gets the SAME number the map/graph would give it — used by the Experiment grid AND the
    #    graph's hook marker. One global predictor per (channel × metric); no duplicated maths. ──
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
        pls = PLSRegression(1).fit(Xo, yo)
        pred_ok = pls.predict(Xo).ravel()
        coef = np.asarray(pls.coef_).reshape(-1)
        if coef.shape[0] != Vm.shape[1]: coef = np.asarray(pls.coef_).T.reshape(-1)
        intercept = float(np.mean(pred_ok - Xo @ coef))
        order = np.argsort(pred_ok)
        STEER[f'{ch}_{tgt}_coef'] = coef.astype(np.float32)
        STEER[f'{ch}_{tgt}_int'] = np.float32(intercept)
        STEER[f'{ch}_{tgt}_psort'] = pred_ok[order].astype(np.float32)
        STEER[f'{ch}_{tgt}_kind'] = np.array(kind)
        if kind == 'binary':
            STEER[f'{ch}_{tgt}_ybypred'] = yo[order].astype(np.float32)     # >10M indicator ordered by prediction → local rate
        else:
            STEER[f'{ch}_{tgt}_ysort'] = np.sort(yo).astype(np.float32)     # quantile-map target (log units; UI un-logs)
        hr = abs(float(spearmanr(pred_ok, yo)[0]))
        print(f'  {ch}/{tgt}: steer model saved (n={int(ok.sum())}, in-sample r={hr:.3f}, kind={kind})', flush=True)
    # RAW-VIEWS projection (Tyler's experiment): orient toward raw views, NOT log, so the
    # log vs raw arrangement can be compared side by side. Held-out r(>10M) showed log wins
    # (0.307 vs 0.288) — this lets you SEE why. All 11k have views, so it's fully supervised.
    vmap = np.array(mp.get('views', []), float)
    if len(vmap) == len(mids):
        vmap[~np.isfinite(vmap)] = 0.0
        oofv = np.full(len(mids), np.nan)
        for tr, te in kf.split(Vm): oofv[te] = PLSRegression(1).fit(Vm[tr], vmap[tr]).predict(Vm[te]).ravel()
        cvv = abs(float(spearmanr(oofv, vmap)[0]))
        ch10 = abs(float(spearmanr(oofv, (vmap > 1e7).astype(float))[0]))
        XYv = PLSRegression(2).fit(Vm, vmap).transform(Vm)
        if spearmanr(XYv[:, 0], vmap)[0] < 0: XYv[:, 0] = -XYv[:, 0]
        mp['proj']['rawviews'] = {'x': grid(XYv[:, 0]), 'y': grid(XYv[:, 1]), 'cv': round(cvv, 3), 'co': round(ch10, 3)}
        print(f'  {ch}/rawviews: held-out r(self) {cvv:.3f} r(>10M) {ch10:.3f}', flush=True)
    # REALISTIC VIEWS (predict-scope): feed each video's STEERED keep/ret5 estimate + its real
    # duration through the 211's retention→views model → views on YOUR channel's scale, not the
    # library's. Reuses the views 2D layout; est is the transformed (realistic) view count.
    if 'keep' in mp['proj'] and 'ret5' in mp['proj'] and 'views' in mp['proj']:
        ke = np.array(mp['proj']['keep']['est'], float)
        re = np.array(mp['proj']['ret5']['est'], float)
        ld = np.array([np.log10(LIBDUR.get(vid, DUR_MED) + 1) for vid in mids])
        rv = np.power(10.0, PS[0] * ke + PS[1] * re + PS[2] * ld + PS[3])
        mp['proj']['realviews'] = {'x': mp['proj']['views']['x'], 'y': mp['proj']['views']['y'],
                                   'cv': mp['proj']['views'].get('cv', 0), 'co': 0.0,
                                   'est': [round(float(x)) for x in rv], 'predscope': True}
        print(f'  {ch}/realviews: predict-scope applied → median {np.median(rv):,.0f} (vs raw library median {np.median(vmap[vmap>0]):,.0f})', flush=True)
    r2_put(f'raw/{ch}/map.json', json.dumps(mp).encode(), 'application/json')
    print(f'  saved raw/{ch}/map.json', flush=True)
STEER['PSCOPE'] = PS.astype(np.float32)              # [c_keep, c_ret5, c_logdur, intercept] — retention→views on Tyler's scale
STEER['PSCOPE_durmed'] = np.float32(DUR_MED)         # fallback duration for an upload with no known length
bio = io.BytesIO(); np.savez_compressed(bio, **STEER)
r2_put('raw/steer_models.npz', bio.getvalue(), 'application/octet-stream')
print('done — keep/ret5 + rawviews projections added; raw/steer_models.npz saved for upload scoring', flush=True)
