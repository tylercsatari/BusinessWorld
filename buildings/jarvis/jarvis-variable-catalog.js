/**
 * jarvis-variable-catalog.js
 *
 * A reusable, pattern-based catalog that tells you, for any variable key used
 * in the Jarvis indicator registry or derived-experiment graph:
 *
 *   - plain-English description   (what the variable represents)
 *   - measurement/formula         (exactly how the number is produced)
 *   - modality                    (transcript / retention curve / metadata / derived)
 *   - quantification style        (count, density, hook slice, first-N-sec window,
 *                                  front-load ratio, retention window, view-ratio,
 *                                  interaction product, …)
 *   - source fields               (which inputs are read from the raw data blob)
 *   - phrase family / evidence    (for phrase-based metrics: the family name plus
 *                                  5 example phrases so you can eyeball what counts)
 *
 * Consumed by server.js (to enrich API responses) and jarvis-ui.js (to render
 * experiment cards + a browsable variables catalog). Works in both CommonJS
 * and browser contexts.
 *
 * Design note: the dispatcher is *pattern based*, not a hand-coded switch per
 * metric. Add a new phrase family or a new window type and every derived key
 * that uses it becomes self-describing for free.
 */
'use strict';

// ── Phrase-family directory ──────────────────────────────────────────────
// Each entry documents one named phrase list referenced by jarvis-metrics.js.
// `examples` are first-5 phrases copied by hand so the catalog can travel
// without re-requiring the full metrics module.
const PHRASE_FAMILIES = {
    proof_of_work: {
        const_name: 'PROOF_OF_WORK_PHRASES',
        description: 'Statements of invested effort / "skin in the game" — admissions that the creator personally spent time, money, or repetitions before arriving at the claim.',
        signal: 'Creator credibility via proof of work',
        examples: ['i tested', "i've tested", 'i tried', 'i spent', 'after years'],
    },
    future_self: {
        const_name: 'FUTURE_SELF_PHRASES',
        description: 'Imagery about the viewer\'s future state / transformed version of themselves.',
        signal: 'Aspirational identity framing',
        examples: ['you will be', "you'll be able to", "you'll finally", 'imagine yourself', 'your future'],
    },
    failure_vulnerability: {
        const_name: 'FAILURE_VULNERABILITY_PHRASES',
        description: 'Admissions of failure, struggle, or lack of knowledge from the creator.',
        signal: 'Parasocial trust via vulnerability',
        examples: ['i failed', "i've failed", 'my biggest failure', 'i was wrong', 'i made a mistake'],
    },
    action_trigger: {
        const_name: 'ACTION_TRIGGER_PHRASES',
        description: 'Direct calls-to-action and urgency language that push the viewer to act now.',
        signal: 'Conversion / CTA pressure',
        examples: ['right now', 'do this now', 'start today', 'take action', 'limited time'],
    },
    reference_callback: {
        const_name: 'REFERENCE_CALLBACK_PHRASES',
        description: 'Backward references to something said earlier in the same video.',
        signal: 'Long-arc coherence / promise-payoff stitching',
        examples: ['remember when i said', 'as i mentioned', 'going back to', 'earlier i showed', 'i told you'],
    },
    visual_credibility: {
        const_name: 'VISUAL_CREDIBILITY_PHRASES',
        description: 'Language that directs the viewer\'s eye to on-screen proof: charts, screenshots, before/after.',
        signal: 'Visual authority / "show, don\'t tell"',
        examples: ['look at this', 'you can see', 'notice how', 'watch what happens', 'look at the screen'],
    },
    payoff_signal: {
        const_name: 'PAYOFF_SIGNAL_PHRASES',
        description: 'Phrases that announce the answer / reveal / conclusion arriving.',
        signal: 'Open-loop closure',
        examples: ['here is the result', 'and the answer is', 'here it is', 'that is the secret', 'turns out'],
    },
    setup_signal: {
        const_name: 'SETUP_SIGNAL_PHRASES',
        description: 'Phrases that frame what the viewer is about to see — explicit problem statements / content promises.',
        signal: 'Up-front promise contracts',
        examples: ['in this video i will', 'today i will show', 'by the end of this video', 'i am going to prove', 'let me show you exactly'],
    },
    // Zygarnik phrase-set families (ZYGARNIK_PHRASE_SETS keys in jarvis-metrics.js)
    open_loop: {
        const_name: 'ZYGARNIK_PHRASE_SETS.open_loop',
        description: 'Unanswered questions / experiments that the viewer will stay to see resolved.',
        signal: 'Zeigarnik open-loop',
        examples: ['what if', 'i wonder', "let's see", 'will it', 'to find out'],
    },
    closure: {
        const_name: 'ZYGARNIK_PHRASE_SETS.closure',
        description: 'Resolution language: the open loop is being closed.',
        signal: 'Zeigarnik closure',
        examples: ['it works', 'it worked', 'i did it', 'the result is', 'turned out'],
    },
    unresolved_ref: {
        const_name: 'ZYGARNIK_PHRASE_SETS.unresolved_ref',
        description: 'Demonstratives pointing at something unspecified the viewer must keep watching to identify.',
        signal: 'Deictic curiosity',
        examples: ['this thing', 'check this', 'watch this', 'look at this', 'what happens'],
    },
    temporal_anticipation: {
        const_name: 'ZYGARNIK_PHRASE_SETS.temporal_anticipation',
        description: 'Near-future-tense framing ("about to", "in a second") that pushes the payoff imminent.',
        signal: 'Imminence framing',
        examples: ['about to', 'going to', 'gonna', 'ready to', 'in a second'],
    },
    contrast: {
        const_name: 'ZYGARNIK_PHRASE_SETS.contrast',
        description: 'Pivots that flip the expectation: but, however, instead, plot twist.',
        signal: 'Expectation reversal',
        examples: ['but', 'however', 'instead', 'plot twist', 'surprisingly'],
    },
    superlative: {
        const_name: 'ZYGARNIK_PHRASE_SETS.superlative',
        description: 'Extreme claims: most, best, worst, biggest, ever, impossible.',
        signal: 'Claim escalation',
        examples: ['most', 'best', 'worst', 'biggest', 'ever'],
    },
    sensory: {
        const_name: 'ZYGARNIK_PHRASE_SETS.sensory',
        description: 'Sensory imperatives — look / watch / feel / taste — directing the viewer\'s perception.',
        signal: 'Sensory engagement',
        examples: ['look', 'watch', 'see', 'feel', 'notice'],
    },
    imperative: {
        const_name: 'ZYGARNIK_PHRASE_SETS.imperative',
        description: 'Attention-directing imperatives — stay, wait, pay attention.',
        signal: 'Attention anchoring',
        examples: ["let's", 'check out', 'wait', 'stay tuned', 'pay attention'],
    },
    social_proof: {
        const_name: 'ZYGARNIK_PHRASE_SETS.social_proof',
        description: 'Crowd / authority citations: millions, studies show, experts say.',
        signal: 'Authority borrowing',
        examples: ['millions of', 'studies show', 'research shows', 'experts say', 'proven'],
    },
    scarcity: {
        const_name: 'ZYGARNIK_PHRASE_SETS.scarcity',
        description: 'Limited-availability framing.',
        signal: 'Scarcity pressure',
        examples: ['limited time', 'running out', 'last chance', 'rare', 'exclusive'],
    },
    stakes_high: {
        const_name: 'ZYGARNIK_PHRASE_SETS.stakes_high',
        description: 'High-stakes framing — life-changing, all-or-nothing, point of no return.',
        signal: 'Stakes elevation',
        examples: ['everything changes', 'life changing', 'never be the same', 'all or nothing', 'game changer'],
    },
    credibility_signal: {
        const_name: 'ZYGARNIK_PHRASE_SETS.credibility_signal',
        description: 'Creator-experience signals — years of practice, data, tests.',
        signal: 'Expertise claims',
        examples: ['years of', 'i have done this', 'my experience', 'i tested', 'based on'],
    },
    reward_language: {
        const_name: 'ZYGARNIK_PHRASE_SETS.reward_language',
        description: 'Promise-of-reward language — "the key is", "worth it", "paid off".',
        signal: 'Reward promise',
        examples: ['finally', 'step by step', 'the key is', 'worth it', 'paid off'],
    },
    loss_aversion: {
        const_name: 'ZYGARNIK_PHRASE_SETS.loss_aversion',
        description: 'Avoid-the-mistake framing.',
        signal: 'Negative-outcome avoidance',
        examples: ['stop wasting', 'avoid this', 'biggest mistake', 'most people fail', 'you will lose'],
    },
    urgency: {
        const_name: 'ZYGARNIK_PHRASE_SETS.urgency',
        description: 'Urgency / immediacy language.',
        signal: 'Time pressure',
        examples: ['right now', 'immediately', 'today', 'time is running out', 'do it now'],
    },
    vulnerability: {
        const_name: 'ZYGARNIK_PHRASE_SETS.vulnerability',
        description: 'Creator admissions of weakness, doubt, or shame.',
        signal: 'Vulnerability / parasocial bond',
        examples: ['i am embarrassed', 'i almost quit', 'i failed', 'i was scared', 'i cried'],
    },
    transformation: {
        const_name: 'ZYGARNIK_PHRASE_SETS.transformation',
        description: 'Before/after language about personal change.',
        signal: 'Transformation narrative',
        examples: ['used to be', 'changed everything', 'from zero to', 'the old me', 'transformed my'],
    },
    specificity_anchor: {
        const_name: 'ZYGARNIK_PHRASE_SETS.specificity_anchor',
        description: 'Precise numbers, dates, step counts.',
        signal: 'Precision / credibility anchor',
        examples: ['at exactly', 'in just', 'in 30 days', 'precisely', 'step one'],
    },
    micro_commitment: {
        const_name: 'ZYGARNIK_PHRASE_SETS.micro_commitment',
        description: 'Small asks that pull the viewer into participation.',
        signal: 'Participation ladder',
        examples: ['comment below', 'save this', 'share this', 'follow along', 'try this'],
    },
    emotional_peak: {
        const_name: 'ZYGARNIK_PHRASE_SETS.emotional_peak',
        description: 'Peak-emotion language — unbelievable, mind blown, in tears.',
        signal: 'Affective spike',
        examples: ['unbelievable', 'i cannot believe', 'mind blown', 'goosebumps', 'in tears'],
    },
    visual_proof: {
        const_name: 'ZYGARNIK_PHRASE_SETS.visual_proof',
        description: 'Demonstrative "look / watch / see" paired with on-screen evidence.',
        signal: 'Visual evidence cue',
        examples: ['look at', 'watch this', 'see here', 'right here', 'as you can see'],
    },
    // "New" phrase sets
    new_proof: {
        const_name: 'NEW_PROOF_PHRASES',
        description: 'Proof-arrival language — results and visible outcomes.',
        signal: 'Result arrival',
        examples: ['the result', 'it worked', 'here is the result', 'look at this', 'as you can see'],
    },
    new_setup: {
        const_name: 'NEW_SETUP_PHRASES',
        description: 'Problem-framing / up-front-contract language.',
        signal: 'Problem framing',
        examples: ['the problem', 'imagine', 'what if', 'the question is', 'most people'],
    },
    new_payoff: {
        const_name: 'NEW_PAYOFF_PHRASES',
        description: 'Closing-payoff language — "at the end", "what i learned".',
        signal: 'Payoff delivery',
        examples: ['the result', 'it worked', 'in the end', 'finally', 'at the end'],
    },
    new_visual_proof: {
        const_name: 'NEW_VISUAL_PROOF_PHRASES',
        description: 'On-screen demonstration language.',
        signal: 'Visual evidence',
        examples: ['look at this', 'as you can see', 'check this out', 'before and after', 'watch this'],
    },
    new_credential: {
        const_name: 'NEW_CREDENTIAL_PHRASES',
        description: 'Credential / authority language (tested, studied, sciences).',
        signal: 'Authority borrowing',
        examples: ['i tested', 'the science says', 'studies show', 'in my experience', 'research shows'],
    },
    new_consequence: {
        const_name: 'NEW_CONSEQUENCE_PHRASES',
        description: 'Cause-and-effect connective tissue.',
        signal: 'Consequence chaining',
        examples: ['that meant', 'which means', 'so that', 'as a result', 'because of this'],
    },
    new_personal_stake: {
        const_name: 'NEW_PERSONAL_STAKE_PHRASES',
        description: 'Personal-impact / "this cost me something" language.',
        signal: 'Personal stakes',
        examples: ['my life', 'everything changed', 'almost lost', 'cost me', 'changed everything'],
    },
    new_micro_reward: {
        const_name: 'NEW_MICRO_REWARD_PHRASES',
        description: 'Frequent small reward/acknowledgement language — pacing dopamine.',
        signal: 'Micro-rewards',
        examples: ['exactly', 'that is right', 'here is why', 'wait for it', 'now watch'],
    },
    new_early_engagement: {
        const_name: 'NEW_EARLY_ENGAGEMENT_PHRASES',
        description: 'Opening engagement hooks — "imagine", "have you ever".',
        signal: 'Hook-window engagement',
        examples: ['think about this', 'imagine', 'picture this', 'have you ever', 'can you imagine'],
    },
    new_mid_filler: {
        const_name: 'NEW_MID_FILLER_PHRASES',
        description: 'Filler / low-signal conversational language — measure of pacing drag.',
        signal: 'Filler density (negative indicator)',
        examples: ['um', 'uh', 'so basically', 'and then', 'like i said'],
    },
    new_closing_hook: {
        const_name: 'NEW_CLOSING_HOOK_PHRASES',
        description: 'End-of-video re-hook language.',
        signal: 'Retention tail',
        examples: ['but wait', 'one more thing', 'before you go', 'last thing', 'hold on'],
    },
};

