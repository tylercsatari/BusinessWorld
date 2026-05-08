#!/usr/bin/env python3
"""
Hook Model — fix normalizer + post-upload r-values + validate on training set.

Loads 372 videos from videos_complete.json, computes pre/post indicator values,
populates the model-v2.json with mean/std and Pearson r values, then uses ridge
regression to compute post_to_views_weights that don't explode for OOD hooks.

Validation: rank correlation between predicted and actual log10(views) on 10
videos spanning the view distribution.
"""

import json
import math
import os
import re
import subprocess
import sys
from collections import Counter

import numpy as np
from scipy.stats import pearsonr, spearmanr
from sklearn.linear_model import Ridge

ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(ROOT, 'model-v2.json')
VIDEOS_PATH = '/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset/01_video_performance/videos_complete.json'
VAL_OUT_PATH = os.path.join(ROOT, 'validation_results.json')

# ── Featurizer (Python port of featurizer.js) ──

CONTRASTIVE = ['but', 'however', 'yet', 'although', 'whereas', 'while',
               'nevertheless', 'meanwhile', 'despite', 'instead', 'rather',
               'conversely', 'nonetheless', 'on the other hand', 'in contrast']
COMPARISON = ['than', 'vs', 'versus', 'more', 'less', 'better', 'worse',
              'greater', 'smaller', 'higher', 'lower', 'faster', 'slower']
INTERROGATIVE = {'what', 'how', 'why', 'who', 'when', 'where', 'which', 'whose',
                 'will', 'can', 'could', 'would', 'should',
                 'do', 'does', 'did', 'is', 'are', 'was', 'were',
                 'if', 'whether'}
SECOND_PERSON = {'you', 'your', 'yours', 'yourself', 'yourselves'}

WINDOWS = [1, 3, 5, 10]
DEFAULT_WPS = 4.402

INDICATOR_KEYS = [
    'transcript_word_count', 'transcript_char_count',
    'unique_word_ratio', 'hapax_legomena_ratio',
    'pivot_word_count', 'pivot_word_density',
    'comparison_word_count', 'hook_word_ratio', 'second_person_ratio',
    'hook_question_count', 'hook_question_density',
    'exclamation_count', 'repeated_phrase_count',
]

POST_KEYS = [
    'avg_percent_viewed', 'swiped_away_rate_pct', 'stayed_to_watch_pct',
    'avg_retention_vs_baseline', 'non_sub_fraction', 'retention_variation',
    'ret_at_10pct', 'ret_at_25pct', 'ret_at_50pct', 'ret_at_75pct',
    'ret_at_85pct', 'ret_at_90pct',
    'hook_drop', 'end_recovery', 'retention_quartile_spread',
]


def tokens(text):
    return [w for w in text.lower().split() if w]


def count_word_boundary(text_lower, words):
    n = 0
    for w in words:
        n += len(re.findall(r'\b' + re.escape(w) + r'\b', text_lower))
    return n


def count_word_set(words_list, word_set):
    n = 0
    for w in words_list:
        if re.sub(r'[^a-z\']', '', w) in word_set:
            n += 1
    return n


def featurize_window(orig_text):
    """Return all feature values for a windowed text. Mirrors featurizer.js."""
    text = orig_text.lower()
    words = tokens(text)
    wc = len(words)
    out = {}
    out['transcript_word_count'] = wc
    out['transcript_char_count'] = len(orig_text)
    out['unique_word_ratio'] = (len(set(words)) / wc) if wc else 0
    if wc:
        c = Counter(words)
        out['hapax_legomena_ratio'] = sum(1 for _, n in c.items() if n == 1) / wc
    else:
        out['hapax_legomena_ratio'] = 0
    pivot_n = count_word_boundary(text, CONTRASTIVE)
    out['pivot_word_count'] = pivot_n
    out['pivot_word_density'] = (pivot_n / wc * 100) if wc else 0
    out['comparison_word_count'] = count_word_boundary(text, COMPARISON)
    out['hook_word_ratio'] = (count_word_set(words, INTERROGATIVE) / wc) if wc else 0
    out['second_person_ratio'] = (count_word_set(words, SECOND_PERSON) / wc) if wc else 0
    out['hook_question_count'] = orig_text.count('?')
    out['hook_question_density'] = (orig_text.count('?') / wc) if wc else 0
    out['exclamation_count'] = orig_text.count('!')
    # repeated bigrams
    positions = {}
    for i in range(len(words) - 1):
        bg = words[i] + ' ' + words[i + 1]
        positions.setdefault(bg, []).append(i)
    rp = 0
    for _bg, pos in positions.items():
        if len(pos) < 2:
            continue
        for i in range(1, len(pos)):
            if pos[i] - pos[i - 1] >= 10:
                rp += 1
                break
    out['repeated_phrase_count'] = rp
    return out


