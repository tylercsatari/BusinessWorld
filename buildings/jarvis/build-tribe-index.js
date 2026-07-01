#!/usr/bin/env node
// build-tribe-index.js — builds a tiny index of every processed tribe-analysis video so the Brain tab
// can LIST them without the server reading 210 × (15-89MB) files into RAM (which OOMs the 2GB box).
// The metadata scalars (analyzed_at, duration_s, engagement_score, max_activation_second, n_timesteps)
// are top-level and near the FRONT of each JSON, so we read only the first ~256KB per file and regex
// them out — never loading the huge vertex/region arrays. Writes tribe-analysis/_index.json + uploads
// it to R2 (tribe-analysis/_index.json), which /api/tribe/available serves. Run: node buildings/jarvis/build-tribe-index.js
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (e) {}
let cloud = null; try { cloud = require('../../cloud-storage'); if (cloud.initR2) cloud.initR2(); } catch (e) { console.warn('R2 unavailable — will only write locally'); }

const DIR = path.join(__dirname, 'tribe-analysis');
const HEAD = 256 * 1024;   // bytes to read from the front of each file
const numOf = (buf, key) => { const m = buf.match(new RegExp('"' + key + '"\\s*:\\s*(-?[0-9.eE+]+)')); return m ? parseFloat(m[1]) : null; };
const strOf = (buf, key) => { const m = buf.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"')); return m ? m[1] : null; };

function readHead(fp) {
    const fd = fs.openSync(fp, 'r');
    try { const b = Buffer.alloc(HEAD); const n = fs.readSync(fd, b, 0, HEAD, 0); return b.slice(0, n).toString('utf8'); }
    finally { fs.closeSync(fd); }
}

// Human-readable title for a videoId, from the local private analytics (video_data/{id}/analysis.json).
// Baked into the index so the Brain-tab list shows names on the deploy (where video_data/ is absent).
const VDATA = path.join(DIR, '..', '..', '..', 'video_data');   // repo-root/video_data
function titleFor(id) {
    try {
        const p = path.join(VDATA, id, 'analysis.json');
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'))?.metadata?.title || null;
    } catch (e) { return null; }
}

(async () => {
    const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && !f.includes('.images') && !f.startsWith('_') && !f.includes('fsaverage') && !f.slice(0, -5).includes('.'));
    const index = [];
    for (const f of files) {
        try {
            const head = readHead(path.join(DIR, f));
            const n_timesteps = numOf(head, 'n_timesteps');
            const engagement_score = numOf(head, 'engagement_score');
            if (!n_timesteps || engagement_score == null) continue;   // not a real analysis
            const videoId = f.slice(0, -5);
            index.push({
                videoId,
                title: titleFor(videoId),
                analyzed_at: strOf(head, 'analyzed_at'),
                duration_s: numOf(head, 'duration_s') || 0,
                engagement_score,
                max_activation_second: numOf(head, 'max_activation_second') || 0,
                n_timesteps,
            });
        } catch (e) { console.warn('skip', f, e.message); }
    }
    index.sort((a, b) => (b.engagement_score || 0) - (a.engagement_score || 0));
    const out = JSON.stringify({ updated: Date.now(), n: index.length, videos: index });
    fs.writeFileSync(path.join(DIR, '_index.json'), out);
    console.log(`indexed ${index.length} tribe videos → _index.json (${(out.length / 1024).toFixed(1)}KB)`);
    if (cloud && cloud.uploadToR2) {
        await cloud.uploadToR2('tribe-analysis/_index.json', Buffer.from(out), 'application/json');
        console.log('uploaded → R2 tribe-analysis/_index.json');
    }
})().catch(e => { console.error(e); process.exit(1); });
