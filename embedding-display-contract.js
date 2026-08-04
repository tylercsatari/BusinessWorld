'use strict';

const {
    GOVERNANCE: coordinateGovernance,
    ledgerFeatureCell,
    scoreRecordBindingSha256,
    sha256Canonical,
    validateScoreLedger,
} = require('./buildings/jarvis/shorts-score-ledger');
const longScoreLedger = require(
    './buildings/jarvis/long-score-ledger'
);
const SAVED_HOOK_INDEX_VERSION = 10;
const HISTORICAL_SAVED_HOOK_DISPLAY_SCHEMA =
    'saved-hook-historical-display-v1';
const HISTORICAL_SAVED_HOOK_DISPLAY_VERSION = 1;
const SHORTS_DISPLAY_PREFERENCE = Object.freeze(['together', 'text', 'visual']);
const LONGQUANT_DISPLAY_PREFERENCE = Object.freeze(['visual', 'together', 'text']);
const SAVED_HOOK_METRICS = Object.freeze(['keep', 'ret5', 'views', 'realviews', 'gt10M', 'outlier']);
const LONGQUANT_SAVED_METRICS = longScoreLedger.OUTPUT_METRICS;
const HISTORICAL_SHORTS_DOCUMENT_MISMATCH_ERROR =
    'score ledger feature contract document hash does not match';

function exactSha256(value) {
    return (
        typeof value === 'string'
        && /^[a-f0-9]{64}$/.test(value)
    );
}

function exactObjectKeys(value, keys) {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort())
            === JSON.stringify(keys.slice().sort());
}

function savedHookScoreRecordSha256(record) {
    return scoreRecordBindingSha256(record);
}

function savedHookRecordReference(record, scoreRecordSha256) {
    const id = record && record.id || null;
    return {
        schema: 'saved-hook-source-reference-v1',
        storage_key: id ? `raw/saved-hooks/${id}.json` : null,
        record_id: id,
        score_record_sha256: scoreRecordSha256 || null,
    };
}

function compactSavedHookBindingPayload(record) {
    return {
        schema: 'saved-hook-compact-binding-v2',
        id: record && record.id || null,
        title: record && record.title || null,
        kind: record && record.kind || null,
        savedAt: record && record.savedAt || null,
        score_domain: record && record.score_domain || null,
        hasMontage: !!(record && record.hasMontage),
        folder: record && record.folder || null,
        input_manifest: record && record.input_manifest || null,
        embedding_input_fingerprint:
            record && record.embedding_input_fingerprint || null,
        score_input_fingerprint:
            record && record.score_input_fingerprint || null,
        creator_profile:
            record && record.creator_profile || null,
        score_record_sha256:
            record && record.score_record_sha256 || null,
        score_ledger_sha256:
            record && record.score_ledger_sha256 || null,
        output_contract_sha256:
            record && record.output_contract_sha256 || null,
        score_revision_fingerprint:
            record && record.score_revision_fingerprint || null,
        record_ref: record && record.record_ref || null,
        m_identity: record && record.m_identity || null,
        selection_policy: record && record.selection_policy || null,
        derived_identity: record && record.derived_identity || null,
    };
}

