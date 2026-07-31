#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
    createR2SmallObjectStore,
    DEFAULT_R2_SMALL_OBJECT_MAX_BYTES,
    R2_CONDITIONAL_ERROR_CODES,
    R2PreconditionFailedError,
    R2StorageError,
    R2ObjectMissingError,
    R2ObjectTooLargeError,
    isR2PreconditionFailedError,
} = require('../cloud-storage');

const tests = [];
function test(name, run) {
    tests.push({ name, run });
}

function bodyFrom(chunks) {
    return (async function* stream() {
        for (const chunk of chunks) yield Buffer.from(chunk);
    })();
}

test('If-None-Match create sends a bounded conditional PutObject and returns its ETag', async () => {
    let seen = null;
    const store = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: {
            async send(command) {
                seen = command;
                return { ETag: '"created-etag"', VersionId: 'v1' };
            },
        },
        maxBytes: 1024,
    });

    const result = await store.put('leases/a.json', '{"ok":true}', {
        ifNoneMatch: '*',
        contentType: 'application/json',
        metadata: { owner: 'worker-a', schema: 'lease-v1' },
    });

    assert.equal(seen.constructor.name, 'PutObjectCommand');
    assert.deepEqual(seen.input, {
        Bucket: 'test-bucket',
        Key: 'leases/a.json',
        Body: Buffer.from('{"ok":true}'),
        ContentLength: 11,
        ContentType: 'application/json',
        Metadata: { owner: 'worker-a', schema: 'lease-v1' },
        IfNoneMatch: '*',
    });
    assert.deepEqual(result, {
        key: 'leases/a.json',
        etag: '"created-etag"',
        versionId: 'v1',
    });
});

test('If-Match update sends the exact quoted ETag and never also sends If-None-Match', async () => {
    let seen = null;
    const store = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: {
            async send(command) {
                seen = command;
                return { ETag: '"next-etag"' };
            },
        },
    });

    await store.put('leases/a.json', Buffer.from('next'), {
        ifMatch: '"prior-etag"',
    });

    assert.equal(seen.input.IfMatch, '"prior-etag"');
    assert.equal(Object.hasOwn(seen.input, 'IfNoneMatch'), false);
});

test('maps every raw 412 form to one stable precondition-failed error', async () => {
    for (const cause of [
        Object.assign(new Error('condition failed'), { name: 'PreconditionFailed' }),
        Object.assign(new Error('condition failed'), { Code: 'PreconditionFailed' }),
        Object.assign(new Error('condition failed'), { $metadata: { httpStatusCode: 412 } }),
        Object.assign(new Error('conditional race'), {
            name: 'ConditionalRequestConflict',
            $metadata: { httpStatusCode: 409 },
        }),
    ]) {
        const store = createR2SmallObjectStore({
            bucketName: 'test-bucket',
            client: { async send() { throw cause; } },
        });
        await assert.rejects(
            store.put('leases/a.json', 'body', { ifNoneMatch: '*' }),
            (error) => {
                assert.ok(error instanceof R2PreconditionFailedError);
                assert.equal(error.code, R2_CONDITIONAL_ERROR_CODES.PRECONDITION_FAILED);
                assert.equal(error.statusCode, 412);
                assert.equal(error.kind, 'precondition-failed');
                assert.equal(error.cause, cause);
                assert.equal(isR2PreconditionFailedError(error), true);
                return true;
            }
        );
    }
});

test('get returns the bounded body and immutable compare-and-swap metadata', async () => {
    let seen = null;
    const store = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: {
            async send(command) {
                seen = command;
                return {
                    Body: bodyFrom(['abc', 'def']),
                    ContentLength: 6,
                    ContentType: 'application/json',
                    ETag: '"read-etag"',
                    Metadata: { state: 'active' },
                    LastModified: new Date('2026-07-30T12:00:00.000Z'),
                    VersionId: 'v2',
                };
            },
        },
        maxBytes: 16,
    });

    const result = await store.get('leases/a.json', {
        ifMatch: '"read-etag"',
        maxBytes: 8,
    });

    assert.equal(seen.constructor.name, 'GetObjectCommand');
    assert.deepEqual(seen.input, {
        Bucket: 'test-bucket',
        Key: 'leases/a.json',
        IfMatch: '"read-etag"',
    });
    assert.equal(result.body.toString('utf8'), 'abcdef');
    assert.equal(result.etag, '"read-etag"');
    assert.equal(result.contentLength, 6);
    assert.equal(result.contentType, 'application/json');
    assert.deepEqual(result.metadata, { state: 'active' });
    assert.equal(result.lastModified, '2026-07-30T12:00:00.000Z');
    assert.equal(result.versionId, 'v2');
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.metadata), true);
});

