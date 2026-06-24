#!/usr/bin/env python3
"""
RTG · Gemini Embedding 2 — the frontier multimodal encoder. Natively maps images AND
text into ONE 3072-dim space (here MRL-truncated to DIM), so visual frames and the
contextual utterance are directly comparable — the shared bridge, for free.

Per second: visual = the frame (image), concept = the rolling 10s utterance (text).
Output keys match rtg_tokens_*.npz so rtg_field.py / rtg_jepa.py just point TOKENS here.

Output: rtg_tokens_gemini.npz  (owner, sec, clip_img, clip_txt, has_c)
Usage:  python3 rtg_embed_gemini.py [--test]
"""
import os, sys, json, glob, base64, time, threading
import numpy as np
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
MODEL = 'gemini-embedding-2'
URL = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:embedContent'
DIM = 1536
W = 10
WORKERS = 8


def api_key():
    k = os.environ.get('GEMINI_API_KEY')
    if k:
        return k
    for line in open(os.path.join(ROOT, '.env')):
        if line.strip().startswith('GEMINI_API_KEY='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise SystemExit('GEMINI_API_KEY not found in env or .env')


KEY = api_key()


def embed(part, tries=6):
    body = json.dumps({'content': {'parts': [part]}, 'outputDimensionality': DIM}).encode()
    for a in range(tries):
        try:
            req = urllib.request.Request(URL, data=body, method='POST',
                                         headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
            with urllib.request.urlopen(req, timeout=60) as r:
                return np.array(json.loads(r.read())['embedding']['values'], np.float32)
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:200]
            if e.code in (429, 500, 503) and a < tries - 1:
                time.sleep(1.5 * (a + 1) + (hash((id(part), a)) % 100) / 100.0)
                continue
            raise SystemExit(f'HTTP {e.code}: {msg}')
        except Exception:
            if a < tries - 1:
                time.sleep(1.5 * (a + 1)); continue
            raise


def words_by_sec(vid, n):
    out = {t: [] for t in range(n)}
    try:
        a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
        w = (a.get('transcript') or {}).get('words') or []
    except Exception:
        w = []
    for x in w:
        ts = x.get('timestamp')
        if isinstance(ts, (int, float)) and 0 <= int(ts) < n:
            out[int(ts)].append(x.get('word', ''))
    base = {t: ' '.join(z for z in out[t] if z).strip() for t in range(n)}
    return [' '.join(base[s] for s in range(max(0, t - W + 1), t + 1) if base[s]).strip() for t in range(n)]


def main():
    if '--test' in sys.argv:
        e1 = embed({'text': 'a giant red slingshot in a field'})
        fr = sorted(glob.glob(os.path.join(VD, '*', 'frames', 'frame_0003.jpg')))[0]
        e2 = embed({'inlineData': {'mimeType': 'image/jpeg', 'data': base64.b64encode(open(fr, 'rb').read()).decode()}})
        print(f'TEST OK · text dim {e1.shape[0]} · image dim {e2.shape[0]} · cos {float(e1 @ e2 / (np.linalg.norm(e1)*np.linalg.norm(e2))):.3f}')
        return

    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    tasks = []   # (global_row_index, kind, payload)  kind: 'img'/'txt'
    owner, sec, hasc = [], [], []
    frame_for, ctx_for = {}, {}
    ridx = 0
    for vi, mv in enumerate(M):
        vid = mv['id']
        frames = sorted(glob.glob(os.path.join(VD, vid, 'frames', 'frame_*.jpg')))
        n = len(frames)
        if not n:
            continue
        ctx = words_by_sec(vid, n)
        for k in range(n):
            owner.append(vi); sec.append(k); hasc.append(1 if ctx[k] else 0)
            frame_for[ridx] = frames[k]; ctx_for[ridx] = ctx[k]
            tasks.append((ridx, 'img')); tasks.append((ridx, 'txt'))
            ridx += 1
    N = ridx
    IMG = np.zeros((N, DIM), np.float32); TXT = np.zeros((N, DIM), np.float32)
    done = [0]; lock = threading.Lock(); t0 = time.time()

    def run(task):
        r, kind = task
        if kind == 'img':
            v = embed({'inlineData': {'mimeType': 'image/jpeg', 'data': base64.b64encode(open(frame_for[r], 'rb').read()).decode()}}); IMG[r] = v
        else:
            v = embed({'text': ctx_for[r] or ' '}); TXT[r] = v
        with lock:
            done[0] += 1
            if done[0] % 500 == 0:
                el = time.time() - t0
                print(f"  {done[0]}/{len(tasks)} · {el/60:.0f}m · ~{el/done[0]*len(tasks)/60:.0f}m total", flush=True)

    with ThreadPoolExecutor(WORKERS) as ex:
        list(ex.map(run, tasks))
    np.savez_compressed(os.path.join(HERE, 'rtg_tokens_gemini.npz'),
                        owner=np.array(owner, np.int32), sec=np.array(sec, np.int32),
                        clip_img=IMG, clip_txt=TXT, has_c=np.array(hasc, np.int8))
    print(f"saved rtg_tokens_gemini.npz · {N} rows · dim {DIM}", flush=True)


if __name__ == '__main__':
    main()