function validateCompactSavedHookRecord(record) {
    const expected = record && record.compact_score_sha256;
    const domain = record && record.score_domain;
    if (!['shorts', 'longquant'].includes(domain)) return false;
    const scoreRecordSha256 =
        record && record.score_record_sha256;
    if (
        typeof scoreRecordSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(scoreRecordSha256)
    ) return false;
    const recordRef = record && record.record_ref;
    if (
        !recordRef
        || recordRef.schema !== 'saved-hook-source-reference-v1'
        || recordRef.record_id !== record.id
        || recordRef.storage_key !== `raw/saved-hooks/${record.id}.json`
        || recordRef.score_record_sha256 !== scoreRecordSha256
    ) return false;
    const manifest = record && record.input_manifest;
    if (
        record.score_revision_fingerprint
            !== (
                manifest && manifest.revision_fingerprint
                || null
            )
        || record.embedding_input_fingerprint
            !== (
                manifest && manifest.embedding_input_fingerprint
                || null
            )
        || record.score_input_fingerprint
            !== (
                manifest && (
                    manifest.score_input_fingerprint
                    || manifest.input_fingerprint
                )
                || null
            )
        || record.creator_profile
            !== (
                manifest && manifest.creator_profile
                || null
            )
    ) return false;
    if (
        record.kind === 'scored'
        && (
            typeof record.score_ledger_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(
                record.score_ledger_sha256
            )
        )
    ) return false;
    const identity = record && record.m_identity;
    if (!identity || typeof identity !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(record, 'm')) {
        return false;
    }
    const expectedPattern = domain === 'longquant'
        ? coordinateGovernance.coordinates.longOutputPattern
        : coordinateGovernance.coordinates.storedPattern;
    const expectedPrefix = expectedPattern.split('{')[0];
    if (Object.values(identity).some(cell => (
        cell
        && (
            typeof cell.coordinateId !== 'string'
            || !cell.coordinateId.startsWith(expectedPrefix)
            || Object.prototype.hasOwnProperty.call(cell, 'est')
            || Object.prototype.hasOwnProperty.call(cell, 'pctile')
            || !Number.isFinite(Number(cell.value))
            || typeof cell.valueUnit !== 'string'
            || !cell.valueUnit
            || (
                cell.percentile100 != null
                && (
                    !Number.isFinite(Number(cell.percentile100))
                    || Number(cell.percentile100) < 0
                    || Number(cell.percentile100) > 100
                )
            )
            || cell.percentileUnit
                !== coordinateGovernance.percentileStorageUnit
            || typeof cell.channel !== 'string'
            || typeof cell.target !== 'string'
            || typeof cell.modality !== 'string'
            || typeof cell.input !== 'string'
            || !cell.input
            || typeof cell.ledgerSha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(cell.ledgerSha256)
            || cell.ledgerSha256 !== record.score_ledger_sha256
        )
    ))) return false;
    return !!(
        typeof expected === 'string'
        && /^[a-f0-9]{64}$/.test(expected)
        && expected === sha256Canonical(
            compactSavedHookBindingPayload(record)
        )
    );
}

function validateCompactSavedHookSource(compact, sourceRecord) {
    if (
        !validateCompactSavedHookRecord(compact)
        || !sourceRecord
        || typeof sourceRecord !== 'object'
        || sourceRecord.id !== compact.id
    ) return false;
    const calculatedRecordSha256 =
        savedHookScoreRecordSha256(sourceRecord);
    if (
        sourceRecord.score_record_sha256
        && sourceRecord.score_record_sha256
            !== calculatedRecordSha256
    ) return false;
    if (
        calculatedRecordSha256
        !== compact.score_record_sha256
    ) return false;
    let expected;
    try {
        expected = compactSavedHookRecord(sourceRecord, {
            scoreDomain: compact.score_domain,
        });
    } catch (_) {
        return false;
    }
    return (
        expected.compact_score_sha256
            === compact.compact_score_sha256
        && sha256Canonical(
            compactSavedHookBindingPayload(expected)
        ) === sha256Canonical(
            compactSavedHookBindingPayload(compact)
        )
    );
}

function historicalSavedHookDisplayBindingPayload(display) {
    return {
        schema: HISTORICAL_SAVED_HOOK_DISPLAY_SCHEMA,
        version: HISTORICAL_SAVED_HOOK_DISPLAY_VERSION,
        record_id: display && display.record_id || null,
        score_domain: display && display.score_domain || null,
        score_ledger_sha256:
            display && display.score_ledger_sha256 || null,
        score_revision_fingerprint:
            display && display.score_revision_fingerprint || null,
        m_identity: display && display.m_identity || null,
        selection_policy: display && display.selection_policy || null,
    };
}

