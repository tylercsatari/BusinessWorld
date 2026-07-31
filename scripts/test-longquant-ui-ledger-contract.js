'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const longScoreLedgerContract = require(
    '../buildings/jarvis/long-score-ledger'
);

const root = path.resolve(__dirname, '..');
const uiPath = path.join(root, 'buildings/jarvis/jarvis-longquant.js');
const source = fs.readFileSync(uiPath, 'utf8');
const serverSource = fs.readFileSync(
    path.join(root, 'server.js'),
    'utf8'
);
const governanceBytes = fs.readFileSync(
    path.join(
        root,
        'buildings/jarvis/quant-coordinate-governance.json'
    )
);
const governance = JSON.parse(governanceBytes.toString('utf8'));
const governanceSha256 = require('node:crypto')
    .createHash('sha256')
    .update(governanceBytes)
    .digest('hex');

assert.doesNotMatch(source, /\.pctile\b/, 'UI must not consume generic pctile aliases');
assert.doesNotMatch(source, /\.reward\b/, 'UI must not consume generic reward aliases');
assert.doesNotMatch(source, /\bscore\.pct\b/, 'UI must not consume generic score.pct aliases');
assert.doesNotMatch(source, /\bbest_pctile\b/, 'UI must not consume best_pctile aliases');
assert.doesNotMatch(source, /\/api\/longquant\/thumbs\/img\//, 'obsolete mutable thumbnail route must not be used');
assert.doesNotMatch(source, /longform\/saved-thumbs\/\$\{[^}]+\}\.jpg/, 'saved thumbnail URLs must not be assembled from record IDs');
assert.doesNotMatch(source, /\brecord\.media\b/, 'legacy record.media must not be a media authority');
assert.match(source, /\brecord\.media_ref\b/, 'validated media_ref must be consumed');
assert.match(source, /unverified\s*[^<\n]*non-rankable/, 'invalid evidence must be labeled non-rankable');

const marker = '    return { mount };';
assert.equal(source.includes(marker), true, 'test export insertion point changed');
const instrumented = source.replace(marker, `    return {
        mount,
        __test: {
            LQ_OUTPUT_CHANNELS,
            LQ_OUTPUT_METRICS,
            LQ_OUTPUT_COORDINATES,
            LQ_METRIC_DEFINITIONS,
            LQ_LEDGER_VERSION,
            LQ_GOVERNANCE_SCHEMA_VERSION,
            LQ_GOVERNANCE_SHA256,
            LQ_PERCENTILE_STORAGE_UNIT,
            LQ_SCORER_SOURCE_SHA256,
            lqxCanonicalJson,
            lqxSha256,
            lqxScoreFromPayload,
            lqxInputState,
            lqxLedgerState,
            lqxRegisteredCoordinate,
            lqxScoreDecisionEligible,
            lqxScoreFor,
            lqxPrimaryPct100,
            lqxDecisionPct100,
            lqxPrimaryAttrs,
            lqxCanonicalThumbDecision,
            lqxSavedMediaRef,
        },
    };`);

const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    __QUANT_COORDINATE_GOVERNANCE__: governance,
    __QUANT_COORDINATE_GOVERNANCE_SHA256__: governanceSha256,
};
vm.runInNewContext(instrumented, sandbox, {
    filename: uiPath,
});
const api = sandbox.module.exports.__test;
assert.ok(api, 'instrumented Long Quant UI test API was not exported');

function sha256(value) {
    return crypto
        .createHash('sha256')
        .update(value)
        .digest('hex');
}

function textRevision(value) {
    const bytes = Buffer.from(String(value || ''), 'utf8');
    return {
        present: bytes.length > 0,
        sha256: sha256(bytes),
        utf8_byte_length: bytes.length,
    };
}

