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
const MAX_VIEWS = Infinity;             // 10k → ∞ (include recent 100M+; the date filter keeps it last-year)
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
    // broad single-word sweep — date-sorted, surfaces the long tail of recent uploads
    'amazing', 'wow', 'crazy', 'insane', 'epic', 'genius', 'wholesome', 'emotional', 'shocking',
    'before after', 'transformation', 'glow up', 'speedrun', 'world record', 'experiment', 'reaction',
    'tutorial beginner', 'pro tips', 'mistakes', 'hacks', 'gadget', 'invention', 'robot', 'drone',
    'football skills', 'goals', 'dunk', 'trick shot', 'gym', 'calisthenics', 'yoga', 'run', 'marathon',
    'guitar solo', 'beat', 'remix', 'mashup', 'acapella', 'orchestra', 'violin', 'dj', 'producer',
    'sushi', 'ramen', 'pizza', 'burger', 'dessert', 'cake', 'chocolate', 'spicy', 'mukbang', 'recipe easy',
    'puppy', 'kitten', 'parrot', 'snake', 'spider', 'shark', 'ocean', 'volcano', 'storm', 'aurora',
    'car mod', 'supercar', 'ev', 'tesla', 'engine', 'restoration', 'detailing',
    'magic', 'illusion', 'card trick', 'escape', 'puzzle', 'riddle', 'iq test', 'optical illusion',
    'art timelapse', 'sculpt', 'graffiti', 'tattoo', 'calligraphy', 'origami', 'lego', 'diorama',
    'fortnite', 'minecraft build', 'roblox', 'valorant', 'cod', 'gta', 'speedrun glitch', 'gaming setup',
    'history fact', 'ancient', 'war', 'science fact', 'math trick', 'coding tips', 'startup', 'investing',
    'plane', 'train', 'ship', 'submarine', 'rocket launch', 'nasa', 'telescope',
    'fashion haul', 'outfit', 'thrift', 'sneakers', 'watch', 'jewelry', 'nails',
    'farm life', 'harvest', 'tractor', 'fishing', 'hunting', 'camping', 'hiking', 'van life',
    'baby first', 'twins', 'grandma', 'wedding', 'proposal', 'surprise reunion', 'soldier homecoming',
    'asmr eating', 'asmr slime', 'soap cutting', 'kinetic sand', 'pressure wash', 'cleaning', 'restore',
    'street performer', 'busker', 'flash mob', 'crowd', 'concert', 'festival',
    'hindi', 'tamil', 'telugu', 'bhojpuri', 'punjabi', 'urdu', 'arabic', 'spanish', 'portuguese',
    'brasil', 'indonesia', 'filipino', 'korean', 'japanese', 'thai', 'vietnam', 'turkish', 'russian',
    'nigeria', 'kenya', 'egypt', 'mexico', 'colombia', 'argentina', 'france', 'germany', 'italy',
    'pov', 'storytime scary', 'true story', 'caught on camera', 'cctv', 'dashcam', 'bodycam',
    'life hack kitchen', 'diy home', 'organize', 'declutter', 'budget', 'side hustle', 'passive income',
    'prank gone wrong', 'social experiment', 'kindness', 'tip', 'homeless help', 'good deed',
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
    const buckets = { '10k-100k': 0, '100k-1M': 0, '1M-10M': 0, '10M-100M': 0, '100M+': 0 };
    let outliers = 0;
    for (const v of stored) {
        const x = v.views;
        if (x < 1e5) buckets['10k-100k']++; else if (x < 1e6) buckets['100k-1M']++;
        else if (x < 1e7) buckets['1M-10M']++; else if (x < 1e8) buckets['10M-100M']++; else buckets['100M+']++;
        if ((v.outlier || 0) >= 3) outliers++;
    }
    return { target: TARGET, discovered: vids.length, stored: stored.length, storageBytes: bytes,
        minViews: MIN_VIEWS, maxViews: MAX_VIEWS === Infinity ? null : MAX_VIEWS, viewBuckets: buckets, outliers3x: outliers,
        removed: vids.filter(v => v.removed).length, updated: Date.now(),
        avgSizeMB: stored.length ? +(bytes / stored.length / 1e6).toFixed(2) : 0 };
}

