#!/usr/bin/env node
'use strict';

const cloud = require('../cloud-storage');
const {
    loadProjectEnvironment,
} = require('./load-project-environment');
const {
    INDEX_SCHEMA,
    INDEX_KEY,
    buildSavedChannelIndex,
    canonicalIndexArtifactIdentity,
    canonicalIndexBytes,
    isCanonicalManifestKey,
    validateSavedChannelIndex,
} = require('../buildings/jarvis/saved-channel-index-contract');
const {
    createR2JsonCasMutator,
} = require('../buildings/jarvis/r2-json-cas');

const CHANNEL_ROOT = 'raw/saved-channels/';
const INDEX_ARCHIVE_ROOT =
    `${CHANNEL_ROOT}indexes/by-artifact-sha256/`;

function parseJsonBuffer(bytes, key) {
    try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || Array.isArray(value) || typeof value !== 'object') {
            throw new Error('root is not an object');
        }
        return value;
    } catch (error) {
        throw new Error(
            `Canonical manifest ${key} is invalid JSON: ${error.message}`
        );
    }
}

async function loadCanonicalManifestArtifacts(storage) {
    const keys = (await storage.listR2Keys(CHANNEL_ROOT))
        .filter(isCanonicalManifestKey)
        .sort();
    const artifacts = [];
    for (const key of keys) {
        const bytes = await storage.downloadFromR2(key);
        if (!Buffer.isBuffer(bytes) || !bytes.length) {
            throw new Error(`Canonical manifest disappeared: ${key}`);
        }
        artifacts.push({
            key,
            bytes,
            manifest: parseJsonBuffer(bytes, key),
        });
    }
    return artifacts;
}

function savedChannelCasStorage(storage) {
    if (storage && storage.savedChannelCasStorage) {
        return storage.savedChannelCasStorage;
    }
    if (
        !storage
        || typeof storage.getR2SmallObject !== 'function'
        || typeof storage.putR2SmallObjectConditional !== 'function'
        || typeof storage.isMissingR2ObjectError !== 'function'
        || typeof storage.isR2PreconditionFailedError !== 'function'
    ) {
        throw new Error(
            'write mode requires conditional small-object R2 methods'
        );
    }
    return {
        get: (key, options) =>
            storage.getR2SmallObject(key, options),
        put: (key, bytes, options) =>
            storage.putR2SmallObjectConditional(
                key,
                bytes,
                options
            ),
        isMissing: error =>
            storage.isMissingR2ObjectError(error),
        isPreconditionFailed: error =>
            storage.isR2PreconditionFailedError(error),
    };
}

function migrationIndexValidation(value) {
    if (
        value
        && !Array.isArray(value)
        && typeof value === 'object'
        && value.schema !== INDEX_SCHEMA
    ) {
        return { valid: true, errors: [] };
    }
    return validateSavedChannelIndex(value);
}

async function putImmutableIndexArtifact(
    storage,
    key,
    bytes
) {
    let writeResult = null;
    try {
        writeResult = await storage.put(key, bytes, {
            ifNoneMatch: '*',
            contentType: 'application/json',
        });
    } catch (error) {
        if (!storage.isPreconditionFailed(error)) throw error;
    }
    const readback = await storage.get(
        key,
        writeResult && writeResult.etag
            ? { ifMatch: writeResult.etag }
            : {}
    );
    if (
        !readback
        || !Buffer.isBuffer(readback.body)
        || !readback.body.equals(bytes)
    ) {
        throw new Error(
            `Immutable index collision or read-after-write failure for ${key}`
        );
    }
    const parsed = parseJsonBuffer(readback.body, key);
    const validation = validateSavedChannelIndex(parsed);
    if (!validation.valid) {
        throw new Error(
            `Immutable index contract validation failed for ${key}: `
                + validation.errors.join('; ')
        );
    }
    return writeResult
        ? 'written-and-verified'
        : 'verified-existing';
}

async function assertManifestSnapshotCurrent(storage, artifacts) {
    const currentArtifacts =
        await loadCanonicalManifestArtifacts(storage);
    if (currentArtifacts.length !== artifacts.length) {
        throw new Error(
            'Canonical manifest set changed during rebuild'
        );
    }
    for (let index = 0; index < artifacts.length; index++) {
        const expected = artifacts[index];
        const current = currentArtifacts[index];
        if (
            !current
            || current.key !== expected.key
            || !current.bytes.equals(expected.bytes)
        ) {
            throw new Error(
                `Canonical manifest changed during rebuild: ${expected.key}`
            );
        }
    }
}

