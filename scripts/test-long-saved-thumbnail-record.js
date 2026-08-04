#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const longLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const savedRecord = require(
    '../buildings/jarvis/long-saved-thumbnail-record'
);
const ledgerContract = require(
    '../buildings/jarvis/shorts-score-ledger'
);

const image = Buffer.from('fixture-jpeg-bytes');
const imageSha256 = crypto
    .createHash('sha256')
    .update(image)
    .digest('hex');
const title = 'Canonical saved thumbnail';
const idea = 'Canonical saved thumbnail with exact video context';
const textRevision = value => {
    const bytes = Buffer.from(value, 'utf8');
    return {
        present: value.length > 0,
        sha256: crypto
            .createHash('sha256')
            .update(bytes)
            .digest('hex'),
        utf8_byte_length: bytes.length,
    };
};
const queryPayload = {
    schema_version: 2,
    thumbnail: {
        present: true,
        sha256: imageSha256,
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
const entries = longLedger.OUTPUT_COORDINATES.map(
    (coordinate, index) => {
        const [, , group, metric] = coordinate.split('.');
        const provenance = {
            coordinate,
            query_input: query,
        };
        if (coordinate === 'long.output.visual.ctrviews') {
            provenance.artifact_revision = {
                key: 'longform/thumb-rl/scorer_visual.npz',
                sha256: artifactSha256,
                immutable_key:
                    `longform/thumb-rl/by-sha256/${artifactSha256}.npz`,
                manifest_key:
                    'longform/thumb-rl/scorer_visual.manifest.json',
                manifest_sha256: manifestSha256,
                immutable_manifest_key:
                    `longform/thumb-rl/by-sha256/${artifactSha256}.manifest.json`,
                lineage_manifest_sha256: lineageSha256,
                lineage_schema_version: 1,
            };
            provenance.dataset_lineage = {
                lineage_manifest_sha256: lineageSha256,
                release_manifest_sha256: manifestSha256,
                lineage_manifest: { schemaVersion: 1 },
            };
        }
        return {
            coordinate_id: coordinate,
            group,
            metric,
            available: true,
            value: 10 + index,
            percentile: 60 + index,
            kind: 'fixture',
            projection: metric,
            unavailable_reason: null,
            provenance,
        };
    }
);
const ledger = {
    schema: 'long-stored-score-ledger-v1',
    schema_version: 1,
    percentile_unit: longLedger.PERCENTILE_STORAGE_UNIT,
    ledger_version: ledgerContract.GOVERNANCE.ledgerVersion,
    governance_schema_version:
        ledgerContract.GOVERNANCE.schemaVersion,
    governance_sha256: ledgerContract.GOVERNANCE_SHA256,
    coordinate_ids: [...longLedger.OUTPUT_COORDINATES],
    entries,
    values_by_id: Object.fromEntries(entries.map(entry => [
        entry.coordinate_id,
        entry.value,
    ])),
    percentiles_by_id: Object.fromEntries(entries.map(entry => [
        entry.coordinate_id,
        entry.percentile,
    ])),
    available_count: 21,
    expected_count: 21,
    schema_complete: true,
    all_values_available: true,
    producer_errors: [],
    contract_valid: true,
};
ledger.ledger_sha256 = ledgerContract.sha256Canonical(ledger);

const score = {
    title,
    long_score_ledger: ledger,
    input_manifest: {
        domain: 'longquant',
        query_input: query,
        query_input_fingerprint: query.fingerprint_sha256,
        thumbnail_sha256: imageSha256,
        score_text_sha256: query.score_text.sha256,
    },
    pctile: 0.6,
    visual_pctile: 0.6,
    thumbnail_potential: 0.6,
    text_pctile: null,
    relevance: 0.8,
    nn_cos: 0.9,
    idea_model_reward: 0.6,
    thumbnail_model_reward: 0.6,
    training_reward: 0.6,
    reward: 0.6,
    reward_trace: {
        schema: longLedger.REWARD_TRACE_SCHEMA,
        visual_pctile: 0.6,
        relevance: 0.8,
        relevance_floor: 0.35,
        relevance_penalty: 0,
        density: 0.9,
        density_floor: 0.759826,
        density_penalty: 0,
        idea_model_reward: 0.6,
        thumbnail_model_reward: 0.6,
        threshold_score: 0.6,
        threshold_channel: 'visual',
        together_used_for_threshold: false,
    },
    channels: {
        visual: {
            metrics: {
                ctrviews: {
                    est: 99,
                    pctile: 99,
                },
            },
            neighbors: [
                {
                    id: 'neighbor-a',
                    sim: 0.91,
                    title: 'Must not persist',
                    views: 123456789,
                },
            ],
            map_placements: {
                ctrviews: {
                    est: null,
                    pctile: 98,
                    kind: 'neighbor_axis_percentile',
                    axis_x: 1.25,
                    projection: 'ctrviews',
                    provenance: {
                        coordinate:
                            'long.map-placement.visual.ctrviews',
                        large_redundant_payload: {
                            views: 123456789,
                        },
                    },
                },
            },
        },
    },
    emb_preview: {
        visual: [0.1, -0.2, 0.3],
        text: null,
        together: null,
    },
};
score.output_contract = longLedger.longOutputContract(ledger);
score.score_alias_contract = {
    schema: longLedger.SCORE_ALIAS_SCHEMA,
    canonical_coordinate_id: 'long.output.visual.ctrviews',
    canonical_field: 'percentile',
    canonical_value: 0.6,
    decision_use: 'thumbnail_threshold_and_rewards',
    decision_eligible: true,
    compatibility_aliases: Object.fromEntries(
        ['pctile', 'visual_pctile', 'thumbnail_potential'].map(
            name => [
                name,
                {
                    coordinate_id:
                        'long.output.visual.ctrviews',
                    field: 'percentile',
                },
            ]
        )
    ),
};

const record = savedRecord.bindRecord({
    id: 'ltfixture',
    savedAt: 1,
    title,
    prompt: 'A prompt',
    score,
    media: {
        kind: 'thumbnail-jpeg',
        key:
            `longform/saved-thumbs/media/by-sha256/${imageSha256}.jpg`,
        thumbnail_sha256: imageSha256,
        byte_length: image.length,
    },
});
assert.strictEqual(
    record.schema,
    savedRecord.RECORD_SCHEMA
);
assert.strictEqual(
    record.score.schema,
    savedRecord.SCORE_SCHEMA
);
assert.strictEqual(
    record.score.scalar_score_authority,
    'long_score_ledger'
);
assert.deepStrictEqual(
    Object.keys(record.score).sort(),
    [
        'decision_trace',
        'input_manifest',
        'long_score_ledger',
        'non_authoritative_geometry',
        'output_contract',
        'scalar_score_authority',
        'schema',
    ],
    'the persisted score envelope contains redundant fields'
);
for (const field of [
    'pctile',
    'visual_pctile',
    'text_pctile',
    'thumbnail_potential',
    'metrics',
    'channels',
    'emb_preview',
    'reward',
    'training_reward',
    'idea_model_reward',
    'thumbnail_model_reward',
    'reward_trace',
    'score_alias_contract',
    'relevance',
    'nn_cos',
]) {
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            record.score,
            field
        ),
        false,
        `${field} survived the persistence boundary`
    );
}
assert.deepStrictEqual(
    record.score.decision_trace,
    {
        schema: savedRecord.DECISION_TRACE_SCHEMA,
        authority:
            savedRecord.DECISION_TRACE_AUTHORITY,
        threshold_coordinate_id:
            'long.output.visual.ctrviews',
        packaging_used_for_threshold: false,
        observations: {
            topical_relevance_cosine: 0.8,
            visual_manifold_density_cosine: 0.9,
        },
        policy_thresholds: {
            topical_relevance_floor: 0.35,
            visual_manifold_density_floor: 0.759826,
        },
    },
    'non-redundant decision inputs were not preserved'
);
const geometry =
    record.score.non_authoritative_geometry;
