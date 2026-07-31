#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const path = require('path');
const {
    loadProjectEnvironment,
} = require('./load-project-environment');
const longSavedThumbnailRecord = require(
    '../buildings/jarvis/long-saved-thumbnail-record'
);
const longScoreLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const {
    canonicalJson,
    sha256Canonical,
} = require('../buildings/jarvis/shorts-score-ledger');
const {
    contentAddressedDigest,
} = require('../buildings/jarvis/canonical-json-artifact');

const DEFAULTS = Object.freeze({
    sourcePrefix: 'longform/saved-thumbs',
    migrationPrefix:
        'longform/saved-thumbs/migration-v1',
    indexKey: 'longform/saved-thumbs/index.json',
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function canonicalBytes(value) {
    return Buffer.from(canonicalJson(value), 'utf8');
}

function sha256Bytes(value) {
    return crypto
        .createHash('sha256')
        .update(value)
        .digest('hex');
}

function exactSha256(value) {
    return typeof value === 'string'
        && /^[a-f0-9]{64}$/.test(value);
}

function immutableReference(key, bytes, mediaType) {
    const buffer = Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes);
    return {
        key,
        sha256: sha256Bytes(buffer),
        byte_length: buffer.length,
        media_type: mediaType,
    };
}

function contentAddressedKey(
    prefix,
    category,
    sha256,
    extension
) {
    return [
        String(prefix).replace(/\/+$/g, ''),
        category,
        'by-sha256',
        `${sha256}${extension}`,
    ].join('/');
}

function isJpeg(bytes) {
    const buffer = bytes && Buffer.from(bytes);
    return !!(
        buffer
        && buffer.length >= 4
        && buffer[0] === 0xff
        && buffer[1] === 0xd8
        && buffer[buffer.length - 2] === 0xff
        && buffer[buffer.length - 1] === 0xd9
    );
}

async function auditReference(storage, reference, label) {
    const downloaded = await storage.get(reference.key);
    if (!downloaded) {
        throw new Error(`${label} is missing after write`);
    }
    const bytes = Buffer.from(downloaded);
    if (
        bytes.length !== reference.byte_length
        || sha256Bytes(bytes) !== reference.sha256
    ) {
        throw new Error(
            `${label} failed read-after-write verification`
        );
    }
    return bytes;
}

async function immutablePut(
    storage,
    key,
    bytes,
    mediaType,
    write
) {
    const buffer = Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes);
    const reference = immutableReference(
        key,
        buffer,
        mediaType
    );
    const addressedDigest = contentAddressedDigest(key);
    if (addressedDigest && addressedDigest !== reference.sha256) {
        throw new Error(
            `immutable key does not match exact bytes at ${key}`
        );
    }
    const existing = await storage.get(key);
    if (existing) {
        const existingBytes = Buffer.from(existing);
        if (!existingBytes.equals(buffer)) {
            throw new Error(
                `immutable key collision at ${key}`
            );
        }
        return {
            reference,
            disposition: 'verified-existing',
        };
    }
    if (!write) {
        return {
            reference,
            disposition: 'planned',
        };
    }
    await storage.put(key, buffer, mediaType);
    await auditReference(
        storage,
        reference,
        `immutable object ${key}`
    );
    return {
        reference,
        disposition: 'written-and-verified',
    };
}

async function verifiedReplace(
    storage,
    key,
    bytes,
    mediaType,
    expectedPriorBytes,
    write
) {
    const buffer = Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes);
    const existing = await storage.get(key);
    if (existing && Buffer.from(existing).equals(buffer)) {
        return {
            reference: immutableReference(
                key,
                buffer,
                mediaType
            ),
            disposition: 'verified-existing',
        };
    }
    const expected = expectedPriorBytes == null
        ? null
        : Buffer.from(expectedPriorBytes);
    if (
        existing
        && (
            !expected
            || !Buffer.from(existing).equals(expected)
        )
    ) {
        throw new Error(
            `mutable source changed before verified replacement at ${key}`
        );
    }
    if (!existing && expected) {
        throw new Error(
            `mutable source disappeared before replacement at ${key}`
        );
    }
    const reference = immutableReference(
        key,
        buffer,
        mediaType
    );
    if (!write) {
        return { reference, disposition: 'planned-replacement' };
    }
    await storage.put(key, buffer, mediaType);
    await auditReference(
        storage,
        reference,
        `replacement object ${key}`
    );
    return {
        reference,
        disposition: 'replaced-and-verified',
    };
}

function sourceRecordId(key, sourcePrefix) {
    const normalized = String(sourcePrefix).replace(/\/+$/g, '');
    if (
        path.posix.dirname(key) !== normalized
        || !key.endsWith('.json')
        || path.posix.basename(key) === 'index.json'
    ) {
        return null;
    }
    return path.posix.basename(key, '.json');
}