function makeScore(primaryPercentile = 87) {
    const artifactSha = 'a'.repeat(64);
    const manifestSha = 'b'.repeat(64);
    const lineageSha = 'c'.repeat(64);
    const thumbnailBytes = Buffer.from(
        'longquant-ui-ledger-contract-fixture'
    );
    const scoreText = 'Canonical Long Quant UI fixture';
    const queryPayload = {
        schema_version: 2,
        thumbnail: {
            present: true,
            sha256: sha256(thumbnailBytes),
            byte_length: thumbnailBytes.length,
        },
        title: textRevision(scoreText),
        idea: textRevision(scoreText),
        score_text: textRevision(scoreText),
        selected_text_source: 'title',
    };
    const queryInput = {
        ...queryPayload,
        text: queryPayload.score_text,
        generation: 'longquant-query-input-v2',
        fingerprint_sha256: api.lqxSha256(
            api.lqxCanonicalJson(queryPayload)
        ),
        text_source: 'title',
    };
    const entries = api.LQ_OUTPUT_COORDINATES.map((coordinateId, index) => {
        const [, , group, metric] = coordinateId.split('.');
        const provenance = {
            coordinate: coordinateId,
            query_input: queryInput,
        };
        if (coordinateId === 'long.output.visual.ctrviews') {
            provenance.artifact_revision = {
                key: 'longform/thumb-rl/scorer_visual.npz',
                sha256: artifactSha,
                immutable_key: `longform/thumb-rl/by-sha256/${artifactSha}.npz`,
                manifest_key: 'longform/thumb-rl/scorer_visual.manifest.json',
                manifest_sha256: manifestSha,
                immutable_manifest_key: `longform/thumb-rl/by-sha256/${artifactSha}.manifest.json`,
                lineage_schema_version: 1,
                lineage_manifest_sha256: lineageSha,
            };
            provenance.dataset_lineage = {
                lineage_manifest_sha256: lineageSha,
                release_manifest_sha256: manifestSha,
                lineage_manifest: { schemaVersion: 1 },
            };
        }
        return {
            coordinate_id: coordinateId,
            group,
            metric,
            available: true,
            value: index === 0 ? 12.5 : 20 + index,
            percentile: index === 0 ? primaryPercentile : 30 + index,
            kind: 'test-coordinate',
            projection: metric,
            unavailable_reason: null,
            provenance,
        };
    });
    const ledger = {
        schema: 'long-stored-score-ledger-v1',
        schema_version: 1,
        percentile_unit: api.LQ_PERCENTILE_STORAGE_UNIT,
        ledger_version: api.LQ_LEDGER_VERSION,
        governance_schema_version: api.LQ_GOVERNANCE_SCHEMA_VERSION,
        governance_sha256: api.LQ_GOVERNANCE_SHA256,
        entries,
        coordinate_ids: [...api.LQ_OUTPUT_COORDINATES],
        values_by_id: Object.fromEntries(entries.map(entry => [
            entry.coordinate_id,
            entry.value,
        ])),
        percentiles_by_id: Object.fromEntries(entries.map(entry => [
            entry.coordinate_id,
            entry.percentile,
        ])),
        available_count: entries.length,
        expected_count: entries.length,
        schema_complete: true,
        all_values_available: true,
        producer_errors: [],
        contract_valid: true,
    };
    ledger.ledger_sha256 = api.lqxSha256(api.lqxCanonicalJson(ledger));
    const score = {
        long_score_ledger: ledger,
        output_contract: {
            version: 3,
            ledger_version: api.LQ_LEDGER_VERSION,
            percentile_unit: api.LQ_PERCENTILE_STORAGE_UNIT,
            ledger_sha256: ledger.ledger_sha256,
            channels: [...api.LQ_OUTPUT_CHANNELS],
            channel_inputs: {
                visual: 'thumbnail image only',
                text: 'title or idea text only',
                together: 'thumbnail image plus title or idea',
            },
            metrics: [...api.LQ_OUTPUT_METRICS],
            metric_definitions: api.LQ_METRIC_DEFINITIONS.map(item => ({ ...item })),
            coordinates: [...api.LQ_OUTPUT_COORDINATES],
            expected: entries.length,
            available: entries.length,
            unavailable: [],
            producer_errors: [],
            schema_complete: true,
            all_values_available: true,
            complete: true,
            contract_valid: true,
        },
        input_manifest: {
            domain: 'longquant',
            embedding_model: 'gemini-embedding-2',
            embedding_dimensions: 1536,
            scorer: 'longquant_score.py',
            scorer_sha256: api.LQ_SCORER_SOURCE_SHA256,
            display_contract_version: 2,
            coordinate_governance_schema_version:
                api.LQ_GOVERNANCE_SCHEMA_VERSION,
            coordinate_governance_sha256:
                api.LQ_GOVERNANCE_SHA256,
            query_input: queryInput,
            query_input_fingerprint: queryInput.fingerprint_sha256,
            thumbnail_sha256: queryInput.thumbnail.sha256,
            score_text_sha256: queryInput.score_text.sha256,
        },
    };
    Object.defineProperties(score, {
        _fixtureImageData: {
            value: `data:image/jpeg;base64,${
                thumbnailBytes.toString('base64')
            }`,
        },
        _fixtureScoreText: { value: scoreText },
    });
    return score;
}

