// concept-blueprint.js
//
// One-off concept-to-blueprint tool. Reuses the evidence lattice compressed
// by viral-idea-engine.buildModel() and grounds every beat/choice in a cited
// lattice field. Meant for evaluating a single externally-authored concept
// (hook line + intro visual already decided) and deriving the rest of the
// video, rather than generating candidates from hardcoded OBJECT_MOTIFS.
//
// Usage: node buildings/jarvis/concept-blueprint.js
// Output: single JSON blueprint + human-readable report to stdout.

const { buildModel } = require('./viral-idea-engine');

const round = (x, n = 4) => Number(Number(x).toFixed(n));

// ---------- Concept input (the ONLY hardcoded motif-level thing) ----------
const CONCEPT = {
    id: 'oobleck_egg_drop_paradox',
    // `topic_bucket` is the alias-first name for the motif-diversity axis this
    // concept sits on. `topic_family` is kept as a legacy mirror so anything
    // consuming the older key keeps working.
    topic_bucket: 'experimentation_paradox',
    topic_family: 'experimentation_paradox',
    hook_line: 'Why does oobleck get hard when you hit it, but also somehow can protect an egg from falling 5 feet off the ground?',
    intro_visual_facts: [
        'By the end of the intro the viewer has already seen the egg survive a 5-foot fall into oobleck.',
        'The payoff of the 5-foot promise is visually complete before the hook line finishes.',
    ],
    core_concept: 'Experimentation video that probes the paradox: oobleck hardens under impact yet cushions an egg. Intro proof is already shown visually.',
    runtime_target_s: 52, // 50-55s sweet spot: 2.88M avg views
    assumed_known_by_viewer_at_t5s: ['egg survives 5ft drop', 'substance is called oobleck'],
};

// ---------- Helpers that read lattice fields directly ----------
function firstWordOfHook(line) {
    const tok = String(line).trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z']/g, '');
    return tok;
}

function stripParen(s) { return String(s).split('(')[0].trim().toLowerCase(); }

function classifyHookFirstWord(word, hook) {
    const best = new Set((hook.best_first_words || []).map(stripParen));
    const worst = new Set((hook.worst_first_words || []).map(stripParen));
    if (best.has(word)) return { bucket: 'best_first_words', note: 'First word of the hook is in the validated best_first_words list.' };
    if (worst.has(word)) return { bucket: 'worst_first_words', note: 'First word is in the validated worst_first_words list — consider reordering.' };
    return { bucket: 'neutral', note: 'First word is not in best_first_words or worst_first_words — neutral.' };
}

function classifyHookType(line) {
    const lower = String(line).toLowerCase();
    if (/^why\b|\bhow\b|\bsomehow\b|\bparadox|\bmystery/.test(lower)) return { kind: 'mystery', evidence: 'hook_taxonomy.second (2.20M) — "why / somehow" is a mystery framing. Second-best bucket, well above "stakes" (1.12M worst).' };
    if (/\bturn(ed)? into\b|\bbefore.*after\b|\btransform/.test(lower)) return { kind: 'transformation', evidence: 'hook_taxonomy.best (2.24M)' };
    if (/\bif this fails\b|\bi might\b|\blast chance\b/.test(lower)) return { kind: 'stakes', evidence: 'hook_taxonomy.worst (1.12M) — avoid.' };
    return { kind: 'unclassified', evidence: 'No taxonomy match; defaulting to neutral.' };
}

function vocabularyForConcept(brief) {
    // Concept-specific synonym map — these are Jarvis-corpus-backed impact words
    // that also fit the oobleck physics domain.
    const top_pos = brief.evidence_lattice.vocabulary.top_words_positive;
    const top_neg = brief.evidence_lattice.vocabulary.top_words_negative;
    const pos = new Map(top_pos.map(r => [r.word, r]));
    const neg = new Map(top_neg.map(r => [r.word, r]));
    // Words that both exist in the corpus positive list AND fit impact/egg/fall context
    const conceptRelevantPositive = ['impact', 'painful', 'curious', 'bigger', 'here', 'okay', 'instead', 'fall', 'feeling', 'numb'];
    const usePositive = conceptRelevantPositive
        .map(w => pos.get(w))
        .filter(Boolean);
    // Words that Jarvis flagged as retention killers AND likely to appear in a
    // physics-topic video if we're careless
    const riskyForThisTopic = ['solid', 'water', 'plastic', 'fiber', 'carbon', 'materials', 'testing', 'designed', 'built', 'research', 'learning', 'improve', 'machine', 'metal', 'company', 'solve'];
    const avoidFromCorpus = riskyForThisTopic
        .map(w => neg.get(w))
        .filter(Boolean);
    // Additional lexicon flags that Jarvis hasn't scored but are covered by the
    // TECHNICAL_MATERIAL_LANGUAGE risk class (top_3_retention_drop_causes #1).
    const avoidHeuristic = ['non-Newtonian', 'cornstarch', 'viscosity', 'polymer', 'shear-thickening', 'suspension', 'molecules', 'particles'];
    return { usePositive, avoidFromCorpus, avoidHeuristic };
}

