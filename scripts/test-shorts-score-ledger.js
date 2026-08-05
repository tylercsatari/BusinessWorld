#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const ledgerContract = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const displayContract = require('../embedding-display-contract');
const savedChannelAnalysis = require(
    '../buildings/jarvis/saved-channel-analysis'
);
const savedChannelValidation = require(
    '../buildings/jarvis/saved-channel-validation'
);
const manifestBinding = require(
    '../buildings/jarvis/saved-channel-manifest-binding'
);
const savedChannelRecordBinding = require(
    '../buildings/jarvis/saved-channel-record-binding'
);
const {
    canonicalArtifactIdentity,
} = require('../buildings/jarvis/canonical-json-artifact');

const ROOT = path.join(__dirname, '..');
const python = `
import json
from shorts_score_ledger import FEATURES, materialize_score_bundle
steer = {}
for index, definition in enumerate(FEATURES):
    if definition.get('source') != 'steer':
        continue
    unit = definition.get('unit')
    if unit in ('percent', 'retention_percent_rewatch_capable'):
        value = 60 + index
    elif unit == 'probability':
        value = 0.65
    elif unit == 'views':
        value = 100000 + index
    else:
        value = 1.5 + index / 10
    steer[definition['sourceKey']] = {
        'est': value,
        'pctile': (
            None
            if definition.get('target') == 'realviews'
            else 70 + index / 10
        ),
        'coordinate_id': 'shorts.stored.' + definition['key'],
        'feature_key': definition['key'],
        'group': definition['group'],
        'target': definition['target'],
        'kind': 'fixture',
    }
indicators = {
    'novelty_' + target: 0.5
    for target in ('keep', 'ret5', 'views')
}
registry = {
    'indicators': [
        {
            'name': 'novelty_' + target,
            'kind': 'novelty',
            'target': target,
            'validated': True,
            'spearman': 0.2,
            'pts': (
                [[0.1, 1.0], [0.5, 2.0], [0.9, 3.0]]
                if target == 'views'
                else [[0.1, 25.0], [0.5, 60.0], [0.9, 90.0]]
            ),
        }
        for target in ('keep', 'ret5', 'views')
    ],
}
bundle = materialize_score_bundle(
    {'steer': steer, 'indicators': indicators},
    registry,
)
print(json.dumps(bundle))
`;
const bundle = JSON.parse(execFileSync(
    'python3',
    ['-c', python],
    { cwd: ROOT, encoding: 'utf8' }
));
const ledger = bundle.score_ledger;
const validation = ledgerContract.validateScoreLedger(ledger);

function shortsBrowserRuntime() {
    return {
        schema: 'shorts-score-ledger-browser-runtime-v1',
        schemaVersion: 1,
        ledgerSchema: 'shorts-stored-score-ledger-v1',
        ledgerSchemaVersion: 1,
        ledgerVersion: ledgerContract.GOVERNANCE.ledgerVersion,
        percentileUnit:
            ledgerContract.GOVERNANCE.percentileStorageUnit,
        featureIdentitySchemaVersion:
            ledgerContract.FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
        featureContractSha256:
            ledgerContract.FEATURE_CONTRACT_SHA256,
        featureContractDocumentSha256:
            ledgerContract.FEATURE_CONTRACT_DOCUMENT_SHA256,
        governanceVersion:
            ledgerContract.GOVERNANCE.schemaVersion,
        governanceSha256:
            ledgerContract.GOVERNANCE_SHA256,
        expectedCoordinateIds:
            ledgerContract.EXPECTED_COORDINATE_IDS,
        unitBounds: Object.fromEntries(
            Object.entries(
                ledgerContract.GOVERNANCE.valueUnits
            ).map(([unit, definition]) => [unit, {
                min: definition.minimumInclusive,
                max: definition.maximumInclusive,
            }])
        ),
        definitions: ledgerContract.FEATURE_DEFINITIONS.map(
            definition => ({
                coordinateId: definition.coordinateId,
                featureKey: definition.key,
                group: definition.group,
                target: definition.target,
                source: definition.source,
                sourceKey:
                    definition.sourceKey || definition.key,
                unit: definition.unit,
                displayUnit: definition.displayUnit ?? null,
            })
        ),
    };
}

function shortsBrowserLedgerApi() {
    const uiPath = path.join(
        ROOT,
        'buildings/jarvis/jarvis-retention.js'
    );
    const marker =
        '        getExperimentContext: () => LAB_CONTEXT,';
    const source = fs.readFileSync(uiPath, 'utf8');
    assert(
        source.includes(marker),
        'Shorts UI test export insertion point changed'
    );
    const instrumented = source.replace(
        marker,
        `        getExperimentContext: () => LAB_CONTEXT,
        __test: {
            shortsLedgerState,
            shortsRegisteredCoordinate,
            savedChannelFeatureCell,
            savedChannelFeatureDisplay,
            savedChannelFeatureStatus,
        },`
    );
    const noTimer = () => 0;
    const document = {
        addEventListener() {},
        removeEventListener() {},
        visibilityState: 'visible',
    };
    const window = {
        addEventListener() {},
        removeEventListener() {},
        setInterval: noTimer,
        clearInterval() {},
        setTimeout: noTimer,
        clearTimeout() {},
        document,
        location: { href: 'http://localhost/' },
        innerWidth: 1024,
    };
    window.window = window;
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        setTimeout: noTimer,
        clearTimeout() {},
        setInterval: noTimer,
        clearInterval() {},
        TextEncoder,
        URLSearchParams,
        fetch: async () => {
            throw new Error('network disabled in ledger test');
        },
        window,
        document,
        __SHORTS_SCORE_LEDGER_RUNTIME__: shortsBrowserRuntime(),
    };
    vm.runInNewContext(instrumented, sandbox, {
        filename: uiPath,
    });
    return sandbox.module.exports.__test;
}

const browserLedgerApi = shortsBrowserLedgerApi();

const exactMontageBytes = Buffer.from('canonical-five-frame-jpeg');
const exactMontageSha256 = require('crypto')
    .createHash('sha256')
    .update(exactMontageBytes)
    .digest('hex');
const exactTranscript = 'This is the exact transcript.';
const exactEmbeddingInput = {
    schema: 'shorts-embedding-input-v2',
    montage_sha256: exactMontageSha256,
    transcript: exactTranscript,
    channels: {
        visual: '5-frame-montage',
        text: 'normalized-transcript',
        together: '5-frame-montage+normalized-transcript',
    },
};
const exactEmbeddingFingerprint =
    ledgerContract.sha256Canonical(exactEmbeddingInput);