function sourceJpegId(key, sourcePrefix) {
    const normalized = String(sourcePrefix).replace(/\/+$/g, '');
    if (
        path.posix.dirname(key) !== normalized
        || !key.endsWith('.jpg')
    ) {
        return null;
    }
    return path.posix.basename(key, '.jpg');
}

function idsFromIndex(index) {
    const ids = new Set();
    for (const collection of [
        index && index.rows,
        index && index.thumbs,
        index && index.legacy_unbound,
    ]) {
        for (const row of Array.isArray(collection) ? collection : []) {
            if (row && typeof row.id === 'string' && row.id) {
                ids.add(row.id);
            }
        }
    }
    return ids;
}

function sourceArchiveManifest({
    id,
    jsonKey,
    jsonReference,
    jpegKey,
    jpegReference,
}) {
    const manifest = {
        schema:
            'long-saved-thumbnail-source-archive-v1',
        schema_version: 1,
        record_id: id,
        original_json: jsonReference
            ? {
                source_key: jsonKey,
                ...jsonReference,
            }
            : null,
        original_jpeg: jpegReference
            ? {
                source_key: jpegKey,
                ...jpegReference,
            }
            : null,
    };
    manifest.archive_manifest_sha256 =
        sha256Canonical(manifest);
    return manifest;
}

async function archiveSource({
    storage,
    migrationPrefix,
    id,
    jsonKey,
    jsonBytes,
    jpegKey,
    jpegBytes,
    write,
}) {
    let jsonStored = null;
    let jpegStored = null;
    if (jsonBytes) {
        const sha256 = sha256Bytes(jsonBytes);
        jsonStored = await immutablePut(
            storage,
            contentAddressedKey(
                migrationPrefix,
                'archive/json',
                sha256,
                '.json'
            ),
            jsonBytes,
            'application/json',
            write
        );
    }
    if (jpegBytes) {
        const sha256 = sha256Bytes(jpegBytes);
        jpegStored = await immutablePut(
            storage,
            contentAddressedKey(
                migrationPrefix,
                'archive/jpeg',
                sha256,
                '.jpg'
            ),
            jpegBytes,
            'image/jpeg',
            write
        );
    }
    const manifest = sourceArchiveManifest({
        id,
        jsonKey,
        jsonReference:
            jsonStored && jsonStored.reference,
        jpegKey,
        jpegReference:
            jpegStored && jpegStored.reference,
    });
    const manifestBytes = canonicalBytes(manifest);
    const manifestStored = await immutablePut(
        storage,
        contentAddressedKey(
            migrationPrefix,
            'archive/manifests',
            sha256Bytes(manifestBytes),
            '.json'
        ),
        manifestBytes,
        'application/json',
        write
    );
    return {
        manifest,
        manifestReference: manifestStored.reference,
        jsonReference:
            jsonStored && jsonStored.reference,
        jpegReference:
            jpegStored && jpegStored.reference,
    };
}

function uniqueErrors(groups) {
    return [...new Set(
        groups
            .flat()
            .filter(Boolean)
            .map(String)
    )];
}

function candidateContractValidation(
    record,
    id,
    jpegBytes
) {
    const errors = [];
    if (
        !record
        || typeof record !== 'object'
        || Array.isArray(record)
    ) {
        return {
            valid: false,
            errors: ['legacy saved thumbnail JSON is not an object'],
        };
    }
    if (
        !/^lt[a-z0-9]+$/i.test(String(id || ''))
        || record.id !== id
    ) {
        errors.push(
            'legacy saved thumbnail ID is missing or differs from its source key'
        );
    }
    if (
        typeof record.title !== 'string'
        || record.title.length === 0
    ) {
        errors.push(
            'legacy saved thumbnail exact title is missing'
        );
    }
    if (!jpegBytes) {
        errors.push('legacy saved thumbnail JPEG is missing');
    } else if (!isJpeg(jpegBytes)) {
        errors.push(
            'legacy saved thumbnail media is not an exact JPEG'
        );
    }
    for (
        const path of longSavedThumbnailRecord
            .redundantNumericalEvidencePaths(record)
    ) {
        errors.push(
            `legacy saved thumbnail duplicates numerical evidence at ${path}`
        );
    }
    const score = record.score;
    if (
        !score
        || typeof score !== 'object'
        || Array.isArray(score)
    ) {
        errors.push(
            'legacy saved thumbnail has no nested canonical score'
        );
        return {
            valid: false,
            errors,
            validations: null,
        };
    }
    const ledger = longScoreLedger.validateLongScoreLedger(
        score.long_score_ledger
    );
    const output =
        longScoreLedger.validateLongOutputContract(score);
    const alias =
        longScoreLedger.validateLongScoreAliasContract(score);
    const reward =
        longScoreLedger.validateLongScoreRewardContract(score);
    const input = longScoreLedger.validateLongInputManifest(
        score,
        {
            imageBytes: jpegBytes,
            title: record.title,
            scoreText: record.title,
        }
    );
    errors.push(
        ...ledger.errors,
        ...output.errors,
        ...alias.errors,
        ...reward.errors,
        ...input.errors
    );
    if (
        input.query
        && input.query.selected_text_source !== 'title'
    ) {
        errors.push(
            'Long score selected text source is not the exact title'
        );
    }
    return {
        valid: errors.length === 0,
        errors: uniqueErrors(errors),
        validations: {
            ledger,
            output,
            alias,
            reward,
            input,
        },
    };
}

