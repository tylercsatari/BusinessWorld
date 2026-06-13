#!/usr/bin/env python3
"""
RESEARCH PASS — does whole-video content predict retention out-of-fold?

The hook-only features (first 10s) predict swipe-away (a hook outcome) but NOT
whole-video retention (people watching to the end). Hypothesis: retention is
driven by sustained pacing / dynamics / variety across the WHOLE video, which
hook-only features miss. This script extracts whole-video aggregate features and
tests retention predictability with airtight time-split CV — honest go/no-go
BEFORE anything is promised or built.
"""
import os, json, glob, warnings, subprocess, tempfile
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
import librosa, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(JARVIS))
VIDEO_DATA = os.path.join(ROOT, 'video_data')
SR = 22050
CACHE = os.path.join(HERE, 'wholevideo_features.json')


def ensure_wav_full(d):
    wav = os.path.join(d, 'video.wav')
    if os.path.exists(wav):
        return wav, False
    mp4 = os.path.join(d, 'video.mp4')
    if os.path.exists(mp4):
        tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
        try:
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', mp4, '-ac', '1', '-ar', str(SR), tmp],
                           check=True, timeout=180)
            return tmp, True
        except Exception:
            return None, False
    return None, False


def whole_audio(d):
    wav, tmp = ensure_wav_full(d)
    if not wav:
        return {}
    try:
        y, sr = librosa.load(wav, sr=SR, mono=True)   # FULL video
    except Exception:
        if tmp:
            try: os.unlink(wav)
            except Exception: pass
        return {}
    f = {}
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    f['wv_loud_mean'] = float(np.mean(rms)); f['wv_loud_std'] = float(np.std(rms))
    f['wv_loud_dynrange'] = float(np.percentile(rms, 95) - np.percentile(rms, 5))
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    dur = len(y) / sr
    ot = librosa.onset.onset_detect(onset_envelope=onset, sr=sr, hop_length=hop, units='time')
    f['wv_onset_density'] = float(len(ot) / dur) if dur > 0 else 0.0
    f['wv_onset_std'] = float(np.std(onset))
    cen = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]
    f['wv_centroid_mean'] = float(np.mean(cen)); f['wv_centroid_std'] = float(np.std(cen))
    try:
        tempo = librosa.beat.beat_track(y=y, sr=sr)[0]
        f['wv_tempo'] = float(tempo if np.isscalar(tempo) else tempo[0])
    except Exception:
        f['wv_tempo'] = 0.0
    try:
        f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1200, sr=sr, hop_length=hop)
        f['wv_voiced_ratio'] = float(np.nanmean(voiced.astype(float)))
        f['wv_pitch_std'] = float(np.nanstd(np.nan_to_num(f0, nan=0.0)))
    except Exception:
        pass
    # loudness "events" — how often it crosses its mean (energy variety)
    crossings = np.sum(np.abs(np.diff((rms > rms.mean()).astype(int))))
    f['wv_loud_changes_per_s'] = float(crossings / dur) if dur > 0 else 0.0
    if tmp:
        try: os.unlink(wav)
        except Exception: pass
    return f


def whole_visual(d, analysis):
    fr = (analysis or {}).get('frames', [])
    fdir = os.path.join(d, 'frames')
    imgs = []
    for fo in fr:
        fn = fo.get('filename'); ts = fo.get('timestamp', 0)
        p = os.path.join(fdir, fn) if fn else None
        if p and os.path.exists(p):
            img = cv2.imread(p)
            if img is not None:
                imgs.append((ts, cv2.resize(img, (120, 213))))
    if len(imgs) < 3:
        files = sorted(glob.glob(os.path.join(fdir, '*.jpg')))
        imgs = [(i, cv2.resize(cv2.imread(p), (120, 213))) for i, p in enumerate(files) if cv2.imread(p) is not None]
    if len(imgs) < 3:
        return {}
    imgs.sort(key=lambda x: x[0])
    grays = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0 for _, im in imgs]
    bright = [float(g.mean()) for g in grays]
    sat = [float(cv2.cvtColor(im, cv2.COLOR_BGR2HSV)[:, :, 1].mean()) / 255.0 for _, im in imgs]
    ts = [t for t, _ in imgs]
    span = max(ts[-1] - ts[0], 1e-6)
    motion = [float(np.abs(grays[i] - grays[i - 1]).mean()) for i in range(1, len(grays))]
    cuts = sum(1 for mdv in motion if mdv > 0.18)
    f = {
        'wv_cut_rate': float(cuts / span),
        'wv_motion_mean': float(np.mean(motion)) if motion else 0.0,
        'wv_motion_std': float(np.std(motion)) if motion else 0.0,
        'wv_bright_std': float(np.std(bright)),     # visual variety over the video
        'wv_sat_mean': float(np.mean(sat)),
        'wv_avg_shot_len': float(span / max(cuts, 1)),
        'wv_n_frames': len(imgs),
    }
    # face presence over the whole video
    try:
        clf = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        idxs = np.linspace(0, len(imgs) - 1, min(20, len(imgs))).astype(int)
        present = 0
        for i in idxs:
            g = (grays[i] * 255).astype(np.uint8)
            if len(clf.detectMultiScale(g, 1.1, 4, minSize=(18, 18))):
                present += 1
        f['wv_face_frac'] = float(present / len(idxs))
    except Exception:
        pass
    return f


