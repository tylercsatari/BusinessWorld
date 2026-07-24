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
import os, sys, json, base64, subprocess, tempfile, shutil, time, io, threading, re
import numpy as np, boto3, urllib.request
from concurrent.futures import ThreadPoolExecutor
from sklearn.cluster import MiniBatchKMeans
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import roc_auc_score
from sklearn.cross_decomposition import PLSRegression
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis as LDA

# ---- coherent-speech gate: many shorts are music/ambient with no voiceover, and
#      Whisper-tiny HALLUCINATES junk words on them. Those fake transcripts would
#      pollute the text/together spaces, so we detect "no real voiceover" and treat
#      such videos as SILENT (no text vector; together = image-only). ----
ENGWORDS = set()
try:
    for _w in open('/usr/share/dict/words'):
        _w = _w.strip().lower()
        if _w: ENGWORDS.add(_w)
except Exception:
    pass
def coherent(txt):
    """True only if the transcript looks like a real, coherent English voiceover."""
    toks = re.findall(r"[a-z']{2,}", (txt or '').lower())
    if len(toks) < 2:
        return False                      # empty or a single token → not a voiceover
    if not ENGWORDS:
        return len(toks) >= 3             # no dictionary available → length fallback
    real = sum(1 for w in toks if w.strip("'") in ENGWORDS)
    return real >= 2 and real / len(toks) >= 0.5

HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    v = os.environ.get(k)
    if v: return v
    for ln in open(os.path.join(HERE, '.env')):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
KEY = env('GEMINI_API_KEY'); BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
import random
DIM = 1536
WORKERS = int(os.environ.get('RAW_WORKERS', '6'))      # lower (e.g. 2) for owned/YouTube downloads to avoid bot-detection bursts
RAW_MAX = int(os.environ.get('RAW_MAX', '1000000'))    # default: everything stored
OWNED_JITTER = float(os.environ.get('RAW_OWNED_JITTER', '0'))   # seconds of random pre-download sleep on YouTube pulls (gentle pacing)
BACKFILL_MODE = os.environ.get('RAW_BACKFILL') == '1'
CHECKPOINT_EVERY = max(100, int(os.environ.get('RAW_CHECKPOINT_EVERY', '5000' if BACKFILL_MODE else '100')))
MAP_EVERY = max(0, int(os.environ.get('RAW_MAP_EVERY', '0' if BACKFILL_MODE else '500')))
STATUS_EVERY = max(10, int(os.environ.get('RAW_STATUS_EVERY', '50')))
STREAM_R2 = os.environ.get('RAW_STREAM_R2', '1') != '0'
EMB_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent'
CHANS = ['visual', 'text', 'together']

_wlock = threading.Lock(); _wmodel = [None]
def whisper_text(wav):
    """Returns (transcript, is_real_voiceover). Combines Whisper's own confidence
    (no_speech_prob / avg_logprob) with the coherent() English check."""
    import whisper
    with _wlock:
        if _wmodel[0] is None:
            _wmodel[0] = whisper.load_model('tiny')
        try:
            res = _wmodel[0].transcribe(wav, fp16=False)
        except Exception:
            return '', False
    txt = (res.get('text') or '').strip()
    segs = res.get('segments') or []
    nsp = float(np.mean([sg.get('no_speech_prob', 0.0) for sg in segs])) if segs else 1.0
    alp = float(np.mean([sg.get('avg_logprob', -5.0) for sg in segs])) if segs else -5.0
    good = bool(txt) and nsp < 0.6 and alp > -1.0 and coherent(txt)
    return txt, good


def r2_get(key):
    try: return s3.get_object(Bucket=BUCKET, Key=key)['Body'].read()
    except Exception: return None
