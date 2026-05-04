#!/usr/bin/env node
'use strict';
// Fast sync: priority files only (progress + compact indexes)
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const cloudStorage = require('../../cloud-storage');
cloudStorage.initR2();

const JARVIS_DIR = __dirname;
const R2_PREFIX = 'jarvis/';

// Priority: small/critical files first; skip huge raw logs
const PRIORITY_FILES = [
  'autonomous_progress',
  'candidate_queue',
  'indicator-registry',
];
const COMPACT_FILES = [
  'indicators_compact',
  'derived_experiments_compact',
];
// Large files — upload last (may timeout but progress/compact are done)
const LARGE_FILES = [
  'graph',
  'derived_experiments',
  'indicators',
  'experiments_log_compact',
];

async function uploadFile(name) {
  const localFile = path.join(JARVIS_DIR, `${name}.json`);
  if (!fs.existsSync(localFile)) { console.log(`  SKIP ${name}`); return; }
  const stat = fs.statSync(localFile);
  const sizeMB = (stat.size / 1e6).toFixed(1);
  try {
    const buf = fs.readFileSync(localFile);
    await cloudStorage.uploadToR2(`${R2_PREFIX}${name}.json`, buf, 'application/json');
    console.log(`  ✓ ${name} ${sizeMB}MB`);
  } catch(e) {
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

async function run() {
  if (!cloudStorage.isR2Ready()) { console.error('R2 not ready'); process.exit(1); }
  console.log('R2 ready. Syncing priority files...');
  for (const name of [...PRIORITY_FILES, ...COMPACT_FILES]) {
    await uploadFile(name);
  }
  console.log('Priority sync done. Uploading large files...');
  for (const name of LARGE_FILES) {
    await uploadFile(name);
  }
  console.log('All done.');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
