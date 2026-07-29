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
import os, io, json, hashlib, platform
from datetime import datetime, timezone
import numpy as np, boto3, sklearn, scipy
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import KFold
from scipy.stats import spearmanr
from plot_artifact import SHORT_PROJECTIONS, build_plot_artifact, encode_plot_artifact

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
def r2_delete(k):
    try: s3.delete_object(Bucket=BUCKET, Key=k)
    except Exception: pass
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def sha256_bytes(data): return hashlib.sha256(data).hexdigest()
def population_snapshot(values):
    rows = [str(value) for value in values if str(value)]
    unique = sorted(set(rows))
    return {
        'rowCount': len(rows),
        'uniqueVideoCount': len(unique),
        'duplicateVideoCount': len(rows) - len(unique),
        'videoIdSha256': sha256_bytes('\n'.join(unique).encode()),
        'orderedVideoIdSha256': sha256_bytes(
            json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()
        ),
    }
def grid(a):
    a = np.asarray(a, float); q1, q9 = np.nanpercentile(a, 1), np.nanpercentile(a, 99)
    return (np.clip((a - q1) / ((q9 - q1) or 1), 0, 1) * 1000).round().astype(int).tolist()

# ───── load EVERY account's retention (id → keep / ret5 / dur / views) ─────
SOURCE_REVISIONS = {}
def load_table(c):
    if c.get('owner') or c['id'] == 'tyler':
        source = 'buildings/jarvis/retention-study/retention_table.json'
        raw = open(os.path.join(HERE, source), 'rb').read()
    else:
        source = f"retention/{c['id']}.json"
        raw = r2_get(source) or b'{"videos":[]}'
    SOURCE_REVISIONS[c['id']] = {'source': source, 'sha256': sha256_bytes(raw)}
    return json.loads(raw)
channels_bytes = r2_get('retention/channels.json') or b'{"channels":[]}'
SOURCE_REVISIONS['retention_channels'] = {
    'source': 'retention/channels.json',
    'sha256': sha256_bytes(channels_bytes),
}
chans = json.loads(channels_bytes).get('channels', [])
if not any(c.get('id') == 'tyler' for c in chans):
    chans = [{'id': 'tyler', 'owner': True, 'name': 'Main'}] + chans
ACC = {}                       # acct_id → {keep,ret5,dur,views,name}
for c in chans:
    t = load_table(c); K = {}; R = {}; D = {}; Vw = {}; Sw = {}
    for v in t.get('videos', []):
        vid = str(v.get('id') or v.get('videoId') or '')
        if not vid: continue
        def finite_value(key):
            try:
                value = float(v[key])
                return value if np.isfinite(value) else None
            except (KeyError, TypeError, ValueError):
                return None
        keep_value = finite_value('keep_rate')
        ret5_value = finite_value('ret5')
        duration_value = finite_value('duration_s')
        views_value = finite_value('views')
        swiped_value = finite_value('swiped')
        if keep_value is not None: K[vid] = keep_value
        if ret5_value is not None: R[vid] = ret5_value
        if duration_value is not None: D[vid] = duration_value
        if views_value is not None: Vw[vid] = views_value
        if swiped_value is not None: Sw[vid] = swiped_value
        elif keep_value is not None: Sw[vid] = 100.0 - keep_value
    ACC[c['id']] = {'keep': K, 'ret5': R, 'dur': D, 'views': Vw, 'swipe': Sw, 'name': c.get('name', c['id'])}
    print(f"  account {c['id']} ({c.get('name')}): keep={len(K)} ret5={len(R)}", flush=True)
# pooled 'all' = union of every account
aK = {}; aR = {}; aD = {}; aVw = {}; aSw = {}
for cid, a in ACC.items():
    aK.update(a['keep']); aR.update(a['ret5']); aD.update(a['dur']); aVw.update(a['views']); aSw.update(a['swipe'])
ACC['all'] = {'keep': aK, 'ret5': aR, 'dur': aD, 'views': aVw, 'swipe': aSw, 'name': 'All pooled'}
SOURCE_REVISIONS['all'] = {
    'source': 'deterministic union of account retention tables',
    'members': {
        account_id: SOURCE_REVISIONS.get(account_id)
        for account_id in sorted(ACC)
        if account_id != 'all'
    },
}
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
VIEW_EQ_POPULATIONS = {
    a: population_snapshot([
        video_id for video_id in ACC[a]['keep']
        if video_id in ACC[a]['ret5'] and video_id in ACC[a]['dur'] and video_id in ACC[a]['views']
    ])
    for a in ACCTS
}
for a in ACCTS:
    e = VIEW_EQ[a]
    if e: print(f"  view-eq[{a}]: logV = {e['wk']:.4f}·keep + {e['wr']:.4f}·ret5 + {e['wd']:.3f}·logdur scaled β={e['beta']:.3f} (n={e['n']})", flush=True)

