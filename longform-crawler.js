// longform-crawler.js — Builds the LONG-FORM research dataset for "Long Quant":
// tens of thousands of last-year HORIZONTAL (long-form) videos. Collects the
// THUMBNAIL + TITLE + public metadata only (NO video download). Reuses
// shorts-crawler's InnerTube discovery (no API quota). Resumable + deduped via
// longform/db.json on R2. Fully separate from the Shorts library crawler
// (library-crawler.js) so that flow is untouched.
//
// Definition (per Tyler): long-form = HORIZONTAL (width > height). Shorts are
// vertical. Duration does not matter.

try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const path = require('path');
const cloud = require('./cloud-storage');
const sc = require('./shorts-crawler');
if (cloud.initR2 && !cloud.isR2Ready()) cloud.initR2();

const MIN_VIEWS = 1_000;                   // ~1k → billions (full range, last year)
const MAX_VIEWS = Infinity;
const TARGET = 100_000;                    // overnight: grab as many as possible
const UPLOAD_DATE = 5;                     // YouTube filter: this year
const CONC = 8;                            // concurrent thumbnail+meta fetches (light — no video)
const DB_KEY = 'longform/db.json';
const STATS_KEY = 'longform/stats.json';
const THUMB_PREFIX = 'longform/thumbs/';
const LOCAL_DB = path.join(__dirname, 'longform-db.json');

