/**
 * Step 3 — Pre × Pre cross-correlations.
 *
 * For pre-upload indicators that already have a significant pre→post edge
 * (so we know they matter for hooks), compute Pearson r between every pair.
 * Keep |r| >= 0.15 AND n >= 40.
 *
 * Output: pre_pre_correlations.json — [{a_key, b_key, r, n}]
 */

const fs = require('fs');
const path = require('path');

const INDICATORS_PATH = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis/indicators.json';
const PRE_POST_PATH = path.join(__dirname, 'pre_post_correlations.json');
const OUT_PATH = path.join(__dirname, 'pre_pre_correlations.json');

const MIN_R = 0.15;
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

console.log('Loading pre→post correlations…');
const prePost = JSON.parse(fs.readFileSync(PRE_POST_PATH, 'utf8'));
const activeKeys = new Set(prePost.map(e => e.pre_key));
console.log(`  ${activeKeys.size} pre indicators have at least one pre→post edge.`);

console.log('Loading indicators…');
const allInds = JSON.parse(fs.readFileSync(INDICATORS_PATH, 'utf8'));
const preInds = allInds.filter(i =>
    i.layer === 'pre' && i.dataset && i.dataset.length > 0 && activeKeys.has(i.key)
);
console.log(`  ${preInds.length} pre indicators with datasets ∩ active.`);

// Build maps
const maps = preInds.map(ind => {
    const m = new Map();
    for (const r of ind.dataset) {
        if (r.ytId != null && r.value != null && isFinite(r.value)) m.set(r.ytId, r.value);
    }
    return { key: ind.key, map: m };
});

// All ytIds — fixed order helps
const ytIdSet = new Set();
for (const { map } of maps) for (const yt of map.keys()) ytIdSet.add(yt);
const allYtIds = [...ytIdSet];
const idIndex = new Map(allYtIds.map((id, i) => [id, i]));

// Convert each indicator's data into a sparse vector keyed by ytId index.
// Store: keys list (ytId indexes) and values list (parallel arrays).
const sparse = maps.map(({ key, map }) => {
    const ks = [];
    const vs = [];
    for (const [yt, v] of map.entries()) {
        ks.push(idIndex.get(yt));
        vs.push(v);
    }
    // Sort by index so intersection by two-pointer is cheap.
    const order = ks.map((_, i) => i).sort((a, b) => ks[a] - ks[b]);
    return {
        key,
        ks: order.map(i => ks[i]),
        vs: order.map(i => vs[i]),
    };
});

console.log(`Computing pairs… ${sparse.length * (sparse.length - 1) / 2} candidates.`);

const edges = [];
let progress = 0;
const total = sparse.length;

for (let i = 0; i < sparse.length; i++) {
    const a = sparse[i];
    if (i % 50 === 0) console.log(`  ${i}/${total} (kept ${edges.length})`);
    for (let j = i + 1; j < sparse.length; j++) {
        const b = sparse[j];
        // Intersect by two-pointer
        let p = 0, q = 0;
        const xs = [], ys = [];
        while (p < a.ks.length && q < b.ks.length) {
            const ka = a.ks[p], kb = b.ks[q];
            if (ka === kb) {
                xs.push(a.vs[p]);
                ys.push(b.vs[q]);
                p++; q++;
            } else if (ka < kb) p++;
            else q++;
        }
        if (xs.length < MIN_N) continue;
        const { r, n } = pearson(xs, ys);
        if (Math.abs(r) >= MIN_R) edges.push({ a_key: a.key, b_key: b.key, r, n });
    }
}

edges.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
console.log(`Kept ${edges.length} pre×pre edges with |r| >= ${MIN_R} and n >= ${MIN_N}.`);

fs.writeFileSync(OUT_PATH, JSON.stringify(edges, null, 2));
console.log(`Saved ${OUT_PATH}`);
