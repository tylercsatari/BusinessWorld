#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    canonicalJsonBytes,
    sha256Bytes,
} = require('../buildings/jarvis/canonical-json-artifact');
const binding = require(
    '../buildings/jarvis/saved-channel-manifest-binding'
);
const recordBinding = require(
    '../buildings/jarvis/saved-channel-record-binding'
);
const scoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const {
    scoreLedgerFromFeatures,
} = require('./fixtures/score-ledger-fixture');

const record = {
    id: 'abcdefghijk',
    title: 'Bound record',
    score_ledger: {
        ledger_sha256: 'a'.repeat(64),
    },
};
const row = {
    id: record.id,
    title: record.title,
    status: 'done',
    views: 123,
    published: '2026-07-29',
    viewsObservedAt: 1,
    scoredAt: 2,
    score_ledger: record.score_ledger,
    input_manifest: {
        revision_fingerprint: 'revision',
    },
    evidence_state: 'canonical_bound',
    canonical: true,
    predictor_eligible: true,
    evidence_warning: null,
};
const result =
    recordBinding.bindSavedChannelRecordAndRow(
        record,
        row
    );
const recordBytes = canonicalJsonBytes(record);
assert.equal(
    row.record_artifact_sha256,
    sha256Bytes(recordBytes)
);
assert.equal(row.record_byte_length, recordBytes.length);
assert.equal(
    row.manifest_row_sha256,
    binding.manifestRowBindingSha256(row)
);
assert.equal(
    binding.validateManifestRowBinding(row).valid,
    true
);
assert.equal(
    result.recordArtifactSha256,
    row.record_artifact_sha256
);
assert.equal(
    recordBinding.savedChannelRecordArtifactKey(
        'ch0000000000000001',
        row.record_artifact_sha256
    ),
    'raw/saved-channels/ch0000000000000001/video-artifacts/'
        + `by-sha256/${row.record_artifact_sha256}.json`
);
assert.throws(
    () => recordBinding.savedChannelRecordArtifactKey(
        'invalid',
        row.record_artifact_sha256
    ),
    /channel ID is invalid/
);
assert.throws(
    () => recordBinding.savedChannelRecordArtifactKey(
        'ch0000000000000001',
        'invalid'
    ),
    /SHA-256 is invalid/
);

const prior = JSON.parse(JSON.stringify(row));
prior.manifest_row_sha256 =
    binding.priorManifestRowBindingSha256V1(prior);
const priorValidation =
    binding.validateManifestRowBinding(prior);
assert.equal(priorValidation.valid, false);
assert.equal(
    priorValidation.state,
    'migration-required'
);
assert.equal(priorValidation.prior_v1_valid, true);
const priorV2 = JSON.parse(JSON.stringify(row));
priorV2.manifest_row_sha256 =
    binding.priorManifestRowBindingSha256V2(priorV2);
const priorV2Validation =
    binding.validateManifestRowBinding(priorV2);
assert.equal(priorV2Validation.valid, false);
assert.equal(priorV2Validation.state, 'migration-required');
assert.equal(priorV2Validation.prior_v2_valid, true);

const tamperedHash = JSON.parse(JSON.stringify(row));
tamperedHash.record_artifact_sha256 = 'f'.repeat(64);
assert.equal(
    binding.validateManifestRowBinding(tamperedHash).valid,
    false
);
const tamperedLength = JSON.parse(JSON.stringify(row));
tamperedLength.record_byte_length += 1;
assert.equal(
    binding.validateManifestRowBinding(tamperedLength).valid,
    false
);

const fixtureFeatures = Object.fromEntries(
    scoreLedger.FEATURE_DEFINITIONS.map(
        (definition, index) => [
            definition.key,
            [
                definition.unit === 'views'
                    ? 100000 + index
                    : definition.unit === 'probability'
                        ? 0.5
                        : 50 + index,
                definition.target === 'realviews'
                    ? null
                    : 60 + index,
            ],
        ]
    )
);
const priorRecord = {
    id: 'priorrecord1',
    savedChannelVideoId: 'priorrecord1',
    title: 'Exactly verified prior record',
    score_ledger: scoreLedgerFromFeatures(fixtureFeatures),
};
priorRecord.score_record_sha256 =
    scoreLedger.priorScoreRecordBindingSha256V1(priorRecord);
const priorRow = {
    id: priorRecord.id,
    title: priorRecord.title,
    status: 'done',
    views: 321,
    published: '2026-07-29',
    viewsObservedAt: 3,
    scoredAt: 4,
    score_record_sha256: priorRecord.score_record_sha256,
    score_ledger: JSON.parse(
        JSON.stringify(priorRecord.score_ledger)
    ),
    input_manifest: {
        revision_fingerprint: null,
    },
    evidence_state: 'historical_unbound_input',
    canonical: false,
    predictor_eligible: false,
    evidence_warning:
        recordBinding.HISTORICAL_EVIDENCE_WARNING,
};
priorRow.manifest_row_sha256 =
    binding.priorManifestRowBindingSha256V1(priorRow);
const migratedPrior =
    recordBinding.canonicalizeSavedChannelRecordBinding(
        priorRecord,
        priorRow,
        {
            allowPriorRevisionMigration: true,
            allowPriorRecordBindingMigration: true,
        }
    );
assert.equal(
    migratedPrior.valid,
    true,
    migratedPrior.errors.join('; ')
);
assert.equal(migratedPrior.migratedPriorRecordBinding, true);
assert.equal(
    binding.validateManifestRowBinding(priorRow).valid,
    true
);
assert.equal(
    priorRow.score_record_sha256,
    scoreLedger.scoreRecordBindingSha256(priorRecord)
);

console.log(JSON.stringify({
    passed: true,
    checks: 20,
    schema: binding
        .manifestRowBindingPayload(row)
        .schema,
}));