// Regex to pull the family name off a key like `proof_of_work_count_hook`.
// For each family we list the canonical key stem.
const FAMILY_KEY_STEMS = {
    proof_of_work: 'proof_of_work',
    future_self: 'future_self',
    failure_vulnerability: 'failure_vulnerability',
    action_trigger: 'action_trigger',
    reference_callback: 'reference_callback',
    visual_credibility: 'visual_credibility',
    payoff_signal: 'payoff_signal',
    setup_signal: 'setup_signal',
    open_loop: 'open_loop',
    closure: 'closure',
    unresolved_ref: 'unresolved_ref',
    temporal_anticipation: 'temporal_anticipation',
    contrast: 'contrast',
    superlative: 'superlative',
    sensory: 'sensory',
    imperative: 'imperative',
    social_proof: 'social_proof',
    scarcity: 'scarcity',
    stakes_high: 'stakes_high',
    credibility_signal: 'credibility_signal',
    reward_language: 'reward_language',
    loss_aversion: 'loss_aversion',
    urgency: 'urgency',
    vulnerability: 'vulnerability',
    transformation: 'transformation',
    specificity_anchor: 'specificity_anchor',
    micro_commitment: 'micro_commitment',
    emotional_peak: 'emotional_peak',
    visual_proof: 'visual_proof',
    // "New" phrase families — key stems in the registry differ from internal names
    new_proof: 'proof_phrase',
    new_setup: 'setup_phrase',
    new_payoff: 'payoff_phrase',
    new_visual_proof: 'visual_proof_phrase',
    new_credential: 'credential_signal',
    new_consequence: 'consequence',
    new_personal_stake: 'personal_stake',
    new_micro_reward: 'micro_reward',
    new_early_engagement: 'early_engagement',
    new_mid_filler: 'mid_filler',
    new_closing_hook: 'closing_hook',
};

