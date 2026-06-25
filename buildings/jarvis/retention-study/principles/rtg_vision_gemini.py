#!/usr/bin/env python3
"""
RTG · taxonomy #3, frontier vision. Replaces Tesseract OCR (which misread stylized/animated text
and can't see non-numeric graphics) with GEMINI VISION per frame. Structured JSON per second:
real counter/timer/score (+ value), progress bar (+ fraction), and any HUD/meter/gauge graphics.
Far fewer false positives + detects the graphics OCR can't. Resumable, disk-light. → rtg_vision.json
"""
import os, json, base64, urllib.request, glob, subprocess, tempfile, shutil
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = os.environ.get('GEMINI_API_KEY', '')
if not KEY:
    for up in range(2, 6):
        envp = os.path.join(HERE, *(['..'] * up), '.env')
        if os.path.exists(envp):
            for ln in open(envp):
                if ln.startswith('GEMINI_API_KEY'):
                    KEY = ln.split('=', 1)[1].strip().strip('"').strip("'")
            break
MODEL = 'gemini-2.5-flash'
URL = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent'
META = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
OUT = os.path.join(HERE, 'rtg_vision.json')
MAXSEC = 95
PROMPT = ('Look at this single short-form video frame. Detect ON-SCREEN GRAPHICS only (not the '
          'natural scene). Return STRICT JSON: {"counter":{"present":bool,"value":"the exact digits/'
          'text shown or null","kind":"timer|score|money|percent|count|other|null"},"progress_bar":'
          '{"present":bool,"fraction":number 0-1 or null},"graphics":["short labels of any other HUD/'
          'meter/gauge/gauge-needle/health-bar/overlay graphics"]}. A counter is a number meant to '
          'change (timer, score, money, %, tally) — NOT a static label, date, or logo.')


def vision(path):
    try:
        img = base64.b64encode(open(path, 'rb').read()).decode()
        body = {'contents': [{'parts': [{'text': PROMPT}, {'inline_data': {'mime_type': 'image/jpeg', 'data': img}}]}],
                'generationConfig': {'temperature': 0, 'responseMimeType': 'application/json'}}
        data = json.dumps(body).encode()
        for _ in range(3):
            try:
                req = urllib.request.Request(URL, data=data, headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
                r = json.load(urllib.request.urlopen(req, timeout=70))
                return json.loads(r['candidates'][0]['content']['parts'][0]['text'])
            except Exception:
                continue
    except Exception:
        pass
    return {}


def clean(t, d):
    c = (d or {}).get('counter') or {}; b = (d or {}).get('progress_bar') or {}
    return {'t': t, 'cp': bool(c.get('present')), 'cv': c.get('value'), 'ck': c.get('kind'),
            'bp': bool(b.get('present')), 'bf': b.get('fraction'), 'g': (d or {}).get('graphics') or []}


def process(vid):
    tmp = tempfile.mkdtemp(prefix='rtgvis_')
    try:
        mp4 = os.path.join(tmp, 'v.mp4')
        subprocess.run(['yt-dlp', '--no-playlist', '-q', '--no-warnings', '-f', 'bv*[height<=480]/worst[ext=mp4]/worst',
                        '-o', mp4, f'https://www.youtube.com/watch?v={vid}'], capture_output=True, timeout=160)
        src = mp4 if os.path.exists(mp4) else next(iter(glob.glob(os.path.join(tmp, 'v.*'))), None)
        if not src:
            return {'persec': [], 'err': 'download'}
        fr = os.path.join(tmp, 'f'); os.makedirs(fr, exist_ok=True)
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-i', src, '-vf', 'fps=1,scale=720:-1',
                        '-frames:v', str(MAXSEC), '-q:v', '3', os.path.join(fr, '%04d.jpg')], timeout=120)
        frames = sorted(glob.glob(os.path.join(fr, '*.jpg')))
        with ThreadPoolExecutor(max_workers=10) as ex:
            res = list(ex.map(vision, frames))
        persec = [clean(i, res[i]) for i in range(len(frames))]
        return {'persec': persec, 'n': len(persec)}
    except subprocess.TimeoutExpired:
        return {'persec': [], 'err': 'timeout'}
    except Exception as e:
        return {'persec': [], 'err': str(e)[:100]}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    done = json.load(open(OUT)) if os.path.exists(OUT) else {}
    todo = [m for m in META if m['id'] not in done]
    print(f"key:{'ok' if KEY else 'MISSING'} · {len(done)} done · {len(todo)} to process", flush=True)
    for i, m in enumerate(todo):
        r = process(m['id']); done[m['id']] = r
        nc = sum(1 for p in r.get('persec', []) if p['cp']); nb = sum(1 for p in r.get('persec', []) if p['bp'])
        print(f"  [{i+1}/{len(todo)}] {m['id']} · {r.get('n', 0)}s · {nc} counter · {nb} bar · {r.get('err', 'ok')}", flush=True)
        if (i + 1) % 3 == 0 or i == len(todo) - 1:
            json.dump(done, open(OUT, 'w'))
    json.dump(done, open(OUT, 'w'))
    ok = sum(1 for v in done.values() if v.get('persec'))
    print(f"\ndone · {ok}/{len(done)} videos · rtg_vision.json", flush=True)


if __name__ == '__main__':
    main()
