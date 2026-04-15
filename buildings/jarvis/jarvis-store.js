/**
 * Jarvis Store — R2-backed JSON persistence for Jarvis runtime data.
 * Uses cloud-storage.js primitives. R2 keys stored under jarvis/ prefix.
 *
 * When R2 is ready:  read from R2 (cached), write to R2 + local disk.
 * When R2 is absent: read/write local disk only (existing behavior).
 */
const path = require('path');
const fs = require('fs');
const cloudStorage = require('../../cloud-storage');
const { uploadToR2, downloadFromR2, existsInR2, isR2Ready } = cloudStorage;
// Auto-init R2 if credentials are present (needed when store runs outside server.js context)
if (!isR2Ready()) cloudStorage.initR2();

const R2_PREFIX = 'jarvis/';
const JARVIS_DIR = __dirname;

// In-memory cache with TTL
const cache = {};
const cacheTime = {};
const TTL_MS = 30 * 1000; // 30 seconds

// Canonical Jarvis data files that should be persisted to R2
const CANONICAL_FILES = [
    'indicators',
    'derived_experiments',
    'experiments_log',
    'graph',
    'resolutions',
    'tools',
    'autonomous_runs',
    'autonomous_progress',
    'candidate_queue'
];

// Default fallback values per file (matches existing behavior)
const DEFAULTS = {
    indicators: [],
    derived_experiments: [],
    experiments_log: [],
    graph: { nodes: [], edges: [], derived_edges: [] },
    resolutions: [],
    tools: [],
    autonomous_runs: [],
    autonomous_progress: { active: false, run_id: null, recent_events: [] },
    candidate_queue: []
};

function r2Key(name) { return `${R2_PREFIX}${name}.json`; }
function localPath(name) { return path.join(JARVIS_DIR, `${name}.json`); }

/**
 * Load JSON data by name.
 * Priority: cache (TTL) → R2 → local file → fallback.
 */
async function loadJson(name, fallback) {
    const fb = fallback !== undefined ? fallback : (DEFAULTS[name] ?? null);

    // Cache hit
    const now = Date.now();
    if (cache[name] && cacheTime[name] && (now - cacheTime[name]) < TTL_MS) {
        return cache[name];
    }

    // Try R2
    if (isR2Ready()) {
        try {
            const buf = await downloadFromR2(r2Key(name));
            if (buf) {
                const data = JSON.parse(buf.toString('utf8'));
                cache[name] = data;
                cacheTime[name] = now;
                return data;
            }
        } catch (e) {
            console.warn(`jarvis-store: R2 read failed for ${name}:`, e.message);
        }
    }

    // Fallback to local file
    const lp = localPath(name);
    try {
        if (fs.existsSync(lp)) {
            const data = JSON.parse(fs.readFileSync(lp, 'utf8'));
            cache[name] = data;
            cacheTime[name] = now;
            return data;
        }
    } catch (e) {
        console.warn(`jarvis-store: local read failed for ${name}:`, e.message);
    }

    return fb;
}

/**
 * Save JSON data by name.
 * Writes to R2 (if ready) + local disk + updates cache.
 */
async function saveJson(name, data) {
    const jsonStr = JSON.stringify(data, null, 2);

    // Update cache immediately
    cache[name] = data;
    cacheTime[name] = Date.now();

    // Write to R2
    if (isR2Ready()) {
        try {
            await uploadToR2(r2Key(name), Buffer.from(jsonStr), 'application/json');
        } catch (e) {
            console.warn(`jarvis-store: R2 write failed for ${name}:`, e.message);
        }
    }

    // Always write local copy (pipeline compat + safety)
    try {
        fs.writeFileSync(localPath(name), jsonStr);
    } catch (e) {
        console.warn(`jarvis-store: local write failed for ${name}:`, e.message);
    }
}

/**
 * Check if a Jarvis data file exists in R2.
 */
async function exists(name) {
    if (!isR2Ready()) return false;
    return existsInR2(r2Key(name));
}

/**
 * Seed a local file to R2 if the R2 key doesn't already exist.
 * Returns: 'seeded' | 'exists' | 'no-local' | 'no-r2'
 */
async function seedFromLocalIfMissing(name) {
    if (!isR2Ready()) return 'no-r2';

    const inR2 = await existsInR2(r2Key(name));
    if (inR2) return 'exists';

    const lp = localPath(name);
    if (!fs.existsSync(lp)) return 'no-local';

    const buf = fs.readFileSync(lp);
    await uploadToR2(r2Key(name), buf, 'application/json');
    console.log(`jarvis-store: seeded ${name} → R2`);
    return 'seeded';
}

/**
 * Force-upload a local file to R2 (overwrite).
 * Returns: 'uploaded' | 'no-local' | 'no-r2'
 */
async function forceUploadToR2(name) {
    if (!isR2Ready()) return 'no-r2';

    const lp = localPath(name);
    if (!fs.existsSync(lp)) return 'no-local';

    const buf = fs.readFileSync(lp);
    await uploadToR2(r2Key(name), buf, 'application/json');
    console.log(`jarvis-store: uploaded ${name} → R2 (overwrite)`);
    return 'uploaded';
}

/**
 * Migrate all canonical Jarvis files to R2.
 * mode: 'seed' = only if missing in R2, 'overwrite' = force upload all
 */
async function migrateAll(mode = 'seed') {
    if (!isR2Ready()) return { error: 'R2 not configured' };

    const results = {};
    for (const name of CANONICAL_FILES) {
        try {
            results[name] = mode === 'overwrite'
                ? await forceUploadToR2(name)
                : await seedFromLocalIfMissing(name);
        } catch (e) {
            results[name] = `error: ${e.message}`;
        }
    }
    return results;
}

/**
 * Invalidate cache for a specific key.
 */
function invalidateCache(name) {
    delete cache[name];
    delete cacheTime[name];
}

/**
 * Auto-seed: run on server startup to populate R2 from local if needed.
 */
async function autoSeed() {
    if (!isR2Ready()) {
        console.log('jarvis-store: R2 not ready, using local files only');
        return;
    }
    console.log('jarvis-store: checking R2 for missing Jarvis data...');
    const results = await migrateAll('seed');
    const seeded = Object.entries(results).filter(([, v]) => v === 'seeded');
    if (seeded.length > 0) {
        console.log(`jarvis-store: seeded ${seeded.length} file(s) to R2:`, seeded.map(([k]) => k).join(', '));
    } else {
        console.log('jarvis-store: all canonical files present in R2');
    }
}

module.exports = {
    loadJson,
    saveJson,
    exists,
    seedFromLocalIfMissing,
    forceUploadToR2,
    migrateAll,
    invalidateCache,
    autoSeed,
    CANONICAL_FILES,
    DEFAULTS
};
