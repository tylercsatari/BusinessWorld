#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const {
    execFileSync,
} = require('child_process');
const longLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const scoreBinding = require(
    '../buildings/jarvis/shorts-score-ledger'
);

const ROOT = path.join(__dirname, '..');
const artifactSha256 = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const lineageSha256 = 'c'.repeat(64);
const python = `
import json
import longquant_score as scorer
channels = {}
for group in scorer.LONG_GROUPS:
    metrics = {}
    for index, metric in enumerate(scorer.LONG_METRICS):
        coordinate = f"long.output.{group}.{metric}"
        provenance = {"coordinate": coordinate}
        if coordinate == "long.output.visual.ctrviews":
            provenance.update({
                "artifact_revision": {
                    "key": "longform/thumb-rl/scorer_visual.npz",
                    "sha256": "${artifactSha256}",
                    "immutable_key": "longform/thumb-rl/by-sha256/${artifactSha256}.npz",
                    "manifest_key": "longform/thumb-rl/scorer_visual.manifest.json",
                    "manifest_sha256": "${manifestSha256}",
                    "immutable_manifest_key": "longform/thumb-rl/by-sha256/${artifactSha256}.manifest.json",
                    "lineage_manifest_sha256": "${lineageSha256}",
                    "lineage_schema_version": 1,
                },
                "dataset_lineage": {
                    "lineage_manifest_sha256": "${lineageSha256}",
                    "release_manifest_sha256": "${manifestSha256}",
                    "lineage_manifest": {"schemaVersion": 1},
                },
            })
        metrics[metric] = {
            "est": float(10 + index),
            "pctile": float(60 + index),
            "kind": "fixture",
            "projection": metric,
            "provenance": provenance,
        }
    channels[group] = {"metrics": metrics}
print(json.dumps(scorer.build_long_score_ledger(channels)))
`;
const ledger = JSON.parse(execFileSync(
    'python3',
    ['-c', python],
    { cwd: ROOT, encoding: 'utf8' }
));
const validation = longLedger.validateLongScoreLedger(ledger);
assert.strictEqual(
    validation.valid,
    true,
    validation.errors.join('; ')
);
assert.strictEqual(validation.entries.length, 21);

