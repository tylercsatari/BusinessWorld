#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const cloudStorage = require('../../cloud-storage');
cloudStorage.initR2();

async function run() {
    if (!cloudStorage.isR2Ready()) { console.error('R2 not ready'); process.exit(1); }
    const localFile = path.join(__dirname, 'graph.json');
    const stat = fs.statSync(localFile);
    console.log(`graph.json size: ${(stat.size/1e6).toFixed(1)}MB`);
    const buf = fs.readFileSync(localFile);
    const parsed = JSON.parse(buf.toString());
    const count = `(${(parsed.nodes||[]).length} nodes, ${(parsed.edges||[]).length} edges)`;
    await cloudStorage.uploadToR2('jarvis/graph.json', buf, 'application/json');
    console.log(`✓ graph.json uploaded ${count}`);
    process.exit(0);
}
run().catch(e => { console.error('✗ graph:', e.message); process.exit(1); });
