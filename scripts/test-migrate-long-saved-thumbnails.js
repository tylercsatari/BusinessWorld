#!/usr/bin/env node
'use strict';

const assert = require('assert');
const longSavedThumbnailRecord = require(
    '../buildings/jarvis/long-saved-thumbnail-record'
);
const longScoreLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const ledgerContract = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const {
    DEFAULTS,
    auditIndexPointer,
    migrateLongSavedThumbnails,
    sha256Bytes,
} = require('./migrate-long-saved-thumbnails');

class MemoryStorage {
    constructor(entries = {}) {
        this.objects = new Map(
            Object.entries(entries).map(([key, value]) => [
                key,
                Buffer.from(value),
            ])
        );
        this.puts = [];
    }

    async get(key) {
        const value = this.objects.get(key);
        return value ? Buffer.from(value) : null;
    }

    async put(key, bytes, mediaType) {
        const value = Buffer.from(bytes);
        this.objects.set(key, value);
        this.puts.push({
            key,
            bytes: Buffer.from(value),
            mediaType,
        });
    }

    async list(prefix) {
        return [...this.objects.keys()]
            .filter(key => key.startsWith(prefix))
            .sort();
    }

    snapshot() {
        return JSON.stringify(
            [...this.objects.entries()]
                .sort(([left], [right]) => (
                    left.localeCompare(right)
                ))
                .map(([key, value]) => [
                    key,
                    value.toString('base64'),
                ])
        );
    }
}

function jpeg(label) {
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from(`fixture:${label}`, 'utf8'),
        Buffer.from([0xff, 0xd9]),
    ]);
}

function textRevision(value) {
    const bytes = Buffer.from(value, 'utf8');
    return {
        present: value.length > 0,
        sha256: sha256Bytes(bytes),
        utf8_byte_length: bytes.length,
    };
}

