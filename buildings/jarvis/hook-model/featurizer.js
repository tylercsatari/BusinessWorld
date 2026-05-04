/**
 * Hook Model Featurizer — quantifiable indicators only.
 * --------------------------------------------------------
 * Every indicator in this file MUST be a pure function of (text, wps).
 * No domain-specific phrase lists. No topic-specific vocabularies. Only:
 *
 *   - structural   → pure math on the text (counts, ratios)
 *   - linguistic   → uses a CLOSED grammatical category defined by English
 *                    grammar (interrogatives, contrastive conjunctions,
 *                    comparative markers, second-person pronouns)
 *
 * Arbitrary phrase-list indicators (proof_of_work, open_loop, sensory,
 * action_verb, beat_count, anticipation/escalation, hook_phrase_diversity,
 * narrative_tension, social_proof, …) have been removed. They will be
 * re-discovered by the model itself over time as compound features that
 * emerge from interactions of the quantifiable primitives below.
 */

const TIME_WINDOWS = [1, 3, 5, 10];
const DEFAULT_WPS = 4.402;

// ─────────── Closed grammatical categories ───────────
// All members of these lists are defined by their syntactic function in
// English, not by topic or domain. They are NOT arbitrary curated vocabularies.

// Contrastive conjunctions (Quirk et al., A Comprehensive Grammar of the
// English Language, 1985, §13.30+). Closed class.
const CONTRASTIVE_CONJUNCTIONS = [
    'but', 'however', 'yet', 'although', 'whereas', 'while', 'nevertheless',
    'meanwhile', 'despite', 'instead', 'rather', 'conversely', 'nonetheless',
    'on the other hand', 'in contrast'
];

// Comparative markers — comparison constructions in English.
// 'than', 'vs', 'versus' = closed class. The comparative adjectives are
// the most frequent forms; speakers identify them by morphology (-er) or by
// 'more X' / 'less X' syntactic comparison constructions.
const COMPARISON_MARKERS = [
    'than', 'vs', 'versus', 'more', 'less', 'better', 'worse',
    'greater', 'smaller', 'higher', 'lower', 'faster', 'slower'
];

// Interrogative wh-words and inversion auxiliaries used to form questions
// in English. Closed grammatical class.
const INTERROGATIVE_WORDS = new Set([
    'what', 'how', 'why', 'who', 'when', 'where', 'which', 'whose',
    'will', 'can', 'could', 'would', 'should',
    'do', 'does', 'did', 'is', 'are', 'was', 'were',
    'if', 'whether'
]);

// Second-person pronouns — closed grammatical class.
const SECOND_PERSON_PRONOUNS = new Set([
    'you', 'your', 'yours', 'yourself', 'yourselves'
]);

// ─────────── Helpers ───────────

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function tokens(text) { return text.toLowerCase().split(/\s+/).filter(Boolean); }

function countWordBoundary(textLower, words) {
    let total = 0;
    const matches = [];
    for (const w of words) {
        const re = new RegExp('\\b' + escapeRe(w) + '\\b', 'g');
        const found = textLower.match(re);
        if (found) {
            total += found.length;
            for (let i = 0; i < found.length; i++) matches.push(w);
        }
    }
    return { count: total, matches };
}

