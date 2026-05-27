#!/usr/bin/env node
// Generate 1,000+ theorized Zeigarnik mechanisms via combinatorial axes + LLM,
// each scored against the operationalized formula.

const fs = require('fs');
const http = require('http');

const OUT = '/tmp/zeigarnik_theorized_v2.json';
const LOG = '/tmp/zeigarnik_gen.log';

const BATCH = 25;       // mechanisms requested per LLM call
const TARGET = 400;
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
                if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${d.slice(0,400)}`));
                try { resolve(JSON.parse(d)); } catch { resolve(d); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// 13 stake-type families (the mechanisms a Zeigarnik can hook into)
const MECHANISMS = [
    'height_fall', 'speed_impact', 'fire_burn', 'water_drown', 'animal_attack',
    'blade_weapon', 'explosion_blast', 'electricity', 'crush_pressure',
    'extreme_cold_heat', 'money_loss', 'audience_shame', 'time_pressure'
];

// Subject identity (who's at risk)
const SUBJECTS = ['self (creator)', 'sibling', 'parent', 'best friend', 'stranger', 'kid', 'pet', 'animal', 'expensive object'];

// Settings
const SETTINGS = [
    'open cliff', 'rooftop', 'highway', 'forest', 'beach', 'lake', 'pool',
    'workshop', 'kitchen', 'public park', 'stadium', 'casino floor',
    'shopping mall', 'studio', 'foreign city', 'desert', 'snow mountain',
    'underwater', 'inside a car', 'inside a plane', 'cave', 'bridge',
    'arena', 'volcano rim', 'oil rig', 'crane', 'forklift', 'industrial site'
];

const SYS = `You are generating EXTREME Zeigarnik mechanisms — single-shot visual ideas where the opening 1.5 seconds locks the viewer into an unresolved loop they can't scroll past. Examples that work:
- MrBeast money flying out of a bag on a roller coaster (extreme-money-loss + mortal-falling combo)
- Tom Cruise falling out of helicopter spiraling
- Lit dynamite stick in hand with countdown
- Hippo charging tourist boat
- 100ft Nazaré wave swallowing surfer
- Walking tightrope between two skyscrapers
- F1 car split in half by fire (Grosjean walks out)
- Free-solo climbing 3000-ft El Capitan
- Holding breath underwater for record
- Buried alive in glass coffin (MrBeast)
- Cobra strikes inches from face
- Crane operator inside falling crane

For each mechanism, output:
{
  "id": <int>,
  "title": "<one-line description of what's on screen — make it specific and concrete>",
  "mechanism_family": "<one of: height_fall, speed_impact, fire_burn, water_drown, animal_attack, blade_weapon, explosion_blast, electricity, crush_pressure, extreme_cold_heat, money_loss, audience_shame, time_pressure>",
  "stake_tier": <0-6: 0=none, 1=aesthetic, 2=property, 3=time/record, 4=extreme pain, 5=irreversible body, 6=mortal>,
  "stake_visibility": <0-3: 0=verbal-only, 1=implied off-frame, 2=visible but small, 3=visually dominant>,
  "resolution_window_sec": <typical seconds until the loop closes — 3 to 60>,
  "single_shot": <true/false: can the entire video be one continuous take>,
  "irreversibility": <0-2: 0=reversible, 1=replaceable, 2=permanent>,
  "subject_identity": "<self|sibling|parent|friend|stranger|kid|pet|animal|object>",
  "setting": "<setting>",
  "tyler_channel_fit": <0-3: 0=way off-brand, 1=could fit, 2=natural fit, 3=signature for Tyler Csatari's workshop/DIY style>
}

