/**
 * jarvis-metrics.js — Node-native metric extraction + statistics for Jarvis pipeline.
 * Replaces numpy/scipy dependency for hosted Render execution.
 */

// ── Statistical helpers (no external deps) ───────────────────────────────

/** Simple mean */
function mean(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}

/** Population std dev (matches numpy.std default ddof=0) */
function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    let ss = 0;
    for (let i = 0; i < arr.length; i++) ss += (arr[i] - m) ** 2;
    return Math.sqrt(ss / arr.length);
}

/** Population variance (numpy.var ddof=0) */
function variance(arr) {
    if (!arr.length) return 0;
    const m = mean(arr);
    let ss = 0;
    for (let i = 0; i < arr.length; i++) ss += (arr[i] - m) ** 2;
    return ss / arr.length;
}

/** Simple linear regression: returns { slope, intercept } */
function linregress(x, y) {
    const n = x.length;
    if (n < 2) return { slope: 0, intercept: 0 };
    const mx = mean(x), my = mean(y);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - mx;
        num += dx * (y[i] - my);
        den += dx * dx;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = my - slope * mx;
    return { slope, intercept };
}

/** Pearson correlation coefficient + two-tailed p-value */
function pearsonr(x, y) {
    const n = x.length;
    if (n < 3) return { r: 0, p: 1 };
    const mx = mean(x), my = mean(y);
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - mx, dy = y[i] - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    if (denom === 0) return { r: 0, p: 1 };
    const r = Math.max(-1, Math.min(1, num / denom));
    // t-test for significance
    const t = r * Math.sqrt((n - 2) / (1 - r * r + 1e-15));
    const p = twoTailPFromT(Math.abs(t), n - 2);
    return { r, p };
}

/** Spearman rank correlation */
function spearmanr(x, y) {
    const n = x.length;
    if (n < 3) return { rho: 0, p: 1 };
    const rx = rank(x), ry = rank(y);
    return pearsonr(rx, ry);  // Spearman = Pearson on ranks
}

/** Assign ranks (average for ties, matching scipy.stats.rankdata) */
function rank(arr) {
    const n = arr.length;
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
        let j = i;
        while (j < n - 1 && indexed[j + 1].v === indexed[i].v) j++;
        const avgRank = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
        i = j + 1;
    }
    return ranks;
}

/** Two-tailed p-value from t-statistic using Beta incomplete function approx.
 *  Good enough for n > 20 which is always true (min_n=50). */
function twoTailPFromT(t, df) {
    // Use the regularized incomplete beta function approximation
    const x = df / (df + t * t);
    const p = betaIncomplete(df / 2, 0.5, x);
    return Math.min(1, Math.max(0, p));
}

/** Regularized incomplete beta function Ix(a, b) — continued fraction approx.
 *  Lentz's algorithm. Accuracy sufficient for pipeline use. */
function betaIncomplete(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);
    // Use continued fraction (Lentz)
    if (x < (a + 1) / (a + b + 2)) {
        return front * betaCF(a, b, x) / a;
    }
    return 1 - front * betaCF(b, a, 1 - x) / b;
}

function betaCF(a, b, x) {
    const maxIter = 200;
    const eps = 1e-10;
    let qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIter; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
        c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
        c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < eps) break;
    }
    return h;
}

/** Stirling's approximation for ln(Gamma(x)) — good for x > 0.5 */
function lnGamma(x) {
    // Lanczos approximation (g=7, n=9)
    const g = 7;
    const c = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) {
        return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    }
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < c.length; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Skewness (Fisher's, matching scipy.stats.skew) */
function skew(arr) {
    const n = arr.length;
    if (n < 3) return 0;
    const m = mean(arr);
    let m2 = 0, m3 = 0;
    for (let i = 0; i < n; i++) {
        const d = arr[i] - m;
        m2 += d * d;
        m3 += d * d * d;
    }
    m2 /= n;
    m3 /= n;
    const s = Math.sqrt(m2);
    if (s === 0) return 0;
    return m3 / (s * s * s);
}

// ── Metric definitions ───────────────────────────────────────────────────

const RETENTION_POINTS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95];
const RETENTION_WINDOWS = [
    [0, 5], [0, 10], [5, 15], [10, 20], [20, 30], [30, 40], [40, 50],
    [50, 60], [60, 70], [70, 80], [80, 90], [90, 100], [95, 100],
];
const DAILY_VIEWS_WINDOWS = [[0, 1], [0, 3], [0, 7], [7, 14], [14, 30]];
const DAILY_VIEWS_RATIOS = [
    ['week2', 'week1', 7, 14, 0, 7],
    ['month1', 'week1', 0, 30, 0, 7],
    ['week3', 'week2', 14, 21, 7, 14],
];

const MOTION_KEYWORDS = new Set([
    'moving', 'motion', 'walking', 'running', 'jumping', 'dancing',
    'gesture', 'action', 'dynamic', 'swinging', 'waving', 'shaking',
]);
const CLIMAX_LABELS = new Set(['climax', 'peak', 'payoff', 'reveal']);

// ── Zygarnik / Open-Loop / Gratification Delay word lists ───────────────

const ZYGARNIK_PHRASE_SETS = {
    open_loop: [
        'what if', 'i wonder', "let's see", 'will it', 'can i', 'can we',
        'how many', 'is it possible', 'to find out', 'to see if', 'to see how',
        'to test', 'but first', 'wait until', 'watch what', "you won't believe",
        "let's find out", 'the question is', 'i wanted to see', 'i wanted to find out',
        'i wanted to test', 'i wanted to know', 'could i', 'could we', 'would it',
        'i need to know', 'i have to try', 'we need to find', "let's test",
        'to figure out', 'if it works', 'if this works', 'whether it',
    ],
    closure: [
        'it works', 'it worked', 'i did it', "it's done", 'finally done',
        'finished', 'the result is', 'turned out', 'success', 'nailed it',
        'as expected', 'complete', 'completed', 'as you can see',
        'the answer is', "here's what happened", "that's how", 'the winner is',
        'and there you go', 'there you have it', 'and that is', 'so basically',
        'worked perfectly', 'mission accomplished', 'all done', 'easy',
    ],
    unresolved_ref: [
        'this thing', 'check this', 'watch this', 'look at this',
        'what happens', 'what happened', 'what will', 'what would',
        'the result', 'the answer', 'the outcome', 'the truth',
        'the secret', "you'll see", 'wait for it', 'you will see',
        'stay tuned', 'keep watching', 'the moment', 'the big',
        'wait for this', 'here it is', 'look what', 'see what',
    ],
    temporal_anticipation: [
        'about to', 'going to', 'gonna', 'when i', 'once i', 'after this',
        'almost', 'ready to', 'here we go', "let's go", "let's do",
        'about to see', 'about to find', 'about to test', 'get ready',
        'brace yourself', 'in a second', 'in a moment', 'any second',
    ],
    contrast: [
        'but', 'however', 'instead', 'versus', 'surprisingly',
        'actually', 'except', 'though', 'although', 'yet',
        'on the other hand', 'plot twist', 'the catch',
    ],
    superlative: [
        'most', 'best', 'worst', 'biggest', 'smallest', 'fastest',
        'strongest', 'first ever', 'never before', "world's", 'ever',
        'insane', 'impossible', 'unbelievable', 'incredible', 'crazy',
        'extreme', 'ultimate', 'maximum', 'legendary',
    ],
    action_verb: [
        'make', 'making', 'build', 'building', 'create', 'creating',
        'try', 'trying', 'test', 'testing', 'break', 'breaking',
        'destroy', 'destroying', 'cut', 'cutting', 'open', 'opening',
        'eat', 'eating', 'cook', 'cooking', 'turn', 'turning',
        'use', 'using', 'smash', 'smashing', 'drop', 'dropping',
        'launch', 'launching', 'pour', 'pouring', 'mix', 'mixing',
    ],
    sensory: [
        'look', 'watch', 'see', 'hear', 'feel', 'taste', 'smell',
        'notice', 'check this', 'look at', 'watch this',
        'listen', 'touch', 'sounds like', 'looks like', 'feels like',
    ],
    imperative: [
        "let's", 'check out', 'watch this', 'look at', 'imagine', 'think about',
        'guess what', 'wait', 'hold on', 'stay tuned', 'keep watching',
        "don't go", 'stick around', 'pay attention', 'remember this',
    ],
    outcome_ref: [
        'result', 'answer', 'outcome', 'what happens', 'what happened',
        'the winner', 'the verdict', 'turns out', 'find out', 'found out',
        'the truth', 'the secret', 'spoiler', 'the reveal',
    ],
    suspense: [
        'careful', 'dangerous', 'risky', 'scary', 'terrifying',
        'deadly', 'insane', 'wild', 'intense', 'nervous',
        'hoping', 'praying', 'fingers crossed', 'moment of truth',
        'do or die', 'no turning back', 'nerve',
    ],
    identity_hook: [
        "if you", "for anyone who", "have you ever", "you know that feeling",
        "does this sound familiar", "anyone else", "raise your hand if",
        "you might be", "sounds like you", "if this is you", "relate",
        "been there", "we all know", "this is for you", "for those of you",
    ],
    social_proof: [
        "million", "millions of", "everyone", "most people", "studies show",
        "research shows", "experts say", "proven", "scientists", "according to",
        "data shows", "statistically", "90 percent", "99 percent",
        "thousands of", "viral", "trending", "people are saying",
    ],
    scarcity: [
        "limited time", "running out", "before it", "disappearing", "last chance",
        "only a few", "once in a lifetime", "never again", "rare", "exclusive",
        "while you can", "dont miss", "time sensitive", "act now",
    ],
    pattern_interrupt: [
        "wait", "stop", "actually no", "plot twist", "wrong", "mistake",
        "i lied", "not what you think", "you were wrong", "everybody says",
        "they say", "but the truth", "unpopular opinion", "nobody talks about",
        "what nobody tells you", "secret nobody",
    ],
};

