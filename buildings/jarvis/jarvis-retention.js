/**
 * jarvis-retention.js — "Retention × Swipe → Views" study tab.
 * Visualises retention-study/retention_study.json: era diagnosis, the three
 * questions through magnitude lenses (not one R²), scatter, and example curves.
 */
const JarvisRetention = (function () {
    'use strict';
    const C = { bg: '#0b1120', card: '#0f172a', card2: '#131c30', border: '#1e293b', border2: '#27364d',
        text: '#e2e8f0', dim: '#94a3b8', mute: '#64748b', faint: '#475569', cyan: '#22d3ee', green: '#34d399',
        orange: '#fb923c', red: '#f87171', purple: '#a78bfa', yellow: '#fbbf24', accent: '#38bdf8' };
    let root = null, S = null, err = null;
    const st = { sec: 'overview' };
    const SEC = [['overview', '① Data & Era'], ['q1', '② Q1 · Views'], ['q2', '③ Q2 · Shape'], ['q3', '④ Q3 · Swipe'], ['scatter', '⑤ Scatter']];
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmt = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
    const fv = x => x == null ? '—' : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(0) + 'K' : '' + Math.round(x);
    const h2 = (t, s) => `<div style="margin-bottom:14px"><div style="font-size:19px;font-weight:800;color:${C.text}">${t}</div>${s ? `<div style="font-size:12.5px;color:${C.dim};margin-top:3px;line-height:1.5">${s}</div>` : ''}</div>`;
    const card = (i, p = 14) => `<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:${p}px;margin-bottom:12px">${i}</div>`;
    const note = (h, c) => `<div style="background:${(c || C.cyan)}12;border-left:3px solid ${c || C.cyan};border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:12px;font-size:12px;color:${C.dim};line-height:1.55">${h}</div>`;
    const stat = (l, v, c) => `<div style="background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:8px 12px"><div style="font-size:10px;color:${C.mute};text-transform:uppercase">${l}</div><div style="font-size:16px;font-weight:800;color:${c || C.text}">${v}</div></div>`;

    function hist(vals, mask, lo, hi, nb, label) {
        const w = 540, h = 150, pad = 30, bw = (w - pad * 2) / nb;
        const bins = new Array(nb).fill(0), binsB = new Array(nb).fill(0);
        vals.forEach((v, i) => { const b = Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / (hi - lo) * nb))); (mask && mask[i] ? binsB : bins)[b]++; });
        const mx = Math.max(...bins.map((c, i) => c + binsB[i]), 1);
        let s = '';
        for (let i = 0; i < nb; i++) {
            const x = pad + i * bw, ha = (bins[i] / mx) * (h - pad * 1.5), hb = (binsB[i] / mx) * (h - pad * 1.5);
            s += `<rect x="${x + 1}" y="${h - pad - ha}" width="${bw - 2}" height="${ha}" fill="${C.faint}"/>`;
            if (mask) s += `<rect x="${x + 1}" y="${h - pad - ha - hb}" width="${bw - 2}" height="${hb}" fill="${C.accent}"/>`;
        }
        s += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        s += `<text x="${pad}" y="${h - 8}" fill="${C.mute}" font-size="9">${lo}</text><text x="${w - pad}" y="${h - 8}" text-anchor="end" fill="${C.mute}" font-size="9">${hi}</text>`;
        s += `<text x="${w / 2}" y="13" text-anchor="middle" fill="${C.dim}" font-size="10">${label}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${s}</svg>`;
    }
    function binbars(bins, label, unit) {
        const valid = bins.filter(b => b.n > 0); const mx = Math.max(...valid.map(b => b.median_views || 0), 1);
        const w = 540, rh = 30, h = valid.length * rh + 26;
        let s = `<text x="0" y="12" fill="${C.dim}" font-size="11" font-weight="700">${label}</text>`;
        valid.forEach((b, i) => {
            const y = 22 + i * rh, len = (b.median_views / mx) * (w - 230);
            s += `<text x="0" y="${y + 14}" fill="${C.mute}" font-size="10">${b.lo}–${b.hi}${unit} (n=${b.n})</text>`;
            s += `<rect x="120" y="${y + 4}" width="${Math.max(1, len)}" height="14" rx="2" fill="${C.cyan}" opacity="0.8"/>`;
            s += `<text x="${120 + len + 5}" y="${y + 15}" fill="${C.text}" font-size="10">${fv(b.median_views)}</text>`;
        });
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${s}</svg>`;
    }
    function scatter(pts, xk, xlabel, xlo, xhi) {
        const w = 540, h = 320, pad = 38;
        const X = v => pad + ((v - xlo) / (xhi - xlo)) * (w - pad * 2);
        const ys = pts.map(p => p.lv), ylo = Math.min(...ys), yhi = Math.max(...ys);
        const Y = v => h - pad - ((v - ylo) / (yhi - ylo || 1)) * (h - pad * 2);
        let s = '';
        pts.forEach(p => { s += `<circle cx="${X(p[xk])}" cy="${Y(p.lv)}" r="3.2" fill="${p.modern ? C.accent : C.faint}" opacity="0.7"><title>${esc(p.name)} · ${xlabel} ${p[xk]} · ${fv(Math.pow(10, p.lv))} views</title></circle>`; });
        s += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        s += `<text x="${w / 2}" y="${h - 6}" text-anchor="middle" fill="${C.mute}" font-size="10">${xlabel}</text><text x="10" y="${pad}" fill="${C.mute}" font-size="9">log views</text>`;
        s += `<text x="${w - pad}" y="14" text-anchor="end" fill="${C.accent}" font-size="9">● modern</text><text x="${w - pad - 70}" y="14" text-anchor="end" fill="${C.faint}" font-size="9">● legacy</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg>`;
    }
    function curves(ex) {
        const w = 540, h = 220, pad = 34;
        const X = t => pad + t * (w - pad * 2), Y = v => h - pad - Math.min(v, 2) / 2 * (h - pad * 2);
        const cols = [C.red, C.orange, C.yellow, C.green, C.cyan, C.purple];
        let s = `<line x1="${pad}" y1="${Y(1)}" x2="${w - pad}" y2="${Y(1)}" stroke="${C.border2}" stroke-dasharray="4 3"/><text x="${w - pad}" y="${Y(1) - 3}" text-anchor="end" fill="${C.mute}" font-size="8">100%</text>`;
        ex.forEach((e, k) => { let p = ''; e.curve.forEach((v, i) => p += (i ? 'L' : 'M') + X(i / 99) + ' ' + Y(v) + ' '); s += `<path d="${p}" fill="none" stroke="${cols[k % 6]}" stroke-width="1.5" opacity="0.85"/>`; });
        s += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/><text x="${pad}" y="${h - 8}" fill="${C.mute}" font-size="9">0%</text><text x="${w - pad}" y="${h - 8}" text-anchor="end" fill="${C.mute}" font-size="9">100% of duration</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${s}</svg><div style="font-size:10px;color:${C.mute};margin-top:4px">${ex.map((e, k) => `<span style="color:${cols[k % 6]}">●</span> ${esc(e.name)} (ret ${fmt(e.ret, 0)}%, ${fv(e.views)})`).join(' &nbsp; ')}</div>`;
    }

    function overview() {
        const e = S.era, m = S.meta;
        let h = h2('Retention × Swipe → Views — what the data actually says',
            `${m.n} of your videos with the full per-% retention curve + real swipe metric, last 3 years. Target: log views.`);
        h += card(`<div style="font-weight:700;color:${C.red};margin-bottom:6px">⚠ The swipe metric changed mid-window</div>
            <div style="font-size:12px;color:${C.dim};line-height:1.6">Swipe is <b>bimodal by era</b>: videos older than ~1.5yr report a median <b>${fmt(e.legacy_swipe_median, 1)}%</b> swipe (the old/partial metric — implausible 99% "stayed"), while the last ~1.5yr report a realistic <b>${fmt(e.modern_swipe_median, 1)}%</b>. Pooling them is invalid — <b>all swipe analysis below uses the modern cohort only (n=${e.modern_n})</b>. Blue = modern, grey = legacy.</div>
            ${hist(S.dist.swipe, S.dist.modern_mask, 0, 55, 22, 'swipe-away % — two clusters = two metric eras')}`);
        h += note(`<b>The selection caveat that governs everything:</b> every video here is a <b>winner</b> (60K–285M views). The videos that <i>died</i> with high swipe never got analysed, so they're absent. That's why swipe looks weak in-sample even though, across the <i>full</i> population, swipe gates whether a video lives at all. We measure survivors; the impression count swipe actually controls isn't in the export.`, C.orange);
        h += note(`<b>Replay is universal:</b> every curve starts above 100% (mean ${fmt(m.mean_start_retention * 100, 0)}%) — rewatch/replay inflation, exactly as expected. Handled by reading the curve net of it.`, C.cyan);
        return h;
    }
    function q1() {
        const Q = S.Q1, d = Q.decomp_modern;
        let h = h2('Q1 — How much do retention & swipe move views?', 'Through three lenses, not one number: rank correlation, the actual view magnitudes by bin, and confound-controlled CV-R² with duration first-class.');
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Lens 1 — rank correlation with views</div>
            <table style="width:100%;font-size:12px;border-collapse:collapse">
            <tr><td style="padding:4px;color:${C.dim}">Retention (all)</td><td style="text-align:right;color:${C.green}">${fmt(Q.retention_all.spearman_views, 2)}</td></tr>
            <tr><td style="padding:4px;color:${C.dim}">Swipe (modern cohort)</td><td style="text-align:right;color:${Math.abs(Q.swipe_modern.spearman_views) > 0.2 ? C.green : C.mute}">${fmt(Q.swipe_modern.spearman_views, 2)}</td></tr>
            <tr><td style="padding:4px;color:${C.dim}">Duration (all)</td><td style="text-align:right;color:${C.mute}">${fmt(Q.duration_all.spearman_views, 2)}</td></tr>
            <tr><td style="padding:4px;color:${C.faint}">Swipe pooled (INVALID — era artifact)</td><td style="text-align:right;color:${C.faint}">${fmt(Q.swipe_pooled_INVALID.spearman_views, 2)}</td></tr></table>`);
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Lens 2 — actual median views by bin (the magnitude view)</div>
            ${binbars(Q.bins.views_by_retention, 'by retention %', '%')}
            <div style="height:8px"></div>${binbars(Q.bins.views_by_swipe_modern, 'by swipe % (modern)', '%')}
            <div style="height:8px"></div>${binbars(Q.bins.views_by_duration, 'by duration', 's')}`);
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Lens 3 — confound-controlled (modern cohort, n=${d.n})</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${stat('ret+swipe alone', fmt(d.naive_cv_r2, 2), d.naive_cv_r2 > 0 ? C.green : C.orange)}
            ${stat('+ duration', fmt(d.content_plus_duration_cv_r2, 2), C.green)}
            ${stat('view spread (80%)', '×/÷ ' + fmt(d.view_range_mult_80pct, 1), C.orange)}</div>`);
        h += note(`<b>The honest answer:</b> within the comparable cohort, retention & swipe are <b>weak</b> predictors of views — swipe rank-correlation is ${fmt(Q.swipe_modern.spearman_views, 2)} (~noise), retention ${fmt(Q.retention_all.spearman_views, 2)} (modest). <b>Duration is the bigger lever</b> — adding it lifts CV-R² from ${fmt(d.naive_cv_r2, 2)} to ${fmt(d.content_plus_duration_cv_r2, 2)}. Even with all three, at fixed values views still swing <b>×/÷ ${fmt(d.view_range_mult_80pct, 1)}</b>. The dominant driver — the algorithm's impression push — isn't in the data, and the failures are missing (selection). So this is a floor on the true effect, not a ceiling.`, C.orange);
        return h;
    }
    function q2() {
        const Q = S.Q2;
        let h = h2('Q2 — Does the curve SHAPE matter beyond the average?', 'Functional-PCA of the 100-point curves: modes orthogonal to the level. Does adding shape improve view prediction beyond the average % viewed?');
        h += card(`<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
            ${stat('avg retention only', fmt(Q.cv_r2_avg_only, 3), C.mute)}
            ${stat('+ curve shape', fmt(Q.cv_r2_avg_plus_shape, 3), Q.shape_delta_r2 > 0 ? C.green : C.orange)}
            ${stat('shape adds (ΔR²)', (Q.shape_delta_r2 >= 0 ? '+' : '') + fmt(Q.shape_delta_r2, 3), Q.shape_delta_r2 > 0 ? C.green : C.red)}</div>
            <div style="font-weight:700;color:${C.text};margin:6px 0">Example curves — lowest vs highest avg retention</div>${curves(S.example_curves)}`);
        h += note(`<b>Yes — shape adds${Q.shape_delta_r2 > 0 ? ' a little' : ' nothing'} (Δ ${(Q.shape_delta_r2 >= 0 ? '+' : '') + fmt(Q.shape_delta_r2, 3)}).</b> ${Q.shape_delta_r2 > 0 ? 'Where the drop happens carries view-relevant info beyond the average — two videos with the same average % viewed but different shapes are NOT equivalent. But both signals are small overall.' : 'The average % viewed captures essentially all the view-relevant retention signal.'}`, Q.shape_delta_r2 > 0 ? C.green : C.orange);
        return h;
    }
    function q3() {
        const Q = S.Q3;
        let h = h2('Q3 — Can swipe be inferred from retention? Can we drop it?', 'Swipe is the feed stop-or-scroll decision — a different funnel stage than in-video retention.');
        h += card(`<div style="display:flex;gap:10px;flex-wrap:wrap">
            ${stat('infer swipe from retention', 'R² ' + fmt(Q.swipe_from_retention_cv_r2, 2), C.red)}
            ${stat('residual', '±' + fmt(Q.swipe_resid_sd_pct, 0) + '% swipe', C.orange)}
            ${stat('swipe adds for views', (Q.swipe_adds_for_views >= 0 ? '+' : '') + fmt(Q.swipe_adds_for_views, 3), C.mute)}</div>`);
        h += note(`<b>No, you can't infer swipe from retention</b> (R² ${fmt(Q.swipe_from_retention_cv_r2, 2)}, ±${fmt(Q.swipe_resid_sd_pct, 0)}%) — they're different funnel stages (feed-stop vs in-video hold). <b>But swipe is redundant for predicting views</b> over retention+duration (adds ${(Q.swipe_adds_for_views >= 0 ? '+' : '') + fmt(Q.swipe_adds_for_views, 3)}), so you can simplify the view model to retention+duration — you just can't reconstruct swipe itself.`, C.purple);
        return h;
    }
    function scatterSec() {
        let h = h2('Scatter — see it for yourself', 'log views vs each metric. Blue = modern (real swipe), grey = legacy (old metric). Hover for the video.');
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:6px">Swipe vs views</div>${scatter(S.scatter, 'swipe', 'swipe %', 0, 55)}`);
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:6px">Retention vs views</div>${scatter(S.scatter, 'ret', 'avg retention %', 50, 110)}`);
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:6px">Duration vs views</div>${scatter(S.scatter, 'dur', 'duration s', 30, 180)}`);
        return h;
    }
    function bodyFor() { return ({ overview, q1, q2, q3, scatter: scatterSec }[st.sec] || overview)(); }
    function rerender() {
        if (!root) return;
        const nav = SEC.map(([id, l]) => `<button data-rs="${id}" style="background:${st.sec === id ? C.accent + '22' : 'transparent'};border:1px solid ${st.sec === id ? C.accent : C.border};color:${st.sec === id ? C.accent : C.dim};border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer">${l}</button>`).join('');
        root.innerHTML = `<div style="background:${C.bg};border-radius:12px;padding:16px;color:${C.text};font-family:'Nunito',sans-serif">
            <div style="font-size:21px;font-weight:900;color:${C.accent};margin-bottom:8px">Retention × Swipe → Views</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">${nav}</div><div>${S ? bodyFor() : 'Loading…'}</div></div>`;
    }
    function onClick(e) { const b = e.target.closest('[data-rs]'); if (b) { st.sec = b.getAttribute('data-rs'); rerender(); } }
    async function mount(el) {
        root = el;
        if (!root.__rsb) { root.addEventListener('click', onClick); root.__rsb = true; }
        if (!S && !err) {
            root.innerHTML = `<div style="padding:40px;text-align:center;color:${C.dim}">Loading study…</div>`;
            try { S = await fetch('./buildings/jarvis/retention-study/retention_study.json').then(r => r.json()); }
            catch (e) { err = e; root.innerHTML = `<div style="padding:24px;color:${C.red}">Failed to load: ${esc(e.message)}</div>`; return; }
        }
        rerender();
    }
    return { mount };
})();
if (typeof window !== 'undefined') window.JarvisRetention = JarvisRetention;
if (typeof module !== 'undefined' && module.exports) module.exports = JarvisRetention;
