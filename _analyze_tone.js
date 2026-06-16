/**
 * _analyze_tone.js — derive ranked tone/writing principles + the visual↔dialogue
 * relationship by analyzing every posted video (transcript + swipe ratio), then
 * write them into knowledge files the hook engine reads.
 *
 *   node -r dotenv/config _analyze_tone.js
 *
 * Outputs: buildings/jarvis/hook-tone-principles.json
 *          buildings/jarvis/visual-dialogue-insights.json
 */
const fs = require('fs'), path = require('path');

function ex(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) {}
    const i = text.indexOf('{'); if (i < 0) return null;
    let d = 0, s = false, e = false;
    for (let k = i; k < text.length; k++) { const c = text[k];
        if (s) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') s = false; }
        else if (c === '"') s = true; else if (c === '{') d++; else if (c === '}') { if (--d === 0) { try { return JSON.parse(text.slice(i, k + 1)); } catch (x) { return null; } } } }
    return null;
}
async function kimi(messages, maxTok) {
    const r = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.FIREWORKS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'accounts/fireworks/models/kimi-k2p6', messages, temperature: 0.3, max_tokens: maxTok || 22000 })
    });
    if (!r.ok) throw new Error('fireworks ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return ex((await r.json()).choices?.[0]?.message?.content);
}

function buildDataset() {
    const tg = JSON.parse(fs.readFileSync('buildings/jarvis/qrd/qrd_targets.json', 'utf8'));
    const base = 'video_data';
    const dirs = fs.readdirSync(base).filter(d => fs.existsSync(path.join(base, d, 'analysis.json')));
    const vids = [];
    for (const d of dirs) {
        try {
            const a = JSON.parse(fs.readFileSync(path.join(base, d, 'analysis.json'), 'utf8'));
            const id = a.videoId || d; const t = (a.transcript || {}).fullText || '';
            const sw = tg[id] && typeof tg[id].swipe === 'number' ? tg[id].swipe : null;
            if (!t || t.length < 120 || sw == null) continue;
            vids.push({ id, title: ((a.metadata || {}).title || '').slice(0, 100), swipe: sw, opening: t.slice(0, 380).replace(/\s+/g, ' '), mid: t.slice(Math.floor(t.length / 2), Math.floor(t.length / 2) + 300).replace(/\s+/g, ' ') });
        } catch (e) {}
    }
    vids.sort((a, b) => a.swipe - b.swipe);
    return vids;
}

async function main() {
    if (!process.env.FIREWORKS_API_KEY) { console.error('Need FIREWORKS_API_KEY'); process.exit(1); }
    const vids = buildDataset();
    console.log('analyzable videos (transcript + swipe):', vids.length);
    const best = vids.slice(0, 45);
    const worst = vids.slice(-30);

    // ---- 1) 50 ranked tone / writing principles (contrastive) ----
    console.log('Deriving 50 ranked tone/writing principles...');
    const fmt = v => `[swipe ${v.swipe}%] "${v.title}"\n   HOOK: ${v.opening}\n   MID: ${v.mid}`;
    const sys1 = `You are a viral-video analyst. You are given this maker/experiment channel's BEST-retained videos (lowest swipe-away %) and WORST-retained videos, each with the opening (hook) and a mid-script sample. Find what the best ones DO with TONE and WRITING that the worst ones don't — for both hooks and scripts.`;
    const user1 = `BEST-RETAINED (these keep viewers):\n${best.map(fmt).join('\n\n')}\n\nWORST-RETAINED (these get swiped):\n${worst.map(fmt).join('\n\n')}\n\nDerive 50 OPERATIONALIZED tone/writing principles that make this channel's hooks and scripts go viral — concrete and actionable (a writer could follow each), drawn from what separates best from worst. Rank by importance (how strongly it separates best from worst). Output ONLY JSON:\n{"principles":[{"rank":1,"name":"short name","how":"the operational rule a writer follows","why":"why it cuts swipe / holds retention","applies":"hook | script | both"}]}\nExactly 50, ranked 1 (most important) to 50.`;
    let tone = null;
    try { tone = await kimi([{ role: 'system', content: sys1 }, { role: 'user', content: user1 }]); } catch (e) { console.error('tone call failed', e.message); }
    const principles = (tone && Array.isArray(tone.principles)) ? tone.principles.slice(0, 50) : [];
    fs.writeFileSync('buildings/jarvis/hook-tone-principles.json', JSON.stringify({ generated: new Date().toISOString().slice(0, 10), nVideos: vids.length, principles }, null, 1));
    console.log('  wrote', principles.length, 'tone principles');

    // ---- 2) visual ↔ dialogue relationship at high-retention moments ----
    console.log('Analyzing visual↔dialogue on high-swipe videos...');
    let lib = {}; try { lib = JSON.parse(fs.readFileSync('buildings/jarvis/retention-event-library.json', 'utf8')); } catch (e) {}
    const swById = Object.fromEntries(vids.map(v => [v.id, v.swipe]));
    const moments = [];
    for (const v of Object.values(lib.videos || {})) {
        const sw = swById[v.ytId]; if (sw == null || sw > 5) continue;   // only well-retained videos
        for (const ev of (v.events || [])) {
            if (ev.type !== 'peak' || !ev.frame_description) continue;
            const words = (ev.words_spoken || []).filter(w => !/^\[/.test(w)).join(' ');
            if (words.length < 8) continue;
            moments.push({ swipe: sw, said: words.slice(0, 120), shown: (ev.frame_description || '').slice(0, 150) });
        }
    }
    moments.sort((a, b) => a.swipe - b.swipe);
    const sample = moments.slice(0, 40);
    const sys2 = `You analyze the relationship between what is SAID and what is SHOWN at the highest-retention moments of top-performing videos.`;
    const user2 = `At these high-retention peak moments (from low-swipe videos), here is what was SAID and what was SHOWN on screen:\n${sample.map(m => `• SAID: "${m.said}"  |  SHOWN: ${m.shown}`).join('\n')}\n\nDerive the principles of how visuals and dialogue RELATE at moments that hold viewers — does the visual show what's said, contradict it, get ahead of it, reveal it a beat late? Be specific and operational for a creator writing a hook (line + visual together). Output ONLY JSON:\n{"insights":[{"name":"short","rule":"operational rule for pairing line + visual","why":"why it holds retention"}]}\n12-18 insights.`;
    let vd = null;
    try { vd = await kimi([{ role: 'system', content: sys2 }, { role: 'user', content: user2 }], 12000); } catch (e) { console.error('visual-dialogue call failed', e.message); }
    const insights = (vd && Array.isArray(vd.insights)) ? vd.insights : [];
    fs.writeFileSync('buildings/jarvis/visual-dialogue-insights.json', JSON.stringify({ generated: new Date().toISOString().slice(0, 10), nMoments: moments.length, insights }, null, 1));
    console.log('  wrote', insights.length, 'visual-dialogue insights');
    console.log('DONE');
}
main().catch(e => console.error('FAILED', e.message));
