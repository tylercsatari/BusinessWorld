#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const QA_DIR = path.join(ROOT, 'tmp', 'predictor-lab-qa');
const RESULTS_PATH = path.join(ROOT, 'buildings', 'jarvis', 'predictor-lab', 'results.json');
const DEFAULT_ORIGIN = process.env.PREDICTOR_LAB_ORIGIN || 'http://127.0.0.1:8002';
const HEADLESS = !process.argv.includes('--headed');
const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844 };

function request(url, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode || 0,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out requesting ${url}`)));
        req.on('error', reject);
    });
}

async function serverIsReady(origin) {
    try {
        const response = await request(`${origin}/buildings/jarvis/jarvis-retention.js`);
        return response.status === 200 && response.body.includes('JarvisRetention');
    } catch (_) {
        return false;
    }
}

async function ensureServer(origin) {
    if (await serverIsReady(origin)) return { child: null, reused: true };

    const parsed = new URL(origin);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const output = [];
    const child = spawn(process.execPath, ['--max-old-space-size=1024', 'server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: port },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const remember = chunk => {
        output.push(String(chunk));
        if (output.length > 80) output.shift();
    };
    child.stdout.on('data', remember);
    child.stderr.on('data', remember);

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Local server exited ${child.exitCode}:\n${output.join('').slice(-5000)}`);
        }
        if (await serverIsReady(origin)) return { child, reused: false };
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    child.kill('SIGTERM');
    throw new Error(`Local server did not become ready at ${origin}:\n${output.join('').slice(-5000)}`);
}

function stopServer(child) {
    if (!child || child.exitCode !== null || child.killed) return;
    child.kill('SIGTERM');
}

function harnessHtml(origin) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <base href="${origin}/">
  <link rel="stylesheet" href="/buildings/jarvis/jarvis.css">
  <style>
    * { box-sizing: border-box; }
    html, body, #qa-root { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #050914; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
</head>
<body>
  <main id="qa-root"></main>
  <script src="/buildings/building-registry.js"></script>
  <script src="/buildings/jarvis/jarvis-upload-utils.js"></script>
  <script src="/buildings/jarvis/jarvis-retention.js"></script>
  <script src="/buildings/jarvis/jarvis-ui.js"></script>
  <script>
    BuildingRegistry.get('Jarvis').open(document.getElementById('qa-root'));
  </script>
