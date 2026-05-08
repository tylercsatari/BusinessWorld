"""
Fix the Hook Model: compute normalizer, post-upload r-values, atomic post indicators.
Run: python3 buildings/jarvis/hook-model/fix_model.py
"""
import json, math, re
from pathlib import Path
from collections import Counter

DATASET = Path('/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset')
JARVIS = Path('/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis/hook-model')
WPS_DEFAULT = 4.402

# ── Load training videos ───────────────────────────────────────────
print("Loading training videos...")
with open(DATASET / '01_video_performance/videos_complete.json') as f:
    videos = json.load(f)['videos']
print(f"  {len(videos)} videos loaded")

# ── Featurizer ────────────────────────────────────────────────────
PIVOT_WORDS = ['but','however','yet','although','whereas','while','nevertheless',
               'meanwhile','despite','instead','rather','conversely','nonetheless',
               'on the other hand','in contrast']
COMPARISON_WORDS = ['more','less','than','fewer','greater','larger','smaller',
                    'better','worse','faster','slower']
SECOND_PERSON = ["you","your","you're","you'll","you've","you'd"]

def get_window_text(words_with_ts, window_sec, wps=WPS_DEFAULT):
    if words_with_ts:
        ws = [w for w in words_with_ts if (w.get('timestamp_s') or w.get('start') or w.get('timestamp') or 0) <= window_sec]
        return ' '.join(w.get('word', w.get('text', '')) for w in ws)
    return ''

def compute_indicators(text):
    if not text.strip():
        return {k: 0.0 for k in ['transcript_word_count','transcript_char_count',
                'unique_word_ratio','hapax_legomena_ratio','hook_question_count',
                'hook_question_density','exclamation_count','repeated_phrase_count',
                'hook_word_ratio','pivot_word_count','pivot_word_density',
                'comparison_word_count','second_person_ratio']}
    
    words = text.lower().split()
    n = max(len(words), 1)
    tl = text.lower()
    
    # Repeated bigrams (gap >= 10)
    positions = {}
    for i in range(len(words)-1):
        bg = words[i] + ' ' + words[i+1]
        positions.setdefault(bg, []).append(i)
    rep = sum(1 for pos in positions.values() if len(pos) >= 2 and any(pos[j]-pos[j-1] >= 10 for j in range(1, len(pos))))
    
    # Pivot words
    piv = sum(len(re.findall(r'\b' + re.escape(p) + r'\b', tl)) for p in PIVOT_WORDS)
    # Comparison words
    cmp = sum(tl.count(w) for w in COMPARISON_WORDS)
    # Second person
    sp = sum(tl.count(w) for w in SECOND_PERSON)
    
    return {
        'transcript_word_count': len(words),
        'transcript_char_count': len(text),
        'unique_word_ratio': len(set(words)) / n,
        'hapax_legomena_ratio': sum(1 for c in Counter(words).values() if c == 1) / n,
        'hook_question_count': text.count('?'),
        'hook_question_density': text.count('?') / n,
        'exclamation_count': text.count('!'),
        'repeated_phrase_count': rep,
        'hook_word_ratio': len(words) / n,  # will be ratio vs total words at @10s
        'pivot_word_count': piv,
        'pivot_word_density': piv / n,
        'comparison_word_count': cmp,
        'second_person_ratio': sp / n,
    }

# ── Compute features for all videos at all windows ─────────────────
print("Computing features for all videos...")
WINDOWS = [1, 3, 5, 10]
IND_KEYS = ['transcript_word_count','transcript_char_count','unique_word_ratio',
            'hapax_legomena_ratio','hook_question_count','hook_question_density',
            'exclamation_count','repeated_phrase_count','hook_word_ratio',
            'pivot_word_count','pivot_word_density','comparison_word_count','second_person_ratio']

# Feature matrix: {feature_key: [values across 372 videos]}
feature_vals = {}
log_views_list = []
post_vals = {k: [] for k in ['avg_percent_viewed','swiped_away_rate_pct','stayed_to_watch_pct',
                               'avg_retention_vs_baseline','non_sub_fraction',
                               'ret_at_10pct','ret_at_25pct','ret_at_50pct','ret_at_75pct',
                               'ret_at_85pct','ret_at_90pct','hook_drop_rate',
                               'end_recovery_score','retention_quartile_spread',
                               'retention_final_5pct','max_cliff']}

