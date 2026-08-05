#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function main() {
    const root = path.resolve(__dirname, '..');
    const source = fs.readFileSync(
        path.join(root, 'server.js'),
        'utf8'
    );
    assert(
        source.includes('IMMUTABLE VIDEO IDEA (do not change)')
            && source.includes('brief: immutableRenderBrief')
            && source.includes('video_idea: premise'),
        'Grind must pass the immutable video idea through the single-sheet render contract'
    );
    const start = source.indexOf('function hookPanelModelKey');
    const end = source.indexOf(
        'async function hookModelGenerateRetry',
        start
    );
    assert(start >= 0 && end > start);

    let providerCalls = 0;
    let splitCalls = 0;
    let failProvider = false;
    const context = vm.createContext({
        Buffer,
        process: { env: {} },
        RAW_PY_ENV: {},
        setTimeout,
        STORYBOARD_DEFAULT_MODEL: 'gpt-image-2',
        STORY_MODELS: {
            'gpt-image-2': {
                slug: 'gpt-image-2',
                provider: 'openai',
            },
            'flux-2-pro': {
                slug: 'flux-2-pro',
                provider: 'replicate',
            },
            'seedream-4': {
                slug: 'seedream-4',
                provider: 'replicate',
            },
        },
        storyboardStylePresets: {
            ANIMATION_STYLE_ID: 'animation',
            DEFAULT_STYLE_ID: 'default',
            stylePreset(id) {
                return { id, promptContract: 'style' };
            },
        },
        storyboardSheetPrompt() {
            return 'single sheet prompt';
        },
        storyboardSheetGeometry() {
            return {
                sheet_aspect_ratio: '45:16',
                panel_count: 5,
            };
        },
        fivePanelSheet: {
            normalizePanels(panels) {
                return panels;
            },
            async splitImage() {
                splitCalls += 1;
                return {
                    frames: Array.from(
                        { length: 5 },
                        () => Buffer.from('frame')
                    ),
                    montage: Buffer.from('montage'),
                    geometry: {
                        render_call_count: 1,
                        panel_count: 5,
                    },
                };
            },
        },
        async genStoryFrame() {
            providerCalls += 1;
            if (failProvider) throw new Error('provider failed');
            return 'data:image/jpeg;base64,eA==';
        },
        decodeStoryboardDataImage() {
            return { bytes: Buffer.from('sheet') };
        },
    });
    vm.runInContext(
        `${source.slice(start, end)}\nthis.render = renderHookPanelRobust;`,
        context
    );

    const result = await context.render({
        brief: 'test',
        hookText: 'test',
        panels: ['1', '2', '3', '4', '5'],
        animation: false,
        imageModel: 'gpt-image-2',
        strictImageModel: true,
        providerCallBudget: 1,
    });
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(splitCalls, 1);
    assert.strictEqual(result.frames.length, 5);
    assert.strictEqual(result.geometry.provider_call_count, 1);
    assert.strictEqual(result.geometry.render_call_count, 1);

    providerCalls = 0;
    splitCalls = 0;
    failProvider = true;
    await assert.rejects(
        context.render({
            brief: 'test',
            hookText: 'test',
            panels: ['1', '2', '3', '4', '5'],
            animation: false,
            imageModel: 'gpt-image-2',
            strictImageModel: true,
            providerCallBudget: 1,
        }),
        /provider failed/
    );
    assert.strictEqual(
        providerCalls,
        1,
        'a Grind attempt must not hide retries or fallback image calls'
    );
    assert.strictEqual(splitCalls, 0);

    console.log('hook single-sheet renderer contract: ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
