/**
 * stream-json.js — bounded-RAM readers for giant JSON array files. No deps.
 *
 * The Jarvis data files (derived_experiments 82MB, resolutions 28MB,
 * experiments_log 130MB, research_questions 511MB) are arrays of *tiny* records
 * — they're huge by COUNT, not by row size. `JSON.parse(fs.readFileSync(...))`
 * inflates the whole file 5-10x in heap and OOMs the 2GB Render box.
 *
 * These helpers walk a file as a byte stream and keep only a bounded slice in
 * memory (a page, or top-N by score, or the first match), so peak RAM stays
 * flat — a few MB — no matter how big the file grows. Slower (re-reads the file
 * per request) but it never crashes. That's the deliberate trade.
 *
 * The tokenizer is string/escape/bracket aware, so it works identically on
 * minified single-line arrays AND pretty-printed multi-line ones.
 */
const fs = require('fs');

const MAX_ELEM = 8 * 1024 * 1024;  // cap on one element's chars before we skip it — OOM backstop
                                   // (real records are bytes-to-KB; this only trips on pathological input)

/**
 * Stream every top-level element of a JSON array file, invoking `onRecord(obj,
 * index)` for each. Return `false` from onRecord to stop early (the stream is
 * destroyed and the file handle released immediately).
 *
 * Assumes the first `[` in the file opens the array of interest. For files that
 * wrap the array under a key (e.g. research_questions.json -> {..,"questions":[]}),
 * pass `{ arrayKey: 'questions' }` to begin capture at that key's array.
 *
 * Peak RAM = current 64KB chunk + one record's worth of characters.
 */
/**
 * Remove a top-level field (and its value, however large) from a JSON *object*
 * string, at the string level — no parsing of the value. Lets us drop a giant
 * field (e.g. resolutions' 26MB `indicator_keys`) before JSON.parse so it never
 * materializes in heap. Returns the text unchanged if the field isn't present.
 */
function stripField(text, field) {
    const needle = '"' + field + '"';
    const at = text.indexOf(needle);
    if (at < 0) return text;
    let i = at + needle.length;
    while (i < text.length && text[i] !== ':') i++;   // skip to colon
    i++;
    while (i < text.length && /\s/.test(text[i])) i++; // skip ws before value
    const ch = text[i];
    if (ch === '[' || ch === '{') {
        const close = ch === '[' ? ']' : '}';
        let depth = 0, inS = false, esc = false;
        for (; i < text.length; i++) {
            const c = text[i];
            if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; }
            if (c === '"') inS = true;
            else if (c === '[' || c === '{') depth++;
            else if (c === ']' || c === '}') { depth--; if (depth === 0) { i++; break; } }
        }
    } else if (ch === '"') {
        let esc = false;
        for (i++; i < text.length; i++) { const c = text[i]; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') { i++; break; } }
    } else {
        while (i < text.length && text[i] !== ',' && text[i] !== '}') i++; // scalar
    }
    // Drop the key:value span plus one adjacent comma to keep the object valid.
    let start = at, end = i;
    let b = start - 1; while (b >= 0 && /\s/.test(text[b])) b--;
    if (text[b] === ',') start = b;                 // leading comma (field not first)
    else { let f = end; while (f < text.length && /\s/.test(text[f])) f++; if (text[f] === ',') end = f + 1; } // trailing comma (field first)
    return text.slice(0, start) + text.slice(end);
}

