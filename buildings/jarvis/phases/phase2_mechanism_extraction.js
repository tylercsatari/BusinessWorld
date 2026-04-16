#!/usr/bin/env node
'use strict';
/**
 * Phase 2 — Mechanism extraction over the existing video pool.
 *
 * For every video in video_data/, derive observations of mechanism-shaped
 * moves from three deterministic sources:
 *   1) AI segment labels (Hook / Setup / Climax / Payoff / etc.) with position
 *   2) transcript phrase-family hits (curiosity gap, stakes, proof, urgency, ...)
 *   3) frame-level engagementAnalysis keyword hits with position
 *
 * Observations are tagged with a position bucket so that resolution is
 * preserved per the meta-architecture. Mechanism IDs are produced
 * mechanically from (source_kind, family/label, position_bucket) — no
 * hand-curated taxonomy.
 *
 * Outputs:
 *   mechanism_observations.json
 *   mechanisms.json
 *   mechanism_indicator_links.json
 */

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');

const PHASE_ID = 'phase_2_mechanisms';
const JARVIS = lib.JARVIS_DIR;

// ── Position bucketing ────────────────────────────────────────────────────
// Resolution is multi-grain. We tag every observation with a coarse bucket;
// finer slicing can come later. Buckets are chosen to align with the existing
// resolution registry (first_10s, hook quarter, mid, late) and §8 of the
// meta-architecture (resolution as a first-class axis).
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

// ── Phrase bank ───────────────────────────────────────────────────────────
// Mirrors the families already in jarvis-metrics, kept inline so phase 2 is
// self-contained. The point of phase 2 is observation breadth, not parity
// with the indicator catalog. Future passes will widen this bank.
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

// Frame engagement keyword bank. Drives source #3 (frame-level moves).
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

// ── Helpers ───────────────────────────────────────────────────────────────

function lowerOrEmpty(x) { return (x == null) ? '' : String(x).toLowerCase(); }

function scanPhrases(textLower, families) {
    const hits = [];
    for (const [fam, phrases] of Object.entries(families)) {
        for (const p of phrases) {
            if (textLower.indexOf(p) >= 0) {
                hits.push({ family: fam, matched: p });
            }
        }
    }
    return hits;
}

function transcriptWordsWithTimes(video) {
    const words = (video.transcript && video.transcript.words) || [];
    return words.filter(w => w && typeof w.start === 'number' && w.text);
}

function pickRetention(curve, pct) {
    if (!Array.isArray(curve) || !curve.length) return null;
    const idx = Math.round((pct / 100) * (curve.length - 1));
    const v = curve[Math.max(0, Math.min(curve.length - 1, idx))];
    return (typeof v === 'number' && isFinite(v)) ? v : null;
}

function videoIndicators(video) {
    const a = video.analytics || {};
    const m = video.metadata || {};
    const curve = a.retentionCurve || [];
    const dur = m.duration || 0;
    const vc = m.viewCount || 0;
    const out = {
        log_views: vc > 0 ? Math.log10(vc) : null,
        swipe_away_rate: (typeof a.swipedAwayRate === 'number') ? a.swipedAwayRate : null,
        avg_retention: (typeof a.avgRetention === 'number') ? a.avgRetention : null,
        retention_pct_10: pickRetention(curve, 10),
        retention_pct_25: pickRetention(curve, 25),
        retention_pct_50: pickRetention(curve, 50),
        retention_pct_75: pickRetention(curve, 75),
        retention_pct_90: pickRetention(curve, 90),
        hook_retention: (curve.length > 1) ? curve[1] : null,
        like_rate: (vc > 0 && a.likes != null) ? (a.likes / vc) : null,
        duration_s: dur || null,
    };
    return out;
}

// ── Mechanism observation extraction per video ────────────────────────────

