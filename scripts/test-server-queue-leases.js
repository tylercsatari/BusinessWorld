#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
    R2ObjectMissingError,
    R2PreconditionFailedError,
} = require('../cloud-storage');
const {
    createR2LeaseManager,
    parseR2LeaseRecord,
} = require('../buildings/jarvis/r2-lease');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(
    path.join(root, 'server.js'),
    'utf8'
);
const runtimeStart = serverSource.indexOf(
    '// BEGIN QUEUE_LEASE_RUNTIME'
);
const runtimeEnd = serverSource.indexOf(
    '// END QUEUE_LEASE_RUNTIME'
);
assert.ok(
    runtimeStart >= 0 && runtimeEnd > runtimeStart,
    'server queue lease runtime markers are missing'
);

const runtimeContext = {
    console,
    Date,
    Error,
    Object,
    Promise,
    RangeError,
    String,
    TypeError,
    setInterval,
    clearInterval,
};
vm.createContext(runtimeContext);
vm.runInContext(
    serverSource.slice(runtimeStart, runtimeEnd)
        + '\nthis.queueLeaseTestApi = {'
        + ' QUEUE_LEASE_FENCE_SCHEMA,'
        + ' QUEUE_LEASE_FENCE_VERSION,'
        + ' QUEUE_LEASE_NAMES,'
        + ' QueueLeaseOwnershipError,'
        + ' createQueueLeaseCoordinator'
        + ' };',
    runtimeContext
);
const {
    QUEUE_LEASE_FENCE_SCHEMA,
    QUEUE_LEASE_FENCE_VERSION,
    QUEUE_LEASE_NAMES,
    createQueueLeaseCoordinator,
} = runtimeContext.queueLeaseTestApi;

class MockCasObjectStore {
    constructor() {
        this.objects = new Map();
        this.revision = 0;
    }

    async get(key) {
        const object = this.objects.get(key);
        if (!object) throw new R2ObjectMissingError(key);
        return Object.freeze({
            key,
            body: Buffer.from(object.body),
            etag: object.etag,
            contentLength: object.body.length,
            contentType: 'application/json',
            metadata: Object.freeze({}),
            lastModified: null,
            versionId: null,
        });
    }

    async put(key, body, options = {}) {
        const current = this.objects.get(key);
        if (options.ifNoneMatch === '*' && current) {
            throw new R2PreconditionFailedError(
                key,
                { ifNoneMatch: '*' }
            );
        }
        if (
            options.ifMatch
            && (!current || options.ifMatch !== current.etag)
        ) {
            throw new R2PreconditionFailedError(
                key,
                { ifMatch: options.ifMatch }
            );
        }
        this.revision += 1;
        const object = {
            body: Buffer.from(body),
            etag: `"queue-etag-${this.revision}"`,
        };
        this.objects.set(key, object);
        return Object.freeze({
            key,
            etag: object.etag,
            versionId: null,
        });
    }

    record(key) {
        const object = this.objects.get(key);
        return object
            ? parseR2LeaseRecord(object.body, {
                expectedKey: key,
            })
            : null;
    }
}

function fakeClock(initialMs = 1_000_000) {
    let now = initialMs;
    return {
        now: () => now,
        advance(ms) {
            now += ms;
        },
    };
}

function fakeTimers() {
    const timers = new Set();
    return {
        setIntervalFn(callback, intervalMs) {
            const timer = {
                callback,
                intervalMs,
                active: true,
                unref() {},
            };
            timers.add(timer);
            return timer;
        },
        clearIntervalFn(timer) {
            timer.active = false;
            timers.delete(timer);
        },
        async fire() {
            for (const timer of [...timers]) {
                if (timer.active) timer.callback();
            }
            await new Promise(resolve => setImmediate(resolve));
        },
        get size() {
            return timers.size;
        },
    };
}

function coordinatorFor({
    manager,
    ownerId,
    clock,
    timers,
    leaseApi = null,
}) {
    return createQueueLeaseCoordinator({
        leaseApi: leaseApi || {
            acquire: options => manager.acquire(options),
            heartbeat: options => manager.heartbeat(options),
            release: options => manager.release(options),
            inspect: options => manager.inspect(options),
        },
        ownerId,
        ttlMs: 1000,
        heartbeatIntervalMs: 200,
        clock: clock.now,
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
    });
}

