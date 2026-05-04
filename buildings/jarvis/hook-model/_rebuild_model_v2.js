/**
 * Step 4 — Rebuild model-v2.json from measured correlations.
 *
 * Three-layer graph:
 *   pre-upload indicators  →  post-upload indicators  →  log10(views)
 *
 * Pre nodes come from two sources:
 *   (a) dataset-based pre indicators in indicators.json (1134 total) —
 *       per-video values were measured by Tactical Brain experiments
 *   (b) featurizer.js indicators (13 × 4 windows = 52) —
 *       text-only formulas computable at inference time on a new hook
 *
 * Pre→post edges = Pearson r computed across videos. Significance gate
 * is applied (|r| >= 0.07, n >= 40) for the dataset-based path; for the
 * featurizer path we keep ALL edges so prediction can run end-to-end on
 * any new text. Edge weights = r values.
 *
 * Post→views weights = Pearson r between each post indicator and log10(views).
 *
 * Depth: dataset-based pre node depth = max(1, # of significant pre×pre
 * correlations it has with another pre node that is closer to post).
 * "Closer to post" = max |r_pre_post| ranking. Featurizer pre nodes are
 * always depth 1 (text → behavior is the closest tier).
 */

const fs = require('fs');
const path = require('path');

const featurizer = require('./featurizer');

const VIDEOS_PATH = '/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset/01_video_performance/videos_complete.json';
const INDICATORS_PATH = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis/indicators.json';
const POST_VALUES_PATH = path.join(__dirname, 'post_indicator_values.json');
const PRE_POST_PATH = path.join(__dirname, 'pre_post_correlations.json');
const PRE_PRE_PATH = path.join(__dirname, 'pre_pre_correlations.json');
const OUT_PATH = path.join(__dirname, 'model-v2.json');

const DEFAULT_WPS = 4.402;
const WINDOWS = [1, 3, 5, 10];

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

function meanStd(values) {
    const v = values.filter(x => x != null && isFinite(x));
    if (!v.length) return { mean: 0, std: 1, n: 0 };
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
    return { mean, std: Math.sqrt(variance) || 1, n: v.length };
}

function getHookText(video) {
    const tw = video.transcript_words;
    if (Array.isArray(tw) && tw.length && tw[0].timestamp_s != null) {
        const cutoff = 10.0;
        const words = tw.filter(w => (w.timestamp_s || 0) <= cutoff).map(w => w.word);
        if (words.length >= 1) return words.join(' ');
    }
    const txt = video.transcript_text || '';
    return txt.split(/\s+/).filter(Boolean).slice(0, Math.round(DEFAULT_WPS * 10)).join(' ');
}

function getWps(video) {
    const tw = video.transcript_words;
    if (Array.isArray(tw) && tw.length >= 5 && tw[tw.length - 1].timestamp_s != null) {
        const dur = tw[tw.length - 1].timestamp_s - (tw[0].timestamp_s || 0);
        if (dur > 0) {
            const wps = tw.length / dur;
            if (isFinite(wps) && wps >= 1.5 && wps <= 8) return wps;
        }
    }
    return DEFAULT_WPS;
}

console.log('Loading videos…');
const blob = JSON.parse(fs.readFileSync(VIDEOS_PATH, 'utf8'));
const videos = (Array.isArray(blob) ? blob : blob.videos).filter(v => v.total_views > 0);
console.log(`  ${videos.length} videos with views.`);

console.log('Loading post indicator values…');
const postVals = JSON.parse(fs.readFileSync(POST_VALUES_PATH, 'utf8'));
const POST_KEYS = Object.keys(postVals);

const postMaps = {};
for (const pk of POST_KEYS) {
    const m = new Map();
    for (const r of postVals[pk]) m.set(r.ytId, r.value);
    postMaps[pk] = m;
}

console.log('Loading dataset-based pre×post edges…');
const prePostEdges = JSON.parse(fs.readFileSync(PRE_POST_PATH, 'utf8'));
console.log(`  ${prePostEdges.length} edges loaded.`);

console.log('Loading pre×pre edges…');
const prePreEdges = JSON.parse(fs.readFileSync(PRE_PRE_PATH, 'utf8'));
console.log(`  ${prePreEdges.length} edges loaded.`);

console.log('Loading indicators metadata…');
const allInds = JSON.parse(fs.readFileSync(INDICATORS_PATH, 'utf8'));
const indByKey = Object.fromEntries(allInds.map(i => [i.key, i]));

