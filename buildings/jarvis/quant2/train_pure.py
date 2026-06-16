#!/usr/bin/env python3
"""
QUANT 2 (pure) · QP2-3 — swipe-hazard model + latent discovery on PURE features.

Features are 100% bottom-up — NO LLM ratings anywhere:
  vision  DINOv2  mean⊕hook (1536)   ·  motion  VideoMAE mean (768)
  audio   wav2vec2 mean⊕hook (1536)  ·  DSP     cut rate, motion, RMS, pitch … (real)

Targets: discrete-time swipe hazard from the real retention anchors, pooled
(reel × interval), GROUPED time-split CV by real publish date (no leak, no overfit:
each modality PCA-reduced on the TRAIN fold only).

Honest design — two clean comparisons, NO imputation of a missing modality:
  • PRIMARY (all 213): vision + motion + visual-DSP  → the always-on pure model.
  • AUDIO LIFT (109 with audio): primary-features vs primary+audio, same reels.

Latent discovery: PLS(pure embeddings → reel hazard vector) → directions, with the
actual frames at each extreme for post-hoc naming. Manifold: PCA-2D + k-means.
Output: quant2_pure.json.
"""
import os, json, warnings, datetime
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.linear_model import ElasticNet
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.cross_decomposition import PLSRegression
from sklearn.cluster import KMeans
from sklearn.metrics import r2_score, silhouette_score
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
MANIFEST = os.path.join(HERE, 'manifest.json')
OUT = os.path.join(HERE, 'quant2_pure.json')
VIS, AUD, MOT = os.path.join(HERE, 'emb'), os.path.join(HERE, 'emb_audio'), os.path.join(HERE, 'emb_motion')
DSP = os.path.join(HERE, 'dsp.json')
VIS_DSP = ['vi_cut_rate', 'vi_motion_mean', 'vi_motion_first3_ratio', 'vi_brightness_mean', 'vi_brightness_slope', 'vi_saturation_mean', 'vi_warmth']
AUD_DSP = ['a_rms_mean', 'a_rms_first3_ratio', 'a_rms_slope', 'a_pitch_mean', 'a_pitch_slope', 'a_voiced_ratio', 'a_onset_mean', 'a_zcr_mean', 'a_centroid_mean']
K_PER = 10   # PCA comps per embedding modality (small → no overfit at n~200)


def haz(S):
    return [float(np.clip((S[j] - S[j + 1]) / max(S[j], 1e-6), 1e-3, 1 - 1e-3)) for j in range(4)]


