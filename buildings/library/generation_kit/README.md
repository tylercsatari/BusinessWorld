# Da Vinci Stack — Idea Generation Kit

Everything needed to generate more "parallel-asset architecture" video ideas — the same
pipeline that produced the **100 reciprocal-bridge ideas** in the pinned Library note
(_"Da Vinci Stack — 100 Video Ideas"_).

## The architecture (what makes these ideas work)

The thing Tyler **builds** in the video is a **parallel asset** — a famous-or-novel scientific
demonstration (like the Da Vinci self-supporting bridge) that happens to share its underlying
physical principle with one of Tyler's past videos. The viewer does **not** know the connection
until the **SECRET REVEAL** at the end:

> "What you didn't realize — this is the EXACT same principle I used to build my [past video]."

This is NOT a rebuild of a past video. It's a new demonstration whose *mechanism* matches a past
video's mechanism.

## Files in this kit

| File | What it is |
|------|-----------|
| `parallel_assets.json` | Catalog of **1,000** candidate parallel assets (name, principle, description, wow_factor, loosely-tagged Tyler principle family). |
| `past_videos.json` | Tyler's past videos grouped by **principle family** (`constructible` = invokable from natural materials; `rejected` = can't be). Each family lists the demonstrated principles + natural materials. |
| `ideas.json` | The **100 generated ideas** (first 5 are hand-picked exemplars that set the quality bar). The generator appends here. |
| `idea_framework.md` | The underlying framework doc (Zeigarnik stakes, riddle structure, constructibility test). |

## How to generate more

Run from the **repo root** (the generator resolves the kit path relative to its own location):

```bash
# dry run — 3 ideas, prints results, writes nothing
node _generate_ideas_v3.js

# generate N ideas, append to ideas.json, regenerate the live Library note
node _generate_ideas_v3.js --count 20 --apply
```

`--apply` requires the local server running (`node server.js`) — it deletes the prior
`Da Vinci Stack — …` note and recreates it via `/api/data/notes`, so the Library always shows
the full current set.

## The 6-step pipeline (per idea)

1. **Zeigarnik scenario** — a high-stakes survival/escape situation with a mortal stake.
2. **Problem** — the one-sentence goal the protagonist must solve.
3. **Pick a parallel asset** — the LLM chooses from a 12-asset slate whose principle physically
   solves the problem.
4. **Principle match** — verify the asset's mechanism matches a Tyler past-video principle family
   (judged on a 0–3 `principle_convergence` scale).
5. **Constructibility** — the materials scene is built so the asset is hand-buildable from
   materials *visible at frame 0*.
6. **Secret reveal line** — the end-of-video punchline tying the asset's principle to the past
   video. (The hook line must NOT leak the past-video reference — it's reserved for the reveal.)

## Quality gates (in `_generate_ideas_v3.js`)

- Hook line auto-fails if it leaks a past-video reference (must live only in `secret_reveal_line`).
- `secret_reveal_line` must be non-empty.
- gpt-4o judge scores Zeigarnik + Limited-Answer dimensions; score floor gate
  (`la ≥ 22, zei ≥ 16, principle_convergence ≥ 1`) catches lenient PASSes.
- Dedupes against existing titles and used assets.

## Note structure

The live note is **sub-tabbed**: each outer tab = one principle family, each inner sub-tab = one
idea. In the Library, the tab picker is a collapsible left sidebar (outer tabs vertical, sub-tabs
nested beneath the active one).