// ─────────── Featurize videos ───────────
console.log('Featurizing videos…');
const featPerVid = [];
for (const v of videos) {
    const text = getHookText(v);
    if (!text || text.length < 3) continue;
    const wps = getWps(v);
    const fz = featurizer.featurize(text, wps);
    featPerVid.push({
        ytId: v.video_id,
        features: fz.features,
        log10v: Math.log10(v.total_views),
        wps,
    });
}
console.log(`  ${featPerVid.length} featurized.`);

// Featurizer feature keys (e.g. transcript_word_count_w3)
const FEAT_KEYS = [];
for (const k of Object.keys(featurizer.HOOK_INDICATORS)) {
    for (const w of WINDOWS) FEAT_KEYS.push(`${k}_w${w}`);
}

// Feature stats
const feature_stats = {};
for (const fk of FEAT_KEYS) {
    feature_stats[fk] = meanStd(featPerVid.map(r => r.features[fk]));
}

// Featurizer × post correlations
console.log('Computing featurizer pre→post correlations…');
const feat_pre_to_post = {};
for (const pk of POST_KEYS) {
    feat_pre_to_post[pk] = {};
    const pmap = postMaps[pk];
    for (const fk of FEAT_KEYS) {
        const xs = [], ys = [];
        for (const rec of featPerVid) {
            const pv = pmap.get(rec.ytId);
            const fv = rec.features[fk];
            if (pv != null && isFinite(pv) && fv != null && isFinite(fv)) {
                xs.push(fv); ys.push(pv);
            }
        }
        if (xs.length < 40) { feat_pre_to_post[pk][fk] = 0; continue; }
        const { r } = pearson(xs, ys);
        feat_pre_to_post[pk][fk] = r;
    }
}

// Featurizer × log10(views) (direct, for r_with_views display)
const feat_r_with_views = {};
for (const fk of FEAT_KEYS) {
    const xs = [], ys = [];
    for (const rec of featPerVid) {
        const fv = rec.features[fk];
        if (fv != null && isFinite(fv)) { xs.push(fv); ys.push(rec.log10v); }
    }
    feat_r_with_views[fk] = pearson(xs, ys).r;
}

// ─────────── Post → views ───────────
console.log('Computing post→views correlations…');
const log10vsByYt = new Map(featPerVid.map(r => [r.ytId, r.log10v]));
const post_to_views_weights = {};
const post_to_views_meta = {};
for (const pk of POST_KEYS) {
    const xs = [], ys = [];
    for (const r of postVals[pk]) {
        const lv = log10vsByYt.get(r.ytId);
        if (lv != null && isFinite(lv)) { xs.push(r.value); ys.push(lv); }
    }
    const { r, n } = pearson(xs, ys);
    post_to_views_weights[pk] = r;
    post_to_views_meta[pk] = { r, n };
}

// Post stats
const post_stats = {};
for (const pk of POST_KEYS) {
    post_stats[pk] = meanStd(postVals[pk].map(r => r.value));
}

// ─────────── pre_to_post_weights map ───────────
// Sparse: post_key → { pre_key: r }
const pre_to_post_weights = {};
for (const pk of POST_KEYS) pre_to_post_weights[pk] = {};

// Dataset-based pre nodes (sparse — only kept if |r| >= 0.07)
for (const e of prePostEdges) {
    pre_to_post_weights[e.post_key][e.pre_key] = e.r;
}
// Featurizer pre nodes (dense — keep all so inference can sum)
for (const pk of POST_KEYS) {
    for (const fk of FEAT_KEYS) {
        pre_to_post_weights[pk][fk] = feat_pre_to_post[pk][fk];
    }
}

// ─────────── Pre node list ───────────
// Active dataset-based pre nodes = those with at least one edge in prePostEdges
const activeDatasetPreKeys = new Set(prePostEdges.map(e => e.pre_key));

// Compute post_strength for each pre node = max |r| over its edges
const postStrength = {};
for (const k of activeDatasetPreKeys) postStrength[k] = 0;
for (const fk of FEAT_KEYS) postStrength[fk] = 0;
for (const e of prePostEdges) {
    const a = Math.abs(e.r);
    if (a > postStrength[e.pre_key]) postStrength[e.pre_key] = a;
}
for (const fk of FEAT_KEYS) {
    let mx = 0;
    for (const pk of POST_KEYS) {
        const a = Math.abs(feat_pre_to_post[pk][fk] || 0);
        if (a > mx) mx = a;
    }
    postStrength[fk] = mx;
}

