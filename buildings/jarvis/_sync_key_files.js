'use strict';
/**
 * Targeted sync: upload key count-bearing files to R2, skip huge experiments_log.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const cs = require('../../cloud-storage');
cs.initR2();

const DIR = __dirname;

// Files to sync in priority order (skip experiments_log which is 80MB+)
const FILES = [
    'autonomous_progress',
    'autonomous_runs',
    'derived_experiments',
    'derived_experiments_compact',
    'indicators',
    'indicators_compact',
    'candidate_queue',
    'resolutions',
    'indicator-registry',
    'graph',
];

async function run() {
    if (!cs.isR2Ready()) { console.error('R2 not ready'); process.exit(1); }
    console.log('R2 ready. Syncing key files...');
    for (const name of FILES) {
        const localFile = path.join(DIR, `${name}.json`);
        if (!fs.existsSync(localFile)) { console.log(`  SKIP ${name} (missing)`); continue; }
        const stat = fs.statSync(localFile);
        const sizeMB = (stat.size / 1e6).toFixed(1);
        if (stat.size > 100 * 1e6) { console.log(`  SKIP ${name} (${sizeMB}MB > 100MB limit)`); continue; }
        try {
            const buf = fs.readFileSync(localFile);
            await cs.uploadToR2('jarvis/' + name + '.json', buf, 'application/json');
            let count = '';
            if (name === 'derived_experiments') {
                try { const p = JSON.parse(buf); const arr = p.experiments || p; count = ` — ${Array.isArray(arr) ? arr.length : Object.keys(arr).length} exps`; } catch(e){}
            } else if (name === 'indicators') {
                try { const p = JSON.parse(buf); const arr = p.indicators || p; count = ` — ${Array.isArray(arr) ? arr.length : Object.keys(arr).length} indicators`; } catch(e){}
            }
            console.log(`  ✓ ${name} (${sizeMB}MB)${count}`);
        } catch(e) {
            console.error(`  ✗ ${name}: ${e.message}`);
        }
    }
    console.log('Done.');
}
run().catch(e => { console.error(e.message); process.exit(1); });
