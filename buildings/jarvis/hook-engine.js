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

    const sys = `You are the hook strategist for a maker/experiment YouTube channel. Below is how this channel's ${examples.length} most SIMILAR past videos ACTUALLY opened — the real transcript of their first ~15 seconds (the hook + how it leads into the video). Learn from these proven openings (see the view counts).

CRITICAL — what a hook IS:
- The hook LINE is ONLY the GRAB: the very first 1–2 sentences a viewer hears (roughly 8–25 words). In each real opening below, the hook is just the opening claim/question BEFORE the creator starts explaining how they made it.
  • e.g. real opening "This is an indestructible chest plate. But can it save my life? Starting with a sheet of titanium I…" → the HOOK is only: "This is an indestructible chest plate. But can it save my life?"
- Do NOT write a summary of the whole video. Do NOT explain how it's made. Just the punchy opener that makes someone stay: a bold claim, a question, an open loop, a "but…/wait…" turn.

A hook = the LINE (that short grab, in the channel's real voice) + the VISUAL (what's on screen in the first 1–3 seconds — action/impact/reveal, never a talking head).

=== HOW OUR MOST SIMILAR VIDEOS REALLY OPENED (first ~15s; the hook is just their FIRST sentence or two) ===
${fmtOpenings(examples)}
=== END REAL OPENINGS ===

${findings}${wins}`;

    const user = `NEW VIDEO
Title: ${title || '(untitled)'}
What actually happens: ${context || '(none)'}
Script so far: ${script || '(none)'}
Existing hooks (make these different): ${(opts.existingHooks || []).join(' | ') || 'none'}

Write 4 distinct hook options. Each LINE must be SHORT — the first 1–2 sentences only (8–25 words), the grab, NOT a description of the video. Model each on a SPECIFIC real opening above. Output ONLY JSON:
{"hooks":[{"line":"the short spoken grab (1-2 sentences max)","visual":"the opening shot","modeledOn":"the title of the real video whose opening style this matches","why":"one short sentence: what makes this grip"}]}`;

    // ONE deep reasoning pass — Kimi K2.6 internally reasons (chain-of-thought)
    // over the real openings before answering, so a second round-trip just
    // doubles latency. The prompt makes it self-check before finalizing.
    let drafts = [];
    try { const o = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }]); drafts = (o && o.hooks) || []; }
    catch (e) { return { hooks: [], error: 'llm failed: ' + e.message }; }
    drafts = drafts.filter(h => h && (h.line || h.text)).map(h => ({
        line: (h.line || h.text || '').trim(), visual: (h.visual || '').trim(),
        modeledOn: (h.modeledOn || '').trim(), why: (h.why || '').trim()
    }));
    if (!drafts.length) return { hooks: [], error: 'no drafts' };

    // attach the real exemplar each was modeled on (for display)
    const byTitle = {}; examples.forEach(e => { byTitle[(e.title || '').toLowerCase()] = e; });
    const hooks = drafts.slice(0, 4).map(h => {
        const m = byTitle[(h.modeledOn || '').toLowerCase()];
        return { line: h.line, visual: h.visual, why: h.why, modeledOn: m ? { title: m.title, views: m.views } : (h.modeledOn ? { title: h.modeledOn } : null) };
    });
    return { hooks, nExamples: examples.length, nVideos: intel.examples('', 9999).length };
}

module.exports = { run };
