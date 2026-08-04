#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const modulePath = path.join(__dirname, '..', 'cloud-storage.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');

function loadCloudStorageWithMockR2() {
    let sendHandler = null;

    class MockCommand {
        constructor(input) {
            this.input = input;
        }
    }
    class MockGetObjectCommand extends MockCommand {}
    class MockListObjectsV2Command extends MockCommand {}
    class MockS3Client {
        async send(command, options) {
            if (!sendHandler) throw new Error('Mock R2 send handler is not configured');
            return sendHandler(command, options);
        }
    }
    class MockNodeHttpHandler {
        constructor(options) {
            this.options = options;
        }
    }

    const awsMock = {
        S3Client: MockS3Client,
        PutObjectCommand: MockCommand,
        GetObjectCommand: MockGetObjectCommand,
        HeadObjectCommand: MockCommand,
        DeleteObjectCommand: MockCommand,
        ListObjectsV2Command: MockListObjectsV2Command,
        CreateMultipartUploadCommand: MockCommand,
        UploadPartCommand: MockCommand,
        CompleteMultipartUploadCommand: MockCommand,
        AbortMultipartUploadCommand: MockCommand,
    };
    const localRequire = (request) => {
        if (request === '@aws-sdk/client-s3') return awsMock;
        if (request === '@aws-sdk/s3-request-presigner') {
            return { getSignedUrl: async () => 'https://example.invalid/signed' };
        }
        if (request === '@smithy/node-http-handler') {
            return { NodeHttpHandler: MockNodeHttpHandler };
        }
        return require(request);
    };

    const loadedModule = { exports: {} };
    const compile = new Function('require', 'module', 'exports', '__dirname', '__filename', moduleSource);
    compile(localRequire, loadedModule, loadedModule.exports, path.dirname(modulePath), modulePath);

    return {
        api: loadedModule.exports,
        MockGetObjectCommand,
        MockListObjectsV2Command,
        setSendHandler(handler) {
            sendHandler = handler;
        },
    };
}

