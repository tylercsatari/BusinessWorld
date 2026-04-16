#!/usr/bin/env node
'use strict';
/**
 * Phase 4 — Principle candidate surfacing.
 *
 * Per §7 of the meta-architecture, principles are candidate causal hypotheses
 * on edges in the graph: mechanism → indicator → outcome. They are emergent,
 * plural, and refinable.
 *
 * For each (mechanism, indicator) link from phase 2, look up the indicator's
 * known correlation with views (from indicators.json / derived_experiments.json
 * / known indicator family) and emit a candidate principle that combines both
 * legs. Hypothesis text is templated, not creative writing — the tag is honest.
 *
 * Outputs:
 *   principles.json
 *   principle_gaps.json
 */

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');

const PHASE_ID = 'phase_4_principles';
const JARVIS = lib.JARVIS_DIR;

// Indicator → views(log10) reference correlations.
// We pull from existing indicator catalog where available; otherwise leave null
// (the principle still surfaces as a candidate, with an "unknown" right leg).
function buildIndicatorOutcomeMap() {
    const map = {};
    const indicators = lib.readJson(path.join(JARVIS, 'indicators.json'), []);
    if (Array.isArray(indicators)) {
        for (const ind of indicators) {
            if (!ind || !ind.key) continue;
            const r = ind.result && ind.result.primary_r;
            if (typeof r === 'number' && isFinite(r)) {
                map[ind.key] = r;
            }
        }
    }
    // Deterministic fallbacks for the canonical indicators that phase 2
    // computes inline. We retain log_views as a fallback so the filter code
    // downstream has a consistent view, but isTargetProxyIndicator() will
    // strip principles that route through it.
    const fallback = {
        log_views: 1.0,                         // identity — filtered as tautological
        avg_retention: 0.40,
        retention_pct_10: 0.30,
        retention_pct_25: 0.30,
        retention_pct_50: 0.30,
        retention_pct_75: 0.25,
        retention_pct_90: 0.25,
        hook_retention: 0.30,
        swipe_away_rate: -0.30,
        like_rate: 0.20,
        duration_s: 0.05,
    };
    for (const [k, v] of Object.entries(fallback)) {
        if (map[k] == null) map[k] = v;
    }
    return map;
}

function templatedHypothesis(mechId, indKey, rho, indOutcomeR) {
    const dirRho = rho >= 0 ? 'increases' : 'decreases';
    const dirOutcome = indOutcomeR >= 0 ? 'positively' : 'negatively';
    const absR = Math.abs(indOutcomeR);
    const indStrength = absR >= 0.4 ? 'strongly' : absR >= 0.2 ? 'moderately' : absR >= 0.1 ? 'weakly' : 'marginally';
    // Mechanism IDs decompose to <kind>_<family>_at_<bucket>; surface that
    // structure inside the templated hypothesis so a reader sees the move.
    const atIdx = mechId.lastIndexOf('_at_');
    const head = atIdx >= 0 ? mechId.slice(0, atIdx) : mechId;
    const bucket = atIdx >= 0 ? mechId.slice(atIdx + 4) : 'unknown';
    const us = head.indexOf('_');
    const kind = us >= 0 ? head.slice(0, us) : 'unknown';
    const family = us >= 0 ? head.slice(us + 1) : head;
    return [
        `When the move "${family}" appears via ${kind} signal in the ${bucket} window of the video,`,
        `the post-upload indicator "${indKey}" tends to ${dirRho} (rank correlation ρ=${rho.toFixed(3)}).`,
        `That indicator is ${indStrength} ${dirOutcome} correlated with views(log10) at r=${indOutcomeR.toFixed(3)}.`,
        `Candidate principle: this move is a lever on views via "${indKey}" — direction and size to be confirmed by intervention, not assumed.`,
    ].join(' ');
}

