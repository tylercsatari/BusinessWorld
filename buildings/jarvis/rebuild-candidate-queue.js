'use strict';
/**
 * rebuild-candidate-queue.js
 *
 * Repopulates candidate_queue.json with:
 *   1. Pre-upload atomics: new Group P indicators not yet in indicators.json
 *   2. Post-upload composites: new atomics × high-signal existing indicators
 *
 * Excluded composites: anything containing emotional_peak_position_pct or
 * revelation_pace_score (these always return null — no segment data).
 */

const fs   = require('fs');
const path = require('path');

const DIR = path.join(__dirname);

// ── Load existing computed keys ──────────────────────────────────────────
const existingKeys = new Set();

const indicators = JSON.parse(fs.readFileSync(path.join(DIR, 'indicators.json'), 'utf8'));
for (const item of indicators) {
    const k = typeof item === 'string' ? item : item.key;
    if (k) existingKeys.add(k);
}

try {
    const derived = JSON.parse(fs.readFileSync(path.join(DIR, 'derived_experiments.json'), 'utf8'));
    for (const item of derived) {
        const k = typeof item === 'string' ? item : item.key;
        if (k) existingKeys.add(k);
    }
} catch (e) {
    console.log('Note: derived_experiments.json not found or unreadable, skipping.');
}

// ── Define all new atomic keys (Groups P + Q) ───────────────────────────
const ZYGARNIK_EARLY_WINDOWS = [2, 3, 5, 8, 10, 15, 20];

const baseAtomics = [
    // Family 1: Zygarnik depth
    'zygarnik_buildup_ratio',
    'unresolved_loop_count',
    'zygarnik_score',
    'loop_density_acceleration',
    // Family 2: Pre-proof tension
    'proof_withheld_duration_pct',
    'setup_density_first_third',
    'payoff_density_last_third',
    'setup_to_payoff_ratio',
    'pre_proof_tension_score',
    // Family 3: Visual credibility
    'visual_proof_phrase_count',
    'visual_proof_phrase_density',
    'credential_signal_count',
    'credential_signal_density',
    // Family 4: Story stake / consequence
    'consequence_density',
    'consequence_density_first_half',
    'personal_stake_density',
    'personal_stake_density_first10s',
    'stakes_early_flag',
    'consequence_front_load_ratio',
    // Family 5: Closure gap
    'first_payoff_position_pct',
    'hook_to_payoff_gap_pct',
    'pre_closure_open_loop_count',
    'closure_gap_pct',
    // Family 6: Micro-reward
    'micro_reward_density',
    'micro_reward_density_first_quarter',
    'information_drip_ratio',
    'early_engagement_density',
    'mid_filler_density',
    'closing_hook_density',
    // Family 7: Title
    'title_open_loop_count',
    // Group Q1: Anticipation language
    'anticipation_phrase_count',
    'anticipation_phrase_density',
    'anticipation_phrase_count_first10s',
    'anticipation_front_load_ratio',
    // Group Q2: Counterintuitive/reveal signals
    'counterintuitive_count',
    'counterintuitive_density',
    'counterintuitive_count_first_half',
    'counterintuitive_count_first10s',
    // Group Q3: Confession/vulnerability signals
    'confession_signal_count',
    'confession_signal_density',
    'confession_first_half_count',
    'confession_hook_count',
    // Group Q4: Escalation language
    'escalation_phrase_count',
    'escalation_phrase_density',
    'escalation_count_first_third',
    'escalation_count_mid_third',
    // Group Q5: Specificity markers
    'numeric_specificity_count',
    'numeric_specificity_density',
    'numeric_specificity_first_half',
    'specificity_phrase_count',
    'specificity_phrase_density',
    // Group Q6: Narrative callback signals
    'callback_count',
    'callback_density',
    'callback_second_half_count',
    'callback_last_third_count',
    // Group Q7: Urgency/FOMO signals
    'urgency_signal_count',
    'urgency_signal_density',
    'urgency_count_first_quarter',
    'urgency_count_last_quarter',
    'urgency_front_load_ratio',
    // Family: Group R — Psychographic / Persuasion indicators
    'rhetorical_question_count', 'rhetorical_question_density',
    'rhetorical_question_count_hook', 'rhetorical_question_front_load_ratio',
    'social_comparison_count', 'social_comparison_density',
    'social_comparison_count_first_half', 'social_comparison_hook_count',
    'transformation_arc_count', 'transformation_arc_density',
    'transformation_arc_count_first_half', 'transformation_arc_hook_count',
    'loss_framing_count', 'loss_framing_density',
    'loss_framing_count_hook', 'loss_framing_count_first_half',
    'mystery_setup_count', 'mystery_setup_density',
    'mystery_setup_count_hook', 'mystery_setup_front_load_ratio',
    'promise_specificity_count', 'promise_specificity_density',
    'promise_specificity_count_hook', 'promise_specificity_front_load_ratio',
    'pattern_interrupt_count', 'pattern_interrupt_density',
    'pattern_interrupt_count_hook', 'pattern_interrupt_count_first_half',
    'viewer_stakes_count', 'viewer_stakes_density',
    'viewer_stakes_count_hook', 'viewer_stakes_front_load_ratio',
];

