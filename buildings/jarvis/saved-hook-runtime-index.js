'use strict';

const displayContract = require('../../embedding-display-contract');
const {
    canonicalJson,
    sha256Canonical,
} = require('./shorts-score-ledger');
const {
    canonicalArtifactIdentity,
    canonicalJsonBytes,
} = require('./canonical-json-artifact');

const INDEX_SCHEMA = 'saved-hook-runtime-index-v1';
const INDEX_VERSION = displayContract.SAVED_HOOK_INDEX_VERSION;
const INDEX_KEYS = Object.freeze([
    'schema',
    'version',
    'updatedAt',
    'hooks',
    'legacy_hooks',
    'folders',
    'index_sha256',
]);
const CANONICAL_ROW_KEYS = Object.freeze([
    'id',
    'title',
    'kind',
    'score_domain',
    'hasMontage',
    'savedAt',
    'folder',
    'input_manifest',
    'score_revision_fingerprint',
    'embedding_input_fingerprint',
    'score_input_fingerprint',
    'creator_profile',
    'score_record_sha256',
    'score_ledger_sha256',
    'output_contract_sha256',
    'record_ref',
    'm_identity',
    'selection_policy',
    'derived_identity',
    'compact_score_sha256',
]);
const LEGACY_ROW_KEYS = Object.freeze([
    'id',
    'title',
    'kind',
    'score_domain',
    'hasMontage',
    'savedAt',
    'folder',
    'frame_imgs',
    'evidence_state',
    'canonical',
    'predictor_eligible',
    'evidence_warning',
    'historical_display',
]);
const FOLDER_KEYS = Object.freeze(['id', 'name']);

function clone(value) {
    return value == null
        ? value
        : JSON.parse(JSON.stringify(value));
}

function legacyRow(row) {
    const source = row && typeof row === 'object'
        ? row
        : {};
    const output = {
        id: source.id,
        title: source.title,
        kind: source.kind,
        score_domain: source.score_domain,
        hasMontage: !!source.hasMontage,
        savedAt: source.savedAt,
        folder: source.folder || null,
        frame_imgs: Array.isArray(source.frame_imgs)
            ? clone(source.frame_imgs)
            : [],
        historical_display: null,
    };
    output.score_domain = output.score_domain
        || (
            source.long_score_ledger
            || source.output_contract
                ? 'longquant'
                : 'shorts'
        );
    output.evidence_state = 'legacy_unbound_evidence';
    output.canonical = false;
    output.predictor_eligible = false;
    output.evidence_warning = (
        'Historical display cache only. The exact JPEG, text, input '
        + 'manifest, and score ledger were not jointly bound.'
    );
    const currentLedger = output.score_domain === 'longquant'
        ? source.long_score_ledger
        : source.score_ledger;
    const currentLedgerSha256 = currentLedger
        && currentLedger.ledger_sha256;
    const generatedDisplay =
        displayContract.historicalSavedHookDisplay(
            source,
            { scoreDomain: output.score_domain }
        );
    const preservedDisplay = source.historical_display;
    if (generatedDisplay) {
        output.historical_display = generatedDisplay;
    } else if (
        !currentLedgerSha256
        &&
        displayContract.validateHistoricalSavedHookDisplay(
            preservedDisplay
        )
        && preservedDisplay.record_id === String(output.id)
        && preservedDisplay.score_domain === output.score_domain
    ) {
        output.historical_display = clone(preservedDisplay);
    }
    return output;
}

function bindingPayload(index) {
    return {
        schema: INDEX_SCHEMA,
        version: INDEX_VERSION,
        updatedAt:
            Number.isSafeInteger(index && index.updatedAt)
            && index.updatedAt >= 0
                ? index.updatedAt
                : 0,
        hooks: Array.isArray(index && index.hooks)
            ? index.hooks
            : [],
        legacy_hooks: Array.isArray(index && index.legacy_hooks)
            ? index.legacy_hooks
            : [],
        folders: Array.isArray(index && index.folders)
            ? index.folders
            : [],
    };
}

function exactSha256(value) {
    return (
        typeof value === 'string'
        && /^[a-f0-9]{64}$/.test(value)
    );
}

