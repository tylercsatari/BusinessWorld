#!/usr/bin/env python3
"""
PRINCIPLES → NOVELTY: the SINGLE source of truth for novelty. One function, run
against the FULL corpus of hook embeddings (recomputed as the corpus grows, since
global novelty is corpus-relative — more data re-places everyone). Nothing else
computes novelty; Fusion and everything else just READ these indicators.

Grid: modality {visual, text(spoken), together} × type {global, niche, temporal,
combinatorial} + cross-modal {coherence, fusion_combinatorial} = 14 indicators.
Each is an INDICATOR (named scalar per video) usable anywhere.

Also attaches the metrics each video has (views for all; 5s-retention + swipe for
the owned set) so the Principles UI can graph novelty↔metric and Fusion can stack.

Writes raw/principles/novelty.npz (ids + indicator matrix) + novelty.json (meta,
coverage, per-indicator Spearman vs each available metric — for the graphs).
Run: python3 principles_novelty.py
"""
import os, io, json, datetime
import numpy as np, boto3
from sklearn.neighbors import NearestNeighbors
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import PCA
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

MOD = {'vis': 'visual', 'txt': 'text', 'tog': 'together'}
print('loading corpus embeddings…', flush=True)
emb, meta0 = {}, {}
for sk, ck in MOD.items():
    z = np.load(io.BytesIO(r2_get(f'raw/{ck}/embeddings.npz')), allow_pickle=True)
    emb[sk] = {'ids': [str(x) for x in z['ids']], 'V': norm(np.asarray(z['vecs'], np.float32))}
    if sk == 'vis':
        meta0 = {'views': np.asarray(z['views'], float), 'outlier': np.asarray(z['outlier'], float),
                 'subs': np.asarray(z['subs'], float), 'mine': np.asarray(z['mine'], bool) if 'mine' in z.files else np.zeros(len(z['ids']), bool)}
# master = visual order (covers everyone); align other modalities by id
ids = emb['vis']['ids']; N = len(ids); idpos = {v: i for i, v in enumerate(ids)}
def align(sk):
    M = np.full((N, emb[sk]['V'].shape[1]), np.nan, np.float32); have = np.zeros(N, bool)
    for j, vid in enumerate(emb[sk]['ids']):
        i = idpos.get(vid)
        if i is not None: M[i] = emb[sk]['V'][j]; have[i] = True
    return M, have
VV = {'vis': (emb['vis']['V'], np.ones(N, bool))}
VV['txt'] = align('txt'); VV['tog'] = align('tog')
print(f'corpus N={N}; text-covered={int(VV["txt"][1].sum())}', flush=True)

# month index (temporal) + owned-set retention/swipe metrics
db = json.loads(r2_get('library/db.json') or b'{"videos":{}}')
month = np.full(N, -1, int)
for v in db.get('videos', {}).values():
    i = idpos.get(str(v.get('videoId', ''))); ud = str(v.get('uploadDate', '') or '')
    if i is not None and len(ud) == 8 and ud.isdigit(): month[i] = int(ud[:4]) * 12 + int(ud[4:6])
ret5 = np.full(N, np.nan); keep = np.full(N, np.nan)
try:
    rt = json.loads(open(os.path.join(HERE, 'buildings/jarvis/retention-study/retention_table.json')).read())
    for v in rt.get('videos', []):
        i = idpos.get(str(v.get('id', '')))
        if i is None: continue
        if v.get('ret5_surv') is not None: ret5[i] = float(v['ret5_surv'])     # % surviving past 5s
        if v.get('keep_rate') is not None: keep[i] = float(v['keep_rate'])      # stayed-to-watch %  (swipe = 100-keep)
except Exception as e:
    print('owned metrics load failed:', str(e)[:80], flush=True)