// Broad topic pool, long-form-leaning. Generic topics surface the long tail of
// recent horizontal uploads; the modifiers bias toward long-form formats.
const QUERIES = [
    'how to', 'tutorial', 'full tutorial', 'explained', 'documentary', 'full documentary',
    'podcast', 'full episode', 'interview', 'video essay', 'deep dive', 'breakdown', 'analysis',
    'review', 'in depth review', 'unboxing', 'first look', 'vlog', 'day in the life', 'storytime',
    'lecture', 'course', 'masterclass', 'guide', 'walkthrough', 'commentary', 'reaction',
    'football', 'basketball', 'soccer', 'workout', 'recipe', 'travel', 'nature', 'wildlife',
    'tech', 'phone review', 'ai', 'coding', 'programming', 'finance', 'stocks', 'crypto', 'real estate', 'business',
    'history', 'geography', 'space', 'physics', 'biology', 'psychology', 'science', 'engineering',
    'guitar', 'piano', 'drums', 'music production', 'mixing', 'songwriting', 'edit', 'filmmaking',
    'street food', 'baking', 'coffee', 'bbq', 'gardening', 'woodworking', 'pottery', 'painting',
    'skateboarding', 'parkour', 'climbing', 'surfing', 'boxing', 'mma', 'chess', 'poker',
    'dog training', 'cat', 'horse', 'aquarium', 'farm', 'homestead',
    'car review', 'motorcycle', 'truck', 'racing', 'restoration', 'mechanic', 'detailing',
    'language learning', 'study with me', 'exam prep', 'college', 'productivity', 'minimalism',
    'comedy', 'standup', 'sketch', 'animation', 'short film',
    'startup', 'investing', 'economics', 'marketing', 'entrepreneur', 'case study',
    'build', 'diy project', 'home renovation', 'workshop', 'maker', 'electronics', 'robotics', 'drone',
    'gameplay', 'lets play', 'walkthrough part 1', 'speedrun', 'game review', 'gaming',
    'plane', 'train', 'ship', 'submarine', 'rocket launch', 'nasa', 'telescope', 'aviation',
    'true crime', 'mystery', 'explained history', 'ancient', 'war documentary', 'geopolitics',
    'fitness', 'nutrition', 'meal prep', 'bodybuilding', 'marathon training',
    'photography', 'lightroom', 'blender tutorial', 'after effects', '3d modeling',
    'hindi', 'tamil', 'telugu', 'punjabi', 'urdu', 'arabic', 'spanish', 'portuguese',
    'brasil', 'indonesia', 'filipino', 'korean', 'japanese', 'thai', 'vietnam', 'turkish', 'russian',
    'nigeria', 'kenya', 'egypt', 'mexico', 'colombia', 'argentina', 'france', 'germany', 'italy',
    'camping', 'hiking', 'fishing', 'hunting', 'van life', 'overlanding', 'survival',
    'science experiment', 'chemistry', 'math', 'calculus', 'statistics', 'data science', 'machine learning',
    // ── broadened long-tail pool (break the ~6k plateau → reach 20–30k) ──
    'iceberg explained', 'ranking', 'tier list', 'reacting to', 'exposed', 'the truth about', 'debunked',
    'day in my life', 'morning routine', 'night routine', 'what i eat in a day', 'grwm', 'haul', 'try on',
    'room makeover', 'apartment tour', 'house tour', 'studio tour', 'setup tour', 'desk setup', 'pc build',
    'first time', 'i tried', 'i built', 'i made', 'i spent', '24 hours', '100 hours', 'challenge', 'experiment gone wrong',
    'beginner guide', 'advanced', 'masterclass', 'crash course', 'explained simply', 'for beginners', 'step by step',
    'tutorial 2025', 'how it works', 'how its made', 'behind the scenes', 'process', 'timelapse build',
    'documentary history', 'lost media', 'unsolved', 'conspiracy', 'timeline', 'the rise and fall', 'the story of',
    'analysis', 'video essay', 'retrospective', 'ranking every', 'every', 'complete history', 'evolution of',
    'react', 'first reaction', 'blind reaction', 'listening to', 'watching', 'tier ranking',
    'stock market', 'day trading', 'options trading', 'dividend', 'index funds', 'crypto news', 'bitcoin', 'ethereum',
    'passive income', 'dropshipping', 'ecommerce', 'amazon fba', 'freelancing', 'side hustle 2025', 'make money online',
    'productivity system', 'notion setup', 'second brain', 'time management', 'habits', 'discipline', 'mindset',
    'unreal engine', 'unity tutorial', 'godot', 'game dev', 'indie game', 'devlog', 'shader', 'pixel art',
    'react tutorial', 'python tutorial', 'javascript', 'rust lang', 'go lang', 'sql', 'docker', 'kubernetes', 'aws',
    'chatgpt', 'ai tools', 'midjourney', 'stable diffusion', 'llm', 'prompt engineering', 'ai agents', 'automation',
    'guitar lesson', 'music theory', 'ableton', 'fl studio', 'mixing vocals', 'mastering', 'sound design', 'synth',
    'photography tutorial', 'lightroom preset', 'photoshop tutorial', 'davinci resolve', 'premiere pro', 'color grading',
    'woodworking project', 'metalworking', 'welding', 'blacksmithing', 'leathercraft', '3d printing', 'cnc', 'resin art',
    'car build', 'engine swap', 'project car', 'off road', 'overland build', 'rebuild', 'barn find', 'dyno',
    'pc gaming', 'speedrun world record', 'boss fight', 'no hit run', 'randomizer', 'mod showcase', 'lets play ep 1',
    'cooking', 'recipe dinner', 'meal prep week', 'baking bread', 'sourdough', 'street food tour', 'restaurant review',
    'fitness journey', 'body transformation', 'gym workout', 'push pull legs', 'calisthenics progression', 'running vlog',
    'travel vlog', 'solo travel', 'budget travel', 'digital nomad', 'living in', 'moving to', 'expat', 'country tour',
    'nature documentary', 'wildlife', 'deep sea', 'space documentary', 'astronomy', 'geology', 'weather', 'ocean',
    'psychology explained', 'philosophy', 'stoicism', 'history documentary', 'ancient civilizations', 'mythology',
    'true crime documentary', 'case files', 'investigation', 'mystery solved', 'cold case', 'forensics',
    'minecraft', 'fortnite', 'roblox', 'valorant', 'league of legends', 'gta', 'call of duty', 'elden ring', 'zelda',
    'anime review', 'manga', 'film analysis', 'movie review', 'breakdown scene', 'ending explained', 'easter eggs',
    'diy home improvement', 'renovation', 'garden', 'homestead', 'off grid', 'tiny house', 'van build', 'cabin build',
    'hindi vlog', 'tamil', 'telugu', 'bangla', 'urdu podcast', 'arabic', 'spanish', 'portugues', 'brasil', 'indonesia',
    'filipino', 'korean', 'japanese', 'thai', 'vietnam', 'turkce', 'russian', 'polski', 'deutsch', 'francais', 'italiano',
    'podcast episode', 'interview', 'full episode', 'q and a', 'ama', 'fireside chat', 'panel discussion', 'keynote',
    // ── overnight mega-pool (keep discovery from drying up before 100k) ──
    'best', 'worst', 'top 10', 'top 5', 'greatest', 'insane', 'unbelievable', 'satisfying', 'oddly satisfying',
    'compilation', 'moments', 'highlights', 'fails', 'wins', 'clips', 'edit', 'montage', 'supercut',
    'vs', 'comparison', 'which is better', 'battle', 'showdown', 'tournament', 'championship', 'finals',
    'review 2024', 'review 2025', 'unboxing 2025', 'first impressions', 'long term review', 'one year later',
    'explained in', 'in 10 minutes', 'in 5 minutes', 'in depth', 'deep dive into', 'everything about', 'the science of',
    'how to make', 'how to build', 'how to fix', 'how to draw', 'how to cook', 'how to start', 'how to grow', 'how to learn',
    'diy', 'build with me', 'restoration project', 'transformation', 'before and after', 'makeover', 'flip',
    'street interview', 'man on the street', 'social experiment', 'prank', 'undercover', 'hidden camera',
    'reaction to', 'reacting', 'watching for the first time', 'blind reaction', 'americans react', 'tier list ranking',
    'basketball highlights', 'football highlights', 'soccer skills', 'nba', 'nfl', 'fifa', 'ufc', 'boxing highlights', 'f1',
    'guitar cover', 'piano cover', 'drum cover', 'live performance', 'concert', 'acoustic', 'lo fi', 'beat making',
    'cooking show', 'baking recipe', 'street food', 'taste test', 'food review', 'mukbang', 'what i ate', 'restaurant tour',
    'workout routine', 'full body workout', 'home workout', 'gym motivation', 'yoga class', 'stretching', 'meditation',
    'travel guide', 'things to do in', 'living in', 'cost of living', 'moving abroad', 'city tour', 'road trip', 'hidden gems',
    'nature', 'hiking trail', 'camping trip', 'backpacking', 'wildlife documentary', 'ocean documentary', 'space exploration',
    'car review', 'suv', 'electric car', 'truck review', 'motorcycle review', 'test drive', 'pov drive', 'car detailing',
    'tech review', 'smartphone', 'laptop review', 'gaming pc', 'keyboard', 'headphones', 'camera review', 'gadgets',
    'coding project', 'build an app', 'web development', 'full stack', 'system design', 'leetcode', 'devops', 'cybersecurity',
    'ai explained', 'chatgpt tutorial', 'ai tools 2025', 'automate', 'no code', 'saas', 'startup story', 'founder interview',
    'personal finance', 'budgeting', 'debt free', 'investing for beginners', 'retirement', 'real estate investing', 'taxes',
    'productivity', 'study with me', 'note taking', 'digital minimalism', 'morning routine', 'self improvement', 'discipline',
    'history of', 'the fall of', 'ancient rome', 'world war', 'cold war', 'medieval', 'empire', 'lost civilization',
    'true crime', 'documentary 2025', 'investigation', 'case file', 'mystery', 'unsolved', 'disappearance', 'scandal',
    'minecraft', 'fortnite', 'roblox', 'valorant', 'league of legends', 'gta 5', 'call of duty', 'elden ring', 'zelda', 'pokemon',
    'movie review', 'film analysis', 'ending explained', 'trailer breakdown', 'top movies', 'best shows', 'anime recap',
    'kdrama', 'bollywood', 'nollywood', 'telenovela', 'comedy sketch', 'stand up', 'improv', 'parody', 'skit',
    'hindi', 'tamil', 'telugu', 'kannada', 'malayalam', 'marathi', 'gujarati', 'punjabi', 'bengali', 'urdu',
    'espanol', 'portugues', 'francais', 'deutsch', 'italiano', 'nederlands', 'polski', 'turkce', 'русский', '日本語', '한국어',
    'tagalog', 'bahasa indonesia', 'bahasa melayu', 'ไทย', 'tiếng việt', 'العربية', 'فارسی', 'kiswahili', 'yoruba', 'amharic',
];

