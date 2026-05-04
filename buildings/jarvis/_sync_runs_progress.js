'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const cs = require('../../cloud-storage');
cs.initR2();
const DIR = __dirname;
async function run() {
  for (const name of ['autonomous_runs', 'autonomous_progress']) {
    const localFile = path.join(DIR, name + '.json');
    if (!fs.existsSync(localFile)) { console.log('SKIP', name); continue; }
    const buf = fs.readFileSync(localFile);
    const parsed = JSON.parse(buf.toString());
    let count = '';
    if (name === 'autonomous_runs') {
      const arr = Array.isArray(parsed) ? parsed : list(parsed.values());
      count = ` (${Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length} runs)`;
    } else if (name === 'autonomous_progress') {
      count = ` (active=${parsed.active}, completed=${parsed.completed}, run=${parsed.run_id})`;
    }
    const sizeMB = (buf.length / 1e6).toFixed(2);
    await cs.uploadToR2('jarvis/' + name + '.json', buf, 'application/json');
    console.log('✓', name, sizeMB + 'MB' + count);
  }
  console.log('Sync done.');
}
run().catch(e => { console.error(e.message); process.exit(1); });
