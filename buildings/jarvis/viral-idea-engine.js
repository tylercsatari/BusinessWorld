// Jarvis Viral Idea Engine
//
// Compresses the full Jarvis artifact set (findings, principles, bridges,
// mechanisms, components, research answers) into a structured model brief
// — then uses that brief to produce evidence-backed 100M+ video ideas.
//
// Architecture:
//   1) Load artifacts from disk server-side (never shipped to an LLM).
//   2) compress() → deterministic structured brief (post-upload predictors,
//      pre-upload predictors, pre→post→views bridges, proven features,
//      narrative/retention patterns, concept anchors, hook mechanisms).
//   3) generateIdeas(brief, count) → additive-scored, evidence-joined ideas
//      assembled from a finite palette grounded in the brief.
//
// No LLM calls. No giant payloads. Everything is deterministic scoring on top
// of already-derived artifacts. The brief is ~10-30 KB; ideas are tiny.

const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = __dirname;

function loadJsonSafe(name) {
    const p = path.join(ARTIFACT_DIR, name);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { return null; }
}

function round(x, n = 4) {
    if (x === null || x === undefined || Number.isNaN(x)) return null;
    const k = Math.pow(10, n);
    return Math.round(x * k) / k;
}

// ──────────────────────────────────────────────────────────────────────
// Loaders
// ──────────────────────────────────────────────────────────────────────

function loadAllArtifacts() {
    return {
        findings: loadJsonSafe('findings-summary.json'),
        answers: loadJsonSafe('research_answers.json'),
        principles: loadJsonSafe('principles.json'),
        bridgeTop: loadJsonSafe('bridge_top_principles.json'),
        bridgeValidation: loadJsonSafe('bridge_validation.json'),
        components: loadJsonSafe('components.json'),
        mechanisms: loadJsonSafe('mechanisms.json'),
        questions: loadJsonSafe('research_questions.json'),
    };
}

// ──────────────────────────────────────────────────────────────────────
// Compression: build a structured brief from the full artifact set.
// ──────────────────────────────────────────────────────────────────────

// Target-proxy indicators that should never be treated as independent drivers
const TARGET_PROXY = new Set(['views', 'views_log10', 'log_views', 'log10_views']);

function topPostUploadPredictors(answers, limit = 8) {
    if (!answers) return [];
    const q1 = answers.answers.find(a => a.question_id === 'q001');
    const raw = (q1 && q1.findings && q1.findings.strongest_post_upload && q1.findings.strongest_post_upload.top) || [];
    // Dedupe by family prefix (collapse retention_mean_*, retention_pct_*, retention_volatility_*, etc.)
    const seen = new Set();
    const out = [];
    for (const row of raw) {
        if (TARGET_PROXY.has(row.key)) continue;
        const family = collapseFamily(row.key);
        if (seen.has(family)) continue;
        seen.add(family);
        out.push({ key: row.key, family, r_to_views: round(row.r, 4) });
        if (out.length >= limit) break;
    }
    return out;
}

function topPreUploadPredictors(answers, limit = 10) {
    if (!answers) return [];
    const q1 = answers.answers.find(a => a.question_id === 'q001');
    const raw = (q1 && q1.findings && q1.findings.strongest_pre_upload && q1.findings.strongest_pre_upload.top) || [];
    const out = [];
    for (const row of raw) {
        if (TARGET_PROXY.has(row.key)) continue;
        out.push({
            key: row.key,
            r_to_views: round(row.r, 4),
            direction: row.r >= 0 ? 'higher → more views' : 'lower → more views',
        });
        if (out.length >= limit) break;
    }
    return out;
}

function collapseFamily(key) {
    // Normalize retention_mean_75_100 → retention_mean_*, retention_pct_90 → retention_pct_*
    return String(key)
        .replace(/_\d+_\d+$/, '_*')
        .replace(/_\d+$/, '_N');
}