def hook_at_window(transcript_words, window_s, fallback_text='', wps=DEFAULT_WPS):
    """Extract text up to window_s using word timestamps when available."""
    if transcript_words:
        words = []
        for w in transcript_words:
            t = w.get('timestamp_s')
            if t is None:
                continue
            if t < window_s:
                words.append(w.get('word', ''))
        if words:
            return ' '.join(words)
    words = (fallback_text or '').split()
    n = max(1, int(round(window_s * wps)))
    return ' '.join(words[:n])


# ── Post indicators ──

def curve_at(curve, pos):
    if not curve:
        return None
    best, best_d = None, float('inf')
    for p in curve:
        ppos = p.get('position') if 'position' in p else p.get('second')
        if ppos is None:
            continue
        d = abs(ppos - pos)
        if d < best_d:
            best_d = d
            best = p.get('retention')
    if best is None or not math.isfinite(best):
        return None
    return best


def curve_mean(curve, lo, hi):
    if not curve:
        return None
    vals = []
    for p in curve:
        ppos = p.get('position') if 'position' in p else p.get('second')
        if ppos is None:
            continue
        if lo <= ppos <= hi and math.isfinite(p.get('retention', float('nan'))):
            vals.append(p['retention'])
    if not vals:
        return None
    return sum(vals) / len(vals)


def num(x):
    return x if (x is not None and isinstance(x, (int, float)) and math.isfinite(x)) else None


def extract_post(v):
    out = {
        'avg_percent_viewed': num(v.get('avg_percent_viewed')),
        'swiped_away_rate_pct': num(v.get('swiped_away_rate_pct')),
        'stayed_to_watch_pct': num(v.get('stayed_to_watch_pct')),
        'avg_retention_vs_baseline': num(v.get('avg_retention_vs_baseline')),
        'non_sub_fraction': num(v.get('non_sub_fraction')),
        'retention_variation': num(v.get('retention_variation')),
    }
    curve = v.get('retention_curve')
    if not isinstance(curve, list):
        curve = None
    out['ret_at_10pct'] = curve_at(curve, 0.10)
    out['ret_at_25pct'] = curve_at(curve, 0.25)
    out['ret_at_50pct'] = curve_at(curve, 0.50)
    out['ret_at_75pct'] = curve_at(curve, 0.75)
    out['ret_at_85pct'] = curve_at(curve, 0.85)
    out['ret_at_90pct'] = curve_at(curve, 0.90)
    r10, r25 = out['ret_at_10pct'], out['ret_at_25pct']
    out['hook_drop'] = (r10 - r25) if (r10 is not None and r25 is not None) else None
    out['end_recovery'] = curve_mean(curve, 0.80, 0.95)
    q1 = curve_mean(curve, 0.0, 0.25)
    q4 = curve_mean(curve, 0.75, 1.0)
    out['retention_quartile_spread'] = (q4 / q1) if (q1 and q4 and q1 > 1e-6) else None
    return out


# ── Main ──

