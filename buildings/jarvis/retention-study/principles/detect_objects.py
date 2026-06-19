#!/usr/bin/env python3
"""
OBJECT DETECTION — Grounding DINO (open-vocabulary, much more accurate than OWLv2).

Definition of a COMPONENT (objective, reproducible):
  An object phrase is a COMPONENT of a frame iff Grounding DINO localizes it with score > TAU,
  returning a box. Non-objects ("focus","setting") don't ground and are excluded by construction.

Candidates per frame = a compact common-object base + content nouns from the frame's own scene
description (so creative objects like "chest plate" get queried). Per second + per hook (tracked).

Output: objects.json  { id → {persec:[{t,dets:[{label,score,box[x,y,w,h]}]}], hook:[{label,score,seconds}]} }
Boxes are normalized [0,1] (x,y = top-left), drawable directly on the displayed frame.
"""
import os, json, re, time
import numpy as np, torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'
TAU = 0.30
TOPK = 9
SZ = 800

BASE = ("person. face. hand. table. chair. shelf. floor. wall. door. phone. laptop. screen. camera. "
        "car. wheel. bottle. cup. food. box. book. sign. ball. tool. machine. robot. "
        "dog. tree. plant. fire. smoke. suit. shirt. hat. helmet. mask. glasses. shoe. armor. shield. sword. gun. light.")
BASE_LIST = [x.strip() for x in BASE.split('.') if x.strip()]
STOP = set("the a an and or but to of in on for with at by from up about into over after is are was were be been this that these those it its as i you he she they we my your his her their our shows scene background foreground frame visible appears very most more some many large small left right center top bottom front behind clear likely natural bright dark warm".split())


def candidates(desc):
    toks = [w for w in re.findall(r"[a-zA-Z]+", (desc or '').lower()) if len(w) >= 4 and w not in STOP]
    grams = []
    for i, w in enumerate(toks):
        grams.append(w)
        if i + 1 < len(toks):
            grams.append(w + ' ' + toks[i + 1])
    return list(dict.fromkeys(grams))[:16]


def main():
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
    print(f"loading Grounding DINO · device {DEV}", flush=True)
    mid = 'IDEA-Research/grounding-dino-tiny'
    proc = AutoProcessor.from_pretrained(mid)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(mid).to(DEV).eval()
    MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)

    def prep(img):
        im = img.resize((SZ, SZ), Image.BICUBIC)
        return ((np.asarray(im, np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)

    def scene_desc(vid):
        try:
            a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
            return {round(float(f.get('timestamp', -1))): (f.get('analysis') or {}).get('sceneDescription', '')
                    for f in (a.get('frames') or []) if isinstance(f.get('timestamp'), (int, float))}
        except Exception:
            return {}

    def clean(lab, cset):
        lab = lab.strip().lower()
        if not lab or len(lab.split()) > 4:                # drop spurious whole-prompt groundings
            return None
        if lab in cset:
            return lab
        best = None
        for c in cset:                                     # whole-word candidate match
            if (c == lab or (' ' + c + ' ') in (' ' + lab + ' ')) and (best is None or len(c) > len(best)):
                best = c
        return best or lab.split()[0]

    out, t0 = {}, time.time()
    for vi, m in enumerate(M):
        vid = m['id']; descs = scene_desc(vid); persec = []
        for k in range(1, 6):
            fp = os.path.join(VD, vid, 'frames', f'frame_{k:04d}.jpg')
            if not os.path.exists(fp):
                continue
            try:
                img = Image.open(fp).convert('RGB')
            except Exception:
                continue
            extra = candidates(descs.get(float(k - 1), '') or descs.get(k - 1, ''))
            cset = set(BASE_LIST) | set(extra)
            prompt = BASE + ' ' + '. '.join(extra) + '.'
            px = torch.from_numpy(prep(img)[None]).to(DEV)
            tin = proc.tokenizer([prompt], return_tensors='pt', truncation=True, max_length=256).to(DEV)
            with torch.no_grad():
                o = model(pixel_values=px, input_ids=tin.input_ids, attention_mask=tin.attention_mask, token_type_ids=tin.get('token_type_ids'))
            res = proc.post_process_grounded_object_detection(o, tin.input_ids, threshold=TAU, text_threshold=0.22, target_sizes=[(SZ, SZ)])[0]
            best = {}
            for bi in range(len(res['scores'])):
                sc = float(res['scores'][bi]); lab = clean(res['labels'][bi], cset)
                if not lab or sc <= TAU or sc <= best.get(lab, (0,))[0]:
                    continue
                x1, y1, x2, y2 = [float(v) for v in res['boxes'][bi]]
                best[lab] = (sc, [round(x1 / SZ, 3), round(y1 / SZ, 3), round((x2 - x1) / SZ, 3), round((y2 - y1) / SZ, 3)])
            dets = sorted([{'label': L, 'score': round(s, 3), 'box': bx} for L, (s, bx) in best.items()], key=lambda d: -d['score'])[:TOPK]
            persec.append({'t': k - 1, 'dets': dets})
        agg = {}
        for ps in persec:
            for d in ps['dets']:
                a0 = agg.setdefault(d['label'], {'label': d['label'], 'score': 0.0, 'seconds': 0})
                a0['score'] = max(a0['score'], d['score']); a0['seconds'] += 1
        out[vid] = {'persec': persec, 'hook': sorted(agg.values(), key=lambda d: (-d['seconds'], -d['score']))}
        if (vi + 1) % 15 == 0:
            print(f"  {vi+1}/{len(M)} · {time.time()-t0:.0f}s", flush=True)
    json.dump(out, open(os.path.join(HERE, 'objects.json'), 'w'))
    print(f"saved objects.json · {len(out)} videos · {time.time()-t0:.0f}s", flush=True)


if __name__ == '__main__':
    main()
