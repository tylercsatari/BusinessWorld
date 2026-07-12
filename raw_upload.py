#!/usr/bin/env python3
"""
RAW upload — process ONE uploaded video exactly like a dataset hook, then locate it
in the existing embedding space by nearest neighbours (the maps only store 2D coords,
not the projection models, so a new vector is placed among the hooks it's most similar
to — consistent across all three channels/projections).

  args: --file <path> [--title <name>]
  stdout: JSON {montage (b64 jpeg), transcript, silent, channels:{visual,text,together}}
          each channel = {neighbors:[{id,sim}]} (text=null when no real voiceover)

Identical montage/whisper/embed to raw_embed.py so the upload's vectors are comparable.
"""
import os, sys, json, base64, subprocess, tempfile, shutil, io, time, re
import numpy as np, boto3, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    v = os.environ.get(k)
    if v: return v
    try:
        for ln in open(os.path.join(HERE, '.env')):
            if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception: pass
KEY = env('GEMINI_API_KEY'); BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
DIM = 1536
EMB_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent'

ENGWORDS = set()
try:
    for _w in open('/usr/share/dict/words'):
        _w = _w.strip().lower()
        if _w: ENGWORDS.add(_w)
except Exception: pass
def coherent(txt):
    toks = re.findall(r"[a-z']{2,}", (txt or '').lower())
    if len(toks) < 2: return False
    if not ENGWORDS: return len(toks) >= 3
    real = sum(1 for w in toks if w.strip("'") in ENGWORDS)
    return real >= 2 and real / len(toks) >= 0.5

def r2_get(key):
    try: return s3.get_object(Bucket=BUCKET, Key=key)['Body'].read()
    except Exception: return None

