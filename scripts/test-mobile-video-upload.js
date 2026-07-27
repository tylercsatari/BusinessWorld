#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium, webkit } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const helperPath = path.join(ROOT, 'buildings/jarvis/jarvis-upload-utils.js');
const retentionPath = path.join(ROOT, 'buildings/jarvis/jarvis-retention.js');

function makeFixture(folder) {
    const output = path.join(folder, 'phone-opening.mp4');
    const result = spawnSync('ffmpeg', [
        '-nostdin', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '10000k', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
        output,
    ], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg fixture failed');
    return output;
}

function startStaticServer(root) {
    const server = http.createServer((request, response) => {
        if (request.url === '/__mobile-upload__') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end('<!doctype html><meta charset="utf-8"><title>mobile upload test</title>');
            return;
        }
        const pathname = decodeURIComponent(String(request.url || '/').split('?')[0]);
        const file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(path.resolve(root) + path.sep)) {
            response.writeHead(403);
            response.end('forbidden');
            return;
        }
        fs.readFile(file, (error, body) => {
            if (error) {
                response.writeHead(404);
                response.end('missing');
                return;
            }
            const type = file.endsWith('.json') ? 'application/json'
                : file.endsWith('.js') ? 'application/javascript'
                    : file.endsWith('.css') ? 'text/css'
                        : 'application/octet-stream';
            response.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
            response.end(body);
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({
            server,
            origin: `http://127.0.0.1:${server.address().port}`,
        }));
    });
}

function mockScore(title, visualOnly) {
    const montage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIA5QH7WQAAAABJRU5ErkJggg==';
    const metric = value => ({ est: value, pctile: value, kind: 'pct' });
    const steer = {
        visual_keep: metric(71),
        visual_ret5: metric(68),
        visual_views: { est: 1200000, pctile: 74, kind: 'logcount' },
        visual_outlier: { est: 2.1, pctile: 70, kind: 'logx' },
        visual_gt10M: { est: 0.18, pctile: 69, kind: 'binary' },
    };
    if (!visualOnly) {
        Object.assign(steer, {
            text_keep: metric(75),
            text_ret5: metric(72),
            together_keep: metric(79),
            together_ret5: metric(76),
        });
    }
    return {
        title,
        montage,
        transcript: visualOnly ? '' : 'This is the exact opening voiceover.',
        silent: !!visualOnly,
        indicators: { content_visual__keep: 0.71 },
        steer,
        emb_preview: { visual: [0.1, 0.2], text: visualOnly ? null : [0.2, 0.3], together: [0.3, 0.4] },
        input_manifest: {
            domain: 'shorts_raw',
            source_window: 'first 5 seconds',
            display_preference: ['together', 'text', 'visual'],
            transcript_used: !visualOnly,
            channels: {
                visual: { present: true, input: '5-frame montage only', image: 'five frames', text: '' },
                text: { present: !visualOnly, input: 'first-5-second transcript only', image: '', text: visualOnly ? '' : 'This is the exact opening voiceover.' },
                together: { present: true, input: visualOnly ? '5-frame montage only because no coherent voiceover was detected' : '5-frame montage plus first-5-second transcript', image: 'five frames', text: visualOnly ? '' : 'This is the exact opening voiceover.' },
            },
        },
        channels: {
            visual: { neighbors: [] },
            text: visualOnly ? null : { neighbors: [] },
            together: { neighbors: [] },
        },
    };
}