function historicalIdentityValid(
    identity,
    target,
    domain,
    ledgerSha256
) {
    if (identity == null) return true;
    if (
        !identity
        || typeof identity !== 'object'
        || Array.isArray(identity)
        || Object.prototype.hasOwnProperty.call(identity, 'est')
        || Object.prototype.hasOwnProperty.call(identity, 'pctile')
        || !['visual', 'text', 'together'].includes(identity.channel)
        || identity.target !== target
        || !Number.isFinite(Number(identity.value))
        || typeof identity.valueUnit !== 'string'
        || !identity.valueUnit
        || (
            identity.percentile100 != null
            && (
                !Number.isFinite(Number(identity.percentile100))
                || Number(identity.percentile100) < 0
                || Number(identity.percentile100) > 100
            )
        )
        || identity.percentileUnit
            !== (
                domain === 'longquant'
                    ? longScoreLedger.PERCENTILE_STORAGE_UNIT
                    : coordinateGovernance.percentileStorageUnit
            )
        || typeof identity.modality !== 'string'
        || typeof identity.input !== 'string'
        || !identity.input
        || identity.ledgerSha256 !== ledgerSha256
    ) {
        return false;
    }
    const expectedCoordinate = domain === 'longquant'
        ? `long.output.${identity.channel}.${target}`
        : `shorts.stored.${identity.channel}.${target}`;
    return identity.coordinateId === expectedCoordinate;
}

function validateHistoricalSavedHookDisplay(display) {
    const keys = [
        'schema',
        'version',
        'record_id',
        'score_domain',
        'score_ledger_sha256',
        'score_revision_fingerprint',
        'm_identity',
        'selection_policy',
        'display_sha256',
    ];
    if (
        !exactObjectKeys(display, keys)
        || display.schema !== HISTORICAL_SAVED_HOOK_DISPLAY_SCHEMA
        || display.version !== HISTORICAL_SAVED_HOOK_DISPLAY_VERSION
        || !String(display.record_id || '')
        || !['shorts', 'longquant'].includes(display.score_domain)
        || !exactSha256(display.score_ledger_sha256)
        || (
            display.score_revision_fingerprint != null
            && !exactSha256(display.score_revision_fingerprint)
        )
        || !exactSha256(display.display_sha256)
    ) {
        return false;
    }
    const targets = display.score_domain === 'longquant'
        ? LONGQUANT_SAVED_METRICS
        : SAVED_HOOK_METRICS;
    if (
        !exactObjectKeys(display.m_identity, targets)
        || !Object.entries(display.m_identity).every(
            ([target, identity]) => historicalIdentityValid(
                identity,
                target,
                display.score_domain,
                display.score_ledger_sha256
            )
        )
        || !Object.values(display.m_identity).some(Boolean)
    ) {
        return false;
    }
    const policy = display.selection_policy;
    const expectedPolicyId = display.score_domain === 'longquant'
        ? 'policy.longquant.display-preference.v1'
        : 'policy.shorts.display-preference.v1';
    if (
        !exactObjectKeys(policy, [
            'id',
            'preference',
            'role',
            'source_ledger_sha256',
            'meaning',
        ])
        || policy.id !== expectedPolicyId
        || !Array.isArray(policy.preference)
        || policy.preference.some(
            channel => !['visual', 'text', 'together'].includes(channel)
        )
        || new Set(policy.preference).size !== policy.preference.length
        || policy.role
            !== 'historical_display_only_hash_bound_materialized_view'
        || policy.source_ledger_sha256
            !== display.score_ledger_sha256
        || typeof policy.meaning !== 'string'
        || !policy.meaning
    ) {
        return false;
    }
    return display.display_sha256 === sha256Canonical(
        historicalSavedHookDisplayBindingPayload(display)
    );
}

