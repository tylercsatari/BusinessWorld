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
    'same-idea-hook-directional-frontier-v3'
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
assert(afterFirst.target_prior_distance > 0.12);
assert(afterFirst.target_seed_distance > 0.04);
assert.strictEqual(afterFirst.duplicate_distance_floor, 0.02);
assert(afterFirst.exploration_pressure > 0);

assert.deepStrictEqual(
    exploration.directionFromSeed([0.8, 0.6, 0], seed).map(
        value => Math.round(value * 1000) / 1000
    ),
    [0, 1, 0]
);
assert.strictEqual(
    exploration.directionSignature([0, 1, 0]),
    exploration.directionSignature([0, 1, 0]),
    'direction identities must be deterministic'
);

const tooClose = {
    id: 'too-close',
    measurement: measure([0.97, 0.21, 0], seed, [first]),
};
const offTopic = {
    id: 'off-topic',
    measurement: measure([0, 1, 0], seed, [first]),
};
const sameDirectionFarther = {
    id: 'same-direction-farther',
    measurement: measure([0.8, 0.6, 0], seed, [first]),
};
const newDirectionNearby = {
    id: 'new-direction-nearby',
    measurement: measure([0.96, 0, 0.28], seed, [first]),
};
const selection = exploration.selectCandidate(
    state,
    [tooClose, offTopic, sameDirectionFarther, newDirectionNearby]
);
assert.strictEqual(
    selection.evaluated[0].decision.reason,
    'semantic_duplicate'
);
assert.strictEqual(
    selection.evaluated[1].decision.reason,
    'outside_topic'
);
assert.strictEqual(selection.selected.id, 'new-direction-nearby');
assert(
    selection.selected.measurement.seedDistance
        < state.targetSeedDistance,
    'a nearby magnitude must remain eligible when it opens a new direction'
);
assert(
    selection.selected.measurement.nearestPriorDistance
        >= state.duplicateDistanceFloor
);
assert.strictEqual(
    selection.selected.measurement
        .nearestPriorDirectionalAngleDegrees,
    90
);
assert(
    selection.selected.rankComponents.directional
        > selection.evaluated[2].rankComponents.directional
);
assert(selection.selected.measurement.directionSignature);

state = exploration.recordRejections(state, [
    'semantic_duplicate',
    'outside_topic',
]);
assert.strictEqual(state.rejectedCount, 2);
assert.deepStrictEqual(state.rejectionReasons, {
    semantic_duplicate: 1,
    outside_topic: 1,
});
const priorTarget = state.targetPriorDistance;
const seedTarget = state.targetSeedDistance;
state = exploration.recordScore(state, 60, {
    observedSeedDistance:
        selection.selected.measurement.seedDistance,
});
assert(state.targetPriorDistance > priorTarget);
assert(state.targetSeedDistance > seedTarget);

const afterImprovement = state;
state = exploration.recordScore(state, 55);
assert(
    state.targetPriorDistance
        > afterImprovement.targetPriorDistance,
    'a non-improving result must increase the soft exploration objective'
);
assert(
    state.targetSeedDistance
        > afterImprovement.targetSeedDistance
);

const beforeWin = state;
state = exploration.recordScore(state, 90);
assert.strictEqual(state.scoreDeficit, 0);
assert.strictEqual(
    state.targetPriorDistance,
    beforeWin.targetPriorDistance
);
assert.strictEqual(
    state.targetSeedDistance,
    beforeWin.targetSeedDistance
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
    restored.targetSeedDistance,
    afterImprovement.targetSeedDistance
);
assert.strictEqual(
    restored.targetPriorDistance,
    afterImprovement.targetPriorDistance
);
assert.strictEqual(restored.bestScore, afterImprovement.bestScore);
assert.strictEqual(restored.scoreDeficit, afterImprovement.scoreDeficit);

