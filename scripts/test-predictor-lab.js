#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const uiPath = path.join(root, 'buildings', 'jarvis', 'jarvis-retention.js');
const server = fs.readFileSync(serverPath, 'utf8');
const ui = fs.readFileSync(uiPath, 'utf8');

new vm.Script(server, { filename: serverPath });
new vm.Script(ui, { filename: uiPath });

function includes(source, marker, message) {
    assert(source.includes(marker), message || `missing contract marker: ${marker}`);
}

function matches(source, pattern, message) {
    assert(pattern.test(source), message || `missing contract pattern: ${pattern}`);
}

// The result route must prefer the persisted R2 artifact while retaining a
// local fallback, and the status route must merge analysis and embedding jobs.
includes(
    server,
    "if (pathname === '/api/raw/predictor-lab' && req.method === 'GET')",
    'server is missing the Predictor Lab artifact GET route'
);
includes(
    server,
    "path.join(__dirname, 'buildings/jarvis/predictor-lab/results.json')",
    'artifact route is missing its local persisted fallback'
);
includes(
    server,
    "serveR2Gz(req, res, 'raw/predictor-lab/results.json', 300e3, fallback)",
    'artifact route must serve the canonical R2 result with a bounded cache'
);
includes(
    server,
    "if (pathname === '/api/raw/predictor-lab/status' && req.method === 'GET')",
    'server is missing the Predictor Lab status GET route'
);
includes(
    server,
    "cloud.downloadFromR2('raw/predictor-lab/status.json')",
    'status route must read analysis progress'
);
includes(
    server,
    "cloud.downloadFromR2('raw/predictor-lab/embed-status.json')",
    'status route must read Science Center embedding progress'
);
includes(
    server,
    "const embeddingActive = embedding.stage === 'running'",
    'status route must distinguish an active embedding job'
);
includes(
    server,
    "const metadataActive = metadata.stage === 'running'",
    'status route must distinguish an active metadata job'
);
matches(
    server,
    /stage:\s*embeddingActive\s*\?\s*'embedding'\s*:\s*metadataActive\s*\?\s*'metadata'\s*:\s*analysis\.stage/,
    'merged status must surface the active job stage'
);
matches(
    server,
    /updatedAt:\s*Math\.max\(Number\(analysis\.updatedAt\s*\|\|\s*0\),\s*Number\(embedding\.heartbeat\s*\|\|\s*0\),\s*Number\(metadata\.updatedAt\s*\|\|\s*0\)\)/,
    'merged status must expose the newest heartbeat'
);
includes(
    server,
    "'Cache-Control': 'no-store'",
    'live Predictor Lab status must not be cached'
);

// Raw Data starts on the existing embedding map and keeps Predictor Lab target
// and point selection as explicit, independent state.
matches(
    ui,
    /rawView:\s*'map'.*rawPredictorTarget:\s*'keep'.*rawPredictorPoint:\s*null/,
    'Raw Data Predictor Lab state defaults are missing'
);
includes(ui, "fetch('/api/raw/predictor-lab'", 'UI does not load the persisted Predictor Lab artifact');
includes(ui, "fetch('/api/raw/predictor-lab/status'", 'UI does not poll Predictor Lab status');
includes(
    ui,
    "if (st.rawView === 'predictor') rtgUpdateRaw()",
    'status updates must repaint only while Predictor Lab is visible'
);
includes(
    ui,
    "tab('map', 'Embedding map')",
    'Raw Data is missing the embedding-map tab'
);
includes(
    ui,
    "tab('predictor', 'Predictor lab')",
    'Raw Data is missing the Predictor Lab tab'
);
includes(
    ui,
    "if ((st.rawView || 'map') === 'predictor') return viewTabs + renderRawPredictor()",
    'Raw Data does not route Predictor Lab through the shared tab state'
);

