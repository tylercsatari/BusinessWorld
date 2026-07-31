'use strict';

const {
    canonicalJsonBytes,
    sha256Bytes,
} = require('./canonical-json-artifact');

const REQUEST_FINGERPRINT_SCHEMA =
    'business-world.quant-job-request-fingerprint';
const REQUEST_FINGERPRINT_VERSION = 1;
const REQUEST_REUSE_TTL_MS = 20 * 60 * 1000;

function normalizeRequestId(value) {
    return String(value || '')
        .replace(/[^a-z0-9_-]/gi, '')
        .slice(0, 96);
}

function normalizeNamespace(value) {
    return value === 'shorts' ? 'shorts' : 'longform';
}

function sha256Buffer(value) {
    if (Buffer.isBuffer(value)) return sha256Bytes(value);
    if (value instanceof Uint8Array) {
        return sha256Bytes(Buffer.from(value));
    }
    throw new TypeError(
        'quant job byte identity requires a Buffer or Uint8Array'
    );
}

function requestFingerprint({
    kind,
    namespace,
    input,
    scorer,
}) {
    const normalizedKind = String(kind || '').trim();
    if (!normalizedKind) {
        throw new TypeError('quant job kind is required');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('quant job input identity must be an object');
    }
    if (!scorer || typeof scorer !== 'object' || Array.isArray(scorer)) {
        throw new TypeError('quant job scorer identity must be an object');
    }
    return sha256Bytes(canonicalJsonBytes({
        schema: REQUEST_FINGERPRINT_SCHEMA,
        version: REQUEST_FINGERPRINT_VERSION,
        namespace: normalizeNamespace(namespace),
        kind: normalizedKind,
        input,
        scorer,
    }));
}

function reusableJobId(
    prior,
    fingerprint,
    now = Date.now(),
    ttlMs = REQUEST_REUSE_TTL_MS
) {
    if (
        !prior
        || typeof prior !== 'object'
        || typeof prior.jid !== 'string'
        || !prior.jid
        || typeof prior.requestFingerprint !== 'string'
        || prior.requestFingerprint !== fingerprint
        || !Number.isFinite(Number(prior.ts))
        || now - Number(prior.ts) >= ttlMs
    ) {
        return '';
    }
    return prior.jid;
}

module.exports = Object.freeze({
    REQUEST_FINGERPRINT_SCHEMA,
    REQUEST_FINGERPRINT_VERSION,
    REQUEST_REUSE_TTL_MS,
    normalizeNamespace,
    normalizeRequestId,
    requestFingerprint,
    reusableJobId,
    sha256Buffer,
});