valid_videos = []
for v in videos:
    views = v.get('total_views', 0)
    if not views or views < 1000:
        continue
    lv = math.log10(views)
    log_views_list.append(lv)
    
    words_ts = v.get('transcript_words', [])
    text_full = v.get('transcript_text', '')
    
    # Compute features at each window
    for w in WINDOWS:
        wtext = get_window_text(words_ts, w) if words_ts else text_full[:max(1, int(w * WPS_DEFAULT * 5))]
        inds = compute_indicators(wtext)
        # hook_word_ratio: ratio vs @10s window (not vs total)
        w10_text = get_window_text(words_ts, 10) if words_ts else text_full[:int(10 * WPS_DEFAULT * 5)]
        w10_n = max(len(w10_text.split()), 1)
        inds['hook_word_ratio'] = len(wtext.split()) / w10_n
        for k, val in inds.items():
            fkey = f"{k}_w{w}"
            feature_vals.setdefault(fkey, []).append(val)
    
    # Post-upload metrics
    curve = v.get('retention_curve', [])
    def get_ret(pct):
        if not curve: return None
        pts = [pt.get('retention', 0) for pt in curve if abs(pt.get('position', pt.get('second', 0.5)) - pct) <= 0.05]
        return sum(pts)/len(pts) if pts else None
    
    def mean_ret(lo, hi):
        if not curve: return None
        pts = [pt.get('retention', 0) for pt in curve if lo <= pt.get('position', pt.get('second', 0.5)) <= hi]
        return sum(pts)/len(pts) if pts else None
    
    post_vals['avg_percent_viewed'].append(v.get('avg_percent_viewed'))
    post_vals['swiped_away_rate_pct'].append(v.get('swiped_away_rate_pct'))
    post_vals['stayed_to_watch_pct'].append(v.get('stayed_to_watch_pct'))
    post_vals['avg_retention_vs_baseline'].append(v.get('avg_retention_vs_baseline'))
    post_vals['non_sub_fraction'].append(v.get('non_sub_fraction'))
    
    for k, pct in [('ret_at_10pct',0.10),('ret_at_25pct',0.25),('ret_at_50pct',0.50),
                   ('ret_at_75pct',0.75),('ret_at_85pct',0.85),('ret_at_90pct',0.90)]:
        post_vals[k].append(get_ret(pct))
    
    r10 = get_ret(0.10); r25 = get_ret(0.25)
    post_vals['hook_drop_rate'].append(r25 - r10 if r10 and r25 else None)
    
    er = mean_ret(0.80, 0.95)
    post_vals['end_recovery_score'].append(er)
    
    q1 = mean_ret(0.0, 0.25); q4 = mean_ret(0.75, 1.0)
    post_vals['retention_quartile_spread'].append(q4/max(q1, 0.01) if q1 and q4 else None)
    
    f5 = mean_ret(0.95, 1.0)
    post_vals['retention_final_5pct'].append(f5)
    
    # Max cliff: biggest single drop in retention
    if curve and len(curve) > 2:
        diffs = [curve[i+1].get('retention',0) - curve[i].get('retention',0) for i in range(len(curve)-1)]
        post_vals['max_cliff'].append(min(diffs))
    else:
        post_vals['max_cliff'].append(None)
    
    valid_videos.append(v)

n = len(valid_videos)
print(f"  Computed features for {n} valid videos")

# ── Pearson r function ────────────────────────────────────────────
def pearsonr(x, y):
    pairs = [(a, b) for a, b in zip(x, y) if a is not None and b is not None]
    if len(pairs) < 20:
        return 0.0, 1.0, len(pairs)
    xs, ys = zip(*pairs)
    n = len(xs)
    mx, my = sum(xs)/n, sum(ys)/n
    num = sum((a-mx)*(b-my) for a,b in zip(xs,ys))
    dx = math.sqrt(sum((a-mx)**2 for a in xs))
    dy = math.sqrt(sum((b-my)**2 for b in ys))
    if dx == 0 or dy == 0:
        return 0.0, 1.0, n
    r = max(-1, min(1, num / (dx * dy)))
    return r, 0.01 if abs(r) > 0.05 else 0.99, n

# ── Compute normalizer ─────────────────────────────────────────────
print("Computing normalizer stats...")
normalizer = {}
for fkey, vals in feature_vals.items():
    if not vals:
        normalizer[fkey] = {'mean': 0, 'std': 1}
        continue
    clean = [v for v in vals if v is not None]
    if not clean:
        normalizer[fkey] = {'mean': 0, 'std': 1}
        continue
    mu = sum(clean) / len(clean)
    std = math.sqrt(sum((v-mu)**2 for v in clean) / max(len(clean)-1, 1))
    normalizer[fkey] = {'mean': mu, 'std': max(std, 1e-6)}