async function runUiFlow(browser, origin, fixture, failVideoScore, emulateNoCapture) {
    const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    await page.goto(origin + '/__mobile-upload__', { waitUntil: 'domcontentloaded' });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><base href="${origin}/"><style>html,body{margin:0;background:#020617}</style></head><body><main id="root"></main></body></html>`);
    await page.addScriptTag({ path: helperPath });
    await page.evaluate(({ failVideoScore, fullScore, visualScore, emulateNoCapture }) => {
        if (emulateNoCapture) {
            try { Object.defineProperty(HTMLMediaElement.prototype, 'captureStream', { value: undefined, configurable: true }); } catch (error) {}
            try { Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true }); } catch (error) {}
        }
        const nativeFetch = window.fetch.bind(window);
        const json = value => Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        window.__mobileUploadRequests = [];
        window.fetch = function (url, options) {
            const parsed = new URL(url, location.href);
            const pathname = parsed.pathname;
            const method = String(options && options.method || 'GET').toUpperCase();
            if (method === 'POST') {
                const headers = Object.fromEntries(new Headers(options && options.headers || {}).entries());
                const body = options && options.body;
                window.__mobileUploadRequests.push({
                    pathname,
                    bytes: body && typeof body.size === 'number' ? body.size : String(body || '').length,
                    headers,
                });
            }
            if (pathname === '/api/retention/channels') return json({ channels: [{ id: 'main', name: 'Main' }], active: 'main' });
            if (pathname === '/api/indicators/registry') return json({ indicators: [], meta: { targets: [] } });
            if (pathname === '/api/raw/saved-hooks') return json({ hooks: [] });
            if (pathname === '/api/raw/saved-channels') return json({ channels: [], featureContract: { groups: [], features: [] } });
            if (pathname === '/api/hooks/grind/runs') return json({ runs: [] });
            if (pathname === '/api/hooks/warmup') return json({ ok: true, fired: false });
            if (pathname === '/api/raw/map') return json({ n: 0 });
            if (pathname === '/api/rtg/labels') return json({});
            if (pathname === '/api/raw/embed-upload') return json({ ok: true, jobId: failVideoScore ? 'video-fails' : 'video-ok' });
            if (pathname === '/api/raw/embed-montage') return json({ ok: true, jobId: 'visual-ok' });
            if (pathname === '/api/shortsquant/jobs/video-fails') return json({ status: 'error', error: 'could not read this bounded phone video' });
            if (pathname === '/api/shortsquant/jobs/video-ok') return json({ status: 'done', result: fullScore });
            if (pathname === '/api/shortsquant/jobs/visual-ok') return json({ status: 'done', result: visualScore });
            return nativeFetch(url, options);
        };
    }, {
        failVideoScore,
        emulateNoCapture,
        fullScore: mockScore('phone-opening.mp4', false),
        visualScore: mockScore('phone-opening.mp4', true),
    });
    await page.addScriptTag({ path: retentionPath });
    await page.evaluate(() => window.JarvisRetention.mountExperiment(document.getElementById('root')));
    const upload = page.locator('[data-rawupload]').first();
    await upload.waitFor({ state: 'visible', timeout: 30000 });
    const chooserEvent = page.waitForEvent('filechooser');
    await upload.click();
    const chooser = await chooserEvent;
    await chooser.setFiles(fixture);
    await page.waitForFunction(() => {
        const state = window.JarvisRetention && window.JarvisRetention.__st && window.JarvisRetention.__st();
        return state && state.rawUploads && state.rawUploads.length === 1 && !state.rawUploading;
    }, null, { timeout: 60000 });
    const result = await page.evaluate(() => {
        const state = window.JarvisRetention.__st();
        return {
            error: state.rawUpErr,
            upload: {
                warning: state.rawUploads[0]._uploadWarning || null,
                mode: state.rawUploads[0]._uploadMode || null,
                silent: state.rawUploads[0].silent,
            },
            requests: window.__mobileUploadRequests,
        };
    });
    await page.close();
    return result;
}

