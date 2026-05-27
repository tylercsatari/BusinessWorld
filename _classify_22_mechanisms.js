#!/usr/bin/env node
// Re-classify all 2,279 local shorts against the user's 22 specific Zeigarnik mechanisms.

const fs = require('fs');
const http = require('http');

const DB = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/shorts-db.json';
const OUT = '/tmp/shorts_22mech_classified.json';
const LOG = '/tmp/shorts_22mech.log';

const BATCH = 40;
const CONCURRENCY = 8;

function log(line) {
    const msg = `[${new Date().toISOString()}] ${line}`;
    console.log(msg); fs.appendFileSync(LOG, msg + '\n');
}
function httpJson(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            method, hostname: 'localhost', port: 8002, path,
            headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 }
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${d.slice(0,300)}`));
                try { resolve(JSON.parse(d)); } catch { resolve(d); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const SYS = `Classify viral YouTube Short titles against 22 specific Zeigarnik mechanisms.

THE 22 MECHANISMS:
1. car_hold — holding up a car while someone is trapped underneath
2. fuse_light — lighting a fuse on a device (novelty is the device)
3. giant_switch — pulling a giant switch (novelty on switch)
4. giant_button — pressing a giant button (novelty on button)
5. speeding_object — large speeding object (car/train) moving toward subject
6. bat_at_head — weapon being swung at someone's head (novelty on helmet OR weapon)
7. hanging_high — hanging from a really high place
8. drop_from_high — dropping an object from a very high place
9. launcher — loading and shooting a launcher (novelty on launcher and payload)
10. sword_slo_mo — slow-motion sword cutting through something
11. balloon_slo_mo — large balloon overhead being popped in slow motion
12. bear_trap — activating a bear trap then walking toward another (credibility test)
13. opening_box — opening a large box / container (novelty on the box)
14. blindfolded_extreme — blindfolded in an extreme environment (volcano, bungee, cliff)
15. beaker — holding a dangerous-looking item with safety glasses, putting into beaker
16. tall_tower_extract — removing something from a really tall tower (Jenga-style)
17. rope_fray — hanging from rope while fraying it
18. linear_gear_switch — large linear/gear-rate mechanical switch
19. massive_pinata — massive piñata being broken
20. jar_pull — pulling a random thing out of a jar / bin
21. falling_massive — massive thing falling toward subject
22. wheel_spin — spinning wheel landing on something

Also consider:
- OTHER extreme Zeigarnik mechanisms not on the list — categorize as "other" with a brief mechanism_name

For each input (id|title):
{
  "id": <int>,
  "mechanism": "<one of the 22 names above, or 'other_<short_name>', or 'none'>",
  "novelty_element": "<what's novel — the device, the helmet, the box content, etc. — or empty>",
  "score": <0-10: confidence this title matches an extreme-Zeigarnik mechanism>
}

If you can't tell from the title (e.g. "Best Dance Moves"), set mechanism="none", score=0.

Output strict JSON: { "results": [...] }`;

async function classifyBatch(items) {
    const userMsg = items.map(it => `${it.idx}|${it.title}`).join('\n');
    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o-mini',
        messages: [{ role:'system', content:SYS }, { role:'user', content:userMsg }],
        temperature: 0.1,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
    const p = JSON.parse(text);
    return p.results || [];
}

(async () => {
    fs.writeFileSync(LOG, '');
    const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
    const videos = Object.values(db.videos).filter(v => v.title && v.videoId);
    log(`loaded ${videos.length} videos`);

    const indexed = videos.map((v, i) => ({ idx: i, videoId: v.videoId, title: v.title, views: v.views || 0, channelTitle: v.channelTitle || '' }));

    const batches = [];
    for (let i = 0; i < indexed.length; i += BATCH) batches.push(indexed.slice(i, i + BATCH));
    log(`batches: ${batches.length}, concurrency: ${CONCURRENCY}`);

    const out = [];
    let bi = 0, inFlight = 0, completed = 0;
    await new Promise((resolve) => {
        const tick = () => {
            while (inFlight < CONCURRENCY && bi < batches.length) {
                const batch = batches[bi++];
                inFlight++;
                classifyBatch(batch).then(rs => {
                    const map = new Map(rs.map(r => [r.id, r]));
                    for (const v of batch) {
                        const r = map.get(v.idx);
                        if (!r || r.mechanism === 'none' || r.score < 3) continue;
                        out.push({
                            videoId: v.videoId,
                            title: v.title,
                            views: v.views,
                            channelTitle: v.channelTitle,
                            mechanism: r.mechanism,
                            novelty_element: r.novelty_element || '',
                            score: r.score
                        });
                    }
                    completed++;
                    if (completed % 5 === 0) {
                        fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
                        log(`progress: ${completed}/${batches.length}  hits=${out.length}`);
                    }
                }).catch(e => log(`✗ batch: ${e.message}`)).finally(() => {
                    inFlight--;
                    if (bi < batches.length) tick();
                    else if (inFlight === 0) resolve();
                });
            }
        };
        tick();
    });

    out.sort((a,b) => b.views - a.views);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    log(`DONE  total_hits=${out.length}`);

    // Per-mechanism breakdown
    const byMech = {};
    for (const o of out) byMech[o.mechanism] = (byMech[o.mechanism] || 0) + 1;
    log('\nPer-mechanism hits:');
    for (const k of Object.keys(byMech).sort((a,b) => byMech[b] - byMech[a])) log(`  ${k}: ${byMech[k]}`);
})().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
