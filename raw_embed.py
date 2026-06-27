#!/usr/bin/env python3
"""
RAW hook embeddings — the unsupervised playground. For every library video stored on R2, take the
FIRST 5 SECONDS, tile it into one montage (single resolution = the whole hook), and embed it with
Gemini multimodal (gemini-embedding-2, 1536-dim) so the conceptual+visual gestalt is captured in
one vector. NO labels, no interpretation — just embed and let clusters emerge. Resumable: tracks
which IDs are embedded (raw/manifest.json) and re-embeds new ones as the crawl grows. Stores
raw/embeddings.npz (vectors + metadata) and raw/map.json (UMAP-2D + k-means at several k) on R2.
Usage: python3 raw_embed.py   (env RAW_MAX caps how many to embed this run, default 5000)
"""
import os, sys, json, base64, subprocess, tempfile, shutil, time, io, threading
import numpy as np, boto3, urllib.request
from concurrent.futures import ThreadPoolExecutor
from sklearn.cluster import MiniBatchKMeans

HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    v = os.environ.get(k)
    if v: return v
    for ln in open(os.path.join(HERE, '.env')):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
KEY = env('GEMINI_API_KEY'); BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
DIM, WORKERS, RAW_MAX = 1536, 8, int(os.environ.get('RAW_MAX', '5000'))
EMB_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent'


def r2_get(key):
    try:
        return s3.get_object(Bucket=BUCKET, Key=key)['Body'].read()
    except Exception:
        return None
def r2_put(key, data, ct):
    s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=ct)


def embed_montage(b64, tries=6):
    body = json.dumps({'content': {'parts': [{'inlineData': {'mimeType': 'image/jpeg', 'data': b64}}]}, 'outputDimensionality': DIM}).encode()
    for a in range(tries):
        try:
            req = urllib.request.Request(EMB_URL, data=body, method='POST', headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
            with urllib.request.urlopen(req, timeout=60) as r:
                return np.array(json.loads(r.read())['embedding']['values'], np.float32)
        except Exception:
            if a < tries - 1:
                time.sleep(1.5 * (a + 1)); continue
            return None


def hook_montage(vid):
    tmp = tempfile.mkdtemp(prefix='raw_')
    try:
        mp4, mon = os.path.join(tmp, 'v.mp4'), os.path.join(tmp, 'm.jpg')
        s3.download_file(BUCKET, f'library/videos/{vid}.mp4', mp4)
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', mp4,
                        '-vf', 'fps=1,scale=320:-1,tile=5x1', '-frames:v', '1', mon], timeout=40)
        if not os.path.exists(mon):
            return None
        return base64.b64encode(open(mon, 'rb').read()).decode()
    except Exception:
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---- load library db (stored videos + metadata) ----
libdb = json.loads(r2_get('library/db.json') or b'{"videos":{}}')
stored = [v for v in libdb['videos'].values() if v.get('stored')]
print(f"library: {len(stored)} stored videos on R2", flush=True)

# ---- load existing embedding store (resumable) ----
ids, V, O, SU, TI, veclist = [], [], [], [], [], []
buf = r2_get('raw/embeddings.npz')
if buf:
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    ids = list(z['ids']); veclist = list(z['vecs']); V = list(z['views']); O = list(z['outlier']); SU = list(z['subs']); TI = list(z['title'])
done = set(ids)
todo = [v for v in stored if v['videoId'] not in done][:max(0, RAW_MAX - len(ids))]
print(f"already embedded: {len(ids)} · to embed now: {len(todo)} (RAW_MAX={RAW_MAX})", flush=True)
lock = threading.Lock(); cnt = [0]; t0 = time.time()


def save_all():
    if not ids:
        return
    Vec = np.array(veclist, np.float32)
    bio = io.BytesIO()
    np.savez_compressed(bio, ids=np.array(ids, object), vecs=Vec, views=np.array(V, np.float64),
                        outlier=np.array(O, np.float64), subs=np.array(SU, np.float64), title=np.array(TI, object))
    r2_put('raw/embeddings.npz', bio.getvalue(), 'application/octet-stream')
    r2_put('raw/manifest.json', json.dumps({'embedded': len(ids), 'updated': time.time()}).encode(), 'application/json')
    # projection + clustering (unsupervised)
    try:
        Xn = Vec / (np.linalg.norm(Vec, axis=1, keepdims=True) + 1e-9)
        import umap
        xy = umap.UMAP(n_neighbors=15, min_dist=0.1, metric='cosine', random_state=0).fit_transform(Xn) if len(Xn) >= 10 else np.zeros((len(Xn), 2))
        clusters = {}
        for k in [6, 10, 16, 24]:
            if len(Xn) >= k:
                clusters[str(k)] = MiniBatchKMeans(k, random_state=0, n_init=3, batch_size=1024).fit_predict(Xn).tolist()
        def g(a):
            a = np.asarray(a, float); lo, hi = np.nanpercentile(a, 2), np.nanpercentile(a, 98)
            return (np.clip((a - lo) / ((hi - lo) or 1), 0, 1) * 1000).round().astype(int)
        out = {'n': len(ids), 'updated': time.time(),
               'x': g(xy[:, 0]).tolist(), 'y': g(xy[:, 1]).tolist(),
               'views': [float(x) for x in V], 'outlier': [round(float(x), 1) if x == x else None for x in O],
               'subs': [float(x) for x in SU], 'id': list(ids), 'title': [str(t)[:60] for t in TI], 'clusters': clusters}
        r2_put('raw/map.json', json.dumps(out).encode(), 'application/json')
    except Exception as e:
        print('map build skipped:', str(e)[:80], flush=True)


def work(v):
    b64 = hook_montage(v['videoId'])
    if not b64:
        return
    e = embed_montage(b64)
    if e is None:
        return
    subs = v.get('subs') or 0
    with lock:
        ids.append(v['videoId']); V.append(v.get('views') or 0)
        O.append((v['views'] / subs) if subs else float('nan')); SU.append(subs); TI.append(v.get('title') or '')
        veclist.append(e)
        cnt[0] += 1
        if cnt[0] % 100 == 0:
            el = time.time() - t0
            print(f"  embedded {len(ids)} (+{cnt[0]}) · {el/60:.0f}m · ~{el/cnt[0]*len(todo)/60:.0f}m left", flush=True)
            save_all()


with ThreadPoolExecutor(WORKERS) as ex:
    list(ex.map(work, todo))
save_all()
print(f"done · {len(ids)} hooks embedded · raw/embeddings.npz + raw/map.json on R2", flush=True)
