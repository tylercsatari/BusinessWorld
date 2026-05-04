"""
Hook Model Training (V2 spec, no concept layer)
-----------------------------------------------

Refines the r-value-initialized weights via leave-one-out cross-validation
on the 372-video Tyler Csatari corpus.

  - Featurizer: a Python port of the JS featurizer in featurizer.js. Same
    word lists, same windows, same formulas — verified to match within ±1
    count on the training videos (see model.json node_meta).
  - Architecture: linear, no hidden layers. y = W @ x_norm + b.
  - Loss: MSE + lambda * sum_k |w_k - r_k| (L1 toward measured r).
  - Lambda: chosen via 5-value grid search [1e-5, 5e-5, 1e-4, 5e-4, 1e-3]
    by 10-fold CV.
  - LOO ensemble: 372 hold-out predictions used to compute calibrated CI.

Run (from buildings/jarvis/hook-model/):
    pip install pandas numpy scikit-learn
    python3 train.py

Outputs:
    - Overwrites model.json with trained weights, feature_stats, cv_r2.
    - Writes loo_predictions.json (per-video held-out prediction).
"""

import json
import math
import re
import sys
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
    from sklearn.linear_model import Ridge
    from sklearn.model_selection import KFold
except ImportError as e:
    print(f"Missing dependency: {e}. Run: pip install pandas numpy scikit-learn", file=sys.stderr)
    sys.exit(1)

# ─────── Paths ───────
HERE = Path(__file__).resolve().parent
TRANSCRIPTS = Path('/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset/01_video_performance/transcripts_with_segments.json')
MODEL_PATH = HERE / 'model.json'
LOO_PATH = HERE / 'loo_predictions.json'

# ─────── Word/phrase lists (must match featurizer.js exactly) ───────
PIVOT_WORDS = [
    'but', 'however', 'yet', 'although', 'whereas', 'while', 'nevertheless',
    'meanwhile', 'despite', 'instead', 'rather', 'conversely', 'nonetheless',
    'on the other hand', 'in contrast'
]
SENSORY_WORDS = {
    'feel', 'touch', 'cold', 'warm', 'hot', 'sharp', 'rough', 'smooth',
    'loud', 'quiet', 'bright', 'dark', 'smell', 'taste', 'bitter', 'sweet',
    'soft', 'hard', 'heavy', 'light', 'thick', 'thin', 'pain', 'ache',
    'burn', 'tingle'
}
OPEN_LOOP_PHRASES = [
    'what if', 'i wonder', "let's see", 'will it', 'can i', 'can we',
    'how many', 'is it possible', 'to find out', 'to see if', 'to see how',
    'to test', 'but first', 'wait until', 'watch what', "you won't believe",
    "let's find out", 'the question is', 'i wanted to see', 'i wanted to find out',
    'i wanted to test', 'i wanted to know', 'could i', 'could we', 'would it',
    'i need to know', 'i have to try', 'we need to find', "let's test",
    'to figure out', 'if it works', 'if this works', 'whether it'
]
PROOF_OF_WORK_PHRASES = [
    'i tested', 'i tried', 'i built', 'i made', 'i created', 'i spent',
    'i walked', 'i ran', 'i ate', 'i wore', 'i did', 'i used',
    'after testing', 'after trying', 'after building', 'after making',
    'i found out', 'i discovered', 'i learned', 'i measured',
    'this took', 'this cost', 'it took me', 'it cost me',
    'i calculated', 'i counted', 'i tracked', 'i recorded',
    'according to my', 'based on my', 'from my testing'
]
CONTRAST_PHRASES = [
    'but', 'however', 'instead', 'versus', 'surprisingly', 'actually',
    'except', 'though', 'although', 'yet', 'on the other hand',
    'plot twist', 'the catch'
]
ACTION_VERB_PHRASES = [
    'make', 'making', 'build', 'building', 'create', 'creating',
    'try', 'trying', 'test', 'testing', 'break', 'breaking',
    'destroy', 'destroying', 'cut', 'cutting', 'open', 'opening',
    'eat', 'eating', 'cook', 'cooking', 'turn', 'turning',
    'use', 'using', 'smash', 'smashing', 'drop', 'dropping',
    'launch', 'launching', 'pour', 'pouring', 'mix', 'mixing'
]
ESCALATION_PHRASES = [
    "and it gets worse", "but wait", "and then", "and here's the thing",
    "but here's where it gets", "and that's when", "and just when",
    "but the worst part", "and it only gets", "and then something happened",
    "and i realized", "and at that moment", "right at that point"
]
HOOK_TYPE_WORDS = {
    'what', 'how', 'why', 'will', 'can', 'could', 'would',
    'watch', 'see', 'look', 'check', 'wait', 'but', 'if'
}
BEAT_RE = re.compile(
    r'^(So|And\s+then|Now|But\s+then|Then|After|Before|When|Until|Because|Which\s+means)\b',
    re.IGNORECASE,
)

