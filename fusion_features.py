#!/usr/bin/env python3
"""
FUSION — phase 1: build the unified, leakage-aware feature table for the library
hook set, from the embeddings + metadata we already have. One row per video
(master = the visual set; text features are NaN where there's no voiceover — the
downstream HistGradientBoosting handles NaN natively).

ALL features here are UNSUPERVISED w.r.t. the target (views) — novelty/coherence/
CCA use only the embeddings + dates, so computing them on the whole set is NOT
target leakage. The only target-supervised steps (residualisation, the models)
happen in fusion_analyze.py, in-fold.

Outputs raw/fusion/features.npz (+ features_meta.json) to R2 and ./fusion_features.npz
Run: python3 fusion_features.py
"""
import os, io, json, datetime
import numpy as np, boto3
from sklearn.neighbors import NearestNeighbors
from sklearn.cluster import MiniBatchKMeans
from sklearn.cross_decomposition import CCA

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

def load_chan(c):
    buf = r2_get(f'raw/{c}/embeddings.npz')
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    return {
        'ids': [str(x) for x in z['ids']], 'vecs': np.asarray(z['vecs'], np.float32),
        'views': np.asarray(z['views'], float), 'outlier': np.asarray(z['outlier'], float),
        'subs': np.asarray(z['subs'], float), 'title': [str(t) for t in z['title']],
        'mine': np.asarray(z['mine'], bool) if 'mine' in z.files else np.zeros(len(z['ids']), bool),
        'silent': np.asarray(z['silent'], bool) if 'silent' in z.files else np.zeros(len(z['ids']), bool),
    }

print('loading embeddings…', flush=True)
VIS = load_chan('visual'); TXT = load_chan('text'); TOG = load_chan('together')
ids = VIS['ids']; N = len(ids); idpos = {v: i for i, v in enumerate(ids)}
print(f'master (visual) N={N}; text={len(TXT["ids"])}; together={len(TOG["ids"])}', flush=True)

def norm(X):
    return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
VX = norm(VIS['vecs'])
# align text/together vecs onto the master order (NaN rows where missing)
def aligned(ch):
    M = np.full((N, ch['vecs'].shape[1]), np.nan, np.float32)
    pos = {v: i for i, v in enumerate(ch['ids'])}
    have = np.zeros(N, bool)
    for vid, j in pos.items():
        i = idpos.get(vid)
        if i is not None: M[i] = ch['vecs'][j]; have[i] = True
    return M, have
TXraw, has_txt = aligned(TXT)
TGraw, has_tog = aligned(TOG)
TX = norm(np.nan_to_num(TXraw)); TX[~has_txt] = np.nan
TG = norm(np.nan_to_num(TGraw)); TG[~has_tog] = np.nan

# ---- metadata join (uploadDate → age, durationSec) ----
print('joining metadata…', flush=True)
db = json.loads(r2_get('library/db.json') or b'{"videos":{}}')
TODAY = datetime.date.today()
age = np.full(N, np.nan); dur = np.full(N, np.nan)
for v in db.get('videos', {}).values():
    i = idpos.get(str(v.get('videoId', '')))
    if i is None: continue
    ud = str(v.get('uploadDate', '') or '')
    if len(ud) == 8 and ud.isdigit():
        try:
            d = datetime.date(int(ud[:4]), int(ud[4:6]), int(ud[6:8]))
            age[i] = max(1, (TODAY - d).days)
        except Exception: pass
    if v.get('durationSec'): dur[i] = float(v['durationSec'])
# owned-set videos aren't in library db — fill their age/dur as NaN (fine; HGB handles)

views = VIS['views']; subs = VIS['subs']; outlier = VIS['outlier']
mine = VIS['mine']; silent = VIS['silent']

# month index for temporal novelty
month = np.full(N, -1, int)
for v in db.get('videos', {}).values():
    i = idpos.get(str(v.get('videoId', '')))
    if i is None: continue
    ud = str(v.get('uploadDate', '') or '')
    if len(ud) == 8 and ud.isdigit(): month[i] = int(ud[:4]) * 12 + int(ud[4:6])

