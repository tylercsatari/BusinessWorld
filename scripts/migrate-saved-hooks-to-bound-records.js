#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
    buildBoundRevision,
    buildCompactIndex,
    canonicalCompactIndexBytes,
    classifyHistoricalSavedHook,
    compactIndexRow,
    contentAddressedKey,
    immutableObjectReference,
    normalizeText,
    revisionBindingPayload,
    scoreResultArtifact,
    sha256Bytes,
    sourceArchiveManifest,
    sourceArchiveManifestSha256,
    validateBoundRevision,
    validateCompactIndex,
    validateCompleteInputManifest,
    validateImmutableObjectReference,
} = require('../buildings/jarvis/saved-hook-record-binding');
const {
    canonicalJson,
    sha256Canonical,
    validateScoreLedger,
} = require('../buildings/jarvis/shorts-score-ledger');

const DEFAULTS = Object.freeze({
    sourcePrefix: 'raw/saved-hooks',
    archivePrefix: 'raw/saved-hooks-bound/archive-v1',
    canonicalPrefix: 'raw/saved-hooks-bound/canonical-v1',
    revisionPrefix: 'raw/saved-hooks-bound/revisions-v1',
    quarantinePrefix: 'raw/saved-hooks-bound/quarantine-v1',
    indexPrefix: 'raw/saved-hooks-bound/index-v1',
});

function canonicalBytes(value) {
    return Buffer.from(canonicalJson(value), 'utf8');
}

function idFromJsonKey(key) {
    return path.posix.basename(key, '.json');
}

function isSourceRecordKey(key, sourcePrefix) {
    const normalized = String(sourcePrefix).replace(/\/+$/g, '');
    return (
        key.startsWith(`${normalized}/`)
        && key.endsWith('.json')
        && path.posix.dirname(key) === normalized
        && path.posix.basename(key) !== 'index.json'
    );
}

function decodeCanonicalJpeg(result) {
    const encoded = result && (
        result.canonical_jpeg_base64
        || result.montage
    );
    if (typeof encoded !== 'string' || !encoded.trim()) {
        throw new Error('rescore result lacks canonical JPEG bytes');
    }
    const base64 = encoded.includes('base64,')
        ? encoded.slice(encoded.indexOf('base64,') + 7)
        : encoded;
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 4) {
        throw new Error('rescore result canonical JPEG is empty');
    }
    if (
        bytes[0] !== 0xff
        || bytes[1] !== 0xd8
        || bytes[bytes.length - 2] !== 0xff
        || bytes[bytes.length - 1] !== 0xd9
    ) {
        throw new Error('rescore result canonical media is not a JPEG');
    }
    return bytes;
}

async function immutablePut(storage, key, bytes, mediaType, write) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const reference = immutableObjectReference(key, buffer, mediaType);
    const referenceErrors = validateImmutableObjectReference(
        reference,
        'immutable migration object'
    );
    if (referenceErrors.length) {
        throw new Error(referenceErrors.join('; '));
    }
    const existing = await storage.get(key);
    if (existing) {
        const existingBuffer = Buffer.from(existing);
        if (
            existingBuffer.length !== buffer.length
            || sha256Bytes(existingBuffer) !== reference.sha256
            || !existingBuffer.equals(buffer)
        ) {
            throw new Error(
                `immutable key collision at ${key}; existing bytes differ`
            );
        }
        return { reference, disposition: 'verified-existing' };
    }
    if (write) {
        await storage.put(key, buffer, mediaType);
        const downloaded = await storage.get(key);
        if (
            !downloaded
            || !Buffer.from(downloaded).equals(buffer)
        ) {
            throw new Error(
                `immutable object ${key} failed read-after-write audit`
            );
        }
        return { reference, disposition: 'written-and-verified' };
    }
    return { reference, disposition: 'planned' };
}

function rescoreAttestationErrors(
    result,
    sourceJsonSha256,
    sourceJpegSha256
) {
    const attestation = result && result.rescore_attestation;
    const errors = [];
    if (
        !attestation
        || attestation.schema !== 'saved-hook-fresh-rescore-attestation-v1'
        || attestation.mode !== 'fresh_rescore'
    ) {
        errors.push('fresh rescore attestation is missing');
    } else {
        if (attestation.source_json_sha256 !== sourceJsonSha256) {
            errors.push('rescore attestation source JSON hash differs');
        }
        if (attestation.source_jpeg_sha256 !== sourceJpegSha256) {
            errors.push('rescore attestation source JPEG hash differs');
        }
    }
    return errors;
}