function topBridges(answers, limit = 12) {
    if (!answers) return [];
    const q4 = answers.answers.find(a => a.question_id === 'q004');
    const bridges = (q4 && q4.findings && q4.findings.top_bridges) || [];
    const paths = (q4 && q4.findings && q4.findings.top_multi_hop_paths) || [];
    // Merge, score by max(path_score, bridge_strength) weighted by sign consistency
    const rows = [];
    for (const b of bridges) {
        if (TARGET_PROXY.has(b.pre) || TARGET_PROXY.has(b.post)) continue;
        const score = (b.path_score || b.bridge_strength || 0) * (b.sign_consistent ? 1 : 0.6);
        rows.push({
            pre: b.pre, post: b.post,
            pre_r: round(b.pre_r),
            post_r: round(b.post_r),
            bridge_strength: round(b.bridge_strength),
            sign_consistent: !!b.sign_consistent,
            score: round(score, 4),
            source: 'top_bridges',
        });
    }
    for (const p of paths) {
        if (TARGET_PROXY.has(p.pre) || TARGET_PROXY.has(p.post)) continue;
        rows.push({
            pre: p.pre, post: p.post,
            pre_r: round(p.pre_r),
            post_r: round(p.post_r),
            path_strength: round(p.path_strength),
            interaction_r: round(p.interaction_r),
            sign_consistent: !!p.sign_consistent,
            score: round((p.path_strength || 0) * (p.sign_consistent ? 1 : 0.6), 4),
            source: 'multi_hop',
        });
    }
    // Dedupe by (pre,post), keep higher score
    const map = new Map();
    for (const r of rows) {
        const key = `${r.pre}::${r.post}`;
        const cur = map.get(key);
        if (!cur || (r.score || 0) > (cur.score || 0)) map.set(key, r);
    }
    return [...map.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
}

function topMechanismPrinciples(principles, bridgeTop, limit = 15) {
    const rows = [];
    // From principles.json: top by |chain_strength_specificity_weighted|, require n_videos >= 20
    if (principles && Array.isArray(principles.principles)) {
        for (const p of principles.principles) {
            if (!p.edge) continue;
            if (TARGET_PROXY.has(p.edge.via_indicator)) continue;
            if ((p.mechanism_n_videos || 0) < 20) continue;
            rows.push({
                principle_id: p.id,
                mechanism_id: p.edge.from_mechanism,
                via_indicator: p.edge.via_indicator,
                to_outcome: p.edge.to_outcome,
                mechanism_indicator_rho: round(p.mechanism_indicator_rho),
                indicator_outcome_r: round(p.indicator_outcome_r),
                chain_strength_signed: round(p.chain_strength_signed),
                chain_strength_specificity_weighted: round(p.chain_strength_specificity_weighted),
                mechanism_n_videos: p.mechanism_n_videos,
                mechanism_specificity_idf: round(p.mechanism_specificity_idf),
                source: 'principles',
            });
        }
    }
    // From bridge_top_principles.json: top chains already sorted by csw
    if (bridgeTop && Array.isArray(bridgeTop.top)) {
        for (const p of bridgeTop.top) {
            if (TARGET_PROXY.has(p.via_indicator)) continue;
            rows.push({
                principle_id: p.principle_id,
                mechanism_id: p.mechanism_id,
                via_indicator: p.via_indicator,
                to_outcome: p.to_outcome,
                pre_to_post_rho: round(p.pre_to_post_rho),
                post_to_views_r: round(p.post_to_views_r),
                chain_strength: round(p.chain_strength),
                chain_strength_specificity_weighted: round(p.chain_strength_specificity_weighted),
                mechanism_n_videos: p.mechanism_n_videos,
                mechanism_specificity_idf: round(p.mechanism_specificity_idf),
                source: 'bridge_top',
            });
        }
    }
    // Dedupe by principle_id, prefer higher |csw|
    const map = new Map();
    for (const r of rows) {
        const score = Math.abs(r.chain_strength_specificity_weighted || 0);
        const cur = map.get(r.principle_id);
        if (!cur || score > Math.abs(cur.chain_strength_specificity_weighted || 0)) map.set(r.principle_id, r);
    }
    return [...map.values()]
        .sort((a, b) => Math.abs(b.chain_strength_specificity_weighted || 0) - Math.abs(a.chain_strength_specificity_weighted || 0))
        .slice(0, limit);
}

function provenFeatures(findings) {
    if (!findings) return { kept_signals: [], discoveries: [], retention_patterns: [], concept_signals: [] };
    // Drop circular/corrupted reasons by filtering out kept_signals with 'CORRUPTED' context
    const kept = (findings.kept_signals || []).map(s => ({
        signal: s.signal,
        delta_r2: s.delta_r2,
        meaning: s.meaning,
        category: s.category,
    }));
    const discoveries = (findings.top_discoveries || [])
        .filter(d => d.r_partial === null || Math.abs(d.r_partial) >= 0.2)
        .map(d => ({ discovery: d.discovery, r_partial: d.r_partial, meaning: d.meaning }));
    const retention = (findings.retention_patterns || []).map(p => ({ pattern: p.pattern, evidence: p.evidence }));
    // Extract concept-level signals from kept_signals (category === 'concept')
    const conceptSignals = kept.filter(s => s.category === 'concept' || s.category === 'content');
    return { kept_signals: kept, discoveries, retention_patterns: retention, concept_signals: conceptSignals };
}

function topComponents(components, limit = 12) {
    if (!components || !Array.isArray(components.components)) return [];
    const rows = components.components
        .filter(c => {
            // Keep fragment_kind in frame/position/segment. Drop uninformative 'source_kind: compound'.
            if (c.fragment_kind === 'source_kind') return false;
            return (c.n_mechanisms_using || 0) >= 5;
        })
        .map(c => ({
            id: c.id,
            label: c.label,
            fragment_kind: c.fragment_kind,
            fragment_value: c.fragment_value,
            n_mechanisms_using: c.n_mechanisms_using,
            n_observations_total: c.n_observations_total,
        }))
        .sort((a, b) => (b.n_mechanisms_using || 0) - (a.n_mechanisms_using || 0))
        .slice(0, limit);
    return rows;
}

// ──────────────────────────────────────────────────────────────────────
// Concept anchors: proven high-lift concept buckets extracted from the data.
// ──────────────────────────────────────────────────────────────────────

const CONCEPT_ANCHORS = [
    {
        id: 'making',
        label: 'Making / Building / Construction',
        signals: ['pat_making_v2'],
        evidence: "pat_making_v2 delta_r2 +0.012 — title contains making/build/creat/construct. 34 videos avg 19.7M views vs 5.6M rest. 'Making' avg $24M (23 videos).",
        family: 'concept',
    },
    {
        id: 'indestructible',
        label: 'Indestructibility / Stress-Test',
        signals: ['indestructible_x_prev_keep'],
        evidence: "indestructible_x_prev_keep delta_r2 +0.026 — concept × previous keep interaction. Indestructible release after a high-keep video = super-viral.",
        family: 'concept',
    },
    {
        id: 'superhero',
        label: 'Superhero Framing',
        signals: ['cat_superhero'],
        evidence: "cat_superhero included in v9 and v13 models. Concept category delivered the first large step above baseline (+0.09 R²).",
        family: 'concept',
    },
    {
        id: 'visceral_body',
        label: 'Visceral / Physical Body Challenge',
        signals: ['pivot_density', 'visceral_words_late'],
        evidence: "Retention patterns: visceral words +5.9% (painful), +4.3% (difference), +2.5% (hurt). 'Late visceral amplification': 'crazy' at Q1=0 → Q4=+0.060.",
        family: 'concept',
    },
    {
        id: 'anticipation_setup',
        label: 'Anticipation / Setup-Payoff',
        signals: ['pivot_density', 'has_callback', 'anticipatory_frame_pct'],
        evidence: "'would happen' bigrams +4.3% retention, 'my body' +3.3%. 46% of videos contain callbacks. anticipatory_frame_pct is top hook_drop_rate reducer (avg_r=-0.401).",
        family: 'concept',
    },
];

// ──────────────────────────────────────────────────────────────────────
// Hook mechanisms: proven first-5s/first-10s prescriptions from principles.
// Each tags the principle IDs and mechanism IDs that ground it.
// ──────────────────────────────────────────────────────────────────────

function extractHookMechanisms(brief) {
    // Pull mechanisms whose bucket includes first_5s, first_10s, or hook_quarter
    const hookBuckets = new Set(['first_5s', 'first_10s', 'hook_quarter']);
    const out = [];
    for (const p of brief.top_mechanism_principles) {
        const mid = String(p.mechanism_id || '');
        let bucket = null;
        if (mid.includes('first_5s')) bucket = 'first_5s';
        else if (mid.includes('first_10s')) bucket = 'first_10s';
        else if (mid.includes('hook_quarter')) bucket = 'hook_quarter';
        if (!bucket) continue;
        out.push({
            mechanism_id: p.mechanism_id,
            bucket,
            principle_id: p.principle_id,
            via_indicator: p.via_indicator,
            csw: p.chain_strength_specificity_weighted,
            sign: (p.chain_strength_specificity_weighted || 0) >= 0 ? 'positive' : 'negative',
            n_videos: p.mechanism_n_videos,
        });
    }
    return out;
}

// ──────────────────────────────────────────────────────────────────────
// compress(): produce the full structured brief.
// ──────────────────────────────────────────────────────────────────────

function compress(artifacts) {
    artifacts = artifacts || loadAllArtifacts();
    const { findings, answers, principles, bridgeTop, components, mechanisms } = artifacts;

    const brief = {
        generated_at: new Date().toISOString(),
        source_sizes: {
            findings_model_history: (findings && findings.model_history || []).length,
            principles_total: principles && principles.n_principles,
            bridge_top_count: bridgeTop && bridgeTop.top ? bridgeTop.top.length : 0,
            components_total: components && components.n_components,
            mechanisms_total: mechanisms && mechanisms.n_mechanisms,
            videos_in_pool: mechanisms && mechanisms.n_videos_pool,
        },
        headline_model_r2: (() => {
            // Last non-corrupted model
            const hist = (findings && findings.model_history) || [];
            for (let i = hist.length - 1; i >= 0; i--) {
                const m = hist[i];
                if (!/CORRUPTED/i.test(m.model)) return { model: m.model, cv_r2: m.cv_r2, n_features: m.n_features };
            }
            return null;
        })(),
        top_post_upload_predictors: topPostUploadPredictors(answers, 8),
        top_pre_upload_predictors: topPreUploadPredictors(answers, 10),
        top_bridges_pre_to_post_to_views: topBridges(answers, 12),
        top_mechanism_principles: topMechanismPrinciples(principles, bridgeTop, 15),
        proven_features: provenFeatures(findings),
        top_components: topComponents(components, 12),
        concept_anchors: CONCEPT_ANCHORS,
    };
    brief.hook_mechanisms = extractHookMechanisms(brief);
    return brief;
}

// ──────────────────────────────────────────────────────────────────────
// Idea generation: deterministic additive scoring.
//
// An idea is built from slots — concept_anchor × hook_mechanism ×
// narrative_structure × duration_band. Each slot contributes a weighted
// score with explicit evidence. Total score = weighted sum.
// Evidence is carried forward so every recommendation can be audited.
// ──────────────────────────────────────────────────────────────────────

const NARRATIVE_STRUCTURES = [
    {
        id: 'late_peak_arc',
        label: 'Late-peak dramatic arc (peak at 60-80% of runtime)',
        weight: 0.9,
        evidence: "Retention pattern: videos peaking at 60-80% get ~10x more views than early-peaking (5.2M vs 530K median). 'Late peak = 10x more views'.",
    },
    {
        id: 'golden_final_5pct',
        label: 'Golden final 5% (spike visceral payoff in last 5% of runtime)',
        weight: 0.8,
        evidence: "Retention pattern: videos at 95-99% percentile gain +8.0% above baseline vs -0.4% rest. Final 5% is THE differentiator for mega-virality.",
    },
    {
        id: 'dramatic_pacing',
        label: 'Dramatic pacing: large max_cliff + high deriv_std',
        weight: 0.8,
        evidence: "max_cliff_single_drop r_partial=+0.36. deriv_std in v22 model. BIGGER retention drops = MORE views. Pacing complexity beats monotonic decay.",
    },
    {
        id: 'visceral_body_language',
        label: 'Visceral/physical language ramp (hurt, painful, difference, my body)',
        weight: 0.7,
        evidence: "Retention gain: painful +5.9%, difference +4.3%, hurt +2.5%, 'my body' +3.3%. 'Late visceral amplification': visceral words 60x more effective late.",
    },
    {
        id: 'fast_pacing_no_pauses',
        label: 'Fast speech + no long silences',
        weight: 0.5,
        evidence: "Speech rate r=+0.24 vs retention. Long pauses >1s: r=-0.22 vs retention. Transition words ('so', 'however') drop -11.2% / -8.6%.",
    },
    {
        id: 'callback_closure',
        label: 'Callback to hook concept in last 20%',
        weight: 0.4,
        evidence: "has_callback r=0.14 vs keep. 46% of videos use callbacks. 'Anticipation phrases retain': would-happen, my-body bigrams.",
    },
];

const DURATION_BANDS = [
    {
        id: 'sweet_spot_46_60',
        label: '46–60s sweet spot',
        weight: 1.0,
        evidence: "Duration sweet spot: 46-60s = 28/98 videos hit 10M+, median 2.9M. 15-30s = death zone (0/11, 513K median). 46-60s balances duration×retention.",
    },
];

function scoreIdea(idea, brief) {
    // Score components:
    //   - concept: delta_r2 from proven_features + matched signals
    //   - hook: |csw| of matched principle (up to cap)
    //   - narrative: sum of structure weights
    //   - duration: band weight
    //   - bridge bonus: if idea uses at least one top pre-upload predictor
    const parts = { concept: 0, hook: 0, narrative: 0, duration: 0, bridge: 0 };

    // concept score: aggregate delta_r2 from kept_signals matching concept signal names
    for (const anchor of idea.concept_anchors) {
        const conceptRow = brief.concept_anchors.find(c => c.id === anchor);
        if (!conceptRow) continue;
        for (const sig of conceptRow.signals) {
            const kept = brief.proven_features.kept_signals.find(k => k.signal === sig);
            if (kept) {
                const delta = parseFloat(String(kept.delta_r2).replace('+', '')) || 0;
                parts.concept += delta;
            } else {
                parts.concept += 0.008; // baseline concept lift credit
            }
        }
    }

    // hook score
    for (const hook of idea.hook_mechanisms) {
        parts.hook += Math.abs(hook.csw || 0);
    }

    // narrative score
    for (const n of idea.narrative_structures) {
        const row = NARRATIVE_STRUCTURES.find(x => x.id === n);
        if (row) parts.narrative += row.weight * 0.05; // scale to R² equivalents
    }

    // duration score
    const dBand = DURATION_BANDS.find(d => d.id === idea.duration_band_id);
    if (dBand) parts.duration += dBand.weight * 0.05;

    // bridge bonus: add the top 3 pre-upload predictors the idea leverages, if declared
    for (const preKey of idea.pre_upload_levers || []) {
        const row = brief.top_pre_upload_predictors.find(p => p.key === preKey);
        if (row) parts.bridge += Math.abs(row.r_to_views || 0) * 0.5;
    }

    const total = parts.concept + parts.hook + parts.narrative + parts.duration + parts.bridge;
    return { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 4)])), total: round(total, 4) };
}

