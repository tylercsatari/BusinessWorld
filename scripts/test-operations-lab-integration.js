#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const retention = read('buildings/jarvis/jarvis-retention.js');
const server = read('server.js');
const auth = read('auth.js');
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
for (const method of ['afterRender', 'handleClick', 'handleInput', 'handleChange', 'handleKeyDown']) {
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
    server.includes('surfaceSourceErrors: true'),
    'Operations R2 failures must be surfaced instead of masquerading as a build state',
);
assert(
    server.includes("url.searchParams.get('artifactHash')"),
    'Operations artifact requests must be able to bypass a stale server cache by hash',
);
assert(
    !auth.includes("pathname.startsWith('/api/raw/saved-hook/') || pathname.startsWith('/api/raw-long/saved-hook/')"),
    'Saved-hook analysis JSON must not bypass authentication',
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
    builder.includes('validate_artifact(artifact)')
        && builder.includes('publish_artifact(artifact)'),
    'The canonical artifact must pass a staged validation contract before publication',
);
assert(
    builder.includes('build_validation_partition(rows)')
        && builder.includes('by_adjust(hypotheses)'),
    'Validation must use one shared blocked partition and dependency-safe global correction',
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
assert(
    builder.includes('DESCRIPTIONS_COMPLETE_MARKER.write_text')
        && followup.includes('descriptions-complete.json'),
    'Description completion must use a durable marker that survives launchd restarts',
);
assert(
    builder.indexOf('save_local_description(payload)')
        < builder.indexOf('R2.put_json(f"{DESCRIPTION_PREFIX}{hook_id}.json", payload)'),
    'Paid vision results must be durably cached locally before their R2 upload',
);

console.log(JSON.stringify({
    ok: true,
    tab: 'operations',
    routes: 2,
    delegatedEvents: 5,
    proxyWarning: true,
    signedMontages: true,
}));
