'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FEATURE_CONTRACT_PATH = path.join(
    __dirname,
    'saved-channel-feature-contract.json'
);
const GOVERNANCE_PATH = path.join(
    __dirname,
    'quant-coordinate-governance.json'
);
const FEATURE_CONTRACT_BYTES = fs.readFileSync(FEATURE_CONTRACT_PATH);
const GOVERNANCE_BYTES = fs.readFileSync(GOVERNANCE_PATH);
const FEATURE_CONTRACT = JSON.parse(FEATURE_CONTRACT_BYTES.toString('utf8'));
const GOVERNANCE = JSON.parse(GOVERNANCE_BYTES.toString('utf8'));
const FEATURE_CONTRACT_DOCUMENT_SHA256 = crypto
    .createHash('sha256')
    .update(FEATURE_CONTRACT_BYTES)
    .digest('hex');
const GOVERNANCE_SHA256 = crypto
    .createHash('sha256')
    .update(GOVERNANCE_BYTES)
    .digest('hex');
const STORED_PATTERN = GOVERNANCE.coordinates.storedPattern;
const FEATURE_DEFINITIONS = Object.freeze(
    (FEATURE_CONTRACT.features || []).map(definition => Object.freeze({
        ...definition,
        displayUnit: definition.displayUnit ?? null,
        coordinateId: STORED_PATTERN.replace(
            '{featureKey}',
            definition.key
        ),
    }))
);
const FEATURE_BY_KEY = new Map(
    FEATURE_DEFINITIONS.map(definition => [definition.key, definition])
);
const EXPECTED_COORDINATE_IDS = Object.freeze(
    FEATURE_DEFINITIONS.map(definition => definition.coordinateId)
);
const FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION = 1;
const FEATURE_CONTRACT_IDENTITY = Object.freeze({
    schema: 'shorts-stored-score-contract-identity-v1',
    schema_version: FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
    pipeline: Object.fromEntries([
        'sourceWindow',
        'embeddingModel',
        'embeddingDimensions',
        'scorer',
    ].map(key => [key, (FEATURE_CONTRACT.pipeline || {})[key] ?? null])),
    features: FEATURE_DEFINITIONS.map(definition => Object.fromEntries([
        'key',
        'group',
        'target',
        'unit',
        'displayUnit',
        'source',
        'sourceKey',
    ].map(key => [key, definition[key] ?? null]))),
});

if (
    FEATURE_DEFINITIONS.length !== 21
    || new Set(EXPECTED_COORDINATE_IDS).size !== FEATURE_DEFINITIONS.length
) {
    throw new Error(
        'canonical Shorts feature contract must define 21 unique coordinates'
    );
}

const finite = value => (
    value !== null
    && value !== undefined
    && value !== ''
    && typeof value !== 'boolean'
    && Number.isFinite(Number(value))
);
const UNIT_VALUE_BOUNDS = Object.freeze(Object.fromEntries(
    Object.entries(GOVERNANCE.valueUnits || {}).map(([unit, definition]) => {
        if (
            !definition
            || typeof definition !== 'object'
            || !Object.prototype.hasOwnProperty.call(
                definition,
                'minimumInclusive'
            )
            || !Object.prototype.hasOwnProperty.call(
                definition,
                'maximumInclusive'
            )
            || (
                definition.minimumInclusive != null
                && !finite(definition.minimumInclusive)
            )
            || (
                definition.maximumInclusive != null
                && !finite(definition.maximumInclusive)
            )
            || (
                definition.minimumInclusive != null
                && definition.maximumInclusive != null
                && Number(definition.minimumInclusive)
                    > Number(definition.maximumInclusive)
            )
        ) {
            throw new Error(`invalid governed value unit: ${unit}`);
        }
        return [unit, Object.freeze({
            min: definition.minimumInclusive,
            max: definition.maximumInclusive,
        })];
    })
));

if (GOVERNANCE.percentileStorageUnit !== 'percentile_0_100') {
    throw new Error('unsupported canonical percentile storage unit');
}
if (
    !UNIT_VALUE_BOUNDS.percent
    || UNIT_VALUE_BOUNDS.percent.min !== 0
    || UNIT_VALUE_BOUNDS.percent.max !== 100
) {
    throw new Error('canonical percent must be governed on [0, 100]');
}
if (
    !UNIT_VALUE_BOUNDS.retention_percent_rewatch_capable
    || UNIT_VALUE_BOUNDS.retention_percent_rewatch_capable.min !== 0
    || UNIT_VALUE_BOUNDS.retention_percent_rewatch_capable.max !== null
) {
    throw new Error(
        'rewatch-capable retention must be governed on [0, +infinity)'
    );
}
for (const definition of FEATURE_DEFINITIONS) {
    if (!Object.prototype.hasOwnProperty.call(
        UNIT_VALUE_BOUNDS,
        definition.unit
    )) {
        throw new Error(
            `unsupported canonical Shorts unit: ${definition.unit}`
        );
    }
}

function withinClosedBounds(value, bounds) {
    if (!finite(value)) return false;
    const numeric = Number(value);
    return (
        (bounds.min == null || numeric >= bounds.min)
        && (bounds.max == null || numeric <= bounds.max)
    );
}

function valueWithinUnitBounds(value, unit) {
    const bounds = UNIT_VALUE_BOUNDS[unit];
    return !!bounds && withinClosedBounds(value, bounds);
}

function percentileWithinBounds(value) {
    return withinClosedBounds(value, { min: 0, max: 100 });
}

