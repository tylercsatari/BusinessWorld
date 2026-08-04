#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
    canonicalJsonBytes,
    contentAddressedDigest,
    sha256Bytes,
} = require('../buildings/jarvis/canonical-json-artifact');
const {
    archiveKey,
    immutablePut,
    verifiedReplace,
} = require('./migrate-saved-channel-score-ledgers');

class Missing extends Error {}
class Precondition extends Error {}

class MemoryProvider {
    constructor(seed = {}) {
        this.objects = new Map(
            Object.entries(seed).map(([key, bytes]) => [
                key,
                Buffer.from(bytes),
            ])
        );
        this.revisions = new Map(
            [...this.objects.keys()].map(key => [key, 1])
        );
        this.writes = [];
    }

    async downloadFromR2(key) {
        const bytes = this.objects.get(key);
        return bytes ? Buffer.from(bytes) : null;
    }

    async getR2SmallObject(key, options = {}) {
        if (!this.objects.has(key)) throw new Missing(key);
        const etag = `"${this.revisions.get(key)}"`;
        if (options.ifMatch && options.ifMatch !== etag) {
            throw new Precondition(key);
        }
        return {
            key,
            body: Buffer.from(this.objects.get(key)),
            etag,
        };
    }

    async putR2SmallObjectConditional(key, bytes, options = {}) {
        const exists = this.objects.has(key);
        const currentEtag = exists
            ? `"${this.revisions.get(key)}"`
            : null;
        if (
            (options.ifNoneMatch === '*' && exists)
            || (
                options.ifMatch
                && options.ifMatch !== currentEtag
            )
        ) {
            throw new Precondition(key);
        }
        const next = Buffer.from(bytes);
        this.objects.set(key, next);
        const revision = (this.revisions.get(key) || 0) + 1;
        this.revisions.set(key, revision);
        this.writes.push({ key, bytes: Buffer.from(next) });
        return { key, etag: `"${revision}"` };
    }

    isMissingR2ObjectError(error) {
        return error instanceof Missing;
    }

    isR2PreconditionFailedError(error) {
        return error instanceof Precondition;
    }
}

async function main() {
    const canonicalRecord = {
        z: 'last in source order',
        a: {
            score_record_sha256: 'semantic-binding-only',
        },
    };
    const bytes = canonicalJsonBytes(canonicalRecord);
    const key = archiveKey('canonical-records', bytes);
    assert.strictEqual(
        contentAddressedDigest(key),
        sha256Bytes(bytes),
        'archive key does not bind exact canonical bytes'
    );

    const provider = new MemoryProvider();
    assert.strictEqual(
        await immutablePut(
            key,
            bytes,
            'application/json',
            provider,
            true
        ),
        'written-and-verified'
    );
    assert.strictEqual(
        await immutablePut(
            key,
            bytes,
            'application/json',
            provider,
            true
        ),
        'verified-existing'
    );
    assert.strictEqual(
        provider.writes.length,
        1,
        'idempotent immutable archive issued a duplicate write'
    );
    await assert.rejects(
        () => immutablePut(
            `${key.slice(0, -69)}${'f'.repeat(64)}.json`,
            bytes,
            'application/json',
            provider,
            true
        ),
        /does not bind exact bytes/
    );

    const mutableKey =
        'raw/saved-channels/ch0000000000000001/videos/abcdefghijk.json';
    const source = Buffer.from('{"legacy":true}', 'utf8');
    const next = canonicalJsonBytes({
        schema: 'saved-channel-video-v1',
        legacy: false,
    });
    const mutableProvider = new MemoryProvider({
        [mutableKey]: source,
    });
    assert.strictEqual(
        await verifiedReplace(
            mutableKey,
            source,
            next,
            'application/json',
            mutableProvider
        ),
        'replaced-and-verified'
    );
    const writesAfterReplace = mutableProvider.writes.length;
    assert.strictEqual(
        await verifiedReplace(
            mutableKey,
            next,
            next,
            'application/json',
            mutableProvider
        ),
        'verified-existing'
    );
    assert.strictEqual(
        mutableProvider.writes.length,
        writesAfterReplace,
        'byte-identical mutable replacement issued a duplicate write'
    );
    await assert.rejects(
        () => verifiedReplace(
            mutableKey,
            source,
            canonicalJsonBytes({ changed: true }),
            'application/json',
            mutableProvider
        ),
        /changed during migration/
    );

    process.stdout.write(`${JSON.stringify({
        ok: true,
        exactCanonicalArchive: true,
        immutableCreateOnly: true,
        conditionalMutableReplacement: true,
        idempotent: true,
    })}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
