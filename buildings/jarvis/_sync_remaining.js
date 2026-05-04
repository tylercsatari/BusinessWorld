'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
const fs = require('fs');
const path = require('path');

const FILES = ['graph', 'resolutions', 'autonomous_runs', 'autonomous_progress', 'candidate_queue'];
const DIR = __dirname;

async function run() {
  for (const name of FILES) {
    const fp = path.join(DIR, name + '.json');
    if (!fs.existsSync(fp)) { console.log('skip (missing):', name); continue; }
    const buf = fs.readFileSync(fp);
    await cs.uploadToR2('jarvis/' + name + '.json', buf, 'application/json');
    console.log('uploaded:', name, buf.length, 'bytes');
  }
  console.log('Done.');
}
run().catch(e => { console.error(e.message); process.exit(1); });
