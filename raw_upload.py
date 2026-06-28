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

def embed(parts, tries=5):
    body = json.dumps({'content': {'parts': parts}, 'outputDimensionality': DIM}).encode()
    for a in range(tries):
        try:
            req = urllib.request.Request(EMB_URL, data=body, method='POST', headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
            with urllib.request.urlopen(req, timeout=60) as r:
                return np.array(json.loads(r.read())['embedding']['values'], np.float32)
        except Exception:
            if a < tries - 1: time.sleep(1.2 * (a + 1)); continue
            return None
def img_part(b64): return {'inlineData': {'mimeType': 'image/jpeg', 'data': b64}}

def whisper_text(wav):
    import whisper
    try:
        res = whisper.load_model('tiny').transcribe(wav, fp16=False)
    except Exception:
        return '', False
    txt = (res.get('text') or '').strip()
    segs = res.get('segments') or []
    nsp = float(np.mean([sg.get('no_speech_prob', 0.0) for sg in segs])) if segs else 1.0
    alp = float(np.mean([sg.get('avg_logprob', -5.0) for sg in segs])) if segs else -5.0
    return txt, (bool(txt) and nsp < 0.6 and alp > -1.0 and coherent(txt))

def hook_inputs(mp4):
    """first-5s montage (b64) + (transcript, is_voiceover) from a LOCAL file."""
    tmp = tempfile.mkdtemp(prefix='rawup_')
    try:
        mon, wav = os.path.join(tmp, 'm.jpg'), os.path.join(tmp, 'a.wav')
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', mp4, '-vf', 'fps=1,scale=320:-1,tile=5x1', '-frames:v', '1', mon], timeout=60)
        if not os.path.exists(mon): return None
        b64 = base64.b64encode(open(mon, 'rb').read()).decode()
        txt, good = '', False
        try:
            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', mp4, '-vn', '-ar', '16000', '-ac', '1', wav], timeout=60)
            if os.path.exists(wav): txt, good = whisper_text(wav)
        except Exception: pass
        return b64, txt, good
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def neighbors(c, vec, k=12):
    buf = r2_get(f'raw/{c}/embeddings.npz')
    if buf is None: return None
    z = np.load(io.BytesIO(buf), allow_pickle=True)
    V = np.asarray(z['vecs'], np.float32); ids = z['ids']
    if len(V) == 0: return []
    Vn = V / (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
    q = vec / (np.linalg.norm(vec) + 1e-9)
    sims = Vn @ q
    top = np.argsort(-sims)[:k]
    return [{'id': str(ids[i]), 'sim': round(float(sims[i]), 4)} for i in top]

def main():
    args = {}
    a = sys.argv[1:]
    for i in range(0, len(a) - 1, 2):
        if a[i].startswith('--'): args[a[i][2:]] = a[i + 1]
    path = args.get('file')
    if not path or not os.path.exists(path):
        print(json.dumps({'error': 'no file'})); return
    inp = hook_inputs(path)
    if not inp:
        print(json.dumps({'error': 'could not read video / extract frames'})); return
    b64, txt, good = inp
    ev = embed([img_part(b64)])
    et = embed([{'text': txt}]) if good else None
    eg = embed([img_part(b64)] + ([{'text': txt}] if good else []))
    out = {
        'montage': b64,
        'transcript': txt if good else '',
        'silent': (not good),
        'title': args.get('title', 'My upload'),
        'channels': {
            'visual': {'neighbors': neighbors('visual', ev)} if ev is not None else None,
            'text': ({'neighbors': neighbors('text', et)} if (good and et is not None) else None),
            'together': {'neighbors': neighbors('together', eg)} if eg is not None else None,
        },
    }
    print(json.dumps(out))

if __name__ == '__main__':
    main()
