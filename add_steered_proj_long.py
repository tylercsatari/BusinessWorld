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
import os, io, json, hashlib, platform
import numpy as np, boto3, scipy, sklearn
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import KFold
from scipy.stats import spearmanr
from plot_artifact import LONG_PROJECTIONS, build_plot_artifact, encode_plot_artifact
from project_environment import env_value

HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    return env_value(k, HERE)
BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
def r2_get(k):
    try: return s3.get_object(Bucket=BUCKET, Key=k)['Body'].read()
    except Exception: return None
def _etag(value): return str(value or '').strip().strip('"') or None
def r2_head(k):
    try:
        h = s3.head_object(Bucket=BUCKET, Key=k)
        return {
            'key': k,
            'etag': _etag(h.get('ETag')),
            'version_id': str(h.get('VersionId') or '') or None,
            'content_length': int(h['ContentLength']) if h.get('ContentLength') is not None else None,
            'metadata': dict(h.get('Metadata') or {}),
        }
    except Exception:
        return {'key': k, 'etag': None, 'version_id': None, 'content_length': None, 'metadata': {}}
def r2_put(k, d, ct, metadata=None):
    result = s3.put_object(
        Bucket=BUCKET,
        Key=k,
        Body=d,
        ContentType=ct,
        Metadata=metadata or {},
    )
    return {
        'key': k,
        'etag': _etag(result.get('ETag')),
        'version_id': str(result.get('VersionId') or '') or None,
        'content_length': len(d),
        'metadata': dict(metadata or {}),
    }
def r2_delete(k):
    try: s3.delete_object(Bucket=BUCKET, Key=k)
    except Exception: pass
def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf8')
def digest(data): return hashlib.sha256(data).hexdigest()
def id_population(values):
    ids = [str(value) for value in values]; unique = set(ids)
    return {
        'row_count': len(ids),
        'unique_video_id_count': len(unique),
        'duplicate_video_id_count': len(ids) - len(unique),
        'video_id_sha256': digest('\n'.join(sorted(unique)).encode('utf8')),
        'ordered_video_id_sha256': digest(canonical_bytes(ids)),
    }
def put_immutable(key, data, content_type):
    expected = key.rsplit('/', 1)[-1].split('.', 1)[0]
    actual = digest(data)
    if expected != actual:
        raise RuntimeError(f'content-addressed key mismatch for {key}: expected {expected}, got {actual}')
    existing = r2_head(key)
    if existing.get('etag'):
        recorded = (existing.get('metadata') or {}).get('sha256')
        if recorded and recorded != actual:
            raise RuntimeError(f'immutable object metadata mismatch for {key}')
        if existing.get('content_length') not in (None, len(data)):
            raise RuntimeError(f'immutable object length mismatch for {key}')
        if not recorded:
            existing_bytes = r2_get(key)
            if existing_bytes is None or digest(existing_bytes) != actual:
                raise RuntimeError(f'immutable object content mismatch for {key}')
        return existing
    return r2_put(key, data, content_type, {'sha256': actual, 'immutable': 'true'})
def read_immutable_source(key, immutable_prefix, fallback=None):
    before = r2_head(key)
    data = r2_get(key)
    if data is None:
        return fallback, {
            'mutable_key': key,
            'available': False,
            'mutable_etag': before.get('etag'),
            'mutable_version_id': before.get('version_id'),
            'content_length': before.get('content_length'),
            'sha256': None,
            'immutable_key': None,
            'immutable_etag': None,
        }
    after = r2_head(key)
    if before.get('etag') and after.get('etag') and before['etag'] != after['etag']:
        raise RuntimeError(f'{key} changed while the generation was reading it')
    head = after if after.get('etag') else before
    sha256 = digest(data)
    suffix = key.rsplit('.', 1)[-1].lower()
    extension = 'json' if suffix == 'json' else 'bin'
    content_type = 'application/json' if extension == 'json' else 'application/octet-stream'
    immutable_key = f'{immutable_prefix}/{sha256}.{extension}'
    immutable_revision = put_immutable(immutable_key, data, content_type)
    return data, {
        'mutable_key': key,
        'available': True,
        'mutable_etag': head.get('etag'),
        'mutable_version_id': head.get('version_id'),
        'content_length': len(data),
        'sha256': sha256,
        'immutable_key': immutable_key,
        'immutable_etag': immutable_revision.get('etag'),
    }
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def grid(a):
    a = np.asarray(a, float); q1, q9 = np.nanpercentile(a, 1), np.nanpercentile(a, 99)
    return (np.clip((a - q1) / ((q9 - q1) or 1), 0, 1) * 1000).round().astype(int).tolist()
