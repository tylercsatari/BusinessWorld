#!/usr/bin/env python3
"""
NOVELTY FIELD — per-video novelty for the WHOLE corpus under every quantification, in
map order, so the UI can recolour the actual graph by the chosen method and you can SEE
the quantification (not one fixed colouring). Definitions identical to novelty_quantify.py.
Writes novelty_field.json: { modality: { method: [novelty per corpus video, map order] } }
plus the exact formula + held-out keep/ret5 ρ per (modality,method) from the sweep.
"""
import io, json, numpy as np, boto3, warnings, os; warnings.filterwarnings('ignore')
from sklearn.neighbors import NearestNeighbors
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import PCA
HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    for ln in open(HERE + '/.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
g = lambda k: s3.get_object(Bucket='business-world-videos', Key=k)['Body'].read()
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def rn(x): return np.linalg.norm(x, axis=1)

FORMULAS = {
    'mean': 'novelty = 1 − cos(e, corpus-mean). Distance from the single centre. (≡ low global density)',
    'knn5': 'novelty = mean cos-distance to the 5 nearest corpus hooks. Local emptiness (tight).',
    'knn15': 'novelty = mean cos-distance to the 15 nearest corpus hooks. Local emptiness.',
    'knn50': 'novelty = mean cos-distance to the 50 nearest corpus hooks. Local emptiness (broad).',
    'niche8': 'novelty = 1 − max cos to 8 k-means centroids. Distance to the nearest of 8 themes.',
    'niche25': 'novelty = 1 − max cos to 25 k-means centroids. Distance to the nearest of 25 themes.',
    'niche80': 'novelty = 1 − max cos to 80 k-means centroids. Distance to the nearest of 80 themes.',
    'maha': 'novelty = ‖PCA-whitened(e)‖. Mahalanobis distance — how unusual given the covariance.',
    'pcaresid10': 'novelty = ‖e − PCA10-reconstruct(e)‖ / ‖e‖. Unusual COMBINATION (10-dim subspace).',
    'pcaresid50': 'novelty = ‖e − PCA50-reconstruct(e)‖ / ‖e‖. Unusual COMBINATION (50-dim subspace).',
    'mode': 'novelty = 1 − cos(e, densest corpus exemplar). Distance from the single most-typical hook.',
}

def field(Xv):
    """per-video novelty (n,) for each method + the reference geometry (kmeans labels, mode index)."""
    out = {}; aux = {'labels': {}}
    mu = Xv.mean(0); mu = mu / (np.linalg.norm(mu) + 1e-9)
    out['mean'] = 1 - Xv @ mu
    nn = NearestNeighbors(n_neighbors=51, metric='cosine').fit(Xv); dist, _ = nn.kneighbors(Xv)
    for k in [5, 15, 50]: out[f'knn{k}'] = dist[:, 1:k + 1].mean(1)
    for K in [8, 25, 80]:
        km = MiniBatchKMeans(K, random_state=0, n_init=3, batch_size=1024).fit(Xv)
        cen = norm(km.cluster_centers_); out[f'niche{K}'] = 1 - (Xv @ cen.T).max(1); aux['labels'][K] = km.labels_
    pw = PCA(50, whiten=True, random_state=0).fit(Xv); out['maha'] = rn(pw.transform(Xv))
    for n in [10, 50]:
        p = PCA(n, random_state=0).fit(Xv); rec = p.inverse_transform(p.transform(Xv))
        out[f'pcaresid{n}'] = rn(Xv - rec) / (rn(Xv) + 1e-9)
    dens = dist[:, 1:16].mean(1)                          # mean dist to 15 NN; smallest = densest
    aux['mode_idx'] = int(np.argmin(dens)); mode = Xv[aux['mode_idx']]; out['mode'] = 1 - Xv @ mode
    return out, aux

# held-out ρ per (modality, method) from the sweep (same definitions)
SW = json.loads(g('raw/principles/novelty_quantify.json'))
stat = {}
for r in SW['results']: stat[(r['modality'], r['method'])] = {'keep': r['keep_lin'], 'ret5': r['ret5_lin']}

MODK = {'visual': 'visual', 'text': 'text', 'whole': 'together'}
field_out = {}
for mk, ck in MODK.items():
    z = np.load(io.BytesIO(g(f'raw/{ck}/embeddings.npz')), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; X = norm(np.asarray(z['vecs'], np.float32)); epos = {v: i for i, v in enumerate(ids)}
    mp = json.loads(g(f'raw/{ck}/map.json')); mids = [str(x) for x in mp['id']]
    Xm = np.zeros((len(mids), X.shape[1]), np.float32); mask = np.zeros(len(mids), bool)
    for i, vid in enumerate(mids):
        j = epos.get(vid)
        if j is not None: Xm[i] = X[j]; mask[i] = True
    F, aux = field(Xm[mask])
    # reference geometry in the map's UMAP coords (grid 0-1000) so the UI can DRAW what each
    # method measures distance FROM: mean=centre · mode=the densest exemplar · niche=K centroids.
    ux = np.array(mp['proj']['umap']['x'], float); uy = np.array(mp['proj']['umap']['y'], float)
    midx = np.where(mask)[0]; uxm, uym = ux[midx], uy[midx]
    refs = {'mean': {'kind': 'centre', 'pts': [[round(float(uxm.mean())), round(float(uym.mean()))]]},
            'mode': {'kind': 'exemplar', 'pts': [[round(float(ux[midx[aux['mode_idx']]])), round(float(uy[midx[aux['mode_idx']]]))]]}}
    for K in [8, 25, 80]:
        lab = aux['labels'][K]; pts = [[round(float(uxm[lab == c].mean())), round(float(uym[lab == c].mean()))] for c in range(K) if (lab == c).any()]
        refs[f'niche{K}'] = {'kind': 'centroids', 'pts': pts}
    field_out[mk] = {'methods': {}, 'n': int(mask.sum())}
    for meth, vals in F.items():
        full = np.full(len(mids), np.nan); full[mask] = vals
        med = float(np.nanmedian(vals))
        full = np.where(np.isfinite(full), full, med)     # neutral-fill missing so the map never breaks
        sm = stat.get((mk, meth), {})
        field_out[mk]['methods'][meth] = {'nov': [round(float(x), 4) for x in full],
                                          'keep_r': sm.get('keep'), 'ret5_r': sm.get('ret5'), 'formula': FORMULAS.get(meth, ''),
                                          'ref': refs.get(meth)}
    print(f'{mk} ({ck}): {mask.sum()} videos × {len(F)} methods · refs {list(refs)}', flush=True)

out = {'modalities': list(MODK), 'methods': list(FORMULAS), 'formulas': FORMULAS, 'field': field_out,
       'note': 'per-video novelty for the whole corpus, every quantification, map order (matches raw/<ch>/map.json id[])'}
open(HERE + '/buildings/jarvis/retention-study/principles/novelty_field.json', 'w').write(json.dumps(out))
s3.put_object(Bucket='business-world-videos', Key='raw/principles/novelty_field.json', Body=json.dumps(out).encode(), ContentType='application/json')
import os as _os
print('wrote novelty_field.json', round(_os.path.getsize(HERE + '/buildings/jarvis/retention-study/principles/novelty_field.json') / 1e6, 2), 'MB')
