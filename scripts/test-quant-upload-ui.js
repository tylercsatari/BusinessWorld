#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const helperPath = path.join(ROOT, 'buildings/jarvis/jarvis-upload-utils.js');
const longPath = path.join(ROOT, 'buildings/jarvis/jarvis-longquant.js');
const shortPath = path.join(ROOT, 'buildings/jarvis/jarvis-retention.js');
const LIVE_ORIGIN = 'http://127.0.0.1:8002';

function liveHarness(kind) {
    const isLong = kind === 'long';
    const empty = isLong ? {
        '/api/longquant/channels': { channels: [], active: 'tyler' },
        '/api/longquant/thumbs/list': { thumbs: [] },
        '/api/longquant/ideas/runs': { runs: [] },
        '/api/longquant/grind/runs': { runs: [] },
        '/api/longquant/grind/status': { ok: true, runningNow: [], active: [], counts: {} },
    } : {
        '/api/retention/channels': { channels: [], active: 'main' },
        '/api/indicators/registry': { indicators: [], meta: { targets: [] } },
        '/api/raw/saved-hooks': { hooks: [] },
        '/api/hooks/grind/runs': { runs: [] },
    };
    const replies = isLong ? {
        '/api/longquant/exp/generate': { ok: false, error: 'verification request captured' },
        '/api/longquant/exp/score-upload': { error: 'verification request captured' },
        '/api/longquant/exp/score-title': { error: 'verification request captured' },
        '/api/longquant/grind/start': { ok: false, error: 'verification request captured' },
    } : {
        '/api/hooks/warmup': { ok: true, fired: false },
        '/api/hooks/generate': { error: 'verification request captured' },
        '/api/hooks/grind': { error: 'verification request captured' },
        '/api/raw/embed-montage': { error: 'verification request captured' },
    };
    const extras = isLong ? '<script src="/buildings/jarvis/promise-lab-ui.js"></script>' : '';
    const modulePath = isLong ? '/buildings/jarvis/jarvis-longquant.js' : '/buildings/jarvis/jarvis-retention.js';
    const mount = isLong ? 'JarvisLongQuant' : 'JarvisRetention';
    return `<!doctype html><html><head><meta charset="utf-8"><base href="${LIVE_ORIGIN}/"><style>html,body{margin:0;background:#020617}</style></head>
<body><main id="root"></main><script src="/buildings/jarvis/jarvis-upload-utils.js"></script>${extras}
<script>const nativeFetch=window.fetch.bind(window);const empty=${JSON.stringify(empty)};const replies=${JSON.stringify(replies)};window.__quantRequests=[];window.fetch=function(url,options){const path=new URL(url,location.href).pathname;const method=String(options&&options.method||'GET').toUpperCase();if(method!=='GET'){let body=options&&options.body;try{body=typeof body==='string'?JSON.parse(body):body}catch(error){}window.__quantRequests.push({path,method,body})}const payload=empty[path]||replies[path];if(payload)return Promise.resolve(new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}}));return nativeFetch(url,options)};</script>
<script src="${modulePath}"></script><script>window.${mount}.mount(document.getElementById('root'));</script></body></html>`;
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<main id="quant-panel"><button id="pick-image">Choose image</button></main>');
        await page.addScriptTag({ path: helperPath });
        await page.evaluate(() => {
            window.uploadResult = null;
            document.getElementById('pick-image').addEventListener('click', () => {
                window.JarvisUpload.pickFiles({
                    accept: 'image/jpeg,image/png,image/webp',
                    onSelect: async files => {
                        const prepared = await window.JarvisUpload.prepareImage(files[0]);
                        window.uploadResult = {
                            name: prepared.name,
                            width: prepared.width,
                            height: prepared.height,
                            image: prepared.dataUrl.startsWith('data:image/'),
                        };
                    },
                    onError: error => { window.uploadResult = { error: error.message }; },
                });
            });
        });

        const chooserPromise = page.waitForEvent('filechooser');
        await page.click('#pick-image');
        const chooser = await chooserPromise;

        // Reproduce the production bug: a status poll redraws and removes the panel
        // while the native picker is open. The persistent body-level input must survive.
        await page.evaluate(() => {
            document.getElementById('quant-panel').outerHTML = '<main id="quant-panel">redrawn while picker was open</main>';
        });
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIA5QH7WQAAAABJRU5ErkJggg==', 'base64');
        await chooser.setFiles({ name: 'thumbnail.png', mimeType: 'image/png', buffer: png });
        await page.waitForFunction(() => window.uploadResult !== null);
        const selected = await page.evaluate(() => window.uploadResult);
        assert.deepStrictEqual(selected, { name: 'thumbnail.png', width: 1, height: 1, image: true });

        const resized = await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 2000;
            canvas.height = 1125;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#1d4ed8';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const file = new File([blob], 'large-thumbnail.png', { type: 'image/png' });
            const out = await window.JarvisUpload.prepareImage(file, { maxWidth: 1600, maxHeight: 900, maxDataUrlChars: 2800000 });
            return { width: out.width, height: out.height, chars: out.dataUrl.length, type: out.dataUrl.slice(0, 23) };
        });
        assert.deepStrictEqual({ width: resized.width, height: resized.height }, { width: 1600, height: 900 });
        assert(resized.chars <= 2800000, 'prepared thumbnail must stay within the request-memory budget');
        assert(resized.type.startsWith('data:image/jpeg'), 'large uploads should be normalized to JPEG');

        const longSource = fs.readFileSync(longPath, 'utf8');
        const shortSource = fs.readFileSync(shortPath, 'utf8');
        assert(longSource.includes('data-lqxchooseimage'), 'Long Quant score control must invoke the stable chooser');
        assert(longSource.includes("'/api/longquant/exp/score-upload'"), 'Long Quant thumbnail score endpoint must remain wired');
        assert(longSource.includes("'/api/longquant/exp/score-title'"), 'Long Quant title test endpoint must remain wired');
        assert(longSource.includes("'/api/longquant/exp/generate'"), 'Long Quant generation endpoint must remain wired');
        assert(longSource.includes("'/api/longquant/grind/start'"), 'Long Quant grind endpoint must remain wired');
        assert(!longSource.includes('id="lqx-file"'), 'Long Quant must not restore the redraw-prone nested file input');
        assert(longSource.includes('openLongRawVideoPicker') && longSource.includes('openLongRawFramePicker'), 'Long Quant raw upload controls must use the shared picker');
        assert(shortSource.includes('openRawVideoPicker') && shortSource.includes('openRawFramePicker'), 'Shorts Quant upload controls must use the shared picker');
        assert(!shortSource.includes('id="rawUpFile"') && !shortSource.includes('id="rawFrameFile"'), 'Shorts Quant must not restore redraw-prone nested file inputs');

        let live = null;
        if (process.argv.includes('--live')) {
            const livePage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            await livePage.goto(`${LIVE_ORIGIN}/buildings/jarvis/jarvis-upload-utils.js`, { waitUntil: 'domcontentloaded' });
            await livePage.setContent(liveHarness('long'), { waitUntil: 'domcontentloaded' });
            const experiment = livePage.locator('[data-rs="experiment"]');
            await experiment.waitFor({ state: 'visible', timeout: 30000 });
            await experiment.click();
            const choose = livePage.locator('[data-lqxchooseimage]');
            await choose.waitFor({ state: 'visible', timeout: 15000 });
            const chooserEvent = livePage.waitForEvent('filechooser');
            await choose.click();
            const liveChooser = await chooserEvent;
            await liveChooser.setFiles({ name: 'thumbnail.png', mimeType: 'image/png', buffer: png });
            await livePage.getByText('ready to score', { exact: false }).waitFor({ state: 'visible', timeout: 15000 });
            await livePage.locator('[data-lqxscoretitle]').fill('Holding my breath surrounded by sharks');

            // Long Quant status updates repaint this panel every six seconds. The selected
            // image and its score-ready state must still be present after that repaint.
            await livePage.waitForTimeout(7000);
            const ready = await livePage.getByText('ready to score', { exact: false }).count();
            const preview = await livePage.locator('img[src^="data:image/"]').count();
            const longLive = {
                ready,
                preview,
                chooseLabel: await choose.textContent(),
                title: await livePage.locator('[data-lqxscoretitle]').inputValue(),
                scoreControls: await livePage.locator('[data-lqxscore]').count(),
                titleControls: await livePage.locator('[data-lqxtitletest]').count(),
                generateControls: await livePage.locator('[data-lqxgen]').count(),
                grindControls: await livePage.locator('[data-lqxgrindstart]').count(),
            };
            assert.strictEqual(longLive.ready, 1, 'actual Long Quant score card lost its ready state after a poll repaint');
            assert(longLive.preview >= 1, 'actual Long Quant score card did not render the selected image');
            assert.strictEqual(longLive.chooseLabel.trim(), 'Replace image');
            assert.strictEqual(longLive.title, 'Holding my breath surrounded by sharks');
            assert.deepStrictEqual(
                { score: longLive.scoreControls, title: longLive.titleControls, generate: longLive.generateControls, grind: longLive.grindControls },
                { score: 1, title: 1, generate: 1, grind: 1 }
            );

            await livePage.locator('[data-lqxtitle]').fill('Build a submarine out of glass');
            await livePage.locator('[data-lqxcount="3"]').click();
            await livePage.locator('[data-lqxgen]').click();
            await livePage.locator('[data-lqxscore]').click();
            await livePage.locator('[data-lqxtitletestinput]').fill('I Built a Glass Submarine');
            await livePage.locator('[data-lqxtitletest]').click();
            await livePage.locator('[data-lqxgrindidea]').fill('Holding my breath surrounded by sharks');
            await livePage.locator('[data-lqxgrindthreshold]').fill('91');
            await livePage.locator('[data-lqxgrindmax]').fill('7');
            await livePage.locator('[data-lqxgrindstart]').click();
            await livePage.waitForFunction(() => window.__quantRequests.filter(r => [
                '/api/longquant/exp/generate', '/api/longquant/exp/score-upload',
                '/api/longquant/exp/score-title', '/api/longquant/grind/start',
            ].includes(r.path)).length === 4);
            const longRequests = await livePage.evaluate(() => window.__quantRequests.filter(r => r.method === 'POST'));
            const longByPath = Object.fromEntries(longRequests.map(request => [request.path, request.body]));
            assert.deepStrictEqual(longByPath['/api/longquant/exp/generate'], { title: 'Build a submarine out of glass', count: 3 });
            assert.strictEqual(longByPath['/api/longquant/exp/score-upload'].title, 'Holding my breath surrounded by sharks');
            assert(longByPath['/api/longquant/exp/score-upload'].image.startsWith('data:image/'));
            assert.deepStrictEqual(longByPath['/api/longquant/exp/score-title'], { title: 'I Built a Glass Submarine' });
            assert.deepStrictEqual(longByPath['/api/longquant/grind/start'], {
                idea: 'Holding my breath surrounded by sharks', threshold: '91', maxAttempts: '7', count: 3,
            });
            longLive.requests = {
                generate: longByPath['/api/longquant/exp/generate'],
                score: { title: longByPath['/api/longquant/exp/score-upload'].title, hasImage: true },
                title: longByPath['/api/longquant/exp/score-title'],
                grind: longByPath['/api/longquant/grind/start'],
            };
            await livePage.close();

            const shortsPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            await shortsPage.goto(`${LIVE_ORIGIN}/buildings/jarvis/jarvis-upload-utils.js`, { waitUntil: 'domcontentloaded' });
            await shortsPage.setContent(liveHarness('shorts'), { waitUntil: 'domcontentloaded' });
            const shortsExperiment = shortsPage.locator('[data-rs="experiment"]');
            await shortsExperiment.waitFor({ state: 'visible', timeout: 30000 });
            await shortsExperiment.click();
            const videoUploadControls = await shortsPage.locator('[data-rawupload]').count();
            await shortsPage.locator('#exp-gen-input').fill('A helmet that survives a flamethrower');
            await shortsPage.locator('[data-expgenn="2"]').click();
            await shortsPage.locator('[data-expgen]').click();
            await shortsPage.locator('#grind-input').fill('A helmet that survives a flamethrower');
            await shortsPage.locator('[data-grindstart]').click();
            await shortsPage.locator('[data-rawbuildmode="1"]').click();
            const frameSlot = shortsPage.locator('[data-rawframe="0"]');
            await frameSlot.waitFor({ state: 'visible', timeout: 15000 });
            const shortsChooserEvent = shortsPage.waitForEvent('filechooser');
            await frameSlot.click();
            const shortsChooser = await shortsChooserEvent;
            await shortsChooser.setFiles({ name: 'hook-frame.png', mimeType: 'image/png', buffer: png });
            await shortsPage.locator('img[src^="data:image/"]').waitFor({ state: 'visible', timeout: 15000 });
            await shortsPage.locator('[data-rawtext]').fill('A fireproof helmet survives the test');
            await shortsPage.locator('[data-rawplace]').click();
            await shortsPage.waitForFunction(() => window.__quantRequests.filter(r => [
                '/api/hooks/generate', '/api/hooks/grind', '/api/raw/embed-montage',
            ].includes(r.path)).length === 3);
            const shortsRequests = await shortsPage.evaluate(() => window.__quantRequests.filter(r => r.method === 'POST'));
            const shortsByPath = Object.fromEntries(shortsRequests.map(request => [request.path, request.body]));
            const shortsLive = {
                videoUploadControls,
                framePreviews: await shortsPage.locator('img[src^="data:image/"]').count(),
                hiddenInputs: await shortsPage.locator('#rawUpFile,#rawFrameFile').count(),
                generateControls: await shortsPage.locator('[data-expgen]').count(),
                grindControls: await shortsPage.locator('[data-grindstart]').count(),
                scoreControls: await shortsPage.locator('[data-rawplace]').count(),
                requests: {
                    generate: shortsByPath['/api/hooks/generate'],
                    grind: shortsByPath['/api/hooks/grind'],
                    score: {
                        hasMontage: !!(shortsByPath['/api/raw/embed-montage'] && shortsByPath['/api/raw/embed-montage'].montage),
                        text: shortsByPath['/api/raw/embed-montage'] && shortsByPath['/api/raw/embed-montage'].text,
                    },
                },
            };
            assert.strictEqual(shortsLive.videoUploadControls, 1);
            assert.strictEqual(shortsLive.framePreviews, 1);
            assert.strictEqual(shortsLive.hiddenInputs, 0);
            assert.strictEqual(shortsLive.generateControls, 1);
            assert.strictEqual(shortsLive.grindControls, 1);
            assert.strictEqual(shortsLive.scoreControls, 1);
            assert.deepStrictEqual(shortsByPath['/api/hooks/generate'], {
                premise: 'A helmet that survives a flamethrower', count: 2, invent: false,
            });
            assert.deepStrictEqual(shortsByPath['/api/hooks/grind'], {
                premise: 'A helmet that survives a flamethrower', threshold: 82, metric: 'keep', hours: 3,
            });
            assert(shortsLive.requests.score.hasMontage, 'Shorts score request must include its composed hook image');
            assert.strictEqual(shortsLive.requests.score.text, 'A fireproof helmet survives the test');
            await shortsPage.close();
            live = { longQuant: longLive, shortsQuant: shortsLive };
        }

        console.log(JSON.stringify({ ok: true, selected, resized, live, contracts: { longQuant: true, shortsQuant: true } }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
