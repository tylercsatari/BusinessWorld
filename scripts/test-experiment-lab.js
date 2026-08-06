#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const validationBuilder = require('../buildings/jarvis/saved-channel-validation');
const {
    scoreLedgerFromFeatures,
} = require('./fixtures/score-ledger-fixture');
const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const {
    EXPECTED_COORDINATE_IDS,
    FEATURE_CONTRACT_DOCUMENT_SHA256,
    FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
    FEATURE_CONTRACT_SHA256,
    FEATURE_DEFINITIONS,
    GOVERNANCE,
    GOVERNANCE_SHA256,
    scoreRecordBindingSha256,
    scoreLedgerValidationSummary,
} = shortsScoreLedger;
const {
    CANONICAL_EVIDENCE_STATE,
    manifestRowBindingSha256,
    validateManifestRowBinding,
} = require(
    '../buildings/jarvis/saved-channel-manifest-binding'
);
const {
    canonicalArtifactIdentity,
} = require('../buildings/jarvis/canonical-json-artifact');
const displayContract = require('../embedding-display-contract');
const savedHookRuntimeIndex = require(
    '../buildings/jarvis/saved-hook-runtime-index'
);
const channelFreeKeepContract = require(
    '../buildings/jarvis/channel-free-keep-forecast-contract'
);

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = process.env.EXPERIMENT_LAB_ORIGIN || 'http://127.0.0.1:8002';
const coordinateGovernance = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'buildings/jarvis/quant-coordinate-governance.json'),
    'utf8'
));
const shortsScoreLedgerRuntime = {
    schema: 'shorts-score-ledger-browser-runtime-v1',
    schemaVersion: 1,
    ledgerSchema: 'shorts-stored-score-ledger-v1',
    ledgerSchemaVersion: 1,
    ledgerVersion: GOVERNANCE.ledgerVersion,
    percentileUnit: GOVERNANCE.percentileStorageUnit,
    featureIdentitySchemaVersion:
        FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
    featureContractSha256: FEATURE_CONTRACT_SHA256,
    featureContractDocumentSha256:
        FEATURE_CONTRACT_DOCUMENT_SHA256,
    governanceVersion: GOVERNANCE.schemaVersion,
    governanceSha256: GOVERNANCE_SHA256,
    expectedCoordinateIds: EXPECTED_COORDINATE_IDS,
    unitBounds: Object.fromEntries(
        Object.entries(GOVERNANCE.valueUnits)
            .map(([unit, definition]) => [unit, {
                min: definition.minimumInclusive,
                max: definition.maximumInclusive,
            }])
    ),
    definitions: FEATURE_DEFINITIONS.map(definition => ({
        coordinateId: definition.coordinateId,
        featureKey: definition.key,
        group: definition.group,
        target: definition.target,
        source: definition.source,
        sourceKey: definition.sourceKey || definition.key,
        unit: definition.unit,
        displayUnit: definition.displayUnit ?? null,
    })),
};
const CREATOR_ADAPTIVE_BENCHMARK_ID = 'shorts.causal-keep-mixture-benchmark.v1';
const CREATOR_ADAPTIVE_BENCHMARK_COORDINATE_ID = 'shorts.causal-keep-mixture.v1';
const CREATOR_ADAPTIVE_CANDIDATE_COUNT = 43360;
const CREATOR_ADAPTIVE_CANDIDATE_SHA256 = 'bc7ae80a7afeac82a40648c3ff07e066cc238d3b27918d5f82bf3bbbd04de3ff';
const CREATOR_ADAPTIVE_BENCHMARK_SHA256 = 'c82a290cd4180974d754e6b1c0afec8d456d08d0434794925936ffb11ea82747';
const CREATOR_ADAPTIVE_RESULT_CORE_SHA256 = 'a8dc76db007bc1b158c1e9a04775d1ae7f32656c19b44e733b0523256a42391a';
const CREATOR_ADAPTIVE_OUTPUT_TRANSFORM = 'clip(0.5 * centered-together residual analog + 0.5 * visual+together semantic stack, 0, 100)';

function bindSavedChannelFixtureRow(video) {
    video.evidence_state = CANONICAL_EVIDENCE_STATE;
    video.canonical = true;
    video.predictor_eligible = true;
    video.evidence_warning = null;
    const record = { ...video };
    record.score_record_sha256 =
        scoreRecordBindingSha256(record);
    video.score_record_sha256 =
        record.score_record_sha256;
    const artifact = canonicalArtifactIdentity(record);
    Object.defineProperty(video, '__record', {
        configurable: false,
        enumerable: false,
        value: record,
        writable: false,
    });
    video.record_artifact_sha256 = artifact.sha256;
    video.record_byte_length = artifact.byte_length;
    video.manifest_row_sha256 =
        manifestRowBindingSha256(video);
    video.score_ledger_validation =
        scoreLedgerValidationSummary(video);
    return video;
}
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
const creatorHistoryIds = (account, videoIndex) => (
    Array.from({ length: 8 }, (_, index) => `${account}-prior-${videoIndex}-${index}`)
);