async function findPartFiles(root) {
    const found = [];
    async function visit(directory) {
        const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch((error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(entryPath);
            else if (entry.name.includes('.part-')) found.push(entryPath);
        }
    }
    await visit(root);
    return found;
}

async function pathExists(filePath) {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

const tests = [];
function test(name, run) {
    tests.push({ name, run });
}

const originalEnv = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
};
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.R2_BUCKET_NAME = 'test-bucket';

const harness = loadCloudStorageWithMockR2();
const {
    downloadFromR2,
    downloadFromR2ToFile,
    listR2Keys,
    listR2Objects,
    R2_DOWNLOAD_ERROR_CODES,
    R2ObjectMissingError,
    R2StorageError,
    R2ObjectTooLargeError,
} = harness.api;
harness.api.initR2();

test('bounded buffered reads abort a body that stops making progress', async () => {
    let observedSignal = null;
    harness.setSendHandler(async (command, options) => {
        assert.ok(command instanceof harness.MockGetObjectCommand);
        observedSignal = options && options.abortSignal;
        return {
            Body: {
                [Symbol.asyncIterator]() {
                    return this;
                },
                next() {
                    return new Promise((resolve, reject) => {
                        observedSignal.addEventListener('abort', () => {
                            reject(Object.assign(
                                new Error('request aborted'),
                                { name: 'AbortError' }
                            ));
                        }, { once: true });
                    });
                },
                async return() {
                    return { done: true };
                },
            },
        };
    });

    await assert.rejects(
        downloadFromR2(
            'objects/stalled-buffered-read.bin',
            { timeoutMs: 20 }
        ),
        error => error && error.name === 'AbortError'
    );
    assert.ok(observedSignal);
    assert.equal(observedSignal.aborted, true);
    await assert.rejects(
        downloadFromR2('objects/invalid-timeout.bin', {
            timeoutMs: 0,
        }),
        RangeError
    );
});

test('bounded listings abort a request that stops making progress', async () => {
    for (const [operation, run] of [
        ['listR2Keys', () => listR2Keys('objects/', { timeoutMs: 20 })],
        ['listR2Objects', () => listR2Objects('objects/', { timeoutMs: 20 })],
    ]) {
        let observedSignal = null;
        harness.setSendHandler(async (command, options) => {
            assert.ok(command instanceof harness.MockListObjectsV2Command);
            observedSignal = options && options.abortSignal;
            return new Promise((resolve, reject) => {
                observedSignal.addEventListener('abort', () => {
                    reject(Object.assign(
                        new Error(`${operation} aborted`),
                        { name: 'AbortError' }
                    ));
                }, { once: true });
            });
        });

        await assert.rejects(run(), error => error && error.name === 'AbortError');
        assert.ok(observedSignal);
        assert.equal(observedSignal.aborted, true);
    }
    await assert.rejects(
        listR2Keys('objects/', { timeoutMs: 0 }),
        RangeError
    );
    await assert.rejects(
        listR2Objects('objects/', { timeoutMs: Number.MAX_SAFE_INTEGER + 1 }),
        RangeError
    );
});

test('listings preserve pagination and object metadata under a shared deadline', async () => {
    const requests = [];
    harness.setSendHandler(async (command, options) => {
        assert.ok(command instanceof harness.MockListObjectsV2Command);
        assert.ok(options.abortSignal);
        requests.push(command.input);
        if (!command.input.ContinuationToken) {
            return {
                IsTruncated: true,
                NextContinuationToken: 'page-2',
                Contents: [
                    {
                        Key: 'objects/a.bin',
                        Size: 2,
                        ETag: '"a"',
                        LastModified: new Date('2026-07-29T00:00:00.000Z'),
                    },
                ],
            };
        }
        return {
            IsTruncated: false,
            Contents: [
                {
                    Key: 'objects/b.bin',
                    Size: 3,
                    ETag: '"b"',
                    LastModified: new Date('2026-07-29T00:00:01.000Z'),
                },
            ],
        };
    });

    assert.deepEqual(
        await listR2Keys('objects/', { timeoutMs: 1000 }),
        ['objects/a.bin', 'objects/b.bin']
    );
    assert.deepEqual(requests, [
        {
            Bucket: 'test-bucket',
            Prefix: 'objects/',
            ContinuationToken: undefined,
        },
        {
            Bucket: 'test-bucket',
            Prefix: 'objects/',
            ContinuationToken: 'page-2',
        },
    ]);

    requests.length = 0;
    assert.deepEqual(
        await listR2Objects('objects/', { timeoutMs: 1000 }),
        [
            {
                key: 'objects/a.bin',
                size: 2,
                etag: '"a"',
                lastModified: Date.parse('2026-07-29T00:00:00.000Z'),
            },
            {
                key: 'objects/b.bin',
                size: 3,
                etag: '"b"',
                lastModified: Date.parse('2026-07-29T00:00:01.000Z'),
            },
        ]
    );
});

test('keeps the original R2 APIs and exports the additive streaming helper', () => {
    for (const exportName of [
        'downloadFromR2',
        'getR2Stream',
        'uploadToR2',
        'uploadFileToR2',
        'downloadFromR2ToFile',
    ]) {
        assert.equal(typeof harness.api[exportName], 'function', `${exportName} must remain exported`);
    }

    const helperStart = moduleSource.indexOf('async function downloadFromR2ToFile');
    const helperEnd = moduleSource.indexOf('// Like downloadFromR2', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, 'streaming helper source must be discoverable');
    assert.doesNotMatch(
        moduleSource.slice(helperStart, helperEnd),
        /Buffer\.concat/,
        'streaming helper must not concatenate the object in memory'
    );
});

test('streams multiple chunks to an exact file and reports metadata', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'r2-stream-success-'));
    const destination = path.join(root, 'nested', 'object.bin');
    try {
        harness.setSendHandler(async (command) => {
            assert.ok(command instanceof harness.MockGetObjectCommand);
            assert.deepEqual(command.input, { Bucket: 'test-bucket', Key: 'objects/success.bin' });
            return {
                ContentLength: 6,
                ETag: '"etag-1"',
                ContentType: 'application/octet-stream',
                Body: (async function* body() {
                    yield Buffer.from('ab');
                    yield Uint8Array.from(Buffer.from('cdef'));
                })(),
            };
        });

        const result = await downloadFromR2ToFile('objects/success.bin', destination, { maxBytes: 6 });
        assert.equal(await fs.promises.readFile(destination, 'utf8'), 'abcdef');
        assert.deepEqual(result, {
            key: 'objects/success.bin',
            path: destination,
            bytesWritten: 6,
            contentLength: 6,
            etag: '"etag-1"',
            contentType: 'application/octet-stream',
        });
        assert.deepEqual(await findPartFiles(root), []);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('exposes an exact missing-object error without creating output', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'r2-stream-missing-'));
    const destination = path.join(root, 'missing.bin');
    try {
        const missingCause = Object.assign(new Error('not found'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
        });
        harness.setSendHandler(async () => {
            throw missingCause;
        });

        await assert.rejects(
            downloadFromR2ToFile('objects/missing.bin', destination, { maxBytes: 10 }),
            (error) => {
                assert.ok(error instanceof R2ObjectMissingError);
                assert.equal(error.code, R2_DOWNLOAD_ERROR_CODES.MISSING);
                assert.equal(error.kind, 'missing');
                assert.equal(error.statusCode, 404);
                assert.equal(error.cause, missingCause);
                return true;
            }
        );
        assert.equal(await pathExists(destination), false);
        assert.deepEqual(await findPartFiles(root), []);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('exposes an exact storage error when the R2 request fails', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'r2-stream-storage-'));
    const destination = path.join(root, 'storage.bin');
    try {
        const storageCause = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        harness.setSendHandler(async () => {
            throw storageCause;
        });

        await assert.rejects(
            downloadFromR2ToFile('objects/storage.bin', destination, { maxBytes: 10 }),
            (error) => {
                assert.ok(error instanceof R2StorageError);
                assert.equal(error.code, R2_DOWNLOAD_ERROR_CODES.STORAGE);
                assert.equal(error.kind, 'storage');
                assert.equal(error.statusCode, 502);
                assert.equal(error.cause, storageCause);
                return true;
            }
        );
        assert.equal(await pathExists(destination), false);
        assert.deepEqual(await findPartFiles(root), []);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('rejects an advertised oversized object before opening a partial file', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'r2-stream-length-'));
    const destination = path.join(root, 'too-large.bin');
    let destroyed = false;
    try {
        harness.setSendHandler(async () => ({
            ContentLength: 11,
            Body: {
                destroy() {
                    destroyed = true;
                },
                async *[Symbol.asyncIterator]() {
                    yield Buffer.from('never-read');
                },
            },
        }));

        await assert.rejects(
            downloadFromR2ToFile('objects/too-large.bin', destination, { maxBytes: 10 }),
            (error) => {
                assert.ok(error instanceof R2ObjectTooLargeError);
                assert.equal(error.code, R2_DOWNLOAD_ERROR_CODES.TOO_LARGE);
                assert.equal(error.kind, 'too-large');
                assert.equal(error.statusCode, 413);
                assert.equal(error.maxBytes, 10);
                assert.equal(error.receivedBytes, 11);
                assert.equal(error.bytesWritten, 0);
                return true;
            }
        );
        assert.equal(destroyed, true, 'oversized response body should be cancelled');
        assert.equal(await pathExists(destination), false);
        assert.deepEqual(await findPartFiles(root), []);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('enforces the limit while streaming and preserves an existing destination', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'r2-stream-limit-'));
    const destination = path.join(root, 'existing.bin');
    let generatorClosed = false;
    await fs.promises.writeFile(destination, 'original');
    try {
        harness.setSendHandler(async () => ({
            Body: (async function* body() {
                try {
                    yield Buffer.from('1234');
                    yield Buffer.from('5678');
                } finally {
                    generatorClosed = true;
                }
            })(),
        }));

        await assert.rejects(
            downloadFromR2ToFile('objects/stream-too-large.bin', destination, { maxBytes: 6 }),
            (error) => {
                assert.ok(error instanceof R2ObjectTooLargeError);
                assert.equal(error.code, R2_DOWNLOAD_ERROR_CODES.TOO_LARGE);
                assert.equal(error.maxBytes, 6);
                assert.equal(error.receivedBytes, 8);
                assert.equal(error.bytesWritten, 4);
                return true;
            }
        );
        assert.equal(generatorClosed, true, 'source iterator should be closed after overflow');
        assert.equal(await fs.promises.readFile(destination, 'utf8'), 'original');
        assert.deepEqual(await findPartFiles(root), []);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('turns a body-stream failure into storage error and removes partial output', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'r2-stream-body-error-'));
    const destination = path.join(root, 'partial.bin');
    const streamCause = new Error('upstream body failed');
    try {
        harness.setSendHandler(async () => ({
            Body: (async function* body() {
                yield Buffer.from('partial');
                throw streamCause;
            })(),
        }));

        await assert.rejects(
            downloadFromR2ToFile('objects/body-error.bin', destination, { maxBytes: 100 }),
            (error) => {
                assert.ok(error instanceof R2StorageError);
                assert.equal(error.code, R2_DOWNLOAD_ERROR_CODES.STORAGE);
                assert.equal(error.kind, 'storage');
                assert.equal(error.cause, streamCause);
                return true;
            }
        );
        assert.equal(await pathExists(destination), false);
        assert.deepEqual(await findPartFiles(root), []);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

(async () => {
    let failed = 0;
    for (const { name, run } of tests) {
        try {
            await run();
            console.log(`ok - ${name}`);
        } catch (error) {
            failed += 1;
            console.error(`not ok - ${name}`);
            console.error(error && error.stack ? error.stack : error);
        }
    }

    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }

    if (failed) {
        console.error(`${failed} test(s) failed`);
        process.exitCode = 1;
    } else {
        console.log(`${tests.length} tests passed`);
    }
})();
