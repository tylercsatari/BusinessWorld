#!/usr/bin/env python3
"""
TEXT EMBEDDINGS — fold on-screen text into the semantic modalities.

Per the spec: on-screen text is SEMANTIC, so it joins CONCEPT and WHOLE novelty (not visual),
and also gets its OWN modality/embedding.

For hook and for each second we build:
  clip_txt_comb  CLIP text of (spoken script + on-screen text)  → feeds the WHOLE embedding
  mini_comb      MiniLM of (spoken + on-screen)                 → the new CONCEPT embedding
  mini_text      MiniLM of (on-screen only)                     → the standalone TEXT modality

Rows aligned to (video order × seconds 1..5 that exist) — same as persec_emb.npz.
Output: text_emb.npz
"""
import os, json
import numpy as np, torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'


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


def main():
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    OCR = json.load(open(os.path.join(HERE, 'ocr.json')))
    from transformers import CLIPModel, AutoTokenizer
    from sentence_transformers import SentenceTransformer
    clip = CLIPModel.from_pretrained('openai/clip-vit-base-patch16').to(DEV).eval()
    ctok = AutoTokenizer.from_pretrained('openai/clip-vit-base-patch16')
    st = SentenceTransformer('all-MiniLM-L6-v2', device=DEV)

    def clip_text(s):
        with torch.no_grad():
            tin = ctok([s or ' '], return_tensors='pt', padding=True, truncation=True, max_length=77).to(DEV)
            return clip.text_projection(clip.text_model(**tin).pooler_output).cpu().numpy()[0]

    # hook level
    h_clip, h_mini, h_text = [], [], []
    for m in M:
        vid = m['id']; spoken = (m.get('hook_text') or '').strip(); scr = (OCR.get(vid, {}).get('hook') or '').strip()
        comb = (spoken + ' ' + scr).strip()
        h_clip.append(clip_text(comb[:300])); h_mini.append(st.encode(comb or ' ')); h_text.append(st.encode(scr or ' '))

    # second level (aligned to video order × frames 1..5 that exist)
    s_owner, s_sec, s_clip, s_mini, s_text = [], [], [], [], []
    for vi, m in enumerate(M):
        vid = m['id']; wbs = words_by_sec(vid)
        ocrsec = {p['t']: p.get('text', '') for p in OCR.get(vid, {}).get('persec', [])}
        for k in range(1, 6):
            if not os.path.exists(os.path.join(VD, vid, 'frames', f'frame_{k:04d}.jpg')):
                continue
            spoken = wbs.get(k - 1, ''); scr = ocrsec.get(k - 1, '')
            comb = (spoken + ' ' + scr).strip()
            s_owner.append(vi); s_sec.append(k - 1)
            s_clip.append(clip_text(comb[:300])); s_mini.append(st.encode(comb or ' ')); s_text.append(st.encode(scr or ' '))
        if (vi + 1) % 40 == 0:
            print(f"  {vi+1}/{len(M)}", flush=True)

    np.savez_compressed(os.path.join(HERE, 'text_emb.npz'),
                        h_clip=np.array(h_clip, np.float32), h_mini=np.array(h_mini, np.float32), h_text=np.array(h_text, np.float32),
                        s_owner=np.array(s_owner, np.int32), s_sec=np.array(s_sec, np.int32),
                        s_clip=np.array(s_clip, np.float32), s_mini=np.array(s_mini, np.float32), s_text=np.array(s_text, np.float32))
    print(f"text_emb.npz · {len(h_mini)} hooks · {len(s_mini)} seconds", flush=True)


if __name__ == '__main__':
    main()
