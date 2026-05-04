/**
 * Step 2 — Pre-upload × Post-upload cross-correlations.
 *
 * For every pre-upload indicator that has a per-video dataset, compute
 * Pearson r against every post-upload indicator. Inner-join on ytId.
 * Keep significant edges (|r| >= 0.07 AND n >= 40).
 *
 * Output: pre_post_correlations.json — [{pre_key, post_key, r, n}]
 */

const fs = require('fs');
const path = require('path');

const INDICATORS_PATH = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis/indicators.json';
const POST_VALUES_PATH = path.join(__dirname, 'post_indicator_values.json');
const OUT_PATH = path.join(__dirname, 'pre_post_correlations.json');

const MIN_R = 0.07;
const MIN_N = 40;

function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return { r: 0, n };
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
        sx += xs[i]; sy += ys[i];
        sxx += xs[i] * xs[i]; syy += ys[i] * ys[i];
        sxy += xs[i] * ys[i];
    }
    const num = n * sxy - sx * sy;
    const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    if (!isFinite(den) || den === 0) return { r: 0, n };
    return { r: num / den, n };
}

console.log('Loading indicators…');
const allInds = JSON.parse(fs.readFileSync(INDICATORS_PATH, 'utf8'));
const preInds = allInds.filter(i => i.layer === 'pre' && i.dataset && i.dataset.length > 0);
console.log(`  ${preInds.length} pre indicators with datasets.`);

console.log('Loading post indicator values…');
const postVals = JSON.parse(fs.readFileSync(POST_VALUES_PATH, 'utf8'));
const postKeys = Object.keys(postVals);
console.log(`  ${postKeys.length} post indicators.`);

// Build post lookup: postKey -> Map(ytId -> value)
const postMaps = {};
for (const pk of postKeys) {
    const m = new Map();
    for (const r of postVals[pk]) m.set(r.ytId, r.value);
    postMaps[pk] = m;
}

const edges = [];
let nComputed = 0, nKept = 0;

for (const pre of preInds) {
    const preMap = new Map();
    for (const r of pre.dataset) {
        if (r.ytId != null && r.value != null && isFinite(r.value)) preMap.set(r.ytId, r.value);
    }
    if (preMap.size < MIN_N) continue;

    for (const pk of postKeys) {
        const postMap = postMaps[pk];
        const xs = [];
        const ys = [];
        for (const [yt, v] of preMap.entries()) {
            const pv = postMap.get(yt);
            if (pv != null && isFinite(pv)) { xs.push(v); ys.push(pv); }
        }
        if (xs.length < MIN_N) continue;
        const { r, n } = pearson(xs, ys);
        nComputed++;
        if (Math.abs(r) >= MIN_R) {
            edges.push({ pre_key: pre.key, post_key: pk, r, n });
            nKept++;
        }
    }
}

edges.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

console.log(`Computed ${nComputed} pre×post pairs.`);
console.log(`Kept ${nKept} edges with |r| >= ${MIN_R} and n >= ${MIN_N}.`);

fs.writeFileSync(OUT_PATH, JSON.stringify(edges, null, 2));
console.log(`Saved ${OUT_PATH}`);

// Summary
const byPost = {};
for (const e of edges) byPost[e.post_key] = (byPost[e.post_key] || 0) + 1;
console.log('Edges per post node:');
for (const [k, c] of Object.entries(byPost).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${c}`);
}
const distinctPre = new Set(edges.map(e => e.pre_key));
console.log(`Distinct pre nodes with at least one edge: ${distinctPre.size}`);
