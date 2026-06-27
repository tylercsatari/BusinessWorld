#!/usr/bin/env python3
"""
RAW hook embeddings — THREE channels, all from the FIRST 5 SECONDS of each library video:
  visual    = montage of 5 frames (1/sec) → Gemini multimodal embed
  text      = Whisper transcript of the first 5s → Gemini text embed (if any speech)
  together  = montage + transcript embedded as ONE multimodal content
One dot = one video's hook. No labels. Saves the montage (raw/montage/<id>.jpg) + transcript so
each point's RAW INPUT is inspectable. Per channel: raw/<chan>/embeddings.npz + raw/<chan>/map.json
(projections + HELD-OUT scores: fit on 70%, measured on the 30% it never saw). Resumable per channel.
Usage: RAW_MAX=5000 python3 raw_embed.py
"""
import os, sys, json, base64, subprocess, tempfile, shutil, time, io, threading
import numpy as np, boto3, urllib.request
from concurrent.futures import ThreadPoolExecutor
from sklearn.cluster import MiniBatchKMeans
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import roc_auc_score
from sklearn.cross_decomposition import PLSRegression
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis as LDA

HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    v = os.environ.get(k)
    if v: return v
    for ln in open(os.path.join(HERE, '.env')):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
KEY = env('GEMINI_API_KEY'); BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
DIM, WORKERS, RAW_MAX = 1536, 6, int(os.environ.get('RAW_MAX', '5000'))
EMB_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent'
CHANS = ['visual', 'text', 'together']

_wlock = threading.Lock(); _wmodel = [None]
def whisper_text(wav):
    import whisper
    with _wlock:
        if _wmodel[0] is None:
            _wmodel[0] = whisper.load_model('tiny')
        try:
            return (_wmodel[0].transcribe(wav, fp16=False).get('text') or '').strip()
        except Exception:
            return ''


def r2_get(key):
    try: return s3.get_object(Bucket=BUCKET, Key=key)['Body'].read()
    except Exception: return None
def r2_put(key, data, ct): s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=ct)


