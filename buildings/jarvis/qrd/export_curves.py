#!/usr/bin/env python3
"""
Export real per-frame TIME-SERIES curves for a handful of representative reels,
so the QRD tab can visualise "keep the time axis" (§4-6) — the mel-spectrogram,
the audio descriptor channels over time, the visual channels over time, the
event-alignment markers, and the level-2 path-signature interaction matrix.

Output: qrd_curves.json  (lean — arrays downsampled, a few reels only).
"""
import os, json, warnings
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
import librosa

from extract_features import ensure_wav, load_frames, SR, T, CUT_THRESH
from signatures import signature_features

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(JARVIS))
VIDEO_DATA = os.path.join(ROOT, 'video_data')
EXPANDED = os.path.join(JARVIS, 'signals-dataset-expanded.json')
FEATURES = os.path.join(HERE, 'qrd_features.json')
MODEL = os.path.join(HERE, 'qrd_model.json')
OUT = os.path.join(HERE, 'qrd_curves.json')

NPTS = 120           # time samples per channel
NMEL_OUT = 32        # mel bands kept for the heatmap
NMEL_T = 96          # mel time frames kept
import cv2


def downsample(arr, n):
    arr = np.asarray(arr, dtype=np.float64)
    if arr.size <= 1:
        return [0.0] * n
    xs = np.linspace(0, 1, arr.size)
    return list(np.interp(np.linspace(0, 1, n), xs, arr))


def norm01(arr):
    a = np.asarray(arr, dtype=np.float64)
    lo, hi = np.nanmin(a), np.nanmax(a)
    return ((a - lo) / (hi - lo)).tolist() if hi - lo > 1e-9 else (a * 0).tolist()


