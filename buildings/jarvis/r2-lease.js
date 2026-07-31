'use strict';

const {
    getR2SmallObject,
    putR2SmallObjectConditional,
    isMissingR2ObjectError,
    isR2PreconditionFailedError,
} = require('../../cloud-storage');

const R2_LEASE_SCHEMA = 'business-world.r2-lease';
const R2_LEASE_VERSION = 1;
const R2_LEASE_HANDLE_SCHEMA = 'business-world.r2-lease-handle';
const R2_LEASE_RECORD_MAX_BYTES = 4096;
const MIN_R2_LEASE_TTL_MS = 1000;
const MAX_R2_LEASE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_R2_LEASE_TTL_MS = 60 * 1000;
const DEFAULT_R2_LEASE_ACQUIRE_ATTEMPTS = 8;
const MAX_R2_LEASE_ACQUIRE_ATTEMPTS = 32;

const R2_LEASE_ERROR_CODES = Object.freeze({
    INVALID_RECORD: 'R2_LEASE_INVALID_RECORD',
    INVALID_HANDLE: 'R2_LEASE_INVALID_HANDLE',
    LOST: 'R2_LEASE_LOST',
    STORAGE: 'R2_LEASE_STORAGE_ERROR',
    CLOCK: 'R2_LEASE_CLOCK_ERROR',
});

const LEASE_RECORD_KEYS = Object.freeze([
    'acquired_at_ms',
    'expires_at_ms',
    'generation',
    'key',
    'owner_id',
    'released_at_ms',
    'renewed_at_ms',
    'schema',
    'state',
    'ttl_ms',
    'version',
].sort());
const LEASE_HANDLE_KEYS = Object.freeze([
    'acquiredAtMs',
    'etag',
    'expiresAtMs',
    'generation',
    'key',
    'ownerId',
    'releasedAtMs',
    'renewedAtMs',
    'schema',
    'state',
    'ttlMs',
    'version',
].sort());

class R2LeaseError extends Error {
    constructor(message, { code, key = null, cause = null, ...details } = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.key = key;
        if (cause) this.cause = cause;
        Object.assign(this, details);
    }
}

class R2LeaseValidationError extends R2LeaseError {
    constructor(message, { key = null, cause = null, field = null } = {}) {
        super(message, {
            code: R2_LEASE_ERROR_CODES.INVALID_RECORD,
            key,
            cause,
            field,
            retryable: false,
        });
    }
}

class R2LeaseHandleError extends R2LeaseError {
    constructor(message, { key = null, field = null } = {}) {
        super(message, {
            code: R2_LEASE_ERROR_CODES.INVALID_HANDLE,
            key,
            field,
            retryable: false,
        });
    }
}

class R2LeaseLostError extends R2LeaseError {
    constructor(message, { key, ownerId, generation, reason, cause = null } = {}) {
        super(message, {
            code: R2_LEASE_ERROR_CODES.LOST,
            key,
            cause,
            ownerId,
            generation,
            reason,
            retryable: false,
        });
    }
}

class R2LeaseStorageError extends R2LeaseError {
    constructor(message, { key, operation, cause } = {}) {
        super(message, {
            code: R2_LEASE_ERROR_CODES.STORAGE,
            key,
            cause,
            operation,
            retryable: true,
        });
    }
}

class R2LeaseClockError extends R2LeaseError {
    constructor(message, { key = null, nowMs, priorMs = null } = {}) {
        super(message, {
            code: R2_LEASE_ERROR_CODES.CLOCK,
            key,
            nowMs,
            priorMs,
            retryable: false,
        });
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertSafeTimestamp(value, field, key, ErrorClass = R2LeaseValidationError) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new ErrorClass(`${field} must be a non-negative safe integer`, { key, field });
    }
    return value;
}

function validateLeaseKey(key, ErrorClass = R2LeaseValidationError) {
    if (
        typeof key !== 'string'
        || !key
        || Buffer.byteLength(key, 'utf8') > 1024
        || /[\u0000-\u001f\u007f]/.test(key)
    ) {
        throw new ErrorClass('Lease key must be a non-empty control-free string no larger than 1024 bytes', {
            key: typeof key === 'string' ? key : null,
            field: 'key',
        });
    }
    return key;
}