const ZYGARNIK_FAMILIES = Object.keys(ZYGARNIK_PHRASE_SETS);
const ZYGARNIK_EARLY_WINDOWS = [2, 3, 5, 8, 10, 15, 20];

const ZYGARNIK_SPECIAL_KEYS = [
    'gratification_delay_word_idx', 'gratification_delay_pct',
    'promise_proof_gap_words', 'promise_proof_gap_pct',
    'first_question_position_pct',
    'dangling_question_count', 'dangling_question_ratio',
    'hook_tension_ratio',
    'hook_open_loop_density', 'hook_closure_density', 'hook_unresolved_density',
    'countdown_flag', 'countdown_position_pct',
    'withheld_outcome_flag',
    'setup_duration_s', 'setup_duration_pct', 'hook_plus_setup_duration_pct',
    'payoff_position_pct',
    'object_mention_frame_pct_first3s', 'object_mention_frame_pct_first5s',
    'object_mention_frame_pct_first10s',
    'setup_visual_frame_count', 'anticipatory_frame_pct',
    'open_loop_before_closure_flag',
    'title_open_loop_flag', 'title_curiosity_gap_flag',
    'hook_question_density',
    'identity_hook_density',
    'social_proof_hook_density',
    'scarcity_hook_density',
    'pattern_interrupt_density',
    'hook_specificity_score',
    'hook_number_density',
    'title_number_count',
    'micro_commitment_count',
    'open_loop_before_first_third_flag',
    'tension_peak_position_pct',
    'story_arc_front_load_ratio',
    'hook_identity_flag',
];

function windowedTranscript(transcript, duration, windowSec) {
    if (!transcript || !duration || duration <= 0) return '';
    const words = transcript.split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const frac = Math.min(windowSec / duration, 1.0);
    const nWords = Math.max(1, Math.ceil(words.length * frac));
    return words.slice(0, nWords).join(' ');
}

function countPhraseMatches(textLower, phrases) {
    let count = 0;
    for (const phrase of phrases) {
        let idx = 0;
        while ((idx = textLower.indexOf(phrase, idx)) !== -1) {
            count++;
            idx += phrase.length;
        }
    }
    return count;
}

const COUNTDOWN_RE = /\b(3\s*[,.]?\s*2\s*[,.]?\s*1|countdown|ready\s+set|here we go|here it goes|in\s+\d+\s*seconds?)\b/i;

const OBJECT_KEYWORDS = [
    'device', 'machine', 'tool', 'material', 'setup', 'apparatus',
    'equipment', 'gadget', 'contraption', 'press', 'hydraulic',
    'saw', 'drill', 'knife', 'hammer', 'blender', 'oven',
];

const INTERACTION_BASES = [
    'retention_pct_50', 'retention_pct_25', 'speech_rate_wps',
    'face_frame_pct', 'retention_entropy', 'hook_drop_rate',
    'non_sub_view_share', 'swipe_away_rate', 'like_rate',
    'unique_word_ratio', 'scene_change_rate', 'hook_duration_pct',
    'title_word_count', 'avg_segment_duration_s', 'close_up_frame_pct',
    'open_loop_count', 'open_loop_density',
    'open_loop_count_first5s', 'open_loop_density_first5s',
    'open_loop_count_first10s',
    'closure_count', 'closure_density',
    'closure_count_first5s', 'closure_density_first5s',
    'closure_count_first10s',
    'unresolved_ref_density', 'unresolved_ref_density_first5s',
    'temporal_anticipation_density', 'temporal_anticipation_count',
    'contrast_count', 'superlative_count',
    'action_verb_density', 'sensory_density',
    'suspense_density', 'imperative_density', 'outcome_ref_density',
    'gratification_delay_pct', 'promise_proof_gap_pct',
    'hook_tension_ratio', 'dangling_question_ratio',
    'withheld_outcome_flag', 'countdown_flag',
    'setup_duration_pct', 'payoff_position_pct',
    'hook_open_loop_density', 'hook_closure_density',
    // New Group A indicators
    'hook_payoff_gap', 'end_recovery_score', 'narrative_arc_completeness',
    'action_frame_pct', 'max_silence_gap_s', 'opening_speech_rate_3s',
    // New Group B indicators
    'open_loop_to_closure_ratio', 'zygarnik_tension_peak_pct', 'early_proof_position_pct',
    'hook_stake_density', 'setup_payoff_ratio', 'resolution_density',
    'closure_rate_per_min', 'tension_arc_score', 'pre_payoff_open_loop_density',
    'visual_stake_frame_pct',
    // New indicator families
    'open_loop_count_first3s',
    'open_loop_count_first15s',
    'closure_count_first10s',
    'suspense_count',
    'suspense_density',
    'contrast_density',
    'identity_hook_density',
    'social_proof_hook_density',
    'pattern_interrupt_density',
    'hook_specificity_score',
    'hook_number_density',
    'open_loop_to_closure_ratio',
    'zygarnik_tension_peak_pct',
    'tension_arc_score',
    'resolution_density',
    'tension_peak_position_pct',
    'story_arc_front_load_ratio',
];

// Static metric definitions — keys that have hardcoded extraction logic
const STATIC_KEYS = new Set([
    'hook_retention_pct', 'final_5pct_retention', 'mid_video_cliff',
    'retention_entropy', 'hook_drop_rate', 'early_momentum',
    'retention_25pct', 'retention_50pct', 'retention_75pct', 'retention_90pct',
    'above_baseline_mean', 'peak_count', 'drop_count', 'max_peak_delta',
    'max_drop_delta', 'retention_variance', 'retention_skew',
    'view_accel_7day', 'week1_week2_ratio', 'non_sub_view_share',
    'swipe_away_rate', 'daily_view_peak_day',
    'like_rate', 'comment_rate', 'share_rate', 'subs_gained_per_view',
    'subs_per_like', 'revenue_per_view',
    'duration_log', 'transcript_word_count', 'speech_rate_wps',
    'hook_word_count', 'question_count', 'segment_count',
    'has_hook_segment', 'hook_duration_s',
    'face_frame_pct', 'text_overlay_frame_pct', 'scene_change_count',
    'keep_x_non_sub_share',
    // Pre-upload: transcript
    'transcript_char_count', 'avg_word_length', 'unique_word_ratio',
    'sentence_count', 'exclamation_count', 'uppercase_word_ratio',
    'hook_question_count', 'hook_word_ratio', 'hook_char_count',
    'transcript_number_count',
    // Pre-upload: structure
    'hook_duration_pct', 'avg_segment_duration_s', 'longest_segment_duration_s',
    'shortest_segment_duration_s', 'hook_position_s', 'climax_position_pct',
    'has_climax_segment', 'hook_to_climax_gap_s',
    // Pre-upload: metadata
    'duration_s', 'title_char_count', 'title_word_count',
    'title_question_flag', 'title_exclamation_flag', 'title_number_flag',
    // Pre-upload: visual
    'scene_change_rate', 'unique_scene_ratio', 'visual_technique_count_mean',
    'close_up_frame_pct', 'hand_presence_frame_pct', 'motion_word_frame_pct',
]);

// Layer map for static keys
const STATIC_LAYER = {
    // post-upload (need analytics)
    hook_retention_pct: 'post', final_5pct_retention: 'post', mid_video_cliff: 'post',
    retention_entropy: 'post', hook_drop_rate: 'post', early_momentum: 'post',
    retention_25pct: 'post', retention_50pct: 'post', retention_75pct: 'post', retention_90pct: 'post',
    above_baseline_mean: 'post', peak_count: 'post', drop_count: 'post',
    max_peak_delta: 'post', max_drop_delta: 'post', retention_variance: 'post', retention_skew: 'post',
    view_accel_7day: 'post', week1_week2_ratio: 'post',
    non_sub_view_share: 'post', swipe_away_rate: 'post', daily_view_peak_day: 'post',
    like_rate: 'post', comment_rate: 'post', share_rate: 'post',
    subs_gained_per_view: 'post', subs_per_like: 'post', revenue_per_view: 'post',
    keep_x_non_sub_share: 'post',
    // pre-upload
    duration_log: 'pre', transcript_word_count: 'pre', speech_rate_wps: 'pre',
    hook_word_count: 'pre', question_count: 'pre', segment_count: 'pre',
    has_hook_segment: 'pre', hook_duration_s: 'pre',
    face_frame_pct: 'pre', text_overlay_frame_pct: 'pre', scene_change_count: 'pre',
    transcript_char_count: 'pre', avg_word_length: 'pre', unique_word_ratio: 'pre',
    sentence_count: 'pre', exclamation_count: 'pre', uppercase_word_ratio: 'pre',
    hook_question_count: 'pre', hook_word_ratio: 'pre', hook_char_count: 'pre',
    transcript_number_count: 'pre',
    hook_duration_pct: 'pre', avg_segment_duration_s: 'pre',
    longest_segment_duration_s: 'pre', shortest_segment_duration_s: 'pre',
    hook_position_s: 'pre', climax_position_pct: 'pre',
    has_climax_segment: 'pre', hook_to_climax_gap_s: 'pre',
    duration_s: 'pre', title_char_count: 'pre', title_word_count: 'pre',
    title_question_flag: 'pre', title_exclamation_flag: 'pre', title_number_flag: 'pre',
    scene_change_rate: 'pre', unique_scene_ratio: 'pre',
    visual_technique_count_mean: 'pre', close_up_frame_pct: 'pre',
    hand_presence_frame_pct: 'pre', motion_word_frame_pct: 'pre',
};

// ── Programmatic registration of Zygarnik keys ──
for (const fam of ZYGARNIK_FAMILIES) {
    for (const measure of ['count', 'density']) {
        const fullKey = `${fam}_${measure}`;
        STATIC_KEYS.add(fullKey);
        STATIC_LAYER[fullKey] = 'pre';
        for (const w of ZYGARNIK_EARLY_WINDOWS) {
            const wKey = `${fam}_${measure}_first${w}s`;
            STATIC_KEYS.add(wKey);
            STATIC_LAYER[wKey] = 'pre';
        }
    }
}
for (const k of ZYGARNIK_SPECIAL_KEYS) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── New Group A indicators ──
for (const k of ['hook_payoff_gap', 'narrative_arc_completeness', 'action_frame_pct',
    'max_silence_gap_s', 'opening_speech_rate_3s']) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}
