#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    INDEX_SCHEMA,
    INDEX_VERSION,
    INDEX_KEY,
    SCORE_AUTHORITY,
    buildSavedChannelIndex,
    canonicalIndexArtifactIdentity,
    canonicalIndexBytes,
    sha256Bytes,
    validateSavedChannelIndex,
} = require('../buildings/jarvis/saved-channel-index-contract');
const {
    rebuildSavedChannelIndex,
} = require('./rebuild-saved-channel-index');

function artifact(id, updatedAt, overrides = {}) {
    const manifest = {
        version: 1,
        id,
        url: `https://www.youtube.com/@${id}`,
        name: `Channel ${id}`,
        status: 'running',
        phase: 'scoring',
        createdAt: 1000,
        updatedAt,
        discovered: 3,
        completed: 1,
        failed: 1,
        integrityFailures: 0,
        queued: 1,
        current: {
            id: 'abcdefghijk',
            title: 'Current video',
            number: 2,
        },
        error: null,
        videos: [
            {
                id: 'abcdefghijk',
                status: 'done',
                score_ledger: {
                    values: [91.5, 88000000],
                    ledger_sha256: 'a'.repeat(64),
                },
            },
            { id: 'lmnopqrstuv', status: 'error' },
            { id: 'wxyzABCDEFG', status: 'queued' },
        ],
        ...overrides,
    };
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    return {
        key: `raw/saved-channels/${id}/manifest.json`,
        manifest,
        bytes,
    };
}

function collectNumericLeaves(value, path = '', output = []) {
    if (typeof value === 'number') {
        output.push(path);
    } else if (Array.isArray(value)) {
        value.forEach((item, index) => (
            collectNumericLeaves(item, `${path}[${index}]`, output)
        ));
    } else if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, item]) => (
            collectNumericLeaves(
                item,
                path ? `${path}.${key}` : key,
                output
            )
        ));
    }
    return output;
}

