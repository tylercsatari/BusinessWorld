#!/usr/bin/env node
'use strict';

const cloud = require('../cloud-storage');
const {
    loadProjectEnvironment,
} = require('./load-project-environment');
const ledger = require('../buildings/jarvis/shorts-score-ledger');
const {
    canonicalJsonBytes,
    contentAddressedDigest,
    sha256Bytes,
} = require('../buildings/jarvis/canonical-json-artifact');
const manifestBinding = require(
    '../buildings/jarvis/saved-channel-manifest-binding'
);
const recordBinding = require(
    '../buildings/jarvis/saved-channel-record-binding'
);

const ROOT = 'raw/saved-channels/';
const write = process.argv.includes('--write');
const auditAll = process.argv.includes('--audit-all');
const migrationPrefixArgument = process.argv.indexOf(
    '--migration-prefix'
);
const MIGRATION_PREFIX = (
    migrationPrefixArgument >= 0
        ? process.argv[migrationPrefixArgument + 1]
        : 'raw/saved-channels/migrations/score-binding-v3'
).replace(/\/+$/g, '');
const requestedChannels = new Set(
    process.argv
        .filter(argument => /^ch[a-f0-9]{16}$/.test(argument))
);
let archivedSourceRecordMapPromise = null;
const R2_READ_TIMEOUT_MS = 45000;
const R2_READ_ATTEMPTS = 3;

async function boundedDownload(key) {
    let lastError = null;
    for (let attempt = 1; attempt <= R2_READ_ATTEMPTS; attempt++) {
        try {
            return await cloud.downloadFromR2(key, {
                timeoutMs: R2_READ_TIMEOUT_MS,
            });
        } catch (error) {
            lastError = error;
            if (attempt === R2_READ_ATTEMPTS) break;
            await new Promise(resolve => setTimeout(
                resolve,
                250 * attempt
            ));
        }
    }
    throw new Error(
        `R2 read failed after ${R2_READ_ATTEMPTS} attempts at ${key}: `
        + `${lastError && lastError.message || 'unknown error'}`
    );
}

function parseJson(buffer, key) {
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch (error) {
        throw new Error(`${key} is invalid JSON: ${error.message}`);
    }
}

async function immutablePut(
    key,
    bytes,
    mediaType,
    provider = cloud,
    shouldWrite = write
) {
    const buffer = Buffer.from(bytes);
    const addressedDigest = contentAddressedDigest(key);
    if (addressedDigest && addressedDigest !== sha256Bytes(buffer)) {
        throw new Error(
            `immutable migration key does not bind exact bytes at ${key}`
        );
    }
    if (!shouldWrite) return 'planned';
    const existing = provider === cloud
        ? await boundedDownload(key).catch(() => null)
        : await provider.downloadFromR2(key)
        .catch(() => null);
    if (existing) {
        if (!Buffer.from(existing).equals(buffer)) {
            throw new Error(`immutable migration collision at ${key}`);
        }
        return 'verified-existing';
    }
    let written;
    try {
        written = await provider.putR2SmallObjectConditional(
            key,
            buffer,
            {
                ifNoneMatch: '*',
                contentType: mediaType,
            }
        );
    } catch (error) {
        if (
            typeof provider.isR2PreconditionFailedError !== 'function'
            || !provider.isR2PreconditionFailedError(error)
        ) {
            throw error;
        }
        const raced = provider === cloud
            ? await boundedDownload(key)
            : await provider.downloadFromR2(key);
        if (!raced || !Buffer.from(raced).equals(buffer)) {
            throw new Error(`immutable migration collision at ${key}`);
        }
        return 'verified-existing';
    }
    const verified = await provider.getR2SmallObject(
        key,
        { ifMatch: written.etag }
    );
    if (
        !verified
        || verified.etag !== written.etag
        || !Buffer.from(verified.body).equals(buffer)
    ) {
        throw new Error(`${key} failed read-after-write verification`);
    }
    return 'written-and-verified';
}

