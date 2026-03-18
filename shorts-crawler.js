// shorts-crawler.js — Discovers and archives 100M+ view YouTube Shorts

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const cloud = require('./cloud-storage');

const DB_PATH = path.join(__dirname, 'shorts-db.json');
const VIDEO_DATA_DIR = path.join(__dirname, 'video_data');
const YTDLP_BASE = ['--js-runtimes', 'node', '--remote-components', 'ejs:github'];
const MIN_VIEWS = 100_000_000;
const MAX_FRAMES_PER_CYCLE = 5;
const MAX_RETRIES = 3;

// Check for yt-dlp and ffmpeg availability
let hasYtdlp = false;
let hasFfmpeg = false;
try { execFileSync('yt-dlp', ['--version'], { stdio: 'ignore' }); hasYtdlp = true; } catch (e) { console.warn('shorts-crawler: yt-dlp not found, frame extraction disabled'); }
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); hasFfmpeg = true; } catch (e) { console.warn('shorts-crawler: ffmpeg not found, frame extraction disabled'); }

// InnerTube constants (same as server.js)
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENT = { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' };

const BROWSE_REGIONS = ['US', 'IN', 'BR', 'MX', 'ID', 'GB', 'PH', 'DE', 'KR', 'TR', 'PK', 'NG', 'FR', 'JP', 'SA', 'AR', 'CO', 'EG', 'TH'];

const SHORTS_QUERIES = [
    'viral', '#shorts', 'funny shorts', 'trending shorts', 'most viewed shorts',
    'tiktok', 'satisfying', 'comedy shorts', 'dance shorts', 'challenge shorts',
    'shorts viral 2025', 'shorts funny', 'meme', 'prank', 'shorts trending',
    'cute', 'fails', 'magic trick', 'life hack', 'cooking shorts',
    'pets', 'baby', 'car', 'sports shorts', 'gaming shorts',
    'anime shorts', 'art', 'music shorts', 'singing', 'reaction shorts',
    'scary shorts', 'horror shorts', 'diy shorts', 'beauty shorts',
    'fitness shorts', 'science shorts', 'history shorts', 'asmr shorts',
    'minecraft shorts', 'fortnite shorts', 'roblox shorts',
    'mrbeast shorts', 'most viewed shorts ever', '#shorts viral',
    'shorts 2025', 'shorts 2024', 'shorts billion views',
    'Indian shorts', 'hindi shorts', 'spanish shorts', 'kpop shorts',
];

// ── Database ──

async function loadDb() {
    // On Render or when local file missing, try R2
    if (process.env.RENDER || !fs.existsSync(DB_PATH)) {
        try {
            const buf = await cloud.downloadFromR2("shorts/db.json");
            if (buf) {
                const db = JSON.parse(buf.toString("utf8"));
                // Also write to local for caching
                try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch(e) {}
                return db;
            }
        } catch(e) {
            console.warn("shorts-crawler: R2 DB load failed:", e.message);
        }
    }
    // Fall back to local file
    if (fs.existsSync(DB_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        } catch (e) {
            console.warn('shorts-crawler: failed to load DB, starting fresh:', e.message);
        }
    }
    return { lastUpdated: null, totalVideos: 0, videos: {} };
}

function saveDb(db) {
    db.totalVideos = Object.keys(db.videos).length;
    db.lastUpdated = new Date().toISOString();
    try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch(e) {}
    // Async R2 sync - do not block
    if (cloud.isR2Ready()) {
        const buf = Buffer.from(JSON.stringify(db));
        cloud.uploadToR2("shorts/db.json", buf, "application/json")
            .then(() => console.log("shorts-crawler: DB synced to R2"))
            .catch(e => console.warn("shorts-crawler: R2 DB sync failed:", e.message));
    }
}

// ── InnerTube helpers ──

function buildSP(sort, uploadDate, type, duration) {
    const parts = [];
    if (sort != null) parts.push(Buffer.from([0x08, sort]));
    const fp = [];
    if (uploadDate != null) fp.push(Buffer.from([0x08, uploadDate]));
    if (type != null) fp.push(Buffer.from([0x10, type]));
    if (duration != null) fp.push(Buffer.from([0x18, duration]));
    if (fp.length) { const fb = Buffer.concat(fp); parts.push(Buffer.from([0x12, fb.length]), fb); }
    return Buffer.concat(parts).toString('base64');
}

function parseVideos(data) {
    const videos = [];
    function extract(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 25) return;
        if (obj.videoRenderer) {
            const vr = obj.videoRenderer;
            const viewText = vr.viewCountText?.simpleText || vr.viewCountText?.runs?.[0]?.text || '0';
            const viewNum = parseInt(viewText.replace(/[^0-9]/g, '')) || 0;
            videos.push({
                videoId: vr.videoId,
                title: vr.title?.runs?.[0]?.text || '',
                channelTitle: vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || '',
                publishedAt: vr.publishedTimeText?.simpleText || '',
                thumbnail: vr.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
                views: viewNum,
                duration: vr.lengthText?.simpleText || '',
            });
            return;
        }
        if (Array.isArray(obj)) { for (const item of obj) extract(item, depth + 1); return; }
        for (const v of Object.values(obj)) extract(v, depth + 1);
    }
    extract(data, 0);
    return videos;
}