library_bytes = r2_get('library/db.json') or b'{"videos":{}}'
SOURCE_REVISIONS['public_library'] = {
    'source': 'library/db.json',
    'sha256': sha256_bytes(library_bytes),
}
db = json.loads(library_bytes)
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
LINEAGE = {
    'schemaVersion': 1,
    'producer': 'add_steered_proj.py',
    'producerSourceSha256': sha256_bytes(open(__file__, 'rb').read()),
    'generatedAt': datetime.now(timezone.utc).isoformat(),
    'embeddingModel': 'gemini-embedding-2',
    'embeddingDimensions': 1536,
    'runtime': {
        'python': platform.python_version(),
        'numpy': np.__version__,
        'scikitLearn': sklearn.__version__,
        'scipy': scipy.__version__,
    },
    'sourceRevisions': SOURCE_REVISIONS,
    'viewEquationFitPopulations': VIEW_EQ_POPULATIONS,
    'modalities': {},
}
USE_PENDING = os.environ.get('RAW_STEER_USE_PENDING') == '1'
PENDING_KEYS = []
for ch in ['visual', 'text', 'together']:
    buf = r2_get(f'raw/{ch}/embeddings.npz')
    if not buf:
        print(f'{ch}: no embeddings yet — skip', flush=True); continue
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; V = norm(np.asarray(z['vecs'], np.float32))
    map_key = f'raw/{ch}/map.pending.json' if USE_PENDING else f'raw/{ch}/map.json'
    map_bytes = r2_get(map_key)
    if not map_bytes:
        raise RuntimeError(f'{map_key} is missing; refusing to replace the last complete map')
    mp = json.loads(map_bytes)
    mids = [str(x) for x in mp['id']]; epos = {v: i for i, v in enumerate(ids)}
    modality_lineage = {
        'embeddingStore': {
            'source': f'raw/{ch}/embeddings.npz',
            'artifactSha256': sha256_bytes(buf),
            **population_snapshot(ids),
        },
        'mapStore': {
            'source': map_key,
            'artifactSha256': sha256_bytes(map_bytes),
            **population_snapshot(mids),
        },
        'axes': {},
        'mapProjections': {},
    }
    LINEAGE['modalities'][ch] = modality_lineage
    Vm = np.zeros((len(mids), V.shape[1]), np.float32)
    for i, vid in enumerate(mids):
        j = epos.get(vid)
        if j is not None: Vm[i] = V[j]
    mp['owner'] = [owner_of.get(vid, '') for vid in mids]   # which account owns each point ('' = library)

    # ── PER-ACCOUNT keep / ret5 / realviews ──
    for acct in ACCTS:
        KEEP, RET5, SWIPE = ACC[acct]['keep'], ACC[acct]['ret5'], ACC[acct]['swipe']
        for tgt, lab in [('keep', KEEP), ('ret5', RET5), ('swipe', SWIPE)]:
            pj, nown = steer_metric(Vm, mids, lab)
            if pj is None:
                print(f'  {ch}/{tgt}__{acct}: too few owned ({nown})', flush=True); continue
            mp['proj'][f'{tgt}__{acct}'] = pj
            fit_ids = [video_id for video_id in mids if video_id in lab]
            modality_lineage['mapProjections'][f'{tgt}__{acct}'] = {
                'algorithm': 'PLSRegression(n_components=2)',
                'target': tgt,
                'fitPopulation': population_snapshot(fit_ids),
                'projectionPopulation': population_snapshot(mids),
                'labelSourceRevision': SOURCE_REVISIONS.get(acct),
            }
            print(f'  {ch}/{tgt}__{acct}: held-out align {pj["cv"]:.3f} (owned {nown})', flush=True)
        eq = VIEW_EQ[acct]
        if eq and f'keep__{acct}' in mp['proj'] and f'ret5__{acct}' in mp['proj']:
            ke = np.array(mp['proj'][f'keep__{acct}']['est'], float)
            re = np.array(mp['proj'][f'ret5__{acct}']['est'], float)
            ld = np.array([np.log10(LIBDUR.get(vid, eq['durmed']) + 1) for vid in mids])
            rvlog = eq_logviews(eq, ke, re, ld); rv = np.maximum(0.0, np.power(10.0, rvlog) - 1)
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
    for b in ['keep', 'ret5', 'realviews', 'swipe']:
        if f'{b}__tyler' in mp['proj']: mp['proj'][b] = mp['proj'][f'{b}__tyler']

    # ── GLOBAL library-driven metrics (single, unchanged): steer models for views/outlier/>10M ──
    vv = np.array(mp.get('views', []), float)
    ov = np.array([np.nan if x is None else x for x in (mp.get('outlier') or [])], float)
    allm = []
    if len(vv) == len(mids):
        allm.append(('views', np.log10(np.where(vv > 0, vv, np.nan) + 1), 'logcount'))
        allm.append(('gt10M', np.where(np.isfinite(vv), (vv > 1e7).astype(float), np.nan), 'binary'))
    if len(ov) == len(mids):
        allm.append(('outlier', np.log10(np.where(ov > 0, ov, np.nan) + 1), 'logx'))
    for tgt, yv, kind in allm:
        ok = np.isfinite(yv) & (np.abs(Vm).sum(1) > 0)
        if ok.sum() < 200: continue
        Xo = Vm[ok]; yo = yv[ok]
        fit_ids = [mids[i] for i in np.flatnonzero(ok)]
        pls = PLSRegression(1).fit(Xo, yo); pred_ok = pls.predict(Xo).ravel()
        coef = np.asarray(pls.coef_).reshape(-1)
        if coef.shape[0] != Vm.shape[1]: coef = np.asarray(pls.coef_).T.reshape(-1)
        intercept = float(np.mean(pred_ok - Xo @ coef)); order = np.argsort(pred_ok)
        STEER[f'{ch}_{tgt}_coef'] = coef.astype(np.float32); STEER[f'{ch}_{tgt}_int'] = np.float32(intercept)
        STEER[f'{ch}_{tgt}_psort'] = pred_ok[order].astype(np.float32); STEER[f'{ch}_{tgt}_kind'] = np.array(kind)
        if kind == 'binary': STEER[f'{ch}_{tgt}_ybypred'] = yo[order].astype(np.float32)
        else: STEER[f'{ch}_{tgt}_ysort'] = np.sort(yo).astype(np.float32)
        modality_lineage['axes'][tgt] = {
            'algorithm': 'PLSRegression(n_components=1)',
            'target': 'views > 10000000' if kind == 'binary' else (
                'log10(views + 1)' if tgt == 'views' else 'log10(outlier + 1)'
            ),
            'fitPopulation': population_snapshot(fit_ids),
            'projectionRankPopulation': population_snapshot(fit_ids),
            'outcomeCalibrationPopulation': population_snapshot(fit_ids),
            'sourceOutcomeRevision': {
                'source': map_key,
                'sha256': sha256_bytes(map_bytes),
                'field': 'views' if tgt in ('views', 'gt10M') else 'outlier',
            },
            'kind': kind,
        }
    # global keep/ret5 steer models (Main) so an UPLOAD still scores identically in the Experiment tab
    for tgt, lab in [('keep', ACC['tyler']['keep']), ('ret5', ACC['tyler']['ret5'])]:
        oi = [i for i, vid in enumerate(mids) if vid in lab]
        if len(oi) < 40: continue
        fit_ids = [mids[i] for i in oi]
        Xo = Vm[oi]; yo = np.array([lab[mids[i]] for i in oi]); pls = PLSRegression(2).fit(Xo, yo)
        pred_all = pls.predict(Vm).ravel(); coef = np.asarray(pls.coef_).reshape(-1)
        if coef.shape[0] != Vm.shape[1]: coef = np.asarray(pls.coef_).T.reshape(-1)
        intercept = float(np.mean(pred_all - Vm @ coef))
        STEER[f'{ch}_{tgt}_coef'] = coef.astype(np.float32); STEER[f'{ch}_{tgt}_int'] = np.float32(intercept)
        STEER[f'{ch}_{tgt}_psort'] = np.sort(pred_all).astype(np.float32); STEER[f'{ch}_{tgt}_ysort'] = np.sort(yo).astype(np.float32)
        STEER[f'{ch}_{tgt}_kind'] = np.array('pct')
        modality_lineage['axes'][tgt] = {
            'algorithm': 'PLSRegression(n_components=2)',
            'target': tgt,
            'fitPopulation': population_snapshot(fit_ids),
            'projectionRankPopulation': population_snapshot(mids),
            'outcomeCalibrationPopulation': population_snapshot(fit_ids),
            'sourceOutcomeRevision': SOURCE_REVISIONS.get('tyler'),
            'kind': 'pct',
        }
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

    plot = encode_plot_artifact(build_plot_artifact(mp, ch, SHORT_PROJECTIONS))
    final_map_bytes = json.dumps(mp, separators=(',', ':'), allow_nan=False).encode()
    final_map_sha256 = sha256_bytes(final_map_bytes)
    plot_sha256 = sha256_bytes(plot)
    map_archive_key = f'raw/{ch}/maps/by-sha256/{final_map_sha256}.json'
    plot_archive_key = f'raw/{ch}/plots/by-sha256/{plot_sha256}.json'
    modality_lineage['publishedMap'] = {
        'canonicalKey': f'raw/{ch}/map.json',
        'archiveKey': map_archive_key,
        'artifactSha256': final_map_sha256,
        **population_snapshot(mids),
    }
    modality_lineage['publishedPlot'] = {
        'canonicalKey': f'raw/{ch}/plot.json',
        'archiveKey': plot_archive_key,
        'artifactSha256': plot_sha256,
        'rowCount': len(mids),
    }
    map_manifest_bytes = json.dumps({
        'schemaVersion': 1,
        'producer': 'add_steered_proj.py',
        'producerSourceSha256': LINEAGE['producerSourceSha256'],
        'generatedAt': LINEAGE['generatedAt'],
        'modality': ch,
        'embeddingModel': LINEAGE['embeddingModel'],
        'embeddingDimensions': LINEAGE['embeddingDimensions'],
        'runtime': LINEAGE['runtime'],
        **modality_lineage,
    }, sort_keys=True, separators=(',', ':')).encode()
    r2_put(f'raw/{ch}/plot.json', plot, 'application/json')
    r2_put(plot_archive_key, plot, 'application/json')
    r2_put(f'raw/{ch}/map.json', final_map_bytes, 'application/json')
    r2_put(map_archive_key, final_map_bytes, 'application/json')
    r2_put(f'raw/{ch}/map.manifest.json', map_manifest_bytes, 'application/json')
    r2_put(f'raw/{ch}/maps/by-sha256/{final_map_sha256}.manifest.json', map_manifest_bytes, 'application/json')
    if USE_PENDING: PENDING_KEYS.append(f'raw/{ch}/map.pending.json')
    print(f'  saved raw/{ch}/map.json + plot.json ({len(plot):,} bytes; proj keys: {len(mp["proj"])})', flush=True)

