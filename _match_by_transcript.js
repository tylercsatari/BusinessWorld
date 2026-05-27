#!/usr/bin/env node
// Match unlinked YouTube uploads to videos collection records using transcript ↔ script similarity.
// Usage: node _match_by_transcript.js [--apply]

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://localhost:8002';
const APPLY = process.argv.includes('--apply');
const SUBS_DIR = '/tmp/yt_subs';
const UNLINKED = '/tmp/unlinked_meta.json';

function httpJson(method, urlStr, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'Content-Type': 'application/json' } };
        const req = http.request(opts, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`${method} ${urlStr} ${res.statusCode}: ${d.slice(0,300)}`));
                try { resolve(JSON.parse(d)); } catch { resolve(d); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// Strip VTT to plain text, dedupe consecutive duplicate lines (YT auto-subs roll the same text repeatedly)
function vttToText(vtt) {
    const lines = vtt.split(/\r?\n/);
    const out = [];
    let lastClean = '';
    for (const raw of lines) {
        if (!raw.trim()) continue;
        if (raw.startsWith('WEBVTT') || raw.startsWith('Kind:') || raw.startsWith('Language:') || raw.startsWith('NOTE')) continue;
        if (/-->/.test(raw)) continue;
        // Strip inline <00:00:00.480><c>word</c> tags
        const clean = raw.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        if (!clean) continue;
        if (clean === lastClean) continue;
        out.push(clean);
        lastClean = clean;
    }
    return out.join(' ').toLowerCase().replace(/[^a-z0-9']+/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set(('a about all also and as at be been but by can could do for from get got go had has have he her him his how i if in into is it its just like make me my no not now of on one or our out she so some than that the their them then there they this to up us was we were what when which who will with would you your').split(' '));

function tokens(text) {
    if (!text) return [];
    return text.toLowerCase().replace(/[^a-z0-9']+/g, ' ').split(/\s+/).filter(w => w && w.length > 2 && !STOP.has(w));
}
function bigrams(arr) {
    const b = [];
    for (let i = 0; i < arr.length - 1; i++) b.push(arr[i] + ' ' + arr[i+1]);
    return b;
}
function tfMap(arr) {
    const m = new Map();
    for (const t of arr) m.set(t, (m.get(t) || 0) + 1);
    return m;
}
function cosine(aMap, bMap) {
    let dot = 0;
    let aN = 0, bN = 0;
    for (const [k, v] of aMap) { aN += v * v; if (bMap.has(k)) dot += v * bMap.get(k); }
    for (const [, v] of bMap) bN += v * v;
    if (!aN || !bN) return 0;
    return dot / (Math.sqrt(aN) * Math.sqrt(bN));
}

(async () => {
    const unlinked = JSON.parse(fs.readFileSync(UNLINKED, 'utf8'));
    const videos = await httpJson('GET', `${BASE}/api/data/videos`);
    const candidates = videos.filter(v => !v.youtubeVideoId && ['workshop','incubator','posted','idea'].includes(v.status));

    console.log(`Unlinked YT uploads : ${unlinked.length}`);
    console.log(`Candidate records   : ${candidates.length}\n`);

    // Build record text blobs (name + project + hook + context + script)
    const cVecs = candidates.map(c => {
        const blob = [c.name, c.project, c.hook, c.context, c.script].filter(Boolean).join(' ');
        const toks = tokens(blob);
        const bg = bigrams(toks);
        // Weight: unigrams + 2x bigrams (bigrams more discriminative)
        const m = tfMap(toks);
        for (const g of bg) m.set('B:' + g, (m.get('B:' + g) || 0) + 2);
        return { c, vec: m, blobLen: blob.length };
    });

    // Process each YT video
    const results = [];
    let processed = 0;
    let noSubs = 0;
    for (const u of unlinked) {
        const subFile = path.join(SUBS_DIR, `${u.id}.en.vtt`);
        if (!fs.existsSync(subFile)) { noSubs++; results.push({ u, top: [], reason: 'no captions' }); continue; }
        const vtt = fs.readFileSync(subFile, 'utf8');
        const text = vttToText(vtt);
        // Also incorporate the title (small weight) — it's still a real signal
        const toks = tokens(text + ' ' + u.title);
        const bg = bigrams(toks);
        const m = tfMap(toks);
        for (const g of bg) m.set('B:' + g, (m.get('B:' + g) || 0) + 2);

        const scored = cVecs.map(cv => ({ c: cv.c, score: cosine(m, cv.vec), blobLen: cv.blobLen }))
                            .sort((a, b) => b.score - a.score);
        results.push({ u, top: scored.slice(0, 3), tokens: toks.length });
        processed++;
    }
    console.log(`Processed ${processed} videos with captions, ${noSubs} had no captions.\n`);

    // Bucket
    const STRONG = 0.18;     // strong match — generally safe to auto-link
    const POSSIBLE = 0.10;   // worth showing for confirmation
    const proposals = [];
    const possible = [];
    const weak = [];
    const usedCand = new Map(); // candId -> {score, ytId}

    for (const r of results) {
        const top = r.top[0];
        const sec = r.top[1];
        if (!top || top.score < POSSIBLE) { weak.push(r); continue; }
        if (top.score >= STRONG && (!sec || top.score - sec.score >= 0.05)) {
            proposals.push(r);
        } else {
            possible.push(r);
        }
    }

    // Resolve duplicate candidate claims — keep the YT with the higher score
    const resolved = [];
    const claim = new Map();
    for (const r of proposals) {
        const cid = r.top[0].c.id;
        if (!claim.has(cid) || claim.get(cid).top[0].score < r.top[0].score) {
            const prev = claim.get(cid);
            if (prev) possible.push(prev);
            claim.set(cid, r);
        } else {
            possible.push(r);
        }
    }
    for (const r of claim.values()) resolved.push(r);

    console.log('=== STRONG TRANSCRIPT MATCHES (cosine ≥ 0.18, top‑gap ≥ 0.05) ===');
    if (!resolved.length) console.log('  (none)');
    for (const r of resolved) {
        console.log(`  ${r.u.id}  "${r.u.title}"`);
        console.log(`     → ${r.top[0].c.id}  status=${r.top[0].c.status}  proj="${r.top[0].c.project || ''}"  "${r.top[0].c.name}"  sim=${r.top[0].score.toFixed(3)}  (next=${(r.top[1]?.score || 0).toFixed(3)})`);
    }

    console.log('\n=== POSSIBLE (mid confidence — needs eyes) ===');
    if (!possible.length) console.log('  (none)');
    for (const r of possible.sort((a,b) => (b.top[0]?.score||0) - (a.top[0]?.score||0))) {
        console.log(`  ${r.u.id}  "${r.u.title}"`);
        for (const t of r.top) {
            if (!t) continue;
            console.log(`     ${t.score.toFixed(3)}  ${t.c.id}  status=${t.c.status}  proj="${t.c.project||''}"  "${t.c.name}"`);
        }
    }

    console.log('\n=== WEAK / NO MATCH (cosine < 0.10) ===  count:', weak.length);
    for (const r of weak.slice(0, 20)) console.log(`  ${r.u.id}  "${r.u.title}"  topScore=${r.top[0]?.score.toFixed(3) || 'n/a'}`);
    if (weak.length > 20) console.log(`  ... and ${weak.length - 20} more`);

    console.log('\nSummary:');
    console.log(`  Unlinked YT       : ${unlinked.length}`);
    console.log(`  Strong matches    : ${resolved.length}`);
    console.log(`  Possible matches  : ${possible.length}`);
    console.log(`  Weak / no match   : ${weak.length}`);
    console.log(`  No captions       : ${noSubs}`);

    if (!APPLY) {
        console.log('\n(Dry run. Re-run with --apply to write strong matches.)');
        return;
    }

    console.log('\nApplying strong matches (skipping long-form)...');
    const longformIds = new Set(fs.readFileSync('/tmp/longform_ids.txt', 'utf8').trim().split('\n').map(s => s.trim()).filter(Boolean));
    let ok = 0, fail = 0, skipped = 0;
    for (const r of resolved) {
        const isLongFormYT = longformIds.has(r.u.id);
        const isLongFormRecord = /\blong\s*form\b/i.test(r.top[0].c.name || '');
        if (isLongFormYT || isLongFormRecord) {
            console.log(`  ⊘ skip long-form: ${r.u.id} "${r.u.title}" → ${r.top[0].c.name}`);
            skipped++;
            continue;
        }
        try {
            await httpJson('PATCH', `${BASE}/api/data/videos/${r.top[0].c.id}`, {
                youtubeVideoId: r.u.id,
                status: 'posted',
                postedDate: r.top[0].c.postedDate || new Date().toISOString()
            });
            console.log(`  ✓ ${r.top[0].c.id} ← ${r.u.id}`);
            ok++;
        } catch (e) {
            console.log(`  ✗ ${r.top[0].c.id} ← ${r.u.id}: ${e.message}`);
            fail++;
        }
    }
    console.log(`\nDone. linked=${ok} failed=${fail} skipped=${skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
