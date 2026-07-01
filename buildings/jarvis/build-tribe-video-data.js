#!/usr/bin/env node
// build-tribe-video-data.js — for every ANALYZED tribe video, extract its companion data
// (YouTube retention curve + duration + transcript) from the private video_data/{id}/analysis.json
// and upload it to R2 as tribe-analysis/video-data/{id}.json. This is what makes the brain-vs-retention
// overlay + frame captions work ON THE DEPLOY (video_data/ is local-only/gitignored, empty on Render).
// Only the analyzed set (from _index.json) gets a companion — no point shipping the other ~160.
// Run after new analyses: node buildings/jarvis/build-tribe-video-data.js
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (e) {}
let cloud = null; try { cloud = require('../../cloud-storage'); if (cloud.initR2) cloud.initR2(); } catch (e) { console.error('R2 unavailable — cannot upload'); process.exit(1); }

const DIR = path.join(__dirname, '..', '..');                 // repo root
const VDATA = path.join(DIR, 'video_data');
const IDX = path.join(__dirname, 'tribe-analysis', '_index.json');

(async () => {
    if (!fs.existsSync(VDATA)) { console.error('no local video_data/ dir — run this on your Mac'); process.exit(1); }
    // which videos are analyzed? prefer the local index, else every folder that has analysis.json
    let ids = [];
    if (fs.existsSync(IDX)) { try { ids = (JSON.parse(fs.readFileSync(IDX, 'utf8')).videos || []).map(v => v.videoId); } catch (e) {} }
    if (!ids.length) ids = fs.readdirSync(VDATA).filter(v => fs.existsSync(path.join(VDATA, v, 'analysis.json')));

    let up = 0, skip = 0, fail = 0;
    for (const id of ids) {
        const p = path.join(VDATA, id, 'analysis.json');
        if (!fs.existsSync(p)) { skip++; continue; }
        try {
            const a = JSON.parse(fs.readFileSync(p, 'utf8'));
            const rc = (a && a.analytics && Array.isArray(a.analytics.retentionCurve)) ? a.analytics.retentionCurve : [];
            const tr = (a && a.transcript) || {};
            const companion = {
                videoId: id,
                title: a?.metadata?.title || null,
                durationSec: Number(a?.metadata?.duration || a?.metadata?.durationSec || a?.analytics?.avgViewDuration || 0) || 0,
                avgViewDuration: a?.analytics?.avgViewDuration || null,
                avgPercentViewed: a?.analytics?.avgPercentViewed || null,
                retentionCurve: rc,
                transcript: { words: Array.isArray(tr.words) ? tr.words : [], fullText: tr.fullText || '' },
            };
            await cloud.uploadToR2(`tribe-analysis/video-data/${id}.json`, Buffer.from(JSON.stringify(companion)), 'application/json');
            up++;
            if (up % 25 === 0) console.log(`  …uploaded ${up}`);
        } catch (e) { console.warn('fail', id, e.message); fail++; }
    }
    console.log(`companions → R2 tribe-analysis/video-data/: uploaded=${up} skipped(no analysis)=${skip} failed=${fail}`);
})().catch(e => { console.error(e); process.exit(1); });
