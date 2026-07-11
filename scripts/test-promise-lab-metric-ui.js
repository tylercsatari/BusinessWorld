#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const uiPath = path.join(ROOT, 'buildings/jarvis/promise-lab-ui.js');

const rawDefinition = {
    label: 'Raw phrase slope +2s',
    family: 'raw-slope',
    channel: 'observed YouTube retention geometry',
    unit: 'retention ratio per second',
    offsetSeconds: 2,
    definition: 'least-squares slope over the exact spoken span interval after shifting both boundaries forward by 2 second(s)',
};
const viewsDefinition = {
    label: 'Views raw',
    family: 'performance',
    channel: 'observed YouTube outcome',
    unit: 'views',
    definition: 'measured raw view count for the source Short',
};
const normalizedDefinition = {
    label: 'Endpoint-normalized slope +2s',
    family: 'normalized-slope',
    channel: 'normalized observed retention geometry',
    unit: 'endpoint-normalized retention per second',
    offsetSeconds: 2,
    definition: 'slope after mapping curve entry to one and terminal retention to zero',
};
const residualDefinition = {
    label: 'Unexpected slope +2s',
    family: 'residual-slope',
    channel: 'normalized observed retention geometry',
    unit: 'OOF residual normalized retention per second',
    offsetSeconds: 2,
    definition: 'endpoint-normalized slope minus its grouped out-of-fold expectation',
};
const experiment = (target, family) => ({
    id: `${target}-fixture`, target, cluster: 2, targetFamily: family,
    representation: 'raw-hook-residual', confounds: family === 'performance' ? 'performance' : 'slope',
    pcaDimensions: 32, ridgeAlpha: 1, n: 12, sourceVideos: 3,
    heldoutSpearman: .21, searchWideP: .01, searchWideQ: .03, status: 'validated',
});
const rawExperiment = experiment('slope_raw_o2', 'raw-slope');
const viewsExperiment = experiment('views_raw', 'performance');
const normalizedExperiment = experiment('slope_normalized_o2', 'normalized-slope');
const residualExperiment = experiment('slope_residual_o2', 'residual-slope');
const sharedPoints = {
    globalIndices: [0, 1, 2], x: [-1, 0, 1], y: [.5, -.25, .2],
    spanStartSeconds: [1, 2, 3], spanEndSeconds: [2, 3, 4],
};
const detail = (target, meta, values, residuals, selectedExperiment) => ({
    cluster: 2, target, targetMeta: meta, selectedExperiment,
    points: { ...sharedPoints, target: values, targetResidual: residuals },
    validation: { predictedOOF: [-.03, -.02], observedResidualOOF: [-.04, -.01] },
    extremes: { high: [], low: [] },
    normalizationAudit: { oofSpearman: .1, oofR2: .01 },
});

