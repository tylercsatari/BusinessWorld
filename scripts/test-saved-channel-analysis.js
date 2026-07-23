#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const analysis = require('../buildings/jarvis/saved-channel-analysis');

assert.strictEqual(analysis.contract.features.length, 21, 'saved channels must expose exactly 21 canonical outputs');
assert.deepStrictEqual(analysis.contract.groups.map(group => group.key), ['visual', 'text', 'together', 'novelty']);

const videos = [];
for (let index = 0; index < 96; index++) {
    const signal = Math.sin(index * 0.41) + ((index * 17) % 11) / 20;
    const logViews = 6.2 + signal * 0.9 + Math.sin(index * 2.17) * 0.04;
    const features = {};
    analysis.contract.features.forEach((feature, featureIndex) => {
        if (feature.group === 'text' && index % 4 === 0) return;
        const percentile = feature.key === 'visual.keep'
            ? 50 + signal * 24
            : 50 + Math.sin(index * (featureIndex + 3) * 0.73) * 28;
        const estimate = feature.key === 'visual.views'
            ? Math.pow(10, 6.2 + signal * 0.95)
            : feature.unit === 'views'
                ? Math.pow(10, 6.1 + Math.sin(index * (featureIndex + 5) * 0.39) * 0.7)
                : percentile;
        features[feature.key] = [estimate, percentile];
    });
    videos.push({
        id: `v${String(index).padStart(10, '0')}`,
        title: `Synthetic Short ${index}`,
        status: 'done',
        silent: index % 4 === 0,
        views: Math.round(Math.pow(10, logViews)),
        published: `2025${String((index % 12) + 1).padStart(2, '0')}${String((index % 27) + 1).padStart(2, '0')}`,
        viewsObservedAt: Date.UTC(2026, 6, 1),
        features,
    });
}

const first = analysis.analyzeChannel({ id: 'chtest', name: 'Synthetic', videos });
assert.strictEqual(first.status, 'ready');
assert.strictEqual(first.version, 5, 'visual analysis contract version must invalidate legacy cached responses');
assert.strictEqual(first.n, 96);
assert.strictEqual(first.eligibility.completedWithPublicViews, 96, 'eligibility must distinguish scored public-view rows from optional age metadata');
assert.strictEqual(first.eligibility.knownPublicationDates, 96);
assert.strictEqual(first.search.exhaustiveCandidates, 1561);
assert.strictEqual(first.singles[0].key, 'visual.keep', 'the known synthetic signal must rank first');
assert(first.singles[0].oof.r2 > 0.8, 'known signal should predict unseen rows');
assert(first.models.nestedSelected.r2 > 0.7, 'nested selection should recover the held-out signal');
assert.strictEqual(first.models.nestedSelected.points.length, videos.length);
assert.strictEqual(first.indicatorMatrix.columns.length, 21, 'matrix must contain every canonical indicator');
assert.strictEqual(first.indicatorMatrix.rows.length, videos.length, 'matrix must retain every scored Short');
assert.strictEqual(first.indicatorMatrix.rows[0].views, Math.max(...videos.map(video => video.views)), 'matrix rows should make actual-view trajectory visually explicit');
assert.strictEqual(first.indicatorMatrix.rows[0].rawValues.length, 21, 'matrix must retain exact stored values for point-level readouts');
assert.strictEqual(first.indicatorRelationships.columns.length, 21, 'redundancy map must cover every indicator');
assert.strictEqual(first.indicatorRelationships.matrix.length, 21, 'redundancy map must contain every row');
assert.strictEqual(first.indicatorRelationships.matrix[0].length, 21, 'redundancy map must be square');
assert(first.indicatorRelationships.matrix[0][0].spearman > 0.99, 'an indicator must be perfectly rank-correlated with itself');
assert.strictEqual(first.featureProfiles.length, 21, 'every indicator needs a visible score-to-outcome profile');
assert(first.featureProfiles.every(profile => profile.bins.length >= 2), 'every populated indicator needs visible trajectory bins');
assert(first.featureProfiles.find(profile => profile.key === 'text.keep').missing > 0, 'profile coverage must surface missing text inputs');
assert(first.outcomeProfile.histogram.reduce((sum, bin) => sum + bin.n, 0) === videos.length, 'outcome histogram must account for every analyzed Short');
assert.strictEqual(first.signalSummary.strongestTrajectory.key, 'visual.keep', 'known high-to-high signal should lead the trajectory summary');
assert.strictEqual(first.signalSummary.strongestBlindSingle.key, 'visual.keep', 'known held-out signal should lead the blind summary');
assert(first.singles.find(row => row.key === 'text.keep').coverage < 1, 'missing transcripts must be reported, not silently counted as observed');
assert.strictEqual(first.risk.model.status, 'ready', '10M tail-risk model should run when both outcomes exist');
assert(first.risk.model.nestedSelected.brierSkill > 0.5, 'selection-safe tail model should recover the synthetic hit signal');
const tenMillionRisk = first.risk.targets.find(target => target.targetViews === 10000000).cohorts.find(cohort => cohort.minAgeDays === 0);
const visualViewsRisk = tenMillionRisk.viewsSignals.find(signalRow => signalRow.key === 'visual.views');
const thirtyMillionThreshold = visualViewsRisk.thresholds.find(row => row.threshold === 30000000);
assert(thirtyMillionThreshold.n > 0 && thirtyMillionThreshold.hitRate > tenMillionRisk.baseRate, '30M normal-views embedding threshold should show conditional lift');
assert(thirtyMillionThreshold.ciLow < thirtyMillionThreshold.hitRate, 'risk table must expose uncertainty instead of treating an observed hit rate as certainty');
const matchedThirtyMillion = first.risk.matchedQuestions.find(question => question.targetViews === 30000000);
assert.strictEqual(matchedThirtyMillion.scoreThreshold, 30000000, 'fixed risk questions must compare like-for-like embedded and actual view cutoffs');
assert.deepStrictEqual(matchedThirtyMillion.signals.map(signal => signal.key), ['visual.views', 'text.views', 'together.views'], 'fixed risk questions must keep visual, text, and combined ordinary views axes distinct');
assert(matchedThirtyMillion.signals[0].passed > 0, 'fixed 30M evidence must retain the sample behind the probability');
assert(first.risk.model.chronological && first.risk.model.chronological.testN > 0, 'newer Shorts must receive a forward chronological blind check');
const fingerprint = analysis.savedChannelAnalysisFingerprint({ videos });
const changedVideos = videos.map((video, index) => index ? video : { ...video, views: video.views + 1 });
assert.notStrictEqual(fingerprint, analysis.savedChannelAnalysisFingerprint({ videos: changedVideos }), 'view refreshes must invalidate cached risk analysis');

