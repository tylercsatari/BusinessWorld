#!/usr/bin/env python3
"""
OBJECT DETECTION — quantitative components (replaces text-noun extraction).

Definition of a COMPONENT (objective, reproducible):
  An object phrase is a COMPONENT of a frame iff an open-vocabulary detector
  (OWL-ViT) localizes it in that frame with score > TAU, returning a bounding box.
  → non-objects ("focus", "setting", "area") never get a box, so they are excluded by construction.

Candidates per frame = a base common-object vocabulary + content n-grams pulled from the
frame's own scene description (so creative objects like "chest plate" get a chance to ground).

Resolution-consistent: detected PER SECOND (each of the first 5 frames). Hook-level objects =
the union, tracked across seconds (how many seconds each object persists).

Output: objects.json  { id → {persec:[{t,dets:[{label,score,box[x,y,w,h]}]}], hook:[{label,score,seconds}]} }
Box coords are normalized [0,1] (x,y = top-left), drawable directly on the displayed frame.
"""
import os, json, re, math, time
import numpy as np, torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'
TAU = 0.15                         # min detection score to count as a confirmed object (OWLv2 calibrated)
TOPK = 9                           # max objects kept per frame

BASE = ("person face hand arm leg body hair eye mouth crowd child man woman "
        "table chair desk bed couch shelf floor wall door window stairs room kitchen "
        "phone laptop computer screen tv monitor keyboard camera microphone headphones speaker "
        "car truck bike motorcycle wheel engine road "
        "bottle cup glass plate bowl food burger pizza drink fruit knife fork spoon "
        "box bag book paper money card sign poster "
        "ball toy tool hammer drill machine robot drone gadget device wire battery "
        "dog cat animal bird fish horse "
        "tree plant grass flower rock water fire smoke sky cloud sun "
        "suit shirt jacket hat helmet mask glasses shoe glove costume armor sword shield gun weapon "
        "ring chain metal wood plastic paint brush light lamp candle clock mirror gem diamond").split()
STOP = set("the a an and or but to of in on for with at by from up about into over after is are was were be been this that these those it its as i you he she they we my your his her their our shows scene background foreground frame visible appears very most more some many large small left right center top bottom front behind clear likely natural bright dark warm".split())


def candidates(desc):
    toks = [w for w in re.findall(r"[a-zA-Z]+", (desc or '').lower()) if len(w) >= 3 and w not in STOP]
    grams = []
    for i, w in enumerate(toks):
        grams.append(w)
        if i + 1 < len(toks):
            grams.append(w + ' ' + toks[i + 1])
    seen, out = set(), []
    for g in grams:
        if g not in seen:
            seen.add(g); out.append(g)
    return out[:28]


def main():
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    from transformers import Owlv2ForObjectDetection, AutoTokenizer
    print(f"loading OWLv2 · device {DEV}", flush=True)
    model = Owlv2ForObjectDetection.from_pretrained('google/owlv2-base-patch16-ensemble').to(DEV).eval()
    tok = AutoTokenizer.from_pretrained('google/owlv2-base-patch16-ensemble')
    CM = np.array([0.48145466, 0.4578275, 0.40821073], np.float32); CS = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)

    def frame_path(vid, k):
        return os.path.join(VD, vid, 'frames', f'frame_{k:04d}.jpg')

    def scene_desc(vid):
        try:
            a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
            return {round(float(f.get('timestamp', -1))): (f.get('analysis') or {}).get('sceneDescription', '')
                    for f in (a.get('frames') or []) if isinstance(f.get('timestamp'), (int, float))}
        except Exception:
            return {}

    out, t0 = {}, time.time()
    for vi, m in enumerate(M):
        vid = m['id']; descs = scene_desc(vid); persec = []
        for k in range(1, 6):
            fp = frame_path(vid, k)
            if not os.path.exists(fp):
                continue
            try:
                img = Image.open(fp).convert('RGB')
            except Exception:
                continue
            qs = candidates(descs.get(float(k - 1), '') or descs.get(k - 1, ''))
            queries = list(dict.fromkeys(BASE + qs))
            a = ((np.asarray(img.resize((960, 960), Image.BICUBIC), np.float32) / 255.0 - CM) / CS).transpose(2, 0, 1)
            ti = tok(queries, return_tensors='pt', padding=True).to(DEV)
            with torch.no_grad():
                o = model(input_ids=ti.input_ids, attention_mask=ti.attention_mask, pixel_values=torch.from_numpy(a[None]).to(DEV))
            logits = o.logits[0].cpu().numpy(); boxes = o.pred_boxes[0].cpu().numpy()
            best = {}
            sig = 1.0 / (1.0 + np.exp(-logits))
            for q in range(sig.shape[0]):
                qi = int(sig[q].argmax()); sc = float(sig[q, qi])
                if sc > TAU and sc > best.get(queries[qi], (0,))[0]:
                    cx, cy, bw, bh = boxes[q]
                    best[queries[qi]] = (sc, [round(float(cx - bw / 2), 3), round(float(cy - bh / 2), 3), round(float(bw), 3), round(float(bh), 3)])
            dets = sorted(([{'label': L, 'score': round(s, 3), 'box': bx} for L, (s, bx) in best.items()]), key=lambda d: -d['score'])[:TOPK]
            persec.append({'t': k - 1, 'dets': dets})
        # hook-level: track each object across seconds (max score + #seconds present)
        agg = {}
        for ps in persec:
            for d in ps['dets']:
                a0 = agg.setdefault(d['label'], {'label': d['label'], 'score': 0.0, 'seconds': 0})
                a0['score'] = max(a0['score'], d['score']); a0['seconds'] += 1
        hook = sorted(agg.values(), key=lambda d: (-d['seconds'], -d['score']))
        out[vid] = {'persec': persec, 'hook': hook}
        if (vi + 1) % 15 == 0:
            print(f"  {vi+1}/{len(M)} · {time.time()-t0:.0f}s", flush=True)
    json.dump(out, open(os.path.join(HERE, 'objects.json'), 'w'))
    print(f"saved objects.json · {len(out)} videos · {time.time()-t0:.0f}s", flush=True)


if __name__ == '__main__':
    main()
