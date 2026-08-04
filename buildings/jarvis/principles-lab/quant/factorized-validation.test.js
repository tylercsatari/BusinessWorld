#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    blindResidualScale,
    duplicateGroups,
    fitRidge,
    forwardFolds,
    groupFolds,
    logScoreBits,
    purgeLeakageGroupOverlap,
    regressionReport,
} = require('./factorized-validation');

const ridge = fitRidge(
    [[0], [1], [2], [3], [4]],
    [1, 3, 5, 7, 9],
    0.01
);
const ridgePrediction = ridge.predict([[5]])[0];
assert(Math.abs(ridgePrediction - 11) < 0.1, 'ridge fit should recover a simple line');

const groupedRows = Array.from({ length: 60 }, (_, index) => ({
    id: String(index),
    source: index < 30 ? 'one' : 'two',
}));
assert.strictEqual(groupFolds(groupedRows).length, 2);
for (const fold of groupFolds(groupedRows)) {
    const trainSources = new Set(fold.train.map(row => row.source));
    assert(!fold.test.some(row => trainSources.has(row.source)));
}

const crossSourceCopies = groupedRows.map(row => ({
    ...row,
    copyGroup:
        row.id === '0' || row.id === '30'
            ? 'same-upload'
            : `copy-${row.id}`,
}));
for (const fold of groupFolds(crossSourceCopies)) {
    const testCopies = new Set(fold.test.map(row => row.copyGroup));
    assert(
        !fold.train.some(row => testCopies.has(row.copyGroup)),
        'whole-source folds must purge duplicate content from training'
    );
}
const directPurge = purgeLeakageGroupOverlap(
    [{ id: 'a', copyGroup: 'same' }, { id: 'b', copyGroup: 'other' }],
    [{ id: 'c', copyGroup: 'same' }]
);
assert.deepStrictEqual(directPurge.rows.map(row => row.id), ['b']);

const datedRows = Array.from({ length: 40 }, (_, index) => ({
    id: String(index),
    source: 'one',
    publishedAt: Date.UTC(2024, 0, index + 1),
    copyGroup:
        index === 2 || index === 30
            ? 'chronological-copy'
            : `dated-${index}`,
}));
for (const fold of forwardFolds(datedRows)) {
    assert(
        Math.max(...fold.train.map(row => row.publishedAt))
            < Math.min(...fold.test.map(row => row.publishedAt))
    );
    const testCopies = new Set(fold.test.map(row => row.copyGroup));
    assert(!fold.train.some(row => testCopies.has(row.copyGroup)));
}

const copies = duplicateGroups([
    { text: 'this is a simple repeated opening phrase now' },
    { text: 'this is a simple repeated opening phrase now' },
    { text: 'a completely unrelated sentence about another topic' },
]);
assert.strictEqual(copies[0], copies[1]);
assert.notStrictEqual(copies[0], copies[2]);

const baseline = [0, 1, 2, 3].map((actual, index) => ({
    key: String(index),
    fold: index < 2 ? 'a' : 'b',
    actual,
    predicted: 1.5,
    sigma: 2,
    highLabel: actual >= 2,
}));
const improved = baseline.map(row => ({
    ...row,
    predicted: row.actual + 0.1,
    sigma: 0.5,
}));
assert(logScoreBits(improved, baseline).bitsPerObservation > 0);
const report = regressionReport(improved);
assert(report.calibration && report.discrimination);

const uncertaintyRows = Array.from({ length: 90 }, (_, index) => {
    const source = `source-${Math.floor(index / 30)}`;
    const signal = (index % 30) / 10;
    return {
        id: `uncertainty-${index}`,
        source,
        copyGroup: `uncertainty-${index}`,
        y: 2 + 3 * signal + ((index * 17) % 7 - 3) * 0.2,
        features: { signal },
    };
});
const uncertainty = blindResidualScale(
    uncertaintyRows,
    'grouped',
    ['signal'],
    {
        controls: [],
        includeOpportunity: false,
        includeAge: false,
    }
);
assert(Number.isFinite(uncertainty.sigma) && uncertainty.sigma > 0);
assert.strictEqual(uncertainty.residualN, uncertaintyRows.length);
assert.strictEqual(
    uncertainty.method,
    'fully_nested_inner_holdout_rmse'
);

const outputPath = path.join(__dirname, 'factorized-validation.json');
assert(fs.existsSync(outputPath), 'analysis result must exist');
const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
assert.strictEqual(output.schema, 'business-world-factorized-validation-v1');
assert.strictEqual(output.leakageAudit.passed, true);
assert(
    output.leakageAudit.numericalSanity.maximumAbsolutePredictiveBitsPerObservation < 8
);
assert(
    !output.outOfDistributionPredictiveBits.summary.tentative.includes(
        'promise-opening-10s'
    ),
    'a constant cohort forecast must not be promoted as video discrimination'
);

process.stdout.write(JSON.stringify({
    passed: true,
    checks: 15,
    output: path.relative(process.cwd(), outputPath),
}) + '\n');
