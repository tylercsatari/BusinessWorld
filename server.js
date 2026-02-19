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

const PORT = process.env.PORT || 8002;
const DIR = __dirname;
const LAYOUT_FILE = path.join(DIR, 'layout.json');

// Strip hyphens from Notion UUIDs so we can compare IDs regardless of format
function normalizeId(id) { return id ? id.replace(/-/g, '') : ''; }

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
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
            notion: {
                videosPageId: process.env.NOTION_VIDEOS_PAGE_ID || '',
                videosDataPageId: process.env.NOTION_VIDEOS_DATA_PAGE_ID || '',
                ideasPageId: process.env.NOTION_IDEAS_PAGE_ID || '',
                todoPageId: process.env.NOTION_TODO_PAGE_ID || '',
                calendarPageId: process.env.NOTION_CALENDAR_PAGE_ID || ''
            },
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
    // API: Notion proxy — full CRUD for pages and blocks
    // =========================================
    const NOTION_HEADERS = {
        'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
    };

    // POST /api/notion/pages — create a page
    if (pathname === '/api/notion/pages' && req.method === 'POST') {
        const body = await readBody(req);
        await proxyFetch(res, 'https://api.notion.com/v1/pages', {
            method: 'POST', headers: NOTION_HEADERS, body: JSON.stringify(body)
        });
        return;
    }

    // PATCH /api/notion/pages/:id — update page (title, archive)
    const notionPagePatch = pathname.match(/^\/api\/notion\/pages\/([^/]+)$/);
    if (notionPagePatch && req.method === 'PATCH') {
        const pageId = notionPagePatch[1];
        const body = await readBody(req);
        // Protect critical system pages from being archived/deleted
        const protectedIds = [
            process.env.NOTION_VIDEOS_DATA_PAGE_ID,
            process.env.NOTION_VIDEOS_PAGE_ID,
            process.env.NOTION_IDEAS_PAGE_ID,
            process.env.NOTION_TODO_PAGE_ID,
            process.env.NOTION_CALENDAR_PAGE_ID,
        ].filter(Boolean).map(normalizeId);
        if (body.archived && protectedIds.includes(normalizeId(pageId))) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot delete protected system page' }));
            return;
        }
        await proxyFetch(res, `https://api.notion.com/v1/pages/${pageId}`, {
            method: 'PATCH', headers: NOTION_HEADERS, body: JSON.stringify(body)
        });
        return;
    }

    // GET /api/notion/blocks/:id/children — list block children
    const notionBlockChildren = pathname.match(/^\/api\/notion\/blocks\/([^/]+)\/children$/);
    if (notionBlockChildren && req.method === 'GET') {
        const qs = url.search || '';
        await proxyFetch(res, `https://api.notion.com/v1/blocks/${notionBlockChildren[1]}/children${qs}`, {
            method: 'GET', headers: NOTION_HEADERS
        });
        return;
    }

    // PATCH /api/notion/blocks/:id/children — append block children
    if (notionBlockChildren && req.method === 'PATCH') {
        const body = await readBody(req);
        await proxyFetch(res, `https://api.notion.com/v1/blocks/${notionBlockChildren[1]}/children`, {
            method: 'PATCH', headers: NOTION_HEADERS, body: JSON.stringify(body)
        });
        return;
    }

    // PATCH /api/notion/blocks/:id — update a block
    const notionBlockPatch = pathname.match(/^\/api\/notion\/blocks\/([^/]+)$/);
    if (notionBlockPatch && req.method === 'PATCH') {
        const body = await readBody(req);
        await proxyFetch(res, `https://api.notion.com/v1/blocks/${notionBlockPatch[1]}`, {
            method: 'PATCH', headers: NOTION_HEADERS, body: JSON.stringify(body)
        });
        return;
    }

    // POST /api/notion/ensure-calendar-page — auto-create calendar page if needed
    if (pathname === '/api/notion/ensure-calendar-page' && req.method === 'POST') {
        // If already configured, return it
        if (process.env.NOTION_CALENDAR_PAGE_ID) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ calendarPageId: process.env.NOTION_CALENDAR_PAGE_ID }));
            return;
        }
        // Need a parent page to create under
        const parentId = process.env.NOTION_VIDEOS_PAGE_ID;
        if (!parentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No parent page configured' }));
            return;
        }
        try {
            // Search existing children for a "Calendar" page
            const listRes = await fetch(`https://api.notion.com/v1/blocks/${parentId}/children`, {
                method: 'GET', headers: NOTION_HEADERS
            });
            if (listRes.ok) {
                const listData = await listRes.json();
                const existing = (listData.results || []).find(b => b.type === 'child_page' && b.child_page.title === 'Calendar');
                if (existing) {
                    process.env.NOTION_CALENDAR_PAGE_ID = existing.id;
                    // Save to .env if local dev
                    if (!process.env.RENDER) {
                        try {
                            let envContent = fs.readFileSync(envPath, 'utf8');
                            envContent = envContent.replace(/^NOTION_CALENDAR_PAGE_ID=.*$/m, `NOTION_CALENDAR_PAGE_ID=${existing.id}`);
                            fs.writeFileSync(envPath, envContent, 'utf8');
                        } catch (e) {}
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ calendarPageId: existing.id }));
                    return;
                }
            }
            // Create new Calendar page
            const createRes = await fetch('https://api.notion.com/v1/pages', {
                method: 'POST', headers: NOTION_HEADERS,
                body: JSON.stringify({
                    parent: { page_id: parentId },
                    properties: { title: { title: [{ text: { content: 'Calendar' } }] } }
                })
            });
            if (!createRes.ok) throw new Error('Failed to create Calendar page');
            const newPage = await createRes.json();
            process.env.NOTION_CALENDAR_PAGE_ID = newPage.id;
            // Save to .env if local dev
            if (!process.env.RENDER) {
                try {
                    let envContent = fs.readFileSync(envPath, 'utf8');
                    envContent = envContent.replace(/^NOTION_CALENDAR_PAGE_ID=.*$/m, `NOTION_CALENDAR_PAGE_ID=${newPage.id}`);
                    fs.writeFileSync(envPath, envContent, 'utf8');
                } catch (e) {}
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ calendarPageId: newPage.id }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // DELETE /api/notion/blocks/:id — delete a block
    if (notionBlockPatch && req.method === 'DELETE') {
        const blockId = notionBlockPatch[1];
        // Protect critical system pages (child pages are also blocks in Notion)
        const protectedIds = [
            process.env.NOTION_VIDEOS_DATA_PAGE_ID,
            process.env.NOTION_VIDEOS_PAGE_ID,
            process.env.NOTION_IDEAS_PAGE_ID,
            process.env.NOTION_TODO_PAGE_ID,
            process.env.NOTION_CALENDAR_PAGE_ID,
        ].filter(Boolean).map(normalizeId);
        if (protectedIds.includes(normalizeId(blockId))) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot delete protected system page' }));
            return;
        }
        await proxyFetch(res, `https://api.notion.com/v1/blocks/${blockId}`, {
            method: 'DELETE', headers: NOTION_HEADERS
        });
        return;
    }

    // =========================================
    // API: Dropbox proxy — file browser (with auto token refresh)
    // =========================================
    async function getDropboxToken() {
        // If we have a refresh token, check if current access token works and refresh if needed
        if (process.env.DROPBOX_REFRESH_TOKEN && process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET) {
            // Try refreshing proactively if no token or token looks expired
            if (!process.env.DROPBOX_ACCESS_TOKEN || process.env._DROPBOX_TOKEN_EXPIRED) {
                try {
                    const params = new URLSearchParams({
                        grant_type: 'refresh_token',
                        refresh_token: process.env.DROPBOX_REFRESH_TOKEN
                    });
                    const authHeader = 'Basic ' + Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString('base64');
                    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
                        method: 'POST',
                        headers: { 'Authorization': authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: params.toString()
                    });
                    if (tokenRes.ok) {
                        const tokenData = await tokenRes.json();
                        process.env.DROPBOX_ACCESS_TOKEN = tokenData.access_token;
                        delete process.env._DROPBOX_TOKEN_EXPIRED;
                        console.log('Dropbox: token refreshed');
                    }
                } catch (e) { console.warn('Dropbox: refresh failed', e); }
            }
        }
        return process.env.DROPBOX_ACCESS_TOKEN;
    }

    async function dropboxFetch(res, url, opts) {
        const token = await getDropboxToken();
        opts.headers = { ...opts.headers, 'Authorization': `Bearer ${token}` };
        const response = await fetch(url, opts);
        // If 401, try refresh once
        if (response.status === 401 && process.env.DROPBOX_REFRESH_TOKEN) {
            process.env._DROPBOX_TOKEN_EXPIRED = '1';
            const newToken = await getDropboxToken();
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
            const token = await getDropboxToken();
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

server.listen(PORT, () => {
    console.log(`Business World running at http://localhost:${PORT}`);
});
