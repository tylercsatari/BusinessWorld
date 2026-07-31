'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const shortsLedger = require('./shorts-score-ledger');
const longLedger = require('./long-score-ledger');
const governanceBytes = fs.readFileSync(
    path.join(__dirname, 'quant-coordinate-governance.json')
);
const governance = JSON.parse(governanceBytes);
const governanceSha256 = crypto
    .createHash('sha256')
    .update(governanceBytes)
    .digest('hex');
const shortsBrowserRuntime = {
    schema: 'shorts-score-ledger-browser-runtime-v1',
    schemaVersion: 1,
    ledgerSchema: 'shorts-stored-score-ledger-v1',
    ledgerSchemaVersion: 1,
    ledgerVersion: shortsLedger.GOVERNANCE.ledgerVersion,
    percentileUnit: shortsLedger.GOVERNANCE.percentileStorageUnit,
    featureIdentitySchemaVersion:
        shortsLedger.FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
    featureContractSha256: shortsLedger.FEATURE_CONTRACT_SHA256,
    featureContractDocumentSha256:
        shortsLedger.FEATURE_CONTRACT_DOCUMENT_SHA256,
    governanceVersion: shortsLedger.GOVERNANCE.schemaVersion,
    governanceSha256: shortsLedger.GOVERNANCE_SHA256,
    expectedCoordinateIds: shortsLedger.EXPECTED_COORDINATE_IDS,
    unitBounds: Object.fromEntries(
        Object.entries(shortsLedger.GOVERNANCE.valueUnits)
            .map(([unit, definition]) => [unit, {
                min: definition.minimumInclusive,
                max: definition.maximumInclusive,
            }])
    ),
    definitions: shortsLedger.FEATURE_DEFINITIONS.map(
        definition => ({
            coordinateId: definition.coordinateId,
            featureKey: definition.key,
            group: definition.group,
            target: definition.target,
            source: definition.source,
            sourceKey: definition.sourceKey || definition.key,
            unit: definition.unit,
            displayUnit: definition.displayUnit ?? null,
        })
    ),
};

function loadUi(file, marker, replacement, globals = {}) {
    const source = fs.readFileSync(file, 'utf8');
    assert(source.includes(marker), `${path.basename(file)} test marker moved`);
    const window = {
        addEventListener: () => {},
        removeEventListener: () => {},
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval,
        innerWidth: 1280,
        document: {
            addEventListener: () => {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
        },
    };
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        window,
        document: window.document,
        ...globals,
    };
    vm.runInNewContext(source.replace(marker, replacement), sandbox, {
        filename: file,
    });
    return { api: sandbox.module.exports.__test, source };
}

function shortsValue(definition, index) {
    if (definition.unit === 'views') return 1_000_000 + index;
    if (definition.unit === 'probability') return 0.2 + index / 100;
    if (definition.unit === 'number') return 2 + index / 10;
    if (definition.unit === 'log10_views') return 6 + index / 100;
    return 60 + index;
}

const shortsRecord = {
    features: Object.fromEntries(
        shortsLedger.FEATURE_DEFINITIONS.map((definition, index) => [
            definition.key,
            [shortsValue(definition, index), 70 + index],
        ])
    ),
};
shortsRecord.score_ledger =
    shortsLedger.materializeHistoricalScoreLedger(shortsRecord);
shortsRecord.score_ledger_validation = {
    valid: true,
    ledger_sha256: shortsRecord.score_ledger.ledger_sha256,
};
shortsRecord.input_manifest = {
    domain: 'shorts_raw',
    channels: {
        visual: {
            present: true,
            input: 'first-five-second five-frame montage only',
        },
        text: {
            present: true,
            input: 'first-five-second transcript only',
        },
        together: {
            present: true,
            input: 'first-five-second montage plus transcript',
        },
    },
};
shortsRecord.steer = {
    visual_keep: { est: 1, pctile: 1 },
};
shortsRecord.non_authoritative_geometry = {
    schema: 'shorts-geometry-v1',
    authority: 'non_authoritative_visualization_only',
    scalar_score_use: 'forbidden',
    channels: {
        visual: {
            metrics: {
                keep: { est: 999, pctile: 99 },
            },
            neighbors: [{ id: 'geometry-only', sim: 1 }],
        },
    },
};

