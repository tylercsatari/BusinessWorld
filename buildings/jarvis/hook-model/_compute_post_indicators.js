/**
 * Step 1 — Compute per-video post-upload indicator values.
 *
 * For every video with usable data we extract a set of atomic post-upload
 * indicators. These will become the post-upload nodes in model-v2 and are
 * the targets we cross-correlate every pre-upload indicator against.
 *
 * Output: post_indicator_values.json
 *   { indicator_key: [ { ytId, value, log10_views }, ... ], ... }
 */

const fs = require('fs');
const path = require('path');

const VIDEOS_PATH = '/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset/01_video_performance/videos_complete.json';
const OUT_PATH = path.join(__dirname, 'post_indicator_values.json');

function curveAt(curve, pos) {
    if (!curve || !curve.length) return null;
    let best = null, bestDist = Infinity;
    for (const p of curve) {
        const ppos = p.position != null ? p.position : (p.second != null ? p.second : null);
        if (ppos == null) continue;
        const d = Math.abs(ppos - pos);
        if (d < bestDist) { bestDist = d; best = p.retention; }
    }
    return best != null && isFinite(best) ? best : null;
}

function curveMean(curve, lo, hi) {
    if (!curve || !curve.length) return null;
    const vals = [];
    for (const p of curve) {
        const ppos = p.position != null ? p.position : (p.second != null ? p.second : null);
        if (ppos == null) continue;
        if (ppos >= lo && ppos <= hi && isFinite(p.retention)) vals.push(p.retention);
    }
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function asNumber(x) {
    return (x != null && isFinite(x)) ? x : null;
}

function extractIndicators(v) {
    const out = {};
    out.avg_percent_viewed       = asNumber(v.avg_percent_viewed);
    out.swiped_away_rate_pct     = asNumber(v.swiped_away_rate_pct);
    out.stayed_to_watch_pct      = asNumber(v.stayed_to_watch_pct);
    out.avg_retention_vs_baseline= asNumber(v.avg_retention_vs_baseline);
    out.non_sub_fraction         = asNumber(v.non_sub_fraction);
    out.retention_variation      = asNumber(v.retention_variation);

    const curve = Array.isArray(v.retention_curve) ? v.retention_curve : null;
    out['ret_at_10pct'] = curveAt(curve, 0.10);
    out['ret_at_25pct'] = curveAt(curve, 0.25);
    out['ret_at_50pct'] = curveAt(curve, 0.50);
    out['ret_at_75pct'] = curveAt(curve, 0.75);
    out['ret_at_85pct'] = curveAt(curve, 0.85);
    out['ret_at_90pct'] = curveAt(curve, 0.90);

    const r10 = curveAt(curve, 0.10);
    const r25 = curveAt(curve, 0.25);
    out['hook_drop'] = (r10 != null && r25 != null) ? (r10 - r25) : null;

    out['end_recovery'] = curveMean(curve, 0.80, 0.95);

    const q1 = curveMean(curve, 0.0, 0.25);
    const q4 = curveMean(curve, 0.75, 1.0);
    out['retention_quartile_spread'] = (q1 != null && q4 != null && q1 > 1e-6) ? q4 / q1 : null;

    return out;
}

console.log('Loading videos…');
const blob = JSON.parse(fs.readFileSync(VIDEOS_PATH, 'utf8'));
const videos = Array.isArray(blob) ? blob : blob.videos;
console.log(`  ${videos.length} videos.`);

const POST_KEYS = [
    'avg_percent_viewed', 'swiped_away_rate_pct', 'stayed_to_watch_pct',
    'avg_retention_vs_baseline', 'non_sub_fraction', 'retention_variation',
    'ret_at_10pct', 'ret_at_25pct', 'ret_at_50pct', 'ret_at_75pct',
    'ret_at_85pct', 'ret_at_90pct',
    'hook_drop', 'end_recovery', 'retention_quartile_spread',
];

const result = {};
for (const k of POST_KEYS) result[k] = [];

let nValid = 0;
for (const v of videos) {
    const views = v.total_views;
    const ytId = v.video_id;
    if (!ytId || !views || views <= 0) continue;
    const log10v = Math.log10(views);
    const inds = extractIndicators(v);
    for (const k of POST_KEYS) {
        const val = inds[k];
        if (val == null) continue;
        result[k].push({ ytId, value: val, log10_views: log10v });
    }
    nValid++;
}

console.log(`  ${nValid} videos had usable data.`);
console.log('Per-indicator counts:');
for (const k of POST_KEYS) {
    console.log(`  ${k.padEnd(30)} n=${result[k].length}`);
}

fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
console.log(`Saved ${OUT_PATH}`);
