#!/usr/bin/env python3
"""
QRD Feature Extraction — Stage 2 of the Quant Research Decoded pipeline.

Turns each reel's raw audio + visual streams (the first T=10s, where the hook
lives) into readable per-channel curves, then reduces every curve to the
simple-baseline summary (§6.3) plus an event-aligned level-2 path signature
(§6.2). Atomic, deterministic, one number per channel-statistic per reel.

  Audio  (librosa)      : loudness/RMS, spectral centroid, onset strength,
                          zero-crossing rate, pitch (pyin), MFCC, mel bands,
                          voiced-frame ratio.            → ~109 reels w/ audio
  Visual (opencv,
          mediapipe,
          tesseract)    : brightness, saturation, contrast, colour warmth,
                          motion energy, cut rate, faces (present/size/centred),
                          on-screen text at 0s.          → all 213 reels (frames)
  Voice  (transcript)   : speaking rate, time-to-first-word, word count,
                          question-hook flag.            → all 213 reels

Output: qrd_features.json  (list of per-reel records, keyed by ytId).
Resumable: re-running skips reels already present unless --force.

Usage:
  python3 extract_features.py [--limit N] [--only ID] [--force] [--no-audio]
"""
import os, sys, json, glob, subprocess, tempfile, warnings, argparse, time
warnings.filterwarnings('ignore')
os.environ.setdefault('GLOG_minloglevel', '3')
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')

import numpy as np
np.random.seed(7)

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(JARVIS))
VIDEO_DATA = os.path.join(ROOT, 'video_data')
EXPANDED = os.path.join(JARVIS, 'signals-dataset-expanded.json')
OUT = os.path.join(HERE, 'qrd_features.json')
T = 10.0           # seconds of hook to analyse
SR = 22050         # librosa standard
CUT_THRESH = 0.18  # normalised frame-diff above which we call a cut

# ── lazy heavy imports ──
_librosa = _cv2 = _mp_fd = _pyt = None
def librosa():
    global _librosa
    if _librosa is None:
        import librosa as L; _librosa = L
    return _librosa
def cv2():
    global _cv2
    if _cv2 is None:
        import cv2 as C; _cv2 = C
    return _cv2
def face_detector():
    # OpenCV Haar cascade — built in, no model download, robust enough for the
    # coarse face present / size / centred atoms (mediapipe 0.10.x dropped the
    # legacy mp.solutions API and its Tasks API needs an external .tflite).
    global _mp_fd
    if _mp_fd is None:
        C = cv2()
        _mp_fd = C.CascadeClassifier(C.data.haarcascades + 'haarcascade_frontalface_default.xml')
    return _mp_fd
def tess():
    global _pyt
    if _pyt is None:
        import pytesseract as P; _pyt = P
    return _pyt

from signatures import signature_features


# ════════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════════
def reduce_curve(curve, times, prefix, T=T):
    """Simple-baseline reduction of one channel (§6.3)."""
    curve = np.asarray(curve, dtype=np.float64)
    times = np.asarray(times, dtype=np.float64)
    m = np.isfinite(curve) & np.isfinite(times)
    curve, times = curve[m], times[m]
    out = {}
    if curve.size < 2:
        return {f'{prefix}_mean': float(curve.mean()) if curve.size else 0.0}
    out[f'{prefix}_mean'] = float(np.mean(curve))
    out[f'{prefix}_std'] = float(np.std(curve))
    # slope per second
    try:
        out[f'{prefix}_slope'] = float(np.polyfit(times, curve, 1)[0])
    except Exception:
        out[f'{prefix}_slope'] = 0.0
    # value at 3 s
    out[f'{prefix}_at3'] = float(np.interp(3.0, times, curve))
    # first-3s vs rest ratio (the "WAAASUP" swell)
    early = curve[times < 3.0]; rest = curve[times >= 3.0]
    if early.size and rest.size and abs(rest.mean()) > 1e-9:
        out[f'{prefix}_first3_ratio'] = float(early.mean() / rest.mean())
    else:
        out[f'{prefix}_first3_ratio'] = 1.0
    return out


