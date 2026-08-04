'use strict';

const {
    exactSha256,
    sha256Bytes,
} = require('./canonical-json-artifact');
const longSavedThumbnailRecord = require(
    './long-saved-thumbnail-record'
);
const longScoreLedger = require('./long-score-ledger');
const shortsScoreLedger = require('./shorts-score-ledger');

const INDEX_SCHEMA = 'long-hook-library-index-v1';
const INDEX_VERSION = 1;
const RECORD_ROOT = 'longform/hook-embeds/';
const EVIDENCE_STATES = new Set([
    'canonical_bound',
    'legacy_unbound',
]);
const NAVIGATION_KEYS = Object.freeze([
    'title',
    'url',
    'published',
    'views',
    'keep_rate',
    'swiped',
    'avg_retention',
    'duration_s',
    'curve',
    'hookText',
    'hookEndSec',
    'hookEndPct',
    'transcriptSource',
    'cutBy',
    'cutReason',
    'ts',
    'error',
]);
const ROW_KEYS = Object.freeze([
    'id',
    'record_key',
    'record_artifact_sha256',
    'record_byte_length',
    'evidence_state',
    'score_record_sha256',
    'ledger_sha256',
    'navigation',
    'evidence_errors',
    'index_row_sha256',
]);
const INDEX_KEYS = Object.freeze([
    'schema',
    'version',
    'rows',
    'counts',
    'recut',
    'migration_release',
    'updated_at',
    'index_sha256',
]);

function isPlainObject(value) {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value);
}

function exactKeys(value, keys) {
    return isPlainObject(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => (
            Object.prototype.hasOwnProperty.call(value, key)
        ));
}

function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function finiteOrNull(value) {
    return value == null || Number.isFinite(Number(value));
}

function canonicalNavigation(record) {
    const navigation = Object.fromEntries(
        NAVIGATION_KEYS.map(key => [key, null])
    );
    for (const key of NAVIGATION_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(record || {}, key)) {
            continue;
        }
        navigation[key] = record[key] == null
            ? null
            : jsonClone(record[key]);
    }
    if (Array.isArray(navigation.curve)) {
        navigation.curve = navigation.curve.map(Number);
    }
    return navigation;
}

function canonicalScoreEvidence(record) {
    const score = record
        && record.score
        && typeof record.score === 'object'
        && !Array.isArray(record.score)
        ? record.score
        : null;
    if (!score) {
        return {
            state: 'legacy_unbound',
            scoreRecordSha256: null,
            ledgerSha256: null,
            errors: ['canonical Long score envelope is missing'],
        };
    }
    const scoreValidation =
        longSavedThumbnailRecord.validateScore(score);
    const inputValidation =
        scoreValidation.valid
            ? longScoreLedger.validateLongInputManifest(score)
            : { valid: false, errors: [] };
    const calculatedScoreRecordSha256 =
        shortsScoreLedger.scoreRecordBindingSha256({
            ...record,
            score_domain: 'longquant',
        });
    const recordedScoreRecordSha256 =
        record.score_record_sha256 || null;
    const errors = []
        .concat(scoreValidation.errors || [])
        .concat(inputValidation.errors || []);
    if (
        !exactSha256(recordedScoreRecordSha256)
        || recordedScoreRecordSha256
            !== calculatedScoreRecordSha256
    ) {
        errors.push(
            'Long hook score-record binding is missing or differs'
        );
    }
    const ledgerSha256 = score
        && score.long_score_ledger
        && score.long_score_ledger.ledger_sha256
        || null;
    if (!exactSha256(ledgerSha256)) {
        errors.push('canonical Long score ledger hash is missing');
    }
    return errors.length
        ? {
            state: 'legacy_unbound',
            scoreRecordSha256: null,
            ledgerSha256: null,
            errors: [...new Set(errors)].slice(0, 20),
        }
        : {
            state: 'canonical_bound',
            scoreRecordSha256: recordedScoreRecordSha256,
            ledgerSha256,
            errors: [],
        };
}

