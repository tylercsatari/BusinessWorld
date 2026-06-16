#!/usr/bin/env python3
"""
QUANT 2 (pure) · QP1 audio lane — frozen wav2vec2 over the raw waveform.

Self-supervised audio representation (NOT speech-to-text, NOT an LLM rating):
wav2vec2 learned structure from raw audio with no labels. We pool its hidden
states into a per-video audio embedding + a hook-window (first 3s) embedding —
the sonic shape of the open (loudness swell, beat, pitch lift) as a vector.

Source: video_data/<id>/video.mp4 (109 true-label reels have it). 16 kHz mono.
Cache: quant2/emb_audio/<id>.npy  (dict: mean[D], hook[D]). Idempotent.
"""
import os, json, warnings
warnings.filterwarnings('ignore')
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
EMB = os.path.join(HERE, 'emb_audio'); os.makedirs(EMB, exist_ok=True)
MANIFEST = os.path.join(HERE, 'manifest.json')
MODEL_NAME = 'facebook/wav2vec2-base'   # 768-d, self-supervised
SR = 16000
HOOK_S = 3.0
WIN_S = 10.0   # first 10s only — the hook window


def main():
    import torch, librosa
    from transformers import Wav2Vec2Model
    torch.set_num_threads(max(1, os.cpu_count() - 1))
    print(f'loading {MODEL_NAME} …', flush=True)
    model = Wav2Vec2Model.from_pretrained(MODEL_NAME).eval()

    vids = [v for v in json.load(open(MANIFEST))['videos'] if v.get('mp4')]
    todo = [v for v in vids if not os.path.exists(os.path.join(EMB, v['id'] + '.npy'))]
    print(f'{len(vids)} videos with audio · {len(todo)} to embed', flush=True)

    @torch.no_grad()
    def embed(wav):
        x = torch.from_numpy(wav).float().unsqueeze(0)
        h = model(x).last_hidden_state[0]                 # T × 768
        return torch.nn.functional.normalize(h.mean(0), dim=0).numpy().astype(np.float32), h

    done = 0
    for v in todo:
        mp4 = os.path.join(ROOT, v['mp4'])
        try:
            y, _ = librosa.load(mp4, sr=SR, mono=True, duration=WIN_S)
        except Exception as e:
            continue
        if y is None or len(y) < SR:
            continue
        try:
            mean_e, h = embed(y)
            hook_y = y[:int(HOOK_S * SR)]
            hook_e = (embed(hook_y)[0] if len(hook_y) > SR // 2 else mean_e)
        except Exception:
            continue
        np.save(os.path.join(EMB, v['id'] + '.npy'), {'mean': mean_e, 'hook': hook_e}, allow_pickle=True)
        done += 1
        if done % 20 == 0:
            print(f'  {done}/{len(todo)} audio-embedded …', flush=True)
    print(f'DONE · audio-embedded {done} videos → emb_audio/ (dim=768)', flush=True)


if __name__ == '__main__':
    main()