const exactSha256 = value => (
    /^[a-f0-9]{64}$/.test(String(value || ''))
);

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => (
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function sha256Canonical(value) {
    return crypto
        .createHash('sha256')
        .update(canonicalJson(value))
        .digest('hex');
}

function scoreInputManifestBindingPayload(manifest) {
    if (!manifest || typeof manifest !== 'object') return null;
    const canonicalMontage = manifest.canonical_montage || {};
    const channel = name => {
        const value = manifest.channels
            && manifest.channels[name]
            || {};
        return {
            present: value.present === true,
            text: String(value.text || ''),
        };
    };
    return {
        schema: 'score-input-manifest-binding-v1',
        domain: manifest.domain || null,
        scorer: manifest.scorer || null,
        embedding_model: manifest.embedding_model || null,
        embedding_dimensions:
            manifest.embedding_dimensions ?? null,
        feature_contract_identity_schema_version:
            manifest.feature_contract_identity_schema_version
            ?? null,
        feature_contract_sha256:
            manifest.feature_contract_sha256 || null,
        feature_contract_document_sha256:
            manifest.feature_contract_document_sha256 || null,
        coordinate_governance_version:
            manifest.coordinate_governance_version ?? null,
        coordinate_governance_sha256:
            manifest.coordinate_governance_sha256 || null,
        steer_artifact_sha256:
            manifest.steer_artifact_sha256 || null,
        steer_artifact_archive_key:
            manifest.steer_artifact_archive_key || null,
        steer_lineage_manifest_sha256:
            manifest.steer_lineage_manifest_sha256 || null,
        steer_lineage_schema_version:
            manifest.steer_lineage_schema_version ?? null,
        source_window: manifest.source_window || null,
        canonical_montage: {
            width: canonicalMontage.width ?? null,
            height: canonicalMontage.height ?? null,
            format: canonicalMontage.format || null,
            quality: canonicalMontage.quality ?? null,
            subsampling: canonicalMontage.subsampling || null,
            montage_sha256:
                canonicalMontage.montage_sha256 || null,
        },
        transcript_used: manifest.transcript_used === true,
        duration_s: manifest.duration_s ?? null,
        creator_profile: manifest.creator_profile || null,
        input_fingerprint: manifest.input_fingerprint || null,
        score_input_fingerprint:
            manifest.score_input_fingerprint || null,
        embedding_input_fingerprint:
            manifest.embedding_input_fingerprint || null,
        revision_fingerprint:
            manifest.revision_fingerprint || null,
        output_fingerprint: manifest.output_fingerprint || null,
        scorer_revisions: manifest.scorer_revisions || null,
        query_input_fingerprint:
            manifest.query_input_fingerprint || null,
        thumbnail_sha256: manifest.thumbnail_sha256 || null,
        score_text_sha256: manifest.score_text_sha256 || null,
        query_input: manifest.query_input || null,
        channels: {
            visual: channel('visual'),
            text: channel('text'),
            together: channel('together'),
        },
    };
}

function scoreRecordBindingPayload(record) {
    const nestedScore = (
        record
        && record.score
        && typeof record.score === 'object'
    ) ? record.score : null;
    const inputManifest = record && record.input_manifest
        || nestedScore && nestedScore.input_manifest
        || null;
    const longField = name => (
        record && record[name] !== undefined
            ? record[name]
            : nestedScore && nestedScore[name] !== undefined
                ? nestedScore[name]
                : null
    );
    const longScoreLedger = record && (
        record.long_score_ledger
        || record.score && record.score.long_score_ledger
    ) || null;
    const scoreDomain = record && record.score_domain
        || (
            longScoreLedger
            || String(inputManifest && inputManifest.domain || '')
                .toLowerCase()
                .includes('longquant')
                ? 'longquant'
                : 'shorts'
    );
    const payload = {
        schema: 'shorts-score-record-binding-v3',
        id: record && (
            record.id
            || record.savedChannelVideoId
            || record.sourceVideoId
        ) || null,
        kind: record && record.kind || null,
        title: record && record.title || null,
        text: record && (
            record.text !== undefined
                ? record.text
                : record.transcript
        ) || null,
        duration_s: record && (
            record.dur_s !== undefined
                ? record.dur_s
                : record.duration_s
        ) || null,
        score_ledger: record && record.score_ledger || null,
        long_score_ledger: longScoreLedger,
        visual_keep_forecast:
            record && record.visual_keep_forecast || null,
        creator_adaptive_keep_forecast:
            record && record.creator_adaptive_keep_forecast || null,
        input_manifest:
            scoreInputManifestBindingPayload(inputManifest),
        canonical_montage_ref:
            record && record.montage_ref || null,
        scored_evidence: {
            indicators: record && record.indicators || null,
            channels: record && record.channels || null,
            emb_preview: record && record.emb_preview || null,
            novelty_provenance:
                record && record.novelty_provenance || null,
        },
        input_identity: inputManifest ? {
            revision_fingerprint:
                inputManifest.revision_fingerprint || null,
            embedding_input_fingerprint:
                inputManifest.embedding_input_fingerprint || null,
            score_input_fingerprint:
                inputManifest.score_input_fingerprint
                || inputManifest.input_fingerprint
                || null,
            query_input_fingerprint:
                inputManifest.query_input_fingerprint || null,
            thumbnail_sha256:
                inputManifest.thumbnail_sha256 || null,
            score_text_sha256:
                inputManifest.score_text_sha256 || null,
            query_input:
                inputManifest.query_input || null,
        } : null,
    };
    if (scoreDomain === 'longquant') {
        payload.schema = 'score-record-binding-v6';
        payload.score_domain = 'longquant';
        payload.output_contract = longField('output_contract');
        payload.decision_trace = longField('decision_trace');
        payload.non_authoritative_geometry =
            longField('non_authoritative_geometry');
    }
    return payload;
}

function priorScoreRecordBindingPayloadV2V4(record) {
    const payload = scoreRecordBindingPayload(record);
    const nestedScore = (
        record
        && record.score
        && typeof record.score === 'object'
    ) ? record.score : null;
    const inputManifest = record && record.input_manifest
        || nestedScore && nestedScore.input_manifest
        || null;
    payload.schema = payload.score_domain === 'longquant'
        ? 'score-record-binding-v4'
        : 'shorts-score-record-binding-v2';
    if (payload.score_domain === 'longquant') {
        delete payload.decision_trace;
        delete payload.non_authoritative_geometry;
        const longField = name => (
            record && record[name] !== undefined
                ? record[name]
                : nestedScore
                    && nestedScore[name] !== undefined
                    ? nestedScore[name]
                    : null
        );
        payload.score_alias_contract =
            longField('score_alias_contract');
        payload.reward_contract = {
            reward: longField('reward'),
            training_reward: longField('training_reward'),
            thumbnail_model_reward:
                longField('thumbnail_model_reward'),
            idea_model_reward:
                longField('idea_model_reward'),
            relevance: longField('relevance'),
            nn_cos: longField('nn_cos'),
            reward_trace: longField('reward_trace'),
        };
        payload.long_channel_evidence =
            longField('channels');
        payload.embedding_preview =
            longField('emb_preview');
    }
    payload.legacy_steer_cache = record && record.steer || null;
    payload.legacy_feature_cache =
        record && record.features || null;
    payload.input_manifest = inputManifest;
    return payload;
}

function priorScoreRecordBindingSha256V2V4(record) {
    return sha256Canonical(
        priorScoreRecordBindingPayloadV2V4(record)
    );
}

function validatePriorScoreRecordBindingV2V4(record) {
    const recorded = record && record.score_record_sha256;
    const calculated =
        priorScoreRecordBindingSha256V2V4(record);
    const valid = (
        typeof recorded === 'string'
        && /^[a-f0-9]{64}$/.test(recorded)
        && recorded === calculated
    );
    return {
        valid,
        recorded_sha256: recorded || null,
        calculated_sha256: calculated,
        errors: valid
            ? []
            : ['prior v2/v4 score-record binding does not match'],
    };
}

function priorScoreRecordBindingPayloadV1(record) {
    const inputManifest = record && record.input_manifest;
    return {
        schema: 'shorts-score-record-binding-v1',
        id: record && (
            record.id
            || record.savedChannelVideoId
            || record.sourceVideoId
        ) || null,
        kind: record && record.kind || null,
        title: record && record.title || null,
        score_ledger: record && record.score_ledger || null,
        long_score_ledger: record && (
            record.long_score_ledger
            || record.score && record.score.long_score_ledger
        ) || null,
        legacy_steer_cache: record && record.steer || null,
        legacy_feature_cache: record && record.features || null,
        visual_keep_forecast:
            record && record.visual_keep_forecast || null,
        creator_adaptive_keep_forecast:
            record && record.creator_adaptive_keep_forecast || null,
        input_identity: inputManifest ? {
            revision_fingerprint:
                inputManifest.revision_fingerprint || null,
            embedding_input_fingerprint:
                inputManifest.embedding_input_fingerprint || null,
            score_input_fingerprint:
                inputManifest.score_input_fingerprint
                || inputManifest.input_fingerprint
                || null,
        } : null,
    };
}

function priorScoreRecordBindingSha256V1(record) {
    return sha256Canonical(priorScoreRecordBindingPayloadV1(record));
}

function validatePriorScoreRecordBindingV1(record) {
    const recorded = record && record.score_record_sha256;
    const calculated = priorScoreRecordBindingSha256V1(record);
    const valid = (
        typeof recorded === 'string'
        && /^[a-f0-9]{64}$/.test(recorded)
        && recorded === calculated
    );
    return {
        valid,
        recorded_sha256: recorded || null,
        calculated_sha256: calculated,
        errors: valid
            ? []
            : ['prior v1 score-record binding does not match'],
    };
}

function normalizedTranscript(value) {
    return String(value == null ? '' : value)
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function validateShortsInputManifest(record, expected = {}) {
    const manifest = record && record.input_manifest;
    const errors = [];
    if (!manifest || typeof manifest !== 'object') {
        return {
            valid: false,
            errors: ['Shorts score input manifest is missing'],
        };
    }
    const canonicalMontage = manifest.canonical_montage;
    const montageSha256 = canonicalMontage
        && canonicalMontage.montage_sha256;
    if (
        manifest.domain !== 'shorts_raw'
        || !exactSha256(montageSha256)
    ) {
        errors.push('Shorts canonical montage identity is missing');
    }
    const transcriptUsed = manifest.transcript_used === true;
    const transcript = normalizedTranscript(
        manifest.channels
        && manifest.channels.text
        && manifest.channels.text.text
    );
    const expectedText = expected.text !== undefined
        ? normalizedTranscript(expected.text)
        : null;
    if (
        expectedText != null
        && transcript
            !== (transcriptUsed ? expectedText : '')
    ) {
        errors.push('Shorts score is bound to different transcript text');
    }
    const expectedMontageSha256 =
        expected.montageSha256
        || (
            expected.montageBytes != null
                ? crypto
                    .createHash('sha256')
                    .update(expected.montageBytes)
                    .digest('hex')
                : null
        );
    if (
        expectedMontageSha256
        && montageSha256 !== expectedMontageSha256
    ) {
        errors.push('Shorts score is bound to different montage bytes');
    }
    const embeddingInput = {
        schema: 'shorts-embedding-input-v2',
        montage_sha256: montageSha256 || null,
        transcript,
        channels: {
            visual: '5-frame-montage',
            text: transcriptUsed
                ? 'normalized-transcript'
                : 'absent',
            together: transcriptUsed
                ? '5-frame-montage+normalized-transcript'
                : '5-frame-montage',
        },
    };
    const embeddingFingerprint =
        sha256Canonical(embeddingInput);
    if (
        manifest.embedding_input_fingerprint
            !== embeddingFingerprint
    ) {
        errors.push('Shorts embedding input fingerprint differs');
    }
    const duration = Number(manifest.duration_s);
    const durationMs = Number.isFinite(duration) && duration > 0
        ? Math.round(duration * 1000)
        : null;
    const creatorProfile = String(
        manifest.creator_profile || ''
    ).trim().toLowerCase() || null;
    const scoreInput = {
        schema: 'shorts-score-input-v2',
        embedding_input_fingerprint: embeddingFingerprint,
        embedding_input: embeddingInput,
        duration_ms: durationMs,
        creator_profile: creatorProfile,
    };
    if (
        manifest.score_input_fingerprint
            !== sha256Canonical(scoreInput)
        || manifest.input_fingerprint
            !== manifest.score_input_fingerprint
    ) {
        errors.push('Shorts score input fingerprint differs');
    }
    if (
        expected.durationS !== undefined
        && (
            Number(expected.durationS) > 0
                ? Math.round(Number(expected.durationS) * 1000)
                : null
        ) !== durationMs
    ) {
        errors.push('Shorts score is bound to different duration');
    }
    if (
        expected.creatorProfile !== undefined
        && (
            String(expected.creatorProfile || '')
                .trim()
                .toLowerCase()
            || null
        ) !== creatorProfile
    ) {
        errors.push('Shorts score is bound to different creator profile');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        montageSha256,
        normalizedTranscript: transcript,
        embeddingFingerprint,
        scoreInputFingerprint:
            manifest.score_input_fingerprint || null,
    };
}

function scoreRecordBindingSha256(record) {
    return sha256Canonical(scoreRecordBindingPayload(record));
}

const FEATURE_CONTRACT_SHA256 = sha256Canonical(
    FEATURE_CONTRACT_IDENTITY
);

function exactKeys(object, expected) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
        return false;
    }
    const keys = Object.keys(object);
    return keys.length === expected.length
        && keys.every(key => expected.includes(key));
}

