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

// Files that get precomputed compact mirrors (strip heavy dataset arrays)
const COMPACT_MIRROR_SOURCES = ['indicators', 'derived_experiments', 'experiments_log'];
const LARGE_JSON_KEYS = new Set(['indicators', 'derived_experiments', 'experiments_log', 'graph']);

function compactMirrorName(name) { return `${name}_compact`; }

function shouldCache(name) {
    return !LARGE_JSON_KEYS.has(name) && !LARGE_JSON_KEYS.has(String(name).replace(/_compact$/, ''));
}

function stringifyForStore(name, data) {
    return LARGE_JSON_KEYS.has(name) ? JSON.stringify(data) : JSON.stringify(data, null, 2);
}

function compactProject(name, item) {
    if (!item) return item;
    if (name === 'indicators') {
        const { dataset, ...rest } = item;
        return { ...rest, _datasetSize: Array.isArray(dataset) ? dataset.length : 0 };
    }
    if (name === 'experiments_log') {
        return {
            id: item.id,
            indicator_key: item.indicator_key,
            target: item.target,
            n_videos: item.n_videos,
            status: item.status,
            ran_at: item.ran_at,
            kind: item.kind,
            source: item.source,
            r: item.outputs && typeof item.outputs.r === 'number' ? item.outputs.r : null,
        };
    }
    return item;
}

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
 * Priority: cache (TTL) → local file → R2 → fallback.
 * Local-first: the runner always has current local files (R2 sync happens post-run),
 * so reading from R2 on startup wastes time downloading 200MB+ unnecessarily.
 */
async function loadJson(name, fallback) {
    const fb = fallback !== undefined ? fallback : (DEFAULTS[name] ?? null);

    // Cache hit
    const now = Date.now();
    if (shouldCache(name) && cache[name] && cacheTime[name] && (now - cacheTime[name]) < TTL_MS) {
        return cache[name];
    }

    // Prefer local file (always current — R2 sync is post-run, not pre-run)
    const lp = localPath(name);
    try {
        if (fs.existsSync(lp)) {
            const data = JSON.parse(fs.readFileSync(lp, 'utf8'));
            if (shouldCache(name)) {
                cache[name] = data;
                cacheTime[name] = now;
            }
            return data;
        }
    } catch (e) {
        console.warn(`jarvis-store: local read failed for ${name}:`, e.message);
    }

    // Fall back to R2 only if local file missing
    if (isR2Ready()) {
        try {
            const buf = await downloadFromR2(r2Key(name));
            if (buf) {
                const data = JSON.parse(buf.toString('utf8'));
                if (shouldCache(name)) {
                    cache[name] = data;
                    cacheTime[name] = now;
                }
                return data;
            }
        } catch (e) {
            console.warn(`jarvis-store: R2 read failed for ${name}:`, e.message);
        }
    }

    return fb;
}

/**
 * Save JSON data by name.
 * Writes to R2 (if ready) + local disk + updates cache.
 * Auto-generates compact mirror for eligible files.
 */
async function saveJson(name, data) {
    const jsonStr = stringifyForStore(name, data);

    // Update cache immediately for smaller files only
    if (shouldCache(name)) {
        cache[name] = data;
        cacheTime[name] = Date.now();
    } else {
        delete cache[name];
        delete cacheTime[name];
    }

    // Write to local copy immediately (pipeline compat + safety — never block on network)
    try {
        fs.writeFileSync(localPath(name), jsonStr);
    } catch (e) {
        console.warn(`jarvis-store: local write failed for ${name}:`, e.message);
    }

    // Auto-generate compact mirror (local only, fire immediately)
    if (COMPACT_MIRROR_SOURCES.includes(name)) {
        await saveCompactMirror(name, data);
    }

    // Fire-and-forget R2 write — never await in the main runner loop
    if (isR2Ready()) {
        uploadToR2(r2Key(name), Buffer.from(jsonStr), 'application/json')
            .catch(e => console.warn(`jarvis-store: R2 write failed for ${name}:`, e.message));
    }
}