const shortsUi = loadUi(
    path.join(__dirname, 'jarvis-retention.js'),
    `    return {
        mount,
        mountExperiment,
        unmountExperiment,
        getExperimentContext: () => LAB_CONTEXT,
        __st: () => st,
    };`,
    `    return {
        mount,
        mountExperiment,
        unmountExperiment,
        getExperimentContext: () => LAB_CONTEXT,
        __st: () => st,
        __test: {
            embeddingIdentityAttrs,
            shortsGeometryChannel,
            shortsGrindVerifiedScore,
            shortsLedgerState,
            shortsRegisteredCoordinate,
            steerOf,
        },
    };`,
    {
        __SHORTS_SCORE_LEDGER_RUNTIME__: shortsBrowserRuntime,
    }
);
const shortsApi = shortsUi.api;
const shortsCoordinate = shortsApi.shortsRegisteredCoordinate(
    shortsRecord,
    'shorts.stored.visual.keep'
);
assert.equal(shortsCoordinate.value, shortsRecord.score_ledger.values_by_id[
    'shorts.stored.visual.keep'
]);
assert.equal(shortsCoordinate.valueUnit, 'percent');
assert.equal(shortsCoordinate.target, 'keep');
assert.equal(shortsCoordinate.modality, 'visual');
assert.equal(
    shortsCoordinate.ledgerSha256,
    shortsRecord.score_ledger.ledger_sha256
);
assert.notEqual(shortsCoordinate.value, 999);
const shortsAttrs = shortsApi.embeddingIdentityAttrs(
    shortsCoordinate,
    'shorts-fixture'
);
for (const required of [
    'data-embedding-authority="canonical-ledger-coordinate"',
    'data-coordinate-id="shorts.stored.visual.keep"',
    'data-coordinate-ledger-sha256="',
    'data-coordinate-value-unit="percent"',
    'data-coordinate-target="keep"',
    'data-coordinate-modality="visual"',
    'data-coordinate-input="first-five-second five-frame montage only"',
]) assert.match(shortsAttrs, new RegExp(required.replace('.', '\\.')));
assert.equal(
    shortsApi.shortsGeometryChannel(shortsRecord, 'visual')
        .metrics.keep.est,
    999
);
assert.equal(
    shortsApi.shortsRegisteredCoordinate(
        { non_authoritative_geometry: shortsRecord.non_authoritative_geometry },
        'shorts.stored.visual.keep'
    ),
    null
);
const shortsTampered = structuredClone(shortsRecord);
shortsTampered.score_ledger.entries[0].value = 99;
assert.equal(shortsApi.shortsLedgerState(shortsTampered).valid, false);
assert.equal(
    shortsApi.shortsRegisteredCoordinate(
        shortsTampered,
        'shorts.stored.visual.keep'
    ),
    null
);
assert.equal(
    shortsApi.shortsGrindVerifiedScore({
        score_verified: true,
        score_coordinate_id: 'legacy.keep',
        score_ledger_sha256: 'a'.repeat(64),
        score_value: 80,
        score_percentile_0_100: 80,
    }),
    null
);

function textRevision(value) {
    const bytes = Buffer.from(String(value || ''), 'utf8');
    return {
        present: bytes.length > 0,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        utf8_byte_length: bytes.length,
    };
}

