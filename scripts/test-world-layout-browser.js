#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};

function json(res, status, value) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
}

async function requestBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
    let layout = {
        _layoutSchema: 'business-world-layout-v2',
        _revision: 0,
        _savedAt: null,
        _writer: '',
        _writerSequence: 0,
        _lastMutationId: '',
        buildings: { Jarvis: { x: -24, z: 16 } },
        paths: [],
        trees: [],
        employees: [],
        flags: [],
        penSize: { w: 12, d: 12 },
        finances: { bank: 20000, expenses: 0 },
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/load-layout') {
            json(res, 200, layout);
            return;
        }
        if (url.pathname === '/save-layout' && req.method === 'POST') {
            const command = await requestBody(req);
            if (command.expectedRevision !== layout._revision) {
                json(res, 409, {
                    error: 'stale layout',
                    code: 'world_layout_conflict',
                    current: { revision: layout._revision },
                });
                return;
            }
            layout = {
                ...command.layout,
                _layoutSchema: 'business-world-layout-v2',
                _revision: layout._revision + 1,
                _savedAt: new Date().toISOString(),
                _writer: command.writer,
                _writerSequence: command.writerSequence,
                _lastMutationId: command.mutationId,
            };
            json(res, 200, {
                ok: true,
                schema: layout._layoutSchema,
                revision: layout._revision,
                savedAt: layout._savedAt,
                writer: layout._writer,
                writerSequence: layout._writerSequence,
                mutationId: layout._lastMutationId,
            });
            return;
        }
        if (url.pathname === '/api/auth/config') {
            json(res, 200, {
                url: 'https://example.supabase.co',
                anonKey: 'test-anon-key',
            });
            return;
        }
        if (url.pathname.startsWith('/api/')) {
            json(res, 404, { error: 'not used by layout browser test' });
            return;
        }

        const relative = url.pathname === '/'
            ? 'index.html'
            : decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const file = path.resolve(ROOT, relative);
        if (!file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
        ],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const diagnostics = [];
    page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
            diagnostics.push(`${message.type()}: ${message.text()}`);
        }
    });
    page.on('pageerror', error => diagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed', request => diagnostics.push(
        `requestfailed: ${request.url()} ${request.failure() && request.failure().errorText || ''}`
    ));
    try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => typeof window.__bootApp === 'function', null, { timeout: 20000 });
        await page.evaluate(() => window.__bootApp());
        await page.waitForFunction(
            () => window.__layoutReady && window._bw && window._bw.jarvis,
            null,
            { timeout: 90000 }
        );

        const first = await page.evaluate(async () => {
            await window.toggleEditMode();
            window._bw.jarvis.position.x = 34;
            window._bw.jarvis.position.z = -22;
            await window.toggleEditMode();
            return {
                button: document.getElementById('edit-btn').textContent,
                active: document.getElementById('edit-btn').classList.contains('active'),
                state: window.__layoutPersistence.getState(),
            };
        });
        assert.strictEqual(first.button, 'Edit Mode');
        assert.strictEqual(first.active, false);
        assert.strictEqual(first.state.pending, false);
        assert.strictEqual(first.state.inFlight, false);
        assert.deepStrictEqual(layout.buildings.Jarvis, { x: 34, z: -22 });

        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => typeof window.__bootApp === 'function', null, { timeout: 60000 });
        await page.evaluate(() => window.__bootApp());
        await page.waitForFunction(
            () => window.__layoutReady && window._bw && window._bw.jarvis,
            null,
            { timeout: 90000 }
        );
        const reloaded = await page.evaluate(() => ({
            x: window._bw.jarvis.position.x,
            z: window._bw.jarvis.position.z,
            revision: window.__layoutPersistence.getState().revision,
        }));
        assert.deepStrictEqual(reloaded, { x: 34, z: -22, revision: 1 });

        process.stdout.write(JSON.stringify({
            ok: true,
            editExitWaitedForAcknowledgement: true,
            positionSurvivedReload: true,
            revision: reloaded.revision,
        }) + '\n');
    } catch (error) {
        console.error(`Browser diagnostics:\n${diagnostics.slice(-30).join('\n')}`);
        throw error;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
