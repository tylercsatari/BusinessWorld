#!/usr/bin/env node
// scrape-channels-long.js — MULTI-CHANNEL LONG-FORM (horizontal) YouTube Studio scraper.
// This is the long-form sibling of scrape-channels.js. It clones the same interception/parse
// mechanism but targets regular uploads (not Shorts) and captures long-form metrics:
//   • CTR + impressions          (Reach tab  → parseReach)
//   • relative + absolute retention curves, ret5, ret30, avg_view_duration
//                                (Engagement/Overview tab → parseRetention)
//   • views / title / duration / published (public metadata → fetchMeta)
//
// It does NOT modify scrape-channels.js or swipe-scraper.js (the Shorts flow). It reuses the
// SAME logged-in Chrome profile (yt-chrome-profile) via swipe-scraper-long.js's SESSION_DIR,
// so one login serves both flows.
//
// SETUP: it reads scrape-channels-long.config.json by default (Main + Account 1/2/3):
//   { "channels": [ { "id": "tyler", "name": "Main" },
//                   { "id": "bob",  "name": "Bob", "videoIdsLong": ["abc","def"] } ] }
//   (videoIdsLong optional — omitted → auto-discovers that channel's regular /videos/upload grid.)
//   Override with a different file: node scrape-channels-long.js my-config.json
//
// RUN: node scrape-channels-long.js
//   Opens real Chrome (your logged-in profile). You MUST already be LOGGED IN to YouTube
//   Studio. When it pauses for a channel, use the account menu (top-right in Studio) to
//   SWITCH to that channel, then press Enter — it discovers + scrapes all that channel's
//   long-form uploads, then moves to the next channel.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const scraper = require('./swipe-scraper-long');   // long-form sibling — shares the Chrome profile
let cloud = null; try { require('dotenv').config(); cloud = require('./cloud-storage'); if (cloud.initR2) cloud.initR2(); } catch (e) { console.warn('cloud-storage unavailable — R2 upload skipped'); }
async function r2put(key, obj) { if (!cloud || !cloud.uploadToR2) return; try { await cloud.uploadToR2(key, Buffer.from(JSON.stringify(obj)), 'application/json'); console.log(`  [R2] uploaded ${key}`); } catch (e) { console.warn(`  [R2] upload failed ${key}:`, e.message); } }

const STUDY = path.join(__dirname, 'buildings/jarvis/longform-study');
const RET_DIR = path.join(STUDY, 'retention');
const CHANNELS_JSON = path.join(STUDY, 'channels.json');
const CONFIG = path.join(__dirname, process.argv[2] || 'scrape-channels-long.config.json');
const WINDOW_MS = 3 * 365 * 24 * 3600 * 1000;   // account scrape window: last 3 YEARS (the public thumbnail crawler stays at 1yr)

const ask = (q) => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a); }); });

