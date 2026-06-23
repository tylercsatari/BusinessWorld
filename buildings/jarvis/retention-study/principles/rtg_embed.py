#!/usr/bin/env python3
"""
RTG · Phase 1 — the two channels, for the WHOLE video (not just the 5 s hook).

For every second t of every confirmed video we emit two tokens, both in the SHARED
CLIP space so cross-modal edges (C->V, V->C) are directly comparable:

  V_t = CLIP-image  of frame t           (the visual channel)
  C_t = CLIP-text   of that second's transcript words   (the conceptual channel)

This is the substrate for the dependency matrix A[i,j] (Phase 2). No interpretation
here — pure extraction, aligned to (video order x seconds 0..n-1) with owner/sec indices.

Output: rtg_tokens.npz  (owner, sec, clip_img, clip_txt, has_c)
        rtg_meta.json    (video order: id, n_sec, duration)
"""
import os, json, glob
import numpy as np, torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'


def main():
    # video order: reuse the novelty/hook pipeline order so rtg.json lines up with novelty.json
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    T = json.load(open(os.path.join(RS, 'retention_table.json')))
    dur_by = {v['id']: v.get('duration_s') for v in T['videos']}

    from transformers import CLIPModel, AutoTokenizer
    clip = CLIPModel.from_pretrained('openai/clip-vit-base-patch16').to(DEV).eval()
    ctok = AutoTokenizer.from_pretrained('openai/clip-vit-base-patch16')
    CM = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
    CS = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)

    def prep(img):
        w, h = img.size; s = 224 / min(w, h)
        img = img.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
        w, h = img.size; l = (w - 224) // 2; t = (h - 224) // 2
        a = np.asarray(img.crop((l, t, l + 224, t + 224)), np.float32) / 255.0
        return ((a - CM) / CS).transpose(2, 0, 1)

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
    meta = []
    for vi, m in enumerate(M):
        vid = m['id']
        frames = sorted(glob.glob(os.path.join(VD, vid, 'frames', 'frame_*.jpg')))
        if not frames:
            meta.append({'id': vid, 'n_sec': 0, 'duration': dur_by.get(vid)})
            continue
        n = len(frames)
        wbs = words_by_sec(vid, n)
        # --- visual tokens: CLIP image per frame, batched ---
        for k, fp in enumerate(frames):           # k = second index (0-based); frame_0001 -> sec 0
            try:
                img = Image.open(fp).convert('RGB')
            except Exception:
                continue
            with torch.no_grad():
                ci = clip.visual_projection(clip.vision_model(
                    pixel_values=torch.from_numpy(prep(img)[None]).to(DEV)).pooler_output).cpu().numpy()[0]
                txt = wbs.get(k, '') or ''
                tin = ctok([txt if txt else ' '], return_tensors='pt', padding=True,
                           truncation=True, max_length=77).to(DEV)
                ct = clip.text_projection(clip.text_model(**tin).pooler_output).cpu().numpy()[0]
            owner.append(vi); sec.append(k)
            cimg.append(ci); ctxt.append(ct); hasc.append(1 if txt else 0)
        meta.append({'id': vid, 'n_sec': n, 'duration': dur_by.get(vid)})
        if (vi + 1) % 10 == 0:
            print(f"  {vi+1}/{len(M)}  ({len(owner)} second-rows)", flush=True)

    np.savez_compressed(os.path.join(HERE, 'rtg_tokens.npz'),
                        owner=np.array(owner, np.int32), sec=np.array(sec, np.int32),
                        clip_img=np.array(cimg, np.float32), clip_txt=np.array(ctxt, np.float32),
                        has_c=np.array(hasc, np.int8))
    json.dump({'videos': meta}, open(os.path.join(HERE, 'rtg_meta.json'), 'w'))
    print(f"saved rtg_tokens.npz · {len(owner)} second-rows · {len(meta)} videos", flush=True)


if __name__ == '__main__':
    main()