function canonicalRecordFromLegacy(
    record,
    jpegBytes,
    archive
) {
    const mediaSha256 = sha256Bytes(jpegBytes);
    const canonical = longSavedThumbnailRecord.bindRecord({
        id: record.id,
        savedAt: record.savedAt == null
            ? null
            : record.savedAt,
        title: record.title,
        prompt: typeof record.prompt === 'string'
            ? record.prompt
            : '',
        source: typeof record.source === 'string'
            ? record.source
            : '',
        score: clone(record.score),
        media: {
            kind: 'thumbnail-jpeg',
            key:
                `longform/saved-thumbs/media/by-sha256/${mediaSha256}.jpg`,
            thumbnail_sha256: mediaSha256,
            byte_length: jpegBytes.length,
        },
        sourceVideo: record.sourceVideo || null,
        batchId: record.batchId || '',
        runRid: record.runRid || '',
        attemptK: Number.isFinite(Number(record.attemptK))
            ? Number(record.attemptK)
            : null,
        thumbI: Number.isFinite(Number(record.thumbI))
            ? Number(record.thumbI)
            : null,
        context: typeof record.context === 'string'
            ? record.context
            : '',
        baseline: record.baseline || null,
        meta: (
            record.meta
            && typeof record.meta === 'object'
            && !Array.isArray(record.meta)
        ) ? clone(record.meta) : {},
        migration: {
            schema:
                'long-saved-thumbnail-offline-migration-v1',
            source_classification:
                'legacy_exactly_bound_evidence',
            source_json: {
                source_key:
                    archive.manifest.original_json.source_key,
                ...archive.jsonReference,
            },
            source_jpeg: {
                source_key:
                    archive.manifest.original_jpeg.source_key,
                ...archive.jpegReference,
            },
            source_archive_manifest:
                archive.manifestReference,
        },
    });
    const validation =
        longSavedThumbnailRecord.validateRecord(canonical);
    if (!validation.valid) {
        throw new Error(
            `canonical record validation failed: ${
                validation.errors.join('; ')
            }`
        );
    }
    return canonical;
}

async function writeQuarantine({
    storage,
    migrationPrefix,
    id,
    archive,
    record,
    errors,
    write,
}) {
    const score = record
        && typeof record === 'object'
        && record.score
        && typeof record.score === 'object'
        ? record.score
        : null;
    const quarantine = {
        schema:
            'long-saved-thumbnail-quarantine-v1',
        schema_version: 1,
        record_id: id,
        state: 'legacy_unbound_evidence',
        source_archive_manifest:
            archive.manifestReference,
        source_json:
            archive.manifest.original_json,
        source_jpeg:
            archive.manifest.original_jpeg,
        errors: uniqueErrors(errors),
        submitted_evidence: {
            nested_score_present: !!score,
            ledger_sha256:
                score
                && score.long_score_ledger
                && exactSha256(
                    score.long_score_ledger.ledger_sha256
                )
                    ? score.long_score_ledger.ledger_sha256
                    : null,
            alias_fields_present: [
                'pctile',
                'pct100',
                'reward',
                'training_reward',
                'idea_model_reward',
                'visual_pctile',
                'thumbnail_potential',
            ].filter(field => (
                Object.prototype.hasOwnProperty.call(
                    score || record || {},
                    field
                )
            )),
        },
    };
    quarantine.quarantine_sha256 =
        sha256Canonical(quarantine);
    const bytes = canonicalBytes(quarantine);
    const stored = await immutablePut(
        storage,
        contentAddressedKey(
            migrationPrefix,
            'quarantine',
            sha256Bytes(bytes),
            '.json'
        ),
        bytes,
        'application/json',
        write
    );
    return {
        artifact: quarantine,
        reference: stored.reference,
        disposition: stored.disposition,
    };
}

