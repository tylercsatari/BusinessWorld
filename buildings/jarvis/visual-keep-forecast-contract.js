'use strict';

const governance = require('./quant-coordinate-governance.json');

const COORDINATE_ID =
    governance.coordinates.visualKeepForecast.id;
const MODEL_CANONICAL_KEY =
    'raw/predictor-lab/visual-keep-model-v1.json';
const MODEL_MANIFEST_KEY =
    'raw/predictor-lab/visual-keep-model-v1.manifest.json';
const MODEL_ARCHIVE_PREFIX =
    'raw/predictor-lab/visual-keep-model/by-sha256/';
const SHA256_RE = /^[a-f0-9]{64}$/;

function exactSha256(value) {
    return SHA256_RE.test(String(value || '').toLowerCase());
}

function validateVisualKeepForecast(value, expected = {}) {
    const errors = [];
    const add = message => errors.push(message);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            valid: false,
            errors: ['visual keep forecast is missing'],
        };
    }
    const raw = Number(value.raw);
    const estimate = Number(value.est);
    if (value.coordinate_id !== COORDINATE_ID) {
        add('coordinate ID is not canonical');
    }
    if (value.source !== 'live_frozen_model_score') {
        add('source is not live_frozen_model_score');
    }
    if (value.calibration_scope !== 'pooled_global') {
        add('calibration scope is not pooled_global');
    }
    if (
        !Object.prototype.hasOwnProperty.call(value, 'account_model')
        || value.account_model !== null
    ) {
        add('account_model is not explicitly null');
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
    if (!exactSha256(value.model_artifact_sha256)) {
        add('model artifact SHA-256 is missing or malformed');
    }
    if (!exactSha256(value.model_manifest_sha256)) {
        add('model manifest SHA-256 is missing or malformed');
    }
    if (!exactSha256(value.producer_source_sha256)) {
        add('producer source SHA-256 is missing or malformed');
    }
    if (!exactSha256(value.feature_contract_sha256)) {
        add('feature contract SHA-256 is missing or malformed');
    }
    if (
        value.model_artifact_canonical_key !== MODEL_CANONICAL_KEY
    ) {
        add('model canonical key is incorrect');
    }
    if (value.model_manifest_key !== MODEL_MANIFEST_KEY) {
        add('model manifest key is incorrect');
    }
    const expectedArchiveKey = exactSha256(
        value.model_artifact_sha256
    )
        ? `${MODEL_ARCHIVE_PREFIX}${value.model_artifact_sha256}.json`
        : null;
    if (
        !expectedArchiveKey
        || value.model_artifact_key !== expectedArchiveKey
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
            'producerSourceSha256',
            'producer_source_sha256',
            'producer source SHA-256',
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
    validateVisualKeepForecast,
};