// ── discovery ───────────────────────────────────────────────────────────────
// pull every LONG-FORM (horizontal) video id off the current channel's Studio content listing.
// Shorts flow points at /videos/short — the long-form flow points at /videos/upload (regular grid).
async function discoverVideoIds(page) {
    await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const m = page.url().match(/channel\/(UC[\w-]+)/);
    const chId = m ? m[1] : null;
    console.log(chId ? `  active channel: ${chId}` : '  (could not read active channel id — scraping whatever content page loads)');
    // /videos/upload = the long-form uploads grid (vs /videos/short for Shorts)
    const url = chId ? `https://studio.youtube.com/channel/${chId}/videos/upload` : 'https://studio.youtube.com';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    // capture id + visibility + row text per row, then drop Private/Draft/Scheduled, and (where the
    // grid publish date is legible) anything older than a year. fetchMeta re-checks privacy + date.
    const seen = new Map();
    for (let scroll = 0; scroll < 60; scroll++) {
        const batch = await page.evaluate(() => {
            const out = [];
            const rows = document.querySelectorAll('ytcp-video-row');
            const pick = (row) => {
                const a = row.querySelector('a[href*="/video/"]');
                const id = a ? (a.getAttribute('href').match(/\/video\/([\w-]{6,})/) || [])[1] : null;
                if (!id) return;
                const visEl = row.querySelector('[id*="visibility" i], [class*="visibility" i], ytcp-video-visibility-select');
                const vis = ((visEl && (visEl.innerText || visEl.textContent)) || '').replace(/\s+/g, ' ').trim();
                const txt = ((row.innerText || row.textContent) || '').replace(/\s+/g, ' ').trim();
                out.push({ id, vis, txt });
            };
            if (rows.length) rows.forEach(pick);
            else document.querySelectorAll('a[href*="/video/"]').forEach(a => { const id = (a.getAttribute('href').match(/\/video\/([\w-]{6,})/) || [])[1]; if (id) out.push({ id, vis: '', txt: '' }); });
            return out;
        });
        batch.forEach(r => { if (!seen.has(r.id)) seen.set(r.id, r); });
        await page.mouse.wheel(0, 4000); await page.waitForTimeout(700);
        if (scroll > 3 && batch.length === 0) break;
    }
    const PRIV = /\b(Private|Unlisted|Draft|Scheduled)\b/i, cutoff = Date.now() - WINDOW_MS;
    const kept = [], dPriv = [], dOld = [];
    for (const [id, r] of seen) {
        if (r.vis ? PRIV.test(r.vis) : PRIV.test(r.txt)) { dPriv.push(id); continue; }   // exclude private/unlisted/draft/scheduled
        const dm = r.txt.match(/([A-Z][a-z]{2,9}\.? \d{1,2}, \d{4})/);                    // grid publish date, if legible
        if (dm) { const t = Date.parse(dm[1].replace('.', '')); if (!isNaN(t) && t < cutoff) { dOld.push(id); continue; } }
        kept.push(id);
    }
    console.log(`  discovery: ${seen.size} found → ${kept.length} public & last-3yr kept · ${dPriv.length} private/unlisted/draft skipped · ${dOld.length} older-than-3yr skipped (fetchMeta re-checks each)`);
    return kept;
}

// public video metadata (views/title/duration/date) via a SECOND tab in the same logged-in
// browser — cookied, so no consent wall, and it leaves the Studio channel context untouched.
async function fetchMeta(metaPage, videoId) {
    try {
        await metaPage.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await metaPage.waitForTimeout(400);
        return await metaPage.evaluate(() => {
            const r = window.ytInitialPlayerResponse || {}; const vd = r.videoDetails || {}, mf = (r.microformat || {}).playerMicroformatRenderer || {};
            return { title: vd.title || null, views: parseInt(vd.viewCount) || null, duration_s: parseInt(vd.lengthSeconds) || null, published: mf.publishDate || mf.uploadDate || null, is_private: !!vd.isPrivate, is_unlisted: !!mf.isUnlisted };
        });
    } catch (e) { return {}; }
}

// ── reach parse (CTR + impressions) ───────────────────────────────────────────
// Confirmed from a real Studio get_screen payload: each metric is a metricColumns[] entry
//   { "metric": { "type": "VIDEO_THUMBNAIL_IMPRESSIONS" }, "counts": { "values": [ …daily… ] } }
// Impressions = Σ VIDEO_THUMBNAIL_IMPRESSIONS counts; CTR = VIDEO_THUMBNAIL_IMPRESSIONS_VTR
// (a 0..1 ratio) impressions-weighted over its daily values. Recursive walk → robust to nesting.
function reachColumns(body) {
    let root; try { root = JSON.parse(body.replace(/^\)\]\}'\s*/, '')); } catch (e) { return []; }
    const cols = [];
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        const type = o.metric && (o.metric.type || (typeof o.metric === 'string' ? o.metric : null));
        if (type && o.counts && Array.isArray(o.counts.values)) cols.push({ type, values: o.counts.values });
        for (const k in o) walk(o[k]);
    })(root);
    return cols;
}
function parseReach(body) {
    const cols = reachColumns(body);
    const byType = t => cols.filter(c => c.type === t);
    const sum = a => a.reduce((x, y) => x + (+y || 0), 0);
    // a metric can appear at several time ranges (same type, different sums) — take the widest (largest total)
    const impCols = byType('VIDEO_THUMBNAIL_IMPRESSIONS');
    let imp = null; for (const c of impCols) { const s = sum(c.values); if (!imp || s > imp._sum) imp = { values: c.values, _sum: s }; }
    const impressions = imp ? Math.round(imp._sum) : null;
    // CTR = the VTR column matching the chosen impressions range (same length), impressions-weighted
    const vtrCols = byType('VIDEO_THUMBNAIL_IMPRESSIONS_VTR');
    let vtr = imp ? vtrCols.find(c => c.values.length === imp.values.length) : null; vtr = vtr || vtrCols[0];
    let ctr = null;
    if (vtr && imp && vtr.values.length === imp.values.length) {
        let num = 0, den = 0;
        for (let i = 0; i < vtr.values.length; i++) { const w = +imp.values[i] || 0; num += (+vtr.values[i] || 0) * w; den += w; }
        ctr = den ? num / den : null;
    } else if (vtr) ctr = vtr.values.length ? sum(vtr.values) / vtr.values.length : null;
    if (ctr != null && ctr <= 1) ctr *= 100;           // ratio → percent
    return { impressions, ctr: ctr != null ? +ctr.toFixed(2) : null };
}

