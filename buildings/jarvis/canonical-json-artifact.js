'use strict';

const crypto = require('crypto');
const {
    canonicalJson,
} = require('./shorts-score-ledger');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function canonicalJsonBytes(value) {
    return Buffer.from(canonicalJson(value), 'utf8');
}

function sha256Bytes(value) {
    return crypto
        .createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : Buffer.from(value))
        .digest('hex');
}

function canonicalArtifactIdentity(value) {
    const bytes = canonicalJsonBytes(value);
    return {
        bytes,
        sha256: sha256Bytes(bytes),
        byte_length: bytes.length,
    };
}

function exactSha256(value) {
    return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function contentAddressedDigest(key) {
    const leaf = String(key || '').split('/').pop() || '';
    const match = leaf.match(/^([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i);
    return match ? match[1].toLowerCase() : null;
}

function validateArtifactReference(reference, options = {}) {
    const errors = [];
    const label = options.label || 'artifact';
    if (
        !reference
        || typeof reference !== 'object'
        || Array.isArray(reference)
    ) {
        return [`${label} reference is missing`];
    }
    if (!String(reference.key || '').trim()) {
        errors.push(`${label} key is missing`);
    }
    if (!exactSha256(reference.sha256)) {
        errors.push(`${label} SHA-256 is invalid`);
    }
    if (
        !Number.isSafeInteger(reference.byte_length)
        || reference.byte_length < 0
    ) {
        errors.push(`${label} byte length is invalid`);
    }
    if (!String(reference.media_type || '').trim()) {
        errors.push(`${label} media type is missing`);
    }
    if (options.requireContentAddressedKey !== false) {
        const digest = contentAddressedDigest(reference.key);
        if (!digest || digest !== reference.sha256) {
            errors.push(`${label} key is not addressed by its exact byte hash`);
        }
    }
    return errors;
}

function assertExactArtifactBytes(bytes, reference, options = {}) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const errors = validateArtifactReference(reference, options);
    const label = options.label || 'artifact';
    if (
        reference
        && typeof reference === 'object'
        && !Array.isArray(reference)
        && (
            buffer.length !== reference.byte_length
            || sha256Bytes(buffer) !== reference.sha256
        )
    ) {
        errors.push(`${label} bytes differ from the recorded identity`);
    }
    if (options.canonicalJsonValue !== undefined) {
        const expected = canonicalJsonBytes(options.canonicalJsonValue);
        if (!buffer.equals(expected)) {
            errors.push(`${label} bytes are not the exact canonical JSON`);
        }
    }
    if (errors.length) throw new Error([...new Set(errors)].join('; '));
    return buffer;
}

module.exports = {
    SHA256_PATTERN,
    assertExactArtifactBytes,
    canonicalArtifactIdentity,
    canonicalJsonBytes,
    contentAddressedDigest,
    exactSha256,
    sha256Bytes,
    validateArtifactReference,
};
