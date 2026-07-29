#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const validation = require('../buildings/jarvis/saved-channel-validation');
const featureContractPath = path.join(__dirname, '..', 'buildings', 'jarvis', 'saved-channel-feature-contract.json');
const featureContractSha256 = crypto.createHash('sha256').update(fs.readFileSync(featureContractPath)).digest('hex');
const fixtureSha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const fixturePopulation = (label, rowCount = 24) => ({
    rowCount,
    uniqueVideoCount: rowCount,
    videoIdSha256: fixtureSha256(`population:${label}:${rowCount}`),
});
const fixtureSnakePopulation = (label, rowCount = 24) => ({
    row_count: rowCount,
    unique_video_id_count: rowCount,
    duplicate_video_id_count: 0,
    video_id_sha256: fixtureSha256(`population:${label}:${rowCount}`),
});

assert.strictEqual(validation.contract.features.length, 21);
assert.strictEqual(validation.contract.version, 5);
assert.strictEqual(validation.contract.pipeline.embeddingModel, 'gemini-embedding-2');
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
    const videos = Array.from({ length: 24 }, (_, index) => {
        const id = `${definition.accountId}-${index}`;
        return {
            id,
            title: `${definition.accountName} fixture ${index}`,
            status: 'done',
            published: `20250${index + 1}01`,
            subscribers: channelIndex ? 200000 : 100000,
            views: 10 ** (5.8 + index * .2 + channelIndex * .05),
            features: savedFeatures(index),
            visual_keep_forecast: index < 2 ? {
                coordinate_id: 'shorts.visual-keep-forecast.v1',
                raw: index === 0 ? 91.25 : 99.75,
                est: index === 0 ? 91.25 : 99.75,
                calibration_scope: 'pooled_global',
                account_model: null,
                model_artifact_sha256: index === 0
                    ? fixtureSha256('visual-keep-model')
                    : fixtureSha256('stale-visual-keep-model'),
            } : null,
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
                curve: Array.from({ length: 101 }, (_, curveIndex) => (
                    1.18 - curveIndex * (0.0045 + index * 0.00002) + channelIndex * 0.01
                )),
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
    accountHeldOut: blindVector(index).map((value, featureIndex) => {
        const featureName = blindNames[featureIndex];
        return /\.(?:views|outlier|gt10M)\.(?:raw|percentile)$/.test(featureName)
            ? value
            : (featureIndex % 2 ? value : value - 1);
    }),
})));
const blindArtifactRows = [
    ...allRows,
    ...Array.from({ length: 632 - allRows.length }, (_, index) => {
        const account = index % 2 ? 'creatinganything' : 'brushlabs';
        const signal = index % 24;
        return {
            id: `${account}-artifact-only-${index}`,
            title: `Artifact-only ${account} row ${index}`,
            account,
            accountName: account === 'creatinganything' ? 'CreatingAnything' : 'BrushLabs',
            publishedAt: Date.UTC(2024, index % 12, 1 + index % 27),
            actualKeep: 44 + signal * 2.1 + (account === 'creatinganything' ? 2 : 0),
            actualRet5: 61 + signal * 1.7,
            actualViews: 10 ** (5.1 + signal * 0.11),
            duration: 18 + signal,
            videoHeldOut: blindVector(signal),
            accountHeldOut: blindVector(signal).map((value, featureIndex) => (
                featureIndex % 2 ? value : value - 0.5
            )),
        };
    }),
];
assert.strictEqual(blindArtifactRows.length, 632);
const missingAxisRow = allRows.find(row => row.id === 'hafu-0');
missingAxisRow.videoHeldOut[blindNames.indexOf('text.views.raw')] = null;
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
const fixtureMapManifest = modality => ({
    schemaVersion: 1,
    producerSourceSha256: fixtureSha256(`short-map-producer:${modality}`),
    embeddingStore: {
        source: `raw/${modality}/embeddings.npz`,
        artifactSha256: fixtureSha256(`short-embedding:${modality}`),
        ...fixturePopulation(`short-embedding:${modality}`, 100),
    },
    publishedMap: {
        canonicalKey: `raw/${modality}/map.json`,
        archiveKey: `raw/${modality}/maps/by-sha256/${fixtureSha256(`short-map:${modality}`)}.json`,
        artifactSha256: fixtureSha256(`short-map:${modality}`),
        ...fixturePopulation(`short-map:${modality}`, 100),
    },
    publishedPlot: {
        canonicalKey: `raw/${modality}/plot.json`,
        archiveKey: `raw/${modality}/plots/by-sha256/${fixtureSha256(`short-plot:${modality}`)}.json`,
        artifactSha256: fixtureSha256(`short-plot:${modality}`),
        rowCount: 100,
    },
});
const fixtureLongMapManifest = modality => ({
    schema_version: 2,
    immutable_manifest_key: `raw-long/${modality}/manifests/by-sha256/${fixtureSha256(`long-manifest:${modality}`)}.json`,
    algorithm_generation: {
        generator_source_sha256: fixtureSha256('long-steer-source'),
    },
    embedding_archive: {
        mutable_key: `raw-long/${modality}/embeddings.npz`,
        sha256: fixtureSha256(`long-embedding:${modality}`),
        immutable_key: `raw-long/${modality}/embeddings/by-sha256/${fixtureSha256(`long-embedding:${modality}`)}.npz`,
        video_id_population: fixtureSnakePopulation(`long-embedding:${modality}`, 120),
    },
    map_artifact: {
        sha256: fixtureSha256(`long-map:${modality}`),
        immutable_key: `raw-long/${modality}/maps/by-sha256/${fixtureSha256(`long-map:${modality}`)}.json`,
    },
    plot_artifact: {
        sha256: fixtureSha256(`long-plot:${modality}`),
        immutable_key: `raw-long/${modality}/plots/by-sha256/${fixtureSha256(`long-plot:${modality}`)}.json`,
    },
    video_id_alignment_population: {
        method: 'exact_video_id',
        intersection: fixtureSnakePopulation(`long-intersection:${modality}`, 110),
    },
    account_metric_populations: {
        tyler: {
            ctr: fixtureSnakePopulation(`long:${modality}:tyler:ctr`, 40),
            ret30: fixtureSnakePopulation(`long:${modality}:tyler:ret30`, 38),
        },
        all: {
            ctr: fixtureSnakePopulation(`long:${modality}:all:ctr`, 72),
            ret30: fixtureSnakePopulation(`long:${modality}:all:ret30`, 68),
        },
    },
    label_snapshot_revisions: {
        tyler: { sha256: fixtureSha256('long-label:tyler') },
        all: { sha256: fixtureSha256('long-label:all') },
    },
});
const fixtureIndicatorRegistry = {
    indicators: ['keep', 'ret5', 'views'].map((target, index) => ({
        name: `nov_${target}`,
        kind: 'novelty',
        target,
        validated: true,
        spearman: 0.2 + index * 0.1,
        pts: [[0.1, 1], [0.2, 2], [0.3, 3]],
    })),
};
const fixtureRuntimeManifests = {
    shortsSteer: {
        key: 'raw/steer_manifest.json',
        artifactSha256: fixtureSha256('shorts-steer-manifest'),
        value: {
            artifactSha256: fixtureSha256('shorts-steer-artifact'),
            archiveKey: `raw/steer_models/by-sha256/${fixtureSha256('shorts-steer-artifact')}.npz`,
            producerSourceSha256: fixtureSha256('shorts-steer-source'),
            sourceRevisions: {
                tyler: { sha256: fixtureSha256('shorts-labels:tyler') },
                public_library: { sha256: fixtureSha256('shorts-public-library') },
            },
            viewEquationFitPopulations: {
                tyler: fixturePopulation('shorts-view-equation:tyler', 42),
                all: fixturePopulation('shorts-view-equation:all', 48),
            },
            modalities: Object.fromEntries(['visual', 'text', 'together'].map(modality => [
                modality,
                {
                    axes: Object.fromEntries(['keep', 'ret5', 'views', 'outlier', 'gt10M'].map(target => [
                        target,
                        { fitPopulation: fixturePopulation(`shorts:${modality}:${target}`, 50) },
                    ])),
                },
            ])),
        },
    },
    shortsVisualMap: {
        key: 'raw/visual/map.manifest.json',
        artifactSha256: fixtureSha256('short-map-manifest:visual'),
        value: fixtureMapManifest('visual'),
    },
    shortsTextMap: {
        key: 'raw/text/map.manifest.json',
        artifactSha256: fixtureSha256('short-map-manifest:text'),
        value: fixtureMapManifest('text'),
    },
    shortsTogetherMap: {
        key: 'raw/together/map.manifest.json',
        artifactSha256: fixtureSha256('short-map-manifest:together'),
        value: fixtureMapManifest('together'),
    },
    noveltyModels: {
        key: 'raw/novelty_models.npz',
        artifactSha256: fixtureSha256('novelty-models'),
        bytes: 100,
    },
    indicatorWeights: {
        key: 'raw/indicators/weights.npz',
        artifactSha256: fixtureSha256('indicator-weights'),
        bytes: 100,
    },
    indicatorRegistry: {
        key: 'raw/indicators/registry.json',
        artifactSha256: fixtureSha256('indicator-registry'),
        value: fixtureIndicatorRegistry,
    },
    shortsLiveScoreSource: {
        key: 'local:raw_upload.py',
        artifactSha256: fixtureSha256('raw-upload-source'),
    },
    shortsChannelWorkerSource: {
        key: 'local:yt_relay_watcher.py',
        artifactSha256: fixtureSha256('saved-channel-worker-source'),
    },
    longVisualMap: {
        key: 'raw-long/visual/map.manifest.json',
        artifactSha256: fixtureSha256('long-map-manifest:visual'),
        value: fixtureLongMapManifest('visual'),
    },
    longTextMap: {
        key: 'raw-long/text/map.manifest.json',
        artifactSha256: fixtureSha256('long-map-manifest:text'),
        value: fixtureLongMapManifest('text'),
    },
    longTogetherMap: {
        key: 'raw-long/together/map.manifest.json',
        artifactSha256: fixtureSha256('long-map-manifest:together'),
        value: fixtureLongMapManifest('together'),
    },
    longSteer: {
        key: 'raw-long/steer_models.manifest.json',
        artifactSha256: fixtureSha256('long-steer-manifest'),
        value: {
            generator_source_sha256: fixtureSha256('long-steer-source'),
            immutable_manifest_key: `raw-long/models/manifests/by-sha256/${fixtureSha256('long-steer-manifest')}.json`,
            model_artifact: {
                sha256: fixtureSha256('long-steer-artifact'),
                immutable_key: `raw-long/models/by-sha256/${fixtureSha256('long-steer-artifact')}.npz`,
            },
            label_snapshot_revisions: {
                tyler: { sha256: fixtureSha256('long-label:tyler') },
                all: { sha256: fixtureSha256('long-label:all') },
            },
        },
    },
    longVisualScorer: {
        key: 'longform/thumb-rl/scorer_visual.manifest.json',
        artifactSha256: fixtureSha256('long-frozen-manifest'),
        value: {
            artifactSha256: fixtureSha256('long-frozen-artifact'),
            archiveKey: `longform/thumb-rl/by-sha256/${fixtureSha256('long-frozen-artifact')}.npz`,
            producerSourceSha256: fixtureSha256('thumb-producer-source'),
            populations: {
                privateCtrFit: fixturePopulation('long-frozen-ctr', 55),
                curatedViewsFit: fixturePopulation('long-frozen-curated', 70),
            },
            sourceRevisions: {
                curatedIds: { sha256: fixtureSha256('long-curated-source') },
            },
        },
    },
    longScoreSource: {
        key: 'local:longquant_score.py',
        artifactSha256: fixtureSha256('long-score-source'),
    },
};
const predictor = {
    generatedAt: 123456,
    provenance: {
        privateAxisTrainingIdOverlap: 0,
        savedAxisTrainingIdOverlap: 0,
        validationCreatorAxisTrainingIdOverlap: 0,
        validationCreatorVideoCountExcluded: 16,
        validationCreatorChannelIds: ['UCfixtureTyler', 'UCfixtureHafu'],
        featureScorerVersionPersistedPerVideo: false,
        featureContractVersion: validation.contract.version,
        featureContractSha256,
        artifactSha256: fixtureSha256('predictor-artifact'),
        artifactArchiveKey: `raw/predictor-lab/by-sha256/${fixtureSha256('predictor-artifact')}.json`,
        artifactManifestKey: 'raw/predictor-lab/results.manifest.json',
        artifactManifestSha256: fixtureSha256('predictor-manifest'),
        artifactGeneratedAt: 123456,
        producerSourceSha256: fixtureSha256('predictor-source'),
        sourceArtifacts: {
            'fixture:source': {
                sha256: fixtureSha256('predictor-source-artifact'),
                bytes: 123,
            },
        },
        runtimeManifests: fixtureRuntimeManifests,
        rawAxisCorpusVideoCount: 1234,
        rawAxisCorpusIdHash: fixtureSha256('candidate-union'),
        publicAxisExcludedVideoCount: 321,
        publicAxisExcludedVideoIdHash: fixtureSha256('excluded'),
        rawStoreShape: {
            visual: { rows: 1100, dimensions: 1536, idSha256: fixtureSha256('visual-store') },
            text: { rows: 700, dimensions: 1536, idSha256: fixtureSha256('text-store') },
            together: { rows: 1000, dimensions: 1536, idSha256: fixtureSha256('together-store') },
        },
        publicAxisPopulations: Object.fromEntries(['visual', 'text', 'together'].map((modality, modalityIndex) => [
            modality,
            {
                views: { rowCount: 900 - modalityIndex * 100, videoIdSha256: fixtureSha256(`${modality}-views`) },
                outlier: { rowCount: 800 - modalityIndex * 100, videoIdSha256: fixtureSha256(`${modality}-outlier`) },
                gt10M: { rowCount: 900 - modalityIndex * 100, videoIdSha256: fixtureSha256(`${modality}-gt10M`) },
            },
        ])),
    },
    targets: {
        keep: {
            points: keepPoints,
            visualOnlyStudy: {
                schemaVersion: 2,
                label: 'Fixture visual-only keep study',
                coordinateId: 'shorts.visual-keep-forecast.v1',
                population: { n: 632, accounts: [], embeddingDimensions: 1536 },
                protocols: {},
                formula: {
                    selected: { pooledAlpha: 1, accountAlpha: 1, accountWeight: .75 },
                },
                production: {
                    fitPopulation: {
                        n: blindArtifactRows.length,
                        videoIdSha256: fixtureSha256('visual-keep-fit-population'),
                        byAccount: {
                            tyler: fixturePopulation('visual-keep-fit-tyler', blindArtifactRows.filter(row => row.account === 'tyler').length),
                            hafu: fixturePopulation('visual-keep-fit-hafu', blindArtifactRows.filter(row => row.account === 'hafu').length),
                        },
                    },
                    points: blindArtifactRows.map((row, index) => ({
                        id: row.id,
                        predicted: 45 + index % 40,
                        pooledPrediction: 45 + index % 40,
                        calibrationScope: 'pooled_global',
                    })),
                },
                modelArtifact: {
                    artifactSha256: fixtureSha256('visual-keep-model'),
                    canonicalKey: 'raw/predictor-lab/visual-keep-model-v1.json',
                    archiveKey: `raw/predictor-lab/visual-keep-model/by-sha256/${fixtureSha256('visual-keep-model')}.json`,
                    producerSourceSha256: fixtureSha256('visual-keep-producer'),
                    generatedAt: 123456,
                },
                promotion: { promoted: false, status: 'fixture' },
            },
            blindInputs: {
                featureNames: blindNames,
                videoHeldOutProtocol: 'synthetic video holdout',
                accountHeldOutProtocol: 'synthetic account holdout',
                rows: blindArtifactRows,
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
    sourceFingerprint: fixtureSha256('fixture'),
});

assert.strictEqual(result.version, validation.VERSION);
assert.strictEqual(result.visualKeepStudy, predictor.targets.keep.visualOnlyStudy);
assert.strictEqual(result.rows.length, 48);
assert.strictEqual(result.validationRows.length, 632);
assert(result.validationRows.every(row => row.scoreLedger && row.scoreLedger.values.length === 104));
assert(result.validationRows.every(row => !Object.prototype.hasOwnProperty.call(row, 'blindVideoHeldOut')));
assert(result.validationRows.every(row => !Object.prototype.hasOwnProperty.call(row, 'blindAccountHeldOut')));
assert.strictEqual(result.scopes.pooled.n, 48);
assert.strictEqual(result.scopes.pooled.validationN, 632);
assert.strictEqual(result.validationCohort.totalRows, 632);
assert.strictEqual(result.validationCohort.blindOnlyRows, 584);
assert.strictEqual(result.leakageAudit.validationAccountCount, 4);
assert.strictEqual(result.leakageAudit.savedDrilldownAccountCount, 2);
assert.strictEqual(result.scopes.tyler.n, 24);
assert.strictEqual(result.scopes.hafu.n, 24);
assert.strictEqual(result.joinSummary.reduce((sum, row) => sum + row.matchedRows, 0), 48);
assert(result.leakageAudit.passedForBlindInputs, 'all blind arrays should align to the immutable 45-feature contract');
assert.strictEqual(result.leakageAudit.privateRowsExcludedFromPublicAxis, true);
assert.strictEqual(result.leakageAudit.savedRowsExcludedFromPublicAxis, true);
assert.strictEqual(result.leakageAudit.validationCreatorsExcludedFromPublicAxis, true);
const leakedResult = validation.buildValidation({
    channels,
    predictor: {
        ...predictor,
        provenance: {
            ...predictor.provenance,
            validationCreatorAxisTrainingIdOverlap: 1,
        },
    },
    generatedAt: 1000,
    sourceFingerprint: fixtureSha256('fixture-with-creator-leakage'),
});
assert.strictEqual(leakedResult.leakageAudit.passedForBlindInputs, false, 'creator overlap must fail the blind audit instead of being hard-coded green');
assert.strictEqual(leakedResult.leakageAudit.validationCreatorsExcludedFromPublicAxis, false);
const { publicAxisPopulations: omittedHistoricalPopulation, ...historicalProvenance } = predictor.provenance;
let historicalPopulationError = null;
try {
    validation.buildValidation({
        channels,
        predictor: { ...predictor, provenance: historicalProvenance },
        generatedAt: 1001,
        sourceFingerprint: fixtureSha256('fixture-historical-public-population'),
    });
} catch (error) {
    historicalPopulationError = error;
}
assert(historicalPopulationError, 'an artifact without exact public fit populations must be quarantined');
assert(
    historicalPopulationError.lineageAudit.runtimeProvenanceMissing.includes(
        'dataset.shorts.creator-excluded-public.v1:runtimeSnapshot.modalityTargetPopulations'
    )
);
let malformedPublicPopulationError = null;
try {
    validation.buildValidation({
        channels,
        predictor: {
            ...predictor,
            provenance: {
                ...predictor.provenance,
                publicAxisPopulations: {
                    ...predictor.provenance.publicAxisPopulations,
                    visual: {
                        ...predictor.provenance.publicAxisPopulations.visual,
                        views: { rowCount: 900, videoIdSha256: 'not-a-sha256' },
                    },
                },
            },
        },
        generatedAt: 1002,
        sourceFingerprint: fixtureSha256('fixture-malformed-public-population'),
    });
} catch (error) {
    malformedPublicPopulationError = error;
}
assert(malformedPublicPopulationError, 'a malformed public population hash must be quarantined');
assert(
    malformedPublicPopulationError.lineageAudit.runtimeProvenanceMissing.includes(
        'dataset.shorts.creator-excluded-public.v1:runtimeSnapshot.modalityTargetPopulations'
    )
);
let contractMismatchError = null;
try {
    validation.buildValidation({
        channels,
        predictor: {
            ...predictor,
            provenance: {
                ...predictor.provenance,
                featureContractSha256: 'deliberately-mismatched-contract-hash',
            },
        },
        generatedAt: 1002,
        sourceFingerprint: fixtureSha256('fixture-contract-mismatch'),
    });
} catch (error) {
    contractMismatchError = error;
}
assert(contractMismatchError, 'a contract-mismatched artifact must be quarantined');
assert.strictEqual(contractMismatchError.code, 'SCORE_LINEAGE_CONTRACT_MISMATCH');
assert.strictEqual(contractMismatchError.lineageAudit.structuralPassed, true);
assert.strictEqual(contractMismatchError.lineageAudit.contractRevisionAligned, false);
assert.strictEqual(contractMismatchError.lineageAudit.passed, false);
let incompleteArtifactTupleError = null;
try {
    validation.buildValidation({
        channels,
        predictor: {
            ...predictor,
            provenance: {
                ...predictor.provenance,
                runtimeManifests: {
                    ...predictor.provenance.runtimeManifests,
                    indicatorWeights: null,
                },
            },
        },
        generatedAt: 1003,
        sourceFingerprint: fixtureSha256('fixture-incomplete-artifact-tuple'),
    });
} catch (error) {
    incompleteArtifactTupleError = error;
}
assert(incompleteArtifactTupleError, 'an artifact with one missing companion revision must be quarantined');
assert(
    incompleteArtifactTupleError.lineageAudit.runtimeRevisionMissing.includes(
        'artifact.shorts.indicator-registry.v1:runtimeRevision.weightsSha256'
    )
);
assert.strictEqual(result.rows[0].blindFeatureNames.length, 45);
assert.strictEqual(result.scopes.pooled.storedIndicators.length, 21);
assert.strictEqual(result.scopes.pooled.blindVideoIndicators.length, 36);
assert.strictEqual(result.scopes.pooled.blindAccountIndicators.length, 36);
assert.strictEqual(result.score21Model.inputs.count, 9);
assert.strictEqual(result.score21Model.inputs.directScoresAvailableForAssociation, 18);
assert.strictEqual(result.score21Model.inputs.excludedPrivateLabelAlignedScores.length, 9);
assert.deepStrictEqual(result.score21Model.inputs.excludedStoredNovelty, [
    'novelty.keep',
    'novelty.ret5',
    'novelty.views',
]);
assert.strictEqual(result.coordinateRegistry.version, 3);
assert.strictEqual(result.coordinateRegistry.totals.shortsStoredProduction, 21);
assert.strictEqual(result.coordinateRegistry.totals.shortsVisualKeepForecasts, 1);
assert.strictEqual(result.coordinateRegistry.totals.shortsDirectHeldout, 36);
assert.strictEqual(result.coordinateRegistry.totals.shortsCombinedForecasts, 26);
assert.strictEqual(result.coordinateRegistry.totals.shortsObservedOutcomes, 13);
assert.strictEqual(result.coordinateRegistry.totals.shortsLegacyDiagnostics, 7);
assert.strictEqual(result.coordinateRegistry.totals.shortsRowColumns, 104);
assert.strictEqual(result.coordinateRegistry.totals.shortsBlindColumns, 62);
assert.strictEqual(result.coordinateRegistry.totals.shortsBlindUniquePredictions, 53);
assert.strictEqual(result.coordinateRegistry.totals.shortsBlindAliasColumns, 9);
assert.strictEqual(result.coordinateRegistry.totals.shortsDiagnosticColumns, 29);
assert.strictEqual(result.coordinateRegistry.totals.shortsOutcomeColumns, 13);
assert.deepStrictEqual(result.coordinateRegistry.classification.blind, {
    columns: 62,
    uniquePredictions: 53,
    aliasColumns: 9,
    families: ['videoHeldout', 'accountHeldout', 'videoForecast', 'accountForecast'],
    meaning: 'Coordinates eligible for blind validation. Nine creator-excluded public direct axes appear in both protocol views but identify the same fitted prediction.',
});
assert.strictEqual(result.coordinateRegistry.classification.diagnostics.columns, 29);
assert.strictEqual(result.coordinateRegistry.classification.outcomes.columns, 13);
assert.strictEqual(result.coordinateRegistry.totals.longStoredOutputs, 12);
assert.strictEqual(new Set(result.coordinateRegistry.columns.map(column => column.id)).size, 104);

const expectedValueClassCounts = {
    direct_embedding_axis: 45,
    embedding_derived_transform: 12,
    combined_forecast: 27,
    observed_outcome: 13,
    legacy_diagnostic: 7,
};
const actualValueClassCounts = result.coordinateRegistry.columns.reduce((counts, column) => {
    counts[column.valueClass] = (counts[column.valueClass] || 0) + 1;
    return counts;
}, {});
assert.deepStrictEqual(actualValueClassCounts, expectedValueClassCounts);
assert.strictEqual(result.coordinateRegistry.totals.shortsDirectEmbeddingAxes, 36);
assert.strictEqual(result.coordinateRegistry.totals.shortsDirectAxisColumns, 45);
assert.strictEqual(result.coordinateRegistry.totals.shortsDistinctDirectEmbeddingAxes, 36);
assert.strictEqual(result.coordinateRegistry.totals.shortsDirectAxisAliasColumns, 9);
assert.strictEqual(result.coordinateRegistry.totals.shortsEmbeddingDerivedTransforms, 12);
assert.strictEqual(result.coordinateRegistry.totals.shortsCombinedForecasts, 26);
assert.strictEqual(result.coordinateRegistry.totals.shortsObservedOutcomes, 13);
assert.strictEqual(result.coordinateRegistry.totals.shortsLegacyDiagnostics, 7);
result.coordinateRegistry.columns.forEach(column => {
    assert(/^[a-f0-9]{64}$/.test(column.coordinateIdentity.axisFingerprint), `${column.id} axis identity missing`);
    assert(/^[a-f0-9]{64}$/.test(column.coordinateIdentity.coordinateFingerprint), `${column.id} coordinate identity missing`);
    assert(column.coordinateIdentity.axisTuple.fitDatasetSnapshotSha256ById, `${column.id} fit snapshots missing from identity`);
    assert(column.coordinateIdentity.axisTuple.artifactRevisionSha256ById, `${column.id} artifact revisions missing from identity`);
});

const lineageCatalog = result.coordinateRegistry.lineageCatalog
    || validation.contract.lineageCatalog
    || validation.contract;
const blindArtifact = lineageCatalog.artifacts['artifact.runtime.shorts.blind-predictor.v1'];
assert.strictEqual(blindArtifact.scoredWithContractVersion, validation.contract.version);
assert.strictEqual(blindArtifact.scoredWithContractSha256, featureContractSha256);
assert.strictEqual(blindArtifact.displayedLineageContractVersion, validation.contract.version);
assert.strictEqual(blindArtifact.displayedLineageContractSha256, featureContractSha256);
assert.strictEqual(blindArtifact.contractAlignment, 'exact feature-contract file hash match');
const privateBlindDataset = lineageCatalog.datasets['dataset.shorts.private-blind-population.v1'];
const observedJoinedDataset = lineageCatalog.datasets['dataset.runtime.shorts.observed-joined.v1'];
assert.strictEqual(privateBlindDataset.runtimeSnapshot.rowCount, 632);
assert.strictEqual(Object.keys(privateBlindDataset.runtimeSnapshot.byAccount).length, 4);
assert.strictEqual(observedJoinedDataset.rowCount, 48);
assert.notStrictEqual(
    privateBlindDataset.runtimeSnapshot.videoIdHash,
    observedJoinedDataset.videoIdHash,
    'the exact blind fit population must never be replaced by the smaller UI evaluation join',
);
assert.strictEqual(privateBlindDataset.runtimeSnapshot.videoFolds.length, 5);
assert.strictEqual(privateBlindDataset.runtimeSnapshot.accountHoldouts.length, 4);
const publicBlindDataset = lineageCatalog.datasets['dataset.shorts.creator-excluded-public.v1'];
assert.strictEqual(publicBlindDataset.runtimeSnapshot.candidateUnionRowCount, 1234);
assert.strictEqual(publicBlindDataset.runtimeSnapshot.exactFitPopulationsPersisted, true);
assert.strictEqual(
    publicBlindDataset.runtimeSnapshot.modalityTargetPopulations.text.outlier.rowCount,
    700,
);
assert.strictEqual(
    publicBlindDataset.runtimeSnapshot.modalityTargetPopulations.text.outlier.exact,
    true,
);
const catalogNames = ['inputSets', 'representations', 'datasets', 'algorithms', 'artifacts'];
catalogNames.forEach(name => {
    assert(
        lineageCatalog[name] && typeof lineageCatalog[name] === 'object',
        `missing provenance catalog ${name}`,
    );
});

function resolveCatalogEntry(catalog, id) {
    if (id === null || id === undefined) return null;
    if (Array.isArray(catalog)) return catalog.find(entry => entry && entry.id === id) || null;
    if (Object.prototype.hasOwnProperty.call(catalog, id)) {
        const entry = catalog[id];
        return entry && typeof entry === 'object' ? { id, ...entry } : { id, value: entry };
    }
    return Object.values(catalog).find(entry => entry && entry.id === id) || null;
}

const requiredLineageFields = [
    'inputId',
    'representationId',
    'datasetId',
    'targetField',
    'algorithmId',
    'scalarTransform',
    'calibration',
    'holdout',
    'artifactId',
    'sourceCode',
    'mapView',
];

function assertCompleteLineage(column) {
    assert(
        typeof column.lineageId === 'string' && /^[a-z0-9][a-z0-9._-]+$/i.test(column.lineageId),
        `${column.id} must have a stable machine-readable lineageId`,
    );
    assert(column.lineage && typeof column.lineage === 'object', `${column.id} is missing inline lineage`);
    requiredLineageFields.forEach(field => {
        assert(
            Object.prototype.hasOwnProperty.call(column.lineage, field),
            `${column.id} lineage is missing ${field}`,
        );
    });
    assert(
        resolveCatalogEntry(lineageCatalog.inputSets, column.lineage.inputId),
        `${column.id} inputId does not resolve: ${column.lineage.inputId}`,
    );
    if (column.lineage.representationId !== null) {
        assert(
            resolveCatalogEntry(lineageCatalog.representations, column.lineage.representationId),
            `${column.id} representationId does not resolve: ${column.lineage.representationId}`,
        );
    }
    if (['direct_embedding_axis', 'embedding_derived_transform', 'combined_forecast'].includes(column.valueClass)) {
        assert(
            column.lineage.representationId !== null,
            `${column.id} is predictive but does not identify its input representation`,
        );
    }
    assert(
        resolveCatalogEntry(lineageCatalog.datasets, column.lineage.datasetId),
        `${column.id} datasetId does not resolve: ${column.lineage.datasetId}`,
    );
    assert(
        resolveCatalogEntry(lineageCatalog.algorithms, column.lineage.algorithmId),
        `${column.id} algorithmId does not resolve: ${column.lineage.algorithmId}`,
    );
    if (column.lineage.artifactId !== null) {
        assert(
            resolveCatalogEntry(lineageCatalog.artifacts, column.lineage.artifactId),
            `${column.id} artifactId does not resolve: ${column.lineage.artifactId}`,
        );
    }
    assert(
        typeof column.lineage.targetField === 'string' && column.lineage.targetField.length > 0,
        `${column.id} must identify its fitted or observed target field`,
    );
    ['scalarTransform', 'calibration', 'holdout', 'sourceCode', 'mapView'].forEach(field => {
        const documented = typeof column.lineage[field] === 'string'
            ? column.lineage[field].trim().length > 0
            : column.lineage[field] && typeof column.lineage[field] === 'object'
                ? Object.keys(column.lineage[field]).length > 0
                : column.lineage[field] !== null && column.lineage[field] !== undefined;
        assert(
            documented,
            `${column.id} must explicitly document ${field}`,
        );
    });
}

result.coordinateRegistry.columns.forEach(assertCompleteLineage);
assert.strictEqual(
    new Set(result.coordinateRegistry.columns.map(column => column.lineageId)).size,
    result.coordinateRegistry.columns.length,
    'each Shorts coordinate needs its own stable lineage identity',
);
const leakedLineageByCoordinate = new Map(
    leakedResult.coordinateRegistry.columns.map(column => [column.id, column.lineageId]),
);
result.coordinateRegistry.columns.forEach(column => {
    assert.strictEqual(
        leakedLineageByCoordinate.get(column.id),
        column.lineageId,
        `${column.id} lineageId changed when runtime leakage evidence changed`,
    );
});
assert(
    result.coordinateRegistry.lineageAudit
    && result.coordinateRegistry.lineageAudit.passed === true,
    JSON.stringify(result.coordinateRegistry.lineageAudit),
);
assert.strictEqual(result.coordinateRegistry.lineageAudit.columnsChecked, 104);
assert.strictEqual(result.coordinateRegistry.lineageAudit.unclassifiedColumns.length, 0);
assert.strictEqual(result.coordinateRegistry.lineageAudit.incompleteLineages.length, 0);
assert.strictEqual(result.coordinateRegistry.lineageAudit.unresolvedReferences.length, 0);
assert.strictEqual(result.coordinateRegistry.lineageAudit.catalogReferenceErrors.length, 0);

function registryColumn(id) {
    const column = result.coordinateRegistry.columns.find(candidate => candidate.id === id);
    assert(column, `missing registry column ${id}`);
    return column;
}

function lineageEvidence(column) {
    const lineage = column.lineage;
    return JSON.stringify({
        column,
        input: resolveCatalogEntry(lineageCatalog.inputSets, lineage.inputId),
        representation: resolveCatalogEntry(lineageCatalog.representations, lineage.representationId),
        dataset: resolveCatalogEntry(lineageCatalog.datasets, lineage.datasetId),
        algorithm: resolveCatalogEntry(lineageCatalog.algorithms, lineage.algorithmId),
        artifact: resolveCatalogEntry(lineageCatalog.artifacts, lineage.artifactId),
    }).toLowerCase();
}

function assertLineageMentions(column, patterns) {
    const evidence = lineageEvidence(column);
    patterns.forEach(pattern => {
        assert.match(evidence, pattern, `${column.id} lineage does not document ${pattern}`);
    });
}

const storedVisualKeep = registryColumn('shorts.stored.visual.keep');
assert.strictEqual(storedVisualKeep.valueClass, 'direct_embedding_axis');
assertLineageMentions(storedVisualKeep, [
    /private/,
    /tyler/,
    /pls/,
    /(?:component.{0,12}2|2.{0,12}component|n_components.{0,5}2)/,
    /quantile/,
    /production/,
]);
const storedTextKeep = registryColumn('shorts.stored.text.keep');
assert.strictEqual(
    storedTextKeep.lineage.representationId,
    'representation.shorts.text.live-gemini1536.v1',
);
assert.deepStrictEqual(
    storedTextKeep.lineage.representation.map(item => item.id),
    [
        'representation.shorts.text.live-gemini1536.v1',
        'representation.shorts.text.gemini1536.v1',
    ],
    'stored text lineage must distinguish the live Gemini-fallback query representation from the Whisper-only fit corpus',
);

const storedVisualViews = registryColumn('shorts.stored.visual.views');
assert.strictEqual(storedVisualViews.valueClass, 'direct_embedding_axis');
assertLineageMentions(storedVisualViews, [
    /public/,
    /pls/,
    /quantile/,
    /production/,
]);

const videoHeldoutVisualKeep = registryColumn('shorts.video-heldout.visual.keep');
assert.strictEqual(videoHeldoutVisualKeep.valueClass, 'direct_embedding_axis');
assertLineageMentions(videoHeldoutVisualKeep, [
    /private/,
    /ridge/,
    /alpha.{0,5}100/,
    /five.{0,24}fold/,
    /within.{0,16}account/,
    /entire.{0,16}(?:outer.)?fold/,
]);

const accountHeldoutVisualViews = registryColumn('shorts.account-heldout.visual.views');
assert.strictEqual(accountHeldoutVisualViews.valueClass, 'direct_embedding_axis');
assertLineageMentions(accountHeldoutVisualViews, [
    /public/,
    /pls/,
    /(?:account|creator).{0,24}exclud|exclud.{0,24}(?:account|creator)/,
]);
const videoHeldoutVisualViews = registryColumn('shorts.video-heldout.visual.views');
assert.strictEqual(
    videoHeldoutVisualViews.lineage.fitDatasetId,
    'dataset.shorts.creator-excluded-public.v1',
);
assert.strictEqual(
    accountHeldoutVisualViews.lineage.fitDatasetId,
    'dataset.shorts.creator-excluded-public.v1',
);
assert.strictEqual(
    videoHeldoutVisualViews.lineage.underlyingAxisId,
    accountHeldoutVisualViews.lineage.underlyingAxisId,
    'the two protocol columns must disclose that they alias one shared public fit',
);
assert.strictEqual(
    videoHeldoutVisualViews.lineage.calibrationId,
    'calibration.inverse-log10-nonnegative.v1',
);
assert.match(
    lineageCatalog.algorithms['algorithm.shorts.public-heldout-pls1-quantile.v1'].scalarFormula,
    /in-sample predictions/i,
);
assert.doesNotMatch(
    lineageCatalog.algorithms['algorithm.shorts.public-heldout-pls1-quantile.v1'].scalarFormula,
    /cross-fit training predictions/i,
);

const videoForecastKeep = registryColumn('shorts.video-forecast.keep');
assert.strictEqual(videoForecastKeep.valueClass, 'combined_forecast');
assertLineageMentions(videoForecastKeep, [
    /nested/,
    /multi.{0,3}target/,
    /ridge/,
    /nine|9/,
    /concrete|creator-excluded/,
    /axis|axes/,
]);
const videoForecastViews = registryColumn('shorts.video-forecast.views');
assert.strictEqual(videoForecastViews.lineage.targetField, 'log10(current lifetime views + 1)');
assert.strictEqual(videoForecastViews.lineage.calibrationId, 'calibration.inverse-log10-nonnegative.v1');
const videoForecastSwipe = registryColumn('shorts.video-forecast.swipe');
assert.strictEqual(videoForecastSwipe.lineage.targetField, 'keep');
assert.strictEqual(videoForecastSwipe.lineage.calibrationId, 'calibration.one-minus-percent.v1');
const videoForecastHit10M = registryColumn('shorts.video-forecast.hit10M');
assert.strictEqual(videoForecastHit10M.unit, 'probability');
assert.strictEqual(videoForecastHit10M.lineage.calibrationId, 'calibration.clamp-probability.v1');
assert.match(
    lineageCatalog.representations['representation.runtime.shorts.nine-axis-vector.v1'].construction,
    /training.*mean imputation|training-mean imputation/i,
);
assert.doesNotMatch(
    lineageCatalog.representations['representation.runtime.shorts.nine-axis-vector.v1'].construction,
    /median imputation/i,
);

const observedKeep = registryColumn('shorts.observed.keep');
assert.strictEqual(observedKeep.valueClass, 'observed_outcome');
assert.strictEqual(observedKeep.lineage.representationId, null);
assertLineageMentions(observedKeep, [
    /observed|measured/,
    /keep|stayed/,
    /no.{0,12}embedding|without.{0,12}embedding|identity/,
]);

const storedVisualRealviews = registryColumn('shorts.stored.visual.realviews');
assert.strictEqual(storedVisualRealviews.valueClass, 'embedding_derived_transform');
assert.deepStrictEqual(
    storedVisualRealviews.lineage.algorithm.map(item => item.id),
    ['algorithm.shorts.private-pls2-axis.v1', 'algorithm.shorts.realviews-equation.v1'],
);
assert.deepStrictEqual(
    storedVisualRealviews.lineage.calibration.map(item => item.id),
    ['calibration.shorts.private-rank-to-outcome.v1', 'calibration.identity-target-units.v1'],
);
assertLineageMentions(storedVisualRealviews, [
    /keep/,
    /ret5|five.{0,8}second|5s/,
    /duration/,
    /derived|transform|formula/,
]);
const videoHeldoutRealviews = registryColumn('shorts.video-heldout.visual.realviews');
assert.strictEqual(
    videoHeldoutRealviews.lineage.calibrationId,
    'calibration.inverse-log10-nonnegative.v1',
);
const legacyPublicEnsemble = registryColumn('shorts.legacy.views-public-axis-ensemble');
assert.strictEqual(legacyPublicEnsemble.lineage.usesEmbedding, true);
assert.strictEqual(
    legacyPublicEnsemble.lineage.algorithmId,
    'algorithm.shorts.legacy-public-axis-ensemble.v1',
);
assert.strictEqual(
    legacyPublicEnsemble.lineage.representationId,
    'representation.runtime.shorts.three-public-view-axes.v1',
);

assert.strictEqual(result.coordinateRegistry.longQuant.columns.length, 12);
result.coordinateRegistry.longQuant.columns.forEach(column => {
    assert(
        ['direct_embedding_axis', 'embedding_derived_transform'].includes(column.valueClass),
        `${column.id} has unclassified Long Quant lineage: ${column.valueClass}`,
    );
    assertCompleteLineage(column);
});
assert.strictEqual(
    new Set(result.coordinateRegistry.longQuant.columns.map(column => column.lineageId)).size,
    result.coordinateRegistry.longQuant.columns.length,
    'each Long Quant output needs its own stable lineage identity',
);
const leakedLongLineageByCoordinate = new Map(
    leakedResult.coordinateRegistry.longQuant.columns.map(column => [column.id, column.lineageId]),
);
result.coordinateRegistry.longQuant.columns.forEach(column => {
    assert.strictEqual(
        leakedLongLineageByCoordinate.get(column.id),
        column.lineageId,
        `${column.id} Long Quant lineageId changed across equivalent registry builds`,
    );
});
const longColumn = id => {
    const column = result.coordinateRegistry.longQuant.columns.find(candidate => candidate.id === id);
    assert(column, `missing Long Quant coordinate ${id}`);
    return column;
};
const referenceIds = value => {
    if (value == null) return [];
    if (Array.isArray(value)) return value.flatMap(referenceIds);
    if (typeof value === 'object') return [value.id || value.ref].filter(Boolean);
    return [String(value)];
};
const longVisualRealviews = longColumn('long.output.visual.realviews');
assert.deepStrictEqual(
    longVisualRealviews.lineage.rawInputIds,
    ['input.long.thumbnail.v1'],
    'candidate duration must not be represented as a live Long realistic-views query input',
);
assert(referenceIds(longVisualRealviews.lineage.rawInputs).includes('input.long.duration.v1'));
assert.match(
    JSON.stringify(longVisualRealviews.lineage.rawInputs),
    /reference-row duration.*candidate\/query duration is not an input/i,
);
assert.deepStrictEqual(
    new Set(referenceIds(longVisualRealviews.lineage.fitDataset)),
    new Set(['dataset.long.tyler-private-performance.v1', 'dataset.long.raw-manifold.v1']),
);
assert.deepStrictEqual(
    new Set(referenceIds(longVisualRealviews.lineage.algorithm)),
    new Set([
        'algorithm.long.private-pls2-axis.v1',
        'algorithm.long.realviews-equation.v1',
        'algorithm.long.neighbor-placement.v1',
        'algorithm.long.neighbor-metric-resolution.v1',
    ]),
);
const longTogetherCtrviews = longColumn('long.output.together.ctrviews');
assert.deepStrictEqual(
    new Set(referenceIds(longTogetherCtrviews.lineage.fitDataset)),
    new Set(['dataset.long.tyler-private-performance.v1', 'dataset.long.raw-manifold.v1']),
);
assert(referenceIds(longTogetherCtrviews.lineage.algorithm).includes('algorithm.long.ctrviews-blend.v1'));
const longVisualCtrviews = longColumn('long.output.visual.ctrviews');
assert.strictEqual(longVisualCtrviews.valueClass, 'direct_embedding_axis');
assert.strictEqual(longVisualCtrviews.lineage.reproducibility.status, 'frozen-artifact-required');
assert.deepStrictEqual(
    referenceIds(longVisualCtrviews.lineage.artifact),
    ['artifact.long.visual-ctrviews-ladder.v1', 'artifact.long.live-score-runtime.v1'],
);
const lineageRegistries = validation.contract.lineageContract.registries;
const storedPrivateFamily = validation.contract.lineageContract.coordinateFamilies
    .find(family => family.id === 'family.shorts.stored.private-axis.v1');
assert.strictEqual(
    storedPrivateFamily.representationIdByModality.text,
    'representation.shorts.text.live-gemini1536.v1',
);
assert.strictEqual(
    storedPrivateFamily.fitRepresentationIdByModality.text,
    'representation.shorts.text.gemini1536.v1',
);
assert.strictEqual(
    lineageRegistries.artifacts['artifact.shorts.steer-models.v1'].archivePathPattern,
    'raw/steer_models/by-sha256/{artifactSha256}.npz',
);
assert.strictEqual(
    lineageRegistries.artifacts['artifact.long.visual-ctrviews-ladder.v1'].manifestPath,
    'longform/thumb-rl/scorer_visual.manifest.json',
);
assert.strictEqual(
    lineageRegistries.visualizationMaps['map.shorts.views.v1'].fitDatasetId,
    'dataset.shorts.map-manifold.v1',
);
assert.match(
    lineageRegistries.fitDatasets['dataset.shorts.public-corpus.v1'].representationPopulation,
    /owned rows.*may be included/i,
);
assert.match(
    lineageRegistries.fitDatasets['dataset.shorts.map-manifold.v1'].selectionRule,
    /deterministic seed-0 70% training split/i,
);

assert(result.ledgerAudit.passed, JSON.stringify(result.ledgerAudit));
assert.strictEqual(result.outcomeDefinitions.some(outcome => outcome.key === 'drop20'), true);
const ledgerOutcomeMatrix = result.scopes.pooled.ledgerOutcomeMatrix;
const outcomeKeys = Object.keys(ledgerOutcomeMatrix);
assert.strictEqual(outcomeKeys.length, 13);
assert.deepStrictEqual(
    new Set(outcomeKeys),
    new Set(result.outcomeDefinitions.map(outcome => outcome.key)),
);
const canonicalCoordinateIds = result.coordinateRegistry.columns.map(column => column.id);
const expectedMetricKeys = [
    'spearman',
    'withinAccountSpearman',
    'auc',
    'oofR2',
    'oofSpearman',
    'oofMae',
    'oofMedianFactorError',
    'oofAuc',
    'oofBrier',
    'n',
    'oofN',
    'qValue',
    'evidence',
];
outcomeKeys.forEach(outcomeKey => {
    const matrixRow = ledgerOutcomeMatrix[outcomeKey];
    assert(matrixRow.outcome && matrixRow.outcome.key === outcomeKey);
    assert.strictEqual(matrixRow.outcome.qValueFamily, 'global_all_eligible_104x13');
    assert(
        matrixRow.outcome.qValueEligibleTests > 104,
        'the BH family must span eligible tests across outcomes, not one outcome at a time',
    );
    assert.strictEqual(matrixRow.coordinates.length, 104);
    assert.deepStrictEqual(
        matrixRow.coordinates.map(entry => entry.coordinateId),
        canonicalCoordinateIds,
        `${outcomeKey} must remain in canonical score-ledger order`,
    );
    matrixRow.coordinates.forEach(entry => {
        [
            'coordinateId',
            'label',
            'family',
            'protocol',
            'valueClass',
            'target',
            'group',
            'unit',
            'available',
            'availabilityNote',
            'validationTier',
            'plainEnglish',
            'coverage',
            'metrics',
        ].forEach(key => assert(Object.prototype.hasOwnProperty.call(entry, key), `${outcomeKey}:${entry.coordinateId}:${key}`));
        assert.deepStrictEqual(Object.keys(entry.metrics), expectedMetricKeys);
    });
});
const matrixEntry = (outcomeKey, coordinateId) => {
    const entry = ledgerOutcomeMatrix[outcomeKey].coordinates.find(
        coordinate => coordinate.coordinateId === coordinateId
    );
    assert(entry, `missing ${outcomeKey} x ${coordinateId}`);
    return entry;
};
const fullBlindKeep = matrixEntry('keep', 'shorts.video-heldout.visual.keep');
assert.strictEqual(fullBlindKeep.metrics.n, 632);
assert.strictEqual(fullBlindKeep.metrics.oofN, 632);
assert.strictEqual(fullBlindKeep.coverage.pairedBlindOnlyRows, 584);
assert.strictEqual(fullBlindKeep.coverage.calibrationMode, 'video_5fold');
assert.strictEqual(fullBlindKeep.coverage.trainingTestOverlapN, 0);
assert.strictEqual(fullBlindKeep.coverage.duplicateTestPredictionN, 0);
assert.strictEqual(fullBlindKeep.validationTier, 'video_held_out_coordinate_plus_video_5fold_calibration');
assert.strictEqual(fullBlindKeep.calibration.mode, 'video_5fold');
assert.strictEqual(fullBlindKeep.calibration.folds.length, 5);
assert(fullBlindKeep.calibration.folds.every(fold => fold.parameters && fold.parameters.kind === 'linear'));
assert(Number.isFinite(fullBlindKeep.calibration.diagnostics.actualRange));
assert(Number.isFinite(fullBlindKeep.calibration.diagnostics.predictedRange));
assert(Number.isFinite(fullBlindKeep.calibration.diagnostics.rangeRatio));
const fullBlindKeepColumnIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.video-heldout.visual.keep'
);
const directFullBlindKeepOof = validation._singleCoordinateOof(
    result.validationRows.map(row => ({
        id: row.id,
        accountId: row.accountId,
        predicted: row.scoreLedger.values[fullBlindKeepColumnIndex],
        actual: row.actual.keep,
    })),
    { key: 'keep', unit: 'percent' },
    'video_5fold',
);
assert.deepStrictEqual(
    fullBlindKeep.calibration.folds.map(fold => [fold.fold, fold.parameters]),
    directFullBlindKeepOof.audit.folds.map(fold => [fold.fold, fold.calibration]),
    'the UI calibration registry must persist the exact parameters used by OOF metrics',
);
const directPredictionRange = Math.max(...directFullBlindKeepOof.predictions.map(point => point.calibrated))
    - Math.min(...directFullBlindKeepOof.predictions.map(point => point.calibrated));
assert(Math.abs(directPredictionRange - fullBlindKeep.calibration.diagnostics.predictedRange) < 1e-4);
const accountBlindKeep = matrixEntry('keep', 'shorts.account-heldout.visual.keep');
assert.strictEqual(accountBlindKeep.metrics.n, 632);
assert.strictEqual(accountBlindKeep.metrics.oofN, 632);
assert.strictEqual(accountBlindKeep.coverage.calibrationMode, 'leave_account_out');
assert.strictEqual(accountBlindKeep.coverage.heldOutAccountLeakageN, 0);
assert.strictEqual(accountBlindKeep.validationTier, 'account_held_out_coordinate_plus_leave_account_out_calibration');
assert.strictEqual(accountBlindKeep.calibration.mode, 'leave_account_out');
assert(accountBlindKeep.calibration.folds.every(fold => fold.parameters && fold.parameters.kind === 'linear'));
const tylerAccountBlindKeep = result.scopes.tyler.ledgerOutcomeMatrix.keep.coordinates.find(
    entry => entry.coordinateId === 'shorts.account-heldout.visual.keep'
);
assert.strictEqual(tylerAccountBlindKeep.metrics.oofN, 24);
assert.strictEqual(
    tylerAccountBlindKeep.coverage.heldOutAccountLeakageN,
    0,
    'account-specific scope predictions must still be calibrated on the other accounts',
);
assert.strictEqual(
    matrixEntry('keep', 'shorts.stored.visual.keep').metrics.n,
    48,
    'blind-only rows must never receive fabricated stored coordinates',
);
assert.strictEqual(
    matrixEntry('averageRetention', 'shorts.video-heldout.visual.keep').metrics.n,
    48,
    'blind-only rows must never receive fabricated average-retention outcomes',
);
assert.strictEqual(
    matrixEntry('outlier', 'shorts.video-heldout.visual.keep').metrics.n,
    48,
    'blind-only rows must never receive fabricated outlier outcomes',
);
assert.strictEqual(
    matrixEntry('survival20', 'shorts.video-heldout.visual.keep').metrics.n,
    48,
    'blind-only rows must never receive fabricated retention curves',
);
const observedColumns = result.coordinateRegistry.columns.filter(
    column => column.valueClass === 'observed_outcome'
);
assert.strictEqual(observedColumns.length, 13);
outcomeKeys.forEach(outcomeKey => {
    observedColumns.forEach(column => {
        const entry = matrixEntry(outcomeKey, column.id);
        assert.strictEqual(entry.available, false);
        assert.strictEqual(entry.validationTier, 'outcome_not_predictor');
        assert.strictEqual(entry.metrics.evidence, 'outcome_not_predictor');
        assert.strictEqual(entry.metrics.qValue, null);
        assert.strictEqual(entry.metrics.oofN, 0);
        assert.strictEqual(entry.metrics.oofR2, null);
        assert.strictEqual(entry.metrics.oofAuc, null);
    });
});
assert.match(result.validationContract.videoHeldOut, /five-fold calibration/i);
assert.match(result.validationContract.accountHeldOut, /leave-account-out calibration/i);
assert.match(result.validationContract.glossary.outcomeNotPredictor, /excluded/i);
assert.match(result.validationContract.glossary.qValue, /full eligible 104-coordinate by 13-outcome/i);
assert.match(result.validationContract.glossary.predictionRange, /narrow ratio/i);
assert.match(result.validationContract.glossary.plotModes, /exact fold-specific calibration/i);
assert.strictEqual(Object.prototype.hasOwnProperty.call(result.scopes.pooled, 'outcomeMatrix'), false);

const firstRow = result.rows.find(row => row.id === 'tyler-0');
assert(firstRow);
const staleVisualKeepRow = result.rows.find(row => row.id === 'tyler-1');
assert(staleVisualKeepRow);
assert.strictEqual(
    firstRow.predictions.visualKeepForecast,
    91.25,
    'a persisted scalar is canonical only when its coordinate, scope, and artifact revision match',
);
assert.strictEqual(firstRow.predictions.visualKeepForecastSource, 'persisted_score_artifact');
assert.strictEqual(
    staleVisualKeepRow.predictions.visualKeepForecast,
    predictor.targets.keep.visualOnlyStudy.production.points.find(
        point => point.id === staleVisualKeepRow.id
    ).predicted,
    'a stale persisted model revision must be replaced by the current frozen-model backfill',
);
assert.strictEqual(
    staleVisualKeepRow.predictions.visualKeepForecastSource,
    'current_frozen_model_training_population_backfill',
);
assert.strictEqual(
    staleVisualKeepRow.predictions.visualKeepForecastRejectedRevision,
    fixtureSha256('stale-visual-keep-model'),
);
assert.strictEqual(firstRow.scoreLedger.values.length, result.coordinateRegistry.columns.length);
assert.strictEqual(firstRow.scoreLedger.percentiles.length, result.coordinateRegistry.columns.length);
const storedTextKeepIndex = result.coordinateRegistry.columns.findIndex(column => column.id === 'shorts.stored.text.keep');
assert.strictEqual(firstRow.scoreLedger.values[storedTextKeepIndex], firstRow.storedRaw[6]);
assert.strictEqual(firstRow.scoreLedger.percentiles[storedTextKeepIndex], firstRow.storedPercentile[6]);
const videoRet5Index = result.coordinateRegistry.columns.findIndex(column => column.id === 'shorts.video-heldout.text.ret5');
assert.strictEqual(
    firstRow.scoreLedger.values[videoRet5Index],
    firstRow.blindVideoHeldOut[firstRow.blindFeatureNames.indexOf('text.ret5.raw')],
);
const videoPublicViewsIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.video-heldout.visual.views'
);
const accountPublicViewsIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.account-heldout.visual.views'
);
assert.strictEqual(
    firstRow.scoreLedger.values[videoPublicViewsIndex],
    firstRow.scoreLedger.values[accountPublicViewsIndex],
    'public-axis protocol aliases must display the same fitted coordinate',
);
const observedKeepIndex = result.coordinateRegistry.columns.findIndex(column => column.id === 'shorts.observed.keep');
assert.strictEqual(firstRow.scoreLedger.values[observedKeepIndex], firstRow.actual.keep);
const visualKeepForecastIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.visual-keep-forecast.v1'
);
assert(visualKeepForecastIndex >= 0);
assert.strictEqual(
    firstRow.scoreLedger.values[visualKeepForecastIndex],
    91.25,
);
const visualKeepColumn = result.coordinateRegistry.columns[visualKeepForecastIndex];
assert.strictEqual(visualKeepColumn.valueClass, 'combined_forecast');
assert.strictEqual(
    visualKeepColumn.lineage.artifactId,
    'artifact.shorts.visual-keep-model.v1',
);
assert.strictEqual(
    result.coordinateRegistry.lineageCatalog.artifacts[
        'artifact.shorts.visual-keep-model.v1'
    ].artifactSha256,
    fixtureSha256('visual-keep-model'),
);
const blindOnlyRow = result.validationRows.find(
    row => row.validationSource === 'predictor_blind_inputs_only'
);
assert(blindOnlyRow, 'the expanded blind cohort must be returned for UI plots');
assert(Number.isFinite(blindOnlyRow.scoreLedger.values[visualKeepForecastIndex]));
const storedVisualKeepIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.stored.visual.keep'
);
const videoVisualKeepIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.video-heldout.visual.keep'
);
const observedAverageRetentionIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.observed.averageRetention'
);
const observedOutlierIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.observed.outlier'
);
const observedSurvival20Index = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.observed.survival20'
);
assert.strictEqual(blindOnlyRow.scoreLedger.values[storedVisualKeepIndex], null);
assert(Number.isFinite(blindOnlyRow.scoreLedger.values[videoVisualKeepIndex]));
assert.strictEqual(blindOnlyRow.scoreLedger.values[observedAverageRetentionIndex], null);
assert.strictEqual(blindOnlyRow.scoreLedger.values[observedOutlierIndex], null);
assert.strictEqual(blindOnlyRow.scoreLedger.values[observedSurvival20Index], null);
assert.strictEqual(result.ledgerAudit.rows, 632);
assert.strictEqual(firstRow.actual.retentionCurve.seconds.length, 21);
assert.strictEqual(firstRow.actual.retentionCurve.observed[0], 118);
assert.strictEqual(firstRow.actual.retentionCurve.normalized[0], 100);
assert.strictEqual(firstRow.actual.swipe, 50);
assert.strictEqual(firstRow.predictions.score21.video.retentionCurve.length, 21);
assert.strictEqual(firstRow.predictions.score21.account.retentionCurve.length, 21);
assert(Number.isFinite(firstRow.predictions.score21.video.drop20));
assert.strictEqual(result.scopes.pooled.retentionForecasts.video.bySecond.length, 21);
assert(result.scopes.pooled.retentionForecasts.video.curves > 0);
assert(Number.isFinite(result.scopes.pooled.score21Forecasts.video.keep.mae));
assert(Number.isFinite(result.scopes.pooled.score21Forecasts.video.drop20.mae));
assert(Number.isFinite(
    matrixEntry('hit10M', 'shorts.video-heldout.visual.gt10M').metrics.oofAuc
));
assert(Math.abs(firstRow.predictions.viewsPublicAxis.visual - 999999) < 1, 'log10 public-axis values must convert back to ordinary views');
assert(Math.abs(firstRow.predictions.viewsPublicAxisEnsemble - 999999) < 1);
const incompleteViewsRow = result.rows.find(row => row.id === 'hafu-0');
assert.strictEqual(incompleteViewsRow.predictions.viewsPublicAxisCount, 2);
assert.strictEqual(incompleteViewsRow.predictions.viewsPublicAxisEnsemble, null, 'a partial modality set must never be labeled as a 3-axis ensemble');