function longScore() {
    const image = Buffer.from('long-ui-provenance-fixture');
    const queryPayload = {
        schema_version: 2,
        thumbnail: {
            present: true,
            sha256: crypto.createHash('sha256').update(image).digest('hex'),
            byte_length: image.length,
        },
        title: textRevision('Canonical title'),
        idea: textRevision(''),
        score_text: textRevision('Canonical title'),
        selected_text_source: 'title',
    };
    const queryInput = {
        ...queryPayload,
        text: queryPayload.score_text,
        generation: 'longquant-query-input-v2',
        fingerprint_sha256: shortsLedger.sha256Canonical(queryPayload),
        text_source: 'title',
    };
    const entries = longLedger.OUTPUT_COORDINATES.map((coordinate, index) => {
        const [, , group, metric] = coordinate.split('.');
        const definition = longLedger.METRIC_DEFINITIONS.find(
            candidate => candidate.key === metric
        );
        const value = metric === 'views' || metric === 'realviews'
            ? 1_000_000 + index
            : metric === 'gt10m'
                ? 0.5
                : 50 + index;
        const provenance = {
            coordinate,
            query_input: queryInput,
        };
        if (coordinate === 'long.output.visual.ctrviews') {
            const artifact = 'a'.repeat(64);
            const manifest = 'b'.repeat(64);
            const lineage = 'c'.repeat(64);
            provenance.artifact_revision = {
                key: longLedger.VISUAL_CTRVIEWS_ARTIFACT_KEY,
                sha256: artifact,
                immutable_key:
                    `${longLedger.VISUAL_CTRVIEWS_ARCHIVE_PREFIX}/${artifact}.npz`,
                manifest_key: longLedger.VISUAL_CTRVIEWS_MANIFEST_KEY,
                manifest_sha256: manifest,
                immutable_manifest_key:
                    `${longLedger.VISUAL_CTRVIEWS_ARCHIVE_PREFIX}/${artifact}.manifest.json`,
                lineage_schema_version: 1,
                lineage_manifest_sha256: lineage,
            };
            provenance.dataset_lineage = {
                lineage_manifest_sha256: lineage,
                release_manifest_sha256: manifest,
                lineage_manifest: { schemaVersion: 1 },
            };
        }
        return {
            coordinate_id: coordinate,
            group,
            metric,
            available: true,
            value,
            percentile: 60 + index,
            kind: 'fixture',
            projection: definition.projectionKey,
            unavailable_reason: null,
            provenance,
        };
    });
    const ledger = {
        schema: 'long-stored-score-ledger-v1',
        schema_version: 1,
        percentile_unit: longLedger.PERCENTILE_STORAGE_UNIT,
        ledger_version: governance.ledgerVersion,
        governance_schema_version: governance.schemaVersion,
        governance_sha256: governanceSha256,
        entries,
        coordinate_ids: [...longLedger.OUTPUT_COORDINATES],
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
    ledger.ledger_sha256 = shortsLedger.sha256Canonical(ledger);
    return {
        input_manifest: {
            domain: 'longquant',
            embedding_model: 'gemini-embedding-2',
            scorer: 'longquant_score.py',
            query_input: queryInput,
            query_input_fingerprint: queryInput.fingerprint_sha256,
            thumbnail_sha256: queryInput.thumbnail.sha256,
            score_text_sha256: queryInput.score_text.sha256,
        },
        long_score_ledger: ledger,
        output_contract: longLedger.longOutputContract(ledger),
        non_authoritative_geometry: {
            schema: 'long-saved-thumbnail-geometry-v1',
            authority: 'non_authoritative_visualization_only',
            scalar_score_use: 'forbidden',
            channels: {
                visual: {
                    neighbors: [{ id: 'geometry-only', sim: 1 }],
                    map_placements: {
                        ctrviews: {
                            axis_x: 500,
                            kind: 'map-placement-only',
                            provenance: {
                                coordinate:
                                    'long.map-placement.visual.ctrviews',
                            },
                        },
                    },
                },
            },
        },
        channels: {
            visual: {
                metrics: {
                    ctrviews: { value: -999, percentile: 1 },
                },
            },
        },
    };
}

const longUi = loadUi(
    path.join(__dirname, 'jarvis-longquant.js'),
    '    return { mount };',
    `    return {
        mount,
        __test: {
            lqxEmbeddingAttrs,
            lqxInputManifest,
            lqxLedgerState,
            lqxRegisteredCoordinate,
            lqxRegisteredMapPlacement,
        },
    };`,
    {
        __QUANT_COORDINATE_GOVERNANCE__: governance,
        __QUANT_COORDINATE_GOVERNANCE_SHA256__: governanceSha256,
    }
);
const longApi = longUi.api;
const longRecord = longScore();
const longCoordinate = longApi.lqxRegisteredCoordinate(
    longRecord,
    'visual',
    'ctrviews'
);
assert.equal(longCoordinate.value, 50);
assert.equal(longCoordinate.valueUnit, 'percentile');
assert.equal(longCoordinate.target, 'ctrviews');
assert.equal(longCoordinate.modality, 'visual');
assert.match(longCoordinate.input, /thumbnail sha256 [a-f0-9]{64}/);
assert.notEqual(longCoordinate.value, -999);
const longAttrs = longApi.lqxEmbeddingAttrs(
    longRecord,
    'visual',
    'ctrviews',
    longCoordinate,
    'canonical-scalar-output',
    'long-fixture'
);
for (const required of [
    'data-embedding-authority="canonical-ledger-coordinate"',
    'data-coordinate-id="long.output.visual.ctrviews"',
    'data-coordinate-ledger-sha256="',
    'data-coordinate-value-unit="percentile"',
    'data-coordinate-target="ctrviews"',
    'data-coordinate-modality="visual"',
    'data-coordinate-input="thumbnail image bytes only;',
]) assert.match(longAttrs, new RegExp(required.replace('.', '\\.')));
const placement = longApi.lqxRegisteredMapPlacement(
    longRecord,
    'visual',
    'ctrviews'
);
assert.equal(placement.value, null);
assert.equal(placement.ledgerSha256, null);
const longTamperedInput = structuredClone(longRecord);
longTamperedInput.input_manifest.query_input.selected_text_source = 'idea';
assert.equal(longApi.lqxLedgerState(longTamperedInput).valid, false);
assert.equal(
    longApi.lqxRegisteredCoordinate(
        longTamperedInput,
        'visual',
        'ctrviews'
    ),
    null
);
assert.equal(
    longApi.lqxRegisteredCoordinate(
        { non_authoritative_geometry: longRecord.non_authoritative_geometry },
        'visual',
        'ctrviews'
    ),
    null
);
const inferred = longApi.lqxInputManifest({
    title: 'This must not become score provenance',
});
assert.equal(inferred.valid, false);
assert.equal(inferred.channels.text.present, false);

assert.doesNotMatch(
    longUi.source,
    /registeredCoordinates\s*:/,
    'Long raw records must not duplicate canonical scalar coordinates'
);
assert.match(
    longUi.source,
    /scalar_score_use\s*!==\s*'forbidden'/,
    'Long geometry adapter must reject scalar use'
);

console.log(JSON.stringify({
    ok: true,
    shortsCoordinate: shortsCoordinate.coordinateId,
    shortsLedgerSha256: shortsCoordinate.ledgerSha256,
    longCoordinate: longCoordinate.coordinateId,
    longLedgerSha256: longCoordinate.ledgerSha256,
}, null, 2));
