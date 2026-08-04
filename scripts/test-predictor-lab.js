#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const uiPath = path.join(root, 'buildings', 'jarvis', 'jarvis-retention.js');
const rawEmbedPath = path.join(root, 'raw_embed.py');
const server = fs.readFileSync(serverPath, 'utf8');
const ui = fs.readFileSync(uiPath, 'utf8');
const rawEmbed = fs.readFileSync(rawEmbedPath, 'utf8');
const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);

new vm.Script(server, { filename: serverPath });
new vm.Script(ui, { filename: uiPath });

function includes(source, marker, message) {
    assert(source.includes(marker), message || `missing contract marker: ${marker}`);
}

function matches(source, pattern, message) {
    assert(pattern.test(source), message || `missing contract pattern: ${pattern}`);
}

function extractFunctionDeclaration(name, nextName) {
    const startMarker = `async function ${name}(`;
    const endMarker = `async function ${nextName}(`;
    const start = server.indexOf(startMarker);
    const end = server.indexOf(endMarker, start + startMarker.length);
    assert(start >= 0, `missing server reader: ${name}`);
    assert(end > start, `could not isolate server reader: ${name}`);
    return server.slice(start, end);
}

function extractSyncFunctionDeclaration(name, nextName) {
    const startMarker = `function ${name}(`;
    const endMarker = `async function ${nextName}(`;
    const start = server.indexOf(startMarker);
    const end = server.indexOf(
        endMarker,
        start + startMarker.length
    );
    assert(start >= 0, `missing server function: ${name}`);
    assert(
        end > start,
        `could not isolate server function: ${name}`
    );
    return server.slice(start, end);
}

function createReleaseReaderHarness({
    name,
    nextName,
    globals = {},
}) {
    let manifest = null;
    const sandbox = {
        Buffer,
        require,
        cloud: {
            downloadFromR2: async () => Buffer.from(
                JSON.stringify(manifest),
                'utf8'
            ),
        },
        exactSha256: value => (
            /^[a-f0-9]{64}$/i.test(String(value || ''))
        ),
        savedChannelFeatureContract: {
            version: shortsScoreLedger.FEATURE_CONTRACT.version,
        },
        savedChannelFeatureContractDocumentSha256:
            shortsScoreLedger.FEATURE_CONTRACT_DOCUMENT_SHA256,
        ...globals,
    };
    vm.createContext(sandbox);
    new vm.Script(
        `${extractFunctionDeclaration(name, nextName)}
this.__readerUnderTest = ${name};`,
        { filename: `${serverPath}#${name}` }
    ).runInContext(sandbox);
    return {
        read: () => sandbox.__readerUnderTest(),
        use: value => {
            manifest = value;
        },
    };
}

function distinctSha256(value) {
    const first = value[0] === '0' ? '1' : '0';
    return `${first}${value.slice(1)}`;
}

function releaseComponent(prefix, digit) {
    const artifactSha256 = String(digit).repeat(64);
    return {
        artifactSha256,
        manifestSha256: String((Number(digit) + 3) % 10).repeat(64),
        artifactKey: `${prefix}${artifactSha256}.json`,
        manifestKey: `${prefix}${artifactSha256}.manifest.json`,
    };
}