// Evidence citations: plain-English lines grounded in the brief
function evidenceFor(idea, brief) {
    const out = [];
    for (const anchor of idea.concept_anchors) {
        const row = brief.concept_anchors.find(c => c.id === anchor);
        if (row) out.push(`Concept[${row.id}]: ${row.evidence}`);
    }
    for (const hook of idea.hook_mechanisms) {
        out.push(`Hook[${hook.mechanism_id}] via ${hook.via_indicator} (principle ${hook.principle_id}, n=${hook.n_videos}, csw=${round(hook.csw, 3)}).`);
    }
    for (const n of idea.narrative_structures) {
        const row = NARRATIVE_STRUCTURES.find(x => x.id === n);
        if (row) out.push(`Structure[${row.id}]: ${row.evidence}`);
    }
    const dBand = DURATION_BANDS.find(d => d.id === idea.duration_band_id);
    if (dBand) out.push(`Duration[${dBand.id}]: ${dBand.evidence}`);
    for (const preKey of idea.pre_upload_levers || []) {
        const row = brief.top_pre_upload_predictors.find(p => p.key === preKey);
        if (row) out.push(`Pre-upload lever[${row.key}]: r=${row.r_to_views}, ${row.direction}.`);
    }
    return out;
}

// ──────────────────────────────────────────────────────────────────────
// Idea skeletons — deliberately finite. Each skeleton combines proven
// concept anchors with mechanism-backed hook/structure prescriptions.
// The engine picks the top hook mechanisms by |csw| inside each bucket.
// ──────────────────────────────────────────────────────────────────────