function extractContinuationToken(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.token && data.continuationCommand) return data.token;
    if (data.continuationItemRenderer) {
        const ep = data.continuationItemRenderer.continuationEndpoint;
        if (ep?.continuationCommand?.token) return ep.continuationCommand.token;
    }
    if (data.nextContinuationData?.continuation) return data.nextContinuationData.continuation;
    if (Array.isArray(data)) {
        for (const item of data) {
            const t = extractContinuationToken(item);
            if (t) return t;
        }
        return null;
    }
    for (const v of Object.values(data)) {
        if (v && typeof v === 'object') {
            const t = extractContinuationToken(v);
            if (t) return t;
        }
    }
    return null;
}

async function innerTubeSearch(query, sp) {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: INNERTUBE_CLIENT }, query, params: sp })
    });
    const firstData = await res.json();
    const videos = parseVideos(firstData);

    let contToken = extractContinuationToken(firstData);
    for (let page = 0; page < 5 && contToken; page++) {
        try {
            const contRes = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ context: { client: INNERTUBE_CLIENT }, continuation: contToken })
            });
            const contData = await contRes.json();
            const pageVideos = parseVideos(contData);
            if (pageVideos.length === 0) break;
            videos.push(...pageVideos);
            contToken = extractContinuationToken(contData);
        } catch { break; }
    }
    return videos;
}

async function innerTubeBrowse(browseId, region) {
    const videos = [];
    try {
        const client = { ...INNERTUBE_CLIENT, gl: region };
        const browseRes = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}&prettyPrint=false`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: { client }, browseId })
        });
        const browseData = await browseRes.json();
        videos.push(...parseVideos(browseData));

        let contToken = extractContinuationToken(browseData);
        for (let page = 0; page < 2 && contToken; page++) {
            const contRes = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}&prettyPrint=false`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ context: { client }, continuation: contToken })
            });
            const contData = await contRes.json();
            const pageVideos = parseVideos(contData);
            if (pageVideos.length === 0) break;
            videos.push(...pageVideos);
            contToken = extractContinuationToken(contData);
        }
    } catch { /* ignore browse failures */ }
    return videos;
}

// ── Shorts detection ──

function durToSec(dur) {
    if (!dur) return -1;
    const p = dur.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] || 0);
}

function isShort(v) {
    const s = durToSec(v.duration);
    if (s <= 0) return false;
    if (s <= 60) return true;
    if (s <= 180) {
        const t = (v.title || '').toLowerCase();
        return t.includes('#shorts') || t.includes('#short') || t.includes('shorts');
    }
    return false;
}

// ── Main crawl ──

let crawling = false;

