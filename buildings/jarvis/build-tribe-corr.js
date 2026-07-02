#!/usr/bin/env node
// build-tribe-corr.js — precompute the Tribe-V2 ↔ tracked-metrics join for the "🧠 Tribe Influence" tab.
// For every Tribe-analyzed video (owner/Main channel), slice EVERY per-second Tribe signal to the first
// 5 s of stimulus (HRF offset = 5 s → brain indices 5..9) and reduce each to scalar features + a 5-pt
// shape, then attach the tracked metrics (views/keep/ret5/retention/… from video_data + retention_table)
// so the browser can correlate Tribe-indicator × tracked-metric (mean/linear) AND overlay shapes.
// Writes retention-study/tribe-corr.json (local) + uploads R2 retention/tribe-corr.json.
// Run locally (needs tribe-analysis/*.json + video_data/*): node buildings/jarvis/build-tribe-corr.js
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (e) {}
let cloud = null; try { cloud = require('../../cloud-storage'); if (cloud.initR2) cloud.initR2(); } catch (e) {}

const ROOT = path.join(__dirname, '..', '..');
const TDIR = path.join(__dirname, 'tribe-analysis');
const VDATA = path.join(ROOT, 'video_data');
const RTABLE = path.join(__dirname, 'retention-study', 'retention_table.json');
const OUT = path.join(__dirname, 'retention-study', 'tribe-corr.json');

const HRF = 5;                 // stimulus 0..4 → brain indices 5..9
const WIN = 5;                 // first 5 seconds
// ── first-5s scalar features from a per-second vector (indices HRF..HRF+WIN-1) ──
function sliceFeat(arr) {
    if (!Array.isArray(arr)) return null;
    const v = arr.slice(HRF, HRF + WIN).map(Number).filter(x => isFinite(x));
    if (v.length < 3) return null;                       // too short to be meaningful
    const n = v.length, mean = v.reduce((a, b) => a + b, 0) / n;
    const peak = Math.max(...v), trough = Math.min(...v);
    let argmax = 0; for (let i = 1; i < n; i++) if (v[i] > v[argmax]) argmax = i;
    // slope: OLS over t=0..n-1
    const tm = (n - 1) / 2; let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - tm) * (v[i] - mean); sxx += (i - tm) * (i - tm); }
    const slope = sxx ? sxy / sxx : 0;
    return { mean, slope, peak, argmax, delta: v[n - 1] - v[0], range: peak - trough, shape: v };
}
// only these interpretable signals keep their 5-pt shape (for curve overlays); the rest keep scalars only
const feat = (arr) => { const f = sliceFeat(arr); return f ? { mean: r4(f.mean), slope: r4(f.slope), peak: r4(f.peak), argmax: f.argmax, delta: r4(f.delta), range: r4(f.range) } : null; };
const r4 = (x) => (x == null || !isFinite(x)) ? null : Math.round(x * 1e4) / 1e4;

function tribeIndicators(a) {
    const out = {}, shapes = {};
    const add = (id, arr, keepShape) => { const f = sliceFeat(arr); if (!f) return; out[id] = { mean: r4(f.mean), slope: r4(f.slope), peak: r4(f.peak), argmax: f.argmax, delta: r4(f.delta), range: r4(f.range) }; if (keepShape) shapes[id] = f.shape.map(r4); };
    // global (8) — keep shapes
    if (Array.isArray(a.brain_engagement_curve)) { add('eng.activation', a.brain_engagement_curve.map(p => p.activation), true); add('eng.zscore', a.brain_engagement_curve.map(p => p.activation_zscore), true); }
    if (Array.isArray(a.raw_engagement_curve)) add('eng.raw', a.raw_engagement_curve.map(p => p.activation_raw), true);
    for (const w of Object.keys(a.multi_scale_analysis || {})) add('ms.' + w, a.multi_scale_analysis[w].activation_curve, true);
    // 10 functional regions — keep shapes
    for (const r of Object.keys(a.region_activations || {})) add('reg.' + r, a.region_activations[r].timeseries, true);
    // 8 networks — keep shapes
    for (const c of Object.keys(a.functional_networks || {})) add('net.' + c, a.functional_networks[c].timeseries_raw, true);
    // 75 Destrieux — scalars only
    for (const r of Object.keys(a.destrieux_region_activations || {})) add('dx.' + r, a.destrieux_region_activations[r].timeseries, false);
    // 181 HCP — scalars only
    for (const r of Object.keys(a.hcp_roi_activations || {})) add('hcp.' + r, a.hcp_roi_activations[r].timeseries_zscore, false);
    return { out, shapes };
}

