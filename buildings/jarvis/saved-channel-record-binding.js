'use strict';

const shortsScoreLedger = require('./shorts-score-ledger');
const manifestBinding = require('./saved-channel-manifest-binding');
const {
    canonicalJsonBytes,
    exactSha256,
    sha256Bytes,
} = require('./canonical-json-artifact');

const SAVED_CHANNEL_ROOT = 'raw/saved-channels/';
const HISTORICAL_EVIDENCE_WARNING = (
    'Historical display evidence only. The stored ledger is not bound '
    + 'to the exact montage and transcript bytes, so this row is '
    + 'excluded from fitting and validation.'
);

function savedChannelRecordArtifactKey(channelId, artifactSha256) {
    if (
        typeof channelId !== 'string'
        || !/^ch[a-f0-9]{16}$/.test(channelId)
    ) {
        throw new Error('saved-channel artifact channel ID is invalid');
    }
    if (!exactSha256(artifactSha256)) {
        throw new Error('saved-channel record artifact SHA-256 is invalid');
    }
    return (
        `${SAVED_CHANNEL_ROOT}${channelId}/video-artifacts/`
        + `by-sha256/${artifactSha256}.json`
    );
}

function bindSavedChannelRecordAndRow(record, row) {
    let recordChanged = false;
    let rowChanged = false;
    const scoreRecordSha256 =
        shortsScoreLedger.scoreRecordBindingSha256(record);
    if (record.score_record_sha256 !== scoreRecordSha256) {
        record.score_record_sha256 = scoreRecordSha256;
        recordChanged = true;
    }
    if (row.score_record_sha256 !== scoreRecordSha256) {
        row.score_record_sha256 = scoreRecordSha256;
        rowChanged = true;
    }
    const recordBytes = canonicalJsonBytes(record);
    const recordArtifactSha256 = sha256Bytes(recordBytes);
    if (
        row.record_artifact_sha256
            !== recordArtifactSha256
    ) {
        row.record_artifact_sha256 =
            recordArtifactSha256;
        rowChanged = true;
    }
    if (row.record_byte_length !== recordBytes.length) {
        row.record_byte_length = recordBytes.length;
        rowChanged = true;
    }
    const manifestRowSha256 =
        manifestBinding.manifestRowBindingSha256(row);
    if (row.manifest_row_sha256 !== manifestRowSha256) {
        row.manifest_row_sha256 = manifestRowSha256;
        rowChanged = true;
    }
    return {
        recordChanged,
        rowChanged,
        scoreRecordSha256,
        recordArtifactSha256,
        recordByteLength: recordBytes.length,
        manifestRowSha256,
    };
}

function resolveScoreLedger(ledger, options = {}) {
    const current = shortsScoreLedger.validateScoreLedger(ledger);
    if (current.valid) {
        return {
            valid: true,
            state: 'canonical-current',
            ledger,
            originalLedgerSha256: ledger.ledger_sha256,
            errors: [],
        };
    }
    if (options.allowPriorRevisionMigration !== true) {
        return {
            valid: false,
            state: 'migration-required',
            ledger: null,
            originalLedgerSha256: null,
            errors: [
                ...current.errors,
                'prior ledger migration is allowed only in the explicit offline migration tool',
            ],
        };
    }
    const prior =
        shortsScoreLedger.validatePriorCanonicalScoreLedger(ledger);
    return prior.valid
        ? {
            valid: true,
            state: 'canonical-prior',
            ledger: prior.migratedLedger,
            originalLedgerSha256: ledger.ledger_sha256,
            errors: [],
        }
        : {
            valid: false,
            state: 'invalid',
            ledger: null,
            originalLedgerSha256: null,
            errors: [...current.errors, ...prior.errors],
        };
}

function classifySavedChannelInputEvidence(record, montageBytes) {
    const ledgerValidation =
        shortsScoreLedger.validateScoreLedger(
            record && record.score_ledger
        );
    const text = record && (
        record.text !== undefined
            ? record.text
            : record.transcript || ''
    );
    const inputValidation =
        shortsScoreLedger.validateShortsInputManifest(
            record,
            {
                montageBytes,
                text,
                durationS:
                    record
                    && record.input_manifest
                    && record.input_manifest.duration_s,
                creatorProfile:
                    record
                    && record.input_manifest
                    && record.input_manifest.creator_profile,
            }
        );
    const nonCanonicalProvenance = (
        ledgerValidation.entries || []
    ).filter(entry => {
        const status = entry
            && entry.provenance
            && entry.provenance.status;
        return [
            'historical_materialization',
            'conflict',
        ].includes(status);
    });
    const errors = [
        ...(ledgerValidation.errors || []),
        ...(inputValidation.errors || []),
    ];
    if (nonCanonicalProvenance.length) {
        errors.push(
            'score ledger contains historical or conflicting provenance'
        );
    }
    const canonical = errors.length === 0;
    return {
        valid: canonical,
        state: canonical
            ? manifestBinding.CANONICAL_EVIDENCE_STATE
            : manifestBinding.HISTORICAL_EVIDENCE_STATE,
        canonical,
        predictor_eligible: canonical,
        warning: canonical ? null : HISTORICAL_EVIDENCE_WARNING,
        errors: [...new Set(errors)],
        input_validation: inputValidation,
        ledger_validation: ledgerValidation,
    };
}

