/**
 * Data Store — R2-backed JSON collections with in-memory cache.
 * Each collection is a single JSON file: data/{name}.json
 * Format: { "lastModified": "ISO", "records": [...] }
 */
const crypto = require('crypto');
const { uploadToR2, downloadFromR2, deleteFromR2, isR2Ready } = require('./cloud-storage');

const COLLECTIONS = ['videos', 'ideas', 'todos', 'calendar', 'invoices', 'notes', 'sponsors', 'sponsorvideos'];
const cache = {};  // { collectionName: { lastModified, records } }
const cacheTime = {};  // { collectionName: timestamp }
const TTL_MS = 60 * 1000; // 60 seconds

const MAX_BACKUPS = 5;

function r2Key(name) { return `data/${name}.json`; }
function backupIndexKey(name) { return `data/backups/${name}-index.json`; }
function backupDataKey(name, ts) { return `data/backups/${name}-${ts}.json`; }

async function loadBackupIndex(name) {
    const buf = await downloadFromR2(backupIndexKey(name));
    if (!buf) return [];
    try { return JSON.parse(buf.toString('utf8')); } catch { return []; }
}

async function saveBackupIndex(name, index) {
    await uploadToR2(backupIndexKey(name), Buffer.from(JSON.stringify(index)), 'application/json');
}

async function createBackup(name) {
    // Download current data from R2 (not cache — we want what's actually stored)
    const current = await downloadFromR2(r2Key(name));
    if (!current) return; // nothing to back up

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const key = backupDataKey(name, ts);
    await uploadToR2(key, current, 'application/json');

    // Update index
    const index = await loadBackupIndex(name);
    index.push(ts);

    // Trim to MAX_BACKUPS — delete oldest
    while (index.length > MAX_BACKUPS) {
        const oldest = index.shift();
        await deleteFromR2(backupDataKey(name, oldest));
    }
    await saveBackupIndex(name, index);
}

async function listBackups(name) {
    return loadBackupIndex(name);
}

async function restoreBackup(name, timestamp) {
    const index = await loadBackupIndex(name);
    // If no timestamp given, use the most recent
    const ts = timestamp || index[index.length - 1];
    if (!ts) throw new Error(`No backups found for collection "${name}"`);
    if (!index.includes(ts)) throw new Error(`Backup "${ts}" not found for collection "${name}"`);

    const buf = await downloadFromR2(backupDataKey(name, ts));
    if (!buf) throw new Error(`Backup data missing for "${ts}"`);

    // Restore: overwrite current data
    await uploadToR2(r2Key(name), buf, 'application/json');

    // Invalidate cache so next load picks up restored data
    delete cache[name];
    delete cacheTime[name];

    return JSON.parse(buf.toString('utf8'));
}

async function load(name) {
    const now = Date.now();
    if (cache[name] && cacheTime[name] && (now - cacheTime[name]) < TTL_MS) {
        return cache[name];
    }
    if (!isR2Ready()) {
        throw new Error('R2 not ready — refusing to serve empty data to prevent data loss');
    }
    const buf = await downloadFromR2(r2Key(name));
    if (buf) {
        cache[name] = JSON.parse(buf.toString('utf8'));
    } else {
        cache[name] = { lastModified: new Date().toISOString(), records: [] };
    }
    cacheTime[name] = now;
    return cache[name];
}

async function flush(name) {
    if (!isR2Ready()) throw new Error('R2 not ready — refusing to flush to prevent data loss');
    const data = cache[name];
    if (!data) return;
    // Back up current R2 data before overwriting
    try { await createBackup(name); } catch (e) {
        console.warn(`Backup failed for ${name} (continuing with flush):`, e.message);
    }
    data.lastModified = new Date().toISOString();
    await uploadToR2(r2Key(name), Buffer.from(JSON.stringify(data, null, 2)), 'application/json');
    cacheTime[name] = Date.now();
}

async function getAll(name) {
    const data = await load(name);
    return data.records;
}

async function getById(name, id) {
    const data = await load(name);
    return data.records.find(r => r.id === id) || null;
}

async function create(name, fields) {
    const data = await load(name);
    const record = { id: crypto.randomUUID(), ...fields, createdAt: new Date().toISOString() };
    data.records.push(record);
    await flush(name);
    return record;
}

async function update(name, id, fields) {
    const data = await load(name);
    const idx = data.records.findIndex(r => r.id === id);
    if (idx < 0) return null;
    Object.assign(data.records[idx], fields, { updatedAt: new Date().toISOString() });
    await flush(name);
    return data.records[idx];
}

async function remove(name, id) {
    const data = await load(name);
    const idx = data.records.findIndex(r => r.id === id);
    if (idx < 0) return false;
    data.records.splice(idx, 1);
    await flush(name);
    return true;
}

module.exports = { COLLECTIONS, getAll, getById, create, update, remove, listBackups, restoreBackup };