function exactInputRecord(scoreInput, manifestPatch = {}) {
    const scoreInputFingerprint =
        ledgerContract.sha256Canonical(scoreInput);
    return {
        input_manifest: {
            domain: 'shorts_raw',
            canonical_montage: {
                montage_sha256: exactMontageSha256,
            },
            transcript_used: true,
            duration_s: 4.321,
            creator_profile: null,
            embedding_input_fingerprint: exactEmbeddingFingerprint,
            score_input_fingerprint: scoreInputFingerprint,
            input_fingerprint: scoreInputFingerprint,
            channels: {
                text: { text: `  ${exactTranscript}  ` },
            },
            ...manifestPatch,
        },
    };
}
const exactScoreInputV2 = {
    schema: 'shorts-score-input-v2',
    embedding_input_fingerprint: exactEmbeddingFingerprint,
    embedding_input: exactEmbeddingInput,
    duration_ms: 4321,
    creator_profile: 'tyler',
};
const exactInputRecordV2 = exactInputRecord(
    exactScoreInputV2,
    { creator_profile: 'tyler' }
);
const exactValidationV2 = ledgerContract.validateShortsInputManifest(
    exactInputRecordV2,
    {
        montageBytes: exactMontageBytes,
        text: exactTranscript,
        durationS: 4.321,
        creatorProfile: 'TYLER',
    }
);
assert.strictEqual(exactValidationV2.valid, true);
assert.strictEqual(
    exactValidationV2.scoreInputSchema,
    'shorts-score-input-v2'
);
const exactScoreInputV3 = {
    schema: 'shorts-score-input-v3',
    embedding_input_fingerprint: exactEmbeddingFingerprint,
    embedding_input: exactEmbeddingInput,
    duration_ms: 4321,
};
const exactInputRecordV3 = exactInputRecord(
    exactScoreInputV3,
    {
        score_input_schema: 'shorts-score-input-v3',
        requested_creator_profile: 'tyler',
    }
);
const exactValidationV3 = ledgerContract.validateShortsInputManifest(
    exactInputRecordV3,
    {
        montageBytes: exactMontageBytes,
        text: exactTranscript,
        durationS: 4.321,
        creatorProfile: null,
    }
);
assert.strictEqual(exactValidationV3.valid, true);
assert.strictEqual(
    exactValidationV3.scoreInputSchema,
    'shorts-score-input-v3'
);
const unsupportedInputRecord = JSON.parse(
    JSON.stringify(exactInputRecordV3)
);
unsupportedInputRecord.input_manifest.score_input_schema =
    'shorts-score-input-v99';
const unsupportedInputValidation =
    ledgerContract.validateShortsInputManifest(
        unsupportedInputRecord
    );
assert.strictEqual(unsupportedInputValidation.valid, false);
assert(
    unsupportedInputValidation.errors.includes(
        'Shorts score input schema is unsupported'
    )
);

const browserLedgerWithoutWrapper = JSON.parse(JSON.stringify(ledger));
const browserValidState = browserLedgerApi.shortsLedgerState({
    score_ledger: browserLedgerWithoutWrapper,
});
assert.strictEqual(
    browserValidState.valid,
    true,
    browserValidState.errors.join('; ')
);
assert.strictEqual(
    browserLedgerApi.shortsRegisteredCoordinate(
        { score_ledger: browserLedgerWithoutWrapper },
        'shorts.stored.visual.keep'
    ).value,
    ledger.values_by_id['shorts.stored.visual.keep'],
    'browser and canonical readers must return the exact same scalar'
);

assert.strictEqual(ledgerContract.FEATURE_CONTRACT.version, 10);
assert.strictEqual(ledgerContract.GOVERNANCE.schemaVersion, 4);
assert.strictEqual(ledgerContract.GOVERNANCE.ledgerVersion, 11);
assert.deepStrictEqual(
    ledgerContract.GOVERNANCE.valueUnits.percent,
    {
        minimumInclusive: 0,
        maximumInclusive: 100,
        description:
            'A non-rewatch percentage whose complete support is the closed interval [0, 100].',
    }
);
assert.strictEqual(
    ledgerContract.GOVERNANCE.valueUnits
        .retention_percent_rewatch_capable.minimumInclusive,
    0
);
assert.strictEqual(
    ledgerContract.GOVERNANCE.valueUnits
        .retention_percent_rewatch_capable.maximumInclusive,
    null
);
assert(
    ledgerContract.FEATURE_DEFINITIONS
        .filter(definition => definition.target === 'ret5')
        .every(
            definition => (
                definition.unit
                === 'retention_percent_rewatch_capable'
            )
        ),
    'every ret5 coordinate must use the one governed rewatch-capable unit'
);
assert(
    ledgerContract.FEATURE_DEFINITIONS
        .filter(definition => definition.target === 'keep')
        .every(definition => definition.unit === 'percent'),
    'keep must remain an ordinary [0, 100] percent'
);
assert.strictEqual(validation.valid, true, validation.errors.join('; '));
assert.strictEqual(
    validation.entries.length,
    21,
    'the materialized ledger must contain all 21 registered coordinates'
);
assert.deepStrictEqual(
    validation.entries.map(entry => entry.coordinate_id),
    ledgerContract.EXPECTED_COORDINATE_IDS
);
assert.strictEqual(
    ledger.entries.find(
        entry => entry.coordinate_id === 'shorts.stored.visual.realviews'
    ).percentile,
    null,
    'an available coordinate may retain an explicitly unavailable percentile'
);

function rehashLedger(candidate) {
    delete candidate.ledger_sha256;
    candidate.ledger_sha256 = ledgerContract.sha256Canonical(candidate);
    return candidate;
}

function ledgerWithUnavailable(coordinateId, reason) {
    const candidate = JSON.parse(JSON.stringify(ledger));
    const entry = candidate.entries.find(
        item => item.coordinate_id === coordinateId
    );
    assert(entry, `missing fixture coordinate ${coordinateId}`);
    entry.available = false;
    entry.value = null;
    entry.percentile = null;
    entry.unavailable_reason = reason;
    candidate.values_by_id[coordinateId] = null;
    candidate.percentiles_by_id[coordinateId] = null;
    candidate.available_count = candidate.entries.filter(
        item => item.available === true
    ).length;
    candidate.all_values_available = (
        candidate.available_count === candidate.entries.length
    );
    candidate.unavailable = candidate.entries
        .filter(item => item.available !== true)
        .map(item => ({
            coordinate_id: item.coordinate_id,
            reason: item.unavailable_reason,
        }));
    return rehashLedger(candidate);
}

const unavailableReason =
    'visual embedding was not produced for the canonical five-frame input';
const unavailableCoordinateId = 'shorts.stored.visual.keep';
const unavailableLedger = ledgerWithUnavailable(
    unavailableCoordinateId,
    unavailableReason
);
const unavailableRecord = { score_ledger: unavailableLedger };
const unavailableState = browserLedgerApi.shortsLedgerState(
    unavailableRecord
);
assert.strictEqual(
    unavailableState.valid,
    true,
    unavailableState.errors.join('; ')
);
const unavailableCell = browserLedgerApi.savedChannelFeatureCell(
    unavailableRecord,
    'visual.keep'
);
assert.strictEqual(unavailableCell.value, null);
assert.strictEqual(
    unavailableCell.unavailableReason,
    unavailableReason,
    'saved-channel cards must preserve the ledger reason for an unavailable coordinate'
);
assert.strictEqual(
    browserLedgerApi.savedChannelFeatureDisplay(
        ledgerContract.FEATURE_DEFINITIONS.find(
            definition => definition.key === 'visual.keep'
        ),
        unavailableCell
    ),
    'Not scored',
    'saved-channel score cards must never collapse an unavailable coordinate to a dash'
);
assert(
    browserLedgerApi.savedChannelFeatureStatus(
        unavailableCell
    ).includes(unavailableReason),
    'saved-channel score cards must explain why a coordinate was not scored'
);
const availableCell = browserLedgerApi.savedChannelFeatureCell(
    { score_ledger: browserLedgerWithoutWrapper },
    'visual.keep'
);
assert.strictEqual(
    availableCell.value,
    ledger.values_by_id[unavailableCoordinateId],
    'saved-channel cards must read the same canonical scalar as the normal score card'
);
assert.strictEqual(
    availableCell.ledgerSha256,
    ledger.ledger_sha256,
    'saved-channel cards must retain the immutable ledger identity'
);

