'use strict';

const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const longSourcePath = path.join(
    root,
    'buildings',
    'jarvis',
    'jarvis-longquant.js'
);
const governancePath = path.join(
    root,
    'buildings',
    'jarvis',
    'quant-coordinate-governance.json'
);
const source = fs.readFileSync(longSourcePath, 'utf8');
const governanceBytes = fs.readFileSync(governancePath);
const governance = JSON.parse(governanceBytes);
const governanceSha256 = crypto
    .createHash('sha256')
    .update(governanceBytes)
    .digest('hex');
const {
    METRIC_DEFINITIONS,
    OUTPUT_CHANNELS,
    OUTPUT_COORDINATES,
    OUTPUT_METRICS,
    longOutputContract,
    validateLongScoreLedger,
} = require('../buildings/jarvis/long-score-ledger');
const {
    canonicalJson,
    sha256Canonical,
} = require('../buildings/jarvis/shorts-score-ledger');

const governedChannels = governance.expansions.longGroups;
const governedMetricDefinitions = governance.expansions.longMetrics;
const governedMetrics = governedMetricDefinitions.map(
    definition => definition.key
);
const governedCoordinates = governedChannels.flatMap(channel => (
    governedMetrics.map(metric => (
        governance.coordinates.longOutputPattern
            .replace('{group}', channel)
            .replace('{metricKey}', metric)
    ))
));

assert.equal(
    governedChannels.length * governedMetrics.length,
    21,
    'Long governance must define exactly 3 channels x 7 metrics'
);
assert.deepEqual(
    [...OUTPUT_CHANNELS],
    governedChannels,
    'server Long channel inventory drifted from governance'
);
assert.deepEqual(
    [...OUTPUT_METRICS],
    governedMetrics,
    'server Long metric inventory drifted from governance'
);
assert.deepEqual(
    [...OUTPUT_COORDINATES],
    governedCoordinates,
    'server Long coordinate inventory drifted from governance'
);
assert.deepEqual(
    METRIC_DEFINITIONS.map(definition => ({ ...definition })),
    governedMetricDefinitions,
    'server Long metric definitions drifted from governance'
);
assert.equal(
    new Set(governedCoordinates).size,
    21,
    'Long governance contains duplicate coordinate IDs'
);
assert.equal(
    source.includes('function lqxNormalizeScore'),
    false,
    'deleted Long compatibility normalizer was reintroduced'
);
assert(
    source.includes('globalThis.__QUANT_COORDINATE_GOVERNANCE__')
        && source.includes(
            'globalThis.__QUANT_COORDINATE_GOVERNANCE_SHA256__'
        ),
    'Long UI no longer consumes the served governance document and its hash'
);

const projection = {
    x: [100, 500, 900],
    y: [120, 520, 920],
    est: [1, 2, 3],
};
const rawChannel = {
    n: 3,
    id: ['a', 'b', 'c'],
    views: [100, 1_000, 10_000],
    proj: Object.fromEntries(
        governedMetricDefinitions.map(definition => [
            definition.projectionKey,
            {
                x: projection.x,
                y: projection.y,
                est: projection.est,
            },
        ])
    ),
};
const compactPlots = Object.fromEntries(
    governedMetricDefinitions.map((definition, index) => [
        definition.projectionKey,
        {
            points: [[100, 120, 1], [500, 520, 2], [900, 920, 3]],
            zMin: 1,
            zMax: 3,
            colorKind: definition.projectionKey === 'hi10m'
                ? 'binary'
                : 'metric',
            marker: {
                x: 350 + index,
                y: 450,
                percentile: 61 + index,
            },
        },
    ])
);
const compactBundle = { n: 3, plots: compactPlots };

