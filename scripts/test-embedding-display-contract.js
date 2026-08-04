#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const contract = require('../embedding-display-contract');
const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const longScoreLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const longHookLibraryIndex = require(
    '../buildings/jarvis/long-hook-library-index'
);
const savedHookRuntimeIndex = require(
    '../buildings/jarvis/saved-hook-runtime-index'
);
const storyboardContract = require(
    '../buildings/jarvis/storyboard-contract'
);
const {
    createR2JsonCasMutator,
} = require('../buildings/jarvis/r2-json-cas');
const {
    scoreLedgerFromFeatures,
} = require('./fixtures/score-ledger-fixture');
const quantCoordinateGovernance = require('../buildings/jarvis/quant-coordinate-governance.json');
const helperStart = serverSource.indexOf("const SAVED_HOOK_INDEX_KEY =");
const helperEnd = serverSource.indexOf('\nfunction savedChannelId', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, 'embedding display contract helpers were not found');

const objects = new Map();
const revisions = new Map();
const writes = [];
class MissingR2ObjectError extends Error {}
class R2PreconditionFailedError extends Error {}
class HttpRequestError extends Error {
    constructor(statusCode, message, code) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}
const context = {
    Buffer,
    console,
    isFinite,
    HttpRequestError,
    SAVED_HOOK_INDEX_VERSION: contract.SAVED_HOOK_INDEX_VERSION,
    embeddingDisplayPreference: contract.embeddingDisplayPreference,
    embeddingSteerSelection: contract.embeddingSteerSelection,
    compactSavedHookRecord: contract.compactSavedHookRecord,
    savedHookScoreRecordSha256: contract.savedHookScoreRecordSha256,
    scoreDomainForRecord: contract.scoreDomainForRecord,
    validateCompactSavedHookRecord:
        contract.validateCompactSavedHookRecord,
    quantCoordinateGovernance,
    shortsScoreLedger,
    longScoreLedger,
    longHookLibraryIndex,
    savedHookRuntimeIndex,
    storyboardContract,
    createR2JsonCasMutator,
    cloud: {
        downloadFromR2: async key => objects.has(key) ? Buffer.from(objects.get(key)) : null,
        uploadToR2: async (key, body) => {
            await new Promise(resolve => setTimeout(resolve, 2));
            objects.set(key, Buffer.from(body));
            writes.push(key);
        },
        getR2SmallObject: async (key, options = {}) => {
            if (!objects.has(key)) {
                throw new MissingR2ObjectError(key);
            }
            const etag = `"${revisions.get(key) || 1}"`;
            if (options.ifMatch && options.ifMatch !== etag) {
                throw new R2PreconditionFailedError(key);
            }
            return {
                key,
                body: Buffer.from(objects.get(key)),
                etag,
            };
        },
        putR2SmallObjectConditional:
            async (key, body, options = {}) => {
                await new Promise(resolve => setTimeout(resolve, 2));
                const exists = objects.has(key);
                const currentEtag = exists
                    ? `"${revisions.get(key) || 1}"`
                    : null;
                if (
                    (options.ifNoneMatch === '*' && exists)
                    || (
                        options.ifMatch
                        && options.ifMatch !== currentEtag
                    )
                ) {
                    throw new R2PreconditionFailedError(key);
                }
                const revision = (revisions.get(key) || 1) + 1;
                revisions.set(key, revision);
                objects.set(key, Buffer.from(body));
                writes.push(key);
                return { key, etag: `"${revision}"` };
            },
        isMissingR2ObjectError: error =>
            error instanceof MissingR2ObjectError,
        isR2PreconditionFailedError: error =>
            error instanceof R2PreconditionFailedError,
        listR2Keys: async prefix => [...objects.keys()].filter(
            key => key.startsWith(prefix)
        ),
    },
};
vm.createContext(context);
vm.runInContext(
    serverSource.slice(helperStart, helperEnd)
        + '\nthis.contractApi = { SAVED_HOOK_INDEX_KEY, SAVED_HOOK_INDEX_VERSION, embeddingDisplayPreference, embeddingSteerSelection, compactSavedHookRecord, ensureSavedHookIndexIntegrity, readSavedHookIndex, updateSavedHookIndex };',
    context
);

function metric(est, pctile) {
    return { est, pctile, kind: 'fixture' };
}

