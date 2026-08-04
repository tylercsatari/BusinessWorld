'use strict';

const governance = require('./quant-coordinate-governance.json');

const COORDINATE_ID =
    governance.coordinates.creatorAdaptiveKeepForecast.id;
const MODEL_CANONICAL_KEY =
    'raw/predictor-lab/creator-adaptive-keep-model-v1.json';
const MODEL_MANIFEST_KEY =
    'raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json';
const MODEL_ARCHIVE_PREFIX =
    'raw/predictor-lab/creator-adaptive-keep-model/by-sha256/';
const SERVING_CANONICAL_KEY =
    'raw/predictor-lab/creator-adaptive-keep-serving-v1.npz';
const SERVING_MANIFEST_KEY =
    'raw/predictor-lab/creator-adaptive-keep-serving-v1.manifest.json';
const SERVING_ARCHIVE_PREFIX =
    'raw/predictor-lab/creator-adaptive-keep-serving/by-sha256/';
const SHA256_RE = /^[a-f0-9]{64}$/;

function exactSha256(value) {
    return SHA256_RE.test(String(value || '').toLowerCase());
}

function validateCreatorAdaptiveKeepForecast(value, expected = {}) {
    const errors = [];
    const add = message => errors.push(message);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            valid: false,
            errors: ['creator-adaptive keep forecast is missing'],
        };
    }
    const raw = Number(value.raw);
    const estimate = Number(value.est);
    if (value.coordinate_id !== COORDINATE_ID) {
        add('coordinate ID is not canonical');
    }
    if (value.source !== 'live_creator_profile_shadow_score') {
        add('source is not live_creator_profile_shadow_score');
    }
    if (
        value.forecast_scope
        !== 'future_upload_after_profile_history'
        || value.historical_replay_valid !== false
    ) {
        add('forecast time boundary is not a future-upload score');
    }
    if (value.calibration_scope !== 'creator_profile_snapshot') {
        add('calibration scope is not creator_profile_snapshot');
    }
    if (
        value.kind !== 'keep_rate_percent'
        || value.unit !== 'percent'
    ) {
        add('unit contract is not keep_rate_percent');
    }
    if (value.pctile !== null) {
        add('derived forecast percentile must be explicitly null');
    }
    if (
        !Number.isFinite(raw)
        || !Number.isFinite(estimate)
        || raw < 0
        || raw > 100
        || estimate < 0
        || estimate > 100
    ) {
        add('raw/estimate values are outside [0,100]');
    } else if (Math.abs(raw - estimate) > 1e-9) {
        add('raw and estimate values disagree');
    }
    const profile = String(value.profile_account || '').trim();
    if (!profile) add('creator profile is missing');
    if (
        expected.profileAccount != null
        && profile !== String(expected.profileAccount)
    ) {
        add('creator profile does not match the scored input');
    }
    const historyN = Number(value.history_n);
    if (
        !Number.isInteger(historyN)
        || historyN < 8
        || historyN > 30
    ) {
        add('strictly-earlier creator history count is outside [8,30]');
    }
    if (
        !Array.isArray(value.history_video_ids)
        || value.history_video_ids.length !== historyN
        || new Set(value.history_video_ids.map(String)).size !== historyN
    ) {
        add('creator history video IDs do not exactly bind the history count');
    }
    if (
        value.history_end == null
        || !Number.isFinite(Number(value.history_end))
    ) {
        add('creator history cutoff is missing');
    }
    [
        'history_only_baseline',
        'component_a',
        'component_b',
    ].forEach(key => {
        if (!Number.isFinite(Number(value[key]))) {
            add(`${key} is missing or non-finite`);
        }
    });
    if (
        value.predictor_eligible !== false
        || value.research_only !== true
    ) {
        add('research-only predictor boundary is missing');
    }
    if (Number(value.candidate_count) !== 43360) {
        add('locked candidate count is incorrect');
    }
    [
        'serving_artifact_sha256',
        'serving_manifest_sha256',
        'serving_producer_source_sha256',
        'serving_scorer_source_sha256',
        'model_artifact_sha256',
        'model_manifest_sha256',
        'model_producer_source_sha256',
        'feature_contract_sha256',
        'candidate_registry_sha256',
    ].forEach(key => {
        if (!exactSha256(value[key])) {
            add(`${key} is missing or malformed`);
        }
    });
    if (
        value.serving_artifact_canonical_key
        !== SERVING_CANONICAL_KEY
    ) {
        add('serving canonical key is incorrect');
    }
    if (value.serving_manifest_key !== SERVING_MANIFEST_KEY) {
        add('serving manifest key is incorrect');
    }
    const expectedServingArchive = exactSha256(
        value.serving_artifact_sha256
    )
        ? `${SERVING_ARCHIVE_PREFIX}${value.serving_artifact_sha256}.npz`
        : null;
    if (
        !expectedServingArchive
        || value.serving_artifact_key !== expectedServingArchive
    ) {
        add('serving artifact key is not the immutable content address');
    }
    if (value.model_artifact_canonical_key !== MODEL_CANONICAL_KEY) {
        add('model canonical key is incorrect');
    }
    if (value.model_manifest_key !== MODEL_MANIFEST_KEY) {
        add('model manifest key is incorrect');
    }
    const expectedModelArchive = exactSha256(
        value.model_artifact_sha256
    )
        ? `${MODEL_ARCHIVE_PREFIX}${value.model_artifact_sha256}.json`
        : null;
    if (
        !expectedModelArchive
        || value.model_artifact_key !== expectedModelArchive
    ) {
        add('model artifact key is not the immutable content address');
    }
    if (
        value.feature_contract_version == null
        || value.feature_contract_version === ''
    ) {
        add('feature contract version is missing');
    }
    if (!String(value.input || '').trim()) {
        add('input definition is missing');
    }
    const exactExpected = [
        ['coordinateId', 'coordinate_id', 'coordinate ID'],
        [
            'servingArtifactSha256',
            'serving_artifact_sha256',
            'serving artifact SHA-256',
        ],
        [
            'servingManifestSha256',
            'serving_manifest_sha256',
            'serving manifest SHA-256',
        ],
        [
            'servingProducerSourceSha256',
            'serving_producer_source_sha256',
            'serving producer SHA-256',
        ],
        [
            'servingScorerSourceSha256',
            'serving_scorer_source_sha256',
            'serving scorer SHA-256',
        ],
        [
            'modelArtifactSha256',
            'model_artifact_sha256',
            'model artifact SHA-256',
        ],
        [
            'modelManifestSha256',
            'model_manifest_sha256',
            'model manifest SHA-256',
        ],
        [
            'modelProducerSourceSha256',
            'model_producer_source_sha256',
            'model producer SHA-256',
        ],
        [
            'featureContractVersion',
            'feature_contract_version',
            'feature contract version',
        ],
        [
            'featureContractSha256',
            'feature_contract_sha256',
            'feature contract SHA-256',
        ],
        [
            'candidateRegistrySha256',
            'candidate_registry_sha256',
            'candidate registry SHA-256',
        ],
    ];
    exactExpected.forEach(([expectedKey, valueKey, label]) => {
        if (
            expected[expectedKey] != null
            && value[valueKey] !== expected[expectedKey]
        ) {
            add(`${label} does not match the active release`);
        }
    });
    return {
        valid: errors.length === 0,
        raw: Number.isFinite(raw) ? raw : null,
        errors: [...new Set(errors)],
    };
}

module.exports = {
    COORDINATE_ID,
    MODEL_CANONICAL_KEY,
    MODEL_MANIFEST_KEY,
    SERVING_CANONICAL_KEY,
    SERVING_MANIFEST_KEY,
    validateCreatorAdaptiveKeepForecast,
};
