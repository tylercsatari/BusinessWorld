#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    createR2JsonCasMutator,
} = require('../buildings/jarvis/r2-json-cas');
const {
    canonicalJsonBytes,
} = require('../buildings/jarvis/canonical-json-artifact');

class Missing extends Error {}
class Precondition extends Error {}

function memoryStorage() {
    let body = null;
    let revision = 0;
    let injectConflict = false;
    let writes = 0;
    return {
        conflictOnce() {
            injectConflict = true;
        },
        async get(key, options = {}) {
            if (!body) throw new Missing(key);
            const etag = `"${revision}"`;
            if (options.ifMatch && options.ifMatch !== etag) {
                throw new Precondition(key);
            }
            return {
                key,
                body: Buffer.from(body),
                etag,
            };
        },
        async put(key, next, options = {}) {
            const etag = body ? `"${revision}"` : null;
            if (
                (options.ifNoneMatch === '*' && body)
                || (options.ifMatch && options.ifMatch !== etag)
            ) {
                throw new Precondition(key);
            }
            if (injectConflict) {
                injectConflict = false;
                const current = body
                    ? JSON.parse(body.toString('utf8'))
                    : { rows: [] };
                current.rows.push('concurrent');
                body = Buffer.from(JSON.stringify(current));
                revision += 1;
                throw new Precondition(key);
            }
            body = Buffer.from(next);
            revision += 1;
            writes += 1;
            return { key, etag: `"${revision}"` };
        },
        isMissing(error) {
            return error instanceof Missing;
        },
        isPreconditionFailed(error) {
            return error instanceof Precondition;
        },
        value() {
            return body && JSON.parse(body.toString('utf8'));
        },
        bytes() {
            return body && Buffer.from(body);
        },
        writeCount() {
            return writes;
        },
    };
}

function validator(value) {
    return {
        valid: !!value
            && Array.isArray(value.rows)
            && new Set(value.rows).size === value.rows.length,
        errors: ['rows must be a unique array'],
    };
}

async function main() {
    const storage = memoryStorage();
    const index = createR2JsonCasMutator({
        key: 'index.json',
        storage,
        emptyValue: () => ({ rows: [] }),
        validate: validator,
        bind: value => ({
            rows: value.rows.slice().sort(),
        }),
        label: 'test index',
    });

    await Promise.all([
        index.mutate(value => {
            value.rows.push('first');
        }),
        index.mutate(value => {
            value.rows.push('second');
        }),
    ]);
    storage.conflictOnce();
    await index.mutate(value => {
        value.rows.push('third');
    });

    assert.deepStrictEqual(storage.value(), {
        rows: ['concurrent', 'first', 'second', 'third'],
    });
    assert.deepStrictEqual(
        (await index.readRevision()).value,
        storage.value()
    );
    assert(
        storage.bytes().equals(canonicalJsonBytes(storage.value())),
        'the default CAS serializer did not persist canonical JSON bytes'
    );
    const writesBeforeNoop = storage.writeCount();
    await index.mutate(value => value);
    assert.strictEqual(
        storage.writeCount(),
        writesBeforeNoop,
        'a byte-identical CAS mutation created a redundant revision'
    );

    process.stdout.write(JSON.stringify({
        ok: true,
        rows: storage.value().rows.length,
        conflictRetryPreservedConcurrentMutation: true,
        exactReadAfterWriteVerified: true,
        canonicalBytes: true,
        byteIdenticalNoop: true,
    }) + '\n');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
