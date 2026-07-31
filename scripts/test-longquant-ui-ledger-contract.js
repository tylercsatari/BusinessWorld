'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const uiPath = path.join(root, 'buildings/jarvis/jarvis-longquant.js');
const source = fs.readFileSync(uiPath, 'utf8');
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
            lqxCanonicalJson,
            lqxSha256,
            lqxLedgerState,
            lqxRegisteredCoordinate,
            lqxPrimaryPct100,
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
        idea: textRevision(''),
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
    return {
        long_score_ledger: ledger,
        output_contract: {
            version: 3,
            ledger_version: api.LQ_LEDGER_VERSION,
            percentile_unit: api.LQ_PERCENTILE_STORAGE_UNIT,
            ledger_sha256: ledger.ledger_sha256,
            channels: [...api.LQ_OUTPUT_CHANNELS],
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
            embedding_model: 'fixture',
            scorer: 'fixture',
            query_input: queryInput,
            query_input_fingerprint: queryInput.fingerprint_sha256,
            thumbnail_sha256: queryInput.thumbnail.sha256,
            score_text_sha256: queryInput.score_text.sha256,
        },
    };
}

const score = makeScore(87);
score.reward = -999;
score.pct = 0.01;
score.pctile = 0.02;
score.visual_pctile = 0.03;
assert.equal(api.lqxLedgerState(score).valid, true, 'valid fixture ledger should validate');
assert.equal(api.lqxPrimaryPct100(score), 87, 'legacy aliases must not alter the primary percentile');

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
