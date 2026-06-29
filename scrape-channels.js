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
    await page.goto('https://studio.youtube.com/channel/UC/videos/short', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // Studio rewrites UC→the active channel; if it didn't, fall back to the default content tab
    if (!page.url().includes('/videos')) await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
    const ids = new Set();
    for (let scroll = 0; scroll < 40; scroll++) {
        const batch = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/video/"]')).map(a => (a.getAttribute('href').match(/\/video\/([\w-]{6,})/) || [])[1]).filter(Boolean));
        batch.forEach(id => ids.add(id));
        await page.mouse.wheel(0, 4000); await page.waitForTimeout(700);
        if (scroll > 3 && batch.length === 0) break;
    }
    return [...ids];
}

// map one scraped video to the retention_table.json row format (same fields as the 211)
function toRow(videoId, d) {
    return Object.assign({ id: videoId, url: `https://youtube.com/watch?v=${videoId}`, scraped_at: new Date().toISOString() }, d, {
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
    await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded' });
    await ask('\nMake sure you are LOGGED IN to YouTube Studio in the Chrome window, then press Enter…');

    for (const ch of cfg.channels) {
        console.log(`\n=== Channel: ${ch.name} (${ch.id}) ===`);
        await ask(`Switch Chrome to "${ch.name}" via the account menu (top-right), then press Enter…`);
        let ids = ch.videoIds || [];
        if (!ids.length) { console.log('Discovering this channel\'s videos…'); ids = await discoverVideoIds(page); }
        console.log(`${ids.length} videos to scrape for ${ch.name}.`);
        const rows = [];
        for (let i = 0; i < ids.length; i++) {
            process.stdout.write(`  [${i + 1}/${ids.length}] ${ids[i]} … `);
            try { const d = await scraper.scrapeOneVideo(page, ids[i]); rows.push(toRow(ids[i], d)); console.log('ok'); }
            catch (e) { console.log('failed:', e.message.slice(0, 60)); }
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