function extractFromVideo(video) {
    const observations = [];
    const dur = (video.metadata && video.metadata.duration) || 0;
    const segs = (video.aiAnalysis && video.aiAnalysis.segments) || [];

    // Source 1: segment labels
    for (const seg of segs) {
        if (!seg || !seg.label) continue;
        const start = (typeof seg.startTime === 'number') ? seg.startTime : 0;
        const labelKey = lowerOrEmpty(seg.label).trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (!labelKey) continue;
        const bucket = positionBucket(start, dur);
        observations.push({
            mechanism_id: `segment_${labelKey}_at_${bucket}`,
            evidence_kind: 'segment_label',
            evidence_text: `${seg.label}: ${(seg.description || '').slice(0, 160)}`,
            position_s: start,
            position_pct: dur > 0 ? +(start / dur * 100).toFixed(2) : null,
            source: 'aiAnalysis.segments',
        });
    }

    // Source 2: transcript phrase hits
    const words = transcriptWordsWithTimes(video);
    if (words.length && dur > 0) {
        const segWindowSec = 5;
        for (let t = 0; t < dur; t += segWindowSec) {
            const winWords = words.filter(w => w.start >= t && w.start < t + segWindowSec);
            if (!winWords.length) continue;
            const winText = winWords.map(w => w.text || '').join(' ').toLowerCase();
            const hits = scanPhrases(winText, PHRASE_FAMILIES);
            const seenFams = new Set();
            for (const h of hits) {
                if (seenFams.has(h.family)) continue;
                seenFams.add(h.family);
                const bucket = positionBucket(t, dur);
                observations.push({
                    mechanism_id: `phrase_${h.family}_at_${bucket}`,
                    evidence_kind: 'transcript_phrase',
                    evidence_text: `"${h.matched}" in [${t}-${t + segWindowSec}s]`,
                    position_s: t,
                    position_pct: +(t / dur * 100).toFixed(2),
                    source: 'transcript.words',
                });
            }
        }
    } else if (video.transcript && typeof video.transcript.fullText === 'string' && dur > 0) {
        const ftLower = video.transcript.fullText.toLowerCase();
        const hits = scanPhrases(ftLower, PHRASE_FAMILIES);
        const seenFams = new Set();
        for (const h of hits) {
            if (seenFams.has(h.family)) continue;
            seenFams.add(h.family);
            observations.push({
                mechanism_id: `phrase_${h.family}_at_unknown`,
                evidence_kind: 'transcript_phrase_full',
                evidence_text: `"${h.matched}" (no per-word timing)`,
                position_s: null,
                position_pct: null,
                source: 'transcript.fullText',
            });
        }
    }

    // Source 3: frame engagement notes
    const frames = video.frames || {};
    for (const fk of Object.keys(frames)) {
        const f = frames[fk];
        if (!f || !f.analysis) continue;
        const a = f.analysis;
        const ts = (typeof f.timestamp === 'number') ? f.timestamp : null;
        if (ts == null) continue;
        const bucket = positionBucket(ts, dur);
        const blob = lowerOrEmpty([
            a.engagementAnalysis, a.visualTechniques, a.cinematography, a.sceneDescription,
        ].filter(Boolean).join(' | '));
        if (!blob) continue;
        const hits = scanPhrases(blob, FRAME_KEYWORD_FAMILIES);
        const seenFams = new Set();
        for (const h of hits) {
            if (seenFams.has(h.family)) continue;
            seenFams.add(h.family);
            observations.push({
                mechanism_id: `frame_${h.family}_at_${bucket}`,
                evidence_kind: 'frame_engagement',
                evidence_text: `frame#${fk} t=${ts}s "${h.matched}"`,
                position_s: ts,
                position_pct: dur > 0 ? +(ts / dur * 100).toFixed(2) : null,
                source: 'frames.analysis',
            });
        }
    }

    return observations;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
    const startedAt = lib.nowIso();
    lib.setPhaseProgress(PHASE_ID, { step: 'starting', started_at: startedAt });
    console.log(`[${PHASE_ID}] start`);

    const videoIds = lib.listVideoIds();
    console.log(`  pool: ${videoIds.length} videos`);

    const observationsByMech = new Map();          // mechanism_id -> array of {video_id, ...obs}
    const sampleEvidenceByMech = new Map();        // mechanism_id -> first 3 evidence strings
    const observationsRows = [];                   // flattened for mechanism_observations.json (capped)
    const MAX_OBS_ROWS = 250000;

    // Per-video aggregates: counts of each mechanism_id + indicator vector
    const videoMechCounts = new Map();             // video_id -> { mech_id: count }
    const videoIndicatorVec = new Map();           // video_id -> { indicator_key: value }

    let processed = 0, withObs = 0, totalObs = 0;
    const PROGRESS_EVERY = 100;

    for (const vid of videoIds) {
        const video = lib.loadVideo(vid);
        if (!video) { processed++; continue; }

        const obs = extractFromVideo(video);
        const mechCounts = {};
        for (const o of obs) {
            mechCounts[o.mechanism_id] = (mechCounts[o.mechanism_id] || 0) + 1;

            if (!observationsByMech.has(o.mechanism_id)) observationsByMech.set(o.mechanism_id, { n_observations: 0, n_videos: 0, evidence_kinds: new Set() });
            const slot = observationsByMech.get(o.mechanism_id);
            slot.n_observations++;
            slot.evidence_kinds.add(o.evidence_kind);

            if (!sampleEvidenceByMech.has(o.mechanism_id)) sampleEvidenceByMech.set(o.mechanism_id, []);
            const ev = sampleEvidenceByMech.get(o.mechanism_id);
            if (ev.length < 3) ev.push({ video_id: vid, ...o });

            if (observationsRows.length < MAX_OBS_ROWS) {
                observationsRows.push({ video_id: vid, ...o });
            }
        }

        for (const mech of Object.keys(mechCounts)) {
            const slot = observationsByMech.get(mech);
            slot.n_videos++;
        }

        videoMechCounts.set(vid, mechCounts);
        videoIndicatorVec.set(vid, videoIndicators(video));

        processed++;
        if (obs.length) { withObs++; totalObs += obs.length; }

        if (processed % PROGRESS_EVERY === 0) {
            const pct = +(processed / videoIds.length * 100).toFixed(1);
            console.log(`  [${pct}%] processed ${processed}/${videoIds.length} videos, ${observationsByMech.size} mech ids so far`);
            lib.setPhaseProgress(PHASE_ID, {
                step: 'extracting', processed, total: videoIds.length,
                n_mechanism_ids: observationsByMech.size, n_observations: totalObs,
                updated_at: lib.nowIso(),
            });
        }
    }

    console.log(`  extraction done: ${processed} videos, ${withObs} with observations, ${totalObs} total observations, ${observationsByMech.size} distinct mechanism ids`);

    // Write mechanism_observations.json (capped)
    const obsFile = path.join(JARVIS, 'mechanism_observations.json');
    lib.writeJson(obsFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        n_videos_processed: processed,
        n_observations_total: totalObs,
        n_observations_stored: observationsRows.length,
        capped: observationsRows.length >= MAX_OBS_ROWS,
        observations: observationsRows,
    });
    console.log(`  wrote mechanism_observations.json (${observationsRows.length} rows, capped=${observationsRows.length >= MAX_OBS_ROWS})`);

    // Write mechanisms.json
    const mechanisms = [];
    for (const [id, slot] of observationsByMech.entries()) {
        const samples = sampleEvidenceByMech.get(id) || [];
        mechanisms.push({
            id,
            label: id.replace(/_/g, ' '),
            rough_description: `Observed: ${id} (${slot.n_observations} obs across ${slot.n_videos} videos)`,
            source_kinds: Array.from(slot.evidence_kinds),
            n_observations: slot.n_observations,
            n_videos: slot.n_videos,
            sample_evidence: samples,
            emergence_method: 'phase2_observation_derived',
        });
    }
    mechanisms.sort((a, b) => b.n_videos - a.n_videos);

    const mechFile = path.join(JARVIS, 'mechanisms.json');
    lib.writeJson(mechFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        n_mechanisms: mechanisms.length,
        mechanisms,
    });
    console.log(`  wrote mechanisms.json (${mechanisms.length} mechanism ids)`);

    // ── Mechanism × indicator links via Spearman rho ─────────────────────
    // Only consider mechanisms observed in at least 20 videos. Indicators are
    // computed per-video at extraction time.
    const indicatorKeys = [
        'log_views', 'swipe_away_rate', 'avg_retention',
        'retention_pct_10', 'retention_pct_25', 'retention_pct_50',
        'retention_pct_75', 'retention_pct_90', 'hook_retention',
        'like_rate', 'duration_s',
    ];

    const links = [];
    let mechProcessed = 0;
    const mechIdsInScope = mechanisms.filter(m => m.n_videos >= 20).map(m => m.id);
    console.log(`  building mechanism×indicator links: ${mechIdsInScope.length} mechanisms × ${indicatorKeys.length} indicators`);

    for (const mechId of mechIdsInScope) {
        for (const indKey of indicatorKeys) {
            const xs = [];
            const ys = [];
            for (const [vid, mc] of videoMechCounts.entries()) {
                const indVec = videoIndicatorVec.get(vid);
                if (!indVec) continue;
                const yv = indVec[indKey];
                if (yv == null || !isFinite(yv)) continue;
                xs.push(mc[mechId] || 0);
                ys.push(yv);
            }
            if (xs.length < 20) continue;
            const sp = lib.spearmanr(xs, ys);
            if (Math.abs(sp.rho) < 0.05) continue;
            links.push({
                mechanism_id: mechId,
                indicator_key: indKey,
                rho: +sp.rho.toFixed(4),
                n: sp.n,
            });
        }
        mechProcessed++;
        if (mechProcessed % 50 === 0) {
            console.log(`    links progress: ${mechProcessed}/${mechIdsInScope.length} mechanisms scored, ${links.length} non-trivial links so far`);
            lib.setPhaseProgress(PHASE_ID, {
                step: 'linking', mech_processed: mechProcessed, mech_total: mechIdsInScope.length,
                n_links: links.length, updated_at: lib.nowIso(),
            });
        }
    }

    links.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
    const linksFile = path.join(JARVIS, 'mechanism_indicator_links.json');
    lib.writeJson(linksFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        n_links: links.length,
        threshold_abs_rho: 0.05,
        threshold_min_n: 20,
        indicator_keys: indicatorKeys,
        links,
    });
    console.log(`  wrote mechanism_indicator_links.json (${links.length} links)`);

    lib.patchStatus(s => {
        s.current_phase = PHASE_ID;
        s.current_phase_progress = { step: 'completed', completed_at: lib.nowIso() };
        s.phase_results = s.phase_results || {};
        s.phase_results[PHASE_ID] = {
            status: 'completed',
            started_at: startedAt,
            completed_at: lib.nowIso(),
            n_videos_processed: processed,
            n_observations: totalObs,
            n_mechanism_ids: mechanisms.length,
            n_mechanisms_in_scope_for_links: mechIdsInScope.length,
            n_links: links.length,
        };
        s.completed_phases = Array.from(new Set([...(s.completed_phases || []), PHASE_ID]));
        s.totals = s.totals || {};
        s.totals.n_videos_processed = processed;
        s.totals.n_mechanism_observations = totalObs;
        s.totals.n_mechanisms = mechanisms.length;
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