async function auditCanonicalRecord(
    storage,
    record,
    sourcePrefix,
    sourceRecordBytes = null
) {
    const validation =
        longSavedThumbnailRecord.validateRecord(record);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    const mediaBytes = await storage.get(record.media.key);
    if (!mediaBytes || !isJpeg(mediaBytes)) {
        throw new Error(
            'canonical saved thumbnail JPEG is missing or invalid'
        );
    }
    const jpeg = Buffer.from(mediaBytes);
    if (
        sha256Bytes(jpeg) !== record.media.thumbnail_sha256
        || jpeg.length !== record.media.byte_length
    ) {
        throw new Error(
            'canonical saved thumbnail JPEG identity differs'
        );
    }
    const row =
        longSavedThumbnailRecord.compactIndexRow(record);
    const canonicalRecordBytes = canonicalBytes(record);
    if (
        row.record_artifact_sha256
            !== sha256Bytes(canonicalRecordBytes)
        || row.record_byte_length !== canonicalRecordBytes.length
    ) {
        throw new Error(
            'canonical saved thumbnail artifact identity differs'
        );
    }
    if (
        sourceRecordBytes
        && !Buffer.from(sourceRecordBytes).equals(
            canonicalRecordBytes
        )
    ) {
        throw new Error(
            'canonical saved thumbnail source bytes are not canonical JSON'
        );
    }
    if (
        row.record_key
            !== `${String(sourcePrefix).replace(/\/+$/g, '')}/${record.id}.json`
    ) {
        throw new Error(
            'canonical saved thumbnail source prefix differs'
        );
    }
    return { row, mediaBytes: jpeg };
}

async function persistCanonicalCandidate({
    storage,
    settings,
    sourceJsonKey,
    sourceJsonBytes,
    canonical,
    jpegBytes,
}) {
    const mediaStored = await immutablePut(
        storage,
        canonical.media.key,
        jpegBytes,
        'image/jpeg',
        settings.write
    );
    const recordBytes = canonicalBytes(canonical);
    const recordArtifact =
        longSavedThumbnailRecord.recordArtifactIdentity(
            canonical
        );
    const immutableRecordKey = contentAddressedKey(
        settings.migrationPrefix,
        'records',
        recordArtifact.sha256,
        '.json'
    );
    const immutableRecordStored = await immutablePut(
        storage,
        immutableRecordKey,
        recordBytes,
        'application/json',
        settings.write
    );
    const sourceStored = await verifiedReplace(
        storage,
        sourceJsonKey,
        recordBytes,
        'application/json',
        sourceJsonBytes,
        settings.write
    );
    if (settings.write) {
        const storedBytes = await storage.get(sourceJsonKey);
        const stored = JSON.parse(
            Buffer.from(storedBytes).toString('utf8')
        );
        const pair =
            longSavedThumbnailRecord.validateIndexRecordPair(
                longSavedThumbnailRecord.compactIndexRow(stored),
                stored
            );
        if (
            !pair.valid
            || canonicalJson(stored) !== canonicalJson(canonical)
        ) {
            throw new Error(
                'canonical record failed read-after-write validation'
            );
        }
    }
    return {
        media: mediaStored,
        immutableRecord: immutableRecordStored,
        sourceRecord: sourceStored,
    };
}

async function processCanonicalRecord({
    storage,
    settings,
    id,
    sourceJsonKey,
    sourceJsonBytes,
    record,
}) {
    if (record.id !== id) {
        throw new Error(
            'canonical saved thumbnail ID differs from source key'
        );
    }
    const bytes = canonicalBytes(record);
    const sourceBytes = Buffer.from(sourceJsonBytes || bytes);
    const bytesCanonical = sourceBytes.equals(bytes);
    const audited = await auditCanonicalRecord(
        storage,
        record,
        settings.sourcePrefix,
        bytesCanonical ? sourceBytes : null
    );
    const sourceRecord = await verifiedReplace(
        storage,
        sourceJsonKey,
        bytes,
        'application/json',
        sourceBytes,
        settings.write
    );
    const artifact =
        longSavedThumbnailRecord.recordArtifactIdentity(record);
    const immutableRecord = await immutablePut(
        storage,
        contentAddressedKey(
            settings.migrationPrefix,
            'records',
            artifact.sha256,
            '.json'
        ),
        bytes,
        'application/json',
        settings.write
    );
    return {
        state: 'canonical',
        id,
        row: audited.row,
        record,
        immutable_record:
            immutableRecord.reference,
        dispositions: {
            media: 'verified-existing',
            immutable_record:
                immutableRecord.disposition,
            source_record: sourceRecord.disposition,
        },
    };
}

