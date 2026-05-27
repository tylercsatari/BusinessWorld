#!/usr/bin/env node
// Create the "Da Vinci Stack" framework note in BusinessWorld's library.
// Tabs: Overview · 1 VFX Placeholders · 2 Visual Open Loops · 3 Riddle Frames · 4 Underlying Principles

const fs = require('fs');
const http = require('http');

const DESKTOP = '/Users/tylercsatari/Desktop';
const DOCS = [
    { title: '① VFX Placeholders', file: '1 — VFX Placeholders.md' },
    { title: '② Visual Open Loops', file: '2 — Visual Open Loops.md' },
    { title: '③ Riddle Frames', file: '3 — Riddle Frames.md' },
    { title: '④ Underlying Principles', file: '4 — Underlying Principles.md' }
];

const OVERVIEW = `# The Da Vinci Stack

> The 4-layer recipe for every shippable Tyler Csatari short. Named after the **Da Vinci Bridge** video because that short stacks all four layers in one frame — duct tape on grass cued the VFX-rendered canyon edge (layer 1), Tyler walking toward the cliff opened the mortal visual loop (layer 2), the "if you only had short sticks and no fasteners, how would you cross?" voice line framed the riddle (layer 3), and the build's answer demonstrated the *reciprocal structures* principle (layer 4).

---

## The four layers (one row per shipped video)

| Layer | What it answers | Playbook tab |
|---|---|---|
| **1 — VFX Placeholder** | What on-set hack makes the danger filmable? (duct-tape canyon, greensuit, mocap dots, foam stand-in) | ① VFX Placeholders |
| **2 — Visual Open Loop** | What is on screen in the first 1.5 seconds that the viewer can't scroll past? (extreme stake, recognizable danger, novelty multiplier) | ② Visual Open Loops |
| **3 — Riddle Frame** | What is the puzzle the viewer is solving until 0:25? (constraint, forbidden move, "if you had only X…") | ③ Riddle Frames |
| **4 — Underlying Principle** | What deep transferable scientific / engineering idea does the build actually exploit? (reciprocal structures, non-Newtonian, tensegrity, Magnus, capillary, Hooke's…) | ④ Underlying Principles |

---

## How to use this note

1. **Open ② Visual Open Loops** and pick any mechanism with formula score ≥ 19. The doc has 1,500 candidates + 250 verified viral examples + the scoring formula.
2. **Open ③ Riddle Frames** and pick a constraint puzzle (R1) or forbidden-move (R2) that matches the visual.
3. **Open ④ Underlying Principles** and pick a principle from the list you haven't shipped recently (under-mined = open lane).
4. **Open ① VFX Placeholders** and pick the on-set hack that lets you film it cheaply (tape edge, foam stand-in, mocap markers, greensuit).
5. Write the shot list. Every video = one row of (1) × (2) × (3) × (4).

---

## The Da Vinci Bridge worked example

- **Layer 1 (Placeholder):** duct tape on grass marked the canyon edge. Corner inset shows the CGI canyon. (Family A — Corner-Overlay Reveal.)
- **Layer 2 (Open Loop):** Tyler walking toward the edge. Tier 6 mortal stake, visually dominant, single-shot, recognized danger, novelty = the reciprocal stick bridge sitting at the edge. Formula score ≈ 22 (mega-viral predicted). Posted 2026-05-25 — currently 3.35M views and climbing.
- **Layer 3 (Riddle):** "If you only had short pieces of wood and no fasteners, how would you cross?" Frame R1 — constraint puzzle (goal: cross water, constraints: no nails, no fasteners).
- **Layer 4 (Principle):** Reciprocal structures — every stick supports its neighbors via mutual interlock geometry. The same principle Tyler used in the Reciprocal Helmet (linked: 'Reciprocal Helmet introduction').

---

## Quality check before shipping any video built from this stack

1. Can the entire video be ONE continuous shot to resolution? (Cut Count = 2)
2. Is the stake visually dominant in the first 1.5s? (Visibility = 3)
3. Is failure literally irreversible? (Irreversibility = 2)
4. Does the viewer recognize the danger in 0.5s? (Recognized = 1)
5. Is resolution under 30s? (Window ≥ 2)
6. Is the body / money / identity of someone we relate to at risk? (Proximity ≥ 2)
7. **Is there clear NOVELTY on the mechanism** — a specific custom element, scale, subject, or pairing the viewer hasn't seen before? (Novelty = 2)

If yes to 6 of 7, the formula predicts viral.

---

## The four tabs in this note

- **① VFX Placeholders** — 40 placeholder families × ~25 examples each → ~1,000 entries. Every on-set hack from tape edges to mocap dots to greensuit assistants to lighting reference balls.
- **② Visual Open Loops** — 253 verified viral examples (web-researched + mined from your local 2,279 100M+ shorts DB) + the 9-indicator Zeigarnik formula (Stake Tier, Stake Visibility, Resolution Window, Cut Count, Irreversibility, Identity Proximity, Recognized Danger, Family Bonus, **Novelty**) + 1,500 theorized mechanisms scored against the formula.
- **③ Riddle Frames** — 30 logical-puzzle templates (constraint, forbidden, numerical, time, budget, paradox, lateral, bio-mimicry, etc.) + a combinatorial generator.
- **④ Underlying Principles** — 30 named scientific / engineering principles extracted from your videos posted in the last 3 years. Reciprocal structures, non-Newtonian fluid behavior, Hooke's law, thermal expansion, mechanical advantage, etc.

Click any tab above to dig in.`;

function httpJson(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            method, hostname: 'localhost', port: 8002, path,
            headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 }
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${d.slice(0,400)}`));
                try { resolve(JSON.parse(d)); } catch { resolve(d); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    // Build tabs from desktop docs
    const tabs = [{ title: '★ Overview', body: OVERVIEW }];
    for (const d of DOCS) {
        const p = `${DESKTOP}/${d.file}`;
        if (!fs.existsSync(p)) {
            console.error(`Missing: ${p}`);
            continue;
        }
        const body = fs.readFileSync(p, 'utf8');
        tabs.push({ title: d.title, body });
        console.log(`Loaded ${d.title}: ${body.length} bytes`);
    }

    // Check if a "Da Vinci Stack" note already exists; replace if so
    const existing = await httpJson('GET', '/api/data/notes');
    const prior = existing.find(n => (n.title || '').toLowerCase().includes('da vinci stack'));
    if (prior) {
        console.log(`Updating existing note ${prior.id}...`);
        const updated = await httpJson('PATCH', `/api/data/notes/${prior.id}`, {
            title: 'The Da Vinci Stack',
            tabs,
            pinned: true,
            body: '',
            lastEdited: new Date().toISOString()
        });
        console.log('Updated:', updated.id);
        return;
    }

    console.log('Creating new note...');
    const note = await httpJson('POST', '/api/data/notes', {
        title: 'The Da Vinci Stack',
        body: '',  // Body unused for tabbed notes
        tabs,
        pinned: true,
        linkedProject: '',
        linkedIdeaId: '',
        lastEdited: new Date().toISOString()
    });
    console.log('Created:', note.id);
    console.log('Tabs:', note.tabs?.length);
    const totalBytes = tabs.reduce((s, t) => s + (t.body?.length || 0), 0);
    console.log('Total body bytes across tabs:', totalBytes.toLocaleString());
})().catch(e => { console.error(e); process.exit(1); });