def ensure_wav(d):
    """Return path to a <=10s mono 22050 wav for this reel, or None."""
    wav = os.path.join(d, 'video.wav')
    if os.path.exists(wav):
        return wav, False
    mp4 = os.path.join(d, 'video.mp4')
    if not os.path.exists(mp4):
        alt = glob.glob(os.path.join(d, '*.mp4'))
        mp4 = alt[0] if alt else None
    if mp4 and os.path.exists(mp4):
        tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
        try:
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-t', str(T),
                            '-i', mp4, '-ac', '1', '-ar', str(SR), tmp],
                           check=True, timeout=120)
            return tmp, True
        except Exception:
            return None, False
    return None, False


# ════════════════════════════════════════════════════════════════════
# audio
# ════════════════════════════════════════════════════════════════════
def extract_audio(d):
    L = librosa()
    wav, is_tmp = ensure_wav(d)
    if not wav:
        return {}, {}, None
    try:
        y, sr = L.load(wav, sr=SR, mono=True, duration=T)
    except Exception:
        if is_tmp:
            try: os.unlink(wav)
            except Exception: pass
        return {}, {}, None
    feats, channels = {}, {}
    hop = 512
    def times_for(c):
        return L.times_like(c, sr=sr, hop_length=hop)
    try:
        rms = L.feature.rms(y=y, hop_length=hop)[0]
        feats.update(reduce_curve(rms, times_for(rms), 'a_loud'))
        channels['loudness'] = rms
    except Exception: pass
    try:
        cen = L.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]
        feats.update(reduce_curve(cen, times_for(cen), 'a_centroid'))
        channels['centroid'] = cen
    except Exception: pass
    try:
        onset = L.onset.onset_strength(y=y, sr=sr, hop_length=hop)
        feats.update(reduce_curve(onset, times_for(onset), 'a_onset'))
        channels['onset'] = onset
        ot = L.onset.onset_detect(onset_envelope=onset, sr=sr, hop_length=hop, units='time')
        feats['a_first_onset'] = float(ot[0]) if len(ot) else 0.0
    except Exception: pass
    try:
        zcr = L.feature.zero_crossing_rate(y, hop_length=hop)[0]
        feats.update(reduce_curve(zcr, times_for(zcr), 'a_zcr'))
    except Exception: pass
    try:
        f0, voiced, vprob = L.pyin(y, fmin=65, fmax=1200, sr=sr, hop_length=hop)
        vr = float(np.nanmean(voiced.astype(float))) if voiced is not None else 0.0
        feats['a_voiced_ratio'] = vr
        f0f = np.nan_to_num(f0, nan=0.0)
        ft = times_for(f0f)
        red = reduce_curve(f0f, ft, 'a_pitch')
        feats.update(red)
        channels['pitch'] = f0f
    except Exception: pass
    try:
        mf = L.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)
        for i in range(4):
            feats[f'a_mfcc{i+1}_mean'] = float(np.mean(mf[i]))
        channels['mfcc1'] = mf[0]
    except Exception: pass
    try:
        mel = L.feature.melspectrogram(y=y, sr=sr, n_mels=64, hop_length=hop)
        low = mel[:21].mean(); high = mel[42:].mean()
        feats['a_mel_lowhigh'] = float(low / high) if high > 1e-9 else 0.0
    except Exception: pass
    feats['a_has_audio'] = 1.0
    align = {'first_onset': feats.get('a_first_onset', None)}
    if is_tmp:
        try: os.unlink(wav)
        except Exception: pass
    return feats, channels, align


# ════════════════════════════════════════════════════════════════════
# visual
# ════════════════════════════════════════════════════════════════════
def load_frames(d, analysis):
    """Return list of (timestamp, BGR-image) for frames within the first T s."""
    C = cv2()
    out = []
    fr = (analysis or {}).get('frames', [])
    fdir = os.path.join(d, 'frames')
    if fr:
        for f in fr:
            ts = f.get('timestamp', f.get('index', 0))
            if ts is None or ts > T:
                continue
            fn = f.get('filename')
            p = os.path.join(fdir, fn) if fn else None
            if not p or not os.path.exists(p):
                p2 = os.path.join(d, fn) if fn else None
                p = p2 if (p2 and os.path.exists(p2)) else None
            if p:
                img = C.imread(p)
                if img is not None:
                    out.append((float(ts), img))
    if not out:  # fall back to raw frame files in order
        files = sorted(glob.glob(os.path.join(fdir, '*.jpg')) + glob.glob(os.path.join(fdir, '*.png')))
        for i, p in enumerate(files):
            ts = i * (T / max(len(files), 1))
            if ts > T: break
            img = C.imread(p)
            if img is not None:
                out.append((float(ts), img))
    out.sort(key=lambda x: x[0])
    return out