assert.strictEqual(
    geometry.authority,
    savedRecord.GEOMETRY_AUTHORITY
);
assert.strictEqual(
    geometry.scalar_score_use,
    'forbidden'
);
assert.deepStrictEqual(
    geometry.channels.visual.neighbors,
    [{ id: 'neighbor-a', sim: 0.91 }],
    'neighbor outcomes or labels leaked into visualization geometry'
);
assert.deepStrictEqual(
    geometry.channels.visual.map_placements.ctrviews,
    {
        axis_x: 1.25,
        projection: 'ctrviews',
        provenance: {
            coordinate:
                'long.map-placement.visual.ctrviews',
        },
    },
    'map geometry retained recomputed scalar evidence'
);
assert.deepStrictEqual(
    geometry.channels.visual.embedding_preview,
    [0.1, -0.2, 0.3]
);
assert.strictEqual(
    record.media.schema,
    savedRecord.MEDIA_SCHEMA
);
assert.strictEqual(
    savedRecord.validateRecord(record).valid,
    true,
    savedRecord.validateRecord(record).errors.join('; ')
);
const display = savedRecord.displayRecord(record);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(display, 'media'),
    false,
    'the display envelope exposed the internal media object'
);
assert.deepStrictEqual(
    display.media_ref,
    {
        schema: savedRecord.MEDIA_REF_SCHEMA,
        url:
            `${savedRecord.MEDIA_ROUTE_PREFIX}/${imageSha256}`,
        key:
            `longform/saved-thumbs/media/by-sha256/${imageSha256}.jpg`,
        thumbnail_sha256: imageSha256,
        byte_length: image.length,
        media_type: 'image/jpeg',
        immutable: true,
    },
    'displayRecord did not emit the strict content-addressed media_ref'
);
assert.strictEqual(
    savedRecord.validateMediaRef(
        display.media_ref,
        record.media
    ).valid,
    true
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(display, 'metrics'),
    false,
    'displayRecord recomputed a metric cache'
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(display, 'channels'),
    false,
    'displayRecord recreated the legacy channel envelope'
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(display, 'emb_preview'),
    false,
    'displayRecord recreated an embedding-preview alias'
);

