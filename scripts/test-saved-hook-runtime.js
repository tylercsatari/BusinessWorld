#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Readable } = require('stream');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const RETENTION_UI_PATH = path.join(
    ROOT,
    'buildings/jarvis/jarvis-retention.js'
);
const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
const retentionUiSource = fs.readFileSync(
    RETENTION_UI_PATH,
    'utf8'
);

const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const longScoreLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const savedHookRecordBinding = require(
    '../buildings/jarvis/saved-hook-record-binding'
);
const savedHookRuntimeIndex = require(
    '../buildings/jarvis/saved-hook-runtime-index'
);
const {
    createR2JsonCasMutator,
} = require('../buildings/jarvis/r2-json-cas');
const displayContract = require('../embedding-display-contract');

class MissingR2Object extends Error {}
class R2PreconditionFailed extends Error {}

function sourceSlice(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notStrictEqual(
        start,
        -1,
        `production source marker is missing: ${startMarker}`
    );
    assert.notStrictEqual(
        end,
        -1,
        `production source marker is missing: ${endMarker}`
    );
    assert.ok(end > start, `invalid source marker order: ${startMarker}`);
    return source.slice(start, end);
}

class MemoryR2 {
    constructor(seed = {}) {
        this.objects = new Map(
            Object.entries(seed).map(([key, value]) => [
                key,
                Buffer.isBuffer(value)
                    ? Buffer.from(value)
                    : Buffer.from(String(value), 'utf8'),
            ])
        );
        this.revisions = new Map(
            [...this.objects.keys()].map(key => [key, 1])
        );
        this.resetOperations();
    }

    resetOperations() {
        this.downloads = [];
        this.uploads = [];
        this.deletes = [];
        this.lists = [];
    }

    get writeCount() {
        return this.uploads.length + this.deletes.length;
    }

    async downloadFromR2(key) {
        this.downloads.push(key);
        const value = this.objects.get(key);
        return value == null ? null : Buffer.from(value);
    }

    async uploadToR2(key, value, mediaType) {
        const bytes = Buffer.from(value);
        this.uploads.push({
            key,
            mediaType: mediaType || null,
            byteLength: bytes.length,
        });
        this.objects.set(key, bytes);
        this.revisions.set(
            key,
            (this.revisions.get(key) || 0) + 1
        );
    }

    async getR2SmallObject(key, options = {}) {
        this.downloads.push(key);
        if (!this.objects.has(key)) {
            throw new MissingR2Object(key);
        }
        const etag = `"${this.revisions.get(key)}"`;
        if (options.ifMatch && options.ifMatch !== etag) {
            throw new R2PreconditionFailed(key);
        }
        return {
            key,
            body: Buffer.from(this.objects.get(key)),
            etag,
        };
    }

    async putR2SmallObjectConditional(
        key,
        value,
        options = {}
    ) {
        const exists = this.objects.has(key);
        const etag = exists
            ? `"${this.revisions.get(key)}"`
            : null;
        if (
            (options.ifNoneMatch === '*' && exists)
            || (
                options.ifMatch
                && options.ifMatch !== etag
            )
        ) {
            throw new R2PreconditionFailed(key);
        }
        const bytes = Buffer.from(value);
        const revision = (this.revisions.get(key) || 0) + 1;
        this.objects.set(key, bytes);
        this.revisions.set(key, revision);
        this.uploads.push({
            key,
            mediaType: options.contentType || null,
            byteLength: bytes.length,
        });
        return { key, etag: `"${revision}"` };
    }

    isMissingR2ObjectError(error) {
        return error instanceof MissingR2Object;
    }

    isR2PreconditionFailedError(error) {
        return error instanceof R2PreconditionFailed;
    }

    async deleteFromR2(key) {
        this.deletes.push(key);
        this.objects.delete(key);
    }

    async listR2Keys(prefix) {
        this.lists.push(prefix);
        return [...this.objects.keys()]
            .filter(key => key.startsWith(prefix))
            .sort();
    }
}

function request(method, body) {
    const payload = body == null ? '' : JSON.stringify(body);
    const req = Readable.from(payload ? [Buffer.from(payload)] : []);
    req.method = method;
    req.headers = {};
    return req;
}