const context = {
    __QUANT_COORDINATE_GOVERNANCE__: governance,
    __QUANT_COORDINATE_GOVERNANCE_SHA256__: governanceSha256,
    RAW: Object.fromEntries(
        governedChannels.map(channel => [channel, rawChannel])
    ),
    LQGRAPHHTML: {},
    C: {
        accent: '#08f',
        amber: '#f59e0b',
        border: '#333',
        card: '#111',
        card2: '#222',
        dim: '#999',
        faint: '#666',
        green: '#0c8',
        mute: '#888',
        purple: '#a78bfa',
        red: '#f87171',
        text: '#eee',
    },
    esc: value => String(value == null ? '' : value),
    lqxEmbeddingAttrs: (
        score,
        channel,
        metric,
        coordinate,
        origin,
        assetId
    ) => [
        `data-coordinate-id="${coordinate.coordinateId}"`,
        `data-embedding-asset="${assetId || ''}"`,
        `data-embedding-origin="${origin}"`,
        `data-embedding-source-key="${channel}_${metric}"`,
        `data-embedding-est="${coordinate.value}"`,
        `data-embedding-percentile="${coordinate.percentile100}"`,
    ].join(' ').replace(/^/, ' '),
    lqxPlotEnsure: () => compactBundle,
    lqxPlotFor: () => compactBundle,
    rawRamp: () => '#38bdf8',
};
vm.createContext(context);

const helperStart = source.indexOf('const LQ_GOVERNANCE_RUNTIME');
const helperEnd = source.indexOf(
    'function lqxCanonicalThumbDecision',
    helperStart
);
const geometryStart = source.indexOf(
    'function lqxGeometryChannels'
);
const geometryEnd = source.indexOf(
    'function lqxPlotKey',
    geometryStart
);
assert(
    helperStart >= 0 && helperEnd > helperStart,
    'current Long canonical graph helpers were not found'
);
assert(
    geometryStart >= 0 && geometryEnd > geometryStart,
    'current Long geometry-only helpers were not found'
);
vm.runInContext(
    source.slice(geometryStart, geometryEnd)
        + source.slice(helperStart, helperEnd)
        + `
this.graphApi = {
    LQ_COMPARE_METRICS,
    LQ_GOVERNANCE_SHA256,
    LQ_OUTPUT_CHANNELS,
    LQ_OUTPUT_COORDINATES,
    LQ_OUTPUT_METRICS,
    lqxCanonicalJson,
    lqxChannelMetricHtml,
    lqxGraphGrid,
    lqxHasCanonicalLedger,
    lqxLedgerState,
    lqxMetricOrigin,
    lqxPrimaryMetric,
    lqxPrimaryPct01,
    lqxGeometryChannel,
    lqxGeometryChannels,
    lqxRegisteredCoordinate,
    lqxRegisteredMapPlacement,
    lqxSha256,
    lqxStoredOutputCount,
};`,
    context
);
const api = context.graphApi;

assert.deepEqual(
    Array.from(api.LQ_OUTPUT_CHANNELS),
    governedChannels,
    'browser Long channel inventory drifted from governance'
);
assert.deepEqual(
    Array.from(api.LQ_OUTPUT_METRICS),
    governedMetrics,
    'browser Long metric inventory drifted from governance'
);
assert.deepEqual(
    Array.from(api.LQ_OUTPUT_COORDINATES),
    governedCoordinates,
    'browser Long coordinate inventory drifted from governance'
);
assert.equal(
    api.LQ_GOVERNANCE_SHA256,
    governanceSha256,
    'browser Long governance hash is not the canonical document hash'
);

const artifactSha256 = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const lineageSha256 = 'c'.repeat(64);
function releaseProvenance() {
    return {
        artifact_revision: {
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
        },
        dataset_lineage: {
            lineage_manifest_sha256: lineageSha256,
            release_manifest_sha256: manifestSha256,
            lineage_manifest: { schemaVersion: 1 },
        },
    };
}

function scalarValue(metric, ordinal) {
    if (metric === 'views' || metric === 'realviews') {
        return 1_000_000 + ordinal * 100_000;
    }
    if (metric === 'scaled_views') return 1.5 + ordinal / 10;
    if (metric === 'gt10m') return 0.1 + ordinal / 100;
    return 50 + ordinal;
}

function textInputRevision(value) {
    const bytes = Buffer.from(String(value || ''), 'utf8');
    return {
        present: bytes.length > 0,
        sha256: crypto
            .createHash('sha256')
            .update(bytes)
            .digest('hex'),
        utf8_byte_length: bytes.length,
    };
}

