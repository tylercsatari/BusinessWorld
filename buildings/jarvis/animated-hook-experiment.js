'use strict';

const crypto = require('crypto');
const {
    canonicalJsonBytes,
    sha256Bytes,
} = require('./canonical-json-artifact');

const SCHEMA = 'animated-hook-batch-experiment-v1';
const SCHEMA_VERSION = 1;
const DEFAULT_COORDINATE_ID = 'shorts.channel-free.concat.keep';
const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SAVED_HOOK_ID_PATTERN = /^hk[a-z0-9]{4,40}$/;

function hashPayload(experiment) {
    const payload = { ...(experiment || {}) };
    delete payload.experiment_sha256;
    return payload;
}

function normalizedExperiment(input) {
    const source = input && typeof input === 'object' ? input : {};
    const id = String(source.id || '').trim().toLowerCase();
    if (!ID_PATTERN.test(id)) {
        throw new TypeError('animated hook experiment id is invalid');
    }
    const threshold = Number(source.threshold_value_0_100);
    const minimum = Number.parseInt(source.minimum_verified_attempts, 10);
    const winners = Number.parseInt(source.winner_target, 10);
    const batchSize = Number.parseInt(source.batch_size, 10);
    const requests = Array.isArray(source.requests)
        ? source.requests.map(request => ({
            rid: String(request && request.rid || ''),
            count: Number.parseInt(request && request.count, 10),
            created_at_ms: Number(request && request.created_at_ms) || 0,
        }))
        : [];
    return {
        ...source,
        schema: SCHEMA,
        schema_version: SCHEMA_VERSION,
        id,
        status: ['running', 'complete', 'stopped', 'error']
            .includes(source.status)
            ? source.status
            : 'running',
        threshold_coordinate_id: DEFAULT_COORDINATE_ID,
        threshold_unit: 'predicted_keep_percent',
        threshold_value_0_100:
            Number.isFinite(threshold)
            && threshold >= 0
            && threshold <= 100
                ? threshold
                : 80,
        minimum_verified_attempts:
            Number.isSafeInteger(minimum) && minimum >= 1
                ? minimum
                : 100,
        winner_target:
            Number.isSafeInteger(winners) && winners >= 1
                ? winners
                : 10,
        batch_size:
            Number.isSafeInteger(batchSize)
                ? Math.max(1, Math.min(8, batchSize))
                : 8,
        image_model: DEFAULT_IMAGE_MODEL,
        strict_image_model: true,
        animation: true,
        render_mode: 'single-panel',
        folder_name: String(
            source.folder_name || 'Animated Hook Grind'
        ).trim().replace(/\s+/g, ' ').slice(0, 120),
        requests,
        stats: source.stats && typeof source.stats === 'object'
            ? { ...source.stats }
            : {
                generated_attempts: 0,
                verified_unique_attempts: 0,
                winner_count: 0,
                saved_count: 0,
                failed_count: 0,
                highest_score: null,
            },
        created_at_ms: Number(source.created_at_ms) || Date.now(),
        updated_at_ms: Number(source.updated_at_ms) || Date.now(),
    };
}

function bindExperiment(input) {
    const bound = normalizedExperiment(input);
    delete bound.experiment_sha256;
    bound.experiment_sha256 = sha256Bytes(
        canonicalJsonBytes(hashPayload(bound))
    );
    return bound;
}

function validateExperiment(experiment) {
    const errors = [];
    let normalized = null;
    try {
        normalized = normalizedExperiment(experiment);
    } catch (error) {
        errors.push(error.message);
    }
    if (normalized) {
        if (
            experiment.schema !== SCHEMA
            || experiment.schema_version !== SCHEMA_VERSION
        ) errors.push('animated hook experiment schema is invalid');
        const requestIds = new Set();
        for (const request of normalized.requests) {
            if (!/^ahb[a-f0-9]{20,28}$/.test(request.rid)) {
                errors.push('animated hook experiment request id is invalid');
            }
            if (
                !Number.isSafeInteger(request.count)
                || request.count < 1
                || request.count > 8
            ) errors.push('animated hook experiment request count is invalid');
            if (requestIds.has(request.rid)) {
                errors.push('animated hook experiment request ids are duplicated');
            }
            requestIds.add(request.rid);
        }
        const calculated = sha256Bytes(
            canonicalJsonBytes(hashPayload(experiment))
        );
        if (
            !HASH_PATTERN.test(String(experiment.experiment_sha256 || ''))
            || experiment.experiment_sha256 !== calculated
        ) errors.push('animated hook experiment hash is invalid');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        experiment: errors.length === 0 ? normalized : null,
    };
}

function requestId(experimentId, index) {
    const digest = crypto.createHash('sha256')
        .update(`${experimentId}:${index}`)
        .digest('hex')
        .slice(0, 22);
    return `ahb${digest}`;
}

function normalizedPremise(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function exactHash(value) {
    return HASH_PATTERN.test(String(value || ''));
}

function verifiedAttempt(attempt, experiment) {
    const score = Number(
        attempt && attempt.channel_free_concat_keep_percent
    );
    return !!(
        attempt
        && attempt.score_verified === true
        && attempt.score_coordinate_id === DEFAULT_COORDINATE_ID
        && Number.isFinite(score)
        && score >= 0
        && score <= 100
        && exactHash(attempt.score_ledger_sha256)
        && exactHash(attempt.score_record_sha256)
        && exactHash(attempt.score_model_artifact_sha256)
        && attempt.panel_model === experiment.image_model
        && attempt.requested_image_model === experiment.image_model
        && attempt.strict_image_model === true
        && SAVED_HOOK_ID_PATTERN.test(
            String(attempt.saved_hook_id || '')
        )
        && normalizedPremise(attempt.premise)
    );
}

function summarize(experiment, groups) {
    const attempts = [];
    for (const group of groups || []) {
        for (const attempt of (
            Array.isArray(group && group.attempts)
                ? group.attempts
                : []
        )) attempts.push(attempt);
    }
    const unique = new Map();
    let failed = 0;
    for (const attempt of attempts) {
        if (!verifiedAttempt(attempt, experiment)) {
            if (attempt && attempt.status === 'done') failed += 1;
            continue;
        }
        const key = normalizedPremise(attempt.premise);
        const existing = unique.get(key);
        if (
            !existing
            || Number(attempt.channel_free_concat_keep_percent)
                > Number(existing.channel_free_concat_keep_percent)
        ) unique.set(key, attempt);
    }
    const verified = [...unique.values()];
    const scores = verified.map(attempt => Number(
        attempt.channel_free_concat_keep_percent
    ));
    return {
        generated_attempts: attempts.length,
        verified_unique_attempts: verified.length,
        winner_count: scores.filter(
            score => score >= experiment.threshold_value_0_100
        ).length,
        saved_count: verified.filter(attempt => (
            SAVED_HOOK_ID_PATTERN.test(
                String(attempt.saved_hook_id || '')
            )
        )).length,
        failed_count: failed,
        highest_score: scores.length
            ? Math.max(...scores)
            : null,
    };
}

module.exports = {
    SCHEMA,
    SCHEMA_VERSION,
    DEFAULT_COORDINATE_ID,
    DEFAULT_IMAGE_MODEL,
    bindExperiment,
    validateExperiment,
    requestId,
    verifiedAttempt,
    summarize,
};