function jsonClone(value) {
    return value == null
        ? value
        : JSON.parse(JSON.stringify(value));
}

function approvedPriorLedgerRevision(ledger) {
    const revisions = (
        GOVERNANCE.compatibility
        && GOVERNANCE.compatibility.migratableLedgerRevisions
    ) || [];
    const expectedCoordinateIdsSha256 = Array.isArray(
        ledger && ledger.expected_coordinate_ids
    )
        ? sha256Canonical(ledger.expected_coordinate_ids)
        : null;
    return revisions.find(revision => (
        revision
        && ledger.ledger_version === revision.ledgerVersion
        && ledger.feature_contract_version
            === revision.featureContractVersion
        && ledger.feature_contract_identity_schema_version
            === revision.featureContractIdentitySchemaVersion
        && ledger.feature_contract_sha256
            === revision.featureContractSha256
        && ledger.feature_contract_document_sha256
            === revision.featureContractDocumentSha256
        && ledger.coordinate_governance_version
            === revision.coordinateGovernanceVersion
        && ledger.coordinate_governance_sha256
            === revision.coordinateGovernanceSha256
        && expectedCoordinateIdsSha256
            === revision.expectedCoordinateIdsSha256
    )) || null;
}

function migratePriorEntryUnits(ledger, revision, errors) {
    const migration = revision && revision.scoreValueMigration;
    if (
        !migration
        || migration.kind !== 'target-unit-relabel'
        || migration.target !== 'ret5'
        || migration.fromUnit !== 'percent'
        || migration.toUnit !== 'retention_percent_rewatch_capable'
        || migration.numericTransform !== 'identity'
        || migration.priorMinimumInclusive !== 0
        || migration.priorMaximumInclusive !== null
        || migration.historicalUpperBoundWasEnforced !== false
    ) {
        errors.push('prior score ledger unit migration is not approved');
        return [];
    }
    const entries = ledger && Array.isArray(ledger.entries)
        ? ledger.entries
        : [];
    return entries.map((entry, index) => {
        const definition = FEATURE_DEFINITIONS[index];
        if (!definition || !entry || typeof entry !== 'object') {
            return jsonClone(entry);
        }
        if (definition.target !== migration.target) {
            return jsonClone(entry);
        }
        if (entry.unit !== migration.fromUnit) {
            errors.push(
                `${definition.coordinateId} prior unit is not ${migration.fromUnit}`
            );
        }
        if (
            entry.available === true
            && (
                !finite(entry.value)
                || Number(entry.value)
                    < migration.priorMinimumInclusive
            )
        ) {
            errors.push(
                `${definition.coordinateId} value is outside governance range for prior unit ${migration.fromUnit}`
            );
        }
        return {
            ...jsonClone(entry),
            unit: migration.toUnit,
        };
    });
}

