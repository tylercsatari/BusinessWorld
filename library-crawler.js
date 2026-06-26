// library-crawler.js — Builds the big RESEARCH dataset: ~100k last-year Shorts, 10k–<100M views,
// full 720p video stored on R2 (library/videos/<id>.mp4). Reuses shorts-crawler's InnerTube
// discovery (no API quota). Resumable + deduped via library/db.json on R2. Separate from the
// existing 100M-view crawler so that flow is untouched.

try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const cloud = require('./cloud-storage');
const sc = require('./shorts-crawler');
if (cloud.initR2 && !cloud.isR2Ready()) cloud.initR2();

const MIN_VIEWS = 10_000;
const MAX_VIEWS = 100_000_000;          // strictly < 100M (no overlap with the owned/100M set)
const TARGET = 100_000;
const UPLOAD_DATE = 5;                    // YouTube filter: this year
const CONC = 4;                           // concurrent downloads
const DB_KEY = 'library/db.json';
const STATS_KEY = 'library/stats.json';
const LOCAL_DB = path.join(__dirname, 'library-db.json');

// broader query pool than the 100M crawler (long-tail diversity to reach 100k distinct)
const QUERIES = [...sc.SHORTS_QUERIES,
    'how to', 'tutorial', 'explained', 'review', 'unboxing', 'vlog', 'storytime', 'motivation',
    'football', 'basketball', 'soccer', 'workout', 'recipe', 'travel', 'nature', 'wildlife',
    'tech', 'phone', 'ai', 'coding', 'finance', 'stocks', 'crypto', 'real estate', 'business',
    'history', 'geography', 'space', 'physics', 'biology', 'psychology', 'facts', 'trivia',
    'guitar', 'piano', 'drums', 'rap', 'edit', 'amv', 'cosplay', 'makeup', 'skincare', 'fashion',
    'street food', 'baking', 'coffee', 'bbq', 'gardening', 'woodworking', 'pottery', 'painting',
    'skateboarding', 'parkour', 'climbing', 'surfing', 'boxing', 'mma', 'chess', 'cards',
    'dog', 'cat', 'horse', 'bird', 'fish', 'reptile', 'farm', 'wildlife rescue',
    'car review', 'motorcycle', 'truck', 'racing', 'drift', 'mechanic',
    'language', 'study', 'exam', 'school', 'college', 'productivity', 'minimalism',
    'comedy skit', 'standup', 'impression', 'voice', 'animation', 'cartoon',
];

let db = null, running = false, stop = false;