async function processLegacyRecord({
    storage,
    settings,
    id,
    sourceJsonKey,
    sourceJsonBytes,
    sourceJpegKey,
    sourceJpegBytes,
}) {
    const archive = await archiveSource({
        storage,
        migrationPrefix: settings.migrationPrefix,
        id,
        jsonKey: sourceJsonKey,
        jsonBytes: sourceJsonBytes,
        jpegKey: sourceJpegKey,
        jpegBytes: sourceJpegBytes,
        write: settings.write,
    });
    if (!sourceJsonBytes) {
        const errors = [
            'legacy saved thumbnail JSON is missing',
        ];
        const quarantine = await writeQuarantine({
            storage,
            migrationPrefix: settings.migrationPrefix,
            id,
            archive,
            record: null,
            errors,
            write: settings.write,
        });
        return {
            state: 'quarantined',
            id,
            errors,
            quarantine,
        };
    }
    let record;
    try {
        record = JSON.parse(
            Buffer.from(sourceJsonBytes).toString('utf8')
        );
    } catch (error) {
        const errors = [
            `legacy saved thumbnail JSON is invalid: ${error.message}`,
        ];
        const quarantine = await writeQuarantine({
            storage,
            migrationPrefix: settings.migrationPrefix,
            id,
            archive,
            record: null,
            errors,
            write: settings.write,
        });
        return {
            state: 'quarantined',
            id,
            errors,
            quarantine,
        };
    }
    const validation = candidateContractValidation(
        record,
        id,
        sourceJpegBytes
    );
    if (!validation.valid) {
        const quarantine = await writeQuarantine({
            storage,
            migrationPrefix: settings.migrationPrefix,
            id,
            archive,
            record,
            errors: validation.errors,
            write: settings.write,
        });
        return {
            state: 'quarantined',
            id,
            title: typeof record.title === 'string'
                ? record.title
                : '',
            savedAt: record.savedAt || null,
            prompt: typeof record.prompt === 'string'
                ? record.prompt
                : '',
            sourceVideo: record.sourceVideo || null,
            errors: validation.errors,
            quarantine,
        };
    }
    const canonical = canonicalRecordFromLegacy(
        record,
        Buffer.from(sourceJpegBytes),
        archive
    );
    const persisted = await persistCanonicalCandidate({
        storage,
        settings,
        sourceJsonKey,
        sourceJsonBytes,
        canonical,
        jpegBytes: Buffer.from(sourceJpegBytes),
    });
    return {
        state: 'canonical',
        id,
        row:
            longSavedThumbnailRecord.compactIndexRow(canonical),
        record: canonical,
        immutable_record:
            persisted.immutableRecord.reference,
        source_archive_manifest:
            archive.manifestReference,
        dispositions: {
            media: persisted.media.disposition,
            immutable_record:
                persisted.immutableRecord.disposition,
            source_record:
                persisted.sourceRecord.disposition,
        },
    };
}

function legacyIndexRow(result) {
    return {
        id: result.id,
        state: 'legacy_unbound_evidence',
        savedAt: result.savedAt || null,
        title: result.title || '',
        prompt: result.prompt || '',
        sourceVideo: result.sourceVideo || null,
        quarantine_key:
            result.quarantine
            && result.quarantine.reference.key,
        quarantine_sha256:
            result.quarantine
            && result.quarantine.reference.sha256,
        errors: uniqueErrors(result.errors || []),
    };
}

function buildIndexRelease(rows, legacyRows) {
    const indexPayload = {
        schema: longSavedThumbnailRecord.INDEX_SCHEMA,
        rows: [...rows].sort((left, right) => (
            String(left.id).localeCompare(String(right.id))
        )),
        legacy_unbound: [...legacyRows].sort((left, right) => (
            String(left.id).localeCompare(String(right.id))
        )),
    };
    const release = {
        schema:
            'long-saved-thumbnail-index-release-v1',
        schema_version: 1,
        index_schema: longSavedThumbnailRecord.INDEX_SCHEMA,
        rows: indexPayload.rows,
        legacy_unbound: indexPayload.legacy_unbound,
        canonical_count: indexPayload.rows.length,
        quarantined_count:
            indexPayload.legacy_unbound.length,
        index_payload_sha256:
            longSavedThumbnailRecord
                .indexPayloadSha256(indexPayload),
    };
    release.release_sha256 =
        sha256Canonical(release);
    return { indexPayload, release };
}

function indexPointer(indexPayload, releaseReference, release) {
    return longSavedThumbnailRecord.bindIndex({
        ...indexPayload,
        migration_release: {
            schema:
                longSavedThumbnailRecord
                    .MIGRATION_POINTER_SCHEMA,
            key: releaseReference.key,
            artifact_sha256: releaseReference.sha256,
            byte_length: releaseReference.byte_length,
            release_sha256: release.release_sha256,
            index_payload_sha256:
                release.index_payload_sha256,
        },
    });
}

