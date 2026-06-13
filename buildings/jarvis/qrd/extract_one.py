#!/usr/bin/env python3
"""
Extract playground features from ONE uploaded file and predict swipe-away/dud.

Features are computed identically to the training extractor (extract_features.py)
so predictions stay consistent with the trained model. Supports:
  --type video : frames pulled from the mp4 + audio via ffmpeg
  --type audio : audio only (visual features imputed → flagged degraded)
Transcript (speaking rate / time-to-first-word / question hook) via whisper if
available; imputed otherwise.

Outputs a JSON result (prediction + per-feature contributions + degraded flags)
to stdout. Used by the server /api/qrd/predict endpoint.
"""
import os, sys, json, argparse, tempfile, subprocess, warnings
warnings.filterwarnings('ignore')
import numpy as np
import librosa, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = json.load(open(os.path.join(HERE, 'qrd_playground_model.json')))
T = 10.0
SR = 22050
CUT_THRESH = 0.18


def reduce_curve(curve, times, prefix, T=T):
    curve = np.asarray(curve, float); times = np.asarray(times, float)
    m = np.isfinite(curve) & np.isfinite(times); curve, times = curve[m], times[m]
    out = {}
    if curve.size < 2:
        return {f'{prefix}_mean': float(curve.mean()) if curve.size else 0.0}
    out[f'{prefix}_mean'] = float(np.mean(curve)); out[f'{prefix}_std'] = float(np.std(curve))
    try: out[f'{prefix}_slope'] = float(np.polyfit(times, curve, 1)[0])
    except Exception: out[f'{prefix}_slope'] = 0.0
    out[f'{prefix}_at3'] = float(np.interp(3.0, times, curve))
    early = curve[times < 3.0]; rest = curve[times >= 3.0]
    out[f'{prefix}_first3_ratio'] = float(early.mean() / rest.mean()) if (early.size and rest.size and abs(rest.mean()) > 1e-9) else 1.0
    return out


def audio_features(wav):
    y, sr = librosa.load(wav, sr=SR, mono=True, duration=T)
    hop = 512; f = {}
    tl = lambda c: librosa.times_like(c, sr=sr, hop_length=hop)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]; f.update(reduce_curve(rms, tl(rms), 'a_loud'))
    cen = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]; f.update(reduce_curve(cen, tl(cen), 'a_centroid'))
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop); f.update(reduce_curve(onset, tl(onset), 'a_onset'))
    zcr = librosa.feature.zero_crossing_rate(y, hop_length=hop)[0]; f.update(reduce_curve(zcr, tl(zcr), 'a_zcr'))
    try:
        f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1200, sr=sr, hop_length=hop)
        f['a_voiced_ratio'] = float(np.nanmean(voiced.astype(float)))
        f.update(reduce_curve(np.nan_to_num(f0, nan=0.0), tl(f0), 'a_pitch'))
    except Exception: pass
    try:
        mf = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)
        f['a_mfcc1_mean'] = float(np.mean(mf[0]))
    except Exception: pass
    return f


def video_to_wav_full(path):
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', str(SR), tmp],
                   check=True, timeout=180)
    return tmp


def frames_from_video(path, fps=1):  # ~1 fps to match training frame cadence (consistency). ALL frames.
    cap = cv2.VideoCapture(path)
    vfps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, int(vfps / fps))
    out = []; i = 0
    while True:
        ok, frame = cap.read()
        if not ok: break
        if i % step == 0:
            out.append((i / vfps, frame))
        i += 1
    cap.release()
    return out


def visual_features(frames):
    if not frames:
        return {}
    f = {}; times = [t for t, _ in frames]
    bright, sat, contrast, warmth, grays = [], [], [], [], []
    for t, img in frames:
        small = cv2.resize(img, (160, 284)); hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV); gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        grays.append(gray.astype(np.float32) / 255.0)
        bright.append(float(gray.mean()) / 255.0); sat.append(float(hsv[:, :, 1].mean()) / 255.0)
        contrast.append(float(gray.std()) / 255.0)
        b, g, r = small[:, :, 0].mean(), small[:, :, 1].mean(), small[:, :, 2].mean(); warmth.append(float(r - b) / 255.0)
    f.update(reduce_curve(bright, times, 'vi_bright')); f.update(reduce_curve(sat, times, 'vi_sat'))
    f.update(reduce_curve(contrast, times, 'vi_contrast')); f.update(reduce_curve(warmth, times, 'vi_warmth'))
    motion, cuts, first_cut = [], 0, None
    for i in range(1, len(grays)):
        d = float(np.abs(grays[i] - grays[i - 1]).mean()); motion.append(d)
        if d > CUT_THRESH:
            cuts += 1
    if motion:
        f.update(reduce_curve(motion, times[1:], 'vi_motion'))
    span = max(times[-1] - times[0], 1e-6); f['vi_cut_rate'] = float(cuts / span)
    try:
        clf = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        FW, FH = 240, 426; idxs = np.linspace(0, len(frames) - 1, min(12, len(frames))).astype(int)
        present, sizes, centred = 0, [], []
        for i in idxs:
            g = cv2.cvtColor(cv2.resize(frames[i][1], (FW, FH)), cv2.COLOR_BGR2GRAY)
            faces = clf.detectMultiScale(g, 1.1, 4, minSize=(24, 24))
            if len(faces):
                present += 1; x, y, w, h = max(faces, key=lambda b: b[2] * b[3])
                sizes.append((w * h) / float(FW * FH)); cx = (x + w / 2) / FW; cy = (y + h / 2) / FH
                centred.append(1.0 - (abs(cx - 0.5) + abs(cy - 0.5)))
        f['vi_face_frac'] = float(present / len(idxs)); f['vi_face_size'] = float(np.mean(sizes)) if sizes else 0.0
        f['vi_face_centered'] = float(np.mean(centred)) if centred else 0.0
    except Exception: pass
    try:
        import pytesseract
        txt = 0
        for i in range(min(2, len(frames))):
            s = pytesseract.image_to_string(cv2.cvtColor(cv2.resize(frames[i][1], (360, 640)), cv2.COLOR_BGR2GRAY), config='--psm 11').strip()
            if sum(c.isalnum() for c in s) >= 3: txt = 1; break
        f['vi_text_at0'] = float(txt)
    except Exception: pass
    return f


