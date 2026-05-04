/**
 * Hook Model v2 — 3-layer linear scorer.
 *
 *     pre-upload features  →  post-upload metrics  →  log10(views)
 *
 * The model is fully described in model-v2.json:
 *   pre_nodes[]              text-derivable indicators × 4 time windows
 *   post_nodes[]              real YouTube performance metrics
 *   pre_to_post_weights{}     pearson r(pre_feature, post_metric) over training
 *   post_to_views_weights{}   pearson r(post_metric, log10(views)) over training
 *   feature_stats{}           mean/std for each pre feature key
 *   post_stats{}              mean/std for each post metric
 *   bias                      mean log10(views) over training
 *
 * Forward pass:
 *   1. z-score each pre feature against training stats, clip to ±5
 *   2. for each post node: post_act = Σ pre_to_post_weights[post][pre] · pre_z
 *   3. log10(views) = bias + Σ post_to_views_weights[post] · (post_act − μ)/σ
 *
 * The middle layer uses raw pearson r, so the scale of post_act is roughly
 * Σ(r²) — we re-normalize against post_stats before applying the post→views
 * weight so the contribution is in z-units.
 */

const fs = require('fs');
const path = require('path');

let _cachedModel = null;
const MODEL_PATH = path.join(__dirname, 'model-v2.json');

function loadModel(forceReload = false) {
    if (_cachedModel && !forceReload) return _cachedModel;
    const raw = fs.readFileSync(MODEL_PATH, 'utf8');
    _cachedModel = JSON.parse(raw);
    return _cachedModel;
}

function clip(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function score(features, matched, model = loadModel()) {
    const featureStats = model.feature_stats || {};
    const postStats = model.post_stats || {};
    const preNodes = model.pre_nodes || [];
    const postNodes = model.post_nodes || [];
    const preToPost = model.pre_to_post_weights || {};
    const postToViews = model.post_to_views_weights || {};
    const bias = typeof model.bias === 'number' ? model.bias : 6.2297;
    const yStd = typeof model.log10_views_std === 'number' ? model.log10_views_std : 0.78;

    // Step 1: pre-upload activations (z-scored)
    const preActivations = {};
    const preDetail = {};
    for (const node of preNodes) {
        const fk = node.key;
        const raw = features[fk] ?? 0;
        const stat = featureStats[fk] || { mean: 0, std: 1 };
        const std = Math.max(stat.std || 1e-6, 1e-6);
        const z = clip((raw - (stat.mean || 0)) / std, -5, 5);
        preActivations[fk] = z;
        preDetail[fk] = {
            key: fk,
            indicator_key: node.indicator_key,
            window: node.window,
            value: raw,
            zscore: z,
            r_with_views: node.r_with_views,
            label: node.label,
            description: node.description,
            matched: matched ? (matched[fk] || []) : [],
        };
    }

    // Step 2: post-upload activations
    // Σ r·z_pre then z-scored against the training-set distribution of the
    // exact same linear combination (post_combo_stats), so the middle layer
    // is in proper z-units regardless of how many pre nodes feed in.
    const comboStats = model.post_combo_stats || {};
    const postActivations = {};
    const postDetail = {};
    for (const node of postNodes) {
        const weights = preToPost[node.key] || {};
        let raw = 0;
        const drivers = [];
        for (const [preKey, w] of Object.entries(weights)) {
            const z = preActivations[preKey] || 0;
            const c = w * z;
            raw += c;
            if (Math.abs(c) > 1e-6) drivers.push({ pre_key: preKey, weight: w, pre_z: z, contrib: c });
        }
        const cstat = comboStats[node.key] || { mean: 0, std: 1 };
        const cstd = Math.max(cstat.std || 1e-6, 1e-6);
        const zPost = clip((raw - (cstat.mean || 0)) / cstd, -5, 5);
        postActivations[node.key] = zPost;
        drivers.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
        postDetail[node.key] = {
            key: node.key,
            label: node.label,
            description: node.description,
            improve_hint: node.improve_hint,
            r_with_views: node.r_with_views ?? postToViews[node.key],
            n_videos: node.n_videos,
            raw_activation: raw,
            zscore: zPost,
            drivers: drivers.slice(0, 12),
        };
    }

    // Step 3: views prediction
    let log10v = bias;
    const postContribs = [];
    for (const node of postNodes) {
        const w = postToViews[node.key] ?? 0;
        const z = postActivations[node.key];
        const contrib = w * z;
        log10v += contrib;
        postContribs.push({
            key: node.key,
            label: node.label,
            zscore: z,
            weight: w,
            contribution: contrib,
        });
    }
    postContribs.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    // Pre-upload contribution-to-views: trace each pre node through every post node.
    // Each path contributes (z_pre · w_pp / σ_combo) · w_pv, matching the
    // composition of steps 2 and 3 above.
    const preContribs = preNodes.map(node => {
        const z = preActivations[node.key];
        let totalContrib = 0;
        const paths = [];
        for (const post of postNodes) {
            const wPP = (preToPost[post.key] || {})[node.key] || 0;
            const wPV = postToViews[post.key] || 0;
            const cstat = comboStats[post.key] || { std: 1 };
            const cstd = Math.max(cstat.std || 1e-6, 1e-6);
            const c = (z * wPP / cstd) * wPV;
            totalContrib += c;
            if (Math.abs(c) > 1e-6) paths.push({ post_key: post.key, pre_to_post: wPP, post_to_views: wPV, contrib: c });
        }
        paths.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
        return {
            key: node.key,
            indicator_key: node.indicator_key,
            window: node.window,
            label: node.label,
            value: preDetail[node.key].value,
            zscore: z,
            matched: preDetail[node.key].matched,
            r_with_views: node.r_with_views,
            contribution: totalContrib,
            paths,
        };
    });
    preContribs.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    return {
        version: 'v2',
        log10_views: log10v,
        predicted_views: Math.pow(10, log10v),
        ci_low: Math.pow(10, log10v - 1.96 * yStd),
        ci_high: Math.pow(10, log10v + 1.96 * yStd),
        pre_activations: preActivations,
        post_activations: postActivations,
        pre_detail: preDetail,
        post_detail: postDetail,
        pre_contributions: preContribs,
        post_contributions: postContribs,
        bias,
        log10_views_std: yStd,
        mode: model.mode || 'measured',
    };
}

function predict(hookText, wps, model = loadModel()) {
    const featurizer = require('./featurizer');
    const fz = featurizer.featurize(hookText, wps || model.wps_default || 4.402);
    const out = score(fz.features, fz.matched, model);
    out.windows = fz.windows;
    out.matched = fz.matched;
    out.features = fz.features;
    out.wps = fz.wps;
    out.word_timings = featurizer.getWordTimings ? featurizer.getWordTimings(hookText, fz.wps) : null;
    return out;
}

module.exports = { loadModel, score, predict, MODEL_PATH };