// Both missions must be independently selectable, and switching missions must
// use the corresponding persisted target rather than a shared score.
includes(
    ui,
    "targetPill('keep', 'Keep rate · private')",
    'keep-rate target control is missing'
);
includes(
    ui,
    "targetPill('views', 'Views · public')",
    'public-views target control is missing'
);
includes(
    ui,
    "const key = st.rawPredictorTarget || 'keep', target = PREDICTORLAB.targets[key]",
    'selected target is not wired to the persisted target payload'
);
includes(
    ui,
    'data-predictortarget="${id}"',
    'target controls are missing their interaction attribute'
);

// Scatter points carry target-qualified IDs. Selection, toggle-off, target
// changes, tab changes, and the close action must all update the same state.
includes(
    ui,
    'data-predictorpoint="${target}:${esc(point.id)}"',
    'scatter points must retain both target and video identity'
);
includes(
    ui,
    'st.rawPredictorPoint === `${target}:${point.id}`',
    'scatter rendering is not bound to selected-point state'
);
includes(
    ui,
    'st.rawPredictorPoint === `${st.rawPredictorTarget}:${item.id}`',
    'point detail must be scoped to the active target'
);
matches(
    ui,
    /const rwv = e\.target\.closest\('\[data-rawview\]'\);\s*if \(rwv\) \{\s*st\.rawView = rwv\.getAttribute\('data-rawview'\);\s*st\.rawPredictorPoint = null;\s*if \(st\.rawView === 'predictor'\) predictorEnsure\(false\);\s*rtgUpdateRaw\(\);\s*return;\s*\}/,
    'Raw Data tab interaction must clear stale point state and lazily load Predictor Lab'
);
matches(
    ui,
    /const rpt = e\.target\.closest\('\[data-predictortarget\]'\);\s*if \(rpt\) \{\s*st\.rawPredictorTarget = rpt\.getAttribute\('data-predictortarget'\);\s*st\.rawPredictorPoint = null;\s*rtgUpdateRaw\(\);\s*return;\s*\}/,
    'target interaction must switch mission and clear stale point state'
);
matches(
    ui,
    /const rpp = e\.target\.closest\('\[data-predictorpoint\]'\);\s*if \(rpp\) \{\s*const id = rpp\.getAttribute\('data-predictorpoint'\);\s*st\.rawPredictorPoint = st\.rawPredictorPoint === id \? null : id;\s*rtgUpdateRaw\(\);\s*return;\s*\}/,
    'point interaction must select and toggle off the exact target-qualified point'
);
matches(
    ui,
    /if \(e\.target\.closest\('\[data-predictorpointclose\]'\)\) \{\s*st\.rawPredictorPoint = null;\s*rtgUpdateRaw\(\);\s*return;\s*\}/,
    'point-detail close interaction must clear point state'
);
matches(
    ui,
    /if \(e\.target\.closest\('\[data-predictorrefresh\]'\)\) \{\s*PREDICTORLAB = null;\s*PREDICTORSTATUS = null;\s*predictorEnsure\(true\);\s*rtgUpdateRaw\(\);\s*return;\s*\}/,
    'refresh interaction must invalidate both cached payloads and force a reload'
);

// The visible contract must expose provenance, validation separation, exact
// points, the deployable formula, and all registry metadata.
for (const marker of [
    'Retrospective interpolation · predicted vs actual · every point is clickable',
    'exact held-out video',
    'separate stress test · stronger than interpolation, still retrospective unless explicitly frozen',
    'within-source video lift R²',
    'Descriptive tail calibration · not decision-grade risk',
    'Retrospective known-source folds · unseen video labels',
    'Final fitted research formula · every downstream input exposed',
    'Each term stores its training median, mean, scale, and weight.',
    'Experiment registry · ${Number(registry.evaluatedPerSelection || 0).toLocaleString()} deterministic candidates',
    'What was allowed into the score',
    'Science Center geometry benchmark',
    'Indicator relationship atlas · every candidate input',
    'Artifact provenance · what is actually frozen?',
]) {
    includes(ui, marker, `Predictor Lab UI is missing visible contract: ${marker}`);
}

console.log(JSON.stringify({
    ok: true,
    serverRoutes: 2,
    rawTabs: ['map', 'predictor'],
    targets: ['keep', 'views'],
    interactions: ['tab', 'target', 'point-toggle', 'point-close', 'refresh'],
}));
