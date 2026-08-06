#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
    FEATURE_DEFINITIONS,
} = require('../buildings/jarvis/shorts-score-ledger');
const {
    scoreLedgerFromFeatures,
} = require('./fixtures/score-ledger-fixture');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(
    ROOT,
    'buildings/jarvis/storyboard-workbench/.cache'
);

function fixtureValue(definition, index) {
    if (definition.unit === 'probability') return 0.55 + index / 100;
    if (definition.unit === 'views') return 1_000_000 + index * 250_000;
    if (definition.unit === 'log10_views') return 6.4;
    if (definition.unit === 'number') return 1.2 + index / 10;
    if (definition.unit === 'retention_percent_rewatch_capable') {
        return 82 + index / 2;
    }
    return 68 + index / 2;
}

async function main() {
    const ledger = scoreLedgerFromFeatures(Object.fromEntries(
        FEATURE_DEFINITIONS.map((definition, index) => [
            definition.key,
            [fixtureValue(definition, index), 55 + index],
        ])
    ));
    const retentionSource = fs.readFileSync(
        path.join(ROOT, 'buildings/jarvis/jarvis-retention.js'),
        'utf8'
    );
    const indexSource = fs.readFileSync(
        path.join(ROOT, 'index.html'),
        'utf8'
    );
    const serverSource = fs.readFileSync(
        path.join(ROOT, 'server.js'),
        'utf8'
    );
    const fivePanelSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings/jarvis/five-panel-sheet.js'
        ),
        'utf8'
    );
    const styleSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings/jarvis/storyboard-style-presets.js'
        ),
        'utf8'
    );
    assert(
        retentionSource.includes('scoreCandidate: scoreStoryboardCandidate'),
        'workbench must use the canonical Shorts scoring callback'
    );
    const scorerStart = retentionSource.indexOf(
        'async function scoreStoryboardCandidate'
    );
    const scorerEnd = retentionSource.indexOf(
        'async function openStoryboardScore',
        scorerStart
    );
    const scorerSource = retentionSource.slice(scorerStart, scorerEnd);
    assert(
        scorerSource.includes("rtJob('/api/raw/embed-montage'"),
        'storyboards must score through /api/raw/embed-montage'
    );
    assert.strictEqual(
        (scorerSource.match(/\/api\/raw\/embed-montage/g) || []).length,
        1,
        'one storyboard score action must make exactly one canonical score request'
    );
    for (const legacy of [
        'genFramesPanel',
        'rtgPlaceHook',
        'openRawStripPicker',
        'rawFrameDesc',
        'rawGenBusy',
    ]) {
        assert(
            !retentionSource.includes(legacy),
            `legacy storyboard implementation must be removed: ${legacy}`
        );
    }
    assert(
        indexSource.includes('storyboard-workbench.js?v=14')
            && indexSource.indexOf('storyboard-style-presets.js?v=1')
            < indexSource.indexOf('storyboard-workbench.js?v=14')
            && indexSource.indexOf('storyboard-workbench.js?v=14')
            < indexSource.indexOf('jarvis-retention.js?v='),
        'the shared style contract and storyboard module must load before '
            + 'the Shorts integration'
    );
    assert(
        retentionSource.includes('data-auto-image-model')
            && retentionSource.includes('automaticImageModelSelect')
            && indexSource.includes('jarvis-retention.js?v=saved-editor-v1'),
        'Auto and Grind must load the current shared image-model selector'
    );
    assert(
        styleSource.includes('FIVE-FRAME CONTINUITY LOCK')
            && serverSource.includes(
                "require(\n    './buildings/jarvis/storyboard-style-presets'"
            )
            && serverSource.includes('styleContract: style.promptContract'),
        'the server must inject the versioned text-only style contract'
    );
    assert(
        serverSource.includes("'gpt-image-2':")
            && serverSource.includes("provider: 'openai'")
            && serverSource.includes('openAIImageProvider.generateImage'),
        'GPT Image 2 must run through the shared server-side provider boundary'
    );
    assert(
        serverSource.includes("size: size.value,")
            && serverSource.includes("openAIImageProvider.outputSize('storyboard-sheet')"),
        'GPT Image 2 coherent sheets must bind their exact 45:16 output size'
    );
    assert(
        serverSource.includes("width: 1440,\n            height: 512,"),
        'Flux coherent sheets must use an exact 45:16 canvas'
    );
    assert(
        serverSource.includes("width: 2880,\n            height: 1024,"),
        'Seedream coherent sheets must use an exact 45:16 canvas'
    );
    assert(
        serverSource.includes("{ aspectRatio: 'storyboard-sheet' }"),
        'coherent generation must request the five-panel geometry contract'
    );
    assert(
        fivePanelSource.includes('panel 1 occupies 0-20%')
            && fivePanelSource.includes('panel 5 80-100%')
            && serverSource.includes('fivePanelSheet.buildPrompt'),
        'the model prompt must lock all five equal panel boundaries'
    );
    assert(
        serverSource.includes('function storyboardPanelPrompt')
            && serverSource.includes('Continuity is automatic and mandatory')
            && serverSource.includes('Resolve words such as this, that, it')
            && serverSource.includes('CHRONOLOGICAL FIVE-FRAME PLAN:'),
        'single-frame generation must resolve references from the automatic '
            + 'five-frame continuity contract'
    );
    assert(
        serverSource.includes("'target-frame'")
            && serverSource.includes("'sequence-sheet'")
            && serverSource.includes("'storyboard-frame'")
            && serverSource.includes("'external-source'")
            && serverSource.includes('source_panels: sourcePanels'),
        'every image sent to a frame edit must retain its explicit context role'
    );
    assert(
        serverSource.includes("sheet_aspect_ratio: '45:16'")
            && serverSource.includes(
                "postprocess: 'normalize-to-1440x512-then-five-equal-columns'"
            ),
        'every model path must declare the canonical 45:16 postprocess'
    );

    fs.mkdirSync(CACHE, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    await page.setContent(`<!doctype html>
        <html>
        <head><meta charset="utf-8"><title>Storyboard workbench test</title></head>
        <body><main id="app"></main></body>
        </html>`);
    await page.addStyleTag({
        path: path.join(
            ROOT,
            'buildings/jarvis/storyboard-workbench.css'
        ),
    });
    await page.addStyleTag({
        content: `
            html, body { margin: 0; min-height: 100%; background: #080d15; }
            body { color: white; font: 14px Arial, sans-serif; }
            #app { margin: 0 auto; max-width: 1180px; padding: 18px; }
        `,
    });
    await page.addScriptTag({
        path: path.join(
            ROOT,
            'buildings/jarvis/storyboard-style-presets.js'
        ),
    });
    await page.addScriptTag({
        path: path.join(
            ROOT,
            'buildings/jarvis/storyboard-workbench.js'
        ),
    });
    await page.evaluate(({ scoreLedger }) => {
        const clone = value => JSON.parse(JSON.stringify(value));
        const calls = {
            generate: [],
            panel: [],
            montage: [],
            score: [],
            open: [],
            saveScore: [],
            saveStoryboard: [],
            createFolder: [],
            moveItem: [],
            deleteFolder: [],
        };
        const stored = new Map();
        const folders = [];
        let revision = 0;
        let candidateSequence = 0;
        let generationGate = null;
        let releaseGeneration = null;
        let saveGate = null;
        let releaseSave = null;
        let storyboardLoadGate = null;
        let releaseStoryboardLoad = null;
        let storyboardLoadFailures = 0;

        function color(index) {
            return ['#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#8b5cf6'][
                index % 5
            ];
        }

        function frameDataUrl(fill, label) {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 569;
            const context = canvas.getContext('2d');
            context.fillStyle = fill;
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#fff';
            context.font = 'bold 36px Arial';
            context.fillText(label, 24, 64);
            context.fillStyle = 'rgba(0,0,0,.35)';
            context.fillRect(20, 100, 280, 420);
            return canvas.toDataURL('image/png');
        }

        function stripDataUrl(seed) {
            const canvas = document.createElement('canvas');
            canvas.width = 1600;
            canvas.height = 569;
            const context = canvas.getContext('2d');
            for (let index = 0; index < 5; index++) {
                context.fillStyle = color(index + seed);
                context.fillRect(index * 320, 0, 320, 569);
                context.fillStyle = '#fff';
                context.font = 'bold 42px Arial';
                context.fillText(
                    `${seed + 1}.${index + 1}`,
                    index * 320 + 24,
                    62
                );
                context.fillStyle = 'rgba(0,0,0,.28)';
                context.fillRect(index * 320 + 18, 90, 284, 440);
            }
            return canvas.toDataURL('image/png');
        }

        async function composeFrames(frames) {
            const canvas = document.createElement('canvas');
            canvas.width = 1600;
            canvas.height = 569;
            const context = canvas.getContext('2d');
            for (let index = 0; index < frames.length; index++) {
                const image = await new Promise((resolve, reject) => {
                    const value = new Image();
                    value.onload = () => resolve(value);
                    value.onerror = reject;
                    value.src = frames[index];
                });
                context.drawImage(image, index * 320, 0, 320, 569);
            }
            return canvas.toDataURL('image/jpeg', 0.9);
        }

        async function requestJson(url, options = {}) {
            if (url.startsWith('/api/storyboards?')) {
                const parsed = new URL(url, 'http://fixture.local');
                const offset = Number(
                    parsed.searchParams.get('offset')
                ) || 0;
                const limit = Number(
                    parsed.searchParams.get('limit')
                ) || 100;
                const rows = [...stored.values()].map(record => ({
                    id: record.id,
                    revision: record.revision,
                    name: record.name,
                    model: record.model,
                    generationMode: record.generationMode,
                    complete: record.panels.every(panel => !!panel.image),
                    scored: !!record.score,
                    folder: record.folderId || null,
                    folderId: record.folderId || null,
                    updatedAt: record.updatedAt,
                    createdAt: record.createdAt,
                }));
                return {
                    storyboards: rows.slice(offset, offset + limit),
                    total: rows.length,
                    offset,
                    limit,
                    folders: clone(folders),
                };
            }
            if (url === '/api/storyboards/montage') {
                const payload = JSON.parse(options.body || '{}');
                const image = await composeFrames(payload.panels || []);
                calls.montage.push({
                    panelCount: (payload.panels || []).length,
                });
                return {
                    image,
                    media: {
                        url: image,
                        sha256: 'a'.repeat(64),
                        byte_length: image.length,
                        media_type: 'image/jpeg',
                    },
                    panelMediaSha256s: [0, 1, 2, 3, 4].map(
                        index => String(index + 1).repeat(64)
                    ),
                };
            }
            if (url === '/api/storyboards/save') {
                if (saveGate) await saveGate;
                const payload = JSON.parse(options.body || '{}');
                const id = payload.id || `sbfixture${String(++candidateSequence).padStart(4, '0')}`;
                const record = {
                    ...clone(payload),
                    id,
                    revision: `revision-${++revision}`,
                    createdAt: 100,
                    updatedAt: 100 + revision,
                };
                stored.set(id, record);
                calls.saveStoryboard.push(clone(payload));
                return { id, revision: record.revision };
            }
            if (url === '/api/experimentlab/folder') {
                const payload = JSON.parse(options.body || '{}');
                const folder = {
                    id: `elfixture${folders.length + 1}`,
                    name: payload.name,
                };
                folders.push(folder);
                calls.createFolder.push(clone(payload));
                return { ok: true, folder };
            }
            if (url === '/api/experimentlab/item/move') {
                const payload = JSON.parse(options.body || '{}');
                const record = stored.get(payload.id);
                if (record) record.folderId = payload.folderId || null;
                calls.moveItem.push(clone(payload));
                return { ok: true };
            }
            if (url === '/api/experimentlab/folder/delete') {
                const payload = JSON.parse(options.body || '{}');
                const index = folders.findIndex(
                    folder => folder.id === payload.id
                );
                if (index >= 0) folders.splice(index, 1);
                stored.forEach(record => {
                    if (record.folderId === payload.id) {
                        record.folderId = null;
                    }
                });
                calls.deleteFolder.push(clone(payload));
                return { ok: true };
            }
            if (url.startsWith('/api/storyboards/')) {
                if (storyboardLoadGate) await storyboardLoadGate;
                if (storyboardLoadFailures > 0) {
                    storyboardLoadFailures--;
                    throw new Error('fixture saved storyboard timeout');
                }
                const id = decodeURIComponent(url.split('/').pop());
                if (!stored.has(id)) throw new Error('missing storyboard');
                return clone(stored.get(id));
            }
            if (url === '/api/frames/plan') {
                return {
                    order: [0, 1, 2, 3, 4],
                    frames: [0, 1, 2, 3, 4].map(index => ({
                        i: index,
                        relation: index ? 'edit' : 'new',
                        edit_of: index ? index - 1 : null,
                        compose_from: [],
                        prompt: `Directed frame ${index + 1}`,
                    })),
                };
            }
            throw new Error(`unexpected request: ${url}`);
        }

        async function runJob(url, body) {
            if (url === '/api/storyboards/generate') {
                calls.generate.push(clone(body));
                if (generationGate) await generationGate;
                return {
                    image: stripDataUrl(calls.generate.length - 1),
                    panels: [0, 1, 2, 3, 4].map(index => frameDataUrl(
                        ['#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#8b5cf6'][index],
                        `SHEET ${index + 1}`
                    )),
                    renderContract:
                        'canonical-five-panel-storyboard-request-v1',
                    providerCallCount: 1,
                    renderCallCount: 1,
                };
            }
            if (url === '/api/storyboards/panel') {
                calls.panel.push(clone(body));
                return {
                    image: frameDataUrl(
                        '#ec4899',
                        `EDIT ${calls.panel.length}`
                    ),
                };
            }
            throw new Error(`unexpected job: ${url}`);
        }

        async function scoreCandidate(input) {
            calls.score.push({
                id: input.id,
                frameCount: input.frames.length,
                hasMontage: input.montage.startsWith('data:image/'),
                text: input.text,
            });
            return {
                source: 'storyboard',
                title: input.title,
                transcript: input.text,
                score_ledger: clone(scoreLedger),
                score_ledger_validation: { valid: true },
                score_record_sha256: 'c'.repeat(64),
                input_manifest: {
                    score_input_fingerprint: 'b'.repeat(64),
                    input_fingerprint: 'b'.repeat(64),
                    output_fingerprint: 'd'.repeat(64),
                    revision_fingerprint: 'e'.repeat(64),
                    embedding_model: 'fixture-multimodal',
                    embedding_dimensions: 1536,
                    canonical_montage: {
                        montage_sha256: 'a'.repeat(64),
                    },
                },
            };
        }

        async function openScore(result) {
            if (
                !result.montageDataUrl
                && Array.isArray(result.storyboardFrames)
            ) {
                result.montageDataUrl = await composeFrames(
                    result.storyboardFrames
                );
            }
            calls.open.push({
                hasMontage: !!result.montageDataUrl,
                ledgerSha256: result.score_ledger.ledger_sha256,
            });
        }

        window.JarvisUpload = {
            queue: [],
            pickFiles(config) {
                const files = this.queue.shift() || [];
                Promise.resolve().then(() => config.onSelect(files));
            },
        };
        window.__holdGeneration = () => {
            generationGate = new Promise(resolve => {
                releaseGeneration = resolve;
            });
        };
        window.__releaseGeneration = () => {
            if (releaseGeneration) releaseGeneration();
            generationGate = null;
            releaseGeneration = null;
        };
        window.__holdSave = () => {
            saveGate = new Promise(resolve => {
                releaseSave = resolve;
            });
        };
        window.__releaseSave = () => {
            if (releaseSave) releaseSave();
            saveGate = null;
            releaseSave = null;
        };
        window.__holdStoryboardLoad = () => {
            storyboardLoadGate = new Promise(resolve => {
                releaseStoryboardLoad = resolve;
            });
        };
        window.__releaseStoryboardLoad = () => {
            if (releaseStoryboardLoad) releaseStoryboardLoad();
            storyboardLoadGate = null;
            releaseStoryboardLoad = null;
        };
        window.__failNextStoryboardLoad = () => {
            storyboardLoadFailures++;
        };
        window.__queueStrips = async count => {
            const files = [];
            for (let index = 0; index < count; index++) {
                const response = await fetch(stripDataUrl(index + 2));
                const blob = await response.blob();
                files.push(new File(
                    [blob],
                    `candidate-${index + 1}.png`,
                    { type: 'image/png' }
                ));
            }
            window.JarvisUpload.queue.push(files);
        };
        window.__queueReferences = async count => {
            const files = [];
            for (let index = 0; index < count; index++) {
                const response = await fetch(frameDataUrl(
                    color(index),
                    `REF ${index + 1}`
                ));
                files.push(new File(
                    [await response.blob()],
                    `reference-${index + 1}.png`,
                    { type: 'image/png' }
                ));
            }
            window.JarvisUpload.queue.push(files);
        };
        window.__fixtureStripDataUrl = stripDataUrl;
        const workbench = window.JarvisStoryboardWorkbench.create({
            escapeHtml: value => String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;'),
            requestJson,
            runJob,
            composeFrames,
            scoreCandidate,
            openScore,
            autoPersistScore: true,
            autoPersistDrafts: true,
            enableFolders: true,
            saveScore: async (score, overrides) => {
                calls.saveScore.push({
                    ledgerSha256: score.score_ledger.ledger_sha256,
                    hasMontage: !!overrides.montage,
                });
                return { id: `saved-hook-${calls.saveScore.length}` };
            },
            getCreatorProfile: () => 'tyler',
            onError: error => {
                window.__reportedError = String(error);
            },
        });
        const app = document.getElementById('app');
        app.innerHTML = workbench.render();
        document.addEventListener('click', event => {
            if (workbench.handleClick(event)) event.preventDefault();
        });
        document.addEventListener('input', event => {
            workbench.handleInput(event);
        });
        document.addEventListener('change', event => {
            workbench.handleChange(event);
        });
        document.addEventListener('keydown', event => {
            workbench.handleKeyDown(event);
        });
        workbench.afterRender();
        window.__workbench = workbench;
        window.__calls = calls;
        window.__stored = stored;
    }, { scoreLedger: ledger });

    assert.strictEqual(
        await page.locator('[data-sb-manual-progress]').count(),
        1,
        'the AI route must expose one concise build progression'
    );
    assert.deepStrictEqual(
        await page.locator('[data-sb-section]').evaluateAll(nodes => (
            nodes.map(node => node.getAttribute('data-sb-section'))
        )),
        ['upload', 'build', 'refine'],
        'the workbench must expose upload and AI as alternate starts '
            + 'before their shared refine stage'
    );
    assert.strictEqual(
        await page.locator('[data-sb-view], [data-sb-generation-mode]').count(),
        0,
        'the workbench must not expose fake Compose/Compare or generation modes'
    );
    assert.strictEqual(
        await page.locator('[data-sb-hook-text]').count(),
        0,
        'spoken text must come after the visual panel exists'
    );
    assert.strictEqual(
        await page.locator('[data-sb-model]').inputValue(),
        'gpt-image-2',
        'new storyboards must default to the newest OpenAI image model'
    );
    assert.deepStrictEqual(
        await page.locator('[data-sb-model] option').evaluateAll(options => (
            options.map(option => [option.value, option.textContent.trim()])
        )),
        [
            ['gpt-image-2', 'GPT Image 2 (OpenAI)'],
            ['flux-2-pro', 'FLUX.2 Pro'],
            ['seedream-4', 'Seedream 4'],
            ['nano-banana', 'Nano Banana'],
            ['nano-banana-pro', 'Nano Banana Pro'],
        ],
        'the model picker must expose GPT Image 2 without removing existing providers'
    );

    await page.click('[data-sb-folder-new]');
    await page.fill('[data-sb-folder-name]', 'Launch concepts');
    await page.click('[data-sb-folder-create]');
    await page.waitForFunction(() => (
        window.__workbench.getState().candidates[0].folderId
            === 'elfixture1'
    ));
    assert.strictEqual(
        await page.evaluate(() => window.__calls.createFolder.length),
        1,
        'account folders must be created through workspace metadata only'
    );

    await page.fill(
        '[data-sb-brief]',
        'A spill-proof machine is tested across five escalating scenes.'
    );
    await page.click('.sb-style-toggle');
    assert.strictEqual(
        await page.evaluate(() => (
            window.__workbench.getState().candidates[0].stylePreset
        )),
        'stylized-3d-explainer-v1',
        'the animation switch must select the versioned style preset'
    );
    await page.evaluate(() => window.__queueReferences(2));
    await page.click('[data-sb-add-reference]');
    await page.waitForFunction(() => (
        window.__workbench.getState().candidates[0]
            .references.length === 2
    ));
    await page.evaluate(() => window.__holdGeneration());
    await page.click('[data-sb-generate-all]');
    await page.waitForFunction(() => (
        window.__workbench.getState().busy
    ));
    assert.strictEqual(
        await page.locator('[data-sb-brief]').isDisabled(),
        true,
        'mutable controls must lock while generation is in flight'
    );
    assert.strictEqual(
        await page.locator('[data-sb-upload-panel]').isDisabled(),
        true,
        'uploads must lock while generation is in flight'
    );
    await page.evaluate(() => window.__releaseGeneration());
    await page.waitForFunction(() => {
        const state = window.__workbench.getState();
        return !state.busy
            && state.candidates[0].panels.every(panel => !!panel.image);
    });
    await page.waitForFunction(() => {
        const current = window.__workbench.getState().candidates[0];
        return current.saveState === 'saved' && !!current.serverId;
    });
    assert.strictEqual(
        await page.locator('[data-sb-transcript-review]').count(),
        1,
        'AI-built openings must pause at the shared transcript review'
    );
    const coherent = await page.evaluate(() => {
        const state = window.__workbench.getState();
        return {
            generateCalls: window.__calls.generate.length,
            panelCount: state.candidates[0].panels.length,
            sources: state.candidates[0].panels.map(panel => panel.source),
            payload: window.__calls.generate[0],
        };
    });
    assert.strictEqual(coherent.generateCalls, 1);
    assert.strictEqual(coherent.panelCount, 5);
    assert(coherent.sources.every(source => source === 'coherent-sheet'));
    assert.strictEqual(coherent.payload.async, true);
    assert.strictEqual(coherent.payload.model, 'gpt-image-2');
    assert.strictEqual(
        coherent.payload.stylePreset,
        'stylized-3d-explainer-v1'
    );
    assert.strictEqual(coherent.payload.panels.length, 5);
    assert.strictEqual(
        coherent.payload.brief,
        'A spill-proof machine is tested across five escalating scenes.'
    );
    assert.strictEqual(
        coherent.payload.hookText,
        '',
        'spoken text must not silently steer whole-panel generation'
    );
    assert.deepStrictEqual(
        coherent.payload.layout,
        {
            panelCount: 5,
            panelAspectRatio: '9:16',
            sheetAspectRatio: '45:16',
            direction: 'left-to-right',
        },
        'the client must send the same geometry contract enforced by the server'
    );
    assert.strictEqual(
        await page.evaluate(() => window.__calls.score.length),
        0,
        'generation persistence must never invoke the embed scorer'
    );
    assert.strictEqual(
        await page.evaluate(() => (
            window.__calls.saveStoryboard[0].folderId
        )),
        'elfixture1',
        'the generated draft must persist immediately in its account folder'
    );
    assert.strictEqual(
        coherent.payload.refs.length,
        2,
        'enabling animation must not add either supplied example as an image '
            + 'reference'
    );
    assert(
        !JSON.stringify(coherent.payload.refs).includes(
            'stylized-3d-explainer'
        ),
        'the style preset must travel as text identity, never disguised as '
            + 'an image reference'
    );
    assert.deepStrictEqual(
        coherent.payload.refs.map(reference => ({
            global: reference.global,
            panels: reference.panels,
        })),
        [
            { global: true, panels: [] },
            { global: true, panels: [] },
        ],
        'uploaded references must be available automatically to the whole panel'
    );
    assert.strictEqual(
        await page.locator('[data-sb-whole-panel]').count(),
        1,
        'the canonical generated sheet must stay visible before frame edits'
    );
    const geometry = await page.evaluate(async () => {
        const current = window.__workbench.getState().candidates[0];
        const dimensions = source => new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve([image.width, image.height]);
            image.onerror = reject;
            image.src = source;
        });
        return {
            sheet: await dimensions(current.composite),
            frames: await Promise.all(
                current.panels.map(panel => dimensions(panel.image))
            ),
        };
    });
    assert.deepStrictEqual(geometry.sheet, [1440, 512]);
    assert(
        geometry.frames.every(size => (
            size[0] === 320 && size[1] === 569
        )),
        'the canonical sheet must split into five fixed 9:16 frame artifacts'
    );
    assert.strictEqual(
        await page.locator(
            '[data-sb-context-panel], [data-sb-ref-scope]'
        ).count(),
        0,
        'continuity must never require manual image selection'
    );
    await page.fill(
        '[data-sb-hook-text]',
        'This machine makes it impossible to spill.'
    );

    const canvas = page.locator('[data-sb-draw-canvas]');
    let bounds = await canvas.boundingBox();
    assert(bounds && bounds.width > 0 && bounds.height > 0);
    assert.strictEqual(
        await canvas.evaluate(element => getComputedStyle(element).touchAction),
        'pan-y',
        'canvas must start in page-scroll mode'
    );
    await page.click('[data-sb-draw-mode="draw"]');
    bounds = await canvas.boundingBox();
    assert(bounds && bounds.width > 0 && bounds.height > 0);
    await page.mouse.move(bounds.x + 35, bounds.y + 45);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 125, bounds.y + 165, { steps: 5 });
    await page.mouse.up();
    await page.click('[data-sb-draw-apply]');
    await page.waitForFunction(() => (
        window.__workbench.getState().candidates[0].panels[0].source
            === 'annotated-frame'
    ));

    await page.fill(
        '[data-sb-edit-prompt]',
        'Make the liquid bright blue and preserve the same machine.'
    );
    await page.click('[data-sb-generate-panel]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__calls.panel.length === 1
    ));
    const edit = await page.evaluate(() => {
        const current = window.__workbench.getState().candidates[0];
        return {
            relation: current.panels[0].relation,
            source: current.panels[0].source,
            revisions: current.panels[0].revisions.length,
            refs: window.__calls.panel[0].refs.length,
            referenceRoles: window.__calls.panel[0].refs.map(
                reference => reference.role
            ),
            referenceScopes: window.__calls.panel[0].refs.map(
                reference => ({
                    global: reference.global,
                    panels: reference.panels,
                })
            ),
            targetPanel: window.__calls.panel[0].targetPanel,
            stylePreset: window.__calls.panel[0].stylePreset,
            brief: window.__calls.panel[0].brief,
            panels: window.__calls.panel[0].panels,
            context: window.__calls.panel[0].context,
            sourcePanels: current.panels[0].sourcePanels,
        };
    });
    assert.strictEqual(edit.relation, 'edit');
    assert.strictEqual(edit.source, 'panel-edit');
    assert(edit.revisions >= 2);
    assert.strictEqual(
        edit.refs,
        8,
        'frame edits must deterministically fill the context budget with the '
            + 'base, live sheet, neighbors, uploads, and remaining frames'
    );
    assert.deepStrictEqual(edit.referenceRoles, [
        'target-frame',
        'sequence-sheet',
        'storyboard-frame',
        'external-source',
        'external-source',
        'storyboard-frame',
        'storyboard-frame',
        'storyboard-frame',
    ]);
    assert(
        edit.referenceScopes.every(reference => (
            reference.global === false
            && JSON.stringify(reference.panels) === '[0]'
        )),
        'every automatic reference must be scoped to the selected output frame'
    );
    assert.strictEqual(edit.targetPanel, 0);
    assert.strictEqual(
        edit.stylePreset,
        'stylized-3d-explainer-v1',
        'frame refinements must reuse the whole-panel animation style'
    );
    assert.strictEqual(
        edit.brief,
        'A spill-proof machine is tested across five escalating scenes.'
    );
    assert.strictEqual(
        edit.panels.length,
        5,
        'every panel request must carry the full chronological frame plan'
    );
    assert.deepStrictEqual(edit.context, {
        policy: 'automatic-continuity-v2',
        sourcePanels: [0, 1, 2, 3, 4],
        includesSequence: true,
    });
    assert.deepStrictEqual(
        edit.sourcePanels,
        [0, 1, 2, 3, 4],
        'frame lineage must identify the exact storyboard context sent'
    );

    await page.click('[data-sb-restore-panel="previous"]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__workbench.getState().candidates[0]
            .panels[0].source === 'annotated-frame'
    ));
    await page.click('[data-sb-restore-panel="previous"]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__workbench.getState().candidates[0]
            .panels[0].source === 'coherent-sheet'
    ));
    assert.strictEqual(
        await page.evaluate(() => (
            window.__workbench.getState().candidates[0]
                .panels[0].revisions.length
        )),
        0,
        'revision history must walk C to B to A without toggling'
    );
    await page.click('[data-sb-restore-panel="next"]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__workbench.getState().candidates[0]
            .panels[0].source === 'annotated-frame'
    ));
    await page.click('[data-sb-restore-panel="next"]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__workbench.getState().candidates[0]
            .panels[0].source === 'panel-edit'
    ));
    await page.click('[data-sb-restore-panel="previous"]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__workbench.getState().candidates[0]
            .panels[0].source === 'annotated-frame'
    ));

    const nativeUndoPreserved = await page.evaluate(() => {
        const input = document.querySelector('[data-sb-hook-text]');
        const event = new KeyboardEvent('keydown', {
            key: 'z',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        });
        return input.dispatchEvent(event);
    });
    assert(
        nativeUndoPreserved,
        'text inputs must retain their native undo behavior'
    );

    const storyboardSavesBeforeScore = await page.evaluate(() => (
        window.__calls.saveStoryboard.length
    ));
    await page.evaluate(() => window.__holdSave());
    await page.click('[data-sb-score-current]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && !!window.__workbench.getState().candidates[0].score
    ));
    assert.strictEqual(
        await page.evaluate(() => window.__calls.score.length),
        1
    );
    assert.deepStrictEqual(
        await page.evaluate(() => window.__calls.montage),
        [{ panelCount: 5 }],
        'each score must use one server-assembled five-panel montage'
    );
    await page.waitForFunction(() => window.__calls.open.length === 1);
    assert.strictEqual(
        await page.evaluate(() => window.__calls.open[0].hasMontage),
        true,
        'a completed score must open its canonical analysis automatically'
    );
    assert.strictEqual(
        await page.evaluate(() => window.__calls.saveScore.length),
        0,
        'the score analysis must open before background persistence finishes'
    );
    await page.evaluate(() => window.__releaseSave());
    await page.waitForFunction(() => (
        window.__calls.saveScore.length === 1
        && window.__workbench.getState().candidates[0]
            .savedHookId === 'saved-hook-1'
    ));
    assert.deepStrictEqual(
        await page.evaluate(before => ({
            savedHooks: window.__calls.saveScore.length,
            scorePersistenceRevisions:
                window.__calls.saveStoryboard.length - before,
            savedHookId: window.__workbench.getState().candidates[0]
                .savedHookId,
        }), storyboardSavesBeforeScore),
        {
            savedHooks: 1,
            scorePersistenceRevisions: 2,
            savedHookId: 'saved-hook-1',
        },
        'Experiment Lab scoring must first persist the complete score, then '
            + 'persist its Saved Hooks cross-link without rescoring'
    );
    await page.click('[data-sb-open-score]');
    await page.waitForFunction(() => window.__calls.open.length === 2);
    assert.strictEqual(
        await page.evaluate(() => window.__calls.open[1].hasMontage),
        true
    );

    const savesBeforeNoop = await page.evaluate(() => (
        window.__calls.saveStoryboard.length
    ));
    await page.click('[data-sb-save]');
    assert.strictEqual(
        await page.evaluate(() => window.__calls.saveStoryboard.length),
        savesBeforeNoop,
        'Save must be instant when the durable revision is already current'
    );
    assert.strictEqual(
        await page.evaluate(() => window.__calls.saveScore.length),
        1
    );
    const savedId = await page.evaluate(() => (
        window.__workbench.getState().candidates[0].serverId
    ));
    await page.waitForFunction(id => (
        !!document.querySelector(
            `[data-sb-load-saved] option[value="${id}"]`
        )
    ), savedId);
    await page.click('[data-sb-new]');
    const originalCandidateId = await page.evaluate(id => (
        window.__workbench.getState().candidates.find(
            candidate => candidate.serverId === id
        ).id
    ), savedId);
    await page.click(
        `[data-sb-delete-candidate="${originalCandidateId}"]`
    );
    await page.evaluate(() => window.__failNextStoryboardLoad());
    await page.selectOption('[data-sb-load-saved]', savedId);
    await page.waitForFunction(id => {
        const current = window.__workbench.getState().candidates.find(
            candidate => candidate.serverId === id
        );
        return current
            && current.mediaState === 'error'
            && /timeout/i.test(current.mediaError);
    }, savedId);
    assert.strictEqual(
        await page.locator('[data-sb-retry-storyboard]').count(),
        1,
        'a failed saved load must remain visibly retryable in the editor'
    );
    await page.evaluate(() => window.__holdStoryboardLoad());
    await page.selectOption('[data-sb-load-saved]', savedId);
    await page.waitForFunction(id => {
        const state = window.__workbench.getState();
        const current = state.candidates.find(
            candidate => candidate.serverId === id
        );
        return !state.busy
            && current
            && current.mediaState === 'loading'
            && state.selectedCandidateId === current.id;
    }, savedId);
    assert.match(
        await page.locator('.sb-status').textContent(),
        /open.*loading/i,
        'a saved storyboard must enter the editor before its manifest and '
            + 'images finish loading'
    );
    await page.evaluate(() => window.__releaseStoryboardLoad());
    await page.waitForFunction(id => {
        const current = window.__workbench.getState().candidates.find(
            candidate => candidate.serverId === id
        );
        return !window.__workbench.getState().busy
            && current
            && current.mediaState === 'ready'
            && !!current.score;
    }, savedId);
    await page.click('[data-sb-open-score]');
    await page.waitForFunction(() => window.__calls.open.length === 3);
    const reopen = await page.evaluate(() => ({
        scoreCalls: window.__calls.score.length,
        hasMontage: window.__calls.open[2].hasMontage,
        hasComposite: !!window.__workbench.getState().candidates[0]
            .composite,
    }));
    assert.strictEqual(reopen.scoreCalls, 1, 'saved reopen must not rescore');
    assert.strictEqual(reopen.hasMontage, true);
    assert.strictEqual(
        reopen.hasComposite,
        true,
        'saved storyboards must restore the canonical whole-panel artifact'
    );
    assert.strictEqual(
        await page.locator('[data-sb-animation-style]').isChecked(),
        true,
        'the animation style must survive save and reload'
    );
    assert.strictEqual(
        await page.locator('[data-sb-auto-continuity]').count(),
        1,
        'saved storyboards must expose one automatic continuity status, not selectors'
    );
    const scoreCallsBeforeMove = await page.evaluate(() => (
        window.__calls.score.length
    ));
    await page.selectOption('[data-sb-current-folder]', '');
    await page.waitForFunction(() => (
        window.__calls.moveItem.length === 1
    ));
    assert.strictEqual(
        await page.evaluate(() => window.__calls.score.length),
        scoreCallsBeforeMove,
        'folder organization must never invoke the embed scorer'
    );
    await page.fill(
        '[data-sb-brief]',
        'Unsaved local revision that must not be overwritten.'
    );
    await page.selectOption('[data-sb-load-saved]', savedId);
    await page.waitForFunction(() => (
        /unsaved edits/i.test(
            window.__workbench.getState().error
        )
    ));
    assert.strictEqual(
        await page.locator('[data-sb-brief]').inputValue(),
        'Unsaved local revision that must not be overwritten.',
        'reopening a saved record must not overwrite a dirty local copy'
    );

    await page.click('[data-sb-new]');
    await page.evaluate(() => window.__queueStrips(2));
    await page.click('[data-sb-upload-strips]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__workbench.getState().candidates.length === 4
        && window.__calls.score.length === 1
    ));
    assert.strictEqual(
        await page.locator('.sb-candidate-card').count(),
        4,
        'multiple imports must appear together without switching views'
    );
    assert.strictEqual(
        await page.locator('.sb-candidate-copy small.is-done').count(),
        1,
        'imported strips must not score before an explicit action'
    );
    assert.strictEqual(
        await page.locator('.sb-candidate-metrics > span').count(),
        3,
        'only the previously scored candidate may expose score metrics'
    );
    assert.strictEqual(
        await page.locator('[data-sb-transcript-review]').count(),
        1,
        'finished-strip imports must open the shared transcript review'
    );
    await page.fill(
        '[data-sb-transcript-review] [data-sb-hook-text]',
        'Manual transcript supplied after the finished strip was uploaded.'
    );
    assert.strictEqual(
        await page.evaluate(() => window.__calls.score.length),
        1,
        'editing the transcript must not trigger scoring'
    );
    await page.click('[data-sb-score-current]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__calls.score.length === 2
    ));
    assert.strictEqual(
        await page.evaluate(() => window.__calls.score.at(-1).text),
        'Manual transcript supplied after the finished strip was uploaded.',
        'the explicit score action must include the reviewed transcript'
    );
    assert.strictEqual(
        await page.locator('.sb-candidate-copy small.is-done').count(),
        2,
        'the selected strip must become scored only after the explicit action'
    );
    assert.strictEqual(
        await page.locator('.sb-candidate-metrics > span').count(),
        6,
        'explicitly scored candidates must expose the canonical summaries'
    );

    const beforeOverflow = await page.evaluate(() => (
        window.__workbench.getState().candidates.map(item => item.id)
    ));
    await page.evaluate(() => window.__queueStrips(12));
    await page.click('[data-sb-upload-strips]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__workbench.getState().candidates.length === 12
    ));
    const overflow = await page.evaluate(ids => ({
        ids: window.__workbench.getState().candidates.map(item => item.id),
        error: window.__workbench.getState().error,
        status: window.__workbench.getState().status,
        retained: ids.every(id => (
            window.__workbench.getState().candidates
                .some(item => item.id === id)
        )),
    }), beforeOverflow);
    assert(overflow.retained, 'batch import must never evict existing work');
    assert.match(overflow.error, /did not fit/);
    assert.match(overflow.status, /^8 storyboards imported\./);
    assert.strictEqual(
        await page.evaluate(() => window.__calls.score.length),
        2,
        'bulk imports must also wait for an explicit score action'
    );
    await page.click('[data-sb-batch-score]');
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
        && window.__calls.score.length === 11
    ));
    assert.match(
        await page.evaluate(() => window.__workbench.getState().status),
        /^Batch complete: 9\/9 scored/
    );
    const autosaveBefore = await page.evaluate(() => ({
        saves: window.__calls.saveStoryboard.length,
        scores: window.__calls.score.length,
    }));
    await page.evaluate(() => {
        window.__autosaveFocusNode = document.querySelector(
            '[data-sb-name]'
        );
    });
    await page.fill(
        '[data-sb-name]',
        'Typed changes persist without a save click'
    );
    await page.waitForFunction(before => (
        window.__calls.saveStoryboard.length > before
        && window.__workbench.getState()
            .candidates.find(candidate => (
                candidate.id
                    === window.__workbench.getState().selectedCandidateId
            )).saveState === 'saved'
    ), autosaveBefore.saves);
    assert.strictEqual(
        await page.evaluate(() => window.__calls.score.length),
        autosaveBefore.scores,
        'debounced text persistence must never invoke the embed scorer'
    );
    assert.deepStrictEqual(
        await page.evaluate(() => ({
            sameNode: document.querySelector('[data-sb-name]')
                === window.__autosaveFocusNode,
            stillFocused: document.activeElement
                === window.__autosaveFocusNode,
        })),
        { sameNode: true, stillFocused: true },
        'background persistence must not rebuild the editor or take focus'
    );

    const selectedBeforeRevision = await page.evaluate(() => (
        window.__workbench.getState().selectedCandidateId
    ));
    await page.click(
        `[data-sb-delete-candidate="${selectedBeforeRevision}"]`
    );
    await page.evaluate(async () => {
        await window.__workbench.importSavedHook({
            id: 'saved-origin-1',
            title: 'Editable saved opening',
            idea: 'A machine is tested in five escalating scenes.',
            text: 'This machine should not be able to do this.',
            frames: [0, 1, 2, 3, 4].map(index => ({
                prompt: `Saved frame prompt ${index + 1}`,
            })),
            montage: window.__fixtureStripDataUrl(20),
        });
    });
    await page.waitForFunction(() => {
        const state = window.__workbench.getState();
        const current = state.candidates.find(candidate => (
            candidate.id === state.selectedCandidateId
        ));
        return !state.busy
            && current
            && current.sourceSavedHookId === 'saved-origin-1'
            && current.panels.every(panel => !!panel.image);
    });
    const importedRevision = await page.evaluate(() => {
        const state = window.__workbench.getState();
        const current = state.candidates.find(candidate => (
            candidate.id === state.selectedCandidateId
        ));
        return {
            sourceSavedHookId: current.sourceSavedHookId,
            title: current.name,
            text: current.hookText,
            prompts: current.panels.map(panel => panel.prompt),
            score: current.score,
            savedHookId: current.savedHookId,
            panelIds: current.panels.map(panel => panel.id),
        };
    });
    assert.strictEqual(
        importedRevision.sourceSavedHookId,
        'saved-origin-1'
    );
    assert.strictEqual(importedRevision.title, 'Editable saved opening');
    assert.strictEqual(
        importedRevision.text,
        'This machine should not be able to do this.'
    );
    assert.deepStrictEqual(
        importedRevision.prompts,
        [1, 2, 3, 4, 5].map(index => (
            `Saved frame prompt ${index}`
        ))
    );
    assert.strictEqual(
        importedRevision.score,
        null,
        'editing must fork a new unscored revision rather than mutate the '
            + 'saved score artifact'
    );
    assert.strictEqual(importedRevision.savedHookId, null);
    assert.strictEqual(
        await page.locator('[data-sb-panel-move]').count(),
        10,
        'every frame must expose mobile-safe left/right reorder controls'
    );
    await page.locator('[data-sb-panel-drag="0"]').dragTo(
        page.locator('[data-sb-panel-slot="2"]')
    );
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
    ));
    const draggedRevision = await page.evaluate(before => {
        const state = window.__workbench.getState();
        const current = state.candidates.find(candidate => (
            candidate.id === state.selectedCandidateId
        ));
        return {
            panelIds: current.panels.map(panel => panel.id),
            prompts: current.panels.map(panel => panel.prompt),
            score: current.score,
            savedHookId: current.savedHookId,
            movedWholePanel:
                current.panels[2].id === before.panelIds[0]
                && current.panels[2].prompt === before.prompts[0],
        };
    }, importedRevision);
    assert(draggedRevision.movedWholePanel);
    assert.deepStrictEqual(draggedRevision.panelIds, [
        importedRevision.panelIds[1],
        importedRevision.panelIds[2],
        importedRevision.panelIds[0],
        importedRevision.panelIds[3],
        importedRevision.panelIds[4],
    ]);
    assert.strictEqual(draggedRevision.score, null);
    assert.strictEqual(draggedRevision.savedHookId, null);
    await page.waitForFunction(() => {
        const state = window.__workbench.getState();
        const current = state.candidates.find(candidate => (
            candidate.id === state.selectedCandidateId
        ));
        return current && current.saveState === 'saved';
    });
    assert.deepStrictEqual(
        await page.evaluate(() => (
            window.__calls.saveStoryboard.at(-1).panels.map(
                panel => panel.prompt
            )
        )),
        draggedRevision.prompts,
        'background persistence must store the reordered panel sequence'
    );

    await page.screenshot({
        path: path.join(CACHE, 'desktop.png'),
        fullPage: true,
    });

    await page.locator('[data-sb-select-candidate]').first().click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const mobileOrderBefore = await page.evaluate(() => {
        const state = window.__workbench.getState();
        const current = state.candidates.find(candidate => (
            candidate.id === state.selectedCandidateId
        ));
        return current.panels.map(panel => panel.id);
    });
    await page.click(
        '[data-sb-panel-index="0"][data-sb-panel-move="1"]'
    );
    await page.waitForFunction(() => (
        !window.__workbench.getState().busy
    ));
    assert.deepStrictEqual(
        await page.evaluate(() => {
            const state = window.__workbench.getState();
            const current = state.candidates.find(candidate => (
                candidate.id === state.selectedCandidateId
            ));
            return current.panels.map(panel => panel.id);
        }),
        [
            mobileOrderBefore[1],
            mobileOrderBefore[0],
            mobileOrderBefore[2],
            mobileOrderBefore[3],
            mobileOrderBefore[4],
        ],
        'phone users must be able to reorder frames without HTML drag support'
    );
    const mobile = await page.evaluate(() => {
        const rail = document.querySelector('[data-sb-panel-rail]');
        const stage = document.querySelector('[data-sb-stage]');
        const canvas = document.querySelector('[data-sb-draw-canvas]');
        return {
            bodyScrollable:
                document.documentElement.scrollHeight
                    > document.documentElement.clientHeight,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            railScrollable: rail.scrollWidth > rail.clientWidth,
            stageWidth: stage.getBoundingClientRect().width,
            touchAction: getComputedStyle(canvas).touchAction,
        };
    });
    assert(mobile.bodyScrollable, 'mobile compose view must scroll vertically');
    assert(
        mobile.documentWidth <= mobile.viewportWidth + 1,
        `mobile page overflowed: ${mobile.documentWidth}px > ${mobile.viewportWidth}px`
    );
    assert(mobile.railScrollable, 'five-panel rail must scroll horizontally');
    assert(mobile.stageWidth <= mobile.viewportWidth);
    assert.strictEqual(mobile.touchAction, 'pan-y');
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(50);
    assert(
        await page.evaluate(() => window.scrollY > 0),
        'mobile page must retain user-controlled scroll position'
    );
    await page.screenshot({
        path: path.join(CACHE, 'mobile.png'),
        fullPage: true,
    });

    await browser.close();
    assert.deepStrictEqual(errors, [], errors.join('\n'));
    console.log(JSON.stringify({
        ok: true,
        coherentGenerationCalls: coherent.generateCalls,
        canonicalScoreCalls: 11,
        batchCandidates: 12,
        savedReopenRescored: false,
        mobile,
        screenshots: {
            desktop: path.join(CACHE, 'desktop.png'),
            mobile: path.join(CACHE, 'mobile.png'),
        },
    }, null, 2));
}

main().catch(error => {
    console.error(error && error.stack || error);
    process.exit(1);
});
