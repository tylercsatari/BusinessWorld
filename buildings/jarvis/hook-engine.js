/**
 * hook-engine.js — a reasoning engine for video hooks, modeled on the
 * JarvisMark agent architecture (perceive → decide → act → verify, with memory).
 *
 * It does NOT just prompt an LLM. It runs a loop the model can't fake its way
 * through, because every draft is graded by a DETERMINISTIC scorer built from the
 * channel's real retention data:
 *
 *   PERCEIVE  pull the video's topic + retrieve the most similar REAL past hooks
 *             (actual line + visual + views) + distilled findings + learned memory.
 *   DECIDE    the LLM drafts candidate hooks, grounded in those real examples.
 *   VERIFY    score(line, visual) grades each draft against the data (word-level
 *             retention impact, opening-word quality, specificity, curiosity gap,
 *             visual energy, material-word penalty) → a real swipe-through estimate
 *             + concrete critique.
 *   REFINE    the LLM rewrites the weak drafts using their critiques; re-score.
 *   SELECT    return the top hooks by score, each tied to the real exemplar it
 *             learned from and its data-backed predicted swipe-through.
 *
 * Memory (semantic): learned hook principles accumulate across runs and feed back
 * into DECIDE. recordOutcome() lets the channel teach the engine which hooks won.
 *
 * Pure module: the LLM call and the memory store are injected by the caller, so
 * this stays testable and side-effect free.
 */
const intel = require('./hook-intel');

// ---- word-level retention data (real A/B deltas) for the scorer ----
const fs = require('fs');
const path = require('path');
function readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8')); } catch (e) { return null; } }

let _words = null, _wordsAt = 0;
function wordImpact() {
    if (_words && Date.now() - _wordsAt < 10 * 60 * 1000) return _words;
    const raw = readJson('word-retention-impact.json') || {};
    const m = {};
    for (const [w, v] of Object.entries(raw)) {
        if (v && typeof v.avg_ab === 'number' && (v.n || 0) >= 6) m[w.toLowerCase()] = v.avg_ab;
    }
    _words = m; _wordsAt = Date.now();
    return m;
}

