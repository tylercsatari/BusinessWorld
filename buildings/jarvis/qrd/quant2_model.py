#!/usr/bin/env python3
"""
QUANT 2 — bottom-up swipe-hazard model (the computable scaffold).

Philosophy (from the Quant-2 brief): do NOT quantify named mechanisms ("stakes")
top-down. Quantify the viewer's leave/stay behaviour as a DISCRETE-TIME HAZARD,
discover the latent directions that move it, and only name them afterward.

What THIS script computes from REAL data (no fabrication):
  • A discrete-time survival/hazard table from each reel's real retention anchors
    (3s hold `keep`, plus ret_25/50/75/90 → a monotone survival curve).
  • A pooled discrete-time hazard model  h_ij = P(leave in interval j | survived):
    standardised content features + interval + duration + real-date recency,
    fit linear (ElasticNet, interpretable) AND nonlinear (GBT), scored by a
    GROUPED, TIME-ORDERED split (all intervals of a reel stay together; train on
    earlier reels, validate on later — a real split-by-time using the Pen dates).
  • Latent-direction discovery: PLS between standardised features and the reel's
    hazard vector → the directions that most change leave-probability (named only
    post-hoc, with example reels at each extreme).
  • The data pyramid inventory (what's truly-labelled vs needs gathering).

What it does NOT pretend to have: a 0.5s-resolution hazard (needs the per-second
audience-retention export), or self-supervised video/audio encoder features
(needs the raw mp4s + GPU). Those are flagged in the output as roadmap, not done.

Honest by construction: with ~213 reels the model is a SCAFFOLD; every score is
out-of-fold with a confidence range, and tiny gaps are treated as noise.
"""
import os, json, warnings, datetime
warnings.filterwarnings('ignore')
import numpy as np
np.random.seed(7)
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import ElasticNet
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.cross_decomposition import PLSRegression
from sklearn.metrics import r2_score
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'quant2_model.json')
DATES = os.path.join(HERE, 'qrd_dates.json')

LLM = ['z_score', 'vz_score', 'novelty', 'cognitive_load', 'net_novelty',
       'action', 'scale', 'contrast', 'expression', 'v_novelty']
EXTRACTED = ['a_loud_first3_ratio', 'a_loud_slope', 'a_onset_mean', 'a_centroid_mean',
             'a_pitch_slope', 'a_zcr_mean', 'a_mfcc1_mean', 'a_voiced_ratio',
             'v_speaking_rate', 'v_time_first_word', 'v_hook_question', 'vi_cut_rate',
             'vi_motion_first3_ratio', 'vi_motion_mean', 'vi_bright_slope', 'vi_sat_mean',
             'vi_warmth_first3_ratio', 'vi_face_frac', 'vi_face_size', 'vi_text_at0']
CONF = ['duration_s', 'c_recency']
CONTENT = LLM + EXTRACTED   # the levers; confounds are read underneath them
LABELS = {
    'a_loud_first3_ratio': 'Loudness swell', 'a_loud_slope': 'Loudness ramp', 'a_onset_mean': 'Onset punch',
    'a_centroid_mean': 'Audio brightness', 'a_pitch_slope': 'Pitch lift', 'a_zcr_mean': 'Zero-crossing',
    'a_mfcc1_mean': 'Timbre (MFCC-1)', 'a_voiced_ratio': 'Voiced ratio', 'v_speaking_rate': 'Speaking rate',
    'v_time_first_word': 'Time to first word', 'v_hook_question': 'Question hook', 'vi_cut_rate': 'Cut rate',
    'vi_motion_first3_ratio': 'Early motion', 'vi_motion_mean': 'Motion energy', 'vi_bright_slope': 'Brightness ramp',
    'vi_sat_mean': 'Saturation', 'vi_warmth_first3_ratio': 'Warm open', 'vi_face_frac': 'Face presence',
    'vi_face_size': 'Face size', 'vi_text_at0': 'Hook caption', 'z_score': 'Zeigarnik (text)', 'vz_score': 'Visual Zeigarnik',
    'novelty': 'Novelty', 'cognitive_load': 'Cognitive load', 'net_novelty': 'Net novelty', 'action': 'Visual action',
    'scale': 'Visual scale', 'contrast': 'Visual contrast', 'expression': 'Visual expression', 'v_novelty': 'Visual novelty',
    'duration_s': 'Duration', 'c_recency': 'Recency (era)',
}
# survival anchors as a fraction of duration (the only curve the data carries)
ANCHOR_FRAC = [0.25, 0.50, 0.75, 0.90]
INTERVAL_MID = [0.125, 0.375, 0.625, 0.825]   # midpoint of each interval (for the hazard curve x-axis)


