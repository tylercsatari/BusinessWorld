#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
    R2ObjectMissingError,
    R2PreconditionFailedError,
} = require('../cloud-storage');
const {
    R2_LEASE_SCHEMA,
    R2_LEASE_VERSION,
    R2_LEASE_ERROR_CODES,
    R2LeaseValidationError,
    R2LeaseLostError,
    R2LeaseStorageError,
    createR2LeaseManager,
    parseR2LeaseRecord,
    serializeR2LeaseRecord,
} = require('../buildings/jarvis/r2-lease');

class MockCasObjectStore {
    constructor() {
        this.object = null;
        this.revision = 0;
        this.operations = [];
        this.nextGetError = null;
        this.nextPutError = null;
    }

    async get(key, options = {}) {
        this.operations.push({ operation: 'get', key, options: { ...options } });
        if (this.nextGetError) {
            const error = this.nextGetError;
            this.nextGetError = null;
            throw error;
        }
        if (!this.object || this.object.key !== key) {
            throw new R2ObjectMissingError(key);
        }
        if (options.ifMatch && options.ifMatch !== this.object.etag) {
            throw new R2PreconditionFailedError(key, { ifMatch: options.ifMatch });
        }
        return Object.freeze({
            key,
            body: Buffer.from(this.object.body),
            etag: this.object.etag,
            contentLength: this.object.body.length,
            contentType: this.object.contentType,
            metadata: Object.freeze({ ...this.object.metadata }),
            lastModified: null,
            versionId: null,
        });
    }

    async put(key, body, options = {}) {
        this.operations.push({
            operation: 'put',
            key,
            body: Buffer.from(body),
            options: {
                ...options,
                metadata: { ...(options.metadata || {}) },
            },
        });
        if (this.nextPutError) {
            const error = this.nextPutError;
            this.nextPutError = null;
            throw error;
        }
        if (options.ifNoneMatch === '*' && this.object) {
            throw new R2PreconditionFailedError(key, { ifNoneMatch: '*' });
        }
        if (options.ifMatch && (!this.object || options.ifMatch !== this.object.etag)) {
            throw new R2PreconditionFailedError(key, { ifMatch: options.ifMatch });
        }
        if (!options.ifMatch && options.ifNoneMatch !== '*') {
            throw new Error('Mock store requires an explicit CAS condition');
        }

        this.revision += 1;
        const etag = `"mock-etag-${this.revision}"`;
        this.object = {
            key,
            body: Buffer.from(body),
            etag,
            contentType: options.contentType || null,
            metadata: { ...(options.metadata || {}) },
        };
        return Object.freeze({ key, etag, versionId: null });
    }

    forceObject(key, value) {
        this.revision += 1;
        this.object = {
            key,
            body: Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(JSON.stringify(value)),
            etag: `"mock-etag-${this.revision}"`,
            contentType: 'application/json',
            metadata: {},
        };
    }

    currentRecord() {
        return this.object ? parseR2LeaseRecord(this.object.body, { expectedKey: this.object.key }) : null;
    }
}

function fakeClock(initialMs) {
    let value = initialMs;
    return {
        now: () => value,
        set(next) {
            value = next;
        },
        advance(delta) {
            value += delta;
        },
    };
}

function managerFor(store, clock) {
    return createR2LeaseManager({
        storage: store,
        clock: clock.now,
        defaultTtlMs: 1000,
        defaultAcquireAttempts: 8,
    });
}

const tests = [];
function test(name, run) {
    tests.push({ name, run });
}

test('record schema serializes deterministically and rejects any undeclared field', () => {
    const record = {
        schema: R2_LEASE_SCHEMA,
        version: R2_LEASE_VERSION,
        key: 'leases/schema.json',
        state: 'active',
        owner_id: 'worker-a',
        generation: 1,
        ttl_ms: 1000,
        acquired_at_ms: 100,
        renewed_at_ms: 100,
        expires_at_ms: 1100,
        released_at_ms: null,
    };
    const first = serializeR2LeaseRecord(record);
    const second = serializeR2LeaseRecord({ ...record });
    assert.equal(first.toString('utf8'), second.toString('utf8'));
    assert.deepEqual(parseR2LeaseRecord(first, { expectedKey: record.key }), record);
    assert.throws(
        () => serializeR2LeaseRecord({ ...record, undocumented: true }),
        (error) => error instanceof R2LeaseValidationError
            && error.code === R2_LEASE_ERROR_CODES.INVALID_RECORD
    );
});

