/**
 * hook-engine.js — Kimi-driven hook reasoning over REAL transcripts.
 *
 * No arbitrary chopping, no heuristic scorer. The engine retrieves how the
 * channel's most TOPICALLY SIMILAR past videos ACTUALLY opened — the real first
 * words the creator spoke (the hook in context, from each video's transcript) —
 * and has Kimi study what the hook IS in each, then reason out hooks for the new
 * video. It can self-critique against those real examples before finalizing.
 *
 * Memory: hooks the user keeps ("wins") are fed back so the engine emulates the
 * style that actually gets picked.
 *
 * Pure module: the LLM call and the memory store are injected by the caller.
 */
const intel = require('./hook-intel');

function fmtOpenings(ex) {
    return ex.map((e, i) => `${i + 1}. "${e.title}" — ${(e.views || 0).toLocaleString()} views\n   HOW IT ACTUALLY OPENED: "${e.opening}"`).join('\n\n');
}

// opts: { title, context, script, existingHooks:[] }
// llm: async (messages) => parsed JSON object (caller wires Kimi → JSON extraction)
// memory: { principles:[], wins:[{line,visual}] }
async function run(opts, llm, memory) {
    const title = opts.title || '', context = opts.context || '', script = (opts.script || '').slice(0, 1800);
    const topic = `${title} ${context} ${script}`.trim();
    memory = memory || {};

    const examples = intel.examples(topic, 10);          // REAL openings, most similar first
    const pack = intel.build();                          // distilled findings (guidance, not structure)
    if (!examples.length) return { hooks: [], error: 'no corpus' };

    const findings = (pack && !pack.error) ? [
        `What keeps this channel's viewers (from our retention analysis): ${(pack.designRules || []).slice(0, 5).join(' ')}`,
        `Opening words that work: ${(pack.openingWords && pack.openingWords.bestFirst || []).join(', ')}. Avoid opening on: ${(pack.openingWords && pack.openingWords.worstFirst || []).join(', ')}.`,
        `Words that hold viewers: ${(pack.wordsThatRetain || []).slice(0, 12).join(', ')}. Words that lose them: ${(pack.wordsThatKill || []).slice(0, 12).join(', ')}.`
    ].join('\n') : '';

    const wins = (memory.wins && memory.wins.length)
        ? `\n\nHOOKS THE CREATOR KEPT BEFORE (emulate this taste):\n${memory.wins.slice(0, 8).map(w => `• "${w.line}"${w.visual ? `  [visual: ${w.visual}]` : ''}`).join('\n')}`
        : '';

    const sys = `You are the hook strategist for a maker/experiment YouTube channel. Below is how this channel's ${examples.length} most SIMILAR past videos ACTUALLY opened — the real first words the creator spoke. These are proven hooks (see the view counts).

Your job: STUDY these real openings. For each, notice what the hook actually IS — how the very first line grabs attention (a bold claim, a question, an open loop, a "but…"/"wait…" turn), and how it sets up the rest of the video. A hook is not a fixed length — it's whatever opening makes someone keep watching. Then write hooks for the NEW video, modeled on what genuinely works here.

A hook = the LINE (the spoken opening, in the channel's real voice) + the VISUAL (what's literally on screen in the first seconds — action/impact/reveal, never a talking head).

=== HOW OUR MOST SIMILAR VIDEOS REALLY OPENED ===
${fmtOpenings(examples)}
=== END REAL OPENINGS ===

${findings}${wins}`;

    const user = `NEW VIDEO
Title: ${title || '(untitled)'}
What actually happens: ${context || '(none)'}
Script so far: ${script || '(none)'}
Existing hooks (make these different): ${(opts.existingHooks || []).join(' | ') || 'none'}

Write 4 distinct hooks for this video, each modeled on a SPECIFIC real opening above. Output ONLY JSON:
{"hooks":[{"line":"the spoken opening, in our real voice","visual":"the opening shot","modeledOn":"the title of the real video whose opening this is modeled on","why":"one sentence: what makes this grip, tied to that real opening"}]}`;

    let drafts = [];
    try { const o = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }]); drafts = (o && o.hooks) || []; }
    catch (e) { return { hooks: [], error: 'llm failed: ' + e.message }; }
    drafts = drafts.filter(h => h && (h.line || h.text)).map(h => ({
        line: (h.line || h.text || '').trim(), visual: (h.visual || '').trim(),
        modeledOn: (h.modeledOn || '').trim(), why: (h.why || '').trim()
    }));
    if (!drafts.length) return { hooks: [], error: 'no drafts' };

    // SELF-CRITIQUE — Kimi judges its own drafts against the real openings and
    // rewrites any that are weaker than the proven examples. (The "ask itself
    // what's wrong" step — reasoning, not an arbitrary score.)
    try {
        const critMsg = [
            { role: 'system', content: sys },
            { role: 'user', content: `Here are 4 hook drafts for the new video:\n${drafts.map((h, i) => `${i + 1}. LINE: "${h.line}"  VISUAL: "${h.visual}"`).join('\n')}\n\nCompare each to the REAL openings above. For any that is more generic, vaguer, or weaker than how our real videos open, REWRITE it to match that proven quality (specific, bold, an open loop, a strong opening word, action visual). Keep the strong ones. Output ONLY JSON in the same 4-item order: {"hooks":[{"line":"...","visual":"...","modeledOn":"...","why":"..."}]}` }
        ];
        const o2 = await llm(critMsg);
        const improved = ((o2 && o2.hooks) || []).map(h => ({
            line: (h.line || '').trim(), visual: (h.visual || '').trim(),
            modeledOn: (h.modeledOn || '').trim(), why: (h.why || '').trim()
        })).filter(h => h.line);
        if (improved.length >= drafts.length) drafts = improved;
    } catch (e) { /* keep originals */ }

    // attach the real exemplar each was modeled on (for display)
    const byTitle = {}; examples.forEach(e => { byTitle[(e.title || '').toLowerCase()] = e; });
    const hooks = drafts.slice(0, 4).map(h => {
        const m = byTitle[(h.modeledOn || '').toLowerCase()];
        return { line: h.line, visual: h.visual, why: h.why, modeledOn: m ? { title: m.title, views: m.views } : (h.modeledOn ? { title: h.modeledOn } : null) };
    });
    return { hooks, nExamples: examples.length, nVideos: intel.examples('', 9999).length };
}

module.exports = { run };