STATIC_KEYS.add('end_recovery_score');
STATIC_LAYER['end_recovery_score'] = 'post';

// ── New Group B indicators ──
for (const k of ['open_loop_to_closure_ratio', 'zygarnik_tension_peak_pct', 'early_proof_position_pct',
    'hook_stake_density', 'setup_payoff_ratio', 'resolution_density',
    'closure_rate_per_min', 'tension_arc_score', 'pre_payoff_open_loop_density',
    'visual_stake_frame_pct']) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}


// ── get_metric_definition ────────────────────────────────────────────────

function getMetricDefinition(key) {
    // Static keys — simplified definitions (layer is what matters for the runner)
    if (STATIC_KEYS.has(key)) {
        return {
            description: key.replace(/_/g, ' '),
            formula: key,
            expected_range: 'varies',
            data_sources: ['analysis'],
            layer: STATIC_LAYER[key] || 'post',
        };
    }

    let m;

    // retention_pct_N
    m = key.match(/^retention_pct_(\d+)$/);
    if (m) {
        return {
            description: `Retention at ${m[1]}% into the video.`,
            formula: `retentionCurve[${m[1]}].retention`,
            expected_range: '0 to 2.0',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
    }

    // retention_mean_LO_HI
    m = key.match(/^retention_mean_(\d+)_(\d+)$/);
    if (m) {
        return {
            description: `Mean retention in the ${m[1]}-${m[2]}% window.`,
            formula: `mean(retentionCurve[${m[1]}:${m[2]}].retention)`,
            expected_range: '0 to 2.0',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
    }

    // retention_slope_LO_HI
    m = key.match(/^retention_slope_(\d+)_(\d+)$/);
    if (m) {
        return {
            description: `Linear regression slope of retention in ${m[1]}-${m[2]}% window.`,
            formula: `linregress(retentionCurve[${m[1]}:${m[2]}]).slope`,
            expected_range: '-0.05 to 0.05',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
    }

    // retention_volatility_LO_HI
    m = key.match(/^retention_volatility_(\d+)_(\d+)$/);
    if (m) {
        return {
            description: `Std deviation of retention in ${m[1]}-${m[2]}% window.`,
            formula: `std(retentionCurve[${m[1]}:${m[2]}].retention)`,
            expected_range: '0 to 0.5',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
    }

    // views_log_days_D0_D1
    m = key.match(/^views_log_days_(\d+)_(\d+)$/);
    if (m) {
        return {
            description: `Log10 of total views in days ${m[1]}-${m[2]}.`,
            formula: `log10(sum(dailyViews[${m[1]}:${m[2]}].views) + 1)`,
            expected_range: '0 to 8',
            data_sources: ['analytics.dailyViews'],
            layer: 'post',
        };
    }

    // views_ratio_X_vs_Y
    m = key.match(/^views_ratio_(\w+)_vs_(\w+)$/);
    if (m) {
        const ri = DAILY_VIEWS_RATIOS.find(r => r[0] === m[1] && r[1] === m[2]);
        if (ri) {
            return {
                description: `View ratio: days ${ri[2]}-${ri[3]} / days ${ri[4]}-${ri[5]}.`,
                formula: `sum(dailyViews[${ri[2]}:${ri[3]}]) / sum(dailyViews[${ri[4]}:${ri[5]}]) + 1)`,
                expected_range: '0 to 5',
                data_sources: ['analytics.dailyViews'],
                layer: 'post',
            };
        }
    }

    // Interaction terms: keyA_x_keyB
    m = key.match(/^(.+)_x_(.+)$/);
    if (m) {
        const defA = getMetricDefinition(m[1]);
        const defB = getMetricDefinition(m[2]);
        if (defA && defB) {
            const layerA = defA.layer || 'post';
            const layerB = defB.layer || 'post';
            return {
                description: `Interaction: ${m[1]} * ${m[2]}.`,
                formula: `${m[1]} * ${m[2]}`,
                expected_range: 'varies',
                data_sources: [...new Set([...(defA.data_sources || []), ...(defB.data_sources || [])])],
                layer: (layerA === 'pre' && layerB === 'pre') ? 'pre' : 'post',
            };
        }
    }

    return null;
}


// ── extract_metric ───────────────────────────────────────────────────────

function extractMetric(key, analysis) {
    const meta = analysis.metadata || {};
    const analytics = analysis.analytics || {};
    const rawT = analysis.transcript;
    const transcript = (typeof rawT === 'object' && rawT ? (rawT.fullText || '') : (rawT || '')).trim();
    const ai = analysis.aiAnalysis || {};
    const frames = analysis.frames || [];
    const segments = (typeof ai === 'object' ? (ai.segments || []) : []);
    const curve = analytics.retentionCurve || [];
    const daily = analytics.dailyViews || [];

    function curveVal(idx) {
        if (curve.length <= idx) return null;
        return curve[idx].retention;
    }

    function hookSeg() {
        return segments.find(s => (s.label || '').toLowerCase() === 'hook') || null;
    }

    function hookText() {
        const hs = hookSeg();
        if (hs && hs.transcript) return hs.transcript;
        if (transcript) {
            const dur = meta.duration || 1;
            const words = transcript.split(/\s+/).filter(Boolean);
            const hookEst = Math.max(1, Math.floor(words.length * 5 / dur));
            return words.slice(0, hookEst).join(' ');
        }
        return '';
    }

    function sceneChangeCount() {
        let changes = 0, prev = '';
        for (const f of frames) {
            const desc = String((f.analysis || {}).sceneDescription || '');
            if (prev && desc.slice(0, 60) !== prev.slice(0, 60)) changes++;
            prev = desc;
        }
        return changes;
    }

    // ── Static keys ──────────────────────────────────────────────────────

    if (key === 'hook_retention_pct') {
        const v = curveVal(10);
        return v != null ? [v, null] : [null, 'no curve'];
    }
    if (key === 'final_5pct_retention') {
        if (curve.length < 5) return [null, 'curve too short'];
        return [mean(curve.slice(-5).map(p => p.retention)), null];
    }
    if (key === 'mid_video_cliff') {
        if (curve.length < 2) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        let maxDiff = 0;
        for (let i = 1; i < vals.length; i++) maxDiff = Math.max(maxDiff, Math.abs(vals[i] - vals[i - 1]));
        return [maxDiff, null];
    }
    if (key === 'retention_entropy') {
        if (!curve.length) return [null, 'no curve'];
        const vals = curve.map(p => Math.abs(p.retention));
        const total = vals.reduce((a, b) => a + b, 0);
        if (total === 0) return [0, null];
        let h = 0;
        for (const v of vals) {
            if (v > 0) { const p = v / total; h -= p * Math.log2(p); }
        }
        return [h, null];
    }
    if (key === 'hook_drop_rate') {
        if (curve.length < 10) return [null, 'curve too short'];
        const vals = curve.slice(0, 10).map(p => p.retention);
        const x = vals.map((_, i) => i);
        return [linregress(x, vals).slope, null];
    }
    if (key === 'early_momentum') {
        const v25 = curveVal(25), v10 = curveVal(10);
        if (v25 == null || v10 == null) return [null, 'no curve'];
        return [v25 - v10, null];
    }
    if (key === 'retention_25pct') { const v = curveVal(25); return v != null ? [v, null] : [null, 'no curve']; }
    if (key === 'retention_50pct') { const v = curveVal(50); return v != null ? [v, null] : [null, 'no curve']; }
    if (key === 'retention_75pct') { const v = curveVal(75); return v != null ? [v, null] : [null, 'no curve']; }
    if (key === 'retention_90pct') { const v = curveVal(90); return v != null ? [v, null] : [null, 'no curve']; }

    if (key === 'above_baseline_mean') {
        if (!curve.length) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        const n = vals.length;
        const above = vals.map((v, i) => v - (1.0 - i / Math.max(n - 1, 1)));
        return [mean(above), null];
    }
    if (key === 'peak_count') {
        if (curve.length < 3) return [null, 'curve too short'];
        const vals = curve.map(p => p.retention);
        let peaks = 0;
        for (let i = 1; i < vals.length - 1; i++) {
            if (vals[i] > vals[i - 1] && vals[i] > vals[i + 1]) peaks++;
        }
        return [peaks, null];
    }
    if (key === 'drop_count') {
        if (curve.length < 2) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        let drops = 0;
        for (let i = 1; i < vals.length; i++) {
            if ((vals[i - 1] - vals[i]) > 0.03) drops++;
        }
        return [drops, null];
    }
    if (key === 'max_peak_delta') {
        if (curve.length < 2) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        let maxInc = 0;
        for (let i = 1; i < vals.length; i++) {
            if (vals[i] > vals[i - 1]) maxInc = Math.max(maxInc, vals[i] - vals[i - 1]);
        }
        return [maxInc, null];
    }
    if (key === 'max_drop_delta') {
        if (curve.length < 2) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        let maxDrop = 0;
        for (let i = 1; i < vals.length; i++) {
            if (vals[i] < vals[i - 1]) maxDrop = Math.max(maxDrop, vals[i - 1] - vals[i]);
        }
        return [maxDrop, null];
    }
    if (key === 'retention_variance') {
        if (!curve.length) return [null, 'no curve'];
        return [variance(curve.map(p => p.retention)), null];
    }
    if (key === 'retention_skew') {
        if (curve.length < 3) return [null, 'curve too short'];
        return [skew(curve.map(p => p.retention)), null];
    }

    // Views / engagement
    if (key === 'view_accel_7day') {
        if (!daily.length) return [null, 'no daily views'];
        const w1 = daily.slice(0, 7).reduce((s, d) => s + (d.views || 0), 0);
        return [Math.log10(w1 + 1), null];
    }
    if (key === 'week1_week2_ratio') {
        if (daily.length < 7) return [null, 'insufficient daily views'];
        const w1 = daily.slice(0, 7).reduce((s, d) => s + (d.views || 0), 0);
        const w2 = daily.slice(7, 14).reduce((s, d) => s + (d.views || 0), 0);
        return [w2 / (w1 + 1), null];
    }
    if (key === 'non_sub_view_share') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.nonSubscriberViews || 0) / total, null];
    }
    if (key === 'swipe_away_rate') {
        const v = analytics.swipedAwayRate;
        return v != null ? [v, null] : [null, 'no swipe data'];
    }
    if (key === 'daily_view_peak_day') {
        if (!daily.length) return [null, 'no daily views'];
        let maxV = -1, maxI = 0;
        for (let i = 0; i < daily.length; i++) {
            if ((daily[i].views || 0) > maxV) { maxV = daily[i].views || 0; maxI = i; }
        }
        return [maxI, null];
    }
    if (key === 'like_rate') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.likes || 0) / total * 1000, null];
    }
    if (key === 'comment_rate') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.comments || 0) / total * 1000, null];
    }
    if (key === 'share_rate') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.shares || 0) / total * 1000, null];
    }
    if (key === 'subs_gained_per_view') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.subscribersGained || 0) / total * 1000, null];
    }
    if (key === 'subs_per_like') {
        const likes = analytics.likes || 0;
        const subs = analytics.subscribersGained || 0;
        return [subs / (likes + 1), null];
    }
    if (key === 'revenue_per_view') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.estimatedRevenue || 0) / total * 1000, null];
    }
    if (key === 'duration_log') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        return [Math.log10(dur), null];
    }
    if (key === 'transcript_word_count') {
        if (!transcript) return [null, 'no transcript'];
        return [transcript.split(/\s+/).filter(Boolean).length, null];
    }
    if (key === 'speech_rate_wps') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        return [transcript.split(/\s+/).filter(Boolean).length / dur, null];
    }
    if (key === 'hook_word_count') {
        const hs = hookSeg();
        if (hs && hs.transcript) return [hs.transcript.split(/\s+/).filter(Boolean).length, null];
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 1;
        const words = transcript.split(/\s+/).filter(Boolean);
        const hookEst = Math.max(1, Math.floor(words.length * 5 / dur));
        return [words.slice(0, hookEst).length, null];
    }
    if (key === 'question_count') {
        if (!transcript) return [null, 'no transcript'];
        return [(transcript.match(/\?/g) || []).length, null];
    }
    if (key === 'segment_count') return [segments.length, null];
    if (key === 'has_hook_segment') return [hookSeg() ? 1 : 0, null];
    if (key === 'hook_duration_s') {
        const hs = hookSeg();
        if (hs) return [(hs.endTime || 0) - (hs.startTime || 0), null];
        return [0, null];
    }
    if (key === 'face_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => String((f.analysis || {}).sceneDescription || '').toLowerCase().includes('face')).length;
        return [ct / frames.length, null];
    }
    if (key === 'text_overlay_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            return String(a.visualTechniques || '').toLowerCase().includes('text overlay') ||
                   String(a.sceneDescription || '').toLowerCase().includes('text overlay');
        }).length;
        return [ct / frames.length, null];
    }
    if (key === 'scene_change_count') {
        if (!frames.length) return [null, 'no frames'];
        return [sceneChangeCount(), null];
    }
    if (key === 'keep_x_non_sub_share') {
        const keep = analytics.avgRetention;
        const total = analytics.totalViews || 0;
        if (keep == null || !total) return [null, 'missing data'];
        return [keep * ((analytics.nonSubscriberViews || 0) / total), null];
    }

    // Pre-upload: transcript/language
    if (key === 'transcript_char_count') {
        if (!transcript) return [null, 'no transcript'];
        return [transcript.length, null];
    }
    if (key === 'avg_word_length') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [mean(words.map(w => w.length)), null];
    }
    if (key === 'unique_word_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [new Set(words).size / words.length, null];
    }
    if (key === 'sentence_count') {
        if (!transcript) return [null, 'no transcript'];
        return [(transcript.match(/[.!?]/g) || []).length, null];
    }
    if (key === 'exclamation_count') {
        if (!transcript) return [null, 'no transcript'];
        return [(transcript.match(/!/g) || []).length, null];
    }
    if (key === 'uppercase_word_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const ct = words.filter(w => w.length >= 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
        return [ct / words.length, null];
    }
    if (key === 'hook_question_count') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        return [(ht.match(/\?/g) || []).length, null];
    }
    if (key === 'hook_word_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const totalWords = transcript.split(/\s+/).filter(Boolean).length;
        if (!totalWords) return [null, 'empty transcript'];
        const hs = hookSeg();
        let hw;
        if (hs && hs.transcript) {
            hw = hs.transcript.split(/\s+/).filter(Boolean).length;
        } else {
            const dur = meta.duration || 1;
            const words = transcript.split(/\s+/).filter(Boolean);
            const hookEst = Math.max(1, Math.floor(words.length * 5 / dur));
            hw = words.slice(0, hookEst).length;
        }
        return [hw / totalWords, null];
    }
    if (key === 'hook_char_count') {
        const hs = hookSeg();
        if (hs && hs.transcript) return [hs.transcript.length, null];
        if (transcript) {
            const dur = meta.duration || 1;
            return [transcript.length / dur * 5, null];
        }
        return [null, 'no hook text'];
    }
    if (key === 'transcript_number_count') {
        if (!transcript) return [null, 'no transcript'];
        return [(transcript.match(/\d+/g) || []).length, null];
    }

    // Pre-upload: structure
    if (key === 'hook_duration_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const hs = hookSeg();
        if (!hs) return [0, null];
        return [((hs.endTime || 0) - (hs.startTime || 0)) / dur * 100, null];
    }
    if (key === 'avg_segment_duration_s') {
        if (!segments.length) return [null, 'no segments'];
        return [mean(segments.map(s => (s.endTime || 0) - (s.startTime || 0))), null];
    }
    if (key === 'longest_segment_duration_s') {
        if (!segments.length) return [null, 'no segments'];
        return [Math.max(...segments.map(s => (s.endTime || 0) - (s.startTime || 0))), null];
    }
    if (key === 'shortest_segment_duration_s') {
        if (!segments.length) return [null, 'no segments'];
        return [Math.min(...segments.map(s => (s.endTime || 0) - (s.startTime || 0))), null];
    }
    if (key === 'hook_position_s') {
        const hs = hookSeg();
        if (!hs) return [null, 'no hook segment'];
        return [hs.startTime || 0, null];
    }
    if (key === 'climax_position_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const cs = segments.find(s => CLIMAX_LABELS.has((s.label || '').toLowerCase()));
        if (!cs) return [null, 'no climax segment'];
        return [(cs.startTime || 0) / dur * 100, null];
    }
    if (key === 'has_climax_segment') {
        return [segments.some(s => CLIMAX_LABELS.has((s.label || '').toLowerCase())) ? 1 : 0, null];
    }
    if (key === 'hook_to_climax_gap_s') {
        const hs = hookSeg();
        const cs = segments.find(s => CLIMAX_LABELS.has((s.label || '').toLowerCase()));
        if (!hs || !cs) return [null, 'missing hook or climax segment'];
        return [Math.max(0, (cs.startTime || 0) - (hs.endTime || 0)), null];
    }

    // Pre-upload: metadata
    if (key === 'duration_s') {
        const dur = meta.duration || 0;
        return dur ? [dur, null] : [null, 'no duration'];
    }
    if (key === 'title_char_count') {
        const title = meta.title || '';
        return title ? [title.length, null] : [null, 'no title'];
    }
    if (key === 'title_word_count') {
        const title = meta.title || '';
        return title ? [title.split(/\s+/).filter(Boolean).length, null] : [null, 'no title'];
    }
    if (key === 'title_question_flag') {
        return [(meta.title || '').includes('?') ? 1 : 0, null];
    }
    if (key === 'title_exclamation_flag') {
        return [(meta.title || '').includes('!') ? 1 : 0, null];
    }
    if (key === 'title_number_flag') {
        return [/\d/.test(meta.title || '') ? 1 : 0, null];
    }

    // Pre-upload: visual
    if (key === 'scene_change_rate') {
        if (!frames.length) return [null, 'no frames'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        return [sceneChangeCount() / dur, null];
    }
    if (key === 'unique_scene_ratio') {
        if (!frames.length) return [null, 'no frames'];
        const descs = frames.map(f => String((f.analysis || {}).sceneDescription || '').slice(0, 60));
        return [new Set(descs).size / descs.length, null];
    }
    if (key === 'visual_technique_count_mean') {
        if (!frames.length) return [null, 'no frames'];
        const counts = frames.map(f => {
            const vt = String((f.analysis || {}).visualTechniques || '');
            return vt.split(/[.;]/).filter(s => s.trim()).length;
        });
        return [mean(counts), null];
    }
    if (key === 'close_up_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            return String(a.sceneDescription || '').toLowerCase().includes('close') ||
                   String(a.visualTechniques || '').toLowerCase().includes('close') ||
                   String(a.cinematography || '').toLowerCase().includes('close');
        }).length;
        return [ct / frames.length, null];
    }
    if (key === 'hand_presence_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => String((f.analysis || {}).sceneDescription || '').toLowerCase().includes('hand')).length;
        return [ct / frames.length, null];
    }
    if (key === 'motion_word_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => {
            const desc = String((f.analysis || {}).sceneDescription || '').toLowerCase();
            for (const kw of MOTION_KEYWORDS) { if (desc.includes(kw)) return true; }
            return false;
        }).length;
        return [ct / frames.length, null];
    }

    // ── Zygarnik / Open-Loop / Gratification Delay families ────────────

    // Phrase family metrics: {family}_{count|density}[_first{N}s]
    const zyFamMatch = key.match(/^(open_loop|closure|unresolved_ref|temporal_anticipation|contrast|superlative|action_verb|sensory|imperative|outcome_ref|suspense|identity_hook|social_proof|scarcity|pattern_interrupt)_(count|density)(?:_first(\d+)s)?$/);
    if (zyFamMatch) {
        const [, family, measure, windowStr] = zyFamMatch;
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        const windowSec = windowStr ? parseInt(windowStr) : null;
        const text = windowSec && dur ? windowedTranscript(transcript, dur, windowSec) : transcript;
        if (!text) return [null, 'no text for window'];
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty text'];
        const count = countPhraseMatches(text.toLowerCase(), ZYGARNIK_PHRASE_SETS[family]);
        return measure === 'count' ? [count, null] : [count / words.length, null];
    }

    // Gratification delay: word index of first closure phrase
    if (key === 'gratification_delay_word_idx') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        let minIdx = words.length;
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0) {
                const wb = tl.slice(0, pos).split(/\s+/).filter(Boolean).length;
                if (wb < minIdx) minIdx = wb;
            }
        }
        return [minIdx, null];
    }
    if (key === 'gratification_delay_pct') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        let minIdx = words.length;
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0) {
                const wb = tl.slice(0, pos).split(/\s+/).filter(Boolean).length;
                if (wb < minIdx) minIdx = wb;
            }
        }
        return [minIdx / words.length, null];
    }

    // Promise-proof gap
    if (key === 'promise_proof_gap_words' || key === 'promise_proof_gap_pct') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const totalWords = tl.split(/\s+/).filter(Boolean).length;
        if (!totalWords) return [null, 'empty transcript'];
        let firstOpen = -1, firstClose = -1;
        for (const phrase of ZYGARNIK_PHRASE_SETS.open_loop) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (firstOpen < 0 || pos < firstOpen)) firstOpen = pos;
        }
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (firstClose < 0 || pos < firstClose)) firstClose = pos;
        }
        if (firstOpen < 0) return [0, null];
        const gapWords = firstClose < 0
            ? totalWords
            : tl.slice(firstOpen, Math.max(firstClose, firstOpen)).split(/\s+/).filter(Boolean).length;
        return key.endsWith('_pct') ? [gapWords / totalWords, null] : [gapWords, null];
    }

    if (key === 'first_question_position_pct') {
        if (!transcript) return [null, 'no transcript'];
        const idx = transcript.indexOf('?');
        if (idx < 0) return [1.0, null];
        return [idx / Math.max(transcript.length, 1), null];
    }

    // Dangling questions (not resolved within 30 words)
    if (key === 'dangling_question_count' || key === 'dangling_question_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        let dangling = 0, total = 0;
        for (let i = 0; i < words.length; i++) {
            if (words[i].includes('?')) {
                total++;
                const window30 = words.slice(i + 1, i + 31).join(' ');
                let resolved = false;
                for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
                    if (window30.includes(phrase)) { resolved = true; break; }
                }
                if (!resolved) dangling++;
            }
        }
        if (key === 'dangling_question_count') return [dangling, null];
        return total > 0 ? [dangling / total, null] : [1.0, null];
    }

    // Hook tension metrics
    if (key === 'hook_tension_ratio') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const htl = ht.toLowerCase();
        const oc = countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.open_loop);
        const cc = countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.closure);
        return [oc / (oc + cc + 1), null];
    }
    if (key === 'hook_open_loop_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [countPhraseMatches(ht.toLowerCase(), ZYGARNIK_PHRASE_SETS.open_loop) / w.length, null];
    }
    if (key === 'hook_closure_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [countPhraseMatches(ht.toLowerCase(), ZYGARNIK_PHRASE_SETS.closure) / w.length, null];
    }
    if (key === 'hook_unresolved_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [countPhraseMatches(ht.toLowerCase(), ZYGARNIK_PHRASE_SETS.unresolved_ref) / w.length, null];
    }
    if (key === 'hook_question_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [(ht.match(/\?/g) || []).length / w.length, null];
    }

    // Countdown
    if (key === 'countdown_flag') {
        if (!transcript) return [null, 'no transcript'];
        return [COUNTDOWN_RE.test(transcript) ? 1 : 0, null];
    }
    if (key === 'countdown_position_pct') {
        if (!transcript) return [null, 'no transcript'];
        const cm = COUNTDOWN_RE.exec(transcript);
        if (!cm) return [1.0, null];
        return [cm.index / Math.max(transcript.length, 1), null];
    }

    // Withheld outcome: first 50% has open loops but no closure
    if (key === 'withheld_outcome_flag') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const mid = Math.floor(tl.length / 2);
        const firstHalf = tl.slice(0, mid);
        const hasOpen = ZYGARNIK_PHRASE_SETS.open_loop.some(p => firstHalf.includes(p));
        const hasClose = ZYGARNIK_PHRASE_SETS.closure.some(p => firstHalf.includes(p));
        return [hasOpen && !hasClose ? 1 : 0, null];
    }
    if (key === 'open_loop_before_closure_flag') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        let firstOpen = tl.length, firstClose = tl.length;
        for (const phrase of ZYGARNIK_PHRASE_SETS.open_loop) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && pos < firstOpen) firstOpen = pos;
        }
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && pos < firstClose) firstClose = pos;
        }
        return [firstOpen < firstClose ? 1 : 0, null];
    }

    // Title-level indicators
    if (key === 'title_open_loop_flag') {
        const title = (meta.title || '').toLowerCase();
        if (!title) return [null, 'no title'];
        return [ZYGARNIK_PHRASE_SETS.open_loop.some(p => title.includes(p)) ? 1 : 0, null];
    }
    if (key === 'title_curiosity_gap_flag') {
        const title = (meta.title || '').toLowerCase();
        if (!title) return [null, 'no title'];
        const hasCuriosity = title.includes('?') ||
            ['how', 'why', 'what', 'can', 'will', 'is it', 'could'].some(w => title.includes(w));
        const hasResolution = ZYGARNIK_PHRASE_SETS.closure.some(p => title.includes(p));
        return [hasCuriosity && !hasResolution ? 1 : 0, null];
    }

    // Segment timing
    if (key === 'setup_duration_s') {
        const ss = segments.find(s => (s.label || '').toLowerCase() === 'setup');
        return ss ? [(ss.endTime || 0) - (ss.startTime || 0), null] : [0, null];
    }
    if (key === 'setup_duration_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const ss = segments.find(s => (s.label || '').toLowerCase() === 'setup');
        if (!ss) return [0, null];
        return [((ss.endTime || 0) - (ss.startTime || 0)) / dur * 100, null];
    }
    if (key === 'hook_plus_setup_duration_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        let total = 0;
        for (const s of segments) {
            const lbl = (s.label || '').toLowerCase();
            if (lbl === 'hook' || lbl === 'setup') total += (s.endTime || 0) - (s.startTime || 0);
        }
        return [total / dur * 100, null];
    }
    if (key === 'payoff_position_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const payoffLabels = new Set(['payoff', 'reveal', 'result', 'climax', 'peak', 'conclusion']);
        const ps = segments.find(s => payoffLabels.has((s.label || '').toLowerCase()));
        if (!ps) return [null, 'no payoff segment'];
        return [(ps.startTime || 0) / dur * 100, null];
    }

    // Visual/frame indicators
    {
        const objFrameMatch = key.match(/^object_mention_frame_pct_first(\d+)s$/);
        if (objFrameMatch) {
            if (!frames.length) return [null, 'no frames'];
            const windowSec = parseInt(objFrameMatch[1]);
            const wFrames = frames.filter(f => (f.timestamp || 0) <= windowSec);
            if (!wFrames.length) return [0, null];
            const ct = wFrames.filter(f => {
                const desc = String((f.analysis || {}).sceneDescription || '').toLowerCase();
                return OBJECT_KEYWORDS.some(kw => desc.includes(kw));
            }).length;
            return [ct / wFrames.length, null];
        }
    }
    if (key === 'setup_visual_frame_count') {
        if (!frames.length) return [null, 'no frames'];
        const sw = ['setup', 'setting up', 'preparing', 'preparation', 'arranging', 'positioning'];
        return [frames.filter(f => {
            const desc = String((f.analysis || {}).sceneDescription || '').toLowerCase();
            return sw.some(w => desc.includes(w));
        }).length, null];
    }
    if (key === 'anticipatory_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const aw = ['anticipat', 'tension', 'suspense', 'curios', 'intrigu', 'engaging', 'hook'];
        const ct = frames.filter(f => {
            const eng = String((f.analysis || {}).engagementAnalysis || '').toLowerCase();
            const desc = String((f.analysis || {}).sceneDescription || '').toLowerCase();
            return aw.some(w => eng.includes(w) || desc.includes(w));
        }).length;
        return [ct / frames.length, null];
    }

    // ── Group A: New indicators ──────────────────────────────────────────

    if (key === 'hook_payoff_gap') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const hs = hookSeg();
        const payoffLabels = new Set(['payoff', 'reveal', 'result', 'climax', 'peak', 'conclusion']);
        const ps = segments.find(s => payoffLabels.has((s.label || '').toLowerCase()));
        if (hs && ps) {
            return [Math.max(0, (ps.startTime || 0) - (hs.endTime || 0)) / dur * 100, null];
        }
        if (transcript && hs) {
            const tl = transcript.toLowerCase();
            let closurePos = -1;
            for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
                const pos = tl.indexOf(phrase);
                if (pos >= 0 && (closurePos < 0 || pos < closurePos)) closurePos = pos;
            }
            if (closurePos >= 0) {
                const closureFrac = closurePos / tl.length;
                const hookEndFrac = (hs.endTime || 0) / dur;
                return [Math.max(0, closureFrac - hookEndFrac) * 100, null];
            }
        }
        return [50, null];
    }

    if (key === 'end_recovery_score') {
        if (curve.length < 10) return [null, 'curve too short'];
        const tail = curve.slice(-10).map(p => p.retention);
        const x = tail.map((_, i) => i);
        return [linregress(x, tail).slope, null];
    }

    if (key === 'narrative_arc_completeness') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const openCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop);
        const closureCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.closure);
        return [Math.min(2.0, closureCount / (openCount + 1)), null];
    }

    if (key === 'action_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const actionWords = ['running', 'jumping', 'hitting', 'throwing', 'cutting', 'breaking',
            'exploding', 'falling', 'fighting', 'spinning', 'moving', 'action',
            'fast', 'quick', 'rush', 'slam', 'crash'];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            const desc = String(a.sceneDescription || '').toLowerCase();
            const vt = String(a.visualTechniques || '').toLowerCase();
            return actionWords.some(w => desc.includes(w) || vt.includes(w));
        }).length;
        return [ct / frames.length, null];
    }

    if (key === 'max_silence_gap_s') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        if (!transcript) return [dur / 2, null];
        const wordCount = transcript.split(/\s+/).filter(Boolean).length;
        const segCount = Math.max(segments.length, 1);
        const approx = (dur - wordCount / 2.5) / segCount;
        return [Math.min(Math.max(0, approx), dur / 2), null];
    }

    if (key === 'opening_speech_rate_3s') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const text = windowedTranscript(transcript, dur, 3);
        if (!text) return [null, 'no opening text'];
        const wc = text.split(/\s+/).filter(Boolean).length;
        return [wc / 3, null];
    }

    // ── Group B: Zygarnik-effect / delayed gratification indicators ──────

    if (key === 'open_loop_to_closure_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const openCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop);
        const closureCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.closure);
        return [Math.min(10, openCount / (closureCount + 1)), null];
    }

    if (key === 'zygarnik_tension_peak_pct') {
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (words.length < 5) return [0, null];
        const windowSize = Math.max(1, Math.floor(words.length * 0.2));
        let maxDensity = 0, peakPos = 0;
        for (let i = 0; i <= words.length - windowSize; i++) {
            const windowText = words.slice(i, i + windowSize).join(' ');
            const count = countPhraseMatches(windowText, ZYGARNIK_PHRASE_SETS.open_loop);
            const density = count / windowSize;
            if (density > maxDensity) {
                maxDensity = density;
                peakPos = (i + windowSize / 2) / words.length * 100;
            }
        }
        return [maxDensity > 0 ? peakPos : 0, null];
    }

    if (key === 'early_proof_position_pct') {
        if (!transcript) return [1.0, null];
        const tl = transcript.toLowerCase();
        const proofPhrases = ['the result', 'it worked', 'look at this', 'here it is', 'turns out',
            'and it', 'so it', 'actually', 'proof', 'evidence', 'before and after',
            'this is what', 'as you can see', 'check this out'];
        let earliest = -1;
        for (const phrase of proofPhrases) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (earliest < 0 || pos < earliest)) earliest = pos;
        }
        if (earliest < 0) return [1.0, null];
        return [earliest / Math.max(tl.length, 1), null];
    }

    if (key === 'hook_stake_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const htl = ht.toLowerCase();
        const stakePhrases = ['destroy', 'ruin', 'save', 'lose', 'win', 'die', 'break', 'kill',
            'survive', 'never', 'always', 'impossible', 'dangerous', 'deadly',
            'incredible', 'insane', 'crazy', 'unbelievable', 'shocking'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [countPhraseMatches(htl, stakePhrases) / w.length, null];
    }

    if (key === 'setup_payoff_ratio') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const ss = segments.find(s => (s.label || '').toLowerCase() === 'setup');
        const payoffLabels = new Set(['payoff', 'reveal', 'result', 'climax', 'peak', 'conclusion']);
        const ps = segments.find(s => payoffLabels.has((s.label || '').toLowerCase()));
        const setupDur = ss ? (ss.endTime || 0) - (ss.startTime || 0) : 0;
        if (!ps) return [setupDur ? setupDur / dur : 0, null];
        const payoffDur = (ps.endTime || 0) - (ps.startTime || 0);
        return [setupDur / (payoffDur + 1), null];
    }

    if (key === 'resolution_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const startIdx = Math.floor(words.length * 0.8);
        const lastWords = words.slice(startIdx);
        if (!lastWords.length) return [0, null];
        const count = countPhraseMatches(lastWords.join(' '), ZYGARNIK_PHRASE_SETS.closure);
        return [count / lastWords.length, null];
    }

    if (key === 'closure_rate_per_min') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const count = countPhraseMatches(transcript.toLowerCase(), ZYGARNIK_PHRASE_SETS.closure);
        return [count / (dur / 60), null];
    }

    if (key === 'tension_arc_score') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const mid = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ');
        const secondHalf = words.slice(mid).join(' ');
        const firstCount = countPhraseMatches(firstHalf, ZYGARNIK_PHRASE_SETS.open_loop);
        const secondCount = countPhraseMatches(secondHalf, ZYGARNIK_PHRASE_SETS.open_loop);
        const firstDensity = firstCount / Math.max(mid, 1);
        const secondDensity = secondCount / Math.max(words.length - mid, 1);
        return [firstDensity - secondDensity, null];
    }

    if (key === 'pre_payoff_open_loop_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const [payoffPct] = extractMetric('payoff_position_pct', analysis);
        const cutoffFrac = payoffPct != null ? payoffPct / 100 : 0.7;
        const cutoffIdx = Math.floor(words.length * cutoffFrac);
        const preWords = words.slice(0, cutoffIdx);
        if (!preWords.length) return [0, null];
        const count = countPhraseMatches(preWords.join(' '), ZYGARNIK_PHRASE_SETS.open_loop);
        return [count / preWords.length, null];
    }

    if (key === 'visual_stake_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const stakeWords = ['danger', 'dramatic', 'intense', 'climax', 'reveal', 'shock',
            'surprise', 'impact', 'extreme', 'before and after', 'transformation'];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            const desc = String(a.sceneDescription || '').toLowerCase();
            const eng = String(a.engagementAnalysis || '').toLowerCase();
            return stakeWords.some(w => desc.includes(w) || eng.includes(w));
        }).length;
        return [ct / frames.length, null];
    }

    if (key === "identity_hook_density") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const htl = ht.toLowerCase();
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, "empty hook"];
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.identity_hook) / w.length, null];
    }

    if (key === "social_proof_hook_density") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const htl = ht.toLowerCase();
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, "empty hook"];
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.social_proof) / w.length, null];
    }

    if (key === "scarcity_hook_density") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const htl = ht.toLowerCase();
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, "empty hook"];
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.scarcity) / w.length, null];
    }

    if (key === "pattern_interrupt_density") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        // Weight early words more (first 25% of video)
        const earlyWords = words.slice(0, Math.ceil(words.length * 0.25)).join(" ");
        return [countPhraseMatches(earlyWords, ZYGARNIK_PHRASE_SETS.pattern_interrupt) / Math.max(earlyWords.split(/\s+/).length, 1), null];
    }

    if (key === "hook_specificity_score") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        // Numbers, percentages, specific time references = high specificity
        const numberMatches = (ht.match(/\b\d+(\.\d+)?(%|\s*percent|\s*times|\s*x|\s*dollars?|\s*seconds?|\s*minutes?|\s*hours?|\s*days?|\s*months?|\s*years?)?\b/gi) || []).length;
        const w = ht.split(/\s+/).filter(Boolean);
        return [numberMatches / Math.max(w.length, 1), null];
    }

    if (key === "hook_number_density") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const numberMatches = (ht.match(/\b\d+\b/g) || []).length;
        const w = ht.split(/\s+/).filter(Boolean);
        return [numberMatches / Math.max(w.length, 1), null];
    }

    if (key === "title_number_count") {
        const title = (meta.title || "").toLowerCase();
        return [(title.match(/\b\d+\b/g) || []).length, null];
    }

    if (key === "micro_commitment_count") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const mcPhrases = [
            "raise your hand", "comment below", "tell me", "let me know",
            "do you agree", "have you tried", "tag someone", "save this",
            "share this", "write yes", "type yes", "tap the", "click the",
            "smash the like", "hit the like",
        ];
        return [countPhraseMatches(tl, mcPhrases), null];
    }

    if (key === "open_loop_before_first_third_flag") {
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        const firstThird = words.slice(0, Math.ceil(words.length / 3)).join(" ");
        const hasOpen = countPhraseMatches(firstThird, ZYGARNIK_PHRASE_SETS.open_loop) > 0;
        const hasClose = countPhraseMatches(firstThird, ZYGARNIK_PHRASE_SETS.closure) > 0;
        return [hasOpen && !hasClose ? 1 : 0, null];
    }

    if (key === "tension_peak_position_pct") {
        // Like zygarnik_tension_peak_pct but for suspense language
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (words.length < 5) return [0, null];
        const windowSize = Math.max(1, Math.floor(words.length * 0.15));
        let maxDensity = 0, peakPos = 0;
        for (let i = 0; i <= words.length - windowSize; i++) {
            const windowText = words.slice(i, i + windowSize).join(" ");
            const count = countPhraseMatches(windowText, ZYGARNIK_PHRASE_SETS.suspense);
            const density = count / windowSize;
            if (density > maxDensity) {
                maxDensity = density;
                peakPos = (i + windowSize / 2) / words.length * 100;
            }
        }
        return [maxDensity > 0 ? peakPos : 0, null];
    }

    if (key === "story_arc_front_load_ratio") {
        // How much narrative tension is in first 40% vs last 60%
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        const splitIdx = Math.floor(words.length * 0.4);
        const firstPart = words.slice(0, splitIdx).join(" ");
        const lastPart = words.slice(splitIdx).join(" ");
        const firstTension = countPhraseMatches(firstPart, ZYGARNIK_PHRASE_SETS.open_loop) +
                             countPhraseMatches(firstPart, ZYGARNIK_PHRASE_SETS.suspense);
        const lastTension = countPhraseMatches(lastPart, ZYGARNIK_PHRASE_SETS.open_loop) +
                            countPhraseMatches(lastPart, ZYGARNIK_PHRASE_SETS.suspense);
        return [firstTension / (lastTension + 1), null];
    }

    if (key === "hook_identity_flag") {
        const ht = hookText();
        if (!ht) return [0, null];
        return [countPhraseMatches(ht.toLowerCase(), ZYGARNIK_PHRASE_SETS.identity_hook) > 0 ? 1 : 0, null];
    }

    // ── Pattern-based keys ───────────────────────────────────────────────

    let m;

    // retention_pct_N
    m = key.match(/^retention_pct_(\d+)$/);
    if (m) {
        const v = curveVal(parseInt(m[1]));
        return v != null ? [v, null] : [null, 'no curve'];
    }

    // retention_mean_LO_HI
    m = key.match(/^retention_mean_(\d+)_(\d+)$/);
    if (m) {
        const lo = parseInt(m[1]), hi = parseInt(m[2]);
        if (curve.length < hi) return [null, 'curve too short'];
        const vals = curve.slice(lo, hi).map(p => p.retention);
        if (!vals.length) return [null, 'empty window'];
        return [mean(vals), null];
    }

    // retention_slope_LO_HI
    m = key.match(/^retention_slope_(\d+)_(\d+)$/);
    if (m) {
        const lo = parseInt(m[1]), hi = parseInt(m[2]);
        if (curve.length < hi) return [null, 'curve too short'];
        const vals = curve.slice(lo, hi).map(p => p.retention);
        if (vals.length < 2) return [null, 'window too small'];
        const x = vals.map((_, i) => i);
        return [linregress(x, vals).slope, null];
    }

    // retention_volatility_LO_HI
    m = key.match(/^retention_volatility_(\d+)_(\d+)$/);
    if (m) {
        const lo = parseInt(m[1]), hi = parseInt(m[2]);
        if (curve.length < hi) return [null, 'curve too short'];
        const vals = curve.slice(lo, hi).map(p => p.retention);
        if (vals.length < 2) return [null, 'window too small'];
        return [std(vals), null];
    }

    // views_log_days_D0_D1
    m = key.match(/^views_log_days_(\d+)_(\d+)$/);
    if (m) {
        const d0 = parseInt(m[1]), d1 = parseInt(m[2]);
        if (!daily.length) return [null, 'no daily views'];
        const totalV = daily.slice(d0, d1).reduce((s, d) => s + (d.views || 0), 0);
        return [Math.log10(totalV + 1), null];
    }

    // views_ratio_X_vs_Y
    m = key.match(/^views_ratio_(\w+)_vs_(\w+)$/);
    if (m) {
        const ri = DAILY_VIEWS_RATIOS.find(r => r[0] === m[1] && r[1] === m[2]);
        if (ri && daily.length) {
            const num = daily.slice(ri[2], ri[3]).reduce((s, d) => s + (d.views || 0), 0);
            const den = daily.slice(ri[4], ri[5]).reduce((s, d) => s + (d.views || 0), 0);
            return [num / (den + 1), null];
        }
        return [null, 'no daily views or unknown ratio'];
    }

    // Interaction: keyA_x_keyB
    m = key.match(/^(.+)_x_(.+)$/);
    if (m) {
        const aKey = m[1], bKey = m[2];
        if (getMetricDefinition(aKey) && getMetricDefinition(bKey)) {
            const [va, skipA] = extractMetric(aKey, analysis);
            const [vb, skipB] = extractMetric(bKey, analysis);
            if (va != null && vb != null) return [va * vb, null];
            return [null, skipA || skipB || 'missing component'];
        }
    }

    return [null, `unknown key: ${key}`];
}