def r2_put(key, data, ct): s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=ct)
def emit_status(stage, **extra):
    payload = {
        'version': 1, 'stage': stage, 'heartbeat': int(time.time() * 1000),
        'workerPid': os.getpid(), 'workers': WORKERS, 'checkpointEvery': CHECKPOINT_EVERY,
        'streamingFirstFiveSeconds': STREAM_R2, **extra,
    }
    try: r2_put('raw/predictor-lab/embed-status.json', json.dumps(payload).encode(), 'application/json')
    except Exception: pass


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


def hook_inputs(vid, src='lib'):
    """download → first-5s montage (saved to R2) b64 + (transcript, is_voiceover).
    src='lib' pulls the stored R2 video; src='owned' pulls the user's video from
    YouTube via yt-dlp. EVERYTHING ELSE (montage tiling, audio, Whisper) is identical,
    so an owned hook is embedded exactly like a library hook. None on failure."""
    tmp = tempfile.mkdtemp(prefix='raw_')
    try:
        mp4, mon, wav = os.path.join(tmp, 'v.mp4'), os.path.join(tmp, 'm.jpg'), os.path.join(tmp, 'a.wav')
        if src == 'owned':
            if OWNED_JITTER: time.sleep(random.uniform(0, OWNED_JITTER))   # gentle pacing so concurrent pulls don't burst → bot wall
            # The DEFAULT 'web' player client is bot-walled ("confirm you're not a bot"); these
            # alternate clients are NOT — they download cookielessly even when the IP is flagged.
            pc = os.environ.get('RAW_PLAYER_CLIENT', 'web_safari,mweb,tv_embedded,web_embedded')
            ck = os.environ.get('RAW_COOKIES_BROWSER'); ckf = os.environ.get('RAW_COOKIES')
            cmd = ['yt-dlp', '--no-playlist', '-q', '--no-warnings', '--merge-output-format', 'mp4',
                   '--extractor-args', f'youtube:player_client={pc}',
                   '-f', 'bv*[height<=720]+ba/b[height<=720]/best', '-o', mp4]
            if ckf: cmd += ['--cookies', ckf]
            elif ck: cmd += ['--cookies-from-browser', ck]
            subprocess.run(cmd + [f'https://www.youtube.com/watch?v={vid}'], timeout=240)
            if not os.path.exists(mp4):
                for f in os.listdir(tmp):                      # yt-dlp may append an ext
                    if f.startswith('v.'): mp4 = os.path.join(tmp, f); break
            if not os.path.exists(mp4): return None
        else:
            streamed = False
            if STREAM_R2:
                try:
                    signed = s3.generate_presigned_url(
                        'get_object',
                        Params={'Bucket': BUCKET, 'Key': f'library/videos/{vid}.mp4'},
                        ExpiresIn=600,
                    )
                    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-i', signed, '-t', '5',
                                    '-vf', 'fps=1,scale=320:-1,tile=5x1', '-frames:v', '1', mon], timeout=60)
                    if os.path.exists(mon):
                        streamed = True
                        try:
                            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-i', signed, '-t', '5',
                                            '-vn', '-ar', '16000', '-ac', '1', wav], timeout=60)
                        except Exception:
                            pass
                except Exception:
                    streamed = False
            if not streamed:
                s3.download_file(BUCKET, f'library/videos/{vid}.mp4', mp4)
        if src == 'owned' or not STREAM_R2 or not os.path.exists(mon):
            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', mp4, '-vf', 'fps=1,scale=320:-1,tile=5x1', '-frames:v', '1', mon], timeout=40)
        if not os.path.exists(mon): return None
        montage = open(mon, 'rb').read()
        r2_put(f'raw/montage/{vid}.jpg', montage, 'image/jpeg')
        b64 = base64.b64encode(montage).decode()
        txt, good = '', False
        try:
            if not os.path.exists(wav) and os.path.exists(mp4):
                subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', mp4, '-vn', '-ar', '16000', '-ac', '1', wav], timeout=40)
            if os.path.exists(wav): txt, good = whisper_text(wav)
        except Exception: pass
        return b64, txt, good
    except Exception:
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---- load library (metadata) ----
libdb = json.loads(r2_get('library/db.json') or b'{"videos":{}}')
def is_stored_short(v):
    try:
        return (
            bool(v.get('stored') and v.get('videoId'))
            and float(v.get('height') or 0) > float(v.get('width') or 0)
            and 0 < float(v.get('durationSec') or 0) <= 180
        )
    except (TypeError, ValueError):
        return False
