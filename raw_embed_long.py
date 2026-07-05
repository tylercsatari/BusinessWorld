#!/usr/bin/env python3
"""
raw_embed_long.py — LONG-FORM sibling of raw_embed.py. Embeds the long-form corpus (the ~6k crawled
thumbnails) + our own account videos into the SAME 1536-d Gemini space, in three channels:
  visual   = the THUMBNAIL image (longform/thumbs/<id>.jpg)         → embed([img])
  text     = the video TITLE                                        → embed([title])
  together = thumbnail + title                                      → embed([img, title])
No ffmpeg montage / no Whisper (that's a Shorts-hook thing) — a long-form video's "hook" is its
thumbnail + title. Writes R2 raw-long/<chan>/embeddings.npz + raw-long/<chan>/map.json (same schema as
raw/*, served by /api/raw-long/map). Resumable: skips ids already embedded. Steering (per-account
keep→ctr etc.) is a SEPARATE step: add_steered_proj_long.py.

Run: python3 raw_embed_long.py   (env RAW_LONG_LIMIT=N for a test slice; RAW_LONG_SAVE_EVERY=250)
"""
import os, io, sys, json, time, base64, numpy as np, requests, warnings; warnings.filterwarnings('ignore')
try: requests.packages.urllib3.disable_warnings()
except Exception: pass
from sklearn.cross_decomposition import PLSRegression
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis as LDA
from sklearn.cluster import MiniBatchKMeans
HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    v = os.environ.get(k)
    if v: return v
    for ln in open(os.path.join(HERE, '.env')):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
import boto3
BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
def r2_get(k):
    try: return s3.get_object(Bucket=BUCKET, Key=k)['Body'].read()
    except Exception: return None
def r2_put(k, d, ct): s3.put_object(Bucket=BUCKET, Key=k, Body=d, ContentType=ct)

DIM = 1536
KEY = env('GEMINI_API_KEY')
EMB_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent'
CHANS = ['visual', 'text', 'together']
SAVE_EVERY = int(os.environ.get('RAW_LONG_SAVE_EVERY', '250'))
LIMIT = int(os.environ.get('RAW_LONG_LIMIT', '0'))

def embed(parts):
    for attempt in range(6):
        try:
            r = requests.post(EMB_URL, headers={'x-goog-api-key': KEY, 'Content-Type': 'application/json'},
                              json={'content': {'parts': parts}, 'outputDimensionality': DIM}, timeout=60)
            if r.status_code == 200:
                return np.asarray(r.json()['embedding']['values'], np.float32)
            if r.status_code in (429, 500, 503): time.sleep(2 * (attempt + 1)); continue
            print('  embed HTTP', r.status_code, r.text[:120], flush=True); return None
        except Exception as e:
            time.sleep(2 * (attempt + 1))
    return None
def img_part(b64): return {'inlineData': {'mimeType': 'image/jpeg', 'data': b64}}

def get_thumb(vid):
    b = r2_get(f'longform/thumbs/{vid}.jpg')          # crawled corpus thumbnails live here
    if b and len(b) > 1500: return b
    for nm in ('maxresdefault', 'hqdefault'):   # owned videos: pull from the public CDN (fast-fail)
        try:
            r = requests.get(f'https://i.ytimg.com/vi/{vid}/{nm}.jpg', timeout=(4, 8))
            if r.ok and len(r.content) > 1500: return r.content
        except Exception: pass
    return None