function makeScore(image, title, percentile = 73) {
    const idea = `${title} with exact context`;
    const queryPayload = {
        schema_version: 2,
        thumbnail: {
            present: true,
            sha256: sha256Bytes(image),
            byte_length: image.length,
        },
        title: textRevision(title),
        idea: textRevision(idea),
        score_text: textRevision(title),
        selected_text_source: 'title',
    };
    const query = {
        ...queryPayload,
        text: queryPayload.score_text,
        generation: 'longquant-query-input-v2',
        fingerprint_sha256:
            ledgerContract.sha256Canonical(queryPayload),
        text_source: 'title',
    };
    const artifactSha256 = 'a'.repeat(64);
    const manifestSha256 = 'b'.repeat(64);
    const lineageSha256 = 'c'.repeat(64);
    const entries = longScoreLedger.OUTPUT_COORDINATES.map(
        (coordinate, index) => {
            const [, , group, metric] = coordinate.split('.');
            const provenance = {
                coordinate,
                query_input: query,
            };
            if (
                coordinate
                    === 'long.output.visual.ctrviews'
            ) {
                provenance.artifact_revision = {
                    key:
                        'longform/thumb-rl/scorer_visual.npz',
                    sha256: artifactSha256,
                    immutable_key:
                        `longform/thumb-rl/by-sha256/${artifactSha256}.npz`,
                    manifest_key:
                        'longform/thumb-rl/scorer_visual.manifest.json',
                    manifest_sha256: manifestSha256,
                    immutable_manifest_key:
                        `longform/thumb-rl/by-sha256/${artifactSha256}.manifest.json`,
                    lineage_manifest_sha256:
                        lineageSha256,
                    lineage_schema_version: 1,
                };
                provenance.dataset_lineage = {
                    lineage_manifest_sha256:
                        lineageSha256,
                    release_manifest_sha256:
                        manifestSha256,
                    lineage_manifest: {
                        schemaVersion: 1,
                    },
                };
            }
            return {
                coordinate_id: coordinate,
                group,
                metric,
                available: true,
                value: 1000 + index,
                percentile:
                    coordinate
                        === 'long.output.visual.ctrviews'
                        ? percentile
                        : 50 + index,
                kind: 'migration-test',
                projection: metric,
                unavailable_reason: null,
                provenance,
            };
        }
    );
    const ledger = {
        schema: 'long-stored-score-ledger-v1',
        schema_version: 1,
        percentile_unit:
            longScoreLedger.PERCENTILE_STORAGE_UNIT,
        ledger_version:
            ledgerContract.GOVERNANCE.ledgerVersion,
        governance_schema_version:
            ledgerContract.GOVERNANCE.schemaVersion,
        governance_sha256:
            ledgerContract.GOVERNANCE_SHA256,
        coordinate_ids: [
            ...longScoreLedger.OUTPUT_COORDINATES,
        ],
        entries,
        values_by_id: Object.fromEntries(
            entries.map(entry => [
                entry.coordinate_id,
                entry.value,
            ])
        ),
        percentiles_by_id: Object.fromEntries(
            entries.map(entry => [
                entry.coordinate_id,
                entry.percentile,
            ])
        ),
        available_count:
            longScoreLedger.OUTPUT_COORDINATES.length,
        expected_count:
            longScoreLedger.OUTPUT_COORDINATES.length,
        schema_complete: true,
        all_values_available: true,
        producer_errors: [],
        contract_valid: true,
    };
    ledger.ledger_sha256 =
        ledgerContract.sha256Canonical(ledger);
    const canonicalValue = percentile / 100;
    const score = {
        title,
        long_score_ledger: ledger,
        input_manifest: {
            domain: 'longquant',
            query_input: query,
            query_input_fingerprint:
                query.fingerprint_sha256,
            thumbnail_sha256:
                query.thumbnail.sha256,
            score_text_sha256:
                query.score_text.sha256,
        },
        pctile: canonicalValue,
        visual_pctile: canonicalValue,
        thumbnail_potential: canonicalValue,
        text_pctile: null,
        relevance: 0.8,
        nn_cos: 0.9,
        idea_model_reward: canonicalValue,
        thumbnail_model_reward: canonicalValue,
        training_reward: canonicalValue,
        reward: canonicalValue,
        reward_trace: {
            schema:
                longScoreLedger.REWARD_TRACE_SCHEMA,
            visual_pctile: canonicalValue,
            relevance: 0.8,
            relevance_floor: 0.35,
            relevance_penalty: 0,
            density: 0.9,
            density_floor: 0.75,
            density_penalty: 0,
            idea_model_reward: canonicalValue,
            thumbnail_model_reward: canonicalValue,
            threshold_score: canonicalValue,
            threshold_channel: 'visual',
            together_used_for_threshold: false,
        },
    };
    score.output_contract =
        longScoreLedger.longOutputContract(ledger);
    score.score_alias_contract = {
        schema: longScoreLedger.SCORE_ALIAS_SCHEMA,
        canonical_coordinate_id:
            'long.output.visual.ctrviews',
        canonical_field: 'percentile',
        canonical_value: canonicalValue,
        decision_use:
            'thumbnail_threshold_and_rewards',
        decision_eligible: true,
        compatibility_aliases: Object.fromEntries(
            [
                'pctile',
                'visual_pctile',
                'thumbnail_potential',
            ].map(name => [
                name,
                {
                    coordinate_id:
                        'long.output.visual.ctrviews',
                    field: 'percentile',
                },
            ])
        ),
    };
    assert.strictEqual(
        longScoreLedger.validateLongScoreLedger(
            score.long_score_ledger
        ).valid,
        true
    );
    assert.strictEqual(
        longScoreLedger.validateLongOutputContract(
            score
        ).valid,
        true
    );
    assert.strictEqual(
        longScoreLedger.validateLongScoreAliasContract(
            score
        ).valid,
        true
    );
    assert.strictEqual(
        longScoreLedger.validateLongScoreRewardContract(
            score
        ).valid,
        true
    );
    return score;
}