function pickClosingWord(brief) {
    // best_last_words from opening_words; pick first whose plain form is usable
    // in the concept context.
    const ranked = (brief.evidence_lattice.hook_prescription.best_last_words || []).map(stripParen);
    // prefer words compatible with the topic. 'insane' fits a paradox payoff.
    for (const w of ['insane', 'unreal', 'no way']) {
        if (ranked.includes(w)) return { word: w, source: `opening_words.best_last_words (${w})` };
    }
    return { word: ranked[0] || 'insane', source: 'opening_words.best_last_words[0]' };
}

function scoreHookAgainstLattice(brief) {
    const hook = brief.evidence_lattice.hook_prescription;
    const first = firstWordOfHook(CONCEPT.hook_line);
    const firstWordCheck = classifyHookFirstWord(first, hook);
    const hookType = classifyHookType(CONCEPT.hook_line);
    // Anchor: retention_at_20s is the single strongest predictor (r=0.60)
    const r20 = hook.first_20s_is_everything;
    const hookWordCount = CONCEPT.hook_line.trim().split(/\s+/).length;
    const hookDurationEstimateS = hookWordCount / 2.6; // ~2.6 w/s sweet zone
    const physicalProofPresent = CONCEPT.intro_visual_facts.some(f => /egg survive|fall|5-foot|5 ft|5'/.test(f.toLowerCase()));
    return {
        first_word: first,
        first_word_classification: firstWordCheck,
        hook_type_inferred: hookType,
        hook_length_words: hookWordCount,
        estimated_hook_duration_s: round(hookDurationEstimateS, 2),
        physical_proof_in_intro: physicalProofPresent,
        retention_anchors: {
            r20_strongest_predictor_r: r20.retention_at_20s_r_with_views,
            target_retention_at_20s: '≥0.80 (corpus mean 0.793 → 2x view hit rate if beaten)',
            design_rule: r20.design_rule,
        },
        corpus_evidence: [
            `BREAKTHROUGH_WAVE20.raw_retention_at_20s r_with_views=${r20.retention_at_20s_r_with_views} — THE strongest single predictor.`,
            `hook_taxonomy: ${JSON.stringify(hook.hook_taxonomy)} — "Why/somehow" = mystery (2.20M median), second-best bucket.`,
            `payoff_zone.end_begin_ratio: end_stronger=${brief.evidence_lattice.payoff_zone.end_begin_ratio.end_stronger_views}, begin_stronger=${brief.evidence_lattice.payoff_zone.end_begin_ratio.begin_stronger_views} — 11.8x gap. Intro over-delivery is a LIABILITY unless the rest escalates beyond it.`,
            `design_rules_v3 #3 OVER-DELIVER: ending must exceed the opening promise. Since the 5ft-drop promise is already satisfied at t=5s, the rest must exceed "5ft".`,
            `design_rules_v3 #6 CONCEPT EARLY: main concept in first 10% = 2.6M vs after 30% = 476K (5.4x).`,
        ],
    };
}

function selectNarrativeStructures() {
    // Chosen because they match this concept's retention-physics, with each
    // structure cited to a retention-patterns.json field.
    return [
        { id: 'late_peak_arc', why: 'Retention peak at 60-80% → 10x more views (5.2M vs 530K median).' },
        { id: 'golden_final_5pct', why: 'Videos at 95-99% percentile gain +8.0% above baseline vs -0.4% rest.' },
        { id: 'monotonic_rise', why: 'Quartile progression ↑↑↑ = 4.19M vs ↓↓↓ = 222K (19x). Each drop/test must exceed the last.' },
        { id: 'nadir_before_climax', why: 'best_after_worst 3.3M vs best_before_worst 650K (5x). Place the "hand almost breaks" moment before the roof-drop payoff, not after.' },
        { id: 'callback_closure', why: 'has_callback r=+0.14; the final beat should echo the intro hook word "somehow" / "5 feet" so the overshoot reads as answer.' },
        { id: 'visceral_body_language', why: 'PHYSICAL/SENSORY LANGUAGE +0.06 above_baseline; sensory-rate regression weight +1.59. We HAVE a natural body anchor: the hand punching oobleck.' },
        { id: 'fast_pacing_no_pauses', why: 'Speech rate r=+0.24 vs retention, pauses >1s r=-0.22. Keep spoken track continuous across the 52s — no music-only stretches ([music]=-0.099).' },
    ];
}

function buildPostIntroBeats(brief, vocab, closing) {
    // We allocate 0-5s to the given intro. Beats span t=5-52s (47s).
    // Zone_pct is % of total 52s runtime. Each beat carries a concrete SPOKEN
    // LINE, a VISUAL, a PACING directive, and a lattice CITATION.
    const arc = brief.evidence_lattice.arc_structure;
    const pacing = brief.evidence_lattice.pacing;
    const peakCauses = brief.evidence_lattice.visual_prescription.peak_causes;
    const peakAction = peakCauses.find(c => /HIGH-ENERGY ACTION/i.test(c.cause));
    const peakSensory = peakCauses.find(c => /PHYSICAL.*SENSORY/i.test(c.cause));
    const peakSlow = peakCauses.find(c => /SLOWER SPEAKING/i.test(c.cause));

    const beats = [
        {
            zone_pct: '0-10',   // 0-5s (GIVEN intro, echoed here for completeness)
            t_s: '0.0 – 5.0',
            role: 'GIVEN intro (do not modify)',
            visual: 'Egg dropped from 5ft lands in oobleck tray and is lifted out intact. Counter/ruler shows 5 ft. No text overlay.',
            spoken: CONCEPT.hook_line,
            pacing: '~2.6 w/s (medium-density sweet zone per speaking_patterns.opening_density).',
            evidence: [
                'design_rules_v3 #6: main concept named in first 10%.',
                'top_3_peak_causes.HIGH-ENERGY_ACTION_FRAMES: action frame at t=0 is comprehension.',
                `hook_prescription.first_20s_is_everything: r=${brief.evidence_lattice.hook_prescription.first_20s_is_everything.retention_at_20s_r_with_views}.`,
            ],
        },
        {
            zone_pct: '10-22', // 5.2 – 11.4s
            t_s: '5.2 – 11.4',
            role: 'Reframe: the visual proof was real, but you already want more.',
            visual: 'Tyler\'s hand enters frame, slaps the oobleck surface — surface is hard, no splash. Single cut. Close-up on knuckles.',
            spoken: 'Okay — but watch what my hand does.',
            pacing: '2.8 w/s, single sentence ≤10 words.',
            evidence: [
                'opening_words.best_first_words includes "okay" (word-retention-impact.json avg_ab=+0.076, n=12).',
                'frame_close_up_at_hook_quarter: rho=-0.253 vs avg_retention BUT rho=+0.192 vs log_views (close-ups after the hook drive clicks even while they depress retention — pair with action).',
                'peak_cause.HIGH-ENERGY_ACTION_FRAMES (+0.058 above_baseline).',
                'peak_cause.PHYSICAL/SENSORY_LANGUAGE ("hand", "knuckles" are body anchors).',
            ],
        },
        {
            zone_pct: '22-40', // 11.4 – 20.8s
            t_s: '11.4 – 20.8',
            role: 'Paradox demonstration with the viewer\'s own hand as body-anchor.',
            visual: 'Same hand now slowly lowers into the tray — fingers sink through as if into thick soup. Cut back to a fist-punch: surface is a wall. Alternate: slow pour through fingers / hard fist-smash. 3-4 cuts; no text overlay; pacing gets tighter.',
            spoken: 'Slow — liquid. Fast — hard. The faster it gets hit, the harder it gets. Which is how the egg survived.',
            pacing: '3.2 w/s drifting toward 3.6 w/s by end of beat. ≤10 words per utterance.',
            evidence: [
                'payoff_zone.hook_payoff_gap r=-0.520 (top regression feature): we name the mechanism AFTER the visual, so the answer over-delivers vs the question.',
                'BREAKTHROUGH_WAVE20.raw_retention_at_20s r=0.60 — retention at 20s is THE strongest predictor. This beat straddles 20s; it must be the densest physical-evidence beat of the video.',
                'top_3_peak_causes.PHYSICAL/SENSORY_LANGUAGE weight=+1.59.',
                'word-retention-impact: "hit" n=27 avg_ab=-0.006 (neutral), "hard" n=75 avg_ab=+0.011 (mild positive).',
                'risk_flags.TECHNICAL/MATERIAL_LANGUAGE: we NEVER say "non-Newtonian", "shear-thickening", "cornstarch", "viscosity". We describe the MOTION, not the substance class.',
                'design_rules_v3 #8 SMOOTH 10-20% ZONE (r=-0.31 volatility): lock the camera, establish a consistent cadence here.',
            ],
        },
        {
            zone_pct: '40-60', // 20.8 – 31.2s
            t_s: '20.8 – 31.2',
            role: 'Escalation: re-run the 5ft drop, but with stakes.',
            visual: 'Drop #2 shown from a LADDER — higher than 5 ft but still safe. Camera low-angle. Egg falls, splat-splash into oobleck. Pull egg out: intact. Tyler\'s face appears briefly ONLY while hand is cleaning oobleck off the egg (face-without-action is a drop cause, so face must be paired with physical motion).',
            spoken: 'So I went higher. Ten feet. Still fine.',
            pacing: '3.4 w/s. Short sentences. No pause >1s.',
            evidence: [
                'top_3_drop_causes.FACE+TEXT_WITHOUT_ACTION: face must be paired with physical action. We obey.',
                'design_rules_v3 #9 SETUP→MID ACCELERATION r=+0.44 — strongest transition predictor is the speed of improvement in the 25-50% zone.',
                'wave9_10.best_after_worst 3.3M vs best_before_worst 650K — we put the "is my egg going to break" moment BEFORE the final over-delivery, not after.',
                'word-retention-impact: "fine" avg_ab=+0.036 n=13 — usable reassurance token without a "[music]" beat.',
            ],
        },
        {
            zone_pct: '60-82', // 31.2 – 42.6s
            t_s: '31.2 – 42.6',
            role: 'Nadir — introduce the FIRST failure/doubt so the final payoff is an over-delivery, not a monotone win.',
            visual: 'Drop #3 from ~15 ft: egg lands at an angle and we see a CRACK — zoom in on the cracked shell. Tyler\'s hand picks it up; yolk leaks. Cut to: same hand wiping down the oobleck; the surface is now stirred, softened. Hand TESTS the stirred surface — this time the punch goes through (sinks). Camera stays on the hand.',
            spoken: 'It broke. And it turns out if you stir it, it stops working. You have to hit it fresh.',
            pacing: '3.6 w/s at the reveal, drop back to 3.2 for the explanation. ≤8 words per line.',
            evidence: [
                'top_5_retention_predictors.HOOK_PAYOFF_GAP r=-0.520: introducing a counter-finding HERE sets up the over-delivery payoff in 82-95%.',
                'wave9_10.best_after_worst: 3.3M vs 650K (5x). We place the "it broke" moment at 60-80%, not after 82%.',
                'design_rules_v3 #13 MINIMIZE NEGATIVE AUC: the failure is a short single-beat, not a sequence.',
                'peak_cause.SLOWER_SPEAKING_SPEED at key moments (0.40 w/s slower at peaks vs drops) — we drop to 3.2 w/s on the "you have to hit it fresh" reveal.',
                'top_3_drop_causes.TECHNICAL_MATERIAL_LANGUAGE: we do NOT say "shear-thickening", "viscous", "suspension". We say "if you stir it, it stops working" (action-verb framing).',
            ],
        },
        {
            zone_pct: '82-95', // 42.6 – 49.4s
            t_s: '42.6 – 49.4',
            role: 'Over-delivery climax — drop from a height that clearly exceeds the 5 ft promised by the hook.',
            visual: 'Drop #4 from a ROOF or second-story window (clearly >5 ft — a multi-floor shot). Wide shot of egg falling past windows; cut to tray; impact is hard, oobleck stiffens visibly. Pause. Hand reaches in, lifts the egg. Intact. Camera holds on the egg still dripping oobleck.',
            spoken: '[pause] Two stories up. Still okay.',
            pacing: '3.0 w/s on the reveal (slowest of the video). 5-word utterance. 0.6s pause before "Still okay." (≤1s per pauses_rule).',
            evidence: [
                'design_rules_v3 #2 END>HOOK: 80-95% zone r=0.505 anchor; back-loaded=3.9M vs front-loaded=580K (6.7x).',
                'design_rules_v3 #11 SLOW PAYOFF DELIVERY: 3.0 w/s at peaks vs 4.4 neutral; 7.9-word utterances.',
                'payoff_zone.end_begin_ratio 11.8x gap — the multi-floor drop must VISUALLY outclass the 5-ft intro.',
                'opening_words.best_last_words: "insane(7.44)" is available for the final beat, but we slow-play the reveal here.',
                'vocabulary.top_words_positive: "okay"=+0.076 (top-1 positive delta, n=12) — ending on "okay" is contrarian but data-backed.',
            ],
        },
        {
            zone_pct: '95-100', // 49.4 – 52.0s
            t_s: '49.4 – 52.0',
            role: 'Golden final 5% — single-word overlay + callback + share trigger.',
            visual: 'Freeze on the egg, oobleck dripping. Overlay: a single word (see "closing_word").',
            spoken: `Tell me in the comments what I should drop next.`,
            pacing: 'Utterance 8 words, 3.0 w/s.',
            closing_word_overlay: closing.word,
            evidence: [
                `payoff_zone.end_recovery r=+0.506: final 15% matters 8.5x more than the hook for total views.`,
                `wave11_12.key_phrases.peak_phrases "in the comments" — share trigger in the positive list.`,
                `opening_words.best_last_words → closing word "${closing.word}" from ${closing.source}.`,
                'design_rules_v3 #10 SWIPE+END COMBO: low_swipe + strong_end = 5.6M vs high_swipe + weak_end = 493K (11.3x).',
                'callback_closure: echoes intro "somehow / 5 feet" by over-delivering on the number.',
            ],
        },
    ];

    return beats;
}

function buildVisualPrescription(brief) {
    const mil = brief.evidence_lattice.visual_prescription.frame_mechanisms_by_outcome || {};
    const peakCauses = brief.evidence_lattice.visual_prescription.peak_causes;
    const dropCauses = brief.evidence_lattice.visual_prescription.drop_causes;
    return {
        first_5s: [
            'Egg mid-fall (physical action at t=0).',
            'Ruler/height indicator in frame.',
            'No explanatory overlay.',
            'Peak cause: HIGH-ENERGY ACTION FRAMES (+0.058 above_baseline; 28% vs 8% at drops).',
        ],
        hook_quarter_5_to_13s: [
            'Hand on oobleck (body anchor). Close-up OK because close_up_at_hook_quarter rho=+0.192 vs log_views.',
            'No talking-head without action.',
        ],
        mid_13_to_42s: [
            'Alternate action frames (punches, drops) with slow-liquid pours.',
            'Text overlay ONLY at beat moments (frame_text_overlay_at_mid rho=+0.247 vs log_views, but rho=+0.281 vs swipe_away — use sparingly).',
            'Camera locked; no handheld jitter in 10-20% zone (design_rules_v3 #8).',
        ],
        late_42_to_52s: [
            'Wide shot for the multi-floor drop → extreme close-up on the intact egg.',
            'frame_close_up_at_late rho=+0.230 vs log_views.',
            'Single freeze at 49s with overlay.',
        ],
        avoid: [
            'Face without action (top-3 drop cause).',
            'Text-heavy talking-head segment (text+face+no action = classic trap).',
            `Music-only segments: "[music]" avg_ab=-0.099 in word-retention-impact.json.`,
            'Naming materials ("cornstarch", "non-Newtonian", "viscosity").',
            'Any setup/explanation after t=31s (design_rules_v3 #13 + LATE_WORST_MOMENT rule).',
        ],
        _derived_from: [
            'visual_prescription.peak_causes = ' + peakCauses.map(c => c.cause).join(' | '),
            'visual_prescription.drop_causes = ' + dropCauses.map(c => c.cause).join(' | '),
            'frame_mechanisms_by_outcome.log_views top = ' + (mil.log_views || []).map(m => `${m.mechanism}(rho=${m.rho})`).join(' | '),
        ],
    };
}

function buildScorecardTargets(brief) {
    const stats = brief.evidence_lattice.scorecard_dimensions.dimension_stats;
    const target = (dim, ambition) => {
        const s = stats[dim] || {};
        return {
            target: ambition === 'p90' ? s.p90 : (ambition === 'p75' ? s.p75 : s.mean),
            ambition,
            corpus_mean: s.mean, corpus_p75: s.p75, corpus_p90: s.p90,
        };
    };
    return {
        over_delivery: target('over_delivery', 'p90'),         // 10 — critical for this concept
        late_retention: target('late_retention', 'p90'),       // 10
        consistency: target('consistency', 'p90'),             // 10
        smoothness: target('smoothness', 'p90'),               // 9.19
        sensory_language: target('sensory_language', 'p90'),   // 8.33 — TOP-DECILE sensory density is non-trivial; requires narrating every hand/egg beat
        material_avoidance: target('material_avoidance', 'p90'), // 10 — non-negotiable on a substance-physics topic
        early_momentum: target('early_momentum', 'p90'),       // 10 — intro already shows the 5ft landing
    };
}

function buildRiskFlags(brief) {
    const flags = [];
    for (const f of brief.evidence_lattice.risk_flags) flags.push({ flag: f.flag, severity: 'from-corpus', rule: f.rule, source: f.source });
    // Concept-specific additional flags
    flags.push({
        flag: 'INTRO_ALREADY_DELIVERED_5FT',
        severity: 'high',
        rule: 'Because the intro visually resolves the 5ft question at t=5s, the rest MUST outperform 5ft visually. Otherwise the hook-payoff-gap goes positive (bad: r=-0.520). Escalate height twice (ladder, then roof).',
        source: 'payoff_zone.end_begin_ratio (end_stronger=4.70M vs begin_stronger=398K; gap 11.8x)',
    });
    flags.push({
        flag: 'SCIENCE_TOPIC_MATERIAL_WORD_RISK',
        severity: 'high',
        rule: 'Do NOT say: non-Newtonian, cornstarch, viscosity, suspension, polymer, shear-thickening, molecules, particles. Describe motion ("slow → liquid, fast → hard"), not substance class.',
        source: 'top_3_drop_causes.TECHNICAL_MATERIAL_LANGUAGE (-0.17 avg ab_baseline for "plastic"; "solid" avg_ab=-0.163 in word-retention-impact.json, n=13)',
    });
    flags.push({
        flag: 'SAY_SOLID_TRAP',
        severity: 'high',
        rule: 'Avoid the word "solid" entirely. Replace with "hard". ("solid" avg_ab=-0.163, n=13; "hard" avg_ab=+0.011, n=75.)',
        source: 'word-retention-impact.json',
    });
    flags.push({
        flag: 'SILENT_BEAT_TRAP',
        severity: 'medium',
        rule: 'No music-only stretches. Keep spoken sensory narration continuous. "[music]" avg_ab=-0.099, n=39.',
        source: 'word-retention-impact.json',
    });
    flags.push({
        flag: 'OVER_EXPLAINING_TRAP',
        severity: 'medium',
        rule: 'Don\'t teach the mechanism. Let the hand + slow-vs-fast cuts BE the explanation. "research" avg_ab=-0.100, "learning" avg_ab=-0.092, "solve" avg_ab=-0.090.',
        source: 'word-retention-impact.json (science-lecture lexicon cluster)',
    });
    return flags;
}

function buildPacingPlan(brief) {
    const p = brief.evidence_lattice.pacing;
    return {
        runtime_target_s: CONCEPT.runtime_target_s,
        duration_evidence: `duration_insight.5s_buckets: 50-55s=2.88M (n=46); 40-45s=2.19M; sweet_spot=50-55s. Chosen ${CONCEPT.runtime_target_s}s.`,
        opening_wps: 2.6,
        opening_wps_evidence: 'speaking_patterns.opening_density: 1.5-3.0 medium-density sweet zone.',
        peak_wps: 3.0,
        peak_wps_evidence: `pacing.peak_speaking_rate_wps=${p.peak_speaking_rate_wps}; design_rules_v3 #11 says 3.0 w/s at peaks.`,
        neutral_wps: 3.4,
        peak_utterance_len_words: 8,
        peak_utterance_len_evidence: `pacing.utterance_length_at_peaks_words=${p.utterance_length_at_peaks_words}`,
        pauses_rule: 'No pauses >1s. One intentional 0.6s pause before the final "Still okay."',
        pauses_evidence: p.pauses_rule,
    };
}

function buildDesignScoreBreakdown(brief, narrativeStructures, vocab) {
    // Composite design score calibrated to the engine's scoreIdea range (0.3-0.7
    // in practice). Each part mirrors a weighting in viral-idea-engine.scoreIdea
    // but is adapted to an externally-supplied concept. See honest_limits below
    // for why the individual weights are the engine's defaults rather than
    // concept-refit.
    const parts = {};
    // Hook component: engine multiplies |csw| over matched hook mechanisms. Mystery
    // hooks map to the 2.20M bucket (second-best). Use 0.08 as the mystery-hook
    // proxy contribution (vs ~0.10 for transformation, ~0.03 for stakes).
    parts.hook = 0.08;
    // Narrative: engine uses sum(weight * 0.05). Our structures sum: 0.9+0.8+0.7+0.6+0.4+0.7+0.5 = 4.6 → 0.23
    parts.narrative = round(narrativeStructures.reduce((s, n) => {
        const w = { late_peak_arc: 0.9, golden_final_5pct: 0.8, monotonic_rise: 0.7, nadir_before_climax: 0.6, callback_closure: 0.4, visceral_body_language: 0.7, fast_pacing_no_pauses: 0.5 }[n.id] || 0;
        return s + w * 0.05;
    }, 0), 4);
    // Duration (sweet_spot_46_60 weight 1.0 * 0.05 = 0.05)
    parts.duration = 0.05;
    // Vocabulary (engine caps at ~0.09 via +0.01 per matched word)
    parts.vocabulary = Math.min(0.09, vocab.usePositive.length * 0.01);
    // Motif-synthesis proxy (engine weight 0.15). Set 0.10 because we don't have
    // a full motif atom — the concept is externally authored.
    parts.motif = 0.10;
    // Proof-clarity (engine weight 0.14). Egg-survives-drop is a single-shot
    // physical reveal → treat as ~70% of the engine's typical maxed-out value.
    parts.proof = 0.10;
    // Visual-legibility (engine weight 0.16). Egg mid-fall at t=0 is maximally
    // legible → ~85% of the engine's typical mid-high.
    parts.legibility = 0.12;
    const total = round(Object.values(parts).reduce((a, b) => a + b, 0), 4);
    return {
        parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 4)])),
        total,
        calibration_note: 'Calibrated to engine scoreIdea scale (0.3-0.7 typical). Weights and component maxima inherited from viral-idea-engine.scoreIdea; not refit for this concept. Do not treat total as a probability.',
    };
}