let db = null, running = false, stop = false;

async function loadDb() {
    if (db) return db;
    try {
        if (fs.existsSync(LOCAL_DB)) { db = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8')); return db; }
        const buf = await cloud.downloadFromR2(DB_KEY);
        if (buf) { db = JSON.parse(buf.toString('utf8')); return db; }
    } catch (e) { console.warn('longform: loadDb', e.message); }
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
    } catch (e) { console.warn('longform: saveDb', e.message); }
}

function computeStats() {
    const vids = Object.values(db.videos);
    const stored = vids.filter(v => v.stored);
    const bytes = stored.reduce((s, v) => s + (v.thumbBytes || 0), 0);
    const buckets = { '1k-10k': 0, '10k-100k': 0, '100k-1M': 0, '1M-10M': 0, '10M-100M': 0, '100M+': 0 };
    let outliers = 0;
    for (const v of stored) {
        const x = v.views;
        if (x < 1e4) buckets['1k-10k']++; else if (x < 1e5) buckets['10k-100k']++; else if (x < 1e6) buckets['100k-1M']++;
        else if (x < 1e7) buckets['1M-10M']++; else if (x < 1e8) buckets['10M-100M']++; else buckets['100M+']++;
        if ((v.outlier || 0) >= 3) outliers++;
    }
    return { target: TARGET, discovered: vids.length, stored: stored.length, thumbBytes: bytes,
        minViews: MIN_VIEWS, maxViews: MAX_VIEWS === Infinity ? null : MAX_VIEWS, viewBuckets: buckets, outliers3x: outliers,
        removed: vids.filter(v => v.removed).length, updated: Date.now() };
}

