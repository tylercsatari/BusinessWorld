#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'buildings/jarvis/jarvis-retention.js');

function plotBundle(channel) {
    const names = ['keep', 'ret5', 'views', 'realviews', 'outlier', 'hi10m'];
    return {
        version: 1,
        channel,
        n: 66157,
        missing: [],
        plots: Object.fromEntries(names.map((name, projectionIndex) => [name, {
            points: Array.from({ length: 96 }, (_, index) => [
                10 + index * 10,
                930 - ((index * 71 + projectionIndex * 29) % 860),
                name === 'hi10m' ? Number(index % 4 === 0) : 20 + index * 3,
            ]),
            zMin: name === 'hi10m' ? 0 : 20,
            zMax: name === 'hi10m' ? 1 : 89,
            colorKind: name === 'hi10m' ? 'binary' : name.includes('views') ? 'views' : 'metric',
            marker: { x: 710, y: 340, percentile: 84.2 },
        }])),
    };
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
        await page.route('http://quant.test/**', route => {
            const url = new URL(route.request().url());
            if (url.pathname.startsWith('/api/raw/saved-montage/')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'image/gif',
                    body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
                });
            }
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><main id="root"></main>' });
        });
        await page.goto('http://quant.test/');
        await page.evaluate(() => {
            const neighbors = [{ id: 'video-a', sim: 0.93 }, { id: 'video-b', sim: 0.87 }];
            const metric = (est, pctile) => ({ est, pctile, kind: 'fixture' });
            const steer = {};
            for (const channel of ['visual', 'text', 'together']) {
                steer[`${channel}_keep`] = metric(81, 84);
                steer[`${channel}_ret5`] = metric(74, 77);
                steer[`${channel}_views`] = metric(12000000, 89);
                steer[`${channel}_realviews`] = metric(8000000, 82);
                steer[`${channel}_outlier`] = metric(4.1, 75);
                steer[`${channel}_gt10M`] = metric(0.63, 88);
            }
            const record = {
                id: 'saved123',
                title: 'A complete saved hook',
                text: 'This machine does something impossible.',
                transcript: 'This machine does something impossible.',
                hasMontage: true,
                silent: false,
                indicators: {},
                steer,
                emb_preview: { visual: [0.1, 0.2], text: [0.3, 0.4], together: [0.5, 0.6] },
                channels: {
                    visual: { neighbors },
                    text: { neighbors },
                    together: { neighbors },
                },
            };
            window.__quantCalls = [];
            window.fetch = async (input, options) => {
                const url = new URL(String(input), location.href);
                window.__quantCalls.push({ path: url.pathname, search: url.search, method: String(options && options.method || 'GET') });
                let body;
                if (url.pathname === '/api/indicators/registry') body = { indicators: [], meta: { targets: [] } };
                else if (url.pathname === '/api/raw/saved-hooks') body = { hooks: [{ id: record.id, title: record.title, hasMontage: true, savedAt: Date.now(), m: {} }], folders: [] };
                else if (url.pathname === '/api/raw/saved-hook/saved123') body = record;
                else if (url.pathname === '/api/raw/plot') body = window[`__${url.searchParams.get('channel')}Plot`];
                else if (url.pathname === '/api/hooks/grind/runs') body = { runs: [] };
                else if (url.pathname === '/api/hooks/warmup') body = { ok: true, fired: false };
                else body = {};
                return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
            };
        });
        await page.evaluate(({ visual, text, together }) => {
            window.__visualPlot = visual;
            window.__textPlot = text;
            window.__togetherPlot = together;
        }, {
            visual: plotBundle('visual'),
            text: plotBundle('text'),
            together: plotBundle('together'),
        });
        await page.addScriptTag({ path: MODULE });
        await page.evaluate(() => window.JarvisRetention.mountExperiment(document.getElementById('root')));
        await page.locator('[data-savedopen="saved123"]').waitFor();
        await page.locator('[data-savedopen="saved123"]').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-compact-quant-plot]').length === 18);

        const result = await page.evaluate(() => ({
            calls: window.__quantCalls,
            compactPlots: document.querySelectorAll('[data-compact-quant-plot]').length,
            circles: document.querySelectorAll('[data-compact-quant-plot] circle').length,
            domNodes: document.querySelectorAll('*').length,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            scoreText: document.body.innerText.includes('A complete saved hook') && document.body.innerText.toLowerCase().includes('keep rate'),
        }));
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/map').length, 0, 'score details must never request a complete Raw map');
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/plot').length, 3, 'one compact request per embedded input channel');
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/saved-hook/saved123').length, 1, 'saved score should hydrate once');
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/saved-montage/saved123').length, 0, 'image delivery must not block saved statistics');
        assert.strictEqual(result.compactPlots, 18);
        assert(result.circles < 2000, `compact plots created too many circles (${result.circles})`);
        assert(result.domNodes < 10000, `mobile detail DOM is unbounded (${result.domNodes})`);
        assert(result.scrollWidth <= result.clientWidth, 'mobile score detail introduced horizontal overflow');
        assert(result.scoreText, 'the complete score read-out did not render');
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
