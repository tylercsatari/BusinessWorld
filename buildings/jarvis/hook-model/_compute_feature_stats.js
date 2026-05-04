/**
 * Compute per-feature mean/std on the 372-video training corpus by running
 * the JS featurizer over each video's first ~10s of transcript. Writes the
 * results back into model.json under feature_stats so the scorer produces
 * sensible predictions even before train.py runs.
 *
 * Also recomputes bias = mean log10(views) over the corpus and
 * log10_views_std = std log10(views) (used for the ±1.96σ confidence band).
 *
 * Usage: node _compute_feature_stats.js
 */

const fs = require('fs');
const path = require('path');
const { featurize } = require('./featurizer');

const TRANSCRIPTS = '/Users/tylercsatari/Desktop/BusinessHub/tyler_ml_dataset/01_video_performance/transcripts_with_segments.json';
const MODEL_PATH = path.join(__dirname, 'model.json');

function main() {
    const data = JSON.parse(fs.readFileSync(TRANSCRIPTS, 'utf8'));
    const videos = data.videos || [];
    console.log(`Loaded ${videos.length} videos`);

    const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    const featureKeys = Object.keys(model.weights);

    // Buckets for online mean/var (Welford)
    const stats = {};
    for (const k of featureKeys) stats[k] = { n: 0, mean: 0, M2: 0 };

    // Compute corpus-wide WPS too — words per second across all videos
    let totalWords = 0, totalSeconds = 0;
    let logViewSum = 0, logViewSumSq = 0, nView = 0;

    for (const v of videos) {
        const tWords = v.transcript_words || [];
        if (!tWords.length || !v.total_views) continue;

        // Build the hook from words within 10s timestamps
        const hookWords = tWords.filter(w => w.timestamp_s != null && w.timestamp_s <= 10).map(w => w.word);
        if (!hookWords.length) continue;
        const hookText = hookWords.join(' ');

        // Per-video wps (used for window extraction inside featurize)
        const lastT = tWords[tWords.length - 1].timestamp_s || 1;
        const wps = tWords.length / Math.max(lastT, 1);
        totalWords += tWords.length;
        totalSeconds += Math.max(lastT, 1);

        const fz = featurize(hookText, wps);

        for (const k of featureKeys) {
            const x = fz.features[k] ?? 0;
            const s = stats[k];
            s.n++;
            const delta = x - s.mean;
            s.mean += delta / s.n;
            s.M2 += delta * (x - s.mean);
        }

        const lv = Math.log10(v.total_views);
        logViewSum += lv;
        logViewSumSq += lv * lv;
        nView++;
    }

    const corpusWps = totalSeconds > 0 ? totalWords / totalSeconds : 4.402;
    const meanLogViews = logViewSum / nView;
    const varLogViews = (logViewSumSq / nView) - meanLogViews * meanLogViews;
    const stdLogViews = Math.sqrt(Math.max(0, varLogViews));

    console.log(`Corpus wps = ${corpusWps.toFixed(3)}`);
    console.log(`mean log10(views) = ${meanLogViews.toFixed(4)}`);
    console.log(`std log10(views)  = ${stdLogViews.toFixed(4)}`);

    // Convert Welford to mean/std and write back
    const featureStats = {};
    for (const [k, s] of Object.entries(stats)) {
        const variance = s.n > 1 ? s.M2 / (s.n - 1) : 0;
        featureStats[k] = {
            mean: s.mean,
            std: Math.sqrt(variance),
            n: s.n,
        };
    }

    model.feature_stats = featureStats;
    model.bias = meanLogViews;
    model.log10_views_std = stdLogViews;
    model.wps_default = corpusWps;
    model.training_n = nView;
    model.note = (
        'Weights = Pearson r-values from indicators.json (mode=r_value_prior). ' +
        'Feature stats computed by running JS featurizer over the 372 training transcripts. ' +
        'Replaced after train.py with LOO-trained weights.'
    );

    fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));
    console.log(`Updated ${MODEL_PATH}`);
}

main();