def whole_audio_features(wav):
    """Whole-video audio aggregates — identical to wholevideo_research.whole_audio."""
    y, sr = librosa.load(wav, sr=SR, mono=True)
    hop = 512; f = {}; dur = len(y) / sr
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    f['wv_loud_mean'] = float(np.mean(rms)); f['wv_loud_std'] = float(np.std(rms))
    f['wv_loud_dynrange'] = float(np.percentile(rms, 95) - np.percentile(rms, 5))
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    ot = librosa.onset.onset_detect(onset_envelope=onset, sr=sr, hop_length=hop, units='time')
    f['wv_onset_density'] = float(len(ot) / dur) if dur > 0 else 0.0; f['wv_onset_std'] = float(np.std(onset))
    cen = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]
    f['wv_centroid_mean'] = float(np.mean(cen)); f['wv_centroid_std'] = float(np.std(cen))
    try:
        tempo = librosa.beat.beat_track(y=y, sr=sr)[0]; f['wv_tempo'] = float(tempo if np.isscalar(tempo) else tempo[0])
    except Exception: f['wv_tempo'] = 0.0
    try:
        f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1200, sr=sr, hop_length=hop)
        f['wv_voiced_ratio'] = float(np.nanmean(voiced.astype(float))); f['wv_pitch_std'] = float(np.nanstd(np.nan_to_num(f0, nan=0.0)))
    except Exception: pass
    crossings = np.sum(np.abs(np.diff((rms > rms.mean()).astype(int))))
    f['wv_loud_changes_per_s'] = float(crossings / dur) if dur > 0 else 0.0
    f['duration_s'] = float(dur)
    return f