function legacyRecord(id, title, image, percentile = 73) {
    return {
        id,
        savedAt: 1700000000000,
        title,
        prompt: `Thumbnail prompt for ${title}`,
        source: 'migration-test',
        score: makeScore(image, title, percentile),
        sourceVideo: {
            id: `video-${id}`,
            title,
        },
        pctile: percentile / 100,
        reward: percentile / 100,
    };
}

function legacyStorage(record, image, options = {}) {
    const id = record.id;
    const json = options.jsonBytes || Buffer.from(
        JSON.stringify(record, null, 2),
        'utf8'
    );
    const index = options.index || {
        thumbs: [{
            id,
            title: record.title,
            savedAt: record.savedAt,
            pctile: record.pctile,
            reward: record.reward,
        }],
    };
    return {
        storage: new MemoryStorage({
            [`${DEFAULTS.sourcePrefix}/${id}.json`]:
                json,
            [`${DEFAULTS.sourcePrefix}/${id}.jpg`]:
                image,
            [DEFAULTS.indexKey]:
                Buffer.from(JSON.stringify(index), 'utf8'),
            ...(options.extra || {}),
        }),
        json,
        indexBytes:
            Buffer.from(JSON.stringify(index), 'utf8'),
    };
}

async function dryRunIsReadOnly() {
    const image = jpeg('dry-run');
    const record = legacyRecord(
        'ltdryrun',
        'Dry-run exact title',
        image
    );
    const { storage } = legacyStorage(record, image);
    const before = storage.snapshot();
    const report = await migrateLongSavedThumbnails({
        storage,
    });
    assert.strictEqual(report.mode, 'dry-run');
    assert.strictEqual(report.canonical_count, 1);
    assert.strictEqual(report.quarantined_count, 0);
    assert.strictEqual(report.invalid_count, 0);
    assert.strictEqual(storage.snapshot(), before);
    assert.strictEqual(storage.puts.length, 0);
}

