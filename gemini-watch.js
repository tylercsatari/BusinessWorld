/**
 * gemini-watch.js — have Gemini natively "watch" a video and return structured
 * observations mapped onto Tyler's indicator vocabulary.
 *
 * Flow (Gemini Files API, resumable upload):
 *   1. start  → get an upload URL
 *   2. upload+finalize the bytes → file resource {uri, name, state}
 *   3. poll file.state until ACTIVE
 *   4. generateContent with the file + a structured-observation prompt (JSON out)
 *
 * Used by server.js /api/gemini/watch. Requires process.env.GEMINI_API_KEY.
 */
const fs = require('fs');

// gemini-3.5-flash: GA (May 2026), best-in-class for video understanding, 1M context.
// Verified field names against the live v1beta API (camelCase thinkingConfig/mediaResolution).
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const BASE = 'https://generativelanguage.googleapis.com';

// What Gemini should extract. Phrased in terms of Tyler's retention/indicator
// vocabulary so the coordinator can map it onto real indicators afterward.
const OBSERVATION_PROMPT = `You are a meticulous video analyst for a top YouTube creator. Watch this ENTIRE video (visuals, motion, pacing, on-screen text, narration, audio) and return STRICT JSON only — no prose, no markdown.

Schema:
{
  "summary": "1-2 sentence plain description of the whole video",
  "duration_seconds": <number, your best estimate>,
  "hook": {
    "first_3s": "exactly what happens in the first 3 seconds (visual + spoken/text)",
    "description": "how the opening tries to grab attention",
    "strength_1to10": <int>,
    "promise": "what the opening implicitly or explicitly promises the viewer"
  },
  "beats": [ { "t_start": <sec>, "t_end": <sec>, "description": "...", "intensity_1to10": <int> } ],
  "pacing": { "cuts_per_min_estimate": <number>, "dead_spots": [ { "t": <sec>, "why": "..." } ], "notes": "..." },
  "visuals": { "style": "...", "subject_scale_1to10": <int>, "motion_1to10": <int>, "contrast_1to10": <int>, "on_screen_text": ["..."] },
  "audio": { "has_narration": <bool>, "music": "...", "sound_design": "...", "notes": "..." },
  "payoff": { "description": "how it ends / what it delivers", "t_climax": <sec>, "exceeds_hook": <bool> },
  "novelty_1to10": <int>,
  "clarity_1to10": <int>,
  "spoken_excerpt": "a short verbatim excerpt of narration if discernible, else \\"\\"",
  "candidate_weaknesses": ["first-pass guesses at what could be improved — these will be validated against data later"]
}

Be specific and quantitative. Estimate timestamps. If something is absent, use null or empty. Output ONLY the JSON object.`;

function authUrl(p) {
  const key = process.env.GEMINI_API_KEY;
  return `${BASE}${p}${p.includes('?') ? '&' : '?'}key=${key}`;
}

