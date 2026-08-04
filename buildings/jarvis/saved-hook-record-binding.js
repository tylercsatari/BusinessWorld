'use strict';

const crypto = require('crypto');
const {
    canonicalJson,
    sha256Canonical,
    validateScoreLedger,
    validateShortsInputManifest,
} = require('./shorts-score-ledger');
const {
    canonicalArtifactIdentity,
    canonicalJsonBytes,
} = require('./canonical-json-artifact');

const RECORD_SCHEMA = 'saved-hook-bound-revision-v1';
const RECORD_SCHEMA_VERSION = 1;
const INDEX_SCHEMA = 'saved-hook-bound-index-v1';
const INDEX_SCHEMA_VERSION = 1;
const TEXT_NORMALIZATION = 'unicode-nfkc-whitespace-v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BOUND_REVISION_KEYS = Object.freeze([
    'schema',
    'schema_version',
    'state',
    'record_id',
    'source_archive',
    'source_archive_manifest_sha256',
    'source_archive_manifest',
    'canonical_jpeg',
    'normalized_text',
    'input_manifest',
    'canonical_input_identity',
    'score_ledger',
    'scorer_identity',
    'score_result',
    'migration',
    'revision_sha256',
]);
const COMPACT_INDEX_ROW_KEYS = Object.freeze([
    'schema',
    'record_id',
    'revision_sha256',
    'revision',
    'source_json_sha256',
    'source_jpeg_sha256',
    'canonical_jpeg_sha256',
    'normalized_text_sha256',
    'input_manifest_sha256',
    'canonical_input_sha256',
    'score_ledger_sha256',
    'score_result_sha256',
    'scorer_revision_fingerprint',
    'row_sha256',
]);
const COMPACT_INDEX_KEYS = Object.freeze([
    'schema',
    'schema_version',
    'row_count',
    'rows',
    'index_sha256',
]);

function jsonClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sha256Bytes(value) {
    return crypto
        .createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : Buffer.from(value))
        .digest('hex');
}

function normalizeText(value) {
    return String(value == null ? '' : value)
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizePrefix(value) {
    return String(value || '').replace(/^\/+|\/+$/g, '');
}

function contentAddressedKey(prefix, category, sha256, extension) {
    if (!HASH_PATTERN.test(String(sha256 || ''))) {
        throw new Error('content-addressed key requires a SHA-256 digest');
    }
    const base = [normalizePrefix(prefix), normalizePrefix(category)]
        .filter(Boolean)
        .join('/');
    return `${base}/${sha256}${extension || ''}`;
}

function immutableObjectReference(key, bytes, mediaType) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return {
        key: String(key),
        sha256: sha256Bytes(buffer),
        byte_length: buffer.length,
        media_type: mediaType || 'application/octet-stream',
    };
}

function validateImmutableObjectReference(reference, label) {
    const errors = [];
    const name = label || 'object';
    if (!reference || typeof reference !== 'object') {
        return [`${name} reference is missing`];
    }
    if (!String(reference.key || '').trim()) {
        errors.push(`${name} key is missing`);
    }
    if (!HASH_PATTERN.test(String(reference.sha256 || ''))) {
        errors.push(`${name} SHA-256 is invalid`);
    }
    if (
        !Number.isSafeInteger(reference.byte_length)
        || reference.byte_length < 0
    ) {
        errors.push(`${name} byte length is invalid`);
    }
    if (!String(reference.media_type || '').trim()) {
        errors.push(`${name} media type is missing`);
    }
    const leaf = String(reference.key || '').split('/').pop() || '';
    const addressedDigest = leaf.split('.')[0];
    if (
        HASH_PATTERN.test(String(reference.sha256 || ''))
        && addressedDigest !== reference.sha256
    ) {
        errors.push(`${name} key is not addressed by its byte hash`);
    }
    return errors;
}

