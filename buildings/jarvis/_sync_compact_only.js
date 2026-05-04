#!/usr/bin/env node
'use strict';
// Sync only derived_experiments_compact.json to R2
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const cloudStorage = require('../../cloud-storage');
cloudStorage.initR2();

async function run() {
  if (!cloudStorage.isR2Ready()) { console.error('R2 not ready'); process.exit(1); }
  const name = 'derived_experiments_compact';
  const localFile = path.join(__dirname, `${name}.json`);
  const stat = fs.statSync(localFile);
  const sizeMB = (stat.size / 1e6).toFixed(1);
  console.log(`Uploading ${name} (${sizeMB}MB)...`);
  const buf = fs.readFileSync(localFile);
  await cloudStorage.uploadToR2(`jarvis/${name}.json`, buf, 'application/json');
  console.log(`✓ ${name} uploaded.`);
  process.exit(0);
}
run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