function validatePriorCanonicalScoreLedger(ledger) {
    const errors = [];
    const hashPayload = ledger && typeof ledger === 'object'
        ? { ...ledger }
        : null;
    if (hashPayload) delete hashPayload.ledger_sha256;
    let approvedRevision = null;
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
        errors.push('prior score ledger is missing');
    } else {
        approvedRevision = approvedPriorLedgerRevision(ledger);
        if (ledger.schema !== 'shorts-stored-score-ledger-v1') {
            errors.push('prior score ledger schema is not canonical');
        }
        if (ledger.schema_version !== 1) {
            errors.push('prior score ledger schema version is not supported');
        }
        if (
            !Number.isInteger(ledger.ledger_version)
            || ledger.ledger_version < 1
            || ledger.ledger_version >= GOVERNANCE.ledgerVersion
        ) {
            errors.push('score ledger is not a supported prior version');
        }
        if (
            !Number.isInteger(ledger.feature_contract_version)
            || ledger.feature_contract_version < 1
            || ledger.feature_contract_version > FEATURE_CONTRACT.version
        ) {
            errors.push('prior score ledger feature contract version is invalid');
        }
        if (
            typeof ledger.feature_contract_document_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(
                ledger.feature_contract_document_sha256
            )
        ) {
            errors.push(
                'prior score ledger feature contract document hash is missing'
            );
        }
        if (
            !Number.isInteger(ledger.coordinate_governance_version)
            || ledger.coordinate_governance_version < 1
            || ledger.coordinate_governance_version
                > GOVERNANCE.schemaVersion
            || typeof ledger.coordinate_governance_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(
                ledger.coordinate_governance_sha256
            )
        ) {
            errors.push('prior score ledger governance identity is invalid');
        }
        if (!approvedRevision) {
            errors.push(
                'prior score ledger revision is not on the immutable migration allowlist'
            );
        }
        if (
            typeof ledger.ledger_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(ledger.ledger_sha256)
            || ledger.ledger_sha256 !== sha256Canonical(hashPayload)
        ) {
            errors.push('prior score ledger content hash does not match');
        }
    }
    const migratedEntries = approvedRevision
        ? migratePriorEntryUnits(ledger, approvedRevision, errors)
        : [];
    if (errors.length) {
        return { valid: false, errors, migratedLedger: null };
    }

    const migratedLedger = {
        schema: 'shorts-stored-score-ledger-v1',
        schema_version: 1,
        ledger_version: GOVERNANCE.ledgerVersion,
        feature_contract_version: FEATURE_CONTRACT.version,
        feature_contract_identity_schema_version:
            FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
        feature_contract_sha256: FEATURE_CONTRACT_SHA256,
        feature_contract_document_sha256:
            FEATURE_CONTRACT_DOCUMENT_SHA256,
        coordinate_governance_version: GOVERNANCE.schemaVersion,
        coordinate_governance_sha256: GOVERNANCE_SHA256,
        expected_coordinate_ids:
            jsonClone(ledger.expected_coordinate_ids),
        entries: migratedEntries,
        values_by_id: jsonClone(ledger.values_by_id),
        percentiles_by_id: jsonClone(ledger.percentiles_by_id),
        schema_complete: ledger.schema_complete,
        all_values_available: ledger.all_values_available,
        available_count: ledger.available_count,
        unavailable: jsonClone(ledger.unavailable),
        registry_revision: jsonClone(ledger.registry_revision ?? null),
        registry_meta: jsonClone(ledger.registry_meta ?? null),
    };
    migratedLedger.ledger_sha256 = sha256Canonical(migratedLedger);
    const currentValidation = validateScoreLedger(migratedLedger);
    return {
        valid: currentValidation.valid,
        errors: currentValidation.errors,
        migratedLedger:
            currentValidation.valid ? migratedLedger : null,
    };
}