function rowBindingPayload(row) {
    return Object.fromEntries(
        ROW_KEYS
            .filter(key => key !== 'index_row_sha256')
            .map(key => [key, row[key]])
    );
}

function bindRow(row) {
    const canonical = {
        ...rowBindingPayload(row),
        index_row_sha256: null,
    };
    canonical.index_row_sha256 =
        shortsScoreLedger.sha256Canonical(
            rowBindingPayload(canonical)
        );
    return canonical;
}

function compactRecord(record, recordBytes) {
    const id = String(record && record.id || '').trim();
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error('Long hook record ID is missing or invalid');
    }
    const bytes = Buffer.isBuffer(recordBytes)
        ? recordBytes
        : Buffer.from(recordBytes);
    const scoreEvidence = canonicalScoreEvidence(record);
    return bindRow({
        id,
        record_key: `${RECORD_ROOT}${id}.json`,
        record_artifact_sha256: sha256Bytes(bytes),
        record_byte_length: bytes.length,
        evidence_state: scoreEvidence.state,
        score_record_sha256:
            scoreEvidence.scoreRecordSha256,
        ledger_sha256: scoreEvidence.ledgerSha256,
        navigation: canonicalNavigation(record),
        evidence_errors: scoreEvidence.errors,
    });
}

function validateNavigation(navigation) {
    const errors = [];
    if (!exactKeys(navigation, NAVIGATION_KEYS)) {
        return ['Long hook navigation fields differ'];
    }
    for (const key of [
        'views',
        'keep_rate',
        'swiped',
        'avg_retention',
        'duration_s',
        'hookEndSec',
        'hookEndPct',
        'ts',
    ]) {
        if (!finiteOrNull(navigation[key])) {
            errors.push(`Long hook navigation ${key} is not numeric`);
        }
    }
    if (
        navigation.curve != null
        && (
            !Array.isArray(navigation.curve)
            || navigation.curve.length < 2
            || navigation.curve.some(value => (
                !Number.isFinite(Number(value))
            ))
        )
    ) {
        errors.push('Long hook navigation curve is invalid');
    }
    return errors;
}

function validateRow(row) {
    const errors = [];
    if (!exactKeys(row, ROW_KEYS)) {
        errors.push('Long hook index row fields differ');
        return { valid: false, errors };
    }
    if (
        !String(row.id || '').match(/^[A-Za-z0-9_-]+$/)
        || row.record_key !== `${RECORD_ROOT}${row.id}.json`
    ) {
        errors.push('Long hook index row identity differs');
    }
    if (!exactSha256(row.record_artifact_sha256)) {
        errors.push('Long hook record artifact hash is invalid');
    }
    if (
        !Number.isSafeInteger(row.record_byte_length)
        || row.record_byte_length <= 0
    ) {
        errors.push('Long hook record byte length is invalid');
    }
    if (!EVIDENCE_STATES.has(row.evidence_state)) {
        errors.push('Long hook evidence state is invalid');
    }
    if (
        row.evidence_state === 'canonical_bound'
        && (
            !exactSha256(row.score_record_sha256)
            || !exactSha256(row.ledger_sha256)
            || row.evidence_errors.length !== 0
        )
    ) {
        errors.push('canonical Long hook evidence is incomplete');
    }
    if (
        row.evidence_state === 'legacy_unbound'
        && (
            row.score_record_sha256 !== null
            || row.ledger_sha256 !== null
            || !Array.isArray(row.evidence_errors)
            || row.evidence_errors.length === 0
        )
    ) {
        errors.push('legacy Long hook evidence is not quarantined');
    }
    errors.push(...validateNavigation(row.navigation));
    const expected = shortsScoreLedger.sha256Canonical(
        rowBindingPayload(row)
    );
    if (
        !exactSha256(row.index_row_sha256)
        || row.index_row_sha256 !== expected
    ) {
        errors.push('Long hook index row hash differs');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
    };
}

