#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    isShortsExperimentSharedRoute,
    isPublic,
    permsAllow,
    routeBuilding,
} = require('../auth');

const jarvis = { buildings: ['Jarvis'], features: {} };
const experimentLab = { buildings: ['Experiment Lab'], features: {} };
const workshop = { buildings: ['Workshop'], features: {} };
const storage = { buildings: ['Storage'], features: {} };
const unrelated = { buildings: ['Library'], features: {} };
const owner = { all: true, role: 'owner' };

const labOnlyRoutes = [
    '/api/experimentlab/context',
    '/api/experimentlab/workspaces/current',
];

for (const route of labOnlyRoutes) {
    assert.strictEqual(routeBuilding(route), 'Experiment Lab', route);
    assert.strictEqual(permsAllow(experimentLab, route, 'GET'), true, route);
    assert.strictEqual(permsAllow(jarvis, route, 'GET'), false, route);
    assert.strictEqual(permsAllow(unrelated, route, 'GET'), false, route);
    assert.strictEqual(permsAllow(owner, route, 'GET'), true, route);
}

const sharedRoutes = [
    '/api/indicators/registry',
    '/api/shortsquant/jobs/jabc123',
    '/api/raw/scorer-contract',
    '/api/raw/plot',
    '/api/raw/map',
    '/api/raw/embed-youtube',
    '/api/raw/embed-upload',
    '/api/raw/embed-montage',
    '/api/raw/hook-save',
    '/api/raw/hook-delete',
    '/api/raw/folder-create',
    '/api/raw/folder-delete',
    '/api/raw/hook-move',
    '/api/raw/saved-hooks',
    '/api/raw/saved-hook/abc123',
    '/api/raw/saved-montage/abc123',
    '/api/raw/saved-channels',
    '/api/raw/saved-channel',
    '/api/raw/saved-channel/ch0123456789abcdef',
    '/api/raw/saved-channel/ch0123456789abcdef/analysis',
    '/api/raw/saved-channel/ch0123456789abcdef/stop',
    '/api/raw/saved-channel/ch0123456789abcdef/resume',
    '/api/raw/saved-channel/ch0123456789abcdef/delete',
    '/api/raw/saved-channel/ch0123456789abcdef/video/dQw4w9WgXcQ',
    '/api/raw/saved-channel/ch0123456789abcdef/montage/dQw4w9WgXcQ',
    '/api/storyboards',
    '/api/storyboards/generate',
    '/api/storyboards/panel',
    '/api/storyboards/montage',
    '/api/storyboards/save',
    '/api/storyboards/sb0123456789',
    `/api/storyboards/media/${'a'.repeat(64)}.jpg`,
    '/api/frames/plan',
    '/api/frames/gen',
    '/api/hooks/generate',
    '/api/hooks/warmup',
    '/api/hooks/grind',
    '/api/hooks/demo/status/reqabc123',
    '/api/hooks/grpo/group/demo/reqabc123',
    '/api/hooks/grpo/montage/demo/reqabc123_1',
    '/api/hooks/grind/runs',
    '/api/hooks/grind/run/runabc123',
    '/api/hooks/grind/stop/runabc123',
    '/api/hooks/grind/score/runabc123_1',
    '/api/hooks/grind/montage/runabc123_1',
];

for (const route of sharedRoutes) {
    assert.strictEqual(
        isShortsExperimentSharedRoute(route),
        true,
        `${route} must be on the explicit shared allowlist`
    );
    assert.strictEqual(
        routeBuilding(route),
        'Jarvis+Experiment Lab',
        route
    );
    assert.strictEqual(permsAllow(jarvis, route, 'GET'), true, route);
    assert.strictEqual(permsAllow(experimentLab, route, 'GET'), true, route);
    assert.strictEqual(permsAllow(unrelated, route, 'GET'), false, route);
    assert.strictEqual(permsAllow(owner, route, 'GET'), true, route);
}

const ownerOnlyNearMisses = [
    '/api/raw/fusion',
    '/api/raw/predictor-lab',
    '/api/raw/predictor-lab/status',
    '/api/raw/hook-enrich',
    '/api/raw/upload-selftest',
    '/api/raw/saved-channel-validation',
    '/api/raw-long/embed-montage',
    '/api/hooks/runs',
    '/api/hooks/guesses',
    '/api/hooks/grpo/runs',
    '/api/hooks/grpo/index',
    '/api/storyboards/admin',
];

for (const route of ownerOnlyNearMisses) {
    assert.strictEqual(
        isShortsExperimentSharedRoute(route),
        false,
        `${route} must not leak through the shared allowlist`
    );
    assert.strictEqual(routeBuilding(route), 'owner', route);
    assert.strictEqual(permsAllow(jarvis, route, 'GET'), false, route);
    assert.strictEqual(permsAllow(experimentLab, route, 'GET'), false, route);
    assert.strictEqual(permsAllow(owner, route, 'GET'), true, route);
}

const jarvisOnly = '/api/shortsquant/promise-lab/opening-predictions';
assert.strictEqual(routeBuilding(jarvisOnly), 'Jarvis');
assert.strictEqual(permsAllow(jarvis, jarvisOnly, 'GET'), true);
assert.strictEqual(permsAllow(experimentLab, jarvisOnly, 'GET'), false);

const inventory = '/api/data/inventory';
assert.strictEqual(routeBuilding(inventory), 'Storage+Workshop');
assert.strictEqual(permsAllow(storage, inventory, 'GET'), true);
assert.strictEqual(permsAllow(workshop, inventory, 'GET'), true);
assert.strictEqual(permsAllow(unrelated, inventory, 'GET'), false);

[
    '/api/hooks/generate',
    '/api/hooks/warmup',
    '/api/hooks/grind',
    '/api/hooks/demo/status/reqabc123',
    '/api/hooks/grpo/group/demo/reqabc123',
    '/api/hooks/grpo/montage/demo/reqabc123_1',
    '/api/hooks/grind/run/runabc123',
    '/api/hooks/grind/stop/runabc123',
    '/api/hooks/grind/montage/runabc123_1',
    '/api/raw/saved-montage/abc123',
    '/api/raw/saved-channel/ch0123456789abcdef/montage/dQw4w9WgXcQ',
].forEach(route => {
    assert.strictEqual(
        isPublic(route, 'GET'),
        false,
        `${route} must require a signed-in account`
    );
});

console.log('Experiment Lab auth contract: pass');