let bounded = exploration.createState({ threshold: 100 });
for (let index = 0; index < 1000; index++) {
    bounded = exploration.recordScore(bounded, 0);
}
assert.strictEqual(
    bounded.targetSeedDistance,
    bounded.topicalGeometrySeedLimit,
    'the soft radial target cannot leave the explicit topical cap geometry'
);
assert.strictEqual(
    bounded.targetPriorDistance,
    bounded.topicalGeometryPriorLimit,
    'the soft pairwise target may expand to the topical cap geometry'
);

const legacyRestored = exploration.restoreState({
    ...exploration.publicState(afterImprovement),
    schema: 'shorts-grind-exploration-v2',
    strategy: 'same-idea-hook-proportional-outward-v2',
    required_seed_distance: afterImprovement.targetSeedDistance,
    required_prior_distance: afterImprovement.targetPriorDistance,
    target_seed_distance: undefined,
    target_prior_distance: undefined,
}, { threshold: 90 });
assert.strictEqual(
    legacyRestored.targetSeedDistance,
    afterImprovement.targetSeedDistance
);
assert.strictEqual(
    legacyRestored.targetPriorDistance,
    afterImprovement.targetPriorDistance
);

const prompt = exploration.generationPrompt({
    seedPremise: 'Build a robot arm',
    state: afterImprovement,
    priorPremises: ['Can a robot arm lift a car?'],
    rejectedPremises: ['Can a robot arm lift something heavy?'],
    selectionRound: 2,
});
assert(prompt.includes('IMMUTABLE VIDEO IDEA: Build a robot arm'));
assert(prompt.includes('Do not invent a different video concept'));
assert(prompt.includes('Vary only the hook treatment'));
assert(prompt.includes('OUTWARD SEARCH ROUND 3'));
assert(prompt.includes('STRUCTURAL ASSIGNMENT'));
assert(prompt.includes('Return exactly one normal five-beat plan'));
assert(prompt.includes('sentence skeleton'));
assert(prompt.includes('DO NOT REPEAT THESE RENDERED HOOK TREATMENTS'));
assert(prompt.includes('RECENT DRAFTS NOT SELECTED FOR RENDER'));
assert(prompt.includes('soft targets'));
assert(prompt.includes('underexplored semantic direction'));
assert(prompt.includes('Missing either target does not discard'));
assert.deepStrictEqual(
    exploration.outwardAssignments(1),
    exploration.outwardAssignments(4),
    'the assignment lattice rotates deterministically and repeats only after every assignment has been used'
);
assert.notDeepStrictEqual(
    exploration.outwardAssignments(1),
    exploration.outwardAssignments(2),
    'consecutive screening rounds must receive different structural searches'
);
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
assert(grindSource.includes('selectionRound,'));
assert(grindSource.includes('grindExploration.recordScore'));
assert(grindSource.includes('direction_signature:'));
assert(grindSource.includes('nearest_prior_directional_angle_degrees:'));
assert(grindSource.includes('directional_frontier_score:'));
assert(grindSource.includes('target_seed_embedding_distance:'));
assert(grindSource.includes('duplicate_embedding_distance_floor:'));
assert(grindSource.includes('hook_text_embedding_artifact:'));
assert(grindSource.includes('hook_text_embedding_sha256:'));
assert(grindSource.includes('exactTextEmbeddingBuffer(emb)'));
assert(grindSource.includes('persisted hook embedding hash mismatch'));
assert(serverSource.includes('premise: hookPlanOutput.treatmentText(plan)'));
assert(grindSource.includes('providerCallBudget: 1'));
assert(grindSource.includes("context: 'the immutable Grind video idea'"));
assert(grindSource.includes("context: 'a Grind candidate hook'"));
assert(grindSource.includes('scoreMontage('));
assert(!grindSource.includes('Math.min(0.30'));
assert(!grindSource.includes('rejected < maxAttempts'));
assert(!grindSource.includes('both topical and far enough outward'));
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