def pls_dir(X, y):                          # PLS1 unit direction that best predicts y
    m = PLSRegression(1).fit(X, y); w = np.asarray(m.coef_).reshape(-1); return w / (np.linalg.norm(w) + 1e-9)
CTRVIEWS_ALPHA = 0.3                         # 30% CTR-direction + 70% views-direction (from exp_ctr_views_long.py)
PROVENANCE_SCHEMA_VERSION = 2
ALGORITHM_GENERATION = 'long-map-steering-v2'
try: GENERATOR_SOURCE_SHA256 = digest(open(__file__, 'rb').read())
except Exception: GENERATOR_SOURCE_SHA256 = None
RUNTIME_REVISION = {
    'python': platform.python_version(),
    'numpy': np.__version__,
    'scikit_learn': sklearn.__version__,
    'scipy': scipy.__version__,
    'generator_source_sha256': GENERATOR_SOURCE_SHA256,
}

MIN_OWNED = 12   # long-form accounts have far fewer videos than the shorts 211 — lower the bar

# ───── every account's long-form metrics (id → ctr / ret30 / retention / dur / views) ─────
channels_bytes, CHANNELS_REVISION = read_immutable_source(
    'longform/channels.json',
    'longform/source-snapshots/channels/by-sha256',
    fallback=b'{"channels":[]}',
)
chans = json.loads(channels_bytes or b'{"channels":[]}').get('channels', [])
if not any(c.get('id') == 'tyler' for c in chans):
    chans = [{'id': 'tyler', 'name': 'Main'}] + chans
ACC = {}
LABEL_SNAPSHOT_REVISIONS = {}
for c in chans:
    account_id = str(c['id'])
    label_bytes, label_revision = read_immutable_source(
        f'longform/ret_{account_id}.json',
        f'longform/source-snapshots/private-labels/{account_id}/by-sha256',
        fallback=b'{"videos":[]}',
    )
    LABEL_SNAPSHOT_REVISIONS[account_id] = label_revision
    t = json.loads(label_bytes or b'{"videos":[]}')
    CT = {}; R30 = {}; RE = {}; D = {}; Vw = {}
    for v in t.get('videos', []):
        vid = str(v.get('id') or '')
        if not vid: continue
        def finite_value(key):
            try:
                value = float(v[key])
                return value if np.isfinite(value) else None
            except (KeyError, TypeError, ValueError):
                return None
        ctr_value = finite_value('ctr')
        ret30_value = finite_value('ret30')
        retention_value = finite_value('avg_retention')
        duration_value = finite_value('duration_s')
        views_value = finite_value('views')
        if ctr_value is not None: CT[vid] = ctr_value
        if ret30_value is not None: R30[vid] = ret30_value
        if retention_value is not None: RE[vid] = retention_value
        if duration_value is not None: D[vid] = duration_value
        if views_value is not None: Vw[vid] = views_value
    ACC[account_id] = {'ctr': CT, 'ret30': R30, 'ret': RE, 'dur': D, 'views': Vw, 'name': c.get('name', account_id)}
    print(f"  account {account_id} ({c.get('name')}): ctr={len(CT)} ret30={len(R30)}", flush=True)
