#!/usr/bin/env python3
"""
PRINCIPLES → NOVELTY over the FULL 11k corpus, written in the EXACT structure the
existing A–E novelty views consume (buildings/.../principles/novelty.json). This
MERGES the owned 211 into the corpus: every video's novelty is measured against all
~11k neighbours (so the owned scores shift as the corpus grows), in the shared Gemini
space (where owned + library both live). Recompute whenever the corpus grows.

Modalities map to what the views expect: whole=together, concept=text, visual=visual,
text=text. Owned videos keep their detection/concepts (attached from the old file) for
the hook-detail panel; library videos have none (views degrade gracefully). Per-second
is collapsed (library has no per-second) — N.second mirrors the hook so the toggle works.

Run: python3 principles_novelty.py   (writes the served novelty.json + backs up the old)
"""
import os, io, json, datetime
import numpy as np, boto3
from sklearn.neighbors import NearestNeighbors
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import PCA
from scipy.stats import rankdata

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'buildings/jarvis/retention-study/principles/novelty.json')
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
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def pct(a): a = np.asarray(a, float); r = np.full(len(a), 0.5); m = np.isfinite(a); r[m] = (rankdata(a[m]) - 1) / max(1, m.sum() - 1); return r

print('loading corpus embeddings…', flush=True)
ch = {}
for sk, ck in [('vis', 'visual'), ('txt', 'text'), ('tog', 'together')]:
    z = np.load(io.BytesIO(r2_get(f'raw/{ck}/embeddings.npz')), allow_pickle=True)
    ch[sk] = {'ids': [str(x) for x in z['ids']], 'V': norm(np.asarray(z['vecs'], np.float32))}
    if sk == 'vis':
        META = {'views': np.asarray(z['views'], float), 'subs': np.asarray(z['subs'], float),
                'title': [str(t) for t in z['title']], 'mine': np.asarray(z['mine'], bool) if 'mine' in z.files else np.zeros(len(z['ids']), bool)}
ids = ch['vis']['ids']; N = len(ids); idpos = {v: i for i, v in enumerate(ids)}
def align(sk):
    M = np.full((N, ch[sk]['V'].shape[1]), np.nan, np.float32); have = np.zeros(N, bool)
    for j, vid in enumerate(ch[sk]['ids']):
        i = idpos.get(vid)
        if i is not None: M[i] = ch[sk]['V'][j]; have[i] = True
    return M, have
VIS = (ch['vis']['V'], np.ones(N, bool)); TXT = align('txt'); TOG = align('tog')
# modality → (embeddings, valid-mask)
MODE = {'whole': TOG, 'concept': TXT, 'visual': VIS, 'text': TXT}
print(f'corpus N={N}; text-covered={int(TXT[1].sum())}', flush=True)

# metadata: age + month (temporal) from library db
db = json.loads(r2_get('library/db.json') or b'{"videos":{}}'); today = datetime.date.today()
age = np.full(N, np.nan); month = np.full(N, -1, int)
for v in db.get('videos', {}).values():
    i = idpos.get(str(v.get('videoId', ''))); ud = str(v.get('uploadDate', '') or '')
    if i is not None and len(ud) == 8 and ud.isdigit():
        d = datetime.date(int(ud[:4]), int(ud[4:6]), int(ud[6:8])); age[i] = max(1, (today - d).days); month[i] = int(ud[:4]) * 12 + int(ud[4:6])

def proj2d(Xn, valid):
    P = np.zeros((N, 2))                              # missing (silent) → origin, never NaN
    idx = np.where(valid)[0]
    if len(idx) > 10:
        p = PCA(2, random_state=0).fit_transform(Xn[idx])
        p = p / (np.abs(p).max(0) + 1e-9)            # → ~[-1,1]
        P[idx] = np.nan_to_num(p)
    return P

def geom(Xn, valid):
    """global nov (mean kNN cos-dist) + niche (kmeans label + dist to centre)."""
    nov = np.full(N, np.nan); lab = np.zeros(N, int); dc = np.full(N, np.nan)
    idx = np.where(valid)[0]
    if len(idx) < 50: return nov, lab, dc
    Xv = Xn[idx]; k = min(9, len(idx))
    nn = NearestNeighbors(n_neighbors=k, metric='cosine').fit(Xv); dist, _ = nn.kneighbors(Xv)
    nov[idx] = dist[:, 1:].mean(1)
    K = 8
    km = MiniBatchKMeans(K, random_state=0, n_init=3, batch_size=1024).fit(Xv); cen = norm(km.cluster_centers_)
    lab[idx] = km.labels_; dc[idx] = 1 - np.einsum('ij,ij->i', Xv, cen[km.labels_])
    return nov, lab, dc

hook = {'global': {}, 'niche': {}, 'proj': {}}
for mk, (M, valid) in MODE.items():
    print(f'modality {mk}…', flush=True)
    Xn = np.nan_to_num(M)
    nov, lab, dc = geom(Xn, valid)
    # neutral-fill missing (silent videos for text/concept) so views never break
    novf = np.where(np.isfinite(nov), nov, np.nanmedian(nov[valid]) if valid.any() else 0)
    hook['global'][mk] = {'nov': [round(float(x), 4) for x in novf], 'pct': [round(float(x), 4) for x in pct(np.where(valid, nov, np.nan))]}
    hook['niche'][mk] = {'labels': [int(x) for x in lab], 'k': 8, 'dist_to_centre': [round(float(x), 4) if x == x else 0.0 for x in dc]}
    P = proj2d(Xn, valid); hook['proj'][mk] = [[round(float(x), 4), round(float(y), 4)] for x, y in P]

