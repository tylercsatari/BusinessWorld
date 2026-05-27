#!/usr/bin/env node
// Cluster via two-step: LLM defines meta-principles, then embeddings assign each input.

const fs = require('fs');
const http = require('http');

const ROOT = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld';
const JSON_PATH = ROOT + '/buildings/library/frameworks/04-underlying-principles.json';
const META_PATH = ROOT + '/buildings/library/frameworks/04-underlying-principles.meta.json';
const DESKTOP_MD = '/Users/tylercsatari/Desktop/4 — Underlying Principles.md';

function httpJson(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            method, hostname: 'localhost', port: 8002, path,
            headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 }
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${d.slice(0, 400)}`));
                try { resolve(JSON.parse(d)); } catch { resolve(d); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function cosSim(a, b) {
    let d = 0, an = 0, bn = 0;
    for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; an += a[i]*a[i]; bn += b[i]*b[i]; }
    return d / (Math.sqrt(an) * Math.sqrt(bn));
}

async function embed(input) {
    const r = await httpJson('POST', '/api/openai/embeddings', {
        model: 'text-embedding-3-small',
        input,
        dimensions: 512
    });
    return r.data.map(x => x.embedding);
}

(async () => {
    const records = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    const ok = records.filter(r => !r.error && r.principles && r.principles.length);

    const flat = [];
    for (const r of ok) for (const p of r.principles) {
        flat.push({
            name: p.name,
            category: p.category || 'other',
            explanation: p.explanation || '',
            where: p.where_in_video || '',
            ytId: r.ytId,
            title: r.title,
            views: r.views || 0,
            uploadDate: r.uploadDate || ''
        });
    }
    console.log(`Instances to cluster: ${flat.length}`);

    // Step 1 — ask LLM to define ~40 meta-principles from the corpus
    const compact = flat.map((p, i) => `${i}|${p.name}|${p.category}|${p.explanation}`).join('\n');
    const messages = [
        { role: 'system', content:
`Given a list of extracted scientific/engineering principles (one per line: index|name|category|explanation), define 30-50 distinct META-principles that COVER the corpus.

KEEP textbook-named principles like "non-Newtonian fluid behavior", "reciprocal structures", "Hooke's law", "Van der Waals forces", "thermal expansion", "Henry's law", "vantablack absorption".

You may merge near-synonyms ("composite layering" + "cross-grain lamination" → "composite layering").

Flag the very vague entries ("3d printing", "lightweight materials", "iterative design", "energy efficiency") as the DROP list — but only the truly generic ones, not anything with a specific physical mechanism.