test('missing and storage errors remain distinguishable and fail closed', async () => {
    const missing = Object.assign(new Error('missing'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
    });
    const missingStore = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: { async send() { throw missing; } },
    });
    await assert.rejects(
        missingStore.get('leases/missing.json'),
        (error) => error instanceof R2ObjectMissingError && error.statusCode === 404
    );

    const outage = Object.assign(new Error('network down'), { code: 'ECONNRESET' });
    const outageStore = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: { async send() { throw outage; } },
    });
    await assert.rejects(
        outageStore.get('leases/a.json'),
        (error) => {
            assert.ok(error instanceof R2StorageError);
            assert.equal(error.cause, outage);
            assert.notEqual(error.statusCode, 404);
            assert.equal(isR2PreconditionFailedError(error), false);
            return true;
        }
    );
});

test('small-object reads and writes cannot escape their hard memory bound', async () => {
    const readStore = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: {
            async send() {
                return {
                    Body: bodyFrom(['12345', '67890']),
                    ETag: '"oversized"',
                };
            },
        },
        maxBytes: 8,
    });
    await assert.rejects(
        readStore.get('leases/a.json'),
        (error) => error instanceof R2ObjectTooLargeError && error.receivedBytes === 10
    );

    let sends = 0;
    const writeStore = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: { async send() { sends += 1; } },
        maxBytes: 4,
    });
    await assert.rejects(
        writeStore.put('leases/a.json', '12345', { ifNoneMatch: '*' }),
        (error) => error instanceof R2ObjectTooLargeError
    );
    assert.equal(sends, 0, 'oversized writes must fail before reaching R2');

    assert.throws(
        () => createR2SmallObjectStore({
            bucketName: 'test-bucket',
            client: { async send() {} },
            maxBytes: DEFAULT_R2_SMALL_OBJECT_MAX_BYTES + 1,
        }),
        RangeError
    );
});

test('rejects a truncated body whose bytes disagree with R2 Content-Length', async () => {
    const store = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: {
            async send() {
                return {
                    Body: bodyFrom(['abc']),
                    ContentLength: 6,
                    ETag: '"truncated"',
                };
            },
        },
    });
    await assert.rejects(
        store.get('leases/truncated.json'),
        (error) => error instanceof R2StorageError
            && /Content-Length/.test(error.message)
    );
});

test('rejects ambiguous or non-CAS conditional requests before I/O', async () => {
    let sends = 0;
    const store = createR2SmallObjectStore({
        bucketName: 'test-bucket',
        client: { async send() { sends += 1; } },
    });

    await assert.rejects(store.put('leases/a.json', 'body'), TypeError);
    await assert.rejects(
        store.put('leases/a.json', 'body', {
            ifMatch: '"etag"',
            ifNoneMatch: '*',
        }),
        TypeError
    );
    await assert.rejects(
        store.put('leases/a.json', 'body', { ifNoneMatch: '"etag"' }),
        TypeError
    );
    await assert.rejects(
        store.get('leases/a.json', { ifMatch: '*' }),
        TypeError
    );
    assert.equal(sends, 0);
});

(async () => {
    let passed = 0;
    for (const entry of tests) {
        try {
            await entry.run();
            passed += 1;
            console.log(`ok ${passed} - ${entry.name}`);
        } catch (error) {
            console.error(`not ok ${passed + 1} - ${entry.name}`);
            console.error(error);
            process.exitCode = 1;
            return;
        }
    }
    console.log(`1..${passed}`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