// exclude videos older than ~1 year using the relative "published" text
function withinLastYear(pub) {
    if (!pub) return true;                       // unknown → keep (search already date-filtered)
    return !/year/i.test(pub);                   // "1 year ago" / "2 years ago" → drop
}

// rotate through (sort × query) a FEW per call, then return so downloads run — tight interleave
let qPos = 0;
const SORTS = [3, 1];                      // 3 = view-count, 1 = upload-date (long tail)
const TOTAL_Q = () => SORTS.length * QUERIES.length;
async function discover() {
    const seen = new Set(Object.keys(db.videos));
    let added = 0;
    for (let n = 0; n < 8; n++) {          // ~8 queries per discover() call → yields to download often
        if (stop) break;
        const sort = SORTS[Math.floor(qPos / QUERIES.length) % SORTS.length];
        const q = QUERIES[qPos % QUERIES.length];
        qPos = (qPos + 1) % TOTAL_Q();
        let vids = [];
        try { vids = await sc.innerTubeSearch(q, sc.buildSP(sort, UPLOAD_DATE, 6, null)); } catch (e) { continue; }
        for (const v of vids) {
            if (!v.videoId || seen.has(v.videoId)) continue;
            if (!(v.views >= MIN_VIEWS && v.views < MAX_VIEWS)) continue;
            if (!sc.isShort(v) || !withinLastYear(v.publishedAt)) continue;
            seen.add(v.videoId); added++;
            db.videos[v.videoId] = { videoId: v.videoId, title: v.title, channel: v.channelTitle,
                views: v.views, publishedAt: v.publishedAt, duration: v.duration, stored: false, addedAt: Date.now() };
        }
    }
    await saveDb(false);
    return added;
}

// full metadata dump (no download) — dimensions for the vertical filter + everything else
function ytJson(id) {
    return new Promise(res => execFile('yt-dlp', ['--no-playlist', '-q', '--no-warnings', '-J', `https://www.youtube.com/watch?v=${id}`],
        { timeout: 70000, maxBuffer: 96 * 1024 * 1024 }, (err, out) => { if (err) return res(null); try { res(JSON.parse(out)); } catch { res(null); } }));
}
// VERTICAL short only — reject horizontal/square (poisons the set) and long-form
function isVerticalShort(info) {
    const w = info.width || 0, h = info.height || 0, d = info.duration || 0;
    if (w && h && h <= w) return false;     // horizontal or square
    if (d && d > 185) return false;          // long-form
    return true;
}
const chanCache = {};
function flatChannel(cid) {
    return new Promise(res => execFile('yt-dlp', ['--flat-playlist', '--no-warnings', '-I', '1:30', '--print', '%(id)s|%(view_count)s',
        `https://www.youtube.com/channel/${cid}/videos`], { timeout: 70000, maxBuffer: 16 * 1024 * 1024 },
        (err, out) => res(err ? [] : out.trim().split('\n').map(l => { const [i, vv] = l.split('|'); return { id: i, views: parseInt(vv) || 0 }; }).filter(x => x.id))));
}
// outlier = this video's views ÷ median views of the channel's ~10 videos posted before it
async function channelOutlier(info) {
    const cid = info.channel_id; if (!cid) return {};
    if (!chanCache[cid]) chanCache[cid] = await flatChannel(cid);
    const vids = chanCache[cid] || []; const idx = vids.findIndex(x => x.id === info.id);
    let prev = (idx >= 0 ? vids.slice(idx + 1, idx + 11) : vids.slice(0, 10)).map(x => x.views).filter(x => x > 0);
    if (!prev.length) return {};
    prev.sort((a, b) => a - b); const med = prev[Math.floor(prev.length / 2)];
    return { outlier: med ? +((info.view_count || 0) / med).toFixed(2) : null, baselineViews: med, baselineN: prev.length };
}
function enrich(v, info) {
    Object.assign(v, {
        title: info.title || v.title, channel: info.channel || info.uploader || v.channel, channelId: info.channel_id || null,
        channelUrl: info.channel_url || info.uploader_url || null, subs: info.channel_follower_count ?? null,
        uploadDate: info.upload_date || null, timestamp: info.timestamp || null, views: info.view_count ?? v.views,
        likes: info.like_count ?? null, comments: info.comment_count ?? null, durationSec: info.duration ?? null,
        width: info.width || null, height: info.height || null, url: info.webpage_url || `https://www.youtube.com/watch?v=${v.videoId}`,
        // outlier = views ÷ subscribers (how far it overperformed the channel's size; viral-on-small-channel = high)
        outlier: info.channel_follower_count > 0 ? +(((info.view_count || 0) / info.channel_follower_count)).toFixed(1) : null,
    });
}
function ytdl720(id, out) {
    return new Promise((resolve, reject) => execFile('yt-dlp', ['--no-playlist', '-q', '--no-warnings', '--no-progress',
        '-f', 'bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best', '--merge-output-format', 'mp4', '-o', out,
        `https://www.youtube.com/watch?v=${id}`], { timeout: 180000 }, (err) => err ? reject(err) : resolve()));
}

