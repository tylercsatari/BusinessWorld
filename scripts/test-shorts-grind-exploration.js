#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const exploration = require(
    '../buildings/jarvis/grind-exploration'
);

function measure(candidate, seed, prior) {
    return exploration.measureCandidate({
        candidateEmbedding: candidate,
        seedEmbedding: seed,
        priorEmbeddings: prior,
    });
}

const seed = [1, 0, 0];
const first = [0.98, 0.2, 0];
let state = exploration.createState({ threshold: 90 });
const firstMeasurement = measure(first, seed, []);

assert.strictEqual(
    state.strategy,
    'same-idea-hook-proportional-outward-v2'
);
assert.deepStrictEqual(
    exploration.candidateDecision(
        state,
        firstMeasurement
    ),
    { accepted: true, reason: 'seed_attempt' }
);

state = exploration.recordScore(state, 50, {
    observedSeedDistance: firstMeasurement.seedDistance,
});
const afterFirst = exploration.publicState(state);
assert.strictEqual(afterFirst.accepted_count, 1);
assert.strictEqual(afterFirst.score_deficit, 40);
assert(afterFirst.required_prior_distance > 0.12);
assert(afterFirst.required_seed_distance > 0.04);

const tooClose = {
    id: 'too-close',
    measurement: measure([0.97, 0.21, 0], seed, [first]),
};
const offTopic = {
    id: 'off-topic',
    measurement: measure([0, 1, 0], seed, [first]),
};
const nearShell = {
    id: 'near-shell',
    measurement: measure([0.8, 0, 0.6], seed, [first]),
};
const largeLeap = {
    id: 'large-leap',
    measurement: measure([0.7, 0, 0.714], seed, [first]),
};
const selection = exploration.selectCandidate(
    state,
    [tooClose, offTopic, largeLeap, nearShell]
);
assert.strictEqual(
    selection.evaluated[0].decision.reason,
    'not_far_enough_from_seed'
);
assert.strictEqual(
    selection.evaluated[1].decision.reason,
    'outside_topic'
);
assert.strictEqual(selection.selected.id, 'near-shell');
assert(
    selection.selected.measurement.seedDistance
        >= state.requiredSeedDistance
);
assert(
    selection.selected.measurement.nearestPriorDistance
        >= state.requiredPriorDistance
);

state = exploration.recordRejections(state, [
    'not_far_enough_from_seed',
    'outside_topic',
]);
assert.strictEqual(state.rejectedCount, 2);
assert.deepStrictEqual(state.rejectionReasons, {
    not_far_enough_from_seed: 1,
    outside_topic: 1,
});
const priorRequirement = state.requiredPriorDistance;
const seedRequirement = state.requiredSeedDistance;
state = exploration.recordScore(state, 60, {
    observedSeedDistance:
        selection.selected.measurement.seedDistance,
});
assert(state.requiredPriorDistance > priorRequirement);
assert(state.requiredSeedDistance > seedRequirement);
assert(
    state.requiredSeedDistance
        > selection.selected.measurement.seedDistance,
    'the next accepted concept must be farther from the seed than the one just rendered'
);

const afterImprovement = state;
state = exploration.recordScore(state, 55);
assert(
    state.requiredPriorDistance
        > afterImprovement.requiredPriorDistance,
    'a non-improving result must continue moving outward'
);
assert(
    state.requiredSeedDistance
        > afterImprovement.requiredSeedDistance
);

const beforeWin = state;
state = exploration.recordScore(state, 90);
assert.strictEqual(state.scoreDeficit, 0);
assert.strictEqual(
    state.requiredPriorDistance,
    beforeWin.requiredPriorDistance
);
assert.strictEqual(
    state.requiredSeedDistance,
    beforeWin.requiredSeedDistance
);

const farMiss = exploration.recordScore(
    exploration.createState({ threshold: 90 }),
    10
);
const nearMiss = exploration.recordScore(
    exploration.createState({ threshold: 90 }),
    89
);
assert(
    farMiss.lastPriorExpansion > nearMiss.lastPriorExpansion,
    'outward movement must be proportional to score deficit'
);
assert(
    farMiss.lastSeedExpansion > nearMiss.lastSeedExpansion
);
const unavailableScore = exploration.recordScore(
    exploration.createState({ threshold: 90 }),
    null
);
assert.strictEqual(unavailableScore.bestScore, null);
assert.strictEqual(unavailableScore.scoreDeficit, 90);

