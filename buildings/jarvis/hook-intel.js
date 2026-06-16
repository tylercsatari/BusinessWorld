/**
 * hook-intel.js — feeds the hook generator REAL data, two ways:
 *
 *  1. build()            — a compact pack of the channel's distilled swipe /
 *                          retention findings, design rules, word + visual
 *                          guidance, and the top real opening hooks.
 *  2. examples(q, n)     — retrieval: given a video's topic, returns the most
 *                          TOPICALLY SIMILAR past videos' ACTUAL opening hooks
 *                          (the real spoken line + the real opening visual +
 *                          view count), so the model learns from concrete proof
 *                          instead of inventing structure.
 *
 * The exemplars come from retention-event-library.json (370 posted videos, each
 * with per-moment words_spoken + frame_description). For the hook we take each
 * video's EARLIEST event — the opening line and the opening shot, exactly what
 * the new video needs. The heavy raw tables never enter a prompt; only these
 * small distilled/retrieved slices do.
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let _packCache = null, _packAt = 0;
let _corpus = null, _corpusAt = 0;
const CACHE_MS = 10 * 60 * 1000;

function readJson(rel) {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8')); }
    catch (e) { return null; }
}
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

const STOP = new Set(('the a an and or but to of in on for with this that these those is are was were be been it its i you he she they we my your our how what when why a video make made making build built i\'m i\'ll get got go went my').split(' '));
function tokens(s) {
    return (String(s || '').toLowerCase().match(/[a-z0-9']+/g) || []).filter(w => w.length > 2 && !STOP.has(w));
}

// Build the exemplar corpus once: every posted video's REAL opening hook.
function corpus() {
    if (_corpus && Date.now() - _corpusAt < CACHE_MS) return _corpus;
    const lib = readJson('retention-event-library.json') || {};
    const vids = Object.values(lib.videos || {});
    const out = [];
    for (const v of vids) {
        if (!v || !Array.isArray(v.events) || !v.events.length || !v.name) continue;
        const opening = [...v.events].sort((a, b) => (a.position_pct || 0) - (b.position_pct || 0))[0];
        const line = (opening.words_spoken || []).filter(w => !/^\[/.test(w)).join(' ').trim();
        if (!line || line.length < 6) continue;
        out.push({
            name: v.name, views: v.views || 0,
            line: clip(line, 180),
            visual: clip(opening.frame_description || '', 200),
            retention: typeof v.above_baseline_mean === 'number' ? +v.above_baseline_mean.toFixed(3) : null,
            _tok: tokens(v.name + ' ' + line)
        });
    }
    out.sort((a, b) => (b.views || 0) - (a.views || 0));
    _corpus = out; _corpusAt = Date.now();
    return out;
}

// Retrieval: the past openings most relevant to `query` (the new video's topic),
// blended with raw performance so the examples are both on-topic and proven.
function examples(query, limit) {
    const c = corpus();
    const n = Math.max(1, Math.min(limit || 12, 24));
    const strip = e => ({ name: e.name, views: e.views, line: e.line, visual: e.visual, retention: e.retention });
    const q = tokens(query);
    if (!q.length) return c.slice(0, n).map(strip);
    const qset = new Set(q);
    const scored = c.map(e => {
        let overlap = 0;
        for (const t of e._tok) if (qset.has(t)) overlap++;
        const viewBoost = Math.log10((e.views || 0) + 10) / 10;   // small tiebreak toward proven hits
        return { e, score: overlap + viewBoost };
    });
    scored.sort((a, b) => b.score - a.score);
    // Keep mostly-relevant, but if nothing matched the topic fall back to top hits.
    const top = scored.filter(s => s.score >= 1).slice(0, n).map(s => strip(s.e));
    return top.length ? top : c.slice(0, n).map(strip);
}

function build() {
    if (_packCache && Date.now() - _packAt < CACHE_MS) return _packCache;

    const findings = readJson('findings-summary.json') || {};
    const rp = readJson('retention-patterns.json') || {};
    const words = readJson('word-retention-impact.json') || {};
    const bridge = readJson('bridge_top_principles.json') || {};

    const discoveries = (findings.top_discoveries || []).slice(0, 7).map(d => ({
        signal: d.discovery, r: d.r_partial ?? d.r ?? null, meaning: clip(d.meaning, 220)
    }));
    const patterns = (findings.retention_patterns || []).slice(0, 6)
        .map(p => ({ pattern: p.pattern, evidence: clip(p.evidence, 200) }));
    const designRules = (rp.design_rules_summary_v3 || rp.design_rules_summary || [])
        .slice(0, 9).map(s => clip(s, 190));
    const predictors = (rp.top_5_retention_predictors || []).slice(0, 5).map(p => ({
        signal: p.signal, r: p.r_with_views, rule: clip(p.design_rule || p.description, 190)
    }));
    const ow = rp.opening_words || {};
    const visualPeakCauses = (rp.top_3_retention_peak_causes || []).map(c => ({ cause: c.cause, rule: clip(c.design_rule, 170) }));
    const retentionDropCauses = (rp.top_3_retention_drop_causes || []).map(c => ({ cause: c.cause, rule: clip(c.design_rule, 170) }));
    const wordArr = Object.entries(words)
        .filter(([w, v]) => /^[a-z][a-z'’-]+$/i.test(w) && v && typeof v.avg_ab === 'number' && (v.n || 0) >= 8)
        .map(([w, v]) => ({ w, ab: v.avg_ab }));
    const wordsThatRetain = wordArr.filter(x => x.ab > 0).sort((a, b) => b.ab - a.ab).slice(0, 16).map(x => x.w);
    const wordsThatKill = wordArr.filter(x => x.ab < 0).sort((a, b) => a.ab - b.ab).slice(0, 16).map(x => x.w);
    const principles = (bridge.top || []).slice(0, 12)
        .filter(p => p && p.via_indicator)
        .map(p => ({ signal: p.via_indicator, outcome: p.to_outcome, strength: typeof p.chain_strength === 'number' ? +p.chain_strength.toFixed(2) : null }));

    const c = corpus();
    _packCache = {
        generated: (findings.generated || '').slice(0, 10) || null,
        nVideos: c.length,
        objective: 'Win the first 3–5 seconds: keep ≥85% of viewers (swipe-away ≤15%) and hold retention high at 20s — the single strongest predictor of total views. A hook is the SPOKEN LINE and the OPENING VISUAL working together.',
        discoveries, patterns, designRules, predictors,
        openingWords: { bestFirst: ow.best_first_words || [], worstFirst: ow.worst_first_words || [], rule: clip(ow.design_rule, 200) },
        visualPeakCauses, retentionDropCauses,
        wordsThatRetain, wordsThatKill, principles,
        // Top REAL opening hooks by views (line + visual) — concrete proof.
        topExemplars: c.slice(0, 8).map(e => ({ line: e.line, visual: e.visual, views: e.views }))
    };
    _packAt = Date.now();
    return _packCache;
}

module.exports = { build, examples };