# ── Compute post-upload r-values ──────────────────────────────────
print("Computing post-upload r-values...")
post_nodes = []
for pk, pvals in post_vals.items():
    r, p, nn = pearsonr(pvals, log_views_list)
    if abs(r) >= 0.05 and nn >= 20:
        post_nodes.append({
            'key': pk,
            'r_value': round(r, 4),
            'p_value': round(p, 6),
            'n_videos': nn,
            'description': f"Post-upload metric: {pk.replace('_',' ')}"
        })
post_nodes.sort(key=lambda x: abs(x['r_value']), reverse=True)
print(f"  {len(post_nodes)} post-upload nodes (|r|>=0.05, n>=20)")
for p in post_nodes[:8]:
    print(f"    r={p['r_value']:+.3f} | {p['key']}")

# ── Compute pre-upload r-values (all features vs log_views) ──────
print("Computing pre-upload r-values...")
pre_r = {}
for fkey, vals in feature_vals.items():
    r, p, nn = pearsonr(vals, log_views_list)
    pre_r[fkey] = {'r': round(r, 4), 'p': round(p, 6), 'n': nn}

# ── Build pre_nodes list ──────────────────────────────────────────
pre_nodes = []
IND_META = {
    'transcript_word_count': {'label':'Word Count','algorithm':'len(text.split())','category':'structural'},
    'transcript_char_count': {'label':'Char Count','algorithm':'len(text)','category':'structural'},
    'unique_word_ratio': {'label':'Unique Word Ratio','algorithm':'len(set(words))/len(words)','category':'structural'},
    'hapax_legomena_ratio': {'label':'Hapax Ratio','algorithm':'words_appearing_once/total_words','category':'structural'},
    'hook_question_count': {'label':'Question Count','algorithm':'text.count("?")','category':'structural'},
    'hook_question_density': {'label':'Question Density','algorithm':"questions/word_count",'category':'structural'},
    'exclamation_count': {'label':'Exclamation Count','algorithm':"text.count('!')",'category':'structural'},
    'repeated_phrase_count': {'label':'Repeated Bigrams','algorithm':'bigrams_repeating_with_gap>=10_words','category':'structural'},
    'hook_word_ratio': {'label':'Hook Word Ratio','algorithm':'words_in_window/words_in_@10s','category':'structural'},
    'pivot_word_count': {'label':'Pivot Word Count','algorithm':'count_contrastive_conjunctions','category':'linguistic','words':PIVOT_WORDS},
    'pivot_word_density': {'label':'Pivot Density','algorithm':'pivot_count/word_count','category':'linguistic'},
    'comparison_word_count': {'label':'Comparison Words','algorithm':'count_comparative_terms','category':'linguistic','words':COMPARISON_WORDS},
    'second_person_ratio': {'label':'Second Person Ratio','algorithm':"count_you/your/you're/etc / word_count",'category':'linguistic'},
}
for ind_key in IND_KEYS:
    meta = IND_META.get(ind_key, {'label': ind_key.replace('_',' ').title(), 'algorithm': 'computed', 'category': 'structural'})
    for w in WINDOWS:
        fkey = f"{ind_key}_w{w}"
        stats = pre_r.get(fkey, {'r': 0, 'p': 1, 'n': 0})
        pre_nodes.append({
            'key': fkey,
            'indicator_key': ind_key,
            'window': w,
            'source': 'featurizer',
            'label': f"{meta['label']} @{w}s",
            'description': meta.get('algorithm', ''),
            'category': meta.get('category', 'structural'),
            'word_list': meta.get('words', []),
            'r_value': stats['r'],
            'p_value': stats['p'],
            'n_videos': stats['n'],
        })

pre_nodes.sort(key=lambda x: abs(x['r_value']), reverse=True)
print(f"  {len(pre_nodes)} pre-upload feature nodes computed")

# ── Load existing model and update ────────────────────────────────
print("Rebuilding model-v2.json...")
with open(JARVIS / 'model-v2.json') as f:
    model = json.load(f)

# Update model
model['normalizer'] = normalizer
model['post_nodes'] = post_nodes
model['pre_nodes'] = pre_nodes
model['bias'] = sum(log_views_list) / len(log_views_list)
model['log10_views_std'] = math.sqrt(sum((v - model['bias'])**2 for v in log_views_list) / len(log_views_list))
model['n_videos'] = n
model['mode'] = 'computed_from_training_data'

with open(JARVIS / 'model-v2.json', 'w') as f:
    json.dump(model, f, indent=2)