stored = [{'videoId': v['videoId'], 'views': v.get('views'), 'subs': v.get('subs'),
           'title': v.get('title'), 'outlier': v.get('outlier'), 'src': 'lib', 'mine': False}
          for v in libdb['videos'].values() if is_stored_short(v)]
scienceids = {v['videoId'] for v in stored}
print(f"library: {len(stored)} stored vertical Shorts on R2", flush=True)

# ---- load OWNED videos from EVERY account (channels.json) — same pipeline, mine=True, tagged with
#      the owning account so steered keep/ret5/realviews can later be refit per account. Main = the
#      committed retention_table.json; every other account = R2 retention/<id>.json. ----
OWNED = []
try:
    _ch = json.loads((r2_get('retention/channels.json') or b'{"channels":[]}')).get('channels', [])
except Exception:
    _ch = []
if not any(c.get('id') == 'tyler' for c in _ch):
    _ch = [{'id': 'tyler', 'owner': True, 'name': 'Main'}] + _ch
seen_owned = set()
for c in _ch:
    cid = c.get('id')
    try:
        if c.get('owner') or cid == 'tyler':
            rt = json.loads(open(os.path.join(HERE, 'buildings/jarvis/retention-study/retention_table.json')).read())
        else:
            rt = json.loads(r2_get(f'retention/{cid}.json') or b'{"videos":[]}')
    except Exception as e:
        print(f'owned[{cid}] load failed:', str(e)[:100], flush=True); continue
    nadd = 0
    for v in rt.get('videos', []):
        vid = v.get('id') or v.get('videoId')
        if not vid or vid in seen_owned: continue
        seen_owned.add(vid)
        OWNED.append({'videoId': vid, 'views': v.get('views'), 'subs': v.get('subs'),
                      'title': v.get('title'), 'outlier': v.get('outlier'), 'src': 'owned', 'mine': True, 'owner': cid})
        nadd += 1
    print(f'  owned[{cid}]: {nadd} videos', flush=True)
mineids = {v['videoId'] for v in OWNED}
stored = [v for v in stored if v['videoId'] not in mineids] + OWNED   # owned wins (mine=True)
print(f"owned: {len(OWNED)} across {len(_ch)} accounts · total to consider: {len(stored)}", flush=True)

# ---- per-channel stores (migrate old raw/embeddings.npz → visual) ----
store = {c: {'ids': [], 'vecs': [], 'views': [], 'outlier': [], 'subs': [], 'title': [], 'txt': [], 'mine': [], 'silent': []} for c in CHANS}
def load_chan(c):
    buf = r2_get(f'raw/{c}/embeddings.npz') or (r2_get('raw/embeddings.npz') if c == 'visual' else None)
    if not buf: return
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    s = store[c]; s['ids'] = list(z['ids']); s['vecs'] = list(z['vecs'])
    for k in ['views', 'outlier', 'subs', 'title']: s[k] = list(z[k])
    n = len(s['ids'])
    s['txt'] = list(z['txt']) if 'txt' in z.files else [''] * n
    base_mine = [bool(x) for x in z['mine']] if 'mine' in z.files else [False] * n
    s['mine'] = [base_mine[i] or (s['ids'][i] in mineids) for i in range(n)]   # an owned id is always mine, even if it was first seen as a library video
    s['silent'] = [bool(x) for x in z['silent']] if 'silent' in z.files else [not coherent(t) for t in s['txt']]