async function writeQuarantine(options) {
    const quarantine = {
        schema: 'saved-hook-migration-quarantine-v1',
        schema_version: 1,
        record_id: options.recordId,
        state: 'quarantined',
        classification: 'legacy_unbound_evidence',
        source_json: options.sourceJsonReference,
        source_jpeg: options.sourceJpegReference || null,
        source_archive_manifest:
            options.sourceArchiveManifestReference || null,
        failure_stage: options.failureStage,
        reason: String(options.reason || 'migration failed'),
        legacy_evidence: {
            has_steer: !!options.hasSteer,
            has_features: !!options.hasFeatures,
            submitted_score_ledger_sha256:
                options.submittedLedgerSha256 || null,
        },
    };
    quarantine.quarantine_sha256 = sha256Canonical(quarantine);
    const quarantineBytes = canonicalBytes(quarantine);
    const key = contentAddressedKey(
        options.quarantinePrefix,
        'records',
        sha256Bytes(quarantineBytes),
        '.json'
    );
    const stored = await immutablePut(
        options.storage,
        key,
        quarantineBytes,
        'application/json',
        options.write
    );
    return {
        quarantine,
        reference: stored.reference,
        disposition: stored.disposition,
    };
}

async function auditReference(storage, reference, label) {
    const bytes = await storage.get(reference.key);
    if (!bytes) throw new Error(`${label} object is missing`);
    const buffer = Buffer.from(bytes);
    if (
        buffer.length !== reference.byte_length
        || sha256Bytes(buffer) !== reference.sha256
    ) {
        throw new Error(`${label} object hash or byte length differs`);
    }
    return buffer;
}

async function auditBoundRevision(storage, revision, revisionReference) {
    const structural = validateBoundRevision(revision);
    if (!structural.valid) {
        throw new Error(structural.errors.join('; '));
    }
    const revisionBytes = await auditReference(
        storage,
        revisionReference,
        'bound revision'
    );
    const redownloadedRevision = JSON.parse(
        revisionBytes.toString('utf8')
    );
    if (
        !revisionBytes.equals(canonicalBytes(redownloadedRevision))
        ||
        redownloadedRevision.revision_sha256 !== revision.revision_sha256
        || sha256Canonical(revisionBindingPayload(redownloadedRevision))
            !== revision.revision_sha256
    ) {
        throw new Error('redownloaded bound revision identity differs');
    }

    const sourceJson = await auditReference(
        storage,
        revision.source_archive.original_json,
        'archived source JSON'
    );
    JSON.parse(sourceJson.toString('utf8'));
    await auditReference(
        storage,
        revision.source_archive.original_jpeg,
        'archived source JPEG'
    );
    const archiveManifestBytes = await auditReference(
        storage,
        revision.source_archive_manifest,
        'source archive manifest'
    );
    const archiveManifest = JSON.parse(
        archiveManifestBytes.toString('utf8')
    );
    if (
        sourceArchiveManifestSha256(archiveManifest)
            !== revision.source_archive_manifest_sha256
        || canonicalJson(archiveManifest)
            !== canonicalJson(revision.source_archive)
    ) {
        throw new Error('source archive manifest hash edge differs');
    }

    const canonicalJpeg = await auditReference(
        storage,
        revision.canonical_jpeg,
        'canonical JPEG'
    );
    const inputManifestBytes = await auditReference(
        storage,
        revision.input_manifest,
        'input manifest'
    );
    const inputManifest = JSON.parse(
        inputManifestBytes.toString('utf8')
    );
    const ledgerBytes = await auditReference(
        storage,
        revision.score_ledger.reference,
        'score ledger'
    );
    const scoreLedger = JSON.parse(ledgerBytes.toString('utf8'));
    const ledgerValidation = validateScoreLedger(scoreLedger);
    if (!ledgerValidation.valid) {
        throw new Error(
            `redownloaded score ledger is invalid: ${
                ledgerValidation.errors.join('; ')
            }`
        );
    }
    if (
        scoreLedger.ledger_sha256
            !== revision.score_ledger.ledger_sha256
    ) {
        throw new Error('score ledger identity hash edge differs');
    }
    const normalizedTextValue = inputManifest
        && inputManifest.transcript_used
        ? normalizeText(
            inputManifest.channels
            && inputManifest.channels.text
            && inputManifest.channels.text.text
        )
        : '';
    const manifestValidation = validateCompleteInputManifest(
        inputManifest,
        canonicalJpeg,
        normalizedTextValue,
        scoreLedger
    );
    if (!manifestValidation.valid) {
        throw new Error(manifestValidation.errors.join('; '));
    }
    if (
        manifestValidation.manifest_sha256
            !== revision.input_manifest.sha256
        || manifestValidation.normalized_text_sha256
            !== revision.normalized_text.sha256
    ) {
        throw new Error('input manifest or normalized text hash edge differs');
    }

    const resultBytes = await auditReference(
        storage,
        revision.score_result.reference,
        'score result'
    );
    const result = JSON.parse(resultBytes.toString('utf8'));
    const resultHashPayload = { ...result };
    delete resultHashPayload.score_result_sha256;
    if (
        sha256Canonical(resultHashPayload)
            !== revision.score_result.score_result_sha256
        || result.score_result_sha256
            !== revision.score_result.score_result_sha256
        || result.canonical_jpeg_sha256
            !== revision.canonical_jpeg.sha256
        || result.normalized_text_sha256
            !== revision.normalized_text.sha256
        || result.input_manifest_sha256
            !== revision.input_manifest.sha256
        || result.score_input_fingerprint
            !== revision.canonical_input_identity
                .score_input_fingerprint
        || result.score_ledger_sha256
            !== revision.score_ledger.ledger_sha256
    ) {
        throw new Error('score result hash edge differs');
    }
    return {
        valid: true,
        record_id: revision.record_id,
        revision_sha256: revision.revision_sha256,
    };
}