// ── retention parse (relative + absolute curves, ret5, ret30, avg_view_duration) ──
// curve      = retentionValues/100  (relative-retention ratios, same as the Shorts 211)
// curve_abs  = absolute audience-watch series/100 if the payload carries one (else null)
// ret5/ret30 = relative retention interpolated at 5s / 30s
// avg_view_duration = avgPercentageWatched × videoDurationMs (ms)
function extractArray(body, key) {
    const idx = body.indexOf('"' + key + '"');
    if (idx < 0) return null;
    const lb = body.indexOf('[', idx), rb = body.indexOf(']', lb);
    if (lb < 0 || rb < 0) return null;
    try { const a = JSON.parse(body.slice(lb, rb + 1)); return (Array.isArray(a) && a.length) ? a : null; } catch (e) { return null; }
}
function parseRetention(body, videoId) {
    const arr = extractArray(body, 'retentionValues');
    if (!arr) return {};
    // absolute series — key varies by Studio version; try the common candidates (needs live verify).
    const absArr = extractArray(body, 'absoluteRetentionValues')
                || extractArray(body, 'absoluteAudienceWatchRatios')
                || extractArray(body, 'audienceWatchRatios');
    const dur = +((body.match(/"videoDurationMs"\s*:\s*"?([0-9]+)"?/) || [])[1]) || null;
    const apw = (body.match(/"avgPercentageWatched"\s*:\s*([0-9.]+)/) || [])[1];
    // interpolate the relative curve at `ms` (clamped to the ends).
    const at = (a, d, ms) => { const pos = (ms / d) * (a.length - 1), lo = Math.max(0, Math.floor(pos)), hi = Math.min(a.length - 1, Math.ceil(pos)), f = pos - lo; return a[lo] + (a[hi] - a[lo]) * f; };
    return {
        curve: arr.map(v => +(v / 100).toFixed(4)),
        curve_abs: absArr ? absArr.map(v => +(v / 100).toFixed(4)) : null,
        ret5: dur ? +at(arr, dur, 5000).toFixed(1) : null,
        ret30: dur ? +at(arr, dur, 30000).toFixed(1) : null,
        avg_retention: apw ? +(+apw * 100).toFixed(2) : null,
        avg_view_duration: (apw != null && dur != null) ? Math.round(+apw * dur) : null,
    };
}

// one-time raw-payload dumps so we can pin the EXACT Studio metric keys (dir is gitignored)
let _dbgReach = true, _dbgRet = true;

