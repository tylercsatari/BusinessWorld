#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
    for (const sourceLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const line = sourceLine.trim();
        if (!line || line.startsWith('#')) continue;
        const equals = line.indexOf('=');
        if (equals <= 0) continue;
        const key = line.slice(0, equals).trim();
        if (!process.env[key]) {
            process.env[key] = line.slice(equals + 1).trim();
        }
    }
}

const cloud = require('../cloud-storage');
const contract = require(
    '../buildings/jarvis/animated-hook-experiment'
);

const ROOT_KEY = 'hooks/experiments/animated-hook-batch/';

function argument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0
        ? process.argv[index + 1]
        : fallback;
}

function has(name) {
    return process.argv.includes(`--${name}`);
}

function experimentId() {
    return String(
        argument('id', 'animated-channel-free-2026-08-04')
    ).trim().toLowerCase();
}

function experimentKey(id) {
    return `${ROOT_KEY}${id}.json`;
}

async function readJson(key) {
    const bytes = await cloud.downloadFromR2(key).catch(() => null);
    return bytes ? JSON.parse(bytes.toString('utf8')) : null;
}

async function writeExperiment(experiment) {
    const bound = contract.bindExperiment({
        ...experiment,
        updated_at_ms: Date.now(),
    });
    await cloud.uploadToR2(
        experimentKey(bound.id),
        Buffer.from(JSON.stringify(bound)),
        'application/json'
    );
    return bound;
}

async function loadExperiment(id) {
    const value = await readJson(experimentKey(id));
    if (!value) return null;
    const validation = contract.validateExperiment(value);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return value;
}

async function liveSummary(experiment) {
    const groups = [];
    let pending = 0;
    let active = 0;
    for (
        let offset = 0;
        offset < experiment.requests.length;
        offset += 12
    ) {
        const rows = await Promise.all(
            experiment.requests.slice(offset, offset + 12).map(
                async request => {
                    const [queued, group, status] = await Promise.all([
                        cloud.existsInR2(
                            `hooks/grpo/requests/${request.rid}.json`
                        ).catch(() => false),
                        readJson(
                            `hooks/grpo/demo/groups/${request.rid}.json`
                        ),
                        readJson(
                            `hooks/grpo/demo/status/${request.rid}.json`
                        ),
                    ]);
                    return { queued, group, status };
                }
            )
        );
        for (const row of rows) {
            if (row.queued) pending += 1;
            if (row.group) {
                groups.push(row.group);
            }
            if (
                row.queued
                || row.group && row.group.done !== true
                || row.status && row.status.stage !== 'done'
            ) active += 1;
        }
    }
    return {
        ...contract.summarize(experiment, groups),
        queued_batches: pending,
        active_batches: active,
        total_batches: experiment.requests.length,
    };
}

async function status(id) {
    const experiment = await loadExperiment(id);
    if (!experiment) throw new Error(`experiment ${id} was not found`);
    return {
        id: experiment.id,
        status: experiment.status,
        threshold_coordinate_id:
            experiment.threshold_coordinate_id,
        threshold_value_0_100:
            experiment.threshold_value_0_100,
        minimum_verified_attempts:
            experiment.minimum_verified_attempts,
        winner_target: experiment.winner_target,
        image_model: experiment.image_model,
        animation: experiment.animation,
        folder_name: experiment.folder_name,
        stats: await liveSummary(experiment),
        created_at:
            new Date(experiment.created_at_ms).toISOString(),
        updated_at:
            new Date(experiment.updated_at_ms).toISOString(),
        completed_at: experiment.completed_at_ms
            ? new Date(experiment.completed_at_ms).toISOString()
            : null,
        experiment_sha256: experiment.experiment_sha256,
    };
}

async function launch(id) {
    const existing = await loadExperiment(id);
    if (existing && !has('restart')) return status(id);
    if (existing && has('restart')) {
        throw new Error(
            'choose a new --id instead of overwriting an auditable experiment'
        );
    }
    const minimum = Number.parseInt(
        argument('minimum', '100'),
        10
    );
    const winners = Number.parseInt(
        argument('winners', '10'),
        10
    );
    const threshold = Number(
        argument('threshold', '80')
    );
    await writeExperiment({
        id,
        status: 'running',
        threshold_value_0_100: threshold,
        minimum_verified_attempts: minimum,
        winner_target: winners,
        batch_size: Number.parseInt(
            argument('batch-size', '8'),
            10
        ),
        folder_name: argument(
            'folder',
            'Animated Hook Grind'
        ),
        requests: [],
        created_at_ms: Date.now(),
        updated_at_ms: Date.now(),
    });
    return status(id);
}

async function stop(id) {
    const experiment = await loadExperiment(id);
    if (!experiment) throw new Error(`experiment ${id} was not found`);
    experiment.status = 'stopped';
    experiment.stopped_at_ms = Date.now();
    await writeExperiment(experiment);
    for (const request of experiment.requests) {
        await cloud.deleteFromR2(
            `hooks/grpo/requests/${request.rid}.json`
        ).catch(() => {});
    }
    return status(id);
}

async function resume(id) {
    const experiment = await loadExperiment(id);
    if (!experiment) throw new Error(`experiment ${id} was not found`);
    if (experiment.status === 'complete') {
        throw new Error(`experiment ${id} is already complete`);
    }
    experiment.status = 'running';
    experiment.error = null;
    experiment.stopped_at_ms = null;
    await writeExperiment(experiment);
    return status(id);
}

async function watch(id) {
    const intervalSeconds = Math.max(
        5,
        Number.parseInt(argument('interval', '30'), 10) || 30
    );
    for (;;) {
        const snapshot = await status(id);
        process.stdout.write(`${JSON.stringify(snapshot)}\n`);
        if (['complete', 'stopped', 'error'].includes(snapshot.status)) {
            return snapshot;
        }
        await new Promise(resolve => setTimeout(
            resolve,
            intervalSeconds * 1000
        ));
    }
}

async function main() {
    cloud.initR2();
    if (!cloud.isR2Ready()) throw new Error('R2 is not configured');
    const id = experimentId();
    let output;
    if (has('stop')) output = await stop(id);
    else if (has('resume')) output = await resume(id);
    else if (has('status')) output = await status(id);
    else if (has('watch')) output = await watch(id);
    else output = await launch(id);
    if (!has('watch')) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
});