function record(domain, displayPreference) {
    const output = {
        id: domain === 'longquant' ? 'long-1' : 'short-1',
        title: 'Preference fixture',
        kind: 'scored',
        hasMontage: true,
        savedAt: 123,
        input_manifest: {
            domain,
            display_preference: displayPreference,
            scorer: domain === 'longquant' ? 'longquant_score.py' : 'raw_upload.py',
            embedding_model: 'gemini-embedding-2',
        },
        steer: {
            together_keep: metric(82, 82),
            text_keep: metric(85, 85),
            visual_keep: metric(99, 99),
            together_ret5: metric(77, 77),
            visual_ret5: metric(98, 98),
            together_views: metric(12_000_000, 88),
            visual_views: metric(50_000_000, 99),
            together_realviews: metric(4_000_000, null),
            visual_realviews: metric(9_000_000, null),
            together_gt10M: metric(.42, 73),
            visual_gt10M: metric(.91, 99),
            together_outlier: metric(3.2, 76),
            visual_outlier: metric(8.1, 99),
        },
    };
    if (domain !== 'longquant') {
        output.features = Object.fromEntries(
            shortsScoreLedger.FEATURE_DEFINITIONS.map(definition => {
                const cell = output.steer[
                    definition.sourceKey || definition.key
                ];
                return [
                    definition.key,
                    cell ? [cell.est, cell.pctile] : null,
                ];
            })
        );
        output.score_ledger = scoreLedgerFromFeatures(output.features);
    }
    return output;
}

