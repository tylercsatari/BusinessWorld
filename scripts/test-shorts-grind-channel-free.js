#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const start = source.indexOf(
    'const SHORTS_GRIND_CHANNEL_FREE_CONCAT'
);
const end = source.indexOf(
    'function shortsGrindRunHashPayload',
    start
);
assert(start >= 0 && end > start);

const sha = value => String(value).repeat(64).slice(0, 64);
const coordinateId = 'shorts.channel-free.concat.keep';
const modelSha = sha('b');
const recordSha = sha('c');
const ledgerSha = sha('d');
const context = vm.createContext({
    channelFreeKeepForecastContract: {
        COORDINATE_IDS: { concat: coordinateId },
        validateChannelFreeKeepForecasts(value, expected) {
            assert.strictEqual(expected.requireText, true);
            return {
                valid: value && value.valid === true,
                outputs: value && value.outputs || {},
            };
        },
    },
    shortsScoreLedger: {
        validateScoreLedger(ledger) {
            return { valid: ledger && ledger.valid === true };
        },
    },
    exactSha256(value) {
        return typeof value === 'string'
            && /^[a-f0-9]{64}$/.test(value);
    },
});
vm.runInContext(
    `${source.slice(start, end)}
    this.coordinateValue = grindCoordinateValue;
    this.attemptValid = shortsGrindAttemptProjectionValid;
    this.targetValue = shortsGrindAttemptTargetValue;
    this.targetUnit = shortsGrindTargetUnit;`,
    context
);

const score = {
    score_ledger: {
        valid: true,
        ledger_sha256: ledgerSha,
        entries: [],
    },
    score_record_sha256: recordSha,
    channel_free_keep_forecasts: {
        valid: true,
        outputs: {
            concat: {
                coordinate_id: coordinateId,
                available: true,
                raw: 78.4,
                est: 78.4,
                pctile: 91.2,
                kind: 'channel_free_keep_rate_percent',
                model_artifact_sha256: modelSha,
            },
        },
    },
};

const projection = context.coordinateValue(score, coordinateId);
assert(projection);
assert.strictEqual(projection.score_value, 78.4);
assert.strictEqual(projection.score_percentile_0_100, 91.2);
assert.strictEqual(
    projection.score_target_unit,
    'predicted_keep_percent'
);
assert.strictEqual(projection.score_record_sha256, recordSha);
assert.strictEqual(projection.score_model_artifact_sha256, modelSha);
assert.strictEqual(context.attemptValid(projection, coordinateId), true);
assert.strictEqual(context.targetValue(projection, coordinateId), 78.4);
assert.strictEqual(
    context.targetUnit(coordinateId),
    'predicted_keep_percent'
);

assert.strictEqual(
    context.attemptValid({
        ...projection,
        score_value: 101,
    }, coordinateId),
    false
);
assert.strictEqual(
    context.attemptValid({
        ...projection,
        score_record_sha256: sha('e'),
        score_target_unit: 'percentile_0_100',
    }, coordinateId),
    false
);

const runEnd = source.indexOf('async function grindProcess', start);
const runContext = vm.createContext({
    channelFreeKeepForecastContract:
        context.channelFreeKeepForecastContract,
    exactSha256: context.exactSha256,
    shortsScoreLedger: {
        validateScoreLedger:
            context.shortsScoreLedger.validateScoreLedger,
        sha256Canonical(value) {
            return crypto.createHash('sha256')
                .update(JSON.stringify(value))
                .digest('hex');
        },
    },
});
vm.runInContext(
    `${source.slice(start, runEnd)}
    this.bindRun = bindShortsGrindRun;
    this.validateRun = validateShortsGrindRun;
    this.runResponse = shortsGrindRunForResponse;`,
    runContext
);
const belowThreshold = runContext.bindRun({
    rid: 'gr-test',
    premise: 'test premise',
    threshold_coordinate_id: coordinateId,
    threshold_unit: 'predicted_keep_percent',
    threshold_value_0_100: 80,
    attempts: [projection],
    status: 'maxed',
});
assert.strictEqual(runContext.validateRun(belowThreshold).valid, true);
const belowResponse = runContext.runResponse(belowThreshold);
assert.strictEqual(belowResponse.best_score.target_value, 78.4);
assert.strictEqual(belowResponse.winner_attempt_index, null);
assert.strictEqual(
    belowResponse.best_score.score_percentile_0_100,
    91.2,
    'the pooled percentile remains visible but must not clear the raw target'
);

const winnerAttempt = {
    ...projection,
    k: 1,
    score_value: 82.3,
    score_percentile_0_100: 84.1,
};
const winningRun = runContext.bindRun({
    rid: 'gr-win',
    premise: 'test premise',
    threshold_coordinate_id: coordinateId,
    threshold_unit: 'predicted_keep_percent',
    threshold_value_0_100: 80,
    attempts: [{ ...projection, k: 0 }, winnerAttempt],
    status: 'won',
});
const winningResponse = runContext.runResponse(winningRun);
assert.strictEqual(runContext.validateRun(winningRun).valid, true);
assert.strictEqual(winningResponse.winner_attempt_index, 1);
assert.strictEqual(winningResponse.best_score.target_value, 82.3);

assert(source.includes("schema: 'shorts-grind-request-v3'"));
assert(source.includes("schema: 'shorts-grind-run-v3'"));
assert(source.includes("render_mode: 'single-panel'"));
assert(!source.includes('renderFrameRobust('));
console.log('shorts grind channel-free target contract: ok');
