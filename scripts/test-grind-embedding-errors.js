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
    const start = source.indexOf('async function geminiTextEmbed');
    const end = source.indexOf('const genVecEnc', start);
    assert(start >= 0 && end > start);
    let response = null;
    const context = vm.createContext({
        process: { env: {} },
        GENMEM_DIM: 768,
        async fetchT() {
            return response;
        },
    });
    vm.runInContext(
        `${source.slice(start, end)}\nthis.embed = geminiTextEmbed;`,
        context
    );

    await assert.rejects(
        context.embed('topic', {
            required: true,
            context: 'the immutable Grind video idea',
        }),
        /GEMINI_API_KEY/
    );
    assert.strictEqual(await context.embed('topic'), null);

    context.process.env.GEMINI_API_KEY = 'test';
    response = {
        ok: false,
        status: 429,
        async json() {
            return {
                error: {
                    status: 'RESOURCE_EXHAUSTED',
                    message: 'quota exhausted',
                },
            };
        },
    };
    await assert.rejects(
        context.embed('candidate', {
            required: true,
            context: 'a Grind candidate concept',
        }),
        /HTTP 429.*quota exhausted/
    );
    assert.strictEqual(await context.embed('candidate'), null);

    response = {
        ok: true,
        status: 200,
        async json() {
            return { embedding: { values: [3, 4, 0, 0, 0, 0, 0, 0] } };
        },
    };
    const embedding = await context.embed('candidate', {
        required: true,
        context: 'a Grind candidate concept',
    });
    assert.strictEqual(embedding.length, 8);
    assert(Math.abs(embedding[0] - 0.6) < 1e-12);
    assert(Math.abs(embedding[1] - 0.8) < 1e-12);

    console.log('grind embedding failure contract: ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
