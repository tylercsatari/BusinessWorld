#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const planner = require('../buildings/jarvis/grind-planner');

assert.strictEqual(
    planner.normalizeMode('standard'),
    planner.STANDARD_MODE
);
assert.strictEqual(
    planner.normalizeMode('anything-else'),
    planner.FINE_TUNED_MODE
);
assert.strictEqual(
    planner.sourceMetricForCoordinate('shorts.stored.together.ret5'),
    'together_ret5_geometry'
);
assert.strictEqual(
    planner.sourceMetricForCoordinate('shorts.stored.together.views'),
    'together_views_geometry'
);
assert.strictEqual(
    planner.sourceMetricForCoordinate('shorts.stored.together.gt10M'),
    'together_gt10m_geometry'
);
assert.strictEqual(
    planner.sourceMetricForCoordinate('shorts.channel-free.concat.keep'),
    'together_keep_geometry'
);

const messages = planner.standardMessages({
    generationPrompt:
        'IMMUTABLE VIDEO IDEA: Build a web shooter that holds my weight',
    count: 4,
    invent: false,
});
assert.strictEqual(messages.length, 2);
assert(messages[0].content.includes('not the fine-tuned planner'));
assert(messages[0].content.includes('exactly 4 materially distinct'));
assert(messages[0].content.includes('Never copy their subject'));
assert(messages[1].content.includes('Do not change it'));

const plans = planner.parseStandardPlans({
    hooks: Array.from({ length: 4 }, (_, index) => ({
        premise: `Treatment ${index + 1}`,
        frames: Array.from(
            { length: 5 },
            (__, frame) => `Treatment ${index + 1}, frame ${frame + 1}`
        ),
    })),
}, {
    fallbackPremise: 'Fallback',
    count: 4,
});
assert.strictEqual(plans.length, 4);
assert(plans.every(plan => (
    plan.frames.length === 5
    && plan.treatment_source === 'standard_exploratory_json'
)));

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(
    path.join(root, 'buildings/jarvis/jarvis-retention.js'),
    'utf8'
);
const grindStart = server.indexOf('async function grindProcess');
const grindEnd = server.indexOf('let _grindBusy', grindStart);
const grindSource = server.slice(grindStart, grindEnd);
assert(server.includes('planner_mode: plannerMode'));
assert(server.includes('standardHookModelGenerateResilient'));
assert(server.includes('grindPlannerGenerateResilient'));
assert(server.includes("=== grindPlanner.STANDARD_MODE"));
assert(grindSource.includes('grindPlannerGenerateRetry('));
assert(grindSource.includes('grindPlannerGenerateBatchRetry('));
assert(grindSource.includes('usesPlannerInspiration'));
assert(grindSource.includes('planner_sources:'));
assert(grindSource.includes('planner_inspiration_retrieval:'));
assert(grindSource.includes('_hookLastGen = 0'));
assert(grindSource.includes('generateCanonicalHookOpening({'));
assert(grindSource.includes('scoreMontage('));
assert(!grindSource.includes('standardHookModelGenerate('));
assert(ui.includes('data-grindfinetuned'));
assert(ui.includes("? 'standard'"));
assert(ui.includes('plannerMode,'));
assert(ui.includes('standard exploration model'));

console.log('grind planner contract: ok');
