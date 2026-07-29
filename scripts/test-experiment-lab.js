#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const validationBuilder = require('../buildings/jarvis/saved-channel-validation');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = process.env.EXPERIMENT_LAB_ORIGIN || 'http://127.0.0.1:8002';

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
                input_manifest: {
                    input_fingerprint: `input-${id}`,
                    revision_fingerprint: `revision-${id}`,
                    output_fingerprint: `output-${id}`,
                    scorer_revisions: { scorer: { sha256: 'feedface01234567' } },
                    steer_artifact_sha256: '0123456789abcdef',
                    steer_artifact_archive_key: 'raw/steer_models/by-sha256/0123456789abcdef.npz',
                    steer_lineage_manifest_sha256: 'abcdef0123456789',
                    steer_lineage_schema_version: 1,
                },
            };
        });
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
        }));
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
                            schemaVersion: 1,
                            label: 'Visual-only keep-rate predictor',
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
                                selected: { pooledAlpha: 1, accountAlpha: .1, accountWeight: .75 },
                                pooled: { coefficients: Array.from({ length: 1536 }, () => 0) },
                            },
                            promotion: {
                                promoted: false,
                                status: 'research_only_not_validated_for_pre_upload_decisions',
                                plainEnglish: 'Retrospective structure exists, but future and unseen-creator transfer do not clear the honest baselines.',
                                rule: 'Both strict protocols must beat their legitimate null.',
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
        const replies = {
            '/api/retention/channels': { channels: [], active: 'tyler' },
            '/api/indicators/registry': { indicators: [], meta: { targets: [] } },
            '/api/raw/saved-hooks': { hooks: [] },
            '/api/raw/saved-channels': { channels: [{ id: channelId, name: 'Mobile Risk Channel', url: 'https://youtube.com/@risk', status: 'partial', discovered: 21, completed: 20, failed: 1 }], featureContract },
            [`/api/raw/saved-channel/${channelId}`]: { id: channelId, name: 'Mobile Risk Channel', url: 'https://youtube.com/@risk', status: 'partial', discovered: 21, completed: 20, failed: 1, queued: 0, videos: videos.concat(unfinishedVideo), featureContract },
            [`/api/raw/saved-channel/${channelId}/analysis`]: riskAnalysis,
            '/api/raw/saved-channel-validation': validationArtifact,
            [`/api/raw/saved-channel/${channelId}/resume`]: { ok: true },
            '/api/hooks/grind/runs': { runs: [] },
            '/api/hooks/warmup': { ok: true, fired: false },
        };
        videos.forEach(video => {
            replies[`/api/raw/saved-channel/${channelId}/video/${video.id}`] = {
                title: video.title,
                transcript: `Stored transcript for ${video.title}`,
                silent: false,
                indicators: {},
                steer: Object.fromEntries(featureContract.features.filter(feature => feature.source === 'steer').map(feature => [feature.sourceKey, { est: video.features[feature.key][0], pctile: video.features[feature.key][1] }])),
                emb_preview: { visual: [0.1, 0.2], text: [0.2, 0.3], together: [0.3, 0.4] },
                channels: { visual: { neighbors: [] }, text: { neighbors: [] }, together: { neighbors: [] } },
                input_manifest: {
                    domain: 'shorts_raw',
                    scorer: 'raw_upload.py',
                    embedding_model: 'gemini-embedding-2',
                    embedding_dimensions: 1536,
                    steer_artifact_sha256: '0123456789abcdef',
                    steer_artifact_archive_key: 'raw/steer_models/by-sha256/0123456789abcdef.npz',
                    steer_lineage_manifest_sha256: 'abcdef0123456789',
                    steer_lineage_schema_version: 1,
                    source_window: 'first 5 seconds',
                    display_preference: ['together', 'text', 'visual'],
                },
            };
        });
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><base href="${ORIGIN}/"><link rel="stylesheet" href="/buildings/experimentlab/experimentlab.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#080d14}</style></head><body><main id="root"></main>
<script src="/buildings/building-registry.js"></script><script src="/buildings/jarvis/jarvis-upload-utils.js"></script>
<script>const nativeFetch=window.fetch.bind(window);const replies=${JSON.stringify(replies)};window.__fetchCounts={};window.fetch=function(url,options){const p=new URL(url,location.href).pathname;window.__fetchCounts[p]=(window.__fetchCounts[p]||0)+1;if(p.includes('/api/raw/saved-channel/')&&p.includes('/montage/')){const b=Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='),c=>c.charCodeAt(0));return Promise.resolve(new Response(b,{status:200,headers:{'Content-Type':'image/gif'}}));}if(replies[p])return Promise.resolve(new Response(JSON.stringify(replies[p]),{status:200,headers:{'Content-Type':'application/json'}}));if(p.includes('/principles/')||p==='/api/raw/map'||p==='/api/rtg/labels')return Promise.resolve(new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));return nativeFetch(url,options)};</script>
<script src="/buildings/jarvis/jarvis-retention.js"></script><script src="/buildings/experimentlab/experimentlab-ui.js"></script><script>BuildingRegistry.get('Experiment Lab').open(document.getElementById('root'));</script></body></html>`, { waitUntil: 'networkidle' });

        await page.getByRole('heading', { name: 'Experiment Lab' }).waitFor();
        try {
            await page.getByPlaceholder('type a video idea — or leave blank and the model invents one…').waitFor();
        } catch (error) {
            console.error('INITIAL ROOT:', (await page.locator('#root').innerText()).slice(0, 1500));
            throw error;
        }
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
        await page.waitForFunction(() => {
            const image = document.querySelector('#rtg-exppanel img[style*="width:260px"][src*="vid00000002"]');
            return image && image.complete && image.naturalWidth > 0;
        });
        assert(await page.locator('#rtg-exppanel').evaluate(panel => panel.textContent.includes('graphs — every channel')), 'stored score must open the complete graph read-out');
        await page.getByText('Exactly what the 21 graphs mean', { exact: true }).waitFor();
        const lineageText = await page.locator('#rtg-exppanel').innerText();
        assert(lineageText.includes("exact raw-map video IDs that join to a finite Tyler stayed-to-watch label"), 'score detail must expose the keep-axis fitting population');
        assert(lineageText.includes('Public Shorts embedding corpus'), 'score detail must expose the public-axis fitting population');
        assert(lineageText.includes('artifact 0123456789ab'), 'score detail must expose the exact persisted steer artifact');
        const parityAfterStoredOpen = await page.evaluate(() => window.BusinessWorldEmbeddingParityAudit(document));
        assert(parityAfterStoredOpen.ok, `stored card/detail parity failed: ${JSON.stringify(parityAfterStoredOpen.conflicts)}`);
        const selectedTextKeepValues = await page.locator(`[data-embedding-asset="${channelId}:vid00000002"][data-embedding-id="shorts_raw:stored-production:text_keep"]`).evaluateAll(nodes => nodes.map(node => ({
            estimate: node.getAttribute('data-embedding-est'),
            percentile: node.getAttribute('data-embedding-percentile'),
            sourceKey: node.getAttribute('data-embedding-source-key'),
        })));
        assert(selectedTextKeepValues.length >= 2, 'the selected Text.keep embedding must appear on both library and detail surfaces');
        assert(selectedTextKeepValues.every(value =>
            value.estimate === String(videos[1].features['text.keep'][0])
            && value.percentile === String(videos[1].features['text.keep'][1])
            && value.sourceKey === 'text_keep'
        ), 'the same Text.keep asset must retain an identical raw estimate, percentile, and source key everywhere');
        await page.locator(`[data-savedchannelvideo="${channelId}:vid00000002"]`).click();
        assert.strictEqual(await page.evaluate(pathname => window.__fetchCounts[pathname], videoPath), 1, 'opening the same saved Short again must use the in-memory stored-artifact cache');

        await page.locator(`[data-savedchannelresume="${channelId}"]`).click();
        const resumePath = `/api/raw/saved-channel/${channelId}/resume`;
        await page.waitForFunction(pathname => window.__fetchCounts[pathname] === 1, resumePath);
        await page.getByText('Score ledger', { exact: true }).click();
        await page.getByText('Canonical score ledger', { exact: true }).waitFor();
        assert.strictEqual(await page.getByText('LEDGER PARITY AUDIT PASSED', { exact: true }).count(), 1);
        assert.strictEqual(await page.locator('[data-savedledgercolumn]').count(), 21, 'the default ledger family must be the exact 21 stored score-card coordinates');
        assert.strictEqual(await page.locator('[data-savedledgercolumn="shorts.stored.text.keep"]').count(), 1);
        await page.locator('[data-savedledgerfamily="all"]').click();
        assert.strictEqual(await page.locator('[data-savedledgercolumn]').count(), 103, 'the full ledger must expose every registered observed, stored, held-out, forecast, and legacy scalar');
        assert((await page.locator('[data-savedledger]').innerText()).includes('103 columns are not 103 embedding spaces.'), 'the ledger must distinguish direct axes from derived values, forecasts, observations, and legacy columns');
        assert((await page.locator('[data-savedledger]').innerText()).includes('45 direct-axis columns representing 36 distinct fitted axes'), 'the ledger must distinguish direct-axis columns from distinct fits');
        assert((await page.locator('[data-savedledger]').innerText()).includes('9 public-axis aliases'), 'the ledger must disclose the nine shared public axes reused across protocol views');
        assert((await page.locator('[data-savedledger]').innerText()).includes('A historical fit manifest that was never saved is labeled unknown'), 'the ledger must not infer missing historical fit populations');
        assert((await page.locator('[data-savedledger-row-provenance="vid00000001"]').innerText()).includes('fit manifest abcdef012345'), 'each saved row must expose its persisted artifact and fit-manifest identity');
        const rowManifest = page.locator('[data-savedledger-row-manifest="vid00000001"]').first();
        await rowManifest.locator('summary').click();
        assert((await rowManifest.innerText()).includes('raw/steer_models/by-sha256/0123456789abcdef.npz'), 'the complete per-row manifest must be touch-accessible instead of existing only in a hover tooltip');
        const hitProbabilityText = await page.locator('[data-savedledgercell$=":shorts.video-forecast.hit10M"]').first().innerText();
        assert(hitProbabilityText.includes('% probability'), `10M forecasts must display their continuous probability (rendered: ${hitProbabilityText})`);
        assert.strictEqual(await page.locator('[data-savedledger-provenance-matrix="shorts"] [data-savedledger-coordinate-select]').count(), 103, 'the provenance matrix must contain every Shorts coordinate');
        assert.strictEqual(await page.locator('[data-savedledger-provenance-matrix="long"] [data-savedledger-coordinate-select]').count(), 12, 'the provenance matrix must also disclose all Long Quant outputs');
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
        await page.locator('[data-savedledgercolumn="shorts.account-heldout.visual.views"] button').click();
        const lineagePanel = page.locator('[data-savedledger-provenance-drilldown]');
        await lineagePanel.waitFor();
        assert.strictEqual(await lineagePanel.getAttribute('data-coordinate-id'), 'shorts.account-heldout.visual.views');
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
        assert((await page.locator('[data-savedledger]').innerText()).includes('Long Quant output provenance'), 'the registry summary must include the 12 Long Quant outputs');
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
        await page.getByText('Prediction analysis', { exact: true }).click();
        try {
            await page.getByText('Execution risk · can an embedding score justify making the video?', { exact: true }).waitFor();
        } catch (error) {
            console.error('ANALYSIS PANEL:', (await page.locator('#rtg-exppanel').innerText()).slice(-3000));
            throw error;
        }
        assert((await page.locator('[data-savedchannelriskthresholdtable]').innerText()).includes('30.00M'), 'risk table must expose literal normal-views embedding thresholds');
        assert.strictEqual(await page.getByText('47–91%', { exact: true }).count(), 1, 'risk table must show confidence rather than a bare hit rate');
        assert.strictEqual(await page.getByText('Blind 10M tail model · combinations and future stability', { exact: true }).count(), 1);
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

        await page.getByText('Blind validation', { exact: true }).click();
        const canonicalValidation = page.locator('[data-savedvalidation-canonical]');
        await canonicalValidation.waitFor();
        assert.strictEqual(await canonicalValidation.getAttribute('data-coordinate-count'), '103');
        assert.strictEqual(await canonicalValidation.getAttribute('data-outcome-count'), '13');
        const visualKeepStudy = page.locator('[data-savedvisualkeep-study]');
        await visualKeepStudy.waitFor();
        assert((await visualKeepStudy.innerText()).includes('Best tested visual-only keep-rate predictor'));
        assert((await visualKeepStudy.innerText()).includes('RESEARCH ONLY'));
        assert.strictEqual(await visualKeepStudy.locator('[data-savedvisualkeepprotocol]').count(), 3);
        assert.strictEqual(await visualKeepStudy.locator('[data-savedvisualkeep-scatter] circle').count(), 40);
        await visualKeepStudy.locator('[data-savedvisualkeepprotocol="forwardTime"]').click();
        assert((await visualKeepStudy.innerText()).includes('Future upload simulation'));
        await visualKeepStudy.locator('[data-savedvisualkeepaccount="hafu"]').click();
        assert.strictEqual(await visualKeepStudy.locator('[data-savedvisualkeep-scatter] circle').count(), 20);
        await visualKeepStudy.locator('[data-savedvisualkeepprotocol="videoHoldout"]').click();
        assert.strictEqual(await page.getByText('What predicts performance?', { exact: true }).count(), 1);
        assert.strictEqual(await page.getByText(/103 ledger columns do not mean 103 independent embeddings/).count(), 1);
        assert.strictEqual(await page.getByText(/Leakage audit passed.*does not mean the predictor is accurate/).count(), 1);
        assert.strictEqual(await page.locator('[data-savedvalidation-ledger-classification]').innerText(), '62 blind columns · 53 unique blind predictions · 9 alias columns · 28 diagnostics · 13 actual outcomes');
        assert.strictEqual(await page.locator('[data-savedvalidationtarget]').count(), 13, 'all observed outcomes and curve checkpoints must be selectable');
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').count(), 103, 'the heatmap must preserve the canonical 103-column ledger');
        assert.strictEqual(await page.getByText('All 103 coordinates × all 13 observed outcomes', { exact: true }).count(), 1);
        assert.strictEqual(await page.locator('[data-savedvalidationcell]').count(), 103 * 13, 'every ledger coordinate must be compared with every observed outcome');
        assert.strictEqual(await page.locator('[data-savedvalidationfeature="shorts.observed.keep"] [data-savedvalidationcell]').first().innerText(), 'TRUTH\nnot predictor', 'actual outcomes must be visibly blocked from predictor use');
        for (const term of ['Stored', 'Video held out', 'Account held out', 'Direct axis', 'Derived score', 'Forecast', 'Alias', 'Observed outcome', 'OOF R²', 'MAE / factor error', 'Global q']) {
            assert.strictEqual(await page.getByText(term, { exact: true }).count(), 1, `plain-English glossary is missing ${term}`);
        }
        await page.locator('[data-savedvalidationfamily="strict"]').click();
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').count(), 62, 'blind predictor filter must contain exactly the registered held-out coordinates and forecasts');
        await page.locator('[data-savedvalidationfamily="all"]').click();
        await page.locator('[data-savedvalidationcell][data-savedvalidationcoordinate="shorts.stored.text.ret5"][data-savedvalidationoutcome="keep"]').click();
        await page.locator('[data-savedvalidation-selected]').waitFor();
        const selectedTextRet5 = await page.locator('[data-savedvalidation-selected]').innerText();
        assert(selectedTextRet5.includes('shorts.stored.text.ret5'));
        assert(selectedTextRet5.includes('Text input only'));
        assert(selectedTextRet5.includes('Five-second retention score'));
        const relationshipScatter = page.locator('[data-savedvalidation-scatter]');
        assert.strictEqual(await relationshipScatter.getAttribute('data-plot-mode'), 'oof');
        assert((await relationshipScatter.innerText()).includes('Held-out predicted Stayed to watch vs observed Stayed to watch'));
        assert((await relationshipScatter.innerText()).includes('same calculation'));
        assert((await relationshipScatter.innerText()).includes('transformed-span coverage'));
        const crossTargetPoint = relationshipScatter.locator('circle[data-savedvalidationrow="vid00000002"]').first();
        const crossTargetTooltip = await crossTargetPoint.locator('title').textContent();
        assert(crossTargetTooltip.includes('5s retention:'), 'cross-target hover must name the plotted score coordinate');
        assert(crossTargetTooltip.includes('Held-out predicted Stayed to watch:'), 'hover must expose the exact calibrated prediction used by OOF metrics');
        assert(crossTargetTooltip.includes('Actual Stayed to watch:'), 'cross-target hover must name the independent outcome');
        assert(crossTargetTooltip.includes('Coordinate: shorts.stored.text.ret5'));
        await crossTargetPoint.dispatchEvent('click');
        const crossTargetDetail = page.locator('[data-savedvalidation-point-detail]');
        await crossTargetDetail.waitFor();
        assert((await crossTargetDetail.innerText()).includes('shorts.stored.text.ret5'));
        assert((await crossTargetDetail.innerText()).includes('shorts.observed.keep'));
        assert((await crossTargetDetail.innerText()).includes('saved score + private outcomes'));
        await relationshipScatter.locator('[data-savedvalidationplotmode="raw"]').dispatchEvent('click');
        assert.strictEqual(await page.locator('[data-savedvalidation-scatter]').getAttribute('data-plot-mode'), 'raw');
        assert((await page.locator('[data-savedvalidation-scatter]').innerText()).includes('not a percentage prediction'));
        await page.locator('[data-savedvalidation-scatter] [data-savedvalidationplotmode="oof"]').dispatchEvent('click');
        assert.strictEqual(await page.locator('[data-savedvalidation-scatter]').getAttribute('data-plot-mode'), 'oof');
        await page.locator('[data-savedvalidationcell][data-savedvalidationcoordinate="shorts.video-heldout.text.realviews"][data-savedvalidationoutcome="views"]').click();
        const selectedRealViews = await page.locator('[data-savedvalidation-selected]').innerText();
        assert(selectedRealViews.includes('Text input only'));
        assert(selectedRealViews.includes('combines predicted keep, predicted five-second retention, and duration'));
        assert(selectedRealViews.includes('derived, not a new embedding direction'));
        await page.locator('[data-savedvalidationcell][data-savedvalidationcoordinate="shorts.video-heldout.together.views"][data-savedvalidationoutcome="views"]').click();
        await page.locator('[data-savedvalidation-selected]').waitFor();
        assert((await page.locator('[data-savedvalidation-selected]').innerText()).includes('shorts.video-heldout.together.views'));
        const blindViewsPoint = page.locator('[data-savedvalidation-scatter] circle[data-savedvalidationrow="vid00000002"]').first();
        const blindViewsTooltip = await blindViewsPoint.locator('title').textContent();
        assert(blindViewsTooltip.includes('Coordinate: shorts.video-heldout.together.views'), 'the hover must name the exact selected coordinate');
        assert(blindViewsTooltip.includes('Actual Current lifetime views:'), 'the hover must name the independently observed outcome');
        await blindViewsPoint.dispatchEvent('click');
        const selectedPointDetail = page.locator('[data-savedvalidation-point-detail]');
        await selectedPointDetail.waitFor();
        assert((await selectedPointDetail.innerText()).includes('shorts.video-heldout.together.views'));
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
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').count(), 13, 'outcomes filter must expose the 13 measured truth fields without treating them as predictors');
        await page.locator('[data-savedvalidationfamily="all"]').click();
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
        console.log(JSON.stringify({ ok: true, sharedExperimentControls: 5, desktopWidth: 1280, mobileWidth: 390, mobileScrollTop: await workspace.evaluate(element => element.scrollTop), storedImage: true, exactIndicatorSort: 'text.keep', savedArtifactFetches: 1, resumeRequests: 1, matrixColumns: 21, relationshipCells: 441, trajectoryCharts: 21, riskSignalCharts: riskSignals.length, riskThreshold: '30M', blindValidationCoordinates: 103, blindValidationOutcomes: 13, embeddingParity: finalParity }));
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
