#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const UI_PATH = path.join(ROOT, 'buildings/jarvis/jarvis-retention.js');
const source = fs.readFileSync(UI_PATH, 'utf8');
const validatorStart = source.indexOf('function shortsGrindVerifiedScore(attempt)');
const validatorEnd = source.indexOf('function shortsGrindUnverifiedMessage(attempt)', validatorStart);
assert.ok(validatorStart >= 0 && validatorEnd > validatorStart);
const helperContext = vm.createContext({
    channelFreeKeepForecastsOf(readout) {
        return readout && readout._channelFree || null;
    },
});
vm.runInContext(
    `${source.slice(validatorStart, validatorEnd)}
    this.verifiedScore = shortsGrindVerifiedScore;
    this.readoutMatches = shortsGrindReadoutMatchesVerifiedScore;`,
    helperContext
);
const verifiedScore = helperContext.verifiedScore;
const readoutMatches = helperContext.readoutMatches;

assert.strictEqual(typeof verifiedScore, 'function');

const valid = {
    score_verified: true,
    score_coordinate_id: 'shorts.stored.together.keep',
    score_ledger_sha256: 'a'.repeat(64),
    score_value: 83.25,
    score_percentile_0_100: 91.5,
};

assert.strictEqual(
    JSON.stringify(verifiedScore(valid)),
    JSON.stringify(valid)
);

const invalidCases = [
    null,
    {},
    { pct: 91.5, status: 'done' },
    { ...valid, score_verified: false },
    { ...valid, score_verified: 1 },
    { ...valid, score_coordinate_id: '' },
    { ...valid, score_coordinate_id: '   ' },
    { ...valid, score_ledger_sha256: 'A'.repeat(64) },
    { ...valid, score_ledger_sha256: 'a'.repeat(63) },
    { ...valid, score_value: '83.25' },
    { ...valid, score_value: Number.NaN },
    { ...valid, score_value: Number.POSITIVE_INFINITY },
    { ...valid, score_percentile_0_100: '91.5' },
    { ...valid, score_percentile_0_100: -0.01 },
    { ...valid, score_percentile_0_100: 100.01 },
];

for (const candidate of invalidCases) {
    assert.strictEqual(verifiedScore(candidate), null);
}

assert.ok(verifiedScore({ ...valid, score_percentile_0_100: 0 }));
assert.ok(verifiedScore({ ...valid, score_percentile_0_100: 100 }));

const binding = verifiedScore(valid);
const validReadout = {
    score_ledger: {
        ledger_sha256: valid.score_ledger_sha256,
        entries: [{
            coordinate_id: valid.score_coordinate_id,
            available: true,
            value: valid.score_value,
            percentile: valid.score_percentile_0_100,
        }],
    },
};
assert.strictEqual(readoutMatches(validReadout, binding), true);
assert.strictEqual(readoutMatches(null, binding), false);
assert.strictEqual(readoutMatches(validReadout, null), false);
assert.strictEqual(readoutMatches({
    score_ledger: {
        ...validReadout.score_ledger,
        ledger_sha256: 'b'.repeat(64),
    },
}, binding), false);

const channelFree = {
    ...valid,
    score_coordinate_id: 'shorts.channel-free.concat.keep',
    score_value: 78.4,
    score_percentile_0_100: 91.2,
    score_record_sha256: 'b'.repeat(64),
    score_model_artifact_sha256: 'c'.repeat(64),
    score_target_unit: 'predicted_keep_percent',
};
const channelFreeBinding = verifiedScore(channelFree);
assert(channelFreeBinding);
assert.strictEqual(channelFreeBinding.score_value, 78.4);
assert.strictEqual(readoutMatches({
    score_ledger: {
        ledger_sha256: valid.score_ledger_sha256,
        entries: [],
    },
    _channelFree: {
        outputs: {
            concat: {
                coordinateId: channelFree.score_coordinate_id,
                value: channelFree.score_value,
                percentile100:
                    channelFree.score_percentile_0_100,
                scoreRecordSha256:
                    channelFree.score_record_sha256,
                model_artifact_sha256:
                    channelFree.score_model_artifact_sha256,
            },
        },
    },
}, channelFreeBinding), true);
assert.strictEqual(verifiedScore({
    ...channelFree,
    score_target_unit: 'percentile_0_100',
}), null);
assert.strictEqual(readoutMatches({
    score_ledger: {
        ...validReadout.score_ledger,
        entries: [{
            ...validReadout.score_ledger.entries[0],
            percentile: 90,
        }],
    },
}, binding), false);

const inherited = Object.create(valid);
assert.strictEqual(
    verifiedScore(inherited),
    null,
    'ledger fields must be explicit properties of the attempt'
);

const grindStart = source.indexOf('// ── 🎯 GRIND:');
const grindEnd = source.indexOf('// ── ONE unified progress stepper', grindStart);
assert.ok(grindStart >= 0 && grindEnd > grindStart);
const grindSource = source.slice(grindStart, grindEnd);

assert.ok(!/\ba\.pct\b/.test(grindSource), 'grind UI must not read legacy attempt.pct');
assert.ok(!/\ba\.scoreCoordinateId\b/.test(grindSource), 'grind UI must not read camelCase score coordinate aliases');
assert.ok(!/\ba\.scoreValue\b/.test(grindSource), 'grind UI must not read camelCase score value aliases');
assert.ok(grindSource.includes('shortsGrindVerifiedScore(a)'));
assert.ok(grindSource.includes('Historical score unverified'));
assert.ok(grindSource.includes("Object.prototype.hasOwnProperty.call(a, 'pct')"));
assert.ok(grindSource.includes('score_ledger_sha256: verifiedScore.score_ledger_sha256'));
assert.ok(grindSource.includes('score_percentile_0_100: verifiedScore.score_percentile_0_100'));
assert.ok(grindSource.includes('shorts.channel-free.concat.keep'));
assert.ok(grindSource.includes('predicted_keep_percent'));
assert.ok(grindSource.includes('data-grindanimation'));
assert.ok(grindSource.includes('required_seed_embedding_distance'));
assert.ok(grindSource.includes('topical_similarity_floor'));
assert.ok(grindSource.includes('image_provider_call_count'));
assert.ok(grindSource.includes('one provider call → one 45:16 sheet'));

console.log('shorts grind UI ledger contract: ok');
