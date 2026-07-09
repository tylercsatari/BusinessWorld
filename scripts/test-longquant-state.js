'use strict';

const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const helperStart = source.indexOf('function longQuantCompactGrindRun');
const helperEnd = source.indexOf('function longQuantActiveSort', helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error('Long Quant helper source not found');
const scoreStart = source.indexOf('const LONGQUANT_RELEVANCE_FLOOR');
const scoreEnd = source.indexOf('function longQuantDisplayGrindNote', scoreStart);
if (scoreStart < 0 || scoreEnd < 0) throw new Error('Long Quant scoring contract source not found');

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
const scoreContext = {};
vm.createContext(scoreContext);
vm.runInContext(
    source.slice(scoreStart, scoreEnd)
        + '\nthis.scoreApi = { longQuantPublicScore, longQuantNormalizeRunScores };',
    scoreContext
);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function main() {
    const legacyScore = {
        pctile: 0.41,
        reward: 0.41,
        relevance: 0.30,
        metrics: { ctr: { pctile: 8 } },
        channels: {
            visual: {
                metrics: { ctrviews: { pctile: 92 }, ctr: { pctile: 70 } },
                neighbors: [{ sim: 0.70 }],
            },
            together: { metrics: { ctr: { pctile: 8 } } },
            text: { metrics: { ctr: { pctile: 12 } } },
        },
        input_manifest: { display_preference: ['together', 'text', 'visual'] },
    };
    const aligned = scoreContext.scoreApi.longQuantPublicScore(legacyScore);
    const expectedIdeaReward = 0.92 - (0.35 - 0.30) * 2;
    const expectedThumbReward = expectedIdeaReward - (0.7598260641098022 - 0.70) * 1.5;
    assert(Math.abs(aligned.pctile - 0.92) < 1e-9, 'combined score overrode visual thumbnail potential');
    assert(Math.abs(aligned.idea_model_reward - expectedIdeaReward) < 1e-9, 'idea-model reward does not match training leash');
    assert(Math.abs(aligned.thumbnail_model_reward - expectedThumbReward) < 1e-9, 'thumbnail-model reward does not match training guards');
    assert(aligned.metrics.ctr.pctile === 70, 'default metrics did not stay on the visual channel');
    assert(aligned.input_manifest.display_preference.join(',') === 'visual,together,text', 'UI channel preference is not visual-first');
    assert(aligned.reward_trace.together_used_for_threshold === false, 'packaging embedding can affect threshold');

    const run = scoreContext.scoreApi.longQuantNormalizeRunScores({
        attempts: [{ thumbs: [{ score: legacyScore }] }],
        baseline: { score: legacyScore },
    });
    assert(run.attempts[0].thumbs[0].score.pctile === 0.92, 'stored run scores are not normalized on read');
    assert(run.baseline.score.thumbnail_model_reward != null, 'stored baseline reward trace is missing');

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
        scoring: {
            thumbnailPotential: aligned.pctile,
            ideaModelReward: aligned.idea_model_reward,
            thumbnailModelReward: aligned.thumbnail_model_reward,
            thresholdChannel: aligned.reward_trace.threshold_channel,
            packagingUsedForThreshold: aligned.reward_trace.together_used_for_threshold,
        },
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
