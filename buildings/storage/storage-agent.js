/**
 * Storage Agent — conversational, tool-calling inventory assistant.
 *
 * Replaces the old rigid regex/enum NLU (storage-intent.js). Instead of
 * classifying a single intent, this runs an LLM tool-calling loop (jarv1s-style):
 * the model reads the current inventory + the user's (possibly long, multi-step)
 * request, then calls inventory tools as many times as needed — adding/removing/
 * moving any number of items across any number of boxes in one turn.
 *
 * Behavior (per design):
 *   - Act, then validate: perform changes, then state the resulting state.
 *   - Ask only when confused or when a remove/move target's best semantic match
 *     is below CONFIG.search.semanticMatchThreshold (uses returned suggestions).
 *   - Auto-create boxes / best-guess when confident.
 *
 * Tools map 1:1 onto existing StorageService methods (Airtable + Pinecone).
 */
const StorageAgent = (() => {
    const MODEL = 'gpt-4o';
    const MAX_ITERATIONS = 10;

    // ── Tool schemas (OpenAI function-calling format) ──
    const TOOLS = [
        {
            type: 'function',
            function: {
                name: 'search_inventory',
                description: 'Semantic search for items already in storage. Use this to locate items, check what exists, verify a change, or resolve which item the user means. Returns matching items with their box, quantity, and similarity score.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'What to look for (natural language item name).' }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'add_item',
                description: 'Add a quantity of an item to a box. Similar existing items are automatically merged (quantity incremented) when the semantic match is strong; set force=true to create a separate entry instead. The box is created automatically if it does not exist.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Item name.' },
                        quantity: { type: 'number', description: 'How many to add (default 1).' },
                        box: { type: 'string', description: 'Destination box label (e.g. "A", "CAMERA GEAR").' },
                        force: { type: 'boolean', description: 'If true, create a new separate entry even if a similar item exists.' }
                    },
                    required: ['name', 'box']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'remove_item',
                description: 'Remove a quantity of an item (or all of it). Finds the item semantically. If no item matches confidently, returns needsClarification with suggestions — in that case ASK the user which they meant instead of guessing.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Item name to remove.' },
                        quantity: { type: 'number', description: 'How many to remove (default 1). Ignored if all=true.' },
                        all: { type: 'boolean', description: 'Remove the entire item entry.' }
                    },
                    required: ['name']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'move_item',
                description: 'Move an item to a different box. Finds the item semantically; returns needsClarification with suggestions if uncertain (ASK rather than guess). The destination box must exist — create it first if needed.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Item to move.' },
                        toBox: { type: 'string', description: 'Destination box label.' }
                    },
                    required: ['name', 'toBox']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_box',
                description: 'Create a new empty box with the given label.',
                parameters: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Box label.' } },
                    required: ['name']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'remove_box',
                description: 'Delete a box. Fails if the box still has items (clear it first).',
                parameters: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Box label to delete.' } },
                    required: ['name']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'clear_box',
                description: 'Remove every item from a box (the box itself remains).',
                parameters: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Box label to empty.' } },
                    required: ['name']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'move_all_items',
                description: 'Move every item from one box into another box.',
                parameters: {
                    type: 'object',
                    properties: {
                        fromBox: { type: 'string', description: 'Source box label.' },
                        toBox: { type: 'string', description: 'Destination box label.' }
                    },
                    required: ['fromBox', 'toBox']
                }
            }
        }
    ];

    // ── Build a compact snapshot of current inventory for the system prompt ──
    function inventorySnapshot() {
        const boxes = StorageService.getBoxes();
        if (!boxes.length) return '(The storage room is empty — no boxes yet.)';
        return boxes.map(b => {
            const items = StorageService.getItemsByBox(b.id);
            const list = items.length
                ? items.map(i => `${i.name} x${i.quantity}`).join(', ')
                : '(empty)';
            return `Box ${b.name}: ${list}`;
        }).join('\n');
    }

    function systemPrompt() {
        return `You are JARVIS, the assistant for a physical storage room. You manage real items kept in labeled boxes.

CONSTRAINTS OF THE STORAGE ROOM:
- Every item has a quantity and lives in exactly one box.
- Box labels are short uppercase tags (e.g. "A", "B", "CAMERA GEAR"). They are created on demand.
- Items with near-identical meaning are automatically merged (quantities combined) when added; only force a separate entry if the user clearly means a distinct thing.
- Semantic search backs item lookup; a confident match needs similarity >= ${CONFIG.search.semanticMatchThreshold}.

HOW TO BEHAVE:
- The user may give a long, natural command describing MANY operations at once. Carry out ALL of them by calling tools — one tool call per operation, as many as needed.
- ACT, then VALIDATE: make the changes, then in your final reply briefly state what is now true (e.g. "Box A now has 5 batteries and 2 tapes"). Use search_inventory if you need to confirm a result.
- ASK ONLY WHEN GENUINELY UNSURE: if a remove/move tool returns needsClarification (no confident semantic match), ask the user which item they meant using the suggestions — do NOT guess. If a request is contradictory or impossible given the constraints, ask.
- When confident, just do it. Create boxes automatically when the user names a new one.
- Keep replies SHORT and conversational — they are spoken aloud. No markdown, no bullet lists, no headers. One or two sentences.

CURRENT INVENTORY:
${inventorySnapshot()}`;
    }

    // ── Tool executors → existing StorageService methods ──
    // Each returns { result, modified, undo } where result is sent back to the model.
    async function execTool(name, args) {
        switch (name) {
            case 'search_inventory': {
                const r = await StorageService.findItem(args.query || '');
                if (r.results && r.results.length) {
                    return { result: { found: r.results.map(m => ({ name: m.name, quantity: m.quantity, box: m.box, score: +m.score.toFixed(2) })) } };
                }
                return { result: { found: [], suggestions: (r.suggestions || []).map(s => ({ name: s.name, box: s.boxName, score: +(+s.score).toFixed(2) })) } };
            }
            case 'add_item': {
                const qty = args.quantity || 1;
                const r = args.force
                    ? await StorageService.addItemForce(args.name, qty, args.box)
                    : await StorageService.addItem(args.name, qty, args.box);
                return {
                    result: {
                        ok: true,
                        added: qty,
                        item: r.item.name,
                        box: r.boxName,
                        merged: !!r.merged,
                        mergedWith: r.mergedWith || null,
                        newQuantity: r.item.quantity
                    },
                    modified: true,
                    undo: async () => { await StorageService.removeItem(r.item.name, qty); }
                };
            }
            case 'remove_item': {
                const qty = args.all ? 9999 : (args.quantity || 1);
                const r = await StorageService.removeItem(args.name, qty);
                if (r.error) {
                    return { result: { needsClarification: true, message: r.error, suggestions: (r.suggestions || []).map(s => ({ name: s.name, box: s.boxName, score: +(+s.score).toFixed(2) })) } };
                }
                const snap = { name: r.item.name, box: r.boxName };
                return {
                    result: { ok: true, item: r.item.name, box: r.boxName, removedAll: !!r.deleted, remaining: r.deleted ? 0 : r.item.quantity },
                    modified: true,
                    undo: async () => { await StorageService.addItemForce(snap.name, qty >= 9999 ? 1 : qty, snap.box); }
                };
            }
            case 'move_item': {
                // Capture the item's current box BEFORE moving, for a correct undo.
                let sourceBox = null;
                try {
                    const f = await StorageService.findItem(args.name);
                    if (f.results && f.results[0]) sourceBox = f.results[0].box;
                } catch (e) {}
                const r = await StorageService.moveItem(args.name, args.toBox);
                if (r.error) {
                    return { result: { needsClarification: !!r.suggestions, message: r.error, suggestions: (r.suggestions || []).map(s => ({ name: s.name, box: s.boxName, score: +(+s.score).toFixed(2) })) } };
                }
                return {
                    result: { ok: true, item: r.item.name, toBox: r.toBox },
                    modified: true,
                    undo: sourceBox ? async () => { await StorageService.moveItem(r.item.name, sourceBox); } : undefined
                };
            }

            case 'create_box': {
                const r = await StorageService.addBox(args.name);
                if (r.error) return { result: { ok: false, message: r.error } };
                return { result: { ok: true, box: r.box.name }, modified: true, undo: async () => { await StorageService.removeBox(r.box.name); } };
            }
            case 'remove_box': {
                const r = await StorageService.removeBox(args.name);
                if (r.error) return { result: { ok: false, message: r.error } };
                return { result: { ok: true, removedBox: r.box.name }, modified: true };
            }
            case 'clear_box': {
                const boxName = (args.name || '').toUpperCase();
                const box = StorageService.findBoxByName(boxName);
                const snapshot = box ? StorageService.getItemsByBox(box.id).map(i => ({ name: i.name, qty: i.quantity, box: box.name })) : [];
                const r = await StorageService.clearBox(args.name);
                if (r.error) return { result: { ok: false, message: r.error } };
                return {
                    result: { ok: true, box: r.box.name, cleared: r.count },
                    modified: true,
                    undo: async () => { for (const it of snapshot) await StorageService.addItemForce(it.name, it.qty, it.box); }
                };
            }
            case 'move_all_items': {
                const r = await StorageService.moveAllItems(args.fromBox, args.toBox);
                if (r.error) return { result: { ok: false, message: r.error } };
                return { result: { ok: true, moved: r.count, fromBox: r.fromBox, toBox: r.toBox }, modified: true };
            }
            default:
                return { result: { ok: false, message: `Unknown tool: ${name}` } };
        }
    }

    async function chat(messages) {
        const res = await fetch('/api/openai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, temperature: 0.2 })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Agent chat failed: ${res.status} ${err.slice(0, 200)}`);
        }
        const data = await res.json();
        if (!data.choices || !data.choices[0]) throw new Error('No response from model.');
        return data.choices[0].message;
    }

    return {
        /**
         * Run one user turn through the tool-calling loop.
         * ctx = { addChatMsg, speak, onStateChange, pushUndo, history }
         *   - history: persistent array of chat messages (role/content) across turns
         * Returns the final assistant text.
         */
        async run(userText, ctx) {
            const history = ctx.history || [];

            // Rebuild messages: fresh system prompt (live inventory snapshot) + prior turns + new user text
            const priorTurns = history.filter(m => m.role === 'user' || m.role === 'assistant');
            const messages = [
                { role: 'system', content: systemPrompt() },
                ...priorTurns.slice(-12),
                { role: 'user', content: userText }
            ];
            history.push({ role: 'user', content: userText });

            let anyModified = false;

            for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
                let msg;
                try {
                    msg = await chat(messages);
                } catch (e) {
                    if (ctx.addChatMsg) ctx.addChatMsg(`Error: ${e.message}`, 'error');
                    return null;
                }

                // No tool calls → final answer
                if (!msg.tool_calls || msg.tool_calls.length === 0) {
                    const text = (msg.content || '').trim();
                    messages.push({ role: 'assistant', content: text });
                    if (text) {
                        history.push({ role: 'assistant', content: text });
                        if (ctx.addChatMsg) ctx.addChatMsg(text, 'ai');
                        if (ctx.speak) await ctx.speak(text);
                    }
                    if (anyModified && ctx.onStateChange) ctx.onStateChange();
                    return text;
                }

                // Execute each tool call, append results
                messages.push({
                    role: 'assistant',
                    content: msg.content || '',
                    tool_calls: msg.tool_calls
                });

                for (const tc of msg.tool_calls) {
                    let args = {};
                    try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
                    let exec;
                    try {
                        exec = await execTool(tc.function.name, args);
                    } catch (e) {
                        exec = { result: { ok: false, error: e.message } };
                    }
                    if (exec.modified) {
                        anyModified = true;
                        if (ctx.onStateChange) ctx.onStateChange();
                        if (exec.undo && ctx.pushUndo) {
                            ctx.pushUndo(`${tc.function.name} ${args.name || args.box || args.fromBox || ''}`.trim(), exec.undo);
                        }
                    }
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: JSON.stringify(exec.result)
                    });
                }
            }

            // Hit iteration cap
            const capMsg = "I've done as much as I could in one go — tell me if there's more.";
            if (ctx.addChatMsg) ctx.addChatMsg(capMsg, 'ai');
            if (ctx.speak) await ctx.speak(capMsg);
            if (anyModified && ctx.onStateChange) ctx.onStateChange();
            return capMsg;
        }
    };
})();
