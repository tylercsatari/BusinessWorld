/**
 * sync-analysis-to-r2.js — push local per-video analysis.json files to R2 so the
 * Pen (and the hook engine) can read them on Render, where the local video_data/
 * folder doesn't exist.
 *
 * Run it LOCALLY (where video_data/ lives) with your R2 env vars loaded:
 *   node sync-analysis-to-r2.js            # upload only the ones missing in R2
 *   node sync-analysis-to-r2.js --force    # re-upload everything
 *
 * It uploads each video_data/<ytId>/analysis.json to R2 key videos/<ytId>/analysis.json
 * (exactly the key videoAnalyzer.getAnalysis reads). Frames are uploaded by the
 * analyzer itself; this only syncs the analysis JSON (transcript/metadata/etc).
 */
require('dotenv').config && (() => { try { require('dotenv').config(); } catch (e) {} })();
const fs = require('fs');
const path = require('path');
const cloud = require('./cloud-storage');

const FORCE = process.argv.includes('--force');
const DIR = path.join(__dirname, 'video_data');

async function main() {
    if (!cloud.isR2Ready()) {
        console.error('R2 is not configured (missing R2 env vars). Aborting.');
        process.exit(1);
    }
    if (!fs.existsSync(DIR)) { console.error('No video_data/ directory here.'); process.exit(1); }
    const ids = fs.readdirSync(DIR).filter(d => fs.existsSync(path.join(DIR, d, 'analysis.json')));
    console.log(`Found ${ids.length} local analyses. ${FORCE ? 'Force re-uploading all.' : 'Uploading those missing in R2.'}`);

    let uploaded = 0, skipped = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const key = `videos/${id}/analysis.json`;
        try {
            if (!FORCE) {
                const existing = await cloud.downloadFromR2(key).catch(() => null);
                if (existing) { skipped++; continue; }
            }
            const buf = fs.readFileSync(path.join(DIR, id, 'analysis.json'));
            await cloud.uploadToR2(key, buf, 'application/json');
            uploaded++;
        } catch (e) {
            failed++;
            console.warn(`  ✗ ${id}: ${e.message}`);
        }
        if ((i + 1) % 50 === 0) console.log(`  …${i + 1}/${ids.length}  (uploaded ${uploaded}, skipped ${skipped}, failed ${failed})`);
    }
    console.log(`\nDone. Uploaded ${uploaded}, skipped ${skipped} (already in R2), failed ${failed}.`);
    console.log('The Pen and hook engine can now read these transcripts on Render.');
}
main();
