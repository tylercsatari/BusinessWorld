#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const cs = require('../../cloud-storage');
cs.initR2();
async function run() {
  if (!cs.isR2Ready()) { console.error('R2 not ready'); process.exit(1); }
  const files = ['autonomous_progress', 'autonomous_runs'];
  for (const name of files) {
    const f = path.join(__dirname, `${name}.json`);
    if (!fs.existsSync(f)) { console.log(`SKIP ${name} (missing)`); continue; }
    const buf = fs.readFileSync(f);
    const d = JSON.parse(buf.toString());
    let info = '';
    if (name === 'autonomous_progress') info = ` active=${d.active} run=${d.run_id} completed=${d.completed}`;
    await cs.uploadToR2(`jarvis/${name}.json`, buf, 'application/json');
    console.log(`✓ ${name} ${(buf.length/1e6).toFixed(2)}MB${info}`);
  }
  console.log('Done.');
  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