// ── Candidate generation ─────────────────────────────────────────────────

const DEFAULT_CANDIDATES = [
    'hook_retention_pct', 'final_5pct_retention', 'mid_video_cliff',
    'retention_entropy', 'hook_drop_rate', 'early_momentum',
    'retention_25pct', 'retention_50pct', 'retention_75pct', 'retention_90pct',
    'above_baseline_mean', 'peak_count', 'drop_count', 'max_peak_delta',
    'max_drop_delta', 'retention_variance', 'retention_skew',
    'view_accel_7day', 'week1_week2_ratio', 'non_sub_view_share',
    'swipe_away_rate', 'daily_view_peak_day',
    'like_rate', 'comment_rate', 'share_rate', 'subs_gained_per_view',
    'subs_per_like', 'revenue_per_view',
    'duration_log', 'transcript_word_count', 'speech_rate_wps',
    'hook_word_count', 'question_count', 'segment_count',
    'has_hook_segment', 'hook_duration_s',
    'face_frame_pct', 'text_overlay_frame_pct', 'scene_change_count',
    'keep_x_non_sub_share',
];

function generateAutonomousCandidates() {
    const candidates = [];

    for (const pct of RETENTION_POINTS) candidates.push(`retention_pct_${pct}`);
    for (const [lo, hi] of RETENTION_WINDOWS) candidates.push(`retention_mean_${lo}_${hi}`);
    for (const [lo, hi] of RETENTION_WINDOWS) { if (hi - lo >= 5) candidates.push(`retention_slope_${lo}_${hi}`); }
    for (const [lo, hi] of RETENTION_WINDOWS) { if (hi - lo >= 3) candidates.push(`retention_volatility_${lo}_${hi}`); }
    for (const [d0, d1] of DAILY_VIEWS_WINDOWS) candidates.push(`views_log_days_${d0}_${d1}`);
    for (const [numN, denN] of DAILY_VIEWS_RATIOS) candidates.push(`views_ratio_${numN}_vs_${denN}`);

    // Transcript static
    for (const k of ['transcript_word_count', 'question_count', 'speech_rate_wps']) candidates.push(k);
    // Pre-upload transcript
    for (const k of ['transcript_char_count', 'avg_word_length', 'unique_word_ratio',
        'sentence_count', 'exclamation_count', 'uppercase_word_ratio',
        'hook_question_count', 'hook_word_ratio', 'hook_char_count',
        'transcript_number_count']) candidates.push(k);
    // Frame
    for (const k of ['face_frame_pct', 'text_overlay_frame_pct', 'scene_change_count']) candidates.push(k);
    // Pre-upload visual
    for (const k of ['scene_change_rate', 'unique_scene_ratio', 'visual_technique_count_mean',
        'close_up_frame_pct', 'hand_presence_frame_pct', 'motion_word_frame_pct']) candidates.push(k);
    // Pre-upload structure
    for (const k of ['hook_duration_pct', 'avg_segment_duration_s', 'longest_segment_duration_s',
        'shortest_segment_duration_s', 'hook_position_s', 'climax_position_pct',
        'has_climax_segment', 'hook_to_climax_gap_s']) candidates.push(k);
    // Pre-upload metadata
    for (const k of ['duration_s', 'title_char_count', 'title_word_count',
        'title_question_flag', 'title_exclamation_flag', 'title_number_flag']) candidates.push(k);

    // Zygarnik / Open-Loop / Gratification Delay families
    for (const fam of ZYGARNIK_FAMILIES) {
        for (const measure of ['count', 'density']) {
            candidates.push(`${fam}_${measure}`);
            for (const w of ZYGARNIK_EARLY_WINDOWS) {
                candidates.push(`${fam}_${measure}_first${w}s`);
            }
        }
    }
    for (const k of ZYGARNIK_SPECIAL_KEYS) candidates.push(k);

    // Interaction terms
    const seenPairs = new Set();
    for (let i = 0; i < INTERACTION_BASES.length; i++) {
        for (let j = i + 1; j < INTERACTION_BASES.length; j++) {
            const pk = `${INTERACTION_BASES[i]}_x_${INTERACTION_BASES[j]}`;
            if (!seenPairs.has(pk)) { seenPairs.add(pk); candidates.push(pk); }
        }
    }

    // Deduplicate preserving order
    const seen = new Set();
    return candidates.filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
}