function buildScore(availableCoordinates = new Set(governedCoordinates)) {
    const thumbnailBytes = Buffer.from(
        'longquant-channel-graph-fixture'
    );
    const scoreText = 'Canonical channel graph fixture';
    const queryPayload = {
        schema_version: 2,
        thumbnail: {
            present: true,
            sha256: crypto
                .createHash('sha256')
                .update(thumbnailBytes)
                .digest('hex'),
            byte_length: thumbnailBytes.length,
        },
        title: textInputRevision(scoreText),
        idea: textInputRevision(''),
        score_text: textInputRevision(scoreText),
        selected_text_source: 'title',
    };
    const queryInput = {
        ...queryPayload,
        text: queryPayload.score_text,
        generation: 'longquant-query-input-v2',
        fingerprint_sha256: sha256Canonical(queryPayload),
        text_source: 'title',
    };
    const channels = Object.fromEntries(
        governedChannels.map(channel => [
            channel,
            {
                metrics: {},
                map_placements: Object.fromEntries(
                    governedMetricDefinitions.map((definition, index) => [
                        definition.key,
                        {
                            axis_x: 200 + index * 10,
                            kind: 'neighbor_axis_percentile',
                            projection: definition.projectionKey,
                            provenance: {
                                coordinate:
                                    `long.map-placement.${channel}.${definition.projectionKey}`,
                            },
                        },
                    ])
                ),
                neighbors: [{ id: 'neighbor', sim: 0.9 }],
            },
        ])
    );
    const entries = governedCoordinates.map((coordinate, ordinal) => {
        const [, , channel, metric] = coordinate.split('.');
        const available = availableCoordinates.has(coordinate);
        const definition = governedMetricDefinitions.find(
            candidate => candidate.key === metric
        );
        return {
            coordinate_id: coordinate,
            group: channel,
            metric,
            available,
            value: available ? scalarValue(metric, ordinal) : null,
            percentile: available ? 55 + ordinal : null,
            kind: available ? 'fixture-scalar' : null,
            projection: definition.projectionKey,
            unavailable_reason: available
                ? null
                : 'scalar_estimate_not_materialized',
            provenance: available
                ? {
                    coordinate,
                    query_input: queryInput,
                    ...(
                        coordinate === 'long.output.visual.ctrviews'
                            ? releaseProvenance()
                            : {}
                    ),
                }
                : null,
        };
    });
    const ledger = {
        schema: 'long-stored-score-ledger-v1',
        schema_version: 1,
        percentile_unit: governance.percentileStorageUnit,
        ledger_version: governance.ledgerVersion,
        governance_schema_version: governance.schemaVersion,
        governance_sha256: governanceSha256,
        entries,
        coordinate_ids: [...governedCoordinates],
        values_by_id: Object.fromEntries(
            entries.map(entry => [entry.coordinate_id, entry.value])
        ),
        percentiles_by_id: Object.fromEntries(
            entries.map(entry => [entry.coordinate_id, entry.percentile])
        ),
        expected_count: governedCoordinates.length,
        schema_complete: true,
        available_count: entries.filter(entry => entry.available).length,
        all_values_available: entries.every(entry => entry.available),
        producer_errors: [],
        contract_valid: true,
    };
    ledger.ledger_sha256 = sha256Canonical(ledger);
    const validation = validateLongScoreLedger(ledger);
    assert.deepEqual(
        validation.errors,
        [],
        `fixture ledger must satisfy the production contract: ${validation.errors.join(', ')}`
    );
    return {
        non_authoritative_geometry: {
            schema: 'long-saved-thumbnail-geometry-v1',
            authority: 'non_authoritative_visualization_only',
            scalar_score_use: 'forbidden',
            channels,
        },
        channels: JSON.parse(JSON.stringify(channels)),
        long_score_ledger: ledger,
        output_contract: longOutputContract(ledger),
        input_manifest: {
            domain: 'longquant',
            embedding_model: 'fixture',
            scorer: 'fixture',
            query_input: queryInput,
            query_input_fingerprint:
                queryInput.fingerprint_sha256,
            thumbnail_sha256:
                queryInput.thumbnail.sha256,
            score_text_sha256:
                queryInput.score_text.sha256,
        },
        scoreWarning:
            `${validation.availableCount}/21 scalar values are materialized`,
    };
}

