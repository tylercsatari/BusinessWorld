# Da Vinci Stack — Idea Generation Framework

> *This file is the durable spec for "what makes a Tyler Csatari Da Vinci Stack video idea valid." Any future session — including ones with no prior context — can read this file and produce more compliant ideas. Run `node _generate_more_ideas.js --count N --apply` to produce N more on top of the existing set.*

---

## Source documents (on desktop)

- **Doc 1** — `1 — VFX Placeholders.md` (1,000 placeholder mechanisms across 40 families)
- **Doc 2** — `2 — Visual Open Loops.md` (253 verified examples + 9-indicator Zeigarnik formula + 1,500 theorized)
- **Doc 3** — `3 — Riddle Frames.md` (30 logical-puzzle templates)
- **Doc 4** — `4 — Underlying Principles.md` (1,998 atomic named principles from Tyler's last-3-yr videos)
- **Doc 5** — `5 — Logical Alignment.md` (13-indicator score, v2 with material constraints)

A valid idea stacks all of Docs 1+2+3+4 and scores well on both Doc 2's formula and Doc 5's formula.

---

## The 4-layer stack

| Layer | What it does | Doc |
|---|---|---|
| ① VFX Placeholder | The on-set hack that makes the dangerous shot filmable | Doc 1 |
| ② Visual Open Loop | What the viewer sees in the first 1.5s — the Zeigarnik trigger | Doc 2 |
| ③ Riddle Frame | The puzzle structure the viewer is solving | Doc 3 |
| ④ Underlying Principle | The named scientific principle the answer relies on (from Tyler's catalog) | Doc 4 |

---

## The two scoring formulas — both must clear

### Logical Alignment v2 (Doc 5) — max 34

13 indicators. Threshold: **≥27** to ship. Most important:

- **Construction Test**: could a thoughtful viewer derive the principle's solution from only the visible materials + constraints? If no, kill the idea.
- **Material Plausibility** (0–3): materials must be plausibly at the scene (no magnet boots in a pipe).
- **Material Sufficiency** (0–3): the principle must be hand-constructible from the listed materials.
- **Material Visibility** (0–3): materials shown in opening frame.
- **Riddle Solvability** (0–3): the riddle must be derivable, not arbitrary.

Plus the original 9 indicators (Obvious Elimination, Solution Space, Principle Convergence, Reality Check, Non-Obvious Reveal, Category Recognition, Past Video Callback, Not Binary, Constraint Realism).

### Zeigarnik (Doc 2) — max ~23

9 indicators. Threshold: **≥19** to ship. Key drivers:

- **Stake Tier** (0–6): mortal stakes dominate viral lists.
- **Single Shot** (Cut Count): one continuous take to resolution > multi-cut.
- **Novelty** (0–2): an unprecedented pairing / object / scale.
- **Recognized Danger**: viewer identifies the threat in 0.5s without exposition.

---

## The hard rule (from the user, recorded here)

> *"The riddle has to be like the Da Vinci Bridge: the whole scene and all the materials are laid out in front of you. The viewer mentally solves the riddle as you explain it. The materials in the scene combine into the solution. You don't whip out a pre-built magnet boot — the solution emerges from what's visible."*

If a future idea's solution requires materials that weren't in the opening shot, it fails. Period.

---

## Past videos and their constructible principles

The full mapping is in `past_videos.json`. Summary:

| Principle family | Tyler video (views) | Natural materials |
|---|---|---|
| Non-Newtonian shear-thickening | Indestructible Shoes (34M), Indestructible Egg (550M) | cornstarch + water + cloth |
| Mechanical advantage (pulley/lever) | Strength Arm "Make Me Lift" (30M) | rope + sticks + rocks + anchor |
| Composite layering | Bulletproof Batman Armour (80M), Indestructible Armour (285M) | newspaper/cardboard + tape |
| Thermal insulation organic | Fireproof Shield (62M), Halloween costume (75M) | green leaves + mud + bark |
| Spring elastic return | 3D Basketball Shoes (2M) | bouncy balls + plywood + tubes |
| Buoyancy / displacement | (adjacent only) | sealed bottles + lashing |
| Catenary / tensile geometry | Da Vinci Bridge (3M+) — used once, don't reuse identically | rope + chain |
| Friction heat / ignition | (adjacent — Fireproof) | dry wood + spindle |
| Triboelectric static | (adjacent) | wool + balloon + dry tinder |
| Resonance acoustic | (adjacent) | voice / object + tuning element |
| Centripetal / centrifugal | (adjacent) | rope + weight |
| Siphon / fluid dynamics | (adjacent) | tube + height difference |
| Balance / center of mass | Magnet Shoes (55M, adjacent — kick-out) | weighted objects + lever |
| Capillary action | (adjacent) | porous fiber + water |

**Rejected for riddle-use** (still good for tutorials): magnet boots, Vantablack, D3O foam, continuum robotics. These require specialty fabrication and fail Material Plausibility.

---

## Anatomy of a valid idea (the schema)

Every generated idea must have these fields filled:

\`\`\`json
{
  "id": "auto-assigned",
  "title": "<short ≤8 words>",
  "principle_family": "<one of the families above>",
  "principle_name": "<specific atomic name from Doc 4>",
  "past_video": { "title": "...", "ytId": "...", "views": <num> },

  "opening_scene": "<vivid description: who, where, what's visible — frame 0>",
  "materials_visible": ["<list of materials in the opening shot>"],
  "goal": "<the one-sentence need>",
  "constraints": ["<list — each constraint must eliminate at least one default solution>"],
  "default_solutions_eliminated": [
    { "solution": "<what someone would normally try>", "why_eliminated": "<which constraint blocks it>" }
  ],
  "principle_solution": "<how the visible materials combine to invoke the principle>",
  "hook_line": "<the actual spoken first line of the video — must reference 'just like I did with [past_video]'>",

  "stake_tier": <0-6>,
  "stake_visibility": <0-3>,
  "resolution_window_sec": <3-60>,
  "single_shot": <true|false>,
  "irreversibility": <0-2>,
  "identity_proximity": <0-3>,
  "recognized_danger": <0-1>,
  "novelty": <0-2>,
  "family_bonus_eligible": <true|false>,

  "obvious_elimination": <0-3>,
  "solution_space": <0-3>,
  "principle_convergence": <0-3>,
  "reality_check": <0-3>,
  "non_obvious_reveal": <0-3>,
  "category_recognition": <0-2>,
  "past_video_callback": <0-2>,
  "not_binary": <0-1>,
  "constraint_realism": <0-2>,
  "material_plausibility": <0-3>,
  "material_sufficiency": <0-3>,
  "material_visibility": <0-3>,
  "riddle_solvability": <0-3>,

  "vfx_placeholder_family": "<one or more Family letters from Doc 1>",
  "vfx_notes": "<how to film safely>"
}
\`\`\`

---

## Scoring functions (computed automatically by the generator)

\`\`\`
ZeigarnikScore = (stake_tier × 1.5)
               + stake_visibility
               + min(3, floor((30 - resolution_window_sec) / 7))   // window inverse, capped
               + (single_shot ? 2 : 0)
               + irreversibility
               + (identity_proximity × 0.7)
               + recognized_danger
               + (family_bonus_eligible ? 1 : 0)
               + novelty

LogicalAlignment_v2 = obvious_elimination
                    + solution_space
                    + principle_convergence
                    + reality_check
                    + non_obvious_reveal
                    + category_recognition
                    + past_video_callback
                    + not_binary
                    + constraint_realism
                    + material_plausibility
                    + material_sufficiency
                    + material_visibility
                    + riddle_solvability
\`\`\`

### Pass thresholds

- Zeigarnik ≥ 19
- Logical Alignment v2 ≥ 27

If either fails, the idea is filtered out and replaced.

---

## How to generate more

\`\`\`bash
cd /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld
node _generate_more_ideas.js --count 50 --apply
\`\`\`

- Reads the current note "Da Vinci Stack — 100 Aligned Video Ideas" via the running server.
- Reads `past_videos.json` to know which principles are constructible.
- Reads existing idea titles (dedup).
- Calls gpt-4o-mini with the prompt encoded in this framework.
- Auto-scores every candidate.
- Filters out anything that doesn't clear both thresholds.
- Filters out duplicates by title.
- Generates more until `count` is hit OR 3x the count is attempted (safety).
- Appends to the existing tabbed note, grouped by principle family.

Omit \`--apply\` to do a dry run that just prints.

---

## Failure modes (always check before accepting an idea)

1. Solution uses pre-built specialty hardware (magnet boots, Vantablack, D3O) → Material Plausibility = 0 → reject.
2. Solution materials aren't visible in opening frame → Material Visibility = 0 → reject.
3. Riddle phrased as "would you?" → Not Binary = 0 → reject.
4. Principle wouldn't physically work in the constrained scenario → Reality Check = 0 → reject.
5. Default solutions aren't actually eliminated by the constraints → Obvious Elimination low → reject.
6. The principle doesn't match Tyler's past video catalog → Past Video Callback = 0 → reject.
7. Multiple valid solutions remain → Solution Space < 3 → flag for review.
8. Riddle is too obvious (viewer guesses in 3s) → Non-Obvious Reveal low → consider tightening.

---

## File layout in this kit

\`\`\`
buildings/library/generation_kit/
├── idea_framework.md         ← THIS FILE — the spec
├── past_videos.json          ← principle → video → constructibility mapping
├── _generate_more_ideas.js   ← the runner (at project root for easy invocation)
└── ideas.json                ← all currently-shipped ideas (the running set)
\`\`\`
