#!/usr/bin/env python3
"""
QUANT 2 (pure) · QP1 DSP lane — real measured signals (NO LLM, NO ratings).

Hand-computed descriptors the brief lists explicitly — every one is a deterministic
measurement of the pixels/waveform, reproducible by re-running this code:

  Visual (from frames, all 213):
    cut_rate            fraction of consecutive frame-pairs that are a cut (diff > thr)
    motion_mean         mean frame-to-frame pixel change (cheap motion energy)
    motion_first3_ratio hook motion vs rest
    brightness_mean/slope, saturation_mean, warmth   (HSV / RGB)
  Audio (from mp4, 109):
    rms_mean / rms_first3_ratio / rms_slope   loudness swell (the "WAAASUP" ramp)
    pitch_mean / pitch_slope                  intonation / question lift (pyin)
    onset_mean, zcr_mean, centroid_mean, voiced_ratio

Output: dsp.json  { <id>: { feature: value, ... } }.  These are the bottom-up,
language-free counterpart to the banned LLM scores.
"""
import os, json, warnings
warnings.filterwarnings('ignore')
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
MANIFEST = os.path.join(HERE, 'manifest.json')
OUT = os.path.join(HERE, 'dsp.json')
CUT_THR = 0.18
WIN_S = 10.0


def visual_dsp(fdir):
    import cv2
    files = sorted([f for f in os.listdir(fdir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]) if os.path.isdir(fdir) else []
    if len(files) < 3:
        return None
    grays, brights, sats, warmths = [], [], [], []
    for f in files:
        im = cv2.imread(os.path.join(fdir, f))
        if im is None:
            continue
        im = cv2.resize(im, (160, 284))
        hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
        grays.append(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0)
        brights.append(float(hsv[:, :, 2].mean()) / 255.0)
        sats.append(float(hsv[:, :, 1].mean()) / 255.0)
        b, g, r = im[:, :, 0].mean(), im[:, :, 1].mean(), im[:, :, 2].mean()
        warmths.append(float(r - b) / 255.0)
    if len(grays) < 3:
        return None
    diffs = [float(np.abs(grays[i] - grays[i - 1]).mean()) for i in range(1, len(grays))]
    n3 = max(1, len(diffs) // 3)
    cut_rate = float(np.mean([1.0 if d > CUT_THR else 0.0 for d in diffs]))
    motion_mean = float(np.mean(diffs))
    motion_first3_ratio = float(np.mean(diffs[:n3]) / (np.mean(diffs) + 1e-6))
    bslope = float(np.polyfit(np.arange(len(brights)), brights, 1)[0]) if len(brights) > 2 else 0.0
    return {'vi_cut_rate': cut_rate, 'vi_motion_mean': motion_mean, 'vi_motion_first3_ratio': motion_first3_ratio,
            'vi_brightness_mean': float(np.mean(brights)), 'vi_brightness_slope': bslope,
            'vi_saturation_mean': float(np.mean(sats)), 'vi_warmth': float(np.mean(warmths))}


def audio_dsp(mp4):
    import librosa
    try:
        y, sr = librosa.load(mp4, sr=22050, mono=True, duration=WIN_S)
    except Exception:
        return None
    if y is None or len(y) < sr // 2:
        return None
    rms = librosa.feature.rms(y=y)[0]
    n3 = max(1, len(rms) // 3)
    cent = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    onset = librosa.onset.onset_strength(y=y, sr=sr)
    zcr = librosa.feature.zero_crossing_rate(y)[0]
    try:
        f0, vflag, _ = librosa.pyin(y, fmin=65, fmax=1200, sr=sr)
        f0v = f0[~np.isnan(f0)]
        pitch_mean = float(np.mean(f0v)) if len(f0v) else 0.0
        pitch_slope = float(np.polyfit(np.arange(len(f0v)), f0v, 1)[0]) if len(f0v) > 4 else 0.0
        voiced = float(np.mean(vflag)) if vflag is not None else 0.0
    except Exception:
        pitch_mean = pitch_slope = voiced = 0.0
    return {'a_rms_mean': float(np.mean(rms)), 'a_rms_first3_ratio': float(np.mean(rms[:n3]) / (np.mean(rms) + 1e-6)),
            'a_rms_slope': float(np.polyfit(np.arange(len(rms)), rms, 1)[0]) if len(rms) > 4 else 0.0,
            'a_pitch_mean': pitch_mean, 'a_pitch_slope': pitch_slope, 'a_voiced_ratio': voiced,
            'a_onset_mean': float(np.mean(onset)), 'a_zcr_mean': float(np.mean(zcr)),
            'a_centroid_mean': float(np.mean(cent)) / sr}


def main():
    vids = [v for v in json.load(open(MANIFEST))['videos'] if v['tier'] == 'true_label']
    out = json.load(open(OUT)) if os.path.exists(OUT) else {}
    done = 0
    for v in vids:
        if v['id'] in out:
            continue
        rec = {}
        vd = visual_dsp(os.path.join(ROOT, v['frame_dir']))
        if vd:
            rec.update(vd)
        if v.get('mp4'):
            ad = audio_dsp(os.path.join(ROOT, v['mp4']))
            if ad:
                rec.update(ad)
        if rec:
            out[v['id']] = rec; done += 1
        if done % 25 == 0 and done:
            print(f'  {done} done …', flush=True); json.dump(out, open(OUT, 'w'))
    json.dump(out, open(OUT, 'w'))
    nv = sum(1 for r in out.values() if 'vi_cut_rate' in r); na = sum(1 for r in out.values() if 'a_rms_mean' in r)
    print(f'DSP: {len(out)} videos · visual {nv} · audio {na} → dsp.json')


if __name__ == '__main__':
    main()