const partialInventory = new Set([
    ...governedCoordinates.filter(coordinate => (
        coordinate.startsWith('long.output.visual.')
    )),
    'long.output.text.views',
    'long.output.together.views',
    'long.output.together.gt10m',
]);
assert.equal(
    partialInventory.size,
    10,
    'partial fixture no longer contains the intended ten scalars'
);
const partialScore = buildScore(partialInventory);

// A mutable browser cache is deliberately contradictory. It must never override
// the bound ledger or fill an unavailable scalar from map geometry.
partialScore.channels.visual.metrics.ctrviews = {
    value: -999,
    percentile: 1,
};
partialScore.channels.text.metrics.ctr = {
    value: 99,
    percentile: 99,
};

const partialState = api.lqxLedgerState(partialScore);
assert.equal(partialState.valid, true);
assert.equal(partialState.available, 10);
assert.equal(api.lqxStoredOutputCount(partialScore), 10);
assert.equal(api.lqxHasCanonicalLedger(partialScore), true);
assert.equal(
    api.lqxRegisteredCoordinate(
        partialScore,
        'visual',
        'ctrviews'
    ).value,
    partialScore.long_score_ledger
        .values_by_id['long.output.visual.ctrviews'],
    'browser cache overrode the canonical Long ledger'
);
assert.equal(
    api.lqxRegisteredCoordinate(partialScore, 'text', 'ctr'),
    null,
    'unavailable scalar was reconstructed from a browser cache'
);
assert.equal(
    api.lqxMetricOrigin(partialScore, 'text', 'ctr'),
    'unavailable',
    'unavailable scalar received a misleading origin'
);
assert.equal(
    api.lqxRegisteredMapPlacement(
        partialScore,
        'text',
        'ctr'
    ).coordinateId,
    'long.map-placement.text.ctr',
    'separate governed map geometry was not retained'
);

