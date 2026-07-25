#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(ROOT, 'buildings/jarvis/principles-lab/artifact.json');
const OUTPUT_DIR = path.join(ROOT, 'tmp/principles-lab-qa');

function assertArtifact() {
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
    assert.equal(artifact.schema, 'predictive-abstraction-lab-v1');
    assert.ok(artifact.artifactHash?.length === 64);
    assert.ok(artifact.sources.length >= 9);
    assert.ok(artifact.candidates.length >= 20);
    assert.equal(artifact.summary.universalClaims, 0);
    assert.equal(artifact.summary.domainClaims, 0);
    assert.equal(artifact.summary.transformationCounts.prospective.pass, 0);

    const semantic = artifact.candidates.find(row => row.id === 'system:opening-semantic-increment');
    assert.ok(semantic);
    assert.equal(semantic.status, 'falsified_currently');
    assert.equal(semantic.prerequisites.predictability.state, 'fail');
    assert.ok(semantic.outcomes.strictBlindCandidateVsBaseline.improvementPoints < 0);

    const baseline = artifact.candidates.find(row => row.id === 'system:shorts-opening-decay-baseline');
    assert.ok(baseline);
    assert.equal(baseline.level, 'regional_invariant');
    assert.match(baseline.claimBoundary, /baseline/i);

    for (const id of ['system:known-account-keep', 'system:known-channel-views']) {
        const candidate = artifact.candidates.find(row => row.id === id);
        assert.ok(candidate);
        assert.equal(candidate.prerequisites.persistence.state, 'fail');
        assert.equal(candidate.prerequisites.predictability.state, 'fail');
    }

    const operations = artifact.candidates.filter(row => row.family === 'visual_operations');
    assert.ok(operations.length >= 16);
    assert.ok(operations.every(row => ['mechanism', 'local_invariant'].includes(row.level)));
    assert.ok(operations.every(row => row.pareto?.front >= 1));

    for (const candidate of artifact.candidates) {
        assert.deepEqual(
            Object.keys(candidate.prerequisites).sort(),
            ['distinguishability', 'persistence', 'predictability', 'similarity']
        );
        assert.equal(candidate.transformations.length, artifact.transformations.length);
        assert.ok(candidate.claimBoundary);
        assert.ok(candidate.nextTest);
        assert.equal(candidate.description.mdlEligible, false);
    }
    return artifact;
}

function contentType(filePath) {
    if (filePath.endsWith('.js')) return 'application/javascript';
    if (filePath.endsWith('.css')) return 'text/css';
    if (filePath.endsWith('.json')) return 'application/json';
    return 'text/html';
}

function labHarnessHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/buildings/jarvis/principles-lab.css">
  <style>
    html,body{height:100%;margin:0;background:#080d14}
    #shell{height:100%;overflow:auto;padding:14px;box-sizing:border-box}
  </style>
</head>
<body>
  <div id="shell"><div id="root"></div></div>
  <script src="/buildings/jarvis/principles-lab-ui.js"></script>
  <script>window.JarvisPrinciplesLab.mount(document.getElementById('root'));</script>
</body>
</html>`;
}

function jarvisHarnessHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/buildings/jarvis/jarvis.css">
  <link rel="stylesheet" href="/buildings/jarvis/principles-lab.css">
  <style>
    html,body{height:100%;margin:0;background:#080d14}
    #jarvis-root{height:100%;overflow:auto}
  </style>
</head>
<body>
  <div id="jarvis-root"></div>
  <script>
    window.BuildingRegistry = {
      register(name, controller) {
        if (name === 'Jarvis') window.__jarvisController = controller;
      }
    };
  </script>
  <script src="/buildings/jarvis/principles-lab-ui.js"></script>
  <script src="/buildings/jarvis/jarvis-ui.js"></script>
  <script>window.__jarvisController.open(document.getElementById('jarvis-root'));</script>
</body>
</html>`;
}