function functionSource(name, nextName) {
    const start = serverSource.indexOf(
        `async function ${name}`
    );
    const end = serverSource.indexOf(
        `async function ${nextName}`,
        start + 1
    );
    assert.ok(
        start >= 0 && end > start,
        `${name} source boundaries are missing`
    );
    return serverSource.slice(start, end);
}

const tests = [];
function test(name, run) {
    tests.push({ name, run });
}

test(
    'two Render processes cannot acquire the same queue job',
    async () => {
        const store = new MockCasObjectStore();
        const clock = fakeClock();
        const manager = createR2LeaseManager({
            storage: store,
            clock: clock.now,
            defaultTtlMs: 1000,
        });
        const timersA = fakeTimers();
        const timersB = fakeTimers();
        const processA = coordinatorFor({
            manager,
            ownerId: 'render-a',
            clock,
            timers: timersA,
        });
        const processB = coordinatorFor({
            manager,
            ownerId: 'render-b',
            clock,
            timers: timersB,
        });

        const contenders = await Promise.all([
            processA.acquire(
                QUEUE_LEASE_NAMES.SHORTS_HOOK,
                'job123'
            ),
            processB.acquire(
                QUEUE_LEASE_NAMES.SHORTS_HOOK,
                'job123'
            ),
        ]);
        const owners = contenders.filter(Boolean);
        assert.equal(owners.length, 1);
        const owner = owners[0];
        let consumed = 0;
        const fence = await owner.mutate(
            'consume test request',
            activeFence => {
                consumed += 1;
                return activeFence;
            }
        );
        assert.equal(consumed, 1);
        assert.equal(fence.schema, QUEUE_LEASE_FENCE_SCHEMA);
        assert.equal(
            fence.schema_version,
            QUEUE_LEASE_FENCE_VERSION
        );
        assert.equal(fence.queue_name, 'shorts-hook');
        assert.equal(fence.job_id, 'job123');
        assert.equal(fence.generation, 1);
        assert.equal(
            fence.lease_key,
            'queue-leases/shorts-hook/job123.json'
        );

        const released = await owner.release();
        assert.equal(released.released, true);
        assert.equal(timersA.size + timersB.size, 0);
    }
);

test(
    'scheduled heartbeats renew ownership during long work',
    async () => {
        const store = new MockCasObjectStore();
        const clock = fakeClock();
        const manager = createR2LeaseManager({
            storage: store,
            clock: clock.now,
            defaultTtlMs: 1000,
        });
        const timers = fakeTimers();
        const coordinator = coordinatorFor({
            manager,
            ownerId: 'render-heartbeat',
            clock,
            timers,
        });
        const ownership = await coordinator.acquire(
            QUEUE_LEASE_NAMES.SHORTS_GRIND,
            'grind123'
        );
        const key = coordinator.keyFor(
            QUEUE_LEASE_NAMES.SHORTS_GRIND,
            'grind123'
        );
        const before = store.record(key);
        clock.advance(200);
        await timers.fire();
        const after = store.record(key);
        assert.equal(before.generation, after.generation);
        assert.equal(after.renewed_at_ms, clock.now());
        assert.ok(after.expires_at_ms > before.expires_at_ms);
        await ownership.release();
    }
);