function sourceArchiveManifest(options) {
    const jsonBytes = Buffer.isBuffer(options.jsonBytes)
        ? options.jsonBytes
        : Buffer.from(options.jsonBytes);
    const jpegBytes = Buffer.isBuffer(options.jpegBytes)
        ? options.jpegBytes
        : Buffer.from(options.jpegBytes);
    const archivePrefix = normalizePrefix(options.archivePrefix);
    const jsonSha256 = sha256Bytes(jsonBytes);
    const jpegSha256 = sha256Bytes(jpegBytes);
    return {
        schema: 'saved-hook-source-archive-v1',
        schema_version: 1,
        record_id: String(options.recordId),
        original_json: {
            source_key: String(options.jsonSourceKey),
            ...immutableObjectReference(
                contentAddressedKey(
                    archivePrefix,
                    'json',
                    jsonSha256,
                    '.json'
                ),
                jsonBytes,
                'application/json'
            ),
        },
        original_jpeg: {
            source_key: String(options.jpegSourceKey),
            ...immutableObjectReference(
                contentAddressedKey(
                    archivePrefix,
                    'jpeg',
                    jpegSha256,
                    '.jpg'
                ),
                jpegBytes,
                'image/jpeg'
            ),
        },
    };
}

function sourceArchiveManifestSha256(manifest) {
    return sha256Canonical(manifest);
}

function classifyHistoricalSavedHook(record) {
    const legacyCaches = [];
    if (record && Object.prototype.hasOwnProperty.call(record, 'steer')) {
        legacyCaches.push('steer');
    }
    if (record && Object.prototype.hasOwnProperty.call(record, 'features')) {
        legacyCaches.push('features');
    }
    const exactProvenancePresent = !!(
        record
        && record.bound_revision
        && record.bound_revision.schema === RECORD_SCHEMA
        && HASH_PATTERN.test(
            String(record.bound_revision.revision_sha256 || '')
        )
    );
    if (legacyCaches.length || !exactProvenancePresent) {
        return {
            classification: 'legacy_unbound_evidence',
            canonical: false,
            requires_rescore: true,
            legacy_caches: legacyCaches,
            reason: legacyCaches.length
                ? 'historical score caches lack exact media/input provenance'
                : 'historical record lacks a verified bound revision',
        };
    }
    return {
        classification: 'bound_revision_candidate',
        canonical: false,
        requires_rescore: false,
        legacy_caches: [],
        reason: 'candidate must still pass full revision and object audit',
    };
}

function manifestText(manifest) {
    const textChannel = manifest
        && manifest.channels
        && manifest.channels.text;
    if (!manifest || manifest.transcript_used !== true) return '';
    return normalizeText(textChannel && textChannel.text);
}

