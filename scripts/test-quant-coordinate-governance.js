#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const validation = require('../buildings/jarvis/saved-channel-validation');
const governance = require('../buildings/jarvis/quant-coordinate-governance.json');
const featureContract = require('../buildings/jarvis/saved-channel-feature-contract.json');
const governanceSha256 = require('crypto').createHash('sha256').update(
    fs.readFileSync(
        path.join(
            ROOT,
            'buildings',
            'jarvis',
            'quant-coordinate-governance.json'
        )
    )
).digest('hex');
const validationSource = fs.readFileSync(
    path.join(ROOT, 'buildings', 'jarvis', 'saved-channel-validation.js'),
    'utf8'
);
const shortsUiSource = fs.readFileSync(
    path.join(ROOT, 'buildings', 'jarvis', 'jarvis-retention.js'),
    'utf8'
);
const longUiSource = fs.readFileSync(
    path.join(ROOT, 'buildings', 'jarvis', 'jarvis-longquant.js'),
    'utf8'
);
const displayContractSource = fs.readFileSync(
    path.join(ROOT, 'embedding-display-contract.js'),
    'utf8'
);
const predictorSource = fs.readFileSync(
    path.join(
        ROOT,
        'buildings',
        'jarvis',
        'predictor-lab',
        'run_predictor_lab.py'
    ),
    'utf8'
);
const operationsSource = fs.readFileSync(
    path.join(
        ROOT,
        'buildings',
        'jarvis',
        'operations-lab',
        'build_operations.py'
    ),
    'utf8'
);
const serverSource = fs.readFileSync(
    path.join(ROOT, 'server.js'),
    'utf8'
);
const savedChannelWorkerSource = fs.readFileSync(
    path.join(ROOT, 'yt_relay_watcher.py'),
    'utf8'
);
const savedChannelRecordBindingSource = fs.readFileSync(
    path.join(
        ROOT,
        'buildings',
        'jarvis',
        'saved-channel-record-binding.js'
    ),
    'utf8'
);
const shortsLedgerSource = fs.readFileSync(
    path.join(ROOT, 'buildings', 'jarvis', 'shorts-score-ledger.js'),
    'utf8'
);
const longLedgerSource = fs.readFileSync(
    path.join(ROOT, 'buildings', 'jarvis', 'long-score-ledger.js'),
    'utf8'
);
const longSavedRecordSource = fs.readFileSync(
    path.join(
        ROOT,
        'buildings',
        'jarvis',
        'long-saved-thumbnail-record.js'
    ),
    'utf8'
);
const longQueueSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'queue-longquant-channel-grinds.js'),
    'utf8'
);
const harvestSource = fs.readFileSync(
    path.join(ROOT, 'buildings', 'jarvis', 'hook-rl', 'r7_harvest.py'),
    'utf8'
);
const longScorerSource = fs.readFileSync(
    path.join(ROOT, 'longquant_score.py'),
    'utf8'
);
const manifestBindingSource = fs.readFileSync(
    path.join(
        ROOT,
        'buildings',
        'jarvis',
        'saved-channel-manifest-binding.js'
    ),
    'utf8'
);
const shortsProjectionProducerSource = fs.readFileSync(
    path.join(ROOT, 'add_steered_proj.py'),
    'utf8'
);
const longProjectionProducerSource = fs.readFileSync(
    path.join(ROOT, 'add_steered_proj_long.py'),
    'utf8'
);

function expand(pattern, replacements) {
    return Object.entries(replacements).reduce(
        (value, [key, replacement]) => value.replace(`{${key}}`, replacement),
        pattern
    );
}

const outcomeKeys = Object.keys(
    governance.inference.outcomeHypothesisFamilies
);
const storedOutcomeKeys = outcomeKeys.filter(key => key !== 'swipe');
const publicFeatures = featureContract.features.filter(feature => (
    feature.group !== 'novelty'
    && governance.expansions.creatorExcludedPublicTargets.includes(
        feature.target
    )
));
const privateHeldoutFeatures = featureContract.features.filter(feature => (
    feature.group !== 'novelty'
    && governance.expansions.privateHeldoutTargets.includes(feature.target)
));

