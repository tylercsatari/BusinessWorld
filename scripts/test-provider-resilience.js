#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const resilience = require(
    '../buildings/jarvis/provider-resilience'
);

async function main() {
    let clock = 0;
    let fetchCalls = 0;
    const seenIds = [];
    const heartbeats = [];
    let heartbeatWriteFailures = 0;
    const result = await resilience.pollPrediction({
        prediction: {
            id: 'prediction-1',
            status: 'processing',
        },
        deadlineAtMs: 60000,
        now: () => clock,
        sleep: async milliseconds => {
            clock += milliseconds;
        },
        fetchStatus: async current => {
            fetchCalls += 1;
            seenIds.push(current.id);
            if (fetchCalls === 1) {
                const error = new Error('This operation was aborted');
                error.name = 'AbortError';
                throw error;
            }
            if (fetchCalls === 2) {
                return { ...current, status: 'processing' };
            }
            return {
                ...current,
                status: 'succeeded',
                output: [{ premise: 'Recovered hook' }],
            };
        },
        onHeartbeat: event => {
            heartbeats.push(event);
            if (heartbeatWriteFailures === 0) {
                heartbeatWriteFailures += 1;
                const error = new Error(
                    'temporary progress-store interruption'
                );
                error.retryable = true;
                throw error;
            }
        },
    });
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(fetchCalls, 3);
    assert.deepStrictEqual(
        seenIds,
        ['prediction-1', 'prediction-1', 'prediction-1'],
        'a status abort must resume the same prediction instead of creating another one'
    );
    assert.strictEqual(
        heartbeats.filter(event => event.kind === 'recovering').length,
        1
    );
    assert.strictEqual(heartbeatWriteFailures, 1);

    let permanentCalls = 0;
    await assert.rejects(
        resilience.pollPrediction({
            prediction: { id: 'prediction-2', status: 'processing' },
            deadlineAtMs: 10000,
            now: () => 0,
            sleep: async () => {},
            fetchStatus: async () => {
                permanentCalls += 1;
                const error = new Error('credential rejected');
                error.statusCode = 401;
                throw error;
            },
        }),
        /credential rejected/
    );
    assert.strictEqual(permanentCalls, 1);

    let retryCalls = 0;
    const retryNotifications = [];
    const retried = await resilience.retryTransient(
        async () => {
            retryCalls += 1;
            if (retryCalls < 3) {
                const error = new Error('temporary provider timeout');
                error.retryable = true;
                throw error;
            }
            return 'complete';
        },
        {
            maxAttempts: 4,
            sleep: async () => {},
            onRetry: (error, attempt) => {
                retryNotifications.push([
                    error.message,
                    attempt,
                ]);
            },
        }
    );
    assert.strictEqual(retried, 'complete');
    assert.strictEqual(retryCalls, 3);
    assert.deepStrictEqual(
        retryNotifications.map(item => item[1]),
        [1, 2]
    );

    let transientStopChecks = 0;
    const stopCheckRecovered = await resilience.pollPrediction({
        prediction: { id: 'prediction-stop-check', status: 'processing' },
        deadlineAtMs: 10000,
        now: () => 0,
        sleep: async () => {},
        shouldStop: async () => {
            transientStopChecks += 1;
            if (transientStopChecks === 1) {
                const error = new Error('temporary stop-store timeout');
                error.retryable = true;
                throw error;
            }
            return false;
        },
        fetchStatus: async current => ({
            ...current,
            status: 'succeeded',
        }),
    });
    assert.strictEqual(stopCheckRecovered.status, 'succeeded');
    assert(transientStopChecks >= 2);

    let stopChecks = 0;
    await assert.rejects(
        resilience.pollPrediction({
            prediction: { id: 'prediction-3', status: 'processing' },
            deadlineAtMs: 10000,
            now: () => 0,
            sleep: async () => {},
            shouldStop: async () => {
                stopChecks += 1;
                return true;
            },
            fetchStatus: async () => {
                throw new Error('must not fetch after stop');
            },
        }),
        error => error && error.code === 'HOOK_GENERATION_STOPPED'
    );
    assert.strictEqual(stopChecks, 1);

    const server = fs.readFileSync(
        path.resolve(__dirname, '../server.js'),
        'utf8'
    );
    const ideaStart = server.indexOf('async function hookModelGenerate(');
    const ideaEnd = server.indexOf(
        '// ── Generation diversity memory',
        ideaStart
    );
    const ideaSource = server.slice(ideaStart, ideaEnd);
    assert(ideaSource.includes('providerResilience.pollPrediction'));
    assert(ideaSource.includes("? 'recovering'"));
    assert(ideaSource.includes('retryDeadlineAtMs'));
    const grindStart = server.indexOf('async function grindProcess');
    const grindEnd = server.indexOf('let _grindBusy', grindStart);
    const grindSource = server.slice(grindStart, grindEnd);
    assert(grindSource.includes('retryDeadlineAtMs: deadline'));
    assert(grindSource.includes('shouldStop: checkStopped'));
    assert(grindSource.includes(
        'temporary idea-provider interruption; retrying this attempt'
    ));
    assert(grindSource.includes(
        "error.code === 'HOOK_GENERATION_STOPPED'"
    ));
    assert(grindSource.includes('grindExploration.restoreState'));
    assert(grindSource.includes(
        "context: 'a restored Grind hook treatment'"
    ));
    assert(grindSource.includes('max_attempts: maxAttempts'));
    assert(!grindSource.includes('(3 tries)'));
    const queueStart = server.indexOf('async function grindQueue()');
    const queueEnd = server.indexOf(
        '// ── Long Quant GRIND',
        queueStart
    );
    const queueSource = server.slice(queueStart, queueEnd);
    const processIndex = queueSource.indexOf('await grindProcess(');
    const terminalConsumeIndex = queueSource.indexOf(
        "'consume terminal Shorts grind request'",
        processIndex
    );
    assert(processIndex >= 0);
    assert(terminalConsumeIndex > processIndex);
    assert(!queueSource.includes("'consume Shorts grind request'"));
    assert(queueSource.includes('resumeRun'));
    assert(queueSource.includes('shortsGrindRunTerminal(existingRun)'));
    const sweeperStart = server.indexOf(
        'async function grindSweepOrphans()'
    );
    const sweeperEnd = server.indexOf(
        'let _hookBusy',
        sweeperStart
    );
    const sweeperSource = server.slice(sweeperStart, sweeperEnd);
    assert(sweeperSource.includes('requestPending'));
    assert(sweeperSource.includes(
        'completed attempts and outward exploration are preserved'
    ));
    const autoStart = server.indexOf('async function hookProcessRequest');
    const autoEnd = server.indexOf(
        'async function hookSweepOrphans',
        autoStart
    );
    const autoSource = server.slice(autoStart, autoEnd);
    assert(autoSource.includes('ideaGenerationDeadlineAtMs'));
    assert(autoSource.includes('resilientAutoStep'));
    assert(autoSource.includes("'video-idea embedding'"));
    assert(autoSource.includes("'hook-treatment embedding'"));
    assert(autoSource.includes("'canonical hook scoring'"));
    assert(autoSource.includes(
        'retrying without consuming an idea slot'
    ));
    const imageStart = server.indexOf('async function replicateRun(');
    const imageEnd = server.indexOf('// relation:', imageStart);
    assert(
        server.slice(imageStart, imageEnd)
            .includes('providerResilience.pollPrediction'),
        'Replicate image renders must survive interrupted status polls too'
    );

    console.log(JSON.stringify({
        ok: true,
        resumedSamePrediction: true,
        transientRetries: retryCalls,
        permanentFailuresStop: true,
        grindAndEliteSharePolicy: true,
        autoSharesPolicy: true,
    }));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
