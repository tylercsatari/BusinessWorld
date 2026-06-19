/**
 * footage-coverage.js — does a project's Dropbox footage cover its script?
 *
 * For a video that has a linked Channel Project + a written script, this:
 *   1. lists every raw video clip under the project's Dropbox folder
 *   2. has Gemini natively "watch" each clip (whole timeline, not just the start)
 *      → a compact catalogue of what's shot. Cached by Dropbox content_hash so a
 *      clip is only ever analyzed/downloaded ONCE (re-runs only touch new clips).
 *   3. runs ONE text reasoning pass: script + the catalogue of all clips → which
 *      script beats are covered, and which look like they have NO footage.
 *
 * It owns no I/O — the server injects download/list/gemini/kimi/cache so this stays
 * testable and decoupled. The result is a list of "gap" suggestions, used as a tool
 * (keep or delete each), never a gate.
 */

const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'mts', 'm2ts', 'mpg', 'mpeg', 'ogv', '3gp', 'wmv', 'flv']);
// Subfolders that are NOT raw footage — edited outputs, audio, and build artifacts.
// Skipping them keeps "do I have footage for this beat?" honest (a final edit would
// otherwise look like it covers everything).
const SKIP_DIR = /\/(final videos|vo|voiceover|cad|pcb|software|manufacturing|assembly|orders?)\//i;

