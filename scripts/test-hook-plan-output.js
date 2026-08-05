'use strict';

const assert = require('assert');
const {
    parseHookPlans,
    outputShape,
} = require('../buildings/jarvis/hook-plan-output');

const frames = Array.from(
    { length: 5 },
    (_, index) => `Frame ${index + 1}: visual beat ${index + 1}`
);
const expected = {
    premise: 'A spill-proof machine reveals its real purpose',
    frames,
    cohesion_mode: 'continuous',
    reasoning: 'Escalating reveal',
};

assert.deepStrictEqual(parseHookPlans({ attempts: [expected] }), [expected]);
assert.deepStrictEqual(
    parseHookPlans(JSON.stringify({ attempts: [expected] })),
    [expected]
);
assert.deepStrictEqual(
    parseHookPlans(`\n\`\`\`json\n${JSON.stringify({ attempts: [expected] })}\n\`\`\``),
    [expected]
);
assert.deepStrictEqual(
    parseHookPlans([JSON.stringify({ attempts: [expected] })]),
    [expected]
);
const streamed = JSON.stringify({ attempts: [expected] });
const streamSize = Math.ceil(streamed.length / 5);
assert.deepStrictEqual(
    parseHookPlans(Array.from(
        { length: 5 },
        (_, index) => streamed.slice(
            index * streamSize,
            (index + 1) * streamSize
        )
    )),
    [expected],
    'five streamed JSON fragments must never be mistaken for five frames'
);
assert.deepStrictEqual(
    parseHookPlans({ output: { result: { hooks: [expected] } } }),
    [expected]
);
const fivePlans = Array.from({ length: 5 }, (_, index) => ({
    premise: `Hook treatment ${index + 1}`,
    frames: frames.map(frame => `${frame} treatment ${index + 1}`),
}));
assert.strictEqual(
    parseHookPlans({ attempts: fivePlans }, { limit: 5 }).length,
    5,
    'an array of five plans must never be mistaken for one five-frame plan'
);
assert.deepStrictEqual(
    parseHookPlans({
        hook_text: expected.premise,
        panels: frames.map(prompt => ({ prompt })),
        cohesionMode: 'continuous',
        rationale: 'Escalating reveal',
    }),
    [expected]
);
assert.deepStrictEqual(
    parseHookPlans(Object.fromEntries([
        ['premise', expected.premise],
        ...frames.map((frame, index) => [`frame_${index + 1}`, frame]),
    ]))[0].frames,
    frames
);
assert.deepStrictEqual(
    parseHookPlans(frames, { fallbackPremise: expected.premise })[0],
    {
        premise: expected.premise,
        frames,
        cohesion_mode: '',
        reasoning: '',
    }
);

assert.throws(
    () => parseHookPlans({ attempts: [] }),
    error => (
        error.code === 'HOOK_PLAN_OUTPUT_INVALID'
        && /output shape: object\(attempts\)/.test(error.message)
    )
);
assert.strictEqual(outputShape(['fragment']), 'array(1)>string(8)');

console.log('hook plan output parser tests passed');