const activeIds = [
    ...storedOutcomeKeys.map(outcomeKey => expand(
        governance.coordinates.observedPattern,
        { outcomeKey }
    )),
    ...featureContract.features.map(feature => expand(
        governance.coordinates.storedPattern,
        { featureKey: feature.key }
    )),
    governance.coordinates.visualKeepForecast.id,
    ...Object.values(governance.coordinates.visualKeepProtocols)
        .map(protocol => protocol.id),
    governance.coordinates.creatorAdaptiveKeepForecast.id,
    ...publicFeatures.map(feature => expand(
        governance.coordinates.creatorExcludedPublicPattern,
        { featureKey: feature.key }
    )),
    ...governance.expansions.heldoutProtocols.flatMap(protocol => (
        privateHeldoutFeatures.map(feature => expand(
            governance.coordinates.privateHeldoutPattern,
            { protocol, featureKey: feature.key }
        ))
    )),
    ...governance.expansions.heldoutProtocols.flatMap(protocol => (
        storedOutcomeKeys.map(outcomeKey => expand(
            governance.coordinates.forecastPattern,
            { protocol, outcomeKey }
        ))
    )),
];
const activeIdSet = new Set(activeIds);

assert.strictEqual(governance.schemaVersion, 4);
assert.strictEqual(governance.ledgerVersion, 11);
assert.strictEqual(
    governance.compatibility.migratableLedgerRevisions.length,
    2,
    'Shorts migration must accept only explicitly byte-pinned revisions'
);
assert.strictEqual(
    governance.compatibility.migratableLongLedgerRevisions.length,
    2,
    'Long migration must accept only explicitly byte-pinned revisions'
);
assert.deepStrictEqual(
    governance.valueUnits.percent,
    {
        minimumInclusive: 0,
        maximumInclusive: 100,
        description:
            'A non-rewatch percentage whose complete support is the closed interval [0, 100].',
    }
);
assert.strictEqual(
    governance.valueUnits
        .retention_percent_rewatch_capable.minimumInclusive,
    0
);
assert.strictEqual(
    governance.valueUnits
        .retention_percent_rewatch_capable.maximumInclusive,
    null
);
assert(
    featureContract.features
        .filter(feature => feature.target === 'ret5')
        .every(
            feature => (
                feature.unit
                === 'retention_percent_rewatch_capable'
            )
        ),
    'all ret5 coordinates must use the governed rewatch-capable unit'
);
assert(
    featureContract.features
        .filter(feature => feature.target === 'keep')
        .every(feature => feature.unit === 'percent'),
    'keep must remain bounded by the ordinary percent unit'
);
assert.strictEqual(validation.LEDGER_VERSION, governance.ledgerVersion);
assert.strictEqual(validation.coordinateGovernance, governance);
assert(
    longUiSource.includes('__QUANT_COORDINATE_GOVERNANCE__')
        && longUiSource.includes(
            '__QUANT_COORDINATE_GOVERNANCE_SHA256__'
        )
        && !/const LQ_LEDGER_VERSION = \d+;/.test(longUiSource)
        && !/const LQ_GOVERNANCE_SHA256 = '[a-f0-9]{64}';/.test(
            longUiSource
        ),
    'The Long browser must consume canonical runtime governance without copied release constants'
);
assert(
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes(
        '/api/quant-coordinate-governance.js'
    ),
    'The canonical governance runtime must load before the Quant browser UIs'
);
assert.strictEqual(featureContract.features.length, 21);
assert.strictEqual(outcomeKeys.length, 13);
assert.strictEqual(publicFeatures.length, 9);
assert.strictEqual(privateHeldoutFeatures.length, 9);
assert.strictEqual(activeIds.length, 89);
assert.strictEqual(activeIdSet.size, 89, 'active coordinate IDs must be unique');
assert.strictEqual(
    featureContract.lineageContract.inventorySemantics.shortsLedgerColumns,
    89
);
assert.strictEqual(governance.displayTransforms.length, 3);
assert.strictEqual(
    featureContract.lineageContract.inventorySemantics
        .shortsNonStoredDisplayTransforms,
    3
);
governance.displayTransforms.forEach(transform => {
    assert.strictEqual(transform.formula, '100 - source');
    assert.strictEqual(transform.stored, false);
    assert.strictEqual(transform.predictorEligible, false);
    assert.strictEqual(
        activeIdSet.has(transform.id),
        false,
        `${transform.id} must remain outside the stored ledger`
    );
    assert(
        activeIdSet.has(transform.sourceCoordinateId),
        `${transform.id} must resolve to a stored source coordinate`
    );
});

