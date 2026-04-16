#!/usr/bin/env node
'use strict';
/**
 * overnight_orchestrator.js
 *
 * Reads buildings/jarvis/overnight_task_queue.json and runs each phase
 * script as a child process, sequentially. Updates overnight_status.json
 * at every transition. Halts on first failure with a recorded reason.
 *
 * Usage:
 *   node buildings/jarvis/overnight_orchestrator.js              # run from start
 *   node buildings/jarvis/overnight_orchestrator.js --start-from phase_3_components
 *   node buildings/jarvis/overnight_orchestrator.js --dry-run    # print plan, do not run
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const JARVIS = __dirname;
const QUEUE_FILE = path.join(JARVIS, 'overnight_task_queue.json');
const STATUS_FILE = path.join(JARVIS, 'overnight_status.json');
const LOG_FILE = path.join(JARVIS, 'overnight_orchestrator.log');

function nowIso() { return new Date().toISOString(); }

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return fallback; }
}
function writeJson(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

function patchStatus(updater) {
    const cur = readJson(STATUS_FILE, {});
    const next = updater(cur) || cur;
    next.updated_at = nowIso();
    writeJson(STATUS_FILE, next);
}

function logLine(line) {
    const stamped = `[${nowIso()}] ${line}\n`;
    process.stdout.write(stamped);
    try { fs.appendFileSync(LOG_FILE, stamped); } catch { /* best effort */ }
}

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { startFrom: null, dryRun: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--start-from') { opts.startFrom = args[i + 1]; i++; }
        else if (args[i] === '--dry-run') { opts.dryRun = true; }
    }
    return opts;
}

function runPhase(task) {
    return new Promise((resolve) => {
        const scriptPath = path.join(JARVIS, task.script);
        if (!fs.existsSync(scriptPath)) {
            return resolve({ ok: false, code: -1, error: `script not found: ${scriptPath}` });
        }
        const startedAt = nowIso();
        const start = Date.now();
        const child = spawn('node', [scriptPath], {
            cwd: path.join(JARVIS, '..', '..'),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const onChunk = (chunk) => {
            const text = chunk.toString();
            process.stdout.write(text);
            try { fs.appendFileSync(LOG_FILE, text); } catch { /* best effort */ }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);

        const maxMs = (task.max_minutes || 60) * 60 * 1000;
        const timer = setTimeout(() => {
            logLine(`TIMEOUT: ${task.id} exceeded max_minutes=${task.max_minutes}, killing.`);
            try { child.kill('SIGTERM'); } catch { /* */ }
        }, maxMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            const elapsedMin = (Date.now() - start) / 60000;
            resolve({ ok: code === 0, code, started_at: startedAt, finished_at: nowIso(), elapsed_minutes: +elapsedMin.toFixed(2) });
        });
    });
}

async function main() {
    const opts = parseArgs();
    const queue = readJson(QUEUE_FILE, null);
    if (!queue || !Array.isArray(queue.tasks)) {
        console.error(`[orchestrator] FATAL: ${QUEUE_FILE} missing or malformed`);
        process.exit(1);
    }

    let tasks = queue.tasks;
    if (opts.startFrom) {
        const idx = tasks.findIndex(t => t.id === opts.startFrom);
        if (idx < 0) {
            console.error(`[orchestrator] FATAL: --start-from ${opts.startFrom} not found in queue`);
            process.exit(1);
        }
        tasks = tasks.slice(idx);
        logLine(`resuming from ${opts.startFrom}`);
    }

    logLine(`orchestrator starting; ${tasks.length} task(s) ahead`);
    logLine(`task order: ${tasks.map(t => t.id).join(' → ')}`);
    if (opts.dryRun) {
        logLine('dry-run: not executing.');
        process.exit(0);
    }

    patchStatus(s => {
        s.overall_status = 'running';
        s.started_at = s.started_at || nowIso();
        s.failed_phase = null;
        s.failure_reason = null;
        if (opts.startFrom) s.resumed_from = opts.startFrom;
        return s;
    });

    for (const task of tasks) {
        logLine(`▶ START ${task.id} — ${task.label}`);
        patchStatus(s => {
            s.current_phase = task.id;
            s.current_phase_started_at = nowIso();
            s.current_phase_progress = { step: 'launching' };
            return s;
        });

        const res = await runPhase(task);

        if (!res.ok) {
            logLine(`✗ FAIL ${task.id} (exit=${res.code}, elapsed=${res.elapsed_minutes ?? '?'}m)`);
            patchStatus(s => {
                s.overall_status = 'failed';
                s.failed_phase = task.id;
                s.failure_reason = `exit code ${res.code}`;
                s.finished_at = nowIso();
                return s;
            });
            process.exit(2);
        }

        logLine(`✓ DONE ${task.id} (elapsed=${res.elapsed_minutes}m)`);
        patchStatus(s => {
            s.current_phase = null;
            s.current_phase_progress = null;
            s.current_phase_started_at = null;
            return s;
        });
    }

    patchStatus(s => {
        s.overall_status = 'completed';
        s.finished_at = nowIso();
        s.current_phase = null;
        s.current_phase_progress = null;
        s.current_phase_started_at = null;
        return s;
    });
    logLine(`orchestrator completed all phases.`);
}

main().catch(err => {
    logLine(`orchestrator crashed: ${err.stack || err.message}`);
    patchStatus(s => {
        s.overall_status = 'failed';
        s.failure_reason = `orchestrator crash: ${String(err.message || err).slice(0, 300)}`;
        s.finished_at = nowIso();
        return s;
    });
    process.exit(3);
});
