const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
const geminiWatch = require('./gemini-watch');
const footageCoverage = require('./footage-coverage');
const instagram = require('./instagram-service');
const igPostJobs = {};   // jobId -> live progress of a trial-reel post (client polls)
const videolabCoordinator = require('./videolab-coordinator');
let codexRunner = null;
try {
    codexRunner = require('./codex-runner');
} catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    console.warn('codex-runner unavailable; in-app Codex chat will be disabled.');
}
// Surface background-job crashes in the logs instead of dying silently. A heap
// OOM still terminates the process (Node prints "heap out of memory" itself), but
// a stray throw/rejection in a setImmediate job now leaves a clear breadcrumb.
process.on('uncaughtException', (e) => { try { console.error('[uncaughtException]', e && e.stack || e); } catch (_) {} });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', e && e.stack || e); } catch (_) {} });

const cloud = require('./cloud-storage');
const swipeScraper = require('./swipe-scraper');
const dataStore = require('./data-store');
const auth = require('./auth');
const shortsCrawler = require('./shorts-crawler');
const financeService = require('./buildings/finance/finance-service');
const jarvisStore = require('./buildings/jarvis/jarvis-store');
const jarvisRunner = require('./buildings/jarvis/jarvis-runner');
const jarvisVariableCatalog = require('./buildings/jarvis/jarvis-variable-catalog');
const jarvisMetrics = require('./buildings/jarvis/jarvis-metrics');
const streamJson = require('./buildings/jarvis/stream-json');
const viralIdeaEngine = require('./buildings/jarvis/viral-idea-engine');
const PDFDocument = require('pdfkit');
const { spawn } = require('child_process');
const PORT = process.env.PORT || 8002;
const IS_RENDER = !!process.env.RENDER;  // Render sets this env var automatically
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Hook reasoning engine support: server-side LLM JSON + memory persistence ──
function _extractJsonObject(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) {}
    const a = text.indexOf('"hooks"');
    const from = a >= 0 ? text.lastIndexOf('{', a) : text.indexOf('{');
    if (from < 0) return null;
    let depth = 0, inStr = false, escCh = false;
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (inStr) { if (escCh) escCh = false; else if (ch === '\\') escCh = true; else if (ch === '"') inStr = false; }
        else if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { if (--depth === 0) { try { return JSON.parse(text.slice(from, i + 1)); } catch (e) { return null; } } }
    }
    return null;
}
// Kimi K2.6 (Fireworks) is a REASONING model — it writes a long chain-of-thought
// before the JSON, so it needs a high token ceiling or it gets cut off mid-thought
// (finish_reason 'length') before ever emitting the JSON. Give it room.
async function hookLlmJson(messages) {
    if (process.env.FIREWORKS_API_KEY) {
        try {
            const r = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
                method: 'POST', headers: { 'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: process.env.KIMI_CHAT_MODEL || 'accounts/fireworks/models/kimi-k2p6', messages, temperature: 0.4, max_tokens: 20000 })
            });
            if (r.ok) { const o = _extractJsonObject((await r.json()).choices?.[0]?.message?.content); if (o) return o; }
        } catch (e) { /* fall through */ }
    }
    // Last-resort only if Fireworks is unset/unreachable — Kimi is the engine.
    if (process.env.OPENAI_API_KEY) {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o', messages, temperature: 0.5, max_tokens: 1800, response_format: { type: 'json_object' } })
        });
        if (r.ok) { const o = _extractJsonObject((await r.json()).choices?.[0]?.message?.content); if (o) return o; }
    }
    return null;
}
async function loadHookMemory() {
    try {
        const all = await dataStore.getAll('settings');
        const rec = all.find(r => r.key === 'hookMemory');
        return rec ? { principles: rec.principles || [], wins: rec.wins || [] } : { principles: [], wins: [] };
    } catch (e) { return { principles: [], wins: [] }; }
}
async function recordHookWin(win) {
    if (!win || !win.line) return;
    const all = await dataStore.getAll('settings');
    let rec = all.find(r => r.key === 'hookMemory');
    const wins = (rec && rec.wins) || [];
    if (!wins.some(w => w.line === win.line)) wins.unshift({ line: win.line, visual: win.visual || '', note: win.note || '' });
    const trimmed = wins.slice(0, 40);
    if (rec) await dataStore.update('settings', rec.id, { wins: trimmed });
    else await dataStore.create('settings', { key: 'hookMemory', principles: [], wins: trimmed });
}

function makeLineItemRows(lineItems, currency, indent) {
    return lineItems.map(li => {
        const desc = li.description || "";
        const amt = (li.amount || 0).toFixed(2);
        const delivHtml = li.deliverables
            ? `<div style="font-size:12px;color:#555;margin-top:6px;line-height:1.6;word-break:break-word;white-space:pre-wrap"><strong>Deliverables:</strong> ${esc(li.deliverables)}</div>`
            : "";
        const notesHtml = li.notes
            ? `<div style="font-size:12px;color:#555;margin-top:4px;line-height:1.6;word-break:break-word;white-space:pre-wrap"><strong>Notes:</strong> ${esc(li.notes)}</div>`
            : "";
        const pl = indent ? "padding-left:20px;" : "";
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:14px 0;border-bottom:1px solid #f0f0f0;">
            <div style="flex:1;min-width:0;${pl}">
                <div style="font-size:14px;font-weight:700;color:#2d3436;word-break:break-word">${esc(desc)}</div>
                ${delivHtml}${notesHtml}
            </div>
            <div style="font-size:14px;font-weight:700;color:#2d3436;white-space:nowrap;text-align:right;flex-shrink:0;padding-top:1px">${currency} $${amt}</div>
        </div>`;
    }).join("");
}

function generateBatchInvoiceHTML({ invoiceNumber, invoiceDate, dueDate, primaryCompanyName, companyAddr, lineItems, subtotal, currency }) {
    const numStr = String(invoiceNumber).padStart(4, '0');
    // Group line items by company so multi-company invoices read clearly
    const byCompany = {};
    lineItems.forEach(li => { (byCompany[li.companyName || 'Other'] = byCompany[li.companyName || 'Other'] || []).push(li); });
    const companyNames = Object.keys(byCompany);
    const showGrouping = companyNames.length > 1;
    const rows = showGrouping
        ? companyNames.map(cn => {
            const header = `<div style="font-weight:700;color:#2d3436;background:#f8f9fa;padding:10px 12px;margin-top:8px;border-radius:4px;">${esc(cn)}</div>`;
            return header + makeLineItemRows(byCompany[cn], currency, true);
        }).join("")
        : makeLineItemRows(lineItems, currency, false);

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>INV-${numStr} ${esc(primaryCompanyName)} ${invoiceDate}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333;padding:40px;max-width:800px;margin:0 auto}
.inv-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:3px solid #2d3436}
.inv-title{font-size:32px;font-weight:800;color:#2d3436;letter-spacing:-0.5px}.inv-number{font-size:14px;color:#888;margin-top:4px}
.inv-parties{display:flex;justify-content:space-between;gap:40px;margin-bottom:32px}.inv-party{flex:1}
.inv-party-label{font-size:11px;font-weight:700;color:#636e72;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.inv-party-name{font-size:16px;font-weight:700;margin-bottom:4px}.inv-party-detail{font-size:13px;color:#666;line-height:1.6}
.inv-dates{display:flex;gap:32px;margin-bottom:28px}.inv-date-box{background:#f8f9fa;padding:10px 16px;border-radius:8px}
.inv-date-label{font-size:11px;font-weight:700;color:#888;text-transform:uppercase}.inv-date-value{font-size:15px;font-weight:600;margin-top:2px}
.inv-totals{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-bottom:32px}
.inv-total-row{display:flex;gap:40px;font-size:14px}.inv-total-label{color:#888;min-width:100px;text-align:right}
.inv-total-value{font-weight:600;min-width:100px;text-align:right}
.inv-grand-total{font-size:20px;font-weight:800;color:#2d3436;border-top:2px solid #2d3436;padding-top:8px;margin-top:4px}
.inv-bank{margin-top:32px;padding:16px;background:#f8f9fa;border-radius:8px;font-size:13px;line-height:1.6}
.inv-bank-title{font-size:12px;font-weight:700;color:#636e72;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.inv-bank-row{display:flex;gap:8px}.inv-bank-label{color:#888;min-width:130px}.inv-bank-value{font-weight:600}
@media print{body{padding:15mm;margin:0}@page{margin:0;size:auto}html{-webkit-print-color-adjust:exact}}
</style></head><body>
<div class="inv-header"><div><div class="inv-title">INVOICE</div><div class="inv-number">INV-${numStr}</div></div></div>
<div class="inv-parties">
<div class="inv-party"><div class="inv-party-label">From</div><div class="inv-party-name">Centrality LTD</div><div class="inv-party-detail">14 Discovery Ridge Road SW<br>Calgary AB Canada, T3H 4P8<br>@TylerCsatari<br>+1 (403) 519-6945<br>tylerdaviscsatari@gmail.com</div></div>
<div class="inv-party"><div class="inv-party-label">Bill To</div><div class="inv-party-name">${esc(primaryCompanyName)}</div><div class="inv-party-detail">${companyAddr || ''}</div></div>
</div>
<div class="inv-dates"><div class="inv-date-box"><div class="inv-date-label">Invoice Date</div><div class="inv-date-value">${invoiceDate}</div></div><div class="inv-date-box"><div class="inv-date-label">Due Date</div><div class="inv-date-value">${dueDate}</div></div></div>
<div style="margin-bottom:8px;">
  <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:2px solid #e0e0e0;">
    <span style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px">Description</span>
    <span style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;text-align:right">Amount</span>
  </div>
  ${rows}
</div>
<div class="inv-totals">
<div class="inv-total-row"><span class="inv-total-label">Subtotal</span><span class="inv-total-value">${currency} $${subtotal.toFixed(2)}</span></div>
<div class="inv-total-row inv-grand-total"><span class="inv-total-label">Total</span><span class="inv-total-value">${currency} $${subtotal.toFixed(2)}</span></div>
</div>
<div class="inv-bank"><div class="inv-bank-title">Payment Details</div><div class="inv-bank-row"><span class="inv-bank-label">Institution Number:</span><span class="inv-bank-value">001</span></div><div class="inv-bank-row"><span class="inv-bank-label">Transit Number:</span><span class="inv-bank-value">30489</span></div><div class="inv-bank-row"><span class="inv-bank-label">Account Number:</span><span class="inv-bank-value">1987-607</span></div></div>
</body></html>`;
}

const DIR = __dirname;
const LAYOUT_FILE = path.join(DIR, 'layout.json');
const BUILD_TS = Date.now();

// ── Jarvis Compact Helpers ────────────────────────────────────────────
function sendJsonGz(req, res, data, statusCode) {
    const json = typeof data === 'string' ? data : JSON.stringify(data);
    const accepts = (req.headers['accept-encoding'] || '');
    if (accepts.includes('gzip')) {
        zlib.gzip(Buffer.from(json, 'utf8'), (err, compressed) => {
            if (err) {
                res.writeHead(statusCode || 200, { 'Content-Type': 'application/json' });
                res.end(json);
            } else {
                res.writeHead(statusCode || 200, {
                    'Content-Type': 'application/json',
                    'Content-Encoding': 'gzip',
                    'Vary': 'Accept-Encoding',
                });
                res.end(compressed);
            }
        });
    } else {
        res.writeHead(statusCode || 200, { 'Content-Type': 'application/json' });
        res.end(json);
    }
}

function compactIndicator(ind) {
    if (!ind) return ind;
    const { dataset, ...rest } = ind;
    return { ...rest, _datasetSize: Array.isArray(dataset) ? dataset.length : 0 };
}

function compactDerived(d) {
    if (!d) return d;
    const { dataset, ...rest } = d;
    return { ...rest, _datasetSize: Array.isArray(dataset) ? dataset.length : 0 };
}

// ── Viral-Idea Ideas Cache (Render OOM guard) ──────────────────────────
// Render's 2GB dyno can't run buildIdeas() — it OOMs and 502s. Ideas are
// pre-generated locally by buildings/jarvis/sync-ideas-to-r2.js and uploaded
// to R2; these endpoints just serve the cached JSON. In-memory cache layer
// avoids re-fetching R2 on every request. Local generation is kept as a
// last-resort fallback (with a hard timeout) for when R2 is unreachable.
const VIRAL_IDEAS_TTL_MS = 5 * 60 * 1000;
const _viralIdeasCache = new Map(); // count -> { payload, ts }
const _viralIdeasInFlight = new Map(); // count -> Promise<payload>
const VIRAL_IDEAS_R2_KEY = 'jarvis/viral-ideas-cache.json';
const VIRAL_MODEL_R2_KEY = 'jarvis/viral-model-cache.json';
const VIRAL_R2_MEM_KEY_IDEAS = '__r2_ideas__';
const VIRAL_R2_MEM_KEY_MODEL = '__r2_model__';
const VIRAL_LOCAL_FALLBACK_MS = 500;
const VIRAL_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
let _viralRefreshLastRun = 0;
let _viralRefreshActive = false;

// Trim a cached ideas payload to the requested count. The R2 cache is built
// at count=10 (the upper bound the UI ever asks for); smaller requests just
// take a prefix of the array so we don't re-generate per-count.
function _shapeIdeasPayload(payload, count) {
    if (!payload || !Array.isArray(payload.ideas)) return payload;
    if (payload.ideas.length <= count) return payload;
    return { ...payload, ideas: payload.ideas.slice(0, count) };
}

// ── Jarvis Runner State (in-memory, survives across requests) ──────────
const LOG_TAIL_MAX = 32 * 1024; // keep last 32 KB of output
const _runner = {
    active: false,
    pid: null,
    startedAt: null,
    mode: null,     // 'auto' | 'queue'
    args: [],
    exitCode: null,
    signal: null,
    error: null,
    logTail: '',
    _proc: null,    // live reference so GC can't collect it
};

function _launchPipeline(mode, args) {
    // Refuse if already running
    if (_runner.active && _runner._proc && _runner._proc.exitCode === null) {
        return { started: false, error: 'A run is already active', pid: _runner.pid };
    }
    // Reset state
    _runner.active = true;
    _runner.mode = mode;
    _runner.args = args;
    _runner.exitCode = null;
    _runner.signal = null;
    _runner.error = null;
    _runner.logTail = '';
    _runner.startedAt = new Date().toISOString();

    const proc = spawn('python3', ['-u', ...args], {
        cwd: __dirname,
        env: { ...process.env, JARVIS_API_URL: `http://localhost:${PORT}` },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    _runner._proc = proc;
    _runner.pid = proc.pid;

    function appendLog(chunk) {
        _runner.logTail += chunk.toString();
        if (_runner.logTail.length > LOG_TAIL_MAX) {
            _runner.logTail = _runner.logTail.slice(-LOG_TAIL_MAX);
        }
    }
    proc.stdout.on('data', appendLog);
    proc.stderr.on('data', appendLog);

    proc.on('error', (err) => {
        _runner.active = false;
        _runner.error = err.message;
        _runner.logTail += `\n[SPAWN ERROR] ${err.message}\n`;
        _runner._proc = null;
        // Write failed progress so UI sees the failure
        if (mode === 'auto') {
            jarvisStore.saveJson('autonomous_progress', {
                active: false, run_id: `server_error_${Date.now()}`,
                mode: 'hybrid_auto', started_at: _runner.startedAt,
                finished_at: new Date().toISOString(),
                stop_reason: `spawn_error: ${err.message}`,
                attempted: 0, completed: 0, failures: 0,
                recent_events: [{ type: 'error', msg: err.message, ts: new Date().toISOString() }],
            }).catch(() => {});
        }
    });

    proc.on('close', (code, signal) => {
        _runner.active = false;
        _runner.exitCode = code;
        _runner.signal = signal;
        // If auto mode exited with error before Python could init progress, surface it
        if (mode === 'auto' && code !== 0) {
            const elapsed = Date.now() - new Date(_runner.startedAt).getTime();
            if (elapsed < 10000) { // crashed within 10s — likely never initialized progress
                jarvisStore.saveJson('autonomous_progress', {
                    active: false, run_id: `crash_${Date.now()}`,
                    mode: 'hybrid_auto', started_at: _runner.startedAt,
                    finished_at: new Date().toISOString(),
                    stop_reason: `process_exit: code=${code} signal=${signal}`,
                    attempted: 0, completed: 0, failures: 0,
                    recent_events: [{
                        type: 'error', ts: new Date().toISOString(),
                        msg: `Process exited (code=${code}). Last output: ${_runner.logTail.slice(-500)}`,
                    }],
                }).catch(() => {});
            }
        }
        _runner._proc = null;
    });

    return { started: true, pid: proc.pid };
}

/**
 * Node-native Jarvis runner — used on Render (no Python/numpy available).
 * Runs the pipeline in-process via jarvis-runner.js.
 * mode: 'auto' | 'queue'
 */
function _launchNodeRunner(mode, opts) {
    // Duplicate-run protection (same as Python path)
    if (_runner.active) {
        return { started: false, error: 'A run is already active', pid: _runner.pid };
    }

    _runner.active = true;
    _runner.mode = mode;
    _runner.args = [mode, JSON.stringify(opts)];
    _runner.exitCode = null;
    _runner.signal = null;
    _runner.error = null;
    _runner.logTail = '';
    _runner.startedAt = new Date().toISOString();
    _runner._proc = null;
    _runner.pid = process.pid;  // in-process, use Node's own PID

    // Reset the runner's log buffer so server can read it
    jarvisRunner._logBuffer = '';

    const runnerPromise = mode === 'auto'
        ? jarvisRunner.autoRun(opts)
        : jarvisRunner.runQueue(opts.n || 5);

    runnerPromise
        .then(() => {
            _runner.active = false;
            _runner.exitCode = 0;
            _runner.logTail = jarvisRunner._logBuffer.slice(-LOG_TAIL_MAX);
            console.log(`[jarvis] Node runner completed (${mode})`);
        })
        .catch((err) => {
            _runner.active = false;
            _runner.exitCode = 1;
            _runner.error = err.message;
            _runner.logTail = jarvisRunner._logBuffer.slice(-LOG_TAIL_MAX) +
                `\n[NODE RUNNER ERROR] ${err.message}\n`;
            console.error(`[jarvis] Node runner failed:`, err.message);
            if (mode === 'auto') {
                jarvisStore.saveJson('autonomous_progress', {
                    active: false, run_id: `node_error_${Date.now()}`,
                    mode: 'hybrid_auto', started_at: _runner.startedAt,
                    finished_at: new Date().toISOString(),
                    stop_reason: `node_error: ${err.message}`,
                    attempted: 0, completed: 0, failures: 0,
                    recent_events: [{ type: 'error', msg: err.message, ts: new Date().toISOString() }],
                }).catch(() => {});
            }
        });

    return { started: true, pid: process.pid, engine: 'node' };
}

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.md': 'text/markdown; charset=utf-8',
};

// =========================================
// TRIBE v2 brain analysis: in-process job tracker
// =========================================
// Keyed by videoId — one job per video at a time. Persisted JSON in
// buildings/jarvis/tribe-analysis/{videoId}.json IS the source of truth for
// completed runs; this map only tracks queued/running/failed jobs in memory.
const _tribeJobs = {};
const TRIBE_PYTHON = process.env.TRIBE_PYTHON
    || '/Users/tylercsatari/Desktop/BusinessHub/tribev2/.venv/bin/python3.11';
// Python that has the ML/data deps (boto3, whisper, numpy). The server is often
// launched with a bare PATH where `python3` is system python WITHOUT these, so we
// TEST-IMPORT the deps in each candidate and pick the first that actually has them.
// Override with RAW_PYTHON. PYTHONHOME/PYTHONPATH are stripped so the chosen
// interpreter resolves its OWN site-packages (a leaked PYTHONHOME can hide numpy).
const RAW_PY_ENV = (() => { const e = { ...process.env }; delete e.PYTHONHOME; delete e.PYTHONPATH; return e; })();
const RAW_PYTHON = (() => {
    const { execSync } = require('child_process');
    const cands = [process.env.RAW_PYTHON, '/Users/tylercsatari/miniforge3/bin/python3',
        '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3', '/usr/bin/python3'].filter(Boolean);
    for (const p of cands) {
        try { execSync(`"${p}" -c "import numpy, boto3"`, { stdio: 'ignore', timeout: 12000, env: RAW_PY_ENV }); return p; }
        catch (e) {}
    }
    return 'python3';
})();
console.log('[raw-upload] using python:', RAW_PYTHON);
const TRIBE_CACHE = process.env.TRIBE_CACHE
    || '/Users/tylercsatari/Desktop/BusinessHub/tribev2/cache';

function _tribeStartJob(videoId, videoPath) {
    if (_tribeJobs[videoId] && (_tribeJobs[videoId].status === 'running' || _tribeJobs[videoId].status === 'queued')) {
        return _tribeJobs[videoId];
    }
    const scriptPath = path.join(__dirname, 'buildings', 'jarvis', 'tribe-analysis', 'analyze_video.py');
    const outPath = path.join(__dirname, 'buildings', 'jarvis', 'tribe-analysis', `${videoId}.json`);
    const id = `tribe_${videoId}_${Date.now()}`;
    const job = {
        id, videoId, status: 'queued', startedAt: new Date().toISOString(),
        log: [], stdout: '', error: null,
    };
    _tribeJobs[videoId] = job;

    try {
        const r2Key = `tribe-analysis/${videoId}.json`;
        const spawnEnv = {
            ...process.env,
            HF_TOKEN: process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '',
            HUGGINGFACE_TOKEN: process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '',
            // Fix: python3.11 pyexpat links against system libexpat which is missing a symbol.
            // Homebrew's libexpat has the symbol. Setting DYLD_LIBRARY_PATH makes the venv
            // python3.11 pick up the correct library at runtime.
            DYLD_LIBRARY_PATH: '/opt/homebrew/Cellar/expat/2.8.0/lib:' + (process.env.DYLD_LIBRARY_PATH || ''),
        };
        const proc = require('child_process').spawn(
            TRIBE_PYTHON,
            [scriptPath, videoPath, '--output', outPath,
             '--cache-folder', TRIBE_CACHE,
             '--r2-key', r2Key,
             '--skip-text',  // remove once Llama-3.2-3B access approved at hf.co
            ],
            { cwd: path.dirname(scriptPath), env: spawnEnv }
        );
        job.status = 'running';
        job.pid = proc.pid;
        proc.stdout.on('data', d => { job.stdout += d.toString(); });
        proc.stderr.on('data', d => {
            const lines = d.toString().split(/\r?\n/).filter(Boolean);
            for (const ln of lines) {
                job.log.push(ln);
                if (job.log.length > 200) job.log.shift();
            }
        });
        proc.on('error', err => {
            job.status = 'failed';
            job.error = err.message;
            console.error(`[tribe] spawn error for ${videoId}: ${err.message}`);
        });
        proc.on('close', code => {
            if (code === 0 && fs.existsSync(outPath)) {
                job.status = 'complete';
                console.log(`[tribe] ${videoId} done → ${outPath}`);
            } else {
                job.status = 'failed';
                job.error = job.error || `exit ${code}`;
                console.error(`[tribe] ${videoId} failed (exit ${code})`);
            }
        });
    } catch (e) {
        job.status = 'failed';
        job.error = e.message;
    }
    return job;
}

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

const AI_VIDEO_IDEA_DEFAULT_BATCH = 3;
const AI_VIDEO_IDEA_MAX_BATCH = 5;
const AI_VIDEO_IDEA_MAX_RUNS = 20;
const AI_VIDEO_IDEA_MAX_TOTAL = 60;
const AI_VIDEO_IDEA_DEDUPE_LIMIT = parseInt(process.env.AI_VIDEO_IDEA_DEDUPE_LIMIT || '1200', 10);
const AI_VIDEO_IDEA_SIMILARITY_THRESHOLD = Number(process.env.AI_VIDEO_IDEA_SIMILARITY_THRESHOLD || 0.88);
const AI_VIDEO_IDEA_JOB_TIMEOUT_MS = parseInt(process.env.AI_VIDEO_IDEA_JOB_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const AI_VIDEO_IDEA_JOB_IDLE_TIMEOUT_MS = parseInt(process.env.AI_VIDEO_IDEA_JOB_IDLE_TIMEOUT_MS || String(90 * 1000), 10);
// In-memory progress for AI-idea generation jobs (the client polls these; SSE is
// buffered by Render's proxy so streaming a long response shows nothing).
const aiVideoJobs = {};
const footageJobs = {};   // jobId -> live footage-coverage progress (polled by the client)

function aiVideoJobEvent(job, phase, msg, detail) {
    if (!job) return;
    const now = Date.now();
    const event = {
        at: new Date(now).toISOString(),
        elapsedMs: now - job.startedAt,
        phase: phase || job.phase || 'step',
        msg: String(msg || ''),
        detail: detail || null
    };
    job.phase = event.phase;
    job.updatedAt = now;
    job.events.push(event);
    if (job.events.length > 240) job.events.splice(0, job.events.length - 240);
    // Mirror to the server log so a crash/OOM leaves a breadcrumb of the LAST
    // phase reached (Render logs) — the in-memory job vanishes on a crash.
    try { console.log(`[aivideo ${(job.id || '').slice(0, 8)} +${Math.round(event.elapsedMs / 1000)}s] ${event.phase}: ${event.msg}`); } catch (e) {}
}

function aiVideoJobHeartbeat(job, phase, label, extra) {
    const started = Date.now();
    return setInterval(() => {
        const elapsed = Math.round((Date.now() - started) / 1000);
        aiVideoJobEvent(job, phase, `${label} (${elapsed}s)`, extra);
    }, 10000);
}

function aiVideoJobFail(job, msg, detail) {
    if (!job || job.done) return;
    job.cancelled = true;
    job.error = msg || 'AI video idea job failed.';
    job.done = true;
    if (job.abortController) {
        try { job.abortController.abort(); } catch (e) {}
    }
    try { console.error(`[aivideo ${(job.id || '').slice(0, 8)}] FAILED: ${job.error}`, detail || ''); } catch (e) {}
    aiVideoJobEvent(job, 'error', job.error, detail);
    job.phase = 'error';
    job.updatedAt = Date.now();
}

function aiVideoThrowIfStopped(job) {
    if (job && job.cancelled) throw new Error(job.error || 'AI video idea job stopped.');
}

const AI_VIDEO_IDEA_FORMULA = `
Shared representation:
P = promise vector; V = early visual evidence vector; C = conceptual/text vector;
O = expected outcome/gratification vector; A = action/process vector;
G = creator goal/motivation vector; D = reference distribution of other videos;
U = audience-interest distribution.

Score every idea as graph relationships, not as loose vibes:
- novelty = f(P, D)
- credibility = f(P, V, C, O)
- broad appeal = f(P, O, U)
- motivation = f(G, A, O, creator context)
- reference_to_gratification = f(P, O, V, unresolvedness)

Novelty is valuable only when it is unfamiliar but still understandable:
- novelty_global: distance from broad video/reference space.
- novelty_niche: distance from Business World/Tyler/project niche.
- novelty_recent: difference from recently saturated ideas.
- novelty_combo: rarity of the concept combination.
- novelty_coherence: novelty * fast understandability * relevance to known interest clusters.

Credibility is perceived likelihood that the promised outcome will resolve:
- promise_evidence_alignment: early frame/first 3 seconds supports the promise.
- predicate_grounding: object, action, property, reference, outcome are grounded.
- causal_path_likelihood: path from current state to payoff makes sense.
- proof_immediacy: proof appears fast enough.
- creator_prior: fits this creator's history and capability.
- implausibility_gap and mismatch_penalty reduce the score.

Broad appeal is expected interest across audience segments:
- recognition probability, cross-segment reach, reward universality, cultural centrality.
- Prefer broad familiar anchors plus unusual transformations.
- Strong universal rewards include danger, speed, beauty, money, status, transformation,
  destruction, fantasy, proof, forbidden tests, scale, and impossible-looking reality.

Motivation is goal-action-payoff coherence:
- goal clarity, action-goal alignment, creator fit, payoff justification,
  constraint pressure, template-object fit, and scale_reward_slope.
- Penalize trend arbitrage that feels copied with no real reason.

Reference to gratification:
- The hook must point to a desirable unresolved payoff before it pays off.
- Score payoff_identifiability, expected_payoff_value, unresolvedness,
  evidence_payoff_is_coming, optimal_uncertainty, delay_tolerance, and sensory/conceptual reward.
- Avoid 0 uncertainty (boring) and 100% uncertainty (confusing/unbelievable).

Premise graph test:
creator -> does action -> to object/concept -> under constraint -> causing expected outcome -> producing viewer reward.
Ask: Is this graph rare, credible, broadly interesting, motivated, and pointed at a valuable unresolved payoff?
`;

function aiVideoClampInt(value, fallback, min, max) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function aiVideoTrimText(value, max = 700) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 14).trim() + ' ...[trimmed]' : text;
}

function aiVideoDateValue(row) {
    const raw = row && (row.lastEdited || row.updatedAt || row.createdAt || row.date || row.postedAt);
    const ms = raw ? Date.parse(raw) : 0;
    return Number.isFinite(ms) ? ms : 0;
}

function aiVideoMetricValue(row) {
    const raw = row && (row.views ?? row.viewCount ?? row.totalViews ?? row.metrics?.views ?? row.analytics?.views ?? 0);
    if (typeof raw === 'number') return raw;
    const n = Number(String(raw || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function aiVideoCompactRows(rows, fields, limit, sortMode = 'recent') {
    const arr = Array.isArray(rows) ? rows.slice() : [];
    if (sortMode === 'views') {
        arr.sort((a, b) => aiVideoMetricValue(b) - aiVideoMetricValue(a));
    } else {
        arr.sort((a, b) => aiVideoDateValue(b) - aiVideoDateValue(a));
    }
    return arr.slice(0, limit).map(row => {
        const out = {};
        fields.forEach(field => {
            if (row && row[field] != null && row[field] !== '') out[field] = aiVideoTrimText(row[field], 500);
        });
        if (row && row.id) out.id = row.id;
        if (row && aiVideoMetricValue(row)) out.views = aiVideoMetricValue(row);
        return out;
    }).filter(row => Object.keys(row).length > 0);
}

function aiVideoReadJarvisJson(file, maxChars) {
    try {
        const full = path.join(__dirname, 'buildings', 'jarvis', file);
        if (!fs.existsSync(full)) return null;
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        return aiVideoTrimText(JSON.stringify(parsed, null, 2), maxChars);
    } catch (e) {
        return null;
    }
}

function aiVideoReadJarvisIdeaSample(file, maxItems, maxChars) {
    try {
        const full = path.join(__dirname, 'buildings', 'jarvis', file);
        if (!fs.existsSync(full)) return null;
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        let list = [];
        if (Array.isArray(parsed)) list = parsed;
        else if (Array.isArray(parsed.ideas)) list = parsed.ideas;
        else if (Array.isArray(parsed.candidates)) list = parsed.candidates;
        else if (parsed && typeof parsed === 'object') list = Object.values(parsed).filter(v => v && typeof v === 'object').slice(0, maxItems);
        const compact = list.slice(0, maxItems).map(item => {
            if (!item || typeof item !== 'object') return aiVideoTrimText(item, 300);
            return {
                name: aiVideoTrimText(item.name || item.title || item.idea || item.hook || '', 220),
                hook: aiVideoTrimText(item.hook || item.opening || '', 260),
                score: item.score ?? item.total ?? item.predicted ?? item.views ?? '',
                notes: aiVideoTrimText(item.notes || item.why || item.reason || item.context || '', 320)
            };
        });
        return aiVideoTrimText(JSON.stringify(compact, null, 2), maxChars);
    } catch (e) {
        return null;
    }
}

function aiVideoIdeaText(idea) {
    return [
        idea?.title || idea?.name,
        idea?.hook,
        idea?.context,
        idea?.promise || idea?.P,
        idea?.earlyVisual || idea?.early_visual || idea?.V,
        idea?.conceptual || idea?.C,
        idea?.payoff || idea?.expectedOutcome || idea?.expected_outcome || idea?.O,
        idea?.actionProcess || idea?.action_process || idea?.A,
        idea?.creatorGoal || idea?.creator_goal || idea?.G,
        idea?.why100m || idea?.why_100m,
        idea?.differentiation
    ].filter(Boolean).map(v => String(v).trim()).join('\n').slice(0, 5000);
}

function aiVideoExtractJsonObject(text, key) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) {}
    const needle = key ? `"${key}"` : '';
    const anchor = needle ? text.indexOf(needle) : -1;
    const from = anchor >= 0 ? text.lastIndexOf('{', anchor) : text.indexOf('{');
    if (from < 0) return null;
    let depth = 0, inStr = false, escCh = false;
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (escCh) escCh = false;
            else if (ch === '\\') escCh = true;
            else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(text.slice(from, i + 1)); } catch (e) { return null; }
            }
        }
    }
    return null;
}