function historicalSavedHookDisplay(record, options = {}) {
    if (!record || typeof record !== 'object' || !record.id) {
        return null;
    }
    const scoreDomain = scoreDomainForRecord(
        record,
        options.scoreDomain
    );
    const ledger = scoreDomain === 'longquant'
        ? record.long_score_ledger
        : historicalShortsDisplayLedger(record);
    const ledgerValidation = scoreDomain === 'longquant'
        ? longScoreLedger.validateLongOutputContract(record)
        : { valid: !!ledger };
    if (
        !ledgerValidation.valid
        || !exactSha256(ledger && ledger.ledger_sha256)
    ) {
        return null;
    }
    const targets = scoreDomain === 'longquant'
        ? LONGQUANT_SAVED_METRICS
        : SAVED_HOOK_METRICS;
    const selected = {};
    for (const target of targets) {
        selected[target] = scoreDomain === 'longquant'
            ? longQuantEmbeddingSelection(record, target)
            : historicalShortsEmbeddingSelection(
                record,
                target,
                ledger
            );
    }
    if (!Object.values(selected).some(Boolean)) return null;
    const manifest = record.input_manifest
        && typeof record.input_manifest === 'object'
        ? record.input_manifest
        : {};
    const revisionFingerprint = exactSha256(
        manifest.revision_fingerprint
    )
        ? manifest.revision_fingerprint
        : null;
    const display = {
        schema: HISTORICAL_SAVED_HOOK_DISPLAY_SCHEMA,
        version: HISTORICAL_SAVED_HOOK_DISPLAY_VERSION,
        record_id: String(record.id),
        score_domain: scoreDomain,
        score_ledger_sha256: ledger.ledger_sha256,
        score_revision_fingerprint: revisionFingerprint,
        m_identity: selected,
        selection_policy: {
            id: scoreDomain === 'longquant'
                ? 'policy.longquant.display-preference.v1'
                : 'policy.shorts.display-preference.v1',
            preference: embeddingDisplayPreference(
                record,
                scoreDomain === 'longquant'
                    ? 'longquant'
                    : 'shorts_raw'
            ),
            role:
                'historical_display_only_hash_bound_materialized_view',
            source_ledger_sha256: ledger.ledger_sha256,
            meaning:
                'Display and navigation only. Values are copied exactly '
                + 'from the persisted score ledger and remain excluded '
                + 'from fitting, validation, and predictor eligibility '
                + 'because the historical input bytes are not jointly bound.',
        },
    };
    display.display_sha256 = sha256Canonical(
        historicalSavedHookDisplayBindingPayload(display)
    );
    return validateHistoricalSavedHookDisplay(display)
        ? display
        : null;
}

function historicalShortsDisplayLedger(record) {
    const ledger = record && record.score_ledger;
    const validation = validateScoreLedger(ledger);
    if (validation.valid) return ledger;
    const materialization = record && record.score_materialization;
    const entries = ledger && Array.isArray(ledger.entries)
        ? ledger.entries
        : [];
    const exactHistoricalMaterialization = !!(
        materialization
        && materialization.schema
            === 'saved-hook-historical-materialization-v1'
        && materialization.role
            === 'historical_evidence_not_live_rescore'
        && materialization.ledger_sha256 === ledger.ledger_sha256
        && exactSha256(materialization.source_record_sha256)
        && Array.isArray(materialization.source_fields)
        && materialization.source_fields.length > 0
        && materialization.source_fields.every(
            field => ['features', 'steer'].includes(field)
        )
        && typeof materialization.claim_boundary === 'string'
        && materialization.claim_boundary
        && entries.length > 0
        && entries.every(entry => {
            const status = entry
                && entry.provenance
                && entry.provenance.status;
            return entry && (
                entry.available === true
                    ? status === 'historical_materialization'
                    : ['unavailable', 'conflict'].includes(status)
            );
        })
    );
    return (
        exactHistoricalMaterialization
        && validation.errors.length === 1
        && validation.errors[0]
            === HISTORICAL_SHORTS_DOCUMENT_MISMATCH_ERROR
    ) ? ledger : null;
}

function historicalShortsEmbeddingSelection(
    record,
    target,
    ledger
) {
    for (const channel of embeddingDisplayPreference(
        record,
        'shorts_raw'
    )) {
        const coordinateId =
            `shorts.stored.${channel}.${target}`;
        const entry = (ledger.entries || []).find(
            candidate => (
                candidate
                && candidate.coordinate_id === coordinateId
            )
        );
        if (
            !entry
            || entry.available !== true
            || !Number.isFinite(Number(entry.value))
        ) {
            continue;
        }
        const inputIdentity = channelInputIdentity(
            record,
            channel,
            'shorts'
        );
        return {
            domain: String(
                record.input_manifest
                && record.input_manifest.domain
                || 'shorts_raw'
            ),
            origin: 'historical-materialized-ledger',
            channel,
            target,
            sourceKey: entry.source_key
                || `${channel}_${target}`,
            coordinateId,
            value: Number(entry.value),
            valueUnit: entry.unit,
            displayUnit: entry.display_unit || entry.unit,
            percentile100: entry.percentile == null
                || !Number.isFinite(Number(entry.percentile))
                ? null
                : Number(entry.percentile),
            percentileUnit:
                coordinateGovernance.percentileStorageUnit,
            modality: inputIdentity.modality,
            input: inputIdentity.input,
            inputPresent: inputIdentity.inputPresent,
            kind:
                entry.provenance
                && entry.provenance.kind || null,
            scorer:
                record.input_manifest
                && record.input_manifest.scorer || null,
            embeddingModel:
                record.input_manifest
                && record.input_manifest.embedding_model || null,
            selectionPolicyId:
                'policy.shorts.display-preference.v1',
            selectionPreference: embeddingDisplayPreference(
                record,
                'shorts_raw'
            ),
            ledgerSha256: ledger.ledger_sha256,
        };
    }
    return null;
}

