#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const shorts = fs.readFileSync(path.join(ROOT, 'buildings/jarvis/jarvis-retention.js'), 'utf8');
const long = fs.readFileSync(path.join(ROOT, 'buildings/jarvis/jarvis-longquant.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function includes(source, needle, message) {
    assert(source.includes(needle), message);
}

function excludes(source, needle, message) {
    assert(!source.includes(needle), message);
}

// Browser code converts these images to data URLs before drawing the embedding
// detail. A signed R2 redirect is valid for <img>, but fetch() cannot read it
// when the R2 bucket does not expose CORS headers.
excludes(server, 'redirectR2Object(', 'browser-readable quant media must not use signed R2 redirects');
includes(
    server,
    "serveR2ObjectForRequest(req, res, `raw/saved-hooks/${savedMon[1]}.jpg`, 'image/jpeg'",
    'saved Shorts hook montages must be streamed from the app origin',
);
includes(
    server,
    "serveR2ObjectForRequest(req, res, `longform/thumbs/${vid}.jpg`, 'image/jpeg'",
    'Long Quant thumbnails must be streamed from the app origin',
);
for (const key of [
    '`raw/montage/${rawMon[1]}.jpg`',
    '`${base}/${hookMon[2]}.jpg`',
    '`hooks/grind/montages/${grindMon[1]}.jpg`',
    '`hooks/grpo/${grpoMon[1]}/montages/${grpoMon[2]}.jpg`',
]) {
    includes(server, `serveR2ObjectForRequest(req, res, ${key}`, `quant media route ${key} must remain same-origin`);
}

// The prewarmer and an interactive scorer each touch the large neighbour
// libraries. Sharing the limiter prevents the two processes from exceeding the
// Render memory limit during boot.
includes(server, "process.env.RAW_PREWARM !== '0'", 'raw prewarm must be explicitly disableable for verification');
includes(server, 'runHeavyScore(() => new Promise(resolve => {', 'raw prewarm must share the heavy-score limiter');

// Shorts jobs must be persisted and polled in the Shorts namespace. Polling the
// Long Quant endpoint happened to work only while both sides used the default.
includes(server, "quantJobSubmit('raw-embed-youtube', relayRunner, 'shorts', quantRequestId(req))", 'link scoring must create an idempotent Shorts job');
includes(server, "}, 'shorts', quantRequestId(req));", 'upload scoring must create an idempotent Shorts job');
includes(shorts, "'/api/shortsquant/jobs/' + j.jobId", 'Shorts UI must poll the Shorts job namespace');
excludes(shorts, "'/api/longquant/jobs/' + j.jobId", 'Shorts UI must never poll Long Quant jobs');
includes(server, 'instance: QUANT_JOB_INSTANCE', 'jobs must record the process instance that owns them');
includes(server, 'rec.instance !== QUANT_JOB_INSTANCE', 'polling must detect jobs orphaned by a restart');
includes(shorts, "'X-Quant-Request-Id': requestId", 'Shorts resubmits must preserve an idempotency key');
includes(long, "'X-Quant-Request-Id': requestId", 'Long Quant resubmits must preserve an idempotency key');

// Every scorer that can exceed a reverse-proxy timeout must use the job path.
for (const marker of [
    "rtJob('/api/raw/embed-youtube'",
    "rtJob('/api/raw/embed-upload'",
    "rtJob('/api/raw/embed-montage'",
]) {
    includes(shorts, marker, `Shorts scorer must use async jobs: ${marker}`);
}
includes(long, "lqxJob('/api/raw-long/embed-montage'", 'Long Quant montage scoring must use async jobs');
includes(server, "quantJobSubmit('raw-long-embed-image', scoreRunner, 'longform', quantRequestId(req))", 'Long Raw image scoring must use the Long Quant model job');
includes(server, 'const scoreRunner = () => longQuantScoreThumbnail(imageBuffer, title, idea, true);', 'Long Raw image scoring must use the trained Long Quant thumbnail scorer');
includes(long, "lqxJob('/api/longquant/thumbs/save', payload)", 'Long Quant saves must be durable async jobs');
includes(server, "quantJobSubmit('thumb-save', saveRunner, 'longform', quantRequestId(req))", 'Long Quant save jobs must be idempotent');
includes(shorts, "rtFetchJson('/api/raw/saved-hook/' + id", 'saved hook details must use retrying JSON transport');
includes(shorts, "rtFetchJson('/api/raw/saved-hooks'", 'saved hook indexes must use retrying JSON transport');
includes(shorts, 'montageFromFrameIds(rec.frame_imgs || [])', 'legacy saved hooks must rebuild a missing montage from durable generated frames');
includes(server, 'surfaceSourceErrors: true', 'map and status routes must surface backing-storage failures');
includes(server, 'savedChannelValidationCacheIsCompatible', 'saved-channel ledgers must verify a cached artifact before source-failure fallback');
includes(server, "cacheStatus: 'source-unavailable-hit'", 'ordinary saved channels must remain readable from the last contract-matched ledger when private validation sources are temporarily unavailable');
includes(server, 'runtimeArtifact.scoredWithContractSha256 === contractSha256', 'a cached ledger must match the exact score contract before fallback');
includes(server, 'readPredictorLabReleaseManifest', 'saved-channel validation must begin from the atomic predictor-lab release pointer');
includes(server, "raw/predictor-lab/release-v1.json", 'the atomic predictor-lab release key must be pinned in the server');
includes(server, 'The predictor manifest pinned by the atomic release is not available.', 'an atomic release must fail closed when its immutable predictor manifest is missing');
includes(shorts, 'view complete row manifest', 'touch users must be able to open the complete per-video scoring manifest');
includes(shorts, '% probability', 'forecast 10M probabilities must remain continuous instead of being formatted as yes/no');
includes(long, 'connection issue while checking this grind:', 'grind polling failures must stay visible while retrying');
includes(long, 'data-lqxsavedretry', 'saved Long Quant detail failures must expose a retry action');
includes(shorts, 'if (pj.result && pj.result.error) throw new Error(pj.result.error);', 'Shorts jobs must surface scorer error payloads');
includes(long, 'if (j.result && j.result.error) throw new Error(j.result.error);', 'Long Quant jobs must surface scorer error payloads');
assert((server.match(/validateRawScoreResult\(JSON\.parse\(await (?:upRunner|monRunner)\(\)\)\)/g) || []).length >= 2,
    'upload and montage workers must convert scorer error payloads into failed jobs through the shared validator');
const passiveLongScores = (long.match(/lqxScoreFor\([^\n]+,\s*false\)/g) || []).length;
const activeLongScores = (long.match(/lqxScoreFor\([^\n]+,\s*true\)/g) || []).length;
assert(passiveLongScores >= 6, `Long Quant summary cards must never rescore on render (found ${passiveLongScores} passive calls)`);
assert(activeLongScores === 5, `only five explicitly opened detail surfaces may repair legacy scores (found ${activeLongScores})`);

// Force browsers to load the repaired clients instead of pairing new routes
// with a cached pre-repair module.
includes(index, 'jarvis-retention.js?v=creator-keep-v1', 'Shorts bundle cache key must be bumped');
includes(index, 'jarvis-longquant.js?v=coordinate-lineage-1', 'Long Quant bundle cache key must be bumped');

console.log(JSON.stringify({
    ok: true,
    contracts: {
        sameOriginMedia: true,
        shortsJobNamespace: true,
        restartRecovery: true,
        idempotentResubmits: true,
        asyncScoring: true,
        durableLongSaves: true,
        correctLongScorer: true,
        surfacedStorageErrors: true,
        memorySerialized: true,
        boundedLegacyRepair: true,
        cacheBustedClients: true,
    },
}, null, 2));