function verifyPredictorUiProjection() {
    const sandbox = { Buffer };
    vm.createContext(sandbox);
    new vm.Script(
        `${extractSyncFunctionDeclaration(
            'predictorLabUiArtifactBuffer',
            'readVisualKeepReleaseManifest'
        )}
this.__project = predictorLabUiArtifactBuffer;`,
        {
            filename:
                `${serverPath}#predictorLabUiArtifactBuffer`,
        }
    ).runInContext(sandbox);
    const sourceArtifactSha256 = '9'.repeat(64);
    const complete = {
        version: 1,
        provenance: {
            featureContractSha256: '8'.repeat(64),
            publicAxisFitPopulations: {
                ['1'.repeat(64)]: {
                    rowsSha256: '1'.repeat(64),
                    rows: [
                        {
                            id: 'a',
                            channelId: 'UCa',
                            unusedAuditPayload:
                                'x'.repeat(1000),
                        },
                        {
                            id: 'b',
                            channelId: 'UCb',
                            unusedAuditPayload:
                                'y'.repeat(1000),
                        },
                    ],
                },
                ['2'.repeat(64)]: {
                    rowsSha256: '2'.repeat(64),
                    rows: [
                        {
                            id: 'c',
                            channelId: 'UCc',
                            unusedAuditPayload:
                                'z'.repeat(1000),
                        },
                    ],
                },
            },
        },
        targets: {
            keep: {
                metrics: { n: 3, mae: 7.5 },
            },
        },
    };
    const completeBytes = Buffer.from(
        JSON.stringify(complete)
    );
    const projectedBytes = sandbox.__project(
        completeBytes,
        sourceArtifactSha256
    );
    const projected = JSON.parse(
        projectedBytes.toString('utf8')
    );
    assert(
        !projected.provenance.publicAxisFitPopulations,
        'UI projection retained the unused full fit rows'
    );
    assert.strictEqual(
        projected.provenance.publicAxisFitPopulationIndex.length,
        2
    );
    assert.strictEqual(
        projected.transport_projection
            .source_artifact_sha256,
        sourceArtifactSha256
    );
    assert.strictEqual(
        projected.transport_projection
            .omitted_row_references,
        3
    );
    assert.deepStrictEqual(
        projected.targets,
        complete.targets,
        'UI projection changed a numerical predictor output'
    );
    assert(
        complete.provenance.publicAxisFitPopulations,
        'UI projection mutated the complete source artifact'
    );
    assert(
        projectedBytes.length < completeBytes.length,
        'UI projection did not reduce its transport payload'
    );
    return {
        schema:
            projected.transport_projection.schema,
        populationCount:
            projected.transport_projection
                .omitted_population_count,
        rowReferences:
            projected.transport_projection
                .omitted_row_references,
    };
}

