#!/usr/bin/env node
'use strict';
/**
 * Cron watcher: reset stale run, sync local→R2, then exit.
 * Called by the overnight watcher to handle dead-process recovery.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');

const JARVIS_DIR = __dirname;
const progressFile = path.join(JARVIS_DIR, 'autonomous_progress.json');

// 1. Reset stale run
try {
    const prog = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    const runId = prog.run_id || 'unknown';
    const completed = prog.completed || 0;
    const attempted = prog.attempted || 0;
    if (prog.active) {
        prog.active = false;
        prog.stop_reason = 'process_died';
        prog.finished_at = new Date().toISOString();
        fs.writeFileSync(progressFile, JSON.stringify(prog, null, 2));
        console.log(`[reset] Cleared stale run ${runId} (${attempted} attempted, ${completed} completed)`);
    } else {
        console.log(`[reset] Run ${runId} already inactive, skipping reset`);
    }
} catch (e) {
    console.error('[reset] ERROR reading/writing autonomous_progress:', e.message);
    process.exit(1);
}

// 2. Delegate to sync-to-r2.js
const { execSync } = require('child_process');
try {
    console.log('[sync] Running sync-to-r2.js...');
    const out = execSync(`node ${path.join(JARVIS_DIR, 'sync-to-r2.js')}`, {
        cwd: JARVIS_DIR,
        timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(out.toString());
    console.log('[sync] sync-to-r2.js complete');
} catch (e) {
    console.error('[sync] ERROR in sync-to-r2.js:', e.stderr?.toString() || e.message);
    process.exit(1);
}

console.log('[reset_and_sync] Done.');
process.exit(0);