async function auditIndexPointer(storage, pointer) {
    const indexValidation =
        longSavedThumbnailRecord.validateIndex(pointer);
    if (!indexValidation.valid) {
        throw new Error(
            `live index binding differs: ${
                indexValidation.errors.join('; ')
            }`
        );
    }
    if (pointer.migration_release) {
        const releasePointer = pointer.migration_release;
        const releaseBytes = await storage.get(
            releasePointer.key
        );
        if (
            !releaseBytes
            || Buffer.byteLength(releaseBytes)
                !== releasePointer.byte_length
            || sha256Bytes(releaseBytes)
                !== releasePointer.artifact_sha256
        ) {
            throw new Error(
                'migration release artifact identity differs'
            );
        }
        let release;
        try {
            release = JSON.parse(
                Buffer.from(releaseBytes).toString('utf8')
            );
        } catch (error) {
            throw new Error(
                `migration release JSON is invalid: ${error.message}`
            );
        }
        const releaseHashPayload = clone(release);
        delete releaseHashPayload.release_sha256;
        const expectedIndexPayloadSha256 =
            longSavedThumbnailRecord
                .indexPayloadSha256(pointer);
        if (
            release.schema
                !== 'long-saved-thumbnail-index-release-v1'
            || release.schema_version !== 1
            || release.index_schema
                !== longSavedThumbnailRecord.INDEX_SCHEMA
            || release.canonical_count
                !== pointer.rows.length
            || release.quarantined_count
                !== pointer.legacy_unbound.length
            || release.release_sha256
                !== sha256Canonical(releaseHashPayload)
            || release.release_sha256
                !== releasePointer.release_sha256
            || release.index_payload_sha256
                !== expectedIndexPayloadSha256
            || canonicalJson(release.rows)
                !== canonicalJson(pointer.rows)
            || canonicalJson(release.legacy_unbound)
                !== canonicalJson(pointer.legacy_unbound)
        ) {
            throw new Error(
                'migration release artifact describes different index evidence'
            );
        }
    }
    for (const row of pointer.rows) {
        const rowValidation =
            longSavedThumbnailRecord.validateIndexRow(row);
        if (!rowValidation.valid) {
            throw new Error(
                `index row ${row.id} is invalid: ${
                    rowValidation.errors.join('; ')
                }`
            );
        }
        const bytes = await storage.get(row.record_key);
        if (!bytes) {
            throw new Error(
                `index record ${row.record_key} is missing`
            );
        }
        const record = JSON.parse(
            Buffer.from(bytes).toString('utf8')
        );
        const canonicalRecordBytes = canonicalBytes(record);
        if (
            !Buffer.from(bytes).equals(canonicalRecordBytes)
            || sha256Bytes(canonicalRecordBytes)
                !== row.record_artifact_sha256
            || canonicalRecordBytes.length
                !== row.record_byte_length
        ) {
            throw new Error(
                `index record ${row.record_key} exact artifact differs`
            );
        }
        const pair =
            longSavedThumbnailRecord.validateIndexRecordPair(
                row,
                record
            );
        if (!pair.valid) {
            throw new Error(
                `index pair ${row.id} differs: ${
                    pair.errors.join('; ')
                }`
            );
        }
        const media = await storage.get(row.media_key);
        if (
            !media
            || sha256Bytes(media) !== row.thumbnail_sha256
        ) {
            throw new Error(
                `index media ${row.media_key} differs`
            );
        }
    }
}

async function writeIndexLast({
    storage,
    settings,
    initialIndexBytes,
    rows,
    legacyRows,
}) {
    const built = buildIndexRelease(rows, legacyRows);
    const releaseBytes = canonicalBytes(built.release);
    const releaseStored = await immutablePut(
        storage,
        contentAddressedKey(
            settings.migrationPrefix,
            'indexes',
            sha256Bytes(releaseBytes),
            '.json'
        ),
        releaseBytes,
        'application/json',
        settings.write
    );
    const pointer = indexPointer(
        built.indexPayload,
        releaseStored.reference,
        built.release
    );
    const pointerBytes = canonicalBytes(pointer);
    const currentIndexBytes = await storage.get(settings.indexKey);
    const initial = initialIndexBytes
        ? Buffer.from(initialIndexBytes)
        : null;
    const current = currentIndexBytes
        ? Buffer.from(currentIndexBytes)
        : null;
    if (
        (initial == null) !== (current == null)
        || (
            initial
            && current
            && !initial.equals(current)
        )
    ) {
        throw new Error(
            'live saved-thumbnail index changed during migration'
        );
    }
    const pointerStored = await verifiedReplace(
        storage,
        settings.indexKey,
        pointerBytes,
        'application/json',
        initial,
        settings.write
    );
    if (settings.write) {
        const downloaded = await auditReference(
            storage,
            pointerStored.reference,
            'live saved-thumbnail index pointer'
        );
        const parsed = JSON.parse(downloaded.toString('utf8'));
        if (
            parsed.migration_release.release_sha256
                !== built.release.release_sha256
            || parsed.migration_release.artifact_sha256
                !== releaseStored.reference.sha256
            || parsed.migration_release.index_payload_sha256
                !== longSavedThumbnailRecord
                    .indexPayloadSha256(parsed)
        ) {
            throw new Error(
                'live saved-thumbnail index pointer binding differs'
            );
        }
        await auditIndexPointer(storage, parsed);
    }
    return {
        release: {
            key: releaseStored.reference.key,
            sha256: built.release.release_sha256,
            artifact_sha256:
                releaseStored.reference.sha256,
            disposition: releaseStored.disposition,
        },
        pointer: {
            key: settings.indexKey,
            sha256: pointerStored.reference.sha256,
            disposition: pointerStored.disposition,
        },
    };
}

