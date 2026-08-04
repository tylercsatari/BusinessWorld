#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const contract = require('../buildings/jarvis/together-concat-keep-interaction-contract');
const validation = require('../buildings/jarvis/saved-channel-validation');

const artifact = contract.ARTIFACT;
const coordinateId = 'shorts.interaction.together-channel-free-concat.keep.v1';
const hashValues = values => crypto.createHash('sha256')
    .update(JSON.stringify(values.map(String).sort()))
    .digest('hex');
const rounded = (value, digits = 4) => Number(Number(value).toFixed(digits));

assert.strictEqual(contract.AUDIT.valid, true, contract.AUDIT.errors.join('; '));
assert.strictEqual(contract.AUDIT.rows, 211);
assert.strictEqual(artifact.coordinateId, coordinateId);
assert.deepStrictEqual(artifact.source.inputCoordinateIds, [
    'shorts.stored.together.keep',
    'shorts.channel-free.concat.keep',
]);
assert.strictEqual(artifact.source.targetCoordinateId, 'shorts.observed.keep');
assert.strictEqual(artifact.protocol.candidateCount, 23);
assert.strictEqual(artifact.protocol.candidates.length, 23);
assert.strictEqual(new Set(artifact.protocol.candidates.map(row => row.id)).size, 23);
assert(artifact.protocol.interactionFeatures.includes('together_x_concat'));
assert(artifact.protocol.interactionFeatures.includes('together_div_concat'));
assert(artifact.protocol.interactionFeatures.includes('log_together_div_concat'));
assert.strictEqual(artifact.generatorSourceSha256, contract.GENERATOR_SHA256);
assert.strictEqual(artifact.protocol.chartTrainingRowsRead, 0);
assert.strictEqual(artifact.protocol.chartTrainingOutcomesRead, 0);

const rows = artifact.rows;
const rowIds = rows.map(row => String(row.id));
assert.strictEqual(new Set(rowIds).size, rows.length);
assert.deepStrictEqual([...new Set(rows.map(row => row.fold))].sort(), [0, 1, 2, 3, 4]);
for (const selection of artifact.outerSelections) {
    const test = rows.filter(row => row.fold === selection.fold);
    const train = rows.filter(row => row.fold !== selection.fold);
    const population = selection.populationAudit;
    assert.strictEqual(test.length, selection.testRows);
    assert.strictEqual(train.length, selection.trainRows);
    assert.strictEqual(population.videoIdOverlapCount, 0);
    assert.strictEqual(population.contentFamilyOverlapCount, 0);
    assert.strictEqual(
        population.trainingVideoIdSha256,
        hashValues(train.map(row => row.id))
    );
    assert.strictEqual(
        population.testingVideoIdSha256,
        hashValues(test.map(row => row.id))
    );
    assert.strictEqual(
        population.trainingContentFamilySha256,
        hashValues(train.map(row => row.contentFamilyId))
    );
    assert.strictEqual(
        population.testingContentFamilySha256,
        hashValues(test.map(row => row.contentFamilyId))
    );
    assert.strictEqual(selection.innerFoldAudit.length, 4);
    assert(selection.innerFoldAudit.every(split => (
        split.videoIdOverlapCount === 0
        && split.contentFamilyOverlapCount === 0
        && /^[a-f0-9]{64}$/.test(split.trainingVideoIdSha256)
        && /^[a-f0-9]{64}$/.test(split.testingVideoIdSha256)
    )));
}

const mae = rows.reduce(
    (sum, row) => sum + Math.abs(row.prediction - row.actualKeep),
    0
) / rows.length;
assert.strictEqual(rounded(mae), artifact.results.nestedCombined.mae);
assert(rows.every(row => (
    rounded(Math.abs(row.prediction - row.actualKeep)) === row.absoluteError
)));
assert(artifact.results.nestedCombined.mae < artifact.results.rawStoredTogether.mae);
assert(artifact.results.nestedCombined.mae < artifact.results.rawChannelFreeConcat.mae);
assert(artifact.results.nestedCombined.within10pp >= 0.98);

const fairGain = artifact.results.incrementalVsCalibratedTogether;
assert(Math.abs(fairGain.meanImprovementPp) < 0.1);
assert(fairGain.ci95[0] <= 0 && fairGain.ci95[1] >= 0);
assert.strictEqual(fairGain.draws, 20000);
assert(
    artifact.results.upstreamLeakageSensitivity.nestedCombined.mae
    > artifact.results.nestedCombined.mae
);
const groups = artifact.results.trainingFoldQuadrants.groups;
assert(groups.both_high.meanActualKeep > groups.mixed.meanActualKeep);
assert(groups.mixed.meanActualKeep > groups.both_low.meanActualKeep);
assert.strictEqual(
    artifact.claimBoundary.status,
    'research_diagnostic_not_predictor_eligible'
);

const registry = validation.buildCoordinateRegistry();
assert.strictEqual(registry.columns.length, 94);
assert.strictEqual(new Set(registry.columns.map(column => column.id)).size, 94);
const coordinate = registry.columns.find(column => column.id === coordinateId);
assert(coordinate, 'interaction coordinate is absent from the ledger');
assert.strictEqual(coordinate.family, 'keepInteraction');
assert.strictEqual(coordinate.status, 'research_diagnostic');
assert.strictEqual(coordinate.predictorEligible, false);
assert.strictEqual(coordinate.valueClass, 'combined_forecast');
assert.deepStrictEqual(
    coordinate.lineage.exactSourceCoordinateIds,
    artifact.source.inputCoordinateIds
);
assert.strictEqual(
    coordinate.lineage.reproducibility.artifactSha256,
    contract.ARTIFACT_SHA256
);
assert(!registry.classification.blind.families.includes('keepInteraction'));
assert.strictEqual(
    registry.families.find(family => family.key === 'keepInteraction').count,
    1
);

const uiSource = fs.readFileSync(
    path.join(ROOT, 'buildings/jarvis/jarvis-retention.js'),
    'utf8'
);
assert(uiSource.includes('data-keep-interaction-study'));
assert(uiSource.includes('data-keep-interaction-quadrants'));
assert(uiSource.includes('data-keep-interaction-incremental'));
assert(uiSource.includes('upstream stored Together axis used Tyler labels'));
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
assert(serverSource.includes(
    'local:predictor-lab/together-concat-keep-interaction.json'
));
assert(serverSource.includes(
    'local:together-concat-keep-interaction-contract.js'
));
assert(serverSource.includes(
    'local:predictor-lab/run_together_concat_keep_interaction.py'
));

console.log('together + channel-free concat interaction contract tests passed');