# ── source list: crawled corpus (longform-db) + our own account videos (mine=True) ──
def load_sources():
    src = {}   # id -> {id,title,views,subs,outlier,mine,owner}
    db = json.loads((r2_get('longform/db.json') or open(os.path.join(HERE, 'longform-db.json')).read() if os.path.exists(os.path.join(HERE, 'longform-db.json')) else '{"videos":{}}'))
    if isinstance(db, (bytes, bytearray)): db = json.loads(db)
    for v in db.get('videos', {}).values():
        if not v.get('stored'): continue
        vid = str(v.get('videoId') or '')
        if not vid: continue
        src[vid] = {'id': vid, 'title': v.get('title') or vid, 'views': float(v.get('views') or 0),
                    'subs': float(v.get('subs') or 0), 'outlier': float(v['outlier']) if v.get('outlier') is not None else np.nan,
                    'mine': False, 'owner': ''}
    # owned: every account's long-form videos win over a library dupe (mine=True)
    chans = json.loads((r2_get('longform/channels.json') or b'{"channels":[]}')).get('channels', [])
    for c in chans:
        t = json.loads(r2_get(f"longform/ret_{c['id']}.json") or b'{"videos":[]}')
        for v in t.get('videos', []):
            vid = str(v.get('id') or '')
            if not vid: continue
            base = src.get(vid, {})
            src[vid] = {'id': vid, 'title': v.get('title') or base.get('title') or vid,
                        'views': float(v.get('views') or base.get('views') or 0),
                        'subs': base.get('subs', 0.0), 'outlier': base.get('outlier', np.nan),
                        'mine': True, 'owner': c['id']}
    return list(src.values())

# ── per-channel accumulator, seeded from any existing npz (resume) ──
store = {c: {'ids': [], 'vecs': [], 'views': [], 'outlier': [], 'subs': [], 'title': [], 'txt': [], 'mine': [], 'owner': []} for c in CHANS}
def load_existing(c):
    buf = r2_get(f'raw-long/{c}/embeddings.npz')
    if not buf: return set()
    try:
        z = np.load(io.BytesIO(buf), allow_pickle=True); s = store[c]
        s['ids'] = [str(x) for x in z['ids']]; s['vecs'] = list(np.asarray(z['vecs'], np.float32))
        for k in ('views', 'outlier', 'subs'): s[k] = list(np.asarray(z[k], np.float64))
        for k in ('title', 'txt'): s[k] = [str(x) for x in z[k]]
        s['mine'] = [bool(x) for x in z['mine']]
        s['owner'] = [str(x) for x in z['owner']] if 'owner' in z.files else [''] * len(s['ids'])
        return set(s['ids'])
    except Exception:
        return set()

def save_npz(c):
    s = store[c]
    if not s['ids']: return
    bio = io.BytesIO()
    np.savez_compressed(bio, ids=np.array(s['ids'], object), vecs=np.array(s['vecs'], np.float32),
                        views=np.array(s['views'], np.float64), outlier=np.array(s['outlier'], np.float64),
                        subs=np.array(s['subs'], np.float64), title=np.array(s['title'], object), txt=np.array(s['txt'], object),
                        mine=np.array(s['mine'], bool), owner=np.array(s['owner'], object))
    r2_put(f'raw-long/{c}/embeddings.npz', bio.getvalue(), 'application/octet-stream')

