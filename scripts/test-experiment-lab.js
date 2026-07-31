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
    const featureContract = JSON.parse(fs.readFileSync(path.join(ROOT, 'buildings/jarvis/saved-channel-feature-contract.json'), 'utf8'));
    const featureContractSha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, 'buildings/jarvis/saved-channel-feature-contract.json')))
        .digest('hex');
    const fixtureSha256 = label => crypto.createHash('sha256').update(`experiment-lab:${label}`).digest('hex');
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

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
        page.on('pageerror', error => console.error('PAGE ERROR:', error.stack || error.message));
        page.on('console', message => { if (message.type() === 'error') console.error('BROWSER ERROR:', message.text()); });
        page.on('requestfailed', request => console.error('REQUEST FAILED:', request.url(), request.failure() && request.failure().errorText));
        await page.route('**/api/raw/saved-channel/**/montage/**', route => route.fulfill({
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
                        FEATURE_CONTRACT_SHA256,
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
                        FEATURE_CONTRACT_SHA256,
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
        assert.deepStrictEqual(
            shortsScoreLedger.validateScoreLedger(
                historicalSavedHookRecord.score_ledger
            ).errors,
            [
                'score ledger feature contract document hash does not match',
            ],
            'historical browser fixture must differ only by the '
                + 'superseded feature-contract document hash'
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
        const replies = {
            '/api/retention/channels': { channels: [], active: 'tyler' },
            '/api/indicators/registry': { indicators: [], meta: { targets: [] } },
            '/api/raw/saved-hooks': {
                hooks: [historicalSavedHookRow],
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
            '/api/raw/saved-channels': { channels: [{ id: channelId, name: 'Mobile Risk Channel', url: 'https://youtube.com/@risk', status: 'partial', discovered: 21, completed: 20, failed: 1 }], featureContract },
            [`/api/raw/saved-channel/${channelId}`]: { id: channelId, name: 'Mobile Risk Channel', url: 'https://youtube.com/@risk', status: 'partial', discovered: 21, completed: 20, failed: 1, queued: 0, videos: videos.concat(unfinishedVideo), featureContract },
            [`/api/raw/saved-channel/${channelId}/analysis`]: riskAnalysis,
            '/api/raw/saved-channel-validation': validationArtifact,
            '/api/raw/scorer-contract': {
                schema: 'shorts-live-score-contract-v2',
                revision_fingerprint:
                    fixtureSha256('current-live-revision'),
                feature_contract_sha256:
                    FEATURE_CONTRACT_SHA256,
                coordinates: {
                    visual_keep_forecast:
                        coordinateGovernance.coordinates
                            .visualKeepForecast.id,
                    creator_adaptive_keep_forecast:
                        coordinateGovernance.coordinates
                            .creatorAdaptiveKeepForecast.id,
                },
                visual_keep_model_artifact_sha256:
                    fixtureSha256('visual-keep-model'),
                visual_keep_model_manifest_sha256:
                    fixtureSha256('visual-keep-model-manifest'),
                creator_model_artifact_sha256: fixtureSha256('creator-adaptive-keep-model'),
                creator_serving_artifact_sha256: fixtureSha256('creator-adaptive-keep-serving'),
                creator_profiles: ['tyler', 'hafu'],
            },
            '/api/raw/map': rawVisualMap,
            [`/api/raw/saved-channel/${channelId}/resume`]: { ok: true },
            '/api/hooks/grind/runs': { runs: [] },
            '/api/hooks/warmup': { ok: true, fired: false },
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
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><base href="${ORIGIN}/"><link rel="stylesheet" href="/buildings/experimentlab/experimentlab.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#080d14}</style></head><body><main id="root"></main>
<script>Object.defineProperty(globalThis,"__SHORTS_SCORE_LEDGER_RUNTIME__",{value:${JSON.stringify(shortsScoreLedgerRuntime)},writable:false,configurable:false});</script>
<script src="/buildings/building-registry.js"></script><script src="/buildings/jarvis/jarvis-upload-utils.js"></script>
<script>
const nativeFetch=window.fetch.bind(window);
const replies=${JSON.stringify(replies)};
window.__historicalTamperFixtures=${
    JSON.stringify(historicalTamperFixtures)
};
window.__fetchCounts={};
window.fetch=function(url,options){
    const p=new URL(url,location.href).pathname;
    window.__fetchCounts[p]=(window.__fetchCounts[p]||0)+1;
    if(p.includes('/api/raw/saved-channel/')&&p.includes('/montage/')){
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
        if(p==='${
            `/api/raw/saved-hook/${historicalSavedHookId}`
        }'){
            return new Promise(resolve=>setTimeout(
                ()=>resolve(response()),
                120
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
    return nativeFetch(url,options);
};
</script>
<script src="/buildings/jarvis/jarvis-retention.js"></script><script src="/buildings/experimentlab/experimentlab-ui.js"></script><script>BuildingRegistry.get('Experiment Lab').open(document.getElementById('root'));</script></body></html>`, { waitUntil: 'networkidle' });

        await page.getByRole('heading', { name: 'Experiment Lab' }).waitFor();
        try {
            await page.getByPlaceholder('type a video idea — or leave blank and the model invents one…').waitFor();
        } catch (error) {
            console.error('INITIAL ROOT:', (await page.locator('#root').innerText()).slice(0, 1500));
            throw error;
        }
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
        await historicalSavedHookCard.click();
        await page.locator(
            '[data-saved-detail-state="loading"]'
        ).waitFor();
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
        await page.locator(
            '[data-saved-detail-state="historical-read-only"]'
        ).waitFor();
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
        await page.locator('[data-savedbank="channels"]').click();
        assert.strictEqual(await page.getByPlaceholder('type a video idea — or leave blank and the model invents one…').count(), 1);
        assert.strictEqual(await page.getByPlaceholder("the hook you're writing — every variant stays grounded on this…").count(), 1);
        assert.strictEqual(await page.getByPlaceholder('or paste a YouTube link…').count(), 1);
        assert.strictEqual(await page.getByPlaceholder('https://youtube.com/@channel').count(), 1);
        assert.strictEqual(await page.getByText('Save channel + score every Short', { exact: true }).count(), 1);
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 1280, scroll: 1280 });

        await page.setViewportSize({ width: 390, height: 844 });
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 390, scroll: 390 });
        const workspace = page.locator('.experiment-lab-workspace');
        const scrollState = await workspace.evaluate(element => ({ overflowY: getComputedStyle(element).overflowY, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, top: element.scrollTop }));
        assert.strictEqual(scrollState.overflowY, 'auto', 'the lab workspace must own vertical scrolling');
        assert(scrollState.scrollHeight > scrollState.clientHeight, 'mobile workspace should contain enough content to scroll');
        await workspace.evaluate(element => { element.scrollTop = element.scrollHeight; });
        assert((await workspace.evaluate(element => element.scrollTop)) > 0, 'mobile Experiment Lab must scroll independently of the hidden page body');
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
        assert.strictEqual(await page.evaluate(() => window.__fetchCounts['/api/raw/embed-montage'] || 0), 0, 'opening a saved scored Short must not invoke the embedding endpoint');
        try {
            await page.locator(
                '#rtg-exppanel [data-visual-keep-forecast]'
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
                'All 18 registered channel coordinates'
            ),
            `stored score must open the complete graph read-out: ${
                storedPanelText.slice(0, 500)
            }`
        );
        await page.getByText(
            '21 stored score coordinates + 2 derived keep forecasts',
            { exact: true }
        ).waitFor();
        const storedVisualForecast = page.locator('[data-visual-keep-forecast]');
        await storedVisualForecast.waitFor();
        const storedVisualForecastText =
            await storedVisualForecast.innerText();
        assert(
            storedVisualForecastText.includes(
                `${videos[1].visual_keep_forecast.raw.toFixed(1)}%`
            ),
            'the ordinary stored score card must show the exact frozen visual '
                + `raw value: ${storedVisualForecastText}`
        );
        assert((await storedVisualForecast.innerText()).includes('shorts.visual-keep-forecast.v1'), 'the ordinary score card must name the canonical ledger coordinate');
        const storedCreatorForecast = page.locator('[data-creator-adaptive-keep-forecast]');
        await storedCreatorForecast.waitFor();
        const storedCreatorForecastText = await storedCreatorForecast.innerText();
        assert(
            storedCreatorForecastText.includes(
                `${videos[1].creator_adaptive_keep_forecast.raw.toFixed(1)}%`
            ),
            'the ordinary stored score card must show the exact '
                + `creator-adaptive raw value: ${storedCreatorForecastText}`
        );
        assert(storedCreatorForecastText.includes(`${videos[1].creator_adaptive_keep_forecast.history_only_baseline.toFixed(1)}%`), 'the ordinary stored score card must show the matched history-only baseline');
        assert(/research only.*not predictor-eligible/i.test(storedCreatorForecastText), 'the ordinary score card must identify the ineligible coordinate as research only');
        assert(storedCreatorForecastText.includes('shorts.creator-adaptive-keep.v1'), 'the ordinary score card must name the creator-adaptive ledger coordinate');
        assert(storedCreatorForecastText.includes('canonical visual embedding + canonical together'), 'the derived scalar must disclose both multimodal embedding inputs');
        assert(storedCreatorForecastText.includes('43,360 prespecified time-ordered candidates'), 'the stored card must disclose the frozen schema-3 registry size');
        assert.strictEqual(await storedCreatorForecast.getAttribute('data-revision-status'), 'current', 'the creator forecast must prove its live model and scorer revisions match');
        assert(/future-upload research forecast/i.test(storedCreatorForecastText), 'an arbitrary historical open must not be mislabeled as a blind prequential replay');
        assert.strictEqual(await storedCreatorForecast.locator('[data-expgo="visual:keep"]').count(), 1, 'the multimodal scalar must expose its visual source plane');
        assert.strictEqual(await storedCreatorForecast.locator('[data-expgo="together:keep"]').count(), 1, 'the multimodal scalar must expose its together source plane');
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
        await page.getByText('Score ledger', { exact: true }).click();
        await page.getByText('Canonical score ledger', { exact: true }).waitFor();
        assert.strictEqual(await page.getByText('LEDGER PARITY AUDIT PASSED', { exact: true }).count(), 1);
        assert.strictEqual(await page.locator('[data-savedledgercolumn]').count(), 21, 'the default ledger family must be the exact 21 stored score-card coordinates');
        assert.strictEqual(await page.locator('[data-savedledgercolumn="shorts.stored.text.keep"]').count(), 1);
        await page.locator('[data-savedledgerfamily="all"]').click();
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
        await page.locator('[data-savedledgercolumn="shorts.creator-excluded.visual.views"] button').click();
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
        await page.locator('[data-savedledger-provenance-matrix="long"] [data-savedledger-coordinate-select="long.output.visual.realviews"]').click();
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
        await page.locator('[data-savedledgerfamily="stored"]').click();
        await page.getByText(
            'Exploratory public analysis',
            { exact: true }
        ).click();
        try {
            await page.getByText('Execution-risk research · does an embedding score separate later view outcomes?', { exact: true }).waitFor();
        } catch (error) {
            console.error('ANALYSIS PANEL:', (await page.locator('#rtg-exppanel').innerText()).slice(-3000));
            throw error;
        }
        assert((await page.locator('[data-savedchannelriskthresholdtable]').innerText()).includes('30.00M'), 'risk table must expose literal normal-views embedding thresholds');
        assert.strictEqual(await page.getByText('47–91%', { exact: true }).count(), 1, 'risk table must show confidence rather than a bare hit rate');
        assert.strictEqual(
            await page.getByText(
                'Historical diagnostic 10M tail model · combinations and retrospective time split',
                { exact: true }
            ).count(),
            1,
            'historical saved-channel scores must never be presented as blind or prospective evidence'
        );
        await page.locator('[data-savedchannelmatrix]').waitFor();
        assert(await page.locator('[data-savedchannelmatrix]').evaluate(canvas => {
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            for (let index = 0; index < pixels.length; index += 4) if (pixels[index] || pixels[index + 1] || pixels[index + 2]) return true;
            return false;
        }), 'the 21-indicator matrix canvas must contain rendered pixels');
        assert.strictEqual(await page.getByText('All videos × all 21 indicators', { exact: true }).count(), 1);
        for (const selector of ['[data-savedchannelprocessmap]', '[data-savedchanneloutcomehist]', '[data-savedchannelagescatter]', '[data-savedchannelevidence]', '[data-savedchannelindicatorplayground]', '[data-savedchannelprofileatlas]', '[data-savedchannelrelationships]', '[data-savedchannelresiduals]', '[data-savedchannelcontinuouscalibration]', '[data-savedchannelranktrace]', '[data-savedchannelselectionfrequency]', '[data-savedchannelcombinationlandscape]', '[data-savedchannelriskroc]', '[data-savedchannelriskpr]', '[data-savedchannelriskreliability]', '[data-savedchannelriskoutcomes]', '[data-savedchanneltargetlandscape]', '[data-savedchannelrisksignalatlas]']) {
            assert.strictEqual(await page.locator(selector).count(), 1, `visual analysis is missing ${selector}`);
        }
        assert.strictEqual(await page.locator('[data-savedchannelrelationships] rect').count(), 441, 'redundancy heatmap must render all 21 × 21 relationships');
        assert.strictEqual(await page.locator('[data-savedchannelprofileatlas] > [data-savedchannelanalysisfeature]').count(), 21, 'trajectory atlas must render one graph per indicator');
        assert.strictEqual(await page.locator('[data-savedchannelrisksignalatlas] > [data-savedchannelrisksignal]').count(), riskSignals.length, 'risk atlas must show every ordinary views signal together');
        const visualViewsButton = page.locator('[data-savedchannelindicatorplayground] [data-savedchannelanalysisfeature="visual.views"]');
        assert.strictEqual(await visualViewsButton.count(), 1);
        await visualViewsButton.click();
        await page.getByText('Indicator playground · visual.views', { exact: true }).waitFor();
        assert((await page.locator('[data-savedchannelindicatorscatter] circle[data-savedchannelvideo]').count()) >= videos.length, 'selected-indicator scatter must expose every underlying video as a drill-down point');

        await page.getByText(
            'Leakage-controlled retrospective validation',
            { exact: true }
        ).click();
        const canonicalValidation = page.locator('[data-savedvalidation-canonical]');
        await canonicalValidation.waitFor();
        assert.strictEqual(await canonicalValidation.getAttribute('data-coordinate-count'), String(shortsCoordinateCount));
        assert.strictEqual(await canonicalValidation.getAttribute('data-outcome-count'), String(observedOutcomeCount));
        const creatorKeepStudy = page.locator('[data-savedcreatorkeep-study]');
        await creatorKeepStudy.waitFor();
        const creatorKeepStudyText = await creatorKeepStudy.innerText();
        assert(creatorKeepStudyText.includes('Known-creator prequential multimodal keep mixture'));
        assert(creatorKeepStudyText.includes('RESEARCH ONLY · NOT PREDICTOR-ELIGIBLE'));
        assert(creatorKeepStudyText.includes('2/2 ACCOUNT-MAE CEILING MET'));
        assert(creatorKeepStudyText.includes('INPUT 1 · VISUAL'));
        assert(creatorKeepStudyText.includes('INPUT 2 · TOGETHER'));
        assert(creatorKeepStudyText.includes('PRIOR-OUTCOME HISTORY'));
        assert(/incremental MAE value/i.test(creatorKeepStudyText));
        assert(creatorKeepStudyText.includes('PREQUENTIAL ±10 COVERAGE'));
        assert.strictEqual(await creatorKeepStudy.locator('[data-savedcreatorkeep-scatter] circle[data-savedchannelvideo], [data-savedcreatorkeep-scatter] circle[data-savedvalidationrow]').count(), 40);
        const pooledPrequentialDistribution = creatorKeepStudy.locator('[data-savedcreatorkeep-error-distribution="prequential"]');
        const pooledFrozenDistribution = creatorKeepStudy.locator('[data-savedcreatorkeep-error-distribution="frozen"]');
        assert.strictEqual(await pooledPrequentialDistribution.getAttribute('data-account'), 'all');
        assert.strictEqual(await pooledPrequentialDistribution.getAttribute('data-error-n'), '40');
        assert.strictEqual(await pooledFrozenDistribution.getAttribute('data-error-n'), '40');
        assert((await pooledPrequentialDistribution.locator('[data-error-histogram-bin]').count()) > 0, 'the empirical absolute-error histogram must render bins');
        assert.strictEqual(await pooledPrequentialDistribution.locator('[data-error-cdf]').count(), 1, 'the empirical cumulative coverage curve must render');
        assert((await pooledPrequentialDistribution.innerText()).includes('No bell curve or normality assumption is imposed.'));
        const firstCreatorKeepPoint = creatorKeepStudy.locator('[data-savedcreatorkeep-scatter] circle[data-savedvalidationrow]').first();
        const firstCreatorKeepPointTitle = await firstCreatorKeepPoint.locator('title').textContent();
        assert(firstCreatorKeepPointTitle.includes('Component A:'));
        assert(firstCreatorKeepPointTitle.includes('Component B:'));
        await firstCreatorKeepPoint.click();
        const creatorKeepPointDetail = await creatorKeepStudy.locator('[data-savedcreatorkeep-scatter]').innerText();
        assert(/component A .*centered-together residual analog/i.test(creatorKeepPointDetail));
        assert(/component B .*visual\+together semantic stack/i.test(creatorKeepPointDetail));
        await creatorKeepStudy.locator('[data-savedcreatorkeepaccount="hafu"]').click();
        assert.strictEqual(await creatorKeepStudy.locator('[data-savedcreatorkeep-scatter] circle[data-savedchannelvideo], [data-savedcreatorkeep-scatter] circle[data-savedvalidationrow]').count(), 20);
        const hafuPrequentialDistribution = creatorKeepStudy.locator('[data-savedcreatorkeep-error-distribution="prequential"]');
        assert.strictEqual(await hafuPrequentialDistribution.getAttribute('data-account'), 'hafu');
        assert.strictEqual(await hafuPrequentialDistribution.getAttribute('data-error-n'), '20');
        assert(Math.abs(Number(await hafuPrequentialDistribution.getAttribute('data-error-max')) - 6.35) < 1e-6, 'Hafu maximum miss must be derived from the same plotted predictions');
        const hafuWithinOne = hafuPrequentialDistribution.locator('[data-error-coverage-threshold="1"]');
        assert.strictEqual(await hafuWithinOne.getAttribute('data-count'), '3');
        assert(Math.abs(Number(await hafuWithinOne.getAttribute('data-percentage')) - 15) < 1e-6, 'Hafu within-one-point coverage must match the empirical errors');
        const hafuHistogramCount = await hafuPrequentialDistribution.locator('[data-error-histogram-bin]').evaluateAll(bins => bins.reduce((sum, bin) => sum + Number(bin.dataset.count || 0), 0));
        assert.strictEqual(hafuHistogramCount, 20, 'every Hafu prediction must occur in exactly one histogram bin');
        assert(await hafuPrequentialDistribution.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'the distribution panel must not overflow its mobile-width parent');
        if (process.env.EXPERIMENT_LAB_KEEP_DISTRIBUTION_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_KEEP_DISTRIBUTION_SCREENSHOT), { recursive: true });
            await hafuPrequentialDistribution.screenshot({ path: process.env.EXPERIMENT_LAB_KEEP_DISTRIBUTION_SCREENSHOT });
        }
        await creatorKeepStudy.locator('[data-savedcreatorkeepaccount="all"]').click();
        const visualKeepStudy = page.locator('[data-savedvisualkeep-study]');
        await visualKeepStudy.waitFor();
        assert((await visualKeepStudy.innerText()).includes('Best tested visual-only keep-rate predictor'));
        assert((await visualKeepStudy.innerText()).includes('RESEARCH ONLY'));
        assert.strictEqual(await visualKeepStudy.locator('[data-savedvisualkeepprotocol]').count(), 3);
        assert.strictEqual(await visualKeepStudy.locator('[data-savedvisualkeep-scatter] circle[data-savedchannelvideo-embedding], [data-savedvisualkeep-scatter] circle[data-savedvalidationrow]').count(), 40);
        await visualKeepStudy.locator('[data-savedvisualkeepprotocol="forwardTime"]').click();
        assert((await visualKeepStudy.innerText()).includes('Future upload simulation'));
        await visualKeepStudy.locator('[data-savedvisualkeepaccount="hafu"]').click();
        assert.strictEqual(await visualKeepStudy.locator('[data-savedvisualkeep-scatter] circle[data-savedchannelvideo-embedding], [data-savedvisualkeep-scatter] circle[data-savedvalidationrow]').count(), 20);
        await visualKeepStudy.locator('[data-savedvisualkeepprotocol="videoHoldout"]').click();
        assert.strictEqual(await page.getByText('What predicts performance?', { exact: true }).count(), 1);
        assert.strictEqual(await page.getByText(new RegExp(`${shortsCoordinateCount} ledger columns do not mean ${shortsCoordinateCount} independent embeddings`)).count(), 1);
        assert.strictEqual(await page.getByText(/Leakage audit passed.*does not imply universal creator transfer/).count(), 1);
        assert.strictEqual(await page.locator('[data-savedvalidation-ledger-classification]').innerText(), ledgerClassificationText);
        assert.strictEqual(await page.locator('[data-savedvalidationtarget]').count(), observedOutcomeCount, 'all observed outcomes and curve checkpoints must be selectable');
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').count(), shortsCoordinateCount, 'the heatmap must preserve the canonical active ledger');
        assert.strictEqual(await page.getByText(`All ${shortsCoordinateCount} coordinates × all ${observedOutcomeCount} observed outcomes`, { exact: true }).count(), 1);
        assert.strictEqual(await page.locator('[data-savedvalidationcell]').count(), shortsCoordinateCount * observedOutcomeCount, 'every ledger coordinate must be compared with every observed outcome');
        assert.strictEqual(await page.locator('[data-savedvalidationfeature="shorts.observed.keep"] [data-savedvalidationcell]').first().innerText(), 'TRUTH\nnot predictor', 'actual outcomes must be visibly blocked from predictor use');
        for (const term of ['Stored', 'Video held out', 'Account held out', 'Direct axis', 'Derived score', 'Forecast', 'Prequential next upload', 'Compatibility alias', 'Observed outcome', 'Prediction R²', 'MAE / factor error', 'Global exploratory q']) {
            assert.strictEqual(await page.getByText(term, { exact: true }).count(), 1, `plain-English glossary is missing ${term}`);
        }
        await page.locator('[data-savedvalidationfamily="strict"]').click();
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').count(), heldoutClassification.columns, 'held-out predictor filter must exclude research-only coordinates');
        await page.locator('[data-savedvalidationfamily="all"]').click();
        const creatorResearchCell = page.locator('[data-savedvalidationcell][data-savedvalidationcoordinate="shorts.creator-prequential-forecast.keep"][data-savedvalidationoutcome="keep"]');
        assert.strictEqual(await creatorResearchCell.innerText(), 'RESEARCH\nclick for honest baseline');
        await creatorResearchCell.click();
        const creatorVideoTableText = await page.locator('[data-savedvalidation-video-table]').innerText();
        assert(creatorVideoTableText.includes('History-only baseline'));
        assert(creatorVideoTableText.includes('Incremental absolute-error value'));
        assert(creatorVideoTableText.includes('66.0%'), 'creator validation rows must expose the exact matched history baseline');
        await page.locator('[data-savedvalidationcell][data-savedvalidationcoordinate="shorts.stored.text.ret5"][data-savedvalidationoutcome="keep"]').click();
        await page.locator('[data-savedvalidation-selected]').waitFor();
        const selectedTextRet5 = await page.locator('[data-savedvalidation-selected]').innerText();
        assert(selectedTextRet5.includes('shorts.stored.text.ret5'));
        assert(selectedTextRet5.includes('Text input only'));
        assert(selectedTextRet5.includes('Five-second retention score'));
        const relationshipScatter = page.locator('[data-savedvalidation-scatter]');
        assert.strictEqual(await relationshipScatter.getAttribute('data-plot-mode'), 'raw');
        assert(/Raw .*5s retention.* vs observed Stayed to watch/.test(
            await relationshipScatter.innerText()
        ));
        assert((await relationshipScatter.innerText()).includes('Only association is shown; no cross-outcome estimator is invented.'));
        assert((await relationshipScatter.innerText()).includes('association-only; no numerical prediction range exists'));
        const crossTargetPoint = relationshipScatter.locator('circle[data-savedvalidationrow="vid00000002"]').first();
        const crossTargetTooltip = await crossTargetPoint.locator('title').textContent();
        assert(/Raw .*5s retention.*:/.test(crossTargetTooltip), 'cross-target hover must name the plotted score coordinate');
        assert(crossTargetTooltip.includes('Actual Stayed to watch:'), 'hover must expose the measured outcome without inventing a cross-target prediction');
        assert(crossTargetTooltip.includes('Actual Stayed to watch:'), 'cross-target hover must name the independent outcome');
        assert(crossTargetTooltip.includes('Coordinate: shorts.stored.text.ret5'));
        await crossTargetPoint.dispatchEvent('click');
        const crossTargetDetail = page.locator('[data-savedvalidation-point-detail]');
        await crossTargetDetail.waitFor();
        assert((await crossTargetDetail.innerText()).includes('shorts.stored.text.ret5'));
        assert((await crossTargetDetail.innerText()).includes('shorts.observed.keep'));
        assert((await crossTargetDetail.innerText()).includes('saved score + private outcomes'));
        assert.strictEqual(await page.locator('[data-savedvalidation-scatter]').getAttribute('data-plot-mode'), 'raw');
        assert((await page.locator('[data-savedvalidation-scatter]').innerText()).includes('Only association is shown'));
        assert.strictEqual(
            await page.locator(
                '[data-savedvalidation-scatter] [data-savedvalidationplotmode="prediction"]'
            ).count(),
            0,
            'a cross-target pairing must not expose a prediction toggle'
        );
        await page.locator('[data-savedvalidationcell][data-savedvalidationcoordinate="shorts.video-heldout.text.realviews"][data-savedvalidationoutcome="views"]').click();
        const selectedRealViews = await page.locator('[data-savedvalidation-selected]').innerText();
        assert(selectedRealViews.includes('Text input only'));
        assert(selectedRealViews.includes('combines predicted keep, predicted five-second retention, and duration'));
        assert(selectedRealViews.includes('derived, not a new embedding direction'));
        await page.locator('[data-savedvalidationcell][data-savedvalidationcoordinate="shorts.creator-excluded.together.views"][data-savedvalidationoutcome="views"]').click();
        await page.locator('[data-savedvalidation-selected]').waitFor();
        assert((await page.locator('[data-savedvalidation-selected]').innerText()).includes('shorts.creator-excluded.together.views'));
        const blindViewsPoint = page.locator('[data-savedvalidation-scatter] circle[data-savedvalidationrow="vid00000002"]').first();
        const blindViewsTooltip = await blindViewsPoint.locator('title').textContent();
        assert(blindViewsTooltip.includes('Coordinate: shorts.creator-excluded.together.views'), 'the hover must name the exact selected coordinate');
        assert(blindViewsTooltip.includes('Actual Current lifetime views:'), 'the hover must name the independently observed outcome');
        await blindViewsPoint.dispatchEvent('click');
        const selectedPointDetail = page.locator('[data-savedvalidation-point-detail]');
        await selectedPointDetail.waitFor();
        assert((await selectedPointDetail.innerText()).includes('shorts.creator-excluded.together.views'));
        assert.strictEqual(await selectedPointDetail.locator('[data-savedchannelvideo]').count(), 1, 'matched points must drill into the original saved score card without recomputation');
        await selectedPointDetail.locator('[data-savedchannelvideo]').click();
        await page.waitForFunction(id => {
            const image = document.querySelector('#rtg-exppanel img[style*="width:260px"]');
            return image && image.src.includes(id);
        }, 'vid00000002');
        if (process.env.EXPERIMENT_LAB_CONTEXT_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_CONTEXT_SCREENSHOT), { recursive: true });
            await page.locator('#rtg-exppanel').screenshot({ path: process.env.EXPERIMENT_LAB_CONTEXT_SCREENSHOT });
        }
        assert.strictEqual(await page.evaluate(pathname => window.__fetchCounts[pathname], videoPath), 1, 'reopening an older cached validation video must not fetch or recompute it again');
        assert.strictEqual(await page.evaluate(() => window.__fetchCounts['/api/raw/embed-montage'] || 0), 0, 'validation inspection must never recalculate a stored embedding');
        const lineageDetails = page.locator('[data-savedvalidation-canonical] details').filter({ hasText: 'show the complete raw-input' }).first();
        await lineageDetails.locator(':scope > summary').click();
        const validationLineageText = await lineageDetails.innerText();
        for (const stage of ['Raw inputs', 'Representation', 'Fit dataset', 'Fit target', 'Algorithm / rotation', 'Calibration', 'Validation / holdout', 'Frozen artifact']) {
            assert(validationLineageText.includes(stage), `canonical coordinate lineage is missing ${stage}`);
        }
        await page.locator('[data-savedvalidationfamily="outcome"]').click();
        assert.strictEqual(
            await page.locator('[data-savedvalidationfeature]').count(),
            outcomeClassification.columns,
            'the outcomes filter must expose each stored truth coordinate '
                + 'once; swipe remains a display transform of keep'
        );
        await page.locator('[data-savedvalidationfamily="all"]').click();
        await visualKeepStudy.evaluate(element => element.scrollIntoView({ block: 'center' }));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const visualKeepDrilldowns = page.locator('[data-savedvisualkeep-scatter] circle[data-savedvalidationrow]');
        const visibleVisualKeepIndex = await visualKeepDrilldowns.evaluateAll(nodes => nodes.findIndex(node => {
            const rect = node.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return rect.width > 0
                && rect.height > 0
                && rect.left >= 0
                && rect.right <= document.documentElement.clientWidth
                && rect.top >= 0
                && rect.bottom <= document.documentElement.clientHeight
                && hit === node;
        }));
        assert(visibleVisualKeepIndex >= 0, 'the mobile validation chart must expose at least one directly clickable stored-video point');
        const visualKeepDrilldown = visualKeepDrilldowns.nth(visibleVisualKeepIndex);
        const visualKeepTooltip = await visualKeepDrilldown.locator('title').textContent();
        assert(visualKeepTooltip.includes('shorts.visual-keep-protocol.video-heldout.v1:'), 'the validation point must name and disclose its leakage-controlled protocol coordinate');
        assert(visualKeepTooltip.includes('shorts.visual-keep-forecast.v1:'), 'the validation point must separately name and disclose the frozen raw ledger coordinate');
        const visualKeepHitAudit = await visualKeepDrilldown.evaluate(node => {
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
        const visualKeepVideoId = String(await visualKeepDrilldown.getAttribute('data-savedvalidationrow'));
        const visualKeepVideo = videos.find(video => video.id === visualKeepVideoId);
        assert(visualKeepVideo, 'the clickable validation point must resolve to its saved-video fixture');
        await visualKeepDrilldown.click({ force: true });
        const visualKeepPointDetail = visualKeepStudy.locator('[data-savedvisualkeep-point-detail]');
        await visualKeepPointDetail.waitFor();
        const protocolValue = Number(await visualKeepDrilldown.getAttribute('data-coordinate-value'));
        const protocolPoint = visualKeepPoints.find(point => point.id === visualKeepVideoId);
        assert(protocolPoint);
        assert(Math.abs(protocolValue - protocolPoint.predicted) < 1e-8, 'the plotted point must use the registered protocol ledger value');
        const visualKeepPointText = await visualKeepPointDetail.innerText();
        assert(visualKeepPointText.includes('shorts.visual-keep-protocol.video-heldout.v1'));
        assert(visualKeepPointText.includes('shorts.visual-keep-forecast.v1'));
        assert(visualKeepPointText.includes('shorts.observed.keep'));
        await visualKeepPointDetail.locator('button[data-savedchannelvideo]:not([data-savedchannelvideo-embedding])').click();
        const keepCoordinateTable = page.locator('[data-visual-keep-coordinate-table]');
        await keepCoordinateTable.waitFor();
        assert.strictEqual(await keepCoordinateTable.locator('[data-visual-keep-coordinate-row]').count(), 11, 'the score card must show all three held-out protocols, the frozen score-time forecast, the historical creator-prequential validation row, three stored modality maps, two blind axes, and observed truth');
        const registeredVideoProtocolRow = keepCoordinateTable.locator('[data-coordinate-id="shorts.visual-keep-protocol.video-heldout.v1"]');
        assert.strictEqual(Number(await registeredVideoProtocolRow.getAttribute('data-coordinate-value')), protocolPoint.predicted);
        const keepCoordinateTableText = await keepCoordinateTable.innerText();
        assert(
            keepCoordinateTableText.includes('artifact.runtime.shorts.blind-predictor.v1'),
            'the protocol value must disclose the exact predictor-study artifact family',
        );
        assert(
            keepCoordinateTableText.includes('artifact.shorts.visual-keep-model.v1'),
            'the frozen pooled value must disclose its separate visual-model artifact family',
        );
        assert((await keepCoordinateTable.locator('[data-visual-keep-error-equation]').innerText()).includes(
            `${protocolPoint.predicted.toFixed(1)}% protocol prediction`
        ), 'the score card error equation must use the same protocol value as the plotted point');
        assert.strictEqual(
            Number(await keepCoordinateTable.locator('[data-coordinate-id="shorts.visual-keep-forecast.v1"]').getAttribute('data-coordinate-value')),
            visualKeepVideo.visual_keep_forecast.raw,
            'the frozen production forecast must remain a separate exact ledger value',
        );
        if (process.env.EXPERIMENT_LAB_KEEP_COORDINATE_SCREENSHOT) {
            fs.mkdirSync(
                path.dirname(process.env.EXPERIMENT_LAB_KEEP_COORDINATE_SCREENSHOT),
                { recursive: true },
            );
            await keepCoordinateTable.screenshot({
                path: process.env.EXPERIMENT_LAB_KEEP_COORDINATE_SCREENSHOT,
            });
        }
        await visualKeepPointDetail.locator('button[data-savedchannelvideo-embedding="visual:keep"]').click();
        await page.locator('[data-rawproj="keep"]').waitFor();
        const rawMapForecast = page.locator('[data-visual-keep-raw-map-value]');
        await rawMapForecast.waitFor();
        assert((await rawMapForecast.innerText()).includes(`${visualKeepVideo.visual_keep_forecast.raw.toFixed(1)}%`), 'clicking a validation point must open its normal embedding with the same raw ledger value');
        assert((await rawMapForecast.innerText()).includes('shorts.visual-keep-forecast.v1'), 'the normal map must name the forecast coordinate rather than inventing another embedding');
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
        assert.strictEqual(await page.evaluate(() => window.__fetchCounts['/api/raw/embed-montage'] || 0), 0, 'opening the normal embedding must reuse the stored vector and never re-embed');
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 390, scroll: 390 });
        if (process.env.EXPERIMENT_LAB_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_SCREENSHOT), { recursive: true });
            await page.screenshot({ path: process.env.EXPERIMENT_LAB_SCREENSHOT, fullPage: false });
        }
        if (process.env.EXPERIMENT_LAB_DESKTOP_SCREENSHOT) {
            await page.setViewportSize({ width: 1280, height: 820 });
            assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 1280, scroll: 1280 });
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_DESKTOP_SCREENSHOT), { recursive: true });
            await page.screenshot({ path: process.env.EXPERIMENT_LAB_DESKTOP_SCREENSHOT, fullPage: false });
        }
        const finalParity = await page.evaluate(() => window.BusinessWorldEmbeddingParityAudit(document));
        assert(finalParity.ok, `final rendered embedding parity failed: ${JSON.stringify(finalParity.conflicts)}`);
        console.log(JSON.stringify({ ok: true, sharedExperimentControls: 5, desktopWidth: 1280, mobileWidth: 390, mobileScrollTop: await workspace.evaluate(element => element.scrollTop), storedImage: true, exactIndicatorSort: 'text.keep', savedArtifactFetches: 1, resumeRequests: 1, matrixColumns: 21, relationshipCells: 441, trajectoryCharts: 21, riskSignalCharts: riskSignals.length, riskThreshold: '30M', blindValidationCoordinates: shortsCoordinateCount, blindValidationOutcomes: observedOutcomeCount, embeddingParity: finalParity }));
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
