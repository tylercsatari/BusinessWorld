#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const displayContract = require('../embedding-display-contract');
const runtimeIndex = require(
    '../buildings/jarvis/saved-hook-runtime-index'
);
const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const {
    canonicalJsonBytes,
} = require('../buildings/jarvis/canonical-json-artifact');
const {
    migrateSavedHookRuntimeIndex,
} = require('./migrate-saved-hook-runtime-index');

function jpegFixture() {
    const bytes = Buffer.alloc(256, 0x51);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[254] = 0xff;
    bytes[255] = 0xd9;
    return bytes;
}

function legacyRecord() {
    const values = {
        keep: 72,
        ret5: 81,
        views: 2_000_000,
        outlier: 2.4,
        gt10M: 0.18,
        realviews: 1_500_000,
    };
    const steer = {};
    for (const definition of shortsScoreLedger.FEATURE_DEFINITIONS) {
        if (definition.source !== 'steer') continue;
        steer[definition.sourceKey] = {
            est: values[definition.target],
            pctile: definition.target === 'realviews'
                ? null
                : 68,
            kind: definition.target,
        };
    }
    return {
        id: 'legacy-1',
        savedAt: 123,
        kind: 'scored',
        title: 'Historical source',
        text: 'Historical transcript',
        hasMontage: true,
        steer,
        emb_preview: {
            visual: Array(48).fill(0.1),
            text: Array(48).fill(0.2),
            together: Array(48).fill(0.3),
        },
        channels: {
            visual: { neighbors: [] },
            text: { neighbors: [] },
            together: { neighbors: [] },
        },
    };
}

function historicalLedgerRecord() {
    const record = legacyRecord();
    record.score_domain = 'shorts';
    record.score_ledger =
        shortsScoreLedger.materializeHistoricalScoreLedger(record);
    return record;
}

function priorDocumentHistoricalLedgerRecord() {
    const record = historicalLedgerRecord();
    record.score_ledger.feature_contract_document_sha256 =
        '4'.repeat(64);
    delete record.score_ledger.ledger_sha256;
    record.score_ledger.ledger_sha256 =
        shortsScoreLedger.sha256Canonical(record.score_ledger);
    record.score_materialization = {
        schema: 'saved-hook-historical-materialization-v1',
        role: 'historical_evidence_not_live_rescore',
        ledger_sha256: record.score_ledger.ledger_sha256,
        source_record_sha256: '5'.repeat(64),
        source_fields: ['steer'],
        claim_boundary:
            'Historical values only; not a current prediction.',
    };
    const archivedDocumentValidation =
        shortsScoreLedger.validateScoreLedger(
            record.score_ledger
        );
    assert.equal(archivedDocumentValidation.valid, true);
    assert.equal(
        archivedDocumentValidation.featureContractDocumentCurrent,
        false
    );
    return record;
}

