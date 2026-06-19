#!/usr/bin/env python3
"""
HOOK EXTRACTION + EMBEDDING — Principle: Novelty (extraction only, no labels/scoring).

Hook = the first 5 seconds of every CONFIRMED video (the 211 in retention_table.json).
  visual frames : frame_0001..0005.jpg  (frames are 1 fps, so 1..5 = seconds 1..5)
  hook script   : transcript words with timestamp < 5.0

Embeds each hook several independent ways so the 2D latent maps separate cleanly
(embedding the whole hook at once gives poor resolution — the user's point):

  visual_dino   DINOv2-small  CLS, mean-pooled over the 5 frames        (pure vision)
  scene_dino    DINOv2-small  CLS, PER FRAME (5 per video)              (scene components)
  clip_img      CLIP ViT-B/16 image features, mean over 5 frames        (vision in joint space)
  clip_txt      CLIP ViT-B/16 text features of the hook script          (concept in joint space)
  whole         normalized(clip_img)+normalized(clip_txt) / 2           (the whole hook, low-res)
  concept       all-MiniLM-L6-v2 of the hook script                     (pure concept / script)
  coherence     cosine(clip_img, clip_txt)  (do visuals match words)    (for coherent novelty)

Caches everything to hooks_emb.npz + hooks_meta.json so projection tweaks are instant.
NO interpretation here — just vectors.
"""
import os, json, sys, datetime
import numpy as np
import torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
TABLE = os.path.join(RS, 'retention_table.json')
TODAY = datetime.date(2026, 6, 19)
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'


def hook_frames(vid):
    fr = os.path.join(VD, vid, 'frames')
    out = []
    for i in range(1, 6):
        p = os.path.join(fr, f'frame_{i:04d}.jpg')
        if os.path.exists(p):
            out.append(p)
    return out


def hook_text(vid):
    try:
        a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
        w = (a.get('transcript') or {}).get('words') or []
        toks = [x.get('word', '') for x in w if isinstance(x.get('timestamp'), (int, float)) and x['timestamp'] < 5.0]
        return ' '.join(t for t in toks if t).strip()
    except Exception:
        return ''


def main():
    T = json.load(open(TABLE))
    V = [v for v in T['videos'] if hook_frames(v['id'])]
    print(f"{len(V)} confirmed hooks · device={DEV}", flush=True)

    from transformers import AutoModel, CLIPModel, AutoTokenizer
    from sentence_transformers import SentenceTransformer
    print("loading models…", flush=True)
    dino = AutoModel.from_pretrained('facebook/dinov2-small').to(DEV).eval()
    clip = CLIPModel.from_pretrained('openai/clip-vit-base-patch16').to(DEV).eval()
    ctok = AutoTokenizer.from_pretrained('openai/clip-vit-base-patch16')
    st = SentenceTransformer('all-MiniLM-L6-v2', device=DEV)

    # manual preprocessing (no torchvision in this env): resize shortest edge → center-crop → normalize.
    DINO_M = np.array([0.485, 0.456, 0.406], np.float32); DINO_S = np.array([0.229, 0.224, 0.225], np.float32)
    CLIP_M = np.array([0.48145466, 0.4578275, 0.40821073], np.float32); CLIP_S = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)

    def prep(img, mean, std, resize=256, crop=224):
        w, h = img.size; s = resize / min(w, h)
        img = img.resize((max(crop, round(w * s)), max(crop, round(h * s))), Image.BICUBIC)
        w, h = img.size; l = (w - crop) // 2; t = (h - crop) // 2
        a = np.asarray(img.crop((l, t, l + crop, t + crop)), np.float32) / 255.0
        return ((a - mean) / std).transpose(2, 0, 1)

    def batch(imgs, mean, std, resize):
        return torch.from_numpy(np.stack([prep(im, mean, std, resize) for im in imgs])).to(DEV)

    def nrm(x):
        return x / (np.linalg.norm(x) + 1e-9)

    visual_pooled, clip_img_p, clip_txt, whole, concept, coherence = [], [], [], [], [], []
    scene_owner, scene_frame, scene_vecs = [], [], []
    meta = []
    for vi, v in enumerate(V):
        vid = v['id']
        fps = hook_frames(vid)
        imgs = []
        for p in fps:
            try:
                imgs.append(Image.open(p).convert('RGB'))
            except Exception:
                pass
        if not imgs:
            continue
        with torch.no_grad():
            dv = dino(pixel_values=batch(imgs, DINO_M, DINO_S, 256)).last_hidden_state[:, 0].cpu().numpy()  # (nf,384) CLS
            vp = clip.vision_model(pixel_values=batch(imgs, CLIP_M, CLIP_S, 224)).pooler_output
            ci = clip.visual_projection(vp).cpu().numpy()
        txt = hook_text(vid)[:300]
        with torch.no_grad():
            tin = ctok([txt or ' '], return_tensors='pt', padding=True, truncation=True, max_length=77).to(DEV)
            tp = clip.text_model(**tin).pooler_output
            ct = clip.text_projection(tp).cpu().numpy()[0]
        cvec = st.encode(txt or ' ')
        img_pool = ci.mean(0)
        visual_pooled.append(dv.mean(0)); clip_img_p.append(img_pool); clip_txt.append(ct)
        whole.append((nrm(img_pool) + nrm(ct)) / 2.0); concept.append(cvec)
        coherence.append(float(nrm(img_pool) @ nrm(ct)))
        for fi in range(dv.shape[0]):
            scene_owner.append(vi); scene_frame.append(fi); scene_vecs.append(dv[fi])
        ageday = None
        if v.get('published'):
            try:
                ageday = (TODAY - datetime.date.fromisoformat(v['published'])).days
            except Exception:
                pass
        meta.append({'id': vid, 'name': (v.get('title') or vid)[:46], 'views': int(v['views']),
                     'lv': round(float(np.log10(max(v['views'], 1))), 3), 'url': v.get('url'),
                     'published': v.get('published'), 'age_days': ageday, 'hook_text': txt})
        if (vi + 1) % 20 == 0:
            print(f"  {vi+1}/{len(V)}", flush=True)

    np.savez_compressed(os.path.join(HERE, 'hooks_emb.npz'),
                        visual=np.array(visual_pooled, np.float32), clip_img=np.array(clip_img_p, np.float32),
                        clip_txt=np.array(clip_txt, np.float32), whole=np.array(whole, np.float32),
                        concept=np.array(concept, np.float32), coherence=np.array(coherence, np.float32),
                        scene_owner=np.array(scene_owner, np.int32), scene_frame=np.array(scene_frame, np.int32),
                        scene=np.array(scene_vecs, np.float32))
    json.dump({'meta': meta, 'n': len(meta), 'hook_seconds': 5,
               'models': {'visual': 'facebook/dinov2-small', 'whole': 'openai/clip-vit-base-patch16',
                          'concept': 'all-MiniLM-L6-v2'}},
              open(os.path.join(HERE, 'hooks_meta.json'), 'w'))
    print(f"saved {len(meta)} hooks → hooks_emb.npz + hooks_meta.json ({len(scene_vecs)} scene frames)", flush=True)


if __name__ == '__main__':
    main()