test('simultaneous cross-process acquisition has exactly one winner', async () => {
    const store = new MockCasObjectStore();
    const clock = fakeClock(1_000_000);
    const contenders = Array.from({ length: 24 }, (_, index) => {
        const manager = managerFor(store, clock);
        return manager.acquire({
            key: 'leases/concurrent.json',
            ownerId: `worker-${index}`,
            ttlMs: 5000,
        });
    });

    const results = await Promise.all(contenders);
    const winners = results.filter((result) => result.acquired);
    const losers = results.filter((result) => !result.acquired);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 23);
    assert.ok(losers.every((result) => result.reason === 'held' || result.reason === 'contention'));
    assert.equal(store.currentRecord().owner_id, winners[0].lease.ownerId);
    assert.equal(store.currentRecord().generation, 1);
});

test('a different owner cannot heartbeat, forge, or release an active lease', async () => {
    const store = new MockCasObjectStore();
    const clock = fakeClock(20_000);
    const manager = managerFor(store, clock);
    const acquired = await manager.acquire({
        key: 'leases/ownership.json',
        ownerId: 'worker-a',
        ttlMs: 5000,
    });

    await assert.rejects(
        manager.heartbeat({ lease: acquired.lease, ownerId: 'worker-b' }),
        (error) => error instanceof R2LeaseLostError && error.reason === 'owner-mismatch'
    );
    await assert.rejects(
        manager.release({ lease: acquired.lease, ownerId: 'worker-b' }),
        (error) => error instanceof R2LeaseLostError && error.reason === 'owner-mismatch'
    );

    const forged = Object.freeze({ ...acquired.lease, ownerId: 'worker-b' });
    await assert.rejects(
        manager.heartbeat({ lease: forged, ownerId: 'worker-b' }),
        (error) => error instanceof R2LeaseLostError && error.reason === 'superseded'
    );
    assert.equal(store.currentRecord().owner_id, 'worker-a');
    assert.equal(store.currentRecord().state, 'active');
});

test('heartbeat renews only the matching owner and ETag and invalidates the old handle', async () => {
    const store = new MockCasObjectStore();
    const clock = fakeClock(30_000);
    const manager = managerFor(store, clock);
    const acquired = await manager.acquire({
        key: 'leases/heartbeat.json',
        ownerId: 'worker-a',
        ttlMs: 1000,
    });

    clock.advance(400);
    const renewed = await manager.heartbeat({
        lease: acquired.lease,
        ownerId: 'worker-a',
        ttlMs: 2000,
    });
    assert.notEqual(renewed.etag, acquired.lease.etag);
    assert.equal(renewed.renewedAtMs, 30_400);
    assert.equal(renewed.expiresAtMs, 32_400);
    assert.equal(store.currentRecord().expires_at_ms, 32_400);

    await assert.rejects(
        manager.heartbeat({
            lease: acquired.lease,
            ownerId: 'worker-a',
            ttlMs: 2000,
        }),
        (error) => error instanceof R2LeaseLostError && error.reason === 'superseded'
    );
});

test('stale takeover is compare-and-swap and gives one new owner a higher fencing generation', async () => {
    const store = new MockCasObjectStore();
    const clock = fakeClock(40_000);
    const originalManager = managerFor(store, clock);
    const original = await originalManager.acquire({
        key: 'leases/stale.json',
        ownerId: 'worker-old',
        ttlMs: 1000,
    });

    clock.set(41_000);
    const contenderB = managerFor(store, clock);
    const contenderC = managerFor(store, clock);
    const results = await Promise.all([
        contenderB.acquire({
            key: 'leases/stale.json',
            ownerId: 'worker-b',
            ttlMs: 5000,
        }),
        contenderC.acquire({
            key: 'leases/stale.json',
            ownerId: 'worker-c',
            ttlMs: 5000,
        }),
    ]);
    const winners = results.filter((result) => result.acquired);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].reason, 'stale');
    assert.equal(winners[0].lease.generation, 2);
    assert.equal(store.currentRecord().owner_id, winners[0].lease.ownerId);

    await assert.rejects(
        originalManager.heartbeat({ lease: original.lease, ownerId: 'worker-old' }),
        (error) => error instanceof R2LeaseLostError && error.reason === 'superseded'
    );
    await assert.rejects(
        originalManager.release({ lease: original.lease, ownerId: 'worker-old' }),
        (error) => error instanceof R2LeaseLostError && error.reason === 'superseded'
    );

    const takeoverWrites = store.operations.filter((operation) =>
        operation.operation === 'put'
        && operation.options.ifMatch === original.lease.etag
    );
    assert.equal(takeoverWrites.length, 2, 'both contenders must CAS against the exact stale ETag');
});

