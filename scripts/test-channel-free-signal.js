#!/usr/bin/env node
'use strict';

/*
 * Channel-free signal consistency gate.
 *
 * Verifies the whole chain agrees — the canonical run artifacts, the promotion
 * ledger, the UI artifact, and the Experiment-tab data source — so a stale
 * regeneration anywhere fails loudly instead of drifting silently.
 *
 *   node scripts/test-channel-free-signal.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

let failures = 0;
const check = (ok, label, detail) => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail}`}`);
    if (!ok) failures += 1;
};

const signal = read('buildings/jarvis/predictor-lab/channel-free-signal.json');
const scores = read('buildings/jarvis/predictor-lab/channel-free-scores.json');
const ledger = read('buildings/jarvis/principles-lab/quant/promotion-ledger.json');
const artifact = read('buildings/jarvis/principles-lab/artifact.json');
const modelPath = path.join(
    ROOT,
    'buildings/jarvis/predictor-lab/channel-free-keep-model-v1.json'
);
const modelBytes = fs.readFileSync(modelPath);
const model = JSON.parse(modelBytes.toString('utf8'));
const modelSha256 = crypto.createHash('sha256')
    .update(modelBytes)
    .digest('hex');

console.log('channel-free signal consistency gate');

// 1) signal <-> scores: same run
check(scores.runId === signal.runId, 'scores.runId matches signal.runId',
    `${scores.runId} vs ${signal.runId}`);
check(scores.identityHash === signal.dataIdentity.identityHash, 'data identity hash matches',
    'artifacts built from different corpora');
check((scores.rows || []).length === signal.dataIdentity.n, 'row count matches n',
    `${(scores.rows || []).length} vs ${signal.dataIdentity.n}`);
check(scores.selected === signal.selectedSignal.name, 'selected signal matches',
    `${scores.selected} vs ${signal.selectedSignal.name}`);
check(model.runId === signal.runId, 'deployment model matches signal run',
    `${model.runId} vs ${signal.runId}`);
check(modelSha256 === signal.deploymentArtifact.sha256,
    'deployment model bytes match the pinned SHA-256',
    `${modelSha256} vs ${signal.deploymentArtifact.sha256}`);
check(model.selectedSignal === signal.selectedSignal.name,
    'deployment model selected signal matches validation',
    `${model.selectedSignal} vs ${signal.selectedSignal.name}`);
check(model.training.channelInformation === null,
    'deployment model contains no creator information',
    JSON.stringify(model.training.channelInformation));
for (const name of ['visual', 'text', 'together', 'concat']) {
    const deployed = (model.models || {})[name] || {};
    const expectedDimensions = name === 'concat' ? 4608 : 1536;
    check(
        deployed.coordinateId === `shorts.channel-free.${name}.keep`
        && deployed.inputDimensions === expectedDimensions
        && Array.isArray(deployed.coefficients)
        && deployed.coefficients.length === expectedDimensions
        && Array.isArray(deployed.percentileReference)
        && deployed.percentileReference.length === signal.dataIdentity.n,
        `deployment formula[${name}] is complete`,
        JSON.stringify({
            coordinateId: deployed.coordinateId,
            inputDimensions: deployed.inputDimensions,
            coefficients: (deployed.coefficients || []).length,
            percentileReference: (deployed.percentileReference || []).length,
        })
    );
}

// 2) scores summary metrics match the validated results (UI reads summary)
for (const name of signal.protocol.adaptiveSearchUniverse.candidates) {
    const summary = (scores.summary || {})[name] || {};
    const validated = ((signal.results || {})[name] || {}).oof_5x5 || {};
    check(summary.mae === validated.mae_mean && summary.rho === validated.spearman_mean,
        `summary[${name}] equals validated OOF metrics`,
        `summary ${summary.mae}/${summary.rho} vs validated ${validated.mae_mean}/${validated.spearman_mean}`);
}

// 3) ledger finding mirrors the artifact and passed its own consistency gate
const finding = (ledger.findings || {}).channelFreeKeepDirection || {};
check(finding.runId === signal.runId, 'ledger finding.runId matches signal run',
    `${finding.runId} vs ${signal.runId} — rerun promotion-ledger.js`);
check(finding.consistency && finding.consistency.consistent === true,
    'ledger consistency gate passed', JSON.stringify(finding.consistency || {}));
check((finding.candidates || []).length === signal.protocol.adaptiveSearchUniverse.candidatesEvaluated,
    'ledger carries every candidate', `${(finding.candidates || []).length} candidates`);
check(finding.oofMAE === signal.selectedSignal.oofMAE, 'ledger headline MAE matches artifact',
    `${finding.oofMAE} vs ${signal.selectedSignal.oofMAE}`);

// 4) ledger provenance hashes both artifacts
const hashed = (ledger.artifacts || []).map(row => row.path);
check(hashed.includes('predictor-lab/channel-free-signal.json'), 'signal artifact is hashed in provenance', '');
check(hashed.includes('predictor-lab/channel-free-scores.json'), 'scores artifact is hashed in provenance', '');

// 5) UI artifact (Principles Lab) carries the same finding
const uiFinding = (((artifact.quantAudit || {}).promotion || {}).findings || {}).channelFreeKeepDirection || {};
check(uiFinding.runId === signal.runId, 'artifact.json finding matches signal run',
    `${uiFinding.runId} vs ${signal.runId} — rerun build-artifact.js`);
check((uiFinding.candidates || []).length === (finding.candidates || []).length,
    'artifact.json carries every candidate', '');

// 6) Saved-accounts coordinate registry (Experiment tab -> Saved accounts -> ledger/dropdown)
const validation = require(path.join(ROOT, 'buildings/jarvis/saved-channel-validation.js'));
const registry = validation.buildCoordinateRegistry();
check(registry.columns.length === 93, 'coordinate registry totals 93 (89 + 4 channel-free)',
    `${registry.columns.length} columns`);
const cfColumns = registry.columns.filter(column => column.family === 'channelFree');
check(cfColumns.length === 4, 'all 4 channelFree coordinates registered',
    cfColumns.map(column => column.id).join(', '));
check(cfColumns.every(column => column.lineage && column.lineage.runId === scores.runId),
    'channelFree coordinate lineage binds to scores runId', '');
const famMeta = (registry.families || []).find(family => family.key === 'channelFree');
check(!!famMeta && famMeta.count === 4, 'channelFree family meta present with count 4', JSON.stringify(famMeta || {}));

console.log(failures ? `\nFAIL — ${failures} consistency check(s) failed` : '\nPASS — every consumer agrees with the canonical run');
process.exit(failures ? 1 : 0);