async function main() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-mobile-upload-'));
    const fixture = makeFixture(folder);
    const originalBytes = fs.statSync(fixture).size;
    assert(originalBytes > 1024 * 1024, 'fixture must be large enough to trigger the bounded path');

    const staticRoot = process.env.BW_STATIC_ROOT || ROOT;
    const emulateNoCapture = process.env.BW_CAPTURE !== '1';
    const staticServer = await startStaticServer(staticRoot);
    const browserName = String(process.env.BW_BROWSER || 'chromium').toLowerCase();
    const browserType = browserName === 'webkit' ? webkit : chromium;
    const browser = await browserType.launch({ headless: true });
    try {
        const page = await browser.newPage({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        await page.setContent('<input id="video" type="file" accept="video/*"><div id="status"></div>');
        await page.addScriptTag({ path: helperPath });
        await page.evaluate(emulateNoCapture => {
            // Match iPhone Safari's relevant capability boundary: it can seek/draw a
            // local video but does not expose HTMLMediaElement.captureStream().
            if (emulateNoCapture) {
                try { Object.defineProperty(HTMLMediaElement.prototype, 'captureStream', { value: undefined, configurable: true }); } catch (error) {}
                try { Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true }); } catch (error) {}
            }
        }, emulateNoCapture);
        await page.locator('#video').setInputFiles(fixture);
        const prepared = await page.evaluate(async () => {
            const file = document.getElementById('video').files[0];
            const result = await window.JarvisUpload.prepareVideo(file, {
                directBytes: 256 * 1024,
                minHeadBytes: 512 * 1024,
                maxHeadBytes: 2 * 1024 * 1024,
                maxTailBytes: 128 * 1024,
                prefixSeconds: 6,
            });
            const original = new Uint8Array(await file.arrayBuffer());
            const transfer = new Uint8Array(await result.blob.arrayBuffer());
            let headMatches = true;
            let tailMatches = true;
            if (result.sparse) {
                for (let index = 0; index < Math.min(256, result.sparse.headBytes); index++) {
                    if (transfer[index] !== original[index]) headMatches = false;
                }
                for (let index = 0; index < Math.min(256, result.sparse.tailBytes); index++) {
                    if (transfer[transfer.length - 1 - index] !== original[original.length - 1 - index]) tailMatches = false;
                }
            }
            return {
                mode: result.mode,
                originalBytes: result.originalBytes,
                transferBytes: result.transferBytes,
                duration: result.duration,
                headBytes: result.sparse ? result.sparse.headBytes : null,
                tailBytes: result.sparse ? result.sparse.tailBytes : null,
                fallbackMontage: String(result.fallbackMontage || '').startsWith('data:image/jpeg;base64,'),
                headMatches,
                tailMatches,
            };
        });

        assert.strictEqual(prepared.originalBytes, originalBytes);
        assert(prepared.transferBytes < originalBytes, 'phone path must never silently upload the full original');
        assert(prepared.duration > 29 && prepared.duration < 31, 'full duration must survive bounded preparation');
        if (emulateNoCapture) {
            assert.strictEqual(prepared.mode, 'sparse');
            assert(prepared.transferBytes <= 3 * 1024 * 1024, 'test transfer exceeded its explicit bound');
            assert.strictEqual(prepared.fallbackMontage, true, 'phone path must retain a visual recovery montage');
            assert.strictEqual(prepared.headMatches, true, 'bounded transfer did not preserve opening bytes');
            assert.strictEqual(prepared.tailMatches, true, 'bounded transfer did not preserve final metadata bytes');
        }

        const normalUi = await runUiFlow(browser, staticServer.origin, fixture, false, emulateNoCapture);
        assert.strictEqual(normalUi.error, null, 'actual Shorts UI reported an upload error');
        const normalUpload = normalUi.requests.find(request => request.pathname === '/api/raw/embed-upload');
        assert(normalUpload, 'actual Shorts UI did not submit the video score');
        assert(normalUpload.bytes < originalBytes, 'actual Shorts UI silently submitted the full phone original');
        if (emulateNoCapture) {
            assert.strictEqual(normalUpload.headers['x-raw-sparse'], '1');
            assert.strictEqual(Number(normalUpload.headers['x-raw-original-size']), originalBytes);
            assert.strictEqual(normalUi.upload.mode, 'sparse');
        }
        assert.strictEqual(normalUi.upload.silent, false);

        const recoveryUi = await runUiFlow(browser, staticServer.origin, fixture, true, emulateNoCapture);
        assert.strictEqual(recoveryUi.error, null, 'visual recovery should produce a usable score');
        assert(recoveryUi.requests.some(request => request.pathname === '/api/raw/embed-upload'), 'recovery test never attempted the bounded video');
        assert(recoveryUi.requests.some(request => request.pathname === '/api/raw/embed-montage'), 'codec failure did not automatically use the visual recovery');
        assert(recoveryUi.upload.warning && recoveryUi.upload.warning.includes('five visual frames'), 'visual-only recovery was not clearly disclosed');
        assert.strictEqual(recoveryUi.upload.silent, true);

        console.log(JSON.stringify({
            ok: true,
            browser: browserName,
            emulated: emulateNoCapture ? 'phone browser without captureStream' : 'captureStream-capable browser',
            prepared,
            ui: { boundedUpload: normalUi, codecRecovery: recoveryUi },
        }, null, 2));
    } finally {
        await browser.close();
        await new Promise(resolve => staticServer.server.close(resolve));
        fs.rmSync(folder, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