async function verifiedReplace(
    key,
    expectedPriorBytes,
    nextBytes,
    mediaType,
    provider = cloud
) {
    let revision;
    try {
        revision = await provider.getR2SmallObject(key);
    } catch (error) {
        if (
            typeof provider.isMissingR2ObjectError === 'function'
            && provider.isMissingR2ObjectError(error)
        ) {
            revision = null;
        } else {
            throw error;
        }
    }
    const current = revision && revision.body;
    if (
        !current
        || !Buffer.from(current).equals(expectedPriorBytes)
    ) {
        throw new Error(
            `mutable saved-channel source changed during migration at ${key}`
        );
    }
    const next = Buffer.from(nextBytes);
    if (Buffer.from(current).equals(next)) {
        return 'verified-existing';
    }
    const written = await provider.putR2SmallObjectConditional(
        key,
        next,
        {
            ifMatch: revision.etag,
            contentType: mediaType,
        }
    );
    const verified = await provider.getR2SmallObject(
        key,
        { ifMatch: written.etag }
    );
    if (
        !verified
        || verified.etag !== written.etag
        || !Buffer.from(verified.body).equals(next)
    ) {
        throw new Error(`${key} failed final replacement verification`);
    }
    return 'replaced-and-verified';
}

function archiveKey(category, bytes) {
    return (
        `${MIGRATION_PREFIX}/${category}/by-sha256/`
        + `${sha256Bytes(bytes)}.json`
    );
}

function pushError(result, message) {
    if (result.errors.length < 100) result.errors.push(message);
    else result.suppressedErrors += 1;
}

function savedChannelVideoId(record) {
    return String(
        record && (
            record.id
            || record.savedChannelVideoId
            || record.sourceVideoId
            || record.videoId
        )
        || ''
    );
}

function exactStoredRecordBinding(record) {
    const stored = record && record.score_record_sha256;
    return !!(
        stored
        && new Set([
            ledger.scoreRecordBindingSha256(record),
            ledger.priorScoreRecordBindingSha256V1(record),
            ledger.priorScoreRecordBindingSha256V2V4(record),
        ].filter(Boolean)).has(stored)
    );
}

async function archivedSourceRecordMap() {
    if (archivedSourceRecordMapPromise) {
        return archivedSourceRecordMapPromise;
    }
    archivedSourceRecordMapPromise = (async () => {
        const prefix =
            `${MIGRATION_PREFIX}/source-records/by-sha256/`;
        const keys = await cloud.listR2Keys(prefix);
        const records = new Map();
        for (let at = 0; at < keys.length; at += 20) {
            const batch = keys.slice(at, at + 20);
            const buffers = await Promise.all(batch.map(
                key => boundedDownload(key).catch(() => null)
            ));
            buffers.forEach((buffer, index) => {
                if (!buffer) return;
                const key = batch[index];
                const expectedKey = (
                    `${prefix}${sha256Bytes(buffer)}.json`
                );
                if (key !== expectedKey) {
                    throw new Error(
                        `source-record archive key differs at ${key}`
                    );
                }
                const record = parseJson(buffer, key);
                const videoId = savedChannelVideoId(record);
                if (!videoId || !exactStoredRecordBinding(record)) {
                    return;
                }
                const existing = records.get(videoId) || [];
                existing.push({ key, buffer, record });
                records.set(videoId, existing);
            });
        }
        return records;
    })();
    return archivedSourceRecordMapPromise;
}