// load the Reach tab so its get_screen payload (impressions/CTR) fires, capture it.
// domcontentloaded (NOT networkidle — Studio's SPA never idles → 30s hangs + tab instability),
// then poll until the get_screen XHR arrives.
async function scrapeReach(page, videoId) {
    let body = null, any = null;   // body = the get_screen carrying impression counts; any = last seen (for the debug dump)
    const h = async (resp) => { try { const u = resp.url(); if (u.includes('youtubei') && u.includes('get_screen')) { const b = await resp.text(); any = b; if (b.includes('VIDEO_THUMBNAIL_IMPRESSIONS') && b.includes('counts')) body = b; } } catch (e) {} };
    page.on('response', h);
    try {
        await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-reach`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        for (let t = 0; t < 40 && !body; t++) await page.waitForTimeout(500);   // up to ~20s for the reach XHR to fire
    } finally { try { page.off('response', h); } catch (e) {} }
    const use = body || any;
    if (use && _dbgReach) { _dbgReach = false; try { fs.writeFileSync(path.join(RET_DIR, '_debug_reach.json'), use); console.log('\n  [debug] wrote first Reach payload → longform-study/retention/_debug_reach.json'); } catch (e) {} }
    return use ? parseReach(use) : {};
}

// load the video's analytics so the get_screen payload (with the retention curve) fires, capture it
async function scrapeRetention(page, videoId) {
    let body = null;
    const h = async (resp) => { try { const u = resp.url(); if (u.includes('youtubei') && u.includes('get_screen')) { const b = await resp.text(); if (b.includes('retentionValues')) body = b; } } catch (e) {} };
    page.on('response', h);
    try {
        for (const tab of ['tab-overview', 'tab-engagement']) {
            if (body) break;
            await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/${tab}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            for (let t = 0; t < 24 && !body; t++) await page.waitForTimeout(500);   // up to ~12s per tab
        }
    } finally { try { page.off('response', h); } catch (e) {} }
    if (body && _dbgRet) { _dbgRet = false; try { fs.writeFileSync(path.join(RET_DIR, '_debug_retention.json'), body); console.log('\n  [debug] wrote first Retention payload → longform-study/retention/_debug_retention.json'); } catch (e) {} }
    return body ? parseRetention(body, videoId) : {};
}

// map one scraped long-form video to the row schema
function toRow(videoId, d, meta) {
    const m = meta || {};
    return {
        id: videoId,
        url: `https://youtube.com/watch?v=${videoId}`,
        title: m.title != null ? m.title : null,
        published: m.published != null ? m.published : null,
        ctr: d.ctr != null ? d.ctr : null,
        impressions: d.impressions != null ? d.impressions : null,
        avg_retention: d.avg_retention != null ? d.avg_retention : null,
        ret30: d.ret30 != null ? d.ret30 : null,
        ret5: d.ret5 != null ? d.ret5 : null,
        avg_view_duration: d.avg_view_duration != null ? d.avg_view_duration : null,
        views: m.views != null ? m.views : null,
        duration_s: m.duration_s != null ? m.duration_s : null,
        curve: d.curve || [],
        curve_abs: d.curve_abs || [],
        scraped_at: new Date().toISOString(),
    };
}

async function registerChannel(id, name, n) {
    let cj = { active: 'tyler', channels: [] };
    try { cj = JSON.parse(fs.readFileSync(CHANNELS_JSON, 'utf8')); } catch (e) {}
    // always keep Main (id "tyler") as the first channel
    if (!cj.channels.some(c => c.id === 'tyler')) cj.channels.unshift({ id: 'tyler', name: 'Main', table: 'longform/ret_tyler.json', n: 0, owner: true });
    const ix = cj.channels.findIndex(c => c.id === id);
    const entry = { id, name, table: `longform/ret_${id}.json`, n, scraped: new Date().toISOString() };
    if (ix >= 0) cj.channels[ix] = Object.assign(cj.channels[ix], entry); else cj.channels.push(entry);
    fs.writeFileSync(CHANNELS_JSON, JSON.stringify(cj, null, 2));
    await r2put('longform/channels.json', cj);     // R2 = source of truth for the deployed app
    console.log(`[channels] registered ${id} (${n} videos) → longform/channels.json + R2`);
}