// Reverse index: stem -> family name (longest stems first to avoid matching
// `open_loop` inside `open_loop_payoff`, etc.)
const FAMILY_STEMS_SORTED = Object.entries(FAMILY_KEY_STEMS)
    .map(([family, stem]) => ({ family, stem }))
    .sort((a, b) => b.stem.length - a.stem.length);

// ── Quantification-style descriptors ─────────────────────────────────────
// A quantification style describes *how* a phrase family is counted/windowed.
// Each entry takes a suffix off the key and produces a provenance snippet.
const QUANTIFICATION_STYLES = [
    {
        style: 'count',
        suffix_regex: /^_count$/,
        label: 'Raw count (full transcript)',
        describe: () => 'Count of distinct phrase matches across the entire transcript. Each phrase in the family contributes 1 per match; substring matches count.',
        formula: 'countPhraseMatches(transcript.toLowerCase(), FAMILY_PHRASES)',
        modality: 'transcript.fullText',
        expected_range: '0 to ~100',
    },
    {
        style: 'density',
        suffix_regex: /^_density$/,
        label: 'Density per word (full transcript)',
        describe: () => 'Phrase count normalized by transcript word count. Rate — resilient to long vs short videos.',
        formula: 'countPhraseMatches(text, FAMILY_PHRASES) / word_count',
        modality: 'transcript.fullText',
        expected_range: '0 to 0.05',
    },
    {
        style: 'count_hook',
        suffix_regex: /^_count_hook$/,
        label: 'Hook-window count (first 10%)',
        describe: () => 'Count of phrase matches in the first 10% of the transcript (by word index). Measures whether the family is used up-front.',
        formula: 'countPhraseMatches(words[0 : ceil(N*0.10)].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (hook slice)',
        expected_range: '0 to ~20',
    },
    {
        style: 'density_hook',
        suffix_regex: /^_density_hook$/,
        label: 'Hook-window density',
        describe: () => 'Phrase density in the first 10% of transcript, normalized by hook word count.',
        formula: 'hook_count / hook_word_count',
        modality: 'transcript.fullText (hook slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'count_first_quarter',
        suffix_regex: /^_count_first_quarter$/,
        label: 'First-quarter count (0–25%)',
        describe: () => 'Count of phrase matches in the first 25% of the transcript.',
        formula: 'countPhraseMatches(words[0 : floor(N/4)].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (first-quarter slice)',
        expected_range: '0 to ~30',
    },
    {
        style: 'count_first_half',
        suffix_regex: /^_count_first_half$/,
        label: 'First-half count (0–50%)',
        describe: () => 'Count of phrase matches in the first 50% of the transcript.',
        formula: 'countPhraseMatches(words[0 : floor(N/2)].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (first-half slice)',
        expected_range: '0 to ~50',
    },
    {
        style: 'count_mid',
        suffix_regex: /^_count_mid$/,
        label: 'Mid-section count (33–67%)',
        describe: () => 'Count of phrase matches in the middle third of the transcript.',
        formula: 'countPhraseMatches(words[N/3 : 2N/3].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (middle-third slice)',
        expected_range: '0 to ~30',
    },
    {
        style: 'count_last_quarter',
        suffix_regex: /^_count_last_quarter$/,
        label: 'Last-quarter count (75–100%)',
        describe: () => 'Count of phrase matches in the final 25% of the transcript.',
        formula: 'countPhraseMatches(words[floor(3N/4) : N].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (last-quarter slice)',
        expected_range: '0 to ~30',
    },
    {
        style: 'front_load_ratio',
        suffix_regex: /^_front_load_ratio$/,
        label: 'Front-load ratio (first half / second half)',
        describe: () => 'First-half match count divided by second-half match count (with a tiny epsilon so we never divide by zero). Ratio > 1 = front-loaded.',
        formula: '(count_first_half + 0.0001) / (count_second_half + 0.0001)',
        modality: 'transcript.fullText (halves)',
        expected_range: '0.1 to 10',
    },
    {
        style: 'position_pct',
        suffix_regex: /^_position_pct$/,
        label: 'First-occurrence position (% of transcript)',
        describe: () => 'Word index of the first phrase match divided by total words. Measures how early the family first appears.',
        formula: 'first_match_word_index / total_words',
        modality: 'transcript.fullText',
        expected_range: '0 to 1',
    },
    {
        style: 'count_first_Ns',
        suffix_regex: /^_count_first(\d+)s$/,
        label: (m) => `Count in first ${m[1]} seconds`,
        describe: (m) => `Count of phrase matches in the first ${m[1]} seconds of the transcript (words sliced by speech-rate estimate).`,
        formula: (m) => `countPhraseMatches(words[0 : wordsIn${m[1]}s].join(" "), FAMILY_PHRASES)`,
        modality: 'transcript.fullText (first-N-sec slice)',
        expected_range: '0 to ~20',
    },
    {
        style: 'density_first_Ns',
        suffix_regex: /^_density_first(\d+)s$/,
        label: (m) => `Density in first ${m[1]} seconds`,
        describe: (m) => `Density of phrase matches in the first ${m[1]} seconds of the transcript.`,
        formula: (m) => `count_first${m[1]}s / words_in_first${m[1]}s`,
        modality: 'transcript.fullText (first-N-sec slice)',
        expected_range: '0 to 0.1',
    },
];

