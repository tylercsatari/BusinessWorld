#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
    COORDINATE_ID,
    validateCreatorAdaptiveKeepForecast,
} = require(
    '../buildings/jarvis/creator-adaptive-keep-forecast-contract'
);

const sha = label => crypto.createHash('sha256')
    .update(`creator-contract:${label}`)
    .digest('hex');
const servingArtifact = sha('serving-artifact');
const modelArtifact = sha('model-artifact');
const forecast = {
    coordinate_id: COORDINATE_ID,
    est: 72.5,
    raw: 72.5,
    pctile: null,
    kind: 'keep_rate_percent',
    unit: 'percent',
    calibration_scope: 'creator_profile_snapshot',
    profile_account: 'tyler',
    history_only_baseline: 68,
    history_n: 8,
    history_video_ids: Array.from(
        { length: 8 },
        (_, index) => `prior-${index}`
    ),
    history_end: 1234567890,
    component_a: 71,
    component_b: 74,
    model_formula: '0.5 * component_a + 0.5 * component_b',
    candidate_count: 43360,
    candidate_registry_sha256: sha('candidate-registry'),
    forecast_scope: 'future_upload_after_profile_history',
    historical_replay_valid: false,
    predictor_eligible: false,
    research_only: true,
    source: 'live_creator_profile_shadow_score',
    serving_artifact_sha256: servingArtifact,
    serving_artifact_key:
        `raw/predictor-lab/creator-adaptive-keep-serving/by-sha256/${servingArtifact}.npz`,
    serving_artifact_canonical_key:
        'raw/predictor-lab/creator-adaptive-keep-serving-v1.npz',
    serving_manifest_sha256: sha('serving-manifest'),
    serving_manifest_key:
        'raw/predictor-lab/creator-adaptive-keep-serving-v1.manifest.json',
    serving_producer_source_sha256: sha('serving-producer'),
    serving_scorer_source_sha256: sha('serving-scorer'),
    model_artifact_sha256: modelArtifact,
    model_artifact_key:
        `raw/predictor-lab/creator-adaptive-keep-model/by-sha256/${modelArtifact}.json`,
    model_artifact_canonical_key:
        'raw/predictor-lab/creator-adaptive-keep-model-v1.json',
    model_manifest_sha256: sha('model-manifest'),
    model_manifest_key:
        'raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json',
    model_producer_source_sha256: sha('model-producer'),
    feature_contract_version: 10,
    feature_contract_sha256: sha('feature-contract'),
    input:
        'canonical visual embedding + canonical together embedding + registered strictly-earlier creator profile history',
};
const expected = {
    coordinateId: COORDINATE_ID,
    profileAccount: 'tyler',
    servingArtifactSha256: servingArtifact,
    servingManifestSha256: forecast.serving_manifest_sha256,
    servingProducerSourceSha256:
        forecast.serving_producer_source_sha256,
    servingScorerSourceSha256:
        forecast.serving_scorer_source_sha256,
    modelArtifactSha256: modelArtifact,
    modelManifestSha256: forecast.model_manifest_sha256,
    modelProducerSourceSha256:
        forecast.model_producer_source_sha256,
    featureContractVersion: 10,
    featureContractSha256: forecast.feature_contract_sha256,
    candidateRegistrySha256:
        forecast.candidate_registry_sha256,
};

assert.strictEqual(
    validateCreatorAdaptiveKeepForecast(forecast, expected).valid,
    true
);
[
    ['profile mismatch', { profile_account: 'hafu' }],
    ['historical substitution', {
        forecast_scope: 'historical_row_prequential',
        historical_replay_valid: true,
    }],
    ['mutable serving key', {
        serving_artifact_key:
            'raw/predictor-lab/creator-adaptive-keep-serving-v1.npz',
    }],
    ['history overlap ambiguity', {
        history_video_ids: Array.from(
            { length: 8 },
            () => 'same-video'
        ),
    }],
    ['missing producer revision', {
        serving_scorer_source_sha256: null,
    }],
    ['silent output disagreement', { est: 73 }],
].forEach(([label, mutation]) => {
    assert.strictEqual(
        validateCreatorAdaptiveKeepForecast(
            { ...forecast, ...mutation },
            expected
        ).valid,
        false,
        label
    );
});

console.log('creator-adaptive keep forecast contract tests passed');