function validateOwnerId(ownerId, key, ErrorClass = R2LeaseValidationError) {
    if (
        typeof ownerId !== 'string'
        || !ownerId
        || Buffer.byteLength(ownerId, 'utf8') > 256
        || /[\u0000-\u001f\u007f]/.test(ownerId)
    ) {
        throw new ErrorClass('owner_id must be a non-empty control-free string no larger than 256 bytes', {
            key,
            field: 'owner_id',
        });
    }
    return ownerId;
}

function validateTtlMs(ttlMs, key, ErrorClass = R2LeaseValidationError) {
    if (
        !Number.isSafeInteger(ttlMs)
        || ttlMs < MIN_R2_LEASE_TTL_MS
        || ttlMs > MAX_R2_LEASE_TTL_MS
    ) {
        throw new ErrorClass(
            `ttl_ms must be an integer between ${MIN_R2_LEASE_TTL_MS} and ${MAX_R2_LEASE_TTL_MS}`,
            { key, field: 'ttl_ms' }
        );
    }
    return ttlMs;
}

function canonicalLeaseRecord(record) {
    return Object.freeze({
        schema: record.schema,
        version: record.version,
        key: record.key,
        state: record.state,
        owner_id: record.owner_id,
        generation: record.generation,
        ttl_ms: record.ttl_ms,
        acquired_at_ms: record.acquired_at_ms,
        renewed_at_ms: record.renewed_at_ms,
        expires_at_ms: record.expires_at_ms,
        released_at_ms: record.released_at_ms,
    });
}

function validateR2LeaseRecord(record, { expectedKey = null } = {}) {
    if (!isPlainObject(record)) {
        throw new R2LeaseValidationError('Lease record must be a plain object', {
            key: expectedKey,
        });
    }
    const actualKeys = Object.keys(record).sort();
    if (
        actualKeys.length !== LEASE_RECORD_KEYS.length
        || actualKeys.some((key, index) => key !== LEASE_RECORD_KEYS[index])
    ) {
        throw new R2LeaseValidationError('Lease record fields do not match the versioned schema', {
            key: expectedKey,
            field: 'record',
        });
    }
    if (record.schema !== R2_LEASE_SCHEMA || record.version !== R2_LEASE_VERSION) {
        throw new R2LeaseValidationError('Lease record schema or version is unsupported', {
            key: expectedKey,
            field: 'schema',
        });
    }

    const key = validateLeaseKey(record.key);
    if (expectedKey !== null && key !== expectedKey) {
        throw new R2LeaseValidationError('Lease body key does not match its R2 object key', {
            key: expectedKey,
            field: 'key',
        });
    }
    if (record.state !== 'active' && record.state !== 'released') {
        throw new R2LeaseValidationError('Lease state must be "active" or "released"', {
            key,
            field: 'state',
        });
    }
    validateOwnerId(record.owner_id, key);
    if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
        throw new R2LeaseValidationError('generation must be a positive safe integer', {
            key,
            field: 'generation',
        });
    }
    validateTtlMs(record.ttl_ms, key);
    assertSafeTimestamp(record.acquired_at_ms, 'acquired_at_ms', key);
    assertSafeTimestamp(record.renewed_at_ms, 'renewed_at_ms', key);
    assertSafeTimestamp(record.expires_at_ms, 'expires_at_ms', key);

    if (record.renewed_at_ms < record.acquired_at_ms) {
        throw new R2LeaseValidationError('renewed_at_ms cannot precede acquired_at_ms', {
            key,
            field: 'renewed_at_ms',
        });
    }
    if (record.state === 'active') {
        if (record.released_at_ms !== null) {
            throw new R2LeaseValidationError('An active lease must have released_at_ms = null', {
                key,
                field: 'released_at_ms',
            });
        }
        if (record.expires_at_ms !== record.renewed_at_ms + record.ttl_ms) {
            throw new R2LeaseValidationError('Active lease expiry must equal renewed_at_ms + ttl_ms', {
                key,
                field: 'expires_at_ms',
            });
        }
    } else {
        assertSafeTimestamp(record.released_at_ms, 'released_at_ms', key);
        if (record.released_at_ms < record.renewed_at_ms) {
            throw new R2LeaseValidationError('released_at_ms cannot precede renewed_at_ms', {
                key,
                field: 'released_at_ms',
            });
        }
        if (record.expires_at_ms !== record.released_at_ms) {
            throw new R2LeaseValidationError('Released lease expiry must equal released_at_ms', {
                key,
                field: 'expires_at_ms',
            });
        }
    }
    return canonicalLeaseRecord(record);
}

