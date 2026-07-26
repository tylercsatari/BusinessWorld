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
    assert.equal(artifact.schema, 'business-world-principles-atlas-v2');
    assert.equal(artifact.clusterAtlas.maps.length, 6);
    assert.equal(artifact.clusterAtlas.partitionCount, 24);
    assert.ok(artifact.clusterAtlas.maps.every(map => map.partitions.length === 4));
    assert.ok(artifact.clusterAtlas.maps.every(map => map.atlasSample.length > 2_000));
    assert.ok(artifact.surfaces.length >= 13);
    assert.ok(artifact.invariants.length >= 12);
    assert.equal(artifact.verdict.universal, 0);
    assert.ok(artifact.provenance.length >= 30);
    assert.ok(artifact.provenance.every(row => row.sha256?.length === 64));
    assert.equal(artifact.artifactHash?.length, 64);

    const opening = artifact.corpus.promise.opening20s;
    assert.equal(opening.videos, 208);
    assert.ok(opening.tokens > 17_000);
    assert.ok(opening.spans > 790_000);
    assert.ok(opening.components > 2_500);
    assert.ok(opening.edges > 4_700_000);
    assert.ok(opening.medianTimingErrorSeconds < 0.11);
    assert.ok(opening.p95TimingErrorSeconds < 0.30);

    const source = artifact.invariants.find(row => row.id === 'source_opportunity_dominates_cluster_lift');
    assert.ok(source);
    assert.equal(source.status, 'supported_negative');
    assert.ok(source.tests.some(row => row.id === 'unseen_creator_transfer' && row.status === 'fail'));

    const market = artifact.invariants.find(row => row.id === 'external_market_semantics_transfer_to_retention');
    assert.ok(market);
    assert.equal(market.status, 'supported');
    const isolation = market.tests.find(row => row.id === 'external_training_isolation');
    const retentionTransfer = market.tests.find(row => row.id === 'owned_average_retention_transfer');
    const viewsTransfer = market.tests.find(row => row.id === 'owned_views_transfer');
    assert.equal(isolation.value.ownedLabelsUsed, false);
    assert.ok(retentionTransfer.value.spearman > 0.34);
    assert.ok(viewsTransfer.value.spearman < 0.08);

    const factorization = artifact.invariants.find(row => row.id === 'views_factorization');
    assert.ok(factorization.claim.includes('Opportunity'));
    assert.equal(factorization.status, 'synthesis_hypothesis');

    const openingModel = artifact.models.find(row => row.id === 'pooled_opening_curve');
    assert.ok(openingModel.fixed20Second.r2 < 0);
    assert.ok(openingModel.fixed20Second.predictedSd < openingModel.fixed20Second.actualSd / 20);

    const longTransfer = artifact.models.find(row => row.id === 'long_to_short_transfer');
    assert.ok(Object.values(longTransfer.modalities).every(row => row.r2 < 0));

    for (const invariant of artifact.invariants) {
        assert.ok(invariant.boundary);
        assert.ok(invariant.nextFalsifier);
        assert.ok(invariant.tests.length > 0);
        assert.ok(artifact.transformationMatrix.some(row => row.invariantId === invariant.id));
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
  <style>html,body{height:100%;margin:0;background:#080d14}#jarvis-root{height:100%;overflow:auto}</style>
</head>
<body>
  <div id="jarvis-root"></div>
  <script>
    window.BuildingRegistry = { register(name, controller) {
      if (name === 'Jarvis') window.__jarvisController = controller;
    }};
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

async function assertNoOverflow(page, selectors, label) {
    const overflows = await page.evaluate(currentSelectors => currentSelectors.map(selector => {
        const node = document.querySelector(selector);
        return node ? { selector, overflow: node.scrollWidth - node.clientWidth } : null;
    }).filter(Boolean), selectors);
    for (const row of overflows) {
        assert.ok(row.overflow <= 1, `${label}: ${row.selector} overflows by ${row.overflow}px`);
    }
}

async function assertCanvasHasData(page) {
    const result = await page.locator('#pla-atlas-canvas').evaluate(canvas => {
        const context = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const pixels = context.getImageData(0, 0, width, height).data;
        const background = [9, 17, 29];
        let changed = 0;
        for (let index = 0; index < pixels.length; index += 400) {
            if (
                Math.abs(pixels[index] - background[0]) > 8
                || Math.abs(pixels[index + 1] - background[1]) > 8
                || Math.abs(pixels[index + 2] - background[2]) > 8
            ) changed += 1;
        }
        return { width, height, changed };
    });
    assert.ok(result.width > 500);
    assert.ok(result.height > 400);
    assert.ok(result.changed > 10, `atlas canvas appears blank (${JSON.stringify(result)})`);
}

async function runUi(artifact) {
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
        await page.getByRole('heading', { name: artifact.title }).waitFor();
        assert.equal(await page.locator('.pla-invariant-row').count(), artifact.invariants.length);
        assert.equal(await page.locator('.pla-factor-flow article').count(), 4);
        await assertNoOverflow(page, ['body', '#shell', '#root'], 'desktop discoveries');
        await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-discoveries.png'), fullPage: true });

        await page.getByRole('button', { name: 'Whole system', exact: true }).click();
        assert.equal(await page.locator('.pla-surface-row').count(), artifact.surfaces.length);
        assert.ok(await page.locator('.pla-system-graph').count() === 1);

        await page.getByRole('button', { name: 'Cluster atlas', exact: true }).click();
        await page.locator('#pla-atlas-canvas').waitFor();
        await page.waitForTimeout(300);
        await assertCanvasHasData(page);
        assert.equal(await page.locator('[data-atlas-map] option').count(), 6);
        assert.equal(await page.locator('[data-atlas-k] option').count(), 4);
        await page.locator('[data-atlas-map]').selectOption('long:text');
        await page.locator('[data-atlas-projection]').selectOption('views');
        await page.locator('[data-atlas-k]').selectOption('16');
        await page.locator('[data-atlas-color]').selectOption('views');
        await page.waitForTimeout(300);
        await assertCanvasHasData(page);
        await page.locator('#pla-atlas-canvas').click({ position: { x: 400, y: 280 } });
        await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop-atlas.png'), fullPage: true });

        await page.getByRole('button', { name: 'Prediction audit', exact: true }).click();
        assert.equal(await page.locator('.pla-model-list button').count(), artifact.models.length);
        await page.getByText('Owned-hook retention from frozen external text market axis', { exact: true }).click();
        await page.getByText(/average retention · spearman/i).waitFor();

        await page.getByRole('button', { name: 'Evidence ledger', exact: true }).click();
        assert.equal(await page.locator('.pla-opening-audit .pla-stat').count(), 6);
        assert.equal(await page.locator('.pla-transfer-table > div').count(), 4);
        assert.equal(await page.locator('.pla-provenance-table tbody tr').count(), artifact.provenance.length);
        await page.locator('[data-evidence-search]').fill('market-reward');
        assert.ok(await page.locator('.pla-provenance-table tbody tr').count() >= 1);

        await page.getByRole('button', { name: 'Method', exact: true }).click();
        assert.ok(await page.locator('.pla-pipeline > div').count() >= 8);
        assert.ok(await page.locator('.pla-lockboxes > span').count() >= 4);
        assert.deepEqual(errors, []);

        for (const viewport of [
            { name: 'mobile-390', width: 390, height: 844 },
            { name: 'mobile-320', width: 320, height: 700 },
        ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.goto(`${labUrl}?principles_view=discoveries`, { waitUntil: 'networkidle' });
            await page.getByRole('heading', { name: artifact.title }).waitFor();
            await assertNoOverflow(page, ['body', '#shell', '#root'], viewport.name);
            await page.screenshot({ path: path.join(OUTPUT_DIR, `${viewport.name}.png`), fullPage: true });
        }

        await page.setViewportSize({ width: 1440, height: 960 });
        await page.goto(jarvisUrl, { waitUntil: 'networkidle' });
        const principlesTab = page.locator('.jarvis-tab').filter({ hasText: 'Principles' });
        assert.equal(await principlesTab.count(), 1);
        await principlesTab.click();
        await page.getByRole('heading', { name: artifact.title }).waitFor();
        assert.equal(await page.locator('#principles-lab-root .pla-invariant-row').count(), artifact.invariants.length);
        await page.screenshot({ path: path.join(OUTPUT_DIR, 'jarvis-integration.png'), fullPage: true });
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function main() {
    const artifact = assertArtifact();
    await runUi(artifact);
    console.log(`Principles Atlas: ${artifact.surfaces.length} surfaces, ${artifact.clusterAtlas.mapCount} maps, ${artifact.invariants.length} findings`);
    console.log(`Screenshots: ${path.relative(ROOT, OUTPUT_DIR)}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