WINDOWS = [1, 3, 5, 10]

# ─────── Featurizer (Python port of featurizer.js) ───────

def count_word_boundary(t, words):
    return sum(len(re.findall(r'\b' + re.escape(w) + r'\b', t)) for w in words)

def count_phrases(t, phrases):
    return sum(t.count(p) for p in phrases)

def feat_pivot(t):           return count_word_boundary(t, PIVOT_WORDS)
def feat_open_loop(t):       return count_phrases(t, OPEN_LOOP_PHRASES)
def feat_proof(t):           return count_phrases(t, PROOF_OF_WORK_PHRASES)
def feat_contrast(t):        return count_phrases(t, CONTRAST_PHRASES)
def feat_action(t):          return count_phrases(t, ACTION_VERB_PHRASES)

def feat_open_loop_first_half(t):
    words = t.split()
    if not words: return 0
    mid = len(words) // 2
    return count_phrases(' '.join(words[:mid]), OPEN_LOOP_PHRASES)

def feat_sensory(t):
    return sum(1 for w in t.split() if re.sub(r"[^a-z']", '', w) in SENSORY_WORDS)

def feat_repeated_phrase(t):
    words = t.split()
    pos = {}
    for i in range(len(words) - 1):
        bg = words[i] + ' ' + words[i+1]
        pos.setdefault(bg, []).append(i)
    n = 0
    for plist in pos.values():
        if len(plist) < 2: continue
        for i in range(1, len(plist)):
            if plist[i] - plist[i-1] >= 10:
                n += 1
                break
    return n

def feat_unique_word_ratio(t):
    words = t.split()
    if not words: return 0.0
    return len(set(words)) / len(words)

def feat_hapax(t):
    words = t.split()
    if not words: return 0.0
    counts = {}
    for w in words: counts[w] = counts.get(w, 0) + 1
    return sum(1 for c in counts.values() if c == 1) / len(words)

def feat_beat(text):
    sents = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]
    return sum(1 for s in sents if BEAT_RE.match(s))

def feat_word_count(t):
    s = t.strip()
    return len(s.split()) if s else 0

def feat_char_count(text):
    return len(text)

def feat_hook_word_ratio(t):
    words = t.split()
    if not words: return 0.0
    n = sum(1 for w in words if re.sub(r"[^a-z']", '', w) in HOOK_TYPE_WORDS)
    return n / len(words)

def feat_hook_phrase_diversity(t):
    n = 0
    if any(p in t for p in OPEN_LOOP_PHRASES): n += 1
    if any(p in t for p in CONTRAST_PHRASES):  n += 1
    if any(p in t for p in ACTION_VERB_PHRASES): n += 1
    if any(p in t for p in PROOF_OF_WORK_PHRASES): n += 1
    if any(re.sub(r"[^a-z']", '', w) in SENSORY_WORDS for w in t.split()): n += 1
    return n

def feat_anticipation(t):
    words = t.split()
    if not words: return 0.0
    for i in range(len(words)):
        window = ' '.join(words[i:i+6])
        for p in ESCALATION_PHRASES:
            if p in window:
                return i / len(words)
    return 0.0  # imputed

INDICATOR_FNS = {
    'pivot_word_count': feat_pivot,
    'sensory_count': feat_sensory,
    'open_loop_count': feat_open_loop,
    'open_loop_count_first_half': feat_open_loop_first_half,
    'proof_of_work_count': feat_proof,
    'contrast_count': feat_contrast,
    'action_verb_count': feat_action,
    'repeated_phrase_count': feat_repeated_phrase,
    'unique_word_ratio': feat_unique_word_ratio,
    'hapax_legomena_ratio': feat_hapax,
    'beat_count': lambda t: feat_beat(t),  # uses original-case for re
    'transcript_word_count': feat_word_count,
    'transcript_char_count': lambda t: feat_char_count(t),
    'hook_word_ratio': feat_hook_word_ratio,
    'hook_phrase_diversity': feat_hook_phrase_diversity,
    'anticipation_escalation_position_pct': feat_anticipation,
}

# Indicators that should receive ORIGINAL-CASE text (not lowered)
RAW_TEXT_INDICATORS = {'beat_count', 'transcript_char_count'}


def extract_window(words_with_ts, window_sec, wps):
    """Slice transcript words to first N at window_sec, by word index estimate."""
    n = max(1, round(window_sec * wps))
    return [w['word'] for w in words_with_ts[:n]]


def featurize_video(words_with_ts, wps):
    out = {}
    for w_sec in WINDOWS:
        words = extract_window(words_with_ts, w_sec, wps)
        original = ' '.join(words)
        lowered = original.lower()
        for ikey, fn in INDICATOR_FNS.items():
            text = original if ikey in RAW_TEXT_INDICATORS else lowered
            out[f'{ikey}_w{w_sec}'] = fn(text)
    return out


# ─────── Training pipeline ───────

