"""Deterministic serving math for the governed creator keep coordinate."""

import io
import json

import numpy as np

from shorts_score_ledger import GOVERNANCE


EPSILON = 1e-9
COORDINATE_ID = GOVERNANCE['coordinates'][
    'creatorAdaptiveKeepForecast'
]['id']
FEATURE_NAMES = (
    'ct12',
    'ct24',
    'ct48',
    'cc12',
    'cv12',
    'cv24',
    'krrTogether',
    'krrVisual',
)


def _normalized(vector):
    value = np.asarray(vector, dtype=np.float64).reshape(-1)
    return value / (np.linalg.norm(value) + EPSILON)


def load_serving_state(value):
    archive = np.load(io.BytesIO(value), allow_pickle=False)
    metadata = json.loads(str(np.asarray(archive['metadata_json']).reshape(-1)[0]))
    if metadata.get('schema') != 'creator-adaptive-keep-serving-v1':
        raise RuntimeError('creator-adaptive serving state has the wrong schema')
    if metadata.get('coordinateId') != COORDINATE_ID:
        raise RuntimeError('creator-adaptive serving coordinate is incompatible')
    if tuple(metadata.get('featureNames') or ()) != FEATURE_NAMES:
        raise RuntimeError('creator-adaptive serving feature order is incompatible')
    return {
        'metadata': metadata,
        'reference_centered_visual': np.asarray(
            archive['reference_centered_visual'],
            dtype=np.float64,
        ),
        'reference_centered_together': np.asarray(
            archive['reference_centered_together'],
            dtype=np.float64,
        ),
        'reference_standardized_residual': np.asarray(
            archive['reference_standardized_residual'],
            dtype=np.float64,
        ),
        'stage3_mean': np.asarray(archive['stage3_mean'], dtype=np.float64),
        'stage3_std': np.asarray(archive['stage3_std'], dtype=np.float64),
        'stage3_weights': np.asarray(
            archive['stage3_weights'],
            dtype=np.float64,
        ),
        'stage3_y_mean': float(np.asarray(archive['stage3_y_mean']).reshape(-1)[0]),
        'profile_ids': [
            str(value)
            for value in np.asarray(archive['profile_ids']).reshape(-1)
        ],
        'profile_counts': np.asarray(archive['profile_counts'], dtype=np.int64),
        'profile_visual': np.asarray(archive['profile_visual'], dtype=np.float64),
        'profile_together': np.asarray(
            archive['profile_together'],
            dtype=np.float64,
        ),
        'profile_outcomes': np.asarray(
            archive['profile_outcomes'],
            dtype=np.float64,
        ),
        'profile_mean_visual': np.asarray(
            archive['profile_mean_visual'],
            dtype=np.float64,
        ),
        'profile_mean_together': np.asarray(
            archive['profile_mean_together'],
            dtype=np.float64,
        ),
        'profile_baseline': np.asarray(
            archive['profile_baseline'],
            dtype=np.float64,
        ),
        'profile_scale': np.asarray(archive['profile_scale'], dtype=np.float64),
        'profile_stage2_bias': np.asarray(
            archive['profile_stage2_bias'],
            dtype=np.float64,
        ),
    }


def _weighted_knn(similarity, targets, neighbors):
    count = min(int(neighbors), len(similarity))
    if count <= 0:
        raise RuntimeError('creator-adaptive serving reference set is empty')
    local = np.argpartition(similarity, -count)[-count:]
    chosen = similarity[local]
    weights = np.exp(np.clip(15.0 * (chosen - np.max(chosen)), -60, 0))
    return float(np.sum(weights * targets[local]) / (np.sum(weights) + EPSILON))


def _kernel_ridge(train_vectors, outcomes, query, alpha=0.1):
    gram = train_vectors @ train_vectors.T
    train_mean = float(np.mean(outcomes))
    centered = outcomes - train_mean
    system = gram + float(alpha) * np.eye(len(train_vectors))
    try:
        weights = np.linalg.solve(system, centered)
    except np.linalg.LinAlgError:
        weights = np.linalg.lstsq(system, centered, rcond=None)[0]
    return float(train_mean + (query @ train_vectors.T) @ weights)