function ledgerWithValue(coordinateId, value) {
    const candidate = JSON.parse(JSON.stringify(ledger));
    const entry = candidate.entries.find(
        item => item.coordinate_id === coordinateId
    );
    assert(entry, `missing fixture coordinate ${coordinateId}`);
    entry.value = value;
    candidate.values_by_id[coordinateId] = value;
    return rehashLedger(candidate);
}

function ledgerWithPercentile(coordinateId, percentile) {
    const candidate = JSON.parse(JSON.stringify(ledger));
    const entry = candidate.entries.find(
        item => item.coordinate_id === coordinateId
    );
    assert(entry, `missing fixture coordinate ${coordinateId}`);
    entry.percentile = percentile;
    candidate.percentiles_by_id[coordinateId] = percentile;
    return rehashLedger(candidate);
}

function mutatedLedger(mutate) {
    const candidate = JSON.parse(JSON.stringify(ledger));
    mutate(candidate);
    return rehashLedger(candidate);
}

const browserMutationMatrix = [
    {
        name: 'feature contract hash',
        ledger: mutatedLedger(candidate => {
            candidate.feature_contract_sha256 = 'f'.repeat(64);
        }),
    },
    {
        name: 'feature contract document hash format',
        ledger: mutatedLedger(candidate => {
            candidate.feature_contract_document_sha256 =
                'not-a-sha256';
        }),
    },
    {
        name: 'coordinate target label',
        ledger: mutatedLedger(candidate => {
            candidate.entries[0].target = 'ret5';
        }),
    },
    {
        name: 'keep value outside percent bounds',
        ledger: mutatedLedger(candidate => {
            const coordinateId = 'shorts.stored.visual.keep';
            candidate.entries[0].value = 150;
            candidate.values_by_id[coordinateId] = 150;
        }),
    },
    {
        name: 'coordinate governance hash',
        ledger: mutatedLedger(candidate => {
            candidate.coordinate_governance_sha256 =
                'e'.repeat(64);
        }),
    },
    {
        name: 'summary available count',
        ledger: mutatedLedger(candidate => {
            candidate.available_count--;
        }),
    },
    {
        name: 'unavailable inventory',
        ledger: mutatedLedger(candidate => {
            candidate.unavailable = [{
                coordinate_id: 'shorts.stored.visual.keep',
                reason: 'fabricated',
            }];
        }),
    },
];

for (const testCase of browserMutationMatrix) {
    const canonical =
        ledgerContract.validateScoreLedger(testCase.ledger);
    const browser = browserLedgerApi.shortsLedgerState({
        score_ledger: testCase.ledger,
    });
    assert.strictEqual(
        canonical.valid,
        false,
        `${testCase.name} must fail the canonical validator`
    );
    assert.strictEqual(
        browser.valid,
        canonical.valid,
        `${testCase.name} must have browser/canonical parity`
    );
}

const archivedDocumentLedger = mutatedLedger(candidate => {
    candidate.feature_contract_document_sha256 = 'a'.repeat(64);
});
const archivedDocumentValidation =
    ledgerContract.validateScoreLedger(archivedDocumentLedger);
assert.strictEqual(
    archivedDocumentValidation.valid,
    true,
    archivedDocumentValidation.errors.join('; ')
);
assert.strictEqual(
    archivedDocumentValidation.featureContractDocumentCurrent,
    false,
    'an archived descriptive document must remain visible without changing coordinate validity'
);
const archivedDocumentSummary =
    ledgerContract.scoreLedgerValidationSummary({
        score_ledger: archivedDocumentLedger,
    });
assert.strictEqual(archivedDocumentSummary.valid, true);
assert.strictEqual(
    archivedDocumentSummary.feature_contract_document_current,
    false
);
assert.strictEqual(archivedDocumentSummary.warnings.length, 1);

const repairableLedger = mutatedLedger(candidate => {
    candidate.feature_contract_sha256 = 'd'.repeat(64);
});
assert.strictEqual(
    browserLedgerApi.shortsLedgerState({
        score_ledger: repairableLedger,
    }).valid,
    false
);
repairableLedger.feature_contract_sha256 =
    ledgerContract.FEATURE_CONTRACT_SHA256;
rehashLedger(repairableLedger);
assert.strictEqual(
    browserLedgerApi.shortsLedgerState({
        score_ledger: repairableLedger,
    }).valid,
    true,
    'an invalid ledger object must not be cached by identity after repair'
);

const staleDiagnosticWrapperState =
    browserLedgerApi.shortsLedgerState({
        score_ledger: JSON.parse(JSON.stringify(ledger)),
        score_ledger_validation: {
            valid: false,
            ledger_sha256: null,
            errors: ['stale wrapper fixture'],
        },
    });
assert.strictEqual(
    staleDiagnosticWrapperState.valid,
    true,
    'a stale diagnostic wrapper must not hide a self-valid ledger'
);
assert.match(
    staleDiagnosticWrapperState.validationWarning,
    /stale wrapper fixture/
);

