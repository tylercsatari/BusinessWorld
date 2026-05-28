#!/usr/bin/env node
// Da Vinci Stack — Idea Generator v3 (parallel-asset architecture)
// THE KEY SHIFT: the thing Tyler BUILDS in the video is a parallel asset — a famous-or-novel
// demonstration of a principle (like the Da Vinci Bridge) — NOT a rebuild of one of his past
// videos. The connection to a past video is a SECRET REVEAL at the end of the video.
//
// 6-STEP PIPELINE per idea:
//   1. Zeigarnik high-stakes scenario (survival / escape / mortal stake)
//   2. Identify the problem the protagonist must solve
//   3. Pick a PARALLEL ASSET whose principle physically solves the problem
//   4. Verify the parallel asset's principle matches a Tyler past video's principle family
//   5. Construct the materials scene so the asset is BUILDABLE from visible materials
//   6. Add the SECRET REVEAL line: "What you didn't realize — this is the same principle I used in [past video]"
//
// Usage:
//   node _generate_ideas_v3.js                 # dry run 3 ideas
//   node _generate_ideas_v3.js --count 95 --apply
//
// Files used:
//   buildings/library/generation_kit/parallel_assets.json  (the catalog)
//   buildings/library/generation_kit/past_videos.json
//   buildings/library/generation_kit/ideas.json  (existing — first 5 are exemplar bar)
// Writes to ideas.json and the live BusinessWorld note.

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname);
const KIT_DIR = path.join(ROOT, 'buildings/library/generation_kit');
const PAST = path.join(KIT_DIR, 'past_videos.json');
const ASSETS = path.join(KIT_DIR, 'parallel_assets.json');
const IDEAS_DB = path.join(KIT_DIR, 'ideas.json');
const LOG = '/tmp/ideas_v3.log';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i+1] : d; };
const COUNT = parseInt(arg('--count', '3'));
const APPLY = argv.includes('--apply');
const NOTE_TITLE_PREFIX = 'Da Vinci Stack — ';
const CONCURRENCY = 5;
const REFINE_CYCLES = 1;