def embed(parts, tries=6):
    body = json.dumps({'content': {'parts': parts}, 'outputDimensionality': DIM}).encode()
    for a in range(tries):
        try:
            req = urllib.request.Request(EMB_URL, data=body, method='POST', headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
            with urllib.request.urlopen(req, timeout=60) as r:
                return np.array(json.loads(r.read())['embedding']['values'], np.float32)
        except Exception:
            if a < tries - 1: time.sleep(1.5 * (a + 1)); continue
            return None
def img_part(b64): return {'inlineData': {'mimeType': 'image/jpeg', 'data': b64}}


def hook_inputs(vid):
    """download → first-5s montage (saved to R2) b64 + first-5s transcript. None on failure."""
    tmp = tempfile.mkdtemp(prefix='raw_')
    try:
        mp4, mon, wav = os.path.join(tmp, 'v.mp4'), os.path.join(tmp, 'm.jpg'), os.path.join(tmp, 'a.wav')
        s3.download_file(BUCKET, f'library/videos/{vid}.mp4', mp4)
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', mp4, '-vf', 'fps=1,scale=320:-1,tile=5x1', '-frames:v', '1', mon], timeout=40)
        if not os.path.exists(mon): return None
        montage = open(mon, 'rb').read()
        r2_put(f'raw/montage/{vid}.jpg', montage, 'image/jpeg')
        b64 = base64.b64encode(montage).decode()
        txt = ''
        try:
            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', mp4, '-vn', '-ar', '16000', '-ac', '1', wav], timeout=40)
            if os.path.exists(wav): txt = whisper_text(wav)
        except Exception: pass
        return b64, txt
    except Exception:
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---- load library (metadata) ----
libdb = json.loads(r2_get('library/db.json') or b'{"videos":{}}')
stored = [v for v in libdb['videos'].values() if v.get('stored')]
print(f"library: {len(stored)} stored on R2", flush=True)

# ---- per-channel stores (migrate old raw/embeddings.npz → visual) ----
store = {c: {'ids': [], 'vecs': [], 'views': [], 'outlier': [], 'subs': [], 'title': [], 'txt': []} for c in CHANS}
def load_chan(c):
    buf = r2_get(f'raw/{c}/embeddings.npz') or (r2_get('raw/embeddings.npz') if c == 'visual' else None)
    if not buf: return
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    s = store[c]; s['ids'] = list(z['ids']); s['vecs'] = list(z['vecs'])
    for k in ['views', 'outlier', 'subs', 'title']: s[k] = list(z[k])
    s['txt'] = list(z['txt']) if 'txt' in z.files else [''] * len(s['ids'])
for c in CHANS: load_chan(c)
done = {c: set(store[c]['ids']) for c in CHANS}
print({c: len(done[c]) for c in CHANS}, flush=True)

todo = [v for v in stored if any(v['videoId'] not in done[c] for c in CHANS)][:RAW_MAX]
lock = threading.Lock(); cnt = [0]; t0 = time.time()


def heldout(X, views):
    Xn = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
    lv = np.log10(views + 1); y = (views > 1e7).astype(int)
    if len(X) < 50 or y.sum() < 10 or (len(y) - y.sum()) < 10: return None, None
    rng = np.random.RandomState(0); idx = rng.permutation(len(X)); cut = int(.7 * len(X)); tr, te = idx[:cut], idx[cut:]
    try:
        auc = roc_auc_score(y[te], LogisticRegression(C=1, max_iter=1500).fit(Xn[tr], y[tr]).decision_function(Xn[te]))
        r = float(np.corrcoef(Ridge(alpha=10).fit(Xn[tr], lv[tr]).predict(Xn[te]), lv[te])[0, 1])
    except Exception: return None, None
    return round(float(auc), 3), round(r, 3)


def build_map(c):
    s = store[c]; ids = s['ids']
    if len(ids) < 20: return
    try:
        X = np.array(s['vecs'], np.float32); Xn = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
        vv = np.array(s['views'], float); lv = np.log10(vv + 1)
        ov = np.array(s['outlier'], float); omed = np.nanmedian(ov[~np.isnan(ov)]) if (~np.isnan(ov)).any() else 0.0
        ovf = np.where(np.isnan(ov), omed, ov); lo = np.log10(ovf + 1)
        rng = np.random.RandomState(0); idx = rng.permutation(len(X)); cut = int(.7 * len(X)); tr, te = idx[:cut], idx[cut:]
        Xc = Xn - Xn.mean(0); P = np.linalg.svd(Xc, full_matrices=False)[2]
        def grid(a):
            a = np.asarray(a, float); q1, q9 = np.nanpercentile(a, 1), np.nanpercentile(a, 99)
            return (np.clip((a - q1) / ((q9 - q1) or 1), 0, 1) * 1000).round().astype(int)
        def hocorr(axis, target):  # held-out corr (test points only)
            at, tt = axis[te], target[te]
            return abs(float(np.corrcoef(at, tt)[0, 1])) if at.std() > 1e-9 and tt.std() > 1e-9 else 0.0
        proj = {}
        def add(name, xy, supervised):
            xy = np.asarray(xy, float)
            cv = max(hocorr(xy[:, 0], lv), hocorr(xy[:, 1], lv)) if supervised else max(abs(np.corrcoef(xy[:, 0], lv)[0, 1]), abs(np.corrcoef(xy[:, 1], lv)[0, 1]))
            co = max(hocorr(xy[:, 0], lo), hocorr(xy[:, 1], lo)) if supervised else max(abs(np.corrcoef(xy[:, 0], lo)[0, 1]), abs(np.corrcoef(xy[:, 1], lo)[0, 1]))
            proj[name] = {'x': grid(xy[:, 0]).tolist(), 'y': grid(xy[:, 1]).tolist(), 'cv': round(cv, 3), 'co': round(co, 3)}
        add('pca', Xc @ P[:2].T, False)
        try:
            import umap; add('umap', umap.UMAP(n_neighbors=15, min_dist=0.1, metric='cosine', random_state=0).fit_transform(Xn), False)
        except Exception: pass
        # supervised: FIT ON TRAIN, transform ALL (layout), score on held-out test
        for nm, Y in [('views', lv), ('outlier', lo), ('both', np.column_stack([lv, lo]))]:
            try:
                m = PLSRegression(2).fit(Xn[tr], Y[tr] if Y.ndim == 1 else Y[tr]); add(nm, m.transform(Xn), True)
            except Exception: pass
        for nm, yb in [('hi10m', (vv > 1e7).astype(int)), ('hiout', (ovf >= np.nanpercentile(ovf, 85)).astype(int))]:
            if yb[tr].sum() > 5 and (len(tr) - yb[tr].sum()) > 5:
                try:
                    lx = LDA(n_components=1).fit(Xn[tr], yb[tr]).transform(Xn)[:, 0]; add(nm, np.column_stack([lx, Xc @ P[0]]), True)
                except Exception: pass
        clusters = {str(k): MiniBatchKMeans(k, random_state=0, n_init=3, batch_size=1024).fit_predict(Xn).tolist() for k in [6, 10, 16, 24] if len(Xn) >= k}
        auc, r = heldout(X, vv)
        out = {'n': len(ids), 'channel': c, 'updated': time.time(), 'proj': proj, 'heldout_auc10m': auc, 'heldout_rviews': r,
               'views': [float(x) for x in s['views']], 'outlier': [round(float(x), 1) if x == x else None for x in s['outlier']],
               'subs': [float(x) for x in s['subs']], 'id': list(ids), 'title': [str(t)[:60] for t in s['title']],
               'txt': [str(t)[:200] for t in s['txt']], 'clusters': clusters}
        r2_put(f'raw/{c}/map.json', json.dumps(out).encode(), 'application/json')
        print(f"  map[{c}]: n={len(ids)} held-out AUC(>10M)={auc} r(views)={r} · " + ' '.join(f"{k}(v{proj[k]['cv']}/o{proj[k]['co']})" for k in proj), flush=True)
    except Exception as e:
        print(f'map[{c}] skipped:', str(e)[:120], flush=True)


def save_npz(c):
    s = store[c]
    if not s['ids']: return
    bio = io.BytesIO()
    np.savez_compressed(bio, ids=np.array(s['ids'], object), vecs=np.array(s['vecs'], np.float32),
                        views=np.array(s['views'], np.float64), outlier=np.array(s['outlier'], np.float64),
                        subs=np.array(s['subs'], np.float64), title=np.array(s['title'], object), txt=np.array(s['txt'], object))
    r2_put(f'raw/{c}/embeddings.npz', bio.getvalue(), 'application/octet-stream')


for c in CHANS: build_map(c)   # immediate maps from whatever's already embedded (visual migrated)


def work(v):
    vid = v['videoId']
    if all(vid in done[c] for c in CHANS): return
    inp = hook_inputs(vid)
    if not inp: return
    b64, txt = inp
    embeds = {}
    if vid not in done['visual']: embeds['visual'] = embed([img_part(b64)])
    if txt and vid not in done['text']: embeds['text'] = embed([{'text': txt}])
    if vid not in done['together']: embeds['together'] = embed([img_part(b64)] + ([{'text': txt}] if txt else []))
    with lock:
        meta = (v.get('views') or 0, (v['views'] / v['subs']) if v.get('subs') else float('nan'), v.get('subs') or 0, v.get('title') or '', txt)
        for c, e in embeds.items():
            if e is None: continue
            s = store[c]; s['ids'].append(vid); s['vecs'].append(e)
            s['views'].append(meta[0]); s['outlier'].append(meta[1]); s['subs'].append(meta[2]); s['title'].append(meta[3]); s['txt'].append(meta[4])
            done[c].add(vid)
        cnt[0] += 1
        if cnt[0] % 100 == 0:
            el = time.time() - t0
            print(f"  {cnt[0]}/{len(todo)} · {el/60:.0f}m · visual {len(store['visual']['ids'])} text {len(store['text']['ids'])} together {len(store['together']['ids'])}", flush=True)
            for c in CHANS: save_npz(c)
            if cnt[0] % 500 == 0:
                for c in CHANS: build_map(c)


with ThreadPoolExecutor(WORKERS) as ex:
    list(ex.map(work, todo))
for c in CHANS: save_npz(c); build_map(c)
print('done', {c: len(store[c]['ids']) for c in CHANS}, flush=True)
