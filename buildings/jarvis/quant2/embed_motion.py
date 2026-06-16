#!/usr/bin/env python3
"""
QUANT 2 (pure) · QP1 motion lane — frozen VideoMAE over frame clips.

DINOv2 sees single frames (static composition). VideoMAE was self-supervised by
masked video modelling, so it represents MOTION/temporal dynamics — the difference
between "fast unexpected transformation" and "static talking head" that single
frames miss. No labels, no language: just the temporal shape of the open.

Input: 16 frames sampled across the first-10s window. Cache: emb_motion/<id>.npy
(dict: mean[D]). Idempotent. CPU-feasible (videomae-base).
"""
import os, json, warnings
warnings.filterwarnings('ignore')
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
EMB = os.path.join(HERE, 'emb_motion'); os.makedirs(EMB, exist_ok=True)
MANIFEST = os.path.join(HERE, 'manifest.json')
MODEL_NAME = 'MCG-NJU/videomae-base'
NFRAMES = 16


def main():
    import torch
    from PIL import Image
    from transformers import VideoMAEModel
    torch.set_num_threads(max(1, os.cpu_count() - 1))
    print(f'loading {MODEL_NAME} …', flush=True)
    model = VideoMAEModel.from_pretrained(MODEL_NAME).eval()
    MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)

    def prep(im):
        im = im.resize((224, 224), Image.BICUBIC)
        return ((np.asarray(im, np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)

    vids = [v for v in json.load(open(MANIFEST))['videos'] if v['tier'] == 'true_label' and v['n_frames'] >= 4]
    todo = [v for v in vids if not os.path.exists(os.path.join(EMB, v['id'] + '.npy'))]
    print(f'{len(vids)} videos · {len(todo)} to embed', flush=True)

    @torch.no_grad()
    def embed(clip):                                      # 16 × 3 × 224 × 224
        px = torch.from_numpy(np.stack(clip)).float().unsqueeze(0)   # 1 × 16 × 3 × 224 × 224
        h = model(pixel_values=px).last_hidden_state[0]   # tokens × 768
        return torch.nn.functional.normalize(h.mean(0), dim=0).numpy().astype(np.float32)

    done = 0
    for v in todo:
        fdir = os.path.join(ROOT, v['frame_dir'])
        if not os.path.isdir(fdir):
            continue
        files = sorted([f for f in os.listdir(fdir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
        if len(files) < 4:
            continue
        idx = np.linspace(0, len(files) - 1, NFRAMES).astype(int)   # 16 evenly-spaced frames
        try:
            clip = [prep(Image.open(os.path.join(fdir, files[i])).convert('RGB')) for i in idx]
            e = embed(clip)
        except Exception:
            continue
        np.save(os.path.join(EMB, v['id'] + '.npy'), {'mean': e}, allow_pickle=True)
        done += 1
        if done % 20 == 0:
            print(f'  {done}/{len(todo)} motion-embedded …', flush=True)
    print(f'DONE · motion-embedded {done} videos → emb_motion/ (dim=768)', flush=True)


if __name__ == '__main__':
    main()
