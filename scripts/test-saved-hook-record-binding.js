#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    FEATURE_DEFINITIONS,
    materializeHistoricalScoreLedger,
    sha256Canonical,
} = require('../buildings/jarvis/shorts-score-ledger');
const {
    classifyHistoricalSavedHook,
    compactIndexRow,
    contentAddressedKey,
    normalizeText,
    revisionBindingPayload,
    sha256Bytes,
} = require('../buildings/jarvis/saved-hook-record-binding');
const {
    auditBoundRevision,
    canonicalBytes,
    loadExistingRevisions,
    migrateSavedHooks,
    parseArguments,
} = require('./migrate-saved-hooks-to-bound-records');

class MemoryStorage {
    constructor(seed) {
        this.objects = new Map(
            Object.entries(seed || {}).map(([key, value]) => [
                key,
                Buffer.from(value),
            ])
        );
        this.putCount = 0;
    }

    async get(key) {
        const value = this.objects.get(key);
        return value == null ? null : Buffer.from(value);
    }

    async put(key, value) {
        this.putCount += 1;
        this.objects.set(key, Buffer.from(value));
    }

    async list(prefix) {
        return [...this.objects.keys()]
            .filter(key => key.startsWith(prefix))
            .sort();
    }
}

function fixtureLedger() {
    const features = Object.fromEntries(
        FEATURE_DEFINITIONS.map((definition, index) => [
            definition.key,
            {
                value: 50 + index,
                percentile: 60 + index / 10,
            },
        ])
    );
    return materializeHistoricalScoreLedger({ features });
}

function jpeg(label) {
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from(`fixture-${label}`, 'utf8'),
        Buffer.from([0xff, 0xd9]),
    ]);
}

