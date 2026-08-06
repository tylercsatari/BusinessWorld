#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({
            viewport: { width: 390, height: 844 },
        });
        await page.setContent(
            '<!doctype html><html><body><main id="root"></main></body></html>'
        );
        await page.evaluate(() => {
            const empty = {
                '/api/retention/channels': {
                    channels: [],
                    active: 'main',
                },
                '/api/indicators/registry': {
                    indicators: [],
                    meta: { targets: [] },
                },
                '/api/raw/saved-hooks': { hooks: [] },
                '/api/raw/saved-channels': {
                    channels: [],
                    featureContract: { groups: [], features: [] },
                },
                '/api/hooks/grind/runs': { runs: [] },
                '/api/hooks/elite-corpus': {
                    schema: 'elite-hook-corpus-index-v1',
                    minimum_index_percentile: 80,
                    corpus: { row_count: 66142 },
                    metrics: [
                        {
                            id: 'together_keep_geometry',
                            label: 'Together keep geometry',
                            description: 'Retrieval geometry only.',
                            indexed_elite_count: 13476,
                        },
                        {
                            id: 'observed_views',
                            label: 'Observed views',
                            description: 'Retrospective retrieval only.',
                            indexed_elite_count: 13682,
                        },
                    ],
                    channels: [{
                        id: 'tyler-channel',
                        name: 'Tyler Csatari',
                        corpus_match_count: 415,
                    }],
                },
            };
            window.__autoRequests = [];
            window.fetch = async (url, options) => {
                const pathname = String(url).split('?')[0];
                const method = String(
                    options && options.method || 'GET'
                ).toUpperCase();
                if (method !== 'GET') {
                    let body = options && options.body;
                    try {
                        body = typeof body === 'string'
                            ? JSON.parse(body)
                            : body;
                    } catch (error) {}
                    window.__autoRequests.push({
                        pathname,
                        method,
                        body,
                    });
                }
                const payload = empty[pathname]
                    || (pathname === '/api/hooks/generate'
                        ? { error: 'captured generate request' }
                        : pathname === '/api/hooks/grind'
                            ? { error: 'captured grind request' }
                            : pathname === '/api/hooks/warmup'
                                ? { ok: true }
                                : {});
                return new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            };
        });
        for (const file of [
            'buildings/jarvis/storyboard-style-presets.js',
            'buildings/jarvis/storyboard-workbench.js',
            'buildings/jarvis/jarvis-retention.js',
        ]) {
            await page.addScriptTag({ path: path.join(root, file) });
        }
        await page.evaluate(() => {
            window.JarvisRetention.mountShortsExperiment(
                document.getElementById('root')
            );
        });

        const selectors = page.locator('[data-auto-image-model]');
        await selectors.first().waitFor({ state: 'visible' });
        assert.strictEqual(
            await selectors.count(),
            2,
            'Auto and Grind should render the shared model selector'
        );
        await selectors.first().selectOption('flux-2-pro');
        assert.deepStrictEqual(
            await selectors.evaluateAll(elements => (
                elements.map(element => element.value)
            )),
            ['flux-2-pro', 'flux-2-pro'],
            'one model selection must update both workflows'
        );

        await page.locator('#exp-gen-input').fill(
            'A helmet that survives a flamethrower'
        );
        await page.locator('[data-expgenn="2"]').click();
        await page.locator('[data-expanimation]').check();
        await page.locator('[data-expgen]').click();
        await page.locator('#grind-input').fill(
            'A helmet that survives a flamethrower'
        );
        await page.locator('[data-grindstart]').click();
        await page.waitForFunction(() => (
            window.__autoRequests.filter(request => (
                request.pathname === '/api/hooks/generate'
                || request.pathname === '/api/hooks/grind'
            )).length === 2
        ));
        const requests = await page.evaluate(() => (
            Object.fromEntries(window.__autoRequests.map(request => (
                [request.pathname, request.body]
            )))
        ));
        assert.deepStrictEqual(
            {
                premise: requests['/api/hooks/generate'].premise,
                count: requests['/api/hooks/generate'].count,
                invent: requests['/api/hooks/generate'].invent,
                imageModel:
                    requests['/api/hooks/generate'].imageModel,
                strictImageModel:
                    requests['/api/hooks/generate'].strictImageModel,
                animation:
                    requests['/api/hooks/generate'].animation,
            },
            {
                premise: 'A helmet that survives a flamethrower',
                count: 2,
                invent: false,
                imageModel: 'flux-2-pro',
                strictImageModel: true,
                animation: true,
            }
        );
        assert.strictEqual(
            requests['/api/hooks/grind'].imageModel,
            'flux-2-pro'
        );
        assert.strictEqual(
            requests['/api/hooks/grind'].premise,
            'A helmet that survives a flamethrower'
        );

        await page.locator('[data-grindmode="elite-corpus"]').click();
        await page.locator('[data-grindelitemetric]').waitFor({
            state: 'visible',
        });
        await page.locator('[data-grindelitemetric]').selectOption(
            'observed_views'
        );
        await page.locator('[data-grindelitecutoff]').fill('97');
        await page.locator('[data-grindchanneloriented]').check();
        await page.locator('[data-grindelitechannel]').selectOption(
            'tyler-channel'
        );
        await page.locator('[data-grindanimation]').check();
        await page.locator('#grind-input').fill('');
        await page.locator('[data-grindstart]').click();
        await page.waitForFunction(() => (
            window.__autoRequests.filter(request => (
                request.pathname === '/api/hooks/grind'
            )).length === 2
        ));
        const eliteRequest = await page.evaluate(() => (
            window.__autoRequests.filter(request => (
                request.pathname === '/api/hooks/grind'
            )).at(-1).body
        ));
        assert.deepStrictEqual(
            {
                premise: eliteRequest.premise,
                explorationMode: eliteRequest.explorationMode,
                eliteMetric: eliteRequest.eliteMetric,
                eliteCutoff: eliteRequest.eliteCutoff,
                channelOriented: eliteRequest.channelOriented,
                eliteChannelId: eliteRequest.eliteChannelId,
                animation: eliteRequest.animation,
            },
            {
                premise: '',
                explorationMode: 'elite-corpus',
                eliteMetric: 'observed_views',
                eliteCutoff: 97,
                channelOriented: true,
                eliteChannelId: 'tyler-channel',
                animation: true,
            }
        );
        const dimensions = await page.evaluate(() => ({
            viewport: document.documentElement.clientWidth,
            document: document.documentElement.scrollWidth,
        }));
        assert(
            dimensions.document <= dimensions.viewport + 1,
            'Auto controls must not force horizontal mobile overflow'
        );
        console.log(JSON.stringify({ ok: true, requests, dimensions }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