test(
    'heartbeat uncertainty fences all later mutations and skips release',
    async () => {
        const store = new MockCasObjectStore();
        const clock = fakeClock();
        const manager = createR2LeaseManager({
            storage: store,
            clock: clock.now,
            defaultTtlMs: 1000,
        });
        const timers = fakeTimers();
        let failHeartbeat = false;
        let releaseCalls = 0;
        const leaseApi = {
            acquire: options => manager.acquire(options),
            heartbeat: options => {
                if (failHeartbeat) {
                    throw new Error('simulated R2 uncertainty');
                }
                return manager.heartbeat(options);
            },
            release: options => {
                releaseCalls += 1;
                return manager.release(options);
            },
            inspect: options => manager.inspect(options),
        };
        const coordinator = coordinatorFor({
            manager,
            ownerId: 'render-uncertain',
            clock,
            timers,
            leaseApi,
        });
        const ownership = await coordinator.acquire(
            QUEUE_LEASE_NAMES.LONG_GRIND,
            'long123'
        );
        failHeartbeat = true;
        await assert.rejects(
            ownership.heartbeat('forced uncertainty'),
            error => (
                error
                && error.code
                    === 'QUEUE_LEASE_OWNERSHIP_UNCERTAIN'
            )
        );
        let mutated = false;
        await assert.rejects(
            ownership.mutate(
                'must not run',
                () => {
                    mutated = true;
                }
            ),
            error => (
                error
                && error.code
                    === 'QUEUE_LEASE_OWNERSHIP_UNCERTAIN'
            )
        );
        assert.equal(mutated, false);
        const released = await ownership.release();
        assert.equal(released.released, false);
        assert.equal(released.reason, 'ownership-uncertain');
        assert.equal(releaseCalls, 0);
    }
);

test(
    'stale takeover increments the fencing generation and blocks the old owner',
    async () => {
        const store = new MockCasObjectStore();
        const clock = fakeClock();
        const manager = createR2LeaseManager({
            storage: store,
            clock: clock.now,
            defaultTtlMs: 1000,
        });
        const first = coordinatorFor({
            manager,
            ownerId: 'render-old',
            clock,
            timers: fakeTimers(),
        });
        const second = coordinatorFor({
            manager,
            ownerId: 'render-new',
            clock,
            timers: fakeTimers(),
        });
        const oldOwner = await first.acquire(
            QUEUE_LEASE_NAMES.LONG_GRIND,
            'takeover123'
        );
        clock.advance(1000);
        const newOwner = await second.acquire(
            QUEUE_LEASE_NAMES.LONG_GRIND,
            'takeover123'
        );
        assert.equal(newOwner.generation, 2);
        assert.equal(newOwner.fence().generation, 2);
        let staleWrite = false;
        await assert.rejects(
            oldOwner.heartbeat('old owner after takeover'),
            error => (
                error
                && error.code
                    === 'QUEUE_LEASE_OWNERSHIP_UNCERTAIN'
            )
        );
        await assert.rejects(
            oldOwner.mutate(
                'stale write',
                () => {
                    staleWrite = true;
                }
            )
        );
        assert.equal(staleWrite, false);
        await newOwner.release();
        await oldOwner.release();
    }
);

test(
    'all live consumers, recovery, and forced resume use the durable lease',
    () => {
        const hookQueue = functionSource(
            'hookDemoQueue',
            'composeMontage'
        );
        const shortsQueue = functionSource(
            'grindQueue',
            'longQuantHostedRun'
        );
        const longRecovery = functionSource(
            'longQuantRecoverStaleGrinds',
            'longQuantGrindQueue'
        );
        const longQueue = serverSource.slice(
            serverSource.indexOf(
                'async function longQuantGrindQueue'
            ),
            serverSource.indexOf(
                '// Phone video probes are bounded'
            )
        );
        const resumeRoute = serverSource.slice(
            serverSource.indexOf(
                "if (pathname === '/api/longquant/grind/resume'"
            ),
            serverSource.indexOf(
                'const lqGrindImg',
                serverSource.indexOf(
                    "if (pathname === '/api/longquant/grind/resume'"
                )
            )
        );
        for (const [name, body, queueConstant] of [
            [
                'Shorts hook',
                hookQueue,
                'QUEUE_LEASE_NAMES.SHORTS_HOOK',
            ],
            [
                'Shorts grind',
                shortsQueue,
                'QUEUE_LEASE_NAMES.SHORTS_GRIND',
            ],
            [
                'Long grind',
                longQueue,
                'QUEUE_LEASE_NAMES.LONG_GRIND',
            ],
        ]) {
            const acquireAt = body.indexOf(
                'queueLeaseCoordinator.acquire'
            );
            const consumeAt = body.indexOf(
                'consume '
            );
            assert.ok(
                acquireAt >= 0 && consumeAt > acquireAt,
                `${name} does not acquire before consuming`
            );
            assert.ok(
                body.includes(queueConstant),
                `${name} uses the wrong lease namespace`
            );
            assert.ok(
                body.includes('ownership.release()'),
                `${name} lacks owner-only release`
            );
        }
        assert.ok(
            longRecovery.includes(
                'queueLeaseCoordinator.acquire'
            )
            && longRecovery.includes(
                "'revalidate stale Long grind'"
            ),
            'Long recovery mutates without acquiring ownership'
        );
        assert.ok(
            resumeRoute.includes(
                'queueLeaseCoordinator.acquire'
            )
            && resumeRoute.includes(
                'longQuantGrindProcess('
            )
            && resumeRoute.includes('ownership'),
            'forced Long resume bypasses durable ownership'
        );
        assert.ok(
            serverSource.includes(
                'queue_lease_fence: queueLeaseFence'
            ),
            'progress records do not persist fencing generations'
        );
        assert.ok(
            serverSource.includes(
                "cloud.existsInR2(`hooks/grind/stop/${rid}`)"
            )
            && serverSource.includes(
                "cloud.existsInR2(\n            `longform/grind/stop/${rid}`"
            ),
            'Shorts or Long cancellation marker checks were removed'
        );
    }
);