const aliases = governance.compatibility.aliasPatterns.flatMap(alias => (
    publicFeatures.flatMap(feature => (
        alias.targets.includes(feature.target) ? [{
            id: expand(alias.from, { featureKey: feature.key }),
            canonicalId: expand(alias.to, { featureKey: feature.key }),
        }] : []
    ))
));
const aliasMap = Object.fromEntries(
    aliases.map(alias => [alias.id, alias.canonicalId])
);
const minimalRegistry = {
    columns: activeIds.map(id => ({ id })),
    aliasMap,
};

assert.strictEqual(aliases.length, 18);
aliases.forEach(alias => {
    assert.strictEqual(
        activeIdSet.has(alias.id),
        false,
        `${alias.id} must remain outside the active ledger`
    );
    assert(
        activeIdSet.has(alias.canonicalId),
        `${alias.id} must resolve to an active canonical coordinate`
    );
    assert.strictEqual(
        validation.resolveCoordinateId(minimalRegistry, alias.id),
        alias.canonicalId
    );
});
governance.compatibility.retired.forEach(retired => {
    assert.strictEqual(
        activeIdSet.has(retired.id),
        false,
        `${retired.id} must remain outside the active ledger`
    );
});

assert.strictEqual(
    governance.inference.outcomeHypothesisFamilies.keep,
    governance.inference.outcomeHypothesisFamilies.swipe,
    'keep and derived swipe are one feed-decision hypothesis family'
);
assert(
    validationSource.includes('swipe: round(100 - byKey.keep)'),
    'score21 swipe must remain a deterministic inverse of keep'
);
assert(
    validationSource.includes(
        "derived: '100 - stayed to watch'"
    ),
    'observed swipe must disclose its deterministic derivation'
);
assert(
    shortsUiSource.includes('registry.displayTransforms || []')
        && shortsUiSource.includes("transform.formula !== '100 - source'"),
    'Shorts UI must render non-stored swipe values from the governed keep source'
);
assert(
    !shortsProjectionProducerSource.includes(
        "('swipe', SWIPE)"
    )
        && !shortsUiSource.includes(
            "['swipe', '→ swipe-ratio']"
        )
        && shortsProjectionProducerSource.includes(
            "key == 'swipe' or key.startswith('swipe__')"
        ),
    'swipe-away must remain a governed 100 - keep transform, never a second fitted map plane'
);
for (const [name, source] of [
    ['Shorts projection producer', shortsProjectionProducerSource],
    ['Long projection producer', longProjectionProducerSource],
]) {
    assert(
        source.includes(
            "'geometry_fit_scope': 'full_fit_descriptive"
        )
            && source.includes(
                "'validation_metric_scope': '5_fold_out_of_fold_spearman"
            )
            && source.includes(
                "'scalar_score_use': 'forbidden'"
            ),
        `${name} must distinguish full-fit geometry from OOF validation`
    );
}
for (const [name, source] of [
    ['Shorts browser', shortsUiSource],
    ['Long browser', longUiSource],
]) {
    assert(
        !source.includes('held-out scored')
            && !source.includes('held-out align')
            && source.includes(
                'full-fit descriptive geometry'
            ),
        `${name} must not describe full-fit map coordinates as held-out predictions`
    );
}

const nativePoints = [
    { id: 'a', accountId: 'one', actual: 40, predicted: 72, baseline: 60 },
    { id: 'b', accountId: 'two', actual: 80, predicted: 64, baseline: 60 },
];
const nativeEvaluation = validation._identityCoordinateEvaluation(
    nativePoints,
    { key: 'keep', unit: 'percent' },
    'registered_video_heldout_identity'
);
assert.deepStrictEqual(
    nativeEvaluation.predictions.map(point => point.predicted),
    [72, 64]
);
assert.strictEqual(nativeEvaluation.identity, true);
assert.strictEqual(nativeEvaluation.fittedByRelationshipChart, false);
assert.strictEqual(nativeEvaluation.audit.fittedParameterCount, 0);
assert.strictEqual(nativeEvaluation.audit.trainingRowsReadByChart, 0);
assert.strictEqual(nativeEvaluation.audit.trainingOutcomesReadByChart, 0);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(validation, '_singleCoordinateOof'),
    false
);
assert(!validationSource.includes('function fitOOFCoordinate'));
assert(!validationSource.includes(
    'video_held_out_coordinate_plus_video_5fold_calibration'
));

