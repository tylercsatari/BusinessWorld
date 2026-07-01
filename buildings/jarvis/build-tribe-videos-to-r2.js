#!/usr/bin/env node
// build-tribe-videos-to-r2.js — mirror every ANALYZED tribe video's video.mp4 to R2 so the Brain-tab
// player actually loads on the deploy (video_data/{id}/video.mp4 is local-only/gitignored → absent on
// Render). /api/tribe/video/:id redirects to a presigned URL of tribe-analysis/video/{id}.mp4.
// Only the analyzed set (from _index.json) is mirrored (~0.5 GB, median ~2MB). Idempotent: skips keys
// already in R2. Run after new analyses: node buildings/jarvis/build-tribe-videos-to-r2.js
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (e) {}
let cloud = null; try { cloud = require('../../cloud-storage'); if (cloud.initR2) cloud.initR2(); } catch (e) { console.error('R2 unavailable'); process.exit(1); }

const ROOT = path.join(__dirname, '..', '..');
const VDATA = path.join(ROOT, 'video_data');
const IDX = path.join(__dirname, 'tribe-analysis', '_index.json');

(async () => {
    if (!fs.existsSync(VDATA)) { console.error('no local video_data/ — run this on your Mac'); process.exit(1); }
    let ids = [];
    if (fs.existsSync(IDX)) { try { ids = (JSON.parse(fs.readFileSync(IDX, 'utf8')).videos || []).map(v => v.videoId); } catch (e) {} }
    if (!ids.length) ids = fs.readdirSync(VDATA).filter(v => fs.existsSync(path.join(VDATA, v, 'video.mp4')));

    let up = 0, skip = 0, miss = 0, fail = 0, bytes = 0;
    for (const id of ids) {
        const p = path.join(VDATA, id, 'video.mp4');
        if (!fs.existsSync(p)) { miss++; continue; }
        const key = `tribe-analysis/video/${id}.mp4`;
        try {
            if (await cloud.existsInR2(key)) { skip++; continue; }
            await cloud.uploadToR2(key, fs.readFileSync(p), 'video/mp4');
            up++; bytes += fs.statSync(p).size;
            if (up % 25 === 0) console.log(`  …uploaded ${up} (${(bytes / 1e6).toFixed(0)} MB)`);
        } catch (e) { console.warn('fail', id, e.message); fail++; }
    }
    console.log(`videos → R2 tribe-analysis/video/: uploaded=${up} (${(bytes / 1e6).toFixed(0)} MB) skipped(in R2)=${skip} missing-file=${miss} failed=${fail}`);
})().catch(e => { console.error(e); process.exit(1); });
