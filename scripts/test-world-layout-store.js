#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    WorldLayoutConflictError,
    createWorldLayoutStore,
} = require('../world-layout-store');

class MissingObjectError extends Error {}
class PreconditionError extends Error {}

function memoryStorage(seed) {
    let body = seed ? Buffer.from(JSON.stringify(seed)) : null;
    let version = body ? 1 : 0;
    let writes = 0;
    return {
        async get(key, options = {}) {
            if (!body) throw new MissingObjectError(key);
            const etag = `"${version}"`;
            if (options.ifMatch && options.ifMatch !== etag) {
                throw new PreconditionError(key);
            }
            return { key, etag, body: Buffer.from(body) };
        },
        async put(key, next, options = {}) {
            const etag = body ? `"${version}"` : null;
            if (
                (options.ifNoneMatch === '*' && body)
                || (options.ifMatch && options.ifMatch !== etag)
            ) {
                throw new PreconditionError(key);
            }
            body = Buffer.from(next);
            version += 1;
            writes += 1;
            return { key, etag: `"${version}"` };
        },
        isMissing(error) {
            return error instanceof MissingObjectError;
        },
        isPreconditionFailed(error) {
            return error instanceof PreconditionError;
        },
        value() {
            return body ? JSON.parse(body.toString('utf8')) : null;
        },
        writes() {
            return writes;
        },
    };
}

function command({ revision, writer, sequence, mutation, x, z }) {
    return {
        schema: 'business-world-layout-save-v2',
        expectedRevision: revision,
        writer,
        writerSequence: sequence,
        mutationId: mutation,
        layout: {
            buildings: { Workshop: { x, z } },
            paths: ['0,0'],
        },
    };
}

async function main() {
    const storage = memoryStorage({
        buildings: { Workshop: { x: 2, z: 2 } },
        paths: ['0,0'],
    });
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++));
    const firstStore = createWorldLayoutStore({ storage, now });
    const secondStore = createWorldLayoutStore({ storage, now });

    const legacy = await firstStore.read();
    assert.strictEqual(legacy._revision, 0, 'legacy layout did not migrate to revision zero');
    assert.deepStrictEqual(legacy.buildings.Workshop, { x: 2, z: 2 });

    const firstCommand = command({
        revision: 0,
        writer: 'browser-a',
        sequence: 1,
        mutation: 'browser-a:1:first',
        x: 8,
        z: 10,
    });
    const first = await firstStore.save(firstCommand);
    assert.strictEqual(first._revision, 1);
    assert.deepStrictEqual(first.buildings.Workshop, { x: 8, z: 10 });

    const writesBeforeRetry = storage.writes();
    const retry = await firstStore.save(firstCommand);
    assert.strictEqual(retry._revision, 1, 'idempotent retry advanced the revision');
    assert.strictEqual(storage.writes(), writesBeforeRetry, 'idempotent retry wrote another object');

    await assert.rejects(
        () => secondStore.save(command({
            revision: 0,
            writer: 'browser-b',
            sequence: 1,
            mutation: 'browser-b:1:stale',
            x: 20,
            z: 20,
        })),
        error => error instanceof WorldLayoutConflictError
            && error.current.revision === 1
    );

    const originProtected = await firstStore.save(command({
        revision: 1,
        writer: 'browser-a',
        sequence: 2,
        mutation: 'browser-a:2:origin',
        x: 0,
        z: 0,
    }));
    assert.strictEqual(originProtected._revision, 2);
    assert.deepStrictEqual(
        originProtected.buildings.Workshop,
        { x: 8, z: 10 },
        'an uninitialized origin replaced the stored building position'
    );

    const concurrent = await Promise.allSettled([
        firstStore.save(command({
            revision: 2,
            writer: 'browser-a',
            sequence: 3,
            mutation: 'browser-a:3:concurrent',
            x: 12,
            z: 14,
        })),
        secondStore.save(command({
            revision: 2,
            writer: 'browser-b',
            sequence: 2,
            mutation: 'browser-b:2:concurrent',
            x: 30,
            z: 32,
        })),
    ]);
    assert.strictEqual(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.strictEqual(concurrent.filter(result => result.status === 'rejected').length, 1);
    assert(
        concurrent.find(result => result.status === 'rejected').reason
            instanceof WorldLayoutConflictError,
        'the stale concurrent writer was not rejected'
    );
    assert.strictEqual(storage.value()._revision, 3);

    process.stdout.write(JSON.stringify({
        ok: true,
        legacyLayoutMigrated: true,
        idempotentRetry: true,
        staleWriterRejected: true,
        concurrentWriterRejected: true,
        exactRevision: storage.value()._revision,
    }) + '\n');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