/**
 * Save a compact mirror: dataset-stripped projection stored alongside the full file.
 */
async function saveCompactMirror(name, data) {
    if (!Array.isArray(data)) return;

    const compact = data.map(item => compactProject(name, item));
    const cn = compactMirrorName(name);
    const jsonStr = stringifyForStore(name, compact);

    if (shouldCache(cn)) {
        cache[cn] = compact;
        cacheTime[cn] = Date.now();
    } else {
        delete cache[cn];
        delete cacheTime[cn];
    }

    // Fire-and-forget compact mirror R2 write
    if (isR2Ready()) {
        uploadToR2(r2Key(cn), Buffer.from(jsonStr), 'application/json')
            .catch(e => console.warn(`jarvis-store: R2 compact write failed for ${cn}:`, e.message));
    }

    try {
        fs.writeFileSync(localPath(cn), jsonStr);
    } catch (e) {
        console.warn(`jarvis-store: local compact write failed for ${cn}:`, e.message);
    }
}

/**
 * Load a compact mirror by name. Never loads the full file.
 * Falls back to empty array if compact mirror doesn't exist.
 */
async function loadCompactJson(name, fallback) {
    const cn = compactMirrorName(name);
    const fb = fallback !== undefined ? fallback : [];

    const now = Date.now();
    if (shouldCache(cn) && cache[cn] && cacheTime[cn] && (now - cacheTime[cn]) < TTL_MS) {
        return cache[cn];
    }

    if (isR2Ready()) {
        try {
            const buf = await downloadFromR2(r2Key(cn));
            if (buf) {
                const data = JSON.parse(buf.toString('utf8'));
                if (shouldCache(cn)) {
                    cache[cn] = data;
                    cacheTime[cn] = now;
                }
                return data;
            }
        } catch (e) {
            console.warn(`jarvis-store: R2 compact read failed for ${cn}:`, e.message);
        }
    }

    const lp = localPath(cn);
    try {
        if (fs.existsSync(lp)) {
            const data = JSON.parse(fs.readFileSync(lp, 'utf8'));
            if (shouldCache(cn)) {
                cache[cn] = data;
                cacheTime[cn] = now;
            }
            return data;
        }
    } catch (e) {
        console.warn(`jarvis-store: local compact read failed for ${cn}:`, e.message);
    }

    console.warn(`jarvis-store: compact mirror not found for ${name} — return empty`);
    return fb;
}

/**
 * Invalidate compact mirror cache entry.
 */
function invalidateCompactCache(name) {
    const cn = compactMirrorName(name);
    delete cache[cn];
    delete cacheTime[cn];
}

/**
 * Build compact mirrors for any source that doesn't already have one in R2.
 * Intended for local/dev use — loads full files to project them.
 */
async function buildCompactMirrors() {
    const built = [];
    for (const name of COMPACT_MIRROR_SOURCES) {
        const cn = compactMirrorName(name);
        if (isR2Ready()) {
            try {
                const has = await existsInR2(r2Key(cn));
                if (has) continue;
            } catch {}
        }
        try {
            const data = await loadJson(name, []);
            if (Array.isArray(data) && data.length > 0) {
                await saveCompactMirror(name, data);
                built.push(`${name} (${data.length} items)`);
            }
        } catch (e) {
            console.warn(`jarvis-store: compact mirror build failed for ${name}:`, e.message);
        }
    }
    if (built.length > 0) {
        console.log('jarvis-store: built compact mirrors:', built.join(', '));
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
 * Also ensures compact mirrors exist in R2.
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
    // Ensure compact mirrors exist (builds from full files if missing)
    await buildCompactMirrors();
}

module.exports = {
    loadJson,
    saveJson,
    loadCompactJson,
    exists,
    seedFromLocalIfMissing,
    forceUploadToR2,
    migrateAll,
    invalidateCache,
    invalidateCompactCache,
    buildCompactMirrors,
    autoSeed,
    CANONICAL_FILES,
    COMPACT_MIRROR_SOURCES,
    DEFAULTS
};