function canonicalizeKey(raw) {
    let k = raw.trim().toLowerCase();
    k = k.replace(/[^a-z0-9_]/g, '_');
    k = k.replace(/_+/g, '_').replace(/^_|_$/g, '');
    return k;
}

function validateCandidate(key) {
    if (STATIC_KEYS.has(key)) return true;
    let m;
    m = key.match(/^retention_pct_(\d+)$/);
    if (m) { const pct = parseInt(m[1]); return pct >= 1 && pct <= 99; }
    m = key.match(/^retention_(?:mean|slope|volatility)_(\d+)_(\d+)$/);
    if (m) { const lo = parseInt(m[1]), hi = parseInt(m[2]); return lo >= 0 && lo < hi && hi <= 100; }
    m = key.match(/^views_log_days_(\d+)_(\d+)$/);
    if (m) { const d0 = parseInt(m[1]), d1 = parseInt(m[2]); return d0 >= 0 && d0 < d1 && d1 <= 365; }
    m = key.match(/^views_ratio_(\w+)_vs_(\w+)$/);
    if (m) return DAILY_VIEWS_RATIOS.some(r => r[0] === m[1] && r[1] === m[2]);
    m = key.match(/^(.+)_x_(.+)$/);
    if (m) return getMetricDefinition(m[1]) != null && getMetricDefinition(m[2]) != null;
    return false;
}

