const path = require('path');
const fs = require('fs');
const metrics = require('../buildings/jarvis/jarvis-metrics.js');

const VIDEO_DATA_DIR = path.join(__dirname, '..', 'video_data');
function loadVideos() {
    const videos = [];
    if (!fs.existsSync(VIDEO_DATA_DIR)) { console.error('video_data dir not found'); return videos; }
    for (const d of fs.readdirSync(VIDEO_DATA_DIR)) {
        const ap = path.join(VIDEO_DATA_DIR, d, 'analysis.json');
        try {
            if (!fs.existsSync(ap)) continue;
            videos.push(JSON.parse(fs.readFileSync(ap, 'utf8')));
        } catch (e) { /* skip */ }
    }
    return videos;
}

const videos = loadVideos();
console.log(`Loaded ${videos.length} videos`);

const metricsToCheck = [
    'delayed_gratification_count', 'story_stake_count', 'hook_unresolved_density',
    'title_curiosity_gap_flag', 'delayed_gratification_peak_position_pct',
];

for (const m of metricsToCheck) {
    const vals = videos.map(v => {
        try { const r = metrics.extractMetric(m, v); return r && r[0] != null ? r[0] : null; }
        catch (e) { return null; }
    }).filter(v => v != null);
    const nonzero = vals.filter(v => v !== 0);
    console.log(`${m}: total=${vals.length} nonzero=${nonzero.length} mean=${nonzero.length ? (nonzero.reduce((a, b) => a + b, 0) / nonzero.length).toFixed(3) : 'N/A'}`);
}
