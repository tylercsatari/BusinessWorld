#!/usr/bin/env node
// V3 generator — adds Novelty axis (the multiplier the user identified).
// Each mechanism = (Zeigarnik stake-vector) × (Novel object/setting/scale that hooks the eye).

const fs = require('fs');
const http = require('http');

const OUT = '/tmp/zeigarnik_v3.json';
const LOG = '/tmp/zeigarnik_v3.log';
const TARGET = 1500;
const BATCH = 20;
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

// Anchor the 22 user mechanisms + discovered ones from research
const MECHANISMS = [
    'car_hold', 'fuse_light', 'giant_switch', 'giant_button', 'speeding_object',
    'bat_at_head', 'hanging_high', 'drop_from_high', 'launcher', 'sword_slo_mo',
    'balloon_slo_mo', 'bear_trap', 'opening_box', 'blindfolded_extreme', 'beaker',
    'tall_tower_extract', 'rope_fray', 'linear_gear_switch', 'massive_pinata',
    'jar_pull', 'falling_massive', 'wheel_spin',
    // Discovered viral families
    'hydraulic_press', 'glitter_bomb', 'last_to_leave', 'tier_comparison',
    'magic_illusion', 'will_it_blend', 'bullet_vs_x', 'trampoline_stack',
    'house_demolition', 'pickaxe_safe', 'mega_material_pool', 'elephant_toothpaste',
    'iron_man_suit', 'robot_haircut', 'moving_target_auto', 'slingshot_human'
];

const SYS = `You generate EXTREME Zeigarnik mechanisms for Tyler Csatari, a high-budget DIY YouTuber.

Every mechanism = (stake-vector) × (NOVELTY on a specific element).

NOVELTY EXAMPLES (from real viral videos that crossed 100M+ views):
- MrBeast "Stop This Train Win Lamborghini" — train is the speeding object, novelty is parking a $250K Lambo on actual railroad tracks
- Slow Mo Guys "Dan inside giant water balloon" — balloon pop is the mechanism, novelty is a HUMAN sealed inside the 6-ft balloon before it pops
- Joerg Sprave katana-launching device — launcher is the mechanism, novelty is the projectile being a full-size katana
- Hacksmith 4000°F plasma lightsaber — sword cutting is mechanism, novelty is real plasma at 4000°F
- MrBeast Strongman lifting car with 4 people inside — car-hold mechanism, novelty is people sitting inside while it's lifted
- Mark Rober World's Largest Nerf Gun — launcher mechanism, novelty is Guinness-record size
- How Ridiculous 165m dam drop — drop-from-high mechanism, novelty is the Swiss dam height + target choice
- MrBeast giant red $100,000 button — giant button mechanism, novelty is the cash prize + punishment-randomizer behind it
- Will It Blend? iPhone — destruction mechanism, novelty is destroying a brand-new iPhone

NOVELTY DIMENSIONS:
- Object novelty: the prop/device/payload is unusual (the katana, the plasma blade, the Lambo)
- Scale novelty: 10x / 100x / world-record size (largest Nerf gun, 1000-sheet stack)
- Subject novelty: human inside the balloon, person on the railroad, mom doing science
- Setting novelty: Swiss dam, real volcano, real burning house, oil rig
- Pairing novelty: train vs Lambo, Coke vs Mentos at scale, bullets vs bullets
- Tech novelty: auto-aiming gimbal, mech exoskeleton, holographic interface

For each generated mechanism output strict JSON:
{
  "id": <int>,
  "title": "<concrete, vivid one-line of what's on screen — name the novel element>",
  "mechanism_family": "<one of the 36 anchor families>",
  "novelty_dimension": "<object|scale|subject|setting|pairing|tech>",
  "novelty_description": "<what makes the visual feel unprecedented in 1 line>",
  "stake_tier": <0-6>,
  "stake_visibility": <0-3>,
  "resolution_window_sec": <3-60>,
  "single_shot": <true/false>,
  "irreversibility": <0-2>,
  "identity_proximity": <0-3>,
  "recognized_danger": <0-1>,
  "tyler_channel_fit": <0-3>
}

CONSTRAINTS:
- Every mechanism must have stake_tier ≥ 4 AND novelty_dimension specified
- 70%+ should be single_shot=true
- NEVER put kids/pets/animals in mortal/explosive/blade/electric/crush/fire scenarios
- Be SPECIFIC: "Tyler stands on a custom mechanical claw lifting a real Cybertruck 8 ft off the ground" not "person holds car"
- The novelty must be REAL and BUILDABLE (not magical)
- Span all 36 anchor families across batches

Output strict JSON: { "mechanisms": [...] }`;