const leanScorerRecord = savedRecord.bindRecord({
    id: 'ltleanscorer',
    savedAt: 2,
    title,
    prompt: 'Lean scorer envelope',
    score: {
        long_score_ledger: ledger,
        output_contract: score.output_contract,
        input_manifest: score.input_manifest,
        decision_trace: record.score.decision_trace,
    },
    media: {
        kind: 'thumbnail-jpeg',
        key:
            `longform/saved-thumbs/media/by-sha256/${imageSha256}.jpg`,
        thumbnail_sha256: imageSha256,
        byte_length: image.length,
    },
});
assert.strictEqual(
    savedRecord.validateRecord(leanScorerRecord).valid,
    true,
    savedRecord.validateRecord(leanScorerRecord)
        .errors.join('; ')
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        leanScorerRecord.score,
        'non_authoritative_geometry'
    ),
    false,
    'a lean scorer envelope invented visualization geometry'
);
const noisyLeanScore = {
    long_score_ledger: ledger,
    output_contract: {
        ...score.output_contract,
        pctile: 99,
    },
    input_manifest: score.input_manifest,
    decision_trace: record.score.decision_trace,
    pctile: 0.99,
    visual_pctile: 0.99,
    text_pctile: 0.01,
    thumbnail_potential: 0.99,
    metrics: {
        ctrviews: {
            est: 99,
            pctile: 99,
        },
    },
};
const noisyLeanRecord = savedRecord.bindRecord({
    id: 'ltleanscorer',
    savedAt: 2,
    title,
    prompt: 'Lean scorer envelope',
    score: noisyLeanScore,
    media: record.media,
});
assert.deepStrictEqual(
    noisyLeanRecord,
    leanScorerRecord,
    'transient scalar aliases changed canonical persisted identity'
);
const scorerManifestWithLineage = JSON.parse(
    JSON.stringify(score.input_manifest)
);
scorerManifestWithLineage.dataset_runtime_revision = {
    modalities: {
        visual: {
            dataset_lineage: {
                account_metric_private_fit_populations: {
                    fixture: {
                        metrics: {
                            ctr: {
                                fit_population: {
                                    count: 1,
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};
const leanObservedDecisionRecord = savedRecord.bindRecord({
    id: 'ltleanobservations',
    savedAt: 3,
    title,
    prompt: 'Lean scorer decision observations',
    score: {
        long_score_ledger: ledger,
        output_contract: score.output_contract,
        input_manifest: scorerManifestWithLineage,
        relevance: 0.8,
        nn_cos: 0.9,
    },
    media: record.media,
});
assert.deepStrictEqual(
    leanObservedDecisionRecord.score.decision_trace
        .observations,
    {
        topical_relevance_cosine: 0.8,
        visual_manifold_density_cosine: 0.9,
    },
    'lean scorer decision observations were not canonicalized'
);
assert.deepStrictEqual(
    leanObservedDecisionRecord.score.decision_trace
        .policy_thresholds,
    {
        topical_relevance_floor: null,
        visual_manifold_density_floor: null,
    },
    'the persistence boundary invented policy thresholds'
);
const indexRow = savedRecord.compactIndexRow(record);
const recordArtifact = savedRecord.recordArtifactIdentity(record);
assert.strictEqual(
    indexRow.record_artifact_sha256,
    recordArtifact.sha256,
    'index row does not bind exact canonical record bytes'
);
assert.strictEqual(
    indexRow.record_byte_length,
    recordArtifact.byte_length,
    'index row canonical byte length differs'
);
assert.strictEqual(
    savedRecord.validateIndexRecordPair(indexRow, record).valid,
    true
);
const boundIndex = savedRecord.bindIndex({
    rows: [indexRow],
    legacy_unbound: [],
});
assert.strictEqual(
    savedRecord.validateIndex(boundIndex).valid,
    true,
    savedRecord.validateIndex(boundIndex).errors.join('; ')
);
const scoreInjectedIndex = JSON.parse(JSON.stringify(boundIndex));
scoreInjectedIndex.rows[0].pctile = 99;
assert.strictEqual(
    savedRecord.validateIndex(scoreInjectedIndex).valid,
    false,
    'a duplicate scalar score was accepted in a compact index row'
);
const topLevelInjection = {
    ...boundIndex,
    scores: [99],
};
assert.strictEqual(
    savedRecord.validateIndex(topLevelInjection).valid,
    false,
    'an unknown top-level score cache was accepted in the index'
);
const artifactSwapRow = {
    ...indexRow,
    record_artifact_sha256: 'f'.repeat(64),
};
artifactSwapRow.index_row_sha256 =
    ledgerContract.sha256Canonical(
        savedRecord.compactIndexRow(record)
            && {
                id: artifactSwapRow.id,
                saved_at: artifactSwapRow.saved_at,
                record_key: artifactSwapRow.record_key,
                record_content_sha256:
                    artifactSwapRow.record_content_sha256,
                record_artifact_sha256:
                    artifactSwapRow.record_artifact_sha256,
                record_byte_length:
                    artifactSwapRow.record_byte_length,
                score_record_sha256:
                    artifactSwapRow.score_record_sha256,
                ledger_sha256:
                    artifactSwapRow.ledger_sha256,
                media_key: artifactSwapRow.media_key,
                thumbnail_sha256:
                    artifactSwapRow.thumbnail_sha256,
            }
    );
assert.strictEqual(
    savedRecord.validateIndexRecordPair(
        artifactSwapRow,
        record
    ).valid,
    false,
    'an index row was allowed to point at different canonical record bytes'
);
const migrationPointerIndex = savedRecord.bindIndex({
    ...boundIndex,
    migration_release: {
        schema: savedRecord.MIGRATION_POINTER_SCHEMA,
        key:
            'longform/saved-thumbs/migration-v1/indexes/by-sha256/'
            + `${'d'.repeat(64)}.json`,
        artifact_sha256: 'd'.repeat(64),
        byte_length: 123,
        release_sha256: 'e'.repeat(64),
        index_payload_sha256:
            savedRecord.indexPayloadSha256(boundIndex),
    },
});
assert.strictEqual(
    savedRecord.validateIndex(migrationPointerIndex).valid,
    true,
    savedRecord.validateIndex(migrationPointerIndex)
        .errors.join('; ')
);
const stalePointerIndex = {
    ...savedRecord.bindIndex({
        rows: [],
        legacy_unbound: [],
    }),
    migration_release:
        migrationPointerIndex.migration_release,
};
assert.strictEqual(
    savedRecord.validateIndex(stalePointerIndex).valid,
    false,
    'a migration pointer survived after its index payload changed'
);
const retirement =
    savedRecord.retireStaleMigrationRelease(
        stalePointerIndex
    );
assert.strictEqual(retirement.retired, true);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        retirement.index,
        'migration_release'
    ),
    false,
    'stale migration pointer was not explicitly retired'
);
const reboundAfterRuntimeMutation = savedRecord.bindIndex({
    ...migrationPointerIndex,
    rows: [],
});
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        reboundAfterRuntimeMutation,
        'migration_release'
    ),
    false,
    'runtime index mutation retained stale migration provenance'
);
assert.strictEqual(
    savedRecord.validateIndex(
        reboundAfterRuntimeMutation
    ).valid,
    true
);
const droppedIndex = {
    ...boundIndex,
    rows: [],
};
assert.strictEqual(
    savedRecord.validateIndex(droppedIndex).valid,
    false,
    'dropping a canonical index row without rebinding was accepted'
);
const duplicatedIndex = savedRecord.bindIndex({
    rows: [indexRow, indexRow],
    legacy_unbound: [],
});
assert.strictEqual(
    savedRecord.validateIndex(duplicatedIndex).valid,
    false,
    'duplicate canonical ids were accepted in the bound index'
);

const onePercentScore = JSON.parse(JSON.stringify(score));
const onePercentEntry =
    onePercentScore.long_score_ledger.entries.find(
        entry => entry.coordinate_id
            === 'long.output.visual.ctrviews'
    );
onePercentEntry.percentile = 1;
onePercentScore.long_score_ledger.percentiles_by_id[
    onePercentEntry.coordinate_id
] = 1;
delete onePercentScore.long_score_ledger.ledger_sha256;
onePercentScore.long_score_ledger.ledger_sha256 =
    ledgerContract.sha256Canonical(
        onePercentScore.long_score_ledger
    );
onePercentScore.output_contract =
    longLedger.longOutputContract(
        onePercentScore.long_score_ledger
    );
onePercentScore.pctile = 0.01;
onePercentScore.visual_pctile = 0.01;
onePercentScore.thumbnail_potential = 0.01;
onePercentScore.score_alias_contract.canonical_value = 0.01;
onePercentScore.idea_model_reward = 0.01;
onePercentScore.thumbnail_model_reward = 0.01;
onePercentScore.training_reward = 0.01;
onePercentScore.reward = 0.01;
onePercentScore.reward_trace.visual_pctile = 0.01;
onePercentScore.reward_trace.idea_model_reward = 0.01;
onePercentScore.reward_trace.thumbnail_model_reward = 0.01;
onePercentScore.reward_trace.threshold_score = 0.01;
const onePercentRecord = savedRecord.bindRecord({
    id: 'ltonepercent',
    savedAt: 2,
    title,
    prompt: 'One percentile fixture',
    score: onePercentScore,
    media: record.media,
});
assert.strictEqual(
    savedRecord.scorePercentile(onePercentRecord.score),
    1,
    'a stored 1.0th percentile changed at the persistence boundary'
);
const onePercentDisplay =
    savedRecord.displayRecord(onePercentRecord);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        onePercentDisplay,
        'pctile'
    ),
    false,
    'displayRecord recomputed a percentile alias'
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        onePercentDisplay,
        'pct100'
    ),
    false,
    'displayRecord recomputed a percentile presentation cache'
);
assert.strictEqual(
    onePercentDisplay.score.long_score_ledger
        .percentiles_by_id[
            'long.output.visual.ctrviews'
        ],
    1,
    'displayRecord did not expose the exact canonical ledger value'
);

const imageSwap = JSON.parse(JSON.stringify(record));
imageSwap.media.thumbnail_sha256 = 'd'.repeat(64);
imageSwap.media.key =
    `longform/saved-thumbs/media/by-sha256/${'d'.repeat(64)}.jpg`;
imageSwap.record_content_sha256 =
    savedRecord.recordContentSha256(imageSwap);
assert.strictEqual(
    savedRecord.validateRecord(imageSwap).valid,
    false,
    'a score bound to another JPEG was accepted'
);

const titleSwap = JSON.parse(JSON.stringify(record));
titleSwap.title = 'Different title';
titleSwap.score_record_sha256 =
    ledgerContract.scoreRecordBindingSha256(titleSwap);
titleSwap.record_content_sha256 =
    savedRecord.recordContentSha256(titleSwap);
assert.strictEqual(
    savedRecord.validateRecord(titleSwap).valid,
    false,
    'a score bound to another title was accepted'
);

const ledgerSwap = JSON.parse(JSON.stringify(record));
ledgerSwap.score.long_score_ledger.values_by_id[
    'long.output.visual.views'
] += 1;
ledgerSwap.score_record_sha256 =
    ledgerContract.scoreRecordBindingSha256(ledgerSwap);
ledgerSwap.record_content_sha256 =
    savedRecord.recordContentSha256(ledgerSwap);
assert.strictEqual(
    savedRecord.validateRecord(ledgerSwap).valid,
    false,
    'a tampered self-unverified ledger was accepted'
);

const indexSwap = {
    ...indexRow,
    thumbnail_sha256: 'e'.repeat(64),
};
assert.strictEqual(
    savedRecord.validateIndexRecordPair(
        indexSwap,
        record
    ).valid,
    false,
    'a compact index row could be repointed'
);

function rehash(mutated) {
    mutated.score_record_sha256 =
        ledgerContract.scoreRecordBindingSha256(mutated);
    mutated.record_content_sha256 =
        savedRecord.recordContentSha256(mutated);
    return mutated;
}

for (const [label, mutate] of [
    [
        'percentile alias',
        candidate => {
            candidate.score.pctile = 0.99;
        },
    ],
    [
        'recomputed metrics',
        candidate => {
            candidate.score.metrics = {
                ctrviews: {
                    est: 99,
                    pctile: 99,
                },
            };
        },
    ],
    [
        'duplicated channels',
        candidate => {
            candidate.score.channels = {
                visual: {
                    metrics: {
                        ctrviews: {
                            est: 99,
                            pctile: 99,
                        },
                    },
                },
            };
        },
    ],
    [
        'derived reward',
        candidate => {
            candidate.score.reward = 0.99;
        },
    ],
    [
        'legacy reward trace',
        candidate => {
            candidate.score.reward_trace = {
                threshold_score: 0.99,
            };
        },
    ],
    [
        'output-contract score cache',
        candidate => {
            candidate.score.output_contract.pctile =
                99;
        },
    ],
    [
        'input-manifest score cache',
        candidate => {
            candidate.score.input_manifest.pctile =
                99;
        },
    ],
]) {
    const candidate = rehash(
        JSON.parse(JSON.stringify(record))
    );
    mutate(candidate);
    rehash(candidate);
    assert.strictEqual(
        savedRecord.validateRecord(candidate).valid,
        false,
        `a rehashed ${label} was accepted`
    );
}

const derivedDecisionScore = JSON.parse(
    JSON.stringify(record)
);
derivedDecisionScore.score.decision_trace.threshold_score =
    0.99;
rehash(derivedDecisionScore);
assert.strictEqual(
    savedRecord.validateRecord(derivedDecisionScore).valid,
    false,
    'decision trace accepted a copied threshold score'
);

const geometryPercentile = JSON.parse(
    JSON.stringify(record)
);
geometryPercentile.score.non_authoritative_geometry
    .channels.visual.map_placements.ctrviews.percentile = 99;
rehash(geometryPercentile);
assert.strictEqual(
    savedRecord.validateRecord(geometryPercentile).valid,
    false,
    'visualization geometry accepted a percentile'
);

const mutableMediaRef = {
    ...display.media_ref,
    url: `/api/longquant/thumbs/img/${record.id}`,
};
assert.strictEqual(
    savedRecord.validateMediaRef(
        mutableMediaRef,
        record.media
    ).valid,
    false,
    'media_ref accepted an ID-addressed mutable route'
);
assert.strictEqual(
    savedRecord.validateMediaRef(
        {
            ...display.media_ref,
            extra_score: 99,
        },
        record.media
    ).valid,
    false,
    'media_ref accepted an uncontracted field'
);

assert.throws(
    () => savedRecord.bindRecord({
        id: 'ltnestedmeta',
        savedAt: 3,
        title,
        prompt: 'Nested metadata authority',
        score,
        media: record.media,
        meta: {
            audit: {
                pctile: 0.6,
            },
        },
    }),
    /meta\.audit\.pctile/,
    'bindRecord accepted nested metadata score evidence'
);
assert.throws(
    () => savedRecord.bindRecord({
        id: 'ltnestedbaseline',
        savedAt: 4,
        title,
        prompt: 'Nested baseline authority',
        score,
        media: record.media,
        baseline: {
            candidate: {
                score,
            },
        },
    }),
    /baseline\.candidate\.score/,
    'bindRecord accepted nested baseline score evidence'
);

const nestedAuthorityRecord =
    JSON.parse(JSON.stringify(record));
nestedAuthorityRecord.meta = {
    diagnostics: {
        reward: 0.6,
    },
};
nestedAuthorityRecord.score_record_sha256 =
    ledgerContract.scoreRecordBindingSha256(
        nestedAuthorityRecord
    );
nestedAuthorityRecord.record_content_sha256 =
    savedRecord.recordContentSha256(
        nestedAuthorityRecord
    );
const nestedAuthorityValidation =
    savedRecord.validateRecord(nestedAuthorityRecord);
assert.strictEqual(
    nestedAuthorityValidation.valid,
    false,
    'a rehashed record accepted nested numerical authority'
);
assert(
    nestedAuthorityValidation.errors.some(error => (
        error.includes('meta.diagnostics.reward')
    )),
    nestedAuthorityValidation.errors.join('; ')
);

console.log(JSON.stringify({
    ok: true,
    recordSha256: record.record_content_sha256,
    scoreRecordSha256: record.score_record_sha256,
    ledgerSha256: ledger.ledger_sha256,
}));
