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
const shortsCrawler = require('./shorts-crawler');
const financeService = require('./buildings/finance/finance-service');
const PDFDocument = require('pdfkit');
const PORT = process.env.PORT || 8002;
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
const DIR = __dirname;
const LAYOUT_FILE = path.join(DIR, 'layout.json');
const BUILD_TS = Date.now();


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
            search: { semanticMatchThreshold: parseFloat(process.env.SEMANTIC_MATCH_THRESHOLD) || 0.85 },
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
    // API: Jarvis Auto-Classify Observation
    // =========================================
    if (pathname === '/api/jarvis/classify' && req.method === 'POST') {
        const body = await readBody(req);
        const { observation, registry } = body;
        const openaiKey = process.env.OPENAI_API_KEY;
        if (!openaiKey) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No OpenAI key configured' }));
            return;
        }
        if (!observation || !registry) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing observation or registry' }));
            return;
        }

        const levelList = registry.map(r => `${r.id} (level ${r.level}): ${r.name} — ${r.description}`).join('\n');

        const prompt = `You are classifying an observation about a YouTube video analysis into a resolution level system.

Resolution levels (ordered coarsest to finest):
${levelList}

Observation: "${observation}"

Classify this:
1. Which existing level best matches this observation's granularity?
2. Is it between two existing levels? If yes, which two?
3. What measurable signals/dimensions does it reference?
4. One sentence reasoning.

Respond ONLY as valid JSON:
{"matchedLevel": "r0", "isBetween": false, "betweenLower": null, "betweenUpper": null, "signals": ["signal1"], "reasoning": "one sentence"}`;

        try {
            const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0
                })
            });
            const aiData = await aiResp.json();
            const content = aiData.choices?.[0]?.message?.content || '';
            // Extract JSON from response (strip markdown fences if present)
            const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            const parsed = JSON.parse(jsonStr);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(parsed));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Classification failed: ' + e.message }));
        }
        return;
    }

    // =========================================
    // API: OpenAI Whisper transcription
    // =========================================
    if (pathname === '/api/openai/transcribe' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.audio) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing audio field' }));
            return;
        }
        const audioBuffer = Buffer.from(body.audio, 'base64');
        const mimeType = body.mimeType || 'audio/webm';
        const ext = mimeType.includes('mp4') ? 'mp4'
                  : mimeType.includes('ogg') ? 'ogg'
                  : mimeType.includes('wav') ? 'wav'
                  : 'webm';

        // Build multipart/form-data manually (no extra dependencies)
        const boundary = '----Whisper' + Date.now() + Math.random().toString(36).slice(2);
        const filePart = Buffer.concat([
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
                `Content-Type: ${mimeType}\r\n\r\n`
            ),
            audioBuffer,
            Buffer.from('\r\n')
        ]);
        const modelPart = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="model"\r\n\r\n` +
            `whisper-1\r\n`
        );
        const closing = Buffer.from(`--${boundary}--\r\n`);
        const multipartBody = Buffer.concat([filePart, modelPart, closing]);

        try {
            const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`
                },
                body: multipartBody
            });
            const text = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(text);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Ideas — semantic search index + query
    // =========================================
    if (pathname === '/api/ideas/index-embeddings' && req.method === 'POST') {
        try {
            const ideas = await dataStore.getAll('ideas');
            if (!ideas || ideas.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ indexed: 0 }));
                return;
            }

            // Build texts for embedding
            const texts = ideas.map(idea =>
                `${idea.name}. ${idea.hook || ''} ${idea.context || ''} ${idea.tags || ''}`.trim()
            );

            // Batch embed 50 at a time
            const batchSize = 50;
            const allVectors = [];
            for (let i = 0; i < texts.length; i += batchSize) {
                const batchTexts = texts.slice(i, i + batchSize);
                const batchIdeas = ideas.slice(i, i + batchSize);

                const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: JSON.stringify({ input: batchTexts, model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small', dimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS) || 512 })
                });
                if (!embeddingRes.ok) {
                    const errText = await embeddingRes.text();
                    throw new Error(`OpenAI embeddings error: ${embeddingRes.status} ${errText}`);
                }
                const embeddingData = await embeddingRes.json();

                for (let j = 0; j < batchIdeas.length; j++) {
                    const idea = batchIdeas[j];
                    allVectors.push({
                        id: idea.id,
                        values: embeddingData.data[j].embedding,
                        metadata: {
                            name: idea.name,
                            status: idea.status || idea.type,
                            tags: idea.tags || ''
                        }
                    });
                }
            }

            // Upsert to Pinecone in batches of 100
            for (let i = 0; i < allVectors.length; i += 100) {
                const batch = allVectors.slice(i, i + 100);
                const upsertRes = await fetch(`${process.env.PINECONE_HOST}/vectors/upsert`, {
                    method: 'POST',
                    headers: { 'Api-Key': process.env.PINECONE_API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ vectors: batch, namespace: 'ideas' })
                });
                if (!upsertRes.ok) {
                    const errText = await upsertRes.text();
                    throw new Error(`Pinecone upsert error: ${upsertRes.status} ${errText}`);
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ indexed: allVectors.length }));
        } catch (e) {
            console.error('index-embeddings error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/ideas/search' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { query, topK = 10, statusFilter } = body;
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'query is required' }));
                return;
            }

            // Embed query
            const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                body: JSON.stringify({ input: [query], model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small', dimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS) || 512 })
            });
            if (!embeddingRes.ok) {
                const errText = await embeddingRes.text();
                throw new Error(`OpenAI embeddings error: ${embeddingRes.status} ${errText}`);
            }
            const embeddingData = await embeddingRes.json();
            const queryEmbedding = embeddingData.data[0].embedding;

            // Query Pinecone
            const pcBody = {
                vector: queryEmbedding,
                topK: topK,
                namespace: 'ideas',
                includeMetadata: true
            };
            if (statusFilter && statusFilter !== 'all') {
                pcBody.filter = { status: { '$eq': statusFilter } };
            }
            const pcRes = await fetch(`${process.env.PINECONE_HOST}/query`, {
                method: 'POST',
                headers: { 'Api-Key': process.env.PINECONE_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify(pcBody)
            });
            if (!pcRes.ok) {
                const errText = await pcRes.text();
                throw new Error(`Pinecone query error: ${pcRes.status} ${errText}`);
            }
            const pcData = await pcRes.json();

            const results = (pcData.matches || []).map(m => ({
                id: m.id,
                name: m.metadata?.name || '',
                score: m.score,
                status: m.metadata?.status || '',
                tags: m.metadata?.tags || ''
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results }));
        } catch (e) {
            console.error('ideas/search error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
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
    // API: Fill logistics — schedule cron jobs for ideas with context but no logistics
    // =========================================
    if (pathname === '/api/admin/fill-logistics' && req.method === 'POST') {
        try {
            const { exec } = require('child_process');
            const allIdeas = await dataStore.getAll('ideas');
            const needLogistics = allIdeas.filter(i => (i.context || '').trim().length > 0 && !i.logistics && i.type !== 'todo');

            if (needLogistics.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ scheduled: 0, ideas: [], finishesAt: null }));
                return;
            }

            const now = Date.now();
            const results = [];
            for (let idx = 0; idx < needLogistics.length; idx++) {
                const idea = needLogistics[idx];
                const scheduledAt = new Date(now + (2 * 60 * 1000) + (idx * 15 * 60 * 1000)).toISOString();
                const safeName = (idea.name || 'Untitled').replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 40);

                // Logistics research prompt — emphasizes SPECIFIC product URLs (see Feature 4 notes)
                const prompt = `You are a logistics researcher for a YouTube video idea. Research the logistics needed for this idea and update the idea's logistics field.

Idea name: ${idea.name}
Idea context: ${idea.context}

Research the materials, services, and equipment needed. For each item find specific products with prices in CAD, sourcing info for Calgary AB Canada, and direct product links.

CRITICAL: Find SPECIFIC products with DIRECT product page URLs. Do NOT link to search results, category pages, or generic listings. Each link must go directly to a specific product listing. Example of BAD link: https://www.amazon.ca/s?k=solenoid+valve. Example of GOOD link: https://www.amazon.ca/dp/B08XYZ1234. If you cannot find a specific product URL, leave the links array empty rather than adding a search URL.

For AliExpress: find the specific item URL (e.g. https://www.aliexpress.com/item/1234567890.html), not a search or store page.

Provide multiple approach angles if applicable (e.g. DIY vs professional, budget vs premium). Include safety considerations.

Update the idea by calling PATCH /api/data/ideas/${idea.id} with a JSON body containing a "logistics" field with this structure:
{
  "summary": "Brief overview",
  "estimated_cost_range": "$X - $Y CAD",
  "last_researched": "${new Date().toISOString().split('T')[0]}",
  "angles": [
    {
      "name": "Approach name",
      "description": "Brief description",
      "complexity": "easy|medium|hard|extreme",
      "timeline": "Estimated time",
      "materials": [{"name": "Item", "quantity": 1, "unit_price_cad": 0, "estimated_cost_cad": 0, "where_to_buy": "Store", "links": ["https://direct-product-url"], "notes": ""}],
      "services": [],
      "equipment": []
    }
  ],
  "safety": ["Safety consideration 1"],
  "sourcing_notes": "General sourcing notes for Calgary"
}`;

                const cronArgs = [
                    'cron', 'add',
                    '--name', `Logistics #${idx + 1}: ${safeName}`,
                    '--at', scheduledAt,
                    '--session', 'isolated',
                    '--message', prompt,
                    '--timeout-seconds', '840',
                    '--announce',
                    '--channel', 'telegram'
                ];

                await new Promise((resolve, reject) => {
                    exec('openclaw ' + cronArgs.map(a => {
                        // Shell-escape each argument
                        if (typeof a === 'string' && (a.includes(' ') || a.includes('"') || a.includes("'") || a.includes('\n') || a.includes('$') || a.includes('`') || a.includes('\\'))) {
                            return "'" + a.replace(/'/g, "'\\''") + "'";
                        }
                        return a;
                    }).join(' '), { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
                        if (err) { console.warn(`Failed to schedule logistics for ${idea.name}:`, err.message); reject(err); }
                        else resolve(stdout);
                    });
                });

                results.push({ id: idea.id, name: idea.name, scheduledAt });
            }

            const finishesAt = results.length > 0 ? results[results.length - 1].scheduledAt : null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ scheduled: results.length, ideas: results, finishesAt }));
        } catch (e) {
            console.error('Fill logistics error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: AI Chat — chat with Optimusk Prime via OpenClaw cron
    // =========================================
    const AI_CHAT_R2_KEY = 'data/ai-chat.json';

    if (pathname === '/api/ai/chat' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { message } = body;
            if (!message || !message.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'message required' }));
                return;
            }

            const crypto = require('crypto');
            const messageId = crypto.randomUUID();
            const timestamp = new Date().toISOString();

            // Load existing chat history from R2
            let history = [];
            try {
                const buf = await cloud.downloadFromR2(AI_CHAT_R2_KEY);
                if (buf) history = JSON.parse(buf.toString('utf8'));
            } catch (e) { console.warn('Failed to load chat history:', e.message); }

            history.push({ id: messageId, role: 'user', content: message.trim(), timestamp });
            await cloud.uploadToR2(AI_CHAT_R2_KEY, Buffer.from(JSON.stringify(history)), 'application/json');

            // Schedule openclaw cron job to process message via isolated agent
            const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
            const cronMessage = `[BusinessWorld Chat] User message: ${message.trim()}\n\nAfter responding, POST to ${appUrl}/api/ai/reply with: {"text": "your reply", "secret": "bw-ai-secret-2026"}\n\nAlso respond normally on Telegram to Tyler (chat_id 7906038704) so he gets a Telegram notification too.`;
            const { exec } = require('child_process');
            const cronCmd = `openclaw cron add --name "BW Chat" --at "+5s" --session isolated --message ${JSON.stringify(cronMessage)} --timeout-seconds 120 --announce --channel telegram`;

            try {
                await new Promise((resolve, reject) => {
                    exec(cronCmd, { timeout: 10000 }, (err, stdout, stderr) => {
                        if (err) reject(err);
                        else { console.log('OpenClaw cron scheduled:', stdout.trim()); resolve(stdout); }
                    });
                });
            } catch (cronErr) {
                console.warn('OpenClaw cron failed, falling back to Telegram:', cronErr.message);
                // Fallback: send via Telegram bot directly
                const botToken = process.env.TELEGRAM_BOT_TOKEN;
                const chatId = process.env.TELEGRAM_TYLER_CHAT_ID;
                const telegramText = `[Message from BusinessWorld app] ${message.trim()}\n\nNote: After responding on Telegram normally, also POST to ${appUrl}/api/ai/reply with body: {"text": "<your full reply>", "secret": "bw-ai-secret-2026"}`;
                try {
                    const tgResp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: chatId, text: telegramText })
                    });
                    const tgData = await tgResp.json();
                    if (!tgData.ok) console.warn('Telegram sendMessage error:', tgData.description);
                    else console.log('Telegram fallback message sent, message_id:', tgData.result.message_id);
                } catch (tgErr) {
                    console.warn('Telegram fallback also failed:', tgErr.message);
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, messageId, timestamp }));
        } catch (e) {
            console.error('AI chat error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/ai/chat' && req.method === 'GET') {
        try {
            const since = url.searchParams.get('since');
            let history = [];
            try {
                const buf = await cloud.downloadFromR2(AI_CHAT_R2_KEY);
                if (buf) history = JSON.parse(buf.toString('utf8'));
            } catch (e) { console.warn('Failed to load chat history:', e.message); }

            const messages = since
                ? history.filter(m => m.timestamp > since)
                : history.slice(-50);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ messages }));
        } catch (e) {
            console.error('AI chat history error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/ai/reply' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            // Support both formats:
            // New Telegram callback: { text, secret }
            // Legacy openclaw: { reply, messageId }
            const replyText = body.text || body.reply;
            const secret = body.secret;
            const messageId = body.messageId;

            // If secret is provided, validate it
            if (secret && secret !== 'bw-ai-secret-2026') {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid secret' }));
                return;
            }

            if (!replyText) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'text or reply required' }));
                return;
            }

            const crypto = require('crypto');
            const timestamp = new Date().toISOString();

            let history = [];
            try {
                const buf = await cloud.downloadFromR2(AI_CHAT_R2_KEY);
                if (buf) history = JSON.parse(buf.toString('utf8'));
            } catch (e) { console.warn('Failed to load chat history:', e.message); }

            // Find the last unanswered user message to link this reply to
            const repliedIds = new Set(history.filter(m => m.role === 'assistant' && m.replyTo).map(m => m.replyTo));
            const replyToId = messageId || (history.filter(m => m.role === 'user' && !repliedIds.has(m.id)).pop() || {}).id || null;

            history.push({ id: crypto.randomUUID(), role: 'assistant', content: replyText, replyTo: replyToId, timestamp });
            await cloud.uploadToR2(AI_CHAT_R2_KEY, Buffer.from(JSON.stringify(history)), 'application/json');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            console.error('AI reply error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Invoice generation — creates HTML invoice, stores in R2
    // =========================================
    if (pathname === '/api/invoices/generate' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { sponsorVideoId, businessInfo } = body;
            if (!sponsorVideoId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'sponsorVideoId required' })); return; }

            const video = await dataStore.getById('sponsorvideos', sponsorVideoId);
            if (!video) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Video deal not found' })); return; }

            const company = video.companyId ? await dataStore.getById('sponsors', video.companyId) : null;
            const allInvoices = await dataStore.getAll('invoices');
            const maxNum = allInvoices.reduce((m, i) => Math.max(m, i.invoiceNumber || 0), 4);
            const invoiceNumber = maxNum + 1;
            const invoiceDate = new Date().toISOString().split('T')[0];
            const due = new Date(); due.setDate(due.getDate() + 30);
            const dueDate = due.toISOString().split('T')[0];
            const companyAddr = (company?.address || '').replace(/\n/g, '<br>');
            const lineItems = [{ description: video.title || 'Sponsored Video', amount: video.amount || 0 }];
            const subtotal = lineItems.reduce((s, li) => s + (li.amount || 0), 0);
            const total = subtotal;
            const currency = video.currency || 'CAD';

            const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>INV-${String(invoiceNumber).padStart(4,'0')} ${esc(company?.name || 'Invoice')} ${invoiceDate}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333;padding:40px;max-width:800px;margin:0 auto}
