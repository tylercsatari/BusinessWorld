#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const contract = require('../embedding-display-contract');
const helperStart = serverSource.indexOf("const SAVED_HOOK_INDEX_KEY =");
const helperEnd = serverSource.indexOf('\nfunction savedChannelId', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, 'embedding display contract helpers were not found');

const objects = new Map();
const writes = [];
const context = {
    Buffer,
    console,
    isFinite,
    SAVED_HOOK_INDEX_VERSION: contract.SAVED_HOOK_INDEX_VERSION,
    embeddingDisplayPreference: contract.embeddingDisplayPreference,
    embeddingSteerSelection: contract.embeddingSteerSelection,
    compactSavedHookRecord: contract.compactSavedHookRecord,
    cloud: {
        downloadFromR2: async key => objects.has(key) ? Buffer.from(objects.get(key)) : null,
        uploadToR2: async (key, body) => {
            await new Promise(resolve => setTimeout(resolve, 2));
            objects.set(key, Buffer.from(body));
            writes.push(key);
        },
    },
};
vm.createContext(context);
vm.runInContext(
    serverSource.slice(helperStart, helperEnd)
        + '\nthis.contractApi = { SAVED_HOOK_INDEX_KEY, SAVED_HOOK_INDEX_VERSION, embeddingDisplayPreference, embeddingSteerSelection, compactSavedHookRecord, readSavedHookIndex, updateSavedHookIndex };',
    context
);

function metric(est, pctile) {
    return { est, pctile, kind: 'fixture' };
}

function record(domain, displayPreference) {
    return {
        id: domain === 'longquant' ? 'long-1' : 'short-1',
        title: 'Preference fixture',
        kind: 'scored',
        hasMontage: true,
        savedAt: 123,
        input_manifest: {
            domain,
            display_preference: displayPreference,
            scorer: domain === 'longquant' ? 'longquant_score.py' : 'raw_upload.py',
            embedding_model: 'gemini-embedding-2',
        },
        steer: {
            together_keep: metric(82, 82),
            text_keep: metric(85, 85),
            visual_keep: metric(99, 99),
            together_ret5: metric(77, 77),
            visual_ret5: metric(98, 98),
            together_views: metric(12_000_000, 88),
            visual_views: metric(50_000_000, 99),
            together_realviews: metric(4_000_000, null),
            visual_realviews: metric(9_000_000, null),
            together_gt10M: metric(.42, 73),
            visual_gt10M: metric(.91, 99),
            together_outlier: metric(3.2, 76),
            visual_outlier: metric(8.1, 99),
        },
    };
}

async function main() {
    const api = context.contractApi;
    const shortRecord = record('shorts_raw', ['together', 'text', 'visual']);
    const selectedShort = api.embeddingSteerSelection(shortRecord, 'keep', 'shorts_raw');
    assert.strictEqual(selectedShort.channel, 'together', 'Shorts must honor Both-first display preference');
    assert.strictEqual(selectedShort.est, 82, 'Shorts selected value drifted from the Both embedding');
    assert.strictEqual(selectedShort.sourceKey, 'together_keep');

    const compact = api.compactSavedHookRecord(shortRecord);
    assert.strictEqual(compact.keep, 82, 'saved card percentile must equal opened-record Both.keep');
    assert.strictEqual(compact.m.keep_est, 82, 'saved compact estimate must equal opened-record Both.keep');
    assert.strictEqual(compact.m.views, 12_000_000, 'saved compact views must equal opened-record Both.views');
    assert.strictEqual(compact.m_identity.keep.sourceKey, 'together_keep', 'saved card must persist its exact source identity');
    assert.strictEqual(compact.m_identity.views.est, 12_000_000, 'saved identity must persist the exact raw value');

    const longRecord = record('longquant', ['visual', 'together', 'text']);
    const selectedLong = api.embeddingSteerSelection(longRecord, 'keep', 'longquant');
    assert.strictEqual(selectedLong.channel, 'visual', 'Long Quant must honor image-only Visual-first display preference');
    assert.strictEqual(selectedLong.est, 99, 'Long Quant selected value drifted from the Visual embedding');

    const fallback = record('shorts_raw', []);
    delete fallback.steer.together_keep;
    const selectedFallback = api.embeddingSteerSelection(fallback, 'keep', 'shorts_raw');
    assert.strictEqual(selectedFallback.channel, 'text', 'Shorts missing-channel fallback must be Text before Visual');
    assert.strictEqual(selectedFallback.est, 85);

    objects.set(api.SAVED_HOOK_INDEX_KEY, Buffer.from(JSON.stringify({ version: 1, hooks: [], folders: [] })));
    await Promise.all([
        api.updateSavedHookIndex(index => { index.hooks.push({ id: 'a' }); }),
        api.updateSavedHookIndex(index => { index.hooks.push({ id: 'b' }); }),
        api.updateSavedHookIndex(index => { index.folders.push({ id: 'f1', name: 'One' }); }),
    ]);
    const updated = JSON.parse(objects.get(api.SAVED_HOOK_INDEX_KEY).toString('utf8'));
    assert.deepStrictEqual(updated.hooks.map(row => row.id), ['a', 'b'], 'serialized index updates lost a concurrent hook');
    assert.strictEqual(updated.folders.length, 1, 'serialized index updates lost a concurrent folder');
    assert.strictEqual(updated.version, api.SAVED_HOOK_INDEX_VERSION, 'saved index version was not upgraded');
    assert(writes.length === 3, 'each serialized mutation should persist exactly once');

    assert(!serverSource.includes("rec.steer['together_' + t] || rec.steer['visual_' + t]"), 'legacy hard-coded saved-card preference still exists');
    assert(serverSource.includes('idx.hooks[at] = compact'), 'enrichment must refresh all compact metrics, not only the montage flag');
    assert(serverSource.includes('saved-hook index update failed:'), 'saved-hook creation can still report success after an index failure');
    const deleteRoute = serverSource.slice(serverSource.indexOf("pathname === '/api/raw/hook-delete'"), serverSource.indexOf("pathname === '/api/raw/hook-delete'") + 1100);
    assert(deleteRoute.indexOf('updateSavedHookIndex') < deleteRoute.indexOf('deleteFromR2'), 'saved-hook deletion can remove the record before hiding its index card');

    console.log(JSON.stringify({
        ok: true,
        shorts: { selected: selectedShort.sourceKey, keep: selectedShort.est, views: compact.m.views },
        longquant: { selected: selectedLong.sourceKey, keep: selectedLong.est },
        fallback: selectedFallback.sourceKey,
        concurrentIndexRows: updated.hooks.length,
        indexVersion: updated.version,
    }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
