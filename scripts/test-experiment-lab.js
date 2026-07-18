#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:8002';

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
        const channelId = 'ch0123456789abcdef';
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
        const replies = {
            '/api/retention/channels': { channels: [], active: 'tyler' },
            '/api/indicators/registry': { indicators: [], meta: { targets: [] } },
            '/api/raw/saved-hooks': { hooks: [] },
            '/api/raw/saved-channels': { channels: [{ id: channelId, name: 'Mobile Risk Channel', url: 'https://youtube.com/@risk', status: 'partial', discovered: 21, completed: 20, failed: 1 }], featureContract },
            [`/api/raw/saved-channel/${channelId}`]: { id: channelId, name: 'Mobile Risk Channel', url: 'https://youtube.com/@risk', status: 'partial', discovered: 21, completed: 20, failed: 1, queued: 0, videos: videos.concat(unfinishedVideo), featureContract },
            [`/api/raw/saved-channel/${channelId}/analysis`]: riskAnalysis,
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
                input_manifest: { domain: 'shorts_raw', source_window: 'first 5 seconds', display_preference: ['together', 'text', 'visual'] },
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
        await page.locator(`[data-savedchannelvideo="${channelId}:vid00000002"]`).click();
        assert.strictEqual(await page.evaluate(pathname => window.__fetchCounts[pathname], videoPath), 1, 'opening the same saved Short again must use the in-memory stored-artifact cache');

        await page.locator(`[data-savedchannelresume="${channelId}"]`).click();
        const resumePath = `/api/raw/saved-channel/${channelId}/resume`;
        await page.waitForFunction(pathname => window.__fetchCounts[pathname] === 1, resumePath);
        await page.getByText('Prediction analysis', { exact: true }).click();
        try {
            await page.getByText('Execution risk · can an embedding score justify making the video?', { exact: true }).waitFor();
        } catch (error) {
            console.error('ANALYSIS PANEL:', (await page.locator('#rtg-exppanel').innerText()).slice(-3000));
            throw error;
        }
        assert.strictEqual(await page.getByText('≥ 30.00M', { exact: true }).count(), 1, 'risk table must expose literal normal-views embedding thresholds');
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
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 390, scroll: 390 });
        if (process.env.EXPERIMENT_LAB_SCREENSHOT) {
            fs.mkdirSync(path.dirname(process.env.EXPERIMENT_LAB_SCREENSHOT), { recursive: true });
            await page.screenshot({ path: process.env.EXPERIMENT_LAB_SCREENSHOT, fullPage: false });
        }
        console.log(JSON.stringify({ ok: true, sharedExperimentControls: 5, desktopWidth: 1280, mobileWidth: 390, mobileScrollTop: await workspace.evaluate(element => element.scrollTop), storedImage: true, exactIndicatorSort: 'text.keep', savedArtifactFetches: 1, resumeRequests: 1, matrixColumns: 21, relationshipCells: 441, trajectoryCharts: 21, riskSignalCharts: riskSignals.length, riskThreshold: '30M' }));
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
