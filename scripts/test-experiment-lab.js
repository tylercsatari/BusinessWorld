#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const validationBuilder = require('../buildings/jarvis/saved-channel-validation');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = process.env.EXPERIMENT_LAB_ORIGIN || 'http://127.0.0.1:8002';

async function main() {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const featureContract = JSON.parse(fs.readFileSync(path.join(ROOT, 'buildings/jarvis/saved-channel-feature-contract.json'), 'utf8'));
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
                scoredAt: Date.now() - videoIndex * 1000,
                features,
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
        const keepPoints = videos.map((video, index) => ({ id: video.id, actual: 57 + index, predicted: 58 + index * .9 }));
        const viewsPoints = videos.map(video => ({ id: video.id, channel: channelId, channelName: 'Mobile Risk Channel', actualViews: video.views, predictedViews: Math.round(video.views * 1.12) }));
        const validationArtifact = validationBuilder.buildValidation({
            channels: [{
                channelId,
                accountId: 'tyler',
                accountName: 'Tyler Csatari',
                manifest: { videos },
                privateTable: { videos: privateVideos },
            }],
            predictor: {
                generatedAt: Date.now(),
                provenance: {
                    privateAxisTrainingIdOverlap: 0,
                    savedAxisTrainingIdOverlap: 0,
                    validationCreatorAxisTrainingIdOverlap: 0,
                    validationCreatorVideoCountExcluded: videos.length,
                    validationCreatorChannelIds: ['UCfixtureTyler'],
                    featureScorerVersionPersistedPerVideo: false,
                },
                targets: {
                    keep: {
                        points: keepPoints,
                        blindInputs: {
                            featureNames: blindFeatureNames,
                            videoHeldOutProtocol: 'The evaluated video is excluded.',
                            accountHeldOutProtocol: 'The evaluated account is excluded.',
                            rows: videos.map((video, index) => ({
                                id: video.id,
                                videoHeldOut: blindVector(index),
                                accountHeldOut: blindVector(index).map((value, featureIndex) => featureIndex % 2 ? value : value - .5),
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
            sourceFingerprint: 'ui-fixture',
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
        assert(lineageText.includes("Tyler Csatari private Shorts with observed stayed-to-watch labels"), 'score detail must expose the keep-axis fitting population');
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
        assert((await page.locator('[data-savedledger]').innerText()).includes('Long Quant outputs'), 'the registry summary must include the 12 Long Quant outputs');
        const ledgerDownloadPromise = page.waitForEvent('download');
        await page.locator('[data-savedledgerexport]').click();
        const ledgerDownload = await ledgerDownloadPromise;
        assert.strictEqual(ledgerDownload.suggestedFilename(), `${channelId}-canonical-score-ledger.csv`);
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
        await page.getByText('Tyler + Hafu blind validation', { exact: true }).waitFor();
        assert.strictEqual(await page.getByText('BLIND INPUT ARRAY AUDIT PASSED', { exact: true }).count(), 1);
        assert((await page.getByText(/1 validation creator · 20 additional creator-resolved videos excluded · 0 creator overlap/).count()) === 1, 'the UI must expose the whole-creator leakage audit');
        assert.strictEqual(await page.getByText('21 scores × every observed outcome', { exact: true }).count(), 1);
        assert.strictEqual(await page.getByText('Video-by-video audit trail', { exact: true }).count(), 1);
        assert.strictEqual(await page.getByText('Where this number came from', { exact: true }).count(), 1);
        assert.strictEqual(await page.getByText('Retention path · every measured second through 20', { exact: true }).count(), 1);
        assert.strictEqual(await page.locator('[data-savedvalidationtarget]').count(), 13, 'all observed outcomes and curve checkpoints must be selectable');
        assert.strictEqual(await page.locator('[data-savedvalidationfeature]').count(), 21, 'the matrix must preserve all 21 upload scores');
        assert((await page.locator('circle[data-savedvalidationrow]').count()) >= videos.length, 'selected relationship plot must expose every matched video');
        await page.locator('[data-savedvalidationprotocol="stored"]').click();
        await page.locator('[data-savedvalidationtarget="keep"]').click();
        await page.locator('[data-savedvalidationfeature="text.ret5"]').click();
        await page.getByText('text.ret5 → Stayed to watch', { exact: true }).waitFor();
        const crossTargetPoint = page.locator('circle[data-savedvalidationrow="vid00000002"]').first();
        const crossTargetTooltip = await crossTargetPoint.locator('title').textContent();
        assert(crossTargetTooltip.includes('text.ret5:'), 'cross-target hover must name the plotted score coordinate');
        assert(crossTargetTooltip.includes('Actual Stayed to watch:'), 'cross-target hover must name the independent outcome');
        assert(crossTargetTooltip.includes('Y coordinate ID: shorts.stored.text.ret5'));
        assert(crossTargetTooltip.includes('X outcome ID: shorts.observed.keep'));
        await crossTargetPoint.click();
        const crossTargetContext = page.locator('[data-savedvalidationcontext]');
        await crossTargetContext.waitFor();
        assert.strictEqual(await crossTargetContext.getAttribute('data-coordinate-id'), 'shorts.stored.text.ret5');
        assert.strictEqual(await crossTargetContext.getAttribute('data-coordinate-target'), 'ret5');
        assert.strictEqual(await crossTargetContext.getAttribute('data-outcome-id'), 'shorts.observed.keep');
        assert.strictEqual(await crossTargetContext.getAttribute('data-plotted-raw'), String(videos[1].features['text.ret5'][0]));
        assert.strictEqual(await crossTargetContext.getAttribute('data-stored-reference-raw'), String(videos[1].features['text.ret5'][0]));
        assert((await crossTargetContext.innerText()).toLowerCase().includes('5s retention'), 'the plotted percentage must be labeled as 5-second retention rather than keep rate');
        await page.locator('[data-savedvalidationprotocol="video"]').click();
        await page.locator('[data-savedvalidationtarget="views"]').click();
        await page.locator('[data-savedvalidationfeature="together.views"]').click();
        await page.getByText('together.views → Current lifetime views', { exact: true }).waitFor();
        const blindViewsPoint = page.locator('circle[data-savedvalidationrow="vid00000002"]').first();
        const blindViewsTooltip = await blindViewsPoint.locator('title').textContent();
        assert(blindViewsTooltip.includes('together.views:'), 'the hover must name the exact selected coordinate');
        assert(blindViewsTooltip.includes('Actual Current lifetime views:'), 'the hover must name the independently observed outcome');
        await blindViewsPoint.click();
        await page.getByText('Raw observed curve', { exact: true }).waitFor();
        assert.strictEqual(await page.getByText('Same video · normalized actual vs prediction', { exact: true }).count(), 1);
        await page.locator('[data-savedvalidationprotocol="stored"]').click();
        const storedViewsTooltip = await page.locator('circle[data-savedvalidationrow="vid00000002"]').first().locator('title').textContent();
        assert(storedViewsTooltip.includes('together.views: 12.00M'), 'stored matrix plot must preserve the exact score-card view-equivalent');
        const auditVideo = page.locator(`span[data-savedvalidationrow="vid00000002"]`).first().locator('xpath=ancestor::tr');
        await auditVideo.locator('[data-savedvalidationvideo]').click();
        const validationContext = page.locator('[data-savedvalidationcontext]');
        await validationContext.waitFor();
        const contextText = await validationContext.innerText();
        assert.strictEqual(await validationContext.getAttribute('data-stored-reference-raw'), '12000000', 'the context panel must select the same persisted Both.views coordinate as the clicked point');
        assert.strictEqual(await validationContext.getAttribute('data-loaded-card-raw'), '12000000', 'the loaded card must expose the same raw Both.views coordinate');
        assert.strictEqual(await validationContext.getAttribute('data-card-parity'), 'match', 'parity may only be labeled exact when the raw values actually match');
        assert(contextText.includes('12.00M'), 'opening the original graph must retain the exact stored Both.views score');
        assert(contextText.includes('exact raw-value match'), 'the validation artifact and stored score card must agree exactly');
        await page.waitForFunction(id => {
            const image = document.querySelector('#rtg-exppanel img[style*="width:260px"]');
            return image && image.src.includes(id);
        }, 'vid00000002');
        if (process.env.EXPERIMENT_LAB_CONTEXT_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_CONTEXT_SCREENSHOT), { recursive: true });
            await validationContext.screenshot({ path: process.env.EXPERIMENT_LAB_CONTEXT_SCREENSHOT });
        }
        assert.strictEqual(await page.evaluate(pathname => window.__fetchCounts[pathname], videoPath), 1, 'reopening an older cached validation video must not fetch or recompute it again');
        await page.locator('[data-savedvalidationprotocol="account"]').click();
        assert.strictEqual(await page.getByText('18 direct scores · account external:', { exact: false }).count(), 1);
        await page.locator('[data-savedvalidationexpand]').first().click();
        assert.strictEqual(await page.getByText('All 21 stored channel scores · diagnostic replay', { exact: true }).count(), 1);
        assert.strictEqual(await page.evaluate(() => window.__fetchCounts['/api/raw/embed-montage'] || 0), 0, 'validation inspection must never recalculate a stored embedding');
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
        console.log(JSON.stringify({ ok: true, sharedExperimentControls: 5, desktopWidth: 1280, mobileWidth: 390, mobileScrollTop: await workspace.evaluate(element => element.scrollTop), storedImage: true, exactIndicatorSort: 'text.keep', savedArtifactFetches: 1, resumeRequests: 1, matrixColumns: 21, relationshipCells: 441, trajectoryCharts: 21, riskSignalCharts: riskSignals.length, riskThreshold: '30M', blindValidationRows: videos.length, embeddingParity: finalParity }));
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