function response() {
    let resolveEnded;
    const ended = new Promise(resolve => {
        resolveEnded = resolve;
    });
    const chunks = [];
    return {
        statusCode: null,
        headers: {},
        ended,
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            for (const [name, value] of Object.entries(headers || {})) {
                this.headers[String(name).toLowerCase()] = value;
            }
        },
        end(value) {
            if (value != null) chunks.push(Buffer.from(value));
            this.body = Buffer.concat(chunks);
            resolveEnded();
        },
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function sendJsonGz(_req, res, data, statusCode, headers = {}) {
    res.writeHead(statusCode || 200, {
        ...headers,
        'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(data));
}

function runtimeFor(cloud, options = {}) {
    const helperSource = sourceSlice(
        serverSource,
        'async function readSavedHookIndex()',
        'function savedChannelRowIsCanonicalDone'
    );
    const enrichRoute = sourceSlice(
        serverSource,
        "if (pathname === '/api/raw/hook-enrich'",
        "if ((pathname === '/api/raw/saved-hooks'"
    );
    const listRoute = sourceSlice(
        serverSource,
        "if ((pathname === '/api/raw/saved-hooks'",
        '// Folders for saved hooks:'
    );
    const montageRoute = sourceSlice(
        serverSource,
        'const savedMon = pathname.match(',
        'const savedOne = pathname.match('
    );
    const detailRoute = sourceSlice(
        serverSource,
        'const savedOne = pathname.match(',
        '// multi-channel retention:'
    );
    const r2JsonCasStorage = {
        get: (key, options) =>
            cloud.getR2SmallObject(key, options),
        put: (key, bytes, options) =>
            cloud.putR2SmallObjectConditional(
                key,
                bytes,
                options
            ),
        isMissing: error =>
            cloud.isMissingR2ObjectError(error),
        isPreconditionFailed: error =>
            cloud.isR2PreconditionFailedError(error),
    };
    const context = vm.createContext({
        Buffer,
        console,
        require,
        cloud,
        createR2JsonCasMutator,
        r2JsonCasStorage,
        shortsScoreLedger,
        longScoreLedger,
        savedHookRecordBinding,
        savedHookRuntimeIndex,
        HttpRequestError: class HttpRequestError extends Error {
            constructor(statusCode, message, code) {
                super(message);
                this.statusCode = statusCode;
                this.code = code;
            }
        },
        SAVED_HOOK_INDEX_VERSION:
            displayContract.SAVED_HOOK_INDEX_VERSION,
        SAVED_HOOK_INDEX_KEY: 'raw/saved-hooks/index.json',
        SAVED_HOOK_INDEX_CACHE_TTL_MS: 1000,
        SAVED_HOOK_MEDIA_ROOT:
            'raw/saved-hooks/media/by-sha256/',
        compactSavedHookBindingPayload:
            displayContract.compactSavedHookBindingPayload,
        compactSavedHookRecord:
            displayContract.compactSavedHookRecord,
        historicalSavedHookDisplay:
            displayContract.historicalSavedHookDisplay,
        savedHookScoreRecordSha256:
            displayContract.savedHookScoreRecordSha256,
        scoreDomainForRecord:
            displayContract.scoreDomainForRecord,
        validateCompactSavedHookRecord:
            displayContract.validateCompactSavedHookRecord,
        validateCompactSavedHookSource:
            displayContract.validateCompactSavedHookSource,
        validateHistoricalSavedHookDisplay:
            displayContract.validateHistoricalSavedHookDisplay,
        exactSha256(value) {
            return /^[a-f0-9]{64}$/i.test(String(value || ''));
        },
        validateRawScoreResult:
            options.validateRawScoreResult
            || (() => {
                throw new Error(
                    'canonical scorer validation was unexpectedly reached'
                );
            }),
        url: {
            searchParams: new URLSearchParams(),
        },
        experimentLabAccountScope: async () => null,
        requireExperimentLabItem:
            options.requireExperimentLabItem
            || (async () => null),
        readBody,
        sendJsonGz,
    });
    const program = `
${helperSource}
async function __dispatch(req, res, pathname) {
${enrichRoute}
${listRoute}
${montageRoute}
${detailRoute}
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'route not found in test harness' }));
}
globalThis.__savedHookRuntime = {
    __dispatch,
    __setView(value) {
        url.searchParams = {
            get(name) {
                return name === 'view' ? value : null;
            },
        };
    },
    canonicalSavedHookRecord,
    decodeSavedHookMontage,
    ensureSavedHookIndexIntegrity,
    readSavedHookIndex,
    savedHookIndexBindingPayload,
    savedHookMediaReference,
    savedHookMontageBytes,
    validateSavedHookRuntimeIndex,
    writeImmutableSavedHookMedia,
};
`;
    vm.runInContext(program, context, {
        filename: 'saved-hook-runtime-extracted.js',
    });
    return context.__savedHookRuntime;
}

async function dispatch(runtime, method, pathname, body) {
    const req = request(method, body);
    const res = response();
    try {
        await runtime.__dispatch(req, res, pathname);
    } catch (error) {
        res.writeHead(error.statusCode || 500, {
            'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({
            error: error.message,
            code: error.code || 'server_error',
        }));
    }
    await res.ended;
    const raw = res.body ? res.body.toString('utf8') : '';
    let json = null;
    if (raw) {
        try {
            json = JSON.parse(raw);
        } catch (_) {
            json = null;
        }
    }
    return {
        status: res.statusCode,
        headers: res.headers,
        raw,
        json,
    };
}

function jpeg(label) {
    const payload = Buffer.alloc(160, 0);
    Buffer.from(`saved-hook-runtime:${label}`, 'utf8').copy(payload);
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        payload,
        Buffer.from([0xff, 0xd9]),
    ]);
}