function canonicalCompactEvidenceValid(row) {
    if (
        !row
        || row.kind !== 'scored'
        || !displayContract.validateCompactSavedHookRecord(row)
        || !exactSha256(row.score_record_sha256)
        || !exactSha256(row.score_ledger_sha256)
    ) {
        return false;
    }
    const manifest = row.input_manifest;
    if (
        !manifest
        || typeof manifest !== 'object'
        || Array.isArray(manifest)
        || !exactSha256(manifest.revision_fingerprint)
        || !exactSha256(manifest.embedding_input_fingerprint)
        || !exactSha256(
            manifest.score_input_fingerprint
                || manifest.input_fingerprint
        )
    ) {
        return false;
    }
    if (
        row.score_revision_fingerprint
            !== manifest.revision_fingerprint
        || row.embedding_input_fingerprint
            !== manifest.embedding_input_fingerprint
        || row.score_input_fingerprint
            !== (
                manifest.score_input_fingerprint
                || manifest.input_fingerprint
            )
    ) {
        return false;
    }
    if (row.score_domain === 'shorts') {
        if (
            manifest.domain !== 'shorts_raw'
            || !manifest.canonical_montage
            || !exactSha256(
                manifest.canonical_montage.montage_sha256
            )
            || manifest.input_fingerprint
                !== manifest.score_input_fingerprint
        ) {
            return false;
        }
        const selected = Object.values(row.m_identity || {})
            .filter(Boolean);
        if (
            selected.some(cell => (
                cell.origin !== 'canonical-score-ledger'
            ))
        ) {
            return false;
        }
    }
    if (row.score_domain === 'longquant') {
        if (
            !String(manifest.domain || '')
                .toLowerCase()
                .includes('longquant')
        ) {
            return false;
        }
    }
    return true;
}

function uniqueNonemptyIds(rows) {
    const ids = rows.map(row => String(row && row.id || ''));
    return ids.every(Boolean) && new Set(ids).size === ids.length;
}

function exactKeys(value, expectedKeys) {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && canonicalJson(Object.keys(value).sort())
            === canonicalJson(expectedKeys.slice().sort());
}

function validateIndex(index) {
    const expected = sha256Canonical(bindingPayload(index));
    const hooks = Array.isArray(index && index.hooks)
        ? index.hooks
        : [];
    const legacyHooks = Array.isArray(index && index.legacy_hooks)
        ? index.legacy_hooks
        : [];
    const folders = Array.isArray(index && index.folders)
        ? index.folders
        : [];
    const canonicalIds = new Set(
        hooks.map(row => String(row && row.id || ''))
    );
    const errors = [];
    if (
        !index
        || typeof index !== 'object'
        || Array.isArray(index)
        || canonicalJson(Object.keys(index).sort())
            !== canonicalJson(INDEX_KEYS.slice().sort())
    ) {
        errors.push('saved-hook runtime index has non-canonical fields');
    }
    if (!index || index.schema !== INDEX_SCHEMA) {
        errors.push('saved-hook runtime index schema differs');
    }
    if (!index || index.version !== INDEX_VERSION) {
        errors.push('saved-hook runtime index version differs');
    }
    if (
        !index
        || !Number.isSafeInteger(index.updatedAt)
        || index.updatedAt < 0
    ) {
        errors.push('saved-hook runtime index updatedAt is invalid');
    }
    if (
        !Array.isArray(index && index.hooks)
        || !hooks.every(row => (
            exactKeys(row, CANONICAL_ROW_KEYS)
            && canonicalCompactEvidenceValid(row)
        ))
        || !uniqueNonemptyIds(hooks)
    ) {
        errors.push(
            'saved-hook runtime canonical rows are invalid or duplicated'
        );
    }
    if (
        !Array.isArray(index && index.legacy_hooks)
        || !uniqueNonemptyIds(legacyHooks)
        || legacyHooks.some(row => (
            !row
            || !exactKeys(row, LEGACY_ROW_KEYS)
            || row.evidence_state !== 'legacy_unbound_evidence'
            || row.canonical !== false
            || row.predictor_eligible !== false
            || row.m !== undefined
            || row.m_identity !== undefined
            || row.derived_identity !== undefined
            || row.score_ledger_sha256 !== undefined
            || row.output_contract_sha256 !== undefined
            || (
                row.historical_display !== null
                && (
                    !displayContract
                        .validateHistoricalSavedHookDisplay(
                            row.historical_display
                        )
                    || row.historical_display.record_id
                        !== String(row.id)
                    || row.historical_display.score_domain
                        !== row.score_domain
                )
            )
        ))
    ) {
        errors.push(
            'saved-hook runtime legacy rows are invalid or duplicated'
        );
    }
    if (
        legacyHooks.some(row => (
            canonicalIds.has(String(row && row.id || ''))
        ))
    ) {
        errors.push(
            'saved-hook id appears as both canonical and legacy evidence'
        );
    }
    if (
        !Array.isArray(index && index.folders)
        || !uniqueNonemptyIds(folders)
        || folders.some(folder => (
            !exactKeys(folder, FOLDER_KEYS)
            || typeof folder.name !== 'string'
        ))
    ) {
        errors.push(
            'saved-hook runtime folders are invalid or duplicated'
        );
    }
    if (
        !exactSha256(index && index.index_sha256)
        || index.index_sha256 !== expected
    ) {
        errors.push('saved-hook runtime index hash differs');
    }
    return {
        valid: errors.length === 0,
        errors,
        expected_sha256: expected,
        recorded_sha256:
            exactSha256(index && index.index_sha256)
                ? index.index_sha256
                : null,
    };
}

