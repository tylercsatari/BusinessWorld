#!/usr/bin/env python3
"""
QUANT 2 (pure) · QP5 — score a NEW hook from raw pixels/audio.

Input: an mp4 (the candidate's first ~10s). Pipeline (all bottom-up, no LLM):
  cv2 frames + librosa audio → DINOv2 + VideoMAE + wav2vec2 + real DSP
  → quant2_scorer.pkl → predicted discrete-time swipe hazard
  → nearest gold reels (cosine on DINOv2) that kept / lost viewers
  → measured lever gaps vs the low-hazard keepers (honest: all weak → hypotheses)

Output: STRICT JSON on stdout. Usage: python3 predict_pure.py --file clip.mp4
"""
import os, sys, json, argparse, pickle, warnings
warnings.filterwarnings('ignore')
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)
VIS_DSP = ['vi_cut_rate', 'vi_motion_mean', 'vi_motion_first3_ratio', 'vi_brightness_mean', 'vi_brightness_slope', 'vi_saturation_mean', 'vi_warmth']


def grab_frames(mp4, n=16, secs=10.0):
    import cv2
    cap = cv2.VideoCapture(mp4)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(min(fps * secs, cap.get(cv2.CAP_PROP_FRAME_COUNT) or fps * secs))
    idx = np.linspace(0, max(1, total - 1), n).astype(int)
    frames, want = [], set(int(i) for i in idx)
    i = 0
    while True:
        ok, fr = cap.read()
        if not ok or i > total:
            break
        if i in want:
            frames.append(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
        i += 1
    cap.release()
    return frames


def prep(rgb):
    from PIL import Image
    im = Image.fromarray(rgb).resize((224, 224), Image.BICUBIC)
    return ((np.asarray(im, np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--file', required=True); args = ap.parse_args()
    import torch, cv2, librosa
    from transformers import AutoModel, VideoMAEModel, Wav2Vec2Model
    torch.set_num_threads(max(1, os.cpu_count() - 1))
    scorer = pickle.load(open(os.path.join(HERE, 'quant2_scorer.pkl'), 'rb'))
    gold = np.load(os.path.join(HERE, 'quant2_gold.npz'), allow_pickle=True)
    det = json.load(open(os.path.join(HERE, 'quant2_detectors.json')))

    frames = grab_frames(args.file)
    if len(frames) < 4:
        print(json.dumps({'error': 'could not read enough frames'})); return
    dino = AutoModel.from_pretrained('facebook/dinov2-small').eval()
    vmae = VideoMAEModel.from_pretrained('MCG-NJU/videomae-base').eval()

    @torch.no_grad()
    def dino_emb(arrs):
        px = torch.from_numpy(np.stack(arrs)).float()
        f = dino(pixel_values=px).last_hidden_state[:, 0]
        return torch.nn.functional.normalize(f, dim=1).numpy().astype(np.float32)
    arrs = [prep(f) for f in frames]
    Z = dino_emb(arrs); vis = np.concatenate([Z.mean(0), Z[:8].mean(0)])
    with torch.no_grad():
        idx = np.linspace(0, len(arrs) - 1, 16).astype(int)
        mh = vmae(pixel_values=torch.from_numpy(np.stack([arrs[i] for i in idx])).float().unsqueeze(0)).last_hidden_state[0]
        mot = torch.nn.functional.normalize(mh.mean(0), dim=0).numpy().astype(np.float32)

    # visual DSP
    grays = [cv2.cvtColor(cv2.resize(f, (160, 284)), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0 for f in frames]
    diffs = [float(np.abs(grays[i] - grays[i - 1]).mean()) for i in range(1, len(grays))]
    n3 = max(1, len(diffs) // 3)
    hsv = [cv2.cvtColor(cv2.resize(f, (160, 284)), cv2.COLOR_RGB2HSV) for f in frames]
    vdsp = [float(np.mean([1.0 if d > 0.18 else 0 for d in diffs])), float(np.mean(diffs)),
            float(np.mean(diffs[:n3]) / (np.mean(diffs) + 1e-6)),
            float(np.mean([h[:, :, 2].mean() for h in hsv]) / 255), 0.0,
            float(np.mean([h[:, :, 1].mean() for h in hsv]) / 255),
            float(np.mean([(f[:, :, 0].mean() - f[:, :, 2].mean()) for f in frames]) / 255)]

    # audio (optional)
    aud = None
    try:
        y, sr = librosa.load(args.file, sr=16000, mono=True, duration=10.0)
        if len(y) > sr // 2:
            wav = Wav2Vec2Model.from_pretrained('facebook/wav2vec2-base').eval()
            with torch.no_grad():
                hh = wav(torch.from_numpy(y).float().unsqueeze(0)).last_hidden_state[0]
                am = torch.nn.functional.normalize(hh.mean(0), dim=0).numpy().astype(np.float32)
                hk = torch.nn.functional.normalize(wav(torch.from_numpy(y[:int(3 * sr)]).float().unsqueeze(0)).last_hidden_state[0].mean(0), dim=0).numpy().astype(np.float32)
                aud = np.concatenate([am, hk])
    except Exception:
        aud = None

    # assemble in the scorer's feature order: PCA(vis)⊕PCA(mot)⊕PCA(aud)⊕vdsp ⊕ interval ⊕ recency
    def pca_of(key, vec, dim):
        sc, pc = scorer['scalers'][key], scorer['pcas'][key]
        v = vec if vec is not None else np.zeros(dim)
        return pc.transform(sc.transform(v.reshape(1, -1)))[0]
    base = list(pca_of('vis', vis, 1536)) + list(pca_of('mot', mot, 768)) + list(pca_of('aud', aud, 1536)) + list(vdsp)
    haz = []
    for j in range(4):
        x = np.array(base + [1.0 if k == j else 0.0 for k in range(4)] + [1.0]).reshape(1, -1)  # recency=1 (now, latest era)
        logit = scorer['model'].predict(scorer['fscl'].transform(x))[0]
        haz.append(float(1 / (1 + np.exp(-logit))))
    survival = [1.0]
    for hh2 in haz:
        survival.append(survival[-1] * (1 - hh2))

    # nearest gold exemplars (cosine on DINOv2 vision)
    vn = vis / (np.linalg.norm(vis) + 1e-9)
    sims = gold['emb'] @ vn
    order = np.argsort(sims)
    near = lambda i: {'id': str(gold['ids'][i]), 'name': str(gold['names'][i]), 'frame0': str(gold['frame0'][i]),
                      'hazard': round(float(gold['hazard'][i]), 3), 'sim': round(float(sims[i]), 3)}
    nearest = [near(i) for i in order[-5:][::-1]]
    keepers = [near(i) for i in order[-30:] if float(gold['hazard'][i]) <= 0.12][:4]

    # measured lever gaps vs keepers (honest, weak)
    cand_dsp = dict(zip(VIS_DSP, vdsp))
    gaps = []
    for L in det['levers']:
        if L['key'] not in cand_dsp:
            continue
        cv_ = cand_dsp[L['key']]; tgt = L['median_keepers']
        if abs(L['rho_with_hazard']) < 0.04:
            continue
        gaps.append({'label': L['label'], 'yours': round(cv_, 3), 'keepers': round(tgt, 3),
                     'suggest': L['direction'], 'rho': L['rho_with_hazard']})

    print(json.dumps({
        'hazard': haz, 'survival': survival, 'swipe10s': round(1 - survival[-1], 3),
        'predicted_keep_overall': round(float(np.mean(survival)), 3),
        'nearest_examples': nearest, 'low_hazard_neighbours': keepers,
        'lever_gaps': gaps[:6], 'has_audio': aud is not None,
        'confidence': 'low', 'caveat': 'Rank-only model (rho~0.45, R2~0 at n=211). Levers are weak hypotheses, not rules — A/B test before trusting.',
    }))


if __name__ == '__main__':
    main()
