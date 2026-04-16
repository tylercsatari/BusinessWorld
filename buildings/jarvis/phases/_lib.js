'use strict';
// Shared helpers for overnight phase scripts. Kept tiny on purpose.

const fs = require('fs');
const path = require('path');

const JARVIS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(JARVIS_DIR, '..', '..');
const VIDEO_DATA_DIR = path.join(REPO_ROOT, 'video_data');
const STATUS_FILE = path.join(JARVIS_DIR, 'overnight_status.json');

function nowIso() { return new Date().toISOString(); }

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[phase] readJson failed for ${file}: ${err.message}`);
        return fallback;
    }
}

function writeJson(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

function listVideoIds() {
    if (!fs.existsSync(VIDEO_DATA_DIR)) return [];
    return fs.readdirSync(VIDEO_DATA_DIR).filter(d => {
        const ap = path.join(VIDEO_DATA_DIR, d, 'analysis.json');
        return fs.existsSync(ap);
    });
}

function loadVideo(id) {
    const ap = path.join(VIDEO_DATA_DIR, id, 'analysis.json');
    try { return JSON.parse(fs.readFileSync(ap, 'utf8')); } catch { return null; }
}

function patchStatus(updater) {
    const cur = readJson(STATUS_FILE, {});
    const next = updater(cur) || cur;
    writeJson(STATUS_FILE, next);
}

function setPhaseProgress(phaseId, progress) {
    patchStatus(s => {
        s.current_phase = phaseId;
        s.current_phase_progress = progress;
        s.updated_at = nowIso();
        return s;
    });
}

function pearsonr(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 3) return { r: 0, n };
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - mx, dy = y[i] - my;
        num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    if (!isFinite(denom) || denom === 0) return { r: 0, n };
    return { r: Math.max(-1, Math.min(1, num / denom)), n };
}

function rankArr(arr) {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
        i = j + 1;
    }
    return ranks;
}

function spearmanr(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 3) return { rho: 0, n };
    const rx = rankArr(x.slice(0, n));
    const ry = rankArr(y.slice(0, n));
    const r = pearsonr(rx, ry).r;
    return { rho: r, n };
}

// Ubiquity-aware weight per §11 of the meta-architecture. A mechanism in
// nearly every video carries almost no discriminative signal and is not
// actionable as a lever — so its weight approaches zero. Rare mechanisms
// receive higher weight. Add-one smoothing keeps the endpoints finite.
function idfWeight(totalVideos, nVideosWithMech) {
    const N = Number(totalVideos) || 0;
    const n = Math.max(0, Number(nVideosWithMech) || 0);
    if (N <= 0) return 0;
    return Math.log((N + 1) / (n + 1));
}

// Target-proxy / tautological indicator guard. Per Tyler's filter rule, an
// indicator that IS the outcome (log_views vs views_log10 is the identity)
// produces bridges that look strong but encode no distinct optimization
// behavior, so we exclude them from the principle and bridge layers. Kept
// as a set so it is easy to extend without recompile-time changes.
const TARGET_PROXY_INDICATORS = new Set([
    'log_views',
    'views',
    'views_log10',
    'log10_views',
]);

function isTargetProxyIndicator(key, indicatorOutcomeR) {
    if (key && TARGET_PROXY_INDICATORS.has(String(key).toLowerCase())) return true;
    if (typeof indicatorOutcomeR === 'number' && Math.abs(indicatorOutcomeR) >= 0.99) return true;
    return false;
}

// Parse a mechanism_id of shape "<kind>_<family>_at_<bucket>" into parts.
// Families may contain underscores (e.g. "text_overlay"). Returns null on
// shapes that do not match the observation-derived grammar.
function parseMechanismId(id) {
    const atIdx = String(id || '').lastIndexOf('_at_');
    if (atIdx < 0) return null;
    const head = id.slice(0, atIdx);
    const bucket = id.slice(atIdx + 4);
    const us = head.indexOf('_');
    if (us < 0) return null;
    return { kind: head.slice(0, us), family: head.slice(us + 1), bucket };
}

// Emit cross-source co-occurrence "compound" mechanisms from a set of
// same-video observations. Two observations whose (kind, family) differ in
// kind but share a position bucket produce a compound id of the form
//   compound_<kindA>_<famA>_X_<kindB>_<famB>_at_<bucket>
// Pair order is stable (lexicographic) so the same pair always produces
// the same id. Compounds of compounds are not emitted. `bucket === 'unknown'`
// is skipped so we do not manufacture phantom co-occurrence.
function expandCompoundMechanisms(observations) {
    const perBucket = new Map();
    for (const o of observations || []) {
        const d = parseMechanismId(o && o.mechanism_id);
        if (!d) continue;
        if (d.kind === 'compound') continue;
        if (d.bucket === 'unknown') continue;
        if (!perBucket.has(d.bucket)) perBucket.set(d.bucket, new Set());
        perBucket.get(d.bucket).add(`${d.kind}|${d.family}`);
    }
    const out = [];
    for (const [bucket, set] of perBucket.entries()) {
        const arr = Array.from(set).sort();
        for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
                const [ka, fa] = arr[i].split('|');
                const [kb, fb] = arr[j].split('|');
                if (ka === kb) continue;
                out.push({
                    mechanism_id: `compound_${ka}_${fa}_X_${kb}_${fb}_at_${bucket}`,
                    evidence_kind: 'cross_source_cooccurrence',
                    evidence_text: `${ka}:${fa} co-occurs with ${kb}:${fb} in ${bucket}`,
                    position_s: null,
                    position_pct: null,
                    source: 'phase2_cooccurrence',
                });
            }
        }
    }
    return out;
}

module.exports = {
    JARVIS_DIR, REPO_ROOT, VIDEO_DATA_DIR, STATUS_FILE,
    nowIso, readJson, writeJson,
    listVideoIds, loadVideo,
    patchStatus, setPhaseProgress,
    pearsonr, spearmanr, rankArr,
    idfWeight, TARGET_PROXY_INDICATORS, isTargetProxyIndicator,
    parseMechanismId, expandCompoundMechanisms,
};
