#!/usr/bin/env node
'use strict';
// Sync only the candidate_queue.json to R2 (lightweight, won't OOM)
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const cloudStorage = require('../../cloud-storage');
cloudStorage.initR2();

const JARVIS_DIR = __dirname;
const UPLOAD_FILES = ['candidate_queue', 'autonomous_progress', 'resolutions'];

async function sync() {
    for (const name of UPLOAD_FILES) {
        const filePath = path.join(JARVIS_DIR, `${name}.json`);
        if (!fs.existsSync(filePath)) { console.log(`SKIP ${name} (not found)`); continue; }
        const buf = fs.readFileSync(filePath);
        await cloudStorage.uploadToR2(`jarvis/${name}.json`, buf, 'application/json');
        console.log(`Synced ${name}.json → R2 (${(buf.length/1024).toFixed(0)} KB)`);
    }
    process.exit(0);
}
sync().catch(e => { console.error(e.message); process.exit(1); });
setTimeout(() => process.exit(2), 30000);