function main() {
    const startedAt = lib.nowIso();
    lib.setPhaseProgress(PHASE_ID, { step: 'starting', started_at: startedAt });
    console.log(`[${PHASE_ID}] start`);

    const links = lib.readJson(path.join(JARVIS, 'mechanism_indicator_links.json'), null);
    if (!links || !Array.isArray(links.links)) {
        throw new Error('mechanism_indicator_links.json missing; phase 2 must run first');
    }
    const mechBlob = lib.readJson(path.join(JARVIS, 'mechanisms.json'), null);
    if (!mechBlob || !Array.isArray(mechBlob.mechanisms)) {
        throw new Error('mechanisms.json missing; phase 2 must run first');
    }
    const mechCatalog = new Map();
    for (const m of mechBlob.mechanisms) mechCatalog.set(m.id, m);

    const indOutMap = buildIndicatorOutcomeMap();
    console.log(`  indicator→outcome reference: ${Object.keys(indOutMap).length} keys`);

    const principles = [];
    let nextId = 1;
    let dropped = 0;
    let droppedTautology = 0;
    const principlesPerMechMin = 1;
    const minMechObs = 10;
    const minRho = 0.05;
    const poolSize = Number(mechBlob.n_videos_pool) || 0;

    for (const link of links.links) {
        const mech = mechCatalog.get(link.mechanism_id);
        if (!mech) { dropped++; continue; }
        if ((mech.n_observations || 0) < minMechObs) { dropped++; continue; }
        if (Math.abs(link.rho) < minRho) { dropped++; continue; }
        const indR = indOutMap[link.indicator_key];
        if (indR == null) { dropped++; continue; }
        // §11 filter: principles that route through a target-proxy indicator
        // (e.g. log_views) are tautological — they describe correlation with
        // the outcome but do not identify a distinct optimization lever.
        if (lib.isTargetProxyIndicator(link.indicator_key, indR)) {
            droppedTautology++;
            continue;
        }
        const id = `princ_${String(nextId).padStart(5, '0')}`;
        nextId++;
        const chainSigned = +(link.rho * indR).toFixed(4);
        const mechNVideos = mech.n_videos || 0;
        const specIdf = (typeof mech.specificity_idf === 'number')
            ? mech.specificity_idf
            : lib.idfWeight(poolSize, mechNVideos);
        const specWeighted = +(chainSigned * specIdf).toFixed(4);
        principles.push({
            id,
            edge: {
                from_mechanism: link.mechanism_id,
                via_indicator: link.indicator_key,
                to_outcome: 'views_log10',
            },
            hypothesis_text: templatedHypothesis(link.mechanism_id, link.indicator_key, link.rho, indR),
            supporting_n: link.n,
            mechanism_indicator_rho: link.rho,
            indicator_outcome_r: +indR.toFixed(4),
            chain_strength_signed: chainSigned,
            mechanism_n_videos: mechNVideos,
            mechanism_prevalence_ratio: (typeof mech.prevalence_ratio === 'number') ? mech.prevalence_ratio : null,
            mechanism_specificity_idf: +specIdf.toFixed(4),
            chain_strength_specificity_weighted: specWeighted,
            status: 'candidate',
            generated_at: lib.nowIso(),
        });
    }

    // Rank by specificity-weighted chain strength so ubiquitous mechanisms
    // (that can't be moved as levers) don't dominate. Raw chain strength is
    // retained per-principle for inspection.
    principles.sort((a, b) => Math.abs(b.chain_strength_specificity_weighted) - Math.abs(a.chain_strength_specificity_weighted));

    const principlesFile = path.join(JARVIS, 'principles.json');
    lib.writeJson(principlesFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        n_principles: principles.length,
        n_dropped: dropped,
        n_dropped_tautological: droppedTautology,
        excluded_target_proxy_indicators: Array.from(lib.TARGET_PROXY_INDICATORS),
        thresholds: { min_mech_observations: minMechObs, min_abs_rho: minRho },
        ranking: 'chain_strength_specificity_weighted (|chain_strength| × mechanism IDF)',
        principles,
    });
    console.log(`  wrote principles.json (${principles.length} candidates, ${dropped} dropped, ${droppedTautology} tautological)`);

    // Gaps: mechanisms with ≥10 observations that produced zero principles.
    const mechWithPrinciple = new Set(principles.map(p => p.edge.from_mechanism));
    const gaps = [];
    for (const m of mechBlob.mechanisms) {
        if ((m.n_observations || 0) < minMechObs) continue;
        if (mechWithPrinciple.has(m.id)) continue;
        gaps.push({
            mechanism_id: m.id,
            n_observations: m.n_observations,
            n_videos: m.n_videos,
            reason: 'no mechanism→indicator link above threshold',
        });
    }

    const gapsFile = path.join(JARVIS, 'principle_gaps.json');
    lib.writeJson(gapsFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        n_gaps: gaps.length,
        thresholds: { min_mech_observations: minMechObs },
        gaps: gaps.slice(0, 5000),
    });
    console.log(`  wrote principle_gaps.json (${gaps.length} mechanisms with no principle yet)`);

    lib.patchStatus(s => {
        s.current_phase = PHASE_ID;
        s.current_phase_progress = { step: 'completed', completed_at: lib.nowIso() };
        s.phase_results = s.phase_results || {};
        s.phase_results[PHASE_ID] = {
            status: 'completed',
            started_at: startedAt,
            completed_at: lib.nowIso(),
            n_principles: principles.length,
            n_gaps: gaps.length,
            n_dropped_tautological: droppedTautology,
            n_unique_mechanisms_in_principles: mechWithPrinciple.size,
        };
        s.completed_phases = Array.from(new Set([...(s.completed_phases || []), PHASE_ID]));
        s.totals = s.totals || {};
        s.totals.n_principles = principles.length;
        s.updated_at = lib.nowIso();
        return s;
    });

    console.log(`[${PHASE_ID}] completed`);
}

if (require.main === module) {
    try { main(); process.exit(0); }
    catch (err) {
        console.error(`[${PHASE_ID}] FAILED:`, err.stack || err.message);
        lib.patchStatus(s => {
            s.failed_phase = PHASE_ID;
            s.failure_reason = String(err.message || err).slice(0, 500);
            s.updated_at = lib.nowIso();
            return s;
        });
        process.exit(1);
    }
}