def embed(parts, tries=3):
    # bounded so 3 sequential embeds can't blow past the server's 240s kill (was 5×60s=300s PER call,
    # which intermittently hung the whole upload when Gemini was slow). 3×30s = 90s worst case per embed.
    body = json.dumps({'content': {'parts': parts}, 'outputDimensionality': DIM}).encode()
    for a in range(tries):
        try:
            req = urllib.request.Request(EMB_URL, data=body, method='POST', headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
            with urllib.request.urlopen(req, timeout=30) as r:
                return np.array(json.loads(r.read())['embedding']['values'], np.float32)
        except Exception:
            if a < tries - 1: time.sleep(1.0 * (a + 1)); continue
            return None
def img_part(b64): return {'inlineData': {'mimeType': 'image/jpeg', 'data': b64}}

def gemini_transcribe(wav):
    """Transcribe via the Gemini API — used where Whisper/torch isn't installed
    (e.g. the Render box). Returns (text, is_voiceover)."""
    try:
        data = base64.b64encode(open(wav, 'rb').read()).decode()
        url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'
        body = json.dumps({'contents': [{'parts': [
            {'inlineData': {'mimeType': 'audio/wav', 'data': data}},
            {'text': 'Transcribe ONLY the spoken words in this short audio, verbatim. If there is no speech (music or ambient noise only), reply with exactly: NO_SPEECH'}]}],
            'generationConfig': {'temperature': 0, 'topP': 1, 'topK': 1}}).encode()   # greedy → deterministic transcript (text/together stay stable on re-upload)
        req = urllib.request.Request(url, data=body, method='POST', headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read())
        t = (((j.get('candidates') or [{}])[0].get('content') or {}).get('parts') or [{}])[0].get('text', '').strip()
        if not t or 'NO_SPEECH' in t.upper(): return '', False
        return t, coherent(t)
    except Exception:
        return '', False

def whisper_text(wav):
    """Whisper-tiny where available (matches how the dataset was transcribed) with a Gemini
    SECOND OPINION: quiet or music-backed voiceovers routinely fail whisper-tiny's confidence
    gates and used to come back 'silent' even though speech exists. If whisper isn't confident,
    Gemini listens too — a hook is only called silent when BOTH hear nothing."""
    wtxt, wgood = '', False
    try:
        import whisper
        res = whisper.load_model('tiny').transcribe(wav, fp16=False)
        wtxt = (res.get('text') or '').strip()
        segs = res.get('segments') or []
        nsp = float(np.mean([sg.get('no_speech_prob', 0.0) for sg in segs])) if segs else 1.0
        alp = float(np.mean([sg.get('avg_logprob', -5.0) for sg in segs])) if segs else -5.0
        wgood = bool(wtxt) and nsp < 0.6 and alp > -1.0 and coherent(wtxt)
    except Exception:
        pass
    if wgood:
        return wtxt, True
    gtxt, ggood = gemini_transcribe(wav)
    if ggood and gtxt:
        return gtxt, True
    return (wtxt or gtxt), False

def _montage_audio(src, mon, wav):
    """Extract the 5-frame montage + first-5s audio→transcript from one source file.
    ffmpeg auto-detects the container/codec, so .mov/.mp4/.webm/.mkv all work here."""
    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', src, '-vf', 'fps=1,scale=320:-1,tile=5x1', '-frames:v', '1', mon], timeout=90)
    txt, good = '', False
    if os.path.exists(mon):
        try:
            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', src, '-vn', '-ar', '16000', '-ac', '1', wav], timeout=90)
            if os.path.exists(wav) and os.path.getsize(wav) > 1000: txt, good = whisper_text(wav)
        except Exception: pass
    return txt, good

def hook_inputs(src):
    """first-5s montage (b64) + (transcript, is_voiceover) from ANY local video file.
    Tries the file directly first; if ffmpeg can't decode it (exotic codec/container),
    normalizes to a clean H.264 mp4 and retries — so any uploadable format works."""
    tmp = tempfile.mkdtemp(prefix='rawup_')
    try:
        mon, wav, norm = os.path.join(tmp, 'm.jpg'), os.path.join(tmp, 'a.wav'), os.path.join(tmp, 'norm.mp4')
        txt, good = _montage_audio(src, mon, wav)
        if not os.path.exists(mon):                       # decode failed → transcode then retry
            try:
                subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-i', src, '-t', '6',
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', norm], timeout=180)
            except Exception: pass
            if os.path.exists(norm):
                for f in (mon, wav):
                    try: os.remove(f)
                    except Exception: pass
                txt, good = _montage_audio(norm, mon, wav)
        if not os.path.exists(mon): return None
        b64 = base64.b64encode(open(mon, 'rb').read()).decode()
        return b64, txt, good
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

import gc, tempfile
# The scorer was taking 310s on the deploy (>240s kill → error) vs 26s locally: re-downloading three
# ~72MB embedding files from R2 every upload and holding them in RAM swap-thrashed the tight box.
# Fix: keep a normalized copy on local disk (validated by the R2 ETag so it's never stale), memory-map
# it, and compute similarities in CHUNKS so a matmul never pulls the whole 72MB into RAM. First upload
# after a deploy warms the cache; every one after skips the download entirely. Result cached per request.
_CDIR = tempfile.gettempdir()
_NBR = {}
def _norm_emb(c):
    npy = os.path.join(_CDIR, f'rawemb_{c}.npy'); meta = os.path.join(_CDIR, f'rawemb_{c}.meta.json')
    etag = None
    try: etag = s3.head_object(Bucket=BUCKET, Key=f'raw/{c}/embeddings.npz').get('ETag')
    except Exception: pass
    if etag and os.path.exists(npy) and os.path.exists(meta):
        try:
            m = json.load(open(meta))
            if m.get('etag') == etag: return np.load(npy, mmap_mode='r'), m['ids']
        except Exception: pass
    buf = r2_get(f'raw/{c}/embeddings.npz')
    if buf is None: return None, None
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    V = np.array(z['vecs'], np.float32); ids = [str(x) for x in z['ids']]; del z, buf
    if len(V): V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
    try: np.save(npy, V); json.dump({'etag': etag, 'ids': ids}, open(meta, 'w'))
    except Exception: pass
    return V, ids
def neighbors(c, vec, k=12):
    if c not in _NBR:
        V, ids = _norm_emb(c)
        if V is None: _NBR[c] = None
        elif len(V) == 0: _NBR[c] = []
        else:
            q = (np.asarray(vec, np.float32) / (np.linalg.norm(vec) + 1e-9))
            n = len(V); sims = np.empty(n, np.float32)
            for i in range(0, n, 4096): sims[i:i + 4096] = np.asarray(V[i:i + 4096]) @ q   # chunked over the mmap → low RAM
            del V; gc.collect()
            kk = min(13, n)
            part = np.argpartition(-sims, kk - 1)[:kk]
            _NBR[c] = [{'id': ids[i], 'sim': round(float(sims[i]), 4)} for i in part[np.argsort(-sims[part])]]
    r = _NBR[c]
    return r if r is None else r[:k]

def _run():
    args = {}
    a = sys.argv[1:]
    for i in range(0, len(a) - 1, 2):
        if a[i].startswith('--'): args[a[i][2:]] = a[i + 1]
    # --image: a montage image is provided directly (built from photos in the browser)
    # with explicit --text; no ffmpeg/transcription needed. Otherwise --file is a video.
    dur_s = None                                           # full-video duration → predict-scope realistic views
    try:                                                   # the client may send the REAL full length (it trims the upload to 6s)
        if args.get('duration'): dur_s = float(args['duration'])
    except Exception: dur_s = None
    if args.get('image'):
        img = args['image']
        if not os.path.exists(img):
            print(json.dumps({'error': 'no image'})); return
        b64 = base64.b64encode(open(img, 'rb').read()).decode()
        txt = (args.get('text') or '').strip()
        good = bool(txt)                                   # user-set text is used verbatim
    else:
        path = args.get('file')
        if not path or not os.path.exists(path):
            print(json.dumps({'error': 'no file'})); return
        inp = hook_inputs(path)
        if not inp:
            print(json.dumps({'error': 'could not read this video — ffmpeg failed to decode it even after transcoding'})); return
        b64, txt, good = inp
        if dur_s is None:                                  # only ffprobe if the client didn't send the real duration (else we'd read the 6s clip)
            try:
                r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                                   capture_output=True, text=True, timeout=20)
                dur_s = float(r.stdout.strip()) if r.stdout.strip() else None
            except Exception: dur_s = None
    ev = embed([img_part(b64)])
    et = embed([{'text': txt}]) if good else None
    eg = embed([img_part(b64)] + ([{'text': txt}] if good else []))
    # score the hook on every validated indicator (project its embedding onto the
    # registry's probe weights; + per-modality global novelty from the neighbours).
    indicators = {}
    try:
        wb = r2_get('raw/indicators/weights.npz')
        embmap = {'visual': ev, 'text': et, 'together': eg}
        if wb:
            W = np.load(io.BytesIO(wb), allow_pickle=True)
            for key in W.files:                         # content_{mod}__{target}
                mod = key.split('content_')[-1].split('__')[0]; e = embmap.get(mod)
                if e is None: continue
                en = e / (np.linalg.norm(e) + 1e-9); w = W[key]
                indicators[key] = round(float(en @ w[:-1] + w[-1]), 4)
        skof = {'visual': 'vis', 'text': 'txt', 'together': 'tog'}
        for mod, e in embmap.items():                   # global novelty = mean cos-dist to nearest hooks
            if e is None: continue
            nb = neighbors(mod, e, k=13)
            if nb: indicators[f'nov_{skof[mod]}_global'] = round(float(np.mean([1 - x['sim'] for x in nb])), 4)
        # niche / temporal / combinatorial novelty via the saved corpus models
        mb = r2_get('raw/novelty_models.npz')
        if mb:
            M = np.load(io.BytesIO(mb), allow_pickle=True)
            nrm = {'vis': ev, 'txt': et, 'tog': eg}
            for sk, e in nrm.items():
                if e is None: continue
                en = np.asarray(e, float); en = en / (np.linalg.norm(en) + 1e-9)
                cen = M[f'{sk}_centroids']; indicators[f'nov_{sk}_niche'] = round(float(1 - np.max(cen @ en)), 4)
                rc = M[f'{sk}_recent']; indicators[f'nov_{sk}_temporal'] = round(float(1 - en @ rc), 4)
                comp = M[f'{sk}_pca_comp']; mu = M[f'{sk}_pca_mean']; recon = mu + (en - mu) @ comp.T @ comp
                indicators[f'nov_{sk}_combinatorial'] = round(float(np.linalg.norm(en - recon) / (np.linalg.norm(en) + 1e-9)), 4)
            if ev is not None and et is not None:
                vn = np.asarray(ev, float); vn /= (np.linalg.norm(vn) + 1e-9); tn = np.asarray(et, float); tn /= (np.linalg.norm(tn) + 1e-9)
                indicators['nov_coherence'] = round(float(vn @ tn), 4)
                if eg is not None:
                    gn = np.asarray(eg, float); gn /= (np.linalg.norm(gn) + 1e-9); mix = (vn + tn); mix /= (np.linalg.norm(mix) + 1e-9)
                    indicators['nov_fusion_combinatorial'] = round(float(1 - gn @ mix), 4)
    except Exception: pass
    # STEERED estimate — the ONE global number. Project the upload onto the same linear
    # direction the 11k map uses for each (channel × metric), then map it exactly the way
    # the map does: keep/ret5 quantile-map onto your 211's actual outcomes; views/outlier
    # quantile-map onto the corpus distribution; >10M = local >10M rate around the hook's
    # rank. Whatever the graph shows for a video, an upload gets the identical maths.
    steer = {}
    try:
        sb = r2_get('raw/steer_models.npz')
        if sb:
            SM = np.load(io.BytesIO(sb), allow_pickle=True); keys = set(SM.files)
            for mod, e in {'visual': ev, 'text': et, 'together': eg}.items():
                if e is None: continue
                en = np.asarray(e, float); en = en / (np.linalg.norm(en) + 1e-9)
                for tgt in ('keep', 'ret5', 'views', 'outlier', 'gt10M'):
                    ck = f'{mod}_{tgt}_coef'
                    if ck not in keys: continue
                    pred = float(en @ SM[ck] + SM[f'{mod}_{tgt}_int'])
                    psort = SM[f'{mod}_{tgt}_psort']
                    rank = float(np.searchsorted(psort, pred)) / max(1, len(psort) - 1)
                    rank = min(1.0, max(0.0, rank))
                    kind = str(SM[f'{mod}_{tgt}_kind']) if f'{mod}_{tgt}_kind' in keys else 'pct'
                    if kind == 'binary':                                    # >10M class: local rate in a ±5% rank window
                        yb = SM[f'{mod}_{tgt}_ybypred']; n = len(yb); c = int(round(rank * (n - 1))); w = max(1, n // 20)
                        est = float(yb[max(0, c - w):min(n, c + w)].mean())
                    else:
                        ysort = SM[f'{mod}_{tgt}_ysort']; yv = float(ysort[int(round(rank * (len(ysort) - 1)))])
                        est = float(10 ** yv) if kind in ('logcount', 'logx') else yv
                    steer[f'{mod}_{tgt}'] = {'est': round(est, 4) if est < 100 else round(est), 'pctile': round(rank * 100, 1), 'kind': kind}
            # REALISTIC VIEWS (predict-scope): feed the steered keep/ret5 ests + this video's real
            # duration through the 211's retention→views model → views on Tyler's channel scale.
            if 'PSCOPE' in keys:
                # video upload → its real (ffprobed) duration; 5-frame build → no duration, so
                # assume a generic 30s short. keep + ret5 + log_dur all feed the predict-scope.
                have_dur = bool(dur_s and dur_s > 0)
                dv = dur_s if have_dur else 30.0
                PS = SM['PSCOPE']; ld = float(np.log10(dv + 1))
                for mod in ('visual', 'text', 'together'):
                    kk = steer.get(f'{mod}_keep'); rr = steer.get(f'{mod}_ret5')
                    if kk and rr:
                        rv = float(10 ** (PS[0] * kk['est'] + PS[1] * rr['est'] + PS[2] * ld + PS[3]))
                        steer[f'{mod}_realviews'] = {'est': round(rv), 'pctile': None, 'kind': 'realviews', 'dur_s': round(dv), 'dur_assumed': not have_dur}
    except Exception: pass
    def preview(e):
        if e is None: return None
        a = np.asarray(e, float)
        return [round(float(x), 3) for x in (a[:1536].reshape(48, 32).mean(1) if len(a) >= 1536 else a)]
    input_manifest = {
        'domain': 'shorts_raw',
        'scorer': 'raw_upload.py',
        'source_window': 'first 5 seconds',
        'display_preference': ['together', 'text', 'visual'],
        'transcript_used': bool(good),
        'duration_s': round(float(dur_s), 3) if dur_s else None,
        'channels': {
            'visual': {
                'present': ev is not None,
                'input': '5-frame montage only',
                'image': 'five frames sampled from the first 5 seconds and stitched left to right',
                'text': '',
            },
            'text': {
                'present': bool(good and et is not None),
                'input': 'first-5-second transcript only',
                'image': '',
                'text': txt if good else '',
            },
            'together': {
                'present': eg is not None,
                'input': '5-frame montage plus first-5-second transcript' if good else '5-frame montage only because no coherent voiceover was detected',
                'image': 'five frames sampled from the first 5 seconds and stitched left to right',
                'text': txt if good else '',
            },
        },
    }
    out = {
        'montage': b64,
        'transcript': txt if good else '',
        'silent': (not good),
        'title': args.get('title', 'My hook'),
        'indicators': indicators,
        'steer': steer,
        'emb_preview': {'visual': preview(ev), 'text': preview(et), 'together': preview(eg)},
        'input_manifest': input_manifest,
        'channels': {
            'visual': {'neighbors': neighbors('visual', ev)} if ev is not None else None,
            'text': ({'neighbors': neighbors('text', et)} if (good and et is not None) else None),
            'together': {'neighbors': neighbors('together', eg)} if eg is not None else None,
        },
    }
    print(json.dumps(out))

def main():
    try:
        _run()
    except Exception as e:
        import traceback
        print(json.dumps({'error': 'processing failed: ' + str(e)[:200], 'trace': traceback.format_exc()[-500:]}))

if __name__ == '__main__':
    main()