// Windowed variants for count/density families
const windowedFamilies = [
    ['visual_proof_phrase', ['count', 'density']],
    ['credential_signal',   ['count', 'density']],
    ['consequence',         ['density']],
    ['personal_stake',      ['density']],
    ['micro_reward',        ['density']],
];
const windowedAtomics = [];
for (const [fam, measures] of windowedFamilies) {
    for (const measure of measures) {
        for (const w of ZYGARNIK_EARLY_WINDOWS) {
            windowedAtomics.push(`${fam}_${measure}_first${w}s`);
        }
    }
}
// unresolved_loop_count windowed
for (const w of ZYGARNIK_EARLY_WINDOWS) {
    windowedAtomics.push(`unresolved_loop_count_first${w}s`);
}

const allNewAtomics = [...baseAtomics, ...windowedAtomics];

// ── High-signal existing indicators for cross-composite generation ────────
const HIGH_SIGNAL_BASES = [
    'open_loop_count', 'dangling_question_ratio', 'hook_payoff_gap',
    'gratification_delay_pct', 'promise_proof_gap_pct', 'closure_count',
    'withheld_outcome_flag', 'setup_duration_pct', 'hook_tension_ratio',
    'hook_open_loop_density', 'open_loop_density', 'hook_drop_rate',
    'hook_retention_pct', 'non_sub_view_share', 'like_rate', 'share_rate',
    'comment_rate', 'retention_75pct', 'retention_90pct',
    'retention_pct_10', 'subs_gained_per_view',
];

// Excluded keys — always return null
const EXCLUDED = new Set(['emotional_peak_position_pct', 'revelation_pace_score']);

// ── Build pre-upload pool ────────────────────────────────────────────────
const preUpload = allNewAtomics.filter(k => !existingKeys.has(k));

// ── Build post-upload composite pool ────────────────────────────────────
const postUpload = [];
const seenComposites = new Set();

for (const newKey of allNewAtomics) {
    if (EXCLUDED.has(newKey)) continue;
    for (const base of HIGH_SIGNAL_BASES) {
        if (EXCLUDED.has(base)) continue;
        // Both orderings
        for (const [a, b] of [[newKey, base], [base, newKey]]) {
            if (a === b) continue;
            const compositeKey = `${a}_x_${b}`;
            if (seenComposites.has(compositeKey)) continue;
            if (existingKeys.has(compositeKey)) continue;
            // Skip if either component contains an excluded key
            if (EXCLUDED.has(a) || EXCLUDED.has(b)) continue;
            seenComposites.add(compositeKey);
            postUpload.push(compositeKey);
        }
    }
}

// ── Deduplicate and combine ──────────────────────────────────────────────
const allNew = [...new Set([...preUpload, ...postUpload])];

// Final sanity filter: remove anything already computed
const finalQueue = allNew.filter(k => !existingKeys.has(k));

// ── Write output ─────────────────────────────────────────────────────────
fs.writeFileSync(
    path.join(DIR, 'candidate_queue.json'),
    JSON.stringify(finalQueue, null, 2),
    'utf8'
);

console.log(`Pre-upload new atomics:    ${preUpload.length}`);
console.log(`Post-upload composites:    ${postUpload.length}`);
console.log(`Total (deduplicated):      ${finalQueue.length}`);