const restored = exploration.restoreState(
    exploration.publicState(afterImprovement),
    { threshold: 90 }
);
assert.strictEqual(
    restored.acceptedCount,
    afterImprovement.acceptedCount
);
assert.strictEqual(
    restored.requiredSeedDistance,
    afterImprovement.requiredSeedDistance
);
assert.strictEqual(
    restored.requiredPriorDistance,
    afterImprovement.requiredPriorDistance
);
assert.strictEqual(restored.bestScore, afterImprovement.bestScore);
assert.strictEqual(restored.scoreDeficit, afterImprovement.scoreDeficit);

let bounded = exploration.createState({ threshold: 100 });
for (let index = 0; index < 1000; index++) {
    bounded = exploration.recordScore(bounded, 0);
}
assert.strictEqual(
    bounded.requiredSeedDistance,
    bounded.topicalGeometrySeedLimit,
    'the only seed-radius boundary is the explicit topical cap geometry'
);
assert.strictEqual(
    bounded.requiredPriorDistance,
    bounded.topicalGeometryPriorLimit,
    'pairwise exploration may expand to the topical cap geometry'
);

const prompt = exploration.generationPrompt({
    seedPremise: 'Build a robot arm',
    state: afterImprovement,
    priorPremises: ['Can a robot arm lift a car?'],
    rejectedPremises: ['Can a robot arm lift something heavy?'],
});
assert(prompt.includes('IMMUTABLE VIDEO IDEA: Build a robot arm'));
assert(prompt.includes('Do not invent a different video concept'));
assert(prompt.includes('Vary only the hook treatment'));
assert(prompt.includes('DO NOT REPEAT THESE RENDERED HOOK TREATMENTS'));
assert(prompt.includes('TOO CLOSE OR OFF-TOPIC'));
const firstPrompt = exploration.generationPrompt({
    seedPremise: 'Build a robot arm',
    state: exploration.createState({ threshold: 90 }),
});
assert(firstPrompt.includes('IMMUTABLE VIDEO IDEA: Build a robot arm'));
assert(firstPrompt.includes('This is the first hook treatment'));
assert(firstPrompt.includes('exact supplied idea'));

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(
    path.join(root, 'server.js'),
    'utf8'
);
const grindStart = serverSource.indexOf(
    'async function grindProcess'
);
const grindEnd = serverSource.indexOf(
    'let _grindBusy',
    grindStart
);
assert(grindStart >= 0 && grindEnd > grindStart);
const grindSource = serverSource.slice(grindStart, grindEnd);
assert(grindSource.includes('grindExploration.createState'));
assert(grindSource.includes('grindExploration.measureCandidate'));
assert(grindSource.includes('grindExploration.selectCandidate'));
assert(grindSource.includes('grindExploration.recordScore'));
assert(grindSource.includes('providerCallBudget: 1'));
assert(grindSource.includes("context: 'the immutable Grind video idea'"));
assert(grindSource.includes("context: 'a Grind candidate hook'"));
assert(grindSource.includes('scoreMontage('));
assert(!grindSource.includes('Math.min(0.30'));
assert(!grindSource.includes('rejected < maxAttempts'));
const ideaIndex = grindSource.indexOf('hookModelGenerateRetry(');
const candidateEmbeddingIndex = grindSource.indexOf(
    'grindExploration.measureCandidate'
);
const renderIndex = grindSource.indexOf('generateCanonicalHookOpening({');
const scoreIndex = grindSource.indexOf('scoreMontage(');
const expansionIndex = grindSource.indexOf(
    'grindExploration.recordScore',
    scoreIndex
);
assert(
    ideaIndex < candidateEmbeddingIndex
    && candidateEmbeddingIndex < renderIndex
    && renderIndex < scoreIndex
    && scoreIndex < expansionIndex,
    'the worker must execute concept -> idea embedding gate -> one-sheet render -> canonical score -> proportional expansion'
);

const renderStart = serverSource.indexOf(
    'async function generateFivePanelStoryboard'
);
const renderEnd = serverSource.indexOf(
    'async function hookModelGenerateRetry',
    renderStart
);
const renderSource = serverSource.slice(renderStart, renderEnd);
assert(renderSource.includes('fivePanelSheet.splitImage'));
assert(renderSource.includes('providerCallBudget'));

console.log('shorts grind outward exploration contract: ok');
