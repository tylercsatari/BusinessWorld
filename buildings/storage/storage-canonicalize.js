/**
 * Text normalization and canonicalization service.
 * Ported from StorageAI/src/domain/canonicalize.py and parse_intent.py normalization.
 */
const StorageCanonicalize = (() => {
    // Irregular plurals
    const IRREGULARS = {
        'children': 'child', 'men': 'man', 'women': 'woman', 'people': 'person',
        'teeth': 'tooth', 'feet': 'foot', 'mice': 'mouse', 'geese': 'goose',
        'oxen': 'ox', 'lice': 'louse', 'cacti': 'cactus', 'fungi': 'fungus',
        'alumni': 'alumnus', 'larvae': 'larva', 'vertebrae': 'vertebra',
        'knives': 'knife', 'wives': 'wife', 'lives': 'life', 'wolves': 'wolf',
        'halves': 'half', 'shelves': 'shelf', 'leaves': 'leaf', 'loaves': 'loaf',
        'thieves': 'thief', 'scarves': 'scarf'
    };

    // Articles and determiners to strip
    const ARTICLES = ['a', 'an', 'the', 'some', 'any', 'another', 'additional', 'extra', 'more'];

    // Quantity/measure phrases to strip (e.g., "pieces of", "sticks of")
    const QTY_PHRASES_RE = /\b(sticks?|pieces?|bottles?|cans?|bags?|boxes?|packs?|pairs?|sets?|rolls?|sheets?|cups?|slices?|loaves?|bunches?|bars?|tubes?|tubs?|cartons?|cases?|batches?)\s+of\s+/gi;

    // Spoken letter map (for box names)
    const SPOKEN_LETTERS = {
        'ay': 'a', 'bee': 'b', 'be': 'b', 'cee': 'c', 'see': 'c', 'sea': 'c',
        'dee': 'd', 'ee': 'e', 'ef': 'f', 'eff': 'f', 'gee': 'g', 'aitch': 'h',
        'eye': 'i', 'jay': 'j', 'kay': 'k', 'el': 'l', 'em': 'm', 'en': 'n',
        'oh': 'o', 'pee': 'p', 'queue': 'q', 'cue': 'q', 'are': 'r', 'ar': 'r',
        'ess': 's', 'tee': 't', 'you': 'u', 'vee': 'v', 'double-u': 'w',
        'ex': 'x', 'why': 'y', 'zee': 'z', 'zed': 'z'
    };

    // Quantity word map
    const QTY_WORDS = {
        'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
        'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
        'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
        'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
        'a': 1, 'an': 1
    };

    // Number words → digits (for box name normalization)
    const NUMBER_WORDS_TO_DIGITS = {
        'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
        'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
        'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
        'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
        'eighteen': '18', 'nineteen': '19', 'twenty': '20'
    };

    // Digits → number words (reverse mapping)
    const DIGITS_TO_WORDS = {};
    for (const [word, digit] of Object.entries(NUMBER_WORDS_TO_DIGITS)) {
        DIGITS_TO_WORDS[digit] = word;
    }

    /**
     * Normalize a box name to a canonical form for comparison.
     * Converts number words ↔ digits so "SHOES ONE" and "SHOES 1" match.
     * Returns lowercase with all number words converted to digits.
     */
    function canonicalizeBoxName(name) {
        if (!name) return '';
        let n = name.trim().toLowerCase().replace(/[.!?,;:]+$/, '');
        n = n.replace(/^box\s+/i, '');
        // Map spoken letters
        const tokens = n.split(/\s+/);
        const normalized = tokens.map(t => {
            if (StorageCanonicalize.SPOKEN_LETTERS[t]) return StorageCanonicalize.SPOKEN_LETTERS[t];
            if (NUMBER_WORDS_TO_DIGITS[t]) return NUMBER_WORDS_TO_DIGITS[t];
            return t;
        });
        return normalized.join(' ').toUpperCase();
    }

    function singularizeToken(token) {
        if (!token || token.length <= 2) return token;
        const lower = token.toLowerCase();
        if (IRREGULARS[lower]) return IRREGULARS[lower];
        // Check if it looks like an acronym (all uppercase) — don't singularize
        if (token === token.toUpperCase() && token.length <= 4) {
            // Strip trailing 's' from acronyms like "TVs" → "TV"
            return lower.endsWith('s') ? lower.slice(0, -1) : lower;
        }
        if (lower.endsWith('ies') && lower.length > 4) return lower.slice(0, -3) + 'y';
        if (lower.endsWith('xes') || lower.endsWith('zes') || lower.endsWith('ches') || lower.endsWith('shes') || lower.endsWith('sses')) {
            return lower.slice(0, -2);
        }
        if (lower.endsWith('ses') && lower.length > 4) return lower.slice(0, -1);
        if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us') && !lower.endsWith('is')) {
            return lower.slice(0, -1);
        }
        return lower;
    }

    return {
        SPOKEN_LETTERS,
        QTY_WORDS,
        NUMBER_WORDS_TO_DIGITS,
        DIGITS_TO_WORDS,
        canonicalizeBoxName,

        /**
         * Basic canonicalize: lowercase, trim, collapse whitespace
         */
        canonicalize(name) {
            if (!name) return '';
            return name.trim().toLowerCase().replace(/\s+/g, ' ');
        },

        /**
         * Full normalization to singular form for matching/storage.
         * Strips articles, quantity phrases, singularizes.
         */
        normalizeToSingular(name) {
            if (!name) return '';
            let n = name.trim().toLowerCase();
            // Strip trailing punctuation
            n = n.replace(/[.!?,;:]+$/, '');
            // Strip leading articles/determiners
            const articleRe = new RegExp(`^(${ARTICLES.join('|')})\\s+`, 'i');
            n = n.replace(articleRe, '');
            // Remove quantity/measure phrases
            n = n.replace(QTY_PHRASES_RE, '');
            // Collapse whitespace
            n = n.replace(/\s+/g, ' ').trim();
            if (!n) return '';
            // Singularize last token only
            const tokens = n.split(' ');
            tokens[tokens.length - 1] = singularizeToken(tokens[tokens.length - 1]);
            return tokens.join(' ');
        },

        /**
         * Normalize item name for intent parsing.
         * Strips articles, quantifiers, trailing descriptors, singularizes.
         */
        normalizeItem(name) {
            if (!name) return '';
            let n = name.trim().toLowerCase();
            n = n.replace(/[.!?,;:]+$/, '');
            // Strip leading articles
            const articleRe = new RegExp(`^(${ARTICLES.join('|')})\\s+`, 'i');
            n = n.replace(articleRe, '');
            // Remove quantity/measure phrases
            n = n.replace(QTY_PHRASES_RE, '');
            // Remove trailing descriptors
            n = n.replace(/\s+(items?|pieces?|units?)$/i, '');
            n = n.replace(/\s+/g, ' ').trim();
            if (!n) return '';
            // Singularize last token
            const tokens = n.split(' ');
            tokens[tokens.length - 1] = singularizeToken(tokens[tokens.length - 1]);
            return tokens.join(' ');
        },

        /**
         * Normalize box name: strip "box " prefix, map spoken letters, normalize numbers.
         * This is used for raw normalization (not matching against existing boxes).
         */
        normalizeBox(name) {
            if (!name) return null;
            return canonicalizeBoxName(name);
        },

        /**
         * Parse a quantity token to a number.
         */
        parseQty(token) {
            if (!token) return 1;
            token = token.trim().toLowerCase();
            if (token === 'some') return 1;
            if (/^\d+$/.test(token)) return parseInt(token);
            return QTY_WORDS[token] || 1;
        },

        /**
         * Singularize a single token.
         */
        singularize: singularizeToken,

        /**
         * Fuzzy match a spoken box name against existing box names.
         * Returns the matched box name or null.
         */
        resolveSpokenBoxName(spoken, existingBoxNames) {
            if (!spoken) return null;
            let extracted = spoken.trim().toLowerCase().replace(/[.!?,;:]+$/, '');
            // Strip conversational fillers
            extracted = extracted.replace(/^(also|and|then|just|put|in|into)\s+/gi, '');
            // Handle "X as in Romeo" → extract X
            const asInMatch = extracted.match(/^(\w)\s+as\s+in\s+/i);
            if (asInMatch) extracted = asInMatch[1];
            // Strip "box " prefix
            extracted = extracted.replace(/^box\s+/i, '');
            // Map spoken letters
            if (SPOKEN_LETTERS[extracted]) extracted = SPOKEN_LETTERS[extracted];
            const upper = extracted.toUpperCase();
            // Exact match
            if (existingBoxNames.map(b => b.toUpperCase()).includes(upper)) return upper;
            // Single letter match
            if (upper.length === 1) {
                const match = existingBoxNames.find(b => b.toUpperCase() === upper);
                if (match) return match.toUpperCase();
            }
            // Substring/startsWith
            const startMatch = existingBoxNames.find(b => b.toUpperCase().startsWith(upper));
            if (startMatch) return startMatch.toUpperCase();
            return null;
        }
    };
})();