function getCandidateLayer(key) {
    const defn = getMetricDefinition(key);
    return defn ? (defn.layer || 'post') : 'post';
}

/**
 * Returns true if key is an interaction composite (a_x_b pattern),
 * excluding hardcoded static keys like keep_x_non_sub_share.
 */
function isCompositeKey(key) {
    if (STATIC_KEYS.has(key)) return false;
    return /^(.+)_x_(.+)$/.test(key);
}

/**
 * Parse a composite key into its component keys.
 * Returns { a, b } or null if not composite.
 */
function parseCompositeKey(key) {
    if (STATIC_KEYS.has(key)) return null;
    const m = key.match(/^(.+)_x_(.+)$/);
    if (!m) return null;
    if (getMetricDefinition(m[1]) && getMetricDefinition(m[2])) return { a: m[1], b: m[2] };
    return null;
}

function biasPool(pool, preuploadRatio) {
    if (preuploadRatio == null) return pool;
    const pre = pool.filter(k => getCandidateLayer(k) === 'pre');
    const post = pool.filter(k => getCandidateLayer(k) !== 'pre');
    if (!pre.length) return pool;
    if (!post.length || preuploadRatio >= 1.0) return [...pre, ...post];
    if (preuploadRatio <= 0.0) return [...post, ...pre];

    const result = [];
    let pi = 0, qi = 0;
    const batch = 10;
    while (pi < pre.length || qi < post.length) {
        const nPre = Math.round(batch * preuploadRatio);
        const nPost = batch - nPre;
        let added = 0;
        while (added < nPre && pi < pre.length) { result.push(pre[pi++]); added++; }
        added = 0;
        while (added < nPost && qi < post.length) { result.push(post[qi++]); added++; }
        if (pi >= pre.length && qi < post.length) { result.push(...post.slice(qi)); break; }
        if (qi >= post.length && pi < pre.length) { result.push(...pre.slice(pi)); break; }
    }
    return result;
}