# ---------- the novelty function (one definition, applied per modality) ----------
def novelty(Xn, valid):
    """global=mean k-NN cos-dist (isolation) · niche=dist to own kmeans centroid ·
    temporal=dist to earlier-month centroid · combinatorial=PCA reconstruction
    residual (made of unusual combinations of common factors)."""
    g = np.full(N, np.nan); ni = np.full(N, np.nan); te = np.full(N, np.nan); cb = np.full(N, np.nan)
    idx = np.where(valid)[0]
    if len(idx) < 50: return g, ni, te, cb
    Xv = Xn[idx]
    k = min(21, len(idx))
    nn = NearestNeighbors(n_neighbors=k, metric='cosine').fit(Xv)
    dist, _ = nn.kneighbors(Xv); g[idx] = dist[:, 1:].mean(1)
    K = min(25, max(2, len(idx) // 200))
    km = MiniBatchKMeans(K, random_state=0, n_init=3, batch_size=1024).fit(Xv)
    cen = norm(km.cluster_centers_); ni[idx] = 1 - np.einsum('ij,ij->i', Xv, cen[km.labels_])
    mo = month[idx]
    for m in sorted(set(mo[mo > 0].tolist())):
        prior = idx[(month[idx] < m) & (month[idx] > 0)]
        if len(prior) < 20: continue
        c = norm(Xn[prior].mean(0, keepdims=True))[0]; cur = idx[mo == m]; te[cur] = 1 - Xn[cur] @ c
    npc = min(50, Xv.shape[1], len(idx) - 1)
    pca = PCA(n_components=npc, random_state=0).fit(Xv)
    recon = pca.inverse_transform(pca.transform(Xv))
    cb[idx] = np.linalg.norm(Xv - recon, axis=1) / (np.linalg.norm(Xv, axis=1) + 1e-9)
    return g, ni, te, cb

F, names = {}, []
for sk in MOD:
    print(f'novelty: {MOD[sk]}…', flush=True)
    g, ni, te, cb = novelty(VV[sk][0] if sk == 'vis' else np.nan_to_num(VV[sk][0]), VV[sk][1])
    for nm, arr in [('global', g), ('niche', ni), ('temporal', te), ('combinatorial', cb)]:
        key = f'{sk}_{nm}'; F[key] = arr; names.append(key)
# cross-modal
pair = VV['txt'][1] & VV['tog'][1]
coh = np.full(N, np.nan); fcomb = np.full(N, np.nan); p = np.where(pair)[0]
if len(p) > 50:
    coh[p] = np.einsum('ij,ij->i', VV['vis'][0][p], np.nan_to_num(VV['txt'][0])[p])
    mix = norm(VV['vis'][0][p] + np.nan_to_num(VV['txt'][0])[p])
    fcomb[p] = 1 - np.einsum('ij,ij->i', np.nan_to_num(VV['tog'][0])[p], mix)
F['coherence'] = coh; names.append('coherence')
F['fusion_combinatorial'] = fcomb; names.append('fusion_combinatorial')

# ---------- assemble + per-indicator correlation to each available metric ----------
X = np.column_stack([F[n] for n in names]).astype(np.float32)
METRICS = {'views': np.log10(meta0['views'] + 1), 'outlier': np.log10(np.where(meta0['outlier'] > 0, meta0['outlier'], np.nan) + 1),
           'ret5': ret5, 'keep': keep}
corr = {}
for n in names:
    corr[n] = {}
    for mk, mv in METRICS.items():
        m = np.isfinite(X[:, names.index(n)]) & np.isfinite(mv)
        corr[n][mk] = round(float(spearmanr(X[m, names.index(n)], mv[m])[0]), 3) if m.sum() > 30 else None
# histograms for the graphs
hist = {}
for n in names:
    v = X[:, names.index(n)]; v = v[np.isfinite(v)]
    if len(v) > 10:
        h, edges = np.histogram(v, bins=24)
        hist[n] = {'counts': h.tolist(), 'lo': round(float(edges[0]), 4), 'hi': round(float(edges[-1]), 4)}

bio = io.BytesIO()
np.savez_compressed(bio, ids=np.array(ids, object), X=X, names=np.array(names, object))
r2_put('raw/principles/novelty.npz', bio.getvalue(), 'application/octet-stream')
out = {'n': N, 'updated': datetime.date.today().isoformat(), 'indicators': names,
       'coverage': {'all': N, 'text': int(VV['txt'][1].sum()), 'owned': int(meta0['mine'].sum()),
                    'owned_retention': int(np.isfinite(ret5).sum())},
       'metrics': list(METRICS.keys()), 'corr': corr, 'hist': hist}
r2_put('raw/principles/novelty.json', json.dumps(out).encode(), 'application/json')

print('\n=== novelty indicators × metric (Spearman) ===', flush=True)
print(f'{"indicator":24s}' + ''.join(f'{m:>9s}' for m in METRICS), flush=True)
for n in names:
    print(f'{n:24s}' + ''.join(f'{(str(corr[n][m]) if corr[n][m] is not None else "—"):>9s}' for m in METRICS), flush=True)
print(f'\ncoverage: all {N} · text {int(VV["txt"][1].sum())} · owned {int(meta0["mine"].sum())} · owned-retention {int(np.isfinite(ret5).sum())}', flush=True)
print('saved → raw/principles/novelty.npz + novelty.json', flush=True)