function uniqueRows(rows, label) {
    const byId = new Map();
    for (const row of rows) {
        const id = String(row && row.id || '');
        if (!id) {
            throw new Error(`${label} contains a row without an id`);
        }
        if (!byId.has(id)) {
            byId.set(id, row);
            continue;
        }
        if (canonicalJson(byId.get(id)) !== canonicalJson(row)) {
            throw new Error(
                `${label} contains conflicting duplicate id ${id}`
            );
        }
    }
    return [...byId.values()];
}

function bindIndex(index, options = {}) {
    const hooks = uniqueRows(
        Array.isArray(index && index.hooks)
            ? index.hooks.map(clone)
            : [],
        'saved-hook canonical rows'
    ).sort((left, right) => (
        String(left.id).localeCompare(String(right.id))
    ));
    const canonicalIds = new Set(hooks.map(row => String(row.id)));
    const legacyHooks = uniqueRows(
        (
            Array.isArray(index && index.legacy_hooks)
                ? index.legacy_hooks
                : []
        )
            .map(legacyRow)
            .filter(row => !canonicalIds.has(String(row.id))),
        'saved-hook legacy rows'
    ).sort((left, right) => (
        String(left.id).localeCompare(String(right.id))
    ));
    const folders = uniqueRows(
        Array.isArray(index && index.folders)
            ? index.folders.map(clone)
            : [],
        'saved-hook folders'
    ).sort((left, right) => (
        String(left.id).localeCompare(String(right.id))
    ));
    const output = {
        schema: INDEX_SCHEMA,
        version: INDEX_VERSION,
        updatedAt:
            options.updatedAt !== undefined
                ? Number(options.updatedAt)
                : Number.isSafeInteger(index && index.updatedAt)
                    ? index.updatedAt
                    : 0,
        hooks,
        legacy_hooks: legacyHooks,
        folders,
    };
    output.index_sha256 = sha256Canonical(bindingPayload(output));
    const validation = validateIndex(output);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return output;
}

function canonicalIndexBytes(index) {
    const validation = validateIndex(index);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return canonicalJsonBytes(index);
}

function canonicalIndexArtifactIdentity(index) {
    const validation = validateIndex(index);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return canonicalArtifactIdentity(index);
}

function migrateLegacyIndex(index) {
    const priorCanonicalRows = Array.isArray(index && index.hooks)
        ? index.hooks
        : [];
    const priorLegacyRows = Array.isArray(index && index.legacy_hooks)
        ? index.legacy_hooks
        : [];
    const canonicalRows = priorCanonicalRows.filter(
        canonicalCompactEvidenceValid
    );
    const canonicalIds = new Set(
        canonicalRows.map(row => String(row.id))
    );
    const legacyRows = priorCanonicalRows
        .concat(priorLegacyRows)
        .filter(row => !canonicalIds.has(String(row && row.id || '')))
        .map(legacyRow);
    return bindIndex({
        hooks: canonicalRows,
        legacy_hooks: legacyRows,
        folders: Array.isArray(index && index.folders)
            ? index.folders
            : [],
        updatedAt: index && index.updatedAt,
    });
}

module.exports = {
    INDEX_SCHEMA,
    INDEX_VERSION,
    INDEX_KEYS,
    CANONICAL_ROW_KEYS,
    LEGACY_ROW_KEYS,
    FOLDER_KEYS,
    bindIndex,
    bindingPayload,
    canonicalCompactEvidenceValid,
    canonicalIndexArtifactIdentity,
    canonicalIndexBytes,
    legacyRow,
    migrateLegacyIndex,
    validateIndex,
};
