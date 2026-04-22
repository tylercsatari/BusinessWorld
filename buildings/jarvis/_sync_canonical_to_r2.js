'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const jarvisStore = require('./jarvis-store');
const cs = require('../../cloud-storage');
cs.initR2();

async function run() {
  console.log('[sync-canonical] Forcing upload of all canonical files to R2...');
  const results = await jarvisStore.migrateAll('overwrite');
  for (const [k, v] of Object.entries(results)) {
    console.log(' ', k, ':', v);
  }
  console.log('[sync-canonical] Done.');
}
run().catch(e => { console.error(e.message); process.exit(1); });