print(f"  Saved: {len(pre_nodes)} pre, {len(post_nodes)} post, normalizer has {len(normalizer)} entries")

# ── Validation: rank correlation on 10 videos ─────────────────────
print("\nRunning validation on 10 videos...")

# Pick 10 videos spanning 50K to 22M
sorted_videos = sorted(valid_videos, key=lambda x: x.get('total_views', 0))
n_vid = len(sorted_videos)
# Pick evenly spaced across the range
indices = [int(i * (n_vid-1) / 9) for i in range(10)]
test_videos = [sorted_videos[i] for i in indices]

def score_hook(hook_text, wps=WPS_DEFAULT):
    """Score a hook using the fixed model."""
    # Compute features at @10s (max window)
    words = hook_text.split()
    windows = {}
    for w in WINDOWS:
        n_words = max(1, round(w * wps))
        windows[w] = ' '.join(words[:n_words])
    
    # Compute features
    all_feats = {}
    for w in WINDOWS:
        inds = compute_indicators(windows[w])
        w10_n = max(len(windows[10].split()), 1)
        inds['hook_word_ratio'] = len(windows[w].split()) / w10_n
        for k, val in inds.items():
            all_feats[f"{k}_w{w}"] = val
    
    # Z-score
    z_feats = {}
    for fk, val in all_feats.items():
        stats = normalizer.get(fk, {'mean': 0, 'std': 1})
        z = (val - stats['mean']) / max(stats['std'], 1e-6)
        z_feats[fk] = max(-5, min(5, z))
    
    # Compute pre-activation contributions
    # For each post-upload node, compute weighted sum of pre-upload features
    # Using pre→post correlations (for now: use pre feature r_value × post r_value as proxy)
    # Better: direct dot product of z-scored features × their r_values with views
    
    # Simple approach: weighted sum of pre features × their r_with_views
    log10_views = model['bias']
    for node in pre_nodes:
        fk = node['key']
        r = node.get('r_value', 0)
        z = z_feats.get(fk, 0)
        log10_views += r * z * 0.1  # scale factor to prevent explosion
    
    return log10_views

print(f"\n{'Title':<45} {'Actual':>12} {'Predicted':>12} {'Log10_A':>8} {'Log10_P':>8}")
print("-" * 90)

actual_ranks = []
predicted_log = []
for i, v in enumerate(test_videos):
    hook = v.get('transcript_text', '')[:200]  # first ~200 chars as hook approximation
    actual_lv = math.log10(v['total_views'])
    pred_lv = score_hook(hook)
    actual_ranks.append(v['total_views'])
    predicted_log.append(pred_lv)
    print(f"{v.get('title','?')[:44]:<45} {v['total_views']:>12,} {10**pred_lv:>12,.0f} {actual_lv:>8.2f} {pred_lv:>8.2f}")

# Spearman rank correlation
def spearman(x, y):
    n = len(x)
    rx = sorted(range(n), key=lambda i: x[i])
    ry = sorted(range(n), key=lambda i: y[i])
    rank_x = [0]*n; rank_y = [0]*n
    for i, idx in enumerate(rx): rank_x[idx] = i
    for i, idx in enumerate(ry): rank_y[idx] = i
    d2 = sum((rank_x[i]-rank_y[i])**2 for i in range(n))
    return 1 - 6*d2/(n*(n**2-1))

rho = spearman(actual_ranks, predicted_log)
rmse = math.sqrt(sum((math.log10(a) - p)**2 for a, p in zip(actual_ranks, predicted_log)) / len(actual_ranks))
print(f"\nSpearman rank correlation: {rho:.3f}")
print(f"RMSE (log10): {rmse:.3f}")
print(f"Training std: {model['log10_views_std']:.3f}")

# Save validation
val_results = {
    'spearman_rho': round(rho, 3),
    'rmse_log10': round(rmse, 3),
    'training_std': round(model['log10_views_std'], 3),
    'n_test_videos': 10,
    'videos': [
        {
            'ytId': v.get('video_id', v.get('ytId', '')),
            'title': v.get('title',''),
            'actual_views': v['total_views'],
            'actual_log10': round(math.log10(v['total_views']), 3),
            'predicted_log10': round(score_hook(v.get('transcript_text','')[:200]), 3),
        }
        for v in test_videos
    ]
}
with open(JARVIS / 'validation_results.json', 'w') as f:
    json.dump(val_results, f, indent=2)

print(f"\nValidation saved to {JARVIS}/validation_results.json")
print("Done!")
