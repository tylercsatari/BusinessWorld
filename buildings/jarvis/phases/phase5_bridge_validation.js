#!/usr/bin/env node
'use strict';
/**
 * Phase 5 — Pre→post→views bridge validation.
 *
 * §11 of the meta-architecture distinguishes correlation from
 * optimization-worthiness. For every candidate principle from phase 4,
 * verify both legs of the chain on the available video pool, and
 * specifically call out the publication-time leading indicators
 * (first_10s retention, swipe-away rate).
 *
 * Outputs:
 *   bridge_validation.json
 *   bridge_top_principles.json
 */

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');

// Phase 5 re-derives per-video signals self-contained (no shared state with
// phase 2). The phrase / frame banks below mirror phase 2 deliberately so
// this phase can run independently if phase 2's process has exited.

const PHASE_ID = 'phase_5_bridge';
const JARVIS = lib.JARVIS_DIR;

const PHRASE_FAMILIES = {
    curiosity_gap: ['you wont believe', 'what happens next', 'guess what', 'wait until you see', 'turns out', 'plot twist', 'but heres the thing', "you'll never guess"],
    stakes: ['if i lose', 'if i fail', 'if this works', 'on the line', 'at stake', 'if i dont', 'have to', 'must'],
    loss_aversion: ['lose', 'losing', 'lost', 'gone', 'never again', 'last chance'],
    urgency: ['right now', 'today', 'before it', 'hurry', 'quickly', 'immediately'],
    proof_of_work: ['hours', 'days', 'months', 'years', 'every day', 'practiced', 'trained', 'tested'],
    proof_signal: ['look at this', 'as you can see', 'check this out', 'watch this', 'right here'],
    credibility: ['ive been', 'i have been', 'expert', 'professional', 'years of', 'studied', 'qualified'],
    consequence: ['so that', 'as a result', 'which means', 'because of', 'this caused'],
    personal_stake: ['my', 'mine', 'i had to', 'for me', 'i risked'],
    callback: ['like i said', 'as i mentioned', 'remember when', 'earlier i', 'going back to'],
    rhetorical_question: ['ever wonder', 'have you ever', 'what if', 'why do', 'why does', 'how come'],
    pattern_interrupt: ['but wait', 'actually', 'except', 'however', 'instead', 'turns out'],
    payoff_signal: ['here it is', 'this is it', 'finally', 'and here', 'the answer is', 'the result'],
    setup: ['so basically', 'first', 'before', 'to start', 'lets begin', 'imagine'],
    climax_marker: ['and then', 'suddenly', 'all of a sudden', 'thats when', 'next thing'],
    open_loop: ['ill show you', 'wait for it', 'you have to see', 'coming up', 'in a moment'],
    revelation: ['the truth is', 'in reality', 'actually', 'really', 'turns out'],
    commitment: ['promise', 'guarantee', 'i swear', 'i bet', 'no matter what'],
    social_proof: ['everyone', 'most people', 'people are', 'they say', 'studies show'],
    failure_vulnerability: ['i failed', 'i messed up', 'i was wrong', 'i couldnt', 'i didnt know'],
    transformation: ['used to', 'before i', 'now i', 'changed my', 'turned into'],
    action_trigger: ['try', 'do this', 'go', 'click', 'subscribe', 'follow', 'comment'],
    specificity: ['exactly', 'precisely', 'specifically', '$', 'percent', '%'],
    visual_credibility: ['as you can see', 'look', 'watch closely', 'right here', 'see this'],
    anticipation: ['get ready', 'wait', 'about to', 'coming', 'next', 'almost'],
    foreshadow: ['later', 'youll see', 'just wait', 'in a sec', 'eventually'],
    micro_reward: ['nice', 'wow', 'beautiful', 'perfect', 'love it', 'amazing'],
    counterintuitive: ['surprisingly', 'opposite', 'wouldnt expect', 'against', 'paradox'],
};
const FRAME_KEYWORD_FAMILIES = {
    text_overlay: ['text overlay', 'on-screen text', 'caption', 'subtitle'],
    close_up: ['close up', 'close-up', 'tight shot', 'macro'],
    fast_cut: ['quick cut', 'fast cut', 'rapid', 'cut quickly'],
    direct_address: ['looks at the camera', 'facing the camera', 'speaking directly'],
    motion: ['running', 'jumping', 'moving fast', 'dynamic motion', 'motion blur'],
    reveal: ['reveals', 'reveal', 'unveils', 'shows for the first time'],
    zoom: ['zoom in', 'zoom out', 'pushing in', 'pulling back'],
    natural_lighting: ['natural light', 'natural lighting', 'sunlight'],
    high_energy: ['high energy', 'intense', 'energetic', 'exciting'],
    relatability: ['relatable', 'everyday', 'familiar', 'common situation'],
};