function scoreDomainForRecord(record, requestedDomain) {
    const manifestDomain = String(
        record && record.input_manifest
        && record.input_manifest.domain || ''
    ).toLowerCase();
    const requested = String(requestedDomain || '').toLowerCase();
    if (
        requested === 'longquant'
        || record && record.score_domain === 'longquant'
        || record && record.long_score_ledger
        || manifestDomain.includes('longquant')
    ) return 'longquant';
    return 'shorts';
}

function embeddingDisplayPreference(record, fallbackDomain) {
    const manifest = record && record.input_manifest && typeof record.input_manifest === 'object'
        ? record.input_manifest
        : {};
    const requested = Array.isArray(manifest.display_preference) ? manifest.display_preference : [];
    const domain = String(manifest.domain || fallbackDomain || 'shorts_raw').toLowerCase();
    const defaults = domain.includes('longquant') ? LONGQUANT_DISPLAY_PREFERENCE : SHORTS_DISPLAY_PREFERENCE;
    const valid = [];
    for (const channel of requested.concat(defaults)) {
        if (!['visual', 'text', 'together'].includes(channel) || valid.includes(channel)) continue;
        valid.push(channel);
    }
    return valid;
}

function channelInputIdentity(record, channel, domain) {
    const manifest = record && record.input_manifest;
    const manifestChannel = manifest && manifest.channels
        && manifest.channels[channel];
    const longInputs = record && record.output_contract
        && record.output_contract.channel_inputs;
    const defaults = domain === 'longquant'
        ? {
            visual: 'thumbnail image only',
            text: 'title or idea text only',
            together: 'thumbnail image plus title or idea',
        }
        : {
            visual: 'first-five-second five-frame montage only',
            text: 'first-five-second transcript only',
            together: 'first-five-second montage plus transcript',
        };
    return {
        modality: channel === 'together' ? 'multimodal' : channel,
        input: String(
            domain === 'longquant'
                ? longInputs && longInputs[channel]
                    || defaults[channel]
                : manifestChannel && manifestChannel.input
                    || defaults[channel]
        ),
        inputPresent: domain === 'longquant'
            ? channel === 'visual'
                ? !!(
                    manifest
                    && manifest.query_input
                    && manifest.query_input.thumbnail
                    && manifest.query_input.thumbnail.present
                )
                : !!(
                    manifest
                    && manifest.query_input
                    && manifest.query_input.text
                    && manifest.query_input.text.present
                )
            : !!(manifestChannel && manifestChannel.present === true),
    };
}

function embeddingSteerSelection(record, target, fallbackDomain) {
    for (const channel of embeddingDisplayPreference(record, fallbackDomain)) {
        const sourceKey = `${channel}_${target}`;
        const coordinateId = coordinateGovernance.coordinates.storedPattern
            .replace('{featureKey}', `${channel}.${target}`);
        const ledgerCell = ledgerFeatureCell(
            record,
            `${channel}.${target}`
        );
        if (ledgerCell.ledgerPresent) {
            if (ledgerCell.value != null) {
                const entry = ledgerCell.entry;
                const inputIdentity = channelInputIdentity(
                    record,
                    channel,
                    'shorts'
                );
                const historical = entry.provenance
                    && entry.provenance.status
                        === 'historical_materialization';
                return {
                    domain: String((record.input_manifest && record.input_manifest.domain) || fallbackDomain || 'shorts_raw'),
                    origin: historical
                        ? 'historical-materialized-ledger'
                        : 'canonical-score-ledger',
                    channel,
                    target,
                    sourceKey: entry.source_key || sourceKey,
                    coordinateId,
                    value: Number(entry.value),
                    valueUnit: entry.unit,
                    displayUnit: entry.display_unit || entry.unit,
                    percentile100: entry.percentile == null
                        || !isFinite(Number(entry.percentile))
                        ? null
                        : Number(entry.percentile),
                    percentileUnit:
                        coordinateGovernance.percentileStorageUnit,
                    modality: inputIdentity.modality,
                    input: inputIdentity.input,
                    inputPresent: inputIdentity.inputPresent,
                    kind: entry.provenance && entry.provenance.kind || null,
                    scorer: (record.input_manifest && record.input_manifest.scorer) || null,
                    embeddingModel: (record.input_manifest && record.input_manifest.embedding_model) || null,
                    selectionPolicyId: 'policy.shorts.display-preference.v1',
                    selectionPreference: embeddingDisplayPreference(record, fallbackDomain),
                    ledgerSha256: ledgerCell.ledgerSha256,
                };
            }
            continue;
        }
    }
    return null;
}