def whole_visual_features(frames):
    """Whole-video visual aggregates — identical to wholevideo_research.whole_visual."""
    if len(frames) < 3:
        return {}
    grays = [cv2.cvtColor(cv2.resize(im, (120, 213)), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0 for _, im in frames]
    bright = [float(g.mean()) for g in grays]
    sat = [float(cv2.cvtColor(cv2.resize(im, (120, 213)), cv2.COLOR_BGR2HSV)[:, :, 1].mean()) / 255.0 for _, im in frames]
    ts = [t for t, _ in frames]; span = max(ts[-1] - ts[0], 1e-6)
    motion = [float(np.abs(grays[i] - grays[i - 1]).mean()) for i in range(1, len(grays))]
    cuts = sum(1 for d in motion if d > CUT_THRESH)
    f = {'wv_cut_rate': float(cuts / span), 'wv_motion_mean': float(np.mean(motion)) if motion else 0.0,
         'wv_motion_std': float(np.std(motion)) if motion else 0.0, 'wv_bright_std': float(np.std(bright)),
         'wv_sat_mean': float(np.mean(sat)), 'wv_avg_shot_len': float(span / max(cuts, 1))}
    try:
        clf = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        idxs = np.linspace(0, len(frames) - 1, min(20, len(frames))).astype(int); present = 0
        for i in idxs:
            g = (grays[i] * 255).astype(np.uint8)
            if len(clf.detectMultiScale(g, 1.1, 4, minSize=(18, 18))): present += 1
        f['wv_face_frac'] = float(present / len(idxs))
    except Exception: pass
    return f


def predict_retention(feat):
    RM = MODEL.get('retention_model')
    if not RM:
        return None
    F = RM['features']; mu = RM['feature_means']; sd = RM['feature_stds']; med = RM['impute_median']
    x = [feat[k] if isinstance(feat.get(k), (int, float)) and np.isfinite(feat.get(k)) else med[k] for k in F]
    z = [(x[j] - mu[j]) / (sd[j] if sd[j] else 1) for j in range(len(F))]
    rc = RM['regression']; pred = rc['intercept'] + sum(z[j] * rc['coef'][j] for j in range(len(F)))
    return {'retention_est': float(pred), 'metrics': RM['metrics'],
            'mean': RM['metrics']['mean']}


def transcribe(wav):
    """Whisper → speaking rate, time-to-first-word, question-hook flag."""
    try:
        import whisper
        model = whisper.load_model('tiny')
        res = model.transcribe(wav, word_timestamps=True, fp16=False)
        words = [w for seg in res.get('segments', []) for w in seg.get('words', [])]
        words = [{'word': w['word'].strip(), 'timestamp': w['start']} for w in words if w.get('start', 99) <= T]
        f = {'v_word_count_10s': float(len(words)), 'v_speaking_rate': float(len(words) / T)}
        if words:
            f['v_time_first_word'] = float(words[0]['timestamp'])
        full = (res.get('text') or '')[:240].lower()
        f['v_hook_question'] = 1.0 if ('?' in full or full.strip().startswith(('what', 'how', 'why', 'who', 'when', 'did', 'do you', 'have you', 'ever'))) else 0.0
        return f, res.get('text', '')
    except Exception as e:
        return {}, None


def predict(feat):
    F = MODEL['features']; mu = MODEL['feature_means']; sd = MODEL['feature_stds']; med = MODEL['impute_median']
    imputed = []
    x = []
    for k in F:
        if isinstance(feat.get(k), (int, float)) and np.isfinite(feat.get(k)):
            x.append(feat[k])
        else:
            x.append(med[k]); imputed.append(k)
    z = [(x[j] - mu[j]) / (sd[j] if sd[j] else 1) for j in range(len(F))]
    # dud probability
    dc = MODEL['dud_logistic']; lin = dc['intercept'] + sum(z[j] * dc['coef'][j] for j in range(len(F)))
    proba = 1 / (1 + np.exp(-lin))
    # swipe % estimate (elasticnet on log1p → back-transform)
    rc = MODEL['swipe_regression']; reg = rc['intercept'] + sum(z[j] * rc['coef'][j] for j in range(len(F)))
    swipe_pct = float(np.expm1(reg))
    # per-feature contributions to dud (z * coef)
    contrib = sorted([{'key': F[j], 'label': MODEL['labels'].get(F[j], F[j]),
                       'contribution': float(z[j] * dc['coef'][j]), 'value': float(x[j])}
                      for j in range(len(F))], key=lambda d: abs(d['contribution']), reverse=True)
    swipe_est = max(0.0, min(100.0, swipe_pct))
    return {'dud_proba': float(proba), 'is_dud_pred': bool(proba >= 0.5),
            'swipe_pct_est': swipe_est, 'keep_rate_est': float(100.0 - swipe_est),
            'contributions': contrib[:12], 'imputed': imputed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', required=True)
    ap.add_argument('--type', choices=['video', 'audio'], required=True)
    args = ap.parse_args()
    feat = {}; degraded = []; transcript = None; tmp_wav = None; full_wav = None
    retention = None
    try:
        if args.type == 'video':
            all_frames = frames_from_video(args.file)            # ALL frames (1 fps) for whole-video
            hook_frames = [(t, im) for t, im in all_frames if t <= T]
            feat.update(visual_features(hook_frames))
            if not all_frames: degraded.append('visual (no frames decoded)')
            full_wav = video_to_wav_full(args.file)
            feat.update(audio_features(full_wav))                # first-10s hook audio (librosa duration cap)
            # whole-video features → retention (weak ranking model)
            wv = {}; wv.update(whole_audio_features(full_wav)); wv.update(whole_visual_features(all_frames))
            retention = predict_retention(wv)
            tmp_wav = full_wav
        else:
            degraded.append('visual (audio-only — retention needs video)')
            tmp_wav = args.file if args.file.lower().endswith('.wav') else video_to_wav_full(args.file)
            feat.update(audio_features(tmp_wav))
        vf, transcript = transcribe(tmp_wav)
        if vf: feat.update(vf)
        else: degraded.append('transcript (whisper unavailable → speaking-rate imputed)')
        feat['duration_s'] = feat.get('duration_s', float(librosa.get_duration(path=tmp_wav)))
    except Exception as e:
        import traceback; print(json.dumps({'error': str(e), 'tb': traceback.format_exc()[-600:]})); return
    finally:
        if tmp_wav and tmp_wav != args.file:
            try: os.unlink(tmp_wav)
            except Exception: pass
    result = predict(feat)
    result['retention'] = retention
    result['degraded'] = degraded
    result['transcript'] = (transcript or '')[:500]
    result['features'] = {k: feat.get(k) for k in MODEL['features']}
    result['model_metrics'] = MODEL['metrics']
    result['dud_threshold'] = MODEL['dud_threshold']
    print(json.dumps(result))


if __name__ == '__main__':
    main()