async function verifyCurrentContractReleaseReaders() {
    const featureContractVersion = Number(
        shortsScoreLedger.FEATURE_CONTRACT.version
    );
    const featureContractSha256 =
        shortsScoreLedger.FEATURE_CONTRACT_DOCUMENT_SHA256;
    assert(
        Number.isFinite(featureContractVersion),
        'current feature-contract version must be numeric'
    );
    assert(
        /^[a-f0-9]{64}$/.test(featureContractSha256),
        'current feature-contract document SHA must be exact'
    );
    const staleVersion = featureContractVersion + 1;
    const staleSha256 = distinctSha256(featureContractSha256);
    const producerSourceSha256 = 'f'.repeat(64);
    const cases = [
        {
            name: 'readPredictorLabReleaseManifest',
            nextName: 'readPinnedPredictorArtifactBytes',
            globals: {
                PREDICTOR_LAB_RELEASE_KEY:
                    'raw/predictor-lab/release-v1.json',
            },
            validManifest: {
                schemaVersion: 1,
                featureContractVersion,
                featureContractSha256,
                producerSourceSha256,
                predictor: releaseComponent(
                    'raw/predictor-lab/by-sha256/',
                    1
                ),
                visualKeepModel: releaseComponent(
                    'raw/predictor-lab/visual-keep-model/by-sha256/',
                    2
                ),
                creatorAdaptiveKeepModel: releaseComponent(
                    'raw/predictor-lab/creator-adaptive-keep-model/by-sha256/',
                    3
                ),
            },
            failure:
                /atomic release pointer failed integrity validation/,
        },
        {
            name: 'readVisualKeepReleaseManifest',
            nextName: 'readVisualKeepModel',
            globals: {
                VISUAL_KEEP_COORDINATE_ID:
                    'shorts.visual-keep-forecast.test',
                VISUAL_KEEP_MODEL_KEY:
                    'raw/predictor-lab/visual-keep-model-v1.json',
                VISUAL_KEEP_MODEL_MANIFEST_KEY:
                    'raw/predictor-lab/visual-keep-model-v1.manifest.json',
            },
            validManifest: {
                coordinateId:
                    'shorts.visual-keep-forecast.test',
                canonicalKey:
                    'raw/predictor-lab/visual-keep-model-v1.json',
                artifactSha256: '4'.repeat(64),
                archiveKey:
                    `raw/predictor-lab/visual-keep-model/by-sha256/${'4'.repeat(64)}.json`,
                producerSourceSha256,
                featureContractVersion,
                featureContractSha256,
            },
            failure:
                /visual keep model release manifest failed integrity validation/,
        },
        {
            name: 'readCreatorAdaptiveKeepReleaseManifest',
            nextName: 'readCreatorAdaptiveKeepModel',
            globals: {
                CREATOR_ADAPTIVE_KEEP_SCHEMA_VERSION: 3,
                CREATOR_ADAPTIVE_KEEP_COORDINATE_ID:
                    'shorts.creator-adaptive-keep.test',
                CREATOR_ADAPTIVE_KEEP_MODEL_KEY:
                    'raw/predictor-lab/creator-adaptive-keep-model-v1.json',
                CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY:
                    'raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json',
            },
            validManifest: {
                schemaVersion: 3,
                coordinateId:
                    'shorts.creator-adaptive-keep.test',
                canonicalKey:
                    'raw/predictor-lab/creator-adaptive-keep-model-v1.json',
                artifactSha256: '5'.repeat(64),
                archiveKey:
                    `raw/predictor-lab/creator-adaptive-keep-model/by-sha256/${'5'.repeat(64)}.json`,
                producerSourceSha256,
                featureContractVersion,
                featureContractSha256,
            },
            failure:
                /creator-adaptive keep model release manifest failed integrity validation/,
        },
    ];

    for (const testCase of cases) {
        const harness = createReleaseReaderHarness(testCase);
        harness.use(testCase.validManifest);
        await assert.doesNotReject(
            harness.read(),
            `${testCase.name} rejected the current feature contract`
        );
        harness.use({
            ...testCase.validManifest,
            featureContractVersion: staleVersion,
        });
        await assert.rejects(
            harness.read(),
            testCase.failure,
            `${testCase.name} accepted a stale feature-contract version`
        );
        harness.use({
            ...testCase.validManifest,
            featureContractSha256: staleSha256,
        });
        await assert.rejects(
            harness.read(),
            testCase.failure,
            `${testCase.name} accepted a stale feature-contract document SHA`
        );
    }
    return {
        readers: cases.map(testCase => testCase.name),
        featureContractVersion,
        featureContractSha256,
        staleCasesRejected: cases.length * 2,
    };
}

