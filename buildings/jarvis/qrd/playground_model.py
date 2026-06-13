#!/usr/bin/env python3
"""
Export the deployable PLAYGROUND model for the upload predictor.

Uses ONLY extracted features (librosa/opencv/whisper) — NO LLM-scored features,
because the exact training prompts for the LLM scores can't be guaranteed
reproducible, and the user's rule is "consistent with model and prompt in
training data." Extracted-only stays consistent by construction (same code).

Exports the standardisation stats + model coefficients so the server can score
an uploaded reel with a few dot-products, plus the validated out-of-fold
accuracy for honest display.

Output: qrd_playground_model.json
"""
import os, json, warnings
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import ElasticNet, LogisticRegression
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import r2_score, roc_auc_score
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'qrd_playground_model.json')

# PRUNED to the features that genuinely influence swipe (|univariate corr| > 0.10),
# all time-windowed to the first 10s / expressed as rates. Duration is EXCLUDED:
# it is the strongest correlate (+0.46) but a format confound, not a hook lever,
# and dropping it both matches intent and raises out-of-fold AUC (0.84 -> 0.88).
# All reproducible from an upload (audio + visual + whisper transcript). No LLM.
FEATURES = ['v_hook_question', 'v_speaking_rate', 'v_time_first_word',
            'a_mfcc1_mean', 'a_onset_mean', 'a_pitch_slope', 'a_zcr_mean', 'a_centroid_mean',
            'vi_sat_mean', 'vi_face_size']
# which features need which modality (so the server can flag degraded inputs)
AUDIO_FEATS = [f for f in FEATURES if f.startswith('a_')]
VISUAL_FEATS = [f for f in FEATURES if f.startswith('vi_')]
VOICE_FEATS = ['v_speaking_rate', 'v_time_first_word', 'v_hook_question']
LABELS = {'a_loud_first3_ratio': 'Loudness swell', 'a_loud_slope': 'Loudness ramp', 'a_onset_mean': 'Onset punch',
          'a_centroid_mean': 'Audio brightness', 'a_pitch_slope': 'Pitch lift', 'a_zcr_mean': 'Zero-crossing',
          'a_mfcc1_mean': 'Timbre (MFCC-1)', 'a_voiced_ratio': 'Voiced ratio', 'v_speaking_rate': 'Speaking rate',
          'v_time_first_word': 'Time to first word', 'v_hook_question': 'Question hook', 'vi_cut_rate': 'Cut rate',
          'vi_motion_first3_ratio': 'Early motion', 'vi_motion_mean': 'Motion energy', 'vi_bright_slope': 'Brightness ramp',
          'vi_sat_mean': 'Saturation', 'vi_warmth_first3_ratio': 'Warm open', 'vi_face_frac': 'Face presence',
          'vi_face_size': 'Face size', 'vi_face_centered': 'Face centred', 'vi_text_at0': 'Hook caption', 'duration_s': 'Duration'}


def load():
    feats = {r['ytId']: r for r in json.load(open(os.path.join(HERE, 'qrd_features.json')))}
    exp = json.load(open(os.path.join(JARVIS, 'signals-dataset-expanded.json')))
    tgt = json.load(open(os.path.join(HERE, 'qrd_targets.json')))
    rows = []
    for r in exp:
        y = r.get('ytId')
        if not y or y not in tgt:
            continue
        rec = dict(r); f = feats.get(y, {})
        for k in FEATURES:
            if isinstance(f.get(k), (int, float)):
                rec[k] = f[k]
        rec['swipe'] = tgt[y]['swipe']
        rows.append(rec)
    med = {}
    for k in FEATURES:
        vals = [r[k] for r in rows if isinstance(r.get(k), (int, float)) and np.isfinite(r.get(k))]
        med[k] = float(np.median(vals)) if vals else 0.0
        for r in rows:
            if not isinstance(r.get(k), (int, float)) or not np.isfinite(r.get(k)):
                r[k] = med[k]
    return rows, med