async function exactOnePercentAndWriteOrdering() {
    const image = jpeg('one-percent');
    const record = legacyRecord(
        'ltonepercentmigration',
        'Exact 1.0th percentile title',
        image,
        1
    );
    const { storage, json, indexBytes } =
        legacyStorage(record, image);
    const report = await migrateLongSavedThumbnails({
        storage,
        write: true,
    });
    assert.strictEqual(report.canonical_count, 1);
    assert.strictEqual(report.quarantined_count, 0);
    assert.strictEqual(report.invalid_count, 0);
    const sourceKey =
        `${DEFAULTS.sourcePrefix}/${record.id}.json`;
    const migrated = JSON.parse(
        (await storage.get(sourceKey)).toString('utf8')
    );
    const validation =
        longSavedThumbnailRecord.validateRecord(migrated);
    assert.strictEqual(
        validation.valid,
        true,
        validation.errors.join('; ')
    );
    assert.strictEqual(
        longSavedThumbnailRecord.scorePercentile(
            migrated.score
        ),
        1,
        'exact 1.0th percentile was not preserved'
    );
    const displayed =
        longSavedThumbnailRecord.displayRecord(migrated);
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            displayed,
            'pctile'
        ),
        false,
        'display record recreated a duplicate percentile authority'
    );
    assert.strictEqual(
        longSavedThumbnailRecord.scorePercentile(
            displayed.score
        ),
        1,
        'display record changed the canonical ledger percentile'
    );
    assert.deepStrictEqual(
        await storage.get(
            migrated.migration.source_json.key
        ),
        json,
        'original JSON bytes were not preserved'
    );
    assert.deepStrictEqual(
        await storage.get(
            migrated.migration.source_jpeg.key
        ),
        image,
        'original JPEG bytes were not preserved'
    );
    const archivedIndex = storage.puts.find(put => (
        put.key.includes('/archive/index/by-sha256/')
    ));
    assert(archivedIndex, 'original index was not archived');
    assert.deepStrictEqual(
        archivedIndex.bytes,
        indexBytes,
        'original index bytes changed in the archive'
    );
    const index = JSON.parse(
        (await storage.get(DEFAULTS.indexKey))
            .toString('utf8')
    );
    assert.strictEqual(
        index.schema,
        longSavedThumbnailRecord.INDEX_SCHEMA
    );
    assert.strictEqual(index.rows.length, 1);
    assert.strictEqual(index.legacy_unbound.length, 0);
    assert.strictEqual(
        index.migration_release.index_payload_sha256,
        longSavedThumbnailRecord.indexPayloadSha256(index),
        'migration release does not describe the live index payload'
    );
    assert.strictEqual(
        longSavedThumbnailRecord
            .validateIndexRecordPair(
                index.rows[0],
                migrated
            ).valid,
        true
    );
    const runtimeMutation =
        longSavedThumbnailRecord.bindIndex({
            ...index,
            rows: [],
        });
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            runtimeMutation,
            'migration_release'
        ),
        false,
        'runtime mutation retained stale migration provenance'
    );
    assert.strictEqual(
        storage.puts[storage.puts.length - 1].key,
        DEFAULTS.indexKey,
        'the live index pointer was not written last'
    );
    const pointerIndex = storage.puts.findIndex(
        put => put.key === DEFAULTS.indexKey
    );
    const mediaIndex = storage.puts.findIndex(
        put => put.key === migrated.media.key
    );
    const immutableRecordIndex = storage.puts.findIndex(
        put => (
            put.key.includes('/records/by-sha256/')
            && put.key.endsWith(
                `${
                    longSavedThumbnailRecord
                        .recordArtifactIdentity(migrated).sha256
                }.json`
            )
        )
    );
    const sourceRecordIndex = storage.puts.findIndex(
        put => put.key === sourceKey
    );
    assert(
        mediaIndex >= 0
        && immutableRecordIndex > mediaIndex
        && sourceRecordIndex > immutableRecordIndex
        && pointerIndex > sourceRecordIndex,
        'canonical media/record ordering differs'
    );
    const canonicalRecordBytes =
        longSavedThumbnailRecord
            .recordArtifactIdentity(migrated).bytes;
    assert(
        (await storage.get(sourceKey)).equals(canonicalRecordBytes),
        'the mutable canonical record is not exact canonical JSON'
    );
    assert.strictEqual(
        index.rows[0].record_artifact_sha256,
        sha256Bytes(canonicalRecordBytes),
        'the index does not bind the exact canonical record bytes'
    );
    assert.strictEqual(
        index.rows[0].record_byte_length,
        canonicalRecordBytes.length,
        'the index records a different canonical byte length'
    );
    return { storage, report, migrated };
}

async function jpegSwapIsQuarantined() {
    const scoredImage = jpeg('score-bound');
    const storedImage = jpeg('swapped-source');
    const record = legacyRecord(
        'ltjpegswap',
        'JPEG swap title',
        scoredImage
    );
    const { storage, json } =
        legacyStorage(record, storedImage);
    const report = await migrateLongSavedThumbnails({
        storage,
        write: true,
    });
    assert.strictEqual(report.canonical_count, 0);
    assert.strictEqual(report.quarantined_count, 1);
    assert.strictEqual(report.invalid_count, 0);
    assert(
        report.records[0].errors.some(error => (
            error.includes('different thumbnail')
        )),
        report.records[0].errors.join('; ')
    );
    assert.deepStrictEqual(
        await storage.get(
            `${DEFAULTS.sourcePrefix}/${record.id}.json`
        ),
        json,
        'quarantine rewrote legacy JSON'
    );
    const index = JSON.parse(
        (await storage.get(DEFAULTS.indexKey))
            .toString('utf8')
    );
    assert.strictEqual(index.rows.length, 0);
    assert.strictEqual(index.legacy_unbound.length, 1);
}