async function main() {
    if (!fs.existsSync(CONFIG)) {
        console.error(`Missing ${path.basename(CONFIG)} — see the header of this file for the format.`);
        process.exit(1);
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    fs.mkdirSync(RET_DIR, { recursive: true });
    const context = await chromium.launchPersistentContext(scraper.SESSION_DIR, { headless: false, channel: 'chrome', viewport: { width: 1280, height: 900 } });
    let page = context.pages()[0] || await context.newPage();
    let metaPage = await context.newPage();   // separate tab for public metadata (keeps Studio context)
    await page.bringToFront();
    await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded' });
    await ask('\nMake sure you are LOGGED IN to YouTube Studio in the Chrome window, then press Enter…');

    for (const ch of cfg.channels) {
        console.log(`\n=== Channel: ${ch.name} (${ch.id}) — LONG-FORM ===`);
        await ask(`Switch Chrome to "${ch.name}" via the account menu (top-right), then press Enter…`);
        let ids = ch.videoIdsLong || [];   // optional long-form-specific id list; else discover
        if (!ids.length) { console.log('Discovering this channel\'s long-form uploads…'); ids = await discoverVideoIds(page); }
        if (ch.limit) { ids = ids.slice(0, ch.limit); console.log(`(limit ${ch.limit} for a quick test)`); }
        console.log(`${ids.length} long-form videos to scrape for ${ch.name}.`);
        const rows = [];
        const save = async (final) => {
            const table = { meta: { n: rows.length, channel: ch.name, channel_id: ch.id, scraped_at: new Date().toISOString() }, videos: rows };
            await r2put(`longform/ret_${ch.id}.json`, table);   // per-channel table (R2)
            await registerChannel(ch.id, ch.name, rows.length);
            if (final) console.log(`Saved longform/ret_${ch.id}.json (${rows.length} videos) → R2.`);
            else console.log(`  …progress saved (${rows.length}/${ids.length}) → R2`);
        };
        const cutoff = Date.now() - WINDOW_MS;
        let skipPriv = 0, skipOld = 0;
        for (let i = 0; i < ids.length; i++) {
            process.stdout.write(`  [${i + 1}/${ids.length}] ${ids[i]} … `);
            try {
                // recover a tab that died mid-run (Studio can close it) instead of failing every remaining video
                if (page.isClosed() || metaPage.isClosed()) {
                    try { if (page.isClosed()) page = await context.newPage(); if (metaPage.isClosed()) metaPage = await context.newPage(); }
                    catch (e) { console.log('\n⚠ browser/context closed — stopping this channel (re-run to resume; saved videos are already on R2).'); break; }
                }
                const meta = await fetchMeta(metaPage, ids[i]);         // views / title / duration / published (PUBLIC watch page)
                // GATE: only PUBLIC videos from the last 3 years. Private + Unlisted (owner still sees
                // metadata, so use videoDetails.isPrivate + microformat.isUnlisted) and unavailable are
                // dropped; so is anything older than the window.
                if (meta.is_private || meta.is_unlisted) { skipPriv++; console.log(`skip (${meta.is_private ? 'private' : 'unlisted'})`); continue; }
                const pub = meta.published ? Date.parse(meta.published) : NaN;
                if (isNaN(pub)) { skipPriv++; console.log('skip (unavailable — no public metadata)'); continue; }
                if (pub < cutoff) { skipOld++; console.log(`skip (older than 3yr · ${String(meta.published).slice(0, 10)})`); continue; }
                const reach = await scrapeReach(page, ids[i]);          // ctr / impressions
                const ret = await scrapeRetention(page, ids[i]);        // curve / curve_abs / ret5 / ret30 / avg_view_duration
                const row = toRow(ids[i], Object.assign({}, reach, ret), meta);
                rows.push(row);
                // per-video files (local + R2)
                fs.writeFileSync(path.join(RET_DIR, `${ids[i]}.json`), JSON.stringify(row));
                await r2put(`longform/ret_${ids[i]}.json`, row);
                console.log(`ok (ctr ${row.ctr != null ? row.ctr + '%' : '—'} · impr ${row.impressions != null ? row.impressions.toLocaleString() : '—'} · ret30 ${row.ret30 != null ? row.ret30 : '—'} · curve ${row.curve.length}pts · ${row.views != null ? row.views.toLocaleString() + ' views' : 'no meta'})`);
            } catch (e) { console.log('failed:', e.message.slice(0, 60)); }
            if (rows.length && (i + 1) % 20 === 0) await save(false);      // checkpoint every 20
        }
        console.log(`  ${ch.name}: ${rows.length} public last-3yr videos scraped · skipped ${skipPriv} private/unlisted/unavailable · ${skipOld} older-than-3yr`);
        await save(true);
    }
    await context.close();
    console.log('\nDone. Long-form rows written to buildings/jarvis/longform-study + R2 longform/*.');
}
main().catch(e => { console.error(e); process.exit(1); });
