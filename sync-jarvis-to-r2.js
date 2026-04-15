'use strict';
/**
 * sync-jarvis-to-r2.js
 * Force-uploads all canonical Jarvis JSON files to R2.
 * Run: node sync-jarvis-to-r2.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { initR2 } = require('./cloud-storage');
const jarvisStore = require('./buildings/jarvis/jarvis-store');

// Initialize R2 connection
initR2();

async function main() {
    const { CANONICAL_FILES } = jarvisStore;
    if (!CANONICAL_FILES) {
        console.error('jarvis-store does not export CANONICAL_FILES');
        process.exit(1);
    }

    console.log(`Syncing ${CANONICAL_FILES.length} canonical files to R2...`);
    for (const name of CANONICAL_FILES) {
        try {
            const result = await jarvisStore.forceUploadToR2(name);
            console.log(`  ${name}: ${result}`);
        } catch (e) {
            console.error(`  ${name}: ERROR — ${e.message}`);
        }
    }
    console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