def heldout(X, vv):
    try:
        from sklearn.linear_model import LogisticRegression, Ridge
        from sklearn.metrics import roc_auc_score
        Xn = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
        lv = np.log10(vv + 1); y10 = (vv > 1e7).astype(int)
        rng = np.random.RandomState(0); idx = rng.permutation(len(X)); cut = int(.7 * len(X)); tr, te = idx[:cut], idx[cut:]
        auc = 0.0
        if y10[tr].sum() > 5 and (len(tr) - y10[tr].sum()) > 5 and 0 < y10[te].sum() < len(te):
            p = LogisticRegression(max_iter=200).fit(Xn[tr], y10[tr]).predict_proba(Xn[te])[:, 1]
            auc = round(float(roc_auc_score(y10[te], p)), 3)
        pr = Ridge(1.0).fit(Xn[tr], lv[tr]).predict(Xn[te])
        r = round(float(np.corrcoef(pr, lv[te])[0, 1]), 3) if pr.std() > 1e-9 else 0.0
        return auc, r
    except Exception:
        return 0.0, 0.0

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
        def hocorr(axis, target):
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
        for nm, Y in [('views', lv), ('outlier', lo), ('both', np.column_stack([lv, lo]))]:
            try:
                m = PLSRegression(2).fit(Xn[tr], Y[tr]); add(nm, m.transform(Xn), True)
            except Exception: pass
        for nm, yb in [('hi10m', (vv > 1e7).astype(int)), ('hiout', (ovf >= np.nanpercentile(ovf, 85)).astype(int))]:
            if yb[tr].sum() > 5 and (len(tr) - yb[tr].sum()) > 5:
                try:
                    lx = LDA(n_components=1).fit(Xn[tr], yb[tr]).transform(Xn)[:, 0]; add(nm, np.column_stack([lx, Xc @ P[0]]), True)
                except Exception: pass
        clusters = {str(k): MiniBatchKMeans(k, random_state=0, n_init=3, batch_size=1024).fit_predict(Xn).tolist() for k in [6, 10, 16, 24] if len(Xn) >= k}
        auc, r = heldout(X, vv)
        mine = [bool(x) for x in s.get('mine', [])] or [False] * len(ids)
        out = {'n': len(ids), 'channel': c, 'updated': time.time(), 'proj': proj, 'heldout_auc10m': auc, 'heldout_rviews': r,
               'views': [float(x) for x in s['views']], 'outlier': [round(float(x), 1) if x == x else None for x in s['outlier']],
               'subs': [float(x) for x in s['subs']], 'id': list(ids), 'title': [str(t)[:60] for t in s['title']],
               'txt': [str(t)[:200] for t in s['txt']], 'mine': mine, 'silent': [False] * len(ids), 'owner': s.get('owner', [''] * len(ids)),
               'clusters': clusters, 'nmine': int(sum(mine)), 'nsilent': 0}
        r2_put(f'raw-long/{c}/map.json', json.dumps(out).encode(), 'application/json')
        print(f"  map[{c}]: n={len(ids)} mine={sum(mine)} AUC(>10M)={auc} r(views)={r} · " + ' '.join(f"{k}(v{proj[k]['cv']}/o{proj[k]['co']})" for k in proj), flush=True)
    except Exception as e:
        print(f'map[{c}] skipped:', str(e)[:140], flush=True)

def main():
    if not KEY: print('no GEMINI_API_KEY — abort', flush=True); sys.exit(1)
    done = {c: load_existing(c) for c in CHANS}
    print(f"resume: visual={len(done['visual'])} text={len(done['text'])} together={len(done['together'])} already embedded", flush=True)
    src = load_sources()
    # OWNED account videos FIRST (only ~50, and they're what matters most) — safe now that thumbnail
    # fetch fast-fails; then the ~6k corpus. Every re-run embeds any new owned before continuing corpus.
    src.sort(key=lambda v: not v['mine'])
    if LIMIT: src = src[:LIMIT]
    todo = [v for v in src if v['id'] not in done['together']]
    print(f"sources: {len(src)} ({sum(v['mine'] for v in src)} owned) · {len(todo)} to embed", flush=True)
    n = 0
    for v in todo:
        vid = v['id']
        tb = get_thumb(vid)
        if not tb: continue
        b64 = base64.b64encode(tb).decode()
        vis = embed([img_part(b64)]) if vid not in done['visual'] else None
        txt = embed([{'text': v['title'][:400]}]) if vid not in done['text'] else None
        tog = embed([img_part(b64), {'text': v['title'][:400]}]) if vid not in done['together'] else None
        for c, vec in [('visual', vis), ('text', txt), ('together', tog)]:
            if vec is None: continue
            s = store[c]
            s['ids'].append(vid); s['vecs'].append(vec); s['views'].append(v['views']); s['outlier'].append(v['outlier'])
            s['subs'].append(v['subs']); s['title'].append(v['title']); s['txt'].append(v['title']); s['mine'].append(v['mine']); s['owner'].append(v['owner'])
            done[c].add(vid)
        n += 1
        if n % 50 == 0: print(f"  embedded {n}/{len(todo)} (last: {v['title'][:44]!r} {v['views']:,.0f} views)", flush=True)
        if n % SAVE_EVERY == 0:
            for c in CHANS: save_npz(c); build_map(c)   # rebuild maps each checkpoint so the Raw tab fills progressively
            print(f"  ✓ checkpoint saved + maps rebuilt at {n}", flush=True)
    for c in CHANS: save_npz(c); build_map(c)
    print(f"done — embedded {n} this run. raw-long/{{visual,text,together}}/embeddings.npz + map.json on R2.", flush=True)

if __name__ == '__main__':
    main()