async function archivedPartialMigrationProof(item) {
    const row = item.row;
    const record = item.record;
    if (
        !row
        || !record
        || !row.score_record_sha256
        || !record.score_record_sha256
        || row.score_record_sha256 === record.score_record_sha256
    ) {
        return null;
    }
    const canonicalArchiveKey = archiveKey(
        'canonical-records',
        item.sourceBuffer
    );
    const canonicalArchive = await boundedDownload(
        canonicalArchiveKey
    ).catch(() => null);
    if (
        !canonicalArchive
        || !Buffer.from(canonicalArchive).equals(item.sourceBuffer)
    ) {
        return null;
    }
    const archived = await archivedSourceRecordMap();
    const candidates = (archived.get(String(row.id)) || []).filter(
        candidate => (
            candidate.record.score_record_sha256
                === row.score_record_sha256
            && candidate.record.score_ledger
            && row.score_ledger
            && candidate.record.score_ledger.ledger_sha256
                === row.score_ledger.ledger_sha256
        )
    );
    if (candidates.length !== 1) return null;
    const sourceLedger = recordBinding.resolveScoreLedger(
        candidates[0].record.score_ledger,
        { allowPriorRevisionMigration: true }
    );
    const rowLedger = recordBinding.resolveScoreLedger(
        row.score_ledger,
        { allowPriorRevisionMigration: true }
    );
    const currentLedger = recordBinding.resolveScoreLedger(
        record.score_ledger,
        { allowPriorRevisionMigration: true }
    );
    if (
        !sourceLedger.valid
        || !rowLedger.valid
        || !currentLedger.valid
        || sourceLedger.ledger.ledger_sha256
            !== rowLedger.ledger.ledger_sha256
        || currentLedger.ledger.ledger_sha256
            !== rowLedger.ledger.ledger_sha256
    ) {
        return null;
    }
    return {
        verified: true,
        videoId: String(row.id),
        sourceArchiveKey: candidates[0].key,
        canonicalArchiveKey,
        sourceScoreRecordSha256:
            candidates[0].record.score_record_sha256,
        sourceLedgerSha256:
            candidates[0].record.score_ledger.ledger_sha256,
        currentStoredScoreRecordSha256:
            record.score_record_sha256,
        currentCanonicalLedgerSha256:
            currentLedger.ledger.ledger_sha256,
    };
}

function needsCanonicalization(row) {
    if (!row || row.status !== 'done') return false;
    return (
        ledger.scoreLedgerValidationSummary(row).valid !== true
        || manifestBinding.validateManifestRowBinding(row).valid !== true
        || Object.prototype.hasOwnProperty.call(row, 'features')
    );
}