async function crawl() {
    if (crawling) { console.log('shorts-crawler: crawl already in progress, skipping'); return; }
    crawling = true;
    const t0 = Date.now();
    console.log('shorts-crawler: starting crawl cycle...');

    try {
        const db = await loadDb();

        // --- Source 1: InnerTube search for shorts sorted by view count ---
        const sp = buildSP(3, null, 6, null); // sort=viewcount, type=shorts, all time
        const searches = SHORTS_QUERIES.map(q => innerTubeSearch(q, sp).catch(() => []));

        // --- Source 2: InnerTube browse FEshorts for all regions ---
        const browseFetches = BROWSE_REGIONS.map(region => innerTubeBrowse('FEshorts', region));

        // --- Source 3: YouTube OAuth chart=mostPopular (if refresh token set) ---
        const oauthFetches = [];
        if (process.env.YOUTUBE_REFRESH_TOKEN && process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) {
            const tokenPromise = (async () => {
                try {
                    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            grant_type: 'refresh_token',
                            refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
                            client_id: process.env.YOUTUBE_CLIENT_ID,
                            client_secret: process.env.YOUTUBE_CLIENT_SECRET,
                        }).toString()
                    });
                    const tokenData = await tokenRes.json();
                    return tokenData.access_token || null;
                } catch { return null; }
            })();

            for (const rc of BROWSE_REGIONS) {
                oauthFetches.push((async () => {
                    const accessToken = await tokenPromise;
                    if (!accessToken) return [];
                    try {
                        const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&chart=mostPopular&regionCode=${rc}&maxResults=50`;
                        const r = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
                        const d = await r.json();
                        return (d.items || []).map(item => {
                            const dur = item.contentDetails?.duration || '';
                            const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                            const secs = match ? (parseInt(match[1] || 0) * 3600 + parseInt(match[2] || 0) * 60 + parseInt(match[3] || 0)) : 0;
                            const mm = String(Math.floor(secs / 60));
                            const ss = String(secs % 60).padStart(2, '0');
                            const durStr = secs >= 3600 ? `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
                            return {
                                videoId: item.id,
                                title: item.snippet?.title || '',
                                channelTitle: item.snippet?.channelTitle || '',
                                publishedAt: item.snippet?.publishedAt || '',
                                thumbnail: item.snippet?.thumbnails?.high?.url || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
                                views: parseInt(item.statistics?.viewCount) || 0,
                                duration: durStr,
                            };
                        });
                    } catch { return []; }
                })());
            }
        }

        // Run all sources in parallel
        const [searchResults, browseResults, oauthResults] = await Promise.all([
            Promise.all(searches),
            Promise.all(browseFetches),
            Promise.all(oauthFetches),
        ]);

        // Merge, deduplicate, filter
        const seen = new Set(Object.keys(db.videos));
        let newCount = 0;
        const allBatches = [...searchResults, ...browseResults, ...oauthResults];
        for (const batch of allBatches) {
            for (const v of batch) {
                if (!v.videoId || seen.has(v.videoId)) continue;
                seen.add(v.videoId);
                // Must be a Short with 100M+ views
                if (v.views < MIN_VIEWS) continue;
                if (!isShort(v)) continue;

                db.videos[v.videoId] = {
                    videoId: v.videoId,
                    title: v.title,
                    channelTitle: v.channelTitle,
                    views: v.views,
                    publishedAt: v.publishedAt,
                    thumbnail: v.thumbnail,
                    duration: v.duration,
                    discoveredAt: new Date().toISOString(),
                    framesStatus: 'pending',
                    framesR2Keys: [],
                    r2MetaKey: `shorts/${v.videoId}/meta.json`,
                    retryCount: 0,
                };
                newCount++;

                // Upload meta to R2
                if (cloud.isR2Ready()) {
                    cloud.uploadToR2(
                        `shorts/${v.videoId}/meta.json`,
                        Buffer.from(JSON.stringify(db.videos[v.videoId])),
                        'application/json'
                    ).catch(e => console.warn(`shorts-crawler: R2 meta upload failed for ${v.videoId}:`, e.message));
                }
            }
        }

        saveDb(db);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`shorts-crawler: crawl done in ${elapsed}s — ${newCount} new videos, ${Object.keys(db.videos).length} total in DB`);
    } catch (e) {
        console.error('shorts-crawler: crawl error:', e.message);
    } finally {
        crawling = false;
    }
}

// ── Frame extraction ──

function execPromise(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
        });
    });
}