const unitBoundaryCases = [
    {
        name: 'percent lower endpoint',
        valid: true,
        ledger: ledgerWithValue('shorts.stored.visual.keep', 0),
    },
    {
        name: 'percent upper endpoint',
        valid: true,
        ledger: ledgerWithValue('shorts.stored.visual.keep', 100),
    },
    {
        name: 'rewatch-capable ret5 above one hundred',
        valid: true,
        ledger: ledgerWithValue('shorts.stored.visual.ret5', 150),
    },
    {
        name: 'probability lower endpoint',
        valid: true,
        ledger: ledgerWithValue('shorts.stored.visual.gt10M', 0),
    },
    {
        name: 'probability upper endpoint',
        valid: true,
        ledger: ledgerWithValue('shorts.stored.visual.gt10M', 1),
    },
    {
        name: 'views lower endpoint',
        valid: true,
        ledger: ledgerWithValue('shorts.stored.visual.views', 0),
    },
    {
        name: 'log views lower endpoint',
        valid: true,
        ledger: ledgerWithValue('shorts.stored.novelty.views', 0),
    },
    {
        name: 'unbounded number remains finite-only',
        valid: true,
        ledger: ledgerWithValue('shorts.stored.visual.outlier', -2.5),
    },
    {
        name: 'percentile lower endpoint',
        valid: true,
        ledger: ledgerWithPercentile('shorts.stored.visual.keep', 0),
    },
    {
        name: 'percentile upper endpoint',
        valid: true,
        ledger: ledgerWithPercentile('shorts.stored.visual.keep', 100),
    },
    {
        name: 'negative percent',
        valid: false,
        ledger: ledgerWithValue('shorts.stored.visual.keep', -0.001),
    },
    {
        name: 'percent above one hundred',
        valid: false,
        ledger: ledgerWithValue('shorts.stored.visual.keep', 150),
    },
    {
        name: 'negative rewatch-capable ret5',
        valid: false,
        ledger: ledgerWithValue('shorts.stored.visual.ret5', -0.001),
    },
    {
        name: 'negative probability',
        valid: false,
        ledger: ledgerWithValue('shorts.stored.visual.gt10M', -0.001),
    },
    {
        name: 'probability above one',
        valid: false,
        ledger: ledgerWithValue('shorts.stored.visual.gt10M', 1.001),
    },
    {
        name: 'negative views',
        valid: false,
        ledger: ledgerWithValue('shorts.stored.visual.views', -1),
    },
    {
        name: 'negative log views',
        valid: false,
        ledger: ledgerWithValue('shorts.stored.novelty.views', -0.001),
    },
    {
        name: 'negative percentile',
        valid: false,
        ledger: ledgerWithPercentile(
            'shorts.stored.visual.keep',
            -0.001
        ),
    },
    {
        name: 'percentile above one hundred',
        valid: false,
        ledger: ledgerWithPercentile(
            'shorts.stored.visual.keep',
            100.001
        ),
    },
];
const pythonUnitResults = JSON.parse(execFileSync(
    'python3',
    [
        '-c',
        [
            'import json,sys',
            'from shorts_score_ledger import validate_score_ledger',
            'results = []',
            'for ledger in json.load(sys.stdin):',
            '    try:',
            '        validate_score_ledger(ledger)',
            "        results.append({'valid': True, 'error': None})",
            '    except ValueError as error:',
            "        results.append({'valid': False, 'error': str(error)})",
            'print(json.dumps(results))',
        ].join('\n'),
    ],
    {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify(
            unitBoundaryCases.map(testCase => testCase.ledger)
        ),
    }
));
unitBoundaryCases.forEach((testCase, index) => {
    const javascriptResult = ledgerContract.validateScoreLedger(
        testCase.ledger
    );
    assert.strictEqual(
        javascriptResult.valid,
        testCase.valid,
        `${testCase.name} JavaScript result: ${javascriptResult.errors.join('; ')}`
    );
    assert.strictEqual(
        pythonUnitResults[index].valid,
        testCase.valid,
        `${testCase.name} Python result: ${pythonUnitResults[index].error}`
    );
    assert.strictEqual(
        javascriptResult.valid,
        pythonUnitResults[index].valid,
        `${testCase.name} must have JS/Python validation parity`
    );
    if (!testCase.valid) {
        assert(
            javascriptResult.errors.some(error => (
                error.includes('outside governance range')
            )),
            `${testCase.name} must report its governed range in JavaScript`
        );
        assert(
            pythonUnitResults[index].error.includes(
                'outside governance range'
            ),
            `${testCase.name} must report its governed range in Python`
        );
    }
});
const bindingRecord = {
    id: 'fixture-video',
    title: 'Cross-language binding',
    text: 'Exact normalized transcript',
    dur_s: 5,
    score_ledger: ledger,
    features: bundle.features,
    steer: bundle.addressed_steer,
    indicators: { novelty_keep: 0.25 },
    channels: {
        visual: { input: 'canonical montage' },
    },
    emb_preview: { visual: [0.1, 0.2] },
    novelty_provenance: { registry_sha256: 'n'.repeat(64) },
    input_manifest: {
        revision_fingerprint: 'revision',
        embedding_input_fingerprint: 'embedding',
        score_input_fingerprint: 'score',
        domain: 'shorts_raw',
        channels: {
            text: {
                text: 'Exact normalized transcript',
            },
        },
    },
};
const pythonBindingSha256 = execFileSync(
    'python3',
    [
        '-c',
        'import json,sys\nfrom shorts_score_ledger import score_record_binding_sha256\nprint(score_record_binding_sha256(json.load(sys.stdin)))',
    ],
    {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify(bindingRecord),
    }
).trim();
assert.strictEqual(
    ledgerContract.scoreRecordBindingSha256(bindingRecord),
    pythonBindingSha256,
    'Python and JavaScript must bind a scored record to identical bytes'
);
const channelFreeBindingRecord = JSON.parse(JSON.stringify(bindingRecord));
channelFreeBindingRecord.channel_free_keep_forecasts = {
    schema: 'shorts-channel-free-keep-forecasts-v1',
    model_artifact_sha256: 'c'.repeat(64),
    model_run_id: 'fixture-run',
    selected_signal: 'concat',
    source: 'live_frozen_channel_free_model_score',
    channel_information: null,
    outputs: Object.fromEntries(
        ['visual', 'text', 'together', 'concat'].map(
            (signal, index) => [signal, {
                coordinate_id: `shorts.channel-free.${signal}.keep`,
                signal,
                available: true,
                raw: 60 + index,
                est: 60 + index,
                pctile: 50 + index,
            }]
        )
    ),
};
channelFreeBindingRecord.visual_keep_forecast = { raw: 1 };
channelFreeBindingRecord.creator_adaptive_keep_forecast = { raw: 2 };
const channelFreePayload = ledgerContract.scoreRecordBindingPayload(
    channelFreeBindingRecord
);
assert.strictEqual(
    channelFreePayload.schema,
    'shorts-score-record-binding-v4'
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        channelFreePayload,
        'visual_keep_forecast'
    ),
    false,
    'v4 must retire the old frozen visual field'
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        channelFreePayload,
        'creator_adaptive_keep_forecast'
    ),
    false,
    'v4 must retire the old creator-adaptive field'
);
const pythonChannelFreeBindingSha256 = execFileSync(
    'python3',
    [
        '-c',
        'import json,sys\nfrom shorts_score_ledger import score_record_binding_sha256\nprint(score_record_binding_sha256(json.load(sys.stdin)))',
    ],
    {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify(channelFreeBindingRecord),
    }
).trim();
assert.strictEqual(
    ledgerContract.scoreRecordBindingSha256(channelFreeBindingRecord),
    pythonChannelFreeBindingSha256,
    'Python and JavaScript must bind the four channel-free outputs identically'
);
const changedChannelFreeRecord = JSON.parse(
    JSON.stringify(channelFreeBindingRecord)
);
changedChannelFreeRecord.channel_free_keep_forecasts.outputs.concat.raw += 1;
assert.notStrictEqual(
    ledgerContract.scoreRecordBindingSha256(changedChannelFreeRecord),
    ledgerContract.scoreRecordBindingSha256(channelFreeBindingRecord),
    'a channel-free output mutation must change the score-record hash'
);
const changedRetiredFields = JSON.parse(
    JSON.stringify(channelFreeBindingRecord)
);
changedRetiredFields.visual_keep_forecast.raw = 99;
changedRetiredFields.creator_adaptive_keep_forecast.raw = 99;
assert.strictEqual(
    ledgerContract.scoreRecordBindingSha256(changedRetiredFields),
    ledgerContract.scoreRecordBindingSha256(channelFreeBindingRecord),
    'retired fields must not create a duplicate v4 score authority'
);
const alternateAcquisition = JSON.parse(
    JSON.stringify(bindingRecord)
);
alternateAcquisition.input_manifest.source_mode = 'youtube';
alternateAcquisition.input_manifest.cache_status = 'hit';
alternateAcquisition.input_manifest.cache_key = 'transport-only';
assert.strictEqual(
    ledgerContract.scoreRecordBindingSha256(
        alternateAcquisition
    ),
    ledgerContract.scoreRecordBindingSha256(bindingRecord),
    'acquisition and cache provenance must not change semantic score identity'
);
const priorV2V4Binding = execFileSync(
    'python3',
    [
        '-c',
        'import json,sys\nfrom shorts_score_ledger import prior_score_record_binding_sha256_v2_v4\nprint(prior_score_record_binding_sha256_v2_v4(json.load(sys.stdin)))',
    ],
    {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify(bindingRecord),
    }
).trim();
assert.strictEqual(
    ledgerContract.priorScoreRecordBindingSha256V2V4(
        bindingRecord
    ),
    priorV2V4Binding,
    'Python and JavaScript must verify the prior v2/v4 binding identically'
);
const pythonPriorBindingSha256 = execFileSync(
    'python3',
    [
        '-c',
        'import json,sys\nfrom shorts_score_ledger import prior_score_record_binding_sha256_v1\nprint(prior_score_record_binding_sha256_v1(json.load(sys.stdin)))',
    ],
    {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify(bindingRecord),
    }
).trim();
assert.strictEqual(
    ledgerContract.priorScoreRecordBindingSha256V1(bindingRecord),
    pythonPriorBindingSha256,
    'Python and JavaScript must verify the prior record revision identically'
);
for (const mutation of [
    record => { record.text = 'Substituted transcript'; },
    record => {
        record.input_manifest.embedding_input_fingerprint =
            'different-embedding';
    },
    record => {
        record.score_ledger.entries[0].value += 1;
    },
    record => {
        record.channels.visual.input = 'different source';
    },
]) {
    const changed = JSON.parse(JSON.stringify(bindingRecord));
    mutation(changed);
    assert.notStrictEqual(
        ledgerContract.scoreRecordBindingSha256(changed),
        ledgerContract.scoreRecordBindingSha256(bindingRecord),
        'every scored input/evidence mutation must change the record binding'
    );
}
const boundRecord = JSON.parse(JSON.stringify(bindingRecord));
boundRecord.score_record_sha256 =
    ledgerContract.scoreRecordBindingSha256(boundRecord);