function positionBucket(positionS, durationS) {
    if (!isFinite(positionS) || positionS < 0) return 'unknown';
    if (!isFinite(durationS) || durationS <= 0) return 'unknown';
    if (positionS <= 5) return 'first_5s';
    if (positionS <= 10) return 'first_10s';
    const pct = positionS / durationS;
    if (pct <= 0.25) return 'hook_quarter';
    if (pct <= 0.75) return 'mid';
    return 'late';
}

function lowerOrEmpty(x) { return (x == null) ? '' : String(x).toLowerCase(); }
function scanPhrases(textLower, families) {
    const hits = [];
    for (const [fam, phrases] of Object.entries(families)) {
        for (const p of phrases) if (textLower.indexOf(p) >= 0) hits.push({ family: fam });
    }
    return hits;
}
function pickRetention(curve, pct) {
    if (!Array.isArray(curve) || !curve.length) return null;
    const idx = Math.round((pct / 100) * (curve.length - 1));
    const v = curve[Math.max(0, Math.min(curve.length - 1, idx))];
    return (typeof v === 'number' && isFinite(v)) ? v : null;
}

function videoMechCounts(video) {
    const observations = [];
    const dur = (video.metadata && video.metadata.duration) || 0;
    const segs = (video.aiAnalysis && video.aiAnalysis.segments) || [];

    for (const seg of segs) {
        if (!seg || !seg.label) continue;
        const start = (typeof seg.startTime === 'number') ? seg.startTime : 0;
        const labelKey = lowerOrEmpty(seg.label).trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (!labelKey) continue;
        observations.push({ mechanism_id: `segment_${labelKey}_at_${positionBucket(start, dur)}` });
    }
    const words = (video.transcript && video.transcript.words) || [];
    if (words.length && dur > 0) {
        for (let t = 0; t < dur; t += 5) {
            const winWords = words.filter(w => w && typeof w.start === 'number' && w.start >= t && w.start < t + 5);
            if (!winWords.length) continue;
            const txt = winWords.map(w => w.text || '').join(' ').toLowerCase();
            const hits = scanPhrases(txt, PHRASE_FAMILIES);
            const seen = new Set();
            for (const h of hits) {
                if (seen.has(h.family)) continue;
                seen.add(h.family);
                observations.push({ mechanism_id: `phrase_${h.family}_at_${positionBucket(t, dur)}` });
            }
        }
    }
    const frames = video.frames || {};
    for (const fk of Object.keys(frames)) {
        const f = frames[fk];
        if (!f || !f.analysis) continue;
        const ts = (typeof f.timestamp === 'number') ? f.timestamp : null;
        if (ts == null) continue;
        const blob = lowerOrEmpty([f.analysis.engagementAnalysis, f.analysis.visualTechniques, f.analysis.cinematography, f.analysis.sceneDescription].filter(Boolean).join(' | '));
        if (!blob) continue;
        const hits = scanPhrases(blob, FRAME_KEYWORD_FAMILIES);
        const seen = new Set();
        for (const h of hits) {
            if (seen.has(h.family)) continue;
            seen.add(h.family);
            observations.push({ mechanism_id: `frame_${h.family}_at_${positionBucket(ts, dur)}` });
        }
    }
    // Mirror phase 2: cross-source co-occurrence compounds in the same bucket.
    const compounds = lib.expandCompoundMechanisms(observations);
    for (const c of compounds) observations.push(c);

    const counts = {};
    for (const o of observations) counts[o.mechanism_id] = (counts[o.mechanism_id] || 0) + 1;
    return counts;
}

function videoIndicators(video) {
    const a = video.analytics || {};
    const m = video.metadata || {};
    const curve = a.retentionCurve || [];
    const vc = m.viewCount || 0;
    return {
        log_views: vc > 0 ? Math.log10(vc) : null,
        swipe_away_rate: (typeof a.swipedAwayRate === 'number') ? a.swipedAwayRate : null,
        retention_pct_10: pickRetention(curve, 10),
        retention_pct_50: pickRetention(curve, 50),
        retention_pct_90: pickRetention(curve, 90),
        hook_retention: (curve.length > 1) ? curve[1] : null,
    };
}

