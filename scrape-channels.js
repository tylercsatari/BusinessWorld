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

// map one scraped video to the retention_table.json row format (same fields as the 211)
function toRow(videoId, d, meta) {
    return Object.assign({ id: videoId, url: `https://youtube.com/watch?v=${videoId}`, scraped_at: new Date().toISOString() }, meta || {}, d, {
        keep_rate: d.keep_rate != null ? d.keep_rate : d.stayedToWatch,
        swiped: d.swiped != null ? d.swiped : d.swipedAway,
    });
}

function registerChannel(id, name, n) {
    let cj = { active: 'tyler', channels: [] };
    try { cj = JSON.parse(fs.readFileSync(CHANNELS_JSON, 'utf8')); } catch (e) {}
    const ix = cj.channels.findIndex(c => c.id === id);
    const entry = { id, name, table: `retention/${id}.json`, n, scraped: new Date().toISOString() };
    if (ix >= 0) cj.channels[ix] = Object.assign(cj.channels[ix], entry); else cj.channels.push(entry);
    fs.writeFileSync(CHANNELS_JSON, JSON.stringify(cj, null, 2));
    console.log(`[channels] registered ${id} (${n} videos) → channels.json`);
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
        for (let i = 0; i < ids.length; i++) {
            process.stdout.write(`  [${i + 1}/${ids.length}] ${ids[i]} … `);
            try { const d = await scraper.scrapeOneVideo(page, ids[i]); const meta = await fetchMeta(metaPage, ids[i]); rows.push(toRow(ids[i], d, meta)); console.log(`ok (keep ${d.stayedToWatch}% · ${meta.views != null ? meta.views.toLocaleString() + ' views' : 'no meta'})`); }
            catch (e) { console.log('failed:', e.message.slice(0, 60)); }
            // FIRST video only: capture the Studio analytics payloads (BROAD filter — the data
            // comes via get_screen/creator endpoints, not URLs containing "analytics") by
            // explicitly loading the engagement + overview tabs so the retention graph fetches.
            if (i === 0) {
                const cap = [];
                const h = async (resp) => { const u = resp.url(); if (u.includes('youtubei') && /get_screen|creator|analytics|explore|insights/.test(u)) { try { const b = await resp.text(); if (b && b.length > 300) cap.push({ url: u.slice(0, 200), len: b.length, body: b.slice(0, 500000) }); } catch (e) {} } };
                page.on('response', h);
                for (const tab of ['tab-engagement', 'tab-overview']) { await page.goto(`https://studio.youtube.com/video/${ids[0]}/analytics/${tab}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await page.waitForTimeout(3000); }
                page.off('response', h);
                fs.writeFileSync(path.join(__dirname, `analytics-debug-${ch.id}.json`), JSON.stringify(cap));
                console.log(`  ↳ captured ${cap.length} analytics payloads → analytics-debug-${ch.id}.json (send me this)`);
            }
        }
        const out = { meta: { n: rows.length, channel: ch.name, channel_id: ch.id, scraped_at: new Date().toISOString() }, videos: rows };
        fs.writeFileSync(path.join(RET_DIR, `${ch.id}.json`), JSON.stringify(out));
        registerChannel(ch.id, ch.name, rows.length);
        console.log(`Saved retention/${ch.id}.json (${rows.length} videos).`);
    }
    await context.close();
    console.log('\nDone. The new channels now appear as tabs in BusinessWorld → Retention→Views.');
}
main().catch(e => { console.error(e); process.exit(1); });