function serializeR2LeaseRecord(record) {
    const canonical = validateR2LeaseRecord(record, { expectedKey: record?.key || null });
    return Buffer.from(JSON.stringify(canonical), 'utf8');
}

function parseR2LeaseRecord(body, { expectedKey = null } = {}) {
    let parsed;
    try {
        const text = Buffer.isBuffer(body)
            ? body.toString('utf8')
            : Buffer.from(body).toString('utf8');
        parsed = JSON.parse(text);
    } catch (cause) {
        throw new R2LeaseValidationError('Lease object is not valid UTF-8 JSON', {
            key: expectedKey,
            cause,
        });
    }
    return validateR2LeaseRecord(parsed, { expectedKey });
}

function activeLeaseRecord({ key, ownerId, generation, ttlMs, nowMs }) {
    return validateR2LeaseRecord({
        schema: R2_LEASE_SCHEMA,
        version: R2_LEASE_VERSION,
        key,
        state: 'active',
        owner_id: ownerId,
        generation,
        ttl_ms: ttlMs,
        acquired_at_ms: nowMs,
        renewed_at_ms: nowMs,
        expires_at_ms: nowMs + ttlMs,
        released_at_ms: null,
    }, { expectedKey: key });
}

function renewedLeaseRecord(record, { ttlMs, nowMs }) {
    return validateR2LeaseRecord({
        ...record,
        ttl_ms: ttlMs,
        renewed_at_ms: nowMs,
        expires_at_ms: nowMs + ttlMs,
    }, { expectedKey: record.key });
}

function releasedLeaseRecord(record, nowMs) {
    return validateR2LeaseRecord({
        ...record,
        state: 'released',
        expires_at_ms: nowMs,
        released_at_ms: nowMs,
    }, { expectedKey: record.key });
}

function leaseMetadata(record) {
    return {
        schema: R2_LEASE_SCHEMA,
        version: String(R2_LEASE_VERSION),
        state: record.state,
        owner: record.owner_id,
        generation: String(record.generation),
        expires_at_ms: String(record.expires_at_ms),
    };
}

function validateEtag(etag, key, ErrorClass = R2LeaseStorageError) {
    const normalized = typeof etag === 'string' ? etag.trim() : '';
    if (!normalized) {
        if (ErrorClass === R2LeaseHandleError) {
            throw new ErrorClass('Lease handle must contain a non-empty exact ETag', {
                key,
                field: 'etag',
            });
        }
        throw new ErrorClass('R2 lease operation returned no ETag', {
            key,
            operation: 'etag',
            cause: new Error('Missing ETag'),
        });
    }
    return normalized;
}

function leaseHandle(key, etag, record) {
    return Object.freeze({
        schema: R2_LEASE_HANDLE_SCHEMA,
        version: R2_LEASE_VERSION,
        key,
        ownerId: record.owner_id,
        generation: record.generation,
        state: record.state,
        ttlMs: record.ttl_ms,
        acquiredAtMs: record.acquired_at_ms,
        renewedAtMs: record.renewed_at_ms,
        expiresAtMs: record.expires_at_ms,
        releasedAtMs: record.released_at_ms,
        etag: validateEtag(etag, key),
    });
}

