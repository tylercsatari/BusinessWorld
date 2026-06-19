#!/usr/bin/env python3
"""
HOOK FRAME THUMBNAILS — so the detection overlay shows on the DEPLOYED site too.

video_data/ frames are gitignored (huge), so they 404 on Render. Here we write small
downscaled copies of just the 5 hook frames (seconds 0-4) for the 211 confirmed videos
into a committed folder the UI can load anywhere.

Output: principles/hookframes/<id>/<sec>.jpg   (sec = 0..4)
"""
import os, json
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
OUT = os.path.join(HERE, 'hookframes')
WIDTH = 220


def main():
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    n, total = 0, 0
    for m in M:
        vid = m['id']; d = os.path.join(OUT, vid); made = False
        for k in range(1, 6):
            src = os.path.join(VD, vid, 'frames', f'frame_{k:04d}.jpg')
            if not os.path.exists(src):
                continue
            try:
                img = Image.open(src).convert('RGB')
                w, h = img.size
                img = img.resize((WIDTH, max(1, round(h * WIDTH / w))), Image.LANCZOS)
                os.makedirs(d, exist_ok=True)
                img.save(os.path.join(d, f'{k - 1}.jpg'), quality=72, optimize=True)
                total += 1; made = True
            except Exception as e:
                print('skip', vid, k, e)
        if made:
            n += 1
    sz = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs)
    print(f"{total} thumbnails for {n} videos · {sz/1e6:.1f} MB → hookframes/")


if __name__ == '__main__':
    main()