function pickHooksForIdea(brief, { need_bucket_first_5s = true, need_bucket_first_10s = true, need_bucket_hook_quarter = false } = {}) {
    // For each required bucket, pick the hook with the largest |csw| that's
    // in that bucket.
    const picks = [];
    const byBucket = {};
    for (const h of brief.hook_mechanisms) {
        if (!byBucket[h.bucket]) byBucket[h.bucket] = [];
        byBucket[h.bucket].push(h);
    }
    for (const b of Object.keys(byBucket)) {
        byBucket[b].sort((a, b) => Math.abs(b.csw || 0) - Math.abs(a.csw || 0));
    }
    if (need_bucket_first_5s && byBucket.first_5s && byBucket.first_5s[0]) picks.push(byBucket.first_5s[0]);
    if (need_bucket_first_10s && byBucket.first_10s && byBucket.first_10s[0]) picks.push(byBucket.first_10s[0]);
    if (need_bucket_hook_quarter && byBucket.hook_quarter && byBucket.hook_quarter[0]) picks.push(byBucket.hook_quarter[0]);
    return picks;
}

function baseIdeaSkeletons() {
    return [
        {
            title: 'Making Something Indestructible — 60s Stress-Test with Late Visceral Payoff',
            one_line_premise: 'Build or assemble a seemingly fragile object, narrate a physical stress-test, and deliver the visceral reveal at 75-90% of runtime.',
            concept_anchors: ['making', 'indestructible'],
            narrative_structures: ['late_peak_arc', 'dramatic_pacing', 'visceral_body_language', 'golden_final_5pct'],
            duration_band_id: 'sweet_spot_46_60',
            pre_upload_levers: ['visual_variety_entropy', 'pivot_word_count', 'scene_burst_count', 'proof_of_work_count', 'repeated_phrase_count'],
            hook_bucket_preference: { need_bucket_first_5s: true, need_bucket_first_10s: true },
        },
        {
            title: 'Superhero-Framed Physical Challenge — Direct-Address Hook, Body-On-The-Line Payoff',
            one_line_premise: 'Cast yourself (or subject) as a superhero-coded challenger; look camera-in in the first 3 seconds, state the premise visibly, and land a painful/visceral reveal past midpoint.',
            concept_anchors: ['superhero', 'visceral_body'],
            narrative_structures: ['late_peak_arc', 'visceral_body_language', 'fast_pacing_no_pauses', 'callback_closure'],
            duration_band_id: 'sweet_spot_46_60',
            pre_upload_levers: ['visual_variety_entropy', 'scene_change_count', 'beat_count', 'pivot_word_count'],
            hook_bucket_preference: { need_bucket_first_5s: true, need_bucket_first_10s: true },
        },
        {
            title: 'Would You Believe ____? — Anticipation-Setup with 10x Late-Peak Reveal',
            one_line_premise: 'Open on a tight close-up and a spoken anticipation phrase ("you won\'t believe what happened when…"), set up the stakes, and withhold the proof until the 60-80% mark.',
            concept_anchors: ['anticipation_setup', 'visceral_body'],
            narrative_structures: ['late_peak_arc', 'callback_closure', 'dramatic_pacing', 'golden_final_5pct'],
            duration_band_id: 'sweet_spot_46_60',
            pre_upload_levers: ['pivot_word_count', 'repeated_phrase_count', 'visual_variety_entropy'],
            hook_bucket_preference: { need_bucket_first_5s: true, need_bucket_hook_quarter: true },
        },
        {
            title: 'Making X vs Y — Side-By-Side Build, Single Decisive Moment',
            one_line_premise: 'Build two competing variants in parallel on camera; cut every 2-3 seconds across visual varieties; converge on one decisive test where one fails in the last 5%.',
            concept_anchors: ['making', 'anticipation_setup'],
            narrative_structures: ['dramatic_pacing', 'fast_pacing_no_pauses', 'golden_final_5pct', 'late_peak_arc'],
            duration_band_id: 'sweet_spot_46_60',
            pre_upload_levers: ['scene_burst_count', 'scene_change_count', 'frame_cluster_count', 'visual_variety_entropy', 'beat_count'],
            hook_bucket_preference: { need_bucket_first_5s: true, need_bucket_first_10s: true },
        },
        {
            title: 'I Made My Body Do ____ — Visceral First-Person Build with Late Painful Reveal',
            one_line_premise: 'First-person physical construction/modification (visible body, visible effort, proof-of-work props); ramp visceral language in the second half; the last 5% is the "ow / I felt it" payoff.',
            concept_anchors: ['making', 'visceral_body', 'indestructible'],
            narrative_structures: ['late_peak_arc', 'visceral_body_language', 'golden_final_5pct', 'callback_closure'],
            duration_band_id: 'sweet_spot_46_60',
            pre_upload_levers: ['proof_of_work_count', 'pivot_word_count', 'repeated_phrase_count', 'visual_variety_entropy'],
            hook_bucket_preference: { need_bucket_first_5s: true, need_bucket_first_10s: true },
        },
    ];
}