CONSTRAINTS:
- Every mechanism must have stake_tier ≥ 4 (no mild stakes)
- Stake_visibility must be ≥ 2
- Aim for single_shot=true on at least 70%
- Diversity: span all 13 mechanism_families; do not repeat the same specific situation
- Be CONCRETE: not "person falls" but "Tyler hangs from helicopter skid with cliff face passing under him"
- SAFETY: NEVER put kids, pets, or animals in mortal/explosive/blade/electrical/crush/fire stakes. They can appear as bystanders or in safe positions only. The subject in mortal danger must be an adult (self, sibling, parent, friend, stranger) or an inanimate object.

Output strict JSON: { "mechanisms": [ ... ] }`;

async function generateBatch(seedIdx) {
    // pick a tilt for variety
    const family = MECHANISMS[seedIdx % MECHANISMS.length];
    const subject = SUBJECTS[(seedIdx * 7) % SUBJECTS.length];
    const setting = SETTINGS[(seedIdx * 13) % SETTINGS.length];

    const userMsg = `Generate ${BATCH} NEW extreme Zeigarnik mechanisms biased toward but not limited to:
- mechanism_family: ${family}
- subject_identity: ${subject}
- setting: ${setting}

Mix in adjacent families/settings/subjects as well. Every mechanism must be UNIQUE and CONCRETE. Make 10 of them deliberately Tyler-Csatari-friendly (DIY builds, helmets, weapons, exoskeletons, sci-bro experiments) by setting tyler_channel_fit=2 or 3.`;

    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: userMsg }],
        temperature: 0.9,
        max_tokens: 8000,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text);
    return parsed.mechanisms || [];
}

function scoreMechanism(m) {
    const stake = (m.stake_tier || 0) * 1.5;
    const visibility = m.stake_visibility || 0;
    const window = Math.max(0, 3 - Math.floor((m.resolution_window_sec || 60) / 15));
    const shot = m.single_shot ? 2 : 0;
    const irrev = m.irreversibility || 0;
    const family_bonus = ['height_fall', 'animal_attack', 'fire_burn', 'explosion_blast'].includes(m.mechanism_family) ? 1 : 0;
    const tyler_bonus = m.tyler_channel_fit >= 2 ? 0.5 : 0;
    return Math.round((stake + visibility + window + shot + irrev + family_bonus + tyler_bonus) * 10) / 10;
}

(async () => {
    fs.writeFileSync(LOG, '');
    log(`generating ${TARGET} mechanisms in batches of ${BATCH}, concurrency ${CONCURRENCY}`);

    const numBatches = Math.ceil(TARGET / BATCH);
    const all = [];
    let bi = 0, inFlight = 0, completed = 0;
    await new Promise((resolve) => {
        const tick = () => {
            while (inFlight < CONCURRENCY && bi < numBatches) {
                const idx = bi++;
                inFlight++;
                generateBatch(idx).then(arr => {
                    for (const m of arr) {
                        m.score = scoreMechanism(m);
                        all.push(m);
                    }
                    completed++;
                    if (completed % 5 === 0) {
                        fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
                        log(`progress: ${completed}/${numBatches} batches  ${all.length} mechanisms`);
                    }
                }).catch(e => log(`✗ batch ${idx}: ${e.message}`)).finally(() => {
                    inFlight--;
                    if (bi < numBatches) tick();
                    else if (inFlight === 0) resolve();
                });
            }
        };
        tick();
    });

    // Dedupe by lower-cased title
    const seen = new Set();
    const unique = [];
    for (const m of all) {
        const k = (m.title || '').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        unique.push(m);
    }
    unique.sort((a, b) => b.score - a.score);
    fs.writeFileSync(OUT, JSON.stringify(unique, null, 2));
    log(`DONE  generated=${all.length}  unique=${unique.length}`);

    const buckets = {};
    for (const m of unique) buckets[m.mechanism_family] = (buckets[m.mechanism_family]||0)+1;
    log('Family distribution:');
    for (const k of Object.keys(buckets).sort((a,b)=>buckets[b]-buckets[a])) log(`  ${k}: ${buckets[k]}`);
})().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
