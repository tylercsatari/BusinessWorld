'use strict';

const ACTIVE_PREDICTION_STATES = new Set([
    'starting',
    'processing',
]);

function errorMessage(error) {
    return String(error && error.message || error || 'provider request failed');
}

function isPermanentError(error) {
    if (!error) return false;
    if (error.permanent === true) return true;
    if (error.retryable === false) return true;
    if (error.retryable === true) return false;
    if (
        error.code === 'HOOK_GENERATION_STOPPED'
        || error.code === 'QUEUE_LEASE_OWNERSHIP_UNCERTAIN'
    ) return true;
    const status = Number(error.statusCode || error.providerStatus);
    if (
        Number.isFinite(status)
        && status >= 400
        && status < 500
        && ![408, 409, 425, 429].includes(status)
    ) return true;
    return /(?:out of credits|insufficient.quota|billing|spend limit|credential|unauthori[sz]ed|forbidden|permission|not configured|missing on server|refusing to fall back|invalid (?:model|version|input)|moderation blocked)/i
        .test(errorMessage(error));
}

function retryDelayMs(failureCount) {
    const attempt = Math.max(1, Number(failureCount) || 1);
    return Math.min(15000, 1000 * (2 ** Math.min(4, attempt - 1)));
}

function stoppedError() {
    const error = new Error('generation stopped by you');
    error.code = 'HOOK_GENERATION_STOPPED';
    error.statusCode = 409;
    error.permanent = true;
    return error;
}

function deadlineError(context, lastError) {
    const detail = lastError
        ? ` Last status-check error: ${errorMessage(lastError).slice(0, 220)}`
        : '';
    const error = new Error(
        `${context || 'provider prediction'} did not finish before its processing deadline.${detail}`
    );
    error.code = 'PROVIDER_PREDICTION_DEADLINE';
    error.statusCode = 504;
    error.retryable = true;
    return error;
}

async function stopRequested(shouldStop) {
    if (!shouldStop) return false;
    try {
        return await shouldStop() === true;
    } catch (error) {
        if (isPermanentError(error)) throw error;
        return false;
    }
}

async function notify(callback, ...args) {
    if (!callback) return;
    try {
        await callback(...args);
    } catch (error) {
        if (isPermanentError(error)) throw error;
    }
}

async function pollPrediction({
    prediction,
    fetchStatus,
    deadlineAtMs,
    intervalMs = 2500,
    onHeartbeat,
    shouldStop,
    context = 'provider prediction',
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    if (!prediction || typeof prediction !== 'object') {
        throw new TypeError('an initial provider prediction is required');
    }
    if (typeof fetchStatus !== 'function') {
        throw new TypeError('fetchStatus must be a function');
    }
    const deadline = Number(deadlineAtMs);
    if (!Number.isFinite(deadline)) {
        throw new TypeError('deadlineAtMs must be finite');
    }
    let current = prediction;
    let consecutiveFailures = 0;
    let lastError = null;
    while (
        ACTIVE_PREDICTION_STATES.has(String(current.status || ''))
        && now() < deadline
    ) {
        if (await stopRequested(shouldStop)) throw stoppedError();
        const delay = consecutiveFailures
            ? retryDelayMs(consecutiveFailures)
            : Math.max(0, Number(intervalMs) || 0);
        if (delay) await sleep(delay);
        if (await stopRequested(shouldStop)) throw stoppedError();
        try {
            const next = await fetchStatus(current);
            if (!next || typeof next !== 'object') {
                const error = new Error(
                    `${context} returned no status document`
                );
                error.retryable = true;
                throw error;
            }
            current = next;
            consecutiveFailures = 0;
            lastError = null;
            await notify(onHeartbeat, {
                kind: 'status',
                status: String(current.status || 'unknown'),
                consecutiveFailures: 0,
                error: null,
            });
        } catch (error) {
            if (isPermanentError(error)) throw error;
            lastError = error;
            consecutiveFailures += 1;
            await notify(onHeartbeat, {
                kind: 'recovering',
                status: String(current.status || 'unknown'),
                consecutiveFailures,
                error: errorMessage(error),
            });
        }
    }
    if (ACTIVE_PREDICTION_STATES.has(String(current.status || ''))) {
        throw deadlineError(context, lastError);
    }
    return current;
}

async function retryTransient(operation, {
    maxAttempts = 3,
    deadlineAtMs = null,
    onRetry,
    shouldStop,
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    if (typeof operation !== 'function') {
        throw new TypeError('operation must be a function');
    }
    const boundedAttempts = Math.max(1, Number(maxAttempts) || 1);
    const deadline = Number(deadlineAtMs);
    const hasDeadline = deadlineAtMs != null && Number.isFinite(deadline);
    let attempt = 0;
    let lastError = null;
    while (
        attempt < boundedAttempts
        && (!hasDeadline || now() < deadline)
    ) {
        if (await stopRequested(shouldStop)) throw stoppedError();
        attempt += 1;
        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            if (isPermanentError(error)) throw error;
            if (
                attempt >= boundedAttempts
                || (hasDeadline && now() >= deadline)
            ) break;
            await notify(onRetry, error, attempt);
            await sleep(retryDelayMs(attempt));
        }
    }
    throw lastError || deadlineError('provider operation');
}

module.exports = Object.freeze({
    ACTIVE_PREDICTION_STATES,
    errorMessage,
    isPermanentError,
    pollPrediction,
    retryDelayMs,
    retryTransient,
});