function log(line) {
    const msg = `[${new Date().toISOString()}] ${line}`;
    console.log(msg);
    try { fs.appendFileSync(LOG, msg + '\n'); } catch {}
}
function httpJson(method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            method, hostname:'localhost', port:8002, path:p,
            headers: { 'Content-Type':'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 }
        }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ if(res.statusCode>=400) return reject(new Error(res.statusCode+': '+d.slice(0,400))); try{resolve(JSON.parse(d))}catch{resolve(d)} }); });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function n(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function scoreZeigarnik(m) {
    const stake = n(m.stake_tier) * 1.5;
    const vis = n(m.stake_visibility);
    const w_sec = n(m.resolution_window_sec, 60);
    const window = w_sec <= 10 ? 3 : w_sec <= 30 ? 2 : w_sec <= 60 ? 1 : 0;
    const shot = m.single_shot === true ? 2 : 0;
    const irr = n(m.irreversibility);
    const prox = n(m.identity_proximity) * 0.7;
    const rec = n(m.recognized_danger);
    const fam = m.family_bonus_eligible === true ? 1 : 0;
    const nov = n(m.novelty);
    return Math.round((stake + vis + window + shot + irr + prox + rec + fam + nov) * 10) / 10;
}
function scoreLA(m) {
    const fields = ['obvious_elimination', 'solution_space', 'principle_convergence', 'reality_check', 'non_obvious_reveal', 'category_recognition', 'past_video_callback', 'not_binary', 'constraint_realism', 'material_plausibility', 'material_sufficiency', 'material_visibility', 'riddle_solvability'];
    return fields.reduce((s, f) => s + n(m[f]), 0);
}
function hookLeaksPastVideo(hook) {
    // The hook line should NOT mention Tyler's past videos. Common leakage phrases:
    return /\b(just like (i|my)|i (tested|built|made|did)|in my [a-z]+ video|my previous|like i showed|previously i)\b/i.test(hook || '');
}

function loadExemplars() {
    const ideas = JSON.parse(fs.readFileSync(IDEAS_DB, 'utf8'));
    return ideas.slice(0, 5).map(i => `EXEMPLAR — TITLE: ${i.title}
OPENING SCENE: ${i.opening_scene}
MATERIALS VISIBLE: ${(i.materials_visible || []).join(', ')}
GOAL: ${i.goal}
CONSTRAINTS: ${(i.constraints || []).map(c => '· ' + c).join(' ')}
DEFAULTS ELIMINATED: ${(i.default_solutions_eliminated || []).map(d => `(${d.solution} → ${d.why_eliminated})`).join(' · ')}
CONSTRUCTION: ${i.principle_solution}
HOOK LINE: "${i.hook_line}"
PRINCIPLE: ${i.principle_name} [family: ${i.principle_family}]
PAST VIDEO: ${i.past_video?.title}`).join('\n\n');
}

// ─── PIPELINE STEP 1: pick a Tyler family + present a candidate-asset slate ────
function pickFamilyAndSlate(past, assets, usedAssetNames, usedFamilies) {
    const families = past.constructible.filter(f => f.past_videos.length > 0);
    // Sample family by least-used (round-robin-ish)
    const sorted = families.slice().sort((a, b) => (usedFamilies[a.principle_family] || 0) - (usedFamilies[b.principle_family] || 0));
    const fam = sorted[0];
    usedFamilies[fam.principle_family] = (usedFamilies[fam.principle_family] || 0) + 1;

    // Build a slate of 12 candidate parallel assets that PLAUSIBLY match this family.
    // Use loose family tag + keyword scan over asset.principle/description for the family's principle keywords.
    const principleKeywords = fam.principles.flatMap(p => p.split(/[\s/]+/).filter(w => w.length > 4)).map(w => w.toLowerCase());

    function relevanceScore(a) {
        if (usedAssetNames.has((a.name || '').toLowerCase().trim())) return -1;
        let score = 0;
        if (a.related_tyler_principle_family === fam.principle_family) score += 4;
        const text = `${a.principle} ${a.description}`.toLowerCase();
        for (const kw of principleKeywords) if (text.includes(kw)) score += 1;
        score += Math.min(2, (parseInt(a.wow_factor) || 5) / 4);
        return score;
    }
    const ranked = assets
        .map(a => ({ a, s: relevanceScore(a) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s);

    // Top 12, with some random shuffle so we don't always pick the same
    const top = ranked.slice(0, 24);
    for (let i = top.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [top[i], top[j]] = [top[j], top[i]]; }
    const slate = top.slice(0, 12).map(x => x.a);

    return { family: fam, slate };
}

// ─── PIPELINE: LLM picks asset from slate, then writes idea ──────────────
function buildPromptWithSlate(family, slate, exemplars, recentTitles) {
    const pastVideo = family.past_videos[0];
    const naturalMaterials = family.natural_materials.join(', ');
    const familyPrinciples = family.principles.join(' / ');
    const slateList = slate.map((a, i) => `  ${i+1}. **${a.name}** — demonstrates "${a.principle}". ${a.description}`).join('\n');

    return `You write Tyler Csatari video ideas using the **parallel-asset architecture**.

═══════════════════════════════════════════════════════════════════════
STEP A — TYLER'S PAST VIDEO + ITS PRINCIPLE
═══════════════════════════════════════════════════════════════════════

PAST VIDEO: ${pastVideo.title} (ytId: ${pastVideo.ytId}, ${pastVideo.views.toLocaleString()} views)
PRINCIPLES Tyler demonstrated: ${familyPrinciples}
NATURAL MATERIALS that invoke this family: ${naturalMaterials}

═══════════════════════════════════════════════════════════════════════
STEP B — CHOOSE A PARALLEL ASSET FROM THIS SLATE
═══════════════════════════════════════════════════════════════════════

Pick exactly ONE asset from the slate below. Your choice MUST share the SAME underlying physical MECHANISM as the past video's principles — not just be topically related. If NONE of them share a real mechanism (≥ "same chapter, same effect" level), respond with \`{"skip": true, "reason": "no match"}\` and stop.

SLATE:
${slateList}

═══════════════════════════════════════════════════════════════════════

THE BIG IDEA: the thing Tyler builds in this video is a famous-or-novel scientific demonstration — a "parallel asset" — that happens to share its underlying principle with one of Tyler's past videos. The viewer doesn't know the connection until the SECRET REVEAL at the end.

Example: in Tyler's *real* Da Vinci Bridge video, he built the bridge to demonstrate the reciprocal-structure principle. That principle is the same one he had used in his Reciprocal Helmet. The reveal at the end is "you didn't realize, but this is the same physics that made my helmet work."

The VIEWER does not know about the past video at the start of the video. Tyler reveals the connection at the end.

═══════════════════════════════════════════════════════════════════════
THE EXEMPLAR QUALITY BAR (the 5 user-approved originals)
═══════════════════════════════════════════════════════════════════════

${exemplars}

═══════════════════════════════════════════════════════════════════════
THE 6-STEP PIPELINE for THIS idea
═══════════════════════════════════════════════════════════════════════

STEP 1 — ZEIGARNIK. Design a high-stakes scenario where building the parallel asset solves the problem.
   The stake should be mortal/irreversible (cliff fall, drowning, crush, fire — like the exemplars).

STEP 2 — PROBLEM. Identify the one-sentence goal (cross a gap, hold up a load, etc.) the asset will solve.

STEP 3 — RIDDLE. Phrase as "If you were [stranded] with only [materials], how would you [achieve goal]?"
   Hook line is 50-80 words, vivid, sensory.
   **THE HOOK LINE MUST NOT CONTAIN ANY OF: "just like I", "I tested", "I built", "I made", "I did", "in my video", "previously", "like I showed".**
   The past-video reference belongs ONLY in the secret_reveal_line at the END of the video.

STEP 4 — DEFAULT ELIMINATIONS. List 4-6 obvious solutions and explain why each fails (specific physical reasons).

STEP 5 — CONSTRUCTION. The parallel asset you chose from the slate must be the only surviving solution, AND must be hand-constructible from materials VISIBLE in the opening scene.

STEP 6 — SECRET REVEAL LINE. Write the punchline-at-end where Tyler reveals to the viewer: "What you didn't realize... this is the EXACT same principle I used in [past video title] — [1-line connection]."

═══════════════════════════════════════════════════════════════════════
EXISTING TITLES (DO NOT DUPLICATE)
═══════════════════════════════════════════════════════════════════════
${recentTitles.slice(-25).map(t => '· ' + t).join('\n')}

═══════════════════════════════════════════════════════════════════════
OUTPUT — strict JSON
═══════════════════════════════════════════════════════════════════════

{
  "chosen_asset_index": <1-${slate.length} — your pick from the slate above>,
  "title": "<8 words max, vivid, specific>",
  "parallel_asset": {
    "name": "<exact name from slate>",
    "principle": "<exact principle from slate>",
    "description": "<exact description from slate>"
  },
  "principle_family": "${family.principle_family}",
  "principle_name": "<atomic textbook name of the underlying principle — be specific>",
  "past_video": { "title": "${pastVideo.title}", "ytId": "${pastVideo.ytId}", "views": ${pastVideo.views} },
  "opening_scene": "<vivid 2-3 sentence cinematic scene description with all materials visible at frame 0 and the immediate threat. Sensory details required.>",
  "materials_visible": ["<material 1>", "<material 2>", ...],
  "goal": "<one-sentence need>",
  "constraints": ["<each constraint eliminates a default>", ...],
  "default_solutions_eliminated": [
    { "solution": "<what someone would try>", "why_eliminated": "<specific physical reason>" }
    // 4+ entries
  ],
  "principle_solution": "<2-3 sentences: how the visible materials are combined to construct the parallel asset you chose and how it solves the problem>",
  "hook_line": "<the opener — 'If you were…' format, 50-80 words, vivid, NO mention of past video>",
  "secret_reveal_line": "<the punchline-at-end. Format: 'What you didn't realize — this is the EXACT same principle I used to build my [past video name]. [1-sentence explanation of how the two share principle].'>",
  "vfx_placeholder_family": "<Family letter(s)>",
  "vfx_notes": "<one sentence on filming safety>",
  // Scoring fields — fill honestly based on the idea you just wrote
  "stake_tier": <0-6>, "stake_visibility": <0-3>, "resolution_window_sec": <3-60>, "single_shot": <true|false>,
  "irreversibility": <0-2>, "identity_proximity": <0-3>, "recognized_danger": <0-1>, "novelty": <0-2>, "family_bonus_eligible": <true|false>,
  "obvious_elimination": <0-3>, "solution_space": <0-3>, "principle_convergence": <0-3>, "reality_check": <0-3>,
  "non_obvious_reveal": <0-3>, "category_recognition": <0-2>, "past_video_callback": <0-2>, "not_binary": <0-1>, "constraint_realism": <0-2>,
  "material_plausibility": <0-3>, "material_sufficiency": <0-3>, "material_visibility": <0-3>, "riddle_solvability": <0-3>
}

Output strict JSON: { "idea": {...} }`;
}

async function generateOne(family, slate, exemplars, recentTitles) {
    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: 'You select a parallel asset from a slate, then write a cinematic video idea. Output strict JSON only.' },
            { role: 'user', content: buildPromptWithSlate(family, slate, exemplars, recentTitles) }
        ],
        temperature: 0.9,
        max_tokens: 3500,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
    const parsed = JSON.parse(text);
    if (parsed.skip) return { skipped: true, reason: parsed.reason };
    return parsed.idea || parsed;
}

// ─── JUDGE: comparative against exemplars + parallel-asset checks ─────────
function buildJudgePrompt(idea, exemplars) {
    return `Evaluate this new idea against the exemplar quality bar AND the parallel-asset architecture rules.

EXEMPLARS:
${exemplars}

NEW IDEA:
TITLE: ${idea.title}
PARALLEL ASSET BEING BUILT: ${idea.parallel_asset?.name} — ${idea.parallel_asset?.principle}
PRINCIPLE: ${idea.principle_name}
PAST VIDEO (secret reveal target): ${idea.past_video?.title}
OPENING SCENE: ${idea.opening_scene}
MATERIALS VISIBLE: ${(idea.materials_visible || []).join(', ')}
GOAL: ${idea.goal}
CONSTRAINTS: ${(idea.constraints || []).join(' | ')}
DEFAULTS ELIMINATED: ${(idea.default_solutions_eliminated || []).map(d => `(${d.solution} → ${d.why_eliminated})`).join(' · ')}
CONSTRUCTION: ${idea.principle_solution}
HOOK LINE: "${idea.hook_line}"
SECRET REVEAL LINE: "${idea.secret_reveal_line}"

CHECKS (FAIL only on clear weakness vs exemplars):

C1. Mortal/irreversible stake (FAIL if mild stake)
C2. Hook line is 40+ words, vivid, sensory, does NOT mention past video
C3. Materials visible in opening scene
C4. Parallel asset (${idea.parallel_asset?.name}) is hand-constructible from those materials
C5. Defaults eliminated specifically (3+)
C6. Parallel asset is the only surviving solution
C7. Physics works (the parallel asset actually solves the problem at the scale described)
C8. Secret reveal line — the parallel asset and the past video must share the SAME underlying physical MECHANISM (not just be topically related). E.g. magnesium combustion (exothermic oxidation) ≠ pyrolysis-char thermal shielding even though both are "fire-related". Reciprocal-frame interlocking IS the same as helmet plates interlocking. FAIL if the mechanism connection is a stretch or topical-only.
C9. Past video link is a real Tyler video (not generic)
C10. Riddle is genuinely solvable by a viewer with the visible materials

Output strict JSON: { "verdict":"PASS"|"FAIL", "checks": {...}, "reasons":[...],
  "stake_tier":<>, "stake_visibility":<>, "resolution_window_sec":<>, "single_shot":<>,
  "irreversibility":<>, "identity_proximity":<>, "recognized_danger":<>, "novelty":<>, "family_bonus_eligible":<>,
  "obvious_elimination":<>, "solution_space":<>, "principle_convergence":<>, "reality_check":<>,
  "non_obvious_reveal":<>, "category_recognition":<>, "past_video_callback":<>, "not_binary":<>, "constraint_realism":<>,
  "material_plausibility":<>, "material_sufficiency":<>, "material_visibility":<>, "riddle_solvability":<>
}

Default to PASS for the structural checks. On C8 (principle match), use this scale and default to 2 for reasonable connections:
- 0: unrelated (different field — magnetism vs thermal). FAIL.
- 1: topically related only ("both involve heat" / "both use force"). Acceptable for novelty videos.
- 2: same effect / same chapter ("both exploit phase-change latent heat" / "both use cross-grain layering"). Solid connection.
- 3: exact same mechanism (reciprocal-frame interlock in bridge = reciprocal interlock in helmet). Perfect.

Default to 2 unless the connection is clearly a stretch. Only score 1 if the connection is genuinely topical-only; only 0 if completely unrelated.`;
}

async function judgeIdea(idea, exemplars) {
    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: 'Editor comparing new idea to exemplars. You MUST fill in ALL scoring numeric fields requested in the schema (never leave them blank). Default PASS unless clearly weaker. JSON only.' },
            { role: 'user', content: buildJudgePrompt(idea, exemplars) }
        ],
        temperature: 0.0,
        max_tokens: 2000,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
    return JSON.parse(text);
}

