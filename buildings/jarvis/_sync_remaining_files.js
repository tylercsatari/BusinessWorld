#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const cloudStorage = require('../../cloud-storage');
cloudStorage.initR2();

const JARVIS_DIR = __dirname;

// Only sync smaller/critical files — skip the large derived_experiments (already synced)
const FILES = [
    'autonomous_progress',
    'autonomous_runs',
    'graph',
    'resolutions',
    'indicators',
    'indicator-registry',
    'candidate_queue',
    'experiments_log_compact',
    'principles',
    'findings-summary',
];

async function run() {
    if (!cloudStorage.isR2Ready()) { console.error('R2 not ready'); process.exit(1); }
    console.log('Syncing remaining files to R2...');
    for (const name of FILES) {
        const localFile = path.join(JARVIS_DIR, `${name}.json`);
        if (!fs.existsSync(localFile)) { console.log(`  SKIP ${name} (no local file)`); continue; }
        const stat = fs.statSync(localFile);
        const sizeMB = (stat.size / 1e6).toFixed(1);
        try {
            const buf = fs.readFileSync(localFile);
            await cloudStorage.uploadToR2(`jarvis/${name}.json`, buf, 'application/json');
            console.log(`  ✓ ${name} ${sizeMB}MB`);
        } catch(e) {
            console.log(`  ✗ ${name}: ${e.message}`);
        }
    }
    console.log('Done.');
    process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
