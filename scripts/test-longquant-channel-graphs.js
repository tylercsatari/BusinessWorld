'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'buildings', 'jarvis', 'jarvis-longquant.js'), 'utf8');
const helperStart = source.indexOf('const LQ_COMPARE_METRICS');
const helperEnd = source.indexOf('function lqxHash', helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error('Long Quant channel graph source not found');

const projection = {
    x: [100, 500, 900],
    y: [120, 520, 920],
    est: [1, 2, 3],
};
const rawChannel = {
    n: 3,
    id: ['a', 'b', 'c'],
    views: [100, 1000, 10000],
    proj: {
        ctrviews: { x: projection.x, y: projection.y },
        ctr: projection,
        ret30: projection,
        views: projection,
        realviews: projection,
        hi10m: projection,
    },
};
const metric = pctile => ({ est: pctile, pctile, kind: 'fixture' });
const channel = (withCtrViews, missingCalibrated) => ({
    metrics: {
        ctrviews: withCtrViews ? metric(91) : null,
        ctr: missingCalibrated ? null : metric(72),
        ret30: missingCalibrated ? null : metric(68),
        views: metric(77),
        realviews: missingCalibrated ? null : metric(74),
        gt10m: { est: 0.12, pctile: 12, kind: 'fixture' },
    },
    neighbors: [{ id: 'a', sim: 0.9 }, { id: 'b', sim: 0.8 }],
});

const context = {
    RAW: { visual: rawChannel, together: rawChannel },
    LQGRAPHHTML: {},
    C: {
        card: '#111', card2: '#222', border: '#333', text: '#eee', mute: '#888', faint: '#666',
        cyan: '#0ff', green: '#0c8', accent: '#08f', dim: '#999',
    },
    rawEnsure: () => {},
    rawRamp: () => '#38bdf8',
    esc: value => String(value == null ? '' : value),
    lqxNormalizeScore: score => score,
    lqxMetricPct: m => m && m.pctile == null ? null : Math.round(Number(m.pctile)),
};
vm.createContext(context);
vm.runInContext(
    source.slice(helperStart, helperEnd)
        + '\nthis.graphApi = { LQ_COMPARE_METRICS, lqxMetricForChannel, lqxStoredOutputCount, lqxHasTwelveOutputs, lqxChannelMetricHtml, lqxGraphGrid };',
    context
);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const score = {
    channels: {
        visual: channel(true, true),
        together: channel(false),
    },
};
const togetherCtrViews = context.graphApi.lqxMetricForChannel(score, 'together', 'ctrviews');
const visualCtr = context.graphApi.lqxMetricForChannel(score, 'visual', 'ctr');
assert(togetherCtrViews && togetherCtrViews.kind === 'neighbor_axis_percentile', 'together CTR+views did not derive from its own projection');
assert(visualCtr && visualCtr.kind === 'neighbor_axis_percentile', 'missing calibrated visual metric did not derive from its own projection');

const html = context.graphApi.lqxGraphGrid(score, 'fixture-thumb');
const summary = context.graphApi.lqxChannelMetricHtml(score);
const compactSummary = context.graphApi.lqxChannelMetricHtml(score, true);
const visualBindings = (html.match(/data-lqxrawchan="visual"/g) || []).length;
const togetherBindings = (html.match(/data-lqxrawchan="together"/g) || []).length;
const visualSummary = (summary.match(/title="visual embedding:/g) || []).length;
const togetherSummary = (summary.match(/title="together embedding:/g) || []).length;
assert(context.graphApi.LQ_COMPARE_METRICS.length === 6, 'expected six metrics per channel');
assert(context.graphApi.lqxStoredOutputCount(score) < 12 && !context.graphApi.lqxHasTwelveOutputs(score), 'partial stored score was mistaken for 12/12');
const completeScore = { channels: { visual: channel(true), together: channel(true) } };
assert(context.graphApi.lqxStoredOutputCount(completeScore) === 12 && context.graphApi.lqxHasTwelveOutputs(completeScore), 'complete stored score was not recognized');
assert(visualBindings === 6, `expected 6 visual graph bindings, got ${visualBindings}`);
assert(togetherBindings === 6, `expected 6 together graph bindings, got ${togetherBindings}`);
assert(visualSummary === 6 && togetherSummary === 6, '12-output summary is not grouped 6+6 by input');
assert(compactSummary.includes('12 embedding outputs') && compactSummary.includes('12/12'), 'compact cards do not expose the shared 12-output contract');
assert(!html.includes('data-lqxrawchan="text"'), 'text channel leaked into the requested 12-graph comparison');
assert(html.includes('12 independent embedding outputs by input'), '12-output heading missing');
assert(context.graphApi.lqxGraphGrid(score, 'fixture-thumb') === html, 'ready graph HTML was not cached');
assert(!source.includes('function lqxMetricHtml('), 'legacy mixed-channel renderer still exists');
const compactCalls = (source.match(/lqxChannelMetricHtml\([^\n]+, true\)/g) || []).length;
assert(compactCalls >= 7, `expected shared compact 12-output renderer across thumbnail surfaces, got ${compactCalls}`);
assert(source.includes('data-lqxscoretitle') && source.includes('JSON.stringify({ image: st.lqxScoreImg, title, idea: title })'), 'manual scoring does not send the together-channel input');

console.log(JSON.stringify({
    ok: true,
    metricsPerChannel: context.graphApi.LQ_COMPARE_METRICS.length,
    graphBindings: { visual: visualBindings, together: togetherBindings, total: visualBindings + togetherBindings },
    summaryOutputs: { visual: visualSummary, together: togetherSummary, total: visualSummary + togetherSummary },
    compactSummary: '12/12',
    sharedCompactRendererCalls: compactCalls,
    togetherCtrViews,
    visualCtrFallback: visualCtr,
    cached: true,
}, null, 2));