function longQuantEmbeddingSelection(record, target) {
    const contractValidation =
        longScoreLedger.validateLongOutputContract(record);
    if (!contractValidation.valid) return null;
    for (const channel of embeddingDisplayPreference(
        record,
        'longquant'
    )) {
        const cell = longScoreLedger.longLedgerCell(
            record,
            channel,
            target
        );
        if (!cell.valid || !cell.entry) continue;
        const definition = longScoreLedger.METRIC_DEFINITIONS.find(
            candidate => candidate.key === target
        );
        const inputIdentity = channelInputIdentity(
            record,
            channel,
            'longquant'
        );
        return {
            domain: 'longquant',
            origin: 'canonical-long-score-ledger',
            channel,
            target,
            sourceKey: null,
            coordinateId: cell.coordinateId,
            value: cell.value,
            valueUnit: definition && definition.unit || 'number',
            displayUnit: definition && definition.unit || 'number',
            percentile100: cell.percentile,
            percentileUnit: longScoreLedger.PERCENTILE_STORAGE_UNIT,
            modality: inputIdentity.modality,
            input: inputIdentity.input,
            inputPresent: inputIdentity.inputPresent,
            kind: cell.entry.kind || null,
            projection: cell.entry.projection || null,
            scorer:
                record.input_manifest
                && record.input_manifest.scorer || null,
            embeddingModel:
                record.input_manifest
                && record.input_manifest.embedding_model || null,
            selectionPolicyId:
                'policy.longquant.display-preference.v1',
            selectionPreference: embeddingDisplayPreference(
                record,
                'longquant'
            ),
            ledgerSha256: cell.ledgerSha256,
        };
    }
    return null;
}

