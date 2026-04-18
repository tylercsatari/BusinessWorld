#!/usr/bin/env node
'use strict';
// Pull canonical Jarvis JSON files from R2 → local disk
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
const fs = require('fs');
const path = require('path');

const FILES = ['autonomous_progress', 'derived_experiments', 'graph', 'resolutions'];

async function run() {
    if (!cs.isR2Ready()) { console.error('R2 not ready'); process.exit(1); }
    for (const name of FILES) {
        try {
            const buf = await cs.downloadFromR2(`jarvis/${name}.json`);
            const d = JSON.parse(buf.toString());
            const dest = path.join(__dirname, `${name}.json`);
            fs.writeFileSync(dest, JSON.stringify(d, null, 2));
            const arr = Array.isArray(d) ? d : (d.experiments || d.nodes || []);
            console.log(`  pulled ${name}: ${Array.isArray(arr) ? arr.length : Object.keys(d).length} items, ${(buf.length/1e6).toFixed(1)}MB`);
        } catch(e) { console.error(`  FAIL ${name}:`, e.message); }
    }
}
run().then(() => console.log('done')).catch(e => { console.error(e); process.exit(1); });