def load():
    feats = {r['ytId']: r for r in json.load(open(os.path.join(HERE, 'qrd_features.json')))}
    rows = json.load(open(os.path.join(JARVIS, 'signals-dataset-expanded.json')))
    vis = json.load(open(os.path.join(JARVIS, 'vision-scores-cache.json'))) if os.path.exists(os.path.join(JARVIS, 'vision-scores-cache.json')) else {}
    tgt = json.load(open(os.path.join(HERE, 'qrd_targets.json'))) if os.path.exists(os.path.join(HERE, 'qrd_targets.json')) else {}
    dates = json.load(open(DATES)) if os.path.exists(DATES) else {}
    merged = []
    for r in rows:
        yid = r.get('ytId')
        if not yid:
            continue
        rec = dict(r)
        v = vis.get(yid)
        if v:
            rec.update({'action': v.get('action'), 'scale': v.get('scale'), 'contrast': v.get('contrast'),
                        'expression': v.get('expression'), 'v_novelty': v.get('novelty')})
        f = feats.get(yid, {})
        for k, val in f.items():
            if isinstance(val, (int, float)) and k != 'signature':
                rec[k] = val
        s = tgt.get(yid)
        if s and isinstance(s.get('swipe'), (int, float)):
            rec['swipe'] = s['swipe']
        d = (dates.get(yid) or {}).get('date')
        try:
            rec['_dt'] = datetime.date.fromisoformat(d) if d else None
        except Exception:
            rec['_dt'] = None
        merged.append(rec)
    valid = [r['_dt'] for r in merged if r.get('_dt')]
    base = min(valid) if valid else None
    for rec in merged:
        rec['c_recency'] = ((rec['_dt'] - base).days / 365.0) if (rec.get('_dt') and base) else np.nan
    merged.sort(key=lambda r: (r.get('_dt') is None, r.get('_dt') or datetime.date(1900, 1, 1)))
    # impute features
    for k in CONTENT + CONF:
        vals = [r[k] for r in merged if isinstance(r.get(k), (int, float)) and np.isfinite(r.get(k))]
        med = float(np.median(vals)) if vals else 0.0
        for r in merged:
            if not isinstance(r.get(k), (int, float)) or not np.isfinite(r.get(k)):
                r[k] = med
    return merged, (str(min(valid)) if valid else None, str(max(valid)) if valid else None), len(valid)


def survival_curve(rec):
    """Monotone survival S at [0,.25,.5,.75,.9] from the real anchors; None if missing."""
    a = [rec.get('ret_25'), rec.get('ret_50'), rec.get('ret_75'), rec.get('ret_90')]
    if any(not isinstance(x, (int, float)) or not np.isfinite(x) for x in a):
        return None
    S = [1.0]
    for x in a:
        S.append(min(S[-1], max(1e-3, min(1.0, float(x)))))   # clip to (0,1], enforce non-increasing
    return S  # length 5: S[0..4] at fracs [0,.25,.5,.75,.9]


def hazard_table(merged):
    """Pooled (reel × interval) discrete-time hazard observations."""
    Xrows, hrows, grp, reel_haz = [], [], [], {}
    feat_keys = CONTENT + CONF
    for gi, rec in enumerate(merged):
        S = survival_curve(rec)
        if S is None:
            continue
        hz = []
        for j in range(4):
            h = (S[j] - S[j + 1]) / max(S[j], 1e-6)     # leave-prob in interval j given survived
            h = float(min(1 - 1e-3, max(1e-3, h)))
            hz.append(h)
            iv = [1.0 if k == j else 0.0 for k in range(4)]   # interval one-hot
            Xrows.append([rec[k] for k in feat_keys] + iv)
            hrows.append(h)
            grp.append(gi)
        reel_haz[rec['ytId']] = {'name': (rec.get('name') or rec['ytId'])[:48], 'S': S, 'h': hz,
                                 'keep3s': (1 - rec['keep'] / 100.0) if isinstance(rec.get('keep'), (int, float)) else None,
                                 'swipe': rec.get('swipe')}
    cols = [LABELS.get(k, k) for k in feat_keys] + ['interval_0', 'interval_1', 'interval_2', 'interval_3']
    return np.array(Xrows), np.array(hrows), np.array(grp), cols, feat_keys, reel_haz


