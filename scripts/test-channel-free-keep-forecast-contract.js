#!/usr/bin/env node
'use strict';

const assert = require('assert');
const contract = require(
    '../buildings/jarvis/channel-free-keep-forecast-contract'
);

function fixture(requireText = true) {
    return {
        schema: 'shorts-channel-free-keep-forecasts-v1',
        model_artifact_path:
            'buildings/jarvis/predictor-lab/channel-free-keep-model-v1.json',
        model_artifact_sha256: contract.MODEL_SHA256,
        model_run_id: contract.MODEL.runId,
        selected_signal: contract.MODEL.selectedSignal,
        source: 'live_frozen_channel_free_model_score',
        channel_information: null,
        outputs: Object.fromEntries(contract.SIGNALS.map((signal, index) => {
            const available = ['visual', 'together'].includes(signal)
                || requireText;
            return [signal, {
                coordinate_id: contract.COORDINATE_IDS[signal],
                signal,
                kind: 'channel_free_keep_rate_percent',
                unit: 'percent',
                percentile_unit: 'percentile_0_100',
                input: `canonical ${signal} fixture`,
                channel_information: null,
                calibration_scope: 'pooled_global_no_creator',
                source: 'live_frozen_channel_free_model_score',
                model_artifact_sha256: contract.MODEL_SHA256,
                model_run_id: contract.MODEL.runId,
                selected: signal === contract.MODEL.selectedSignal,
                oof_mae: 7.1 + index / 10,
                oof_spearman: 0.5 + index / 100,
                available,
                raw: available ? 60 + index : null,
                est: available ? 60 + index : null,
                pctile: available ? 50 + index : null,
                unavailable_reason: available
                    ? null
                    : 'A coherent first-5-second transcript is required.',
            }];
        })),
    };
}

assert.strictEqual(contract.MODEL_AUDIT.valid, true);
assert.strictEqual(contract.SIGNALS.length, 4);
assert.deepStrictEqual(
    contract.DISPLAY_ORDER,
    ['concat', 'visual', 'together', 'text']
);

const complete = contract.validateChannelFreeKeepForecasts(
    fixture(true),
    { requireText: true }
);
assert.deepStrictEqual(complete.errors, []);
assert.strictEqual(complete.valid, true);

const silent = contract.validateChannelFreeKeepForecasts(
    fixture(false),
    { requireText: false }
);
assert.strictEqual(silent.valid, true);
assert.strictEqual(silent.outputs.visual.available, true);
assert.strictEqual(silent.outputs.together.available, true);
assert.strictEqual(silent.outputs.text.available, false);
assert.strictEqual(silent.outputs.concat.available, false);

const creatorLeak = fixture(true);
creatorLeak.outputs.concat.channel_information = 'tyler';
assert.strictEqual(
    contract.validateChannelFreeKeepForecasts(
        creatorLeak,
        { requireText: true }
    ).valid,
    false
);

const phantomText = fixture(false);
phantomText.outputs.text.available = true;
phantomText.outputs.text.raw = 70;
phantomText.outputs.text.est = 70;
phantomText.outputs.text.pctile = 80;
phantomText.outputs.text.unavailable_reason = null;
assert.strictEqual(
    contract.validateChannelFreeKeepForecasts(
        phantomText,
        { requireText: false }
    ).valid,
    false
);

const tampered = fixture(true);
tampered.outputs.visual.raw += 1;
assert.strictEqual(
    contract.validateChannelFreeKeepForecasts(
        tampered,
        { requireText: true }
    ).valid,
    false
);

console.log(JSON.stringify({
    ok: true,
    modelSha256: contract.MODEL_SHA256,
    runId: contract.MODEL.runId,
    signals: contract.DISPLAY_ORDER,
    silentAvailability: Object.fromEntries(
        contract.SIGNALS.map(signal => [
            signal,
            silent.outputs[signal].available,
        ])
    ),
}));
