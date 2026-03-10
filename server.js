const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env file
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const eq = line.indexOf('=');
        if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
}

const videoAnalyzer = require('./video-analyzer');
const cloud = require('./cloud-storage');
const swipeScraper = require('./swipe-scraper');
const dataStore = require('./data-store');
const PORT = process.env.PORT || 8002;
const DIR = __dirname;
const LAYOUT_FILE = path.join(DIR, 'layout.json');

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
};

// Helper: read request body as JSON
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

// Helper: proxy a fetch and send response
async function proxyFetch(res, url, opts) {
    try {
        const response = await fetch(url, opts);
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
            const buffer = await response.arrayBuffer();
            res.writeHead(response.status, { 'Content-Type': contentType });
            res.end(Buffer.from(buffer));
        } else {
            const text = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(text);
        }
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // --- CORS headers for all API routes ---
    if (pathname.startsWith('/api/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }

    // =========================================
    // API: Debug env vars (shows which keys are set, not their values)
    // =========================================
    if (pathname === '/api/debug-env' && req.method === 'GET') {
        const keys = ['AIRTABLE_TOKEN', 'AIRTABLE_BASE_ID', 'OPENAI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_HOST'];
        const status = {};
        keys.forEach(k => {
            const v = process.env[k];
            status[k] = v ? `set (${v.length} chars, starts with "${v.slice(0, 4)}...")` : 'NOT SET';
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
        return;
    }

    // =========================================
    // API: Non-secret config for frontend
    // =========================================
    if (pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            airtable: {
                boxesTable: 'Box', itemsTable: 'Items', itemsLinkField: 'Link To Box',
                boxesNameField: 'Name', itemsNameField: 'Name', itemsQuantityField: 'Quantity'
            },
            search: { semanticMatchThreshold: parseFloat(process.env.SEMANTIC_MATCH_THRESHOLD) || 0.75 },
            dropbox: { rootPath: process.env.DROPBOX_ROOT_PATH || '' }
        }));
        return;
    }

    // =========================================
    // API: Airtable proxy  /api/airtable/:table[/:recordId]
    // =========================================
    const airtableMatch = pathname.match(/^\/api\/airtable\/([^/]+)(\/([^/]+))?$/);
    if (airtableMatch) {
        const table = decodeURIComponent(airtableMatch[1]);
        const recordId = airtableMatch[3] || '';
        const qs = url.search || '';
        const airtableUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${recordId ? '/' + recordId : ''}${qs}`;

        const opts = {
            method: req.method,
            headers: {
                'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
                'Content-Type': 'application/json'
            }
        };
        if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
            const body = await readBody(req);
            opts.body = JSON.stringify(body);
        }
        await proxyFetch(res, airtableUrl, opts);
        return;
    }

    // =========================================
    // API: OpenAI Chat  /api/openai/chat
    // =========================================
    if (pathname === '/api/openai/chat' && req.method === 'POST') {
        const body = await readBody(req);
        const payload = {
            model: body.model || process.env.OPENAI_CHAT_MODEL || 'gpt-4o',
            messages: body.messages,
            temperature: body.temperature ?? 0
        };
        if (body.max_tokens) payload.max_tokens = body.max_tokens;

        await proxyFetch(res, 'https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return;
    }

    // =========================================
    // API: OpenAI Embeddings  /api/openai/embeddings
    // =========================================
    if (pathname === '/api/openai/embeddings' && req.method === 'POST') {
        const body = await readBody(req);
        const payload = {
            model: body.model || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
            input: body.input,
            dimensions: body.dimensions || parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS) || 512
        };

        await proxyFetch(res, 'https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return;
    }

    // =========================================
    // API: OpenAI TTS  /api/openai/tts
    // =========================================
    if (pathname === '/api/openai/tts' && req.method === 'POST') {
        const body = await readBody(req);
        const payload = {
            model: body.model || process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
            voice: body.voice || process.env.OPENAI_TTS_VOICE || 'alloy',
            input: body.input
        };

        await proxyFetch(res, 'https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return;
    }

    // =========================================
    // API: Pinecone proxy  /api/pinecone/:action
    // =========================================
    const pineconeMatch = pathname.match(/^\/api\/pinecone\/(upsert|delete|query)$/);
    if (pineconeMatch && req.method === 'POST') {
        const action = pineconeMatch[1];
        const paths = { upsert: '/vectors/upsert', delete: '/vectors/delete', query: '/query' };
        const body = await readBody(req);

        await proxyFetch(res, `${process.env.PINECONE_HOST}${paths[action]}`, {
            method: 'POST',
            headers: { 'Api-Key': process.env.PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return;
    }

    // =========================================
    // API: Generic data store — /api/data/:collection[/:id]
    // =========================================
    const dataMatch = pathname.match(/^\/api\/data\/([a-z]+)(?:\/([^/]+))?$/);
    if (dataMatch) {
        const collection = dataMatch[1];
        const id = dataMatch[2] || null;
        if (!dataStore.COLLECTIONS.includes(collection)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown collection: ${collection}` }));
            return;
        }
        try {
            if (req.method === 'GET') {
                const result = id ? await dataStore.getById(collection, id) : await dataStore.getAll(collection);
                if (id && !result) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } else if (req.method === 'POST') {
                const body = await readBody(req);
                const record = await dataStore.create(collection, body);
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(record));
            } else if (req.method === 'PATCH' && id) {
                const body = await readBody(req);
                const record = await dataStore.update(collection, id, body);
                if (!record) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(record));
            } else if (req.method === 'DELETE' && id) {
                const ok = await dataStore.remove(collection, id);
                if (!ok) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } else {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Dropbox proxy — file browser (with auto token refresh)
    // =========================================
    async function dropboxFetch(res, url, opts) {
        const token = await cloud.getDropboxToken();
        opts.headers = { ...opts.headers, 'Authorization': `Bearer ${token}` };
        const response = await fetch(url, opts);
        // If 401, try refresh once
        if (response.status === 401 && process.env.DROPBOX_REFRESH_TOKEN) {
            process.env._DROPBOX_TOKEN_EXPIRED = '1';
            const newToken = await cloud.getDropboxToken();
            opts.headers['Authorization'] = `Bearer ${newToken}`;
            return proxyFetch(res, url, opts);
        }
        // Forward response
        const body = await response.text();
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
        res.end(body);
    }

    const DROPBOX_HEADERS = {
        'Content-Type': 'application/json'
    };

    if (pathname === '/api/dropbox/list_folder' && req.method === 'POST') {
        const body = await readBody(req);
        await dropboxFetch(res, 'https://api.dropboxapi.com/2/files/list_folder', {
            method: 'POST', headers: { ...DROPBOX_HEADERS }, body: JSON.stringify(body)
        });
        return;
    }

    if (pathname === '/api/dropbox/list_folder/continue' && req.method === 'POST') {
        const body = await readBody(req);
        await dropboxFetch(res, 'https://api.dropboxapi.com/2/files/list_folder/continue', {
            method: 'POST', headers: { ...DROPBOX_HEADERS }, body: JSON.stringify(body)
        });
        return;
    }

    if (pathname === '/api/dropbox/get_temporary_link' && req.method === 'POST') {
        const body = await readBody(req);
        await dropboxFetch(res, 'https://api.dropboxapi.com/2/files/get_temporary_link', {
            method: 'POST', headers: { ...DROPBOX_HEADERS }, body: JSON.stringify(body)
        });
        return;
    }

    if (pathname === '/api/dropbox/get_thumbnail' && req.method === 'GET') {
        const filePath = url.searchParams.get('path');
        if (!filePath) { res.writeHead(400); res.end('Missing path'); return; }
        try {
            const token = await cloud.getDropboxToken();
            const response = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Dropbox-API-Arg': JSON.stringify({
                        resource: { '.tag': 'path', path: filePath },
                        format: 'jpeg',
                        size: 'w256h256',
                        mode: 'fitone_bestfit'
                    }),
                    'Content-Type': 'application/octet-stream'
                }
            });
            if (!response.ok) {
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'thumbnail failed' }));
                return;
            }
            const buffer = await response.arrayBuffer();
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
            res.end(Buffer.from(buffer));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Video Analyzer
    // =========================================

    // POST /api/video/analyze — start analysis
    if (pathname === '/api/video/analyze' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (!body.url) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing url' })); return; }
            const result = await videoAnalyzer.startAnalysis(body.url, process.env.OPENAI_API_KEY, process.env.OPENAI_CHAT_MODEL || 'gpt-4o');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/video/discover-shorts — discover Shorts from a channel URL
    if (pathname === '/api/video/discover-shorts' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (!body.channelUrl) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing channelUrl' })); return; }
            const parsed = videoAnalyzer.parseChannelUrl(body.channelUrl);
            if (!parsed) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid channel URL' })); return; }

            const allIds = await videoAnalyzer.discoverChannelShorts(parsed);

            // Filter out IDs already in video records
            const videos = await dataStore.getAll('videos');
            const knownYtIds = new Set(videos.map(v => v.youtubeVideoId).filter(Boolean));

            // Filter out IDs already analyzed in R2
            const newIds = [];
            for (const id of allIds) {
                if (knownYtIds.has(id)) continue;
                if (cloud.isR2Ready() && await cloud.existsInR2(`videos/${id}/analysis.json`)) continue;
                newIds.push(id);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ total: allIds.length, alreadyAnalyzed: allIds.length - newIds.length, newIds }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/video/status/:id — poll progress (in-memory first, then R2)
    const videoStatusMatch = pathname.match(/^\/api\/video\/status\/([a-zA-Z0-9_-]+)$/);
    if (videoStatusMatch && req.method === 'GET') {
        let status = videoAnalyzer.getStatus(videoStatusMatch[1]);
        if (!status && cloud.isR2Ready()) {
            try {
                const r2Job = await cloud.loadJobState(videoStatusMatch[1]);
                if (r2Job) status = r2Job;
            } catch (e) {}
        }
        if (!status) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
    }

    // GET /api/video/metrics-summary — bulk metrics for all posted videos (for sorting in Pen)
    // Fast path: single pre-built R2 file, memory cache, rebuilds every 5 min
    if (pathname === '/api/video/metrics-summary' && req.method === 'GET') {
        try {
            if (!global._metricsCache) await _loadOrBuildMetrics();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' });
            res.end(global._metricsCache);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to load metrics' }));
        }
        return;
    }

    // GET /api/video/analysis/:id — return analysis.json (local first, then R2)
    const videoAnalysisMatch = pathname.match(/^\/api\/video\/analysis\/([a-zA-Z0-9_-]+)$/);
    if (videoAnalysisMatch && req.method === 'GET') {
        const analysis = await videoAnalyzer.getAnalysis(videoAnalysisMatch[1]);
        if (!analysis) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(analysis));
        return;
    }

    // GET /api/video/frame/:id/:file — serve frame JPEG (local first, then R2 redirect)
    const videoFrameMatch = pathname.match(/^\/api\/video\/frame\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (videoFrameMatch && req.method === 'GET') {
        const framePath = videoAnalyzer.getFramePath(videoFrameMatch[1], videoFrameMatch[2]);
        if (framePath) {
            const data = fs.readFileSync(framePath);
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
            res.end(data);
            return;
        }
        // Fall back to R2 signed URL redirect
        const r2Url = await videoAnalyzer.getFrameR2Url(videoFrameMatch[1], videoFrameMatch[2]);
        if (r2Url) {
            res.writeHead(302, { 'Location': r2Url, 'Cache-Control': 'public, max-age=3600' });
            res.end();
            return;
        }
        res.writeHead(404); res.end('Not found');
        return;
    }

    // POST /api/video/reanalyze-frames — re-run frame analysis on existing frames
    // GET /api/video/incomplete-frames — find videos with missing frame analyses
    if (pathname === '/api/video/incomplete-frames' && req.method === 'GET') {
        try {
            const videos = await dataStore.getAll('videos');
            const posted = videos.filter(v => v.youtubeVideoId && v.analysisStatus === 'complete');
            const incomplete = [];
            for (const v of posted) {
                const analysis = await videoAnalyzer.getAnalysis(v.youtubeVideoId);
                if (!analysis || !analysis.frames || analysis.frames.length === 0) continue;
                const missing = analysis.frames.filter(f => !f.analysis || f.analysis.error).length;
                if (missing > 0) {
                    incomplete.push({ id: v.id, ytId: v.youtubeVideoId, name: v.name, totalFrames: analysis.frames.length, missingFrames: missing });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ total: posted.length, incomplete }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/video/reanalyze-frames' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (!body.videoId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing videoId' })); return; }
            const result = await videoAnalyzer.reanalyzeFrames(body.videoId, process.env.OPENAI_API_KEY, process.env.OPENAI_CHAT_MODEL || 'gpt-4o');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/video/missing-transcripts — find videos with empty/missing transcripts
    if (pathname === '/api/video/missing-transcripts' && req.method === 'GET') {
        try {
            const videos = await dataStore.getAll('videos');
            const posted = videos.filter(v => v.youtubeVideoId && v.analysisStatus === 'complete');
            const missing = [];
            for (const v of posted) {
                const analysis = await videoAnalyzer.getAnalysis(v.youtubeVideoId);
                if (analysis && (!analysis.transcript || !analysis.transcript.fullText)) {
                    missing.push({ id: v.id, ytId: v.youtubeVideoId, name: v.name });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ total: posted.length, missing }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/video/refetch-transcript — re-download captions for a video
    if (pathname === '/api/video/refetch-transcript' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (!body.videoId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing videoId' })); return; }
            const result = await videoAnalyzer.refetchTranscript(body.videoId, process.env.OPENAI_API_KEY);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/video/missing-dropbox — find videos without dropboxPath
    if (pathname === '/api/video/missing-dropbox' && req.method === 'GET') {
        try {
            const videos = await dataStore.getAll('videos');
            const posted = videos.filter(v => v.youtubeVideoId && v.analysisStatus === 'complete');
            const missing = [];
            for (const v of posted) {
                const analysis = await videoAnalyzer.getAnalysis(v.youtubeVideoId);
                if (!analysis || !analysis.dropboxPath) {
                    missing.push({ id: v.id, ytId: v.youtubeVideoId, name: v.name });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ total: posted.length, missing }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/video/missing-hd — find videos without dropboxHDPath
    if (pathname === '/api/video/missing-hd' && req.method === 'GET') {
        try {
            const videos = await dataStore.getAll('videos');
            const posted = videos.filter(v => v.youtubeVideoId && v.analysisStatus === 'complete');
            const missing = [];
            for (const v of posted) {
                const analysis = await videoAnalyzer.getAnalysis(v.youtubeVideoId);
                if (!analysis || !analysis.dropboxHDPath) {
                    missing.push({ id: v.id, ytId: v.youtubeVideoId, name: v.name });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ total: posted.length, missing }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/video/reupload-dropbox — re-download and upload to Dropbox
    if (pathname === '/api/video/reupload-dropbox' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (!body.videoId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing videoId' })); return; }
            const result = await videoAnalyzer.reuploadToDropbox(body.videoId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/video/download-hd — download HD and upload to Dropbox
    if (pathname === '/api/video/download-hd' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (!body.videoId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing videoId' })); return; }
            const result = await videoAnalyzer.downloadHD(body.videoId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/youtube/status — check if YouTube credentials are configured
    if (pathname === '/api/youtube/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            hasCredentials: !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET),
            isConnected: !!process.env.YOUTUBE_REFRESH_TOKEN
        }));
        return;
    }

    // POST /api/youtube/save-credentials — save Client ID + Secret to .env
    if (pathname === '/api/youtube/save-credentials' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (!body.clientId || !body.clientSecret) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing clientId or clientSecret' }));
                return;
            }
            process.env.YOUTUBE_CLIENT_ID = body.clientId.trim();
            process.env.YOUTUBE_CLIENT_SECRET = body.clientSecret.trim();
            // Persist to .env
            if (!process.env.RENDER) {
                try {
                    let envContent = fs.readFileSync(envPath, 'utf8');
                    // Update or add CLIENT_ID
                    if (envContent.match(/^YOUTUBE_CLIENT_ID=/m)) {
                        envContent = envContent.replace(/^YOUTUBE_CLIENT_ID=.*$/m, `YOUTUBE_CLIENT_ID=${process.env.YOUTUBE_CLIENT_ID}`);
                    } else {
                        envContent += `\nYOUTUBE_CLIENT_ID=${process.env.YOUTUBE_CLIENT_ID}`;
                    }
                    // Update or add CLIENT_SECRET
                    if (envContent.match(/^YOUTUBE_CLIENT_SECRET=/m)) {
                        envContent = envContent.replace(/^YOUTUBE_CLIENT_SECRET=.*$/m, `YOUTUBE_CLIENT_SECRET=${process.env.YOUTUBE_CLIENT_SECRET}`);
                    } else {
                        envContent += `\nYOUTUBE_CLIENT_SECRET=${process.env.YOUTUBE_CLIENT_SECRET}`;
                    }
                    fs.writeFileSync(envPath, envContent, 'utf8');
                } catch (e) {}
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/youtube/clear-token — clear stored refresh token to force re-auth
    if (pathname === '/api/youtube/clear-token' && req.method === 'POST') {
        delete process.env.YOUTUBE_REFRESH_TOKEN;
        delete process.env._YOUTUBE_ACCESS_TOKEN;
        // Also remove from .env file
        if (!process.env.RENDER) {
            try {
                let envContent = fs.readFileSync(envPath, 'utf8');
                envContent = envContent.replace(/^YOUTUBE_REFRESH_TOKEN=.*\n?/m, '');
                fs.writeFileSync(envPath, envContent, 'utf8');
            } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // GET /api/youtube/auth-url — build OAuth2 authorize URL
    if (pathname === '/api/youtube/auth-url' && req.method === 'GET') {
        const clientId = process.env.YOUTUBE_CLIENT_ID;
        if (!clientId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'YOUTUBE_CLIENT_ID not configured' })); return; }
        const redirect = `http://localhost:${PORT}/api/youtube/callback`;
        const scope = 'https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/yt-analytics-monetary.readonly https://www.googleapis.com/auth/youtube.readonly';
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: authUrl }));
        return;
    }

    // GET /api/youtube/callback — exchange code for tokens
    if (pathname === '/api/youtube/callback' && req.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) { res.writeHead(400); res.end('Missing code'); return; }
        try {
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code,
                    client_id: process.env.YOUTUBE_CLIENT_ID,
                    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
                    redirect_uri: `http://localhost:${PORT}/api/youtube/callback`,
                    grant_type: 'authorization_code'
                }).toString()
            });
            const tokenData = await tokenRes.json();
            if (tokenData.refresh_token) {
                process.env.YOUTUBE_REFRESH_TOKEN = tokenData.refresh_token;
                if (!process.env.RENDER) {
                    try {
                        let envContent = fs.readFileSync(envPath, 'utf8');
                        if (envContent.match(/^YOUTUBE_REFRESH_TOKEN=/m)) {
                            envContent = envContent.replace(/^YOUTUBE_REFRESH_TOKEN=.*$/m, `YOUTUBE_REFRESH_TOKEN=${tokenData.refresh_token}`);
                        } else {
                            envContent += `\nYOUTUBE_REFRESH_TOKEN=${tokenData.refresh_token}`;
                        }
                        fs.writeFileSync(envPath, envContent, 'utf8');
                    } catch (e) {}
                }
            }
            if (tokenData.access_token) process.env._YOUTUBE_ACCESS_TOKEN = tokenData.access_token;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>YouTube connected!</h2><p>You can close this window.</p><script>window.close()</script></body></html>');
        } catch (e) {
            res.writeHead(500); res.end('OAuth failed: ' + e.message);
        }
        return;
    }

    // GET /api/youtube/analytics/:id — fetch retention data
    const ytAnalyticsMatch = pathname.match(/^\/api\/youtube\/analytics\/([a-zA-Z0-9_-]+)$/);
    if (ytAnalyticsMatch && req.method === 'GET') {
        const ytVideoId = ytAnalyticsMatch[1];
        try {
            // Refresh access token if we have a refresh token
            let accessToken = process.env._YOUTUBE_ACCESS_TOKEN;
            if (!accessToken && process.env.YOUTUBE_REFRESH_TOKEN) {
                const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
                        client_id: process.env.YOUTUBE_CLIENT_ID,
                        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
                        grant_type: 'refresh_token'
                    }).toString()
                });
                const tokenData = await tokenRes.json();
                if (tokenData.access_token) {
                    accessToken = tokenData.access_token;
                    process.env._YOUTUBE_ACCESS_TOKEN = accessToken;
                }
            }
            if (!accessToken) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not authenticated. Connect YouTube first.' })); return; }

            const authHeaders = { 'Authorization': `Bearer ${accessToken}` };
            const ytApi = (params) => `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2000-01-01&endDate=2099-12-31&filters=video==${ytVideoId}&${params}`;

            // Fire all queries in parallel
            const subFilter = encodeURIComponent(`video==${ytVideoId};subscribedStatus==SUBSCRIBED`);
            const nonSubFilter = encodeURIComponent(`video==${ytVideoId};subscribedStatus==UNSUBSCRIBED`);

            const [retentionRes, statsRes, engagementRes, subViewsRes, nonSubViewsRes, revenueRes, swipeRes, dailyViewsRes] = await Promise.all([
                // 1. Retention curve — every 1% mark
                fetch(ytApi('metrics=audienceWatchRatio&dimensions=elapsedVideoTimeRatio&sort=elapsedVideoTimeRatio'), { headers: authHeaders }),
                // 2. Basic stats
                fetch(ytApi('metrics=views,averageViewDuration,averageViewPercentage'), { headers: authHeaders }),
                // 3. Engagement — likes, shares, comments, subscribersGained
                fetch(ytApi('metrics=likes,shares,comments,subscribersGained,subscribersLost'), { headers: authHeaders }),
                // 4. Subscriber views
                fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2000-01-01&endDate=2099-12-31&metrics=views,averageViewPercentage&filters=${subFilter}`, { headers: authHeaders }),
                // 5. Non-subscriber views
                fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2000-01-01&endDate=2099-12-31&metrics=views,averageViewPercentage&filters=${nonSubFilter}`, { headers: authHeaders }),
                // 6. Revenue (requires monetary scope)
                fetch(ytApi('metrics=estimatedRevenue'), { headers: authHeaders }),
                // 7. Engagement rate: engagedViews = views past initial seconds
                fetch(ytApi('metrics=views,engagedViews'), { headers: authHeaders }),
                // 8. Daily views breakdown for time-interval comparison
                fetch(ytApi('metrics=views,estimatedMinutesWatched&dimensions=day&sort=day'), { headers: authHeaders }),
            ]);

            const [retentionData, statsData, engagementData, subViewsData, nonSubViewsData, revenueData, swipeData, dailyViewsData] = await Promise.all([
                retentionRes.json(), statsRes.json(), engagementRes.json(), subViewsRes.json(), nonSubViewsRes.json(), revenueRes.json(), swipeRes.json(), dailyViewsRes.json()
            ]);

            // Parse retention curve (100 data points, every 1%)
            const retentionCurve = [];
            let avgRetention = null, retentionVariation = null;

            if (retentionData.rows && retentionData.rows.length > 0) {
                const retentions = [];
                for (const row of retentionData.rows) {
                    retentionCurve.push({ second: row[0], retention: row[1] });
                    retentions.push(row[1]);
                }
                avgRetention = retentions.reduce((a, b) => a + b, 0) / retentions.length;
                const mean = avgRetention;
                retentionVariation = Math.sqrt(retentions.reduce((sum, r) => sum + (r - mean) ** 2, 0) / retentions.length);
            }

            // Parse basic stats
            let avgPercentViewed = null, avgViewDuration = null, totalViews = null;
            if (statsData.rows && statsData.rows.length > 0) {
                totalViews = statsData.rows[0][0];
                avgViewDuration = statsData.rows[0][1];
                avgPercentViewed = statsData.rows[0][2];
            }

            // Parse swipe-away rate from engagedViews
            // views = all plays (Shorts: includes when Short starts playing in feed)
            // engagedViews = views that watched past the initial seconds (stayed to watch)
            // swipedAwayRate = (views - engagedViews) / views * 100
            let engagedViews = null, swipedAwayRate = null, viewedRate = null;
            if (swipeData.rows && swipeData.rows.length > 0) {
                const swipeViews = swipeData.rows[0][0];
                engagedViews = swipeData.rows[0][1];
                if (engagedViews != null && swipeViews > 0) {
                    viewedRate = (engagedViews / swipeViews) * 100;
                    swipedAwayRate = 100 - viewedRate;
                }
            }

            // Parse engagement
            let likes = null, shares = null, ytComments = null, subscribersGained = null, subscribersLost = null;
            if (engagementData.rows && engagementData.rows.length > 0) {
                likes = engagementData.rows[0][0];
                shares = engagementData.rows[0][1];
                ytComments = engagementData.rows[0][2];
                subscribersGained = engagementData.rows[0][3];
                subscribersLost = engagementData.rows[0][4];
            }

            // Parse subscriber vs non-subscriber
            let subscriberViews = null, nonSubscriberViews = null;
            let subscriberAvgPercent = null, nonSubscriberAvgPercent = null;
            if (subViewsData.rows && subViewsData.rows.length > 0) {
                subscriberViews = subViewsData.rows[0][0];
                subscriberAvgPercent = subViewsData.rows[0][1];
            }
            if (nonSubViewsData.rows && nonSubViewsData.rows.length > 0) {
                nonSubscriberViews = nonSubViewsData.rows[0][0];
                nonSubscriberAvgPercent = nonSubViewsData.rows[0][1];
            }

            // Parse revenue
            let estimatedRevenue = null;
            if (revenueData.rows && revenueData.rows.length > 0) {
                estimatedRevenue = revenueData.rows[0][0];
            }

            // Parse daily views for time-interval comparison
            const dailyViews = [];
            if (dailyViewsData.rows) {
                let cumulative = 0;
                for (const row of dailyViewsData.rows) {
                    if (row[1] === 0 && cumulative === 0) continue; // skip days before video existed
                    cumulative += row[1];
                    dailyViews.push({ date: row[0], views: row[1], cumulative, watchMinutes: row[2] });
                }
            }

            const analytics = {
                avgRetention, retentionVariation, avgPercentViewed, avgViewDuration,
                totalViews,
                engagedViews, viewedRate, swipedAwayRate,
                likes, shares, comments: ytComments,
                subscribersGained, subscribersLost,
                subscriberViews, nonSubscriberViews,
                subscriberAvgPercent, nonSubscriberAvgPercent,
                estimatedRevenue,
                retentionCurve,
                dailyViews
            };

            // Merge into analysis.json if it exists — also update likes in metadata
            const analysis = await videoAnalyzer.getAnalysis(ytVideoId);
            if (analysis) {
                analysis.analytics = analytics;
                // Update likes/comments from analytics (more accurate than yt-dlp which may get 0 for private counts)
                if (likes != null) analysis.metadata.likeCount = likes;
                if (ytComments != null) analysis.metadata.commentCount = ytComments;
                if (totalViews != null) analysis.metadata.viewCount = totalViews;
                const analysisPath = path.join(__dirname, 'video_data', ytVideoId, 'analysis.json');
                fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
                fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
                // Also upload to R2
                videoAnalyzer.uploadAnalysisToR2(ytVideoId, analysis);

                // Save analytics snapshot for history tracking
                try {
                    await cloud.saveAnalyticsSnapshot(ytVideoId, {
                        totalViews, engagedViews, viewedRate, swipedAwayRate,
                        subscriberViews, nonSubscriberViews,
                        avgRetention, avgPercentViewed,
                        likes, shares, subscribersGained,
                    });
                } catch (snapErr) {
                    console.warn(`Analytics snapshot save failed for ${ytVideoId}:`, snapErr.message);
                }
                // Invalidate metrics cache so next request rebuilds with fresh data
                global._metricsCacheTime = 0;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(analytics));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/youtube/analytics-missing — return video IDs that have analysis but no analytics
    if (pathname === '/api/youtube/analytics-missing' && req.method === 'GET') {
        try {
            const videos = await dataStore.getAll('videos');
            const posted = videos.filter(v => v.youtubeVideoId && v.analysisStatus === 'complete');
            const missing = [];
            for (const v of posted) {
                const analysis = await videoAnalyzer.getAnalysis(v.youtubeVideoId);
                if (analysis && (analysis.analytics == null || analysis.analytics.totalViews == null)) {
                    missing.push({ id: v.id, ytId: v.youtubeVideoId, name: v.name });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ total: posted.length, missing }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Analytics History — list snapshots from R2
    // =========================================
    const analyticsHistoryMatch = pathname.match(/^\/api\/video\/analytics-history\/([a-zA-Z0-9_-]+)$/);
    if (analyticsHistoryMatch && req.method === 'GET') {
        const vid = analyticsHistoryMatch[1];
        try {
            const snapshots = await cloud.getAllAnalyticsSnapshots(vid);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ videoId: vid, snapshots }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Swipe Ratio Scraper — Playwright-based YouTube Studio scraping
    // =========================================

    // Check scrape status (for polling from frontend)
    if (pathname === '/api/youtube/swipe-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(swipeScraper.getStatus()));
        return;
    }

    // One-button flow: opens Chrome, logs in if needed, scrapes all videos
    if (pathname === '/api/youtube/fetch-swipe-ratios' && req.method === 'POST') {
        // Gather video IDs first (before launching browser)
        const videoIds = [];
        try {
            if (cloud.isR2Ready()) {
                const keys = await cloud.listR2Keys('videos/');
                const ids = [...new Set(keys.filter(k => k.endsWith('/analysis.json')).map(k => k.split('/')[1]))];
                console.log(`[swipe] Found ${ids.length} videos in R2`);
                for (const vid of ids) {
                    try {
                        const analysis = await videoAnalyzer.getAnalysis(vid);
                        if (analysis && !analysis?.analytics?.swipeRatio?.scrapedAt) {
                            videoIds.push(vid);
                        }
                    } catch (e) {}
                }
            }
            // Also check local video_data
            const videoDataDir = path.join(__dirname, 'video_data');
            if (fs.existsSync(videoDataDir)) {
                const dirs = fs.readdirSync(videoDataDir).filter(d =>
                    fs.existsSync(path.join(videoDataDir, d, 'analysis.json'))
                );
                for (const vid of dirs) {
                    if (videoIds.includes(vid)) continue;
                    try {
                        const analysis = JSON.parse(fs.readFileSync(path.join(videoDataDir, vid, 'analysis.json'), 'utf8'));
                        if (!analysis?.analytics?.swipeRatio) {
                            videoIds.push(vid);
                        }
                    } catch (e) {}
                }
            }
            console.log(`[swipe] ${videoIds.length} videos need swipe data`);
        } catch (e) {
            console.error('[swipe] Error gathering videos:', e.message);
        }

        if (videoIds.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'No videos found needing swipe data', results: {}, total: 0 }));
            return;
        }

        // Respond immediately, run scraper in background
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'started', total: videoIds.length, message: 'Chrome is opening. Log in if prompted, then scraping will begin automatically.' }));

        // Run the scraper in background
        swipeScraper.scrapeAll(videoIds, (progress) => {
            console.log(`[swipe] ${progress.current}/${progress.total}: ${progress.videoId}`);
        }).then(async (results) => {
            // Save results into each video's analysis
            for (const [videoId, data] of Object.entries(results)) {
                if (data.error) continue;
                try {
                    const analysis = await videoAnalyzer.getAnalysis(videoId);
                    if (analysis) {
                        if (!analysis.analytics) analysis.analytics = {};
                        analysis.analytics.swipeRatio = {
                            stayedToWatch: data.stayedToWatch,
                            swipedAway: data.swipedAway,
                            subscriberStayed: data.subscriberStayed || null,
                            subscriberSwiped: data.subscriberSwiped || null,
                            nonSubscriberStayed: data.nonSubscriberStayed || null,
                            nonSubscriberSwiped: data.nonSubscriberSwiped || null,
                            scrapedAt: data.scrapedAt
                        };
                        const analysisPath = path.join(__dirname, 'video_data', videoId, 'analysis.json');
                        fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
                        fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
                        videoAnalyzer.uploadAnalysisToR2(videoId, analysis);
                    }
                } catch (e) {
                    console.error(`[swipe] Failed to save ${videoId}:`, e.message);
                }
            }
            const ok = Object.values(results).filter(r => !r.error).length;
            const fail = Object.values(results).filter(r => r.error).length;
            console.log(`[swipe] Done! ${ok} scraped, ${fail} failed`);
        }).catch(err => {
            console.error('[swipe] Scrape failed:', err.message);
        });

        return;
    }

    // =========================================
    // API: Performance Scoring — rank video against last 10 at same time interval
    // =========================================
    const perfScoreMatch = pathname.match(/^\/api\/video\/performance-score\/([a-zA-Z0-9_-]+)$/);
    if (perfScoreMatch && req.method === 'GET') {
        const targetId = perfScoreMatch[1];
        try {
            // Load the target video's analysis
            const targetAnalysis = await videoAnalyzer.getAnalysis(targetId);
            if (!targetAnalysis || !targetAnalysis.analytics || !targetAnalysis.analytics.totalViews) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No analytics data for this video. Fetch analytics first.' }));
                return;
            }

            // How many days since this video was uploaded?
            function getUploadDate(analysis) {
                const ud = analysis.metadata?.uploadDate;
                if (!ud) return null;
                return new Date(ud.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
            }
            const targetUpload = getUploadDate(targetAnalysis);
            const targetDaysSinceUpload = targetUpload
                ? Math.max(1, Math.floor((Date.now() - targetUpload.getTime()) / 86400000))
                : null;

            // Get cumulative views at the target's current age from dailyViews
            function getCumulativeAtDay(analysis, dayNum) {
                const dv = analysis.analytics?.dailyViews;
                if (!dv || dv.length === 0) return null;
                // dailyViews is sorted chronologically, cumulative is pre-computed
                if (dayNum >= dv.length) return dv[dv.length - 1].cumulative;
                return dv[Math.max(0, dayNum - 1)]?.cumulative ?? null;
            }

            const targetViewsAtAge = targetDaysSinceUpload
                ? getCumulativeAtDay(targetAnalysis, targetDaysSinceUpload)
                : targetAnalysis.analytics.totalViews;

            // Format the time label (e.g., "First 6 days")
            const timeLabel = targetDaysSinceUpload
                ? `First ${targetDaysSinceUpload} day${targetDaysSinceUpload !== 1 ? 's' : ''}`
                : 'All time';

            // Load all analysis files from R2 to find comparison videos
            const allVideos = [];
            if (cloud.isR2Ready()) {
                const keys = await cloud.listR2Keys('videos/');
                const videoIds = [...new Set(keys.filter(k => k.endsWith('/analysis.json')).map(k => k.split('/')[1]))];
                for (const vid of videoIds) {
                    if (vid === targetId) continue;
                    try {
                        const a = await videoAnalyzer.getAnalysis(vid);
                        if (a && a.analytics && a.analytics.totalViews != null && a.analyzedAt) {
                            allVideos.push(a);
                        }
                    } catch (e) {}
                }
            }

            // Sort by upload date (most recent first), take last 10
            allVideos.sort((a, b) => {
                const da = a.metadata?.uploadDate || '';
                const db = b.metadata?.uploadDate || '';
                return db.localeCompare(da);
            });
            const comparisons = allVideos.slice(0, 10);

            // For each comparison video, get their cumulative views at the SAME day count
            const compViewsAtAge = comparisons.map(a => {
                if (!targetDaysSinceUpload) return a.analytics.totalViews;
                return getCumulativeAtDay(a, targetDaysSinceUpload);
            }).filter(v => v != null);

            const compRetentions = comparisons.map(a => a.analytics.avgRetention || 0);
            const compRevenues = comparisons.map(a => a.analytics.estimatedRevenue || 0);
            const compEngagementRates = comparisons.map(a => {
                if (a.analytics.engagedViews && a.analytics.totalViews)
                    return (a.analytics.engagedViews / a.analytics.totalViews) * 100;
                return null;
            }).filter(v => v != null);

            const targetEngagementRate = (targetAnalysis.analytics.engagedViews && targetAnalysis.analytics.totalViews)
                ? (targetAnalysis.analytics.engagedViews / targetAnalysis.analytics.totalViews) * 100
                : null;
            const targetRevenue = targetAnalysis.analytics.estimatedRevenue || 0;
            const targetAvgRet = targetAnalysis.analytics.avgRetention || 0;

            // Rank: position among comparisons (1 = best, 10 = worst)
            function rankScore(val, compArr) {
                if (compArr.length === 0) return null;
                const beaten = compArr.filter(c => val > c).length;
                return Math.max(1, Math.min(10, 11 - (Math.round((beaten / compArr.length) * 9) + 1)));
            }

            // Build typical range from comparisons
            let typicalLow = null, typicalHigh = null, typicalMedian = null;
            if (compViewsAtAge.length > 0) {
                const sorted = [...compViewsAtAge].sort((a, b) => a - b);
                typicalLow = sorted[Math.floor(sorted.length * 0.25)];
                typicalHigh = sorted[Math.floor(sorted.length * 0.75)];
                typicalMedian = sorted[Math.floor(sorted.length / 2)];
            }

            const viewsScore = compViewsAtAge.length > 0 ? rankScore(targetViewsAtAge, compViewsAtAge) : null;
            const retScore = comparisons.length > 0 ? rankScore(targetAvgRet, compRetentions) : null;
            const revScore = comparisons.length > 0 ? rankScore(targetRevenue, compRevenues) : null;
            const engScore = (targetEngagementRate != null && compEngagementRates.length > 0)
                ? rankScore(targetEngagementRate, compEngagementRates) : null;

            // Overall score = views-based ranking (like YouTube Studio)
            const typical = viewsScore;

            // Balanced = weighted composite
            let balanced = null;
            if (viewsScore != null && retScore != null) {
                const hasRev = targetRevenue > 0 || compRevenues.some(r => r > 0);
                const hasEng = engScore != null;
                if (hasRev && hasEng) {
                    balanced = Math.round(viewsScore * 0.3 + retScore * 0.25 + engScore * 0.2 + revScore * 0.25);
                } else if (hasRev) {
                    balanced = Math.round(viewsScore * 0.4 + retScore * 0.3 + revScore * 0.3);
                } else if (hasEng) {
                    balanced = Math.round(viewsScore * 0.4 + retScore * 0.3 + engScore * 0.3);
                } else {
                    balanced = Math.round(viewsScore * 0.5 + retScore * 0.5);
                }
                balanced = Math.max(1, Math.min(10, balanced));
            }

            const metricsObj = {
                views: { value: targetViewsAtAge || targetAnalysis.analytics.totalViews, score: viewsScore },
                avgRetention: { value: targetAvgRet, score: retScore },
                revenue: { value: targetRevenue, score: revScore },
            };
            if (engScore != null) {
                metricsObj.engagementRate = { value: targetEngagementRate, score: engScore };
            }

            // Comparison video list (for UI display)
            const compList = comparisons.map((a, i) => ({
                videoId: a.videoId,
                title: a.metadata?.title || a.videoId,
                viewsAtAge: compViewsAtAge[i] ?? a.analytics.totalViews,
            })).sort((a, b) => (b.viewsAtAge || 0) - (a.viewsAtAge || 0));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                typical,
                balanced,
                metrics: metricsObj,
                comparedTo: comparisons.length,
                timeLabel,
                daysSinceUpload: targetDaysSinceUpload,
                targetViews: targetViewsAtAge || targetAnalysis.analytics.totalViews,
                typicalRange: typicalLow != null ? { low: typicalLow, median: typicalMedian, high: typicalHigh } : null,
                compList
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // Privacy Policy (for Google OAuth app publishing)
    // =========================================
    if (pathname === '/privacy-policy' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Privacy Policy - Business World</title>
<style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;color:#333;line-height:1.6;}h1{color:#5a3e1b;}</style></head><body>
<h1>Privacy Policy</h1>
<p><strong>Last updated:</strong> February 2026</p>
<p>Business World is a personal productivity tool. This application accesses YouTube Analytics data solely for the account owner's personal use.</p>
<h2>Data We Access</h2>
<ul><li>YouTube Analytics data (video performance, retention, revenue metrics)</li>
<li>This data is only displayed to you within the application and is not shared with any third parties.</li></ul>
<h2>Data Storage</h2>
<p>Analytics data is cached locally and in private cloud storage (Cloudflare R2) solely for your convenience. No data is sold, shared, or used for advertising.</p>
<h2>Third-Party Services</h2>
<p>This app uses Google OAuth to authenticate with YouTube. No data is sent to any other third parties.</p>
<h2>Contact</h2>
<p>Tyler Csatari — tyler@tylercsatari.com</p>
</body></html>`);
        return;
    }

    // =========================================
    // Save layout (local dev only — Render's ephemeral disk would cause drift)
    // =========================================
    if (req.method === 'POST' && pathname === '/save-layout') {
        if (process.env.RENDER) {
            // On Render, layout.json from git is the source of truth — don't overwrite
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true,"readonly":true}');
            return;
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                JSON.parse(body);
                fs.writeFileSync(LAYOUT_FILE, body, 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            } catch (e) {
                res.writeHead(400);
                res.end('Invalid JSON');
            }
        });
        return;
    }

    // =========================================
    // READ-ONLY API v1 — /api/v1/*
    // External programs can query all data without modifying anything.
    // Auth: set API_READ_KEY in .env to require ?key= or X-API-Key header.
    // =========================================
    if (pathname.startsWith('/api/v1/')) {
        // Auth check
        const apiKey = process.env.API_READ_KEY;
        if (apiKey) {
            const provided = url.searchParams.get('key') || req.headers['x-api-key'];
            if (provided !== apiKey) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid or missing API key' }));
                return;
            }
        }

        // Only GET allowed
        if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Read-only API: only GET requests allowed' }));
            return;
        }

        const json = (data, status = 200) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };

        try {
            const v1path = pathname.slice('/api/v1'.length); // e.g. "/videos" or "/videos/abc123"

            // --- Overview: summary stats across everything ---
            if (v1path === '/overview') {
                const [videos, ideas, todos, calendar, invoices, notes] = await Promise.all(
                    ['videos', 'ideas', 'todos', 'calendar', 'invoices', 'notes'].map(c => dataStore.getAll(c))
                );
                // Inventory from Airtable
                let boxCount = 0, itemCount = 0;
                try {
                    const boxRes = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent('Box')}?pageSize=100`, {
                        headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
                    });
                    const boxData = await boxRes.json();
                    boxCount = boxData.records?.length || 0;
                    const itemRes = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent('Items')}?pageSize=100`, {
                        headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
                    });
                    const itemData = await itemRes.json();
                    itemCount = itemData.records?.length || 0;
                } catch (e) {}

                json({
                    videos: { total: videos.length, complete: videos.filter(v => v.analysisStatus === 'complete').length },
                    ideas: { total: ideas.length },
                    todos: { total: todos.length },
                    calendar: { total: calendar.length },
                    invoices: { total: invoices.length },
                    notes: { total: notes.length },
                    inventory: { boxes: boxCount, items: itemCount }
                });
                return;
            }

            // --- Data store collections: videos, ideas, scripts, todos, calendar, invoices ---
            const collectionMatch = v1path.match(/^\/(videos|ideas|todos|calendar|invoices|notes)(?:\/([^/]+))?$/);
            if (collectionMatch) {
                const collection = collectionMatch[1];
                const id = collectionMatch[2];

                if (id) {
                    const record = await dataStore.getById(collection, id);
                    if (!record) { json({ error: 'Not found' }, 404); return; }
                    json(record);
                } else {
                    const records = await dataStore.getAll(collection);
                    json(records);
                }
                return;
            }

            // --- Video analysis (by YouTube video ID) ---
            const analysisMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/analysis$/);
            if (analysisMatch) {
                const analysis = await videoAnalyzer.getAnalysis(analysisMatch[1]);
                if (!analysis) { json({ error: 'No analysis found' }, 404); return; }
                json(analysis);
                return;
            }

            // --- Video analytics only ---
            const analyticsMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/analytics$/);
            if (analyticsMatch) {
                const analysis = await videoAnalyzer.getAnalysis(analyticsMatch[1]);
                if (!analysis || !analysis.analytics) { json({ error: 'No analytics found' }, 404); return; }
                json(analysis.analytics);
                return;
            }

            // --- Video analytics history (snapshots over time) ---
            const analyticsHistMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/analytics\/history$/);
            if (analyticsHistMatch) {
                const snapshots = await cloud.getAllAnalyticsSnapshots(analyticsHistMatch[1]);
                json({ videoId: analyticsHistMatch[1], snapshots });
                return;
            }

            // --- Video transcript ---
            const transcriptMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/transcript$/);
            if (transcriptMatch) {
                const analysis = await videoAnalyzer.getAnalysis(transcriptMatch[1]);
                if (!analysis || !analysis.transcript) { json({ error: 'No transcript found' }, 404); return; }
                json(analysis.transcript);
                return;
            }

            // --- Video frames list ---
            const framesMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/frames$/);
            if (framesMatch) {
                const analysis = await videoAnalyzer.getAnalysis(framesMatch[1]);
                if (!analysis || !analysis.frames) { json({ error: 'No frames found' }, 404); return; }
                json(analysis.frames.map(f => ({
                    timestamp: f.timestamp,
                    filename: f.filename,
                    analysis: f.analysis || null,
                    url: `/api/v1/videos/${framesMatch[1]}/frames/${f.filename}${apiKey ? '?key=' + apiKey : ''}`
                })));
                return;
            }

            // --- Video single frame image ---
            const frameMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/frames\/([a-zA-Z0-9_.-]+)$/);
            if (frameMatch) {
                const [, vid, filename] = frameMatch;
                // Try local first
                const framePath = videoAnalyzer.getFramePath(vid, filename);
                if (framePath) {
                    const data = fs.readFileSync(framePath);
                    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
                    res.end(data);
                    return;
                }
                // Try R2 signed URL redirect
                const r2Url = await videoAnalyzer.getFrameR2Url(vid, filename);
                if (r2Url) {
                    res.writeHead(302, { 'Location': r2Url, 'Cache-Control': 'public, max-age=3600' });
                    res.end();
                    return;
                }
                res.writeHead(404); res.end('Not found');
                return;
            }

            // --- Video metadata (title, description, duration, etc.) ---
            const metadataMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/metadata$/);
            if (metadataMatch) {
                const analysis = await videoAnalyzer.getAnalysis(metadataMatch[1]);
                if (!analysis || !analysis.metadata) { json({ error: 'No metadata found' }, 404); return; }
                json(analysis.metadata);
                return;
            }

            // --- Video performance score ---
            const perfMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/performance$/);
            if (perfMatch) {
                const targetId = perfMatch[1];
                const targetAnalysis = await videoAnalyzer.getAnalysis(targetId);
                if (!targetAnalysis || !targetAnalysis.analytics || !targetAnalysis.analytics.totalViews) {
                    json({ error: 'No analytics data for this video' }, 404);
                    return;
                }
                // Redirect to existing performance endpoint logic by forwarding internally
                // We'll compute inline for the read-only API
                function getUploadDate(a) {
                    const ud = a.metadata?.uploadDate;
                    if (!ud) return null;
                    return new Date(ud.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
                }
                const targetUpload = getUploadDate(targetAnalysis);
                const daysAge = targetUpload ? Math.max(1, Math.floor((Date.now() - targetUpload.getTime()) / 86400000)) : null;
                function getCumAt(a, d) {
                    const dv = a.analytics?.dailyViews;
                    if (!dv || !dv.length) return null;
                    if (d >= dv.length) return dv[dv.length - 1].cumulative;
                    return dv[Math.max(0, d - 1)]?.cumulative ?? null;
                }
                const targetViewsAtAge = daysAge ? getCumAt(targetAnalysis, daysAge) : targetAnalysis.analytics.totalViews;

                json({
                    videoId: targetId,
                    title: targetAnalysis.metadata?.title,
                    daysSinceUpload: daysAge,
                    viewsAtAge: targetViewsAtAge,
                    totalViews: targetAnalysis.analytics.totalViews,
                    avgRetention: targetAnalysis.analytics.avgRetention,
                    engagedViews: targetAnalysis.analytics.engagedViews,
                    estimatedRevenue: targetAnalysis.analytics.estimatedRevenue,
                    swipedAwayRate: targetAnalysis.analytics.swipedAwayRate,
                    viewedRate: targetAnalysis.analytics.viewedRate
                });
                return;
            }

            // --- All video analyses (bulk: returns all analyzed videos with full data) ---
            if (v1path === '/videos/all/analyses') {
                const videos = await dataStore.getAll('videos');
                const results = [];
                for (const v of videos) {
                    if (!v.youtubeVideoId) continue;
                    const analysis = await videoAnalyzer.getAnalysis(v.youtubeVideoId);
                    if (analysis) {
                        results.push({ record: v, analysis });
                    }
                }
                json(results);
                return;
            }

            // --- Inventory: boxes ---
            if (v1path === '/inventory/boxes') {
                const boxRes = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent('Box')}?pageSize=100`, {
                    headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
                });
                const boxData = await boxRes.json();
                json(boxData.records || []);
                return;
            }

            // --- Inventory: items ---
            if (v1path === '/inventory/items') {
                let allItems = [];
                let offset = null;
                do {
                    const qs = offset ? `?pageSize=100&offset=${offset}` : '?pageSize=100';
                    const itemRes = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent('Items')}${qs}`, {
                        headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
                    });
                    const data = await itemRes.json();
                    allItems = allItems.concat(data.records || []);
                    offset = data.offset || null;
                } while (offset);
                json(allItems);
                return;
            }

            // --- Inventory: history ---
            if (v1path === '/inventory/history') {
                const histRes = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent('History')}?pageSize=100&sort%5B0%5D%5Bfield%5D=Time&sort%5B0%5D%5Bdirection%5D=desc`, {
                    headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
                });
                const histData = await histRes.json();
                json(histData.records || []);
                return;
            }

            // --- Dropbox file listing ---
            if (v1path === '/dropbox/files') {
                const folderPath = url.searchParams.get('path') || '';
                const token = await cloud.getDropboxToken();
                const dbxRes = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: folderPath || '', recursive: false, limit: 2000 })
                });
                const dbxData = await dbxRes.json();
                json(dbxData);
                return;
            }

            // --- Search across all collections ---
            if (v1path === '/search') {
                const q = (url.searchParams.get('q') || '').toLowerCase().trim();
                if (!q) { json({ error: 'Missing ?q= parameter' }, 400); return; }

                const results = {};
                for (const col of dataStore.COLLECTIONS) {
                    const records = await dataStore.getAll(col);
                    const matches = records.filter(r => {
                        const text = JSON.stringify(r).toLowerCase();
                        return text.includes(q);
                    });
                    if (matches.length > 0) results[col] = matches;
                }
                json(results);
                return;
            }

            // --- Not found ---
            json({ error: 'Unknown endpoint', available: [
                '/api/v1/overview',
                '/api/v1/videos', '/api/v1/videos/:id',
                '/api/v1/videos/:ytId/analysis', '/api/v1/videos/:ytId/analytics',
                '/api/v1/videos/:ytId/analytics/history', '/api/v1/videos/:ytId/transcript',
                '/api/v1/videos/:ytId/frames', '/api/v1/videos/:ytId/frames/:filename',
                '/api/v1/videos/:ytId/metadata', '/api/v1/videos/:ytId/performance',
                '/api/v1/videos/all/analyses',
                '/api/v1/ideas', '/api/v1/ideas/:id',
                '/api/v1/todos', '/api/v1/todos/:id',
                '/api/v1/calendar', '/api/v1/calendar/:id',
                '/api/v1/invoices', '/api/v1/invoices/:id',
                '/api/v1/inventory/boxes', '/api/v1/inventory/items', '/api/v1/inventory/history',
                '/api/v1/dropbox/files?path=',
                '/api/v1/search?q='
            ] }, 404);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // Load layout
    // =========================================
    if (req.method === 'GET' && pathname === '/load-layout') {
        if (fs.existsSync(LAYOUT_FILE)) {
            const data = fs.readFileSync(LAYOUT_FILE, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        } else {
            res.writeHead(404);
            res.end('{}');
        }
        return;
    }

    // =========================================
    // Static file serving
    // =========================================
    let filePath = path.join(DIR, pathname === '/' ? 'index.html' : pathname);
    // Block .env files from being served
    if (path.basename(filePath).startsWith('.env')) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        // Prevent browser caching of HTML/JS so code changes take effect immediately
        const headers = { 'Content-Type': contentType };
        if (ext === '.html' || ext === '.js') {
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        }
        res.writeHead(200, headers);
        res.end(data);
    });
});

