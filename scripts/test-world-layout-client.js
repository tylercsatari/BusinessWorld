#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    WorldLayoutConflictError,
    createWorldLayoutStore,
    layoutRevisionMetadata,
} = require('../world-layout-store');
const {
    createWorldLayoutClient,
} = require('../world-layout-client');

class MissingObjectError extends Error {}
class PreconditionError extends Error {}

function memoryStorage(seed) {
    const values = new Map(Object.entries(seed || {}));
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
        has(key) { return values.has(key); },
    };
}

function r2MemoryStorage() {
    let body = null;
    let version = 0;
    return {
        async get(key, options = {}) {
            if (!body) throw new MissingObjectError(key);
            const etag = `"${version}"`;
            if (options.ifMatch && options.ifMatch !== etag) throw new PreconditionError(key);
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
            return { key, etag: `"${version}"` };
        },
        isMissing(error) { return error instanceof MissingObjectError; },
        isPreconditionFailed(error) { return error instanceof PreconditionError; },
    };
}

function response(status, value) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return value; },
    };
}

function createBackend() {
    const store = createWorldLayoutStore({ storage: r2MemoryStorage() });
    let activeSaves = 0;
    let maximumActiveSaves = 0;
    let failSaves = false;
    let loseAcknowledgementOnce = false;
    return {
        store,
        setFailSaves(value) { failSaves = value; },
        loseAcknowledgementOnce() { loseAcknowledgementOnce = true; },
        maximumActiveSaves() { return maximumActiveSaves; },
        async fetch(url, options = {}) {
            if (url === '/load-layout') return response(200, await store.read());
            if (url !== '/save-layout') return response(404, { error: 'not found' });
            if (failSaves) throw new Error('network unavailable');
            activeSaves += 1;
            maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
            try {
                await new Promise(resolve => setTimeout(resolve, 4));
                const command = JSON.parse(options.body);
                try {
                    const saved = await store.save(command);
                    if (loseAcknowledgementOnce) {
                        loseAcknowledgementOnce = false;
                        throw new Error('connection closed after write');
                    }
                    return response(200, { ok: true, ...layoutRevisionMetadata(saved) });
                } catch (error) {
                    if (error instanceof WorldLayoutConflictError) {
                        return response(409, {
                            error: error.message,
                            code: error.code,
                            current: error.current,
                        });
                    }
                    throw error;
                }
            } finally {
                activeSaves -= 1;
            }
        },
    };
}

function idFactory(values) {
    let index = 0;
    return () => values[index++] || `generated-${index}`;
}

function client(backend, storage, ids) {
    return createWorldLayoutClient({
        fetchImpl: backend.fetch,
        storage,
        createId: idFactory(ids),
        retryDelays: [0, 1],
        backgroundRetryMs: 60 * 1000,
    });
}

async function main() {
    const backend = createBackend();
    const tabStorage = memoryStorage();
    const firstClient = client(backend, tabStorage, [
        'browser-a', 'mutation-a1', 'mutation-a2', 'mutation-a3',
    ]);
    const initial = await firstClient.load();
    firstClient.setReady();
    assert.strictEqual(initial.layout._revision, 0);

    const firstSave = firstClient.save({ buildings: { Jarvis: { x: 4, z: 6 } } });
    const secondSave = firstClient.save({ buildings: { Jarvis: { x: 12, z: 14 } } });
    assert.strictEqual((await firstSave).ok, true);
    assert.strictEqual((await secondSave).ok, true);
    assert.strictEqual(backend.maximumActiveSaves(), 1, 'client writes overlapped');
    let stored = await backend.store.read();
    assert.deepStrictEqual(stored.buildings.Jarvis, { x: 12, z: 14 });
    assert.strictEqual(stored._revision, 2);

    backend.loseAcknowledgementOnce();
    const lostAcknowledgement = await firstClient.save({
        buildings: { Jarvis: { x: 18, z: 20 } },
    });
    assert.strictEqual(lostAcknowledgement.ok, true, 'lost acknowledgement was not retried idempotently');
    stored = await backend.store.read();
    assert.strictEqual(stored._revision, 3, 'idempotent transport retry wrote twice');

    backend.setFailSaves(true);
    const unsaved = await firstClient.save({
        buildings: { Jarvis: { x: 24, z: 26 } },
    });
    assert.strictEqual(unsaved.ok, false);
    assert.strictEqual(tabStorage.has('business-world:layout-draft:v2'), true);
    firstClient.dispose();

    backend.setFailSaves(false);
    const recoveredClient = client(backend, tabStorage, ['recovery-mutation']);
    const recovered = await recoveredClient.load();
    assert.strictEqual(recovered.recovered, true);
    assert.deepStrictEqual(recovered.layout.buildings.Jarvis, { x: 24, z: 26 });
    recoveredClient.setReady();
    const recoveredSave = await recoveredClient.save(recovered.layout);
    assert.strictEqual(recoveredSave.ok, true);
    stored = await backend.store.read();
    assert.deepStrictEqual(stored.buildings.Jarvis, { x: 24, z: 26 });
    assert.strictEqual(tabStorage.has('business-world:layout-draft:v2'), false);

    const tabOneStorage = memoryStorage();
    const tabTwoStorage = memoryStorage();
    const tabOne = client(backend, tabOneStorage, ['browser-one', 'one-mutation']);
    const tabTwo = client(backend, tabTwoStorage, ['browser-two', 'two-mutation']);
    await Promise.all([tabOne.load(), tabTwo.load()]);
    tabOne.setReady();
    tabTwo.setReady();
    assert.strictEqual((await tabOne.save({ buildings: { Jarvis: { x: 30, z: 32 } } })).ok, true);
    const staleResult = await tabTwo.save({ buildings: { Jarvis: { x: 40, z: 42 } } });
    assert.strictEqual(staleResult.ok, false);
    assert.strictEqual(staleResult.conflict, true);
    stored = await backend.store.read();
    assert.deepStrictEqual(stored.buildings.Jarvis, { x: 30, z: 32 });

    const reloadClient = client(backend, memoryStorage(), ['browser-reload']);
    const reloaded = await reloadClient.load();
    assert.deepStrictEqual(reloaded.layout.buildings.Jarvis, { x: 30, z: 32 });

    [recoveredClient, tabOne, tabTwo, reloadClient].forEach(value => value.dispose());
    process.stdout.write(JSON.stringify({
        ok: true,
        orderedSaves: true,
        idempotentTransportRetry: true,
        unsavedReloadRecovery: true,
        staleTabRejected: true,
        exactReload: true,
        finalRevision: stored._revision,
    }) + '\n');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
