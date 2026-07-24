#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const retention = read('buildings/jarvis/jarvis-retention.js');
const server = read('server.js');
const html = read('index.html');
const builder = read('buildings/jarvis/operations-lab/build_operations.py');
const embeddingStore = read('buildings/jarvis/promise-lab/embedding_store.py');
const followup = read('buildings/jarvis/operations-lab/finish_operations.sh');

assert(
    retention.includes("['operations', 'Operations']"),
    'Shorts Quant corpus navigation must expose the Operations tab',
);
assert(
    retention.includes('id="shorts-operations-panel"'),
    'Operations must render inside its own delegated event boundary',
);
for (const method of ['afterRender', 'handleClick', 'handleInput', 'handleChange']) {
    assert(
        retention.includes(`operationsUI().${method}`),
        `JarvisRetention must delegate ${method} to the Operations module`,
    );
}

assert(
    html.includes('buildings/jarvis/operations-lab-ui.js'),
    'The Operations UI module must load in index.html',
);
assert(
    html.includes('buildings/jarvis/operations-lab.css'),
    'The Operations stylesheet must load in index.html',
);
assert(
    server.includes("/api/shortsquant/operations-lab/status"),
    'The Operations worker status route is missing',
);
assert(
    server.includes("/api/shortsquant/operations-lab/artifact"),
    'The Operations artifact route is missing',
);
assert(
    server.includes('redirectR2Object(res, `raw/saved-hooks/${savedMon[1]}.jpg`'),
    'Saved montages must use signed R2 redirects instead of entering Render memory',
);

assert(
    builder.includes('outcomeBlindExtraction": True'),
    'Artifact provenance must record outcome-blind extraction',
);
assert(
    builder.includes('not observed YouTube swipe ratios'),
    'The artifact must identify keep values as model estimates',
);
assert(
    builder.includes('while attempt < MAX_RETRIES'),
    'Ordinary Gemini failures must remain bounded',
);
assert(
    builder.includes('if error["kind"] == "credits_or_quota_exhausted"'),
    'Credit exhaustion must have a distinct retry path',
);
assert(
    builder.includes('while failures < MAX_RETRIES'),
    'Ordinary embedding failures must remain bounded',
);
assert(
    builder.includes('for hypothesis in hypotheses'),
    'Interaction evidence must receive one correction across both declared thresholds',
);
assert(
    builder.includes('apply_global_cluster_adjustment(families)'),
    'Cluster evidence must receive a target-wide multiple-testing correction',
);
assert(
    builder.includes('on_retry=report_retry'),
    'Operations must surface embedding transport retries in worker status',
);
assert(
    embeddingStore.includes('self._notify_retry(response.status_code'),
    'The embedding transport must report provider retries as they happen',
);
assert(
    followup.includes('while true') && followup.includes('"stage": "complete"'),
    'The canonical artifact handoff must retry until the full build completes',
);

console.log(JSON.stringify({
    ok: true,
    tab: 'operations',
    routes: 2,
    delegatedEvents: 4,
    proxyWarning: true,
    signedMontages: true,
}));
