#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const contract = require(
    '../buildings/jarvis/animated-hook-experiment'
);

const hash = character => character.repeat(64);
const experiment = contract.bindExperiment({
    id: 'animated-contract-test',
    status: 'running',
    threshold_value_0_100: 80,
    minimum_verified_attempts: 100,
    winner_target: 10,
    folder_name: 'Animated Hook Grind',
    requests: Array.from({ length: 13 }, (_, index) => ({
        rid: contract.requestId('animated-contract-test', index),
        count: 8,
        created_at_ms: 1000 + index,
    })),
    created_at_ms: 1000,
    updated_at_ms: 1000,
});

assert(contract.validateExperiment(experiment).valid);
assert.strictEqual(experiment.image_model, 'gpt-image-2');
assert.strictEqual(experiment.animation, true);
assert.strictEqual(experiment.strict_image_model, true);
assert.strictEqual(new Set(
    experiment.requests.map(request => request.rid)
).size, 13);
const exploration = contract.explorationTerritories(
    experiment.id,
    0,
    104
);
assert.strictEqual(exploration.length, 104);
assert.strictEqual(new Set(exploration).size, 104);
assert(
    exploration.every(territory => (
        territory.includes('Subject domain:')
        && territory.includes('Hook mechanism:')
        && territory.includes('Visual grammar:')
    ))
);

function attempt(index, score, overrides = {}) {
    return {
        k: index,
        premise: `Distinct animated hook concept ${index}`,
        status: 'done',
        score_verified: true,
        score_coordinate_id: contract.DEFAULT_COORDINATE_ID,
        channel_free_concat_keep_percent: score,
        score_ledger_sha256: hash('a'),
        score_record_sha256: hash('b'),
        score_model_artifact_sha256: hash('c'),
        panel_model: 'gpt-image-2',
        requested_image_model: 'gpt-image-2',
        strict_image_model: true,
        saved_hook_id: `hkbatch${String(index).padStart(4, '0')}`,
        ...overrides,
    };
}

const attempts = Array.from({ length: 104 }, (_, index) => (
    attempt(index, index < 12 ? 82 + index / 10 : 74)
));
const stats = contract.summarize(experiment, [{ attempts }]);
assert.strictEqual(stats.generated_attempts, 104);
assert.strictEqual(stats.verified_unique_attempts, 104);
assert.strictEqual(stats.winner_count, 12);
assert.strictEqual(stats.saved_count, 104);
assert.strictEqual(stats.highest_score, 83.1);

const duplicateAndInvalid = contract.summarize(experiment, [{
    attempts: [
        attempt(1, 82),
        attempt(2, 85, {
            premise: 'Distinct animated hook concept 1',
        }),
        attempt(3, 99, { panel_model: 'flux-2-pro' }),
        attempt(4, 99, { saved_hook_id: null }),
    ],
}]);
assert.strictEqual(duplicateAndInvalid.verified_unique_attempts, 1);
assert.strictEqual(duplicateAndInvalid.winner_count, 1);
assert.strictEqual(duplicateAndInvalid.highest_score, 85);

const tampered = {
    ...experiment,
    threshold_value_0_100: 81,
};
assert.strictEqual(contract.validateExperiment(tampered).valid, false);

const server = fs.readFileSync(
    path.resolve(__dirname, '../server.js'),
    'utf8'
);
for (const required of [
    'animated-hook-batch-request-v1',
    'strictImageModel',
    'persistCanonicalSavedHook',
    'Animated Hook Grind',
    'channel_free_concat_keep_percent',
    'animatedHookExperimentTick',
    'exploration_territories',
    'minimum_text_embedding_distance: 0.30',
    'animatedHookBatchExperimentStopped',
]) {
    assert(
        server.includes(required),
        `server is missing animated batch integration: ${required}`
    );
}

process.stdout.write(JSON.stringify({
    ok: true,
    suite: 'animated-hook-experiment-contract',
    verified: stats.verified_unique_attempts,
    winners: stats.winner_count,
}) + '\n');