async function loadDb() {
    if (db) return db;
    try {
        if (fs.existsSync(LOCAL_DB)) { db = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8')); return db; }
        const buf = await cloud.downloadFromR2(DB_KEY);
        if (buf) { db = JSON.parse(buf.toString('utf8')); return db; }
    } catch (e) { console.warn('library: loadDb', e.message); }
    db = { videos: {}, updated: 0 };
    return db;
}

let saveT = 0;
async function saveDb(force) {
    if (!db) return;
    const now = Date.now();
    if (!force && now - saveT < 20000) return;       // throttle
    saveT = now; db.updated = now;
    try { fs.writeFileSync(LOCAL_DB, JSON.stringify(db)); } catch (e) {}
    try {
        await cloud.uploadToR2(DB_KEY, Buffer.from(JSON.stringify(db)), 'application/json');
        await cloud.uploadToR2(STATS_KEY, Buffer.from(JSON.stringify(computeStats())), 'application/json');
    } catch (e) { console.warn('library: saveDb', e.message); }
}

function computeStats() {
    const vids = Object.values(db.videos);
    const stored = vids.filter(v => v.stored);
    const bytes = stored.reduce((s, v) => s + (v.sizeBytes || 0), 0);
    const buckets = { '10k-100k': 0, '100k-1M': 0, '1M-10M': 0, '10M-100M': 0 };
    for (const v of stored) {
        const x = v.views;
        if (x < 1e5) buckets['10k-100k']++; else if (x < 1e6) buckets['100k-1M']++;
        else if (x < 1e7) buckets['1M-10M']++; else buckets['10M-100M']++;
    }
    return { target: TARGET, discovered: vids.length, stored: stored.length, storageBytes: bytes,
        minViews: MIN_VIEWS, maxViews: MAX_VIEWS, viewBuckets: buckets, updated: Date.now(),
        avgSizeMB: stored.length ? +(bytes / stored.length / 1e6).toFixed(2) : 0 };
}

// exclude videos older than ~1 year using the relative "published" text
function withinLastYear(pub) {
    if (!pub) return true;                       // unknown → keep (search already date-filtered)
    return !/year/i.test(pub);                   // "1 year ago" / "2 years ago" → drop
}

async function discover() {
    const seen = new Set(Object.keys(db.videos));
    let added = 0;
    // both view-sorted (high-view) and date-sorted (long tail) this-year shorts
    for (const sort of [3, 1]) {
        const sp = sc.buildSP(sort, UPLOAD_DATE, 6, null);
        for (const q of QUERIES) {
            if (stop) return added;
            let vids = [];
            try { vids = await sc.innerTubeSearch(q, sp); } catch (e) { continue; }
            for (const v of vids) {
                if (!v.videoId || seen.has(v.videoId)) continue;
                if (!(v.views >= MIN_VIEWS && v.views < MAX_VIEWS)) continue;
                if (!sc.isShort(v) || !withinLastYear(v.publishedAt)) continue;
                seen.add(v.videoId); added++;
                db.videos[v.videoId] = { videoId: v.videoId, title: v.title, channel: v.channelTitle,
                    views: v.views, publishedAt: v.publishedAt, duration: v.duration, stored: false, addedAt: Date.now() };
            }
            await saveDb(false);
            if (added >= 800) return added;                                    // interleave: go download these
            if (Object.keys(db.videos).length >= TARGET * 1.3) return added;   // enough candidates queued
        }
    }
    return added;
}

function ytdl(id, out) {
    return new Promise((resolve, reject) => {
        execFile('yt-dlp', ['--no-playlist', '-q', '--no-warnings', '--no-progress',
            '-f', 'bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best', '--merge-output-format', 'mp4',
            '-o', out, `https://www.youtube.com/watch?v=${id}`],
            { timeout: 180000 }, (err) => err ? reject(err) : resolve());
    });
}

async function downloadOne(v) {
    const tmp = path.join(os.tmpdir(), `lib_${v.videoId}.mp4`);
    try {
        await ytdl(v.videoId, tmp);
        if (!fs.existsSync(tmp)) throw new Error('no file');
        const buf = fs.readFileSync(tmp);
        await cloud.uploadToR2(`library/videos/${v.videoId}.mp4`, buf, 'video/mp4');
        v.stored = true; v.sizeBytes = buf.length; v.r2Key = `library/videos/${v.videoId}.mp4`; v.storedAt = Date.now();
    } catch (e) {
        v.failed = (v.failed || 0) + 1; v.lastError = String(e.message || e).slice(0, 80);
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) {}
    }
}

async function downloadPending() {
    const pending = Object.values(db.videos).filter(v => !v.stored && (v.failed || 0) < 3);
    let done = 0;
    for (let i = 0; i < pending.length && !stop; i += CONC) {
        const batch = pending.slice(i, i + CONC);
        await Promise.all(batch.map(downloadOne));
        done += batch.length;
        await saveDb(false);
        const stored = Object.values(db.videos).filter(v => v.stored).length;
        if (done % 20 === 0) console.log(`library: ${stored} stored / ${Object.keys(db.videos).length} discovered`);
        if (stored >= TARGET) { stop = true; break; }
    }
    return done;
}

async function run() {
    if (running) return; running = true; stop = false;
    await loadDb();
    console.log(`library-crawler: ${computeStats().stored} stored, target ${TARGET}`);
    while (!stop) {
        const storedNow = Object.values(db.videos).filter(v => v.stored).length;
        if (storedNow >= TARGET) break;
        const pending = Object.values(db.videos).filter(v => !v.stored && (v.failed || 0) < 3).length;
        if (pending < CONC * 10) { console.log('library: discovering…'); await discover(); }
        await downloadPending();
        await saveDb(true);
    }
    await saveDb(true); running = false;
    console.log('library-crawler: done', computeStats());
}

module.exports = { run, loadDb, computeStats, stopCrawl: () => { stop = true; } };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
