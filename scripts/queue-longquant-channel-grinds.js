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
async function main() {
    const channelUrl = arg('channel', 'https://www.youtube.com/@TylerCSatari/videos');
    const limit = parseInt(arg('limit', '0'), 10) || 0;
    const threshold = parseInt(arg('threshold', '90'), 10) || 90;
    const maxAttempts = parseInt(arg('max-attempts', '40'), 10) || 40;
    const count = parseInt(arg('count', '5'), 10) || 5;
    const hours = parseFloat(arg('hours', '8')) || 8;
    const dryRun = has('dry-run');
    const extraArgs = [];
    const cookiesBrowser = arg('cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER || '');
    if (cookiesBrowser) extraArgs.push('--cookies-from-browser', cookiesBrowser);

    cloud.initR2();
    if (!cloud.isR2Ready()) throw new Error('R2 is not configured');

    let videos = await channelVideos(channelUrl, extraArgs);
    if (limit > 0) videos = videos.slice(0, limit);
    const bid = batchId();
    const queued = [];
    for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        const context = localTranscriptContext(v.id, v) || await ytdlpTranscriptContext(v.id, v.url, extraArgs, v);
        const contextStatus = context ? 'ok' : 'missing';
        const rid = 'lqg' + Date.now().toString(36) + i.toString(36).padStart(2, '0');
        const payload = {
            rid,
            idea: v.title,
            title: v.title,
            context,
            transcript30: context,
            contextChars: context.length,
            contextStatus,
            threshold,
            maxAttempts,
            count,
            hours,
            source: 'tyler-channel-overnight',
            batchId: bid,
            autosaveBest: true,
            sourceVideo: v,
            ts: Date.now(),
        };
        queued.push({ rid, video: v, transcriptChars: context.length, contextStatus, requestKey: `longform/grind/requests/${rid}.json` });
        if (!dryRun) {
            await cloud.uploadToR2(`longform/grind/runs/${rid}.json`, Buffer.from(JSON.stringify({
                rid, idea: v.title, title: v.title, context, transcript30: context, contextChars: context.length, contextStatus, sourceVideo: v,
                threshold, count, attempts: [], status: 'queued',
                note: `queued by Tyler channel overnight batch — first attempt will render the current video title exactly${context ? ' with transcript context' : ' (transcript missing)'}`,
                best: null, ts: Date.now(), source: payload.source, batchId: bid,
            })), 'application/json');
            await cloud.uploadToR2(`longform/grind/requests/${rid}.json`, Buffer.from(JSON.stringify(payload)), 'application/json');
        }
        console.log(`${dryRun ? 'would queue' : 'queued'} ${i + 1}/${videos.length}: ${v.id} ${v.title} (${context.length} context chars, ${contextStatus})`);
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
        n: queued.length,
        queuedAt: new Date().toISOString(),
        queued,
    };
    if (!dryRun) await cloud.uploadToR2(`longform/grind/batches/${bid}.json`, Buffer.from(JSON.stringify(manifest)), 'application/json');
    console.log(JSON.stringify({ ok: true, dryRun, batchId: bid, queued: queued.length }, null, 2));
}

main().catch(e => {
    console.error(e && e.stack || e);
    process.exit(1);
});
