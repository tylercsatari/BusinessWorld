#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    OPENAI_IMAGE_MODEL,
    OUTPUT_SIZES,
    generateImage,
    outputSize,
    requestFor,
} = require('../buildings/jarvis/openai-image-provider');

function response(status, payload, requestId = 'req_fixture') {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return String(name).toLowerCase() === 'x-request-id'
                    ? requestId
                    : null;
            },
        },
        async json() {
            return payload;
        },
    };
}

async function main() {
    assert.strictEqual(OPENAI_IMAGE_MODEL, 'gpt-image-2');
    assert.deepStrictEqual(outputSize('storyboard-sheet'), {
        width: 2880,
        height: 1024,
        value: '2880x1024',
    });
    assert.deepStrictEqual(outputSize('9:16'), {
        width: 1152,
        height: 2048,
        value: '1152x2048',
    });
    Object.values(OUTPUT_SIZES).forEach(size => {
        assert.strictEqual(size.width % 16, 0);
        assert.strictEqual(size.height % 16, 0);
        assert(size.width * size.height >= 655360);
        assert(Math.max(size.width, size.height) <= 3840);
        assert(
            Math.max(size.width, size.height)
                / Math.min(size.width, size.height) <= 3
        );
    });

    const generatedRequest = requestFor({
        apiKey: 'fixture-key',
        model: OPENAI_IMAGE_MODEL,
        prompt: 'Five connected frames.',
        refs: [],
        aspectRatio: 'storyboard-sheet',
    });
    assert(generatedRequest.url.endsWith('/images/generations'));
    assert.strictEqual(
        generatedRequest.init.headers.Authorization,
        'Bearer fixture-key'
    );
    assert.deepStrictEqual(
        JSON.parse(generatedRequest.init.body),
        {
            model: 'gpt-image-2',
            prompt: 'Five connected frames.',
            size: '2880x1024',
            quality: 'medium',
            output_format: 'jpeg',
            output_compression: 90,
            moderation: 'auto',
            n: 1,
        }
    );

    const reference = 'data:image/png;base64,'
        + Buffer.from('fixture-image').toString('base64');
    const editRequest = requestFor({
        apiKey: 'fixture-key',
        prompt: 'Preserve the object and change the background.',
        refs: [reference, reference],
        aspectRatio: '9:16',
    });
    assert(editRequest.url.endsWith('/images/edits'));
    assert.strictEqual(editRequest.init.body.get('model'), 'gpt-image-2');
    assert.strictEqual(editRequest.init.body.get('size'), '1152x2048');
    assert.strictEqual(editRequest.init.body.get('quality'), 'medium');
    assert.strictEqual(editRequest.init.body.getAll('image[]').length, 2);
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            editRequest.init.headers,
            'Content-Type'
        ),
        false,
        'fetch must set the multipart boundary'
    );

    const providerCalls = [];
    const result = await generateImage({
        apiKey: 'fixture-key',
        prompt: 'Create a coherent storyboard.',
        refs: [],
        aspectRatio: 'storyboard-sheet',
        fetchWithTimeout: async (url, init, timeoutMs) => {
            providerCalls.push({ url, init, timeoutMs });
            return response(200, {
                data: [{
                    b64_json: Buffer.from('fixture-output')
                        .toString('base64'),
                }],
            });
        },
    });
    assert.strictEqual(providerCalls.length, 1);
    assert.strictEqual(providerCalls[0].timeoutMs, 180000);
    assert.strictEqual(result.provider, 'openai');
    assert.strictEqual(result.model, 'gpt-image-2');
    assert.strictEqual(result.endpoint, 'generations');
    assert(result.dataUrl.startsWith('data:image/jpeg;base64,'));

    await assert.rejects(
        () => generateImage({
            apiKey: '',
            prompt: 'Anything',
        }),
        error => (
            error.statusCode === 503
            && error.code === 'openai_image_key_missing'
        )
    );
    await assert.rejects(
        () => generateImage({
            apiKey: 'fixture-key',
            prompt: 'Anything',
            fetchWithTimeout: async () => response(429, {
                error: {
                    code: 'insufficient_quota',
                    message: 'Provider detail that should be normalized.',
                },
            }),
        }),
        error => (
            error.statusCode === 402
            && error.code === 'openai_image_out_of_credits'
            && /out of credits/i.test(error.message)
        )
    );

    console.log(JSON.stringify({
        ok: true,
        model: OPENAI_IMAGE_MODEL,
        generationSize: OUTPUT_SIZES['storyboard-sheet'].value,
        editSize: OUTPUT_SIZES['9:16'].value,
        referenceEditing: true,
        normalizedProviderErrors: true,
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
