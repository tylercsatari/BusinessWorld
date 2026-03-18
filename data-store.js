/**
 * Data Store — R2-backed JSON collections with in-memory cache.
 * Each collection is a single JSON file: data/{name}.json
 * Format: { "lastModified": "ISO", "records": [...] }
 */
const crypto = require('crypto');
const { uploadToR2, downloadFromR2, isR2Ready } = require('./cloud-storage');

const COLLECTIONS = ['videos', 'ideas', 'todos', 'calendar', 'invoices', 'notes', 'sponsors', 'sponsorvideos'];
const cache = {};  // { collectionName: { lastModified, records } }
const cacheTime = {};  // { collectionName: timestamp }
const TTL_MS = 60 * 1000; // 60 seconds

function r2Key(name) { return `data/${name}.json`; }

async function load(name) {
    const now = Date.now();
    if (cache[name] && cacheTime[name] && (now - cacheTime[name]) < TTL_MS) {
        return cache[name];
    }
    if (!isR2Ready()) {
        // Don't cache when R2 isn't ready — return empty but allow retry once R2 initializes
        return { lastModified: new Date().toISOString(), records: [] };
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
    if (!isR2Ready()) return;
    const data = cache[name];
    if (!data) return;
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

module.exports = { COLLECTIONS, getAll, getById, create, update, remove };