// ── Resolution logic ─────────────────────────────────────────────────────

const INDICATOR_RESOLUTION_MAP = {
    mid_video_cliff: ['r0', 0, 100, null, null],
    retention_entropy: ['r0', 0, 100, null, null],
    above_baseline_mean: ['r0', 0, 100, null, null],
    peak_count: ['r0', 0, 100, null, null],
    drop_count: ['r0', 0, 100, null, null],
    max_peak_delta: ['r0', 0, 100, null, null],
    max_drop_delta: ['r0', 0, 100, null, null],
    retention_variance: ['r0', 0, 100, null, null],
    retention_skew: ['r0', 0, 100, null, null],
    non_sub_view_share: ['r0', 0, 100, null, null],
    swipe_away_rate: ['r0', 0, 100, null, null],
    daily_view_peak_day: ['r0', 0, 100, null, null],
    duration_log: ['r0', 0, 100, null, null],
    transcript_word_count: ['r0', 0, 100, null, null],
    speech_rate_wps: ['r0', 0, 100, null, null],
    segment_count: ['r0', 0, 100, null, null],
    scene_change_count: ['r0', 0, 100, null, null],
    like_rate: ['r0', 0, 100, null, null],
    comment_rate: ['r0', 0, 100, null, null],
    share_rate: ['r0', 0, 100, null, null],
    subs_gained_per_view: ['r0', 0, 100, null, null],
    subs_per_like: ['r0', 0, 100, null, null],
    revenue_per_view: ['r0', 0, 100, null, null],
    keep_x_non_sub_share: ['r0', 0, 100, null, null],
    face_frame_pct: ['r0', 0, 100, null, null],
    text_overlay_frame_pct: ['r0', 0, 100, null, null],
    transcript_char_count: ['r0', 0, 100, null, null],
    avg_word_length: ['r0', 0, 100, null, null],
    unique_word_ratio: ['r0', 0, 100, null, null],
    sentence_count: ['r0', 0, 100, null, null],
    exclamation_count: ['r0', 0, 100, null, null],
    uppercase_word_ratio: ['r0', 0, 100, null, null],
    transcript_number_count: ['r0', 0, 100, null, null],
    hook_question_count: ['r_hook', 0, 10, null, null],
    hook_word_ratio: ['r_hook', 0, 10, null, null],
    hook_char_count: ['r_hook', 0, 10, null, null],
    hook_duration_pct: ['r_hook', 0, 10, null, null],
    hook_position_s: ['r_hook', 0, 10, null, null],
    avg_segment_duration_s: ['r0', 0, 100, null, null],
    longest_segment_duration_s: ['r0', 0, 100, null, null],
    shortest_segment_duration_s: ['r0', 0, 100, null, null],
    climax_position_pct: ['r0', 0, 100, null, null],
    has_climax_segment: ['r0', 0, 100, null, null],
    hook_to_climax_gap_s: ['r0', 0, 100, null, null],
    duration_s: ['r0', 0, 100, null, null],
    title_char_count: ['r0', 0, 100, null, null],
    title_word_count: ['r0', 0, 100, null, null],
    title_question_flag: ['r0', 0, 100, null, null],
    title_exclamation_flag: ['r0', 0, 100, null, null],
    title_number_flag: ['r0', 0, 100, null, null],
    scene_change_rate: ['r0', 0, 100, null, null],
    unique_scene_ratio: ['r0', 0, 100, null, null],
    visual_technique_count_mean: ['r0', 0, 100, null, null],
    close_up_frame_pct: ['r0', 0, 100, null, null],
    hand_presence_frame_pct: ['r0', 0, 100, null, null],
    motion_word_frame_pct: ['r0', 0, 100, null, null],
    hook_retention_pct: ['r0', 0, 100, null, null],
    retention_25pct: ['r0', 0, 100, null, null],
    retention_50pct: ['r0', 0, 100, null, null],
    retention_75pct: ['r0', 0, 100, null, null],
    retention_90pct: ['r0', 0, 100, null, null],
    final_5pct_retention: ['r_last5pct', 95, 100, null, null],
    hook_drop_rate: ['r_hook', 0, 10, null, null],
    hook_word_count: ['r_hook', 0, 10, null, null],
    has_hook_segment: ['r_hook', 0, 10, null, null],
    hook_duration_s: ['r_hook', 0, 10, null, null],
    early_momentum: ['r_early', 10, 25, null, null],
    view_accel_7day: ['r_week1', null, null, 0, 7],
    week1_week2_ratio: ['r_week1_2', null, null, 0, 14],
};