# temporal: dist to earlier-month centroid (together space)
tn = np.full(N, np.nan); Tg = np.nan_to_num(TOG[0])
for m in sorted(set(month[month > 0].tolist())):
    prior = np.where((month < m) & (month > 0) & TOG[1])[0]
    if len(prior) < 20: continue
    c = norm(Tg[prior].mean(0, keepdims=True))[0]; cur = np.where(month == m)[0]; tn[cur] = 1 - Tg[cur] @ c
hook['temporal'] = {'nov': [None if x != x else round(float(x), 4) for x in tn], 'window_days': 30}
# coherent: coherence = visual·text (paired); novelty = whole global
coh = np.full(N, np.nan); pair = TXT[1] & VIS[1]
coh[pair] = np.einsum('ij,ij->i', VIS[0][pair], np.nan_to_num(TXT[0])[pair])
wnov = np.asarray(hook['global']['whole']['nov'], float)
hook['coherent'] = {'novelty': [round(float(x), 4) for x in wnov], 'coherence': [None if x != x else round(float(x), 4) for x in coh],
                    'nov_pct': hook['global']['whole']['pct'], 'coh_pct': [round(float(x), 4) for x in pct(coh)]}
hook['scene'] = {'spread': hook['niche']['whole']['dist_to_centre']}

# combo: clusters on together + rarity (= together combinatorial via PCA residual)
print('combo…', flush=True)
Tv = Tg[TOG[1]]; tidx = np.where(TOG[1])[0]
kmC = MiniBatchKMeans(12, random_state=0, n_init=3, batch_size=1024).fit(Tv)
labC = np.zeros(N, int); labC[tidx] = kmC.labels_
cen2 = PCA(2, random_state=0).fit(Tv).transform(kmC.cluster_centers_); cen2 = cen2 / (np.abs(cen2).max(0) + 1e-9)
freq = np.bincount(kmC.labels_, minlength=12)
clusters = [{'id': i, 'label': f'cluster {i}', 'freq': int(freq[i]), 'pos': [round(float(cen2[i][0]), 4), round(float(cen2[i][1]), 4)]} for i in range(12)]
npc = min(50, Tv.shape[1]); pcaT = PCA(npc, random_state=0).fit(Tv)
res = np.linalg.norm(Tv - pcaT.inverse_transform(pcaT.transform(Tv)), axis=1) / (np.linalg.norm(Tv, axis=1) + 1e-9)
rar = np.full(N, np.nan); rar[tidx] = res
combo = {'clusters': clusters, 'edges': [], 'rarity': [None if x != x else round(float(x), 4) for x in rar], 'k_clusters': 12}

# videos (+ attach owned detail from old file)
owned_detail = {}
try:
    old = json.load(open(OUT))
    for v in old.get('videos', []):
        owned_detail[v['id']] = {k: v.get(k) for k in ['hook_text', 'onscreen_text', 'concepts', 'objects_hook', 'objects_persec', 'persec', 'scenes'] if v.get(k) is not None}
    LEDGER = old.get('ledger', [])
except Exception:
    LEDGER = []
videos = []
for i, vid in enumerate(ids):
    vw = float(META['views'][i])
    rec = {'id': vid, 'name': META['title'][i] or vid, 'views': vw, 'lv': round(float(np.log10(vw + 1)), 3),
           'url': f'https://www.youtube.com/watch?v={vid}', 'age_days': None if age[i] != age[i] else int(age[i]),
           'mine': bool(META['mine'][i])}
    rec.update(owned_detail.get(vid, {}))
    videos.append(rec)

# second: minimal mirror so the metadata header + toggle don't crash (no real per-second for library)
second = {'owner': list(range(N)), 'sec': [0] * N, 'proj': hook['proj'],
          'global': hook['global'], 'niche': hook['niche'],
          'coherence': hook['coherent']['coherence'], 'coh_pct': hook['coherent']['coh_pct'], 'temporal': hook['temporal']['nov']}

out = {'meta': {'n': N, 'hook_seconds': 5, 'resolutions': ['hook'], 'corpus': N, 'owned': int(META['mine'].sum()),
                'models': {'visual': 'gemini-embedding-2', 'whole': 'gemini (together)', 'concept': 'gemini (text)', 'detector': '— (library: none)'}},
       'ledger': LEDGER, 'videos': videos, 'hook': hook, 'second': second, 'combo': combo}

if os.path.exists(OUT) and not os.path.exists(OUT.replace('.json', '_owned_backup.json')):
    import shutil; shutil.copy(OUT, OUT.replace('.json', '_owned_backup.json')); print('backed up owned → novelty_owned_backup.json', flush=True)
json.dump(out, open(OUT, 'w'))
print(f'\nwrote {OUT} · {N} hooks · {os.path.getsize(OUT)//1024} KB', flush=True)
print('global-nov modalities:', {mk: f'{np.nanmin(hook["global"][mk]["nov"]):.3f}–{np.nanmax(hook["global"][mk]["nov"]):.3f}' for mk in MODE}, flush=True)
print(f'owned merged into corpus: {int(META["mine"].sum())} videos — their novelty now measured vs all {N}', flush=True)
