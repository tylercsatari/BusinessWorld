#!/usr/bin/env node
'use strict';
/**
 * One-shot: push local Jarvis canonical JSON files to R2.
 * Run after local autorun has generated new experiments/graph data.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const cloudStorage = require('../../cloud-storage');
cloudStorage.initR2();

const JARVIS_DIR = __dirname;
const R2_PREFIX = 'jarvis/';

const FILES = [
    'autonomous_progress',
    'derived_experiments',
    'graph',
    'resolutions',
    'indicators',
    'candidate_queue',
    'experiments_log',
    'tools',
];

async function run() {
    if (!cloudStorage.isR2Ready()) {
        console.error('R2 not ready — check credentials');
        process.exit(1);
    }
    console.log('R2 ready. Syncing local → R2...');
    for (const name of FILES) {
        const localPath = path.join(JARVIS_DIR, `${name}.json`);
        if (!fs.existsSync(localPath)) {
            console.log(`  SKIP ${name} (no local file)`);
            continue;
        }
        const stat = fs.statSync(localPath);
        const sizeMB = (stat.size / 1e6).toFixed(1);
        try {
            const buf = fs.readFileSync(localPath);
            // Parse to validate JSON
            const parsed = JSON.parse(buf.toString());
            // Count for summary
            let count = '';
            if (name === 'derived_experiments') {
                const arr = parsed.experiments || parsed;
                count = ` (${Array.isArray(arr) ? arr.length : Object.keys(arr).length} exps)`;
            } else if (name === 'graph') {
                count = ` (${(parsed.nodes||[]).length} nodes, ${(parsed.edges||[]).length} edges)`;
            } else if (name === 'autonomous_progress') {
                count = ` (active=${parsed.active}, completed=${parsed.completed})`;
            }
            await cloudStorage.uploadToR2(`${R2_PREFIX}${name}.json`, buf, 'application/json');
            console.log(`  ✓ ${name} ${sizeMB}MB${count}`);
        } catch (e) {
            console.error(`  ✗ ${name}: ${e.message}`);
        }
    }
    console.log('Sync complete.');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
