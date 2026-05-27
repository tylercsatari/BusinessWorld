#!/usr/bin/env node
// Render a user-friendly version of doc 4 to ~/Desktop.
const fs = require('fs');
const ROOT = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld';
const meta = JSON.parse(fs.readFileSync(ROOT + '/buildings/library/frameworks/04-underlying-principles.meta.json', 'utf8'));
const records = JSON.parse(fs.readFileSync(ROOT + '/buildings/library/frameworks/04-underlying-principles.json', 'utf8'));

const ok = records.filter(r => !r.error && r.principles && r.principles.length);
const totalVideos = ok.length;
const totalInstances = ok.reduce((n, r) => n + r.principles.length, 0);

let md = '';
md += `# Hook Playbook 4 — Your Channel's Underlying Principles\n\n`;
md += `> *Every viral video on your channel is a re-skin of one of these principles. Build a new video by picking a principle below + a fresh riddle frame + a fresh visual + a fresh stake.*\n\n`;
md += `Source: ${totalVideos} of your videos (with full transcripts on disk) auto-analyzed with gpt-4o-mini, then clustered into the **${meta.meta.length} distinct meta-principles below**.\n\n`;
md += `---\n\n`;
md += `## How to use this in 60 seconds\n\n`;
md += `1. **Scan the top 20** below — these are the ideas that already work on your audience.\n`;
md += `2. **Pick one** that you haven't shot in 3+ months.\n`;
md += `3. **Use the transfer template** to re-skin it onto a new topic/build/test.\n`;
md += `4. **Stack it** with a Visual (Playbook 1), a Zeigarnik (Playbook 2), and a Riddle frame (Playbook 3).\n\n`;
md += `---\n\n`;
md += `## All ${meta.meta.length} meta-principles (most-used first)\n\n`;

const all = meta.meta;
// Sort by usage count (which is byMeta[id].length, but the JSON stores it as a separate object)
const byMeta = meta.byMeta || {};
all.sort((a, b) => (byMeta[b.id]?.length || 0) - (byMeta[a.id]?.length || 0));

let idx = 1;
for (const m of all) {
    const usage = byMeta[m.id] || [];
    usage.sort((a, b) => (b.views || 0) - (a.views || 0));
    const top3 = usage.slice(0, 3);
    md += `### ${idx++}. ${m.name}\n`;
    md += `*${m.domain}* · used in **${usage.length}** of your videos\n\n`;
    md += `**Principle.** ${m.explanation}\n\n`;
    md += `**Transfer template.** ${m.transfer_template}\n\n`;
    if (top3.length) {
        md += `**Already used in:**\n`;
        for (const v of top3) {
            const viewsLabel = v.views ? ((v.views / 1000000).toFixed(1) + 'M views') : '';
            md += `- [${v.title}](https://youtu.be/${v.ytId})${viewsLabel ? ' — ' + viewsLabel : ''}\n`;
        }
        if (usage.length > 3) md += `- *…and ${usage.length - 3} more*\n`;
        md += `\n`;
    }
}

md += `---\n\n`;
md += `## Domain breakdown\n\n`;
const domainCounts = {};
for (const m of all) {
    const u = (byMeta[m.id] || []).length;
    domainCounts[m.domain] = (domainCounts[m.domain] || 0) + u;
}
const sortedDomains = Object.keys(domainCounts).sort((a, b) => domainCounts[b] - domainCounts[a]);
md += `| Domain | Times used across your videos |\n|---|---|\n`;
for (const d of sortedDomains) md += `| ${d} | ${domainCounts[d]} |\n`;
md += `\n`;

md += `**Read:** psychology dominates because your videos lean on endurance/challenge/exposure framings; engineering and materials are the next big anchors (the builds themselves); narrative is the editing layer that makes the principle land. \n\nWhen brainstorming next videos, force yourself into under-used domains (perception, optics, chemistry, economics, game-theory) — these are open lanes.\n\n`;