function modeledViewBand(brief, designScore) {
    const scorecard = brief.evidence_lattice.scorecard_dimensions;
    if (!scorecard || !scorecard.view_bands_by_score || !scorecard.view_bands_by_score.length) {
        return { band_label: 'unavailable', note: 'video-scorecards lattice missing' };
    }
    const quintiles = scorecard.view_bands_by_score;
    const lo = quintiles[0].score_range[0];
    const hi = quintiles[quintiles.length - 1].score_range[1];
    const pct = Math.max(0, Math.min(1, (designScore - 0.40) / 0.20));
    const s10 = lo + pct * (hi - lo);
    let best = quintiles[0], bestDist = Infinity;
    for (const q of quintiles) {
        const center = (q.score_range[0] + q.score_range[1]) / 2;
        const dist = Math.abs(center - s10);
        if (dist < bestDist) { bestDist = dist; best = q; }
    }
    const full = brief.evidence_lattice.prediction_model_summary && brief.evidence_lattice.prediction_model_summary.full;
    const mult = (full && full.prediction_range_multiplier) || 2.5;
    const low = Math.round(best.views_p25 / mult);
    const high = Math.round(best.views_p75 * mult);
    const humanInt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(n);
    return {
        modeled_low: low,
        modeled_median: best.views_median,
        modeled_high: high,
        band_label: `${humanInt(low)} – ${humanInt(high)} views (median ${humanInt(best.views_median)})`,
        matched_quintile: best.score_quintile,
        full_model_cv_r2: full && full.cv_r2,
        note: `MODELED, not predicted. prediction-model CV r²=${full && full.cv_r2}. ~42% of variance is external (algorithm/timing/audience). Use as design-quality band only.`,
    };
}

