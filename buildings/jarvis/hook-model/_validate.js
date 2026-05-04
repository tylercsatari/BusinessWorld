/**
 * Step 5 — Validate Hook Model v2 on 10 random videos.
 *
 * Pipeline (text → score):
 *   1. Featurize hook text via featurizer.js
 *   2. z_pre[fk] = (value - mean) / std       (per featurizer feature)
 *   3. post_score[p] = Σ r_pre_post[p][fk] * z_pre[fk]
 *   4. post_z[p] = (post_score[p] - combo_mean[p]) / combo_std[p]
 *   5. view_score = Σ_p r_post_views[p] * post_z[p]
 *   6. view_norm = sqrt(Σ_p r_post_views[p]^2)
 *   7. log10_views_pred = bias + log10_views_std * view_score / view_norm
 *
 * Inference uses ONLY featurizer-derived values (not Tactical Brain dataset
 * lookups), per the task spec — so a real new hook can be scored.
 *
 * Saves: validation_results.json
 */

const fs = require('fs');
const path = require('path');

const featurizer = require('./featurizer');

const VIDEOS_PATH = '/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset/01_video_performance/videos_complete.json';
const MODEL_PATH = path.join(__dirname, 'model-v2.json');
const OUT_PATH = path.join(__dirname, 'validation_results.json');

const DEFAULT_WPS = 4.402;

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

function predict(model, hookText, wps) {
    const fz = featurizer.featurize(hookText, wps);

    // z-score featurizer features
    const z_pre = {};
    for (const fk of model.feat_keys) {
        const stat = model.feature_stats[fk];
        const std = Math.max(stat.std || 1e-6, 1e-6);
        const v = fz.features[fk] || 0;
        z_pre[fk] = Math.max(-5, Math.min(5, (v - (stat.mean || 0)) / std));
    }

    // Post combo scores
    const post_z = {};
    for (const node of model.post_nodes) {
        const pk = node.key;
        const weights = model.pre_to_post_weights[pk] || {};
        let s = 0;
        for (const fk of model.feat_keys) {
            s += (weights[fk] || 0) * z_pre[fk];
        }
        const cstat = model.post_combo_stats[pk];
        const std = Math.max(cstat.std || 1e-6, 1e-6);
        post_z[pk] = (s - (cstat.mean || 0)) / std;
    }

    // View score, calibrated against measured training distribution.
    let view_score = 0;
    for (const node of model.post_nodes) {
        const w = model.post_to_views_weights[node.key] || 0;
        view_score += w * post_z[node.key];
    }
    const vstat = model.view_combo_stats;
    const view_z = (view_score - (vstat.mean || 0)) / Math.max(vstat.std || 1e-6, 1e-6);
    const log10_views_pred =
        model.bias +
        model.log10_views_std * (model.view_score_r_with_views || 0) * view_z;

    return { log10_views_pred, post_z, z_pre };
}

console.log('Loading model…');
const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
console.log(`  ${model.pre_nodes.length} pre nodes, ${model.post_nodes.length} post nodes, n=${model.training_n}.`);

console.log('Loading videos…');
const blob = JSON.parse(fs.readFileSync(VIDEOS_PATH, 'utf8'));
const allVideos = (Array.isArray(blob) ? blob : blob.videos).filter(v => v.total_views > 0);
console.log(`  ${allVideos.length} videos.`);

// Pick 10 videos spanning ~50K to ~50M views.
// Strategy: log-uniform buckets across the range, pick one per bucket.
const targetLow = 5e4;
const targetHigh = 5e7;
const eligible = allVideos.filter(v => v.total_views >= targetLow && v.total_views <= targetHigh);
console.log(`  ${eligible.length} eligible (50K..50M views).`);

eligible.sort((a, b) => a.total_views - b.total_views);
const N = 10;
const picks = [];
for (let i = 0; i < N; i++) {
    const idx = Math.floor(i * eligible.length / N + eligible.length / (2 * N));
    picks.push(eligible[Math.min(idx, eligible.length - 1)]);
}

const results = [];
let sumSqError = 0;
for (const v of picks) {
    const text = getHookText(v);
    const wps = getWps(v);
    const { log10_views_pred } = predict(model, text, wps);
    const log10_actual = Math.log10(v.total_views);
    const err = log10_views_pred - log10_actual;
    sumSqError += err * err;
    results.push({
        ytId: v.video_id,
        title: v.title,
        actual_views: v.total_views,
        predicted_views: Math.round(Math.pow(10, log10_views_pred)),
        log10_actual: parseFloat(log10_actual.toFixed(4)),
        log10_predicted: parseFloat(log10_views_pred.toFixed(4)),
        log10_error: parseFloat(err.toFixed(4)),
        wps: parseFloat(wps.toFixed(2)),
        hook_text: text,
    });
}
const rmse = Math.sqrt(sumSqError / results.length);

console.log('\nValidation results:');
console.log('ytId         actual    pred      log10_err    title');
console.log('───────────  ────────  ────────  ──────────   ────────────────────');
for (const r of results) {
    console.log(
        `${r.ytId.padEnd(12)} ${String(r.actual_views).padStart(8)}  ${String(r.predicted_views).padStart(8)}  ${(r.log10_error >= 0 ? '+' : '') + r.log10_error.toFixed(3).padStart(6)}    ${(r.title || '').slice(0, 50)}`
    );
}
console.log(`\nRMSE log10(views): ${rmse.toFixed(4)}`);
console.log(`Training σ_log10(views): ${model.log10_views_std.toFixed(4)}`);
console.log(`Skill ratio (lower=better): ${(rmse / model.log10_views_std).toFixed(3)}`);

fs.writeFileSync(OUT_PATH, JSON.stringify({
    rmse_log10: rmse,
    training_std_log10: model.log10_views_std,
    n_validation: results.length,
    results,
}, null, 2));
console.log(`Saved ${OUT_PATH}`);
