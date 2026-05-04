/**
 * Hook Model Featurizer
 * --------------------
 * Pure-JS port of the indicator computation logic from jarvis-metrics.js.
 * Given a hook script + words-per-second, computes each indicator value at
 * @1s, @3s, @5s, @10s windows and returns the feature vector + matched
 * phrases for UI highlighting.
 *
 * Word lists are verbatim from jarvis-metrics.js. R-values come from
 * indicators.json (measured Pearson r on 370 Tyler Csatari videos).
 */

const TIME_WINDOWS = [1, 3, 5, 10];
const DEFAULT_WPS = 4.402;

// ─────────── Word / phrase lists (verbatim from jarvis-metrics.js) ───────────

const PIVOT_WORDS = [
    'but', 'however', 'yet', 'although', 'whereas', 'while', 'nevertheless',
    'meanwhile', 'despite', 'instead', 'rather', 'conversely', 'nonetheless',
    'on the other hand', 'in contrast'
];

const SENSORY_WORDS = [
    'feel', 'touch', 'cold', 'warm', 'hot', 'sharp', 'rough', 'smooth',
    'loud', 'quiet', 'bright', 'dark', 'smell', 'taste', 'bitter', 'sweet',
    'soft', 'hard', 'heavy', 'light', 'thick', 'thin', 'pain', 'ache',
    'burn', 'tingle'
];

const OPEN_LOOP_PHRASES = [
    'what if', 'i wonder', "let's see", 'will it', 'can i', 'can we',
    'how many', 'is it possible', 'to find out', 'to see if', 'to see how',
    'to test', 'but first', 'wait until', 'watch what', "you won't believe",
    "let's find out", 'the question is', 'i wanted to see', 'i wanted to find out',
    'i wanted to test', 'i wanted to know', 'could i', 'could we', 'would it',
    'i need to know', 'i have to try', 'we need to find', "let's test",
    'to figure out', 'if it works', 'if this works', 'whether it'
];

const PROOF_OF_WORK_PHRASES = [
    'i tested', 'i tried', 'i built', 'i made', 'i created', 'i spent',
    'i walked', 'i ran', 'i ate', 'i wore', 'i did', 'i used',
    'after testing', 'after trying', 'after building', 'after making',
    'i found out', 'i discovered', 'i learned', 'i measured',
    'this took', 'this cost', 'it took me', 'it cost me',
    'i calculated', 'i counted', 'i tracked', 'i recorded',
    'according to my', 'based on my', 'from my testing'
];

const CONTRAST_PHRASES = [
    'but', 'however', 'instead', 'versus', 'surprisingly', 'actually',
    'except', 'though', 'although', 'yet', 'on the other hand',
    'plot twist', 'the catch'
];

const ACTION_VERB_PHRASES = [
    'make', 'making', 'build', 'building', 'create', 'creating',
    'try', 'trying', 'test', 'testing', 'break', 'breaking',
    'destroy', 'destroying', 'cut', 'cutting', 'open', 'opening',
    'eat', 'eating', 'cook', 'cooking', 'turn', 'turning',
    'use', 'using', 'smash', 'smashing', 'drop', 'dropping',
    'launch', 'launching', 'pour', 'pouring', 'mix', 'mixing'
];

const ESCALATION_PHRASES = [
    "and it gets worse", "but wait", "and then", "and here's the thing",
    "but here's where it gets", "and that's when", "and just when",
    "but the worst part", "and it only gets", "and then something happened",
    "and i realized", "and at that moment", "right at that point"
];

const HOOK_TYPE_WORDS = new Set([
    'what', 'how', 'why', 'will', 'can', 'could', 'would',
    'watch', 'see', 'look', 'check', 'wait', 'but', 'if'
]);

const BEAT_STARTERS_RE = /^(So|And\s+then|Now|But\s+then|Then|After|Before|When|Until|Because|Which\s+means)\b/i;

const TITLE_ACTION_RE = /^(Making|Building|Testing|Breaking|Trying|Running|Walking|Eating|Creating|Destroying|Climbing|Lifting|Cutting|Firing|Launching|Smashing|Dropping|Pouring|Growing|Wearing)/i;

// ─────────── Helpers ───────────

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokens(text) {
    return text.toLowerCase().split(/\s+/).filter(Boolean);
}

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