async function processFrames() {
    if (!hasYtdlp || !hasFfmpeg) {
        console.log('shorts-crawler: skipping frame extraction (yt-dlp or ffmpeg missing)');
        return;
    }

    const db = await loadDb();
    const pending = Object.values(db.videos)
        .filter(v => (v.framesStatus === 'pending' || v.framesStatus === 'failed') && (v.retryCount || 0) < MAX_RETRIES)
        .slice(0, MAX_FRAMES_PER_CYCLE);

    if (pending.length === 0) return;
    console.log(`shorts-crawler: processing frames for ${pending.length} videos...`);

    for (const video of pending) {
        const videoDir = path.join(VIDEO_DATA_DIR, `shorts_${video.videoId}`);
        const videoFile = path.join(videoDir, 'video.mp4');

        try {
            // Ensure directory exists
            fs.mkdirSync(videoDir, { recursive: true });

            video.framesStatus = 'processing';
            saveDb(db);

            // Download first 10 seconds
            await execPromise('yt-dlp', [
                ...YTDLP_BASE,
                '-f', 'best[height<=720]/best',
                '--download-sections', '*0-10',
                '-o', videoFile,
                '--no-playlist',
                '--no-warnings',
                `https://www.youtube.com/shorts/${video.videoId}`
            ]);

            // Extract 3 frames at ~1s, 4s, 8s
            const framePattern = path.join(videoDir, 'frame_%04d.jpg');
            try {
                await execPromise('ffmpeg', [
                    '-y', '-i', videoFile,
                    '-vf', "select='eq(n\\,0)+eq(n\\,3)+eq(n\\,7)'",
                    '-vsync', 'vfr', '-q:v', '2',
                    framePattern
                ]);
            } catch {
                // Fallback: extract using fps filter
                await execPromise('ffmpeg', [
                    '-y', '-i', videoFile,
                    '-vf', 'fps=0.33',
                    '-frames:v', '3', '-q:v', '2',
                    framePattern
                ]);
            }

            // Find extracted frames
            const frameFiles = fs.readdirSync(videoDir).filter(f => f.startsWith('frame_') && f.endsWith('.jpg')).sort();

            // Upload frames to R2
            const r2Keys = [];
            for (const frameFile of frameFiles) {
                const framePath = path.join(videoDir, frameFile);
                const r2Key = `shorts/${video.videoId}/${frameFile}`;
                if (cloud.isR2Ready()) {
                    const frameData = fs.readFileSync(framePath);
                    await cloud.uploadToR2(r2Key, frameData, 'image/jpeg');
                }
                r2Keys.push(r2Key);
            }

            // Delete video file (keep frames locally)
            if (fs.existsSync(videoFile)) fs.unlinkSync(videoFile);

            // Update DB
            video.framesStatus = 'done';
            video.framesR2Keys = r2Keys;
            saveDb(db);
            console.log(`shorts-crawler: frames done for ${video.videoId} (${frameFiles.length} frames)`);

        } catch (e) {
            console.warn(`shorts-crawler: frame extraction failed for ${video.videoId}:`, e.message);
            video.framesStatus = 'failed';
            video.retryCount = (video.retryCount || 0) + 1;
            saveDb(db);
            // Clean up partial downloads
            if (fs.existsSync(videoFile)) try { fs.unlinkSync(videoFile); } catch {}
        }
    }
}

// ── Exports ──

async function getStats() {
    const db = await loadDb();
    const videos = Object.values(db.videos);
    return {
        totalVideos: videos.length,
        framesReady: videos.filter(v => v.framesStatus === 'done').length,
        framesPending: videos.filter(v => v.framesStatus === 'pending' || v.framesStatus === 'processing').length,
        framesFailed: videos.filter(v => v.framesStatus === 'failed').length,
        lastCrawled: db.lastUpdated,
        minViews: MIN_VIEWS,
    };
}

async function getVideos({ page = 1, limit = 50, minViews = MIN_VIEWS, sort = 'views' } = {}) {
    const db = await loadDb();
    let videos = Object.values(db.videos).filter(v => v.views >= minViews);

    if (sort === 'discoveredAt') {
        videos.sort((a, b) => (b.discoveredAt || '').localeCompare(a.discoveredAt || ''));
    } else {
        videos.sort((a, b) => b.views - a.views);
    }

    limit = Math.min(Math.max(1, limit), 200);
    page = Math.max(1, page);
    const total = videos.length;
    const pages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    videos = videos.slice(start, start + limit);

    return { videos, total, page, pages };
}

function getFramePath(videoId, filename) {
    const fp = path.join(VIDEO_DATA_DIR, `shorts_${videoId}`, filename);
    return fs.existsSync(fp) ? fp : null;
}

async function getFrameR2Url(videoId, filename) {
    const key = `shorts/${videoId}/${filename}`;
    return cloud.getR2SignedUrl(key, 3600);
}

async function getVideoFromDb(videoId) {
    const db = await loadDb();
    return db.videos[videoId] || null;
}

module.exports = { crawl, processFrames, getStats, getVideos, getFramePath, getFrameR2Url, getVideoFromDb, loadDb };
