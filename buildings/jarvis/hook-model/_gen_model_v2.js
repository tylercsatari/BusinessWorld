/**
 * Generate model-v2.json — 3-layer Hook Model.
 *
 *   pre-upload (text features)  →  post-upload (real YouTube metrics)  →  log10(views)
 *
 * Pre-upload features come from featurize() on each training video's transcript
 * (windowed by WPS to @1s/@3s/@5s/@10s exactly the way the runtime does it).
 *
 * Post-upload metrics are extracted from videos_complete.json:
 *   - swipe_away_rate            (swiped_away_rate_pct / 100)
 *   - end_recovery_score         (mean retention in 0.80–0.95 of curve)
 *   - retention_quartile_spread  (mean Q4 / mean Q1 retention)
 *   - retention_mean_75_100      (mean retention in last quarter)
 *   - hook_drop_rate             (retention[0–0.20] last − first; negative = dropping fast)
 *   - avg_percent_viewed         (avg_percent_viewed / 100)
 *
 * Pre→post weights = Pearson r(pre_feature_value, post_metric) across videos.
 * Post→views weights = Pearson r(post_metric, log10(views)) across videos.
 * Bias = mean(log10(views)) over training set.
 *
 * Run from repo root: node buildings/jarvis/hook-model/_gen_model_v2.js
 */

const fs = require('fs');
const path = require('path');

const featurizer = require('./featurizer');

const DATASET = '/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset';
const VIDEOS_PATH = path.join(DATASET, '01_video_performance/videos_complete.json');
const INDICATORS_PATH = path.join(DATASET, '02_jarvis_brain/indicators.json');
const OUT_PATH = path.join(__dirname, 'model-v2.json');

// ─────────── Quantifiable pre-upload indicators only ───────────
// Driven by featurizer.HOOK_INDICATORS — keep the model in lockstep with the
// featurizer's indicator registry. All entries are either:
//   structural (pure text statistics) or
//   linguistic (a CLOSED grammatical category in English).
// Arbitrary phrase-list indicators (proof_of_work, open_loop, sensory,
// action_verb, beat_count, hook_phrase_diversity, anticipation_escalation, …)
// have been removed and are expected to re-emerge as compound features.
const PRE_INDICATORS = Object.keys(featurizer.HOOK_INDICATORS);

const WINDOWS = [1, 3, 5, 10];

// ─────────── Post-upload nodes ───────────
const POST_NODES = [
    {
        key: 'swipe_away_rate',
        label: 'Swipe-Away Rate',
        description: 'Fraction of viewers who swipe away in the first second. Lower = better. Source: YouTube analytics swiped_away_rate_pct.',
        improve_hint: 'Front-load contrastive conjunctions (pivot_word) and questions in the @1s window — give the viewer something to resolve.',
    },
    {
        key: 'end_recovery_score',
        label: 'End Recovery Score',
        description: 'Mean retention from 80–95% of the video. Captures whether viewers "stick the landing".',
        improve_hint: 'Set up bigram callbacks (repeated_phrase_count) early — they pay off in the back half.',
    },
    {
        key: 'retention_quartile_spread',
        label: 'Retention Q4/Q1 Ratio',
        description: 'Mean retention in last quarter divided by first quarter. >1 = curve rising, <1 = curve falling.',
        improve_hint: 'Use repeated_phrase callbacks and pivot_word transitions to make the back half feel earned.',
    },
    {
        key: 'retention_mean_75_100',
        label: 'Final-Quarter Retention',
        description: 'Mean retention across the final quarter of the video (0.75–1.0).',
        improve_hint: 'Higher transcript_word_count and pivot_word density correlate with stronger final-quarter retention.',
    },
    {
        key: 'hook_drop_rate',
        label: 'Hook Drop Rate',
        description: 'Retention slope across the first 20% of the video (negative = dropping fast). Less negative = better hook.',
        improve_hint: 'Reduce hook_word_ratio (over-using question words hurts), favor contrastive conjunctions and concrete tokens.',
    },
    {
        key: 'avg_percent_viewed',
        label: 'Avg % Viewed',
        description: 'Average percentage of the video each viewer watched.',
        improve_hint: 'Longer hook setup (transcript_word_count @5s) and structural pivots correlate with higher overall retention.',
    },
];

// ─────────── Helpers ───────────

function pearsonr(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return { r: 0, p: 1, n };
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, valid = 0;
    for (let i = 0; i < n; i++) {
        const x = xs[i], y = ys[i];
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        valid++;
    }
    if (valid < 3) return { r: 0, p: 1, n: valid };
    const num = valid * sxy - sx * sy;
    const den = Math.sqrt((valid * sxx - sx * sx) * (valid * syy - sy * sy));
    if (den === 0) return { r: 0, p: 1, n: valid };
    const r = num / den;
    return { r, p: null, n: valid };
}

function meanStd(values) {
    const v = values.filter(x => x != null && isFinite(x));
    if (!v.length) return { mean: 0, std: 1, n: 0 };
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
    return { mean, std: Math.sqrt(variance) || 1, n: v.length };
}

