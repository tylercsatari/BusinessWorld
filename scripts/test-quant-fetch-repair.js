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
const youtubeRelay = fs.readFileSync(path.join(ROOT, 'yt_relay_watcher.py'), 'utf8');

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
    "const SAVED_HOOK_MEDIA_ROOT = 'raw/saved-hooks/media/by-sha256/';",
    'canonical saved Shorts hook media must use a content-addressed namespace',
);
includes(
    server,
    'const bytes = await savedHookMontageBytes(',
    'saved Shorts hook montages must resolve through their ledger-bound media reference',
);
includes(
    server,
    "? 'public, max-age=31536000, immutable'",
    'canonical saved Shorts hook media must be served immutably from the app origin',
);
excludes(
    server,
    "serveR2ObjectForRequest(req, res, `raw/saved-hooks/${savedMon[1]}.jpg`, 'image/jpeg'",
    'canonical saved Shorts media must not bypass its content-addressed ledger binding',
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
includes(server, "'raw-embed-youtube',\n                    relayRunner,\n                    'shorts',\n                    quantRequestId(req),\n                    requestFingerprint", 'link scoring must create an exact-input idempotent Shorts job');
includes(youtubeRelay, 'out = acquire_link(url, rid)', 'the residential relay must acquire media without scoring it');
includes(server, "'--file', relayTemp", 'relayed media must be scored by the canonical server runtime');
includes(server, 'validateRawScoreResult(scored)', 'the server must validate a relayed score before returning it');
const youtubeRoute = server.slice(
    server.indexOf("if (pathname === '/api/raw/embed-youtube'"),
    server.indexOf("if (pathname === '/api/raw/embed-upload'")
);
assert.strictEqual(
    (youtubeRoute.match(/validateRawScoreResult\(/g) || []).length,
    2,
    'YouTube scoring must validate the direct result once or the relayed result once, never validate a stripped relay result twice'
);
includes(
    youtubeRoute,
    'resolve(JSON.parse(line));',
    'the relay scorer payload must remain intact until acquisition metadata is attached and the final canonical validation runs'
);
excludes(youtubeRelay, 'out = score_link(url, title, creator_profile=creator_profile)', 'one-off link scoring must not run a second scorer environment on the Mac');
includes(server, "}, 'shorts', requestId, requestFingerprint);", 'upload scoring must create an exact-input idempotent Shorts job');
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
includes(server, "'raw-long-embed-image',\n                            scoreRunner,\n                            'longform',\n                            quantRequestId(req),\n                            requestFingerprint", 'Long Raw image scoring must use the exact-input Long Quant model job');
includes(server, 'const scoreRunner = () => longQuantScoreThumbnail(imageBuffer, title, idea, true);', 'Long Raw image scoring must use the trained Long Quant thumbnail scorer');
includes(long, "await lqxJob('/api/longquant/thumbs/save', canonicalPayload)", 'Long Quant saves must be durable async jobs');
includes(server, "'thumb-save',\n                    saveRunner,\n                    'longform',\n                    quantRequestId(req),\n                    requestFingerprint", 'Long Quant save jobs must be exact-input idempotent');
includes(shorts, "rtFetchJson('/api/raw/saved-hook/' + id", 'saved hook details must use retrying JSON transport');
const savedHookIndexPath = shorts.slice(
    shorts.indexOf('function loadSavedHooks('),
    shorts.indexOf('function beginSavedHookSave(')
);
includes(
    savedHookIndexPath,
    'return rtFetchJson(',
    'saved hook indexes must use retrying JSON transport'
);
includes(
    savedHookIndexPath,
    "'/api/raw/saved-hooks'",
    'the shared saved-hook loader must read the canonical index endpoint'
);
includes(
    server,
    'const compact = compactSavedHookRecord(\n                saved.record,',
    'a successful saved-hook write must return its exact compact index row'
);
includes(
    shorts,
    "function savedHookUiState()",
    'the Saved hooks badge and library must share one client-side store'
);
includes(
    shorts,
    "data-saved-hook-pending",
    'a save must be visible in the library before its network write finishes'
);
const resolveSavedReadPath = shorts.slice(
    shorts.indexOf('async function resolveSavedScoreQueueEntry('),
    shorts.indexOf('function boundedSavedScoreQueueResolution(')
);
includes(
    resolveSavedReadPath,
    'scoreContractEnsure(false);',
    'opening a persisted score may refresh revision metadata in the background'
);
excludes(
    resolveSavedReadPath,
    'await currentScorerContract(true)',
    'a persisted score must not wait for a forced live-contract refresh'
);
includes(
    shorts,
    'SAVED_HOOK_DETAIL_TOTAL_TIMEOUT_MS',
    'saved-hook detail loading must have a terminal deadline'
);
includes(
    shorts,
    'data-savedqueueretry',
    'saved-hook detail failures must expose an explicit retry control'
);
includes(shorts, "'Historical display evidence: the score ledger was '", 'legacy saved hooks must be labeled as unbound display evidence');
includes(shorts, "'This is a new transient score for an unscored '", 'an unscored saved idea may be evaluated only as an explicit transient result');
const openSavedReadPath = shorts.slice(
    shorts.indexOf('async function openSaved(id, options)'),
    shorts.indexOf('function savedDetail()')
);
excludes(openSavedReadPath, '/api/raw/hook-enrich', 'opening saved evidence must never mutate or silently migrate it');
includes(shorts, 'async function rescoreSavedHook(id)', 'historical saved videos must expose one explicit current-model re-score path');
includes(shorts, "await rtFetchJson('/api/raw/hook-enrich'", 'an explicit re-score must persist the validated replacement record');
includes(shorts, 'expected_score_record_sha256:', 'the explicit saved-video upgrade must use an atomic record precondition');
includes(shorts, "rec.transcript || rec.text || ''", 'the explicit re-score must preserve transcripts from every historical schema');
includes(shorts, "'/api/raw/saved-montage/' + id", 'the explicit re-score must attempt durable legacy montage recovery even when old metadata omitted hasMontage');
includes(shorts, 'data-best-keep-predictor', 'every score card must surface the strongest available keep-rate readout');
const rawValidationPath = server.slice(
    server.indexOf('function validateRawScoreResult('),
    server.indexOf('// Most recent raw_upload.py run')
);
includes(
    rawValidationPath,
    'validateChannelFreeKeepForecasts(',
    'every fresh scorer response must validate the four channel-free outputs'
);
includes(
    rawValidationPath,
    "fatal.push(\n            'channel-free keep outputs: '",
    'an incomplete or mismatched channel-free output set must fail closed'
);
excludes(
    rawValidationPath,
    'validateCreatorAdaptiveKeepForecast(',
    'the retired creator-adaptive output must not run on new scores'
);
excludes(
    rawValidationPath,
    'validateVisualKeepForecast(',
    'the retired frozen visual output must not run on new scores'
);
const channelFreeReadPath = shorts.slice(
    shorts.indexOf('function channelFreeKeepForecastsOf(up)'),
    shorts.indexOf('function savedVisualKeepCoordinateSnapshot')
);
for (const signal of ['visual', 'text', 'together', 'concat']) {
    includes(
        channelFreeReadPath,
        signal,
        `the score reader must recognize channel-free ${signal}`
    );
}
includes(
    channelFreeReadPath,
    "value.source !== 'live_frozen_channel_free_model_score'",
    'the UI must verify the frozen channel-free source identity'
);
includes(
    shorts,
    'Channel-free keep · no creator profile or scale',
    'the score UI must clearly disclose that creator scaling is absent'
);
includes(server, 'replacement score does not bind the canonical ledger SHA', 'saved-video upgrades must bind the exact scorer ledger before replacing evidence');
includes(server, 'surfaceSourceErrors: true', 'map and status routes must surface backing-storage failures');
includes(server, 'cached.sourceFingerprint === fingerprint', 'saved-channel validation may reuse an artifact only after every source byte matches');
includes(server, 'return buildFreshSavedChannelValidationBuffer(', 'saved-channel validation must rebuild from current exact sources or fail closed');
includes(server, 'allowStaleOnSourceError: false', 'validation claims must never fall back to stale source data');
excludes(server, "cacheStatus: 'source-unavailable-hit'", 'validation claims must not survive unavailable sources through an unverifiable fallback');
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
const passiveLongScores = (
    long.match(/lqxScoreFor\([\s\S]{0,320}?,\s*false\s*\)/g)
    || []
).length;
const activeLongScores = (
    long.match(
        /lqxScoreFor\([\s\S]{0,320}?,\s*true\s*,\s*imageSource\s*\)/g
    )
    || []
).length;
assert(passiveLongScores >= 8, `Long Quant summary cards must never rescore on render (found ${passiveLongScores} passive calls)`);
assert(activeLongScores === 0, `opening Long Quant detail surfaces must never create a new score (found ${activeLongScores} active calls)`);

// Force browsers to load the repaired clients instead of pairing new routes
// with a cached pre-repair module.
includes(index, 'jarvis-upload-utils.js?v=canonical-source-v2', 'upload canonicalization bundle cache key must be bumped');
includes(index, 'jarvis-retention.js?v=grind-outward-v1', 'Shorts bundle cache key must be bumped');
includes(index, 'storyboard-style-presets.js?v=1', 'the storyboard style contract must load before the workbench');
includes(index, 'storyboard-workbench.js?v=12', 'the advanced storyboard workbench bundle must load before Shorts');
includes(index, 'experimentlab-ui.js?v=8', 'Experiment Lab score handoff bundle must be cache-busted');
includes(index, 'experimentlab.css?v=12', 'Experiment Lab score presentation styles must be cache-busted');
includes(index, 'storyboard-workbench.css?v=8', 'the advanced storyboard workbench styles must be cache-busted');
includes(index, 'jarvis-longquant.js?v=immutable-score-card-v2', 'Long Quant bundle cache key must be bumped');

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
        passiveHistoricalEvidence: true,
        cacheBustedClients: true,
    },
}, null, 2));
