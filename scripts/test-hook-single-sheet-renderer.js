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
        3,
        'only the raw Score and planned Auto/Grind boundaries may call the low-level renderer'
    );
    assert.strictEqual(
        (source.match(/generateCanonicalHookOpening\(/g) || []).length,
        3,
        'Auto and Grind must share one planned complete-opening method'
    );
    const scoreRouteStart = source.indexOf(
        "pathname === '/api/storyboards/generate'"
    );
    const scoreRouteEnd = source.indexOf(
        "pathname === '/api/storyboards/panel'",
        scoreRouteStart
    );
    const scoreRoute = source.slice(scoreRouteStart, scoreRouteEnd);
    assert(scoreRoute.includes('generateRawScoreStoryboardOpening({'));
    assert(!scoreRoute.includes('generateCanonicalHookOpening({'));
    assert(!scoreRoute.includes('generateShortsOpeningTranscript('));
    assert(!source.includes('renderHookPanelRobust'));
    const autoStart = source.indexOf('async function hookProcessRequest');
    const autoEnd = source.indexOf(
        'async function hookSweepOrphans',
        autoStart
    );
    const grindStart = source.indexOf('async function grindProcess');
    const grindEnd = source.indexOf('let _grindBusy', grindStart);
    const wholeHookWorkers = [
        source.slice(autoStart, autoEnd),
        source.slice(grindStart, grindEnd),
    ];
    wholeHookWorkers.forEach(workerSource => {
        assert(workerSource.includes('generateCanonicalHookOpening({'));
        assert(!workerSource.includes('genStoryFrame('));
        assert(!workerSource.includes('replicateRun('));
        assert(!workerSource.includes('openAIImageProvider.generateImage('));
    });
    const legacyFrameStart = source.indexOf(
        "if (pathname === '/api/frames/gen'"
    );
    const legacyFrameEnd = source.indexOf(
        'const demoStat = pathname.match',
        legacyFrameStart
    );
    assert(
        !source.slice(legacyFrameStart, legacyFrameEnd)
            .includes('genStoryFrame('),
        'the unscoped legacy vertical generator must stay retired'
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
    let promptInput = null;
    let providerInput = null;
    let transcriptLlmCalls = 0;
    let sourceWidth = 2880;
    let sourceHeight = 1024;
    const context = vm.createContext({
        Buffer,
        process: { env: {} },
        RAW_PY_ENV: {},
        setTimeout,
        CANONICAL_HOOK_SHEET_PROVIDER_CALL_BUDGET: 1,
        CANONICAL_HOOK_SHEET_ASPECT_RATIO: 45 / 16,
        CANONICAL_HOOK_SHEET_RATIO_TOLERANCE: 0.02,
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
            'nano-banana': {
                slug: 'nano-banana',
                provider: 'replicate',
            },
        },
        STORY_SHEET_MODEL_KEYS: new Set([
            'gpt-image-2',
            'flux-2-pro',
            'seedream-4',
        ]),
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
        async generateShortsOpeningTranscript() {
            transcriptLlmCalls += 1;
            throw new Error('raw Score must never call the transcript LLM');
        },
    });
    vm.runInContext(
        `${source.slice(start, end)}\nthis.render = generateFivePanelStoryboard; this.rawScore = generateRawScoreStoryboardOpening; this.opening = generateCanonicalHookOpening;`,
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
    promptInput = null;
    const rawScore = await context.rawScore({
        brief: 'Keep every word of this exact scene.',
        transcript: 'Keep this exact spoken line.',
        panels: ['Exact panel 1', '2', '3', '4', '5'],
        stylePreset: 'default',
        imageModel: 'gpt-image-2',
        strictImageModel: true,
        providerCallBudget: 1,
    });
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(splitCalls, 1);
    assert.strictEqual(transcriptLlmCalls, 0);
    assert.strictEqual(
        promptInput.brief,
        'Keep every word of this exact scene.'
    );
    assert.strictEqual(
        promptInput.hookText,
        'Keep this exact spoken line.'
    );
    assert.strictEqual(promptInput.panels[0], 'Exact panel 1');
    assert.strictEqual(rawScore.transcript, 'Keep this exact spoken line.');
    assert.strictEqual(rawScore.transcriptProvenance.provider, 'user');
    assert.strictEqual(rawScore.transcriptProvenance.provider_call_count, 0);
    assert.strictEqual(rawScore.planningProviderCallCount, 0);
    assert.strictEqual(
        rawScore.generationIntent,
        'score-raw-user-input-v1'
    );

    providerCalls = 0;
    splitCalls = 0;
    await assert.rejects(
        context.render({
            brief: 'test',
            panels: ['1', '2', '3', '4', '5'],
            stylePreset: 'default',
            imageModel: 'nano-banana',
            providerCallBudget: 1,
        }),
        /cannot return an exact 45:16 five-panel sheet/
    );
    assert.strictEqual(providerCalls, 0);
    assert.strictEqual(splitCalls, 0);

    providerCalls = 0;
    splitCalls = 0;
    await assert.rejects(
        context.render({
            brief: 'test',
            panels: ['1', '2', '3', '4', '5'],
            stylePreset: 'default',
            imageModel: 'gpt-image-2',
            strictImageModel: false,
            providerCallBudget: 5,
        }),
        /requires exactly one image-provider call/
    );
    assert.strictEqual(
        providerCalls,
        0,
        'an expanded provider-call budget must fail before image spend'
    );
    assert.strictEqual(splitCalls, 0);

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
        /single-frame image instead of the required 45:16 five-panel sheet/
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

    const rendererStart = source.indexOf(
        'async function generateFivePanelStoryboard'
    );
    const rendererEnd = source.indexOf(
        'function shortsTranscriptProviderError',
        rendererStart
    );
    const rendererSource = source.slice(rendererStart, rendererEnd);
    assert.strictEqual(
        (rendererSource.match(/await genStoryFrame\(/g) || []).length,
        1,
        'the complete-hook renderer must contain one provider call site'
    );
    assert(!rendererSource.includes('const ladder ='));

    console.log('hook single-sheet renderer contract: ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
