'use strict';

const {
    canonicalJsonBytes,
} = require('./canonical-json-artifact');

function jsonBuffer(value) {
    return canonicalJsonBytes(value);
}

function validationErrors(result) {
    if (result === true || result == null) return [];
    if (result === false) return ['validation returned false'];
    if (result.valid === true) return [];
    if (Array.isArray(result.errors) && result.errors.length) {
        return result.errors.map(String);
    }
    return ['validation did not return a valid result'];
}

function assertValid(value, validate, label) {
    if (typeof validate !== 'function') return;
    const errors = validationErrors(validate(value));
    if (errors.length) {
        throw new Error(`${label}: ${errors.join('; ')}`);
    }
}

function createR2JsonCasMutator({
    key,
    storage,
    emptyValue,
    validate,
    bind = value => value,
    serialize = jsonBuffer,
    parse = bytes => JSON.parse(bytes.toString('utf8')),
    maxAttempts = 8,
    contentType = 'application/json',
    label = key,
} = {}) {
    if (typeof key !== 'string' || !key) {
        throw new TypeError('R2 JSON CAS key must be a non-empty string');
    }
    if (
        !storage
        || typeof storage.get !== 'function'
        || typeof storage.put !== 'function'
        || typeof storage.isMissing !== 'function'
        || typeof storage.isPreconditionFailed !== 'function'
    ) {
        throw new TypeError(
            'R2 JSON CAS storage requires get, put, isMissing, and '
                + 'isPreconditionFailed'
        );
    }
    if (typeof emptyValue !== 'function') {
        throw new TypeError('R2 JSON CAS emptyValue must be a function');
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new RangeError('R2 JSON CAS maxAttempts must be positive');
    }

    let queue = Promise.resolve();

    async function readRevision() {
        try {
            const revision = await storage.get(key);
            return {
                revision,
                value: parse(revision.body),
            };
        } catch (error) {
            if (!storage.isMissing(error)) throw error;
            return {
                revision: null,
                value: emptyValue(),
            };
        }
    }

    function mutate(mutator) {
        if (typeof mutator !== 'function') {
            return Promise.reject(
                new TypeError('R2 JSON CAS mutator must be a function')
            );
        }
        const operation = queue
            .catch(() => {})
            .then(async () => {
                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    const { revision, value } = await readRevision();
                    assertValid(
                        value,
                        validate,
                        `${label} current value is invalid`
                    );
                    const mutationResult = await mutator(value, {
                        attempt,
                        etag: revision && revision.etag || null,
                        exists: !!revision,
                    });
                    if (mutationResult === null) return value;
                    const candidate = mutationResult === undefined
                        ? value
                        : mutationResult;
                    const next = await bind(candidate);
                    assertValid(
                        next,
                        validate,
                        `${label} next value is invalid`
                    );
                    const bytes = serialize(next);
                    if (!Buffer.isBuffer(bytes) || !bytes.length) {
                        throw new Error(
                            `${label} serializer returned no bytes`
                        );
                    }
                    if (
                        revision
                        && Buffer.isBuffer(revision.body)
                        && revision.body.equals(bytes)
                    ) {
                        return next;
                    }

                    let written;
                    try {
                        written = await storage.put(key, bytes, {
                            ...(revision
                                ? { ifMatch: revision.etag }
                                : { ifNoneMatch: '*' }),
                            contentType,
                        });
                    } catch (error) {
                        if (storage.isPreconditionFailed(error)) continue;
                        throw error;
                    }
                    if (!written || !written.etag) {
                        throw new Error(
                            `${label} conditional write returned no ETag`
                        );
                    }

                    let verified;
                    try {
                        verified = await storage.get(key, {
                            ifMatch: written.etag,
                        });
                    } catch (error) {
                        if (storage.isPreconditionFailed(error)) {
                            // A compliant later writer could only advance from
                            // this exact ETag after observing this mutation.
                            return next;
                        }
                        throw error;
                    }
                    if (
                        verified.etag !== written.etag
                        || !verified.body.equals(bytes)
                    ) {
                        throw new Error(
                            `${label} failed exact read-after-write verification`
                        );
                    }
                    return next;
                }
                throw new Error(
                    `${label} stayed contended after ${maxAttempts} CAS attempts`
                );
            });
        queue = operation.catch(() => {});
        return operation;
    }

    return Object.freeze({
        key,
        mutate,
        readRevision,
    });
}

module.exports = {
    createR2JsonCasMutator,
    jsonBuffer,
};