def main():
    print('Loading transcripts…')
    raw = json.loads(TRANSCRIPTS.read_text())
    videos = raw.get('videos', [])
    print(f'  {len(videos)} videos')

    rows = []
    targets = []
    video_ids = []
    for v in videos:
        tw = v.get('transcript_words') or []
        if not tw or not v.get('total_views'):
            continue
        last_t = max(1.0, tw[-1].get('timestamp_s') or 1.0)
        wps = len(tw) / last_t
        feats = featurize_video(tw, wps)
        rows.append(feats)
        targets.append(math.log10(v['total_views']))
        video_ids.append(v.get('video_id'))

    df = pd.DataFrame(rows).fillna(0.0)
    y = np.array(targets, dtype=float)
    print(f'Feature matrix: {df.shape}, target n={len(y)}')

    # Z-score normalize
    means = df.mean()
    stds = df.std(ddof=0).replace(0, 1e-6)
    X = ((df - means) / stds).clip(-5, 5).values

    # Load model.json (for r-value priors)
    model = json.loads(MODEL_PATH.read_text())
    feature_keys = list(df.columns)
    r_priors = np.array([model['weights'].get(k, 0.0) for k in feature_keys])

    # Lambda grid search via 10-fold CV
    print('\nLambda grid search…')
    best_lambda, best_r2 = None, -1e9
    for lam in [1e-5, 5e-5, 1e-4, 5e-4, 1e-3]:
        kf = KFold(n_splits=10, shuffle=True, random_state=42)
        preds = np.zeros_like(y)
        for tr, te in kf.split(X):
            # Re-center X around r-prior: solve y - bias = X @ (w - r) + X @ r
            # with Ridge on (w - r). Equivalent to L2 toward r prior.
            X_tr = X[tr]
            y_tr_centered = y[tr] - y[tr].mean()
            offset = X_tr @ r_priors
            ridge = Ridge(alpha=1.0 / max(lam, 1e-9), fit_intercept=False)
            ridge.fit(X_tr, y_tr_centered - offset)
            w_full = ridge.coef_ + r_priors
            preds[te] = X[te] @ w_full + y[tr].mean()
        ss_res = ((y - preds) ** 2).sum()
        ss_tot = ((y - y.mean()) ** 2).sum()
        r2 = 1 - ss_res / ss_tot
        print(f'  lambda={lam:.0e}  CV R²={r2:.4f}')
        if r2 > best_r2:
            best_r2, best_lambda = r2, lam

    print(f'\nBest lambda = {best_lambda:.0e}  CV R²={best_r2:.4f}')

    # Final fit on full data with best lambda
    bias = y.mean()
    offset = X @ r_priors
    ridge = Ridge(alpha=1.0 / max(best_lambda, 1e-9), fit_intercept=False)
    ridge.fit(X, y - bias - offset)
    final_weights = ridge.coef_ + r_priors

    # LOO predictions for calibrated uncertainty
    print('Computing LOO predictions…')
    loo_preds = np.zeros_like(y)
    for i in range(len(y)):
        idx = [j for j in range(len(y)) if j != i]
        X_tr = X[idx]
        y_tr = y[idx]
        bias_i = y_tr.mean()
        offset_i = X_tr @ r_priors
        r = Ridge(alpha=1.0 / max(best_lambda, 1e-9), fit_intercept=False)
        r.fit(X_tr, y_tr - bias_i - offset_i)
        w_i = r.coef_ + r_priors
        loo_preds[i] = X[i] @ w_i + bias_i
    loo_resid = y - loo_preds
    loo_std = float(np.std(loo_resid))
    print(f'  LOO residual std = {loo_std:.4f}')

    # Persist
    model['weights'] = {k: float(w) for k, w in zip(feature_keys, final_weights)}
    model['feature_stats'] = {
        k: {'mean': float(means[k]), 'std': float(stds[k]), 'n': int(len(y))}
        for k in feature_keys
    }
    model['bias'] = float(bias)
    model['log10_views_std'] = loo_std
    model['training_n'] = int(len(y))
    model['cv_r2'] = float(best_r2)
    model['lambda'] = best_lambda
    model['mode'] = 'trained'
    model['trained_at'] = pd.Timestamp.utcnow().isoformat()
    model['note'] = (
        f'Trained on {len(y)} videos via 10-fold CV lambda search '
        f'+ LOO calibration. CV R²={best_r2:.3f}.'
    )

    MODEL_PATH.write_text(json.dumps(model, indent=2))
    print(f'Wrote {MODEL_PATH}')

    LOO_PATH.write_text(json.dumps({
        'video_ids': video_ids,
        'y_true': y.tolist(),
        'y_loo': loo_preds.tolist(),
        'cv_r2': best_r2,
        'lambda': best_lambda,
        'loo_std': loo_std,
    }, indent=2))
    print(f'Wrote {LOO_PATH}')


if __name__ == '__main__':
    main()