async function migrateChannel(channelId) {
    const manifestKey = `${ROOT}${channelId}/manifest.json`;
    const manifestBuffer = await boundedDownload(manifestKey);
    if (!manifestBuffer) {
        return {
            channelId,
            missingManifest: true,
            done: 0,
            selected: 0,
            migrated: 0,
            unchanged: 0,
            invalid: 0,
            conflicts: 0,
        };
    }
    const manifest = parseJson(manifestBuffer, manifestKey);
    const sourceManifestArchiveKey = archiveKey(
        'source-manifests',
        manifestBuffer
    );
    const sourceManifestDisposition = await immutablePut(
        sourceManifestArchiveKey,
        manifestBuffer,
        'application/json'
    );
    const doneRows = (manifest.videos || []).filter(
        row => row && row.status === 'done'
    );
    const selectedRows = auditAll
        ? doneRows
        : doneRows.filter(needsCanonicalization);
    const result = {
        channelId,
        name: manifest.name || null,
        done: doneRows.length,
        selected: selectedRows.length,
        migrated: 0,
        unchanged: 0,
        invalid: 0,
        conflicts: 0,
        errors: [],
        suppressedErrors: 0,
        sourceRecordsArchived: 0,
        recordArtifactsEnsured: 0,
        canonicalByteNormalizations: 0,
        canonicalInputBound: 0,
        historicalInputQuarantined: 0,
        recoveredArchivedPartialMigrations: 0,
        sourceManifestArchiveKey,
        sourceManifestDisposition,
        canonicalManifestArchiveKey: null,
        canonicalManifestDisposition: null,
    };
    let manifestChanged = false;
    for (let at = 0; at < selectedRows.length; at += 20) {
        const batch = selectedRows.slice(at, at + 20);
        const records = await Promise.all(batch.map(async row => {
            const mutableKey =
                `${ROOT}${channelId}/videos/${row.id}.json`;
            const montageKey =
                `${ROOT}${channelId}/montages/${row.id}.jpg`;
            let key = mutableKey;
            let [buffer, montageBytes] = await Promise.all([
                boundedDownload(mutableKey)
                    .catch(() => null),
                boundedDownload(montageKey)
                    .catch(() => null),
            ]);
            if (
                !buffer
                && typeof row.record_artifact_sha256 === 'string'
            ) {
                key = recordBinding.savedChannelRecordArtifactKey(
                    channelId,
                    row.record_artifact_sha256
                );
                buffer = await boundedDownload(key)
                    .catch(() => null);
            }
            return {
                key,
                mutableKey,
                row,
                sourceBuffer: buffer,
                record: buffer ? parseJson(buffer, key) : null,
                montageBytes,
            };
        }));
        // Every item has a distinct mutable record key and immutable archive
        // keys. Bound concurrency removes R2 round-trip serialization while
        // the manifest itself is still replaced exactly once after the batch.
        await Promise.all(records.map(async item => {
            if (!item.record) {
                result.invalid += 1;
                pushError(result, `${item.row.id}: full record missing`);
                return;
            }
            const partialMigrationProof =
                await archivedPartialMigrationProof(item);
            recordBinding.applySavedChannelEvidenceState(
                item.row,
                {
                    state:
                        manifestBinding
                            .HISTORICAL_EVIDENCE_STATE,
                    canonical: false,
                    predictor_eligible: false,
                    warning:
                        recordBinding
                            .HISTORICAL_EVIDENCE_WARNING,
                }
            );
            const canonical =
                recordBinding.canonicalizeSavedChannelRecordBinding(
                    item.record,
                    item.row,
                    {
                        allowPriorRevisionMigration: true,
                        allowPriorRecordBindingMigration: true,
                        allowLegacyCacheMaterialization: true,
                        archivedStaleManifestPointerProof:
                            partialMigrationProof,
                    }
                );
            if (!canonical.valid) {
                result.invalid += 1;
                pushError(
                    result,
                    `${item.row.id}: ${canonical.errors.join('; ')}`
                );
                return;
            }
            const evidence =
                recordBinding.classifySavedChannelInputEvidence(
                    item.record,
                    item.montageBytes
                );
            const evidenceChanged =
                recordBinding.applySavedChannelEvidenceState(
                    item.row,
                    evidence
                );
            if (evidenceChanged) {
                recordBinding.bindSavedChannelRecordAndRow(
                    item.record,
                    item.row
                );
            }
            const evidenceValidation =
                recordBinding.validateSavedChannelEvidenceState(
                    item.record,
                    item.row,
                    item.montageBytes
                );
            const ledgerValidation =
                ledger.validateScoreLedger(item.record.score_ledger);
            const rowValidation =
                manifestBinding.validateManifestRowBinding(item.row);
            const recordSha256 =
                ledger.scoreRecordBindingSha256(item.record);
            const canonicalRecordBytes =
                canonicalJsonBytes(item.record);
            const recordBytesChanged =
                !Buffer.from(item.sourceBuffer).equals(
                    canonicalRecordBytes
                );
            const exactRecordArtifactValid = (
                item.row.record_artifact_sha256
                    === sha256Bytes(canonicalRecordBytes)
                && item.row.record_byte_length
                    === canonicalRecordBytes.length
            );
            if (
                !ledgerValidation.valid
                || !rowValidation.valid
                || item.record.score_record_sha256 !== recordSha256
                || item.row.score_record_sha256 !== recordSha256
                || item.record.score_ledger.ledger_sha256
                    !== item.row.score_ledger.ledger_sha256
                || !exactRecordArtifactValid
                || !evidenceValidation.valid
            ) {
                result.invalid += 1;
                pushError(
                    result,
                    `${item.row.id}: post-migration binding audit failed`
                );
                return;
            }
            if (evidence.canonical) {
                result.canonicalInputBound += 1;
            } else {
                result.historicalInputQuarantined += 1;
            }
            result.conflicts += ledgerValidation.entries.filter(entry => (
                entry
                && entry.available === false
                && entry.provenance
                && entry.provenance.status === 'conflict'
            )).length;
            if (canonical.recoveredArchivedPartialMigration) {
                result.recoveredArchivedPartialMigrations += 1;
            }
            if (
                canonical.recordChanged
                || canonical.rowChanged
                || evidenceChanged
                || recordBytesChanged
            ) {
                result.migrated += 1;
                manifestChanged =
                    canonical.rowChanged
                    || evidenceChanged
                    || manifestChanged;
                if (
                    write
                    && (
                        canonical.recordChanged
                        || recordBytesChanged
                    )
                ) {
                    const sourceArchiveKey = archiveKey(
                        'source-records',
                        item.sourceBuffer
                    );
                    await immutablePut(
                        sourceArchiveKey,
                        item.sourceBuffer,
                        'application/json'
                    );
                    result.sourceRecordsArchived += 1;
                }
                const recordArtifactKey =
                    recordBinding.savedChannelRecordArtifactKey(
                        channelId,
                        item.row.record_artifact_sha256
                    );
                await immutablePut(
                    recordArtifactKey,
                    canonicalRecordBytes,
                    'application/json'
                );
                result.recordArtifactsEnsured += 1;
                if (recordBytesChanged) {
                    result.canonicalByteNormalizations += 1;
                }
            } else {
                result.unchanged += 1;
                const recordArtifactKey =
                    recordBinding.savedChannelRecordArtifactKey(
                        channelId,
                        item.row.record_artifact_sha256
                    );
                await immutablePut(
                    recordArtifactKey,
                    canonicalRecordBytes,
                    'application/json'
                );
                result.recordArtifactsEnsured += 1;
            }
        }));
        process.stdout.write(
            `[${channelId}] ${Math.min(
                at + batch.length,
                selectedRows.length
            )}/${selectedRows.length}\r`
        );
    }
    if (write && manifestChanged) {
        const canonicalManifestBytes =
            canonicalJsonBytes(manifest);
        result.canonicalManifestArchiveKey = archiveKey(
            'canonical-manifests',
            canonicalManifestBytes
        );
        result.canonicalManifestDisposition = await immutablePut(
            result.canonicalManifestArchiveKey,
            canonicalManifestBytes,
            'application/json'
        );
        await verifiedReplace(
            manifestKey,
            manifestBuffer,
            canonicalManifestBytes,
            'application/json'
        );
    } else if (manifestChanged) {
        const canonicalManifestBytes =
            canonicalJsonBytes(manifest);
        result.canonicalManifestArchiveKey = archiveKey(
            'canonical-manifests',
            canonicalManifestBytes
        );
        result.canonicalManifestDisposition = 'planned';
    }
    process.stdout.write(`${' '.repeat(90)}\r`);
    return result;
}