for c in CHANS: load_chan(c)
done = {c: set(store[c]['ids']) for c in CHANS}
print({c: len(done[c]) for c in CHANS}, flush=True)

# ---- which montages already exist on R2 (bulk list, so we can backfill any
#      video that got embedded but never had its frame-stitch saved) ----
def list_montages():
    have, tok = set(), None
    while True:
        kw = {'Bucket': BUCKET, 'Prefix': 'raw/montage/', 'MaxKeys': 1000}
        if tok: kw['ContinuationToken'] = tok
        r = s3.list_objects_v2(**kw)
        for o in r.get('Contents', []):
            k = o['Key']
            if k.endswith('.jpg'): have.add(k[len('raw/montage/'):-4])
        if r.get('IsTruncated'): tok = r.get('NextContinuationToken')
        else: break
    return have
have_montage = list_montages()
print(f"montages on R2: {len(have_montage)}", flush=True)

# ---- one-time cleanup of already-embedded data for the no-voiceover gate ----
def _reembed_imgonly(args):
    c, i = args
    vid = store[c]['ids'][i]
    b = r2_get(f'raw/montage/{vid}.jpg')
    if not b: return (i, None)
    return (i, embed([img_part(base64.b64encode(b).decode())]))
def migrate_clean():
    # TEXT channel: keep ONLY coherent voiceovers; drop music/hallucinated junk.
    s = store['text']
    keep = [i for i, t in enumerate(s['txt']) if coherent(t)]
    if len(keep) != len(s['ids']):
        for k in list(s.keys()): s[k] = [s[k][i] for i in keep]
        print(f"text: pruned {len(keep)} coherent voiceovers (dropped junk)", flush=True)
    s['silent'] = [False] * len(s['ids'])
    # VISUAL + TOGETHER keep every video, but flag the silent ones. A video HAS a
    # voiceover iff it produced a text embedding — derive silence from text-channel
    # membership (authoritative + consistent), NOT each channel's own stored txt
    # (the earliest-migrated visual rows have no txt and would falsely read silent).
    voiced = set(store['text']['ids'])
    for c in ['visual', 'together']:
        store[c]['silent'] = [vid not in voiced for vid in store[c]['ids']]
    # TOGETHER: any hook that fused HALLUCINATED text → re-embed image-only (cheap:
    # the montage is already on R2, so no re-download), so junk text can't confound it.
    st = store['together']
    bad = [i for i, t in enumerate(st['txt']) if t and not coherent(t)]
    if bad:
        print(f"together: re-embedding {len(bad)} hooks image-only (had hallucinated text)…", flush=True)
        with ThreadPoolExecutor(WORKERS) as ex:
            for i, e in ex.map(_reembed_imgonly, [('together', i) for i in bad]):
                if e is not None: st['vecs'][i] = e; st['txt'][i] = ''; st['silent'][i] = True
        print("together: image-only re-embed done", flush=True)
    for c in CHANS: done[c] = set(store[c]['ids'])

# A video is COMPLETE when it has both visual + together embeddings AND a montage
# on R2. (Text is best-effort — only videos with first-5s speech get a text vector,
# so it must NOT gate completeness or no-speech videos would reprocess forever.)
def needs(v):
    vid = v['videoId']
    return (vid not in done['visual']) or (vid not in done['together']) or (vid not in have_montage)

todo = [v for v in stored if needs(v)]
if os.environ.get('RAW_OWNED_ONLY') == '1':
    todo = [v for v in todo if v.get('mine')]   # gentle account-only grind (skip the big library backlog)
todo.sort(key=lambda v: not v.get('mine'))      # OWNED (account) videos FIRST — the priority; the library backlog embeds after
todo = todo[:RAW_MAX]
lock = threading.Lock(); cnt = [0]; completed = [0]; fails = [0]; t0 = time.time()
print(f"todo: {len(todo)} of {len(stored)} stored need embedding and/or a montage", flush=True)