const recordArtifact = canonicalArtifactIdentity(boundRecord);
const manifestRow = {
    id: 'fixture-video',
    title: 'Cross-language binding',
    status: 'done',
    views: 123456,
    published: '2026-01-02',
    viewsObservedAt: 456,
    scoredAt: 123,
    score_record_sha256:
        boundRecord.score_record_sha256,
    record_artifact_sha256: recordArtifact.sha256,
    record_byte_length: recordArtifact.byte_length,
    score_ledger: ledger,
    input_manifest: {
        revision_fingerprint: 'revision',
    },
    evidence_state: 'canonical_bound',
    canonical: true,
    predictor_eligible: true,
    evidence_warning: null,
};
const pythonManifestBinding = execFileSync(
    'python3',
    [
        '-c',
        'import json,sys\nfrom shorts_score_ledger import saved_channel_manifest_row_binding_sha256\nprint(saved_channel_manifest_row_binding_sha256(json.load(sys.stdin)))',
    ],
    {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify(manifestRow),
    }
).trim();
assert.strictEqual(
    manifestBinding.manifestRowBindingSha256(manifestRow),
    pythonManifestBinding,
    'Python and JavaScript must bind a saved-channel row identically'
);
manifestRow.manifest_row_sha256 = pythonManifestBinding;
assert.strictEqual(
    manifestBinding.validateManifestRowBinding(manifestRow).valid,
    true
);

const legacySavedChannelRecord = {
    videoId: 'legacy-channel-video',
    title: 'Legacy saved channel record',
    steer: JSON.parse(JSON.stringify(bundle.addressed_steer)),
    input_manifest: {
        revision_fingerprint: 'legacy-revision',
        embedding_input_fingerprint: 'legacy-embedding',
        score_input_fingerprint: 'legacy-score',
    },
};
const legacySavedChannelRow = {
    id: 'legacy-channel-video',
    savedChannelId: 'chfixture',
    title: legacySavedChannelRecord.title,
    status: 'done',
    features: JSON.parse(JSON.stringify(bundle.features)),
    input_manifest: {
        revision_fingerprint: 'legacy-revision',
    },
    evidence_state: 'historical_unbound_input',
    canonical: false,
    predictor_eligible: false,
    evidence_warning:
        savedChannelRecordBinding.HISTORICAL_EVIDENCE_WARNING,
};
const legacyBindingResult =
    savedChannelRecordBinding.canonicalizeSavedChannelRecordBinding(
        legacySavedChannelRecord,
        legacySavedChannelRow,
        {
            allowPriorRevisionMigration: true,
            allowLegacyCacheMaterialization: true,
        }
    );
assert.strictEqual(
    legacyBindingResult.valid,
    true,
    legacyBindingResult.errors.join('; ')
);
assert.strictEqual(legacyBindingResult.legacyMaterialized, true);
assert.strictEqual(
    ledgerContract.validateScoreLedger(
        legacySavedChannelRecord.score_ledger
    ).valid,
    true
);
assert.strictEqual(
    legacySavedChannelRecord.score_ledger.ledger_sha256,
    legacySavedChannelRow.score_ledger.ledger_sha256
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        legacySavedChannelRecord,
        'steer'
    ),
    false
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        legacySavedChannelRow,
        'features'
    ),
    false
);
assert.strictEqual(
    manifestBinding.validateManifestRowBinding(
        legacySavedChannelRow
    ).valid,
    true
);
assert.strictEqual(
    legacySavedChannelRecord.score_record_sha256,
    legacySavedChannelRow.score_record_sha256
);

const priorBoundRecord = JSON.parse(
    JSON.stringify(legacySavedChannelRecord)
);
const priorBoundRow = JSON.parse(JSON.stringify(legacySavedChannelRow));
priorBoundRecord.score_record_sha256 =
    ledgerContract.priorScoreRecordBindingSha256V1(priorBoundRecord);
priorBoundRow.score_record_sha256 =
    priorBoundRecord.score_record_sha256;
priorBoundRow.manifest_row_sha256 =
    manifestBinding.manifestRowBindingSha256(priorBoundRow);
const priorBoundResult =
    savedChannelRecordBinding.canonicalizeSavedChannelRecordBinding(
        priorBoundRecord,
        priorBoundRow,
        {
            allowPriorRevisionMigration: true,
            allowPriorRecordBindingMigration: true,
            allowLegacyCacheMaterialization: true,
        }
    );
assert.strictEqual(
    priorBoundResult.valid,
    true,
    priorBoundResult.errors.join('; ')
);
assert.strictEqual(priorBoundResult.migratedPriorRecordBinding, true);
assert.strictEqual(
    priorBoundRecord.score_record_sha256,
    ledgerContract.scoreRecordBindingSha256(priorBoundRecord)
);
assert.strictEqual(
    priorBoundRow.score_record_sha256,
    priorBoundRecord.score_record_sha256
);

