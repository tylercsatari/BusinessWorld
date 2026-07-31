#!/usr/bin/env node
'use strict';

const assert = require('assert');
const longHookLibraryIndex = require(
    '../buildings/jarvis/long-hook-library-index'
);

const legacyRecord = {
    id: 'video-1',
    title: 'A legacy hook',
    views: 1234,
    keep_rate: 72.5,
    duration_s: 20,
    curve: [1.1, 0.9, 0.8],
    hookText: 'This is a legacy hook',
    hookEndSec: 4,
    score: {
        pctile: 80,
        metrics: {
            views: { est: 1000000, pctile: 90 },
        },
    },
};
const legacyBytes = Buffer.from(JSON.stringify(legacyRecord));
const legacyRow = longHookLibraryIndex.compactRecord(
    legacyRecord,
    legacyBytes
);
assert.equal(legacyRow.evidence_state, 'legacy_unbound');
assert.equal(legacyRow.score_record_sha256, null);
assert.equal(legacyRow.ledger_sha256, null);
assert.ok(legacyRow.evidence_errors.length > 0);
assert.equal(
    Object.prototype.hasOwnProperty.call(
        legacyRow.navigation,
        'metrics'
    ),
    false
);
assert.equal(
    Object.prototype.hasOwnProperty.call(
        legacyRow.navigation,
        'pctile'
    ),
    false
);

const index = longHookLibraryIndex.bindIndex({
    rows: [legacyRow],
    recut: null,
    migration_release: null,
    updated_at: 1,
});
assert.deepEqual(
    longHookLibraryIndex.validateIndex(index).errors,
    []
);
assert.equal(index.counts.total, 1);
assert.equal(index.counts.legacy_unbound, 1);
assert.equal(index.counts.canonical_bound, 0);
assert.equal(
    longHookLibraryIndex.validateRowRecordPair(
        index.rows[0],
        legacyRecord,
        legacyBytes
    ).valid,
    true
);

const duplicate = longHookLibraryIndex.bindIndex({
    rows: [legacyRow, legacyRow],
    updated_at: 1,
});
assert.equal(
    longHookLibraryIndex.validateIndex(duplicate).valid,
    false
);

const tampered = JSON.parse(JSON.stringify(index));
tampered.rows[0].navigation.keep_rate = 99;
assert.equal(
    longHookLibraryIndex.validateIndex(tampered).valid,
    false
);

const changedBytes = Buffer.from(
    JSON.stringify({ ...legacyRecord, title: 'Changed' })
);
assert.equal(
    longHookLibraryIndex.validateRowRecordPair(
        index.rows[0],
        legacyRecord,
        changedBytes
    ).valid,
    false
);

console.log(JSON.stringify({
    passed: true,
    checks: 18,
    schema: index.schema,
}));
