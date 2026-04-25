#!/usr/bin/env node
'use strict';
/**
 * Pre-generate viral ideas locally and upload to R2.
 * Render's 2GB dyno OOMs when running buildIdeas() because it loads the
 * full Jarvis artifact set (~5MB+) and runs synthesis. Run this locally
 * (no memory limit), then Render serves the pre-built JSON.
 *
 * Outputs:
 *   r2://jarvis/viral-ideas-cache.json  — { brief_summary, ideas } (count=10)
 *   r2://jarvis/viral-model-cache.json  — { brief } (full structured brief)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cloudStorage = require('../../cloud-storage');
const viralIdeaEngine = require('./viral-idea-engine');

const R2_IDEAS_KEY = 'jarvis/viral-ideas-cache.json';
const R2_MODEL_KEY = 'jarvis/viral-model-cache.json';
const IDEAS_COUNT = 10;

async function run() {
    cloudStorage.initR2();
    if (!cloudStorage.isR2Ready()) {
        console.error('R2 not ready — check R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in .env');
        process.exit(1);
    }
    console.log('R2 ready. Generating viral ideas locally...');

    const t0 = Date.now();
    const ideasPayload = viralIdeaEngine.buildIdeas(IDEAS_COUNT, { skipMechanisms: true });
    ideasPayload.generated_at = new Date().toISOString();
    ideasPayload.cached_count = IDEAS_COUNT;
    const ideasBuf = Buffer.from(JSON.stringify(ideasPayload));
    console.log(`  ideas built in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${ideasPayload.ideas.length} ideas, ${(ideasBuf.length / 1e6).toFixed(2)}MB`);

    const t1 = Date.now();
    const { brief } = viralIdeaEngine.buildModel({ skipMechanisms: true });
    const modelPayload = { generated_at: new Date().toISOString(), brief };
    const modelBuf = Buffer.from(JSON.stringify(modelPayload));
    console.log(`  model built in ${((Date.now() - t1) / 1000).toFixed(1)}s — ${(modelBuf.length / 1e6).toFixed(2)}MB`);

    console.log('Uploading to R2...');
    await cloudStorage.uploadToR2(R2_IDEAS_KEY, ideasBuf, 'application/json');
    console.log(`  ✓ ${R2_IDEAS_KEY}`);
    await cloudStorage.uploadToR2(R2_MODEL_KEY, modelBuf, 'application/json');
    console.log(`  ✓ ${R2_MODEL_KEY}`);
    console.log('Done.');
}

if (require.main === module) {
    run().catch(e => { console.error('Fatal:', e.stack || e.message); process.exit(1); });
}

module.exports = { run, R2_IDEAS_KEY, R2_MODEL_KEY, IDEAS_COUNT };