async function refineIdea(idea, j, exemplars) {
    const reasons = (j.reasons || []).join(' / ');
    const failed = Object.entries(j.checks || {}).filter(([k,v]) => v === 'FAIL').map(([k]) => k).join(', ');
    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o',
        messages: [{ role:'user', content: `Rewrite this idea to fix the failed checks. Keep the parallel asset ${idea.parallel_asset?.name} and the principle. Fix only what failed.

EXEMPLARS:
${exemplars}

ORIGINAL IDEA: ${JSON.stringify(idea)}

FAILED CHECKS: ${failed}
REASONS: ${reasons}

Output strict JSON: { "idea": {...same schema...} }`
        }],
        temperature: 0.85,
        max_tokens: 3500,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
    return JSON.parse(text).idea;
}

// ─── Render markdown for one idea ─────────────────────────────────────────
function renderIdea(idea, i) {
    const zei = scoreZeigarnik(idea);
    const la = scoreLA(idea);
    const elimRows = (idea.default_solutions_eliminated || []).map(d => `| ${d.solution} | ${d.why_eliminated} |`).join('\n');
    return `# ${idea.title}

**Hook (opener):** *"${(idea.hook_line || '').replace(/\n/g, ' ')}"*

**Opening scene:** ${idea.opening_scene || ''}

**Materials visible:** ${(idea.materials_visible || []).join(', ')}

**Goal:** ${idea.goal || ''}

**Constraints:**
${(idea.constraints || []).map(c => `- ${c}`).join('\n')}

**Default solutions eliminated:**

| Default | Why eliminated |
|---|---|
${elimRows}

## ★ The Parallel Asset (what Tyler builds)

**${idea.parallel_asset?.name || ''}** — demonstrates *${idea.parallel_asset?.principle || idea.principle_name}*.

${idea.parallel_asset?.description || ''}

**Construction:** ${idea.principle_solution || ''}

## ★ The Secret Reveal (end of video)

> ${idea.secret_reveal_line || ''}

**Connection:** The ${idea.parallel_asset?.name || 'parallel asset'} and Tyler's [${idea.past_video?.title || ''}](https://youtu.be/${idea.past_video?.ytId || ''}) (${(idea.past_video?.views || 0).toLocaleString()} views) both rely on the same atomic principle: \`${idea.principle_name}\`.

---

**VFX:** ${idea.vfx_placeholder_family || ''} — ${idea.vfx_notes || ''}

**Scores:** Zeigarnik ${zei} · Logical Alignment v2 ${la}/34
`;
}

