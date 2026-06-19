#!/usr/bin/env python3
"""
ON-SCREEN TEXT (OCR) — the text layer OWLv2 ignores (captions, titles, overlays).

Tesseract per hook frame, filtered hard (conf≥60, len≥3, real dictionary word / number)
so stylized-font garbage doesn't pollute the embeddings. Per second + per hook (deduped).

Honest limit: tesseract is weak on heavily stylized/animated text — it reliably catches clean
horizontal captions, which is most content text, but will miss some artistic overlays.

Output: ocr.json  { id → {persec:[{t,text}], hook:"deduped words"} }
"""
import os, json, re
from PIL import Image, ImageOps
import pytesseract

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
WORDS = set(w.strip().lower() for w in open('/usr/share/dict/words')) if os.path.exists('/usr/share/dict/words') else set()
KEEP = set("ok diy ai vs tv id 3d 2d ufo dna nasa".split())


def good(t):
    tl = t.lower().strip(".,!?'")
    if re.fullmatch(r"[0-9][0-9,\.\$%kmKM]*", t):
        return True
    if len(tl) >= 3 and (tl in WORDS or tl in KEEP):
        return True
    return False


def ocr(p, conf=60):
    try:
        img = Image.open(p).convert('RGB')
    except Exception:
        return ''
    g = ImageOps.grayscale(img); w, h = g.size; g = g.resize((w * 2, h * 2))
    try:
        d = pytesseract.image_to_data(g, config='--psm 11', output_type=pytesseract.Output.DICT)
    except Exception:
        return ''
    out = []
    for i, t in enumerate(d['text']):
        t = t.strip().strip('.,')
        try:
            c = float(d['conf'][i])
        except Exception:
            c = -1
        if c >= conf and len(t) >= 2 and good(t):
            out.append(t)
    return ' '.join(out)[:200]


def main():
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    out = {}
    for vi, m in enumerate(M):
        vid = m['id']; persec = []; seen = []
        for k in range(1, 6):
            p = os.path.join(VD, vid, 'frames', f'frame_{k:04d}.jpg')
            if not os.path.exists(p):
                continue
            t = ocr(p)
            persec.append({'t': k - 1, 'text': t})
            for w in t.split():
                if w.lower() not in [s.lower() for s in seen]:
                    seen.append(w)
        out[vid] = {'persec': persec, 'hook': ' '.join(seen[:24])}
        if (vi + 1) % 25 == 0:
            print(f"  {vi+1}/{len(M)}", flush=True)
    json.dump(out, open(os.path.join(HERE, 'ocr.json'), 'w'))
    withtext = sum(1 for v in out.values() if v['hook'])
    print(f"ocr.json · {len(out)} videos · {withtext} have on-screen text", flush=True)


if __name__ == '__main__':
    main()