def score_creator_adaptive_keep(state, visual, together, profile):
    profile_id = str(profile or '').strip().lower()
    if profile_id not in state['profile_ids']:
        raise RuntimeError(
            f'creator profile {profile_id or "(blank)"} is not registered'
        )
    profile_index = state['profile_ids'].index(profile_id)
    count = int(state['profile_counts'][profile_index])
    if count < 8:
        raise RuntimeError(
            f'creator profile {profile_id} has only {count} prior labels; 8 required'
        )
    visual_query = _normalized(visual)
    together_query = _normalized(together)
    centered_visual = _normalized(
        visual_query - state['profile_mean_visual'][profile_index]
    )
    centered_together = _normalized(
        together_query - state['profile_mean_together'][profile_index]
    )
    visual_similarity = (
        state['reference_centered_visual'] @ centered_visual
    )
    together_similarity = (
        state['reference_centered_together'] @ centered_together
    )
    combined_similarity = 0.5 * (
        visual_similarity + together_similarity
    )
    residual = state['reference_standardized_residual']
    baseline = float(state['profile_baseline'][profile_index])
    scale = float(state['profile_scale'][profile_index])

    def pooled(similarity, neighbors):
        return baseline + scale * _weighted_knn(
            similarity,
            residual,
            neighbors,
        )

    history_visual = state['profile_visual'][profile_index, :count]
    history_together = state['profile_together'][profile_index, :count]
    history_outcomes = state['profile_outcomes'][profile_index, :count]
    features = np.asarray([
        pooled(together_similarity, 12),
        pooled(together_similarity, 24),
        pooled(together_similarity, 48),
        pooled(combined_similarity, 12),
        pooled(visual_similarity, 12),
        pooled(visual_similarity, 24),
        _kernel_ridge(
            history_together,
            history_outcomes,
            together_query,
        ),
        _kernel_ridge(
            history_visual,
            history_outcomes,
            visual_query,
        ),
    ], dtype=np.float64)
    residual_features = features - baseline

    component_a = float(np.clip(
        baseline
        + 0.5 * (features[0] - baseline)
        + state['profile_stage2_bias'][profile_index],
        0,
        100,
    ))
    standardized = (
        residual_features - state['stage3_mean']
    ) / state['stage3_std']
    component_b = float(np.clip(
        baseline
        + state['stage3_y_mean']
        + standardized @ state['stage3_weights'],
        0,
        100,
    ))
    predicted = float(np.clip(
        0.5 * component_a + 0.5 * component_b,
        0,
        100,
    ))
    profile_metadata = (
        state['metadata'].get('profiles') or {}
    ).get(profile_id) or {}
    return {
        'coordinate_id': COORDINATE_ID,
        'est': round(predicted, 6),
        'raw': round(predicted, 6),
        'pctile': None,
        'kind': 'keep_rate_percent',
        'unit': 'percent',
        'profile_account': profile_id,
        'profile_account_name': profile_metadata.get('name') or profile_id,
        'history_only_baseline': round(baseline, 6),
        'history_n': count,
        'history_video_ids': profile_metadata.get('historyVideoIds') or [],
        'history_end': profile_metadata.get('historyThrough'),
        'component_a': round(component_a, 6),
        'component_b': round(component_b, 6),
        'component_a_definition': 'Centered together-embedding residual analog',
        'component_b_definition': 'Visual-plus-together semantic stack',
        'model_formula': (
            '0.5 × centered-together residual analog + '
            '0.5 × visual+together semantic stack'
        ),
        'model_history_window': 30,
        'model_minimum_history_n': 8,
        'candidate_count': 43360,
        'forecast_scope': 'future_upload_after_profile_history',
        'historical_replay_valid': False,
        'claim_boundary': (
            'Valid as a research forecast only for uploads after the '
            'profile history cutoff; use row-specific prequential values '
            'for blind historical validation.'
        ),
        'predictor_eligible': False,
        'research_only': True,
        'source': 'live_creator_profile_shadow_score',
    }
