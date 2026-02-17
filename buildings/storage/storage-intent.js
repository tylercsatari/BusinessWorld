/**
 * Intent parsing with regex + OpenAI LLM fallback + multi-intent extraction.
 * Ported from StorageAI/src/nlu/parse_intent.py and multi_intent.py
 */
const StorageIntent = (() => {

    // --- GPT Helper (via server proxy) ---
    async function gptChat(messages, temperature = 0) {
        const res = await fetch('/api/openai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, temperature })
        });
        const data = await res.json();
        if (data.choices && data.choices[0]) return data.choices[0].message.content.trim();
        throw new Error('No GPT response');
    }

    // --- Regex Patterns (from parse_intent.py lines 110-236) ---
    const PATTERNS = [
        // MOVE: "move X [from box Y] to box Z"
        {
            intent: 'MOVE',
            regex: /(?:move|moving|put|place|relocate)\s+(.+?)\s+(?:from\s+(?:box\s+)?.+?\s+)?(?:to|into|in)\s+(?:box\s+)?(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({
                itemName: StorageCanonicalize.normalizeItem(m[1]),
                toBox: StorageCanonicalize.normalizeBox(m[2])
            })
        },
        // CLEAR_BOX: "clear/remove everything from box A"
        {
            intent: 'CLEAR_BOX',
            regex: /(?:remove|delete|clear)\s+(?:(?:all\s+)?(?:the\s+)?items?|everything|all)\s+(?:from|in|inside)\s+(?:box\s+)?(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({ boxName: StorageCanonicalize.normalizeBox(m[1]) })
        },
        {
            intent: 'CLEAR_BOX',
            regex: /(?:clear|empty)\s+(?:out\s+)?(?:box\s+)?(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({ boxName: StorageCanonicalize.normalizeBox(m[1]) })
        },
        // ADD_BOX: "add box named X" / "create box X" / "create box shoes one"
        {
            intent: 'ADD_BOX',
            regex: /(?:add|create|make)\s+(?:a\s+)?(?:new\s+)?box.*?(?:named|called)\s+(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({ boxName: StorageCanonicalize.normalizeBox(m[1]) })
        },
        {
            intent: 'ADD_BOX',
            regex: /(?:add|create|make)\s+(?:a\s+)?(?:new\s+)?box\s+(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({ boxName: StorageCanonicalize.normalizeBox(m[1]) })
        },
        {
            intent: 'ADD_BOX',
            regex: /(?:add|create|make)\s+(?:a\s+)?(?:new\s+)?box\b/i,
            extract: () => ({ boxName: null })
        },
        // REMOVE_BOX: "remove/delete box A" or "remove box shoes one"
        {
            intent: 'REMOVE_BOX',
            regex: /(?:remove|delete)\s+(?:the\s+)?box\s+(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({ boxName: StorageCanonicalize.normalizeBox(m[1]) })
        },
        // ADD item with box: "add 3 batteries to box A" or "add 2 pops to shoes one"
        {
            intent: 'ADD',
            regex: /(?:add(?:ing|ed)?|put|place)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|some)\s+)?(.+?)\s+(?:to|into|in)\s+(?:box\s+)?(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({
                quantity: StorageCanonicalize.parseQty(m[1]),
                itemName: StorageCanonicalize.normalizeItem(m[2]),
                boxName: StorageCanonicalize.normalizeBox(m[3])
            })
        },
        // ADD item without box: "add 3 batteries"
        {
            intent: 'ADD',
            regex: /(?:add(?:ing|ed)?|put|place)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|some)\s+)?(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({
                quantity: StorageCanonicalize.parseQty(m[1]),
                itemName: StorageCanonicalize.normalizeItem(m[2]),
                boxName: null
            })
        },
        // REMOVE all: "remove all batteries"
        {
            intent: 'REMOVE',
            regex: /(?:remove|take|grab)\s+all(?:\s+of\s+the)?\s+(.+)/i,
            extract: m => ({ itemName: StorageCanonicalize.normalizeItem(m[1]), quantity: 9999, removeAll: true })
        },
        // REMOVE: "remove 2 batteries"
        {
            intent: 'REMOVE',
            regex: /(?:remove(?:ing|ed)?|take|grab)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|some)\s+)?(.+?)(?:\s*[.?!]*)$/i,
            extract: m => ({
                quantity: StorageCanonicalize.parseQty(m[1]),
                itemName: StorageCanonicalize.normalizeItem(m[2]),
                removeAll: false
            })
        },
        // FIND: "where are the scissors?" / "find batteries" / "do i have tape?"
        {
            intent: 'FIND',
            regex: /(?:where\s+(?:are|is)|find|do\s+i\s+have|search\s+for|look\s+for|locate|what(?:'s|\s+is)\s+in)\s+(?:the\s+|my\s+)?(.+?)(?:\s*[?!.]*\s*)$/i,
            extract: m => ({ itemName: StorageCanonicalize.normalizeItem(m[1]) })
        }
    ];

    // --- LLM Fallback Intent Extraction ---
    async function llmExtractIntent(text) {
        const prompt = `You are an inventory management intent extractor. Given the user text, extract the structured intent.

Return ONLY valid JSON with these fields:
- intent: one of "ADD", "REMOVE", "FIND", "MOVE", "ADD_BOX", "REMOVE_BOX", "CLEAR_BOX", or null if no intent
- object_name: the item name (singular form, no articles) or null
- quantity: number or null
- box_name: box identifier or null
- to_box: destination box (for MOVE) or null
- remove_all: true if removing all of an item, else false

User text: "${text}"

JSON:`;

        try {
            const response = await gptChat([{ role: 'user', content: prompt }], 0);
            // Strip code fences if present
            let json = response.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
            const parsed = JSON.parse(json);
            if (!parsed.intent) return null;
            return {
                intent: parsed.intent.toUpperCase(),
                itemName: parsed.object_name ? StorageCanonicalize.normalizeItem(parsed.object_name) : null,
                quantity: parsed.quantity || 1,
                boxName: parsed.box_name ? StorageCanonicalize.normalizeBox(parsed.box_name) : null,
                toBox: parsed.to_box ? StorageCanonicalize.normalizeBox(parsed.to_box) : null,
                removeAll: parsed.remove_all || false
            };
        } catch (e) {
            console.warn('LLM intent extraction failed:', e.message);
            return null;
        }
    }

    // --- Multi-Intent Extraction ---
    async function extractMultipleIntents(text) {
        const prompt = `You are extracting inventory management operations from a single user statement.
The user may describe MULTIPLE operations in one sentence.

Supported intents: ADD, REMOVE, FIND, MOVE, ADD_BOX, REMOVE_BOX, CLEAR_BOX

Return a JSON array of operations. Each operation has:
- intent: string
- object_name: item name (singular, no articles) or null
- quantity: number or null (default 1 for add/remove)
- box_name: box name or null
- to_box: destination box for MOVE or ADD
- from_box: source box for MOVE
- remove_all: boolean
- everything: boolean (true if "everything" or "all items")

Important:
- "add X and Y to box A" = 2 separate ADD operations with same box
- "remove everything from box A" = CLEAR_BOX
- Singularize item names (batteries → battery, scissors stays scissors)

User text: "${text}"

JSON array:`;

        try {
            const response = await gptChat([{ role: 'user', content: prompt }], 0);
            let json = response.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
            const ops = JSON.parse(json);
            if (!Array.isArray(ops) || ops.length === 0) return null;

            return ops.map(op => ({
                intent: (op.intent || '').toUpperCase(),
                itemName: op.object_name ? StorageCanonicalize.normalizeItem(op.object_name) : null,
                quantity: op.quantity || 1,
                boxName: (op.box_name || op.to_box) ? StorageCanonicalize.normalizeBox(op.box_name || op.to_box) : null,
                toBox: op.to_box ? StorageCanonicalize.normalizeBox(op.to_box) : null,
                fromBox: op.from_box ? StorageCanonicalize.normalizeBox(op.from_box) : null,
                removeAll: op.remove_all || false,
                everything: op.everything || false
            }));
        } catch (e) {
            console.warn('Multi-intent extraction failed:', e.message);
            return null;
        }
    }

    return {
        /**
         * Parse a single intent from text using regex patterns.
         * Returns { intent, itemName, quantity, boxName, toBox, removeAll } or null.
         */
        parseRegex(text) {
            const input = text.trim();
            for (const p of PATTERNS) {
                const m = input.match(p.regex);
                if (m) {
                    return { intent: p.intent, ...p.extract(m) };
                }
            }
            return null;
        },

        /**
         * Parse intent with regex first, then LLM fallback.
         */
        async parse(text) {
            // Try regex first
            const regexResult = this.parseRegex(text);
            if (regexResult) return regexResult;
            // LLM fallback
            return llmExtractIntent(text);
        },

        /**
         * Extract multiple intents from compound statements.
         * Falls back to single intent parsing if multi-intent fails.
         */
        async parseMulti(text) {
            // Check for compound indicators
            const hasCompound = /\b(and|then|also|plus|,)\b/i.test(text);
            if (hasCompound) {
                const multi = await extractMultipleIntents(text);
                if (multi && multi.length > 0) return multi;
            }
            // Fall back to single intent
            const single = await this.parse(text);
            return single ? [single] : null;
        },

        // Expose for direct use
        gptChat
    };
})();
