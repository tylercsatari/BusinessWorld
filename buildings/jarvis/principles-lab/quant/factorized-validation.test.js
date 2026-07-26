#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    duplicateGroups,
    fitRidge,
    forwardFolds,
    groupFolds,
    logScoreBits,
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

const datedRows = Array.from({ length: 40 }, (_, index) => ({
    id: String(index),
    source: 'one',
    publishedAt: Date.UTC(2024, 0, index + 1),
}));
for (const fold of forwardFolds(datedRows)) {
    assert(
        Math.max(...fold.train.map(row => row.publishedAt))
            <= Math.min(...fold.test.map(row => row.publishedAt))
    );
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
    checks: 9,
    output: path.relative(process.cwd(), outputPath),
}) + '\n');