async function rebuildSavedChannelIndex(storage, options = {}) {
    const maxAttempts = Number.isSafeInteger(options.maxAttempts)
        ? options.maxAttempts
        : 8;
    if (maxAttempts < 1 || maxAttempts > 32) {
        throw new Error('maxAttempts must be between 1 and 32');
    }
    let casStorage = null;
    let pointerCas = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const artifacts =
            await loadCanonicalManifestArtifacts(storage);
        const index = buildSavedChannelIndex(artifacts, {
            updatedAt: options.updatedAt,
        });
        const bytes = canonicalIndexBytes(index);
        const artifactIdentity =
            canonicalIndexArtifactIdentity(index);
        const archiveKey =
            `${INDEX_ARCHIVE_ROOT}${artifactIdentity.sha256}.json`;
        const result = {
            mode: options.write ? 'write' : 'dry-run',
            atomicity:
                'immutable archive first, then atomic single-object index replacement',
            indexKey: INDEX_KEY,
            archiveKey,
            manifestCount: artifacts.length,
            manifestKeys: artifacts.map(artifact => artifact.key),
            payloadSha256: index.payloadSha256,
            artifactSha256: artifactIdentity.sha256,
            bytes: bytes.length,
            authority: index.authority,
            validation: validateSavedChannelIndex(index),
            wrote: false,
            readAfterWriteVerified: false,
            archiveDisposition: 'planned',
            attempts: attempt,
        };
        if (!options.write) return { index, result };
        if (!casStorage) {
            casStorage = savedChannelCasStorage(storage);
            pointerCas = createR2JsonCasMutator({
                key: INDEX_KEY,
                storage: casStorage,
                emptyValue: () => buildSavedChannelIndex([]),
                validate: migrationIndexValidation,
                serialize: canonicalIndexBytes,
                label: 'saved-channel navigation index rebuild',
            });
        }

        await assertManifestSnapshotCurrent(storage, artifacts);
        result.archiveDisposition =
            await putImmutableIndexArtifact(
                casStorage,
                archiveKey,
                bytes
            );
        await pointerCas.mutate(async () => {
            await assertManifestSnapshotCurrent(
                storage,
                artifacts
            );
            return index;
        });
        const pointer = await pointerCas.readRevision();
        if (
            !pointer.revision
            || !pointer.revision.body.equals(bytes)
            || !validateSavedChannelIndex(pointer.value).valid
        ) {
            throw new Error(
                `Read-after-write verification failed for ${INDEX_KEY}`
            );
        }
        try {
            await assertManifestSnapshotCurrent(
                storage,
                artifacts
            );
        } catch (error) {
            if (attempt === maxAttempts) throw error;
            continue;
        }
        result.wrote = true;
        result.readAfterWriteVerified = true;
        return { index, result };
    }
    throw new Error(
        `Canonical manifests changed during all ${maxAttempts} rebuild attempts`
    );
}

function parseArgs(argv) {
    const options = { write: false, updatedAt: undefined };
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (value === '--write') {
            options.write = true;
        } else if (value === '--dry-run') {
            options.write = false;
        } else if (value === '--updated-at') {
            const parsed = Number(argv[++index]);
            if (!Number.isSafeInteger(parsed) || parsed < 0) {
                throw new Error('--updated-at must be a nonnegative integer');
            }
            options.updatedAt = parsed;
        } else {
            throw new Error(`Unknown argument: ${value}`);
        }
    }
    return options;
}

function loadEnvironment() {
    return loadProjectEnvironment({
        scriptDirectory: __dirname,
    });
}

async function main() {
    loadEnvironment();
    const options = parseArgs(process.argv.slice(2));
    if (!cloud.initR2()) {
        throw new Error('R2 configuration is unavailable');
    }
    const { result } = await rebuildSavedChannelIndex(cloud, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    CHANNEL_ROOT,
    INDEX_ARCHIVE_ROOT,
    parseJsonBuffer,
    loadCanonicalManifestArtifacts,
    assertManifestSnapshotCurrent,
    migrationIndexValidation,
    putImmutableIndexArtifact,
    rebuildSavedChannelIndex,
    savedChannelCasStorage,
    parseArgs,
    loadEnvironment,
};