async function loadExistingRevisions(storage, revisionPrefix) {
    const bySource = new Map();
    const keys = (await storage.list(revisionPrefix))
        .filter(key => key.endsWith('.json'))
        .sort();
    for (const key of keys) {
        let candidate = null;
        try {
            const bytes = await storage.get(key);
            if (!bytes) continue;
            const revision = JSON.parse(Buffer.from(bytes).toString('utf8'));
            const validation = validateBoundRevision(revision);
            if (!validation.valid) continue;
            const reference = immutableObjectReference(
                key,
                bytes,
                'application/json'
            );
            if (
                validateImmutableObjectReference(
                    reference,
                    'existing bound revision'
                ).length
                || !Buffer.from(bytes).equals(canonicalBytes(revision))
            ) {
                continue;
            }
            const sourceKey = [
                revision.record_id,
                revision.source_archive.original_json.sha256,
                revision.source_archive.original_jpeg.sha256,
            ].join(':');
            candidate = { sourceKey, revision, reference };
        } catch (_error) {
            // Invalid historical migration products are never resumed.
            continue;
        }
        const existing = bySource.get(candidate.sourceKey);
        if (
            existing
            && (
                existing.revision.revision_sha256
                    !== candidate.revision.revision_sha256
                || existing.reference.sha256
                    !== candidate.reference.sha256
            )
        ) {
            throw new Error(
                `ambiguous bound revisions for source ${candidate.sourceKey}`
            );
        }
        bySource.set(candidate.sourceKey, {
            revision: candidate.revision,
            reference: candidate.reference,
        });
    }
    return bySource;
}

