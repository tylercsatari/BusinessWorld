'use strict';

const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const helperStart = source.indexOf('function longQuantGrindProgress');
const helperEnd = source.indexOf('function longQuantCompactSourceVideo', helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error('Long Quant helper source not found');
const scoreStart = source.indexOf('const LONGQUANT_RELEVANCE_FLOOR');
const scoreEnd = source.indexOf('function longQuantDisplayGrindNote', scoreStart);
if (scoreStart < 0 || scoreEnd < 0) throw new Error('Long Quant scoring contract source not found');
const recoveryStart = source.indexOf('async function longQuantRecoverStaleGrinds');
const recoveryEnd = source.indexOf('async function longQuantGrindQueue', recoveryStart);
if (recoveryStart < 0 || recoveryEnd < 0) throw new Error('Long Quant recovery source not found');

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
        + '\nthis.auditApi = { longQuantGrindProgress, longQuantCompactGrindRun, longQuantGrindRunObjects, longQuantReadCompactGrindRuns, longQuantRequestPriority };',
    context
);
const scoreContext = {};
scoreContext.longQuantScoreImageBuffer = async (buf, title, idea) => {
    scoreContext.lastScoreArgs = { buf, title, idea };
    return scoreContext.scoreFixture;
};
vm.createContext(scoreContext);
vm.runInContext(
    source.slice(scoreStart, scoreEnd)
        + '\nthis.scoreApi = { longQuantOutputContract, longQuantPublicScore, longQuantScoreThumbnail, longQuantNormalizeRunScores };',
    scoreContext
);
const recoveryRuns = new Map([
    ['longform/grind/runs/partial.json', { rid: 'partial', status: 'queued', ts: Date.now() - 180_000, maxAttempts: 40, attempts: [{ thumbs: [{ status: 'done', image: 'a' }] }] }],
    ['longform/grind/runs/fresh.json', { rid: 'fresh', status: 'queued', ts: Date.now() - 180_000, maxAttempts: 40, attempts: [] }],
]);
const recoveryRequests = new Map([
    ['longform/grind/requests/partial.json', { rid: 'partial', resume: true, maxAttempts: 40 }],
    ['longform/grind/requests/fresh.json', { rid: 'fresh', resume: false, maxAttempts: 40 }],
]);
const recoveryUploads = new Map();
let recoveryRunDownloads = 0;
const recoveryContext = {
    console,
    Buffer,
    _lqGrindRecoverAt: 0,
    _lqGrindActive: new Set(),
    longQuantStaleMs: () => 120_000,
    longQuantOrphanMs: () => 120_000,
    longQuantTerminalStatus: status => ['won', 'maxed', 'deadline', 'error', 'stopped', 'archived', 'done'].includes(String(status || '')),
    longQuantGrindProgress: context.auditApi.longQuantGrindProgress,
    longQuantGrindStopped: async () => false,
    longQuantRequestFromRun: (run, rid) => ({ rid, maxAttempts: Number(run.maxAttempts) || 40, threshold: 90, hours: 20, autosaveBest: true }),
    cloud: {
        listR2Keys: async prefix => prefix.endsWith('/runs/') ? Array.from(recoveryRuns.keys()) : Array.from(recoveryRequests.keys()),
        downloadFromR2: async key => {
            if (recoveryRuns.has(key)) { recoveryRunDownloads++; return Buffer.from(JSON.stringify(recoveryRuns.get(key))); }
            return recoveryRequests.has(key) ? Buffer.from(JSON.stringify(recoveryRequests.get(key))) : null;
        },
        uploadToR2: async (key, buf) => { recoveryUploads.set(key, JSON.parse(Buffer.from(buf).toString('utf8'))); },
        deleteFromR2: async key => { recoveryRequests.delete(key); },
    },
};
vm.createContext(recoveryContext);
vm.runInContext(
    source.slice(recoveryStart, recoveryEnd) + '\nthis.recoveryApi = { longQuantRecoverStaleGrinds };',
    recoveryContext
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
    assert(aligned.output_contract.complete === false && aligned.output_contract.missing.includes('together.ctrviews'), 'incomplete legacy score was not identified');

    const completeMetrics = () => ({
        ctrviews: { pctile: 91 }, ctr: { pctile: 72 }, ret30: { pctile: 68 },
        views: { pctile: 77 }, realviews: { pctile: 74 }, gt10m: { pctile: 12 },
    });
    scoreContext.scoreFixture = {
        pctile: 0.91,
        relevance: 0.8,
        channels: {
            visual: { metrics: completeMetrics(), neighbors: [{ sim: 0.9 }] },
            together: { metrics: completeMetrics(), neighbors: [{ sim: 0.85 }] },
        },
    };
    const twelve = await scoreContext.scoreApi.longQuantScoreThumbnail('image-buffer', 'Real video title', 'Real video idea');
    assert(twelve.output_contract.complete && twelve.output_contract.expected === 12, 'shared scorer did not enforce 12 complete outputs');
    assert(twelve.output_contract.channels.join(',') === 'visual,together', 'shared scorer channel contract drifted');
    assert(scoreContext.lastScoreArgs.title === 'Real video title' && scoreContext.lastScoreArgs.idea === 'Real video idea', 'shared scorer dropped its text input');
    await scoreContext.scoreApi.longQuantScoreThumbnail('image-buffer', '', '').then(
        () => { throw new Error('shared scorer accepted blank together-channel input'); },
        error => assert(/title or idea is required/i.test(error.message), 'blank-input error was not explicit')
    );
    const rawScoreCalls = (source.match(/longQuantScoreImageBuffer\(/g) || []).length;
    assert(rawScoreCalls === 2, `found ${Math.max(0, rawScoreCalls - 2)} direct high-level scorer call(s) outside the shared contract`);
    const groupSource = source.slice(source.indexOf('async function longQuantBuildThumbGroup'), source.indexOf('async function longQuantHandleDemo'));
    assert(groupSource.includes('longQuantScoreThumbnail('), 'generate/grind thumbnail groups bypass the shared scorer');
    const uploadSource = source.slice(source.indexOf("pathname === '/api/longquant/exp/score-upload'"), source.indexOf("pathname === '/api/longquant/exp/score-key'"));
    assert(uploadSource.includes('longQuantScoreThumbnail(') && uploadSource.includes('body.title'), 'manual score bypasses the shared scorer or drops its title');

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

    const partialQueued = context.auditApi.longQuantCompactGrindRun({
        rid: 'partial',
        status: 'queued',
        ts: Date.now() - 20_000,
        maxAttempts: 40,
        attempts: [{ status: 'done', thumbs: [{ status: 'done', image: 'saved-image' }] }],
    }, 'partial', new Set(['partial']));
    assert(partialQueued.executionState === 'recovering' && partialQueued.status === 'recovering', 'started work fell back into the fresh queue');
    assert(partialQueued.hasStarted && partialQueued.resumePending && !partialQueued.waitingInQueue, 'partial-run resume flags are inconsistent');

    const freshQueued = context.auditApi.longQuantCompactGrindRun({
        rid: 'fresh', status: 'queued', ts: Date.now() - 20_000, maxAttempts: 40, attempts: [],
    }, 'fresh', new Set(['fresh']));
    assert(freshQueued.executionState === 'queued' && freshQueued.waitingInQueue && !freshQueued.hasStarted, 'never-started work is not queued');
    assert(context.auditApi.longQuantRequestPriority({ resume: true }) < context.auditApi.longQuantRequestPriority({ urgent: true }), 'resume work does not outrank fresh urgent work');

    const recoverySource = source.slice(source.indexOf('async function longQuantRecoverStaleGrinds'), source.indexOf('async function longQuantGrindQueue'));
    assert(recoverySource.includes("progress.started ? 'recovering' : 'queued'"), 'recovery does not preserve the started-vs-fresh lifecycle');
    assert(source.includes('channelQueueDepth') && source.includes('channelResumeDepth'), 'queue and resume depths are not separated');
    const processSource = source.slice(source.indexOf('async function longQuantGrindProcess'), source.indexOf('const _lqGrindActive'));
    assert(processSource.indexOf('const hb = setInterval') < processSource.indexOf('const priorIdeaTexts'), 'resume heartbeat starts after prior-idea embedding rebuild');
    assert(processSource.includes('await longQuantMapLimit(priorIdeaTexts, 3'), 'prior-idea rebuild is not bounded and parallel');
    await recoveryContext.recoveryApi.longQuantRecoverStaleGrinds();
    const migratedPartial = recoveryUploads.get('longform/grind/runs/partial.json');
    assert(migratedPartial && migratedPartial.status === 'recovering', 'persisted partial run was not migrated out of queued');
    assert(!recoveryUploads.has('longform/grind/runs/fresh.json'), 'fresh queued run was needlessly rewritten');
    assert(recoveryRunDownloads === 1, `recovery downloaded ${recoveryRunDownloads} full run snapshots instead of only resumable work`);

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
        lifecycle: { partial: partialQueued.executionState, fresh: freshQueued.executionState, persistedMigration: migratedPartial.status, resumeBeforeFresh: true, fullRunDownloads: recoveryRunDownloads },
        cap: maxed.status,
        scoring: {
            thumbnailPotential: aligned.pctile,
            ideaModelReward: aligned.idea_model_reward,
            thumbnailModelReward: aligned.thumbnail_model_reward,
            thresholdChannel: aligned.reward_trace.threshold_channel,
            packagingUsedForThreshold: aligned.reward_trace.together_used_for_threshold,
            outputContract: twelve.output_contract,
            directHighLevelScorerCalls: rawScoreCalls - 2,
        },
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
