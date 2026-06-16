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
const fs = require('fs');
const path = require('path');

// Data-derived knowledge (from _analyze_tone.js over every posted video).
let _tone = null, _vd = null, _kbAt = 0;
function loadKb() {
    if (_kbAt && Date.now() - _kbAt < 10 * 60 * 1000) return;
    try { _tone = JSON.parse(fs.readFileSync(path.join(__dirname, 'hook-tone-principles.json'), 'utf8')); } catch (e) { _tone = null; }
    try { _vd = JSON.parse(fs.readFileSync(path.join(__dirname, 'visual-dialogue-insights.json'), 'utf8')); } catch (e) { _vd = null; }
    _kbAt = Date.now();
}
// The top tone/writing rules, derived by contrasting best- vs worst-retained
// videos. These are the channel's actual voice — they take precedence over
// generic advice. (hook/both rules first, capped to keep context bounded.)
function toneBlock() {
    loadKb();
    const ps = (_tone && _tone.principles) || [];
    if (!ps.length) return '';
    const pick = ps.filter(p => p.applies !== 'script').slice(0, 22);
    return `=== THIS CHANNEL'S TONE / WRITING RULES (ranked, derived from every posted video's retention — write in THIS voice) ===\n${pick.map(p => `${p.rank}. ${p.name}: ${p.how}`).join('\n')}\n=== END TONE RULES ===`;
}
function vdBlock() {
    loadKb();
    const ins = (_vd && _vd.insights) || [];
    if (!ins.length) return '';
    return `=== HOW LINE + VISUAL PAIR at high-retention moments (do this) ===\n${ins.map(i => `• ${i.name}: ${i.rule}`).join('\n')}\n=== END LINE+VISUAL PAIRING ===`;
}

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

function loadJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8')); } catch (e) { return null; } }
const _tok = s => (String(s || '').toLowerCase().match(/[a-z0-9']+/g) || []);

// SEARCH business world for the working mechanisms relevant to THIS video: the
// causal experiment chains (bridge_top_principles), the data-derived tone rules,
// and the visual components — ranked by relevance to the topic + draft hooks.
function searchMechanisms(topic, drafts) {
    loadKb();
    const bridge = loadJson('bridge_top_principles.json');
    const qset = new Set([..._tok(topic), ...((drafts || []).flatMap(d => _tok((d.line || '') + ' ' + (d.visual || ''))))]);
    const pool = [];
    ((bridge && bridge.top) || []).slice(0, 25).forEach(p => { if (p && p.via_indicator) pool.push({ kind: 'experiment', text: `${p.via_indicator} → ${p.to_outcome}`, strength: typeof p.chain_strength === 'number' ? +p.chain_strength.toFixed(2) : null }); });
    ((_tone && _tone.principles) || []).forEach(p => pool.push({ kind: 'tone-rule', text: `${p.name}: ${p.how}` }));
    visuals.VISUAL_COMPONENTS.forEach(c => pool.push({ kind: 'visual-mechanism', text: c }));
    ((_vd && _vd.insights) || []).forEach(i => pool.push({ kind: 'line+visual', text: `${i.name}: ${i.rule}` }));
    const scored = pool.map(m => { let o = 0; for (const w of _tok(m.text)) if (qset.has(w)) o++; return { ...m, score: o + (m.kind === 'experiment' && m.strength ? Math.abs(m.strength) : 0) }; });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter(m => m.score > 0).slice(0, 8);
    return top.length ? top : scored.slice(0, 6);
}

// opts: { title, context, script, existingHooks:[] }
// llm: async (messages) => parsed JSON object (caller wires Kimi → JSON extraction)
// memory: { principles:[], wins:[{line,visual}] }
// emit: (event) => void  — trace events for the live visualizer (optional)
async function run(opts, llm, memory, emit) {
    emit = typeof emit === 'function' ? emit : () => {};
    const title = opts.title || '', context = opts.context || '', script = (opts.script || '').slice(0, 1800);
    const topic = `${title} ${context} ${script}`.trim();
    memory = memory || {};

    emit({ stage: 'search', status: 'run', title: 'Searching your past videos', detail: `Scanning ${intel.corpusSize()} real openings for the most similar + best-retained…` });
    const examples = intel.examples(topic, 10);          // REAL openings, swipe-ranked
    const pack = intel.build();
    if (!examples.length) { emit({ stage: 'search', status: 'error', title: 'No corpus' }); return { hooks: [], error: 'no corpus' }; }
    emit({ stage: 'search', status: 'done', title: `Found ${examples.length} similar best-retained openings`, items: examples.map(e => ({ label: e.title, meta: typeof e.swipe === 'number' ? `${(100 - e.swipe).toFixed(1)}% kept` : `${(e.views || 0).toLocaleString()} views` })) });

    const findings = (pack && !pack.error) ? [
        `What keeps this channel's viewers (from our retention analysis): ${(pack.designRules || []).slice(0, 5).join(' ')}`,
        `Opening words that work: ${(pack.openingWords && pack.openingWords.bestFirst || []).join(', ')}. Avoid opening on: ${(pack.openingWords && pack.openingWords.worstFirst || []).join(', ')}.`,
        `Words that hold viewers: ${(pack.wordsThatRetain || []).slice(0, 12).join(', ')}. Words that lose them: ${(pack.wordsThatKill || []).slice(0, 12).join(', ')}.`
    ].join('\n') : '';

    const wins = (memory.wins && memory.wins.length)
        ? `\n\nHOOKS THE CREATOR KEPT BEFORE (emulate this taste):\n${memory.wins.slice(0, 8).map(w => `• "${w.line}"${w.visual ? `  [visual: ${w.visual}]` : ''}`).join('\n')}`
        : '';

    loadKb();
    const nTone = ((_tone && _tone.principles) || []).length, nVd = ((_vd && _vd.insights) || []).length;
    emit({ stage: 'voice', status: 'done', title: `Loaded the channel's viral voice`, detail: `${nTone} tone rules + ${nVd} line+visual rules + ${HOOK_PRINCIPLES.length} swipe principles`, items: ((_tone && _tone.principles) || []).slice(0, 6).map(p => ({ label: p.name })) });

    // SEARCH business world for working mechanisms relevant to this video
    emit({ stage: 'mechanisms', status: 'run', title: 'Searching Jarvis experiments for working mechanisms' });
    const mechanisms = searchMechanisms(topic);
    emit({ stage: 'mechanisms', status: 'done', title: `${mechanisms.length} working mechanisms found`, items: mechanisms.map(m => ({ label: m.text.slice(0, 110), meta: m.kind + (m.strength != null ? ` r=${m.strength}` : '') })) });

    const sys = `You are the hook strategist for a maker/experiment YouTube channel. The ONLY metric that matters is the SWIPE RATIO: the % of viewers who keep watching past the first 3–5 seconds instead of swiping away. Everything you write is to minimize swipe-away.

Do NOT just copy what high-view videos did. Reason about WHY a hook works using these principles (each is backed by this channel's own retention experiments), then DELIBERATELY build new hooks by applying the ones that fit this video:

=== HOOK PRINCIPLES (reason with these) ===
${fmtPrinciples()}
=== END PRINCIPLES ===

Below are this channel's best-RETAINED similar openings — sorted by lowest swipe-away (the real metric), with their actual first ~15s. Use them as EVIDENCE of the principles in action, not templates to copy. Diagnose which principles each one uses to stop the swipe.

=== BEST-RETAINED SIMILAR OPENINGS (lowest swipe-away first) ===
${fmtOpenings(examples)}
=== END OPENINGS ===

What a hook IS: the LINE is ONLY the GRAB — the first 1–2 sentences (8–25 words), the opener that stops the swipe, NOT a summary of the video. The rules below are derived from THIS channel's own retention data and define its actual viral voice — follow them over any generic instinct.

${toneBlock()}

A hook = LINE + VISUAL, and THE VISUAL IS HALF THE HOOK. The opening shot must be designed from the visual mechanics below and must embody the SAME principle as the line.

${visuals.block()}

${vdBlock()}

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

    // DRAFT — Kimi reasons over everything and writes 4 wildly-different hooks.
    emit({ stage: 'draft', status: 'run', title: 'Reasoning + drafting 4 wildly-different hooks', detail: 'Applying the voice, principles, visual mechanics & mechanisms…' });
    let drafts = [];
    try { const o = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }]); drafts = (o && o.hooks) || []; }
    catch (e) { emit({ stage: 'draft', status: 'error', title: 'LLM failed' }); return { hooks: [], error: 'llm failed: ' + e.message }; }
    drafts = drafts.filter(h => h && (h.line || h.text)).map(h => ({
        line: (h.line || h.text || '').trim(), visual: (h.visual || '').trim(),
        principles: Array.isArray(h.principles) ? h.principles.map(p => String(p).trim()).filter(Boolean).slice(0, 4) : [],
        modeledOn: (h.modeledOn || '').trim(), why: (h.why || '').trim()
    })).slice(0, 4);
    if (!drafts.length) { emit({ stage: 'draft', status: 'error', title: 'No drafts' }); return { hooks: [], error: 'no drafts' }; }
    emit({ stage: 'draft', status: 'done', title: 'Drafted 4 hooks', items: drafts.map(d => ({ label: d.line })) });

    // VALIDATE — check each draft against the working mechanisms + tone rules.
    emit({ stage: 'validate', status: 'run', title: 'Validating each hook against the mechanisms' });
    let validations = [];
    try {
        const vSys = `You critically validate draft hooks against this channel's WORKING MECHANISMS and its retention tone rules. Be a skeptic — a hook only "passes" if a specific mechanism supports it.`;
        const vUser = `WORKING MECHANISMS:\n${mechanisms.map(m => `• [${m.kind}] ${m.text}`).join('\n')}\n\n${toneBlock()}\n\nDRAFT HOOKS:\n${drafts.map((d, i) => `${i + 1}. LINE: "${d.line}"  VISUAL: "${d.visual}"`).join('\n')}\n\nFor EACH hook (same order), name the single strongest mechanism/tone-rule that SUPPORTS it, rate its swipe-stopping strength 1-10, and give one concrete concern if any. Output ONLY JSON: {"validations":[{"supportedBy":"the mechanism/rule name","strength":8,"concern":"... or ''"}]}`;
        const vo = await llm([{ role: 'system', content: vSys }, { role: 'user', content: vUser }]);
        validations = (vo && Array.isArray(vo.validations)) ? vo.validations : [];
    } catch (e) { /* validation is best-effort */ }
    emit({ stage: 'validate', status: 'done', title: 'Validated', items: drafts.map((d, i) => ({ label: d.line, meta: validations[i] ? `${validations[i].strength || '?'}/10 · ${validations[i].supportedBy || ''}` : 'checked' })) });

    // FINALIZE
    const byTitle = {}; examples.forEach(e => { byTitle[(e.title || '').toLowerCase()] = e; });
    const hooks = drafts.map((h, i) => {
        const m = byTitle[(h.modeledOn || '').toLowerCase()];
        const v = validations[i] || {};
        return {
            line: h.line, visual: h.visual, why: h.why, principles: h.principles,
            validation: (v.strength || v.supportedBy) ? { strength: v.strength || null, supportedBy: v.supportedBy || '', concern: v.concern || '' } : null,
            modeledOn: m ? { title: m.title, views: m.views, swipe: m.swipe } : (h.modeledOn ? { title: h.modeledOn } : null)
        };
    });
    emit({ stage: 'final', status: 'done', title: 'Done', hooks });
    return { hooks, nExamples: examples.length, nVideos: intel.corpusSize(), mechanisms, principles: HOOK_PRINCIPLES.map(p => p.name) };
}

module.exports = { run, searchMechanisms };
