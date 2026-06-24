#!/usr/bin/env python3
"""
RTG · CONTEXT aggregation. "carbon fiber" at one second is not a reference; the whole
utterance it sits inside is ("could this helmet survive a bat if covered in carbon fiber").

So the concept token at second t is re-embedded as the ROLLING UTTERANCE — the joined
transcript over a causal recency window up to t — with SigLIP2 text. No segmentation
(continuous sliding window, never cut); just more context. The visual tokens are reused
unchanged from rtg_tokens_siglip.npz.

Output: rtg_tokens_ctx.npz  (owner, sec, clip_img [reused], clip_txt [contextual], has_c)
"""
import os, json
import numpy as np, torch

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
VD = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(RS))), 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'
MID = 'google/siglip2-so400m-patch16-384'
W = 10                      # causal recency window (seconds) — spans a typical utterance


def words_by_sec(vid, n):
    out = ['' for _ in range(n)]
    try:
        a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
        w = (a.get('transcript') or {}).get('words') or []
    except Exception:
        return out
    b = {t: [] for t in range(n)}
    for x in w:
        ts = x.get('timestamp')
        if isinstance(ts, (int, float)) and 0 <= int(ts) < n:
            b[int(ts)].append(x.get('word', ''))
    return [' '.join(z for z in b[t] if z).strip() for t in range(n)]


def main():
    z = np.load(os.path.join(HERE, 'rtg_tokens_siglip.npz'))
    owner, sec, V = z['owner'], z['sec'], z['clip_img']
    meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
    from transformers import AutoModel, AutoProcessor
    print(f"loading {MID} · {DEV}", flush=True)
    model = AutoModel.from_pretrained(MID).to(DEV).eval()
    proc = AutoProcessor.from_pretrained(MID)
    emb = lambda o: (o.pooler_output if hasattr(o, 'pooler_output') else (o.last_hidden_state.mean(1) if hasattr(o, 'last_hidden_state') else o))

    seq = {}
    for r in range(len(owner)):
        seq.setdefault(int(owner[r]), []).append(r)

    ctxt = np.zeros((len(owner), V.shape[1]), np.float32)
    hasc = np.zeros(len(owner), np.int8)
    for vi in sorted(seq):
        rows = sorted(seq[vi], key=lambda r: sec[r]); n = len(rows)
        words = words_by_sec(meta[vi]['id'], n)
        ctx = [' '.join(w for w in words[max(0, t - W + 1):t + 1] if w).strip() for t in range(n)]
        with torch.no_grad():
            ti = proc(text=[c if c else ' ' for c in ctx], return_tensors='pt', padding='max_length', truncation=True).to(DEV)
            T = emb(model.get_text_features(**ti)).float().cpu().numpy()
        for k, r in enumerate(rows):
            ctxt[r] = T[k]; hasc[r] = 1 if ctx[k] else 0
        if (vi + 1) % 20 == 0:
            print(f"  {vi+1}/{len(meta)}", flush=True)

    np.savez_compressed(os.path.join(HERE, 'rtg_tokens_ctx.npz'),
                        owner=owner, sec=sec, clip_img=V, clip_txt=ctxt, has_c=hasc)
    print(f"saved rtg_tokens_ctx.npz · {len(owner)} rows · window {W}s", flush=True)


if __name__ == '__main__':
    main()