def science_complete():
    return {c: len(done[c] & scienceids) for c in CHANS}


emit_status('running' if todo else 'complete', discovered=len(stored), eligible=len(stored), queued=len(todo),
            processed=0, failed=0, complete={c: len(done[c]) for c in CHANS},
            scienceEligible=len(scienceids), scienceComplete=science_complete(),
            message='Embedding canonical first-five-second inputs')


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
        mine = [bool(x) for x in s.get('mine', [])] or [False] * len(ids)
        silent = [bool(x) for x in s.get('silent', [])] or [False] * len(ids)
        out = {'n': len(ids), 'channel': c, 'updated': time.time(), 'proj': proj, 'heldout_auc10m': auc, 'heldout_rviews': r,
               'views': [float(x) for x in s['views']], 'outlier': [round(float(x), 1) if x == x else None for x in s['outlier']],
               'subs': [float(x) for x in s['subs']], 'id': list(ids), 'title': [str(t)[:60] for t in s['title']],
               'txt': [str(t)[:200] for t in s['txt']], 'mine': mine, 'silent': silent, 'clusters': clusters,
               'nmine': int(sum(mine)), 'nsilent': int(sum(silent))}
        r2_put(f'raw/{c}/map.json', json.dumps(out).encode(), 'application/json')
        print(f"  map[{c}]: n={len(ids)} mine={sum(mine)} silent={sum(silent)} held-out AUC(>10M)={auc} r(views)={r} · " + ' '.join(f"{k}(v{proj[k]['cv']}/o{proj[k]['co']})" for k in proj), flush=True)
    except Exception as e:
        print(f'map[{c}] skipped:', str(e)[:120], flush=True)


def save_npz(c):
    s = store[c]
    if not s['ids']: return
    bio = io.BytesIO()
    n = len(s['ids'])
    mine = (s.get('mine') or [False] * n)[:n] + [False] * max(0, n - len(s.get('mine') or []))
    silent = (s.get('silent') or [False] * n)[:n] + [False] * max(0, n - len(s.get('silent') or []))
    np.savez_compressed(bio, ids=np.array(s['ids'], object), vecs=np.array(s['vecs'], np.float32),
                        views=np.array(s['views'], np.float64), outlier=np.array(s['outlier'], np.float64),
                        subs=np.array(s['subs'], np.float64), title=np.array(s['title'], object), txt=np.array(s['txt'], object),
                        mine=np.array(mine, bool), silent=np.array(silent, bool))
    r2_put(f'raw/{c}/embeddings.npz', bio.getvalue(), 'application/octet-stream')


migrate_clean()                # apply the no-voiceover gate to already-embedded data
if not BACKFILL_MODE:
    for c in CHANS: save_npz(c)     # persist mine/silent flags + cleaned text/together
    for c in CHANS: build_map(c)    # immediate maps from whatever's already embedded