function canonicalRecord() {
    const record = legacyRecord();
    const mediaBytes = jpegFixture();
    const ledger =
        shortsScoreLedger.materializeHistoricalScoreLedger(record);
    ledger.entries = ledger.entries.map(entry => ({
        ...entry,
        provenance: entry.available
            ? {
                status: 'current_score',
                source: 'saved_hook_runtime_migration_test',
            }
            : entry.provenance,
    }));
    delete ledger.ledger_sha256;
    ledger.ledger_sha256 =
        shortsScoreLedger.sha256Canonical(ledger);
    const montageSha256 =
        crypto.createHash('sha256').update(mediaBytes).digest('hex');
    const text = record.text;
    const embeddingInput = {
        schema: 'shorts-embedding-input-v2',
        montage_sha256: montageSha256,
        transcript: text,
        channels: {
            visual: '5-frame-montage',
            text: 'normalized-transcript',
            together: '5-frame-montage+normalized-transcript',
        },
    };
    const embeddingInputFingerprint =
        shortsScoreLedger.sha256Canonical(embeddingInput);
    const scoreInput = {
        schema: 'shorts-score-input-v2',
        embedding_input_fingerprint: embeddingInputFingerprint,
        embedding_input: embeddingInput,
        duration_ms: 5000,
        creator_profile: null,
    };
    const scoreInputFingerprint =
        shortsScoreLedger.sha256Canonical(scoreInput);
    const canonical = {
        ...record,
        score_domain: 'shorts',
        dur_s: 5,
        score_ledger: ledger,
        input_manifest: {
            domain: 'shorts_raw',
            scorer: 'saved-hook-runtime-migration-test',
            embedding_model: 'fixture-multimodal',
            embedding_dimensions: 1536,
            source_window: 'first 5 seconds',
            canonical_montage: {
                width: 1280,
                height: 144,
                format: 'JPEG',
                montage_sha256: montageSha256,
            },
            transcript_used: true,
            duration_s: 5,
            input_fingerprint: scoreInputFingerprint,
            score_input_fingerprint: scoreInputFingerprint,
            embedding_input_fingerprint:
                embeddingInputFingerprint,
            revision_fingerprint: crypto
                .createHash('sha256')
                .update('migration-test-revision')
                .digest('hex'),
            output_fingerprint: crypto
                .createHash('sha256')
                .update('migration-test-output')
                .digest('hex'),
            feature_contract_sha256:
                ledger.feature_contract_sha256,
            feature_contract_document_sha256:
                ledger.feature_contract_document_sha256,
            coordinate_governance_version:
                ledger.coordinate_governance_version,
            coordinate_governance_sha256:
                ledger.coordinate_governance_sha256,
            scorer_revisions: {
                scorer: {
                    state: 'present',
                    sha256: crypto
                        .createHash('sha256')
                        .update('migration-test-scorer')
                        .digest('hex'),
                },
            },
            channels: {
                visual: {
                    present: true,
                    input: '5-frame montage only',
                    image: 'canonical montage',
                    text: '',
                },
                text: {
                    present: true,
                    input: 'normalized transcript',
                    image: '',
                    text,
                },
                together: {
                    present: true,
                    input:
                        'canonical montage plus normalized transcript',
                    image: 'canonical montage',
                    text,
                },
            },
        },
        montage_ref: {
            schema: 'saved-hook-canonical-media-v1',
            key:
                'raw/saved-hooks/media/by-sha256/'
                + `${montageSha256}.jpg`,
            sha256: montageSha256,
            byte_length: mediaBytes.length,
            media_type: 'image/jpeg',
        },
    };
    delete canonical.steer;
    delete canonical.emb_preview;
    delete canonical.channels;
    canonical.score_record_sha256 =
        displayContract.savedHookScoreRecordSha256(canonical);
    return { record: canonical, mediaBytes };
}

function memoryStorage(seed) {
    const objects = new Map(
        Object.entries(seed).map(([key, value]) => [
            key,
            Buffer.from(value),
        ])
    );
    const writes = [];
    return {
        objects,
        writes,
        async get(key) {
            return objects.has(key)
                ? Buffer.from(objects.get(key))
                : null;
        },
        async put(key, bytes, mediaType) {
            objects.set(key, Buffer.from(bytes));
            writes.push({ key, mediaType });
        },
    };
}