// Reconstruct a hook script from the first ~10s of timestamped words, falling
// back to slicing the transcript by WPS×10 words if timestamps are missing.
function getHookText(video, wps) {
    const tw = video.transcript_words;
    if (Array.isArray(tw) && tw.length && tw[0].timestamp_s != null) {
        const cutoff = 10.0;
        const words = tw.filter(w => (w.timestamp_s || 0) <= cutoff).map(w => w.word);
        if (words.length >= 1) return words.join(' ');
    }
    const txt = video.transcript_text || '';
    const all = txt.split(/\s+/).filter(Boolean);
    return all.slice(0, Math.max(1, Math.round(wps * 10))).join(' ');
}

function extractPostMetrics(video) {
    const out = {};
    const swiped = video.swiped_away_rate_pct;
    out.swipe_away_rate = (swiped != null && isFinite(swiped)) ? swiped / 100 : null;

    const apv = video.avg_percent_viewed;
    out.avg_percent_viewed = (apv != null && isFinite(apv)) ? apv / 100 : null;

    const curve = Array.isArray(video.retention_curve) ? video.retention_curve : null;
    if (curve && curve.length) {
        const positions = curve.map(p => p.position != null ? p.position : (p.second != null ? p.second : null));
        const retentions = curve.map(p => p.retention);

        const inRange = (lo, hi) => {
            const vals = [];
            for (let i = 0; i < curve.length; i++) {
                const pos = positions[i];
                if (pos != null && pos >= lo && pos <= hi && isFinite(retentions[i])) vals.push(retentions[i]);
            }
            return vals;
        };

        const r80_95 = inRange(0.80, 0.95);
        out.end_recovery_score = r80_95.length ? r80_95.reduce((a, b) => a + b, 0) / r80_95.length : null;

        const q1 = inRange(0, 0.25);
        const q4 = inRange(0.75, 1.0);
        out.retention_quartile_spread = (q1.length && q4.length)
            ? (q4.reduce((a, b) => a + b, 0) / q4.length) / Math.max(0.01, q1.reduce((a, b) => a + b, 0) / q1.length)
            : null;

        const r75_100 = inRange(0.75, 1.0);
        out.retention_mean_75_100 = r75_100.length ? r75_100.reduce((a, b) => a + b, 0) / r75_100.length : null;

        const r0_20 = inRange(0, 0.20);
        out.hook_drop_rate = r0_20.length >= 2 ? (r0_20[r0_20.length - 1] - r0_20[0]) : null;
    } else {
        out.end_recovery_score = null;
        out.retention_quartile_spread = null;
        out.retention_mean_75_100 = null;
        out.hook_drop_rate = null;
    }
    return out;
}

// ─────────── Main ───────────

console.log('Loading videos…');
const videosRaw = JSON.parse(fs.readFileSync(VIDEOS_PATH, 'utf8'));
const videos = Array.isArray(videosRaw) ? videosRaw : videosRaw.videos;
console.log(`  ${videos.length} videos.`);

// Default WPS — average of training set (compute below); use 4.4 as initial guess.
const DEFAULT_WPS = 4.402;

// Featurize all videos
console.log('Featurizing transcripts…');
const featuresPerVid = []; // [{vid, features, post, log10v}]
let nWithViews = 0;
for (const v of videos) {
    const views = v.total_views;
    if (!views || views <= 0) continue;
    const text = getHookText(v, DEFAULT_WPS);
    if (!text || text.length < 3) continue;

    // Per-video WPS estimate from timestamped words if present
    const tw = v.transcript_words;
    let wps = DEFAULT_WPS;
    if (Array.isArray(tw) && tw.length >= 5 && tw[tw.length - 1].timestamp_s != null) {
        const dur = tw[tw.length - 1].timestamp_s - (tw[0].timestamp_s || 0);
        if (dur > 0) wps = tw.length / dur;
    }
    // Clip pathological wps
    if (!isFinite(wps) || wps < 1.5 || wps > 8) wps = DEFAULT_WPS;

    const fz = featurizer.featurize(text, wps);
    const post = extractPostMetrics(v);
    featuresPerVid.push({
        video_id: v.video_id,
        features: fz.features,
        post,
        log10v: Math.log10(views),
        views,
        wps,
    });
    nWithViews++;
}
console.log(`  ${nWithViews} videos featurized.`);

// Compute pre-feature stats (mean, std) per feature key
const featKeys = [];
for (const ind of PRE_INDICATORS) {
    for (const w of WINDOWS) featKeys.push(`${ind}_w${w}`);
}
const feature_stats = {};
for (const fk of featKeys) {
    const vals = featuresPerVid.map(r => r.features[fk]);
    feature_stats[fk] = meanStd(vals);
}

// Compute post-metric stats (real metric distribution — used by detail panel)
const post_stats = {};
for (const node of POST_NODES) {
    const vals = featuresPerVid.map(r => r.post[node.key]);
    post_stats[node.key] = meanStd(vals);
}

