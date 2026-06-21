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
    let root = null, DATA = null, S = null, N = null, CR = null, INT = null, CF = null, err = null;
    const st = { sec: 'data', sort: 'views', dir: -1, q: '', open: null, predScale: 'actual', nov: 'global', novRes: 'hook', corTarget: 'ret_5s', corGroup: 'all', corSel: null, intView: 'synergy', intPair: null, cfTarget: 'keep_rate', cfSel: null };
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
        // x-axis numeric range ticks (min · mid · max) so you see the actual span of the variable
        const xtf = v => Math.abs(v) >= 1000 ? fv(v) : (Math.abs(v) >= 100 || Number.isInteger(v)) ? v.toFixed(0) : v.toFixed(1);
        [xmin, (xmin + xmax) / 2, xmax].forEach((xt, k) => { const xx = X(xt); s += `<line x1="${xx.toFixed(1)}" y1="${h - pb}" x2="${xx.toFixed(1)}" y2="${h - pb + 3}" stroke="${C.border2}"/><text x="${xx.toFixed(1)}" y="${h - pb + 11}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}" fill="${C.mute}" font-size="8">${xtf(xt)}</text>`; });
        s += `<text x="${(pl + w - pr) / 2}" y="${h - 3}" text-anchor="middle" fill="${C.dim}" font-size="10">${xlabel} (${xtf(xmin)}–${xtf(xmax)}) →</text>`;
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
    // ── Principle: Novelty latent-space viz ──
    const NPAL = ['#22d3ee', '#34d399', '#fb923c', '#a78bfa', '#fbbf24', '#f87171', '#38bdf8', '#f472b6', '#4ade80', '#e879f9'];
    function heatCol(t) { t = Math.max(0, Math.min(1, t || 0));
        const st = [[37, 99, 235], [34, 211, 238], [250, 204, 21], [248, 113, 113]], x = t * 3, i = Math.min(2, Math.floor(x)), f = x - i, a = st[i], b = st[i + 1];
        return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`; }
    // 2D latent map: each point a hook (click → open its data). opt: color(i), tip(i), r(i), op(i), pick(i)→videoIdx, sel
    function latentMap(proj, opt) {
        if (!proj || !proj.length) return '';
        const w = 520, h = 330, pad = 16, X = x => pad + (x + 1) / 2 * (w - 2 * pad), Y = y => pad + (1 - (y + 1) / 2) * (h - 2 * pad);
        let s = '', top = '';
        proj.forEach((p, i) => { if (!p) return; const pk = opt.pick ? opt.pick(i) : i, isSel = opt.sel != null && pk === opt.sel;
            const c = opt.color(i), r = isSel && !opt.traj ? 6 : (opt.r ? opt.r(i) : 3.2);
            const circ = `<circle data-hook="${pk}" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${r}" fill="${c}" opacity="${isSel ? 1 : (opt.op ? opt.op(i) : 0.72)}" stroke="${isSel ? '#fff' : '#0b1120'}" stroke-width="${isSel ? 1.6 : 0.4}" style="cursor:pointer"><title>${esc(opt.tip(i))}</title></circle>`;
            if (isSel) top += circ; else s += circ; });
        // numbered trajectory: connect the selected hook's seconds 0→4 so you can read the order
        if (opt.traj && opt.traj.length > 1) {
            let path = ''; opt.traj.forEach((p, k) => { path += (k ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1) + ' '; });
            top += `<path d="${path}" fill="none" stroke="#fff" stroke-width="1.6" opacity="0.65" stroke-dasharray="3 2"/>`;
            opt.traj.forEach((p, k) => { const x = X(p[0]).toFixed(1), y = Y(p[1]).toFixed(1); top += `<circle cx="${x}" cy="${y}" r="8.5" fill="#0b1120" stroke="#fff" stroke-width="1.5"/><text x="${x}" y="${(+y + 3).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="10" font-weight="800">${k}</text>`; });
        }
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}${top}</svg>`;
    }
    function legendBar(lo, hi, label) {
        const stops = [0, .25, .5, .75, 1].map(t => `${heatCol(t)} ${t * 100}%`).join(',');
        return `<div style="display:flex;align-items:center;gap:8px;font-size:10px;color:${C.mute};margin-top:4px"><span>${lo}</span><span style="flex:1;height:8px;border-radius:4px;background:linear-gradient(90deg,${stops})"></span><span>${hi}</span>${label ? `<span style="margin-left:6px">${label}</span>` : ''}</div>`;
    }
    function mapCard(title, sub, svg, legend) {
        return `<div><div style="font-size:12px;font-weight:700;color:${C.text}">${title}</div><div style="font-size:10px;color:${C.mute};margin-bottom:4px">${sub}</div>${svg}${legend || ''}</div>`;
    }
    // concept co-occurrence graph (combinatorial novelty)
    function comboGraph(G) {
        if (!G || !G.nodes.length) return '<div style="color:' + C.mute + '">no concepts yet</div>';
        const w = 520, h = 380, pad = 24, X = x => pad + (x + 1) / 2 * (w - 2 * pad), Y = y => pad + (1 - (y + 1) / 2) * (h - 2 * pad);
        const mxw = Math.max(...G.edges.map(e => e.w), 1), mxf = Math.max(...G.nodes.map(nd => nd.freq), 1);
        let s = '';
        G.edges.forEach(e => { const a = G.nodes[e.a], b = G.nodes[e.b]; s += `<line x1="${X(a.pos[0]).toFixed(1)}" y1="${Y(a.pos[1]).toFixed(1)}" x2="${X(b.pos[0]).toFixed(1)}" y2="${Y(b.pos[1]).toFixed(1)}" stroke="${C.accent}" stroke-width="${(0.3 + e.w / mxw * 2).toFixed(2)}" opacity="${(0.08 + e.w / mxw * 0.4).toFixed(2)}"/>`; });
        G.nodes.forEach(nd => { const r = 3 + nd.freq / mxf * 9, cx = X(nd.pos[0]), cy = Y(nd.pos[1]);
            s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${C.purple}" opacity="0.55"><title>${esc(nd.w)} · ${nd.freq} hooks</title></circle>`;
            if (nd.freq / mxf > 0.28) s += `<text x="${cx.toFixed(1)}" y="${(cy - r - 2).toFixed(1)}" text-anchor="middle" fill="${C.dim}" font-size="9">${esc(nd.w)}</text>`; });
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg>`;
    }
    // novelty × coherence quadrant (coherent novelty)
    function quadPlot(xv, yv, opt) {
        const w = 520, h = 360, pl = 18, pr = 14, pt = 14, pb = 18, X = x => pl + x * (w - pl - pr), Y = y => h - pb - y * (h - pt - pb);
        let s = `<line x1="${X(.5)}" y1="${pt}" x2="${X(.5)}" y2="${h - pb}" stroke="${C.border2}" stroke-dasharray="3 3"/><line x1="${pl}" y1="${Y(.5)}" x2="${w - pr}" y2="${Y(.5)}" stroke="${C.border2}" stroke-dasharray="3 3"/>`;
        const q = [['curiosity', .75, .75, C.green], ['confusion', .25, .75, C.orange], ['familiar', .75, .25, C.cyan], ['boring', .25, .25, C.mute]];
        q.forEach(([t, x, y, c]) => s += `<text x="${X(x)}" y="${Y(y)}" text-anchor="middle" fill="${c}" font-size="11" font-weight="700" opacity="0.5">${t}</text>`);
        let top = '';
        xv.forEach((x, i) => { if (x == null || yv[i] == null) return; const isSel = opt.sel != null && i === opt.sel, r = isSel ? 6 : 3.4;
            const circ = `<circle data-hook="${i}" cx="${X(x).toFixed(1)}" cy="${Y(yv[i]).toFixed(1)}" r="${r}" fill="${opt.color(i)}" opacity="${isSel ? 1 : 0.72}" stroke="${isSel ? '#fff' : '#0b1120'}" stroke-width="${isSel ? 1.6 : 0.4}" style="cursor:pointer"><title>${esc(opt.tip(i))}</title></circle>`;
            if (isSel) top += circ; else s += circ; });
        s += top;
        s += `<text x="${(pl + w - pr) / 2}" y="${h - 3}" text-anchor="middle" fill="${C.dim}" font-size="10">novelty (distance from corpus) →</text>`;
        s += `<text x="10" y="${(pt + h - pb) / 2}" fill="${C.dim}" font-size="10" transform="rotate(-90 10 ${(pt + h - pb) / 2})">coherence (visuals ↔ words) →</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg>`;
    }
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
    const fv = x => x == null ? '—' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(0) + 'K' : '' + Math.round(x);

    const COLS = [
        { k: 'title', l: 'Video', w: '28%', align: 'left' },
        { k: 'published', l: 'Posted', w: '10%' },
        { k: 'keep_rate', l: 'Keep %', w: '9%' },
        { k: 'swiped', l: 'Swiped %', w: '9%' },
        { k: 'avg_retention', l: 'Retention %', w: '11%' },
        { k: 'ret5', l: '5s ret %', w: '11%' },
        { k: 'views', l: 'Views', w: '12%' },
        { k: 'duration_s', l: 'Dur s', w: '7%' },
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
                <td style="text-align:right;padding:7px 8px;color:${C.purple};font-size:12px">${r.ret5 == null ? '—' : fmt(r.ret5, 1)}</td>
                <td style="text-align:right;padding:7px 8px;color:${C.text};font-size:12px;font-weight:700">${fv(r.views)}</td>
                <td style="text-align:right;padding:7px 8px;color:${C.dim};font-size:11px">${fmt(r.duration_s, 0)}</td></tr>`;
            const exp = open ? `<tr><td colspan="8" style="padding:10px 14px;background:${C.card2}">
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:${C.dim}">
                    <a href="${esc(r.url)}" target="_blank" style="background:${C.accent}22;border:1px solid ${C.accent};color:${C.accent};border-radius:6px;padding:4px 10px;font-weight:700;text-decoration:none">▶ Open on YouTube ↗</a>
                    <span style="background:${C.card};border:1px solid ${C.border};border-radius:6px;padding:4px 10px">id: ${esc(r.id)}</span>
                    <span style="background:${C.card};border:1px solid ${C.border};border-radius:6px;padding:4px 10px;color:${C.cyan}">kept ${fmt(r.keep_rate, 1)}% · swiped ${fmt(r.swiped, 1)}%</span>
                    ${r.nonsub_keep != null ? `<span style="background:${C.card};border:1px solid ${C.border};border-radius:6px;padding:4px 10px">non-sub keep ${fmt(r.nonsub_keep, 1)}%</span>` : ''}
                    <span style="background:${C.card};border:1px solid ${C.purple};border-radius:6px;padding:4px 10px;color:${C.purple}">5s ret: ${r.ret5 == null ? '—' : fmt(r.ret5, 1) + '%'} absolute · ${r.ret5_surv == null ? '—' : fmt(r.ret5_surv, 1) + '%'} survival</span>
                    <span style="background:${C.card};border:1px solid ${C.border};border-radius:6px;padding:4px 10px">👍 ${fv(r.likes)} · 💬 ${fv(r.comments)} · ↗ ${fv(r.shares)}</span>
                </div>${r.curve ? curveSvg(r.curve) : ''}
                <div style="font-size:10px;color:${C.mute};margin-top:6px">Verify in YouTube Studio: Keep % = "Viewed" in Viewed-vs-Swiped-Away, retention = "average percentage viewed", <b style="color:${C.purple}">5s ret</b> = the audience-retention curve value at the 5-second mark (absolute can exceed 100% on loops; survival = relative to the opening). Keep + Swiped = 100. ${r.scraped_at ? 'Scraped ' + esc((r.scraped_at || '').slice(0, 10)) : ''}</div></td></tr>` : '';
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
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">Each modelled toward log views. Dashed line = trend; spread around it is what that metric <i>doesn't</i> explain. Axis shows the actual range of each.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div><div style="font-size:12px;color:${C.cyan};margin-bottom:3px;font-weight:700">Keep rate → views</div>${scatter('keep', 'keep rate %', C.cyan)}</div>
                <div><div style="font-size:12px;color:${C.green};margin-bottom:3px;font-weight:700">Retention → views</div>${scatter('ret', 'retention %', C.green)}</div>
                <div><div style="font-size:12px;color:${C.purple};margin-bottom:3px;font-weight:700">5-sec retention → views</div>${scatter('ret5', '5-sec retention %', C.purple)}</div>
                <div><div style="font-size:12px;color:${C.yellow};margin-bottom:3px;font-weight:700">Duration → views</div>${scatter('dur', 'duration (s)', C.yellow)}</div></div>`);
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
    const SLCOL = { keep: C.cyan, retention: C.green, ret5: C.purple, log_dur: C.yellow, hook: C.accent, tail: C.purple, nonsub_keep: C.cyan };
    // the active model = whichever inputs are checked (st.predFeats), pulled from the precomputed subsets
    function curKey() { const order = (S.predictor.order || ['keep', 'retention', 'ret5', 'log_dur']); return order.filter(f => (st.predFeats || ['keep', 'retention', 'log_dur']).includes(f)).join('+'); }
    function curModel() {
        const P = S.predictor; if (!P.subsets) return P.v_best;          // fallback for older data
        const k = curKey(), m = k ? P.subsets[k] : null; if (!m) return null;
        const sel = m.features, sliders = sel.map(f => Object.assign({ key: f }, P.feat_meta[f])), feat_median = {};
        sel.forEach(f => feat_median[f] = P.feat_meta[f].default);
        return { features: sel, coef: m.coef, intercept: m.intercept, resid_sd_log10: m.resid_sd_log10, cv_r2: m.cv_r2, sliders, feat_median, labels: sel.map(f => P.feat_meta[f].label) };
    }
    function pval(key) { st.pvals = st.pvals || {}; const m = curModel(), sl = m && m.sliders.find(s => s.key === key); return st.pvals[key] != null ? st.pvals[key] : (sl ? sl.default : 0); }
    function predictBest(overrides) {
        const vb = curModel(), P10 = e => Math.pow(10, e); if (!vb) return { log: 0, mid: 0, lo50: 0, hi50: 0, lo80: 0, hi80: 0 };
        let plog = vb.intercept;
        vb.features.forEach((f, i) => { const sl = vb.sliders.find(s => s.key === f);
            let x = overrides && overrides[f] != null ? overrides[f] : (sl ? pval(f) : vb.feat_median[f]); if (sl && sl.transform === 'ln') x = Math.log(Math.max(x, 1));
            plog += vb.coef[i] * x; });
        const sd = vb.resid_sd_log10;
        return { log: plog, mid: P10(plog), lo50: P10(plog - 0.6745 * sd), hi50: P10(plog + 0.6745 * sd), lo80: P10(plog - 1.2816 * sd), hi80: P10(plog + 1.2816 * sd) };
    }
    function predictOut() {
        const vb = curModel(); if (!vb) return ''; const r = predictBest();
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
        const g = root.querySelector('#predict-graph'); if (g) g.innerHTML = leverGraph();
        const pg = root.querySelector('#predict-pairs'); if (pg) pg.innerHTML = pairSurfaces();
        (curModel() || { sliders: [] }).sliders.forEach(s => { const el = root.querySelector('#pf-' + s.key + '-val'); if (el) el.textContent = pval(s.key) + s.unit; }); }
    const metricVal = r => (st.predScale === 'log' ? r.log : r.mid);
    const metricLabel = v => (st.predScale === 'log' ? fmtv(v, 2) : fv(v));
    const valsFor = (sl, n) => Array.from({ length: n }, (_, i) => sl.min + (sl.max - sl.min) * i / (n - 1 || 1));
    function corrFor(a, b) {
        const key = k => k === 'retention' ? 'ret' : k === 'log_dur' ? 'dur' : k;
        const pts = (S.scatter || []).filter(p => p[key(a)] != null && p[key(b)] != null), n = pts.length;
        if (n < 3) return null;
        const xs = pts.map(p => p[key(a)]), ys = pts.map(p => p[key(b)]);
        const mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
        const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
        const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
        return den ? num / den : null;
    }
    function leverGraph() {
        const vb = curModel(); if (!vb) return ''; const scale = st.predScale || 'actual', w = 520, h = 230, pl = 46, pr = 16, pt = 14, pb = 34;
        const series = vb.sliders.map(sl => {
            const vals = valsFor(sl, 25);
            return { sl, pts: vals.map(v => ({ x: v, r: predictBest({ [sl.key]: v }) })) };
        });
        const ms = series.flatMap(s => s.pts.map(p => metricVal(p.r))), lo = Math.min(...ms), hi = Math.max(...ms);
        const X = (v, sl) => pl + (v - sl.min) / ((sl.max - sl.min) || 1) * (w - pl - pr);
        const Y = v => h - pb - (v - lo) / ((hi - lo) || 1) * (h - pt - pb);
        let s = `<line x1="${pl}" y1="${h - pb}" x2="${w - pr}" y2="${h - pb}" stroke="${C.border2}"/><line x1="${pl}" y1="${pt}" x2="${pl}" y2="${h - pb}" stroke="${C.border2}"/>`;
        for (let i = 0; i <= 4; i++) { const mv = lo + (hi - lo) * i / 4, y = Y(mv);
            s += `<line x1="${pl}" y1="${y}" x2="${w - pr}" y2="${y}" stroke="${C.border}" stroke-dasharray="3 3"/><text x="${pl - 5}" y="${y + 3}" text-anchor="end" fill="${C.mute}" font-size="8">${metricLabel(mv)}</text>`; }
        series.forEach((se, i) => {
            const color = SLCOL[se.sl.key] || [C.cyan, C.green, C.yellow, C.purple][i % 4];
            let p = ''; se.pts.forEach((ptd, j) => p += (j ? 'L' : 'M') + X(ptd.x, se.sl) + ' ' + Y(metricVal(ptd.r)) + ' ');
            s += `<path d="${p}" fill="none" stroke="${color}" stroke-width="2.5" opacity="0.9"/>`;
            const cur = pval(se.sl.key), r = predictBest({ [se.sl.key]: cur });
            s += `<circle cx="${X(cur, se.sl)}" cy="${Y(metricVal(r))}" r="4" fill="${color}" stroke="${C.bg}" stroke-width="1.5"><title>${esc(se.sl.label)} ${fmt(cur, 0)}${se.sl.unit} → ${fv(r.mid)} views</title></circle>`;
            s += `<text x="${pl + i * 112}" y="11" fill="${color}" font-size="9" font-weight="800">${esc(se.sl.label)}</text>`;
        });
        s += `<text x="${(pl + w - pr) / 2}" y="${h - 6}" text-anchor="middle" fill="${C.dim}" font-size="10">each lever swept min→max, other levers held at current slider values</text>`;
        s += `<text x="11" y="${(pt + h - pb) / 2}" fill="${C.dim}" font-size="10" transform="rotate(-90 11 ${(pt + h - pb) / 2})">${scale === 'log' ? 'log10 views' : 'actual views (linear axis)'}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg>`;
    }
    function pairSurface(a, b) {
        const av = valsFor(a, 6), bv = valsFor(b, 6), cells = [];
        av.forEach(x => bv.forEach(y => { const r = predictBest({ [a.key]: x, [b.key]: y }); cells.push({ x, y, r, m: metricVal(r) }); }));
        const lo = Math.min(...cells.map(c => c.m)), hi = Math.max(...cells.map(c => c.m));
        const col = v => { const t = Math.max(0, Math.min(1, (v - lo) / ((hi - lo) || 1))); return `rgb(${Math.round(16 + t * 22)},${Math.round(32 + t * 160)},${Math.round(55 + t * 82)})`; };
        const rel = corrFor(a.key, b.key);
        let grid = `<div></div>` + bv.map(v => `<div style="font-size:9px;color:${SLCOL[b.key] || C.dim};text-align:center">${fmt(v, 0)}${b.unit}</div>`).join('');
        for (let i = av.length - 1; i >= 0; i--) {
            grid += `<div style="font-size:9px;color:${SLCOL[a.key] || C.dim};text-align:right;padding-right:4px;font-weight:800">${fmt(av[i], 0)}${a.unit}</div>`;
            bv.forEach(v => {
                const c = cells.find(z => z.x === av[i] && z.y === v), near = Math.abs(av[i] - pval(a.key)) < (a.max - a.min) / 10 && Math.abs(v - pval(b.key)) < (b.max - b.min) / 10;
                grid += `<div title="${esc(a.label)} ${fmt(av[i], 1)}${a.unit}, ${esc(b.label)} ${fmt(v, 1)}${b.unit} → ${fv(c.r.mid)} views" style="background:${col(c.m)};border:${near ? '2px solid ' + C.yellow : '1px solid rgba(255,255,255,.05)'};border-radius:5px;padding:8px 3px;text-align:center;font-size:10px;color:#fff;font-weight:800">${metricLabel(c.m)}</div>`;
            });
        }
        return `<div style="background:${C.card2};border:1px solid ${C.border};border-radius:10px;padding:10px">
            <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px"><div style="font-size:12px;font-weight:800;color:${C.text}">${esc(a.label)} × ${esc(b.label)}</div><div style="font-size:10px;color:${C.mute}">real-data r ${rel == null ? '—' : sgn(rel)}</div></div>
            <div style="display:grid;grid-template-columns:42px repeat(6,1fr);gap:4px">${grid}</div>
            <div style="font-size:9px;color:${C.mute};margin-top:5px">${esc(a.label)} ↑ · ${esc(b.label)} → · third lever held at current slider</div></div>`;
    }
    function pairSurfaces() {
        const m = curModel(); if (!m || m.sliders.length < 2) return `<div style="font-size:11px;color:${C.mute}">Check at least two inputs to see combined surfaces.</div>`;
        const sl = m.sliders, pairs = [];
        for (let i = 0; i < sl.length; i++) for (let j = i + 1; j < sl.length; j++) pairs.push(pairSurface(sl[i], sl[j]));
        return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px">${pairs.join('')}</div>`;
    }
    function predComparison() {
        const P = S.predictor; if (!P.subsets) return '';
        const P10 = e => Math.pow(10, e), ck = curKey();
        const rows = Object.entries(P.subsets).map(([k, m]) => ({ k, m, rng: P10(1.2816 * m.resid_sd_log10) })).sort((a, b) => b.m.cv_r2 - a.m.cv_r2);
        const lab = f => P.feat_meta[f].label;
        return cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Every model compared — accuracy vs range</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">CV R² = out-of-sample accuracy (higher = better). Range = ×/÷ band on the prediction (lower = tighter). Click a row to load that model.</div>
            <div style="display:flex;gap:8px;font-size:9px;color:${C.mute};text-transform:uppercase;padding:0 6px 3px"><span style="flex:1">inputs → log views</span><span style="width:80px;text-align:right">CV R²</span><span style="width:80px;text-align:right">range</span></div>
            ${rows.map(({ k, m, rng }) => { const on = k === ck; return `<div data-predset="${k}" style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:5px;background:${on ? C.card2 : 'transparent'};border:1px solid ${on ? C.accent : 'transparent'}">
                <span style="flex:1;font-size:11px;color:${on ? C.text : C.dim}">${m.features.map(lab).join(' + ')}</span>
                <span style="width:80px;text-align:right;font-size:11px;color:${C.accent};font-weight:700">${fmtv(m.cv_r2, 2)}</span>
                <span style="width:80px;text-align:right;font-size:11px;color:${C.orange}">×/÷ ${fmtv(rng, 1)}</span></div>`; }).join('')}`);
    }
    function renderPredict() {
        const P = S.predictor, P10 = e => Math.pow(10, e), order = P.order || ['keep', 'retention', 'ret5', 'log_dur'];
        st.predFeats = st.predFeats || ['keep', 'retention', 'log_dur'];
        const vb = curModel();
        const chk = order.map(f => { const on = st.predFeats.includes(f), c = SLCOL[f] || C.cyan, fm = P.feat_meta[f];
            return `<button data-predfeat="${f}" style="background:${on ? c + '22' : 'transparent'};border:1px solid ${on ? c : C.border};color:${on ? c : C.dim};border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">${on ? '☑' : '☐'} ${esc(fm.label)}</button>`; }).join('');
        let h = h2c('⑤ Predict — expected views, your choice of levers', `Check the inputs to model log-views from; the fit, accuracy and range update live. ${S.meta.n} videos.`);
        h += cardc(`<div style="font-size:11px;color:${C.mute};margin-bottom:6px">Model views from:</div><div style="display:flex;gap:6px;flex-wrap:wrap">${chk}</div>`);
        if (!vb) { h += note('Select at least one input above.', C.orange); return h; }
        const rngMult = P10(1.2816 * vb.resid_sd_log10);
        const sld = s => { const c = SLCOL[s.key] || C.cyan, val = pval(s.key); return `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="color:${c};font-weight:700">${esc(s.label)}</span><span id="pf-${s.key}-val" style="color:${C.text};font-weight:800">${val}${s.unit}</span></div>
            <input type="range" data-pf="${s.key}" min="${Math.floor(s.min)}" max="${Math.ceil(s.max)}" value="${val}" step="1" style="width:100%;accent-color:${c}"/></div>`; };
        h += cardc(`<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">${statc('inputs', vb.labels.join(' + '), C.accent)}${statc('model R² (CV)', fmtv(vb.cv_r2, 2), vb.cv_r2 > 0.25 ? C.green : C.cyan)}${statc('view range', '×/÷ ' + fmtv(rngMult, 1), C.orange)}</div>
            ${vb.sliders.map(sld).join('')}
            <div id="predict-out" style="margin-top:6px;padding-top:12px;border-top:1px solid ${C.border}">${predictOut()}</div>`);
        h += predComparison();
        h += cardc(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
                <div><div style="font-weight:700;color:${C.text}">Independent lever response curves</div><div style="font-size:11px;color:${C.mute};margin-top:2px">Each line sweeps one input while the others stay fixed. Actual views uses a true linear y-axis; log10 compresses the same model so the lower range is readable.</div></div>
                <div style="display:flex;gap:6px">
                    <button data-pred-scale="actual" style="background:${st.predScale === 'actual' ? C.accent + '22' : 'transparent'};border:1px solid ${st.predScale === 'actual' ? C.accent : C.border};color:${st.predScale === 'actual' ? C.accent : C.dim};border-radius:7px;padding:5px 9px;font-size:11px;font-weight:800;cursor:pointer">actual views</button>
                    <button data-pred-scale="log" style="background:${st.predScale === 'log' ? C.accent + '22' : 'transparent'};border:1px solid ${st.predScale === 'log' ? C.accent : C.border};color:${st.predScale === 'log' ? C.accent : C.dim};border-radius:7px;padding:5px 9px;font-size:11px;font-weight:800;cursor:pointer">log10</button>
                </div></div><div id="predict-graph">${leverGraph()}</div>`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Combined lever surfaces</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:9px">Every cell is a model instance: two inputs swept together while the others stay at your current slider value.</div>
            <div id="predict-pairs">${pairSurfaces()}</div>`);
        h += note(`<b>${esc(vb.labels.join(' + '))}</b> pins down ~${Math.round(vb.cv_r2 * 100)}% of views (CV R² ${fmtv(vb.cv_r2, 2)}), leaving a ×/÷ ${fmtv(rngMult, 1)} band — the rest is the algorithm's push, topic and timing, which no on-video metric sees. Try swapping <b>Retention %</b> for <b>5-sec retention</b> in the checkboxes and watch R² and the range change in the table above (5-sec retention is easier to influence but explains views less well). Center bar = best guess; 80% band = realistic landing.`, C.accent);
        return h;
    }

    // ───────────────────── PRINCIPLES → NOVELTY ─────────────────────
    function novTip(i, extra) { const v = N.videos[i]; return (v.name || v.id) + ' · ' + fv(v.views) + ' views' + (extra ? ' · ' + extra : '') + ' · click for data'; }
    function rankPct(arr, i) { const v = arr[i]; if (v == null) return 0; const s = arr.filter(x => x != null).sort((a, b) => a - b); return s.indexOf(v) / (s.length - 1 || 1); }
    // resolution-aware maps. hook → one point per video; second → one point per video-second.
    function resMaps(colorHook, colorSec, legend, hookExtra) {
        if (st.novRes === 'second') {
            const S = N.second, mods = [['whole', 'Whole / sec', 'CLIP image + spoken & on-screen text'], ['concept', 'Concept / sec', 'MiniLM of spoken + on-screen text'], ['visual', 'Visual / sec', 'DINOv2 of the frame (no text)'], ['text', 'Text / sec', 'on-screen caption text only']];
            const trajFor = mod => { if (st.novSel == null) return null; const rows = []; for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === st.novSel) rows.push(i); rows.sort((a, b) => S.sec[a] - S.sec[b]); return rows.map(i => S.proj[mod][i]); };
            const mk = ([mod, label, sub]) => mapCard(label, sub, latentMap(S.proj[mod], { color: i => colorSec(mod, i), pick: i => S.owner[i], sel: st.novSel, traj: trajFor(mod), r: i => (st.novSel != null && S.owner[i] === st.novSel) ? 5 : 2.3, op: () => 0.62, tip: i => novTip(S.owner[i], 'second ' + S.sec[i]) }), legend);
            return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${mods.map(mk).join('')}<div style="font-size:11px;color:${C.mute};align-self:center;padding:10px">Each point is <b>one second</b> (${S.owner.length} total). Select a hook → its 5 seconds are <b>connected 0→4</b> with numbers, so you can read the path its hook takes through latent space (does it stay put or travel?).</div></div>`;
        }
        const H = N.hook, mods = [['whole', 'Whole hook', 'CLIP image + spoken & on-screen text'], ['concept', 'Concept', 'MiniLM of spoken + on-screen text'], ['visual', 'Visual', 'DINOv2 frames, pooled (no text)'], ['text', 'On-screen text', 'MiniLM of caption/overlay text only']];
        const mk = ([mod, label, sub]) => mapCard(label, sub, latentMap(H.proj[mod], { color: i => colorHook(mod, i), sel: st.novSel, tip: i => novTip(i) }), legend);
        return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${mods.map(mk).join('')}${hookExtra || `<div style="font-size:11px;color:${C.mute};align-self:center;padding:10px">Each point is a <b>whole hook</b>. Switch to <b>per-second</b> (top right) to see the same geometry at granular resolution.</div>`}</div>`;
    }
    // committed thumbnail of a hook second (works on the deployed site; video_data/ frames are gitignored)
    const hookFrame = (vid, sec) => `./buildings/jarvis/retention-study/principles/hookframes/${encodeURIComponent(vid)}/${sec}.jpg`;
    // frame with the OWLv2 detection boxes drawn on it (toggleable overlay so you can compare raw vs detected)
    function frameBoxes(vid, second, dets, w, showBoxes) {
        const boxes = showBoxes ? (dets || []).map((d, bi) => { const c = NPAL[bi % NPAL.length]; return `<div style="position:absolute;left:${(d.box[0] * 100).toFixed(1)}%;top:${(d.box[1] * 100).toFixed(1)}%;width:${(d.box[2] * 100).toFixed(1)}%;height:${(d.box[3] * 100).toFixed(1)}%;border:2px solid ${c};box-shadow:0 0 0 1px #000b;pointer-events:none"><span style="position:absolute;top:-1px;left:-1px;background:${c};color:#000;font-size:9px;font-weight:800;padding:0 3px;white-space:nowrap;border-radius:0 0 3px 0">${esc(d.label)} ${d.score}</span></div>`; }).join('') : '';
        return `<div style="position:relative;width:${w}px;flex-shrink:0"><img src="${hookFrame(vid, second)}" loading="lazy" onerror="this.parentElement.style.opacity=0.15" style="width:${w}px;height:${Math.round(w * 16 / 9)}px;object-fit:fill;border-radius:6px;border:1px solid ${C.border2};display:block"/>${boxes}<div style="text-align:center;font-size:10px;color:${C.mute};margin-top:2px">sec ${second} · <b style="color:${C.dim}">${(dets || []).length}</b> obj</div></div>`;
    }
    function renderHookDetail(i) {
        const v = N.videos[i], H = N.hook, g = H.global, nz = H.niche, ch = H.coherent;
        const bar = (label, val, pctv, color) => `<div style="margin-bottom:7px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px"><span style="color:${C.dim}">${label}</span><span style="color:${C.text};font-weight:700">${val}</span></div><div style="height:5px;background:${C.card};border-radius:3px;overflow:hidden"><div style="height:100%;width:${Math.round((pctv || 0) * 100)}%;background:${color || C.accent}"></div></div></div>`;
        const chip = (lab, c) => `<span style="display:inline-block;background:${c}22;border:1px solid ${c};color:${c};border-radius:5px;padding:1px 7px;font-size:11px;font-weight:700;margin:0 3px 3px 0">${esc(lab)}</span>`;
        const coord = m => H.proj[m] && H.proj[m][i] ? `(${H.proj[m][i][0].toFixed(2)}, ${H.proj[m][i][1].toFixed(2)})` : '—';
        const onscreen = (v.onscreen_text || '').trim();
        const col2 = (title, body) => `<div style="flex:1;min-width:208px"><div style="font-size:11px;font-weight:800;color:${C.text};margin-bottom:6px;text-transform:uppercase;letter-spacing:.3px">${title}</div>${body}</div>`;
        const clusLabel = c => { const cl = (N.combo.clusters || []).find(x => x.id === c); return cl ? cl.label : 'c' + c; };
        // OBJECTS (OWLv2) — quantitative, with toggleable boxes drawn per second
        const persec = v.objects_persec || [], showBx = st.novBoxes !== false;
        const objToggle = `<button data-novboxes style="background:${showBx ? C.orange + '22' : 'transparent'};border:1px solid ${showBx ? C.orange : C.border};color:${showBx ? C.orange : C.dim};border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer">▣ detection ${showBx ? 'ON' : 'OFF'}</button>`;
        const objFrames = persec.length ? `<div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px">${persec.map(ps => frameBoxes(v.id, ps.t, ps.dets, 132, showBx)).join('')}</div>` : `<div style="font-size:11px;color:${C.mute}">no detections stored</div>`;
        const hookObjs = (v.objects_hook || []).length ? (v.objects_hook || []).map(o => `<span style="display:inline-block;background:${C.orange}1e;border:1px solid ${C.orange};color:${C.orange};border-radius:5px;padding:1px 7px;font-size:11px;font-weight:700;margin:0 3px 3px 0">${esc(o.label)} <span style="opacity:.7">${o.score}·${o.seconds}s</span></span>`).join('') : `<span style="color:${C.mute};font-size:11px">none ≥ score 0.15</span>`;
        // CONCEPTS (quantitative MMR keyphrases)
        const concepts = (v.concepts || []).length ? (v.concepts || []).map(c => `<span style="display:inline-block;background:${C.purple}1e;border:1px solid ${C.purple};color:${C.purple};border-radius:5px;padding:1px 7px;font-size:11px;font-weight:700;margin:0 3px 3px 0" title="cluster: ${esc(clusLabel(c.cluster))}">${esc(c.phrase)} <span style="opacity:.65">${c.score}</span></span>`).join('') : `<span style="color:${C.mute};font-size:11px">no concept extracted</span>`;
        // SECOND-BY-SECOND — every second analysed at the same depth as the whole hook
        const miniBar = (lab, pctv, c) => `<div style="flex:1;min-width:64px"><div style="font-size:9px;color:${C.mute};display:flex;justify-content:space-between"><span>${lab}</span><span style="color:${C.dim};font-weight:700">${Math.round(pctv * 100)}</span></div><div style="height:4px;background:${C.card};border-radius:2px;overflow:hidden"><div style="height:100%;width:${Math.round(pctv * 100)}%;background:${c}"></div></div></div>`;
        const nc4 = (k) => NPAL[k % NPAL.length];
        const secRows = (v.persec || []).map(p => `<div style="display:flex;gap:8px;padding:9px 0;border-top:1px solid ${C.border}">
                <img src="${hookFrame(v.id, p.sec)}" loading="lazy" onerror="this.style.display='none'" style="width:44px;height:78px;object-fit:cover;border-radius:5px;border:1px solid ${C.border2};flex-shrink:0"/>
                <div style="flex:1;min-width:0">
                    <div style="display:flex;gap:8px;align-items:center;margin-bottom:5px"><span style="background:${C.accent}22;border:1px solid ${C.accent};color:${C.accent};border-radius:5px;padding:1px 8px;font-size:11px;font-weight:800;flex-shrink:0">sec ${p.sec}</span>
                        <div style="display:flex;gap:9px;flex:1">${miniBar('whole', p.nov_pct.whole, heatCol(p.nov_pct.whole))}${miniBar('concept', p.nov_pct.concept, heatCol(p.nov_pct.concept))}${miniBar('visual', p.nov_pct.visual, heatCol(p.nov_pct.visual))}${miniBar('text', p.nov_pct.text, heatCol(p.nov_pct.text))}</div></div>
                    <div style="font-size:10px;color:${C.mute};margin-bottom:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                        <span>niche</span><span title="whole" style="color:${nc4(p.niche.whole)};font-weight:700">●${p.niche.whole}</span><span title="concept" style="color:${nc4(p.niche.concept)};font-weight:700">●${p.niche.concept}</span><span title="visual" style="color:${nc4(p.niche.visual)};font-weight:700">●${p.niche.visual}</span><span title="text" style="color:${nc4(p.niche.text)};font-weight:700">●${p.niche.text}</span>
                        <span>· temporal ${p.temporal == null ? '—' : p.temporal}</span><span>· coherence ${p.coh} (${Math.round(p.coh_pct * 100)}th)</span><span>· ${(p.objects || []).length} obj</span></div>
                    ${p.onscreen ? `<div style="font-size:11px;color:${C.yellow};margin-bottom:1px">⌶ "${esc(p.onscreen)}"</div>` : ''}
                    ${p.desc ? `<div style="font-size:11px;color:${C.dim};line-height:1.45"><span style="color:${C.faint}">⚠ </span>${esc(p.desc)}</div>` : ''}
                </div></div>`).join('') || `<div style="font-size:11px;color:${C.mute}">no per-second analysis</div>`;
        return cardc(`<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px">
                <div><div style="font-size:15px;font-weight:800;color:${C.text}">${esc(v.name || v.id)}</div>
                    <div style="font-size:11px;color:${C.mute};margin-top:2px">${fv(v.views)} views · ${v.published || '—'} · ${v.age_days != null ? v.age_days + 'd old' : '—'} · id ${esc(v.id)}</div></div>
                <div style="display:flex;gap:6px;flex-shrink:0"><a href="${esc(v.url)}" target="_blank" style="background:${C.red}22;border:1px solid ${C.red};color:${C.red};border-radius:6px;padding:5px 11px;font-size:12px;font-weight:700;text-decoration:none">▶ YouTube ↗</a>
                    <button data-novclose style="background:transparent;border:1px solid ${C.border2};color:${C.dim};border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer">✕ close</button></div></div>
            <div style="border-top:1px solid ${C.border};padding-top:10px;margin-bottom:10px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-size:11px;font-weight:800;color:${C.orange};text-transform:uppercase;letter-spacing:.3px">⬚ Objects — OWLv2 detection (every second)</div>${objToggle}</div>
                ${objFrames}
                <div style="font-size:10px;color:${C.mute};margin:8px 0 3px">tracked across the hook (object · score · #seconds present)</div><div>${hookObjs}</div></div>
            <div style="border-top:1px solid ${C.border};padding-top:10px;margin-bottom:10px">
                <div style="font-size:11px;font-weight:800;color:${C.purple};margin-bottom:4px;text-transform:uppercase;letter-spacing:.3px">D · Concepts — MMR keyphrases (centrality score)</div>
                <div style="margin-bottom:6px">${concepts}</div>
                <div style="font-size:11px;color:${C.dim}">combo rarity: ${N.combo.rarity[i] != null ? `<b style="color:${C.purple}">${fmtv(N.combo.rarity[i], 3)}</b> (${Math.round(rankPct(N.combo.rarity, i) * 100)}th pct, over concept-cluster pairs)` : '<span style="color:' + C.mute + '">n/a (needs ≥2 concept-clusters)</span>'}</div></div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <div style="flex:1;min-width:240px"><div style="font-size:10px;color:${C.mute};margin-bottom:4px">HOOK SCRIPT — spoken (first 5s)</div>
                    <div style="font-size:12px;color:${C.dim};line-height:1.5;background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:8px 10px">${esc(v.hook_text || '(no speech in first 5s)')}</div></div>
                <div style="flex:1;min-width:240px"><div style="font-size:10px;color:${C.yellow};margin-bottom:4px">⌶ ON-SCREEN TEXT — OCR (captions/overlays)</div>
                    <div style="font-size:12px;color:${onscreen ? C.text : C.mute};line-height:1.5;background:${C.card2};border:1px solid ${onscreen ? C.yellow + '55' : C.border};border-radius:8px;padding:8px 10px">${onscreen ? esc(onscreen) : '(no on-screen text detected)'}</div></div></div>
            <div style="display:flex;gap:18px;flex-wrap:wrap;border-top:1px solid ${C.border};padding-top:12px;margin-bottom:8px">
                ${col2('A · Global novelty', ['whole', 'concept', 'visual', 'text'].map(m => bar(m, fmtv(g[m].nov[i], 3) + ' · ' + Math.round(g[m].pct[i] * 100) + 'th pct', g[m].pct[i], heatCol(g[m].pct[i]))).join(''))}
                ${col2('B · Niche', ['whole', 'concept', 'visual', 'text'].map(m => `<div style="margin-bottom:7px;font-size:11px;color:${C.dim}">${m}: ${chip('cluster ' + nz[m].labels[i], NPAL[nz[m].labels[i] % NPAL.length])} <span style="color:${C.mute}">· dist ${fmtv(nz[m].dist_to_centre[i], 3)}</span></div>`).join(''))}
                ${col2('C · Temporal', bar('novelty vs ±45d', H.temporal.nov[i] == null ? 'no neighbours' : fmtv(H.temporal.nov[i], 3), rankPct(H.temporal.nov, i), C.green) + `<div style="font-size:10px;color:${C.mute}">distance from hooks posted within 45 days</div>`)}
                ${col2('E · Coherent', bar('novelty', fmtv(ch.novelty[i], 3), ch.nov_pct[i], heatCol(ch.nov_pct[i])) + bar('coherence (vis↔words)', fmtv(ch.coherence[i], 3), ch.coh_pct[i], C.cyan) + `<div style="font-size:10px;color:${C.mute}">quadrant: <b style="color:${ch.nov_pct[i] > .5 && ch.coh_pct[i] > .5 ? C.green : C.dim}">${(ch.nov_pct[i] > .5 ? 'novel' : 'familiar') + ' + ' + (ch.coh_pct[i] > .5 ? 'coherent' : 'incoherent')} → ${ch.nov_pct[i] > .5 ? (ch.coh_pct[i] > .5 ? 'curiosity' : 'confusion') : (ch.coh_pct[i] > .5 ? 'familiar' : 'boring')}</b></div>`)}
                ${col2('Scene spread + coords', bar('scene spread (visual cuts)', fmtv(H.scene.spread[i], 3), rankPct(H.scene.spread, i), C.orange) + `<div style="font-size:10px;color:${C.mute};line-height:1.7">2D position · whole ${coord('whole')} · concept ${coord('concept')} · visual ${coord('visual')} · text ${coord('text')}</div>`)}
            </div>
            <div style="border-top:1px solid ${C.border};padding-top:10px">
                <div style="font-size:11px;font-weight:800;color:${C.text};margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px">⧗ Second-by-second — each second analysed like the whole hook</div>
                <div style="font-size:10px;color:${C.mute};margin-bottom:4px">novelty percentile (whole · concept · visual) · niche cluster per modality · temporal · coherence · #objects. The ⚠ line is the LLM description (interpreted, never scored).</div>${secRows}</div>`);
    }
    function renderNovGlobal() {
        const H = N.hook, S = N.second;
        let h = h2c('A · Global novelty — distance from the entire corpus', 'Mean cosine distance to the 8 nearest hooks. Outliers (red) are unlike everything else; dense blue cores are the crowded space. Pure geometry over the embeddings.');
        h += cardc(resMaps((mod, i) => heatCol(H.global[mod].pct[i]), (mod, i) => heatCol(S.global[mod].pct[i]), legendBar('typical', 'novel / outlier')));
        h += note('The concept map and the visual map disagree on purpose — some hooks are visually ordinary but conceptually strange. That is why they are embedded separately rather than as one low-res "whole" point.', C.cyan);
        return h;
    }
    function renderNovNiche() {
        const H = N.hook, S = N.second;
        let h = h2c('B · Niche novelty — emergent clusters', 'k-means (k=8) finds natural clusters with no labels. Colour = cluster. A hook far from its own cluster centre is niche-novel even if globally common.');
        h += cardc(resMaps((mod, i) => NPAL[H.niche[mod].labels[i] % NPAL.length], (mod, i) => NPAL[S.niche[mod].labels[i] % NPAL.length], ''));
        h += note('Clusters are unnamed — just where hooks naturally group. Per-second clustering (toggle) shows whether the seconds within one hook stay in the same niche or move through several.', NPAL[3]);
        return h;
    }
    function renderNovTemporal() {
        const ages = N.videos.map(v => v.age_days).filter(a => a != null), amin = Math.min(...ages), amax = Math.max(...ages);
        const col = i => { const a = N.videos[i].age_days; return a == null ? C.faint : heatCol(1 - (a - amin) / ((amax - amin) || 1)); };
        let h = h2c('C · Temporal novelty — what people have seen recently', 'Maps coloured by recency (bright = newer). Saturation shows up as a recent-heavy clump. The ±45-day temporal distance is per hook.');
        h += cardc(resMaps((mod, i) => col(i), (mod, i) => col(N.second.owner[i]), legendBar('older', 'newer')));
        h += note('A hook can be historically fine but dead now because everyone copied it. Watch whether bright (new) points pile into old territory or break into open space.', C.green);
        return h;
    }
    function renderNovCombo() {
        const G = N.combo;
        const nodes = (G.clusters || []).map(c => ({ w: c.label, freq: c.freq, pos: c.pos }));
        let h = h2c('D · Combinatorial novelty — concept-cluster co-occurrence', 'A concept = an MMR keyphrase (multi-word, centrality-scored). Concepts are k-means-clustered corpus-wide into recurring ideas; nodes here are those clusters. Edges = clusters that co-occur in a hook. Rare pairings are the interesting combinations.');
        h += cardc(`<div style="display:grid;grid-template-columns:3fr 2fr;gap:12px">
            <div>${comboGraph({ nodes, edges: G.edges })}<div style="font-size:10px;color:${C.mute};margin-top:4px">node = a concept-cluster (size = how many hooks use it) · edge = co-occurrence</div></div>
            <div>${mapCard('Concept map · per-hook combo rarity', 'rarer concept-cluster pairings = brighter', latentMap(N.hook.proj.concept, { color: i => heatCol(rankPct(G.rarity, i)), sel: st.novSel, tip: i => novTip(i, G.rarity[i] != null ? 'rarity ' + G.rarity[i] : 'single concept') }), legendBar('common', 'rare'))}</div></div>`);
        h += note('A rare combination of two <i>familiar</i> concept-clusters (a known anchor + an extreme modifier) is the strongest novelty pattern. Now defined quantitatively: concept = keyphrase, cluster = embedding k-means, rarity = inverse co-occurrence.', C.accent);
        return h;
    }
    function renderNovCoherent() {
        const ch = N.hook.coherent;
        let h = h2c('E · Coherent novelty — novelty × coherence (the curiosity quadrant)', 'X = novelty (distance from corpus). Y = coherence = cos(CLIP image, CLIP text) — do the visuals match the words. Novel + coherent = curiosity; novel + incoherent = confusion.');
        h += cardc(`<div style="display:grid;grid-template-columns:3fr 2fr;gap:12px">
            <div>${quadPlot(ch.nov_pct, ch.coh_pct, { color: i => heatCol(N.videos[i].lv ? (N.videos[i].lv - 4.5) / 4 : 0.5), sel: st.novSel, tip: i => novTip(i, 'coh ' + ch.coherence[i]) })}<div style="font-size:10px;color:${C.mute};margin-top:4px">point colour = views (brighter = more) · click to open its data</div></div>
            <div>${mapCard('Per-second coherence', 'each second coloured by visual↔word match', latentMap(N.second.proj.whole, { color: i => heatCol(N.second.coh_pct[i]), pick: i => N.second.owner[i], sel: st.novSel, r: i => (st.novSel != null && N.second.owner[i] === st.novSel) ? 5 : 2.4, op: () => 0.62, tip: i => novTip(N.second.owner[i], 'sec ' + N.second.sec[i] + ' coh ' + N.second.coherence[i]) }), legendBar('mismatch', 'coherent'))}</div></div>`);
        h += note('<b>Valuable novelty = distance × understandability.</b> Coherence is a defined CLIP cosine, not a human judgement. Once views are overlaid, the curiosity quadrant should be where winners concentrate.', C.green);
        return h;
    }
    function renderNovLedger() {
        const tcol = { geometry: C.cyan, encoder: C.accent, 'model-metric': C.green, defined: C.purple, detection: C.orange, interpreted: C.red };
        let h = h2c('📋 Interpretation ledger — what is measured vs interpreted', 'Every data point in this tab, with its exact definition and how much human/LLM interpretation it carries. The goal: define absolutely everything.');
        h += cardc((N.ledger || []).map(L => `<div style="display:flex;gap:10px;padding:8px 0;border-top:1px solid ${C.border}">
            <div style="width:150px;flex-shrink:0"><div style="font-size:12px;font-weight:700;color:${C.text}">${esc(L.metric)}</div><span style="display:inline-block;margin-top:3px;background:${(tcol[L.type] || C.mute)}22;border:1px solid ${tcol[L.type] || C.mute};color:${tcol[L.type] || C.mute};border-radius:5px;padding:0 6px;font-size:9px;font-weight:800;text-transform:uppercase">${esc(L.type)}</span></div>
            <div style="flex:1;font-size:11px;color:${C.dim};line-height:1.5">${esc(L.def)}</div></div>`).join(''));
        h += note('<b>geometry</b> = pure distance/clustering on vectors · <b>encoder</b> = a fixed pretrained net, identical for all videos · <b>model-metric</b> = a defined scalar (e.g. CLIP cosine) · <b>defined</b> = an explicit formula (MMR keyphrase) · <b>detection</b> = OWLv2 box+score · <b style="color:' + C.red + '">interpreted</b> = LLM prose, shown as context only, never fed into a score.', C.dim);
        return h;
    }
    // ── Correlations: every novelty feature vs the indicators + views ──
    // Human-readable definition for any feature name (parsed from its naming grammar).
    function featDef(name) {
        const MOD = { whole: 'whole-hook (CLIP image + spoken & on-screen text)', concept: 'concept (MiniLM of the spoken + on-screen script)', visual: 'visual (DINOv2 of the frames)', text: 'on-screen text (OCR captions/overlays)' };
        const md = m => MOD[m] || m; let x;
        if (x = name.match(/^global_nov_(\w+)$/)) return `Global novelty of the whole hook in the ${md(x[1])} space — mean cosine distance to its 8 nearest hooks. Higher = more unlike the rest of the corpus.`;
        if (x = name.match(/^nov_s(\d)_(\w+)$/)) return `Novelty of second ${x[1]} on its own, ${md(x[2])} space (how far that second sits from other hooks' second ${x[1]}).`;
        if (x = name.match(/^nov_avg_(\w+)$/)) return `Average novelty across the 5 seconds, ${md(x[1])} space.`;
        if (x = name.match(/^nov_std_(\w+)$/)) return `How much novelty VARIES second-to-second (standard deviation), ${md(x[1])}. High = the hook keeps changing.`;
        if (x = name.match(/^nov_range_(\w+)$/)) return `Spread of novelty across the seconds (max − min), ${md(x[1])}.`;
        if (x = name.match(/^nov_slope_(\w+)$/)) return `Trend of novelty across the 5 seconds, ${md(x[1])} — positive = gets more novel toward second 4.`;
        if (x = name.match(/^nov_d(\d)(\d)_(\w+)$/)) return `Change in novelty from second ${x[1]} → second ${x[2]}, ${md(x[3])} space.`;
        if (x = name.match(/^niche_dist_(\w+)$/)) return `Distance from the hook to the centre of its own niche cluster, ${md(x[1])} — high = an outlier even within its niche.`;
        if (x = name.match(/^niche_switches_(\w+)$/)) return `How many distinct niche clusters the 5 seconds pass through, ${md(x[1])} — high = the hook travels between niches across its seconds.`;
        if (x = name.match(/^in_niche_(\w+)_(\d+)$/)) return `1 if this hook sits in emergent niche cluster #${x[2]} of the ${md(x[1])} space (an unnamed k-means group of similar hooks), else 0.`;
        if (x = name.match(/^traj_len_(\w+)$/)) return `Total length of the path the hook traces through the 2D ${md(x[1])} map over its 5 seconds — high = the content moves around a lot.`;
        if (x = name.match(/^traj_disp_(\w+)$/)) return `Straight-line distance from second 0 to second 4 in the 2D ${md(x[1])} map — the net drift of the hook.`;
        if (x = name.match(/^traj_maxstep_(\w+)$/)) return `The largest single second-to-second jump in the 2D ${md(x[1])} map — the biggest cut/change inside the hook.`;
        if (name === 'coherence_hook') return `Hook coherence — cosine between the visuals (CLIP image) and the words (spoken + on-screen). High = the visuals match what's being said.`;
        if (x = name.match(/^coh_s(\d)$/)) return `Coherence at second ${x[1]} — do that second's visuals match its words.`;
        if (name === 'coh_avg') return `Average coherence across the 5 seconds.`;
        if (name === 'coh_std') return `How much coherence varies across the seconds.`;
        if (name === 'coh_slope') return `Trend of coherence across the seconds (positive = more coherent toward the end).`;
        if (name === 'temporal_hook') return `Temporal novelty — distance from hooks posted within ±45 days. High = unlike what's been posted recently (fresh vs saturated).`;
        if (name === 'temporal_avg') return `Average per-second temporal novelty.`;
        if (name === 'combo_rarity') return `Combinatorial rarity — how rare this hook's concept-cluster pairings are across the corpus (rare combos = novel).`;
        if (name === 'n_concepts') return `Number of distinct concepts (keyphrases) extracted from the hook.`;
        if (x = name.match(/^in_concept_cl_(\d+)$/)) { const cl = N && (N.combo.clusters || []).find(c => c.id === +x[1]); return `1 if the hook contains a concept in concept-cluster #${x[1]}${cl ? ` (e.g. “${esc(cl.label)}”)` : ''}, else 0.`; }
        if (name === 'nobj_hook') return `Number of distinct objects detected across the hook (Grounding DINO).`;
        if (x = name.match(/^nobj_s(\d)$/)) return `Number of objects detected at second ${x[1]}.`;
        if (name === 'nobj_avg') return `Average number of objects detected per second.`;
        if (name === 'nobj_slope') return `Trend in object count across the seconds — positive = more objects appear later in the hook.`;
        if (name === 'scene_spread') return `How much the 5 frames differ visually (mean pairwise distance) — high = lots of visual cutting/change.`;
        return 'No definition available for this feature name.';
    }
    function corScatter(feat, tgt, tvals) {
        const xv = feat.values, yv = (tvals || CR.target_values)[tgt], pts = [];
        for (let i = 0; i < xv.length; i++) if (xv[i] != null && yv[i] != null) pts.push([xv[i], yv[i], i]);
        if (pts.length < 3) return '';
        const w = 520, h = 230, pl = 44, pr = 12, pt = 12, pb = 30;
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
        const X = x => pl + (x - xmin) / (xmax - xmin || 1) * (w - pl - pr), Y = y => h - pb - (y - ymin) / (ymax - ymin || 1) * (h - pt - pb);
        const nn = pts.length, sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0), sxx = xs.reduce((a, b) => a + b * b, 0), sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
        const sl = (nn * sxy - sx * sy) / (nn * sxx - sx * sx || 1), ic = (sy - sl * sx) / nn;
        let s = `<line x1="${pl}" y1="${h - pb}" x2="${w - pr}" y2="${h - pb}" stroke="${C.border2}"/><line x1="${pl}" y1="${pt}" x2="${pl}" y2="${h - pb}" stroke="${C.border2}"/>`;
        s += `<line x1="${X(xmin)}" y1="${Y(sl * xmin + ic)}" x2="${X(xmax)}" y2="${Y(sl * xmax + ic)}" stroke="${C.accent}" stroke-width="2" opacity="0.5" stroke-dasharray="5 3"/>`;
        pts.forEach(p => { const v = N && N.videos[p[2]]; s += `<a href="${v ? esc(v.url) : '#'}" target="_blank"><circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="3" fill="${C.cyan}" opacity="0.6"><title>${v ? esc(v.name) : ''} · ${feat.name} ${fmt(p[0], 2)} · ${tgt} ${fmt(p[1], 1)}</title></circle></a>`; });
        // numeric ticks (min · mid · max) on both axes so the actual range is visible
        const tf = vv => !isFinite(vv) ? '' : Math.abs(vv) >= 1000 ? fv(vv) : (Math.abs(vv) >= 100 || Number.isInteger(vv)) ? vv.toFixed(0) : Math.abs(vv) >= 1 ? vv.toFixed(1) : vv.toFixed(2);
        [xmin, (xmin + xmax) / 2, xmax].forEach((xt, k) => { const xx = X(xt); s += `<line x1="${xx.toFixed(1)}" y1="${h - pb}" x2="${xx.toFixed(1)}" y2="${h - pb + 3}" stroke="${C.border2}"/><text x="${xx.toFixed(1)}" y="${h - pb + 11}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}" fill="${C.mute}" font-size="8">${tf(xt)}</text>`; });
        [ymin, (ymin + ymax) / 2, ymax].forEach(yt => { const yy = Y(yt); s += `<line x1="${pl - 3}" y1="${yy.toFixed(1)}" x2="${pl}" y2="${yy.toFixed(1)}" stroke="${C.border2}"/><text x="${pl - 5}" y="${(yy + 3).toFixed(1)}" text-anchor="end" fill="${C.mute}" font-size="8">${tf(yt)}</text>`; });
        s += `<text x="${(pl + w - pr) / 2}" y="${h - 2}" text-anchor="middle" fill="${C.dim}" font-size="10">${esc(feat.name)} →</text><text x="9" y="${(pt + h - pb) / 2}" fill="${C.dim}" font-size="10" transform="rotate(-90 9 ${(pt + h - pb) / 2})">${esc(tgt)} →</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg>`;
    }
    function corBars(feats, tgt) {
        const rows = feats.map(f => ({ f, c: f.corr[tgt] })).filter(x => x.c).sort((a, b) => Math.abs(b.c.r) - Math.abs(a.c.r));
        const bonf = CR.meta.bonferroni_p, fdr = CR.meta.fdr_p, mid = 250, half = 120;
        return rows.map(({ f, c }) => {
            const sig = c.p < bonf ? '★★' : c.p < fdr ? '★' : c.p < 0.05 ? '•' : '';
            const col = c.r >= 0 ? C.green : C.orange, len = Math.abs(c.r) * half, on = st.corSel === f.name;
            return `<div data-cor="${esc(f.name)}" style="display:flex;align-items:center;gap:8px;padding:2px 4px;cursor:pointer;border-radius:5px;background:${on ? C.card2 : 'transparent'}">
                <div style="width:150px;flex-shrink:0;font-size:11px;color:${c.p < 0.05 ? C.text : C.mute};text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
                <div style="position:relative;flex:1;height:13px"><div style="position:absolute;left:${mid - 4}px;top:0;width:1px;height:13px;background:${C.border2}"></div>
                    <div style="position:absolute;left:${c.r >= 0 ? mid : mid - len}px;top:2px;width:${Math.max(1, len)}px;height:9px;border-radius:2px;background:${col};opacity:${c.p < 0.05 ? 0.95 : 0.4}"></div>
                    <div style="position:absolute;left:${c.r >= 0 ? mid + len + 4 : mid - len - 30}px;top:0;font-size:10px;color:${C.text};font-weight:700">${sgn(c.r)} <span style="color:${sig ? C.yellow : C.faint}">${sig}</span></div></div></div>`;
        }).join('');
    }
    function renderNovCorrelations() {
        if (!CR) return cardc(`<div style="padding:24px;color:${C.mute}">Run <code>build_correlations.py</code> to generate correlations.json.</div>`);
        const tgt = st.corTarget, groups = ['all', ...Array.from(new Set(CR.features.map(f => f.group)))];
        let h = h2c('📊 Correlations — every data point vs the indicators & views', `Each of ${CR.meta.n_features} novelty features Spearman-correlated against keep rate, retention, 5-sec retention, duration, and views. Univariate (each point on its own). n=${CR.meta.n}.`);
        h += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><span style="font-size:10px;color:${C.mute};align-self:center;text-transform:uppercase">vs</span>${CR.targets.map(t => `<button data-cortgt="${t.key}" style="background:${tgt === t.key ? C.accent + '22' : 'transparent'};border:1px solid ${tgt === t.key ? C.accent : C.border};color:${tgt === t.key ? C.accent : C.dim};border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">${t.label}</button>`).join('')}</div>`;
        h += `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">${groups.map(g => `<button data-corgrp="${g}" style="background:${st.corGroup === g ? C.purple + '22' : 'transparent'};border:1px solid ${st.corGroup === g ? C.purple : C.border};color:${st.corGroup === g ? C.purple : C.mute};border-radius:6px;padding:2px 8px;font-size:10px;font-weight:700;cursor:pointer">${g}</button>`).join('')}</div>`;
        const feats = st.corGroup === 'all' ? CR.features : CR.features.filter(f => f.group === st.corGroup);
        if (st.corSel) { const fsel = CR.features.find(f => f.name === st.corSel); if (fsel) h += cardc(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-size:13px;font-weight:800;color:${C.text}">${esc(fsel.name)} <span style="color:${C.mute};font-size:11px">(${esc(fsel.group)})</span></div><button data-corclose style="background:transparent;border:1px solid ${C.border2};color:${C.dim};border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer">✕</button></div>
            <div style="font-size:12px;color:${C.dim};line-height:1.5;background:${C.card2};border-left:3px solid ${C.accent};border-radius:0 6px 6px 0;padding:8px 11px;margin-bottom:8px">${featDef(fsel.name)}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${CR.targets.map(t => { const c = fsel.corr[t.key]; return statc(t.label, c ? sgn(c.r) + (c.p < 0.05 ? ' ✓' : '') : '—', c && c.p < 0.05 ? (c.r >= 0 ? C.green : C.orange) : C.mute); }).join('')}</div>
            ${corScatter(fsel, tgt)}<div style="font-size:10px;color:${C.mute};margin-top:3px">vs ${esc(CR.targets.find(t => t.key === tgt).label)} · dashed = trend · click a point to open the video</div>`); }
        h += note(`<b>Significance:</b> • = raw p&lt;0.05 · ★ = survives FDR (q.10, p≤${fmtv(CR.meta.fdr_p, 4)}) · ★★ = Bonferroni (p&lt;${fmtv(CR.meta.bonferroni_p, 5)}). With ${CR.meta.n_tests} tests, expect ~${Math.round(CR.meta.n_tests * 0.05)} false positives at p&lt;0.05 — trust ★/★★. <b style="color:${C.green}">green +</b>, <b style="color:${C.orange}">orange −</b>. Bars at &lt;0.05 are solid, others faded. Click any row for its scatter.`, C.dim);
        h += cardc(`<div style="font-size:11px;color:${C.mute};margin-bottom:6px">${feats.length} features · sorted by |correlation| vs <b style="color:${C.accent}">${esc(CR.targets.find(t => t.key === tgt).label)}</b></div>${corBars(feats, tgt)}`);
        return h;
    }
    // ── Interactions: stabilized covariance + pairwise synergy between significant features ──
    function matHeat(names, mat, colorFn, clusters) {
        const Nn = names.length, cell = Math.max(9, Math.min(20, Math.floor(420 / Nn)));
        const shortn = s => s.length > 18 ? s.slice(0, 17) + '…' : s;
        let head = `<div style="display:flex"><div style="width:118px;flex-shrink:0"></div>${names.map((nm, j) => `<div style="width:${cell}px;height:64px;position:relative"><div style="position:absolute;bottom:2px;left:${cell / 2}px;writing-mode:vertical-rl;transform:rotate(180deg);font-size:8px;color:${clusters ? NPAL[clusters[j] % NPAL.length] : C.mute};white-space:nowrap">${esc(shortn(nm))}</div></div>`).join('')}</div>`;
        let rows = names.map((nm, i) => `<div style="display:flex;align-items:center"><div style="width:118px;flex-shrink:0;font-size:8.5px;text-align:right;padding-right:4px;color:${clusters ? NPAL[clusters[i] % NPAL.length] : C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(shortn(nm))}</div>${mat[i].map((v, j) => `<div data-pair="${i}_${j}" title="${esc(nm)} × ${esc(names[j])} = ${v}" style="width:${cell}px;height:${cell}px;background:${colorFn(v, i, j)};cursor:pointer;border:${st.intPair === i + '_' + j || st.intPair === j + '_' + i ? '1px solid #fff' : 'none'}"></div>`).join('')}</div>`).join('');
        return `<div style="overflow-x:auto">${head}${rows}</div>`;
    }
    const divCol = (v, pos, neg, scale) => { const t = Math.max(-1, Math.min(1, v / (scale || 1))); const c = t >= 0 ? pos : neg; return `rgba(${c},${(Math.abs(t) * 0.85 + 0.06).toFixed(2)})`; };
    function renderNovInteractions() {
        if (!INT) return cardc(`<div style="padding:24px;color:${C.mute}">Run <code>build_interactions.py</code> to generate interactions.json.</div>`);
        const tk = st.corTarget, D = INT.per_target[tk];
        let h = h2c('🔗 Interactions — how the significant signals relate to each other', 'Among the features that significantly predict the target: which move together (redundant) and which AMPLIFY each other (explain more jointly than the sum). Covariance is Ledoit-Wolf stabilized; rows ordered by clustering so redundant blocks group.');
        h += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><span style="font-size:10px;color:${C.mute};align-self:center;text-transform:uppercase">target</span>${INT.targets.map(t => `<button data-cortgt="${t.key}" style="background:${tk === t.key ? C.accent + '22' : 'transparent'};border:1px solid ${tk === t.key ? C.accent : C.border};color:${tk === t.key ? C.accent : C.dim};border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">${t.label}</button>`).join('')}</div>`;
        if (!D || !D.corr) { h += cardc(`<div style="color:${C.mute};padding:14px">Too few significant features for ${esc(tk)} to map interactions.</div>`); return h; }
        const views = [['synergy', 'Synergy (amplify ↔ redundant)'], ['corr', 'Correlation (redundancy structure)'], ['interaction', 'Multiplicative interaction']];
        h += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${views.map(([id, l]) => `<button data-intview="${id}" style="background:${st.intView === id ? C.purple + '22' : 'transparent'};border:1px solid ${st.intView === id ? C.purple : C.border};color:${st.intView === id ? C.purple : C.mute};border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer">${l}</button>`).join('')}</div>`;
        // pair detail
        if (st.intPair) { const [pi, pj] = st.intPair.split('_').map(Number); if (pi !== pj && D.features[pi] && D.features[pj]) {
            const a = D.features[pi], b = D.features[pj], syn = D.synergy[pi][pj], inter = D.interaction[pi][pj], cc = D.corr[pi][pj], ri = D.single_r2[pi], rj = D.single_r2[pj];
            const verdict = syn > 0.01 ? `<b style="color:${C.green}">amplify</b> — together they explain more than the sum of their singles` : (Math.abs(cc) > 0.4 ? `<b style="color:${C.orange}">redundant</b> — they move together (r=${cc}); the second adds little` : `<b style="color:${C.dim}">independent</b> — roughly additive`);
            h += cardc(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-size:13px;font-weight:800;color:${C.text}">${esc(a)} <span style="color:${C.purple}">×</span> ${esc(b)}</div><button data-intclose style="background:transparent;border:1px solid ${C.border2};color:${C.dim};border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer">✕</button></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${statc('feature corr', sgn(cc), Math.abs(cc) > 0.4 ? C.orange : C.mute)}${statc('synergy', sgn(syn, 3), syn > 0 ? C.green : C.red)}${statc('interaction', sgn(inter, 3), inter > 0 ? C.green : C.mute)}${statc('single R² a/b', fmtv(ri, 2) + ' / ' + fmtv(rj, 2), C.cyan)}</div>
                <div style="font-size:11px;color:${C.dim};line-height:1.45;margin-bottom:6px"><b style="color:${C.text}">${esc(a)}:</b> ${featDef(a)}<br><b style="color:${C.text}">${esc(b)}:</b> ${featDef(b)}</div>
                <div style="font-size:12px;color:${C.dim}">${verdict}.</div>`); } }
        const mat = D[st.intView], scale = st.intView === 'corr' ? 1 : Math.max(0.001, Math.max(...mat.flat().map(Math.abs)));
        const colorFn = st.intView === 'corr' ? (v => divCol(v, '56,189,248', '251,146,60', 1)) : (v => divCol(v, '52,211,153', '248,113,113', scale));
        h += cardc(`<div style="font-size:11px;color:${C.mute};margin-bottom:8px">${st.intView === 'corr' ? 'Stabilized feature-feature correlation — <span style="color:#38bdf8">blue</span>=move together, <span style="color:#fb923c">orange</span>=opposite. Block structure = redundant groups.' : st.intView === 'synergy' ? 'Synergy toward <b>' + esc(INT.targets.find(t => t.key === tk).label) + '</b> — <span style="color:#34d399">green</span> pairs AMPLIFY (explain more than the sum), <span style="color:#f87171">red</span> overlap/interfere. Diagonal = single R².' : 'Multiplicative interaction — <span style="color:#34d399">green</span> = the product term adds signal.'} Click a cell for the pair.</div>${matHeat(D.features, mat, colorFn, D.clusters)}`);
        const pairRow = (p, val, c) => `<div data-pair="${D.features.indexOf(p.a)}_${D.features.indexOf(p.b)}" style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:3px 4px;cursor:pointer;border-bottom:1px solid ${C.border}"><span style="color:${C.dim}">${esc(p.a)} <span style="color:${c}">+</span> ${esc(p.b)}</span><span style="color:${c};font-weight:700">${val(p)}</span></div>`;
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${cardc(`<div style="font-size:12px;font-weight:800;color:${C.green};margin-bottom:6px">⬆ Top amplifying pairs</div>${D.top_synergy.slice(0, 10).map(p => pairRow(p, x => 'synergy ' + sgn(x.synergy, 3), C.green)).join('')}`)}
            ${cardc(`<div style="font-size:12px;font-weight:800;color:${C.orange};margin-bottom:6px">⬇ Top redundant pairs (overlap)</div>${(D.top_redundant || []).slice(0, 10).map(p => pairRow(p, x => 'r=' + x.corr + ' syn ' + sgn(x.synergy, 3), C.orange)).join('') || `<div style="font-size:11px;color:${C.mute}">none strongly correlated</div>`}`)}</div>`;
        h += note('“Synergy” = R²(both) − (r²a + r²b): positive means the two carry <i>different</i> slices of the target so stacking them pays off; negative means they overlap. This is what tells you which signals to combine in a predictor vs which are duplicates. Modest values are expected — these are subtle content signals, not the dominant keep/retention/duration levers.', C.purple);
        return h;
    }
    // ── Confound falsification audit: does any metadata actually move retention/swipe? ──
    function confDef(name) {
        const D = { post_day_of_week: 'Day of week posted (0=Mon). External timing.',
            post_month: 'Calendar month posted. External seasonality.',
            timeline_position: 'How far into the channel history this video sits (0=earliest). Account-growth stage / creator-experience proxy.',
            days_since_prev_post: 'Days since the previous upload. Posting-frequency / cadence proxy.',
            video_age_days: 'How many days ago it was posted. Exposure time / recency.',
            subscribers_gained: 'Subscribers gained around this video. Downstream — a consequence of the video, not a cause of retention.',
            subscribers_lost: 'Subscribers lost around this video. Downstream consequence.',
            subscriber_view_fraction: 'Share of views from existing subscribers. Audience composition — high = served mostly to fans (who retain regardless of the hook).',
            likes: 'Raw like count. Downstream — a consequence of the content, not a cause of retention.',
            comments: 'Raw comment count. Downstream consequence.', shares: 'Raw share count. Downstream consequence.',
            like_rate: 'Likes per 1000 views. Downstream engagement propensity.', comment_rate: 'Comments per 1000 views. Downstream.', share_rate: 'Shares per 1000 views. Downstream.',
            duration: 'Video length. Content/format — longer videos mechanically average a lower % retention (so use retention@5s / swipe, which are length-robust).',
            aspect_ratio: 'Height ÷ width. Format.', is_vertical: '1 if vertical. Format.' };
        return D[name] || 'Metadata factor.';
    }
    const ROLECOL = { external: C.orange, downstream: C.faint, audience: C.purple, content: C.cyan };
    const ROLELAB = { external: 'External confound (timing / cadence / account growth)', downstream: 'Downstream consequence of the video', audience: 'Audience composition', content: 'Content / format' };
    function renderNovConfounds() {
        if (!CF) return cardc(`<div style="padding:24px;color:${C.mute}">Run <code>build_confounds.py</code> to generate confounds.json.</div>`);
        const tk = st.cfTarget, isRate = (CF.targets.find(t => t.key === tk) || {}).kind === 'rate';
        let h = h2c('🧪 Confounds — does any metadata actually move retention / swipe?', `A one-time falsification audit: every external/metadata factor tested against the rate targets (it only measures, never alters the data). Positive control: the same factors vs views — if they hit volume but not the rates, the rates are content-driven. n=${CF.meta.n}.`);
        // definitions reference — what every variable means
        const TGTDEF = { keep_rate: 'the swipe ratio — % of viewers who stayed instead of swiping away.', ret_5s: '% of the video still being watched at the 5-second mark.', retention: 'average % of the whole video watched.', nonsub_ret: 'average % watched by non-subscribers (cold audience — purest content read).', day1_views: 'views in the first ~day (24h volume proxy).', total_views: 'lifetime views (volume).' };
        const byRole = {}; CF.features.forEach(f => (byRole[f.role] = byRole[f.role] || []).push(f.name));
        h += cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:6px">What every variable means</div>
            <div style="font-size:10px;color:${C.mute};text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px">Targets (what we test against)</div>
            ${CF.targets.map(t => `<div style="font-size:11px;color:${C.dim};margin-bottom:2px"><b style="color:${t.kind === 'rate' ? C.green : C.dim}">${esc(t.label)}</b> — ${TGTDEF[t.key] || ''}</div>`).join('')}
            ${Object.keys(ROLECOL).filter(r => byRole[r]).map(r => `<div style="font-size:10px;color:${ROLECOL[r]};text-transform:uppercase;letter-spacing:.3px;margin:9px 0 3px">${ROLELAB[r]}</div>` + byRole[r].map(nm => `<div style="font-size:11px;color:${C.dim};margin-bottom:2px"><b style="color:${C.text}">${esc(nm)}</b> — ${confDef(nm)}</div>`).join('')).join('')}`);
        // per-role joint CV-R² verdict matrix
        const rj = CF.role_joint_r2;
        const cell = v => { const c = v > 0.03 ? C.orange : C.mute; return `<td style="text-align:center;padding:4px 8px;font-size:11px;color:${c};font-weight:${v > 0.03 ? 700 : 400}">${v >= 0 ? '+' : ''}${fmtv(v, 2)}</td>`; };
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:4px">Joint CV-R²: does each group of factors explain the target <i>at all</i>?</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">≤0 = no real signal (worse than guessing the mean). The <b style="color:${C.orange}">External</b> row is the actual confound test.</div>
            <div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:11px"><thead><tr><th style="text-align:left;padding:4px 8px;color:${C.mute}">role</th>${CF.targets.map(t => `<th style="padding:4px 8px;color:${t.kind === 'rate' ? C.green : C.dim};font-size:10px">${esc(t.label)}<div style="font-size:8px;opacity:.7">${t.kind}</div></th>`).join('')}</tr></thead><tbody>
            ${(CF.roles || []).filter(r => rj[r]).map(r => `<tr style="border-top:1px solid ${C.border}"><td style="padding:4px 8px;color:${ROLECOL[r]};font-weight:700">${r}</td>${CF.targets.map(t => cell(rj[r][t.key])).join('')}</tr>`).join('')}</tbody></table></div>`);
        // verdict text for the selected rate target
        const ext = CF.features.filter(f => f.role === 'external');
        const extSig = ext.filter(f => f.corr[tk] && f.corr[tk].p < 0.05).map(f => f.name);
        const trendOnly = extSig.every(nm => nm === 'timeline_position' || nm === 'video_age_days');
        if (isRate) h += note(extSig.length === 0
            ? `<b style="color:${C.green}">Confirmed for ${esc(CF.targets.find(t => t.key === tk).label)}:</b> no external confound is significant. Posting time, cadence and account growth do not move this rate — it's content-driven. No confound control needed.`
            : (trendOnly
                ? `<b style="color:${C.yellow}">Mostly confirmed:</b> the only external factors that move ${esc(CF.targets.find(t => t.key === tk).label)} are <b>recency / timeline-position</b> (newer videos do better) — almost certainly <i>you improving over time</i>, not a true confound. Worth one stability check: confirm the novelty→rate correlations survive controlling for posting recency. Posting time, cadence, account momentum are all inert.`
                : `<b style="color:${C.orange}">Watch:</b> external factors significant here: ${extSig.map(esc).join(', ')}. Worth controlling these for this target.`), extSig.length === 0 ? C.green : (trendOnly ? C.yellow : C.orange));
        // target selector
        h += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 8px"><span style="font-size:10px;color:${C.mute};align-self:center;text-transform:uppercase">vs</span>${CF.targets.map(t => `<button data-cftgt="${t.key}" style="background:${tk === t.key ? (t.kind === 'rate' ? C.green : C.accent) + '22' : 'transparent'};border:1px solid ${tk === t.key ? (t.kind === 'rate' ? C.green : C.accent) : C.border};color:${tk === t.key ? (t.kind === 'rate' ? C.green : C.accent) : C.dim};border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">${esc(t.label)}${t.kind === 'volume' ? ' ⚙' : ''}</button>`).join('')}</div>`;
        // feature detail
        if (st.cfSel) { const fs = CF.features.find(f => f.name === st.cfSel); if (fs) h += cardc(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-size:13px;font-weight:800;color:${C.text}">${esc(fs.name)} <span style="color:${ROLECOL[fs.role]};font-size:11px">· ${ROLELAB[fs.role]}</span></div><button data-cfclose style="background:transparent;border:1px solid ${C.border2};color:${C.dim};border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer">✕</button></div>
            <div style="font-size:12px;color:${C.dim};line-height:1.5;background:${C.card2};border-left:3px solid ${ROLECOL[fs.role]};border-radius:0 6px 6px 0;padding:8px 11px;margin-bottom:8px">${confDef(fs.name)}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${CF.targets.map(t => { const c = fs.corr[t.key]; return statc(t.label, c ? sgn(c.r) + (c.p < 0.05 ? ' ✓' : '') : '—', c && c.p < 0.05 ? (c.r >= 0 ? C.green : C.orange) : C.mute); }).join('')}</div>${corScatter(fs, tk, CF.target_values)}`); }
        // every factor's scatter (each dot a video) vs the selected target — see the actual relationship
        const grid = CF.features.map(f => ({ f, c: f.corr[tk] })).filter(x => x.c).sort((a, b) => Math.abs(b.c.r) - Math.abs(a.c.r))
            .map(({ f, c }) => `<div><div style="font-size:11px;font-weight:700;color:${ROLECOL[f.role]};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)} <span style="color:${c.p < 0.05 ? (c.r >= 0 ? C.green : C.orange) : C.mute};font-weight:800">${sgn(c.r)}${c.p < 0.05 ? '✓' : ''}</span></div>${corScatter(f, tk, CF.target_values)}</div>`).join('');
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Every factor vs ${esc(CF.targets.find(t => t.key === tk).label)} — each dot is a video</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">Look for an actual tilt. A flat cloud = no relationship (the inert confounds); a real slope = a relationship. Click any point to open the video. Dashed = trend line.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${grid}</div>`);
        // bars, coloured by role
        const rows = CF.features.map(f => ({ f, c: f.corr[tk] })).filter(x => x.c).sort((a, b) => Math.abs(b.c.r) - Math.abs(a.c.r));
        const bonf = CF.meta.bonferroni_p, fdr = CF.meta.fdr_p, mid = 250, half = 120;
        const bars = rows.map(({ f, c }) => { const sig = c.p < bonf ? '★★' : c.p < fdr ? '★' : c.p < 0.05 ? '•' : '', col = ROLECOL[f.role], len = Math.abs(c.r) * half, on = st.cfSel === f.name;
            return `<div data-cf="${esc(f.name)}" style="display:flex;align-items:center;gap:8px;padding:2px 4px;cursor:pointer;border-radius:5px;background:${on ? C.card2 : 'transparent'}">
                <div style="width:150px;flex-shrink:0;font-size:11px;color:${c.p < 0.05 ? C.text : C.mute};text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${ROLELAB[f.role]}">${esc(f.name)}</div>
                <div style="position:relative;flex:1;height:13px"><div style="position:absolute;left:${mid - 4}px;top:0;width:1px;height:13px;background:${C.border2}"></div>
                    <div style="position:absolute;left:${c.r >= 0 ? mid : mid - len}px;top:2px;width:${Math.max(1, len)}px;height:9px;border-radius:2px;background:${col};opacity:${c.p < 0.05 ? 0.95 : 0.4}"></div>
                    <div style="position:absolute;left:${c.r >= 0 ? mid + len + 4 : mid - len - 30}px;top:0;font-size:10px;color:${C.text};font-weight:700">${sgn(c.r)} <span style="color:${sig ? C.yellow : C.faint}">${sig}</span></div></div></div>`; }).join('');
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px;font-size:10px">${Object.keys(ROLECOL).map(r => `<span style="color:${ROLECOL[r]}">■ ${r}</span>`).join('')}</div>`;
        h += cardc(`<div style="font-size:11px;color:${C.mute};margin-bottom:6px">Every metadata factor vs <b style="color:${C.accent}">${esc(CF.targets.find(t => t.key === tk).label)}</b>, sorted by |r|, coloured by role. Click any for its definition + scatter.</div>${bars}`);
        h += note(`Only <b style="color:${C.orange}">external</b> factors could be true confounds. <b style="color:${C.faint}">Downstream</b> (likes/shares/comments, subs gained) and <b style="color:${C.purple}">audience</b> (sub-fraction) correlations are expected — they're consequences of the same content that drives retention, not causes, so they don't threaten the novelty findings. <b style="color:${C.cyan}">Content</b> (duration) is intrinsic. The positive-control ⚙ volume targets show metadata barely predicts even views within one account.`, C.dim);
        return h;
    }
    function renderPrinciples() {
        let h = h2c('Principles — deliberately quantifying what makes a hook work', 'Hook = the first 5 seconds of every confirmed video. Embedded several independent ways at two resolutions (whole hook + per second). Objects via detection, concepts via keyphrase math — see the 📋 Ledger for every definition.');
        h += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"><span style="background:${C.purple}22;border:1px solid ${C.purple};color:${C.purple};border-radius:8px;padding:5px 12px;font-size:12px;font-weight:800">✦ Novelty</span><span style="border:1px dashed ${C.border2};color:${C.faint};border-radius:8px;padding:5px 12px;font-size:12px">coherence · soon</span><span style="border:1px dashed ${C.border2};color:${C.faint};border-radius:8px;padding:5px 12px;font-size:12px">tension · soon</span></div>`;
        if (!N) { h += cardc(`<div style="padding:30px;text-align:center;color:${C.dim}">Building novelty geometry… <div style="font-size:11px;color:${C.mute};margin-top:6px">Run the <code>principles/</code> pipeline (embed → detect → concepts → build_novelty) to generate <code>novelty.json</code>.</div></div>`); return h; }
        const MS = [['global', 'A Global'], ['niche', 'B Niche'], ['temporal', 'C Temporal'], ['combo', 'D Combinatorial'], ['coherent', 'E Coherent'], ['correlations', '📊 Correlations'], ['interactions', '🔗 Interactions'], ['ledger', '📋 Ledger']];
        const resBtn = (id, l) => `<button data-novres="${id}" style="background:${st.novRes === id ? C.accent + '22' : 'transparent'};border:1px solid ${st.novRes === id ? C.accent : C.border};color:${st.novRes === id ? C.accent : C.dim};border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer">${l}</button>`;
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
            <div style="display:flex;gap:6px;flex-wrap:wrap">${MS.map(([id, l]) => `<button data-nov="${id}" style="background:${st.nov === id ? C.purple + '22' : 'transparent'};border:1px solid ${st.nov === id ? C.purple : C.border};color:${st.nov === id ? C.purple : C.dim};border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer">${l}</button>`).join('')}</div>
            ${st.nov !== 'combo' && st.nov !== 'ledger' ? `<div style="margin-left:auto;display:flex;gap:6px;align-items:center"><span style="font-size:10px;color:${C.mute};text-transform:uppercase">resolution</span>${resBtn('hook', 'Whole hook')}${resBtn('second', 'Per second')}</div>` : ''}</div>`;
        h += `<div style="font-size:11px;color:${C.mute};margin-bottom:10px">${N.meta.n} hooks · ${N.second.owner.length} seconds · visual ${N.meta.models.visual} · detector ${N.meta.models.detector}. <b>Click any point for its full data — objects (with boxes), concepts, and every metric.</b></div>`;
        if (st.novSel != null && N.videos[st.novSel]) h += renderHookDetail(st.novSel);
        h += ({ global: renderNovGlobal, niche: renderNovNiche, temporal: renderNovTemporal, combo: renderNovCombo, coherent: renderNovCoherent, correlations: renderNovCorrelations, interactions: renderNovInteractions, ledger: renderNovLedger }[st.nov] || renderNovGlobal)();
        return h;
    }

    function render() {
        if (!root) return;
        const SECS = [['data', '📋 Data'], ['q1', '① Views'], ['q2', '② Shape'], ['ind', '③ Drivers'], ['q4', '④ Duration'], ['predict', '⑤ Predict'], ['confounds', '🧪 Confounds'], ['principles', '✦ Principles']];
        const nav = SECS.map(([id, l]) => `<button data-rs="${id}" style="background:${st.sec === id ? C.accent + '22' : 'transparent'};border:1px solid ${st.sec === id ? C.accent : C.border};color:${st.sec === id ? C.accent : C.dim};border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer">${l}</button>`).join('');
        const sec = S ? ({ data: renderData, q1: renderQ1, q2: renderQ2, ind: renderIndicators, q4: renderQ4, predict: renderPredict, confounds: renderNovConfounds, principles: renderPrinciples }[st.sec] || renderData)() : renderData();
        root.innerHTML = `<div style="background:${C.bg};border-radius:12px;padding:16px;color:${C.text};font-family:'Nunito',sans-serif">
            <div style="font-size:21px;font-weight:900;color:${C.accent};margin-bottom:8px">Retention → Views</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">${nav}</div>${sec}</div>`;
    }

    function onClick(e) {
        const ps = e.target.closest('[data-pred-scale]'); if (ps) { st.predScale = ps.getAttribute('data-pred-scale'); render(); return; }
        const pfeat = e.target.closest('[data-predfeat]'); if (pfeat) { const f = pfeat.getAttribute('data-predfeat'); st.predFeats = (st.predFeats || ['keep', 'retention', 'log_dur']); st.predFeats = st.predFeats.includes(f) ? st.predFeats.filter(x => x !== f) : st.predFeats.concat([f]); render(); return; }
        const pset = e.target.closest('[data-predset]'); if (pset) { st.predFeats = pset.getAttribute('data-predset').split('+'); render(); return; }
        const ns = e.target.closest('[data-rs]'); if (ns) { st.sec = ns.getAttribute('data-rs'); render(); return; }
        const nr = e.target.closest('[data-novres]'); if (nr) { st.novRes = nr.getAttribute('data-novres'); render(); return; }
        const ct = e.target.closest('[data-cortgt]'); if (ct) { st.corTarget = ct.getAttribute('data-cortgt'); render(); return; }
        const cg = e.target.closest('[data-corgrp]'); if (cg) { st.corGroup = cg.getAttribute('data-corgrp'); render(); return; }
        if (e.target.closest('[data-corclose]')) { st.corSel = null; render(); return; }
        const cf = e.target.closest('[data-cor]'); if (cf && !e.target.closest('a')) { st.corSel = cf.getAttribute('data-cor'); render(); return; }
        const iv = e.target.closest('[data-intview]'); if (iv) { st.intView = iv.getAttribute('data-intview'); render(); return; }
        if (e.target.closest('[data-intclose]')) { st.intPair = null; render(); return; }
        const ip = e.target.closest('[data-pair]'); if (ip) { st.intPair = ip.getAttribute('data-pair'); render(); return; }
        const cft = e.target.closest('[data-cftgt]'); if (cft) { st.cfTarget = cft.getAttribute('data-cftgt'); render(); return; }
        if (e.target.closest('[data-cfclose]')) { st.cfSel = null; render(); return; }
        const cff = e.target.closest('[data-cf]'); if (cff && !e.target.closest('a')) { st.cfSel = cff.getAttribute('data-cf'); render(); return; }
        const nv = e.target.closest('[data-nov]'); if (nv) { st.nov = nv.getAttribute('data-nov'); render(); return; }
        if (e.target.closest('[data-reload]')) { err = null; DATA = null; mount(root); return; }
        if (e.target.closest('[data-novboxes]')) { st.novBoxes = !(st.novBoxes !== false); render(); return; }
        if (e.target.closest('[data-novclose]')) { st.novSel = null; render(); return; }
        const hk = e.target.closest('[data-hook]'); if (hk) { st.novSel = +hk.getAttribute('data-hook'); render(); return; }
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
            const base = './buildings/jarvis/retention-study/';
            // robust JSON load: reject HTML (a mid-deploy holding page starts with '<') so we don't try to parse it
            // cache-bust so the data sheet stays the single source of truth (no stale JSON in the browser)
            const loadJSON = async (url) => { const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=29'); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(); if (/^\s*</.test(t)) throw new Error('got HTML (deploy in progress)'); return JSON.parse(t); };
            for (let tries = 1; !DATA; tries++) {
                try {
                    DATA = await loadJSON(base + 'retention_table.json');
                    S = await loadJSON(base + 'retention_study.json').catch(() => null);
                    N = await loadJSON(base + 'principles/novelty.json').catch(() => null);
                    CR = await loadJSON(base + 'principles/correlations.json').catch(() => null);
                    INT = await loadJSON(base + 'principles/interactions.json').catch(() => null);
                    CF = await loadJSON(base + 'principles/confounds.json').catch(() => null);
                } catch (e) {
                    if (tries >= 3) { root.innerHTML = `<div style="padding:24px;color:${C.dim}">Couldn't load data — the site may be mid-deploy. <button data-reload style="background:${C.accent}22;border:1px solid ${C.accent};color:${C.accent};border-radius:6px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer;margin-left:8px">Retry</button></div>`; return; }
                    root.innerHTML = `<div style="padding:40px;text-align:center;color:${C.dim}">Loading… <span style="color:${C.mute};font-size:11px">(retry ${tries})</span></div>`;
                    await new Promise(res => setTimeout(res, 1500));
                }
            }
        }
        render();
    }
    return { mount };
})();
if (typeof window !== 'undefined') window.JarvisRetention = JarvisRetention;
if (typeof module !== 'undefined' && module.exports) module.exports = JarvisRetention;