function compactSavedHookRecord(record, options = {}) {
    const scoreDomain = scoreDomainForRecord(
        record,
        options.scoreDomain
    );
    const selected = {};
    const targets = scoreDomain === 'longquant'
        ? LONGQUANT_SAVED_METRICS
        : SAVED_HOOK_METRICS;
    const scoredLongRecord = scoreDomain === 'longquant' && !!(
        record && record.kind === 'scored'
        || record && record.long_score_ledger
        || record && record.output_contract
    );
    if (scoredLongRecord) {
        const contractValidation =
            longScoreLedger.validateLongOutputContract(record);
        const inputValidation =
            longScoreLedger.validateLongInputManifest(record);
        if (
            !contractValidation.valid
            || !inputValidation.valid
        ) {
            throw new Error(
                contractValidation.errors
                    .concat(inputValidation.errors)
                    .join('; ')
                || 'canonical Long score contract is invalid'
            );
        }
    }
    for (const target of targets) {
        selected[target] = scoredLongRecord
            ? longQuantEmbeddingSelection(record, target)
            : scoreDomain === 'longquant'
                ? null
                : embeddingSteerSelection(
                    record,
                    target,
                    'shorts_raw'
                );
    }
    const manifest = record && record.input_manifest && typeof record.input_manifest === 'object'
        ? record.input_manifest
        : {};
    const visualForecast = record && record.visual_keep_forecast && typeof record.visual_keep_forecast === 'object'
        ? record.visual_keep_forecast
        : null;
    const creatorForecast = record && record.creator_adaptive_keep_forecast && typeof record.creator_adaptive_keep_forecast === 'object'
        ? record.creator_adaptive_keep_forecast
        : null;
    const scoreRecordSha256 =
        savedHookScoreRecordSha256(record);
    if (
        record && record.score_record_sha256
        && record.score_record_sha256 !== scoreRecordSha256
    ) {
        throw new Error(
            'saved hook score record binding does not match its source record'
        );
    }
    const compact = {
        id: record.id,
        title: record.title,
        kind: record.kind,
        score_domain: scoreDomain,
        hasMontage: !!record.hasMontage,
        savedAt: record.savedAt,
        folder: record.folder || null,
        input_manifest: record.input_manifest || null,
        score_revision_fingerprint: manifest.revision_fingerprint || null,
        embedding_input_fingerprint: manifest.embedding_input_fingerprint || null,
        score_input_fingerprint: manifest.score_input_fingerprint || manifest.input_fingerprint || null,
        creator_profile: manifest.creator_profile || null,
        score_record_sha256: scoreRecordSha256,
        score_ledger_sha256:
            scoreDomain === 'longquant'
                ? record.long_score_ledger
                    && record.long_score_ledger.ledger_sha256 || null
                : record && record.score_ledger
                    && record.score_ledger.ledger_sha256 || null,
        output_contract_sha256:
            scoreDomain === 'longquant'
                ? sha256Canonical(record.output_contract)
                : null,
        record_ref: savedHookRecordReference(
            record,
            scoreRecordSha256
        ),
        m_identity: selected,
        selection_policy: {
            id: scoreDomain === 'longquant'
                ? 'policy.longquant.display-preference.v1'
                : 'policy.shorts.display-preference.v1',
            preference: embeddingDisplayPreference(
                record,
                scoreDomain === 'longquant'
                    ? 'longquant'
                    : 'shorts_raw'
            ),
            role: 'non_authoritative_hash_bound_materialized_view',
            source_ledger_sha256:
                scoreDomain === 'longquant'
                    ? record.long_score_ledger
                        && record.long_score_ledger.ledger_sha256 || null
                    : record && record.score_ledger
                        && record.score_ledger.ledger_sha256 || null,
            meaning: 'A compact navigation view only. Every selected value retains its canonical coordinateId and source ledger hash; the policy does not create a generic metric coordinate or a second score authority.',
        },
        derived_identity: scoreDomain === 'longquant' ? null : {
            visual_keep_forecast: visualForecast ? {
                coordinateId: visualForecast.coordinate_id
                    || coordinateGovernance.coordinates.visualKeepForecast.id,
                raw: visualForecast.raw == null ? null : Number(visualForecast.raw),
                artifactSha256: visualForecast.model_artifact_sha256 || null,
            } : null,
            creator_adaptive_keep: creatorForecast ? {
                coordinateId: creatorForecast.coordinate_id
                    || coordinateGovernance.coordinates
                        .creatorAdaptiveKeepForecast.id,
                raw: creatorForecast.raw == null ? null : Number(creatorForecast.raw),
                profile: creatorForecast.profile_account || manifest.creator_profile || null,
                modelArtifactSha256: creatorForecast.model_artifact_sha256 || null,
                servingArtifactSha256: creatorForecast.serving_artifact_sha256 || null,
            } : null,
        },
    };
    compact.compact_score_sha256 = sha256Canonical(
        compactSavedHookBindingPayload(compact)
    );
    return compact;
}

module.exports = {
    SAVED_HOOK_INDEX_VERSION,
    HISTORICAL_SAVED_HOOK_DISPLAY_SCHEMA,
    HISTORICAL_SAVED_HOOK_DISPLAY_VERSION,
    SHORTS_DISPLAY_PREFERENCE,
    LONGQUANT_DISPLAY_PREFERENCE,
    LONGQUANT_SAVED_METRICS,
    SAVED_HOOK_METRICS,
    compactSavedHookBindingPayload,
    embeddingDisplayPreference,
    embeddingSteerSelection,
    longQuantEmbeddingSelection,
    compactSavedHookRecord,
    scoreDomainForRecord,
    savedHookScoreRecordSha256,
    historicalSavedHookDisplay,
    historicalSavedHookDisplayBindingPayload,
    validateCompactSavedHookRecord,
    validateCompactSavedHookSource,
    validateHistoricalSavedHookDisplay,
};
