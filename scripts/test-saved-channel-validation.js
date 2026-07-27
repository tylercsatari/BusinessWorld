#!/usr/bin/env node
'use strict';

const assert = require('assert');
const validation = require('../buildings/jarvis/saved-channel-validation');

assert.strictEqual(validation.contract.features.length, 21);
assert.strictEqual(
    validation.contract.features.find(feature => feature.key === 'novelty.views').unit,
    'log10_views',
    'novelty views must not be logged twice during validation'
);

const blindNames = [
    ...['visual', 'text', 'together'].flatMap(group =>
        ['keep', 'ret5', 'views', 'realviews', 'outlier', 'gt10M'].flatMap(target => [
            `${group}.${target}.raw`,
            `${group}.${target}.percentile`,
        ])
    ),
    'novelty.temporal.raw',
    'novelty.temporal.percentile',
    'novelty.niche.raw',
    'novelty.niche.percentile',
    'novelty.combinatorial.raw',
    'novelty.combinatorial.percentile',
    'text.present',
    'duration.log',
    'title.words',
];
assert.strictEqual(blindNames.length, 45);

function blindVector(index) {
    return blindNames.map(name => {
        if (name.endsWith('.percentile')) return 20 + index * 12;
        if (name.endsWith('.views.raw') || name.endsWith('.realviews.raw')) return 6 + index * .1;
        if (name.endsWith('.gt10M.raw')) return .15 + index * .12;
        if (name.endsWith('.outlier.raw')) return .5 + index * .1;
        if (name.endsWith('.keep.raw')) return 52 + index * 4;
        if (name.endsWith('.ret5.raw')) return 66 + index * 3;
        return 1 + index * .1;
    });
}

function savedFeatures(index) {
    return Object.fromEntries(validation.contract.features.map(feature => {
        let raw;
        if (feature.unit === 'views') raw = 10 ** (5.7 + index * .15);
        else if (feature.unit === 'log10_views') raw = 5.8 + index * .15;
        else if (feature.unit === 'probability') raw = .1 + index * .12;
        else if (feature.unit === 'percent') raw = 50 + index * 5;
        else raw = .5 + index * .2;
        return [feature.key, [raw, 15 + index * 15]];
    }));
}

const channels = validation.SUPPORTED_CHANNELS.map((definition, channelIndex) => {
    const videos = Array.from({ length: 4 }, (_, index) => {
        const id = `${definition.accountId}-${index}`;
        return {
            id,
            title: `${definition.accountName} fixture ${index}`,
            status: 'done',
            published: `20250${index + 1}01`,
            subscribers: channelIndex ? 200000 : 100000,
            views: 10 ** (5.8 + index * .2 + channelIndex * .05),
            features: savedFeatures(index),
        };
    });
    return {
        ...definition,
        manifest: { videos },
        privateTable: {
            videos: videos.map((video, index) => ({
                id: video.id,
                title: video.title,
                keep_rate: 50 + index * 6 + channelIndex,
                ret5: 65 + index * 4,
                avg_retention: 82 - index,
                views: video.views * .8,
                duration_s: 24 + index,
                published: video.published,
            })),
        },
    };
});

const allRows = channels.flatMap(source => source.privateTable.videos.map((row, index) => ({
    id: row.id,
    title: row.title,
    account: source.accountId,
    accountName: source.accountName,
    videoHeldOut: blindVector(index),
    accountHeldOut: blindVector(index).map((value, featureIndex) => featureIndex % 2 ? value : value - 1),
})));
const keepPoints = allRows.map((row, index) => ({
    id: row.id,
    predicted: 49 + (index % 4) * 6,
    actual: 50 + (index % 4) * 6,
}));
const viewsPoints = channels.flatMap(source => source.manifest.videos.map((row, index) => ({
    id: row.id,
    channel: source.channelId,
    actualViews: row.views,
    predictedViews: row.views * 1.2,
})));
const predictor = {
    generatedAt: 123456,
    provenance: {
        savedAxisTrainingIdOverlap: 0,
        featureScorerVersionPersistedPerVideo: false,
    },
    targets: {
        keep: {
            points: keepPoints,
            blindInputs: {
                featureNames: blindNames,
                videoHeldOutProtocol: 'synthetic video holdout',
                accountHeldOutProtocol: 'synthetic account holdout',
                rows: allRows,
            },
            stressTests: [
                { label: 'Unseen-account transfer', points: keepPoints.map(point => ({ ...point, predicted: point.predicted - 2 })) },
                { label: 'Forward-time keep-rate transfer', points: keepPoints.slice(2) },
            ],
        },
        views: {
            points: viewsPoints,
            stressTests: [
                { label: 'Unseen-channel transfer', points: viewsPoints.map(point => ({ ...point, predictedViews: point.actualViews * .9 })) },
                { label: 'Forward-time public-views transfer', points: viewsPoints.slice(2) },
            ],
        },
    },
};

const result = validation.buildValidation({
    channels,
    predictor,
    generatedAt: 999,
    sourceFingerprint: 'fixture',
});

assert.strictEqual(result.rows.length, 8);
assert.strictEqual(result.scopes.pooled.n, 8);
assert.strictEqual(result.scopes.tyler.n, 4);
assert.strictEqual(result.scopes.hafu.n, 4);
assert.strictEqual(result.joinSummary.reduce((sum, row) => sum + row.matchedRows, 0), 8);
assert(result.leakageAudit.passedForBlindInputs, 'all blind arrays should align to the immutable 45-feature contract');
assert.strictEqual(result.leakageAudit.privateRowsExcludedFromPublicAxis, true);
assert.strictEqual(result.leakageAudit.savedRowsExcludedFromPublicAxis, true);
assert.strictEqual(result.rows[0].blindFeatureNames.length, 45);
assert.strictEqual(result.scopes.pooled.storedIndicators.length, 21);
assert.strictEqual(result.scopes.pooled.blindVideoIndicators.length, 36);
assert.strictEqual(result.scopes.pooled.blindAccountIndicators.length, 36);

const firstRow = result.rows.find(row => row.id === 'tyler-0');
assert(firstRow);
assert(Math.abs(firstRow.predictions.viewsPublicAxis.visual - 999999) < 1, 'log10 public-axis values must convert back to ordinary views');
assert(Math.abs(firstRow.predictions.viewsPublicAxisEnsemble - 999999) < 1);

const blindPercentile = result.scopes.pooled.blindVideoIndicators.find(item => item.key === 'visual.keep.percentile');
assert(blindPercentile);
assert.strictEqual(blindPercentile.metrics.mae, undefined, 'rank coordinates must not claim percentage-point calibration error');
assert.strictEqual(typeof blindPercentile.metrics.spearman, 'number');
assert(result.scopes.tyler.storedIndicators.find(item => item.key === 'visual.keep').warning.includes('in-sample'));
assert(result.scopes.hafu.storedIndicators.find(item => item.key === 'visual.keep').warning.includes('account-external'));

console.log(JSON.stringify({
    ok: true,
    joined: result.rows.length,
    storedIndicators: result.scopes.pooled.storedIndicators.length,
    blindIndicators: result.scopes.pooled.blindVideoIndicators.length,
    strictViews: firstRow.predictions.viewsPublicAxisEnsemble,
}));