function validateCompleteInputManifest(
    manifest,
    canonicalJpegBytes,
    normalizedTextValue,
    scoreLedger
) {
    const errors = [];
    const jpegBytes = Buffer.isBuffer(canonicalJpegBytes)
        ? canonicalJpegBytes
        : Buffer.from(canonicalJpegBytes || '');
    const jpegSha256 = sha256Bytes(jpegBytes);
    const normalized = normalizeText(normalizedTextValue);
    const requiredStrings = [
        'domain',
        'scorer',
        'embedding_model',
        'source_window',
        'feature_contract_sha256',
        'feature_contract_document_sha256',
        'coordinate_governance_sha256',
        'input_fingerprint',
        'score_input_fingerprint',
        'embedding_input_fingerprint',
        'revision_fingerprint',
        'output_fingerprint',
    ];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return {
            valid: false,
            errors: ['complete input manifest is missing'],
            manifest_sha256: null,
            normalized_text: normalized,
            normalized_text_sha256:
                sha256Bytes(Buffer.from(normalized, 'utf8')),
        };
    }
    requiredStrings.forEach(field => {
        if (!String(manifest[field] || '').trim()) {
            errors.push(`input manifest ${field} is missing`);
        }
    });
    for (const field of [
        'input_fingerprint',
        'score_input_fingerprint',
        'embedding_input_fingerprint',
        'revision_fingerprint',
        'output_fingerprint',
        'feature_contract_sha256',
        'feature_contract_document_sha256',
        'coordinate_governance_sha256',
    ]) {
        if (
            manifest[field] != null
            && !HASH_PATTERN.test(String(manifest[field]))
        ) {
            errors.push(`input manifest ${field} is not SHA-256`);
        }
    }
    if (
        !Number.isSafeInteger(manifest.embedding_dimensions)
        || manifest.embedding_dimensions <= 0
    ) {
        errors.push('input manifest embedding_dimensions is invalid');
    }
    if (
        manifest.duration_s != null
        && (
            !Number.isFinite(Number(manifest.duration_s))
            || Number(manifest.duration_s) < 0
        )
    ) {
        errors.push('input manifest duration_s is invalid');
    }
    if (typeof manifest.transcript_used !== 'boolean') {
        errors.push('input manifest transcript_used is missing');
    }
    if (
        !manifest.scorer_revisions
        || typeof manifest.scorer_revisions !== 'object'
        || Array.isArray(manifest.scorer_revisions)
    ) {
        errors.push('input manifest scorer_revisions is incomplete');
    }
    const montage = manifest.canonical_montage;
    if (!montage || typeof montage !== 'object') {
        errors.push('input manifest canonical_montage is missing');
    } else {
        if (montage.montage_sha256 !== jpegSha256) {
            errors.push(
                'input manifest canonical montage does not match JPEG bytes'
            );
        }
        if (
            !Number.isSafeInteger(montage.width)
            || montage.width <= 0
            || !Number.isSafeInteger(montage.height)
            || montage.height <= 0
            || String(montage.format || '').toUpperCase() !== 'JPEG'
        ) {
            errors.push(
                'input manifest canonical montage geometry is incomplete'
            );
        }
    }
    const channels = manifest.channels;
    for (const channel of ['visual', 'text', 'together']) {
        if (
            !channels
            || !channels[channel]
            || typeof channels[channel] !== 'object'
            || typeof channels[channel].present !== 'boolean'
            || typeof channels[channel].input !== 'string'
            || typeof channels[channel].image !== 'string'
            || typeof channels[channel].text !== 'string'
        ) {
            errors.push(`input manifest ${channel} channel is incomplete`);
        }
    }
    if (manifestText(manifest) !== normalized) {
        errors.push(
            'normalized text does not match the input manifest text channel'
        );
    }
    const exactInputValidation = validateShortsInputManifest(
        { input_manifest: manifest },
        {
            montageBytes: jpegBytes,
            text: normalized,
            durationS: manifest.duration_s,
            creatorProfile: manifest.creator_profile,
        }
    );
    if (!exactInputValidation.valid) {
        errors.push(...exactInputValidation.errors);
    }
    if (manifest.input_fingerprint !== manifest.score_input_fingerprint) {
        errors.push(
            'input manifest input and score-input fingerprints differ'
        );
    }
    const ledgerValidation = validateScoreLedger(scoreLedger);
    if (!ledgerValidation.valid) {
        errors.push(
            `canonical Shorts score ledger is invalid: ${
                ledgerValidation.errors.join('; ')
            }`
        );
    } else {
        if (
            manifest.feature_contract_sha256
                !== scoreLedger.feature_contract_sha256
            || manifest.feature_contract_document_sha256
                !== scoreLedger.feature_contract_document_sha256
            || manifest.coordinate_governance_sha256
                !== scoreLedger.coordinate_governance_sha256
            || manifest.coordinate_governance_version
                !== scoreLedger.coordinate_governance_version
        ) {
            errors.push(
                'input manifest and score ledger contract revisions differ'
            );
        }
    }
    return {
        valid: errors.length === 0,
        errors,
        manifest_sha256: sha256Canonical(manifest),
        normalized_text: normalized,
        normalized_text_sha256:
            sha256Bytes(Buffer.from(normalized, 'utf8')),
        canonical_jpeg_sha256: jpegSha256,
    };
}