function countWordSet(textLower, wordSet) {
    const wlist = textLower.split(/\s+/).filter(Boolean);
    let total = 0;
    const matches = [];
    for (const w of wlist) {
        const stripped = w.replace(/[^a-z']/g, '');
        if (wordSet.has(stripped)) { total++; matches.push(stripped); }
    }
    return { count: total, matches };
}

// ─────────── Indicator computations ───────────
// Each returns { count: number, matches: string[] }

function computeTranscriptWordCount(textLower) {
    const trimmed = textLower.trim();
    return { count: trimmed ? trimmed.split(/\s+/).length : 0, matches: [] };
}

function computeTranscriptCharCount(_textLower, originalText) {
    return { count: (originalText || '').length, matches: [] };
}

function computeUniqueWordRatio(textLower) {
    const words = textLower.split(/\s+/).filter(Boolean);
    if (!words.length) return { count: 0, matches: [] };
    return { count: new Set(words).size / words.length, matches: [] };
}

function computeHapaxRatio(textLower) {
    const words = textLower.split(/\s+/).filter(Boolean);
    if (!words.length) return { count: 0, matches: [] };
    const counts = {};
    for (const w of words) counts[w] = (counts[w] || 0) + 1;
    const hapax = Object.entries(counts).filter(([_, c]) => c === 1);
    return { count: hapax.length / words.length, matches: hapax.map(([w]) => w) };
}

function computePivotWordCount(textLower) {
    return countWordBoundary(textLower, CONTRASTIVE_CONJUNCTIONS);
}

function computePivotWordDensity(textLower) {
    const wc = textLower.split(/\s+/).filter(Boolean).length;
    const { count, matches } = computePivotWordCount(textLower);
    return { count: wc ? (count / wc) * 100 : 0, matches };
}

function computeComparisonWordCount(textLower) {
    return countWordBoundary(textLower, COMPARISON_MARKERS);
}

function computeHookWordRatio(textLower) {
    const words = textLower.split(/\s+/).filter(Boolean);
    if (!words.length) return { count: 0, matches: [] };
    const matches = [];
    let n = 0;
    for (const w of words) {
        const stripped = w.replace(/[^a-z']/g, '');
        if (INTERROGATIVE_WORDS.has(stripped)) { n++; matches.push(stripped); }
    }
    return { count: n / words.length, matches };
}

function computeSecondPersonRatio(textLower) {
    const words = textLower.split(/\s+/).filter(Boolean);
    if (!words.length) return { count: 0, matches: [] };
    const matches = [];
    let n = 0;
    for (const w of words) {
        const stripped = w.replace(/[^a-z']/g, '');
        if (SECOND_PERSON_PRONOUNS.has(stripped)) { n++; matches.push(stripped); }
    }
    return { count: n / words.length, matches };
}

function computeHookQuestionCount(_textLower, originalText) {
    const matches = (originalText || '').match(/\?/g) || [];
    return { count: matches.length, matches: matches.length ? ['?'] : [] };
}

function computeHookQuestionDensity(textLower, originalText) {
    const wc = textLower.split(/\s+/).filter(Boolean).length;
    const { count } = computeHookQuestionCount(textLower, originalText);
    return { count: wc ? count / wc : 0, matches: [] };
}

function computeExclamationCount(_textLower, originalText) {
    const matches = (originalText || '').match(/!/g) || [];
    return { count: matches.length, matches: matches.length ? ['!'] : [] };
}

function computeRepeatedPhraseCount(textLower) {
    const words = textLower.split(/\s+/).filter(Boolean);
    const positions = {};
    for (let i = 0; i < words.length - 1; i++) {
        const bg = words[i] + ' ' + words[i + 1];
        if (!positions[bg]) positions[bg] = [];
        positions[bg].push(i);
    }
    let count = 0;
    const matches = [];
    for (const [bg, pos] of Object.entries(positions)) {
        if (pos.length < 2) continue;
        for (let i = 1; i < pos.length; i++) {
            if (pos[i] - pos[i - 1] >= 10) { count++; matches.push(bg); break; }
        }
    }
    return { count, matches };
}

// ─────────── Indicator registry ───────────
// `category` is one of:
//   'structural'   → computed from text statistics, no vocabulary at all
//   'linguistic'   → uses a CLOSED grammatical category (interrogatives,
//                    contrastive conjunctions, comparative markers, pronouns)
// `algorithm` is the precise rule shown to the user in the node panel.
// `quantifiable_reason` justifies why it does not depend on domain knowledge.

const HOOK_INDICATORS = {
    transcript_word_count: {
        r: 0.264, p: 4.1e-7, n: 370,
        category: 'structural',
        description: 'Total word count of the windowed text.',
        algorithm: 'len(text.split()) — counts whitespace-separated tokens.',
        quantifiable_reason: 'Pure tokenization. No vocabulary, no domain knowledge.',
        compute: (textLower) => computeTranscriptWordCount(textLower),
    },
    transcript_char_count: {
        r: 0.256, p: 8.2e-7, n: 370,
        category: 'structural',
        description: 'Total character count of the windowed text.',
        algorithm: 'len(text) — counts characters including spaces and punctuation.',
        quantifiable_reason: 'Pure character count. No vocabulary involved.',
        compute: (_, originalText) => computeTranscriptCharCount(_, originalText),
    },
    unique_word_ratio: {
        r: -0.203, p: 8.3e-5, n: 370,
        category: 'structural',
        description: 'Type–token ratio: unique words divided by total words.',
        algorithm: 'len(set(words)) / len(words). Standard type–token ratio.',
        quantifiable_reason: 'Pure math on word identities. No domain knowledge.',
        compute: (textLower) => computeUniqueWordRatio(textLower),
    },
    hapax_legomena_ratio: {
        r: -0.185, p: 3.6e-4, n: 370,
        category: 'structural',
        description: 'Fraction of words that appear exactly once (hapax legomena).',
        algorithm: 'count(w for w in words if words.count(w) == 1) / len(words). A standard corpus-linguistics metric.',
        quantifiable_reason: 'Counts singletons — a closed mathematical operation. No vocabulary required.',
        compute: (textLower) => computeHapaxRatio(textLower),
    },
    pivot_word_count: {
        r: 0.241, p: 2.7e-6, n: 370,
        category: 'linguistic',
        description: 'Count of contrastive conjunctions (a closed grammatical category in English).',
        algorithm: "Counts whole-word, case-insensitive matches of the closed grammatical category of contrastive conjunctions: ['but', 'however', 'yet', 'although', 'whereas', 'while', 'nevertheless', 'meanwhile', 'despite', 'instead', 'rather', 'conversely', 'nonetheless', 'on the other hand', 'in contrast']. These are defined by English grammar (Quirk et al., 1985, §13.30+), not by arbitrary topic selection.",
        quantifiable_reason: 'Contrastive conjunctions are a CLOSED grammatical class in English — defined by syntactic function, not by topic. Membership is fixed by the language, not curated.',
        wordList: CONTRASTIVE_CONJUNCTIONS,
        compute: (textLower) => computePivotWordCount(textLower),
    },
    pivot_word_density: {
        r: 0.154, p: 0.003, n: 370,
        category: 'linguistic',
        description: 'Contrastive conjunctions per 100 words — length-normalized.',
        algorithm: '(pivot_word_count / max(word_count, 1)) × 100. Density per 100 words.',
        quantifiable_reason: 'Same closed grammatical class as pivot_word_count, normalized for text length.',
        wordList: CONTRASTIVE_CONJUNCTIONS,
        compute: (textLower) => computePivotWordDensity(textLower),
    },
    comparison_word_count: {
        r: 0.153, p: 0.003, n: 370,
        category: 'linguistic',
        description: 'Count of comparative markers (a closed grammatical class).',
        algorithm: "Counts whole-word matches of comparative markers: ['than', 'vs', 'versus', 'more', 'less', 'better', 'worse', 'greater', 'smaller', 'higher', 'lower', 'faster', 'slower']. These signal grammatical comparison constructions.",
        quantifiable_reason: "'than', 'vs', 'versus' are closed-class function words. The comparative adjectives ('more', 'less', '-er' forms) are part of the comparison construction grammar, not topic vocabulary.",
        wordList: COMPARISON_MARKERS,
        compute: (textLower) => computeComparisonWordCount(textLower),
    },
    hook_word_ratio: {
        r: -0.269, p: 1.4e-7, n: 370,
        category: 'linguistic',
        description: 'Fraction of interrogative wh-words and inversion auxiliaries.',
        algorithm: "count(w in {'what','how','why','who','when','where','which','whose','will','can','could','would','should','do','does','did','is','are','was','were','if','whether'}) / len(words). Closed grammatical class of interrogatives + auxiliaries used in question formation.",
        quantifiable_reason: 'WH-words and inversion auxiliaries form a closed grammatical class for question formation in English. Membership is fixed by the language.',
        wordList: Array.from(INTERROGATIVE_WORDS),
        compute: (textLower) => computeHookWordRatio(textLower),
    },
    second_person_ratio: {
        r: -0.138, p: 0.008, n: 370,
        category: 'linguistic',
        description: "Fraction of second-person pronouns ('you', 'your', 'yours', 'yourself', 'yourselves').",
        algorithm: "count(w in {'you','your','yours','yourself','yourselves'}) / len(words). Closed grammatical class of second-person pronouns.",
        quantifiable_reason: 'Second-person pronouns are a closed grammatical class in English. Five entries, fixed by the language.',
        wordList: Array.from(SECOND_PERSON_PRONOUNS),
        compute: (textLower) => computeSecondPersonRatio(textLower),
    },
    hook_question_count: {
        r: 0.126, p: 0.015, n: 370,
        category: 'structural',
        description: "Number of '?' punctuation marks in the windowed text.",
        algorithm: "Counts occurrences of '?' in the original (case-preserving) text.",
        quantifiable_reason: 'Counts a single punctuation glyph. No vocabulary, no domain knowledge.',
        compute: (textLower, originalText) => computeHookQuestionCount(textLower, originalText),
    },
    hook_question_density: {
        r: 0.156, p: 0.003, n: 370,
        category: 'structural',
        description: "'?' per word in the windowed text.",
        algorithm: "count('?') / max(word_count, 1).",
        quantifiable_reason: 'Pure ratio of a punctuation glyph to token count.',
        compute: (textLower, originalText) => computeHookQuestionDensity(textLower, originalText),
    },
    exclamation_count: {
        r: -0.142, p: 0.006, n: 370,
        category: 'structural',
        description: "Number of '!' punctuation marks in the windowed text.",
        algorithm: "Counts occurrences of '!' in the original text.",
        quantifiable_reason: 'Counts a single punctuation glyph. No vocabulary required.',
        compute: (textLower, originalText) => computeExclamationCount(textLower, originalText),
    },
    repeated_phrase_count: {
        r: 0.217, p: 2.8e-5, n: 367,
        category: 'structural',
        description: 'Number of bigrams that repeat 2+ times with at least 10 words between occurrences.',
        algorithm: 'Build all bigrams. For each bigram with 2+ occurrences, check if any consecutive pair of occurrences is separated by ≥10 word positions. Count bigrams that satisfy this. No phrase list — the bigrams come from the text itself.',
        quantifiable_reason: 'Pure structural detection of self-repetition with positional gap. No vocabulary or topic knowledge.',
        compute: (textLower) => computeRepeatedPhraseCount(textLower),
    },
};

// ─────────── Indicators removed (will emerge later) ───────────
// These are exposed so the UI can show greyed-out placeholders and explain
// why they are not in the model right now. The list is *informational only*
// — featurize() does not compute them.
const REMOVED_INDICATORS = [
    { key: 'proof_of_work_count',         reason: '31 hand-curated phrases. Should emerge as a compound of action verbs + first-person + past tense.' },
    { key: 'open_loop_count',             reason: '30+ hand-curated phrases. Should emerge from interrogatives + future modals + uncertainty markers.' },
    { key: 'sensory_count',               reason: '26 hand-curated words. Should emerge from concrete-noun classifiers, not a fixed list.' },
    { key: 'action_verb_count',           reason: '40 hand-curated verbs. Should emerge from POS tagging + verb-class clusters.' },
    { key: 'beat_count',                  reason: '10 hand-curated sentence starters. Should emerge from discourse-marker analysis.' },
    { key: 'contrast_count',              reason: 'Overlaps pivot_word but uses different curated phrases. Not independently grammatical.' },
    { key: 'hook_phrase_diversity',       reason: 'Counts presence across multiple curated families. Compound of arbitrary lists.' },
    { key: 'anticipation_escalation_position_pct', reason: 'Position of first match against curated escalation phrases. Arbitrary.' },
    { key: 'urgency_count',               reason: 'Hand-curated urgency phrases.' },
    { key: 'stakes_count',                reason: 'Hand-curated stakes phrases.' },
    { key: 'callback_count',              reason: 'Hand-curated callback phrases.' },
    { key: 'credibility_signal',          reason: 'Hand-curated credibility phrases.' },
    { key: 'gap_tease_count',             reason: 'Hand-curated phrase family.' },
    { key: 'narrative_clock_count',       reason: 'Hand-curated phrase family.' },
    { key: 'progressive_reveal_count',    reason: 'Hand-curated phrase family.' },
    { key: 'authority_stack_count',       reason: 'Hand-curated phrase family.' },
    { key: 'specificity_anchor',          reason: 'Hand-curated specificity phrases.' },
    { key: 'pre_gratification',           reason: 'Hand-curated phrases.' },
    { key: 'narrative_tension',           reason: 'Hand-curated phrases.' },
    { key: 'social_proof',                reason: 'Hand-curated phrases.' },
    { key: 'loop_stacking',               reason: "Definition of 'loop' itself depends on curated phrase lists." },
    { key: 'persistence_signal',          reason: 'Hand-curated phrases.' },
];

// ─────────── Window extraction ───────────

function extractWindow(words, windowSec, wps) {
    const n = Math.max(1, Math.round(windowSec * wps));
    return words.slice(0, n).join(' ');
}

// ─────────── Public API ───────────

function featurize(hookText, wps = DEFAULT_WPS) {
    const allWords = (hookText || '').split(/\s+/).filter(Boolean);
    const windows = {};
    for (const w of TIME_WINDOWS) windows[w] = extractWindow(allWords, w, wps);

    const features = {};
    const matched = {};

    for (const [key, ind] of Object.entries(HOOK_INDICATORS)) {
        for (const w of TIME_WINDOWS) {
            const text = windows[w];
            const textLower = text.toLowerCase();
            const out = ind.compute(textLower, text);
            const fkey = `${key}_w${w}`;
            features[fkey] = out.count || 0;
            matched[fkey] = out.matches || [];
        }
    }

    return {
        features,
        windows,
        matched,
        indicators: Object.keys(HOOK_INDICATORS),
        wps,
    };
}

function getWordTimings(text, wps = DEFAULT_WPS) {
    const words = (text || '').split(/\s+/).filter(Boolean);
    const dt = 1 / Math.max(wps, 0.1);
    const out = [];
    for (let i = 0; i < words.length; i++) {
        const t = i * dt;
        const inWindows = TIME_WINDOWS.filter(w => t < w);
        out.push({
            word: words[i],
            index: i,
            t: parseFloat(t.toFixed(3)),
            windows: inWindows,
            tier: inWindows.length ? inWindows[0] : null,
        });
    }
    return out;
}

function getIndicators() {
    const out = {};
    for (const [key, ind] of Object.entries(HOOK_INDICATORS)) {
        out[key] = {
            r: ind.r,
            p: ind.p,
            n: ind.n,
            category: ind.category,
            description: ind.description,
            algorithm: ind.algorithm,
            quantifiable_reason: ind.quantifiable_reason,
            wordList: ind.wordList || null,
        };
    }
    return out;
}

function getRemovedIndicators() { return REMOVED_INDICATORS.slice(); }

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        featurize,
        getIndicators,
        getRemovedIndicators,
        getWordTimings,
        HOOK_INDICATORS,
        REMOVED_INDICATORS,
        TIME_WINDOWS,
        DEFAULT_WPS,
    };
}

if (typeof window !== 'undefined') {
    window.HookModelFeaturizer = {
        featurize, getIndicators, getRemovedIndicators, getWordTimings,
        HOOK_INDICATORS, REMOVED_INDICATORS, TIME_WINDOWS, DEFAULT_WPS,
    };
}
