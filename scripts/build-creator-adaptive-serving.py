#!/usr/bin/env python3
"""Build and optionally publish the immutable live serving state for causal keep v1."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_PATH = ROOT / 'scripts/benchmark-causal-keep-mixture.py'
SCORER_PATH = ROOT / 'creator_adaptive_keep.py'
MODEL_PATH = (
    ROOT
    / 'buildings/jarvis/predictor-lab/creator-adaptive-keep-model-v1.json'
)
OUTPUT_PATH = (
    ROOT
    / 'buildings/jarvis/predictor-lab/creator-adaptive-keep-serving-v1.npz'
)
MANIFEST_PATH = (
    ROOT
    / 'buildings/jarvis/predictor-lab/'
    'creator-adaptive-keep-serving-v1.manifest.json'
)
CANONICAL_KEY = (
    'raw/predictor-lab/creator-adaptive-keep-serving-v1.npz'
)
MANIFEST_KEY = (
    'raw/predictor-lab/creator-adaptive-keep-serving-v1.manifest.json'
)
COORDINATE_ID = 'shorts.creator-adaptive-keep.v1'


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError(f'could not load {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_json(value) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(',', ':'),
        ensure_ascii=True,
        allow_nan=False,
    ).encode()


def deterministic_npz(arrays) -> bytes:
    """Serialize arrays without ZIP timestamps so equal inputs hash equally."""
    output = io.BytesIO()
    with zipfile.ZipFile(
        output,
        mode='w',
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for name, value in arrays:
            encoded = io.BytesIO()
            np.lib.format.write_array(
                encoded,
                np.asarray(value),
                allow_pickle=False,
            )
            member = zipfile.ZipInfo(
                filename=f'{name}.npy',
                date_time=(1980, 1, 1, 0, 0, 0),
            )
            member.compress_type = zipfile.ZIP_DEFLATED
            member.external_attr = 0o600 << 16
            archive.writestr(
                member,
                encoded.getvalue(),
                compress_type=zipfile.ZIP_DEFLATED,
                compresslevel=9,
            )
    return output.getvalue()


def build_state(benchmark, rows, visual, together, model):
    context = benchmark.build_context(rows)
    experts, baseline, history_scale = benchmark.build_experts(
        rows,
        visual,
        together,
        context,
        freeze_final=False,
    )
    locked = (model.get('formula') or {}).get('lockedFormula') or {}
    predictions = benchmark.reconstruct_locked_predictions(
        rows,
        context,
        experts,
        baseline,
        locked,
        freeze_final=False,
    )
    centered_visual = benchmark.make_causal_centered(visual, context)
    centered_together = benchmark.make_causal_centered(together, context)
    aliases = benchmark.aliased_experts(experts)
    stage3_features, feature_names = benchmark.feature_matrix(
        aliases,
        baseline,
        'semanticWide',
    )
    if tuple(feature_names) != (
        'ct12', 'ct24', 'ct48', 'cc12',
        'cv12', 'cv24', 'krrTogether', 'krrVisual',
    ):
        raise RuntimeError('the selected stage-three feature order changed')
    outcomes = context['outcomes']
    source_valid = np.isfinite(baseline) & np.isfinite(history_scale)
    complete = source_valid & np.all(np.isfinite(stage3_features), axis=1)
    x_train = stage3_features[complete]
    x_mean = np.mean(x_train, axis=0)
    x_std = np.maximum(np.std(x_train, axis=0), 0.5)
    standardized = (x_train - x_mean) / x_std
    target = outcomes[complete] - baseline[complete]
    y_mean = float(np.mean(target))
    centered_target = target - y_mean
    system = standardized.T @ standardized + np.eye(standardized.shape[1])
    try:
        weights = np.linalg.solve(
            system,
            standardized.T @ centered_target,
        )
    except np.linalg.LinAlgError:
        weights = np.linalg.lstsq(
            system,
            standardized.T @ centered_target,
            rcond=None,
        )[0]
    weights = np.clip(weights, -3.0, 3.0)

    account_ids = sorted(context['orders'], key=benchmark.stable_hash)
    max_history = 30
    profile_visual = np.zeros(
        (len(account_ids), max_history, visual.shape[1]),
        dtype=np.float32,
    )
    profile_together = np.zeros_like(profile_visual)
    profile_outcomes = np.full(
        (len(account_ids), max_history),
        np.nan,
        dtype=np.float32,
    )
    profile_counts = np.zeros(len(account_ids), dtype=np.int32)
    profile_mean_visual = np.zeros(
        (len(account_ids), visual.shape[1]),
        dtype=np.float32,
    )
    profile_mean_together = np.zeros_like(profile_mean_visual)
    profile_baseline = np.zeros(len(account_ids), dtype=np.float32)
    profile_scale = np.zeros(len(account_ids), dtype=np.float32)
    profile_stage2_bias = np.zeros(len(account_ids), dtype=np.float32)
    profiles = {}
    component_a = predictions['componentA']
    for account_index, account in enumerate(account_ids):
        order = context['orders'][account]
        history = order[-min(max_history, len(order)):]
        count = len(history)
        if count < 8:
            raise RuntimeError(f'{account} has fewer than eight history rows')
        profile_counts[account_index] = count
        profile_visual[account_index, :count] = visual[history]
        profile_together[account_index, :count] = together[history]
        profile_outcomes[account_index, :count] = outcomes[history]
        profile_mean_visual[account_index] = np.mean(visual[order], axis=0)
        profile_mean_together[account_index] = np.mean(
            together[order],
            axis=0,
        )
        profile_baseline[account_index] = np.mean(outcomes[history])
        profile_scale[account_index] = max(
            float(np.std(outcomes[history])),
            4.0,
        )
        valid = order[
            np.isfinite(component_a[order])
            & np.isfinite(baseline[order])
        ]
        recent = valid[-min(12, len(valid)):]
        profile_stage2_bias[account_index] = (
            float(np.mean(outcomes[recent] - component_a[recent]))
            if len(recent) else 0.0
        )
        sample = rows[int(order[-1])]
        profiles[account] = {
            'name': str(sample.get('accountName') or account),
            'historyN': count,
            'historyVideoIds': [
                str(rows[int(index)]['id']) for index in history
            ],
            'historyThrough': float(
                max(context['timestamps'][history])
            ),
        }

    model_bytes = MODEL_PATH.read_bytes()
    metadata = {
        'schema': 'creator-adaptive-keep-serving-v1',
        'coordinateId': COORDINATE_ID,
        'generatedAt': int(model.get('generatedAt') or 0),
        'generatedAtSource': 'locked creator-adaptive model artifact',
        'modelArtifactSha256': hashlib.sha256(model_bytes).hexdigest(),
        'modelSchemaVersion': model.get('schemaVersion'),
        'modelProducerSourceSha256': model.get('producerSourceSha256'),
        'featureContractVersion': model.get('featureContractVersion'),
        'featureContractSha256': model.get('featureContractSha256'),
        'benchmark': model.get('benchmark'),
        'candidateRegistrySha256': (
            (model.get('selection') or {}).get('candidateRegistrySha256')
        ),
        'candidateCount': (
            (model.get('selection') or {}).get('candidateCount')
        ),
        'featureNames': list(feature_names),
        'formula': locked,
        'populationN': len(rows),
        'referenceN': int(np.sum(source_valid)),
        'stage3TrainingN': int(np.sum(complete)),
        'profiles': profiles,
        'producer': 'scripts/build-creator-adaptive-serving.py',
        'producerSourceSha256': hashlib.sha256(
            Path(__file__).read_bytes()
        ).hexdigest(),
        'servingScorerSourceSha256': hashlib.sha256(
            SCORER_PATH.read_bytes()
        ).hexdigest(),
        'determinism': (
            'The artifact stores the exact causal reference vectors, '
            'strictly-earlier profile histories, stage-two bias state, '
            'and final global stage-three Ridge state.'
        ),
    }
    artifact = deterministic_npz([
        ('metadata_json', np.asarray([
            canonical_json(metadata).decode('ascii')
        ])),
        ('reference_centered_visual', np.asarray(
            centered_visual[source_valid],
            dtype=np.float32,
        )),
        ('reference_centered_together', np.asarray(
            centered_together[source_valid],
            dtype=np.float32,
        )),
        ('reference_standardized_residual', np.asarray(
            (
                outcomes[source_valid] - baseline[source_valid]
            ) / history_scale[source_valid],
            dtype=np.float32,
        )),
        ('stage3_mean', np.asarray(x_mean, dtype=np.float64)),
        ('stage3_std', np.asarray(x_std, dtype=np.float64)),
        ('stage3_weights', np.asarray(weights, dtype=np.float64)),
        ('stage3_y_mean', np.asarray([y_mean], dtype=np.float64)),
        ('profile_ids', np.asarray(account_ids)),
        ('profile_counts', profile_counts),
        ('profile_visual', profile_visual),
        ('profile_together', profile_together),
        ('profile_outcomes', profile_outcomes),
        ('profile_mean_visual', profile_mean_visual),
        ('profile_mean_together', profile_mean_together),
        ('profile_baseline', profile_baseline),
        ('profile_scale', profile_scale),
        ('profile_stage2_bias', profile_stage2_bias),
    ])
    return artifact, metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    benchmark = load_module('causal_keep_benchmark', BENCHMARK_PATH)
    scorer = load_module('creator_adaptive_keep_serving', SCORER_PATH)
    predictor = benchmark.load_predictor()
    rows, visual, together = benchmark.load_canonical_data(predictor)
    model = json.loads(MODEL_PATH.read_text(encoding='utf-8'))
    if model.get('coordinateId') != COORDINATE_ID:
        raise RuntimeError('creator-adaptive model coordinate changed')
    locked_benchmark = model.get('benchmark') or {}
    benchmark_artifact = ROOT / str(
        locked_benchmark.get('artifactPath') or ''
    )
    if (
        not benchmark_artifact.is_file()
        or hashlib.sha256(benchmark_artifact.read_bytes()).hexdigest()
        != locked_benchmark.get('artifactSha256')
    ):
        raise RuntimeError(
            'the locked benchmark artifact is missing or has changed'
        )
    actual_fingerprints = benchmark.dataset_fingerprints(
        rows,
        visual,
        together,
    )
    if actual_fingerprints != (
        locked_benchmark.get('datasetFingerprints') or {}
    ):
        raise RuntimeError(
            'current rows or embedding matrices do not match the '
            'locked benchmark fingerprints'
        )
    artifact, metadata = build_state(
        benchmark,
        rows,
        visual,
        together,
        model,
    )
    state = scorer.load_serving_state(artifact)
    smoke = {
        profile: scorer.score_creator_adaptive_keep(
            state,
            visual[-1],
            together[-1],
            profile,
        )['raw']
        for profile in state['profile_ids']
    }
    artifact_sha256 = hashlib.sha256(artifact).hexdigest()
    archive_key = (
        'raw/predictor-lab/creator-adaptive-keep-serving/by-sha256/'
        f'{artifact_sha256}.npz'
    )
    manifest = {
        'schemaVersion': 1,
        'coordinateId': COORDINATE_ID,
        'artifactSha256': artifact_sha256,
        'canonicalKey': CANONICAL_KEY,
        'archiveKey': archive_key,
        'generatedAt': metadata['generatedAt'],
        'modelArtifactSha256': metadata['modelArtifactSha256'],
        'producer': metadata['producer'],
        'producerSourceSha256': metadata['producerSourceSha256'],
        'servingScorerSourceSha256': metadata[
            'servingScorerSourceSha256'
        ],
        'featureContractVersion': metadata['featureContractVersion'],
        'featureContractSha256': metadata['featureContractSha256'],
        'profiles': sorted(metadata['profiles']),
        'populationN': metadata['populationN'],
        'referenceN': metadata['referenceN'],
        'stage3TrainingN': metadata['stage3TrainingN'],
    }
    OUTPUT_PATH.write_bytes(artifact)
    MANIFEST_PATH.write_bytes(canonical_json(manifest) + b'\n')
    if args.publish:
        predictor.put_bytes(archive_key, artifact, 'application/octet-stream')
        predictor.put_bytes(
            CANONICAL_KEY,
            artifact,
            'application/octet-stream',
        )
        predictor.put_bytes(
            MANIFEST_KEY,
            canonical_json(manifest),
            'application/json',
        )
    print(json.dumps({
        'ok': True,
        'artifact': str(OUTPUT_PATH),
        'manifest': str(MANIFEST_PATH),
        'artifactSha256': artifact_sha256,
        'bytes': len(artifact),
        'profiles': sorted(metadata['profiles']),
        'smokePredictions': smoke,
        'published': args.publish,
    }, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        raise