async function migrateOne(options) {
    const jsonKey = options.jsonKey;
    const recordId = idFromJsonKey(jsonKey);
    const jpegKey = `${options.sourcePrefix}/${recordId}.jpg`;
    const jsonBytes = await options.storage.get(jsonKey);
    if (!jsonBytes) {
        throw new Error(`source JSON disappeared: ${jsonKey}`);
    }
    let record;
    try {
        record = JSON.parse(Buffer.from(jsonBytes).toString('utf8'));
    } catch (error) {
        throw new Error(`source JSON is invalid: ${error.message}`);
    }
    const classification = classifyHistoricalSavedHook(record);
    const sourceJsonSha256 = sha256Bytes(jsonBytes);
    const jsonArchiveKey = contentAddressedKey(
        options.archivePrefix,
        'json',
        sourceJsonSha256,
        '.json'
    );
    const sourceJsonStored = await immutablePut(
        options.storage,
        jsonArchiveKey,
        jsonBytes,
        'application/json',
        options.write
    );
    const jpegBytes = await options.storage.get(jpegKey);
    if (!jpegBytes) {
        const quarantine = await writeQuarantine({
            ...options,
            recordId,
            sourceJsonReference: {
                source_key: jsonKey,
                ...sourceJsonStored.reference,
            },
            sourceJpegReference: null,
            failureStage: 'source_archive',
            reason: 'source JPEG is missing',
            hasSteer: !!record.steer,
            hasFeatures: !!record.features,
            submittedLedgerSha256:
                record.score_ledger && record.score_ledger.ledger_sha256,
        });
        return { state: 'quarantined', recordId, quarantine };
    }

    const sourceJpegSha256 = sha256Bytes(jpegBytes);
    const jpegArchiveKey = contentAddressedKey(
        options.archivePrefix,
        'jpeg',
        sourceJpegSha256,
        '.jpg'
    );
    const sourceJpegStored = await immutablePut(
        options.storage,
        jpegArchiveKey,
        jpegBytes,
        'image/jpeg',
        options.write
    );
    const sourceArchive = sourceArchiveManifest({
        recordId,
        jsonSourceKey: jsonKey,
        jpegSourceKey: jpegKey,
        jsonBytes,
        jpegBytes,
        archivePrefix: options.archivePrefix,
    });
    const sourceArchiveBytes = canonicalBytes(sourceArchive);
    const sourceArchiveSha256 = sourceArchiveManifestSha256(sourceArchive);
    const sourceArchiveKey = contentAddressedKey(
        options.archivePrefix,
        'manifests',
        sourceArchiveSha256,
        '.json'
    );
    const sourceArchiveStored = await immutablePut(
        options.storage,
        sourceArchiveKey,
        sourceArchiveBytes,
        'application/json',
        options.write
    );

    const resumeKey = [
        recordId,
        sourceJsonSha256,
        sourceJpegSha256,
    ].join(':');
    const resumed = options.existingRevisions.get(resumeKey);
    if (resumed) {
        await auditBoundRevision(
            options.storage,
            resumed.revision,
            resumed.reference
        );
        return {
            state: 'verified',
            recordId,
            revision: resumed.revision,
            revisionReference: resumed.reference,
            resumed: true,
        };
    }

    if (typeof options.rescore !== 'function') {
        const quarantine = await writeQuarantine({
            ...options,
            recordId,
            sourceJsonReference: sourceArchive.original_json,
            sourceJpegReference: sourceArchive.original_jpeg,
            sourceArchiveManifestReference:
                sourceArchiveStored.reference,
            failureStage: 'rescore',
            reason: (
                'fresh rescore required; historical steer/features and '
                + 'unbound scores cannot become canonical'
            ),
            hasSteer: !!record.steer,
            hasFeatures: !!record.features,
            submittedLedgerSha256:
                record.score_ledger && record.score_ledger.ledger_sha256,
        });
        return {
            state: 'quarantined',
            recordId,
            classification,
            quarantine,
        };
    }

    try {
        const result = await options.rescore({
            schema: 'saved-hook-rescore-request-v1',
            record_id: recordId,
            source_json_key: jsonKey,
            source_jpeg_key: jpegKey,
            source_json_sha256: sourceJsonSha256,
            source_jpeg_sha256: sourceJpegSha256,
            source_json_base64: Buffer.from(jsonBytes).toString('base64'),
            source_jpeg_base64: Buffer.from(jpegBytes).toString('base64'),
            historical_record: record,
            historical_evidence_classification:
                'legacy_unbound_evidence',
        });
        const attestationErrors = rescoreAttestationErrors(
            result,
            sourceJsonSha256,
            sourceJpegSha256
        );
        if (attestationErrors.length) {
            throw new Error(attestationErrors.join('; '));
        }
        const canonicalJpeg = decodeCanonicalJpeg(result);
        const builtResult = scoreResultArtifact(result, canonicalJpeg);
        const scoreResult = builtResult.artifact;

        const canonicalJpegKey = contentAddressedKey(
            options.canonicalPrefix,
            'jpeg',
            sha256Bytes(canonicalJpeg),
            '.jpg'
        );
        const canonicalJpegStored = await immutablePut(
            options.storage,
            canonicalJpegKey,
            canonicalJpeg,
            'image/jpeg',
            options.write
        );
        const manifestBytes = canonicalBytes(result.input_manifest);
        const manifestKey = contentAddressedKey(
            options.canonicalPrefix,
            'input-manifests',
            sha256Bytes(manifestBytes),
            '.json'
        );
        const manifestStored = await immutablePut(
            options.storage,
            manifestKey,
            manifestBytes,
            'application/json',
            options.write
        );
        const ledgerBytes = canonicalBytes(result.score_ledger);
        const ledgerKey = contentAddressedKey(
            options.canonicalPrefix,
            'score-ledgers',
            sha256Bytes(ledgerBytes),
            '.json'
        );
        const ledgerStored = await immutablePut(
            options.storage,
            ledgerKey,
            ledgerBytes,
            'application/json',
            options.write
        );
        const resultBytes = canonicalBytes(scoreResult);
        const resultKey = contentAddressedKey(
            options.canonicalPrefix,
            'score-results',
            sha256Bytes(resultBytes),
            '.json'
        );
        const resultStored = await immutablePut(
            options.storage,
            resultKey,
            resultBytes,
            'application/json',
            options.write
        );
        const revision = buildBoundRevision({
            recordId,
            sourceArchive,
            sourceArchiveManifestReference:
                sourceArchiveStored.reference,
            canonicalJpegReference: canonicalJpegStored.reference,
            normalizedText: builtResult.normalizedText,
            inputManifestReference: manifestStored.reference,
            scoreLedgerReference: ledgerStored.reference,
            scoreResultReference: resultStored.reference,
            scoreResultArtifact: scoreResult,
        });
        const revisionBytes = canonicalBytes(revision);
        const revisionKey = contentAddressedKey(
            options.revisionPrefix,
            'records',
            sha256Bytes(revisionBytes),
            '.json'
        );
        const revisionStored = await immutablePut(
            options.storage,
            revisionKey,
            revisionBytes,
            'application/json',
            options.write
        );
        if (options.write) {
            await auditBoundRevision(
                options.storage,
                revision,
                revisionStored.reference
            );
        }
        return {
            state: options.write ? 'verified' : 'planned',
            recordId,
            revision,
            revisionReference: revisionStored.reference,
            resumed: false,
        };
    } catch (error) {
        const quarantine = await writeQuarantine({
            ...options,
            recordId,
            sourceJsonReference: sourceArchive.original_json,
            sourceJpegReference: sourceArchive.original_jpeg,
            sourceArchiveManifestReference:
                sourceArchiveStored.reference,
            failureStage: 'fresh_rescore_validation',
            reason: error.message,
            hasSteer: !!record.steer,
            hasFeatures: !!record.features,
            submittedLedgerSha256:
                record.score_ledger && record.score_ledger.ledger_sha256,
        });
        return {
            state: 'quarantined',
            recordId,
            classification,
            quarantine,
        };
    }
}

