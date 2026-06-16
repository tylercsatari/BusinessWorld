#!/usr/bin/env python3
"""
QUANT 2 (pure) · QP4 — mechanism detectors + deployable scorer.

Two products, both grounded in MEASURED quantities (no LLM):

1. DSP LEVER TABLE — for each real measured signal (cut rate, motion, loudness ramp,
   pitch lift, …), its rank-correlation with the swipe hazard and the value that the
   LOW-HAZARD reels (the ones that keep viewers) actually have. This is the honest,
   data-backed "what to change" — e.g. "your loudness ramp is below the keepers'."

2. DEPLOYABLE SCORER — a full-data fitted pipeline (per-modality PCA + ElasticNet on
   the pooled discrete-time hazard) saved to quant2_scorer.pkl, plus the gold
   embeddings for nearest-neighbour retrieval. predict_pure.py loads these to score a
   new hook. NO LLM, NO retraining at predict time.

Output: quant2_detectors.json + quant2_scorer.pkl + quant2_gold.npz
"""
import os, json, pickle, warnings
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.linear_model import ElasticNet
from scipy.stats import spearmanr

import importlib.util
_spec = importlib.util.spec_from_file_location('tp', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'train_pure.py'))
tp = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(tp)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'quant2_detectors.json')
PKL = os.path.join(HERE, 'quant2_scorer.pkl')
GOLD = os.path.join(HERE, 'quant2_gold.npz')

LEVER_LABEL = {
    'vi_cut_rate': 'Cut rate (pacing)', 'vi_motion_mean': 'Motion energy', 'vi_motion_first3_ratio': 'Hook motion (first-3s)',
    'vi_brightness_mean': 'Brightness', 'vi_brightness_slope': 'Brightness ramp', 'vi_saturation_mean': 'Saturation', 'vi_warmth': 'Warm tone',
    'a_rms_mean': 'Loudness', 'a_rms_first3_ratio': 'Loud open (first-3s)', 'a_rms_slope': 'Loudness ramp',
    'a_pitch_mean': 'Pitch', 'a_pitch_slope': 'Pitch lift', 'a_voiced_ratio': 'Speech presence',
    'a_onset_mean': 'Onset punch', 'a_zcr_mean': 'Zero-crossing (noisiness)', 'a_centroid_mean': 'Audio brightness',
}


def main():
    rows = tp.load()
    n = len(rows)
    mh = np.array([np.mean(r['h']) for r in rows])                 # per-reel mean hazard
    lo_mask = mh <= np.percentile(mh, 33)                          # low-hazard reels = keep viewers

    # ── DSP lever table ──
    levers = []
    for key in tp.VIS_DSP + tp.AUD_DSP:
        vals = np.array([r['vdsp'][tp.VIS_DSP.index(key)] if key in tp.VIS_DSP else r['adsp'][tp.AUD_DSP.index(key)] for r in rows], float)
        if not np.isfinite(vals).any():
            continue
        rho = float(spearmanr(vals, mh).correlation)
        levers.append({
            'key': key, 'label': LEVER_LABEL.get(key, key),
            'rho_with_hazard': rho,                                # <0 = raising it LOWERS hazard (good)
            'median_all': float(np.nanmedian(vals)),
            'median_keepers': float(np.nanmedian(vals[lo_mask])),  # what low-hazard reels have
            'direction': 'raise' if rho < 0 else 'lower',          # to reduce swipe
        })
    levers.sort(key=lambda d: -abs(d['rho_with_hazard']))

    # ── deployable scorer: per-modality PCA (full data) + ElasticNet on pooled hazard ──
    def modal_mat(key, dim):
        return np.array([np.asarray(r[key], float) if r[key] is not None else np.zeros(dim) for r in rows])
    scalers, pcas = {}, {}
    feat_parts = []
    for key, dim, kpc in (('vis', 1536, tp.K_PER), ('mot', 768, tp.K_PER), ('aud', 1536, tp.K_PER)):
        M = modal_mat(key, dim); sc = StandardScaler().fit(M); pc = PCA(n_components=min(kpc, n - 1)).fit(sc.transform(M))
        scalers[key] = sc; pcas[key] = pc; feat_parts.append(pc.transform(sc.transform(M)))
    vdsp = np.array([r['vdsp'] for r in rows], float)
    Xreel = np.concatenate(feat_parts + [vdsp], 1)                 # per-reel feature
    # pooled (reel × interval)
    Xp, yp = [], []
    for i, r in enumerate(rows):
        for j in range(4):
            Xp.append(list(Xreel[i]) + [1.0 if k == j else 0.0 for k in range(4)] + [r['recency']]); yp.append(r['h'][j])
    Xp = np.array(Xp); yp = np.array(yp)
    fscl = StandardScaler().fit(Xp)
    model = ElasticNet(alpha=0.03, l1_ratio=0.5, max_iter=5000).fit(fscl.transform(Xp), np.log(yp / (1 - yp)))
    pickle.dump({'scalers': scalers, 'pcas': pcas, 'fscl': fscl, 'model': model,
                 'vis_dsp_keys': tp.VIS_DSP, 'k_per': tp.K_PER}, open(PKL, 'wb'))

    # gold embeddings (vision mean⊕hook) for nearest-neighbour retrieval
    G = np.array([r['vis'] for r in rows], np.float32)
    Gn = G / (np.linalg.norm(G, axis=1, keepdims=True) + 1e-9)
    np.savez(GOLD, emb=Gn, ids=np.array([r['id'] for r in rows]), names=np.array([r['name'] for r in rows]),
             frame0=np.array([r['frame0'] or '' for r in rows]), hazard=mh.astype(np.float32))

    out = {'n': n, 'no_llm': True, 'levers': levers,
           'note': ('rho_with_hazard < 0 means raising the lever LOWERS swipe (good). "median_keepers" is the value '
                    'the low-hazard third of reels actually have — the measured target. All from pixels/waveform, no LLM. '
                    'Signal is weak at n=%d (rank only), so treat each as a hypothesis to A/B test.' % n)}
    json.dump(out, open(OUT, 'w'))
    top = [l for l in levers if abs(l['rho_with_hazard']) > 0.1][:6]
    print(f"{n} reels · {len(levers)} DSP levers · scorer + gold saved")
    for l in top:
        print(f"  {l['label']:24s} ρ={l['rho_with_hazard']:+.2f}  {l['direction']} (keepers≈{l['median_keepers']:.3f} vs all {l['median_all']:.3f})")


if __name__ == '__main__':
    main()
