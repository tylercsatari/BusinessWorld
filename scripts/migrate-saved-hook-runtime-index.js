#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cloud = require('../cloud-storage');
const {
    loadProjectEnvironment,
} = require('./load-project-environment');
const displayContract = require('../embedding-display-contract');
const runtimeIndex = require(
    '../buildings/jarvis/saved-hook-runtime-index'
);
const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const longScoreLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const {
    canonicalJsonBytes,
    contentAddressedDigest,
} = require('../buildings/jarvis/canonical-json-artifact');

const INDEX_KEY = 'raw/saved-hooks/index.json';
const SOURCE_ROOT = 'raw/saved-hooks';
const ARCHIVE_PREFIX =
    'raw/saved-hooks-bound/runtime-index-migration-v2';

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
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

function sourceRows(index) {
    const byId = new Map();
    for (const row of []
        .concat(Array.isArray(index && index.hooks) ? index.hooks : [])
        .concat(
            Array.isArray(index && index.legacy_hooks)
                ? index.legacy_hooks
                : []
        )) {
        const id = String(row && row.id || '');
        if (!id) continue;
        if (!byId.has(id)) {
            byId.set(id, row);
            continue;
        }
        const prior = shortsScoreLedger.canonicalJson(byId.get(id));
        if (prior !== shortsScoreLedger.canonicalJson(row)) {
            throw new Error(
                `saved-hook source index has conflicting duplicate id ${id}`
            );
        }
    }
    return [...byId.values()];
}

function historicalProvenancePresent(record) {
    const ledgers = [
        record && record.score_ledger,
        record && record.long_score_ledger,
    ].filter(Boolean);
    return ledgers.some(ledger => (
        Array.isArray(ledger.entries)
        && ledger.entries.some(entry => {
            const status = entry
                && entry.provenance
                && entry.provenance.status;
            return [
                'historical_materialization',
                'conflict',
            ].includes(status);
        })
    ));
}

function validateCanonicalSource(record, mediaBytes) {
    const errors = [];
    if (!record || typeof record !== 'object' || !record.id) {
        return {
            valid: false,
            errors: ['saved-hook source record or id is missing'],
        };
    }
    if (!isJpeg(mediaBytes)) {
        errors.push('saved-hook canonical JPEG is missing or invalid');
    }
    const domain = displayContract.scoreDomainForRecord(record);
    const recordedScoreSha256 = record.score_record_sha256;
    const calculatedScoreSha256 =
        displayContract.savedHookScoreRecordSha256(record);
    if (
        typeof recordedScoreSha256 !== 'string'
        || recordedScoreSha256 !== calculatedScoreSha256
    ) {
        errors.push('saved-hook score-record binding differs');
    }
    if (historicalProvenancePresent(record)) {
        errors.push(
            'historical or conflicting score provenance is not canonical input evidence'
        );
    }
    if (domain === 'shorts') {
        const ledgerValidation =
            shortsScoreLedger.validateScoreLedger(
                record.score_ledger
            );
        if (!ledgerValidation.valid) {
            errors.push(...ledgerValidation.errors);
        }
        const inputValidation =
            shortsScoreLedger.validateShortsInputManifest(
                record,
                {
                    montageBytes: mediaBytes,
                    text:
                        record.text !== undefined
                            ? record.text
                            : record.transcript || '',
                    durationS:
                        record.input_manifest
                        && record.input_manifest.duration_s,
                    creatorProfile:
                        record.input_manifest
                        && record.input_manifest.creator_profile,
                }
            );
        if (!inputValidation.valid) {
            errors.push(...inputValidation.errors);
        }
    } else {
        const contractValidation =
            longScoreLedger.validateLongOutputContract(record);
        const inputValidation =
            longScoreLedger.validateLongInputManifest(
                record,
                { imageBytes: mediaBytes }
            );
        if (!contractValidation.valid) {
            errors.push(...contractValidation.errors);
        }
        if (!inputValidation.valid) {
            errors.push(...inputValidation.errors);
        }
    }
    let compact = null;
    try {
        compact = displayContract.compactSavedHookRecord(
            record,
            { scoreDomain: domain }
        );
    } catch (error) {
        errors.push(error.message);
    }
    if (
        compact
        && (
            !runtimeIndex.canonicalCompactEvidenceValid(compact)
            || !displayContract.validateCompactSavedHookSource(
                compact,
                record
            )
        )
    ) {
        errors.push(
            'saved-hook compact row does not bind the canonical source'
        );
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        compact,
        domain,
    };
}