// ── Non-phrase pattern rules ─────────────────────────────────────────────
// These describe keys that aren't phrase-family-based (retention windows,
// view-time windows, interactions, etc.).
const NON_PHRASE_RULES = [
    {
        name: 'retention_percentile',
        regex: /^retention_pct_(\d+)$/,
        describe: (m) => ({
            label: `Retention at ${m[1]}%`,
            description: `YouTube's audience-retention value at the ${m[1]}% mark of the video — proportion of the average viewer still watching relative to the overall average.`,
            formula: `retentionCurve[${m[1]}].retention`,
            modality: 'analytics.retentionCurve',
            quantification: 'Retention percentile point',
            source_fields: ['analytics.retentionCurve'],
            expected_range: '0 to 2.0',
            layer: 'post',
        }),
    },
    {
        name: 'retention_mean_window',
        regex: /^retention_mean_(\d+)_(\d+)$/,
        describe: (m) => ({
            label: `Mean retention ${m[1]}–${m[2]}%`,
            description: `Average audience retention across the ${m[1]}–${m[2]}% window of the video.`,
            formula: `mean(retentionCurve[${m[1]}:${m[2]}].retention)`,
            modality: 'analytics.retentionCurve',
            quantification: 'Retention window mean',
            source_fields: ['analytics.retentionCurve'],
            expected_range: '0 to 2.0',
            layer: 'post',
        }),
    },
    {
        name: 'retention_slope_window',
        regex: /^retention_slope_(\d+)_(\d+)$/,
        describe: (m) => ({
            label: `Retention slope ${m[1]}–${m[2]}%`,
            description: `Linear-regression slope of retention over the ${m[1]}–${m[2]}% window. Negative = audience is dropping, positive = re-engaging.`,
            formula: `linregress(x = [${m[1]}..${m[2]}], y = retentionCurve).slope`,
            modality: 'analytics.retentionCurve',
            quantification: 'Retention window slope',
            source_fields: ['analytics.retentionCurve'],
            expected_range: '-0.05 to 0.05',
            layer: 'post',
        }),
    },
    {
        name: 'retention_volatility_window',
        regex: /^retention_volatility_(\d+)_(\d+)$/,
        describe: (m) => ({
            label: `Retention volatility ${m[1]}–${m[2]}%`,
            description: `Standard deviation of retention across the ${m[1]}–${m[2]}% window — how noisy/spiky the curve is in that slice.`,
            formula: `std(retentionCurve[${m[1]}:${m[2]}].retention)`,
            modality: 'analytics.retentionCurve',
            quantification: 'Retention window stdev',
            source_fields: ['analytics.retentionCurve'],
            expected_range: '0 to 0.5',
            layer: 'post',
        }),
    },
    {
        name: 'views_log_days_window',
        regex: /^views_log_days_(\d+)_(\d+)$/,
        describe: (m) => ({
            label: `Log views, days ${m[1]}–${m[2]}`,
            description: `Log10 of total views accumulated across days ${m[1]}–${m[2]} after upload.`,
            formula: `log10(sum(dailyViews[${m[1]}:${m[2]}].views) + 1)`,
            modality: 'analytics.dailyViews',
            quantification: 'Day-window log views',
            source_fields: ['analytics.dailyViews'],
            expected_range: '0 to 8',
            layer: 'post',
        }),
    },
    {
        name: 'views_ratio',
        regex: /^views_ratio_(\w+?)_vs_(\w+)$/,
        describe: (m) => ({
            label: `Views ratio ${m[1]} vs ${m[2]}`,
            description: `Ratio of views accumulated in day-window "${m[1]}" vs day-window "${m[2]}". Measures relative velocity across two periods.`,
            formula: `sum(dailyViews[${m[1]}]) / (sum(dailyViews[${m[2]}]) + 1)`,
            modality: 'analytics.dailyViews',
            quantification: 'View-window ratio',
            source_fields: ['analytics.dailyViews'],
            expected_range: '0 to 5',
            layer: 'post',
        }),
    },
    {
        name: 'interaction_product',
        regex: /^(.+)_x_(.+)$/,
        describe: (m) => ({
            label: `${m[1]} × ${m[2]}`,
            description: `Multiplicative interaction — the two component variables multiplied together. Measures whether they matter *jointly* beyond their separate additive effects.`,
            formula: `${m[1]} * ${m[2]}`,
            modality: 'derived from two other variables',
            quantification: 'Interaction product (composite)',
            components: [m[1], m[2]],
            source_fields: [`variable:${m[1]}`, `variable:${m[2]}`],
            expected_range: 'varies',
        }),
    },
];

