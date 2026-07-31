#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    _predictionMetrics,
    _purgeContentFamilyOverlap,
    contentFamilyId,
    evaluateBinaryFeatureSet,
    foldAssignments,
    stratifiedFoldAssignments,
} = require('./saved-channel-analysis');

const metric = _predictionMetrics(
    [0, 10, 20],
    [5, 5, 5],
    [0, 0, 0]
);
assert.strictEqual(metric.n, 3);
assert(Math.abs(metric.r2 - (-0.375)) < 1e-12);
assert(Math.abs(metric.protocolBaselineR2 - 0.45) < 1e-12);
assert.notStrictEqual(
    metric.r2,
    metric.protocolBaselineR2,
    'conventional R2 and protocol-baseline skill are different estimands'
);

const missing = _predictionMetrics(
    [0, 10, 20],
    [0, Number.NaN, 20],
    [0, 0, 0]
);
assert.strictEqual(missing.n, 2);
assert.strictEqual(missing.total, 3);
assert.strictEqual(missing.missingPairsExcluded, 1);
assert.strictEqual(missing.r2, 1);

const empty = _predictionMetrics([], [], []);
assert.strictEqual(empty.n, 0);
assert.strictEqual(empty.total, 0);
assert.strictEqual(empty.missingPairsExcluded, 0);
assert.strictEqual(empty.protocolBaselineR2, null);

const groupedRows = [
    { id: 'a', title: 'same title', y: 0 },
    { id: 'b', title: 'same title', y: 1 },
    { id: 'c', title: 'different c', y: 0 },
    { id: 'd', title: 'different d', y: 1 },
    { id: 'e', title: 'different e', y: 0 },
    { id: 'f', title: 'different f', y: 1 },
    { id: 'g', title: 'different g', y: 0 },
    { id: 'h', title: 'different h', y: 1 },
];
const assignment = foldAssignments(groupedRows, 3);
assert.strictEqual(
    assignment.assignments[0],
    assignment.assignments[1],
    'duplicate content families must remain in one fold'
);

const purge = _purgeContentFamilyOverlap(
    [
        { id: 'train-copy', title: 'same title' },
        { id: 'train-safe', title: 'different title' },
    ],
    [{ id: 'test-copy', title: 'same title' }]
);
assert.deepStrictEqual(
    purge.rows.map(row => row.id),
    ['train-safe']
);
assert.strictEqual(purge.audit.purged, 1);

const transformedReposts = [
    {
        id: 'repost-original',
        title: '  The SAME short!!! ',
        y: 1,
        video: {
            input_manifest: {
                canonical_montage: {
                    montage_sha256: 'a'.repeat(64),
                },
            },
        },
    },
    {
        id: 'repost-reencoded',
        title: 'the same short',
        y: 0,
        video: {
            input_manifest: {
                canonical_montage: {
                    montage_sha256: 'b'.repeat(64),
                },
            },
        },
    },
    ...groupedRows.slice(2),
];
assert.strictEqual(
    contentFamilyId(transformedReposts[0]),
    contentFamilyId(transformedReposts[1]),
    'normalized semantic identity must group a re-encoded repost before exact montage bytes',
);
const transformedAssignment = foldAssignments(transformedReposts, 3);
assert.strictEqual(
    transformedAssignment.assignments[0],
    transformedAssignment.assignments[1],
    'different montage hashes cannot split a semantic repost family',
);
assert.strictEqual(
    contentFamilyId({
        id: 'source-a',
        title: 'unrelated title a',
        sourceContentId: 'stable-source-lineage',
    }),
    contentFamilyId({
        id: 'source-b',
        title: 'unrelated title b',
        source_content_id: 'STABLE-SOURCE-LINEAGE',
    }),
    'stable source lineage must dominate mutable titles and montage encodings',
);

const oneClassFamilyRows = [
    ...Array.from({ length: 5 }, (_, index) => ({
        id: `positive-${index}`,
        title: `positive family ${index}`,
        y: 1,
        canonicalFeatureCells: {
            'visual.keep': { value: 60 + index },
        },
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
        id: `negative-${index}`,
        title: 'one shared negative family',
        y: 0,
        canonicalFeatureCells: {
            'visual.keep': { value: 30 + index },
        },
    })),
];
assert.strictEqual(
    stratifiedFoldAssignments(oneClassFamilyRows, 5),
    null,
    'binary grouped CV must fail when class-bearing family counts cannot support two valid folds',
);
assert.strictEqual(
    evaluateBinaryFeatureSet(
        oneClassFamilyRows,
        ['visual.keep'],
        5,
        1,
        true
    ),
    null,
    'binary evaluation must fail closed rather than train on a one-class split',
);

process.stdout.write(JSON.stringify({
    passed: true,
    checks: 21,
}) + '\n');
