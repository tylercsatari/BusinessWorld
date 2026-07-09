'use strict';

const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const helperStart = source.indexOf('function longQuantCompactGrindRun');
const helperEnd = source.indexOf('function longQuantActiveSort', helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error('Long Quant helper source not found');

let downloads = 0;
const startedAt = Date.now();
const objects = Array.from({ length: 82 }, (_, i) => ({
    key: 'longform/grind/runs/r' + String(i).padStart(3, '0') + '.json',
    etag: 'v1-' + i,
    size: 100 + i,
    lastModified: startedAt,
}));
const payloads = new Map(objects.map((obj, i) => [obj.key, {
    rid: 'r' + String(i).padStart(3, '0'),
    status: i < 2 ? 'running' : 'queued',
    ts: startedAt - 20_000,
    threshold: 90,
    maxAttempts: 40,
    attempts: [],
}]));

const context = {
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    LONGQUANT_RENDER_MODEL: 'flux-pro',
    LONGQUANT_IDEA_MODEL: 'idea',
    longQuantThumbPromptModelLabel: () => 'thumb',
    longQuantDisplayGrindNote: note => note,
    longQuantHeartbeatFreshMs: () => 90_000,
    longQuantTerminalStatus: status => ['won', 'maxed', 'deadline', 'error', 'stopped', 'archived', 'done'].includes(String(status || '')),
    _lqGrindActive: new Set(),
    cloud: {
        listR2Objects: async () => objects.map(obj => ({ ...obj })),
        downloadFromR2: async key => {
            downloads++;
            return Buffer.from(JSON.stringify(payloads.get(key)));
        },
    },
};
vm.createContext(context);
vm.runInContext(
    source.slice(helperStart, helperEnd)
        + '\nthis.auditApi = { longQuantCompactGrindRun, longQuantGrindRunObjects, longQuantReadCompactGrindRuns };',
    context
);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function main() {
    const firstList = await context.auditApi.longQuantGrindRunObjects();
    const firstRows = await context.auditApi.longQuantReadCompactGrindRuns(firstList, 82, new Set());
    assert(firstRows.length === 82 && downloads === 82, 'cold cache mismatch');

    await context.auditApi.longQuantReadCompactGrindRuns(firstList, 82, new Set());
    assert(downloads === 82, 'warm cache redownloaded unchanged runs');

    objects[0].etag = 'v2-0';
    payloads.get(objects[0].key).best = 91;
    await new Promise(resolve => setTimeout(resolve, 1600));
    const secondList = await context.auditApi.longQuantGrindRunObjects();
    const changedRows = await context.auditApi.longQuantReadCompactGrindRuns(secondList, 82, new Set());
    assert(downloads === 83, 'ETag refresh downloaded more than the changed run');
    assert(changedRows.find(row => row.rid === 'r000').best === 91, 'changed run did not refresh');

    const slots = [
        { status: 'done', image: 'a' },
        { status: 'error', error: 'x' },
        { status: 'stopped' },
        { status: 'rendering' },
    ];
    const active = context.auditApi.longQuantCompactGrindRun({
        rid: 'slots',
        status: 'running',
        ts: Date.now() - 20_000,
        maxAttempts: 4,
        attempts: [{ status: 'rendering', thumbs: slots }],
    }, 'slots', new Set());
    assert(active.executionState === 'running' && active.status === 'running', 'in-flight final batch was marked finished');
    assert(active.thumbTryCount === 4 && active.thumbImages === 1 && active.thumbErrors === 1 && active.thumbStopped === 1, 'slot totals diverged');

    slots[3] = { status: 'error', error: 'y' };
    const maxed = context.auditApi.longQuantCompactGrindRun({
        rid: 'slots',
        status: 'running',
        ts: Date.now() - 20_000,
        maxAttempts: 4,
        attempts: [{ status: 'error', thumbs: slots }],
    }, 'slots', new Set());
    assert(maxed.status === 'maxed' && maxed.executionState === 'finished', 'finished cap did not become terminal');

    const stale = context.auditApi.longQuantCompactGrindRun({
        rid: 'stale',
        status: 'running',
        ts: Date.now() - 100_000,
        maxAttempts: 40,
        attempts: [],
    }, 'stale', new Set());
    assert(stale.executionState === 'recovering', 'missed heartbeats still appear running');

    console.log(JSON.stringify({
        ok: true,
        cache: { coldDownloads: 82, warmDownloads: 0, changedDownloads: 1 },
        counts: {
            slots: active.thumbTryCount,
            images: active.thumbImages,
            failed: active.thumbErrors,
            stopped: active.thumbStopped,
            rendering: active.thumbTryCount - active.thumbImages - active.thumbErrors - active.thumbStopped,
        },
        heartbeat: { fresh: active.executionState, stale: stale.executionState },
        cap: maxed.status,
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