// exclude videos older than ~1 year using the relative "published" text
function withinLastYear(pub) {
    if (!pub) return true;
    return !/year/i.test(pub);
}

// rotate through (sort × query) a FEW per call, then return so fetches run
let qPos = 0;
const SORTS = [3, 1];                      // 3 = view-count, 1 = upload-date (long tail)
const TOTAL_Q = () => SORTS.length * QUERIES.length;
async function discover() {
    const seen = new Set(Object.keys(db.videos));
    let added = 0;
    for (let n = 0; n < 8; n++) {
        if (stop) break;
        const sort = SORTS[Math.floor(qPos / QUERIES.length) % SORTS.length];
        const q = QUERIES[qPos % QUERIES.length];
        qPos = (qPos + 1) % TOTAL_Q();
        let vids = [];
        try { vids = await sc.innerTubeSearch(q, sc.buildSP(sort, UPLOAD_DATE, 6, null)); } catch (e) { continue; }
        for (const v of vids) {
            if (!v.videoId || seen.has(v.videoId)) continue;
            if (!(v.views >= MIN_VIEWS && v.views < MAX_VIEWS)) continue;
            if (sc.isShort(v) || !withinLastYear(v.publishedAt)) continue;   // drop shorts; horizontal confirmed at fetch
            seen.add(v.videoId); added++;
            db.videos[v.videoId] = { videoId: v.videoId, title: v.title, channel: v.channelTitle,
                views: v.views, publishedAt: v.publishedAt, duration: v.duration, stored: false, addedAt: Date.now() };
        }
    }
    await saveDb(false);
    return added;
}

// full metadata dump (no download) — dimensions for the horizontal filter + everything else
const { execFile } = require('child_process');
function ytJson(id) {
    return new Promise(res => execFile('yt-dlp', ['--no-playlist', '-q', '--no-warnings',
        '--extractor-args', 'youtube:player_client=web_safari,mweb,tv_embedded,web_embedded',   // bypass the "confirm you're not a bot" wall without cookies
        '-J', `https://www.youtube.com/watch?v=${id}`],
        { timeout: 70000, maxBuffer: 96 * 1024 * 1024 }, (err, out) => { if (err) return res(null); try { res(JSON.parse(out)); } catch { res(null); } }));
}
// LONG-FORM = horizontal only. Reject vertical/square (those are shorts territory).
function isHorizontal(info) {
    const w = info.width || 0, h = info.height || 0;
    if (w && h) return w > h;               // landscape
    return true;                            // unknown dims → keep (discovery already excluded shorts)
}
function enrich(v, info) {
    Object.assign(v, {
        title: info.title || v.title, channel: info.channel || info.uploader || v.channel, channelId: info.channel_id || null,
        channelUrl: info.channel_url || info.uploader_url || null, subs: info.channel_follower_count ?? null,
        uploadDate: info.upload_date || null, timestamp: info.timestamp || null, views: info.view_count ?? v.views,
        likes: info.like_count ?? null, comments: info.comment_count ?? null, durationSec: info.duration ?? null,
        width: info.width || null, height: info.height || null, url: info.webpage_url || `https://www.youtube.com/watch?v=${v.videoId}`,
        // outlier = views ÷ subscribers (how far it overperformed the channel's size)
        outlier: info.channel_follower_count > 0 ? +(((info.view_count || 0) / info.channel_follower_count)).toFixed(1) : null,
    });
}