function migratePriorCanonicalScoreLedger(ledger) {
    const validation = validatePriorCanonicalScoreLedger(ledger);
    return validation.valid ? validation.migratedLedger : null;
}

function validateScoreLedger(ledger) {
    const errors = [];
    const entries = ledger && Array.isArray(ledger.entries)
        ? ledger.entries
        : [];
    const valuesById = ledger && ledger.values_by_id
        && typeof ledger.values_by_id === 'object'
        ? ledger.values_by_id
        : {};
    const percentilesById = ledger && ledger.percentiles_by_id
        && typeof ledger.percentiles_by_id === 'object'
        ? ledger.percentiles_by_id
        : {};
    const ids = entries.map(entry => entry && entry.coordinate_id);
    const hashPayload = ledger && { ...ledger };
    if (hashPayload) delete hashPayload.ledger_sha256;

    if (!ledger || typeof ledger !== 'object') {
        errors.push('score ledger is missing');
    } else {
        if (ledger.schema !== 'shorts-stored-score-ledger-v1') {
            errors.push('score ledger schema is not canonical');
        }
        if (ledger.schema_version !== 1) {
            errors.push('score ledger schema version is not supported');
        }
        if (
            Object.prototype.hasOwnProperty.call(
                ledger,
                'migration_provenance'
            )
        ) {
            errors.push(
                'score ledger migration history must remain outside canonical score identity'
            );
        }
        if (ledger.ledger_version !== GOVERNANCE.ledgerVersion) {
            errors.push('score ledger version does not match governance');
        }
        if (
            ledger.feature_contract_identity_schema_version
                !== FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION
            || ledger.feature_contract_sha256 !== FEATURE_CONTRACT_SHA256
        ) {
            errors.push('score ledger feature contract revision does not match');
        }
        if (
            typeof ledger.feature_contract_document_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(
                ledger.feature_contract_document_sha256
            )
        ) {
            errors.push('score ledger feature contract document hash is missing');
        }
        // The document contains descriptive lineage for many surfaces outside
        // this ledger. Its hash is immutable provenance, while the compact
        // feature-contract identity above governs the 21 score coordinates.
        if (
            ledger.coordinate_governance_version !== GOVERNANCE.schemaVersion
            || ledger.coordinate_governance_sha256 !== GOVERNANCE_SHA256
        ) {
            errors.push('score ledger coordinate governance does not match');
        }
        if (
            !Array.isArray(ledger.expected_coordinate_ids)
            || ledger.expected_coordinate_ids.length
                !== EXPECTED_COORDINATE_IDS.length
            || ledger.expected_coordinate_ids.some(
                (id, index) => id !== EXPECTED_COORDINATE_IDS[index]
            )
        ) {
            errors.push('score ledger expected-coordinate inventory differs');
        }
        if (
            ids.length !== EXPECTED_COORDINATE_IDS.length
            || new Set(ids).size !== ids.length
            || ids.some(
                (id, index) => id !== EXPECTED_COORDINATE_IDS[index]
            )
        ) {
            errors.push('score ledger coordinate order or identity is invalid');
        }
        if (!exactKeys(valuesById, EXPECTED_COORDINATE_IDS)) {
            errors.push('score ledger value index is not exact');
        }
        if (!exactKeys(percentilesById, EXPECTED_COORDINATE_IDS)) {
            errors.push('score ledger percentile index is not exact');
        }
        if (
            typeof ledger.ledger_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(ledger.ledger_sha256)
            || ledger.ledger_sha256 !== sha256Canonical(hashPayload)
        ) {
            errors.push('score ledger content hash does not match');
        }
    }

    let availableCount = 0;
    FEATURE_DEFINITIONS.forEach((definition, index) => {
        const entry = entries[index];
        if (!entry || typeof entry !== 'object') return;
        const valueAvailable = finite(entry.value);
        if (
            entry.coordinate_id !== definition.coordinateId
            || entry.feature_key !== definition.key
            || entry.group !== definition.group
            || entry.target !== definition.target
            || entry.source !== definition.source
            || entry.source_key !== (definition.sourceKey || definition.key)
            || entry.unit !== definition.unit
            || entry.display_unit !== definition.displayUnit
        ) {
            errors.push(`${definition.coordinateId} identity differs`);
        }
        if ((entry.available === true) !== valueAvailable) {
            errors.push(`${definition.coordinateId} availability differs`);
        }
        if (entry.available === true) {
            availableCount++;
            if (!valueWithinUnitBounds(entry.value, definition.unit)) {
                errors.push(
                    `${definition.coordinateId} value is outside governance range for unit ${definition.unit}`
                );
            }
            if (
                Number(valuesById[definition.coordinateId])
                    !== Number(entry.value)
            ) {
                errors.push(`${definition.coordinateId} value index differs`);
            }
            if (
                entry.percentile == null
                    ? percentilesById[definition.coordinateId] != null
                    : !finite(entry.percentile)
                        || Number(
                            percentilesById[definition.coordinateId]
                        ) !== Number(entry.percentile)
            ) {
                errors.push(
                    `${definition.coordinateId} percentile index differs`
                );
            }
            if (
                entry.percentile != null
                && !percentileWithinBounds(entry.percentile)
            ) {
                errors.push(
                    `${definition.coordinateId} percentile is outside governance range [0, 100]`
                );
            }
            if (entry.unavailable_reason != null) {
                errors.push(
                    `${definition.coordinateId} has an unavailable reason`
                );
            }
        } else {
            if (valuesById[definition.coordinateId] != null) {
                errors.push(
                    `${definition.coordinateId} unavailable value is indexed`
                );
            }
            if (
                entry.percentile != null
                || percentilesById[definition.coordinateId] != null
            ) {
                errors.push(
                    `${definition.coordinateId} unavailable percentile is indexed`
                );
            }
            if (!entry.unavailable_reason) {
                errors.push(
                    `${definition.coordinateId} lacks an unavailable reason`
                );
            }
        }
    });
    if (
        ledger
        && (
            ledger.schema_complete !== true
            || ledger.available_count !== availableCount
            || ledger.all_values_available
                !== (availableCount === EXPECTED_COORDINATE_IDS.length)
        )
    ) {
        errors.push('score ledger summary counts differ');
    }
    const expectedUnavailable = entries
        .filter(entry => entry && entry.available !== true)
        .map(entry => ({
            coordinate_id: entry.coordinate_id,
            reason: entry.unavailable_reason,
        }));
    if (
        ledger
        && canonicalJson(ledger.unavailable)
            !== canonicalJson(expectedUnavailable)
    ) {
        errors.push('score ledger unavailable inventory differs');
    }

    return {
        valid: errors.length === 0,
        errors,
        featureContractDocumentSha256:
            ledger && exactSha256(
                ledger.feature_contract_document_sha256
            )
                ? ledger.feature_contract_document_sha256
                : null,
        currentFeatureContractDocumentSha256:
            FEATURE_CONTRACT_DOCUMENT_SHA256,
        featureContractDocumentCurrent: !!(
            ledger
            && ledger.feature_contract_document_sha256
                === FEATURE_CONTRACT_DOCUMENT_SHA256
        ),
        entries,
        entriesById: new Map(
            entries
                .filter(entry => entry && entry.coordinate_id)
                .map(entry => [entry.coordinate_id, entry])
        ),
    };
}