// Pre→post: pearson r between each pre feature key (windowed) and each post metric
console.log('Computing pre→post correlations…');
const pre_to_post_weights = {};
for (const node of POST_NODES) {
    pre_to_post_weights[node.key] = {};
    const ys = featuresPerVid.map(r => r.post[node.key]);
    for (const fk of featKeys) {
        const xs = featuresPerVid.map(r => r.features[fk]);
        const { r, n } = pearsonr(xs, ys);
        pre_to_post_weights[node.key][fk] = r;
    }
}

// Pre-feature z-scores per video (used to compute the linear-combination
// distribution for each post node — needed to z-score the middle layer).
const preZsPerVid = featuresPerVid.map(rec => {
    const zs = {};
    for (const fk of featKeys) {
        const stat = feature_stats[fk];
        const std = Math.max(stat.std || 1e-6, 1e-6);
        zs[fk] = Math.max(-5, Math.min(5, ((rec.features[fk] || 0) - (stat.mean || 0)) / std));
    }
    return zs;
});

// For each post node, compute Σ r · z_pre on every training video so we can
// store the mean/std of that linear combination. At inference we divide the
// raw activation by this std to get a proper z-score for the middle layer.
const post_combo_stats = {};
for (const node of POST_NODES) {
    const weights = pre_to_post_weights[node.key];
    const combos = preZsPerVid.map(zs => {
        let s = 0;
        for (const [fk, r] of Object.entries(weights)) s += r * (zs[fk] || 0);
        return s;
    });
    post_combo_stats[node.key] = meanStd(combos);
}

// Post→views: pearson r between each post metric and log10(views)
console.log('Computing post→views correlations…');
const post_to_views_weights = {};
const post_to_views_meta = {};
const ysLog = featuresPerVid.map(r => r.log10v);
for (const node of POST_NODES) {
    const xs = featuresPerVid.map(r => r.post[node.key]);
    const { r, n } = pearsonr(xs, ysLog);
    post_to_views_weights[node.key] = r;
    post_to_views_meta[node.key] = { r_with_views: r, n };
}

// Bias = mean log10(views)
const log10vStat = meanStd(ysLog);
const bias = log10vStat.mean;
const log10_views_std = log10vStat.std;

// Pre-node R-with-views (for display in detail panel)
console.log('Loading indicator metadata…');
const indicatorsBlob = JSON.parse(fs.readFileSync(INDICATORS_PATH, 'utf8'));
const indicatorList = Array.isArray(indicatorsBlob) ? indicatorsBlob : (indicatorsBlob.indicators || []);
const indicatorByKey = Object.fromEntries(indicatorList.map(i => [i.key, i]));

const featRegistry = featurizer.getIndicators();

const pre_nodes = [];
for (const ind of PRE_INDICATORS) {
    const meta = indicatorByKey[ind] || {};
    const reg = featRegistry[ind] || {};
    for (const w of WINDOWS) {
        const fk = `${ind}_w${w}`;
        pre_nodes.push({
            key: fk,
            indicator_key: ind,
            window: w,
            label: (meta.label || ind.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())),
            description: reg.description || meta.description || '',
            algorithm: reg.algorithm || '',
            category: reg.category || 'structural',
            quantifiable_reason: reg.quantifiable_reason || '',
            r_with_views: meta.r_with_views ?? reg.r ?? null,
            p_value: meta.p_value ?? reg.p ?? null,
            n_videos: meta.n_videos ?? reg.n ?? null,
            ci_low: meta.ci_low ?? null,
            ci_high: meta.ci_high ?? null,
            wordList: reg.wordList || null,
        });
    }
}

const removed_indicators = featurizer.getRemovedIndicators ? featurizer.getRemovedIndicators() : [];

const post_nodes = POST_NODES.map(n => ({
    key: n.key,
    label: n.label,
    description: n.description,
    improve_hint: n.improve_hint,
    r_with_views: post_to_views_weights[n.key],
    n_videos: post_to_views_meta[n.key].n,
    mean: post_stats[n.key].mean,
    std: post_stats[n.key].std,
}));

const model = {
    version: 'v2',
    mode: 'measured',
    note: 'v2 3-layer model: pre-upload text features → post-upload YouTube metrics → log10(views). All pre-upload features are quantifiable: pure text statistics or closed grammatical categories. Arbitrary phrase-list indicators were removed and are expected to re-emerge as compound features.',
    trained_at: new Date().toISOString(),
    training_n: nWithViews,
    bias,
    log10_views_std,
    wps_default: DEFAULT_WPS,
    time_windows: WINDOWS,
    pre_nodes,
    post_nodes,
    pre_to_post_weights,
    post_to_views_weights,
    feature_stats,
    post_stats,
    post_combo_stats,
    removed_indicators,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(model, null, 2));
console.log(`Saved ${OUT_PATH}`);
console.log(`  pre_nodes: ${pre_nodes.length}`);
console.log(`  post_nodes: ${post_nodes.length}`);
console.log(`  bias: ${bias.toFixed(4)}, σ: ${log10_views_std.toFixed(4)}`);
console.log('  post→views r:');
for (const node of POST_NODES) {
    console.log(`    ${node.key.padEnd(30)} r=${post_to_views_weights[node.key].toFixed(3)} (n=${post_to_views_meta[node.key].n})`);
}
