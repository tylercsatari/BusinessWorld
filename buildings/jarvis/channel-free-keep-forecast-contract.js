'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(
    __dirname,
    'predictor-lab',
    'channel-free-keep-model-v1.json'
);
const MODEL_BYTES = fs.readFileSync(MODEL_PATH);
const MODEL = JSON.parse(MODEL_BYTES.toString('utf8'));
const MODEL_SHA256 = crypto.createHash('sha256')
    .update(MODEL_BYTES)
    .digest('hex');
const SIGNALS = Object.freeze(['visual', 'text', 'together', 'concat']);
const DISPLAY_ORDER = Object.freeze(['concat', 'visual', 'together', 'text']);
const COORDINATE_IDS = Object.freeze(Object.fromEntries(
    SIGNALS.map(signal => [
        signal,
        MODEL.models
        && MODEL.models[signal]
        && MODEL.models[signal].coordinateId,
    ])
));

function finite(value) {
    return value !== null
        && value !== undefined
        && value !== ''
        && Number.isFinite(Number(value));
}

function exactSha256(value) {
    return typeof value === 'string'
        && /^[a-f0-9]{64}$/.test(value);
}

function validateModelArtifact() {
    const errors = [];
    if (MODEL.schema !== 'channel-free-keep-model-v1') {
        errors.push('channel-free model schema is invalid');
    }
    if (!MODEL.runId || !MODEL.selectedSignal) {
        errors.push('channel-free model identity is incomplete');
    }
    if (
        !MODEL.training
        || MODEL.training.channelInformation !== null
        || Number(MODEL.training.rows) < 1
        || !exactSha256(MODEL.training.identityHash)
    ) {
        errors.push('channel-free training identity is invalid');
    }
    if (
        !MODEL.embedding
        || MODEL.embedding.model !== 'gemini-embedding-2'
        || Number(MODEL.embedding.dimensionsPerModality) !== 1536
    ) {
        errors.push('channel-free embedding contract is invalid');
    }
    for (const signal of SIGNALS) {
        const model = MODEL.models && MODEL.models[signal];
        const expectedDimensions = signal === 'concat' ? 4608 : 1536;
        if (
            !model
            || model.signal !== signal
            || model.coordinateId
                !== `shorts.channel-free.${signal}.keep`
            || Number(model.inputDimensions) !== expectedDimensions
            || !finite(model.ridgeAlpha)
            || !Array.isArray(model.coefficients)
            || model.coefficients.length !== expectedDimensions
            || !model.coefficients.every(finite)
            || !finite(model.intercept)
            || !Array.isArray(model.percentileReference)
            || !model.percentileReference.length
            || !model.percentileReference.every(finite)
            || model.percentileReference.some(
                (value, index, values) => (
                    index > 0 && Number(value) < Number(values[index - 1])
                )
            )
            || model.outputTransform !== 'clip(linear_prediction, 0, 100)'
        ) {
            errors.push(`channel-free ${signal} model is invalid`);
        }
    }
    if (!exactSha256(MODEL_SHA256)) {
        errors.push('channel-free model SHA-256 is invalid');
    }
    return {
        valid: errors.length === 0,
        errors,
        modelSha256: MODEL_SHA256,
        runId: MODEL.runId || null,
    };
}

const MODEL_AUDIT = Object.freeze(validateModelArtifact());
if (!MODEL_AUDIT.valid) {
    throw new Error(MODEL_AUDIT.errors.join('; '));
}

function validateChannelFreeKeepForecasts(value, expected = {}) {
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            valid: false,
            errors: ['channel-free keep forecasts are missing'],
            outputs: {},
        };
    }
    if (value.schema !== 'shorts-channel-free-keep-forecasts-v1') {
        errors.push('channel-free forecast schema is invalid');
    }
    if (value.model_artifact_sha256 !== MODEL_SHA256) {
        errors.push('channel-free forecast model SHA-256 does not match');
    }
    if (value.model_run_id !== MODEL.runId) {
        errors.push('channel-free forecast run identity does not match');
    }
    if (value.selected_signal !== MODEL.selectedSignal) {
        errors.push('channel-free selected signal does not match');
    }
    if (value.source !== 'live_frozen_channel_free_model_score') {
        errors.push('channel-free forecast source is invalid');
    }
    if (value.channel_information !== null) {
        errors.push('channel-free forecast contains creator information');
    }
    const outputs = value.outputs && typeof value.outputs === 'object'
        ? value.outputs
        : {};
    if (
        JSON.stringify(Object.keys(outputs).sort())
        !== JSON.stringify(SIGNALS.slice().sort())
    ) {
        errors.push('channel-free forecast output inventory is incomplete');
    }
    const requireText = expected.requireText === true;
    for (const signal of SIGNALS) {
        const output = outputs[signal];
        const required = ['visual', 'together'].includes(signal)
            || requireText;
        if (!output || typeof output !== 'object') {
            errors.push(`channel-free ${signal} output is missing`);
            continue;
        }
        if (
            output.coordinate_id !== COORDINATE_IDS[signal]
            || output.signal !== signal
            || output.kind !== 'channel_free_keep_rate_percent'
            || output.unit !== 'percent'
            || output.percentile_unit !== 'percentile_0_100'
            || output.model_artifact_sha256 !== MODEL_SHA256
            || output.model_run_id !== MODEL.runId
            || output.source
                !== 'live_frozen_channel_free_model_score'
            || output.channel_information !== null
            || output.calibration_scope !== 'pooled_global_no_creator'
            || !String(output.input || '').trim()
            || output.selected !== (MODEL.selectedSignal === signal)
            || !finite(output.oof_mae)
            || !finite(output.oof_spearman)
        ) {
            errors.push(`channel-free ${signal} output identity is invalid`);
        }
        if (output.available === true) {
            if (!required) {
                errors.push(
                    `channel-free ${signal} used absent transcript input`
                );
            }
            const raw = output.raw != null ? output.raw : output.est;
            if (
                !finite(raw)
                || Number(raw) < 0
                || Number(raw) > 100
                || !finite(output.est)
                || Number(output.est) !== Number(raw)
                || !finite(output.pctile)
                || Number(output.pctile) < 0
                || Number(output.pctile) > 100
                || output.unavailable_reason != null
            ) {
                errors.push(`channel-free ${signal} value is invalid`);
            }
        } else {
            if (
                required
                || output.available !== false
                || output.raw != null
                || output.est != null
                || output.pctile != null
                || !String(output.unavailable_reason || '').trim()
            ) {
                errors.push(`channel-free ${signal} is unexpectedly unavailable`);
            }
        }
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        outputs,
        modelSha256: MODEL_SHA256,
        runId: MODEL.runId,
        selectedSignal: MODEL.selectedSignal,
    };
}

module.exports = {
    COORDINATE_IDS,
    DISPLAY_ORDER,
    MODEL,
    MODEL_AUDIT,
    MODEL_PATH,
    MODEL_SHA256,
    SIGNALS,
    validateChannelFreeKeepForecasts,
};
