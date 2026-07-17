#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const analysis = require('../buildings/jarvis/saved-channel-analysis');

assert.strictEqual(analysis.contract.features.length, 21, 'saved channels must expose exactly 21 canonical outputs');
assert.deepStrictEqual(analysis.contract.groups.map(group => group.key), ['visual', 'text', 'together', 'novelty']);

const videos = [];
for (let index = 0; index < 96; index++) {
    const signal = Math.sin(index * 0.41) + ((index * 17) % 11) / 20;
    const features = {};
    analysis.contract.features.forEach((feature, featureIndex) => {
        if (feature.group === 'text' && index % 4 === 0) return;
        const percentile = feature.key === 'visual.keep'
            ? 50 + signal * 24
            : 50 + Math.sin(index * (featureIndex + 3) * 0.73) * 28;
        features[feature.key] = [percentile, percentile];
    });
    const logViews = 5.4 + signal * 0.72 + Math.sin(index * 2.17) * 0.04;
    videos.push({
        id: `v${String(index).padStart(10, '0')}`,
        title: `Synthetic Short ${index}`,
        status: 'done',
        silent: index % 4 === 0,
        views: Math.round(Math.pow(10, logViews)),
        features,
    });
}

const first = analysis.analyzeChannel({ id: 'chtest', name: 'Synthetic', videos });
assert.strictEqual(first.status, 'ready');
assert.strictEqual(first.n, 96);
assert.strictEqual(first.search.exhaustiveCandidates, 1561);
assert.strictEqual(first.singles[0].key, 'visual.keep', 'the known synthetic signal must rank first');
assert(first.singles[0].oof.r2 > 0.8, 'known signal should predict unseen rows');
assert(first.models.nestedSelected.r2 > 0.7, 'nested selection should recover the held-out signal');
assert.strictEqual(first.models.nestedSelected.points.length, videos.length);
assert(first.singles.find(row => row.key === 'text.keep').coverage < 1, 'missing transcripts must be reported, not silently counted as observed');

const second = analysis.analyzeChannel({ id: 'chtest', name: 'Synthetic', videos });
assert.deepStrictEqual(
    { singles: first.singles, combinations: first.topCombinations, path: first.forwardPath, nested: first.models.nestedSelected },
    { singles: second.singles, combinations: second.topCombinations, path: second.forwardPath, nested: second.models.nestedSelected },
    'analysis must be deterministic'
);

const insufficient = analysis.analyzeChannel({ id: 'small', videos: videos.slice(0, 7) });
assert.strictEqual(insufficient.status, 'insufficient');

const ui = fs.readFileSync(path.join(__dirname, '..', 'buildings/jarvis/jarvis-retention.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
for (const marker of ['data-savedbank', 'data-savedchanneladd', 'data-savedchannelvideo', 'Prediction analysis', 'Which single indicators predict log views?']) {
    assert(ui.includes(marker), `Shorts Experiment UI is missing ${marker}`);
}
for (const route of ['/api/raw/saved-channels', '/api/raw/saved-channel', 'savedChannelAnalysis.analyzeChannel']) {
    assert(server.includes(route), `server is missing ${route}`);
}

console.log(JSON.stringify({
    ok: true,
    features: analysis.contract.features.length,
    candidates: first.search.exhaustiveCandidates,
    topSingle: first.singles[0].key,
    topSingleOofR2: first.singles[0].oof.r2,
    nestedOofR2: first.models.nestedSelected.r2,
}));
