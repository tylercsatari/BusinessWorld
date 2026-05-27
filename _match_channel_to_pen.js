#!/usr/bin/env node
// Match YouTube channel uploads (from yt-dlp dump) to videos collection.
// Usage: node _match_channel_to_pen.js [--apply]
// Reads /tmp/yt_all.tsv  (lines: "<videoId>\t<title>")

const fs = require('fs');
const http = require('http');

const BASE = 'http://localhost:8002';
const APPLY = process.argv.includes('--apply');
const TSV = process.argv.find(a => a.startsWith('--tsv=')) ?
            process.argv.find(a => a.startsWith('--tsv=')).slice(6) :
            '/tmp/yt_all.txt';

function httpJson(method, urlStr, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const opts = {
            method, hostname: u.hostname, port: u.port,
            path: u.pathname + u.search, headers: { 'Content-Type': 'application/json' }
        };
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

function norm(s) {
    return String(s || '').toLowerCase()
        .replace(/[''`]/g, "'").replace(/[""]/g, '"')
        .replace(/[^a-z0-9\s']/g, ' ')
        .replace(/\s+/g, ' ').trim();
}
function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const v0 = new Array(b.length + 1), v1 = new Array(b.length + 1);
    for (let i = 0; i <= b.length; i++) v0[i] = i;
    for (let i = 0; i < a.length; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < b.length; j++) {
            const c = a[i] === b[j] ? 0 : 1;
            v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + c);
        }
        for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
    }
    return v1[b.length];
}
function sim(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    return 1 - lev(na, nb) / Math.max(na.length, nb.length);
}

(async () => {
    const raw = fs.readFileSync(TSV, 'utf8').trim();
    const uploads = raw.split('\n').map(line => {
        const idx = line.indexOf('|||');
        if (idx < 0) return null;
        return { videoId: line.slice(0, idx).trim(), title: line.slice(idx + 3).trim() };
    }).filter(u => u && /^[\w-]{11}$/.test(u.videoId));
    console.log(`Loaded ${uploads.length} channel uploads from ${TSV}.`);

    const videos = await httpJson('GET', `${BASE}/api/data/videos`);
    console.log(`Loaded ${videos.length} video records from /api/data/videos.\n`);

    const byYtId = new Map();
    for (const v of videos) if (v.youtubeVideoId) byYtId.set(v.youtubeVideoId, v);

    const linked   = uploads.filter(u => byYtId.has(u.videoId));
    const unlinked = uploads.filter(u => !byYtId.has(u.videoId));

    console.log(`✓ Already linked in Pen      : ${linked.length}`);
    console.log(`✗ NOT linked yet (need work) : ${unlinked.length}\n`);

    const candidates = videos.filter(v => !v.youtubeVideoId);
    const byStatus = {};
    for (const c of candidates) byStatus[c.status || 'unknown'] = (byStatus[c.status || 'unknown'] || 0) + 1;
    console.log(`Candidates (records without youtubeVideoId): ${candidates.length}`);
    console.log('  by status:', byStatus, '\n');

    const proposals = [];
    const ambiguous = [];
    const noMatch   = [];
    const used      = new Set();

    for (const up of unlinked) {
        const scored = candidates
            .filter(c => !used.has(c.id))
            .map(c => ({ c, score: sim(up.title, c.name) }))
            .sort((a, b) => b.score - a.score);

        const top    = scored[0];
        const second = scored[1];

        if (!top || top.score < 0.55) {
            noMatch.push(up);
        } else if (top.score >= 0.85 && (!second || (top.score - second.score) >= 0.15)) {
            proposals.push({ up, c: top.c, score: top.score });
            used.add(top.c.id);
        } else {
            ambiguous.push({ up, top3: scored.slice(0, 3) });
        }
    }

    console.log('=== HIGH-CONFIDENCE MATCHES (will be linked on --apply) ===');
    if (!proposals.length) console.log('  (none)');
    for (const p of proposals) {
        console.log(`  ${p.up.videoId}  "${p.up.title}"`);
        console.log(`     → ${p.c.id}  status=${p.c.status}  "${p.c.name}"  sim=${p.score.toFixed(2)}`);
    }

    console.log('\n=== AMBIGUOUS (best score < 0.85 or top-2 within 0.15) ===');
    if (!ambiguous.length) console.log('  (none)');
    for (const a of ambiguous) {
        console.log(`  ${a.up.videoId}  "${a.up.title}"`);
        for (const s of a.top3) {
            console.log(`     ${s.score.toFixed(2)}  ${s.c.id}  status=${s.c.status}  "${s.c.name}"`);
        }
    }

    console.log('\n=== UNMATCHED CHANNEL VIDEOS (no candidate ≥ 0.55) ===');
    if (!noMatch.length) console.log('  (none)');
    for (const u of noMatch) {
        console.log(`  ${u.videoId}  "${u.title}"`);
    }

    console.log('\nSummary:');
    console.log(`  Channel uploads        : ${uploads.length}`);
    console.log(`  Already linked         : ${linked.length}`);
    console.log(`  High-confidence match  : ${proposals.length}`);
    console.log(`  Ambiguous              : ${ambiguous.length}`);
    console.log(`  No candidate           : ${noMatch.length}`);

    if (!APPLY) {
        console.log('\n(Dry run. Re-run with --apply to write high-confidence matches.)');
        return;
    }

    console.log('\nApplying high-confidence matches...');
    let ok = 0, fail = 0;
    for (const p of proposals) {
        try {
            await httpJson('PATCH', `${BASE}/api/data/videos/${p.c.id}`, {
                youtubeVideoId: p.up.videoId,
                status: 'posted',
                postedDate: p.c.postedDate || new Date().toISOString()
            });
            console.log(`  ✓ ${p.c.id} ← ${p.up.videoId}`);
            ok++;
        } catch (e) {
            console.log(`  ✗ ${p.c.id} ← ${p.up.videoId}: ${e.message}`);
            fail++;
        }
    }
    console.log(`\nDone. linked=${ok} failed=${fail}`);
})().catch(e => { console.error(e); process.exit(1); });
