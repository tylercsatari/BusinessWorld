"""
Generate the initial Hook Model model.json by reading indicators.json and
mapping each text-derivable pre-upload indicator to a weight = its measured r.

Also seeds feature_stats with mean=0, std=1 so the model can be scored before
train.py is run. After running train.py, model.json is overwritten with
trained weights and real per-feature mean/std.

Usage:
    python3 _gen_initial_model.py

Output:
    model.json (in this directory)
"""

import json, os, sys
from pathlib import Path

# Indicator JSON shipped with the Jarvis dataset
DATASET_INDICATORS = Path('/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset/02_jarvis_brain/indicators.json')
OUTPUT_PATH = Path(__file__).resolve().parent / 'model.json'

# Substrings in indicator keys that imply a vision-only feature; exclude those.
VISUAL_KEYS = (
    'frame', 'scene', 'visual', 'close_up', 'action_frame',
    'cluster', 'burst', 'face_frame'
)

# Time-windows used in featurizer.js
WINDOWS = [1, 3, 5, 10]

# ─────── Load indicators ───────
if not DATASET_INDICATORS.exists():
    print(f'Could not find {DATASET_INDICATORS}', file=sys.stderr)
    sys.exit(1)

with open(DATASET_INDICATORS) as f:
    raw = json.load(f)
indicators = raw['indicators']

# Phase-1 selection: pre-upload, has measured r, no visual dependency,
# |r| >= 0.05 and p <= 0.10 (the standard Jarvis thresholds).
def is_text_pre_upload(ind):
    if ind.get('layer') != 'pre':
        return False
    if ind.get('r_with_views') is None:
        return False
    if abs(ind['r_with_views']) < 0.05:
        return False
    if ind.get('p_value') is not None and ind['p_value'] > 0.10:
        return False
    key = ind['key'].lower()
    return not any(v in key for v in VISUAL_KEYS)

selected = [i for i in indicators if is_text_pre_upload(i)]
print(f'Selected {len(selected)} text-derivable pre-upload indicators with |r|>=0.05')

# Subset of indicators the JS featurizer can actually compute.
JS_FEATURIZABLE = {
    'pivot_word_count', 'sensory_count', 'open_loop_count',
    'open_loop_count_first_half', 'proof_of_work_count', 'contrast_count',
    'action_verb_count', 'repeated_phrase_count', 'unique_word_ratio',
    'hapax_legomena_ratio', 'beat_count', 'transcript_word_count',
    'transcript_char_count', 'hook_word_ratio', 'hook_phrase_diversity',
    'anticipation_escalation_position_pct',
}

# Build weights: w_{key}_w{window} = r_value for each window
weights = {}
node_meta = {}
for ind in selected:
    key = ind['key']
    if key not in JS_FEATURIZABLE:
        continue
    r = ind['r_with_views']
    p = ind.get('p_value')
    n = ind.get('experiment_n_videos')
    desc = ind.get('description') or ''
    label = ind.get('label') or key.replace('_', ' ').title()
    ci_low = ind.get('ci_low')
    ci_high = ind.get('ci_high')

    for w in WINDOWS:
        fk = f'{key}_w{w}'
        weights[fk] = r

    node_meta[key] = {
        'label': label,
        'description': desc,
        'r_with_views': r,
        'p_value': p,
        'n_videos': n,
        'ci_low': ci_low,
        'ci_high': ci_high,
        'experiment_id': ind.get('experiment_id'),
        'resolution_id': ind.get('resolution_id'),
    }

# Feature-stat placeholders so the scorer can run before training.
# After train.py, these are replaced with the real corpus mean/std.
feature_stats = {fk: {'mean': 0.0, 'std': 1.0} for fk in weights}

# Bias = mean log10(views) over the training set.
# Use the published value 6.2297 from the spec until train.py recomputes it.
BIAS = 6.2297
TRAIN_STD = 0.78  # 1 std of log10(views) in training corpus

model = {
    'mode': 'r_value_prior',
    'note': ('Weights initialized to Pearson r-values from Jarvis indicators.json. '
             'feature_stats are placeholders (mean=0, std=1) until train.py is run.'),
    'trained_at': None,
    'training_n': 372,
    'cv_r2': None,
    'bias': BIAS,
    'log10_views_std': TRAIN_STD,
    'wps_default': 4.402,
    'time_windows': WINDOWS,
    'weights': weights,
    'feature_stats': feature_stats,
    'node_meta': node_meta,
}

OUTPUT_PATH.write_text(json.dumps(model, indent=2))
print(f'Wrote {OUTPUT_PATH} with {len(weights)} weights ({len(node_meta)} indicators × {len(WINDOWS)} windows).')
