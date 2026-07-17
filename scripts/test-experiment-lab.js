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
    assert(index.includes("makeClickable(g, 'Experiment Lab')"), '3D Experiment Lab is not registered as clickable');
    assert(index.includes("'Experiment Lab': experimentLab"), 'Experiment Lab is absent from persistent building lookup');

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
        await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
        const replies = {
            '/api/retention/channels': { channels: [], active: 'tyler' },
            '/api/indicators/registry': { indicators: [], meta: { targets: [] } },
            '/api/raw/saved-hooks': { hooks: [] },
            '/api/raw/saved-channels': { channels: [], featureContract: { groups: [], features: [] } },
            '/api/hooks/grind/runs': { runs: [] },
            '/api/hooks/warmup': { ok: true, fired: false },
        };
        await page.setContent(`<!doctype html><html><head><base href="${ORIGIN}/"><link rel="stylesheet" href="/buildings/experimentlab/experimentlab.css"><style>html,body,#root{margin:0;min-height:100%;background:#080d14}</style></head><body><main id="root"></main>
<script src="/buildings/building-registry.js"></script><script src="/buildings/jarvis/jarvis-upload-utils.js"></script>
<script>const nativeFetch=window.fetch.bind(window);const replies=${JSON.stringify(replies)};window.fetch=function(url,options){const p=new URL(url,location.href).pathname;if(replies[p])return Promise.resolve(new Response(JSON.stringify(replies[p]),{status:200,headers:{'Content-Type':'application/json'}}));if(p.includes('/principles/')||p==='/api/raw/map'||p==='/api/rtg/labels')return Promise.resolve(new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));return nativeFetch(url,options)};</script>
<script src="/buildings/jarvis/jarvis-retention.js"></script><script src="/buildings/experimentlab/experimentlab-ui.js"></script><script>BuildingRegistry.get('Experiment Lab').open(document.getElementById('root'));</script></body></html>`, { waitUntil: 'networkidle' });

        await page.getByRole('heading', { name: 'Experiment Lab' }).waitFor();
        await page.getByPlaceholder('type a video idea — or leave blank and the model invents one…').waitFor();
        await page.locator('[data-savedbank="channels"]').click();
        assert.strictEqual(await page.getByPlaceholder('type a video idea — or leave blank and the model invents one…').count(), 1);
        assert.strictEqual(await page.getByPlaceholder("the hook you're writing — every variant stays grounded on this…").count(), 1);
        assert.strictEqual(await page.getByPlaceholder('or paste a YouTube link…').count(), 1);
        assert.strictEqual(await page.getByPlaceholder('https://youtube.com/@channel').count(), 1);
        assert.strictEqual(await page.getByText('Save channel + score every Short', { exact: true }).count(), 1);
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 1280, scroll: 1280 });

        await page.setViewportSize({ width: 390, height: 844 });
        assert.deepStrictEqual(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })), { width: 390, scroll: 390 });
        console.log(JSON.stringify({ ok: true, sharedExperimentControls: 5, desktopWidth: 1280, mobileWidth: 390 }));
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
