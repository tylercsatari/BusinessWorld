/**
 * hook-intel.js — distills the processed Jarvis analytics into a COMPACT,
 * model-ready "hook intelligence pack".
 *
 * The raw tables (experiments_log, indicator-registry, graph, qrd_features…)
 * are tens of MB — far too much to put in a prompt. This module reads the
 * already-distilled, human-readable findings and assembles a small pack (a few
 * KB) the hook generator can reason over: the objective, the strongest swipe /
 * retention findings with their meanings, the design rules, word-level guidance,
 * the VISUAL peak/drop causes (so the visuals are designed from data too), the
 * top causal principles, and real exemplar videos that held the most viewers.
 *
 * Cached for 10 min. Everything is best-effort: a missing/sparse file just
 * drops that slice rather than failing.
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let _cache = null, _cacheAt = 0;
const CACHE_MS = 10 * 60 * 1000;

function readJson(rel) {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8')); }
    catch (e) { return null; }
}
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function build() {
    if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;

    const findings = readJson('findings-summary.json') || {};
    const rp = readJson('retention-patterns.json') || {};
    const swipe = readJson('qrd/qrd_swipe.json') || {};
    const targets = readJson('qrd/qrd_targets.json') || {};
    const words = readJson('word-retention-impact.json') || {};
    const bridge = readJson('bridge_top_principles.json') || {};

    // The strongest discoveries, with their plain-English meaning
    const discoveries = (findings.top_discoveries || []).slice(0, 7).map(d => ({
        signal: d.discovery, r: d.r_partial ?? d.r ?? null, meaning: clip(d.meaning, 220)
    }));

    // Retention patterns (evidence-backed)
    const patterns = (findings.retention_patterns || []).slice(0, 6)
        .map(p => ({ pattern: p.pattern, evidence: clip(p.evidence, 200) }));

    // Actionable design rules
    const designRules = (rp.design_rules_summary_v3 || rp.design_rules_summary || [])
        .slice(0, 9).map(s => clip(s, 190));

    // Top retention predictors with their design rule
    const predictors = (rp.top_5_retention_predictors || []).slice(0, 5).map(p => ({
        signal: p.signal, r: p.r_with_views, rule: clip(p.design_rule || p.description, 190)
    }));

    // First/last word guidance
    const ow = rp.opening_words || {};

    // VISUAL peak causes + language drop causes — designs the visuals from data
    const visualPeakCauses = (rp.top_3_retention_peak_causes || []).map(c => ({ cause: c.cause, rule: clip(c.design_rule, 170) }));
    const retentionDropCauses = (rp.top_3_retention_drop_causes || []).map(c => ({ cause: c.cause, rule: clip(c.design_rule, 170) }));

    // Word-level retention impact: the strongest helpers / killers (real A/B deltas)
    const wordArr = Object.entries(words)
        .filter(([w, v]) => /^[a-z][a-z'’-]+$/i.test(w) && v && typeof v.avg_ab === 'number' && (v.n || 0) >= 8)
        .map(([w, v]) => ({ w, ab: v.avg_ab }));
    const wordsThatRetain = wordArr.filter(x => x.ab > 0).sort((a, b) => b.ab - a.ab).slice(0, 16).map(x => x.w);
    const wordsThatKill = wordArr.filter(x => x.ab < 0).sort((a, b) => a.ab - b.ab).slice(0, 16).map(x => x.w);

    // Top causal principles (signal → outcome chains)
    const principles = (bridge.top || []).slice(0, 12)
        .filter(p => p && p.via_indicator)
        .map(p => ({ signal: p.via_indicator, outcome: p.to_outcome, strength: typeof p.chain_strength === 'number' ? +p.chain_strength.toFixed(2) : null }));

    // Real exemplars: the videos that held the MOST viewers past the hook
    // (lowest swipe-away %). Concrete proof of what an opening that works looks like.
    let exemplars = [];
    const oof = Array.isArray(swipe.oof) ? swipe.oof : [];
    if (oof.length) {
        exemplars = oof.filter(o => o && o.name && typeof o.swipe === 'number')
            .sort((a, b) => a.swipe - b.swipe).slice(0, 10)
            .map(o => ({ title: o.name, swipeAwayPct: +o.swipe.toFixed(2) }));
    } else {
        // fall back to qrd_targets if the swipe model OOF isn't present
        exemplars = Object.values(targets || {}).filter(t => t && typeof t.swipe === 'number')
            .sort((a, b) => a.swipe - b.swipe).slice(0, 10).map(t => ({ title: t.name || '(untitled)', swipeAwayPct: +t.swipe.toFixed(2) }));
    }

    _cache = {
        generated: (findings.generated || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        nVideos: swipe.n || (targets ? Object.keys(targets).length : null),
        objective: 'Win the first 3–5 seconds: keep ≥85% of viewers (swipe-away ≤15%) and hold retention high at the 20-second mark — empirically the single strongest predictor of total views. The hook is the SPOKEN LINE and the OPENING VISUAL working together.',
        discoveries, patterns, designRules, predictors,
        openingWords: { bestFirst: ow.best_first_words || [], worstFirst: ow.worst_first_words || [], rule: clip(ow.design_rule, 200) },
        visualPeakCauses, retentionDropCauses,
        wordsThatRetain, wordsThatKill,
        principles, exemplars
    };
    _cacheAt = Date.now();
    return _cache;
}

module.exports = { build };
