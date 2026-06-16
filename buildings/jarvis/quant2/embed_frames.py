#!/usr/bin/env python3
"""
QUANT 2 · Phase 2 — frozen DINOv2 frame embedder (World 1, non-linguistic).

For every manifest video with local frames, run frozen DINOv2 over each frame and
cache:
  • per-frame CLS embeddings        (the sensory trajectory z(t) over the clip)
  • mean-pooled video embedding     (the video's position in content space)
  • hook-window embedding           (mean over the first HOOK_FRAMES — the 0-3s hook)

These are SELF-SUPERVISED features: DINOv2 learned them from images with NO labels,
so they carry the structure of what's on screen without any human "stakes/novelty"
language. The small true-labelled set later maps these to swipe; the corpus uses
them for the content manifold.

Cache: quant2/emb/<id>.npy  (dict: frame[ N×D ], mean[ D ], hook[ D ]).
CPU-friendly (dinov2-small, 384-d). Idempotent: skips videos already embedded.

Usage:
  python3 embed_frames.py --tier true_label      # the calibration set first
  python3 embed_frames.py --tier corpus          # the manifold set (needs frames)
  python3 embed_frames.py --tier all --limit 50  # smoke test
"""
import os, sys, json, argparse, warnings
warnings.filterwarnings('ignore')
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(JARVIS))
EMB = os.path.join(HERE, 'emb')
os.makedirs(EMB, exist_ok=True)
MANIFEST = os.path.join(HERE, 'manifest.json')

MODEL_NAME = 'facebook/dinov2-small'   # 384-d, ~22M params, CPU-feasible
HOOK_FRAMES = 8                        # first frames ≈ the hook window
BATCH = 16


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tier', default='true_label', choices=['true_label', 'corpus', 'all'])
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    import torch
    from PIL import Image
    from transformers import AutoModel
    torch.set_num_threads(max(1, os.cpu_count() - 1))
    print(f'loading {MODEL_NAME} …', flush=True)
    model = AutoModel.from_pretrained(MODEL_NAME).eval()
    # Manual preprocessing (no torchvision): resize 224, ImageNet normalise.
    MEAN = np.array([0.485, 0.456, 0.406], np.float32)
    STD = np.array([0.229, 0.224, 0.225], np.float32)

    def preprocess(im):
        im = im.resize((224, 224), Image.BICUBIC)
        a = (np.asarray(im, np.float32) / 255.0 - MEAN) / STD
        return a.transpose(2, 0, 1)   # C,H,W

    man = json.load(open(MANIFEST))
    vids = [v for v in man['videos'] if v['n_frames'] > 0 and (args.tier == 'all' or v['tier'] == args.tier)]
    if args.limit:
        vids = vids[:args.limit]
    todo = [v for v in vids if not os.path.exists(os.path.join(EMB, v['id'] + '.npy'))]
    print(f'{len(vids)} videos in tier · {len(todo)} not yet embedded', flush=True)

    @torch.no_grad()
    def embed_paths(paths):
        out = []
        for i in range(0, len(paths), BATCH):
            arrs = []
            for p in paths[i:i + BATCH]:
                try:
                    arrs.append(preprocess(Image.open(p).convert('RGB')))
                except Exception:
                    pass
            if not arrs:
                continue
            px = torch.from_numpy(np.stack(arrs)).float()
            feats = model(pixel_values=px).last_hidden_state[:, 0]   # CLS token per image
            feats = torch.nn.functional.normalize(feats, dim=1).cpu().numpy().astype(np.float32)
            out.append(feats)
        return np.concatenate(out, 0) if out else np.zeros((0, 384), np.float32)

    done = 0
    for v in todo:
        fdir = os.path.join(ROOT, v['frame_dir'])
        paths = sorted([os.path.join(fdir, f) for f in os.listdir(fdir)
                        if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp'))]) if os.path.isdir(fdir) else []
        if not paths:
            continue
        Z = embed_paths(paths)                              # N × D, L2-normalised
        if Z.shape[0] == 0:
            continue
        rec = {'frame': Z, 'mean': Z.mean(0), 'hook': Z[:HOOK_FRAMES].mean(0), 'n': Z.shape[0]}
        np.save(os.path.join(EMB, v['id'] + '.npy'), rec, allow_pickle=True)
        done += 1
        if done % 20 == 0:
            print(f'  {done}/{len(todo)} embedded …', flush=True)
    print(f'DONE · embedded {done} videos → quant2/emb/  (dim={384})', flush=True)


if __name__ == '__main__':
    main()
