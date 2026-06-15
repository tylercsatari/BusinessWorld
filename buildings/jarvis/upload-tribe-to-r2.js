/**
 * upload-tribe-to-r2.js — push the local tribe-analysis/*.json brain files to R2,
 * so Render (which can't hold 5GB in git) can serve them. The server already reads
 * `tribe-analysis/<videoId>.json` from R2 on demand (server.js ~line 5877), caching
 * locally — so once a file is in R2, it's viewable on the hosted site.
 *
 * Run from the project root on your Mac (where the files live + .env has R2 creds):
 *     node buildings/jarvis/upload-tribe-to-r2.js          # upload only missing files
 *     node buildings/jarvis/upload-tribe-to-r2.js --force  # re-upload everything
 *
 * Idempotent: skips files already in R2 unless --force. Safe to re-run / resume.
 */
const fs = require('fs');
const path = require('path');

// Load .env the same way server.js does (R2 creds live there).
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const eq = line.indexOf('=');
        if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
}

const cloud = require('../../cloud-storage');
cloud.initR2();   // must init the R2 client explicitly (same as sync-to-r2.js)
const DIR = path.join(__dirname, 'tribe-analysis');
const FORCE = process.argv.includes('--force');

async function waitForR2(ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (cloud.isR2Ready && cloud.isR2Ready()) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return cloud.isR2Ready && cloud.isR2Ready();
}

(async () => {
    if (!(await waitForR2())) { console.error('R2 not ready — check R2 creds in .env'); process.exit(1); }

    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.includes('.images.') && f !== 'fsaverage5_mesh.json');
    console.log(`${files.length} local tribe-analysis JSON files. force=${FORCE}`);

    let uploaded = 0, skipped = 0, failed = 0, bytes = 0;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const key = `tribe-analysis/${f}`;
        const local = path.join(DIR, f);
        try {
            if (!FORCE && (await cloud.existsInR2(key))) { skipped++; continue; }
            const buf = fs.readFileSync(local);                 // one file at a time; Mac has the RAM
            await cloud.uploadToR2(key, buf, 'application/json');
            uploaded++; bytes += buf.length;
            console.log(`  [${i + 1}/${files.length}] ↑ ${f} (${(buf.length / 1048576).toFixed(1)}MB)`);
        } catch (e) {
            failed++;
            console.error(`  [${i + 1}/${files.length}] ✗ ${f}: ${e.message}`);
        }
    }
    console.log(`\nDone. uploaded=${uploaded} skipped(already in R2)=${skipped} failed=${failed} total=${(bytes / 1073741824).toFixed(2)}GB`);
    if (failed) process.exit(1);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
