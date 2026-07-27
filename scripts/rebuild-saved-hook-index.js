#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const cloud = require('../cloud-storage');
const {
    SAVED_HOOK_INDEX_VERSION,
    compactSavedHookRecord,
} = require('../embedding-display-contract');

const ROOT = path.resolve(__dirname, '..');
const INDEX_KEY = 'raw/saved-hooks/index.json';
const write = process.argv.includes('--write');
const concurrencyArg = process.argv.find(arg => arg.startsWith('--concurrency='));
const concurrency = Math.max(1, Math.min(32, Number(concurrencyArg && concurrencyArg.split('=')[1]) || 12));

for (const candidate of [
    process.env.BUSINESSWORLD_ENV,
    path.join(ROOT, '.env'),
    path.resolve(ROOT, '..', '..', '.env'),
]) {
    if (candidate && fs.existsSync(candidate)) {
        dotenv.config({ path: candidate, override: false, quiet: true });
        break;
    }
}

function json(buffer) {
    return buffer ? JSON.parse(buffer.toString('utf8')) : null;
}

function comparable(row) {
    const identities = row && row.m_identity || {};
    return JSON.stringify({
        keep: row && row.keep,
        m: row && row.m,
        identity: Object.fromEntries(Object.entries(identities).map(([key, value]) => [
            key,
            value && {
                sourceKey: value.sourceKey,
                est: value.est,
                pctile: value.pctile,
                kind: value.kind,
            },
        ])),
    });
}

async function mapLimit(items, limit, worker) {
    const output = new Array(items.length);
    let cursor = 0;
    async function run() {
        while (cursor < items.length) {
            const index = cursor++;
            output[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
}

async function rebuild(sourceIndex) {
    let changed = 0;
    const missingRecords = [];
    const hooks = await mapLimit(sourceIndex.hooks || [], concurrency, async oldRow => {
        const recordBuffer = await cloud.downloadFromR2(`raw/saved-hooks/${oldRow.id}.json`);
        if (!recordBuffer) {
            missingRecords.push(oldRow.id);
            return oldRow;
        }
        const compact = compactSavedHookRecord(json(recordBuffer));
        compact.folder = oldRow.folder || compact.folder;
        if (comparable(oldRow) !== comparable(compact)) changed++;
        return compact;
    });
    return {
        version: SAVED_HOOK_INDEX_VERSION,
        updatedAt: Date.now(),
        folders: Array.isArray(sourceIndex.folders) ? sourceIndex.folders : [],
        hooks,
        changed,
        missingRecords,
    };
}

async function main() {
    if (!cloud.initR2()) throw new Error('R2 credentials are unavailable');
    const originalBuffer = await cloud.downloadFromR2(INDEX_KEY);
    if (!originalBuffer) throw new Error(`${INDEX_KEY} does not exist`);
    const original = json(originalBuffer);
    if (!Array.isArray(original.hooks)) throw new Error('saved-hook index has no hooks array');

    const rebuilt = await rebuild(original);
    let verification = null;
    let backupKey = null;
    if (write) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupKey = `raw/saved-hooks/index.backup-${stamp}.json`;
        await cloud.uploadToR2(backupKey, originalBuffer, 'application/json');
        const output = {
            version: rebuilt.version,
            updatedAt: rebuilt.updatedAt,
            folders: rebuilt.folders,
            hooks: rebuilt.hooks,
        };
        await cloud.uploadToR2(INDEX_KEY, Buffer.from(JSON.stringify(output)), 'application/json');
        const persisted = json(await cloud.downloadFromR2(INDEX_KEY));
        const secondPass = await rebuild(persisted);
        verification = {
            version: persisted.version,
            hooks: persisted.hooks.length,
            remainingMismatches: secondPass.changed,
            missingRecords: secondPass.missingRecords.length,
        };
        if (verification.remainingMismatches !== 0) throw new Error(`post-write verification found ${verification.remainingMismatches} mismatches`);
    }

    console.log(JSON.stringify({
        ok: true,
        mode: write ? 'write' : 'audit',
        sourceVersion: original.version || 1,
        targetVersion: rebuilt.version,
        hooks: rebuilt.hooks.length,
        changed: rebuilt.changed,
        missingRecords: rebuilt.missingRecords,
        backupKey,
        verification,
    }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