function historicalCell(record, definition) {
    const featureCell = legacyFeatureCell(record, definition.key);
    const sourceKey = definition.sourceKey || definition.key;
    const steerCell = record && record.steer && record.steer[sourceKey];
    const featureAvailable = finite(featureCell.value);
    const steerAvailable = !!(
        definition.source === 'steer'
        && steerCell
        && finite(steerCell.est)
    );
    if (steerAvailable) {
        const emittedIdentity = [
            steerCell.coordinate_id || steerCell.coordinateId,
            steerCell.feature_key,
            steerCell.group,
            steerCell.target,
        ];
        const expectedIdentity = [
            definition.coordinateId,
            definition.key,
            definition.group,
            definition.target,
        ];
        const identityDeclared = emittedIdentity.some(
            value => value != null && value !== ''
        );
        if (
            identityDeclared
            && emittedIdentity.some(
                (value, index) => value !== expectedIdentity[index]
            )
        ) {
            return {
                value: null,
                percentile: null,
                unavailableReason:
                    'historical steer coordinate identity conflicts with the ledger contract',
                provenance: {
                    status: 'conflict',
                    source: 'legacy_steer_cache',
                    emitted_identity: emittedIdentity,
                    expected_identity: expectedIdentity,
                    materialized_coordinate_id: definition.coordinateId,
                },
            };
        }
    }
    if (featureAvailable && steerAvailable) {
        const featureValue = Number(featureCell.value);
        const steerValue = Number(steerCell.est);
        const featurePercentile = finite(featureCell.percentile)
            ? Number(featureCell.percentile)
            : null;
        const steerPercentile = finite(steerCell.pctile)
            ? Number(steerCell.pctile)
            : null;
        if (
            featureValue !== steerValue
            || (
                featurePercentile != null
                && steerPercentile != null
                && featurePercentile !== steerPercentile
            )
        ) {
            return {
                value: null,
                percentile: null,
                unavailableReason:
                    'historical feature and steer caches disagree',
                provenance: {
                    status: 'conflict',
                    source: 'legacy_feature_and_steer_cache',
                    feature_value: featureValue,
                    steer_value: steerValue,
                    feature_percentile: featurePercentile,
                    steer_percentile: steerPercentile,
                    materialized_coordinate_id: definition.coordinateId,
                },
            };
        }
        return {
            value: featureValue,
            percentile:
                featurePercentile == null
                    ? steerPercentile
                    : featurePercentile,
            provenance: {
                status: 'historical_materialization',
                source: 'legacy_feature_and_steer_cache',
                parity_verified: true,
                kind: steerCell.kind || null,
                durationSeconds: finite(steerCell.dur_s)
                    ? Number(steerCell.dur_s)
                    : null,
                durationAssumed: !!steerCell.dur_assumed,
                materialized_coordinate_id: definition.coordinateId,
            },
        };
    }
    if (featureAvailable) {
        return {
            value: featureCell.value,
            percentile: featureCell.percentile,
            provenance: {
                status: 'historical_materialization',
                source: 'legacy_feature_cache',
                materialized_coordinate_id: definition.coordinateId,
            },
        };
    }
    if (steerAvailable) {
        return {
            value: Number(steerCell.est),
            percentile: finite(steerCell.pctile)
                ? Number(steerCell.pctile)
                : null,
            provenance: {
                status: 'historical_materialization',
                source: 'legacy_steer_cache',
                kind: steerCell.kind || null,
                durationSeconds: finite(steerCell.dur_s)
                    ? Number(steerCell.dur_s)
                    : null,
                durationAssumed: !!steerCell.dur_assumed,
                materialized_coordinate_id: definition.coordinateId,
            },
        };
    }
    return {
        value: null,
        percentile: null,
        provenance: {
            status: 'unavailable',
            source: 'historical_materialization',
            materialized_coordinate_id: definition.coordinateId,
        },
    };
}

