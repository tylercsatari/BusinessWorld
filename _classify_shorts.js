#!/usr/bin/env node
// Classify every shorts-db title for "extreme Zeigarnik" potential via LLM.
// Output: /tmp/shorts_zeigarnik_classified.json
// Each entry: { videoId, title, views, channelTitle, isZeigarnik, mechanism, stakeCategory, stakeLevel, oneAction, score }

const fs = require('fs');
const http = require('http');

const DB = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/shorts-db.json';
const OUT = '/tmp/shorts_zeigarnik_classified.json';
const LOG = '/tmp/shorts_classify.log';

const BATCH = 50;      // titles per LLM call
const CONCURRENCY = 8;

function log(line) {
    const t = new Date().toISOString();
    const msg = `[${t}] ${line}`;
    console.log(msg);
    fs.appendFileSync(LOG, msg + '\n');
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
                if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${d.slice(0, 400)}`));
                try { resolve(JSON.parse(d)); } catch { resolve(d); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const SYS = `You classify viral YouTube Short titles for an "extreme visual Zeigarnik effect" research project.

A video qualifies if its OPENING VISUAL would plausibly open an unresolved mental loop with EXTREME stakes — falling from height, fire/explosion, weapon, wildlife threat, deadly water, extreme money loss visibly on screen, irreversible body damage about to happen, deadly machinery, etc.

DOES qualify (extreme Zeigarnik):
- Falling from helicopter / building / cliff / skyscraper edge
- Dynamite / fuse / bomb / explosion mid-air
- Wildlife about to bite / charge (shark, alligator, lion, bear, hippo, snake)
- Fire / flame approaching person / object
- Money flying away (visible cash on screen, irreversibly leaving)
- Bullet / blade approaching subject
- World-record attempt at clearly deadly stunt
- Tornado / volcano / lava / lightning at close range
- Falling vehicle / motorcycle crash mid-air
- Sinking / drowning / underwater no-air
- Walking tightrope between high buildings
- Free solo / no-rope climbing

DOES NOT qualify (filter out):
- Dance challenges / nursery rhymes / kids songs / cartoons
- Food / cooking / mukbang (unless extreme like spice that injures)
- Hair / makeup / fashion
- Couple pranks / relationship content
- Pet/baby cuteness (not in danger)
- Random comedy
- Sports highlights without mortal stake
- Reaction content
- Product reviews
- Music videos
- Most "satisfying" content (asmr, crafts)

For each input title, output:
{
  "id": <int — the index from input>,
  "isZeigarnik": true/false,
  "mechanism": "<short noun phrase describing the visual open loop, ≤8 words; or empty>",
  "stakeCategory": "mortal|irreversible-body|catastrophic-property|extreme-money-loss|wildlife-threat|public-shame||other|none",
  "oneAction": true/false,
  "score": 0-10
}

Score scale (0 if isZeigarnik=false; otherwise):
  10 = visibly life-threatening, single shot, no recovery if it fails (MrBeast roller coaster, helicopter exit, dynamite)
  7-9 = serious irreversible stakes, body or mortal
  4-6 = high stakes but recoverable (records, dangerous wildlife at safe distance)
  1-3 = minor stakes — should usually be false unless borderline

Output strict JSON only:
{ "results": [ ... ] }
Every input id must appear in results exactly once.`;

async function classifyBatch(items) {
    const userMsg = items.map(it => `${it.idx}: ${it.title} [views=${it.views}, channel=${it.channelTitle}]`).join('\n');
    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: SYS },
            { role: 'user', content: userMsg }
        ],
        temperature: 0.1,
        max_tokens: 4500,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text);
    return parsed.results || [];
}

(async () => {
    fs.writeFileSync(LOG, '');
    const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
    const videos = Object.values(db.videos).filter(v => v.title && v.videoId);
    log(`loaded ${videos.length} videos from shorts-db`);

    // Tag each with idx
    const indexed = videos.map((v, i) => ({ idx: i, videoId: v.videoId, title: v.title, views: v.views || 0, channelTitle: v.channelTitle || '' }));

    // Resume if possible
    let classified = [];
    if (fs.existsSync(OUT)) {
        try {
            classified = JSON.parse(fs.readFileSync(OUT, 'utf8'));
            log(`resume: ${classified.length} already classified`);
        } catch {}
    }
    const doneIds = new Set(classified.map(c => c.videoId));
    const remaining = indexed.filter(v => !doneIds.has(v.videoId));
    log(`remaining: ${remaining.length}`);

    // Batch and run with concurrency
    const batches = [];
    for (let i = 0; i < remaining.length; i += BATCH) batches.push(remaining.slice(i, i + BATCH));
    log(`batches: ${batches.length}, concurrency: ${CONCURRENCY}`);

    let inFlight = 0, bi = 0, completed = 0, failed = 0;
    await new Promise((resolve) => {
        const tick = () => {
            while (inFlight < CONCURRENCY && bi < batches.length) {
                const batch = batches[bi++];
                inFlight++;
                classifyBatch(batch).then(rs => {
                    // Map results back
                    const map = new Map(rs.map(r => [r.id, r]));
                    for (const v of batch) {
                        const r = map.get(v.idx);
                        if (!r) continue;
                        classified.push({
                            videoId: v.videoId,
                            title: v.title,
                            views: v.views,
                            channelTitle: v.channelTitle,
                            isZeigarnik: !!r.isZeigarnik,
                            mechanism: r.mechanism || '',
                            stakeCategory: r.stakeCategory || 'none',
                            oneAction: !!r.oneAction,
                            score: r.score || 0
                        });
                    }
                    completed++;
                    if (completed % 5 === 0) {
                        fs.writeFileSync(OUT, JSON.stringify(classified, null, 2));
                        const hits = classified.filter(c => c.isZeigarnik).length;
                        log(`progress: ${completed}/${batches.length} batches  hits=${hits}/${classified.length}`);
                    }
                }).catch(e => {
                    failed++;
                    log(`✗ batch failed: ${e.message}`);
                }).finally(() => {
                    inFlight--;
                    if (bi < batches.length) tick();
                    else if (inFlight === 0) resolve();
                });
            }
        };
        tick();
    });

    fs.writeFileSync(OUT, JSON.stringify(classified, null, 2));
    const hits = classified.filter(c => c.isZeigarnik);
    log(`DONE  total=${classified.length}  zeigarnik_hits=${hits.length}  failed_batches=${failed}`);
    // Top 30 by views
    hits.sort((a, b) => b.views - a.views);
    log(`\nTop 30 verified extreme-Zeigarnik shorts by views:`);
    for (const h of hits.slice(0, 30)) {
        log(`  ${h.views.toLocaleString().padStart(13)} | score ${h.score} | ${h.stakeCategory} | "${h.title.slice(0,70)}" | ${h.channelTitle}`);
    }
})().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