# ---------- novelty features per modality ----------
def novelty_block(Xn, valid, label):
    """global (mean cos-dist to k-NN), niche (dist to own kmeans centroid),
    temporal (cos-dist to centroid of strictly-earlier videos)."""
    out = {f'{label}_glob_nov': np.full(N, np.nan), f'{label}_niche_nov': np.full(N, np.nan),
           f'{label}_temporal_nov': np.full(N, np.nan)}
    idx = np.where(valid)[0]
    if len(idx) < 50: return out
    Xv = Xn[idx]
    k = min(21, len(idx))
    nn = NearestNeighbors(n_neighbors=k, metric='cosine').fit(Xv)
    dist, _ = nn.kneighbors(Xv)
    out[f'{label}_glob_nov'][idx] = dist[:, 1:].mean(1)        # exclude self (col 0)
    K = min(25, max(2, len(idx) // 200))
    km = MiniBatchKMeans(K, random_state=0, n_init=3, batch_size=1024).fit(Xv)
    cen = norm(km.cluster_centers_); lab = km.labels_
    out[f'{label}_niche_nov'][idx] = 1 - np.einsum('ij,ij->i', Xv, cen[lab])
    # temporal: centroid of all valid videos in strictly-earlier months
    mo = month[idx]
    for m in sorted(set(mo[mo > 0].tolist())):
        prior = idx[(mo < m) & (mo > 0)]
        if len(prior) < 20: continue
        c = norm(Xn[prior].mean(0, keepdims=True))[0]
        cur = idx[mo == m]
        out[f'{label}_temporal_nov'][cur] = 1 - Xn[cur] @ c
    return out

print('novelty: visual…', flush=True); F = {}
F.update(novelty_block(VX, np.ones(N, bool), 'vis'))
print('novelty: text…', flush=True); F.update(novelty_block(np.nan_to_num(TX), has_txt, 'txt'))
print('novelty: together…', flush=True); F.update(novelty_block(np.nan_to_num(TG), has_tog, 'tog'))

# ---------- cross-modal: coherence, combinatorial, CCA alignment ----------
print('cross-modal…', flush=True)
pair = has_txt & has_tog
coh = np.full(N, np.nan); comb = np.full(N, np.nan); cca_align = np.full(N, np.nan)
pidx = np.where(pair)[0]
if len(pidx) > 50:
    coh[pidx] = np.einsum('ij,ij->i', VX[pidx], np.nan_to_num(TX)[pidx])     # visual·text alignment
    mix = norm((VX[pidx] + np.nan_to_num(TX)[pidx]))                          # the "sum of parts"
    comb[pidx] = 1 - np.einsum('ij,ij->i', np.nan_to_num(TG)[pidx], mix)      # how far the fused departs from the parts
    nc = 10
    try:
        cca = CCA(n_components=nc, max_iter=500)
        U, Vc = cca.fit_transform(VX[pidx], np.nan_to_num(TX)[pidx])
        Un = U / (np.linalg.norm(U, axis=1, keepdims=True) + 1e-9)
        Vn = Vc / (np.linalg.norm(Vc, axis=1, keepdims=True) + 1e-9)
        cca_align[pidx] = np.einsum('ij,ij->i', Un, Vn)                       # on-pattern cross-modal alignment
    except Exception as e:
        print('  CCA failed:', str(e)[:80], flush=True)
F['coherence'] = coh; F['combinatorial_nov'] = comb; F['cca_align'] = cca_align

# ---------- metadata / confound features ----------
F['log_subs'] = np.log10(np.where(subs > 0, subs, np.nan) + 1)
F['log_age'] = np.log10(age + 1)
F['log_dur'] = np.log10(np.where(dur > 0, dur, np.nan) + 1)
F['silent'] = silent.astype(float)
F['has_text'] = has_txt.astype(float)

# ---------- assemble ----------
names = list(F.keys())
X = np.column_stack([F[n] for n in names]).astype(np.float32)
log_views = np.log10(views + 1)
log_outlier = np.log10(np.where(outlier > 0, outlier, np.nan) + 1)

meta = {
    'n': N, 'feature_names': names, 'created': TODAY.isoformat(),
    'n_with_text': int(has_txt.sum()), 'n_mine': int(mine.sum()), 'n_silent': int(silent.sum()),
    'feature_groups': {
        'novelty_visual': ['vis_glob_nov', 'vis_niche_nov', 'vis_temporal_nov'],
        'novelty_text': ['txt_glob_nov', 'txt_niche_nov', 'txt_temporal_nov'],
        'novelty_together': ['tog_glob_nov', 'tog_niche_nov', 'tog_temporal_nov'],
        'cross_modal': ['coherence', 'combinatorial_nov', 'cca_align'],
        'confounds': ['log_subs', 'log_age', 'log_dur', 'silent', 'has_text'],
    },
}
bio = io.BytesIO()
np.savez_compressed(bio, ids=np.array(ids, object), X=X, names=np.array(names, object),
                    log_views=log_views, views=views, log_outlier=log_outlier, outlier=outlier,
                    subs=subs, age=age, dur=dur, mine=mine, silent=silent, has_txt=has_txt)
data = bio.getvalue()
open(os.path.join(HERE, 'fusion_features.npz'), 'wb').write(data)
r2_put('raw/fusion/features.npz', data, 'application/octet-stream')
r2_put('raw/fusion/features_meta.json', json.dumps(meta, indent=1).encode(), 'application/json')

# coverage sanity print
print('\nfeature coverage (% non-NaN):', flush=True)
for nm in names:
    col = X[:, names.index(nm)]
    print(f'  {nm:18s} {100 * np.mean(np.isfinite(col)):5.1f}%  '
          f'[{np.nanmin(col):.3g}, {np.nanmax(col):.3g}]', flush=True)
print(f'\nsaved {N} rows × {len(names)} features → raw/fusion/features.npz', flush=True)