async function main() {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const labUiSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings/experimentlab/experimentlab-ui.js'
        ),
        'utf8'
    );
    assert(
        labUiSource.includes(
            'window.JarvisRetention.mountShortsExperiment'
        ),
        'Experiment Lab must mount the canonical Jarvis Experiment renderer'
    );
    assert(
        labUiSource.includes(
            "{ surface: 'experiment-lab' }"
        ),
        'Experiment Lab must declare its account-scoped surface'
    );
    assert.strictEqual(
        (labUiSource.match(/\/api\//g) || []).length,
        0,
        'Experiment Lab shell must not duplicate canonical API workflows'
    );
    assert(
        labUiSource.includes("hooks: {")
            && labUiSource.includes("team: {")
            && !labUiSource.includes("channels: {"),
        'Experiment Lab navigation must expose private hooks and owner Team '
            + 'oversight without exposing the Jarvis Saved Channels product'
    );
    const retentionSource = fs.readFileSync(
        path.join(ROOT, 'buildings/jarvis/jarvis-retention.js'),
        'utf8'
    );
    assert.strictEqual(
        (retentionSource.match(/function renderExperiment\(\)/g) || []).length,
        1,
        'Shorts Quant and Experiment Lab must have exactly one Experiment renderer'
    );
    assert(
        retentionSource.includes(
            'function renderShortsExperimentSurface()'
        )
            && retentionSource.includes(
                "st.sec === 'experiment' ? renderShortsExperimentSurface()"
            )
            && retentionSource.includes(
                ': renderShortsExperimentSurface();'
            ),
        'both hosts must render the same canonical Shorts experiment surface'
    );
    assert(
        !retentionSource.includes(
            "isExperimentLabSurface() ? '' : tab('predictor'"
        )
            && !retentionSource.includes('canLoadPrivateValidation'),
        'workspace tenancy must not suppress canonical Experiment functionality'
    );
    const functionBody = (name, nextName) => retentionSource.slice(
        retentionSource.indexOf(`function ${name}(`),
        retentionSource.indexOf(`function ${nextName}(`)
    );
    assert(
        !functionBody('renderExperiment', 'renderFusion')
            .includes('isExperimentLabSurface()')
            && !functionBody(
                'renderSavedChannelLedger',
                'renderSavedChannelDetail'
            ).includes('isExperimentLabSurface()')
            && !functionBody(
                'renderSavedChannelDetail',
                'savedChannelsPanel'
            ).includes('isExperimentLabSurface()'),
        'canonical rendering, ledger, and validation methods must be '
            + 'surface-agnostic'
    );
    const labCssSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings/experimentlab/experimentlab.css'
        ),
        'utf8'
    );
    for (const color of [
        '#f5f5f7',
        '#ffffff',
        '#1d1d1f',
        '#006edb',
    ]) {
        assert(
            labCssSource.includes(color),
            `Experiment Lab light product palette is missing ${color}`
        );
    }
    assert(
        !/(?:linear|radial|conic)-gradient/i.test(
            labCssSource
        ),
        'Experiment Lab must not use decorative gradients'
    );
    assert(
        labCssSource.includes('.shorts-experiment-surface')
            && labCssSource.includes('.experiment-lab-tab')
            && labCssSource.includes('border-radius: 26px')
            && labCssSource.includes('@media (max-width: 760px)'),
        'Experiment Lab must give the shared controls a dedicated rounded, '
            + 'responsive product presentation'
    );
    assert(
        retentionSource.includes('const channelsAllowed = !isExperimentLabSurface();')
            && retentionSource.includes("if (isExperimentLabSurface()) return panel;"),
        'surface policy must remove Saved Channels only from Experiment Lab '
            + 'without forking the canonical saved-library renderer'
    );
    const featureContract = JSON.parse(fs.readFileSync(path.join(ROOT, 'buildings/jarvis/saved-channel-feature-contract.json'), 'utf8'));
    const featureContractSha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, 'buildings/jarvis/saved-channel-feature-contract.json')))
        .digest('hex');
    assert.strictEqual(
        featureContractSha256,
        FEATURE_CONTRACT_DOCUMENT_SHA256
    );
    assert.notStrictEqual(
        FEATURE_CONTRACT_DOCUMENT_SHA256,
        FEATURE_CONTRACT_SHA256,
        'the predictor release document hash must remain distinct from '
            + 'the semantic score-ledger identity hash in this fixture'
    );
    const fixtureSha256 = label => crypto.createHash('sha256').update(`experiment-lab:${label}`).digest('hex');
    const channelFreeKeepForecasts = videoIndex => {
        const inputLabels = {
            visual: 'canonical first-5-second 5-frame montage embedding only',
            text: 'canonical first-5-second normalized transcript embedding only',
            together: 'canonical montage + normalized transcript embedding',
            concat: 'ordered concatenation of visual + text + together embeddings',
        };
        const baseValues = {
            visual: 61.25,
            text: 59.5,
            together: 63.75,
            concat: 65.5,
        };
        return {
            schema: 'shorts-channel-free-keep-forecasts-v1',
            model_artifact_path:
                'buildings/jarvis/predictor-lab/channel-free-keep-model-v1.json',
            model_artifact_sha256:
                channelFreeKeepContract.MODEL_SHA256,
            model_run_id: channelFreeKeepContract.MODEL.runId,
            selected_signal:
                channelFreeKeepContract.MODEL.selectedSignal,
            source: 'live_frozen_channel_free_model_score',
            channel_information: null,
            outputs: Object.fromEntries(
                channelFreeKeepContract.SIGNALS.map(signal => {
                    const model = channelFreeKeepContract.MODEL.models[signal];
                    const validation = channelFreeKeepContract.MODEL
                        .validation[signal].oof_5x5;
                    const raw = baseValues[signal] + videoIndex * 0.4;
                    return [signal, {
                        coordinate_id:
                            channelFreeKeepContract.COORDINATE_IDS[signal],
                        signal,
                        kind: 'channel_free_keep_rate_percent',
                        unit: 'percent',
                        percentile_unit: 'percentile_0_100',
                        input: inputLabels[signal],
                        channel_information: null,
                        calibration_scope: 'pooled_global_no_creator',
                        source: 'live_frozen_channel_free_model_score',
                        model_artifact_path:
                            'buildings/jarvis/predictor-lab/channel-free-keep-model-v1.json',
                        model_artifact_sha256:
                            channelFreeKeepContract.MODEL_SHA256,
                        model_run_id:
                            channelFreeKeepContract.MODEL.runId,
                        model_generated_at:
                            channelFreeKeepContract.MODEL.generatedAt,
                        training_identity_hash:
                            channelFreeKeepContract.MODEL.training
                                .identityHash,
                        selected:
                            channelFreeKeepContract.MODEL.selectedSignal
                                === signal,
                        oof_mae: validation.mae_mean,
                        oof_spearman: validation.spearman_mean,
                        percentile_reference_n:
                            model.percentileReference.length,
                        available: true,
                        est: raw,
                        raw,
                        pctile: 45 + videoIndex * 1.5,
                        unavailable_reason: null,
                    }];
                })
            ),
        };
    };
    const population = (label, rowCount) => ({
        rowCount,
        uniqueVideoCount: rowCount,
        duplicateVideoCount: 0,
        videoIdSha256: fixtureSha256(`population:${label}`),
        orderedVideoIdSha256: fixtureSha256(`ordered-population:${label}`),
    });
    const shortsMapManifest = modality => ({
        producerSourceSha256: fixtureSha256(`shorts-map-source:${modality}`),
        publishedMap: {
            ...population(`shorts-map:${modality}`, 120),
            artifactSha256: fixtureSha256(`shorts-map:${modality}`),
            archiveKey: `raw/${modality}/maps/by-sha256/${fixtureSha256(`shorts-map:${modality}`)}.json`,
        },
        publishedPlot: {
            artifactSha256: fixtureSha256(`shorts-plot:${modality}`),
            archiveKey: `raw/${modality}/plots/by-sha256/${fixtureSha256(`shorts-plot:${modality}`)}.json`,
        },
        embeddingStore: {
            ...population(`shorts-embedding:${modality}`, 120),
            artifactSha256: fixtureSha256(`shorts-embedding:${modality}`),
            source: `raw/${modality}/embeddings.npz`,
        },
    });
    const snakePopulation = (label, rowCount) => ({
        row_count: rowCount,
        unique_video_id_count: rowCount,
        duplicate_video_id_count: 0,
        video_id_sha256: fixtureSha256(`population:${label}`),
        ordered_video_id_sha256: fixtureSha256(`ordered-population:${label}`),
    });
    const longMapManifest = modality => ({
        algorithm_generation: {
            generator_source_sha256: fixtureSha256(`long-map-source:${modality}`),
        },
        immutable_manifest_key: `raw-long/${modality}/manifests/by-sha256/${fixtureSha256(`long-map-manifest:${modality}`)}.json`,
        embedding_archive: {
            sha256: fixtureSha256(`long-embedding:${modality}`),
            immutable_key: `raw-long/${modality}/embeddings/by-sha256/${fixtureSha256(`long-embedding:${modality}`)}.npz`,
            mutable_key: `raw-long/${modality}/embeddings.npz`,
            video_id_population: snakePopulation(`long-embedding:${modality}`, 110),
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
            intersection: snakePopulation(`long-intersection:${modality}`, 110),
        },
        account_metric_private_fit_populations: {
            tyler: {
                ctr: snakePopulation(`long:${modality}:tyler:ctr`, 40),
                ret30: snakePopulation(`long:${modality}:tyler:ret30`, 38),
            },
            all: {
                ctr: snakePopulation(`long:${modality}:all:ctr`, 72),
                ret30: snakePopulation(`long:${modality}:all:ret30`, 68),
            },
        },
        label_snapshot_revisions: {
            tyler: { sha256: fixtureSha256('long-label:tyler') },
            all: { sha256: fixtureSha256('long-label:all') },
        },
    });
    const indicatorRegistry = {
        indicators: ['keep', 'ret5', 'views'].map((target, index) => ({
            name: `nov_${target}`,
            kind: 'novelty',
            target,
            validated: true,
            spearman: 0.2 + index * 0.1,
            pts: [[0.1, 1], [0.2, 2], [0.3, 3]],
        })),
    };
    const runtimeManifests = {
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
                    tyler: population('shorts-view-equation:tyler', 42),
                    all: population('shorts-view-equation:all', 48),
                },
                modalities: Object.fromEntries(['visual', 'text', 'together'].map(modality => [
                    modality,
                    {
                        axes: Object.fromEntries(['keep', 'ret5', 'views', 'outlier', 'gt10M'].map(target => [
                            target,
                            { fitPopulation: population(`shorts:${modality}:${target}`, 50) },
                        ])),
                    },
                ])),
            },
        },
        shortsVisualMap: { key: 'raw/visual/map.manifest.json', artifactSha256: fixtureSha256('shorts-map-manifest:visual'), value: shortsMapManifest('visual') },
        shortsTextMap: { key: 'raw/text/map.manifest.json', artifactSha256: fixtureSha256('shorts-map-manifest:text'), value: shortsMapManifest('text') },
        shortsTogetherMap: { key: 'raw/together/map.manifest.json', artifactSha256: fixtureSha256('shorts-map-manifest:together'), value: shortsMapManifest('together') },
        noveltyModels: { key: 'raw/novelty_models.npz', artifactSha256: fixtureSha256('novelty-models'), bytes: 100 },
        indicatorWeights: { key: 'raw/indicators/weights.npz', artifactSha256: fixtureSha256('indicator-weights'), bytes: 100 },
        indicatorRegistry: { key: 'raw/indicators/registry.json', artifactSha256: fixtureSha256('indicator-registry'), value: indicatorRegistry },
        shortsLiveScoreSource: { key: 'local:raw_upload.py', artifactSha256: fixtureSha256('raw-upload-source') },
        shortsChannelWorkerSource: { key: 'local:yt_relay_watcher.py', artifactSha256: fixtureSha256('saved-channel-worker-source') },
        creatorAdaptiveKeepModelRelease: {
            key: 'raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json',
            artifactSha256: fixtureSha256('creator-adaptive-keep-release-manifest'),
            manifestSha256: fixtureSha256('creator-adaptive-keep-release-manifest'),
            archiveKey: `raw/predictor-lab/creator-adaptive-keep-model/by-sha256/${fixtureSha256('creator-adaptive-keep-model')}.json`,
            producerSourceSha256: fixtureSha256('creator-adaptive-keep-producer'),
            featureContractVersion: featureContract.version,
            featureContractSha256,
        },
        longVisualMap: { key: 'raw-long/visual/map.manifest.json', artifactSha256: fixtureSha256('long-map-manifest:visual'), value: longMapManifest('visual') },
        longTextMap: { key: 'raw-long/text/map.manifest.json', artifactSha256: fixtureSha256('long-map-manifest:text'), value: longMapManifest('text') },
        longTogetherMap: { key: 'raw-long/together/map.manifest.json', artifactSha256: fixtureSha256('long-map-manifest:together'), value: longMapManifest('together') },
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
                    privateCtrFit: population('long-frozen-ctr', 55),
                    curatedViewsFit: population('long-frozen-curated', 70),
                },
                sourceRevisions: {
                    curatedIds: { sha256: fixtureSha256('long-curated-source') },
                },
            },
        },
        longScoreSource: { key: 'local:longquant_score.py', artifactSha256: fixtureSha256('long-score-source') },
    };
    assert(index.includes("makeClickable(g, 'Experiment Lab')"), '3D Experiment Lab is not registered as clickable');
    assert(index.includes("'Experiment Lab': experimentLab"), 'Experiment Lab is absent from persistent building lookup');

    const browser = await chromium.launch({
        headless: true,
        executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            || undefined,
    });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
        page.on('pageerror', error => console.error('PAGE ERROR:', error.stack || error.message));
        page.on('console', message => { if (message.type() === 'error') console.error('BROWSER ERROR:', message.text()); });
        page.on('requestfailed', request => console.error('REQUEST FAILED:', request.url(), request.failure() && request.failure().errorText));
        page.on('response', response => {
            if (response.status() >= 400) {
                console.error(
                    'HTTP ERROR:',
                    response.status(),
                    response.url()
                );
            }
        });
        await page.route('**/api/raw/saved-channel/**/montage/**', route => route.fulfill({
            status: 200,
            contentType: 'image/gif',
            body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
        }));
        await page.route('**/api/raw/montage/**', route => route.fulfill({
            status: 200,
            contentType: 'image/gif',
            body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
        }));
        await page.route('**/api/raw/saved-montage/**', route => route.fulfill({
            status: 200,
            contentType: 'image/gif',
            body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
        }));
        await page.route('**/api/hooks/grind/montage/**', route => route.fulfill({
            status: 200,
            contentType: 'image/gif',
            body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
        }));
        await page.route(`${ORIGIN}/__experiment-lab-origin__`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Experiment Lab test origin</title>' }));
        // Establish the local origin without loading Business World's global bundles twice.
        await page.goto(`${ORIGIN}/__experiment-lab-origin__`, { waitUntil: 'domcontentloaded' });
        const channelId = 'chd3f5a3dae83f3382';
        const videos = Array.from({ length: 20 }, (_, videoIndex) => {
            const id = `vid${String(videoIndex + 1).padStart(8, '0')}`;
            const views = videoIndex === 0 ? 50000000 : videoIndex === 1 ? 1000000 : Math.round(18000000 / (videoIndex + 1));
            const features = Object.fromEntries(featureContract.features.map((feature, featureIndex) => {
                const percentile = feature.key === 'text.keep'
                    ? (videoIndex === 1 ? 99 : videoIndex === 0 ? 10 : Math.max(1, 90 - videoIndex * 3))
                    : Math.max(1, Math.min(99, 92 - videoIndex * 3 + (featureIndex % 5)));
                const value = feature.unit === 'views' ? Math.round(Math.pow(10, 5.2 + percentile / 42))
                    : feature.unit === 'probability' ? percentile / 100
                        : feature.unit === 'percent' ? percentile
                            : percentile / 10;
                return [feature.key, [value, percentile]];
            }));
            if (videoIndex === 1) features['together.views'] = [12000000, 88];
            return {
                id,
                title: videoIndex === 0 ? 'Highest raw views' : videoIndex === 1 ? 'Highest text keep rate' : `Stored Short ${videoIndex + 1}`,
                status: 'done',
                hasMontage: true,
                sourceUrl: `https://youtube.com/shorts/${id}`,
                views,
                subscribers: 1000000,
                scoredAt: Date.now() - videoIndex * 1000,
                features,
                indicators: {},
                channel_free_keep_forecasts:
                    channelFreeKeepForecasts(videoIndex),
                visual_keep_forecast: {
                    coordinate_id: 'shorts.visual-keep-forecast.v1',
                    est: 61.25 + videoIndex * .55,
                    raw: 61.25 + videoIndex * .55,
                    pctile: null,
                    kind: 'keep_rate_percent',
                    unit: 'percent',
                    calibration_scope: 'pooled_global',
                    account_model: null,
                    source: 'live_frozen_model_score',
                    model_artifact_sha256: fixtureSha256('visual-keep-model'),
                    model_manifest_sha256:
                        fixtureSha256('visual-keep-model-manifest'),
                    model_artifact_key:
                        'raw/predictor-lab/visual-keep-model/by-sha256/'
                        + `${fixtureSha256('visual-keep-model')}.json`,
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
                },
                creator_adaptive_keep_forecast: {
                    coordinate_id: 'shorts.creator-adaptive-keep.v1',
                    est: 58.5 + videoIndex * .9,
                    raw: 58.5 + videoIndex * .9,
                    pctile: null,
                    kind: 'keep_rate_percent',
                    unit: 'percent',
                    calibration_scope:
                        'creator_profile_snapshot',
                    profile_account: 'tyler',
                    profile_account_name: 'Tyler Csatari',
                    history_n: 8,
                    history_start: Date.UTC(2024, 0, 1),
                    history_end: Date.UTC(2025, 0, 1) + videoIndex,
                    history_video_ids: creatorHistoryIds('tyler', videoIndex),
                    history_only_baseline: 57.25 + videoIndex * .5,
                    component_a: 58 + videoIndex * .9,
                    component_b: 59 + videoIndex * .9,
                    component_a_definition: 'Centered together-embedding residual analog',
                    component_b_definition: 'Visual-plus-together semantic stack',
                    model_modality: 'multimodal',
                    model_history_window: 30,
                    model_minimum_history_n: 8,
                    model_formula: CREATOR_ADAPTIVE_OUTPUT_TRANSFORM,
                    benchmark_id: CREATOR_ADAPTIVE_BENCHMARK_ID,
                    benchmark_artifact_sha256: CREATOR_ADAPTIVE_BENCHMARK_SHA256,
                    candidate_registry_sha256: CREATOR_ADAPTIVE_CANDIDATE_SHA256,
                    candidate_count: CREATOR_ADAPTIVE_CANDIDATE_COUNT,
                    model_artifact_sha256: fixtureSha256('creator-adaptive-keep-model'),
                    model_artifact_key:
                        'raw/predictor-lab/creator-adaptive-keep-model/by-sha256/'
                        + `${fixtureSha256('creator-adaptive-keep-model')}.json`,
                    model_artifact_canonical_key:
                        'raw/predictor-lab/creator-adaptive-keep-model-v1.json',
                    model_manifest_sha256:
                        fixtureSha256(
                            'creator-adaptive-keep-model-manifest'
                        ),
                    model_manifest_key:
                        'raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json',
                    model_producer_source_sha256:
                        fixtureSha256(
                            'creator-adaptive-keep-model-producer'
                        ),
                    serving_artifact_sha256:
                        fixtureSha256(
                            'creator-adaptive-keep-serving'
                        ),
                    serving_artifact_key:
                        'raw/predictor-lab/creator-adaptive-keep-serving/by-sha256/'
                        + `${fixtureSha256(
                            'creator-adaptive-keep-serving'
                        )}.npz`,
                    serving_artifact_canonical_key:
                        'raw/predictor-lab/creator-adaptive-keep-serving-v1.npz',
                    serving_manifest_sha256:
                        fixtureSha256(
                            'creator-adaptive-keep-serving-manifest'
                        ),
                    serving_manifest_key:
                        'raw/predictor-lab/creator-adaptive-keep-serving-v1.manifest.json',
                    serving_producer_source_sha256:
                        fixtureSha256(
                            'creator-adaptive-keep-serving-producer'
                        ),
                    serving_scorer_source_sha256:
                        fixtureSha256(
                            'creator-adaptive-keep-serving-scorer'
                        ),
                    feature_contract_version:
                        featureContract.version,
                    feature_contract_sha256:
                        FEATURE_CONTRACT_DOCUMENT_SHA256,
                    input:
                        'canonical visual embedding + canonical together embedding + registered strictly-earlier creator profile history',
                    forecast_scope:
                        'future_upload_after_profile_history',
                    historical_replay_valid: false,
                    claim_boundary:
                        'Valid only for uploads after the registered profile history cutoff.',
                    predictor_eligible: false,
                    research_only: true,
                    source:
                        'live_creator_profile_shadow_score',
                    model_status: {
                        state: 'research_only_retrospective_target_met',
                        promoted: false,
                        predictorEligible: false,
                    },
                },
                input_manifest: {
                    input_fingerprint:
                        fixtureSha256(`score-input:${id}`),
                    score_input_fingerprint:
                        fixtureSha256(`score-input:${id}`),
                    embedding_input_fingerprint:
                        fixtureSha256(`embedding-input:${id}`),
                    revision_fingerprint:
                        fixtureSha256('current-live-revision'),
                    output_fingerprint:
                        fixtureSha256(`output:${id}`),
                    canonical_montage: {
                        montage_sha256:
                            fixtureSha256(`montage:${id}`),
                    },
                    creator_profile: 'tyler',
                    scorer_revisions: {
                        scorer: { sha256: 'feedface01234567' },
                        artifacts: {
                            'raw/predictor-lab/visual-keep-model-v1.manifest.json': {
                                sha256:
                                    fixtureSha256(
                                        'visual-keep-model-manifest'
                                    ),
                            },
                            'raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json': {
                                sha256:
                                    fixtureSha256(
                                        'creator-adaptive-keep-model-manifest'
                                    ),
                            },
                            'raw/predictor-lab/creator-adaptive-keep-serving-v1.manifest.json': {
                                sha256:
                                    fixtureSha256(
                                        'creator-adaptive-keep-serving-manifest'
                                    ),
                            },
                        },
                    },
                    feature_contract_sha256:
                        FEATURE_CONTRACT_SHA256,
                    feature_contract_document_sha256:
                        FEATURE_CONTRACT_DOCUMENT_SHA256,
                    channels: {
                        visual: {
                            present: true,
                            input: 'first-five-second five-frame montage only',
                        },
                        text: {
                            present: true,
                            input: 'first-five-second transcript only',
                        },
                        together: {
                            present: true,
                            input: 'first-five-second montage plus transcript',
                        },
                    },
                    steer_artifact_sha256: '0123456789abcdef',
                    steer_artifact_archive_key: 'raw/steer_models/by-sha256/0123456789abcdef.npz',
                    steer_lineage_manifest_sha256: 'abcdef0123456789',
                    steer_lineage_schema_version: 1,
                },
            };
        });
        videos.forEach(video => {
            video.score_ledger =
                scoreLedgerFromFeatures(video.features);
            bindSavedChannelFixtureRow(video);
        });
        // The ledger is the scalar authority. API summaries are diagnostics,
        // so an omitted or stale wrapper must never turn valid coordinates
        // into dashes on a saved card.
        delete videos[2].score_ledger_validation;
        videos[3].score_ledger_validation = {
            state: 'stale-wrapper-fixture',
            valid: false,
            ledger_sha256: null,
            errors: ['fixture wrapper is intentionally stale'],
        };
        const historicalSavedHookId = 'hkhistoricaldisplay';
        const historicalSavedHookRecord = JSON.parse(
            JSON.stringify(videos[0].__record)
        );
        historicalSavedHookRecord.id = historicalSavedHookId;
        historicalSavedHookRecord.title =
            'Historical ledger display parity';
        historicalSavedHookRecord.savedAt = Date.now();
        historicalSavedHookRecord.hasMontage = false;
        historicalSavedHookRecord.evidence_state =
            'legacy_unbound_evidence';
        historicalSavedHookRecord.canonical = false;
        historicalSavedHookRecord.predictor_eligible = false;
        historicalSavedHookRecord.evidence_warning =
            'Historical display only.';
        delete historicalSavedHookRecord.score_ledger_validation;
        historicalSavedHookRecord.score_ledger.entries.forEach(
            entry => {
                entry.provenance = {
                    ...(entry.provenance || {}),
                    status: entry.available
                        ? 'historical_materialization'
                        : 'unavailable',
                };
            }
        );
        historicalSavedHookRecord.score_ledger
            .feature_contract_document_sha256 = '4'.repeat(64);
        delete historicalSavedHookRecord.score_ledger.ledger_sha256;
        historicalSavedHookRecord.score_ledger.ledger_sha256 =
            shortsScoreLedger.sha256Canonical(
                historicalSavedHookRecord.score_ledger
            );
        historicalSavedHookRecord.score_materialization = {
            schema: 'saved-hook-historical-materialization-v1',
            role: 'historical_evidence_not_live_rescore',
            ledger_sha256:
                historicalSavedHookRecord.score_ledger
                    .ledger_sha256,
            source_record_sha256: fixtureSha256(
                'historical-source-record'
            ),
            source_fields: ['features', 'steer'],
            claim_boundary:
                'Historical display only; not a current prediction.',
        };
        const historicalDocumentValidation =
            shortsScoreLedger.validateScoreLedger(
                historicalSavedHookRecord.score_ledger
            );
        assert.strictEqual(historicalDocumentValidation.valid, true);
        assert.strictEqual(
            historicalDocumentValidation.featureContractDocumentCurrent,
            false,
            'historical browser fixture must retain its archived document revision'
        );
        const historicalSavedHookRow =
            savedHookRuntimeIndex.legacyRow(
                historicalSavedHookRecord
            );
        assert(
            historicalSavedHookRow.historical_display,
            'fixture must contain a hash-bound historical display'
        );
        const historicalSavedHookKeep =
            historicalSavedHookRow.historical_display
                .m_identity.keep;
        const queuedSavedHookId = 'hkqueueddisplay';
        const queuedSavedHookRecord = JSON.parse(
            JSON.stringify(historicalSavedHookRecord)
        );
        queuedSavedHookRecord.id = queuedSavedHookId;
        queuedSavedHookRecord.title =
            'Second persisted analysis in queue';
        queuedSavedHookRecord.savedAt = Date.now() - 1000;
        const queuedSavedHookRow =
            savedHookRuntimeIndex.legacyRow(
                queuedSavedHookRecord
            );
        assert(
            queuedSavedHookRow.historical_display,
            'second queue fixture must contain a valid historical display'
        );
        const failedSavedHookId = 'hkfaileddisplay';
        const failedSavedHookRecord = JSON.parse(
            JSON.stringify(historicalSavedHookRecord)
        );
        failedSavedHookRecord.id = failedSavedHookId;
        failedSavedHookRecord.title =
            'Saved detail failure is visible';
        failedSavedHookRecord.savedAt = Date.now() - 1500;
        const failedSavedHookRow =
            savedHookRuntimeIndex.legacyRow(
                failedSavedHookRecord
            );
        assert(
            failedSavedHookRow.historical_display,
            'failed queue fixture must still have a valid index row'
        );
        const canonicalChannelFreeSavedHook = (
            videoIndex,
            id,
            title,
            savedAt
        ) => {
            const record = JSON.parse(
                JSON.stringify(videos[videoIndex].__record)
            );
            record.id = id;
            record.kind = 'scored';
            record.score_domain = 'shorts';
            record.title = title;
            record.text = title;
            record.savedAt = savedAt;
            record.hasMontage = true;
            record.input_manifest = {
                ...record.input_manifest,
                domain: 'shorts_raw',
            };
            delete record.score_record_sha256;
            record.score_record_sha256 =
                displayContract.savedHookScoreRecordSha256(record);
            const row = displayContract.compactSavedHookRecord(
                record,
                { scoreDomain: 'shorts' }
            );
            assert.strictEqual(
                displayContract.validateCompactSavedHookRecord(row),
                true,
                'channel-free saved-hook fixture must be a valid '
                    + 'hash-bound compact row'
            );
            return { record, row };
        };
        const autoSavedHookId = 'hk-auto-opened-score';
        const autoSavedHookRecord = JSON.parse(
            JSON.stringify(videos[0].__record)
        );
        autoSavedHookRecord.id = autoSavedHookId;
        autoSavedHookRecord.title =
            'Automatically opened YouTube score';
        autoSavedHookRecord.text = historicalSavedHookRecord.text
            || 'Saved fixture transcript for editing.';
        autoSavedHookRecord.source = 'youtube';
        autoSavedHookRecord.savedAt = Date.now() + 1000;
        autoSavedHookRecord.hasMontage = true;
        delete autoSavedHookRecord.score_record_sha256;
        autoSavedHookRecord.score_record_sha256 =
            displayContract.savedHookScoreRecordSha256(
                autoSavedHookRecord
            );
        const autoSavedHookRow =
            displayContract.compactSavedHookRecord(
                autoSavedHookRecord,
                { scoreDomain: 'shorts' }
            );
        assert.strictEqual(
            displayContract.validateCompactSavedHookRecord(
                autoSavedHookRow
            ),
            true,
            'auto-saved browser fixture must expose the exact compact row'
        );
        const channelFreeLowId = 'hkchannelconcatchlow';
        const channelFreeHighId = 'hkchannelconcatchhigh';
        const channelFreeLow = canonicalChannelFreeSavedHook(
            1,
            channelFreeLowId,
            'Lower channel-free concat opening',
            Date.now() - 2000
        );
        const channelFreeHigh = canonicalChannelFreeSavedHook(
            18,
            channelFreeHighId,
            'Higher channel-free concat opening',
            Date.now() - 3000
        );
        const channelFreeLowOutput = channelFreeLow.row
            .derived_identity.channel_free_keep.concat;
        const channelFreeHighOutput = channelFreeHigh.row
            .derived_identity.channel_free_keep.concat;
        assert(
            channelFreeHighOutput.raw > channelFreeLowOutput.raw,
            'channel-free sort fixtures must have distinct raw forecasts'
        );
        const historicalUpgradeScore = JSON.parse(
            JSON.stringify(videos[0].__record)
        );
        historicalUpgradeScore.id = historicalSavedHookId;
        historicalUpgradeScore.title =
            historicalSavedHookRecord.title;
        historicalUpgradeScore.text =
            historicalSavedHookRecord.text;
        historicalUpgradeScore.transcript =
            historicalSavedHookRecord.text;
        historicalUpgradeScore.montage =
            'c2NvcmVyLWNhbm9uaWNhbC1tb250YWdl';
        historicalUpgradeScore.hasMontage = true;
        historicalUpgradeScore.evidence_state = 'canonical_bound';
        historicalUpgradeScore.predictor_eligible = true;
        historicalUpgradeScore.score_display_eligible = true;
        historicalUpgradeScore.score_ledger_validation =
            scoreLedgerValidationSummary(historicalUpgradeScore);
        historicalUpgradeScore.score_record_validation = {
            state: 'verified',
            valid: true,
            recorded_sha256:
                historicalUpgradeScore.score_record_sha256,
            calculated_sha256:
                historicalUpgradeScore.score_record_sha256,
        };
        const rebindHistoricalFixture = fixture => {
            delete fixture.score_ledger.ledger_sha256;
            fixture.score_ledger.ledger_sha256 =
                shortsScoreLedger.sha256Canonical(
                    fixture.score_ledger
                );
            fixture.score_materialization.ledger_sha256 =
                fixture.score_ledger.ledger_sha256;
            fixture.historical_display.score_ledger_sha256 =
                fixture.score_ledger.ledger_sha256;
            fixture.historical_display.selection_policy
                .source_ledger_sha256 =
                    fixture.score_ledger.ledger_sha256;
            Object.values(
                fixture.historical_display.m_identity
            ).filter(Boolean).forEach(identity => {
                identity.ledgerSha256 =
                    fixture.score_ledger.ledger_sha256;
            });
            delete fixture.historical_display.display_sha256;
            fixture.historical_display.display_sha256 =
                shortsScoreLedger.sha256Canonical(
                    displayContract
                        .historicalSavedHookDisplayBindingPayload(
                            fixture.historical_display
                        )
                );
            return fixture;
        };
        const historicalTamperFixtures = [];
        const tamperedDisplay = JSON.parse(JSON.stringify({
            ...historicalSavedHookRecord,
            historical_display:
                historicalSavedHookRow.historical_display,
        }));
        tamperedDisplay.historical_display.m_identity.keep.value += 1;
        historicalTamperFixtures.push(tamperedDisplay);
        const tamperedMaterialization = JSON.parse(JSON.stringify({
            ...historicalSavedHookRecord,
            historical_display:
                historicalSavedHookRow.historical_display,
        }));
        tamperedMaterialization.score_materialization.role =
            'live_rescore';
        historicalTamperFixtures.push(tamperedMaterialization);
        const tamperedContractIdentity = JSON.parse(JSON.stringify({
            ...historicalSavedHookRecord,
            historical_display:
                historicalSavedHookRow.historical_display,
        }));
        tamperedContractIdentity.score_ledger
            .coordinate_governance_sha256 = '6'.repeat(64);
        historicalTamperFixtures.push(
            rebindHistoricalFixture(tamperedContractIdentity)
        );
        const tamperedProvenance = JSON.parse(JSON.stringify({
            ...historicalSavedHookRecord,
            historical_display:
                historicalSavedHookRow.historical_display,
        }));
        tamperedProvenance.score_ledger.entries[0]
            .provenance.status = 'current_score';
        historicalTamperFixtures.push(
            rebindHistoricalFixture(tamperedProvenance)
        );
        const unfinishedVideo = { id: 'vid99999999', title: 'Retry this Short', status: 'error', views: 0, error: 'temporary worker failure', hasMontage: false };
        const singles = featureContract.features.map((feature, index) => ({
            key: feature.key,
            coverage: 1,
            pearsonRawViews: .42 - index / 100,
            pearsonLogViews: .38 - index / 120,
            spearmanViews: feature.key === 'text.keep' ? .71 : .31 - index / 150,
            oof: { r2: feature.key === 'text.keep' ? .36 : Math.max(-.08, .18 - index / 100), medianFactor: 1.5 + index / 50 },
        }));
        const tailRankings = featureContract.features.map((feature, index) => ({
            key: feature.key,
            direction: 'higher',
            directionalAuc: feature.key === 'text.keep' ? .81 : .67 - index / 200,
            prAuc: .7 - index / 200,
            topDecile: { n: 2, hits: index < 3 ? 2 : 1, hitRate: index < 3 ? 1 : .5, ciLow: .21, ciHigh: 1, lift: index < 3 ? 2 : 1 },
        }));
        const riskThreshold = { threshold: 30000000, n: 12, passRate: .6, hits: 9, misses: 3, hitRate: .75, ciLow: .47, ciHigh: .91, lift: 1.5, recall: .9, actualViewsP10: 800000, actualViewsP25: 4200000, actualViewsMedian: 18000000, actualViewsP75: 35000000 };
        const riskSignal = { key: 'together.views', label: 'Both · Views (library)', available: 20, baseRate: .5, thresholds: [riskThreshold], calibrationBins: [{ n: 10, scoreMedian: 8000000, actualViewsMedian: 4000000, hitRate: .2, ciLow: .06, ciHigh: .51 }, { n: 10, scoreMedian: 40000000, actualViewsMedian: 22000000, hitRate: .8, ciLow: .49, ciHigh: .94 }], bestEvidence: riskThreshold };
        const riskSignals = featureContract.features.filter(feature => feature.unit === 'views').map(feature => ({ ...riskSignal, key: feature.key, label: `${feature.group} · ${feature.label}` }));
        const riskCohort = { minAgeDays: 30, n: 20, knownAge: 20, positives: 10, baseRate: .5, viewsSignals: riskSignals, featureRankings: tailRankings };
        const nestedPoints = videos.map((video, index) => ({ id: video.id, title: video.title, actualViews: video.views, predictedViews: Math.max(1000, video.views * (index % 2 ? .8 : 1.2)), actualLog: Math.log10(video.views + 1), predictedLog: Math.log10(Math.max(1000, video.views * (index % 2 ? .8 : 1.2))) }));
        const binaryPoints = videos.map((video, index) => ({ id: video.id, title: video.title, actualViews: video.views, hit: index % 2 ? 0 : 1, probability: index % 2 ? .18 + index / 200 : .78 - index / 300 }));
        const matrixRows = videos.slice().sort((a, b) => b.views - a.views).map((video, index) => ({
            id: video.id,
            title: video.title,
            views: video.views,
            publishedAt: Date.now() - (index + 30) * 86400000,
            ageDays: index + 30,
            viewsPercentile: 100 - index / (videos.length - 1) * 100,
            values: featureContract.features.map(feature => video.features[feature.key][1]),
            rawValues: featureContract.features.map(feature => video.features[feature.key][0]),
        }));
        const relationships = featureContract.features.map((feature, row) => featureContract.features.map((other, column) => ({ n: 20, pearson: row === column ? 1 : .7 - Math.abs(row - column) / 30, spearman: row === column ? 1 : .65 - Math.abs(row - column) / 30 })));
        const featureProfiles = featureContract.features.map(feature => {
            const values = videos.map(video => video.features[feature.key][0]);
            return {
                key: feature.key, group: feature.group, label: feature.label, unit: feature.unit, available: 20, missing: 0,
                rawDistribution: { min: Math.min(...values), p10: values[2], p25: values[5], median: values[10], p75: values[15], p90: values[18], max: Math.max(...values) },
                bins: Array.from({ length: 5 }, (_, index) => ({ n: 4, scoreMedian: .1 + index * .2, rawMedian: values[index * 4], actualViewsP25: 400000 + index * 700000, actualViewsMedian: 800000 + index * 2500000, actualViewsP75: 1800000 + index * 5000000, hitRate10M: index / 4, hitRate10MCiLow: Math.max(0, index / 4 - .18), hitRate10MCiHigh: Math.min(1, index / 4 + .18) })),
            };
        });
        const outcomeProfile = { n: 20, min: Math.min(...videos.map(video => video.views)), p10: 300000, p25: 700000, median: 1800000, p75: 6000000, p90: 18000000, max: 50000000, histogram: Array.from({ length: 6 }, (_, index) => ({ logLow: 5 + index * .45, logHigh: 5.45 + index * .45, n: index === 5 ? 5 : 3 })) };
        const riskAnalysis = {
            channelId, status: 'ready', n: 20, transcriptCoverage: 1,
            outcome: { primary: 'log10(raw YouTube views + 1)', validation: 'Out of fold.' },
            search: { exhaustiveCandidates: 1561, forwardPathModels: 21 },
            singles,
            signalSummary: { strongestTrajectory: singles.find(row => row.key === 'text.keep'), strongestBlindSingle: singles.find(row => row.key === 'text.keep'), strongestTail: tailRankings.find(row => row.key === 'text.keep') },
            indicatorMatrix: { columns: featureContract.features.map(feature => ({ key: feature.key, group: feature.group, label: feature.label })), rows: matrixRows },
            indicatorRelationships: { columns: featureContract.features.map(feature => ({ key: feature.key, group: feature.group, label: feature.label })), matrix: relationships },
            featureProfiles,
            outcomeProfile,
            topCombinations: [{ keys: ['text.keep'], r2: .36, spearman: .5, medianFactor: 1.55 }, { keys: ['text.keep', 'together.views'], r2: .41, spearman: .55, medianFactor: 1.4 }, { keys: ['text.keep', 'together.views', 'visual.gt10M'], r2: .43, spearman: .57, medianFactor: 1.35 }],
            forwardPath: [{ size: 1, added: 'text.keep', r2: .36 }, { size: 2, added: 'together.views', r2: .41 }],
            models: {
                nestedSelected: { r2: .39, medianFactor: 1.48, points: nestedPoints, selections: [{ features: ['text.keep', 'together.views'], folds: 3 }, { features: ['visual.gt10M'], folds: 2 }] },
                allIndicators: { r2: .33, medianFactor: 1.62 },
                bestExploratory: { r2: .41, medianFactor: 1.4 },
            },
            risk: {
                primaryTargetViews: 10000000, targetOptions: [1000000, 10000000],
                targets: [{ targetViews: 1000000, cohorts: [{ ...riskCohort, minAgeDays: 0, positives: 16, baseRate: .8 }, { ...riskCohort, positives: 16, baseRate: .8 }] }, { targetViews: 10000000, cohorts: [{ ...riskCohort, minAgeDays: 0 }, riskCohort] }],
                viewAgeConfound: { knownAge: 20, total: 20, pearsonLogAgeToLogViews: .12 },
                model: { status: 'ready', targetViews: 10000000, positives: 10, negatives: 10, exhaustiveCandidates: 1561, validation: 'Blind combination selection.', nestedSelected: { rocAuc: .8, prAuc: .77, brierSkill: .31, calibrationError: .07, calibrationBins: [{ n: 10, predicted: .2, observed: .1 }, { n: 10, predicted: .8, observed: .9 }], points: binaryPoints }, chronological: { rocAuc: .74 } },
            },
        };
        const blindFeatureNames = [
            ...['visual', 'text', 'together'].flatMap(group =>
                ['keep', 'ret5', 'views', 'realviews', 'outlier', 'gt10M'].flatMap(target => [
                    `${group}.${target}.raw`,
                    `${group}.${target}.percentile`,
                ])
            ),
            'novelty.temporal.raw', 'novelty.temporal.percentile',
            'novelty.niche.raw', 'novelty.niche.percentile',
            'novelty.combinatorial.raw', 'novelty.combinatorial.percentile',
            'text.present', 'duration.log', 'title.words',
        ];
        const blindVector = index => blindFeatureNames.map(name => {
            if (name.endsWith('.percentile')) return Math.min(99, 20 + index * 3);
            if (name.endsWith('.views.raw') || name.endsWith('.realviews.raw')) return Math.log10(videos[index].views + 1);
            if (name.endsWith('.keep.raw')) return 58 + index;
            if (name.endsWith('.ret5.raw')) return 70 + index / 2;
            if (name.endsWith('.gt10M.raw')) return index % 2 ? .25 : .75;
            if (name.endsWith('.outlier.raw')) return .4 + index / 20;
            return 1;
        });
        const privateVideos = videos.map((video, index) => ({
            id: video.id,
            title: video.title,
            keep_rate: 57 + index,
            ret5: 69 + index / 2,
            avg_retention: 82 - index / 3,
            views: Math.round(video.views * .92),
            duration_s: 28 + index / 2,
            curve: Array.from({ length: 101 }, (_, curveIndex) => 1.2 - curveIndex * (0.004 + index * 0.00003)),
            published: `2025${String((index % 12) + 1).padStart(2, '0')}${String((index % 27) + 1).padStart(2, '0')}`,
        }));
        const hafuVideos = videos.map((video, index) => ({
            ...video,
            id: `hafu${String(index + 1).padStart(7, '0')}`,
            title: `Hafu validation Short ${index + 1}`,
            sourceUrl: `https://youtube.com/shorts/hafu${String(index + 1).padStart(7, '0')}`,
            visual_keep_forecast: {
                ...video.visual_keep_forecast,
                est: 64.5 + index * .2,
                raw: 64.5 + index * .2,
                account_model: null,
            },
        }));
        hafuVideos.forEach(video => {
            bindSavedChannelFixtureRow(video);
        });
        const hafuPrivateVideos = privateVideos.map((video, index) => ({
            ...video,
            id: hafuVideos[index].id,
            title: hafuVideos[index].title,
        }));
        const keepPoints = videos.map((video, index) => ({ id: video.id, actual: 57 + index, predicted: 58 + index * .9 }));
        const viewsPoints = videos.map(video => ({ id: video.id, channel: channelId, channelName: 'Mobile Risk Channel', actualViews: video.views, predictedViews: Math.round(video.views * 1.12) }));
        const visualKeepPoints = [
            ...videos.map((video, index) => ({
                id: video.id,
                title: video.title,
                account: 'tyler',
                accountName: 'Tyler Csatari',
                actual: 57 + index,
                predicted: 58 + index * .82,
                baseline: 66,
                error: 1 - index * .18,
                fold: String(index % 5 + 1),
            })),
            ...hafuVideos.map((video, index) => ({
                id: video.id,
                title: video.title,
                account: 'hafu',
                accountName: 'Hafu Go',
                actual: 57 + index,
                predicted: 63 + index * .18,
                baseline: 66,
                error: 6 - index * .82,
                fold: String(index % 5 + 1),
            })),
        ];
        const visualAccountMetrics = [
            { account: 'tyler', name: 'Tyler Csatari', n: 20, r2: .42, spearman: .64, mae: 4.8, actualRange: 19, predictedRange: 15.6, rangeRatio: .82, protocolBaselineR2: .31, baselineMae: 6.9 },
            { account: 'hafu', name: 'Hafu Go', n: 20, r2: .01, spearman: .08, mae: 7.7, actualRange: 19, predictedRange: 3.4, rangeRatio: .18, protocolBaselineR2: -.08, baselineMae: 7.1 },
        ];
        const creatorAdaptivePoints = [
            ...videos.map((video, index) => ({
                id: video.id,
                title: video.title,
                account: 'tyler',
                accountName: 'Tyler Csatari',
                actual: 57 + index,
                predicted: video.creator_adaptive_keep_forecast.raw,
                baseline: video.creator_adaptive_keep_forecast.history_only_baseline,
                error: video.creator_adaptive_keep_forecast.raw - (57 + index),
                absoluteError: Math.abs(video.creator_adaptive_keep_forecast.raw - (57 + index)),
                componentA: video.creator_adaptive_keep_forecast.component_a,
                componentB: video.creator_adaptive_keep_forecast.component_b,
                historyN: video.creator_adaptive_keep_forecast.history_n,
                historyVideoIds: video.creator_adaptive_keep_forecast.history_video_ids,
                historyStart: video.creator_adaptive_keep_forecast.history_start,
                historyEnd: video.creator_adaptive_keep_forecast.history_end,
                publishedAt: Date.UTC(2025, 6, 1) + index,
                phase: 'evaluation',
            })),
            ...hafuVideos.map((video, index) => ({
                id: video.id,
                title: video.title,
                account: 'hafu',
                accountName: 'Hafu Go',
                actual: 57 + index,
                predicted: 63 + index * .35,
                baseline: 66,
                error: 6 - index * .65,
                absoluteError: Math.abs(6 - index * .65),
                componentA: 62.5 + index * .35,
                componentB: 63.5 + index * .35,
                historyN: 8,
                historyVideoIds: creatorHistoryIds('hafu', index),
                historyStart: Date.UTC(2024, 0, 1),
                historyEnd: Date.UTC(2025, 0, 1),
                publishedAt: Date.UTC(2025, 6, 1) + index,
                phase: 'evaluation',
            })),
        ];
        const creatorAdaptiveAccountMetrics = [
            { account: 'tyler', name: 'Tyler Csatari', n: 20, r2: .48, spearman: .71, mae: 4.8, baselineMae: 6.5, maeImprovementVsBaseline: 1.7, protocolBaselineR2: .22, medianAbsoluteError: 4.2, p90AbsoluteError: 9.1, within10PercentagePoints: 90, actualRange: 19, predictedRange: 17.1, rangeRatio: .9, maeBootstrap90: { lower: 3.8, upper: 5.9 } },
            { account: 'hafu', name: 'Hafu Go', n: 20, r2: .2, spearman: .44, mae: 7.7, baselineMae: 8.4, maeImprovementVsBaseline: .7, protocolBaselineR2: .08, medianAbsoluteError: 6.8, p90AbsoluteError: 13.1, within10PercentagePoints: 80, actualRange: 19, predictedRange: 6.65, rangeRatio: .35, maeBootstrap90: { lower: 6.4, upper: 10.8 } },
        ];
        const creatorAdaptiveProfiles = Object.fromEntries(['tyler', 'hafu'].map(account => {
            const historyVideoIds = creatorHistoryIds(account, 'profile');
            return [account, {
                historyN: historyVideoIds.length,
                historyVideoIds,
                historyThrough: Date.UTC(2025, 0, 1),
                historyWindow: 30,
                liveScoringStatus: 'research_shadow_only_not_served_for_anonymous_uploads',
            }];
        }));
        const visualProtocol = (key, label, baselineSkill) => ({
            key,
            label,
            description: `${label} fixture description with a frozen test protocol.`,
            metrics: { n: 40, r2: .24, spearman: .41, mae: 6.2, baselineMae: 7.0, actualRange: 19, predictedRange: 15.6, rangeRatio: .82, protocolBaselineR2: baselineSkill, perAccount: visualAccountMetrics },
            points: visualKeepPoints,
            candidateRegistry: { count: 45, selectionMetric: 'inner-fold RMSE' },
        });
        let validationArtifact;
        try {
            validationArtifact = validationBuilder.buildValidation({
            channels: [
                {
                    channelId,
                    accountId: 'tyler',
                    accountName: 'Tyler Csatari',
                    manifest: { videos },
                    privateTable: { videos: privateVideos },
                },
                {
                    channelId: 'ch87ccaa3dd3383515',
                    accountId: 'hafu',
                    accountName: 'Hafu Go',
                    manifest: { videos: hafuVideos },
                    privateTable: { videos: hafuPrivateVideos },
                },
            ],
            predictor: {
                generatedAt: Date.now(),
                provenance: {
                    privateAxisTrainingIdOverlap: 0,
                    savedAxisTrainingIdOverlap: 0,
                    validationCreatorAxisTrainingIdOverlap: 0,
                    validationCreatorVideoCountExcluded: videos.length,
                    validationCreatorChannelIds: ['UCfixtureTyler'],
                    featureScorerVersionPersistedPerVideo: false,
                    featureContractVersion: featureContract.version,
                    featureContractSha256,
                    artifactSha256: fixtureSha256('predictor-artifact'),
                    artifactArchiveKey: `raw/predictor-lab/by-sha256/${fixtureSha256('predictor-artifact')}.json`,
                    artifactManifestKey: 'raw/predictor-lab/results.manifest.json',
                    artifactManifestSha256: fixtureSha256('predictor-manifest'),
                    artifactGeneratedAt: 123456,
                    producerSourceSha256: fixtureSha256('predictor-source'),
                    sourceArtifacts: {
                        'fixture:source': { sha256: fixtureSha256('predictor-source-artifact'), bytes: 123 },
                    },
                    runtimeManifests,
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
                            views: population(`${modality}-views`, 900 - modalityIndex * 100),
                            outlier: population(`${modality}-outlier`, 800 - modalityIndex * 100),
                            gt10M: population(`${modality}-gt10M`, 900 - modalityIndex * 100),
                        },
                    ])),
                },
                targets: {
                    keep: {
                        points: keepPoints,
                        visualOnlyStudy: {
                            schemaVersion: 2,
                            label: 'Visual-only keep-rate predictor',
                            coordinateId: 'shorts.visual-keep-forecast.v1',
                            input: 'Only the canonical visual opening montage embedding enters the predictor.',
                            population: {
                                n: 40,
                                accounts: [
                                    { id: 'tyler', name: 'Tyler Csatari', n: 20 },
                                    { id: 'hafu', name: 'Hafu Go', n: 20 },
                                ],
                                embeddingModel: 'gemini-embedding-2',
                                embeddingDimensions: 1536,
                            },
                            protocols: {
                                videoHoldout: visualProtocol('known_account_video_holdout', 'Known creator · balanced video holdout', .22),
                                forwardTime: visualProtocol('forward_time', 'Future upload simulation', -.04),
                                accountHoldout: visualProtocol('unseen_account', 'Entire creator held out', -.31),
                            },
                            formula: {
                                scope: 'pooled_global',
                                input: 'L2-normalized 1,536D visual embedding of the canonical five-frame opening montage',
                                selected: {
                                    pooledAlpha: 1,
                                    accountWeight: 0,
                                },
                                pooled: { intercept: 66, coefficients: Array.from({ length: 1536 }, () => 0) },
                                accounts: {},
                                outputTransform:
                                    'clip(linear_prediction, 0, 100)',
                                outputBounds: [0, 100],
                            },
                            production: {
                                coordinateId: 'shorts.visual-keep-forecast.v1',
                                fitPopulation: {
                                    n: 40,
                                    videoIdSha256: fixtureSha256('visual-keep-fit-population'),
                                    byAccount: {
                                        tyler: population('visual-keep-fit-tyler', 20),
                                        hafu: population('visual-keep-fit-hafu', 20),
                                    },
                                },
                                points: [...videos, ...hafuVideos].map(video => ({
                                    id: video.id,
                                    account: null,
                                    predicted: video.visual_keep_forecast.raw,
                                    calibrationScope: video.visual_keep_forecast.calibration_scope,
                                })),
                            },
                            modelArtifact: {
                                artifactSha256: fixtureSha256('visual-keep-model'),
                                canonicalKey: 'raw/predictor-lab/visual-keep-model-v1.json',
                                archiveKey: `raw/predictor-lab/visual-keep-model/by-sha256/${fixtureSha256('visual-keep-model')}.json`,
                                producerSourceSha256: fixtureSha256('visual-keep-producer'),
                                generatedAt: 123456,
                            },
                            promotion: {
                                promoted: false,
                                status: 'research_only_not_validated_for_pre_upload_decisions',
                                plainEnglish: 'Retrospective structure exists, but future and unseen-creator transfer do not clear the honest baselines.',
                                rule: 'Both strict protocols must beat their legitimate null.',
                            },
                        },
                        creatorAdaptiveStudy: {
                            schemaVersion: 3,
                            coordinateId: 'shorts.creator-adaptive-keep.v1',
                            label: 'Known-creator causal keep-rate mixture',
                            input: 'The canonical visual opening embedding, canonical together visual-plus-text opening embedding, and up to 30 strictly earlier creator keep outcomes.',
                            valueDefinition: 'A raw predicted stayed-to-watch percentage for a known creator next upload; this is a multimodal derived forecast.',
                            population: {
                                n: 40,
                                accounts: [
                                    { id: 'tyler', name: 'Tyler Csatari', n: 20 },
                                    { id: 'hafu', name: 'Hafu Go', n: 20 },
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
                                protocol: 'A staged registry is selected only on the chronological 50%-80% window; equal timestamps are one batch.',
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
                                protocol: 'Causal final-20% replay predicts each equal-time batch before revealing any outcome in that batch.',
                                claimBoundary: 'Retrospective known-creator next-upload evidence; cold-start and anonymous scoring are unsupported.',
                                metrics: {
                                    n: 40,
                                    mae: 6.25,
                                    baselineMae: 7.45,
                                    maeImprovementVsBaseline: 1.2,
                                    protocolBaselineR2: .14,
                                    medianAbsoluteError: 5.2,
                                    p90AbsoluteError: 11.2,
                                    within10PercentagePoints: 85,
                                    actualRange: 19,
                                    predictedRange: 17.1,
                                    rangeRatio: .9,
                                    perAccount: creatorAdaptiveAccountMetrics,
                                },
                                points: creatorAdaptivePoints,
                                target: {
                                    metric: 'per-account mean absolute error',
                                    thresholdPercentagePoints: 10,
                                    pointEstimatePassCount: 2,
                                    accountCount: 2,
                                    allAccountsPassPointEstimate: true,
                                    bootstrap90UpperPassCount: 1,
                                    allAccountsPassBootstrap90Upper: false,
                                    baseline: 'Mean keep rate of at most 30 strictly earlier same-creator uploads.',
                                    baselineBeatingAccountCount: 2,
                                    allAccountsBeatHonestBaseline: true,
                                    beatsHonestBaselineOverall: true,
                                    maeImprovementVsBaseline: 1.2,
                                    squaredErrorSkillVsBaseline: .14,
                                },
                            },
                            batchFreezeStress: {
                                protocol: 'Freeze before the final tail and predict the entire tail without consuming intervening labels.',
                                claimBoundary: 'A stricter frozen-backlog stress reported separately from the prequential next-upload replay.',
                                metrics: {
                                    perAccount: [
                                        { account: 'tyler', name: 'Tyler Csatari', n: 20, mae: 7.5, baselineMae: 8.1 },
                                        { account: 'hafu', name: 'Hafu Go', n: 20, mae: 8.4, baselineMae: 9.1 },
                                    ],
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
                            status: {
                                state: 'research_only_retrospective_target_met',
                                plainEnglish: 'The retrospective target is met, but prospective confirmation is still required.',
                                absoluteTargetMet: true,
                                confidenceTargetMet: false,
                                beatsHonestBaselineOverall: true,
                                beatsHonestBaselineEveryAccount: true,
                                promoted: false,
                                predictorEligible: false,
                                promotionBlocker: 'Prospective uploads have not confirmed the locked artifact.',
                                confidenceWarning: 'Point MAE and individual ±10 coverage are different claims.',
                                coldStart: 'unsupported',
                                anonymousUpload: 'unsupported',
                                batchBacklog: 'supported only as the separately reported frozen stress',
                            },
                            modelArtifact: {
                                artifactSha256: fixtureSha256('creator-adaptive-keep-model'),
                                canonicalKey: 'raw/predictor-lab/creator-adaptive-keep-model-v1.json',
                                archiveKey: `raw/predictor-lab/creator-adaptive-keep-model/by-sha256/${fixtureSha256('creator-adaptive-keep-model')}.json`,
                                manifestKey: 'raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json',
                                manifestSha256: fixtureSha256('creator-adaptive-keep-release-manifest'),
                                producerSourceSha256: fixtureSha256('creator-adaptive-keep-producer'),
                                generatedAt: 123456,
                            },
                        },
                        blindInputs: {
                            featureNames: blindFeatureNames,
                            videoHeldOutProtocol: 'The evaluated video is excluded.',
                            accountHeldOutProtocol: 'The evaluated account is excluded.',
                            rows: [...videos, ...hafuVideos].map((video, index) => ({
                                id: video.id,
                                account: index < videos.length ? 'tyler' : 'hafu',
                                videoHeldOut: blindVector(index % videos.length),
                                accountHeldOut: blindVector(index % videos.length).map((value, featureIndex) => (
                                    /\.(?:views|outlier|gt10M)\.(?:raw|percentile)$/.test(blindFeatureNames[featureIndex])
                                        ? value
                                        : (featureIndex % 2 ? value : value - .5)
                                )),
                            })),
                        },
                        stressTests: [
                            { label: 'Unseen-account transfer', points: keepPoints.map(point => ({ ...point, predicted: point.predicted - 1 })) },
                            { label: 'Forward-time keep-rate transfer', points: keepPoints.slice(5) },
                        ],
                    },
                    views: {
                        points: viewsPoints,
                        stressTests: [
                            { label: 'Unseen-channel transfer', points: viewsPoints.map(point => ({ ...point, predictedViews: Math.round(point.actualViews * .9) })) },
                            { label: 'Forward-time public-views transfer', points: viewsPoints.slice(5) },
                        ],
                    },
                },
            },
                sourceFingerprint: fixtureSha256('ui-fixture'),
            });
        } catch (error) {
            if (error && error.lineageAudit) {
                console.error(JSON.stringify(error.lineageAudit, null, 2));
            }
            throw error;
        }
        assert.strictEqual(featureContract.version, 10);
        assert.strictEqual(validationArtifact.version, validationBuilder.VERSION);
        const persistedVisualFixtureRow =
            validationArtifact.validationRows.find(
                row => row.id === videos[1].id
                    && row.channelId === channelId
            );
        assert.strictEqual(
            persistedVisualFixtureRow
                && persistedVisualFixtureRow.predictions
                && persistedVisualFixtureRow.predictions
                    .visualKeepForecast,
            videos[1].visual_keep_forecast.raw,
            'the strict validation artifact must retain the exact bound '
                + 'score-time visual forecast: '
                + JSON.stringify(
                    persistedVisualFixtureRow
                    && persistedVisualFixtureRow.studyMetadata
                    && persistedVisualFixtureRow.studyMetadata.visualKeep
                )
        );
        assert.strictEqual(
            validationArtifact.coordinateRegistry.version,
            coordinateGovernance.ledgerVersion
        );
        const coordinateRegistry =
            validationArtifact.coordinateRegistry;
        const shortsCoordinateCount =
            coordinateRegistry.columns.length;
        const observedOutcomeCount =
            validationArtifact.outcomeDefinitions.length;
        const directAxisColumnCount =
            coordinateRegistry.totals.shortsDirectAxisColumns;
        const distinctDirectAxisCount =
            coordinateRegistry.totals
                .shortsDistinctDirectEmbeddingAxes;
        const compatibilityAliasCount =
            coordinateRegistry.aliases.length;
        const heldoutClassification =
            coordinateRegistry.classification.blind;
        const diagnosticClassification =
            coordinateRegistry.classification.diagnostics;
        const outcomeClassification =
            coordinateRegistry.classification.outcomes;
        const scoreCoordinateCount =
            shortsCoordinateCount - outcomeClassification.columns;
        const ledgerClassificationText = (
            `${heldoutClassification.columns} leakage-controlled held-out columns`
            + ` · ${heldoutClassification.uniquePredictions}`
            + ' unique held-out predictions'
            + ` · ${heldoutClassification.aliasColumns} active aliases`
            + ` · ${compatibilityAliasCount}`
            + ' compatibility aliases outside the ledger'
            + ` · ${diagnosticClassification.columns} diagnostics`
            + ` · ${outcomeClassification.columns} actual outcomes`
        );
        assert.strictEqual(validationArtifact.creatorAdaptiveStudy.schemaVersion, 3);
        assert.strictEqual(
            validationArtifact.creatorAdaptiveStudy.selection.candidateCount,
            CREATOR_ADAPTIVE_CANDIDATE_COUNT
        );
        assert.strictEqual(
            validationArtifact.creatorAdaptiveStudy.selection.candidateRegistrySha256,
            CREATOR_ADAPTIVE_CANDIDATE_SHA256
        );
        assert.strictEqual(
            validationArtifact.creatorAdaptiveStudy.selection.selected.benchmarkId,
            CREATOR_ADAPTIVE_BENCHMARK_ID
        );
        assert.strictEqual(
            validationArtifact.creatorAdaptiveStudy.formula.outputTransform,
            CREATOR_ADAPTIVE_OUTPUT_TRANSFORM
        );
        assert(validationArtifact.creatorAdaptiveStudy.evaluation.points.every(point => (
            Number.isFinite(point.componentA)
            && Number.isFinite(point.componentB)
            && Math.abs(
                point.predicted - 0.5 * (point.componentA + point.componentB)
            ) <= 1e-9
            && point.historyN >= 8
            && point.historyN <= 30
            && point.historyVideoIds.length === point.historyN
        )));
        assert.strictEqual(validationArtifact.creatorAdaptiveStudy.status.promoted, false);
        assert.strictEqual(validationArtifact.creatorAdaptiveStudy.status.predictorEligible, false);
        const creatorForecastColumnIndex =
            validationArtifact.coordinateRegistry.columns.findIndex(
                column => (
                    column.family
                        === 'creatorAdaptiveKeepPrequential'
                )
            );
        const fixtureCreatorRow = validationArtifact.validationRows.find(
            row => row.id === videos[1].id
        );
        assert(
            creatorForecastColumnIndex >= 0
                && fixtureCreatorRow
                && Number.isFinite(
                    fixtureCreatorRow.scoreLedger.values[
                        creatorForecastColumnIndex
                    ]
                ),
            'creator-adaptive fixture must materialize one governed row-ledger '
                + 'coordinate'
        );
        assert.strictEqual(
            fixtureCreatorRow.scoreLedger.values[
                creatorForecastColumnIndex
            ],
            videos[1].creator_adaptive_keep_forecast.raw,
            'creator-adaptive persisted record and governed row ledger must '
                + 'contain the same scalar'
        );
        assert.strictEqual(
            fixtureCreatorRow.channelId,
            channelId,
            'governed validation row must retain its saved-channel identity'
        );
        assert.strictEqual(
            fixtureCreatorRow.scoreLedger.values.length,
            validationArtifact.coordinateRegistry.columns.length,
            'governed row values must cover the complete coordinate registry'
        );
        assert.strictEqual(
            fixtureCreatorRow.scoreLedger.percentiles.length,
            validationArtifact.coordinateRegistry.columns.length,
            'governed row percentiles must cover the complete coordinate registry'
        );
        validationArtifact.rows.forEach(row => {
            if (row.predictions && row.predictions.score21) {
                if (row.predictions.score21.video) row.predictions.score21.video.hit10M = 0.73;
                if (row.predictions.score21.account) row.predictions.score21.account.hit10M = 0.41;
            }
            const videoHitIndex = validationArtifact.coordinateRegistry.columns.findIndex(column => column.id === 'shorts.video-forecast.hit10M');
            const accountHitIndex = validationArtifact.coordinateRegistry.columns.findIndex(column => column.id === 'shorts.account-forecast.hit10M');
            if (row.scoreLedger && videoHitIndex >= 0) row.scoreLedger.values[videoHitIndex] = 0.73;
            if (row.scoreLedger && accountHitIndex >= 0) row.scoreLedger.values[accountHitIndex] = 0.41;
        });
        validationArtifact.artifact = { cacheStatus: 'hit', persisted: true, generatedAt: validationArtifact.generatedAt };
        const rawVisualMap = {
            n: videos.length,
            id: videos.map(video => video.id),
            title: videos.map(video => video.title),
            txt: videos.map(video => `Stored transcript for ${video.title}`),
            views: videos.map(video => video.views),
            outlier: videos.map(video => video.views / 1000000),
            subs: videos.map(() => 1000000),
            silent: videos.map(() => false),
            owner: videos.map(() => 'tyler'),
            mine: videos.map(() => true),
            clusters: { 10: videos.map((video, index) => index % 4) },
            proj: {
                keep: {
                    x: videos.map((video, index) => 80 + index * 42),
                    y: videos.map((video, index) => 120 + (index % 7) * 105),
                    est: videos.map(video => video.features['visual.keep'][0]),
                    actual: videos.map((video, index) => 57 + index),
                    cv: .63,
                    co: 0,
                },
            },
        };
        const ownerAccountId =
            '11111111-1111-4111-8111-111111111111';
        const teamAccountId =
            '22222222-2222-4222-8222-222222222222';
        const teamStoryboardId = 'sbcreatorlab01';
        const teamScoreJobId = 'jteamactivityscore1';
        const accountSummaries = [
            {
                account: {
                    id: ownerAccountId,
                    email: 'owner@example.com',
                    name: 'Owner',
                    role: 'owner',
                },
                counts: {
                    hooks: 1,
                    channels: 1,
                    storyboards: 0,
                },
                folderCounts: {
                    hooks: 0,
                    channels: 0,
                    storyboards: 0,
                },
                activityCount: 0,
                generationCount: 0,
            },
            {
                account: {
                    id: teamAccountId,
                    email: 'creator@example.com',
                    name: 'Creator Account',
                    role: 'member',
                },
                counts: {
                    hooks: 1,
                    channels: 1,
                    storyboards: 1,
                },
                folderCounts: {
                    hooks: 1,
                    channels: 1,
                    storyboards: 1,
                },
                activityCount: 3,
                generationCount: 1,
            },
        ];
        const grindFixtureRid = 'grindreadoutfixture';
        const grindCoordinateId = 'shorts.stored.together.keep';
        const grindScoreFixture = JSON.parse(
            JSON.stringify(historicalUpgradeScore)
        );
        const grindCoordinateEntry = grindScoreFixture.score_ledger.entries
            .find(entry => (
                entry.coordinate_id === grindCoordinateId
                && entry.available === true
            ));
        assert(
            grindCoordinateEntry
                && Number.isFinite(grindCoordinateEntry.value)
                && Number.isFinite(grindCoordinateEntry.percentile),
            'Grind browser fixture requires one exact available ledger coordinate'
        );
        const grindAttemptFixture = {
            k: 0,
            premise: 'A second hook treatment for the exact same machine idea',
            status: 'scored',
            score_verified: true,
            score_projection_schema:
                'shorts-grind-score-projection-v1',
            score_projection_precision: 'source-exact',
            score_coordinate_id: grindCoordinateId,
            score_ledger_sha256:
                grindScoreFixture.score_ledger.ledger_sha256,
            score_record_sha256:
                grindScoreFixture.score_record_sha256,
            score_value: grindCoordinateEntry.value,
            score_percentile_0_100:
                grindCoordinateEntry.percentile,
            score_available: true,
            score_coordinate_count:
                grindScoreFixture.score_ledger.entries.length,
            score_coordinate_available_count:
                grindScoreFixture.score_ledger.entries.filter(
                    entry => entry.available === true
                ).length,
            score_derived_output_count: 4,
            frames: [
                'Establish the machine',
                'Show the impossible spill test',
                'Escalate the test',
                'Withhold the mechanism',
                'Reveal the result',
            ],
            image_provider_call_count: 1,
            topical_similarity: 0.88,
            topical_similarity_floor: 0.70,
            seed_distance: 0.19,
            seed_angle_degrees: 35.9,
            nearest_prior_distance: 0.16,
            direction_signature: '7a3',
            nearest_prior_directional_angle_degrees: 74.2,
            directional_frontier_score: 0.81,
        };
        const grindRunFixture = {
            rid: grindFixtureRid,
            premise: 'This machine makes it impossible to spill',
            status: 'maxed',
            threshold_coordinate_id: grindCoordinateId,
            threshold_unit: 'percentile_0_100',
            threshold_value_0_100: 95,
            threshold_percentile_0_100: 95,
            attempt_count: 1,
            attempts: [grindAttemptFixture],
            exploration_strategy:
                'same-idea-hook-directional-frontier-v3',
            target_seed_embedding_distance: 0.19,
            target_prior_embedding_distance: 0.16,
            duplicate_embedding_distance_floor: 0.02,
            directional_exploration_pressure: 0.58,
            topical_similarity_floor: 0.70,
            rejected_variant_count: 2,
            render_mode: 'single-panel',
            run_validation: { valid: true },
            note: 'One same-idea hook is ready.',
        };
        const replies = {
            '/buildings/jarvis/saved-channel-feature-contract.json':
                featureContract,
            '/api/experimentlab/context': {
                schema: 'experiment-lab-workspace-v1',
                viewer: {
                    id: ownerAccountId,
                    email: 'owner@example.com',
                    name: 'Owner',
                    role: 'owner',
                },
                activeAccount: {
                    id: ownerAccountId,
                    email: 'owner@example.com',
                    name: 'Owner',
                    role: 'owner',
                },
                readOnly: false,
                owner: true,
                teamAccess: true,
                summary: {
                    counts: {
                        hooks: 1,
                        channels: 1,
                        storyboards: 0,
                    },
                    folderCounts: {
                        hooks: 0,
                        channels: 0,
                        storyboards: 0,
                    },
                    activityCount: 0,
                    generationCount: 0,
                },
                workspace: {
                    schema: 'experiment-lab-workspace-v1',
                    collections: {
                        hooks: { folders: [], items: [] },
                        channels: { folders: [], items: [] },
                        storyboards: { folders: [], items: [] },
                    },
                    activity: [],
                },
                accounts: accountSummaries,
            },
            '/api/retention/channels': { channels: [], active: 'tyler' },
            '/api/indicators/registry': { indicators: [], meta: { targets: [] } },
            '/api/raw/saved-hooks': {
                hooks: [
                    historicalSavedHookRow,
                    queuedSavedHookRow,
                    failedSavedHookRow,
                    channelFreeLow.row,
                    channelFreeHigh.row,
                ],
                folders: [],
            },
            [`/api/raw/saved-hook/${historicalSavedHookId}`]: {
                ...historicalSavedHookRecord,
                score_record_validation: {
                    state: 'unverified-legacy',
                    valid: null,
                    recorded_sha256: null,
                    calculated_sha256: null,
                },
            },
            [`/api/raw/saved-hook/${queuedSavedHookId}`]: {
                ...queuedSavedHookRecord,
                score_record_validation: {
                    state: 'unverified-legacy',
                    valid: null,
                    recorded_sha256: null,
                    calculated_sha256: null,
                },
            },
            [`/api/raw/saved-hook/${channelFreeLowId}`]: {
                ...channelFreeLow.record,
                score_record_validation: {
                    state: 'verified',
                    valid: true,
                    recorded_sha256:
                        channelFreeLow.record.score_record_sha256,
                    calculated_sha256:
                        channelFreeLow.record.score_record_sha256,
                },
            },
            [`/api/raw/saved-hook/${channelFreeHighId}`]: {
                ...channelFreeHigh.record,
                score_record_validation: {
                    state: 'verified',
                    valid: true,
                    recorded_sha256:
                        channelFreeHigh.record.score_record_sha256,
                    calculated_sha256:
                        channelFreeHigh.record.score_record_sha256,
                },
            },
            '/api/raw/saved-channels': { channels: [{ id: channelId, name: 'Mobile Risk Channel', url: 'https://youtube.com/@risk', status: 'partial', discovered: 21, completed: 20, failed: 1 }], featureContract },
            [`/api/raw/saved-channel/${channelId}`]: { id: channelId, name: 'Mobile Risk Channel', url: 'https://youtube.com/@risk', status: 'partial', discovered: 21, completed: 20, failed: 1, queued: 0, videos: videos.concat(unfinishedVideo), featureContract },
            [`/api/raw/saved-channel/${channelId}/analysis`]: riskAnalysis,
            '/api/raw/saved-channel-validation': validationArtifact,
            '/api/raw/scorer-contract': {
                schema: 'shorts-live-score-contract-v3',
                revision_fingerprint:
                    fixtureSha256('current-live-revision'),
                feature_contract_sha256:
                    FEATURE_CONTRACT_SHA256,
                feature_contract_document_sha256:
                    FEATURE_CONTRACT_DOCUMENT_SHA256,
                coordinates: {
                    channel_free_keep:
                        channelFreeKeepContract.COORDINATE_IDS,
                },
                channel_free_model_artifact_sha256:
                    channelFreeKeepContract.MODEL_SHA256,
                channel_free_model_run_id:
                    channelFreeKeepContract.MODEL.runId,
                channel_free_selected_signal:
                    channelFreeKeepContract.MODEL.selectedSignal,
                creator_profiles: [],
            },
            '/api/experimentlab/activity': {
                schema: 'experiment-lab-activity-page-v1',
                activities: [],
                total: 0,
                offset: 0,
                limit: 100,
                account: {
                    id: ownerAccountId,
                    email: 'owner@example.com',
                    name: 'Owner',
                    role: 'owner',
                },
                readOnly: false,
            },
            '/api/raw/map': rawVisualMap,
            [`/api/raw/saved-channel/${channelId}/resume`]: { ok: true },
            '/api/hooks/grind/runs': {
                runs: [{
                    rid: grindFixtureRid,
                    premise: grindRunFixture.premise,
                    status: 'running',
                }],
            },
            [`/api/hooks/grind/run/${grindFixtureRid}`]:
                {
                    ...grindRunFixture,
                    status: 'running',
                    note: 'fixture run active',
                },
            [`/api/hooks/grind/score/${grindFixtureRid}_0`]:
                grindScoreFixture,
            '/api/hooks/warmup': { ok: true, fired: false },
        };
        const teamReplies = {
            '/api/experimentlab/context': {
                schema: 'experiment-lab-workspace-v1',
                viewer: {
                    id: ownerAccountId,
                    email: 'owner@example.com',
                    name: 'Owner',
                    role: 'owner',
                },
                activeAccount: {
                    id: teamAccountId,
                    email: 'creator@example.com',
                    name: 'Creator Account',
                    role: 'member',
                },
                readOnly: true,
                owner: true,
                teamAccess: true,
                summary: accountSummaries[1],
                workspace: {
                    schema: 'experiment-lab-workspace-v1',
                    collections: {
                        hooks: {
                            folders: [{
                                id: 'elfteamhooks',
                                name: 'Creator Review',
                            }],
                            items: [{
                                id: historicalSavedHookId,
                                folderId: 'elfteamhooks',
                            }],
                        },
                        channels: {
                            folders: [{
                                id: 'elfteamchannels',
                                name: 'Reference Channels',
                            }],
                            items: [{
                                id: channelId,
                                folderId: 'elfteamchannels',
                            }],
                        },
                        storyboards: {
                            folders: [{
                                id: 'elfteamstoryboards',
                                name: 'Opening Boards',
                            }],
                            items: [{
                                id: teamStoryboardId,
                                folderId: 'elfteamstoryboards',
                            }],
                        },
                    },
                    activity: [
                        {
                            id: 'elateamscore1',
                            type: 'hook-scored-from-link',
                            status: 'complete',
                            title: 'Unsaved creator score',
                            detail: 'Canonical opening score completed',
                            requestId: teamScoreJobId,
                            saved: false,
                            input: {
                                kind: 'youtube-link',
                                url: 'https://youtube.com/shorts/team-score',
                                creatorProfile: 'hafu',
                            },
                            inputEvidence: {
                                durationSeconds: 7.4,
                                transcriptPresent: true,
                                scoreInputFingerprint:
                                    fixtureSha256('team-score-input'),
                            },
                            output: {
                                kind: 'canonical-shorts-score',
                                coordinateCount: 21,
                                availableCoordinateCount: 21,
                                ledgerSha256:
                                    historicalUpgradeScore.score_ledger
                                        .ledger_sha256,
                                channelFreeKeepForecasts:
                                    Object.fromEntries(
                                        ['concat', 'visual', 'together', 'text']
                                            .map(signal => [signal, {
                                                coordinateId:
                                                    channelFreeKeepContract
                                                        .COORDINATE_IDS[signal],
                                                value:
                                                    historicalUpgradeScore
                                                        .channel_free_keep_forecasts
                                                        .outputs[signal].raw,
                                                valueUnit: 'percent',
                                            }])
                                    ),
                                predictorEligible: true,
                            },
                            history: [{
                                status: 'started',
                                detail: 'YouTube opening accepted',
                                at: Date.now() - 2500,
                            }, {
                                status: 'complete',
                                detail: 'Canonical ledger persisted',
                                at: Date.now() - 2000,
                            }],
                            updatedAt: Date.now() - 2000,
                        },
                        {
                            id: 'elateamgenerated1',
                            type: 'hook-generated',
                            status: 'complete',
                            title: 'Generated but not saved',
                            requestId: 'reqteamgenerated1',
                            input: {
                                kind: 'automatic-hook-brief',
                                premise: 'A machine that cannot spill',
                                requestedCount: 5,
                            },
                            output: {
                                kind: 'generated-hooks',
                                candidateCount: 5,
                            },
                            saved: false,
                            updatedAt: Date.now(),
                        },
                        {
                            id: 'elateamsaved1',
                            type: 'score-hook',
                            status: 'saved',
                            title: 'Saved creator hook',
                            saved: true,
                            updatedAt: Date.now() - 1000,
                        },
                    ],
                },
                accounts: accountSummaries,
            },
            '/api/raw/saved-hooks': {
                hooks: [{
                    ...historicalSavedHookRow,
                    folder: 'elfteamhooks',
                }],
                folders: [{
                    id: 'elfteamhooks',
                    name: 'Creator Review',
                }],
            },
            '/api/raw/saved-channels': {
                channels: [{
                    id: channelId,
                    name: 'Creator Reference Channel',
                    url: 'https://youtube.com/@creator',
                    status: 'done',
                    discovered: 20,
                    completed: 20,
                    failed: 0,
                    folder: 'elfteamchannels',
                }],
                folders: [{
                    id: 'elfteamchannels',
                    name: 'Reference Channels',
                }],
                featureContract,
            },
            '/api/storyboards': {
                schema: 'shorts-storyboard-index-v1',
                storyboards: [{
                    id: teamStoryboardId,
                    name: 'Creator Storyboard',
                    model: 'flux-2-pro',
                    complete: true,
                    scored: true,
                    folder: 'elfteamstoryboards',
                }],
                total: 1,
                folders: [{
                    id: 'elfteamstoryboards',
                    name: 'Opening Boards',
                }],
            },
            [`/api/shortsquant/jobs/${teamScoreJobId}`]: {
                jid: teamScoreJobId,
                kind: 'raw-embed-youtube',
                namespace: 'shorts',
                status: 'done',
                result: {
                    ...historicalUpgradeScore,
                    title: 'Unsaved creator score',
                    source: 'youtube',
                },
            },
            [`/api/storyboards/${teamStoryboardId}`]: {
                id: teamStoryboardId,
                name: 'Creator Storyboard',
                brief: 'Reveal a spill-proof machine in one continuous action.',
                hookText: 'This machine makes it impossible to spill.',
                model: 'flux-2-pro',
                generationMode: 'coherent-sheet',
                revision: 3,
                complete: true,
                scored: true,
                score: historicalUpgradeScore,
                savedHookId: historicalSavedHookId,
                panels: Array.from({ length: 5 }, (_, index) => ({
                    image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
                    prompt: `Stored creator frame ${index + 1} prompt`,
                    relation: index ? 'continues prior frame' : 'establishes subject',
                })),
            },
        };
        teamReplies['/api/experimentlab/activity'] = {
            schema: 'experiment-lab-activity-page-v1',
            activities:
                teamReplies['/api/experimentlab/context']
                    .workspace.activity.filter(row => (
                        row.type === 'hook-generated'
                    )),
            total: 1,
            offset: 0,
            limit: 100,
            kind: 'generation',
            account:
                teamReplies['/api/experimentlab/context']
                    .activeAccount,
            readOnly: true,
        };
        teamReplies[
            '/api/hooks/grpo/group/demo/reqteamgenerated1'
        ] = {
            input_id: 'reqteamgenerated1',
            premise: 'A machine that cannot spill',
            done: true,
            attempts: [{
                k: 0,
                status: 'done',
                premise:
                    'This machine makes spills impossible',
                frame_imgs: Array.from({ length: 5 }, () => (
                    'data:image/gif;base64,'
                    + 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
                )),
            }],
        };
        videos.forEach(video => {
            replies[`/api/raw/saved-channel/${channelId}/video/${video.id}`] = {
                ...video.__record,
                savedChannelId: channelId,
                savedChannelVideoId: video.id,
                evidence_state: video.evidence_state,
                canonical: video.canonical,
                predictor_eligible: video.predictor_eligible,
                evidence_warning: video.evidence_warning,
                score_ledger_validation:
                    video.score_ledger_validation,
                score_record_validation: {
                    state: 'verified',
                    valid: true,
                    recorded_sha256: video.score_record_sha256,
                    calculated_sha256: video.score_record_sha256,
                },
                manifest_row_validation:
                    validateManifestRowBinding(video),
                input_binding_validation: {
                    valid: true,
                    state: CANONICAL_EVIDENCE_STATE,
                    errors: [],
                },
                record_artifact_validation: {
                    valid: true,
                    recorded_sha256:
                        video.record_artifact_sha256,
                    actual_sha256:
                        video.record_artifact_sha256,
                    recorded_byte_length:
                        video.record_byte_length,
                    actual_byte_length:
                        video.record_byte_length,
                },
            };
        });
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><base href="${ORIGIN}/"><link rel="stylesheet" href="/buildings/experimentlab/experimentlab.css"><link rel="stylesheet" href="/buildings/jarvis/storyboard-workbench.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#080d14}</style></head><body><main id="root"></main>
<script>Object.defineProperty(globalThis,"__SHORTS_SCORE_LEDGER_RUNTIME__",{value:${JSON.stringify(shortsScoreLedgerRuntime)},writable:false,configurable:false});</script>
<script src="/buildings/building-registry.js"></script><script src="/buildings/jarvis/jarvis-upload-utils.js"></script>
<script>
const nativeFetch=window.fetch.bind(window);
const replies=${JSON.stringify(replies)};
window.__labReplies=replies;
const teamReplies=${JSON.stringify(teamReplies)};
const teamAccountId=${JSON.stringify(teamAccountId)};
const historicalSavedHookId=${JSON.stringify(historicalSavedHookId)};
const queuedSavedHookId=${JSON.stringify(queuedSavedHookId)};
const failedSavedHookId=${JSON.stringify(failedSavedHookId)};
const autoSavedHookId=${JSON.stringify(autoSavedHookId)};
const channelFreeHighId=${JSON.stringify(channelFreeHighId)};
const grindFixtureRid=${JSON.stringify(grindFixtureRid)};
const autoSavedHookRow=${JSON.stringify(autoSavedHookRow)};
const autoSavedHookRecord=${JSON.stringify(autoSavedHookRecord)};
const historicalUpgradeScore=${JSON.stringify(historicalUpgradeScore)};
window.__historicalTamperFixtures=${
    JSON.stringify(historicalTamperFixtures)
};
window.__fetchCounts={};
window.__labSurfaceRequests=[];
window.__labTargetRequests=[];
window.__labAutoSavedScore=null;
window.__autoSavedHookId=null;
window.__labFolderRequests=[];
window.__labStoryboardSaves=[];
window.__grindStopRequests=0;
window.fetch=function(url,options){
    const requestUrl=new URL(url,location.href);
    const p=requestUrl.pathname;
    window.__fetchCounts[p]=(window.__fetchCounts[p]||0)+1;
    const requestHeaders=new Headers(options&&options.headers||{});
    if(requestHeaders.get('X-Business-World-Surface')==='experiment-lab'){
        window.__labSurfaceRequests.push(p);
    }
    if(requestHeaders.get('X-Experiment-Lab-Account')){
        window.__labTargetRequests.push({
            path:p,
            search:requestUrl.search,
            account:requestHeaders.get(
                'X-Experiment-Lab-Account'
            )
        });
    }
    if(
        p==='/api/raw/saved-montage/'+historicalSavedHookId
        || p==='/api/raw/saved-montage/'+autoSavedHookId
        || p==='/api/raw/saved-montage/'+channelFreeHighId
    ){
        const b=Uint8Array.from(
            atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='),
            c=>c.charCodeAt(0)
        );
        return Promise.resolve(new Response(b,{
            status:200,
            headers:{'Content-Type':'image/gif'}
        }));
    }
    if(
        p==='/api/raw/embed-montage'
        && String(options&&options.method||'GET').toUpperCase()==='POST'
    ){
        return Promise.resolve(new Response(
            JSON.stringify(historicalUpgradeScore),
            {
                status:200,
                headers:{'Content-Type':'application/json'}
            }
        ));
    }
    if(
        p==='/api/raw/embed-youtube'
        && String(options&&options.method||'GET').toUpperCase()==='POST'
    ){
        return Promise.resolve(new Response(
            JSON.stringify({
                ...historicalUpgradeScore,
                title:'Automatically opened YouTube score',
                source:'youtube',
                montageDataUrl:
                    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
            }),
            {
                status:200,
                headers:{'Content-Type':'application/json'}
            }
        ));
    }
    if(
        p==='/api/raw/hook-save'
        && String(options&&options.method||'GET').toUpperCase()==='POST'
    ){
        const savedPayload=JSON.parse(options.body||'{}');
        const savedId=autoSavedHookId;
        window.__labAutoSavedScore=savedPayload;
        window.__autoSavedHookId=savedId;
        replies['/api/raw/saved-hooks'].hooks=[
            autoSavedHookRow,
            ...replies['/api/raw/saved-hooks'].hooks.filter(
                row=>row.id!==savedId
            )
        ];
        replies['/api/raw/saved-hook/'+savedId]={
            ...autoSavedHookRecord,
            evidence_state:'canonical_bound',
            canonical:true,
            predictor_eligible:true,
            score_display_eligible:true,
            score_record_validation:{
                state:'verified',
                valid:true,
                recorded_sha256:
                    autoSavedHookRecord.score_record_sha256,
                calculated_sha256:
                    autoSavedHookRecord.score_record_sha256
            },
            input_binding_validation:{
                state:'canonical-valid',
                valid:true,
                errors:[]
            },
            compact_source_validation:{
                state:'canonical-valid',
                valid:true,
                errors:[]
            }
        };
        const response=new Response(JSON.stringify({
            ok:true,
            id:savedId,
            hook:autoSavedHookRow,
            score_record_sha256:autoSavedHookRecord.score_record_sha256,
            score_ledger_sha256:
                autoSavedHookRecord.score_ledger.ledger_sha256
        }),{
            status:200,
            headers:{'Content-Type':'application/json'}
        });
        return new Promise(resolve=>setTimeout(
            ()=>resolve(response),
            savedPayload.source==='youtube' ? 1800 : 180
        ));
    }
    if(
        p==='/api/storyboards/save'
        && String(options&&options.method||'GET').toUpperCase()==='POST'
    ){
        const payload=JSON.parse(options.body||'{}');
        window.__labStoryboardSaves.push(payload);
        return new Promise(resolve=>setTimeout(()=>resolve(
            new Response(JSON.stringify({
                ok:true,
                id:payload.id||'sbautosave001',
                revision:(Number(payload.expectedRevision)||0)+1
            }),{
                status:200,
                headers:{'Content-Type':'application/json'}
            })
        ),120));
    }
    if(
        p==='/api/raw/folder-create'
        && String(options&&options.method||'GET').toUpperCase()==='POST'
    ){
        const payload=JSON.parse(options.body||'{}');
        const folder={id:'elf-owner-hooks-1',name:payload.name};
        replies['/api/raw/saved-hooks'].folders=[folder];
        window.__labFolderRequests.push({path:p,payload});
        return Promise.resolve(new Response(JSON.stringify({
            ok:true,
            id:folder.id,
            name:folder.name
        }),{
            status:200,
            headers:{'Content-Type':'application/json'}
        }));
    }
    if(
        p==='/api/raw/hook-move'
        && String(options&&options.method||'GET').toUpperCase()==='POST'
    ){
        const payload=JSON.parse(options.body||'{}');
        const hook=replies['/api/raw/saved-hooks'].hooks.find(
            row=>row.id===payload.id
        );
        if(hook) hook.folder=payload.folder||null;
        window.__labFolderRequests.push({path:p,payload});
        return Promise.resolve(new Response(JSON.stringify({ok:true}),{
            status:200,
            headers:{'Content-Type':'application/json'}
        }));
    }
    if(
        p==='/api/raw/hook-enrich'
        && String(options&&options.method||'GET').toUpperCase()==='POST'
    ){
        const submitted=JSON.parse(options.body||'{}');
        window.__historicalEnrichSubmission=submitted;
        replies['/api/raw/saved-hook/'+historicalSavedHookId]={
            ...historicalUpgradeScore,
            id:historicalSavedHookId,
            title:submitted.title||historicalUpgradeScore.title,
            text:submitted.text||historicalUpgradeScore.text,
            hasMontage:true,
            evidence_state:'canonical_bound',
            predictor_eligible:true,
            score_display_eligible:true
        };
        return Promise.resolve(new Response(JSON.stringify({
            ok:true,
            score_record_sha256:
                historicalUpgradeScore.score_record_sha256,
            score_ledger_sha256:
                historicalUpgradeScore.score_ledger.ledger_sha256
        }),{
            status:200,
            headers:{'Content-Type':'application/json'}
        }));
    }
    if(
        p==='/api/hooks/grind/stop/'+grindFixtureRid
        && String(options&&options.method||'GET').toUpperCase()==='POST'
    ){
        window.__grindStopRequests+=1;
        return new Promise(resolve=>setTimeout(()=>{
            replies['/api/hooks/grind/run/'+grindFixtureRid]={
                ...replies['/api/hooks/grind/run/'+grindFixtureRid],
                status:'stopped',
                note:'stopped by browser regression fixture'
            };
            resolve(new Response(JSON.stringify({
                ok:true,
                rid:grindFixtureRid,
                status:'stopping'
            }),{
                status:200,
                headers:{'Content-Type':'application/json'}
            }));
        },650));
    }
    if(
        requestHeaders.get('X-Experiment-Lab-Account')===teamAccountId
        && teamReplies[p]
    ){
        return Promise.resolve(new Response(
            JSON.stringify(teamReplies[p]),
            {
                status:200,
                headers:{'Content-Type':'application/json'}
            }
        ));
    }
    if(p==='/api/raw/saved-hook/'+failedSavedHookId){
        return new Promise(resolve=>setTimeout(()=>resolve(
            new Response(JSON.stringify({
                error:'fixture saved-hook detail failure'
            }),{
                status:500,
                headers:{'Content-Type':'application/json'}
            })
        ),250));
    }
    if(p.startsWith('/api/hooks/grind/montage/')){
        return Promise.resolve(new Response(JSON.stringify({
            error:'fixture montage is intentionally unavailable'
        }),{
            status:503,
            headers:{'Content-Type':'application/json'}
        }));
    }
    if(
        (p.includes('/api/raw/saved-channel/')&&p.includes('/montage/'))
        || p.startsWith('/api/raw/montage/')
        || p.startsWith('/api/hooks/grpo/montage/')
    ){
        const b=Uint8Array.from(
            atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='),
            c=>c.charCodeAt(0)
        );
        return Promise.resolve(new Response(b,{
            status:200,
            headers:{'Content-Type':'image/gif'}
        }));
    }
    if(replies[p]){
        const headers={'Content-Type':'application/json'};
        if(p==='/api/raw/map'){
            headers['X-Map-Release-SHA256']='${fixtureSha256('raw-map-release')}';
            headers['X-Map-Pointer-SHA256']='${fixtureSha256('raw-map-pointer')}';
            headers['X-Artifact-SHA256']='${fixtureSha256('raw-map-artifact')}';
            headers.ETag='"${fixtureSha256('raw-map-artifact')}"';
        }
        const response=()=>new Response(
            JSON.stringify(replies[p]),
            {status:200,headers}
        );
        if([
            '${`/api/raw/saved-hook/${historicalSavedHookId}`}',
            '${`/api/raw/saved-hook/${queuedSavedHookId}`}'
        ].includes(p)){
            return new Promise(resolve=>setTimeout(
                ()=>resolve(response()),
                800
            ));
        }
        return Promise.resolve(response());
    }
    if(p.includes('/principles/')||p==='/api/rtg/labels'){
        return Promise.resolve(new Response('{}',{
            status:200,
            headers:{'Content-Type':'application/json'}
        }));
    }
    if(p==='/api/storyboards'){
        return Promise.resolve(new Response(JSON.stringify({
            storyboards:[],
            total:0
        }),{
            status:200,
            headers:{'Content-Type':'application/json'}
        }));
    }
    return nativeFetch(url,options);
};
</script>
<script src="/buildings/jarvis/storyboard-style-presets.js"></script><script src="/buildings/jarvis/storyboard-workbench.js"></script><script src="/buildings/jarvis/jarvis-retention.js"></script><script src="/buildings/experimentlab/experimentlab-ui.js"></script><script>BuildingRegistry.get('Experiment Lab').open(document.getElementById('root'));</script></body></html>`, { waitUntil: 'networkidle' });

        await page.getByRole('heading', { name: 'Experiment Lab' }).waitFor();
        await page.getByText('Owner workspace', { exact: true }).waitFor();
        const experimentContract = await page.evaluate(() =>
            window.JarvisRetention.getExperimentSurfaceContract()
        );
        assert.deepStrictEqual(experimentContract, {
            rendererId: 'shorts-quant-experiment-surface-v1',
            canonicalRenderer: 'renderShortsExperimentSurface',
            canonicalInteractionHandlers: [
                'onClick',
                'onInput',
                'onChange',
                'onKeyDown',
            ],
            workspaceExtensions: [
                'account-scope',
                'folders',
                'surface-navigation',
                'private-saved-hooks',
                'owner-team-inspection',
            ],
        });
        assert.strictEqual(
            await page.locator(
                '[data-shorts-experiment-renderer="shorts-quant-experiment-surface-v1"]'
            ).count(),
            1,
            'Experiment Lab must expose the canonical Shorts Quant surface identity'
        );
        assert.strictEqual(
            await page.locator(
                '[data-shorts-experiment-renderer] [data-lab-workspace-banner]'
            ).count(),
            0,
            'workspace chrome must wrap the canonical surface instead of forking it'
        );
        assert(
            await page.evaluate(() => (
                window.__labSurfaceRequests.includes(
                    '/api/experimentlab/context'
                )
                && window.__labSurfaceRequests.includes(
                    '/api/indicators/registry'
                )
            )),
            'the standalone Lab must scope the canonical Experiment requests'
        );
        try {
            await page.getByPlaceholder('type a video idea — or leave blank and the model invents one…').waitFor();
        } catch (error) {
            console.error('INITIAL ROOT:', (await page.locator('#root').innerText()).slice(0, 1500));
            throw error;
        }
        const grindIdeaInput = page.getByPlaceholder(
            'type a video idea — or leave blank and the model invents one…'
        );
        await grindIdeaInput.fill(
            'Focus and selection must survive a background refresh.'
        );
        const focusSnapshot = await grindIdeaInput.evaluate(element => {
            element.setSelectionRange(10, 19);
            const workspace = element.closest('.experiment-lab-workspace');
            workspace.scrollTop = Math.min(
                50,
                Math.max(0, workspace.scrollHeight - workspace.clientHeight)
            );
            return {
                top: workspace.scrollTop,
                start: element.selectionStart,
                end: element.selectionEnd,
            };
        });
        await page.evaluate(() => {
            window.JarvisRetention.setExperimentLabLibraryView('hooks');
        });
        assert.deepStrictEqual(
            await page.evaluate(() => {
                const active = document.activeElement;
                const workspace = active
                    && active.closest('.experiment-lab-workspace');
                return {
                    placeholder: active
                        && active.getAttribute('placeholder'),
                    value: active && active.value,
                    start: active && active.selectionStart,
                    end: active && active.selectionEnd,
                    top: workspace && workspace.scrollTop,
                };
            }),
            {
                placeholder:
                    'type a video idea — or leave blank and the model invents one…',
                value:
                    'Focus and selection must survive a background refresh.',
                start: focusSnapshot.start,
                end: focusSnapshot.end,
                top: focusSnapshot.top,
            },
            'a background Experiment refresh must preserve the active field, its '
                + 'selection, and the Experiment Lab scroll position'
        );
        const stopGrindButton = page.locator('[data-grindstop]');
        await stopGrindButton.waitFor();
        await stopGrindButton.click();
        assert.deepStrictEqual(
            await page.locator('[data-grindstop]').evaluate(button => ({
                disabled: button.disabled,
                text: button.textContent.trim(),
            })),
            { disabled: true, text: 'Stopping…' },
            'Stop must acknowledge the click synchronously instead of '
                + 'waiting for the server response'
        );
        await page.locator('[data-grindstop]').evaluate(button => {
            button.click();
        });
        assert.strictEqual(
            await page.evaluate(() => window.__grindStopRequests),
            1,
            'a disabled stopping control must not send duplicate stop requests'
        );
        await page.waitForFunction(() => (
            document.querySelector('[data-grindstop]') === null
            && document.querySelector('#rtg-exppanel')
                ?.textContent.includes('stopped by browser regression fixture')
        ));
        await page.locator('[data-grindopen="0"]').waitFor();
        await page.locator('[data-grindopen="0"]').click();
        await page.locator(
            '[data-score-queue-state="ready"]'
        ).waitFor();
        await page.locator('[data-canonical-score-analysis]').waitFor();
        assert.strictEqual(
            await page.getByText(
                `${grindAttemptFixture.score_coordinate_available_count}/${grindAttemptFixture.score_coordinate_count} coordinates · 4 channel-free keep outputs`,
                { exact: true }
            ).count(),
            1,
            'a finished Grind hook must open its complete persisted ledger in the shared score readout'
        );
        assert.strictEqual(
            await page.evaluate(pathname => (
                window.__fetchCounts[pathname] || 0
            ), `/api/hooks/grind/score/${grindFixtureRid}_0`),
            1,
            'the Grind readout must load its canonical persisted score exactly once'
        );
        assert.strictEqual(
            await page.locator(
                `[data-score-queue-id="grind:${grindFixtureRid}:0"]`
            ).count(),
            1,
            'the opened Grind hook must remain a reusable analysis-queue item'
        );
        const grindQueueRow = page.locator(
            `[data-score-queue-id="grind:${grindFixtureRid}:0"]`
        );
        await grindQueueRow.locator('[data-rawupmark]').click();
        assert.strictEqual(
            await page.locator('[data-canonical-score-analysis]').count(),
            0,
            'the first queue item must collapse cleanly'
        );
        await grindQueueRow.locator('[data-rawupmark]').click();
        await page.locator('[data-canonical-score-analysis]').waitFor();
        assert(
            (await page.locator(
                '[data-canonical-score-analysis]'
            ).innerText()).includes(grindAttemptFixture.title),
            'the first queue item must reopen its complete score after being '
                + 'collapsed'
        );
        await page.locator('.experiment-lab-tab[data-lab-view="team"]').click();
        await page.locator(
            `[data-labteamaccount="${teamAccountId}"]`
        ).click();
        await page.getByText(
            'Generated but not saved',
            { exact: true }
        ).waitFor();
        await page.getByPlaceholder(
            'type a video idea — or leave blank and the model invents one…'
        ).focus();
        await page.waitForTimeout(50);
        assert.strictEqual(
            await page.evaluate(() => (
                window.__labTargetRequests.some(request => (
                    request.path === '/api/hooks/warmup'
                ))
            )),
            false,
            'ordinary canonical operations must never inherit the selected Team account'
        );
        assert.strictEqual(
            await page.getByText(
                'Reference Channels',
                { exact: false }
            ).count(),
            0,
            'Experiment Lab owner inspection must not expose saved channels'
        );
        assert(
            await page.evaluate(accountId => (
                window.__labTargetRequests.some(request => (
                    request.account === accountId
                    && request.path === '/api/raw/saved-hooks'
                ))
                && window.__labTargetRequests.some(request => (
                    request.account === accountId
                    && request.path === '/api/storyboards'
                ))
                && window.__labTargetRequests.some(request => (
                    request.account === accountId
                    && request.path === '/api/experimentlab/activity'
                    && request.search.includes('kind=generation')
                ))
                && !window.__labTargetRequests.some(request => (
                    request.account === accountId
                    && request.path === '/api/raw/saved-channels'
                ))
            ), teamAccountId),
            'owner inspection must scope hooks, storyboards, and only the '
                + 'generation archive to the selected account without loading '
                + 'its saved-channel research library'
        );
        const teamActivitySection = page.locator(
            '.lab-team-activity-section'
        );
        await teamActivitySection.waitFor();
        assert.strictEqual(
            await teamActivitySection.locator('table').count(),
            0,
            'owner generations must be visualized as cards rather than an opaque ID table'
        );
        assert.strictEqual(
            await page.locator(
                '[data-labteamactivityscore="elateamscore1"], '
                    + '[data-labteamactivity="elateamscore1"], '
                    + '[data-labteamactivity="elateamsaved1"]'
            ).count(),
            0,
            'score and save actions must never appear in the owner generation feed'
        );
        assert.strictEqual(
            await page.locator(
                '[data-labteamactivity="elateamgenerated1"]'
            ).count(),
            1,
            'the raw generation feed must contain each generation once'
        );
        await page.locator(
            '[data-labteamactivity="elateamgenerated1"]'
        ).click();
        const generatedActivityDetail = page.locator(
            '[data-lab-team-activity-detail="elateamgenerated1"]'
        );
        await generatedActivityDetail.waitFor();
        const generatedDetailText =
            await generatedActivityDetail.innerText();
        assert(
            generatedDetailText.includes('A machine that cannot spill')
                && generatedDetailText.includes('Candidate Count')
                && generatedDetailText.includes('Generation status')
                && generatedDetailText.includes(
                    'This machine makes spills impossible'
                ),
            'a raw generation must expose its input, output candidates, and lifecycle'
        );
        assert.strictEqual(
            await generatedActivityDetail.locator(
                '.lab-team-generation-media img'
            ).count(),
            5,
            'the raw generation detail must visualize every generated frame'
        );
        assert(
            await page.evaluate(accountId => (
                window.__labTargetRequests.some(request => (
                    request.account === accountId
                    && request.path
                        === '/api/hooks/grpo/group/demo/reqteamgenerated1'
                ))
            ), teamAccountId),
            'opening a raw generation must load its durable output in the '
                + 'selected account scope'
        );
        await generatedActivityDetail.locator(
            '[data-labteamactivityclose]'
        ).click();
        if (process.env.EXPERIMENT_LAB_TEAM_DESKTOP_SCREENSHOT) {
            fs.mkdirSync(path.dirname(
                process.env.EXPERIMENT_LAB_TEAM_DESKTOP_SCREENSHOT
            ), { recursive: true });
            await teamActivitySection.scrollIntoViewIfNeeded();
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_TEAM_DESKTOP_SCREENSHOT,
                fullPage: false,
            });
        }
        if (process.env.EXPERIMENT_LAB_TEAM_MOBILE_SCREENSHOT) {
            const teamDesktopViewport = page.viewportSize();
            await page.setViewportSize({ width: 390, height: 844 });
            await teamActivitySection.scrollIntoViewIfNeeded();
            assert.strictEqual(
                await page.evaluate(() => document.documentElement.scrollWidth),
                390,
                'the owner generation cards must not overflow a phone viewport'
            );
            fs.mkdirSync(path.dirname(
                process.env.EXPERIMENT_LAB_TEAM_MOBILE_SCREENSHOT
            ), { recursive: true });
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_TEAM_MOBILE_SCREENSHOT,
                fullPage: false,
            });
            await page.setViewportSize(teamDesktopViewport);
        }
        await page.locator(
            '[data-labteamview="saved"]'
        ).click();
        assert.strictEqual(
            await page.getByText(
                'Creator Review',
                { exact: false }
            ).count() > 0,
            true,
            'the Saved space tab must display another account hook folders'
        );
        assert.strictEqual(
            await page.getByText(
                'Opening Boards',
                { exact: false }
            ).count() > 0,
            true,
            'the Saved space tab must display another account storyboard folders'
        );
        await page.locator(
            '[data-labteamfolder="elfteamhooks"]'
        ).click();
        assert.strictEqual(
            await page.locator(
                `[data-labteamhook="${historicalSavedHookId}"]`
            ).count(),
            1,
            'owner folder selection must show the member saved hooks in their persisted folder'
        );
        const savedSpaceDesktopViewport = page.viewportSize();
        await page.setViewportSize({ width: 390, height: 844 });
        assert.strictEqual(
            await page.evaluate(() => document.documentElement.scrollWidth),
            390,
            'the owner Saved space folder browser must not overflow a phone viewport'
        );
        await page.setViewportSize(savedSpaceDesktopViewport);
        if (process.env.EXPERIMENT_LAB_TEAM_SAVED_SCREENSHOT) {
            fs.mkdirSync(path.dirname(
                process.env.EXPERIMENT_LAB_TEAM_SAVED_SCREENSHOT
            ), { recursive: true });
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_TEAM_SAVED_SCREENSHOT,
                fullPage: false,
            });
        }
        const teamStoryboardCard = page.locator(
            `[data-labteamstoryboard="${teamStoryboardId}"]`
        );
        await teamStoryboardCard.waitFor();
        await teamStoryboardCard.click();
        const teamStoryboardDetail = page.locator(
            `[data-lab-team-storyboard-detail="${teamStoryboardId}"]`
        );
        await teamStoryboardDetail.waitFor();
        assert(
            (await teamStoryboardDetail.innerText()).includes(
                'Stored creator frame 5 prompt'
            ),
            'saved storyboard inspection must reveal all stored frame prompts'
        );
        assert.strictEqual(
            await teamStoryboardDetail.locator(
                '.lab-team-storyboard-frame'
            ).count(),
            5,
            'saved storyboard inspection must visualize every stored frame'
        );
        await page.locator(
            `[data-labteamhook="${historicalSavedHookId}"]`
        ).first().click();
        try {
            await page.locator(
                '[data-saved-detail-state="team-read-only"]'
            ).waitFor({ state: 'attached' });
        } catch (error) {
            console.error(
                'TEAM DETAIL STATES:',
                await page.locator(
                    '[data-saved-detail-state]'
                ).evaluateAll(nodes => nodes.map(node => ({
                    state: node.getAttribute(
                        'data-saved-detail-state'
                    ),
                    text: node.textContent,
                })))
            );
            console.error(
                'TEAM DETAIL TEXT:',
                (await page.locator('#rtg-exppanel').innerText())
                    .slice(0, 2200)
            );
            throw error;
        }
        assert.strictEqual(
            await page.locator(
                '[data-saved-detail-state="team-read-only"]'
            ).count(),
            1,
            'owner Team hook inspection must use the exact canonical detail in read-only mode'
        );
        assert.strictEqual(
            await page.locator(
                '#rtg-exppanel [data-savedrescore]'
            ).count(),
            0,
            'team inspection must never expose a write-capable re-score action'
        );
        await page.locator(
            '.experiment-lab-tab[data-lab-view="team"]'
        ).click();
        await page.locator(
            `[data-labteamaccount="${ownerAccountId}"]`
        ).click();
        await page.getByText('Owner workspace', { exact: true }).waitFor();
        await page.locator('.experiment-lab-tab[data-lab-view="score"]').click();
        await page.locator('[data-rawbuildmode="0"]').first().click();
        await page.getByPlaceholder(
            'or paste a YouTube link…'
        ).fill('https://youtube.com/shorts/auto-open-score');
        await page.locator('[data-rawytgo]').first().click();
        const automaticScoreAnalysis = page.locator(
            '[data-canonical-score-analysis]'
        );
        await automaticScoreAnalysis.waitFor();
        await page.waitForFunction(() => (
            (window.__fetchCounts['/api/raw/hook-save'] || 0) >= 1
        ));
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        const pendingSavedHook = page.locator(
            '[data-saved-hook-pending]'
        );
        await pendingSavedHook.waitFor();
        assert(
            (await pendingSavedHook.innerText()).includes(
                'Automatically opened YouTube score'
            ),
            'a save must appear in Saved hooks immediately while its '
                + 'canonical write is still running'
        );
        const immediateSavedHookCount = await page.locator(
            '[data-savedopen]'
        ).count();
        const immediatePendingHookCount = await page.locator(
            '[data-saved-hook-pending]'
        ).count();
        assert.strictEqual(
            Number(await page.locator(
                '[data-lab-hook-count]'
            ).innerText()),
            immediateSavedHookCount + immediatePendingHookCount,
            'the Saved hooks badge and visible canonical + pending rows '
                + 'must use one local source of truth'
        );
        const immediateCanonicalSavedHook = page.locator(
            `[data-savedopen="${autoSavedHookId}"]`
        );
        await immediateCanonicalSavedHook.waitFor();
        assert.strictEqual(
            await page.locator('[data-saved-hook-pending]').count(),
            0,
            'the visible pending row must become the canonical saved row '
                + 'without navigating away or refreshing the library'
        );
        assert.strictEqual(
            Number(await page.locator(
                '[data-lab-hook-count]'
            ).innerText()),
            await page.locator('[data-savedopen]').count(),
            'the badge and visible canonical library must stay in sync '
                + 'when the background write completes'
        );
        await page.locator(
            '.experiment-lab-tab[data-lab-view="score"]'
        ).click();
        await page.evaluate(() => {
            window.__automaticScoreNode = document.querySelector(
                '[data-canonical-score-analysis]'
            );
        });
        await page.waitForFunction(() => (
            window.__labAutoSavedScore
            && document.querySelector(
                '[data-canonical-score-analysis]'
            )
        ));
        assert.strictEqual(
            await page.evaluate(() => document.querySelector(
                '[data-canonical-score-analysis]'
            ) === window.__automaticScoreNode),
            true,
            'background saved-hook persistence must not replace the open '
                + 'score analysis'
        );
        assert.strictEqual(
            await page.locator(
                '.experiment-lab-tab[data-lab-view="score"]'
            ).getAttribute('aria-selected'),
            'true',
            'a completed score must automatically open the Score view'
        );
        assert.deepStrictEqual(
            await automaticScoreAnalysis.evaluate(element => ({
                ledgerCoordinates: Number(
                    element.dataset.ledgerCoordinateCount
                ),
                availableCoordinates: Number(
                    element.dataset.ledgerCoordinateAvailableCount
                ),
                derivedOutputs: Number(
                    element.dataset.derivedOutputCount
                ),
            })),
            {
                ledgerCoordinates: 21,
                availableCoordinates: 21,
                derivedOutputs: 4,
            },
            'the automatically opened analysis must expose the complete '
                + '21-coordinate ledger and all four channel-free outputs'
        );
        assert(
            (await automaticScoreAnalysis.innerText()).includes(
                '21 stored score coordinates + 4 channel-free keep outputs'
            ),
            'the full result must label the complete analysis explicitly'
        );
        await automaticScoreAnalysis.locator('[data-scoreedit]').click();
        const liveScoreEditor = page.locator(
            '#shorts-storyboard-workbench'
        );
        await liveScoreEditor.locator('.sb-panel-tile img').first().waitFor();
        assert.strictEqual(
            await liveScoreEditor.locator('.sb-panel-tile img').count(),
            5,
            'every live score must open its exact visual input in the one '
                + 'shared five-frame editor'
        );
        assert.strictEqual(
            await liveScoreEditor.locator(
                '[data-sb-hook-text]'
            ).inputValue(),
            String(
                historicalUpgradeScore.transcript
                || historicalUpgradeScore.text
                || ''
            ),
            'the score-to-editor handoff must preserve the transcript that '
                + 'was embedded'
        );
        await liveScoreEditor.locator('[data-sb-new]').click();
        await page.locator('[data-rawbuildmode="0"]').first().click();
        await automaticScoreAnalysis.waitFor();
        const scoreTranscript = automaticScoreAnalysis.locator(
            '.score-input-transcript'
        );
        await scoreTranscript.waitFor();
        assert.deepStrictEqual(
            await scoreTranscript.evaluate(element => {
                const style = getComputedStyle(element);
                return {
                    background: style.backgroundColor,
                    border: style.borderTopColor,
                    color: style.color,
                    fontStyle: style.fontStyle,
                };
            }),
            {
                background: 'rgb(247, 247, 250)',
                border: 'rgb(222, 222, 229)',
                color: 'rgb(29, 29, 31)',
                fontStyle: 'normal',
            },
            'the Experiment Lab transcript must use the light paper theme, '
                + 'not the shared Jarvis navy presentation'
        );
        await automaticScoreAnalysis.locator(
            '[data-rawtransedit]'
        ).click();
        const transcriptEditor = page.locator(
            '[data-canonical-score-analysis] '
                + '.score-input-transcript-editor'
        );
        await transcriptEditor.waitFor();
        assert.deepStrictEqual(
            await transcriptEditor.evaluate(element => {
                const panelStyle = getComputedStyle(element);
                const inputStyle = getComputedStyle(
                    element.querySelector('textarea')
                );
                return {
                    panelBackground: panelStyle.backgroundColor,
                    panelColor: panelStyle.color,
                    inputBackground: inputStyle.backgroundColor,
                    inputColor: inputStyle.color,
                };
            }),
            {
                panelBackground: 'rgb(255, 250, 242)',
                panelColor: 'rgb(29, 29, 31)',
                inputBackground: 'rgb(255, 255, 255)',
                inputColor: 'rgb(29, 29, 31)',
            },
            'editing a transcript must remain in the Experiment Lab visual '
                + 'system instead of reverting to dark Jarvis controls'
        );
        await transcriptEditor.locator('[data-rawtranscancel]').click();
        await page.locator(
            '[data-canonical-score-analysis] [data-rawtitleedit]'
        ).click();
        const scoreTitleInput = page.locator(
            '[data-canonical-score-analysis] '
                + '.score-input-title-editor [data-rawtitletext]'
        );
        await scoreTitleInput.waitFor();
        assert.deepStrictEqual(
            await scoreTitleInput.evaluate(element => {
                const style = getComputedStyle(element);
                return {
                    background: style.backgroundColor,
                    color: style.color,
                };
            }),
            {
                background: 'rgb(255, 255, 255)',
                color: 'rgb(29, 29, 31)',
            },
            'the score title editor must use the same light form controls'
        );
        await page.locator(
            '[data-canonical-score-analysis] [data-rawtitlecancel]'
        ).click();
        assert.deepStrictEqual(
            await page.locator(
                '[data-canonical-score-analysis]'
            ).locator('div, textarea, input').evaluateAll(elements => (
                elements.map(element => ({
                    tag: element.tagName.toLowerCase(),
                    className: element.className,
                    background: getComputedStyle(element).backgroundColor,
                })).filter(item => (
                    item.background === 'rgb(15, 23, 42)'
                    || item.background === 'rgb(30, 41, 59)'
                ))
            )),
            [],
            'the complete Experiment Lab score must not contain Jarvis navy '
                + 'panel or form backgrounds'
        );
        assert.strictEqual(
            await page.evaluate(() => (
                window.__labAutoSavedScore
                && window.__labAutoSavedScore.score_ledger_sha256
            )),
            historicalUpgradeScore.score_ledger.ledger_sha256,
            'the private saved record must bind the exact ledger being shown'
        );
        assert.strictEqual(
            await page.evaluate(() => (
                window.__labAutoSavedScore
                && window.__labAutoSavedScore.score_ledger.entries.length
            )),
            21,
            'the auto-save must persist all 21 coordinates rather than a '
                + 'summary-only score'
        );
        await page.waitForFunction(id => (
            window.JarvisRetention.__st().rawUploads.some(upload => (
                upload && upload.savedId === id
            ))
        ), autoSavedHookId);
        assert.strictEqual(
            await automaticScoreAnalysis.locator(
                '[data-score-storage-status]'
            ).innerText(),
            'Stored in your private hook library',
            'background persistence must update the open score in place'
        );
        assert.strictEqual(
            await automaticScoreAnalysis.locator(
                `[data-scoreopensaved="${autoSavedHookId}"]`
            ).count(),
            1,
            'a persisted score must expose a direct path into Saved hooks'
        );
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        const persistedCanonicalSavedHook = page.locator(
            `[data-savedopen="${autoSavedHookId}"]`
        );
        await persistedCanonicalSavedHook.waitFor();
        assert.strictEqual(
            await page.locator('[data-saved-hook-pending]').count(),
            0,
            'the pending save row must be replaced by the canonical row'
        );
        assert.strictEqual(
            Number(await page.locator(
                '[data-lab-hook-count]'
            ).innerText()),
            await page.locator('[data-savedopen]').count(),
            'after save completion the badge and canonical library count '
                + 'must remain identical'
        );
        await page.locator(
            '.experiment-lab-tab[data-lab-view="score"]'
        ).click();
        const embedCountBeforeReopen = await page.evaluate(() => (
            window.__fetchCounts['/api/raw/embed-montage'] || 0
        ));
        await page.evaluate(() => {
            BuildingRegistry.get('Experiment Lab').close();
            const host = document.getElementById('root');
            host.innerHTML = '';
            BuildingRegistry.get('Experiment Lab').open(host);
        });
        await page.getByText('Owner workspace', { exact: true }).waitFor();
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        const persistedAutomaticScore = page.locator(
            '[data-savedopen="hk-auto-opened-score"]'
        );
        await persistedAutomaticScore.waitFor();
        assert(
            (await persistedAutomaticScore.innerText()).includes(
                'Automatically opened YouTube score'
            ),
            'a completed score must return from the account workspace after '
                + 'the building is fully closed and reopened'
        );
        await page.locator('[data-savedfoldernew]:visible').click();
        await page.locator('[data-savedfoldername]:visible').fill(
            'Launch concepts'
        );
        await page.locator('[data-savedfoldercreate]:visible').click();
        await page.locator(
            '[data-savedfolder="elf-owner-hooks-1"]:visible'
        ).waitFor();
        await page.locator('[data-savedfolder="all"]:visible').click();
        await page.locator(
            '[data-saved-drag="hk-auto-opened-score"]:visible'
        ).dragTo(page.locator(
            '[data-savedfolderdrop="elf-owner-hooks-1"]:visible'
        ));
        await page.waitForFunction(() => (
            window.__labFolderRequests.some(request => (
                request.path === '/api/raw/hook-move'
                && request.payload.id === 'hk-auto-opened-score'
                && request.payload.folder === 'elf-owner-hooks-1'
            ))
        ));
        await page.locator(
            '[data-savedfolder="elf-owner-hooks-1"]:visible'
        ).click();
        await page.locator(
            '[data-savedopen="hk-auto-opened-score"]:visible'
        ).waitFor();
        assert.strictEqual(
            await page.evaluate(() => (
                window.__fetchCounts['/api/raw/embed-montage'] || 0
            )),
            embedCountBeforeReopen,
            'creating a folder and organizing an existing score must be '
                + 'metadata-only and never re-embed the video'
        );
        await page.locator('[data-savedfolder="all"]:visible').click();
        await page.locator(
            '[data-savedscore="hk-auto-opened-score"]'
        ).click();
        await page.locator(
            '[data-saved-detail-state="canonical"]'
        ).waitFor({ state: 'attached' });
        assert.strictEqual(
            await page.evaluate(() => (
                window.__fetchCounts['/api/raw/embed-montage'] || 0
            )),
            embedCountBeforeReopen,
            'reopening a saved score must load its persisted ledger and never '
                + 'invoke the embedding endpoint'
        );
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        await page.locator(
            `[data-savededit="${autoSavedHookId}"]:visible`
        ).click();
        await page.locator(
            '.experiment-lab-tab[data-lab-view="score"][aria-selected="true"]'
        ).waitFor();
        const editableRevision = page.locator(
            '#shorts-storyboard-workbench'
        );
        await editableRevision.locator(
            '.sb-panel-tile img'
        ).first().waitFor();
        assert.strictEqual(
            await editableRevision.locator('.sb-panel-tile img').count(),
            5,
            'Edit must import the saved visual into the shared five-frame '
                + 'storyboard editor'
        );
        assert.strictEqual(
            await editableRevision.locator(
                '[data-sb-hook-text]'
            ).inputValue(),
            autoSavedHookRecord.text,
            'the editable revision must retain the saved spoken text'
        );
        assert(
            (await editableRevision.innerText()).includes(
                'editable revision'
            ),
            'the UI must explain that editing forks a new revision'
        );
        await editableRevision.locator('[data-sb-new]').click();
        await page.locator('[data-rawbuildmode="0"]').first().click();
        await page.locator(
            '.experiment-lab-tab[data-lab-view="score"]'
        ).click();
        await automaticScoreAnalysis.scrollIntoViewIfNeeded();
        if (process.env.EXPERIMENT_LAB_SCORE_DESKTOP_SCREENSHOT) {
            fs.mkdirSync(
                path.dirname(
                    process.env.EXPERIMENT_LAB_SCORE_DESKTOP_SCREENSHOT
                ),
                { recursive: true }
            );
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_SCORE_DESKTOP_SCREENSHOT,
                fullPage: false,
            });
        }
        if (process.env.EXPERIMENT_LAB_SCORE_MOBILE_SCREENSHOT) {
            const scoreDesktopViewport = page.viewportSize();
            await page.setViewportSize({ width: 390, height: 844 });
            await automaticScoreAnalysis.scrollIntoViewIfNeeded();
            assert.strictEqual(
                await page.evaluate(() => document.documentElement.scrollWidth),
                390,
                'the opened canonical score must not overflow the phone viewport'
            );
            fs.mkdirSync(
                path.dirname(
                    process.env.EXPERIMENT_LAB_SCORE_MOBILE_SCREENSHOT
                ),
                { recursive: true }
            );
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_SCORE_MOBILE_SCREENSHOT,
                fullPage: false,
            });
            await page.setViewportSize(scoreDesktopViewport);
        }
        const batchVideoUpload = page.locator(
            '#rtg-exppanel [data-rawupload]'
        ).first();
        await batchVideoUpload.waitFor();
        assert.match(
            await batchVideoUpload.innerText(),
            /Upload videos/,
            'Score must expose one multi-video picker'
        );
        assert.strictEqual(
            await page.getByText(
                'up to 12 · scored one at a time',
                { exact: true }
            ).count(),
            1,
            'Score must disclose that one picker accepts a sequential '
                + 'multi-video batch'
        );
        const storyboardMode = page.locator(
            '[data-rawbuildmode="1"]'
        ).first();
        await storyboardMode.click();
        const integratedStoryboard = page.locator(
            '#rtg-exppanel #shorts-storyboard-workbench'
        );
        await integratedStoryboard.waitFor();
        assert.strictEqual(
            await integratedStoryboard.locator(
                '[data-sb-panel]'
            ).count(),
            5,
            'the live Experiment UI must render the shared five-panel '
                + 'storyboard workbench'
        );
        assert.strictEqual(
            await integratedStoryboard.locator(
                '[data-sb-score-current]'
            ).count(),
            1,
            'the integrated storyboard must expose the canonical Shorts '
                + 'score action'
        );
        assert.strictEqual(
            await integratedStoryboard.locator(
                '[data-sb-animation-style]'
            ).count(),
            1,
            'Experiment Lab must expose the shared text-only animation preset'
        );
        const storyboardBrief = integratedStoryboard.locator(
            '[data-sb-brief]'
        );
        await page.evaluate(() => {
            window.__labStoryboardNode = document.querySelector(
                '#shorts-storyboard-workbench'
            );
            window.__labStoryboardBriefNode = document.querySelector(
                '#shorts-storyboard-workbench [data-sb-brief]'
            );
        });
        await storyboardBrief.fill(
            'Keep this exact editor open while persistence runs.'
        );
        await page.waitForFunction(() => (
            window.__labStoryboardSaves.length > 0
        ));
        await page.waitForTimeout(250);
        assert.deepStrictEqual(
            await page.evaluate(() => ({
                sameWorkbench: document.querySelector(
                    '#shorts-storyboard-workbench'
                ) === window.__labStoryboardNode,
                sameInput: document.querySelector(
                    '#shorts-storyboard-workbench [data-sb-brief]'
                ) === window.__labStoryboardBriefNode,
                stillFocused: document.activeElement
                    === window.__labStoryboardBriefNode,
            })),
            {
                sameWorkbench: true,
                sameInput: true,
                stillFocused: true,
            },
            'Experiment Lab persistence must not rerender the shared '
                + 'workbench or take focus'
        );
        assert.deepStrictEqual(
            await integratedStoryboard.locator(
                '[data-sb-section]'
            ).evaluateAll(nodes => nodes.map(node => (
                node.getAttribute('data-sb-section')
            ))),
            ['upload', 'build', 'refine'],
            'Experiment Lab must expose the shared upload and AI entry '
                + 'paths before their common refinement surface'
        );
        await integratedStoryboard.locator('.sb-style-toggle').click();
        assert.strictEqual(
            await integratedStoryboard.locator(
                '[data-sb-animation-style]'
            ).isChecked(),
            true,
            'the animation switch must work through the shared Experiment '
                + 'event boundary'
        );
        assert.strictEqual(
            await integratedStoryboard.evaluate(element => (
                getComputedStyle(element).getPropertyValue(
                    '--sb-panel'
                ).trim()
            )),
            '#ffffff',
            'Experiment Lab must apply its light visual language without '
                + 'forking the storyboard engine'
        );
        if (process.env.EXPERIMENT_LAB_STORYBOARD_DESKTOP_SCREENSHOT) {
            fs.mkdirSync(path.dirname(
                process.env.EXPERIMENT_LAB_STORYBOARD_DESKTOP_SCREENSHOT
            ), { recursive: true });
            await integratedStoryboard.scrollIntoViewIfNeeded();
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_STORYBOARD_DESKTOP_SCREENSHOT,
                fullPage: false,
            });
        }
        if (process.env.EXPERIMENT_LAB_STORYBOARD_MOBILE_SCREENSHOT) {
            const previousViewport = page.viewportSize();
            await page.setViewportSize({ width: 390, height: 844 });
            await page.waitForTimeout(100);
            fs.mkdirSync(path.dirname(
                process.env.EXPERIMENT_LAB_STORYBOARD_MOBILE_SCREENSHOT
            ), { recursive: true });
            await integratedStoryboard.scrollIntoViewIfNeeded();
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_STORYBOARD_MOBILE_SCREENSHOT,
                fullPage: false,
            });
            await page.setViewportSize(previousViewport);
            await page.waitForTimeout(100);
        }
        assert.strictEqual(
            await integratedStoryboard.locator(
                '[data-sb-view], [data-sb-generation-mode]'
            ).count(),
            0,
            'Experiment Lab must not reintroduce separate comparison or '
                + 'inert generation modes'
        );
        await page.locator('[data-rawbuildmode="0"]').first().click();
        await page.getByPlaceholder(
            'or paste a YouTube link…'
        ).waitFor();
        await page.locator('.experiment-lab-tab[data-lab-view="hooks"]').click();
        const channelFreeSort = page.locator(
            '[data-savedsort="channelFreeConcat"]'
        );
        const channelFreeFilter = page.locator(
            '[data-savedfilt="channelFreeConcat"]'
        );
        await channelFreeSort.waitFor();
        await channelFreeFilter.waitFor();
        await channelFreeSort.click();
        await page.waitForFunction(highId => (
            document.querySelector('[data-savedopen]')
                ?.getAttribute('data-savedopen') === highId
        ), channelFreeHighId);
        const channelFreeHighCard = page.locator(
            `[data-savedopen="${channelFreeHighId}"]`
        );
        const channelFreeLowCard = page.locator(
            `[data-savedopen="${channelFreeLowId}"]`
        );
        const channelFreeHighPreview = channelFreeHighCard.locator(
            '[data-saved-preview="channelFreeConcat"]'
        );
        const channelFreeLowPreview = channelFreeLowCard.locator(
            '[data-saved-preview="channelFreeConcat"]'
        );
        const normalizedChannelFreeCardText = async card => (
            (await card.innerText())
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase()
        );
        assert(
            (await normalizedChannelFreeCardText(
                channelFreeHighCard
            )).includes(
                `channel-free concat keep ${channelFreeHighOutput.raw.toFixed(1)}%`
            ),
            'selected channel-free sorting must put the exact raw forecast '
                + 'on the saved-hook card'
        );
        assert(
            (await normalizedChannelFreeCardText(
                channelFreeLowCard
            )).includes(
                `channel-free concat keep ${channelFreeLowOutput.raw.toFixed(1)}%`
            ),
            'every saved-hook card must preview its own concat forecast '
                + 'without opening the detail'
        );
        assert.deepStrictEqual(
            await channelFreeHighPreview.evaluate(element => ({
                coordinateId:
                    element.dataset.savedPreviewCoordinateId,
                value: Number(element.dataset.savedPreviewValue),
                percentile: Number(
                    element.getAttribute(
                        'data-saved-preview-percentile-0-100'
                    )
                ),
                artifactSha256:
                    element.dataset.savedPreviewArtifactSha256,
            })),
            {
                coordinateId: 'shorts.channel-free.concat.keep',
                value: channelFreeHighOutput.raw,
                percentile: channelFreeHighOutput.percentile100,
                artifactSha256:
                    channelFreeHighOutput.artifactSha256,
            },
            'saved-hook preview must expose the exact compact-record '
                + 'coordinate, value, percentile, and model artifact'
        );
        assert.strictEqual(
            await channelFreeLowPreview.count(),
            1,
            'the lower channel-free fixture lost its visible preview'
        );
        if (process.env.EXPERIMENT_LAB_SAVED_HOOKS_SCREENSHOT) {
            fs.mkdirSync(path.dirname(
                process.env.EXPERIMENT_LAB_SAVED_HOOKS_SCREENSHOT
            ), { recursive: true });
            await page.screenshot({
                path:
                    process.env.EXPERIMENT_LAB_SAVED_HOOKS_SCREENSHOT,
                fullPage: false,
            });
        }
        await channelFreeFilter.evaluate((input, threshold) => {
            input.value = String(threshold);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }, Math.floor(channelFreeHighOutput.raw));
        await page.waitForFunction(({ highId, lowId }) => (
            !!document.querySelector(`[data-savedopen="${highId}"]`)
            && !document.querySelector(`[data-savedopen="${lowId}"]`)
        ), {
            highId: channelFreeHighId,
            lowId: channelFreeLowId,
        });
        await channelFreeFilter.evaluate(input => {
            input.value = '0';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction(lowId => (
            !!document.querySelector(`[data-savedopen="${lowId}"]`)
        ), channelFreeLowId);
        await page.locator('[data-savedsort="recent"]').click();
        const historicalSavedHookCard = page.locator(
            `[data-savedopen="${historicalSavedHookId}"]`
        );
        await historicalSavedHookCard.waitFor();
        const historicalSavedHookCardText =
            await historicalSavedHookCard.innerText();
        assert(
            historicalSavedHookCardText.includes(
                `keep ${historicalSavedHookKeep.value.toFixed(1)}%`
            ),
            'historical saved-card summary must expose the exact '
                + 'persisted ledger value'
        );
        assert(
            historicalSavedHookCardText.includes(
                'display-only · not predictor-eligible'
            ),
            'historical saved-card score must disclose its evidence '
                + 'boundary'
        );
        assert(
            !historicalSavedHookCardText.includes('No valid persisted'),
            'valid historical ledger was rendered as a missing score'
        );
        const scorerContractFetchesBeforeSavedOpen =
            await page.evaluate(() => (
                window.__fetchCounts['/api/raw/scorer-contract'] || 0
            ));
        const tamperAudits = await page.evaluate(() => (
            window.__historicalTamperFixtures.map(
                fixture => (
                    window.BusinessWorldShortsScoreDisplayAudit(
                        fixture
                    )
                )
            )
        ));
        assert(
            tamperAudits.every(audit => audit.valid === false),
            'historical display audit must reject a changed display '
                + 'value, materialization role, second contract identity, '
                + `and provenance status: ${JSON.stringify(tamperAudits)}`
        );
        const embedsBeforeEditorOpen = await page.evaluate(() => (
            window.__fetchCounts['/api/raw/embed-montage'] || 0
        ));
        await page.locator(
            `[data-savedopen="${channelFreeHighId}"]`
        ).click({ position: { x: 22, y: 22 } });
        await page.locator('#shorts-storyboard-workbench').waitFor();
        assert.strictEqual(
            await page.locator(
                '.experiment-lab-tab[data-lab-view="score"]'
            ).getAttribute('aria-selected'),
            'true',
            'clicking a saved card must enter the shared Storyboard editor'
        );
        await page.waitForFunction(title => {
            const editor = document.querySelector(
                '#shorts-storyboard-workbench'
            );
            return editor
                && editor.querySelector('[data-sb-name]')?.value === title
                && editor.querySelectorAll(
                    '[data-sb-panel-rail] img'
                ).length === 5
                && editor.textContent.includes(
                    'Saved opening is ready in the editor'
                );
        }, channelFreeHigh.record.title);
        assert.strictEqual(
            await page.evaluate(() => (
                window.__fetchCounts['/api/raw/embed-montage'] || 0
            )),
            embedsBeforeEditorOpen,
            'opening a saved video in the editor must hydrate its stored media '
                + 'without re-embedding it'
        );
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        await historicalSavedHookCard.waitFor();
        await historicalSavedHookCard.locator(
            `[data-savedscore="${historicalSavedHookId}"]`
        ).click();
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        const queuedSavedHookCard = page.locator(
            `[data-savedopen="${queuedSavedHookId}"]`
        );
        await queuedSavedHookCard.waitFor();
        await queuedSavedHookCard.locator(
            `[data-savedscore="${queuedSavedHookId}"]`
        ).click();
        const analysisQueue = page.locator(
            '[data-score-analysis-queue]'
        );
        await analysisQueue.waitFor();
        const selfQueueRows = analysisQueue.locator(
            '[data-score-queue-id^="self:"]'
        );
        await page.waitForFunction(({ firstId, secondId }) => (
            !!document.querySelector(
                `[data-score-queue-id="self:${firstId}"]`
            )
            && !!document.querySelector(
                `[data-score-queue-id="self:${secondId}"]`
            )
        ), {
            firstId: historicalSavedHookId,
            secondId: queuedSavedHookId,
        });
        const initialQueueStates = await selfQueueRows.evaluateAll(
            nodes => nodes.map(node => (
                node.getAttribute('data-score-queue-state')
            ))
        );
        assert(
            initialQueueStates.includes('loading')
                && initialQueueStates.includes('queued'),
            'back-to-back saved-video clicks must show one active load and '
                + `one queued analysis: ${JSON.stringify(initialQueueStates)}`
        );
        assert(
            !(await page.locator('#rtg-exppanel').innerText()).includes(
                'Another hook is already being prepared or scored'
            ),
            'saved-video analysis must queue instead of rejecting the second click'
        );
        await page.locator(
            '[data-saved-detail-state="loading"]'
        ).waitFor({ state: 'attached' });
        const historicalLoadingText =
            await page.locator('#rtg-exppanel').innerText();
        assert(
            !historicalLoadingText.includes('Extracting 5 frames')
                && !historicalLoadingText.includes(
                    'embedding the 5 frames'
                ),
            'opening persisted history must not masquerade as a live '
                + 'extraction or embedding job'
        );
        await page.waitForFunction(({ firstId, secondId }) => (
            document.querySelector(
                `[data-score-queue-id="self:${firstId}"]`
            )?.getAttribute('data-score-queue-state') === 'ready'
            && document.querySelector(
                `[data-score-queue-id="self:${secondId}"]`
            )?.getAttribute('data-score-queue-state') === 'ready'
        ), {
            firstId: historicalSavedHookId,
            secondId: queuedSavedHookId,
        });
        assert.strictEqual(
            await page.evaluate(() => (
                window.__fetchCounts['/api/raw/scorer-contract'] || 0
            )),
            scorerContractFetchesBeforeSavedOpen,
            'persisted scores must open from their stored ledger without '
                + 'forcing a live scorer-contract refresh'
        );
        const historicalQueueRow = page.locator(
            `[data-score-queue-id="self:${historicalSavedHookId}"]`
        );
        const queuedQueueRow = page.locator(
            `[data-score-queue-id="self:${queuedSavedHookId}"]`
        );
        assert.strictEqual(
            await historicalQueueRow.count(),
            1,
            'the first completed analysis must remain in the queue'
        );
        assert.strictEqual(
            await queuedQueueRow.count(),
            1,
            'the second completed analysis must remain in the queue'
        );
        if (process.env.EXPERIMENT_LAB_QUEUE_DESKTOP_SCREENSHOT) {
            fs.mkdirSync(path.dirname(
                process.env.EXPERIMENT_LAB_QUEUE_DESKTOP_SCREENSHOT
            ), { recursive: true });
            await analysisQueue.scrollIntoViewIfNeeded();
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_QUEUE_DESKTOP_SCREENSHOT,
                fullPage: false,
            });
        }
        if (process.env.EXPERIMENT_LAB_QUEUE_MOBILE_SCREENSHOT) {
            const queueDesktopViewport = page.viewportSize();
            await page.setViewportSize({ width: 390, height: 844 });
            await analysisQueue.scrollIntoViewIfNeeded();
            assert.strictEqual(
                await page.evaluate(() => document.documentElement.scrollWidth),
                390,
                'the multi-analysis queue must not overflow the phone viewport'
            );
            fs.mkdirSync(path.dirname(
                process.env.EXPERIMENT_LAB_QUEUE_MOBILE_SCREENSHOT
            ), { recursive: true });
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_QUEUE_MOBILE_SCREENSHOT,
                fullPage: false,
            });
            await page.setViewportSize(queueDesktopViewport);
        }
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        const failedSavedHookCard = page.locator(
            `[data-savedopen="${failedSavedHookId}"]`
        );
        const followingSavedHookCard = page.locator(
            `[data-savedopen="${channelFreeHighId}"]`
        );
        await failedSavedHookCard.waitFor();
        await followingSavedHookCard.waitFor();
        await failedSavedHookCard.locator(
            `[data-savedscore="${failedSavedHookId}"]`
        ).click();
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        await followingSavedHookCard.locator(
            `[data-savedscore="${channelFreeHighId}"]`
        ).click();
        await page.waitForFunction(({ failedId, followingId }) => (
            document.querySelector(
                `[data-score-queue-id="self:${failedId}"]`
            )?.getAttribute('data-score-queue-state') === 'error'
            && document.querySelector(
                `[data-score-queue-id="self:${followingId}"]`
            )?.getAttribute('data-score-queue-state') === 'ready'
        ), {
            failedId: failedSavedHookId,
            followingId: channelFreeHighId,
        });
        const failedQueueRow = page.locator(
            `[data-score-queue-id="self:${failedSavedHookId}"]`
        );
        const failedQueueToggle = failedQueueRow.locator(
            '[data-rawupmark]'
        );
        if (
            await failedQueueToggle.getAttribute('aria-expanded')
                !== 'true'
        ) {
            await failedQueueToggle.click();
        }
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        await page.locator(
            '[data-saved-detail-state="error"]'
        ).waitFor({ state: 'attached' });
        const visibleQueueError = page.locator(
            '[data-saved-detail-error][role="alert"]'
        );
        assert(
            (await visibleQueueError.innerText()).includes(
                'fixture saved-hook detail failure'
            ),
            'saved-hook detail failures must expose the server error'
        );
        const retrySavedHook = page.locator(
            '[data-saved-detail-state="error"] [data-savedqueueretry]'
        );
        await retrySavedHook.waitFor();
        const failedFetchesBeforeRetry = await page.evaluate(id => (
            window.__fetchCounts['/api/raw/saved-hook/' + id] || 0
        ), failedSavedHookId);
        await retrySavedHook.click();
        await page.waitForFunction(({ id, count }) => (
            (window.__fetchCounts['/api/raw/saved-hook/' + id] || 0)
                > count
        ), {
            id: failedSavedHookId,
            count: failedFetchesBeforeRetry,
        });
        await page.waitForFunction(id => (
            document.querySelector(
                `[data-score-queue-id="self:${id}"]`
            )?.getAttribute('data-score-queue-state') === 'error'
        ), failedSavedHookId);
        assert.strictEqual(
            await page.locator(
                `[data-score-queue-id="self:${channelFreeHighId}"]`
            ).getAttribute('data-score-queue-state'),
            'ready',
            'one failed saved hook must not block the following queued hook'
        );
        await page.locator(
            '.experiment-lab-tab[data-lab-view="score"]'
        ).click();
        await historicalQueueRow.locator('[data-rawupmark]').click();
        await page.locator(
            '[data-saved-detail-state="historical-read-only"]'
        ).waitFor({ state: 'attached' });
        const openedHistoricalCoordinate = page.locator(
            '#rtg-exppanel '
                + '[data-coordinate-id="shorts.stored.together.keep"]'
                + `[data-coordinate-ledger-sha256="`
                + `${historicalSavedHookKeep.ledgerSha256}"]`
        ).first();
        await openedHistoricalCoordinate.waitFor();
        assert.strictEqual(
            Number(
                await openedHistoricalCoordinate.getAttribute(
                    'data-coordinate-value'
                )
            ),
            historicalSavedHookKeep.value,
            'saved grid and opened score card must render the same '
                + 'ledger value'
        );
        const historicalVisualKeep =
            historicalSavedHookRecord.score_ledger.entries.find(
                entry => entry.coordinate_id
                    === 'shorts.stored.visual.keep'
            );
        assert(historicalVisualKeep && historicalVisualKeep.available);
        const historicalKeepDecision = page.locator(
            '#rtg-exppanel [data-best-keep-predictor]'
        );
        await historicalKeepDecision.waitFor();
        assert.strictEqual(
            await historicalKeepDecision.getAttribute(
                'data-coordinate-id'
            ),
            historicalVisualKeep.coordinate_id,
            'an old score must promote its exact canonical visual keep '
                + 'coordinate instead of presenting the whole keep result '
                + 'as unavailable'
        );
        assert(
            (await historicalKeepDecision.innerText()).includes(
                'Canonical visual keep embedding estimate'
            )
        );
        const historicalRescoreCount =
            await historicalKeepDecision.locator(
                '[data-savedrescore]'
            ).count();
        assert.strictEqual(
            historicalRescoreCount,
            1,
            'an owner must get one explicit current-model upgrade action: '
                + JSON.stringify(await historicalKeepDecision.evaluate(
                    node => ({ ...node.dataset })
                )) + ' '
                + (await historicalKeepDecision.innerText()).slice(0, 1200)
        );
        await page.locator(
            '[data-historical-display-readonly]'
        ).waitFor();
        assert.strictEqual(
            await page.locator(
                '#rtg-exppanel [data-savescored]'
            ).count(),
            0,
            'historical display-only evidence must not expose Save'
        );
        assert.strictEqual(
            await page.locator(
                '#rtg-exppanel [data-rawtitleedit], '
                    + '#rtg-exppanel [data-rawtransedit], '
                    + '#rtg-exppanel [data-rawreembed]'
            ).count(),
            0,
            'historical display-only evidence must not expose edit or '
                + 're-embedding controls'
        );
        await historicalQueueRow.locator('[data-rawupmark]').click();
        assert.strictEqual(
            await page.locator(
                '[data-canonical-score-analysis]'
            ).count(),
            0,
            'clicking the expanded queue row must collapse its analysis'
        );
        await queuedQueueRow.locator('[data-rawupmark]').click();
        await page.locator(
            '[data-canonical-score-analysis]'
        ).waitFor();
        assert(
            (await page.locator(
                '[data-canonical-score-analysis]'
            ).innerText()).includes(
                queuedSavedHookRecord.title
            ),
            'selecting the second row must expand its own canonical analysis'
        );
        await historicalQueueRow.locator('[data-rawupmark]').click();
        const renderedHistoricalCoordinates = await page.locator(
            `[data-embedding-asset="saved:${historicalSavedHookId}"]`
                + '[data-coordinate-display-only="true"]'
        ).evaluateAll(nodes => [
            ...new Set(nodes.map(
                node => node.getAttribute('data-coordinate-id')
            ).filter(Boolean)),
        ].sort());
        const expectedHistoricalCoordinates =
            historicalSavedHookRecord.score_ledger.entries
                .filter(entry => entry.available === true)
                .map(entry => entry.coordinate_id)
                .sort();
        assert.deepStrictEqual(
            renderedHistoricalCoordinates,
            expectedHistoricalCoordinates,
            'the read-only historical detail must expose every available '
                + 'persisted ledger coordinate'
        );
        assert.strictEqual(
            await page.evaluate(
                () => window.__fetchCounts[
                    '/api/raw/embed-montage'
                ] || 0
            ),
            0,
            'opening a persisted historical score must not re-embed'
        );
        await historicalKeepDecision.locator(
            '[data-savedrescore]'
        ).click();
        await page.waitForFunction(() => (
            window.__fetchCounts['/api/raw/embed-montage'] === 1
            && window.__fetchCounts['/api/raw/hook-enrich'] === 1
        ));
        const explicitRescoreEmbedCount = 1;
        const upgradedKeepDecision = page.locator(
            '#rtg-exppanel '
                + '[data-best-keep-predictor]'
                + '[data-coordinate-id="shorts.channel-free.concat.keep"]'
        );
        await upgradedKeepDecision.waitFor();
        assert(
            (await upgradedKeepDecision.innerText()).includes(
                `${historicalUpgradeScore.channel_free_keep_forecasts.outputs.concat.raw.toFixed(1)}%`
            ),
            'the explicit upgrade must reopen the persisted current score '
                + 'and promote its selected channel-free forecast'
        );
        const enrichSubmission = await page.evaluate(
            () => window.__historicalEnrichSubmission
        );
        assert.strictEqual(
            enrichSubmission.id,
            historicalSavedHookId
        );
        assert.strictEqual(
            enrichSubmission.expected_score_record_sha256,
            historicalSavedHookRecord.score_record_sha256 || null,
            'the historical upgrade must preserve its exact prior record '
                + 'precondition'
        );
        assert.strictEqual(
            enrichSubmission.score_ledger_sha256,
            historicalUpgradeScore.score_ledger.ledger_sha256,
            'the replacement write must carry the scorer ledger SHA'
        );
        assert.strictEqual(
            enrichSubmission.text,
            String(
                historicalSavedHookRecord.transcript
                || historicalSavedHookRecord.text
                || ''
            ),
            'the upgrade must preserve the historical transcript'
        );
        assert.strictEqual(
            enrichSubmission.montage,
            'data:image/jpeg;base64,'
                + historicalUpgradeScore.montage,
            'the upgrade must persist the exact canonical JPEG returned '
                + 'by the scorer instead of the older display montage'
        );
        assert.strictEqual(
            await page.locator('[data-savedbank="channels"]').count(),
            0,
            'Experiment Lab must not expose the Jarvis Saved Channels tab'
        );
        assert.strictEqual(
            await page.getByPlaceholder('https://youtube.com/@channel').count(),
            0,
            'Experiment Lab must not load the saved-channel intake form'
        );
        assert.strictEqual(
            await page.locator('.experiment-lab-tab[data-lab-view="team"]').count(),
            1,
            'the owner must receive exactly one Team workspace tab'
        );
        assert.deepStrictEqual(
            await page.evaluate(() => ({
                width: document.documentElement.clientWidth,
                scroll: document.documentElement.scrollWidth,
            })),
            { width: 1280, scroll: 1280 }
        );

        await page.setViewportSize({ width: 390, height: 844 });
        assert.deepStrictEqual(
            await page.evaluate(() => ({
                width: document.documentElement.clientWidth,
                scroll: document.documentElement.scrollWidth,
            })),
            { width: 390, scroll: 390 }
        );
        const labWorkspace = page.locator('.experiment-lab-workspace');
        const scrollState = await labWorkspace.evaluate(element => ({
            overflowY: getComputedStyle(element).overflowY,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            top: element.scrollTop,
        }));
        assert.strictEqual(
            scrollState.overflowY,
            'auto',
            'the lab workspace must own vertical scrolling'
        );
        assert(
            scrollState.scrollHeight > scrollState.clientHeight,
            'mobile workspace should contain enough content to scroll'
        );
        await labWorkspace.evaluate(element => {
            element.scrollTop = element.scrollHeight;
        });
        const mobileScrollTop = await labWorkspace.evaluate(
            element => element.scrollTop
        );
        assert(
            mobileScrollTop > 0,
            'mobile Experiment Lab must scroll independently of the hidden page body'
        );
        await labWorkspace.evaluate(element => {
            element.scrollTop = 0;
        });
        if (process.env.EXPERIMENT_LAB_SCREENSHOT) {
            fs.mkdirSync(
                path.dirname(process.env.EXPERIMENT_LAB_SCREENSHOT),
                { recursive: true }
            );
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_SCREENSHOT,
                fullPage: false,
            });
        }
        await page.setViewportSize({ width: 1280, height: 820 });
        await page.locator(
            '.experiment-lab-tab[data-lab-view="create"]'
        ).click();
        assert.strictEqual(
            await page.locator(
                '.experiment-lab-tab[data-lab-view="create"]'
            ).getAttribute('aria-selected'),
            'true',
            'Auto must own the selected navigation state after switching views'
        );
        assert.strictEqual(
            await page.locator(
                '.experiment-lab-tab[data-lab-view="score"]'
            ).getAttribute('aria-selected'),
            'false',
            'Score must release the selected navigation state after switching views'
        );
        if (process.env.EXPERIMENT_LAB_DESKTOP_SCREENSHOT) {
            fs.mkdirSync(
                path.dirname(process.env.EXPERIMENT_LAB_DESKTOP_SCREENSHOT),
                { recursive: true }
            );
            await page.screenshot({
                path: process.env.EXPERIMENT_LAB_DESKTOP_SCREENSHOT,
                fullPage: false,
            });
        }

        await page.evaluate(() => {
            window.__labReplies['/api/experimentlab/context'] = {
                schema: 'experiment-lab-workspace-v1',
                viewer: {
                    id: '33333333-3333-4333-8333-333333333333',
                    email: 'another-owner@example.com',
                    name: 'Another Owner',
                    role: 'owner',
                },
                activeAccount: {
                    id: '33333333-3333-4333-8333-333333333333',
                    email: 'another-owner@example.com',
                    name: 'Another Owner',
                    role: 'owner',
                },
                readOnly: false,
                owner: true,
                teamAccess: false,
                summary: {
                    counts: {
                        hooks: 0,
                        channels: 0,
                        storyboards: 0,
                    },
                    folderCounts: {
                        hooks: 0,
                        channels: 0,
                        storyboards: 0,
                    },
                    activityCount: 0,
                },
                workspace: {
                    schema: 'experiment-lab-workspace-v1',
                    collections: {
                        hooks: { folders: [], items: [] },
                        channels: { folders: [], items: [] },
                        storyboards: { folders: [], items: [] },
                    },
                    activity: [],
                },
                accounts: [],
            };
            BuildingRegistry.get('Experiment Lab').close();
            const host = document.getElementById('root');
            host.innerHTML = '';
            BuildingRegistry.get('Experiment Lab').open(host);
        });
        await page.locator(
            '[data-experiment-lab-account]'
        ).getByText('Another Owner', { exact: true }).waitFor();
        assert.strictEqual(
            await page.locator(
                '.experiment-lab-tab[data-lab-view="team"]'
            ).count(),
            0,
            'a non-Tyler account must not receive a Team tab in the DOM, '
                + 'even if its stored role is owner'
        );

        // Saved-channel research remains a Jarvis capability. Exercise the
        // same canonical renderer directly so removing it from Experiment Lab
        // does not reduce ledger and validation coverage.
        await page.evaluate(async () => {
            BuildingRegistry.get('Experiment Lab').close();
            const host = document.getElementById('root');
            host.innerHTML = '';
            await window.JarvisRetention.mountShortsExperiment(
                host,
                { surface: 'jarvis' }
            );
        });
        await page.locator(
            '[data-shorts-experiment-renderer="shorts-quant-experiment-surface-v1"]'
        ).waitFor();
        await page.locator('[data-savedbank="channels"]').click();
        if (!await page.getByPlaceholder('or paste a YouTube link…').count()) {
            await page.locator('[data-rawbuildmode="0"]').first().click();
        }
        assert.strictEqual(await page.getByPlaceholder('type a video idea — or leave blank and the model invents one…').count(), 1);
        assert.strictEqual(await page.getByPlaceholder('describe one video idea — Grind tests different hooks for it…').count(), 1);
        assert.strictEqual(await page.getByPlaceholder('or paste a YouTube link…').count(), 1);
        assert.strictEqual(await page.getByPlaceholder('https://youtube.com/@channel').count(), 1);
        assert.strictEqual(await page.getByText('Save channel + score every Short', { exact: true }).count(), 1);
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 1280, scroll: 1280 });

        await page.setViewportSize({ width: 390, height: 844 });
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 390, scroll: 390 });
        await page.getByText('Mobile Risk Channel', { exact: true }).click();
        await page.getByText('continue 1 unfinished', { exact: true }).waitFor();
        assert.strictEqual(await page.locator('[data-savedchannelvideo]').first().getAttribute('data-savedchannelvideo'), `${channelId}:vid00000001`, 'raw-view mode must begin with the actual highest-view Short');

        const firstMontage = page.locator('[data-savedchannelmontage-video]').first();
        await firstMontage.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => {
            const image = document.querySelector('[data-savedchannelmontage-video]');
            return image && image.src.includes('/api/raw/saved-channel/') && image.complete && image.naturalWidth > 0;
        });
        assert.strictEqual(await firstMontage.evaluate(image => image.naturalWidth), 1, 'stored authenticated montage must decode as an image');

        await page.locator('[data-savedchannelgroup="text"]').click();
        await page.locator('[data-savedchannelfeature="text.keep"]').click();
        assert.strictEqual((await page.locator('[data-savedchannelsort="feature"]').textContent()).trim(), 'highest Text Keep rate', 'selected indicator must own the sort label');
        assert.strictEqual(await page.locator('[data-savedchannelvideo]').first().getAttribute('data-savedchannelvideo'), `${channelId}:vid00000002`, 'Text Keep rate must reorder the library by Text Keep rate, not raw views');

        const selectedCard = page.locator(`[data-savedchannelvideo="${channelId}:vid00000002"]`);
        await selectedCard.click();
        const videoPath = `/api/raw/saved-channel/${channelId}/video/vid00000002`;
        await page.waitForFunction(pathname => window.__fetchCounts[pathname] === 1, videoPath);
        assert.strictEqual(await page.evaluate(() => window.__fetchCounts['/api/raw/embed-montage'] || 0), explicitRescoreEmbedCount, 'opening a saved scored Short must not invoke the embedding endpoint');
        try {
            await page.locator(
                '#rtg-exppanel [data-channel-free-keep="concat"]'
            ).waitFor();
        } catch (error) {
            console.error(
                'SAVED VIDEO DETAIL:',
                (await page.locator('#rtg-exppanel').innerText())
                    .slice(0, 3000)
            );
            throw error;
        }
        await page.waitForFunction(() => (
            Array.from(document.querySelectorAll(
                '#rtg-exppanel img[src*="vid00000002"]'
            )).some(image => image.complete && image.naturalWidth > 0)
        ));
        const storedPanelText =
            await page.locator('#rtg-exppanel').innerText();
        assert(
            storedPanelText.includes(
                '18 modality × target coordinates'
            ),
            `stored score must open the complete graph read-out: ${
                storedPanelText.slice(0, 500)
            }`
        );
        await page.getByText(
            '21 stored score coordinates + 4 channel-free keep outputs',
            { exact: true }
        ).waitFor();
        for (const signal of ['concat', 'visual', 'together', 'text']) {
            const storedForecast = page.locator(
                `[data-channel-free-keep="${signal}"]`
            );
            await storedForecast.waitFor();
            const storedForecastText = await storedForecast.innerText();
            assert(
                storedForecastText.includes(
                    `${videos[1].channel_free_keep_forecasts.outputs[signal].raw.toFixed(1)}%`
                ),
                `the ordinary stored score card must show the exact ${signal} channel-free value: ${storedForecastText}`
            );
            assert(
                storedForecastText.includes(
                    `shorts.channel-free.${signal}.keep`
                ),
                `the ${signal} card must name its governed coordinate`
            );
            assert(
                storedForecastText.includes('No creator scaling'),
                `the ${signal} card must disclose that creator scaling is absent`
            );
        }
        const currentKeepDecision = page.locator(
            '#rtg-exppanel [data-best-keep-predictor]'
        );
        assert.strictEqual(
            await currentKeepDecision.getAttribute('data-coordinate-id'),
            'shorts.channel-free.concat.keep',
            'the score card must promote the selected channel-free signal'
        );
        assert(
            (await currentKeepDecision.innerText()).includes(
                `${videos[1].channel_free_keep_forecasts.outputs.concat.raw.toFixed(1)}%`
            )
        );
        const lineageText = await page.locator('#rtg-exppanel').innerText();
        assert(lineageText.includes("exact raw-map video IDs that join to a finite Tyler stayed-to-watch label"), 'score detail must expose the keep-axis fitting population');
        assert(lineageText.includes('Public Shorts embedding corpus'), 'score detail must expose the public-axis fitting population');
        assert(lineageText.includes('artifact 0123456789ab'), 'score detail must expose the exact persisted steer artifact');
        const parityAfterStoredOpen = await page.evaluate(() => window.BusinessWorldEmbeddingParityAudit(document));
        assert(parityAfterStoredOpen.ok, `stored card/detail parity failed: ${JSON.stringify(parityAfterStoredOpen.conflicts)}`);
        for (const entry of videos[1].score_ledger.entries) {
            assert.strictEqual(
                entry.available,
                true,
                `fixture coordinate ${entry.coordinate_id} must be available`
            );
            const rendered = await page.locator(
                `[data-embedding-asset="${channelId}:vid00000002"]`
                + `[data-coordinate-id="${entry.coordinate_id}"]`
            ).evaluateAll(nodes => nodes.map(node => ({
                value: node.getAttribute('data-coordinate-value'),
                percentile: node.getAttribute(
                    'data-coordinate-percentile-0-100'
                ),
                ledgerSha256: node.getAttribute(
                    'data-coordinate-ledger-sha256'
                ),
            })));
            assert(
                rendered.length >= 1,
                `score card omitted available coordinate ${entry.coordinate_id}`
            );
            assert(
                rendered.every(value => (
                    Number(value.value) === Number(entry.value)
                    && Number(value.percentile) === Number(entry.percentile)
                    && value.ledgerSha256
                        === videos[1].score_ledger.ledger_sha256
                )),
                `score card changed ${entry.coordinate_id}: ${
                    JSON.stringify(rendered)
                }`
            );
        }
        assert.strictEqual(
            await page.locator(
                '#rtg-exppanel [data-coordinate-unavailable]'
            ).count(),
            0,
            'a complete 21-coordinate ledger must not render a missing-value card'
        );
        const selectedTextKeepValues = await page.locator(`[data-embedding-asset="${channelId}:vid00000002"][data-embedding-id="shorts_raw:shorts.stored.text.keep:text_keep"]`).evaluateAll(nodes => nodes.map(node => ({
            estimate: node.getAttribute('data-embedding-est'),
            percentile: node.getAttribute('data-embedding-percentile'),
            sourceKey: node.getAttribute('data-embedding-source-key'),
        })));
        const selectedAssetCoordinates = await page.locator(
            `[data-embedding-asset="${channelId}:vid00000002"]`
        ).evaluateAll(nodes => nodes.map(node => ({
            id: node.getAttribute('data-embedding-id'),
            authority: node.getAttribute('data-embedding-authority'),
        })));
        assert(
            selectedTextKeepValues.length >= 2,
            'the selected Text.keep embedding must appear on both library '
                + 'and detail surfaces: '
                + JSON.stringify(selectedAssetCoordinates)
        );
        assert(selectedTextKeepValues.every(value =>
            value.estimate === String(videos[1].features['text.keep'][0])
            && value.percentile === String(videos[1].features['text.keep'][1])
            && value.sourceKey === 'text_keep'
        ), 'the same Text.keep asset must retain an identical raw estimate, percentile, and source key everywhere');
        await page.locator(`[data-savedchannelvideo="${channelId}:vid00000002"]`).click();
        assert.strictEqual(await page.evaluate(pathname => window.__fetchCounts[pathname], videoPath), 1, 'opening the same saved Short again must use the in-memory stored-artifact cache');

        for (const wrapperCase of [videos[2], videos[3]]) {
            await page.locator(
                `[data-savedchannelvideo="${channelId}:${wrapperCase.id}"]`
            ).click();
            const coordinate = page.locator(
                `#rtg-exppanel [data-embedding-asset="${channelId}:${wrapperCase.id}"]`
                + '[data-coordinate-id="shorts.stored.visual.keep"]'
            ).first();
            await coordinate.waitFor();
            assert.strictEqual(
                Number(await coordinate.getAttribute('data-coordinate-value')),
                wrapperCase.features['visual.keep'][0],
                'a missing or stale score_ledger_validation wrapper must not '
                    + 'replace a self-validated ledger coordinate with a dash'
            );
            assert.strictEqual(
                await page.evaluate(
                    pathname => window.__fetchCounts[pathname],
                    `/api/raw/saved-channel/${channelId}/video/${wrapperCase.id}`
                ),
                1,
                'wrapper diagnostic cases must open their persisted detail '
                    + 'once without re-embedding'
            );
        }

        await page.locator(`[data-savedchannelresume="${channelId}"]`).click();
        const resumePath = `/api/raw/saved-channel/${channelId}/resume`;
        await page.waitForFunction(pathname => window.__fetchCounts[pathname] === 1, resumePath);
        await page.getByText('Ledger', { exact: true }).click();
        await page.getByText('Canonical score ledger', { exact: true }).waitFor();
        assert.strictEqual(await page.getByText('LEDGER PARITY AUDIT PASSED', { exact: true }).count(), 1);
        assert.strictEqual(await page.locator('[data-savedledgercolumn]').count(), shortsCoordinateCount, 'the canonical ledger must expose all registered coordinates by default');
        assert.strictEqual(await page.locator('[data-savedledgercolumn="shorts.stored.text.keep"]').count(), 1);
        assert.strictEqual(await page.locator('[data-savedledgercolumn]').count(), shortsCoordinateCount, 'the full ledger must expose every active registered observed, stored, held-out, and forecast scalar');
        assert((await page.locator('[data-savedledger]').innerText()).includes(`${shortsCoordinateCount} columns are not ${shortsCoordinateCount} embedding spaces.`), 'the ledger must distinguish direct axes from derived values, forecasts, and observations');
        assert.strictEqual(await page.locator('[data-savedledgercolumn="shorts.visual-keep-forecast.v1"]').count(), 1, 'the frozen visual keep forecast must be one canonical ledger coordinate');
        assert((await page.locator('[data-savedledger]').innerText()).includes(`${directAxisColumnCount} direct-axis columns representing ${distinctDirectAxisCount} distinct fitted axes`), 'the ledger must distinguish direct-axis columns from distinct fits');
        assert((await page.locator('[data-savedledger]').innerText()).includes(`${compatibilityAliasCount} compatibility aliases outside the active row`), 'the ledger must disclose compatibility aliases without storing duplicate columns');
        assert((await page.locator('[data-savedledger]').innerText()).includes('A historical fit manifest that was never saved is labeled unknown'), 'the ledger must not infer missing historical fit populations');
        assert((await page.locator('[data-savedledger-row-provenance="vid00000001"]').innerText()).includes('fit manifest abcdef012345'), 'each saved row must expose its persisted artifact and fit-manifest identity');
        const rowManifest = page.locator('[data-savedledger-row-manifest="vid00000001"]').first();
        await rowManifest.locator('summary').click();
        assert((await rowManifest.innerText()).includes('raw/steer_models/by-sha256/0123456789abcdef.npz'), 'the complete per-row manifest must be touch-accessible instead of existing only in a hover tooltip');
        const hitProbabilityText = await page.locator('[data-savedledgercell$=":shorts.video-forecast.hit10M"]').first().innerText();
        assert(hitProbabilityText.includes('% probability'), `10M forecasts must display their continuous probability (rendered: ${hitProbabilityText})`);
        assert.strictEqual(await page.locator('[data-savedledger-provenance-matrix="shorts"] [data-savedledger-coordinate-select]').count(), shortsCoordinateCount, 'the provenance matrix must contain every active Shorts coordinate');
        assert.strictEqual(await page.locator('[data-savedledger-provenance-matrix="long"] [data-savedledger-coordinate-select]').count(), 21, 'the provenance matrix must disclose all 21 governed Long Quant scalar addresses');
        const valueScroller = page.locator('[data-savedledger-scroll="values"]');
        await valueScroller.evaluate(element => { element.scrollLeft = 480; element.scrollTop = 120; });
        const beforeCoordinateChange = await valueScroller.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
        await page.locator('[data-savedledgercolumn="shorts.stored.text.keep"] button').evaluate(button => button.click());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepStrictEqual(
            await page.locator('[data-savedledger-scroll="values"]').evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop })),
            beforeCoordinateChange,
            'changing the selected coordinate must preserve the value-table scroll position on mobile and desktop',
        );
        await page.locator('[data-savedledgercolumn="shorts.creator-excluded.visual.views"] button').evaluate(button => button.click());
        const lineagePanel = page.locator('[data-savedledger-provenance-drilldown]');
        await lineagePanel.waitFor();
        assert.strictEqual(await lineagePanel.getAttribute('data-coordinate-id'), 'shorts.creator-excluded.visual.views');
        assert.strictEqual(await lineagePanel.locator('[data-savedledger-lineage-step]').count(), 11, 'every selected coordinate must expose all lineage stages');
        const selectedLineageText = await lineagePanel.innerText();
        assert(selectedLineageText.includes('Shared creator-excluded public axis corpus'), 'the selected blind public axis must expose its shared fitting population');
        assert(selectedLineageText.includes('Creator-excluded public PLS + rank-to-outcome direction'), 'the selected blind public axis must expose its projection algorithm');
        assert(selectedLineageText.includes('Inverse Log10 Nonnegative'), 'the selected blind public axis must disclose its log-to-display-unit transform');
        assert(selectedLineageText.includes(fixtureSha256('population:visual-views')), 'the selected axis must expose the exact visual/views fit-population hash');
        assert.strictEqual(await lineagePanel.locator('[data-savedledger-recipe]').count(), 6, 'the selected coordinate must summarize query evidence, fitting evidence, rotation, scalar, revision, and display lineage');
        assert(/axis identity [a-f0-9]{64}/.test(selectedLineageText), 'the selected coordinate must expose its immutable axis fingerprint');
        assert(/coordinate identity [a-f0-9]{64}/.test(selectedLineageText), 'the selected coordinate must expose its immutable coordinate fingerprint');
        assert(!selectedLineageText.includes('Fit target\\nNot registered'), 'the target field must resolve in the drilldown');
        await page.locator('[data-savedledger-provenance-matrix="long"] [data-savedledger-coordinate-select="long.output.visual.realviews"]').evaluate(button => button.click());
        await page.waitForFunction(() => document.querySelector('[data-savedledger-provenance-drilldown]')?.getAttribute('data-coordinate-id') === 'long.output.visual.realviews');
        const longRealviewsLineageText = await page.locator('[data-savedledger-provenance-drilldown]').innerText();
        assert(longRealviewsLineageText.includes('Reference-row duration used while materializing the realviews map'), 'Long realistic views must distinguish reference duration from query inputs');
        assert(longRealviewsLineageText.includes('Candidate/query duration is not an input to channel_score()'), 'Long realistic views must explicitly say candidate duration is not read');
        assert(longRealviewsLineageText.includes('Long Tyler Private Performance'), 'Long realistic views must expose the private CTR/ret30/view-equation fit population');
        assert(longRealviewsLineageText.includes('Long Raw Manifold'), 'Long realistic views must expose the ID-aligned neighbor manifold');
        assert(longRealviewsLineageText.includes('Long Private Pls2 Axis'), 'Long realistic views must expose the upstream private PLS stage');
        assert(longRealviewsLineageText.includes('Long Realviews Equation'), 'Long realistic views must expose the upstream view equation');
        assert(longRealviewsLineageText.includes('Long Neighbor Placement'), 'Long realistic views must expose the neighbor-placement stage');
        const provenanceDownloadPromise = page.waitForEvent('download');
        await page.locator('[data-savedledger-provenance-export]').click();
        const provenanceDownload = await provenanceDownloadPromise;
        assert.strictEqual(provenanceDownload.suggestedFilename(), `${channelId}-complete-score-provenance.csv`);
        const provenanceCsv = fs.readFileSync(await provenanceDownload.path(), 'utf8');
        assert(provenanceCsv.includes('long.output.visual.realviews'), 'the provenance export must include Long Quant coordinate lineage');
        assert(provenanceCsv.includes('Candidate/query duration is not an input to channel_score()'), 'the provenance export must preserve input roles and query exclusions');
        assert(provenanceCsv.includes('dataset.shorts.map-manifold.v1'), 'the provenance export must distinguish visualization-map fit populations from scalar fits');
        assert(provenanceCsv.includes('axis_identity_sha256'), 'the provenance export must include the immutable fitted-axis identity');
        assert(provenanceCsv.includes('coordinate_identity_sha256'), 'the provenance export must include the evaluation-specific coordinate identity');
        assert((await page.locator('[data-savedledger]').innerText()).includes('Long Quant output provenance'), 'the registry summary must include the 21 governed Long Quant scalar addresses');
        const ledgerDownloadPromise = page.waitForEvent('download');
        await page.locator('[data-savedledgerexport]').click();
        const ledgerDownload = await ledgerDownloadPromise;
        assert.strictEqual(ledgerDownload.suggestedFilename(), `${channelId}-canonical-score-ledger.csv`);
        const ledgerCsv = fs.readFileSync(await ledgerDownload.path(), 'utf8');
        assert(ledgerCsv.includes('steer_artifact_archive_key'), 'the value ledger must export the immutable artifact archive key');
        assert(ledgerCsv.includes('steer_lineage_manifest_sha256'), 'the value ledger must export the exact fit-manifest hash');
        assert(ledgerCsv.includes('raw/steer_models/by-sha256/0123456789abcdef.npz'), 'the value ledger must preserve each row’s content-addressed model revision');
        if (process.env.EXPERIMENT_LAB_LEDGER_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_LEDGER_SCREENSHOT), { recursive: true });
            await page.locator('[data-savedledger]').screenshot({ path: process.env.EXPERIMENT_LAB_LEDGER_SCREENSHOT });
        }
        await page.locator('[data-savedledgercolumn="shorts.stored.text.ret5"] button').evaluate(button => button.click());
        assert.strictEqual(
            await page.locator('[data-savedledger]').getAttribute('data-selected-coordinate-id'),
            'shorts.stored.text.ret5',
            'ledger selection must use the shared canonical coordinate state'
        );
        await page.locator('[data-savedledger-open-visualization]').click();
        const canonicalValidation = page.locator('[data-savedvalidation-canonical]');
        await canonicalValidation.waitFor();
        const scoreCoordinateIds = new Set(
            coordinateRegistry.columns
                .filter(column => column.family !== 'observed'
                    && column.valueClass !== 'observed_outcome')
                .map(column => column.id)
        );
        const rankedEntries = (outcomeKey, mode = 'absolute') => validationArtifact.scopes.tyler.ledgerOutcomeMatrix[outcomeKey].coordinates
            .filter(entry => scoreCoordinateIds.has(entry.coordinateId))
            .map((entry, ledgerIndex) => ({
                entry,
                ledgerIndex,
                rho: entry.metrics && Number.isFinite(+entry.metrics.spearman)
                    ? +entry.metrics.spearman
                    : null,
            }))
            .sort((left, right) => {
                if (mode === 'ledger') return left.ledgerIndex - right.ledgerIndex;
                if ((left.rho != null) !== (right.rho != null)) return left.rho != null ? -1 : 1;
                if (left.rho == null) return left.ledgerIndex - right.ledgerIndex;
                const leftValue = mode === 'absolute' ? Math.abs(left.rho) : left.rho;
                const rightValue = mode === 'absolute' ? Math.abs(right.rho) : right.rho;
                return (mode === 'negative' ? leftValue - rightValue : rightValue - leftValue)
                    || left.ledgerIndex - right.ledgerIndex;
            });
        const topKeepEntry = rankedEntries('keep')[0].entry;
        assert.strictEqual(await canonicalValidation.getAttribute('data-coordinate-count'), String(shortsCoordinateCount));
        assert.strictEqual(await canonicalValidation.getAttribute('data-score-coordinate-count'), String(scoreCoordinateCount));
        assert.strictEqual(await canonicalValidation.getAttribute('data-outcome-count'), String(observedOutcomeCount));
        assert.strictEqual(await canonicalValidation.getAttribute('data-coordinate-order'), 'absolute');
        assert.strictEqual(await page.getByText('Ledger visualization', { exact: true }).count(), 1);
        assert((await page.locator('[data-savedvalidation-ledger-classification]').innerText()).includes(ledgerClassificationText));
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker] option').count(), scoreCoordinateCount, 'the Y-axis picker must expose every non-outcome score coordinate exactly once');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker] option[value^="shorts.observed."]').count(), 0, 'observed truth must never appear in the score-axis picker');
        assert.strictEqual(await page.locator('[data-savedvalidation-outcome-picker] option').count(), observedOutcomeCount, 'the visualization picker must expose every measured outcome');
        assert.strictEqual(await page.locator('[data-savedvalidation-ledger-navigator] [data-axis-role="score"]').count(), 1, 'the score axis must be explicit');
        assert.strictEqual(await page.locator('[data-savedvalidation-ledger-navigator] [data-axis-role="observed"]').count(), 1, 'the observed axis must be explicit');
        assert.strictEqual(await page.locator('[data-savedvalidation-ledger-navigator] [data-axis-role="order"]').count(), 1, 'the selected outcome must expose a coordinate ordering control');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-order]').inputValue(), 'absolute');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker] option').first().getAttribute('value'), topKeepEntry.coordinateId, 'default Y-axis order must rank strongest absolute raw Spearman relationship first');
        assert.strictEqual(+await page.locator('[data-savedvalidation-coordinate-picker] option').first().getAttribute('data-correlation'), +topKeepEntry.metrics.spearman);
        assert.strictEqual(await page.locator('[data-savedvalidation-correlation-ranking]').getAttribute('data-outcome'), 'keep');
        assert.strictEqual(await page.locator('[data-savedvalidation-ranked-coordinate]').count(), Math.min(10, rankedEntries('keep').filter(item => item.rho != null).length));
        assert.strictEqual(await page.locator('[data-savedvalidation-ranked-coordinate]').first().getAttribute('data-savedvalidation-ranked-coordinate'), topKeepEntry.coordinateId);
        assert(await page.locator('[data-savedvalidation-ledger-navigator]').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'the canonical coordinate/outcome navigator must fit its mobile parent');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker]').inputValue(), 'shorts.stored.text.ret5', 'the coordinate selected in the ledger must remain selected in Visualization');
        assert.strictEqual(await page.locator('[data-savedcreatorkeep-study]').count(), 0, 'one-off creator keep panels must not duplicate the canonical inspector');
        assert.strictEqual(await page.locator('[data-savedvisualkeep-study]').count(), 0, 'one-off visual keep panels must not duplicate the canonical inspector');
        assert.strictEqual(await page.locator('[data-savedvalidationview]').count(), 5, 'the visualization must organize evidence into five focused panes');
        assert.strictEqual(await page.locator('[data-savedvalidation-view-content]').getAttribute('data-savedvalidation-view-content'), 'relationship');
        assert.strictEqual(await page.locator('[data-savedvalidation-pane="relationship"]').count(), 1);
        const initialRelationshipEntry = validationArtifact.scopes.tyler.ledgerOutcomeMatrix.keep.coordinates.find(entry => entry.coordinateId === 'shorts.stored.text.ret5');
        assert.strictEqual(
            await page.locator('[data-savedvalidation-scatter] circle[data-savedvalidationrow]').count(),
            initialRelationshipEntry.coverage.pairedRows,
            'the relationship plot must render every paired validation video'
        );
        await page.locator('[data-savedvalidationview="atlas"]').click();
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').count(), scoreCoordinateCount, 'the atlas must contain score interpretations only');
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').first().getAttribute('data-savedvalidationfeature'), topKeepEntry.coordinateId, 'atlas rows must share the selected outcome-aware ordering');
        assert.strictEqual(await page.getByText(`All ${scoreCoordinateCount} score interpretations × all ${observedOutcomeCount} raw observed metrics`, { exact: true }).count(), 1);
        assert.strictEqual(await page.locator('[data-savedvalidationcell]').count(), scoreCoordinateCount * observedOutcomeCount, 'every score interpretation must be compared with every independently selected observed metric');
        assert.strictEqual(await page.locator('[data-savedvalidationfeature^="shorts.observed."]').count(), 0, 'raw outcomes belong exclusively to the X axis');
        await page.locator('[data-savedvalidationview="method"]').click();
        await page.locator('[data-savedvalidation-pane="method"] details').filter({ hasText: 'Terms used in this analysis' }).locator(':scope > summary').click();
        for (const term of ['Stored', 'Video held out', 'Account held out', 'Direct axis', 'Derived score', 'Forecast', 'Prequential next upload', 'Compatibility alias', 'Observed outcome', 'Prediction R²', 'MAE / factor error', 'Global exploratory q']) {
            assert.strictEqual(await page.getByText(term, { exact: true }).count(), 1, `plain-English glossary is missing ${term}`);
        }
        await page.locator('[data-savedvalidationview="atlas"]').click();
        await page.locator('[data-savedvalidationfamily="strict"]').click();
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').count(), heldoutClassification.columns, 'held-out predictor filter must exclude research-only coordinates');
        await page.locator('[data-savedvalidationfamily="all"]').click();
        await page.locator('[data-savedvalidationview="relationship"]').click();
        await page.locator('[data-savedvalidation-selected]').waitFor();
        await page.locator('[data-savedvalidation-selected-explanation] > summary').click();
        const selectedTextRet5 = await page.locator('[data-savedvalidation-selected]').innerText();
        assert(selectedTextRet5.includes('shorts.stored.text.ret5'));
        assert(selectedTextRet5.includes('Text input only'));
        assert(selectedTextRet5.includes('Five-second retention score'));
        const relationshipScatter = page.locator('[data-savedvalidation-scatter]');
        assert.strictEqual(await relationshipScatter.getAttribute('data-plot-mode'), 'raw');
        assert(/Raw .*5s retention.* vs observed Stayed to watch/.test(
            await relationshipScatter.innerText()
        ));
        assert.strictEqual(await relationshipScatter.getAttribute('data-score-axis'), 'shorts.stored.text.ret5');
        assert.strictEqual(await relationshipScatter.getAttribute('data-observed-axis'), 'shorts.observed.keep');
        assert((await relationshipScatter.innerText()).includes('no chart-specific fit or cross-outcome estimator is created'));
        assert((await relationshipScatter.innerText()).includes('Raw relationship only'));
        const crossTargetPoint = relationshipScatter.locator('circle[data-savedvalidationrow="vid00000002"]').first();
        const crossTargetTooltip = await crossTargetPoint.locator('title').textContent();
        assert(crossTargetTooltip.includes('Y · score ledger shorts.stored.text.ret5:'), 'cross-target hover must name the plotted score coordinate');
        assert(crossTargetTooltip.includes('X · raw observed shorts.observed.keep:'), 'hover must name the independent measured outcome');
        await crossTargetPoint.dispatchEvent('click');
        const crossTargetDetail = page.locator('[data-savedvalidation-point-detail]');
        await crossTargetDetail.waitFor();
        assert((await crossTargetDetail.innerText()).includes('shorts.stored.text.ret5'));
        assert((await crossTargetDetail.innerText()).includes('shorts.observed.keep'));
        assert((await crossTargetDetail.innerText()).includes('saved score + private outcomes'));
        assert.strictEqual(await page.locator('[data-savedvalidation-scatter]').getAttribute('data-plot-mode'), 'raw');
        assert((await page.locator('[data-savedvalidation-scatter]').innerText()).includes('no chart-specific fit or cross-outcome estimator is created'));
        assert.strictEqual(
            await page.locator(
                '[data-savedvalidation-scatter] [data-savedvalidationplotmode="prediction"]'
            ).count(),
            0,
            'a cross-target pairing must not expose a prediction toggle'
        );
        const associationEntry = validationArtifact.scopes.tyler.ledgerOutcomeMatrix.keep.coordinates.find(entry => entry.coordinateId === 'shorts.stored.text.ret5');
        await page.locator('[data-savedvalidationview="accuracy"]').click();
        await page.locator('[data-savedvalidation-statistics] > summary').click();
        assert.strictEqual(await page.locator('[data-savedvalidation-metric]').count(), Object.keys(associationEntry.metrics).length, 'the inspector must render every metric registered for an association-only pair');
        assert((await page.locator('[data-savedvalidation-error-distribution]').innerText()).includes('association-only'));
        assert.strictEqual(await page.locator('[data-savedvalidation-error-cdf]').count(), 0, 'association-only pairs must not invent a prediction-error curve');
        await page.locator('[data-savedvalidation-outcome-picker]').selectOption('views');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker]').inputValue(), 'shorts.stored.text.ret5', 'changing outcomes must never silently change the selected coordinate');
        const topViewsEntry = rankedEntries('views')[0].entry;
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker] option').first().getAttribute('value'), topViewsEntry.coordinateId, 'changing the measured outcome must rerank coordinates against that outcome');
        assert.strictEqual(await page.locator('[data-savedvalidation-correlation-ranking]').getAttribute('data-outcome'), 'views');
        await page.locator('[data-savedvalidation-coordinate-order]').selectOption('positive');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker] option').first().getAttribute('value'), rankedEntries('views', 'positive')[0].entry.coordinateId, 'positive mode must sort signed rho descending');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker]').inputValue(), 'shorts.stored.text.ret5', 'reordering must preserve the chosen coordinate');
        await page.locator('[data-savedvalidation-coordinate-order]').selectOption('negative');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker] option').first().getAttribute('value'), rankedEntries('views', 'negative')[0].entry.coordinateId, 'inverse mode must sort signed rho ascending');
        await page.locator('[data-savedvalidation-coordinate-order]').selectOption('ledger');
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker] option').first().getAttribute('value'), rankedEntries('views', 'ledger')[0].entry.coordinateId, 'ledger mode must restore canonical registry order');
        await page.locator('[data-savedvalidation-coordinate-order]').selectOption('absolute');
        const topRankedButton = page.locator('[data-savedvalidation-ranked-coordinate]').first();
        const topRankedCoordinate = await topRankedButton.getAttribute('data-savedvalidation-ranked-coordinate');
        await topRankedButton.click();
        assert.strictEqual(await page.locator('[data-savedvalidation-coordinate-picker]').inputValue(), topRankedCoordinate, 'ranked quick picks must select the exact ledger coordinate');
        assert.strictEqual(await page.locator('[data-savedvalidation-outcome-picker]').inputValue(), 'views', 'ranked quick picks must preserve the measured outcome');
        await page.locator('[data-savedvalidation-coordinate-picker]').selectOption('shorts.video-forecast.views');
        const nativePredictionEntry = validationArtifact.scopes.tyler.ledgerOutcomeMatrix.views.coordinates.find(entry => entry.coordinateId === 'shorts.video-forecast.views');
        assert(nativePredictionEntry && nativePredictionEntry.evaluation, 'fixture must contain a native registered held-out views prediction');
        await page.locator('[data-savedvalidationview="relationship"]').click();
        assert.strictEqual(await page.locator('[data-savedvalidation-scatter]').getAttribute('data-plot-mode'), 'raw', 'Relationship must preserve the selected raw score axis even for native predictions');
        assert.strictEqual(await page.locator('[data-savedvalidation-scatter] circle[data-savedvalidationrow]').count(), nativePredictionEntry.coverage.pairedRows, 'the native relationship plot must include every registered paired row');
        await page.locator('[data-savedvalidationview="accuracy"]').click();
        assert.strictEqual(await page.locator('[data-savedvalidation-scatter]').getAttribute('data-plot-mode'), 'prediction', 'Accuracy must render the registered native prediction separately');
        await page.locator('[data-savedvalidation-statistics] > summary').click();
        await page.locator('[data-savedvalidation-account-breakdown] > summary').click();
        assert.strictEqual(await page.locator('[data-savedvalidation-metric]').count(), Object.keys(nativePredictionEntry.metrics).length, 'the native inspector must render the complete registered metric schema');
        const nativeErrorDistributionText = await page.locator('[data-savedvalidation-error-distribution]').innerText();
        assert(/median miss/i.test(nativeErrorDistributionText), nativeErrorDistributionText);
        assert(/no Gaussian distribution/i.test(nativeErrorDistributionText), 'the empirical frequency chart must not imply Gaussian errors');
        assert.strictEqual(await page.locator('[data-savedvalidation-error-density]').count(), 1, 'every native prediction must show the empirical miss-frequency plot');
        assert.strictEqual(await page.locator('[data-savedvalidation-error-density]').getAttribute('data-residual-scale'), 'log10(value+1)', 'views residuals must use the same log10(value + 1) scale as the registered model');
        assert.strictEqual(await page.locator('[data-savedvalidation-error-density]').getAttribute('data-residual-sign'), 'predicted-minus-observed');
        assert(await page.locator('[data-savedvalidation-error-coverage]').count() >= 7, 'every native prediction must expose a full threshold-coverage ladder');
        assert.strictEqual(await page.locator('[data-savedvalidation-error-cdf]').count(), 1, 'every native prediction must visualize its empirical error CDF');
        assert.strictEqual(await page.locator('[data-savedvalidation-error-cdf]').getAttribute('data-curve'), 'empirical-step');
        assert.strictEqual(await page.locator('[data-savedvalidation-error-cdf]').getAttribute('data-axis-scale'), 'log10-factor');
        assert.notStrictEqual((await page.locator('[data-savedvalidation-metric="evidence"]').innerText()).trim(), '—', 'the categorical evidence verdict must remain visible rather than being treated as a missing number');
        assert.strictEqual(await page.locator('[data-savedvalidation-evidence-json]').count(), 1, 'every selected relationship must expose its complete registered record');
        assert((await page.locator('[data-savedvalidation-account-metrics]').innerText()).includes('Per-creator validation'));
        await page.locator('[data-savedvalidation-account-breakdown] > summary').click();
        await page.locator('[data-savedvalidation-statistics] > summary').click();
        if (process.env.EXPERIMENT_LAB_ACCURACY_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_ACCURACY_SCREENSHOT), { recursive: true });
            await page.locator('[data-savedvalidation-view-tabs]').evaluate(element => element.scrollIntoView({ block: 'start' }));
            await page.screenshot({ path: process.env.EXPERIMENT_LAB_ACCURACY_SCREENSHOT, fullPage: false });
        }
        if (process.env.EXPERIMENT_LAB_ACCURACY_DESKTOP_SCREENSHOT) {
            await page.setViewportSize({ width: 1280, height: 820 });
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_ACCURACY_DESKTOP_SCREENSHOT), { recursive: true });
            await page.locator('[data-savedvalidation-view-tabs]').evaluate(element => element.scrollIntoView({ block: 'start' }));
            await page.screenshot({ path: process.env.EXPERIMENT_LAB_ACCURACY_DESKTOP_SCREENSHOT, fullPage: false });
            await page.setViewportSize({ width: 390, height: 844 });
        }
        await page.locator('[data-savedvalidation-outcome-picker]').selectOption('keep');
        await page.locator('[data-savedvalidation-coordinate-picker]').selectOption('shorts.creator-prequential-forecast.keep');
        await page.locator('[data-savedvalidationview="atlas"]').click();
        const creatorResearchCell = page.locator('[data-savedvalidationcell][data-savedvalidationcoordinate="shorts.creator-prequential-forecast.keep"][data-savedvalidationoutcome="keep"]');
        assert((await creatorResearchCell.innerText()).includes('RESEARCH ONLY'), 'research-only coordinates must retain their metrics while remaining visibly unpromoted');
        await page.locator('[data-savedvalidationview="videos"]').click();
        const creatorVideoTableText = await page.locator('[data-savedvalidation-video-table]').innerText();
        assert(creatorVideoTableText.includes('History-only baseline'));
        assert(creatorVideoTableText.includes('Incremental absolute-error value'));
        assert(creatorVideoTableText.includes('66.0%'), 'creator validation rows must expose the exact matched history baseline');
        await page.locator('[data-savedvalidationview="accuracy"]').click();
        assert(/p90 miss/i.test(await page.locator('[data-savedvalidation-error-distribution]').innerText()), 'the winning prequential coordinate must use the same generic error-distribution component as every other prediction');
        await page.locator('[data-savedvalidation-open-ledger]').click();
        await page.locator('[data-savedledger]').waitFor();
        assert.strictEqual(await page.locator('[data-savedledger]').getAttribute('data-selected-coordinate-id'), 'shorts.creator-prequential-forecast.keep', 'Visualization must round-trip the exact coordinate back into the ledger');
        await page.locator('[data-savedledger-open-visualization]').click();
        await page.locator('[data-savedvalidation-coordinate-picker]').selectOption('shorts.visual-keep-forecast.v1');
        await page.locator('[data-savedvalidation-outcome-picker]').selectOption('keep');
        if (process.env.EXPERIMENT_LAB_VISUALIZATION_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_VISUALIZATION_SCREENSHOT), { recursive: true });
            await page.locator('[data-savedvalidation-ledger-navigator]').evaluate(element => element.scrollIntoView({ block: 'start' }));
            await page.screenshot({ path: process.env.EXPERIMENT_LAB_VISUALIZATION_SCREENSHOT, fullPage: false });
        }
        await page.locator('[data-savedvalidationview="method"]').click();
        const lineageDetails = page.locator('[data-savedvalidation-pane="method"] details').first();
        const validationLineageText = await lineageDetails.innerText();
        for (const stage of ['Raw inputs', 'Representation', 'Fit dataset', 'Fit target', 'Algorithm / rotation', 'Calibration', 'Validation / holdout', 'Frozen artifact']) {
            assert(validationLineageText.includes(stage), `canonical coordinate lineage is missing ${stage}`);
        }
        await page.locator('[data-savedvalidationview="atlas"]').click();
        assert.strictEqual(
            await page.locator('[data-savedvalidationfamily="outcome"]').count(),
            0,
            'raw outcomes must be isolated to the observed axis instead of masquerading as score coordinates'
        );
        await page.locator('[data-savedvalidationview="relationship"]').click();
        const frozenVisualPoint = page.locator('[data-savedvalidation-scatter] circle[data-savedvalidationrow="vid00000002"]').first();
        await frozenVisualPoint.evaluate(element => element.scrollIntoView({ block: 'center' }));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const visualKeepTooltip = await frozenVisualPoint.locator('title').textContent();
        assert(visualKeepTooltip.includes('Y · score ledger shorts.visual-keep-forecast.v1:'), 'the generic inspector point must name the selected canonical score axis');
        const visualKeepHitAudit = await frozenVisualPoint.evaluate(node => {
            const rect = node.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return {
                direct: hit === node,
                rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                hitTag: hit && hit.tagName,
                hitClass: hit && hit.className && String(hit.className),
            };
        });
        assert(visualKeepHitAudit.direct, `the selected mobile validation point must be physically hit-testable: ${JSON.stringify(visualKeepHitAudit)}`);
        const visualKeepVideoId = String(await frozenVisualPoint.getAttribute('data-savedvalidationrow'));
        const visualKeepVideo = videos.find(video => video.id === visualKeepVideoId);
        assert(visualKeepVideo, 'the clickable validation point must resolve to its saved-video fixture');
        await frozenVisualPoint.click({ force: true });
        const visualKeepPointDetail = page.locator('[data-savedvalidation-point-detail]');
        await visualKeepPointDetail.waitFor();
        const visualKeepPointText = await visualKeepPointDetail.innerText();
        assert(visualKeepPointText.includes('shorts.visual-keep-forecast.v1'));
        assert(visualKeepPointText.includes('shorts.observed.keep'));
        await visualKeepPointDetail.locator('button[data-savedchannelvideo-embedding="visual:keep"]').click();
        await page.locator('[data-rawproj="keep"]').waitFor();
        assert.strictEqual(
            await page.getByText('Predictor lab', { exact: true }).count(),
            1,
            'Experiment Lab must not hide a canonical Shorts Quant raw-view control'
        );
        for (const signal of ['concat', 'visual', 'together', 'text']) {
            const rawMapForecast = page.locator(
                `[data-channel-free-raw-map-value="${signal}"]`
            );
            await rawMapForecast.waitFor();
            const rawMapForecastText = await rawMapForecast.innerText();
            assert(
                rawMapForecastText.includes(
                    `${visualKeepVideo.channel_free_keep_forecasts.outputs[signal].raw.toFixed(1)}%`
                ),
                `opening normal geometry must preserve the ${signal} channel-free value`
            );
            assert(
                rawMapForecastText.includes(
                    `shorts.channel-free.${signal}.keep`
                ),
                `normal geometry must name the ${signal} channel-free coordinate`
            );
        }
        const selectedRawMapPoint = page.locator(
            `circle[data-rawid="${visualKeepVideoId}"]`
        );
        assert.strictEqual(
            await selectedRawMapPoint.count(),
            1,
            'the selected saved Short must resolve to its existing point on '
                + 'the normal visual keep map without creating an upload copy'
        );
        assert.strictEqual(
            await selectedRawMapPoint.getAttribute('stroke'),
            '#fff',
            'the exact existing map point must be visibly selected'
        );
        assert.strictEqual(await page.evaluate(pathname => window.__fetchCounts[pathname], videoPath), 1, 'validation inspection must reuse the cached stored score artifact');
        assert.strictEqual(await page.evaluate(() => window.__fetchCounts['/api/raw/embed-montage'] || 0), explicitRescoreEmbedCount, 'opening the normal embedding must reuse the stored vector and never re-embed');
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 390, scroll: 390 });
        if (await page.locator('[data-experiment-raw-back]').count()) {
            await page.locator('[data-experiment-raw-back]').click();
        }
        const canonicalControlSignature = async () => page.evaluate(() => {
            const surface = document.querySelector(
                '[data-shorts-experiment-renderer]'
            );
            if (!surface) return null;
            return Array.from(surface.querySelectorAll('*'))
                .flatMap(element => Array.from(element.attributes)
                    .filter(attribute => attribute.name.startsWith('data-'))
                    .filter(attribute => attribute.name !== 'data-savedbank')
                    .filter(attribute => !attribute.name.startsWith('data-lab'))
                    .map(attribute =>
                        `${attribute.name}=${attribute.value}`
                    ))
                .sort();
        });
        await page.evaluate(() => {
            BuildingRegistry.get('Experiment Lab').close();
            const host = document.getElementById('root');
            host.innerHTML = '';
            BuildingRegistry.get('Experiment Lab').open(host);
        });
        await page.locator(
            '[data-shorts-experiment-renderer="shorts-quant-experiment-surface-v1"]'
        ).waitFor();
        await page.locator(
            '.experiment-lab-tab[data-lab-view="hooks"]'
        ).click();
        await page.locator(`[data-savedopen="${historicalSavedHookId}"]`).waitFor();
        const labControlSignature = await canonicalControlSignature();
        const labCanonicalColor = await page.locator(
            '[data-shorts-experiment-renderer]'
        ).evaluate(element => getComputedStyle(element).color);
        assert.strictEqual(
            await page.locator('[data-savedbank="channels"]').count(),
            0,
            'Experiment Lab must remain free of Saved Channels after remount'
        );
        await page.evaluate(async () => {
            BuildingRegistry.get('Experiment Lab').close();
            const host = document.getElementById('root');
            host.innerHTML = '';
            await window.JarvisRetention.mountShortsExperiment(
                host,
                { surface: 'jarvis' }
            );
        });
        await page.locator(
            '[data-shorts-experiment-renderer="shorts-quant-experiment-surface-v1"]'
        ).waitFor();
        await page.locator(`[data-savedopen="${historicalSavedHookId}"]`).waitFor();
        const jarvisControlSignature = await canonicalControlSignature();
        const jarvisCanonicalColor = await page.locator(
            '[data-shorts-experiment-renderer]'
        ).evaluate(element => getComputedStyle(element).color);
        assert.strictEqual(
            await page.locator('[data-savedbank="channels"]').count(),
            1,
            'Jarvis must retain its Saved Channels research tab'
        );
        assert.deepStrictEqual(
            labControlSignature,
            jarvisControlSignature,
            'Experiment Lab and Shorts Quant must expose the same canonical '
                + 'creation, scoring, and private-hook controls after filtering '
                + 'the intentional Lab navigation policy'
        );
        assert.notStrictEqual(
            labCanonicalColor,
            jarvisCanonicalColor,
            'Experiment Lab must be allowed to present the shared engine in its '
                + 'own light product language without changing its behavior'
        );
        const finalParity = await page.evaluate(() => window.BusinessWorldEmbeddingParityAudit(document));
        assert(finalParity.ok, `final rendered embedding parity failed: ${JSON.stringify(finalParity.conflicts)}`);
        console.log(JSON.stringify({ ok: true, sharedExperimentControls: labControlSignature.length, coreControlParity: true, labSavedChannels: false, jarvisSavedChannels: true, desktopWidth: 1280, mobileWidth: 390, mobileScrollTop, storedImage: true, exactIndicatorSort: 'text.keep', savedArtifactFetches: 1, resumeRequests: 1, ledgerCoordinates: shortsCoordinateCount, scoreCoordinates: scoreCoordinateCount, observedOutcomes: observedOutcomeCount, visualizedRelationshipCells: scoreCoordinateCount * observedOutcomeCount, embeddingParity: finalParity }));
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