function countPhrases(textLower, phrases) {
    let total = 0;
    const matches = [];
    for (const p of phrases) {
        const re = new RegExp(escapeRe(p), 'g');
        const found = textLower.match(re);
        if (found) {
            total += found.length;
            for (let i = 0; i < found.length; i++) matches.push(p);
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
        if (wordSet.has(stripped)) {
            total++;
            matches.push(stripped);
        }
    }
    return { count: total, matches };
}

// ─────────── Indicator computations ───────────
// Each returns { value: number, matches: string[] }

function computePivotWordCount(textLower) {
    return countWordBoundary(textLower, PIVOT_WORDS);
}

function computeSensoryCount(textLower) {
    const set = new Set(SENSORY_WORDS);
    return countWordSet(textLower, set);
}

function computeOpenLoopCount(textLower) {
    return countPhrases(textLower, OPEN_LOOP_PHRASES);
}

function computeOpenLoopFirstHalf(textLower) {
    const words = textLower.split(/\s+/).filter(Boolean);
    if (!words.length) return { count: 0, matches: [] };
    const mid = Math.floor(words.length / 2);
    const firstHalf = words.slice(0, mid).join(' ');
    return countPhrases(firstHalf, OPEN_LOOP_PHRASES);
}

function computeProofOfWorkCount(textLower) {
    return countPhrases(textLower, PROOF_OF_WORK_PHRASES);
}

function computeContrastCount(textLower) {
    return countPhrases(textLower, CONTRAST_PHRASES);
}

function computeActionVerbCount(textLower) {
    return countPhrases(textLower, ACTION_VERB_PHRASES);
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
            if (pos[i] - pos[i - 1] >= 10) {
                count++;
                matches.push(bg);
                break;
            }
        }
    }
    return { count, matches };
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
    return {
        count: hapax.length / words.length,
        matches: hapax.map(([w]) => w),
    };
}

function computeBeatCount(text) {
    const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    const matches = sentences.filter(s => BEAT_STARTERS_RE.test(s));
    return { count: matches.length, matches };
}

function computeTranscriptWordCount(textLower) {
    const trimmed = textLower.trim();
    return { count: trimmed ? trimmed.split(/\s+/).length : 0, matches: [] };
}

function computeTranscriptCharCount(text) {
    return { count: text.length, matches: [] };
}

