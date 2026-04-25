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
    'indicator-registry',
    'candidate_queue',
    'experiments_log',
    'tools',
];

// Files that get compact mirrors (dataset arrays stripped)
const COMPACT_SOURCES = ['indicators', 'derived_experiments', 'experiments_log'];

function compactProject(name, item) {
    if (!item) return item;
    if (name === 'indicators') {
        const { dataset, ...rest } = item;
        return { ...rest, _datasetSize: Array.isArray(dataset) ? dataset.length : 0 };
    }
    if (name === 'experiments_log') {
        return {
            id: item.id,
            indicator_key: item.indicator_key,
            target: item.target,
            n_videos: item.n_videos,
            status: item.status,
            ran_at: item.ran_at,
            kind: item.kind,
            source: item.source,
            r: item.r != null ? item.r : (item.outputs && typeof item.outputs.r === 'number' ? item.outputs.r : null),
        };
    }
    return item;
}

async function run() {
    if (!cloudStorage.isR2Ready()) {
        console.error('R2 not ready — check credentials');
        process.exit(1);
    }
    console.log('R2 ready. Syncing local → R2...');
    for (const name of FILES) {
        const localFile = path.join(JARVIS_DIR, `${name}.json`);
        if (!fs.existsSync(localFile)) {
            console.log(`  SKIP ${name} (no local file)`);
            continue;
        }
        const stat = fs.statSync(localFile);
        const sizeMB = (stat.size / 1e6).toFixed(1);
        try {
            const buf = fs.readFileSync(localFile);
            const parsed = JSON.parse(buf.toString());
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

            // Build and upload compact mirror if applicable
            if (COMPACT_SOURCES.includes(name) && Array.isArray(parsed)) {
                const compact = parsed.map(item => compactProject(name, item));
                const compactStr = JSON.stringify(compact);
                const compactBuf = Buffer.from(compactStr);
                const compactName = `${name}_compact`;
                await cloudStorage.uploadToR2(`${R2_PREFIX}${compactName}.json`, compactBuf, 'application/json');
                const compactMB = (compactBuf.length / 1e6).toFixed(1);
                // Write local compact file too
                fs.writeFileSync(path.join(JARVIS_DIR, `${compactName}.json`), compactStr);
                console.log(`  ✓ ${compactName} ${compactMB}MB (${compact.length} items, compact mirror)`);
            }
        } catch (e) {
            console.error(`  ✗ ${name}: ${e.message}`);
        }
    }
    // Also refresh the viral-ideas R2 cache so the Render endpoints stay
    // current with the latest experiments.
    try {
        const ideasSync = require('./sync-ideas-to-r2');
        await ideasSync.run();
    } catch (e) {
        console.error('  ✗ viral-ideas refresh:', e.message);
    }
    console.log('Sync complete.');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