async function startResumable(sizeBytes, mimeType, displayName) {
  const res = await fetch(authUrl('/upload/v1beta/files'), {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!res.ok) throw new Error(`Gemini upload start failed: ${res.status} ${await res.text()}`);
  const uploadUrl = res.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini did not return an upload URL');
  return uploadUrl;
}

async function uploadBytes(uploadUrl, bytes) {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Gemini upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.file; // { name, uri, state, mimeType, ... }
}

async function waitActive(fileName, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(authUrl(`/v1beta/${fileName}`));
    if (res.ok) {
      const f = await res.json();
      if (f.state === 'ACTIVE') return f;
      if (f.state === 'FAILED') throw new Error('Gemini file processing FAILED');
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for Gemini to process the video');
}

async function generate(fileUri, mimeType, model, prompt, genConfig, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 180000);   // never let a single clip hang forever
  let res;
  try {
    res = await fetch(authUrl(`/v1beta/models/${model}:generateContent`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { file_data: { mime_type: mimeType, file_uri: fileUri } },
            { text: prompt || OBSERVATION_PROMPT },
          ],
        }],
        // Defaults are tuned for the Video Lab's thorough watch (high thinking +
        // high media resolution). Callers (e.g. footage cataloguing) override with
        // a cheaper/faster config via genConfig.
        generationConfig: {
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: 'high' },
          mediaResolution: 'MEDIA_RESOLUTION_HIGH',
          ...(genConfig || {}),
        },
      }),
      signal: ctrl.signal,
    });
  } catch (e) { throw new Error(`Gemini generateContent ${e.name === 'AbortError' ? 'timed out' : 'failed'}: ${e.message}`); }
  finally { clearTimeout(to); }
  if (!res.ok) throw new Error(`Gemini generateContent failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  let json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(json); }
  catch (e) { return { _parseError: e.message, _raw: text.slice(0, 4000) }; }
}

/**
 * Watch a local video file and return structured observations.
 * @param {string} filePath  path to the video on disk
 * @param {string} mimeType  e.g. "video/mp4"
 * @param {object} opts       { model, displayName }
 */
async function watchVideo(filePath, mimeType = 'video/mp4', opts = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in .env — add it to enable Video Lab.');
  }
  const model = opts.model || GEMINI_MODEL;
  const bytes = fs.readFileSync(filePath);
  const displayName = opts.displayName || 'videolab-clip';

  const uploadUrl = await startResumable(bytes.length, mimeType, displayName);
  const file = await uploadBytes(uploadUrl, bytes);
  await waitActive(file.name);
  const observations = await generate(file.uri, file.mimeType || mimeType, model);

  // best-effort cleanup of the uploaded file
  try { await fetch(authUrl(`/v1beta/${file.name}`), { method: 'DELETE' }); } catch (e) {}

  return { model, observations };
}

/**
 * Same Files-API flow as watchVideo, but takes raw BYTES already in memory and a
 * CUSTOM prompt — used by footage-coverage to catalogue each Dropbox clip without
 * writing it to disk. Returns the parsed JSON the prompt asks for.
 * @param {Buffer} bytes
 * @param {string} mimeType
 * @param {string} prompt   must instruct STRICT-JSON output
 * @param {object} opts     { model, displayName, timeoutMs }
 */
async function analyzeBytes(bytes, mimeType, prompt, opts = {}) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in .env.');
  const model = opts.model || GEMINI_MODEL;
  const displayName = opts.displayName || 'footage-clip';
  const uploadUrl = await startResumable(bytes.length, mimeType, displayName);
  const file = await uploadBytes(uploadUrl, bytes);
  await waitActive(file.name, { timeoutMs: opts.timeoutMs || 120000 });
  const result = await generate(file.uri, file.mimeType || mimeType, model, prompt, opts.genConfig, opts.generateTimeoutMs);
  try { await fetch(authUrl(`/v1beta/${file.name}`), { method: 'DELETE' }); } catch (e) {}
  return { model, result };
}

// The cheap/fast Gemini config for footage cataloguing (vs the Video Lab's
// thorough watch) — exported so callers don't re-declare it.
const FOOTAGE_GEN_CONFIG = { thinkingConfig: { thinkingLevel: 'low' }, mediaResolution: 'MEDIA_RESOLUTION_LOW' };

/**
 * Like analyzeBytes, but STREAMS the file into Gemini's resumable upload so the
 * whole clip is never buffered in memory (a phone .mov can be hundreds of MB / GB).
 * Uses a SINGLE "upload, finalize" command (the variant the Files API reliably
 * accepts) with a streaming request body — the bytes flow Dropbox→server→Gemini
 * without ever materialising the full clip in RAM.
 * @param {object} o
 * @param {ReadableStream} o.readable   a web ReadableStream of the file bytes (e.g. fetch().body)
 * @param {number} o.size               total byte length (required by the resumable protocol)
 * @param {string} o.mimeType
 * @param {string} o.prompt             STRICT-JSON instruction
 * @param {object} [o]                  { displayName, model, timeoutMs }
 */
async function analyzeStream({ readable, size, mimeType, prompt, displayName, model, timeoutMs }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in .env.');
  if (!size || size < 0) throw new Error('analyzeStream needs a positive byte size');
  model = model || GEMINI_MODEL;
  const uploadUrl = await startResumable(size, mimeType, displayName || 'footage-clip');
  // One-shot finalize, but with a STREAMING body (duplex:'half' lets undici send
  // the request body as a stream). Bounded memory; proven single-command protocol.
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 600000);
  let res;
  try {
    res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(size),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: readable,
      duplex: 'half',
      signal: ctrl.signal,
    });
  } catch (e) { throw new Error(`Gemini upload ${e.name === 'AbortError' ? 'timed out' : 'failed'}: ${e.message}`); }
  finally { clearTimeout(to); }
  if (!res.ok) throw new Error(`Gemini upload failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json().catch(() => ({}));
  const file = data.file;
  if (!file || !file.name) throw new Error('Gemini upload did not finalize');
  await waitActive(file.name, { timeoutMs: 120000 });
  // Footage cataloguing only needs "what's in this clip" — use LOW media resolution
  // and LOW thinking so each clip takes seconds, not minutes (and costs far less).
  const result = await generate(file.uri, file.mimeType || mimeType, model, prompt,
    { thinkingConfig: { thinkingLevel: 'low' }, mediaResolution: 'MEDIA_RESOLUTION_LOW' }, 150000);
  try { await fetch(authUrl(`/v1beta/${file.name}`), { method: 'DELETE' }); } catch (e) {}
  return { model, result };
}

module.exports = { watchVideo, analyzeBytes, analyzeStream, FOOTAGE_GEN_CONFIG, GEMINI_MODEL, OBSERVATION_PROMPT };