const score = makeScore(87);
score.reward = -999;
score.pct = 0.01;
score.pctile = 0.02;
score.visual_pctile = 0.03;
assert.equal(api.lqxLedgerState(score).valid, true, 'valid fixture ledger should validate');
assert.equal(
    api.lqxLedgerState(score).predictorEligible,
    true,
    'a complete ledger with valid sidecars should be predictor eligible'
);
assert.equal(api.lqxPrimaryPct100(score), 87, 'legacy aliases must not alter the primary percentile');
const wrapperWarningScore = makeScore(86);
wrapperWarningScore.error = 'stale compatibility wrapper warning';
assert.equal(
    api.lqxLedgerState(wrapperWarningScore).valid,
    true,
    'a wrapper warning must not suppress a self-validating immutable ledger'
);
assert.equal(
    api.lqxPrimaryPct100(wrapperWarningScore),
    86,
    'a wrapper warning must not replace an exact ledger scalar'
);

const readOnlyCacheId = 'read-only-card';
assert.equal(
    api.lqxScoreFor(
        readOnlyCacheId,
        'immutable/card.jpg',
        score._fixtureScoreText,
        '',
        score,
        true,
        score._fixtureImageData
    ),
    score,
    'opening an existing Long score card must return its owned ledger'
);
const mismatchedCardId = 'read-only-card-mismatched-display-text';
assert.equal(
    api.lqxScoreFor(
        mismatchedCardId,
        'immutable/card.jpg',
        'Reconstructed display title that was never scored',
        '',
        score,
        true,
        score._fixtureImageData
    ),
    score,
    'reconstructed display text must not replace the ledger owned by a card'
);
assert.equal(
    api.lqxScoreFor(
        'missing-read-only-card',
        'immutable/missing.jpg',
        'Any display title',
        '',
        null,
        true,
        'data:image/jpeg;base64,bWlzc2luZw=='
    ),
    null,
    'a passive card read must not create a score when persisted evidence is missing'
);
const saveFunctionStart = serverSource.indexOf(
    'async function longQuantSaveThumbRecord(body = {})'
);
const saveFunctionEnd = serverSource.indexOf(
    'async function longQuantBuildThumbGroup',
    saveFunctionStart
);
assert(
    saveFunctionStart >= 0 && saveFunctionEnd > saveFunctionStart,
    'Long saved-thumbnail function boundary changed'
);
const saveFunction = serverSource.slice(
    saveFunctionStart,
    saveFunctionEnd
);
assert.doesNotMatch(
    saveFunction,
    /longQuantScoreThumbnail\s*\(/,
    'saving an existing Long score card must never score it again'
);
assert.match(
    saveFunction,
    /score_ledger_sha256/,
    'Long save must require the exact displayed ledger SHA'
);
assert.match(
    saveFunction,
    /validateLongInputManifest/,
    'Long save must bind the submitted image and text to the score-time input'
);
assert.match(
    saveFunction,
    /silent re-scoring is forbidden/,
    'Long save must fail closed instead of substituting another score'
);
assert.match(
    source,
    /return percentile100 == null\s*\?\s*'Not scored'/,
    'missing Long coordinates must be labeled explicitly instead of rendered as a dash'
);

const primary = api.lqxRegisteredCoordinate(score, 'visual', 'ctrviews');
assert.deepEqual(
    {
        coordinateId: primary.coordinateId,
        value: primary.value,
        valueUnit: primary.valueUnit,
        percentile100: primary.percentile100,
        percentileUnit: primary.percentileUnit,
        ledgerSha256: primary.ledgerSha256,
    },
    {
        coordinateId: 'long.output.visual.ctrviews',
        value: 12.5,
        valueUnit: 'percentile',
        percentile100: 87,
        percentileUnit: 'percentile_0_100',
        ledgerSha256: score.long_score_ledger.ledger_sha256,
    },
    'registered coordinate must expose explicit identity, value, units, and ledger hash'
);
assert.equal(
    primary.predictorEligible,
    true,
    'a canonical registered coordinate should retain decision eligibility'
);
const attrs = api.lqxPrimaryAttrs(score, 'fixture:asset');
assert.match(attrs, /data-coordinate-id="long\.output\.visual\.ctrviews"/);
assert.match(attrs, /data-coordinate-value="12\.5"/);
assert.match(attrs, /data-coordinate-value-unit="percentile"/);
assert.match(attrs, /data-coordinate-percentile-0-100="87"/);
assert.match(attrs, /data-coordinate-percentile-unit="percentile_0_100"/);
assert.match(attrs, /data-coordinate-ledger-sha256="[a-f0-9]{64}"/);

const missingLedger = { pctile: 0.99, reward: 999 };
assert.equal(api.lqxPrimaryPct100(missingLedger), null, 'missing ledger must be non-rankable');
assert.equal(
    api.lqxCanonicalThumbDecision({ score: missingLedger, image: 'legacy.jpg' }, 0, 0).eligible,
    false,
    'legacy aliases must not make a thumbnail eligible'
);

const tampered = makeScore(87);
tampered.long_score_ledger.entries[0].percentile = 99;
tampered.pctile = 0.99;
assert.equal(api.lqxLedgerState(tampered).valid, false, 'tampered ledger must fail validation');
assert.equal(api.lqxPrimaryPct100(tampered), null, 'tampered ledger must be non-rankable');

const withoutOutputContract = makeScore(84);
delete withoutOutputContract.output_contract;
assert.equal(
    api.lqxLedgerState(withoutOutputContract).valid,
    true,
    'a missing output sidecar must not hide a self-validating ledger'
);
assert.equal(
    api.lqxScoreDecisionEligible(withoutOutputContract),
    false,
    'a missing output sidecar must prevent predictor use'
);
assert.equal(
    api.lqxRegisteredCoordinate(
        withoutOutputContract,
        'visual',
        'ctrviews'
    ).value,
    12.5,
    'the exact persisted scalar should remain displayable'
);

const withoutInputManifest = makeScore(82);
delete withoutInputManifest.input_manifest;
const inputlessState = api.lqxLedgerState(withoutInputManifest);
assert.equal(
    inputlessState.valid,
    true,
    'a missing input sidecar must not invalidate ledger content'
);
assert.equal(
    inputlessState.predictorEligible,
    false,
    'a missing input sidecar must prevent predictor use'
);
const inputlessCoordinate = api.lqxRegisteredCoordinate(
    withoutInputManifest,
    'visual',
    'ctrviews'
);
assert.equal(inputlessCoordinate.value, 12.5);
assert.equal(inputlessCoordinate.inputPresent, false);
assert.equal(inputlessCoordinate.predictorEligible, false);
assert.equal(
    api.lqxPrimaryPct100(withoutInputManifest),
    82,
    'an exact persisted scalar remains visible when its input binding is unavailable'
);
assert.equal(
    api.lqxDecisionPct100(withoutInputManifest),
    null,
    'an input-unbound scalar must never be used for ranking or thresholds'
);
assert.equal(
    api.lqxCanonicalThumbDecision({
        score: withoutInputManifest,
        image: 'inputless.jpg',
    }, 0, 0).eligible,
    false,
    'an input-unbound thumbnail must be excluded from every decision surface'
);

const fingerprintOnlyProvenance = makeScore(80);
for (const entry of fingerprintOnlyProvenance.long_score_ledger.entries) {
    entry.provenance.query_input = {
        fingerprint_sha256:
            fingerprintOnlyProvenance.input_manifest
                .query_input_fingerprint,
    };
}
delete fingerprintOnlyProvenance.long_score_ledger.ledger_sha256;
fingerprintOnlyProvenance.long_score_ledger.ledger_sha256 =
    api.lqxSha256(
        api.lqxCanonicalJson(
            fingerprintOnlyProvenance.long_score_ledger
        )
    );
fingerprintOnlyProvenance.output_contract.ledger_sha256 =
    fingerprintOnlyProvenance.long_score_ledger.ledger_sha256;
assert.equal(
    longScoreLedgerContract.validateLongScoreLedger(
        fingerprintOnlyProvenance.long_score_ledger
    ).valid,
    true,
    'canonical ledger validator should accept fingerprint-only provenance'
);
assert.equal(
    longScoreLedgerContract.validateLongInputManifest(
        fingerprintOnlyProvenance
    ).valid,
    true,
    'canonical input validator should accept fingerprint-only provenance'
);
assert.equal(
    api.lqxInputState(fingerprintOnlyProvenance).valid,
    true,
    'browser input validation must match the canonical validator'
);
assert.equal(
    api.lqxLedgerState(fingerprintOnlyProvenance).predictorEligible,
    true,
    'browser decision eligibility must match canonical validation'
);

const outerAuthority = makeScore(78);
const normalizedEnvelope = api.lqxScoreFromPayload({
    score: {
        ...outerAuthority,
        long_score_ledger: null,
        output_contract: null,
        input_manifest: null,
    },
    long_score_ledger: outerAuthority.long_score_ledger,
    output_contract: outerAuthority.output_contract,
    input_manifest: outerAuthority.input_manifest,
});
assert.equal(
    api.lqxLedgerState(normalizedEnvelope).predictorEligible,
    true,
    'valid envelope sidecars must override nested null compatibility copies'
);
assert.equal(
    api.lqxRegisteredCoordinate(
        normalizedEnvelope,
        'visual',
        'ctrviews'
    ).percentile100,
    78,
    'envelope normalization must preserve the exact coordinate'
);

const mediaSha = 'd'.repeat(64);
const validMediaRecord = {
    integrity: {
        valid: true,
        thumbnail_sha256: mediaSha,
    },
    media_ref: {
        url: `https://cdn.example.test/longquant/${mediaSha}.jpg`,
        key: `longform/saved-thumbs/media/by-sha256/${mediaSha}.jpg`,
        thumbnail_sha256: mediaSha,
        byte_length: 1234,
        media_type: 'image/jpeg',
    },
};
assert.equal(
    api.lqxSavedMediaRef(validMediaRecord).url,
    validMediaRecord.media_ref.url,
    'validated content-addressed media_ref should be accepted'
);
assert.equal(
    api.lqxSavedMediaRef({
        integrity: validMediaRecord.integrity,
        media: validMediaRecord.media_ref.url,
    }),
    null,
    'legacy media field must never be a fallback'
);
assert.equal(
    api.lqxSavedMediaRef({
        integrity: validMediaRecord.integrity,
        media_ref: `/api/longquant/thumbs/img/legacy-id?sha=${mediaSha}`,
    }),
    null,
    'obsolete mutable API route must be rejected'
);
assert.equal(
    api.lqxSavedMediaRef({
        integrity: validMediaRecord.integrity,
        media_ref: `/longform/saved-thumbs/legacy-id.jpg?sha=${mediaSha}`,
    }),
    null,
    'obsolete mutable saved-thumbnail path must be rejected'
);
assert.equal(
    api.lqxSavedMediaRef({
        integrity: validMediaRecord.integrity,
        media_ref: {
            ...validMediaRecord.media_ref,
            thumbnail_sha256: 'e'.repeat(64),
        },
    }),
    null,
    'media_ref with mismatched content hash must be rejected'
);

console.log('longquant UI ledger contract: ok');
