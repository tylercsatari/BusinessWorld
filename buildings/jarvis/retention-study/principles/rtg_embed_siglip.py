#!/usr/bin/env python3
"""
RTG declared-route tokens — SigLIP 2 (strong vision-language), full video, per second.

Replaces the weak CLIP tokens for the DECLARED route: SigLIP2 puts a spoken noun and the
later frame that shows it in the same space far better than CLIP. Output keys match
rtg_tokens.npz (clip_img / clip_txt) so rtg_declared.py reuses rtg_build.py's machinery.

Output: rtg_tokens_siglip.npz  (owner, sec, clip_img, clip_txt, has_c)
"""
import os, json, glob
import numpy as np, torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'
MID = 'google/siglip2-so400m-patch16-384'


def main():
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    from transformers import AutoModel, AutoProcessor
    print(f"loading {MID} · {DEV}", flush=True)
    model = AutoModel.from_pretrained(MID).to(DEV).eval()
    proc = AutoProcessor.from_pretrained(MID)
    emb = lambda o: (o.pooler_output if hasattr(o, 'pooler_output') else (o.last_hidden_state.mean(1) if hasattr(o, 'last_hidden_state') else o))

    def words_by_sec(vid, n):
        out = {t: [] for t in range(n)}
        try:
            a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
            w = (a.get('transcript') or {}).get('words') or []
        except Exception:
            w = []
        for x in w:
            ts = x.get('timestamp')
            if isinstance(ts, (int, float)) and 0 <= int(ts) < n:
                out[int(ts)].append(x.get('word', ''))
        return {t: ' '.join(z for z in out[t] if z).strip() for t in range(n)}

    owner, sec, cimg, ctxt, hasc = [], [], [], [], []
    for vi, mv in enumerate(M):
        vid = mv['id']
        frames = sorted(glob.glob(os.path.join(VD, vid, 'frames', 'frame_*.jpg')))
        n = len(frames)
        if not n:
            continue
        wbs = words_by_sec(vid, n)
        imgs = [Image.open(f).convert('RGB') for f in frames]
        txts = [wbs.get(k, '') or ' ' for k in range(n)]
        with torch.no_grad():
            iv = []
            for s in range(0, n, 16):
                pv = proc(images=imgs[s:s + 16], return_tensors='pt').to(DEV)
                iv.append(emb(model.get_image_features(**pv)).float().cpu().numpy())
            Vv = np.concatenate(iv, 0)
            ti = proc(text=txts, return_tensors='pt', padding='max_length', truncation=True).to(DEV)
            Tt = emb(model.get_text_features(**ti)).float().cpu().numpy()
        for k in range(n):
            owner.append(vi); sec.append(k); cimg.append(Vv[k]); ctxt.append(Tt[k]); hasc.append(1 if wbs.get(k) else 0)
        if (vi + 1) % 10 == 0:
            print(f"  {vi+1}/{len(M)} · {len(owner)} rows", flush=True)
    np.savez_compressed(os.path.join(HERE, 'rtg_tokens_siglip.npz'),
                        owner=np.array(owner, np.int32), sec=np.array(sec, np.int32),
                        clip_img=np.array(cimg, np.float32), clip_txt=np.array(ctxt, np.float32),
                        has_c=np.array(hasc, np.int8))
    print(f"saved rtg_tokens_siglip.npz · {len(owner)} rows", flush=True)


if __name__ == '__main__':
    main()
