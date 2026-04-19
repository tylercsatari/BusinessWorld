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

    // ── Additional phrase families referenced by jarvis-metrics.js ──────────
    // Each corresponds to a named `const NAME_PHRASES = [...]` list consumed
    // by extractMetric(). Stems registered below in FAMILY_KEY_STEMS.
    action_verb: {
        const_name: 'ZYGARNIK_PHRASE_SETS.action_verb',
        description: 'Physical-action verbs — make, build, cut, break, smash — that describe on-screen doing rather than telling.',
        signal: 'Kinetic / show-don\'t-tell action language',
        examples: ['make', 'build', 'create', 'cut', 'break'],
    },
    anticipation: {
        const_name: 'ANTICIPATION_PHRASES',
        description: 'Forward-looking teasers that promise a payoff is imminent — "wait for it", "before I show you", "it gets better".',
        signal: 'Anticipation / payoff deferral',
        examples: ['wait for it', "here's the thing", "you won't believe", 'before i show you', 'but first'],
    },
    anticipatory_build: {
        const_name: 'ZYGARNIK_PHRASE_SETS.anticipatory_build',
        description: 'Incremental-proximity language — "almost ready", "we are getting close" — that ratchets anticipation toward an imminent reveal.',
        signal: 'Proximity ratchet',
        examples: ['just a few more', 'almost ready', 'we are getting close', 'nearly there', 'building to'],
    },
    counterintuitive: {
        const_name: 'COUNTERINTUITIVE_PHRASES',
        description: 'Expectation-reversal language — "actually", "turns out", "plot twist" — that signals the claim will contradict the obvious answer.',
        signal: 'Expectation-reversal cue',
        examples: ['actually', 'surprisingly', 'turns out', 'plot twist', "not what you'd expect"],
    },
    confession: {
        const_name: 'CONFESSION_PHRASES',
        description: 'Admissions of mistake, fear, or ignorance from the creator — parasocial vulnerability signals.',
        signal: 'Vulnerability / confession',
        examples: ['i was wrong', 'i made a mistake', 'i failed', 'honestly', 'truth is'],
    },
    escalation: {
        const_name: 'ESCALATION_PHRASES',
        description: 'Connective tissue that ratchets intensity — "and then", "but then", "even more", "to make matters worse".',
        signal: 'Narrative escalation',
        examples: ['and then', 'but then', "what's worse", 'it gets worse', 'even more'],
    },
    specificity_phrase: {
        const_name: 'SPECIFICITY_PHRASES',
        description: 'Precision-signalling language — "exactly", "specifically", "the exact" — that anchors claims to concrete detail.',
        signal: 'Specificity / credibility anchor',
        examples: ['exactly', 'specifically', 'precisely', 'the exact', 'for example'],
    },
    callback: {
        const_name: 'CALLBACK_PHRASES',
        description: 'Backward references to something said earlier in the same video — "as I mentioned", "remember when", "full circle".',
        signal: 'Long-arc callback',
        examples: ['as i mentioned', 'remember when', 'earlier i said', 'going back to', 'full circle'],
    },
    urgency_signal: {
        const_name: 'URGENCY_PHRASES',
        description: 'Urgency / stay-to-the-end pressure — "watch till the end", "right now", "limited time".',
        signal: 'Urgency pressure',
        examples: ["don't miss", 'watch till the end', 'right now', 'act now', 'stop scrolling'],
    },
    rhetorical_question: {
        const_name: 'RHETORICAL_QUESTION_PHRASES',
        description: 'Questions posed to the viewer that expect no answer — "have you ever", "what if", "why do".',
        signal: 'Rhetorical hook / audience address',
        examples: ['what if', 'have you ever', 'did you know', 'why do', 'ever wonder'],
    },
    social_comparison: {
        const_name: 'SOCIAL_COMPARISON_PHRASES',
        description: 'Us-vs-them framings — "most people", "nobody tells you", "unlike other creators".',
        signal: 'In-group / contrast framing',
        examples: ['most people', 'nobody tells you', 'other creators', 'unlike most', 'the difference between'],
    },
    transformation_arc: {
        const_name: 'TRANSFORMATION_ARC_PHRASES',
        description: 'Before/after arc language — "went from", "transformed", "life-changing".',
        signal: 'Transformation arc',
        examples: ['from zero to', 'went from', 'transformed', 'used to be', 'changed everything'],
    },
    loss_framing: {
        const_name: 'LOSS_FRAMING_PHRASES',
        description: 'Avoid-the-mistake / negative-outcome language — "don\'t", "avoid this", "big mistake".',
        signal: 'Loss aversion framing',
        examples: ["don't make", 'avoid this', 'big mistake', 'costly mistake', 'common mistake'],
    },
    mystery_setup: {
        const_name: 'MYSTERY_SETUP_PHRASES',
        description: 'Hidden-knowledge / insider-secret framing — "the real reason", "behind the scenes", "hidden".',
        signal: 'Mystery / insider framing',
        examples: ['the secret', 'the truth', 'behind the scenes', 'hidden', 'shocking'],
    },
    promise_specificity: {
        const_name: 'PROMISE_SPECIFICITY_PHRASES',
        description: 'Up-front, concrete promises of what the viewer will get — "by the end", "step by step", "the exact".',
        signal: 'Concrete promise delivery',
        examples: ['by the end', "i'll show you", 'step by step', 'the exact', 'you will learn'],
    },
    pattern_interrupt: {
        const_name: 'PATTERN_INTERRUPT_PHRASES',
        description: 'Sudden-stop / course-correction phrases — "wait", "hold on", "actually no".',
        signal: 'Pattern interrupt',
        examples: ['wait', 'hold on', 'stop', 'actually no', 'but wait'],
    },
    viewer_stakes: {
        const_name: 'VIEWER_STAKES_PHRASES',
        description: 'Direct-to-viewer stakes — "your business", "you need to know", "change your life".',
        signal: 'Personal stakes to viewer',
        examples: ['for you', 'your business', 'your life', 'you need to know', 'change your'],
    },
    commitment_device: {
        const_name: 'COMMITMENT_DEVICE_PHRASES',
        description: 'Stay-to-the-end / sequential-content pull — "part one", "stay until", "subscribe to see".',
        signal: 'Commitment device',
        examples: ['by the end of this', 'stay until', 'part one', 'series', 'follow along'],
    },
    curiosity_gap: {
        const_name: 'CURIOSITY_GAP_PHRASES',
        description: 'Known-unknowns framing — "most people don\'t know", "here\'s why", "the hidden".',
        signal: 'Curiosity gap',
        examples: ["you don't know", 'most people miss', 'here is why', 'the hidden', 'the key is'],
    },
    stakes_reinforcement: {
        const_name: 'STAKES_REINFORCEMENT_PHRASES',
        description: 'Explicit why-this-matters explanations — "this matters because", "the stakes", "the consequence".',
        signal: 'Stakes reinforcement',
        examples: ['this matters because', 'this is important because', 'the stakes', 'the implication', 'why you should care'],
    },
    viewer_agency: {
        const_name: 'VIEWER_AGENCY_PHRASES',
        description: 'Directive you-instructions — "you should", "you need to", "pay attention to".',
        signal: 'Viewer directive / agency',
        examples: ['you can', 'you should', 'you need to', 'make sure you', 'here is what to do'],
    },
    revelation_signal: {
        const_name: 'REVELATION_SIGNAL_PHRASES',
        description: 'Reveal-language indicating the payoff is arriving now — "turns out", "what I found", "the secret is".',
        signal: 'Reveal / payoff arrival',
        examples: ['turns out', 'what i discovered', 'what i learned', 'the truth is', 'the secret is'],
    },
    curiosity_escalation: {
        const_name: 'CURIOSITY_ESCALATION_PHRASES',
        description: 'Layered "but wait, there\'s more" language that adds new open-loops mid-video.',
        signal: 'Curiosity escalation',
        examples: ['but that is not all', 'and there is more', 'it gets better', 'the craziest part', 'oh and by the way'],
    },
    cliffhanger: {
        const_name: 'CLIFFHANGER_PHRASES',
        description: 'Scene-break cliffhanger language — "but wait", "and then", "what happened next", "the twist".',
        signal: 'Cliffhanger / scene break',
        examples: ['but wait', 'suddenly', 'little did i know', 'what happened next', 'here is the twist'],
    },
    payoff_tease: {
        const_name: 'PAYOFF_TEASE_PHRASES',
        description: 'Teasers of the eventual payoff — "spoiler", "at the end", "the big reveal".',
        signal: 'Payoff teasing',
        examples: ['spoiler', 'at the end', 'fast forward', 'final result', 'the big reveal'],
    },
    social_signal: {
        const_name: 'SOCIAL_SIGNAL_PHRASES',
        description: 'Crowd-scale vocabulary — "millions", "viral", "everyone", "subscribers".',
        signal: 'Audience-scale signal',
        examples: ['million', 'viral', 'everyone', 'people are saying', 'subscribers'],
    },
    narrative_anchor: {
        const_name: 'NARRATIVE_ANCHOR_PHRASES',
        description: 'Temporal-anchor "this is the moment" language that foregrounds a pivotal beat.',
        signal: 'Moment-marker / narrative anchor',
        examples: ['this is the moment', 'this is where', 'at this point', 'this is it', 'this is when'],
    },
    delayed_reveal: {
        const_name: 'DELAYED_REVEAL_PHRASES',
        description: 'Explicit-delay language — "before I tell you", "hold on", "in just a moment".',
        signal: 'Payoff deferral',
        examples: ["i'll tell you in a second", 'keep watching', 'before i tell you', 'but first', 'hold on'],
    },
    proof_arrival: {
        const_name: 'PROOF_ARRIVAL_PHRASES',
        description: 'Evidence-is-here language — "look at this", "it worked", "i tested" — at the moment proof appears.',
        signal: 'Proof arrival',
        examples: ['look at this', 'right here', 'the result', 'it worked', 'i tested'],
    },
    early_proof: {
        const_name: 'EARLY_PROOF_PHRASES',
        description: 'Proof language surfaced in the opening section — credibility delivered up front.',
        signal: 'Early proof placement',
        examples: ['i tested', 'i tried', 'the result', 'it worked', 'after doing this'],
    },
    narrative_tension: {
        const_name: 'NARRATIVE_TENSION_PHRASES',
        description: 'Sustained-tension language — stakes-heavy adjectives and cliff-edge framings.',
        signal: 'Narrative tension',
        examples: ['the problem is', 'on edge', 'no way out', 'running out of time', 'one shot'],
    },
    challenge_statement: {
        const_name: 'CHALLENGE_STATEMENT_PHRASES',
        description: 'Statements that explicitly frame a goal/obstacle — "the challenge is", "I need to", "attempting".',
        signal: 'Challenge framing',
        examples: ['the challenge is', 'the goal is', 'i need to', 'attempting to', 'the mission'],
    },
    stakes_escalation: {
        const_name: 'STAKES_ESCALATION_PHRASES',
        description: 'Stakes-raising turns — "it gets worse", "everything changed", "out of nowhere".',
        signal: 'Stakes escalation',
        examples: ['it gets worse', 'but then', 'everything changed', 'out of nowhere', 'and i realized'],
    },
    tension_ratchet: {
        const_name: 'ZYGARNIK_PHRASE_SETS.tension_ratchet',
        description: 'Layered tension-escalation — "little did I know", "the real problem", "stakes just went up".',
        signal: 'Tension ratchet',
        examples: ['it gets worse', 'little did i know', 'and then everything changed', 'what happened next', 'the real problem'],
    },
    story_clock: {
        const_name: 'ZYGARNIK_PHRASE_SETS.story_clock',
        description: 'Explicit time-to-payoff framing — "by the end", "in the next", "stay till the end".',
        signal: 'Story clock / promise-of-later-payoff',
        examples: ['by the end of this', 'in the next', 'within minutes', 'stay till the end', 'keep watching'],
    },
    promise_echo: {
        const_name: 'ZYGARNIK_PHRASE_SETS.promise_echo',
        description: 'Reminder-of-earlier-promise callbacks — "remember what I said", "as promised", "circling back".',
        signal: 'Promise echo',
        examples: ['remember what i said', 'as i promised', 'i told you', 'circling back', 'as promised'],
    },
    proof_build: {
        const_name: 'ZYGARNIK_PHRASE_SETS.proof_build',
        description: 'Evidence-stacking language — "here\'s another", "on top of that", "also".',
        signal: 'Proof stacking',
        examples: ['here is another', 'on top of that', 'also', 'not only that', 'what is more'],
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

    // Additional families — each stem is the registry key prefix used
    // by jarvis-metrics.js when naming count/density/window variants.
    action_verb: 'action_verb',
    anticipation: 'anticipation',
    anticipatory_build: 'anticipatory_build',
    counterintuitive: 'counterintuitive',
    confession: 'confession',
    escalation: 'escalation',
    specificity_phrase: 'specificity_phrase',
    callback: 'callback',
    urgency_signal: 'urgency_signal',
    rhetorical_question: 'rhetorical_question',
    social_comparison: 'social_comparison',
    transformation_arc: 'transformation_arc',
    loss_framing: 'loss_framing',
    mystery_setup: 'mystery_setup',
    promise_specificity: 'promise_specificity',
    pattern_interrupt: 'pattern_interrupt',
    viewer_stakes: 'viewer_stakes',
    commitment_device: 'commitment_device',
    curiosity_gap: 'curiosity_gap',
    stakes_reinforcement: 'stakes_reinforcement',
    viewer_agency: 'viewer_agency',
    revelation_signal: 'revelation_signal',
    curiosity_escalation: 'curiosity_escalation',
    cliffhanger: 'cliffhanger',
    payoff_tease: 'payoff_tease',
    social_signal: 'social_signal',
    narrative_anchor: 'narrative_anchor',
    delayed_reveal: 'delayed_reveal',
    proof_arrival: 'proof_arrival',
    early_proof: 'early_proof',
    narrative_tension: 'narrative_tension',
    challenge_statement: 'challenge_statement',
    stakes_escalation: 'stakes_escalation',
    tension_ratchet: 'tension_ratchet',
    story_clock: 'story_clock',
    promise_echo: 'promise_echo',
    proof_build: 'proof_build',
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

    // ── Additional window / measure suffixes ───────────────────────────
    // Each entry is a small window / transform applied to a phrase family.
    // Atomic inputs: transcript words (lowercased) + the family's phrase list.
    // Physical evidence: every hit is a substring match inside the chosen
    // word-slice. Formula style: windowed countPhraseMatches (optionally
    // divided by that window's word count for density).
    {
        style: 'count_first_third',
        suffix_regex: /^_count_first_third$/,
        label: 'First-third count (0–33%)',
        describe: () => 'Phrase matches in the first third of the transcript by word index.',
        formula: 'countPhraseMatches(words[0 : floor(N/3)].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (first-third slice)',
        expected_range: '0 to ~30',
    },
    {
        style: 'count_mid_third',
        suffix_regex: /^_count_mid_third$/,
        label: 'Mid-third count (33–67%)',
        describe: () => 'Phrase matches in the middle third of the transcript by word index.',
        formula: 'countPhraseMatches(words[N/3 : 2N/3].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (middle-third slice)',
        expected_range: '0 to ~30',
    },
    {
        style: 'count_last_third',
        suffix_regex: /^_count_last_third$/,
        label: 'Last-third count (67–100%)',
        describe: () => 'Phrase matches in the final third of the transcript by word index.',
        formula: 'countPhraseMatches(words[2N/3 : N].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (last-third slice)',
        expected_range: '0 to ~30',
    },
    {
        style: 'count_second_half',
        suffix_regex: /^_count_second_half$/,
        label: 'Second-half count (50–100%)',
        describe: () => 'Phrase matches in the second half of the transcript by word index.',
        formula: 'countPhraseMatches(words[N/2 : N].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (second-half slice)',
        expected_range: '0 to ~50',
    },
    {
        style: 'count_second_quarter',
        suffix_regex: /^_count_second_quarter$/,
        label: 'Second-quarter count (25–50%)',
        describe: () => 'Phrase matches in the second quarter of the transcript.',
        formula: 'countPhraseMatches(words[N/4 : N/2].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (second-quarter slice)',
        expected_range: '0 to ~30',
    },
    {
        style: 'count_third_quarter',
        suffix_regex: /^_count_third_quarter$/,
        label: 'Third-quarter count (50–75%)',
        describe: () => 'Phrase matches in the third quarter of the transcript.',
        formula: 'countPhraseMatches(words[N/2 : 3N/4].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (third-quarter slice)',
        expected_range: '0 to ~30',
    },
    // Order-flipped aliases: jarvis-metrics.js sometimes names keys
    // "<window>_count" instead of "count_<window>". Same formula, same
    // atomic evidence, different spelling.
    {
        style: 'hook_count',
        suffix_regex: /^_hook_count$/,
        label: 'Hook-window count (first 10%)',
        describe: () => 'Phrase matches in the first 10% of the transcript — order-flipped alias of _count_hook.',
        formula: 'countPhraseMatches(words[0 : ceil(N*0.10)].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (hook slice)',
        expected_range: '0 to ~20',
    },
    {
        style: 'first_half_count',
        suffix_regex: /^_first_half_count$/,
        label: 'First-half count (0–50%)',
        describe: () => 'Phrase matches in the first half of the transcript — alias spelling of _count_first_half.',
        formula: 'countPhraseMatches(words[0 : N/2].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (first-half slice)',
        expected_range: '0 to ~50',
    },
    {
        style: 'second_half_count',
        suffix_regex: /^_second_half_count$/,
        label: 'Second-half count (50–100%)',
        describe: () => 'Phrase matches in the second half of the transcript — alias spelling of _count_second_half.',
        formula: 'countPhraseMatches(words[N/2 : N].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (second-half slice)',
        expected_range: '0 to ~50',
    },
    {
        style: 'last_third_count',
        suffix_regex: /^_last_third_count$/,
        label: 'Last-third count (67–100%)',
        describe: () => 'Phrase matches in the final third of the transcript — alias spelling of _count_last_third.',
        formula: 'countPhraseMatches(words[2N/3 : N].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (last-third slice)',
        expected_range: '0 to ~30',
    },
    {
        style: 'first_half_density',
        suffix_regex: /^_first_half_density$/,
        label: 'First-half density',
        describe: () => 'Phrase density (matches per word) in the first half of the transcript.',
        formula: 'count_first_half / words_in_first_half',
        modality: 'transcript.fullText (first-half slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'front_half_density',
        suffix_regex: /^_front_half_density$/,
        label: 'Front-half density',
        describe: () => 'Phrase density in the front half of the transcript — alias of first_half_density used by loop-style metrics.',
        formula: 'count_front_half / words_in_front_half',
        modality: 'transcript.fullText (front-half slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_first_quarter',
        suffix_regex: /^_density_first_quarter$/,
        label: 'First-quarter density',
        describe: () => 'Phrase density within the first 25% of the transcript.',
        formula: 'count_first_quarter / words_in_first_quarter',
        modality: 'transcript.fullText (first-quarter slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_first_third',
        suffix_regex: /^_density_first_third$/,
        label: 'First-third density',
        describe: () => 'Phrase density within the first third of the transcript.',
        formula: 'count_first_third / words_in_first_third',
        modality: 'transcript.fullText (first-third slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_first_half',
        suffix_regex: /^_density_first_half$/,
        label: 'First-half density',
        describe: () => 'Phrase density within the first half of the transcript.',
        formula: 'count_first_half / words_in_first_half',
        modality: 'transcript.fullText (first-half slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_second_half',
        suffix_regex: /^_density_second_half$/,
        label: 'Second-half density',
        describe: () => 'Phrase density within the second half of the transcript.',
        formula: 'count_second_half / words_in_second_half',
        modality: 'transcript.fullText (second-half slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_second_quarter',
        suffix_regex: /^_density_second_quarter$/,
        label: 'Second-quarter density',
        describe: () => 'Phrase density within the 25–50% slice of the transcript.',
        formula: 'count_second_quarter / words_in_second_quarter',
        modality: 'transcript.fullText (second-quarter slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_third_quarter',
        suffix_regex: /^_density_third_quarter$/,
        label: 'Third-quarter density',
        describe: () => 'Phrase density within the 50–75% slice of the transcript.',
        formula: 'count_third_quarter / words_in_third_quarter',
        modality: 'transcript.fullText (third-quarter slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_last_third',
        suffix_regex: /^_density_last_third$/,
        label: 'Last-third density',
        describe: () => 'Phrase density within the final third of the transcript.',
        formula: 'count_last_third / words_in_last_third',
        modality: 'transcript.fullText (last-third slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_mid',
        suffix_regex: /^_density_mid$/,
        label: 'Mid-section density',
        describe: () => 'Phrase density in the middle of the transcript (typical windowing: middle third).',
        formula: 'count_mid / words_in_mid',
        modality: 'transcript.fullText (middle slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_mid_third',
        suffix_regex: /^_density_mid_third$/,
        label: 'Middle-third density',
        describe: () => 'Phrase density inside the 33–67% window.',
        formula: 'count_mid_third / words_in_mid_third',
        modality: 'transcript.fullText (middle-third slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'density_post_midpoint',
        suffix_regex: /^_density_post_midpoint$/,
        label: 'Post-midpoint density',
        describe: () => 'Phrase density across everything past the midpoint — alias of density_second_half for metrics named by position.',
        formula: 'count_post_midpoint / words_post_midpoint',
        modality: 'transcript.fullText (post-midpoint slice)',
        expected_range: '0 to 0.1',
    },
    {
        style: 'rate_per_min',
        suffix_regex: /^_rate_per_min$/,
        label: 'Rate per minute',
        describe: () => 'Phrase matches divided by video duration in minutes. Atomic inputs: total count + meta.duration.',
        formula: 'total_count / (meta.duration / 60)',
        modality: 'transcript.fullText + metadata.duration',
        expected_range: '0 to ~20',
    },
    {
        style: 'acceleration',
        suffix_regex: /^_acceleration$/,
        label: 'Acceleration (2nd-half density / 1st-half density)',
        describe: () => 'Second-half density divided by first-half density — > 1 means the family accelerates through the video.',
        formula: '(count_second_half / words_second_half) / (count_first_half / words_first_half + epsilon)',
        modality: 'transcript.fullText (halves)',
        expected_range: '0.1 to 10',
    },
    {
        style: 'flag',
        suffix_regex: /^_flag$/,
        label: 'Presence flag (0/1)',
        describe: () => 'Binary indicator: 1 if any phrase-family match is present, 0 otherwise. Atomic evidence: at least one hit anywhere in the transcript.',
        formula: 'countPhraseMatches(transcript, FAMILY_PHRASES) > 0 ? 1 : 0',
        modality: 'transcript.fullText',
        expected_range: '0 or 1',
    },
    {
        style: 'hook_flag',
        suffix_regex: /^_hook_flag$/,
        label: 'Hook-window presence flag (0/1)',
        describe: () => 'Binary indicator: 1 if any match falls inside the first-10% hook slice.',
        formula: 'countPhraseMatches(hook_slice, FAMILY_PHRASES) > 0 ? 1 : 0',
        modality: 'transcript.fullText (hook slice)',
        expected_range: '0 or 1',
    },
    {
        style: 'diversity',
        suffix_regex: /^_diversity$/,
        label: 'Phrase diversity (distinct phrases used)',
        describe: () => 'Number of distinct phrases from the family that each appear at least once — measures breadth rather than volume.',
        formula: 'sum(1 for p in FAMILY_PHRASES if transcript.includes(p))',
        modality: 'transcript.fullText',
        expected_range: '0 to len(FAMILY_PHRASES)',
    },
    // "phrase"-infixed count/density aliases — families whose metric keys
    // literally contain `_phrase_` between stem and suffix (e.g.
    // escalation_phrase_count, anticipation_phrase_density).
    {
        style: 'phrase_count',
        suffix_regex: /^_phrase_count$/,
        label: 'Raw phrase count (full transcript)',
        describe: () => 'Phrase matches across the entire transcript — alias form where the registry key embeds `_phrase_` between the family stem and the measure.',
        formula: 'countPhraseMatches(transcript.toLowerCase(), FAMILY_PHRASES)',
        modality: 'transcript.fullText',
        expected_range: '0 to ~100',
    },
    {
        style: 'phrase_density',
        suffix_regex: /^_phrase_density$/,
        label: 'Phrase density (full transcript)',
        describe: () => 'Phrase matches / word_count — `_phrase_` infix spelling of density.',
        formula: 'countPhraseMatches(transcript, FAMILY_PHRASES) / word_count',
        modality: 'transcript.fullText',
        expected_range: '0 to 0.05',
    },
    {
        style: 'phrase_count_first_Ns',
        suffix_regex: /^_phrase_count_first(\d+)s$/,
        label: (m) => `Phrase count in first ${m[1]} seconds`,
        describe: (m) => `Phrase matches in the first ${m[1]} seconds — alias form with _phrase_ infix.`,
        formula: (m) => `countPhraseMatches(words[0 : wordsIn${m[1]}s].join(" "), FAMILY_PHRASES)`,
        modality: 'transcript.fullText (first-N-sec slice)',
        expected_range: '0 to ~20',
    },
    {
        style: 'phrase_count_first_half',
        suffix_regex: /^_phrase_count_first_half$/,
        label: 'Phrase count in first half',
        describe: () => 'Phrase matches in the first half — alias form with `_phrase_` infix.',
        formula: 'countPhraseMatches(words[0 : N/2].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (first-half slice)',
        expected_range: '0 to ~50',
    },
    {
        style: 'phrase_count_hook',
        suffix_regex: /^_phrase_count_hook$/,
        label: 'Phrase count in hook (first 10%)',
        describe: () => 'Phrase matches in the first 10% — alias form with `_phrase_` infix.',
        formula: 'countPhraseMatches(hook_slice, FAMILY_PHRASES)',
        modality: 'transcript.fullText (hook slice)',
        expected_range: '0 to ~20',
    },
    {
        style: 'phrase_diversity',
        suffix_regex: /^_phrase_diversity$/,
        label: 'Phrase diversity (distinct)',
        describe: () => 'Count of distinct phrases from the family that each appear at least once — alias form with `_phrase_` infix.',
        formula: 'sum(1 for p in FAMILY_PHRASES if transcript.includes(p))',
        modality: 'transcript.fullText',
        expected_range: '0 to len(FAMILY_PHRASES)',
    },
    // "signal"-infixed aliases — keys like confession_signal_count,
    // urgency_signal_count, revelation_signal_count.
    {
        style: 'signal_count',
        suffix_regex: /^_signal_count$/,
        label: 'Signal count (full transcript)',
        describe: () => 'Phrase matches across the entire transcript — alias form where the registry key embeds `_signal_` between the family stem and the measure.',
        formula: 'countPhraseMatches(transcript.toLowerCase(), FAMILY_PHRASES)',
        modality: 'transcript.fullText',
        expected_range: '0 to ~100',
    },
    {
        style: 'signal_density',
        suffix_regex: /^_signal_density$/,
        label: 'Signal density (full transcript)',
        describe: () => 'Phrase matches / word_count — `_signal_` infix spelling of density.',
        formula: 'countPhraseMatches(transcript, FAMILY_PHRASES) / word_count',
        modality: 'transcript.fullText',
        expected_range: '0 to 0.05',
    },
    {
        style: 'signal_hook_count',
        suffix_regex: /^_signal_hook_count$/,
        label: 'Signal count in hook',
        describe: () => 'Phrase matches in the first 10% — `_signal_` infix + hook window.',
        formula: 'countPhraseMatches(hook_slice, FAMILY_PHRASES)',
        modality: 'transcript.fullText (hook slice)',
        expected_range: '0 to ~20',
    },
    {
        style: 'signal_first_half_count',
        suffix_regex: /^_signal_first_half_count$/,
        label: 'Signal count in first half',
        describe: () => 'Phrase matches in the first half of the transcript — `_signal_` infix + first-half window.',
        formula: 'countPhraseMatches(words[0 : N/2].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (first-half slice)',
        expected_range: '0 to ~50',
    },
    // "arc"-infixed aliases for transformation_arc_*
    {
        style: 'arc_count',
        suffix_regex: /^_arc_count$/,
        label: 'Arc count',
        describe: () => 'Phrase matches across the entire transcript — `_arc_` infix form used by transformation-style families.',
        formula: 'countPhraseMatches(transcript, FAMILY_PHRASES)',
        modality: 'transcript.fullText',
        expected_range: '0 to ~100',
    },
    {
        style: 'arc_density',
        suffix_regex: /^_arc_density$/,
        label: 'Arc density',
        describe: () => 'Phrase matches / word_count — `_arc_` infix form.',
        formula: 'countPhraseMatches(transcript, FAMILY_PHRASES) / word_count',
        modality: 'transcript.fullText',
        expected_range: '0 to 0.05',
    },
    {
        style: 'arc_flag',
        suffix_regex: /^_arc_flag$/,
        label: 'Arc presence flag (0/1)',
        describe: () => 'Binary: 1 if any family phrase appears at all, 0 otherwise.',
        formula: 'countPhraseMatches(transcript, FAMILY_PHRASES) > 0 ? 1 : 0',
        modality: 'transcript.fullText',
        expected_range: '0 or 1',
    },
    {
        style: 'arc_hook_count',
        suffix_regex: /^_arc_hook_count$/,
        label: 'Arc count in hook',
        describe: () => 'Phrase matches in the first 10% — `_arc_` infix + hook window.',
        formula: 'countPhraseMatches(hook_slice, FAMILY_PHRASES)',
        modality: 'transcript.fullText (hook slice)',
        expected_range: '0 to ~20',
    },
    {
        style: 'arc_first_half_count',
        suffix_regex: /^_arc_first_half_count$/,
        label: 'Arc count in first half',
        describe: () => 'Phrase matches in the first half — `_arc_` infix + first-half window.',
        formula: 'countPhraseMatches(words[0 : N/2].join(" "), FAMILY_PHRASES)',
        modality: 'transcript.fullText (first-half slice)',
        expected_range: '0 to ~50',
    },
    // First-Nsec "signal" infix (used by story_clock_count_first10s style)
    {
        style: 'count_first_Ns_alias',
        suffix_regex: /^_count_first_(\d+)s$/,
        label: (m) => `Count in first ${m[1]} seconds (underscore variant)`,
        describe: (m) => `Phrase matches in the first ${m[1]} seconds — underscore-separated spelling (story_clock_count_first_10s form).`,
        formula: (m) => `countPhraseMatches(words[0 : wordsIn${m[1]}s].join(" "), FAMILY_PHRASES)`,
        modality: 'transcript.fullText (first-N-sec slice)',
        expected_range: '0 to ~20',
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
        name: 'bridge_metric',
        // Bridge metrics link a pre-upload indicator (something measurable
        // from transcript/title/hook *before* publishing) to a post-upload
        // indicator (retention, shares, views…). The registry spelling is
        // `bridge__PRE__POST`.
        regex: /^bridge__(.+?)__(.+)$/,
        describe: (m) => ({
            label: `Bridge: ${m[1]} → ${m[2]}`,
            description: `Bridge metric that chains a pre-upload indicator ("${m[1]}") to a post-upload indicator ("${m[2]}"). The value is the chained correlation (r_pre→target × r_post→target) or the stacked score computed during bridge validation. Use this to reason about which hook-side levers plausibly cause which retention-side outcome — not a raw transcript count.`,
            formula: `bridge(${m[1]} → ${m[2]}): chain score combining r(${m[1]}, target) and r(${m[2]}, target), or the product of the two component correlations when stacked.`,
            modality: 'derived — pre-side indicator × post-side indicator',
            quantification: 'Bridge / chain correlation',
            components: [m[1], m[2]],
            source_fields: [`variable:${m[1]} (pre-upload)`, `variable:${m[2]} (post-upload)`],
            expected_range: '-1 to 1 (correlation-like)',
            bridge_roles: { pre: m[1], post: m[2] },
        }),
    },
    {
        name: 'retention_percentile_Npct',
        regex: /^retention_(\d+)pct$/,
        describe: (m) => ({
            label: `Retention at ${m[1]}%`,
            description: `YouTube audience-retention value at the ${m[1]}% position of the video — alias spelling of retention_pct_${m[1]}. Atomic input: analytics.retentionCurve.`,
            formula: `retentionCurve[${m[1]}].retention`,
            modality: 'analytics.retentionCurve',
            quantification: 'Retention percentile point',
            source_fields: ['analytics.retentionCurve'],
            expected_range: '0 to 2.0',
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

    // ── Visual / frame-based metrics ────────────────────────────────────
    action_frame_pct: {
        label: 'Action Frame %',
        description: 'Share of sampled video frames whose vision-LLM scene description or visual-technique tag contains action vocabulary (running, jumping, breaking, crashing, …). Physical evidence: each frame either matches or does not, so the fraction is grounded in frame-by-frame decisions.',
        formula: 'frames.filter(f => ACTION_WORDS matches sceneDescription or visualTechniques).length / frames.length',
        modality: 'vision frames (per-frame scene description)',
        quantification: 'Ratio (0–1) of action-tagged frames',
        source_fields: ['frames[].analysis.sceneDescription', 'frames[].analysis.visualTechniques', 'phrase_list:ACTION_WORDS (in-code)'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    anticipatory_frame_pct: {
        label: 'Anticipatory Frame %',
        description: 'Share of sampled frames whose vision engagement-analysis or scene-description contains anticipatory vocabulary (anticipation, tension, suspense, curiosity, intrigue, hook). A windowing-style visual metric: per-frame boolean, averaged across all frames.',
        formula: 'frames.filter(f => ANTICIPATORY_WORDS matches engagementAnalysis or sceneDescription).length / frames.length',
        modality: 'vision frames (engagement analysis)',
        quantification: 'Ratio (0–1) of anticipation-tagged frames',
        source_fields: ['frames[].analysis.engagementAnalysis', 'frames[].analysis.sceneDescription'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    setup_visual_frame_count: {
        label: 'Setup Visual Frame Count',
        description: 'Number of sampled frames whose scene description contains setup vocabulary (setup, preparing, arranging, positioning) — counts "about to start" framings in the visual stream.',
        formula: 'frames.filter(f => SETUP_WORDS matches sceneDescription).length',
        modality: 'vision frames (scene description)',
        quantification: 'Count',
        source_fields: ['frames[].analysis.sceneDescription'],
        expected_range: '0 to frames.length',
        layer: 'pre',
    },
    close_up_frame_pct: {
        label: 'Close-up Frame %',
        description: 'Share of frames whose vision scene-description contains close-up / macro shot vocabulary. Physical evidence: per-frame visual classification.',
        formula: 'frames.filter(f => CLOSE_UP_WORDS matches sceneDescription).length / frames.length',
        modality: 'vision frames (scene description)',
        quantification: 'Ratio (0–1)',
        source_fields: ['frames[].analysis.sceneDescription'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    visual_entropy: {
        label: 'Visual Entropy',
        description: 'Diversity of visual content across sampled frames — computed from distinct scene-description tokens or visual-technique labels. High entropy = many different shot types; low entropy = repeated framings. Atomic input: per-frame vision tags.',
        formula: 'shannon_entropy(distribution of distinct scene_description / visual_technique tokens across frames)',
        modality: 'vision frames (token distribution)',
        quantification: 'Shannon entropy (nats or bits)',
        source_fields: ['frames[].analysis.sceneDescription', 'frames[].analysis.visualTechniques'],
        expected_range: '0 to ~5',
        layer: 'pre',
    },
    visual_complexity: {
        label: 'Visual Complexity',
        description: 'Average per-frame visual complexity derived from number of distinct objects / text regions / motion cues flagged by the vision model.',
        formula: 'mean(frames[].analysis.complexityScore)',
        modality: 'vision frames (complexity score)',
        quantification: 'Mean score',
        source_fields: ['frames[].analysis.complexityScore'],
        expected_range: '0 to 10',
        layer: 'pre',
    },
    visual_stake_frame_pct: {
        label: 'Visual Stake Frame %',
        description: 'Share of frames whose scene description contains high-stakes vocabulary (danger, risk, fall, crash, peak).',
        formula: 'frames.filter(f => STAKE_WORDS matches sceneDescription).length / frames.length',
        modality: 'vision frames',
        quantification: 'Ratio (0–1)',
        source_fields: ['frames[].analysis.sceneDescription'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    face_frame_pct: {
        label: 'Face Frame %',
        description: 'Share of frames where the vision model detected at least one face.',
        formula: 'frames.filter(f => f.analysis.hasFace).length / frames.length',
        modality: 'vision frames (face detection)',
        quantification: 'Ratio (0–1)',
        source_fields: ['frames[].analysis.hasFace'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    hand_presence_frame_pct: {
        label: 'Hand Presence Frame %',
        description: 'Share of frames where the vision model detected at least one hand — useful as a "hands-on demo" indicator.',
        formula: 'frames.filter(f => f.analysis.hasHands).length / frames.length',
        modality: 'vision frames',
        quantification: 'Ratio (0–1)',
        source_fields: ['frames[].analysis.hasHands'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    motion_word_frame_pct: {
        label: 'Motion Word Frame %',
        description: 'Share of frames whose scene description matches MOTION_KEYWORDS (move, spin, fly, throw, …).',
        formula: 'frames.filter(f => MOTION_KEYWORDS matches sceneDescription).length / frames.length',
        modality: 'vision frames',
        quantification: 'Ratio (0–1)',
        source_fields: ['frames[].analysis.sceneDescription', 'phrase_list:MOTION_KEYWORDS'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    text_overlay_frame_pct: {
        label: 'Text Overlay Frame %',
        description: 'Share of frames where on-screen text overlay was detected.',
        formula: 'frames.filter(f => f.analysis.hasTextOverlay).length / frames.length',
        modality: 'vision frames',
        quantification: 'Ratio (0–1)',
        source_fields: ['frames[].analysis.hasTextOverlay'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    scene_change_count: {
        label: 'Scene Change Count',
        description: 'Number of detected scene transitions across the video — derived from frame-to-frame visual-similarity drops.',
        formula: 'count(i where visualDistance(frames[i], frames[i+1]) > threshold)',
        modality: 'vision frames (sequential comparison)',
        quantification: 'Count',
        source_fields: ['frames[].analysis'],
        expected_range: '0 to ~200',
        layer: 'pre',
    },
    scene_change_rate: {
        label: 'Scene Change Rate (per minute)',
        description: 'Scene changes per minute of video duration.',
        formula: 'scene_change_count / (meta.duration / 60)',
        modality: 'derived — vision + metadata',
        quantification: 'Rate per minute',
        source_fields: ['frames[]', 'metadata.duration'],
        expected_range: '0 to ~60',
        layer: 'pre',
    },
    unique_scene_ratio: {
        label: 'Unique Scene Ratio',
        description: 'Distinct scene-description tokens divided by total frame count. A frame-windowing visual-variety metric.',
        formula: 'len(set(frames[].analysis.sceneDescription)) / frames.length',
        modality: 'vision frames',
        quantification: 'Ratio (0–1)',
        source_fields: ['frames[].analysis.sceneDescription'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    visual_technique_count_mean: {
        label: 'Visual Technique Count (mean per frame)',
        description: 'Mean number of distinct visual-technique labels the vision model emitted per frame.',
        formula: 'mean(len(frames[i].analysis.visualTechniques))',
        modality: 'vision frames',
        quantification: 'Mean count',
        source_fields: ['frames[].analysis.visualTechniques'],
        expected_range: '0 to ~5',
        layer: 'pre',
    },

    // ── Beat / pacing metrics ───────────────────────────────────────────
    // Beats = discrete pacing events (scene changes, emphasis spikes, or
    // semantic segment boundaries). Atomic inputs: beat timestamps derived
    // from segments[] or vision change-detection.
    beat_count: {
        label: 'Beat Count',
        description: 'Total count of pacing beats detected across the video. Beats are discrete emphasis events — segment boundaries, scene changes, or phrase-based pivot markers. Physical evidence: each beat has a timestamp.',
        formula: 'beats.length  (beats = segments[] boundaries ∪ scene_changes ∪ pivot_phrase positions)',
        modality: 'derived — segments / frames / transcript',
        quantification: 'Count',
        source_fields: ['segments[]', 'frames[]', 'transcript.fullText'],
        expected_range: '0 to ~200',
        layer: 'pre',
    },
    beat_density_per_minute: {
        label: 'Beat Density (per minute)',
        description: 'Beats per minute of video duration. Windowing-style formula: total beats normalized by duration.',
        formula: 'beat_count / (meta.duration / 60)',
        modality: 'derived — beat list + metadata',
        quantification: 'Rate per minute',
        source_fields: ['beats[]', 'metadata.duration'],
        expected_range: '0 to ~60',
        layer: 'pre',
    },
    beat_acceleration: {
        label: 'Beat Acceleration (2nd half / 1st half)',
        description: 'Density of beats in the second half divided by density in the first half. Values > 1 mean pacing tightens toward the end; < 1 means it loosens. Halves-style ratio grounded in beat timestamps.',
        formula: '(beats_in_second_half / half_duration_min) / (beats_in_first_half / half_duration_min + epsilon)',
        modality: 'derived — beat timestamps + duration halves',
        quantification: 'Ratio (halves)',
        source_fields: ['beats[]', 'metadata.duration'],
        expected_range: '0.1 to 10',
        layer: 'pre',
    },
    beat_cadence_variance: {
        label: 'Beat Cadence Variance',
        description: 'Variance of inter-beat intervals. Low variance = metronomic pacing; high variance = uneven pacing with long-hold + rapid-fire mixes. Atomic input: consecutive beat timestamps.',
        formula: 'variance([beats[i+1].t - beats[i].t for i in 0..len(beats)-1])',
        modality: 'derived — beat timestamps',
        quantification: 'Variance (seconds²)',
        source_fields: ['beats[]'],
        expected_range: '0 to ~100',
        layer: 'pre',
    },

    // ── Average-style metrics ───────────────────────────────────────────
    avg_percent_viewed: {
        label: 'Avg. % Viewed',
        description: 'Average fraction of the video each viewer watched, averaged across viewers. This is the single-number retention that YouTube publishes for a video.',
        formula: 'analytics.avgPercentViewed',
        modality: 'YouTube Analytics (retention)',
        quantification: '% (0–100)',
        source_fields: ['analytics.avgPercentViewed'],
        expected_range: '0 to 100',
        layer: 'post',
    },
    avg_view_duration_s: {
        label: 'Avg. View Duration (s)',
        description: 'Average watch time in seconds per view. Atomic input: total watch time / total views.',
        formula: 'analytics.totalWatchTimeSeconds / analytics.views',
        modality: 'YouTube Analytics',
        quantification: 'Seconds (mean)',
        source_fields: ['analytics.totalWatchTimeSeconds', 'analytics.views'],
        expected_range: '0 to duration_s',
        layer: 'post',
    },
    avg_segment_duration_s: {
        label: 'Avg. Segment Duration (s)',
        description: 'Mean duration of all named segments (hook, setup, reveal, payoff, …) — atomic inputs are each segment\'s startTime and endTime.',
        formula: 'mean(segments[].endTime - segments[].startTime)',
        modality: 'segments[]',
        quantification: 'Seconds (mean)',
        source_fields: ['segments[].startTime', 'segments[].endTime'],
        expected_range: '0 to ~300',
        layer: 'pre',
    },
    avg_word_gap_s: {
        label: 'Avg. Word Gap (s)',
        description: 'Mean pause between consecutive words in the transcript. Atomic inputs: per-word timestamps from the ASR layer. A pacing-proxy for silence / deliberation.',
        formula: 'mean(transcript.words[i+1].start - transcript.words[i].end)',
        modality: 'transcript.words (word-level timestamps)',
        quantification: 'Seconds (mean)',
        source_fields: ['transcript.words[].start', 'transcript.words[].end'],
        expected_range: '0 to ~2',
        layer: 'pre',
    },
    avg_word_length: {
        label: 'Avg. Word Length (chars)',
        description: 'Mean character length of words in the transcript — a simple vocabulary-complexity proxy.',
        formula: 'mean(transcript.split(/\\s+/).map(w => w.length))',
        modality: 'transcript.fullText',
        quantification: 'Characters (mean)',
        source_fields: ['transcript.fullText'],
        expected_range: '3 to 8',
        layer: 'pre',
    },

    // ── Other commonly-used single-value metrics ─────────────────────────
    transcript_char_count: {
        label: 'Transcript Character Count',
        description: 'Length of the full transcript in characters.',
        formula: 'transcript.length',
        modality: 'transcript.fullText',
        quantification: 'Count',
        source_fields: ['transcript.fullText'],
        expected_range: '0 to ~50000',
        layer: 'pre',
    },
    transcript_word_count: {
        label: 'Transcript Word Count',
        description: 'Word count of the full transcript.',
        formula: 'transcript.split(/\\s+/).filter(Boolean).length',
        modality: 'transcript.fullText',
        quantification: 'Count',
        source_fields: ['transcript.fullText'],
        expected_range: '0 to ~10000',
        layer: 'pre',
    },
    transcript_number_count: {
        label: 'Transcript Number Count',
        description: 'How many numeric tokens appear in the transcript — a numeric-specificity baseline.',
        formula: '(transcript.match(/\\d+/g) || []).length',
        modality: 'transcript.fullText',
        quantification: 'Count',
        source_fields: ['transcript.fullText'],
        expected_range: '0 to ~500',
        layer: 'pre',
    },
    unique_word_ratio: {
        label: 'Unique Word Ratio',
        description: 'Distinct lowercased words / total word count — vocabulary richness.',
        formula: 'len(set(transcript.lowercase().split(/\\s+/))) / word_count',
        modality: 'transcript.fullText',
        quantification: 'Ratio (0–1)',
        source_fields: ['transcript.fullText'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    sentence_count: {
        label: 'Sentence Count',
        description: 'Number of sentence-ending punctuation marks (. ! ?) in the transcript.',
        formula: '(transcript.match(/[.!?]/g) || []).length',
        modality: 'transcript.fullText',
        quantification: 'Count',
        source_fields: ['transcript.fullText'],
        expected_range: '0 to ~500',
        layer: 'pre',
    },
    exclamation_count: {
        label: 'Exclamation Count',
        description: 'Number of `!` characters in the transcript.',
        formula: '(transcript.match(/!/g) || []).length',
        modality: 'transcript.fullText',
        quantification: 'Count',
        source_fields: ['transcript.fullText'],
        expected_range: '0 to ~200',
        layer: 'pre',
    },
    question_count: {
        label: 'Question Count',
        description: 'Number of `?` characters in the transcript — rhetorical or literal questions combined.',
        formula: '(transcript.match(/\\?/g) || []).length',
        modality: 'transcript.fullText',
        quantification: 'Count',
        source_fields: ['transcript.fullText'],
        expected_range: '0 to ~100',
        layer: 'pre',
    },
    uppercase_word_ratio: {
        label: 'Uppercase Word Ratio',
        description: 'Fraction of words that are entirely uppercase (≥ 2 chars, at least one letter) — a shouty-emphasis proxy.',
        formula: 'count(words where w === w.toUpperCase() and has letter and length>=2) / word_count',
        modality: 'transcript.fullText',
        quantification: 'Ratio (0–1)',
        source_fields: ['transcript.fullText'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    hook_word_count: {
        label: 'Hook Word Count',
        description: 'Word count of the hook segment (or first ~5 seconds of transcript if no segment labelled "hook").',
        formula: 'hookSegment ? hookSegment.transcript.split(/\\s+/).length : firstNseconds(5).wordCount',
        modality: 'segments[label=hook] + transcript.fullText (fallback)',
        quantification: 'Count',
        source_fields: ['segments[]', 'transcript.fullText'],
        expected_range: '0 to ~200',
        layer: 'pre',
    },
    hook_char_count: {
        label: 'Hook Character Count',
        description: 'Character length of the hook segment text (or proportional slice of transcript if no explicit hook segment).',
        formula: 'hookSegment ? hookSegment.transcript.length : transcript.length / duration * 5',
        modality: 'segments[label=hook]',
        quantification: 'Count',
        source_fields: ['segments[]', 'transcript.fullText'],
        expected_range: '0 to ~1500',
        layer: 'pre',
    },
    hook_duration_s: {
        label: 'Hook Duration (s)',
        description: 'Duration of the segment labelled "hook" in seconds.',
        formula: 'hookSegment.endTime - hookSegment.startTime',
        modality: 'segments[label=hook]',
        quantification: 'Seconds',
        source_fields: ['segments[].startTime', 'segments[].endTime'],
        expected_range: '0 to ~30',
        layer: 'pre',
    },
    hook_duration_pct: {
        label: 'Hook Duration %',
        description: 'Hook-segment duration as a percentage of total video duration.',
        formula: '(hookSegment.endTime - hookSegment.startTime) / meta.duration * 100',
        modality: 'segments[label=hook] + metadata.duration',
        quantification: '% (0–100)',
        source_fields: ['segments[]', 'metadata.duration'],
        expected_range: '0 to 100',
        layer: 'pre',
    },
    hook_position_s: {
        label: 'Hook Position (s)',
        description: 'Start-time (seconds) of the hook segment.',
        formula: 'hookSegment.startTime',
        modality: 'segments[label=hook]',
        quantification: 'Seconds',
        source_fields: ['segments[].startTime'],
        expected_range: '0 to ~60',
        layer: 'pre',
    },
    hook_word_ratio: {
        label: 'Hook Word Ratio',
        description: 'Share of total transcript words that fall inside the hook slice.',
        formula: 'hook_word_count / total_word_count',
        modality: 'segments[] + transcript.fullText',
        quantification: 'Ratio (0–1)',
        source_fields: ['segments[]', 'transcript.fullText'],
        expected_range: '0 to 1',
        layer: 'pre',
    },
    hook_question_count: {
        label: 'Hook Question Count',
        description: 'Count of `?` characters inside the hook slice.',
        formula: '(hookText.match(/\\?/g) || []).length',
        modality: 'segments[label=hook] / transcript hook slice',
        quantification: 'Count',
        source_fields: ['segments[]', 'transcript.fullText'],
        expected_range: '0 to ~10',
        layer: 'pre',
    },
    duration_s: {
        label: 'Duration (s)',
        description: 'Total video length in seconds.',
        formula: 'metadata.duration',
        modality: 'metadata',
        quantification: 'Seconds',
        source_fields: ['metadata.duration'],
        expected_range: '1 to ~3600',
        layer: 'pre',
    },
    duration_log: {
        label: 'Duration (log)',
        description: 'log10(duration + 1) — log transform of duration for regression use.',
        formula: 'log10(metadata.duration + 1)',
        modality: 'metadata',
        quantification: 'log10 seconds',
        source_fields: ['metadata.duration'],
        expected_range: '0 to ~4',
        layer: 'pre',
    },
    segment_count: {
        label: 'Segment Count',
        description: 'Number of named segments in the video structure.',
        formula: 'segments.length',
        modality: 'segments[]',
        quantification: 'Count',
        source_fields: ['segments[]'],
        expected_range: '0 to ~20',
        layer: 'pre',
    },
    longest_segment_duration_s: {
        label: 'Longest Segment Duration (s)',
        description: 'Max segment duration (endTime − startTime) across segments[].',
        formula: 'max(segments[].endTime - segments[].startTime)',
        modality: 'segments[]',
        quantification: 'Seconds',
        source_fields: ['segments[].startTime', 'segments[].endTime'],
        expected_range: '0 to duration_s',
        layer: 'pre',
    },
    shortest_segment_duration_s: {
        label: 'Shortest Segment Duration (s)',
        description: 'Min segment duration across segments[].',
        formula: 'min(segments[].endTime - segments[].startTime)',
        modality: 'segments[]',
        quantification: 'Seconds',
        source_fields: ['segments[].startTime', 'segments[].endTime'],
        expected_range: '0 to duration_s',
        layer: 'pre',
    },
    speech_rate_wps: {
        label: 'Speech Rate (words/sec)',
        description: 'Total words divided by total duration.',
        formula: 'word_count / meta.duration',
        modality: 'transcript.fullText + metadata.duration',
        quantification: 'Rate (wps)',
        source_fields: ['transcript.fullText', 'metadata.duration'],
        expected_range: '0 to ~6',
        layer: 'pre',
    },
    opening_speech_rate_3s: {
        label: 'Opening Speech Rate (first 3s)',
        description: 'Words per second inside the first 3 seconds — measures up-front verbal density.',
        formula: 'wordsInFirst3s / 3',
        modality: 'transcript.fullText (first-3-sec slice) + metadata.duration',
        quantification: 'Rate (wps)',
        source_fields: ['transcript.fullText', 'metadata.duration'],
        expected_range: '0 to ~10',
        layer: 'pre',
    },
    max_silence_gap_s: {
        label: 'Max Silence Gap (s)',
        description: 'Longest estimated silent pause in the video — approximated from speech rate and segment boundaries when precise word timings are absent.',
        formula: 'approx: (duration - wordCount/2.5) / max(segmentCount, 1), clamped to [0, duration/2]',
        modality: 'transcript + segments + metadata',
        quantification: 'Seconds',
        source_fields: ['transcript.fullText', 'segments[]', 'metadata.duration'],
        expected_range: '0 to ~30',
        layer: 'pre',
    },
    title_char_count: {
        label: 'Title Character Count',
        description: 'Character length of the video title.',
        formula: 'metadata.title.length',
        modality: 'metadata.title',
        quantification: 'Count',
        source_fields: ['metadata.title'],
        expected_range: '0 to ~100',
        layer: 'pre',
    },
    title_word_count: {
        label: 'Title Word Count',
        description: 'Word count of the video title.',
        formula: 'metadata.title.split(/\\s+/).filter(Boolean).length',
        modality: 'metadata.title',
        quantification: 'Count',
        source_fields: ['metadata.title'],
        expected_range: '1 to ~20',
        layer: 'pre',
    },
    title_question_flag: {
        label: 'Title Has Question (0/1)',
        description: 'Binary: 1 if the title contains `?`.',
        formula: 'metadata.title.includes("?") ? 1 : 0',
        modality: 'metadata.title',
        quantification: '0 or 1',
        source_fields: ['metadata.title'],
        expected_range: '0 or 1',
        layer: 'pre',
    },
    title_exclamation_flag: {
        label: 'Title Has Exclamation (0/1)',
        description: 'Binary: 1 if the title contains `!`.',
        formula: 'metadata.title.includes("!") ? 1 : 0',
        modality: 'metadata.title',
        quantification: '0 or 1',
        source_fields: ['metadata.title'],
        expected_range: '0 or 1',
        layer: 'pre',
    },
    title_number_flag: {
        label: 'Title Has Number (0/1)',
        description: 'Binary: 1 if the title contains a digit.',
        formula: '/\\d/.test(metadata.title) ? 1 : 0',
        modality: 'metadata.title',
        quantification: '0 or 1',
        source_fields: ['metadata.title'],
        expected_range: '0 or 1',
        layer: 'pre',
    },

    // ── Retention-curve summaries ─────────────────────────────────────────
    retention_variance: {
        label: 'Retention Variance',
        description: 'Variance of the retention curve across all sampled points — noisier curves have higher variance.',
        formula: 'variance(retentionCurve[].retention)',
        modality: 'analytics.retentionCurve',
        quantification: 'Variance',
        source_fields: ['analytics.retentionCurve'],
        expected_range: '0 to ~0.5',
        layer: 'post',
    },
    retention_entropy: {
        label: 'Retention Entropy',
        description: 'Shannon entropy of the binned retention-value distribution — how spread-out the retention curve is.',
        formula: 'shannon_entropy(histogram(retentionCurve[].retention))',
        modality: 'analytics.retentionCurve',
        quantification: 'Entropy',
        source_fields: ['analytics.retentionCurve'],
        expected_range: '0 to ~5',
        layer: 'post',
    },
    retention_skew: {
        label: 'Retention Skew',
        description: 'Skewness of the retention-curve distribution — positive skew = retention concentrated early.',
        formula: 'skew(retentionCurve[].retention)',
        modality: 'analytics.retentionCurve',
        quantification: 'Skewness',
        source_fields: ['analytics.retentionCurve'],
        expected_range: '-5 to 5',
        layer: 'post',
    },
    end_recovery_score: {
        label: 'End Recovery Score',
        description: 'Linear-regression slope of retention across the final 10 points of the curve — positive = audience re-engaging at the end.',
        formula: 'linregress(x=[0..9], y=retentionCurve.tail(10).retention).slope',
        modality: 'analytics.retentionCurve',
        quantification: 'Slope',
        source_fields: ['analytics.retentionCurve'],
        expected_range: '-0.05 to 0.05',
        layer: 'post',
    },

    // ── Engagement-rate metrics ───────────────────────────────────────────
    like_rate: {
        label: 'Like Rate',
        description: 'Likes per 1,000 views.',
        formula: 'likes / (views / 1000)',
        modality: 'YouTube Analytics',
        quantification: 'Rate per 1k views',
        source_fields: ['analytics.likes', 'analytics.views'],
        expected_range: '0 to ~100',
        layer: 'post',
    },
    comment_rate: {
        label: 'Comment Rate',
        description: 'Comments per 1,000 views.',
        formula: 'comments / (views / 1000)',
        modality: 'YouTube Analytics',
        quantification: 'Rate per 1k views',
        source_fields: ['analytics.comments', 'analytics.views'],
        expected_range: '0 to ~50',
        layer: 'post',
    },
    swipe_away_rate: {
        label: 'Swipe-Away Rate',
        description: 'Fraction of impressions that resulted in a swipe-away before watching — inverse of keep rate.',
        formula: '1 - analytics.swipeRatio.stayedToWatch',
        modality: 'YouTube Analytics (impressions)',
        quantification: 'Ratio (0–1)',
        source_fields: ['analytics.swipeRatio.stayedToWatch'],
        expected_range: '0 to 1',
        layer: 'post',
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

    // 4) Fallback — we still try to infer *something* from naming clues.
    //    Pattern-based inference: look for well-known structural tokens
    //    (count, density, ratio, pct, first_half, hook, …) and surface
    //    whatever we can read off the name. Only reaches here when the
    //    key didn't match any family stem or explicit pattern rule above.
    const clues = inferStructuralClues(trimmedKey);
    return {
        key: trimmedKey,
        source: 'fallback',
        label: humanizeKey(trimmedKey),
        description: clues.length
            ? `No explicit catalog entry for "${trimmedKey}", but the key name contains recognizable clues: ${clues.map(c => c.display).join('; ')}. Best-guess interpretation: ${clues.map(c => c.interpretation).join(' ')}`
            : `No pattern match for "${trimmedKey}" and no structural clues recognized in the name. Add a static entry or a phrase family to make it self-describing.`,
        formula: trimmedKey,
        modality: clues.find(c => c.modality)?.modality || 'unknown',
        quantification: clues.find(c => c.quantification)?.quantification || 'unknown',
        source_fields: [],
        expected_range: clues.find(c => c.expected_range)?.expected_range || 'unknown',
        structural_clues: clues.map(c => c.token),
    };
}

// Tokens we try to spot inside an unknown key name. Each entry produces
// a small interpretive note so the fallback can still give the reader
// something actionable. Ordered so that more-specific tokens come first.
const STRUCTURAL_CLUE_TOKENS = [
    { token: 'front_load_ratio', display: 'front_load_ratio suffix', interpretation: 'Likely a ratio of first-half count to second-half count (front-loaded = > 1).', quantification: 'Front-load ratio', modality: 'transcript halves', expected_range: '0.1 to 10' },
    { token: 'first_quarter',    display: 'first_quarter window',    interpretation: 'Likely measured over the first 25% of the transcript.', modality: 'transcript.fullText (first-quarter slice)' },
    { token: 'first_third',      display: 'first_third window',      interpretation: 'Likely measured over the first 33% of the transcript.', modality: 'transcript.fullText (first-third slice)' },
    { token: 'first_half',       display: 'first_half window',       interpretation: 'Likely measured over the first 50% of the transcript.', modality: 'transcript.fullText (first-half slice)' },
    { token: 'second_half',      display: 'second_half window',      interpretation: 'Likely measured over the last 50% of the transcript.', modality: 'transcript.fullText (second-half slice)' },
    { token: 'second_quarter',   display: 'second_quarter window',   interpretation: 'Likely measured over the 25–50% slice.', modality: 'transcript.fullText (second-quarter slice)' },
    { token: 'third_quarter',    display: 'third_quarter window',    interpretation: 'Likely measured over the 50–75% slice.', modality: 'transcript.fullText (third-quarter slice)' },
    { token: 'last_quarter',     display: 'last_quarter window',     interpretation: 'Likely measured over the final 25% of the transcript.', modality: 'transcript.fullText (last-quarter slice)' },
    { token: 'last_third',       display: 'last_third window',       interpretation: 'Likely measured over the final 33% of the transcript.', modality: 'transcript.fullText (last-third slice)' },
    { token: 'mid_third',        display: 'mid_third window',        interpretation: 'Likely measured over the 33–67% slice.', modality: 'transcript.fullText (mid-third slice)' },
    { token: 'post_midpoint',    display: 'post_midpoint window',    interpretation: 'Likely measured over everything past the 50% mark.', modality: 'transcript.fullText (post-midpoint slice)' },
    { token: 'hook',             display: 'hook window',             interpretation: 'Likely measured over the first ~10% (or the explicit hook segment).', modality: 'hook slice' },
    { token: 'per_min',          display: 'rate_per_min suffix',     interpretation: 'Likely total count divided by duration in minutes.', quantification: 'Rate per minute' },
    { token: 'per_minute',       display: 'rate_per_min suffix',     interpretation: 'Likely total count divided by duration in minutes.', quantification: 'Rate per minute' },
    { token: 'density',          display: 'density suffix',          interpretation: 'Likely count normalized by word count (or duration).', quantification: 'Density (rate)', expected_range: '0 to 0.1' },
    { token: 'ratio',            display: 'ratio suffix',            interpretation: 'Likely a dimensionless ratio of two counts or durations.', quantification: 'Ratio' },
    { token: 'count',            display: 'count suffix',            interpretation: 'Likely a raw count.', quantification: 'Count' },
    { token: 'flag',             display: 'flag suffix',             interpretation: 'Likely a binary 0/1 indicator.', quantification: '0 or 1', expected_range: '0 or 1' },
    { token: 'pct',              display: 'pct suffix',              interpretation: 'Likely a percentage (0–100) or a position within the video.', quantification: '%' },
    { token: 'percentile',       display: 'percentile suffix',       interpretation: 'Likely a retention-curve sample at a specific video-position percentile.', quantification: 'Retention percentile point', modality: 'analytics.retentionCurve' },
    { token: 'score',            display: 'score suffix',            interpretation: 'Likely a derived scalar composed from other variables.' },
    { token: 'variance',         display: 'variance suffix',         interpretation: 'Likely a variance / dispersion measure.', quantification: 'Variance' },
    { token: 'slope',            display: 'slope suffix',            interpretation: 'Likely a linear-regression slope over a windowed slice.', quantification: 'Slope' },
    { token: 'mean',             display: 'mean suffix',             interpretation: 'Likely an average over a windowed slice.', quantification: 'Mean' },
    { token: 'peak',             display: 'peak suffix',             interpretation: 'Likely a maximum-value position or magnitude.' },
    { token: 'drop',             display: 'drop suffix',             interpretation: 'Likely a negative-going delta in a metric (retention drop, viewer drop, …).' },
    { token: 'retention',        display: 'retention prefix',        interpretation: 'Almost certainly derived from analytics.retentionCurve.', modality: 'analytics.retentionCurve' },
    { token: 'hook',             display: 'hook prefix',             interpretation: 'Almost certainly scoped to the hook segment / first ~10% slice.' },
    { token: 'title',            display: 'title prefix',            interpretation: 'Almost certainly derived from metadata.title.', modality: 'metadata.title' },
    { token: 'segment',          display: 'segment token',           interpretation: 'Likely derived from segments[] (named video structure).' },
    { token: 'frame',            display: 'frame token',             interpretation: 'Likely a per-frame visual metric from the vision model.', modality: 'vision frames' },
    { token: 'visual',           display: 'visual prefix',           interpretation: 'Likely a vision-derived metric.', modality: 'vision frames' },
    { token: 'duration',         display: 'duration token',          interpretation: 'Likely a seconds-valued duration read off segments or metadata.' },
    { token: 'zygarnik',         display: 'zygarnik prefix',         interpretation: 'Curiosity-gap / open-loop family metric.' },
];

function inferStructuralClues(key) {
    const seen = new Set();
    const hits = [];
    for (const c of STRUCTURAL_CLUE_TOKENS) {
        if (key.includes(c.token) && !seen.has(c.token)) {
            seen.add(c.token);
            hits.push(c);
        }
    }
    return hits;
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