// ── Well-known static variables ──────────────────────────────────────────
// Keys that don't match any pattern rule get their provenance from this map.
const STATIC_VARIABLES = {
    views: {
        label: 'Views',
        description: 'Total lifetime view count reported by YouTube Analytics. Always log-transformed before correlation because views follow a power-law distribution.',
        formula: 'analytics.lifetimeViews',
        modality: 'YouTube Analytics (video)',
        quantification: 'Raw count (log-transformed for correlation)',
        source_fields: ['analytics.lifetimeViews'],
        expected_range: '1 to 100M+',
        layer: 'target',
    },
    keep: {
        label: 'Keep Rate',
        description: 'Share of impressions that resulted in a watch past the initial swipe — how well the cold-start hook held a viewer.',
        formula: 'analytics.swipeRatio.stayedToWatch',
        modality: 'YouTube Analytics (impressions)',
        quantification: '% (0–100)',
        source_fields: ['analytics.swipeRatio.stayedToWatch'],
        expected_range: '0 to 1',
        layer: 'post',
    },
    retention: {
        label: 'Retention %',
        description: 'Average percent of the video watched across all viewers — the single-number view-duration proxy YouTube publishes.',
        formula: 'analytics.avgPercentViewed',
        modality: 'YouTube Analytics (retention)',
        quantification: '% (0–100)',
        source_fields: ['analytics.avgPercentViewed'],
        expected_range: '0 to 100',
        layer: 'post',
    },
    share_rate: {
        label: 'Share Rate',
        description: 'Shares per 1,000 views — a rate-normalized engagement signal that rules out raw-view scaling.',
        formula: 'shares / (views / 1000)',
        modality: 'YouTube Analytics (video)',
        quantification: 'Ratio (shares per 1k views)',
        source_fields: ['analytics.shares', 'analytics.views'],
        expected_range: '0 to 50',
        layer: 'post',
    },
    z_score: {
        label: 'Zeigarnik Score (text)',
        description: 'LLM-rated curiosity-gap score for the opening hook — scored 1–10 from title plus first ~180 characters of transcript.',
        formula: 'LLM-scored(title + first_180_chars_transcript)',
        modality: 'LLM text scoring',
        quantification: 'Integer 1–10',
        source_fields: ['metadata.title', 'transcript.fullText[0:180]'],
        expected_range: '1 to 10',
        layer: 'pre',
    },
    z_type: {
        label: 'Zeigarnik Type (text)',
        description: 'Categorical LLM classification of the open-loop style (A–E) — assigned from the same prompt used for z_score.',
        formula: 'LLM-classified(title + first_180_chars_transcript)',
        modality: 'LLM text scoring',
        quantification: 'Categorical A/B/C/D/E',
        source_fields: ['metadata.title', 'transcript.fullText[0:180]'],
        expected_range: 'A, B, C, D, E',
        layer: 'pre',
    },
    vz_score: {
        label: 'Visual Zeigarnik Score',
        description: 'LLM-vision-rated curiosity-gap score for the first three frames plus the first three seconds of transcript.',
        formula: 'LLM-vision(frames[0:3] + transcript[0:3s])',
        modality: 'LLM vision scoring',
        quantification: 'Integer 1–10',
        source_fields: ['frames[0..2]', 'transcript.fullText[0:3s]'],
        expected_range: '1 to 10',
        layer: 'pre',
    },
    vz_type: {
        label: 'Visual Zeigarnik Type',
        description: 'Categorical LLM-vision classification (A–E) of the visual hook style.',
        formula: 'LLM-vision-classified(frames[0:3])',
        modality: 'LLM vision scoring',
        quantification: 'Categorical A/B/C/D/E',
        source_fields: ['frames[0..2]'],
        expected_range: 'A, B, C, D, E',
        layer: 'pre',
    },
    novelty: {
        label: 'Novelty',
        description: 'LLM-rated how-different-from-category score (1–10) based on title + opening transcript.',
        formula: 'LLM-scored(title + opening_transcript)',
        modality: 'LLM text scoring',
        quantification: 'Integer 1–10',
        source_fields: ['metadata.title', 'transcript.fullText'],
        expected_range: '1 to 10',
        layer: 'pre',
    },
    cognitive_load: {
        label: 'Cognitive Load',
        description: 'LLM-rated comprehension cost (1–10) — how much effort the viewer must spend to parse the opening.',
        formula: 'LLM-scored(title + opening_transcript)',
        modality: 'LLM text scoring',
        quantification: 'Integer 1–10',
        source_fields: ['metadata.title', 'transcript.fullText'],
        expected_range: '1 to 10',
        layer: 'pre',
    },
    net_novelty: {
        label: 'Net Novelty',
        description: 'Novelty minus cognitive load — the fresh-idea score after paying the comprehension tax.',
        formula: 'novelty - cognitive_load',
        modality: 'derived from two LLM scores',
        quantification: 'Integer (difference)',
        components: ['novelty', 'cognitive_load'],
        source_fields: ['variable:novelty', 'variable:cognitive_load'],
        expected_range: '-9 to 9',
        layer: 'pre',
    },
};

