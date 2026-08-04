#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const validation = require('../buildings/jarvis/saved-channel-validation');
const {
    scoreLedgerFromFeatures,
} = require('./fixtures/score-ledger-fixture');
const {
    FEATURE_CONTRACT_DOCUMENT_SHA256,
    FEATURE_CONTRACT_SHA256,
    scoreRecordBindingSha256,
} = require('../buildings/jarvis/shorts-score-ledger');
const featureContract = require(
    '../buildings/jarvis/saved-channel-feature-contract.json'
);
const {
    manifestRowBindingSha256,
} = require(
    '../buildings/jarvis/saved-channel-manifest-binding'
);
const {
    canonicalArtifactIdentity,
} = require('../buildings/jarvis/canonical-json-artifact');
const featureContractPath = path.join(__dirname, '..', 'buildings', 'jarvis', 'saved-channel-feature-contract.json');
const featureContractSha256 = crypto.createHash('sha256').update(fs.readFileSync(featureContractPath)).digest('hex');
assert.strictEqual(
    featureContractSha256,
    FEATURE_CONTRACT_DOCUMENT_SHA256
);
assert.notStrictEqual(
    FEATURE_CONTRACT_DOCUMENT_SHA256,
    FEATURE_CONTRACT_SHA256,
    'the validation fixture must preserve the distinction between the '
        + 'release document hash and the score-ledger identity hash'
);
const serverSource = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'),
    'utf8'
);
const fixtureSha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const fixtureYoutubeChannelId = value => (
    `UC${crypto.createHash('sha256').update(String(value))
        .digest('base64url').slice(0, 22)}`
);
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
const VISUAL_KEEP_ARTIFACT_SHA256 =
    fixtureSha256('visual-keep-model');
const VISUAL_KEEP_MANIFEST_SHA256 =
    fixtureSha256('visual-keep-model-manifest');
const CREATOR_ADAPTIVE_BENCHMARK_ID = 'shorts.causal-keep-mixture-benchmark.v1';
const CREATOR_ADAPTIVE_BENCHMARK_COORDINATE_ID = 'shorts.causal-keep-mixture.v1';
const CREATOR_ADAPTIVE_CANDIDATE_COUNT = 43360;
const CREATOR_ADAPTIVE_CANDIDATE_SHA256 = 'bc7ae80a7afeac82a40648c3ff07e066cc238d3b27918d5f82bf3bbbd04de3ff';
const CREATOR_ADAPTIVE_BENCHMARK_SHA256 = 'c82a290cd4180974d754e6b1c0afec8d456d08d0434794925936ffb11ea82747';
const CREATOR_ADAPTIVE_RESULT_CORE_SHA256 = 'a8dc76db007bc1b158c1e9a04775d1ae7f32656c19b44e733b0523256a42391a';
const CREATOR_ADAPTIVE_OUTPUT_TRANSFORM = 'clip(0.5 * centered-together residual analog + 0.5 * visual+together semantic stack, 0, 100)';
const creatorAdaptiveLockedFormula = {
    coordinateId: CREATOR_ADAPTIVE_BENCHMARK_COORDINATE_ID,
    formula: '0.5 * stage2 centered-together pooled residual analog + 0.5 * stage3 visual+together semantic stack',
    inputs: [
        'Together embedding (visual plus text)',
        'Visual embedding',
        'Strictly earlier same-creator keep history',
    ],
    label: 'Causal keep-rate mixture',
    modalityClass: 'multimodal',
    stage1: {
        biasWeight: 0.5,
        biasWindow: 12,
        contentWeight: 0.5,
        expert: 'pooledKnn:centeredTogether:k12:t15:z:all',
        gateMargin: 0,
        gateWindow: 0,
    },
    stage2: {
        biasWeight: 1,
        biasWindow: 12,
        gateMargin: 0,
        gateWindow: 0,
        initial: 0.5,
        maximum: 0.5,
        mode: 'constant',
        reliability: 'none',
        ridge: 0,
        window: 0,
    },
    stage3: {
        alpha: 1,
        biasWeight: 0,
        biasWindow: 0,
        family: 'stack',
        featureSet: 'semanticWide',
        features: ['ct12', 'ct24', 'ct48', 'cc12', 'cv12', 'cv24', 'krrTogether', 'krrVisual'],
        localWeight: 0,
    },
    stage4: {
        eta: 0,
        initialWeights: [0.5, 0.5, 0],
        minimum: 0,
        mode: 'fixed',
        window: 0,
    },
};

assert.strictEqual(validation.contract.features.length, 21);
assert.deepStrictEqual(
    validation.contract.features.map(feature => feature.key),
    featureContract.features.map(feature => feature.key),
    'validation must expose the unchanged canonical 21-feature scorer contract'
);
assert.strictEqual(validation.contract.version, 10);
assert.match(
    serverSource,
    /'computed:raw\/saved-channel-validation',\s*-1,\s*buildSavedChannelValidationBuffer/,
    'saved-channel validation must bypass time-based response reuse and defer to its exact source fingerprint'
);
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
        else if (feature.unit === 'probability') raw = .1 + (index % 8) * .1;
        else if (feature.unit === 'percent') raw = 45 + (index % 10) * 5;
        else raw = .5 + index * .2;
        return [feature.key, [raw, 5 + (index % 10) * 9]];
    }));
}

function visualKeepInputManifest(id) {
    const scoreInputFingerprint =
        fixtureSha256(`score-input:${id}`);
    return {
        input_fingerprint: scoreInputFingerprint,
        score_input_fingerprint: scoreInputFingerprint,
        embedding_input_fingerprint:
            fixtureSha256(`embedding-input:${id}`),
        revision_fingerprint:
            fixtureSha256(`score-revision:${id}`),
        canonical_montage: {
            montage_sha256: fixtureSha256(`montage:${id}`),
        },
        feature_contract_sha256:
            FEATURE_CONTRACT_SHA256,
        feature_contract_document_sha256:
            FEATURE_CONTRACT_DOCUMENT_SHA256,
    };
}

function bindSavedVideo(video) {
    video.evidence_state = 'canonical_bound';
    video.canonical = true;
    video.predictor_eligible = true;
    video.evidence_warning = null;
    video.score_record_sha256 =
        scoreRecordBindingSha256(video);
    const fullRecordArtifact = canonicalArtifactIdentity({
        ...video,
    });
    video.record_artifact_sha256 =
        fullRecordArtifact.sha256;
    video.record_byte_length =
        fullRecordArtifact.byte_length;
    video.manifest_row_sha256 =
        manifestRowBindingSha256(video);
    return video;
}