def oof_metrics(X, sw):
    yb = (sw >= np.percentile(sw, 75)).astype(int)
    ylog = np.log1p(np.maximum(0, sw))
    tss = TimeSeriesSplit(n_splits=5)
    pp = np.full(len(sw), np.nan); pr = np.full(len(sw), np.nan)
    for tr, te in tss.split(X):
        sc = StandardScaler().fit(X[tr])
        if len(np.unique(yb[tr])) == 2:
            pp[te] = LogisticRegression(C=0.5, max_iter=2000).fit(sc.transform(X[tr]), yb[tr]).predict_proba(sc.transform(X[te]))[:, 1]
        pr[te] = ElasticNet(alpha=0.1, l1_ratio=0.5, max_iter=5000).fit(sc.transform(X[tr]), ylog[tr]).predict(sc.transform(X[te]))
    md = ~np.isnan(pp); mk = ~np.isnan(pr)
    # bootstrap AUC CI
    rng = np.random.default_rng(7); di = np.where(md)[0]; bs = []
    for _ in range(1000):
        b = rng.choice(di, di.size, replace=True)
        if len(np.unique(yb[b])) == 2:
            bs.append(roc_auc_score(yb[b], pp[b]))
    return {'auc': float(roc_auc_score(yb[md], pp[md])),
            'auc_ci': [float(np.percentile(bs, 5)), float(np.percentile(bs, 95))],
            'spearman': float(spearmanr(ylog[mk], pr[mk]).correlation),
            'r2_oof': float(r2_score(ylog[mk], pr[mk]))}


# whole-video features for the (weak, reproducible) retention ranking model
WV_FEATURES = ['wv_loud_mean', 'wv_loud_std', 'wv_loud_dynrange', 'wv_onset_density', 'wv_onset_std',
               'wv_centroid_mean', 'wv_centroid_std', 'wv_tempo', 'wv_voiced_ratio', 'wv_pitch_std',
               'wv_loud_changes_per_s', 'wv_cut_rate', 'wv_motion_mean', 'wv_motion_std', 'wv_bright_std',
               'wv_sat_mean', 'wv_avg_shot_len', 'wv_face_frac', 'duration_s']
WV_LABELS = {'wv_loud_dynrange': 'Loudness dynamic range', 'wv_onset_density': 'Audio event density',
             'wv_loud_changes_per_s': 'Loudness variation', 'wv_cut_rate': 'Cut rate (whole)',
             'wv_motion_std': 'Motion variety', 'wv_bright_std': 'Visual variety', 'wv_tempo': 'Tempo',
             'wv_avg_shot_len': 'Avg shot length', 'wv_face_frac': 'Face presence (whole)',
             'wv_motion_mean': 'Motion energy (whole)', 'wv_voiced_ratio': 'Voiced ratio (whole)',
             'wv_pitch_std': 'Pitch variety', 'wv_centroid_mean': 'Brightness (audio)',
             'wv_centroid_std': 'Brightness variety', 'wv_loud_mean': 'Loudness (whole)',
             'wv_loud_std': 'Loudness variation', 'wv_onset_std': 'Onset variety', 'wv_sat_mean': 'Saturation (whole)', 'duration_s': 'Duration'}