const payloads = {
    manifest: { status: 'complete', counts: {}, separation: { discoveryInputs: 'fixture', outcomeInputs: 'fixture', enforcement: 'fixture' } },
    progress: { status: 'complete', stage: 'complete' },
    findings: {},
    'manual-probe': {},
    'manual-projection': {
        savedName: 'Fixture embedding', selectedMethod: 'maxmin', reconstruction: { rows: 3 },
        methods: [{
            id: 'maxmin', label: 'Max-min balanced', description: 'Fixture projection',
            points: [[0, 0], [1, 1], [-1, .5]], metrics: { pairwise: [] },
        }],
        frozenPointIndex: {
            labels: [2, 2, 2], spanIds: ['a', 'b', 'c'], texts: ['first phrase', 'missing phrase', 'third phrase'],
            hookIndices: [0, 0, 0], starts: [0, 1, 2], ends: [1, 2, 3],
            charStarts: [0, 6, 14], charEnds: [5, 13, 19],
            hooks: [{ videoId: 'fixture', title: 'Fixture video', text: 'first missing third' }],
        },
    },
    'cluster-outcomes': {
        targetDefinitions: {
            slope_raw_o2: rawDefinition, views_raw: viewsDefinition,
            slope_normalized_o2: normalizedDefinition, slope_residual_o2: residualDefinition,
        },
        topIndicators: [rawExperiment], experimentCount: 4, selectedFamilyCount: 2,
        validatedFamilyCount: 2, timingAudit: { exactHooks: 3, hooks: 3, spansWithExactPositiveDuration: 3, spanInstances: 3 },
        normalization: {
            entryTerminalDiagnostic: { predictedEntryOOF: [1, 1.1], entry: [1.02, 1.09] },
        },
        clusters: [{
            label: 2, spanInstances: 3,
            targets: [rawExperiment, viewsExperiment, normalizedExperiment, residualExperiment],
            slopeBaselineAudits: { 2: { oofSpearman: .1, oofR2: .01 } },
        }],
    },
    'cluster-outcome/2/slope_raw_o2': detail(
        'slope_raw_o2', rawDefinition, [-.1, null, -.02], [-.05, null, .01], rawExperiment,
    ),
    'cluster-outcome/2/views_raw': detail(
        'views_raw', viewsDefinition, [100000, 1000000, 10000000], [-500000, 0, 500000], viewsExperiment,
    ),
    'cluster-outcome/2/slope_normalized_o2': detail(
        'slope_normalized_o2', normalizedDefinition, [-.08, -.04, -.01], [-.02, 0, .02], normalizedExperiment,
    ),
    'cluster-outcome/2/slope_residual_o2': detail(
        'slope_residual_o2', residualDefinition, [-.03, 0, .03], [-.01, 0, .01], residualExperiment,
    ),
};

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent('<!doctype html><head><base href="http://fixture.local/"></head><body style="margin:0;background:#0b1120"><main id="panel" style="padding:14px"></main></body>');
        await page.addScriptTag({ path: uiPath });
        await page.evaluate(payloadsInPage => {
            const colors = {
                bg: '#0b1120', card: '#0f172a', card2: '#131c30', border: '#1e293b', border2: '#27364d',
                text: '#e2e8f0', dim: '#94a3b8', mute: '#64748b', faint: '#475569', cyan: '#22d3ee',
                green: '#34d399', orange: '#fb923c', amber: '#f59e0b', red: '#f87171', purple: '#a78bfa',
                yellow: '#fbbf24', accent: '#38bdf8',
            };
            const escapeHtml = value => String(value ?? '').replace(/[&<>\"]/g, character => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
            })[character]);
            window.__fixtureRequests = [];
            window.fetch = async url => {
                const prefix = '/api/longquant/promise-lab/';
                const key = new URL(url, 'http://fixture.local/').pathname.slice(prefix.length);
                window.__fixtureRequests.push(key);
                const value = payloadsInPage[key];
                return new Response(JSON.stringify(value == null ? { error: `missing fixture ${key}` } : value), {
                    status: value == null ? 404 : 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            };
            const panel = document.getElementById('panel');
            const ui = window.createLongQuantPromiseLab({ colors, escape: escapeHtml });
            panel.innerHTML = ui.render();
            panel.addEventListener('click', event => ui.handleClick(event));
            panel.addEventListener('input', event => ui.handleInput(event));
            panel.addEventListener('change', event => ui.handleChange(event));
            ui.afterRender();
        }, payloads);

        await page.getByRole('button', { name: 'Saved embedding', exact: true }).click();
        const contract = page.locator('[data-pl-outcome-metric-contract]');
        try {
            await contract.waitFor({ state: 'visible', timeout: 10000 });
        } catch (error) {
            const debug = await page.evaluate(() => ({
                requests: window.__fixtureRequests,
                text: document.body.innerText,
            }));
            throw new Error(`${error.message}\nFixture state: ${JSON.stringify(debug, null, 2)}\nPage errors: ${errors.join(' | ')}`);
        }
        const rawText = await contract.innerText();
        assert(rawText.includes('Color = Raw phrase slope +2s'));
        assert(rawText.includes('start + 2s through end + 2s'));
        assert(rawText.includes('BLUE · LOW'));
        assert(rawText.includes('-10.00 pp/s'));
        assert(rawText.includes('RED · HIGH'));
        assert(rawText.includes('-2.00 pp/s'));
        assert(rawText.includes('1 span without this measurement is gray'));
        assert(rawText.includes('It does not show cluster membership'));
        assert(rawText.includes('Moving right predicts a higher confound-adjusted target'));
        assert(rawText.includes('It is not an outcome metric'));
        assert((await page.getByText('Y: held-out Spearman rho', { exact: false }).innerText()).includes('not the retention slope itself'));

        const axisCanvas = page.locator('canvas[data-pl-canvas="cluster-outcome-axis"]');
        await axisCanvas.evaluate(canvas => {
            const rect = canvas.getBoundingClientRect();
            canvas.dispatchEvent(new MouseEvent('click', {
                bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.bottom - 8,
            }));
        });
        const inspectorText = await page.locator('[data-pl-outcome-inspector]').innerText();
        assert(inspectorText.includes('missing phrase'), inspectorText);
        assert(inspectorText.includes('point color (Raw phrase slope +2s): not measured'));
        assert(inspectorText.includes('measured slope window: 4.000s → 5.000s'));

        await page.getByRole('button', { name: 'Video outcomes', exact: true }).click();
        await page.locator('[data-pl-outcome-target="views_raw"][data-pl-outcome-cluster="2"]').click();
        await page.getByText('Color = Views raw', { exact: true }).waitFor();
        const viewsText = await contract.innerText();
        assert(viewsText.includes('Video-level value; no phrase-time window is used'));
        assert(viewsText.includes('Blue is a lower outcome and red is a higher outcome'));
        assert(viewsText.includes('100.0K'));
        assert(viewsText.includes('10.00M'));

        await page.getByRole('button', { name: 'Normalized slope', exact: true }).click();
        await page.getByText('Color = Endpoint-normalized slope +2s', { exact: true }).waitFor();
        const normalizedText = await contract.innerText();
        assert(normalizedText.includes('mapped from entry = 1 to terminal retention = 0'));
        assert(normalizedText.includes('Blue is a steeper normalized loss'));

        await page.getByRole('button', { name: 'Unexpected slope', exact: true }).click();
        await page.getByText('Color = Unexpected slope +2s', { exact: true }).waitFor();
        const residualText = await contract.innerText();
        assert(residualText.includes('grouped out-of-fold slope expected from phrase timing'));
        assert(residualText.includes('Blue is worse than the timing/endpoints predict'));
        assert(residualText.includes('Zero means exactly the out-of-fold expectation'));

        await page.setViewportSize({ width: 390, height: 844 });
        const responsive = await page.evaluate(() => {
            const channels = document.querySelector('.pl-metric-channels');
            const columns = getComputedStyle(channels).gridTemplateColumns.split(' ').filter(Boolean).length;
            return { columns, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        assert.strictEqual(responsive.columns, 1, 'metric channel explanation must stack on mobile');
        assert(responsive.overflow <= 1, `page has ${responsive.overflow}px horizontal overflow on mobile`);
        assert.deepStrictEqual(errors, []);

        console.log(JSON.stringify({
            ok: true,
            rawMetric: { low: '-10.00 pp/s', high: '-2.00 pp/s', missing: 1 },
            performanceMetric: { low: '100.0K', high: '10.00M' },
            mobile: responsive,
        }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