const summary = api.lqxChannelMetricHtml(
    partialScore,
    false,
    'fixture-thumb'
);
const compactSummary = api.lqxChannelMetricHtml(
    partialScore,
    true,
    'fixture-thumb'
);
const graphHtml = api.lqxGraphGrid(partialScore, 'fixture-thumb');
for (const channel of governedChannels) {
    assert.equal(
        (graphHtml.match(
            new RegExp(`data-lqxrawchan="${channel}"`, 'g')
        ) || []).length,
        7,
        `${channel} did not render all seven governed graph addresses`
    );
}
assert.equal(
    (graphHtml.match(/data-compact-quant-plot=/g) || []).length,
    21,
    'Long graph grid did not render the governed 21-coordinate inventory'
);
assert.equal(
    (summary.match(/data-coordinate-id="long\.output\./g) || []).length,
    10,
    'summary did not expose exactly the available canonical scalars'
);
assert.equal(
    (summary.match(/data-embedding-asset="fixture-thumb"/g) || []).length,
    10,
    'available scalar bindings do not share the scored thumbnail identity'
);
assert(
    summary.includes('canonical Long ledger')
        && compactSummary.includes('10/21 scalar values')
        && compactSummary.includes('21 addresses verified'),
    'Long summary does not disclose canonical inventory and availability'
);
assert(
    graphHtml.includes(
        'Map placements are plotted separately and never substituted'
    )
        && graphHtml.includes(
            'map geometry only · long.map-placement.text.ctr'
        ),
    'Long graph UI does not distinguish map geometry from scalar output'
);
assert.equal(
    api.lqxGraphGrid(partialScore, 'fixture-thumb'),
    graphHtml,
    'ready Long graph HTML was not deterministically cached'
);

const completeScore = buildScore();
assert.equal(api.lqxStoredOutputCount(completeScore), 21);
assert.equal(api.lqxHasCanonicalLedger(completeScore), true);
assert.equal(
    api.lqxPrimaryMetric(completeScore).coordinateId,
    'long.output.visual.ctrviews',
    'primary thumbnail decision is not the governed visual CTR+views coordinate'
);
assert.equal(
    api.lqxPrimaryPct01(completeScore),
    completeScore.long_score_ledger
        .percentiles_by_id['long.output.visual.ctrviews'] / 100,
    'primary thumbnail percentile was not derived from the ledger'
);
assert(
    Object.isFrozen(completeScore.long_score_ledger)
        && Object.isFrozen(completeScore.long_score_ledger.entries[0])
        && Object.isFrozen(completeScore.output_contract),
    'validated ledger and output contract were not frozen before cache reuse'
);

const contentTamper = JSON.parse(JSON.stringify(completeScore));
contentTamper.long_score_ledger.entries[0].value = 999;
contentTamper.channels.visual.metrics.ctrviews = {
    value: 999,
    percentile: 99,
};
assert.equal(
    api.lqxHasCanonicalLedger(contentTamper),
    false,
    'mutated ledger content retained a valid stale hash'
);
assert.equal(
    api.lqxRegisteredCoordinate(
        contentTamper,
        'visual',
        'ctrviews'
    ),
    null,
    'invalid ledger fell through to duplicate channel data'
);

const governanceTamper = JSON.parse(JSON.stringify(completeScore));
governanceTamper.long_score_ledger.governance_sha256 = 'f'.repeat(64);
delete governanceTamper.long_score_ledger.ledger_sha256;
governanceTamper.long_score_ledger.ledger_sha256 = sha256Canonical(
    governanceTamper.long_score_ledger
);
governanceTamper.output_contract.ledger_sha256 =
    governanceTamper.long_score_ledger.ledger_sha256;
assert.equal(
    api.lqxHasCanonicalLedger(governanceTamper),
    false,
    'self-consistent ledger from foreign governance was accepted'
);

const inventoryTamper = JSON.parse(JSON.stringify(completeScore));
inventoryTamper.long_score_ledger.coordinate_ids[0] =
    'long.output.visual.deleted_alias';
delete inventoryTamper.long_score_ledger.ledger_sha256;
inventoryTamper.long_score_ledger.ledger_sha256 = sha256Canonical(
    inventoryTamper.long_score_ledger
);
inventoryTamper.output_contract.ledger_sha256 =
    inventoryTamper.long_score_ledger.ledger_sha256;
assert.equal(
    api.lqxHasCanonicalLedger(inventoryTamper),
    false,
    'foreign coordinate inventory was accepted'
);

const definitionTamper = JSON.parse(JSON.stringify(completeScore));
definitionTamper.output_contract.metric_definitions[0].target = 'views';
assert.equal(
    api.lqxHasCanonicalLedger(definitionTamper),
    false,
    'mutated metric definition was accepted'
);
assert.equal(
    api.lqxRegisteredCoordinate({}, 'visual', 'ctrviews'),
    null,
    'ledgerless payload produced a canonical scalar'
);

const unicodeFixture = {
    a: [1, -0, { x: null, y: true }],
    z: 'promise \ud83e\uddea',
};
assert.equal(
    api.lqxSha256(api.lqxCanonicalJson(unicodeFixture)),
    crypto.createHash('sha256')
        .update(canonicalJson(unicodeFixture))
        .digest('hex'),
    'browser canonical UTF-8 SHA-256 differs from the server hash'
);

console.log(JSON.stringify({
    ok: true,
    governedCoordinates: governedCoordinates.length,
    metricsPerChannel: governedMetrics.length,
    partialAvailable: partialState.available,
    completeAvailable: api.lqxStoredOutputCount(completeScore),
    graphBindings: Object.fromEntries(
        governedChannels.map(channel => [
            channel,
            (graphHtml.match(
                new RegExp(`data-lqxrawchan="${channel}"`, 'g')
            ) || []).length,
        ])
    ),
    governanceSha256,
}, null, 2));