// The result route must serve only the immutable artifact pinned by the
// atomic release. A mutable R2 key or local file must never become a second
// production source of truth. The status route remains operational telemetry.
includes(
    server,
    "if (pathname === '/api/raw/predictor-lab' && req.method === 'GET')",
    'server is missing the Predictor Lab artifact GET route'
);
includes(
    server,
    'async function readPinnedPredictorArtifactBytes(',
    'artifact route is missing the immutable byte verifier'
);
includes(
    server,
    'await readPredictorLabReleaseManifest();',
    'artifact route must resolve the atomic release first'
);
includes(
    server,
    '`immutable:${release.predictor.artifactKey}`',
    'artifact route must cache by immutable content address'
);
includes(
    server,
    'await readPinnedPredictorArtifactBytes(',
    'artifact route must hash-verify the pinned bytes before serving'
);
includes(
    server,
    "'X-Artifact-SHA256':",
    'artifact route must disclose its exact immutable revision'
);
includes(
    server,
    'predictorLabUiArtifactBuffer(',
    'browser route must use the bounded display projection'
);
includes(
    server,
    "'X-Artifact-View':",
    'browser route must disclose that it is a display projection'
);
includes(
    server,
    '${artifactSha256}-predictor-lab-ui-v1',
    'browser projection must have a revision-specific ETag'
);
includes(
    server,
    "'The pinned Predictor Lab release is unavailable.'",
    'artifact route must fail closed when the release cannot be verified'
);
assert(
    !server.includes(
        "serveR2Gz(req, res, 'raw/predictor-lab/results.json', 300e3"
    ),
    'artifact route still accepts the mutable predictor results key'
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
    "const embeddingActive = ['running', 'blocked', 'degraded', 'retrying'].includes(embedding.stage)",
    'status route must distinguish active, blocked, degraded, and retrying embedding jobs'
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

// A spent or throttled embedding request must remain in the resumable queue.
// Progress reports successful durable vectors separately from attempted videos,
// and analysis cannot run while a required visual/together vector is missing.
includes(
    rawEmbed,
    "required_ok = vid in done['visual'] and vid in done['together'] and vid in have_montage",
    'embedding backfill must verify both required vectors before marking a video complete'
);
includes(
    rawEmbed,
    "emit_status('retrying'",
    'embedding backfill must expose unresolved videos as retrying'
);
includes(
    rawEmbed,
    'sys.exit(2)',
    'embedding backfill must return a retryable failure instead of false completion'
);
matches(
    rawEmbed,
    /attempted=cnt\[0\],\s*processed=completed\[0\],\s*failed=fails\[0\]/,
    'embedding status must separate attempts, durable completions, and failures'
);
includes(
    rawEmbed,
    "'credits_or_quota_exhausted'",
    'Gemini quota failures must have a stable machine-readable classification'
);
includes(
    rawEmbed,
    "emit_status('blocked' if blocked else 'degraded'",
    'Gemini provider failures must be published immediately'
);
includes(
    rawEmbed,
    'time.sleep(CREDIT_RETRY_SECONDS)',
    'credit exhaustion must pause the current video instead of consuming the queue'
);
includes(
    rawEmbed,
    'Gemini embedding access restored; resuming automatically from the durable checkpoint.',
    'Gemini recovery must clear the provider warning and announce automatic resume'
);

// Raw Data starts on the existing embedding map and keeps Predictor Lab target
// and point selection as explicit, independent state.
matches(
    ui,
    /rawView:\s*'map'.*rawPredictorTarget:\s*'keep'.*rawPredictorPoint:\s*null/,
    'Raw Data Predictor Lab state defaults are missing'
);
includes(ui, "'/api/raw/predictor-lab',", 'UI does not load the persisted Predictor Lab artifact');
includes(ui, "'/api/raw/predictor-lab/status',", 'UI does not poll Predictor Lab status');
includes(
    ui,
    'Predictor artifact and status belong to different immutable releases.',
    'UI must reject a Predictor artifact/status release mismatch'
);
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
    'Gemini credits or quota exhausted',
    'predictor withheld · fail-closed validation',
    'Descriptive 21-ledger associations · not a views predictor',
]) {
    includes(ui, marker, `Predictor Lab UI is missing visible contract: ${marker}`);
}

verifyCurrentContractReleaseReaders()
    .then(releaseContract => {
        const uiProjection =
            verifyPredictorUiProjection();
        console.log(JSON.stringify({
            ok: true,
            serverRoutes: 2,
            rawTabs: ['map', 'predictor'],
            targets: ['keep', 'views'],
            interactions: [
                'tab',
                'target',
                'point-toggle',
                'point-close',
                'refresh',
            ],
            releaseContract,
            uiProjection,
        }));
    })
    .catch(error => {
        console.error(error.stack || error.message || String(error));
        process.exitCode = 1;
    });