function fixtureLedger() {
    const features = Object.fromEntries(
        shortsScoreLedger.FEATURE_DEFINITIONS.map(
            (definition, index) => [
                definition.key,
                {
                    value: 40 + index,
                    percentile: 50 + index / 10,
                },
            ]
        )
    );
    const ledger =
        shortsScoreLedger.materializeHistoricalScoreLedger({
        features,
    });
    ledger.entries = ledger.entries.map(entry => ({
        ...entry,
        provenance: entry.available
            ? {
                status: 'current_score',
                source: 'saved_hook_runtime_test',
            }
            : entry.provenance,
    }));
    delete ledger.ledger_sha256;
    ledger.ledger_sha256 =
        shortsScoreLedger.sha256Canonical(ledger);
    return ledger;
}

function inputManifest(mediaBytes, text, ledger) {
    const normalized = savedHookRecordBinding.normalizeText(text);
    const transcriptUsed = normalized.length > 0;
    const montageSha256 =
        savedHookRecordBinding.sha256Bytes(mediaBytes);
    const embeddingInput = {
        schema: 'shorts-embedding-input-v2',
        montage_sha256: montageSha256,
        transcript: normalized,
        channels: {
            visual: '5-frame-montage',
            text: transcriptUsed
                ? 'normalized-transcript'
                : 'absent',
            together: transcriptUsed
                ? '5-frame-montage+normalized-transcript'
                : '5-frame-montage',
        },
    };
    const embeddingInputFingerprint =
        shortsScoreLedger.sha256Canonical(embeddingInput);
    const scoreInput = {
        schema: 'shorts-score-input-v2',
        embedding_input_fingerprint: embeddingInputFingerprint,
        embedding_input: embeddingInput,
        duration_ms: 5000,
        creator_profile: null,
    };
    const scoreInputFingerprint =
        shortsScoreLedger.sha256Canonical(scoreInput);
    return {
        domain: 'shorts_raw',
        scorer: 'saved-hook-runtime-fixture',
        embedding_model: 'fixture-multimodal',
        embedding_dimensions: 1536,
        display_contract_version: 1,
        feature_contract_identity_schema_version:
            ledger.feature_contract_identity_schema_version,
        feature_contract_sha256:
            ledger.feature_contract_sha256,
        feature_contract_document_sha256:
            ledger.feature_contract_document_sha256,
        coordinate_governance_version:
            ledger.coordinate_governance_version,
        coordinate_governance_sha256:
            ledger.coordinate_governance_sha256,
        source_window: 'first 5 seconds',
        source_mode: 'saved_hook_runtime_test',
        canonical_montage: {
            width: 1280,
            height: 144,
            format: 'JPEG',
            quality: 88,
            subsampling: '4:2:0',
            montage_sha256: montageSha256,
        },
        transcript_used: transcriptUsed,
        duration_s: 5,
        input_fingerprint: scoreInputFingerprint,
        score_input_fingerprint: scoreInputFingerprint,
        embedding_input_fingerprint: embeddingInputFingerprint,
        revision_fingerprint: crypto
            .createHash('sha256')
            .update('saved-hook-runtime-revision')
            .digest('hex'),
        output_fingerprint: crypto
            .createHash('sha256')
            .update('saved-hook-runtime-output')
            .digest('hex'),
        scorer_revisions: {
            scorer: {
                state: 'present',
                sha256: crypto
                    .createHash('sha256')
                    .update('fixture-scorer')
                    .digest('hex'),
            },
            feature_contract: {
                state: 'present',
                sha256:
                    ledger.feature_contract_document_sha256,
            },
        },
        channels: {
            visual: {
                present: true,
                input: '5-frame montage only',
                image: 'canonical montage',
                text: '',
            },
            text: {
                present: transcriptUsed,
                input: 'normalized transcript',
                image: '',
                text: normalized,
            },
            together: {
                present: true,
                input:
                    'canonical montage plus normalized transcript',
                image: 'canonical montage',
                text: normalized,
            },
        },
    };
}

function canonicalFixture(id = 'hkcanonical') {
    const mediaBytes = jpeg(id);
    const text = 'This is the exact bound hook text.';
    const ledger = fixtureLedger();
    const montageSha256 =
        savedHookRecordBinding.sha256Bytes(mediaBytes);
    const montageRef = {
        schema: 'saved-hook-canonical-media-v1',
        key:
            'raw/saved-hooks/media/by-sha256/'
            + `${montageSha256}.jpg`,
        sha256: montageSha256,
        byte_length: mediaBytes.length,
        media_type: 'image/jpeg',
    };
    const record = {
        id,
        savedAt: 1720000000000,
        kind: 'scored',
        score_domain: 'shorts',
        source: 'test',
        folder: null,
        title: 'Canonical fixture',
        text,
        idea: '',
        dur_s: 5,
        frames: [],
        frame_imgs: [],
        indicators: { fixture: true },
        score_ledger: ledger,
        novelty_provenance: null,
        visual_keep_forecast: null,
        creator_adaptive_keep_forecast: null,
        creator_adaptive_keep_forecast_error: null,
        channels: null,
        emb_preview: null,
        input_manifest: inputManifest(mediaBytes, text, ledger),
        hasMontage: true,
        montage_ref: montageRef,
    };
    record.score_record_sha256 =
        displayContract.savedHookScoreRecordSha256(record);
    const compact = displayContract.compactSavedHookRecord(record, {
        scoreDomain: 'shorts',
    });
    const index = canonicalIndex([compact]);
    return {
        record,
        compact,
        index,
        mediaBytes,
        recordKey: `raw/saved-hooks/${id}.json`,
        mediaKey: montageRef.key,
    };
}