function validateLeaseHandle(handle) {
    if (!isPlainObject(handle)) {
        throw new R2LeaseHandleError('Lease handle must be a plain object');
    }
    const actualKeys = Object.keys(handle).sort();
    if (
        actualKeys.length !== LEASE_HANDLE_KEYS.length
        || actualKeys.some((key, index) => key !== LEASE_HANDLE_KEYS[index])
    ) {
        throw new R2LeaseHandleError('Lease handle fields do not match the versioned schema', {
            key: handle.key || null,
            field: 'handle',
        });
    }
    if (handle.schema !== R2_LEASE_HANDLE_SCHEMA || handle.version !== R2_LEASE_VERSION) {
        throw new R2LeaseHandleError('Lease handle schema or version is unsupported', {
            key: handle.key || null,
            field: 'schema',
        });
    }
    const key = validateLeaseKey(handle.key, R2LeaseHandleError);
    validateOwnerId(handle.ownerId, key, R2LeaseHandleError);
    if (!Number.isSafeInteger(handle.generation) || handle.generation < 1) {
        throw new R2LeaseHandleError('Lease handle generation must be a positive safe integer', {
            key,
            field: 'generation',
        });
    }
    if (handle.state !== 'active' && handle.state !== 'released') {
        throw new R2LeaseHandleError('Lease handle state is invalid', {
            key,
            field: 'state',
        });
    }
    validateTtlMs(handle.ttlMs, key, R2LeaseHandleError);
    assertSafeTimestamp(handle.acquiredAtMs, 'acquiredAtMs', key, R2LeaseHandleError);
    assertSafeTimestamp(handle.renewedAtMs, 'renewedAtMs', key, R2LeaseHandleError);
    assertSafeTimestamp(handle.expiresAtMs, 'expiresAtMs', key, R2LeaseHandleError);
    if (handle.renewedAtMs < handle.acquiredAtMs) {
        throw new R2LeaseHandleError('Lease handle renewedAtMs cannot precede acquiredAtMs', {
            key,
            field: 'renewedAtMs',
        });
    }
    if (handle.state === 'active') {
        if (handle.releasedAtMs !== null) {
            throw new R2LeaseHandleError('An active lease handle must have releasedAtMs = null', {
                key,
                field: 'releasedAtMs',
            });
        }
        if (handle.expiresAtMs !== handle.renewedAtMs + handle.ttlMs) {
            throw new R2LeaseHandleError('Active lease handle expiry is internally inconsistent', {
                key,
                field: 'expiresAtMs',
            });
        }
    } else {
        assertSafeTimestamp(handle.releasedAtMs, 'releasedAtMs', key, R2LeaseHandleError);
        if (handle.releasedAtMs < handle.renewedAtMs || handle.expiresAtMs !== handle.releasedAtMs) {
            throw new R2LeaseHandleError('Released lease handle timestamps are internally inconsistent', {
                key,
                field: 'releasedAtMs',
            });
        }
    }
    validateEtag(handle.etag, key, R2LeaseHandleError);
    return handle;
}

function normalizeAcquireAttempts(value) {
    if (
        !Number.isSafeInteger(value)
        || value < 1
        || value > MAX_R2_LEASE_ACQUIRE_ATTEMPTS
    ) {
        throw new RangeError(
            `maxAttempts must be an integer between 1 and ${MAX_R2_LEASE_ACQUIRE_ATTEMPTS}`
        );
    }
    return value;
}

