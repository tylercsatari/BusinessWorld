#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(
    ROOT,
    'buildings',
    'jarvis',
    'operations-lab',
    '.cache',
    'test-artifact-12.json',
);
const UI_PATH = path.join(ROOT, 'buildings', 'jarvis', 'operations-lab-ui.js');
const CSS_PATH = path.join(ROOT, 'buildings', 'jarvis', 'operations-lab.css');
const ORIGIN = 'http://operations-lab.test';

function fixtureStatus(overrides) {
    return {
        version: 1,
        productVersion: 'shorts-hook-operations-v1',
        stage: 'complete',
        updatedAt: Date.now(),
        message: 'Operations artifact is complete.',
        total: 12,
        described: 12,
        embeddedFeatures: 18,
        providerError: null,
        ...(overrides || {}),
    };
}

async function mount(page, artifact, status, artifactStatus) {
    await page.route('**/api/raw/saved-montage/*', route => route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: [
            '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200">',
            '<rect width="200" height="200" fill="#176b87"/>',
            '<rect x="200" width="200" height="200" fill="#263d63"/>',
            '<rect x="400" width="200" height="200" fill="#406b57"/>',
            '<rect x="600" width="200" height="200" fill="#7b5942"/>',
            '<rect x="800" width="200" height="200" fill="#6b4d78"/>',
            '<text x="500" y="112" fill="white" font-size="34" text-anchor="middle">saved montage</text>',
            '</svg>',
        ].join(''),
    }));
    await page.setContent(
        `<!doctype html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <base href="${ORIGIN}/"><style>html,body{margin:0;min-height:100%;background:#07101a}#mount{min-height:100vh}</style>
        </head><body><main id="mount"></main></body></html>`,
        { waitUntil: 'domcontentloaded' },
    );
    const style = await page.addStyleTag({ path: CSS_PATH });
    await style.evaluate(element => {
        element.id = 'jarvis-operations-lab-styles';
    });
    await page.addScriptTag({
        content: `
            window.__opsFixture = ${JSON.stringify({ artifact, status, artifactStatus: artifactStatus || 200 })};
            window.fetch = async function(url) {
                var fixture = window.__opsFixture;
                var path = String(url);
                if (path.indexOf('/status') >= 0) {
                    return new Response(JSON.stringify(fixture.status), {
                        status: 200,
                        headers: {'Content-Type': 'application/json'}
                    });
                }
                return new Response(
                    JSON.stringify(
                        fixture.artifactStatus === 202
                            ? {version: 1, stage: 'building', error: 'The complete Operations artifact is still building.'}
                            : fixture.artifact
                    ),
                    {
                        status: fixture.artifactStatus,
                        headers: {'Content-Type': 'application/json'}
                    }
                );
            };
        `,
    });
    await page.addScriptTag({ path: UI_PATH });
    await page.addScriptTag({
        content: `
            (function () {
                var mount = document.getElementById('mount');
                var ui;
                function repaint() {
                    mount.innerHTML = ui.render();
                    ui.afterRender();
                }
                ui = window.JarvisOperationsLab.create({
                    escapeHtml: function(value) {
                        return String(value == null ? '' : value)
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;')
                            .replace(/'/g, '&#39;');
                    },
                    formatNumber: function(value) {
                        return Math.round(Number(value) || 0).toLocaleString();
                    },
                    onRender: repaint
                });
                mount.addEventListener('click', function(event) { ui.handleClick(event); });
                mount.addEventListener('input', function(event) { ui.handleInput(event); });
                mount.addEventListener('change', function(event) { ui.handleChange(event); });
                repaint();
                window.__operationsUi = ui;
            }());
        `,
    });
}

async function waitForLoaded(page) {
    await page.getByRole('heading', { name: 'Opening Operations Atlas' }).waitFor();
    await page.getByText('Measurement boundary', { exact: true }).waitFor();
    await page.getByText('Keep is an existing embedding estimate, not an observed YouTube swipe ratio.', {
        exact: true,
    }).waitFor();
}