def audio_curves(d):
    wav, is_tmp = ensure_wav(d)
    if not wav:
        return None
    try:
        y, sr = librosa.load(wav, sr=SR, mono=True, duration=T)
    finally:
        pass
    hop = 512
    out = {}
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    times = librosa.times_like(rms, sr=sr, hop_length=hop)
    out['t_audio'] = downsample(times, NPTS)
    out['loudness'] = norm01(downsample(rms, NPTS))
    out['centroid'] = norm01(downsample(librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0], NPTS))
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    out['onset'] = norm01(downsample(onset, NPTS))
    out['zcr'] = norm01(downsample(librosa.feature.zero_crossing_rate(y, hop_length=hop)[0], NPTS))
    try:
        f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1200, sr=sr, hop_length=hop)
        out['pitch'] = norm01(downsample(np.nan_to_num(f0, nan=0.0), NPTS))
    except Exception:
        out['pitch'] = [0.0] * NPTS
    # mel-spectrogram heatmap (log power, normalised)
    mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=64, hop_length=hop)
    meldb = librosa.power_to_db(mel, ref=np.max)
    # downsample bands (avg pairs) and time
    bands = meldb.reshape(NMEL_OUT, mel.shape[0] // NMEL_OUT, mel.shape[1]).mean(axis=1)
    ti = np.linspace(0, bands.shape[1] - 1, NMEL_T).astype(int)
    grid = bands[:, ti]
    g = (grid - grid.min()) / (grid.max() - grid.min() + 1e-9)
    out['mel'] = [[round(float(v), 3) for v in row] for row in g]  # NMEL_OUT × NMEL_T
    out['mel_dims'] = [NMEL_OUT, NMEL_T]
    ot = librosa.onset.onset_detect(onset_envelope=onset, sr=sr, hop_length=hop, units='time')
    out['first_onset'] = float(ot[0]) if len(ot) else None
    if is_tmp:
        try: os.unlink(wav)
        except Exception: pass
    return out


def visual_curves(d, analysis):
    frames = load_frames(d, analysis)
    if not frames:
        return None
    times = [t for t, _ in frames]
    bright, sat, grays = [], [], []
    for t, img in frames:
        small = cv2.resize(img, (160, 284))
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        grays.append(gray.astype(np.float32) / 255.0)
        bright.append(float(gray.mean()) / 255.0)
        sat.append(float(hsv[:, :, 1].mean()) / 255.0)
    motion, cut_times = [0.0], []
    for i in range(1, len(grays)):
        dval = float(np.abs(grays[i] - grays[i - 1]).mean())
        motion.append(dval)
        if dval > CUT_THRESH:
            cut_times.append(times[i])
    return {
        't_visual': downsample(times, NPTS),
        'brightness': norm01(downsample(bright, NPTS)),
        'saturation': norm01(downsample(sat, NPTS)),
        'motion': norm01(downsample(motion, NPTS)),
        'cut_times': [round(float(c), 2) for c in cut_times],
        'first_cut': float(cut_times[0]) if cut_times else None,
        'duration_seen': float(times[-1]) if times else 0.0,
    }


def signature_matrix(d, analysis):
    """Small aligned multichannel signature for the §6 interaction heatmap."""
    chans = {}
    ac = audio_curves(d)
    if ac:
        for k in ('loudness', 'pitch', 'onset'):
            chans['A·' + k] = ac[k]
    vc = visual_curves(d, analysis)
    if vc:
        for k in ('brightness', 'motion'):
            chans['V·' + k] = vc[k]
    if len(chans) < 2:
        return None
    names = list(chans.keys())
    # build the d×d antisymmetric area matrix from level-2 terms
    sig_names, sig = signature_features(chans, with_time=False, normalize=True)
    idx = {n: i for i, n in enumerate(sig_names)}
    mat = []
    for a in names:
        row = []
        for b in names:
            ka, kb = f'sig2_{a}_{b}', f'sig2_{b}_{a}'
            area = (sig[idx[ka]] - sig[idx[kb]]) if (ka in idx and kb in idx) else 0.0
            row.append(round(float(area), 3))
        mat.append(row)
    return {'channels': names, 'area': mat}


def main():
    rows = {r['ytId']: r for r in json.load(open(EXPANDED)) if r.get('ytId')}
    feats = {r['ytId']: r for r in json.load(open(FEATURES))}
    arche = {}
    if os.path.exists(MODEL):
        arche = json.load(open(MODEL)).get('archetypes', {}).get('assign', {})
    # candidates: reels WITH audio
    audio_ids = [yid for yid, f in feats.items() if f.get('a_has_audio') and yid in rows]
    audio_ids.sort(key=lambda y: -rows[y].get('views', 0))
    NPICK = 6
    pick = []
    # one top-viewed reel from each archetype for diversity
    for a in sorted(set(arche.get(y, -1) for y in audio_ids)):
        for yid in audio_ids:
            if arche.get(yid, -1) == a and yid not in pick:
                pick.append(yid); break
    # fill the rest with the highest-viewed reels with audio
    for yid in audio_ids:
        if len(pick) >= NPICK:
            break
        if yid not in pick:
            pick.append(yid)
    pick = pick[:NPICK]

    out = []
    for yid in pick:
        d = os.path.join(VIDEO_DATA, yid)
        analysis = None
        ap = os.path.join(d, 'analysis.json')
        if os.path.exists(ap):
            try: analysis = json.load(open(ap))
            except Exception: pass
        try:
            ac = audio_curves(d)
            vc = visual_curves(d, analysis)
            sig = signature_matrix(d, analysis)
        except Exception as e:
            print(f'  {yid} ERROR {e}'); continue
        words = ((analysis or {}).get('transcript', {}) or {}).get('words', [])
        first_word = words[0]['timestamp'] if words and isinstance(words[0].get('timestamp'), (int, float)) else None
        rec = {
            'ytId': yid,
            'name': rows[yid].get('name', yid),
            'views': rows[yid].get('views'),
            'retention': rows[yid].get('retention'),
            'archetype': arche.get(yid),
            'audio': ac, 'visual': vc, 'signature': sig,
            'align': {
                'first_word': first_word,
                'first_onset': ac.get('first_onset') if ac else None,
                'first_cut': vc.get('first_cut') if vc else None,
            },
        }
        t0c = [x for x in [first_word, rec['align']['first_onset'], rec['align']['first_cut']] if isinstance(x, (int, float)) and x > 0]
        rec['align']['t0'] = float(min(t0c)) if t0c else 0.0
        out.append(rec)
        print(f'  exported {yid}  views={rows[yid].get("views")}  arch={arche.get(yid)}')
    json.dump(out, open(OUT, 'w'))
    print(f'\nDONE → qrd_curves.json ({len(out)} reels)  {os.path.getsize(OUT)//1024} KB')


if __name__ == '__main__':
    main()