md += `---\n\n`;
md += `## How this stacks with the other playbooks\n\n`;
md += `Best videos pair all four:\n`;
md += `- **Playbook 1 (Visual)**: what does the viewer see in the first 1.5 seconds?\n`;
md += `- **Playbook 2 (Zeigarnik)**: what unresolved loop opens in the first 3 seconds?\n`;
md += `- **Playbook 3 (Riddle)**: what puzzle is the viewer solving until 0:25?\n`;
md += `- **Playbook 4 (Principle, this doc)**: what transferable idea does the video teach?\n\n`;
md += `**Da Vinci Bridge** stacked all four:\n`;
md += `- Visual: split-screen cliff (Playbook 1 — Family A corner-overlay)\n`;
md += `- Zeigarnik: "If you were at a cliff with only short sticks…" (Playbook 2 — Z16 + Z20)\n`;
md += `- Riddle: cross water + no fasteners (Playbook 3 — R1 constraint puzzle)\n`;
md += `- Principle: reciprocal structures / mutual-support geometry (Playbook 4 — closest match: "Material Strength and Design")\n\n`;
md += `---\n\n`;
md += `## Combinatorial generator (the "infinite videos" workflow)\n\n`;
md += `Stack one row from each column. Every row × every other row = a new video idea.\n\n`;
md += `| Visual (Playbook 1) | Zeigarnik (Playbook 2) | Riddle (Playbook 3) | Principle (this doc) |\n`;
md += `|---|---|---|---|\n`;
md += `| Corner-Overlay Reveal (A) | Approaching threshold (Z1) | Constraint puzzle (R1) | #1 — ${all[0]?.name || ''} |\n`;
md += `| Sketch → Build (B) | Falling object (Z2) | Forbidden move (R2) | #2 — ${all[1]?.name || ''} |\n`;
md += `| Time-Lapse Build (C) | Spinning fate (Z3) | Numerical constraint (R3) | #3 — ${all[2]?.name || ''} |\n`;
md += `| Reverse Reveal (D) | Approaching collision (Z4) | Time constraint (R4) | #4 — ${all[3]?.name || ''} |\n`;
md += `| Materials → Object (E) | Opening container (Z5) | Budget constraint (R5) | #5 — ${all[4]?.name || ''} |\n`;
md += `| Scale-Shift (F) | Cliff / edge (Z6) | Logical paradox (R6) | #6 — ${all[5]?.name || ''} |\n`;
md += `| Layered Suit-Up (G) | Casino / probability (Z7) | Wrong-order (R7) | #7 — ${all[6]?.name || ''} |\n`;
md += `| Mine vs Theirs (H) | Suspended subject (Z8) | 1000 yrs ago (R8) | #8 — ${all[7]?.name || ''} |\n`;
md += `| Failed → Succeeded (I) | Off-frame object (Z9) | Made from trash (R9) | #9 — ${all[8]?.name || ''} |\n`;
md += `| Hidden → Revealed (J) | Verbal open loop (Z10) | Beat the expert (R10) | #10 — ${all[9]?.name || ''} |\n`;
md += `\n`;
md += `Tons more rows in each playbook. Use this table as the starting matrix.\n\n`;
md += `---\n\n`;
md += `> Full per-video breakdown (471 KB): \`BusinessHub/BusinessWorld/buildings/library/frameworks/04-underlying-principles.md\`\n`;
md += `> Raw JSON for tooling: \`buildings/library/frameworks/04-underlying-principles.json\`\n`;

fs.writeFileSync('/Users/tylercsatari/Desktop/Hook Playbook 4 — Underlying Principles.md', md);
console.log('Wrote', '/Users/tylercsatari/Desktop/Hook Playbook 4 — Underlying Principles.md');
console.log('Meta-principles included:', all.length);
console.log('Total video instances summarized:', totalInstances);
