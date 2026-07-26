#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(ROOT, 'artifact.json');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function finite(value, label) {
    assert.ok(Number.isFinite(Number(value)), `${label} must be finite`);
}

function validateSplit(split, label) {
    assert.ok(split && typeof split === 'object', `${label} is missing`);
    finite(split.n, `${label}.n`);
    finite(split.spearman, `${label}.spearman`);
    finite(split.bitsPerObservation, `${label}.bitsPerObservation`);
    finite(split.pairwise?.microAccuracy, `${label}.pairwise.microAccuracy`);
    assert.ok(
        Array.isArray(split.calibration?.bins)
            && split.calibration.bins.length >= 2,
        `${label} needs calibration bins`
    );
}

const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
assert.equal(artifact.schema, 'business-world-principles-atlas-v2');
assert.ok(artifact.quantAudit, 'quantAudit is missing');
assert.equal(artifact.generatedAt, artifact.quantAudit.generatedAt);

const declaredHash = artifact.artifactHash;
delete artifact.artifactHash;
assert.equal(
    sha256(Buffer.from(JSON.stringify(artifact))),
    declaredHash,
    'artifactHash does not bind the serialized artifact'
);

const audit = artifact.quantAudit;
assert.equal(audit.schema, 'principles-quant-audit-v1');
assert.equal(audit.verdict.promotedPrinciples, 0);
assert.equal(audit.verdict.supportedRegionalFactors, 2);
assert.equal(audit.verdict.clusterOutcomeSurvivors, 0);
assert.equal(audit.verdict.validatedClusterRelationships, 0);

assert.equal(audit.lineage.snapshot.objects, 14);
assert.equal(audit.lineage.snapshot.completeReadsPerObject, 2);
assert.equal(audit.lineage.snapshot.serverSideConditionalCopy, true);
assert.equal(audit.lineage.reconstructedGeometry.outcomesUsed, false);
assert.equal(audit.lineage.reconstructedGeometry.pass, true);
assert.equal(audit.lineage.reconstructedGeometry.channels.length, 6);

const vectorHashes = new Set();
const geometryHashes = new Set();
for (const channel of audit.lineage.reconstructedGeometry.channels) {
    assert.equal(channel.dimensions, 1536, `${channel.id} dimension mismatch`);
    assert.equal(channel.pcaComponents, 64, `${channel.id} PCA mismatch`);
    assert.deepEqual(channel.resolutions, [6, 10, 16, 24]);
    assert.match(channel.vectorSha256, /^[a-f0-9]{64}$/);
    assert.match(channel.geometrySha256, /^[a-f0-9]{64}$/);
    vectorHashes.add(channel.vectorSha256);
    geometryHashes.add(channel.geometrySha256);
}
assert.equal(vectorHashes.size, 6, 'vector hashes must be channel-specific');
assert.equal(geometryHashes.size, 6, 'geometry hashes must be channel-specific');

const gates = Object.fromEntries(
    audit.lineage.hardGates.map(row => [row.id, row])
);
for (const gate of [
    'twoReadImmutableSourceSnapshot',
    'mapVectorGenerationCoherence',
    'storedRowsOnly',
    'storedAtObservationTime',
    'recheckedExcluded',
    'historicalObservability',
]) {
    assert.equal(gates[gate]?.pass, true, `${gate} must pass`);
}
assert.equal(gates.longStrictAllModalitySupport?.pass, false);

const formats = Object.fromEntries(
    audit.support.formats.map(row => [row.format, row])
);
assert.equal(formats.shorts.observations, 53681);
assert.equal(formats.long.observations, 93671);
assert.equal(
    formats.shorts.historicallyObservableSupport.targetsWithAllModalities,
    3071
);
assert.equal(
    formats.long.historicallyObservableSupport.targetsWithAllModalities,
    171
);
assert.equal(audit.support.strictOutcomeRows, 19765);

assert.equal(audit.signals.creatorDelta.length, 6);
for (const channel of audit.signals.creatorDelta) {
    for (const split of ['unseenCreator', 'laterVideo']) {
        validateSplit(
            channel.absoluteHistoryMatched[split],
            `${channel.id}.absolute.${split}`
        );
        validateSplit(
            channel.creatorDelta[split],
            `${channel.id}.delta.${split}`
        );
    }
}

const sensitivity = audit.signals.baselineSensitivity;
assert.equal(sensitivity.grid.hypotheses, 36);
assert.equal(sensitivity.specifications.length, 6);
assert.equal(sensitivity.historySupportSpecifications.length, 4);
const sensitivityRows = sensitivity.specifications.flatMap(spec => (
    ['visual', 'together'].flatMap(modality => (
        ['unseenCreator', 'laterVideo'].map(split => (
            spec.results[modality][split]
        ))
    ))
));
assert.equal(
    sensitivityRows.filter(row => row.multiplicity.holmP <= .05).length,
    0,
    'no nuisance-baseline result should be family-wise significant'
);

const factorLedger = audit.signals.factorized.ledger;
assert.ok(factorLedger.length >= 10);
const supportedFactors = factorLedger.filter(
    row => row.status === 'supported_ood_bits'
);
assert.deepEqual(
    supportedFactors.map(row => row.id).sort(),
    ['market-hold-retention_5s', 'market-hold-viewed_percent']
);
for (const row of supportedFactors) {
    assert.ok(row.groupedBitsPerObservation > 0);
    assert.ok(row.forwardBitsPerObservation > 0);
}

assert.equal(audit.clusters.outcomeAudit.tests, 24);
assert.equal(audit.clusters.outcomeAudit.familyWiseSignificantTests, 0);
assert.equal(
    audit.clusters.invariance.mechanisms.validatedPairRelationships,
    0
);

assert.ok(
    audit.promotion.searchUniverse.knownOutcomeOrientedSearchExecutionsLowerBound
        >= 485121
);
assert.equal(audit.promotion.findings.promotedFindings.length, 0);

process.stdout.write(JSON.stringify({
    ok: true,
    artifactHash: declaredHash,
    frozenRun: audit.lineage.snapshot.runId,
    channels: audit.lineage.reconstructedGeometry.channels.length,
    strictOutcomeRows: audit.support.strictOutcomeRows,
    visibleSearches:
        audit.promotion.searchUniverse
            .knownOutcomeOrientedSearchExecutionsLowerBound,
    promotedPrinciples: audit.verdict.promotedPrinciples,
}, null, 2) + '\n');
