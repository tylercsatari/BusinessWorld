#!/usr/bin/env node
'use strict';
// Targeted sync: skip experiments_log (160MB) to avoid timeout
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
  'resolutions',
  'indicators',
  'indicator-registry',
  'candidate_queue',
  'tools',
];

const COMPACT_SOURCES = ['indicators', 'derived_experiments'];

function compactProject(item) {
  if (!item) return item;
  const { dataset, ...rest } = item;
  return { ...rest, _datasetSize: Array.isArray(dataset) ? dataset.length : 0 };
}

async function run() {
  if (!cloudStorage.isR2Ready()) { console.error('R2 not ready'); process.exit(1); }
  console.log('R2 ready. Syncing key files → R2 (skipping experiments_log)...');
  for (const name of FILES) {
    const localFile = path.join(JARVIS_DIR, `${name}.json`);
    if (!fs.existsSync(localFile)) { console.log(`  SKIP ${name} (missing)`); continue; }
    const stat = fs.statSync(localFile);
    const sizeMB = (stat.size / 1e6).toFixed(1);
    try {
      const buf = fs.readFileSync(localFile);
      const parsed = JSON.parse(buf.toString());
      let count = '';
      if (name === 'derived_experiments') {
        const arr = parsed.experiments || parsed;
        count = ` (${Array.isArray(arr) ? arr.length : Object.keys(arr).length} exps)`;
      } else if (name === 'autonomous_progress') {
        count = ` (active=${parsed.active}, completed=${parsed.completed})`;
      }
      await cloudStorage.uploadToR2(`${R2_PREFIX}${name}.json`, buf, 'application/json');
      console.log(`  ✓ ${name} ${sizeMB}MB${count}`);
      if (COMPACT_SOURCES.includes(name) && Array.isArray(parsed)) {
        const compact = parsed.map(compactProject);
        const compactStr = JSON.stringify(compact);
        const compactBuf = Buffer.from(compactStr);
        const compactName = `${name}_compact`;
        await cloudStorage.uploadToR2(`${R2_PREFIX}${compactName}.json`, compactBuf, 'application/json');
        fs.writeFileSync(path.join(JARVIS_DIR, `${compactName}.json`), compactStr);
        console.log(`  ✓ ${compactName} ${(compactBuf.length/1e6).toFixed(1)}MB (${compact.length} items, compact)`);
      }
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
    }
  }
  console.log('Key sync complete.');
}
run().catch(e => { console.error(e); process.exit(1); });