function canonicalLongRecord() {
    const textRevision = value => {
        const bytes = Buffer.from(String(value), 'utf8');
        return {
            present: bytes.length > 0,
            sha256: crypto
                .createHash('sha256')
                .update(bytes)
                .digest('hex'),
            utf8_byte_length: bytes.length,
        };
    };
    const image = Buffer.from('embedding-display-long-fixture');
    const queryPayload = {
        schema_version: 2,
        thumbnail: {
            present: true,
            sha256: crypto
                .createHash('sha256')
                .update(image)
                .digest('hex'),
            byte_length: image.length,
        },
        title: textRevision('Canonical Long fixture'),
        idea: textRevision('Canonical Long fixture'),
        score_text: textRevision('Canonical Long fixture'),
        selected_text_source: 'title',
    };
    const queryInput = {
        ...queryPayload,
        text: queryPayload.score_text,
        generation: 'longquant-query-input-v2',
        fingerprint_sha256:
            shortsScoreLedger.sha256Canonical(queryPayload),
        text_source: 'title',
    };
    const entries = longScoreLedger.OUTPUT_COORDINATES.map(
        (coordinate, index) => {
            const [, , group, target] = coordinate.split('.');
            const valueByTarget = {
                ctrviews: 90 + index / 100,
                ctr: 6.5 + index / 100,
                ret30: 54 + index / 100,
                views: 20_000_000 + index,
                scaled_views: 4 + index / 100,
                realviews: 8_000_000 + index,
                gt10m: 0.7 + index / 1000,
            };
            const provenance = {
                coordinate,
                query_input: queryInput,
            };
            if (coordinate === 'long.output.visual.ctrviews') {
                const artifactSha256 = 'd'.repeat(64);
                const manifestSha256 = 'e'.repeat(64);
                const lineageSha256 = 'f'.repeat(64);
                provenance.artifact_revision = {
                    key: longScoreLedger
                        .VISUAL_CTRVIEWS_ARTIFACT_KEY,
                    sha256: artifactSha256,
                    immutable_key:
                        `${longScoreLedger.VISUAL_CTRVIEWS_ARCHIVE_PREFIX}/${artifactSha256}.npz`,
                    manifest_key: longScoreLedger
                        .VISUAL_CTRVIEWS_MANIFEST_KEY,
                    manifest_sha256: manifestSha256,
                    immutable_manifest_key:
                        `${longScoreLedger.VISUAL_CTRVIEWS_ARCHIVE_PREFIX}/${artifactSha256}.manifest.json`,
                    lineage_schema_version: longScoreLedger
                        .VISUAL_CTRVIEWS_LINEAGE_SCHEMA_VERSION,
                    lineage_manifest_sha256: lineageSha256,
                };
                provenance.dataset_lineage = {
                    lineage_manifest_sha256: lineageSha256,
                    release_manifest_sha256: manifestSha256,
                    lineage_manifest: {
                        schemaVersion: longScoreLedger
                            .VISUAL_CTRVIEWS_LINEAGE_SCHEMA_VERSION,
                    },
                };
            }
            return {
                coordinate_id: coordinate,
                group,
                metric: target,
                available: true,
                value: valueByTarget[target],
                percentile: 70 + index,
                kind: 'fixture',
                projection: target,
                unavailable_reason: null,
                provenance,
            };
        }
    );
    const ledger = {
        schema: 'long-stored-score-ledger-v1',
        schema_version: 1,
        percentile_unit: longScoreLedger.PERCENTILE_STORAGE_UNIT,
        ledger_version:
            shortsScoreLedger.GOVERNANCE.ledgerVersion,
        governance_schema_version:
            shortsScoreLedger.GOVERNANCE.schemaVersion,
        governance_sha256:
            shortsScoreLedger.GOVERNANCE_SHA256,
        coordinate_ids: [...longScoreLedger.OUTPUT_COORDINATES],
        entries,
        values_by_id: Object.fromEntries(entries.map(entry => [
            entry.coordinate_id,
            entry.value,
        ])),
        percentiles_by_id: Object.fromEntries(entries.map(entry => [
            entry.coordinate_id,
            entry.percentile,
        ])),
        available_count: entries.length,
        expected_count: entries.length,
        schema_complete: true,
        all_values_available: true,
        producer_errors: [],
        contract_valid: true,
    };
    ledger.ledger_sha256 =
        shortsScoreLedger.sha256Canonical(ledger);
    const output = {
        id: 'long-1',
        title: 'Canonical Long fixture',
        kind: 'scored',
        score_domain: 'longquant',
        savedAt: 456,
        hasMontage: true,
        input_manifest: {
            domain: 'longquant',
            display_preference: ['visual', 'together', 'text'],
            scorer: 'longquant_score.py',
            embedding_model: 'gemini-embedding-2',
            query_input: queryInput,
            query_input_fingerprint:
                queryInput.fingerprint_sha256,
            thumbnail_sha256:
                queryInput.thumbnail.sha256,
            score_text_sha256:
                queryInput.score_text.sha256,
        },
        long_score_ledger: ledger,
    };
    output.output_contract =
        longScoreLedger.longOutputContract(ledger);
    const visualPercentile = entries.find(
        entry => entry.coordinate_id === 'long.output.visual.ctrviews'
    ).percentile / 100;
    output.pctile = visualPercentile;
    output.visual_pctile = visualPercentile;
    output.thumbnail_potential = visualPercentile;
    output.score_alias_contract = {
        schema: longScoreLedger.SCORE_ALIAS_SCHEMA,
        canonical_coordinate_id: 'long.output.visual.ctrviews',
        canonical_field: 'percentile',
        canonical_value: visualPercentile,
        decision_use: 'thumbnail_threshold_and_rewards',
        decision_eligible: true,
        compatibility_aliases: Object.fromEntries(
            ['pctile', 'visual_pctile', 'thumbnail_potential'].map(name => [
                name,
                {
                    coordinate_id: 'long.output.visual.ctrviews',
                    field: 'percentile',
                },
            ])
        ),
    };
    output.relevance = 0.8;
    output.nn_cos = 0.9;
    output.idea_model_reward = visualPercentile;
    output.thumbnail_model_reward = visualPercentile;
    output.training_reward = visualPercentile;
    output.reward = visualPercentile;
    output.reward_trace = {
        schema: longScoreLedger.REWARD_TRACE_SCHEMA,
        visual_pctile: visualPercentile,
        relevance: output.relevance,
        relevance_floor: 0.35,
        relevance_penalty: 0,
        density: output.nn_cos,
        density_floor: 0.759826,
        density_penalty: 0,
        idea_model_reward: output.idea_model_reward,
        thumbnail_model_reward: output.thumbnail_model_reward,
        threshold_score: visualPercentile,
        threshold_channel: 'visual',
        together_used_for_threshold: false,
    };
    return output;
}

