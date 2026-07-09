#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const eq = line.indexOf('=');
        if (eq > 0 && !process.env[line.slice(0, eq).trim()]) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
}

const cloud = require('../cloud-storage');
const TRANSCRIPT_FIRST_SECONDS = Math.max(10, parseInt(process.env.LONGQUANT_TRANSCRIPT_FIRST_SECONDS, 10) || 30);
const TRANSCRIPT_CONTEXT_CHARS = Math.max(1200, Math.min(12000, parseInt(process.env.LONGQUANT_CONTEXT_CHARS, 10) || 6000));
const TRANSCRIPT_FULL_WORDS = Math.max(120, Math.min(1400, parseInt(process.env.LONGQUANT_TRANSCRIPT_WORDS, 10) || 900));
const CHANNEL_SOURCE = 'tyler-channel-overnight';
const TERMINAL_STATUS = new Set(['won', 'maxed', 'deadline', 'error', 'stopped', 'archived', 'done']);

function arg(name, fallback = '') {
    const p = process.argv.indexOf('--' + name);
    return p >= 0 ? String(process.argv[p + 1] || '') : fallback;
}
function has(name) { return process.argv.includes('--' + name); }
function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = execFile(cmd, args, { cwd: ROOT, timeout: opts.timeout || 120000, maxBuffer: opts.maxBuffer || 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
                return;
            }
            resolve({ stdout, stderr });
        });
        if (opts.stdin) {
            p.stdin.end(opts.stdin);
        }
    });
}
function cleanText(s) {
    return String(s || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function tsSec(ts) {
    const parts = String(ts || '').replace(',', '.').split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(parts[0] || 0);
}
function transcriptContext(video, transcript) {
    const first = cleanText(transcript.first || '');
    const full = cleanText(transcript.full || '');
    const parts = [];
    if (video && video.title) parts.push(`Original/current video title: ${video.title}`);
    if (first) parts.push(`First ${TRANSCRIPT_FIRST_SECONDS} seconds transcript: ${first}`);
    if (full && full !== first) parts.push(`Longer transcript excerpt: ${full.split(/\s+/).slice(0, TRANSCRIPT_FULL_WORDS).join(' ')}`);
    return cleanText(parts.join('\n')).slice(0, TRANSCRIPT_CONTEXT_CHARS);
}
function parseVttTranscript(file) {
    const txt = fs.readFileSync(file, 'utf8');
    const lines = txt.split(/\r?\n/);
    const first = [], full = [];
    let keep = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line === 'WEBVTT' || /^\d+$/.test(line) || line.startsWith('NOTE')) continue;
        const m = line.match(/^([0-9:.]+)\s+-->\s+([0-9:.]+)/);
        if (m) {
            keep = tsSec(m[1]) <= 30;
            continue;
        }
        if (keep) {
            const t = cleanText(line);
            if (t && first[first.length - 1] !== t) first.push(t);
        }
        const t = cleanText(line);
        if (t && !/^[0-9:.]+\s+-->\s+[0-9:.]+/.test(line) && full[full.length - 1] !== t) full.push(t);
    }
    return { first: cleanText(first.join(' ')), full: cleanText(full.join(' ')) };
}
function parseJson3Transcript(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const first = [], full = [];
        for (const ev of data.events || []) {
            if (!ev || !ev.segs) continue;
            const start = Number(ev.tStartMs || 0) / 1000;
            for (const seg of ev.segs) {
                const t = cleanText(seg && seg.utf8 || '');
                if (!t) continue;
                full.push(t);
                if (start <= TRANSCRIPT_FIRST_SECONDS) first.push(t);
            }
        }
        return { first: cleanText(first.join(' ')), full: cleanText(full.join(' ')) };
    } catch (e) {
        return { first: '', full: '' };
    }
}
function localTranscriptContext(id, video) {
    const candidates = [
        path.join(ROOT, 'video_data', id, 'analysis.json'),
        path.join(ROOT, 'data', 'video_data', id, 'analysis.json'),
    ];
    for (const f of candidates) {
        try {
            if (!fs.existsSync(f)) continue;
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            const words = j.transcript && Array.isArray(j.transcript.words) ? j.transcript.words : [];
            if (words.length) {
                const first = cleanText(words.filter(w => Number(w.timestamp || w.start || 0) <= TRANSCRIPT_FIRST_SECONDS).map(w => w.word || w.text || '').join(' '));
                const full = cleanText(words.map(w => w.word || w.text || '').join(' '));
                return transcriptContext(video, { first, full });
            }
            const full = cleanText(j.transcript && (j.transcript.fullText || j.transcript.text) || '');
            if (full) return transcriptContext(video, { first: full.split(/\s+/).slice(0, 95).join(' '), full });
        } catch (e) {}
    }
    return '';
}
async function ytdlpTranscriptContext(id, url, extraArgs, video) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-caps-'));
    try {
        const args = [
            '--skip-download', '--write-auto-subs', '--write-subs',
            '--sub-langs', 'en,en.*,en-US',
            '--sub-format', 'json3/vtt/best',
            '--no-warnings',
            '--output', path.join(tmp, '%(id)s.%(ext)s'),
            ...extraArgs,
            url || `https://www.youtube.com/watch?v=${id}`,
        ];
        await run('yt-dlp', args, { timeout: 90000, maxBuffer: 2 * 1024 * 1024 }).catch(() => null);
        const jsonFiles = fs.readdirSync(tmp).filter(f => f.endsWith('.json3')).map(f => path.join(tmp, f));
        for (const f of jsonFiles) {
            const t = transcriptContext(video, parseJson3Transcript(f));
            if (t) return t;
        }
        const vttFiles = fs.readdirSync(tmp).filter(f => f.endsWith('.vtt')).map(f => path.join(tmp, f));
        for (const f of vttFiles) {
            const t = transcriptContext(video, parseVttTranscript(f));
            if (t) return t;
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return '';
}
async function channelVideos(channelUrl, extraArgs) {
    const args = [
        '--flat-playlist', '--dump-single-json', '--no-warnings',
        '--extractor-args', 'youtube:player_client=web_safari,mweb,tv_embedded,web_embedded',
        ...extraArgs,
        channelUrl,
    ];
    const { stdout } = await run('yt-dlp', args, { timeout: 120000, maxBuffer: 24 * 1024 * 1024 });
    const j = JSON.parse(stdout);
    const entries = Array.isArray(j.entries) ? j.entries : [];
    const seen = new Set();
    return entries.map(e => {
        const id = String(e.id || '').trim();
        if (!id || seen.has(id)) return null;
        seen.add(id);
        const url = e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${id}`;
        return {
            id,
            title: String(e.title || id).trim(),
            url,
            duration: e.duration || null,
            channel: j.channel || j.uploader || 'Tyler Csatari',
            thumbnail: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
        };
    }).filter(Boolean);
}
function batchId() {
    return 'tyler-channel-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}
function cleanRid(s) {
    return String(s || '').replace(/[^a-z0-9]/gi, '');
}
function sourceVideoId(o) {
    const v = o && o.sourceVideo && typeof o.sourceVideo === 'object' ? o.sourceVideo : null;
    return String((v && (v.id || v.videoId)) || '').trim();
}
function isChannelWork(o) {
    if (!o || typeof o !== 'object') return false;
    const source = String(o.source || '').toLowerCase();
    return !!(sourceVideoId(o) || o.batchId || source.includes('channel') || source.includes('youtube') || source.includes('tyler'));
}
function terminalStatus(status) {
    return TERMINAL_STATUS.has(String(status || ''));
}
function hasGeneratedWork(run) {
    if (!run || typeof run !== 'object') return false;
    const attempts = Array.isArray(run.attempts) ? run.attempts : [];
    if (attempts.length) return true;
    if (run.best != null || run.baseline || run.autosaved || run.winner != null) return true;
    if (String(run.status || '') === 'running') return true;
    return false;
}
async function r2Json(key) {
    try {
        const b = await cloud.downloadFromR2(key);
        return b ? JSON.parse(b.toString('utf8')) : null;
    } catch (e) {
        return null;
    }
}
async function putJson(key, obj) {
    await cloud.uploadToR2(key, Buffer.from(JSON.stringify(obj)), 'application/json');
}
async function existingLongQuantIndex() {
    const idx = {
        generatedVideoIds: new Set(),
        pendingVideoIds: new Set(),
        pendingByVideo: new Map(),
        channelRuns: [],
        channelRequests: [],
        savedVideoIds: new Set(),
    };
    const [runKeys, reqKeys] = await Promise.all([
        cloud.listR2Keys('longform/grind/runs/').catch(() => []),
        cloud.listR2Keys('longform/grind/requests/').catch(() => []),
    ]);
    for (const key of (runKeys || []).filter(k => k.endsWith('.json')).sort()) {
        const run = await r2Json(key);
        if (!run || !isChannelWork(run)) continue;
        const rid = cleanRid(run.rid || key.split('/').pop().replace('.json', ''));
        const id = sourceVideoId(run);
        const rec = { key, rid, run, id };
        idx.channelRuns.push(rec);
        if (!id) continue;
        if (hasGeneratedWork(run)) {
            idx.generatedVideoIds.add(id);
        } else if (!terminalStatus(run.status)) {
            idx.pendingVideoIds.add(id);
            if (!idx.pendingByVideo.has(id)) idx.pendingByVideo.set(id, rec);
        }
    }
    for (const key of (reqKeys || []).filter(k => k.endsWith('.json')).sort()) {
        const req = await r2Json(key);
        if (!req || !isChannelWork(req)) continue;
        const rid = cleanRid(req.rid || key.split('/').pop().replace('.json', ''));
        const id = sourceVideoId(req);
        const rec = { key, rid, req, id };
        idx.channelRequests.push(rec);
        if (!id) continue;
        if (!idx.generatedVideoIds.has(id)) {
            idx.pendingVideoIds.add(id);
            const prev = idx.pendingByVideo.get(id) || {};
            idx.pendingByVideo.set(id, { ...prev, request: rec, id, rid: prev.rid || rid });
        }
    }
    const saved = await r2Json('longform/saved-thumbs/index.json');
    for (const t of ((saved && saved.thumbs) || [])) {
        const id = sourceVideoId(t);
        if (id) {
            idx.savedVideoIds.add(id);
            idx.generatedVideoIds.add(id);
        }
    }
    return idx;
}
function buildGrindPayload(rid, video, context, opts) {
    const maxAttempts = Math.max(1, Math.min(100, parseInt(opts.maxAttempts, 10) || 40));
    const count = Math.max(1, Math.min(8, parseInt(opts.count, 10) || 5));
    const threshold = Math.max(50, Math.min(99, parseInt(opts.threshold, 10) || 90));
    const hours = Math.min(48, Math.max(0.1, parseFloat(opts.hours) || 8));
    const cleanContext = cleanText(context || '').slice(0, TRANSCRIPT_CONTEXT_CHARS);
    const contextStatus = String(opts.contextStatus || (cleanContext ? 'ok' : 'missing'));
    return {
        rid,
        idea: video.title,
        title: video.title,
        invent: false,
        threshold,
        maxAttempts,
        count,
        hours,
        context: cleanContext,
        transcript30: cleanContext,
        contextChars: cleanContext.length,
        contextStatus,
        source: CHANNEL_SOURCE,
        batchId: opts.batchId,
        autosaveBest: true,
        sourceVideo: video,
        ideaModel: process.env.LONGQUANT_IDEA_VERSION || process.env.LONGQUANT_IDEA_MODEL || '',
        thumbModel: process.env.LONGQUANT_THUMB_VERSION || process.env.LONGQUANT_THUMB_MODEL || '',
        renderModel: process.env.LONGQUANT_RENDER_MODEL || 'black-forest-labs/flux-pro',
        ts: Date.now(),
    };
}
function initialRunFromPayload(payload, note) {
    return {
        rid: payload.rid,
        idea: payload.idea,
        title: payload.title,
        context: payload.context,
        transcript30: payload.context,
        contextChars: payload.contextChars,
        contextStatus: payload.contextStatus,
        sourceVideo: payload.sourceVideo,
        threshold: payload.threshold,
        count: payload.count,
        maxAttempts: payload.maxAttempts,
        hours: payload.hours,
        attempts: [],
        status: 'queued',
        note,
        best: null,
        ts: Date.now(),
        source: payload.source,
        batchId: payload.batchId,
        autosaveBest: payload.autosaveBest,
        ideaModel: payload.ideaModel,
        thumbModel: payload.thumbModel,
        renderModel: payload.renderModel,
    };
}
async function queuePayload(payload, note, dryRun) {
    if (dryRun) return;
    await putJson(`longform/grind/runs/${payload.rid}.json`, initialRunFromPayload(payload, note));
    await putJson(`longform/grind/requests/${payload.rid}.json`, payload);
}
async function requeuePendingRun(rec, opts, dryRun) {
    if (!rec || !rec.run || !rec.id) return null;
    const run = rec.run;
    const video = run.sourceVideo || {};
    const rid = cleanRid(rec.rid || run.rid);
    if (!rid) return null;
    const payload = buildGrindPayload(rid, {
        id: rec.id,
        title: String(video.title || run.title || run.idea || rec.id),
        url: video.url || `https://www.youtube.com/watch?v=${rec.id}`,
        duration: video.duration || null,
        channel: video.channel || 'Tyler Csatari',
        thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${rec.id}/maxresdefault.jpg`,
    }, run.context || run.transcript30 || '', {
        ...opts,
        contextStatus: run.contextStatus || (run.context ? 'ok' : 'missing'),
    });
    if (!dryRun) {
        run.status = 'queued';
        run.note = 'queued as unanalyzed channel work — first attempt will render this original title before exploring variants';
        run.threshold = payload.threshold;
        run.maxAttempts = payload.maxAttempts;
        run.count = payload.count;
        run.hours = payload.hours;
        run.autosaveBest = true;
        run.source = CHANNEL_SOURCE;
        run.batchId = opts.batchId;
        run.ts = Date.now();
        await putJson(`longform/grind/runs/${rid}.json`, run);
        await putJson(`longform/grind/requests/${rid}.json`, payload);
    }
    return { rid, video: payload.sourceVideo, transcriptChars: payload.contextChars, contextStatus: payload.contextStatus, requestKey: `longform/grind/requests/${rid}.json`, requeued: true };
}
async function archiveGeneratedWork(idx, dryRun) {
    const stats = { archived: 0, stopped: 0, deletedRequests: 0 };
    for (const reqRec of idx.channelRequests) {
        if (!reqRec.id || !idx.generatedVideoIds.has(reqRec.id)) continue;
        stats.deletedRequests++;
        if (!dryRun) await cloud.deleteFromR2(reqRec.key).catch(() => {});
    }
    for (const rec of idx.channelRuns) {
        if (!rec.id || !idx.generatedVideoIds.has(rec.id)) continue;
        const run = rec.run || {};
        const rid = cleanRid(rec.rid || run.rid);
        if (!rid || terminalStatus(run.status)) continue;
        stats.archived++;
        stats.stopped++;
        if (!dryRun) {
            await cloud.uploadToR2(`longform/grind/stop/${rid}`, Buffer.from('1'), 'text/plain').catch(() => {});
            await cloud.deleteFromR2(`longform/grind/requests/${rid}.json`).catch(() => {});
            run.status = 'archived';
            run.note = 'closed as done by user — already generated enough; moving channel grind to unanalyzed videos';
            run.archivedAt = Date.now();
            run.ts = Date.now();
            await putJson(rec.key, run);
        }
    }
    return stats;
}
async function main() {
    const channelUrl = arg('channel', 'https://www.youtube.com/@TylerCSatari/videos');
    const limit = parseInt(arg('limit', '0'), 10) || 0;
    const threshold = parseInt(arg('threshold', '90'), 10) || 90;
    const maxAttempts = parseInt(arg('max-attempts', '40'), 10) || 40;
    const count = parseInt(arg('count', '5'), 10) || 5;
    const hours = parseFloat(arg('hours', '8')) || 8;
    const dryRun = has('dry-run');
    const advanceUnanalyzed = has('advance-unanalyzed') || has('close-generated') || has('close-existing');
    const includeGenerated = has('include-generated');
    const forceRequeue = has('force-requeue');
    const extraArgs = [];
    const cookiesBrowser = arg('cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER || '');
    if (cookiesBrowser) extraArgs.push('--cookies-from-browser', cookiesBrowser);

    cloud.initR2();
    if (!cloud.isR2Ready()) throw new Error('R2 is not configured');

    const idx = await existingLongQuantIndex();
    const archiveStats = advanceUnanalyzed ? await archiveGeneratedWork(idx, dryRun) : { archived: 0, stopped: 0, deletedRequests: 0 };
    let videos = await channelVideos(channelUrl, extraArgs);
    const bid = batchId();
    const opts = { threshold, maxAttempts, count, hours, batchId: bid };
    const queued = [], retained = [], skipped = [];
    for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        const alreadyGenerated = idx.generatedVideoIds.has(v.id);
        if (alreadyGenerated && !includeGenerated) {
            skipped.push({ id: v.id, title: v.title, reason: 'already-generated' });
            continue;
        }
        const pending = idx.pendingByVideo.get(v.id);
        if (pending && !forceRequeue) {
            if (pending.request) {
                retained.push({ id: v.id, title: v.title, rid: pending.rid || pending.request.rid, reason: 'already-queued-unstarted' });
            } else {
                const rq = await requeuePendingRun(pending, opts, dryRun);
                if (rq) retained.push({ id: v.id, title: v.title, rid: rq.rid, reason: 'requeued-unstarted' });
            }
            continue;
        }
        if (limit > 0 && queued.length >= limit) {
            skipped.push({ id: v.id, title: v.title, reason: 'limit' });
            continue;
        }
        const context = localTranscriptContext(v.id, v) || await ytdlpTranscriptContext(v.id, v.url, extraArgs, v);
        const contextStatus = context ? 'ok' : 'missing';
        const rid = 'lqg' + Date.now().toString(36) + i.toString(36).padStart(2, '0');
        const payload = buildGrindPayload(rid, v, context, { ...opts, contextStatus });
        const note = `queued by Tyler channel unanalyzed batch — first attempt will render the current video title exactly${context ? ' with transcript context' : ' (transcript missing)'}`;
        queued.push({ rid, video: v, transcriptChars: context.length, contextStatus, requestKey: `longform/grind/requests/${rid}.json` });
        await queuePayload(payload, note, dryRun);
        console.log(`${dryRun ? 'would queue' : 'queued'} ${queued.length}: ${v.id} ${v.title} (${context.length} context chars, ${contextStatus})`);
    }
    const manifest = {
        batchId: bid,
        channelUrl,
        channel: 'Tyler Csatari',
        threshold,
        maxAttempts,
        count,
        hours,
        dryRun,
        advanceUnanalyzed,
        includeGenerated,
        forceRequeue,
        n: queued.length,
        retained: retained.length,
        skipped: skipped.length,
        archiveStats,
        prior: {
            generatedVideos: idx.generatedVideoIds.size,
            pendingVideos: idx.pendingVideoIds.size,
            savedVideos: idx.savedVideoIds.size,
        },
        queuedAt: new Date().toISOString(),
        queued,
        retained,
        skipped: skipped.slice(0, 500),
    };
    if (!dryRun) await cloud.uploadToR2(`longform/grind/batches/${bid}.json`, Buffer.from(JSON.stringify(manifest)), 'application/json');
    console.log(JSON.stringify({ ok: true, dryRun, batchId: bid, queued: queued.length, retained: retained.length, skipped: skipped.length, archiveStats, prior: manifest.prior }, null, 2));
}

main().catch(e => {
    console.error(e && e.stack || e);
    process.exit(1);
});