function computeHookWordRatio(textLower) {
    const words = textLower.split(/\s+/).filter(Boolean);
    if (!words.length) return { count: 0, matches: [] };
    const matches = [];
    let hookN = 0;
    for (const w of words) {
        const stripped = w.replace(/[^a-z']/g, '');
        if (HOOK_TYPE_WORDS.has(stripped)) {
            hookN++;
            matches.push(stripped);
        }
    }
    return { count: hookN / words.length, matches };
}

function computeHookPhraseDiversity(textLower) {
    const families = [
        ['open_loop', OPEN_LOOP_PHRASES],
        ['contrast', CONTRAST_PHRASES],
        ['action_verb', ACTION_VERB_PHRASES],
        ['proof_of_work', PROOF_OF_WORK_PHRASES],
    ];
    let n = 0;
    const matches = [];
    for (const [name, phrases] of families) {
        if (phrases.some(p => textLower.includes(p))) {
            n++;
            matches.push(name);
        }
    }
    // Sensory uses word-set semantics
    const set = new Set(SENSORY_WORDS);
    if (textLower.split(/\s+/).some(w => set.has(w.replace(/[^a-z']/g, '')))) {
        n++;
        matches.push('sensory');
    }
    return { count: n, matches };
}

function computeAnticipationEscalationPositionPct(textLower) {
    const words = textLower.split(/\s+/).filter(Boolean);
    if (!words.length) return { count: 0, matches: [], missing: true };
    for (let i = 0; i < words.length; i++) {
        const window = words.slice(i, i + 6).join(' ');
        for (const p of ESCALATION_PHRASES) {
            if (window.includes(p)) {
                return { count: i / words.length, matches: [p], missing: false };
            }
        }
    }
    return { count: 0, matches: [], missing: true };
}

// ─────────── Indicator registry ───────────
// Each entry exposes its r-value, description, and a compute() that returns
// { count, matches }. The featurizer iterates this registry per time window.

const HOOK_INDICATORS = {
    pivot_word_count: {
        r: 0.241, p: 2.7e-6, n: 370,
        description: 'Count of pivot/contrast words (but, however, yet, although…).',
        wordList: PIVOT_WORDS,
        compute: (textLower) => computePivotWordCount(textLower),
    },
    sensory_count: {
        r: 0.197, p: 1.4e-4, n: 370,
        description: 'Count of sensory/physical words (cold, sharp, loud, taste…).',
        wordList: SENSORY_WORDS,
        compute: (textLower) => computeSensoryCount(textLower),
    },
    open_loop_count: {
        r: 0.206, p: 6.6e-5, n: 370,
        description: 'Count of open-loop / Zeigarnik phrases (what if, will it, can I…).',
        wordList: OPEN_LOOP_PHRASES,
        compute: (textLower) => computeOpenLoopCount(textLower),
    },
    open_loop_count_first_half: {
        r: 0.206, p: 6.6e-5, n: 370,
        description: 'Open-loop matches in first half of hook only.',
        wordList: OPEN_LOOP_PHRASES,
        compute: (textLower) => computeOpenLoopFirstHalf(textLower),
    },
    proof_of_work_count: {
        r: 0.211, p: 4.4e-5, n: 370,
        description: 'Count of proof-of-work phrases (i tested, i built, i spent…).',
        wordList: PROOF_OF_WORK_PHRASES,
        compute: (textLower) => computeProofOfWorkCount(textLower),
    },
    contrast_count: {
        r: 0.205, p: 7.4e-5, n: 370,
        description: 'Count of contrast phrases (but, however, instead, plot twist…).',
        wordList: CONTRAST_PHRASES,
        compute: (textLower) => computeContrastCount(textLower),
    },
    action_verb_count: {
        r: 0.183, p: 3.7e-4, n: 370,
        description: 'Count of action verbs (make, build, test, smash, drop…).',
        wordList: ACTION_VERB_PHRASES,
        compute: (textLower) => computeActionVerbCount(textLower),
    },
    repeated_phrase_count: {
        r: 0.217, p: 2.8e-5, n: 367,
        description: 'Bigrams repeated 2+ times with gap >= 10 words (verbal callbacks).',
        compute: (textLower) => computeRepeatedPhraseCount(textLower),
    },
    unique_word_ratio: {
        r: -0.203, p: 8.3e-5, n: 370,
        description: 'Unique words / total words. Higher = more vocab variety = fewer views.',
        compute: (textLower) => computeUniqueWordRatio(textLower),
    },
    hapax_legomena_ratio: {
        r: -0.185, p: 3.6e-4, n: 370,
        description: 'Fraction of words appearing exactly once. Lower = more repetition = more views.',
        compute: (textLower) => computeHapaxRatio(textLower),
    },
    beat_count: {
        r: 0.226, p: 1.1e-5, n: 370,
        description: 'Narrative beats — sentences starting with So/And then/Now/But then/etc.',
        compute: (_, originalText) => computeBeatCount(originalText),
    },
    transcript_word_count: {
        r: 0.264, p: 4.1e-7, n: 370,
        description: 'Total word count (longer hooks correlate with more views).',
        compute: (textLower) => computeTranscriptWordCount(textLower),
    },
    transcript_char_count: {
        r: 0.256, p: 8.2e-7, n: 370,
        description: 'Total character count of the hook.',
        compute: (_, originalText) => computeTranscriptCharCount(originalText),
    },
    hook_word_ratio: {
        r: -0.269, p: 1.4e-7, n: 370,
        description: 'Fraction of hook-type words (what/how/why/will/can…). Negative: overusing hurts.',
        compute: (textLower) => computeHookWordRatio(textLower),
    },
    hook_phrase_diversity: {
        r: 0.186, p: 2.8e-4, n: 370,
        description: 'Number of distinct phrase families present in the hook.',
        compute: (textLower) => computeHookPhraseDiversity(textLower),
    },
    anticipation_escalation_position_pct: {
        r: -0.227, p: 0.033, n: 88,
        description: 'Position (0–1) of first escalation phrase. Earlier = fewer views.',
        wordList: ESCALATION_PHRASES,
        compute: (textLower) => computeAnticipationEscalationPositionPct(textLower),
    },
};

// ─────────── Window extraction ───────────

function extractWindow(words, windowSec, wps) {
    const n = Math.max(1, Math.round(windowSec * wps));
    return words.slice(0, n).join(' ');
}

// ─────────── Public API ───────────

/**
 * Compute features for a hook script across all time windows.
 * @param {string} hookText
 * @param {number} wps - words per second (default 4.402)
 * @returns {{ features: Object, windows: Object, matched: Object, indicators: string[] }}
 */
function featurize(hookText, wps = DEFAULT_WPS) {
    const allWords = (hookText || '').split(/\s+/).filter(Boolean);
    const windows = {};
    for (const w of TIME_WINDOWS) {
        windows[w] = extractWindow(allWords, w, wps);
    }

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

/**
 * Returns the registry of indicators (key → metadata).
 */
function getIndicators() {
    const out = {};
    for (const [key, ind] of Object.entries(HOOK_INDICATORS)) {
        out[key] = {
            r: ind.r,
            p: ind.p,
            n: ind.n,
            description: ind.description,
            wordList: ind.wordList || null,
        };
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        featurize,
        getIndicators,
        HOOK_INDICATORS,
        TIME_WINDOWS,
        DEFAULT_WPS,
        // Also expose word lists for highlighting in the UI
        WORD_LISTS: {
            pivot_word_count: PIVOT_WORDS,
            sensory_count: SENSORY_WORDS,
            open_loop_count: OPEN_LOOP_PHRASES,
            open_loop_count_first_half: OPEN_LOOP_PHRASES,
            proof_of_work_count: PROOF_OF_WORK_PHRASES,
            contrast_count: CONTRAST_PHRASES,
            action_verb_count: ACTION_VERB_PHRASES,
            anticipation_escalation_position_pct: ESCALATION_PHRASES,
        },
    };
}

if (typeof window !== 'undefined') {
    window.HookModelFeaturizer = { featurize, getIndicators, HOOK_INDICATORS, TIME_WINDOWS, DEFAULT_WPS };
}