const blindPercentile = result.scopes.pooled.blindVideoIndicators.find(item => item.key === 'visual.keep.percentile');
assert(blindPercentile);
assert.strictEqual(blindPercentile.metrics.mae, undefined, 'rank coordinates must not claim percentage-point calibration error');
assert.strictEqual(typeof blindPercentile.metrics.spearman, 'number');
assert(result.scopes.tyler.storedIndicators.find(item => item.key === 'visual.keep').warning.includes('in-sample'));
assert(result.scopes.hafu.storedIndicators.find(item => item.key === 'visual.keep').warning.includes('account-external'));

const continuousOutcome = { key: 'keep', unit: 'percent' };
const videoFoldPoints = Array.from({ length: 40 }, (_, index) => ({
    id: `video-fold-proof-${index}`,
    accountId: index % 2 ? 'account-a' : 'account-b',
    predicted: index,
    actual: 12 + index * 1.75,
}));
const videoProofTarget = videoFoldPoints[7];
const videoOofOriginal = validation._singleCoordinateOof(
    videoFoldPoints,
    continuousOutcome,
    'video_5fold',
);
const videoOofPoisoned = validation._singleCoordinateOof(
    videoFoldPoints.map(point => (
        point.id === videoProofTarget.id ? { ...point, actual: point.actual + 1000000 } : point
    )),
    continuousOutcome,
    'video_5fold',
);
const videoPrediction = resultSet => resultSet.predictions.find(
    point => point.id === videoProofTarget.id
).calibrated;
assert.strictEqual(
    videoPrediction(videoOofOriginal),
    videoPrediction(videoOofPoisoned),
    'changing a test video outcome must not change that video\'s OOF prediction',
);
assert.strictEqual(videoOofOriginal.audit.trainingTestOverlapN, 0);
assert.strictEqual(videoOofOriginal.audit.duplicateTestPredictionN, 0);