// ── Zygarnik resolution registration ──
for (const fam of ZYGARNIK_FAMILIES) {
    for (const measure of ['count', 'density']) {
        INDICATOR_RESOLUTION_MAP[`${fam}_${measure}`] = ['r0', 0, 100, null, null];
        for (const w of ZYGARNIK_EARLY_WINDOWS) {
            INDICATOR_RESOLUTION_MAP[`${fam}_${measure}_first${w}s`] =
                w <= 10 ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
        }
    }
}
for (const k of ZYGARNIK_SPECIAL_KEYS) {
    INDICATOR_RESOLUTION_MAP[k] = k.includes('hook') ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
}

const DEFAULT_RESOLUTION_DEFS = {
    r0: { id: 'r0', label: 'Full Video', description: 'Entire video analyzed as one unit.', start_pct: 0, end_pct: 100, start_day: null, end_day: null, granularity: 'whole' },
    r_last5pct: { id: 'r_last5pct', label: 'Last 5% of Video', description: 'Final 5 percent of video.', start_pct: 95, end_pct: 100, start_day: null, end_day: null, granularity: 'video_window' },
    r_hook: { id: 'r_hook', label: 'Hook Window (0-10%)', description: 'First 10 percent of video.', start_pct: 0, end_pct: 10, start_day: null, end_day: null, granularity: 'video_window' },
    r_early: { id: 'r_early', label: 'Early Window (10-25%)', description: 'Post-hook momentum window.', start_pct: 10, end_pct: 25, start_day: null, end_day: null, granularity: 'video_window' },
    r_week1: { id: 'r_week1', label: 'First 7 Days', description: 'First 7 days post-upload.', start_pct: null, end_pct: null, start_day: 0, end_day: 7, granularity: 'time_window' },
    r_week1_2: { id: 'r_week1_2', label: 'Days 0-14', description: 'First two weeks post-upload.', start_pct: null, end_pct: null, start_day: 0, end_day: 14, granularity: 'time_window' },
};

function getResolutionForKey(key) {
    if (INDICATOR_RESOLUTION_MAP[key]) return INDICATOR_RESOLUTION_MAP[key];
    let m;
    m = key.match(/^retention_pct_(\d+)$/);
    if (m) {
        const n = parseInt(m[1]);
        if (n <= 10) return ['r_hook', 0, 10, null, null];
        if (n >= 95) return ['r_last5pct', 95, 100, null, null];
        return [`r_pct_${n}_${n}`, n, n, null, null];
    }
    m = key.match(/^retention_(?:mean|slope|volatility)_(\d+)_(\d+)$/);
    if (m) {
        const lo = parseInt(m[1]), hi = parseInt(m[2]);
        if (lo === 0 && hi === 100) return ['r0', 0, 100, null, null];
        if (hi <= 10) return ['r_hook', 0, 10, null, null];
        if (lo >= 95) return ['r_last5pct', 95, 100, null, null];
        return [`r_pct_${lo}_${hi}`, lo, hi, null, null];
    }
    m = key.match(/^views_log_days_(\d+)_(\d+)$/);
    if (m) return [`r_days_${m[1]}_${m[2]}`, null, null, parseInt(m[1]), parseInt(m[2])];
    m = key.match(/^views_ratio_(\w+)_vs_(\w+)$/);
    if (m) {
        const ri = DAILY_VIEWS_RATIOS.find(r => r[0] === m[1] && r[1] === m[2]);
        if (ri) {
            const endDay = Math.max(ri[3], ri[5]);
            return [`r_days_0_${endDay}`, null, null, 0, endDay];
        }
    }
    return ['r0', 0, 100, null, null];
}


module.exports = {
    // Stats
    mean, std, variance, linregress, pearsonr, spearmanr, skew,
    // Metrics
    extractMetric, getMetricDefinition, getCandidateLayer,
    // Candidates
    DEFAULT_CANDIDATES, generateAutonomousCandidates,
    canonicalizeKey, validateCandidate, biasPool,
    // Composite helpers
    isCompositeKey, parseCompositeKey,
    // Resolution
    INDICATOR_RESOLUTION_MAP, DEFAULT_RESOLUTION_DEFS, getResolutionForKey,
    // Constants
    RETENTION_POINTS, RETENTION_WINDOWS, DAILY_VIEWS_WINDOWS, DAILY_VIEWS_RATIOS,
    INTERACTION_BASES, STATIC_KEYS,
};
