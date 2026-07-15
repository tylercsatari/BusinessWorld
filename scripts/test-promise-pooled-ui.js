#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { chromium } = require('playwright');

const base = process.env.PROMISE_HARNESS_URL
    || 'http://127.0.0.1:8014/buildings/jarvis/promise-lab/.cache/real-ui-harness.html';

async function chooseLibrary(page) {
    await page.getByRole('button', { name: 'Opening library', exact: true }).click();
    await page.locator('input[data-pl-query]').waitFor({ state: 'visible' });
}

async function search(page, value) {
    const input = page.locator('input[data-pl-query]');
    await input.fill(value);
    await input.evaluate(node => node.dispatchEvent(new Event('change', { bubbles: true })));
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const pooled = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const requests = [];
        pooled.on('request', request => requests.push(request.url()));
        await pooled.goto(`${base}?scope=all`, { waitUntil: 'domcontentloaded' });
        await chooseLibrary(pooled);
        await pooled.getByText('Pooled opening library', { exact: true }).waitFor();
        await pooled.getByText(/636 visible source-aligned Shorts sequences/).waitFor();
        assert.strictEqual(await pooled.locator('tr[data-pl-video]').count(), 60);
        assert.ok((await pooled.evaluate(() => window.__PL_FETCH_LOG || []))
            .some(url => url.includes('opening-predictions') && url.includes('scope=all')));

        const scatter = pooled.locator('canvas[data-pl-canvas="pooled-scatter"]');
        await scatter.waitFor({ state: 'visible' });
        await pooled.waitForFunction(() => {
            const canvas = document.querySelector('canvas[data-pl-canvas="pooled-scatter"]');
            return canvas && canvas._plPooledPointCount === 356;
        });
        assert.strictEqual(await scatter.evaluate(node => node._plPooledPointCount), 356);

        await search(pooled, 'DgFX1kJcWtw');
        await pooled.locator('tr[data-pl-video="DgFX1kJcWtw"]').click();
        await pooled.getByText('Duration-conditioned baseline only', { exact: true }).waitFor();
        const analysis = pooled.locator('[data-pl-analysis]');
        assert.strictEqual(await analysis.getByText('Attention-like relational and drop graph', { exact: true }).count(), 0);
        const predicted = analysis.locator('canvas[data-pl-canvas="retention-predicted"]');
        const actual = analysis.locator('canvas[data-pl-canvas="retention-actual"]');
        const [predictedBox, actualBox] = await Promise.all([
            predicted.boundingBox(), actual.boundingBox(),
        ]);
        assert.ok(predictedBox && actualBox);
        assert.strictEqual(Math.round(predictedBox.width), Math.round(actualBox.width));
        assert.strictEqual(Math.round(predictedBox.height), Math.round(actualBox.height));

        await search(pooled, 'nY-IPU3hxe0');
        await pooled.locator('tr[data-pl-video="nY-IPU3hxe0"]').click();
        await pooled.getByText('Selected component inside the saved four-cluster embedding', { exact: true })
            .waitFor({ timeout: 30000 });
        assert.ok(requests.some(url => url.includes('opening-context-study')));
        assert.ok(requests.some(url => url.includes('manual-projection')));
        assert.ok((await pooled.evaluate(() => window.__PL_FETCH_LOG || []))
            .some(url => url.includes('generation=')));
        await pooled.screenshot({
            path: 'buildings/jarvis/promise-lab/.cache/pooled-ui-verified.png',
            fullPage: false,
        });

        const main = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await main.goto(`${base}?scope=tyler`, { waitUntil: 'domcontentloaded' });
        await chooseLibrary(main);
        await main.getByText(/208 visible source-aligned Shorts sequences/).waitFor({ timeout: 45000 });
        assert.strictEqual(await main.locator('tr[data-pl-video]').count(), 208);
        console.log('Promise pooled UI: pass (636 pooled, 356 external fixed-20 points, 208 Main rows)');
    } finally {
        await browser.close();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
