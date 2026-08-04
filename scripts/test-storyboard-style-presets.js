#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    ANIMATION_STYLE_ID,
    DEFAULT_STYLE_ID,
    PRESETS,
    normalizeStylePreset,
    stylePreset,
} = require('../buildings/jarvis/storyboard-style-presets');

const animation = stylePreset(ANIMATION_STYLE_ID);
const contract = animation.promptContract;

assert.strictEqual(normalizeStylePreset(), DEFAULT_STYLE_ID);
assert.strictEqual(normalizeStylePreset('unknown'), DEFAULT_STYLE_ID);
assert.strictEqual(PRESETS[DEFAULT_STYLE_ID].promptContract, '');
assert.strictEqual(animation.id, ANIMATION_STYLE_ID);
assert(
    contract.length > 4000,
    'the animation preset must operationalize the style in sufficient detail'
);
[
    'RECURRING HUMAN CHARACTER BIBLE',
    'OBJECT BIBLE',
    'WORLD BIBLE',
    'LIGHT AND COLOR',
    'CAMERA AND COMPOSITION',
    'MOTION LANGUAGE',
    'FIVE-FRAME CONTINUITY LOCK',
    'EXCLUSIONS',
].forEach(section => {
    assert(contract.includes(section), `missing style section: ${section}`);
});
[
    'Strength Arm',
    'Giga Blaster',
    '.jpeg',
    'balloons',
    'silver sedan',
].forEach(exampleContent => {
    assert(
        !contract.toLowerCase().includes(exampleContent.toLowerCase()),
        `the style preset leaked example subject matter: ${exampleContent}`
    );
});

console.log(JSON.stringify({
    ok: true,
    stylePreset: animation.id,
    promptCharacters: contract.length,
    textOnly: true,
}, null, 2));