const accountFoldPoints = ['account-a', 'account-b', 'account-c'].flatMap(
    (accountId, accountIndex) => Array.from({ length: 12 }, (_, index) => ({
        id: `${accountId}-${index}`,
        accountId,
        predicted: index + accountIndex * 0.25,
        actual: 20 + index * 2 + accountIndex,
    }))
);
const accountOofOriginal = validation._singleCoordinateOof(
    accountFoldPoints,
    continuousOutcome,
    'leave_account_out',
);
const accountOofPoisoned = validation._singleCoordinateOof(
    accountFoldPoints.map(point => (
        point.accountId === 'account-c' ? { ...point, actual: point.actual + 1000000 } : point
    )),
    continuousOutcome,
    'leave_account_out',
);
const accountPredictions = resultSet => resultSet.predictions
    .filter(point => point.accountId === 'account-c')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(point => point.calibrated);
assert.deepStrictEqual(
    accountPredictions(accountOofOriginal),
    accountPredictions(accountOofPoisoned),
    'changing every outcome in a held-out account must not change that account\'s predictions',
);
assert.strictEqual(accountOofOriginal.audit.trainingTestOverlapN, 0);
assert.strictEqual(accountOofOriginal.audit.heldOutAccountLeakageN, 0);
assert.strictEqual(accountOofOriginal.audit.duplicateTestPredictionN, 0);

console.log(JSON.stringify({
    ok: true,
    joined: result.rows.length,
    validationRows: result.validationRows.length,
    storedIndicators: result.scopes.pooled.storedIndicators.length,
    blindIndicators: result.scopes.pooled.blindVideoIndicators.length,
    matrixOutcomes: Object.keys(result.scopes.pooled.ledgerOutcomeMatrix).length,
    matrixCoordinatesPerOutcome: result.scopes.pooled.ledgerOutcomeMatrix.keep.coordinates.length,
    curveForecasts: result.scopes.pooled.retentionForecasts.video.curves,
    strictViews: firstRow.predictions.viewsPublicAxisEnsemble,
}));