async function archiveInitialIndex(
    storage,
    settings,
    initialIndexBytes,
    parsedIndex
) {
    if (
        !initialIndexBytes
        || (
            parsedIndex
            && parsedIndex.migration_release
            && parsedIndex.migration_release.schema
                === longSavedThumbnailRecord
                    .MIGRATION_POINTER_SCHEMA
        )
    ) {
        return null;
    }
    const bytes = Buffer.from(initialIndexBytes);
    return immutablePut(
        storage,
        contentAddressedKey(
            settings.migrationPrefix,
            'archive/index',
            sha256Bytes(bytes),
            '.json'
        ),
        bytes,
        'application/json',
        settings.write
    );
}

async function migrateLongSavedThumbnails(options) {
    const settings = {
        ...DEFAULTS,
        ...options,
        write: options && options.write === true,
    };
    if (
        !settings.storage
        || typeof settings.storage.get !== 'function'
        || typeof settings.storage.put !== 'function'
        || typeof settings.storage.list !== 'function'
    ) {
        throw new Error(
            'migration requires get/put/list storage methods'
        );
    }
    const sourcePrefix =
        String(settings.sourcePrefix).replace(/\/+$/g, '');
    const initialIndexBytes = await settings.storage.get(
        settings.indexKey
    );
    let parsedIndex = null;
    let indexParseError = null;
    if (initialIndexBytes) {
        try {
            parsedIndex = JSON.parse(
                Buffer.from(initialIndexBytes).toString('utf8')
            );
        } catch (error) {
            indexParseError = error.message;
        }
    }
    const listedKeys = (
        await settings.storage.list(sourcePrefix)
    ).map(String).sort();
    const ids = new Set(idsFromIndex(parsedIndex));
    for (const key of listedKeys) {
        const jsonId = sourceRecordId(key, sourcePrefix);
        const jpegId = sourceJpegId(key, sourcePrefix);
        if (jsonId) ids.add(jsonId);
        if (jpegId) ids.add(jpegId);
    }
    const results = [];
    const globalErrors = [];
    try {
        await archiveInitialIndex(
            settings.storage,
            settings,
            initialIndexBytes,
            parsedIndex
        );
    } catch (error) {
        globalErrors.push(
            `index source archive failed: ${error.message}`
        );
    }
    if (indexParseError) {
        globalErrors.push(
            `legacy index JSON is invalid: ${indexParseError}`
        );
    }
    for (const id of [...ids].sort()) {
        const sourceJsonKey = `${sourcePrefix}/${id}.json`;
        const sourceJpegKey = `${sourcePrefix}/${id}.jpg`;
        try {
            const sourceJsonBytes =
                await settings.storage.get(sourceJsonKey);
            let parsed = null;
            if (sourceJsonBytes) {
                try {
                    parsed = JSON.parse(
                        Buffer.from(sourceJsonBytes)
                            .toString('utf8')
                    );
                } catch (_) {
                    parsed = null;
                }
            }
            if (
                parsed
                && parsed.schema
                    === longSavedThumbnailRecord.RECORD_SCHEMA
            ) {
                results.push(await processCanonicalRecord({
                    storage: settings.storage,
                    settings: {
                        ...settings,
                        sourcePrefix,
                    },
                    id,
                    sourceJsonKey,
                    sourceJsonBytes,
                    record: parsed,
                }));
                continue;
            }
            const sourceJpegBytes =
                await settings.storage.get(sourceJpegKey);
            results.push(await processLegacyRecord({
                storage: settings.storage,
                settings: {
                    ...settings,
                    sourcePrefix,
                },
                id,
                sourceJsonKey,
                sourceJsonBytes: sourceJsonBytes
                    ? Buffer.from(sourceJsonBytes)
                    : null,
                sourceJpegKey,
                sourceJpegBytes: sourceJpegBytes
                    ? Buffer.from(sourceJpegBytes)
                    : null,
            }));
        } catch (error) {
            results.push({
                state: 'invalid',
                id,
                errors: [error.message],
            });
        }
    }
    const canonical = results.filter(
        result => result.state === 'canonical'
    );
    const quarantined = results.filter(
        result => result.state === 'quarantined'
    );
    const invalid = results.filter(
        result => result.state === 'invalid'
    );
    let index = {
        release: null,
        pointer: {
            key: settings.indexKey,
            disposition: 'skipped-due-to-invalid-evidence',
        },
    };
    if (!invalid.length && !globalErrors.length) {
        try {
            index = await writeIndexLast({
                storage: settings.storage,
                settings: {
                    ...settings,
                    sourcePrefix,
                },
                initialIndexBytes,
                rows: canonical.map(result => result.row),
                legacyRows: quarantined.map(legacyIndexRow),
            });
        } catch (error) {
            globalErrors.push(
                `index commit failed: ${error.message}`
            );
            index = {
                release: null,
                pointer: {
                    key: settings.indexKey,
                    disposition: 'failed',
                },
            };
        }
    }
    return {
        schema:
            'long-saved-thumbnail-migration-report-v1',
        mode: settings.write ? 'write' : 'dry-run',
        source_count: ids.size,
        canonical_count: canonical.length,
        quarantined_count: quarantined.length,
        invalid_count:
            invalid.length + globalErrors.length,
        index,
        global_errors: globalErrors,
        records: results.map(result => ({
            id: result.id,
            state: result.state,
            score_percentile:
                result.record
                    ? longSavedThumbnailRecord.scorePercentile(
                        result.record.score
                    )
                    : null,
            ledger_sha256:
                result.record
                && result.record.score
                && result.record.score.long_score_ledger
                    ? result.record.score.long_score_ledger
                        .ledger_sha256
                    : null,
            record_content_sha256:
                result.record
                    ? result.record.record_content_sha256
                    : null,
            record_artifact_sha256:
                result.record
                    ? longSavedThumbnailRecord
                        .recordArtifactIdentity(result.record)
                        .sha256
                    : null,
            record_byte_length:
                result.record
                    ? longSavedThumbnailRecord
                        .recordArtifactIdentity(result.record)
                        .byte_length
                    : null,
            immutable_record:
                result.immutable_record || null,
            source_archive_manifest:
                result.source_archive_manifest || null,
            quarantine:
                result.quarantine
                    ? result.quarantine.reference
                    : null,
            dispositions: result.dispositions || null,
            errors: uniqueErrors(result.errors || []),
        })),
    };
}

