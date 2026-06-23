#!/usr/bin/env python3
"""
RTG v2 visual tokens — V-JEPA2 (temporal), replacing single-frame CLIP-image.

CLIP sees one frame: it knows WHAT is on screen, not what is HAPPENING. V-JEPA2 is a
video model — for each second we feed a short clip window (W frames centred on that
second) so the visual token encodes motion/events, which is what a "promise->proof"
binding actually depends on. Manual preprocessing (no torchvision in this env).

Output: rtg_tokens_vjepa.npz  (owner, sec, vjepa[1408]) — aligned to rtg_tokens.npz order.
Slow: ~2.8s/clip on MPS → the full ~10.5k seconds is an overnight (~8h) run. Keep the
CLIP-text concept tokens from rtg_tokens.npz; this only replaces the visual channel.
"""
import os, json, glob, time
import numpy as np, torch
from PIL import Image
from transformers import AutoModel

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'
W = 16            # frames per clip window (temporal context around each second)
RESZ = 256
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 1, 3, 1, 1)


def main():
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    print(f"loading V-JEPA2-giant · device {DEV}", flush=True)
    m = AutoModel.from_pretrained('facebook/vjepa2-vitg-fpc64-256').to(DEV).eval()

    def load_frame(fp):
        im = Image.open(fp).convert('RGB').resize((RESZ, RESZ), Image.BICUBIC)
        return np.asarray(im, np.float32) / 255.0          # (H,W,3)

    owner, sec, vecs = [], [], []
    t0 = time.time()
    for vi, mv in enumerate(M):
        vid = mv['id']
        frames = sorted(glob.glob(os.path.join(VD, vid, 'frames', 'frame_*.jpg')))
        n = len(frames)
        if not n:
            continue
        cache = {}
        for s in range(n):
            idxs = np.clip(s - W // 2 + np.arange(W), 0, n - 1)
            arr = np.stack([cache.setdefault(k, load_frame(frames[k])) for k in idxs])     # (W,H,W,3)
            x = torch.from_numpy(arr).permute(0, 3, 1, 2).unsqueeze(0)                       # (1,W,3,H,W)
            x = ((x - MEAN) / STD).to(DEV)
            with torch.no_grad():
                h = m(pixel_values_videos=x).last_hidden_state                              # (1,tokens,1408)
                v = h.mean(1).squeeze(0).float().cpu().numpy()
            owner.append(vi); sec.append(s); vecs.append(v)
        if (vi + 1) % 5 == 0:
            el = time.time() - t0
            print(f"  {vi+1}/{len(M)} · {len(owner)} tokens · {el/60:.0f}m · ~{el/len(owner)*10545/3600:.1f}h total", flush=True)
            np.savez_compressed(os.path.join(HERE, 'rtg_tokens_vjepa.npz'),
                                owner=np.array(owner, np.int32), sec=np.array(sec, np.int32),
                                vjepa=np.array(vecs, np.float32))
    np.savez_compressed(os.path.join(HERE, 'rtg_tokens_vjepa.npz'),
                        owner=np.array(owner, np.int32), sec=np.array(sec, np.int32),
                        vjepa=np.array(vecs, np.float32))
    print(f"saved rtg_tokens_vjepa.npz · {len(owner)} tokens", flush=True)


if __name__ == '__main__':
    main()