// ── Helpers ──────────────────────────────────────────────────────────────

function humanizeKey(key) {
    if (!key) return '';
    return String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Try to split a phrase-family key like `proof_of_work_count_hook` into
 * { family, suffix }. Falls back to null if no family stem matches.
 */
function splitFamilyAndSuffix(key) {
    for (const { family, stem } of FAMILY_STEMS_SORTED) {
        if (key === stem) return { family, suffix: '' };
        if (key.startsWith(stem + '_')) {
            return { family, suffix: key.slice(stem.length) }; // suffix starts with '_'
        }
    }
    return null;
}

function findQuantificationStyle(suffix) {
    for (const q of QUANTIFICATION_STYLES) {
        const m = suffix.match(q.suffix_regex);
        if (m) return { match: m, style: q };
    }
    return null;
}

function describePhraseVariable(family, quant, matchGroups) {
    const fam = PHRASE_FAMILIES[family] || {
        const_name: '(unknown)',
        description: `Phrase family "${family}".`,
        signal: humanizeKey(family),
        examples: [],
    };
    const resolveTemplate = (val, m) => (typeof val === 'function' ? val(m) : val);
    return {
        label: `${humanizeKey(family)} — ${resolveTemplate(quant.label, matchGroups)}`,
        description: `${fam.description} ${resolveTemplate(quant.describe, matchGroups)}`,
        formula: resolveTemplate(quant.formula, matchGroups),
        modality: quant.modality,
        quantification: quant.label === 'string' ? quant.label : resolveTemplate(quant.label, matchGroups),
        source_fields: ['transcript.fullText', `phrase_list:${fam.const_name}`],
        phrase_family: {
            name: family,
            const_name: fam.const_name,
            description: fam.description,
            signal: fam.signal,
            examples: fam.examples || [],
        },
        expected_range: quant.expected_range,
    };
}

// ── Main entrypoint ──────────────────────────────────────────────────────

/**
 * Build a provenance object for any variable key. Best-effort: returns null
 * only if we genuinely have nothing to say; otherwise always returns at least
 * a label + generic description so the UI never shows an empty card.
 */
function describeVariable(key, opts = {}) {
    if (!key || typeof key !== 'string') return null;
    const trimmedKey = key.trim();

    // 1) Static well-known variable?
    if (STATIC_VARIABLES[trimmedKey]) {
        return {
            key: trimmedKey,
            source: 'static',
            ...STATIC_VARIABLES[trimmedKey],
        };
    }

    // 2) Phrase-family + quantification-style combo?
    const split = splitFamilyAndSuffix(trimmedKey);
    if (split) {
        if (split.suffix === '') {
            const fam = PHRASE_FAMILIES[split.family];
            if (fam) {
                return {
                    key: trimmedKey,
                    source: 'phrase_family_root',
                    label: humanizeKey(split.family),
                    description: fam.description,
                    formula: 'countPhraseMatches(transcript.toLowerCase(), ' + fam.const_name + ')',
                    modality: 'transcript.fullText',
                    quantification: 'Phrase family (raw count by default)',
                    source_fields: ['transcript.fullText', `phrase_list:${fam.const_name}`],
                    phrase_family: {
                        name: split.family,
                        const_name: fam.const_name,
                        description: fam.description,
                        signal: fam.signal,
                        examples: fam.examples || [],
                    },
                };
            }
        }
        const q = findQuantificationStyle(split.suffix);
        if (q) {
            const desc = describePhraseVariable(split.family, q.style, q.match);
            return { key: trimmedKey, source: 'phrase_family', family: split.family, quantification_style: q.style.style, ...desc };
        }
    }

    // 3) Non-phrase pattern (retention windows, view ratios, interactions, …)
    for (const rule of NON_PHRASE_RULES) {
        const m = trimmedKey.match(rule.regex);
        if (m) {
            const base = rule.describe(m);
            // Recurse for interaction components so derived experiments can
            // show per-component provenance inline.
            if (base.components && Array.isArray(base.components)) {
                base.component_definitions = base.components.map((c) => describeVariable(c, opts) || {
                    key: c,
                    label: humanizeKey(c),
                    description: `Component variable "${c}" — no richer definition available.`,
                    source: 'unknown',
                });
            }
            return { key: trimmedKey, source: rule.name, ...base };
        }
    }

    // 4) Fallback — we know nothing specific. Return a humanized stub so the
    //    UI still has something to show instead of a blank card.
    return {
        key: trimmedKey,
        source: 'fallback',
        label: humanizeKey(trimmedKey),
        description: `No pattern match for "${trimmedKey}". Treat as opaque until a definition is added. Family stems tried: ${FAMILY_STEMS_SORTED.length}.`,
        formula: trimmedKey,
        modality: 'unknown',
        quantification: 'unknown',
        source_fields: [],
        expected_range: 'unknown',
    };
}

/**
 * Describe every component of a derived experiment. Accepts a record with
 * `component_keys` (preferred) or a formula containing `_x_` splits.
 */
function describeDerivedComponents(derived) {
    if (!derived) return [];
    const keys = Array.isArray(derived.component_keys) && derived.component_keys.length
        ? derived.component_keys
        : inferComponentKeys(derived.key || '');
    return keys.map((k) => describeVariable(k));
}

function inferComponentKeys(key) {
    const m = key.match(/^(.+)_x_(.+)$/);
    if (!m) return [];
    return [m[1], m[2]];
}

/**
 * Enumerate every pattern + static + phrase family in the catalog. Used by
 * the UI's browsable "Variables" tab.
 */
function listCatalog() {
    return {
        static_variables: Object.entries(STATIC_VARIABLES).map(([key, def]) => ({ key, ...def })),
        phrase_families: Object.entries(PHRASE_FAMILIES).map(([family, def]) => ({
            family,
            key_stem: FAMILY_KEY_STEMS[family],
            const_name: def.const_name,
            description: def.description,
            signal: def.signal,
            examples: def.examples,
        })),
        quantification_styles: QUANTIFICATION_STYLES.map((q) => ({
            style: q.style,
            suffix_pattern: String(q.suffix_regex),
            description: typeof q.describe === 'function' ? q.describe({ 1: 'N' }) : q.describe,
            formula: typeof q.formula === 'function' ? q.formula({ 1: 'N' }) : q.formula,
            modality: q.modality,
            expected_range: q.expected_range,
        })),
        non_phrase_rules: NON_PHRASE_RULES.map((r) => ({
            name: r.name,
            pattern: String(r.regex),
        })),
    };
}

/**
 * Resolve the target variable key for a record. Records may state it on:
 *   - record.target                    (most derived experiments / indicators)
 *   - record.parameters.target         (atomic indicator experiments)
 *   - record.experiment.parameters.target   (nested experiment blob)
 * When none is present the Jarvis pipeline treats the target as `views`, so we
 * default there too. Returned as a non-empty string.
 */
function resolveTargetKey(record) {
    if (!record) return 'views';
    const pick = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    return pick(record.target)
        || (record.parameters && pick(record.parameters.target))
        || (record.experiment && record.experiment.parameters && pick(record.experiment.parameters.target))
        || 'views';
}

/**
 * Enrich an indicator record in place (non-destructive — returns a shallow
 * copy with an added `variable_definition` field) so the UI can read a
 * consistent provenance block without re-implementing describeVariable.
 *
 * Also attaches `target_variable_definition` (defaulting to `views`) so the
 * UI always has the target side of the correlation defined, not just the
 * independent variable.
 */
function enrichIndicator(ind) {
    if (!ind || !ind.key) return ind;
    const def = describeVariable(ind.key);
    const targetKey = resolveTargetKey(ind);
    return {
        ...ind,
        variable_definition: def,
        target_key: targetKey,
        target_variable_definition: describeVariable(targetKey),
    };
}

function enrichDerivedExperiment(d) {
    if (!d || !d.key) return d;
    const selfDef = describeVariable(d.key);
    const components = describeDerivedComponents(d);
    const targetKey = resolveTargetKey(d);
    return {
        ...d,
        variable_definition: selfDef,
        component_variable_definitions: components,
        target_key: targetKey,
        target_variable_definition: describeVariable(targetKey),
    };
}

/**
 * Lightweight provenance — ~200 bytes per variable. Suitable for bulk
 * attachment to list responses where the full `describeVariable` payload
 * (with 5-phrase examples and long descriptions) would bloat the wire.
 *
 * Returns the essentials the UI needs to render a glanceable chip:
 *   key, label, source, family, signal, quantification, modality, layer.
 */
function describeVariableMini(key) {
    const full = describeVariable(key);
    if (!full) return null;
    const mini = {
        key: full.key,
        source: full.source,
        label: full.label,
        quantification: full.quantification,
        modality: full.modality,
    };
    if (full.layer) mini.layer = full.layer;
    if (full.family) mini.family = full.family;
    if (full.phrase_family && full.phrase_family.signal) mini.signal = full.phrase_family.signal;
    if (full.quantification_style) mini.quantification_style = full.quantification_style;
    if (Array.isArray(full.components) && full.components.length) mini.components = full.components;
    return mini;
}

function enrichIndicatorMini(ind) {
    if (!ind || !ind.key) return ind;
    const targetKey = resolveTargetKey(ind);
    return {
        ...ind,
        variable_definition: describeVariableMini(ind.key),
        target_key: targetKey,
        target_variable_definition: describeVariableMini(targetKey),
    };
}

function enrichDerivedExperimentMini(d) {
    if (!d || !d.key) return d;
    const selfDef = describeVariableMini(d.key);
    const keys = Array.isArray(d.component_keys) && d.component_keys.length
        ? d.component_keys
        : inferComponentKeys(d.key || '');
    const components = keys.map((k) => describeVariableMini(k)).filter(Boolean);
    const targetKey = resolveTargetKey(d);
    return {
        ...d,
        variable_definition: selfDef,
        component_variable_definitions: components,
        target_key: targetKey,
        target_variable_definition: describeVariableMini(targetKey),
    };
}

const api = {
    describeVariable,
    describeVariableMini,
    describeDerivedComponents,
    listCatalog,
    enrichIndicator,
    enrichIndicatorMini,
    enrichDerivedExperiment,
    enrichDerivedExperimentMini,
    resolveTargetKey,
    // Exposed for tests + the UI, which wants to render family metadata
    // outside of any particular key.
    PHRASE_FAMILIES,
    FAMILY_KEY_STEMS,
    QUANTIFICATION_STYLES,
    NON_PHRASE_RULES,
    STATIC_VARIABLES,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.JarvisVariableCatalog = api;
}