const partiallyMigratedRecord = JSON.parse(
    JSON.stringify(legacySavedChannelRecord)
);
const partiallyMigratedRow = JSON.parse(
    JSON.stringify(legacySavedChannelRow)
);
const archivedSourceRecordSha256 = 'f'.repeat(64);
partiallyMigratedRow.score_record_sha256 =
    archivedSourceRecordSha256;
partiallyMigratedRow.manifest_row_sha256 =
    manifestBinding.manifestRowBindingSha256(
        partiallyMigratedRow
    );
const rejectedPartialMigration =
    savedChannelRecordBinding.canonicalizeSavedChannelRecordBinding(
        JSON.parse(JSON.stringify(partiallyMigratedRecord)),
        JSON.parse(JSON.stringify(partiallyMigratedRow)),
        {
            allowPriorRevisionMigration: true,
            allowPriorRecordBindingMigration: true,
        }
    );
assert.strictEqual(rejectedPartialMigration.valid, false);
assert(
    rejectedPartialMigration.errors.includes(
        'saved-channel manifest points to another full record'
    )
);
const recoveredPartialMigration =
    savedChannelRecordBinding.canonicalizeSavedChannelRecordBinding(
        partiallyMigratedRecord,
        partiallyMigratedRow,
        {
            allowPriorRevisionMigration: true,
            allowPriorRecordBindingMigration: true,
            archivedStaleManifestPointerProof: {
                verified: true,
                videoId: partiallyMigratedRow.id,
                sourceScoreRecordSha256:
                    archivedSourceRecordSha256,
                sourceLedgerSha256:
                    partiallyMigratedRow.score_ledger.ledger_sha256,
                currentStoredScoreRecordSha256:
                    partiallyMigratedRecord.score_record_sha256,
                currentCanonicalLedgerSha256:
                    partiallyMigratedRecord.score_ledger.ledger_sha256,
            },
        }
    );
assert.strictEqual(
    recoveredPartialMigration.valid,
    true,
    recoveredPartialMigration.errors.join('; ')
);
assert.strictEqual(
    recoveredPartialMigration.recoveredArchivedPartialMigration,
    true
);

const conflictingSavedChannelRecord = {
    videoId: 'conflicting-channel-video',
    title: 'Conflicting saved channel record',
    steer: JSON.parse(JSON.stringify(bundle.addressed_steer)),
};
conflictingSavedChannelRecord.steer.visual_keep.est += 1;
const conflictingSavedChannelRow = {
    id: 'conflicting-channel-video',
    status: 'done',
    features: JSON.parse(JSON.stringify(bundle.features)),
    evidence_state: 'historical_unbound_input',
    canonical: false,
    predictor_eligible: false,
    evidence_warning:
        savedChannelRecordBinding.HISTORICAL_EVIDENCE_WARNING,
};
const conflictingBindingResult =
    savedChannelRecordBinding.canonicalizeSavedChannelRecordBinding(
        conflictingSavedChannelRecord,
        conflictingSavedChannelRow,
        {
            allowPriorRevisionMigration: true,
            allowLegacyCacheMaterialization: true,
        }
    );
assert.strictEqual(
    conflictingBindingResult.valid,
    true,
    'a legacy conflict remains a valid ledger with an unavailable coordinate'
);
const conflictingLedgerValidation = ledgerContract.validateScoreLedger(
    conflictingSavedChannelRecord.score_ledger
);
assert.strictEqual(conflictingLedgerValidation.valid, true);
const conflictingCell =
    conflictingLedgerValidation.entriesById.get(
        'shorts.stored.visual.keep'
    );
assert.strictEqual(conflictingCell.available, false);
assert.strictEqual(
    conflictingCell.unavailable_reason,
    'historical feature and steer caches disagree'
);

const record = {
    score_ledger: ledger,
    features: {
        ...bundle.features,
        'visual.keep': [-999, -999],
    },
};
const canonical = ledgerContract.scoreFeatureCell(record, 'visual.keep');
assert.strictEqual(canonical.ledgerPresent, true);
assert.strictEqual(canonical.valid, true);
assert.notStrictEqual(
    canonical.value,
    -999,
    'a denormalized feature cache must never override a present ledger'
);
assert.strictEqual(
    canonical.coordinateId,
    'shorts.stored.visual.keep'
);
const selected = displayContract.embeddingSteerSelection(
    {
        ...record,
        input_manifest: {
            domain: 'shorts_raw',
            display_preference: ['visual', 'together', 'text'],
        },
    },
    'keep',
    'shorts_raw'
);
assert.strictEqual(selected.origin, 'canonical-score-ledger');
assert.strictEqual(selected.coordinateId, 'shorts.stored.visual.keep');
assert.strictEqual(selected.value, canonical.value);
assert.strictEqual(selected.valueUnit, canonical.entry.unit);
assert.strictEqual(selected.percentile100, canonical.entry.percentile);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(selected, 'est'),
    false
);
assert.deepStrictEqual(
    ledgerContract.scoreLedgerValidationSummary(record),
    {
        state: 'canonical-valid',
        valid: true,
        ledger_sha256: ledger.ledger_sha256,
        errors: [],
        feature_contract_document_sha256:
            ledgerContract.FEATURE_CONTRACT_DOCUMENT_SHA256,
        current_feature_contract_document_sha256:
            ledgerContract.FEATURE_CONTRACT_DOCUMENT_SHA256,
        feature_contract_document_current: true,
        warnings: [],
        note: 'All displayed stored coordinates are read from this validated ledger. Its descriptive contract document is current.',
    }
);
assert.deepStrictEqual(
    savedChannelAnalysis.featureCell(record, 'visual.keep'),
    { value: canonical.value, percentile: canonical.percentile }
);
assert.deepStrictEqual(
    savedChannelValidation.featureCell(record, 'visual.keep'),
    { raw: canonical.value, percentile: canonical.percentile }
);

const corrupt = JSON.parse(JSON.stringify(record));
corrupt.score_ledger.entries[0].value += 1;
const rejected = ledgerContract.scoreFeatureCell(corrupt, 'visual.keep');
assert.strictEqual(rejected.ledgerPresent, true);
assert.strictEqual(rejected.valid, false);
assert.strictEqual(
    rejected.value,
    null,
    'an invalid present ledger must fail closed instead of using legacy data'
);
const corruptSummary =
    ledgerContract.scoreLedgerValidationSummary(corrupt);
assert.strictEqual(corruptSummary.state, 'canonical-invalid');
assert.strictEqual(corruptSummary.valid, false);
assert.strictEqual(corruptSummary.ledger_sha256, null);
assert(corruptSummary.errors.length > 0);

const legacy = ledgerContract.scoreFeatureCell({
    features: { 'visual.keep': [81.5, 88.2] },
}, 'visual.keep');
assert.strictEqual(legacy.ledgerPresent, false);
assert.strictEqual(legacy.valid, false);
assert.strictEqual(legacy.value, null);
assert.strictEqual(legacy.percentile, null);
const migrationCache = ledgerContract.scoreFeatureCell({
    features: { 'visual.keep': [81.5, 88.2] },
}, 'visual.keep', { allowLegacy: true });
assert.strictEqual(migrationCache.valid, false);
assert.strictEqual(migrationCache.state, 'legacy-migration-cache');
assert.strictEqual(migrationCache.value, 81.5);
assert.strictEqual(migrationCache.percentile, 88.2);
const migratedLedger =
    ledgerContract.materializeHistoricalScoreLedger({
        features: bundle.features,
        steer: bundle.addressed_steer,
    });