function streamArray(filePath, onRecord, opts = {}) {
    const arrayKey = opts.arrayKey || null;
    const maxElem = opts.maxElem || MAX_ELEM;   // skip any single element larger than this
    const transform = opts.transform || null;   // map raw element TEXT before JSON.parse
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });

        let started = false;       // true once we've consumed the array's opening `[`
        let keySeen = !arrayKey;   // when keyed, wait until we pass `"key":` first
        let depth = 0;             // nesting depth inside the current element
        let inStr = false, esc = false;
        let pendingTok = '';       // accumulates a bare string token for arrayKey detection
        let parts = [];            // text SLICES of the element currently being assembled
        let curLen = 0;            // running char length of the current element (across chunks)
        let skipping = false;      // current element exceeded maxElem — track structure, don't buffer
        let idx = 0;
        let stopped = false;

        const stop = () => { stopped = true; stream.destroy(); };

        const flush = () => {
            const wasSkipping = skipping;
            const collected = wasSkipping ? '' : parts.join('');
            parts = []; curLen = 0; skipping = false;
            if (wasSkipping) { idx++; return; }     // counted, too big to deliver
            let t = collected.trim();
            if (!t) return;
            if (transform) t = transform(t);        // e.g. strip a giant field before parsing
            let rec;
            try { rec = JSON.parse(t); } catch (e) { return; } // skip a malformed element rather than die
            if (onRecord(rec, idx++) === false) stop();
        };

        stream.on('data', (chunk) => {
            const n = chunk.length;
            let i = 0;

            // ── Phase 1: locate + consume the opening `[` of our array (char-by-char) ──
            if (!started) {
                for (; i < n; i++) {
                    const c = chunk[i];
                    if (inStr) {
                        if (esc) { esc = false; pendingTok += c; }
                        else if (c === '\\') { esc = true; }
                        else if (c === '"') { inStr = false; if (arrayKey && pendingTok === arrayKey) keySeen = true; pendingTok = ''; }
                        else pendingTok += c;
                        continue;
                    }
                    if (c === '"') { inStr = true; pendingTok = ''; continue; }
                    if (c === '[' && keySeen) { started = true; i++; break; } // consume opening bracket
                    // Keyed search: the key must be *immediately* followed by `[` (ws/colon
                    // allowed). Anything else means this wasn't `"<key>": [` — drop the match.
                    if (arrayKey && keySeen && c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== ':') keySeen = false;
                }
                if (!started) return; // whole chunk was before the array
            }

            // ── Phase 2: split top-level elements. We only scan char-by-char to track
            // structure and find boundaries; the element TEXT is captured by slicing the
            // chunk in bulk at each boundary — O(1) appends, one join per element. This
            // avoids the O(n²) rope-building that char-by-char `+=` causes on big records.
            let segStart = i;   // where the current element's text begins in THIS chunk
            for (; i < n; i++) {
                const c = chunk[i];
                // Skip-mode trip: element exceeded maxElem. Drop what we have, keep scanning
                // for the boundary so we stay in sync, but buffer nothing more.
                if (!skipping && (curLen + (i - segStart)) > maxElem) { skipping = true; parts = []; }

                if (inStr) {
                    if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
                    continue;
                }
                if (c === '"') { inStr = true; continue; }
                if (c === '{' || c === '[') { depth++; continue; }
                if (c === '}') { depth--; continue; }
                if (c === ']') {
                    if (depth === 0) { if (!skipping) parts.push(chunk.slice(segStart, i)); flush(); stop(); return; }
                    depth--; continue;
                }
                if (c === ',' && depth === 0) {
                    if (!skipping) parts.push(chunk.slice(segStart, i));
                    flush();                 // resets parts/curLen/skipping
                    segStart = i + 1;        // next element starts after the comma
                    continue;
                }
            }
            // Element continues into the next chunk: carry its tail.
            if (!skipping) { parts.push(chunk.slice(segStart, n)); curLen += (n - segStart); }
        });

        stream.on('close', () => resolve(idx));
        stream.on('error', (e) => { if (stopped) resolve(idx); else reject(e); });
    });
}

/**
 * Return the top-N records by |record[scoreKey]| (descending), plus the true
 * total count of the whole array. RAM bounded to ~2N records while streaming.
 * `project` (optional) maps each record to a smaller shape before it's kept.
 */
async function topN(filePath, { scoreKey, n = 5000, project = null, arrayKey = null } = {}) {
    let kept = [];   // { s: score, r: record }
    let total = 0;
    const cap = Math.max(2 * n, 1000);
    await streamArray(filePath, (rec) => {
        total++;
        const s = Math.abs(Number(rec && rec[scoreKey]) || 0);
        kept.push({ s, r: project ? project(rec) : rec });
        if (kept.length >= cap) { kept.sort((a, b) => b.s - a.s); kept.length = n; }
        return true;
    }, { arrayKey });
    kept.sort((a, b) => b.s - a.s);
    if (kept.length > n) kept.length = n;
    return { items: kept.map((x) => x.r), total };
}

/**
 * Return a page [offset, offset+limit) of the array, plus the true total.
 * Streams the whole file (to get an accurate total) but only retains the page.
 */
async function page(filePath, { offset = 0, limit = 1000, project = null, filter = null, arrayKey = null } = {}) {
    const items = [];
    let matched = 0;
    await streamArray(filePath, (rec) => {
        if (filter && !filter(rec)) return true;
        const i = matched++;
        if (i >= offset && items.length < limit) items.push(project ? project(rec) : rec);
        return true;
    }, { arrayKey });
    return { items, total: matched };
}

/** First record satisfying `predicate`, or null. Stops reading at the match. */
async function findOne(filePath, predicate, opts = {}) {
    let hit = null;
    await streamArray(filePath, (rec) => {
        if (predicate(rec)) { hit = rec; return false; }
        return true;
    }, opts);
    return hit;
}

/** Project every record into a small shape (RAM bounded). Returns an array. */
async function projectAll(filePath, project, opts = {}) {
    const out = [];
    await streamArray(filePath, (rec) => { out.push(project(rec)); return true; }, opts);
    return out;
}

/** Count records without retaining any. RAM ~ one record. */
async function count(filePath, opts = {}) {
    return streamArray(filePath, () => true, opts);
}

module.exports = { streamArray, topN, page, findOne, projectAll, count, stripField };
