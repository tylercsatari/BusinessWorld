#!/usr/bin/env node
// scrape-channels.js — MULTI-CHANNEL retention/swipe scraper. Wraps the existing
// swipe-scraper (same per-video Studio logic) and loops over every channel you have
// permission to. For each channel you switch the active account in the headed Chrome,
// it lists that channel's Shorts and scrapes the retention curve + swipe-away + views,
// then writes buildings/jarvis/retention-study/retention/<id>.json and registers it in
// channels.json so a new tab appears in BusinessWorld automatically.
//
// SETUP: create scrape-channels.config.json:
//   { "channels": [ { "id": "alice", "name": "Alice's Channel" },
//                    { "id": "bob",   "name": "Bob FPV", "videoIds": ["abc","def"] } ] }
//   (videoIds optional — if omitted it auto-discovers from that channel's Studio content page)
//
// RUN: node scrape-channels.js
//   It opens real Chrome (your logged-in profile). When it pauses for a channel, use the
//   account menu (top-right in Studio) to SWITCH to that channel, then press Enter.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const scraper = require('./swipe-scraper');
let cloud = null; try { require('dotenv').config(); cloud = require('./cloud-storage'); if (cloud.initR2) cloud.initR2(); } catch (e) { console.warn('cloud-storage unavailable — R2 upload skipped'); }
async function r2put(key, obj) { if (!cloud || !cloud.uploadToR2) return; try { await cloud.uploadToR2(key, Buffer.from(JSON.stringify(obj)), 'application/json'); console.log(`  [R2] uploaded ${key}`); } catch (e) { console.warn(`  [R2] upload failed ${key}:`, e.message); } }

const STUDY = path.join(__dirname, 'buildings/jarvis/retention-study');
const RET_DIR = path.join(STUDY, 'retention');
const CHANNELS_JSON = path.join(STUDY, 'channels.json');
const CONFIG = path.join(__dirname, 'scrape-channels.config.json');

const ask = (q) => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a); }); });

// pull every video id off the current channel's Studio content (Shorts) listing
async function discoverVideoIds(page) {
    // read the ACTIVE channel id (Studio puts it in the URL once a channel is selected), then
    // open that channel's Shorts content listing.
    await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const m = page.url().match(/channel\/(UC[\w-]+)/);
    const chId = m ? m[1] : null;
    console.log(chId ? `  active channel: ${chId}` : '  (could not read active channel id — scraping whatever content page loads)');
    const url = chId ? `https://studio.youtube.com/channel/${chId}/videos/short` : 'https://studio.youtube.com';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const ids = new Set();
    for (let scroll = 0; scroll < 40; scroll++) {
        const batch = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/video/"]')).map(a => (a.getAttribute('href').match(/\/video\/([\w-]{6,})/) || [])[1]).filter(Boolean));
        batch.forEach(id => ids.add(id));
        await page.mouse.wheel(0, 4000); await page.waitForTimeout(700);
        if (scroll > 3 && batch.length === 0) break;
    }
    return [...ids];
}

// public video metadata (views/title/duration/date) via a SECOND tab in the same logged-in
// browser — cookied, so no consent wall, and it leaves the Studio channel context untouched.
async function fetchMeta(metaPage, videoId) {
    try {
        await metaPage.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await metaPage.waitForTimeout(400);
        return await metaPage.evaluate(() => {
            const r = window.ytInitialPlayerResponse || {}; const vd = r.videoDetails || {}, mf = (r.microformat || {}).playerMicroformatRenderer || {};
            return { title: vd.title || null, views: parseInt(vd.viewCount) || null, duration_s: parseInt(vd.lengthSeconds) || null, published: mf.publishDate || mf.uploadDate || null };
        });
    } catch (e) { return {}; }
}

// parse the retention curve out of a Studio get_screen payload → same fields as the 211:
//   curve = retentionValues/100 (relative-retention ratios) · ret5 = relative retention at 5s
//   · avg_retention = avgPercentageWatched×100. (Verified to the decimal against the 211.)
function parseRetention(body, videoId) {
    const idx = body.indexOf('"retentionValues"');
    if (idx < 0) return {};
    const lb = body.indexOf('[', idx), rb = body.indexOf(']', lb);
    let arr; try { arr = JSON.parse(body.slice(lb, rb + 1)); } catch (e) { return {}; }
    if (!Array.isArray(arr) || !arr.length) return {};
    const dur = +((body.match(/"videoDurationMs"\s*:\s*"?([0-9]+)"?/) || [])[1]) || null;
    const apw = (body.match(/"avgPercentageWatched"\s*:\s*([0-9.]+)/) || [])[1];
    const at5 = (a, d) => { const pos = (5000 / d) * (a.length - 1), lo = Math.max(0, Math.floor(pos)), hi = Math.min(a.length - 1, Math.ceil(pos)), f = pos - lo; return a[lo] + (a[hi] - a[lo]) * f; };
    return { curve: arr.map(v => +(v / 100).toFixed(4)), ret5: dur ? +at5(arr, dur).toFixed(1) : null, avg_retention: apw ? +(+apw * 100).toFixed(2) : null };
}