async function titleSwapIsQuarantined() {
    const image = jpeg('title-swap');
    const scoreTitle = 'Score-bound title';
    const record = legacyRecord(
        'lttitleswap',
        scoreTitle,
        image
    );
    record.title = 'A different persisted title';
    const { storage } = legacyStorage(record, image);
    const report = await migrateLongSavedThumbnails({
        storage,
        write: true,
    });
    assert.strictEqual(report.canonical_count, 0);
    assert.strictEqual(report.quarantined_count, 1);
    assert.strictEqual(report.invalid_count, 0);
    assert(
        report.records[0].errors.some(error => (
            error.includes('different title')
            || error.includes('different score_text')
        )),
        report.records[0].errors.join('; ')
    );
}

async function aliasesNeverBecomeScores() {
    const image = jpeg('aliases-only');
    const record = {
        id: 'ltaliasonly',
        savedAt: 1700000000001,
        title: 'Alias-only historical row',
        prompt: 'No canonical score exists',
        pctile: 0.99,
        reward: 0.99,
        visual_pctile: 0.99,
        thumbnail_potential: 0.99,
    };
    const { storage } = legacyStorage(record, image);
    const report = await migrateLongSavedThumbnails({
        storage,
        write: true,
    });
    assert.strictEqual(report.canonical_count, 0);
    assert.strictEqual(report.quarantined_count, 1);
    assert.strictEqual(report.invalid_count, 0);
    assert(
        report.records[0].errors.includes(
            'legacy saved thumbnail has no nested canonical score'
        )
    );
    const persisted = JSON.parse(
        (
            await storage.get(
                `${DEFAULTS.sourcePrefix}/${record.id}.json`
            )
        ).toString('utf8')
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            persisted,
            'score'
        ),
        false,
        'aliases were inferred into a canonical score'
    );
}

async function nestedAuthorityIsQuarantined() {
    for (const fixture of [
        {
            id: 'ltnestedmeta',
            path: 'meta.audit.pctile',
            mutate(record) {
                record.meta = {
                    audit: {
                        pctile: 0.73,
                    },
                };
            },
        },
        {
            id: 'ltnestedbaseline',
            path: 'baseline.candidate.score',
            mutate(record) {
                record.baseline = {
                    candidate: {
                        score: record.score,
                    },
                };
            },
        },
    ]) {
        const image = jpeg(fixture.id);
        const record = legacyRecord(
            fixture.id,
            `Nested authority ${fixture.id}`,
            image
        );
        fixture.mutate(record);
        const { storage } = legacyStorage(record, image);
        const report = await migrateLongSavedThumbnails({
            storage,
            write: true,
        });
        assert.strictEqual(report.canonical_count, 0);
        assert.strictEqual(report.quarantined_count, 1);
        assert.strictEqual(report.invalid_count, 0);
        assert(
            report.records[0].errors.some(error => (
                error.includes(fixture.path)
            )),
            report.records[0].errors.join('; ')
        );
    }
}

async function immutableCollisionFailsClosed() {
    const image = jpeg('collision');
    const record = legacyRecord(
        'ltcollision',
        'Collision title',
        image
    );
    const mediaKey =
        `longform/saved-thumbs/media/by-sha256/${sha256Bytes(image)}.jpg`;
    const originalIndex = {
        thumbs: [{
            id: record.id,
            title: record.title,
        }],
    };
    const originalIndexBytes =
        Buffer.from(JSON.stringify(originalIndex));
    const { storage } = legacyStorage(
        record,
        image,
        {
            index: originalIndex,
            extra: {
                [mediaKey]: jpeg('wrong-collision-bytes'),
            },
        }
    );
    const report = await migrateLongSavedThumbnails({
        storage,
        write: true,
    });
    assert.strictEqual(report.canonical_count, 0);
    assert.strictEqual(report.quarantined_count, 0);
    assert.strictEqual(report.invalid_count, 1);
    assert(
        report.records[0].errors.some(error => (
            error.includes('immutable key collision')
        )),
        report.records[0].errors.join('; ')
    );
    assert.strictEqual(
        report.index.pointer.disposition,
        'skipped-due-to-invalid-evidence'
    );
    assert.deepStrictEqual(
        await storage.get(DEFAULTS.indexKey),
        originalIndexBytes,
        'a collision was allowed to move the live index'
    );
}