function materializeHistoricalScoreLedger(record) {
    if (record && record.score_ledger) {
        const validation = validateScoreLedger(record.score_ledger);
        if (validation.valid) return record.score_ledger;
        return migratePriorCanonicalScoreLedger(record.score_ledger);
    }
    const entries = FEATURE_DEFINITIONS.map(definition => {
        const cell = historicalCell(record, definition);
        const numericValue = finite(cell.value)
            ? Number(cell.value)
            : null;
        const numericPercentile = finite(cell.percentile)
            ? Number(cell.percentile)
            : null;
        const valueInBounds = (
            numericValue != null
            && valueWithinUnitBounds(numericValue, definition.unit)
        );
        const percentileInBounds = (
            numericPercentile == null
            || percentileWithinBounds(numericPercentile)
        );
        const available = valueInBounds && percentileInBounds;
        const boundsReason = numericValue != null && !valueInBounds
            ? `historical stored score is outside governance range for unit ${definition.unit}`
            : numericPercentile != null && !percentileInBounds
                ? 'historical stored percentile is outside governance range [0, 100]'
                : null;
        return {
            coordinate_id: definition.coordinateId,
            feature_key: definition.key,
            group: definition.group,
            target: definition.target,
            source: definition.source,
            source_key: definition.sourceKey || definition.key,
            unit: definition.unit,
            display_unit: definition.displayUnit,
            value: available ? numericValue : null,
            percentile: available ? numericPercentile : null,
            available,
            unavailable_reason: available
                ? null
                : cell.unavailableReason
                    || boundsReason
                    || 'historical stored score is unavailable',
            provenance: cell.provenance,
        };
    });
    if (!entries.some(entry => entry.available)) return null;
    const novelty = record && record.novelty_provenance;
    const ledger = {
        schema: 'shorts-stored-score-ledger-v1',
        schema_version: 1,
        ledger_version: GOVERNANCE.ledgerVersion,
        feature_contract_version: FEATURE_CONTRACT.version,
        feature_contract_identity_schema_version:
            FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
        feature_contract_sha256: FEATURE_CONTRACT_SHA256,
        feature_contract_document_sha256:
            FEATURE_CONTRACT_DOCUMENT_SHA256,
        coordinate_governance_version: GOVERNANCE.schemaVersion,
        coordinate_governance_sha256: GOVERNANCE_SHA256,
        expected_coordinate_ids: [...EXPECTED_COORDINATE_IDS],
        entries,
        values_by_id: Object.fromEntries(entries.map(entry => [
            entry.coordinate_id,
            entry.value,
        ])),
        percentiles_by_id: Object.fromEntries(entries.map(entry => [
            entry.coordinate_id,
            entry.percentile,
        ])),
        schema_complete: true,
        all_values_available:
            entries.every(entry => entry.available),
        available_count:
            entries.filter(entry => entry.available).length,
        unavailable: entries
            .filter(entry => !entry.available)
            .map(entry => ({
                coordinate_id: entry.coordinate_id,
                reason: entry.unavailable_reason,
            })),
        registry_revision:
            novelty && novelty.registryRevision || null,
        registry_meta:
            novelty && novelty.registryMeta || null,
    };
    ledger.ledger_sha256 = sha256Canonical(ledger);
    const validation = validateScoreLedger(ledger);
    if (!validation.valid) {
        throw new Error(
            `historical score ledger materialization failed: ${
                validation.errors.join('; ')
            }`
        );
    }
    return ledger;
}