test('release is an owner-only CAS tombstone and permits an immediate next generation', async () => {
    const store = new MockCasObjectStore();
    const clock = fakeClock(50_000);
    const manager = managerFor(store, clock);
    const acquired = await manager.acquire({
        key: 'leases/release.json',
        ownerId: 'worker-a',
        ttlMs: 5000,
    });

    clock.advance(500);
    const released = await manager.release({
        lease: acquired.lease,
        ownerId: 'worker-a',
    });
    assert.equal(released.state, 'released');
    assert.equal(released.releasedAtMs, 50_500);
    assert.equal(store.currentRecord().state, 'released');
    assert.equal(store.currentRecord().expires_at_ms, 50_500);

    await assert.rejects(
        manager.release({ lease: acquired.lease, ownerId: 'worker-a' }),
        (error) => error instanceof R2LeaseLostError
    );

    const next = await manager.acquire({
        key: 'leases/release.json',
        ownerId: 'worker-b',
        ttlMs: 5000,
    });
    assert.equal(next.acquired, true);
    assert.equal(next.reason, 'released');
    assert.equal(next.lease.generation, 2);
    assert.equal(next.lease.ownerId, 'worker-b');
});

test('storage outages and malformed lease objects fail closed without a takeover write', async () => {
    const store = new MockCasObjectStore();
    const clock = fakeClock(60_000);
    const manager = managerFor(store, clock);
    const outage = Object.assign(new Error('R2 unavailable'), { code: 'ECONNRESET' });
    store.nextGetError = outage;

    await assert.rejects(
        manager.acquire({
            key: 'leases/fail-closed.json',
            ownerId: 'worker-a',
            ttlMs: 1000,
        }),
        (error) => {
            assert.ok(error instanceof R2LeaseStorageError);
            assert.equal(error.code, R2_LEASE_ERROR_CODES.STORAGE);
            assert.equal(error.cause, outage);
            return true;
        }
    );
    assert.equal(store.operations.filter((operation) => operation.operation === 'put').length, 0);

    const putOutage = Object.assign(new Error('R2 write timed out'), { code: 'ETIMEDOUT' });
    store.nextPutError = putOutage;
    await assert.rejects(
        manager.acquire({
            key: 'leases/fail-closed.json',
            ownerId: 'worker-a',
            ttlMs: 1000,
        }),
        (error) => {
            assert.ok(error instanceof R2LeaseStorageError);
            assert.equal(error.code, R2_LEASE_ERROR_CODES.STORAGE);
            assert.equal(error.cause, putOutage);
            assert.equal(error.operation, 'put');
            return true;
        }
    );
    assert.equal(store.object, null, 'a failed conditional write cannot produce an ownership handle');

    store.forceObject('leases/fail-closed.json', {
        schema: R2_LEASE_SCHEMA,
        version: R2_LEASE_VERSION,
        key: 'leases/fail-closed.json',
        state: 'active',
        owner_id: 'worker-corrupt',
        generation: 1,
        ttl_ms: 1000,
        acquired_at_ms: 1,
        renewed_at_ms: 1,
        expires_at_ms: 2,
        released_at_ms: null,
        unversioned_extra_field: true,
    });
    const putCountBefore = store.operations.filter((operation) => operation.operation === 'put').length;
    await assert.rejects(
        manager.acquire({
            key: 'leases/fail-closed.json',
            ownerId: 'worker-b',
            ttlMs: 1000,
        }),
        (error) => error instanceof R2LeaseValidationError
    );
    const putCountAfter = store.operations.filter((operation) => operation.operation === 'put').length;
    assert.equal(putCountAfter, putCountBefore, 'invalid stored state must never be overwritten');
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