const tok = s => (String(s || '').toLowerCase().match(/[a-z0-9']+/g) || []);
const FIRST_GOOD = new Set(['go', 'train', 'how', 'walk', 'break', 'these', 'can', 'when', 'this', 'i', 'why', 'what', 'watch', 'meet', 'inside', 'every', 'the']);
const FIRST_BAD = new Set(['in', "it's", 'right', 'spend', "i'm", 'learn', 'apparently', 'so', 'um', 'today', 'hey', 'guys', 'welcome']);
const MATERIAL = new Set(['plastic', 'fiberglass', 'fiber', 'materials', 'carbon', 'resin', 'aluminum', 'polymer', 'epoxy', 'filament', 'pla', 'petg']);
const VISCERAL = new Set(['painful', 'hurt', 'insane', 'crazy', 'freezing', 'burning', 'impossible', 'dangerous', 'fastest', 'hottest', 'strongest', 'world', 'first', 'last', 'real', 'destroy', 'survive', 'beat', 'fail', 'extreme']);
// Concept/curiosity words that historically anchor a strong hook even without a number.
const CONCEPT = new Set(['indestructible', 'unbreakable', 'bulletproof', 'fireproof', 'world\'s', 'worlds', 'ever', 'never', 'secret', 'hidden', 'actually', 'only', 'craziest', 'biggest', 'smallest', 'coolest', 'first', 'real-life', 'reallife', 'discovered', 'finally']);
const VISUAL_ACTION = ['launch', 'pull', 'smash', 'explod', 'jump', 'run', 'fall', 'fire', 'crash', 'reveal', 'open', 'spin', 'fly', 'hit', 'press', 'glow', 'burn', 'pour', 'rip', 'mid-air', 'slow motion', 'reaction', 'wide'];
const VISUAL_STATIC = ['talking head', 'sitting', 'standing still', 'desk', 'looking at the camera', 'static', 'plain background', 'just talking'];

// ---- DETERMINISTIC SCORER: grades a hook against the real retention data ----
// Returns { score:0-100, swipeThrough:'NN%', parts:{...}, critique:[...] }.
function score(line, visual) {
    line = String(line || '').trim();
    visual = String(visual || '').trim();
    const words = tok(line);
    const wi = wordImpact();
    const crit = [];
    let s = 50;   // neutral base
    const parts = {};

    // 1. Word-level retention impact (real A/B deltas — a soft signal: most words
    // aren't in the table, so weight it gently and only flag a clear drag).
    let wsum = 0, wn = 0;
    for (const w of words) { if (w in wi) { wsum += wi[w]; wn++; } }
    const wAvg = wn ? wsum / wn : 0;
    parts.wordImpact = +(wAvg * 100).toFixed(1);
    s += Math.max(-10, Math.min(12, wAvg * 120));
    if (wn >= 3 && wAvg < -0.03) crit.push('Several words historically LOWER retention — swap them for visceral/concrete ones.');

    // 1b. Concept / curiosity / superlative words (anchor strong hooks)
    const concepts = words.filter(w => CONCEPT.has(w)).length;
    if (concepts) s += Math.min(12, concepts * 6);
    parts.concept = concepts;

    // 2. Opening word (strong predictor)
    const first = words[0] || '';
    if (FIRST_GOOD.has(first)) { s += 6; parts.openingWord = 'strong'; }
    else if (FIRST_BAD.has(first)) { s -= 8; parts.openingWord = 'weak'; crit.push(`Opens on "${first}" — a weak first word. Start on action/challenge (go, how, watch, these…).`); }
    else parts.openingWord = 'ok';

    // 3. Material / technical language penalty (14× over-represented at drops)
    const mats = words.filter(w => MATERIAL.has(w));
    if (mats.length) { s -= 6 * mats.length; parts.materialWords = mats; crit.push(`Names materials (${mats.join(', ')}) — show the result, never the material.`); }

    // 4. Specificity: numbers + concrete stakes
    const hasNum = /\d/.test(line) || /\b(one|two|three|first|million|thousand|hundred)\b/.test(line);
    if (hasNum) { s += 6; parts.specific = true; } else crit.push('No concrete number/stake — specifics grip harder than vague claims.');

    // 5. Visceral / high-stakes words
    const visc = words.filter(w => VISCERAL.has(w)).length;
    if (visc) s += Math.min(8, visc * 4);
    parts.visceral = visc;

    // 6. Curiosity gap / open loop
    const openLoop = /\?|but |until |what happens|can you|watch what|wait/i.test(line) || /\bwhy\b|\bhow\b/.test(line);
    if (openLoop) { s += 7; parts.openLoop = true; } else crit.push('No open loop — make the viewer NEED the next second (a question, a "but…", a promise unresolved).');

    // 7. Length: hooks must be tight (≈ first 1-2s of speech)
    parts.words = words.length;
    if (words.length > 14) { s -= 8; crit.push(`Too long (${words.length} words) — a hook is one tight line.`); }
    else if (words.length >= 4 && words.length <= 11) s += 4;

    // 8. Self-reference penalty ("I wanted to…", "today I'm…")
    if (/^(i|i'm|today|in this video|hey|so today)/i.test(line)) { s -= 6; crit.push('Self-referential opener — lead with the spectacle, not yourself.'); }

    // 9. VISUAL: action/impact/reveal rewarded, talking-head/static punished
    const vlow = visual.toLowerCase();
    const action = VISUAL_ACTION.some(k => vlow.includes(k));
    const staticShot = VISUAL_STATIC.some(k => vlow.includes(k));
    if (!visual) { s -= 10; parts.visual = 'missing'; crit.push('No opening VISUAL — the shot matters as much as the line. Describe a high-energy action/impact/reveal.'); }
    else if (action) { s += 8; parts.visual = 'action'; }
    else if (staticShot) { s -= 10; parts.visual = 'static'; crit.push('Opening visual is a static/talking-head shot — open on motion, an impact, or a reveal.'); }
    else { parts.visual = 'neutral'; crit.push('Opening visual is neutral — push it toward action/impact/reveal in the first second.'); }

    s = Math.max(2, Math.min(98, Math.round(s)));
    // Map the 0-100 craft score to a realistic swipe-through band (most videos
    // land 70-92% retained at the hook).
    const swipe = Math.round(62 + (s / 100) * 32);
    return { score: s, swipeThrough: swipe + '%', parts, critique: crit.slice(0, 4) };
}

// ---- format helpers for the prompts ----
function fmtExamples(ex) {
    return ex.map(e => `• "${e.line}"  [VISUAL: ${e.visual || 'n/a'}]  — ${(e.views || 0).toLocaleString()} views`).join('\n');
}
function fmtPack(p) {
    if (!p || p.error) return '';
    const L = (a, f) => (a || []).map(f).join('\n');
    return [
        `DESIGN RULES:\n${(p.designRules || []).map(r => '• ' + r).join('\n')}`,
        `OPENING WORDS — start with: ${(p.openingWords && p.openingWords.bestFirst || []).join(', ')}. Avoid: ${(p.openingWords && p.openingWords.worstFirst || []).join(', ')}.`,
        `WORDS THAT RETAIN: ${(p.wordsThatRetain || []).join(', ')}`,
        `WORDS THAT KILL (avoid): ${(p.wordsThatKill || []).join(', ')}`,
        `VISUAL — make viewers STAY:\n${L(p.visualPeakCauses, c => '• ' + c.cause + ' — ' + c.rule)}`,
        `VISUAL/LANGUAGE — make viewers LEAVE (avoid):\n${L(p.retentionDropCauses, c => '• ' + c.cause + ' — ' + c.rule)}`
    ].join('\n\n');
}

// ---- THE ENGINE ----
// opts: { title, context, script, existingHooks:[] }
// llm: async (messages) => parsedJsonObject  (caller wires Kimi→OpenAI + JSON extraction)
// memory: { principles:[string], wins:[{line,visual,note}] }  (injected; may be empty)
async function run(opts, llm, memory) {
    const title = opts.title || '', context = opts.context || '', script = (opts.script || '').slice(0, 1500);
    const topic = `${title} ${context} ${script}`.trim();
    memory = memory || {};

    // PERCEIVE — retrieve the most similar REAL hooks + the distilled pack
    const examples = intel.examples(topic, 12);
    const pack = intel.build();
    const memBlock = [
        (memory.principles && memory.principles.length) ? `LEARNED PRINCIPLES (from this channel's own past wins — weight these heavily):\n${memory.principles.map(p => '• ' + p).join('\n')}` : '',
        (memory.wins && memory.wins.length) ? `HOOKS THAT WON BEFORE (the user kept these — emulate their style):\n${memory.wins.slice(0, 8).map(w => `• "${w.line}"${w.visual ? ` [VISUAL: ${w.visual}]` : ''}`).join('\n')}` : ''
    ].filter(Boolean).join('\n\n');

    const dataBlock = [
        `REAL OPENING HOOKS from our most SIMILAR past videos (actual line + actual opening shot + views) — study the angle, specificity and visual, then write in THIS proven style:\n${fmtExamples(examples)}`,
        memBlock,
        fmtPack(pack)
    ].filter(Boolean).join('\n\n');

    const sys = `You are this maker/experiment channel's hook strategist. A hook is the SPOKEN LINE + the OPENING VISUAL, both equally important. You are graded by a deterministic scorer built from the channel's real retention data, so ground every choice in the examples/data below — do NOT invent generic structure.

=== CHANNEL DATA ===
${dataBlock}
=== END DATA ===`;

    // DECIDE — draft a wide set of candidates
    const draftMsg = [
        { role: 'system', content: sys },
        { role: 'user', content: `Video: ${title}\nWhat happens: ${context || '(none)'}\nScript: ${script || '(none)'}\nExisting hooks (make different): ${(opts.existingHooks || []).join(' | ') || 'none'}\n\nWrite SIX distinct hook candidates, each modeled on a specific real example above. Output ONLY JSON: {"hooks":[{"line":"...","visual":"...","modeledOn":"which real example's angle"}]}` }
    ];
    let drafts = [];
    try { const o = await llm(draftMsg); drafts = (o && o.hooks) || []; } catch (e) { drafts = []; }
    drafts = drafts.filter(h => h && (h.line || h.text)).map(h => ({ line: (h.line || h.text || '').trim(), visual: (h.visual || '').trim(), modeledOn: h.modeledOn || '' }));
    if (!drafts.length) return { hooks: [], error: 'no drafts' };

    // VERIFY — score every draft against the data
    let scored = drafts.map(d => ({ ...d, ...score(d.line, d.visual) }));

    // REFINE — rewrite the weakest half using their concrete critiques, re-score
    const weak = scored.filter(h => h.score < 78).sort((a, b) => a.score - b.score).slice(0, 4);
    if (weak.length) {
        const refineMsg = [
            { role: 'system', content: sys },
            { role: 'user', content: `Here are weak hook drafts with the SCORER's critique. Rewrite EACH to fix its critique while keeping the topic. Output ONLY JSON: {"hooks":[{"line":"...","visual":"..."}]} in the same order.\n\n${weak.map((h, i) => `${i + 1}. LINE: "${h.line}"\n   VISUAL: "${h.visual}"\n   score ${h.score}/100 — fix: ${h.critique.join(' ')}`).join('\n\n')}` }
        ];
        try {
            const o = await llm(refineMsg);
            const fixed = ((o && o.hooks) || []).map(h => ({ line: (h.line || '').trim(), visual: (h.visual || '').trim() }));
            // replace each weak draft with its improved version if it actually scores higher
            weak.forEach((w, i) => {
                const f = fixed[i]; if (!f || !f.line) return;
                const rescored = { ...f, modeledOn: w.modeledOn, ...score(f.line, f.visual) };
                if (rescored.score > w.score) {
                    const idx = scored.indexOf(w);
                    if (idx >= 0) scored[idx] = rescored;
                }
            });
        } catch (e) { /* keep originals */ }
    }

    // SELECT — best by score, each tied to the nearest real exemplar
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 4).map(h => {
        const ex = intel.examples(h.line + ' ' + topic, 1)[0] || null;
        return {
            line: h.line, visual: h.visual,
            score: h.score, predictedSwipeThrough: h.swipeThrough,
            why: h.critique.length ? `Scored ${h.score}/100. ${h.parts.openLoop ? 'Opens a loop; ' : ''}${h.parts.visual === 'action' ? 'action-led visual; ' : ''}grounded in the channel's retention data.` : `Scored ${h.score}/100 against the channel's real retention data.`,
            modeledOn: ex ? { line: ex.line, views: ex.views } : null,
            breakdown: h.parts
        };
    });
    return { hooks: top, nExamples: examples.length, nVideos: pack.nVideos };
}

module.exports = { run, score, wordImpact };
