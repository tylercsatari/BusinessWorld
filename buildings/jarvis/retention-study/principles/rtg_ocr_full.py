#!/usr/bin/env python3
"""
RTG · taxonomy #3 pipeline. Full-video OCR (not hook-only) to detect on-screen COUNTERS /
TIMERS / SCORES / progress %s — the persistent visual tension meters that climb toward a target
(a sustained open loop). Per video: download lowest-res stream, extract 1 fps, OCR every second,
keep numeric tokens. Resumable + disk-light (one video at a time, cleaned up after). Writes
ocr_full.json; rtg_counters.py turns it into a counter signal and validates it against retention.
"""
import os, json, re, glob, subprocess, tempfile, shutil, sys
import pytesseract
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
META = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
OUT = os.path.join(HERE, 'ocr_full.json')
done = json.load(open(OUT)) if os.path.exists(OUT) else {}
NUM = re.compile(r'\d+(?:[.,:]\d+)*%?')
MAXSEC = 95


def ocr_video(vid, dur):
    tmp = tempfile.mkdtemp(prefix='rtgocr_')
    try:
        mp4 = os.path.join(tmp, 'v.mp4')
        r = subprocess.run(['yt-dlp', '--no-playlist', '-q', '--no-warnings',
                            '-f', 'bv*[height<=480]/worst[ext=mp4]/worst', '-o', mp4,
                            f'https://www.youtube.com/watch?v={vid}'], capture_output=True, timeout=150)
        src = mp4 if os.path.exists(mp4) else next(iter(glob.glob(os.path.join(tmp, 'v.*'))), None)
        if not src:
            return {'persec': [], 'err': 'download', 'msg': r.stderr.decode()[-120:]}
        fr = os.path.join(tmp, 'f'); os.makedirs(fr, exist_ok=True)
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-i', src, '-vf', 'fps=1,scale=720:-1',
                        '-frames:v', str(MAXSEC), '-q:v', '3', os.path.join(fr, '%04d.jpg')], timeout=120)
        persec = []
        for f in sorted(glob.glob(os.path.join(fr, '*.jpg'))):
            t = int(os.path.basename(f)[:4]) - 1
            try:
                txt = pytesseract.image_to_string(Image.open(f).convert('L'), config='--psm 11')
            except Exception:
                txt = ''
            nums = NUM.findall(txt)
            persec.append({'t': t, 'nums': nums, 'text': ' '.join(txt.split())[:80]})
        return {'persec': persec, 'n': len(persec)}
    except subprocess.TimeoutExpired:
        return {'persec': [], 'err': 'timeout'}
    except Exception as e:
        return {'persec': [], 'err': str(e)[:120]}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    d = json.load(open(OUT)) if os.path.exists(OUT) else {}
    todo = [m for m in META if m['id'] not in d]
    print(f"{len(d)} done · {len(todo)} to OCR", flush=True)
    for i, m in enumerate(todo):
        res = ocr_video(m['id'], m.get('duration', 0))
        d[m['id']] = res
        if (i + 1) % 3 == 0 or i == len(todo) - 1:
            json.dump(d, open(OUT, 'w'))
        nnum = sum(1 for p in res.get('persec', []) if p['nums'])
        print(f"  [{i+1}/{len(todo)}] {m['id']} · {res.get('n', 0)}s · {nnum} numeric · {res.get('err', 'ok')}", flush=True)
    json.dump(d, open(OUT, 'w'))
    ok = sum(1 for v in d.values() if v.get('persec'))
    print(f"\ndone. {ok}/{len(d)} videos with frames · ocr_full.json written", flush=True)


if __name__ == '__main__':
    main()