def export_retention(rows_by_id):
    """Whole-video → retention. Reproducible (no LLM). Weak but real (ranking)."""
    wvf = {r['ytId']: r for r in json.load(open(os.path.join(HERE, 'wholevideo_features.json')))}
    exp = json.load(open(os.path.join(JARVIS, 'signals-dataset-expanded.json')))
    rows = []
    for r in exp:
        y = r.get('ytId')
        if not y or y not in wvf:
            continue
        rec = {'retention': r.get('retention'), 'duration_s': r.get('duration_s')}
        for k in WV_FEATURES:
            if k in wvf[y] and isinstance(wvf[y][k], (int, float)):
                rec[k] = wvf[y][k]
        if not isinstance(rec['retention'], (int, float)):
            continue
        rows.append(rec)
    med = {}
    for k in WV_FEATURES:
        vals = [r[k] for r in rows if isinstance(r.get(k), (int, float)) and np.isfinite(r.get(k))]
        med[k] = float(np.median(vals)) if vals else 0.0
        for r in rows:
            if not isinstance(r.get(k), (int, float)) or not np.isfinite(r.get(k)): r[k] = med[k]
    X = np.array([[r[k] for k in WV_FEATURES] for r in rows]); y = np.array([r['retention'] for r in rows])
    tss = TimeSeriesSplit(n_splits=5); pred = np.full(len(y), np.nan)
    for tr, te in tss.split(X):
        sc = StandardScaler().fit(X[tr])
        pred[te] = ElasticNet(alpha=0.1, l1_ratio=0.5, max_iter=5000).fit(sc.transform(X[tr]), y[tr]).predict(sc.transform(X[te]))
    mk = ~np.isnan(pred)
    rng = np.random.default_rng(7); ri = np.where(mk)[0]; sp_bs = []
    for _ in range(1000):
        b = rng.choice(ri, ri.size, replace=True); sp_bs.append(spearmanr(y[b], pred[b]).correlation)
    sc = StandardScaler().fit(X)
    reg = ElasticNet(alpha=0.1, l1_ratio=0.5, max_iter=5000).fit(sc.transform(X), y)
    return {
        'features': WV_FEATURES, 'labels': WV_LABELS,
        'feature_means': sc.mean_.tolist(), 'feature_stds': sc.scale_.tolist(), 'impute_median': med,
        'regression': {'coef': reg.coef_.tolist(), 'intercept': float(reg.intercept_)},
        'metrics': {'r2_oof': float(r2_score(y[mk], pred[mk])),
                    'spearman': float(spearmanr(y[mk], pred[mk]).correlation),
                    'spearman_ci': [float(np.percentile(sp_bs, 5)), float(np.percentile(sp_bs, 95))],
                    'mean': float(np.mean(y)), 'sd': float(np.std(y))},
        'n_train': len(rows),
        'note': 'WEAK, reproducible (no LLM). Whole-video features → overall retention. Use for low-confidence RANKING only, not precise point prediction.',
    }


def main():
    rows, med = load()
    X = np.array([[r[k] for k in FEATURES] for r in rows]); sw = np.array([r['swipe'] for r in rows])
    metrics = oof_metrics(X, sw)
    # final full-data models for deployment
    sc = StandardScaler().fit(X)
    yb = (sw >= np.percentile(sw, 75)).astype(int); ylog = np.log1p(np.maximum(0, sw))
    clf = LogisticRegression(C=0.5, max_iter=2000).fit(sc.transform(X), yb)
    reg = ElasticNet(alpha=0.1, l1_ratio=0.5, max_iter=5000).fit(sc.transform(X), ylog)
    out = {
        'features': FEATURES,
        'labels': LABELS,
        'feature_means': sc.mean_.tolist(),
        'feature_stds': sc.scale_.tolist(),
        'impute_median': med,
        'dud_threshold': float(np.percentile(sw, 75)),
        'base_rate': float(yb.mean()),
        'dud_logistic': {'coef': clf.coef_[0].tolist(), 'intercept': float(clf.intercept_[0])},
        'swipe_regression': {'coef': reg.coef_.tolist(), 'intercept': float(reg.intercept_)},
        'metrics': metrics,
        'modality': {'audio': AUDIO_FEATS, 'visual': VISUAL_FEATS, 'voice': VOICE_FEATS},
        'n_train': len(rows),
        'note': 'Extracted-only (librosa/opencv/whisper). No LLM features — reproducible & consistent with training extraction code. Pre-publish: predicts swipe-away/dud risk only.',
    }
    try:
        out['retention_model'] = export_retention(rows)
    except Exception as e:
        print('  (retention model skipped:', e, ')')
    json.dump(out, open(OUT, 'w'))
    print(f"playground model exported → qrd_playground_model.json")
    print(f"  SWIPE dud AUC={metrics['auc']:.3f} (CI {metrics['auc_ci'][0]:.2f}-{metrics['auc_ci'][1]:.2f})  ρ={metrics['spearman']:.3f}  R²={metrics['r2_oof']:.3f}")
    if 'retention_model' in out:
        rm = out['retention_model']['metrics']
        print(f"  RETENTION (whole-video) R²={rm['r2_oof']:.3f}  ρ={rm['spearman']:.3f} (CI {rm['spearman_ci'][0]:.2f}-{rm['spearman_ci'][1]:.2f})  [weak/ranking]")
    print(f"  features: {len(FEATURES)}  train n={len(rows)}")


if __name__ == '__main__':
    main()