assert.strictEqual(
    ledgerContract.validateScoreLedger(migratedLedger).valid,
    true,
    'historical cached values must migrate into a canonical ledger'
);
const outOfRangeHistoricalFeatures = JSON.parse(JSON.stringify(
    bundle.features
));
const outOfRangeHistoricalSteer = JSON.parse(JSON.stringify(
    bundle.addressed_steer
));
outOfRangeHistoricalFeatures['visual.keep'] = [-0.001, 50];
outOfRangeHistoricalSteer.visual_keep.est = -0.001;
outOfRangeHistoricalSteer.visual_keep.pctile = 50;
const outOfRangeHistoricalLedger =
    ledgerContract.materializeHistoricalScoreLedger({
        features: outOfRangeHistoricalFeatures,
        steer: outOfRangeHistoricalSteer,
    });
const outOfRangeHistoricalEntry =
    outOfRangeHistoricalLedger.entries.find(
        entry => entry.coordinate_id === 'shorts.stored.visual.keep'
    );
assert.strictEqual(outOfRangeHistoricalEntry.available, false);
assert.strictEqual(outOfRangeHistoricalEntry.value, null);
assert.strictEqual(outOfRangeHistoricalEntry.percentile, null);
assert(
    outOfRangeHistoricalEntry.unavailable_reason.includes(
        'outside governance range'
    ),
    'legacy out-of-range values must materialize as unavailable'
);
assert.strictEqual(
    ledgerContract.validateScoreLedger(
        outOfRangeHistoricalLedger
    ).valid,
    true
);
const conflictingLegacySteer = JSON.parse(JSON.stringify(
    bundle.addressed_steer
));
conflictingLegacySteer.visual_keep.est += 10;
const conflictLedger =
    ledgerContract.materializeHistoricalScoreLedger({
        features: bundle.features,
        steer: conflictingLegacySteer,
    });
const conflictEntry = conflictLedger.entries.find(
    entry => entry.coordinate_id === 'shorts.stored.visual.keep'
);
assert.strictEqual(conflictEntry.available, false);
assert.strictEqual(
    conflictEntry.unavailable_reason,
    'historical feature and steer caches disagree'
);
assert.strictEqual(conflictEntry.provenance.status, 'conflict');
assert.strictEqual(
    ledgerContract.validateScoreLedger(conflictLedger).valid,
    true,
    'a legacy disagreement must be explicit unavailable evidence, not a chosen value'
);
const identityConflictSteer = JSON.parse(JSON.stringify(
    bundle.addressed_steer
));
identityConflictSteer.visual_keep.coordinate_id =
    'shorts.stored.text.keep';
const identityConflictLedger =
    ledgerContract.materializeHistoricalScoreLedger({
        features: bundle.features,
        steer: identityConflictSteer,
    });
const identityConflictEntry = identityConflictLedger.entries.find(
    entry => entry.coordinate_id === 'shorts.stored.visual.keep'
);
assert.strictEqual(identityConflictEntry.available, false);
assert(
    identityConflictEntry.unavailable_reason.includes(
        'coordinate identity conflicts'
    )
);
const priorLedger = JSON.parse(JSON.stringify(ledger));
const approvedPriorRevision =
    ledgerContract.GOVERNANCE.compatibility.migratableLedgerRevisions[0];
priorLedger.ledger_version = approvedPriorRevision.ledgerVersion;
priorLedger.feature_contract_version =
    approvedPriorRevision.featureContractVersion;
priorLedger.feature_contract_identity_schema_version =
    approvedPriorRevision.featureContractIdentitySchemaVersion;
priorLedger.feature_contract_sha256 =
    approvedPriorRevision.featureContractSha256;
priorLedger.feature_contract_document_sha256 =
    approvedPriorRevision.featureContractDocumentSha256;
priorLedger.coordinate_governance_version =
    approvedPriorRevision.coordinateGovernanceVersion;
priorLedger.coordinate_governance_sha256 =
    approvedPriorRevision.coordinateGovernanceSha256;
priorLedger.entries
    .filter(entry => entry.target === 'ret5')
    .forEach(entry => {
        entry.unit =
            approvedPriorRevision.scoreValueMigration.fromUnit;
    });
delete priorLedger.ledger_sha256;
priorLedger.ledger_sha256 =
    ledgerContract.sha256Canonical(priorLedger);
const priorValidation =
    ledgerContract.validatePriorCanonicalScoreLedger(priorLedger);
assert.strictEqual(
    priorValidation.valid,
    true,
    priorValidation.errors.join('; ')
);
const outOfRangePriorLedger = JSON.parse(JSON.stringify(priorLedger));
const outOfRangePriorEntry = outOfRangePriorLedger.entries.find(
    entry => entry.coordinate_id === 'shorts.stored.visual.gt10M'
);
outOfRangePriorEntry.value = 1.001;
outOfRangePriorLedger.values_by_id[
    outOfRangePriorEntry.coordinate_id
] = 1.001;
rehashLedger(outOfRangePriorLedger);
const outOfRangePriorValidation =
    ledgerContract.validatePriorCanonicalScoreLedger(
        outOfRangePriorLedger
    );
assert.strictEqual(outOfRangePriorValidation.valid, false);
assert(
    outOfRangePriorValidation.errors.some(error => (
        error.includes('outside governance range')
    )),
    'prior canonical values outside current unit governance must not migrate'
);
assert.strictEqual(
    ledgerContract.migratePriorCanonicalScoreLedger(
        outOfRangePriorLedger
    ),
    null
);
const outOfRangePriorRet5Ledger = JSON.parse(JSON.stringify(priorLedger));
const outOfRangePriorRet5Entry = outOfRangePriorRet5Ledger.entries.find(
    entry => entry.coordinate_id === 'shorts.stored.visual.ret5'
);
outOfRangePriorRet5Entry.value = 150;
outOfRangePriorRet5Ledger.values_by_id[
    outOfRangePriorRet5Entry.coordinate_id
] = 150;
rehashLedger(outOfRangePriorRet5Ledger);
const outOfRangePriorRet5Validation =
    ledgerContract.validatePriorCanonicalScoreLedger(
        outOfRangePriorRet5Ledger
    );
assert.strictEqual(outOfRangePriorRet5Validation.valid, true);
assert.strictEqual(
    outOfRangePriorRet5Validation.migratedLedger.values_by_id[
        outOfRangePriorRet5Entry.coordinate_id
    ],
    150,
    'historical rewatch-capable ret5 values must survive the unit-label correction exactly'
);
const upgradedLedger =
    ledgerContract.migratePriorCanonicalScoreLedger(priorLedger);