# steer_models.npz: per-account view equations (for upload realviews) + Main keep/ret5 (above)
for a in ACCTS:
    e = VIEW_EQ[a]
    if e: STEER[f'VIEWEQ_{a}'] = np.array([e['wk'], e['wr'], e['wd'], e['alpha'], e['beta'], e['durmed']], np.float32)
STEER['PSCOPE'] = (np.array([VIEW_EQ['tyler']['wk'] * VIEW_EQ['tyler']['beta'], VIEW_EQ['tyler']['wr'] * VIEW_EQ['tyler']['beta'],
                             VIEW_EQ['tyler']['wd'] * VIEW_EQ['tyler']['beta'], VIEW_EQ['tyler']['alpha']], np.float32)
                   if VIEW_EQ.get('tyler') else np.zeros(4, np.float32))   # back-compat [c_keep,c_ret5,c_logdur,intercept]
STEER['PSCOPE_durmed'] = np.float32(DUR_MED)
lineage_bytes = json.dumps(LINEAGE, sort_keys=True, separators=(',', ':')).encode()
lineage_sha256 = sha256_bytes(lineage_bytes)
STEER['LINEAGE_JSON'] = np.array(lineage_bytes.decode())
STEER['LINEAGE_SHA256'] = np.array(lineage_sha256)
bio = io.BytesIO()
np.savez_compressed(bio, **STEER)
artifact_bytes = bio.getvalue()
artifact_sha256 = sha256_bytes(artifact_bytes)
archive_key = f'raw/steer_models/by-sha256/{artifact_sha256}.npz'
manifest = {
    **LINEAGE,
    'lineageSha256': lineage_sha256,
    'artifactSha256': artifact_sha256,
    'canonicalKey': 'raw/steer_models.npz',
    'archiveKey': archive_key,
}
manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
r2_put('raw/steer_models.npz', artifact_bytes, 'application/octet-stream')
r2_put(archive_key, artifact_bytes, 'application/octet-stream')
r2_put('raw/steer_manifest.json', manifest_bytes, 'application/json')
r2_put(f'raw/steer_models/by-sha256/{artifact_sha256}.manifest.json', manifest_bytes, 'application/json')
# Preserve every staged input if any channel or scorer-model upload fails, so a
# retry can complete the same publication set.
for pending_key in PENDING_KEYS: r2_delete(pending_key)
print('done — per-account keep/ret5/realviews projections + owner tags added; steer_models.npz saved', flush=True)