async function startServer() {
    const server = http.createServer((request, response) => {
        const clean = decodeURIComponent((request.url || '/').split('?')[0]);
        if (clean === '/' || clean === '/harness.html') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(labHarnessHtml());
            return;
        }
        if (clean === '/jarvis.html') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(jarvisHarnessHtml());
            return;
        }
        const filePath = path.resolve(ROOT, clean.replace(/^\/+/, ''));
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            response.writeHead(404);
            response.end('not found');
            return;
        }
        response.writeHead(200, { 'Content-Type': contentType(filePath) });
        fs.createReadStream(filePath).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        server,
        labUrl: `${baseUrl}/harness.html`,
        jarvisUrl: `${baseUrl}/jarvis.html`,
    };
}

async function assertNoPageOverflow(page, label) {
    const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth - document.body.clientWidth,
        shell: document.getElementById('shell').scrollWidth - document.getElementById('shell').clientWidth,
        root: document.getElementById('root').scrollWidth - document.getElementById('root').clientWidth,
    }));
    assert.ok(overflow.body <= 1, `${label}: body overflow ${overflow.body}px`);
    assert.ok(overflow.shell <= 1, `${label}: shell overflow ${overflow.shell}px`);
    assert.ok(overflow.root <= 1, `${label}: root overflow ${overflow.root}px`);
}

async function runUi() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const { server, labUrl, jarvisUrl } = await startServer();
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(labUrl, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'When is an abstraction justified?' }).waitFor();
        assert.equal(await page.locator('.pl-gate').count(), 4);
        assert.equal(await page.locator('.pl-map-point').count(), 23);
        await assertNoPageOverflow(page, 'desktop map');
        await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-map.png'), fullPage: true });

        await page.getByRole('button', { name: 'Candidate registry' }).click();
        await page.locator('.pl-registry-table').waitFor();
        assert.equal(await page.locator('.pl-registry-table tbody tr').count(), 23);
        await page.locator('[data-pl-status]').selectOption('falsified_currently');
        assert.equal(await page.locator('.pl-registry-table tbody tr').count(), 4);
        await page.locator('[data-pl-clear]').click();

        await page.getByRole('button', { name: 'Transformation survival' }).click();
        await page.locator('.pl-survival-matrix').waitFor();
        assert.equal(await page.locator('.pl-survival-matrix tbody tr').count(), 23);
        await page.locator('[data-pl-transform="source"]').click();
        await page.locator('[data-pl-cell]').first().click();

        await page.getByRole('button', { name: 'Source audit' }).click();
        assert.equal(await page.locator('.pl-source-list > button').count(), 9);
        assert.equal(await page.locator('.pl-quarantine > div').count(), 5);

        await page.getByRole('button', { name: 'Method' }).click();
        assert.equal(await page.locator('.pl-method-grid > div').count(), 4);
        assert.equal(await page.locator('.pl-transform-definitions > div').count(), 11);
        assert.deepEqual(errors, []);

        for (const viewport of [
            { name: 'mobile-390', width: 390, height: 844 },
            { name: 'mobile-320', width: 320, height: 700 },
        ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.goto(labUrl, { waitUntil: 'networkidle' });
            await page.getByRole('heading', { name: 'When is an abstraction justified?' }).waitFor();
            await assertNoPageOverflow(page, viewport.name);
            await page.screenshot({ path: path.join(OUTPUT_DIR, `${viewport.name}.png`), fullPage: true });
        }

        await page.setViewportSize({ width: 1440, height: 960 });
        await page.goto(jarvisUrl, { waitUntil: 'networkidle' });
        const tabs = await page.locator('.jarvis-tab').allTextContents();
        assert.deepEqual(tabs.slice(0, 3).map(text => text.replace(/[^\p{L}\s]/gu, '').trim()), [
            'Shorts Quant',
            'Long Quant',
            'Principles',
        ]);
        await page.getByRole('button', { name: 'Principles' }).click();
        await page.getByRole('heading', { name: 'When is an abstraction justified?' }).waitFor();
        assert.equal(await page.locator('#principles-lab-root .pl-map-point').count(), 23);
        await page.screenshot({ path: path.join(OUTPUT_DIR, 'jarvis-integration.png'), fullPage: true });
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function main() {
    const artifact = assertArtifact();
    await runUi();
    console.log(`Principles Lab contract: ${artifact.candidates.length} candidates, ${artifact.sources.length} sources`);
    console.log(`Screenshots: ${path.relative(ROOT, OUTPUT_DIR)}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