const second = analysis.analyzeChannel({ id: 'chtest', name: 'Synthetic', videos });
assert.deepStrictEqual(
    { singles: first.singles, combinations: first.topCombinations, path: first.forwardPath, nested: first.models.nestedSelected, relationships: first.indicatorRelationships, profiles: first.featureProfiles, outcome: first.outcomeProfile },
    { singles: second.singles, combinations: second.topCombinations, path: second.forwardPath, nested: second.models.nestedSelected, relationships: second.indicatorRelationships, profiles: second.featureProfiles, outcome: second.outcomeProfile },
    'analysis must be deterministic'
);

const insufficient = analysis.analyzeChannel({ id: 'small', videos: videos.slice(0, 7) });
assert.strictEqual(insufficient.status, 'insufficient');

const ui = fs.readFileSync(path.join(__dirname, '..', 'buildings/jarvis/jarvis-retention.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const auth = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
for (const marker of ['data-savedbank', 'data-savedchanneladd', 'data-savedchannelvideo', 'Prediction analysis', 'Relationship atlas (21)', 'Every embedding output × actual views', 'data-savedchannelrelationshipatlas', 'data-savedchannelrelationshipplot', 'drawSavedChannelRelationshipPlots', 'Which single indicators predict log views?', 'Execution risk · can an embedding score justify making the video?', 'data-savedchannelrisktarget', 'data-savedchannelriskcutoff', 'data-savedchannelmatchedquestions', 'data-savedchannelriskprojection', 'data-savedchannelriskevidence', 'data-savedchannelriskinspector', 'data-savedchannelriskdrill', 'data-savedchannelriskthresholdtable', 'data-savedchannelriskcurve', 'data-savedchannelriskcalibration', 'the exact videos behind the number', 'data-savedchannelriskglossary', 'data-savedchannelanalysisartifact', 'conservative EV', 'data-savedchannelmatrix', 'Closest high → high trajectory', 'data-savedchannelindicatorplayground', 'data-savedchannelrelationships', 'data-savedchannelprofileatlas', 'data-savedchannelresiduals', 'savedChannelBinaryCurve', 'continue ${unfinished} unfinished', "st.savedChannelSort = 'feature'", 'wireSavedChannelImages', 'record.montageDataUrl = `/api/raw/saved-channel/']) {
    assert(ui.includes(marker), `Shorts Experiment UI is missing ${marker}`);
}
for (const route of ['/api/raw/saved-channels', '/api/raw/saved-channel', '/api/raw/hook-enrich', 'savedChannelAnalysis.analyzeChannel', 'serveR2ObjectForRequest(req, res, key']) {
    assert(server.includes(route), `server is missing ${route}`);
}
for (const cacheMarker of ["'X-Saved-Analysis'", "'ETag': etag", "storage: persisted ? 'R2'"]) {
    assert(server.includes(cacheMarker), `saved analysis persistence is missing ${cacheMarker}`);
}
assert(auth.includes("saved-channel\\/ch[a-f0-9]{16}\\/montage"), 'saved-channel public-Short montages must be readable by media requests without exposing score records');

console.log(JSON.stringify({
    ok: true,
    features: analysis.contract.features.length,
    candidates: first.search.exhaustiveCandidates,
    topSingle: first.singles[0].key,
    topSingleOofR2: first.singles[0].oof.r2,
    nestedOofR2: first.models.nestedSelected.r2,
    riskBrierSkill: first.risk.model.nestedSelected.brierSkill,
    threshold30MHitRate: thirtyMillionThreshold.hitRate,
}));