# pooled 'all'
aCT = {}; aR30 = {}; aRE = {}; aD = {}; aVw = {}
for cid, a in ACC.items():
    aCT.update(a['ctr']); aR30.update(a['ret30']); aRE.update(a['ret']); aD.update(a['dur']); aVw.update(a['views'])
ACC['all'] = {'ctr': aCT, 'ret30': aR30, 'ret': aRE, 'dur': aD, 'views': aVw, 'name': 'All pooled'}
pooled_revision_members = {
    account: revision
    for account, revision in sorted(LABEL_SNAPSHOT_REVISIONS.items())
}
LABEL_SNAPSHOT_REVISIONS['all'] = {
    'kind': 'composite_private_label_snapshot',
    'members': pooled_revision_members,
    'sha256': digest(canonical_bytes(pooled_revision_members)),
}
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
            'n': len(ids), 'durmed': float(np.median([D[k] for k in ids])),
            'fit_population': id_population(ids)}
def eq_logviews(eq, ctr, r30, ld):
    return eq['alpha'] + eq['beta'] * (eq['wc'] * ctr + eq['w30'] * r30 + eq['wd'] * ld)

VIEW_EQ = {a: fit_view_eq(ACC[a]['ctr'], ACC[a]['ret30'], ACC[a]['dur'], ACC[a]['views']) for a in ACCTS}
for a in ACCTS:
    e = VIEW_EQ[a]
    if e: print(f"  view-eq[{a}]: logV = {e['wc']:.4f}·ctr + {e['w30']:.4f}·ret30 + {e['wd']:.3f}·logdur scaled β={e['beta']:.3f} (n={e['n']})", flush=True)

db_bytes, DATABASE_REVISION = read_immutable_source(
    'longform/db.json',
    'longform/source-snapshots/database/by-sha256',
    fallback=b'{"videos":{}}',
)
db = json.loads(db_bytes or b'{"videos":{}}')
LIBDUR = {str(v.get('videoId', '')): float(v['durationSec']) for v in db.get('videos', {}).values() if v.get('durationSec')}
for a in ACCTS:
    LIBDUR.update({k: ACC[a]['dur'][k] for k in ACC[a]['dur']})
DUR_MED = float(np.median(list(ACC['tyler']['dur'].values()) or [300.0]))
frozen_manifest_bytes, FROZEN_MANIFEST_REVISION = read_immutable_source(
    'longform/thumb-rl/scorer_visual.manifest.json',
    'longform/source-snapshots/frozen-ctrviews-manifests/by-sha256',
    fallback=None,
)
try:
    frozen_manifest = json.loads(frozen_manifest_bytes) if frozen_manifest_bytes else {}
except Exception:
    frozen_manifest = {}
frozen_populations = frozen_manifest.get('populations') or {}
FROZEN_VISUAL_CTRVIEWS_LINEAGE = {
    'manifest_revision': FROZEN_MANIFEST_REVISION,
    'artifact_revision': {
        'mutable_key': frozen_manifest.get('canonicalKey'),
        'sha256': frozen_manifest.get('artifactSha256'),
        'immutable_key': frozen_manifest.get('archiveKey'),
        'lineage_manifest_sha256': frozen_manifest.get('lineageSha256'),
    },
    'embedding_store_population': frozen_populations.get('embeddingStore'),
    'frozen_ctr_fit_population': frozen_populations.get('privateCtrFit'),
    'curated_views_fit_population': frozen_populations.get('curatedViewsFit'),
    'calibration_ladder_population': frozen_populations.get('calibrationLadder'),
    'source_revisions': frozen_manifest.get('sourceRevisions'),
}
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
    return {
        'x': grid(XY[:, 0]),
        'y': grid(XY[:, 1]),
        'cv': round(cv, 3),
        'co': 0.0,
        'owned_only_label': True,
        'est': [round(float(x), 2) for x in est],
        'actual': actual,
        'geometry_fit_scope': 'full_fit_descriptive_all_eligible_labels',
        'estimate_fit_scope': 'full_fit_quantile_calibrated_descriptive',
        'validation_metric_scope': '5_fold_out_of_fold_spearman_only',
        'scalar_score_use': 'forbidden',
    }, len(oi)