function applySavedChannelEvidenceState(row, evidence) {
    const next = {
        evidence_state: evidence.state,
        canonical: evidence.canonical === true,
        predictor_eligible:
            evidence.predictor_eligible === true,
        evidence_warning: evidence.warning || null,
    };
    let changed = false;
    for (const [field, value] of Object.entries(next)) {
        if (row[field] !== value) {
            row[field] = value;
            changed = true;
        }
    }
    return changed;
}

function validateSavedChannelEvidenceState(
    record,
    row,
    montageBytes
) {
    const classified =
        classifySavedChannelInputEvidence(record, montageBytes);
    const errors = manifestBinding.validateEvidenceState(row);
    if (
        row
        && (
            row.evidence_state !== classified.state
            || row.canonical !== classified.canonical
            || row.predictor_eligible
                !== classified.predictor_eligible
            || (row.evidence_warning || null)
                !== classified.warning
        )
    ) {
        errors.push(
            'saved-channel declared evidence state differs from exact input evidence'
        );
    }
    return {
        ...classified,
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        source_limitations: classified.errors,
        declared_state: row && row.evidence_state || null,
    };
}

function canonicalizeSavedChannelRecordBinding(
    record,
    row,
    options = {}
) {
    const errors = [];
    let legacyMaterialized = false;
    if (
        !record
        || !row
        || row.status !== 'done'
        || String(
            record.id
            || record.savedChannelVideoId
            || record.sourceVideoId
            || record.videoId
            || ''
        ) !== String(row.id || '')
    ) {
        errors.push('saved-channel full record identity differs');
    }
    if (
        record
        && row
        && !record.score_ledger
        && !row.score_ledger
    ) {
        const materialized =
            options.allowLegacyCacheMaterialization === true
                ? shortsScoreLedger.materializeHistoricalScoreLedger({
                    ...record,
                    features: row.features || record.features || null,
                })
                : null;
        if (materialized) {
            record.score_ledger = materialized;
            row.score_ledger = JSON.parse(JSON.stringify(materialized));
            legacyMaterialized = true;
        } else {
            errors.push(
                options.allowLegacyCacheMaterialization === true
                    ? 'legacy saved-channel score evidence could not be materialized'
                    : 'legacy saved-channel score evidence requires the explicit offline migration tool'
            );
        }
    }
    const recordLedger = resolveScoreLedger(
        record && record.score_ledger,
        options
    );
    const rowLedger = resolveScoreLedger(
        row && row.score_ledger,
        options
    );
    if (!recordLedger.valid || !rowLedger.valid) {
        errors.push(...recordLedger.errors, ...rowLedger.errors);
    } else if (
        recordLedger.ledger.ledger_sha256
            !== rowLedger.ledger.ledger_sha256
    ) {
        errors.push('saved-channel full and manifest ledgers differ');
    }
    const originalRecordSha256 = record
        ? shortsScoreLedger.scoreRecordBindingSha256(record)
        : null;
    const priorRecordSha256V1 = record
        ? shortsScoreLedger.priorScoreRecordBindingSha256V1(record)
        : null;
    const priorRecordSha256V2V4 = record
        ? shortsScoreLedger
            .priorScoreRecordBindingSha256V2V4(record)
        : null;
    const priorRecordSha256Candidates = new Set([
        priorRecordSha256V1,
        priorRecordSha256V2V4,
    ].filter(Boolean));
    const priorRecordBindingAllowed = (
        options.allowPriorRecordBindingMigration === true
        && record
        && priorRecordSha256Candidates.has(
            record.score_record_sha256
        )
    );
    if (
        record
        && record.score_record_sha256
        && record.score_record_sha256 !== originalRecordSha256
        && !priorRecordBindingAllowed
    ) {
        errors.push('saved-channel full record binding does not match');
    }
    const priorManifestValidation =
        manifestBinding.validateManifestRowBinding(row);
    if (priorManifestValidation.state === 'canonical-invalid') {
        errors.push(...priorManifestValidation.errors);
    }
    const staleManifestRecordPointer = !!(
        row
        && row.score_record_sha256
        && row.score_record_sha256 !== originalRecordSha256
    );
    const priorManifestRecordPointerAllowed = !!(
        options.allowPriorRecordBindingMigration === true
        && row
        && priorRecordSha256Candidates.has(
            row.score_record_sha256
        )
        && (
            priorManifestValidation.valid === true
            || priorManifestValidation.prior_v1_valid === true
            || priorManifestValidation.prior_v2_valid === true
        )
        && recordLedger.valid
        && rowLedger.valid
        && recordLedger.ledger.ledger_sha256
            === rowLedger.ledger.ledger_sha256
    );
    const archivedPointerProof =
        options.archivedStaleManifestPointerProof;
    const archivedManifestRecordPointerAllowed = !!(
        archivedPointerProof
        && archivedPointerProof.verified === true
        && recordLedger.valid
        && rowLedger.valid
        && archivedPointerProof.videoId === String(row && row.id || '')
        && archivedPointerProof.sourceScoreRecordSha256
            === row.score_record_sha256
        && archivedPointerProof.sourceLedgerSha256
            === row.score_ledger.ledger_sha256
        && archivedPointerProof.currentStoredScoreRecordSha256
            === record.score_record_sha256
        && archivedPointerProof.currentCanonicalLedgerSha256
            === recordLedger.ledger.ledger_sha256
        && archivedPointerProof.currentCanonicalLedgerSha256
            === rowLedger.ledger.ledger_sha256
    );
    if (
        staleManifestRecordPointer
        && !priorManifestRecordPointerAllowed
        && !archivedManifestRecordPointerAllowed
    ) {
        errors.push('saved-channel manifest points to another full record');
    }
    if (errors.length) {
        return {
            valid: false,
            errors: [...new Set(errors)],
            recordChanged: false,
            rowChanged: false,
        };
    }
    let recordChanged = legacyMaterialized;
    let rowChanged = legacyMaterialized;
    if (!record.id) {
        record.id = row.id;
        recordChanged = true;
    }
    if (!record.savedChannelVideoId) {
        record.savedChannelVideoId = row.id;
        recordChanged = true;
    }
    if (!record.savedChannelId && row.savedChannelId) {
        record.savedChannelId = row.savedChannelId;
        recordChanged = true;
    }
    if (recordLedger.state === 'canonical-prior') {
        record.score_ledger = recordLedger.ledger;
        recordChanged = true;
    }
    if (rowLedger.state === 'canonical-prior') {
        row.score_ledger = rowLedger.ledger;
        rowChanged = true;
    }
    recordChanged =
        shortsScoreLedger.stripLegacyScoreCaches(record)
        || recordChanged;
    if (Object.prototype.hasOwnProperty.call(row, 'features')) {
        delete row.features;
        rowChanged = true;
    }
    for (const field of [
        'visual_keep_forecast',
        'visual_keep_forecast_error',
        'creator_adaptive_keep_forecast',
        'creator_adaptive_keep_forecast_error',
        'creator_adaptive_keep_release_sha256',
    ]) {
        if (Object.prototype.hasOwnProperty.call(row, field)) {
            delete row[field];
            rowChanged = true;
        }
    }
    const binding = bindSavedChannelRecordAndRow(record, row);
    recordChanged = binding.recordChanged || recordChanged;
    rowChanged = binding.rowChanged || rowChanged;
    const finalManifestValidation =
        manifestBinding.validateManifestRowBinding(row);
    return {
        valid: finalManifestValidation.valid === true,
        errors: finalManifestValidation.errors,
        recordChanged,
        rowChanged,
        scoreRecordSha256: binding.scoreRecordSha256,
        manifestRowSha256: binding.manifestRowSha256,
        reconciledStaleManifestRecordPointer:
            staleManifestRecordPointer,
        migratedPriorRecordBinding:
            priorRecordBindingAllowed
            || priorManifestRecordPointerAllowed,
        recoveredArchivedPartialMigration:
            archivedManifestRecordPointerAllowed,
        legacyMaterialized,
    };
}

function validateSavedChannelRecordBinding(record, row) {
    const recordCopy = record && JSON.parse(JSON.stringify(record));
    const rowCopy = row && JSON.parse(JSON.stringify(row));
    const result = canonicalizeSavedChannelRecordBinding(
        recordCopy,
        rowCopy
    );
    const errors = [...(result.errors || [])];
    if (result.valid && (result.recordChanged || result.rowChanged)) {
        errors.push(
            'saved-channel record requires explicit offline canonicalization'
        );
    }
    return {
        ...result,
        valid: result.valid
            && !result.recordChanged
            && !result.rowChanged,
        errors: [...new Set(errors)],
        recordChanged: false,
        rowChanged: false,
    };
}

module.exports = {
    HISTORICAL_EVIDENCE_WARNING,
    SAVED_CHANNEL_ROOT,
    applySavedChannelEvidenceState,
    bindSavedChannelRecordAndRow,
    canonicalizeSavedChannelRecordBinding,
    classifySavedChannelInputEvidence,
    resolveScoreLedger,
    savedChannelRecordArtifactKey,
    validateSavedChannelEvidenceState,
    validateSavedChannelRecordBinding,
};