function scorerIdentityFromManifest(manifest) {
    return {
        schema: 'saved-hook-scorer-identity-v1',
        scorer: manifest.scorer,
        revision_fingerprint: manifest.revision_fingerprint,
        scorer_revisions_sha256: sha256Canonical(
            manifest.scorer_revisions
        ),
        embedding_model: manifest.embedding_model,
        embedding_dimensions: manifest.embedding_dimensions,
        feature_contract_sha256: manifest.feature_contract_sha256,
        feature_contract_document_sha256:
            manifest.feature_contract_document_sha256,
        coordinate_governance_version:
            manifest.coordinate_governance_version,
        coordinate_governance_sha256:
            manifest.coordinate_governance_sha256,
    };
}

function scoreResultArtifact(rescoreResult, canonicalJpegBytes) {
    const inputManifest = rescoreResult && rescoreResult.input_manifest;
    const scoreLedger = rescoreResult && rescoreResult.score_ledger;
    const normalizedTextValue = normalizeText(
        rescoreResult && (
            rescoreResult.normalized_text
            ?? rescoreResult.transcript
            ?? ''
        )
    );
    const manifestValidation = validateCompleteInputManifest(
        inputManifest,
        canonicalJpegBytes,
        normalizedTextValue,
        scoreLedger
    );
    if (!manifestValidation.valid) {
        throw new Error(manifestValidation.errors.join('; '));
    }
    const artifact = {
        schema: 'saved-hook-canonical-score-result-v1',
        schema_version: 1,
        scorer_identity: scorerIdentityFromManifest(inputManifest),
        input_manifest_sha256: manifestValidation.manifest_sha256,
        canonical_jpeg_sha256:
            manifestValidation.canonical_jpeg_sha256,
        normalized_text_sha256:
            manifestValidation.normalized_text_sha256,
        score_ledger_sha256: scoreLedger.ledger_sha256,
        score_input_fingerprint:
            inputManifest.score_input_fingerprint,
        output_fingerprint: inputManifest.output_fingerprint,
        scorer_output_sha256: sha256Canonical(rescoreResult),
    };
    artifact.score_result_sha256 = sha256Canonical(artifact);
    return {
        artifact,
        normalizedText: manifestValidation.normalized_text,
    };
}

function revisionBindingPayload(revision) {
    const payload = jsonClone(revision);
    if (payload) delete payload.revision_sha256;
    return payload;
}

function buildBoundRevision(options) {
    const scoreResult = options.scoreResultArtifact;
    const sourceArchive = options.sourceArchive;
    const sourceArchiveSha256 = sourceArchiveManifestSha256(sourceArchive);
    const normalized = normalizeText(options.normalizedText);
    const normalizedTextIdentity = {
        normalization: TEXT_NORMALIZATION,
        sha256: sha256Bytes(Buffer.from(normalized, 'utf8')),
        utf8_byte_length: Buffer.byteLength(normalized, 'utf8'),
    };
    const canonicalInputIdentity = {
        schema: 'saved-hook-canonical-input-identity-v1',
        canonical_jpeg_sha256: options.canonicalJpegReference.sha256,
        canonical_jpeg_byte_length:
            options.canonicalJpegReference.byte_length,
        normalized_text_sha256: normalizedTextIdentity.sha256,
        normalized_text_utf8_byte_length:
            normalizedTextIdentity.utf8_byte_length,
        input_manifest_sha256: options.inputManifestReference.sha256,
        score_input_fingerprint:
            scoreResult.score_input_fingerprint,
    };
    canonicalInputIdentity.canonical_input_sha256 = sha256Canonical(
        canonicalInputIdentity
    );
    const revision = {
        schema: RECORD_SCHEMA,
        schema_version: RECORD_SCHEMA_VERSION,
        state: 'canonical_bound',
        record_id: String(options.recordId),
        source_archive: jsonClone(sourceArchive),
        source_archive_manifest_sha256: sourceArchiveSha256,
        source_archive_manifest: jsonClone(
            options.sourceArchiveManifestReference
        ),
        canonical_jpeg: jsonClone(options.canonicalJpegReference),
        normalized_text: normalizedTextIdentity,
        input_manifest: jsonClone(options.inputManifestReference),
        canonical_input_identity: canonicalInputIdentity,
        score_ledger: {
            ledger_sha256: scoreResult.score_ledger_sha256,
            reference: jsonClone(options.scoreLedgerReference),
        },
        scorer_identity: jsonClone(scoreResult.scorer_identity),
        score_result: {
            score_result_sha256: scoreResult.score_result_sha256,
            reference: jsonClone(options.scoreResultReference),
        },
        migration: {
            schema: 'saved-hook-provenance-migration-v1',
            mode: 'fresh_rescore_only',
            historical_evidence_classification:
                'legacy_unbound_evidence',
        },
    };
    revision.revision_sha256 = sha256Canonical(
        revisionBindingPayload(revision)
    );
    return revision;
}