STEER = {}
for a in ACCTS:
    e = VIEW_EQ[a]
    if e:
        STEER[f'VIEWEQ_{a}'] = np.array(
            [e['wc'], e['w30'], e['wd'], e['alpha'], e['beta'], e['durmed']],
            np.float32,
        )
model_buffer = io.BytesIO()
np.savez_compressed(model_buffer, **STEER)
model_bytes = model_buffer.getvalue()
model_sha256 = digest(model_bytes)
model_immutable_key = f'raw-long/models/by-sha256/{model_sha256}.npz'
model_immutable_revision = put_immutable(
    model_immutable_key,
    model_bytes,
    'application/octet-stream',
)
model_artifact = {
    'mutable_key': 'raw-long/steer_models.npz',
    'sha256': model_sha256,
    'immutable_key': model_immutable_key,
    'immutable_etag': model_immutable_revision.get('etag'),
    'algorithm_generation': ALGORITHM_GENERATION,
    'generator_source_sha256': GENERATOR_SOURCE_SHA256,
}
USE_PENDING = os.environ.get('RAW_STEER_USE_PENDING') == '1'
PENDING_KEYS = []
CHANNEL_MANIFESTS = []
for ch in ['visual', 'text', 'together']:
    embedding_key = f'raw-long/{ch}/embeddings.npz'
    embedding_head = r2_head(embedding_key)
    buf = r2_get(embedding_key)
    if not buf:
        print(f'{ch}: no embeddings yet — skip', flush=True); continue
    embedding_after = r2_head(embedding_key)
    if embedding_head.get('etag') and embedding_after.get('etag') and embedding_head['etag'] != embedding_after['etag']:
        raise RuntimeError(f'{embedding_key} changed while the generation was reading it')
    embedding_head = embedding_after if embedding_after.get('etag') else embedding_head
    embedding_sha256 = digest(buf)
    embedding_immutable_key = f'raw-long/{ch}/embeddings/by-sha256/{embedding_sha256}.npz'
    embedding_immutable_revision = put_immutable(
        embedding_immutable_key,
        buf,
        'application/octet-stream',
    )
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; V = norm(np.asarray(z['vecs'], np.float32))
    map_key = f'raw-long/{ch}/map.pending.json' if USE_PENDING else f'raw-long/{ch}/map.json'
    source_map_head = r2_head(map_key)
    map_bytes = r2_get(map_key)
    if not map_bytes:
        raise RuntimeError(f'{map_key} is missing; refusing to replace the last complete map')
    source_map_after = r2_head(map_key)
    if source_map_head.get('etag') and source_map_after.get('etag') and source_map_head['etag'] != source_map_after['etag']:
        raise RuntimeError(f'{map_key} changed while the generation was reading it')
    source_map_head = source_map_after if source_map_after.get('etag') else source_map_head
    source_map_sha256 = digest(map_bytes)
    mp = json.loads(map_bytes)
    mids = [str(x) for x in mp['id']]; epos = {v: i for i, v in enumerate(ids)}
    aligned_ids = [vid for vid in mids if vid in epos]
    map_only_ids = [vid for vid in mids if vid not in epos]
    map_set = set(mids)
    embedding_only_ids = [vid for vid in ids if vid not in map_set]
    alignment_population = {
        'method': 'exact_video_id',
        'embedding_archive': id_population(ids),
        'map': id_population(mids),
        'intersection': id_population(aligned_ids),
        'map_only': id_population(map_only_ids),
        'embedding_archive_only': id_population(embedding_only_ids),
    }
    Vm = np.zeros((len(mids), V.shape[1]), np.float32)
    for i, vid in enumerate(mids):
        j = epos.get(vid)
        if j is not None: Vm[i] = V[j]
    mp['owner'] = [owner_of.get(vid, '') for vid in mids]
    public_views = np.array(mp.get('views', []), float)
    views_fit_mask = (
        np.isfinite(public_views)
        & (public_views > 0)
        & (np.abs(Vm).sum(1) > 1e-6)
    ) if len(public_views) == len(mids) else np.zeros(len(mids), dtype=bool)
    views_fit_ids = [mids[index] for index in np.flatnonzero(views_fit_mask)]
    lv_all = np.log10(np.where(public_views > 0, public_views, np.nan) + 1)
    w_views_ch = (
        pls_dir(Vm[views_fit_mask], lv_all[views_fit_mask])
        if views_fit_mask.sum() >= MIN_OWNED
        and float(np.nanstd(lv_all[views_fit_mask])) > 1e-9
        else None
    )

    for acct in ACCTS:
        CTR, RET30 = ACC[acct]['ctr'], ACC[acct]['ret30']
        for tgt, lab in [('ctr', CTR), ('ret30', RET30)]:
            pj, nown = steer_metric(Vm, mids, lab)
            if pj is None:
                print(f'  {ch}/{tgt}__{acct}: too few owned ({nown})', flush=True); continue
            mp['proj'][f'{tgt}__{acct}'] = pj
            print(f'  {ch}/{tgt}__{acct}: OOF rank validation {pj["cv"]:.3f} (owned {nown}); displayed geometry is full-fit', flush=True)
        eq = VIEW_EQ[acct]
        if eq and f'ctr__{acct}' in mp['proj'] and f'ret30__{acct}' in mp['proj']:
            ce = np.array(mp['proj'][f'ctr__{acct}']['est'], float)
            r3 = np.array(mp['proj'][f'ret30__{acct}']['est'], float)
            ld = np.array([np.log10(LIBDUR.get(vid, eq['durmed']) + 1) for vid in mids])
            rvlog = eq_logviews(eq, ce, r3, ld); rv = np.maximum(0.0, np.power(10.0, rvlog) - 1)
            mask = np.abs(Vm).sum(1) > 1e-6
            Vmk = Vm[mask]; rvk = rvlog[mask]
            oofr = np.full(int(mask.sum()), np.nan)
            for tr, te in kf.split(Vmk): oofr[te] = PLSRegression(1).fit(Vmk[tr], rvk[tr]).predict(Vmk[te]).ravel()
            cvr = abs(float(spearmanr(oofr, rvk)[0]))
            XYr = PLSRegression(2).fit(Vmk, rvk).transform(Vm)
            if spearmanr(XYr[mask, 0], rvk)[0] < 0: XYr[:, 0] = -XYr[:, 0]
            mp['proj'][f'realviews__{acct}'] = {
                'x': grid(XYr[:, 0]),
                'y': grid(XYr[:, 1]),
                'cv': round(cvr, 3),
                'co': 0.0,
                'est': [round(float(x)) for x in rv],
                'predscope': True,
                'geometry_fit_scope': 'full_fit_descriptive_all_eligible_pseudo_labels',
                'estimate_fit_scope': 'derived_from_full_fit_ctr_ret30_and_private_view_equation',
                'validation_metric_scope': '5_fold_out_of_fold_spearman_on_pseudo_label_only',
                'scalar_score_use': 'forbidden',
            }
            print(f'  {ch}/realviews__{acct}: OOF pseudo-label rank validation r={cvr:.3f} · median {np.median(rv):,.0f}; displayed geometry is full-fit', flush=True)
        # JOINT CTR+views axis (from exp_ctr_views_long.py) — a blend aligned with BOTH at once
        own = [i for i, vid in enumerate(mids) if vid in ACC[acct]['ctr']]
        if w_views_ch is not None and len(own) >= MIN_OWNED:
            cy = np.array([ACC[acct]['ctr'][mids[i]] for i in own])
            w_ctr = pls_dir(Vm[own], cy)
            blend = CTRVIEWS_ALPHA * w_ctr + (1 - CTRVIEWS_ALPHA) * w_views_ch; blend /= (np.linalg.norm(blend) + 1e-9)
            x = Vm @ blend
            Xc = Vm - Vm.mean(0); pc = np.linalg.svd(Xc, full_matrices=False)[2][0]
            po = pc - (pc @ blend) * blend; po /= (np.linalg.norm(po) + 1e-9); y = Xc @ po
            cvv = abs(float(spearmanr(x[views_fit_mask], lv_all[views_fit_mask])[0]))
            coc = abs(float(spearmanr(x[own], cy)[0]))
            ce = mp['proj'].get(f'ctr__{acct}', {}).get('est')   # per-point CTR estimate (reused from the ctr__ axis) so the trend bands can show CTR too
            mp['proj'][f'ctrviews__{acct}'] = {
                'x': grid(x),
                'y': grid(y),
                'cv': round(cvv, 3),
                'co': round(coc, 3),
                'joint': True,
                'ctr_est': ce,
                'geometry_fit_scope': 'full_fit_descriptive_private_ctr_plus_public_views',
                'validation_metric_scope': 'in_sample_rank_alignment_only',
                'scalar_score_use': 'forbidden',
            }
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
        mp['proj']['rawviews'] = {
            'x': grid(XYv[:, 0]),
            'y': grid(XYv[:, 1]),
            'cv': round(cvv, 3),
            'co': round(ch10, 3),
            'geometry_fit_scope': 'full_fit_descriptive_all_eligible_public_labels',
            'validation_metric_scope': '5_fold_out_of_fold_spearman_only',
            'scalar_score_use': 'forbidden',
        }

    projection_fit_ids = [
        mids[index]
        for index in range(len(mids))
        if float(np.abs(Vm[index]).sum()) > 1e-6
    ]
    account_metric_private_fit_populations = {}
    for account in ACCTS:
        ctr_fit_ids = [video_id for video_id in mids if video_id in ACC[account]['ctr']]
        ret30_fit_ids = [video_id for video_id in mids if video_id in ACC[account]['ret30']]
        view_equation = VIEW_EQ.get(account)
        account_metric_private_fit_populations[account] = {
            'label_snapshot_revision': LABEL_SNAPSHOT_REVISIONS.get(account),
            'metrics': {
                'ctr': {
                    'projection_key': f'ctr__{account}',
                    'published': f'ctr__{account}' in mp['proj'],
                    'fit_population': id_population(ctr_fit_ids),
                },
                'ret30': {
                    'projection_key': f'ret30__{account}',
                    'published': f'ret30__{account}' in mp['proj'],
                    'fit_population': id_population(ret30_fit_ids),
                },
                'realviews': {
                    'projection_key': f'realviews__{account}',
                    'published': f'realviews__{account}' in mp['proj'],
                    'private_view_equation_fit_population': (
                        (view_equation or {}).get('fit_population')
                    ),
                    'projection_fit_population': id_population(
                        projection_fit_ids
                        if f'realviews__{account}' in mp['proj'] else []
                    ),
                },
                'ctrviews': {
                    'projection_key': f'ctrviews__{account}',
                    'published': f'ctrviews__{account}' in mp['proj'],
                    'private_ctr_fit_population': id_population(ctr_fit_ids),
                    'views_direction_fit_population': id_population(
                        views_fit_ids if f'ctrviews__{account}' in mp['proj'] else []
                    ),
                },
            },
        }

    embedding_artifact = {
        'mutable_key': embedding_key,
        'mutable_etag': embedding_head.get('etag'),
        'mutable_version_id': embedding_head.get('version_id'),
        'content_length': len(buf),
        'sha256': embedding_sha256,
        'immutable_key': embedding_immutable_key,
        'immutable_etag': embedding_immutable_revision.get('etag'),
        'video_id_population': id_population(ids),
    }
    source_map_artifact = {
        'key': map_key,
        'etag': source_map_head.get('etag'),
        'version_id': source_map_head.get('version_id'),
        'content_length': len(map_bytes),
        'sha256': source_map_sha256,
        'video_id_population': id_population(mids),
    }
    generation_payload = {
        'algorithm_generation': ALGORITHM_GENERATION,
        'generator_source_sha256': GENERATOR_SOURCE_SHA256,
        'channel': ch,
        'embedding_archive_sha256': embedding_sha256,
        'source_map_sha256': source_map_sha256,
        'model_sha256': model_sha256,
        'video_id_alignment_sha256': digest(canonical_bytes(alignment_population)),
        'private_fit_lineage_sha256': digest(canonical_bytes(
            account_metric_private_fit_populations
        )),
        'source_database_sha256': DATABASE_REVISION.get('sha256'),
    }
    generation_id = digest(canonical_bytes(generation_payload))
    mp['_provenance'] = {
        'schema_version': PROVENANCE_SCHEMA_VERSION,
        'generation_id': generation_id,
        'algorithm_generation': {
            'id': ALGORITHM_GENERATION,
            'generator': 'add_steered_proj_long.py',
            'generator_source_sha256': GENERATOR_SOURCE_SHA256,
            'pls_components': 2,
            'validation_folds': 5,
            'random_state': 0,
            'ctrviews_alpha': CTRVIEWS_ALPHA,
            'minimum_owned_rows': MIN_OWNED,
            'grid_calibration': 'per-axis p01-p99 clipped to integer [0,1000]',
        },
        'embedding_archive': embedding_artifact,
        'source_map': source_map_artifact,
        'model_artifact': model_artifact,
        'video_id_alignment_population': alignment_population,
        'account_metric_private_fit_populations': account_metric_private_fit_populations,
        'label_snapshot_revisions': LABEL_SNAPSHOT_REVISIONS,
        'source_database_revision': DATABASE_REVISION,
        'channels_registry_revision': CHANNELS_REVISION,
        'frozen_visual_ctrviews_lineage': FROZEN_VISUAL_CTRVIEWS_LINEAGE,
        'runtime_revision': RUNTIME_REVISION,
        'manifest_key': f'raw-long/{ch}/map.manifest.json',
    }
    plot = encode_plot_artifact(build_plot_artifact(mp, ch, LONG_PROJECTIONS))
    published_map_bytes = canonical_bytes(mp)
    map_sha256 = digest(published_map_bytes)
    plot_sha256 = digest(plot)
    map_immutable_key = f'raw-long/{ch}/maps/by-sha256/{map_sha256}.json'
    plot_immutable_key = f'raw-long/{ch}/plots/by-sha256/{plot_sha256}.json'
    map_immutable_revision = put_immutable(
        map_immutable_key,
        published_map_bytes,
        'application/json',
    )
    plot_immutable_revision = put_immutable(
        plot_immutable_key,
        plot,
        'application/json',
    )
    plot_revision = r2_put(f'raw-long/{ch}/plot.json', plot, 'application/json')
    map_revision = r2_put(f'raw-long/{ch}/map.json', published_map_bytes, 'application/json')
    manifest = {
        'schema_version': PROVENANCE_SCHEMA_VERSION,
        'artifact_type': 'longquant-map-generation',
        'generation_id': generation_id,
        'algorithm_generation': mp['_provenance']['algorithm_generation'],
        'channel': ch,
        'embedding_archive': embedding_artifact,
        'source_map': source_map_artifact,
        'map_artifact': {
            'mutable_key': f'raw-long/{ch}/map.json',
            'mutable_etag': map_revision.get('etag'),
            'mutable_version_id': map_revision.get('version_id'),
            'content_length': len(published_map_bytes),
            'sha256': map_sha256,
            'immutable_key': map_immutable_key,
            'immutable_etag': map_immutable_revision.get('etag'),
        },
        'plot_artifact': {
            'mutable_key': f'raw-long/{ch}/plot.json',
            'mutable_etag': plot_revision.get('etag'),
            'mutable_version_id': plot_revision.get('version_id'),
            'content_length': len(plot),
            'sha256': plot_sha256,
            'immutable_key': plot_immutable_key,
            'immutable_etag': plot_immutable_revision.get('etag'),
        },
        'model_artifact': model_artifact,
        'video_id_alignment_population': alignment_population,
        'account_metric_private_fit_populations': account_metric_private_fit_populations,
        'label_snapshot_revisions': LABEL_SNAPSHOT_REVISIONS,
        'source_database_revision': DATABASE_REVISION,
        'channels_registry_revision': CHANNELS_REVISION,
        'frozen_visual_ctrviews_lineage': FROZEN_VISUAL_CTRVIEWS_LINEAGE,
        'runtime_revision': RUNTIME_REVISION,
        'projection_keys': sorted(mp['proj']),
    }
    manifest_bytes = canonical_bytes(manifest)
    manifest_sha256 = digest(manifest_bytes)
    manifest_immutable_key = f'raw-long/{ch}/manifests/by-sha256/{manifest_sha256}.json'
    manifest_immutable_revision = put_immutable(
        manifest_immutable_key,
        manifest_bytes,
        'application/json',
    )
    r2_put(
        f'raw-long/{ch}/map.manifest.json',
        canonical_bytes({
            **manifest,
            'manifest_sha256': manifest_sha256,
            'immutable_manifest_key': manifest_immutable_key,
            'immutable_manifest_etag': manifest_immutable_revision.get('etag'),
        }),
        'application/json',
    )
    CHANNEL_MANIFESTS.append({
        'channel': ch,
        'generation_id': generation_id,
        'manifest_sha256': manifest_sha256,
        'immutable_manifest_key': manifest_immutable_key,
        'map_sha256': map_sha256,
        'map_immutable_key': map_immutable_key,
    })
    if USE_PENDING: PENDING_KEYS.append(f'raw-long/{ch}/map.pending.json')
    print(f'  saved raw-long/{ch}/map.json + immutable {map_immutable_key} + manifest ({len(plot):,} plot bytes; proj keys: {len(mp["proj"])})', flush=True)

