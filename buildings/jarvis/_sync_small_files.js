'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
const fs = require('fs');
const path = require('path');

const FILES = ['indicators_compact', 'indicator-registry', 'candidate_queue', 'autonomous_runs'];
const DIR = __dirname;

async function run() {
  for (const name of FILES) {
    const fp = path.join(DIR, name + '.json');
    if (!fs.existsSync(fp)) { console.log('skip (missing):', name); continue; }
    const buf = fs.readFileSync(fp);
    const mb = (buf.length / 1024 / 1024).toFixed(1);
    await cs.uploadToR2('jarvis/' + name + '.json', buf, 'application/json');
    console.log('uploaded:', name, mb + 'MB');
  }
  console.log('Done.');
  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
setTimeout(() => { console.log('timeout'); process.exit(0); }, 30000);
