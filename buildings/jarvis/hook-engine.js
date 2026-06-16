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
const visuals = require('./hook-visuals');

// The principles that explain WHY a hook keeps viewers past the swipe point —
// each grounded in this channel's own retention experiments (the numbers come
// from findings-summary.json / retention-patterns.json). The model reasons WITH
// these, not by copying high-view videos.
const HOOK_PRINCIPLES = [
    { name: 'Zeigarnik / open loop', what: 'leave something UNRESOLVED the brain needs to close — "but can it…?", "wait…", "you\'ll see why". An open question is the single thing that stops the swipe.', evidence: 'forward-momentum words (so/but/wait/actually) track with higher retention.' },
    { name: 'Deferred gratification (payoff gap)', what: 'promise the payoff will EXCEED the hook; never give away the best part up front — make them stay for it.', evidence: 'HOOK_PAYOFF_GAP is the #1 retention predictor (r=-0.52): videos whose ending beats the hook get ~9× the views.' },
    { name: 'Novelty', what: 'something they have literally never seen — a first, an impossible-sounding combination, a rule being broken.', evidence: 'novelty is a top LLM-scored retention signal; "world\'s first / never been done" openings over-perform.' },
    { name: 'Broad interest', what: 'a stake or curiosity that reaches BEYOND your subscribers — universal, not niche or inside-baseball.', evidence: 'non-subscriber reach is the strongest predictor of total views (r=-0.87 with subscriber fraction).' },
    { name: 'Motivation / stakes', what: 'visceral and high-consequence — pain, danger, money, survival, a number that raises what\'s at risk.', evidence: 'visceral/physical words retain (painful, hurt); high-energy action frames are 28% at retention peaks vs 8% at drops.' },
    { name: 'Credibility', what: 'concrete specifics — a real number, a named object, a verifiable claim — so the bold promise is believable, not hype.', evidence: 'specificity out-grips vague claims; technical/material words KILL retention (plastic -0.17, fiber -0.14) — show the result, never name the material.' }
];

function fmtPrinciples() {
    return HOOK_PRINCIPLES.map(p => `• ${p.name}: ${p.what}\n    (evidence: ${p.evidence})`).join('\n');
}
function fmtOpenings(ex) {
    return ex.map((e, i) => {
        const sw = (typeof e.swipe === 'number') ? `${e.swipe}% swiped away` : `${(e.views || 0).toLocaleString()} views`;
        return `${i + 1}. "${e.title}" — kept ${typeof e.swipe === 'number' ? (100 - e.swipe).toFixed(1) + '% past the hook' : (e.views || 0).toLocaleString() + ' views'} (${sw})\n   ACTUAL OPENING: "${e.opening}"`;
    }).join('\n\n');
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

    const sys = `You are the hook strategist for a maker/experiment YouTube channel. The ONLY metric that matters is the SWIPE RATIO: the % of viewers who keep watching past the first 3–5 seconds instead of swiping away. Everything you write is to minimize swipe-away.

Do NOT just copy what high-view videos did. Reason about WHY a hook works using these principles (each is backed by this channel's own retention experiments), then DELIBERATELY build new hooks by applying the ones that fit this video:

=== HOOK PRINCIPLES (reason with these) ===
${fmtPrinciples()}
=== END PRINCIPLES ===

Below are this channel's best-RETAINED similar openings — sorted by lowest swipe-away (the real metric), with their actual first ~15s. Use them as EVIDENCE of the principles in action, not templates to copy. Diagnose which principles each one uses to stop the swipe.

=== BEST-RETAINED SIMILAR OPENINGS (lowest swipe-away first) ===
${fmtOpenings(examples)}
=== END OPENINGS ===

What a hook IS: the LINE is ONLY the GRAB — the first 1–2 sentences (8–25 words), the opener that stops the swipe, NOT a summary of the video. e.g. "This is an indestructible chest plate. But can it save my life?" — that's the whole hook; the rest is the video.

A hook = LINE + VISUAL, and THE VISUAL IS HALF THE HOOK. The opening shot must be designed from the visual mechanics below and must embody the SAME principle as the line (an open loop → a frozen about-to-happen moment; novelty → a wrong-material / impossible object; stakes → visible danger on a human).

${visuals.block()}

${findings}${wins}`;

    const user = `NEW VIDEO
Title: ${title || '(untitled)'}
What actually happens: ${context || '(none)'}
Script so far: ${script || '(none)'}
Existing hooks (make these different): ${(opts.existingHooks || []).join(' | ') || 'none'}

Write 4 hooks that are WILDLY DIFFERENT from each other — each must take a fundamentally different ANGLE (different principle mix), a different LINE structure (e.g. one bold claim, one question, one challenge/command, one impossible-reveal), AND a different VISUAL MECHANISM from the components list. No two hooks may share the same core idea or the same shot. Generic restatements of the same idea are failures.

For EACH hook:
- LINE: short (1–2 sentences, 8–25 words), built deliberately from 1–3 named principles to minimize swipe-away.
- VISUAL: a concrete opening shot built from the visual mechanics — ONE contradiction, a human hand/body for scale, frozen at the instant before impact/launch/reveal, clean high-contrast background, NO text. Make the apparatus novel. The visual must carry the same principle as the line.

Output ONLY JSON:
{"hooks":[{"line":"the short grab","visual":"the concrete opening shot (contradiction + human + frozen moment, no text)","principles":["principle names applied to BOTH line and visual"],"why":"one sentence: the causal reason this minimizes swipe-away","modeledOn":"title of the best-retained opening it relates to, or '' if newly constructed"}]}`;

    // ONE deep reasoning pass — Kimi K2.6 internally reasons (chain-of-thought)
    // over the real openings before answering, so a second round-trip just
    // doubles latency. The prompt makes it self-check before finalizing.
    let drafts = [];
    try { const o = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }]); drafts = (o && o.hooks) || []; }
    catch (e) { return { hooks: [], error: 'llm failed: ' + e.message }; }
    drafts = drafts.filter(h => h && (h.line || h.text)).map(h => ({
        line: (h.line || h.text || '').trim(), visual: (h.visual || '').trim(),
        principles: Array.isArray(h.principles) ? h.principles.map(p => String(p).trim()).filter(Boolean).slice(0, 4) : [],
        modeledOn: (h.modeledOn || '').trim(), why: (h.why || '').trim()
    }));
    if (!drafts.length) return { hooks: [], error: 'no drafts' };

    // attach the real exemplar each relates to (for display)
    const byTitle = {}; examples.forEach(e => { byTitle[(e.title || '').toLowerCase()] = e; });
    const hooks = drafts.slice(0, 4).map(h => {
        const m = byTitle[(h.modeledOn || '').toLowerCase()];
        return {
            line: h.line, visual: h.visual, why: h.why, principles: h.principles,
            modeledOn: m ? { title: m.title, views: m.views, swipe: m.swipe } : (h.modeledOn ? { title: h.modeledOn } : null)
        };
    });
    return { hooks, nExamples: examples.length, nVideos: intel.examples('', 9999).length, principles: HOOK_PRINCIPLES.map(p => p.name) };
}

module.exports = { run };