Output strict JSON:
{
  "meta_principles": [
    {"id":"MP01", "name":"<≤5 words>", "category":"mechanics|materials|fluids|optics|acoustics|chemistry|thermodynamics|electromagnetism|biology|structural|other", "explanation":"<1 sentence>", "transfer":"<1 sentence — how to re-skin>"}
  ],
  "drop_phrases": ["<specific input names that are too generic to count as principles>"]
}` },
        { role: 'user', content: compact }
    ];

    console.log('Step 1: defining meta-principles...');
    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.1,
        max_tokens: 8000,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text);
    const meta = parsed.meta_principles || [];
    const dropPhrases = new Set((parsed.drop_phrases || []).map(s => s.toLowerCase().trim()));
    console.log(`Meta-principles defined: ${meta.length}. Drop phrases: ${dropPhrases.size}`);

    // Step 2 — embed everything and assign each flat[i] to nearest meta
    console.log('Step 2: embedding meta-principles...');
    const metaTexts = meta.map(m => `${m.name}. ${m.explanation}`);
    const metaEmb = await embed(metaTexts);

    console.log('Step 3: embedding flat principles (batched)...');
    const BATCH = 100;
    const flatEmb = [];
    for (let i = 0; i < flat.length; i += BATCH) {
        const batch = flat.slice(i, i + BATCH).map(p => `${p.name}. ${p.explanation}`);
        const out = await embed(batch);
        for (const e of out) flatEmb.push(e);
        console.log(`  embedded ${flatEmb.length}/${flat.length}`);
    }

    // Assign
    console.log('Step 4: assigning...');
    const items = flat.map((p, i) => {
        const lower = p.name.toLowerCase().trim();
        if (dropPhrases.has(lower)) return { ...p, metaId: null, dropped: true };
        let bestIdx = -1, bestS = -2;
        for (let j = 0; j < metaEmb.length; j++) {
            const s = cosSim(flatEmb[i], metaEmb[j]);
            if (s > bestS) { bestS = s; bestIdx = j; }
        }
        return { ...p, metaId: meta[bestIdx]?.id || null, similarity: bestS, dropped: false };
    });

    const byMeta = {};
    let dropped = 0;
    for (const it of items) {
        if (it.dropped) { dropped++; continue; }
        (byMeta[it.metaId] = byMeta[it.metaId] || []).push(it);
    }
    console.log(`Assigned: ${flat.length - dropped}. Dropped: ${dropped}`);

    // Filter out empty metas
    const usedMeta = meta.filter(m => (byMeta[m.id]?.length || 0) > 0);
    usedMeta.sort((a, b) => (byMeta[b.id]?.length || 0) - (byMeta[a.id]?.length || 0));

    fs.writeFileSync(META_PATH, JSON.stringify({ meta: usedMeta, byMeta }, null, 2));

    // Render markdown
    let md = `# Doc 4 — Underlying Principles\n\n`;
    md += `> *The deep, named, transferable scientific/engineering principles that your builds actually exploit. Not "iterative design" — actual physics. The Da Vinci Bridge demonstrates **reciprocal structures**. The Indestructible Egg demonstrates **non-Newtonian fluid behavior**. These are the patterns we want to multiply.*\n\n`;
    md += `**Source:** all videos posted on your channel since 2023-05-27. Auto-extracted, then clustered with embeddings.\n\n`;
    md += `- Videos in last 3 yrs: **${records.length}**\n`;
    md += `- Videos with a real technical principle: **${ok.length}** *(the rest are pure endurance/challenge with no engineering payload)*\n`;
    md += `- Principle instances extracted: **${flat.length}**\n`;
    md += `- Distinct meta-principles after clustering: **${usedMeta.length}**\n`;
    md += `- Generic entries dropped: **${dropped}**\n\n`;
    md += `---\n\n`;
    md += `## How to use this\n\n`;
    md += `1. **Scan the list below** — these are the principles already driving your channel.\n`;
    md += `2. **Look at the under-used ones** (low count) — those are open lanes for fresh videos.\n`;
    md += `3. **Pick a principle, use the transfer idea**, then pair with Doc 1 (placeholder), Doc 2 (open loop), Doc 3 (riddle).\n\n`;
    md += `---\n\n`;
    md += `## All meta-principles (most-exploited first)\n\n`;

    let n = 1;
    for (const m of usedMeta) {
        const list = byMeta[m.id] || [];
        list.sort((a, b) => (b.views || 0) - (a.views || 0));
        md += `### ${n++}. ${m.name}\n`;
        md += `*${m.category}* · used in **${list.length}** videos in the last 3 years\n\n`;
        md += `**Principle.** ${m.explanation}\n\n`;
        md += `**Transfer idea.** ${m.transfer}\n\n`;
        md += `**Already exploited in:**\n`;
        for (const v of list.slice(0, 10)) {
            const views = v.views ? ` — ${(v.views / 1000000).toFixed(1)}M views` : '';
            md += `- [${v.title}](https://youtu.be/${v.ytId})${views}\n`;
            if (v.where) md += `  *${v.where}*\n`;
        }
        if (list.length > 10) md += `- *…and ${list.length - 10} more*\n`;
        md += `\n`;
    }

    // Category breakdown
    const catCounts = {};
    for (const m of usedMeta) catCounts[m.category] = (catCounts[m.category] || 0) + (byMeta[m.id]?.length || 0);
    md += `---\n\n## Domain distribution\n\n`;
    md += `| Category | Times exploited in last 3 yrs |\n|---|---|\n`;
    for (const k of Object.keys(catCounts).sort((a,b)=>catCounts[b]-catCounts[a])) md += `| ${k} | ${catCounts[k]} |\n`;
    md += `\n`;

    md += `---\n\n## How this stacks with Docs 1, 2, 3\n\n`;
    md += `Best videos pair all four:\n`;
    md += `- **Doc 1 (Placeholder)** — the on-set hack\n`;
    md += `- **Doc 2 (Open Loop)** — the 1.5-second visual\n`;
    md += `- **Doc 3 (Riddle)** — the puzzle frame\n`;
    md += `- **Doc 4 (Principle, this doc)** — the deep physical idea the answer relies on\n\n`;
    md += `**Da Vinci Bridge** stacked all four:\n`;
    md += `- Doc 1: duct-tape on grass + CGI canyon in inset\n`;
    md += `- Doc 2: Tyler at the cliff (T6.A mortal-stake visual)\n`;
    md += `- Doc 3: R1 constraint puzzle (cross water + no fasteners)\n`;
    md += `- Doc 4: **reciprocal structures** (mutual self-support geometry — every stick holds the others)\n\n`;
    md += `---\n\n`;
    md += `*Source data:* \`buildings/library/frameworks/04-underlying-principles.json\` · *Clustering:* \`buildings/library/frameworks/04-underlying-principles.meta.json\`\n`;

    fs.writeFileSync(DESKTOP_MD, md);
    console.log('Wrote', DESKTOP_MD);
})().catch(e => { console.error(e); process.exit(1); });