// ─── Main ────────────────────────────────────────────────────────────────
(async () => {
    fs.writeFileSync(LOG, '');
    log(`Idea generator v3 (parallel-asset architecture) — requested ${COUNT}, apply=${APPLY}`);

    const past = JSON.parse(fs.readFileSync(PAST, 'utf8'));
    const assets = JSON.parse(fs.readFileSync(ASSETS, 'utf8'));
    let existing = [];
    if (fs.existsSync(IDEAS_DB)) { try { existing = JSON.parse(fs.readFileSync(IDEAS_DB, 'utf8')); } catch { existing = []; } }
    log(`existing ideas: ${existing.length} | parallel assets: ${assets.length}`);

    const exemplars = loadExemplars();
    const existingTitles = existing.map(e => (e.title || '').trim().toLowerCase());
    const titleSeen = new Set(existingTitles);
    const usedAssets = new Set(existing.filter(e => e.parallel_asset?.name).map(e => e.parallel_asset.name.toLowerCase().trim()));

    const accepted = [];
    const usedFamilies = {};
    let creative = 0, judged = 0, judgePass = 0, judgeFail = 0, skipped = 0;
    const maxAttempts = COUNT * 6;

    while (accepted.length < COUNT && creative < maxAttempts) {
        // Build a slate per concurrent job, round-robining families
        const slatePicks = [];
        for (let i = 0; i < CONCURRENCY && slatePicks.length < COUNT - accepted.length; i++) {
            const { family, slate } = pickFamilyAndSlate(past, assets, usedAssets, usedFamilies);
            if (!family || slate.length === 0) break;
            slatePicks.push({ family, slate });
        }
        if (slatePicks.length === 0) { log('no more eligible families/slates'); break; }

        const recentTitles = [...titleSeen].slice(-25);
        const genPromises = slatePicks.map(({ family, slate }) =>
            generateOne(family, slate, exemplars, recentTitles)
                .then(idea => ({ idea, family, slate }))
                .catch(e => { log(`gen err: ${e.message}`); return null; })
        );
        const genResults = (await Promise.all(genPromises)).filter(Boolean);
        creative += genResults.length;

        // Judge each + refine
        const judgePromises = genResults.map(async ({ idea, family, slate }) => {
            if (idea?.skipped) {
                skipped++;
                log(`SKIP (${family.principle_family}): ${idea.reason}`);
                return null;
            }
            const asset = idea?.parallel_asset;
            if (asset?.name) usedAssets.add(asset.name.toLowerCase().trim());
            if (!idea || !idea.title) return null;
            const t = idea.title.trim().toLowerCase();
            if (titleSeen.has(t)) return null;
            let cur = idea;
            let j = await judgeIdea(cur, exemplars).catch(e => ({ verdict:'FAIL', reasons:['judge err: '+e.message] }));
            if (j.verdict !== 'PASS') {
                for (let r = 0; r < REFINE_CYCLES; r++) {
                    try {
                        const refined = await refineIdea(cur, j, exemplars);
                        if (refined) { cur = refined; j = await judgeIdea(cur, exemplars); if (j.verdict === 'PASS') break; }
                    } catch (e) { log(`refine err: ${e.message}`); break; }
                }
            }
            return { idea: cur, j, asset: cur.parallel_asset };
        });
        const judgeResults = (await Promise.all(judgePromises)).filter(Boolean);

        for (const { idea, j } of judgeResults) {
            judged++;
            const t = (idea.title || '').trim().toLowerCase();
            if (!t || titleSeen.has(t)) continue;
            // Auto-fail if hook leaks past-video reference (must be reserved for secret_reveal_line)
            if (hookLeaksPastVideo(idea.hook_line)) {
                judgeFail++;
                log(`✗ ${idea.title} — hook leaks past-video reference (must be in secret_reveal_line only)`);
                continue;
            }
            // Auto-fail if secret_reveal_line is empty/missing
            if (!(idea.secret_reveal_line || '').trim()) {
                judgeFail++;
                log(`✗ ${idea.title} — missing secret_reveal_line`);
                continue;
            }
            if (j.verdict === 'PASS') {
                // Add hard score gate on judge's own scoring — catches lenient judges
                Object.assign(idea, j);
                const zei = scoreZeigarnik(idea);
                const la = scoreLA(idea);
                // Loosened gate: accept "topically related" mechanism matches (pc >= 1).
                const pc = n(j.principle_convergence);
                if (la < 22 || zei < 16 || pc < 1) {
                    judgeFail++;
                    log(`✗ ${idea.title} — judge PASS but below floor (la=${la}, zei=${zei}, principle_convergence=${pc})`);
                    continue;
                }
                judgePass++;
                titleSeen.add(t);
                idea._zei = zei;
                idea._la = la;
                accepted.push(idea);
                log(`✓ ${idea.title}  (zei=${idea._zei}, la=${idea._la}, asset=${idea.parallel_asset?.name})`);
                if (accepted.length >= COUNT) break;
            } else {
                judgeFail++;
                log(`✗ ${idea.title} — ${(j.reasons || []).slice(0,2).join(' / ')}`);
            }
        }
        log(`pass-rate ${judgePass}/${judged}`);
    }

    log(`DONE accepted=${accepted.length}/${COUNT} | creative=${creative} | judged=${judged} | pass=${judgePass} fail=${judgeFail}`);

    if (!APPLY) {
        console.log('\nDry-run sample (first):');
        for (const m of accepted.slice(0, 3)) {
            console.log('\n══', m.title);
            console.log('Parallel Asset:', m.parallel_asset?.name);
            console.log('Principle:', m.principle_name);
            console.log('Hook:', (m.hook_line || '').slice(0, 200));
            console.log('Secret Reveal:', (m.secret_reveal_line || '').slice(0, 200));
            console.log('Scores: Zei', m._zei, 'LA', m._la);
        }
        return;
    }

    const all = [...existing, ...accepted];
    fs.writeFileSync(IDEAS_DB, JSON.stringify(all, null, 2));
    log(`wrote ideas.json — total now: ${all.length}`);

    // Build sub-tabbed note structure: outer = principle family, inner = individual idea
    const families = {};
    for (const idea of all) (families[idea.principle_family || 'other'] = families[idea.principle_family] || []).push(idea);
    const familyOrder = Object.keys(families).sort((a, b) => families[b].length - families[a].length);

    const overview = renderOverview(all, families, familyOrder);
    const tabs = [{ title: '★ Overview & Index', body: overview }];
    for (const fam of familyOrder) {
        const list = families[fam].sort((a, b) => (b._la || scoreLA(b)) - (a._la || scoreLA(a)));
        // For families with multiple ideas, build sub-tabs
        const subtabs = list.map((idea, i) => ({
            title: `${i+1}. ${(idea.title || '').slice(0, 30)}`,
            body: renderIdea(idea, i + 1)
        }));
        const famOverview = `# ${prettyTabTitle(fam, list.length)}\n\nClick a sub-tab to view a specific idea.\n\n## Index\n\n| # | Title | Parallel asset | Past video | Zei | LA |\n|---|---|---|---|---|---|\n${list.map((idea, i) => `| ${i+1} | ${idea.title} | ${idea.parallel_asset?.name || ''} | ${idea.past_video?.title || ''} | ${idea._zei ?? scoreZeigarnik(idea)} | ${idea._la ?? scoreLA(idea)} |`).join('\n')}`;
        tabs.push({ title: prettyTabTitle(fam, list.length), body: famOverview, subtabs });
    }

    // Delete prior versions
    const allNotes = await httpJson('GET', '/api/data/notes');
    const priors = allNotes.filter(n => /^da vinci stack — \d+ aligned/i.test(n.title || '') || /^da vinci stack — \d+ video ideas/i.test(n.title || ''));
    for (const p of priors) {
        await httpJson('DELETE', `/api/data/notes/${p.id}`);
        log(`deleted prior note: ${p.id}`);
    }

    const note = await httpJson('POST', '/api/data/notes', {
        title: `${NOTE_TITLE_PREFIX}${all.length} Video Ideas (parallel-asset architecture)`,
        body: '',
        tabs,
        pinned: true,
        linkedProject: '',
        linkedIdeaId: '',
        lastEdited: new Date().toISOString()
    });
    log(`created note ${note.id} — tabs: ${note.tabs.length} — total ideas: ${all.length}`);
})().catch(e => { log('FATAL: ' + e.stack); process.exit(1); });