def main():
    print('Loading videos…')
    with open(VIDEOS_PATH) as f:
        blob = json.load(f)
    videos = blob['videos'] if isinstance(blob, dict) else blob
    print(f'  {len(videos)} videos')

    # Per-video pre features (52 keys = 13 indicators × 4 windows)
    feat_keys = [f'{ind}_w{w}' for ind in INDICATOR_KEYS for w in WINDOWS]
    pre_values = {fk: [] for fk in feat_keys}  # parallel lists across videos
    log10_views = []
    post_values = {pk: [] for pk in POST_KEYS}

    rows = []  # one row per kept video: { fkey -> value, post_key -> value, log10v }
    for v in videos:
        views = v.get('total_views')
        if not views or views <= 0:
            continue
        l10 = math.log10(views)
        words = v.get('transcript_words') or []
        full_text = v.get('transcript_text') or ''
        wps = DEFAULT_WPS

        row_pre = {}
        for w in WINDOWS:
            text = hook_at_window(words, w, full_text, wps)
            feats = featurize_window(text)
            for ind, val in feats.items():
                row_pre[f'{ind}_w{w}'] = val

        post = extract_post(v)
        rows.append({
            'video_id': v.get('video_id'),
            'title': v.get('title'),
            'total_views': views,
            'log10_views': l10,
            'pre': row_pre,
            'post': post,
        })

    print(f'  {len(rows)} videos with usable pre/post data')

    # ── Compute feature_stats (mean/std) ──
    feature_stats = {}
    for fk in feat_keys:
        vals = [r['pre'][fk] for r in rows]
        arr = np.array(vals, dtype=float)
        feature_stats[fk] = {
            'mean': float(arr.mean()),
            'std': float(arr.std(ddof=0)) if arr.std(ddof=0) > 1e-9 else 1e-6,
            'n': len(arr),
        }

    # ── Compute post_stats (mean/std) and post-r ──
    post_stats = {}
    post_r = {}
    for pk in POST_KEYS:
        pairs = [(r['post'][pk], r['log10_views']) for r in rows if r['post'][pk] is not None]
        if not pairs:
            post_stats[pk] = {'mean': 0.0, 'std': 1.0, 'n': 0}
            post_r[pk] = 0.0
            continue
        xs = np.array([p[0] for p in pairs], dtype=float)
        ys = np.array([p[1] for p in pairs], dtype=float)
        post_stats[pk] = {
            'mean': float(xs.mean()),
            'std': float(xs.std(ddof=0)) if xs.std(ddof=0) > 1e-9 else 1e-6,
            'n': len(xs),
        }
        if len(xs) >= 3 and xs.std() > 1e-9:
            r, _ = pearsonr(xs, ys)
            post_r[pk] = float(r) if math.isfinite(r) else 0.0
        else:
            post_r[pk] = 0.0

    print('Post-upload Pearson r with log10(views):')
    for pk in POST_KEYS:
        print(f'  {pk:30s} r={post_r[pk]:+.4f}  n={post_stats[pk]["n"]}')

    # ── Compute pre→views Pearson r ──
    pre_r_views = {}
    for fk in feat_keys:
        xs = np.array([r['pre'][fk] for r in rows], dtype=float)
        ys = np.array([r['log10_views'] for r in rows], dtype=float)
        if xs.std() < 1e-9:
            pre_r_views[fk] = 0.0
        else:
            r, _ = pearsonr(xs, ys)
            pre_r_views[fk] = float(r) if math.isfinite(r) else 0.0

    # ── Compute pre→post Pearson r (for the 52 featurizer features) ──
    pre_post_r = {pk: {} for pk in POST_KEYS}
    for pk in POST_KEYS:
        for fk in feat_keys:
            pairs = [(r['pre'][fk], r['post'][pk]) for r in rows if r['post'][pk] is not None]
            if len(pairs) < 40:
                continue
            xs = np.array([p[0] for p in pairs], dtype=float)
            ys = np.array([p[1] for p in pairs], dtype=float)
            if xs.std() < 1e-9 or ys.std() < 1e-9:
                continue
            r, _ = pearsonr(xs, ys)
            if math.isfinite(r) and abs(r) >= 0.07:
                pre_post_r[pk][fk] = float(r)

    # ── Ridge regression: log10(views) ~ post_z ──
    # This fixes the architectural bug. Replaces individual Pearson r with
    # regularized multivariate coefficients that don't double-count correlated
    # retention metrics.
    common = [r for r in rows if all(r['post'][pk] is not None for pk in POST_KEYS)]
    print(f'Ridge regression on {len(common)} complete-post videos…')
    X = np.zeros((len(common), len(POST_KEYS)))
    y = np.array([r['log10_views'] for r in common])
    for i, r in enumerate(common):
        for j, pk in enumerate(POST_KEYS):
            v = r['post'][pk]
            mu = post_stats[pk]['mean']
            sd = max(post_stats[pk]['std'], 1e-6)
            X[i, j] = (v - mu) / sd

    # Use a moderate alpha to suppress correlated retention metrics' joint pull.
    # The pre-Pearson-r-as-weights architecture sums correlated z-scores, which
    # explodes for out-of-distribution hooks. Ridge with alpha=5 keeps the
    # post→views layer's coefficient norm bounded so predictions stay near the
    # training-distribution mean (~1.6M views) rather than collapsing to 1 view.
    ridge = Ridge(alpha=5.0, fit_intercept=True)
    ridge.fit(X, y)
    print(f'  intercept={ridge.intercept_:.4f}  ||coef||={np.linalg.norm(ridge.coef_):.4f}')
    print('  Ridge coefficients (post_to_views_weights):')
    post_to_views_weights = {}
    for j, pk in enumerate(POST_KEYS):
        post_to_views_weights[pk] = float(ridge.coef_[j])
        print(f'    {pk:30s} {ridge.coef_[j]:+.4f}  (Pearson r {post_r[pk]:+.4f})')
    bias = float(ridge.intercept_)
    log10_views_std = float(np.array([r['log10_views'] for r in rows]).std(ddof=0))

    # ── Patch model-v2.json ──
    print('\nLoading existing model-v2.json…')
    with open(MODEL_PATH) as f:
        model = json.load(f)

    # Update bias and global stats
    model['bias'] = bias
    model['log10_views_std'] = log10_views_std

    # Update feature_stats (52 featurizer features)
    if 'feature_stats' not in model:
        model['feature_stats'] = {}
    for fk, st in feature_stats.items():
        model['feature_stats'][fk] = st

    # Update post_stats
    model['post_stats'] = post_stats

    # Update post_to_views_weights with ridge coefficients (the actual fix)
    model['post_to_views_weights'] = post_to_views_weights

    # Update post_nodes — keep mean/std/r_with_views (Pearson r for display)
    for node in model.get('post_nodes', []):
        pk = node.get('key')
        if pk in post_stats:
            node['mean'] = post_stats[pk]['mean']
            node['std'] = post_stats[pk]['std']
            node['n_videos'] = post_stats[pk]['n']
            node['r_with_views'] = post_r.get(pk, 0.0)

    # Update featurizer pre_nodes with r_with_views and refresh per-key stats
    for node in model.get('pre_nodes', []):
        if node.get('source') != 'featurizer':
            continue
        fk = node.get('key')
        if fk in pre_r_views:
            node['r_with_views'] = pre_r_views[fk]
            node['n_videos'] = feature_stats[fk]['n']

    # Update pre_to_post_weights for the 52 featurizer features.
    # Preserve dataset-derived edges but refresh featurizer edges.
    if 'pre_to_post_weights' not in model:
        model['pre_to_post_weights'] = {}
    featurizer_keys = set(feat_keys)
    for pk in POST_KEYS:
        existing = model['pre_to_post_weights'].get(pk, {})
        # Drop stale featurizer entries; keep dataset entries
        cleaned = {k: v for k, v in existing.items() if k not in featurizer_keys}
        # Re-add featurizer entries from fresh computation
        for fk, r in pre_post_r[pk].items():
            cleaned[fk] = r
        # Sort by abs(r) descending for readability
        sorted_pairs = sorted(cleaned.items(), key=lambda kv: -abs(kv[1]))
        model['pre_to_post_weights'][pk] = dict(sorted_pairs)

    # ── Recompute post_combo_stats by simulating model on training data ──
    # post_combo_raw = Σ pre_to_post[post][pre_key] · pre_z
    # We need pre_z for ALL pre keys (including the 630 dataset features that
    # aren't in our local featurizer). So we just simulate the raw activation
    # using ONLY featurizer features that we computed (a partial sum). To be
    # consistent with how the JS scorer multiplies by pre_z for keys that
    # aren't in the input (where it defaults to 0), this gives a faithful
    # simulation of what happens when only the featurizer pre_z's are non-zero
    # — which is exactly the inference-time behavior for a brand-new hook.
    print('\nRecomputing post_combo_stats from training-set simulation…')
    post_combo_stats = {}
    for pk in POST_KEYS:
        weights = model['pre_to_post_weights'].get(pk, {})
        raws = []
        for r in rows:
            raw = 0.0
            for fk, w in weights.items():
                if fk not in r['pre']:
                    continue  # dataset feature with no per-video featurizer value
                stat = feature_stats.get(fk)
                if not stat:
                    continue
                z = (r['pre'][fk] - stat['mean']) / max(stat['std'], 1e-6)
                z = max(-5.0, min(5.0, z))
                raw += w * z
            raws.append(raw)
        arr = np.array(raws, dtype=float)
        post_combo_stats[pk] = {
            'mean': float(arr.mean()),
            'std': float(arr.std(ddof=0)) if arr.std(ddof=0) > 1e-6 else 1.0,
            'n': len(arr),
        }
    model['post_combo_stats'] = post_combo_stats

    model['training_n'] = len(rows)
    model['trained_at'] = __import__('datetime').datetime.utcnow().isoformat() + 'Z'

    print('Saving updated model-v2.json…')
    with open(MODEL_PATH, 'w') as f:
        json.dump(model, f, indent=2)

    # ── Validation: 10 videos spanning the view distribution ──
    print('\nSelecting 10 validation videos spanning view distribution…')
    sorted_rows = sorted(rows, key=lambda r: r['total_views'])
    # Pick at evenly-spaced quantiles
    indices = np.linspace(0, len(sorted_rows) - 1, 10).astype(int)
    val_videos = [sorted_rows[i] for i in indices]

    # Score each via subprocess to the JS model
    scorer_js = os.path.join(ROOT, '_validate_one.js')
    with open(scorer_js, 'w') as f:
        f.write('''
const path = require('path');
const { predict } = require('./model-v2');
const hook = process.argv[2];
const wps = parseFloat(process.argv[3] || '4.402');
const out = predict(hook, wps);
console.log(JSON.stringify({ log10_views: out.log10_views, predicted_views: out.predicted_views }));
''')

    # Build a video_id → raw video dict for hook extraction
    raw_by_id = {v.get('video_id'): v for v in videos}

    table = []
    print('\n' + '=' * 130)
    print(f'{"Title":<60} {"Actual views":>14} {"Predicted":>14} {"ActualRk":>9} {"PredRk":>7} {"Match":>6}')
    print('=' * 130)
    actual_l10 = [r['log10_views'] for r in val_videos]
    pred_l10 = []
    for r in val_videos:
        v = raw_by_id.get(r['video_id'], {})
        hook = hook_at_window(v.get('transcript_words') or [], 10,
                              v.get('transcript_text') or '', DEFAULT_WPS)
        try:
            res = subprocess.run(
                ['node', scorer_js, hook, str(DEFAULT_WPS)],
                capture_output=True, text=True, timeout=30, cwd=ROOT,
            )
            out = json.loads(res.stdout.strip().splitlines()[-1])
            pred_l10.append(out['log10_views'])
            pv = out['predicted_views']
        except Exception as e:
            print(f'  ERROR scoring {r["title"][:40]}: {e}')
            pred_l10.append(float('nan'))
            pv = float('nan')
        table.append({
            'video_id': r['video_id'],
            'title': r['title'],
            'actual_views': r['total_views'],
            'predicted_views': pv,
            'actual_log10': r['log10_views'],
            'predicted_log10': pred_l10[-1],
            'hook_text': hook[:120],
        })

    # Compute ranks
    actual_rank = np.argsort(np.argsort(actual_l10))
    pred_rank = np.argsort(np.argsort(pred_l10))
    rho, _ = spearmanr(actual_l10, pred_l10)
    for i, row in enumerate(table):
        row['actual_rank'] = int(actual_rank[i])
        row['pred_rank'] = int(pred_rank[i])
        row['match'] = bool(actual_rank[i] == pred_rank[i])
        title = (row['title'] or '')[:58]
        print(f'{title:<60} {row["actual_views"]:>14,} {row["predicted_views"]:>14,.0f} {row["actual_rank"]:>9} {row["pred_rank"]:>7} {"YES" if row["match"] else "no":>6}')
    print('=' * 130)
    print(f'Spearman rank correlation: ρ = {rho:.4f}')

    quality = 'GOOD' if rho >= 0.7 else ('OK' if rho >= 0.5 else 'POOR')
    print(f'Quality: {quality}')

    # Save validation
    val = {
        'spearman_rho': float(rho) if math.isfinite(rho) else None,
        'quality': quality,
        'n_videos': len(table),
        'bias': bias,
        'log10_views_std': log10_views_std,
        'ridge_alpha': 5.0,
        'post_to_views_weights': post_to_views_weights,
        'post_pearson_r': post_r,
        'rows': table,
    }
    with open(VAL_OUT_PATH, 'w') as f:
        json.dump(val, f, indent=2)
    print(f'\nSaved {VAL_OUT_PATH}')

    # Cleanup tmp scorer
    try:
        os.remove(scorer_js)
    except OSError:
        pass


if __name__ == '__main__':
    main()