def extract_visual(d, analysis):
    C = cv2()
    frames = load_frames(d, analysis)
    if not frames:
        return {}, {}, None
    feats, channels = {}, {}
    times = [t for t, _ in frames]
    bright, sat, contrast, warmth = [], [], [], []
    grays = []
    for t, img in frames:
        small = C.resize(img, (160, 284))  # vertical-ish, fast
        hsv = C.cvtColor(small, C.COLOR_BGR2HSV)
        gray = C.cvtColor(small, C.COLOR_BGR2GRAY)
        grays.append(gray.astype(np.float32) / 255.0)
        bright.append(float(gray.mean()) / 255.0)
        sat.append(float(hsv[:, :, 1].mean()) / 255.0)
        contrast.append(float(gray.std()) / 255.0)
        b, g, r = small[:, :, 0].mean(), small[:, :, 1].mean(), small[:, :, 2].mean()
        warmth.append(float(r - b) / 255.0)  # warm (red) vs cool (blue)
    feats.update(reduce_curve(bright, times, 'vi_bright'))
    feats.update(reduce_curve(sat, times, 'vi_sat'))
    feats.update(reduce_curve(contrast, times, 'vi_contrast'))
    feats.update(reduce_curve(warmth, times, 'vi_warmth'))
    channels['brightness'] = np.array(bright)
    channels['saturation'] = np.array(sat)

    # motion energy + cut rate from consecutive gray frames
    motion, cuts, first_cut = [], 0, None
    for i in range(1, len(grays)):
        diff = float(np.abs(grays[i] - grays[i - 1]).mean())
        motion.append(diff)
        if diff > CUT_THRESH:
            cuts += 1
            if first_cut is None:
                first_cut = times[i]
    if motion:
        mtimes = times[1:]
        feats.update(reduce_curve(motion, mtimes, 'vi_motion'))
        feats['vi_motion_max'] = float(np.max(motion))
        channels['motion'] = np.array(motion)
    span = max(times[-1] - times[0], 1e-6)
    feats['vi_cut_rate'] = float(cuts / span)
    feats['vi_first_cut'] = float(first_cut) if first_cut is not None else 0.0

    # faces (OpenCV Haar) — sample up to 12 frames for speed
    try:
        clf = face_detector()
        FW, FH = 240, 426
        idxs = np.linspace(0, len(frames) - 1, min(12, len(frames))).astype(int)
        present, sizes, centred = 0, [], []
        for i in idxs:
            _, img = frames[i]
            g = C.cvtColor(C.resize(img, (FW, FH)), C.COLOR_BGR2GRAY)
            faces = clf.detectMultiScale(g, 1.1, 4, minSize=(24, 24))
            if len(faces):
                present += 1
                x, y, w, h = max(faces, key=lambda b: b[2] * b[3])
                sizes.append((w * h) / float(FW * FH))
                cx = (x + w / 2) / FW; cy = (y + h / 2) / FH
                centred.append(1.0 - (abs(cx - 0.5) + abs(cy - 0.5)))
        feats['vi_face_frac'] = float(present / len(idxs))
        feats['vi_face_size'] = float(np.mean(sizes)) if sizes else 0.0
        feats['vi_face_centered'] = float(np.mean(centred)) if centred else 0.0
    except Exception:
        pass

    # on-screen text at the start (OCR first ≤2 frames)
    try:
        P = tess()
        txt_present = 0
        for i in range(min(2, len(frames))):
            _, img = frames[i]
            up = C.resize(img, (360, 640))
            g = C.cvtColor(up, C.COLOR_BGR2GRAY)
            s = P.image_to_string(g, config='--psm 11').strip()
            letters = sum(c.isalnum() for c in s)
            if letters >= 3:
                txt_present = 1; break
        feats['vi_text_at0'] = float(txt_present)
    except Exception:
        pass

    align = {'first_cut': feats.get('vi_first_cut', None)}
    return feats, channels, align