async function downloadOne(v) {
    const tmp = path.join(os.tmpdir(), `lib_${v.videoId}.mp4`);
    try {
        const info = await ytJson(v.videoId);
        if (!info) { v.failed = (v.failed || 0) + 1; v.lastError = 'no-info'; return; }
        if (!isVerticalShort(info)) { v.nonVertical = true; v.skip = true; v.stored = false; return; }  // not a vertical short — drop, don't retry
        enrich(v, info);
        await ytdl720(v.videoId, tmp);
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

// interleaved backfill: re-check a SMALL batch of already-stored videos — DELETE horizontals from
// R2, backfill metadata on verticals. Runs a few per loop so NEW downloads keep flowing.
async function recheckBatch(limit) {
    const todo = Object.values(db.videos).filter(v => v.stored && !v.rechecked).slice(0, limit);
    if (!todo.length) return;
    await Promise.all(todo.map(async v => {
        const info = await ytJson(v.videoId);
        if (!info) return;                              // couldn't verify — leave it, retry later (never delete on a fetch failure)
        if (!isVerticalShort(info)) {
            try { if (v.r2Key) await cloud.deleteFromR2(v.r2Key); } catch (e) {}
            v.stored = false; v.nonVertical = true; v.removed = true;
        } else { enrich(v, info); v.rechecked = true; }
    }));
    await saveDb(false);
}

async function downloadPending() {
    const pending = Object.values(db.videos).filter(v => !v.stored && !v.skip && (v.failed || 0) < 3);
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
        await recheckBatch(CONC * 2);   // trickle backfill/cleanup of old stored videos (non-blocking to new downloads)
        const storedNow = Object.values(db.videos).filter(v => v.stored).length;
        if (storedNow >= TARGET) break;
        const pending = Object.values(db.videos).filter(v => !v.stored && !v.skip && (v.failed || 0) < 3).length;
        if (pending < CONC * 10) {
            console.log('library: discovering…');
            const added = await discover();
            if (!added && pending === 0) { console.log('library: discovery dry — sleeping 90s (new uploads appear over time)'); await new Promise(r => setTimeout(r, 90000)); }
        }
        await downloadPending();
        await saveDb(true);
    }
    await saveDb(true); running = false;
    console.log('library-crawler: done', computeStats());
}

module.exports = { run, loadDb, computeStats, stopCrawl: () => { stop = true; } };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