def work(v):
    vid = v['videoId']
    if not needs(v): return
    inp = hook_inputs(vid, v.get('src', 'lib'))   # always (re)saves the montage to R2
    if not inp:
        with lock: fails[0] += 1
        return
    b64, txt, good = inp     # good = genuine coherent voiceover (else SILENT)
    have_montage.add(vid)    # montage now guaranteed on R2
    embeds = {}
    if vid not in done['visual']: embeds['visual'] = embed([img_part(b64)])
    if good and vid not in done['text']: embeds['text'] = embed([{'text': txt}])
    if vid not in done['together']:
        # With no voiceover the visual and together requests contain the exact same
        # content. Reuse that deterministic vector instead of paying for it twice.
        embeds['together'] = embeds.get('visual') if not good and embeds.get('visual') is not None else embed([img_part(b64)] + ([{'text': txt}] if good else []))
    mine = bool(v.get('mine'))
    with lock:
        ov = v.get('outlier')
        if ov is None and v.get('views') and v.get('subs'): ov = v['views'] / v['subs']
        meta = (v.get('views') or 0, float(ov) if ov is not None else float('nan'), v.get('subs') or 0, v.get('title') or '')
        for c, e in embeds.items():
            if e is None: continue
            s = store[c]; s['ids'].append(vid); s['vecs'].append(e)
            s['views'].append(meta[0]); s['outlier'].append(meta[1]); s['subs'].append(meta[2]); s['title'].append(meta[3])
            s['txt'].append(txt if good else '')   # '' when no real voiceover → silent is derivable from txt
            s['mine'].append(mine); s['silent'].append(False if c == 'text' else (not good))
            done[c].add(vid)
        required_ok = vid in done['visual'] and vid in done['together'] and vid in have_montage
        if required_ok:
            completed[0] += 1
        else:
            # A quota or transient API failure can return no vector after all
            # retries. Keep the video unresolved so the next resumable pass
            # retries it instead of reporting a false completion.
            fails[0] += 1
        cnt[0] += 1
        if cnt[0] % STATUS_EVERY == 0:
            el = time.time() - t0
            nm = sum(store['visual']['mine'])
            unresolved = len(todo) - completed[0]
            print(f"  attempted {cnt[0]}/{len(todo)} · stored {completed[0]} · unresolved {unresolved} · {el/60:.0f}m · visual {len(store['visual']['ids'])} text {len(store['text']['ids'])} together {len(store['together']['ids'])} · mine {nm} · failed attempts {fails[0]}", flush=True)
            rate = cnt[0] / max(el, 1)
            emit_status('running', discovered=len(stored), eligible=len(stored), queued=max(0, unresolved),
                        attempted=cnt[0], processed=completed[0], failed=fails[0], complete={c: len(done[c]) for c in CHANS},
                        scienceEligible=len(scienceids), scienceComplete=science_complete(),
                        ratePerMinute=round(rate * 60, 2), etaSeconds=round(unresolved / rate) if rate > 0 else None,
                        message=f'Attempted {cnt[0]:,}; stored {completed[0]:,}; {unresolved:,} unresolved')
        if cnt[0] % CHECKPOINT_EVERY == 0:
            for c in CHANS: save_npz(c)
            if MAP_EVERY and cnt[0] % MAP_EVERY == 0:
                for c in CHANS: build_map(c)


with ThreadPoolExecutor(WORKERS) as ex:
    list(ex.map(work, todo))
for c in CHANS:
    save_npz(c)
remaining = [v for v in stored if needs(v)]
if remaining:
    emit_status('retrying', discovered=len(stored), eligible=len(stored), queued=len(remaining),
                attempted=cnt[0], processed=completed[0], failed=fails[0],
                complete={c: len(done[c]) for c in CHANS},
                scienceEligible=len(scienceids), scienceComplete=science_complete(),
                message=f'{len(remaining):,} unresolved Shorts will retry from the durable checkpoint')
    print(f"retry required: {len(remaining)} videos still lack a required visual/together vector", flush=True)
    sys.exit(2)
if not BACKFILL_MODE:
    # A full 60K-point SVD/UMAP map is both memory-heavy and unusable in the
    # browser. The backfill updates the canonical vectors; the existing map stays
    # live until the dedicated sampled-map builder refreshes it.
    for c in CHANS:
        build_map(c)
emit_status('complete', discovered=len(stored), eligible=len(stored), queued=0,
            attempted=cnt[0], processed=completed[0], failed=fails[0],
            complete={c: len(done[c]) for c in CHANS}, ratePerMinute=round(cnt[0] / max(time.time() - t0, 1) * 60, 2),
            scienceEligible=len(scienceids), scienceComplete=science_complete(),
            etaSeconds=0, message='Canonical Science Center embedding pass complete')
print('done', {c: len(store[c]['ids']) for c in CHANS}, 'fails', fails[0], flush=True)
print('(re-run to retry any fails — they stay in `todo` until embedded + montaged)', flush=True)
