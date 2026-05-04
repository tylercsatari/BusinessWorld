/**
 * Hook Model — linear scorer.
 *
 * Loads model.json and produces a log10(views) prediction from a featurized
 * hook. Pure JS, no dependencies. Used by the server (lazy-loaded once) and
 * exposed for testing.
 *
 * Pipeline:
 *   1. featurize(hookText, wps)            → { features, matched, windows }
 *   2. score(features, model)              → { log10_views, predicted_views,
 *                                              ci_low, ci_high, contributions }
 */

const fs = require('fs');
const path = require('path');

let _cachedModel = null;
const MODEL_PATH = path.join(__dirname, 'model.json');

function loadModel(forceReload = false) {
    if (_cachedModel && !forceReload) return _cachedModel;
    const raw = fs.readFileSync(MODEL_PATH, 'utf8');
    _cachedModel = JSON.parse(raw);
    return _cachedModel;
}

function clip(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
}

/**
 * Compute log10(views) prediction for a feature vector.
 * @param {Object} features - { feature_key: numericValue }
 * @param {Object} matched - { feature_key: ["matched","phrases"] } (passthrough)
 * @param {Object} model - loaded model.json
 * @returns full score breakdown
 */
function score(features, matched, model = loadModel()) {
    const weights = model.weights || {};
    const stats = model.feature_stats || {};
    const bias = typeof model.bias === 'number' ? model.bias : 6.2297;
    const yStd = typeof model.log10_views_std === 'number' ? model.log10_views_std : 0.78;

    let logViews = bias;
    const contributions = [];

    for (const [fkey, w] of Object.entries(weights)) {
        const raw = features[fkey] ?? 0;
        const stat = stats[fkey] || { mean: 0, std: 1 };
        const std = Math.max(stat.std || 1e-6, 1e-6);
        const xNorm = clip((raw - (stat.mean || 0)) / std, -5, 5);
        const contrib = w * xNorm;
        logViews += contrib;
        contributions.push({
            key: fkey,
            value: raw,
            zscore: xNorm,
            weight: w,
            contribution: contrib,
            matched: matched ? (matched[fkey] || []) : [],
        });
    }

    contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    const predicted = Math.pow(10, logViews);
    const ciLow = Math.pow(10, logViews - 1.96 * yStd);
    const ciHigh = Math.pow(10, logViews + 1.96 * yStd);

    return {
        log10_views: logViews,
        predicted_views: predicted,
        ci_low: ciLow,
        ci_high: ciHigh,
        contributions,
        mode: model.mode || 'r_value_prior',
        bias,
        log10_views_std: yStd,
    };
}

/**
 * Convenience: featurize + score.
 */
function predict(hookText, wps, model = loadModel()) {
    const featurizer = require('./featurizer');
    const fz = featurizer.featurize(hookText, wps || model.wps_default || 4.402);
    const out = score(fz.features, fz.matched, model);
    out.windows = fz.windows;
    out.matched = fz.matched;
    out.features = fz.features;
    out.wps = fz.wps;
    return out;
}

module.exports = {
    loadModel,
    score,
    predict,
    MODEL_PATH,
};