function createR2LeaseManager({
    storage = null,
    clock = Date.now,
    defaultTtlMs = DEFAULT_R2_LEASE_TTL_MS,
    defaultAcquireAttempts = DEFAULT_R2_LEASE_ACQUIRE_ATTEMPTS,
} = {}) {
    const objectStore = storage || {
        get: getR2SmallObject,
        put: putR2SmallObjectConditional,
    };
    if (!objectStore || typeof objectStore.get !== 'function' || typeof objectStore.put !== 'function') {
        throw new TypeError('R2 lease manager requires storage.get and storage.put functions');
    }
    if (typeof clock !== 'function') throw new TypeError('R2 lease manager clock must be a function');
    validateTtlMs(defaultTtlMs, null);
    normalizeAcquireAttempts(defaultAcquireAttempts);

    function nowMs(key = null) {
        const value = Number(clock());
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new R2LeaseClockError('Lease clock must return a non-negative safe integer', {
                key,
                nowMs: value,
            });
        }
        return value;
    }

    async function readStoredLease(key) {
        let stored;
        try {
            stored = await objectStore.get(key, { maxBytes: R2_LEASE_RECORD_MAX_BYTES });
        } catch (cause) {
            if (isMissingR2ObjectError(cause)) return null;
            if (cause instanceof R2LeaseValidationError) throw cause;
            throw new R2LeaseStorageError(`Failed to read R2 lease: ${key}`, {
                key,
                operation: 'get',
                cause,
            });
        }
        if (stored === null || stored === undefined) return null;
        if (!isPlainObject(stored)) {
            throw new R2LeaseStorageError(`R2 lease read returned an invalid response: ${key}`, {
                key,
                operation: 'get',
                cause: new TypeError('Storage response must be an object'),
            });
        }
        if (
            !Buffer.isBuffer(stored.body)
            && !(stored.body instanceof Uint8Array)
            && typeof stored.body !== 'string'
        ) {
            throw new R2LeaseStorageError(`R2 lease read returned an invalid body: ${key}`, {
                key,
                operation: 'get',
                cause: new TypeError('Storage body must be a Buffer, Uint8Array, or string'),
            });
        }
        if (Buffer.byteLength(stored.body) > R2_LEASE_RECORD_MAX_BYTES) {
            throw new R2LeaseStorageError(`R2 lease object exceeded its hard size limit: ${key}`, {
                key,
                operation: 'get',
                cause: new RangeError(`Lease body exceeded ${R2_LEASE_RECORD_MAX_BYTES} bytes`),
            });
        }
        const etag = validateEtag(stored.etag, key);
        const record = parseR2LeaseRecord(stored.body, { expectedKey: key });
        return Object.freeze({ etag, record });
    }

    async function conditionalWrite(key, record, condition) {
        let result;
        try {
            result = await objectStore.put(key, serializeR2LeaseRecord(record), {
                ...condition,
                maxBytes: R2_LEASE_RECORD_MAX_BYTES,
                contentType: 'application/json',
                metadata: leaseMetadata(record),
            });
        } catch (cause) {
            if (isR2PreconditionFailedError(cause)) {
                return Object.freeze({ written: false, preconditionFailed: true });
            }
            throw new R2LeaseStorageError(`Failed to conditionally write R2 lease: ${key}`, {
                key,
                operation: 'put',
                cause,
            });
        }
        if (!isPlainObject(result)) {
            throw new R2LeaseStorageError(`R2 lease write returned an invalid response: ${key}`, {
                key,
                operation: 'put',
                cause: new TypeError('Storage response must be an object'),
            });
        }
        return Object.freeze({
            written: true,
            preconditionFailed: false,
            etag: validateEtag(result.etag, key),
        });
    }

    async function inspect({ key }) {
        validateLeaseKey(key);
        const stored = await readStoredLease(key);
        if (!stored) return Object.freeze({ state: 'missing', lease: null });
        const at = nowMs(key);
        const state = stored.record.state === 'active' && stored.record.expires_at_ms <= at
            ? 'stale'
            : stored.record.state;
        return Object.freeze({
            state,
            lease: leaseHandle(key, stored.etag, stored.record),
        });
    }

    async function acquire({
        key,
        ownerId,
        ttlMs = defaultTtlMs,
        maxAttempts = defaultAcquireAttempts,
    }) {
        validateLeaseKey(key);
        validateOwnerId(ownerId, key);
        validateTtlMs(ttlMs, key);
        normalizeAcquireAttempts(maxAttempts);

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const current = await readStoredLease(key);
            const at = nowMs(key);

            if (current && current.record.state === 'active' && current.record.expires_at_ms > at) {
                return Object.freeze({
                    acquired: false,
                    reason: 'held',
                    attempts: attempt,
                    holder: Object.freeze({
                        ownerId: current.record.owner_id,
                        generation: current.record.generation,
                        expiresAtMs: current.record.expires_at_ms,
                    }),
                });
            }

            const generation = current ? current.record.generation + 1 : 1;
            if (!Number.isSafeInteger(generation)) {
                throw new R2LeaseValidationError('Lease generation exhausted the safe integer range', {
                    key,
                    field: 'generation',
                });
            }
            const next = activeLeaseRecord({ key, ownerId, generation, ttlMs, nowMs: at });
            const write = await conditionalWrite(
                key,
                next,
                current ? { ifMatch: current.etag } : { ifNoneMatch: '*' }
            );
            if (write.written) {
                return Object.freeze({
                    acquired: true,
                    reason: current ? (current.record.state === 'released' ? 'released' : 'stale') : 'created',
                    attempts: attempt,
                    lease: leaseHandle(key, write.etag, next),
                });
            }
        }

        return Object.freeze({
            acquired: false,
            reason: 'contention',
            attempts: maxAttempts,
            holder: null,
        });
    }

    function assertCallerOwnsHandle(lease, ownerId) {
        validateLeaseHandle(lease);
        validateOwnerId(ownerId, lease.key, R2LeaseHandleError);
        if (lease.ownerId !== ownerId) {
            throw new R2LeaseLostError('Lease handle belongs to a different owner', {
                key: lease.key,
                ownerId,
                generation: lease.generation,
                reason: 'owner-mismatch',
            });
        }
        if (lease.state !== 'active') {
            throw new R2LeaseLostError('Lease handle is not active', {
                key: lease.key,
                ownerId,
                generation: lease.generation,
                reason: 'not-active',
            });
        }
    }

    function assertStoredLeaseMatchesHandle(stored, lease, ownerId, at) {
        if (!stored) {
            throw new R2LeaseLostError('Lease object no longer exists', {
                key: lease.key,
                ownerId,
                generation: lease.generation,
                reason: 'missing',
            });
        }
        const record = stored.record;
        if (
            stored.etag !== lease.etag
            || record.owner_id !== ownerId
            || record.generation !== lease.generation
            || record.state !== 'active'
        ) {
            throw new R2LeaseLostError('Lease ownership or ETag no longer matches', {
                key: lease.key,
                ownerId,
                generation: lease.generation,
                reason: 'superseded',
            });
        }
        if (record.expires_at_ms <= at) {
            throw new R2LeaseLostError('Lease expired before the operation completed', {
                key: lease.key,
                ownerId,
                generation: lease.generation,
                reason: 'expired',
            });
        }
        if (at < record.renewed_at_ms) {
            throw new R2LeaseClockError('Lease clock moved backwards', {
                key: lease.key,
                nowMs: at,
                priorMs: record.renewed_at_ms,
            });
        }
        return record;
    }

    async function heartbeat({ lease, ownerId, ttlMs = null }) {
        assertCallerOwnsHandle(lease, ownerId);
        const renewedTtlMs = ttlMs === null ? lease.ttlMs : ttlMs;
        validateTtlMs(renewedTtlMs, lease.key);

        const stored = await readStoredLease(lease.key);
        const at = nowMs(lease.key);
        const current = assertStoredLeaseMatchesHandle(stored, lease, ownerId, at);
        const next = renewedLeaseRecord(current, { ttlMs: renewedTtlMs, nowMs: at });
        const write = await conditionalWrite(lease.key, next, { ifMatch: stored.etag });
        if (!write.written) {
            throw new R2LeaseLostError('Lease changed during heartbeat', {
                key: lease.key,
                ownerId,
                generation: lease.generation,
                reason: 'compare-and-swap-failed',
            });
        }
        return leaseHandle(lease.key, write.etag, next);
    }

    async function release({ lease, ownerId }) {
        assertCallerOwnsHandle(lease, ownerId);
        const stored = await readStoredLease(lease.key);
        const at = nowMs(lease.key);
        const current = assertStoredLeaseMatchesHandle(stored, lease, ownerId, at);
        const next = releasedLeaseRecord(current, at);
        const write = await conditionalWrite(lease.key, next, { ifMatch: stored.etag });
        if (!write.written) {
            throw new R2LeaseLostError('Lease changed during release', {
                key: lease.key,
                ownerId,
                generation: lease.generation,
                reason: 'compare-and-swap-failed',
            });
        }
        return leaseHandle(lease.key, write.etag, next);
    }

    return Object.freeze({
        acquire,
        heartbeat,
        release,
        inspect,
    });
}

