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
    assert.strictEqual(
        (source.match(/generateFivePanelStoryboard\(/g) || []).length,
        2,
        'only the canonical opening boundary may call the low-level renderer'
    );
    assert.strictEqual(
        (source.match(/generateCanonicalHookOpening\(/g) || []).length,
        4,
        'manual Storyboard, Auto, and Grind must call one complete-opening method'
    );
    assert(!source.includes('renderHookPanelRobust'));
    const start = source.indexOf('function hookPanelModelKey');
    const end = source.indexOf(
        'async function hookModelGenerateRetry',
        start
    );
    assert(start >= 0 && end > start);

    let providerCalls = 0;
    let splitCalls = 0;
    let failProvider = false;
    let promptInput = null;
    let providerInput = null;
    let sourceWidth = 2880;
    let sourceHeight = 1024;
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
                return {
                    id,
                    promptContract:
                        id === 'animation'
                            ? 'FIVE-FRAME CONTINUITY LOCK'
                            : '',
                };
            },
        },
        storyboardSheetPrompt(input) {
            promptInput = input;
            return `single sheet prompt ${input.styleContract || ''}`;
        },
        storyboardSheetGeometry() {
            return {
                sheet_aspect_ratio: '45:16',
                panel_count: 5,
            };
        },
        fivePanelSheet: {
            PANEL_COUNT: 5,
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
        async genStoryFrame(model, prompt, refs, relation, options) {
            providerCalls += 1;
            providerInput = { model, prompt, refs, relation, options };
            if (failProvider) throw new Error('provider failed');
            return 'data:image/jpeg;base64,eA==';
        },
        decodeStoryboardDataImage() {
            return {
                bytes: Buffer.from('sheet'),
                width: sourceWidth,
                height: sourceHeight,
                extension: 'jpg',
                mediaType: 'image/jpeg',
            };
        },
        shortsTranscriptWriter: {
            CONTRACT_SCHEMA: 'shorts-opening-transcript-writer-v1',
        },
    });
    vm.runInContext(
        `${source.slice(start, end)}\nthis.render = generateFivePanelStoryboard; this.opening = generateCanonicalHookOpening;`,
        context
    );

    const result = await context.render({
        brief: 'test',
        hookText: 'test',
        panels: ['1', '2', '3', '4', '5'],
        stylePreset: 'animation',
        imageModel: 'gpt-image-2',
        strictImageModel: true,
        providerCallBudget: 1,
        references: ['data:image/jpeg;base64,eA=='],
        referenceDescriptions: ['Reference 1 applies globally'],
    });
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(splitCalls, 1);
    assert.strictEqual(result.frames.length, 5);
    assert.strictEqual(result.geometry.provider_call_count, 1);
    assert.strictEqual(result.geometry.render_call_count, 1);
    assert.strictEqual(result.stylePreset, 'animation');
    assert.deepStrictEqual(
        promptInput.referenceDescriptions,
        ['Reference 1 applies globally']
    );
    assert.strictEqual(providerInput.refs.length, 1);
    assert.strictEqual(providerInput.relation, 'compose');
    assert.strictEqual(providerInput.options.aspectRatio, 'storyboard-sheet');

    providerCalls = 0;
    splitCalls = 0;
    const opening = await context.opening({
        brief: 'test',
        videoIdea: 'test machine',
        hookTreatment: 'test its limits',
        transcript: 'This machine should never spill, so I pushed it.',
        panels: ['1', '2', '3', '4', '5'],
        stylePreset: 'animation',
        imageModel: 'gpt-image-2',
        strictImageModel: true,
        providerCallBudget: 1,
    });
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(splitCalls, 1);
    assert.strictEqual(
        opening.openingContract,
        'canonical-complete-hook-opening-v1'
    );
    assert.strictEqual(
        opening.transcript,
        'This machine should never spill, so I pushed it.'
    );
    assert.strictEqual(opening.stylePreset, 'animation');

    providerCalls = 0;
    splitCalls = 0;
    sourceWidth = 1024;
    sourceHeight = 1792;
    await assert.rejects(
        context.render({
            brief: 'test',
            panels: ['1', '2', '3', '4', '5'],
            stylePreset: 'default',
            imageModel: 'gpt-image-2',
            strictImageModel: true,
            providerCallBudget: 1,
        }),
        /single-frame image instead of the required wide five-panel sheet/
    );
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(
        splitCalls,
        0,
        'a one-frame provider result must never be split and accepted'
    );

    providerCalls = 0;
    splitCalls = 0;
    sourceWidth = 2880;
    sourceHeight = 1024;
    failProvider = true;
    await assert.rejects(
        context.render({
            brief: 'test',
            hookText: 'test',
            panels: ['1', '2', '3', '4', '5'],
            stylePreset: 'default',
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