function prettyTabTitle(fam, n) {
    const labels = {
        non_newtonian_shear_thickening: 'Oobleck',
        mechanical_advantage: 'Pulleys & Levers',
        composite_layering: 'Layered Armor',
        thermal_insulation_organic: 'Heat Shields',
        spring_elastic_return: 'Elastic Springs',
        buoyancy_displacement: 'Buoyancy',
        catenary_tensile_geometry: 'Tensile Geometry',
        capillary_action: 'Capillary',
        friction_heat_ignition: 'Friction Ignition',
        triboelectric_static: 'Static Electricity',
        resonance_acoustic: 'Acoustic Resonance',
        centripetal_centrifugal: 'Spin & Sling',
        siphon_fluid_dynamics: 'Siphon / Fluid',
        balance_center_of_mass: 'Balance'
    };
    return `${labels[fam] || fam.replace(/_/g, ' ')} (${n})`;
}

function renderOverview(all, families, familyOrder) {
    let md = `# Da Vinci Stack — ${all.length} Video Ideas\n\n`;
    md += `> *Parallel-asset architecture: the thing Tyler BUILDS in each video is a famous-or-novel scientific demonstration (the "parallel asset") that happens to share its underlying principle with one of his past videos. The connection is a SECRET REVEAL at the end — the viewer didn't realize what they were watching until then.*\n\n`;
    md += `> *Each idea was generated through the 6-step pipeline (Zeigarnik → problem → riddle → logical alignment v1 → parallel-asset insertion → logical alignment v2) and survived an adversarial judge pass.*\n\n`;
    md += `## Family tabs (use the filter input at the top to search)\n\n`;
    md += `| Tab | # ideas | Past Tyler video |\n|---|---|---|\n`;
    for (const fam of familyOrder) {
        const list = families[fam];
        const sample = list[0];
        const pv = sample?.past_video;
        const pvLink = pv ? `[${pv.title}](https://youtu.be/${pv.ytId})` : '—';
        md += `| ${prettyTabTitle(fam, list.length)} | ${list.length} | ${pvLink} |\n`;
    }
    md += `\n## All ideas (index)\n\n`;
    md += `| # | Family | Title | Parallel asset | Zei | LA |\n|---|---|---|---|---|---|\n`;
    let idx = 1;
    for (const fam of familyOrder) for (const idea of families[fam]) {
        const zei = idea._zei ?? scoreZeigarnik(idea);
        const la = idea._la ?? scoreLA(idea);
        md += `| ${idx++} | ${fam.replace(/_/g, ' ')} | ${idea.title} | ${idea.parallel_asset?.name || '—'} | ${zei} | ${la} |\n`;
    }
    md += `\n---\n\n## Generate more\n\n\`\`\`bash\nnode _generate_ideas_v3.js --count 20 --apply\n\`\`\`\n\nReads \`buildings/library/generation_kit/parallel_assets.json\` + \`past_videos.json\` + \`ideas.json\`. Picks an unused parallel asset, runs the 6-step pipeline, adversarial judge + refine, appends to ideas.json, regenerates the live note.`;
    return md;
}
