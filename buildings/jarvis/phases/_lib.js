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

module.exports = {
    JARVIS_DIR, REPO_ROOT, VIDEO_DATA_DIR, STATUS_FILE,
    nowIso, readJson, writeJson,
    listVideoIds, loadVideo,
    patchStatus, setPhaseProgress,
    pearsonr, spearmanr, rankArr,
};
