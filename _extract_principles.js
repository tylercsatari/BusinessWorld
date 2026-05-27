#!/usr/bin/env node
// Extract DEEP, NAMED scientific/engineering principles per video.
// ONLY processes videos with uploadDate >= 2023-05-27 (last 3 years).
// Writes incrementally.

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname);
const VIDEO_DIR = path.join(ROOT, 'video_data');
const OUT_JSON = path.join(ROOT, 'buildings/library/frameworks/04-underlying-principles.json');
const LOG = path.join(ROOT, 'buildings/library/frameworks/_principles.log');
const CUTOFF = '20230527'; // YYYYMMDD

const argv = Object.fromEntries(process.argv.slice(2).map(a => a.startsWith('--') ? a.slice(2).split('=') : [a, true]));
const CONCURRENCY = parseInt(argv.concurrency || '8');
const LIMIT = argv.limit ? parseInt(argv.limit) : Infinity;
const RESUME = !!argv.resume;

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

function buildPrompt(a) {
    const title = a.metadata?.title || '';
    const idea = a.aiAnalysis?.videoIdea || '';
    const summary = a.aiAnalysis?.summary || '';
    const transcript = (a.transcript?.fullText || a.transcript || '').toString();
    const tShort = transcript.length > 4000 ? transcript.slice(0, 4000) + ' …' : transcript;

    return [
        { role: 'system', content:
`You extract DEEP, NAMED scientific/engineering principles that a build, demo, or experiment is actually exploiting.

WE WANT principles like:
  • reciprocal structures (Da Vinci bridge, self-supporting interlock)
  • non-Newtonian fluid behavior (oobleck, shear-thickening)
  • tensegrity (tension + compression integrity)
  • catenary curve (chains, arches under self-weight)
  • Magnus effect (spinning ball curve)
  • Bernoulli effect (lift, aerofoil)
  • Coanda effect (fluid following a surface)
  • capillary action
  • thermal expansion / bimetallic strip
  • shape-memory alloys (nitinol)
  • piezoelectricity
  • triboelectric charging
  • diamagnetic levitation
  • eddy currents (Lenz's law)
  • cavitation
  • vortex shedding
  • Helmholtz resonance
  • standing waves / nodes
  • mechanical advantage (lever, pulley, screw, wedge)
  • differential gearing
  • cam-and-follower
  • four-bar linkage
  • Geneva drive
  • ratchet-and-pawl
  • composite layering / cross-grain lamination
  • honeycomb / sandwich structure
  • auxetic geometry (negative Poisson's ratio)
  • origami metamaterials
  • aerogel low-density solid
  • Kevlar / aramid fiber tensile strength
  • UHMWPE (Dyneema) bullet stopping
  • ballistic gel impact analog
  • case hardening
  • forging vs casting grain structure
  • thermite redox
  • exothermic vs endothermic phase change
  • supercooling / supersaturation
  • Maillard reaction
  • photoelectric effect
  • total internal reflection (fiber optic)
  • polarization / birefringence
  • Pepper's ghost illusion
  • parabolic reflector focus
  • Fresnel lens
  • acoustic impedance matching
  • destructive interference (noise cancel)
  • whispering gallery
  • etc.

WE DO NOT WANT:
  • "iterative design process"  (too generic methodology, not a principle)
  • "scientific method"  (no)
  • "endurance and goal achievement"  (psychology, not the build's principle)
  • "exposure therapy"  (no)
  • "narrative engagement"  (storytelling, not the build's principle)
  • "perseverance through inspiration"  (no)
  • "goal setting"  (no)
  • generic categories like "physics" or "engineering"

If the video is a pure endurance/challenge/eating/walking video with NO physical-principle build, return:
  { "principles": [] }

Otherwise return strict JSON:
{
  "principles": [
    {
      "name": "<specific named principle — usually the textbook name>",
      "category": "physics|materials|mechanics|fluids|optics|acoustics|chemistry|thermodynamics|electromagnetism|biology|structural|other",
      "explanation": "<1 sentence — the actual mechanism, naming the law/effect>",
      "where_in_video": "<1 sentence — what specifically the build did that exploits this principle>"
    }
  ]
}
Maximum 3 principles. Most videos will have 1. Some will have 0. Only include principles that genuinely drive the video's physical outcome.` },
        { role: 'user', content:
`TITLE: ${title}
ONE-LINE IDEA: ${idea}
SUMMARY: ${summary}
TRANSCRIPT: ${tShort}` }
    ];
}

async function extractOne(ytId) {
    const file = path.join(VIDEO_DIR, ytId, 'analysis.json');
    if (!fs.existsSync(file)) return { ytId, error: 'no analysis.json' };
    let a;
    try { a = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return { ytId, error: 'bad json: ' + e.message }; }

    const messages = buildPrompt(a);
    const resp = await httpJson('POST', '/api/openai/chat', {
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.1,
        max_tokens: 700,
        response_format: { type: 'json_object' }
    });
    let text = resp?.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return { ytId, error: 'parse fail', raw: text.slice(0, 200) }; }

    return {
        ytId,
        title: a.metadata?.title || '',
        uploadDate: a.metadata?.uploadDate || '',
        views: a.metadata?.viewCount || a.analytics?.totalViews || null,
        principles: parsed.principles || []
    };
}

(async () => {
    fs.writeFileSync(LOG, '');
    log('extraction starting (last 3 years only)');

    const allIds = fs.readdirSync(VIDEO_DIR).filter(n => fs.existsSync(path.join(VIDEO_DIR, n, 'analysis.json')));
    const recent = [];
    for (const id of allIds) {
        try {
            const a = JSON.parse(fs.readFileSync(path.join(VIDEO_DIR, id, 'analysis.json'), 'utf8'));
            const d = String(a.metadata?.uploadDate || '').replace(/-/g, '');
            if (d && d >= CUTOFF) recent.push(id);
        } catch {}
    }
    log(`found ${recent.length} videos with uploadDate >= ${CUTOFF} (of ${allIds.length} total)`);

    let results = [];
    const done = new Set();
    if (RESUME && fs.existsSync(OUT_JSON)) {
        try {
            results = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
            for (const r of results) done.add(r.ytId);
            log(`resume: ${done.size} already processed`);
        } catch (e) { log('resume parse fail, restarting'); results = []; }
    }

    const queue = recent.filter(id => !done.has(id)).slice(0, LIMIT === Infinity ? recent.length : LIMIT);
    log(`queue size: ${queue.length}, concurrency: ${CONCURRENCY}`);

    let inFlight = 0, idx = 0, completed = 0, failed = 0;
    const total = queue.length;
    const saveEvery = 10;

    await new Promise((resolve) => {
        const tick = () => {
            while (inFlight < CONCURRENCY && idx < queue.length) {
                const ytId = queue[idx++];
                inFlight++;
                extractOne(ytId).then(r => {
                    results.push(r);
                    if (r.error) { failed++; log(`✗ ${ytId}: ${r.error}`); }
                    else { completed++; }
                    if ((completed + failed) % saveEvery === 0) {
                        fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
                        log(`progress: ${completed + failed}/${total} ok=${completed} fail=${failed}`);
                    }
                }).catch(e => {
                    failed++;
                    results.push({ ytId, error: 'throw: ' + e.message });
                    log(`✗ ${ytId}: throw ${e.message}`);
                }).finally(() => {
                    inFlight--;
                    if (idx < queue.length) tick();
                    else if (inFlight === 0) resolve();
                });
            }
        };
        tick();
    });

    fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
    log(`done: ok=${completed} fail=${failed} total=${results.length}`);
})().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
