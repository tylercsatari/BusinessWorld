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
    // Family: Group S — Social proof / curiosity gap / emotional peak / commitment device / proof of work / future self / failure vulnerability / action trigger
    'social_proof_count', 'social_proof_density',
    'social_proof_count_hook', 'social_proof_front_load_ratio',
    'curiosity_gap_count', 'curiosity_gap_density',
    'curiosity_gap_count_hook', 'curiosity_gap_front_load_ratio',
    'emotional_peak_count', 'emotional_peak_density',
    'emotional_peak_count_hook', 'emotional_peak_count_first_half',
    'commitment_device_count', 'commitment_device_density',
    'commitment_device_count_hook', 'commitment_device_count_first_quarter',
    'proof_of_work_count', 'proof_of_work_density',
    'proof_of_work_count_hook', 'proof_of_work_front_load_ratio',
    'future_self_count', 'future_self_density',
    'future_self_count_hook', 'future_self_count_first_half',
    'failure_vulnerability_count', 'failure_vulnerability_density',
    'failure_vulnerability_count_hook', 'failure_vulnerability_count_first_half',
    'action_trigger_count', 'action_trigger_density',
    'action_trigger_count_hook', 'action_trigger_count_last_quarter',
    // Group S scalar/derived indicators
    'loop_resolution_ratio', 'promise_density_first_third',
    'emotional_arc_peak_pct', 'curiosity_resolution_gap_pct',
    'hook_phrase_diversity', 'social_proof_before_midpoint_count',
    'proof_of_work_before_claim_ratio',
    // Group T: Reference callback / visual credibility / payoff signal / setup signal / stakes escalation / proof arrival / narrative anchor / delayed reveal
    'reference_callback_count', 'reference_callback_density',
    'reference_callback_count_hook', 'reference_callback_front_load_ratio',
    'visual_credibility_count', 'visual_credibility_density',
    'visual_credibility_count_hook', 'visual_credibility_front_load_ratio',
    'payoff_signal_count', 'payoff_signal_density',
    'payoff_signal_count_hook', 'payoff_signal_count_last_quarter',
    'setup_signal_count', 'setup_signal_density',
    'setup_signal_count_hook', 'setup_signal_front_load_ratio',
    'stakes_escalation_count', 'stakes_escalation_density',
    'stakes_escalation_count_mid', 'stakes_escalation_count_first_half',
    'proof_arrival_count', 'proof_arrival_density',
    'proof_arrival_count_hook', 'proof_arrival_position_pct',
    'narrative_anchor_count', 'narrative_anchor_density',
    'narrative_anchor_count_first_half', 'narrative_anchor_count_last_quarter',
    'delayed_reveal_count', 'delayed_reveal_density',
    'delayed_reveal_count_hook', 'delayed_reveal_front_load_ratio',
    'setup_to_payoff_signal_gap_pct',
    'proof_arrival_timing_pct',
    'delayed_reveal_to_payoff_ratio',
    'visual_credibility_before_claim_ratio',
    'reference_callback_rate_per_min',
    'stakes_escalation_mid_density',
    'narrative_anchor_peak_pct',
    'delayed_reveal_setup_ratio',
    // Group U: Cliffhanger / payoff-tease / stakes-reinforcement / viewer-agency / revelation-signal / curiosity-escalation
    'cliffhanger_count', 'cliffhanger_density',
    'cliffhanger_first_half_count', 'cliffhanger_hook_count',
    'payoff_tease_count', 'payoff_tease_density',
    'payoff_tease_first_half_count', 'payoff_tease_hook_count',
    'stakes_reinforcement_count', 'stakes_reinforcement_density',
    'stakes_reinforcement_first_half_count', 'stakes_reinforcement_hook_count',
    'viewer_agency_count', 'viewer_agency_density',
    'viewer_agency_first_half_count', 'viewer_agency_hook_count',
    'revelation_signal_count', 'revelation_signal_density',
    'revelation_signal_first_half_count', 'revelation_signal_hook_count',
    'curiosity_escalation_count', 'curiosity_escalation_density',
    'curiosity_escalation_first_half_count', 'curiosity_escalation_hook_count',
    // Group W: Zygarnik gradient / ref-to-gratification / proof-closure / credibility / story-stake
    'zygarnik_gradient_pct',
    'zygarnik_front_load_ratio',
    'loop_to_closure_gap_s',
    'ref_to_gratification_gap_pct',
    'gratification_density_first_quarter',
    'pre_payoff_tension_index',
    'early_proof_to_loop_ratio',
    'proof_arrival_delay_proxy',
    'closure_to_open_ratio_first10s',
    'credibility_setup_pct',
    'proof_density_hook',
    'visual_credibility_density_hook',
    'stakes_to_loop_ratio',
    'stake_loop_product',
    'consequence_front_weight',
    // Group X: Narrative tension arc / promise-echo / story-clock / proof-build
    'tension_ratchet_count', 'tension_ratchet_density',
    'tension_ratchet_count_first5s', 'tension_ratchet_count_first10s',
    'tension_ratchet_hook_count',
    'promise_echo_count', 'promise_echo_density',
    'promise_echo_second_half_count',
    'story_clock_count', 'story_clock_density',
    'story_clock_count_first10s', 'story_clock_count_first5s',
    'proof_build_count', 'proof_build_density',
    'proof_build_count_first_half', 'proof_build_count_first5s',
    // Group AA: Zygarnik structural phrase families (tension_builder / implicit_promise /
    //            progressive_reveal / loop_reinforcer / consequence_language / setup_anchor /
    //            outcome_tease / proof_signal / challenge_statement / narrative_tension)
    'tension_builder_count', 'tension_builder_density',
    'tension_builder_count_first5s', 'tension_builder_count_first10s',
    'tension_builder_count_first15s', 'tension_builder_count_first20s',
    'tension_builder_density_first5s', 'tension_builder_density_first10s',
    'tension_builder_count_hook', 'tension_builder_front_load_ratio',
    'implicit_promise_count', 'implicit_promise_density',
    'implicit_promise_count_first5s', 'implicit_promise_count_first10s',
    'implicit_promise_count_first15s', 'implicit_promise_count_first20s',
    'implicit_promise_density_first5s', 'implicit_promise_density_first10s',
    'implicit_promise_count_hook', 'implicit_promise_front_load_ratio',
    'progressive_reveal_count', 'progressive_reveal_density',
    'progressive_reveal_count_first5s', 'progressive_reveal_count_first10s',
    'progressive_reveal_count_first20s', 'progressive_reveal_count_hook',
    'loop_reinforcer_count', 'loop_reinforcer_density',
    'loop_reinforcer_count_first5s', 'loop_reinforcer_count_first10s',
    'loop_reinforcer_count_first15s', 'loop_reinforcer_count_hook',
    'consequence_language_count', 'consequence_language_density',
    'consequence_language_count_first5s', 'consequence_language_count_first10s',
    'consequence_language_count_first15s', 'consequence_language_density_first10s',
    'consequence_language_count_hook', 'consequence_language_front_load_ratio',
    'setup_anchor_count', 'setup_anchor_density',
    'setup_anchor_count_first5s', 'setup_anchor_count_first10s',
    'setup_anchor_count_first15s', 'setup_anchor_count_hook',
    'outcome_tease_count', 'outcome_tease_density',
    'outcome_tease_count_first5s', 'outcome_tease_count_first10s',
    'outcome_tease_count_first15s', 'outcome_tease_density_first10s',
    'outcome_tease_count_hook', 'outcome_tease_front_load_ratio',
    'proof_signal_count', 'proof_signal_density',
    'proof_signal_count_first5s', 'proof_signal_count_first10s',
    'proof_signal_count_first15s', 'proof_signal_count_first20s',
    'proof_signal_density_first5s', 'proof_signal_density_first10s',
    'proof_signal_count_hook', 'proof_signal_front_load_ratio',
    'challenge_statement_count', 'challenge_statement_density',
    'challenge_statement_count_first5s', 'challenge_statement_count_first10s',
    'challenge_statement_count_hook', 'challenge_statement_front_load_ratio',
    'narrative_tension_count', 'narrative_tension_density',
    'narrative_tension_count_first5s', 'narrative_tension_count_first10s',
    'narrative_tension_count_hook', 'narrative_tension_front_load_ratio',
    // Group AB: Expectation-subversion / Knowledge-gap / Momentum / Suspense-bridge
    'expectation_subversion_count', 'expectation_subversion_density',
    'expectation_subversion_count_first5s', 'expectation_subversion_count_first10s',
    'expectation_subversion_count_first15s', 'expectation_subversion_count_hook',
    'expectation_subversion_front_load_ratio', 'expectation_subversion_count_first_half',
    'knowledge_gap_count', 'knowledge_gap_density',
    'knowledge_gap_count_first5s', 'knowledge_gap_count_first10s',
    'knowledge_gap_count_first15s', 'knowledge_gap_count_hook',
    'knowledge_gap_front_load_ratio', 'knowledge_gap_count_first_half',
    'momentum_language_count', 'momentum_language_density',
    'momentum_language_count_first5s', 'momentum_language_count_first10s',
    'momentum_language_count_first15s', 'momentum_language_count_hook',
    'momentum_language_front_load_ratio',
    'suspense_bridge_count', 'suspense_bridge_density',
    'suspense_bridge_count_first5s', 'suspense_bridge_count_first10s',
    'suspense_bridge_count_first15s', 'suspense_bridge_count_hook',
    'suspense_bridge_front_load_ratio', 'suspense_bridge_count_first_half',
    // Group AC: Identity-challenge / Before-after-frame / FOMO / Mechanism-reveal
    'identity_challenge_count', 'identity_challenge_density',
    'identity_challenge_count_first5s', 'identity_challenge_count_first10s',
    'identity_challenge_count_first15s', 'identity_challenge_count_hook',
    'identity_challenge_front_load_ratio', 'identity_challenge_count_first_half',
    'before_after_frame_count', 'before_after_frame_density',
    'before_after_frame_count_first5s', 'before_after_frame_count_first10s',
    'before_after_frame_count_first15s', 'before_after_frame_count_hook',
    'before_after_frame_front_load_ratio',
    'fomo_signal_count', 'fomo_signal_density',
    'fomo_signal_count_first5s', 'fomo_signal_count_first10s',
    'fomo_signal_count_first15s', 'fomo_signal_count_hook',
    'fomo_signal_front_load_ratio', 'fomo_signal_count_first_half',
    'mechanism_reveal_count', 'mechanism_reveal_density',
    'mechanism_reveal_count_first5s', 'mechanism_reveal_count_first10s',
    'mechanism_reveal_count_first15s', 'mechanism_reveal_count_hook',
    'mechanism_reveal_front_load_ratio', 'mechanism_reveal_count_first_half',
    // Group AD: Authority-stack / Narrative-stakes-escalation / Payoff-proximity
    'authority_stack_count', 'authority_stack_density',
    'authority_stack_count_first5s', 'authority_stack_count_first10s',
    'authority_stack_count_first15s', 'authority_stack_count_hook',
    'authority_stack_front_load_ratio',
    'narrative_stakes_escalation_count', 'narrative_stakes_escalation_density',
    'narrative_stakes_escalation_count_first5s', 'narrative_stakes_escalation_count_first10s',
    'narrative_stakes_escalation_count_hook', 'narrative_stakes_escalation_front_load_ratio',
    'narrative_stakes_escalation_count_first_half',
    'payoff_proximity_count', 'payoff_proximity_density',
    'payoff_proximity_count_first5s', 'payoff_proximity_count_first10s',
    'payoff_proximity_count_first15s', 'payoff_proximity_count_hook',
    'payoff_proximity_front_load_ratio', 'payoff_proximity_count_first_half',
    // Group AE: Extended zygarnik/open-loop/pre-upload variants now backed by _zyExtRe dispatch
    // All ZYGARNIK_PHRASE_SETS families — hook/ratio/first_half/position_pct variants
    'open_loop_count_hook', 'open_loop_front_load_ratio', 'open_loop_count_first_half', 'open_loop_position_pct',
    'closure_count_hook', 'closure_front_load_ratio', 'closure_count_first_half', 'closure_position_pct',
    'delayed_gratification_count_hook', 'delayed_gratification_front_load_ratio',
    'delayed_gratification_count_first_half', 'delayed_gratification_position_pct',
    'story_stake_count_hook', 'story_stake_front_load_ratio',
    'story_stake_count_first_half', 'story_stake_position_pct',
    'foreshadow_count_hook', 'foreshadow_front_load_ratio', 'foreshadow_count_first_half',
    'stakes_high_count_hook', 'stakes_high_front_load_ratio', 'stakes_high_count_first_half',
    'credibility_signal_count_hook', 'credibility_signal_front_load_ratio',
    'credibility_signal_count_first_half', 'credibility_signal_position_pct',
    'reward_language_count_hook', 'reward_language_front_load_ratio', 'reward_language_count_first_half',
    'urgency_count_hook', 'urgency_front_load_ratio', 'urgency_count_first_half',
    'loss_aversion_count_hook', 'loss_aversion_front_load_ratio', 'loss_aversion_count_first_half',
    'tension_ratchet_count_hook', 'tension_ratchet_front_load_ratio', 'tension_ratchet_count_first_half',
    'proof_build_count_hook', 'proof_build_front_load_ratio', 'proof_build_count_first_half',
    'story_clock_count_hook', 'story_clock_front_load_ratio', 'story_clock_count_first_half',
    'promise_echo_count_hook', 'promise_echo_front_load_ratio', 'promise_echo_count_first_half',
    'vulnerability_count_hook', 'vulnerability_front_load_ratio', 'vulnerability_count_first_half',
    'transformation_count_hook', 'transformation_front_load_ratio', 'transformation_count_first_half',
    'specificity_anchor_count_hook', 'specificity_anchor_front_load_ratio',
    'social_contrast_count_hook', 'social_contrast_front_load_ratio', 'social_contrast_count_first_half',
    'anticipatory_build_count_hook', 'anticipatory_build_front_load_ratio',
    'pattern_interrupt_count_hook', 'pattern_interrupt_front_load_ratio',
    'scarcity_count_hook', 'scarcity_front_load_ratio', 'scarcity_count_first_half',
    'identity_hook_count_hook', 'identity_hook_front_load_ratio',
    'suspense_count_hook', 'suspense_front_load_ratio', 'suspense_count_first_half',
    'outcome_ref_count_hook', 'outcome_ref_front_load_ratio',
    'unresolved_ref_count_hook', 'unresolved_ref_front_load_ratio', 'unresolved_ref_count_first_half',
    'temporal_anticipation_count_hook', 'temporal_anticipation_front_load_ratio',
    'micro_commitment_count_hook', 'micro_commitment_front_load_ratio', 'micro_commitment_count_first_half',
    'revelation_pace_count_hook', 'revelation_pace_front_load_ratio',
    'social_proof_count_hook', 'social_proof_front_load_ratio',
    'reference_callback_count_hook', 'reference_callback_front_load_ratio',
    'visual_proof_count_hook', 'visual_proof_front_load_ratio', 'visual_proof_count_first_half',
    // Group AH: New zygarnik phrase families
    'teaser_signal_count_hook', 'teaser_signal_front_load_ratio', 'teaser_signal_count_first_half', 'teaser_signal_position_pct',
    'anticipation_escalation_count_hook', 'anticipation_escalation_front_load_ratio', 'anticipation_escalation_count_first_half', 'anticipation_escalation_position_pct',
    'proof_delay_count_hook', 'proof_delay_front_load_ratio', 'proof_delay_count_first_half', 'proof_delay_position_pct',
    'open_question_setup_count_hook', 'open_question_setup_front_load_ratio', 'open_question_setup_count_first_half', 'open_question_setup_position_pct',
    'visual_anchor_count_hook', 'visual_anchor_front_load_ratio', 'visual_anchor_count_first_half', 'visual_anchor_position_pct',
];