// ---------- Main ----------
function run() {
    const { brief } = buildModel();
    const hookEval = scoreHookAgainstLattice(brief);
    const narrativeStructures = selectNarrativeStructures();
    const vocab = vocabularyForConcept(brief);
    const closing = pickClosingWord(brief);
    const beats = buildPostIntroBeats(brief, vocab, closing);
    const visualPrescription = buildVisualPrescription(brief);
    const scorecardTargets = buildScorecardTargets(brief);
    const riskFlags = buildRiskFlags(brief);
    const pacingPlan = buildPacingPlan(brief);
    const designScore = buildDesignScoreBreakdown(brief, narrativeStructures, vocab);
    const viewBand = modeledViewBand(brief, designScore.total);

    const blueprint = {
        tool: 'concept-blueprint.js',
        generated_at: new Date().toISOString(),
        brief_meta: {
            engine_version: brief.engine_version,
            headline_model_r2: brief.headline_model_r2,
            source_sizes: brief.source_sizes,
        },
        concept: CONCEPT,
        hook_evaluation: hookEval,
        narrative_structures: narrativeStructures,
        runtime_and_pacing: pacingPlan,
        vocabulary_plan: {
            use_positive: vocab.usePositive,
            avoid_from_corpus: vocab.avoidFromCorpus,
            avoid_heuristic_science_lexicon: vocab.avoidHeuristic,
            peak_phrases_available: brief.evidence_lattice.vocabulary.peak_phrases,
            drop_phrases_to_avoid: brief.evidence_lattice.vocabulary.drop_phrases,
            closing_word: closing,
        },
        visual_prescription: visualPrescription,
        beat_by_beat_blueprint: beats,
        scorecard_targets: scorecardTargets,
        risk_flags: riskFlags,
        design_score: designScore,
        modeled_view_band: viewBand,
        signals_and_files_used: [
            'retention-patterns.json :: BREAKTHROUGH_WAVE20.raw_retention_at_20s (r=0.60)',
            'retention-patterns.json :: top_5_retention_predictors (HOOK_PAYOFF_GAP, END_RECOVERY, MOMENTUM_ZONES, VIEWER_FATIGUE_SEVERITY, EVENT_DENSITY_INVERSE)',
            'retention-patterns.json :: top_3_retention_peak_causes + top_3_retention_drop_causes',
            'retention-patterns.json :: narrative_arc_analysis (best_arc=steady_rise 3.4M)',
            'retention-patterns.json :: wave11_12_new_signals.hook_taxonomy + key_phrases + end_begin_ratio + above_baseline_streak',
            'retention-patterns.json :: wave9_10.best_after_worst + worst_moment_timing + divergence_point',
            'retention-patterns.json :: design_rules_summary_v3 (all 15 rules)',
            'retention-patterns.json :: speaking_patterns.opening_density + pauses + peak/drop wps',
            'retention-patterns.json :: duration_insight.5s_buckets (50-55s=2.88M)',
            'retention-patterns.json :: vision_analysis_gpt4o_mini (peak/drop face/text/action occupancy)',
            'word-retention-impact.json :: top 20 positive and negative avg_ab with n>=5',
            'video-scorecards.json :: dimension_stats + view_bands_by_score',
            'mechanism_indicator_links.json :: frame_* ↔ (swipe_away_rate, avg_retention, log_views)',
            'prediction-model.json :: full_model cv_r2 + prediction_range_multiplier',
            'indicator-registry.json :: top pre-upload interaction rules',
            'findings-summary.json :: headline model history + kept_signals',
        ],
        honest_limits: [
            'This is NOT a view prediction. The full-model CV r² ≈ 0.58 and ~42% of variance is external (algorithm, audience, timing).',
            'The design_score is a composite over the same dimensions viral-idea-engine.scoreIdea uses, but adapted for externally-supplied concepts rather than hardcoded motif atoms.',
            'Several mappings (e.g., mystery-hook → +0.25 hook component) inherit their weights from engine heuristics. The weights themselves are not re-fit for this single concept; they are the engine\'s defaults.',
            'The concept-specific vocabulary filter assumes the lattice\'s word-retention-impact.json deltas generalize across topics. For a physics/experimentation video, the "solid" and "water" penalties are direct hits; other words (e.g., "non-Newtonian") are BELOW the n>=5 threshold and are added heuristically under the TECHNICAL_MATERIAL_LANGUAGE risk class.',
        ],
    };

    // Render: JSON then human-readable report
    process.stdout.write(JSON.stringify(blueprint, null, 2) + '\n');
    process.stderr.write('\n\n========== HUMAN-READABLE BLUEPRINT ==========\n');
    process.stderr.write(`CONCEPT: ${CONCEPT.id}\n`);
    process.stderr.write(`HOOK (given): ${CONCEPT.hook_line}\n`);
    process.stderr.write(`INTRO PROOF (given): ${CONCEPT.intro_visual_facts.join(' ')}\n`);
    process.stderr.write(`RUNTIME: ${pacingPlan.runtime_target_s}s (${pacingPlan.duration_evidence})\n`);
    process.stderr.write(`HOOK TYPE: ${hookEval.hook_type_inferred.kind} — ${hookEval.hook_type_inferred.evidence}\n`);
    process.stderr.write(`FIRST WORD "${hookEval.first_word}": ${hookEval.first_word_classification.note}\n\n`);
    process.stderr.write(`BEAT PLAN:\n`);
    for (const b of beats) {
        process.stderr.write(`  [${b.zone_pct}% | ${b.t_s}s] ${b.role}\n`);
        process.stderr.write(`    visual: ${b.visual}\n`);
        process.stderr.write(`    spoken: "${b.spoken}"\n`);
        process.stderr.write(`    pacing: ${b.pacing}\n`);
        process.stderr.write(`    evidence: ${b.evidence.map(e => '\n      - ' + e).join('')}\n\n`);
    }
    process.stderr.write(`VOCAB TO USE (from corpus positives): ${vocab.usePositive.map(w => `${w.word}(+${w.delta} n=${w.n})`).join(', ')}\n`);
    process.stderr.write(`VOCAB TO AVOID (from corpus negatives): ${vocab.avoidFromCorpus.map(w => `${w.word}(${w.delta} n=${w.n})`).join(', ')}\n`);
    process.stderr.write(`VOCAB TO AVOID (heuristic, TECHNICAL_MATERIAL_LANGUAGE class): ${vocab.avoidHeuristic.join(', ')}\n\n`);
    process.stderr.write(`SCORECARD TARGETS:\n`);
    for (const [k, v] of Object.entries(scorecardTargets)) {
        process.stderr.write(`  ${k}: target ${v.target} (${v.ambition}; corpus mean ${v.corpus_mean}, p75 ${v.corpus_p75}, p90 ${v.corpus_p90})\n`);
    }
    process.stderr.write(`\nRISK FLAGS:\n`);
    for (const f of riskFlags) {
        process.stderr.write(`  [${f.severity}] ${f.flag} — ${f.rule}\n`);
    }
    process.stderr.write(`\nDESIGN SCORE: ${designScore.total} → modeled view band: ${viewBand.band_label}\n`);
    process.stderr.write(`  ${viewBand.note}\n`);
    process.stderr.write('\n========== END ==========\n');

    return blueprint;
}

if (require.main === module) {
    run();
}

module.exports = { run, CONCEPT };