const defaultR2LeaseManager = createR2LeaseManager();

async function acquireR2Lease(options) {
    return defaultR2LeaseManager.acquire(options);
}

async function heartbeatR2Lease(options) {
    return defaultR2LeaseManager.heartbeat(options);
}

async function releaseR2Lease(options) {
    return defaultR2LeaseManager.release(options);
}

async function inspectR2Lease(options) {
    return defaultR2LeaseManager.inspect(options);
}

module.exports = {
    R2_LEASE_SCHEMA,
    R2_LEASE_VERSION,
    R2_LEASE_HANDLE_SCHEMA,
    R2_LEASE_RECORD_MAX_BYTES,
    MIN_R2_LEASE_TTL_MS,
    MAX_R2_LEASE_TTL_MS,
    DEFAULT_R2_LEASE_TTL_MS,
    DEFAULT_R2_LEASE_ACQUIRE_ATTEMPTS,
    MAX_R2_LEASE_ACQUIRE_ATTEMPTS,
    R2_LEASE_ERROR_CODES,
    R2LeaseError,
    R2LeaseValidationError,
    R2LeaseHandleError,
    R2LeaseLostError,
    R2LeaseStorageError,
    R2LeaseClockError,
    validateR2LeaseRecord,
    serializeR2LeaseRecord,
    parseR2LeaseRecord,
    createR2LeaseManager,
    acquireR2Lease,
    heartbeatR2Lease,
    releaseR2Lease,
    inspectR2Lease,
};