function validateBoundRevision(revision) {
    const errors = [];
    if (!revision || typeof revision !== 'object') {
        return { valid: false, errors: ['bound revision is missing'] };
    }
    if (
        revision.schema !== RECORD_SCHEMA
        || revision.schema_version !== RECORD_SCHEMA_VERSION
        || revision.state !== 'canonical_bound'
    ) {
        errors.push('bound revision schema or state is invalid');
    }
    if (
        canonicalJson(Object.keys(revision).sort())
            !== canonicalJson(BOUND_REVISION_KEYS.slice().sort())
    ) {
        errors.push('bound revision has non-canonical fields');
    }
    if (!String(revision.record_id || '').trim()) {
        errors.push('bound revision record id is missing');
    }
    if (
        !HASH_PATTERN.test(String(revision.revision_sha256 || ''))
        || revision.revision_sha256
            !== sha256Canonical(revisionBindingPayload(revision))
    ) {
        errors.push('bound revision hash does not match');
    }
    const archive = revision.source_archive;
    if (
        !archive
        || archive.schema !== 'saved-hook-source-archive-v1'
        || sourceArchiveManifestSha256(archive)
            !== revision.source_archive_manifest_sha256
    ) {
        errors.push('source archive manifest binding does not match');
    }
    errors.push(
        ...validateImmutableObjectReference(
            archive && archive.original_json,
            'source JSON'
        ),
        ...validateImmutableObjectReference(
            archive && archive.original_jpeg,
            'source JPEG'
        ),
        ...validateImmutableObjectReference(
            revision.source_archive_manifest,
            'source archive manifest'
        ),
        ...validateImmutableObjectReference(
            revision.canonical_jpeg,
            'canonical JPEG'
        ),
        ...validateImmutableObjectReference(
            revision.input_manifest,
            'input manifest'
        ),
        ...validateImmutableObjectReference(
            revision.score_ledger
                && revision.score_ledger.reference,
            'score ledger'
        ),
        ...validateImmutableObjectReference(
            revision.score_result
                && revision.score_result.reference,
            'score result'
        )
    );
    if (
        revision.source_archive_manifest
        && revision.source_archive_manifest.sha256
            !== revision.source_archive_manifest_sha256
    ) {
        errors.push('source archive object hash differs from manifest hash');
    }
    if (
        !revision.score_ledger
        || !HASH_PATTERN.test(
            String(revision.score_ledger.ledger_sha256 || '')
        )
    ) {
        errors.push('canonical score ledger identity is invalid');
    }
    if (
        !revision.score_result
        || !HASH_PATTERN.test(
            String(revision.score_result.score_result_sha256 || '')
        )
    ) {
        errors.push('canonical score result identity is invalid');
    }
    if (
        !revision.normalized_text
        || revision.normalized_text.normalization !== TEXT_NORMALIZATION
        || !HASH_PATTERN.test(
            String(revision.normalized_text.sha256 || '')
        )
        || !Number.isSafeInteger(
            revision.normalized_text.utf8_byte_length
        )
    ) {
        errors.push('normalized text identity is invalid');
    }
    const canonicalInput = revision.canonical_input_identity;
    const canonicalInputPayload = canonicalInput
        ? { ...canonicalInput }
        : null;
    if (canonicalInputPayload) {
        delete canonicalInputPayload.canonical_input_sha256;
    }
    if (
        !canonicalInput
        || canonicalInput.schema
            !== 'saved-hook-canonical-input-identity-v1'
        || canonicalInput.canonical_jpeg_sha256
            !== (revision.canonical_jpeg
                && revision.canonical_jpeg.sha256)
        || canonicalInput.canonical_jpeg_byte_length
            !== (revision.canonical_jpeg
                && revision.canonical_jpeg.byte_length)
        || canonicalInput.normalized_text_sha256
            !== (revision.normalized_text
                && revision.normalized_text.sha256)
        || canonicalInput.normalized_text_utf8_byte_length
            !== (revision.normalized_text
                && revision.normalized_text.utf8_byte_length)
        || canonicalInput.input_manifest_sha256
            !== (revision.input_manifest
                && revision.input_manifest.sha256)
        || !HASH_PATTERN.test(
            String(canonicalInput.score_input_fingerprint || '')
        )
        || canonicalInput.canonical_input_sha256
            !== sha256Canonical(canonicalInputPayload)
    ) {
        errors.push('canonical input identity does not match its inputs');
    }
    return { valid: errors.length === 0, errors };
}