function parseArguments(argv) {
    const options = { write: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--write') {
            options.write = true;
        } else if (argument === '--source-prefix') {
            options.sourcePrefix = argv[++index];
        } else if (argument === '--migration-prefix') {
            options.migrationPrefix = argv[++index];
        } else if (argument === '--index-key') {
            options.indexKey = argv[++index];
        } else if (argument === '--help') {
            options.help = true;
        } else {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    return options;
}

function helpText() {
    return [
        'Usage: node scripts/migrate-long-saved-thumbnails.js [options]',
        '',
        'Dry-run is the default. Source JSON/JPEG objects are never deleted.',
        '  --write                    Commit verified migration artifacts',
        '  --source-prefix PREFIX     Legacy/canonical saved-thumbnail prefix',
        '  --migration-prefix PREFIX  Immutable migration artifact prefix',
        '  --index-key KEY            Live compact index pointer key',
    ].join('\n');
}

function cloudStorageAdapter(cloud) {
    return {
        get: async key => cloud.downloadFromR2(key),
        put: async (key, bytes, mediaType) => {
            await cloud.uploadToR2(key, bytes, mediaType);
        },
        list: async prefix => cloud.listR2Keys(prefix),
    };
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${helpText()}\n`);
        return;
    }
    loadProjectEnvironment({ scriptDirectory: __dirname });
    const cloud = require('../cloud-storage');
    if (!cloud.initR2()) {
        throw new Error('R2 credentials are not configured');
    }
    const report = await migrateLongSavedThumbnails({
        ...options,
        storage: cloudStorageAdapter(cloud),
    });
    process.stdout.write(
        `${JSON.stringify(report, null, 2)}\n`
    );
    if (report.invalid_count) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(
            `${error.stack || error.message}\n`
        );
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULTS,
    archiveSource,
    auditIndexPointer,
    candidateContractValidation,
    canonicalBytes,
    cloudStorageAdapter,
    contentAddressedKey,
    immutablePut,
    isJpeg,
    migrateLongSavedThumbnails,
    parseArguments,
    sha256Bytes,
};