async function repeatRunIsIdempotent(storage) {
    const before = storage.snapshot();
    const writesBefore = storage.puts.length;
    const report = await migrateLongSavedThumbnails({
        storage,
        write: true,
    });
    assert.strictEqual(report.canonical_count, 1);
    assert.strictEqual(report.quarantined_count, 0);
    assert.strictEqual(report.invalid_count, 0);
    assert.strictEqual(
        storage.snapshot(),
        before,
        'repeat migration changed stored state'
    );
    assert.strictEqual(
        storage.puts.length,
        writesBefore,
        'repeat migration issued redundant writes'
    );
    assert.strictEqual(
        report.index.pointer.disposition,
        'verified-existing'
    );
}

async function noncanonicalCanonicalSourceIsNormalized(
    storage,
    migrated
) {
    const sourceKey =
        `${DEFAULTS.sourcePrefix}/${migrated.id}.json`;
    storage.objects.set(
        sourceKey,
        Buffer.from(JSON.stringify(migrated, null, 2), 'utf8')
    );
    const writesBefore = storage.puts.length;
    const report = await migrateLongSavedThumbnails({
        storage,
        write: true,
    });
    assert.strictEqual(report.invalid_count, 0);
    assert.strictEqual(
        report.records[0].dispositions.source_record,
        'replaced-and-verified'
    );
    assert(
        (await storage.get(sourceKey)).equals(
            longSavedThumbnailRecord
                .recordArtifactIdentity(migrated).bytes
        ),
        'noncanonical source JSON was not normalized'
    );
    assert.strictEqual(
        storage.puts.length,
        writesBefore + 1,
        'normalization rewrote immutable artifacts or the unchanged index'
    );
}

async function releaseArtifactSwapFailsClosed() {
    const image = jpeg('release-swap');
    const record = legacyRecord(
        'ltreleaseswap',
        'Release swap title',
        image
    );
    const { storage } = legacyStorage(record, image);
    await migrateLongSavedThumbnails({
        storage,
        write: true,
    });
    const pointer = JSON.parse(
        (await storage.get(DEFAULTS.indexKey))
            .toString('utf8')
    );
    storage.objects.set(
        pointer.migration_release.key,
        Buffer.from('{"schema":"forged"}', 'utf8')
    );
    await assert.rejects(
        () => auditIndexPointer(storage, pointer),
        /release artifact identity differs/,
        'a swapped migration release artifact was accepted'
    );
}

async function main() {
    await dryRunIsReadOnly();
    const written = await exactOnePercentAndWriteOrdering();
    await noncanonicalCanonicalSourceIsNormalized(
        written.storage,
        written.migrated
    );
    await repeatRunIsIdempotent(written.storage);
    await jpegSwapIsQuarantined();
    await titleSwapIsQuarantined();
    await aliasesNeverBecomeScores();
    await nestedAuthorityIsQuarantined();
    await immutableCollisionFailsClosed();
    await releaseArtifactSwapFailsClosed();
    process.stdout.write(`${JSON.stringify({
        ok: true,
        cases: [
            'dry-run is read-only',
            'exact 1.0th and write ordering',
            'canonical source byte normalization',
            'idempotence',
            'JPEG swap quarantine',
            'title swap quarantine',
            'alias-only quarantine',
            'nested meta/baseline authority quarantine',
            'immutable collision fail-closed',
            'migration release artifact swap fail-closed',
        ],
    })}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(
            `${error.stack || error.message}\n`
        );
        process.exitCode = 1;
    });
}

module.exports = {
    MemoryStorage,
    jpeg,
    legacyRecord,
    legacyStorage,
    makeScore,
};