const record = {
    id: 'long-fixture',
    kind: 'scored',
    title: 'Long cross-language fixture',
    score_domain: 'longquant',
    long_score_ledger: ledger,
    input_manifest: {
        domain: 'longquant',
        revision_fingerprint: 'revision',
    },
};
record.output_contract = longLedger.longOutputContract(ledger);
record.pctile = 0.6;
record.visual_pctile = 0.6;
record.thumbnail_potential = 0.6;
record.score_alias_contract = {
    schema: longLedger.SCORE_ALIAS_SCHEMA,
    canonical_coordinate_id: 'long.output.visual.ctrviews',
    canonical_field: 'percentile',
    canonical_value: 0.6,
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
record.relevance = 0.8;
record.nn_cos = 0.9;
record.idea_model_reward = 0.6;
record.thumbnail_model_reward = 0.6;
record.training_reward = 0.6;
record.reward = 0.6;
record.reward_trace = {
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
};
record.decision_trace = {
    schema: 'long-saved-thumbnail-decision-trace-v1',
    authority: 'non_authoritative_decision_trace',
    threshold_coordinate_id: 'long.output.visual.ctrviews',
    packaging_used_for_threshold: false,
    observations: {
        topical_relevance_cosine: 0.8,
        visual_manifold_density_cosine: 0.9,
    },
    policy_thresholds: {
        topical_relevance_floor: 0.35,
        visual_manifold_density_floor: 0.759826,
    },
};
assert.strictEqual(
    longLedger.validateLongOutputContract(record).valid,
    true
);
assert.strictEqual(
    longLedger.validateLongScoreAliasContract(record).valid,
    true
);
assert.strictEqual(
    longLedger.validateLongScoreRewardContract(record).valid,
    true
);
const pythonBindingSha256 = execFileSync(
    'python3',
    [
        '-c',
        'import json,sys\nfrom shorts_score_ledger import score_record_binding_sha256\nprint(score_record_binding_sha256(json.load(sys.stdin)))',
    ],
    {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify(record),
    }
).trim();
assert.strictEqual(
    scoreBinding.scoreRecordBindingSha256(record),
    pythonBindingSha256,
    'Long score records must bind to identical bytes in Python and JavaScript'
);

const tamperedLedger = JSON.parse(JSON.stringify(ledger));
tamperedLedger.values_by_id['long.output.visual.views'] += 1;
assert.strictEqual(
    longLedger.validateLongScoreLedger(tamperedLedger).valid,
    false
);
const rehash = value => {
    const payload = { ...value };
    delete payload.ledger_sha256;
    value.ledger_sha256 = scoreBinding.sha256Canonical(payload);
    return value;
};
const approvedPriorRevision =
    scoreBinding.GOVERNANCE.compatibility
        .migratableLongLedgerRevisions[0];
const priorLedger = JSON.parse(JSON.stringify(ledger));
priorLedger.ledger_version = approvedPriorRevision.ledgerVersion;
priorLedger.governance_schema_version =
    approvedPriorRevision.governanceSchemaVersion;
priorLedger.governance_sha256 =
    approvedPriorRevision.governanceSha256;
rehash(priorLedger);
const migratedPriorLedger =
    longLedger.migratePriorLongScoreLedger(priorLedger);
assert(migratedPriorLedger);
assert.strictEqual(
    longLedger.validateLongScoreLedger(migratedPriorLedger).valid,
    true
);
assert.deepStrictEqual(
    migratedPriorLedger.values_by_id,
    priorLedger.values_by_id,
    'Long governance migration must not change score values'
);
const unknownPriorLedger = JSON.parse(JSON.stringify(priorLedger));
unknownPriorLedger.governance_sha256 = 'd'.repeat(64);
rehash(unknownPriorLedger);
assert.strictEqual(
    longLedger.migratePriorLongScoreLedger(unknownPriorLedger),
    null,
    'an invented Long governance revision must fail closed'
);
const missingManifestLineage = JSON.parse(JSON.stringify(ledger));
const primary = missingManifestLineage.entries.find(
    entry => entry.coordinate_id === 'long.output.visual.ctrviews'
);
delete primary.provenance.artifact_revision.manifest_sha256;
rehash(missingManifestLineage);
assert.strictEqual(
    longLedger.validateLongScoreLedger(missingManifestLineage).valid,
    false,
    'a self-rehashed primary score without release-manifest lineage was accepted'
);
const wrongArchive = JSON.parse(JSON.stringify(ledger));
wrongArchive.entries.find(
    entry => entry.coordinate_id === 'long.output.visual.ctrviews'
).provenance.artifact_revision.immutable_key =
    `longform/thumb-rl/by-sha256/${'d'.repeat(64)}.npz`;
rehash(wrongArchive);
assert.strictEqual(
    longLedger.validateLongScoreLedger(wrongArchive).valid,
    false,
    'a self-rehashed primary score pointing at another immutable artifact was accepted'
);
const textOnly = JSON.parse(JSON.stringify(ledger));
const textOnlyPrimary = textOnly.entries.find(
    entry => entry.coordinate_id === 'long.output.visual.ctrviews'
);
textOnlyPrimary.available = false;
textOnlyPrimary.value = null;
textOnlyPrimary.percentile = null;
textOnlyPrimary.kind = null;
textOnlyPrimary.projection = null;
textOnlyPrimary.provenance = null;
textOnlyPrimary.unavailable_reason = 'input_channel_not_scored';
textOnly.values_by_id[textOnlyPrimary.coordinate_id] = null;
textOnly.percentiles_by_id[textOnlyPrimary.coordinate_id] = null;
textOnly.available_count -= 1;
textOnly.all_values_available = false;
rehash(textOnly);
assert.strictEqual(
    longLedger.validateLongScoreLedger(textOnly).valid,
    true,
    'an explicitly unavailable visual primary incorrectly required artifact lineage'
);
const tamperedContract = JSON.parse(JSON.stringify(record));
tamperedContract.output_contract.coordinates.reverse();
assert.strictEqual(
    longLedger.validateLongOutputContract(tamperedContract).valid,
    false
);
const missingAlias = JSON.parse(JSON.stringify(record));
delete missingAlias.score_alias_contract;
assert.strictEqual(
    longLedger.validateLongScoreAliasContract(missingAlias).valid,
    false,
    'a scored Long record without its persisted alias contract was accepted'
);
const tamperedReward = JSON.parse(JSON.stringify(record));
tamperedReward.reward_trace.thumbnail_model_reward = 0.1;
assert.strictEqual(
    longLedger.validateLongScoreRewardContract(tamperedReward).valid,
    false,
    'a Long record with a divergent persisted reward trace was accepted'
);
const originalRecordSha256 =
    scoreBinding.scoreRecordBindingSha256(record);
const rewardMutation = JSON.parse(JSON.stringify(record));
rewardMutation.reward_trace.relevance_penalty = 0.01;
assert.strictEqual(
    scoreBinding.scoreRecordBindingSha256(rewardMutation),
    originalRecordSha256,
    'retired producer reward aliases must remain outside the canonical record binding'
);
const decisionMutation = JSON.parse(JSON.stringify(record));
decisionMutation.decision_trace.observations
    .topical_relevance_cosine = 0.79;
assert.notStrictEqual(
    scoreBinding.scoreRecordBindingSha256(decisionMutation),
    originalRecordSha256,
    'Long score record binding did not cover the canonical decision trace'
);

console.log(JSON.stringify({
    ok: true,
    coordinates: validation.entries.length,
    available: validation.availableCount,
    ledgerSha256: ledger.ledger_sha256,
    recordSha256: pythonBindingSha256,
}));