async function aiVideoKimiJson(messages, maxTokens = 18000, onToken, signal) {
    if (!process.env.FIREWORKS_API_KEY) throw new Error('FIREWORKS_API_KEY not set');
    const stream = typeof onToken === 'function';
    const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: process.env.KIMI_CHAT_MODEL || 'accounts/fireworks/models/kimi-k2p6',
            messages,
            temperature: 0.35,
            max_tokens: maxTokens,
            stream
        }),
        signal
    });
    if (!response.ok) { const t = await response.text(); throw new Error(`Kimi error ${response.status}: ${t.slice(0, 800)}`); }
    let content = '';
    if (stream) {
        // Parse the Fireworks/OpenAI SSE stream, forwarding each token so the
        // client can watch the model reason & write live.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try { const delta = JSON.parse(data).choices?.[0]?.delta?.content || ''; if (delta) { content += delta; onToken(delta); } } catch (e) {}
            }
        }
    } else {
        const text = await response.text();
        let payload; try { payload = JSON.parse(text); } catch (e) { payload = null; }
        content = payload?.choices?.[0]?.message?.content || text;
    }
    const parsed = aiVideoExtractJsonObject(content, 'ideas');
    if (!parsed || !Array.isArray(parsed.ideas)) throw new Error('Kimi did not return a valid {"ideas": [...]} object');
    return parsed;
}

// Generic, schema-agnostic Kimi call — returns the raw message text (the caller
// parses whatever JSON it asked for). Used by footage-coverage's reasoning pass.
async function aiKimiRaw(messages, maxTokens = 8000) {
    if (!process.env.FIREWORKS_API_KEY) throw new Error('FIREWORKS_API_KEY not set');
    const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.KIMI_CHAT_MODEL || 'accounts/fireworks/models/kimi-k2p6', messages, temperature: 0.3, max_tokens: maxTokens })
    });
    if (!response.ok) { const t = await response.text(); throw new Error(`Kimi error ${response.status}: ${t.slice(0, 800)}`); }
    const text = await response.text();
    let payload; try { payload = JSON.parse(text); } catch (e) { payload = null; }
    return payload?.choices?.[0]?.message?.content || '';
}

async function aiVideoEmbedTexts(texts) {
    if (!texts.length) return [];
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set; semantic dedupe requires embeddings');
    const batchSize = 64;
    const batches = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        batches.push({ start: i, items: texts.slice(i, i + batchSize).map(t => t && t.trim() ? t : 'empty idea') });
    }
    const out = new Array(texts.length);
    // Run batches with bounded CONCURRENCY (was strictly sequential — a large
    // dedupe corpus meant ~40 back-to-back round-trips, ~60s of "stuck"). Each
    // request gets a hard timeout so one stalled call can't hang the whole job.
    const CONCURRENCY = 6;
    let cursor = 0;
    const worker = async () => {
        while (cursor < batches.length) {
            const b = batches[cursor++];
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 30000);
            let response;
            try {
                response = await fetch('https://api.openai.com/v1/embeddings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: JSON.stringify({
                        input: b.items,
                        model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
                        dimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS) || 512
                    }),
                    signal: ctrl.signal
                });
            } catch (e) { throw new Error(`OpenAI embeddings request failed: ${e.name === 'AbortError' ? 'timed out after 30s' : e.message}`); }
            finally { clearTimeout(to); }
            if (!response.ok) throw new Error(`OpenAI embeddings error ${response.status}: ${(await response.text()).slice(0, 300)}`);
            const data = await response.json();
            (data.data || []).forEach((d, j) => { out[b.start + j] = d.embedding; });
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    return out;
}

function aiVideoCosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const av = Number(a[i]) || 0;
        const bv = Number(b[i]) || 0;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function aiVideoNearest(embedding, docs) {
    let best = null;
    for (const doc of docs) {
        if (!doc.embedding) continue;
        const score = aiVideoCosine(embedding, doc.embedding);
        if (!best || score > best.score) {
            best = { score, id: doc.id, type: doc.type, title: doc.title || doc.name || '' };
        }
    }
    return best || { score: 0, id: null, type: null, title: '' };
}

async function aiVideoBuildReferenceDocs() {
    const [ideas, videos, aiideas] = await Promise.all([
        dataStore.getAll('ideas'),
        dataStore.getAll('videos'),
        dataStore.getAll('aiideas')
    ]);
    const docs = [];
    (ideas || []).forEach(row => {
        const text = aiVideoIdeaText(row);
        if (text) docs.push({ id: row.id, type: 'idea', title: row.name || row.title || '', text });
    });
    (videos || []).forEach(row => {
        const text = aiVideoIdeaText(row);
        if (text) docs.push({ id: row.id, type: 'video', title: row.name || row.title || '', text });
    });
    (aiideas || []).forEach(row => {
        if (row.status === 'promoted') return;
        const text = aiVideoIdeaText(row);
        if (text) docs.push({ id: row.id, type: 'aiidea', title: row.title || row.name || '', text, embedding: Array.isArray(row.embedding) ? row.embedding : null });
    });
    docs.sort((a, b) => (a.type === 'aiidea' ? -1 : 0) - (b.type === 'aiidea' ? -1 : 0));
    const capped = docs.slice(0, AI_VIDEO_IDEA_DEDUPE_LIMIT);
    const missing = capped.filter(d => !Array.isArray(d.embedding));
    if (missing.length) {
        const embeddings = await aiVideoEmbedTexts(missing.map(d => d.text));
        missing.forEach((doc, idx) => { doc.embedding = embeddings[idx]; });
    }
    return capped.filter(d => Array.isArray(d.embedding));
}

async function aiVideoUpsertVector(namespace, record, vectorId) {
    if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_HOST || !Array.isArray(record.embedding)) return;
    try {
        const response = await fetch(`${process.env.PINECONE_HOST}/vectors/upsert`, {
            method: 'POST',
            headers: { 'Api-Key': process.env.PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                namespace,
                vectors: [{
                    id: vectorId || record.id,
                    values: record.embedding,
                    metadata: {
                        name: record.name || record.title || '',
                        status: record.status || record.type || 'candidate',
                        source: record.source || 'ai-video-ideas'
                    }
                }]
            })
        });
        if (!response.ok) console.warn(`AI idea Pinecone upsert failed ${response.status}:`, await response.text());
    } catch (e) {
        console.warn('AI idea Pinecone upsert failed:', e.message);
    }
}

async function aiVideoDeleteVector(namespace, id) {
    if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_HOST || !id) return;
    try {
        const response = await fetch(`${process.env.PINECONE_HOST}/vectors/delete`, {
            method: 'POST',
            headers: { 'Api-Key': process.env.PINECONE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ namespace, ids: [id] })
        });
        if (!response.ok) console.warn(`AI idea Pinecone delete failed ${response.status}:`, await response.text());
    } catch (e) {
        console.warn('AI idea Pinecone delete failed:', e.message);
    }
}

function aiVideoScore(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(10, n));
}

function aiVideoNormalizeIdea(raw, runIndex, itemIndex) {
    const pick = (...keys) => {
        for (const key of keys) {
            if (raw && raw[key] != null && raw[key] !== '') return raw[key];
        }
        return '';
    };
    const scoresIn = raw?.scores || {};
    const scores = {
        novelty: aiVideoScore(scoresIn.novelty ?? scoresIn.N),
        credibility: aiVideoScore(scoresIn.credibility),
        broadAppeal: aiVideoScore(scoresIn.broad_appeal ?? scoresIn.broadAppeal),
        motivation: aiVideoScore(scoresIn.motivation),
        referenceToGratification: aiVideoScore(scoresIn.reference_to_gratification ?? scoresIn.referenceToGratification ?? scoresIn.rtg)
    };
    const avg = (scores.novelty + scores.credibility + scores.broadAppeal + scores.motivation + scores.referenceToGratification) / 5;
    scores.overall = aiVideoScore(scoresIn.overall ?? avg, avg);
    const title = aiVideoTrimText(pick('title', 'name') || pick('promise', 'P') || `AI video idea ${runIndex + 1}.${itemIndex + 1}`, 160);
    const risks = Array.isArray(raw?.risks) ? raw.risks.map(r => aiVideoTrimText(r, 260)).filter(Boolean) : [];
    const researchQueries = Array.isArray(raw?.research_queries || raw?.researchQueries)
        ? (raw.research_queries || raw.researchQueries).map(q => aiVideoTrimText(q, 180)).filter(Boolean)
        : [];
    return {
        title,
        name: title,
        hook: aiVideoTrimText(pick('hook'), 420),
        context: aiVideoTrimText(pick('context', 'plan', 'video_plan', 'videoPlan'), 1200),
        promise: aiVideoTrimText(pick('promise', 'P'), 420),
        earlyVisual: aiVideoTrimText(pick('early_visual', 'earlyVisual', 'V'), 420),
        conceptual: aiVideoTrimText(pick('conceptual', 'C'), 420),
        payoff: aiVideoTrimText(pick('payoff', 'expected_outcome', 'expectedOutcome', 'O'), 420),
        actionProcess: aiVideoTrimText(pick('action_process', 'actionProcess', 'A'), 420),
        creatorGoal: aiVideoTrimText(pick('creator_goal', 'creatorGoal', 'G'), 420),
        why100m: aiVideoTrimText(pick('why_100m', 'why100m', 'why_it_could_hit_100m'), 900),
        buildability: aiVideoTrimText(pick('buildability', 'feasibility'), 600),
        differentiation: aiVideoTrimText(pick('differentiation', 'why_not_duplicate'), 600),
        risks,
        researchQueries,
        scores,
        mechanismNotes: raw?.mechanism_notes || raw?.mechanismNotes || {},
        raw
    };
}

function aiVideoPublicRecord(record) {
    if (!record) return null;
    const { embedding, raw, ...rest } = record;
    return rest;
}

async function aiVideoFetchInternetContext() {
    const context = {
        fetchedAt: new Date().toISOString(),
        note: 'Live web search provider is not configured; YouTube trend context is included when YOUTUBE_API_KEY is available.'
    };
    if (!process.env.YOUTUBE_API_KEY) return context;
    try {
        const params = new URLSearchParams({
            part: 'snippet,statistics',
            chart: 'mostPopular',
            regionCode: process.env.AI_VIDEO_IDEA_TREND_REGION || 'US',
            maxResults: String(parseInt(process.env.AI_VIDEO_IDEA_TREND_LIMIT || '25', 10)),
            key: process.env.YOUTUBE_API_KEY
        });
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 8000);   // never let trend context hang the job
        let response;
        try { response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, { signal: ctrl.signal }); }
        finally { clearTimeout(to); }
        if (!response.ok) {
            context.youtubeError = `YouTube API ${response.status}: ${(await response.text()).slice(0, 300)}`;
            return context;
        }
        const data = await response.json();
        context.youtubeMostPopular = (data.items || []).map(item => ({
            title: aiVideoTrimText(item.snippet?.title || '', 180),
            channel: aiVideoTrimText(item.snippet?.channelTitle || '', 100),
            views: Number(item.statistics?.viewCount || 0),
            likes: Number(item.statistics?.likeCount || 0),
            publishedAt: item.snippet?.publishedAt || '',
            tags: Array.isArray(item.snippet?.tags) ? item.snippet.tags.slice(0, 8).map(t => aiVideoTrimText(t, 40)) : []
        }));
    } catch (e) {
        context.youtubeError = e.message;
    }
    return context;
}

async function aiVideoBuildGenerationContext() {
    // Load SEQUENTIALLY (not Promise.all) so we never hold ~10 freshly-parsed R2
    // collections in memory at the same instant — that simultaneous spike was a
    // prime OOM trigger on the 2 GB box.
    const ideas = await dataStore.getAll('ideas');
    const videos = await dataStore.getAll('videos');
    const projects = await dataStore.getAll('projects');
    const components = await dataStore.getAll('components');
    const orders = await dataStore.getAll('orders');
    const inventory = await dataStore.getAll('inventory');
    const notes = await dataStore.getAll('notes');
    const sponsors = await dataStore.getAll('sponsors');
    const sponsorvideos = await dataStore.getAll('sponsorvideos');
    const aiideas = await dataStore.getAll('aiideas');
    const jarvis = {
        findings_summary: aiVideoReadJarvisJson('findings-summary.json', 12000),
        retention_patterns: aiVideoReadJarvisJson('retention-patterns.json', 11000),
        prediction_model: aiVideoReadJarvisJson('prediction-model.json', 6000),
        bridge_top_principles: aiVideoReadJarvisJson('bridge_top_principles.json', 7000),
        hook_tone_principles: aiVideoReadJarvisJson('hook-tone-principles.json', 6000),
        candidate_proposals_sample: aiVideoReadJarvisIdeaSample('candidate_proposals.json', 35, 7000),
        viral_ideas_sample: aiVideoReadJarvisIdeaSample('viral-ideas.json', 45, 9000)
    };
    Object.keys(jarvis).forEach(k => { if (!jarvis[k]) delete jarvis[k]; });
    const internet = await aiVideoFetchInternetContext();
    return {
        generatedAt: new Date().toISOString(),
        defaults: {
            ideasPerRun: AI_VIDEO_IDEA_DEFAULT_BATCH,
            maxIdeasPerRun: AI_VIDEO_IDEA_MAX_BATCH,
            similarityThreshold: AI_VIDEO_IDEA_SIMILARITY_THRESHOLD,
            batchRationale: 'Default 3 per run because quality-critical generation should keep batches small; larger naive batches make the model validate many outputs at once and can reduce quality.'
        },
        collectionCounts: {
            ideas: (ideas || []).length,
            videos: (videos || []).length,
            aiVideoIdeas: (aiideas || []).length,
            projects: (projects || []).length,
            components: (components || []).length,
            orders: (orders || []).length,
            inventory: (inventory || []).length,
            notes: (notes || []).length
        },
        existingIdeas: aiVideoCompactRows(ideas, ['name', 'hook', 'context', 'project', 'type', 'status'], 220),
        existingAiVideoIdeas: aiVideoCompactRows((aiideas || []).filter(i => i.status !== 'promoted'), ['title', 'hook', 'promise', 'payoff', 'why100m', 'status'], 160),
        provenVideos: aiVideoCompactRows(videos, ['name', 'hook', 'context', 'script', 'project', 'status'], 120, 'views'),
        activeProjects: aiVideoCompactRows(projects, ['name', 'notes', 'status'], 80),
        components: aiVideoCompactRows(components, ['name', 'source', 'status', 'needs', 'notes', 'design'], 120),
        ordersAndInventory: {
            orders: aiVideoCompactRows(orders, ['name', 'item', 'status', 'notes'], 80),
            inventory: aiVideoCompactRows(inventory, ['name', 'item', 'status', 'notes'], 80)
        },
        freeNotes: aiVideoCompactRows(notes, ['title', 'name', 'body', 'content', 'text'], 80),
        sponsors: {
            companies: aiVideoCompactRows(sponsors, ['name', 'notes', 'companyStatus'], 50),
            deals: aiVideoCompactRows(sponsorvideos, ['title', 'deliverables', 'notes', 'status'], 50)
        },
        internet,
        jarvis
    };
}

