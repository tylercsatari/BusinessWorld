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
    let root = null, DATA = null, S = null, N = null, CR = null, INT = null, CF = null, RTG = null, RTGP = null, RTGD = null, RTGF = null, RTGA = null, RTGS = null, err = null;
    const THREAD_COLORS = ['#38bdf8', '#34d399', '#a78bfa', '#fbbf24', '#f472b6', '#fb923c', '#22d3ee', '#a3e635'];
    const st = { sec: 'data', sort: 'views', dir: -1, q: '', open: null, predScale: 'actual', predFeats: ['keep', 'retention', 'log_dur'], predInts: [], nov: 'global', novRes: 'hook', corTarget: 'ret_5s', corGroup: 'all', corSel: null, intView: 'synergy', intPair: null, cfTarget: 'keep_rate', cfSel: null, principle: 'novelty', rtgSel: null, rtgMods: { cv: 1, vv: 1, cc: 1, vc: 1 }, rtgDet: 'declared' };
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
    // The predictor is FIT LIVE in the browser by ordinary least squares on your 211 videos, from the
    // SAME data-sheet values (S.scatter). Whatever inputs/interactions are checked define the equation,
    // and it re-derives every time — so the math shown always matches the current selection.
    const FVAL = { keep: r => r.keep, retention: r => r.retention, ret5: r => r.ret5, log_dur: r => r.log_dur };
    const FEAT_ORDER = () => (S.predictor.order || ['keep', 'retention', 'ret5', 'log_dur']);
    function pdata() { return (S.scatter || []).filter(p => p.keep != null && p.ret != null && p.ret5 != null && p.dur > 0 && p.lv != null).map(p => ({ keep: p.keep, retention: p.ret, ret5: p.ret5, log_dur: Math.log(p.dur), lv: p.lv })); }
    function solveLin(A, b) { const n = A.length, M = A.map((r, i) => r.concat([b[i]])); // Gauss-Jordan w/ partial pivot
        for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const pv = M[c][c] || 1e-12; for (let j = c; j <= n; j++) M[c][j] /= pv; for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; } }
        return M.map(r => r[n]); }
    function olsRaw(rows, terms) {   // fit lv = b0 + Σ b_k·term_k ; return RAW coefficients (centered fit for stability)
        const n = rows.length, k = terms.length, cols = terms.map(t => rows.map(t.val)), y = rows.map(r => r.lv);
        const means = cols.map(c => c.reduce((a, b) => a + b, 0) / n), Xc = cols.map((c, i) => c.map(v => v - means[i]));
        const p = k + 1, XtX = Array.from({ length: p }, () => new Array(p).fill(0)), Xty = new Array(p).fill(0);
        for (let r = 0; r < n; r++) { const d = [1]; for (let i = 0; i < k; i++) d.push(Xc[i][r]); for (let i = 0; i < p; i++) { Xty[i] += d[i] * y[r]; for (let j = 0; j < p; j++) XtX[i][j] += d[i] * d[j]; } }
        for (let i = 1; i < p; i++) XtX[i][i] += 1e-6;
        const beta = solveLin(XtX, Xty); let b0 = beta[0]; for (let i = 0; i < k; i++) b0 -= beta[i + 1] * means[i];
        const coef = {}; terms.forEach((t, i) => coef[t.key] = beta[i + 1]);
        let ss = 0; for (let r = 0; r < n; r++) { let pr = beta[0]; for (let i = 0; i < k; i++) pr += beta[i + 1] * Xc[i][r]; ss += (y[r] - pr) ** 2; }
        return { coef, intercept: b0, residSd: Math.sqrt(ss / n) };
    }
    function cvR2(rows, terms) {     // 5-fold out-of-sample R²
        const n = rows.length, oof = new Array(n);
        for (let f = 0; f < 5; f++) { const tr = rows.filter((_, i) => i % 5 !== f); const m = olsRaw(tr, terms);
            for (let i = 0; i < n; i++) if (i % 5 === f) { let pr = m.intercept; terms.forEach(t => pr += m.coef[t.key] * t.val(rows[i])); oof[i] = pr; } }
        const y = rows.map(r => r.lv), yb = y.reduce((a, b) => a + b, 0) / n; let ssr = 0, sst = 0;
        for (let i = 0; i < n; i++) { ssr += (y[i] - oof[i]) ** 2; sst += (y[i] - yb) ** 2; }
        return sst ? 1 - ssr / sst : 0;
    }
    function termsFor(feats, ints) { return feats.map(f => ({ key: f, val: FVAL[f] })).concat(ints.map(p => { const [a, b] = p.split('×'); return { key: p, val: r => FVAL[a](r) * FVAL[b](r) }; })); }
    function curModel() {
        const rows = pdata(); if (!rows.length) return null;
        const feats = FEAT_ORDER().filter(f => (st.predFeats || ['keep', 'retention', 'log_dur']).includes(f)); if (!feats.length) return null;
        const ints = (st.predInts || []).filter(p => { const [a, b] = p.split('×'); return feats.includes(a) && feats.includes(b); });
        const terms = termsFor(feats, ints), m = olsRaw(rows, terms), cv = cvR2(rows, terms);
        const sliders = feats.map(f => Object.assign({ key: f }, S.predictor.feat_meta[f])), feat_median = {};
        feats.forEach(f => feat_median[f] = S.predictor.feat_meta[f].default);
        return { feats, ints, terms, coef: m.coef, intercept: m.intercept, resid_sd_log10: m.residSd, cv_r2: cv, sliders, feat_median, labels: feats.map(f => S.predictor.feat_meta[f].label) };
    }
    function pval(key) { st.pvals = st.pvals || {}; const fm = S.predictor.feat_meta[key]; return st.pvals[key] != null ? st.pvals[key] : (fm ? fm.default : 0); }
    function fvFeat(f, nat) { return f === 'log_dur' ? Math.log(Math.max(nat, 1)) : nat; }   // slider (natural) → feature-space value
    function predictBest(overrides, model) {
        const m = model || curModel(), P10 = e => Math.pow(10, e); if (!m) return { log: 0, mid: 0, lo50: 0, hi50: 0, lo80: 0, hi80: 0 };
        const fv = {}; m.feats.forEach(f => fv[f] = fvFeat(f, overrides && overrides[f] != null ? overrides[f] : pval(f)));
        let plog = m.intercept; m.feats.forEach(f => plog += m.coef[f] * fv[f]); m.ints.forEach(p => { const [a, b] = p.split('×'); plog += m.coef[p] * fv[a] * fv[b]; });
        const sd = m.resid_sd_log10;
        return { log: plog, mid: P10(plog), lo50: P10(plog - 0.6745 * sd), hi50: P10(plog + 0.6745 * sd), lo80: P10(plog - 1.2816 * sd), hi80: P10(plog + 1.2816 * sd) };
    }
    function predictOut(model) {
        const vb = model || curModel(); if (!vb) return ''; const r = predictBest(null, vb);
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
    function updatePredict() { const m = curModel();
        const o = root.querySelector('#predict-out'); if (o) o.innerHTML = predictOut(m);
        const eq = root.querySelector('#predict-eq'); if (eq && m) eq.innerHTML = predEquation(m);
        const g = root.querySelector('#predict-graph'); if (g) g.innerHTML = leverGraph(m);
        const pg = root.querySelector('#predict-pairs'); if (pg) pg.innerHTML = pairSurfaces(m);
        (m || { sliders: [] }).sliders.forEach(s => { const el = root.querySelector('#pf-' + s.key + '-val'); if (el) el.textContent = pval(s.key) + s.unit; }); }
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
    function leverGraph(model) {
        const vb = model || curModel(); if (!vb) return ''; const scale = st.predScale || 'actual', w = 520, h = 230, pl = 46, pr = 16, pt = 14, pb = 34;
        const series = vb.sliders.map(sl => {
            const vals = valsFor(sl, 25);
            return { sl, pts: vals.map(v => ({ x: v, r: predictBest({ [sl.key]: v }, vb) })) };
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
            const cur = pval(se.sl.key), r = predictBest({ [se.sl.key]: cur }, vb);
            s += `<circle cx="${X(cur, se.sl)}" cy="${Y(metricVal(r))}" r="4" fill="${color}" stroke="${C.bg}" stroke-width="1.5"><title>${esc(se.sl.label)} ${fmt(cur, 0)}${se.sl.unit} → ${fv(r.mid)} views</title></circle>`;
            s += `<text x="${pl + i * 112}" y="11" fill="${color}" font-size="9" font-weight="800">${esc(se.sl.label)}</text>`;
        });
        s += `<text x="${(pl + w - pr) / 2}" y="${h - 6}" text-anchor="middle" fill="${C.dim}" font-size="10">each lever swept min→max, other levers held at current slider values</text>`;
        s += `<text x="11" y="${(pt + h - pb) / 2}" fill="${C.dim}" font-size="10" transform="rotate(-90 11 ${(pt + h - pb) / 2})">${scale === 'log' ? 'log10 views' : 'actual views (linear axis)'}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg>`;
    }
    function pairSurface(a, b, mdl) {
        const av = valsFor(a, 6), bv = valsFor(b, 6), cells = [];
        av.forEach(x => bv.forEach(y => { const r = predictBest({ [a.key]: x, [b.key]: y }, mdl); cells.push({ x, y, r, m: metricVal(r) }); }));
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
    function pairSurfaces(model) {
        const m = model || curModel(); if (!m || m.sliders.length < 2) return `<div style="font-size:11px;color:${C.mute}">Check at least two inputs to see combined surfaces.</div>`;
        const sl = m.sliders, pairs = [];
        for (let i = 0; i < sl.length; i++) for (let j = i + 1; j < sl.length; j++) pairs.push(pairSurface(sl[i], sl[j], m));
        return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px">${pairs.join('')}</div>`;
    }
    function curKey() { return FEAT_ORDER().filter(f => (st.predFeats || ['keep', 'retention', 'log_dur']).includes(f)).join('+'); }
    // The written-out math: the fitted equation + a term-by-term breakdown for the current inputs.
    function termLbl(k) { if (k === 'log_dur') return 'ln(duration)'; if (k.includes('×')) { const [a, b] = k.split('×'); return '(' + (a === 'log_dur' ? 'ln(dur)' : a) + ' × ' + (b === 'log_dur' ? 'ln(dur)' : b) + ')'; } return k; }
    function predEquation(m) {
        const sign = v => (v >= 0 ? ' + ' : ' − ') + Math.abs(v);
        let eq = `log₁₀(views) = ${fmtv(m.intercept, 3)}`;
        m.feats.forEach(f => eq += sign(+m.coef[f].toFixed(4)) + '·' + termLbl(f));
        m.ints.forEach(p => eq += sign(+m.coef[p].toFixed(5)) + '·' + termLbl(p));
        // term-by-term for the current slider values
        const fv2 = {}; m.feats.forEach(f => fv2[f] = fvFeat(f, pval(f)));
        const rows = [['intercept', '', m.intercept]];
        m.feats.forEach(f => { const c = m.coef[f] * fv2[f]; rows.push([termLbl(f), m.coef[f].toFixed(4) + ' × ' + fmtv(fv2[f], 2), c]); });
        m.ints.forEach(p => { const [a, b] = p.split('×'); const prod = fv2[a] * fv2[b], c = m.coef[p] * prod; rows.push([termLbl(p), m.coef[p].toFixed(5) + ' × ' + fmtv(prod, 1), c]); });
        const total = rows.reduce((s, r) => s + r[2], 0), P10 = e => Math.pow(10, e);
        const tr = rows.map(r => `<tr><td style="padding:2px 8px;color:${C.dim}">${esc(r[0])}</td><td style="padding:2px 8px;text-align:right;color:${C.mute};font-family:monospace">${esc(r[1])}</td><td style="padding:2px 8px;text-align:right;color:${C.text};font-family:monospace">${r[2] >= 0 ? '+' : ''}${r[2].toFixed(3)}</td><td style="padding:2px 8px;text-align:right;color:${r[2] >= 0 ? C.green : C.orange};font-family:monospace">×${P10(r[2]) >= 1000 ? fv(P10(r[2])) : P10(r[2]).toFixed(2)}</td></tr>`).join('');
        return cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">The exact math (fit live by least squares on your ${m && pdata().length} videos)</div>
            <div style="font-size:11px;color:${C.dim};font-family:monospace;background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:9px 11px;margin-bottom:8px;overflow-x:auto;white-space:nowrap">${esc(eq)}</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:4px">For your current inputs — each term = coefficient × value, summed in log₁₀, then 10^sum = views:</div>
            <div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:11px;width:100%"><thead><tr style="color:${C.mute};font-size:9px;text-transform:uppercase"><th style="text-align:left;padding:2px 8px">term</th><th style="text-align:right;padding:2px 8px">coef × value</th><th style="text-align:right;padding:2px 8px">+ log₁₀</th><th style="text-align:right;padding:2px 8px">× factor</th></tr></thead><tbody>${tr}
                <tr style="border-top:1px solid ${C.border2};font-weight:800"><td style="padding:4px 8px;color:${C.text}">= log₁₀(views)</td><td></td><td style="padding:4px 8px;text-align:right;color:${C.accent};font-family:monospace">${total.toFixed(3)}</td><td style="padding:4px 8px;text-align:right;color:${C.accent};font-family:monospace">${fv(P10(total))}</td></tr></tbody></table></div>
            <div style="font-size:10px;color:${C.mute};margin-top:6px">Uncheck an input → its term drops and <b>every coefficient re-fits</b> (the equation re-derives). Add an interaction → a product term joins. ${m.ints.length ? '' : 'Right now it\'s purely additive in log-views = <b>multiplicative in views</b> (each factor multiplies), which already captures "both high → compounds".'}</div>`);
    }
    function predInteractionTable() {
        const rows = pdata(); const feats = FEAT_ORDER().filter(f => (st.predFeats || []).includes(f));
        if (feats.length < 2) return '';
        const baseTerms = termsFor(feats, []), baseCv = cvR2(rows, baseTerms), pairs = [];
        for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) { const a = feats[i], b = feats[j], key = a + '×' + b;
            const cv = cvR2(rows, termsFor(feats, [key])), on = (st.predInts || []).includes(key);
            pairs.push({ key, a, b, cv, delta: cv - baseCv, on }); }
        pairs.sort((x, y) => y.delta - x.delta);
        const lab = f => S.predictor.feat_meta[f].label;
        return cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Interactions — does combining two inputs add signal?</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">Each row adds that product term and re-tests out-of-sample. <b style="color:${C.green}">+Δ = it pays</b> (genuine interaction beyond the multiplicative baseline); ≈0 or − = redundant. Click to toggle it into the model.</div>
            ${pairs.map(p => `<div data-predint="${p.key}" style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:5px;background:${p.on ? C.purple + '22' : 'transparent'};border:1px solid ${p.on ? C.purple : 'transparent'}">
                <span style="width:18px;color:${p.on ? C.purple : C.faint}">${p.on ? '☑' : '☐'}</span>
                <span style="flex:1;font-size:11px;color:${p.on ? C.text : C.dim}">${esc(lab(p.a))} × ${esc(lab(p.b))}</span>
                <span style="width:90px;text-align:right;font-size:11px;color:${C.accent}">CV R² ${fmtv(p.cv, 3)}</span>
                <span style="width:60px;text-align:right;font-size:11px;color:${p.delta > 0.005 ? C.green : p.delta < -0.005 ? C.orange : C.mute};font-weight:700">${sgn(p.delta, 3)}</span></div>`).join('')}`);
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
        const intChips = (st.predInts || []).filter(p => { const [a, b] = p.split('×'); return st.predFeats.includes(a) && st.predFeats.includes(b); });
        let h = h2c('⑤ Predict — expected views, your choice of levers', `Model log-views from the inputs + interactions you check; the equation re-fits live by least squares on ${S.meta.n} videos. The math is written out below.`);
        h += cardc(`<div style="font-size:11px;color:${C.mute};margin-bottom:6px">Model views from these inputs:</div><div style="display:flex;gap:6px;flex-wrap:wrap">${chk}</div>${intChips.length ? `<div style="font-size:11px;color:${C.mute};margin:8px 0 4px">+ interactions: ${intChips.map(p => { const [a, b] = p.split('×'); return `<span style="color:${C.purple};font-weight:700">${esc(P.feat_meta[a].label)}×${esc(P.feat_meta[b].label)}</span>`; }).join(', ')}</div>` : ''}`);
        if (!vb) { h += note('Select at least one input above.', C.orange); return h; }
        const rngMult = P10(1.2816 * vb.resid_sd_log10);
        const sld = s => { const c = SLCOL[s.key] || C.cyan, val = pval(s.key); return `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="color:${c};font-weight:700">${esc(s.label)}</span><span id="pf-${s.key}-val" style="color:${C.text};font-weight:800">${val}${s.unit}</span></div>
            <input type="range" data-pf="${s.key}" min="${Math.floor(s.min)}" max="${Math.ceil(s.max)}" value="${val}" step="1" style="width:100%;accent-color:${c}"/></div>`; };
        h += cardc(`<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">${statc('inputs', vb.labels.join(' + ') + (vb.ints.length ? ' +' + vb.ints.length + ' int' : ''), C.accent)}${statc('model R² (CV)', fmtv(vb.cv_r2, 2), vb.cv_r2 > 0.25 ? C.green : C.cyan)}${statc('view range', '×/÷ ' + fmtv(rngMult, 1), C.orange)}</div>
            ${vb.sliders.map(sld).join('')}
            <div id="predict-out" style="margin-top:6px;padding-top:12px;border-top:1px solid ${C.border}">${predictOut(vb)}</div>`);
        h += `<div id="predict-eq">${predEquation(vb)}</div>`;
        h += predInteractionTable();
        h += predComparison();
        h += cardc(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
                <div><div style="font-weight:700;color:${C.text}">Independent lever response curves</div><div style="font-size:11px;color:${C.mute};margin-top:2px">Each line sweeps one input while the others stay fixed. Actual views uses a true linear y-axis; log10 compresses the same model so the lower range is readable.</div></div>
                <div style="display:flex;gap:6px">
                    <button data-pred-scale="actual" style="background:${st.predScale === 'actual' ? C.accent + '22' : 'transparent'};border:1px solid ${st.predScale === 'actual' ? C.accent : C.border};color:${st.predScale === 'actual' ? C.accent : C.dim};border-radius:7px;padding:5px 9px;font-size:11px;font-weight:800;cursor:pointer">actual views</button>
                    <button data-pred-scale="log" style="background:${st.predScale === 'log' ? C.accent + '22' : 'transparent'};border:1px solid ${st.predScale === 'log' ? C.accent : C.border};color:${st.predScale === 'log' ? C.accent : C.dim};border-radius:7px;padding:5px 9px;font-size:11px;font-weight:800;cursor:pointer">log10</button>
                </div></div><div id="predict-graph">${leverGraph(vb)}</div>`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Combined lever surfaces</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:9px">Every cell is a model instance: two inputs swept together while the others stay at your current slider value.</div>
            <div id="predict-pairs">${pairSurfaces(vb)}</div>`);
        h += note(`<b>${esc(vb.labels.join(' + '))}</b>${vb.ints.length ? ' (+interactions)' : ''} pins down ~${Math.round(vb.cv_r2 * 100)}% of views (CV R² ${fmtv(vb.cv_r2, 2)}), leaving a ×/÷ ${fmtv(rngMult, 1)} band — the rest is the algorithm's push, topic and timing, which no on-video metric sees. The interaction table shows which pairs genuinely add (keep×5-sec retention is the big one); most don't, because additive-in-log already multiplies them.`, C.accent);
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
    const RMODC = { cv: '#38bdf8', vv: '#34d399', cc: '#a78bfa', vc: '#fbbf24' };
    function rtgArc(v) {
        // two-track arc diagram: V track (top) + C track (bottom), arcs = directed dependencies
        const n = v.n_sec; if (!n) return `<div style="color:${C.mute};padding:20px">no tokens</div>`;
        const W = 820, pad = 34, innerW = W - 2 * pad, yV = 64, yC = 168, H = 232;
        const x = s => pad + (n <= 1 ? 0 : s / (n - 1) * innerW);
        const edges = (v.edges || []).filter(e => st.rtgMods[e.mod]);
        // endpoints actually used (so we only mark real refs/grats)
        const srcMark = {}, dstMark = {};
        edges.forEach(e => { const sy = e.mod[0] === 'c' ? yC : yV, dy = e.mod[1] === 'c' ? yC : yV;
            srcMark[e.mod[0] + ':' + e.i] = sy; dstMark[e.mod[1] + ':' + e.j] = dy; });
        const sOp = s => Math.max(0.3, Math.min(0.92, (s - 0.05) / 0.4 + 0.3));
        let arcs = '';
        edges.forEach(e => {
            const xi = x(e.i), xj = x(e.j), col = RMODC[e.mod], op = sOp(e.s), sw = 1 + Math.min(2.4, Math.max(0, e.z) * 30);
            if (e.mod === 'vv' || e.mod === 'cc') {
                const yy = e.mod === 'vv' ? yV : yC, bulge = Math.min(46, 10 + (xj - xi) * 0.35) * (e.mod === 'vv' ? -1 : 1);
                arcs += `<path d="M ${xi} ${yy} Q ${(xi + xj) / 2} ${yy + bulge} ${xj} ${yy}" fill="none" stroke="${col}" stroke-width="${sw}" opacity="${op}"><title>${MOD_T(e)}</title></path>`;
            } else {
                const ys = e.mod[0] === 'c' ? yC : yV, yd = e.mod[1] === 'c' ? yC : yV, mx = (xi + xj) / 2;
                arcs += `<path d="M ${xi} ${ys} C ${xi} ${(ys + yd) / 2} ${mx} ${yd} ${xj} ${yd}" fill="none" stroke="${col}" stroke-width="${sw}" opacity="${op}"><title>${MOD_T(e)}</title></path>`;
            }
        });
        // markers: triangle = reference (source), circle = gratification (dst) — all clickable
        let marks = '';
        Object.keys(srcMark).forEach(k => { const i = +k.split(':')[1], yy = srcMark[k], xi = x(i); marks += `<path data-rtgnode="${i}" style="cursor:pointer" d="M ${xi - 4.5} ${yy + (yy === yV ? -7 : 7)} L ${xi + 4.5} ${yy + (yy === yV ? -7 : 7)} L ${xi} ${yy} Z" fill="${C.text}" opacity="0.85"><title>reference at ${i}s — click to inspect + play</title></path>`; });
        Object.keys(dstMark).forEach(k => { const j = +k.split(':')[1], yy = dstMark[k], xj = x(j); marks += `<circle data-rtgnode="${j}" style="cursor:pointer" cx="${xj}" cy="${yy}" r="4" fill="${C.bg}" stroke="${C.text}" stroke-width="1.5" opacity="0.95"><title>gratification at ${j}s — click to inspect + play</title></circle>`; });
        // orphans: open loops + payoffs with no partner (dashed orange, no arc)
        (v.unclosed || []).forEach(u => { const yy = u.mod[0] === 'c' ? yC : yV, xi = x(u.i); marks += `<path data-rtgnode="${u.i}" style="cursor:pointer" d="M ${xi - 4.5} ${yy + (yy === yV ? -7 : 7)} L ${xi + 4.5} ${yy + (yy === yV ? -7 : 7)} L ${xi} ${yy} Z" fill="none" stroke="${C.orange}" stroke-width="1.1" stroke-dasharray="2 1.5"><title>unclosed reference (open loop) at ${u.i}s — click to inspect</title></path>`; });
        (v.orphan_grat || []).forEach(t => { const xi = x(t); marks += `<circle data-rtgnode="${t}" style="cursor:pointer" cx="${xi}" cy="${yV}" r="4" fill="none" stroke="${C.orange}" stroke-width="1.4" stroke-dasharray="2 1.5"><title>orphan gratification (no setup) at ${t}s — click to inspect</title></circle>`; });
        const ph = `<line class="rtg-ph" data-x0="${pad}" data-x1="${W - pad}" data-n="${n}" x1="${pad}" y1="12" x2="${pad}" y2="${H - 18}" stroke="#fff" stroke-width="1.5" opacity="0" style="pointer-events:none"/>`;
        // second ticks + speech shading on C track
        let ticks = '';
        for (let s = 0; s < n; s++) { const xs = x(s); ticks += `<line x1="${xs}" y1="${yV}" x2="${xs}" y2="${yV}" />`;
            if (v.has_c && v.has_c[s]) ticks += `<rect x="${xs - 1.4}" y="${yC - 3}" width="2.8" height="6" fill="${RMODC.cc}" opacity="0.5"/>`; }
        const axisLab = [0, Math.floor((n - 1) / 4), Math.floor((n - 1) / 2), Math.floor(3 * (n - 1) / 4), n - 1].map(s =>
            `<text x="${x(s)}" y="${H - 6}" fill="${C.mute}" font-size="9" text-anchor="middle">${s}s</text>`).join('');
        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;background:${C.card2};border-radius:10px">
            <line x1="${pad}" y1="${yV}" x2="${W - pad}" y2="${yV}" stroke="${C.border2}" stroke-width="1.5"/>
            <line x1="${pad}" y1="${yC}" x2="${W - pad}" y2="${yC}" stroke="${C.border2}" stroke-width="1.5"/>
            <text x="6" y="${yV - 10}" fill="${C.dim}" font-size="11" font-weight="700">VISUAL</text>
            <text x="6" y="${yC + 22}" fill="${C.dim}" font-size="11" font-weight="700">CONCEPT</text>
            ${arcs}${marks}${ph}${axisLab}</svg>`;
    }
    function MOD_T(e) { return `${RTGA.mod_label[e.mod]} · ${e.i}s → ${e.j}s · strength ${e.s}`; }
    const RMODS = ['cv', 'vv', 'cc', 'vc'];
    // ---- synced YouTube player + playhead that crosses the RTG channels ----
    let rtgPlayer = null, rtgYTLoading = false, rtgYTCbs = [], rtgRAF = null, rtgCurT = 0, rtgLastSec = -1;
    function rtgLoadYT(cb) {
        if (typeof window === 'undefined' || !window.document) return;
        if (window.YT && window.YT.Player) { cb(); return; }
        rtgYTCbs.push(cb); if (rtgYTLoading) return; rtgYTLoading = true;
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = function () { if (typeof prev === 'function') prev(); rtgYTCbs.splice(0).forEach(f => { try { f(); } catch (e) { } }); };
        const s = window.document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api';
        (window.document.head || window.document.body).appendChild(s);
    }
    function rtgSetPlayhead(t) {
        rtgCurT = t;
        try {
            window.document.querySelectorAll('.rtg-ph').forEach(ph => {
                const x0 = +ph.getAttribute('data-x0'), x1 = +ph.getAttribute('data-x1'), n = +ph.getAttribute('data-n');
                const x = x0 + Math.max(0, Math.min(n - 1, t)) / ((n - 1) || 1) * (x1 - x0);
                ph.setAttribute('x1', x); ph.setAttribute('x2', x); ph.style.opacity = 0.9;
            });
            const lab = window.document.getElementById('rtg-curt'); if (lab) lab.textContent = t.toFixed(1) + 's';
            const sl = window.document.getElementById('rtg-seek'); if (sl && window.document.activeElement !== sl) sl.value = t;
            const sc = Math.round(t);
            if (sc !== rtgLastSec) { rtgLastSec = sc; const cur = window.document.getElementById('rtg-cursec'); if (cur) cur.innerHTML = rtgSecInfo(sc); }
        } catch (e) { }
    }
    function rtgSeek(t) { try { if (rtgPlayer && rtgPlayer.seekTo) { rtgPlayer.seekTo(t, true); if (rtgPlayer.playVideo) rtgPlayer.playVideo(); } } catch (e) { } rtgSetPlayhead(t); }
    function rtgTick() {
        if (typeof requestAnimationFrame === 'undefined') return;
        rtgRAF = requestAnimationFrame(rtgTick);
        try { if (rtgPlayer && rtgPlayer.getCurrentTime) { const ct = rtgPlayer.getCurrentTime(); if (typeof ct === 'number' && isFinite(ct)) rtgSetPlayhead(ct); } } catch (e) { }
    }
    function rtgAfterRender() {
        if (typeof window === 'undefined' || !window.document || !window.document.getElementById) return;
        const host = window.document.getElementById('rtg-yt');
        rtgLastSec = -1;
        if (!host) { try { if (rtgPlayer && rtgPlayer.destroy) rtgPlayer.destroy(); } catch (e) { } rtgPlayer = null; return; }
        const vid = host.getAttribute('data-vid');
        try { if (rtgPlayer && rtgPlayer.destroy) rtgPlayer.destroy(); } catch (e) { } rtgPlayer = null;
        rtgLoadYT(() => { try { rtgPlayer = new window.YT.Player('rtg-yt', { height: '373', width: '210', videoId: vid, playerVars: { playsinline: 1, rel: 0, modestbranding: 1 }, events: {} }); } catch (e) { } });
        if (rtgRAF == null) rtgTick();
    }
    function rtgSecInfo(t) {
        const v = RTGA.videos[st.rtgSel]; if (!v || t < 0 || t >= v.n_sec) return '';
        const w0 = (v.words && v.words[t]) || '';
        if (v.threadV) {            // emergence schema — clusters, no labels
            const tv = v.threadV[t], tc = v.threadC[t];
            const chip = (th, lab) => th < 0 ? `<span style="font-size:10px;color:${C.mute}">${lab}: —</span>` : `<span style="background:${tcol(th)}22;border:1px solid ${tcol(th)};color:${tcol(th)};border-radius:5px;padding:1px 7px;font-size:10px;font-weight:700">${lab} · cluster ${th}</span>`;
            const cx = (v.ctx && v.ctx[t]) || '', rf = (v.refness && v.refness[t]) || 0, pf = (v.payoff && v.payoff[t]) || 0;
            return `<div style="font-size:12px;color:${C.text};font-weight:800;margin-bottom:4px">Second ${t} · ${t}.0s</div>
                <div style="margin-bottom:6px;display:flex;gap:6px;flex-wrap:wrap">${chip(tv, 'visual')} ${chip(tc, 'concept')}</div>
                ${cx ? `<div style="font-size:11px;color:${C.dim};margin-bottom:6px;line-height:1.45">🗣 <span style="color:${C.mute}">utterance:</span> “${esc(cx)}”</div>` : `<div style="font-size:10px;color:${C.mute};margin-bottom:6px">(no speech)</div>`}
                <div style="display:flex;gap:14px;font-size:11px;margin-bottom:5px"><span>reference-ness <b style="color:${C.cyan}">${rf.toFixed(2)}</b></span><span>payoff-ness <b style="color:${C.green}">${pf.toFixed(2)}</b></span><span style="color:${C.mute}">Δvisual ${(v.vsurp && v.vsurp[t] || 0).toFixed(3)}</span></div>
                <div style="font-size:10px;color:${C.mute};line-height:1.5">reference-ness peaks where a spoken idea points to a <i>specific</i> later visual that isn't present yet; payoff-ness peaks where a later visual fulfils one. Both are continuous fields — the markers are just the peaks, nothing thresholded.</div>`;
        }
        const refs = v.edges.filter(e => e.i === t), grats = v.edges.filter(e => e.j === t);
        const uncl = (v.unclosed || []).filter(u => u.i === t), orph = (v.orphan_grat || []).includes(t), ev = (v.events || []).includes(t);
        const w = (v.words && v.words[t]) || '';
        const tag = (txt, col) => `<span style="background:${col}22;border:1px solid ${col};color:${col};border-radius:5px;padding:1px 7px;font-size:10px;font-weight:700;margin:0 4px 4px 0;display:inline-block">${txt}</span>`;
        let tags = '';
        if (refs.length) tags += tag('REFERENCE ×' + refs.length, C.cyan);
        if (grats.length) tags += tag('GRATIFICATION ×' + grats.length, C.green);
        if (uncl.length) tags += tag('UNCLOSED LOOP', C.orange);
        if (orph) tags += tag('ORPHAN', C.orange);
        if (ev) tags += tag('EVENT', C.yellow);
        const eline = e => `${RTGA.mod_label[e.mod]} · ${e.i}s→${e.j}s · strength ${e.s}`;
        return `<div style="font-size:12px;color:${C.text};font-weight:800;margin-bottom:4px">Second ${t} <span style="color:${C.mute};font-weight:400">· ${t}.0s</span></div>
            <div style="margin-bottom:5px">${tags || '<span style="color:' + C.mute + ';font-size:10px">no marker at this second — just a moment on the timeline</span>'}</div>
            ${w ? `<div style="font-size:11px;color:${C.dim};margin-bottom:6px;line-height:1.4">🗣 “${esc(w)}”</div>` : `<div style="font-size:10px;color:${C.mute};margin-bottom:6px">(no speech this second)</div>`}
            <div style="font-size:10px;color:${C.mute};line-height:1.7">visual surprise <b style="color:${C.cyan}">${(v.vsurp[t] || 0).toFixed(3)}</b> · tension <b style="color:${C.purple}">${(v.tension[t] || 0).toFixed(3)}</b> · speech ${v.has_c[t] ? 'yes' : 'no'}</div>
            ${refs.map(e => `<div style="font-size:10px;color:${C.cyan};margin-top:3px">→ opens loop: ${eline(e)}</div>`).join('')}
            ${grats.map(e => `<div style="font-size:10px;color:${C.green};margin-top:3px">← resolves reference at ${e.i}s: ${eline(e)}</div>`).join('')}
            ${uncl.map(u => `<div style="font-size:10px;color:${C.orange};margin-top:3px">⌀ unclosed — best forward score ${u.r}, below the null ceiling (${RTGA.mod_label[u.mod]})</div>`).join('')}
            ${orph ? `<div style="font-size:10px;color:${C.orange};margin-top:3px">◌ orphan gratification — a surprise spike bound to no earlier reference</div>` : ''}`;
    }
    function rtgHeat(v) {
        const G = RTGA.meta.ds_grid, n = v.n_sec, cell = 9, sz = G * cell;
        const grid = m => { const mat = v.mat[m]; let cells = '';
            for (let a = 0; a < G; a++) for (let b = 0; b < G; b++) { const q = mat[a * G + b], xx = b * cell, yy = a * cell;
                let fill; if (q === -128) fill = C.card2; else { const t = q / 127, al = Math.min(0.95, Math.abs(t) * 1.3 + 0.05); fill = t >= 0 ? `rgba(248,113,113,${al})` : `rgba(56,189,248,${al})`; }
                cells += `<rect x="${xx}" y="${yy}" width="${cell}" height="${cell}" fill="${fill}"/>`; }
            const s2b = s => Math.min(G - 1, Math.floor(s / n * G));
            const ev = v.edges.filter(e => e.mod === m).map(e => `<circle cx="${s2b(e.j) * cell + cell / 2}" cy="${s2b(e.i) * cell + cell / 2}" r="2.6" fill="none" stroke="#fff" stroke-width="1.1"/>`).join('');
            return `<div><div style="font-size:10px;color:${RMODC[m]};font-weight:700;margin-bottom:3px">${RTGA.mod_label[m]}</div>
                <svg viewBox="-12 0 ${sz + 14} ${sz + 14}" style="width:100%;max-width:210px">${cells}${ev}
                <text x="-3" y="${sz / 2}" fill="${C.mute}" font-size="8" text-anchor="middle" transform="rotate(-90 -3 ${sz / 2})">reference i →</text>
                <text x="${sz / 2}" y="${sz + 11}" fill="${C.mute}" font-size="8" text-anchor="middle">gratification j →</text></svg></div>`; };
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Dependency matrix A[i,j] — the causal attention map</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">${st.rtgDet === 'pred' ? 'Learned directed <b>PMI</b> = log p(z<sub>j</sub>|context≤i)/p(z<sub>j</sub>) from the CPC critic' : 'Residual affinity (double-centred + gap-detrended)'}, downsampled to ${G}×${G}. Row = reference second i, column = gratification second j. <span style="color:rgba(248,113,113,0.95)">red</span> = ${st.rtgDet === 'pred' ? 'j is predicted by i above the corpus baseline' : 'specific positive binding'} · <span style="color:rgba(56,189,248,0.95)">blue</span> = below expectation · dark = masked. ○ = a kept edge.</div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">${RMODS.map(grid).join('')}</div>`);
    }
    function rtgTension(v) {
        const t = v.tension, n = v.n_sec, W = 820, H = 124, pad = 30, mx = Math.max(0.001, ...t);
        const X = s => pad + (n <= 1 ? 0 : s / (n - 1) * (W - pad - 12)), Y = val => H - 24 - (val / mx) * (H - 40);
        const area = `M ${X(0)} ${Y(0)} ` + t.map((val, i) => `L ${X(i).toFixed(1)} ${Y(val).toFixed(1)}`).join(' ') + ` L ${X(n - 1)} ${Y(0)} Z`;
        const drops = (v.drops || []).map(d => `<line x1="${X(d.t)}" y1="22" x2="${X(d.t)}" y2="${H - 24}" stroke="${C.green}" stroke-width="1" opacity="0.35"/><circle cx="${X(d.t)}" cy="${Y(t[d.t] || 0)}" r="3" fill="${C.green}"><title>gratification at ${d.t}s resolves ${d.amt}</title></circle>`).join('');
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Tension — unresolved reference mass over time</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:6px">Rises when a reference opens a loop, drops (<span style="color:${C.green}">green</span>) when a gratification resolves one. Open loops that never close stay elevated to the end.</div>
            <svg viewBox="0 0 ${W} ${H}" style="width:100%"><path d="${area}" fill="${C.purple}30" stroke="${C.purple}" stroke-width="1.5"/>${drops}
            <line class="rtg-ph" data-x0="${pad}" data-x1="${W - 12}" data-n="${n}" x1="${pad}" y1="14" x2="${pad}" y2="${H - 22}" stroke="#fff" stroke-width="1.5" opacity="0" style="pointer-events:none"/>
            <text x="${pad}" y="${H - 6}" fill="${C.mute}" font-size="9">0s</text><text x="${W - 10}" y="${H - 6}" fill="${C.mute}" font-size="9" text-anchor="end">${n - 1}s</text></svg>`);
    }
    function rtgSurprise(v) {
        const s = v.vsurp, n = v.n_sec, W = 820, H = 110, pad = 30, mx = Math.max(0.001, ...s);
        const X = i => pad + (n <= 1 ? 0 : i / (n - 1) * (W - pad - 12)), Y = val => H - 20 - (val / mx) * (H - 34);
        const line = `M ` + s.map((val, i) => `${X(i).toFixed(1)} ${Y(val).toFixed(1)}`).join(' L ');
        const orph = new Set(v.orphan_grat || []);
        const ev = (v.events || []).map(t => `<circle cx="${X(t)}" cy="${Y(s[t])}" r="3.2" fill="${orph.has(t) ? C.orange : C.yellow}"><title>${orph.has(t) ? 'orphan gratification (no setup)' : 'event boundary'} at ${t}s</title></circle>`).join('');
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Surprise / event boundaries — "where something happened"</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:6px">Per-second visual change (1 − cos of consecutive frames). Spikes = reveals / cuts / transitions. <span style="color:${C.yellow}">●</span> event · <span style="color:${C.orange}">●</span> orphan gratification (a spike bound to no earlier reference).</div>
            <svg viewBox="0 0 ${W} ${H}" style="width:100%"><path d="${line}" fill="none" stroke="${C.cyan}" stroke-width="1.3"/>${ev}
            <line class="rtg-ph" data-x0="${pad}" data-x1="${W - 12}" data-n="${n}" x1="${pad}" y1="12" x2="${pad}" y2="${H - 18}" stroke="#fff" stroke-width="1.5" opacity="0" style="pointer-events:none"/>
            <text x="${pad}" y="${H - 4}" fill="${C.mute}" font-size="9">0s</text><text x="${W - 10}" y="${H - 4}" fill="${C.mute}" font-size="9" text-anchor="end">${n - 1}s</text></svg>`);
    }
    function rtgMathCard() {
        const b = RTGS.meta.baseline, E = RTGS.existence;
        const row = m => `<tr><td style="padding:3px 10px 3px 0;color:${RMODC[m]};font-weight:700">${E[m].label}</td><td style="padding:3px 10px">${b[m]}</td><td style="padding:3px 10px">${E[m].real.toFixed(4)}</td><td style="padding:3px 10px">${E[m].shuf.toFixed(4)}</td><td style="padding:3px 10px;color:${E[m].delta > 0 ? C.green : C.orange}">${sgn(E[m].delta, 4)}</td><td style="padding:3px 10px">${E[m].p < 0.001 ? '<0.001' : E[m].p.toFixed(3)}</td></tr>`;
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:6px">All the math, written out</div>
            <div style="font-family:ui-monospace,monospace;font-size:11px;color:${C.dim};line-height:1.85;background:${C.card2};border-radius:8px;padding:11px 13px;margin-bottom:10px;overflow-x:auto">
              <b style="color:${C.text}">tokens</b>   V<sub>t</sub> = CLIP-image(frame t) · C<sub>t</sub> = CLIP-text(words in second t)  — L2-normalised, shared space<br>
              <b style="color:${C.text}">similarity</b>   S<sub>xy</sub>[i,j] = cos(x<sub>i</sub>, y<sub>j</sub>)   for x,y ∈ {C,V},  j > i+${RTG.meta.min_gap}  (causal)<br>
              <b style="color:${C.text}">baseline</b>   B<sub>xy</sub> = mean cos over cross-video token pairs   →   dep = S − B<br>
              <b style="color:${C.text}">residual</b>   R = S − rowmean<sub>i</sub> − colmean<sub>j</sub> + grandmean   then   R[i,j] −= mean(same-gap cells)<br>
              <b style="color:${C.text}">score</b>   rowpeak = mean<sub>i</sub>( max<sub>j</sub> R[i,j] − mean<sub>j</sub> R[i,j] )   — does each reference have ONE standout gratification<br>
              <b style="color:${C.text}">null</b>   shuffle dst time order, recompute R, ×${RTG.meta.n_shuffles}   →   exists iff real ≫ shuffled<br>
              <b style="color:${C.text}">edge i→j</b>   kept iff R[i,j] > 99.5ᵗʰ-pct of shuffled R (per video, per channel)<br>
              <b style="color:${C.text}">tension(t)</b> = Σ refStrength · 1[loop open at t]   ·   heatmap int8 = round(R / ${RTG.meta.mat_scale} · 127)
            </div>
            <table style="border-collapse:collapse;font-size:11px;color:${C.text}"><thead><tr style="color:${C.mute};text-align:left;border-bottom:1px solid ${C.border}">
              <th style="padding:3px 10px 3px 0">channel</th><th style="padding:3px 10px">baseline B</th><th style="padding:3px 10px">real</th><th style="padding:3px 10px">shuffled null</th><th style="padding:3px 10px">Δ</th><th style="padding:3px 10px">sign-test p</th></tr></thead>
              <tbody>${RMODS.map(row).join('')}</tbody></table>
            <div style="font-size:10px;color:${C.mute};margin-top:6px">Every Δ ≤ 0 → real never beats the null. That's the v0 result: similarity carries no directed binding above chance.</div>`);
    }
    function rtgBars() {
        const E = RTGS.existence, mods = ['cv', 'vv', 'cc', 'vc'];
        const maxv = Math.max(0.001, ...mods.flatMap(m => [E[m].real, E[m].shuf]));
        const rows = mods.map(m => { const e = E[m], wr = Math.max(1, e.real / maxv * 180), ws = Math.max(1, e.shuf / maxv * 180), sig = e.p < 0.001 ? '★★' : e.p < 0.05 ? '★' : '';
            return `<div style="margin-bottom:9px">
                <div style="display:flex;justify-content:space-between;font-size:11px;color:${C.text};margin-bottom:3px"><b style="color:${RMODC[m]}">${e.label}</b><span style="color:${e.delta > 0 && e.p < 0.05 ? C.green : C.mute}">Δ ${sgn(e.delta, 4)} · ${Math.round(e.frac_pos * 100)}% of videos · p ${e.p < 0.001 ? '<0.001' : e.p.toFixed(3)} ${sig}</span></div>
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span style="width:42px;font-size:9px;color:${C.mute};text-align:right">real</span><div style="height:10px;width:${wr}px;background:${RMODC[m]};border-radius:2px"></div><span style="font-size:9px;color:${C.dim}">${e.real.toFixed(4)}</span></div>
                <div style="display:flex;align-items:center;gap:6px"><span style="width:42px;font-size:9px;color:${C.mute};text-align:right">shuffled</span><div style="height:10px;width:${ws}px;background:${C.border2};border-radius:2px"></div><span style="font-size:9px;color:${C.mute}">${e.shuf.toFixed(4)}</span></div></div>`; }).join('');
        return rows;
    }
    function rtgGapChart() {
        const g = RTGS.gap_curve, m = 'cv', gaps = g.gaps, R = g.real[m], Sh = g.shuf[m];
        const W = 360, Hh = 130, pad = 28; const xs = gaps;
        const all = R.concat(Sh).filter(v => v != null); const mn = Math.min(0, ...all), mx = Math.max(...all, 0.01);
        const X = i => pad + i / (xs.length - 1) * (W - pad - 8);
        const Y = val => Hh - pad - (val - mn) / (mx - mn) * (Hh - pad - 8);
        const line = (arr, col, dash) => `<path d="${arr.map((val, i) => (val == null ? '' : (i && arr[i - 1] != null ? 'L' : 'M') + ' ' + X(i).toFixed(1) + ' ' + Y(val).toFixed(1))).filter(Boolean).join(' ')}" fill="none" stroke="${col}" stroke-width="2" ${dash ? 'stroke-dasharray="4 3"' : ''}/>`;
        const zeroY = Y(0);
        return `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;max-width:${W}px;height:auto">
            <line x1="${pad}" y1="${zeroY}" x2="${W - 8}" y2="${zeroY}" stroke="${C.border2}" stroke-dasharray="2 2"/>
            ${line(Sh, C.mute, true)}${line(R, RMODC.cv, false)}
            <text x="${pad}" y="12" fill="${RMODC.cv}" font-size="10" font-weight="700">concept→visual: real (solid) vs shuffled (dashed)</text>
            <text x="${pad}" y="${Hh - 4}" fill="${C.mute}" font-size="9">gap ${xs[0]}s</text><text x="${W - 8}" y="${Hh - 4}" fill="${C.mute}" font-size="9" text-anchor="end">${xs[xs.length - 1]}s</text></svg>`;
    }
    // ---- EMERGENCE view (declared / SigLIP2): full field + clusters, nothing labelled ----
    const tcol = th => th < 0 ? C.card2 : THREAD_COLORS[((th % THREAD_COLORS.length) + THREAD_COLORS.length) % THREAD_COLORS.length];
    function rtgPlayerCard(v) {
        return cardc(`<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
              <div style="width:220px;flex-shrink:0">
                <div id="rtg-yt" data-vid="${esc(v.id)}" data-n="${v.n_sec}" style="width:220px;height:391px;background:#000;border-radius:8px;overflow:hidden"></div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:8px"><input id="rtg-seek" type="range" min="0" max="${v.n_sec - 1}" step="0.1" value="0" style="flex:1;accent-color:${C.purple};cursor:pointer"><span style="font-size:10px;color:${C.dim};font-weight:700;white-space:nowrap">t=<span id="rtg-curt">0.0s</span></span></div>
                <div style="font-size:10px;color:${C.mute};margin-top:4px;line-height:1.4">Drag / click any second to <b>freeze</b> & inspect — the playhead crosses the threads below. Press ▶ to play.</div>
              </div>
              <div style="flex:1;min-width:240px"><div style="font-size:10px;color:${C.mute};text-transform:uppercase;margin-bottom:5px">Moment inspector — at the playhead</div>
                <div id="rtg-cursec" style="background:${C.card2};border-radius:8px;padding:11px 13px;min-height:120px">${rtgSecInfo(0)}</div></div>
            </div>`, 14);
    }
    function rtgStickyPlayer(v) {
        return `<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:12px">
            <div id="rtg-yt" data-vid="${esc(v.id)}" data-n="${v.n_sec}" style="width:210px;height:373px;background:#000;border-radius:8px;overflow:hidden;margin:0 auto"></div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px"><input id="rtg-seek" type="range" min="0" max="${v.n_sec - 1}" step="0.1" value="0" style="flex:1;accent-color:${C.purple};cursor:pointer"><span style="font-size:10px;color:${C.dim};font-weight:700;white-space:nowrap">t=<span id="rtg-curt">0.0s</span></span></div>
            <div style="font-size:9px;color:${C.mute};margin-top:3px;line-height:1.35">Click any point on the charts → it jumps here & plays. Scroll the charts; this stays pinned and the playhead follows.</div>
            <div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin:9px 0 4px">moment at playhead</div>
            <div id="rtg-cursec" style="background:${C.card2};border-radius:8px;padding:9px 11px">${rtgSecInfo(0)}</div>
        </div>`;
    }
    function rtgThreadTimeline(v) {
        const n = v.n_sec, W = 820, pad = 30, iw = W - pad - 10, cell = iw / n, yV = 40, yC = 84, ch = 30;
        let cells = '';
        for (let s = 0; s < n; s++) {
            const x = (pad + s * cell).toFixed(1), w = Math.max(1, cell - 0.3).toFixed(1);
            cells += `<rect data-rtgnode="${s}" style="cursor:pointer" x="${x}" y="${yV}" width="${w}" height="${ch}" fill="${tcol(v.threadV[s])}"><title>${s}s · visual cluster ${v.threadV[s]}</title></rect>`;
            cells += `<rect data-rtgnode="${s}" style="cursor:pointer" x="${x}" y="${yC}" width="${w}" height="${ch}" fill="${tcol(v.threadC[s])}"><title>${s}s · concept cluster ${v.threadC[s]}</title></rect>`;
        }
        const ph = `<line class="rtg-ph" data-x0="${pad + cell / 2}" data-x1="${pad + (n - 1) * cell + cell / 2}" data-n="${n}" x1="${pad}" y1="34" x2="${pad}" y2="${yC + ch + 3}" stroke="#fff" stroke-width="2" opacity="0" style="pointer-events:none"/>`;
        const ax = [0, n >> 2, n >> 1, (3 * n) >> 2, n - 1].map(s => `<text x="${(pad + s * cell + cell / 2).toFixed(0)}" y="${yC + ch + 13}" fill="${C.mute}" font-size="9" text-anchor="middle">${s}s</text>`).join('');
        const legend = Array.from({ length: v.n_threads }, (_, t) => `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:8px"><span style="width:9px;height:9px;border-radius:2px;background:${tcol(t)};display:inline-block"></span><span style="font-size:9px;color:${C.mute}">${t}</span></span>`).join('');
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Emergent threads over time — same colour = same cluster</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5">Every second coloured by which cluster it fell into (k-means in SigLIP2 space — no thresholds, nothing called a reference or gratification). When a colour appears on the <b style="color:${C.dim}">C</b>oncept track and then later on the <b style="color:${C.dim}">V</b>isual track, a spoken idea and its later depiction fell into the same cluster — a loop that <i>emerged</i>. Click a second to inspect & play.</div>
            <svg viewBox="0 0 ${W} ${yC + ch + 20}" style="width:100%">
              <text x="2" y="${yV + ch / 2 + 4}" fill="${C.dim}" font-size="11" font-weight="800">V</text>
              <text x="2" y="${yC + ch / 2 + 4}" fill="${C.dim}" font-size="11" font-weight="800">C</text>
              ${cells}${ph}${ax}</svg>
            <div style="margin-top:6px">${legend}</div>`);
    }
    function rtgRefPayoff(v) {
        const n = v.n_sec, W = 820, pad = 30, iw = W - pad - 10, H = 156, yR = 56, yP = 100, amp = 40;
        const x = s => pad + (n <= 1 ? 0 : s * iw / (n - 1));
        const ref = v.refness || [], pay = v.payoff || [];
        const refA = `M ${x(0)} ${yR} ` + ref.map((r, i) => `L ${x(i).toFixed(1)} ${(yR - r * amp).toFixed(1)}`).join(' ') + ` L ${x(n - 1)} ${yR} Z`;
        const payA = `M ${x(0)} ${yP} ` + pay.map((p, i) => `L ${x(i).toFixed(1)} ${(yP + p * amp).toFixed(1)}`).join(' ') + ` L ${x(n - 1)} ${yP} Z`;
        const arcs = (v.links || []).map(l => { const xi = x(l.i), xj = x(l.j);
            return `<path d="M ${xi} ${yR} C ${xi} ${(yR + yP) / 2} ${xj} ${(yR + yP) / 2} ${xj} ${yP}" fill="none" stroke="${C.purple}" stroke-width="${(0.6 + l.s * 2.4).toFixed(1)}" opacity="${(0.18 + l.s * 0.6).toFixed(2)}"><title>reference @${l.i}s → fulfilled @${l.j}s · strength ${l.s}</title></path>`; }).join('');
        const pk = (arr, base, up, col) => arr.map((r, i) => (r > 0.12 && (i === 0 || r >= arr[i - 1]) && (i === n - 1 || r >= arr[i + 1])) ? `<circle data-rtgnode="${i}" style="cursor:pointer" cx="${x(i).toFixed(1)}" cy="${(base + up * r * amp).toFixed(1)}" r="${(2 + r * 3).toFixed(1)}" fill="${col}" opacity="${(0.35 + r * 0.65).toFixed(2)}"><title>${i}s · ${(r).toFixed(2)}</title></circle>` : '').join('');
        const ph = `<line class="rtg-ph" data-x0="${pad}" data-x1="${x(n - 1)}" data-n="${n}" x1="${pad}" y1="14" x2="${pad}" y2="${H - 10}" stroke="#fff" stroke-width="1.5" opacity="0" style="pointer-events:none"/>`;
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Reference-ness & payoff-ness — continuous fields, markers are the peaks</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5"><b style="color:${C.cyan}">Reference-ness</b> (top) = a spoken idea (in full context) points to a <i>specific</i> later visual that isn't present yet — intrinsic & causal, so it shows even when nothing pays it off. <b style="color:${C.green}">Payoff-ness</b> (bottom) = a later visual fulfils a real earlier reference. The <span style="color:${C.purple}">arcs</span> link each reference peak to where it lands. Nothing is thresholded — a "marker" is just a peak. <i>${(RTGF && RTGF.meta && RTGF.meta.refsource === 'jepa-head') ? 'Now from a probabilistic <b>JEPA predictor head</b> (Var-JEPA-style: sharpness = the model\'s confidence in a specific future) on the frozen <b>' + esc(RTGF.meta.encoder || 'SigLIP') + '</b> encoder, with full context — a real learned expectation, not a proxy. Swap the encoder → Qwen3-VL / Gemini for frontier performance.' : 'SigLIP proxy.'}</i></div>
            <svg viewBox="0 0 ${W} ${H}" style="width:100%">
              <line x1="${pad}" y1="${yR}" x2="${W - 10}" y2="${yR}" stroke="${C.border2}"/><line x1="${pad}" y1="${yP}" x2="${W - 10}" y2="${yP}" stroke="${C.border2}"/>
              <path d="${refA}" fill="${C.cyan}26" stroke="${C.cyan}" stroke-width="1.2"/><path d="${payA}" fill="${C.green}26" stroke="${C.green}" stroke-width="1.2"/>
              ${arcs}${pk(ref, yR, -1, C.cyan)}${pk(pay, yP, 1, C.green)}${ph}
              <text x="${pad}" y="14" fill="${C.cyan}" font-size="10" font-weight="700">reference-ness (anticipation set)</text>
              <text x="${pad}" y="${H - 4}" fill="${C.green}" font-size="10" font-weight="700">payoff-ness (anticipation met)</text></svg>`);
    }
    function rtgFieldHeat(v) {
        const n = v.n_sec, G = Math.min(n, 80), cell = Math.max(3, Math.round(380 / G)), sz = G * cell, fld = v.field;
        const bn = a => [Math.floor(a * n / G), Math.max(Math.floor(a * n / G) + 1, Math.floor((a + 1) * n / G))];
        let cells = '';
        for (let a = 0; a < G; a++) { const [r0, r1] = bn(a); for (let b = 0; b < G; b++) { const [c0, c1] = bn(b);
            let s = 0, c = 0; for (let i = r0; i < r1; i++) for (let j = c0; j < c1; j++) { s += fld[i * n + j]; c++; }
            const t = c ? (s / c) / 127 : 0, al = Math.min(0.95, Math.abs(t) * 1.4 + 0.03);
            cells += `<rect x="${b * cell}" y="${a * cell}" width="${cell}" height="${cell}" fill="${t >= 0 ? `rgba(248,113,113,${al})` : `rgba(56,189,248,${al})`}"/>`; } }
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">The full continuous field ⟨concept<sub>i</sub>, visual<sub>j</sub>⟩</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5">Every moment-pair, nothing thresholded. Row = spoken second i, column = visual second j. <span style="color:rgba(248,113,113,0.95)">Red</span> = the spoken idea matches that later frame above baseline. Bright off-diagonal regions = threads binding across time.${n > 80 ? ' (binned 80×80)' : ''}</div>
            <svg viewBox="0 0 ${sz} ${sz}" style="width:100%;max-width:${sz}px">${cells}</svg>`, 12);
    }
    function rtgTokenMap(v) {
        const S = 300, pad = 14, R = S - 2 * pad;
        const dots = (v.tokens || []).map(t => { const cx = (pad + t.x * R).toFixed(1), cy = (pad + (1 - t.y) * R).toFixed(1), c = tcol(t.th);
            return t.tr === 1
                ? `<rect data-rtgnode="${t.s}" style="cursor:pointer" x="${(cx - 3)}" y="${(cy - 3)}" width="6" height="6" fill="${c}" opacity="0.92"><title>concept ${t.s}s · cluster ${t.th}</title></rect>`
                : `<circle data-rtgnode="${t.s}" style="cursor:pointer" cx="${cx}" cy="${cy}" r="3.6" fill="${c}" opacity="0.8"><title>visual ${t.s}s · cluster ${t.th}</title></circle>`; }).join('');
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">The cluster geometry — moments in SigLIP2 space</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5">Every second's <span style="color:${C.dim}">● visual</span> and <span style="color:${C.dim}">▪ concept</span> token, projected to 2D, coloured by emergent cluster. Moments about the same thing group — a spoken word and the frame that shows it sit together. This is where the threads come from.</div>
            <svg viewBox="0 0 ${S} ${S}" style="width:100%;max-width:${S}px;background:${C.card2};border-radius:8px">${dots}</svg>`, 12);
    }
    function renderRTGEmergence() {
        let h = note(`<b style="color:${C.text}">Emergence, not labelling.</b> No thresholds, nothing stamped "reference" or "gratification". We embed every second — its frame and its spoken words — in SigLIP2's shared space and let k-means find clusters. A <b>thread</b> is just a cluster. A reference→gratification <i>emerges</i> when a thread's colour shows up on the concept track and then later on the visual track. Below: the threads over time, the full field, and the cluster geometry they come from.`, C.cyan);
        if (st.rtgSel != null && RTGF.videos[st.rtgSel]) {
            const v = RTGF.videos[st.rtgSel];
            h += cardc(`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div style="font-size:13px;font-weight:800;color:${C.text}">${esc(v.title)} <span style="font-size:10px;color:${C.mute};font-weight:400">· ${v.n_sec}s · ${v.n_threads} clusters</span></div>
                <div style="display:flex;gap:6px"><a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" style="background:${C.accent}18;border:1px solid ${C.accent};color:${C.accent};border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;text-decoration:none">▶ YouTube</a><span data-rtgclose style="cursor:pointer;border:1px solid ${C.border};color:${C.dim};border-radius:6px;padding:4px 10px;font-size:11px">✕ close</span></div></div>`, 10);
            h += `<div style="display:flex;gap:16px;align-items:flex-start">
                <div style="flex:1;min-width:0">
                    ${rtgThreadTimeline(v)}${rtgRefPayoff(v)}
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">${rtgFieldHeat(v)}${rtgTokenMap(v)}</div>
                </div>
                <div style="width:236px;flex-shrink:0;position:sticky;top:14px">${rtgStickyPlayer(v)}</div>
            </div>`;
        }
        const list = RTGF.videos.map((v, i) => ({ v, i })).filter(o => o.v.n_threads).sort((a, b) => b.v.n_sec - a.v.n_sec);
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:6px">Every video — click to see its emergent threads</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">${list.map(({ v, i }) => {
                const on = st.rtgSel === i, strip = (v.threadV || []).map(th => `<span style="flex:1;background:${tcol(th)}"></span>`).join('');
                return `<div data-rtg="${i}" style="display:flex;align-items:center;gap:8px;padding:4px 7px;border-radius:6px;cursor:pointer;background:${on ? C.card2 : 'transparent'};border:1px solid ${on ? C.purple : 'transparent'}">
                    <div style="flex:1;min-width:0"><div style="font-size:11px;color:${C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(v.title)}</div>
                      <div style="display:flex;height:7px;border-radius:2px;overflow:hidden;margin-top:3px;background:${C.border}">${strip}</div></div></div>`; }).join('')}</div>`);
        return h;
    }
    function renderRTGExistPred() {
        const E = RTGP.existence_pred, exists = !!RTGP.exists;
        const maxa = Math.max(0.001, ...RMODS.flatMap(m => [E[m].learned_acc, E[m].similarity_acc, E[m].shuffled_acc]));
        const bar = (lbl, val, col) => `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span style="width:62px;font-size:9px;color:${C.mute};text-align:right">${lbl}</span><div style="height:10px;width:${Math.max(1, val / maxa * 165)}px;background:${col};border-radius:2px"></div><span style="font-size:9px;color:${C.dim}">${(val * 100).toFixed(1)}%</span></div>`;
        const rows = RMODS.map(m => { const e = E[m], win = e.learned_acc > e.shuffled_acc + 0.01 && e.learned_acc > e.similarity_acc + 0.01;
            return `<div style="margin-bottom:11px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px"><b style="color:${RMODC[m]}">${e.label}</b><span style="color:${win ? C.green : C.mute}">MI ${e.mi_nats.toFixed(3)} nats · ${win ? 'beats baselines' : 'no edge over baselines'}</span></div>
                ${bar('learned', e.learned_acc, RMODC[m])}${bar('similarity', e.similarity_acc, C.dim)}${bar('shuffled', e.shuffled_acc, C.border2)}${bar('chance', e.chance_acc, C.border)}</div>`; }).join('');
        let h = cardc(`<div style="font-size:13px;font-weight:800;color:${C.text};margin-bottom:2px">Step 1 (v1 predictive) — does a directed channel exist, held out?</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:10px;line-height:1.5">We train a small <b>CPC critic</b> (causal GRU context + InfoNCE with cross-video negatives) so its score f(c<sub>i</sub>,z<sub>j</sub>) ≈ log p(z<sub>j</sub>|context≤i)/p(z<sub>j</sub>) — the directed <b>PMI</b>. Trained on ${RTGP.meta.n_train} videos, tested on ${RTGP.meta.n_heldout} <b>held-out</b> ones it never saw. A channel exists if the learned critic predicts the true future moment (top-1 over ${RTGP.meta.neg} negatives) better than time-shuffled context, the v0 similarity score, and chance.</div>
            <div style="background:${exists ? C.green + '14' : C.orange + '14'};border-left:3px solid ${exists ? C.green : C.orange};border-radius:0 8px 8px 0;padding:9px 12px;margin-bottom:10px;font-size:12px;color:${C.text};font-weight:600">${exists ? '✓ ' : '⚠ '}${esc(RTGP.verdict)}</div>
            ${RTGP.diagnosis ? `<div style="font-size:11px;color:${C.dim};line-height:1.55;margin-bottom:12px;background:${C.card2};border-radius:8px;padding:10px 12px"><b style="color:${C.text}">Why:</b> ${esc(RTGP.diagnosis)}</div>` : ''}
            <div style="font-size:10px;color:${C.mute};text-transform:uppercase;margin-bottom:6px">Held-out top-1 prediction accuracy · learned vs baselines (chance ${(E.cv.chance_acc * 100).toFixed(2)}%)</div>${rows}`, 16);
        return h;
    }
    function rtgMathCardPred() {
        const M = RTGP.meta;
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:6px">All the math — v1 predictive detector</div>
            <div style="font-family:ui-monospace,monospace;font-size:11px;color:${C.dim};line-height:1.85;background:${C.card2};border-radius:8px;padding:11px 13px;overflow-x:auto">
              <b style="color:${C.text}">goal</b>   D(i→j) = I( z<sub>i</sub> ; z<sub>j</sub> | c<sub>&lt;i</sub> )  — directed conditional mutual info (NOT symmetric similarity)<br>
              <b style="color:${C.text}">context</b>   c<sub>i</sub> = causal GRU over the source channel, seconds 0..i   (hidden ${M.hidden})<br>
              <b style="color:${C.text}">critic</b>   f(c<sub>i</sub>, z<sub>j</sub>, k) = pred(c<sub>i</sub>, k) · z<sub>j</sub>,   k = j − i   (lag ≤ ${M.max_lag}s)<br>
              <b style="color:${C.text}">train</b>   InfoNCE:  −log[ e^{f(pos)/τ} / Σ e^{f(neg)/τ} ],   ${M.neg} cross-video negatives, τ=${M.temp}<br>
              <b style="color:${C.text}">⇒ optimum</b>   f* = log p(z<sub>j</sub>|c<sub>i</sub>) / p(z<sub>j</sub>) = directed <b>PMI</b>   (the heatmap value)<br>
              <b style="color:${C.text}">surprise</b>   S(j) = −PMI(z<sub>j</sub> | c<sub>j−1</sub>, lag 1)   ·   tension(t) = Σ open-loop PMI<br>
              <b style="color:${C.text}">existence</b>   held-out top-1 retrieval of the true future vs shuffled-context / similarity / chance<br>
              <b style="color:${C.text}">data</b>   visual = ${esc(M.visual_encoder || 'clip-vit-base-patch16')} · concept = CLIP-text · PCA-${M.pca_d} · ${M.n_train} train / ${M.n_heldout} held-out · ${M.epochs} epochs · lag ≤${M.max_lag}s
            </div>
            <div style="font-size:10px;color:${C.mute};margin-top:6px">v1 = correct model, small data (${RTGP.meta.n} videos, 1fps). v2 = scrape 10⁴–10⁶ Shorts + V-JEPA/CLAP encoders + finer resolution + fine-tuned trunk.</div>`);
    }
    function renderRTG() {
        if (!RTG && !RTGP && !RTGD) return cardc(`<div style="padding:30px;text-align:center;color:${C.dim}">Building RTG dependency map… <div style="font-size:11px;color:${C.mute};margin-top:6px">Run <code>principles/rtg_embed.py</code>, <code>rtg_build.py</code>, then <code>rtg_detector.py</code>.</div></div>`);
        let det = st.rtgDet;
        if (det === 'pred' && !RTGP) det = 'sim';
        if (det === 'declared' && !RTGD && !RTGF) det = 'sim';
        if (det === 'sim' && !RTG) det = (RTGF || RTGD) ? 'declared' : 'pred';
        RTGA = det === 'pred' ? RTGP : det === 'declared' ? RTGD : RTG;
        RTGS = det === 'declared' ? RTGD : RTG;          // sim-schema dataset for the shuffle panels
        const isP = det === 'pred';
        let h = '';
        // ---- detector toggle ----
        const detPill = (id, lab, on, avail) => `<span ${avail ? `data-rtgdet="${id}"` : ''} style="cursor:${avail ? 'pointer' : 'default'};border:1px solid ${on ? C.accent : C.border};background:${on ? C.accent + '1e' : 'transparent'};color:${on ? C.accent : avail ? C.dim : C.faint};border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700">${lab}</span>`;
        h += `<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap"><span style="font-size:10px;color:${C.mute};text-transform:uppercase">view</span>${detPill('declared', '⛓ emergence (SigLIP2)', det === 'declared', !!(RTGF || RTGD))}${detPill('sim', 'v0 · CLIP labels', det === 'sim', !!RTG)}${detPill('pred', 'v1 · predictive (CPC)', det === 'pred', !!RTGP)}</div>`;
        // ---- EMERGENCE view (declared) — full field + clusters, nothing labelled ----
        if (det === 'declared' && RTGF) { RTGA = RTGF; return h + renderRTGEmergence(); }
        // ---- existence (branch) ----
        if (isP) { h += renderRTGExistPred(); }
        else {
        const exists = !!RTGS.exists, isD = det === 'declared';
        h += cardc(`<div style="font-size:13px;font-weight:800;color:${C.text};margin-bottom:2px">Step 1 — does a reference→gratification structure even exist?</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:10px;line-height:1.5">${isD ? 'The <b>declared route</b>: a spoken word (concept) and the later frame that depicts it, embedded with <b>SigLIP2</b>. M(i,j) = ⟨text<sub>i</sub>, visual<sub>j</sub>⟩, double-centred for specificity, vs a <b>time-shuffled</b> null. The strongest edges should be real naming loops (slingshot→slingshot).' : 'Before reading any single arc, we test the whole phenomenon. For each video we build the directed dependency between its second-tokens (double-centred + gap-detrended), then compare it to a <b>time-shuffled</b> copy of the same video. If real beats the shuffled null, a directed loop is real — not topic-continuity or noise.'}</div>
            <div style="background:${exists ? C.green + '14' : C.orange + '14'};border-left:3px solid ${exists ? C.green : C.orange};border-radius:0 8px 8px 0;padding:9px 12px;margin-bottom:10px;font-size:12px;color:${C.text};font-weight:600">${exists ? '✓ ' : '⚠ '}${esc(RTGS.verdict)}</div>
            ${RTGS.diagnosis ? `<div style="font-size:11px;color:${C.dim};line-height:1.55;margin-bottom:12px;background:${C.card2};border-radius:8px;padding:10px 12px"><b style="color:${C.text}">Why:</b> ${esc(RTGS.diagnosis)}</div>` : ''}
            <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:16px">
              <div><div style="font-size:10px;color:${C.mute};text-transform:uppercase;margin-bottom:6px">${isD ? 'Declared (concept→visual) score · real vs shuffled' : 'Directed-binding score · real vs time-shuffled null'}</div>${rtgBars()}</div>
              <div><div style="font-size:10px;color:${C.mute};text-transform:uppercase;margin-bottom:6px">${isD ? 'SigLIP2 affinity vs gap' : 'Raw similarity vs gap (continuity)'}</div>${rtgGapChart()}</div>
            </div>`, 16);
        if (isD) h += note(`<b style="color:${C.text}">Declared route, the honest read.</b> SigLIP2 catches "a word labels a later visible object" (slingshot→slingshot, boxes→boxes) — the top edges per video are semantically right, a real step up from the v0 CLIP detector. What it can't catch is "a statement sets up a future EVENT" (the premise→payoff loops that drive retention). That needs a predictive / state-linking model — <b>VL-JEPA</b> — which drops into this same pipeline when access clears. Open a video and read its top declared edges.`, C.cyan);
        else if (!exists) h += note(`<b style="color:${C.text}">The instrument, not the phenomenon.</b> CLIP cosine <i>similarity</i> can't expose directed binding — it's symmetric and continuity-dominated. A real "promise→proof" is a <b>predictive</b> relation. The arcs below are <b>unvalidated candidate</b> similarity structure. (Try the <b>declared (SigLIP2)</b> detector — it recovers the real naming loops.)`, C.orange);
        }
        // ---- variable definitions ----
        const defs = [['Reference (▲)', 'a moment that opens a directed dependency toward a specific later moment — an open loop / setup'],
            ['Gratification (○)', 'a later moment that resolves an earlier reference — the payoff that collapses the loop'],
            ['Edge / arc', 'one directed dependency i→j (j at least ' + RTGA.meta.min_gap + 's later) that beats the ' + (isP ? 'null PMI ceiling' : 'time-shuffled null')],
            ['Visual / Concept track', 'the two channels: V = CLIP image of each second, C = CLIP text of that second\'s words'],
            ['concept→visual (C→V)', 'a spoken/written promise that is paid off visually later — the key structure for this content'],
            ['visual→visual (V→V)', 'a shown setup (e.g. a half-built rig) paid off by a later shot'],
            ['Strength', isP ? 'learned directed PMI = log p(z_j | context≤i) / p(z_j) from the CPC critic (nats)' : 'cosine dependency in CLIP space, minus the cross-video baseline (generic similarity floor)'],
            isP ? ['Held-out test', 'the critic is scored on videos it never trained on — guards against memorising structure'] : ['Time-shuffled null', 'the same video with its moments reordered — destroys real loops, keeps the topic; what we must beat'],
            ['Dependency matrix A[i,j]', 'the full causal attention map: row i = reference second, col j = gratification second, value = ' + (isP ? 'directed PMI (learned)' : 'specific affinity')],
            ['Surprise', isP ? 'S(j) = −PMI(z_j | context, lag 1) — how unpredictable j is given the learned model' : 'per-second visual change (1 − cos of consecutive frames) — marks reveals, cuts, transitions'],
            ['Event boundary', 'a local spike in surprise above mean + ' + RTGA.meta.surprise_k + '·sd — "where something happened"'],
            ['Unclosed reference (dashed ▲)', 'a moment that points forward but whose best match never beats the null — an open loop with no payoff'],
            ['Orphan gratification (dashed ○)', 'an event/reveal bound to no earlier reference — a payoff that came out of nowhere'],
            ['Tension', 'total unresolved reference mass at each second — rises at references, drops at gratifications']];
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:6px">What every variable means</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;font-size:11px;color:${C.dim};line-height:1.5">${defs.map(([t, d]) => `<div><b style="color:${C.text}">${t}</b> — ${d}</div>`).join('')}</div>`);
        // ---- all the math ----
        h += isP ? rtgMathCardPred() : rtgMathCard();
        // ---- per-video explorer ----
        if (st.rtgSel != null && RTGA.videos[st.rtgSel]) {
            const v = RTGA.videos[st.rtgSel], cc = v.counts || {};
            // synced player + scrubber + moment inspector
            h += cardc(`<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
                  <div style="width:220px;flex-shrink:0">
                    <div id="rtg-yt" data-vid="${esc(v.id)}" data-n="${v.n_sec}" style="width:220px;height:391px;background:#000;border-radius:8px;overflow:hidden"></div>
                    <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
                      <input id="rtg-seek" type="range" min="0" max="${v.n_sec - 1}" step="0.1" value="0" style="flex:1;accent-color:${C.purple};cursor:pointer">
                      <span style="font-size:10px;color:${C.dim};font-weight:700;white-space:nowrap">t=<span id="rtg-curt">0.0s</span></span></div>
                    <div style="font-size:10px;color:${C.mute};margin-top:4px;line-height:1.4">Click any ▲ / ○ (or drag) to <b>freeze</b> on that moment & inspect — the white playhead crosses every channel below. Press ▶ on the video to play.</div>
                  </div>
                  <div style="flex:1;min-width:240px"><div style="font-size:10px;color:${C.mute};text-transform:uppercase;margin-bottom:5px">Moment inspector — everything encoded at the playhead</div>
                    <div id="rtg-cursec" style="background:${C.card2};border-radius:8px;padding:11px 13px;min-height:120px">${rtgSecInfo(0)}</div></div>
                </div>`, 14);
            const mtog = ['cv', 'vv', 'cc', 'vc'].map(m => `<span data-rtgmod="${m}" style="cursor:pointer;border:1px solid ${st.rtgMods[m] ? RMODC[m] : C.border};color:${st.rtgMods[m] ? RMODC[m] : C.faint};background:${st.rtgMods[m] ? RMODC[m] + '18' : 'transparent'};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">${RTGA.mod_label[m]}</span>`).join('');
            h += cardc(`<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px">
                  <div><div style="font-size:13px;font-weight:800;color:${C.text}">${esc(v.title)}</div>
                    <div style="font-size:10px;color:${C.mute};margin-top:2px">${v.n_sec}s · ${cc.edges || 0} edges · ${cc.refs || 0} references · ${cc.grats || 0} gratifications · ${cc.unclosed || 0} unclosed · ${cc.orphan_grat || 0} orphan${v.published ? ' · ' + esc(v.published) : ''}</div></div>
                  <div style="display:flex;gap:6px;flex-shrink:0"><a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" style="background:${C.accent}18;border:1px solid ${C.accent};color:${C.accent};border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;text-decoration:none">▶ YouTube</a><span data-rtgclose style="cursor:pointer;border:1px solid ${C.border};color:${C.dim};border-radius:6px;padding:4px 10px;font-size:11px">✕ close</span></div></div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center"><span style="font-size:10px;color:${C.mute};text-transform:uppercase">show</span>${mtog}<span style="margin-left:auto;font-size:10px;color:${C.mute}">▲ reference · ○ gratification · <span style="color:${C.orange}">dashed</span> = orphan/open · arc = directed dependency</span></div>
                ${rtgArc(v)}`, 14);
            h += rtgHeat(v);
            h += rtgTension(v);
            h += rtgSurprise(v);
        }
        const list = RTGA.videos.map((v, i) => ({ v, i })).filter(o => (o.v.counts || {}).edges).sort((a, b) => (b.v.counts.edges) - (a.v.counts.edges));
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Every video — click to see its ${isP ? 'predicted' : 'candidate'} reference→gratification map</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">${RTGA.meta.n} videos · sorted by number of detected loops. Bar coloured by modality mix.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">${list.map(({ v, i }) => {
                const cb = v.counts.by_mod || {}, tot = v.counts.edges || 1, on = st.rtgSel === i;
                const seg = ['cv', 'vv', 'cc', 'vc'].map(m => cb[m] ? `<div style="height:8px;width:${cb[m] / tot * 100}%;background:${RMODC[m]}"></div>` : '').join('');
                return `<div data-rtg="${i}" style="display:flex;align-items:center;gap:8px;padding:4px 7px;border-radius:6px;cursor:pointer;background:${on ? C.card2 : 'transparent'};border:1px solid ${on ? C.purple : 'transparent'}">
                    <div style="flex:1;min-width:0"><div style="font-size:11px;color:${C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(v.title)}</div>
                      <div style="display:flex;height:8px;border-radius:2px;overflow:hidden;margin-top:3px;background:${C.border}">${seg}</div></div>
                    <div style="font-size:11px;color:${C.dim};font-weight:700;flex-shrink:0">${v.counts.edges}</div></div>`; }).join('')}</div>`);
        return h;
    }
    function renderPrinciples() {
        const pr = st.principle || 'novelty';
        const ppill = (id, lab, on) => `<span data-principle="${id}" style="background:${on ? C.purple + '22' : 'transparent'};border:1px solid ${on ? C.purple : C.border};color:${on ? C.purple : C.dim};border-radius:8px;padding:5px 12px;font-size:12px;font-weight:${on ? 800 : 600};cursor:pointer">${lab}</span>`;
        let h = h2c('Principles — deliberately quantifying what makes a hook work', pr === 'rtg'
            ? 'RTG = Reference → Tension → Gratification. The video as two channels (visual + conceptual), second by second, with the directed dependencies that bind an early moment (a reference / open loop) to a later one that resolves it (a gratification).'
            : 'Hook = the first 5 seconds of every confirmed video. Embedded several independent ways at two resolutions (whole hook + per second). Objects via detection, concepts via keyphrase math — see the 📋 Ledger for every definition.');
        h += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${ppill('novelty', '✦ Novelty', pr === 'novelty')}${ppill('rtg', '⛓ RTG', pr === 'rtg')}<span style="border:1px dashed ${C.border2};color:${C.faint};border-radius:8px;padding:5px 12px;font-size:12px">coherence · soon</span></div>`;
        if (pr === 'rtg') return h + renderRTG();
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
        try { rtgAfterRender(); } catch (e) { }
    }

    function onClick(e) {
        const ps = e.target.closest('[data-pred-scale]'); if (ps) { st.predScale = ps.getAttribute('data-pred-scale'); render(); return; }
        const pfeat = e.target.closest('[data-predfeat]'); if (pfeat) { const f = pfeat.getAttribute('data-predfeat'); st.predFeats = (st.predFeats || ['keep', 'retention', 'log_dur']); st.predFeats = st.predFeats.includes(f) ? st.predFeats.filter(x => x !== f) : st.predFeats.concat([f]); render(); return; }
        const pset = e.target.closest('[data-predset]'); if (pset) { st.predFeats = pset.getAttribute('data-predset').split('+'); render(); return; }
        const pint = e.target.closest('[data-predint]'); if (pint) { const k = pint.getAttribute('data-predint'); st.predInts = (st.predInts || []); st.predInts = st.predInts.includes(k) ? st.predInts.filter(x => x !== k) : st.predInts.concat([k]); render(); return; }
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
        const pp = e.target.closest('[data-principle]'); if (pp) { st.principle = pp.getAttribute('data-principle'); render(); return; }
        const rg = e.target.closest('[data-rtg]'); if (rg) { st.rtgSel = +rg.getAttribute('data-rtg'); render(); return; }
        if (e.target.closest('[data-rtgclose]')) { st.rtgSel = null; render(); return; }
        const rm = e.target.closest('[data-rtgmod]'); if (rm) { const k = rm.getAttribute('data-rtgmod'); st.rtgMods[k] = st.rtgMods[k] ? 0 : 1; render(); return; }
        const rnode = e.target.closest('[data-rtgnode]'); if (rnode) { rtgSeek(+rnode.getAttribute('data-rtgnode')); return; }
        const rd = e.target.closest('[data-rtgdet]'); if (rd) { st.rtgDet = rd.getAttribute('data-rtgdet'); render(); return; }
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
        if (e.target.id === 'rtg-seek') { rtgSeek(+e.target.value); return; }
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
            const loadJSON = async (url) => { const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=33'); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(); if (/^\s*</.test(t)) throw new Error('got HTML (deploy in progress)'); return JSON.parse(t); };
            for (let tries = 1; !DATA; tries++) {
                try {
                    DATA = await loadJSON(base + 'retention_table.json');
                    S = await loadJSON(base + 'retention_study.json').catch(() => null);
                    N = await loadJSON(base + 'principles/novelty.json').catch(() => null);
                    CR = await loadJSON(base + 'principles/correlations.json').catch(() => null);
                    INT = await loadJSON(base + 'principles/interactions.json').catch(() => null);
                    CF = await loadJSON(base + 'principles/confounds.json').catch(() => null);
                    RTG = await loadJSON(base + 'principles/rtg.json').catch(() => null);
                    RTGP = await loadJSON(base + 'principles/rtg_pred.json').catch(() => null);
                    RTGD = await loadJSON(base + 'principles/rtg_declared.json').catch(() => null);
                    RTGF = await loadJSON(base + 'principles/rtg_field.json').catch(() => null);
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
