'use strict';

const {
    sha256Canonical,
} = require('./shorts-score-ledger');
const {
    exactSha256,
} = require('./canonical-json-artifact');

const CANONICAL_EVIDENCE_STATE = 'canonical_bound';
const HISTORICAL_EVIDENCE_STATE =
    'historical_unbound_input';

function priorManifestRowBindingPayloadV2(row) {
    const ledger = row && row.score_ledger;
    const inputManifest = row && row.input_manifest;
    return {
        schema: 'saved-channel-manifest-row-binding-v2',
        id: row && row.id || null,
        title: row && row.title || null,
        status: row && row.status || null,
        views: row && row.views != null ? row.views : null,
        published: row && row.published || null,
        viewsObservedAt:
            row && row.viewsObservedAt != null
                ? row.viewsObservedAt
                : null,
        scoredAt:
            row && row.scoredAt != null ? row.scoredAt : null,
        score_record_sha256:
            row && row.score_record_sha256 || null,
        record_artifact_sha256:
            row && row.record_artifact_sha256 || null,
        record_byte_length:
            row && row.record_byte_length != null
                ? row.record_byte_length
                : null,
        score_ledger: {
            ledger_sha256:
                ledger && ledger.ledger_sha256 || null,
        },
        input_manifest: {
            revision_fingerprint:
                inputManifest
                && inputManifest.revision_fingerprint || null,
        },
    };
}

function manifestRowBindingPayload(row) {
    return {
        ...priorManifestRowBindingPayloadV2(row),
        schema: 'saved-channel-manifest-row-binding-v3',
        evidence: {
            state: row && row.evidence_state || null,
            canonical: row && row.canonical === true,
            predictor_eligible:
                row && row.predictor_eligible === true,
            warning: row && row.evidence_warning || null,
        },
    };
}

function priorManifestRowBindingPayloadV1(row) {
    const payload = priorManifestRowBindingPayloadV2(row);
    payload.schema = 'saved-channel-manifest-row-binding-v1';
    delete payload.record_artifact_sha256;
    delete payload.record_byte_length;
    return payload;
}

function manifestRowBindingSha256(row) {
    return sha256Canonical(manifestRowBindingPayload(row));
}

function priorManifestRowBindingSha256V1(row) {
    return sha256Canonical(
        priorManifestRowBindingPayloadV1(row)
    );
}

function priorManifestRowBindingSha256V2(row) {
    return sha256Canonical(
        priorManifestRowBindingPayloadV2(row)
    );
}

function validateEvidenceState(row) {
    const errors = [];
    if (!row || row.status !== 'done') return errors;
    if (row.evidence_state === CANONICAL_EVIDENCE_STATE) {
        if (row.canonical !== true) {
            errors.push(
                'canonical saved-channel evidence must set canonical=true'
            );
        }
        if (typeof row.predictor_eligible !== 'boolean') {
            errors.push(
                'canonical saved-channel predictor eligibility is missing'
            );
        }
        if (row.evidence_warning != null) {
            errors.push(
                'canonical saved-channel evidence cannot carry a warning'
            );
        }
        return errors;
    }
    if (row.evidence_state === HISTORICAL_EVIDENCE_STATE) {
        if (
            row.canonical !== false
            || row.predictor_eligible !== false
        ) {
            errors.push(
                'historical saved-channel evidence must be non-canonical and non-predictive'
            );
        }
        if (!String(row.evidence_warning || '').trim()) {
            errors.push(
                'historical saved-channel evidence warning is missing'
            );
        }
        return errors;
    }
    errors.push('saved-channel evidence state is missing or invalid');
    return errors;
}

function validateManifestRowBinding(row) {
    const recorded = row && row.manifest_row_sha256;
    const calculated = manifestRowBindingSha256(row);
    const present = (
        typeof recorded === 'string'
        && /^[a-f0-9]{64}$/.test(recorded)
    );
    const errors = [];
    const priorV1 = (
        present
        && recorded === priorManifestRowBindingSha256V1(row)
    );
    const priorV2 = (
        present
        && recorded === priorManifestRowBindingSha256V2(row)
    );
    if (
        row && row.status === 'done'
        && (
            typeof row.score_record_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(row.score_record_sha256)
        )
    ) {
        errors.push(
            'saved-channel row lacks a canonical score-record binding'
        );
    }
    if (
        row && row.status === 'done'
        && (
            !row.score_ledger
            || typeof row.score_ledger.ledger_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(
                row.score_ledger.ledger_sha256
            )
        )
    ) {
        errors.push(
            'saved-channel row lacks a canonical score-ledger binding'
        );
    }
    if (
        row && row.status === 'done'
        && !exactSha256(row.record_artifact_sha256)
    ) {
        errors.push(
            'saved-channel row lacks an exact full-record artifact hash'
        );
    }
    if (
        row && row.status === 'done'
        && (
            !Number.isSafeInteger(row.record_byte_length)
            || row.record_byte_length <= 0
        )
    ) {
        errors.push(
            'saved-channel row lacks an exact full-record byte length'
        );
    }
    if (!present) {
        errors.push('saved-channel manifest row binding is missing');
    } else if (priorV1 || priorV2) {
        errors.push(
            `saved-channel manifest row uses prior ${
                priorV2 ? 'v2' : 'v1'
            } binding and `
                + 'requires offline migration'
        );
    } else if (recorded !== calculated) {
        errors.push(
            'saved-channel manifest row binding does not match'
        );
    }
    errors.push(...validateEvidenceState(row));
    const valid = present
        && !priorV1
        && !priorV2
        && recorded === calculated
        && errors.length === 0;
    return {
        state: !present
            ? 'legacy-missing'
            : priorV1 || priorV2
                ? 'migration-required'
            : valid
                ? 'canonical-valid'
                : 'canonical-invalid',
        valid: present ? valid : null,
        recorded_sha256: present ? recorded : null,
        calculated_sha256: calculated,
        errors,
        prior_v1_valid: priorV1,
        prior_v2_valid: priorV2,
    };
}

module.exports = {
    CANONICAL_EVIDENCE_STATE,
    HISTORICAL_EVIDENCE_STATE,
    manifestRowBindingPayload,
    manifestRowBindingSha256,
    priorManifestRowBindingPayloadV1,
    priorManifestRowBindingPayloadV2,
    priorManifestRowBindingSha256V1,
    priorManifestRowBindingSha256V2,
    validateEvidenceState,
    validateManifestRowBinding,
};