// Windowed variants for count/density families
const windowedFamilies = [
    ['visual_proof_phrase', ['count', 'density']],
    ['credential_signal',   ['count', 'density']],
    ['consequence',         ['density']],
    ['personal_stake',      ['density']],
    ['micro_reward',        ['density']],
    // Group S windowed families
    ['social_proof',           ['count', 'density']],
    ['curiosity_gap',          ['count', 'density']],
    ['emotional_peak',         ['count', 'density']],
    ['proof_of_work',          ['count', 'density']],
    ['failure_vulnerability',  ['count', 'density']],
    // Group T windowed families
    ['reference_callback',  ['count', 'density']],
    ['visual_credibility',  ['count', 'density']],
    ['payoff_signal',       ['count', 'density']],
    ['setup_signal',        ['count', 'density']],
    ['stakes_escalation',   ['count', 'density']],
    ['proof_arrival',       ['count', 'density']],
    ['narrative_anchor',    ['count', 'density']],
    ['delayed_reveal',      ['count', 'density']],
    // Group X windowed families
    ['tension_ratchet',     ['count', 'density']],
    ['promise_echo',        ['count', 'density']],
    ['story_clock',         ['count', 'density']],
    ['proof_build',         ['count', 'density']],
    // Group AA windowed families
    ['tension_builder',           ['count', 'density']],
    ['implicit_promise',          ['count', 'density']],
    ['progressive_reveal',        ['count']],
    ['loop_reinforcer',           ['count', 'density']],
    ['consequence_language',      ['count', 'density']],
    ['setup_anchor',              ['count']],
    ['outcome_tease',             ['count', 'density']],
    ['proof_signal',              ['count', 'density']],
    ['challenge_statement',       ['count', 'density']],
    ['narrative_tension',         ['count', 'density']],
    // Group AB windowed families
    ['expectation_subversion',    ['count', 'density']],
    ['knowledge_gap',             ['count', 'density']],
    ['momentum_language',         ['count']],
    ['suspense_bridge',           ['count', 'density']],
    // Group AC windowed families
    ['identity_challenge',        ['count', 'density']],
    ['before_after_frame',        ['count']],
    ['fomo_signal',               ['count', 'density']],
    ['mechanism_reveal',          ['count', 'density']],
    // Group AD windowed families
    ['authority_stack',           ['count', 'density']],
    ['narrative_stakes_escalation', ['count', 'density']],
    ['payoff_proximity',          ['count', 'density']],
    // Group AE: new loop stacking / deferred reveal families
    ['loop_stacking',             ['count', 'density']],
    ['deferred_reveal',           ['count', 'density']],
    // Group AH windowed families
    ['teaser_signal',             ['count', 'density']],
    ['anticipation_escalation',   ['count', 'density']],
    ['proof_delay',               ['count', 'density']],
    ['open_question_setup',       ['count', 'density']],
    ['visual_anchor',             ['count', 'density']],
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
    'reference_callback_count', 'reference_callback_density',
    'reference_callback_front_load_ratio',
    'visual_credibility_count', 'visual_credibility_density',
    'payoff_signal_count', 'payoff_signal_count_last_quarter',
    'setup_signal_count', 'setup_signal_front_load_ratio',
    'stakes_escalation_count', 'delayed_reveal_count',
    'proof_arrival_count', 'narrative_anchor_count',
    'gratification_delay_pct', 'promise_proof_gap_pct', 'closure_count',
    'withheld_outcome_flag', 'setup_duration_pct', 'hook_tension_ratio',
    'hook_open_loop_density', 'open_loop_density', 'hook_drop_rate',
    'hook_retention_pct', 'non_sub_view_share', 'like_rate', 'share_rate',
    'comment_rate', 'retention_75pct', 'retention_90pct',
    'retention_pct_10', 'subs_gained_per_view',
    // New high-signal bases from Groups R/S/T/U
    'rhetorical_question_count', 'social_comparison_count', 'mystery_setup_count',
    'viewer_stakes_count', 'social_proof_count', 'curiosity_gap_count',
    'proof_of_work_count', 'failure_vulnerability_count',
    'payoff_signal_count', 'stakes_escalation_count', 'delayed_reveal_count',
    'cliffhanger_count', 'payoff_tease_count', 'revelation_signal_count',
    'curiosity_escalation_count',
    // Group X high-signal bases
    'tension_ratchet_count', 'promise_echo_count', 'story_clock_count', 'proof_build_count',
    // Group AA high-signal bases (structural Zygarnik families)
    'tension_builder_count', 'tension_builder_density',
    'implicit_promise_count', 'implicit_promise_density',
    'loop_reinforcer_count', 'consequence_language_count',
    'outcome_tease_count', 'proof_signal_count',
    'challenge_statement_count', 'narrative_tension_count',
    // Group AB/AC/AD high-signal bases (best candidates once computed)
    'expectation_subversion_count', 'knowledge_gap_count',
    'suspense_bridge_count', 'identity_challenge_count',
    'mechanism_reveal_count', 'payoff_proximity_count',
    'narrative_stakes_escalation_count',
    // Group AE: new families (loop_stacking / deferred_reveal)
    'loop_stacking_count_hook', 'loop_stacking_front_load_ratio',
    'loop_stacking_count', 'loop_stacking_density',
    'deferred_reveal_count_hook', 'deferred_reveal_front_load_ratio',
    'deferred_reveal_count', 'deferred_reveal_density',
    // Group AF: extended zygarnik hook/ratio variants — top pre-upload focus
    'open_loop_count_hook', 'open_loop_front_load_ratio',
    'delayed_gratification_count_hook', 'delayed_gratification_front_load_ratio',
    'story_stake_count_hook', 'story_stake_front_load_ratio',
    'credibility_signal_count_hook', 'credibility_signal_front_load_ratio',
    'foreshadow_count_hook', 'foreshadow_front_load_ratio',
    'tension_ratchet_count_hook', 'tension_ratchet_front_load_ratio',
    'proof_build_count_hook', 'proof_build_front_load_ratio',
    'vulnerability_count_hook', 'vulnerability_front_load_ratio',
    'stakes_high_count_hook', 'stakes_high_front_load_ratio',
    'reward_language_count_hook', 'reward_language_front_load_ratio',
];

// Excluded keys — always return null
const EXCLUDED = new Set([
    'emotional_peak_position_pct', 'revelation_pace_score',
    'climax_position_pct', 'hook_to_climax_gap_s',
    'transformation_density_hook', 'vulnerability_density_hook',
    'specificity_anchor_density_hook', 'micro_commitment_density_hook',
    'emotional_peak_density_first_quarter', 'emotional_peak_density_last_quarter',
    'revelation_pace_density_mid', 'social_contrast_density_hook',
    'anticipatory_build_density_hook',
]);

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