function generateIdeas(brief, count = 5) {
    brief = brief || compress();
    const skeletons = baseIdeaSkeletons();
    const ideas = skeletons.map((sk, i) => {
        const hooks = pickHooksForIdea(brief, sk.hook_bucket_preference || {});
        const idea = {
            rank: i + 1,
            title: sk.title,
            one_line_premise: sk.one_line_premise,
            concept_anchors: sk.concept_anchors,
            hook_mechanisms: hooks,
            narrative_structures: sk.narrative_structures,
            duration_band_id: sk.duration_band_id,
            pre_upload_levers: sk.pre_upload_levers,
        };
        idea.score_breakdown = scoreIdea(idea, brief);
        idea.evidence = evidenceFor(idea, brief);
        return idea;
    });
    // Sort by total score desc, take top N, rewrite rank
    ideas.sort((a, b) => (b.score_breakdown.total || 0) - (a.score_breakdown.total || 0));
    const topN = ideas.slice(0, count);
    topN.forEach((x, i) => { x.rank = i + 1; });
    return topN;
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

function buildModel() {
    const artifacts = loadAllArtifacts();
    return { brief: compress(artifacts) };
}

function buildIdeas(count = 5) {
    const { brief } = buildModel();
    const ideas = generateIdeas(brief, count);
    return { brief_summary: summarizeBrief(brief), ideas };
}

function summarizeBrief(brief) {
    return {
        generated_at: brief.generated_at,
        source_sizes: brief.source_sizes,
        headline_model_r2: brief.headline_model_r2,
        counts: {
            top_post_upload_predictors: brief.top_post_upload_predictors.length,
            top_pre_upload_predictors: brief.top_pre_upload_predictors.length,
            top_bridges: brief.top_bridges_pre_to_post_to_views.length,
            top_mechanism_principles: brief.top_mechanism_principles.length,
            hook_mechanisms: brief.hook_mechanisms.length,
            proven_kept_signals: brief.proven_features.kept_signals.length,
            top_components: brief.top_components.length,
            concept_anchors: brief.concept_anchors.length,
        },
    };
}

module.exports = {
    loadAllArtifacts,
    compress,
    buildModel,
    buildIdeas,
    generateIdeas,
    summarizeBrief,
};

// CLI: node buildings/jarvis/viral-idea-engine.js [model|ideas|save]
if (require.main === module) {
    const cmd = process.argv[2] || 'ideas';
    if (cmd === 'model') {
        const { brief } = buildModel();
        process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
    } else if (cmd === 'ideas') {
        const count = parseInt(process.argv[3] || '5', 10);
        const payload = buildIdeas(count);
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    } else if (cmd === 'save') {
        const count = parseInt(process.argv[3] || '5', 10);
        const payload = buildIdeas(count);
        const outPath = path.join(ARTIFACT_DIR, 'viral-ideas.json');
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
        process.stdout.write(`Wrote ${outPath}\n`);
    } else {
        process.stderr.write(`Usage: node viral-idea-engine.js [model|ideas [n]|save [n]]\n`);
        process.exit(2);
    }
}