async function main() {
    const first = artifact('ch0000000000000001', 2000);
    const second = artifact('ch0000000000000002', 3000);
    const index = buildSavedChannelIndex(
        [first, second],
        { updatedAt: 4000 }
    );
    assert.strictEqual(index.schema, INDEX_SCHEMA);
    assert.strictEqual(index.version, INDEX_VERSION);
    assert.deepStrictEqual(index.authority, SCORE_AUTHORITY);
    assert.deepStrictEqual(
        index.channels.map(channel => channel.id),
        ['ch0000000000000002', 'ch0000000000000001']
    );
    assert.strictEqual(
        index.channels[1].manifestSha256,
        sha256Bytes(first.bytes)
    );
    assert.strictEqual(
        index.channels[1].manifestBytes,
        first.bytes.length
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            index.channels[0],
            'score_ledger'
        ),
        false
    );
    assert.strictEqual(
        JSON.stringify(index).includes('88000000'),
        false,
        'manifest score values leaked into the navigation index'
    );
    assert.deepStrictEqual(
        collectNumericLeaves(index).sort(),
        [
            'channels[0].completed',
            'channels[0].createdAt',
            'channels[0].current.number',
            'channels[0].discovered',
            'channels[0].failed',
            'channels[0].integrityFailures',
            'channels[0].manifestBytes',
            'channels[0].queued',
            'channels[0].updatedAt',
            'channels[1].completed',
            'channels[1].createdAt',
            'channels[1].current.number',
            'channels[1].discovered',
            'channels[1].failed',
            'channels[1].integrityFailures',
            'channels[1].manifestBytes',
            'channels[1].queued',
            'channels[1].updatedAt',
            'updatedAt',
            'version',
        ].sort(),
        'only navigation metadata may be numeric'
    );
    assert(validateSavedChannelIndex(index).valid);
    assert(
        canonicalIndexBytes(
            buildSavedChannelIndex([first, second])
        ).equals(
            canonicalIndexBytes(
                buildSavedChannelIndex([first, second])
            )
        ),
        'default index rebuild is not deterministic'
    );
    assert.deepStrictEqual(
        JSON.parse(canonicalIndexBytes(index).toString('utf8')),
        index
    );

    const tampered = JSON.parse(JSON.stringify(index));
    tampered.channels[0].completed += 1;
    assert.strictEqual(
        validateSavedChannelIndex(tampered).valid,
        false,
        'payload mutation must invalidate the hash'
    );
    const scoreInjection = JSON.parse(JSON.stringify(index));
    scoreInjection.channels[0].predictedKeep = 91.5;
    assert(
        validateSavedChannelIndex(scoreInjection).errors.some(
            error => /non-canonical fields/.test(error)
        ),
        'score-like fields must be rejected by the strict allowlist'
    );
    assert.throws(
        () => buildSavedChannelIndex(
            [first, { ...first }],
            { updatedAt: 4000 }
        ),
        /Duplicate saved-channel IDs/
    );
    const duplicate = JSON.parse(JSON.stringify(index));
    duplicate.channels[1] = {
        ...duplicate.channels[0],
    };
    duplicate.payloadSha256 = sha256Bytes(Buffer.from('synthetic'));
    const duplicateValidation =
        validateSavedChannelIndex(duplicate);
    assert(
        duplicateValidation.errors.some(
            error => /duplicate channel IDs/.test(error)
        )
    );
    assert.doesNotThrow(() => {
        const malformed = {
            ...index,
            channels: [null],
        };
        assert.strictEqual(
            validateSavedChannelIndex(malformed).valid,
            false
        );
    });

    class Missing extends Error {}
    class Precondition extends Error {}

    class FakeStorage {
        constructor(artifacts) {
            this.objects = new Map(
                artifacts.map(item => [item.key, item.bytes])
            );
            this.objects.set(INDEX_KEY, Buffer.from('{"legacy":true}'));
            this.objects.set(
                'raw/saved-channels/indexes/by-payload-sha256/old.json',
                Buffer.from('{}')
            );
            this.writes = [];
            this.mutateManifestAfterIndexWriteOnce = false;
            this.revisions = new Map(
                [...this.objects.keys()].map(key => [key, 1])
            );
            this.savedChannelCasStorage = {
                get: async (key, options = {}) => {
                    if (!this.objects.has(key)) throw new Missing(key);
                    const etag = `"${this.revisions.get(key)}"`;
                    if (
                        options.ifMatch
                        && options.ifMatch !== etag
                    ) {
                        throw new Precondition(key);
                    }
                    return {
                        key,
                        body: Buffer.from(this.objects.get(key)),
                        etag,
                    };
                },
                put: async (key, bytes, options = {}) => {
                    const exists = this.objects.has(key);
                    const etag = exists
                        ? `"${this.revisions.get(key)}"`
                        : null;
                    if (
                        (options.ifNoneMatch === '*' && exists)
                        || (
                            options.ifMatch
                            && options.ifMatch !== etag
                        )
                    ) {
                        throw new Precondition(key);
                    }
                    const copy = Buffer.from(bytes);
                    this.objects.set(key, copy);
                    const revision =
                        (this.revisions.get(key) || 0) + 1;
                    this.revisions.set(key, revision);
                    this.writes.push({ key, bytes: copy });
                    if (
                        this.mutateManifestAfterIndexWriteOnce
                        && key === INDEX_KEY
                    ) {
                        const manifestKey = [...this.objects.keys()]
                            .filter(candidate => (
                                /\/manifest\.json$/.test(candidate)
                            ))
                            .sort()[0];
                        const manifest = JSON.parse(
                            this.objects.get(manifestKey)
                                .toString('utf8')
                        );
                        manifest.updatedAt =
                            Number(manifest.updatedAt || 0) + 1;
                        this.objects.set(
                            manifestKey,
                            Buffer.from(JSON.stringify(manifest))
                        );
                        this.revisions.set(
                            manifestKey,
                            (this.revisions.get(manifestKey) || 0)
                                + 1
                        );
                        this.mutateManifestAfterIndexWriteOnce =
                            false;
                    }
                    return { key, etag: `"${revision}"` };
                },
                isMissing: error => error instanceof Missing,
                isPreconditionFailed: error =>
                    error instanceof Precondition,
            };
        }

        async listR2Keys() {
            return [...this.objects.keys()];
        }

        async downloadFromR2(key) {
            const value = this.objects.get(key);
            return value ? Buffer.from(value) : null;
        }

        async uploadToR2(key, bytes) {
            const copy = Buffer.from(bytes);
            this.objects.set(key, copy);
            this.writes.push({ key, bytes: copy });
        }
    }

    const dryStorage = new FakeStorage([first, second]);
    const dry = await rebuildSavedChannelIndex(dryStorage, {
        updatedAt: 5000,
        write: false,
    });
    assert.strictEqual(dry.result.manifestCount, 2);
    assert.strictEqual(dry.result.wrote, false);
    assert.strictEqual(dryStorage.writes.length, 0);

    const writeStorage = new FakeStorage([first, second]);
    const written = await rebuildSavedChannelIndex(writeStorage, {
        updatedAt: 5000,
        write: true,
    });
    assert.strictEqual(written.result.wrote, true);
    assert.strictEqual(
        written.result.readAfterWriteVerified,
        true
    );
    assert.strictEqual(writeStorage.writes.length, 2);
    assert.match(
        writeStorage.writes[0].key,
        /^raw\/saved-channels\/indexes\/by-artifact-sha256\/[a-f0-9]{64}\.json$/
    );
    assert.strictEqual(
        writeStorage.writes[0].key,
        `raw/saved-channels/indexes/by-artifact-sha256/${
            canonicalIndexArtifactIdentity(written.index).sha256
        }.json`
    );
    assert.strictEqual(writeStorage.writes[1].key, INDEX_KEY);
    assert(
        writeStorage.writes[0].bytes.equals(
            writeStorage.writes[1].bytes
        )
    );
    const readback = JSON.parse(
        writeStorage.objects.get(INDEX_KEY).toString('utf8')
    );
    assert(validateSavedChannelIndex(readback).valid);

    const racedStorage = new FakeStorage([first, second]);
    racedStorage.mutateManifestAfterIndexWriteOnce = true;
    const raced = await rebuildSavedChannelIndex(
        racedStorage,
        {
            updatedAt: 5000,
            write: true,
        }
    );
    assert.strictEqual(raced.result.attempts, 2);
    assert.strictEqual(
        racedStorage.writes.filter(
            item => item.key === INDEX_KEY
        ).length,
        2
    );
    assert(
        racedStorage.objects.get(INDEX_KEY).equals(
            canonicalIndexBytes(raced.index)
        )
    );

    const writesBeforeRepeat = writeStorage.writes.length;
    const repeated = await rebuildSavedChannelIndex(
        writeStorage,
        {
            updatedAt: 5000,
            write: true,
        }
    );
    assert.strictEqual(
        writeStorage.writes.length,
        writesBeforeRepeat,
        'idempotent rebuild created new archive or pointer revisions'
    );
    assert.strictEqual(
        repeated.result.archiveDisposition,
        'verified-existing'
    );

    const collisionStorage = new FakeStorage([first, second]);
    const collisionDry = await rebuildSavedChannelIndex(
        collisionStorage,
        {
            updatedAt: 5000,
            write: false,
        }
    );
    collisionStorage.objects.set(
        collisionDry.result.archiveKey,
        Buffer.from('{"wrong":true}', 'utf8')
    );
    collisionStorage.revisions.set(
        collisionDry.result.archiveKey,
        1
    );
    await assert.rejects(
        () => rebuildSavedChannelIndex(
            collisionStorage,
            {
                updatedAt: 5000,
                write: true,
            }
        ),
        /Immutable index collision/,
        'immutable archive collision was overwritten'
    );

    process.stdout.write(JSON.stringify({
        ok: true,
        schema: index.schema,
        channels: index.channels.length,
        payloadSha256: index.payloadSha256,
        migrationWrites: writeStorage.writes.length,
        exactArtifactArchive: true,
        idempotentRebuild: true,
        postWriteManifestRaceRetried: true,
    }) + '\n');
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
