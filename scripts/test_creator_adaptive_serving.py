#!/usr/bin/env python3
"""Verify live causal serving equals the locked prequential formula."""

import importlib.util
import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


benchmark = load(
    'causal_keep_benchmark_test',
    ROOT / 'scripts/benchmark-causal-keep-mixture.py',
)
builder = load(
    'causal_keep_serving_builder_test',
    ROOT / 'scripts/build-creator-adaptive-serving.py',
)
serving = load(
    'causal_keep_serving_test',
    ROOT / 'creator_adaptive_keep.py',
)
predictor = benchmark.load_predictor()
rows, visual, together = benchmark.load_canonical_data(predictor)
model = json.loads(builder.MODEL_PATH.read_text(encoding='utf-8'))

latest_timestamp = max(float(row['publishedAt']) for row in rows)
query_index = next(
    index
    for index, row in enumerate(rows)
    if float(row['publishedAt']) == latest_timestamp
)
query_row = rows[query_index]
prefix_indices = [
    index
    for index, row in enumerate(rows)
    if float(row['publishedAt']) < latest_timestamp
]
prefix_rows = [rows[index] for index in prefix_indices]
prefix_visual = visual[prefix_indices]
prefix_together = together[prefix_indices]
artifact, _ = builder.build_state(
    benchmark,
    prefix_rows,
    prefix_visual,
    prefix_together,
    model,
)
artifact_replay, _ = builder.build_state(
    benchmark,
    prefix_rows,
    prefix_visual,
    prefix_together,
    model,
)
assert artifact == artifact_replay
state = serving.load_serving_state(artifact)
served = serving.score_creator_adaptive_keep(
    state,
    visual[query_index],
    together[query_index],
    query_row['account'],
)

direct_rows = prefix_rows + [query_row]
direct_visual = np.vstack([prefix_visual, visual[query_index]])
direct_together = np.vstack([prefix_together, together[query_index]])
context = benchmark.build_context(direct_rows)
experts, baseline, _ = benchmark.build_experts(
    direct_rows,
    direct_visual,
    direct_together,
    context,
    freeze_final=False,
)
direct = benchmark.reconstruct_locked_predictions(
    direct_rows,
    context,
    experts,
    baseline,
    (model.get('formula') or {}).get('lockedFormula'),
    freeze_final=False,
)
expected = float(direct['winner'][-1])
assert abs(served['raw'] - expected) < 2e-4, (
    served['raw'],
    expected,
)
assert served['profile_account'] == query_row['account']
assert served['history_n'] >= 8

production = serving.load_serving_state(builder.OUTPUT_PATH.read_bytes())
first = serving.score_creator_adaptive_keep(
    production,
    visual[query_index],
    together[query_index],
    'tyler',
)
second = serving.score_creator_adaptive_keep(
    production,
    visual[query_index],
    together[query_index],
    'tyler',
)
assert first == second
try:
    serving.score_creator_adaptive_keep(
        production,
        visual[query_index],
        together[query_index],
        'not-a-profile',
    )
except RuntimeError:
    pass
else:
    raise AssertionError('unknown creator profile was accepted')

print(json.dumps({
    'ok': True,
    'query': query_row['id'],
    'profile': query_row['account'],
    'served': served['raw'],
    'direct': expected,
    'difference': served['raw'] - expected,
    'productionReplay': first['raw'],
}, indent=2))