def extract_all():
    if os.path.exists(CACHE):
        return {r['ytId']: r for r in json.load(open(CACHE))}
    exp = json.load(open(os.path.join(JARVIS, 'signals-dataset-expanded.json')))
    ids = [r['ytId'] for r in exp if r.get('ytId')]
    out = {}
    import time
    t0 = time.time()
    for i, yid in enumerate(ids):
        d = os.path.join(VIDEO_DATA, yid)
        if not os.path.isdir(d):
            continue
        analysis = None
        ap = os.path.join(d, 'analysis.json')
        if os.path.exists(ap):
            try: analysis = json.load(open(ap))
            except Exception: pass
        rec = {'ytId': yid}
        try:
            rec.update(whole_visual(d, analysis))
            rec.update(whole_audio(d))
        except Exception as e:
            print(f'  {yid} ERR {e}')
        out[yid] = rec
        if (i + 1) % 20 == 0:
            print(f'  {i+1}/{len(ids)}  ({time.time()-t0:.0f}s)', flush=True)
            json.dump(list(out.values()), open(CACHE, 'w'))
    json.dump(list(out.values()), open(CACHE, 'w'))
    print(f'extracted {len(out)} reels in {time.time()-t0:.0f}s')
    return out


def evaluate(wv):
    from sklearn.preprocessing import StandardScaler
    from sklearn.linear_model import ElasticNet
    from sklearn.ensemble import GradientBoostingRegressor
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.metrics import r2_score
    from scipy.stats import spearmanr
    exp = json.load(open(os.path.join(JARVIS, 'signals-dataset-expanded.json')))
    vis = json.load(open(os.path.join(JARVIS, 'vision-scores-cache.json')))
    hook = {r['ytId']: r for r in json.load(open(os.path.join(HERE, 'qrd_features.json')))}
    LLM = ['z_score', 'vz_score', 'novelty', 'cognitive_load', 'net_novelty', 'action', 'scale', 'contrast', 'expression', 'v_novelty']
    WV = sorted({k for r in wv.values() for k in r if k.startswith('wv_')})
    rows = []
    for r in exp:
        y = r.get('ytId')
        if not y or y not in wv:
            continue
        rec = dict(r); v = vis.get(y)
        if v: rec.update({'action': v['action'], 'scale': v['scale'], 'contrast': v['contrast'], 'expression': v['expression'], 'v_novelty': v['novelty']})
        rec.update({k: wv[y][k] for k in WV if k in wv[y]})
        rows.append(rec)
    pools = {
        'hook-only (10s)': LLM + ['duration_s'],   # baseline ≈ what we had
        'whole-video only': WV + ['duration_s'],
        'whole-video + concept': LLM + WV + ['duration_s'],
    }
    print(f'\nreels usable: {len(rows)}   whole-video features: {len(WV)}')
    print(f'{"feature pool":26s} {"OOF R²":>8s} {"Spear":>7s} {"in-samp":>8s} {"gap":>6s}')
    for name, cols in pools.items():
        cc = [c for c in cols if sum(isinstance(r.get(c), (int, float)) and np.isfinite(r.get(c)) for r in rows) >= 0.5 * len(rows)]
        for k in cc:
            vals = [r[k] for r in rows if isinstance(r.get(k), (int, float)) and np.isfinite(r.get(k))]
            m = float(np.median(vals)) if vals else 0.0
            for r in rows:
                if not isinstance(r.get(k), (int, float)) or not np.isfinite(r.get(k)): r[k] = m
        X = np.array([[r[k] for k in cc] for r in rows]); y = np.array([r['retention'] for r in rows])
        tss = TimeSeriesSplit(n_splits=5); pred = np.full(len(y), np.nan)
        for tr, te in tss.split(X):
            sc = StandardScaler().fit(X[tr])
            pred[te] = ElasticNet(alpha=0.1, l1_ratio=0.5, max_iter=5000).fit(sc.transform(X[tr]), y[tr]).predict(sc.transform(X[te]))
        mk = ~np.isnan(pred)
        scf = StandardScaler().fit(X); ins = ElasticNet(alpha=0.1, l1_ratio=0.5, max_iter=5000).fit(scf.transform(X), y).score(scf.transform(X), y)
        oof = r2_score(y[mk], pred[mk]); sp = spearmanr(y[mk], pred[mk]).correlation
        print(f'{name:26s} {oof:>+8.3f} {sp:>+7.3f} {ins:>+8.3f} {ins-oof:>+6.3f}')
    # also test GBM on the best pool
    cols = [c for c in LLM + WV + ['duration_s'] if sum(isinstance(r.get(c), (int, float)) and np.isfinite(r.get(c)) for r in rows) >= 0.5 * len(rows)]
    X = np.array([[r[k] for k in cols] for r in rows]); y = np.array([r['retention'] for r in rows])
    tss = TimeSeriesSplit(n_splits=5); pred = np.full(len(y), np.nan)
    for tr, te in tss.split(X):
        sc = StandardScaler().fit(X[tr])
        pred[te] = GradientBoostingRegressor(n_estimators=120, max_depth=2, subsample=0.7, random_state=7).fit(sc.transform(X[tr]), y[tr]).predict(sc.transform(X[te]))
    mk = ~np.isnan(pred)
    print(f'{"whole+concept (GBM)":26s} {r2_score(y[mk],pred[mk]):>+8.3f} {spearmanr(y[mk],pred[mk]).correlation:>+7.3f}')


if __name__ == '__main__':
    wv = extract_all()
    evaluate(wv)