async function migrateSavedHooks(options) {
    const settings = { ...DEFAULTS, ...options };
    if (
        !settings.storage
        || typeof settings.storage.get !== 'function'
        || typeof settings.storage.put !== 'function'
        || typeof settings.storage.list !== 'function'
    ) {
        throw new Error('migration requires a storage adapter');
    }
    settings.write = settings.write === true;
    settings.existingRevisions = await loadExistingRevisions(
        settings.storage,
        settings.revisionPrefix
    );
    const sourceKeys = (await settings.storage.list(
        settings.sourcePrefix
    ))
        .filter(key => isSourceRecordKey(key, settings.sourcePrefix))
        .sort();
    const records = [];
    for (const jsonKey of sourceKeys) {
        try {
            records.push(await migrateOne({ ...settings, jsonKey }));
        } catch (error) {
            records.push({
                state: 'fatal',
                recordId: idFromJsonKey(jsonKey),
                error: error.message,
            });
        }
    }

    const verified = records.filter(record => (
        record.state === 'verified'
        || (
            record.state === 'planned'
            && settings.write !== true
        )
    ));
    const rows = verified.map(record => (
        compactIndexRow(record.revision, record.revisionReference)
    ));
    const index = buildCompactIndex(rows);
    const indexBytes = canonicalCompactIndexBytes(index);
    const indexKey = contentAddressedKey(
        settings.indexPrefix,
        'indexes',
        sha256Bytes(indexBytes),
        '.json'
    );
    const indexStored = await immutablePut(
        settings.storage,
        indexKey,
        indexBytes,
        'application/json',
        settings.write
    );
    if (settings.write) {
        const redownloaded = await auditReference(
            settings.storage,
            indexStored.reference,
            'compact index'
        );
        const auditedIndex = JSON.parse(redownloaded.toString('utf8'));
        if (
            !redownloaded.equals(canonicalCompactIndexBytes(auditedIndex))
            || auditedIndex.index_sha256 !== index.index_sha256
            || !validateCompactIndex(auditedIndex).valid
        ) {
            throw new Error('redownloaded compact index hash differs');
        }
    }
    return {
        schema: 'saved-hook-provenance-migration-report-v1',
        mode: settings.write ? 'write' : 'audit-dry-run',
        source_count: sourceKeys.length,
        verified_count: records.filter(
            record => record.state === 'verified'
        ).length,
        planned_count: records.filter(
            record => record.state === 'planned'
        ).length,
        quarantined_count: records.filter(
            record => record.state === 'quarantined'
        ).length,
        fatal_count: records.filter(
            record => record.state === 'fatal'
        ).length,
        compact_index: {
            key: indexKey,
            sha256: index.index_sha256,
            artifact_sha256: indexStored.reference.sha256,
            row_count: index.row_count,
            disposition: indexStored.disposition,
        },
        records,
    };
}

