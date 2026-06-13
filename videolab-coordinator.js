/**
 * videolab-coordinator.js — Optimusk Prime coordinates data-backed video advice.
 *
 * Server-side, fully-logged agentic loop:
 *   1. Pre-fetch the real data (indicator relevance, retention rules, corpus
 *      benchmarks, this video's brain/analytics) — reliable, no agent-curl.
 *   2. Hand it to Optimusk Prime (`openclaw agent --agent optimusk --json`,
 *      Kimi K2.6) which DRAFTS advice, then SELF-CRITIQUES it against the numbers
 *      in a second pass (same session) — "keep questioning itself until sure".
 *   3. Save EVERYTHING to R2 (data used, every step, both passes, the full
 *      Optimusk Prime session transcript, parsed advice) so it's all reviewable.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cloud = require('./cloud-storage');
const dataStore = require('./data-store');

const JARVIS = path.join(__dirname, 'buildings', 'jarvis');
const OPENCLAW = fs.existsSync('/opt/homebrew/bin/openclaw') ? '/opt/homebrew/bin/openclaw' : 'openclaw';
const AGENT = process.env.VIDEOLAB_AGENT || 'optimusk';

function jj(f) { try { return JSON.parse(fs.readFileSync(path.join(JARVIS, f), 'utf8')); } catch (e) { return null; } }

// ── Assemble the real data the coordinator reasons over ──
function buildDataPack() {
    const model = jj('prediction-model.json');
    const derived = jj('derived_experiments_compact.json') || [];
    const topExp = derived.filter(d => typeof d.r === 'number')
        .sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 40)
        .map(d => ({ key: d.key, r: +d.r.toFixed(3) }));
    const patterns = jj('retention-patterns.json');
    const corpus = jj('signals-dataset-expanded.json') || [];
    const col = k => corpus.map(v => v[k]).filter(x => typeof x === 'number').sort((a, b) => a - b);
    const pct = (a, p) => a.length ? a[Math.floor((a.length - 1) * p)] : null;
    const benchmarks = {};
    ['retention', 'keep', 'views', 'retention_per_sec'].forEach(k => {
        const a = col(k); benchmarks[k] = a.length ? { median: pct(a, 0.5), p90: pct(a, 0.9) } : null;
    });
    const exemplars = corpus.slice().sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 8)
        .map(v => ({ title: v.name, views: v.views, retention: v.retention, keep: v.keep }));
    return {
        prediction_model: model ? { pre_upload_model: model.pre_upload_model, full_model: model.full_model } : null,
        top_experiments_by_correlation: topExp,
        retention_design_rules: patterns ? (patterns.top_5_retention_predictors || null) : null,
        corpus_benchmarks: benchmarks,
        top_view_exemplars: exemplars,
        corpus_size: corpus.length,
    };
}

async function videoContext(ytId) {
    const out = {};
    if (!ytId) return out;
    try {
        const vids = await dataStore.getAll('videos');
        const v = vids.find(x => x.youtubeVideoId === ytId);
        if (v) { out.title = v.name; out.analysisStatus = v.analysisStatus; }
    } catch (e) {}
    try {
        const bp = path.join(JARVIS, 'tribe-analysis', `${ytId}.json`);
        if (fs.existsSync(bp)) {
            const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
            out.brain = { engagement_score: b.engagement_score, n_timesteps: b.n_timesteps, peak_moments: (b.peak_moments || []).slice(0, 5) };
        }
    } catch (e) {}
    return out;
}

// ── Run one Optimusk Prime turn via the gateway ──
function runAgent(message, sessionId, opts = {}) {
    const thinking = opts.thinking || 'high';
    const timeout = opts.timeout || 240000;
    return new Promise((resolve) => {
        const args = ['agent', '--agent', AGENT, '-m', message, '--json', '--thinking', thinking];
        if (sessionId) args.push('--session-id', sessionId);
        execFile(OPENCLAW, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err && !stdout) { resolve({ error: (stderr || (err.killed ? 'timed out' : err.code) || 'failed').toString().slice(0, 300) }); return; }
            try {
                const j = JSON.parse(stdout);
                const text = (j.result && j.result.payloads || []).map(p => p.text).filter(Boolean).join('\n');
                const meta = j.result && j.result.meta && j.result.meta.agentMeta || {};
                resolve({ text, sessionId: meta.sessionId, sessionFile: meta.sessionFile, runId: j.runId, usage: meta.usage });
            } catch (e) { resolve({ error: 'parse: ' + e.message, raw: (stdout || '').slice(0, 1500) }); }
        });
    });
}

function parseJsonLoose(text) {
    if (!text) return null;
    try {
        let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
        const s = t.indexOf('{'), e = t.lastIndexOf('}');
        if (s >= 0 && e > s) t = t.slice(s, e + 1);
        return JSON.parse(t);
    } catch (e) { return null; }
}

const OUTPUT_CONTRACT = `Output STRICT JSON only (no prose, no markdown):
{"overallScore":<0-100 how strong this video is vs the corpus>,
 "vsCorpus":"<1 sentence: how it compares to the high-view benchmarks>",
 "tips":[{"rank":1,"timestamp_start":<the second in the video this applies to, or null>,"timestamp_end":<end second or null>,"tip":"<the improvement>","change":"<the concrete edit to make>","why":"<the principle + logic, referencing the data>","evidence":{"indicator":"<indicator/experiment/rule name>","r_or_weight":<the number>,"source":"<which dataset>"},"expectedImpact":"<plain estimate>","brainAlignment":"<TRIBE brain note or null>"}],
 "summary":"<2-3 sentence overall plan>"}
For timestamp_start/timestamp_end, use the beat timings from what Gemini saw so each tip pins to the exact moment in the video it concerns.`;

async function runCoordinator(jobId, { observations, ytId, videoTitle, videoUrl }) {
    const record = { jobId, ytId: ytId || null, videoTitle: videoTitle || null, videoUrl: videoUrl || null, status: 'running', startedAt: new Date().toISOString(), steps: [], advice: null };
    const save = () => cloud.uploadToR2(`data/videolab/${jobId}.json`, Buffer.from(JSON.stringify(record)), 'application/json').catch(() => {});
    const step = (name, data) => { record.steps.push({ name, at: new Date().toISOString(), ...(data || {}) }); };
    try {
        step('gather_data', { note: 'Fetched indicator relevance, retention rules, corpus benchmarks, and this video\'s brain/analytics.' });
        const dataPack = buildDataPack();
        const vctx = await videoContext(ytId);
        record.observations = observations;
        record.dataPack = dataPack;
        record.videoContext = vctx;
        await save();

        const brief = [
            `You are Optimusk Prime, the video-improvement coordinator for YouTuber Tyler Csatari. Give advice grounded ONLY in the data below — never guess. Every tip must cite a specific number.`,
            ``,
            `VIDEO: ${videoTitle || ytId || 'uploaded clip'}${ytId ? ' (' + ytId + ')' : ''}`,
            ``,
            `WHAT GEMINI SAW (the video's actual content):`,
            JSON.stringify(observations).slice(0, 5000),
            ``,
            `THIS VIDEO'S OWN DATA (analytics + TRIBE brain, if available):`,
            JSON.stringify(vctx).slice(0, 2500),
            ``,
            `INDICATOR RELEVANCE — the honest weighted prediction model + the strongest tested experiments (r = correlation to views):`,
            JSON.stringify({ prediction_model: dataPack.prediction_model, top_experiments_by_correlation: dataPack.top_experiments_by_correlation }).slice(0, 4000),
            ``,
            `RETENTION DESIGN RULES (vision-derived, with correlations):`,
            JSON.stringify(dataPack.retention_design_rules).slice(0, 2500),
            ``,
            `CORPUS BENCHMARKS (median / p90 across ${dataPack.corpus_size} videos) and TOP-VIEW EXEMPLARS:`,
            JSON.stringify({ benchmarks: dataPack.corpus_benchmarks, exemplars: dataPack.top_view_exemplars }).slice(0, 2500),
            ``,
            `TASK: Compare what Gemini saw against the indicators, rules, and benchmarks. Produce the highest-leverage, SPECIFIC improvements for THIS video. Rank them. Each tip must name the indicator/experiment/rule and its number.`,
            ``,
            OUTPUT_CONTRACT,
        ].join('\n');
        record.brief = brief;

        step('coordinator_pass_1', { note: 'Optimusk Prime drafting data-backed advice.' });
        await save();
        const p1 = await runAgent(brief);
        step('pass_1_result', { text: p1.text || null, error: p1.error || null, sessionId: p1.sessionId, runId: p1.runId, usage: p1.usage });
        await save();

        let finalText = p1.text;
        if (p1.text && p1.sessionId) {
            const critique = `Now SELF-CRITIQUE your draft. For each tip, verify it is defensible with a specific number from the data I gave you (an indicator correlation, a model feature weight, a retention rule r-value, or this video's brain/analytics). Drop any tip you cannot defend with a number; sharpen the rest and make the "change" a concrete edit. Then output your FINAL answer.\n\n${OUTPUT_CONTRACT}`;
            step('coordinator_pass_2', { note: 'Optimusk Prime self-critiquing against the numbers and finalizing.' });
            await save();
            // Best-effort, fast self-critique: medium thinking + tighter timeout so we either
            // sharpen the draft or fall back to it quickly (never hang for minutes).
            const p2 = await runAgent(critique, p1.sessionId, { thinking: 'medium', timeout: 150000 });
            step('pass_2_result', { text: p2.text || null, error: p2.error || null, usage: p2.usage });
            if (p2.text) finalText = p2.text;
            // Save the full Optimusk Prime session transcript (all reasoning/logic)
            try { if (p1.sessionFile && fs.existsSync(p1.sessionFile)) record.sessionTranscript = fs.readFileSync(p1.sessionFile, 'utf8').slice(0, 250000); } catch (e) {}
        }

        record.finalText = finalText || null;
        record.advice = parseJsonLoose(finalText);
        record.status = record.advice ? 'done' : 'done_unparsed';
        record.finishedAt = new Date().toISOString();
        await save();
        await updateHistory(record);
        return record;
    } catch (e) {
        record.status = 'error';
        record.error = e.message;
        record.finishedAt = new Date().toISOString();
        await save();
        return record;
    }
}

// Lightweight history index so past analyses are browsable.
async function updateHistory(record) {
    try {
        let idx = [];
        try { const buf = await cloud.downloadFromR2('data/videolab/index.json'); if (buf) idx = JSON.parse(buf.toString('utf8')); } catch (e) {}
        idx = idx.filter(x => x.jobId !== record.jobId);
        idx.unshift({
            jobId: record.jobId, ytId: record.ytId, videoTitle: record.videoTitle,
            status: record.status, finishedAt: record.finishedAt,
            overallScore: record.advice && record.advice.overallScore != null ? record.advice.overallScore : null,
            tipCount: record.advice && Array.isArray(record.advice.tips) ? record.advice.tips.length : 0,
        });
        idx = idx.slice(0, 100);
        await cloud.uploadToR2('data/videolab/index.json', Buffer.from(JSON.stringify(idx)), 'application/json');
    } catch (e) {}
}

module.exports = { runCoordinator, buildDataPack };
