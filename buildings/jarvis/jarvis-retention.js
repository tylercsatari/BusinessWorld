/**
 * jarvis-retention.js — "Retention → Views" AUDIT TABLE.
 * No analysis. Every video with its raw, verifiable numbers (swipe, stayed,
 * retention, views, duration), sortable + searchable, each row clickable to see
 * its retention curve and open it on YouTube to confirm against YouTube Studio.
 * Accuracy first; analysis only after the data is trusted.
 */
const JarvisRetention = (function () {
    'use strict';
    const C = { bg: '#0b1120', card: '#0f172a', card2: '#131c30', border: '#1e293b', border2: '#27364d',
        text: '#e2e8f0', dim: '#94a3b8', mute: '#64748b', faint: '#475569', cyan: '#22d3ee', green: '#34d399',
        orange: '#fb923c', red: '#f87171', purple: '#a78bfa', yellow: '#fbbf24', accent: '#38bdf8' };
    let root = null, DATA = null, S = null, err = null;
    const st = { sec: 'data', sort: 'views', dir: -1, q: '', open: null };
    const fmtv = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
    const sgn = (v, d = 2) => (v >= 0 ? '+' : '') + fmtv(v, d);
    const note = (h, c) => `<div style="background:${(c || C.cyan)}12;border-left:3px solid ${c || C.cyan};border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:12px;font-size:12px;color:${C.dim};line-height:1.55">${h}</div>`;
    const statc = (l, v, c) => `<div style="background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:8px 12px"><div style="font-size:10px;color:${C.mute};text-transform:uppercase">${l}</div><div style="font-size:16px;font-weight:800;color:${c || C.text}">${v}</div></div>`;
    const cardc = (i, p = 14) => `<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:${p}px;margin-bottom:12px">${i}</div>`;
    const h2c = (t, s) => `<div style="margin-bottom:14px"><div style="font-size:18px;font-weight:800;color:${C.text}">${t}</div>${s ? `<div style="font-size:12px;color:${C.dim};margin-top:3px;line-height:1.5">${s}</div>` : ''}</div>`;
    function binbars(bins, label, unit) {
        const ok = bins.filter(b => b.n > 0), mx = Math.max(...ok.map(b => b.median_views || 0), 1);
        const w = 520, rh = 28, h = ok.length * rh + 24;
        let s = `<text x="0" y="12" fill="${C.dim}" font-size="11" font-weight="700">${label}</text>`;
        ok.forEach((b, i) => { const y = 22 + i * rh, len = (b.median_views / mx) * (w - 240);
            s += `<text x="0" y="${y + 13}" fill="${C.mute}" font-size="10">${b.lo}–${b.hi}${unit} (n=${b.n})</text><rect x="130" y="${y + 3}" width="${Math.max(1, len)}" height="13" rx="2" fill="${C.cyan}" opacity="0.8"/><text x="${130 + len + 5}" y="${y + 14}" fill="${C.text}" font-size="10">${fv(b.median_views)}</text>`; });
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${s}</svg>`;
    }
    // Raw-data scatter: every video a clickable point (opens on YouTube). Shows the cloud
    // behind each correlation + a least-squares trend so you see how tight/loose it really is.
    function scatter(xk, xlabel, color, opt) {
        opt = opt || {}; const yk = opt.yk || 'lv', ylog = opt.ylog !== false;
        const pts = (S.scatter || []).filter(p => p[xk] != null && isFinite(p[xk]) && p[yk] != null);
        if (!pts.length) return '';
        const w = 520, h = 250, pl = 46, pr = 12, ptp = 12, pb = 32;
        const xs = pts.map(p => p[xk]), ys = pts.map(p => p[yk]);
        const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
        const X = x => pl + (x - xmin) / (xmax - xmin || 1) * (w - pl - pr);
        const Y = y => h - pb - (y - ymin) / (ymax - ymin || 1) * (h - ptp - pb);
        const n = pts.length, sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0);
        const sxx = xs.reduce((a, b) => a + b * b, 0), sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
        const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), icpt = (sy - slope * sx) / n;
        let s = `<line x1="${pl}" y1="${h - pb}" x2="${w - pr}" y2="${h - pb}" stroke="${C.border2}"/><line x1="${pl}" y1="${ptp}" x2="${pl}" y2="${h - pb}" stroke="${C.border2}"/>`;
        if (ylog) for (let d = Math.ceil(ymin); d <= Math.floor(ymax); d++) { const yy = Y(d); s += `<line x1="${pl}" y1="${yy}" x2="${w - pr}" y2="${yy}" stroke="${C.border}" stroke-dasharray="3 3"/><text x="${pl - 4}" y="${yy + 3}" text-anchor="end" fill="${C.mute}" font-size="8">${fv(Math.pow(10, d))}</text>`; }
        s += `<line x1="${X(xmin)}" y1="${Y(slope * xmin + icpt)}" x2="${X(xmax)}" y2="${Y(slope * xmax + icpt)}" stroke="${color}" stroke-width="2" opacity="0.45" stroke-dasharray="5 3"/>`;
        pts.forEach(p => { s += `<a href="${esc(p.url)}" target="_blank"><circle cx="${X(p[xk])}" cy="${Y(p[yk])}" r="3.1" fill="${color}" opacity="0.6"><title>${esc(p.name)} — ${fv(p.views)} views · ${xlabel} ${fmt(p[xk], 0)}</title></circle></a>`; });
        s += `<text x="${(pl + w - pr) / 2}" y="${h - 4}" text-anchor="middle" fill="${C.dim}" font-size="10">${xlabel} →</text>`;
        s += `<text x="11" y="${(ptp + h - pb) / 2}" fill="${C.dim}" font-size="10" transform="rotate(-90 11 ${(ptp + h - pb) / 2})">${opt.ylabel || 'views (log)'} →</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg>`;
    }
    // Keep × Retention synergy: median views in each (keep band × retention band) cell.
    function heatmap() {
        const I = S.interaction; if (!I) return '';
        const g = I.grid_median_views, gn = I.grid_n, ke = I.keep_edges, re = I.ret_edges;
        const logs = g.flat().filter(v => v != null).map(v => Math.log10(v)), lo = Math.min(...logs), hi = Math.max(...logs);
        const col = v => { if (v == null) return C.card2; const t = (Math.log10(v) - lo) / ((hi - lo) || 1); return `rgb(${Math.round(15 + t * 20)},${Math.round(45 + t * 165)},${Math.round(70 + t * 70)})`; };
        let cells = `<div></div>`;
        for (let j = 0; j < re.length - 1; j++) cells += `<div style="text-align:center;font-size:10px;color:${C.green};padding:2px">${re[j]}–${re[j + 1]}%</div>`;
        for (let i = g.length - 1; i >= 0; i--) {
            cells += `<div style="font-size:10px;color:${C.cyan};display:flex;align-items:center;justify-content:flex-end;padding-right:6px;text-align:right;font-weight:700">${ke[i]}–${ke[i + 1]}%</div>`;
            for (let j = 0; j < g[i].length; j++) { const v = g[i][j]; cells += `<div style="background:${col(v)};border-radius:6px;padding:10px 4px;text-align:center;min-height:48px;display:flex;flex-direction:column;justify-content:center"><div style="font-size:14px;font-weight:800;color:#fff">${v == null ? '—' : fv(v)}</div><div style="font-size:9px;color:rgba(255,255,255,0.55)">n=${gn[i][j]}</div></div>`; }
        }
        return `<div style="display:grid;grid-template-columns:62px repeat(${re.length - 1},1fr);gap:5px">${cells}</div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:${C.dim};margin-top:6px"><span>↑ rows = keep rate · columns = retention →</span><span>cell = median views (n videos)</span></div>`;
    }
    // Overlay several retention curves (mean, shape ±, example videos) on one axis.
    function curvesSvg(series, cap) {
        const w = 520, h = 180, pad = 30;
        const X = t => pad + t * (w - pad * 2), Y = v => h - pad - Math.min(v, 2) / 2 * (h - pad * 2);
        let s = `<line x1="${pad}" y1="${Y(1)}" x2="${w - pad}" y2="${Y(1)}" stroke="${C.border2}" stroke-dasharray="4 3"/><text x="${w - pad}" y="${Y(1) - 3}" text-anchor="end" fill="${C.mute}" font-size="8">100%</text>`;
        series.forEach(se => { let p = ''; se.curve.forEach((v, i) => p += (i ? 'L' : 'M') + X(i / 99) + ' ' + Y(v) + ' '); s += `<path d="${p}" fill="none" stroke="${se.color}" stroke-width="${se.w || 2}" ${se.dash ? `stroke-dasharray="${se.dash}"` : ''} opacity="${se.op || 1}"/>`; });
        s += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/><text x="${pad}" y="${h - 8}" fill="${C.mute}" font-size="9">start</text><text x="${w - pad}" y="${h - 8}" text-anchor="end" fill="${C.mute}" font-size="9">end of video</text>`;
        const leg = series.filter(se => se.label).map((se, i) => `<g transform="translate(${pad + i * 132} 12)"><line x1="0" y1="-3" x2="16" y2="-3" stroke="${se.color}" stroke-width="2.5" ${se.dash ? `stroke-dasharray="${se.dash}"` : ''}/><text x="20" y="0" fill="${C.dim}" font-size="9">${esc(se.label)}</text></g>`).join('');
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${leg}${s}</svg>`;
    }
    // Correlation heatmap between indicators — find what's redundant vs independent.
    function corrGrid(M) {
        const k = M.keys, lab = M.labels, rho = M.rho, n = k.length;
        const col = r => { const a = Math.abs(r), t = Math.min(a, 1); return r >= 0 ? `rgba(56,189,248,${0.12 + t * 0.7})` : `rgba(251,146,60,${0.12 + t * 0.7})`; };
        let head = `<th style="padding:3px"></th>` + lab.map(l => `<th style="font-size:8px;color:${C.mute};font-weight:600;padding:2px;height:58px"><div style="writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;margin:0 auto">${esc(l)}</div></th>`).join('');
        let rows = '';
        for (let i = 0; i < n; i++) { rows += `<tr><td style="font-size:9px;color:${C.dim};text-align:right;padding:2px 5px;white-space:nowrap">${esc(lab[i])}</td>`;
            for (let j = 0; j < n; j++) { const r = rho[i][j]; rows += `<td style="background:${i === j ? C.border : col(r)};text-align:center;font-size:8px;color:${Math.abs(r) > 0.5 ? '#fff' : C.dim};padding:5px 3px;font-weight:${Math.abs(r) > 0.6 ? 800 : 400}">${i === j ? '' : (r > 0 ? '' : '') + r.toFixed(2).replace('0.', '.')}</td>`; }
            rows += `</tr>`; }
        return `<table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
            <div style="font-size:10px;color:${C.mute};margin-top:5px"><span style="color:${C.accent}">blue = move together</span> · <span style="color:${C.orange}">orange = opposite</span> · pale = independent. Pairs near 0 carry separate signal worth combining.</div>`;
    }
    // Ranked indicator bars: own correlation + the part independent of keep & retention.
    function indBars(inds) {
        const w = 520, rh = 26, h = inds.length * rh + 8, mx = 0.55;
        const X = v => 250 + (v / mx) * 130;
        let s = `<line x1="250" y1="0" x2="250" y2="${h}" stroke="${C.border2}"/>`;
        inds.forEach((d, i) => { const y = i * rh + 4, c = d.usable ? (d.spearman >= 0 ? C.cyan : C.orange) : C.faint;
            s += `<text x="0" y="${y + 14}" fill="${d.usable ? C.dim : C.mute}" font-size="11">${esc(d.label)}${d.usable ? '' : ' ⚠'}</text>`;
            s += `<rect x="${Math.min(250, X(d.spearman))}" y="${y + 4}" width="${Math.abs(X(d.spearman) - 250)}" height="9" rx="2" fill="${c}" opacity="0.85"/><text x="${d.spearman >= 0 ? X(d.spearman) + 4 : X(d.spearman) - 4}" y="${y + 12}" text-anchor="${d.spearman >= 0 ? 'start' : 'end'}" fill="${C.text}" font-size="9">${sgn(d.spearman)}</text>`;
            if (d.partial_kr != null) { const px = X(d.partial_kr); s += `<circle cx="${px}" cy="${y + 17}" r="2.5" fill="${C.purple}"/><text x="${px + 5}" y="${y + 20}" fill="${C.purple}" font-size="8">${sgn(d.partial_kr)} indep</text>`; } });
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto"><text x="250" y="${h}" fill="${C.mute}" font-size="8">0</text>${s}</svg>`;
    }
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
    const fv = x => x == null ? '—' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(0) + 'K' : '' + Math.round(x);

    const COLS = [
        { k: 'title', l: 'Video', w: '32%', align: 'left' },
        { k: 'published', l: 'Posted', w: '11%' },
        { k: 'keep_rate', l: 'Keep %', w: '10%' },
        { k: 'swiped', l: 'Swiped %', w: '10%' },
        { k: 'avg_retention', l: 'Retention %', w: '12%' },
        { k: 'views', l: 'Views', w: '12%' },
        { k: 'duration_s', l: 'Dur s', w: '8%' },
    ];

    function curveSvg(curve) {
        const w = 520, h = 170, pad = 30;
        const X = t => pad + t * (w - pad * 2), Y = v => h - pad - Math.min(v, 2) / 2 * (h - pad * 2);
        let s = `<line x1="${pad}" y1="${Y(1)}" x2="${w - pad}" y2="${Y(1)}" stroke="${C.border2}" stroke-dasharray="4 3"/><text x="${w - pad}" y="${Y(1) - 3}" text-anchor="end" fill="${C.mute}" font-size="8">100%</text>`;
        let p = ''; curve.forEach((v, i) => p += (i ? 'L' : 'M') + X(i / 99) + ' ' + Y(v) + ' ');
        s += `<path d="${p}" fill="none" stroke="${C.green}" stroke-width="2"/>`;
        s += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        s += `<text x="${pad}" y="${h - 8}" fill="${C.mute}" font-size="9">start</text><text x="${w - pad}" y="${h - 8}" text-anchor="end" fill="${C.mute}" font-size="9">end (100% of duration)</text>`;
        s += `<text x="${pad}" y="14" fill="${C.dim}" font-size="9">retention curve · start ${fmt(curve[0] * 100, 0)}% (replay if >100)</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg>`;
    }

    function rows() {
        let v = DATA.videos.slice();
        if (st.q) { const q = st.q.toLowerCase(); v = v.filter(r => (r.title || '').toLowerCase().includes(q) || r.id.toLowerCase().includes(q)); }
        v.sort((a, b) => { const x = a[st.sort], y = b[st.sort]; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * st.dir; });
        return v;
    }

    // The written conclusions, in the tab itself (not just chat). Pulls live numbers from S.
    function summaryBanner() {
        if (!S) return '';
        const q1 = S.Q1, q4 = S.Q4, gI = S.interaction, flat = gI ? gI.grid_median_views.flat().filter(v => v != null) : [];
        const gmx = flat.length ? Math.max(...flat) : 0, gmn = flat.length ? Math.min(...flat) : 0;
        const row = (n, t) => `<div style="display:flex;gap:9px;margin-bottom:7px;align-items:flex-start"><span style="color:${C.accent};font-weight:800;flex-shrink:0">${n}</span><span style="color:${C.dim};font-size:12px;line-height:1.5">${t}</span></div>`;
        return `<div style="background:linear-gradient(135deg,${C.card2},${C.card});border:1px solid ${C.border2};border-radius:12px;padding:16px;margin-bottom:14px">
            <div style="font-size:14px;font-weight:800;color:${C.text};margin-bottom:10px">What the data says (${S.meta.n} videos · cross-validated)</div>
            ${row('①', `<b style="color:${C.cyan}">Keep rate is your #1 content lever</b> (rank ${sgn(q1.lenses.keep.spearman)}), retention #2 (${sgn(q1.lenses.retention.spearman)}). Together they explain <b>~${Math.round(q1.cv_r2.both * 100)}%</b> of views; at a fixed pair views still swing ×/÷ ${fmtv(q1.view_range_mult_80pct, 1)}.`)}
            ${row('↗', `<b style="color:${C.accent}">They compound.</b> Both-high videos median <b>${fv(gmx)}</b> views vs <b>${fv(gmn)}</b> when both are weak — ~${Math.round(gmx / (gmn || 1))}×. In real views, keep and retention <i>multiply</i>.`)}
            ${row('②', `<b style="color:${C.green}">Curve shape</b> adds ${sgn(S.Q2.shape_delta, 3)} beyond the average — where the drop happens matters a little. (Keep ≠ retention: distinct stages, both earn their place — see <b>① Views</b>.)`)}
            ${row('③', `<b style="color:${C.cyan}">Of every extra indicator tested, only two carry NEW signal</b> beyond keep+retention: <b style="color:${C.yellow}">duration</b> (${fmtv((S.indicators.find(i => i.key === 'log_dur') || {}).partial_kr, 2)} independent) and <b style="color:${C.green}">shape mode 2</b> (${fmtv((S.indicators.find(i => i.key === 'shape_pc2') || {}).partial_kr, 2)}). Hook, ending-retention, replay are just points on the curve — already counted.`)}
            ${row('④', `<b style="color:${C.purple}">Best driveable model = keep + retention + duration</b> (R² ${fmtv(S.selection.interp.cv_r2, 2)}), which <b>tightens the prediction</b> from ×/÷ ${fmtv(S.selection.baseline_range_mult, 1)} to ×/÷ ${fmtv(S.selection.interp.range_mult, 1)}.`)}
            <div style="font-size:11px;color:${C.mute};margin-top:8px;padding-top:8px;border-top:1px solid ${C.border};line-height:1.5">Honest ceiling: this is <b>observational + winners-only</b> (all 60K–285M views), so it's strong association, not proven cause. The ~${Math.round((1 - S.selection.interp.cv_r2) * 100)}% still unexplained is mostly the algorithm's impression push + topic + timing, which aren't in this data. <b>③ Drivers</b> ranks every indicator; <b>⑤ Predict</b> gives the expected-views range. Open each tab for the raw scatter behind every claim.</div></div>`;
    }
    function renderData() {
        const v = rows();
        const head = COLS.map(c => `<th data-sort="${c.k}" style="text-align:${c.align || 'right'};width:${c.w};padding:7px 8px;font-size:11px;color:${st.sort === c.k ? C.accent : C.mute};cursor:pointer;user-select:none;white-space:nowrap">${c.l}${st.sort === c.k ? (st.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
        const body = v.map(r => {
            const open = st.open === r.id;
            const tr = `<tr data-row="${r.id}" style="border-bottom:1px solid ${C.border};cursor:pointer;background:${open ? C.card2 : 'transparent'}">
                <td style="padding:7px 8px;color:${C.text};font-size:12px">${esc((r.title || r.id).slice(0, 54))}</td>
                <td style="text-align:right;padding:7px 8px;color:${C.dim};font-size:11px">${r.published || '—'}</td>
                <td style="text-align:right;padding:7px 8px;color:${C.cyan};font-size:12px;font-weight:700">${r.keep_rate == null ? '—' : fmt(r.keep_rate, 1)}</td>
                <td style="text-align:right;padding:7px 8px;color:${C.orange};font-size:12px">${r.swiped == null ? '—' : fmt(r.swiped, 1)}</td>
                <td style="text-align:right;padding:7px 8px;color:${C.green};font-size:12px">${fmt(r.avg_retention, 1)}</td>
                <td style="text-align:right;padding:7px 8px;color:${C.text};font-size:12px;font-weight:700">${fv(r.views)}</td>
                <td style="text-align:right;padding:7px 8px;color:${C.dim};font-size:11px">${fmt(r.duration_s, 0)}</td></tr>`;
            const exp = open ? `<tr><td colspan="7" style="padding:10px 14px;background:${C.card2}">
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:${C.dim}">
                    <a href="${esc(r.url)}" target="_blank" style="background:${C.accent}22;border:1px solid ${C.accent};color:${C.accent};border-radius:6px;padding:4px 10px;font-weight:700;text-decoration:none">▶ Open on YouTube ↗</a>
                    <span style="background:${C.card};border:1px solid ${C.border};border-radius:6px;padding:4px 10px">id: ${esc(r.id)}</span>
                    <span style="background:${C.card};border:1px solid ${C.border};border-radius:6px;padding:4px 10px;color:${C.cyan}">kept ${fmt(r.keep_rate, 1)}% · swiped ${fmt(r.swiped, 1)}%</span>
                    ${r.nonsub_keep != null ? `<span style="background:${C.card};border:1px solid ${C.border};border-radius:6px;padding:4px 10px">non-sub keep ${fmt(r.nonsub_keep, 1)}%</span>` : ''}
                    <span style="background:${C.card};border:1px solid ${C.border};border-radius:6px;padding:4px 10px">👍 ${fv(r.likes)} · 💬 ${fv(r.comments)} · ↗ ${fv(r.shares)}</span>
                </div>${r.curve ? curveSvg(r.curve) : ''}
                <div style="font-size:10px;color:${C.mute};margin-top:6px">Verify in YouTube Studio: Keep % = "Viewed" in Viewed-vs-Swiped-Away, retention = "average percentage viewed". Keep + Swiped = 100. ${r.scraped_at ? 'Scraped ' + esc((r.scraped_at || '').slice(0, 10)) : ''}</div></td></tr>` : '';
            return tr + exp;
        }).join('');
        const kr = DATA.videos.map(r => r.keep_rate).filter(x => x != null).sort((a, b) => a - b);
        const krMed = kr.length ? kr[kr.length >> 1] : 0;
        return summaryBanner() + `<div style="font-size:12px;color:${C.dim};margin-bottom:12px">${DATA.meta.n} videos with the <b style="color:${C.cyan}">real Keep rate</b> (Viewed-vs-Swiped-Away, scraped from Studio) + retention curve + views. Keep rate ${kr.length ? kr[0] : '—'}–${kr.length ? kr[kr.length - 1] : '—'}% (median ${krMed}%). Click any row for its curve + YouTube link to confirm in Studio.</div>
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
                <input data-q value="${esc(st.q)}" placeholder="search title…" style="background:${C.card2};border:1px solid ${C.border};color:${C.text};border-radius:8px;padding:7px 11px;font-size:13px;width:220px;font-family:inherit"/>
                <span style="font-size:11px;color:${C.mute};margin-left:auto">${v.length} shown · click a header to sort</span></div>
            <div style="overflow-x:auto;border:1px solid ${C.border};border-radius:10px">
                <table style="width:100%;border-collapse:collapse;min-width:680px"><thead><tr style="background:${C.card2};border-bottom:1px solid ${C.border2}">${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }

    function renderQ1() {
        const Q = S.Q1, cv = Q.cv_r2;
        let h = h2c('Q1 — How much do Keep rate & Retention move views?', `On your ${S.meta.n} videos. Three lenses: rank correlation, the actual view magnitudes by bin, and cross-validated variance explained.`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:6px">Rank correlation with views (Spearman)</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${statc('Keep rate', sgn(Q.lenses.keep.spearman), Q.lenses.keep.spearman > 0.4 ? C.green : C.cyan)}${statc('Retention', sgn(Q.lenses.retention.spearman), C.green)}${statc('Keep↔Retention', sgn(Q.lenses.keep_vs_retention), C.mute)}</div>`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">The raw cloud — every dot is one of your videos (click it to open on YouTube)</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">Dashed line = trend. The spread around it is the part keep/retention <i>don't</i> explain.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div><div style="font-size:11px;color:${C.cyan};margin-bottom:3px">Keep rate → views</div>${scatter('keep', 'keep rate %', C.cyan)}</div>
                <div><div style="font-size:11px;color:${C.green};margin-bottom:3px">Retention → views</div>${scatter('ret', 'retention %', C.green)}</div></div>`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Median views by bin (the magnitude view)</div>${binbars(Q.bins.views_by_keep, 'by keep rate %', '%')}<div style="height:10px"></div>${binbars(Q.bins.views_by_retention, 'by retention %', '%')}`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">When BOTH are high — the synergy</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:10px">Median views in each keep × retention cell. Watch the corner: low-keep + low-retention sits near the bottom, both-high explodes.</div>${heatmap()}`);
        const gI = S.interaction, flat = gI ? gI.grid_median_views.flat().filter(v => v != null) : [], gmx = flat.length ? Math.max(...flat) : 0, gmn = flat.length ? Math.min(...flat) : 0;
        h += note(`<b>You were right about the compounding.</b> Top-keep + top-retention videos median <b>${fv(gmx)}</b> views vs <b>${fv(gmn)}</b> in the weak corner — a <b>~${Math.round(gmx / (gmn || 1))}×</b> gap. It's multiplicative: in log-views the model is additive, which means in real views keep and retention <i>multiply</i>. (A separate keep×retention term adds only ${sgn(gI ? gI.interaction_delta_r2 : 0, 3)} — the synergy is already baked into that multiply, not an extra bonus on top.)`, C.accent);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Variance explained (cross-validated R²)</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${statc('keep alone', fmtv(cv.keep_alone, 2), C.cyan)}${statc('retention alone', fmtv(cv.retention_alone, 2), C.green)}${statc('both', fmtv(cv.both, 2), C.accent)}${statc('content-unique', fmtv(Q.content_unique_r2, 2), C.purple)}${statc('view spread 80%', '×/÷ ' + fmtv(Q.view_range_mult_80pct, 1), C.orange)}</div>`);
        h += note(`<b>Keep rate is your strongest single driver</b> (rank ${sgn(Q.lenses.keep.spearman)}). Together, keep + retention explain <b>~${Math.round(cv.both * 100)}%</b> of view variance out-of-fold (${Math.round(Q.content_unique_r2 * 100)}% uniquely, 90% CI ${Math.round(Q.content_unique_ci90[0] * 100)}–${Math.round(Q.content_unique_ci90[1] * 100)}%). Real and meaningful — but at fixed keep+retention views still swing <b>×/÷ ${fmtv(Q.view_range_mult_80pct, 1)}</b>; the rest is the algorithm's push, topic, and timing, which aren't in this data. That irreducible spread is exactly why the <b>⑤ Predict</b> tab gives a <i>range</i>, not a single number.`, C.green);
        // Keep deep-dive (folded in from the old Keep tab): is keep just retention in disguise?
        const Q3 = S.Q3;
        h += h2c('Keep rate vs Retention — distinct stages?', 'Keep rate = the feed stop-or-scroll decision; retention = the in-video hold. The data says related but not redundant.');
        h += cardc(`<div style="display:flex;gap:10px;flex-wrap:wrap">${statc('infer keep from retention', 'R² ' + fmtv(Q3.keep_from_retention_cv_r2, 2), Q3.keep_from_retention_cv_r2 > 0.3 ? C.orange : C.red)}${statc('residual', '±' + fmtv(Q3.keep_resid_sd_pct, 0) + '%', C.orange)}${statc('keep adds for views', sgn(Q3.keep_adds_for_views, 3), Q3.keep_adds_for_views > 0.05 ? C.green : C.mute)}</div>`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Retention → Keep rate (each dot a video)</div><div style="font-size:11px;color:${C.mute};margin-bottom:8px">If keep were just retention in disguise these would sit on a tight line. They're related but distinct — so both earn their place.</div>${scatter('ret', 'retention %', C.purple, { yk: 'keep', ylog: false, ylabel: 'keep rate %' })}`);
        h += note(`Keep rate is <b>partly</b> predictable from retention (R² ${fmtv(Q3.keep_from_retention_cv_r2, 2)}, ±${fmtv(Q3.keep_resid_sd_pct, 0)}%) — but <b>not redundant</b>: it adds ${sgn(Q3.keep_adds_for_views, 3)} for views beyond retention. Keep both.`, C.purple);
        return h;
    }
    function renderQ2() {
        const Q = S.Q2;
        let h = h2c('② Shape — does the curve shape matter beyond the average?', 'Same average % viewed, different shape: an early cliff vs a gentle slide. Functional-PCA pulls out the shape that\'s independent of the level.');
        if (Q.mean_curve && Q.mode1_plus) h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">What "shape" looks like</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">The dominant shape mode, drawn as ± deformations of your average curve. Same area under the line — only <i>where</i> the drop lands changes.</div>
            ${curvesSvg([{ curve: Q.mode1_plus, color: C.green, label: 'flatter / holds late', dash: '5 3' }, { curve: Q.mean_curve, color: C.dim, label: 'average', w: 2.5 }, { curve: Q.mode1_minus, color: C.orange, label: 'early cliff', dash: '5 3' }])}`);
        if (Q.shape_examples && Q.shape_examples.length >= 2) h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Two real videos, opposite shapes</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${Q.shape_examples.map((e, i) => `<div><div style="font-size:11px;color:${i ? C.green : C.orange};margin-bottom:3px">${esc(e.kind)} · ${fv(e.views)} views</div>${curvesSvg([{ curve: e.curve, color: i ? C.green : C.orange }])}<div style="font-size:10px;color:${C.mute};margin-top:2px">${esc(e.name)}</div></div>`).join('')}</div>`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Median views by shape (front-loaded → back-loaded)</div>${binbars(Q.views_by_shape || [], 'shape mode-1 quintile', '')}`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Does shape pay beyond the average? (CV R²)</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${statc('avg retention only', fmtv(Q.cv_r2_avg, 3), C.mute)}${statc('+ curve shape', fmtv(Q.cv_r2_avg_plus_shape, 3), Q.shape_delta > 0 ? C.green : C.orange)}${statc('shape adds ΔR²', sgn(Q.shape_delta, 3), Q.shape_delta > 0 ? C.green : C.red)}</div>`);
        h += note(`<b>Yes — shape adds ${sgn(Q.shape_delta, 3)} beyond the average.</b> Two videos with identical average % viewed are <b>not</b> equivalent: where the drop happens carries real extra signal. The independent piece (Shape mode 2, ${sgn(S.indicators.find(i => i.key === 'shape_pc2') ? S.indicators.find(i => i.key === 'shape_pc2').partial_kr : 0)} after controlling keep+retention) is what the <b>③ Drivers</b> search picks up.`, Q.shape_delta > 0 ? C.green : C.orange);
        return h;
    }
    function renderIndicators() {
        const inds = S.indicators, M = S.corr_matrix, sel = S.selection;
        let h = h2c('③ Drivers — every indicator, ranked by its own pull + its independent pull', `Beyond keep & retention: ${inds.length} candidate signals. Bar = rank correlation with views; purple dot = the part left after controlling for keep+retention (its <i>independent</i> contribution).`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Indicator strength <span style="font-size:11px;color:${C.mute};font-weight:400">(⚠ = outcome-side, not a clean predictor)</span></div>${indBars(inds)}`);
        const dur = inds.find(i => i.key === 'log_dur'), pc2 = inds.find(i => i.key === 'shape_pc2');
        h += note(`Most curve features (hook, ending retention, replay) sit near <b>0 independent</b> — they're just points on the retention curve, already counted. The exceptions that carry <b>genuinely new</b> signal: <b style="color:${C.green}">duration</b> (${dur ? sgn(dur.partial_kr) : '—'} independent) and <b style="color:${C.green}">shape mode 2</b> (${pc2 ? sgn(pc2.partial_kr) : '—'}). Engagement rates correlate <i>negatively</i> but are outcome-side (consequences of how a video was pushed), so they don't go in the predictor.`, C.cyan);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">How the indicators relate to each other</div>${corrGrid(M)}`);
        // combination search — R² climbing + range shrinking, both tracks
        const pathRows = (p, base) => p.map((s, i) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px">
            <span style="color:${C.green};font-weight:700">+ ${esc(s.label)}</span>
            <span style="flex:1;height:6px;background:${C.card};border-radius:3px;overflow:hidden"><span style="display:block;height:100%;width:${Math.round(s.cv_r2 / 0.4 * 100)}%;background:${C.accent}"></span></span>
            <span style="color:${C.accent};font-weight:700;width:54px;text-align:right">R² ${fmtv(s.cv_r2, 2)}</span>
            <span style="color:${C.orange};width:70px;text-align:right">×/÷ ${fmtv(s.range_mult, 1)}</span></div>`).join('');
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Combining indicators — does the prediction tighten?</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:10px">Greedy search: keep adding the indicator that most lifts cross-validated R² until it stops paying. Baseline keep+retention = R² ${fmtv(sel.baseline_cv_r2, 2)}, range ×/÷ ${fmtv(sel.baseline_range_mult, 1)}.</div>
            <div style="font-size:11px;color:${C.cyan};font-weight:700;margin-bottom:6px">Interpretable model (drives ⑤ Predict)</div>${pathRows(sel.interp.path)}
            <div style="font-size:11px;color:${C.purple};font-weight:700;margin:12px 0 6px">Full model (any signal — the ceiling)</div>${pathRows(sel.full.path)}`);
        h += note(`Adding <b>duration</b> takes the interpretable model to R² <b>${fmtv(sel.interp.cv_r2, 2)}</b> and tightens the spread from ×/÷ ${fmtv(sel.baseline_range_mult, 1)} to <b>×/÷ ${fmtv(sel.interp.range_mult, 1)}</b>. Squeezing in the abstract shape modes (full model) reaches R² ${fmtv(sel.full.cv_r2, 2)} / ×/÷ ${fmtv(sel.full.range_mult, 1)} — a real but small extra gain. The <b>⑤ Predict</b> tab uses the interpretable model so every lever is one you can actually move.`, C.green);
        return h;
    }
    function renderQ4() {
        const Q = S.Q4;
        let h = h2c('Q4 — Duration: how does length change things?', 'Added AFTER keep + retention, to see its independent contribution and whether it changes their effect.');
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Median views by duration</div>${binbars(Q.views_by_duration, 'by duration', 's')}`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Duration → views (each dot a video)</div><div style="font-size:11px;color:${C.mute};margin-bottom:8px">Click any point to confirm the length + views on YouTube.</div>${scatter('dur', 'duration (s)', C.yellow)}`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Does duration add? (CV R²)</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${statc('keep+retention', fmtv(Q.cv_r2_content_only, 2), C.cyan)}${statc('+ duration', fmtv(Q.cv_r2_plus_duration, 2), C.green)}${statc('+ interactions', fmtv(Q.cv_r2_plus_duration_interactions, 2), C.accent)}${statc('duration-unique', fmtv(Q.duration_unique_r2, 2), C.purple)}</div>`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Do keep & retention survive controlling for duration? (partial correlation)</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${statc('keep | duration', sgn(Q.partial_keep_given_dur), C.cyan)}${statc('retention | duration', sgn(Q.partial_retention_given_dur), C.green)}</div>`);
        h += note(`<b>Duration is an independent contributor — it adds ${sgn(Q.duration_unique_r2, 2)} unique R²</b> (model goes from ${fmtv(Q.cv_r2_content_only, 2)} → ${fmtv(Q.cv_r2_plus_duration_interactions, 2)} with interactions). Crucially, it does <b>not</b> wash out keep or retention: controlling for duration, their partial correlations stay strong (${sgn(Q.partial_keep_given_dur)} and ${sgn(Q.partial_retention_given_dur)}). So keep + retention + duration are three genuinely separate levers on views.`, C.green);
        return h;
    }

    // Multi-indicator predictor (the best interpretable model from the ③ Drivers search):
    // expected views WITH a range — it can't be deterministic; the model sees only ~1/3 of what drives views.
    const SLCOL = { keep: C.cyan, retention: C.green, log_dur: C.yellow, hook: C.accent, tail: C.purple, nonsub_keep: C.cyan };
    function pval(key) { st.pvals = st.pvals || {}; const sl = S.predictor.v_best.sliders.find(s => s.key === key); return st.pvals[key] != null ? st.pvals[key] : (sl ? sl.default : 0); }
    function predictBest() {
        const vb = S.predictor.v_best, P10 = e => Math.pow(10, e); let plog = vb.intercept;
        vb.features.forEach((f, i) => { const sl = vb.sliders.find(s => s.key === f);
            let x = sl ? pval(f) : vb.feat_median[f]; if (sl && sl.transform === 'ln') x = Math.log(Math.max(x, 1));
            plog += vb.coef[i] * x; });
        const sd = vb.resid_sd_log10;
        return { mid: P10(plog), lo50: P10(plog - 0.6745 * sd), hi50: P10(plog + 0.6745 * sd), lo80: P10(plog - 1.2816 * sd), hi80: P10(plog + 1.2816 * sd) };
    }
    function predictOut() {
        const r = predictBest(), vb = S.predictor.v_best;
        const inputs = vb.sliders.map(s => `<b style="color:${SLCOL[s.key] || C.cyan}">${pval(s.key)}${s.unit}</b> ${esc(s.label.toLowerCase())}`).join(' · ');
        const bar = `<div style="position:relative;height:54px;margin:6px 0 2px">
            <div style="position:absolute;top:22px;left:0;right:0;height:10px;background:${C.card};border-radius:5px;border:1px solid ${C.border}"></div>
            <div style="position:absolute;top:22px;left:8%;right:8%;height:10px;background:linear-gradient(90deg,${C.orange}33,${C.green}55,${C.orange}33);border-radius:5px"></div>
            <div style="position:absolute;top:14px;left:50%;transform:translateX(-50%);width:4px;height:26px;background:${C.accent};border-radius:2px"></div>
            <div style="position:absolute;top:0;left:8%;transform:translateX(-50%);font-size:10px;color:${C.orange}">${fv(r.lo80)}</div>
            <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);font-size:11px;color:${C.accent};font-weight:800">${fv(r.mid)}</div>
            <div style="position:absolute;top:0;right:8%;transform:translateX(50%);font-size:10px;color:${C.orange}">${fv(r.hi80)}</div>
            <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);font-size:9px;color:${C.mute}">most-likely</div></div>`;
        return `<div style="text-align:center;margin-bottom:6px"><div style="font-size:11px;color:${C.mute}">Expected views at ${inputs}</div>
            <div style="font-size:34px;font-weight:900;color:${C.accent};line-height:1.1">${fv(r.mid)}</div></div>${bar}
            <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px">
                ${statc('50% likely between', fv(r.lo50) + ' – ' + fv(r.hi50), C.green)}
                ${statc('80% likely between', fv(r.lo80) + ' – ' + fv(r.hi80), C.orange)}</div>`;
    }
    function updatePredict() { const o = root.querySelector('#predict-out'); if (o) o.innerHTML = predictOut();
        S.predictor.v_best.sliders.forEach(s => { const el = root.querySelector('#pf-' + s.key + '-val'); if (el) el.textContent = pval(s.key) + s.unit; }); }
    function renderPredict() {
        const P = S.predictor, vb = P.v_best, sel = S.selection;
        const base = P.v2_keep_ret, P10 = e => Math.pow(10, e), baseMult = P10(1.2816 * base.resid_sd_log10), bestMult = P10(1.2816 * vb.resid_sd_log10);
        const sld = s => { const c = SLCOL[s.key] || C.cyan, val = pval(s.key); return `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="color:${c};font-weight:700">${esc(s.label)}</span><span id="pf-${s.key}-val" style="color:${C.text};font-weight:800">${val}${s.unit}</span></div>
            <input type="range" data-pf="${s.key}" min="${Math.floor(s.min)}" max="${Math.ceil(s.max)}" value="${val}" step="1" style="width:100%;accent-color:${c}"/></div>`; };
        let h = h2c('⑤ Predict — expected views from your indicators', `Slide the levers the ③ Drivers search found worth keeping (${vb.labels.join(' + ').toLowerCase()}). Cross-validated R² ${fmtv(vb.cv_r2, 2)} on your ${S.meta.n} videos.`);
        h += cardc(`<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">${statc('model R²', fmtv(vb.cv_r2, 2), C.accent)}${statc('range now', '×/÷ ' + fmtv(bestMult, 1), C.green)}${statc('vs keep+ret only', '×/÷ ' + fmtv(baseMult, 1), C.mute)}</div>
            ${vb.sliders.map(sld).join('')}
            <div id="predict-out" style="margin-top:6px;padding-top:12px;border-top:1px solid ${C.border}">${predictOut()}</div>`);
        h += note(`Adding <b>duration</b> tightened the band from ×/÷ ${fmtv(baseMult, 1)} (keep+retention only) to <b>×/÷ ${fmtv(bestMult, 1)}</b>. It's still a <b>range, not a number</b>: these levers pin down ~${Math.round(vb.cv_r2 * 100)}% of views — the other ~${Math.round((1 - vb.cv_r2) * 100)}% is the algorithm's impression push, topic, and timing, which no on-video metric can see. Center bar = best single guess; the 80% band = where it would realistically land.`, C.accent);
        return h;
    }

    function render() {
        if (!root) return;
        const SECS = [['data', '📋 Data'], ['q1', '① Views'], ['q2', '② Shape'], ['ind', '③ Drivers'], ['q4', '④ Duration'], ['predict', '⑤ Predict']];
        const nav = SECS.map(([id, l]) => `<button data-rs="${id}" style="background:${st.sec === id ? C.accent + '22' : 'transparent'};border:1px solid ${st.sec === id ? C.accent : C.border};color:${st.sec === id ? C.accent : C.dim};border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer">${l}</button>`).join('');
        const sec = S ? ({ data: renderData, q1: renderQ1, q2: renderQ2, ind: renderIndicators, q4: renderQ4, predict: renderPredict }[st.sec] || renderData)() : renderData();
        root.innerHTML = `<div style="background:${C.bg};border-radius:12px;padding:16px;color:${C.text};font-family:'Nunito',sans-serif">
            <div style="font-size:21px;font-weight:900;color:${C.accent};margin-bottom:8px">Retention → Views</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">${nav}</div>${sec}</div>`;
    }

    function onClick(e) {
        const ns = e.target.closest('[data-rs]'); if (ns) { st.sec = ns.getAttribute('data-rs'); render(); return; }
        const th = e.target.closest('[data-sort]');
        if (th) { const k = th.getAttribute('data-sort'); if (st.sort === k) st.dir *= -1; else { st.sort = k; st.dir = (k === 'title' || k === 'published') ? 1 : -1; } render(); return; }
        if (e.target.closest('a')) return;
        const tr = e.target.closest('[data-row]');
        if (tr) { const id = tr.getAttribute('data-row'); st.open = st.open === id ? null : id; render(); }
    }
    function onInput(e) {
        if (e.target.hasAttribute && e.target.hasAttribute('data-pf')) { st.pvals = st.pvals || {}; st.pvals[e.target.getAttribute('data-pf')] = +e.target.value; updatePredict(); return; }
        if (e.target.closest('[data-q]')) { st.q = e.target.value; render(); }
    }
    function onChange(e) { if (e.target.closest('[data-tracked]')) { st.trackedOnly = e.target.checked; render(); } }

    async function mount(el) {
        root = el;
        if (!root.__rb) { root.addEventListener('click', onClick); root.addEventListener('input', onInput); root.addEventListener('change', onChange); root.__rb = true; }
        if (!DATA && !err) {
            root.innerHTML = `<div style="padding:40px;text-align:center;color:${C.dim}">Loading…</div>`;
            try {
                DATA = await fetch('./buildings/jarvis/retention-study/retention_table.json').then(r => r.json());
                S = await fetch('./buildings/jarvis/retention-study/retention_study.json').then(r => r.json()).catch(() => null);
            } catch (e) { err = e; root.innerHTML = `<div style="padding:24px;color:${C.red}">Failed to load: ${esc(e.message)}</div>`; return; }
        }
        render();
    }
    return { mount };
})();
if (typeof window !== 'undefined') window.JarvisRetention = JarvisRetention;
if (typeof module !== 'undefined' && module.exports) module.exports = JarvisRetention;