// Depth: count significant pre×pre edges with another pre node that has
// HIGHER post_strength. (Featurizer pre nodes are always depth 1.)
function computeDepth() {
    const depths = {};
    // Index pre×pre edges by node
    const edgeIdx = {};
    for (const e of prePreEdges) {
        if (!edgeIdx[e.a_key]) edgeIdx[e.a_key] = [];
        if (!edgeIdx[e.b_key]) edgeIdx[e.b_key] = [];
        edgeIdx[e.a_key].push(e.b_key);
        edgeIdx[e.b_key].push(e.a_key);
    }
    for (const k of activeDatasetPreKeys) {
        const peers = edgeIdx[k] || [];
        const myStrength = postStrength[k] || 0;
        let count = 0;
        for (const p of peers) {
            if ((postStrength[p] || 0) > myStrength) count++;
        }
        depths[k] = Math.max(1, count);
    }
    for (const fk of FEAT_KEYS) depths[fk] = 1;
    return depths;
}
const depths = computeDepth();

// Build pre_nodes
const pre_nodes = [];

// (a) Featurizer pre nodes
const featRegistry = featurizer.getIndicators();
for (const k of Object.keys(featurizer.HOOK_INDICATORS)) {
    const reg = featRegistry[k] || {};
    const meta = indByKey[k] || {};
    for (const w of WINDOWS) {
        const fk = `${k}_w${w}`;
        pre_nodes.push({
            key: fk,
            indicator_key: k,
            window: w,
            source: 'featurizer',
            label: meta.label || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            description: reg.description || '',
            algorithm: reg.algorithm || '',
            category: reg.category || 'structural',
            quantifiable_reason: reg.quantifiable_reason || '',
            r_with_views: feat_r_with_views[fk],
            n_videos: featPerVid.length,
            wordList: reg.wordList || null,
            depth: depths[fk],
            post_strength: postStrength[fk] || 0,
        });
    }
}

// (b) Dataset-based pre nodes (those with at least one edge)
for (const k of activeDatasetPreKeys) {
    const meta = indByKey[k] || {};
    pre_nodes.push({
        key: k,
        indicator_key: k,
        window: null,
        source: 'tactical_brain',
        label: meta.label || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description: meta.metric_definition?.description || '',
        algorithm: meta.metric_definition?.formula || meta.metric_definition?.what_to_extract || '',
        category: meta.layer || 'pre',
        r_with_views: meta.result?.primary_r ?? null,
        p_value: meta.result?.p_value ?? null,
        n_videos: meta._datasetSize ?? null,
        depth: depths[k],
        post_strength: postStrength[k] || 0,
    });
}

// ─────────── Post nodes ───────────
const POST_NODE_LABELS = {
    avg_percent_viewed:        { label: 'Avg % Viewed',          desc: 'Average percentage of the video each viewer watched.' },
    swiped_away_rate_pct:      { label: 'Swipe-Away Rate',       desc: 'Percentage of viewers who swipe away in the first second.' },
    stayed_to_watch_pct:       { label: 'Stayed-to-Watch %',     desc: 'Percentage of impressions that converted to a sustained watch.' },
    avg_retention_vs_baseline: { label: 'Retention vs Baseline', desc: 'Average retention relative to the per-video YouTube baseline.' },
    non_sub_fraction:          { label: 'Non-Sub Fraction',      desc: 'Fraction of views from non-subscribers (proxy for reach).' },
    retention_variation:       { label: 'Retention Variation',   desc: 'Variability of the retention curve.' },
    ret_at_10pct:              { label: 'Retention @ 10%',       desc: 'Retention at 10% into the video.' },
    ret_at_25pct:              { label: 'Retention @ 25%',       desc: 'Retention at 25% into the video.' },
    ret_at_50pct:              { label: 'Retention @ 50%',       desc: 'Retention at the midpoint.' },
    ret_at_75pct:              { label: 'Retention @ 75%',       desc: 'Retention at 75% into the video.' },
    ret_at_85pct:              { label: 'Retention @ 85%',       desc: 'Retention at 85% into the video.' },
    ret_at_90pct:              { label: 'Retention @ 90%',       desc: 'Retention near the end of the video.' },
    hook_drop:                 { label: 'Hook Drop',             desc: 'Retention[10%] − Retention[25%]. Captures hook fall-off.' },
    end_recovery:              { label: 'End Recovery',          desc: 'Mean retention from 80–95% of the video.' },
    retention_quartile_spread: { label: 'Q4/Q1 Retention Ratio', desc: 'Mean Q4 retention / mean Q1 retention.' },
};

const post_nodes = POST_KEYS.map(pk => ({
    key: pk,
    label: POST_NODE_LABELS[pk]?.label || pk,
    description: POST_NODE_LABELS[pk]?.desc || '',
    r_with_views: post_to_views_weights[pk],
    n_videos: post_to_views_meta[pk].n,
    mean: post_stats[pk].mean,
    std: post_stats[pk].std,
}));