async function main() {
    const source = priorDocumentHistoricalLedgerRecord();
    const priorIndex = {
        version: 7,
        hooks: [{
            id: source.id,
            title: source.title,
            kind: source.kind,
            hasMontage: true,
            savedAt: source.savedAt,
            m: { keep: 72 },
        }],
        folders: [],
    };
    const storage = memoryStorage({
        'raw/saved-hooks/index.json':
            Buffer.from(JSON.stringify(priorIndex)),
        'raw/saved-hooks/legacy-1.json':
            Buffer.from(JSON.stringify(source)),
        'raw/saved-hooks/legacy-1.jpg': jpegFixture(),
    });

    const dry = await migrateSavedHookRuntimeIndex({
        storage,
        write: false,
    });
    assert.equal(dry.canonical.canonical_rows, 0);
    assert.equal(dry.canonical.legacy_unbound_rows, 1);
    assert.equal(
        dry.canonical.historical_quarantined_rows,
        1
    );
    assert.equal(storage.writes.length, 0);

    const written = await migrateSavedHookRuntimeIndex({
        storage,
        write: true,
    });
    assert.equal(written.canonical.canonical_rows, 0);
    assert.equal(written.canonical.legacy_unbound_rows, 1);
    const historical = JSON.parse(
        storage.objects.get(
            'raw/saved-hooks/legacy-1.json'
        )
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(historical, 'steer'),
        true
    );
    const index = JSON.parse(
        storage.objects.get('raw/saved-hooks/index.json')
    );
    assert.equal(runtimeIndex.validateIndex(index).valid, true);
    assert.equal(index.schema, runtimeIndex.INDEX_SCHEMA);
    assert.equal(index.updatedAt, 0);
    assert.equal(
        storage.objects.get('raw/saved-hooks/index.json').equals(
            runtimeIndex.canonicalIndexBytes(index)
        ),
        true,
        'runtime index bytes are not canonical JSON'
    );
    assert.equal(index.hooks.length, 0);
    assert.equal(index.legacy_hooks.length, 1);
    const historicalDisplay =
        index.legacy_hooks[0].historical_display;
    assert.equal(
        displayContract.validateHistoricalSavedHookDisplay(
            historicalDisplay
        ),
        true,
        'legacy index did not retain a hash-bound ledger display'
    );
    assert.equal(
        historicalDisplay.m_identity.keep.value,
        72
    );
    assert.equal(
        historicalDisplay.m_identity.keep.coordinateId,
        'shorts.stored.together.keep'
    );
    assert.equal(
        historicalDisplay.m_identity.keep.ledgerSha256,
        source.score_ledger.ledger_sha256
    );
    assert.equal(
        written.canonical.historical_display_rows,
        1,
        'a prior-document historical ledger lost its display-only values'
    );
    const staleSource = historicalLedgerRecord();
    const staleDisplay =
        displayContract.historicalSavedHookDisplay(staleSource, {
            scoreDomain: 'shorts',
        });
    staleSource.steer.together_keep.est = 91;
    delete staleSource.score_ledger;
    staleSource.score_ledger =
        shortsScoreLedger.materializeHistoricalScoreLedger(
            staleSource
        );
    staleSource.historical_display = staleDisplay;
    const refreshedLegacy = runtimeIndex.legacyRow(staleSource);
    assert.notEqual(
        refreshedLegacy.historical_display.display_sha256,
        staleDisplay.display_sha256,
        'a self-consistent historical cache from an older ledger was preserved'
    );
    assert.equal(
        refreshedLegacy.historical_display.score_ledger_sha256,
        staleSource.score_ledger.ledger_sha256,
        'legacy display was not regenerated from the current source ledger'
    );
    assert.equal(index.legacy_hooks[0].predictor_eligible, false);
    const scoreInjectedIndex = JSON.parse(JSON.stringify(index));
    scoreInjectedIndex.legacy_hooks[0].predictedKeep = 99;
    scoreInjectedIndex.index_sha256 =
        shortsScoreLedger.sha256Canonical(
            runtimeIndex.bindingPayload(scoreInjectedIndex)
        );
    assert.equal(
        runtimeIndex.validateIndex(scoreInjectedIndex).valid,
        false,
        'runtime index accepted an ad hoc duplicate score field'
    );
    const tamperedDisplayIndex = JSON.parse(JSON.stringify(index));
    tamperedDisplayIndex.legacy_hooks[0]
        .historical_display.m_identity.keep.value = 99;
    tamperedDisplayIndex.index_sha256 =
        shortsScoreLedger.sha256Canonical(
            runtimeIndex.bindingPayload(tamperedDisplayIndex)
        );
    assert.equal(
        runtimeIndex.validateIndex(tamperedDisplayIndex).valid,
        false,
        'runtime index accepted a historical value that no longer '
            + 'matched its display hash'
    );

    const historicalBefore = Buffer.from(
        storage.objects.get(
            'raw/saved-hooks/legacy-1.json'
        )
    );
    const writesBeforeRepeat = storage.writes.length;
    const second = await migrateSavedHookRuntimeIndex({
        storage,
        write: true,
    });
    assert.equal(second.canonical.historical_quarantined_rows, 1);
    assert.equal(
        storage.objects.get(
            'raw/saved-hooks/legacy-1.json'
        ).equals(historicalBefore),
        true
    );
    assert.equal(
        storage.writes.length,
        writesBeforeRepeat,
        'byte-identical rerun issued redundant writes'
    );

    const exact = canonicalRecord();
    const exactCompact =
        displayContract.compactSavedHookRecord(exact.record);
    const exactIndex = runtimeIndex.bindIndex({
        hooks: [exactCompact],
        legacy_hooks: [],
        folders: [],
    });
    const exactStorage = memoryStorage({
        'raw/saved-hooks/index.json':
            runtimeIndex.canonicalIndexBytes(exactIndex),
        'raw/saved-hooks/legacy-1.json':
            canonicalJsonBytes(exact.record),
        [exact.record.montage_ref.key]: exact.mediaBytes,
    });
    const exactResult = await migrateSavedHookRuntimeIndex({
        storage: exactStorage,
        write: false,
    });
    assert.equal(
        exactResult.canonical.canonical_rows,
        1
    );

    const prettySourceBytes = Buffer.from(
        JSON.stringify(exact.record, null, 2)
    );
    const preservedStorage = memoryStorage({
        'raw/saved-hooks/index.json':
            runtimeIndex.canonicalIndexBytes(exactIndex),
        'raw/saved-hooks/legacy-1.json':
            prettySourceBytes,
        [exact.record.montage_ref.key]: exact.mediaBytes,
    });
    const preservedResult = await migrateSavedHookRuntimeIndex({
        storage: preservedStorage,
        write: true,
    });
    assert.equal(
        preservedResult.canonical.canonical_source_preserved_rows,
        1,
        'non-canonical JSON bytes were not reported as preserved'
    );
    assert.equal(
        preservedStorage.objects.get(
            'raw/saved-hooks/legacy-1.json'
        ).equals(prettySourceBytes),
        true,
        'runtime-index migration rewrote a source score record'
    );
    assert.equal(
        preservedStorage.writes.some(
            write => write.key === 'raw/saved-hooks/legacy-1.json'
        ),
        false,
        'runtime-index migration issued a mutable source-record write'
    );

    const outageStorage = memoryStorage({
        'raw/saved-hooks/index.json':
            runtimeIndex.canonicalIndexBytes(exactIndex),
        'raw/saved-hooks/legacy-1.json':
            canonicalJsonBytes(exact.record),
        [exact.record.montage_ref.key]: exact.mediaBytes,
    });
    const outageGet = outageStorage.get.bind(outageStorage);
    outageStorage.get = async key => {
        if (key === exact.record.montage_ref.key) {
            throw new Error('simulated media storage outage');
        }
        return outageGet(key);
    };
    await assert.rejects(
        migrateSavedHookRuntimeIndex({
            storage: outageStorage,
            write: true,
        }),
        /simulated media storage outage/,
        'a transient storage failure was silently converted to legacy evidence'
    );
    assert.equal(
        outageStorage.writes.length,
        0,
        'a failed source audit wrote migration output'
    );

    const racingStorage = memoryStorage({
        'raw/saved-hooks/index.json':
            runtimeIndex.canonicalIndexBytes(exactIndex),
        'raw/saved-hooks/legacy-1.json':
            prettySourceBytes,
        [exact.record.montage_ref.key]: exact.mediaBytes,
    });
    const racingGet = racingStorage.get.bind(racingStorage);
    let indexReads = 0;
    racingStorage.get = async key => {
        if (key === 'raw/saved-hooks/index.json') {
            indexReads += 1;
            if (indexReads > 1) {
                return Buffer.from('{"changed":true}');
            }
        }
        return racingGet(key);
    };
    await assert.rejects(
        migrateSavedHookRuntimeIndex({
            storage: racingStorage,
            write: true,
        }),
        /changed during offline migration/,
        'a concurrent index update was not detected'
    );
    assert.equal(
        racingStorage.writes.some(
            write => write.key === 'raw/saved-hooks/legacy-1.json'
        ),
        false,
        'a failed index compare-and-swap partially rewrote source evidence'
    );

    exactStorage.objects.delete(exact.record.montage_ref.key);
    const missingMedia = await migrateSavedHookRuntimeIndex({
        storage: exactStorage,
        write: false,
    });
    assert.equal(
        missingMedia.canonical.legacy_unbound_rows,
        1
    );
    const missingMediaIndex = runtimeIndex.bindIndex({
        hooks: [],
        legacy_hooks: [
            runtimeIndex.legacyRow(exactCompact),
        ],
        folders: [],
    });
    missingMediaIndex.legacy_hooks[0].score = 99;
    missingMediaIndex.index_sha256 =
        shortsScoreLedger.sha256Canonical(
            runtimeIndex.bindingPayload(missingMediaIndex)
        );
    assert.equal(
        runtimeIndex.validateIndex(missingMediaIndex).valid,
        false,
        'legacy runtime row accepted a duplicate score cache'
    );

    process.stdout.write(`${JSON.stringify({
        ok: true,
        canonicalRows: exactResult.canonical.canonical_rows,
        historicalRows: index.legacy_hooks.length,
        historicalDisplay:
            historicalDisplay.display_sha256,
        ledgerSha256:
            exact.record.score_ledger.ledger_sha256,
        scoreRecordSha256:
            exact.record.score_record_sha256,
        idempotent: true,
    })}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