// load the video's analytics so the get_screen payload (with the retention curve) fires, capture it
async function scrapeRetention(page, videoId) {
    let body = null;
    const h = async (resp) => { const u = resp.url(); if (u.includes('youtubei') && u.includes('get_screen')) { try { const b = await resp.text(); if (b.includes('retentionValues')) body = b; } catch (e) {} } };
    page.on('response', h);
    for (const tab of ['tab-overview', 'tab-engagement']) { if (body) break; await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/${tab}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2500); }
    page.off('response', h);
    return body ? parseRetention(body, videoId) : {};
}

// map one scraped video to the retention_table.json row format (same fields as the 211)
function toRow(videoId, d, meta) {
    return Object.assign({ id: videoId, url: `https://youtube.com/watch?v=${videoId}`, scraped_at: new Date().toISOString() }, meta || {}, d, {
        keep_rate: d.keep_rate != null ? d.keep_rate : d.stayedToWatch,
        swiped: d.swiped != null ? d.swiped : d.swipedAway,
    });
}

async function registerChannel(id, name, n) {
    let cj = { active: 'tyler', channels: [] };
    try { cj = JSON.parse(fs.readFileSync(CHANNELS_JSON, 'utf8')); } catch (e) {}
    // always keep Main (the 211) as the first, static-loaded channel
    if (!cj.channels.some(c => c.id === 'tyler')) cj.channels.unshift({ id: 'tyler', name: 'Main', table: 'retention_table.json', n: 211, owner: true });
    const ix = cj.channels.findIndex(c => c.id === id);
    const entry = { id, name, table: `retention/${id}.json`, n, scraped: new Date().toISOString() };
    if (ix >= 0) cj.channels[ix] = Object.assign(cj.channels[ix], entry); else cj.channels.push(entry);
    fs.writeFileSync(CHANNELS_JSON, JSON.stringify(cj, null, 2));
    await r2put('retention/channels.json', cj);     // R2 = source of truth for the deployed app
    console.log(`[channels] registered ${id} (${n} videos) → channels.json + R2`);
}

async function main() {
    if (!fs.existsSync(CONFIG)) {
        console.error('Missing scrape-channels.config.json — see the header of this file for the format.');
        process.exit(1);
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    fs.mkdirSync(RET_DIR, { recursive: true });
    const context = await chromium.launchPersistentContext(scraper.SESSION_DIR, { headless: false, channel: 'chrome', viewport: { width: 1280, height: 900 } });
    const page = context.pages()[0] || await context.newPage();
    const metaPage = await context.newPage();   // separate tab for public metadata (keeps Studio context)
    await page.bringToFront();
    await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded' });
    await ask('\nMake sure you are LOGGED IN to YouTube Studio in the Chrome window, then press Enter…');

    for (const ch of cfg.channels) {
        console.log(`\n=== Channel: ${ch.name} (${ch.id}) ===`);
        await ask(`Switch Chrome to "${ch.name}" via the account menu (top-right), then press Enter…`);
        let ids = ch.videoIds || [];
        if (!ids.length) { console.log('Discovering this channel\'s videos…'); ids = await discoverVideoIds(page); }
        if (ch.limit) { ids = ids.slice(0, ch.limit); console.log(`(limit ${ch.limit} for a quick test)`); }
        console.log(`${ids.length} videos to scrape for ${ch.name}.`);
        const rows = [];
        const save = async (final) => {
            const out = { meta: { n: rows.length, channel: ch.name, channel_id: ch.id, scraped_at: new Date().toISOString() }, videos: rows };
            fs.writeFileSync(path.join(RET_DIR, `${ch.id}.json`), JSON.stringify(out));
            await r2put(`retention/${ch.id}.json`, out);
            await registerChannel(ch.id, ch.name, rows.length);
            if (final) console.log(`Saved retention/${ch.id}.json (${rows.length} videos) → local + R2.`);
            else console.log(`  …progress saved (${rows.length}/${ids.length}) → local + R2`);
        };
        for (let i = 0; i < ids.length; i++) {
            process.stdout.write(`  [${i + 1}/${ids.length}] ${ids[i]} … `);
            try {
                const d = await scraper.scrapeOneVideo(page, ids[i]);      // keep / swipe
                const ret = await scrapeRetention(page, ids[i]);           // curve / ret5 / avg_retention
                const meta = await fetchMeta(metaPage, ids[i]);            // views / title / duration
                rows.push(toRow(ids[i], Object.assign({}, d, ret), meta));
                console.log(`ok (keep ${d.stayedToWatch}% · ret5 ${ret.ret5 != null ? ret.ret5 : '—'} · curve ${ret.curve ? ret.curve.length + 'pts' : 'NONE'} · ${meta.views != null ? meta.views.toLocaleString() + ' views' : 'no meta'})`);
            } catch (e) { console.log('failed:', e.message.slice(0, 60)); }
            if (rows.length && (i + 1) % 20 === 0) await save(false);      // checkpoint every 20 so a long run can't lose everything
        }
        await save(true);
    }
    await context.close();
    console.log('\nDone. The new channels now appear as tabs in BusinessWorld → Retention→Views.');
}
main().catch(e => { console.error(e); process.exit(1); });