// ─────────── Post combo stats (for inference normalization) ───────────
// Per video, compute Σ r * z_score(featurizer_value) for each post node.
// Store mean/std so inference can normalize back to a unit-σ middle-layer.
const featZsPerVid = featPerVid.map(rec => {
    const zs = {};
    for (const fk of FEAT_KEYS) {
        const stat = feature_stats[fk];
        const std = Math.max(stat.std || 1e-6, 1e-6);
        zs[fk] = Math.max(-5, Math.min(5, ((rec.features[fk] || 0) - (stat.mean || 0)) / std));
    }
    return zs;
});
const post_combo_stats = {};
for (const pk of POST_KEYS) {
    const combos = featZsPerVid.map(zs => {
        let s = 0;
        for (const fk of FEAT_KEYS) s += (feat_pre_to_post[pk][fk] || 0) * (zs[fk] || 0);
        return s;
    });
    post_combo_stats[pk] = meanStd(combos);
}

// ─────────── Bias ───────────
const log10vStat = meanStd(featPerVid.map(r => r.log10v));
const bias = log10vStat.mean;

// ─────────── View-score calibration ───────────
// Compute the raw end-to-end view score on training data so inference can
// scale it back to log10(views) properly. This is just a re-derivation of
// the standard z×z×r calibration; no arbitrary weights are introduced.
const view_scores_train = featZsPerVid.map((zs, i) => {
    let view_score = 0;
    for (const pk of POST_KEYS) {
        const cstat = post_combo_stats[pk];
        const std = Math.max(cstat.std || 1e-6, 1e-6);
        let cs = 0;
        for (const fk of FEAT_KEYS) cs += (feat_pre_to_post[pk][fk] || 0) * (zs[fk] || 0);
        const post_z = (cs - (cstat.mean || 0)) / std;
        view_score += (post_to_views_weights[pk] || 0) * post_z;
    }
    return view_score;
});
const view_combo_stats = meanStd(view_scores_train);
// Pearson r between view_score and log10(views) — measured, not assumed.
const log10v_train = featPerVid.map(r => r.log10v);
const { r: view_score_r_with_views } = pearson(view_scores_train, log10v_train);

// ─────────── Pre×pre edge subset for visualization (top 2K by |r|) ───────────
const pre_pre_edges_top = prePreEdges.slice(0, 2000);

// ─────────── Assemble ───────────
const removed_indicators = featurizer.getRemovedIndicators ? featurizer.getRemovedIndicators() : [];

const model = {
    version: 'v2',
    mode: 'measured',
    note: 'v2 3-layer Hook Model. Pre-upload nodes come from (a) Tactical Brain experiments with measured per-video values and (b) the featurizer.js text-only indicators. Post-upload nodes are atomic metrics from videos_complete.json. Edge weights are Pearson r values measured across 372 videos. Pre→post edges below |r| >= 0.07 are dropped from the dataset-based path; featurizer→post edges are kept dense so inference can run on any new hook text.',
    trained_at: new Date().toISOString(),
    training_n: featPerVid.length,
    bias,
    log10_views_std: log10vStat.std,
    wps_default: DEFAULT_WPS,
    time_windows: WINDOWS,
    pre_nodes,
    post_nodes,
    pre_to_post_weights,
    post_to_views_weights,
    feature_stats,
    post_stats,
    post_combo_stats,
    feat_keys: FEAT_KEYS,
    view_combo_stats,
    view_score_r_with_views,
    pre_pre_edges_top,
    removed_indicators,
    counts: {
        pre_nodes_total: pre_nodes.length,
        pre_nodes_featurizer: FEAT_KEYS.length,
        pre_nodes_dataset: activeDatasetPreKeys.size,
        post_nodes: POST_KEYS.length,
        pre_post_edges: prePostEdges.length,
        pre_pre_edges_total: prePreEdges.length,
        pre_pre_edges_kept: pre_pre_edges_top.length,
    },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(model, null, 2));
console.log(`\nSaved ${OUT_PATH}`);
console.log(`  pre_nodes: ${pre_nodes.length} (featurizer ${FEAT_KEYS.length} + tactical ${activeDatasetPreKeys.size})`);
console.log(`  post_nodes: ${POST_KEYS.length}`);
console.log(`  bias: ${bias.toFixed(4)}, σ: ${log10vStat.std.toFixed(4)}`);
console.log('  post→views r:');
for (const pk of POST_KEYS) {
    console.log(`    ${pk.padEnd(30)} r=${post_to_views_weights[pk].toFixed(3)} (n=${post_to_views_meta[pk].n})`);
}

// Depth distribution
const depthDist = {};
for (const n of pre_nodes) depthDist[n.depth] = (depthDist[n.depth] || 0) + 1;
console.log('  depth distribution:', depthDist);