const longScalarCount = (
    governance.expansions.longGroups.length
    * governance.expansions.longMetrics.length
);
const longMapPlacementCount = (
    governance.expansions.longGroups.length
    * featureContract.crossDomainInventory.longQuant.mapProjections.length
);
assert.strictEqual(longScalarCount, 21);
assert.strictEqual(longMapPlacementCount, 36);
assert(
    !shortsUiSource.includes('const source = up && up.steer'),
    'Shorts UI must not read a stored score from the steer cache'
);
assert(
    !shortsUiSource.includes(
        'const cell = video && video.features && video.features[key]'
    ),
    'saved-channel UI must not read a stored score from the feature cache'
);
assert(
    !longUiSource.includes(
        'const legacy = score && score.channels && score.channels[ch]'
    ),
    'Long UI must not read a scalar from a legacy channel metric cache'
);
assert(
    !displayContractSource.includes(
        'const steer = record && record.steer'
    ),
    'compact saved-hook display must materialize or validate a ledger'
);
assert(
    !predictorSource.includes(
        '(video.get("features") or {}).get(definition["key"])'
    ),
    'Predictor Lab must not train from the denormalized feature cache'
);
assert(
    !operationsSource.includes(
        '((row.get("steer") or {}).get(steer_key)'
    ),
    'Operations Lab must not train from the denormalized steer cache'
);
assert(
    serverSource.includes(
        "} = require('./buildings/jarvis/saved-channel-record-binding');"
    )
        && savedChannelRecordBindingSource.includes(
            'function validateSavedChannelRecordBinding('
        ),
    'saved-channel reads need one shared fail-closed binding validator'
);
assert(
    !serverSource.includes('canonicalizeSavedChannelRecordBinding(')
        && serverSource.includes('validateSavedChannelRecordBinding('),
    'runtime reads must validate stored evidence without canonicalizing it'
);
assert(
    !serverSource.includes('migrateSavedChannelManifestBindings'),
    'runtime GET routes must never run historical saved-channel migrations'
);
assert(
    savedChannelRecordBindingSource.includes(
        'features: row.features || record.features || null'
    )
        && savedChannelRecordBindingSource.includes(
            'shortsScoreLedger.materializeHistoricalScoreLedger({'
        )
        && shortsLedgerSource.includes(
            'historical feature and steer caches disagree'
        ),
    'legacy saved-channel rows may migrate only by parity-checking the full-record steer evidence against the manifest feature evidence'
);
assert(
    savedChannelRecordBindingSource.includes(
        'options.allowLegacyCacheMaterialization === true'
    )
        && savedChannelRecordBindingSource.includes(
            'options.allowPriorRevisionMigration !== true'
        ),
    'historical materialization and revision migration must be explicit offline-only operations'
);
assert(
    savedChannelRecordBindingSource.includes(
        'shortsScoreLedger.stripLegacyScoreCaches(record)'
    ),
    'canonical saved-channel records must remove denormalized score caches'
);
assert(
    !shortsUiSource.includes(
        'Object.assign(rec, { indicators: j.indicators, steer:'
    ),
    'a freshly rescored hook must not retain an in-memory steer cache'
);
assert(
    serverSource.includes('validateCompactSavedHookSource('),
    'saved-hook detail must verify its compact index source binding'
);
assert(
    savedChannelWorkerSource.includes("record.pop('steer', None)")
        && savedChannelWorkerSource.includes(
            "record.pop('features', None)"
        ),
    'saved-channel worker must persist only the canonical score ledger'
);
assert(
    longLedgerSource.includes(
        'function longOutputCoordinate(channel, metric)'
    )
        && longLedgerSource.includes(
            'function longMapPlacementCoordinate(channel, projection)'
        ),
    'Long scalar and map coordinate IDs must be constructed from governance'
);
for (const [name, source] of [
    ['Long saved-record contract', longSavedRecordSource],
    ['Long queue worker', longQueueSource],
    ['Long browser', longUiSource],
    ['server', serverSource],
]) {
    assert(
        !source.includes("'long.output.visual.ctrviews'")
            && !source.includes('"long.output.visual.ctrviews"'),
        `${name} must consume the governed Long threshold coordinate`
    );
}
assert(
    !harvestSource.includes("'shorts.stored.")
        && harvestSource.includes('feature_coordinate_id'),
    'legacy Shorts harvest gates must consume governed coordinate constructors'
);
assert(
    !manifestBindingSource.includes('visual_keep_forecast')
        && !manifestBindingSource.includes(
            'creator_adaptive_keep_forecast'
        ),
    'saved-channel manifest rows must not duplicate forecast authorities'
);
assert.notStrictEqual(
    validation.CREATOR_ADAPTIVE_KEEP_PREQUENTIAL_COORDINATE_ID,
    validation.CREATOR_ADAPTIVE_KEEP_MODEL_COORDINATE_ID,
    'historical creator-prequential validation and live forecasting need distinct coordinate IDs'
);
assert(
    shortsUiSource.includes('up.score_ledger.ledger_sha256')
        && longUiSource.includes(
            'score.long_score_ledger.ledger_sha256'
        ),
    'browser plot-cache identities must bind to the displayed ledger revision'
);
assert(
    longScorerSource.includes(
        'could not pin required R2 artifact revision'
    )
        && !longScorerSource.includes(
            'return {\"key\": key, \"etag\": None'
        ),
    'Long scoring must fail closed when mutable object revisions cannot be pinned'
);
assert(
    longUiSource.includes(
        "const id = 'tt' + await lqxExactTextSha256(title);"
    ),
    'Long title-test identity must use exact text SHA-256'
);
assert(
    serverSource.includes(
        'async function savedChannelValidationCacheKey()'
    )
        && serverSource.includes(
            '`computed:raw/saved-channel-validation:${sha}`'
        )
        && serverSource.includes(
            'const validationCacheKey = await savedChannelValidationCacheKey();'
        )
        && serverSource.includes(
            'validationCacheKey,\n            6 * 3600e3,'
        ),
    'saved-channel validation cache must be keyed by the immutable release SHA'
);
assert(
    serverSource.includes(
        'async function readQuantProjectionRelease('
    )
        && serverSource.includes(
            'async function serveQuantMap('
        )
        && serverSource.includes(
            '`immutable:${release.map.key}`'
        )
        && serverSource.includes(
            "'X-Map-Release-SHA256':"
        )
        && serverSource.includes(
            'allowStaleOnSourceError: false'
        ),
    'Raw map routes must serve a hash-verified immutable release and fail closed'
);
assert(
    serverSource.includes(
        "await serveQuantMap(req, res, url, 'raw');"
    )
        && serverSource.includes(
            "await serveQuantMap(req, res, url, 'raw-long');"
        )
        && !serverSource.includes(
            'await serveR2Gz(req, res, `raw/${ch}/map.json`'
        )
        && !serverSource.includes(
            'await serveR2Gz(req, res, `raw-long/${ch}/map.json`'
        ),
    'Raw map HTTP routes must not fall back to mutable map keys'
);
assert(
    shortsUiSource.includes(
        'scoreFeatureContractIdentitySha256(contract)'
    )
        && shortsUiSource.includes(
            'identitySha256'
                + '\n                    !== live.feature_contract_sha256'
        )
        && shortsUiSource.includes(
            "_captureResponseHeaders: true"
        ),
    'the browser must verify static feature-contract identity against the live scorer and capture immutable response revisions'
);
assert(
    shortsUiSource.includes(
        'Predictor artifact and status belong to different immutable releases.'
    )
        && /artifactRelease\s*!==\s*status\.releaseSha256/.test(
            shortsUiSource
        )
        && /artifactSha256\s*!==\s*status\.artifactSha256/.test(
            shortsUiSource
        )
        && serverSource.includes(
            'analysis.artifactSha256 ='
        ),
    'Predictor Lab must reject an artifact/status release mismatch'
);
for (const [name, source] of [
    ['Shorts browser', shortsUiSource],
    ['Long browser', longUiSource],
]) {
    assert(
        source.includes(
            'compact plot is missing exact immutable release identity'
        )
            && source.includes(':release:${release.identity}')
            && source.includes('ReleaseResponseIsCurrent(')
            && /Date\.now\(\)[\s\S]{0,120}< 30000/.test(source),
        `${name} compact plot cache must be short-lived and release-aware`
    );
}

console.log(JSON.stringify({
    ok: true,
    activeShortsRows: activeIds.length,
    compatibilityAliases: aliases.length,
    retiredCoordinates: governance.compatibility.retired.length,
    longScalarOutputs: longScalarCount,
    longMapPlacements: longMapPlacementCount,
    nativeChartFittedParameters:
        nativeEvaluation.audit.fittedParameterCount,
}));