async function immutablePut(
    storage,
    key,
    bytes,
    write,
    mediaType = 'application/json'
) {
    const buffer = Buffer.from(bytes);
    const addressedDigest = contentAddressedDigest(key);
    if (addressedDigest && addressedDigest !== sha256Bytes(buffer)) {
        throw new Error(
            `immutable object key does not match exact bytes at ${key}`
        );
    }
    const existing = await storage.get(key);
    if (existing) {
        if (!Buffer.from(existing).equals(buffer)) {
            throw new Error(`immutable object collision at ${key}`);
        }
        return 'verified-existing';
    }
    if (!write) return 'planned';
    await storage.put(key, buffer, mediaType);
    const persisted = await storage.get(key);
    if (!persisted || !Buffer.from(persisted).equals(buffer)) {
        throw new Error(
            `immutable object ${key} failed read-after-write verification`
        );
    }
    return 'written-and-verified';
}

async function migrateSavedHookRuntimeIndex({
    storage,
    write = false,
}) {
    const sourceIndexBytes = await storage.get(INDEX_KEY);
    if (!sourceIndexBytes) {
        throw new Error('saved-hook runtime index is missing');
    }
    const sourceIndex = JSON.parse(
        Buffer.from(sourceIndexBytes).toString('utf8')
    );
    const rows = sourceRows(sourceIndex);
    const canonicalRows = [];
    const legacyRows = [];
    const records = [];

    async function inspectRow(row) {
        const id = String(row.id);
        const recordKey = `${SOURCE_ROOT}/${id}.json`;
        const recordBytes = await storage.get(recordKey);
        if (!recordBytes) {
            return {
                legacy: runtimeIndex.legacyRow(row),
                record: {
                    id,
                    state: 'legacy_unbound_evidence',
                    reason: 'source record is missing',
                },
            };
        }
        try {
            const source = JSON.parse(
                Buffer.from(recordBytes).toString('utf8')
            );
            const mediaReference = source.montage_ref;
            const canonicalMediaBytes = mediaReference
                ? await storage.get(mediaReference.key)
                : null;
            const evidence = validateCanonicalSource(
                source,
                canonicalMediaBytes
            );
            if (!evidence.valid) {
                return {
                    legacy: runtimeIndex.legacyRow({
                        ...row,
                        ...source,
                    }),
                    record: {
                        id,
                        state: 'legacy_unbound_evidence',
                        reason: evidence.errors.join('; '),
                    },
                };
            }
            const canonical = source;
            const compact = evidence.compact;

            const canonicalBytes = canonicalJsonBytes(canonical);
            const canonicalizedBytes =
                !Buffer.from(recordBytes).equals(canonicalBytes);
            const archiveTransition = canonicalizedBytes;
            const recordArchiveKey = archiveTransition
                ? (
                    `${ARCHIVE_PREFIX}/source-json/by-sha256/`
                    + `${sha256Bytes(recordBytes)}.json`
                )
                : null;
            if (recordArchiveKey) {
                await immutablePut(
                    storage,
                    recordArchiveKey,
                    recordBytes,
                    write
                );
            }
            const canonicalMedia = canonical.montage_ref;
            if (
                !canonicalMedia
                || !canonicalMediaBytes
                || sha256Bytes(canonicalMediaBytes)
                    !== canonicalMedia.sha256
                || Buffer.byteLength(canonicalMediaBytes)
                    !== canonicalMedia.byte_length
            ) {
                throw new Error(
                    'canonical saved-hook media binding differs'
                );
            }
            if (write && canonicalizedBytes) {
                const current = await storage.get(recordKey);
                if (
                    !current
                    || !Buffer.from(current).equals(recordBytes)
                ) {
                    throw new Error(
                        'source record changed during migration'
                    );
                }
                await storage.put(
                    recordKey,
                    canonicalBytes,
                    'application/json'
                );
                const persisted = await storage.get(recordKey);
                if (
                    !persisted
                    || !Buffer.from(persisted).equals(canonicalBytes)
                ) {
                    throw new Error(
                        'canonical source failed verification'
                    );
                }
            }
            return {
                canonical: compact,
                record: {
                    id,
                    state: canonicalizedBytes
                        ? 'canonical_bytes_normalized'
                        : 'canonical_unchanged',
                    score_ledger_sha256:
                        canonical.score_ledger
                        && canonical.score_ledger.ledger_sha256
                        || canonical.long_score_ledger
                        && canonical.long_score_ledger.ledger_sha256
                        || null,
                    score_record_sha256:
                        canonical.score_record_sha256 || null,
                    source_archive_key: recordArchiveKey,
                },
            };
        } catch (error) {
            return {
                legacy: runtimeIndex.legacyRow(row),
                record: {
                    id,
                    state: 'legacy_unbound_evidence',
                    reason: String(error.message || error),
                },
            };
        }
    }

    // R2 latency dominates this offline audit. Bounded batches preserve
    // source order while avoiding one serial round trip per historical row.
    for (let at = 0; at < rows.length; at += 20) {
        const inspected = await Promise.all(
            rows.slice(at, at + 20).map(inspectRow)
        );
        for (const result of inspected) {
            if (result.canonical) {
                canonicalRows.push(result.canonical);
            } else {
                legacyRows.push(result.legacy);
            }
            records.push(result.record);
        }
    }

    const migrated = runtimeIndex.bindIndex({
        hooks: canonicalRows,
        legacy_hooks: legacyRows,
        folders: Array.isArray(sourceIndex.folders)
            ? sourceIndex.folders
            : [],
        updatedAt:
            Number.isSafeInteger(sourceIndex.updatedAt)
                ? sourceIndex.updatedAt
                : 0,
    });
    const migratedBytes = runtimeIndex.canonicalIndexBytes(migrated);
    const sourceSha256 = sha256Bytes(sourceIndexBytes);
    const migratedSha256 = sha256Bytes(migratedBytes);
    const sourceArchiveKey = (
        `${ARCHIVE_PREFIX}/source-index/by-sha256/`
        + `${sourceSha256}.json`
    );
    const migratedArchiveKey = (
        `${ARCHIVE_PREFIX}/canonical-index/by-sha256/`
        + `${migratedSha256}.json`
    );
    const sourceDisposition = sourceSha256 === migratedSha256
        ? 'not-required-canonical-source'
        : await immutablePut(
            storage,
            sourceArchiveKey,
            sourceIndexBytes,
            write
        );
    const migratedDisposition = await immutablePut(
        storage,
        migratedArchiveKey,
        migratedBytes,
        write
    );

    if (write) {
        const current = await storage.get(INDEX_KEY);
        if (
            !current
            || !Buffer.from(current).equals(sourceIndexBytes)
        ) {
            throw new Error(
                'saved-hook runtime index changed during offline migration'
            );
        }
        if (!Buffer.from(current).equals(migratedBytes)) {
            await storage.put(
                INDEX_KEY,
                migratedBytes,
                'application/json'
            );
        }
        const persisted = await storage.get(INDEX_KEY);
        const persistedIndex = persisted
            ? JSON.parse(Buffer.from(persisted).toString('utf8'))
            : null;
        if (
            !persisted
            || !Buffer.from(persisted).equals(migratedBytes)
            || !runtimeIndex.validateIndex(persistedIndex).valid
        ) {
            throw new Error(
                'saved-hook runtime index failed final verification'
            );
        }
    }

    return {
        ok: true,
        mode: write ? 'write' : 'dry-run',
        source: {
            sha256: sourceSha256,
            archive_key: sourceArchiveKey,
            disposition: sourceDisposition,
        },
        canonical: {
            sha256: migratedSha256,
            index_sha256: migrated.index_sha256,
            archive_key: migratedArchiveKey,
            disposition: migratedDisposition,
            canonical_rows: migrated.hooks.length,
            legacy_unbound_rows:
                migrated.legacy_hooks.length,
            historical_quarantined_rows: records.filter(
                record => (
                    record.state === 'legacy_unbound_evidence'
                )
            ).length,
            unchanged_rows: records.filter(
                record => (
                    record.state === 'canonical_unchanged'
                )
            ).length,
            canonical_bytes_normalized_rows: records.filter(
                record => (
                    record.state === 'canonical_bytes_normalized'
                )
            ).length,
            folders: migrated.folders.length,
        },
        records,
    };
}

function cloudStorageAdapter(provider) {
    return {
        get: async key => provider.downloadFromR2(key),
        put: async (key, bytes, mediaType) => {
            await provider.uploadToR2(
                key,
                bytes,
                mediaType
            );
        },
    };
}

async function main() {
    if (process.argv.includes('--help')) {
        process.stdout.write(
            'Usage: node scripts/migrate-saved-hook-runtime-index.js [--write]\n'
        );
        return;
    }
    const write = process.argv.includes('--write');
    if (
        process.argv.slice(2).some(
            argument => !['--write'].includes(argument)
        )
    ) {
        throw new Error('unknown migration argument');
    }
    loadProjectEnvironment({ scriptDirectory: __dirname });
    if (!cloud.initR2()) {
        throw new Error('R2 credentials are not configured');
    }
    const report = await migrateSavedHookRuntimeIndex({
        storage: cloudStorageAdapter(cloud),
        write,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    ARCHIVE_PREFIX,
    INDEX_KEY,
    cloudStorageAdapter,
    isJpeg,
    migrateSavedHookRuntimeIndex,
    sha256Bytes,
    sourceRows,
    validateCanonicalSource,
};