</body>
</html>`;
}

async function installRoutes(page, origin, artifact) {
    await page.route(`${origin}/__predictor_lab_ui_qa__`, route => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><title>Predictor Lab QA origin</title>',
    }));

    await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (
            /^\/api\/raw\/montage\/[^/]+$/.test(url.pathname)
            || /^\/api\/raw\/saved-channel\/[^/]+\/montage\/[^/]+$/.test(url.pathname)
        ) {
            return route.fulfill({
                status: 200,
                contentType: 'image/svg+xml',
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="100" viewBox="0 0 500 100"><rect width="500" height="100" fill="#131c30"/><rect width="166" height="100" fill="#164e63"/><rect x="166" width="168" height="100" fill="#1e3a5f"/><rect x="334" width="166" height="100" fill="#134e4a"/><text x="250" y="57" fill="#e2e8f0" font-family="system-ui,sans-serif" font-size="18" text-anchor="middle">QA montage fixture</text></svg>',
            });
        }
        let payload;
        if (url.pathname === '/api/raw/predictor-lab') {
            payload = artifact;
        } else if (url.pathname === '/api/raw/predictor-lab/status') {
            payload = {
                version: 1,
                stage: 'complete',
                updatedAt: artifact.generatedAt || Date.now(),
                message: 'Persisted predictor artifact is ready.',
                analysis: { stage: 'complete', updatedAt: artifact.generatedAt || Date.now() },
                embedding: { stage: 'idle', updatedAt: artifact.generatedAt || Date.now() },
            };
        } else if (url.pathname === '/api/retention/channels') {
            payload = { channels: [], active: 'tyler' };
        } else if (url.pathname === '/api/indicators/registry') {
            payload = { indicators: [], meta: { targets: [] } };
        } else if (url.pathname === '/api/raw/map') {
            payload = {};
        } else if (url.pathname === '/api/rtg/labels') {
            payload = {};
        } else if (url.pathname === '/api/raw/saved-hooks') {
            payload = { hooks: [] };
        } else if (url.pathname === '/api/raw/saved-channels') {
            payload = { channels: [], featureContract: { groups: [], features: [] } };
        } else if (url.pathname === '/api/hooks/grind/runs') {
            payload = { runs: [] };
        } else {
            payload = {};
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(payload),
        });
    });
}

async function openPredictorLab(page, origin) {
    await page.goto(`${origin}/__predictor_lab_ui_qa__`, { waitUntil: 'domcontentloaded' });
    await page.setContent(harnessHtml(origin), { waitUntil: 'domcontentloaded' });

    const shortsTab = page.locator('.jarvis-tab[data-tab="retention"]');
    await shortsTab.waitFor({ state: 'visible', timeout: 45000 });
    await shortsTab.click();
    await page.locator('[data-rs="raw"]').waitFor({ state: 'visible', timeout: 45000 });
    await page.locator('[data-rs="raw"]').click();
    await page.locator('#rtg-rawpanel [data-rawview="predictor"]').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#rtg-rawpanel [data-rawview="predictor"]').click();
    await page.getByText('Two separate missions: predict private keep rate and public views before upload.', { exact: false })
        .waitFor({ state: 'visible', timeout: 30000 });
}

async function waitForTarget(page, target) {
    await page.waitForFunction(expected => (
        window.JarvisRetention
        && window.JarvisRetention.__st
        && window.JarvisRetention.__st().rawPredictorTarget === expected
    ), target);

    const targetSelector = `[data-predictortarget="${target}"]`;
    await page.locator(targetSelector).waitFor({ state: 'visible' });
    const inactive = target === 'keep' ? 'views' : 'keep';
    assert.strictEqual(
        await page.locator(targetSelector).getAttribute('aria-selected'),
        'true',
        `${target} target must expose its selected state`,
    );
    assert.strictEqual(
        await page.locator(`[data-predictortarget="${inactive}"]`).getAttribute('aria-selected'),
        'false',
        `${inactive} target must expose its inactive state`,
    );
}

async function verifyFormulaAndCalibration(page, artifact, target) {
    const targetData = artifact.targets[target];
    assert(targetData, `Missing ${target} target in predictor artifact`);
    assert((targetData.formula && targetData.formula.terms || []).length > 0, `${target} formula has no terms`);
    assert((targetData.calibration || []).length > 0, `${target} calibration has no bins`);

    const formulaTitle = page.getByText('Final fitted research formula · every downstream input exposed', { exact: true }).first();
    const calibrationTitle = page.getByText('Calibration · when the score says X, what actually happened?', { exact: true });
    await formulaTitle.waitFor({ state: 'visible' });
    await calibrationTitle.waitFor({ state: 'visible' });

    const firstFeature = targetData.formula.terms[0].feature;
    const formulaCard = formulaTitle.locator('..');
    assert.strictEqual(
        await formulaCard.getByText(firstFeature, { exact: true }).count(),
        1,
        `${target} formula must render its first stored term (${firstFeature}) exactly once`,
    );

    const calibrationCard = calibrationTitle.locator('..');
    const calibrationCircles = calibrationCard.locator('svg circle');
    assert.strictEqual(
        await calibrationCircles.count(),
        targetData.calibration.length,
        `${target} calibration must render one circle per persisted bin`,
    );

    return {
        formulaTerms: targetData.formula.terms.length,
        calibrationBins: await calibrationCircles.count(),
    };
}

async function verifyScatterDrilldown(page, artifact, target) {
    const points = artifact.targets[target].points || [];
    assert(points.length > 0, `${target} artifact has no blind scatter points`);
    const scatterTitle = page.getByText('Retrospective interpolation · predicted vs actual · every point is clickable', { exact: true });
    await scatterTitle.waitFor({ state: 'visible' });
    const plotCard = scatterTitle.locator('..');
    const pointLocator = plotCard.locator(`circle[data-predictorpoint^="${target}:"]`);
    const renderedPoints = await pointLocator.count();
    assert.strictEqual(
        renderedPoints,
        Math.min(points.length, 5000),
        `${target} scatter must render every persisted point up to the documented 5,000-point cap`,
    );

    const first = pointLocator.first();
    const pointKey = await first.getAttribute('data-predictorpoint');
    const pointId = pointKey.slice(target.length + 1);
    const expected = points.find(point => String(point.id) === pointId);
    assert(expected, `Could not match clicked ${target} point ${pointId} to persisted data`);
    await first.click({ force: true });

    const detailLabel = page.getByText('exact held-out video', { exact: true });
    await detailLabel.waitFor({ state: 'visible' });
    await page.getByText(expected.title, { exact: true }).waitFor({ state: 'visible' });
    const detailCard = detailLabel.locator('..').locator('..');
    const detailImage = detailCard.locator('img');
    if (await detailImage.count()) {
        await page.waitForFunction(element => element.complete && element.naturalWidth > 0, await detailImage.elementHandle());
        assert(await detailImage.evaluate(element => element.naturalWidth > 0), `${target} drilldown montage failed to decode`);
    }
    assert.strictEqual(
        windowSafeCount(await page.locator('[data-predictorpointclose]').count()),
        1,
        `${target} drilldown must expose one close control`,
    );

    const selectedRadius = await page.locator(`circle[data-predictorpoint="${pointKey}"]`).getAttribute('r');
    assert.strictEqual(selectedRadius, '5', `${target} selected point must receive the selected marker treatment`);

    await page.locator('[data-predictorpointclose]').click();
    await detailLabel.waitFor({ state: 'detached' });
    return { renderedPoints, clickedId: pointId, clickedTitle: expected.title };
}

function windowSafeCount(value) {
    return Number.isFinite(value) ? value : 0;
}

async function viewportAudit(page) {
    return page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        const rawPanel = document.getElementById('rtg-rawpanel');
        const content = document.querySelector('.jarvis-content');
        const visible = element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const globalOverflow = document.documentElement.scrollWidth - viewportWidth;
        const panelOverflow = rawPanel ? rawPanel.scrollWidth - rawPanel.clientWidth : null;
        const wideVisibleElements = rawPanel ? [...rawPanel.querySelectorAll('*')].filter(element => {
            if (!visible(element)) return false;
            const rect = element.getBoundingClientRect();
            if (rect.width <= viewportWidth + 1) return false;
            let parent = element.parentElement;
            while (parent && parent !== rawPanel) {
                const style = getComputedStyle(parent);
                if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && parent.clientWidth < parent.scrollWidth) return false;
                parent = parent.parentElement;
            }
            return true;
        }).slice(0, 12).map(element => ({
            tag: element.tagName.toLowerCase(),
            text: String(element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
            width: Math.round(element.getBoundingClientRect().width),
        })) : [];
        const targetTabs = [...document.querySelectorAll('[data-predictortarget]')].map(element => {
            const rect = element.getBoundingClientRect();
            return { target: element.getAttribute('data-predictortarget'), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
        const targetOverlap = targetTabs.length === 2
            && targetTabs[0].right > targetTabs[1].left + 0.5
            && targetTabs[0].top < targetTabs[1].bottom
            && targetTabs[1].top < targetTabs[0].bottom;
        return {
            viewportWidth,
            viewportHeight,
            documentScrollWidth: document.documentElement.scrollWidth,
            globalOverflow,
            panelOverflow,
            wideVisibleElements,
            targetOverlap,
            content: content ? {
                clientHeight: content.clientHeight,
                scrollHeight: content.scrollHeight,
                overflowY: getComputedStyle(content).overflowY,
                scrollTop: content.scrollTop,
            } : null,
        };
    });
}

async function setJarvisScroll(page, value) {
    await page.locator('.jarvis-content').evaluate((element, next) => {
        element.scrollTop = Math.max(0, Math.min(Number(next) || 0, element.scrollHeight - element.clientHeight));
    }, value);
    await page.waitForTimeout(100);
}

async function scrollJarvisTo(page, locator, topPadding = 10) {
    await locator.evaluate((element, padding) => {
        const content = element.closest('.jarvis-content') || document.querySelector('.jarvis-content');
        if (!content) return;
        const contentRect = content.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        content.scrollTop += elementRect.top - contentRect.top - padding;
    }, topPadding);
    await page.waitForTimeout(150);
}

async function verifyMobileLayout(page, artifact) {
    await page.setViewportSize(MOBILE);
    await waitForTarget(page, 'views');
    await setJarvisScroll(page, 0);
    const before = await viewportAudit(page);
    assert(before.content, 'Jarvis scroll container is missing');
    assert(before.content.scrollHeight > before.content.clientHeight, 'Predictor Lab must have vertically scrollable mobile content');
    assert(/auto|scroll/.test(before.content.overflowY), 'Jarvis content must own mobile vertical scrolling');
    assert(before.globalOverflow <= 1, `Mobile document overflows horizontally by ${before.globalOverflow}px`);
    assert(before.panelOverflow <= 1, `Mobile Predictor Lab panel overflows horizontally by ${before.panelOverflow}px`);
    assert.strictEqual(before.targetOverlap, false, 'Keep/views target controls overlap on mobile');
    assert.deepStrictEqual(before.wideVisibleElements, [], `Unexpected uncontained wide elements: ${JSON.stringify(before.wideVisibleElements)}`);

    await page.screenshot({ path: path.join(QA_DIR, 'mobile-predictor-top.png'), fullPage: false });

    await scrollJarvisTo(page, page.getByText('Final fitted research formula · every downstream input exposed', { exact: true }).first());
    await page.screenshot({ path: path.join(QA_DIR, 'mobile-predictor-formula.png'), fullPage: false });

    const content = page.locator('.jarvis-content');
    const maxScroll = await content.evaluate(element => element.scrollHeight - element.clientHeight);
    const targetScroll = Math.min(maxScroll, Math.max(300, Math.round(maxScroll * 0.45)));
    await content.evaluate((element, value) => { element.scrollTop = value; }, targetScroll);
    await page.waitForTimeout(100);
    const movedTo = await content.evaluate(element => element.scrollTop);
    assert(movedTo > 0, 'Mobile Predictor Lab content did not respond to vertical scrolling');

    const after = await viewportAudit(page);
    assert(after.globalOverflow <= 1, `Mobile document overflow appeared after scrolling (${after.globalOverflow}px)`);
    assert(after.panelOverflow <= 1, `Mobile panel overflow appeared after scrolling (${after.panelOverflow}px)`);
    assert.strictEqual(after.targetOverlap, false, 'Target controls overlap after mobile scroll');

    const formulaFeature = artifact.targets.views.formula.terms[0].feature;
    const formulaCard = page.locator('[data-predictor-formula="research"]');
    assert.strictEqual(await formulaCard.getByText(formulaFeature, { exact: true }).count(), 1, 'Views formula content disappeared in mobile layout');
    return { before, after, movedTo };
}

async function main() {
    assert(fs.existsSync(RESULTS_PATH), `Missing persisted predictor artifact: ${RESULTS_PATH}`);
    const artifact = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    assert(artifact.targets && artifact.targets.keep && artifact.targets.views, 'Predictor artifact must contain keep and views targets');
    fs.mkdirSync(QA_DIR, { recursive: true });
    for (const file of fs.readdirSync(QA_DIR)) {
        if (file.endsWith('.png')) fs.unlinkSync(path.join(QA_DIR, file));
    }

    const server = await ensureServer(DEFAULT_ORIGIN);
    let browser;
    const browserErrors = [];
    const requestFailures = [];
    try {
        browser = await chromium.launch({ headless: HEADLESS });
        const page = await browser.newPage({ viewport: DESKTOP, deviceScaleFactor: 1 });
        page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`));
        page.on('console', message => {
            if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
        });
        page.on('requestfailed', failed => {
            const url = failed.url();
            if (url.startsWith(DEFAULT_ORIGIN)) requestFailures.push(`${url}: ${(failed.failure() || {}).errorText || 'failed'}`);
        });
        await installRoutes(page, DEFAULT_ORIGIN, artifact);
        await openPredictorLab(page, DEFAULT_ORIGIN);

        assert.strictEqual(await page.locator('.jarvis-tab[data-tab="retention"].active').count(), 1, 'Shorts Quant must be the active Jarvis tab');
        assert.strictEqual(await page.locator('[data-rs="raw"]').count(), 1, 'Raw Data control is missing');
        assert.strictEqual(await page.locator('#rtg-rawpanel [data-rawview="predictor"]').count(), 1, 'Predictor Lab subview is missing');

        await waitForTarget(page, 'keep');
        await page.getByText('mean absolute keep-rate error', { exact: true }).waitFor({ state: 'visible' });
        const keepSections = await verifyFormulaAndCalibration(page, artifact, 'keep');
        await page.screenshot({ path: path.join(QA_DIR, 'desktop-keep-overview.png'), fullPage: false });
        const keepDrilldown = await verifyScatterDrilldown(page, artifact, 'keep');
        await page.locator(`circle[data-predictorpoint="keep:${keepDrilldown.clickedId}"]`).click({ force: true });
        const keepDetail = page.getByText('exact held-out video', { exact: true });
        await keepDetail.waitFor({ state: 'visible' });
        await scrollJarvisTo(page, keepDetail.locator('..'));
        await page.screenshot({ path: path.join(QA_DIR, 'desktop-keep-drilldown.png'), fullPage: false });
        await page.locator('[data-predictorpointclose]').click();

        await page.locator('[data-predictortarget="views"]').click();
        await waitForTarget(page, 'views');
        await page.getByText('true median multiplicative views error', { exact: true }).waitFor({ state: 'visible' });
        const viewsSections = await verifyFormulaAndCalibration(page, artifact, 'views');
        const viewsDrilldown = await verifyScatterDrilldown(page, artifact, 'views');
        await setJarvisScroll(page, 0);
        await page.screenshot({ path: path.join(QA_DIR, 'desktop-views-overview.png'), fullPage: false });
        await scrollJarvisTo(page, page.getByText('Final fitted research formula · every downstream input exposed', { exact: true }).first());
        await page.screenshot({ path: path.join(QA_DIR, 'desktop-views-formula.png'), fullPage: false });

        const desktopLayout = await viewportAudit(page);
        assert(desktopLayout.globalOverflow <= 1, `Desktop document overflows horizontally by ${desktopLayout.globalOverflow}px`);
        assert(desktopLayout.panelOverflow <= 1, `Desktop Predictor Lab panel overflows horizontally by ${desktopLayout.panelOverflow}px`);
        assert.strictEqual(desktopLayout.targetOverlap, false, 'Keep/views target controls overlap on desktop');

        const mobileLayout = await verifyMobileLayout(page, artifact);
        assert.deepStrictEqual(browserErrors, [], `Browser errors:\n${browserErrors.join('\n')}`);
        assert.deepStrictEqual(requestFailures, [], `Local request failures:\n${requestFailures.join('\n')}`);

        console.log(JSON.stringify({
            ok: true,
            server: server.reused ? 'reused' : 'started',
            origin: DEFAULT_ORIGIN,
            artifactGeneratedAt: artifact.generatedAt || null,
            desktop: {
                viewport: DESKTOP,
                keep: { ...keepSections, ...keepDrilldown },
                views: { ...viewsSections, ...viewsDrilldown },
                overflowPx: desktopLayout.globalOverflow,
            },
            mobile: {
                viewport: MOBILE,
                overflowPx: mobileLayout.after.globalOverflow,
                panelOverflowPx: mobileLayout.after.panelOverflow,
                scrollTopVerified: mobileLayout.movedTo,
            },
            screenshots: fs.readdirSync(QA_DIR).filter(file => file.endsWith('.png')).sort(),
        }, null, 2));
    } finally {
        if (browser) await browser.close();
        stopServer(server.child);
    }
}

main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
});