model_revision = r2_put('raw-long/steer_models.npz', model_bytes, 'application/octet-stream')
model_manifest = {
    'schema_version': PROVENANCE_SCHEMA_VERSION,
    'artifact_type': 'longquant-steer-model-generation',
    'algorithm_generation': ALGORITHM_GENERATION,
    'generator_source_sha256': GENERATOR_SOURCE_SHA256,
    'model_artifact': {
        **model_artifact,
        'mutable_etag': model_revision.get('etag'),
        'mutable_version_id': model_revision.get('version_id'),
        'content_length': len(model_bytes),
    },
    'account_view_equations': {
        account: {
            'available': VIEW_EQ[account] is not None,
            'fit_rows': VIEW_EQ[account]['n'] if VIEW_EQ[account] else 0,
        }
        for account in ACCTS
    },
    'channel_generations': CHANNEL_MANIFESTS,
}
model_manifest_bytes = canonical_bytes(model_manifest)
model_manifest_sha256 = digest(model_manifest_bytes)
model_manifest_immutable_key = f'raw-long/models/manifests/by-sha256/{model_manifest_sha256}.json'
model_manifest_immutable_revision = put_immutable(
    model_manifest_immutable_key,
    model_manifest_bytes,
    'application/json',
)
r2_put(
    'raw-long/steer_models.manifest.json',
    canonical_bytes({
        **model_manifest,
        'manifest_sha256': model_manifest_sha256,
        'immutable_manifest_key': model_manifest_immutable_key,
        'immutable_manifest_etag': model_manifest_immutable_revision.get('etag'),
    }),
    'application/json',
)
for pending_key in PENDING_KEYS: r2_delete(pending_key)
print('done — per-account ctr/ret30/realviews projections + owner tags added to raw-long/*', flush=True)
