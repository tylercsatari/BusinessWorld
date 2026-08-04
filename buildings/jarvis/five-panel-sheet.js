'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PANEL_COUNT = 5;
const SHEET_WIDTH = 1440;
const SHEET_HEIGHT = 512;
const PANEL_SOURCE_WIDTH = SHEET_WIDTH / PANEL_COUNT;
const SCORE_FRAME_WIDTH = 320;
const SCORE_FRAME_HEIGHT = 568;
const SCORE_MONTAGE_WIDTH = SCORE_FRAME_WIDTH * PANEL_COUNT;

function normalizePanels(panels, fallback) {
    const values = Array.isArray(panels) ? panels.slice(0, PANEL_COUNT) : [];
    while (values.length < PANEL_COUNT) values.push('');
    return values.map((value, index) => (
        String(value || '').trim()
        || `Continue beat ${index + 1} of: ${fallback || 'a compelling visual opening'}`
    ));
}

function buildPrompt({
    brief,
    hookText,
    panels,
    styleContract = '',
    referenceDescriptions = [],
}) {
    const opening = String(brief || hookText || 'A compelling visual opening.').trim();
    const normalizedPanels = normalizePanels(panels, opening);
    const panelLines = normalizedPanels.map((prompt, index) => (
        `PANEL ${index + 1}: ${prompt}`
    ));
    return [
        `Create ONE single edge-to-edge ${
            styleContract ? 'stylized 3D animated' : 'photographic'
        } storyboard sheet on a 45:16 canvas. This is one image, not five image outputs.`,
        'Divide the canvas into EXACTLY FIVE contiguous equal-width columns: '
            + 'panel 1 occupies 0-20%, panel 2 20-40%, panel 3 40-60%, '
            + 'panel 4 60-80%, and panel 5 80-100% of the canvas width.',
        'Every column is a complete vertical 9:16 image. Arrange the five '
            + 'columns left to right in chronological order with no gutter, '
            + 'overlap, inset, or unequal spacing.',
        'Maintain the exact same people, faces, wardrobe, objects, location, '
            + 'lighting logic, and visual style whenever they recur.',
        'Keep every subject inside its own column. Never let one composition '
            + 'span, merge, or bleed across a panel boundary.',
        'Do not add captions, words, letters, numbers, watermarks, borders, '
            + 'gaps, frames, contact-sheet labels, or UI.',
        styleContract,
        `OVERALL OPENING: ${opening}`,
        hookText ? `SPOKEN CONTEXT: ${hookText}` : '',
        referenceDescriptions.length
            ? 'REFERENCE SCOPE (obey this panel mapping exactly):'
            : '',
        ...referenceDescriptions,
        ...panelLines,
    ].filter(Boolean).join('\n');
}

function runFfmpeg(args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args, { env });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk;
            if (stderr.length > 4000) stderr = stderr.slice(-4000);
        });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            reject(new Error('five-panel split timed out'));
        }, 60000);
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`five-panel split failed (${code}): ${stderr.trim().slice(-500)}`));
        });
    });
}

async function splitImage(bytes, options = {}) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) {
        throw new Error('five-panel source image is empty');
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'five-panel-'));
    try {
        const input = path.join(dir, 'source.img');
        fs.writeFileSync(input, bytes);
        const framePaths = Array.from(
            { length: PANEL_COUNT },
            (_, index) => path.join(dir, `frame-${index}.jpg`)
        );
        const montagePath = path.join(dir, 'montage.jpg');
        const splitLabels = Array.from(
            { length: PANEL_COUNT },
            (_, index) => `[crop${index}]`
        ).join('');
        const filters = [
            `[0:v]scale=${SHEET_WIDTH}:${SHEET_HEIGHT}:force_original_aspect_ratio=increase,crop=${SHEET_WIDTH}:${SHEET_HEIGHT},setsar=1,split=${PANEL_COUNT}${splitLabels}`,
        ];
        for (let index = 0; index < PANEL_COUNT; index++) {
            filters.push(
                `[crop${index}]crop=${PANEL_SOURCE_WIDTH}:${SHEET_HEIGHT}:${index * PANEL_SOURCE_WIDTH}:0,scale=${SCORE_FRAME_WIDTH}:${SCORE_FRAME_HEIGHT},setsar=1,split=2[frame${index}][montage${index}]`
            );
        }
        filters.push(
            `${Array.from({ length: PANEL_COUNT }, (_, index) => `[montage${index}]`).join('')}hstack=inputs=${PANEL_COUNT}[sheet]`
        );
        const args = [
            '-nostdin',
            '-loglevel', 'error',
            '-i', input,
            '-filter_complex', filters.join(';'),
        ];
        framePaths.forEach((framePath, index) => {
            args.push('-map', `[frame${index}]`, '-frames:v', '1', '-q:v', '4', framePath);
        });
        args.push('-map', '[sheet]', '-frames:v', '1', '-q:v', '4', montagePath);
        await runFfmpeg(args, options.env || process.env);
        const frames = framePaths.map(framePath => fs.readFileSync(framePath));
        const montage = fs.readFileSync(montagePath);
        return {
            frames,
            montage,
            geometry: {
                render_call_count: 1,
                source_width: SHEET_WIDTH,
                source_height: SHEET_HEIGHT,
                source_aspect_ratio: '45:16',
                panel_count: PANEL_COUNT,
                panel_source_width: PANEL_SOURCE_WIDTH,
                panel_source_height: SHEET_HEIGHT,
                panel_aspect_ratio: '9:16',
                score_frame_width: SCORE_FRAME_WIDTH,
                score_frame_height: SCORE_FRAME_HEIGHT,
                score_montage_width: SCORE_MONTAGE_WIDTH,
                score_montage_height: SCORE_FRAME_HEIGHT,
                split: 'five deterministic equal-width crops',
            },
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = Object.freeze({
    PANEL_COUNT,
    SHEET_WIDTH,
    SHEET_HEIGHT,
    PANEL_SOURCE_WIDTH,
    SCORE_FRAME_WIDTH,
    SCORE_FRAME_HEIGHT,
    SCORE_MONTAGE_WIDTH,
    normalizePanels,
    buildPrompt,
    splitImage,
});