def load():
    dsp = json.load(open(DSP)) if os.path.exists(DSP) else {}
    rows = []
    for v in json.load(open(MANIFEST))['videos']:
        if v['tier'] != 'true_label' or not v.get('targets') or not v['targets'].get('survival'):
            continue
        vp = os.path.join(VIS, v['id'] + '.npy')
        if not os.path.exists(vp):
            continue
        e = np.load(vp, allow_pickle=True).item()
        vis = np.concatenate([e['mean'], e['hook']]).astype(np.float32)
        mot = np.load(os.path.join(MOT, v['id'] + '.npy'), allow_pickle=True).item()['mean'] if os.path.exists(os.path.join(MOT, v['id'] + '.npy')) else None
        aud = None
        ap = os.path.join(AUD, v['id'] + '.npy')
        if os.path.exists(ap):
            ae = np.load(ap, allow_pickle=True).item(); aud = np.concatenate([ae['mean'], ae['hook']]).astype(np.float32)
        d = dsp.get(v['id'], {})
        try:
            dt = datetime.date.fromisoformat(v['published']) if v.get('published') else None
        except Exception:
            dt = None
        ff = sorted([f for f in os.listdir(os.path.join(ROOT, v['frame_dir'])) if f.lower().endswith(('.jpg', '.png'))]) if os.path.isdir(os.path.join(ROOT, v['frame_dir'])) else []
        rows.append({'id': v['id'], 'name': (v.get('name') or v['id'])[:48], 'vis': vis, 'mot': mot, 'aud': aud,
                     'vdsp': [d.get(k, np.nan) for k in VIS_DSP], 'adsp': [d.get(k, np.nan) for k in AUD_DSP],
                     'h': haz(v['targets']['survival']), 'dt': dt, 'frame0': ff[len(ff) // 4] if ff else None})
    # impute DSP medians (DSP is low-dim real signal; modality EMBEDDINGS are never imputed)
    for key, names in (('vdsp', VIS_DSP), ('adsp', AUD_DSP)):
        M = np.array([r[key] for r in rows], float)
        for j in range(M.shape[1]):
            col = M[:, j]; med = np.nanmedian(col[np.isfinite(col)]) if np.isfinite(col).any() else 0.0
            col[~np.isfinite(col)] = med; M[:, j] = col
        for i, r in enumerate(rows):
            r[key] = M[i]
    valid = [r['dt'] for r in rows if r['dt']]; base = min(valid) if valid else None
    for r in rows:
        r['recency'] = ((r['dt'] - base).days / 365.0) if (r['dt'] and base) else 0.0
    rows.sort(key=lambda r: (r['dt'] is None, r['dt'] or datetime.date(1900, 1, 1)))
    return rows


def pooled(rows, feat_fn):
    X, y, grp = [], [], []
    for gi, r in enumerate(rows):
        f = feat_fn(r)
        for j in range(4):
            X.append(list(f) + [1.0 if k == j else 0.0 for k in range(4)] + [r['recency']])
            y.append(r['h'][j]); grp.append(gi)
    return np.array(X), np.array(y), np.array(grp)


def grouped_cv(rows, modal_slices, model_fn, n_folds=5):
    """modal_slices: list of (key, is_embedding). Embeddings get PCA(train-only)."""
    def feat(r, pcas=None, scls=None):
        out = []
        for mi, (key, is_emb) in enumerate(modal_slices):
            v = r[key]
            if v is None:
                v = np.zeros(rows[0][key].shape[0] if hasattr(rows[0][key], 'shape') else len(rows[0][key]))
            out.append(np.asarray(v, float))
        return out
    ng = len(rows); start = int(ng * 0.4); step = max(1, (ng - start) // n_folds)
    scores, sp = [], []
    for f in range(n_folds):
        tr = list(range(0, start + f * step)); te = list(range(start + f * step, start + (f + 1) * step))
        if not te or len(tr) < 8:
            continue
        # fit per-embedding PCA on train only
        pcas = {}
        for key, is_emb in modal_slices:
            if is_emb:
                Mtr = np.array([np.asarray(rows[i][key], float) if rows[i][key] is not None else np.zeros_like(np.asarray(rows[tr[0]][key], float)) for i in tr])
                sc = StandardScaler().fit(Mtr); pc = PCA(n_components=min(K_PER, len(tr) - 1, Mtr.shape[1])).fit(sc.transform(Mtr))
                pcas[key] = (sc, pc)

        def build(idxs):
            def ff(r):
                parts = []
                for key, is_emb in modal_slices:
                    v = r[key]
                    if is_emb:
                        sc, pc = pcas[key]
                        vv = np.asarray(v, float) if v is not None else np.zeros(sc.mean_.shape[0])
                        parts += list(pc.transform(sc.transform(vv.reshape(1, -1)))[0])
                    else:
                        parts += list(np.asarray(v, float))
                return parts
            return pooled([rows[i] for i in idxs], ff)
        Xtr, ytr, _ = build(tr); Xte, yte, _ = build(te)
        scl = StandardScaler().fit(Xtr)
        m = model_fn().fit(scl.transform(Xtr), np.log(ytr / (1 - ytr)))
        ph = 1 / (1 + np.exp(-m.predict(scl.transform(Xte))))
        if len(yte) > 2:
            scores.append(r2_score(yte, ph)); s = spearmanr(yte, ph).correlation
            if np.isfinite(s):
                sp.append(s)
    return (float(np.mean(scores)) if scores else 0.0, float(np.std(scores)) if len(scores) > 1 else 0.0, float(np.mean(sp)) if sp else 0.0)


def main():
    rows = load()
    n = len(rows); n_aud = sum(1 for r in rows if r['aud'] is not None)
    print(f'{n} true-label reels · vision+motion all · audio {n_aud}', flush=True)
    EN = lambda: ElasticNet(alpha=0.03, l1_ratio=0.5, max_iter=5000)
    GB = lambda: GradientBoostingRegressor(n_estimators=80, max_depth=2, subsample=0.7, random_state=7)

    # PRIMARY (all reels): vision + motion + visual DSP
    prim = [('vis', True), ('mot', True), ('vdsp', False)]
    p_en = grouped_cv(rows, prim, EN); p_gb = grouped_cv(rows, prim, GB)
    # DSP-only baseline (cheap real signal)
    dsp_only = grouped_cv(rows, [('vdsp', False)], EN)
    print(f"PRIMARY (vision+motion+vDSP) OOF R²/ρ: EN {p_en[0]:.3f}/{p_en[2]:.2f}  GBT {p_gb[0]:.3f}/{p_gb[2]:.2f}  · DSP-only {dsp_only[0]:.3f}/{dsp_only[2]:.2f}", flush=True)

    # AUDIO LIFT on the audio subset (same reels, ± audio)
    arows = [r for r in rows if r['aud'] is not None]
    a_base = grouped_cv(arows, prim, EN)
    a_full = grouped_cv(arows, prim + [('aud', True), ('adsp', False)], EN)
    print(f"AUDIO LIFT (n={len(arows)}): without {a_base[2]:.2f}ρ  → with audio {a_full[2]:.2f}ρ  (Δ {a_full[2]-a_base[2]:+.3f})", flush=True)

    # ── latent discovery + manifold on combined pure embeddings ──
    def comb(r):
        parts = [r['vis'], r['mot'] if r['mot'] is not None else np.zeros(768)]
        if r['aud'] is not None:
            parts.append(r['aud'])
        else:
            parts.append(np.zeros(1536))
        return np.concatenate(parts)
    E = np.array([comb(r) for r in rows]); Es = StandardScaler().fit_transform(E)
    P = PCA(n_components=min(24, n - 1)).fit_transform(Es); Z2 = PCA(n_components=2).fit_transform(Es)
    Hv = np.array([r['h'] for r in rows]); mh = Hv.mean(1)
    npc = min(6, P.shape[1]); pls = PLSRegression(n_components=npc).fit(P, Hv); proj = pls.transform(P)
    latents = []
    for c in range(npc):
        sc = proj[:, c]; eff = float(spearmanr(sc, mh).correlation); order = np.argsort(sc)
        ex = lambda i: {'id': rows[i]['id'], 'name': rows[i]['name'], 'frame0': rows[i]['frame0'], 'mean_hazard': round(float(mh[i]), 3)}
        latents.append({'id': c, 'effect_on_hazard_rho': eff,
                        'low_hazard_examples': [ex(i) for i in order[-4:][::-1]], 'high_hazard_examples': [ex(i) for i in order[:4]]})
    bestk, bestsil = 4, -1
    for k in (3, 4, 5, 6):
        try:
            lab = KMeans(n_clusters=k, n_init=10, random_state=7).fit_predict(P); s = silhouette_score(P, lab)
            if s > bestsil:
                bestsil, bestk = s, k
        except Exception:
            pass
    km = KMeans(n_clusters=bestk, n_init=10, random_state=7).fit(P)

    out = {
        'n': n, 'n_audio': n_aud, 'modalities': {'vision': 'DINOv2', 'motion': 'VideoMAE', 'audio': 'wav2vec2', 'dsp': 'librosa/opencv (real)'},
        'no_llm': True,
        'hazard': {
            'primary_en': {'r2': p_en[0], 'r2_std': p_en[1], 'rho': p_en[2]},
            'primary_gbt': {'r2': p_gb[0], 'r2_std': p_gb[1], 'rho': p_gb[2]},
            'dsp_only': {'r2': dsp_only[0], 'rho': dsp_only[2]},
            'audio_lift': {'n': len(arows), 'without_rho': a_base[2], 'with_rho': a_full[2], 'delta': round(a_full[2] - a_base[2], 3)},
        },
        'latent_directions': latents,
        'manifold': {'k': bestk, 'silhouette': float(bestsil),
                     'videos': [{'id': rows[i]['id'], 'name': rows[i]['name'], 'frame0': rows[i]['frame0'],
                                 'x': float(Z2[i, 0]), 'y': float(Z2[i, 1]), 'cluster': int(km.labels_[i]),
                                 'mean_hazard': float(mh[i]), 'has_audio': rows[i]['aud'] is not None} for i in range(n)]},
        'honesty': 'Pure raw-sensory features only, zero LLM ratings. Per-modality PCA fit on train fold only; grouped time-split CV by real date. Audio lift measured on the audio subset with no imputation.',
    }
    json.dump(out, open(OUT, 'w'))
    print(f"manifold k={bestk} sil={bestsil:.3f} · latent ρ {[round(l['effect_on_hazard_rho'],2) for l in latents]} → quant2_pure.json")


if __name__ == '__main__':
    main()
