'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const clientSource = fs.readFileSync(
    path.join(root, 'buildings', 'jarvis', 'jarvis-longquant.js'),
    'utf8'
);
const governanceBytes = fs.readFileSync(
    path.join(root, 'buildings', 'jarvis', 'quant-coordinate-governance.json')
);
const quantCoordinateGovernance = JSON.parse(governanceBytes.toString('utf8'));
const quantCoordinateGovernanceSha256 = crypto
    .createHash('sha256')
    .update(governanceBytes)
    .digest('hex');
const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const longScoreLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const longSavedThumbnailRecord = require(
    '../buildings/jarvis/long-saved-thumbnail-record'
);
const longGroups = quantCoordinateGovernance.expansions.longGroups;
const longMetricDefinitions = quantCoordinateGovernance.expansions.longMetrics;
const longMetrics = longMetricDefinitions.map(metric => metric.key);
const longCoordinates = longGroups.flatMap(group => longMetrics.map(metric => (
    quantCoordinateGovernance.coordinates.longOutputPattern
        .replace('{group}', group)
        .replace('{metricKey}', metric)
)));
const projectionByMetric = Object.fromEntries(
    longMetricDefinitions.map(metric => [metric.key, metric.projectionKey])
);
const helperStart = source.indexOf('function longQuantGrindProgress');
const helperEnd = source.indexOf('function longQuantCompactSourceVideo', helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error('Long Quant helper source not found');
const scoreStart = source.indexOf('const LONGQUANT_OUTPUT_CHANNELS');
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
    LONGQUANT_VISUAL_THRESHOLD_COORDINATE:
        longScoreLedger.VISUAL_THRESHOLD_COORDINATE,
    longQuantThumbPromptModelLabel: () => 'thumb',
    longQuantDisplayGrindNote: note => note,
    longQuantHeartbeatFreshMs: () => 90_000,
    longQuantTerminalStatus: status => ['won', 'maxed', 'deadline', 'error', 'stopped', 'archived', 'done'].includes(String(status || '')),
    longQuantAttemptPercentile100: attempt => {
        const values = (
            attempt && Array.isArray(attempt.thumbs)
                ? attempt.thumbs
                : []
        ).map(thumb => {
            const percentile = thumb
                && thumb.score
                && thumb.score.long_score_ledger
                && thumb.score.long_score_ledger
                    .percentiles_by_id
                && thumb.score.long_score_ledger
                    .percentiles_by_id[
                        longScoreLedger
                            .VISUAL_THRESHOLD_COORDINATE
                    ];
            return Number.isFinite(Number(percentile))
                ? Number(percentile)
                : null;
        }).filter(Number.isFinite);
        return values.length ? Math.max(...values) : null;
    },
    longQuantRunBestPercentile100: run => {
        const values = (
            run && Array.isArray(run.attempts)
                ? run.attempts
                : []
        ).map(attempt => context
            .longQuantAttemptPercentile100(attempt))
            .filter(Number.isFinite);
        return values.length ? Math.max(...values) : null;
    },
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
const scoreContext = {
    require,
    shortsScoreLedger,
    longSavedThumbnailRecord,
    longScoreLedger: {
        ...longScoreLedger,
        validateLongInputManifest: () => ({
            valid: true,
            errors: [],
        }),
    },
    quantCoordinateGovernance,
    quantCoordinateGovernanceSha256,
    lqScorePct: score => (
        score && Number.isFinite(Number(score.pctile))
            ? Number(score.pctile) * 100
            : null
    ),
};
scoreContext.longQuantScoreImageBuffer = async (buf, title, idea) => {
    scoreContext.lastScoreArgs = { buf, title, idea };
    return scoreContext.scoreFixture;
};
vm.createContext(scoreContext);
vm.runInContext(
    source.slice(scoreStart, scoreEnd)
        + '\nthis.scoreApi = { longQuantLedgerMetric, longQuantOutputContract, longQuantPublicScore, longQuantScoreThumbnail, longQuantNormalizeRunScores, longQuantPrimaryPercentile, longQuantDecisionReward };',
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
const recoveryFence = rid => ({
    schema: 'business-world.queue-lease-fence',
    schema_version: 1,
    queue_name: 'long-grind',
    job_id: rid,
    lease_key: `queue-leases/long-grind/${rid}.json`,
    owner_id: 'test-recovery',
    generation: 1,
    acquired_at_ms: 1,
    renewed_at_ms: 1,
    expires_at_ms: Date.now() + 60_000,
});
const recoveryContext = {
    console,
    Buffer,
    _lqGrindRecoverAt: 0,
    _lqGrindActive: new Set(),
    longQuantStaleMs: () => 120_000,
    longQuantOrphanMs: () => 120_000,
    longQuantTerminalStatus: status => ['won', 'maxed', 'deadline', 'error', 'stopped', 'archived', 'done'].includes(String(status || '')),
    longQuantGrindProgress: context.auditApi.longQuantGrindProgress,
    longQuantRequestFromRun: (run, rid) => ({ rid, maxAttempts: Number(run.maxAttempts) || 40, threshold: 90, hours: 20, autosaveBest: true }),
    QUEUE_LEASE_NAMES: {
        LONG_GRIND: 'long-grind',
    },
    queueLeaseCoordinator: {
        acquire: async (_queueName, rid) => ({
            checkpoint: async () => recoveryFence(rid),
            mutate: async (_operation, mutation) => (
                mutation(recoveryFence(rid))
            ),
            release: async () => ({
                released: true,
                reason: 'owner-released',
            }),
        }),
    },
    cloud: {
        listR2Keys: async prefix => prefix.endsWith('/runs/') ? Array.from(recoveryRuns.keys()) : Array.from(recoveryRequests.keys()),
        downloadFromR2: async key => {
            if (recoveryRuns.has(key)) { recoveryRunDownloads++; return Buffer.from(JSON.stringify(recoveryRuns.get(key))); }
            return recoveryRequests.has(key) ? Buffer.from(JSON.stringify(recoveryRequests.get(key))) : null;
        },
        uploadToR2: async (key, buf) => { recoveryUploads.set(key, JSON.parse(Buffer.from(buf).toString('utf8'))); },
        deleteFromR2: async key => { recoveryRequests.delete(key); },
        existsInR2: async () => false,
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

function scalarMetric(group, metric, pctile) {
    const value = metric === 'gt10m'
        ? Number(pctile) / 100
        : metric === 'views' || metric === 'realviews'
            ? Number(pctile) * 100_000
            : metric === 'scaled_views'
                ? Number(pctile) / 10
                : Number(pctile);
    const provenance = { coordinate: `long.output.${group}.${metric}` };
    if (group === 'visual' && metric === 'ctrviews') {
        const artifactSha256 = 'a'.repeat(64);
        const manifestSha256 = 'b'.repeat(64);
        const lineageSha256 = 'c'.repeat(64);
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
        est: value,
        pctile: Number(pctile),
        kind: 'fixture-scalar',
        provenance,
    };
}

function mapPlacement(group, metric, pctile) {
    return {
        est: null,
        pctile: Number(pctile),
        axis_x: Number(pctile) * 10,
        kind: 'neighbor_axis_percentile',
        projection: projectionByMetric[metric],
        provenance: {
            coordinate: `long.map-placement.${group}.${projectionByMetric[metric]}`,
        },
    };
}

function channelFixture(group, missing = new Set(), pctile = 70) {
    return {
        metrics: Object.fromEntries(longMetrics.map((metric, index) => [
            metric,
            missing.has(`long.output.${group}.${metric}`)
                ? null
                : scalarMetric(group, metric, pctile + index),
        ])),
        map_placements: Object.fromEntries(longMetrics.map((metric, index) => [
            metric,
            mapPlacement(group, metric, pctile + index),
        ])),
        neighbors: [{
            id: `${group}-fixture-neighbor`,
            sim: group === 'visual' ? 0.70 : 0.85,
        }],
    };
}

const fixtureTextRevision = value => {
    const text = String(value || '');
    const bytes = Buffer.from(text, 'utf8');
    return {
        present: text.length > 0,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        utf8_byte_length: bytes.length,
    };
};
const fixtureImage = Buffer.from('longquant-state-fixture-image');
const fixtureQueryPayload = {
    schema_version: 2,
    thumbnail: {
        present: true,
        sha256: crypto
            .createHash('sha256')
            .update(fixtureImage)
            .digest('hex'),
        byte_length: fixtureImage.length,
    },
    title: fixtureTextRevision('Fixture title'),
    idea: fixtureTextRevision('Fixture idea'),
    score_text: fixtureTextRevision('Fixture title'),
    selected_text_source: 'title',
};
const fixtureQuery = {
    ...fixtureQueryPayload,
    text: fixtureQueryPayload.score_text,
    generation: 'longquant-query-input-v2',
    fingerprint_sha256:
        shortsScoreLedger.sha256Canonical(fixtureQueryPayload),
    text_source: 'title',
};
const fixtureInputManifest = {
    domain: 'longquant',
    scorer: 'longquant_score.py',
    scorer_sha256:
        '02c977a89a1721ef526c3de5fd21892b943495e8c28e6dbfd5407b3f274be297',
    embedding_model: 'gemini-embedding-2',
    embedding_dimensions: 1536,
    display_contract_version: 2,
    coordinate_governance_schema_version:
        quantCoordinateGovernance.schemaVersion,
    coordinate_governance_sha256:
        quantCoordinateGovernanceSha256,
    query_input: fixtureQuery,
    query_input_fingerprint:
        fixtureQuery.fingerprint_sha256,
    thumbnail_sha256:
        fixtureQuery.thumbnail.sha256,
    score_text_sha256:
        fixtureQuery.score_text.sha256,
};

function ledgerForChannels(channels, options = {}) {
    const entries = longCoordinates.map(coordinate => {
        const [, , group, metric] = coordinate.split('.');
        const channel = channels[group];
        const value = channel && channel.metrics && channel.metrics[metric];
        const available = !!(value && Number.isFinite(Number(value.est)));
        return {
            coordinate_id: coordinate,
            group,
            metric,
            available,
            value: available ? Number(value.est) : null,
            percentile: available && Number.isFinite(Number(value.pctile))
                ? Number(value.pctile)
                : null,
            kind: value && value.kind || null,
            projection: value && value.projection || null,
            unavailable_reason: available
                ? null
                : !channel
                    ? 'input_channel_not_scored'
                    : value == null
                        ? 'scalar_estimate_not_materialized'
                        : 'scalar_estimate_not_finite',
            provenance: value && value.provenance
                ? {
                    ...value.provenance,
                    query_input: fixtureQuery,
                }
                : null,
        };
    });
    const producerErrors = [...(options.producerErrors || [])];
    const ledger = {
        schema: 'long-stored-score-ledger-v1',
        schema_version: 1,
        percentile_unit: longScoreLedger.PERCENTILE_STORAGE_UNIT,
        ledger_version: quantCoordinateGovernance.ledgerVersion,
        governance_schema_version: options.governanceSchemaVersion
            ?? quantCoordinateGovernance.schemaVersion,
        governance_sha256: options.governanceSha256
            ?? quantCoordinateGovernanceSha256,
        coordinate_ids: [...longCoordinates],
        entries,
        values_by_id: Object.fromEntries(entries.map(entry => [
            entry.coordinate_id,
            entry.value,
        ])),
        percentiles_by_id: Object.fromEntries(entries.map(entry => [
            entry.coordinate_id,
            entry.percentile,
        ])),
        available_count: entries.filter(entry => entry.available).length,
        expected_count: entries.length,
        schema_complete: entries.length === 21,
        all_values_available: entries.every(entry => entry.available),
        producer_errors: producerErrors,
        contract_valid: entries.length === 21 && producerErrors.length === 0,
    };
    ledger.ledger_sha256 = crypto
        .createHash('sha256')
        .update(shortsScoreLedger.canonicalJson(ledger))
        .digest('hex');
    return ledger;
}

function scoreFixture(channels, fields = {}) {
    const ledger = ledgerForChannels(channels);
    const visualPercentile = (
        ledger.percentiles_by_id['long.output.visual.ctrviews']
    );
    const pctile = Number(visualPercentile) / 100;
    const relevance = fields.relevance == null
        ? 0.30
        : Number(fields.relevance);
    const density = fields.nn_cos == null
        ? Number(channels.visual.neighbors[0].sim)
        : Number(fields.nn_cos);
    const relevancePenalty = Math.max(0, 0.35 - relevance) * 2;
    const densityPenalty =
        Math.max(0, 0.7598260641098022 - density) * 1.5;
    const ideaReward = pctile - relevancePenalty;
    const thumbnailReward = ideaReward - densityPenalty;
    return {
        ...fields,
        pctile,
        visual_pctile: pctile,
        thumbnail_potential: pctile,
        reward: thumbnailReward,
        training_reward: thumbnailReward,
        thumbnail_model_reward: thumbnailReward,
        idea_model_reward: ideaReward,
        relevance,
        nn_cos: density,
        score_alias_contract: {
            schema: 'long-score-alias-contract-v1',
            canonical_coordinate_id: 'long.output.visual.ctrviews',
            canonical_field: 'percentile',
            canonical_value: pctile,
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
        },
        reward_trace: {
            schema: 'long-score-reward-trace-v1',
            visual_pctile: pctile,
            relevance,
            relevance_floor: 0.35,
            relevance_penalty: relevancePenalty,
            density,
            density_floor: 0.7598260641098022,
            density_penalty: densityPenalty,
            idea_model_reward: ideaReward,
            thumbnail_model_reward: thumbnailReward,
            threshold_score: pctile,
            threshold_channel: 'visual',
            together_used_for_threshold: false,
        },
        metrics: channels.visual && channels.visual.metrics,
        channels,
        long_score_ledger: ledger,
        output_contract: longScoreLedger.longOutputContract(ledger),
        input_manifest: fixtureInputManifest,
    };
}

function clientDecisionApi() {
    const start = clientSource.indexOf(
        'const LQ_GOVERNANCE_RUNTIME'
    );
    const end = clientSource.indexOf(
        'function lqxRawRecord',
        start
    );
    if (start < 0 || end <= start) {
        throw new Error('Long Quant client decision source not found');
    }
    const context = {
        LQ_COMPARE_METRICS: longMetricDefinitions.map(metric => [
            metric.key,
            metric.label,
        ]),
        __QUANT_COORDINATE_GOVERNANCE__: quantCoordinateGovernance,
        __QUANT_COORDINATE_GOVERNANCE_SHA256__:
            quantCoordinateGovernanceSha256,
    };
    vm.createContext(context);
    vm.runInContext(
        clientSource.slice(start, end)
            + `
this.clientDecisionApi = {
    lqxCanonicalAttemptDecision,
    lqxCanonicalAutosaveState,
    lqxCanonicalGrindDecision,
    lqxCanonicalResumeDecision,
    lqxCanonicalThumbDecision,
    lqxFormatPercentile100,
    lqxHasCanonicalLedger,
    lqxPrimaryPct01,
    lqxPrimaryPct100,
};`,
        context
    );
    return context.clientDecisionApi;
}

function clientScoreCacheApi(options = {}) {
    const imageStart = clientSource.indexOf(
        'function lqxImgData('
    );
    const imageEnd = clientSource.indexOf(
        'function lqxImg(',
        imageStart
    );
    const cacheStart = clientSource.indexOf(
        'function lqxScoreFor('
    );
    const cacheEnd = clientSource.indexOf(
        'function lqxEmbHeat',
        cacheStart
    );
    const governanceStart = clientSource.indexOf(
        'const LQ_GOVERNANCE_RUNTIME'
    );
    const governanceEnd = clientSource.indexOf(
        'function lqxRawRecord',
        governanceStart
    );
    if (
        imageStart < 0
        || imageEnd <= imageStart
        || cacheStart < 0
        || cacheEnd <= cacheStart
        || governanceStart < 0
        || governanceEnd <= governanceStart
    ) {
        throw new Error(
            'Long Quant browser score-cache source not found'
        );
    }
    const scoreCache = {};
    const imageCache = {};
    const context = {
        console,
        setTimeout,
        clearTimeout,
        atob: value => Buffer.from(
            String(value),
            'base64'
        ).toString('latin1'),
        __QUANT_COORDINATE_GOVERNANCE__:
            options.governance || quantCoordinateGovernance,
        __QUANT_COORDINATE_GOVERNANCE_SHA256__:
            options.governanceSha256
            || quantCoordinateGovernanceSha256,
        LQSCORES: scoreCache,
        LQIMGS: imageCache,
        lqxGeometryChannel: () => ({}),
        urlToDataUrl: options.urlToDataUrl || (async () => {
            throw new Error('unexpected image fetch');
        }),
        lqxJob: options.job || (async () => {
            throw new Error('unexpected score request');
        }),
        rtgUpdateLqExp: () => {},
        rtgUpdateGuessesL: () => {},
        rtgUpdateRaw: () => {},
        window: {
            setTimeout,
        },
    };
    vm.createContext(context);
    vm.runInContext(
        clientSource.slice(imageStart, imageEnd)
            + clientSource.slice(cacheStart, cacheEnd)
            + clientSource.slice(
                governanceStart,
                governanceEnd
            )
            + `
this.clientScoreCacheApi = {
    LQIMGS,
    lqxImgData,
    lqxScoreFor,
};`,
        context
    );
    return context.clientScoreCacheApi;
}

async function main() {
    assert(longGroups.join(',') === 'visual,text,together', 'Long governance group order drifted');
    assert(longMetrics.length === 7, 'Long governance must define seven scalar metrics');
    assert(longCoordinates.length === 21 && new Set(longCoordinates).size === 21, 'Long governance must define 21 unique scalar addresses');

    const providerStart = source.indexOf('async function longQuantHostedRun');
    const providerEnd = source.indexOf('async function longQuantRenderThumb', providerStart);
    const providerSource = source.slice(providerStart, providerEnd);
    assert(providerStart >= 0 && providerEnd > providerStart, 'trained Long Quant provider path is missing');
    assert(source.includes("const LONGQUANT_WORKER_VERSION") && providerSource.includes('longQuantHostedRun'), 'Long Quant worker identity is not pinned');
    assert(providerSource.includes('LONGQUANT_WORKER_URL') && providerSource.includes("':longquant-worker'"), 'Long Quant does not use its authenticated trained-model worker');
    assert(providerSource.includes("task: kind") && providerSource.includes('longQuantRunModelExclusive'), 'idea/thumb adapters do not share the serialized trained worker');
    assert(providerSource.includes("longQuantModelRun('idea'") && providerSource.includes("longQuantModelRun('thumb'"), 'both trained adapters are not wired');
    assert(providerSource.includes('invent: !seed'), 'seeded grind ideas are being treated as unseeded inventions');
    for (const forbidden of ['api.replicate.com', '/deployments/', 'LONGQUANT_WORKER_DEPLOYMENT', 'hookLlmJson', 'FIREWORKS', 'OPENAI', 'ThumbPromptsFallback', 'TemplateThumbPrompts', 'IdeaBank']) {
        assert(!providerSource.includes(forbidden), `Long Quant provider path still contains fallback ${forbidden}`);
    }
    const cogSource = fs.readFileSync(require('path').join(__dirname, '..', 'buildings', 'jarvis', 'longquant-cog', 'predict.py'), 'utf8');
    const coreSource = fs.readFileSync(require('path').join(__dirname, '..', 'buildings', 'jarvis', 'longquant-cog', 'worker_core.py'), 'utf8');
    const modalSource = fs.readFileSync(require('path').join(__dirname, '..', 'buildings', 'jarvis', 'longquant-cog', 'modal_app.py'), 'utf8');
    assert(coreSource.includes('idea_long_r26') && coreSource.includes('thumb_b10'), 'shared worker core does not contain both finalized adapter identities');
    assert(coreSource.includes('enable_thinking=False'), 'shared worker core drifted from the non-thinking mode used during training');
    assert(coreSource.includes('local_files_only=True') && coreSource.includes('use_safetensors=True'), 'worker can still make avoidable network reads while loading weights');
    assert(cogSource.includes('LongQuantEngine') && modalSource.includes('LongQuantEngine'), 'Cog and Modal do not share one inference implementation');
    assert(modalSource.includes('56f3a4c46b2fe38') && modalSource.includes('2152f0e8fd27311d'), 'Modal worker does not verify both finalized adapter hashes');
    assert(modalSource.includes('.run_function(_download_adapters, secrets=[r2_secret])'), 'finalized adapters are not baked into the immutable worker image');
    assert(modalSource.indexOf('.add_local_python_source("worker_core"') > modalSource.indexOf('.run_function(_download_adapters'), 'worker source invalidates the expensive immutable weight layers');
    assert(modalSource.includes('HF_ENABLE_PARALLEL_LOADING') && modalSource.includes('HF_HUB_OFFLINE'), 'worker image does not use local parallel weight loading');
    assert(modalSource.includes('HF_PARALLEL_LOADING_WORKERS": "4"') && modalSource.includes('peft==0.19.1'), 'worker loading concurrency or adapter runtime version drifted');
    assert(modalSource.includes('gpu=["H200", "H100", "A100-80GB"]'), 'worker lacks full-memory GPU fallbacks for faster allocation');
    assert(modalSource.includes('min_containers=0') && modalSource.includes('buffer_containers=0') && modalSource.includes('scaledown_window=45'), 'worker does not have an explicit scale-to-zero policy');
    assert(providerSource.includes("task: 'health'") && providerSource.includes('longQuantKeepWorkerWarm'), 'active grinds do not bridge image-rendering gaps without an always-on worker');

    const fullChannels = Object.fromEntries(
        longGroups.map(group => [group, channelFixture(group)])
    );
    fullChannels.visual.metrics.ctrviews = scalarMetric('visual', 'ctrviews', 92);
    fullChannels.visual.metrics.ctr = scalarMetric('visual', 'ctr', 70);
    fullChannels.together.metrics.ctr = scalarMetric('together', 'ctr', 8);
    fullChannels.text.metrics.ctr = scalarMetric('text', 'ctr', 12);
    const canonicalScore = scoreFixture(fullChannels);
    canonicalScore.long_score_ledger = ledgerForChannels(fullChannels);
    canonicalScore.channels.visual.metrics.ctrviews = scalarMetric(
        'visual',
        'ctrviews',
        5
    );
    const aligned = scoreContext.scoreApi.longQuantPublicScore(canonicalScore);
    const expectedIdeaReward = 0.92 - (0.35 - 0.30) * 2;
    const expectedThumbReward = expectedIdeaReward - (0.7598260641098022 - 0.70) * 1.5;
    assert(
        Math.abs(
            scoreContext.scoreApi.longQuantPrimaryPercentile(aligned)
            - 0.92
        ) < 1e-9,
        'stale summary aliases overrode the exact stored Visual CTR+views metric'
    );
    assert(
        !Object.prototype.hasOwnProperty.call(aligned, 'pctile')
            && !Object.prototype.hasOwnProperty.call(
                aligned,
                'visual_pctile'
            )
            && !Object.prototype.hasOwnProperty.call(
                aligned,
                'thumbnail_potential'
            ),
        'canonical public score retained duplicate percentile aliases'
    );
    assert(
        aligned.decision_trace,
        `canonical public score lost its decision trace: ${
            aligned.error || JSON.stringify(Object.keys(aligned))
        }`
    );
    assert(
        Math.abs(
            scoreContext.scoreApi.longQuantDecisionReward(aligned)
            - expectedThumbReward
        ) < 1e-9,
        `derived decision reward ${
            scoreContext.scoreApi.longQuantDecisionReward(aligned)
        } does not match the bound policy trace ${expectedThumbReward}`
    );
    assert(
        Math.abs(expectedIdeaReward - 0.82) < 1e-9,
        'idea-stage training leash fixture drifted'
    );
    assert(
        scoreContext.scoreApi.longQuantLedgerMetric(
            aligned,
            'visual',
            'ctr'
        ).pctile === 70,
        'visual CTR was not read from its canonical ledger coordinate'
    );
    assert(
        aligned.decision_trace.packaging_used_for_threshold === false,
        'packaging embedding can affect threshold'
    );
    assert(aligned.output_contract.complete === true, 'structurally valid 21-address ledger was rejected');
    assert(aligned.output_contract.expected === 21 && aligned.output_contract.available === 21, 'full scalar ledger count drifted');
    assert(aligned.output_contract.all_values_available === true, 'full scalar ledger was marked nullable');
    assert(aligned.output_contract.metrics.join(',') === longMetrics.join(','), 'server metric contract drifted from governance');
    assert(aligned.output_contract.coordinates.join(',') === longCoordinates.join(','), 'server coordinates drifted from governance');
    assert(
        scoreContext.scoreApi.longQuantLedgerMetric(
            aligned,
            'visual',
            'ctrviews'
        ).pctile === 92,
        'duplicated channel cache overrode the canonical Long ledger'
    );

    const clientApi = clientDecisionApi();
    const scorerSourceSha256 = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, 'longquant_score.py')))
        .digest('hex');
    const pinnedScorerMatch = clientSource.match(
        /const LQ_SCORER_SOURCE_SHA256\s*=\s*'([a-f0-9]{64})'/
    );
    assert(
        pinnedScorerMatch
            && pinnedScorerMatch[1] === scorerSourceSha256,
        'browser cache scorer-source pin drifted from longquant_score.py'
    );
    const readOnlyApi = clientScoreCacheApi();
    const pendingImages = {};
    const imageRaceApi = clientScoreCacheApi({
        urlToDataUrl: url => new Promise(resolve => {
            pendingImages[url] = resolve;
        }),
    });
    assert(
        imageRaceApi.lqxImgData('/image-a', 'shared-image-slot') === ''
            && imageRaceApi.lqxImgData(
                '/image-b',
                'shared-image-slot'
            ) === '',
        'URL-bound image cache did not begin both distinct loads'
    );
    pendingImages['/image-a'](
        'data:image/jpeg;base64,YQ=='
    );
    await new Promise(resolve => setImmediate(resolve));
    assert(
        imageRaceApi.LQIMGS['shared-image-slot'].url
            === '/image-b'
            && !imageRaceApi.LQIMGS['shared-image-slot'].data,
        'stale image response overwrote a newer image URL'
    );
    pendingImages['/image-b'](
        'data:image/jpeg;base64,Yg=='
    );
    await new Promise(resolve => setImmediate(resolve));
    assert(
        imageRaceApi.lqxImgData(
            '/image-b',
            'shared-image-slot'
        ) === 'data:image/jpeg;base64,Yg==',
        'image cache did not bind bytes to their source URL'
    );
    assert(
        readOnlyApi.lqxScoreFor(
            'persisted-card',
            'longform/guesses/demo/montages/fixture.jpg',
            'Reconstructed title',
            'Reconstructed idea',
            canonicalScore,
            true
        ) === canonicalScore,
        'a passive card read did not return its persisted canonical score'
    );
    assert(
        readOnlyApi.lqxScoreFor(
            'missing-card',
            'longform/guesses/demo/montages/missing.jpg',
            'Any title',
            'Any idea',
            null,
            true
        ) === null,
        'a passive card read silently generated a missing score'
    );
    const clientDecisionSource = [
        clientApi.lqxCanonicalAttemptDecision,
        clientApi.lqxCanonicalAutosaveState,
        clientApi.lqxCanonicalGrindDecision,
        clientApi.lqxCanonicalResumeDecision,
        clientApi.lqxCanonicalThumbDecision,
    ].map(fn => fn.toString()).join('\n');
    for (const forbidden of [
        /run\.best\b/,
        /run\.winner\b/,
        /attempt\.pct\b/,
        /thumb\.pct\b/,
        /score\.pctile\b/,
        /autosaved\.pct\b/,
    ]) {
        assert(
            !forbidden.test(clientDecisionSource),
            `client decision reducer reads legacy alias ${forbidden}`
        );
    }
    const lowChannels = Object.fromEntries(
        longGroups.map(group => [group, channelFixture(group)])
    );
    lowChannels.visual.metrics.ctrviews = scalarMetric(
        'visual',
        'ctrviews',
        71
    );
    const lowCanonicalScore = scoreFixture(lowChannels);
    lowCanonicalScore.pctile = 0.999;
    lowCanonicalScore.visual_pctile = 0.999;
    lowCanonicalScore.thumbnail_potential = 0.999;
    lowCanonicalScore.channels.visual.metrics.ctrviews.pctile = 99.9;
    lowCanonicalScore.score_alias_contract.canonical_value = 0.999;
    const forgedWinnerRun = {
        threshold: 90,
        best: 100,
        winner: 0,
        autosaved: { id: 'forged-save', pct: 100 },
        attempts: [{
            pct: 100,
            bestThumb: 0,
            thumbs: [{
                pct: 100,
                image: 'thumb-low',
                score: lowCanonicalScore,
            }],
        }],
    };
    const forgedWinnerDecision = clientApi.lqxCanonicalGrindDecision(
        forgedWinnerRun
    );
    assert(
        forgedWinnerDecision.bestPercentile100 === 71,
        'run/attempt/thumb/score aliases changed canonical best'
    );
    assert(
        forgedWinnerDecision.won === false
            && forgedWinnerDecision.winnerAttemptIndex === null,
        'forged winner aliases cleared a 90th threshold'
    );
    const forgedAttemptDecision = clientApi.lqxCanonicalAttemptDecision(
        forgedWinnerRun.attempts[0],
        0
    );
    assert(
        forgedAttemptDecision.percentile100 === 71,
        'attempt display used attempt.pct or thumb.pct'
    );
    const forgedAutosave = clientApi.lqxCanonicalAutosaveState(
        forgedWinnerRun
    );
    assert(
        forgedAutosave.decision.bestPercentile100 === 71,
        'autosave state used autosaved.pct instead of the canonical ledger'
    );
    assert(
        !forgedAutosave.recorded
            && forgedAutosave.legacyPresent
            && clientApi.lqxCanonicalResumeDecision(
                forgedWinnerRun,
                'finished'
            ).allowed,
        'unbound autosave/winner aliases changed canonical autosave/resume decisions'
    );
    const boundAutosaveRun = JSON.parse(JSON.stringify(forgedWinnerRun));
    boundAutosaveRun.autosaved = {
        id: 'bound-save',
        pct: 100,
        canonical_binding: {
            schema: 'long-grind-autosave-binding-v1',
            ledger_sha256:
                lowCanonicalScore.long_score_ledger.ledger_sha256,
            image: 'thumb-low',
            attempt_index: 0,
            thumb_index: 0,
        },
    };
    assert(
        clientApi.lqxCanonicalAutosaveState(boundAutosaveRun).recorded,
        'content-bound autosave was not linked to the canonical best score'
    );

    const highChannels = Object.fromEntries(
        longGroups.map(group => [group, channelFixture(group)])
    );
    highChannels.visual.metrics.ctrviews = scalarMetric(
        'visual',
        'ctrviews',
        92
    );
    const highCanonicalScore = scoreFixture(highChannels);
    highCanonicalScore.pctile = 0;
    highCanonicalScore.visual_pctile = 0;
    highCanonicalScore.thumbnail_potential = 0;
    highCanonicalScore.channels.visual.metrics.ctrviews.pctile = 0;
    highCanonicalScore.score_alias_contract.canonical_value = 0;
    const hiddenWinnerRun = {
        threshold: 90,
        best: 0,
        winner: null,
        attempts: [{
            pct: 0,
            thumbs: [{ pct: 0, score: highCanonicalScore }],
        }],
    };
    const hiddenWinnerDecision = clientApi.lqxCanonicalGrindDecision(
        hiddenWinnerRun
    );
    assert(
        hiddenWinnerDecision.bestPercentile100 === 92
            && hiddenWinnerDecision.won
            && hiddenWinnerDecision.winnerAttemptIndex === 0,
        'low forged aliases hid a canonical threshold winner'
    );
    assert(
        !clientApi.lqxCanonicalResumeDecision(
            hiddenWinnerRun,
            'finished'
        ).allowed,
        'canonical winner remained resumable because aliases said it lost'
    );

    const oneChannels = Object.fromEntries(
        longGroups.map(group => [group, channelFixture(group)])
    );
    oneChannels.visual.metrics.ctrviews = scalarMetric(
        'visual',
        'ctrviews',
        1.0
    );
    const onePercentileScore = scoreFixture(oneChannels);
    onePercentileScore.pctile = 1;
    onePercentileScore.visual_pctile = 1;
    onePercentileScore.thumbnail_potential = 1;
    onePercentileScore.channels.visual.metrics.ctrviews.pctile = 100;
    assert(
        clientApi.lqxPrimaryPct100(onePercentileScore) === 1.0,
        'exact 1.0th ledger percentile was scaled to 100th'
    );
    assert(
        Math.abs(clientApi.lqxPrimaryPct01(onePercentileScore) - 0.01)
            < 1e-12,
        'exact 1.0th ledger percentile did not convert explicitly to 0.01'
    );
    assert(
        clientApi.lqxFormatPercentile100(1.0) === '1.0th',
        'exact 1.0th display lost its declared percentile unit'
    );
    assert(
        !clientApi.lqxCanonicalGrindDecision({
            threshold: 1.1,
            attempts: [{ pct: 100, thumbs: [{ pct: 100, score: onePercentileScore }] }],
        }).won,
        'exact 1.0th score incorrectly cleared a 1.1th threshold'
    );
    assert(
        clientApi.lqxCanonicalGrindDecision({
            threshold: 1.0,
            attempts: [{ pct: 0, thumbs: [{ pct: 0, score: onePercentileScore }] }],
        }).won,
        'exact 1.0th score did not clear an exact 1.0th threshold'
    );

    const invalidScore = JSON.parse(JSON.stringify(highCanonicalScore));
    invalidScore.long_score_ledger.percentiles_by_id[
        'long.output.visual.ctrviews'
    ] = 99;
    invalidScore.pctile = 1;
    invalidScore.visual_pctile = 1;
    invalidScore.thumbnail_potential = 1;
    const invalidDecision = clientApi.lqxCanonicalGrindDecision({
        threshold: 90,
        best: 100,
        winner: 0,
        attempts: [{
            pct: 100,
            thumbs: [{ pct: 100, score: invalidScore }],
        }],
    });
    assert(
        invalidDecision.bestPercentile100 === null
            && invalidDecision.won === false
            && invalidDecision.invalidThumbCount === 1,
        'invalid canonical ledger did not fail closed'
    );
    const invalidContractScore = JSON.parse(
        JSON.stringify(highCanonicalScore)
    );
    invalidContractScore.output_contract.ledger_sha256 = 'f'.repeat(64);
    const invalidContractDecision = clientApi.lqxCanonicalGrindDecision({
        threshold: 90,
        best: 100,
        attempts: [{
            pct: 100,
            thumbs: [{ pct: 100, score: invalidContractScore }],
        }],
    });
    assert(
        invalidContractDecision.bestPercentile100 === null
            && invalidContractDecision.won === false,
        'ledger with a mismatched output contract did not fail closed'
    );
    assert(
        clientApi.lqxCanonicalResumeDecision(
            {
                ...invalidDecision,
                threshold: 90,
                attempts: [{
                    pct: 100,
                    thumbs: [{ pct: 100, score: invalidScore }],
                }],
            },
            'finished'
        ).allowed,
        'invalid score alias was treated as a proven winner during resume'
    );
    const missingLedgerDecision = clientApi.lqxCanonicalGrindDecision({
        threshold: 90,
        best: 100,
        winner: 0,
        attempts: [{
            pct: 100,
            thumbs: [{
                pct: 100,
                score: {
                    pctile: 1,
                    visual_pctile: 1,
                    thumbnail_potential: 1,
                },
            }],
        }],
    });
    assert(
        missingLedgerDecision.bestPercentile100 === null
            && missingLedgerDecision.won === false,
        'missing ledger aliases produced a score decision'
    );
    assert(
        !source.slice(scoreStart, scoreEnd).includes('computedIdeaReward')
            && !source.slice(scoreStart, scoreEnd).includes(
                'computedThumbReward'
            )
            && !source.slice(scoreStart, scoreEnd).includes(
                'LONGQUANT_RELEVANCE_FLOOR'
            )
            && !source.slice(scoreStart, scoreEnd).includes(
                'LONGQUANT_DENSITY_FLOOR'
            ),
        'server still recomputes the scorer-owned persisted reward trace'
    );

    const unavailableCoordinates = new Set([
        'long.output.visual.ctr',
        'long.output.visual.ret30',
        'long.output.visual.realviews',
        'long.output.text.ctrviews',
        'long.output.text.ctr',
        'long.output.text.ret30',
        'long.output.text.realviews',
        'long.output.together.ctrviews',
        'long.output.together.ctr',
        'long.output.together.ret30',
        'long.output.together.realviews',
    ]);
    const nullableChannels = Object.fromEntries(
        longGroups.map(group => [
            group,
            channelFixture(group, unavailableCoordinates),
        ])
    );
    nullableChannels.visual.metrics.ctrviews = scalarMetric('visual', 'ctrviews', 91);
    const nullableScore = scoreFixture(nullableChannels, {
        pctile: 0.91,
        relevance: 0.8,
    });
    nullableScore.long_score_ledger = ledgerForChannels(nullableChannels);
    const nullableContract = scoreContext.scoreApi.longQuantOutputContract(nullableScore);
    assert(nullableContract.complete && nullableContract.contract_valid, 'nullable scalar ledger was treated as structurally incomplete');
    assert(nullableContract.expected === 21 && nullableContract.available === 10, 'nullable scalar availability count is wrong');
    assert(nullableContract.all_values_available === false && nullableContract.unavailable.length === 11, 'nullable coordinates were not disclosed');
    assert(nullableContract.unavailable.every(item => item.reason === 'scalar_estimate_not_materialized'), 'nullable coordinates lack explicit producer reasons');
    assert(
        nullableContract.unavailable.some(item => item.coordinate === 'long.output.together.ctrviews'),
        'map-only together CTR+views was not disclosed as an unavailable scalar'
    );
    assert(
        nullableChannels.together.map_placements.ctrviews.provenance.coordinate
            === 'long.map-placement.together.ctrviews',
        'map placement fixture does not use the governed geometry namespace'
    );
    assert(
        nullableScore.long_score_ledger.values_by_id['long.output.together.ctrviews'] === null,
        'map placement masqueraded as a scalar ledger value'
    );

    const mismatchedGovernanceScore = JSON.parse(JSON.stringify(nullableScore));
    mismatchedGovernanceScore.long_score_ledger.governance_sha256 = '0'.repeat(64);
    const mismatchedGovernance = scoreContext.scoreApi.longQuantOutputContract(
        mismatchedGovernanceScore
    );
    assert(!mismatchedGovernance.contract_valid, 'governance hash mismatch was accepted');
    assert(
        mismatchedGovernance.producer_errors.some(
            error => error.includes('governance does not match')
        ),
        'governance hash mismatch lacks an explicit error'
    );

    const missingCoordinateScore = JSON.parse(JSON.stringify(nullableScore));
    missingCoordinateScore.long_score_ledger.entries.pop();
    const missingCoordinateContract = scoreContext.scoreApi.longQuantOutputContract(
        missingCoordinateScore
    );
    assert(!missingCoordinateContract.contract_valid, 'missing scalar address was accepted');
    assert(
        missingCoordinateContract.producer_errors.some(
            error => error.includes('coordinate order or identity differs')
                || error.includes('content hash does not match')
        ),
        'missing scalar address lacks an explicit error'
    );

    scoreContext.scoreFixture = nullableScore;
    const scored = await scoreContext.scoreApi.longQuantScoreThumbnail('image-buffer', 'Real video title', 'Real video idea');
    assert(scored.output_contract.complete && scored.output_contract.expected === 21, 'shared scorer did not enforce the 21-address contract');
    assert(scored.output_contract.channels.join(',') === 'visual,text,together', 'shared scorer channel contract drifted');
    assert(scored.output_contract.available === 10 && scored.output_contract.unavailable.length === 11, 'shared scorer hid nullable coordinates');
    assert(
        !Object.prototype.hasOwnProperty.call(
            scored,
            'scoreWarning'
        ),
        'shared scorer polluted the exact score envelope with a UI warning'
    );
    assert(
        scored.output_contract.available === 10
            && scored.output_contract.unavailable.length === 11,
        'shared scorer did not expose nullable scalar reasons in the canonical output contract'
    );
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
        attempts: [{ thumbs: [{ score: canonicalScore }] }],
        baseline: { score: canonicalScore },
    });
    assert(
        scoreContext.scoreApi.longQuantPrimaryPercentile(
            run.attempts[0].thumbs[0].score
        ) === 0.92,
        'stored run scores are not normalized on read'
    );
    assert(
        run.baseline.score.decision_trace,
        'stored baseline decision trace is missing'
    );

    const firstList = await context.auditApi.longQuantGrindRunObjects();
    const firstRows = await context.auditApi.longQuantReadCompactGrindRuns(firstList, 82, new Set());
    assert(firstRows.length === 82 && downloads === 82, 'cold cache mismatch');

    await context.auditApi.longQuantReadCompactGrindRuns(firstList, 82, new Set());
    assert(downloads === 82, 'warm cache redownloaded unchanged runs');

    objects[0].etag = 'v2-0';
    payloads.get(objects[0].key).note = 'changed object';
    await new Promise(resolve => setTimeout(resolve, 1600));
    const secondList = await context.auditApi.longQuantGrindRunObjects();
    const changedRows = await context.auditApi.longQuantReadCompactGrindRuns(secondList, 82, new Set());
    assert(downloads === 83, 'ETag refresh downloaded more than the changed run');
    assert(
        changedRows.find(row => row.rid === 'r000').note === 'changed object',
        'changed run did not refresh'
    );

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
    assert(
        recoverySource.includes(
            "const waitingStatus = freshProgress.started"
        )
            && recoverySource.includes("? 'recovering'")
            && recoverySource.includes(": 'queued'"),
        'recovery does not preserve the started-vs-fresh lifecycle'
    );
    assert(source.includes('channelQueueDepth') && source.includes('channelResumeDepth'), 'queue and resume depths are not separated');
    const processSource = source.slice(source.indexOf('async function longQuantGrindProcess'), source.indexOf('const _lqGrindActive'));
    assert(processSource.indexOf('const hb = setInterval') < processSource.indexOf('const priorIdeaTexts'), 'resume heartbeat starts after prior-idea embedding rebuild');
    assert(processSource.includes('await longQuantMapLimit(priorIdeaTexts, 3'), 'prior-idea rebuild is not bounded and parallel');
    await recoveryContext.recoveryApi.longQuantRecoverStaleGrinds();
    const migratedPartial = recoveryUploads.get('longform/grind/runs/partial.json');
    assert(migratedPartial && migratedPartial.status === 'recovering', 'persisted partial run was not migrated out of queued');
    assert(!recoveryUploads.has('longform/grind/runs/fresh.json'), 'fresh queued run was needlessly rewritten');
    assert(recoveryRunDownloads === 2, `recovery downloaded ${recoveryRunDownloads} full run snapshots instead of one preliminary and one fenced revalidation read`);

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
            thumbnailPotential:
                scoreContext.scoreApi
                    .longQuantPrimaryPercentile(aligned),
            ideaModelReward: expectedIdeaReward,
            thumbnailModelReward:
                scoreContext.scoreApi
                    .longQuantDecisionReward(aligned),
            thresholdChannel: aligned.decision_trace
                .threshold_coordinate_id,
            packagingUsedForThreshold: aligned.decision_trace
                .packaging_used_for_threshold,
            outputContract: scored.output_contract,
            directHighLevelScorerCalls: rawScoreCalls - 2,
        },
        models: { provider: 'modal', idea: 'idea_long_r26', thumbnail: 'thumb_b10', fallback: false },
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