function aiVideoPromptMessages(count, context, runIndex, totalRuns) {
    const schema = {
        ideas: [{
            title: 'short specific title',
            hook: 'spoken/viewer-facing hook line',
            context: 'practical video plan grounded in Business World data',
            promise: 'P: what the video seems to promise',
            early_visual: 'V: first frame / first 3 seconds evidence',
            conceptual: 'C: concept/text implied',
            payoff: 'O: expected gratification / outcome',
            action_process: 'A: action/process being done',
            creator_goal: 'G: creator motivation that feels real',
            why_100m: 'why this has 100M-view mechanics',
            scores: {
                novelty: 0,
                credibility: 0,
                broad_appeal: 0,
                motivation: 0,
                reference_to_gratification: 0,
                overall: 0
            },
            mechanism_notes: {
                novelty: 'sub-scores and nearest-reference avoidance',
                credibility: 'promise-evidence support',
                broad_appeal: 'audience clusters and familiar anchors',
                motivation: 'goal-action-payoff coherence',
                reference_to_gratification: 'unresolved payoff pointer'
            },
            buildability: 'how Tyler/Business World can actually make it',
            risks: ['risk or weakness'],
            differentiation: 'why it is not the same as existing ideas',
            research_queries: ['live/current facts to verify before production']
        }]
    };
    return [
        {
            role: 'system',
            content: [
                'You are Kimi K2.6 inside Business World, acting as an elite short-form video idea generator.',
                'Generate only ideas that could plausibly become 100M-view videos if executed well.',
                'Use Business World local context, Jarvis viral evidence, supplied internet trend context, and broad world knowledge.',
                'You do not have general live web search beyond the supplied context; include research_queries for current facts to check instead of pretending verification happened.',
                'Return ONLY valid JSON. No markdown, no commentary outside JSON.'
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `Generate exactly ${count} AI video idea candidate objects for run ${runIndex + 1} of ${totalRuns}.`,
                'Important: keep the batch small and critically validate every idea. If an idea is not strong enough, replace it with a stronger one before returning JSON.',
                'Do not duplicate or closely paraphrase any existing idea, AI candidate, or completed video in the context.',
                'Favor ideas with broad familiar anchors, unusual but coherent combinations, immediate visual proof, real creator motivation, and a clear unresolved payoff.',
                '',
                'Quantified formula to apply:',
                AI_VIDEO_IDEA_FORMULA,
                '',
                'Business World and Jarvis context:',
                JSON.stringify(context, null, 2),
                '',
                'Output schema:',
                JSON.stringify(schema, null, 2)
            ].join('\n')
        }
    ];
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Never cache app code, the index page, or API data — stale cached assets/data were showing old
    // content after edits. Media routes set their own long Cache-Control below, which overrides this.
    if (!/\.(png|jpe?g|gif|webp|mp4|webm|mov|woff2?|ttf|ico)$/i.test(pathname)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }

    // --- CORS headers for all API routes ---
    if (pathname.startsWith('/api/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-QRD-Type, X-QRD-Ext');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }

    // =========================================
    // AUTH: public Supabase config for the login screen
    // =========================================
    if (pathname === '/api/auth/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: auth.SUPABASE_URL, anonKey: auth.SUPABASE_ANON_KEY }));
        return;
    }
    // AUTH: who am I — verifies token, returns the account + resolved permissions
    // (which buildings / HUD this person can see). Auto-creates a pending account.
    if (pathname === '/api/me' && req.method === 'GET') {
        const acct = await auth.accountForRequest(req, url);
        if (!acct) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not signed in' })); return; }
        const perms = await auth.permsForAccount(acct);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: acct.id, email: acct.email, name: acct.name, displayName: acct.displayName || '', color: acct.color || '', role: acct.role, perms }));
        return;
    }
    // Self-service: a signed-in user updates their OWN display name + character color.
    if (pathname === '/api/me' && req.method === 'PATCH') {
        const acct = await auth.accountForRequest(req, url);
        if (!acct) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not signed in' })); return; }
        const body = await readBody(req);
        const patch = {};
        if (typeof body.displayName === 'string') patch.displayName = body.displayName.trim().slice(0, 40);
        if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) patch.color = body.color.toLowerCase();
        const updated = Object.keys(patch).length ? await dataStore.update('accounts', acct.id, patch) : acct;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: updated.id, email: updated.email, name: updated.name, displayName: updated.displayName || '', color: updated.color || '' }));
        return;
    }
    // AUTH: owner-only profile management (named permission templates)
    if (pathname === '/api/profiles' || /^\/api\/profiles\/[^/]+$/.test(pathname)) {
        const acct = await auth.accountForRequest(req, url);
        if (!acct) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sign in required' })); return; }
        if (acct.role !== 'owner') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Owner only' })); return; }
        if (pathname === '/api/profiles' && req.method === 'GET') {
            const list = await dataStore.getAll('profiles');
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(list));
            return;
        }
        if (pathname === '/api/profiles' && req.method === 'POST') {
            const body = await readBody(req);
            const rec = await dataStore.create('profiles', {
                name: (body.name || 'Untitled profile').trim(),
                buildings: Array.isArray(body.buildings) ? body.buildings : [],
                hud: body.hud || {}, features: body.features || {}
            });
            res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(rec));
            return;
        }
        const pm = pathname.match(/^\/api\/profiles\/([^/]+)$/);
        if (pm && req.method === 'PATCH') {
            const body = await readBody(req);
            const patch = {};
            if (body.name != null) patch.name = String(body.name).trim();
            if (Array.isArray(body.buildings)) patch.buildings = body.buildings;
            if (body.hud) patch.hud = body.hud;
            if (body.features) patch.features = body.features;
            const updated = await dataStore.update('profiles', pm[1], patch);
            if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Profile not found' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(updated));
            return;
        }
        if (pm && req.method === 'DELETE') {
            // un-assign this profile from any accounts (→ pending) before deleting
            const accts = await dataStore.getAll('accounts');
            for (const a of accts) { if (a.role === pm[1]) await dataStore.update('accounts', a.id, { role: 'pending' }); }
            await dataStore.remove('profiles', pm[1]);
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    // AUTH: owner-only account management (list signups, grant roles)
    if (pathname === '/api/accounts' || /^\/api\/accounts\/[^/]+$/.test(pathname)) {
        const acct = await auth.accountForRequest(req, url);
        if (!acct) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sign in required' })); return; }
        if (acct.role !== 'owner') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Owner only' })); return; }
        if (pathname === '/api/accounts' && req.method === 'GET') {
            const list = await dataStore.getAll('accounts');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(list.map(a => ({ id: a.id, email: a.email, name: a.name, displayName: a.displayName || '', color: a.color || '', role: a.role, createdAt: a.createdAt }))));
            return;
        }
        const m = pathname.match(/^\/api\/accounts\/([^/]+)$/);
        if (m && req.method === 'PATCH') {
            const id = m[1];
            const body = await readBody(req);
            const role = body && body.role;
            // role is 'owner', 'pending', or an existing profile id
            const validProfile = role && role !== 'owner' && role !== 'pending'
                ? (await dataStore.getAll('profiles')).some(p => p.id === role) : true;
            if (!role || !validProfile) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid role/profile' })); return; }
            if (id === acct.id && role !== 'owner') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: "You can't remove your own owner access." })); return; }
            const updated = await dataStore.update('accounts', id, { role });
            if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Account not found' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: updated.id, email: updated.email, name: updated.name, role: updated.role }));
            return;
        }
        if (m && req.method === 'DELETE') {
            const id = m[1];
            if (id === acct.id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: "You can't delete your own account." })); return; }
            await dataStore.remove('accounts', id);
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    // =========================================
    // AUTH GATE — everything below is access-controlled by role.
    // Public paths (static page/assets, /api/me, shares, /api/v1) pass through.
    // =========================================
    {
        const decision = await auth.gate(req, url);
        if (!decision.allow) {
            res.writeHead(decision.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(decision.body));
            return;
        }
        req._account = decision.account;
    }

    // =========================================
    // API: QRD predictive playground — upload a reel, get swipe-away/dud risk
    // (reliable, AUC 0.84) + a weak retention ranking estimate. Runs the
    // reproducible extracted-only model (librosa/opencv/whisper, no LLM).
    // Raw binary body; metadata in X-QRD-Type (video|audio) / X-QRD-Ext headers.
    // =========================================
    if (pathname === '/api/qrd/predict' && req.method === 'POST') {
        const type = (req.headers['x-qrd-type'] === 'audio') ? 'audio' : 'video';
        const ext = (req.headers['x-qrd-ext'] || (type === 'audio' ? 'wav' : 'mp4')).replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
        const chunks = [];
        let size = 0;
        const MAX = 200 * 1024 * 1024; // 200 MB cap
        req.on('data', c => { size += c.length; if (size > MAX) { req.destroy(); } chunks.push(c); });
        req.on('end', () => {
            if (size === 0 || size > MAX) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'empty or too-large upload (max 200MB)' })); return; }
            const os = require('os');
            const tmp = path.join(os.tmpdir(), `qrd_upload_${Date.now()}_${Math.round(Math.random() * 1e6)}.${ext}`);
            try { fs.writeFileSync(tmp, Buffer.concat(chunks)); }
            catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'write failed: ' + e.message })); return; }
            const script = path.join(__dirname, 'buildings', 'jarvis', 'qrd', 'extract_one.py');
            const py = spawn('python3', [script, '--file', tmp, '--type', type], { env: { ...process.env } });
            let out = '', err = '';
            py.stdout.on('data', d => out += d);
            py.stderr.on('data', d => err += d);
            const timer = setTimeout(() => { try { py.kill('SIGKILL'); } catch (e) {} }, 240000);
            py.on('close', () => {
                clearTimeout(timer);
                try { fs.unlinkSync(tmp); } catch (e) {}
                const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
                if (!line) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'extraction produced no result', stderr: err.slice(-600) })); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(line);
            });
            py.on('error', e => { clearTimeout(timer); try { fs.unlinkSync(tmp); } catch (_) {} res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'spawn failed: ' + e.message })); });
        });
        req.on('error', () => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'upload stream error' })); });
        return;
    }

    // RAW upload — embed an uploaded video's first-5s hook (visual/text/together) and
    // locate it in the existing map by nearest neighbours. Raw binary body; ext in X-Raw-Ext.
    if (pathname === '/api/raw/embed-upload' && req.method === 'POST') {
        const ext = (req.headers['x-raw-ext'] || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
        const title = (req.headers['x-raw-title'] || 'My upload').toString().slice(0, 80);
        const chunks = []; let size = 0; const MAX = 200 * 1024 * 1024;
        req.on('data', c => { size += c.length; if (size > MAX) req.destroy(); chunks.push(c); });
        req.on('end', () => {
            if (size === 0 || size > MAX) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'empty or too-large upload (max 200MB)' })); return; }
            const os = require('os');
            const tmp = path.join(os.tmpdir(), `rawup_${Date.now()}_${Math.round(Math.random() * 1e6)}.${ext}`);
            try { fs.writeFileSync(tmp, Buffer.concat(chunks)); }
            catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'write failed: ' + e.message })); return; }
            const script = path.join(__dirname, 'raw_upload.py');
            const py = spawn(RAW_PYTHON, [script, '--file', tmp, '--title', title], { env: RAW_PY_ENV });
            let out = '', err = '';
            py.stdout.on('data', d => out += d); py.stderr.on('data', d => err += d);
            const timer = setTimeout(() => { try { py.kill('SIGKILL'); } catch (e) {} }, 240000);
            py.on('close', () => {
                clearTimeout(timer); try { fs.unlinkSync(tmp); } catch (e) {}
                const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
                if (!line) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'embedding produced no result — ' + (err.trim().split('\n').pop() || 'no output').slice(-160), stderr: err.slice(-600) })); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(line);
            });
            py.on('error', e => { clearTimeout(timer); try { fs.unlinkSync(tmp); } catch (_) {} res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'spawn failed: ' + e.message })); });
        });
        req.on('error', () => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'upload stream error' })); });
        return;
    }

    // Quant 2 (pure) — score a new hook from raw pixels/audio (DINOv2+VideoMAE+wav2vec2+DSP, no LLM)
    if (pathname === '/api/quant2/predict' && req.method === 'POST') {
        const chunks = []; let size = 0; const MAX = 200 * 1024 * 1024;
        req.on('data', c => { size += c.length; if (size > MAX) req.destroy(); chunks.push(c); });
        req.on('end', () => {
            if (size === 0 || size > MAX) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'empty or too-large upload (max 200MB)' })); return; }
            const os = require('os');
            const tmp = path.join(os.tmpdir(), `q2_${Date.now()}_${Math.round(Math.random() * 1e6)}.mp4`);
            try { fs.writeFileSync(tmp, Buffer.concat(chunks)); }
            catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'write failed: ' + e.message })); return; }
            const script = path.join(__dirname, 'buildings', 'jarvis', 'quant2', 'predict_pure.py');
            const py = spawn('python3', [script, '--file', tmp], { env: { ...process.env } });
            let out = '', err = '';
            py.stdout.on('data', d => out += d); py.stderr.on('data', d => err += d);
            const timer = setTimeout(() => { try { py.kill('SIGKILL'); } catch (e) {} }, 300000);
            py.on('close', () => {
                clearTimeout(timer); try { fs.unlinkSync(tmp); } catch (e) {}
                const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
                if (!line) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'prediction produced no result', stderr: err.slice(-600) })); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(line);
            });
            py.on('error', e => { clearTimeout(timer); try { fs.unlinkSync(tmp); } catch (_) {} res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'spawn failed: ' + e.message })); });
        });
        req.on('error', () => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'upload stream error' })); });
        return;
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
        // Function-calling pass-through (used by the Storage agent)
        if (body.tools) payload.tools = body.tools;
        if (body.tool_choice) payload.tool_choice = body.tool_choice;
        if (body.parallel_tool_calls !== undefined) payload.parallel_tool_calls = body.parallel_tool_calls;
        if (body.response_format) payload.response_format = body.response_format;

        await proxyFetch(res, 'https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return;
    }

    // =========================================
    // API: top data-backed principles for hook writing (from Jarvis bridge analysis)
    if (pathname === '/api/workshop/hook-principles' && req.method === 'GET') {
        let principles = [];
        try {
            const bp = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'buildings/jarvis/bridge_top_principles.json'), 'utf8'));
            principles = (bp.top || []).slice(0, 15)
                .filter(p => p && p.via_indicator)
                .map(p => ({ signal: p.via_indicator, outcome: p.to_outcome, strength: typeof p.chain_strength === 'number' ? p.chain_strength : null }));
        } catch (e) { /* sparse/missing — return empty */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ principles }));
        return;
    }

    // Compact, data-grounded "hook intelligence pack" distilled from the Jarvis
    // analytics (swipe/retention findings, design rules, word & visual guidance,
    // principles, exemplar videos). A few KB — safe to put in a prompt.
    if (pathname === '/api/workshop/hook-intel' && req.method === 'GET') {
        let pack = {};
        try { pack = require('./buildings/jarvis/hook-intel').build(); }
        catch (e) { pack = { error: 'hook-intel unavailable' }; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pack));
        return;
    }

    // Retrieval: the REAL opening hooks (line + visual + views) of the past
    // videos most relevant to this video's topic. POST { query, limit }.
    if (pathname === '/api/workshop/hook-examples' && req.method === 'POST') {
        let examples = [];
        try {
            const body = await readBody(req);
            examples = require('./buildings/jarvis/hook-intel').examples(body.query || '', body.limit || 12);
        } catch (e) { examples = []; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ examples }));
        return;
    }

    // The HOOK REASONING ENGINE — STREAMS its trace (search → voice → mechanisms
    // → draft → validate → final) as Server-Sent Events so the UI can visualize
    // what it's doing live, then the final hooks.
    if (pathname === '/api/workshop/hook-engine' && req.method === 'POST') {
        const body = await readBody(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        const emit = (ev) => { try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (e) {} };
        try {
            const memory = await loadHookMemory();
            const result = await require('./buildings/jarvis/hook-engine').run(
                { title: body.title, context: body.context, script: body.script, existingHooks: body.existingHooks || [] },
                hookLlmJson, memory, emit
            );
            emit({ stage: 'result', status: 'done', result });
        } catch (e) {
            emit({ stage: 'error', status: 'error', error: e.message });
        }
        res.end();
        return;
    }

    // Feedback → memory: the user kept this hook. Store it as a win the engine
    // emulates next time (and distil a one-line principle from it).
    if (pathname === '/api/workshop/hook-feedback' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            await recordHookWin({ line: body.line || '', visual: body.visual || '', note: body.note || '' });
        } catch (e) { /* best-effort */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // API: Kimi K2.6 Chat (Fireworks, OpenAI-compatible)  /api/kimi/chat
    // Same shape as /api/openai/chat. Needs FIREWORKS_API_KEY.
    // =========================================
    if (pathname === '/api/kimi/chat' && req.method === 'POST') {
        if (!process.env.FIREWORKS_API_KEY) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'FIREWORKS_API_KEY not set' }));
            return;
        }
        const body = await readBody(req);
        const payload = {
            model: body.model || process.env.KIMI_CHAT_MODEL || 'accounts/fireworks/models/kimi-k2p6',
            messages: body.messages,
            temperature: body.temperature ?? 0.2
        };
        if (body.max_tokens) payload.max_tokens = body.max_tokens;
        await proxyFetch(res, 'https://api.fireworks.ai/inference/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`, 'Content-Type': 'application/json' },
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
    // API: Jarvis LLM Signal Scorer
    // =========================================
    if (pathname === '/api/jarvis/score-signal' && req.method === 'POST') {
        const body = await readBody(req);
        const { signal, criteria, sampleSize } = body;
        const openaiKey = process.env.OPENAI_API_KEY;
        if (!openaiKey) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No OpenAI key configured' }));
            return;
        }
        if (!signal || !criteria) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing signal or criteria' }));
            return;
        }

        try {
            const datasetPath = require('path').join(__dirname, 'buildings', 'jarvis', 'signals-dataset.json');
            const dataset = JSON.parse(require('fs').readFileSync(datasetPath, 'utf8'));
            const n = Math.min(sampleSize || 20, 50, dataset.length);

            // Pick N random videos
            const shuffled = [...dataset].sort(() => Math.random() - 0.5);
            const sample = shuffled.slice(0, n);

            // Score each video via GPT-4o-mini
            const scores = [];
            const batchSize = 5;
            for (let i = 0; i < sample.length; i += batchSize) {
                const batch = sample.slice(i, i + batchSize);
                const videoList = batch.map((v, idx) => `${idx + 1}. "${v.name}" (views: ${v.views}, keep: ${v.keep}%, retention: ${v.retention}%)`).join('\n');
                const prompt = `You are scoring YouTube Shorts videos on the signal "${signal}".

Scoring criteria: ${criteria}

Videos to score:
${videoList}

Score each video 1-10 based on the criteria. Use only the video title and metrics to infer the score.

Respond ONLY as valid JSON array: [{"idx": 1, "score": 7}, {"idx": 2, "score": 4}, ...]`;

                const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        messages: [{ role: 'user', content: prompt }],
                        temperature: 0.3
                    })
                });
                const aiData = await aiResp.json();
                const content = aiData.choices?.[0]?.message?.content || '[]';
                const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                const parsed = JSON.parse(jsonStr);
                for (const item of parsed) {
                    const video = batch[item.idx - 1];
                    if (video) {
                        scores.push({ name: video.name, ytId: video.ytId, score: item.score });
                    }
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ scores }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'LLM scoring failed: ' + e.message }));
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
            const vec = (pcData.matches || []).map(m => ({
                id: m.id, name: m.metadata?.name || '', score: m.score,
                status: m.metadata?.status || '', tags: m.metadata?.tags || ''
            }));

            // HYBRID: literal substring matches from LIVE ideas first (always
            // current, catches exact-name items the stale/semantic index misses),
            // then vector matches, deduped.
            const qWords = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean).map(w => w.replace(/s$/, ''));
            const litHit = (text) => { const h = (text || '').toLowerCase(); return qWords.length > 0 && qWords.every(w => h.includes(w)); };
            const allIdeas = await dataStore.getAll('ideas');
            const lit = (allIdeas || []).filter(r => {
                if (statusFilter && statusFilter !== 'all' && (r.status || r.type) !== statusFilter) return false;
                return litHit(`${r.name || ''} ${r.hook || ''} ${r.context || ''} ${r.tags || ''}`);
            }).map(r => ({ id: r.id, name: r.name || '', score: 1, status: r.status || r.type || '', tags: r.tags || '',
                nameHit: litHit(r.name) }))
              .sort((a, b) => (b.nameHit - a.nameHit) || (a.name || '').localeCompare(b.name || ''));

            const seen = new Set(lit.map(r => r.id));
            const results = [...lit];
            vec.forEach(r => { if (!seen.has(r.id)) { seen.add(r.id); results.push(r); } });

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
    // API: AI Video Ideas — Kimi generation + semantic duplicate pruning
    // =========================================
    if (pathname === '/api/ai-video-ideas' && req.method === 'GET') {
        try {
            const ideas = await dataStore.getAll('aiideas');
            const rows = (ideas || [])
                .filter(i => i.status !== 'promoted')
                .sort((a, b) => aiVideoDateValue(b) - aiVideoDateValue(a))
                .map(aiVideoPublicRecord);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ideas: rows }));
        } catch (e) {
            console.error('ai-video-ideas list error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/ai-video-ideas/generate' && req.method === 'POST') {
        try {
            if (!process.env.FIREWORKS_API_KEY) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'FIREWORKS_API_KEY not set; Kimi K2.6 generation is unavailable.' }));
                return;
            }
            if (!process.env.OPENAI_API_KEY) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set; semantic embedding dedupe is unavailable.' }));
                return;
            }
            const body = await readBody(req);
            const runs = aiVideoClampInt(body.runs, 1, 1, AI_VIDEO_IDEA_MAX_RUNS);
            const ideasPerRun = aiVideoClampInt(body.ideasPerRun, AI_VIDEO_IDEA_DEFAULT_BATCH, 1, AI_VIDEO_IDEA_MAX_BATCH);
            if (runs * ideasPerRun > AI_VIDEO_IDEA_MAX_TOTAL) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Too many ideas for one request. Max is ${AI_VIDEO_IDEA_MAX_TOTAL}; try fewer runs or a smaller ideas-per-run value.` }));
                return;
            }

            // Run in the BACKGROUND and report progress via polling. Render's proxy
            // buffers SSE, so a long streamed response shows nothing until it ends;
            // polling a job's accumulating state (steps, live model output, idea
            // cards) is reliable and lets the user watch the whole flow.
            const jobId = require('crypto').randomUUID();
            const requestInput = { runs, ideasPerRun, requestedIdeas: runs * ideasPerRun };
            const abortController = new AbortController();
            const job = {
                id: jobId,
                phase: 'queued',
                events: [],
                output: '',
                cards: [],
                candidateCards: [],
                created: [],
                rejected: [],
                inputs: {
                    request: requestInput,
                    models: {
                        kimi: process.env.KIMI_CHAT_MODEL || 'accounts/fireworks/models/kimi-k2p6',
                        embeddings: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
                        embeddingDimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS) || 512
                    },
                    thresholds: {
                        similarity: AI_VIDEO_IDEA_SIMILARITY_THRESHOLD,
                        dedupeLimit: AI_VIDEO_IDEA_DEDUPE_LIMIT,
                        maxIdeasPerRun: AI_VIDEO_IDEA_MAX_BATCH,
                        maxTotalIdeas: AI_VIDEO_IDEA_MAX_TOTAL,
                        jobTimeoutSeconds: Math.round(AI_VIDEO_IDEA_JOB_TIMEOUT_MS / 1000),
                        idleTimeoutSeconds: Math.round(AI_VIDEO_IDEA_JOB_IDLE_TIMEOUT_MS / 1000)
                    },
                    pipeline: [
                        'acknowledge job',
                        'load Business World/Jarvis/context inputs',
                        'build semantic duplicate reference set',
                        'assemble Kimi prompt',
                        'stream model output',
                        'normalize candidate objects',
                        'embed candidates',
                        'delete near duplicates',
                        'save surviving ideas'
                    ],
                    formulaObjects: ['P promise', 'V early visual evidence', 'C conceptual text', 'O expected outcome', 'A action/process', 'G creator goal']
                },
                outputs: { modelOutputChars: 0, candidateCount: 0, createdCount: 0, rejectedCount: 0 },
                done: false,
                error: null,
                cancelled: false,
                abortController,
                startedAt: Date.now(),
                updatedAt: Date.now()
            };
            aiVideoJobs[jobId] = job;
            for (const k of Object.keys(aiVideoJobs)) { if (Date.now() - aiVideoJobs[k].startedAt > 15 * 60 * 1000) delete aiVideoJobs[k]; }
            aiVideoJobEvent(job, 'queued', `Server accepted AI video idea job ${jobId.slice(0, 8)}.`, { request: requestInput });
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jobId, acceptedAt: new Date(job.startedAt).toISOString(), inputs: job.inputs }));

            const runJob = async () => {
                const watchdog = setInterval(() => {
                    if (job.done) { clearInterval(watchdog); return; }
                    const now = Date.now();
                    const totalMs = now - job.startedAt;
                    const idleMs = now - (job.updatedAt || job.startedAt);
                    if (totalMs > AI_VIDEO_IDEA_JOB_TIMEOUT_MS) {
                        aiVideoJobFail(job, `AI video idea generation timed out after ${Math.round(totalMs / 1000)}s.`, {
                            timeoutMs: AI_VIDEO_IDEA_JOB_TIMEOUT_MS,
                            phase: job.phase
                        });
                        clearInterval(watchdog);
                    } else if (idleMs > AI_VIDEO_IDEA_JOB_IDLE_TIMEOUT_MS) {
                        aiVideoJobFail(job, `AI video idea generation stalled: no server progress for ${Math.round(idleMs / 1000)}s.`, {
                            idleTimeoutMs: AI_VIDEO_IDEA_JOB_IDLE_TIMEOUT_MS,
                            phase: job.phase
                        });
                        clearInterval(watchdog);
                    }
                }, 5000);
                const emit = (ev) => {
                    if (!ev) return;
                    if (job.cancelled) return;
                    if (ev.stage === 'token' && ev.delta) {
                        job.output += ev.delta;
                        if (job.output.length > 90000) job.output = job.output.slice(-90000);
                        job.outputs.modelOutputChars += ev.delta.length;
                        job.updatedAt = Date.now();
                        return;
                    }
                    if (ev.stage === 'candidate' && ev.idea) {
                        job.candidateCards.push(ev.idea);
                        job.outputs.candidateCount = job.candidateCards.length;
                    }
                    if (ev.stage === 'created' && ev.idea) {
                        job.cards.push(ev.idea);
                        job.outputs.createdCount = job.cards.length;
                    }
                    if (ev.msg) aiVideoJobEvent(job, ev.phase || ev.stage || 'step', ev.msg, ev.detail);
                    if (ev.input) job.inputs = { ...job.inputs, ...ev.input };
                    if (ev.output) job.outputs = { ...job.outputs, ...ev.output };
                    if (ev.done) {
                        job.done = true;
                        job.phase = ev.error ? 'error' : 'done';
                        job.updatedAt = Date.now();
                        if (ev.created) job.created = ev.created;
                        if (ev.rejected) job.rejected = ev.rejected;
                        job.outputs.createdCount = job.created.length;
                        job.outputs.rejectedCount = job.rejected.length;
                    }
                };
                try {
                    emit({ phase: 'inputs', msg: 'Reading Business World data: ideas, videos, projects, components, notes, sponsors, Jarvis evidence, and internet trend context.' });
                    let heartbeat = aiVideoJobHeartbeat(job, 'inputs', 'Still reading Business World/R2 inputs');
                    let context;
                    try {
                        context = await aiVideoBuildGenerationContext();
                    } finally {
                        clearInterval(heartbeat);
                    }
                    aiVideoThrowIfStopped(job);
                    const internetSummary = context.internet?.youtubeMostPopular
                        ? { youtubeMostPopularCount: context.internet.youtubeMostPopular.length, topVideos: context.internet.youtubeMostPopular.slice(0, 5).map(v => ({ title: v.title, channel: v.channel, views: v.views })) }
                        : { note: context.internet?.note || 'No live trend provider configured.' };
                    emit({
                        phase: 'inputs',
                        msg: `Inputs loaded: ${context.collectionCounts.ideas} ideas, ${context.collectionCounts.videos} videos, ${context.collectionCounts.aiVideoIdeas} AI candidates, ${context.collectionCounts.projects} projects.`,
                        input: {
                            contextSummary: {
                                generatedAt: context.generatedAt,
                                collectionCounts: context.collectionCounts,
                                internet: internetSummary,
                                jarvisSignals: Object.keys(context.jarvis || {}),
                                sampleExistingIdeas: (context.existingIdeas || []).slice(0, 6).map(i => i.name || i.title || i.hook || i.id).filter(Boolean),
                                sampleExistingAiIdeas: (context.existingAiVideoIdeas || []).slice(0, 6).map(i => i.title || i.hook || i.id).filter(Boolean)
                            }
                        },
                        detail: { collectionCounts: context.collectionCounts, jarvisSignals: Object.keys(context.jarvis || {}) }
                    });

                    emit({ phase: 'dedupe', msg: 'Loading and embedding the semantic reference set for duplicate detection.' });
                    heartbeat = aiVideoJobHeartbeat(job, 'dedupe', 'Still building semantic duplicate reference set');
                    let referenceDocs;
                    try {
                        referenceDocs = await aiVideoBuildReferenceDocs();
                    } finally {
                        clearInterval(heartbeat);
                    }
                    aiVideoThrowIfStopped(job);
                    const byType = referenceDocs.reduce((acc, doc) => { acc[doc.type || 'unknown'] = (acc[doc.type || 'unknown'] || 0) + 1; return acc; }, {});
                    emit({
                        phase: 'dedupe',
                        msg: `Reference set ready: comparing against ${referenceDocs.length} embedded ideas/videos.`,
                        input: { referenceSet: { count: referenceDocs.length, byType } },
                        detail: { referenceCount: referenceDocs.length, byType }
                    });

                    const created = [];
                    const rejected = [];
                    const runReports = [];
                    for (let runIndex = 0; runIndex < runs; runIndex++) {
                        aiVideoThrowIfStopped(job);
                        const messages = aiVideoPromptMessages(ideasPerRun, context, runIndex, runs);
                        const promptChars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
                        emit({
                            phase: 'prompt',
                            msg: `Run ${runIndex + 1}/${runs}: prompt assembled (${promptChars.toLocaleString()} chars) with the P/V/C/O/A/G formula and Business World context.`,
                            input: {
                                prompt: {
                                    run: runIndex + 1,
                                    totalRuns: runs,
                                    system: messages[0]?.content || '',
                                    userPreview: String(messages[1]?.content || '').slice(0, 8000),
                                    userChars: String(messages[1]?.content || '').length,
                                    totalChars: promptChars,
                                    previewNote: 'The UI shows the first 8,000 characters to keep polling fast; this is the actual prompt prefix sent to Kimi.'
                                }
                            },
                            detail: { promptChars, ideasRequested: ideasPerRun }
                        });
                        emit({ phase: 'reasoning', msg: `Run ${runIndex + 1}/${runs}: Kimi K2.6 is reasoning against the viral formula and writing ${ideasPerRun} idea${ideasPerRun === 1 ? '' : 's'}.` });
                        let tokenChars = 0;
                        let firstToken = false;
                        heartbeat = aiVideoJobHeartbeat(job, 'reasoning', `Still waiting on Kimi K2.6 for run ${runIndex + 1}`, { streamedChars: tokenChars });
                        let response;
                        try {
                            response = await aiVideoKimiJson(messages, 18000, (delta) => {
                                tokenChars += delta.length;
                                if (!firstToken) {
                                    firstToken = true;
                                    emit({ phase: 'reasoning', msg: `Kimi stream started for run ${runIndex + 1}.`, detail: { run: runIndex + 1 } });
                                }
                                emit({ stage: 'token', delta });
                            }, abortController.signal);
                        } finally {
                            clearInterval(heartbeat);
                        }
                        aiVideoThrowIfStopped(job);
                        const normalized = (response.ideas || []).slice(0, ideasPerRun).map((idea, idx) => aiVideoNormalizeIdea(idea, runIndex, idx));
                        normalized.forEach(idea => emit({ stage: 'candidate', phase: 'candidate', idea, msg: `Candidate object parsed: ${idea.title}`, detail: { scores: idea.scores, P: idea.promise, V: idea.earlyVisual, O: idea.payoff } }));
                        emit({
                            phase: 'embedding',
                            msg: `Run ${runIndex + 1}: got ${normalized.length} candidate object${normalized.length === 1 ? '' : 's'} — embedding and checking semantic distance.`,
                            output: { candidateCount: job.candidateCards.length },
                            detail: { titles: normalized.map(i => i.title) }
                        });
                        heartbeat = aiVideoJobHeartbeat(job, 'embedding', `Still embedding/deduping run ${runIndex + 1}`);
                        let embeddings;
                        try {
                            embeddings = await aiVideoEmbedTexts(normalized.map(aiVideoIdeaText));
                        } finally {
                            clearInterval(heartbeat);
                        }
                        aiVideoThrowIfStopped(job);
                        let runCreated = 0, runRejected = 0;
                        for (let i = 0; i < normalized.length; i++) {
                            aiVideoThrowIfStopped(job);
                            const idea = normalized[i];
                            const embedding = embeddings[i];
                            const ideaText = aiVideoIdeaText(idea);
                            if (!ideaText.trim() || !idea.title.trim()) { rejected.push({ title: idea.title || '(untitled)', reason: 'empty_idea', run: runIndex + 1 }); runRejected++; emit({ phase: 'rejected', msg: `Rejected: ${idea.title || '(untitled)'} — empty, skipped` }); continue; }
                            const nearest = aiVideoNearest(embedding, referenceDocs);
                            if (nearest.score >= AI_VIDEO_IDEA_SIMILARITY_THRESHOLD) {
                                emit({ phase: 'rejected', msg: `Rejected: ${idea.title} — too similar to "${nearest.title}" (${Math.round(nearest.score * 100)}%).`, detail: { title: idea.title, nearest } });
                                rejected.push({ title: idea.title, reason: 'semantic_duplicate', run: runIndex + 1, similarity: { score: Number(nearest.score.toFixed(4)), matchId: nearest.id, matchType: nearest.type, matchTitle: nearest.title } });
                                runRejected++; continue;
                            }
                            emit({ phase: 'saving', msg: `Saving: ${idea.title} (nearest match ${(nearest.score * 100).toFixed(1)}%, below ${(AI_VIDEO_IDEA_SIMILARITY_THRESHOLD * 100).toFixed(0)}% threshold).`, detail: { title: idea.title, nearest } });
                            const record = await dataStore.create('aiideas', {
                                ...idea, status: 'candidate', source: 'ai-video-ideas',
                                model: process.env.KIMI_CHAT_MODEL || 'accounts/fireworks/models/kimi-k2p6',
                                generatorVersion: 'ai-video-ideas-2026-06-18', formulaName: 'P/V/C/O/A/G viral mechanism graph', embedding,
                                similarity: { maxScore: Number(nearest.score.toFixed(4)), matchId: nearest.id, matchType: nearest.type, matchTitle: nearest.title, threshold: AI_VIDEO_IDEA_SIMILARITY_THRESHOLD },
                                run: { runIndex: runIndex + 1, totalRuns: runs, ideasPerRun }, lastEdited: new Date().toISOString()
                            });
                            await aiVideoUpsertVector('aiideas', record);
                            referenceDocs.push({ id: record.id, type: 'aiidea', title: record.title || record.name || '', text: aiVideoIdeaText(record), embedding });
                            const pub = aiVideoPublicRecord(record);
                            created.push(pub); runCreated++;
                            emit({ stage: 'created', phase: 'created', ok: true, idea: pub, msg: `Created: ${idea.title}`, detail: { similarity: pub.similarity, scores: pub.scores } });
                        }
                        runReports.push({ run: runIndex + 1, created: runCreated, rejected: runRejected });
                        emit({ phase: 'run-complete', msg: `Run ${runIndex + 1} done: ${runCreated} kept, ${runRejected} pruned.`, detail: { runCreated, runRejected } });
                    }
                    emit({ done: true, phase: 'done', msg: `Done: created ${created.length}, pruned ${rejected.length} near-duplicate${rejected.length === 1 ? '' : 's'}.`, created, rejected, output: { createdCount: created.length, rejectedCount: rejected.length, runReports } });
                } catch (e) {
                    console.error('ai-video-ideas generate error:', e);
                    aiVideoJobFail(job, e.message || 'AI video idea generation failed.');
                } finally {
                    clearInterval(watchdog);
                }
            };
            setImmediate(runJob);
        } catch (e) {
            console.error('ai-video-ideas generate setup error:', e);
            if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        }
        return;
    }

    if (pathname === '/api/ai-video-ideas/progress' && req.method === 'GET') {
        const job = aiVideoJobs[url.searchParams.get('job')];
        if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'job not found' })); return; }
        if (!job.done) {
            const now = Date.now();
            const totalMs = now - job.startedAt;
            const idleMs = now - (job.updatedAt || job.startedAt);
            if (totalMs > AI_VIDEO_IDEA_JOB_TIMEOUT_MS) {
                aiVideoJobFail(job, `AI video idea generation timed out after ${Math.round(totalMs / 1000)}s.`, {
                    timeoutMs: AI_VIDEO_IDEA_JOB_TIMEOUT_MS,
                    phase: job.phase
                });
            } else if (idleMs > AI_VIDEO_IDEA_JOB_IDLE_TIMEOUT_MS) {
                aiVideoJobFail(job, `AI video idea generation stalled: no server progress for ${Math.round(idleMs / 1000)}s.`, {
                    idleTimeoutMs: AI_VIDEO_IDEA_JOB_IDLE_TIMEOUT_MS,
                    phase: job.phase
                });
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: job.id,
            phase: job.phase,
            events: job.events,
            output: job.output,
            cards: job.cards,
            candidateCards: job.candidateCards,
            created: job.created,
            rejected: job.rejected,
            inputs: job.inputs,
            outputs: job.outputs,
            done: job.done,
            error: job.error,
            elapsed: Date.now() - job.startedAt,
            updatedAgo: Date.now() - (job.updatedAt || job.startedAt)
        }));
        return;
    }

    // ===== FOOTAGE COVERAGE — does a project's Dropbox footage cover its script? =====
    // Background job (the client polls /progress) so you can leave the page while it
    // pulls + watches every clip. The result is persisted onto the video record, so
    // it's permanent and re-runs only touch new clips (cached by Dropbox hash).
    if (pathname === '/api/footage-coverage/start' && req.method === 'POST') {
        const body = await readBody(req);
        if (!process.env.GEMINI_API_KEY) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not set in .env — needed to watch the footage.' })); return; }
        if (!process.env.FIREWORKS_API_KEY) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'FIREWORKS_API_KEY is not set in .env — needed for the coverage reasoning.' })); return; }
        const video = body && body.videoId ? await dataStore.getById('videos', body.videoId) : null;
        if (!video) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'video not found' })); return; }
        if (!video.project) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'This video has no Channel Project linked, so there is no Dropbox folder to scan.' })); return; }
        if (!(video.script || '').trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'This video has no script yet — nothing to check footage against.' })); return; }

        const jobId = require('crypto').randomUUID();
        const job = { videoId: video.id, events: [], phase: 'starting', total: 0, clips: [], done: false, error: null, result: null, startedAt: Date.now() };
        footageJobs[jobId] = job;
        // NOTE: the actual RESULT is persisted to the video record on R2
        // (footageGaps + footageReport) and the per-clip analyses to the
        // footagecache collection — both kept INDEFINITELY, re-openable any time
        // (postpone filming, come back months later). footageJobs only holds the
        // LIVE progress for the poll loop; it's never the store of record. Bound it
        // by COUNT (not age) so memory can't grow unbounded — this discards only
        // stale progress objects, never a saved result.
        const jobIds = Object.keys(footageJobs);
        if (jobIds.length > 300) {
            jobIds.sort((a, b) => footageJobs[a].startedAt - footageJobs[b].startedAt);
            for (const k of jobIds.slice(0, jobIds.length - 300)) delete footageJobs[k];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));

        (async () => {
            const projectFolder = `${process.env.DROPBOX_ROOT_PATH || ''}/${video.project}`;
            // Token-refreshing Dropbox helpers, scoped to this job.
            const dbxJson = async (endpoint, payload) => {
                const call = async (tok) => fetch('https://api.dropboxapi.com/2/files/' + endpoint, {
                    method: 'POST', headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
                });
                let tok = await dropboxTokenOrThrow(false);
                let r = await call(tok);
                let text = await r.text();
                if ((r.status === 401 || isDropboxInvalidAccessTokenText(text)) && process.env.DROPBOX_REFRESH_TOKEN) {
                    tok = await dropboxTokenOrThrow(true);
                    r = await call(tok);
                    text = await r.text();
                }
                if (!r.ok) throw new Error(`Dropbox ${endpoint} ${r.status}: ${text.slice(0, 200)}`);
                return text ? JSON.parse(text) : {};
            };
            const listFolder = async (folder) => {
                let out = [];
                let data;
                try { data = await dbxJson('list_folder', { path: folder, recursive: true, limit: 2000 }); }
                catch (e) { if (/not_found/i.test(e.message)) return []; throw e; }
                out = out.concat(data.entries || []);
                while (data.has_more) { data = await dbxJson('list_folder/continue', { cursor: data.cursor }); out = out.concat(data.entries || []); }
                return out;
            };
            // ARCHITECTURE: keep Node OUT of the video-byte path entirely. ffmpeg
            // streams the clip straight from a Dropbox temporary-link URL and writes
            // a tiny 360p proxy to disk — the big bytes live only in ffmpeg's own
            // process (which streams http with bounded memory). Node then uploads a
            // few-MB proxy. If memory ever spikes, the OS kills ffmpeg (the big
            // consumer), NOT the server — so a pathological clip fails gracefully
            // instead of taking the whole service down. Scales to thousands of clips.
            const os = require('os');
            // A long video is reduced to a ~30s proxy by sampling frames evenly
            // across its WHOLE length and compressing them into 30s — so a 29-minute
            // clip costs the same as a 30s one (Gemini's size/cost scales with proxy
            // DURATION, not source length).
            const FC_TARGET_SECONDS = 30;
            const FC_OUTPUT_FPS = 1.5;
            const FC_TARGET_FRAMES = Math.round(FC_TARGET_SECONDS * FC_OUTPUT_FPS);   // 45
            const probeDuration = (url) => new Promise((resolve) => {
                let ff, out = '';
                try { ff = require('child_process').spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', url], { stdio: ['ignore', 'pipe', 'ignore'] }); }
                catch (e) { resolve(0); return; }
                ff.stdout.on('data', d => { out += d.toString(); });
                const killer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} resolve(0); }, 60000);
                ff.on('error', () => { clearTimeout(killer); resolve(0); });
                ff.on('exit', () => { clearTimeout(killer); const d = parseFloat(String(out).trim()); resolve(isFinite(d) && d > 0 ? d : 0); });
            });
            const transcodeUrlToProxy = (url, outPath, durationSec) => new Promise((resolve) => {
                const head = ['-y', '-hide_banner', '-loglevel', 'error',
                    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
                let args;
                if (durationSec > FC_TARGET_SECONDS + 2) {
                    // Sample ~45 keyframes across the whole video (keyframe-only decode =
                    // fast even for a 30-min clip), compressed into a ~30s silent proxy.
                    const sampleFps = (FC_TARGET_FRAMES / durationSec).toFixed(6);
                    args = [...head, '-skip_frame', 'nokey', '-threads', '1', '-i', url,
                        '-vf', `fps=${sampleFps},scale=-2:360,setpts=PTS*${sampleFps}/${FC_OUTPUT_FPS}`,
                        '-r', String(FC_OUTPUT_FPS), '-an',
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-threads', '1', '-movflags', '+faststart', outPath];
                } else {
                    // Short clip: keep it whole (low-res, low-fps, with audio).
                    args = [...head, '-threads', '1', '-i', url, '-t', '1200',
                        '-vf', 'scale=-2:360', '-r', String(FC_OUTPUT_FPS),
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-threads', '1',
                        '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', outPath];
                }
                let ff;
                try { ff = require('child_process').spawn('ffmpeg', args, { stdio: 'ignore' }); }
                catch (e) { resolve(false); return; }
                const killer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} resolve(false); }, 300000);
                ff.on('error', () => { clearTimeout(killer); resolve(false); });
                ff.on('exit', (code) => { clearTimeout(killer); resolve(code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0); });
            });
            const analyzeClip = async ({ path: clipPath, name, prompt }) => {
                // A direct download URL ffmpeg can stream (valid ~4h). Node never reads the clip.
                const linkData = await dbxJson('get_temporary_link', { path: clipPath });
                if (!linkData || !linkData.link) throw new Error('Dropbox did not return a temporary link');
                const proxy = path.join(os.tmpdir(), `fc-${require('crypto').randomUUID()}.proxy.mp4`);
                try {
                    const dur = await probeDuration(linkData.link);   // 0 if unknown → treated as short
                    if (!(await transcodeUrlToProxy(linkData.link, proxy, dur))) throw new Error('ffmpeg could not transcode this clip (unreadable or timed out)');
                    const bytes = fs.readFileSync(proxy);   // tiny — a ~30s proxy regardless of source length
                    return await geminiWatch.analyzeBytes(bytes, 'video/mp4', prompt, {
                        displayName: name, genConfig: geminiWatch.FOOTAGE_GEN_CONFIG, timeoutMs: 120000, generateTimeoutMs: 150000
                    });
                } finally {
                    fs.promises.unlink(proxy).catch(() => {});
                }
            };
            // Per-clip cache (by Dropbox content_hash), loaded once. Writes are
            // BATCHED (one R2 flush per ~20 clips, no backups) so caching scales to
            // thousands of clips instead of an O(n^2) flush storm.
            const cacheRecords = await dataStore.getAll('footagecache').catch(() => []);
            const cacheMap = new Map(cacheRecords.map(r => [r.contentHash, r]));
            let pendingCache = [];
            const flushCache = async () => {
                if (!pendingCache.length) return;
                const batch = pendingCache; pendingCache = [];
                try { await dataStore.createMany('footagecache', batch); } catch (e) { console.warn('footagecache flush failed', e.message); }
            };
            const cacheGet = async (hash) => cacheMap.get(hash) || null;
            const cacheSet = async (hash, rec) => { cacheMap.set(hash, rec); pendingCache.push(rec); if (pendingCache.length >= 20) await flushCache(); };

            try {
                const out = await footageCoverage.analyzeProject({
                    video, projectFolder,
                    deps: {
                        listFolder, analyzeClip,
                        kimiJson: (messages, maxTokens) => aiKimiRaw(messages, maxTokens),
                        cacheGet, cacheSet,
                        onEvent: (ev) => {
                            if (!ev) return;
                            if (ev.msg) { job.events.push(ev.msg); try { console.log(`[footage ${jobId.slice(0, 8)}] ${ev.msg}`); } catch (e) {} }
                            if (ev.type === 'phase') job.phase = ev.phase;
                            else if (ev.type === 'list') { job.total = ev.total; job.clips = (ev.clips || []).map(c => ({ name: c.name, status: 'pending' })); job.phase = 'analyzing'; }
                            else if (ev.type === 'clip') { if (job.clips[ev.index]) { job.clips[ev.index].status = ev.status; if (ev.summary) job.clips[ev.index].summary = ev.summary; } }
                        },
                    }
                });
                await flushCache();   // persist any cache records still pending from the last partial batch
                // Persist the gaps as a permanent, individually-deletable suggestion list.
                const fresh = await dataStore.getById('videos', video.id) || video;
                const dismissed = Array.isArray(fresh.footageGapsDismissed) ? fresh.footageGapsDismissed : [];
                const gaps = out.gaps
                    .filter(g => g && g.beat && !dismissed.includes(g.beat))
                    .map(g => ({ id: require('crypto').randomUUID(), beat: g.beat, scriptQuote: g.scriptQuote || '', note: g.note || '', createdAt: new Date().toISOString() }));
                const report = { generatedAt: new Date().toISOString(), clipsAnalyzed: out.clipsAnalyzed, fromCache: out.fromCache, coveredCount: out.covered.length, covered: out.covered, gapsCount: gaps.length, model: out.model, status: 'done' };
                await dataStore.update('videos', video.id, { footageGaps: gaps, footageReport: report });
                job.result = report;
                job.done = true;
            } catch (e) {
                console.error('footage-coverage error:', e);
                await flushCache().catch(() => {});   // don't lose the clips we DID analyze
                job.error = e.message;
                job.done = true;
                try { await dataStore.update('videos', video.id, { footageReport: { generatedAt: new Date().toISOString(), status: 'error', error: e.message } }); } catch (_) {}
            }
        })();
        return;
    }

    if (pathname === '/api/footage-coverage/progress' && req.method === 'GET') {
        const job = footageJobs[url.searchParams.get('job')];
        if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'job not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ phase: job.phase, total: job.total, clips: job.clips, events: job.events, done: job.done, error: job.error, result: job.result, elapsed: Date.now() - job.startedAt }));
        return;
    }

    // ===== INSTAGRAM TRIAL REELS — connect an account + post a final video as a
    // trial reel (shown to non-followers first), for the Split Test stage. =====
    if (pathname === '/api/instagram/status' && req.method === 'GET') {
        try { const s = await instagram.status(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s)); }
        catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ connected: false, error: e.message })); }
        return;
    }
    if (pathname === '/api/instagram/auth-url' && req.method === 'GET') {
        try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ url: instagram.authUrl(url.searchParams.get('state') || '') })); }
        catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    if (pathname === '/api/instagram/callback' && req.method === 'GET') {
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error_description') || url.searchParams.get('error');
        const page = (title, body) => `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${title}</h2><p>${body}</p><script>try{window.opener&&window.opener.postMessage({type:'instagram-connected'},'*')}catch(e){}; setTimeout(()=>window.close(),2500);</script></body>`;
        if (err) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(page('Instagram connection failed', String(err))); return; }
        if (!code) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(page('Instagram connection failed', 'No authorization code returned.')); return; }
        try { const r = await instagram.exchangeCode(code); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('Instagram connected ✓', `Connected as @${r.username || r.igUserId}. You can close this window.`)); }
        catch (e) { res.writeHead(500, { 'Content-Type': 'text/html' }); res.end(page('Instagram connection failed', String(e.message))); }
        return;
    }
    if (pathname === '/api/instagram/disconnect' && req.method === 'POST') {
        try { const s = await instagram.disconnect(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s)); }
        catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    // Post a final video (a Dropbox path) as a Trial Reel. Background job — the
    // client polls /post-progress (publishing can take a minute or two).
    if (pathname === '/api/instagram/post-trial-reel' && req.method === 'POST') {
        const body = await readBody(req);
        const clipPath = body && body.videoPath;
        if (!clipPath) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'videoPath (Dropbox path) is required' })); return; }
        const st = await instagram.status().catch(() => ({ connected: false }));
        if (!st.connected) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: st.configured ? 'Instagram is not connected — connect an account first.' : 'Instagram app is not configured (INSTAGRAM_APP_ID/SECRET missing).' })); return; }

        const jobId = require('crypto').randomUUID();
        const job = { events: [], done: false, error: null, result: null, startedAt: Date.now() };
        igPostJobs[jobId] = job;
        for (const k of Object.keys(igPostJobs)) { if (Date.now() - igPostJobs[k].startedAt > 30 * 60 * 1000) delete igPostJobs[k]; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));

        (async () => {
            const emit = (m) => { job.events.push(m); try { console.log(`[ig-post ${jobId.slice(0, 8)}] ${m}`); } catch (e) {} };
            try {
                // Public URL Instagram can fetch — a Dropbox temporary link (valid ~4h).
                emit('Getting a public link to the video…');
                const tok = await cloud.getDropboxToken();
                const linkRes = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', { method: 'POST', headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: clipPath }) });
                const linkData = await linkRes.json();
                if (!linkData || !linkData.link) throw new Error('Could not get a public Dropbox link for the video.');
                const out = await instagram.postTrialReel({ videoUrl: linkData.link, caption: (body.caption || ''), graduation: body.graduation || 'MANUAL', onStatus: emit });
                job.result = out; job.done = true;
            } catch (e) {
                console.error('ig post error:', e);
                job.error = e.message; job.done = true;
            }
        })();
        return;
    }
    if (pathname === '/api/instagram/post-progress' && req.method === 'GET') {
        const job = igPostJobs[url.searchParams.get('job')];
        if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'job not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: job.events, done: job.done, error: job.error, result: job.result, elapsed: Date.now() - job.startedAt }));
        return;
    }

    // Which footage scan (if any) is still RUNNING for a given video — lets the
    // client reattach the live progress modal after closing it or reloading the
    // page (the scan keeps running server-side regardless).
    if (pathname === '/api/footage-coverage/active' && req.method === 'GET') {
        const vid = url.searchParams.get('videoId');
        let found = null;
        for (const [jid, j] of Object.entries(footageJobs)) {
            if (j.done) continue;
            if (vid && j.videoId !== vid) continue;
            if (!found || j.startedAt > found.startedAt) found = { jobId: jid, videoId: j.videoId, phase: j.phase, total: j.total, startedAt: j.startedAt };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId: found ? found.jobId : null, videoId: found ? found.videoId : null, phase: found ? found.phase : null }));
        return;
    }

    const aiVideoPromoteMatch = pathname.match(/^\/api\/ai-video-ideas\/([^/]+)\/promote$/);
    if (aiVideoPromoteMatch && req.method === 'POST') {
        try {
            const id = decodeURIComponent(aiVideoPromoteMatch[1]);
            const idea = await dataStore.getById('aiideas', id);
            if (!idea) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'AI video idea not found' }));
                return;
            }
            const contextParts = [
                idea.context,
                idea.why100m ? `Why it could hit 100M views: ${idea.why100m}` : '',
                idea.promise ? `P / Promise: ${idea.promise}` : '',
                idea.earlyVisual ? `V / Early visual evidence: ${idea.earlyVisual}` : '',
                idea.conceptual ? `C / Conceptual frame: ${idea.conceptual}` : '',
                idea.payoff ? `O / Payoff: ${idea.payoff}` : '',
                idea.actionProcess ? `A / Action/process: ${idea.actionProcess}` : '',
                idea.creatorGoal ? `G / Creator goal: ${idea.creatorGoal}` : '',
                idea.buildability ? `Buildability: ${idea.buildability}` : '',
                idea.differentiation ? `Differentiation: ${idea.differentiation}` : '',
                idea.risks && idea.risks.length ? `Risks: ${idea.risks.join('; ')}` : '',
                idea.researchQueries && idea.researchQueries.length ? `Research to verify: ${idea.researchQueries.join('; ')}` : ''
            ].filter(Boolean).join('\n\n');
            const promoted = await dataStore.create('ideas', {
                name: idea.title || idea.name || 'AI video idea',
                hook: idea.hook || idea.promise || '',
                context: contextParts,
                script: '',
                project: '',
                type: 'idea',
                source: 'ai-video-ideas',
                sourceAiIdeaId: idea.id,
                aiVideoIdeaScores: idea.scores || {},
                aiVideoIdeaMechanismNotes: idea.mechanismNotes || {},
                lastEdited: new Date().toISOString()
            });
            if (Array.isArray(idea.embedding)) {
                await aiVideoUpsertVector('ideas', {
                    ...promoted,
                    embedding: idea.embedding,
                    status: promoted.status || promoted.type || 'idea',
                    source: 'ai-video-ideas'
                }, promoted.id);
            }
            await dataStore.remove('aiideas', id);
            await aiVideoDeleteVector('aiideas', id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ idea: promoted }));
        } catch (e) {
            console.error('ai-video-ideas promote error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    const aiVideoDeleteMatch = pathname.match(/^\/api\/ai-video-ideas\/([^/]+)$/);
    if (aiVideoDeleteMatch && req.method === 'DELETE') {
        try {
            const id = decodeURIComponent(aiVideoDeleteMatch[1]);
            const ok = await dataStore.remove('aiideas', id);
            if (!ok) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'AI video idea not found' }));
                return;
            }
            await aiVideoDeleteVector('aiideas', id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            console.error('ai-video-ideas delete error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Pipeline — semantic search across videos / projects / components
    // (Pinecone namespace 'pipeline'). Mirrors /api/ideas/* .
    // =========================================
    async function openaiEmbed(inputs) {
        const r = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({ input: inputs, model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small', dimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS) || 512 })
        });
        if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${await r.text()}`);
        return (await r.json()).data;
    }
    if (pathname === '/api/pipeline/index-embeddings' && req.method === 'POST') {
        try {
            const [videos, projects, components] = await Promise.all([
                dataStore.getAll('videos'), dataStore.getAll('projects'), dataStore.getAll('components')
            ]);
            const docs = [];
            (videos || []).forEach(v => docs.push({ id: 'v:' + v.id, type: 'video', name: v.name || '', status: v.status || '',
                text: `${v.name || ''}. Hook: ${v.hook || ''}. ${v.context || ''}. Script: ${(v.script || '').slice(0, 600)}`.trim() }));
            (projects || []).forEach(p => docs.push({ id: 'p:' + p.id, type: 'project', name: p.name || '', status: p.status || '',
                text: `Project: ${p.name || ''}. ${p.notes || ''}`.trim() }));
            (components || []).forEach(c => docs.push({ id: 'c:' + c.id, type: 'component', name: c.name || '', status: c.status || '',
                text: `Component: ${c.name || ''}. ${c.notes || ''} ${(Array.isArray(c.needs) ? c.needs.join(' ') : '')}`.trim() }));
            if (!docs.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ indexed: 0 })); return; }

            const vectors = [];
            for (let i = 0; i < docs.length; i += 50) {
                const batch = docs.slice(i, i + 50);
                const data = await openaiEmbed(batch.map(d => d.text || d.name || ' '));
                batch.forEach((d, j) => vectors.push({ id: d.id, values: data[j].embedding, metadata: { type: d.type, name: d.name, status: d.status } }));
            }
            for (let i = 0; i < vectors.length; i += 100) {
                const up = await fetch(`${process.env.PINECONE_HOST}/vectors/upsert`, {
                    method: 'POST', headers: { 'Api-Key': process.env.PINECONE_API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ vectors: vectors.slice(i, i + 100), namespace: 'pipeline' })
                });
                if (!up.ok) throw new Error(`Pinecone upsert ${up.status}: ${await up.text()}`);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ indexed: vectors.length }));
        } catch (e) {
            console.error('pipeline/index-embeddings error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    if (pathname === '/api/pipeline/search' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { query, topK = 15, typeFilter } = body;
            if (!query) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'query is required' })); return; }
            // HYBRID: literal substring matches from LIVE data first (always
            // current — catches exact-name items even if the vector index is stale
            // or semantically misses them), then vector matches, deduped.
            // word-level, plural-insensitive: every query word (minus trailing s)
            // must appear, so "angry birds" matches "Angry Bird (part 1)" too.
            const qWords = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean).map(w => w.replace(/s$/, ''));
            const litHit = (text) => { const h = (text || '').toLowerCase(); return qWords.length > 0 && qWords.every(w => h.includes(w)); };
            const wantType = (t) => !typeFilter || typeFilter === 'all' || typeFilter === t;
            const lit = [];
            const pushLit = (rows, type) => (rows || []).forEach(r => {
                if (litHit(`${r.name || ''} ${r.hook || ''} ${r.context || ''}`)) {
                    lit.push({ id: r.id, type, name: r.name || '', status: r.status || '', score: 1, literal: true, nameHit: litHit(r.name) });
                }
            });
            const [lv, lp, lc] = await Promise.all([
                wantType('video') ? dataStore.getAll('videos') : [], wantType('project') ? dataStore.getAll('projects') : [], wantType('component') ? dataStore.getAll('components') : []
            ]);
            pushLit(lv, 'video'); pushLit(lp, 'project'); pushLit(lc, 'component');
            lit.sort((a, b) => (b.nameHit - a.nameHit) || (a.name || '').localeCompare(b.name || ''));   // name hits first

            const data = await openaiEmbed([query]);
            const pcBody = { vector: data[0].embedding, topK, namespace: 'pipeline', includeMetadata: true };
            if (typeFilter && typeFilter !== 'all') pcBody.filter = { type: { '$eq': typeFilter } };
            const pcRes = await fetch(`${process.env.PINECONE_HOST}/query`, {
                method: 'POST', headers: { 'Api-Key': process.env.PINECONE_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify(pcBody)
            });
            if (!pcRes.ok) throw new Error(`Pinecone query ${pcRes.status}: ${await pcRes.text()}`);
            const pcData = await pcRes.json();
            const vec = (pcData.matches || []).map(m => ({
                id: (m.id || '').split(':').slice(1).join(':'),
                type: m.metadata?.type || (m.id || '').split(':')[0],
                name: m.metadata?.name || '', status: m.metadata?.status || '', score: m.score
            }));
            const seen = new Set(lit.map(r => r.type + ':' + r.id));
            const results = [...lit];
            vec.forEach(r => { const k = r.type + ':' + r.id; if (!seen.has(k)) { seen.add(k); results.push(r); } });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results }));
        } catch (e) {
            console.error('pipeline/search error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
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
                // Idempotent video creation: never produce two videos for the same source idea.
                const opts = (collection === 'videos' && body && body.sourceIdeaId)
                    ? { dedupeBy: 'sourceIdeaId' } : undefined;
                const record = await dataStore.create(collection, body, opts);
                const status = (opts && record && body.sourceIdeaId === record.sourceIdeaId
                                && record.createdAt && (Date.now() - new Date(record.createdAt).getTime() > 5000))
                    ? 200 : 201;
                res.writeHead(status, { 'Content-Type': 'application/json' });
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
    // API: RTG hand-labels (ground truth) — persisted to R2 so they survive Render's disk
    // =========================================
    // Library dataset stats (the big research video set on R2)
    if (pathname === '/api/library/stats' && req.method === 'GET') {
        try {
            let stats = null;
            try { const buf = await cloud.downloadFromR2('library/stats.json'); if (buf) stats = JSON.parse(buf.toString('utf8')); } catch (e) {}
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify(stats || { stored: 0, discovered: 0, target: 100000 }));
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    if (pathname === '/api/raw/map' && req.method === 'GET') {
        try {
            const ch = (url.searchParams.get('channel') || 'visual').replace(/[^a-z]/g, '');
            let m = null;
            try { const buf = await cloud.downloadFromR2(`raw/${ch}/map.json`); if (buf) m = JSON.parse(buf.toString('utf8')); } catch (e) {}
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify(m || { n: 0, channel: ch }));
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    const rawMon = pathname.match(/^\/api\/raw\/montage\/([\w-]{6,16})$/);
    if (rawMon && req.method === 'GET') {
        try {
            const buf = await cloud.downloadFromR2(`raw/montage/${rawMon[1]}.jpg`);
            if (buf) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); res.end(buf); }
            else { res.writeHead(404); res.end(); }
        } catch (e) { res.writeHead(500); res.end(); }
        return;
    }
    if (pathname === '/api/library/videos' && req.method === 'GET') {
        try {
            const limit = Math.min(parseInt(url.searchParams.get('limit')) || 150, 400);
            let videos = [];
            try {
                const buf = await cloud.downloadFromR2('library/db.json');
                if (buf) {
                    const db = JSON.parse(buf.toString('utf8'));
                    const sort = url.searchParams.get('sort') || 'recent';
                    let arr = Object.values(db.videos || {}).filter(v => v.stored);
                    arr.sort(sort === 'views' ? (a, b) => (b.views || 0) - (a.views || 0)
                        : sort === 'outlier' ? (a, b) => (b.outlier || 0) - (a.outlier || 0)
                        : (a, b) => (b.storedAt || 0) - (a.storedAt || 0));
                    videos = arr.slice(0, limit).map(v => ({ videoId: v.videoId, title: v.title, channel: v.channel, channelUrl: v.channelUrl,
                        views: v.views, subs: v.subs, outlier: v.outlier != null ? v.outlier : (v.subs > 0 ? +((v.views || 0) / v.subs).toFixed(1) : null),
                        publishedAt: v.publishedAt, uploadDate: v.uploadDate, likes: v.likes, comments: v.comments, duration: v.duration, width: v.width, height: v.height }));
                }
            } catch (e) {}
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify({ videos }));
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    const RTG_LABELS_R2_KEY = 'data/rtg-labels.json';
    if (pathname === '/api/rtg/labels' && req.method === 'GET') {
        try {
            let all = {};
            try { const buf = await cloud.downloadFromR2(RTG_LABELS_R2_KEY); if (buf) all = JSON.parse(buf.toString('utf8')); } catch (e) {}
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify(all));
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    if (pathname === '/api/rtg/labels' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { videoId, labels } = body || {};
            if (!videoId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'videoId required' })); return; }
            let all = {};
            try { const buf = await cloud.downloadFromR2(RTG_LABELS_R2_KEY); if (buf) all = JSON.parse(buf.toString('utf8')); } catch (e) {}
            if (labels && (labels.pairs || []).length || (labels && (labels.orphans || []).length)) all[videoId] = labels; else delete all[videoId];
            await cloud.uploadToR2(RTG_LABELS_R2_KEY, Buffer.from(JSON.stringify(all)), 'application/json');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, n: Object.keys(all).length }));
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }

    // =========================================
    // API: AI Chat — chat with Codex
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

            const recent = history.slice(-12).map(m => `${m.role}: ${m.content}`).join('\n');
            const prompt = [
                'You are Codex responding inside the BusinessWorld app chat.',
                'Answer Tyler directly and concisely. Do not edit files, run commands, or claim you changed the repo from this chat turn.',
                'If the user asks for app/code changes, explain the concrete next step and that the coding workspace should handle the edit.',
                '',
                'Recent conversation:',
                recent || '(none)',
                '',
                `Current user message: ${message.trim()}`,
            ].join('\n');

            const appendAssistantReply = async (text, meta = {}) => {
                let latest = [];
                try {
                    const buf = await cloud.downloadFromR2(AI_CHAT_R2_KEY);
                    if (buf) latest = JSON.parse(buf.toString('utf8'));
                } catch (e) { latest = history.slice(); }
                latest.push({
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: text,
                    replyTo: messageId,
                    timestamp: new Date().toISOString(),
                    ...meta,
                });
                await cloud.uploadToR2(AI_CHAT_R2_KEY, Buffer.from(JSON.stringify(latest)), 'application/json');
            };

            const notifyTelegram = async (text) => {
                const botToken = process.env.TELEGRAM_BOT_TOKEN;
                const chatId = process.env.TELEGRAM_TYLER_CHAT_ID;
                if (!botToken || !chatId) return;
                try {
                    const tgResp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: chatId, text: `[BusinessWorld Codex]\n${text}`.slice(0, 4000) })
                    });
                    const tgData = await tgResp.json();
                    if (!tgData.ok) console.warn('Telegram Codex reply error:', tgData.description);
                } catch (tgErr) {
                    console.warn('Telegram Codex reply failed:', tgErr.message);
                }
            };

            if (!codexRunner || typeof codexRunner.runCodex !== 'function') {
                const text = 'Codex chat runner is not available on this server.';
                await appendAssistantReply(text, { source: 'codex', error: true });
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: text, messageId, timestamp }));
                return;
            }

            codexRunner.runCodex(prompt, { timeout: parseInt(process.env.CODEX_CHAT_TIMEOUT_MS || '180000', 10) })
                .then(async result => {
                    await appendAssistantReply(result.text, { source: 'codex' });
                    await notifyTelegram(result.text);
                })
                .catch(async err => {
                    const text = `Codex could not answer from the app: ${err.message}`;
                    console.warn('Codex chat failed:', err.message);
                    await appendAssistantReply(text, { source: 'codex', error: true });
                });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, messageId, timestamp, source: 'codex' }));
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
    // VIDEO LAB — Gemini watches a video; Codex coordinates data-backed advice
    // =========================================
    const VIDEOLAB_SECRET = 'bw-videolab-secret-2026';

    // POST /api/gemini/watch — Gemini "watches" a video and returns structured observations.
    // The video is cached locally (.videolab-cache/) so it can be played back with a
    // timeline and re-analyzed without re-downloading.
    //   JSON  { url }           → download a YouTube/URL video with yt-dlp, then watch
    //   raw   ?name=&type=mp4   → request body is the raw uploaded video bytes
    if (pathname === '/api/gemini/watch' && req.method === 'POST') {
        const crypto = require('crypto');
        const ctype = (req.headers['content-type'] || '');
        const CACHE = path.join(__dirname, '.videolab-cache');
        fs.mkdirSync(CACHE, { recursive: true });
        let videoPath = null, mimeType = 'video/mp4', ytId = null, id = null;
        try {
            if (!process.env.GEMINI_API_KEY) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not set in .env. Add a Gemini API key to enable Video Lab.' }));
                return;
            }
            if (ctype.includes('application/json')) {
                const body = await readBody(req);
                if (!body.url) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Provide { url } or upload raw bytes.' })); return; }
                ytId = videoAnalyzer.parseVideoId ? videoAnalyzer.parseVideoId(body.url) : null;
                id = ytId || crypto.randomUUID();
                videoPath = path.join(CACHE, `${id}.mp4`);
                const ytdlp = (function () { try { require('child_process').execSync('which yt-dlp', { stdio: 'ignore' }); return 'yt-dlp'; } catch (e) {} const hb = (process.env.HOME || '') + '/.local/bin/yt-dlp'; if (fs.existsSync(hb)) return hb; if (fs.existsSync('/opt/homebrew/bin/yt-dlp')) return '/opt/homebrew/bin/yt-dlp'; return 'yt-dlp'; })();
                const cached = ytId && fs.existsSync(videoPath) && fs.statSync(videoPath).size > 10000;
                if (!cached) {
                    const dl = (extra) => new Promise((resolve, reject) => {
                        const args = ['--js-runtimes', 'node', '--remote-components', 'ejs:github', ...extra, '-f', 'mp4[height<=480]/best[height<=480]/best', '--no-playlist', '--force-overwrites', '-o', videoPath, body.url];
                        const proc = spawn(ytdlp, args);
                        let err = '';
                        proc.stderr.on('data', d => { err += d; });
                        proc.on('close', code => code === 0 && fs.existsSync(videoPath) ? resolve() : reject(new Error('yt-dlp failed: ' + err.slice(-300))));
                        proc.on('error', reject);
                    });
                    // Try plain; on YouTube bot-check, fall back to browser cookies.
                    try { await dl([]); }
                    catch (e1) {
                        try { await dl(['--cookies-from-browser', 'chrome']); }
                        catch (e2) { try { await dl(['--cookies-from-browser', 'safari']); } catch (e3) { throw e1; } }
                    }
                }
            } else {
                const name = (url.searchParams.get('name') || 'upload.mp4');
                let ext = 'mp4';
                if (/\.mov$/i.test(name)) { mimeType = 'video/quicktime'; ext = 'mov'; }
                else if (/\.webm$/i.test(name)) { mimeType = 'video/webm'; ext = 'webm'; }
                id = crypto.randomUUID();
                videoPath = path.join(CACHE, `${id}.${ext}`);
                await new Promise((resolve, reject) => {
                    const ws = fs.createWriteStream(videoPath);
                    req.pipe(ws);
                    ws.on('finish', resolve);
                    ws.on('error', reject);
                    req.on('error', reject);
                });
            }

            const { model, observations } = await geminiWatch.watchVideo(videoPath, mimeType, { displayName: ytId || 'videolab' });
            const videoUrl = `/api/videolab/video/${id}`;
            try { await cloud.uploadToR2(`data/videolab/obs-${id}.json`, Buffer.from(JSON.stringify({ ytId, id, model, videoUrl, observations })), 'application/json'); } catch (e) {}

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ytId, videoId: id, videoUrl, model, observations }));
        } catch (e) {
            console.error('gemini/watch error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/videolab/video/:id — stream a cached video (HTTP Range support for seeking).
    const vlVideoMatch = pathname.match(/^\/api\/videolab\/video\/([a-zA-Z0-9_-]+)$/);
    if (vlVideoMatch && req.method === 'GET') {
        try {
            const CACHE = path.join(__dirname, '.videolab-cache');
            const id = vlVideoMatch[1];
            const file = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).find(f => f.startsWith(id + '.')) : null;
            if (!file) { res.writeHead(404); res.end('not found'); return; }
            const full = path.join(CACHE, file);
            const stat = fs.statSync(full);
            const ext = file.split('.').pop().toLowerCase();
            const ctypeMap = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
            const contentType = ctypeMap[ext] || 'video/mp4';
            const range = req.headers.range;
            if (range) {
                const m = range.match(/bytes=(\d+)-(\d*)/);
                const start = parseInt(m[1], 10);
                const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': end - start + 1,
                    'Content-Type': contentType,
                });
                fs.createReadStream(full, { start, end }).pipe(res);
            } else {
                res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
                fs.createReadStream(full).pipe(res);
            }
        } catch (e) { res.writeHead(500); res.end(e.message); }
        return;
    }

    // POST /api/videolab/analyze — run the Codex coordinator (server-side, fully logged).
    if (pathname === '/api/videolab/analyze' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { observations, ytId, videoTitle, videoUrl } = body;
            if (!observations) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'observations required' })); return; }
            const crypto = require('crypto');
            const jobId = crypto.randomUUID();

            // Seed the job so the UI can poll immediately, then run the coordinator in the
            // background (Gemini observations -> data -> Codex 2-pass -> saved transcript).
            await cloud.uploadToR2(`data/videolab/${jobId}.json`, Buffer.from(JSON.stringify({ jobId, ytId: ytId || null, videoTitle: videoTitle || null, videoUrl: videoUrl || null, status: 'running', startedAt: new Date().toISOString(), steps: [] })), 'application/json');
            videolabCoordinator.runCoordinator(jobId, { observations, ytId, videoTitle, videoUrl })
                .then(r => console.log(`VideoLab coordinator ${jobId} → ${r.status}`))
                .catch(e => console.error('VideoLab coordinator error:', e.message));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, jobId }));
        } catch (e) {
            console.error('videolab/analyze error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // DELETE /api/videolab/advice/:jobId — remove a saved analysis + its history entry.
    const vlDelMatch = pathname.match(/^\/api\/videolab\/advice\/([a-zA-Z0-9_-]+)$/);
    if (vlDelMatch && req.method === 'DELETE') {
        try {
            const jobId = vlDelMatch[1];
            await cloud.deleteFromR2(`data/videolab/${jobId}.json`);
            try {
                const buf = await cloud.downloadFromR2('data/videolab/index.json');
                if (buf) {
                    const idx = JSON.parse(buf.toString('utf8')).filter(x => x.jobId !== jobId);
                    await cloud.uploadToR2('data/videolab/index.json', Buffer.from(JSON.stringify(idx)), 'application/json');
                }
            } catch (e) {}
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }

    // GET /api/videolab/history — list past analyses.
    if (pathname === '/api/videolab/history' && req.method === 'GET') {
        try {
            const buf = await cloud.downloadFromR2('data/videolab/index.json');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(buf ? buf.toString('utf8') : '[]');
        } catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); }
        return;
    }

    // POST /api/videolab/advice — coordinator callback with the finished advice JSON.
    if (pathname === '/api/videolab/advice' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (body.secret !== VIDEOLAB_SECRET) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid secret' })); return; }
            if (!body.jobId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'jobId required' })); return; }
            const record = { jobId: body.jobId, status: 'done', advice: body.advice || null, finishedAt: new Date().toISOString() };
            await cloud.uploadToR2(`data/videolab/${body.jobId}.json`, Buffer.from(JSON.stringify(record)), 'application/json');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/videolab/advice/:jobId — poll for the coordinator's result.
    const vlMatch = pathname.match(/^\/api\/videolab\/advice\/([a-zA-Z0-9_-]+)$/);
    if (vlMatch && req.method === 'GET') {
        try {
            const buf = await cloud.downloadFromR2(`data/videolab/${vlMatch[1]}.json`);
            if (!buf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'unknown' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(buf.toString('utf8'));
        } catch (e) {
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
            const lineItems = [{ description: video.title || 'Sponsored Video', amount: video.amount || 0, deliverables: video.deliverables || '', notes: video.notes || '' }];
            const subtotal = lineItems.reduce((s, li) => s + (li.amount || 0), 0);
            const total = subtotal;
            const currency = video.currency || 'CAD';
            const itemRows = makeLineItemRows(lineItems, currency, false);

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
<div class="inv-party"><div class="inv-party-label">From</div><div class="inv-party-name">Centrality LTD</div><div class="inv-party-detail">14 Discovery Ridge Road SW<br>Calgary AB Canada, T3H 4P8<br>@TylerCsatari<br>+1 (403) 519-6945<br>tylerdaviscsatari@gmail.com</div></div>
<div class="inv-party"><div class="inv-party-label">Bill To</div><div class="inv-party-name">${esc(company?.name || 'Company')}</div><div class="inv-party-detail">${companyAddr || ''}</div></div>
</div>
<div class="inv-dates"><div class="inv-date-box"><div class="inv-date-label">Invoice Date</div><div class="inv-date-value">${invoiceDate}</div></div><div class="inv-date-box"><div class="inv-date-label">Due Date</div><div class="inv-date-value">${dueDate}</div></div></div>
<div style="margin-bottom:8px;">
  <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:2px solid #e0e0e0;">
    <span style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px">Description</span>
    <span style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;text-align:right">Amount</span>
  </div>
  ${itemRows}
</div>
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

            // If video already had an invoice, delete the old one (its R2 file + record) so we don't orphan it
            if (video.invoiceId && video.invoiceId !== record.id) {
                try {
                    const old = await dataStore.getById('invoices', video.invoiceId);
                    if (old?.r2Key && cloud.isR2Ready()) await cloud.deleteFromR2(old.r2Key).catch(() => {});
                    await dataStore.remove('invoices', video.invoiceId);
                } catch (e) { /* ok */ }
            }

            // Update video: link invoice and bump status to invoiced if still in progress
            const newStatus = (video.status === 'pending' || video.status === 'active' || video.status === 'delivered') ? 'invoiced' : video.status;
            await dataStore.update('sponsorvideos', video.id, { invoiceId: record.id, status: newStatus });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ invoice: record, html }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Batch invoice — one invoice covering multiple sponsor videos (possibly across companies)
    // =========================================
    if (pathname === '/api/invoices/generate-batch' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const { sponsorVideoIds } = body;
            if (!Array.isArray(sponsorVideoIds) || !sponsorVideoIds.length) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'sponsorVideoIds required' }));
                return;
            }

            const videos = await Promise.all(sponsorVideoIds.map(id => dataStore.getById('sponsorvideos', id)));
            const validVideos = videos.filter(Boolean);
            if (!validVideos.length) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No valid videos found' }));
                return;
            }

            const companyIds = [...new Set(validVideos.map(v => v.companyId).filter(Boolean))];
            const companiesArr = await Promise.all(companyIds.map(id => dataStore.getById('sponsors', id)));
            const companyMap = Object.fromEntries(companiesArr.filter(Boolean).map(c => [c.id, c]));

            const allInvoices = await dataStore.getAll('invoices');
            const maxNum = allInvoices.reduce((m, i) => Math.max(m, i.invoiceNumber || 0), 4);
            const invoiceNumber = maxNum + 1;
            const invoiceDate = new Date().toISOString().split('T')[0];
            const due = new Date(); due.setDate(due.getDate() + 30);
            const dueDate = due.toISOString().split('T')[0];

            const lineItems = validVideos.map(v => ({
                description: v.title || 'Sponsored Video',
                companyName: companyMap[v.companyId]?.name || 'Unknown',
                amount: v.amount || 0,
                currency: v.currency || 'CAD',
                videoId: v.id,
                deliverables: v.deliverables || '',
                notes: v.notes || ''
            }));

            // Primary company = the one with the most line items (tie → first one)
            const counts = {};
            lineItems.forEach(li => { counts[li.companyName] = (counts[li.companyName] || 0) + 1; });
            const primaryCompanyName = Object.entries(counts).sort((a,b) => b[1]-a[1])[0]?.[0] || lineItems[0]?.companyName || 'Client';
            const primaryCompany = companiesArr.find(c => c?.name === primaryCompanyName);
            const companyAddr = (primaryCompany?.address || '').replace(/\n/g, '<br>');

            const subtotal = lineItems.reduce((s, li) => s + (li.amount || 0), 0);
            const currency = validVideos[0]?.currency || 'CAD';

            const html = generateBatchInvoiceHTML({
                invoiceNumber, invoiceDate, dueDate,
                primaryCompanyName, companyAddr,
                lineItems, subtotal, currency
            });

            const r2Key = `invoices/INV-${String(invoiceNumber).padStart(4, '0')}.html`;
            if (cloud.isR2Ready()) {
                await cloud.uploadToR2(r2Key, Buffer.from(html), 'text/html');
            }

            const record = await dataStore.create('invoices', {
                invoiceNumber, invoiceDate, dueDate,
                sponsorVideoIds,
                sponsorVideoId: sponsorVideoIds[0], // backward compat with single-invoice download/pdf paths
                companyId: primaryCompany?.id || null,
                companyName: primaryCompanyName,
                lineItems, subtotal, total: subtotal, currency, r2Key, isBatch: true
            });

            // Link each video to this invoice and mark as invoiced (if still in progress)
            await Promise.all(validVideos.map(v => {
                const newStatus = (v.status === 'pending' || v.status === 'active' || v.status === 'delivered') ? 'invoiced' : v.status;
                return dataStore.update('sponsorvideos', v.id, { invoiceId: record.id, status: newStatus }).catch(() => {});
            }));

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
            doc.text('@TylerCsatari', col1, topY + 62, { width: colW });
            doc.text('+1 (403) 519-6945', col1, topY + 76, { width: colW });
            doc.text('tylerdaviscsatari@gmail.com', col1, topY + 90, { width: colW });

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
                doc.font('Helvetica-Bold').fontSize(11).fillColor(dark);
                doc.text(li.description || '', col1, rowY, { width: 340 });
                doc.text(`${currency} $${(li.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 400, rowY, { width: pageRight - 400, align: 'right' });
                let subY = rowY + 16;
                if (li.deliverables) {
                    doc.font('Helvetica').fontSize(9).fillColor('#555');
                    doc.text(`Deliverables: ${li.deliverables}`, col1, subY, { width: 340 });
                    subY += 13;
                }
                if (li.notes) {
                    doc.font('Helvetica').fontSize(9).fillColor('#555');
                    doc.text(`Notes: ${li.notes}`, col1, subY, { width: 340 });
                    subY += 13;
                }
                const rowH = subY - rowY + 8;
                doc.moveTo(col1, rowY + rowH).lineTo(pageRight, rowY + rowH).lineWidth(0.5).strokeColor('#f0f0f0').stroke();
                rowY += rowH + 4;
                doc.font('Helvetica').fontSize(11).fillColor(dark);
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
        try {
            const withToken = (token) => ({
                ...opts,
                headers: { ...opts.headers, 'Authorization': `Bearer ${token}` }
            });
            let token = await dropboxTokenOrThrow(false);
            let response = await fetch(url, withToken(token));
            let body = await response.text();
            // If Dropbox says the access token is invalid, force-refresh once.
            if ((response.status === 401 || isDropboxInvalidAccessTokenText(body)) && process.env.DROPBOX_REFRESH_TOKEN) {
                token = await dropboxTokenOrThrow(true);
                response = await fetch(url, withToken(token));
                body = await response.text();
            }
            // Forward response
            res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
            res.end(body);
        } catch (e) {
            res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    }

    const DROPBOX_HEADERS = {
        'Content-Type': 'application/json'
    };

    function isDropboxInvalidAccessTokenText(text) {
        return /invalid_access_token/i.test(String(text || ''));
    }

    function dropboxAuthErrorMessage() {
        const st = cloud.getDropboxAuthStatus ? cloud.getDropboxAuthStatus() : {};
        const missing = [];
        if (!st.hasAppKey) missing.push('DROPBOX_APP_KEY');
        if (!st.hasAppSecret) missing.push('DROPBOX_APP_SECRET');
        if (!st.hasRefreshToken) missing.push('DROPBOX_REFRESH_TOKEN');
        if (missing.length) return `Dropbox is missing Render env var(s): ${missing.join(', ')}.`;
        if (st.lastRefresh && st.lastRefresh.ok === false) return `Dropbox token refresh failed: ${st.lastRefresh.error || `HTTP ${st.lastRefresh.status}`}`;
        return 'Dropbox did not return an access token after refresh.';
    }

    async function dropboxTokenOrThrow(forceRefresh) {
        const token = await cloud.getDropboxToken(!!forceRefresh);
        if (!token) {
            const err = new Error(dropboxAuthErrorMessage());
            err.status = 401;
            throw err;
        }
        return token;
    }

    function dropboxRequiredScope(data) {
        return data && data.error && data.error.required_scope ? data.error.required_scope : '';
    }

    function dropboxErrorText(data) {
        return [
            data && data.error_summary,
            data && data.error,
            data && data.error && data.error['.tag']
        ].filter(Boolean).join(' ');
    }

    async function dropboxApiJson(endpoint, body) {
        const call = async (token) => fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
            method: 'POST',
            headers: { ...DROPBOX_HEADERS, 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(body || {})
        });
        let token = await dropboxTokenOrThrow(false);
        let response = await call(token);
        let text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
        if ((response.status === 401 || isDropboxInvalidAccessTokenText(text)) && process.env.DROPBOX_REFRESH_TOKEN) {
            token = await dropboxTokenOrThrow(true);
            response = await call(token);
            text = await response.text();
            try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
        }
        if (!response.ok) {
            const err = new Error(dropboxErrorText(data) || `Dropbox ${endpoint} ${response.status}`);
            err.status = response.status;
            err.data = data;
            err.requiredScope = dropboxRequiredScope(data);
            throw err;
        }
        return data;
    }

    if (pathname === '/api/dropbox/status' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        const out = { ...(cloud.getDropboxAuthStatus ? cloud.getDropboxAuthStatus() : {}) };
        let token = '';
        try {
            token = await dropboxTokenOrThrow(force);
            out.tokenAvailable = !!token;
            const probe = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
                method: 'POST',
                headers: { ...DROPBOX_HEADERS, 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ path: process.env.DROPBOX_ROOT_PATH || '', limit: 1 })
            });
            const text = await probe.text();
            let data = {};
            try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
            out.probe = {
                ok: probe.ok,
                status: probe.status,
                rootPath: process.env.DROPBOX_ROOT_PATH || '',
                error: dropboxErrorText(data),
                entries: Array.isArray(data.entries) ? data.entries.length : undefined
            };
        } catch (e) {
            out.tokenAvailable = false;
            out.error = e.message;
        }
        const finalStatus = cloud.getDropboxAuthStatus ? cloud.getDropboxAuthStatus() : {};
        out.refreshedThisRun = finalStatus.refreshedThisRun;
        out.lastRefresh = finalStatus.lastRefresh;
        out.hasAccessToken = finalStatus.hasAccessToken;
        res.writeHead(out.probe && out.probe.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out, null, 2));
        return;
    }

    // Mint a short-lived Dropbox access token for browser-direct uploads.
    // Dropbox has no presigned upload URLs, so avoiding the Render relay requires
    // the authenticated Workshop client to upload straight to the Dropbox content
    // API with this token. The long-lived refresh token never leaves the server.
    if (pathname === '/api/dropbox/direct_upload_token' && req.method === 'POST') {
        try {
            const token = await dropboxTokenOrThrow(url.searchParams.get('refresh') === '1');
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ accessToken: token, issuedAt: new Date().toISOString() }));
        } catch (e) {
            res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

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

    if (pathname === '/api/dropbox/shared_link' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const folderPath = String(body.path || '').trim();
            if (!folderPath) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing path' })); return; }

            const created = await dropboxApiJson('sharing/create_shared_link_with_settings', {
                path: folderPath,
                settings: { requested_visibility: 'public' }
            });
            if (!created || !created.url) throw new Error('Dropbox did not return a public shared link.');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: folderPath, link: created.url }));
        } catch (e) {
            const data = e.data || {};
            const existing =
                data.metadata ||
                (data.error && data.error.shared_link_already_exists && data.error.shared_link_already_exists.metadata) ||
                (data.error && data.error.shared_link_already_exists);
            const existingLink = existing && existing.url;
            if (existingLink) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ link: existingLink, reused: true }));
                return;
            }
            res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: e.message,
                ...(data.error_summary ? { error_summary: data.error_summary } : {}),
                ...(e.requiredScope ? { required_scope: e.requiredScope } : {})
            }));
        }
        return;
    }

    // Upload a file (raw body) to Dropbox at ?path=... — parent folders are
    // created automatically. Used by the Workshop's voiceover uploads
    // (<project>/vo/<file>). autorename avoids clobbering existing takes.
    if (pathname === '/api/dropbox/upload' && req.method === 'POST') {
        const filePath = url.searchParams.get('path');
        if (!filePath) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing path' })); return; }
        try {
            const uploadOnce = async (token) => {
                const headers = {
                    'Authorization': `Bearer ${token}`,
                    'Dropbox-API-Arg': JSON.stringify({ path: filePath, mode: 'add', autorename: true, mute: true }),
                    'Content-Type': 'application/octet-stream'
                };
                if (req.headers['content-length']) headers['Content-Length'] = req.headers['content-length'];
                return fetch('https://content.dropboxapi.com/2/files/upload', {
                    method: 'POST',
                    headers,
                    body: req,
                    duplex: 'half'
                });
            };
            const token = await dropboxTokenOrThrow(false);
            const response = await uploadOnce(token);
            const text = await response.text();
            if ((response.status === 401 || isDropboxInvalidAccessTokenText(text)) && process.env.DROPBOX_REFRESH_TOKEN) {
                await dropboxTokenOrThrow(true);
            }
            res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
            res.end(text);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ── Chunked, concurrent upload sessions ──────────────────────────────────
    // The single-shot /upload above caps at 150 MB and buffers the whole file in
    // RAM. For anything large the client drives a concurrent upload session:
    //   start → append_v2 (many, in parallel) → finish
    // The server buffers only ONE chunk at a time and refreshes the token on 401.
    // Call a Dropbox content endpoint, refreshing the token once on 401.
    const dropboxContent = async (endpoint, apiArg, body, opts = {}) => {
        const doCall = async (token) => fetch('https://content.dropboxapi.com/2/files/' + endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Dropbox-API-Arg': JSON.stringify(apiArg),
                'Content-Type': 'application/octet-stream',
                ...(opts.contentLength ? { 'Content-Length': String(opts.contentLength) } : {})
            },
            body,
            ...(opts.duplex ? { duplex: 'half' } : {})
        });
        let token = await dropboxTokenOrThrow(false);
        let r = await doCall(token);
        if (r.status === 401 && process.env.DROPBOX_REFRESH_TOKEN) {
            token = await dropboxTokenOrThrow(true);
            if (!opts.noRetry) r = await doCall(token);
        }
        return r;
    };

    if (pathname === '/api/dropbox/session/start' && req.method === 'POST') {
        try {
            const r = await dropboxContent('upload_session/start', { close: false, session_type: { '.tag': 'concurrent' } }, Buffer.alloc(0));
            const text = await r.text();
            res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(text);
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }

    if (pathname === '/api/dropbox/session/append' && req.method === 'POST') {
        const sessionId = url.searchParams.get('session_id');
        const offset = Number(url.searchParams.get('offset'));
        const close = url.searchParams.get('close') === '1';
        if (!sessionId || !Number.isFinite(offset)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing session_id/offset' })); return; }
        try {
            const r = await dropboxContent('upload_session/append_v2',
                { cursor: { session_id: sessionId, offset }, close },
                req,
                { duplex: true, noRetry: true, contentLength: req.headers['content-length'] });
            if (r.ok) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
            const text = await r.text();
            // A retried chunk whose first try already landed → Dropbox reports the
            // correct offset. That means the bytes are already there: treat as OK.
            if (/incorrect_offset/.test(text)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"already":true}'); return; }
            res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(text);
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }

    if (pathname === '/api/dropbox/session/finish' && req.method === 'POST') {
        const sessionId = url.searchParams.get('session_id');
        const offset = Number(url.searchParams.get('offset'));   // bytes appended so far (the tail starts here)
        const filePath = url.searchParams.get('path');
        if (!sessionId || !filePath || !Number.isFinite(offset)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing session_id/offset/path' })); return; }
        try {
            // For a CONCURRENT session every append must be a 4 MB multiple, so the
            // final (non-aligned) tail is sent here in the finish body.
            const r = await dropboxContent('upload_session/finish',
                { cursor: { session_id: sessionId, offset }, commit: { path: filePath, mode: 'add', autorename: true, mute: true } },
                req,
                { duplex: true, noRetry: true, contentLength: req.headers['content-length'] });
            const text = await r.text();
            res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' }); res.end(text);
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }

    if (pathname === '/api/dropbox/get_thumbnail' && req.method === 'GET') {
        const filePath = url.searchParams.get('path');
        if (!filePath) { res.writeHead(400); res.end('Missing path'); return; }
        try {
            const fetchThumbnail = async (token) => fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
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
            let token = await dropboxTokenOrThrow(false);
            let response = await fetchThumbnail(token);
            if (response.status === 401 && process.env.DROPBOX_REFRESH_TOKEN) {
                token = await dropboxTokenOrThrow(true);
                response = await fetchThumbnail(token);
            }
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'thumbnail failed', details: text.slice(0, 500) }));
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

                // Latest write always wins — no stale-writer rejection. The
                // merge below still preserves a position when a client sends
                // 0,0 (building not yet created on that client).
                const BUILDING_NAMES = ['Workshop','Storage','Money Pit','The Pen','Employee Island','Science Center','Jarvis','Library','Finance','The House','Movie Theatre','Gym','Chocolate Bar','Video Lab'];
                const MISSING_DEFAULTS = {
                    'Chocolate Bar': { x: 42, z: 12 },
                    'Gym': { x: 15, z: 30 },
                };

                // Merge buildings: keep R2 position when incoming is 0,0.
                // Union of names so a building added in the client never gets
                // silently dropped by a stale server-side list.
                const existingBuildings = existing.buildings || {};
                const incomingBuildings = incoming.buildings || {};
                const merged = {};

                const allNames = new Set([...BUILDING_NAMES, ...Object.keys(incomingBuildings), ...Object.keys(existingBuildings)]);
                for (const name of allNames) {
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

                // Build final layout: non-building fields from incoming, merged buildings,
                // stamped so the next save can prove it's based on this one
                const finalLayout = { ...incoming, buildings: merged, _savedAt: new Date().toISOString(), _writer: incoming._writer || '' };
                delete finalLayout._basedOn;

                await cloud.uploadToR2('layout/layout.json', Buffer.from(JSON.stringify(finalLayout)), 'application/json');
                console.log('Layout saved to R2 (merged)');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, savedAt: finalLayout._savedAt }));
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

            // --- Video Lab coordinator data: indicators, relevance, patterns, research, brain ---
            const jarvisJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'buildings', 'jarvis', f), 'utf8')); } catch (e) { return null; } };

            if (v1path === '/indicators/relevance') {
                const model = jarvisJson('prediction-model.json');
                let topExperiments = [];
                const derived = jarvisJson('derived_experiments_compact.json');
                if (Array.isArray(derived)) {
                    topExperiments = derived
                        .filter(d => typeof d.r === 'number')
                        .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
                        .slice(0, 120)
                        .map(d => ({ key: d.key, r: +d.r.toFixed(3), target: d.target, kind: d.kind, status: d.status }));
                }
                const findings = jarvisJson('findings-summary.json');
                json({
                    prediction_model: model || null,
                    top_experiments_by_correlation: topExperiments,
                    top_discoveries: findings ? findings.top_discoveries : null,
                    note: 'r = Pearson correlation to log views; prediction_model feature lists are the honest weighted relevance (pre-upload CV≈0.35, full CV≈0.66).'
                });
                return;
            }

            if (v1path === '/indicators') {
                const all = jarvisJson('indicators.json') || [];
                const q = (url.searchParams.get('q') || '').toLowerCase();
                const status = url.searchParams.get('status');
                const layer = url.searchParams.get('layer');
                const target = url.searchParams.get('target');
                let out = all.filter(i =>
                    (!status || i.status === status) &&
                    (!layer || i.layer === layer) &&
                    (!target || i.target === target) &&
                    (!q || JSON.stringify(i).toLowerCase().includes(q))
                );
                json({ total: all.length, matched: out.length, indicators: out.slice(0, 200) });
                return;
            }

            if (v1path === '/retention-patterns') { json(jarvisJson('retention-patterns.json') || { error: 'not found' }); return; }

            if (v1path === '/research') {
                const corpus = jarvisJson('signals-dataset-expanded.json') || [];
                const q = (url.searchParams.get('q') || '').toLowerCase();
                const rows = q ? corpus.filter(r => JSON.stringify(r).toLowerCase().includes(q)) : corpus;
                json({ total: corpus.length, matched: rows.length, sample_fields: corpus[0] ? Object.keys(corpus[0]) : [], rows: rows.slice(0, 60) });
                return;
            }

            const brainMatch = v1path.match(/^\/videos\/([a-zA-Z0-9_-]+)\/brain$/);
            if (brainMatch) {
                const bp = path.join(__dirname, 'buildings', 'jarvis', 'tribe-analysis', `${brainMatch[1]}.json`);
                // Stream the raw JSON (these files are 100MB+) — local first, then R2.
                // Never read+parse the whole file into heap.
                if (fs.existsSync(bp)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    const s = fs.createReadStream(bp); s.on('error', () => { try { res.destroy(); } catch {} }); s.pipe(res);
                    return;
                }
                if (cloud.isR2Ready()) {
                    try {
                        const r2s = await cloud.getR2Stream(`tribe-analysis/${brainMatch[1]}.json`);
                        if (r2s) { res.writeHead(200, { 'Content-Type': 'application/json' }); r2s.on('error', () => { try { res.destroy(); } catch {} }); r2s.pipe(res); return; }
                    } catch {}
                }
                json({ status: 'no_brain_analysis', videoId: brainMatch[1] }, 404);
                return;
            }

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
                const listDropboxFiles = async (token) => fetch('https://api.dropboxapi.com/2/files/list_folder', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: folderPath || '', recursive: false, limit: 2000 })
                });
                let token = await dropboxTokenOrThrow(false);
                let dbxRes = await listDropboxFiles(token);
                let text = await dbxRes.text();
                if ((dbxRes.status === 401 || isDropboxInvalidAccessTokenText(text)) && process.env.DROPBOX_REFRESH_TOKEN) {
                    token = await dropboxTokenOrThrow(true);
                    dbxRes = await listDropboxFiles(token);
                    text = await dbxRes.text();
                }
                let dbxData = {};
                try { dbxData = text ? JSON.parse(text) : {}; } catch (e) { dbxData = { error: text }; }
                json(dbxData, dbxRes.ok ? 200 : dbxRes.status);
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
            // null = key doesn't exist yet (fresh start) — that's a valid empty
            // layout, NOT an error; clients may save. 503 only on real R2 errors.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(buf ? buf.toString('utf8') : '{}');
            return;
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

    // --- Share workshop (assignee / project filter) ---
    if (pathname === '/share/workshop' && req.method === 'GET') {
        try {
            const assigneeParam = url.searchParams.get('assignee') || '';
            const projectParam = url.searchParams.get('project') || '';
            const getAssignedPeople = (v) => {
                const fromList = Array.isArray(v && v.assignedToList) ? v.assignedToList : [];
                const merged = fromList.length ? fromList : ((v && v.assignedTo) ? [v.assignedTo] : []);
                return [...new Set(merged.map(name => String(name || '').trim()).filter(Boolean))];
            };
            let videos = await dataStore.getAll('videos');
            const ideas = await dataStore.getAll('ideas');
            videos = videos.filter(v => v.status === 'pipeline' || v.status === 'workshop' || v.status === 'incubator');
            if (projectParam) videos = videos.filter(v => v.project === projectParam);
            if (assigneeParam === 'none') videos = videos.filter(v => getAssignedPeople(v).length === 0);
            else if (assigneeParam) videos = videos.filter(v => getAssignedPeople(v).includes(assigneeParam));
            const ideasById = {};
            for (const i of ideas) ideasById[i.id] = i;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderShareWorkshopPage(videos, assigneeParam, projectParam, ideasById));
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
                if (video) return video.status || 'pipeline';
                if (idea.type === 'converted') return 'pipeline';
                return idea.type || 'idea';
            };

            // Filter by status
            if (statusParam !== 'all') {
                ideas = ideas.filter(i => {
                    const s = getIdeaStatus(i);
                    if (statusParam === 'posted') return s === 'posted' || s === 'converted';
                    if (statusParam === 'pipeline' || statusParam === 'incubator' || statusParam === 'workshop') {
                        return s === 'pipeline' || s === 'incubator' || s === 'workshop' || s === 'edit';
                    }
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
    // API: Jarvis Loop Status
    // =========================================
    if (pathname === '/api/jarvis/loop-status' && req.method === 'GET') {
        const loops = ['A', 'B', 'C', 'D'];
        const result = {};
        loops.forEach(id => {
            const logPath = `/tmp/autoResearch_loop_${id}.log`;
            try {
                const stat = fs.statSync(logPath);
                const ageMs = Date.now() - stat.mtimeMs;
                result[id] = {
                    lastModified: stat.mtime.toISOString(),
                    ageMinutes: Math.round(ageMs / 60000),
                };
            } catch {
                result[id] = { lastModified: null, ageMinutes: Infinity };
            }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }

    // =========================================
    // API: Jarvis Loop Log
    // =========================================
    if (pathname === '/api/jarvis/loop-log' && req.method === 'GET') {
        const loopId = url.searchParams.get('loop');
        if (!loopId || !['A', 'B', 'C', 'D'].includes(loopId)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid loop parameter. Must be A, B, C, or D.');
            return;
        }
        const logPath = `/tmp/autoResearch_loop_${loopId}.log`;
        try {
            const content = fs.readFileSync(logPath, 'utf8');
            const lines = content.trim().split('\n');
            const last20 = lines.slice(-20).join('\n');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(last20);
        } catch {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('No log file found for loop ' + loopId);
        }
        return;
    }

    // =========================================
    // API: Jarvis Viral Idea Engine
    //   GET /api/jarvis/viral-idea-model — compressed structured brief
    //   GET /api/jarvis/viral-idea-ideas?count=N — N evidence-backed ideas
    // =========================================
    if (pathname === '/api/jarvis/viral-idea-model' && req.method === 'GET') {
        const summaryOnly = url.searchParams.get('summary') === '1';
        const memCached = _viralIdeasCache.get(VIRAL_R2_MEM_KEY_MODEL);
        if (memCached && (Date.now() - memCached.ts) < VIRAL_IDEAS_TTL_MS) {
            const brief = memCached.payload.brief || memCached.payload;
            sendJsonGz(req, res, summaryOnly ? viralIdeaEngine.summarizeBrief(brief) : brief);
            return;
        }
        (async () => {
            try {
                if (cloud.isR2Ready()) {
                    const buf = await cloud.downloadFromR2(VIRAL_MODEL_R2_KEY);
                    if (buf) {
                        const parsed = JSON.parse(buf.toString());
                        _viralIdeasCache.set(VIRAL_R2_MEM_KEY_MODEL, { payload: parsed, ts: Date.now() });
                        const brief = parsed.brief || parsed;
                        sendJsonGz(req, res, summaryOnly ? viralIdeaEngine.summarizeBrief(brief) : brief);
                        return;
                    }
                }
                // Fallback: local gen with timeout (Render will likely fail this,
                // but we try so dev/local still works without R2 priming).
                const payload = await Promise.race([
                    Promise.resolve().then(() => viralIdeaEngine.buildModel({ skipMechanisms: true })),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('local-gen-timeout')), VIRAL_LOCAL_FALLBACK_MS)),
                ]);
                const brief = payload.brief;
                sendJsonGz(req, res, summaryOnly ? viralIdeaEngine.summarizeBrief(brief) : brief);
            } catch (e) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'viral-model unavailable', detail: e.message }));
            }
        })();
        return;
    }
    if (pathname === '/api/jarvis/viral-idea-ideas' && req.method === 'GET') {
        const count = Math.max(1, Math.min(20, parseInt(url.searchParams.get('count') || '5', 10)));
        const force = url.searchParams.get('force') === '1';
        const memCached = _viralIdeasCache.get(VIRAL_R2_MEM_KEY_IDEAS);
        if (!force && memCached && (Date.now() - memCached.ts) < VIRAL_IDEAS_TTL_MS) {
            sendJsonGz(req, res, _shapeIdeasPayload(memCached.payload, count));
            return;
        }
        let pending = _viralIdeasInFlight.get(VIRAL_R2_MEM_KEY_IDEAS);
        if (!pending) {
            pending = (async () => {
                if (cloud.isR2Ready()) {
                    try {
                        const buf = await cloud.downloadFromR2(VIRAL_IDEAS_R2_KEY);
                        if (buf) {
                            const parsed = JSON.parse(buf.toString());
                            _viralIdeasCache.set(VIRAL_R2_MEM_KEY_IDEAS, { payload: parsed, ts: Date.now() });
                            return parsed;
                        }
                    } catch (e) {
                        console.warn('viral-idea-ideas: R2 download failed:', e.message);
                    }
                }
                // Fallback: local gen with timeout. On Render this will time out
                // (and OOM-protect itself); locally it works fine.
                return Promise.race([
                    Promise.resolve().then(() => viralIdeaEngine.buildIdeas(count, { skipMechanisms: true })),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('local-gen-timeout')), VIRAL_LOCAL_FALLBACK_MS)),
                ]);
            })().finally(() => { _viralIdeasInFlight.delete(VIRAL_R2_MEM_KEY_IDEAS); });
            _viralIdeasInFlight.set(VIRAL_R2_MEM_KEY_IDEAS, pending);
        }
        pending.then(payload => sendJsonGz(req, res, _shapeIdeasPayload(payload, count)))
               .catch(e => {
                   res.writeHead(503, { 'Content-Type': 'application/json' });
                   res.end(JSON.stringify({ error: 'viral-ideas unavailable', detail: e.message }));
               });
        return;
    }
    if (pathname === '/api/jarvis/viral-ideas-refresh' && req.method === 'GET') {
        const now = Date.now();
        if (_viralRefreshActive) {
            sendJsonGz(req, res, { status: 'refreshing', started_at_ms_ago: now - _viralRefreshLastRun });
            return;
        }
        const sinceLast = now - _viralRefreshLastRun;
        if (sinceLast < VIRAL_REFRESH_COOLDOWN_MS) {
            sendJsonGz(req, res, { status: 'cooldown', retry_in_ms: VIRAL_REFRESH_COOLDOWN_MS - sinceLast });
            return;
        }
        _viralRefreshActive = true;
        _viralRefreshLastRun = now;
        // Respond immediately, do work in background
        sendJsonGz(req, res, { status: 'refreshing' });
        (async () => {
            try {
                if (!cloud.isR2Ready()) throw new Error('R2 not ready');
                const ideasPayload = viralIdeaEngine.buildIdeas(10, { skipMechanisms: true });
                ideasPayload.generated_at = new Date().toISOString();
                ideasPayload.cached_count = 10;
                await cloud.uploadToR2(VIRAL_IDEAS_R2_KEY, Buffer.from(JSON.stringify(ideasPayload)), 'application/json');
                const { brief } = viralIdeaEngine.buildModel({ skipMechanisms: true });
                const modelPayload = { generated_at: new Date().toISOString(), brief };
                await cloud.uploadToR2(VIRAL_MODEL_R2_KEY, Buffer.from(JSON.stringify(modelPayload)), 'application/json');
                _viralIdeasCache.set(VIRAL_R2_MEM_KEY_IDEAS, { payload: ideasPayload, ts: Date.now() });
                _viralIdeasCache.set(VIRAL_R2_MEM_KEY_MODEL, { payload: modelPayload, ts: Date.now() });
                console.log('viral-ideas-refresh: uploaded to R2');
            } catch (e) {
                console.error('viral-ideas-refresh failed:', e.message);
            } finally {
                _viralRefreshActive = false;
            }
        })();
        return;
    }

    // =========================================
    // API: Jarvis Results TSV
    // =========================================
    if (pathname === '/api/jarvis/results-tsv' && req.method === 'GET') {
        const tsvPath = path.join(__dirname, 'buildings', 'jarvis', 'results.tsv');
        try {
            const content = fs.readFileSync(tsvPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(content);
        } catch {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('');
        }
        return;
    }

    // =========================================
    // API: Jarvis Project Ideas
    //   GET    /api/jarvis/project-ideas       — load { ideas, methodology }
    //   POST   /api/jarvis/project-ideas       — append a new idea
    //   DELETE /api/jarvis/project-ideas/:id   — remove idea by id
    // =========================================
    if (pathname === '/api/jarvis/project-ideas' && req.method === 'GET') {
        const filePath = path.join(__dirname, 'buildings', 'jarvis', 'project-ideas.json');
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(content);
        } catch {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'project-ideas.json not found' }));
        }
        return;
    }
    if (pathname === '/api/jarvis/project-ideas' && req.method === 'POST') {
        const filePath = path.join(__dirname, 'buildings', 'jarvis', 'project-ideas.json');
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const incoming = JSON.parse(body || '{}');
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (!Array.isArray(data.ideas)) data.ideas = [];
                let maxNum = 0;
                for (const it of data.ideas) {
                    const m = /^idea_(\d+)$/.exec(String(it.id || ''));
                    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
                }
                const nextId = `idea_${String(maxNum + 1).padStart(3, '0')}`;
                const novelty = Math.max(1, Math.min(10, parseInt(incoming.novelty_score, 10) || 5));
                const idea = {
                    id: nextId,
                    title: String(incoming.title || '').trim() || '(untitled)',
                    novelty_score: novelty,
                    done_before: !!incoming.done_before,
                    done_before_note: incoming.done_before_note || null,
                    verdict: novelty >= 7 ? 'KEEP' : 'NEEDS_TWIST',
                    improved_title: String(incoming.improved_title || incoming.title || '').trim(),
                    improved_why: String(incoming.improved_why || '').trim(),
                    thumbnail_hook: incoming.thumbnail_hook ? String(incoming.thumbnail_hook).trim() : null,
                    ip_anchor: incoming.ip_anchor ? String(incoming.ip_anchor).trim() : null,
                    category: String(incoming.category || 'gadget').trim(),
                    tags: Array.isArray(incoming.tags) ? incoming.tags.map(String) : [],
                    status: 'idea',
                };
                data.ideas.push(idea);
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, idea }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    if (pathname.startsWith('/api/jarvis/project-ideas/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/api/jarvis/project-ideas/'.length));
        const filePath = path.join(__dirname, 'buildings', 'jarvis', 'project-ideas.json');
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const before = Array.isArray(data.ideas) ? data.ideas.length : 0;
            data.ideas = (data.ideas || []).filter(it => it.id !== id);
            const removed = before - data.ideas.length;
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, removed }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Jarvis Indicator Registry
    // =========================================
    if (pathname === '/api/jarvis/indicators' && req.method === 'GET') {
        const regPath = path.join(__dirname, 'buildings', 'jarvis', 'indicator-registry.json');
        try {
            const content = fs.readFileSync(regPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(content);
        } catch {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'indicator-registry.json not found' }));
        }
        return;
    }

    // =========================================
    // API: Jarvis Hook Model (linear-network scorer)
    // =========================================
    //   POST /api/jarvis/hook-model/score       → predict(hook, wps)
    //   GET  /api/jarvis/hook-model/nodes       → registry of nodes & weights
    //   GET  /api/jarvis/hook-model/node/:key   → indicator detail
    if (pathname === '/api/jarvis/hook-model/score' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const { hook = '', wps } = JSON.parse(body || '{}');
                const hookModel = require('./buildings/jarvis/hook-model/model');
                const out = hookModel.predict(hook, wps);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(out));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (pathname === '/api/jarvis/hook-model/nodes' && req.method === 'GET') {
        try {
            const hookModel = require('./buildings/jarvis/hook-model/model');
            const featurizer = require('./buildings/jarvis/hook-model/featurizer');
            const model = hookModel.loadModel(true);
            const indicators = featurizer.getIndicators();
            const nodes = Object.entries(model.weights).map(([fkey, w]) => {
                const m = fkey.match(/^(.+)_w(\d+)$/);
                const ikey = m ? m[1] : fkey;
                const win = m ? parseInt(m[2], 10) : null;
                const meta = (model.node_meta && model.node_meta[ikey]) || {};
                const ind = indicators[ikey] || {};
                const stat = (model.feature_stats && model.feature_stats[fkey]) || {};
                return {
                    key: fkey,
                    indicator_key: ikey,
                    window: win,
                    weight: w,
                    r_value: meta.r_with_views ?? ind.r ?? null,
                    p_value: meta.p_value ?? ind.p ?? null,
                    n_videos: meta.n_videos ?? ind.n ?? null,
                    description: meta.description || ind.description || '',
                    label: meta.label || ikey,
                    mean: stat.mean,
                    std: stat.std,
                };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                nodes,
                bias: model.bias,
                log10_views_std: model.log10_views_std,
                wps_default: model.wps_default,
                mode: model.mode,
                trained_at: model.trained_at,
                training_n: model.training_n,
                cv_r2: model.cv_r2,
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ───── Hook Model v2 (3-layer: pre → post → views) ─────
    if (pathname === '/api/jarvis/hook-model/score-v2' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const { hook = '', wps } = JSON.parse(body || '{}');
                const hookModelV2 = require('./buildings/jarvis/hook-model/model-v2');
                const out = hookModelV2.predict(hook, wps);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(out));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message, stack: e.stack }));
            }
        });
        return;
    }

    if (pathname === '/api/jarvis/hook-model/nodes-v2' && req.method === 'GET') {
        try {
            const hookModelV2 = require('./buildings/jarvis/hook-model/model-v2');
            const featurizer = require('./buildings/jarvis/hook-model/featurizer');
            const model = hookModelV2.loadModel(true);
            const indReg = featurizer.getIndicators();

            // Enrich pre_nodes with phrase lists + algorithm/category/quantifiable_reason
            // from the featurizer (the featurizer is the source of truth for indicator metadata).
            const preNodes = (model.pre_nodes || []).map(n => {
                const reg = indReg[n.indicator_key] || {};
                return {
                    ...n,
                    wordList: n.wordList || reg.wordList || null,
                    description: n.description || reg.description || '',
                    algorithm: n.algorithm || reg.algorithm || '',
                    category: n.category || reg.category || 'structural',
                    quantifiable_reason: n.quantifiable_reason || reg.quantifiable_reason || '',
                };
            });

            const removedIndicators = model.removed_indicators
                || (featurizer.getRemovedIndicators ? featurizer.getRemovedIndicators() : []);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                version: model.version,
                mode: model.mode,
                bias: model.bias,
                log10_views_std: model.log10_views_std,
                wps_default: model.wps_default,
                training_n: model.training_n,
                trained_at: model.trained_at,
                pre_nodes: preNodes,
                post_nodes: model.post_nodes,
                pre_to_post_weights: model.pre_to_post_weights,
                post_to_views_weights: model.post_to_views_weights,
                feature_stats: model.feature_stats,
                post_stats: model.post_stats,
                removed_indicators: removedIndicators,
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname.startsWith('/api/jarvis/hook-model/node/') && req.method === 'GET') {
        try {
            const key = decodeURIComponent(pathname.slice('/api/jarvis/hook-model/node/'.length));
            const hookModel = require('./buildings/jarvis/hook-model/model');
            const featurizer = require('./buildings/jarvis/hook-model/featurizer');
            const model = hookModel.loadModel();
            const m = key.match(/^(.+)_w(\d+)$/);
            const ikey = m ? m[1] : key;
            const win = m ? parseInt(m[2], 10) : null;
            const meta = (model.node_meta && model.node_meta[ikey]) || {};
            const ind = (featurizer.getIndicators())[ikey] || {};
            const stat = (model.feature_stats && model.feature_stats[key]) || {};

            // Try to enrich with full record from canonical indicators.json
            let canonical = null;
            try {
                const canonicalPath = path.join(__dirname, 'buildings', 'jarvis', 'indicators_compact.json');
                if (fs.existsSync(canonicalPath)) {
                    const all = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
                    const list = Array.isArray(all) ? all : (all.indicators || []);
                    canonical = list.find(i => i.key === ikey) || null;
                }
            } catch { /* non-fatal */ }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                key,
                indicator_key: ikey,
                window: win,
                weight: model.weights[key],
                r_value: meta.r_with_views ?? ind.r ?? null,
                p_value: meta.p_value ?? ind.p ?? null,
                n_videos: meta.n_videos ?? ind.n ?? null,
                ci_low: meta.ci_low,
                ci_high: meta.ci_high,
                description: meta.description || ind.description || '',
                label: meta.label || ikey,
                mean: stat.mean,
                std: stat.std,
                wordList: ind.wordList || null,
                canonical,
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: Jarvis v2 (new unified architecture)
    // =========================================

    // Generic data bridge — used by pipeline HTTP bridge for read/write
    if (pathname.startsWith('/api/jarvis/v2/data/') && (req.method === 'GET' || req.method === 'PUT')) {
        const name = pathname.slice('/api/jarvis/v2/data/'.length);
        if (!jarvisStore.CANONICAL_FILES.includes(name)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown Jarvis data file: ${name}` }));
            return;
        }
        if (req.method === 'GET') {
            try {
                if (url.searchParams.get('fresh') === '1') jarvisStore.invalidateCache(name);
                const data = await jarvisStore.loadJson(name);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }
        // PUT — pipeline writes data back
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                await jarvisStore.saveJson(name, data);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Migration endpoint — seed or overwrite R2 from local files
    if (pathname === '/api/jarvis/v2/migrate-to-r2' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
            try {
                const opts = JSON.parse(body || '{}');
                const mode = opts.overwrite ? 'overwrite' : 'seed';
                const results = await jarvisStore.migrateAll(mode);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ mode, results }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Detail endpoint: single indicator by key (full record with dataset)
    if (pathname.startsWith('/api/jarvis/v2/indicator/') && req.method === 'GET') {
        try {
            const key = decodeURIComponent(pathname.slice('/api/jarvis/v2/indicator/'.length));
            const fp = path.join(__dirname, 'buildings', 'jarvis', 'indicators.json');
            // Streaming find-by-key: stops at the match, peak RAM = one record.
            const found = fs.existsSync(fp)
                ? await streamJson.findOne(fp, (i) => i && i.key === key)
                : ((await jarvisStore.loadJson('indicators', [])).find(i => i.key === key) || null);
            if (!found) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
            const enriched = jarvisVariableCatalog.enrichIndicator(found);
            // Merge extraction-level detail from jarvis-metrics into metric_definition
            const metricDef = jarvisMetrics.getMetricDefinition(key);
            if (metricDef) {
                if (!enriched.metric_definition || enriched.metric_definition.formula === key) {
                    enriched.metric_definition = metricDef;
                }
                // Also enrich the variable_definition if auto/fallback
                const vd = enriched.variable_definition;
                if (vd && (vd.source === 'auto' || vd.source === 'fallback' || vd.formula === key)) {
                    if (metricDef.description && metricDef.description !== key.replace(/_/g, ' ')) vd.description = metricDef.description;
                    if (metricDef.formula && metricDef.formula !== key) vd.formula = metricDef.formula;
                    if (metricDef.data_sources && metricDef.data_sources[0] !== 'analysis') vd.source_fields = metricDef.data_sources;
                    if (metricDef.expected_range && metricDef.expected_range !== 'varies') vd.expected_range = metricDef.expected_range;
                }
            }
            sendJsonGz(req, res, enriched);
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    // Detail endpoint: single derived experiment by key (full record with dataset)
    if (pathname.startsWith('/api/jarvis/v2/derived-experiment/') && req.method === 'GET') {
        try {
            const key = decodeURIComponent(pathname.slice('/api/jarvis/v2/derived-experiment/'.length));
            const fp = path.join(__dirname, 'buildings', 'jarvis', 'derived_experiments.json');
            // Streaming find-by-key: stops at the match, peak RAM = one record.
            const found = fs.existsSync(fp)
                ? await streamJson.findOne(fp, (d) => d && d.key === key)
                : ((await jarvisStore.loadJson('derived_experiments', [])).find(d => d.key === key) || null);
            if (!found) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
            sendJsonGz(req, res, jarvisVariableCatalog.enrichDerivedExperiment(found));
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }

    // Variable catalog: pattern-based provenance layer for any metric key.
    // GET /api/jarvis/v2/variable/<key>        — describe one variable
    // GET /api/jarvis/v2/variables/catalog     — full pattern + family index
    // GET /api/jarvis/v2/variables/known       — describe every key that
    //                                             currently appears in indicators
    //                                             + derived-experiment components
    if (pathname.startsWith('/api/jarvis/v2/variable/') && req.method === 'GET') {
        try {
            const key = decodeURIComponent(pathname.slice('/api/jarvis/v2/variable/'.length));
            const def = jarvisVariableCatalog.describeVariable(key);
            if (!def) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
            // Enrich catalog definition with metric extraction details from jarvis-metrics
            const metricDef = jarvisMetrics.getMetricDefinition(key);
            if (metricDef && (def.source === 'auto' || def.source === 'fallback' || def.formula === key)) {
                if (metricDef.description && metricDef.description !== key.replace(/_/g, ' ')) def.description = metricDef.description;
                if (metricDef.formula && metricDef.formula !== key) def.formula = metricDef.formula;
                if (metricDef.data_sources && metricDef.data_sources.length && metricDef.data_sources[0] !== 'analysis') def.source_fields = metricDef.data_sources;
                if (metricDef.expected_range && metricDef.expected_range !== 'varies') def.expected_range = metricDef.expected_range;
            }
            sendJsonGz(req, res, def);
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    if (pathname === '/api/jarvis/v2/variables/catalog' && req.method === 'GET') {
        try {
            sendJsonGz(req, res, jarvisVariableCatalog.listCatalog());
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    if (pathname === '/api/jarvis/v2/variables/known' && req.method === 'GET') {
        try {
            const [indicators, derived] = await Promise.all([
                jarvisStore.loadCompactJson('indicators', []),
                jarvisStore.loadCompactJson('derived_experiments', []),
            ]);
            const keySet = new Set();
            for (const ind of indicators) {
                if (ind && ind.key) keySet.add(ind.key);
            }
            for (const d of derived) {
                if (d && d.key) keySet.add(d.key);
                if (d && Array.isArray(d.component_keys)) d.component_keys.forEach(k => k && keySet.add(k));
            }
            const variables = Array.from(keySet).sort().map(k => {
                const def = jarvisVariableCatalog.describeVariable(k) || { key: k, source: 'unknown', label: k, description: '' };
                // Enrich with extraction details from jarvis-metrics
                const metricDef = jarvisMetrics.getMetricDefinition(k);
                if (metricDef && (def.source === 'auto' || def.source === 'fallback' || def.source === 'unknown' || def.formula === k)) {
                    if (metricDef.description && metricDef.description !== k.replace(/_/g, ' ')) def.description = metricDef.description;
                    if (metricDef.formula && metricDef.formula !== k) def.formula = metricDef.formula;
                    if (metricDef.data_sources && metricDef.data_sources.length && metricDef.data_sources[0] !== 'analysis') def.source_fields = metricDef.data_sources;
                    if (metricDef.expected_range && metricDef.expected_range !== 'varies') def.expected_range = metricDef.expected_range;
                }
                return def;
            });
            sendJsonGz(req, res, { total: variables.length, variables });
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }
    // One-shot catalog + known-variables aggregator for the UI's Variables
    // section. Returns both the pattern directory and every currently-seen key
    // in a single response so the UI can render a searchable catalog without
    // multiple fetches.
    if (pathname === '/api/jarvis/v2/variables' && req.method === 'GET') {
        try {
            const [indicators, derived] = await Promise.all([
                jarvisStore.loadCompactJson('indicators', []),
                jarvisStore.loadCompactJson('derived_experiments', []),
            ]);
            const keySet = new Set();
            for (const ind of indicators) { if (ind && ind.key) keySet.add(ind.key); }
            for (const d of derived) {
                if (d && d.key) keySet.add(d.key);
                if (d && Array.isArray(d.component_keys)) d.component_keys.forEach(k => k && keySet.add(k));
            }
            const variables = Array.from(keySet).sort().map(k => {
                const def = jarvisVariableCatalog.describeVariable(k);
                return def || { key: k, source: 'unknown', label: k };
            });
            sendJsonGz(req, res, {
                total_known: variables.length,
                catalog: jarvisVariableCatalog.listCatalog(),
                variables,
            });
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        return;
    }

    // Compact indicators (precomputed mirror — never loads full 71MB file)
    // Each item is enriched with a mini variable_definition (~200 bytes) so
    // the UI can render provenance chips without a per-key round-trip.
    // Pass ?nodef=1 to opt out (legacy callers that don't want the extra field).
    if (pathname === '/api/jarvis/v2/indicators' && req.method === 'GET') {
        try {
            const wantDef = url.searchParams.get('nodef') !== '1';
            const enrich = (list) => wantDef ? list.map(jarvisVariableCatalog.enrichIndicatorMini) : list;
            if (url.searchParams.get('full') === '1') {
                if (url.searchParams.get('fresh') === '1') jarvisStore.invalidateCache('indicators');
                const data = await jarvisStore.loadJson('indicators', []);
                sendJsonGz(req, res, enrich(data));
            } else {
                if (url.searchParams.get('fresh') === '1') jarvisStore.invalidateCompactCache('indicators');
                const compact = await jarvisStore.loadCompactJson('indicators', []);
                sendJsonGz(req, res, enrich(compact));
            }
        } catch { sendJsonGz(req, res, '[]'); }
        return;
    }
    if (pathname === '/api/jarvis/v2/graph' && req.method === 'GET') {
        // Memory-efficient path: prefer prebuilt graph_compact.json (~7MB) over graph.json (~237MB).
        // The full file's per-node `connections` arrays are full duplicates of node keys (~100MB
        // of pure redundancy), and derived_edges has 438K rows the UI cannot render anyway.
        // Loading graph.json into Node heap on a 2GB Render dyno OOMs the process.
        try {
            const dir = path.join(__dirname, 'buildings', 'jarvis');
            const compactPath = path.join(dir, 'graph_compact.json');
            const fullPath = path.join(dir, 'graph.json');

            if (fs.existsSync(compactPath)) {
                const buf = fs.readFileSync(compactPath);
                const accepts = (req.headers['accept-encoding'] || '');
                if (accepts.includes('gzip')) {
                    zlib.gzip(buf, (err, compressed) => {
                        if (err) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(buf);
                        } else {
                            res.writeHead(200, {
                                'Content-Type': 'application/json',
                                'Content-Encoding': 'gzip',
                                'Vary': 'Accept-Encoding',
                            });
                            res.end(compressed);
                        }
                    });
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(buf);
                }
                return;
            }

            // Fallback: read full graph.json directly and strip on the fly. Still expensive,
            // but better than nothing if the prebuilt compact file is missing.
            const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            const nodes = (data.nodes || []).map(({ connections, ...rest }) => rest);
            const deLimit = parseInt(url.searchParams.get('de_limit') || '10000', 10);
            const allDe = data.derived_edges || [];
            const derived_edges = deLimit > 0
                ? allDe
                    .filter(de => de.interaction_r != null)
                    .sort((a, b) => Math.abs(b.interaction_r) - Math.abs(a.interaction_r))
                    .slice(0, deLimit)
                : allDe;
            sendJsonGz(req, res, {
                nodes,
                edges: data.edges || [],
                derived_edges,
                _meta: {
                    total_derived_edges: allDe.length,
                    returned_derived_edges: derived_edges.length,
                    connections_stripped: true,
                    fallback: true,
                },
            });
        } catch { sendJsonGz(req, res, { nodes: [], edges: [], derived_edges: [] }); }
        return;
    }

    // =========================================
    // API: Jarvis Knowledge artifacts (overnight build outputs)
    // Direct file reads from buildings/jarvis/<name>.json — no R2 mirror.
    // =========================================
    {
        const KNOWLEDGE_FILES = {
            'mechanisms': 'mechanisms.json',
            'mechanism-components': 'mechanism_components.json',
            'mechanism-observations': 'mechanism_observations.json',
            'components': 'components.json',
            'principles': 'principles.json',
            'principle-gaps': 'principle_gaps.json',
            'bridge-validation': 'bridge_validation.json',
            'bridge-top-principles': 'bridge_top_principles.json',
            'research-questions': 'research_questions.json',
            'research-answers': 'research_answers.json',
            'overnight-status': 'overnight_status.json',
            'findings-summary': 'findings-summary.json',
        };
        if (pathname.startsWith('/api/jarvis/knowledge/')) {
            const name = pathname.slice('/api/jarvis/knowledge/'.length);
            // Overview endpoint — small summary card payload pulled from many files
            if (name === 'overview' && req.method === 'GET') {
                try {
                    const dir = path.join(__dirname, 'buildings', 'jarvis');
                    const safeRead = (f, fallback) => {
                        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
                        catch { return fallback; }
                    };
                    const status = safeRead('overnight_status.json', {});
                    const principles = safeRead('principles.json', { n_principles: 0, principles: [], generated_at: null, ranking: null, thresholds: null });
                    const mechanisms = safeRead('mechanisms.json', { n_mechanisms: 0, generated_at: null, n_videos_pool: null });
                    const components = safeRead('components.json', { n_components: 0, generated_at: null, coverage_pct: null, min_recurrence: null });
                    const bridge = safeRead('bridge_validation.json', { rows: [], n_principles_validated: 0, n_chains_with_both_legs_nonzero: 0, n_videos_in_pool: null, generated_at: null });
                    const bridgeTop = safeRead('bridge_top_principles.json', { top: [], generated_at: null });
                    const gaps = safeRead('principle_gaps.json', { gaps: [], n_gaps: 0 });
                    const answers = safeRead('research_answers.json', { answers: {} });
                    // research_questions.json can be hundreds of MB (it accretes a
                    // recursive `legacy` snapshot every run). Never parse it whole on a
                    // 2GB box — count via bounded streaming when it's large.
                    let researchQuestionsCount = null;  // null = too large to count cheaply
                    try {
                        const rqPath = path.join(dir, 'research_questions.json');
                        if (fs.existsSync(rqPath) && fs.statSync(rqPath).size < 20 * 1024 * 1024) {
                            const q = safeRead('research_questions.json', { questions: [] });
                            researchQuestionsCount = Array.isArray(q.questions) ? q.questions.length : 0;
                        }
                        // else: leave null — don't parse hundreds of MB for a stat card.
                    } catch { researchQuestionsCount = null; }
                    const overview = {
                        overnight: {
                            overall_status: status.overall_status || null,
                            current_phase: status.current_phase || null,
                            started_at: status.started_at || null,
                            finished_at: status.finished_at || null,
                            updated_at: status.updated_at || null,
                            totals: status.totals || {},
                            completed_phases: status.completed_phases || [],
                            failed_phase: status.failed_phase || null,
                            failure_reason: status.failure_reason || null,
                            notes: status.notes || null,
                        },
                        counts: {
                            mechanisms: mechanisms.n_mechanisms || (Array.isArray(mechanisms.mechanisms) ? mechanisms.mechanisms.length : 0),
                            components: components.n_components || (Array.isArray(components.components) ? components.components.length : 0),
                            principles: principles.n_principles || (Array.isArray(principles.principles) ? principles.principles.length : 0),
                            principles_dropped_tautological: principles.n_dropped_tautological || 0,
                            principles_dropped: principles.n_dropped || 0,
                            bridge_rows: Array.isArray(bridge.rows) ? bridge.rows.length : 0,
                            bridge_top: Array.isArray(bridgeTop.top) ? bridgeTop.top.length : 0,
                            bridge_n_chains_both_legs_nonzero: bridge.n_chains_with_both_legs_nonzero || 0,
                            principle_gaps: gaps.n_gaps || (Array.isArray(gaps.gaps) ? gaps.gaps.length : 0),
                            research_questions: researchQuestionsCount,
                            research_answers: Array.isArray(answers.answers)
                                ? answers.answers.length
                                : Object.keys(answers.answers || {}).length,
                            n_videos_pool: mechanisms.n_videos_pool || null,
                        },
                        thresholds: principles.thresholds || null,
                        ranking: principles.ranking || null,
                        generated_at: {
                            principles: principles.generated_at || null,
                            mechanisms: mechanisms.generated_at || null,
                            components: components.generated_at || null,
                            bridge: bridge.generated_at || null,
                            bridge_top: bridgeTop.generated_at || null,
                        },
                    };
                    sendJsonGz(req, res, overview);
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }
            // Single-mechanism detail (full record incl. all sample_evidence)
            if (name.startsWith('mechanism/') && req.method === 'GET') {
                const mechId = decodeURIComponent(name.slice('mechanism/'.length));
                try {
                    const dir = path.join(__dirname, 'buildings', 'jarvis');
                    const mechs = JSON.parse(fs.readFileSync(path.join(dir, 'mechanisms.json'), 'utf8'));
                    const found = (mechs.mechanisms || []).find(m => m.id === mechId);
                    if (!found) { res.writeHead(404); res.end('{}'); return; }
                    // Include component links + observation count if available
                    let componentIds = null;
                    try {
                        const mc = JSON.parse(fs.readFileSync(path.join(dir, 'mechanism_components.json'), 'utf8'));
                        componentIds = (mc.mechanism_components || {})[mechId] || null;
                    } catch {}
                    sendJsonGz(req, res, { mechanism: found, component_ids: componentIds });
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }
            // Single-principle detail
            if (name.startsWith('principle/') && req.method === 'GET') {
                const pid = decodeURIComponent(name.slice('principle/'.length));
                try {
                    const dir = path.join(__dirname, 'buildings', 'jarvis');
                    const principles = JSON.parse(fs.readFileSync(path.join(dir, 'principles.json'), 'utf8'));
                    const found = (principles.principles || []).find(p => p.id === pid);
                    if (!found) { res.writeHead(404); res.end('{}'); return; }
                    let validation = null;
                    try {
                        const bv = JSON.parse(fs.readFileSync(path.join(dir, 'bridge_validation.json'), 'utf8'));
                        validation = (bv.rows || []).find(r => r.principle_id === pid) || null;
                    } catch {}
                    sendJsonGz(req, res, { principle: found, bridge_validation: validation });
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }
            // Generic file passthrough — used for full-list loads. STREAMED from
            // disk through gzip so the server never buffers the whole file (some,
            // like research_questions.json, are hundreds of MB). Peak RAM = chunk.
            if (KNOWLEDGE_FILES[name] && req.method === 'GET') {
                const fp = path.join(__dirname, 'buildings', 'jarvis', KNOWLEDGE_FILES[name]);
                if (!fs.existsSync(fp)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Not found: ${KNOWLEDGE_FILES[name]}` }));
                    return;
                }
                const accepts = (req.headers['accept-encoding'] || '');
                const src = fs.createReadStream(fp);
                src.on('error', () => { try { res.destroy(); } catch {} });
                if (accepts.includes('gzip')) {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
                    src.pipe(zlib.createGzip()).pipe(res);
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    src.pipe(res);
                }
                return;
            }
        }
    }
    if (pathname === '/api/jarvis/v2/tools' && req.method === 'GET') {
        try {
            if (url.searchParams.get('fresh') === '1') jarvisStore.invalidateCache('tools');
            const data = await jarvisStore.loadJson('tools', []);
            sendJsonGz(req, res, data);
        } catch { sendJsonGz(req, res, '[]'); }
        return;
    }
    if (pathname === '/api/jarvis/v2/resolutions' && req.method === 'GET') {
        // Only 79 resolutions, but each carries a multi-MB `indicator_keys` array
        // (~28MB total) the UI never uses. Stream + drop that one field → ~10KB.
        try {
            const fp = path.join(__dirname, 'buildings', 'jarvis', 'resolutions.json');
            if (!fs.existsSync(fp)) { sendJsonGz(req, res, '[]'); return; }
            // One record (r0 "Full Video") carries a ~26MB indicator_keys array. Strip
            // it at the string level BEFORE parsing so it never materializes in heap
            // (parsing it spikes to ~1GB). maxElem raised so the record isn't skipped.
            const items = await streamJson.projectAll(fp, (r) => r, {
                maxElem: 48 * 1024 * 1024,
                transform: (t) => streamJson.stripField(t, 'indicator_keys'),
            });
            sendJsonGz(req, res, items);
        } catch { sendJsonGz(req, res, '[]'); }
        return;
    }
    // Compact derived experiments (precomputed mirror — never loads full file)
    // Each item is enriched with mini variable_definition + per-component
    // mini defs so the UI's experiment detail cards can show provenance
    // without a separate catalog fetch. Pass ?nodef=1 to opt out.
    if (pathname === '/api/jarvis/v2/derived-experiments' && req.method === 'GET') {
        // Bounded-RAM: stream the (huge, ~700K-row) file and keep only the top-N
        // by |r| plus the true total. Never parses the whole file into heap, so a
        // 2GB box survives. Total count goes back in X-Total-Count.
        try {
            const wantDef = url.searchParams.get('nodef') !== '1';
            const enrich = (list) => wantDef ? list.map(jarvisVariableCatalog.enrichDerivedExperimentMini) : list;
            const limit = Math.min(parseInt(url.searchParams.get('limit') || '5000', 10) || 5000, 20000);
            const fp = path.join(__dirname, 'buildings', 'jarvis', 'derived_experiments.json');
            if (!fs.existsSync(fp)) { sendJsonGz(req, res, '[]'); return; }
            const { items, total } = await streamJson.topN(fp, { scoreKey: 'r', n: limit });
            res.setHeader('X-Total-Count', String(total));
            sendJsonGz(req, res, enrich(items));
        } catch { sendJsonGz(req, res, '[]'); }
        return;
    }
    if (pathname === '/api/jarvis/v2/experiments' && req.method === 'GET') {
        try {
            const full = url.searchParams.get('full') === '1';
            const wantDef = url.searchParams.get('nodef') !== '1';
            const enrichAtomic = (list) => wantDef ? list.map(jarvisVariableCatalog.enrichIndicatorMini) : list;
            const enrichDerived = (list) => wantDef ? list.map(jarvisVariableCatalog.enrichDerivedExperimentMini) : list;
            if (full) {
                if (url.searchParams.get('fresh') === '1') {
                    jarvisStore.invalidateCache('experiments_log');
                    jarvisStore.invalidateCache('derived_experiments');
                }
                const [atomic, derived] = await Promise.all([
                    jarvisStore.loadJson('experiments_log', []),
                    jarvisStore.loadJson('derived_experiments', []),
                ]);
                const taggedAtomic = atomic.map(e => e.kind ? e : { ...e, kind: 'atomic' });
                sendJsonGz(req, res, {
                    atomic: enrichAtomic(taggedAtomic),
                    derived: enrichDerived(derived),
                    count: { atomic: taggedAtomic.length, derived: derived.length, total: taggedAtomic.length + derived.length },
                });
            } else {
                if (url.searchParams.get('fresh') === '1') {
                    jarvisStore.invalidateCompactCache('experiments_log');
                    jarvisStore.invalidateCompactCache('derived_experiments');
                }
                const [atomic, derived] = await Promise.all([
                    jarvisStore.loadCompactJson('experiments_log', []),
                    jarvisStore.loadCompactJson('derived_experiments', []),
                ]);
                // derived_experiments_compact.json is still ~85MB (no field projection
                // is applied for this source). Slice to top 5K by |r| so the response
                // payload and Node heap stay under control on the 2GB Render dyno.
                const derivedTopK = parseInt(url.searchParams.get('derived_top') || '5000', 10);
                const derivedTop = Array.isArray(derived)
                    ? derived
                        .filter(e => e && e.r != null)
                        .sort((a, b) => Math.abs(b.r || 0) - Math.abs(a.r || 0))
                        .slice(0, derivedTopK)
                    : [];
                const taggedAtomic = atomic.map(e => e.kind ? e : { ...e, kind: 'atomic' });
                sendJsonGz(req, res, {
                    atomic: enrichAtomic(taggedAtomic),
                    derived: enrichDerived(derivedTop),
                    count: {
                        atomic: taggedAtomic.length,
                        derived: derivedTop.length,
                        derived_total: Array.isArray(derived) ? derived.length : 0,
                        total: taggedAtomic.length + derivedTop.length,
                    },
                });
            }
        } catch (e) {
            sendJsonGz(req, res, { atomic: [], derived: [], count: { atomic: 0, derived: 0, total: 0 } });
        }
        return;
    }
    if (pathname === '/api/jarvis/v2/run-pipeline' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const { n = 5 } = JSON.parse(body || '{}');
                let result;
                if (IS_RENDER) {
                    result = _launchNodeRunner('queue', { n });
                } else {
                    const pipelineArgs = [path.join(__dirname, 'buildings/jarvis/pipeline.py'), '--run', String(n)];
                    result = _launchPipeline('queue', pipelineArgs);
                }
                res.writeHead(result.started ? 200 : 409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...result, n }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // =========================================
    // API: Jarvis Autonomous Run
    // =========================================
    if (pathname === '/api/jarvis/v2/node-auto-run' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const opts = JSON.parse(body || '{}');
                const result = _launchNodeRunner('auto', {
                    maxIterations: parseInt(opts.maxIterations) || 3000,
                    maxMinutes: opts.maxMinutes || null,
                    maxFailures: opts.maxFailures || null,
                    maxNoSignal: opts.maxNoSignal || null,
                    preuploadRatio: opts.preuploadRatio != null ? parseFloat(opts.preuploadRatio) : null,
                });
                res.writeHead(result.started ? 200 : 409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (pathname === '/api/jarvis/v2/auto-run' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const opts = JSON.parse(body || '{}');
                const n = parseInt(opts.n) || 10;
                let result;
                if (IS_RENDER) {
                    // Node-native runner on Render — no Python dependency
                    result = _launchNodeRunner('auto', {
                        maxIterations: n,
                        maxMinutes: opts.maxMinutes || null,
                        maxFailures: opts.maxFailures || null,
                        maxNoSignal: opts.maxNoSignal || null,
                        preuploadRatio: opts.preUploadRatio != null ? parseFloat(opts.preUploadRatio) : null,
                    });
                } else {
                    const pipelineArgs = [path.join(__dirname, 'buildings/jarvis/pipeline.py'), '--auto-run', String(n)];
                    if (opts.maxMinutes) pipelineArgs.push('--max-minutes', String(opts.maxMinutes));
                    if (opts.maxFailures) pipelineArgs.push('--max-failures', String(opts.maxFailures));
                    if (opts.maxNoSignal) pipelineArgs.push('--max-no-signal', String(opts.maxNoSignal));
                    if (opts.llmCandidates != null) pipelineArgs.push('--llm-candidates', String(opts.llmCandidates));
                    if (opts.preUploadRatio != null) pipelineArgs.push('--preupload-ratio', String(opts.preUploadRatio));
                    result = _launchPipeline('auto', pipelineArgs);
                }
                res.writeHead(result.started ? 200 : 409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...result, n }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    if (pathname === '/api/jarvis/v2/auto-run-progress' && req.method === 'GET') {
        try {
            if (url.searchParams.get('fresh') === '1') jarvisStore.invalidateCache('autonomous_progress');
            const data = await jarvisStore.loadJson('autonomous_progress', { active: false, run_id: null, recent_events: [] });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ active: false, run_id: null, recent_events: [] }));
        }
        return;
    }
    if (pathname === '/api/jarvis/v2/auto-run-status' && req.method === 'GET') {
        try {
            if (url.searchParams.get('fresh') === '1') jarvisStore.invalidateCache('autonomous_runs');
            const data = await jarvisStore.loadJson('autonomous_runs', []);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
        }
        return;
    }

    // =========================================
    // API: Jarvis Runner Status (debug)
    // =========================================
    if (pathname === '/api/jarvis/v2/runner-status' && req.method === 'GET') {
        // If Node runner is active, pull live log from its buffer
        const logTail = _runner.active && !_runner._proc
            ? (jarvisRunner._logBuffer || '').slice(-4096)
            : _runner.logTail.slice(-4096);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            active: _runner.active,
            pid: _runner.pid,
            startedAt: _runner.startedAt,
            mode: _runner.mode,
            args: (_runner.args || []).map(a => typeof a === 'string' ? a.replace(__dirname, '.') : String(a)),
            exitCode: _runner.exitCode,
            signal: _runner.signal,
            error: _runner.error,
            logTail,
            engine: _runner._proc ? 'python' : 'node',
        }));
        return;
    }

    // =========================================
    // API: Jarvis Run Hypothesis
    // =========================================
    if (pathname === '/api/jarvis/run-hypothesis' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const hypId = body.id;

            if (hypId === 'h5') {
                // retention_slope_3s: read all video analysis files, compute correlation
                const videoDataDir = path.join(DIR, 'video_data');
                const entries = fs.readdirSync(videoDataDir).filter(d => {
                    try { return fs.statSync(path.join(videoDataDir, d)).isDirectory(); } catch { return false; }
                });

                const dataPoints = [];
                for (const ytId of entries) {
                    try {
                        const raw = fs.readFileSync(path.join(videoDataDir, ytId, 'analysis.json'), 'utf8');
                        const analysis = JSON.parse(raw);
                        const analytics = analysis.analytics || {};
                        const rc = analytics.retentionCurve;
                        const avgPct = analytics.avgPercentViewed;
                        if (!rc || !Array.isArray(rc) || rc.length < 10 || avgPct == null) continue;

                        // Compute early slope: linear regression on first 10 points
                        const first10 = rc.slice(0, 10);
                        const n = first10.length;
                        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
                        first10.forEach((pt, i) => {
                            const x = i;
                            const y = pt.retention;
                            sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
                        });
                        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
                        dataPoints.push({ ytId, slope, avgPercentViewed: avgPct });
                    } catch { continue; }
                }

                // Compute Pearson correlation between slope and avgPercentViewed
                const nn = dataPoints.length;
                if (nn < 3) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'error', message: 'Not enough data points', n: nn }));
                    return;
                }
                let sX = 0, sY = 0, sXY = 0, sX2 = 0, sY2 = 0;
                dataPoints.forEach(d => {
                    sX += d.slope; sY += d.avgPercentViewed;
                    sXY += d.slope * d.avgPercentViewed;
                    sX2 += d.slope * d.slope;
                    sY2 += d.avgPercentViewed * d.avgPercentViewed;
                });
                const denom = Math.sqrt((nn * sX2 - sX * sX) * (nn * sY2 - sY * sY));
                const correlation = denom !== 0 ? (nn * sXY - sX * sY) / denom : 0;

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'complete',
                    hypothesis: 'h5',
                    signal: 'retention_slope_3s',
                    correlation: Math.round(correlation * 1000) / 1000,
                    n: nn,
                    avgSlope: Math.round((sX / nn) * 10000) / 10000,
                    avgRetention: Math.round((sY / nn) * 100) / 100
                }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'pending', message: 'LLM scoring required' }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // Jarvis: loop status + loop logs + unified results.tsv
    // =========================================
    if (pathname === '/api/jarvis/loop-status' && req.method === 'GET') {
        try {
            const loops = ['A', 'B', 'C', 'D'];
            const out = {};
            for (const loop of loops) {
                const logPath = `/tmp/autoResearch_loop_${loop}.log`;
                if (fs.existsSync(logPath)) {
                    const st = fs.statSync(logPath);
                    const ageMinutes = Math.round((Date.now() - st.mtimeMs) / 60000);
                    out[loop] = { lastModified: new Date(st.mtimeMs).toISOString(), ageMinutes };
                } else {
                    out[loop] = { lastModified: null, ageMinutes: null };
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/jarvis/loop-log' && req.method === 'GET') {
        try {
            const loop = String(url.searchParams.get('loop') || '').toUpperCase();
            if (!['A', 'B', 'C', 'D'].includes(loop)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid loop. Use A, B, C, or D.' }));
                return;
            }
            const logPath = `/tmp/autoResearch_loop_${loop}.log`;
            if (!fs.existsSync(logPath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('No log file found');
                return;
            }
            const text = fs.readFileSync(logPath, 'utf8');
            const lines = text.split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(lines || '(no output yet)');
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/jarvis/results-tsv' && req.method === 'GET') {
        try {
            const resultsPath = path.join(DIR, 'buildings', 'jarvis', 'results.tsv');
            const text = fs.existsSync(resultsPath) ? fs.readFileSync(resultsPath, 'utf8') : '';
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(text);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // =========================================
    // API: TRIBE v2 brain analysis
    // =========================================
    //   POST /api/tribe/analyze       { videoId } → { jobId, status }
    //   GET  /api/tribe/results/:id   → analysis JSON or { status: 'pending'|'running'|'failed' }
    //   GET  /api/tribe/available     → [{ videoId, analyzed_at, engagement_score, duration_s }]
    //   GET  /api/tribe/pen-videos    → list videos in video_data/ with analytics
    if (pathname === '/api/tribe/pen-videos' && req.method === 'GET') {
        try {
            const videoDataDir = path.join(DIR, 'video_data');
            const entries = fs.readdirSync(videoDataDir);
            const videos = [];
            for (const ytId of entries) {
                const analysisPath = path.join(videoDataDir, ytId, 'analysis.json');
                if (!fs.existsSync(analysisPath)) continue;
                try {
                    const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
                    const meta = analysis.metadata || {};
                    const analytics = analysis.analytics || {};
                    videos.push({
                        ytId,
                        name: meta.title || ytId,
                        viewCount: analytics.totalViews || 0,
                        duration: meta.duration || 0,
                        hasRetention: Array.isArray(analytics.retentionCurve) && analytics.retentionCurve.length > 0,
                        hasVideo: fs.existsSync(path.join(videoDataDir, ytId, 'video.mp4')),
                    });
                } catch { continue; }
            }
            videos.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
            sendJsonGz(req, res, { videos, count: videos.length });
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/tribe/analyze' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const videoId = String(body.videoId || '').trim();
            if (!videoId || !/^[A-Za-z0-9_-]+$/.test(videoId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid videoId' }));
                return;
            }
            const videoPath = path.join(DIR, 'video_data', videoId, 'video.mp4');
            if (!fs.existsSync(videoPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No video.mp4 at video_data/${videoId}/` }));
                return;
            }
            const job = _tribeStartJob(videoId, videoPath);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jobId: job.id, status: job.status, videoId }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname.match(/^\/api\/tribe\/results\/[^/]+$/) && req.method === 'DELETE') {
        try {
            const videoId = decodeURIComponent(pathname.split('/').pop());
            if (!/^[A-Za-z0-9_-]+$/.test(videoId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid videoId' }));
                return;
            }
            const dir = path.join(DIR, 'buildings', 'jarvis', 'tribe-analysis');
            const files = [`${videoId}.json`, `${videoId}.images.json`, `${videoId}.preds.npy.gz`];
            const PROTECTED_FILES = ['fsaverage5_mesh.json', 'fsaverage5_regions.json', 'analyze_video.py', 'requirements.txt'];
            for (const f of files) {
                if (PROTECTED_FILES.some(p => f === p || f.endsWith('/' + p))) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Cannot delete protected file' }));
                    return;
                }
            }
            let deleted = 0;
            for (const f of files) {
                const fp = path.join(dir, f);
                if (fs.existsSync(fp)) { fs.unlinkSync(fp); deleted++; }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ deleted, videoId }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/tribe/mesh' && req.method === 'GET') {
        try {
            const meshPath = path.join(DIR, 'buildings', 'jarvis', 'tribe-analysis', 'fsaverage5_mesh.json');
            if (!fs.existsSync(meshPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'fsaverage5_mesh.json not found' }));
                return;
            }
            const buf = fs.readFileSync(meshPath);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=86400',
            });
            res.end(buf);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    {
        const m = pathname.match(/^\/api\/tribe\/results\/([A-Za-z0-9_-]+)$/);
        if (m && req.method === 'GET') {
            try {
                const videoId = m[1];
                const resultPath = path.join(DIR, 'buildings', 'jarvis', 'tribe-analysis', `${videoId}.json`);
                // Local first (your Mac): stream from disk — bounded RAM, never reads
                // the whole 100MB+ file into memory.
                if (fs.existsSync(resultPath)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    const s = fs.createReadStream(resultPath);
                    s.on('error', () => { try { res.destroy(); } catch {} });
                    s.pipe(res);
                    return;
                }
                // Render: stream straight from R2 to the client. No whole-file buffer
                // and NO local caching (that would fill Render's ephemeral disk with 5GB).
                if (cloud.isR2Ready()) {
                    try {
                        const r2Stream = await cloud.getR2Stream(`tribe-analysis/${videoId}.json`);
                        if (r2Stream) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            r2Stream.on('error', () => { try { res.destroy(); } catch {} });
                            r2Stream.pipe(res);
                            return;
                        }
                    } catch {}
                }
                const job = _tribeJobs[videoId];
                if (job) {
                    res.writeHead(202, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: job.status,
                        startedAt: job.startedAt,
                        logTail: (job.log || []).slice(-12).join('\n'),
                        error: job.error || null,
                    }));
                    return;
                }
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'not_found' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }
    }

    {
        // GET /api/tribe/video-data/:videoId — companion data for the brain chart:
        // YouTube retention curve (seconds + retention) and the video duration so the
        // UI can convert the normalized retention `second` (0–1 fraction) back into
        // real seconds and overlay it on the brain engagement chart.
        const m = pathname.match(/^\/api\/tribe\/video-data\/([A-Za-z0-9_-]+)$/);
        if (m && req.method === 'GET') {
            try {
                const videoId = m[1];
                const analysisPath = path.join(DIR, 'video_data', videoId, 'analysis.json');
                if (!fs.existsSync(analysisPath)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'analysis.json not found' }));
                    return;
                }
                const a = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
                const rc = (a && a.analytics && Array.isArray(a.analytics.retentionCurve))
                    ? a.analytics.retentionCurve : [];
                const durationSec = Number(a?.metadata?.duration || a?.metadata?.durationSec || a?.analytics?.avgViewDuration || 0) || 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    videoId,
                    title: a?.metadata?.title || null,
                    durationSec,
                    avgViewDuration: a?.analytics?.avgViewDuration || null,
                    avgPercentViewed: a?.analytics?.avgPercentViewed || null,
                    retentionCurve: rc,
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }
    }

    // GET /api/tribe/batch-status — full batch progress including queue
    if (pathname === '/api/tribe/batch-status' && req.method === 'GET') {
        try {
            const videoDataDir = path.join(DIR, 'video_data');
            const tribeDir = path.join(DIR, 'buildings', 'jarvis', 'tribe-analysis');

            // Collect all analyzed videos
            const analyzed = {};
            if (fs.existsSync(tribeDir)) {
                for (const f of fs.readdirSync(tribeDir)) {
                    if (!f.endsWith('.json') || f.includes('.') && !f.endsWith('.json')) continue;
                    const videoId = f.slice(0, -5);
                    if (videoId.includes('.')) continue;
                    try {
                        const d = JSON.parse(fs.readFileSync(path.join(tribeDir, f)));
                        if (d.n_timesteps > 0) {
                            analyzed[videoId] = {
                                n_timesteps: d.n_timesteps,
                                engagement_score: d.engagement_score,
                                analyzed_at: d.analyzed_at
                            };
                        }
                    } catch {}
                }
            }

            // Collect queue (videos with video.mp4, sorted by views desc)
            const allVideos = [];
            if (fs.existsSync(videoDataDir)) {
                for (const vid of fs.readdirSync(videoDataDir)) {
                    const mp4 = path.join(videoDataDir, vid, 'video.mp4');
                    const ana = path.join(videoDataDir, vid, 'analysis.json');
                    if (!fs.existsSync(mp4) || !fs.existsSync(ana)) continue;
                    try {
                        const meta = JSON.parse(fs.readFileSync(ana));
                        const views = parseInt(meta.metadata?.viewCount || 0);
                        const title = meta.metadata?.title || vid;
                        const status = analyzed[vid] ? 'done'
                            : _tribeJobs[vid]?.status === 'running' ? 'running'
                            : _tribeJobs[vid]?.status === 'queued' ? 'queued'
                            : _tribeJobs[vid]?.status === 'failed' ? 'failed'
                            : 'pending';
                        allVideos.push({ videoId: vid, title, views, status,
                            engagement_score: analyzed[vid]?.engagement_score || null,
                            analyzed_at: analyzed[vid]?.analyzed_at || null });
                    } catch {}
                }
            }
            allVideos.sort((a, b) => b.views - a.views);

            const done = allVideos.filter(v => v.status === 'done').length;
            const running = allVideos.filter(v => v.status === 'running').length;
            const total = allVideos.length;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ total, done, running, videos: allVideos }));
        } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (pathname === '/api/tribe/available' && req.method === 'GET') {
        try {
            const dir = path.join(DIR, 'buildings', 'jarvis', 'tribe-analysis');
            const out = [];
            if (fs.existsSync(dir)) {
                // Skip .images.json, fsaverage5_mesh.json, and non-analysis files
                const SKIP_PATTERNS = ['images', 'fsaverage5_mesh', 'fsaverage5_regions'];
                for (const f of fs.readdirSync(dir)) {
                    if (!f.endsWith('.json')) continue;
                    const videoId = f.slice(0, -5);
                    // Skip protected/non-analysis files
                    if (SKIP_PATTERNS.some(p => videoId === p || videoId.endsWith('.' + p) || videoId.endsWith('_' + p))) continue;
                    // Also skip if videoId contains a dot (e.g. IvVJ9RUPcaw.images)
                    if (videoId.includes('.')) continue;
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                        // Must be a real analysis: needs n_timesteps and engagement_score
                        if (!data.n_timesteps || !data.engagement_score) continue;
                        out.push({
                            videoId,
                            analyzed_at: data.analyzed_at || null,
                            duration_s: data.duration_s || 0,
                            engagement_score: data.engagement_score || 0,
                            max_activation_second: data.max_activation_second || 0,
                            n_timesteps: data.n_timesteps || 0,
                        });
                    } catch {}
                }
            }
            // Also surface in-flight jobs so the UI can show progress.
            const inflight = Object.values(_tribeJobs)
                .filter(j => j.status === 'running' || j.status === 'queued')
                .map(j => ({ videoId: j.videoId, status: j.status, startedAt: j.startedAt }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ completed: out, inflight }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/tribe/transcript/:videoId — return { words: [{word, timestamp}], fullText }
    // Sourced from video_data/{videoId}/analysis.json under transcript.{words,fullText}.
    const tribeTranscriptMatch = pathname.match(/^\/api\/tribe\/transcript\/([A-Za-z0-9_-]+)$/);
    if (tribeTranscriptMatch && req.method === 'GET') {
        try {
            const videoId = tribeTranscriptMatch[1];
            const analysisPath = path.join(DIR, 'video_data', videoId, 'analysis.json');
            if (!fs.existsSync(analysisPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'analysis.json not found', words: [], fullText: '' }));
                return;
            }
            const a = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
            const tr = (a && a.transcript) || {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                videoId,
                words: Array.isArray(tr.words) ? tr.words : [],
                fullText: tr.fullText || '',
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/tribe/video/:videoId — stream the actual video file for the browser player
    const tribeVideoMatch = pathname.match(/^\/api\/tribe\/video\/([a-zA-Z0-9_-]+)$/);
    if (tribeVideoMatch && req.method === 'GET') {
        const videoId = tribeVideoMatch[1];
        const videoPath = path.join(DIR, 'video_data', videoId, 'video.mp4');
        if (!fs.existsSync(videoPath)) {
            res.writeHead(404); res.end('Not found'); return;
        }
        const stat = fs.statSync(videoPath);
        const fileSize = stat.size;
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;
            const fileStream = fs.createReadStream(videoPath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': 'video/mp4',
            });
            fileStream.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes',
            });
            fs.createReadStream(videoPath).pipe(res);
        }
        return;
    }

    // GET /api/tribe/frame/:videoId/:second — extract a JPEG frame at a given second
    const tribeFrameMatch = pathname.match(/^\/api\/tribe\/frame\/([a-zA-Z0-9_-]+)\/(\d+(?:\.\d+)?)$/);
    if (tribeFrameMatch && req.method === 'GET') {
        const videoId = tribeFrameMatch[1];
        const second = parseFloat(tribeFrameMatch[2]);
        const videoPath = path.join(DIR, 'video_data', videoId, 'video.mp4');
        if (!fs.existsSync(videoPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Video file not found' }));
            return;
        }
        // Use ffmpeg to extract a single frame
        const { execFile } = require('child_process');
        const tmpFile = path.join(require('os').tmpdir(), `tribe_frame_${videoId}_${second}.jpg`);
        execFile('ffmpeg', [
            '-ss', String(second),
            '-i', videoPath,
            '-vframes', '1',
            '-q:v', '3',
            '-y', tmpFile
        ], { timeout: 15000 }, (err) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ffmpeg failed: ' + err.message }));
                return;
            }
            try {
                const data = fs.readFileSync(tmpFile);
                fs.unlinkSync(tmpFile);
                res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
                res.end(data);
            } catch (e2) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e2.message }));
            }
        });
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
        } else if (ext === '.json') {
            // Data files are the single source of truth — must never serve stale. Revalidate every time;
            // allow a 304 (via Last-Modified) so large unchanged JSON isn't re-downloaded needlessly.
            headers['Cache-Control'] = 'no-cache, must-revalidate';
            try {
                const mt = fs.statSync(filePath).mtime; headers['Last-Modified'] = mt.toUTCString();
                const ims = req.headers['if-modified-since'];
                if (ims && new Date(ims).getTime() >= Math.floor(mt.getTime() / 1000) * 1000) {
                    res.writeHead(304, headers); res.end(); return;
                }
            } catch (e) { /* fall through to full send */ }
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
    const statusLabels = { all: 'All', idea: 'Ideas', pipeline: 'In Pipeline', incubator: 'In Pipeline', workshop: 'In Pipeline', posted: 'Posted' };

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

function renderShareWorkshopPage(videos, assigneeFilter, projectFilter, ideasById) {
    const getAssignedPeople = (v) => {
        const fromList = Array.isArray(v && v.assignedToList) ? v.assignedToList : [];
        const merged = fromList.length ? fromList : ((v && v.assignedTo) ? [v.assignedTo] : []);
        return [...new Set(merged.map(name => String(name || '').trim()).filter(Boolean))];
    };
    const dotStyle = `<style>
        .share-dots { display: inline-flex; gap: 4px; align-items: center; margin-left: 6px; vertical-align: middle; }
        .share-dot { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid #d0cbc2; background: #fff; display: inline-block; }
        .share-dot.has-context { background: #0984e3; border-color: #0984e3; }
        .share-dot.dot-script.has-script { background: #e8a020; border-color: #e8a020; }
        .share-dot.dot-logistics.has-logistics { background: #27ae60; border-color: #27ae60; }
        .share-dots-legend { font-size: 11px; color: #999; margin: -8px 0 12px; text-align: center; }
    </style>`;

    let bodyHtml = dotStyle + '<div class="share-container">';
    bodyHtml += '<div class="share-header"><h1>Workshop</h1></div>';

    bodyHtml += '<div class="share-filter-badges">';
    if (assigneeFilter === 'none') bodyHtml += '<span class="share-badge">Unassigned</span>';
    else if (assigneeFilter) bodyHtml += '<span class="share-badge">Assignee: ' + esc(assigneeFilter) + '</span>';
    if (projectFilter) bodyHtml += '<span class="share-badge">Project: ' + esc(projectFilter) + '</span>';
    if (!assigneeFilter && !projectFilter) bodyHtml += '<span class="share-badge">All workshop videos</span>';
    bodyHtml += '<span class="share-badge">' + videos.length + ' in progress</span>';
    bodyHtml += '</div>';

    bodyHtml += '<div class="share-dots-legend">' +
        '<span class="share-dot has-context"></span> Context &nbsp; ' +
        '<span class="share-dot dot-script has-script"></span> Script &nbsp; ' +
        '<span class="share-dot dot-logistics has-logistics"></span> Logistics' +
        '</div>';

    if (videos.length === 0) {
        bodyHtml += '<div class="share-empty">No workshop videos match this filter.</div>';
    } else {
        bodyHtml += '<div class="share-ideas-grid">';
        for (const v of videos) {
            const idea = v.sourceIdeaId ? ideasById[v.sourceIdeaId] : null;
            const hasContext = v.context && String(v.context).trim();
            const hasScript = v.script && String(v.script).trim();
            const hasLogistics = idea && idea.logistics && Object.keys(idea.logistics).length > 0;
            const preview = String(v.hook || v.context || '').substring(0, 140);
            const dotHtml = '<span class="share-dots" title="Context / Script / Logistics">' +
                '<span class="share-dot' + (hasContext ? ' has-context' : '') + '"></span>' +
                '<span class="share-dot dot-script' + (hasScript ? ' has-script' : '') + '"></span>' +
                '<span class="share-dot dot-logistics' + (hasLogistics ? ' has-logistics' : '') + '"></span>' +
                '</span>';

            // Link to the shared idea page when we have one, otherwise render as a plain card
            const hasLink = !!(idea && idea.id);
            const tag = hasLink ? 'a' : 'div';
            const href = hasLink ? ' href="/share/idea/' + esc(idea.id) + '"' : '';
            bodyHtml += '<' + tag + ' class="share-idea-card"' + href + '>';
            bodyHtml += '<div class="share-idea-card-name">' + esc(v.name || 'Untitled') + dotHtml + '</div>';
            bodyHtml += '<div class="share-idea-card-meta">';
            if (v.project) bodyHtml += '<span class="share-badge">' + esc(v.project) + '</span>';
            for (const person of getAssignedPeople(v)) bodyHtml += '<span class="share-badge">' + esc(person) + '</span>';
            bodyHtml += '</div>';
            if (preview) bodyHtml += '<div class="share-idea-card-preview">' + esc(preview) + (String(v.hook || v.context || '').length > 140 ? '…' : '') + '</div>';
            bodyHtml += '</' + tag + '>';
        }
        bodyHtml += '</div>';
    }

    bodyHtml += '<div class="share-footer">Powered by BusinessWorld</div></div>';
    return renderSharePage('Workshop — BusinessWorld', bodyHtml);
}

// Initialize R2 cloud storage before accepting requests
cloud.initR2();

server.listen(PORT, () => {
    console.log(`Business World running at http://localhost:${PORT}`);
    videoAnalyzer.resumeJobs(process.env.OPENAI_API_KEY, process.env.OPENAI_CHAT_MODEL || 'gpt-4o');
    // Auto-seed Jarvis data to R2 if missing, then force-push code-maintained tools.json
    jarvisStore.autoSeed().then(() => {
        jarvisStore.forceUploadToR2('tools').catch(e => console.warn('Jarvis tools R2 upload failed:', e.message));
    }).catch(e => console.warn('Jarvis auto-seed failed:', e.message));
    // Pre-warm metrics cache in background (ready before user opens Pen)
    _loadOrBuildMetrics().catch(e => console.warn('Metrics pre-warm failed:', e.message));
    // Start shorts crawler — initial crawl after 5s, then every 30 minutes
    setTimeout(() => shortsCrawler.crawl().then(() => shortsCrawler.processFrames()).catch(e => console.warn('shorts-crawler cycle error:', e.message)), 5000);
    setInterval(() => shortsCrawler.crawl().then(() => shortsCrawler.processFrames()).catch(e => console.warn('shorts-crawler cycle error:', e.message)), 30 * 60 * 1000);
});