async function generateBatch(idx) {
    const family = MECHANISMS[idx % MECHANISMS.length];
    const noveltyDims = ['object', 'scale', 'subject', 'setting', 'pairing', 'tech'];
    const dim = noveltyDims[(idx * 3) % noveltyDims.length];

    const userMsg = `Generate ${BATCH} NEW concrete extreme Zeigarnik mechanisms. Bias toward:
- mechanism_family: ${family}
- novelty_dimension: ${dim}

But mix in others. Every entry must be unique. Aim for at least 8 entries with tyler_channel_fit ≥ 2 (workshop / DIY builds: helmets, weapons, exoskeletons, holograms, custom devices).`;

    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o-mini',
        messages: [{role:'system',content:SYS}, {role:'user',content:userMsg}],
        temperature: 0.95,
        max_tokens: 6000,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
    const p = JSON.parse(text);
    return p.mechanisms || [];
}

function scoreV3(m) {
    const stake = (m.stake_tier || 0) * 1.5;
    const visibility = m.stake_visibility || 0;
    const window = Math.max(0, 3 - Math.floor((m.resolution_window_sec || 60) / 15));
    const shot = m.single_shot ? 2 : 0;
    const irrev = m.irreversibility || 0;
    const proximity = (m.identity_proximity || 0) * 0.7;
    const recognized = m.recognized_danger || 0;
    const novelty = m.novelty_dimension ? 2 : 0;  // novel ANY axis = +2
    const family_bonus = ['height_fall','animal_attack','fire_burn','explosion_blast','speeding_object','car_hold','launcher','last_to_leave','tier_comparison'].includes(m.mechanism_family) ? 1 : 0;
    const tyler_bonus = m.tyler_channel_fit >= 2 ? 0.5 : 0;
    return Math.round((stake + visibility + window + shot + irrev + proximity + recognized + novelty + family_bonus + tyler_bonus) * 10) / 10;
}

(async () => {
    fs.writeFileSync(LOG, '');
    log(`v3 generation: target=${TARGET}, batch=${BATCH}, concurrency=${CONCURRENCY}`);
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
                        m.score = scoreV3(m);
                        all.push(m);
                    }
                    completed++;
                    if (completed % 5 === 0) {
                        fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
                        log(`progress ${completed}/${numBatches}  ${all.length} entries`);
                    }
                }).catch(e => log(`✗ ${idx}: ${e.message}`)).finally(() => {
                    inFlight--;
                    if (bi < numBatches) tick();
                    else if (inFlight === 0) resolve();
                });
            }
        };
        tick();
    });

    // Dedupe + filter harm
    const HARM_RX = /\b(dog|cat|puppy|kitten|kid|child|baby|toddler|infant|pet)\b/i;
    const MORTAL_FAMS = new Set(['explosion_blast','blade_weapon','electricity','crush_pressure','fire_burn','sword_slo_mo','bear_trap','fuse_light','launcher','bullet_vs_x','hydraulic_press']);
    const seen = new Set();
    const uniq = [];
    for (const m of all) {
        if (HARM_RX.test(m.title || '') && MORTAL_FAMS.has(m.mechanism_family) && m.stake_tier >= 5) continue;
        const k = (m.title || '').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
        if (!k || seen.has(k)) continue;
        seen.add(k); uniq.push(m);
    }
    uniq.sort((a,b) => b.score - a.score);
    fs.writeFileSync(OUT, JSON.stringify(uniq, null, 2));
    log(`DONE  generated=${all.length}  unique_after_filter=${uniq.length}`);
    const fams = {};
    for (const m of uniq) fams[m.mechanism_family] = (fams[m.mechanism_family]||0)+1;
    log('Families:');
    for (const k of Object.keys(fams).sort((a,b)=>fams[b]-fams[a])) log(`  ${k}: ${fams[k]}`);
})().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
