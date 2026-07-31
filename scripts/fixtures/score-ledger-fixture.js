'use strict';

const crypto = require('crypto');
const ledgerContract = require(
    '../../buildings/jarvis/shorts-score-ledger'
);

function scoreLedgerFromFeatures(features) {
    const entries = ledgerContract.FEATURE_DEFINITIONS.map(definition => {
        const cell = features[definition.key];
        const available = (
            Array.isArray(cell)
            && Number.isFinite(Number(cell[0]))
        );
        return {
            coordinate_id: definition.coordinateId,
            feature_key: definition.key,
            group: definition.group,
            target: definition.target,
            source: definition.source,
            source_key: definition.sourceKey || definition.key,
            unit: definition.unit,
            display_unit: definition.displayUnit,
            value: available ? Number(cell[0]) : null,
            percentile: available && cell[1] != null
                ? Number(cell[1])
                : null,
            available,
            unavailable_reason: available
                ? null
                : 'fixture input unavailable',
            provenance: definition.source === 'novelty'
                ? {
                    status: available ? 'selected' : 'unavailable',
                    target: definition.target,
                }
                : { kind: 'fixture' },
        };
    });
    const payload = {
        schema: 'shorts-stored-score-ledger-v1',
        schema_version: 1,
        ledger_version: ledgerContract.GOVERNANCE.ledgerVersion,
        feature_contract_version:
            ledgerContract.FEATURE_CONTRACT.version,
        feature_contract_identity_schema_version:
            ledgerContract.FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
        feature_contract_sha256:
            ledgerContract.FEATURE_CONTRACT_SHA256,
        feature_contract_document_sha256:
            ledgerContract.FEATURE_CONTRACT_DOCUMENT_SHA256,
        coordinate_governance_version:
            ledgerContract.GOVERNANCE.schemaVersion,
        coordinate_governance_sha256:
            ledgerContract.GOVERNANCE_SHA256,
        expected_coordinate_ids:
            [...ledgerContract.EXPECTED_COORDINATE_IDS],
        entries,
        values_by_id: Object.fromEntries(
            entries.map(entry => [entry.coordinate_id, entry.value])
        ),
        percentiles_by_id: Object.fromEntries(
            entries.map(entry => [
                entry.coordinate_id,
                entry.percentile,
            ])
        ),
        schema_complete: true,
        all_values_available: entries.every(entry => entry.available),
        available_count:
            entries.filter(entry => entry.available).length,
        unavailable: entries.filter(entry => !entry.available).map(
            entry => ({
                coordinate_id: entry.coordinate_id,
                reason: entry.unavailable_reason,
            })
        ),
        registry_revision: null,
        registry_meta: null,
    };
    payload.ledger_sha256 = crypto.createHash('sha256')
        .update(ledgerContract.canonicalJson(payload))
        .digest('hex');
    const validation = ledgerContract.validateScoreLedger(payload);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return payload;
}

module.exports = { scoreLedgerFromFeatures };