function coordinateIdForFeatureKey(featureKey) {
    const definition = FEATURE_BY_KEY.get(featureKey);
    return definition ? definition.coordinateId : null;
}

function ledgerFeatureCell(record, featureKey) {
    const ledger = record && record.score_ledger;
    if (!ledger) {
        return {
            ledgerPresent: false,
            valid: false,
            value: null,
            percentile: null,
            coordinateId: coordinateIdForFeatureKey(featureKey),
            errors: [],
        };
    }
    const validation = validateScoreLedger(ledger);
    const coordinateId = coordinateIdForFeatureKey(featureKey);
    const entry = coordinateId
        ? validation.entriesById.get(coordinateId)
        : null;
    const available = !!(
        validation.valid
        && entry
        && entry.available === true
        && finite(entry.value)
    );
    return {
        ledgerPresent: true,
        valid: validation.valid,
        value: available ? Number(entry.value) : null,
        percentile: available && finite(entry.percentile)
            ? Number(entry.percentile)
            : null,
        coordinateId,
        ledgerSha256: validation.valid ? ledger.ledger_sha256 : null,
        entry: available ? entry : null,
        errors: validation.errors,
    };
}

function legacyFeatureCell(record, featureKey) {
    const cell = record && record.features && record.features[featureKey];
    if (Array.isArray(cell)) {
        return {
            value: finite(cell[0]) ? Number(cell[0]) : null,
            percentile: finite(cell[1]) ? Number(cell[1]) : null,
        };
    }
    if (cell && typeof cell === 'object') {
        const value = cell.v != null ? cell.v : cell.value;
        const percentile = cell.p != null ? cell.p : cell.percentile;
        return {
            value: finite(value) ? Number(value) : null,
            percentile: finite(percentile) ? Number(percentile) : null,
        };
    }
    return { value: null, percentile: null };
}

function scoreFeatureCell(record, featureKey, options = {}) {
    const ledgerCell = ledgerFeatureCell(record, featureKey);
    if (ledgerCell.ledgerPresent) return ledgerCell;
    if (options.allowLegacy !== true) {
        return {
            value: null,
            percentile: null,
            ledgerPresent: false,
            valid: false,
            coordinateId: coordinateIdForFeatureKey(featureKey),
            ledgerSha256: null,
            entry: null,
            errors: ['canonical score ledger is missing'],
            state: 'legacy-missing',
        };
    }
    return {
        ...legacyFeatureCell(record, featureKey),
        ledgerPresent: false,
        valid: false,
        coordinateId: coordinateIdForFeatureKey(featureKey),
        ledgerSha256: null,
        entry: null,
        errors: [],
        state: 'legacy-migration-cache',
    };
}

function scoreLedgerValidationSummary(record) {
    const ledger = record && record.score_ledger;
    if (!ledger) {
        return {
            state: 'legacy-missing',
            valid: null,
            ledger_sha256: null,
            errors: [],
            note: 'No canonical ledger was stored. Compatibility fields may be used only to migrate this historical record.',
        };
    }
    const validation = validateScoreLedger(ledger);
    const documentCurrent =
        validation.featureContractDocumentCurrent === true;
    return {
        state: validation.valid
            ? 'canonical-valid'
            : 'canonical-invalid',
        valid: validation.valid,
        ledger_sha256: validation.valid
            ? ledger.ledger_sha256
            : null,
        errors: validation.errors.slice(0, 12),
        feature_contract_document_sha256:
            validation.featureContractDocumentSha256,
        current_feature_contract_document_sha256:
            validation.currentFeatureContractDocumentSha256,
        feature_contract_document_current: documentCurrent,
        warnings: validation.valid && !documentCurrent
            ? [
                'The score is bound to an archived feature-contract document revision; its semantic coordinate identity and governance match the current scorer.',
            ]
            : [],
        note: validation.valid
            ? (
                'All displayed stored coordinates are read from this validated ledger. '
                + (
                    documentCurrent
                        ? 'Its descriptive contract document is current.'
                        : 'Its descriptive contract document is archived; the scoring identity is unchanged.'
                )
            )
            : 'The canonical ledger failed integrity checks. Compatibility fields must not be displayed as substitutes.',
    };
}

function stripLegacyScoreCaches(record) {
    let changed = false;
    if (record && Object.prototype.hasOwnProperty.call(record, 'steer')) {
        delete record.steer;
        changed = true;
    }
    if (record && Object.prototype.hasOwnProperty.call(record, 'features')) {
        delete record.features;
        changed = true;
    }
    return changed;
}

module.exports = {
    EXPECTED_COORDINATE_IDS,
    FEATURE_CONTRACT,
    FEATURE_CONTRACT_BYTES,
    FEATURE_CONTRACT_DOCUMENT_SHA256,
    FEATURE_CONTRACT_IDENTITY,
    FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
    FEATURE_CONTRACT_SHA256,
    FEATURE_DEFINITIONS,
    GOVERNANCE,
    GOVERNANCE_BYTES,
    GOVERNANCE_SHA256,
    canonicalJson,
    coordinateIdForFeatureKey,
    ledgerFeatureCell,
    legacyFeatureCell,
    materializeHistoricalScoreLedger,
    migratePriorCanonicalScoreLedger,
    scoreFeatureCell,
    scoreInputManifestBindingPayload,
    scoreLedgerValidationSummary,
    priorScoreRecordBindingPayloadV1,
    priorScoreRecordBindingSha256V1,
    priorScoreRecordBindingPayloadV2V4,
    priorScoreRecordBindingSha256V2V4,
    scoreRecordBindingPayload,
    scoreRecordBindingSha256,
    sha256Canonical,
    stripLegacyScoreCaches,
    validateShortsInputManifest,
    validateScoreLedger,
    validatePriorCanonicalScoreLedger,
    validatePriorScoreRecordBindingV1,
    validatePriorScoreRecordBindingV2V4,
};