assert.strictEqual(
    ledgerContract.validateScoreLedger(upgradedLedger).valid,
    true
);
assert.deepStrictEqual(
    upgradedLedger.values_by_id,
    ledger.values_by_id,
    'governance migration must preserve every score value exactly'
);
assert.deepStrictEqual(
    upgradedLedger.percentiles_by_id,
    ledger.percentiles_by_id,
    'governance migration must preserve every percentile exactly'
);
assert(
    upgradedLedger.entries
        .filter(entry => entry.target === 'ret5')
        .every(
            entry => (
                entry.unit
                === 'retention_percent_rewatch_capable'
            )
        ),
    'migration must relabel every ret5 entry to the governed unit'
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        upgradedLedger,
        'migration_provenance'
    ),
    false,
    'migration history must not make semantically identical score ledgers hash differently'
);
const unknownPriorRevision = JSON.parse(JSON.stringify(priorLedger));
unknownPriorRevision.coordinate_governance_sha256 = 'c'.repeat(64);
delete unknownPriorRevision.ledger_sha256;
unknownPriorRevision.ledger_sha256 =
    ledgerContract.sha256Canonical(unknownPriorRevision);
const unknownPriorValidation =
    ledgerContract.validatePriorCanonicalScoreLedger(
        unknownPriorRevision
    );
assert.strictEqual(unknownPriorValidation.valid, false);
assert(
    unknownPriorValidation.errors.some(error => (
        /immutable migration allowlist/.test(error)
    )),
    'an invented prior revision must fail closed'
);
const pythonUpgradedLedger = JSON.parse(execFileSync(
    'python3',
    [
        '-c',
        [
            'import json,sys',
            'from shorts_score_ledger import migrate_prior_canonical_score_ledger',
            'print(json.dumps(migrate_prior_canonical_score_ledger(json.load(sys.stdin))))',
        ].join('\n'),
    ],
    {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify(priorLedger),
    }
));
assert.deepStrictEqual(
    pythonUpgradedLedger,
    upgradedLedger,
    'Python and JavaScript must migrate the same prior ledger identically'
);
const tamperedPrior = JSON.parse(JSON.stringify(priorLedger));
tamperedPrior.entries[0].value += 1;
assert.strictEqual(
    ledgerContract.validatePriorCanonicalScoreLedger(
        tamperedPrior
    ).valid,
    false,
    'a prior ledger with a stale content hash must fail closed'
);
const relabeledPrior = JSON.parse(JSON.stringify(priorLedger));
relabeledPrior.entries[0].group = 'text';
delete relabeledPrior.ledger_sha256;
relabeledPrior.ledger_sha256 =
    ledgerContract.sha256Canonical(relabeledPrior);
assert.strictEqual(
    ledgerContract.validatePriorCanonicalScoreLedger(
        relabeledPrior
    ).valid,
    false,
    'a self-consistent prior hash cannot hide changed coordinate semantics'
);
const invalidCurrentLedger = JSON.parse(JSON.stringify(ledger));
invalidCurrentLedger.entries[0].group = 'text';
delete invalidCurrentLedger.ledger_sha256;
invalidCurrentLedger.ledger_sha256 =
    ledgerContract.sha256Canonical(invalidCurrentLedger);
assert.strictEqual(
    ledgerContract.migratePriorCanonicalScoreLedger(
        invalidCurrentLedger
    ),
    null,
    'a malformed current ledger must not be laundered through migration'
);
assert.deepStrictEqual(
    ledgerContract.scoreLedgerValidationSummary({
        features: { 'visual.keep': [81.5, 88.2] },
    }),
    {
        state: 'legacy-missing',
        valid: null,
        ledger_sha256: null,
        errors: [],
        note: 'No canonical ledger was stored. Compatibility fields may be used only to migrate this historical record.',
    }
);

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const analysis = fs.readFileSync(
    path.join(ROOT, 'buildings/jarvis/saved-channel-analysis.js'),
    'utf8'
);
const validationSource = fs.readFileSync(
    path.join(ROOT, 'buildings/jarvis/saved-channel-validation.js'),
    'utf8'
);
const retentionUi = fs.readFileSync(
    path.join(ROOT, 'buildings/jarvis/jarvis-retention.js'),
    'utf8'
);
const factorized = fs.readFileSync(
    path.join(
        ROOT,
        'buildings/jarvis/principles-lab/quant/factorized-validation.js'
    ),
    'utf8'
);
assert(
    server.includes('shortsScoreLedger.validateScoreLedger(ledger)'),
    'the HTTP scorer boundary must use the shared ledger validator'
);
assert(
    server.includes('shortsScoreLedger.scoreLedgerValidationSummary(record)'),
    'persisted record reads must expose the shared ledger validation state'
);
assert(
    server.includes('videos: (manifest.videos || []).map('),
    'saved-channel manifest reads must validate every persisted score ledger'
);
assert(
    server.includes('const ledger = score && score.score_ledger;'),
    'the grinder must resolve its threshold from the ledger'
);
for (const [name, source] of [
    ['saved-channel analysis', analysis],
    ['saved-channel validation', validationSource],
    ['factorized validation', factorized],
]) {
    assert(
        source.includes('scoreFeatureCell'),
        `${name} must use the shared ledger reader`
    );
}
assert(
    retentionUi.includes(
        'ledgerSha256 !== computedLedgerSha256'
    ),
    'browser records must independently verify the canonical ledger content hash'
);
assert.doesNotMatch(
    retentionUi,
    /!validation\s*\|\|\s*validation\.valid\s*!==\s*true/,
    'an omitted diagnostic wrapper must not suppress a self-validated ledger'
);
assert(
    server.includes("state: 'canonical-valid'")
        && server.includes('ledger_sha256: ledger.ledger_sha256'),
    'fresh scorer responses must carry the same validation proof as persisted records'
);
assert(
    server.includes(
        'result.score_record_sha256 =\n'
        + '        savedHookScoreRecordSha256(result);'
    )
        && server.includes("state: 'verified'")
        && server.includes(
            'calculated_sha256: result.score_record_sha256'
        ),
    'fresh scorer responses must be bound to the same immutable score-record identity as persisted cards'
);
assert(
    retentionUi.includes('score_ledger_validation: rec.score_ledger_validation || null'),
    'saved-hook detail must preserve the persisted ledger validation state'
);
assert(
    retentionUi.includes(
        'This saved score has invalid persisted ledger '
    )
        && retentionUi.includes(
            "'It was not silently recalculated.'"
        ),
    'an invalid persisted saved score must fail closed instead of being re-scored'
);
assert.doesNotMatch(
    retentionUi,
    /uploads\.filter\(rawUploadIsScored\)\.slice\(-1\)/,
    'an explicit score-card selection must never fall back to another upload'
);
assert(
    retentionUi.includes(
        'let scoreIndex = generatedScores.length - 1;'
    ),
    'saving a regenerated attempt must select its newest exact score'
);
assert.doesNotMatch(
    retentionUi,
    /const scored = \(st\.rawUploads \|\| \[\]\)\.find/,
    'generated saves must not select the oldest matching score'
);
assert(
    server.includes(
        'if (required && !available) {\n'
        + '                fatal.push('
    ),
    'fresh scorer responses must fail closed when a required coordinate is unavailable'
);

console.log(JSON.stringify({
    ok: true,
    coordinates: validation.entries.length,
    available: ledger.available_count,
    crossLanguageHash: ledger.ledger_sha256,
    failClosed: true,
}));