test(
    'Shorts and Long stop markers remain authoritative under a lease',
    () => {
        const shortsProcess = serverSource.slice(
            serverSource.indexOf(
                'async function grindProcess'
            ),
            serverSource.indexOf(
                'let _grindBusy',
                serverSource.indexOf(
                    'async function grindProcess'
                )
            )
        );
        const longProcess = serverSource.slice(
            serverSource.indexOf(
                'async function longQuantGrindProcess'
            ),
            serverSource.indexOf(
                'const _lqGrindActive',
                serverSource.indexOf(
                    'async function longQuantGrindProcess'
                )
            )
        );
        const longStopRoute = serverSource.slice(
            serverSource.indexOf(
                "if (pathname === '/api/longquant/grind/stop'"
            ),
            serverSource.indexOf(
                "if (pathname === '/api/longquant/grind/resume'"
            )
        );
        const shortsStopRoute = serverSource.slice(
            serverSource.indexOf(
                'const grindStop = pathname.match'
            ),
            serverSource.indexOf(
                'const grindRun = pathname.match'
            )
        );

        assert.ok(
            shortsProcess.indexOf(
                "'check Shorts grind cancellation'"
            )
                < shortsProcess.indexOf(
                    "`hooks/grind/stop/${rid}`"
                )
            && shortsProcess.includes(
                "status = 'stopped'"
            )
            && shortsProcess.includes(
                "note = 'stopped by you'"
            ),
            'Shorts grind no longer checks its stop marker while owned'
        );
        assert.ok(
            longProcess.indexOf(
                "'check Long grind cancellation'"
            )
                < longProcess.indexOf(
                    "`longform/grind/stop/${rid}`"
                )
            && longProcess.includes(
                "status = 'stopped'"
            )
            && longProcess.includes(
                "note = 'stopped by you'"
            ),
            'Long grind no longer checks its stop marker while owned'
        );
        assert.ok(
            shortsStopRoute.includes(
                'hooks/grind/stop/'
            ),
            'Shorts stop endpoint no longer publishes its marker'
        );
        assert.ok(
            longStopRoute.includes(
                'longform/grind/stop/'
            )
            && longStopRoute.includes(
                'longform/grind/requests/'
            ),
            'Long stop endpoint no longer cancels queued and running work'
        );
    }
);

(async () => {
    let passed = 0;
    for (const { name, run } of tests) {
        try {
            await run();
            passed += 1;
            console.log(`ok ${passed} - ${name}`);
        } catch (error) {
            console.error(`not ok ${passed + 1} - ${name}`);
            throw error;
        }
    }
    console.log(`1..${passed}`);
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