function indexBindingPayload(index) {
    return Object.fromEntries(
        INDEX_KEYS
            .filter(key => key !== 'index_sha256')
            .map(key => [key, index[key]])
    );
}

function bindIndex(index = {}) {
    const rows = Array.isArray(index.rows)
        ? index.rows.map(row => bindRow(row))
        : [];
    const counts = {
        total: rows.length,
        canonical_bound: rows.filter(
            row => row.evidence_state === 'canonical_bound'
        ).length,
        legacy_unbound: rows.filter(
            row => row.evidence_state === 'legacy_unbound'
        ).length,
    };
    const canonical = {
        schema: INDEX_SCHEMA,
        version: INDEX_VERSION,
        rows,
        counts,
        recut: index.recut == null
            ? null
            : jsonClone(index.recut),
        migration_release: index.migration_release == null
            ? null
            : jsonClone(index.migration_release),
        updated_at: Number.isFinite(Number(index.updated_at))
            ? Number(index.updated_at)
            : Date.now(),
        index_sha256: null,
    };
    canonical.index_sha256 =
        shortsScoreLedger.sha256Canonical(
            indexBindingPayload(canonical)
        );
    return canonical;
}

function validateIndex(index) {
    const errors = [];
    if (!exactKeys(index, INDEX_KEYS)) {
        return {
            valid: false,
            errors: ['Long hook library index fields differ'],
        };
    }
    if (
        index.schema !== INDEX_SCHEMA
        || Number(index.version) !== INDEX_VERSION
        || !Array.isArray(index.rows)
    ) {
        errors.push('Long hook library index schema differs');
    }
    const ids = [];
    for (const row of index.rows || []) {
        const validation = validateRow(row);
        errors.push(...validation.errors);
        ids.push(String(row && row.id || ''));
    }
    if (
        ids.some(id => !id)
        || new Set(ids).size !== ids.length
    ) {
        errors.push('Long hook library index IDs are duplicated');
    }
    const expectedCounts = {
        total: (index.rows || []).length,
        canonical_bound: (index.rows || []).filter(
            row => row.evidence_state === 'canonical_bound'
        ).length,
        legacy_unbound: (index.rows || []).filter(
            row => row.evidence_state === 'legacy_unbound'
        ).length,
    };
    if (
        !isPlainObject(index.counts)
        || Object.keys(expectedCounts).some(key => (
            Number(index.counts[key]) !== expectedCounts[key]
        ))
    ) {
        errors.push('Long hook library index counts differ');
    }
    const expectedHash =
        shortsScoreLedger.sha256Canonical(
            indexBindingPayload(index)
        );
    if (
        !exactSha256(index.index_sha256)
        || index.index_sha256 !== expectedHash
    ) {
        errors.push('Long hook library index hash differs');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        calculated_sha256: expectedHash,
    };
}

function validateRowRecordPair(row, record, recordBytes) {
    const rowValidation = validateRow(row);
    const errors = [...rowValidation.errors];
    const bytes = Buffer.isBuffer(recordBytes)
        ? recordBytes
        : Buffer.from(recordBytes);
    if (
        row.record_artifact_sha256 !== sha256Bytes(bytes)
        || row.record_byte_length !== bytes.length
    ) {
        errors.push('Long hook full record bytes differ from index');
    }
    let expected = null;
    try {
        expected = compactRecord(record, bytes);
    } catch (error) {
        errors.push(error.message);
    }
    if (
        expected
        && expected.index_row_sha256 !== row.index_row_sha256
    ) {
        errors.push('Long hook index row differs from full record');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
    };
}

module.exports = {
    INDEX_SCHEMA,
    INDEX_VERSION,
    NAVIGATION_KEYS,
    RECORD_ROOT,
    ROW_KEYS,
    bindIndex,
    bindRow,
    canonicalNavigation,
    compactRecord,
    indexBindingPayload,
    validateIndex,
    validateRow,
    validateRowRecordPair,
};