function canonicalIndex(hooks, legacyHooks = [], folders = []) {
    return savedHookRuntimeIndex.bindIndex({
        hooks,
        legacy_hooks: legacyHooks,
        folders,
        updatedAt: 1720000000000,
    });
}

function canonicalSeed(fixture) {
    return {
        [fixture.recordKey]:
            JSON.stringify(fixture.record),
        [fixture.mediaKey]: fixture.mediaBytes,
        'raw/saved-hooks/index.json':
            JSON.stringify(fixture.index),
    };
}

function mutateCanonicalRecord(record, mutation) {
    const copy = JSON.parse(JSON.stringify(record));
    mutation(copy);
    return copy;
}

function jsonBuffer(value) {
    return Buffer.from(JSON.stringify(value), 'utf8');
}

const results = [];

async function test(name, fn) {
    try {
        await fn();
        results.push({ name, status: 'passed' });
    } catch (error) {
        results.push({
            name,
            status: 'failed',
            error: String(error && error.message || error),
            stack: String(error && error.stack || ''),
        });
    }
}

async function main() {
    await test('GET list rejects an invalid index without repairing R2', async () => {
        const legacyRow = {
            id: 'hklegacylist',
            savedAt: 1,
            title: 'Legacy list row',
            kind: 'scored',
            score_domain: 'shorts',
        };
        const cloud = new MemoryR2({
            'raw/saved-hooks/index.json': JSON.stringify({
                version: 1,
                hooks: [legacyRow],
                folders: [],
            }),
        });
        const runtime = runtimeFor(cloud);
        cloud.resetOperations();
        const reply = await dispatch(
            runtime,
            'GET',
            '/api/raw/saved-hooks'
        );
        assert.strictEqual(reply.status, 409);
        assert.strictEqual(cloud.writeCount, 0);
        assert.strictEqual(
            reply.json.code,
            'saved_hook_index_integrity_failed'
        );
    });

    await test('GET list rejects a missing index without scanning records', async () => {
        const cloud = new MemoryR2({
            'raw/saved-hooks/hkorphan.json': JSON.stringify({
                id: 'hkorphan',
                score_domain: 'shorts',
            }),
        });
        const runtime = runtimeFor(cloud);
        cloud.resetOperations();
        const reply = await dispatch(
            runtime,
            'GET',
            '/api/raw/saved-hooks'
        );
        assert.strictEqual(reply.status, 503);
        assert.strictEqual(reply.json.code, 'saved_hook_index_missing');
        assert.deepStrictEqual(cloud.lists, []);
        assert.strictEqual(cloud.writeCount, 0);
    });

    await test('GET detail is validation-only and never repairs R2', async () => {
        const fixture = canonicalFixture('hkreadonly');
        const cloud = new MemoryR2(canonicalSeed(fixture));
        const runtime = runtimeFor(cloud);
        cloud.resetOperations();
        const reply = await dispatch(
            runtime,
            'GET',
            `/api/raw/saved-hook/${fixture.record.id}`
        );
        assert.strictEqual(reply.status, 200, reply.raw);
        assert.strictEqual(reply.json.evidence_state, 'canonical_bound');
        assert.strictEqual(cloud.writeCount, 0);
    });

    await test(
        'editor detail validates metadata without downloading montage bytes',
        async () => {
            const fixture = canonicalFixture('hkeditorfast');
            const cloud = new MemoryR2(canonicalSeed(fixture));
            const runtime = runtimeFor(cloud);
            runtime.__setView('editor');
            cloud.resetOperations();
            const reply = await dispatch(
                runtime,
                'GET',
                `/api/raw/saved-hook/${fixture.record.id}`
            );
            assert.strictEqual(reply.status, 200, reply.raw);
            assert.strictEqual(
                reply.json.schema,
                'saved-hook-editor-payload-v1'
            );
            assert.strictEqual(reply.json.editor_media.available, true);
            assert.strictEqual(
                reply.json.source_of_truth.media_validation_deferred,
                true
            );
            assert(
                !cloud.downloads.includes(fixture.mediaKey),
                'the editor metadata path must not download the montage'
            );
            assert.strictEqual(cloud.writeCount, 0);
        }
    );

    await test(
        'concurrent saved-hook readers share one bounded index download',
        async () => {
            const fixture = canonicalFixture('hkindexcache');
            const cloud = new MemoryR2(canonicalSeed(fixture));
            const runtime = runtimeFor(cloud);
            cloud.resetOperations();
            await Promise.all([
                runtime.readSavedHookIndex(),
                runtime.readSavedHookIndex(),
                runtime.readSavedHookIndex(),
            ]);
            assert.strictEqual(
                cloud.downloads.filter(
                    key => key === 'raw/saved-hooks/index.json'
                ).length,
                1
            );
        }
    );

    await test('canonical JPEG swap is rejected with HTTP 409', async () => {
        const fixture = canonicalFixture('hkjpegswap');
        const seed = canonicalSeed(fixture);
        seed[fixture.mediaKey] = jpeg('adversarial-swap');
        const cloud = new MemoryR2(seed);
        const runtime = runtimeFor(cloud);
        cloud.resetOperations();
        const reply = await dispatch(
            runtime,
            'GET',
            `/api/raw/saved-hook/${fixture.record.id}`
        );
        assert.strictEqual(reply.status, 409, reply.raw);
        assert.strictEqual(reply.json.evidence_state, 'canonical_invalid');
        assert.strictEqual(
            reply.json.input_binding_validation.valid,
            false
        );
        assert.match(
            reply.json.input_binding_validation.errors.join(' '),
            /canonical media binding is invalid|different montage bytes/
        );
        assert.strictEqual(cloud.writeCount, 0);
    });

    await test('bound text swap is rejected with HTTP 409', async () => {
        const fixture = canonicalFixture('hktextswap');
        const swapped = mutateCanonicalRecord(
            fixture.record,
            record => {
                record.text = 'Substituted text from another hook.';
            }
        );
        const seed = canonicalSeed(fixture);
        seed[fixture.recordKey] = jsonBuffer(swapped);
        const cloud = new MemoryR2(seed);
        const runtime = runtimeFor(cloud);
        cloud.resetOperations();
        const reply = await dispatch(
            runtime,
            'GET',
            `/api/raw/saved-hook/${fixture.record.id}`
        );
        assert.strictEqual(reply.status, 409, reply.raw);
        assert.strictEqual(reply.json.evidence_state, 'canonical_invalid');
        assert.strictEqual(
            reply.json.score_record_validation.valid,
            false
        );
        assert.strictEqual(
            reply.json.input_binding_validation.valid,
            false
        );
        assert.match(
            reply.json.input_binding_validation.errors.join(' '),
            /different transcript text/
        );
        assert.strictEqual(cloud.writeCount, 0);
    });

    await test(
        'compact index/source mismatch is rejected with HTTP 409',
        async () => {
            const fixture = canonicalFixture('hkcompactmismatch');
            const alternate = mutateCanonicalRecord(
                fixture.record,
                record => {
                    record.title = 'Different source title';
                    delete record.score_record_sha256;
                }
            );
            alternate.score_record_sha256 =
                displayContract.savedHookScoreRecordSha256(alternate);
            const alternateCompact =
                displayContract.compactSavedHookRecord(alternate, {
                    scoreDomain: 'shorts',
                });
            const seed = canonicalSeed(fixture);
            seed['raw/saved-hooks/index.json'] = jsonBuffer(
                canonicalIndex([alternateCompact])
            );
            const cloud = new MemoryR2(seed);
            const runtime = runtimeFor(cloud);
            cloud.resetOperations();
            const reply = await dispatch(
                runtime,
                'GET',
                `/api/raw/saved-hook/${fixture.record.id}`
            );
            assert.strictEqual(reply.status, 409, reply.raw);
            assert.strictEqual(
                reply.json.compact_source_validation.valid,
                false
            );
            assert.strictEqual(
                reply.json.compact_source_validation.state,
                'canonical-invalid'
            );
            assert.strictEqual(cloud.writeCount, 0);
        }
    );

    await test(
        'stale enrich precondition is rejected before every write',
        async () => {
            const fixture = canonicalFixture('hkstaleenrich');
            const cloud = new MemoryR2(canonicalSeed(fixture));
            const runtime = runtimeFor(cloud);
            cloud.resetOperations();
            const reply = await dispatch(
                runtime,
                'POST',
                '/api/raw/hook-enrich',
                {
                    id: fixture.record.id,
                    expected_score_record_sha256: '0'.repeat(64),
                    montage: fixture.mediaBytes.toString('base64'),
                    text: fixture.record.text,
                }
            );
            assert.strictEqual(reply.status, 409, reply.raw);
            assert.match(
                reply.json.error,
                /changed before enrichment/
            );
            assert.strictEqual(
                cloud.writeCount,
                0,
                `stale request wrote: ${JSON.stringify({
                    uploads: cloud.uploads,
                    deletes: cloud.deletes,
                })}`
            );
        }
    );

    await test(
        'explicit enrich atomically persists a current score and refreshes the index binding',
        async () => {
            const fixture = canonicalFixture('hkexplicitrescore');
            const cloud = new MemoryR2(canonicalSeed(fixture));
            const authorizationCalls = [];
            const runtime = runtimeFor(cloud, {
                validateRawScoreResult: value => value,
                requireExperimentLabItem: async (...args) => {
                    authorizationCalls.push(args);
                    return null;
                },
            });
            cloud.resetOperations();
            const channelFreeKeepForecasts = {
                schema: 'shorts-channel-free-keep-forecasts-v1',
                outputs: Object.fromEntries(
                    ['visual', 'text', 'together', 'concat'].map(
                        (signal, index) => [signal, {
                            coordinate_id:
                                `shorts.channel-free.${signal}.keep`,
                            raw: 70 + index,
                            est: 70 + index,
                            available: true,
                        }]
                    )
                ),
            };
            const reply = await dispatch(
                runtime,
                'POST',
                '/api/raw/hook-enrich',
                {
                    id: fixture.record.id,
                    expected_score_record_sha256:
                        fixture.record.score_record_sha256,
                    montage:
                        fixture.mediaBytes.toString('base64'),
                    text: fixture.record.text,
                    indicators: fixture.record.indicators,
                    score_ledger: fixture.record.score_ledger,
                    score_ledger_sha256:
                        fixture.record.score_ledger.ledger_sha256,
                    novelty_provenance: null,
                    channel_free_keep_forecasts:
                        channelFreeKeepForecasts,
                    channels: fixture.record.channels,
                    emb_preview: fixture.record.emb_preview,
                    input_manifest: fixture.record.input_manifest,
                }
            );
            assert.strictEqual(reply.status, 200, reply.raw);
            assert.strictEqual(authorizationCalls.length, 1);
            assert.strictEqual(
                authorizationCalls[0][2],
                'hooks'
            );
            assert.strictEqual(
                authorizationCalls[0][3],
                fixture.record.id
            );
            assert.strictEqual(
                authorizationCalls[0][4]
                    && authorizationCalls[0][4].write,
                true
            );
            const persisted = JSON.parse(
                cloud.objects.get(fixture.recordKey).toString('utf8')
            );
            assert.deepStrictEqual(
                persisted.channel_free_keep_forecasts,
                channelFreeKeepForecasts
            );
            assert.strictEqual(persisted.visual_keep_forecast, null);
            assert.strictEqual(
                persisted.creator_adaptive_keep_forecast,
                null
            );
            assert.notStrictEqual(
                persisted.score_record_sha256,
                fixture.record.score_record_sha256
            );
            assert.strictEqual(
                persisted.score_record_sha256,
                displayContract.savedHookScoreRecordSha256(persisted)
            );
            const index = JSON.parse(
                cloud.objects.get(
                    'raw/saved-hooks/index.json'
                ).toString('utf8')
            );
            const compact = index.hooks.find(
                row => row.id === fixture.record.id
            );
            assert.ok(compact);
            assert.strictEqual(
                compact.score_record_sha256,
                persisted.score_record_sha256
            );
        }
    );

    await test(
        'legacy record remains visible as legacy_unbound_evidence with HTTP 200',
        async () => {
            const id = 'hklegacyevidence';
            const legacy = {
                id,
                savedAt: 1700000000000,
                kind: 'scored',
                score_domain: 'shorts',
                title: 'Historical display cache',
                text: 'Historical text with no joint binding',
                hasMontage: true,
                steer: {
                    visual_keep: { est: 80, pctile: 90 },
                },
                features: {
                    visual_keep: { value: 80, percentile: 90 },
                },
            };
            const cloud = new MemoryR2({
                [`raw/saved-hooks/${id}.json`]:
                    JSON.stringify(legacy),
                [`raw/saved-hooks/${id}.jpg`]: jpeg('legacy'),
                'raw/saved-hooks/index.json': JSON.stringify(
                    canonicalIndex([], [{
                        id,
                        savedAt: legacy.savedAt,
                        title: legacy.title,
                        kind: legacy.kind,
                        score_domain: 'shorts',
                        hasMontage: true,
                        folder: null,
                        frame_imgs: [],
                        evidence_state: 'legacy_unbound_evidence',
                        canonical: false,
                        predictor_eligible: false,
                        evidence_warning:
                            'Historical display cache only.',
                    }])
                ),
            });
            const runtime = runtimeFor(cloud);
            cloud.resetOperations();
            const reply = await dispatch(
                runtime,
                'GET',
                `/api/raw/saved-hook/${id}`
            );
            assert.strictEqual(reply.status, 200, reply.raw);
            assert.strictEqual(
                reply.json.evidence_state,
                'legacy_unbound_evidence'
            );
            assert.strictEqual(
                reply.json.score_record_validation.valid,
                null
            );
            assert.strictEqual(cloud.writeCount, 0);
        }
    );

    await test(
        'prior-document historical ledger opens read-only with HTTP 200',
        async () => {
            const id = 'hkhistoricalledger';
            const ledger = fixtureLedger();
            ledger.entries.forEach(entry => {
                entry.provenance = {
                    ...(entry.provenance || {}),
                    status: entry.available
                        ? 'historical_materialization'
                        : 'unavailable',
                };
            });
            ledger.feature_contract_document_sha256 =
                '4'.repeat(64);
            delete ledger.ledger_sha256;
            ledger.ledger_sha256 =
                shortsScoreLedger.sha256Canonical(ledger);
            const archivedDocumentValidation =
                shortsScoreLedger.validateScoreLedger(ledger);
            assert.strictEqual(archivedDocumentValidation.valid, true);
            assert.strictEqual(
                archivedDocumentValidation.featureContractDocumentCurrent,
                false
            );
            const record = {
                id,
                savedAt: 1700000000000,
                kind: 'scored',
                score_domain: 'shorts',
                title: 'Historical materialized ledger',
                text: 'Exact historical scalar display',
                hasMontage: false,
                score_ledger: ledger,
                score_record_sha256: '7'.repeat(64),
                score_materialization: {
                    schema:
                        'saved-hook-historical-materialization-v1',
                    role:
                        'historical_evidence_not_live_rescore',
                    ledger_sha256: ledger.ledger_sha256,
                    source_record_sha256: '5'.repeat(64),
                    source_fields: ['features', 'steer'],
                    claim_boundary:
                        'Historical values only; not a current prediction.',
                },
            };
            const legacyRow =
                savedHookRuntimeIndex.legacyRow(record);
            assert(
                legacyRow.historical_display,
                'historical fixture must materialize a bound display'
            );
            const cloud = new MemoryR2({
                [`raw/saved-hooks/${id}.json`]:
                    JSON.stringify(record),
                'raw/saved-hooks/index.json': JSON.stringify(
                    canonicalIndex([], [legacyRow])
                ),
            });
            const runtime = runtimeFor(cloud);
            cloud.resetOperations();
            const reply = await dispatch(
                runtime,
                'GET',
                `/api/raw/saved-hook/${id}`
            );
            assert.strictEqual(reply.status, 200, reply.raw);
            assert.strictEqual(
                reply.json.evidence_state,
                'legacy_unbound_evidence'
            );
            assert.strictEqual(
                reply.json.historical_display_only,
                true
            );
            assert.strictEqual(
                reply.json.score_display_eligible,
                true
            );
            assert.strictEqual(
                reply.json.predictor_eligible,
                false
            );
            assert.strictEqual(
                reply.json.score_ledger_validation.valid,
                true
            );
            assert.strictEqual(
                reply.json.score_ledger_validation
                    .feature_contract_document_current,
                false
            );
            assert.strictEqual(
                reply.json.score_record_validation.valid,
                false,
                'a stale legacy record binding must remain disclosed '
                    + 'without blocking the independently hash-bound '
                    + 'display-only ledger'
            );
            assert.strictEqual(
                reply.json.historical_display.display_sha256,
                legacyRow.historical_display.display_sha256
            );
            assert.strictEqual(cloud.writeCount, 0);
        }
    );

    await test(
        'canonical montage never falls back to a mutable legacy JPEG',
        async () => {
            const fixture = canonicalFixture('hkcanonicalnofallback');
            const withoutReference = mutateCanonicalRecord(
                fixture.record,
                record => {
                    delete record.montage_ref;
                }
            );
            const seed = canonicalSeed(fixture);
            seed[fixture.recordKey] = jsonBuffer(withoutReference);
            seed[`raw/saved-hooks/${fixture.record.id}.jpg`] =
                fixture.mediaBytes;
            const cloud = new MemoryR2(seed);
            const runtime = runtimeFor(cloud);
            cloud.resetOperations();
            const reply = await dispatch(
                runtime,
                'GET',
                `/api/raw/saved-montage/${fixture.record.id}`
            );
            assert.strictEqual(reply.status, 409, reply.raw);
            assert.strictEqual(
                reply.json.code,
                'saved_hook_source_binding_failed'
            );
            assert.ok(
                !cloud.downloads.includes(
                    `raw/saved-hooks/${fixture.record.id}.jpg`
                )
            );
            assert.strictEqual(cloud.writeCount, 0);
        }
    );

    await test(
        'legacy montage is served only as explicitly unbound evidence',
        async () => {
            const id = 'hklegacymontage';
            const legacy = {
                id,
                savedAt: 1,
                title: 'Legacy montage',
                kind: 'scored',
                score_domain: 'shorts',
                hasMontage: true,
            };
            const legacyRow = savedHookRuntimeIndex.legacyRow(legacy);
            const cloud = new MemoryR2({
                [`raw/saved-hooks/${id}.json`]: jsonBuffer(legacy),
                [`raw/saved-hooks/${id}.jpg`]: jpeg('legacy-montage'),
                'raw/saved-hooks/index.json': jsonBuffer(
                    canonicalIndex([], [legacyRow])
                ),
            });
            const runtime = runtimeFor(cloud);
            const reply = await dispatch(
                runtime,
                'GET',
                `/api/raw/saved-montage/${id}`
            );
            assert.strictEqual(reply.status, 200);
            assert.strictEqual(
                reply.headers['x-evidence-state'],
                'legacy-unbound'
            );
            assert.strictEqual(
                reply.headers['cache-control'],
                'public, max-age=3600'
            );
        }
    );

    await test('canonical record tamper yields HTTP 409', async () => {
        const fixture = canonicalFixture('hkcanonicaltamper');
        const tampered = mutateCanonicalRecord(
            fixture.record,
            record => {
                record.score_ledger.entries[0].value += 1;
            }
        );
        const seed = canonicalSeed(fixture);
        seed[fixture.recordKey] = jsonBuffer(tampered);
        const cloud = new MemoryR2(seed);
        const runtime = runtimeFor(cloud);
        cloud.resetOperations();
        const reply = await dispatch(
            runtime,
            'GET',
            `/api/raw/saved-hook/${fixture.record.id}`
        );
        assert.strictEqual(reply.status, 409, reply.raw);
        assert.strictEqual(reply.json.evidence_state, 'canonical_invalid');
        assert.strictEqual(
            reply.json.score_record_validation.valid,
            false
        );
        assert.strictEqual(
            reply.json.score_ledger_validation.valid,
            false
        );
        assert.strictEqual(cloud.writeCount, 0);
    });

    await test(
        'canonical media is content-addressed, immutable, and byte exact',
        async () => {
            const bytes = jpeg('content-addressed');
            const cloud = new MemoryR2();
            const runtime = runtimeFor(cloud);
            const reference = runtime.savedHookMediaReference(bytes);
            const expectedSha = crypto
                .createHash('sha256')
                .update(bytes)
                .digest('hex');
            assert.deepStrictEqual(
                JSON.parse(JSON.stringify(reference)),
                {
                    schema: 'saved-hook-canonical-media-v1',
                    key:
                        'raw/saved-hooks/media/by-sha256/'
                        + `${expectedSha}.jpg`,
                    sha256: expectedSha,
                    byte_length: bytes.length,
                    media_type: 'image/jpeg',
                }
            );
            await runtime.writeImmutableSavedHookMedia(
                reference,
                bytes
            );
            assert.strictEqual(cloud.uploads.length, 1);
            assert.ok(cloud.objects.get(reference.key).equals(bytes));
            const writesAfterFirst = cloud.writeCount;
            await runtime.writeImmutableSavedHookMedia(
                reference,
                bytes
            );
            assert.strictEqual(
                cloud.writeCount,
                writesAfterFirst,
                'an exact immutable object must not be rewritten'
            );
            cloud.objects.set(
                reference.key,
                jpeg('collision-at-same-key')
            );
            await assert.rejects(
                runtime.writeImmutableSavedHookMedia(
                    reference,
                    bytes
                ),
                /content-addressed saved-hook media collision/
            );
        }
    );

    await test(
        'saved scorer revision opens are explicitly historical and read-only',
        async () => {
            const openSavedSource = sourceSlice(
                retentionUiSource,
            'async function openSaved(id, options)',
                'function savedDetail()'
            );
            const resolveSavedSource = sourceSlice(
                retentionUiSource,
                'async function resolveSavedScoreQueueEntry(entry, requestGeneration)',
                'function drainSavedScoreQueue()'
            );
            assert.match(
                retentionUiSource,
                /loaded read-only\. No value was recalculated/
            );
            assert.match(
                resolveSavedSource,
                /exact persisted historical/
            );
            assert.match(
                resolveSavedSource,
                /it was not silently recalculated/
            );
            assert.doesNotMatch(
                openSavedSource + resolveSavedSource,
                /\/api\/raw\/hook-enrich/
            );
            assert.match(
                resolveSavedSource,
                /new transient score for an unscored/
            );
            assert.match(
                resolveSavedSource,
                /original record was not changed/
            );
        }
    );

    const failed = results.filter(result => result.status === 'failed');
    const report = {
        ok: failed.length === 0,
        suite: 'saved-hook-runtime-adversarial-contracts',
        production_sources: [
            path.relative(ROOT, SERVER_PATH),
            path.relative(ROOT, RETENTION_UI_PATH),
        ],
        harness: (
            'Exact saved-hook helpers and route blocks are evaluated in '
            + 'an isolated VM with deterministic in-memory R2; no network '
            + 'listener, credential, or external service is used.'
        ),
        passed: results.length - failed.length,
        failed: failed.length,
        results: results.map(result => ({
            name: result.name,
            status: result.status,
            error: result.error || null,
        })),
        blockers: failed.map(result => ({
            contract: result.name,
            exact_blocker: result.error,
        })),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failed.length) {
        for (const failure of failed) {
            process.stderr.write(
                `\n[${failure.name}]\n${failure.stack}\n`
            );
        }
        process.exitCode = 1;
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