async function verifyDesktop(page, artifact) {
    await waitForLoaded(page);
    await page.getByText(`${artifact.hooks.length} hooks`, { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Out-of-fold predictive evidence' }).waitFor();

    await page.locator('[data-ops-view="families"]').click();
    await page.getByRole('heading', { name: artifact.families[0].label, exact: true }).waitFor();
    assert.strictEqual(
        await page.locator('.ops-family-list > button').count(),
        artifact.families.length,
        'Every persisted feature family must be selectable',
    );
    assert.strictEqual(
        await page.locator('.ops-plane [data-ops-plane-point]').count(),
        artifact.hooks.length,
        'The semantic plane must render every persisted hook',
    );

    await page.locator('.ops-plane [data-ops-plane-point]').first().click({ force: true });
    await page.getByText('Selected plane point', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Inspect hook' }).click();
    await page.getByText('Complete feature ledger', { exact: true }).waitFor();
    assert.strictEqual(
        await page.locator('.ops-membership-card').count(),
        artifact.families.length,
        'Hook detail must expose every family membership',
    );
    const detailImage = page.locator('.ops-hook-detail img').first();
    await detailImage.waitFor();
    await page.waitForFunction(
        image => image.complete && image.naturalWidth > 0,
        await detailImage.elementHandle(),
    );

    await page.locator('[data-ops-view="interactions"]').click();
    await page.getByRole('heading', { name: 'Operations that co-occur in the same hook' }).waitFor();
    const interactionRows = page.locator('tr[data-ops-interaction]');
    assert(await interactionRows.count() > 0, 'The interaction table must render stored combinations');
    await interactionRows.first().click();
    await page.getByText('Selected cross-family operation', { exact: true }).waitFor();

    await page.locator('[data-ops-target="visual_keep"]').click();
    await page.locator('[data-ops-threshold-number]').fill('85');
    await page.locator('[data-ops-threshold-number]').press('Enter');
    await page.getByText('Hit rate at 85%', { exact: false }).first().waitFor();

    const overflow = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        root: document.querySelector('.operations-lab').scrollWidth,
        client: document.querySelector('.operations-lab').clientWidth,
    }));
    assert(
        overflow.document <= overflow.viewport + 1,
        `Desktop document overflowed: ${JSON.stringify(overflow)}`,
    );
    assert(
        overflow.root <= overflow.client + 1,
        `Desktop Operations root overflowed: ${JSON.stringify(overflow)}`,
    );
}

async function verifyMobile(page, artifact) {
    await waitForLoaded(page);
    await page.locator('[data-ops-view="hooks"]').click();
    await page.getByRole('heading', { name: 'Every analyzed opening' }).waitFor();
    const before = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(50);
    const dimensions = await page.evaluate(() => ({
        before: window.scrollY,
        after: window.scrollY,
        height: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        rootWidth: document.querySelector('.operations-lab').scrollWidth,
        rootClientWidth: document.querySelector('.operations-lab').clientWidth,
    }));
    assert.strictEqual(before, 0);
    assert(
        dimensions.height > dimensions.viewportHeight,
        `Mobile hook library should have scrollable content: ${JSON.stringify(dimensions)}`,
    );
    assert(
        dimensions.after > 0,
        `Mobile page did not scroll: ${JSON.stringify(dimensions)}`,
    );
    assert(
        dimensions.documentWidth <= dimensions.viewportWidth + 1,
        `Mobile document overflowed horizontally: ${JSON.stringify(dimensions)}`,
    );
    assert(
        dimensions.rootWidth <= dimensions.rootClientWidth + 1,
        `Mobile Operations root overflowed: ${JSON.stringify(dimensions)}`,
    );
    assert.strictEqual(
        await page.locator('.ops-hook-card').count(),
        artifact.hooks.length,
        'The mini fixture should show every hook card on mobile',
    );
}

async function verifyBlockedState(page) {
    await waitForLoaded(page);
    await page.getByText('Operations artifact pending', { exact: true }).waitFor();
    const providerError = page.locator('.ops-provider-error');
    await providerError.waitFor();
    assert(
        (await providerError.textContent()).includes(
            'Gemini credits or quota are blocking description extraction.',
        ),
        'The provider error must expose the actionable credit message',
    );
    assert(
        (await providerError.textContent()).includes('credits_or_quota_exhausted'),
        'The provider error must expose its classified error kind',
    );
}

async function main() {
    assert(fs.existsSync(ARTIFACT_PATH), `Missing test artifact: ${ARTIFACT_PATH}`);
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
    const browser = await chromium.launch({ headless: true });
    try {
        const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const desktopErrors = [];
        desktop.on('console', message => {
            if (message.type() === 'error') desktopErrors.push(message.text());
        });
        desktop.on('pageerror', error => desktopErrors.push(error.message));
        await mount(desktop, artifact, fixtureStatus(), 200);
        await verifyDesktop(desktop, artifact);
        assert.deepStrictEqual(desktopErrors, [], `Desktop console errors: ${desktopErrors.join('\n')}`);

        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const mobileErrors = [];
        mobile.on('console', message => {
            if (message.type() === 'error') mobileErrors.push(message.text());
        });
        mobile.on('pageerror', error => mobileErrors.push(error.message));
        await mount(mobile, artifact, fixtureStatus(), 200);
        await verifyMobile(mobile, artifact);
        assert.deepStrictEqual(mobileErrors, [], `Mobile console errors: ${mobileErrors.join('\n')}`);

        const blocked = await browser.newPage({ viewport: { width: 1000, height: 760 } });
        await mount(blocked, null, fixtureStatus({
            stage: 'blocked',
            total: 984,
            described: 325,
            message: 'Gemini credits or quota are blocking description extraction.',
            providerError: {
                provider: 'Gemini',
                kind: 'credits_or_quota_exhausted',
                httpStatus: 429,
                message: 'Gemini credits or quota are blocking description extraction.',
                retrySeconds: 60,
            },
        }), 202);
        await verifyBlockedState(blocked);

        console.log(JSON.stringify({
            ok: true,
            hooks: artifact.hooks.length,
            families: artifact.families.length,
            desktop: 'passed',
            mobile: 'passed',
            blockedCredits: 'passed',
        }));
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error && error.stack || error);
    process.exit(1);
});