// ── tracked metrics for one video (video_data analysis.json + retention_table row) ──
function trackedMetrics(id, rrow) {
    const m = {};
    const vp = path.join(VDATA, id, 'analysis.json');
    if (fs.existsSync(vp)) {
        try {
            const a = JSON.parse(fs.readFileSync(vp, 'utf8'));
            const an = a.analytics || {}, md = a.metadata || {};
            m.views = num(an.totalViews ?? md.viewCount);
            m.avgRetention = num(an.avgRetention);                 // 0-1
            m.retentionVariation = num(an.retentionVariation);
            m.avgPercentViewed = num(an.avgPercentViewed);
            m.avgViewDuration = num(an.avgViewDuration);
            // NOTE: keep/swipe come ONLY from the account retention table (below). The legacy
            // video_data swipedAwayRate is ~0 for most videos → do NOT use it (it fabricated keep≈100).
            m.viewedRate = num(an.viewedRate);
            m.likes = num(an.likes ?? md.likeCount); m.comments = num(an.comments ?? md.commentCount); m.shares = num(an.shares);
            m.subsGained = num(an.subscribersGained); m.subViewsPct = pct(an.subscriberViews, an.totalViews);
            m.duration = num(md.duration);
            // first-5s retention shape (100-pt curve → sample at ~0..5s)
            if (Array.isArray(an.retentionCurve) && an.retentionCurve.length) {
                const dur = num(md.duration) || 0;
                const first5 = an.retentionCurve.filter(p => dur ? (p.second <= 5) : true).map(p => num(p.retention));
                if (first5.length) { m._ret5curve = first5.slice(0, 12).map(r4); m.ret5mean = r4(first5.slice(0, 6).reduce((x, y) => x + y, 0) / Math.min(6, first5.length)); }
            }
        } catch (e) {}
    }
    if (rrow) {  // keep/ret5/swipe from the REAL account retention table (the Data tab source)
        if (rrow.keep_rate != null) m.keep = num(rrow.keep_rate);
        if (rrow.swiped != null) m.swipedAwayRate = num(rrow.swiped); else if (rrow.keep_rate != null) m.swipedAwayRate = 100 - num(rrow.keep_rate);
        if (rrow.ret5 != null) m.ret5 = num(rrow.ret5);
        if (rrow.ret5_surv != null) m.ret5_surv = num(rrow.ret5_surv);
        if (m.views == null && rrow.views != null) m.views = num(rrow.views);
        if (rrow.avg_retention != null && m.avgRetention == null) m.avgRetention = num(rrow.avg_retention) / 100;
    }
    // no keep fallback: only videos in the account table have a real keep rate (others → keep stays null)
    if (m.views != null) m.logviews = r4(Math.log10(Math.max(1, m.views)));
    return m;
}
const num = (x) => { const n = Number(x); return isFinite(n) ? n : null; };
const pct = (a, b) => { a = Number(a); b = Number(b); return (isFinite(a) && isFinite(b) && b) ? r4(100 * a / b) : null; };

(async () => {
    const ids = (JSON.parse(fs.readFileSync(path.join(TDIR, '_index.json'), 'utf8')).videos || []).map(v => ({ id: v.videoId, title: v.title }));
    let rtable = {}; try { for (const r of (JSON.parse(fs.readFileSync(RTABLE, 'utf8')).videos || [])) rtable[r.id] = r; } catch (e) {}
    const rows = [];
    let i = 0;
    for (const { id, title } of ids) {
        i++;
        const tp = path.join(TDIR, id + '.json');
        if (!fs.existsSync(tp)) continue;
        let a; try { a = JSON.parse(fs.readFileSync(tp, 'utf8')); } catch (e) { continue; }
        const { out, shapes } = tribeIndicators(a);
        const metrics = trackedMetrics(id, rtable[id]);
        if (metrics.views == null && metrics.avgRetention == null) continue;   // no tracked data → skip
        rows.push({ id, title: title || id, tribe: out, shapes, metrics });
        if (i % 25 === 0) console.log(`  …${i}/${ids.length}  (kept ${rows.length})`);
    }
    // realviews: duration-deconfounded additive (keep + ret5 with log-duration partialled out), calibrated to views
    computeRealviews(rows);
    const indicatorIds = rows.length ? Object.keys(rows[0].tribe) : [];
    const out = { built_at: null, n: rows.length, hrf: HRF, win: WIN, account: 'tyler',
        indicatorIds, families: { global: 8, regions: 10, networks: 8, destrieux: 75, hcp: 181 }, rows };
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`tribe-corr: ${rows.length} joined videos × ${indicatorIds.length} Tribe indicators → ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
    if (cloud && cloud.uploadToR2) { await cloud.uploadToR2('retention/tribe-corr.json', fs.readFileSync(OUT), 'application/json'); console.log('uploaded → R2 retention/tribe-corr.json'); }
})().catch(e => { console.error(e); process.exit(1); });

// duration-deconfounded additive view model (matches the Predict-tab philosophy: partial out log-duration)
function computeRealviews(rows) {
    const R = rows.filter(r => r.metrics.keep != null && r.metrics.ret5 != null && r.metrics.views > 0 && r.metrics.duration > 0);
    if (R.length < 20) return;
    const logd = R.map(r => Math.log(r.metrics.duration)), keep = R.map(r => r.metrics.keep), ret = R.map(r => r.metrics.ret5), logv = R.map(r => Math.log(r.metrics.views));
    const resid = (y) => { const b = ols1(logd, y); return y.map((v, i) => v - (b.a + b.b * logd[i])); };
    const kr = resid(keep), rr = resid(ret), vr = resid(logv);
    const bk = ols1(kr, vr).b, br = ols1(rr, vr).b;   // deconfounded slopes
    const mv = logv.reduce((a, b) => a + b, 0) / logv.length;
    R.forEach((r, i) => { const est = mv + bk * kr[i] + br * rr[i]; r.metrics.realviews = r4(Math.exp(est)); });
}
function ols1(x, y) { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx); } const b = sxx ? sxy / sxx : 0; return { a: my - b * mx, b }; }