const channels = validation.SUPPORTED_CHANNELS.map((definition, channelIndex) => {
    const youtubeChannelId = fixtureYoutubeChannelId(
        definition.accountId
    );
    const videos = Array.from({ length: 24 }, (_, index) => {
        const id = `${definition.accountId}-${index}`;
        const video = {
            id,
            title: `${definition.accountName} fixture ${index}`,
            status: 'done',
            published: `20250${index + 1}01`,
            subscribers: channelIndex ? 200000 : 100000,
            views: 10 ** (5.8 + index * .2 + channelIndex * .05),
            features: savedFeatures(index),
            score_ledger: scoreLedgerFromFeatures(
                savedFeatures(index)
            ),
            input_manifest: visualKeepInputManifest(id),
            montageSha256: fixtureSha256(`montage:${id}`),
            visual_keep_forecast: index < 2 ? {
                coordinate_id: 'shorts.visual-keep-forecast.v1',
                raw: index === 0 ? 91.25 : 99.75,
                est: index === 0 ? 91.25 : 99.75,
                kind: 'keep_rate_percent',
                unit: 'percent',
                source: 'live_frozen_model_score',
                calibration_scope: 'pooled_global',
                account_model: null,
                model_artifact_sha256: index === 0
                    ? VISUAL_KEEP_ARTIFACT_SHA256
                    : fixtureSha256('stale-visual-keep-model'),
                model_manifest_sha256:
                    VISUAL_KEEP_MANIFEST_SHA256,
                model_artifact_key:
                    'raw/predictor-lab/visual-keep-model/by-sha256/'
                    + `${
                        index === 0
                            ? VISUAL_KEEP_ARTIFACT_SHA256
                            : fixtureSha256('stale-visual-keep-model')
                    }.json`,
                model_artifact_canonical_key:
                    'raw/predictor-lab/visual-keep-model-v1.json',
                model_manifest_key:
                    'raw/predictor-lab/visual-keep-model-v1.manifest.json',
                producer_source_sha256:
                    fixtureSha256('visual-keep-producer'),
                feature_contract_version: featureContract.version,
                feature_contract_sha256:
                    FEATURE_CONTRACT_DOCUMENT_SHA256,
                input: 'first-five-second five-frame montage embedding only',
                pctile: null,
            } : null,
        };
        return bindSavedVideo(video);
    });
    return {
        ...definition,
        youtubeChannelId,
        manifest: { youtubeChannelId, videos },
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
    actualKeep: row.keep_rate,
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
blindArtifactRows.forEach(row => {
    row.montageSha256 = fixtureSha256(`blind-montage:${row.id}`);
});
const blindFoldAssignment = validation._contentFamilyFoldAssignments(
    blindArtifactRows,
    5,
    'outer'
);
blindArtifactRows.forEach((row, index) => {
    row.videoFold = blindFoldAssignment.assignments[index];
});
const blindRowFoldManifestSha256 = validation._sha256Json(
    validation._blindFoldManifestRows(blindArtifactRows)
);
const strictPublicCoordinateKeys = validation.contract.features.filter(
    feature => feature.group !== 'novelty'
        && ['views', 'outlier', 'gt10M'].includes(feature.target)
).map(feature => feature.key);
const publicFitRows = Array.from({ length: 12 }, (_, index) => ({
    id: `public-fit-${index}`,
    channelId: fixtureYoutubeChannelId(`public-${index % 3}`),
}));
const publicFitCanonicalRows = validation._canonicalFitManifestRows(
    publicFitRows
);
const publicFitPopulationSha256 = validation._sha256Json(
    publicFitCanonicalRows
);
const publicAxisFitPopulations = {
    [publicFitPopulationSha256]: {
        rows: publicFitCanonicalRows,
        rowsSha256: publicFitPopulationSha256,
    },
};
const publicAxisFitManifests = Object.fromEntries(
    strictPublicCoordinateKeys.map(key => [key, {
        populationSha256: publicFitPopulationSha256,
        rowsSha256: publicFitPopulationSha256,
        rowCount: publicFitCanonicalRows.length,
    }])
);
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
const creatorAdaptivePoints = blindArtifactRows.slice(0, 40).map((row, index) => {
    const historyVideoIds = allRows
        .filter(candidate => candidate.account === row.account && candidate.id !== row.id)
        .slice(0, 8)
        .map(candidate => candidate.id);
    const componentA = row.actualKeep + 0.5;
    const componentB = row.actualKeep + 1.5;
    return {
        id: row.id,
        account: row.account,
        accountName: row.accountName,
        publishedAt: 2000 + index,
        actual: row.actualKeep,
        predicted: 0.5 * (componentA + componentB),
        baseline: row.actualKeep + 2,
        componentA,
        componentB,
        historyN: historyVideoIds.length,
        historyVideoIds,
        historyStart: 1,
        historyEnd: 1000 + index,
        phase: 'causal_prequential_final20',
    };
});
const creatorAdaptiveProfiles = Object.fromEntries(['tyler', 'hafu'].map(account => {
    const accountRows = allRows.filter(row => row.account === account);
    const historyVideoIds = accountRows.slice(-30).map(row => row.id);
    return [account, {
        historyN: historyVideoIds.length,
        historyVideoIds,
        historyThrough: 1999,
        historyWindow: 30,
        liveScoringStatus: 'research_shadow_only_not_served_for_anonymous_uploads',
    }];
}));
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
    visualKeepModelRelease: {
        key: 'raw/predictor-lab/visual-keep-model-v1.manifest.json',
        artifactSha256: VISUAL_KEEP_ARTIFACT_SHA256,
        manifestSha256: VISUAL_KEEP_MANIFEST_SHA256,
        archiveKey:
            `raw/predictor-lab/visual-keep-model/by-sha256/${VISUAL_KEEP_ARTIFACT_SHA256}.json`,
        producerSourceSha256:
            fixtureSha256('visual-keep-producer'),
        featureContractSha256,
    },
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
const visualProtocolFixture = (label, offset) => ({
    label,
    points: blindArtifactRows.map((row, index) => ({
        id: row.id,
        title: row.title,
        account: row.account,
        accountName: row.accountName,
        actual: row.actualKeep,
        predicted: row.actualKeep + offset + (index % 3) * 0.25,
        baseline: row.actualKeep + offset + 2,
        error: offset + (index % 3) * 0.25,
        fold: String(index % 5),
    })),
});
const predictor = {
    generatedAt: 123456,
    provenance: {
        privateAxisTrainingIdOverlap: 0,
        savedAxisTrainingIdOverlap: 0,
        validationCreatorAxisTrainingIdOverlap: 0,
        validationCreatorVideoCountExcluded: 16,
        validationCreatorChannelIds: channels.map(
            source => source.youtubeChannelId
        ),
        publicAxisFitManifests,
        publicAxisFitPopulations,
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
                protocols: {
                    videoHoldout: visualProtocolFixture(
                        'Known creator · random video holdout',
                        1.25,
                    ),
                    forwardTime: visualProtocolFixture(
                        'Future uploads',
                        2.25,
                    ),
                    accountHoldout: visualProtocolFixture(
                        'Unseen creator',
                        3.25,
                    ),
                },
                formula: {
                    scope: 'pooled_global',
                    outputTransform:
                        'clip(linear_prediction, 0, 100)',
                    outputBounds: [0, 100],
                    selected: {
                        pooledAlpha: 1,
                        accountWeight: 0,
                    },
                    pooled: {
                        intercept: 60,
                        coefficients: Array.from(
                            { length: 1536 },
                            () => 0
                        ),
                    },
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
                    artifactSha256: VISUAL_KEEP_ARTIFACT_SHA256,
                    canonicalKey: 'raw/predictor-lab/visual-keep-model-v1.json',
                    archiveKey: `raw/predictor-lab/visual-keep-model/by-sha256/${VISUAL_KEEP_ARTIFACT_SHA256}.json`,
                    producerSourceSha256: fixtureSha256('visual-keep-producer'),
                    generatedAt: 123456,
                },
                promotion: { promoted: false, status: 'fixture' },
            },
            creatorAdaptiveStudy: {
                schemaVersion: 3,
                label: 'Known-creator causal keep-rate mixture',
                coordinateId: 'shorts.creator-adaptive-keep.v1',
                input: 'The canonical visual opening embedding, the canonical together visual-plus-text opening embedding, and up to 30 strictly earlier measured keep outcomes.',
                valueDefinition: 'A raw predicted stayed-to-watch percentage for a known creator next upload; this is a multimodal derived forecast.',
                population: {
                    n: 48,
                    accounts: [
                        { id: 'tyler', name: 'Tyler Csatari', n: 24 },
                        { id: 'hafu', name: 'Hafu Go', n: 24 },
                    ],
                    embeddingModel: 'gemini-embedding-2',
                    embeddingDimensions: 1536,
                    representations: [
                        { id: 'representation.shorts.visual.gemini1536.v1', dimensions: 1536 },
                        { id: 'representation.shorts.together.gemini1536.v1', dimensions: 1536 },
                    ],
                    fingerprints: {
                        rowManifestSha256: fixtureSha256('creator-adaptive-rows'),
                        visualMatrixSha256: fixtureSha256('creator-adaptive-visual'),
                        togetherMatrixSha256: fixtureSha256('creator-adaptive-together'),
                        combinedSha256: fixtureSha256('creator-adaptive-combined'),
                    },
                },
                selection: {
                    protocol: 'Chronological 50%-80% selection with equal timestamps treated as one batch.',
                    candidateCount: CREATOR_ADAPTIVE_CANDIDATE_COUNT,
                    candidateRegistrySha256: CREATOR_ADAPTIVE_CANDIDATE_SHA256,
                    candidateCountWithAllAccounts: CREATOR_ADAPTIVE_CANDIDATE_COUNT,
                    selected: {
                        benchmarkId: CREATOR_ADAPTIVE_BENCHMARK_ID,
                        modalityClass: 'multimodal',
                        formula: creatorAdaptiveLockedFormula.formula,
                        stage1: creatorAdaptiveLockedFormula.stage1,
                        stage2: creatorAdaptiveLockedFormula.stage2,
                        stage3: creatorAdaptiveLockedFormula.stage3,
                        stage4: creatorAdaptiveLockedFormula.stage4,
                    },
                    metrics: {},
                    benchmarkMetrics: {},
                },
                evaluation: {
                    protocol: 'Causal prequential replay of the final 20% with strictly earlier creator outcomes only.',
                    claimBoundary: 'Retrospective known-creator next-upload evidence; anonymous and cold-start scoring are unsupported.',
                    metrics: {
                        n: 40,
                        mae: 1,
                        baselineMae: 2,
                        maeImprovementVsBaseline: 1,
                        protocolBaselineR2: 0.75,
                        within10PercentagePoints: 100,
                        perAccount: [
                            { account: 'tyler', name: 'Tyler Csatari', n: 24, mae: 1, baselineMae: 2, maeImprovementVsBaseline: 1, protocolBaselineR2: 0.75 },
                            { account: 'hafu', name: 'Hafu Go', n: 16, mae: 1, baselineMae: 2, maeImprovementVsBaseline: 1, protocolBaselineR2: 0.75 },
                        ],
                    },
                    target: {
                        metric: 'per-account mean absolute error',
                        thresholdPercentagePoints: 10,
                        pointEstimatePassCount: 2,
                        accountCount: 2,
                        evaluatedAccountCount: 2,
                        allPopulationAccountsEvaluated: true,
                        missingEvaluationAccounts: [],
                        allAccountsPassPointEstimate: true,
                        baseline: 'Mean of at most 30 strictly earlier same-creator keep labels.',
                        baselineBeatingAccountCount: 2,
                        beatsHonestBaselineOverall: true,
                        allAccountsBeatHonestBaseline: true,
                    },
                    points: creatorAdaptivePoints,
                },
                batchFreezeStress: {
                    metrics: {
                        allAccountsWithin10: true,
                        allAccountsBeatBaseline: true,
                    },
                    points: creatorAdaptivePoints,
                },
                ablations: {
                    interpretation: 'History-only, visual-only, together-only, and the locked multimodal formula remain distinct.',
                },
                formula: {
                    modalityClass: 'multimodal',
                    visualRepresentation: 'L2-normalized canonical 1,536D visual embedding',
                    togetherRepresentation: 'L2-normalized canonical 1,536D together visual-plus-text embedding',
                    historyWindow: 30,
                    minimumHistoryN: 8,
                    model: 'Selection-locked causal 50/50 residual-analog and semantic-stack mixture',
                    lockedFormula: creatorAdaptiveLockedFormula,
                    outputTransform: CREATOR_ADAPTIVE_OUTPUT_TRANSFORM,
                    outputBounds: [0, 100],
                    accounts: creatorAdaptiveProfiles,
                    profileRequirement: 'An explicit creator profile with at least eight strictly earlier measured outcomes is required.',
                },
                benchmark: {
                    benchmarkId: CREATOR_ADAPTIVE_BENCHMARK_ID,
                    artifactSha256: CREATOR_ADAPTIVE_BENCHMARK_SHA256,
                    resultCoreSha256: CREATOR_ADAPTIVE_RESULT_CORE_SHA256,
                    candidateRegistrySha256: CREATOR_ADAPTIVE_CANDIDATE_SHA256,
                    datasetFingerprints: {
                        combinedSha256: fixtureSha256('creator-adaptive-combined'),
                    },
                },
                modelArtifact: {
                    artifactSha256: fixtureSha256('creator-adaptive-keep-model'),
                    canonicalKey: 'raw/predictor-lab/creator-adaptive-keep-model-v1.json',
                    archiveKey: `raw/predictor-lab/creator-adaptive-keep-model/by-sha256/${fixtureSha256('creator-adaptive-keep-model')}.json`,
                    producerSourceSha256: fixtureSha256('creator-adaptive-keep-producer'),
                    generatedAt: 123456,
                },
                status: {
                    state: 'research_only_retrospective_target_met',
                    plainEnglish: 'Retrospective target met; prospective confirmation is still required.',
                    absoluteTargetMet: true,
                    beatsHonestBaselineOverall: true,
                    beatsHonestBaselineEveryAccount: true,
                    promoted: false,
                    predictorEligible: false,
                    coldStart: 'unsupported',
                    anonymousUpload: 'unsupported',
                },
            },
            blindInputs: {
                featureNames: blindNames,
                videoHeldOutProtocol: 'synthetic video holdout',
                accountHeldOutProtocol: 'synthetic account holdout',
                rowFoldManifestSha256: blindRowFoldManifestSha256,
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

const creatorAdaptiveKeepModel = {
    artifactSha256: fixtureSha256('creator-adaptive-keep-model'),
    model: JSON.parse(JSON.stringify(predictor.targets.keep.creatorAdaptiveStudy)),
};
const result = validation.buildValidation({
    channels,
    predictor,
    creatorAdaptiveKeepModel,
    generatedAt: 999,
    sourceFingerprint: fixtureSha256('fixture'),
});

function validationAfterSavedVideoMutation(label, mutate) {
    const mutatedChannels = JSON.parse(JSON.stringify(channels));
    const target = mutatedChannels[0].manifest.videos.find(
        video => video.id === 'tyler-0'
    );
    assert(target, `${label}: fixture row missing`);
    mutate(target);
    bindSavedVideo(target);
    return validation.buildValidation({
        channels: mutatedChannels,
        predictor,
        creatorAdaptiveKeepModel,
        generatedAt: 999,
        sourceFingerprint: fixtureSha256(`fixture:${label}`),
    });
}

assert.strictEqual(result.version, validation.VERSION);
assert.strictEqual(result.visualKeepStudy, predictor.targets.keep.visualOnlyStudy);
assert.deepStrictEqual(
    result.creatorAdaptiveStudy,
    predictor.targets.keep.creatorAdaptiveStudy
);
assert.strictEqual(result.creatorAdaptiveStudy.schemaVersion, 3);
assert.strictEqual(
    result.creatorAdaptiveStudy.selection.candidateCount,
    CREATOR_ADAPTIVE_CANDIDATE_COUNT
);
assert.strictEqual(
    result.creatorAdaptiveStudy.selection.candidateRegistrySha256,
    CREATOR_ADAPTIVE_CANDIDATE_SHA256
);
assert.strictEqual(
    result.creatorAdaptiveStudy.selection.selected.benchmarkId,
    CREATOR_ADAPTIVE_BENCHMARK_ID
);
assert.strictEqual(
    result.creatorAdaptiveStudy.selection.selected.modalityClass,
    'multimodal'
);
assert.strictEqual(result.creatorAdaptiveStudy.formula.historyWindow, 30);
assert.strictEqual(result.creatorAdaptiveStudy.formula.minimumHistoryN, 8);
assert.strictEqual(
    result.creatorAdaptiveStudy.formula.outputTransform,
    CREATOR_ADAPTIVE_OUTPUT_TRANSFORM
);
assert(result.creatorAdaptiveStudy.evaluation.points.every(point => (
    Number.isFinite(point.componentA)
    && Number.isFinite(point.componentB)
    && point.predicted === 0.5 * (point.componentA + point.componentB)
    && point.historyN >= 8
    && point.historyN <= 30
    && point.historyVideoIds.length === point.historyN
    && new Set(point.historyVideoIds).size === point.historyN
)));
assert.strictEqual(result.creatorAdaptiveStudy.status.promoted, false);
assert.strictEqual(result.creatorAdaptiveStudy.status.predictorEligible, false);
assert.match(result.creatorAdaptiveStudy.status.state, /^research_only_/);
const mismatchedCreatorModel = JSON.parse(JSON.stringify(creatorAdaptiveKeepModel));
mismatchedCreatorModel.model.evaluation.points[0].predicted += 1;
assert.throws(
    () => validation.buildValidation({
        channels,
        predictor,
        creatorAdaptiveKeepModel: mismatchedCreatorModel,
        generatedAt: 998,
        sourceFingerprint: fixtureSha256('fixture-creator-model-mismatch'),
    }),
    error => error && error.code === 'CREATOR_ADAPTIVE_MODEL_PARITY_MISMATCH'
);
assert.strictEqual(result.rows.length, 48);
assert.strictEqual(result.validationRows.length, 632);
assert(result.validationRows.every(row => (
    row.scoreLedger
    && row.scoreLedger.values.length === 93
)));
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
assert.strictEqual(result.leakageAudit.publicAxisOverlapAudit.validManifestCount, 9);
assert.strictEqual(result.leakageAudit.publicAxisOverlapAudit.uniqueFitPopulations, 1);
assert.strictEqual(result.leakageAudit.blindFoldAudit.passed, true);
assert.strictEqual(
    result.leakageAudit.blindFoldAudit
        .strongDuplicateProtectionPassed,
    true
);
assert.strictEqual(
    result.leakageAudit.validationCreatorChannelIdentityAudit.passed,
    true
);
assert.deepStrictEqual(
    result.leakageAudit.validationCreatorChannelIdentityAudit
        .canonicalChannelIds,
    channels.map(source => source.youtubeChannelId).sort()
);
assert.strictEqual(result.leakageAudit.allRequiredInputsFinite, false);
assert(result.leakageAudit.requiredFiniteInputRows < result.validationRows.length);
const leakedManifests = JSON.parse(JSON.stringify(publicAxisFitManifests));
const leakedManifest = leakedManifests['visual.views'];
leakedManifest.rows = publicFitCanonicalRows.concat({
    id: channels[0].manifest.videos[0].id,
    channelId: channels[0].youtubeChannelId,
});
leakedManifest.rows = validation._canonicalFitManifestRows(
    leakedManifest.rows
);
leakedManifest.rowsSha256 = validation._sha256Json(leakedManifest.rows);
delete leakedManifest.populationSha256;
leakedManifest.rowCount = leakedManifest.rows.length;
const leakedResult = validation.buildValidation({
    channels,
    predictor: {
        ...predictor,
        provenance: {
            ...predictor.provenance,
            privateAxisTrainingIdOverlap: 0,
            savedAxisTrainingIdOverlap: 0,
            validationCreatorAxisTrainingIdOverlap: 0,
            publicAxisFitManifests: leakedManifests,
        },
    },
    generatedAt: 1000,
    sourceFingerprint: fixtureSha256('fixture-with-creator-leakage'),
});
assert.strictEqual(leakedResult.leakageAudit.passedForBlindInputs, false, 'creator overlap must fail the blind audit instead of being hard-coded green');
assert.strictEqual(leakedResult.leakageAudit.validationCreatorsExcludedFromPublicAxis, false);
assert(
    leakedResult.leakageAudit.publicAxisOverlapAudit
        .validationCreatorOverlap.includes(channels[0].manifest.videos[0].id),
    'locally recomputed overlap must defeat forged zero counters'
);
const mismatchedNamespaceChannels = JSON.parse(
    JSON.stringify(channels)
);
mismatchedNamespaceChannels.forEach(source => {
    delete source.youtubeChannelId;
    delete source.manifest.youtubeChannelId;
    source.manifest.channelId = source.channelId;
});
const mismatchedNamespacePredictor = JSON.parse(
    JSON.stringify(predictor)
);
mismatchedNamespacePredictor.provenance
    .validationCreatorChannelIds =
    mismatchedNamespaceChannels.map(source => source.channelId);
const mismatchedNamespaceResult = validation.buildValidation({
    channels: mismatchedNamespaceChannels,
    predictor: mismatchedNamespacePredictor,
    generatedAt: 1000.5,
    sourceFingerprint:
        fixtureSha256('fixture-mismatched-channel-namespace'),
});
assert.strictEqual(
    mismatchedNamespaceResult.leakageAudit
        .validationCreatorChannelIdentityAudit.passed,
    false,
    'internal ch… IDs must never be compared with public YouTube channel IDs'
);
assert.strictEqual(
    mismatchedNamespaceResult.leakageAudit.passedForBlindInputs,
    false,
    'unknown or mismatched channel-ID namespaces must fail the global leakage gate'
);
assert(
    mismatchedNamespaceResult.leakageAudit
        .validationCreatorChannelIdentityAudit.blockers.some(
            blocker => /non-YouTube channel-ID namespace/.test(blocker)
        )
);
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
assert.strictEqual(
    result.score21Model.protocols.video.scalarOuterFoldLineageConsistent,
    true
);
assert.strictEqual(
    result.score21Model.protocols.video.checkpointOuterFoldLineageConsistent,
    true
);
assert.strictEqual(
    result.score21Model.protocols.video.curveOuterFoldLineageConsistent,
    true
);
assert.strictEqual(
    result.score21Model.protocols.video.scalarOuterFoldLineage.assignmentSha256,
    result.score21Model.protocols.video.checkpointOuterFoldLineage.assignmentSha256,
    'all video-held-out targets must reuse one exact content-family fold lineage',
);
assert.strictEqual(
    result.score21Model.protocols.video.scalarOuterFoldLineage.assignmentSha256,
    result.score21Model.protocols.video.curveOuterFoldLineage.assignmentSha256,
    'curve forecasts must use the same family placement as scalar forecasts',
);
assert.strictEqual(
    result.coordinateRegistry.version,
    validation.LEDGER_VERSION
);
assert.strictEqual(
    result.coordinateRegistry.governanceVersion,
    validation.coordinateGovernance.schemaVersion
);
assert.strictEqual(result.coordinateRegistry.governanceSha256, validation.GOVERNANCE_SHA256);
assert.strictEqual(result.coordinateRegistry.totals.shortsStoredProduction, 21);
assert.strictEqual(result.coordinateRegistry.totals.shortsVisualKeepForecasts, 1);
assert.strictEqual(result.coordinateRegistry.totals.shortsVisualKeepProtocolForecasts, 3);
assert.strictEqual(
    result.coordinateRegistry.totals
        .shortsCreatorAdaptiveKeepPrequential,
    1,
);
assert.strictEqual(result.coordinateRegistry.totals.shortsCreatorExcludedPublic, 9);
assert.strictEqual(result.coordinateRegistry.totals.shortsDirectHeldout, 18);
assert.strictEqual(result.coordinateRegistry.totals.shortsCombinedForecasts, 29);
assert.strictEqual(result.coordinateRegistry.totals.shortsObservedOutcomes, 12);
assert.strictEqual(result.coordinateRegistry.totals.shortsLegacyDiagnostics, 0);
assert.strictEqual(result.coordinateRegistry.totals.shortsCompatibilityAliases, 18);
assert.strictEqual(result.coordinateRegistry.totals.shortsRetiredCoordinates, 7);
assert.strictEqual(result.coordinateRegistry.totals.shortsRowColumns, 93);
assert.strictEqual(result.coordinateRegistry.totals.shortsBlindColumns, 51);
assert.strictEqual(result.coordinateRegistry.totals.shortsBlindUniquePredictions, 51);
assert.strictEqual(result.coordinateRegistry.totals.shortsBlindAliasColumns, 0);
assert.strictEqual(result.coordinateRegistry.totals.shortsDiagnosticColumns, 30);
assert.strictEqual(result.coordinateRegistry.totals.shortsOutcomeColumns, 12);
assert.deepStrictEqual(result.coordinateRegistry.classification.blind, {
    columns: 51,
    uniquePredictions: 51,
    aliasColumns: 0,
    families: ['creatorExcludedPublic', 'videoHeldout', 'accountHeldout', 'videoForecast', 'accountForecast'],
    meaning: 'Coordinates currently eligible for leakage-controlled predictor ranking. Every active blind column is one unique scalar prediction; compatibility aliases are outside the active ledger.',
});
assert.strictEqual(result.coordinateRegistry.classification.diagnostics.columns, 30);
assert.strictEqual(result.coordinateRegistry.classification.outcomes.columns, 12);
assert.strictEqual(result.coordinateRegistry.totals.longStoredOutputs, 21);
assert.strictEqual(new Set(result.coordinateRegistry.columns.map(column => column.id)).size, 93);
assert.strictEqual(result.coordinateRegistry.compatibility.activeColumnsContainAliases, false);
assert.strictEqual(result.coordinateRegistry.compatibility.activeColumnsContainRetired, false);
assert.strictEqual(result.coordinateRegistry.aliases.length, 18);
assert.strictEqual(result.coordinateRegistry.retired.length, 7);
const fixtureProtocolRow = result.validationRows.find(
    row => row.id === blindArtifactRows[0].id
);
const fixtureProtocolValue = coordinateId => {
    const index = result.coordinateRegistry.columns.findIndex(
        column => column.id === coordinateId
    );
    assert(index >= 0, `missing registered protocol coordinate ${coordinateId}`);
    return fixtureProtocolRow.scoreLedger.values[index];
};
assert.strictEqual(
    fixtureProtocolValue('shorts.visual-keep-protocol.video-heldout.v1'),
    blindArtifactRows[0].actualKeep + 1.25,
);
assert.strictEqual(
    fixtureProtocolValue('shorts.visual-keep-protocol.forward-time.v1'),
    blindArtifactRows[0].actualKeep + 2.25,
);
assert.strictEqual(
    fixtureProtocolValue('shorts.visual-keep-protocol.account-heldout.v1'),
    blindArtifactRows[0].actualKeep + 3.25,
);
assert.deepStrictEqual(result.ledgerAudit.visualKeepProtocolParityMismatches, []);

const expectedValueClassCounts = {
    direct_embedding_axis: 40,
    embedding_derived_transform: 12,
    combined_forecast: 29,
    observed_outcome: 12,
};
const actualValueClassCounts = result.coordinateRegistry.columns.reduce((counts, column) => {
    counts[column.valueClass] = (counts[column.valueClass] || 0) + 1;
    return counts;
}, {});
assert.deepStrictEqual(actualValueClassCounts, expectedValueClassCounts);
assert.strictEqual(result.coordinateRegistry.totals.shortsDirectEmbeddingAxes, 40);
assert.strictEqual(result.coordinateRegistry.totals.shortsDirectAxisColumns, 40);
assert.strictEqual(result.coordinateRegistry.totals.shortsDistinctDirectEmbeddingAxes, 40);
assert.strictEqual(result.coordinateRegistry.totals.shortsDirectAxisAliasColumns, 0);
assert.strictEqual(result.coordinateRegistry.totals.shortsEmbeddingDerivedTransforms, 12);
assert.strictEqual(result.coordinateRegistry.totals.shortsCombinedForecasts, 29);
assert.strictEqual(result.coordinateRegistry.totals.shortsObservedOutcomes, 12);
assert.strictEqual(result.coordinateRegistry.totals.shortsLegacyDiagnostics, 0);
result.coordinateRegistry.columns.forEach(column => {
    assert(/^[a-f0-9]{64}$/.test(column.coordinateIdentity.axisFingerprint), `${column.id} axis identity missing`);
    assert(/^[a-f0-9]{64}$/.test(column.coordinateIdentity.coordinateFingerprint), `${column.id} coordinate identity missing`);
    assert(column.coordinateIdentity.axisTuple.fitDatasetSnapshotSha256ById, `${column.id} fit snapshots missing from identity`);
    assert(column.coordinateIdentity.axisTuple.artifactRevisionSha256ById, `${column.id} artifact revisions missing from identity`);
});
for (const protocolId of [
    'shorts.visual-keep-protocol.video-heldout.v1',
    'shorts.visual-keep-protocol.forward-time.v1',
    'shorts.visual-keep-protocol.account-heldout.v1',
]) {
    const protocolColumn = result.coordinateRegistry.columns.find(
        column => column.id === protocolId
    );
    assert(protocolColumn);
    assert.strictEqual(
        protocolColumn.lineage.artifactId,
        'artifact.runtime.shorts.blind-predictor.v1',
    );
}
assert.strictEqual(
    result.coordinateRegistry.columns.find(
        column => column.id === 'shorts.visual-keep-forecast.v1'
    ).lineage.artifactId,
    'artifact.shorts.visual-keep-model.v1',
);

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
    const representationIds = column.lineage.representationId === null
        ? []
        : (Array.isArray(column.lineage.representationId)
            ? column.lineage.representationId
            : [column.lineage.representationId]);
    representationIds.forEach(representationId => {
        assert(
            resolveCatalogEntry(lineageCatalog.representations, representationId),
            `${column.id} representationId does not resolve: ${representationId}`,
        );
    });
    if (['direct_embedding_axis', 'embedding_derived_transform', 'combined_forecast'].includes(column.valueClass)) {
        assert(
            representationIds.length > 0,
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
assert.strictEqual(result.coordinateRegistry.lineageAudit.columnsChecked, 93);
assert.strictEqual(result.coordinateRegistry.lineageAudit.unclassifiedColumns.length, 0);
assert.strictEqual(result.coordinateRegistry.lineageAudit.incompleteLineages.length, 0);
assert.strictEqual(result.coordinateRegistry.lineageAudit.unresolvedReferences.length, 0);
assert.strictEqual(result.coordinateRegistry.lineageAudit.catalogReferenceErrors.length, 0);
assert.deepStrictEqual(result.coordinateRegistry.lineageAudit.duplicateActiveAxes, []);
assert.deepStrictEqual(result.coordinateRegistry.lineageAudit.aliasErrors, []);

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

const creatorExcludedVisualViews = registryColumn('shorts.creator-excluded.visual.views');
assert.strictEqual(creatorExcludedVisualViews.valueClass, 'direct_embedding_axis');
assertLineageMentions(creatorExcludedVisualViews, [
    /public/,
    /pls/,
    /(?:account|creator).{0,24}exclud|exclud.{0,24}(?:account|creator)/,
]);
assert.strictEqual(
    creatorExcludedVisualViews.lineage.fitDatasetId,
    'dataset.shorts.creator-excluded-public.v1',
);
assert.strictEqual(
    result.coordinateRegistry.columns.some(
        column => column.id === 'shorts.video-heldout.visual.views'
    ),
    false,
    'a compatibility alias must not remain in the active ledger'
);
assert.strictEqual(
    result.coordinateRegistry.columns.some(
        column => column.id === 'shorts.account-heldout.visual.views'
    ),
    false,
    'a compatibility alias must not remain in the active ledger'
);
assert.strictEqual(
    validation.resolveCoordinateId(
        result.coordinateRegistry,
        'shorts.video-heldout.visual.views'
    ),
    'shorts.creator-excluded.visual.views'
);
assert.strictEqual(
    validation.resolveCoordinateId(
        result.coordinateRegistry,
        'shorts.account-heldout.visual.views'
    ),
    'shorts.creator-excluded.visual.views'
);
assert.strictEqual(
    creatorExcludedVisualViews.lineage.calibrationId,
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
const videoForecastSwipe = result.coordinateRegistry.displayTransforms.find(
    transform => transform.id === 'shorts.video-forecast.swipe'
);
assert(videoForecastSwipe);
assert.strictEqual(videoForecastSwipe.sourceCoordinateId, 'shorts.video-forecast.keep');
assert.strictEqual(videoForecastSwipe.formula, '100 - source');
assert.strictEqual(videoForecastSwipe.stored, false);
const videoForecastHit10M = registryColumn('shorts.video-forecast.hit10M');
assert.strictEqual(videoForecastHit10M.unit, 'probability');
assert.strictEqual(videoForecastHit10M.lineage.calibrationId, 'calibration.clamp-probability.v1');
assert.match(
    lineageCatalog.representations[
        'representation.runtime.shorts.creator-excluded-nine-axis-vector.v1'
    ].construction,
    /training.*mean imputation|training-mean imputation/i,
);
assert.doesNotMatch(
    lineageCatalog.representations[
        'representation.runtime.shorts.creator-excluded-nine-axis-vector.v1'
    ].construction,
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
assert.strictEqual(
    result.coordinateRegistry.columns.some(
        column => column.id === 'shorts.legacy.views-public-axis-ensemble'
    ),
    false,
    'retired diagnostics must not remain active ledger columns'
);
assert(
    result.coordinateRegistry.retired.some(
        coordinate => (
            coordinate.id === 'shorts.legacy.views-public-axis-ensemble'
            && coordinate.status === 'retired'
            && coordinate.predictorEligible === false
            && coordinate.predictor_eligible === false
            && coordinate.replacement === 'shorts.video-forecast.views'
        )
    ),
    'retired diagnostics must remain traceable in compatibility metadata'
);
result.coordinateRegistry.retired.forEach(coordinate => {
    assert.strictEqual(coordinate.coordinateId, coordinate.id);
    assert.strictEqual(
        coordinate.coordinateIdentity.coordinateId,
        coordinate.id
    );
    assert.strictEqual(
        coordinate.coordinateIdentity.status,
        'retired'
    );
    assert.strictEqual(coordinate.predictorEligible, false);
    assert.strictEqual(coordinate.predictor_eligible, false);
    assert.strictEqual(coordinate.active, false);
    assert(/^[a-f0-9]{64}$/.test(
        coordinate.coordinateIdentitySha256
    ));
    assert.strictEqual(
        result.coordinateRegistry.columns.some(
            column => column.id === coordinate.id
        ),
        false,
        `${coordinate.id} entered active ledger columns`
    );
    for (const outcome of Object.values(
        result.scopes.pooled.ledgerOutcomeMatrix
    )) {
        assert.strictEqual(
            outcome.coordinates.some(
                entry => entry.coordinateId === coordinate.id
            ),
            false,
            `${coordinate.id} entered active forecast rankings`
        );
    }
});

assert.strictEqual(result.coordinateRegistry.longQuant.columns.length, 21);
assert.deepStrictEqual(
    result.coordinateRegistry.longQuant.groups,
    ['visual', 'text', 'together']
);
assert.strictEqual(result.coordinateRegistry.longQuant.mapPlacements.length, 36);
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
assert.strictEqual(
    longVisualCtrviews.lineage.reproducibility.status,
    'frozen-artifact-required-not-held-out'
);
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
    'withinAccountAuc',
    'inferentialEffect',
    'inferentialPValue',
    'inferentialEstimand',
    'inferentialN',
    'inferentialCreatorCount',
    'inferentialMethod',
    'predictionR2',
    'predictionSpearman',
    'predictionMae',
    'predictionBaselineMae',
    'predictionMaeImprovementVsBaseline',
    'predictionProtocolBaselineR2',
    'predictionMedianFactorError',
    'predictionAuc',
    'predictionBrier',
    'n',
    'predictionN',
    'qValue',
    'evidence',
];
outcomeKeys.forEach(outcomeKey => {
    const matrixRow = ledgerOutcomeMatrix[outcomeKey];
    assert(matrixRow.outcome && matrixRow.outcome.key === outcomeKey);
    assert.strictEqual(
        matrixRow.outcome.qValueFamily,
        'global_unique_coordinate_axis_by_outcome_hypothesis'
    );
    assert(
        matrixRow.outcome.qValueEligibleTests > 89,
        'the BH family must span eligible tests across outcomes, not one outcome at a time',
    );
    assert(
        matrixRow.outcome.qValueEligibleRows
            >= matrixRow.outcome.qValueEligibleTests
    );
    assert(
        matrixRow.outcome.qValueDuplicateRowsRemoved > 0,
        'derived swipe and keep must share one feed-decision hypothesis family'
    );
    assert.strictEqual(matrixRow.coordinates.length, 93);
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
            'nativeOutcomeKey',
            'evaluationMode',
            'validationTier',
            'plainEnglish',
            'coverage',
            'inference',
            'evaluation',
            'metrics',
        ].forEach(key => assert(Object.prototype.hasOwnProperty.call(entry, key), `${outcomeKey}:${entry.coordinateId}:${key}`));
        assert.deepStrictEqual(Object.keys(entry.metrics), expectedMetricKeys);
        assert.strictEqual(entry.coverage.chartFittedParameterCount, 0);
        assert.strictEqual(entry.coverage.chartTrainingRowsRead, 0);
        assert.strictEqual(entry.coverage.chartTrainingOutcomesRead, 0);
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
assert.strictEqual(fullBlindKeep.metrics.predictionN, 632);
assert.strictEqual(fullBlindKeep.coverage.pairedBlindOnlyRows, 584);
assert.strictEqual(fullBlindKeep.coverage.evaluationMode, 'registered_video_heldout_identity');
assert.strictEqual(fullBlindKeep.coverage.predictionRows, 632);
assert.strictEqual(fullBlindKeep.validationTier, 'video_held_out_coordinate_identity');
assert.strictEqual(fullBlindKeep.nativeOutcomeKey, 'keep');
assert.strictEqual(fullBlindKeep.evaluation.identity, true);
assert.strictEqual(fullBlindKeep.evaluation.fittedByRelationshipChart, false);
assert.strictEqual(fullBlindKeep.evaluation.audit.fittedParameterCount, 0);
assert.strictEqual(fullBlindKeep.evaluation.audit.trainingRowsReadByChart, 0);
assert.strictEqual(fullBlindKeep.evaluation.audit.trainingOutcomesReadByChart, 0);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(fullBlindKeep, 'calibration'),
    false,
    'relationship rows must not expose a second UI calibration'
);
const fullBlindKeepColumnIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.video-heldout.visual.keep'
);
assert.strictEqual(
    fullBlindKeep.evaluation.valueSource,
    'scoreLedger.values[coordinateRegistry.index]'
);
const firstBlindKeepPrediction = validation._identityCoordinateEvaluation(
    [{
        id: fixtureProtocolRow.id,
        accountId: fixtureProtocolRow.accountId,
        actual: fixtureProtocolRow.actual.keep,
        predicted: fixtureProtocolRow.scoreLedger.values[
            fullBlindKeepColumnIndex
        ],
    }],
    { key: 'keep', unit: 'percent' },
    'registered_video_heldout_identity'
).predictions[0];
assert.strictEqual(
    firstBlindKeepPrediction.predicted,
    fixtureProtocolRow.scoreLedger.values[fullBlindKeepColumnIndex],
    'native prediction charts must read the exact ledger scalar'
);
const accountBlindKeep = matrixEntry('keep', 'shorts.account-heldout.visual.keep');
assert.strictEqual(accountBlindKeep.metrics.n, 632);
assert.strictEqual(accountBlindKeep.metrics.predictionN, 632);
assert.strictEqual(accountBlindKeep.coverage.evaluationMode, 'registered_account_heldout_identity');
assert.strictEqual(accountBlindKeep.validationTier, 'account_held_out_coordinate_identity');
assert.strictEqual(accountBlindKeep.evaluation.identity, true);
assert.strictEqual(accountBlindKeep.evaluation.fittedByRelationshipChart, false);
const tylerAccountBlindKeep = result.scopes.tyler.ledgerOutcomeMatrix.keep.coordinates.find(
    entry => entry.coordinateId === 'shorts.account-heldout.visual.keep'
);
assert.strictEqual(tylerAccountBlindKeep.metrics.predictionN, 24);
assert.strictEqual(
    tylerAccountBlindKeep.coverage.chartTrainingOutcomesRead,
    0,
    'account-specific charts must not fit against outcomes from any account',
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
assert.strictEqual(observedColumns.length, 12);
outcomeKeys.forEach(outcomeKey => {
    observedColumns.forEach(column => {
        const entry = matrixEntry(outcomeKey, column.id);
        assert.strictEqual(entry.available, false);
        assert.strictEqual(entry.validationTier, 'outcome_not_predictor');
        assert.strictEqual(entry.metrics.evidence, 'outcome_not_predictor');
        assert.strictEqual(entry.metrics.qValue, null);
        assert.strictEqual(entry.metrics.predictionN, 0);
        assert.strictEqual(entry.metrics.predictionR2, null);
        assert.strictEqual(entry.metrics.predictionAuc, null);
    });
});
assert.match(result.validationContract.videoHeldOut, /does not fit a second chart-only calibration/i);
assert.match(result.validationContract.accountHeldOut, /does not fit a second chart-only calibration/i);
assert.match(result.validationContract.glossary.outcomeNotPredictor, /excluded/i);
assert.match(result.validationContract.glossary.qValue, /full eligible 93-coordinate by 13-outcome/i);
assert.match(result.validationContract.glossary.predictionRange, /narrow ratio/i);
assert.match(result.validationContract.glossary.plotModes, /no fold assignment, fit, or recalibration/i);
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
assert.strictEqual(
    firstRow.predictions.visualKeepForecastSource,
    'live_frozen_model_score'
);
assert.strictEqual(
    firstRow.predictions.visualKeepForecastEvaluationStatus,
    'retrospective_score_time_prediction_not_confirmed_by_preregistered_result'
);
assert.strictEqual(
    staleVisualKeepRow.predictions.visualKeepForecast,
    null,
    'a stale persisted model revision must fail closed instead of receiving a full-fit reconstruction',
);
assert.strictEqual(
    staleVisualKeepRow.predictions.visualKeepForecastSource,
    null,
);
assert.strictEqual(
    staleVisualKeepRow.predictions.visualKeepForecastEvaluationStatus,
    null,
);
assert.strictEqual(
    staleVisualKeepRow.predictions.visualKeepForecastRejectedRevision,
    fixtureSha256('stale-visual-keep-model'),
);
assert(
    staleVisualKeepRow.predictions
        .visualKeepForecastRejectionReasons.some(
            reason => /model artifact SHA-256 does not match/i.test(reason)
        )
);
assert.strictEqual(
    staleVisualKeepRow.studyMetadata.visualKeep
        .persistedScoreTimeForecastAudit
        .recordedScoreRecordSha256,
    staleVisualKeepRow.studyMetadata.visualKeep
        .persistedScoreTimeForecastAudit
        .calculatedScoreRecordSha256,
    'the wrong-artifact adversary must remain otherwise cryptographically bound'
);
assert.strictEqual(
    staleVisualKeepRow.studyMetadata.visualKeep
        .fullFitTrainingDiagnostic
        .excludedFromCanonicalLedger,
    true,
);
assert.strictEqual(
    staleVisualKeepRow.studyMetadata.visualKeep
        .fullFitTrainingDiagnostic.value,
    predictor.targets.keep.visualOnlyStudy.production.points.find(
        point => point.id === staleVisualKeepRow.id
    ).predicted,
    'the full-fit value remains inspectable only as separate study metadata',
);
assert.strictEqual(
    firstRow.predictions.visualKeepForecastManifestSha256,
    VISUAL_KEEP_MANIFEST_SHA256
);
assert.strictEqual(
    firstRow.predictions.visualKeepForecastInputFingerprint,
    firstRow.inputManifest.score_input_fingerprint
);
assert.strictEqual(
    firstRow.predictions
        .visualKeepForecastInputRevisionFingerprint,
    firstRow.inputManifest.revision_fingerprint
);
const missingModelManifestResult =
    validationAfterSavedVideoMutation(
        'missing-visual-model-manifest',
        video => {
            delete video.visual_keep_forecast
                .model_manifest_sha256;
        }
    );
const missingModelManifestRow =
    missingModelManifestResult.rows.find(
        row => row.id === 'tyler-0'
    );
assert.strictEqual(
    missingModelManifestRow.predictions.visualKeepForecast,
    null,
    'a forecast without its immutable model-manifest SHA must fail closed'
);
assert(
    missingModelManifestRow.predictions
        .visualKeepForecastRejectionReasons.some(
            reason =>
                /model manifest SHA-256 is missing or malformed/i.test(
                    reason
                )
        )
);
assert.strictEqual(
    missingModelManifestRow.studyMetadata.visualKeep
        .persistedScoreTimeForecastAudit
        .recordedScoreRecordSha256,
    missingModelManifestRow.studyMetadata.visualKeep
        .persistedScoreTimeForecastAudit
        .calculatedScoreRecordSha256
);
assert(
    missingModelManifestRow.studyMetadata.visualKeep
        .fullFitTrainingDiagnostic,
    'rejecting score-time provenance must not erase separately labeled study metadata'
);
const missingInputFingerprintResult =
    validationAfterSavedVideoMutation(
        'missing-score-input-fingerprint',
        video => {
            delete video.input_manifest.input_fingerprint;
            delete video.input_manifest.score_input_fingerprint;
        }
    );
const missingInputFingerprintRow =
    missingInputFingerprintResult.rows.find(
        row => row.id === 'tyler-0'
    );
assert.strictEqual(
    missingInputFingerprintRow.predictions
        .visualKeepForecast,
    null,
    'a forecast without its exact score-input fingerprint must fail closed'
);
assert(
    missingInputFingerprintRow.predictions
        .visualKeepForecastRejectionReasons.some(
            reason => /input fingerprint is missing/i.test(reason)
        )
);
assert.strictEqual(
    missingInputFingerprintRow.studyMetadata.visualKeep
        .persistedScoreTimeForecastAudit
        .recordedScoreRecordSha256,
    missingInputFingerprintRow.studyMetadata.visualKeep
        .persistedScoreTimeForecastAudit
        .calculatedScoreRecordSha256
);
const noPersistedForecastRow = result.rows.find(
    row => row.id === 'tyler-2'
);
assert(noPersistedForecastRow);
assert.strictEqual(
    noPersistedForecastRow.predictions.visualKeepForecast,
    null,
    'the current model full-fit point must never substitute for a missing persisted forecast'
);
assert.strictEqual(
    noPersistedForecastRow.studyMetadata.visualKeep
        .fullFitTrainingDiagnostic
        .excludedFromCanonicalLedger,
    true
);
assert.strictEqual(
    result.leakageAudit.visualKeepForecastProvenanceAudit
        .fullFitTrainingDiagnosticsInsertedIntoCanonicalLedger,
    0
);
assert.strictEqual(
    result.leakageAudit.visualKeepForecastProvenanceAudit
        .requiredSource,
    'live_frozen_model_score'
);
assert.deepStrictEqual(
    result.leakageAudit.visualKeepForecastProvenanceAudit
        .modelOutputContract.outputBounds,
    [0, 100]
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
const creatorExcludedPublicViewsIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.creator-excluded.visual.views'
);
assert(creatorExcludedPublicViewsIndex >= 0);
assert.strictEqual(
    firstRow.scoreLedger.values[creatorExcludedPublicViewsIndex],
    Math.max(
        0,
        10 ** firstRow.blindVideoHeldOut[
            firstRow.blindFeatureNames.indexOf('visual.views.raw')
        ] - 1
    ),
    'the canonical creator-excluded public coordinate must use its native ledger value'
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
    VISUAL_KEEP_ARTIFACT_SHA256,
);
const creatorAdaptiveKeepIndex = result.coordinateRegistry.columns.findIndex(
    column => (
        column.id
        === 'shorts.creator-prequential-forecast.keep'
    )
);
assert(creatorAdaptiveKeepIndex >= 0);
const firstCreatorAdaptivePoint = predictor.targets.keep.creatorAdaptiveStudy
    .evaluation.points.find(point => point.id === firstRow.id);
assert(firstCreatorAdaptivePoint);
assert.strictEqual(
    firstRow.scoreLedger.values[creatorAdaptiveKeepIndex],
    firstCreatorAdaptivePoint.predicted,
);
const creatorAdaptiveColumn =
    result.coordinateRegistry.columns[creatorAdaptiveKeepIndex];
assert.notStrictEqual(
    creatorAdaptiveColumn.id,
    predictor.targets.keep.creatorAdaptiveStudy.coordinateId,
    'historical prequential and live future-upload estimands need distinct coordinate IDs',
);
assert.strictEqual(creatorAdaptiveColumn.valueClass, 'combined_forecast');
assert.strictEqual(creatorAdaptiveColumn.protocol, 'prequential');
assert.strictEqual(creatorAdaptiveColumn.predictorEligible, false);
assert.strictEqual(creatorAdaptiveColumn.status, 'research_diagnostic');
assert.strictEqual(
    creatorAdaptiveColumn.lineage.artifactId,
    'artifact.shorts.creator-adaptive-keep-model.v1',
);
assert.strictEqual(
    result.coordinateRegistry.lineageCatalog.artifacts[
        'artifact.shorts.creator-adaptive-keep-model.v1'
    ].artifactSha256,
    fixtureSha256('creator-adaptive-keep-model'),
);
const creatorKeepMatrixEntry = result.scopes.pooled.ledgerOutcomeMatrix.keep.coordinates
    .find(entry => (
        entry.coordinateId
        === 'shorts.creator-prequential-forecast.keep'
    ));
const creatorSwipeMatrixEntry = result.scopes.pooled.ledgerOutcomeMatrix.swipe.coordinates
    .find(entry => (
        entry.coordinateId
        === 'shorts.creator-prequential-forecast.keep'
    ));
const creatorViewsMatrixEntry = result.scopes.pooled.ledgerOutcomeMatrix.views.coordinates
    .find(entry => (
        entry.coordinateId
        === 'shorts.creator-prequential-forecast.keep'
    ));
assert(creatorKeepMatrixEntry.metrics.predictionN > 0);
assert.strictEqual(creatorKeepMatrixEntry.predictorEligible, false);
assert.strictEqual(creatorKeepMatrixEntry.metrics.predictionBaselineMae, 2);
assert.strictEqual(creatorKeepMatrixEntry.metrics.predictionMae, 1);
assert.strictEqual(
    creatorKeepMatrixEntry.metrics.predictionMaeImprovementVsBaseline,
    1,
);
assert.strictEqual(creatorSwipeMatrixEntry.metrics.predictionN, 0);
assert.strictEqual(creatorSwipeMatrixEntry.evaluationMode, 'association_only');
assert.match(creatorSwipeMatrixEntry.availabilityNote, /Association only/);
assert.strictEqual(creatorViewsMatrixEntry.metrics.predictionN, 0);
assert.match(creatorViewsMatrixEntry.availabilityNote, /Association only/);
assert.deepStrictEqual(result.ledgerAudit.creatorAdaptiveParityMismatches, []);
const blindOnlyRow = result.validationRows.find(
    row => row.validationSource === 'predictor_blind_inputs_only'
);
assert(blindOnlyRow, 'the expanded blind cohort must be returned for UI plots');
assert(Number.isFinite(
    blindOnlyRow.predictions.score21.video.keep
), 'every blind-only row with a keep label must receive the video-held-out combined forecast');
assert(Number.isFinite(
    blindOnlyRow.predictions.score21.account.keep
), 'every blind-only row with a keep label must receive the account-held-out combined forecast');
assert.strictEqual(
    blindOnlyRow.predictions.score21.video.retentionCurve,
    null,
    'a blind-only row without an observed retention curve must not receive a fabricated curve forecast'
);
assert.strictEqual(
    result.score21Model.protocols.video.scalarEligible,
    result.validationRows.length,
    'the scalar forecast population must be the full exact blind validation cohort'
);
assert.strictEqual(
    result.score21Model.protocols.account.scalarEligible,
    result.validationRows.length,
    'whole-account transfer must use the same exact eligible scalar cohort'
);
assert.strictEqual(
    blindOnlyRow.scoreLedger.values[visualKeepForecastIndex],
    null,
    'blind-only and full-fit artifact rows must never backfill the canonical score-time coordinate',
);
assert.strictEqual(
    blindOnlyRow.studyMetadata.visualKeep
        .fullFitTrainingDiagnostic
        .excludedFromValidationMatrix,
    true,
);
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
const observedSwipeTransform = result.coordinateRegistry.displayTransforms.find(
    transform => transform.id === 'shorts.observed.swipe'
);
assert(observedSwipeTransform);
assert.strictEqual(observedSwipeTransform.sourceCoordinateId, 'shorts.observed.keep');
assert.strictEqual(observedSwipeTransform.formula, '100 - source');
assert.strictEqual(observedSwipeTransform.stored, false);
assert.strictEqual(
    result.coordinateRegistry.shortsMapProjections.keys.includes('swipe'),
    false,
    'runtime map inventory must not advertise the retired swipe plane'
);
assert.strictEqual(
    result.coordinateRegistry.shortsMapProjections.mapIds.some(
        id => id === 'map.shorts.swipe.v1'
    ),
    false,
    'runtime map registry must not expose the retired swipe plane'
);
assert.strictEqual(
    result.coordinateRegistry.columns.filter(
        column => column.family === 'stored'
    ).length,
    21,
    'retiring a map plane must not alter the stored scorer ledger'
);
const videoForecastKeepIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.video-forecast.keep'
);
const accountForecastKeepIndex = result.coordinateRegistry.columns.findIndex(
    column => column.id === 'shorts.account-forecast.keep'
);
assert.strictEqual(
    firstRow.predictions.score21.video.swipe,
    100 - firstRow.scoreLedger.values[videoForecastKeepIndex],
    'video-held-out swipe must be the exact deterministic inverse of keep'
);
assert.strictEqual(
    firstRow.predictions.score21.account.swipe,
    100 - firstRow.scoreLedger.values[accountForecastKeepIndex],
    'account-held-out swipe must be the exact deterministic inverse of keep'
);
assert.strictEqual(
    result.coordinateRegistry.columns.some(
        column => column.id === 'shorts.video-forecast.swipe'
            || column.id === 'shorts.account-forecast.swipe'
            || column.id === 'shorts.observed.swipe'
    ),
    false,
    'swipe complements must not occupy independent ledger coordinates',
);
assert.strictEqual(firstRow.predictions.score21.video.retentionCurve.length, 21);
assert.strictEqual(firstRow.predictions.score21.account.retentionCurve.length, 21);
assert(Number.isFinite(firstRow.predictions.score21.video.drop20));
assert.strictEqual(result.scopes.pooled.retentionForecasts.video.bySecond.length, 21);
assert(result.scopes.pooled.retentionForecasts.video.curves > 0);
assert(Number.isFinite(result.scopes.pooled.score21Forecasts.video.keep.mae));
assert(Number.isFinite(result.scopes.pooled.score21Forecasts.video.drop20.mae));
assert(Number.isFinite(
    matrixEntry('hit10M', 'shorts.creator-excluded.visual.gt10M').metrics.predictionAuc
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

const identityPoints = [
    { id: 'identity-a', accountId: 'account-a', actual: 10, predicted: 71.25, baseline: 60 },
    { id: 'identity-b', accountId: 'account-b', actual: 90, predicted: 28.75, baseline: 60 },
];
const identityEvaluation = validation._identityCoordinateEvaluation(
    identityPoints,
    { key: 'keep', unit: 'percent' },
    'registered_video_heldout_identity'
);
assert.deepStrictEqual(
    identityEvaluation.predictions.map(point => point.predicted),
    [71.25, 28.75],
    'native-target evaluation must preserve exact registered predictions'
);
assert.strictEqual(identityEvaluation.identity, true);
assert.strictEqual(identityEvaluation.fittedByRelationshipChart, false);
assert.strictEqual(identityEvaluation.audit.fittedParameterCount, 0);
assert.strictEqual(identityEvaluation.audit.trainingRowsReadByChart, 0);
assert.strictEqual(identityEvaluation.audit.trainingOutcomesReadByChart, 0);
const poisonedIdentityEvaluation = validation._identityCoordinateEvaluation(
    identityPoints.map(point => ({ ...point, actual: point.actual + 1000000 })),
    { key: 'keep', unit: 'percent' },
    'registered_video_heldout_identity'
);
assert.deepStrictEqual(
    poisonedIdentityEvaluation.predictions.map(point => point.predicted),
    identityEvaluation.predictions.map(point => point.predicted),
    'changing outcomes must never alter a native ledger prediction'
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(validation, '_singleCoordinateOof'),
    false,
    'the UI-only recalibration helper must not remain part of the validation API'
);

const simpsonPoints = [
    { id: 'a-0', accountId: 'a', actual: 100, predicted: 0 },
    { id: 'a-1', accountId: 'a', actual: 99, predicted: 1 },
    { id: 'a-2', accountId: 'a', actual: 98, predicted: 2 },
    { id: 'a-3', accountId: 'a', actual: 97, predicted: 3 },
    { id: 'b-0', accountId: 'b', actual: 200, predicted: 100 },
    { id: 'b-1', accountId: 'b', actual: 199, predicted: 101 },
    { id: 'b-2', accountId: 'b', actual: 198, predicted: 102 },
    { id: 'b-3', accountId: 'b', actual: 197, predicted: 103 },
];
const simpsonAssociation = validation._rawCoordinateAssociation(
    simpsonPoints,
    { key: 'keep', unit: 'percent' },
    'pooled'
);
assert(
    simpsonAssociation.spearman > 0.5,
    'the adversarial fixture must have a positive pooled descriptive association'
);
assert.strictEqual(
    simpsonAssociation.inferentialEffect,
    simpsonAssociation.withinAccountSpearman,
    'the inferential effect must use the same within-account estimand as its p/q path'
);
assert(
    simpsonAssociation.inferentialEffect < -0.99,
    'between-creator level shifts must not reverse the registered inferential effect'
);
assert.strictEqual(
    simpsonAssociation.inferentialEstimand,
    'creator_macro_content_family_spearman'
);
assert.strictEqual(simpsonAssociation.inferentialN, simpsonPoints.length);
assert.strictEqual(simpsonAssociation.inferentialCreatorCount, 2);
assert.strictEqual(
    simpsonAssociation.inferentialPValue,
    null,
    'fewer than three independent creators must not produce a transfer p-value',
);
const threeCreatorPoints = ['a', 'b', 'c'].flatMap(accountId => (
    [1, 2, 3].map(value => ({
        id: `${accountId}-${value}`,
        accountId,
        contentFamilyId: `${accountId}-family-${value}`,
        actual: value,
        predicted: value,
    }))
));
const threeCreatorAssociation = validation._rawCoordinateAssociation(
    threeCreatorPoints,
    { key: 'keep', unit: 'percent' },
    'pooled'
);
assert.strictEqual(threeCreatorAssociation.inferentialCreatorCount, 3);
assert.strictEqual(
    threeCreatorAssociation.inferentialMethod,
    'exact-creator-sign-flip-after-content-family-collapse'
);
assert(Number.isFinite(threeCreatorAssociation.inferentialPValue));

const explicitRetention = validation._retentionCurveSnapshot([
    { second: 0, value: 1.2 },
    { second: 4, value: 0.9 },
    { second: 20, value: 0.5 },
], 20);
assert.strictEqual(explicitRetention.sourceTimebase, 'explicit-seconds');
assert.strictEqual(explicitRetention.observed[0], 120);
assert.strictEqual(explicitRetention.observed[4], 90);
assert.strictEqual(explicitRetention.observed[20], 50);
assert.strictEqual(
    explicitRetention.observed[2],
    105,
    'irregular timestamped retention must interpolate by seconds rather than array index',
);

const sharedFamilyRows = [
    {
        id: 'shared-a',
        account: 'creator-a',
        title: 'Completely different title A',
        contentFamilyId: 'same-perceptual-content',
    },
    {
        id: 'shared-b',
        account: 'creator-b',
        title: 'Completely different title B',
        contentFamilyId: 'same-perceptual-content',
    },
    {
        id: 'unique-a',
        account: 'creator-a',
        title: 'Unique A',
    },
    {
        id: 'unique-b',
        account: 'creator-b',
        title: 'Unique B',
    },
];
const sharedFamilyAssignment = validation._contentFamilyFoldAssignments(
    sharedFamilyRows,
    2,
    'outer'
);
assert.strictEqual(
    sharedFamilyAssignment.assignments[0],
    sharedFamilyAssignment.assignments[1],
    'the same declared content family must never cross a shared outer fold, even across creators',
);
assert.strictEqual(
    sharedFamilyAssignment.evidenceAudit
        .bySource.explicit_content_family,
    2
);
assert.strictEqual(
    sharedFamilyAssignment.evidenceAudit.titleFallbackRows,
    2
);
assert.strictEqual(
    sharedFamilyAssignment.evidenceAudit
        .strongDuplicateProtectionPassed,
    false,
    'title equality must never be silently reported as strong duplicate protection'
);
assert.match(
    sharedFamilyAssignment.evidenceAudit.warning,
    /title\/row-identity fallbacks.*do not provide strong duplicate-content protection/i
);
const montagePreferredRows = [
    {
        id: 'montage-a',
        account: 'creator-a',
        montageSha256: fixtureSha256('shared-montage'),
        perceptualHash: 'aaaa',
        title: 'First title',
    },
    {
        id: 'montage-b',
        account: 'creator-b',
        montageSha256: fixtureSha256('shared-montage'),
        perceptualHash: 'bbbb',
        title: 'Second title',
    },
];
const montagePreferredAssignment =
    validation._contentFamilyFoldAssignments(
        montagePreferredRows,
        2,
        'montage-precedence'
    );
assert.strictEqual(
    montagePreferredAssignment.assignments[0],
    montagePreferredAssignment.assignments[1],
    'canonical montage SHA must take precedence over conflicting weaker perceptual hashes'
);
assert.strictEqual(
    montagePreferredAssignment.evidenceAudit
        .bySource.canonical_montage_sha256,
    2
);

const gt10MRaw = result.scopes.pooled.blindVideoIndicators.find(
    item => item.key === 'visual.gt10M.raw'
);
const gt10MPercentile = result.scopes.pooled.blindVideoIndicators.find(
    item => item.key === 'visual.gt10M.percentile'
);
assert(Number.isFinite(gt10MRaw.metrics.brier));
assert.strictEqual(gt10MRaw.metrics.spearman, undefined);
assert(Number.isFinite(gt10MPercentile.metrics.spearman));
assert.strictEqual(gt10MPercentile.metrics.brier, undefined);
assert.strictEqual(gt10MPercentile.metrics.auc, undefined);
assert.strictEqual(
    matrixEntry(
        'keep',
        'shorts.creator-excluded.visual.views'
    ).inference.status,
    'exploratory-creator-blocked-exact-sign-flip'
);

function buildAdversarialValidation(adversarialPredictor, generatedAt) {
    return validation.buildValidation({
        channels,
        predictor: adversarialPredictor,
        creatorAdaptiveKeepModel,
        generatedAt,
        sourceFingerprint: fixtureSha256(
            `adversarial-${generatedAt}`
        ),
    });
}

const accountMismatchPredictor = JSON.parse(JSON.stringify(predictor));
accountMismatchPredictor.targets.keep.blindInputs.rows[0].account = 'hafu';
assert.throws(
    () => buildAdversarialValidation(accountMismatchPredictor, 1101),
    error => error && error.code === 'BLIND_ROW_ACCOUNT_MISMATCH',
    'video IDs must join through account plus video identity, not video ID alone',
);

const duplicateBlindIdPredictor = JSON.parse(JSON.stringify(predictor));
duplicateBlindIdPredictor.targets.keep.blindInputs.rows.push({
    ...duplicateBlindIdPredictor.targets.keep.blindInputs.rows[0],
});
assert.throws(
    () => buildAdversarialValidation(duplicateBlindIdPredictor, 1102),
    error => error && error.code === 'BLIND_ROW_DUPLICATE_VIDEO_ID',
    'ambiguous duplicate blind video IDs must fail closed',
);

const wrongFoldPredictor = JSON.parse(JSON.stringify(predictor));
const wrongFoldInputs = wrongFoldPredictor.targets.keep.blindInputs;
wrongFoldInputs.rows[0].videoFold =
    (Number(wrongFoldInputs.rows[0].videoFold) + 1) % 5;
wrongFoldInputs.rowFoldManifestSha256 = validation._sha256Json(
    validation._blindFoldManifestRows(wrongFoldInputs.rows)
);
const wrongFoldResult = buildAdversarialValidation(
    wrongFoldPredictor,
    1103
);
assert.strictEqual(wrongFoldResult.leakageAudit.blindFoldAudit.contentAddressed, true);
assert.strictEqual(wrongFoldResult.leakageAudit.blindFoldAudit.passed, false);
assert(
    wrongFoldResult.leakageAudit.blindFoldAudit.mismatches.includes(
        wrongFoldInputs.rows[0].id
    ),
    'a self-consistent hash must not conceal a fold assignment that differs from the shared algorithm',
);
assert.strictEqual(wrongFoldResult.leakageAudit.passedForBlindInputs, false);

const titleOnlyPredictor = JSON.parse(JSON.stringify(predictor));
const titleOnlyInputs =
    titleOnlyPredictor.targets.keep.blindInputs;
titleOnlyInputs.rows.forEach(row => {
    delete row.contentFamilyId;
    delete row.content_family_id;
    delete row.sourceContentId;
    delete row.source_content_id;
    delete row.montageSha256;
    delete row.montage_sha256;
    delete row.perceptualHash;
    delete row.perceptual_hash;
    delete row.inputManifest;
    delete row.input_manifest;
});
const titleOnlyAssignments =
    validation._contentFamilyFoldAssignments(
        titleOnlyInputs.rows,
        5,
        'outer'
    );
titleOnlyInputs.rows.forEach((row, index) => {
    row.videoFold = titleOnlyAssignments.assignments[index];
});
titleOnlyInputs.rowFoldManifestSha256 =
    validation._sha256Json(
        validation._blindFoldManifestRows(
            titleOnlyInputs.rows
        )
    );
const titleOnlyResult = buildAdversarialValidation(
    titleOnlyPredictor,
    1103.5
);
assert.strictEqual(
    titleOnlyResult.leakageAudit.blindFoldAudit
        .contentAddressed,
    true,
    'the adversarial title-only fold must otherwise be internally self-consistent'
);
assert.strictEqual(
    titleOnlyResult.leakageAudit.blindFoldAudit
        .strongDuplicateProtectionPassed,
    false
);
assert.strictEqual(
    titleOnlyResult.leakageAudit.blindFoldAudit.passed,
    false,
    'title-only families cannot pass a blind fold audit'
);
assert.strictEqual(
    titleOnlyResult.leakageAudit.passedForBlindInputs,
    false,
    'title-only duplicate protection cannot pass the global leakage gate'
);
assert(
    titleOnlyResult.coordinateRegistry.columns
        .filter(column => (
            [
                'videoHeldout',
                'accountHeldout',
                'videoForecast',
                'accountForecast',
            ].includes(column.family)
        ))
        .every(column => column.predictorEligible === false),
    'weak duplicate protection must not promote held-out forecast families'
);

const noFitManifestPredictor = JSON.parse(JSON.stringify(predictor));
delete noFitManifestPredictor.provenance.publicAxisFitManifests;
const noFitManifestResult = buildAdversarialValidation(
    noFitManifestPredictor,
    1104
);
assert.strictEqual(
    noFitManifestResult.leakageAudit.publicAxisOverlapAudit.manifestsComplete,
    false
);
assert.strictEqual(noFitManifestResult.leakageAudit.passedForBlindInputs, false);

const tamperedManifestPredictor = JSON.parse(JSON.stringify(predictor));
tamperedManifestPredictor.provenance.publicAxisFitPopulations[
    publicFitPopulationSha256
].rows[0].id = 'tampered-without-rehash';
const tamperedManifestResult = buildAdversarialValidation(
    tamperedManifestPredictor,
    1105
);
assert.strictEqual(
    tamperedManifestResult.leakageAudit.publicAxisOverlapAudit.manifests
        .find(item => item.key === 'visual.views').hashValid,
    false,
    'the locally recomputed content hash must reject mutated fit membership',
);
assert.strictEqual(tamperedManifestResult.leakageAudit.passedForBlindInputs, false);

const strictForecastNames = validation.contract.features.filter(feature => (
    feature.group !== 'novelty'
    && ['views', 'outlier', 'gt10M'].includes(feature.target)
)).map(feature => `${feature.key}.raw`);
const cvRows = Array.from({ length: 45 }, (_, index) => {
    const accountId = `creator-${index % 3}`;
    const featureValues = strictForecastNames.map((name, featureIndex) => (
        0.1 * featureIndex + index / 10 + (index % 3) * 0.25
    ));
    return {
        id: `cv-${index}`,
        accountId,
        blindFeatureNames: strictForecastNames,
        blindVideoHeldOut: featureValues,
        targetKeep: 42 + index * 0.7 + (index % 3) * 3,
        targetViews: 5 + index * 0.05,
    };
});
const cvTargets = [
    {
        key: 'keep',
        selectionFamily: 'feed-decision',
        accessor: row => row.targetKeep,
    },
    {
        key: 'views',
        selectionFamily: 'reach',
        accessor: row => row.targetViews,
    },
];
const completeTargetRun = validation._crossValidatedMulti(
    cvRows,
    cvTargets,
    'video'
);
const missingUnrelatedRows = cvRows.map((row, index) => ({
    ...row,
    targetViews: index % 4 === 0 ? null : row.targetViews,
}));
const missingUnrelatedRun = validation._crossValidatedMulti(
    missingUnrelatedRows,
    cvTargets,
    'video'
);
assert.strictEqual(
    completeTargetRun.targetEligibility.keep.n,
    cvRows.length
);
assert.strictEqual(
    missingUnrelatedRun.targetEligibility.keep.n,
    cvRows.length,
    'missing an unrelated outcome must not remove a valid keep row'
);
assert(
    missingUnrelatedRun.targetEligibility.views.n < cvRows.length,
    'the missingness must affect only the views target population'
);
cvRows.forEach(row => {
    assert.strictEqual(
        missingUnrelatedRun.predictions.get(row.id)[0],
        completeTargetRun.predictions.get(row.id)[0],
        `unrelated outcome missingness changed keep prediction for ${row.id}`
    );
});
assert(
    completeTargetRun.selected.every(selection => (
        selection.innerFoldUnit === 'creator_account'
        && selection.innerCreatorCount >= 2
        && Number.isFinite(selection.innerCreatorMacroStandardizedMse)
        && Number.isFinite(selection.innerWorstCreatorStandardizedMse)
    )),
    'inner Ridge selection must be creator-balanced and expose its worst-creator loss'
);

const promotionHash = label => fixtureSha256(`promotion:${label}`);
function immutableEvidenceRecord(label, fields) {
    const artifactBytes = JSON.stringify(fields);
    const artifactSha256 = crypto.createHash('sha256')
        .update(Buffer.from(artifactBytes, 'utf8'))
        .digest('hex');
    return {
        ...fields,
        artifactBytes,
        artifactSha256,
        archiveKey:
            `prospective/by-sha256/${artifactSha256}.json`,
    };
}
const prospectiveStudy = perAccount => {
    const locked = {
        modelArtifactSha256: promotionHash('model'),
        protocolSha256: promotionHash('protocol'),
        outcomeDefinitionSha256: promotionHash('outcome'),
        evaluationPopulationSha256: promotionHash('population'),
    };
    const registrationArtifact = immutableEvidenceRecord(
        'registration',
        {
            registeredAt: 200,
            ...locked,
        }
    );
    const prospectiveResult = immutableEvidenceRecord(
        'result',
        {
            completedAt: 300,
            registrationArtifactSha256:
                registrationArtifact.artifactSha256,
            ...locked,
        },
    );
    return {
        modelArtifact: {
            artifactSha256: promotionHash('model'),
            generatedAt: 100,
        },
        protocols: {
            accountHoldout: {
                metrics: { perAccount },
            },
        },
        promotion: {
            promoted: true,
            prospectiveValidated: true,
        },
        status: {
            promoted: true,
            predictorEligible: true,
            prospectiveValidated: true,
        },
        prospectiveValidation: {
            confirmed: true,
            registrationArtifact,
            result: prospectiveResult,
        },
    };
};
const oneRowCreatorStudy = prospectiveStudy(Array.from(
    { length: 5 },
    (_, index) => ({ account: `creator-${index}`, n: 1 })
));
const oneRowPromotionAudit = validation._promotionEligibilityAudit(
    oneRowCreatorStudy,
    'visual_keep'
);
assert.strictEqual(oneRowPromotionAudit.creatorDiversityPassed, false);
assert.strictEqual(oneRowPromotionAudit.effectivePromoted, false);
assert.strictEqual(oneRowPromotionAudit.independentAccountCount, 0);
assert.strictEqual(
    oneRowPromotionAudit.minimumRowsPerIndependentAccount,
    validation._minimumConfirmatoryRowsPerAccount
);

const adequatelySizedStudy = prospectiveStudy(Array.from(
    { length: 5 },
    (_, index) => ({
        account: `creator-${index}`,
        n: validation._minimumConfirmatoryRowsPerAccount,
    })
));
const immutablePromotionAudit = validation._promotionEligibilityAudit(
    adequatelySizedStudy,
    'visual_keep'
);
assert.strictEqual(immutablePromotionAudit.creatorDiversityPassed, true);
assert.strictEqual(immutablePromotionAudit.prospectiveConfirmed, true);
assert.strictEqual(immutablePromotionAudit.effectivePromoted, true);
assert.strictEqual(
    immutablePromotionAudit.prospectiveRegistrationAudit
        .immutableEvidencePassed,
    true
);
const syntheticHashStudy = JSON.parse(JSON.stringify(
    adequatelySizedStudy
));
for (const evidence of [
    syntheticHashStudy.prospectiveValidation.registrationArtifact,
    syntheticHashStudy.prospectiveValidation.result,
]) {
    delete evidence.artifactBytes;
    evidence.artifactSha256 = promotionHash(
        `synthetic-${evidence.completedAt ? 'result' : 'registration'}`
    );
    evidence.archiveKey =
        `prospective/by-sha256/${evidence.artifactSha256}.json`;
}
syntheticHashStudy.prospectiveValidation.result
    .registrationArtifactSha256 =
    syntheticHashStudy.prospectiveValidation.registrationArtifact
        .artifactSha256;
const syntheticHashAudit = validation._promotionEligibilityAudit(
    syntheticHashStudy,
    'visual_keep'
);
assert.strictEqual(
    syntheticHashAudit.effectivePromoted,
    false,
    'matching self-reported 64-character strings cannot promote without evidence bytes'
);
assert(
    syntheticHashAudit.prospectiveRegistrationAudit.blockers.some(
        blocker => /hash-shaped metadata alone is not evidence/.test(
            blocker
        )
    )
);
const booleanOnlyStudy = JSON.parse(JSON.stringify(adequatelySizedStudy));
delete booleanOnlyStudy.prospectiveValidation.registrationArtifact;
delete booleanOnlyStudy.prospectiveValidation.result;
const booleanOnlyAudit = validation._promotionEligibilityAudit(
    booleanOnlyStudy,
    'visual_keep'
);
assert.strictEqual(
    booleanOnlyAudit.effectivePromoted,
    false,
    'caller-supplied prospective booleans cannot substitute for immutable preregistration metadata'
);
assert.strictEqual(
    booleanOnlyAudit.prospectiveRegistrationAudit.passed,
    false
);
const tamperedRegistrationStudy = JSON.parse(JSON.stringify(
    adequatelySizedStudy
));
tamperedRegistrationStudy.prospectiveValidation.result.protocolSha256 =
    promotionHash('different-protocol');
const tamperedRegistrationAudit = validation._promotionEligibilityAudit(
    tamperedRegistrationStudy,
    'visual_keep'
);
assert.strictEqual(tamperedRegistrationAudit.effectivePromoted, false);
assert(
    tamperedRegistrationAudit.prospectiveRegistrationAudit.blockers.some(
        blocker => /protocolSha256 does not match/.test(blocker)
    )
);
const conflictingPromotionStudy = JSON.parse(JSON.stringify(
    adequatelySizedStudy
));
conflictingPromotionStudy.status.promoted = false;
const conflictingPromotionAudit = validation._promotionEligibilityAudit(
    conflictingPromotionStudy,
    'visual_keep'
);
assert.strictEqual(conflictingPromotionAudit.effectivePromoted, false);
assert(
    conflictingPromotionAudit.evidenceBlockers.some(
        blocker => /promotion claims are internally inconsistent/i.test(blocker)
    )
);

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