async function main() {
    loadProjectEnvironment({ scriptDirectory: __dirname });
    if (!cloud.initR2()) {
        throw new Error('R2 credentials are not configured');
    }
    const keys = await cloud.listR2Keys(ROOT);
    const channelIds = [...new Set(
        keys
            .map(key => {
                const match = key.match(
                    /^raw\/saved-channels\/(ch[a-f0-9]{16})\/manifest\.json$/
                );
                return match && match[1];
            })
            .filter(Boolean)
    )]
        .filter(channelId => (
            requestedChannels.size === 0
            || requestedChannels.has(channelId)
        ))
        .sort();
    const results = [];
    for (const channelId of channelIds) {
        results.push(await migrateChannel(channelId));
    }
    const totals = results.reduce((aggregate, result) => {
        for (const key of [
            'done',
            'selected',
            'migrated',
            'unchanged',
            'invalid',
            'conflicts',
        ]) {
            aggregate[key] += Number(result[key] || 0);
        }
        return aggregate;
    }, {
        done: 0,
        selected: 0,
        migrated: 0,
        unchanged: 0,
        invalid: 0,
        conflicts: 0,
    });
    console.log(JSON.stringify({
        ok: totals.invalid === 0,
        mode: write ? 'write' : 'dry-run',
        audit_all: auditAll,
        channels: results,
        totals,
    }, null, 2));
    if (totals.invalid) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error);
        process.exitCode = 1;
    });
}

module.exports = {
    MIGRATION_PREFIX,
    ROOT,
    archiveKey,
    immutablePut,
    parseJson,
    sha256Bytes,
    verifiedReplace,
};