function extOf(name) { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function mimeOf(name) {
    const e = extOf(name);
    if (e === 'mov') return 'video/quicktime';
    if (e === 'webm') return 'video/webm';
    if (e === 'avi') return 'video/x-msvideo';
    if (e === 'mkv') return 'video/x-matroska';
    if (e === 'mpg' || e === 'mpeg') return 'video/mpeg';
    if (e === 'ogv') return 'video/ogg';
    if (e === '3gp') return 'video/3gpp';
    return 'video/mp4';
}
function isRawClip(entry) {
    if (!entry || entry['.tag'] !== 'file') return false;
    if (!VIDEO_EXT.has(extOf(entry.name))) return false;
    const p = (entry.path_display || entry.path_lower || '');
    if (SKIP_DIR.test(p)) return false;
    return true;
}

// What Gemini extracts from ONE clip — a tight, cheap catalogue (not a full critique).
const CLIP_PROMPT = `You are cataloguing raw footage for a video editor. Watch this ENTIRE clip (visuals, action, on-screen text, and anything spoken) and return STRICT JSON only — no prose, no markdown.
Schema:
{
  "summary": "one sentence: what this clip shows overall",
  "shots": ["short concrete description of each distinct shot/action/subject in the clip"],
  "spoken": "a brief paraphrase or verbatim of anything said, else \\"\\"",
  "setting": "where it appears to take place",
  "keywords": ["searchable nouns/actions: e.g. 'drone', 'lake', 'soldering', 'unboxing'"]
}
Be concrete and specific. Output ONLY the JSON object.`;

function buildCoveragePrompt(script, clips) {
    const catalogue = clips.map((c, i) => {
        const a = c.analysis || {};
        const shots = Array.isArray(a.shots) ? a.shots.join('; ') : '';
        const kw = Array.isArray(a.keywords) ? a.keywords.join(', ') : '';
        return `[Clip ${i + 1}] ${c.name}\n  summary: ${a.summary || ''}\n  shots: ${shots}\n  spoken: ${a.spoken || ''}\n  keywords: ${kw}`;
    }).join('\n');
    const sys = `You check whether a creator's filmed footage covers their script. You are given the full SCRIPT and a CATALOGUE of every raw clip currently in their Dropbox. Identify the moments the script implies should have footage (a demonstrated action, a shown object, a location, a reaction, a cutaway/b-roll the narration references) and decide, for each, whether some clip plausibly covers it.
Return STRICT JSON only — no prose, no markdown:
{
  "covered": ["short label of a script moment that IS covered by a clip"],
  "gaps": [
    {
      "beat": "short label of the missing moment",
      "scriptQuote": "the exact sentence/phrase in the script that calls for it",
      "note": "one line: what footage seems to be missing and why you think so"
    }
  ]
}
Be conservative: only list a gap when the script clearly calls for footage that no clip seems to cover. It is fine to return an empty gaps array. Do NOT invent script content. Prefer fewer, high-confidence gaps over many speculative ones.`;
    const user = `SCRIPT:\n${(script || '').slice(0, 20000)}\n\nFOOTAGE CATALOGUE (${clips.length} clip${clips.length === 1 ? '' : 's'}):\n${catalogue || '(no clips found)'}`;
    return { sys, user };
}

/**
 * @param {object} o
 * @param {object} o.video           { id, name, script }
 * @param {string} o.projectFolder   absolute Dropbox path for the project
 * @param {object} o.deps            injected I/O (see top-of-file)
 * @returns {Promise<{clipsAnalyzed:number, fromCache:number, covered:string[], gaps:object[], model:string, skipped:number}>}
 */
async function analyzeProject({ video, projectFolder, deps }) {
    const { listFolder, download, geminiAnalyze, kimiJson, cacheGet, cacheSet, onEvent } = deps;
    const emit = (ev) => { try { onEvent && onEvent(ev); } catch (e) {} };

    emit({ type: 'phase', phase: 'listing', msg: `Listing footage in ${projectFolder} …` });
    const entries = await listFolder(projectFolder);
    const clips = entries.filter(isRawClip);
    // Tell the caller the full work-list up front so the UI can show "n/total" and
    // a per-clip checklist of exactly what's been analyzed vs not.
    emit({ type: 'list', total: clips.length, clips: clips.map(c => ({ name: c.name, path: c.path_display || c.path_lower, size: c.size || 0 })), msg: `Found ${clips.length} raw clip${clips.length === 1 ? '' : 's'} to check.` });

    const analyzed = [];
    let fromCache = 0;
    for (let i = 0; i < clips.length; i++) {
        const e = clips[i];
        const hash = e.content_hash || e.rev || (e.path_lower || e.name);
        let analysis = null;
        const cached = await cacheGet(hash);
        if (cached && cached.analysis) {
            analysis = cached.analysis;
            fromCache++;
            emit({ type: 'clip', index: i, name: e.name, status: 'cached', msg: `(${i + 1}/${clips.length}) ${e.name} — cached ✓` });
        } else {
            emit({ type: 'clip', index: i, name: e.name, status: 'analyzing', msg: `(${i + 1}/${clips.length}) Downloading & watching ${e.name} …` });
            try {
                const bytes = await download(e.path_display || e.path_lower);
                const { result } = await geminiAnalyze(bytes, mimeOf(e.name), CLIP_PROMPT, { displayName: e.name });
                analysis = (result && !result._parseError) ? result : { summary: '', shots: [], spoken: '', keywords: [], _err: result && result._parseError };
                await cacheSet(hash, { contentHash: hash, path: e.path_display || e.path_lower, name: e.name, analysis });
                emit({ type: 'clip', index: i, name: e.name, status: 'done', summary: analysis.summary || '', msg: `(${i + 1}/${clips.length}) ${e.name} — analyzed ✓` });
            } catch (err) {
                analysis = { summary: '', shots: [], spoken: '', keywords: [], _err: err.message };
                emit({ type: 'clip', index: i, name: e.name, status: 'error', error: err.message, msg: `   ⚠ ${e.name}: ${err.message}` });
            }
        }
        analyzed.push({ name: e.name, path: e.path_display || e.path_lower, analysis });
    }

    emit({ type: 'phase', phase: 'reasoning', msg: `Reasoning over the script vs ${analyzed.length} clip${analyzed.length === 1 ? '' : 's'} …` });
    const { sys, user } = buildCoveragePrompt(video.script || '', analyzed);
    const raw = await kimiJson([{ role: 'system', content: sys }, { role: 'user', content: user }], 8000);
    let parsed;
    try {
        let t = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        parsed = JSON.parse(t);
    } catch (e) {
        parsed = { covered: [], gaps: [], _parseError: e.message };
    }
    const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : [];
    const covered = Array.isArray(parsed.covered) ? parsed.covered : [];
    emit({ type: 'phase', phase: 'done', msg: `Done — ${covered.length} covered, ${gaps.length} possible gap${gaps.length === 1 ? '' : 's'}.` });

    return {
        clipsAnalyzed: analyzed.length,
        fromCache,
        covered,
        gaps,
        model: 'gemini+kimi',
    };
}

module.exports = { analyzeProject, isRawClip, CLIP_PROMPT, VIDEO_EXT };
