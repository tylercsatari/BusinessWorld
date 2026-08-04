#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fivePanelSheet = require(
    '../buildings/jarvis/five-panel-sheet'
);

function imageDimensions(bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-probe-'));
    try {
        const file = path.join(dir, 'image.jpg');
        fs.writeFileSync(file, bytes);
        const result = childProcess.execFileSync(
            'ffprobe',
            [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height',
                '-of', 'csv=s=x:p=0',
                file,
            ],
            { encoding: 'utf8' }
        ).trim();
        return result.split('x').map(Number);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function main() {
    assert.strictEqual(fivePanelSheet.PANEL_COUNT, 5);
    assert.strictEqual(
        fivePanelSheet.SHEET_WIDTH / fivePanelSheet.SHEET_HEIGHT,
        45 / 16
    );
    assert.strictEqual(
        fivePanelSheet.PANEL_SOURCE_WIDTH
            / fivePanelSheet.SHEET_HEIGHT,
        9 / 16
    );

    const prompt = fivePanelSheet.buildPrompt({
        brief: 'A machine passes through five consecutive tests.',
        hookText: 'Can this machine survive every test?',
        panels: ['one', 'two', 'three', 'four', 'five'],
        styleContract: 'ANIMATION CONTRACT',
    });
    assert(prompt.includes('ONE single edge-to-edge stylized 3D animated'));
    assert(prompt.includes('panel 1 occupies 0-20%'));
    assert(prompt.includes('panel 5 80-100%'));
    assert.strictEqual((prompt.match(/^PANEL \d:/gm) || []).length, 5);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-source-'));
    let source;
    try {
        const file = path.join(dir, 'source.png');
        childProcess.execFileSync('ffmpeg', [
            '-nostdin',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', 'color=c=red:s=288x512:d=1',
            '-f', 'lavfi',
            '-i', 'color=c=green:s=288x512:d=1',
            '-f', 'lavfi',
            '-i', 'color=c=blue:s=288x512:d=1',
            '-f', 'lavfi',
            '-i', 'color=c=yellow:s=288x512:d=1',
            '-f', 'lavfi',
            '-i', 'color=c=magenta:s=288x512:d=1',
            '-filter_complex', '[0:v][1:v][2:v][3:v][4:v]hstack=inputs=5',
            '-frames:v', '1',
            file,
        ]);
        source = fs.readFileSync(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const result = await fivePanelSheet.splitImage(source);
    assert.strictEqual(result.frames.length, 5);
    for (const frame of result.frames) {
        assert.deepStrictEqual(imageDimensions(frame), [320, 568]);
    }
    assert.deepStrictEqual(
        imageDimensions(result.montage),
        [1600, 568]
    );
    assert.strictEqual(result.geometry.render_call_count, 1);
    assert.strictEqual(
        result.geometry.split,
        'five deterministic equal-width crops'
    );
    console.log('five-panel sheet contract: ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