// Build or load metrics summary (single R2 file instead of 50+ individual reads)
async function _loadOrBuildMetrics() {
    // 1. Try memory cache (5-min TTL)
    if (global._metricsCache && Date.now() - global._metricsCacheTime < 300000) return;
    // 2. Try single pre-built R2 file (instant — one download)
    if (cloud.isR2Ready()) {
        try {
            const buf = await cloud.downloadFromR2('cache/metrics-summary.json');
            if (buf) {
                global._metricsCache = buf.toString('utf8');
                global._metricsCacheTime = Date.now();
                console.log('Metrics: loaded from R2 cache');
                return;
            }
        } catch (e) {}
    }
    // 3. Rebuild from individual analysis files (slow path — only on first ever build)
    await _rebuildMetrics();
}

async function _rebuildMetrics() {
    console.log('Metrics: rebuilding from analysis files...');
    const t0 = Date.now();
    const videos = await dataStore.getAll('videos');
    const posted = videos.filter(v => v.status === 'posted' && v.youtubeVideoId);
    const summary = {};
    await Promise.all(posted.map(async (v) => {
        try {
            const analysis = await videoAnalyzer.getAnalysis(v.youtubeVideoId);
            if (!analysis) return;
            const meta = analysis.metadata || {};
            const an = analysis.analytics || {};
            summary[v.id] = {
                views: an.totalViews ?? meta.viewCount ?? 0,
                likes: an.likes ?? meta.likeCount ?? 0,
                comments: meta.commentCount ?? 0,
                revenue: an.estimatedRevenue ?? 0,
                shares: an.shares ?? 0,
                subsGained: an.subscribersGained ?? 0,
                avgRetention: an.avgRetention ?? 0,
                avgPercentViewed: an.avgPercentViewed ?? 0,
                engagementRate: (an.engagedViews && an.totalViews > 0) ? (an.engagedViews / an.totalViews) : 0
            };
        } catch (e) {}
    }));
    global._metricsCache = JSON.stringify(summary);
    global._metricsCacheTime = Date.now();
    console.log(`Metrics: rebuilt in ${Date.now() - t0}ms (${Object.keys(summary).length} videos)`);
    // Persist to R2 for fast loads on next cold start
    if (cloud.isR2Ready()) {
        cloud.uploadToR2('cache/metrics-summary.json', Buffer.from(global._metricsCache), 'application/json').catch(() => {});
    }
}

// Initialize R2 cloud storage before accepting requests
cloud.initR2();

server.listen(PORT, () => {
    console.log(`Business World running at http://localhost:${PORT}`);
    videoAnalyzer.resumeJobs(process.env.OPENAI_API_KEY, process.env.OPENAI_CHAT_MODEL || 'gpt-4o');
    // Pre-warm metrics cache in background (ready before user opens Pen)
    _loadOrBuildMetrics().catch(e => console.warn('Metrics pre-warm failed:', e.message));
});