# ════════════════════════════════════════════════════════════════════
# voice / transcript
# ════════════════════════════════════════════════════════════════════
def extract_voice(analysis):
    feats = {}
    tr = (analysis or {}).get('transcript', {}) or {}
    words = tr.get('words', []) or []
    in10 = [w for w in words if isinstance(w.get('timestamp'), (int, float)) and w['timestamp'] <= T]
    feats['v_word_count_10s'] = float(len(in10))
    feats['v_speaking_rate'] = float(len(in10) / T)
    if words and isinstance(words[0].get('timestamp'), (int, float)):
        feats['v_time_first_word'] = float(words[0]['timestamp'])
    full = (tr.get('fullText') or '')[:240].lower()
    feats['v_hook_question'] = 1.0 if ('?' in full or full.strip().startswith(('what', 'how', 'why', 'who', 'when', 'did', 'do you', 'have you', 'ever'))) else 0.0
    return feats, words[0].get('timestamp') if (words and isinstance(words[0].get('timestamp'), (int, float))) else None


# ════════════════════════════════════════════════════════════════════
# per-reel driver
# ════════════════════════════════════════════════════════════════════
def extract_reel(yid, do_audio=True):
    d = os.path.join(VIDEO_DATA, yid)
    if not os.path.isdir(d):
        return None
    analysis = None
    ap = os.path.join(d, 'analysis.json')
    if os.path.exists(ap):
        try: analysis = json.load(open(ap))
        except Exception: analysis = None
    rec = {'ytId': yid}
    chans = {}
    a_align = v_align = vi_align = None
    if do_audio:
        af, ac, a_align = extract_audio(d)
        rec.update(af); chans.update({f'a_{k}': v for k, v in ac.items()})
    vf, vc, vi_align = extract_visual(d, analysis)
    rec.update(vf); chans.update({f'v_{k}': v for k, v in vc.items()})
    vof, first_word = extract_voice(analysis)
    rec.update(vof)

    # event alignment (§6.1): t0 = earliest of first word / onset / cut
    cands = [x for x in [first_word,
                         (a_align or {}).get('first_onset'),
                         (vi_align or {}).get('first_cut')] if isinstance(x, (int, float)) and x > 0]
    rec['align_t0'] = float(min(cands)) if cands else 0.0
    rec['align_first_word'] = float(first_word) if isinstance(first_word, (int, float)) else None

    # path signature (§6.2) over aligned channels
    try:
        if len(chans) >= 2:
            names, sig = signature_features(chans, with_time=True, normalize=True)
            # keep only the cross-channel level-2 interaction terms (the useful ones)
            keep = {n: float(v) for n, v in zip(names, sig)
                    if n.startswith('sig2_') and not n.endswith('_t') and 'sig2_t_' not in n}
            rec['signature'] = keep
            rec['n_channels'] = len(chans)
    except Exception:
        pass
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--only', type=str, default=None)
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--no-audio', action='store_true')
    args = ap.parse_args()

    rows = json.load(open(EXPANDED))
    ids = [r['ytId'] for r in rows if r.get('ytId')]
    if args.only:
        ids = [args.only]
    if args.limit:
        ids = ids[:args.limit]

    existing = {}
    if os.path.exists(OUT) and not args.force:
        try:
            existing = {r['ytId']: r for r in json.load(open(OUT))}
        except Exception:
            existing = {}

    out = dict(existing)
    t0 = time.time()
    done = 0
    for i, yid in enumerate(ids):
        if yid in out and not args.force and args.only is None:
            continue
        try:
            rec = extract_reel(yid, do_audio=not args.no_audio)
        except Exception as e:
            print(f'  [{i+1}/{len(ids)}] {yid} ERROR {e}', flush=True)
            continue
        if rec:
            out[yid] = rec
            done += 1
            na = 'A' if rec.get('a_has_audio') else '-'
            nf = rec.get('n_channels', 0)
            print(f'  [{i+1}/{len(ids)}] {yid}  audio:{na} chans:{nf} feats:{len(rec)}  ({time.time()-t0:.0f}s)', flush=True)
            if done % 10 == 0:
                json.dump(list(out.values()), open(OUT, 'w'))
    json.dump(list(out.values()), open(OUT, 'w'))
    nau = sum(1 for r in out.values() if r.get('a_has_audio'))
    print(f'\nDONE. {len(out)} reels in qrd_features.json ({nau} with audio). {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