function inputManifest(canonicalJpeg, text, ledger) {
    const normalized = normalizeText(text);
    const transcriptUsed = normalized.length > 0;
    const embeddingInput = {
        schema: 'shorts-embedding-input-v2',
        montage_sha256: sha256Bytes(canonicalJpeg),
        transcript: normalized,
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
    const embeddingInputFingerprint =
        sha256Canonical(embeddingInput);
    const scoreInput = {
        schema: 'shorts-score-input-v2',
        embedding_input_fingerprint:
            embeddingInputFingerprint,
        embedding_input: embeddingInput,
        duration_ms: 5000,
        creator_profile: null,
    };
    const inputHash = sha256Canonical(scoreInput);
    return {
        domain: 'shorts_raw',
        scorer: 'fixture-rescorer',
        embedding_model: 'fixture-multimodal-embedding',
        embedding_dimensions: 1536,
        display_contract_version: 1,
        feature_contract_identity_schema_version:
            ledger.feature_contract_identity_schema_version,
        feature_contract_sha256: ledger.feature_contract_sha256,
        feature_contract_document_sha256:
            ledger.feature_contract_document_sha256,
        coordinate_governance_version:
            ledger.coordinate_governance_version,
        coordinate_governance_sha256:
            ledger.coordinate_governance_sha256,
        source_window: 'first 5 seconds',
        source_mode: 'migration_test',
        canonical_montage: {
            width: 1280,
            height: 144,
            format: 'JPEG',
            quality: 88,
            subsampling: '4:2:0',
            montage_sha256: sha256Bytes(canonicalJpeg),
        },
        transcript_used: transcriptUsed,
        duration_s: 5,
        input_fingerprint: inputHash,
        score_input_fingerprint: inputHash,
        embedding_input_fingerprint:
            embeddingInputFingerprint,
        revision_fingerprint: sha256Bytes(
            Buffer.from('fixture-revision', 'utf8')
        ),
        output_fingerprint: sha256Bytes(
            Buffer.from('fixture-output', 'utf8')
        ),
        scorer_revisions: {
            scorer: {
                state: 'present',
                sha256: sha256Bytes(Buffer.from('scorer')),
            },
            feature_contract: {
                state: 'present',
                sha256: ledger.feature_contract_document_sha256,
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
                present: normalized.length > 0,
                input: 'normalized transcript',
                image: '',
                text: normalized,
            },
            together: {
                present: true,
                input: 'canonical montage plus normalized transcript',
                image: 'canonical montage',
                text: normalized,
            },
        },
    };
}

function sourceFixture(id, text) {
    const record = {
        id,
        title: `Historical ${id}`,
        text,
        steer: {
            visual_keep: { est: 85, pctile: 92 },
        },
        features: {
            visual_keep: { value: 85, percentile: 92 },
        },
    };
    const sourceJpeg = jpeg(`source-${id}`);
    return {
        record,
        sourceJpeg,
        seed: {
            [`raw/saved-hooks/${id}.json`]:
                Buffer.from(JSON.stringify(record), 'utf8'),
            [`raw/saved-hooks/${id}.jpg`]: sourceJpeg,
        },
    };
}

function validRescoreResult(request, overrides) {
    const canonicalJpeg = (
        overrides && overrides.canonicalJpeg
    ) || jpeg(`canonical-${request.record_id}`);
    const text = overrides && Object.prototype.hasOwnProperty.call(
        overrides,
        'text'
    )
        ? overrides.text
        : request.historical_record.text;
    const ledger = (
        overrides && overrides.ledger
    ) || fixtureLedger();
    const manifest = (
        overrides && overrides.manifest
    ) || inputManifest(canonicalJpeg, text, ledger);
    return {
        rescore_attestation: {
            schema: 'saved-hook-fresh-rescore-attestation-v1',
            mode: 'fresh_rescore',
            source_json_sha256: request.source_json_sha256,
            source_jpeg_sha256: request.source_jpeg_sha256,
        },
        canonical_jpeg_base64: canonicalJpeg.toString('base64'),
        normalized_text: normalizeText(text),
        transcript: normalizeText(text),
        input_manifest: manifest,
        score_ledger: ledger,
    };
}

async function runSingle(id, rescore, write = true) {
    const fixture = sourceFixture(
        id,
        '  This   hook has normalized text.  '
    );
    const storage = new MemoryStorage(fixture.seed);
    const report = await migrateSavedHooks({
        storage,
        write,
        rescore,
        sourcePrefix: 'raw/saved-hooks',
        archivePrefix: 'test/archive',
        canonicalPrefix: 'test/canonical',
        revisionPrefix: 'test/revisions',
        quarantinePrefix: 'test/quarantine',
        indexPrefix: 'test/index',
    });
    return { fixture, storage, report };
}

async function main() {
    assert.strictEqual(
        parseArguments([]).write,
        false,
        'CLI must default to audit/dry-run'
    );
    const legacy = sourceFixture('classification', 'A legacy hook').record;
    assert.deepStrictEqual(
        classifyHistoricalSavedHook(legacy),
        {
            classification: 'legacy_unbound_evidence',
            canonical: false,
            requires_rescore: true,
            legacy_caches: ['steer', 'features'],
            reason:
                'historical score caches lack exact media/input provenance',
        }
    );

    let rescoreCalls = 0;
    const happy = await runSingle('happy', async request => {
        rescoreCalls += 1;
        return validRescoreResult(request);
    });
    assert.strictEqual(happy.report.source_count, 1);
    assert.strictEqual(
        happy.report.verified_count,
        1,
        JSON.stringify(happy.report.records, null, 2)
    );
    assert.strictEqual(happy.report.quarantined_count, 0);
    assert.strictEqual(happy.report.compact_index.row_count, 1);
    assert.strictEqual(rescoreCalls, 1);
    const firstRevision = happy.report.records[0];
    await auditBoundRevision(
        happy.storage,
        firstRevision.revision,
        firstRevision.revisionReference
    );
    const objectCountAfterFirstRun = happy.storage.objects.size;
    const putCountAfterFirstRun = happy.storage.putCount;

    const secondReport = await migrateSavedHooks({
        storage: happy.storage,
        write: true,
        rescore: async request => {
            rescoreCalls += 1;
            return validRescoreResult(request);
        },
        sourcePrefix: 'raw/saved-hooks',
        archivePrefix: 'test/archive',
        canonicalPrefix: 'test/canonical',
        revisionPrefix: 'test/revisions',
        quarantinePrefix: 'test/quarantine',
        indexPrefix: 'test/index',
    });
    assert.strictEqual(secondReport.verified_count, 1);
    assert.strictEqual(secondReport.records[0].resumed, true);
    assert.strictEqual(
        secondReport.records[0].revision.revision_sha256,
        firstRevision.revision.revision_sha256
    );
    assert.strictEqual(
        secondReport.compact_index.sha256,
        happy.report.compact_index.sha256
    );
    assert.strictEqual(rescoreCalls, 1);
    assert.strictEqual(
        happy.storage.objects.size,
        objectCountAfterFirstRun,
        'idempotent rerun must not create new objects'
    );
    assert.strictEqual(
        happy.storage.putCount,
        putCountAfterFirstRun,
        'idempotent rerun must not rewrite immutable objects'
    );
    assert.throws(
        () => compactIndexRow(
            firstRevision.revision,
            {
                ...firstRevision.revisionReference,
                sha256: 'f'.repeat(64),
                key:
                    'test/revisions/records/'
                    + `${'f'.repeat(64)}.json`,
            }
        ),
        /does not identify its exact canonical bytes/,
        'compact index accepted a revision reference to different bytes'
    );

    const noncanonicalOnlyStorage = new MemoryStorage();
    const prettyRevisionBytes = Buffer.from(
        JSON.stringify(firstRevision.revision, null, 2),
        'utf8'
    );
    const prettyRevisionKey = contentAddressedKey(
        'test/revisions',
        'records',
        sha256Bytes(prettyRevisionBytes),
        '.json'
    );
    noncanonicalOnlyStorage.objects.set(
        prettyRevisionKey,
        prettyRevisionBytes
    );
    assert.strictEqual(
        (
            await loadExistingRevisions(
                noncanonicalOnlyStorage,
                'test/revisions'
            )
        ).size,
        0,
        'noncanonical revision bytes were accepted for resume'
    );

    const conflictingRevision = JSON.parse(
        JSON.stringify(firstRevision.revision)
    );
    conflictingRevision.migration.mode = 'conflict-fixture';
    conflictingRevision.revision_sha256 = sha256Canonical(
        revisionBindingPayload(conflictingRevision)
    );
    const conflictingRevisionBytes =
        canonicalBytes(conflictingRevision);
    const conflictingRevisionKey = contentAddressedKey(
        'test/revisions',
        'records',
        sha256Bytes(conflictingRevisionBytes),
        '.json'
    );
    happy.storage.objects.set(
        conflictingRevisionKey,
        conflictingRevisionBytes
    );
    await assert.rejects(
        () => loadExistingRevisions(
            happy.storage,
            'test/revisions'
        ),
        /ambiguous bound revisions for source/,
        'conflicting canonical revisions were resolved by key order'
    );
    happy.storage.objects.delete(conflictingRevisionKey);

    const jpegSwap = await runSingle(
        'jpeg-swap',
        async request => {
            const manifestJpeg = jpeg('manifest-image');
            const returnedJpeg = jpeg('different-returned-image');
            const result = validRescoreResult(request, {
                canonicalJpeg: returnedJpeg,
            });
            result.input_manifest = inputManifest(
                manifestJpeg,
                result.normalized_text,
                result.score_ledger
            );
            return result;
        }
    );
    assert.strictEqual(jpegSwap.report.verified_count, 0);
    assert.strictEqual(jpegSwap.report.quarantined_count, 1);
    assert.match(
        jpegSwap.report.records[0].quarantine.quarantine.reason,
        /canonical montage does not match JPEG bytes/
    );

    const textSwap = await runSingle(
        'text-swap',
        async request => {
            const result = validRescoreResult(request);
            result.normalized_text = 'Different substituted transcript';
            result.transcript = result.normalized_text;
            return result;
        }
    );
    assert.strictEqual(textSwap.report.verified_count, 0);
    assert.strictEqual(textSwap.report.quarantined_count, 1);
    assert.match(
        textSwap.report.records[0].quarantine.quarantine.reason,
        /normalized text does not match/
    );

    const tamperedLedger = await runSingle(
        'tampered-ledger',
        async request => {
            const result = validRescoreResult(request);
            result.score_ledger.entries[0].value += 1;
            return result;
        }
    );
    assert.strictEqual(tamperedLedger.report.verified_count, 0);
    assert.strictEqual(tamperedLedger.report.quarantined_count, 1);
    assert.match(
        tamperedLedger.report.records[0].quarantine.quarantine.reason,
        /score ledger is invalid|content hash does not match/
    );

    const incompleteManifest = await runSingle(
        'incomplete-manifest',
        async request => {
            const result = validRescoreResult(request);
            delete result.input_manifest.output_fingerprint;
            return result;
        }
    );
    assert.strictEqual(incompleteManifest.report.verified_count, 0);
    assert.strictEqual(incompleteManifest.report.quarantined_count, 1);
    assert.match(
        incompleteManifest.report.records[0].quarantine.quarantine.reason,
        /output_fingerprint is missing/
    );

    const noRescore = await runSingle(
        'legacy-quarantine',
        null
    );
    assert.strictEqual(noRescore.report.verified_count, 0);
    assert.strictEqual(noRescore.report.quarantined_count, 1);
    assert.strictEqual(noRescore.report.compact_index.row_count, 0);
    assert.strictEqual(
        noRescore.report.records[0].classification.classification,
        'legacy_unbound_evidence'
    );
    assert.match(
        noRescore.report.records[0].quarantine.quarantine.reason,
        /fresh rescore required/
    );
    const archivedKeys = [...noRescore.storage.objects.keys()]
        .filter(key => key.startsWith('test/archive/'));
    assert.strictEqual(
        archivedKeys.length,
        3,
        'source JSON, JPEG, and archive manifest must be frozen'
    );
    assert.strictEqual(
        [...noRescore.storage.objects.keys()]
            .some(key => key.startsWith('test/revisions/')),
        false,
        'legacy evidence must never be promoted to a bound revision'
    );
    const quarantinePutCount = noRescore.storage.putCount;
    const quarantineRerun = await migrateSavedHooks({
        storage: noRescore.storage,
        write: true,
        rescore: null,
        sourcePrefix: 'raw/saved-hooks',
        archivePrefix: 'test/archive',
        canonicalPrefix: 'test/canonical',
        revisionPrefix: 'test/revisions',
        quarantinePrefix: 'test/quarantine',
        indexPrefix: 'test/index',
    });
    assert.strictEqual(quarantineRerun.quarantined_count, 1);
    assert.strictEqual(
        noRescore.storage.putCount,
        quarantinePutCount,
        'quarantine rerun must not rewrite immutable objects'
    );

    const dryRun = await runSingle(
        'dry-run',
        async request => validRescoreResult(request),
        false
    );
    assert.strictEqual(dryRun.report.mode, 'audit-dry-run');
    assert.strictEqual(dryRun.report.planned_count, 1);
    assert.strictEqual(dryRun.storage.putCount, 0);
    assert.strictEqual(
        dryRun.storage.objects.size,
        Object.keys(dryRun.fixture.seed).length,
        'dry-run must not write any migration object'
    );

    const tamperTarget = firstRevision.revision.score_ledger.reference.key;
    happy.storage.objects.set(
        tamperTarget,
        Buffer.from('{"tampered":true}', 'utf8')
    );
    await assert.rejects(
        auditBoundRevision(
            happy.storage,
            firstRevision.revision,
            firstRevision.revisionReference
        ),
        /score ledger object hash or byte length differs/
    );

    assert.strictEqual(
        sha256Canonical(fixtureLedger()).length,
        64,
        'fixture sanity check'
    );
    process.stdout.write(JSON.stringify({
        ok: true,
        tests: [
            'score/JPEG swap',
            'text swap',
            'tampered ledger',
            'incomplete manifest',
            'idempotence',
            'exact revision artifact binding',
            'noncanonical resume rejection',
            'ambiguous revision rejection',
            'legacy quarantine',
            'quarantine idempotence',
            'dry-run',
            'redownloaded edge tamper',
        ],
    }) + '\n');
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