async function main() {
    const api = context.contractApi;
    const shortRecord = record('shorts_raw', ['together', 'text', 'visual']);
    const selectedShort = api.embeddingSteerSelection(shortRecord, 'keep', 'shorts_raw');
    assert.strictEqual(selectedShort.channel, 'together', 'Shorts must honor Both-first display preference');
    assert.strictEqual(selectedShort.value, 82, 'Shorts selected value drifted from the Both embedding');
    assert.strictEqual(selectedShort.valueUnit, 'percent');
    assert.strictEqual(selectedShort.percentile100, 82);
    assert.strictEqual(selectedShort.percentileUnit, 'percentile_0_100');
    assert.strictEqual(selectedShort.modality, 'multimodal');
    assert.strictEqual(
        selectedShort.input,
        'first-five-second montage plus transcript'
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(selectedShort, 'est'),
        false,
        'compact identities must not duplicate the canonical value as est'
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(selectedShort, 'pctile'),
        false,
        'compact identities must not duplicate percentile100 as pctile'
    );
    assert.strictEqual(selectedShort.sourceKey, 'together_keep');
    assert.strictEqual(selectedShort.coordinateId, 'shorts.stored.together.keep');
    assert.strictEqual(selectedShort.selectionPolicyId, 'policy.shorts.display-preference.v1');
    assert.deepStrictEqual(
        selectedShort.selectionPreference,
        ['together', 'text', 'visual'],
        'display selection must preserve the complete coordinate-addressed preference order'
    );

    const compact = api.compactSavedHookRecord(shortRecord);
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(compact, 'keep'),
        false,
        'compact cards must not mint an unaddressed top-level keep scalar'
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(compact, 'm'),
        false,
        'compact cards must not persist generic metric aliases beside coordinate-addressed identities'
    );
    assert.strictEqual(compact.m_identity.keep.sourceKey, 'together_keep', 'saved card must persist its exact source identity');
    assert.strictEqual(compact.m_identity.keep.coordinateId, 'shorts.stored.together.keep');
    assert.strictEqual(compact.m_identity.views.value, 12_000_000, 'saved identity must persist the exact raw value');
    assert.strictEqual(compact.m_identity.views.coordinateId, 'shorts.stored.together.views');
    const historicalDisplay =
        contract.historicalSavedHookDisplay(shortRecord);
    assert(
        contract.validateHistoricalSavedHookDisplay(
            historicalDisplay
        ),
        'valid score ledger did not produce a historical display view'
    );
    assert.strictEqual(
        historicalDisplay.m_identity.keep.value,
        compact.m_identity.keep.value
    );
    assert.strictEqual(
        historicalDisplay.m_identity.keep.ledgerSha256,
        compact.score_ledger_sha256
    );
    const priorDocumentHistoricalRecord = JSON.parse(
        JSON.stringify(shortRecord)
    );
    priorDocumentHistoricalRecord.score_ledger.entries.forEach(
        entry => {
            entry.provenance = {
                status: entry.available
                    ? 'historical_materialization'
                    : 'unavailable',
                source: 'legacy_steer_cache',
            };
        }
    );
    priorDocumentHistoricalRecord.score_ledger
        .feature_contract_document_sha256 = '4'.repeat(64);
    delete priorDocumentHistoricalRecord.score_ledger.ledger_sha256;
    priorDocumentHistoricalRecord.score_ledger.ledger_sha256 =
        shortsScoreLedger.sha256Canonical(
            priorDocumentHistoricalRecord.score_ledger
        );
    priorDocumentHistoricalRecord.score_materialization = {
        schema: 'saved-hook-historical-materialization-v1',
        role: 'historical_evidence_not_live_rescore',
        ledger_sha256:
            priorDocumentHistoricalRecord.score_ledger.ledger_sha256,
        source_record_sha256: '5'.repeat(64),
        source_fields: ['steer'],
        claim_boundary:
            'Historical values only; not a current prediction.',
    };
    const priorDocumentLedgerValidation =
        shortsScoreLedger.validateScoreLedger(
            priorDocumentHistoricalRecord.score_ledger
        );
    assert.strictEqual(priorDocumentLedgerValidation.valid, true);
    assert.strictEqual(
        priorDocumentLedgerValidation.featureContractDocumentCurrent,
        false,
        'the archived descriptive document revision must remain explicit'
    );
    const priorDocumentDisplay =
        contract.historicalSavedHookDisplay(
            priorDocumentHistoricalRecord
        );
    assert(
        contract.validateHistoricalSavedHookDisplay(
            priorDocumentDisplay
        ),
        'an explicitly bounded historical materialization lost its exact display-only values'
    );
    assert.strictEqual(
        priorDocumentDisplay.m_identity.keep.value,
        historicalDisplay.m_identity.keep.value
    );
    assert.strictEqual(
        priorDocumentDisplay.score_ledger_sha256,
        priorDocumentHistoricalRecord.score_ledger.ledger_sha256,
        'historical display identity must retain the original ledger hash'
    );
    const unboundedPriorDocumentRecord = JSON.parse(
        JSON.stringify(priorDocumentHistoricalRecord)
    );
    delete unboundedPriorDocumentRecord.score_materialization;
    const unboundedPriorDocumentDisplay =
        contract.historicalSavedHookDisplay(
            unboundedPriorDocumentRecord
        );
    assert(
        contract.validateHistoricalSavedHookDisplay(
            unboundedPriorDocumentDisplay
        ),
        'a hash-bound ledger with unchanged semantic identity must remain available as display-only evidence'
    );
    assert.strictEqual(
        unboundedPriorDocumentDisplay.score_ledger_sha256,
        unboundedPriorDocumentRecord.score_ledger.ledger_sha256
    );
    const hashTamperedPriorDocumentRecord = JSON.parse(
        JSON.stringify(priorDocumentHistoricalRecord)
    );
    hashTamperedPriorDocumentRecord.score_ledger.entries[0].value += 1;
    assert.strictEqual(
        contract.historicalSavedHookDisplay(
            hashTamperedPriorDocumentRecord
        ),
        null,
        'a historical materialization with a second integrity failure was accepted'
    );
    const tamperedHistoricalDisplay =
        JSON.parse(JSON.stringify(historicalDisplay));
    tamperedHistoricalDisplay.m_identity.keep.value += 1;
    assert.strictEqual(
        contract.validateHistoricalSavedHookDisplay(
            tamperedHistoricalDisplay
        ),
        false,
        'historical display accepted a value changed after binding'
    );
    assert.strictEqual(compact.selection_policy.id, 'policy.shorts.display-preference.v1');
    assert.deepStrictEqual(compact.selection_policy.preference, ['together', 'text', 'visual']);
    assert.strictEqual(
        contract.validateCompactSavedHookRecord(compact),
        true,
        'a compact row must bind every displayed score to one score record'
    );
    assert.strictEqual(
        contract.validateCompactSavedHookSource(
            compact,
            shortRecord
        ),
        true,
        'a compact row must resolve to the exact full source record'
    );
    assert.strictEqual(
        contract.validateCompactSavedHookSource(compact, null),
        false,
        'a compact row cannot establish source existence without its full record'
    );
    const staleSource = JSON.parse(JSON.stringify(shortRecord));
    staleSource.title = 'Changed after the index was written';
    assert.strictEqual(
        contract.validateCompactSavedHookSource(
            compact,
            staleSource
        ),
        false,
        'a compact row must reject a newer or otherwise different source revision'
    );
    const staleLedgerSource = JSON.parse(
        JSON.stringify(shortRecord)
    );
    staleLedgerSource.score_ledger.entries[0].value += 1;
    assert.strictEqual(
        contract.validateCompactSavedHookSource(
            compact,
            staleLedgerSource
        ),
        false,
        'a compact row must reject a hash-tampered source ledger'
    );
    const tamperedCompact = JSON.parse(JSON.stringify(compact));
    tamperedCompact.m = { keep: 82 };
    assert.strictEqual(
        contract.validateCompactSavedHookRecord(tamperedCompact),
        false,
        'adding a generic compact display alias must invalidate the row'
    );
    const tamperedCompactMedia = JSON.parse(
        JSON.stringify(compact)
    );
    tamperedCompactMedia.hasMontage = false;
    assert.strictEqual(
        contract.validateCompactSavedHookRecord(
            tamperedCompactMedia
        ),
        false,
        'compact media availability must be bound'
    );
    const tamperedCompactReference = JSON.parse(
        JSON.stringify(compact)
    );
    tamperedCompactReference.record_ref.storage_key =
        'raw/saved-hooks/somewhere-else.json';
    assert.strictEqual(
        contract.validateCompactSavedHookRecord(
            tamperedCompactReference
        ),
        false,
        'compact rows must bind the deterministic source storage key'
    );
    const legacyCompact = JSON.parse(JSON.stringify(compact));
    delete legacyCompact.record_ref;
    legacyCompact.compact_score_sha256 =
        shortsScoreLedger.sha256Canonical(
            contract.compactSavedHookBindingPayload(
                legacyCompact
            )
        );
    assert.strictEqual(
        contract.validateCompactSavedHookRecord(legacyCompact),
        false,
        'pre-reference compact rows must force an index rebuild'
    );
    const noLedgerRecord = JSON.parse(JSON.stringify(shortRecord));
    delete noLedgerRecord.score_ledger;
    assert.strictEqual(
        contract.embeddingSteerSelection(
            noLedgerRecord,
            'keep',
            'shorts_raw'
        ),
        null,
        'display selection must not materialize legacy steer/features fallbacks'
    );

    const longRecord = canonicalLongRecord();
    const selectedLong = contract.longQuantEmbeddingSelection(
        longRecord,
        'views'
    );
    assert.strictEqual(selectedLong.channel, 'visual', 'Long Quant must honor image-only Visual-first display preference');
    assert.strictEqual(
        selectedLong.coordinateId,
        'long.output.visual.views'
    );
    const compactLong = contract.compactSavedHookRecord(longRecord);
    assert.strictEqual(compactLong.score_domain, 'longquant');
    assert.strictEqual(
        compactLong.selection_policy.id,
        'policy.longquant.display-preference.v1'
    );
    assert.strictEqual(
        compactLong.m_identity.views.coordinateId,
        'long.output.visual.views'
    );
    assert.strictEqual(
        contract.validateCompactSavedHookRecord(compactLong),
        true
    );
    assert.strictEqual(
        contract.validateCompactSavedHookSource(
            compactLong,
            longRecord
        ),
        true,
        'Long compact rows must resolve to their exact full source record'
    );
    const longAsShort = JSON.parse(JSON.stringify(compactLong));
    longAsShort.score_domain = 'shorts';
    assert.strictEqual(
        contract.validateCompactSavedHookRecord(longAsShort),
        false,
        'a Long coordinate cannot be relabeled as a Shorts row'
    );
    const tamperedLong = JSON.parse(JSON.stringify(longRecord));
    tamperedLong.long_score_ledger.values_by_id[
        'long.output.visual.views'
    ] += 1;
    assert.throws(
        () => contract.compactSavedHookRecord(tamperedLong),
        /value index differs|content hash does not match/,
        'a tampered Long ledger cannot enter the compact index'
    );

    const fallback = record('shorts_raw', []);
    delete fallback.steer.together_keep;
    fallback.features['together.keep'] = null;
    fallback.score_ledger = scoreLedgerFromFeatures(
        fallback.features
    );
    const selectedFallback = api.embeddingSteerSelection(fallback, 'keep', 'shorts_raw');
    assert.strictEqual(selectedFallback.channel, 'text', 'Shorts missing-channel fallback must be Text before Visual');
    assert.strictEqual(selectedFallback.value, 85);
    assert.strictEqual(selectedFallback.coordinateId, 'shorts.stored.text.keep');

    objects.set(
        api.SAVED_HOOK_INDEX_KEY,
        Buffer.from(JSON.stringify(
            savedHookRuntimeIndex.bindIndex({
                hooks: [],
                legacy_hooks: [],
                folders: [],
            })
        ))
    );
    await api.ensureSavedHookIndexIntegrity(
        await api.readSavedHookIndex()
    );
    writes.length = 0;
    const canonicalRuntimeRecord = (id, marker) => {
        const source = JSON.parse(JSON.stringify(shortRecord));
        const embeddingFingerprint = marker.repeat(64);
        const scoreFingerprint = (
            marker === 'a' ? 'c' : 'd'
        ).repeat(64);
        source.id = id;
        source.input_manifest = {
            ...source.input_manifest,
            domain: 'shorts_raw',
            revision_fingerprint: (
                marker === 'a' ? 'e' : 'f'
            ).repeat(64),
            embedding_input_fingerprint:
                embeddingFingerprint,
            score_input_fingerprint: scoreFingerprint,
            input_fingerprint: scoreFingerprint,
            canonical_montage: {
                montage_sha256: (
                    marker === 'a' ? '1' : '2'
                ).repeat(64),
            },
        };
        return source;
    };
    await Promise.all([
        api.updateSavedHookIndex(index => {
            index.hooks.push(api.compactSavedHookRecord(
                canonicalRuntimeRecord('a', 'a')
            ));
        }),
        api.updateSavedHookIndex(index => {
            index.hooks.push(api.compactSavedHookRecord(
                canonicalRuntimeRecord('b', 'b')
            ));
        }),
        api.updateSavedHookIndex(index => { index.folders.push({ id: 'f1', name: 'One' }); }),
    ]);
    const updated = JSON.parse(objects.get(api.SAVED_HOOK_INDEX_KEY).toString('utf8'));
    assert.deepStrictEqual(updated.hooks.map(row => row.id), ['a', 'b'], 'serialized index updates lost a concurrent hook');
    assert.strictEqual(updated.folders.length, 1, 'serialized index updates lost a concurrent folder');
    assert.strictEqual(updated.version, api.SAVED_HOOK_INDEX_VERSION, 'saved index version was not upgraded');
    assert(writes.length === 3, 'each serialized mutation should persist exactly once');

    objects.clear();
    writes.length = 0;
    const historicalShort = { ...shortRecord, id: 'short1' };
    delete historicalShort.score_ledger;
    objects.set(
        'raw/saved-hooks/short1.json',
        Buffer.from(JSON.stringify(historicalShort))
    );
    objects.set(
        'raw/saved-hooks/long1.json',
        Buffer.from(JSON.stringify({
            ...longRecord,
            id: 'long1',
            output_contract: null,
        }))
    );
    await assert.rejects(
        async () => api.ensureSavedHookIndexIntegrity(
            await api.readSavedHookIndex()
        ),
        /offline saved-hook index migration|integrity validation/,
        'a missing index with historical source records must require the explicit offline migration'
    );
    assert.strictEqual(
        writes.length,
        0,
        'read-time validation must not scan, rewrite, or materialize records'
    );
    const untouchedShortRecord = JSON.parse(
        objects.get('raw/saved-hooks/short1.json').toString('utf8')
    );
    assert.strictEqual(
        untouchedShortRecord.score_record_sha256,
        undefined,
        'historical Shorts evidence changed during a read'
    );
    const untouchedLongRecord = JSON.parse(
        objects.get('raw/saved-hooks/long1.json').toString('utf8')
    );
    assert.strictEqual(
        untouchedLongRecord.output_contract,
        null,
        'historical Long evidence changed during a read'
    );

    assert(!serverSource.includes("rec.steer['together_' + t] || rec.steer['visual_' + t]"), 'legacy hard-coded saved-card preference still exists');
    assert(serverSource.includes('idx.hooks[at] = compact'), 'enrichment must refresh all compact metrics, not only the montage flag');
    assert(serverSource.includes('saved-hook index update failed:'), 'saved-hook creation can still report success after an index failure');
    const deleteRouteStart = serverSource.indexOf(
        "pathname === '/api/raw/hook-delete'"
    );
    const deleteRouteEnd = serverSource.indexOf(
        '\n    const savedMon =',
        deleteRouteStart
    );
    const deleteRoute = serverSource.slice(
        deleteRouteStart,
        deleteRouteEnd
    );
    const deleteAt = deleteRoute.indexOf('deleteFromR2');
    const indexAt = deleteRoute.indexOf('updateSavedHookIndex');
    assert(
        deleteAt >= 0 && indexAt >= 0,
        'saved-hook deletion lost its record/index operations'
    );
    assert(
        indexAt < deleteAt
        || (
            serverSource.includes(
                'index.source_records_sha256 === sourceSnapshot.sha256'
            )
            && serverSource.includes(
                'const sourceSnapshot = await savedHookSourceSnapshot()'
            )
        ),
        'record-first deletion requires source-snapshot invalidation before the index can be trusted'
    );

    console.log(JSON.stringify({
        ok: true,
        shorts: {
            selected: selectedShort.sourceKey,
            keep: selectedShort.value,
            views: compact.m_identity.views.value,
        },
        longquant: {
            selected: selectedLong.coordinateId,
            views: selectedLong.value,
        },
        fallback: selectedFallback.sourceKey,
        concurrentIndexRows: updated.hooks.length,
        indexVersion: updated.version,
        sourceBinding: compact.record_ref.storage_key,
    }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