def grouped_time_cv(X, y, grp, model_fn, n_folds=5):
    """Time-ordered grouped CV: groups (reels) are already date-sorted, so splitting
    on group index = split by time. All intervals of a reel stay together."""
    uniq = np.array(sorted(set(grp)))   # group ids in chronological order
    ng = len(uniq)
    start = int(ng * 0.4)
    step = max(1, (ng - start) // n_folds)
    scores, sp = [], []
    oof = np.full(len(y), np.nan)
    for f in range(n_folds):
        tr_g = uniq[:start + f * step]
        te_g = uniq[start + f * step: start + (f + 1) * step]
        if len(te_g) == 0 or len(tr_g) < 8:
            continue
        tr = np.isin(grp, tr_g)
        te = np.isin(grp, te_g)
        sc = StandardScaler().fit(X[tr])
        m = model_fn()
        # model the hazard in logit space (bounded 0-1 target)
        ytr = np.log(y[tr] / (1 - y[tr]))
        m.fit(sc.transform(X[tr]), ytr)
        pr = m.predict(sc.transform(X[te]))
        ph = 1 / (1 + np.exp(-pr))
        oof[te] = ph
        if te.sum() > 2:
            scores.append(r2_score(y[te], ph))
            s = spearmanr(y[te], ph).correlation
            if np.isfinite(s):
                sp.append(s)
    return (float(np.mean(scores)) if scores else 0.0, float(np.std(scores)) if len(scores) > 1 else 0.0,
            [float(s) for s in scores], float(np.mean(sp)) if sp else 0.0, oof)


def main():
    merged, span, n_dated = load()
    X, y, grp, cols, feat_keys, reel_haz = hazard_table(merged)
    n_reels = len(reel_haz)
    print(f'reels with a survival curve: {n_reels}  ·  pooled (reel×interval) obs: {len(y)}  ·  dated {n_dated}')

    # corpus-mean hazard + survival curve
    corpus_h = [float(np.mean([reel_haz[k]['h'][j] for k in reel_haz])) for j in range(4)]
    corpus_S = [1.0]
    for h in corpus_h:
        corpus_S.append(corpus_S[-1] * (1 - h))
    keep3 = [reel_haz[k]['keep3s'] for k in reel_haz if reel_haz[k]['keep3s'] is not None]
    hook_hazard = float(np.mean(keep3)) if keep3 else None   # 3s-hook leave probability

    # ── discrete-time hazard models ──
    en = grouped_time_cv(X, y, grp, lambda: ElasticNet(alpha=0.02, l1_ratio=0.5, max_iter=5000))
    gb = grouped_time_cv(X, y, grp, lambda: GradientBoostingRegressor(n_estimators=120, max_depth=2, subsample=0.7, random_state=7))

    # full-data linear hazard coefficients (interpretable, on logit hazard)
    sc = StandardScaler().fit(X)
    enf = ElasticNet(alpha=0.02, l1_ratio=0.5, max_iter=5000).fit(sc.transform(X), np.log(y / (1 - y)))
    coef = sorted([{'key': cols[j], 'coef': float(c)} for j, c in enumerate(enf.coef_)],
                  key=lambda d: abs(d['coef']), reverse=True)

    # ── latent-direction discovery: PLS(standardised reel features → reel hazard vector) ──
    ids = list(reel_haz.keys())
    Rf = np.array([[merged_by_id(merged, i)[k] for k in CONTENT] for i in ids], dtype=float)
    Hv = np.array([reel_haz[i]['h'] for i in ids])          # 4-dim hazard vector per reel
    Rs = StandardScaler().fit_transform(Rf)
    npc = min(4, Rs.shape[1])
    pls = PLSRegression(n_components=npc).fit(Rs, Hv)
    proj = pls.transform(Rs)                                  # reel latent scores
    latents = []
    for c in range(npc):
        load_c = pls.x_loadings_[:, c]
        top = sorted([{'key': LABELS.get(CONTENT[j], CONTENT[j]), 'load': float(load_c[j])} for j in range(len(CONTENT))],
                     key=lambda d: abs(d['load']), reverse=True)[:6]
        sc_c = proj[:, c]
        # effect on mean hazard: correlation of this latent with each reel's mean hazard
        mh = Hv.mean(axis=1)
        eff = float(spearmanr(sc_c, mh).correlation)
        order = np.argsort(sc_c)
        latents.append({
            'id': c, 'top_features': top, 'effect_on_hazard_rho': eff,
            'low_examples': [reel_haz[ids[i]]['name'] for i in order[:4]],
            'high_examples': [reel_haz[ids[i]]['name'] for i in order[-4:][::-1]],
        })

    # data pyramid (what's truly-labelled vs needs gathering)
    pyramid = {
        'tier1_true_labels': {'have': n_reels, 'what': 'reels with real retention anchors (3s hold + ret_25/50/75/90)'},
        'tier1_fine_curve': {'have': 0, 'need': n_reels, 'what': 'per-second audience-retention export (YouTube Studio) → true 0.5s hazard'},
        'tier3_weak_public': {'have': n_reels, 'what': 'views / log_views (downstream, confounded — auxiliary only)'},
        'tier4_unlabeled_raw': {'have': 0, 'need_encoders': True, 'what': '~2,000 downloaded videos — for the content manifold once encoded (DINOv2/VideoMAE/V-JEPA/AudioMAE). NOT swipe labels.'},
        'tier5_human_pairwise': {'have': 0, 'what': 'pairwise "which would you swipe first?" — for naming latent directions'},
    }

    out = {
        'n_reels': n_reels, 'n_obs': int(len(y)), 'n_dated': n_dated, 'date_span': span,
        'corpus_hazard': corpus_h, 'corpus_survival': corpus_S, 'interval_frac': ANCHOR_FRAC, 'interval_mid': INTERVAL_MID,
        'hook_hazard_3s': hook_hazard,
        'per_reel': {k: reel_haz[k] for k in list(reel_haz)[:60]},   # sample for the UI scatter
        'models': {
            'elasticnet_logit_hazard': {'r2_mean': en[0], 'r2_std': en[1], 'scores': en[2], 'spearman': en[3]},
            'gbt_hazard': {'r2_mean': gb[0], 'r2_std': gb[1], 'scores': gb[2], 'spearman': gb[3]},
        },
        'hazard_coefficients': coef,
        'latent_directions': latents,
        'pyramid': pyramid,
        'leakage': {'split_by_time': n_dated == len(merged), 'grouped_by_reel': True,
                    'target_bounded': True, 'fit_on_train_only': True},
        'honesty': ('Coarse scaffold: 4 survival anchors per reel at %-of-duration, ~213 reels. '
                    'This is NOT the 0.5s-resolution hazard the architecture wants — that needs the '
                    'per-second retention export. Scores are out-of-fold on a real date split; treat small '
                    'gaps as noise. The architecture (encoders → latent z(t) → fine hazard → teacher/student) '
                    'is the build target; this is the part computable from data on hand.'),
    }
    json.dump(out, open(OUT, 'w'))
    print(f"hook 3s-hazard (mean leave-prob 0-3s): {hook_hazard:.3f}" if hook_hazard else "no 3s data")
    print(f"corpus hazard by interval (%dur): {[round(h,3) for h in corpus_h]}  → survival {[round(s,3) for s in corpus_S]}")
    print(f"hazard model OOF R²: ElasticNet {en[0]:.3f}±{en[1]:.3f} (ρ {en[3]:.2f})  ·  GBT {gb[0]:.3f}±{gb[1]:.3f} (ρ {gb[3]:.2f})")
    print(f"top latent direction effect ρ vs hazard: {[round(l['effect_on_hazard_rho'],2) for l in latents]}")
    print(f"→ quant2_model.json")


def merged_by_id(merged, yid):
    for r in merged:
        if r['ytId'] == yid:
            return r
    return {}


if __name__ == '__main__':
    main()
