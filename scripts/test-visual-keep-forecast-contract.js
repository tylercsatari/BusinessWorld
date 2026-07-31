#!/usr/bin/env node
'use strict';

const assert = require('assert');
const contract = require(
    '../buildings/jarvis/visual-keep-forecast-contract'
);

const artifactSha256 = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const producerSourceSha256 = 'c'.repeat(64);
const featureContractSha256 = 'd'.repeat(64);
const expected = {
    coordinateId: contract.COORDINATE_ID,
    modelArtifactSha256: artifactSha256,
    modelManifestSha256: manifestSha256,
    producerSourceSha256,
    featureContractVersion: 10,
    featureContractSha256,
};
const canonical = {
    coordinate_id: contract.COORDINATE_ID,
    raw: 72.25,
    est: 72.25,
    pctile: null,
    kind: 'keep_rate_percent',
    unit: 'percent',
    calibration_scope: 'pooled_global',
    account_model: null,
    model_artifact_sha256: artifactSha256,
    model_artifact_key:
        `raw/predictor-lab/visual-keep-model/by-sha256/${artifactSha256}.json`,
    model_artifact_canonical_key:
        contract.MODEL_CANONICAL_KEY,
    model_manifest_key: contract.MODEL_MANIFEST_KEY,
    model_manifest_sha256: manifestSha256,
    producer_source_sha256: producerSourceSha256,
    feature_contract_version: 10,
    feature_contract_sha256: featureContractSha256,
    input: 'first-five-second five-frame montage embedding only',
    source: 'live_frozen_model_score',
};

assert.deepStrictEqual(
    contract.validateVisualKeepForecast(canonical, expected),
    { valid: true, raw: 72.25, errors: [] }
);

[
    ['account_model', undefined],
    ['account_model', 'tyler'],
    ['model_manifest_sha256', 'e'.repeat(64)],
    ['model_artifact_sha256', 'f'.repeat(64)],
    ['unit', 'probability'],
    ['kind', 'keep_probability'],
    ['est', 71],
    ['source', 'cached_alias'],
    ['calibration_scope', 'creator'],
    ['producer_source_sha256', 'e'.repeat(64)],
    ['feature_contract_sha256', 'e'.repeat(64)],
    ['feature_contract_version', 9],
    ['model_artifact_key', contract.MODEL_CANONICAL_KEY],
    ['model_artifact_canonical_key', null],
    ['model_manifest_key', null],
    ['pctile', 72],
].forEach(([key, value]) => {
    const mutated = { ...canonical };
    if (value === undefined) delete mutated[key];
    else mutated[key] = value;
    assert.strictEqual(
        contract.validateVisualKeepForecast(mutated, expected).valid,
        false,
        `${key} mutation must be rejected`
    );
});

console.log('visual keep forecast contract tests passed');