// Grab the best available thumbnail (maxres → sd → hq). YouTube's i.ytimg CDN is
// public; we store a copy on R2 for the later embedding pipeline.
async function fetchThumb(id) {
    const cands = ['maxresdefault', 'sddefault', 'hqdefault'];
    for (const name of cands) {
        try {
            const r = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`);
            if (!r.ok) continue;
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < 1500) continue;          // YouTube's 120x90 "not found" placeholder is tiny
            return { buf, res: name };
        } catch (e) { /* try next */ }
    }
    return null;
}

async function fetchOne(v) {
    try {
        const info = await ytJson(v.videoId);
        if (!info) { v.failed = (v.failed || 0) + 1; v.lastError = 'no-info'; return; }
        if (!isHorizontal(info)) { v.nonHorizontal = true; v.skip = true; v.stored = false; return; }  // vertical — drop, don't retry
        enrich(v, info);
        const t = await fetchThumb(v.videoId);
        if (!t) { v.failed = (v.failed || 0) + 1; v.lastError = 'no-thumb'; return; }
        await cloud.uploadToR2(`${THUMB_PREFIX}${v.videoId}.jpg`, t.buf, 'image/jpeg');
        v.stored = true; v.thumbBytes = t.buf.length; v.thumbRes = t.res;
        v.thumbKey = `${THUMB_PREFIX}${v.videoId}.jpg`; v.storedAt = Date.now();
    } catch (e) {
        v.failed = (v.failed || 0) + 1; v.lastError = String(e.message || e).slice(0, 80);
    }
}

// interleaved backfill: re-check a SMALL batch of stored videos — delete verticals
// from R2, backfill metadata on the rest.
async function recheckBatch(limit) {
    const todo = Object.values(db.videos).filter(v => v.stored && !v.rechecked).slice(0, limit);
    if (!todo.length) return;
    await Promise.all(todo.map(async v => {
        const info = await ytJson(v.videoId);
        if (!info) return;                              // couldn't verify — never delete on a fetch failure
        if (!isHorizontal(info)) {
            try { if (v.thumbKey) await cloud.deleteFromR2(v.thumbKey); } catch (e) {}
            v.stored = false; v.nonHorizontal = true; v.removed = true;
        } else { enrich(v, info); v.rechecked = true; }
    }));
    await saveDb(false);
}

async function fetchPending() {
    const pending = Object.values(db.videos).filter(v => !v.stored && !v.skip && (v.failed || 0) < 3);
    let done = 0;
    for (let i = 0; i < pending.length && !stop; i += CONC) {
        const batch = pending.slice(i, i + CONC);
        await Promise.all(batch.map(fetchOne));
        done += batch.length;
        await saveDb(false);
        const stored = Object.values(db.videos).filter(v => v.stored).length;
        if (done % 40 === 0) console.log(`longform: ${stored} stored / ${Object.keys(db.videos).length} discovered`);
        if (stored >= TARGET) { stop = true; break; }
    }
    return done;
}

async function run() {
    if (running) return; running = true; stop = false;
    await loadDb();
    console.log(`longform-crawler: ${computeStats().stored} stored, target ${TARGET}`);
    while (!stop) {
        await recheckBatch(CONC * 2);
        const storedNow = Object.values(db.videos).filter(v => v.stored).length;
        if (storedNow >= TARGET) break;
        const pending = Object.values(db.videos).filter(v => !v.stored && !v.skip && (v.failed || 0) < 3).length;
        if (pending < CONC * 10) {
            console.log('longform: discovering…');
            const added = await discover();
            if (!added && pending === 0) { console.log('longform: discovery dry — sleeping 90s'); await new Promise(r => setTimeout(r, 90000)); }
        }
        await fetchPending();
        await saveDb(true);
    }
    await saveDb(true); running = false;
    console.log('longform-crawler: done', computeStats());
}

module.exports = { run, loadDb, computeStats, stopCrawl: () => { stop = true; } };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