function compactIndexRow(revision, revisionReference) {
    const validation = validateBoundRevision(revision);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    const revisionReferenceErrors = validateImmutableObjectReference(
        revisionReference,
        'bound revision'
    );
    if (revisionReferenceErrors.length) {
        throw new Error(revisionReferenceErrors.join('; '));
    }
    const revisionArtifact = canonicalArtifactIdentity(revision);
    if (
        revisionReference.sha256 !== revisionArtifact.sha256
        || revisionReference.byte_length !== revisionArtifact.byte_length
    ) {
        throw new Error(
            'bound revision reference does not identify its exact canonical bytes'
        );
    }
    const row = {
        schema: 'saved-hook-bound-index-row-v1',
        record_id: revision.record_id,
        revision_sha256: revision.revision_sha256,
        revision: jsonClone(revisionReference),
        source_json_sha256:
            revision.source_archive.original_json.sha256,
        source_jpeg_sha256:
            revision.source_archive.original_jpeg.sha256,
        canonical_jpeg_sha256: revision.canonical_jpeg.sha256,
        normalized_text_sha256: revision.normalized_text.sha256,
        input_manifest_sha256: revision.input_manifest.sha256,
        canonical_input_sha256:
            revision.canonical_input_identity.canonical_input_sha256,
        score_ledger_sha256: revision.score_ledger.ledger_sha256,
        score_result_sha256:
            revision.score_result.score_result_sha256,
        scorer_revision_fingerprint:
            revision.scorer_identity.revision_fingerprint,
    };
    row.row_sha256 = sha256Canonical(row);
    return row;
}

function buildCompactIndex(rows) {
    const sorted = rows
        .map(jsonClone)
        .sort((left, right) => (
            String(left.record_id).localeCompare(String(right.record_id))
            || String(left.revision_sha256)
                .localeCompare(String(right.revision_sha256))
        ));
    const duplicate = sorted.find(
        (row, index) => index > 0
            && row.record_id === sorted[index - 1].record_id
    );
    if (duplicate) {
        throw new Error(
            `compact index has duplicate record id ${duplicate.record_id}`
        );
    }
    sorted.forEach(row => {
        const expected = { ...row };
        delete expected.row_sha256;
        if (
            !HASH_PATTERN.test(String(row.row_sha256 || ''))
            || row.row_sha256 !== sha256Canonical(expected)
        ) {
            throw new Error(
                `compact index row ${row.record_id} has an invalid hash`
            );
        }
    });
    const index = {
        schema: INDEX_SCHEMA,
        schema_version: INDEX_SCHEMA_VERSION,
        row_count: sorted.length,
        rows: sorted,
    };
    index.index_sha256 = sha256Canonical(index);
    const validation = validateCompactIndex(index);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return index;
}

