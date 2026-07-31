#!/usr/bin/env node
'use strict';

const assert = require('assert');
const contract = require(
    '../buildings/jarvis/saved-channel-feature-contract.json'
);
const governance = require(
    '../buildings/jarvis/quant-coordinate-governance.json'
);
const validation = require(
    '../buildings/jarvis/saved-channel-validation'
);

const expectedStoredFeatures = [
    'visual.keep',
    'visual.ret5',
    'visual.views',
    'visual.realviews',
    'visual.outlier',
    'visual.gt10M',
    'text.keep',
    'text.ret5',
    'text.views',
    'text.realviews',
    'text.outlier',
    'text.gt10M',
    'together.keep',
    'together.ret5',
    'together.views',
    'together.realviews',
    'together.outlier',
    'together.gt10M',
    'novelty.keep',
    'novelty.ret5',
    'novelty.views',
];
const shortsMaps = Object.entries(
    contract.lineageContract.registries.visualizationMaps
).filter(([, definition]) => definition.domain === 'shorts');

assert.deepStrictEqual(
    contract.features.map(feature => feature.key),
    expectedStoredFeatures,
    'retiring a visualization plane must not change the stored scorer contract'
);
assert.strictEqual(contract.crossDomainInventory.shorts.storedOutputs, 21);
assert.strictEqual(
    contract.crossDomainInventory.shorts.mapProjections.includes('swipe'),
    false,
    'the canonical projection inventory must not advertise swipe'
);
assert.strictEqual(
    shortsMaps.some(([id, definition]) => (
        id === 'map.shorts.swipe.v1'
        || definition.mapKey === 'swipe'
        || definition.target === '100 - keep'
    )),
    false,
    'no canonical fitted/map swipe plane may be registered'
);

const registry = validation.buildCoordinateRegistry();
assert.deepStrictEqual(
    registry.columns
        .filter(column => column.family === 'stored')
        .map(column => column.key),
    expectedStoredFeatures,
    'runtime validation must preserve the same 21 stored scorer cells'
);
assert.strictEqual(
    registry.shortsMapProjections.keys.includes('swipe'),
    false,
    'runtime map projection inventory must not advertise swipe'
);
assert.strictEqual(
    registry.shortsMapProjections.mapIds.includes('map.shorts.swipe.v1'),
    false,
    'runtime map IDs must not expose the retired swipe plane'
);

const observedSwipe = registry.displayTransforms.find(
    transform => transform.id === 'shorts.observed.swipe'
);
assert(observedSwipe, 'the governed observed swipe display must remain');
assert.strictEqual(observedSwipe.sourceCoordinateId, 'shorts.observed.keep');
assert.strictEqual(observedSwipe.formula, '100 - source');
assert.strictEqual(observedSwipe.stored, false);
assert.strictEqual(observedSwipe.predictorEligible, false);
assert.strictEqual(
    registry.columns.some(column => column.id === observedSwipe.id),
    false,
    'the display transform must remain outside the stored ledger'
);
assert.deepStrictEqual(
    governance.displayTransforms.find(
        transform => transform.id === 'shorts.observed.swipe'
    ),
    {
        id: 'shorts.observed.swipe',
        sourceCoordinateId: 'shorts.observed.keep',
        formula: '100 - source',
        protocol: 'observed',
        unit: 'percent',
        stored: false,
        predictorEligible: false,
    }
);

contract.crossDomainInventory.shorts.mapProjections.push('swipe');
try {
    assert.throws(
        () => validation.buildCoordinateRegistry(),
        /retired-swipe-projection-advertised:swipe/,
        'runtime validation must fail closed if swipe is re-advertised as a map'
    );
} finally {
    contract.crossDomainInventory.shorts.mapProjections.pop();
}

console.log(JSON.stringify({
    ok: true,
    storedScorerFeatures: expectedStoredFeatures.length,
    canonicalShortsMapPlanes: shortsMaps.length,
    swipeMapAdvertised: false,
    observedSwipeDisplayTransform: '100 - keep',
}));