function main() {
    const startedAt = lib.nowIso();
    lib.setPhaseProgress(PHASE_ID, { step: 'starting', started_at: startedAt });
    console.log(`[${PHASE_ID}] start`);

    const principlesBlob = lib.readJson(path.join(JARVIS, 'principles.json'), null);
    if (!principlesBlob || !Array.isArray(principlesBlob.principles)) {
        throw new Error('principles.json missing; phase 4 must run first');
    }
    const principles = principlesBlob.principles;
    console.log(`  ${principles.length} candidate principles to validate`);

    // Load mechanism catalog to get specificity (IDF) metadata for ranking,
    // plus the authoritative pool size. If phase 2 was run with the old
    // schema, fall back to computing IDF against the largest observed n.
    const mechBlob = lib.readJson(path.join(JARVIS, 'mechanisms.json'), { mechanisms: [], n_videos_pool: 0 });
    const mechMeta = new Map();
    let derivedPool = 0;
    for (const m of (mechBlob.mechanisms || [])) {
        mechMeta.set(m.id, m);
        if ((m.n_videos || 0) > derivedPool) derivedPool = m.n_videos;
    }
    const poolSize = Number(mechBlob.n_videos_pool) || derivedPool;
    console.log(`  mechanism pool size: ${poolSize}`);

    const videoIds = lib.listVideoIds();
    console.log(`  re-extracting per-video signals for ${videoIds.length} videos`);

    const mechCountsByVid = new Map();
    const indicatorsByVid = new Map();
    let processed = 0;
    for (const vid of videoIds) {
        const v = lib.loadVideo(vid);
        if (!v) { processed++; continue; }
        mechCountsByVid.set(vid, videoMechCounts(v));
        indicatorsByVid.set(vid, videoIndicators(v));
        processed++;
        if (processed % 200 === 0) {
            console.log(`    re-extract progress: ${processed}/${videoIds.length}`);
            lib.setPhaseProgress(PHASE_ID, { step: 're-extracting', processed, total: videoIds.length, updated_at: lib.nowIso() });
        }
    }

    // For each principle, compute the chain freshly + first-10s + swipe-away.
    // Tautological principles (target-proxy via_indicator) are rejected up front
    // so bridge ranking mirrors phase 4's filter even if upstream drift
    // introduces them — defense in depth.
    const rows = [];
    let pProcessed = 0;
    let droppedTautology = 0;
    for (const p of principles) {
        const mech = p.edge.from_mechanism;
        const ind = p.edge.via_indicator;
        if (lib.isTargetProxyIndicator(ind, p.indicator_outcome_r)) {
            droppedTautology++;
            pProcessed++;
            continue;
        }

        // pre→post (mech count vs the via_indicator)
        const xs = [], ys = [];
        const xsLogV = [], ysLogV = [];
        const xs10 = [], ys10 = [];
        const xsSw = [], ysSw = [];
        for (const [vid, mc] of mechCountsByVid.entries()) {
            const ivec = indicatorsByVid.get(vid);
            if (!ivec) continue;
            const cnt = mc[mech] || 0;
            const yv = ivec[ind];
            if (yv != null && isFinite(yv)) { xs.push(cnt); ys.push(yv); }
            if (ivec.log_views != null) { xsLogV.push(cnt); ysLogV.push(ivec.log_views); }
            if (ivec.retention_pct_10 != null) { xs10.push(cnt); ys10.push(ivec.retention_pct_10); }
            if (ivec.swipe_away_rate != null) { xsSw.push(cnt); ysSw.push(ivec.swipe_away_rate); }
        }
        const preToPost = xs.length >= 20 ? lib.spearmanr(xs, ys).rho : null;
        const mechToViews = xsLogV.length >= 20 ? lib.spearmanr(xsLogV, ysLogV).rho : null;
        const first10 = xs10.length >= 20 ? lib.spearmanr(xs10, ys10).rho : null;
        const swipe = xsSw.length >= 20 ? lib.spearmanr(xsSw, ysSw).rho : null;

        const postToViews = p.indicator_outcome_r;
        const chainStrength = (preToPost != null && postToViews != null)
            ? +(preToPost * postToViews).toFixed(4)
            : null;

        const mechRec = mechMeta.get(mech);
        const mechNVideos = (mechRec && typeof mechRec.n_videos === 'number')
            ? mechRec.n_videos
            : (typeof p.mechanism_n_videos === 'number' ? p.mechanism_n_videos : 0);
        const specIdf = (mechRec && typeof mechRec.specificity_idf === 'number')
            ? mechRec.specificity_idf
            : lib.idfWeight(poolSize, mechNVideos);
        const prevalence = poolSize > 0 ? +(mechNVideos / poolSize).toFixed(4) : null;
        const chainSpec = (chainStrength != null)
            ? +(chainStrength * specIdf).toFixed(4)
            : null;

        rows.push({
            principle_id: p.id,
            mechanism_id: mech,
            via_indicator: ind,
            to_outcome: 'views_log10',
            pre_to_post_rho: preToPost != null ? +preToPost.toFixed(4) : null,
            post_to_views_r: postToViews,
            chain_strength: chainStrength,
            mech_to_views_rho_direct: mechToViews != null ? +mechToViews.toFixed(4) : null,
            first_10s_signal: first10 != null ? +first10.toFixed(4) : null,
            swipe_away_signal: swipe != null ? +swipe.toFixed(4) : null,
            n_videos_used: xs.length,
            mechanism_n_videos: mechNVideos,
            mechanism_prevalence_ratio: prevalence,
            mechanism_specificity_idf: +specIdf.toFixed(4),
            chain_strength_specificity_weighted: chainSpec,
        });
        pProcessed++;
        if (pProcessed % 100 === 0) {
            console.log(`    validated ${pProcessed}/${principles.length} principles`);
            lib.setPhaseProgress(PHASE_ID, { step: 'validating', processed: pProcessed, total: principles.length, updated_at: lib.nowIso() });
        }
    }

    // Rank by specificity-weighted chain strength so a mechanism in 99% of
    // videos (near-zero IDF) cannot dominate the top on ubiquity alone.
    rows.sort((a, b) => {
        const ax = a.chain_strength_specificity_weighted == null ? -Infinity : Math.abs(a.chain_strength_specificity_weighted);
        const bx = b.chain_strength_specificity_weighted == null ? -Infinity : Math.abs(b.chain_strength_specificity_weighted);
        return bx - ax;
    });

    const bridgeFile = path.join(JARVIS, 'bridge_validation.json');
    lib.writeJson(bridgeFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        n_principles_validated: rows.length,
        n_dropped_tautological: droppedTautology,
        n_chains_with_both_legs_nonzero: rows.filter(r => r.pre_to_post_rho != null && r.post_to_views_r != null && Math.abs(r.chain_strength || 0) > 0.01).length,
        n_videos_in_pool: videoIds.length,
        ranking: 'chain_strength_specificity_weighted (|chain_strength| × mechanism IDF)',
        excluded_target_proxy_indicators: Array.from(lib.TARGET_PROXY_INDICATORS),
        rows,
    });
    console.log(`  wrote bridge_validation.json (${rows.length} principles validated, ${droppedTautology} tautological dropped)`);

    const top = rows.slice(0, 25);
    const topFile = path.join(JARVIS, 'bridge_top_principles.json');
    lib.writeJson(topFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        ranking: 'chain_strength_specificity_weighted (|chain_strength| × mechanism IDF)',
        excluded_target_proxy_indicators: Array.from(lib.TARGET_PROXY_INDICATORS),
        top: top,
    });
    console.log(`  wrote bridge_top_principles.json (top ${top.length})`);

    // Sanity warning: top-25 should include at least one well-known indicator on the right.
    const knownStrong = ['hook_retention', 'swipe_away_rate', 'retention_pct_10', 'retention_pct_50'];
    const hasKnown = top.some(t => knownStrong.includes(t.via_indicator));
    if (!hasKnown) {
        console.warn('  WARNING: top-25 principles do not include any of the expected strong indicators on the right side. Likely a data-loading mismatch — inspect bridge_validation.json.');
    }
    // Tautology sanity: no row in the top should route through a target-proxy
    // indicator (e.g. log_views → views is the identity). If any slip
    // through, something upstream regressed.
    const tautRows = top.filter(t => lib.isTargetProxyIndicator(t.via_indicator, t.post_to_views_r));
    if (tautRows.length) {
        console.warn(`  WARNING: ${tautRows.length} top-25 row(s) still route through a target-proxy indicator; expected 0.`);
    }

    lib.patchStatus(s => {
        s.current_phase = PHASE_ID;
        s.current_phase_progress = { step: 'completed', completed_at: lib.nowIso() };
        s.phase_results = s.phase_results || {};
        s.phase_results[PHASE_ID] = {
            status: 'completed',
            started_at: startedAt,
            completed_at: lib.nowIso(),
            n_principles_validated: rows.length,
            n_dropped_tautological: droppedTautology,
            n_videos_used: videoIds.length,
            top_chain_strength: top.length ? top[0].chain_strength : null,
            top_chain_strength_specificity_weighted: top.length ? top[0].chain_strength_specificity_weighted : null,
            sanity_known_strong_in_top25: hasKnown,
            sanity_no_target_proxy_in_top25: tautRows.length === 0,
        };
        s.completed_phases = Array.from(new Set([...(s.completed_phases || []), PHASE_ID]));
        s.totals = s.totals || {};
        s.totals.n_bridges_validated = rows.length;
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
