#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

async function testVideoServiceTransition() {
    const source = fs.readFileSync(path.join(ROOT, 'buildings/video-service.js'), 'utf8');
    const rows = [{
        id: 'posted-1',
        name: 'Already live',
        status: 'posted',
        postedDate: '2026-08-01T00:00:00.000Z',
        stageState: { ideate: 'done', edit: 'done', post: 'done' }
    }];
    const requests = [];
    const context = {
        console,
        HtmlUtils: { getConfig: async () => ({}) },
        NotesService: { getById: () => null, update: async () => null },
        fetch: async (url, options = {}) => {
            if (url === '/api/data/videos' && !options.method) return { ok: true, json: async () => rows.map(row => ({ ...row })) };
            if (url === '/api/data/videos/posted-1' && options.method === 'PATCH') {
                const changes = JSON.parse(options.body);
                requests.push(changes);
                Object.assign(rows[0], changes);
                return { ok: true, json: async () => ({ ...rows[0] }) };
            }
            throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
        }
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nglobalThis.__service = VideoService;`, context);
    const service = context.__service;
    await service.sync(true);
    const restored = await service.requeue('posted-1');
    assert.equal(restored.status, 'pipeline');
    assert.equal(restored.postedDate, '');
    assert.equal(restored.stageState.edit, 'done');
    assert.ok(!Object.prototype.hasOwnProperty.call(restored.stageState, 'post'));
    assert.equal(service.getPipeline().length, 1);
    assert.deepEqual(requests[0].stageState, { ideate: 'done', edit: 'done' });
}

async function installHarness(page) {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>html,body,#app{height:100%;margin:0}</style></head><body><main id="app"></main></body></html>');
    await page.addStyleTag({ path: path.join(ROOT, 'buildings/workshop/workshop.css') });
    await page.evaluate(() => {
        const escape = value => String(value == null ? '' : value)
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
        window.HtmlUtils = { escHtml: escape, escAttr: escape, getConfig: async () => ({}) };
        window.__access = { all: true };
        window.canDelete = () => true;
        window.canSeeStage = () => true;
        window.canWriteStage = () => true;
        window.confirm = () => true;
        window.alert = message => { throw new Error(`Unexpected alert: ${message}`); };
        window.BuildingRegistry = { register(name, config) { window.__workshopRegistration = config; } };
        window.EmployeeService = { getNames: () => [], colorForName: () => '' };
        window.NotesService = {
            sync: async () => [], getAll: () => [], getById: () => null,
            create: async value => value, update: async value => value
        };
        const emptyStore = {
            getAll: () => [], getById: () => null,
            create: async value => value, update: async () => null, remove: async () => null
        };
        window.PipelineService = {
            projects: emptyStore, components: emptyStore, orders: emptyStore,
            inventory: emptyStore, sponsors: emptyStore, settings: emptyStore,
            syncAll: async () => null,
            ordersForVideo: () => [], componentsForProject: () => [], ordersForProject: () => [],
            inventoryForProject: () => [], markProducedInventoryReady: async () => null
        };
        const now = new Date().toISOString();
        let videos = [
            { id: 'active-1', name: 'Active robot arm', project: 'Robot', status: 'pipeline', stageState: {}, hook: 'Build the arm', createdAt: now },
            { id: 'posted-1', name: 'Published bridge', project: 'Bridge', status: 'posted', stageState: { post: 'done' }, hook: 'Cross the gap', postedDate: '2026-08-01T00:00:00.000Z' }
        ];
        window.VideoService = {
            sync: async () => videos,
            getProjects: async () => [], getCachedProjects: () => [], getAll: () => videos,
            getPipeline: () => videos.filter(video => ['pipeline', 'incubator', 'workshop'].includes(video.status)),
            getById: id => videos.find(video => video.id === id),
            getByIdeaId: () => null,
            update: async (id, changes) => {
                const index = videos.findIndex(video => video.id === id);
                videos[index] = { ...videos[index], ...changes, updatedAt: new Date().toISOString() };
                return videos[index];
            },
            requeue: async id => {
                const video = videos.find(row => row.id === id);
                const stageState = { ...(video.stageState || {}) };
                delete stageState.post;
                return window.VideoService.update(id, { status: 'pipeline', stageState, postedDate: '' });
            },
            create: async value => value, remove: async () => null,
            saveWithIdeaSync: async (id, changes) => window.VideoService.update(id, changes)
        };
        window.fetch = async url => {
            if (url === '/api/me') return { ok: true, json: async () => ({ displayName: 'Owner' }) };
            if (url === '/api/accounts' || url === '/api/profiles') return { ok: true, json: async () => [] };
            return { ok: true, json: async () => ({}) };
        };
    });
    await page.addScriptTag({ path: path.join(ROOT, 'buildings/workshop/pipeline-stages.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'buildings/workshop/workshop-ui.js') });
    await page.evaluate(async () => window.__workshopRegistration.open(document.getElementById('app')));
}

async function testViewport(browser, viewport, screenshotName) {
    const page = await browser.newPage({ viewport });
    await installHarness(page);
    await page.getByRole('tab', { name: /Posted/ }).click();
    await page.getByRole('heading', { name: 'Posted videos' }).waitFor();
    assert.equal(await page.locator('[data-posted-card]').count(), 1);
    assert.match(await page.locator('#wsp-count').textContent(), /1 posted/);

    await page.getByRole('button', { name: 'Add from pipeline' }).click();
    await page.locator('.wsp-posted-picker-row input').check();
    await page.getByRole('button', { name: 'Move to Posted' }).click();
    await page.locator('[data-posted-card]').nth(1).waitFor();
    assert.equal(await page.locator('[data-posted-card]').count(), 2);
    assert.match(await page.locator('#wsp-count').textContent(), /2 posted/);
    assert.equal(await page.getByRole('tab', { name: /Pipeline/ }).locator('.wsp-tab-count').textContent(), '');
    await page.locator('#wsp-posted-search').fill('bridge');
    assert.equal(await page.locator('[data-posted-card]:visible').count(), 1);
    await page.locator('#wsp-posted-search').fill('');
    assert.equal(await page.locator('[data-posted-card]:visible').count(), 2);

    const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
        body: document.querySelector('#wsp-tab-body').getBoundingClientRect().width
    }));
    assert.ok(dimensions.page <= dimensions.viewport, JSON.stringify(dimensions));
    assert.ok(dimensions.body <= dimensions.viewport, JSON.stringify(dimensions));
    await page.screenshot({ path: path.join('/tmp', screenshotName), fullPage: true });

    await page.locator('[data-posted-open="posted-1"]').click();
    await page.locator('#workshop-detail').waitFor();
    assert.equal(await page.locator('#workshop-name').inputValue(), 'Published bridge');
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('heading', { name: 'Posted videos' }).waitFor();

    await page.locator('[data-posted-restore="active-1"]').click();
    await page.getByRole('tab', { name: /Pipeline/ }).waitFor();
    assert.match(await page.locator('#wsp-count').textContent(), /1 in pipeline/);
    const state = await page.evaluate(() => window.VideoService.getById('active-1'));
    assert.equal(state.status, 'pipeline');
    assert.ok(!Object.prototype.hasOwnProperty.call(state.stageState, 'post'));
    await page.close();
}

(async () => {
    await testVideoServiceTransition();
    const browser = await chromium.launch({ headless: true });
    try {
        await testViewport(browser, { width: 1280, height: 800 }, 'workshop-posted-desktop.png');
        await testViewport(browser, { width: 390, height: 844 }, 'workshop-posted-mobile.png');
    } finally {
        await browser.close();
    }
    console.log(JSON.stringify({ ok: true, desktop: '/tmp/workshop-posted-desktop.png', mobile: '/tmp/workshop-posted-mobile.png' }));
})().catch(error => {
    console.error(error);
    process.exit(1);
});