function commandRescorer(command, args) {
    return async request => {
        const run = spawnSync(command, args || [], {
            input: `${JSON.stringify(request)}\n`,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            shell: false,
        });
        if (run.error) throw run.error;
        if (run.status !== 0) {
            throw new Error(
                `rescore command exited ${run.status}: ${
                    String(run.stderr || '').trim().slice(0, 2000)
                }`
            );
        }
        const output = String(run.stdout || '').trim();
        if (!output) throw new Error('rescore command returned no JSON');
        try {
            return JSON.parse(output);
        } catch (error) {
            throw new Error(
                `rescore command returned invalid JSON: ${error.message}`
            );
        }
    };
}

function parseArguments(argv) {
    const options = {
        write: false,
        rescoreCommand: null,
        rescoreArgs: [],
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--write') {
            options.write = true;
        } else if (argument === '--rescore-command') {
            options.rescoreCommand = argv[++index];
        } else if (argument === '--rescore-arg') {
            options.rescoreArgs.push(argv[++index]);
        } else if (argument === '--source-prefix') {
            options.sourcePrefix = argv[++index];
        } else if (argument === '--archive-prefix') {
            options.archivePrefix = argv[++index];
        } else if (argument === '--canonical-prefix') {
            options.canonicalPrefix = argv[++index];
        } else if (argument === '--revision-prefix') {
            options.revisionPrefix = argv[++index];
        } else if (argument === '--quarantine-prefix') {
            options.quarantinePrefix = argv[++index];
        } else if (argument === '--index-prefix') {
            options.indexPrefix = argv[++index];
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
        'Usage: node scripts/migrate-saved-hooks-to-bound-records.js [options]',
        '',
        'Defaults to an audit/dry-run. No source objects are ever replaced.',
        '  --write                  Write immutable archive/migration objects',
        '  --rescore-command PATH   Fresh scorer executable (JSON stdin/stdout)',
        '  --rescore-arg VALUE      Repeatable scorer argument',
        '  --source-prefix PREFIX   Historical saved-hook source prefix',
        '  --archive-prefix PREFIX  Content-addressed source archive prefix',
        '  --canonical-prefix PREFIX  Canonical rescore artifact prefix',
        '  --revision-prefix PREFIX Content-addressed revision prefix',
        '  --quarantine-prefix PREFIX  Quarantine record prefix',
        '  --index-prefix PREFIX    Hash-addressed compact index prefix',
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
    const cloud = require('../cloud-storage');
    if (!cloud.initR2()) {
        throw new Error('R2 credentials are not configured');
    }
    const report = await migrateSavedHooks({
        ...options,
        storage: cloudStorageAdapter(cloud),
        rescore: options.rescoreCommand
            ? commandRescorer(
                options.rescoreCommand,
                options.rescoreArgs
            )
            : null,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.fatal_count) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULTS,
    auditBoundRevision,
    canonicalBytes,
    cloudStorageAdapter,
    commandRescorer,
    decodeCanonicalJpeg,
    immutablePut,
    loadExistingRevisions,
    migrateSavedHooks,
    parseArguments,
    rescoreAttestationErrors,
};
