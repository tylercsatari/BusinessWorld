#!/usr/bin/env python3
"""
PER-SECOND embeddings — resolution consistency.

The whole-hook embedding (pooled 5 s) is low-resolution: it averages everything.
To stay consistent we embed EACH second on its own, in every modality:

  per-frame  CLIP image  (second t's frame)
  per-second CLIP text + MiniLM concept  (transcript words with floor(timestamp)==t)
  per-second coherence = cos(CLIP image_t, CLIP text_t)

(per-frame DINOv2 visual already exists in hooks_emb.npz as the `scene` array.)

Output: persec_emb.npz, rows aligned to (video order × seconds 0..4) with owner/sec indices.
"""
import os, json
import numpy as np, torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'


def main():
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    from transformers import CLIPModel, AutoTokenizer
    from sentence_transformers import SentenceTransformer
    clip = CLIPModel.from_pretrained('openai/clip-vit-base-patch16').to(DEV).eval()
    ctok = AutoTokenizer.from_pretrained('openai/clip-vit-base-patch16')
    st = SentenceTransformer('all-MiniLM-L6-v2', device=DEV)
    CM = np.array([0.48145466, 0.4578275, 0.40821073], np.float32); CS = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)

    def prep(img):
        w, h = img.size; s = 224 / min(w, h)
        img = img.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
        w, h = img.size; l = (w - 224) // 2; t = (h - 224) // 2
        a = np.asarray(img.crop((l, t, l + 224, t + 224)), np.float32) / 255.0
        return ((a - CM) / CS).transpose(2, 0, 1)

    def words_by_sec(vid):
        try:
            a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
            w = (a.get('transcript') or {}).get('words') or []
        except Exception:
            return {t: '' for t in range(5)}
        out = {t: [] for t in range(5)}
        for x in w:
            ts = x.get('timestamp')
            if isinstance(ts, (int, float)) and 0 <= ts < 5:
                out[int(ts)].append(x.get('word', ''))
        return {t: ' '.join(z for z in out[t] if z).strip() for t in range(5)}

    owner, sec, cimg, ctxt, conc, coh = [], [], [], [], [], []
    for vi, m in enumerate(M):
        vid = m['id']; wbs = words_by_sec(vid)
        for k in range(1, 6):
            fp = os.path.join(VD, vid, 'frames', f'frame_{k:04d}.jpg')
            if not os.path.exists(fp):
                continue
            try:
                img = Image.open(fp).convert('RGB')
            except Exception:
                continue
            with torch.no_grad():
                ci = clip.visual_projection(clip.vision_model(pixel_values=torch.from_numpy(prep(img)[None]).to(DEV)).pooler_output).cpu().numpy()[0]
                txt = wbs.get(k - 1, '') or ' '
                tin = ctok([txt], return_tensors='pt', padding=True, truncation=True, max_length=77).to(DEV)
                ct = clip.text_projection(clip.text_model(**tin).pooler_output).cpu().numpy()[0]
            cv = st.encode(txt)
            a = ci / (np.linalg.norm(ci) + 1e-9); b = ct / (np.linalg.norm(ct) + 1e-9)
            owner.append(vi); sec.append(k - 1); cimg.append(ci); ctxt.append(ct); conc.append(cv); coh.append(float(a @ b))
        if (vi + 1) % 25 == 0:
            print(f"  {vi+1}/{len(M)}", flush=True)
    np.savez_compressed(os.path.join(HERE, 'persec_emb.npz'),
                        owner=np.array(owner, np.int32), sec=np.array(sec, np.int32),
                        clip_img=np.array(cimg, np.float32), clip_txt=np.array(ctxt, np.float32),
                        concept=np.array(conc, np.float32), coherence=np.array(coh, np.float32))
    print(f"saved persec_emb.npz · {len(owner)} second-rows", flush=True)


if __name__ == '__main__':
    main()