function validateCompactIndex(index) {
    const errors = [];
    if (
        !index
        || typeof index !== 'object'
        || Array.isArray(index)
    ) {
        return {
            valid: false,
            errors: ['saved-hook compact index is missing'],
        };
    }
    if (
        canonicalJson(Object.keys(index).sort())
            !== canonicalJson(COMPACT_INDEX_KEYS.slice().sort())
    ) {
        errors.push('saved-hook compact index has non-canonical fields');
    }
    if (
        index.schema !== INDEX_SCHEMA
        || index.schema_version !== INDEX_SCHEMA_VERSION
        || !Array.isArray(index.rows)
        || index.row_count !== (
            Array.isArray(index.rows) ? index.rows.length : -1
        )
    ) {
        errors.push('saved-hook compact index schema or row count differs');
    }
    const rows = Array.isArray(index.rows) ? index.rows : [];
    const ids = rows.map(row => String(row && row.record_id || ''));
    if (
        ids.some((id, at) => !id || ids.indexOf(id) !== at)
    ) {
        errors.push('saved-hook compact index has duplicate record ids');
    }
    const ordered = rows.slice().sort((left, right) => (
        String(left.record_id).localeCompare(String(right.record_id))
        || String(left.revision_sha256)
            .localeCompare(String(right.revision_sha256))
    ));
    if (canonicalJson(ordered) !== canonicalJson(rows)) {
        errors.push('saved-hook compact index rows are not canonical');
    }
    for (const row of rows) {
        if (
            !row
            || canonicalJson(Object.keys(row).sort())
                !== canonicalJson(COMPACT_INDEX_ROW_KEYS.slice().sort())
        ) {
            errors.push('saved-hook compact index row has non-canonical fields');
            continue;
        }
        const payload = { ...row };
        delete payload.row_sha256;
        if (
            !HASH_PATTERN.test(String(row.row_sha256 || ''))
            || row.row_sha256 !== sha256Canonical(payload)
        ) {
            errors.push(
                `saved-hook compact index row ${row.record_id || '(missing)'} hash differs`
            );
        }
        if (
            validateImmutableObjectReference(
                row.revision,
                'saved-hook compact revision'
            ).length
        ) {
            errors.push(
                `saved-hook compact index row ${row.record_id || '(missing)'} revision reference differs`
            );
        }
    }
    const payload = { ...index };
    delete payload.index_sha256;
    if (
        !HASH_PATTERN.test(String(index.index_sha256 || ''))
        || index.index_sha256 !== sha256Canonical(payload)
    ) {
        errors.push('saved-hook compact index hash differs');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
    };
}

function canonicalCompactIndexBytes(index) {
    const validation = validateCompactIndex(index);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return canonicalJsonBytes(index);
}

module.exports = {
    HASH_PATTERN,
    INDEX_SCHEMA,
    INDEX_SCHEMA_VERSION,
    BOUND_REVISION_KEYS,
    COMPACT_INDEX_KEYS,
    COMPACT_INDEX_ROW_KEYS,
    RECORD_SCHEMA,
    RECORD_SCHEMA_VERSION,
    TEXT_NORMALIZATION,
    buildBoundRevision,
    buildCompactIndex,
    canonicalCompactIndexBytes,
    classifyHistoricalSavedHook,
    compactIndexRow,
    contentAddressedKey,
    immutableObjectReference,
    manifestText,
    normalizeText,
    revisionBindingPayload,
    scoreResultArtifact,
    scorerIdentityFromManifest,
    sha256Bytes,
    sourceArchiveManifest,
    sourceArchiveManifestSha256,
    validateBoundRevision,
    validateCompactIndex,
    validateCompleteInputManifest,
    validateImmutableObjectReference,
};