.inv-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:3px solid #2d3436}
.inv-title{font-size:32px;font-weight:800;color:#2d3436;letter-spacing:-0.5px}.inv-number{font-size:14px;color:#888;margin-top:4px}
.inv-parties{display:flex;justify-content:space-between;gap:40px;margin-bottom:32px}.inv-party{flex:1}
.inv-party-label{font-size:11px;font-weight:700;color:#636e72;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.inv-party-name{font-size:16px;font-weight:700;margin-bottom:4px}.inv-party-detail{font-size:13px;color:#666;line-height:1.6}
.inv-dates{display:flex;gap:32px;margin-bottom:28px}.inv-date-box{background:#f8f9fa;padding:10px 16px;border-radius:8px}
.inv-date-label{font-size:11px;font-weight:700;color:#888;text-transform:uppercase}.inv-date-value{font-size:15px;font-weight:600;margin-top:2px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}th{text-align:left;font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;padding:10px 12px;border-bottom:2px solid #e0e0e0}
td{padding:12px;border-bottom:1px solid #f0f0f0;font-size:14px}.td-amount{text-align:right;font-weight:600}
.inv-totals{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-bottom:32px}
.inv-total-row{display:flex;gap:40px;font-size:14px}.inv-total-label{color:#888;min-width:100px;text-align:right}
.inv-total-value{font-weight:600;min-width:100px;text-align:right}
.inv-grand-total{font-size:20px;font-weight:800;color:#2d3436;border-top:2px solid #2d3436;padding-top:8px;margin-top:4px}
.inv-bank{margin-top:32px;padding:16px;background:#f8f9fa;border-radius:8px;font-size:13px;line-height:1.6}
.inv-bank-title{font-size:12px;font-weight:700;color:#636e72;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.inv-bank-row{display:flex;gap:8px}.inv-bank-label{color:#888;min-width:130px}.inv-bank-value{font-weight:600}
@media print{body{padding:15mm;margin:0}@page{margin:0;size:auto}html{-webkit-print-color-adjust:exact}}
</style></head><body>
<div class="inv-header"><div><div class="inv-title">INVOICE</div><div class="inv-number">INV-${String(invoiceNumber).padStart(4,'0')}</div></div></div>
<div class="inv-parties">
<div class="inv-party"><div class="inv-party-label">From</div><div class="inv-party-name">Centrality LTD</div><div class="inv-party-detail">14 Discovery Ridge Road SW<br>Calgary AB Canada, T3H 4P8</div></div>
<div class="inv-party"><div class="inv-party-label">Bill To</div><div class="inv-party-name">${esc(company?.name || 'Company')}</div><div class="inv-party-detail">${companyAddr || ''}</div></div>
</div>
<div class="inv-dates"><div class="inv-date-box"><div class="inv-date-label">Invoice Date</div><div class="inv-date-value">${invoiceDate}</div></div><div class="inv-date-box"><div class="inv-date-label">Due Date</div><div class="inv-date-value">${dueDate}</div></div></div>
<table><thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead><tbody>${lineItems.map(li => `<tr><td>${esc(li.description)}</td><td class="td-amount">${currency} $${li.amount.toFixed(2)}</td></tr>`).join('')}</tbody></table>
<div class="inv-totals">
<div class="inv-total-row"><span class="inv-total-label">Subtotal</span><span class="inv-total-value">${currency} $${subtotal.toFixed(2)}</span></div>
<div class="inv-total-row inv-grand-total"><span class="inv-total-label">Total</span><span class="inv-total-value">${currency} $${total.toFixed(2)}</span></div>
</div>
<div class="inv-bank"><div class="inv-bank-title">Payment Details</div><div class="inv-bank-row"><span class="inv-bank-label">Institution Number:</span><span class="inv-bank-value">001</span></div><div class="inv-bank-row"><span class="inv-bank-label">Transit Number:</span><span class="inv-bank-value">30489</span></div><div class="inv-bank-row"><span class="inv-bank-label">Account Number:</span><span class="inv-bank-value">1987-607</span></div></div>
</body></html>`;

            const r2Key = `invoices/INV-${String(invoiceNumber).padStart(4, '0')}.html`;
            if (cloud.isR2Ready()) {
                await cloud.uploadToR2(r2Key, Buffer.from(html), 'text/html');
            }

            const record = await dataStore.create('invoices', {
                invoiceNumber, invoiceDate, dueDate, sponsorVideoId,
                companyId: video.companyId || null,
                companyName: company?.name || '',
                lineItems, subtotal, total, currency, r2Key
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ invoice: record, html }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/invoices/:id/download — serve invoice HTML from R2 (inline preview or PDF-friendly)
    const invoiceDownloadMatch = pathname.match(/^\/api\/invoices\/([^/]+)\/download$/);
    if (invoiceDownloadMatch && req.method === 'GET') {
        try {
            const invoice = await dataStore.getById('invoices', invoiceDownloadMatch[1]);
            if (!invoice || !invoice.r2Key) { res.writeHead(404); res.end('Not found'); return; }
            const buf = await cloud.downloadFromR2(invoice.r2Key);
            if (!buf) { res.writeHead(404); res.end('Invoice file not found'); return; }
            const invName = `INV-${String(invoice.invoiceNumber).padStart(4, '0')} ${(invoice.companyName || 'Invoice').replace(/[^a-zA-Z0-9 _-]/g, '')} ${invoice.invoiceDate || ''}`.trim();
            res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Disposition': `inline; filename="${invName}.html"` });
            res.end(buf);
        } catch (e) {
            res.writeHead(500); res.end('Error: ' + e.message);
        }
        return;
    }

    // GET /api/invoices/:id/pdf — generate and download actual PDF
    const invoicePdfMatch = pathname.match(/^\/api\/invoices\/([^/]+)\/pdf$/);
    if (invoicePdfMatch && req.method === 'GET') {
        try {
            const invoice = await dataStore.getById('invoices', invoicePdfMatch[1]);
            if (!invoice) { res.writeHead(404); res.end('Not found'); return; }
            const company = invoice.companyId ? await dataStore.getById('sponsors', invoice.companyId) : null;
            const invNum = `INV-${String(invoice.invoiceNumber).padStart(4, '0')}`;
            const fileName = `${invNum} ${(invoice.companyName || 'Invoice').replace(/[^a-zA-Z0-9 _-]/g, '')} ${invoice.invoiceDate || ''}`.trim() + '.pdf';

            const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => {
                const pdf = Buffer.concat(chunks);
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': `attachment; filename="${fileName}"`,
                    'Content-Length': pdf.length
                });
                res.end(pdf);
            });

            const grey = '#636e72';
            const dark = '#2d3436';
            const pageRight = 562;
            const col1 = 50, col2 = 310;

            // Header
            doc.fontSize(28).font('Helvetica-Bold').fillColor(dark).text('INVOICE', col1, 50, { width: 250 });
            doc.fontSize(12).font('Helvetica').fillColor('#888').text(invNum, col1, 82, { width: 250 });
            doc.moveTo(col1, 105).lineTo(pageRight, 105).lineWidth(2).strokeColor(dark).stroke();

            // From / Bill To
            const topY = 125;
            const colW = 240;
            doc.fontSize(9).font('Helvetica-Bold').fillColor(grey).text('FROM', col1, topY, { width: colW });
            doc.fontSize(14).font('Helvetica-Bold').fillColor(dark).text('Centrality LTD', col1, topY + 16, { width: colW });
            doc.fontSize(10).font('Helvetica').fillColor('#666');
            doc.text('14 Discovery Ridge Road SW', col1, topY + 34, { width: colW });
            doc.text('Calgary AB Canada, T3H 4P8', col1, topY + 48, { width: colW });

            doc.fontSize(9).font('Helvetica-Bold').fillColor(grey).text('BILL TO', col2, topY, { width: colW });
            doc.fontSize(14).font('Helvetica-Bold').fillColor(dark).text(invoice.companyName || 'Company', col2, topY + 16, { width: colW });
            if (company?.address) {
                const addrLines = company.address.split('\n');
                let ay = topY + 34;
                doc.fontSize(10).font('Helvetica').fillColor('#666');
                addrLines.forEach(line => { doc.text(line.trim(), col2, ay, { width: colW }); ay += 14; });
            }

            // Dates
            const dateY = 210;
            doc.roundedRect(col1, dateY, 130, 42, 4).fill('#f8f9fa');
            doc.fontSize(8).font('Helvetica-Bold').fillColor('#888').text('INVOICE DATE', col1 + 10, dateY + 8, { width: 110 });
            doc.fontSize(12).font('Helvetica-Bold').fillColor(dark).text(invoice.invoiceDate || '', col1 + 10, dateY + 22, { width: 110 });

            doc.roundedRect(col1 + 145, dateY, 130, 42, 4).fill('#f8f9fa');
            doc.fontSize(8).font('Helvetica-Bold').fillColor('#888').text('DUE DATE', col1 + 155, dateY + 8, { width: 110 });
            doc.fontSize(12).font('Helvetica-Bold').fillColor(dark).text(invoice.dueDate || '', col1 + 155, dateY + 22, { width: 110 });

            // Table header
            const tableY = 280;
            doc.moveTo(col1, tableY + 20).lineTo(pageRight, tableY + 20).lineWidth(1).strokeColor('#e0e0e0').stroke();
            doc.fontSize(9).font('Helvetica-Bold').fillColor('#888');
            doc.text('DESCRIPTION', col1, tableY + 4, { width: 300 });
            doc.text('AMOUNT', 400, tableY + 4, { width: pageRight - 400, align: 'right' });

            // Line items
            let rowY = tableY + 30;
            const items = invoice.lineItems || [{ description: invoice.companyName || 'Sponsored Video', amount: invoice.total || 0 }];
            const currency = invoice.currency || 'CAD';
            doc.font('Helvetica').fontSize(11).fillColor(dark);
            items.forEach(li => {
                doc.text(li.description || '', col1, rowY, { width: 340 });
                doc.text(`${currency} $${(li.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 400, rowY, { width: pageRight - 400, align: 'right' });
                doc.moveTo(col1, rowY + 18).lineTo(pageRight, rowY + 18).lineWidth(0.5).strokeColor('#f0f0f0').stroke();
                rowY += 25;
            });

            // Totals
            const subtotalStr = `${currency} $${(invoice.subtotal || invoice.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const totalStr = `${currency} $${(invoice.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

            rowY += 10;
            doc.fontSize(11).font('Helvetica').fillColor('#888').text('Subtotal', 350, rowY, { width: 80, align: 'right' });
            doc.font('Helvetica-Bold').fillColor(dark).text(subtotalStr, 440, rowY, { width: pageRight - 440, align: 'right' });

            rowY += 28;
            doc.moveTo(350, rowY - 4).lineTo(pageRight, rowY - 4).lineWidth(1.5).strokeColor(dark).stroke();
            doc.fontSize(16).font('Helvetica-Bold').fillColor(dark).text('Total', 350, rowY, { width: 80, align: 'right' });
            doc.text(totalStr, 440, rowY, { width: pageRight - 440, align: 'right' });

            // Payment details
            rowY += 40;
            doc.roundedRect(col1, rowY, pageRight - col1, 72, 4).fill('#f8f9fa');
            doc.fontSize(9).font('Helvetica-Bold').fillColor(grey).text('PAYMENT DETAILS', col1 + 12, rowY + 10, { width: 200 });
            doc.fontSize(10).font('Helvetica').fillColor('#888');
            doc.text('Institution Number:', col1 + 12, rowY + 28, { width: 130 });
            doc.text('Transit Number:', col1 + 12, rowY + 42, { width: 130 });
            doc.text('Account Number:', col1 + 12, rowY + 56, { width: 130 });
            doc.font('Helvetica-Bold').fillColor(dark);
            doc.text('001', col1 + 145, rowY + 28, { width: 100 });
            doc.text('30489', col1 + 145, rowY + 42, { width: 100 });
            doc.text('1987-607', col1 + 145, rowY + 56, { width: 100 });

            doc.end();
        } catch (e) {
            res.writeHead(500); res.end('Error: ' + e.message);
        }
        return;
    }

    // DELETE /api/invoices/:id — delete invoice record and R2 file
    const invoiceDeleteMatch = pathname.match(/^\/api\/invoices\/([^/]+)$/);
    if (invoiceDeleteMatch && req.method === 'DELETE') {
        try {
            const invoice = await dataStore.getById('invoices', invoiceDeleteMatch[1]);
            if (!invoice) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
            // Remove R2 file if exists
            if (invoice.r2Key && cloud.isR2Ready()) {
                try { await cloud.deleteFromR2(invoice.r2Key); } catch (e) { /* ok if missing */ }
            }
            await dataStore.remove('invoices', invoiceDeleteMatch[1]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
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

    // GET /api/shorts-db/stats — shorts crawler database statistics
    if (pathname === '/api/shorts-db/stats' && req.method === 'GET') {
        const stats = await shortsCrawler.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
    }

    // GET /api/shorts-db/videos — paginated list from local shorts DB
    if (pathname === '/api/shorts-db/videos' && req.method === 'GET') {
        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const minViews = parseInt(url.searchParams.get('minViews')) || 100000000;
        const sort = url.searchParams.get('sort') || 'views';
        const result = await shortsCrawler.getVideos({ page, limit, minViews, sort });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }

    // GET /api/shorts-db/frame/:videoId/:filename — serve frame from local or R2
    const shortsFrameMatch = pathname.match(/^\/api\/shorts-db\/frame\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (shortsFrameMatch && req.method === 'GET') {
        const framePath = shortsCrawler.getFramePath(shortsFrameMatch[1], shortsFrameMatch[2]);
        if (framePath) {
            const data = fs.readFileSync(framePath);
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
            res.end(data);
            return;
        }
        const r2Url = await shortsCrawler.getFrameR2Url(shortsFrameMatch[1], shortsFrameMatch[2]);
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
    // ?verify=true will actually test the token (slower but accurate)
    if (pathname === '/api/youtube/status' && req.method === 'GET') {
        const hasCredentials = !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
        const hasRefreshToken = !!process.env.YOUTUBE_REFRESH_TOKEN;
        const hasApiKey = !!process.env.YOUTUBE_API_KEY;

        // Quick check (default): just check if env vars exist
        if (url.searchParams.get('verify') !== 'true') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasCredentials, isConnected: hasRefreshToken, hasApiKey }));
            return;
        }

        // Deep check: actually try to use the credentials
        let tokenWorks = false;
        if (hasApiKey) {
            try {
                const testRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`);
                tokenWorks = testRes.ok;
            } catch (e) {}
        }
        if (!tokenWorks && hasRefreshToken) {
            try {
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
                    process.env._YOUTUBE_ACCESS_TOKEN = tokenData.access_token;
                    tokenWorks = true;
                }
            } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hasCredentials, isConnected: hasRefreshToken, hasApiKey, tokenWorks }));
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

    // OAuth redirect URI — always use localhost (already registered in Google Cloud Console).
    // On Render, the auth URL redirects to localhost which won't load, but the auth code
    // is in the URL. The user copies it and pastes it back via /api/youtube/exchange-code.
    // Always use port 8002 — that's what's registered in Google Cloud Console.
    // On Render, PORT is a random value like 10000, which would cause redirect_uri_mismatch.
    const OAUTH_REDIRECT = 'http://localhost:8002/api/youtube/callback';

    // GET /api/youtube/auth-url — build OAuth2 authorize URL
    if (pathname === '/api/youtube/auth-url' && req.method === 'GET') {
        const clientId = process.env.YOUTUBE_CLIENT_ID;
        if (!clientId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'YOUTUBE_CLIENT_ID not configured' })); return; }
        const scope = 'https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/yt-analytics-monetary.readonly https://www.googleapis.com/auth/youtube.readonly';
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;
        const isRemote = !!(process.env.RENDER || (req.headers.host && !req.headers.host.startsWith('localhost')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: authUrl, redirect: OAUTH_REDIRECT, isRemote }));
        return;
    }

    // GET /api/youtube/callback — exchange code for tokens (works when running locally)
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
                    redirect_uri: OAUTH_REDIRECT,
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

    // POST /api/youtube/exchange-code — manual code exchange (for Render / remote deploys)
    // User approves on Google, gets redirected to localhost (which fails), copies the code
    // from the URL bar, and pastes it here.
    if (pathname === '/api/youtube/exchange-code' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const code = (body.code || '').trim();
            if (!code) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing code' })); return; }
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code,
                    client_id: process.env.YOUTUBE_CLIENT_ID,
                    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
                    redirect_uri: OAUTH_REDIRECT,
                    grant_type: 'authorization_code'
                }).toString()
            });
            const tokenData = await tokenRes.json();
            if (tokenData.error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: tokenData.error_description || tokenData.error }));
                return;
            }
            if (tokenData.refresh_token) process.env.YOUTUBE_REFRESH_TOKEN = tokenData.refresh_token;
            if (tokenData.access_token) process.env._YOUTUBE_ACCESS_TOKEN = tokenData.access_token;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, hasRefresh: !!tokenData.refresh_token }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
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
    // API: Research — find viral YouTube videos
    // =========================================

    // Helper: get YouTube auth for Data API calls (public data).
    // Prefers API key (no expiry), falls back to OAuth access token.
    async function getYouTubeDataAuth() {
        // Option 1: API key — simplest, never expires, works for all public data
        if (process.env.YOUTUBE_API_KEY) {
            return { type: 'key', key: process.env.YOUTUBE_API_KEY };
        }
        // Option 2: OAuth access token
        let accessToken = process.env._YOUTUBE_ACCESS_TOKEN;
        if (!accessToken && process.env.YOUTUBE_REFRESH_TOKEN) {
            try {
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
                } else {
                    console.warn('Research: YouTube token refresh failed:', tokenData.error_description || JSON.stringify(tokenData));
                }
            } catch (e) {
                console.warn('Research: YouTube token refresh error:', e.message);
            }
        }
        if (accessToken) return { type: 'bearer', token: accessToken };
        return null;
    }

    // Build YouTube API URL with auth (key param or bearer header)
    function ytDataUrl(base, params, auth) {
        const p = new URLSearchParams(params);
        if (auth.type === 'key') p.set('key', auth.key);
        return `${base}?${p}`;
    }
    function ytDataHeaders(auth) {
        if (auth.type === 'bearer') return { 'Authorization': `Bearer ${auth.token}` };
        return {};
    }

    // InnerTube search API — returns videos with TOTAL/lifetime view counts.
    // No OAuth needed, uses YouTube's public InnerTube key.
    const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const INNERTUBE_CLIENT = { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' };

    // Build sp parameter from protobuf fields
    // sort: 3=viewcount | uploadDate: 1=hour,2=today,3=week,4=month,5=year
    // type: 1=video, 6=shorts | duration: 1=under4min, 2=over20min
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

    function parseInnerTubeSearch(data) {
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

    // Extract continuation token from InnerTube response
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
        // First page
        const res = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: { client: INNERTUBE_CLIENT }, query, params: sp })
        });
        const firstData = await res.json();
        const videos = parseInnerTubeSearch(firstData);

        // Paginate up to 5 more pages via continuation tokens
        let contToken = extractContinuationToken(firstData);
        for (let page = 0; page < 5 && contToken; page++) {
            try {
                const contRes = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ context: { client: INNERTUBE_CLIENT }, continuation: contToken })
                });
                const contData = await contRes.json();
                const pageVideos = parseInnerTubeSearch(contData);
                if (pageVideos.length === 0) break;
                videos.push(...pageVideos);
                contToken = extractContinuationToken(contData);
            } catch { break; }
        }
        return videos;
    }

    // Duration string to seconds
    function durToSec(dur) {
        if (!dur) return -1;
        const p = dur.split(':').map(Number);
        return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+(p[1]||0);
    }

    // GET /api/research/popular — multi-source popular video discovery
    // Sources: (1) InnerTube search queries, (2) InnerTube browse FEcharts/FEshorts,
    //          (3) YouTube OAuth mostPopular chart (if YOUTUBE_REFRESH_TOKEN set)
    // Returns ALL results (no minViews filter) — frontend filters client-side.
    if (pathname === '/api/research/popular' && req.method === 'GET') {
        try {
            const timeRange = url.searchParams.get('timeRange') || 'week';
            const type = url.searchParams.get('type') || 'all';

            const TIME_CODE = { week: 3, month: 4, year: 5, all: null };
            const uploadDate = TIME_CODE[timeRange] ?? null;

            const BROWSE_REGIONS = ['US','IN','BR','MX','ID','GB','PH','DE','KR','TR'];

            // Every query returns ~20 unique videos sorted by view count.
            // More queries = more coverage. We cast a VERY wide net.
            const VIRAL_QUERIES = [
                // Generic
                'most viewed', 'viral', 'trending', 'popular', 'most watched',
                'most viewed video', 'billion views', 'most popular video',
                'most viewed video of all time', 'top videos', 'viral video',
                // Music — by genre
                'music video', 'official music video', 'song', 'official video',
                'pop music', 'hip hop', 'rap', 'kpop', 'latin music', 'reggaeton',
                'bollywood songs', 'punjabi song', 'arabic music', 'afrobeats',
                'rock music video', 'country music', 'edm', 'r&b', 'trap',
                'spanish song', 'french song', 'turkish music', 'thai song',
                'indonesian song', 'filipino song', 'vietnamese music',
                'german music', 'italian song', 'russian music', 'portuguese music',
                // Music — by artist/era
                'taylor swift', 'ed sheeran', 'eminem', 'drake', 'bad bunny',
                'bts', 'blackpink', 'justin bieber', 'ariana grande', 'dua lipa',
                'bruno mars', 'shakira', 'rihanna', 'adele', 'katy perry',
                'maroon 5', 'coldplay', 'imagine dragons', 'the weeknd',
                'billie eilish', 'post malone', 'cardi b', 'nicki minaj',
                'ozuna', 'j balvin', 'daddy yankee', 'maluma', 'anuel aa',
                'alan walker', 'marshmello', 'sia', 'sam smith', 'doja cat',
                'olivia rodrigo', 'sabrina carpenter', 'lil nas x',
                '2024 music', '2025 music', '2023 music', '2022 music',
                // Entertainment
                'funny video', 'comedy', 'prank', 'challenge', 'reaction',
                'animation', 'cartoon', 'anime', 'movie trailer', 'tv show clip',
                'mrbeast', 'pewdiepie', 'markiplier', 'dude perfect', 'sssniperwolf',
                'like nastya', 'vlad and niki', 'ryan toysreview', 'diana roma',
                // Kids & Education
                'kids songs', 'nursery rhymes', 'baby shark', 'cocomelon',
                'children songs', 'kids video', 'learning video', 'phonics',
                'pinkfong', 'super simple songs', 'chuchu tv', 'little baby bum',
                'dave and ava', 'mother goose club', 'baby ronnie', 'billion surprise toys',
                // Sports & Gaming
                'highlights', 'football', 'soccer', 'cricket', 'basketball', 'nba',
                'gaming', 'minecraft', 'fortnite', 'gta', 'free fire', 'roblox',
                'world cup', 'champions league', 'nfl', 'wwe',
                // Other high-view categories
                'dance video', 'workout', 'cooking', 'asmr', 'compilation',
                'satisfying', 'unboxing', 'review', 'tutorial', 'vlog',
                'wedding dance', 'flash mob', 'talent show', 'audition',
                'car review', 'tech review', 'travel vlog', 'mukbang',
                'relaxing music', 'lofi', 'study music', 'sleep music',
                'nature documentary', 'science experiment', 'magic trick',
                'tiktok compilation', 'try not to laugh', 'fail compilation',
                // Iconic high-view videos
                'despacito', 'shape of you', 'gangnam style', 'see you again', 'uptown funk',
                'johny johny yes papa', 'wheels on the bus', 'bath song', 'finger family',
                'most viewed video youtube', 'youtube most popular',
                'alan walker faded', 'attention charlie puth',
            ];
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

            // --- Source 1: InnerTube search queries ---
            let searches = [];
            if (type === 'shorts') {
                const sp = buildSP(3, uploadDate, 6, null); // sort=viewcount, type=shorts
                searches = SHORTS_QUERIES.map(q => innerTubeSearch(q, sp));
            } else if (type === 'long') {
                const sp = buildSP(3, uploadDate, 1, null); // sort=viewcount, type=video
                searches = VIRAL_QUERIES.map(q => innerTubeSearch(q, sp));
            } else {
                // All: run ALL video queries + all shorts queries
                const spVid = buildSP(3, uploadDate, 1, null);
                const spShort = buildSP(3, uploadDate, 6, null);
                searches = [
                    ...VIRAL_QUERIES.map(q => innerTubeSearch(q, spVid)),
                    ...SHORTS_QUERIES.map(q => innerTubeSearch(q, spShort)),
                ];
            }

            // --- Source 2: InnerTube browse (FEcharts + FEshorts) for 10 regions ---
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
                    videos.push(...parseInnerTubeSearch(browseData));

                    // Follow up to 2 continuation pages
                    let contToken = extractContinuationToken(browseData);
                    for (let page = 0; page < 2 && contToken; page++) {
                        const contRes = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}&prettyPrint=false`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ context: { client }, continuation: contToken })
                        });
                        const contData = await contRes.json();
                        const pageVideos = parseInnerTubeSearch(contData);
                        if (pageVideos.length === 0) break;
                        videos.push(...pageVideos);
                        contToken = extractContinuationToken(contData);
                    }
                } catch { /* ignore browse failures */ }
                return videos;
            }

            const browseIds = (type === 'shorts') ? ['FEshorts']
                            : (type === 'long') ? ['FEcharts']
                            : ['FEcharts', 'FEshorts'];
            const browseFetches = [];
            for (const bid of browseIds) {
                for (const region of BROWSE_REGIONS) {
                    browseFetches.push(innerTubeBrowse(bid, region));
                }
            }

            // --- Source 3: YouTube OAuth chart=mostPopular (if refresh token set) ---
            const oauthFetches = [];
            if (process.env.YOUTUBE_REFRESH_TOKEN && process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) {
                // Exchange refresh token for access token
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
                            const r = await fetch(apiUrl, {
                                headers: { Authorization: `Bearer ${accessToken}` }
                            });
                            const d = await r.json();
                            return (d.items || []).map(item => {
                                const dur = item.contentDetails?.duration || '';
                                const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                                const secs = match ? (parseInt(match[1]||0)*3600 + parseInt(match[2]||0)*60 + parseInt(match[3]||0)) : 0;
                                const mm = String(Math.floor(secs/60));
                                const ss = String(secs%60).padStart(2,'0');
                                const durStr = secs >= 3600 ? `${Math.floor(secs/3600)}:${String(Math.floor((secs%3600)/60)).padStart(2,'0')}:${ss}` : `${mm}:${ss}`;
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
                Promise.all(searches.map(p => p.catch(() => []))),
                Promise.all(browseFetches),
                Promise.all(oauthFetches),
            ]);

            // Merge and deduplicate all sources
            const seen = new Set();
            let allVideos = [];
            for (const batch of [...searchResults, ...browseResults, ...oauthResults]) {
                for (const v of batch) {
                    if (v.videoId && !seen.has(v.videoId)) {
                        seen.add(v.videoId);
                        allVideos.push(v);
                    }
                }
            }

            // Strict type filtering
            if (type === 'shorts') {
                // A Short is: ≤60s (classic Short), OR ≤180s with "shorts" in title
                // This excludes regular videos (CoComelon, music videos) that happen to be 2-3 min
                allVideos = allVideos.filter(v => {
                    const s = durToSec(v.duration);
                    if (s <= 0) return false;
                    if (s <= 60) return true;
                    if (s <= 180) {
                        const t = (v.title || '').toLowerCase();
                        return t.includes('#shorts') || t.includes('#short') || t.includes('shorts');
                    }
                    return false;
                });
            } else if (type === 'long') {
                // Long-form: exclude anything that looks like a Short
                allVideos = allVideos.filter(v => {
                    const s = durToSec(v.duration);
                    if (s > 0 && s <= 60) return false;
                    if (s > 0 && s <= 180) {
                        const t = (v.title || '').toLowerCase();
                        if (t.includes('#shorts') || t.includes('#short')) return false;
                    }
                    return true;
                });
            }

            allVideos.sort((a, b) => b.views - a.views);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ videos: allVideos }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/research/viral — search YouTube for viral videos
    if (pathname === '/api/research/viral' && req.method === 'GET') {
        try {
            const minViews = parseInt(url.searchParams.get('minViews')) || 1000000;
            const timeRange = url.searchParams.get('timeRange') || 'week';
            const query = url.searchParams.get('query') || '';
            const pageToken = url.searchParams.get('pageToken') || '';

            // Try YouTube Data API first
            const auth = await getYouTubeDataAuth();
            if (auth) {
                const now = new Date();
                const ranges = { '24h': 1, '3days': 3, 'week': 7, 'month': 30, '3months': 90, 'year': 365 };
                const days = ranges[timeRange] || 7;
                const publishedAfter = new Date(now - days * 86400000).toISOString();
                const headers = ytDataHeaders(auth);
                const searchParams = {
                    part: 'snippet', type: 'video', order: 'viewCount',
                    publishedAfter, maxResults: '50',
                    ...(query ? { q: query } : {}),
                    ...(pageToken ? { pageToken } : {})
                };
                const searchRes = await fetch(ytDataUrl('https://www.googleapis.com/youtube/v3/search', searchParams, auth), { headers });
                const searchData = await searchRes.json();
                if (!searchData.error) {
                    const videoIds = (searchData.items || []).map(i => i.id.videoId).filter(Boolean);
                    if (videoIds.length > 0) {
                        const statsRes = await fetch(ytDataUrl('https://www.googleapis.com/youtube/v3/videos', {
                            part: 'statistics,contentDetails,snippet', id: videoIds.join(',')
                        }, auth), { headers });
                        const statsData = await statsRes.json();
                        const videos = (statsData.items || [])
                            .map(v => ({
                                videoId: v.id, title: v.snippet.title,
                                channelTitle: v.snippet.channelTitle, channelId: v.snippet.channelId,
                                publishedAt: v.snippet.publishedAt,
                                thumbnail: v.snippet.thumbnails?.maxres?.url || v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.medium?.url,
                                views: parseInt(v.statistics.viewCount) || 0,
                                likes: parseInt(v.statistics.likeCount) || 0,
                                comments: parseInt(v.statistics.commentCount) || 0,
                                duration: v.contentDetails.duration
                            }))
                            .filter(v => v.views >= minViews)
                            .sort((a, b) => b.views - a.views);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ videos, nextPageToken: searchData.nextPageToken || null }));
                        return;
                    }
                }
                if (searchData.error?.code === 401) process.env._YOUTUBE_ACCESS_TOKEN = '';
            }

            // YouTube page scrape fallback — no API key needed, just HTTP
            const searchQuery = query || 'most viewed this week';
            const items = await ytScrapeSearch(searchQuery);
            const videos = items.filter(v => v.views >= minViews).sort((a, b) => b.views - a.views);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ videos, nextPageToken: null }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/research/trending — get currently trending videos
    if (pathname === '/api/research/trending' && req.method === 'GET') {
        try {
            // Try YouTube Data API first
            const auth = await getYouTubeDataAuth();
            if (auth) {
                const region = url.searchParams.get('region') || 'US';
                const headers = ytDataHeaders(auth);
                const params = {
                    part: 'snippet,statistics,contentDetails',
                    chart: 'mostPopular', regionCode: region, maxResults: '50'
                };
                const trendRes = await fetch(ytDataUrl('https://www.googleapis.com/youtube/v3/videos', params, auth), { headers });
                const trendData = await trendRes.json();
                if (!trendData.error) {
                    const videos = (trendData.items || []).map(v => ({
                        videoId: v.id, title: v.snippet.title,
                        channelTitle: v.snippet.channelTitle, channelId: v.snippet.channelId,
                        publishedAt: v.snippet.publishedAt,
                        thumbnail: v.snippet.thumbnails?.maxres?.url || v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.medium?.url,
                        views: parseInt(v.statistics.viewCount) || 0,
                        likes: parseInt(v.statistics.likeCount) || 0,
                        comments: parseInt(v.statistics.commentCount) || 0,
                        duration: v.contentDetails.duration
                    }));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ videos }));
                    return;
                }
                if (trendData.error?.code === 401) process.env._YOUTUBE_ACCESS_TOKEN = '';
            }

            // YouTube page scrape fallback
            const videos = await ytScrapeTrending();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ videos }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/research/grab-frames — download first N frames of an external video
    if (pathname === '/api/research/grab-frames' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const videoId = body.videoId;
            const seconds = Math.min(body.seconds || 10, 30); // max 30 seconds
            if (!videoId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'videoId required' })); return; }

            const dir = path.join(__dirname, 'video_data', `research_${videoId}`);
            const framesDir = path.join(dir, 'frames');
            fs.mkdirSync(framesDir, { recursive: true });

            // Check if frames already exist
            const existing = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
            if (existing.length > 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ frames: existing.sort(), videoId, cached: true }));
                return;
            }

            // Download just the first N seconds
            const videoPath = path.join(dir, 'video.mp4');
            const { execFile } = require('child_process');
            const YTDLP_BASE = ['--js-runtimes', 'node', '--remote-components', 'ejs:github'];
            await new Promise((resolve, reject) => {
                execFile('yt-dlp', [
                    ...YTDLP_BASE,
                    '-f', 'best[height<=720]/best',
                    '--download-sections', `*0-${seconds}`,
                    '-o', videoPath,
                    `https://www.youtube.com/watch?v=${videoId}`
                ], { timeout: 120000 }, (err) => err ? reject(err) : resolve());
            });

            // Extract frames at 1fps
            await new Promise((resolve, reject) => {
                execFile('ffmpeg', [
                    '-i', videoPath,
                    '-vf', 'fps=1',
                    '-q:v', '2',
                    path.join(framesDir, 'frame_%04d.jpg')
                ], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
            });

            // Clean up video file to save space
            try { fs.unlinkSync(videoPath); } catch (e) {}

            const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ frames, videoId, cached: false }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/research/frame/:videoId/:filename — serve research frame
    const researchFrameMatch = pathname.match(/^\/api\/research\/frame\/([a-zA-Z0-9_-]+)\/(.+)$/);
    if (researchFrameMatch && req.method === 'GET') {
        const [, vid, file] = researchFrameMatch;
        const framePath = path.join(__dirname, 'video_data', `research_${vid}`, 'frames', file);
        if (fs.existsSync(framePath)) {
            const data = fs.readFileSync(framePath);
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
            res.end(data);
        } else {
            res.writeHead(404); res.end('Frame not found');
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
    // Admin: List & Restore Backups
    // =========================================
    const backupListMatch = pathname.match(/^\/api\/admin\/backups\/([a-z]+)$/);
    if (backupListMatch && req.method === 'GET') {
        const collection = backupListMatch[1];
        if (!dataStore.COLLECTIONS.includes(collection)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown collection: ${collection}` }));
            return;
        }
        try {
            const backups = await dataStore.listBackups(collection);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ collection, backups }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    const restoreMatch = pathname.match(/^\/api\/admin\/restore\/([a-z]+)$/);
    if (restoreMatch && req.method === 'POST') {
        const collection = restoreMatch[1];
        if (!dataStore.COLLECTIONS.includes(collection)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown collection: ${collection}` }));
            return;
        }
        try {
            const body = await readBody(req);
            const restored = await dataStore.restoreBackup(collection, body.timestamp || null);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, collection, recordCount: restored.records?.length ?? 0 }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // Save layout
    // =========================================
    if (req.method === 'POST' && pathname === '/save-layout') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const incoming = JSON.parse(body);
                if (!cloud.isR2Ready()) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'R2 not available' }));
                    return;
                }

                // Load existing layout from R2 for merge
                let existing = {};
                try {
                    const r2Data = await cloud.downloadFromR2('layout/layout.json');
                    if (r2Data) existing = JSON.parse(r2Data.toString());
                } catch (_) { /* no existing layout, start fresh */ }

                const BUILDING_NAMES = ['Workshop','Storage','Incubator','Money Pit','The Pen','Employee Island','Science Center','Jarvis','Library','Finance','The House','Movie Theatre','Gym','Chocolate Bar'];
                const MISSING_DEFAULTS = {
                    'Chocolate Bar': { x: 42, z: 12 },
                    'Gym': { x: 15, z: 30 },
                };

                // Merge buildings: keep R2 position when incoming is 0,0
                const existingBuildings = existing.buildings || {};
                const incomingBuildings = incoming.buildings || {};
                const merged = {};

                for (const name of BUILDING_NAMES) {
                    const inc = incomingBuildings[name];
                    const ext = existingBuildings[name];

                    if (inc && !(inc.x === 0 && inc.z === 0)) {
                        // Incoming has a real (non-origin) position — use it
                        merged[name] = inc;
                    } else if (ext) {
                        // Incoming is missing or at 0,0 — keep existing R2 value
                        merged[name] = ext;
                    } else if (MISSING_DEFAULTS[name]) {
                        // Missing from both — use hardcoded default
                        merged[name] = { ...MISSING_DEFAULTS[name] };
                    }
                    // else: not in either source and no default — omit
                }

                // Build final layout: non-building fields from incoming, merged buildings
                const finalLayout = { ...incoming, buildings: merged };

                await cloud.uploadToR2('layout/layout.json', Buffer.from(JSON.stringify(finalLayout)), 'application/json');
                console.log('Layout saved to R2 (merged)');
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
                const [videos, ideas, todos, calendar, invoices, notes, sponsors, sponsorvideos] = await Promise.all(
                    ['videos', 'ideas', 'todos', 'calendar', 'invoices', 'notes', 'sponsors', 'sponsorvideos'].map(c => dataStore.getAll(c))
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
                    sponsors: { total: sponsors.length },
                    sponsorvideos: { total: sponsorvideos.length },
                    inventory: { boxes: boxCount, items: itemCount }
                });
                return;
            }

            // --- Data store collections: videos, ideas, scripts, todos, calendar, invoices ---
            const collectionMatch = v1path.match(/^\/(videos|ideas|todos|calendar|invoices|notes|sponsors|sponsorvideos)(?:\/([^/]+))?$/);
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
        if (!cloud.isR2Ready()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'R2 not available' }));
            return;
        }
        try {
            const buf = await cloud.downloadFromR2('layout/layout.json');
            if (buf) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(buf.toString('utf8'));
                return;
            }
        } catch (e) {
            console.warn('R2 layout load failed:', e.message);
        }
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'R2 not available' }));
        return;
    }

    // =========================================
    // Public share pages (read-only, no auth)
    // =========================================

    // --- Share single idea ---
    const shareIdeaMatch = pathname.match(/^\/share\/idea\/([^/]+)$/);
    if (shareIdeaMatch && req.method === 'GET') {
        try {
            const idea = await dataStore.getById('ideas', shareIdeaMatch[1]);
            if (!idea) {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderSharePage('Not Found', '<div style="text-align:center;padding:60px 20px;"><h1 style="font-size:28px;color:#333;">Idea not found</h1><p style="color:#888;margin-top:12px;">This idea may have been removed or the link is invalid.</p></div>'));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderShareIdeaPage(idea));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderSharePage('Error', '<div style="text-align:center;padding:60px 20px;"><h1 style="color:#e74c3c;">Something went wrong</h1></div>'));
        }
        return;
    }

    // --- Share ideas list ---
    if (pathname === '/share/ideas' && req.method === 'GET') {
        try {
            const statusParam = url.searchParams.get('status') || 'all';
            const catParam = url.searchParams.get('cat') || 'all';
            let ideas = await dataStore.getAll('ideas');
            const videos = await dataStore.getAll('videos');

            // Resolve pipeline status per idea (same logic as app)
            const getIdeaStatus = (idea) => {
                const video = videos.find(v => v.sourceIdeaId === idea.id);
                if (video) return video.status || 'incubator';
                if (idea.type === 'converted') return 'incubator';
                return idea.type || 'idea';
            };

            // Filter by status
            if (statusParam !== 'all') {
                ideas = ideas.filter(i => {
                    const s = getIdeaStatus(i);
                    if (statusParam === 'posted') return s === 'posted' || s === 'converted';
                    return s === statusParam;
                });
            }

            // Filter by category (categories stored client-side in localStorage, so we skip server-side cat filtering — show all if cat specified)

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderShareIdeasPage(ideas, statusParam, catParam, getIdeaStatus));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderSharePage('Error', '<div style="text-align:center;padding:60px 20px;"><h1 style="color:#e74c3c;">Something went wrong</h1></div>'));
        }
        return;
    }

    // =========================================
    // API: Finance / Plaid
    // =========================================
    if (pathname === '/api/finance/status' && req.method === 'GET') {
        const configured = financeService.isConfigured();
        let connected = false;
        let connectedAt = null;
        if (configured && cloud.isR2Ready()) {
            const data = await financeService.loadPlaidData(cloud);
            if (data) { connected = true; connectedAt = data.connectedAt || null; }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured, connected, connectedAt }));
        return;
    }

    if (pathname === '/api/finance/link-token' && req.method === 'POST') {
        if (!financeService.isConfigured()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Plaid not configured' }));
            return;
        }
        try {
            const linkToken = await financeService.createLinkToken('tyler');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ link_token: linkToken }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/finance/exchange-token' && req.method === 'POST') {
        if (!financeService.isConfigured()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Plaid not configured' }));
            return;
        }
        try {
            const body = await readBody(req);
            const result = await financeService.exchangePublicToken(body.public_token);
            result.connectedAt = new Date().toISOString();
            await financeService.savePlaidData(cloud, result);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/finance/transactions' && req.method === 'GET') {
        if (!financeService.isConfigured()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Plaid not configured' }));
            return;
        }
        try {
            const conn = await financeService.loadPlaidData(cloud);
            if (!conn) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No bank connection found' }));
                return;
            }
            const start = url.searchParams.get('start') || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
            const end = url.searchParams.get('end') || new Date().toISOString().slice(0, 10);
            const transactions = await financeService.getTransactions(conn.accessToken, start, end);
            const accounts = await financeService.getAccounts(conn.accessToken);
            const meta = await financeService.loadTransactionMeta(cloud) || {};
            // Merge meta onto transactions
            const merged = transactions.map(t => {
                const m = meta[t.transaction_id] || {};
                return { ...t, _project: m.project || null, _category: m.category || null, _accountedFor: !!m.accountedFor, _notes: m.notes || '' };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ transactions: merged, accounts, connectedAt: conn.connectedAt }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/finance/accounts' && req.method === 'GET') {
        if (!financeService.isConfigured()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Plaid not configured' }));
            return;
        }
        try {
            const conn = await financeService.loadPlaidData(cloud);
            if (!conn) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No bank connection found' }));
                return;
            }
            const accounts = await financeService.getAccounts(conn.accessToken);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accounts }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/finance/transaction-meta' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { transactionId, project, category, accountedFor, notes } = body;
            const meta = await financeService.loadTransactionMeta(cloud) || {};
            meta[transactionId] = { project: project || null, category: category || null, accountedFor: !!accountedFor, notes: notes || '' };
            await financeService.saveTransactionMeta(cloud, meta);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/finance/connection' && req.method === 'DELETE') {
        try {
            if (cloud.isR2Ready()) {
                await cloud.deleteFromR2('finance/plaid-connection.json');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // Jarvis: Auto-classify observation into resolution tree
    // =========================================
    if (pathname === '/api/jarvis/classify' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { observation, registry } = JSON.parse(body);
            const openaiKey = process.env.OPENAI_API_KEY;
            if (!openaiKey) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No OpenAI key configured' }));
                return;
            }
            const levelList = (registry || []).map(r => `${r.id} (level ${r.level}): ${r.name} — ${r.description}`).join('\n');
            const prompt = `You are classifying an observation about a YouTube video analysis into a resolution level system.

Resolution levels (ordered coarsest to finest):
${levelList}

Observation: "${observation}"

Classify this observation:
1. Which existing level best matches its granularity?
2. Is it between two existing levels? If yes, which two?
3. What measurable signals/dimensions does it reference? (as array of short names)
4. One sentence reasoning.

Respond ONLY as valid JSON (no markdown):
{"matchedLevel": "r0", "isBetween": false, "betweenLower": null, "betweenUpper": null, "signals": ["signal1"], "reasoning": "one sentence"}`;

            const https = require('https');
            const postData = JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 300
            });
            const result = await new Promise((resolve, reject) => {
                const req2 = https.request({
                    hostname: 'api.openai.com',
                    path: '/v1/chat/completions',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${openaiKey}`,
                        'Content-Length': Buffer.byteLength(postData)
                    }
                }, (r) => {
                    let data = '';
                    r.on('data', d => data += d);
                    r.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            let content = parsed.choices[0].message.content.trim();
                            if (content.includes('```')) content = content.split('```')[1].replace(/^json/, '').split('```')[0].trim();
                            resolve(JSON.parse(content));
                        } catch (e) { reject(e); }
                    });
                });
                req2.on('error', reject);
                req2.write(postData);
                req2.end();
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
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
        // Prevent browser caching of HTML/JS/CSS so code changes take effect immediately
        const headers = { 'Content-Type': contentType };
        if (ext === '.html' || ext === '.js' || ext === '.css') {
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        }
        // Inject cache-busting version stamps into HTML files
        if (ext === '.html') {
            let html = data.toString('utf8');
            html = html.replace(/\.js(\?v=\d+)?"/g, `.js?v=${BUILD_TS}"`);
            html = html.replace(/\.css(\?v=\d+)?"/g, `.css?v=${BUILD_TS}"`);
            res.writeHead(200, headers);
            res.end(html);
            return;
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
                engagementRate: (an.engagedViews && an.totalViews > 0) ? (an.engagedViews / an.totalViews) : 0,
                swipeRatio: an.swipeRatio?.stayedToWatch ?? 0
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

// =========================================
// Share page rendering helpers
// =========================================

const SHARE_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f6f2; color: #333; line-height: 1.5; }
    .share-container { max-width: 720px; margin: 0 auto; padding: 20px 16px 80px; }
    .share-header { text-align: center; padding: 24px 0 16px; }
    .share-header h1 { font-size: 24px; font-weight: 700; color: #333; margin-bottom: 4px; }
    .share-hook { font-size: 15px; color: #5a3e1b; font-style: italic; margin: 8px 0 16px; padding: 10px 14px; background: #fff; border-left: 3px solid #d4a060; border-radius: 6px; }
    .share-section { margin-bottom: 20px; }
    .share-section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #8B5E3C; margin-bottom: 8px; }
    .share-context { font-size: 14px; color: #444; white-space: pre-wrap; word-wrap: break-word; background: #fff; border: 1px solid #e8e4df; border-radius: 10px; padding: 14px; }
    .share-script { font-size: 14px; color: #444; white-space: pre-wrap; word-wrap: break-word; background: #fff; border: 1px solid #e8e4df; border-radius: 10px; padding: 14px; }
    .share-logistics-pending { text-align: center; color: #999; font-size: 14px; padding: 30px 0; }
    .share-header-card { background: #fff; border: 1px solid #e8e4df; border-radius: 10px; padding: 14px; margin-bottom: 16px; }
    .share-header-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
    .share-cost-badge { color: #2d7a3a; font-size: 16px; font-weight: 700; }
    .share-complexity-badge { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #fff; display: inline-block; }
    .share-timeline-badge { font-size: 12px; color: #888; }
    .share-summary-bar { display: flex; gap: 8px; margin-bottom: 16px; overflow-x: auto; padding-bottom: 4px; }
    .share-summary-card { background: #fff; border: 1px solid #e0dcd6; border-radius: 10px; padding: 10px 14px; flex: 1; min-width: 140px; text-decoration: none; color: inherit; }
    .share-summary-card-name { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; }
    .share-summary-card-cost { display: block; font-size: 15px; font-weight: 700; color: #2d7a3a; }
    .share-angle-section { border: 1px solid #e0dcd6; border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
    .share-angle-header { background: #faf8f5; padding: 12px 14px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .share-angle-header-info { flex: 1; }
    .share-angle-header-name { font-weight: 600; font-size: 14px; }
    .share-angle-header-desc { font-size: 12px; color: #888; margin-top: 2px; }
    .share-angle-header-cost { font-size: 15px; font-weight: 700; color: #2d7a3a; white-space: nowrap; }
    .share-angle-body { padding: 0 14px 14px; }
    .share-angle-section.collapsed .share-angle-body { display: none; }
    .share-angle-section.collapsed .share-toggle-icon { transform: rotate(-90deg); }
    .share-section-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #8B5E3C; margin: 14px 0 6px; }
    .share-line-item { display: flex; flex-direction: column; padding: 8px 0; border-bottom: 1px solid #ede9e3; }
    .share-line-name { font-weight: 600; font-size: 13px; color: #333; }
    .share-line-desc { font-size: 12px; color: #888; margin-top: 2px; }
    .share-line-meta { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
    .share-line-cost { color: #2d7a3a; font-weight: 700; font-size: 13px; }
    .share-line-qty { font-size: 11px; color: #999; background: #f0ece6; padding: 1px 6px; border-radius: 4px; }
    .share-line-source { font-size: 11px; color: #888; }
    .share-link { font-size: 11px; color: #4a90d9; text-decoration: none; }
    .share-link:hover { text-decoration: underline; }
    .share-subtotal { display: flex; justify-content: space-between; padding: 6px 0; font-size: 12px; color: #888; border-top: 1px dashed #e0dcd6; margin-top: 4px; }
    .share-angle-total { color: #2d7a3a; text-align: right; font-weight: 700; font-size: 14px; border-top: 2px solid #d5d0c8; padding: 10px 0 4px; margin-top: 8px; }
    .share-safety-list { list-style: none; padding: 0; }
    .share-safety-list li { font-size: 13px; padding: 4px 0; color: #555; }
    .share-safety-list li::before { content: '\\26A0\\FE0F '; }
    .share-sourcing-notes { background: #fff; border-left: 3px solid #d4a060; padding: 10px 14px; font-size: 13px; color: #555; border-radius: 0 6px 6px 0; }
    .share-footer { text-align: center; padding: 30px 0 20px; color: #bbb; font-size: 12px; }
    /* Ideas list page */
    .share-filter-badges { display: flex; gap: 6px; justify-content: center; margin-bottom: 20px; flex-wrap: wrap; }
    .share-badge { padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: 600; background: #e8e4df; color: #5a3e1b; }
    .share-ideas-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .share-idea-card { background: #fff; border: 1px solid #e8e4df; border-radius: 10px; padding: 16px; text-decoration: none; color: inherit; display: block; transition: box-shadow 0.15s; }
    .share-idea-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .share-idea-card-name { font-size: 15px; font-weight: 600; color: #333; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .share-idea-card-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .share-idea-card-preview { font-size: 13px; color: #888; line-height: 1.4; }
    .share-green-dot { width: 8px; height: 8px; border-radius: 50%; background: #2d7a3a; display: inline-block; flex-shrink: 0; }
    .share-empty { text-align: center; color: #999; padding: 60px 20px; font-size: 15px; }
`;

const COMPLEXITY_COLORS = { easy: '#27ae60', medium: '#e67e22', hard: '#e74c3c', extreme: '#8b0000' };

function renderSharePage(title, bodyHtml) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)} — BusinessWorld</title><style>${SHARE_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

function shareFmtCost(v) {
    if (v == null || isNaN(v)) return '$0.00';
    return '$' + Number(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shareComputeLineTotal(item) {
    if (item.computed_total != null && !isNaN(item.computed_total)) return Number(item.computed_total);
    const qty = Number(item.quantity || item.qty || 1);
    const price = Number(item.unit_price_cad || item.estimated_cost_cad || 0);
    return qty * price;
}

function shareSumItems(items) {
    if (!items || !items.length) return 0;
    return items.reduce((acc, item) => acc + shareComputeLineTotal(item), 0);
}

function shareRenderLineItems(items) {
    if (!items || !items.length) return '';
    let html = '';
    let subtotal = 0;
    for (const item of items) {
        const unitPrice = parseFloat(item.unit_price_cad) || 0;
        const qty = parseInt(item.quantity) || 1;
        const cost = parseFloat(item.estimated_cost_cad) || (unitPrice * qty) || 0;
        subtotal += cost;
        const source = esc(item.where_to_buy || item.where_in_calgary || item.source || item.supplier || item.provider || '');
        const nameStr = esc(item.name || item.type || item.item || item.service || '');
        const descStr = item.description ? esc(item.description) : '';
        const notesStr = item.notes ? esc(item.notes) : '';
        const links = (item.links || []).filter(Boolean);
        html += '<div class="share-line-item">';
        html += '<div class="share-line-name">' + nameStr + '</div>';
        if (descStr) html += '<div class="share-line-desc">' + descStr + '</div>';
        html += '<div class="share-line-meta">';
        if (cost) html += '<span class="share-line-cost">CAD ' + shareFmtCost(cost) + '</span>';
        if (qty > 1) html += '<span class="share-line-qty">x' + qty + '</span>';
        if (source) html += '<span class="share-line-source">' + source + '</span>';
        links.forEach(l => { html += '<a class="share-link" href="' + esc(l) + '" target="_blank" rel="noopener">Link</a>'; });
        html += '</div>';
        if (notesStr) html += '<div class="share-line-desc" style="color:#aaa;">' + notesStr + '</div>';
        html += '</div>';
    }
    if (subtotal > 0) {
        html += '<div class="share-subtotal"><span>Subtotal</span><span>CAD ' + shareFmtCost(subtotal) + '</span></div>';
    }
    return html;
}

function renderShareIdeaPage(idea) {
    const log = idea.logistics;
    let logisticsHtml = '';

    if (!log || Object.keys(log).length === 0) {
        logisticsHtml = '<div class="share-logistics-pending">Logistics research pending...</div>';
    } else {
        // Normalize angles
        let angles;
        if (log.angles && Array.isArray(log.angles) && log.angles.length) {
            angles = log.angles;
        } else {
            angles = [{ name: 'Primary Approach', description: log.summary || '', complexity: log.build_complexity || '', timeline: log.timeline_estimate || '', materials: log.materials || [], services: log.services || [], equipment: log.equipment || [] }];
        }

        const angleTotals = angles.map(a => {
            const m = shareSumItems(a.materials), s = shareSumItems(a.services), e = shareSumItems(a.equipment);
            return { materials: m, services: s, equipment: e, grand: m + s + e };
        });

        // Summary header card
        if (log.summary || log.estimated_cost_range || log.last_researched) {
            logisticsHtml += '<div class="share-header-card">';
            if (log.summary) logisticsHtml += '<div style="font-size:13px;margin-bottom:6px;">' + esc(log.summary) + '</div>';
            logisticsHtml += '<div class="share-header-meta">';
            if (log.estimated_cost_range) logisticsHtml += '<span class="share-cost-badge">' + esc(log.estimated_cost_range) + '</span>';
            if (log.build_complexity) {
                const bc = log.build_complexity;
                logisticsHtml += '<span class="share-complexity-badge" style="background:' + (COMPLEXITY_COLORS[bc] || '#999') + ';">' + esc(bc) + '</span>';
            }
            if (log.timeline_estimate) logisticsHtml += '<span class="share-timeline-badge">' + esc(log.timeline_estimate) + '</span>';
            if (log.last_researched) logisticsHtml += '<span class="share-timeline-badge">Researched: ' + esc(log.last_researched) + '</span>';
            logisticsHtml += '</div></div>';
        }

        // Cost summary bar
        if (angles.length > 0) {
            logisticsHtml += '<div class="share-summary-bar">';
            angles.forEach((a, i) => {
                const total = angleTotals[i].grand;
                const complexity = a.complexity || a.build_complexity || '';
                const badgeColor = COMPLEXITY_COLORS[complexity] || '#999';
                logisticsHtml += '<div class="share-summary-card">';
                logisticsHtml += '<span class="share-summary-card-name">' + esc(a.name || 'Angle ' + (i + 1)) + '</span>';
                if (complexity) logisticsHtml += '<span class="share-complexity-badge" style="background:' + badgeColor + ';margin-bottom:4px;">' + esc(complexity) + '</span> ';
                logisticsHtml += '<span class="share-summary-card-cost">' + shareFmtCost(total) + '</span>';
                logisticsHtml += '</div>';
            });
            logisticsHtml += '</div>';
        }

        // Per-angle sections
        angles.forEach((a, i) => {
            const totals = angleTotals[i];
            const complexity = a.complexity || a.build_complexity || '';
            const badgeColor = COMPLEXITY_COLORS[complexity] || '#999';
            logisticsHtml += '<div class="share-angle-section">';
            logisticsHtml += '<div class="share-angle-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
            logisticsHtml += '<div class="share-angle-header-info">';
            logisticsHtml += '<div class="share-angle-header-name">' + esc(a.name || 'Angle ' + (i + 1));
            if (complexity) logisticsHtml += ' <span class="share-complexity-badge" style="background:' + badgeColor + ';">' + esc(complexity) + '</span>';
            logisticsHtml += '</div>';
            if (a.description) logisticsHtml += '<div class="share-angle-header-desc">' + esc(a.description) + '</div>';
            if (a.timeline) logisticsHtml += '<div class="share-timeline-badge">' + esc(a.timeline) + '</div>';
            logisticsHtml += '</div>';
            logisticsHtml += '<span class="share-angle-header-cost">' + shareFmtCost(totals.grand) + '</span>';
            logisticsHtml += '<span class="share-toggle-icon" style="font-size:16px;color:#aaa;transition:transform 0.2s;">&#9660;</span>';
            logisticsHtml += '</div>';

            logisticsHtml += '<div class="share-angle-body">';
            if (a.materials && a.materials.length) {
                logisticsHtml += '<div class="share-section-label">Materials</div>' + shareRenderLineItems(a.materials);
            }
            if (a.services && a.services.length) {
                logisticsHtml += '<div class="share-section-label">Services</div>' + shareRenderLineItems(a.services);
            }
            if (a.equipment && a.equipment.length) {
                logisticsHtml += '<div class="share-section-label">Equipment</div>' + shareRenderLineItems(a.equipment);
            }
            logisticsHtml += '<div class="share-angle-total">Angle Total: ' + shareFmtCost(totals.grand) + '</div>';
            logisticsHtml += '</div></div>';
        });

        // Safety
        if (log.safety && log.safety.length) {
            logisticsHtml += '<div class="share-section"><div class="share-section-title">Safety Checklist</div><ul class="share-safety-list">';
            for (const s of log.safety) logisticsHtml += '<li>' + esc(s) + '</li>';
            logisticsHtml += '</ul></div>';
        }

        // Sourcing notes
        if (log.sourcing_notes) {
            logisticsHtml += '<div class="share-section"><div class="share-section-title">Sourcing Notes</div><div class="share-sourcing-notes">' + esc(log.sourcing_notes) + '</div></div>';
        }
    }

    let bodyHtml = '<div class="share-container">';
    bodyHtml += '<div class="share-header"><h1>' + esc(idea.name || 'Untitled Idea') + '</h1></div>';
    if (idea.hook) bodyHtml += '<div class="share-hook">' + esc(idea.hook) + '</div>';
    if (idea.context) {
        bodyHtml += '<div class="share-section"><div class="share-section-title">Context</div><div class="share-context">' + esc(idea.context) + '</div></div>';
    }
    if (idea.script) {
        bodyHtml += '<div class="share-section"><div class="share-section-title">Script</div><div class="share-script">' + esc(idea.script) + '</div></div>';
    }
    if (logisticsHtml) {
        bodyHtml += '<div class="share-section"><div class="share-section-title">Logistics</div>' + logisticsHtml + '</div>';
    }
    bodyHtml += '<div class="share-footer">Powered by BusinessWorld</div></div>';

    return renderSharePage(idea.name || 'Shared Idea', bodyHtml);
}

function renderShareIdeasPage(ideas, statusFilter, catFilter, getStatus) {
    const statusLabels = { all: 'All', idea: 'Ideas', incubator: 'Incubator', workshop: 'Workshop', posted: 'Posted' };

    let bodyHtml = '<div class="share-container">';
    bodyHtml += '<div class="share-header"><h1>Ideas</h1></div>';

    // Filter badges
    bodyHtml += '<div class="share-filter-badges">';
    if (statusFilter !== 'all') bodyHtml += '<span class="share-badge">Status: ' + esc(statusLabels[statusFilter] || statusFilter) + '</span>';
    if (catFilter !== 'all') bodyHtml += '<span class="share-badge">Category: ' + esc(catFilter) + '</span>';
    if (statusFilter === 'all' && catFilter === 'all') bodyHtml += '<span class="share-badge">Showing all ideas</span>';
    bodyHtml += '</div>';

    if (ideas.length === 0) {
        bodyHtml += '<div class="share-empty">No ideas match this filter.</div>';
    } else {
        bodyHtml += '<div class="share-ideas-grid">';
        for (const idea of ideas) {
            const log = idea.logistics;
            const hasCost = log && log.estimated_cost_range;
            const complexity = log && (log.build_complexity || (log.angles && log.angles[0] && log.angles[0].complexity));
            const hasLogistics = log && Object.keys(log).length > 0;
            const preview = (idea.context || '').substring(0, 120) + ((idea.context || '').length > 120 ? '...' : '');

            bodyHtml += '<a class="share-idea-card" href="/share/idea/' + esc(idea.id) + '">';
            bodyHtml += '<div class="share-idea-card-name">';
            if (hasLogistics) bodyHtml += '<span class="share-green-dot"></span>';
            bodyHtml += esc(idea.name || 'Untitled') + '</div>';
            bodyHtml += '<div class="share-idea-card-meta">';
            if (hasCost) bodyHtml += '<span class="share-cost-badge" style="font-size:13px;">' + esc(log.estimated_cost_range) + '</span>';
            if (complexity) bodyHtml += '<span class="share-complexity-badge" style="background:' + (COMPLEXITY_COLORS[complexity] || '#999') + ';font-size:10px;">' + esc(complexity) + '</span>';
            bodyHtml += '</div>';
            if (preview) bodyHtml += '<div class="share-idea-card-preview">' + esc(preview) + '</div>';
            bodyHtml += '</a>';
        }
        bodyHtml += '</div>';
    }

    bodyHtml += '<div class="share-footer">Powered by BusinessWorld</div></div>';
    return renderSharePage('Ideas — BusinessWorld', bodyHtml);
}

// Initialize R2 cloud storage before accepting requests
cloud.initR2();

server.listen(PORT, () => {
    console.log(`Business World running at http://localhost:${PORT}`);
    videoAnalyzer.resumeJobs(process.env.OPENAI_API_KEY, process.env.OPENAI_CHAT_MODEL || 'gpt-4o');
    // Pre-warm metrics cache in background (ready before user opens Pen)
    _loadOrBuildMetrics().catch(e => console.warn('Metrics pre-warm failed:', e.message));
    // Start shorts crawler — initial crawl after 5s, then every 30 minutes
    setTimeout(() => shortsCrawler.crawl().then(() => shortsCrawler.processFrames()).catch(e => console.warn('shorts-crawler cycle error:', e.message)), 5000);
    setInterval(() => shortsCrawler.crawl().then(() => shortsCrawler.processFrames()).catch(e => console.warn('shorts-crawler cycle error:', e.message)), 30 * 60 * 1000);
});
