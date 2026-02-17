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
    // API: Non-secret config for frontend
    // =========================================
    if (pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            airtable: {
                boxesTable: 'Box', itemsTable: 'Items', itemsLinkField: 'Link To Box',
                boxesNameField: 'Name', itemsNameField: 'Name', itemsQuantityField: 'Quantity'
            },
            search: { semanticMatchThreshold: parseFloat(process.env.SEMANTIC_MATCH_THRESHOLD) || 0.75 }
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
    // Existing: Save layout
    // =========================================
    if (req.method === 'POST' && pathname === '/save-layout') {
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
    // Existing: Load layout
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
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Business World running at http://localhost:${PORT}`);
});
