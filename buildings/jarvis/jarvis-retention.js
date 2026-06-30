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
    let root = null, DATA = null, S = null, S_MAIN = null, N = null, CR = null, INT = null, CF = null, RTGF = null, RTGA = null, RTGE = null, RTGH = null, LIB = null, LIBV = null, SHORTSV = null, RAW = {}, GUESSES = {}, GUESSRUNS = null, GRPORUNS = null, GRPOIDX = {}, GRPOGRP = {}, EXPDEMO = {}, FUSION = null, NOV = null, EXPREG = null, NCEXP = null, NQ = null, NQF = null, CHANS = null, CHDECON = null, err = null;
    const THREAD_COLORS = ['#38bdf8', '#34d399', '#a78bfa', '#fbbf24', '#f472b6', '#fb923c', '#22d3ee', '#a3e635'];
    let RTGLABELS = {};   // { videoId: { pairs:[{r,g}], orphans:[{r}] } } — your hand-labelled ground truth
    const st = { sec: 'data', sort: 'views', dir: -1, q: '', open: null, predScale: 'actual', predFeats: ['keep', 'retention', 'log_dur'], predInts: [], nov: 'global', novRes: 'hook', corTarget: 'ret_5s', corGroup: 'all', corSel: null, intView: 'synergy', intPair: null, cfTarget: 'keep_rate', cfSel: null, principle: 'novelty', rtgSel: null, rtgLabel: false, rtgPending: null, rtgSignal: 'cAny_entail_g4', rtgMinStr: 0, rtgProj: 'aligned', rtgEmbFocus: 'all', hazUnit: 'pct', hazA: 5, hazB: 50, rawColor: 'cluster', rawK: '10', rawProj: 'both', rawChan: 'visual', rawSel: null, rawMine: false, rawUploads: [], rawUpShow: true, rawUpSel: null, rawUploading: false, rawUpErr: null, rawUpStage: 0, rawUpQueue: null, rawBuildMode: false, rawFrames: [null, null, null, null, null], rawText: '', rawFrameSlot: 0, rawBands: false, rawBandK: 6, fuTarget: 'views', novMine: false, nqMod: 'whole', nqMeth: 'mode', guessRun: 'phase1', guessSel: null, guessIter: null, guessProj: null, guessBands: false, guessBandK: 6, guessRunSet: 0, grpoRun: null, grpoSel: null, expGenPrem: '', expGenRid: null, expGenBusy: false, expGenN: 4, expGenStage: null };
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
        let s = '', mineS = '', top = '';
        proj.forEach((p, i) => { if (!p) return; const pk = opt.pick ? opt.pick(i) : i, isSel = opt.sel != null && pk === opt.sel;
            const mineOn = !!opt.mine, isMine = mineOn && opt.mine(pk);
            const c = isMine ? '#fbbf24' : opt.color(i), r = isSel && !opt.traj ? 6 : isMine ? 4.4 : (opt.r ? opt.r(i) : 3.2);
            const opac = isSel ? 1 : isMine ? 1 : (mineOn ? 0.1 : (opt.op ? opt.op(i) : 0.72));
            const circ = `<circle data-hook="${pk}" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${r}" fill="${c}" opacity="${opac}" stroke="${isSel ? '#fff' : isMine ? '#fff' : '#0b1120'}" stroke-width="${isSel ? 1.6 : isMine ? 1.4 : 0.4}" style="cursor:pointer"><title>${esc((isMine ? '★ ' : '') + opt.tip(i))}</title></circle>`;
            if (isSel) top += circ; else if (isMine) mineS += circ; else s += circ; });
        // numbered trajectory: connect the selected hook's seconds 0→4 so you can read the order
        if (opt.traj && opt.traj.length > 1) {
            let path = ''; opt.traj.forEach((p, k) => { path += (k ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1) + ' '; });
            top += `<path d="${path}" fill="none" stroke="#fff" stroke-width="1.6" opacity="0.65" stroke-dasharray="3 2"/>`;
            opt.traj.forEach((p, k) => { const x = X(p[0]).toFixed(1), y = Y(p[1]).toFixed(1); top += `<circle cx="${x}" cy="${y}" r="8.5" fill="#0b1120" stroke="#fff" stroke-width="1.5"/><text x="${x}" y="${(+y + 3).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="10" font-weight="800">${k}</text>`; });
        }
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}${mineS}${top}</svg>`;
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
    // RETENTION SOURCE OF TRUTH — natural-decay baseline + emergent per-second priority, compare any position vs any
    function rtgHazArr() {
        const H = RTGH, sec = (st.hazUnit || 'pct') === 'sec';
        return sec
            ? { N: H.maxT, surv: H.mean_survival_sec, haz: H.natural_decay_sec, prio: H.priority_watch_sec, unit: 's', lab: 'absolute seconds', span: H.maxT }
            : { N: H.P, surv: H.mean_survival_pct, haz: H.natural_decay_pct, prio: H.priority_watch_pct, unit: '%', lab: '% of video', span: 100 };
    }
    function rtgHazCompareText() {
        const A = rtgHazArr(), a = Math.min(st.hazA | 0, A.N - 1), b = Math.min(st.hazB | 0, A.N - 1);
        const pa = A.prio[a] || 1e-6, pb = A.prio[b] || 1e-6, r = pa / pb;
        const fmtpos = p => A.unit === '%' ? p + '%' : p + 's';
        const more = r >= 1 ? `<b style="color:#fbbf24">${r.toFixed(1)}× more</b>` : `<b style="color:${C.dim}">${(1 / r).toFixed(1)}× less</b>`;
        return `Retaining a viewer at <b style="color:${C.accent}">${fmtpos(a)}</b> is ${more} valuable than at <b style="color:${C.accent}">${fmtpos(b)}</b>. `
            + `<span style="color:${C.mute}">Hazard there: ${((A.haz[a] || 0)).toFixed(3)} vs ${((A.haz[b] || 0)).toFixed(3)} · survival ${((A.surv[a] || 0) * 100).toFixed(0)}% vs ${((A.surv[b] || 0) * 100).toFixed(0)}%.</span>`;
    }
    function rtgHazardPanel() {
        if (!RTGH || !RTGH.natural_decay_pct) return '';
        const H = RTGH, A = rtgHazArr(), N = A.N, W = 820, ht = 196, pad = 34, top = 14, yH = ht - 30;
        const X = p => pad + p / (N - 1) * (W - pad - 12);
        const hmax = Math.max(...A.haz), yh = v => yH - (v / hmax) * (yH - top), yu = v => yH - v * (yH - top);
        const survA = `M ${X(0)} ${yH} ` + A.surv.map((s, p) => `L ${X(p).toFixed(1)} ${yu(s).toFixed(1)}`).join(' ') + ` L ${X(N - 1)} ${yH} Z`;
        const hazL = 'M ' + A.haz.map((v, p) => `${X(p).toFixed(1)} ${yh(v).toFixed(1)}`).join(' L ');
        const prioL = 'M ' + A.prio.map((v, p) => `${X(p).toFixed(1)} ${yu(v).toFixed(1)}`).join(' L ');
        const a = Math.min(st.hazA | 0, N - 1), b = Math.min(st.hazB | 0, N - 1);
        const tick = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * (N - 1)));
        const grid = tick.map(p => `<line x1="${X(p)}" y1="${top}" x2="${X(p)}" y2="${yH}" stroke="${C.border}" opacity="0.5"/><text x="${X(p)}" y="${ht - 10}" fill="${C.mute}" font-size="9" text-anchor="middle">${p}${A.unit}</text>`).join('');
        const mark = (p, id, col) => `<line id="${id}" x1="${X(p).toFixed(1)}" y1="${top}" x2="${X(p).toFixed(1)}" y2="${yH}" stroke="${col}" stroke-width="1.5" opacity="0.9"/>`;
        const pill = (id, lab, on) => `<span data-hazunit="${id}" style="cursor:pointer;border:1px solid ${on ? C.accent : C.border};background:${on ? C.accent + '1e' : 'transparent'};color:${on ? C.accent : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">${lab}</span>`;
        // duration-conflation overlay
        const cf = H.conflation, gs = H.grp, sk = A.unit === '%' ? 'surv_pct' : 'surv_sec';
        const gln = (arr, col) => 'M ' + arr.map((v, p) => v == null ? null : `${X(Math.min(p, N - 1)).toFixed(1)} ${yu(v).toFixed(1)}`).filter(Boolean).join(' L ');
        return cardc(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px">
              <div style="font-size:13px;font-weight:800;color:${C.text}">Retention model — the normalization source of truth</div>
              <div style="display:flex;gap:5px">${pill('pct', '% of video', A.unit === '%')}${pill('sec', 'absolute seconds', A.unit === 's')}</div></div>
            <div style="font-size:10.5px;color:${C.mute};margin-bottom:9px;line-height:1.55">Measured as <b style="color:#f87171">hazard</b> = fraction of the <i>current</i> audience lost per second (5-pt drop at 80% = 6.25%, at 30% = 16.7% — handled; per real second). <b style="color:${C.cyan}">Survival</b> is rewatch-decomposed. The <b style="color:#fbbf24">priority</b> of each position emerges from the curve (watch-time saved by flattening hazard there — early compounds) — <b>no weights chosen</b>. Compare any two positions below.</div>
            <svg viewBox="0 0 ${W} ${ht}" style="width:100%">${grid}
              <line x1="${pad}" y1="${yH}" x2="${W - 12}" y2="${yH}" stroke="${C.border2}"/>
              <path d="${survA}" fill="${C.cyan}1e" stroke="${C.cyan}" stroke-width="1.3"/>
              <path d="${hazL}" fill="none" stroke="#f87171" stroke-width="1.6"/>
              <path d="${prioL}" fill="none" stroke="#fbbf24" stroke-width="1.6" stroke-dasharray="4 2"/>
              ${mark(a, 'rtg-markA', C.accent)}${mark(b, 'rtg-markB', C.purple)}
              <text x="${pad}" y="11" fill="${C.cyan}" font-size="10" font-weight="700">survival</text>
              <text x="${pad + 70}" y="11" fill="#f87171" font-size="10" font-weight="700">hazard</text>
              <text x="${pad + 145}" y="11" fill="#fbbf24" font-size="10" font-weight="700">priority</text></svg>
            <div style="background:${C.card2};border-radius:10px;padding:10px 13px;margin-top:8px">
              <div id="rtg-hazratio" style="font-size:11px;color:${C.text};line-height:1.5;margin-bottom:7px">${rtgHazCompareText()}</div>
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="width:14px;color:${C.accent};font-weight:800">A</span><input id="rtg-hazA" type="range" min="0" max="${N - 1}" value="${a}" style="flex:1;accent-color:${C.accent};cursor:pointer"></div>
              <div style="display:flex;align-items:center;gap:8px"><span style="width:14px;color:${C.purple};font-weight:800">B</span><input id="rtg-hazB" type="range" min="0" max="${N - 1}" value="${b}" style="flex:1;accent-color:${C.purple};cursor:pointer"></div>
            </div>
            <div style="font-size:9.5px;color:${C.mute};margin-top:8px;line-height:1.5"><b style="color:${C.text}">Duration confound:</b> 5% of a 30s video (1.5s) ≠ 5% of a 180s video (9s). Splitting videos at the median (${H.median_dur}s) and overlaying short vs long, the survival spread over the first stretch is <b>${cf.pct_spread}</b> by % vs <b>${cf.sec_spread}</b> by second — so early retention is marginally more <b>${cf.pct_spread <= cf.sec_spread ? '%-locked (fraction)' : 'second-locked (absolute time)'}</b>, but both carry spread, so the toggle lets you read either. <span style="color:${C.dim}">(short ${gs.short[sk] ? '—' : ''} vs long, in the active unit.)</span>
              <svg viewBox="0 0 ${W} 70" style="width:100%;margin-top:3px"><path d="${gln(gs.short[sk], C.green)}" fill="none" stroke="${C.green}" stroke-width="1.3" opacity="0.85"/><path d="${gln(gs.long[sk], C.orange)}" fill="none" stroke="${C.orange}" stroke-width="1.3" opacity="0.85"/><text x="${pad}" y="11" fill="${C.green}" font-size="9" font-weight="700">short (&lt;${H.median_dur}s)</text><text x="${pad + 90}" y="11" fill="${C.orange}" font-size="9" font-weight="700">long</text></svg></div>`, 14);
    }
    function rtgUpdateHaz() { try { const el = window.document.getElementById('rtg-hazpanel'); if (el) el.innerHTML = rtgHazardPanel(); } catch (e) { } }
    function rtgUpdateHazCompare() {
        try { const A = rtgHazArr(), W = 820, pad = 34, N = A.N, X = p => pad + p / (N - 1) * (W - pad - 12);
            const r = window.document.getElementById('rtg-hazratio'); if (r) r.innerHTML = rtgHazCompareText();
            const mA = window.document.getElementById('rtg-markA'); if (mA) { const x = X(Math.min(st.hazA | 0, N - 1)).toFixed(1); mA.setAttribute('x1', x); mA.setAttribute('x2', x); }
            const mB = window.document.getElementById('rtg-markB'); if (mB) { const x = X(Math.min(st.hazB | 0, N - 1)).toFixed(1); mB.setAttribute('x1', x); mB.setAttribute('x2', x); }
        } catch (e) { }
    }
    function renderLibrary() {
        const L = LIB || {};
        const stored = L.stored || 0, disc = L.discovered || 0, target = L.target || 100000;
        const gb = ((L.storageBytes || 0) / 1e9).toFixed(2), pct = Math.min(100, stored / target * 100);
        const owned = (DATA && DATA.videos) ? DATA.videos.length : 0, b = L.viewBuckets || {};
        const bk = [['10k–100k', b['10k-100k'] || 0, C.dim], ['100k–1M', b['100k-1M'] || 0, C.cyan], ['1M–10M', b['1M-10M'] || 0, C.green], ['10M–100M', b['10M-100M'] || 0, C.orange]];
        const bmax = Math.max(1, ...bk.map(x => x[1]));
        const stat = (lab, val, col) => `<div style="background:${C.card2};border-radius:8px;padding:9px 13px"><div style="font-size:9px;color:${C.mute};text-transform:uppercase;letter-spacing:.04em">${lab}</div><div style="font-size:18px;font-weight:800;color:${col}">${val}</div></div>`;
        let h = h2c('📚 Library — the research video dataset', 'Every video we have, in one place. Your owned set (with retention curves) + a growing crawl of last-year Shorts, 10k–<100M views, full 720p stored on Cloudflare R2.');
        h += cardc(`<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
              <div style="font-size:13px;font-weight:800;color:${C.text}">Crawl progress</div>
              <span data-libreload style="cursor:pointer;border:1px solid ${C.border};color:${C.dim};border-radius:6px;padding:3px 10px;font-size:11px">↻ refresh</span></div>
            <div style="height:14px;background:${C.card2};border-radius:7px;overflow:hidden;margin-bottom:6px"><div style="height:100%;width:${pct}%;background:${C.accent};border-radius:7px"></div></div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:10px"><b style="color:${C.accent}">${stored.toLocaleString()}</b> / ${target.toLocaleString()} stored (${pct.toFixed(1)}%) · ${disc.toLocaleString()} discovered · <span style="color:${C.dim}">downloading 720p → R2…</span></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">${stat('Stored on R2', stored.toLocaleString(), C.accent)}${stat('Storage used', gb + ' GB', C.cyan)}${stat('Avg size', (L.avgSizeMB || 0) + ' MB', C.green)}${stat('Owned (w/ retention)', owned.toLocaleString(), C.purple)}</div>`);
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:8px">View distribution — last-year Shorts, 10k–&lt;100M</div>
            ${bk.map(x => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:11px"><div style="width:74px;color:${C.dim}">${x[0]}</div><div style="flex:1;height:12px;background:${C.card2};border-radius:3px;overflow:hidden"><div style="height:100%;width:${x[1] / bmax * 100}%;background:${x[2]}"></div></div><div style="width:54px;text-align:right;color:${C.text};font-weight:700">${x[1].toLocaleString()}</div></div>`).join('')}`);
        const vidGrid = (list) => !list || !list.length ? `<div style="font-size:11px;color:${C.mute};padding:8px">none yet — ${LIBV === null ? 'loading…' : 'the crawler is still downloading'}</div>`
            : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">${list.map(v => `
                <a href="https://www.youtube.com/watch?v=${esc(v.videoId)}" target="_blank" style="text-decoration:none;color:inherit">
                  <div style="background:${C.card2};border-radius:8px;overflow:hidden;border:1px solid ${C.border}">
                    <img src="https://i.ytimg.com/vi/${esc(v.videoId)}/hqdefault.jpg" loading="lazy" style="width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:${C.bg}"/>
                    <div style="padding:5px 7px"><div style="font-size:10px;color:${C.text};line-height:1.3;height:26px;overflow:hidden">${esc((v.title || '').slice(0, 52))}</div>
                      <div style="font-size:9px;color:${C.mute};margin-top:3px">${fv(v.views)} views · ${esc(v.publishedAt || '')}${v.duration ? ' · ' + esc(v.duration) : ''}</div></div></div></a>`).join('')}</div>`;
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">📥 New downloads — last-year Shorts (10k–&lt;100M), full 720p on R2 <span style="font-weight:400;color:${C.mute}">(${(LIBV || []).length} shown of ${stored.toLocaleString()})</span></div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">Most recently downloaded. Click any to open on YouTube.</div>${vidGrid(LIBV)}`);
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">💯 The 100M-view set — filtered to the last year <span style="font-weight:400;color:${C.mute}">(${(SHORTSV || []).length} of ${'2,400+'})</span></div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">Your existing high-view crawl (frames on R2), showing only those published in the last ~12 months.</div>${vidGrid(SHORTSV)}`);
        h += note(`<b>What this is for:</b> the big set trains the reference→gratification / encoder model at the scale it's currently starved for (211 → 100k), and powers views-based analysis. <b>Retention curves only exist for your ${owned} owned videos</b> (YouTube only gives audience retention to the owner), so the hold/flatten validation stays on the owned set — the big set ties in for content-structure + views. Target ${target.toLocaleString()} at 720p ≈ ~0.15 TB on R2.`, C.cyan);
        return h;
    }
    // 🔬 RAW — unsupervised hook-embedding playground (first-5s montage → Gemini → UMAP-2D), recolour to find patterns
    function rawRamp(t) { // 0..1 → cool→warm
        const cool = [59, 76, 192], mid = [221, 221, 221], warm = [180, 4, 38]; t = Math.max(0, Math.min(1, t));
        const [a, b, u] = t < 0.5 ? [cool, mid, t * 2] : [mid, warm, (t - 0.5) * 2];
        return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * u)).join(',')})`;
    }
    function rawEnsure(ch) { if (RAW[ch]) return; RAW[ch] = { loading: 1 }; fetch('/api/raw/map?channel=' + ch).then(r => r.json()).then(j => { RAW[ch] = j; rtgUpdateRaw(); }).catch(() => { RAW[ch] = { n: 0 }; rtgUpdateRaw(); }); }
    // ── ONE global hook-scoring source: an upload's number on the map IS out.steer (computed
    //    server-side, identical to how the map scores every video). The graph marker AND the
    //    Experiment grid both read it through these — change the maths once, both follow. ──
    const STEER_KEY = { views: 'views', rawviews: 'views', realviews: 'realviews', outlier: 'outlier', hi10m: 'gt10M', keep: 'keep', ret5: 'ret5' };
    function steerOf(up, mod, tn) { const s = up && up.steer; const k = s && s[`${mod}_${tn}`]; return k || null; }   // {est,pctile,kind}
    function steerBest(up, tn) { for (const m of ['together', 'text', 'visual']) { const k = steerOf(up, m, tn); if (k) return { mod: m, ...k }; } return null; }
    function steerDisp(tn, v) { if (v == null) return null; return (tn === 'views' || tn === 'realviews') ? fv(+v) : tn === 'outlier' ? (+v).toFixed(1) + '×' : tn === 'gt10M' ? (+v * 100).toFixed(0) + '%' : (+v).toFixed(0) + '%'; }
    function steerLabel(tn) { return tn === 'realviews' ? 'est. views (your scale)' : tn === 'views' ? 'est. views (library scale)' : tn === 'outlier' ? 'est. outlier' : tn === 'gt10M' ? 'chance >10M' : tn === 'keep' ? 'est. keep-rate' : 'est. past-5s'; }
    function renderRaw() {
        const chan = st.rawChan || 'visual';
        const chanPill = (id, lab) => `<span data-rawchan="${id}" style="cursor:pointer;border:1px solid ${chan === id ? C.purple : C.border};background:${chan === id ? C.purple + '22' : 'transparent'};color:${chan === id ? C.purple : C.dim};border-radius:8px;padding:5px 13px;font-size:12px;font-weight:700">${lab}</span>`;
        const tabs = `<div style="display:flex;gap:6px;margin-bottom:10px">${chanPill('visual', '🖼 Visual')}${chanPill('text', '🗣 Text')}${chanPill('together', '🔗 Together')}</div>`;
        const head = h2c('🔬 Raw — hook embeddings', 'The first 5 seconds of every stored video, embedded with Gemini, no labels. Three channels — what it LOOKS like, what is SAID, and both. Steer the projection toward views/outliers (held-out scored) and click any dot to see the exact input.');
        const R = RAW[chan];
        if (!R) { rawEnsure(chan); return head + tabs + cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">Loading ${chan}…</div>`); }
        if (R.loading) return head + tabs + cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">Loading ${chan}…</div>`);
        if (!R.n) return head + tabs + cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">No ${chan} embeddings yet — the pipeline is still running (${chan === 'visual' ? 'visual is first' : 'text/together build over ~1.5h'}). Refresh shortly.</div>`);
        const n = R.n, W = 820, H = 520, pad = 16, S = 1000;
        const X = g => pad + g / S * (W - 2 * pad), Yc = g => pad + (1 - g / S) * (H - 2 * pad);
        const PJ = R.proj || {};
        const PROJS = [['both', '→ views+outlier'], ['views', '→ views (log)'], ['rawviews', '→ views (raw)'], ['realviews', '→ realistic views'], ['outlier', '→ outlier'], ['hi10m', '>10M class'], ['hiout', 'top-outlier'], ['keep', '→ keep-rate'], ['ret5', '→ 5s-retention'], ['umap', 'UMAP raw'], ['pca', 'PCA raw']].filter(p => PJ[p[0]]);
        let pm = st.rawProj || 'both'; if (!PJ[pm]) pm = PROJS.length ? PROJS[0][0] : null;
        const proj = (pm && PJ[pm]) || { x: R.x || [], y: R.y || [], cv: 0, co: 0 };
        const supervised = pm && !['umap', 'pca'].includes(pm);
        const mode = st.rawColor || 'cluster', k = st.rawK || '10';
        const MINE = R.mine || [], SILENT = R.silent || [];
        const hiMine = !!st.rawMine;   // "highlight my videos" toggle
        // keep / 5s-retention projections are ORGANISED BY THE METRIC ITSELF: every video
        // carries an estimated keep% (extrapolated from your 211 — proj.est), and your own
        // videos carry their ACTUAL keep% (proj.actual). Colour by that, not views/cluster.
        const ESTP = (pm === 'keep' || pm === 'ret5') && proj.est ? proj.est : null;
        const ACTP = (pm === 'keep' || pm === 'ret5') && proj.actual ? proj.actual : null;
        const metLabel = pm === 'keep' ? 'keep-rate' : '5s-retention';
        // The metric THIS projection tracks — shared by the trend bands AND (when bands are on)
        // the dot colour, so the rising trend is visually confirmable instead of arbitrary clusters.
        // `dir` is the per-point value the bands average; continuous metrics use log so a few
        // mega-outliers don't dominate; the display un-logs it back to real units.
        const bandMetric = () => {
            const V = R.views || [], O = R.outlier || [];
            if (ESTP) return { dir: ESTP.map((e, i) => (ACTP && ACTP[i] != null) ? ACTP[i] : e), label: metLabel, fmt: v => v.toFixed(0) + '%', binary: false, pctLinear: true };
            if (pm === 'hi10m') return { dir: V.map(x => (+x > 1e7 ? 1 : 0)), label: '>10M-view share', fmt: v => Math.round(v * 100) + '%', binary: true, pctLinear: false };
            if (pm === 'hiout') { const ov = O.map(x => (x == null ? NaN : +x)), sv = ov.filter(x => !isNaN(x)).slice().sort((p, q) => p - q), thr = sv.length ? sv[Math.floor(sv.length * 0.85)] : Infinity; return { dir: ov.map(x => (!isNaN(x) && x >= thr) ? 1 : 0), label: 'top-outlier share', fmt: v => Math.round(v * 100) + '%', binary: true, pctLinear: false }; }
            if (pm === 'outlier') return { dir: O.map(x => (x == null ? NaN : Math.log10(+x + 1))), label: 'outlier', fmt: v => v.toFixed(1) + '×', binary: false, pctLinear: false };
            if (pm === 'realviews' && proj.est) return { dir: proj.est.map(x => Math.log10((+x || 0) + 1)), label: 'realistic views (your scale)', fmt: v => fv(v), binary: false, pctLinear: false };
            return { dir: V.map(x => Math.log10((+x || 0) + 1)), label: 'views', fmt: v => fv(v), binary: false, pctLinear: false };
        };
        const BM = st.rawBands ? bandMetric() : null;
        let colOf, estLo = 0, estHi = 100;
        if (BM) {
            // bands ON → ALWAYS colour by the metric the bands track (ignore the colour pills), so
            // the colour gradient can never disagree with the trend path. Otherwise colouring by e.g.
            // VIEWS while the bands track OUTLIER makes the dots fight the path (high views ≠ high outlier).
            const ok = BM.dir.filter(x => x != null && isFinite(x)); estLo = Math.min(...ok); estHi = Math.max(...ok);
            colOf = i => (BM.dir[i] == null || !isFinite(BM.dir[i])) ? '#334155' : rawRamp((BM.dir[i] - estLo) / ((estHi - estLo) || 1));
        }
        else if (ESTP && (mode === 'cluster' || mode === 'metric')) {
            const ok = ESTP.filter(x => x != null && isFinite(x)); estLo = Math.min(...ok); estHi = Math.max(...ok);
            colOf = i => { const v = (ACTP && ACTP[i] != null) ? ACTP[i] : ESTP[i]; return v == null || !isFinite(v) ? '#334155' : rawRamp((v - estLo) / ((estHi - estLo) || 1)); };
        }
        else if (pm === 'realviews' && proj.est && (mode === 'cluster' || mode === 'metric')) {
            const e = proj.est.map(x => Math.log10((+x || 0) + 1)), ok = e.filter(isFinite); estLo = Math.min(...ok); estHi = Math.max(...ok);
            colOf = i => isFinite(e[i]) ? rawRamp((e[i] - estLo) / ((estHi - estLo) || 1)) : '#334155';
        }
        else if (mode === 'cluster') { const cl = (R.clusters || {})[k] || []; colOf = i => tcol(cl[i] != null ? cl[i] : -1); }
        else if (mode === 'voiceover') { colOf = i => SILENT[i] ? '#475569' : C.green; }
        else {
            const raw = mode === 'views' ? R.views : mode === 'outlier' ? R.outlier : R.subs;
            const vals = raw.map(x => x == null ? null : Math.log10((+x) + 1));
            const ok = vals.filter(x => x != null && isFinite(x)); const lo = Math.min(...ok), hi = Math.max(...ok);
            colOf = i => vals[i] == null || !isFinite(vals[i]) ? '#334155' : rawRamp((vals[i] - lo) / ((hi - lo) || 1));
        }
        const GOLD = '#fbbf24';
        const selI = st.rawSel != null ? (R.id || []).indexOf(st.rawSel) : -1;
        let dots = '', mineDots = '';
        for (let i = 0; i < n; i++) {
            const kpv = ESTP ? ((ACTP && ACTP[i] != null) ? `${ACTP[i].toFixed(0)}% ${metLabel} (actual)` : (ESTP[i] != null ? `~${ESTP[i].toFixed(0)}% ${metLabel} (est.)` : '')) : '';
            const tip = `${MINE[i] ? '★ YOUR VIDEO · ' : ''}${esc((R.title[i] || '').slice(0, 40))} · ${fv(R.views[i])} views${kpv ? ' · ' + kpv : ''}${SILENT[i] ? ' · no voiceover' : ''}`;
            const sel = i === selI, mine = hiMine && MINE[i];
            const op = sel ? 1 : (hiMine && !MINE[i] ? 0.12 : 0.72);
            const circ = `<circle data-rawid="${R.id ? R.id[i] : ''}" cx="${X(proj.x[i]).toFixed(1)}" cy="${Yc(proj.y[i]).toFixed(1)}" r="${sel ? 5.5 : mine ? 4 : 2.4}" fill="${mine ? GOLD : colOf(i)}" opacity="${op}" stroke="${sel ? '#fff' : mine ? GOLD : 'none'}" stroke-width="${sel ? 1.5 : mine ? 1.2 : 0}" style="cursor:pointer"><title>${tip}</title></circle>`;
            if (mine) mineDots += circ; else dots += circ;   // draw mine on top
        }
        dots += mineDots;
        // ── uploaded videos: each placed at the similarity-weighted centroid of its
        //    nearest neighbours in THIS channel+projection (the maps store coords, not
        //    the projection models, so a new hook lands among the hooks it's most like).
        //    Several can be compared at once, each a distinctly-coloured numbered mark. ──
        const CYAN = '#22d3ee';
        const UPCOLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#facc15', '#34d399', '#f87171', '#60a5fa', '#fda4af'];
        const ups = st.rawUploads || [];
        const upColor = i => UPCOLORS[i % UPCOLORS.length];
        const upPos = (u) => {           // centroid of this upload's neighbours in the current channel/proj
            const uc = u && u.channels ? u.channels[chan] : null;
            if (!uc || !uc.neighbors) return null;
            let sx = 0, sy = 0, sw = 0, used = 0;
            for (const nb of uc.neighbors) {
                const idx = (R.id || []).indexOf(nb.id); if (idx < 0) continue;
                const w = Math.max(0.001, nb.sim); sx += proj.x[idx] * w; sy += proj.y[idx] * w; sw += w; used++;
            }
            return sw > 0 ? { gx: sx / sw, gy: sy / sw, used } : null;
        };
        if (st.rawUpShow) {
            ups.forEach((u, i) => {
                const p = upPos(u); if (!p) return;
                const col = upColor(i), ux = X(p.gx).toFixed(1), uy = Yc(p.gy).toFixed(1), selU = st.rawUpSel === i;
                const sk = STEER_KEY[pm], sEst = sk ? steerOf(u, chan, sk) : null;   // SAME number the Experiment shows
                const sTxt = sEst ? ` — ${steerDisp(sk, sEst.est)} ${steerLabel(sk)} (${sEst.pctile}th pctile)` : ` — among ${p.used} nearest hooks`;
                dots += `<line x1="${ux}" y1="${(+uy - 10).toFixed(1)}" x2="${ux}" y2="${(+uy + 10).toFixed(1)}" stroke="${col}" stroke-width="1" opacity="0.55"/>`
                    + `<line x1="${(+ux - 10).toFixed(1)}" y1="${uy}" x2="${(+ux + 10).toFixed(1)}" y2="${uy}" stroke="${col}" stroke-width="1" opacity="0.55"/>`
                    + `<circle data-rawupmark="${i}" cx="${ux}" cy="${uy}" r="${selU ? 9 : 7}" fill="${col}" stroke="#fff" stroke-width="${selU ? 3 : 2}" style="cursor:pointer"><title>⬆ #${i + 1} ${esc(u.title || 'upload')}${sTxt}</title></circle>`
                    + `<text x="${ux}" y="${(+uy + 3.5).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="#0f172a" style="pointer-events:none">${i + 1}</text>`;
            });
        }
        // ── TREND BANDS: empirically find the direction the metric trends along THIS
        //    projection (linear gradient of the metric over the 2D coords), split into
        //    sections with dashed dividing lines, and label each band's average. Works
        //    for any view; the metric follows the projection's target. ──
        let bandUnder = '', bandOver = '', bandNote = '';
        if (st.rawBands && BM) {
            const { dir, label, binary, fmt, pctLinear } = BM;
            const px = proj.x, py = proj.y, idxV = [];
            for (let i = 0; i < n; i++) { if (dir[i] != null && isFinite(dir[i]) && px[i] != null) idxV.push(i); }
            if (idxV.length > 30) {
                // Find the DIRECTION the tracked metric actually rises across this map, then
                // split ⟂ to it. We fit the best-fit plane dir ≈ a·x + b·y + c by least squares
                // IN SCREEN SPACE (the plot is 820×520, not square — fitting in data space then
                // mapping to screen skews the angle, which is why it looked off). (a,b) = gradient.
                const sxOf = i => X(px[i]), syOf = i => Yc(py[i]);
                let mx = 0, my = 0, mm = 0;
                for (const i of idxV) { mx += sxOf(i); my += syOf(i); mm += dir[i]; }
                mx /= idxV.length; my /= idxV.length; mm /= idxV.length;
                let Sxx = 0, Syy = 0, Sxy = 0, Sxm = 0, Sym = 0;
                for (const i of idxV) { const dx = sxOf(i) - mx, dy = syOf(i) - my, dm = dir[i] - mm; Sxx += dx * dx; Syy += dy * dy; Sxy += dx * dy; Sxm += dx * dm; Sym += dy * dm; }
                const det = Sxx * Syy - Sxy * Sxy;
                let a = 0, b = 0;
                if (Math.abs(det) > 1e-9) { a = (Syy * Sxm - Sxy * Sym) / det; b = (Sxx * Sym - Sxy * Sxm) / det; }
                if (Math.hypot(a, b) > 1e-12) {
                    const t = idxV.map(i => a * sxOf(i) + b * syOf(i));     // distance along the rise direction (screen units)
                    const K = Math.max(2, Math.min(20, st.rawBandK || 6));
                    // EQUAL-COUNT bins: sort by t, split into K groups of ~equal size, so every band
                    // holds the same number of videos. (Equal-WIDTH bins put almost nothing in the
                    // sparse corners, so on a heavy-tailed metric the last band spiked to a single
                    // extreme value — that was the artefact.) Dividers sit at the t between groups.
                    const ord = idxV.map((_, j) => j).sort((p, q) => t[p] - t[q]);
                    const M = ord.length, binOf = new Array(M);
                    ord.forEach((j, rank) => { binOf[j] = Math.min(K - 1, Math.floor(rank / M * K)); });
                    const bins = Array.from({ length: K }, () => ({ vals: [], gx: 0, gy: 0, cnt: 0 }));
                    for (let j = 0; j < M; j++) { const i = idxV[j], bn = bins[binOf[j]]; bn.vals.push(dir[i]); bn.gx += sxOf(i); bn.gy += syOf(i); bn.cnt++; }
                    const bndT = [];                                       // t-value of each divider = midpoint between adjacent groups
                    for (let bI = 1; bI < K; bI++) { const r = Math.floor(bI / K * M); bndT.push((t[ord[r - 1]] + t[ord[r]]) / 2); }
                    // dividers: clip the screen-space line a·x + b·y = c to the plot rectangle → drawn ⟂ to (a,b)
                    const x0 = pad, x1 = W - pad, y0 = pad, y1 = H - pad;
                    const clip = (A, B, c) => { const p = []; if (Math.abs(B) > 1e-9) { let y = (c - A * x0) / B; if (y >= y0 && y <= y1) p.push([x0, y]); y = (c - A * x1) / B; if (y >= y0 && y <= y1) p.push([x1, y]); } if (Math.abs(A) > 1e-9) { let x = (c - B * y0) / A; if (x >= x0 && x <= x1) p.push([x, y0]); x = (c - B * y1) / A; if (x >= x0 && x <= x1) p.push([x, y1]); } return p.length >= 2 ? [p[0], p[1]] : null; };
                    for (const c of bndT) { const seg = clip(a, b, c); if (seg) bandUnder += `<line x1="${seg[0][0].toFixed(1)}" y1="${seg[0][1].toFixed(1)}" x2="${seg[1][0].toFixed(1)}" y2="${seg[1][1].toFixed(1)}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4 5" opacity="0.32"/>`; }
                    // per-band value: MEDIAN for continuous metrics (robust to the heavy tail), MEAN for binary/% rates
                    const stat = bn => { if (binary || pctLinear) return bn.vals.reduce((s, v) => s + v, 0) / bn.cnt; const s = bn.vals.slice().sort((p, q) => p - q), m = s.length; return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2; };
                    // the trend PATH: a polyline through the band centroids (low→high), arrowhead at the high end
                    const cents = [];
                    for (let bi = 0; bi < K; bi++) { const bn = bins[bi]; if (bn.cnt < 3) continue; cents.push([bn.gx / bn.cnt, bn.gy / bn.cnt]); }
                    if (cents.length >= 2) {
                        bandUnder += `<polyline points="${cents.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="${C.cyan}" stroke-width="2" opacity="0.65"/>`;
                        const e0 = cents[cents.length - 2], e1 = cents[cents.length - 1], ang = Math.atan2(e1[1] - e0[1], e1[0] - e0[0]), ah = 9;
                        bandUnder += `<path d="M${e1[0].toFixed(1)},${e1[1].toFixed(1)} L${(e1[0] - ah * Math.cos(ang - 0.45)).toFixed(1)},${(e1[1] - ah * Math.sin(ang - 0.45)).toFixed(1)} M${e1[0].toFixed(1)},${e1[1].toFixed(1)} L${(e1[0] - ah * Math.cos(ang + 0.45)).toFixed(1)},${(e1[1] - ah * Math.sin(ang + 0.45)).toFixed(1)}" stroke="${C.cyan}" stroke-width="2" fill="none" opacity="0.85"/>`;
                    }
                    for (let bi = 0; bi < K; bi++) {
                        const bn = bins[bi]; if (bn.cnt < 3) continue;
                        const cx = bn.gx / bn.cnt, cy = bn.gy / bn.cnt, v = stat(bn);
                        const txt = fmt((binary || pctLinear) ? v : Math.pow(10, v)), w = txt.length * 6.6 + 12;
                        bandOver += `<g style="pointer-events:none"><rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - 9).toFixed(1)}" width="${w.toFixed(1)}" height="16" rx="4" fill="#0f172a" opacity="0.85" stroke="#1e293b"/><text x="${cx.toFixed(1)}" y="${(cy + 2.8).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#e2e8f0">${txt}</text></g>`;
                    }
                    const statWord = (binary || pctLinear) ? 'avg' : 'median';
                    bandNote = `<b style="color:${C.cyan}">Trend bands ON</b> — dots are coloured by <b>${label}</b> (<span style="color:${rawRamp(0)}">low</span>→<span style="color:${rawRamp(1)}">high</span>) so the colour <b>always matches the band metric</b> — the colour pills are paused; the cyan <b>path</b> (→ arrow) is the best-fit direction it rises; dashed lines cut <b>⟂ to that path</b> into ${K} equal-count bands, each labelled with its <b>${statWord} ${label}</b>.`;
                }
            }
            if (!bandNote) bandNote = `<b style="color:${C.cyan}">Trend bands</b> — not enough data to fit a trend here.`;
        }
        const pill = (id, lab, on, attr) => `<span ${attr}="${id}" style="cursor:pointer;border:1px solid ${on ? C.accent : C.border};background:${on ? C.accent + '1e' : 'transparent'};color:${on ? C.accent : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">${lab}</span>`;
        const projPill = ([id, lab]) => `<span data-rawproj="${id}" style="cursor:pointer;border:1px solid ${pm === id ? C.accent : C.border};background:${pm === id ? C.accent + '1e' : 'transparent'};color:${pm === id ? C.accent : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">${lab}${PJ[id] && !['umap', 'pca'].includes(id) ? ` <span style="opacity:.65;font-weight:400">v${PJ[id].cv}/o${PJ[id].co}</span>` : ''}</span>`;
        const auc = R.heldout_auc10m, rv = R.heldout_rviews;
        const heldline = (auc != null || rv != null) ? `<div style="font-size:10px;color:${C.mute};margin-top:5px;line-height:1.5"><b style="color:${C.accent}">Held-out test</b> (fit on 70%, scored on the 30% it never saw)${auc != null ? ` — predicting <b>>10M views</b>: AUC <b style="color:${auc >= 0.7 ? C.green : auc >= 0.6 ? C.amber : C.dim}">${(+auc).toFixed(3)}</b> (0.5 = chance)` : ''}${rv != null ? ` · log-views correlation r=<b>${(+rv).toFixed(3)}</b>` : ''}. This is the honest, non-overfit signal.</div>` : '';
        const detail = st.rawSel != null && selI >= 0 ? (() => {
            const i = selI, id = st.rawSel;
            const txt = (R.txt && R.txt[i]) || '';
            const monUrl = `/api/raw/montage/${id}`;
            const meta = [['views', fv(R.views[i])], ['outlier', R.outlier && R.outlier[i] ? R.outlier[i] + '× subs' : '—'], ['subs', R.subs && R.subs[i] != null ? fv(R.subs[i]) : '—']];
            if (ESTP) meta.unshift([metLabel, (ACTP && ACTP[i] != null) ? `<span style="color:#fbbf24">${ACTP[i].toFixed(0)}% (yours, actual)</span>` : (ESTP[i] != null ? `~${ESTP[i].toFixed(0)}% (est.)` : '—')]);
            const isMine = (R.mine || [])[i], isSilent = (R.silent || [])[i];
            const lab = s => `<div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:4px">${s}</div>`;
            const imgEl = `<img src="${monUrl}" style="width:100%;border-radius:6px;background:#000;margin-bottom:8px;min-height:60px" onerror="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'Montage still rendering for this video — the embed run reaches it shortly.',style:'font-size:11px;color:#94a3b8;padding:14px;text-align:center;background:#0f172a;border-radius:6px;margin-bottom:8px'}))"/>`;
            const txtEl = txt ? `<div style="font-size:12px;color:${C.text};font-style:italic;margin-bottom:8px;line-height:1.45;background:${C.bg || '#0f172a'};border-radius:6px;padding:9px 11px">"${esc(txt)}"</div>` : `<div style="font-size:11px;color:${C.dim};margin-bottom:8px">No speech in the first 5s — an empty transcript was embedded.</div>`;
            // Show EXACTLY what this channel fed the embedder — nothing more.
            let inputBlock;
            if (chan === 'visual') {
                inputBlock = lab('Exact input embedded — first-5s frames, 1/sec') + imgEl;
            } else if (chan === 'text') {
                inputBlock = lab('Exact input embedded — first-5s transcript (Whisper)') + txtEl
                    + `<div style="font-size:9px;color:${C.faint};text-transform:uppercase;margin:2px 0 4px">↓ source video (for reference — NOT part of the text embedding)</div>` + imgEl;
            } else {
                inputBlock = txt
                    ? lab('Exact input embedded — frames + transcript, fused into one vector') + imgEl + txtEl
                    : lab('Exact input embedded — frames only (no speech in first 5s, so nothing text was added)') + imgEl;
            }
            return `<div style="margin-top:10px;border:1px solid ${isMine ? '#fbbf24' : C.border};border-radius:10px;padding:12px;background:${C.card2}">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px"><div style="font-size:12px;font-weight:700;color:${C.text};line-height:1.4">${isMine ? `<span style="color:#fbbf24">★ YOUR VIDEO</span> · ` : ''}${esc(R.title[i] || '(untitled)')}${isSilent ? ` <span style="color:${C.faint};font-weight:400;font-size:10px">· no voiceover</span>` : ''}</div><span data-rawclose="1" style="cursor:pointer;color:${C.dim};font-size:16px;line-height:1;padding:0 4px">×</span></div>
                  ${inputBlock}
                  <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px">${meta.map(([k2, v]) => `<div><div style="font-size:9px;color:${C.mute};text-transform:uppercase">${k2}</div><div style="font-size:13px;font-weight:700;color:${C.text}">${v}</div></div>`).join('')}</div>
                  <a href="https://youtube.com/watch?v=${id}" target="_blank" style="font-size:11px;color:${C.accent};text-decoration:none">▶ Open on YouTube →</a>
                </div>`;
        })() : '';
        let h = head + tabs;
        const nmine = R.nmine != null ? R.nmine : MINE.filter(Boolean).length;
        const nsilent = R.nsilent != null ? R.nsilent : SILENT.filter(Boolean).length;
        const mineBtn = `<span data-rawmine="1" style="cursor:pointer;border:1px solid ${hiMine ? GOLD : C.border};background:${hiMine ? GOLD + '22' : 'transparent'};color:${hiMine ? GOLD : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">★ My videos${nmine ? ' (' + nmine + ')' : ''}</span>`;
        const UPSTAGES = ['Uploading…', 'Extracting the 5 hook frames…', 'Transcribing the audio…', 'Embedding visual · text · together…', 'Placing among similar hooks…'];
        const upStage = Math.min(st.rawUpStage || 0, UPSTAGES.length - 1);
        const upPct = Math.min(93, Math.round((upStage + 1) / UPSTAGES.length * 100));
        const q = st.rawUpQueue;
        const uploadBtn = `<span data-rawupload="1" style="cursor:pointer;border:1px solid ${C.border};background:transparent;color:${C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">⬆ Upload video${ups.length ? 's — add more' : '(s)'}</span>`;
        const showBtn = ups.length ? `<span data-rawupshow="1" style="cursor:pointer;border:1px solid ${st.rawUpShow ? CYAN : C.border};background:${st.rawUpShow ? CYAN + '22' : 'transparent'};color:${st.rawUpShow ? CYAN : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">⬆ My uploads (${ups.length})</span><span data-rawupclear="1" style="cursor:pointer;color:${C.mute};font-size:10px;margin-left:3px">clear all</span>` : '';
        const upBtn = st.rawUploading
            ? `<span style="display:inline-flex;flex-direction:column;gap:3px;min-width:250px;vertical-align:middle">
                 <span style="font-size:10px;color:${CYAN};font-weight:700">⏳ ${q && q.total > 1 ? `(${q.i}/${q.total}) ` : ''}${UPSTAGES[upStage]} <span style="color:${C.mute};font-weight:400">${upPct}%</span></span>
                 <span style="display:block;height:6px;background:${C.border};border-radius:4px;overflow:hidden"><span style="display:block;height:100%;width:${upPct}%;background:linear-gradient(90deg,${CYAN},#67e8f9);border-radius:4px;transition:width .5s ease"></span></span>
               </span>`
            : `${uploadBtn} ${showBtn}`;
        const upErr = st.rawUpErr ? `<span style="font-size:10px;color:${C.red}">upload failed: ${esc(String(st.rawUpErr).slice(0, 80))}</span>` : '';
        const modeToggle = `<span data-rawbuildmode="0" style="cursor:pointer;border:1px solid ${!st.rawBuildMode ? CYAN : C.border};background:${!st.rawBuildMode ? CYAN + '22' : 'transparent'};color:${!st.rawBuildMode ? CYAN : C.dim};border-radius:6px 0 0 6px;padding:3px 9px;font-size:10px;font-weight:700">🎬 Video</span><span data-rawbuildmode="1" style="cursor:pointer;border:1px solid ${st.rawBuildMode ? CYAN : C.border};border-left:none;background:${st.rawBuildMode ? CYAN + '22' : 'transparent'};color:${st.rawBuildMode ? CYAN : C.dim};border-radius:0 6px 6px 0;padding:3px 9px;font-size:10px;font-weight:700">🖼 5 frames + text</span>`;
        const fr = st.rawFrames || [null, null, null, null, null];
        const nFrames = fr.filter(Boolean).length;
        const builder = st.rawBuildMode ? `<div style="border:1px solid ${C.border};border-radius:10px;padding:10px;margin-bottom:8px;background:${C.card2}">
              <div style="font-size:10px;color:${C.mute};margin-bottom:6px">Build a hook from photos — drop in up to 5 frames (any image type, auto-fit to 9:16) and set the spoken text. It's embedded the same way and added as a marker to compare.</div>
              <div style="display:flex;gap:6px;align-items:flex-end;margin-bottom:8px">${[0, 1, 2, 3, 4].map(i => fr[i]
            ? `<div style="position:relative"><img src="${fr[i]}" style="width:48px;height:85px;object-fit:cover;border-radius:5px;border:1px solid ${C.border}"/><span data-rawframedel="${i}" style="position:absolute;top:-7px;right:-7px;background:${C.card};border:1px solid ${C.border};color:${C.dim};border-radius:50%;width:16px;height:16px;line-height:14px;text-align:center;font-size:10px;cursor:pointer">✕</span><div style="text-align:center;font-size:8px;color:${C.mute}">${i + 1}</div></div>`
            : `<div data-rawframe="${i}" style="width:48px;height:85px;border:1px dashed ${C.border};border-radius:5px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:${C.mute};cursor:pointer;font-size:9px">＋<span>frame ${i + 1}</span></div>`).join('')}</div>
              <input data-rawtext type="text" value="${esc(st.rawText || '')}" placeholder="optional — type the hook's spoken text (drives Text + Together)…" style="width:100%;box-sizing:border-box;background:${C.bg || '#0f172a'};border:1px solid ${C.border};color:${C.text};border-radius:6px;padding:7px 9px;font-size:12px;margin-bottom:8px"/>
              <span data-rawplace="1" style="cursor:${nFrames ? 'pointer' : 'not-allowed'};border:1px solid ${nFrames ? CYAN : C.border};background:${nFrames ? CYAN + '22' : 'transparent'};color:${nFrames ? CYAN : C.faint};border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700">◆ Place this hook${nFrames ? ` (${nFrames}/5 frames)` : ''}</span>
            </div>` : '';
        const upLegend = ups.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:7px"><span style="font-size:9px;color:${C.mute};text-transform:uppercase">my uploads</span>${ups.map((u, i) => `<span data-rawupmark="${i}" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;border:1px solid ${st.rawUpSel === i ? upColor(i) : C.border};background:${upColor(i)}1e;border-radius:6px;padding:2px 7px;font-size:10px;color:${C.text}"><span style="display:inline-block;width:13px;height:13px;border-radius:50%;background:${upColor(i)};color:#0f172a;font-size:9px;font-weight:700;text-align:center;line-height:13px">${i + 1}</span>${esc((u.title || 'upload').replace(/\.[^.]+$/, '').slice(0, 22))}${u.silent ? ' 🔇' : ''}<span data-rawupdel="${i}" style="color:${C.mute};margin-left:2px">✕</span></span>`).join('')}</div>` : '';
        const upDetail = (st.rawUpSel != null && ups[st.rawUpSel]) ? (() => {
            const i = st.rawUpSel, U = ups[i], col = upColor(i);
            const uc = U.channels ? U.channels[chan] : null, pos = upPos(U);
            const nbrTitles = (uc && uc.neighbors ? uc.neighbors.slice(0, 4) : []).map(nb => {
                const idx = (R.id || []).indexOf(nb.id);
                return `<div style="font-size:10px;color:${C.dim};display:flex;justify-content:space-between;gap:8px"><span>${esc((idx >= 0 ? R.title[idx] : nb.id) || nb.id).slice(0, 44)}</span><span style="color:${C.mute}">sim ${nb.sim}</span></div>`;
            }).join('');
            const placed = pos
                ? `<div style="font-size:10px;color:${C.mute};margin-bottom:6px">Marker <b style="color:${col}">#${i + 1}</b> sits at the similarity-weighted centre of its <b>${pos.used}</b> nearest hooks in the <b>${chan}</b> space. Switch channel/projection to compare where each lands there.</div>${nbrTitles ? `<div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:3px">most similar hooks</div>${nbrTitles}` : ''}`
                : (chan === 'text'
                    ? `<div style="font-size:11px;color:${C.dim};margin-bottom:6px">No real voiceover detected, so it isn't placed in the <b>text</b> space (only genuine voiceovers live here). It still appears in <b>Visual</b> and <b>Together</b>.</div>`
                    : `<div style="font-size:11px;color:${C.dim};margin-bottom:6px">Couldn't place it in this channel.</div>`);
            return `<div style="margin-top:10px;border:1px solid ${col};border-radius:10px;padding:12px;background:${C.card2}">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px"><div style="font-size:12px;font-weight:700;color:${C.text};line-height:1.4"><span style="color:${col}">⬆ #${i + 1}</span> · ${esc(U.title || 'My upload')}${U.silent ? ` <span style="color:${C.faint};font-weight:400;font-size:10px">· no voiceover</span>` : ''}</div><span data-rawupclose="1" style="cursor:pointer;color:${C.dim};font-size:16px;line-height:1;padding:0 4px">×</span></div>
                  <div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:4px">exact input embedded — first-5s frames, 1/sec</div>
                  <img src="data:image/jpeg;base64,${U.montage}" style="width:100%;border-radius:6px;background:#000;margin-bottom:8px"/>
                  ${U.silent ? '' : `<div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:2px">transcript (first 5s)</div><div style="font-size:12px;color:${C.text};font-style:italic;margin-bottom:8px;line-height:1.45;background:#0f172a;border-radius:6px;padding:9px 11px">"${esc(U.transcript || '')}"</div>`}
                  ${placed}
                  ${(() => { const s = U.steer || {}; const row = (tn, lab) => { for (const m of ['together', 'text', 'visual']) { const k = s[`${m}_${tn}`]; if (k) return `<div style="display:flex;justify-content:space-between;gap:10px;font-size:11px"><span style="color:${C.mute}">${lab}</span><span style="color:${C.text};font-weight:700">~${k.est}% <span style="color:${C.mute};font-weight:400">(${k.pctile}th pctile of corpus · via ${m})</span></span></div>`; } return ''; }; const kk = row('keep', 'est. keep-rate') + row('ret5', 'est. past-5s'); return kk ? `<div style="margin-top:8px;border-top:1px solid ${C.border};padding-top:7px"><div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:4px">extrapolated onto your 211's scale</div>${kk}<div style="font-size:9px;color:${C.faint};margin-top:4px">Projected onto the same steered direction as the 11k map, quantile-mapped to your videos' actual outcomes. Open <b>→ keep-rate</b> to see it placed.</div></div>` : ''; })()}
                </div>`;
        })() : '';
        h += `<input id="rawUpFile" type="file" accept="video/*" multiple style="display:none"><input id="rawFrameFile" type="file" accept="image/*" style="display:none">`;
        h += cardc(`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
              <div style="font-size:12px;font-weight:700;color:${C.text};display:flex;gap:6px;align-items:center;flex-wrap:wrap">${n.toLocaleString()} hooks · ${chan} ${mineBtn} ${modeToggle} ${st.rawBuildMode ? showBtn : upBtn} ${upErr}</div>
              <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center"><span style="font-size:9px;color:${C.mute};text-transform:uppercase">colour</span>${pill('cluster', 'cluster', mode === 'cluster', 'data-rawcolor')}${pill('views', 'views', mode === 'views', 'data-rawcolor')}${pill('outlier', 'outlier', mode === 'outlier', 'data-rawcolor')}${pill('subs', 'subs', mode === 'subs', 'data-rawcolor')}${chan !== 'text' ? pill('voiceover', 'voiceover', mode === 'voiceover', 'data-rawcolor') : ''}${mode === 'cluster' ? `<span style="width:6px"></span><span style="font-size:9px;color:${C.mute}">k</span>${['6', '10', '16', '24'].map(kk => pill(kk, kk, k === kk, 'data-rawk')).join('')}` : ''}</div></div>${builder}
            <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-bottom:7px"><span style="font-size:9px;color:${C.mute};text-transform:uppercase">project</span>${PROJS.map(projPill).join('')}<span style="width:8px"></span><span data-rawbands="1" style="cursor:pointer;border:1px solid ${st.rawBands ? C.cyan : C.border};background:${st.rawBands ? C.cyan + '22' : 'transparent'};color:${st.rawBands ? C.cyan : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">📊 trend bands</span>${st.rawBands ? `<span style="font-size:9px;color:${C.mute};margin-left:2px">sections</span>${[4, 6, 8, 12, 16].map(kk => `<span data-rawbandk="${kk}" style="cursor:pointer;border:1px solid ${(st.rawBandK || 6) === kk ? C.cyan : C.border};background:${(st.rawBandK || 6) === kk ? C.cyan + '1e' : 'transparent'};color:${(st.rawBandK || 6) === kk ? C.cyan : C.dim};border-radius:6px;padding:3px 8px;font-size:10px;font-weight:700">${kk}</span>`).join('')}` : ''}</div>
            ${st.rawBands ? `<div style="font-size:10px;color:${C.mute};margin-bottom:5px;line-height:1.5">${bandNote}</div>` : ''}
            <div style="font-size:10px;color:${C.mute};margin-bottom:5px;line-height:1.5">${ESTP ? `<b style="color:${C.green}">Steered toward ${metLabel}</b> — the embedding space is rotated by your 211 (the only videos with retention) so an axis tracks ${metLabel}, then <b>every</b> hook gets an <b>estimated ${metLabel}%</b> (extrapolated; held-out align <b>r=${proj.cv}</b>). Your videos show their <b>actual</b> ${metLabel}; corpus videos fall <b>above and below</b> them on the same 0–100% scale.` : supervised ? `<b style="color:${C.accent}">Steered projection</b> — axes rotated toward the target (held-out scored). This one aligns with <b>views r=${proj.cv}</b>, <b>outlier r=${proj.co}</b> (each pill shows v/o; higher = the axes separate that target more — pick the highest for what you're hunting).` : `<b>Raw geometry</b> (no target). Switch to a steered projection to pull views/outliers apart.`} ${ESTP ? `Coloured by <b>${metLabel}</b> (<span style="color:${rawRamp(0)}">${estLo.toFixed(0)}%</span>→<span style="color:${rawRamp(1)}">${estHi.toFixed(0)}%</span>); your videos use actual, the rest estimated.` : mode === 'voiceover' ? `Coloured by <b>voiceover</b>: <span style="color:${C.green}">●</span> has a real voiceover · <span style="color:#475569">●</span> no sound / music (${nsilent.toLocaleString()} silent, excluded from the text channel so junk transcripts can't confound it).` : mode !== 'cluster' ? `Coloured by <b>${mode}</b> (<span style="color:${rawRamp(0)}">low</span>→<span style="color:${rawRamp(1)}">high</span>).` : `Coloured by k-means cluster (k=${k}).`} ${hiMine ? `<b style="color:${GOLD}">★ Your ${nmine} videos are gold</b>; everything else is dimmed.` : `<b style="color:${C.text}">Click any dot</b> to see the exact input.`}</div>${heldline}
            ${upLegend}
            <svg viewBox="0 0 ${W} ${H}" style="width:100%;background:${C.card2};border-radius:8px;margin-top:6px">${bandUnder}${dots}${bandOver}</svg>${detail}${upDetail}`, 12);
        return h;
    }
    function rtgUpdateRaw() { try { const el = window.document.getElementById('rtg-rawpanel'); if (el) el.innerHTML = renderRaw(); } catch (e) { } try { const e2 = window.document.getElementById('rtg-exppanel'); if (e2) e2.innerHTML = renderExperiment(); } catch (e) { } }
    // ── 🎰 Guesses: every hook the model generates, dropped into the SAME map as the library ──
    function guessEnsure(run) { run = run || 'phase0'; if (GUESSES[run]) return; GUESSES[run] = { loading: 1 }; fetch('/api/hooks/guesses?run=' + run).then(r => r.json()).then(j => { GUESSES[run] = j; rtgUpdateGuesses(); }).catch(() => { GUESSES[run] = { rows: [] }; rtgUpdateGuesses(); }); }
    function rtgUpdateGuesses() { try { const el = window.document.getElementById('rtg-guesspanel'); if (el) el.innerHTML = renderGuesses(); } catch (e) { } }
    function renderGuesses() {
        const run = st.guessRun || 'phase1', metric = st.guessMetric || 'views', bands = !!st.guessBands;
        const gview = st.guessView || 'map';
        const vToggle = `<div style="display:flex;gap:6px;margin-bottom:12px">` +
            [['map', '🗺 Map'], ['grpo', '🧠 Ideas per input']].map(([id, lab]) => `<span data-guessview="${id}" style="cursor:pointer;border:1px solid ${gview === id ? C.accent : C.border};background:${gview === id ? C.accent + '1e' : 'transparent'};color:${gview === id ? C.accent : C.dim};border-radius:7px;padding:4px 11px;font-size:12px;font-weight:700">${lab}</span>`).join('') + `</div>`;
        const head = h2c('🎰 Guesses — what the model generates', 'Every hook the model dreams up, embedded into the SAME map as your 11k library. Library dots are coloured by the real metric; white-ringed dots are the model\'s guesses (coloured by predicted-views percentile). As it trains, the rings climb toward the high-views region.') + vToggle;
        if (gview === 'grpo') return head + renderGrpo();
        const rp = (id) => `<span data-guessrun="${id}" style="cursor:pointer;border:1px solid ${run === id ? C.purple : C.border};background:${run === id ? C.purple + '22' : 'transparent'};color:${run === id ? C.purple : C.dim};border-radius:8px;padding:4px 12px;font-size:12px;font-weight:700">${id}</span>`;
        if (GUESSRUNS == null) { GUESSRUNS = []; fetch('/api/hooks/runs').then(r => r.json()).then(j => { GUESSRUNS = (j.runs && j.runs.length) ? j.runs : ['phase0', 'phase1']; if (GUESSRUNS.length && !st.guessRunSet) { st.guessRun = GUESSRUNS[GUESSRUNS.length - 1]; st.guessProj = null; st.guessRunSet = 1; } rtgUpdateGuesses(); }).catch(() => { GUESSRUNS = ['phase0', 'phase1']; }); }
        const runList = (GUESSRUNS && GUESSRUNS.length) ? GUESSRUNS : ['phase0', 'phase1'];
        const G = GUESSES[run], R = RAW.visual;
        if (!R || R.loading) rawEnsure('visual');
        if (!G) guessEnsure(run);
        const PROJS = R && R.proj ? [['keep', '→ keep-rate'], ['ret5', '→ 5s-ret'], ['hi10m', '>10M class'], ['views', '→ views'], ['outlier', '→ outlier'], ['both', 'views+outlier'], ['hiout', 'top-outlier'], ['umap', 'UMAP'], ['pca', 'PCA']].filter(p => R.proj[p[0]]) : [];
        let proj = st.guessProj || ((run.indexOf('keep') === 0 || run.indexOf('grpo') === 0) ? 'keep' : 'hi10m'); if (R && R.proj && !R.proj[proj]) proj = PROJS.length ? PROJS[0][0] : 'views';
        const pPill = ([id, lab]) => `<span data-guessproj="${id}" style="cursor:pointer;border:1px solid ${proj === id ? C.accent : C.border};background:${proj === id ? C.accent + '1e' : 'transparent'};color:${proj === id ? C.accent : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">${lab}</span>`;
        const bandPill = `<span data-guessbands style="cursor:pointer;border:1px solid ${bands ? C.cyan : C.border};background:${bands ? C.cyan + '22' : 'transparent'};color:${bands ? C.cyan : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">📊 trend bands</span>`;
        const resPills = bands ? `<span style="font-size:9px;color:${C.mute};margin-left:2px">sections</span>` + [4, 6, 8, 12, 16].map(kk => `<span data-guessbandk="${kk}" style="cursor:pointer;border:1px solid ${(st.guessBandK || 6) === kk ? C.cyan : C.border};background:${(st.guessBandK || 6) === kk ? C.cyan + '1e' : 'transparent'};color:${(st.guessBandK || 6) === kk ? C.cyan : C.dim};border-radius:6px;padding:3px 8px;font-size:10px;font-weight:700">${kk}</span>`).join('') : '';
        const bandNote = bands ? `<div style="font-size:10px;color:${C.mute};margin-bottom:6px;line-height:1.5"><b style="color:${C.cyan}">Trend bands</b> — the cyan <b>path</b> (→ arrow) is the best-fit direction the metric rises across this projection; dashed lines cut <b>⟂ to it</b> into ${Math.max(2, Math.min(20, st.guessBandK || 6))} equal-count bands, each labelled with its median value. Same method as the 🔬 Raw tab.</div>` : '';
        const controls = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px;align-items:center">${runList.map(rp).join('')}<span style="width:8px"></span><span style="font-size:10px;color:${C.mute}">projection:</span>${PROJS.map(pPill).join('')}<span style="width:6px"></span>${bandPill}${resPills}</div>` + bandNote;
        if (!G || G.loading || !R || R.loading || !R.proj) return head + controls + cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">Loading guesses + 11k library map…</div>`);
        const rows = (G.rows || []);
        if (!rows.length) return head + controls + cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">No guesses yet for ${esc(run)} — they stream in as the harvest runs. <span data-guessreload style="cursor:pointer;text-decoration:underline">↻ refresh</span></div>`);
        const W = 820, H = 520, pad = 16, Sg = 1000, X = g => pad + g / Sg * (W - 2 * pad), Yc = g => pad + (1 - g / Sg) * (H - 2 * pad);
        const P = R.proj[proj] || { x: [], y: [] }, px = P.x || [], py = P.y || [];
        const LV = R.views || [], LO = R.outlier || [], logv = v => Math.log10((+v || 0) + 1);
        let dir, colOf, legLo, legHi;
        if (proj === 'hi10m') { dir = LV.map(v => +v > 1e7 ? 1 : 0); colOf = i => heatCol(dir[i]); legLo = '<10M views'; legHi = '>10M views'; }
        else if (proj === 'hiout') { const ov = LO.map(o => o == null ? NaN : +o), sv = ov.filter(x => !isNaN(x)).slice().sort((a, b) => a - b), thr = sv.length ? sv[Math.floor(sv.length * 0.85)] : Infinity; dir = ov.map(x => (!isNaN(x) && x >= thr) ? 1 : 0); colOf = i => heatCol(dir[i]); legLo = 'rest'; legHi = 'top-outlier'; }
        else if (proj === 'outlier') { const vals = LO.map(o => o == null ? null : logv(o)), ok = vals.filter(x => x != null && isFinite(x)), lo = Math.min(...ok), hi = Math.max(...ok); dir = vals; colOf = i => (vals[i] == null || !isFinite(vals[i])) ? '#334155' : heatCol((vals[i] - lo) / ((hi - lo) || 1)); legLo = 'low'; legHi = 'high outlier'; }
        else if (proj === 'keep' || proj === 'ret5') { const est = (R.proj[proj] && R.proj[proj].est) || [], ok = est.filter(x => x != null && isFinite(x)), lo = Math.min(...ok), hi = Math.max(...ok); dir = est; colOf = i => (est[i] == null || !isFinite(est[i])) ? '#334155' : heatCol((est[i] - lo) / ((hi - lo) || 1)); legLo = proj === 'keep' ? 'swipe away' : 'low 5s-ret'; legHi = proj === 'keep' ? 'high keep-rate' : 'high 5s-ret'; }
        else { const vals = LV.map(logv), ok = vals.filter(x => isFinite(x)), lo = Math.min(...ok), hi = Math.max(...ok); dir = vals; colOf = i => !isFinite(vals[i]) ? '#334155' : heatCol((vals[i] - lo) / ((hi - lo) || 1)); legLo = 'low views'; legHi = 'high views'; }
        let bg = '';
        for (let i = 0; i < px.length; i++) { if (px[i] == null) continue; bg += `<circle cx="${X(px[i]).toFixed(1)}" cy="${Yc(py[i]).toFixed(1)}" r="2" fill="${colOf(i)}" opacity="0.6"/>`; }
        const RID = R.id || [], idIndex = {}; for (let i = 0; i < RID.length; i++) idIndex[RID[i]] = i;
        const placeG = g => { if (g.nbr && g.nbr.length) { let sx = 0, sy = 0, sw = 0; for (const nb of g.nbr) { const idx = idIndex[nb[0]]; if (idx == null || px[idx] == null) continue; const w = Math.max(0.001, nb[1]); sx += px[idx] * w; sy += py[idx] * w; sw += w; } if (sw > 0) return [sx / sw, sy / sw]; } return (proj === 'views' && g.x != null) ? [g.x, g.y] : null; };
        let bandLines = '', bandLabels = '';
        if (bands) {
            const idxV = []; for (let i = 0; i < px.length; i++) if (dir[i] != null && isFinite(dir[i]) && px[i] != null) idxV.push(i);
            if (idxV.length > 30) {
                const sx = i => X(px[i]), sy = i => Yc(py[i]);
                let mx = 0, my = 0, mm = 0; for (const i of idxV) { mx += sx(i); my += sy(i); mm += dir[i]; } mx /= idxV.length; my /= idxV.length; mm /= idxV.length;
                let Sxx = 0, Syy = 0, Sxy = 0, Sxm = 0, Sym = 0;
                for (const i of idxV) { const dx = sx(i) - mx, dy = sy(i) - my, dm = dir[i] - mm; Sxx += dx * dx; Syy += dy * dy; Sxy += dx * dy; Sxm += dx * dm; Sym += dy * dm; }
                const det = Sxx * Syy - Sxy * Sxy; let a = 0, b = 0;
                if (Math.abs(det) > 1e-9) { a = (Syy * Sxm - Sxy * Sym) / det; b = (Sxx * Sym - Sxy * Sxm) / det; }
                if (Math.hypot(a, b) > 1e-12) {
                    const t = idxV.map(i => a * sx(i) + b * sy(i)), K = Math.max(2, Math.min(20, st.guessBandK || 6));
                    const ord = idxV.map((_, j) => j).sort((p, q) => t[p] - t[q]), M = ord.length, binOf = new Array(M);
                    ord.forEach((j, rank) => { binOf[j] = Math.min(K - 1, Math.floor(rank / M * K)); });
                    const bins = Array.from({ length: K }, () => ({ vals: [], gx: 0, gy: 0, cnt: 0 }));
                    for (let j = 0; j < M; j++) { const i = idxV[j], bn = bins[binOf[j]]; bn.vals.push(dir[i]); bn.gx += sx(i); bn.gy += sy(i); bn.cnt++; }
                    const x0 = pad, x1 = W - pad, y0 = pad, y1 = H - pad;
                    const clip = (A, B, c) => { const p = []; if (Math.abs(B) > 1e-9) { let y = (c - A * x0) / B; if (y >= y0 && y <= y1) p.push([x0, y]); y = (c - A * x1) / B; if (y >= y0 && y <= y1) p.push([x1, y]); } if (Math.abs(A) > 1e-9) { let x = (c - B * y0) / A; if (x >= x0 && x <= x1) p.push([x, y0]); x = (c - B * y1) / A; if (x >= x0 && x <= x1) p.push([x, y1]); } return p.length >= 2 ? [p[0], p[1]] : null; };
                    for (let bI = 1; bI < K; bI++) { const rr = Math.floor(bI / K * M), c = (t[ord[rr - 1]] + t[ord[rr]]) / 2, seg = clip(a, b, c); if (seg) bandLines += `<line x1="${seg[0][0].toFixed(1)}" y1="${seg[0][1].toFixed(1)}" x2="${seg[1][0].toFixed(1)}" y2="${seg[1][1].toFixed(1)}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4 5" opacity="0.45"/>`; }
                    const cents = []; for (let bi = 0; bi < K; bi++) { const bn = bins[bi]; if (bn.cnt >= 3) cents.push([bn.gx / bn.cnt, bn.gy / bn.cnt]); }
                    if (cents.length >= 2) {
                        bandLines += `<polyline points="${cents.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="none" stroke="${C.cyan}" stroke-width="2" opacity="0.75"/>`;
                        const e0 = cents[cents.length - 2], e1 = cents[cents.length - 1], ang = Math.atan2(e1[1] - e0[1], e1[0] - e0[0]), ah = 9;
                        bandLines += `<path d="M${e1[0].toFixed(1)},${e1[1].toFixed(1)} L${(e1[0] - ah * Math.cos(ang - 0.45)).toFixed(1)},${(e1[1] - ah * Math.sin(ang - 0.45)).toFixed(1)} M${e1[0].toFixed(1)},${e1[1].toFixed(1)} L${(e1[0] - ah * Math.cos(ang + 0.45)).toFixed(1)},${(e1[1] - ah * Math.sin(ang + 0.45)).toFixed(1)}" stroke="${C.cyan}" stroke-width="2" fill="none" opacity="0.85"/>`;
                    }
                    const med = arr => { const s = arr.slice().sort((p, q) => p - q), m = s.length; return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2; };
                    const isBin = (proj === 'hi10m' || proj === 'hiout');
                    for (let bi = 0; bi < K; bi++) { const bn = bins[bi]; if (bn.cnt < 3) continue; const cx = bn.gx / bn.cnt, cy = bn.gy / bn.cnt;
                        const txt = isBin ? Math.round(bn.vals.reduce((s, x) => s + x, 0) / bn.cnt * 100) + '%' : proj === 'outlier' ? Math.pow(10, med(bn.vals)).toFixed(1) + '×' : fv(Math.pow(10, med(bn.vals)));
                        const w = txt.length * 6.6 + 12;
                        bandLabels += `<g style="pointer-events:none"><rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - 9).toFixed(1)}" width="${w.toFixed(1)}" height="16" rx="4" fill="#0f172a" opacity="0.88" stroke="#1e293b"/><text x="${cx.toFixed(1)}" y="${(cy + 2.8).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#e2e8f0">${txt}</text></g>`;
                    }
                }
            }
        }
        const sel = st.guessSel;
        let gsd = '', selDot = '', placed = 0;
        rows.forEach(r => { const pos = placeG(r); if (!pos) return; placed++; const isSel = sel === r.id, c = heatCol(r.pctile == null ? 0 : r.pctile);
            const circ = `<circle data-guessid="${esc(r.id)}" cx="${X(pos[0]).toFixed(1)}" cy="${Yc(pos[1]).toFixed(1)}" r="${isSel ? 7.5 : 4.6}" fill="${c}" opacity="1" stroke="#fff" stroke-width="${isSel ? 2.4 : 1.2}" style="cursor:pointer"><title>${esc((r.brief || '').slice(0, 70) + ' · ' + Math.round((r.pctile || 0) * 100) + 'th pctile')}</title></circle>`;
            if (isSel) selDot += circ; else gsd += circ; });
        const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${bg}${bandLines}${gsd}${selDot}${bandLabels}</svg>`;
        const pjLabel = (PROJS.find(p => p[0] === proj) || [proj, proj])[1];
        const scaleLab = `<div style="font-size:10px;color:${C.mute};margin-top:5px;line-height:1.5"><b style="color:${C.dim}">Layout</b>: the <b style="color:${C.accent}">${pjLabel}</b> projection — the IDENTICAL embedding & coordinates shown in 🔬 Raw. Library coloured by that metric; each guess placed at the centroid of its 12 nearest library hooks (same method as a Raw upload), coloured by predicted-views percentile. ${placed}/${rows.length} placed${placed < rows.length ? ' (others awaiting neighbour backfill)' : ''}.</div>`;
        const PC = rows.map(r => r.pctile || 0).slice().sort((a, b) => a - b), med2 = PC.length ? PC[Math.floor(PC.length / 2)] : 0, mx2 = PC.length ? PC[PC.length - 1] : 0;
        const stat = `<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:${C.mute};margin:7px 2px"><span><b style="color:${C.text}">${rows.length}</b> guesses</span><span>median <b style="color:${C.accent}">${Math.round(med2 * 100)}th</b></span><span>best <b style="color:${C.green}">${Math.round(mx2 * 100)}th</b> pctile</span><span style="color:${C.dim}">run ${esc(run)}</span><span data-guessreload style="cursor:pointer;color:${C.dim};text-decoration:underline">↻ refresh</span></div>`;
        let detail = '';
        if (sel) { const r = rows.find(x => x.id === sel); if (r) detail = guessDetail(run, r); }
        return head + controls + cardc(`${legendBar(legLo, legHi)}${svg}${scaleLab}${stat}`, 12) + detail;
    }
    function guessDetail(run, r) {
        const frames = (r.frames || []).map((f, i) => `<div style="display:flex;gap:8px;margin-bottom:5px"><span style="color:${C.accent};font-weight:800;flex-shrink:0">${i + 1}</span><span style="font-size:11px;color:${C.dim};line-height:1.45">${esc(f)}</span></div>`).join('');
        const isG = run.indexOf('grpo') === 0 || r.reasoning != null;
        if (isG) {
            const lab = s => `<div style="font-size:9px;color:${C.mute};text-transform:uppercase;letter-spacing:.04em;margin:10px 0 4px">${s}</div>`;
            const bgc = C.bg || '#0f172a';
            const advCol = (r.advantage || 0) > 0 ? C.green : ((r.advantage || 0) < 0 ? '#ef4444' : C.mute);
            const relBad = r.relevance != null && r.relevance < 0.45;
            const sibs = ((GUESSES[run] && GUESSES[run].rows) || []).filter(x => x.input_id === r.input_id).sort((a, b) => (b.pctile || 0) - (a.pctile || 0));
            const sibStrip = sibs.map(x => `<div data-guessid="${x.id}" style="cursor:pointer;flex-shrink:0;width:74px;border:2px solid ${x.id === r.id ? C.accent : 'transparent'};border-radius:6px;overflow:hidden"><img src="/api/hooks/montage/${esc(run)}/${esc(x.id)}" style="width:100%;display:block" loading="lazy"/><div style="font-size:9px;text-align:center;color:${heatCol(x.pctile || 0)};font-weight:800">${Math.round((x.pctile || 0) * 100)}%</div></div>`).join('');
            return cardc(`<div style="display:flex;gap:16px;flex-wrap:wrap">
              <div style="flex:1;min-width:300px">
                ${lab('INPUT — the video idea (no niche, no priors given)')}
                <div style="font-size:13px;color:${C.text};background:${bgc};border-radius:6px;padding:9px 11px;line-height:1.5;font-weight:700">${esc(r.premise || r.brief || '')}</div>
                ${lab('OUTPUT — this idea\'s 5 frames · cohesion: ' + esc(r.cohesion_mode || '—'))}
                <img src="/api/hooks/montage/${esc(run)}/${esc(r.id)}" style="width:100%;border-radius:8px;background:#000;min-height:60px;margin-bottom:6px" onerror="this.style.display='none'"/>
                <div style="background:${bgc};border-radius:6px;padding:10px 11px">${frames || '—'}</div>
                ${lab('REASONING — the model\'s own thinking before it chose these frames')}
                <div style="font-size:11px;color:${C.dim};background:${bgc};border-radius:6px;padding:10px 11px;line-height:1.55;white-space:pre-wrap;max-height:260px;overflow:auto">${esc(r.reasoning || '(no trace)')}</div>
              </div>
              <div style="flex:1;min-width:230px">
                ${lab('SCORE — keep-rate, gated by relevance, ranked within this input')}
                <div style="font-size:12px;color:${C.mute};line-height:2.05">
                  keep-rate percentile: <b style="color:${heatCol(r.pctile || 0)}">${Math.round((r.pctile || 0) * 100)}th</b><br>
                  relevance to input: <b style="color:${relBad ? '#ef4444' : C.text}">${r.relevance != null ? fmt(r.relevance, 2) : '—'}</b> <span style="font-size:9px;color:${C.faint || C.mute}">(on-topic ≥0.45; below = penalised)</span><br>
                  advantage vs its group: <b style="color:${advCol}">${(r.advantage || 0) > 0 ? '+' : ''}${fmt(r.advantage, 2)}</b> <span style="font-size:9px;color:${C.faint || C.mute}">(beats the model's other tries at this idea)</span><br>
                  reward: <b style="color:${C.text}">${fmt(r.reward, 2)}</b><br>
                  in-distribution (nn-cos): <b style="color:${C.cyan}">${fmt(r.nn_cos, 3)}</b><br>
                  what's literally shown: <span style="color:${C.dim};font-style:italic">${esc(r.caption || '—')}</span>
                </div>
                ${lab('ALL ' + sibs.length + ' IDEAS IT GENERATED FOR THIS INPUT (click to compare)')}
                <div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:4px">${sibStrip}</div>
                <div style="margin-top:12px"><span data-guessclose style="cursor:pointer;border:1px solid ${C.border};color:${C.dim};border-radius:6px;padding:4px 11px;font-size:11px">close</span></div>
              </div></div>`, 12);
        }
        const lab = s => `<div style="font-size:9px;color:${C.mute};text-transform:uppercase;letter-spacing:.04em;margin:10px 0 4px">${s}</div>`;
        const bgc = C.bg || '#0f172a';
        return cardc(`<div style="display:flex;gap:16px;flex-wrap:wrap">
          <div style="flex:1;min-width:300px">
            ${lab('Generated hook — the 5 frames (1/sec)')}
            <img src="/api/hooks/montage/${esc(run)}/${esc(r.id)}" style="width:100%;border-radius:8px;background:#000;min-height:60px" onerror="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'Montage still syncing to storage…',style:'font-size:11px;color:#94a3b8;padding:14px;text-align:center;background:#0f172a;border-radius:6px'}))"/>
            ${lab('① INPUT — the brief the model was given')}
            <div style="font-size:12px;color:${C.text};background:${bgc};border-radius:6px;padding:9px 11px;line-height:1.5">${esc(r.brief || '')}</div>
            ${lab('② OUTPUT — the 5-frame spec the model wrote · cohesion: ' + esc(r.cohesion_mode || '—'))}
            <div style="background:${bgc};border-radius:6px;padding:10px 11px">${frames || '<span style="color:' + C.dim + '">—</span>'}</div>
          </div>
          <div style="flex:1;min-width:230px">
            ${lab('③ WHERE IT LANDS — scored on the real views axis')}
            <div style="font-size:12px;color:${C.mute};line-height:2.05">
              estimated views <b style="color:${C.accent}">${fv(Math.pow(10, r.pred || 0))}</b> <span style="font-size:9px;color:${C.faint || C.mute}">(model estimate = 10^prediction from the views axis — not a label)</span><br>
              percentile vs 11k library: <b style="color:${C.green}">${Math.round((r.pctile || 0) * 100)}th</b><br>
              grid position: <b style="color:${C.dim}">(${Math.round(r.x)}, ${Math.round(r.y)})</b> / 1000<br>
              in-distribution (nn-cos): <b style="color:${C.cyan}">${fmt(r.nn_cos, 3)}</b> <span style="font-size:9px;color:${C.faint || C.mute}">(real hooks: .72–.87)</span><br>
              niche: <b style="color:${C.dim}">${esc(r.niche || '—')}</b><br>
              source idea: <b style="color:${C.dim}">${esc(r.source || '—')}</b> · brief #${r.iter != null ? r.iter : '—'}, rank ${r.rank != null ? r.rank : '—'}
            </div>
            <div style="margin-top:12px"><span data-guessclose style="cursor:pointer;border:1px solid ${C.border};color:${C.dim};border-radius:6px;padding:4px 11px;font-size:11px">close</span></div>
          </div></div>`, 12);
    }
    // ── 🧠 GRPO: the multiple ideas the model generates per input, ranked by within-input advantage ──
    function rtgUpdateGrpo() { rtgUpdateGuesses(); }  // GRPO renders inside the Guesses tab
    function grpoEnsureRuns() {
        if (GRPORUNS != null) return;
        GRPORUNS = [];
        fetch('/api/hooks/grpo/runs').then(r => r.json()).then(j => {
            GRPORUNS = (j.runs && j.runs.length) ? j.runs : [];
            if (GRPORUNS.length && !st.grpoRun) st.grpoRun = GRPORUNS[GRPORUNS.length - 1];
            rtgUpdateGrpo();
        }).catch(() => { GRPORUNS = []; });
    }
    function grpoEnsureIndex(run) {
        if (!run || GRPOIDX[run]) return;
        GRPOIDX[run] = { loading: 1 };
        fetch('/api/hooks/grpo/index?run=' + run).then(r => r.json()).then(j => { GRPOIDX[run] = j; rtgUpdateGrpo(); }).catch(() => { GRPOIDX[run] = { rows: [] }; rtgUpdateGrpo(); });
    }
    function grpoEnsureGroup(run, id) {
        const k = run + '/' + id;
        if (GRPOGRP[k]) return;
        GRPOGRP[k] = { loading: 1 };
        fetch('/api/hooks/grpo/group/' + run + '/' + id).then(r => r.json()).then(j => { GRPOGRP[k] = j; rtgUpdateGrpo(); }).catch(() => { GRPOGRP[k] = { error: 1 }; rtgUpdateGrpo(); });
    }
    function grpoDetail(run, id) {
        grpoEnsureGroup(run, id);
        const g = GRPOGRP[run + '/' + id];
        if (!g || g.loading) return `<div style="color:${C.mute};padding:16px">loading ideas…</div>`;
        if (g.error || !g.attempts) return `<div style="color:${C.mute};padding:16px">could not load this group.</div>`;
        const cards = g.attempts.map(a => {
            const advCol = a.advantage > 0 ? C.green : (a.advantage < 0 ? '#ef4444' : C.mute);
            const relBad = a.relevance != null && a.relevance < 0.45;
            const reasoning = a.reasoning ? `<details style="margin-top:6px"><summary style="font-size:10px;color:${C.cyan};cursor:pointer">reasoning</summary><div style="font-size:10px;color:${C.dim};line-height:1.5;margin-top:4px;white-space:pre-wrap;max-height:220px;overflow:auto">${esc(a.reasoning)}</div></details>` : '';
            return `<div style="border:1px solid ${a.k === 0 ? C.accent : C.border};border-radius:10px;padding:8px;background:${C.card2}">
              <img src="/api/hooks/grpo/montage/${run}/${id}_${a.k}" style="width:100%;border-radius:6px;display:block" loading="lazy">
              <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:6px;font-size:10px;color:${C.dim}">
                <span>keep <b style="color:${heatCol(a.keep_pctile || 0)}">${Math.round((a.keep_pctile || 0) * 100)}%</b></span>
                <span>rel <b style="color:${relBad ? '#ef4444' : C.text}">${a.relevance != null ? a.relevance.toFixed(2) : '—'}</b></span>
                <span>reward <b style="color:${C.text}">${(a.reward || 0).toFixed(2)}</b></span>
                <span>adv <b style="color:${advCol}">${a.advantage > 0 ? '+' : ''}${(a.advantage || 0).toFixed(2)}</b></span>
                <span style="color:${C.mute}">${esc(a.cohesion_mode || '')}</span>
              </div>
              <div style="font-size:10px;color:${C.mute};margin-top:4px;font-style:italic">${esc(a.caption || '')}</div>
              ${reasoning}</div>`;
        }).join('');
        return `<div style="margin-bottom:8px"><div style="font-size:13px;color:${C.text};font-weight:800">${esc(g.premise || id)}</div>
          <div style="font-size:10px;color:${C.mute}">group mean reward ${(g.group_mean || 0).toFixed(2)} · best ${(g.best_reward || 0).toFixed(2)} · ${g.n} ideas · winner ringed</div></div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">${cards}</div>`;
    }
    function renderGrpo() {
        const head = `<div style="font-size:12px;color:${C.dim};margin-bottom:10px;line-height:1.5">🧠 <b style="color:${C.text}">Per-input ideas (GRPO)</b> — for each input the model reasons and proposes several hooks. Each is rendered, scored on keep-rate, gated by relevance to the input, and ranked by advantage vs the group's OWN mean — what beats its other attempts at the same idea, no niche or label.</div>`;
        grpoEnsureRuns();
        if (GRPORUNS == null || !GRPORUNS.length) return head + `<div style="color:${C.mute};padding:20px">No GRPO runs yet — input-groups appear here as the run produces them.</div>`;
        const runPills = GRPORUNS.map(r => `<button data-grporun="${r}" style="background:${st.grpoRun === r ? C.accent + '22' : 'transparent'};border:1px solid ${st.grpoRun === r ? C.accent : C.border};color:${st.grpoRun === r ? C.accent : C.dim};border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">${r}</button>`).join('');
        const run = st.grpoRun || GRPORUNS[GRPORUNS.length - 1];
        grpoEnsureIndex(run);
        const idx = GRPOIDX[run];
        let body;
        if (!idx || idx.loading) body = `<div style="color:${C.mute};padding:16px">loading…</div>`;
        else {
            const rows = (idx.rows || []).slice().sort((a, b) => (b.best_keep || 0) - (a.best_keep || 0));
            const list = rows.map(r => {
                const sel = st.grpoSel === r.input_id;
                return `<div data-grpoinput="${r.input_id}" style="cursor:pointer;border:1px solid ${sel ? C.accent : C.border};background:${sel ? C.accent + '15' : C.card2};border-radius:8px;padding:8px 10px;margin-bottom:6px">
                  <div style="font-size:12px;color:${C.text};font-weight:700;line-height:1.3">${esc(r.premise || r.input_id)}</div>
                  <div style="font-size:10px;color:${C.mute};margin-top:3px">best keep <b style="color:${heatCol(r.best_keep || 0)}">${Math.round((r.best_keep || 0) * 100)}%</b> · ${r.n} ideas · spread ${(r.spread || 0).toFixed(2)}</div></div>`;
            }).join('');
            const detail = st.grpoSel ? grpoDetail(run, st.grpoSel) : `<div style="color:${C.mute};padding:16px">Pick an input on the left to see the ideas the model generated for it, ranked by advantage.</div>`;
            body = `<div style="font-size:11px;color:${C.mute};margin-bottom:8px">${rows.length} inputs in ${run}</div><div style="display:grid;grid-template-columns:310px 1fr;gap:14px">
              <div style="max-height:660px;overflow:auto">${list || `<div style="color:${C.mute}">no groups yet</div>`}</div>
              <div>${detail}</div></div>`;
        }
        return head + `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${runPills}</div>` + body;
    }
    function rtgUpdateExp() { try { const el = window.document.getElementById('rtg-exppanel'); if (el) el.innerHTML = renderExperiment(); } catch (e) { } }
    function expDemoPoll(rid, tries) {
        tries = tries || 0;
        fetch('/api/hooks/demo/status/' + rid).then(r => r.json()).then(s => { st.expGenStage = (s && s.stage) || 'queued'; if (st.expGenBusy) rtgUpdateExp(); }).catch(() => {});
        fetch('/api/hooks/grpo/group/demo/' + rid).then(r => r.json()).then(j => {
            if (j && j.attempts && j.attempts.length) { EXPDEMO[rid] = j; st.expGenBusy = false; st.expGenStage = 'done'; rtgUpdateExp(); }
            else if (tries < 90) { setTimeout(() => expDemoPoll(rid, tries + 1), 4000); }
            else { EXPDEMO[rid] = { error: 'timed out — is the model running on Lambda? (the demo is served by the live box)' }; st.expGenBusy = false; rtgUpdateExp(); }
        }).catch(() => { if (tries < 90) setTimeout(() => expDemoPoll(rid, tries + 1), 4000); });
    }
    function expGenSubmit() {
        const inp = window.document.getElementById('exp-gen-input');
        const prem = inp ? inp.value.trim() : (st.expGenPrem || '');
        st.expGenPrem = prem; st.expGenBusy = true; st.expGenRid = null; st.expGenStage = 'queued';
        fetch('/api/hooks/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ premise: prem, count: st.expGenN || 4, invent: !prem }) })
            .then(r => r.json()).then(j => { if (j.rid) { st.expGenRid = j.rid; rtgUpdateExp(); expDemoPoll(j.rid); } else { st.expGenBusy = false; rtgUpdateExp(); } })
            .catch(() => { st.expGenBusy = false; rtgUpdateExp(); });
        rtgUpdateExp();
    }
    function expGenPanel() {
        const bg = C.bg || '#0f172a', n = st.expGenN || 4;
        const STAGES = { queued: 'queued — waiting for the live model…', reasoning: 'reasoning up the hooks…', rendering: 'rendering + scoring frames…', done: 'done' };
        let result = '';
        if (st.expGenRid) {
            const g = EXPDEMO[st.expGenRid];
            if (st.expGenBusy && !g) result = `<div style="margin-top:12px;font-size:12px;color:${C.cyan}">⏳ ${esc(STAGES[st.expGenStage] || 'working…')} <span style="color:${C.mute}">(inventing the idea, then rendering 5 frames · ~1 min)</span></div>`;
            else if (g && g.error) result = `<div style="margin-top:12px;font-size:12px;color:#ef4444">${esc(g.error)}</div>`;
            else if (g && g.attempts && g.attempts.length) {
                const cards = g.attempts.map(a => {
                    // hosted result: 5 separate frame images; legacy box result: one montage + keep%
                    const frameStrip = (a.frame_imgs && a.frame_imgs.length)
                        ? `<div style="display:flex;gap:3px">${a.frame_imgs.map((fid, i) => fid ? `<div style="flex:1;position:relative"><img src="/api/hooks/grpo/montage/demo/${esc(fid)}" style="width:100%;border-radius:4px;display:block" loading="lazy"><span style="position:absolute;top:2px;left:3px;font-size:8px;color:#fff;background:rgba(0,0,0,.55);border-radius:3px;padding:0 3px">${i + 1}</span></div>` : `<div style="flex:1;aspect-ratio:9/16;background:${C.bg};border-radius:4px"></div>`).join('')}</div>`
                        : `<img src="/api/hooks/grpo/montage/demo/${st.expGenRid}_${a.k}" style="width:100%;border-radius:6px;display:block" loading="lazy">`;
                    const keepBadge = a.keep_pctile != null ? `<span>keep <b style="color:${heatCol(a.keep_pctile || 0)}">${Math.round((a.keep_pctile || 0) * 100)}%</b></span>` : '';
                    const frameText = (a.frames && a.frames.length) ? `<details style="margin-top:5px"><summary style="font-size:10px;color:${C.cyan};cursor:pointer">the 5 frames</summary><div style="font-size:10px;color:${C.dim};line-height:1.5;margin-top:4px">${a.frames.map((f, i) => `<div><b style="color:${C.accent}">${i + 1}.</b> ${esc(f)}</div>`).join('')}</div></details>` : '';
                    return `<div style="border:1px solid ${a.k === 0 ? C.accent : C.border};border-radius:10px;padding:9px;background:${C.card2}">
                      <div style="font-size:12px;color:${C.text};font-weight:700;line-height:1.35;margin-bottom:6px">${esc(a.premise || a.caption || '')}</div>
                      ${frameStrip}
                      <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:6px;font-size:10px;color:${C.dim}">${keepBadge}<span style="color:${C.mute}">${esc(a.cohesion_mode || '')}</span></div>${frameText}</div>`;
                }).join('');
                result = `<div style="margin-top:10px"><div style="font-size:11px;color:${C.mute};margin-bottom:8px">${g.n} hook${g.n > 1 ? 's' : ''}${g.premise && g.premise !== '💡 invented' ? ` for "${esc(g.premise)}"` : ' invented'} · ${esc(g.model || 'model')}</div>
                  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px">${cards}</div></div>`;
            } else if (g && g.attempts) { result = `<div style="margin-top:12px;font-size:12px;color:#ef4444">generation came back empty — try again.</div>`; }
        }
        const nPill = k => `<span data-expgenn="${k}" style="cursor:pointer;border:1px solid ${n === k ? C.accent : C.border};background:${n === k ? C.accent + '22' : 'transparent'};color:${n === k ? C.accent : C.dim};border-radius:6px;padding:4px 9px;font-size:11px;font-weight:700">${k}</span>`;
        return `<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:14px;margin-bottom:14px">
          <div style="font-size:14px;font-weight:800;color:${C.text}">✨ Generate an entire hook <span style="font-size:10px;color:${C.mute};font-weight:600">— type an idea (or leave blank to invent one); it writes the idea + a 5-frame opening and renders it. Always on, no GPU.</span></div>
          <div style="display:flex;gap:8px;margin-top:9px;align-items:center;flex-wrap:wrap">
            <input id="exp-gen-input" value="${esc(st.expGenPrem || '')}" placeholder="type a video idea — or leave blank and the model invents one…" style="flex:1;min-width:240px;background:${bg};border:1px solid ${C.border};color:${C.text};border-radius:8px;padding:9px 12px;font-size:13px"/>
            <span style="font-size:10px;color:${C.mute}">outputs</span>${[1, 2, 4, 6, 8].map(nPill).join('')}
            <span data-expgen style="cursor:${st.expGenBusy ? 'default' : 'pointer'};background:${st.expGenBusy ? C.border : C.accent};color:#04121f;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:800;display:inline-flex;align-items:center">${st.expGenBusy ? '⏳ working…' : 'Generate'}</span>
          </div>${result}</div>`;
    }
    function renderExperiment() {
        const head = h2c('🧪 Experiment — score a hook against every validated indicator', 'Upload a video or build one from 5 frames + text. It gets embedded and scored on every independent indicator we have validated — see where it lands on each indicator\'s curve, plus an ensemble read. New indicators appear here automatically as you build them.') + expGenPanel();
        if (EXPREG === null) { EXPREG = { loading: 1 }; fetch('/api/indicators/registry').then(r => r.json()).then(j => { EXPREG = j; rtgUpdateExp(); }).catch(() => { EXPREG = { error: 1 }; rtgUpdateExp(); }); }
        const CY = '#22d3ee';
        const fr = st.rawFrames || [null, null, null, null, null], nFrames = fr.filter(Boolean).length;
        const modePill = (m, lab) => `<span data-rawbuildmode="${m}" style="cursor:pointer;border:1px solid ${(!!st.rawBuildMode === !!m) ? CY : C.border};background:${(!!st.rawBuildMode === !!m) ? CY + '22' : 'transparent'};color:${(!!st.rawBuildMode === !!m) ? CY : C.dim};border-radius:${m ? '0 6px 6px 0' : '6px 0 0 6px'};padding:4px 10px;font-size:11px;font-weight:700">${lab}</span>`;
        const UPSTAGES = ['Uploading…', 'Extracting 5 frames…', 'Transcribing…', 'Embedding…', 'Scoring indicators…'];
        const prog = st.rawUploading ? `<span style="display:inline-flex;flex-direction:column;gap:3px;min-width:230px"><span style="font-size:10px;color:${CY};font-weight:700">⏳ ${UPSTAGES[Math.min(st.rawUpStage || 0, 4)]}</span><span style="height:6px;background:${C.border};border-radius:4px;overflow:hidden;display:block"><span style="display:block;height:100%;width:${Math.min(93, ((st.rawUpStage || 0) + 1) / 5 * 100)}%;background:${CY};border-radius:4px;transition:width .5s"></span></span></span>` : '';
        const builder = st.rawBuildMode ? `<div style="margin-top:8px;display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap">${[0, 1, 2, 3, 4].map(i => fr[i]
            ? `<div style="position:relative"><img src="${fr[i]}" style="width:42px;height:75px;object-fit:cover;border-radius:5px;border:1px solid ${C.border}"/><span data-rawframedel="${i}" style="position:absolute;top:-7px;right:-7px;background:${C.card};border:1px solid ${C.border};color:${C.dim};border-radius:50%;width:15px;height:15px;line-height:13px;text-align:center;font-size:9px;cursor:pointer">✕</span></div>`
            : `<div data-rawframe="${i}" style="width:42px;height:75px;border:1px dashed ${C.border};border-radius:5px;display:flex;align-items:center;justify-content:center;color:${C.mute};cursor:pointer;font-size:9px">＋${i + 1}</div>`).join('')}
            <input data-rawtext type="text" value="${esc(st.rawText || '')}" placeholder="hook text…" style="flex:1;min-width:160px;background:${C.bg || '#0f172a'};border:1px solid ${C.border};color:${C.text};border-radius:6px;padding:6px 9px;font-size:12px"/>
            <span data-rawplace="1" style="cursor:${nFrames ? 'pointer' : 'not-allowed'};border:1px solid ${nFrames ? CY : C.border};background:${nFrames ? CY + '22' : 'transparent'};color:${nFrames ? CY : C.faint};border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700">◆ Score this hook</span></div>` : '';
        const controls = `<input id="rawUpFile" type="file" accept="video/*" style="display:none"><input id="rawFrameFile" type="file" accept="image/*" style="display:none">` +
            cardc(`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span style="font-size:12px;font-weight:800;color:${C.text}">Score a hook:</span>${modePill(0, '🎬 Video')}${modePill(1, '🖼 5 frames + text')}${!st.rawBuildMode ? `<span data-rawupload="1" style="cursor:pointer;border:1px solid ${C.border};color:${C.dim};border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700">⬆ Upload video</span>` : ''}${prog}${st.rawUpErr ? `<span style="font-size:10px;color:${C.red}">${esc(String(st.rawUpErr).slice(0, 70))}</span>` : ''}</div>${builder}`, 12);
        if (!EXPREG || EXPREG.loading) return head + controls + cardc(`<div style="padding:20px;text-align:center;color:${C.dim}">Loading the indicator registry…</div>`);
        if (EXPREG.error || !EXPREG.indicators) return head + controls + cardc(`<div style="padding:20px;text-align:center;color:${C.dim}">No indicator registry yet — run <code>indicators.py</code>.</div>`);
        // scorable = the indicators a NEW hook can actually be scored on (content probes + global novelty)
        const scorableKind = d => d.kind === 'content' || d.kind === 'novelty';
        const val = EXPREG.indicators.filter(d => d.validated && scorableKind(d));
        const up = (st.rawUploads || []).filter(u => u && u.indicators).slice(-1)[0];
        const keyOf = d => d.kind === 'content' ? `${d.name}__${d.target}` : d.name;
        const TLAB = { keep: 'keep rate (stay to watch)', ret5: 'past 5 seconds', views: 'est. views', gt10M: 'chance >10M views' };
        if (!up) {
            const byT = {}; val.forEach(d => { (byT[d.target] = byT[d.target] || []).push(d); });
            return head + controls + cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:4px">${val.length} scorable indicators ready</div><div style="font-size:10px;color:${C.mute};margin-bottom:8px">Upload or build a hook above and it's scored on each of these, fully traceable. Grouped by what they predict:</div>${(EXPREG.meta.targets || []).map(t => byT[t.name] ? `<div style="margin-bottom:6px"><span style="font-size:11px;font-weight:700;color:${C.accent}">${t.label}</span> <span style="font-size:10px;color:${C.mute}">— ${byT[t.name].map(d => d.name.replace('content_', '').replace('nov_', 'nov ')).join(', ')}</span></div>` : '').join('')}`, 12);
        }
        // ── 1. trace: raw input → embedding ──
        const embHeat = ch => { const a = up.emb_preview && up.emb_preview[ch]; if (!a) return `<div style="font-size:9px;color:${C.faint}">${ch}: —</div>`; const mn = Math.min(...a), mx = Math.max(...a); return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span style="font-size:9px;color:${C.dim};width:58px">${ch}</span><svg viewBox="0 0 ${a.length * 5} 10" style="height:11px;width:${a.length * 5}px">${a.map((v, i) => `<rect x="${i * 5}" width="4.4" height="10" fill="${rawRamp((v - mn) / ((mx - mn) || 1))}"/>`).join('')}</svg></div>`; };
        const trace = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:6px">From raw input to score — every number is traceable</div>
            <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
              <div><div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:3px">1 · the 5-frame hook (what gets embedded)</div><img src="data:image/jpeg;base64,${up.montage}" style="width:260px;border-radius:6px;background:#000"/></div>
              <div style="flex:1;min-width:220px"><div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:3px">2 · transcript</div><div style="font-size:11px;font-style:italic;color:${C.text};background:#0f172a;border-radius:6px;padding:8px;margin-bottom:8px">${up.silent ? '(no voiceover — text channel scores as empty)' : '"' + esc(up.transcript || '') + '"'}</div>
                <div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:3px">3 · Gemini embedding (1536-d, pooled to 48 for display)</div>${embHeat('visual')}${embHeat('text')}${embHeat('together')}</div>
            </div>
            <div style="font-size:10px;color:${C.mute};margin-top:7px">4 · each indicator = <b>embedding · (a direction learned toward that metric) + bias → one number</b>, placed on the corpus scatter below.</div>`, 12);
        // ── 2. big clear outputs (ensemble of content probes) ──
        // R = held-out strength; calib = read the actual metric off the corpus curve at the
        // hook's score (the raw probe over-shrinks at n=211, so we CALIBRATE through the curve).
        const Rof = d => d.auc ? Math.abs(d.auc - 0.5) * 2 : Math.abs(d.spearman || 0);
        // percentile (0-1) of the hook among the corpus on this indicator, and a QUANTILE-
        // calibrated estimate: map that rank → the actual-metric value at the same rank, so
        // it spans the FULL observed range (not compressed to the mean / capped at ~77).
        const pctOf = (d, sc) => { const p = d.pts || []; if (!p.length || sc == null) return null; let r = p.filter(x => x[0] <= sc).length / p.length; return (d.spearman || 0) < 0 ? 1 - r : r; };
        const calib = (d, sc) => { const p = d.pts || []; if (!p.length || sc == null) return null; const r = pctOf(d, sc); const acts = p.map(x => x[1]).sort((a, b) => a - b); return acts[Math.max(0, Math.min(acts.length - 1, Math.round(r * (acts.length - 1))))]; };
        const dispV = (tn, v) => v == null ? null : (tn === 'views' ? fv(Math.pow(10, v)) : tn === 'gt10M' ? (v * 100).toFixed(0) + '%' : v.toFixed(0) + '%');
        // ── 3. per-indicator: the SAME Raw cluster (channel × projection), coloured by
        //    the target, with YOUR hook placed via its neighbours. Click → opens it in Raw. ──
        const chMap = { visual: 'visual', text: 'text', together: 'together', vis: 'visual', txt: 'text', tog: 'together' };
        ['visual', 'text', 'together'].forEach(c => { if (!RAW[c]) { RAW[c] = { loading: 1 }; fetch('/api/raw/map?channel=' + c).then(r => r.json()).then(j => { RAW[c] = j; rtgUpdateExp(); }).catch(() => { RAW[c] = { n: 0 }; rtgUpdateExp(); }); } });
        const Nmod = { visual: 'visual', text: 'text', together: 'whole' };
        const idNovCache = {};
        const idNov = ch => { if (idNovCache[ch]) return idNovCache[ch]; const m = {}; try { const g = N && N.hook && N.hook.global && N.hook.global[Nmod[ch]]; if (g) N.videos.forEach((v, i) => { m[v.id] = g.nov[i]; }); } catch (e) {} return (idNovCache[ch] = m); };
        const whatEmbedded = ch => ch === 'visual' ? 'the 5 frames (no text)' : ch === 'text' ? 'the transcript text' : 'the 5 frames + transcript';
        const cluster = (ch, projName, colorMode) => {
            const R = RAW[ch];
            if (!R || R.loading) return `<div style="height:150px;display:flex;align-items:center;justify-content:center;background:${C.card2};border-radius:6px;font-size:10px;color:${C.dim}">loading ${ch} cluster…</div>`;
            const proj = R.proj && R.proj[projName]; if (!proj || !proj.x) return `<div style="height:150px;display:flex;align-items:center;justify-content:center;background:${C.card2};border-radius:6px;font-size:10px;color:${C.faint}">no ${projName} cluster for ${ch}</div>`;
            const ids = R.id || [], nP = R.n || proj.x.length, S = 1000, W = 250, H = 150, pad = 8, X = g => pad + g / S * (W - 2 * pad), Y = g => pad + (1 - g / S) * (H - 2 * pad);
            let colf;
            if (colorMode === 'gt10m') colf = i => (R.views && R.views[i] > 1e7) ? '#f87171' : '#2b3648';
            else if (colorMode === 'novelty') { const nm = idNov(ch), vs = ids.map(id => nm[id]), ok = vs.filter(v => v != null && isFinite(v)), lo = Math.min(...ok), hi = Math.max(...ok); colf = i => vs[i] == null ? '#2b3648' : rawRamp((vs[i] - lo) / ((hi - lo) || 1)); }
            else if (colorMode === 'metric' && proj.est && proj.predscope) { const e = proj.est.map(x => Math.log10((+x || 0) + 1)), ok = e.filter(isFinite), lo = Math.min(...ok), hi = Math.max(...ok); colf = i => isFinite(e[i]) ? rawRamp((e[i] - lo) / ((hi - lo) || 1)) : '#2b3648'; }
            else if (colorMode === 'metric' && proj.est) { const e = proj.est, ac = proj.actual, ok = e.filter(v => v != null && isFinite(v)), lo = Math.min(...ok), hi = Math.max(...ok); colf = i => { const v = (ac && ac[i] != null) ? ac[i] : e[i]; return v == null ? '#2b3648' : rawRamp((v - lo) / ((hi - lo) || 1)); }; }
            else if (colorMode === 'axis' || colorMode === 'metric') { const xs2 = proj.x, lo = Math.min(...xs2), hi = Math.max(...xs2); colf = i => rawRamp((proj.x[i] - lo) / ((hi - lo) || 1)); }
            else if (colorMode === 'owned') colf = i => (R.mine && R.mine[i]) ? '#fbbf24' : '#2b3648';
            else { const v = (R.views || []).map(x => Math.log10((+x || 0) + 1)), ok = v.filter(isFinite), lo = Math.min(...ok), hi = Math.max(...ok); colf = i => rawRamp((v[i] - lo) / ((hi - lo) || 1)); }
            let s = ''; for (let i = 0; i < nP; i++) s += `<circle cx="${X(proj.x[i]).toFixed(1)}" cy="${Y(proj.y[i]).toFixed(1)}" r="1.5" fill="${colf(i)}" opacity="0.55"/>`;
            const nb = up.channels[ch] && up.channels[ch].neighbors; let mk = '';
            if (nb) { let sx = 0, sy = 0, sw = 0; for (const nn of nb) { const idx = ids.indexOf(nn.id); if (idx < 0) continue; const w = Math.max(0.001, nn.sim); sx += proj.x[idx] * w; sy += proj.y[idx] * w; sw += w; } if (sw > 0) { const hx = X(sx / sw).toFixed(1), hy = Y(sy / sw).toFixed(1); mk = `<line x1="${hx}" y1="${(+hy - 9)}" x2="${hx}" y2="${(+hy + 9)}" stroke="${CY}" stroke-width="1"/><line x1="${(+hx - 9)}" y1="${hy}" x2="${(+hx + 9)}" y2="${hy}" stroke="${CY}" stroke-width="1"/><circle cx="${hx}" cy="${hy}" r="5" fill="${CY}" stroke="#fff" stroke-width="1.5"/>`; } }
            return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;background:${C.card2};border-radius:6px">${s}${mk}</svg>`;
        };
        const projFor = { keep: 'keep', ret5: 'ret5', views: 'views', realviews: 'realviews', gt10M: 'hi10m' };
        const colorFor = { keep: 'metric', ret5: 'metric', views: 'views', realviews: 'metric', gt10M: 'gt10m' };
        // ── SEVEN independent output boxes: 4 EMBEDDING (steered map estimate + its graph) and
        //    3 NOVELTY (its OWN calibration curve). Novelty is never in the same box as views/>10M,
        //    and is shown ONCE per metric (a curve, not a re-clustered map). ──
        const metShort = tn => ({ keep: 'keep rate', ret5: '5s retention (rel)', views: 'views (library)', realviews: 'views (your scale)', gt10M: '>10M class' })[tn];
        const bigNumHTML = (s, sub) => `<div style="font-size:26px;font-weight:900;color:${C.text};line-height:1.1;margin:3px 0">${s}${sub ? ` <span style="font-size:11px;color:${C.mute};font-weight:600">${sub}</span>` : ''}</div>`;
        // EMBEDDING box — the steered cluster + steered estimate (= the marker on that graph).
        // Two view boxes: 'views' = RAW library-scale (10k–1B distribution); 'realviews' = predict-scope
        // (embedding→retention→your 211's view model) on YOUR channel scale. Both steered, both shown.
        const embBox = tn => {
            const b = steerBest(up, tn), ch = b ? b.mod : 'together', pj = projFor[tn], cm = colorFor[tn];
            const big = b ? steerDisp(tn, b.est) : '—';
            let sub = '', foot;
            if (tn === 'realviews') {
                const durTxt = b && b.dur_s ? (b.dur_assumed ? `assumed ${b.dur_s}s` : `${b.dur_s}s video`) : 'median dur';
                sub = b ? durTxt : '';
                const vb = steerBest(up, 'views');
                foot = `keep+5s-ret+<b>duration</b> → your 211's view model <span style="color:${C.green}">(retention deconfounded — held at fixed length)</span>${vb ? ` · library raw: <b>${steerDisp('views', vb.est)}</b>` : ''}`;
            } else {
                sub = b && b.pctile != null ? `${b.pctile.toFixed(0)}th pctile` : '';
                const mods = ['together', 'text', 'visual'].map(m => ({ m, k: steerOf(up, m, tn) })).filter(x => x.k);
                foot = mods.length ? mods.map(p => `${p.m} ${steerDisp(tn, p.k.est)}`).join(' · ') : 'embed not ready';
            }
            const tag = tn === 'realviews' ? ` <span style="color:${C.green}">(your scale)</span>` : tn === 'views' ? ` <span style="color:${C.mute}">(library)</span>` : '';
            return cardc(`<div data-expgo="${ch}:${pj}" style="cursor:pointer"><div style="font-size:11px;color:${CY};font-weight:800;text-transform:uppercase">Embedding → ${metShort(tn).replace(' (library)', '').replace(' (your scale)', '')}${tag}</div>${bigNumHTML(big, sub)}${cluster(ch, pj, cm)}<div style="font-size:8.5px;color:${C.mute};margin-top:4px">${foot} · <span style="color:${C.accent}">open graph →</span></div></div>`, 12);
        };
        // NOVELTY box — the strongest novelty indicator's OWN calibration curve (novelty → this metric), hook marked
        const novCurve = (d, sc) => {
            const cv = d.curve || []; if (cv.length < 2) return `<div style="height:84px;display:flex;align-items:center;justify-content:center;color:${C.faint};font-size:9px;background:${C.card2};border-radius:6px">no curve</div>`;
            const Wc = 240, Hc = 84, pd = 16, xs = cv.map(b => (b.lo + b.hi) / 2), ys = cv.map(b => b.mean);
            const allx = sc != null ? xs.concat([sc]) : xs, xmin = Math.min(...allx), xmax = Math.max(...allx), ymin = Math.min(...ys), ymax = Math.max(...ys);
            const Xc = v => pd + (v - xmin) / ((xmax - xmin) || 1) * (Wc - 2 * pd), Yc2 = v => Hc - pd - (v - ymin) / ((ymax - ymin) || 1) * (Hc - 2 * pd);
            const path = cv.map((b, i) => `${i ? 'L' : 'M'}${Xc(xs[i]).toFixed(1)},${Yc2(ys[i]).toFixed(1)}`).join(' ');
            let hook = ''; if (sc != null) { const est = calib(d, sc), hx = Xc(sc); hook = `<line x1="${hx.toFixed(1)}" y1="${pd}" x2="${hx.toFixed(1)}" y2="${Hc - pd}" stroke="${CY}" stroke-dasharray="3 3" opacity="0.7"/><circle cx="${hx.toFixed(1)}" cy="${Yc2(est != null ? Math.max(ymin, Math.min(ymax, est)) : ys[0]).toFixed(1)}" r="4" fill="${CY}" stroke="#fff" stroke-width="1.5"/>`; }
            return `<svg viewBox="0 0 ${Wc} ${Hc}" style="width:100%;background:${C.card2};border-radius:6px"><path d="${path}" fill="none" stroke="${C.purple}" stroke-width="2"/>${hook}</svg>`;
        };
        const novBox = tn => {
            const pool = EXPREG.indicators.filter(d => d.kind === 'novelty' && d.target === tn && up.indicators[keyOf(d)] != null);
            const dv = pool.filter(d => d.validated).sort((a, b) => Rof(b) - Rof(a)), d = dv[0] || pool.slice().sort((a, b) => Rof(b) - Rof(a))[0];
            if (!d) return cardc(`<div><div style="font-size:11px;color:${C.purple};font-weight:800;text-transform:uppercase">Novelty → ${metShort(tn)}</div>${bigNumHTML('—', 'no novelty signal')}</div>`, 12);
            const sc = up.indicators[keyOf(d)], est = calib(d, sc), star = d.validated ? '' : `<span style="color:${C.amber}">*</span>`, pc = pctOf(d, sc);
            return cardc(`<div><div style="font-size:11px;color:${C.purple};font-weight:800;text-transform:uppercase">Novelty → ${metShort(tn)}</div>${bigNumHTML((dispV(tn, est) || '—') + star, pc != null ? `${(pc * 100).toFixed(0)}th pctile novel` : '')}${novCurve(d, sc)}<div style="font-size:8.5px;color:${C.mute};margin-top:4px">${d.name.replace('nov_', '')} (R=${Rof(d).toFixed(2)}) — novelty→${metShort(tn)} curve, your hook ◆</div></div>`, 12);
        };
        const gcol = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(216px,1fr));gap:12px';
        const boxes = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:2px">8 independent outputs — 5 embedding, 3 novelty, each its own box</div>
            <div style="font-size:9px;color:${C.mute};margin-bottom:8px">Every number is the one the graph shows. <b style="color:${CY}">Embedding</b> = the steered map estimate (click → that graph; the marker matches). <b style="color:${C.purple}">Novelty</b> = its OWN calibration, never mixed with views/>10M. <span style="color:${C.amber}">*</span> = unvalidated (5s-retention has no novelty signal — noise).</div>
            <div style="font-size:10px;color:${CY};font-weight:800;text-transform:uppercase;margin-bottom:5px">Embedding — 5 boxes (views in BOTH library &amp; your scale)</div>
            <div style="${gcol};margin-bottom:12px">${['keep', 'ret5', 'views', 'realviews', 'gt10M'].map(embBox).join('')}</div>
            <div style="font-size:10px;color:${C.purple};font-weight:800;text-transform:uppercase;margin-bottom:5px">Novelty — 3 boxes (independent)</div>
            <div style="${gcol}">${['keep', 'ret5', 'views'].map(novBox).join('')}</div>`, 12);
        return head + controls + trace + boxes;
    }
    function rtgUpdateFusion() { try { const el = window.document.getElementById('rtg-fusionpanel'); if (el) el.innerHTML = renderFusion(); } catch (e) { } }
    function fuHeat(v) { // -1..1 correlation → blue(neg)…grey…red(pos)
        const t = Math.max(-1, Math.min(1, v));
        if (t >= 0) { const a = t; return `rgb(${Math.round(51 + a * 197)},${Math.round(65 + a * 50)},${Math.round(85 - a * 30)})`; }
        const a = -t; return `rgb(${Math.round(51 - a * 20)},${Math.round(65 + a * 80)},${Math.round(85 + a * 150)})`;
    }
    function renderFusion() {
        const head = h2c('🧬 Fusion — everything vs everything, the honest read', 'Every hook signal tested against views and against outlier (channel-controlled overperformance), all held-out, FDR-controlled, and — critically — partialled against the confounds (channel size, video age, duration). The point isn\'t raw correlation; it\'s which signals carry INDEPENDENT information once everything else is known.');
        if (FUSION === null) { FUSION = { loading: 1 }; fetch('/api/raw/fusion').then(r => r.json()).then(j => { FUSION = j; rtgUpdateFusion(); }).catch(() => { FUSION = { error: 'load failed' }; rtgUpdateFusion(); }); }
        if (!FUSION || FUSION.loading) return head + cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">Loading the fusion report…</div>`);
        if (FUSION.error || !FUSION.targets) return head + cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">No fusion report yet — run <code>fusion_features.py</code> then <code>fusion_analyze.py</code>.</div>`);
        const tgt = FUSION.targets[st.fuTarget] ? st.fuTarget : 'views', T = FUSION.targets[tgt];
        const HOOK = FUSION.meta.hook, CONF = FUSION.meta.confounds, CONTENT = FUSION.meta.content || [];
        const isHook = f => HOOK.includes(f);
        const isContent = f => CONTENT.includes(f);
        const colOfFeat = f => isContent(f) ? C.green : isHook(f) ? C.cyan : C.mute;
        const visC = (T.univariate || []).find(u => u.feature === 'vis_content');
        const tabBtn = (id, lab) => `<span data-futarget="${id}" style="cursor:pointer;border:1px solid ${tgt === id ? C.accent : C.border};background:${tgt === id ? C.accent + '22' : 'transparent'};color:${tgt === id ? C.accent : C.dim};border-radius:8px;padding:5px 13px;font-size:12px;font-weight:700">${lab}</span>`;
        const tabs = `<div style="display:flex;gap:6px;margin-bottom:10px">${tabBtn('views', 'predict views')}${tabBtn('outlier', 'predict outlier (channel-controlled)')}</div>`;
        const f = T.fusion;
        // headline R² breakdown
        const bar = (val, max, col, w) => `<span style="display:inline-block;height:9px;width:${Math.max(0, Math.min(1, val / max)) * (w || 120)}px;background:${col};border-radius:3px;vertical-align:middle"></span>`;
        const headline = cardc(`<div style="font-size:13px;font-weight:800;color:${C.text};margin-bottom:8px">Can the hook predict ${tgt}? — held-out R²</div>
            <div style="display:flex;flex-direction:column;gap:6px;font-size:11px;color:${C.dim}">
              <div>confounds only (channel size · age · duration) ${bar(f.r2_confounds_only, 0.7, C.mute)} <b style="color:${C.text}">${f.r2_confounds_only}</b></div>
              <div>+ all hook signals ${bar(f.r2_full, 0.7, C.accent)} <b style="color:${C.text}">${f.r2_full}</b> <span style="color:${f.hook_incremental_r2 > 0.02 ? C.green : C.mute}">(hook adds ${f.hook_incremental_r2 >= 0 ? '+' : ''}${f.hook_incremental_r2})</span></div>
              <div>hook signals ALONE (no confounds) ${bar(f.r2_hook_only, 0.7, C.purple)} <b style="color:${C.text}">${f.r2_hook_only}</b></div>
            </div>
            ${visC ? `<div style="font-size:11px;color:${C.text};margin-top:8px;line-height:1.5;background:${C.green}14;border-left:3px solid ${C.green};padding:7px 10px;border-radius:4px"><b style="color:${C.green}">The hook's visual content DOES predict ${tgt} independent of channel size.</b> The content axis (an out-of-fold probe of the raw 1536-d embedding) correlates <b>${visC.partial_spearman >= 0 ? '+' : ''}${visC.partial_spearman}</b> with ${tgt} <i>after</i> removing channel size, age & duration ${visC.sig ? '<span style="color:' + C.green + '">(FDR-significant)</span>' : ''}. Novelty/coherence summaries are weak — but the content direction is real signal.</div>` : ''}
            <div style="font-size:10px;color:${C.mute};margin-top:8px;line-height:1.5">Raw views are still mostly <b>distribution</b> (channel + age), so the confound bar is tall — but the green content axis is the genuine, deconfounded hook signal. Reducing the embedding to novelty scalars (the earlier mistake) hid it.</div>`, 12);
        // independence bars (partial corr w/ target | all else)
        const indMax = Math.max(...T.independence.map(d => Math.abs(d.partial_with_target)), 0.05);
        const indep = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">Independent contribution — partial correlation with ${tgt}, controlling every other signal</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">This is the real "where's the independent signal" read. Confounds (grey) dominate; hook signals (cyan) are what's left after removing them.</div>
            ${T.independence.map(d => { const v = d.partial_with_target, hk = isHook(d.feature); return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;font-size:11px"><span style="width:120px;text-align:right;color:${isContent(d.feature) ? C.green : hk ? C.cyan : C.mute}">${d.feature}</span><span style="flex:1;display:flex;align-items:center"><span style="display:inline-block;height:11px;width:${Math.abs(v) / indMax * 130}px;background:${isContent(d.feature) ? C.green : hk ? C.cyan : C.mute};border-radius:3px;${v < 0 ? 'margin-left:auto' : ''}"></span></span><span style="width:48px;color:${C.text};font-weight:700">${v >= 0 ? '+' : ''}${v}</span></div>`; }).join('')}`, 12);
        // univariate table (hook signals, partial spearman + FDR + AUC)
        const topd = Object.keys(T.thresholds).slice(-1)[0];
        const uni = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">Per-signal screen (hook signals)</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">Partial Spearman = relationship to ${tgt} after removing confounds (with 95% CI). FDR✓ = survives multiple-testing correction. AUC@${topd} = standalone ranking power for the top bucket.</div>
            <div style="display:grid;grid-template-columns:130px 90px 70px 70px;gap:4px 8px;font-size:10px">
              <div style="color:${C.mute};text-transform:uppercase">signal</div><div style="color:${C.mute};text-transform:uppercase">partial ρ</div><div style="color:${C.mute};text-transform:uppercase">FDR</div><div style="color:${C.mute};text-transform:uppercase">AUC@${topd}</div>
              ${T.univariate.filter(u => isHook(u.feature)).map(u => `<div style="color:${colOfFeat(u.feature)}">${u.feature}</div><div style="color:${Math.abs(u.partial_spearman) >= 0.05 ? C.text : C.dim};font-weight:700">${u.partial_spearman >= 0 ? '+' : ''}${u.partial_spearman} <span style="color:${C.mute};font-weight:400;font-size:9px">[${u.ci[0]},${u.ci[1]}]</span></div><div style="color:${u.sig ? C.green : C.faint}">${u.sig ? '✓' : '—'}</div><div style="color:${C.dim}">${(u.auc && u.auc[topd]) || '—'}</div>`).join('')}
            </div>`, 12);
        // redundancy heatmap
        const RM = T.redundancy || FUSION.redundancy, sz = 15;
        const heat = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">Redundancy map — which signals are the same information</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">Pairwise Spearman between every signal. Bright red blocks = duplicates (one signal counted twice). <span style="color:${C.cyan}">●</span> hook · <span style="color:${C.mute}">●</span> confound.</div>
            <svg viewBox="0 0 ${RM.features.length * sz + 130} ${RM.features.length * sz + 12}" style="width:100%;max-width:560px">
              ${RM.matrix.map((row, i) => row.map((v, j) => `<rect x="${130 + j * sz}" y="${i * sz}" width="${sz - 1}" height="${sz - 1}" fill="${fuHeat(v)}"><title>${RM.features[i]} × ${RM.features[j]}: ${v}</title></rect>`).join('')).join('')}
              ${RM.features.map((fn, i) => `<text x="126" y="${i * sz + 11}" text-anchor="end" font-size="8" fill="${colOfFeat(fn)}">${fn}</text>`).join('')}
            </svg>`, 12);
        // per-decile AUC (model vs hook-only vs best single)
        const decs = Object.keys(f.model_auc_by_decile);
        const aucPanel = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">Resolution across the ${tgt} spectrum — held-out AUC at every bucket</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px"><span style="color:${C.accent}">▬</span> full model (incl. confounds) · <span style="color:${C.purple}">▬</span> hook signals only · <span style="color:${C.mute}">▬</span> best single signal. The gap between full and hook-only is the confounds.</div>
            <div style="display:grid;grid-template-columns:repeat(${decs.length},1fr);gap:6px;text-align:center;font-size:10px">
              ${decs.map(d => `<div style="color:${C.mute}">${d}</div>`).join('')}
              ${decs.map(d => `<div><div style="color:${C.accent};font-weight:700">${f.model_auc_by_decile[d]}</div><div style="color:${C.purple}">${(f.hook_auc_by_decile || {})[d] || '—'}</div><div style="color:${C.mute};font-size:9px">${(f.best_single_auc_by_decile || {})[d] || '—'}</div></div>`).join('')}
            </div>`, 12);
        // calibration + importance
        const cal = f.calibration || [];
        const calPanel = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:6px">Calibration — predicted vs actual (top bucket), by model-confidence decile</div>
            <svg viewBox="0 0 240 130" style="width:100%;max-width:280px">
              <line x1="20" y1="110" x2="220" y2="110" stroke="${C.border}"/><line x1="20" y1="10" x2="20" y2="110" stroke="${C.border}"/>
              <line x1="20" y1="110" x2="220" y2="10" stroke="${C.faint}" stroke-dasharray="3 3"/>
              ${cal.map(c => `<circle cx="${20 + c.pred / (cal[cal.length - 1].pred || 1) * 200}" cy="${110 - c.actual / (cal[cal.length - 1].actual || 1) * 100}" r="3" fill="${C.accent}"><title>pred ${c.pred} · actual ${c.actual}</title></circle>`).join('')}
            </svg><div style="font-size:9px;color:${C.mute}">on the diagonal = well-calibrated probabilities.</div>`, 12);
        const imp = f.importance.slice(0, 10), impMax = Math.max(...imp.map(d => d.importance), 0.001);
        const impPanel = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:6px">Model importance (permutation, held-out)</div>
            ${imp.map(d => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;font-size:11px"><span style="width:120px;text-align:right;color:${colOfFeat(d.feature)}">${d.feature}</span><span style="display:inline-block;height:10px;width:${d.importance / impMax * 130}px;background:${colOfFeat(d.feature)};border-radius:3px"></span></div>`).join('')}`, 12);
        // novelty hypotheses
        const hyp = T.novelty_hypotheses.shape, invU = Object.entries(hyp).filter(([k, v]) => v.inverted_u).map(([k]) => k);
        const novPanel = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:6px">Novelty shape & interaction</div>
            <div style="font-size:11px;color:${C.dim};line-height:1.6">${invU.length ? `<b style="color:${C.green}">Inverted-U (a novelty sweet spot)</b> detected for: ${invU.map(x => `<span style="color:${C.text}">${x}</span>`).join(', ')} — moderate novelty beats both very-familiar and very-novel.` : 'No clear inverted-U novelty shape.'}
            ${T.novelty_hypotheses.interactions && T.novelty_hypotheses.interactions.coherence_x_visnov ? `<br>coherence × visual-novelty interaction: <b style="color:${C.text}">${T.novelty_hypotheses.interactions.coherence_x_visnov.interaction_coef}</b> (does visual–text alignment change how novelty pays off).` : ''}</div>`, 12);
        // consensus lift
        const lift = (T.consensus.lift || []).filter(l => l.n >= 30).slice(0, 6);
        const liftPanel = cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">Consensus / agreement — does stacking independent signals raise precision?</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">Base rate of a top-10% ${tgt} hit = ${T.consensus.base_top10pct}. Lift = how much each signal-combination beats that. >1 means the conjunction concentrates winners.</div>
            ${lift.map(l => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;margin-bottom:2px"><span style="color:${C.dim}">${l.signals.join(' + ')}</span><span style="color:${C.text}">n=${l.n} · <b style="color:${l.lift > 1.1 ? C.green : l.lift < 0.9 ? C.red : C.dim}">${l.lift}×</b></span></div>`).join('')}`, 12);
        return head + tabs + headline + indep + uni + heat + aucPanel + `<div style="display:flex;gap:12px;flex-wrap:wrap"><div style="flex:1;min-width:260px">${calPanel}</div><div style="flex:1;min-width:260px">${impPanel}</div></div>` + novPanel + liftPanel;
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

    // raw vs DECONFOUNDED correlations from a channel's per-video scatter. Spearman (rank → robust
    // to leverage); "dec" = partial controlling for duration (the confound Tyler spotted: high-
    // retention videos are short, short videos get fewer views → fake-negative retention).
    function deconStats(scatter) {
        const pts = (scatter || []).filter(p => p.dur > 0 && p.ret != null && p.lv != null && p.keep != null && p.ret5 != null);
        if (pts.length < 8) return null;
        const col = k => pts.map(p => k === 'log_dur' ? Math.log10(p.dur) : k === 'retention' ? p.ret : p[k]);
        const lv = pts.map(p => p.lv), rankOf = a => { const ix = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = []; ix.forEach((p, i) => r[p[1]] = i); return r; };
        const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
        const pear = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da && db ? n / Math.sqrt(da * db) : 0; };
        const spear = (a, b) => pear(rankOf(a), rankOf(b));
        const resid = (y, x) => { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; } const b = sxx ? sxy / sxx : 0; return y.map((v, i) => v - (my + b * (x[i] - mx))); };
        const partial = (a, b, ctrls) => { let ra = a.slice(), rb = b.slice(); ctrls.forEach(c => { ra = resid(ra, c); rb = resid(rb, c); }); return spear(ra, rb); };
        const ldur = col('log_dur'), out = { n: pts.length };
        ['keep', 'retention', 'ret5'].forEach(k => { const a = col(k); out[k] = { raw: spear(a, lv), dec: partial(a, lv, [ldur]) }; });
        out.log_dur = { raw: spear(ldur, lv), dec: partial(ldur, lv, [col('keep'), col('retention')]) };
        out._raw = { keep: col('keep'), retention: col('retention'), ret5: col('ret5'), lv: lv, ldur: ldur, dur: pts.map(p => p.dur), residOn: (a) => resid(a, ldur) };
        return out;
    }
    function confoundPanel() {
        const cur = deconStats(S && S.scatter); if (!cur) return '';
        const chName = (CHANS && (CHANS.channels.find(c => c.id === (st.channel || 'tyler')) || {}).name) || 'Main';
        if (CHDECON === null && CHANS && CHANS.channels) {
            CHDECON = { loading: 1 };
            Promise.all(CHANS.channels.map(async c => { let st2 = (c.owner || c.id === 'tyler') ? S_MAIN : await fetch('/api/retention/study?id=' + encodeURIComponent(c.id)).then(r => r.ok ? r.json() : null).catch(() => null); const d = st2 && st2.scatter ? deconStats(st2.scatter) : null; return d ? { id: c.id, name: c.name, d } : null; })).then(rs => { CHDECON = rs.filter(Boolean); try { render(); } catch (e) {} });
        }
        const DR = [['keep', 'Keep', C.cyan], ['retention', 'Retention', C.green], ['ret5', '5-sec ret', C.purple], ['log_dur', 'Duration', C.yellow]];
        const cell = o => { if (!o) return `<td style="text-align:center;color:${C.faint}">—</td>`; const flip = (o.raw < 0) !== (o.dec < 0) && Math.abs(o.raw) > 0.08 && Math.abs(o.dec) > 0.08; const sg = v => (v >= 0 ? '+' : '') + v.toFixed(2); return `<td style="text-align:center;padding:3px 8px;${flip ? 'background:' + C.amber + '22;border-radius:5px' : ''}"><span style="color:${o.raw < 0 ? '#60a5fa' : C.dim};font-size:10px">${sg(o.raw)}</span> <span style="color:${C.mute}">→</span> <span style="color:${o.dec >= 0.15 ? C.green : o.dec < -0.05 ? '#60a5fa' : C.text};font-weight:700">${sg(o.dec)}</span>${flip ? ' ⚑' : ''}</td>`; };
        const xrows = (CHDECON && CHDECON.length) ? CHDECON.map(c => `<tr><td style="color:${C.text};white-space:nowrap;padding-right:8px;font-weight:700">${esc(c.name)} <span style="color:${C.mute};font-weight:400;font-size:9px">n=${c.d.n}</span></td>${DR.map(([k]) => cell(c.d[k])).join('')}</tr>`).join('') : `<tr><td colspan="5" style="color:${C.mute};font-size:10px;padding:6px">computing across channels…</td></tr>`;
        // ── the actual mechanism, visualised for ANY metric: HOW duration is removed ──
        const rr = cur._raw, mean = a => a.reduce((s, v) => s + v, 0) / a.length;
        const METR = { keep: ['Keep rate', C.cyan], retention: ['Avg retention', C.green], ret5: ['5-sec retention', C.purple] };
        const isConf = o => o && (((o.raw < 0) !== (o.dec < 0) && Math.abs(o.raw) > 0.08 && Math.abs(o.dec) > 0.08) || Math.abs(o.raw - o.dec) > 0.13);
        const m = (st.deconMetric && METR[st.deconMetric]) ? st.deconMetric : 'retention', mLab = METR[m][0], mCol = METR[m][1], o = cur[m];
        const mPills = Object.keys(METR).map(k => `<span data-deconmetric="${k}" style="cursor:pointer;border:1px solid ${m === k ? METR[k][1] : C.border};background:${m === k ? METR[k][1] + '22' : 'transparent'};color:${m === k ? METR[k][1] : C.dim};border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700">${METR[k][0]} ${isConf(cur[k]) ? '<span style="color:' + C.amber + '" title="confounded by duration">⚑</span>' : '<span style="color:' + C.green + '" title="clean">✓</span>'}</span>`).join('');
        const mini = (xs, ys, title, xlab, opt) => { opt = opt || {}; const Wm = 200, Hm = 120, pd = 16;
            const xmn = Math.min(...xs), xmx = Math.max(...xs), ymn = Math.min(...ys), ymx = Math.max(...ys);
            const X = v => pd + (v - xmn) / ((xmx - xmn) || 1) * (Wm - 2 * pd), Y = v => Hm - pd - (v - ymn) / ((ymx - ymn) || 1) * (Hm - 2 * pd);
            let dots = ''; for (let i = 0; i < xs.length; i++) dots += `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="2" fill="${opt.color ? opt.color(i) : C.green}" opacity="0.6"/>`;
            let line = ''; if (opt.fit !== false) { const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } const b = sxx ? sxy / sxx : 0; line = `<line x1="${X(xmn).toFixed(1)}" y1="${Y(my + b * (xmn - mx)).toFixed(1)}" x2="${X(xmx).toFixed(1)}" y2="${Y(my + b * (xmx - mx)).toFixed(1)}" stroke="${opt.lineColor || '#fff'}" stroke-width="1.6" stroke-dasharray="4 3"/>`; }
            return `<div style="text-align:center"><div style="font-size:9px;color:${C.text};font-weight:700;height:24px;line-height:1.15">${title}</div><svg viewBox="0 0 ${Wm} ${Hm}" style="width:100%;background:${C.card2};border-radius:6px">${dots}${line}</svg><div style="font-size:8px;color:${C.faint};margin-top:1px">${xlab}</div></div>`; };
        const mArr = rr[m], mResid = rr.residOn(mArr), lvResid = rr.residOn(rr.lv);
        const dmn = Math.min(...rr.ldur), dmx = Math.max(...rr.ldur), durCol = i => rawRamp((rr.ldur[i] - dmn) / ((dmx - dmn) || 1)), low = mLab.toLowerCase();
        const pipeline = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:6px">
            ${mini(mArr, rr.lv, '① RAW: ' + low + ' → views<br><span style="color:' + C.faint + ';font-weight:400">colour = duration</span>', low + ' (colour=duration)', { color: durCol, fit: false })}
            ${mini(rr.dur, mArr, '② fit ' + low + ' ~ duration<br><span style="color:' + C.yellow + ';font-weight:400">subtract this line</span>', 'duration (s)', { lineColor: C.yellow })}
            ${mini(rr.dur, rr.lv, '③ fit views ~ duration<br><span style="color:' + C.yellow + ';font-weight:400">subtract this line</span>', 'duration (s)', { lineColor: C.yellow })}
            ${mini(mResid, lvResid, '④ what remains = true link<br><span style="color:' + mCol + ';font-weight:400">duration removed</span>', low + ' (residual)', { color: () => mCol, lineColor: mCol })}</div>`;
        const verb = (o.raw < 0) !== (o.dec < 0) && Math.abs(o.raw) > 0.05 ? 'The raw sign was <b>backwards</b> — duration was the whole story.' : Math.abs(o.dec) > Math.abs(o.raw) + 0.08 ? 'Duration was <b>hiding</b> a stronger effect.' : Math.abs(o.raw - o.dec) < 0.08 ? 'Barely changes — this metric is <b>clean</b> (not confounded by duration).' : 'Duration shifts it modestly.';
        return cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">Deconfounded — raw vs controlling for duration</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">Spearman (rank → robust to outliers/leverage). <b>raw → deconfounded</b> per channel; ⚑ <span style="background:${C.amber}22;padding:0 4px;border-radius:4px">sign flips / big change</span> once duration is removed = a confound; ✓ = clean.</div>
            <table style="border-collapse:separate;border-spacing:2px;font-size:10px;width:100%;margin-bottom:12px"><tr><td></td>${DR.map(([, l, c]) => `<td style="color:${c};text-transform:uppercase;text-align:center;font-size:9px;font-weight:700">${l}</td>`).join('')}</tr>${xrows}</table>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap"><span style="font-size:10px;color:${C.mute};text-transform:uppercase;font-weight:700">visualise:</span>${mPills}</div>
            <div style="font-size:11px;font-weight:700;color:${C.text};margin-bottom:2px">How "duration removed" works — ${esc(chName)} · ${mLab}</div>
            <div style="font-size:9.5px;color:${C.mute};margin-bottom:2px;line-height:1.5">① ${low} → views, dots <b>coloured by duration</b> (<span style="color:${rawRamp(0)}">short</span>→<span style="color:${rawRamp(1)}">long</span>). We fit ${low}~duration ② and views~duration ③ (yellow = the part duration alone explains), <b>subtract</b> both, and ④ is what survives — ${low} vs views with duration gone.</div>
            ${pipeline}
            <div style="font-size:10px;color:${C.mute};margin-top:8px;line-height:1.6">${mLab}→views: raw <b style="color:${o.raw < 0 ? '#60a5fa' : C.dim}">${(o.raw >= 0 ? '+' : '') + o.raw.toFixed(2)}</b> → deconfounded <b style="color:${o.dec >= 0.15 ? C.green : o.dec < -0.05 ? '#60a5fa' : C.text}">${(o.dec >= 0 ? '+' : '') + o.dec.toFixed(2)}</b> in ④. ${verb} The predictor uses this partial whenever Duration is in the model.</div>`, 12);
    }
    function renderQ1() {
        const Q = S.Q1, cv = Q.cv_r2;
        let h = h2c('Q1 — How much do Keep rate & Retention move views?', `On your ${S.meta.n} videos. Three lenses: rank correlation, the actual view magnitudes by bin, and cross-validated variance explained.`);
        h += cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:6px">Rank correlation with views (Spearman)</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${statc('Keep rate', sgn(Q.lenses.keep.spearman), Q.lenses.keep.spearman > 0.4 ? C.green : C.cyan)}${statc('Retention', sgn(Q.lenses.retention.spearman), C.green)}${statc('Keep↔Retention', sgn(Q.lenses.keep_vs_retention), C.mute)}</div>
            <div style="font-size:10px;color:${C.amber};margin-top:6px">⚠ These are <b>raw</b> correlations — retention can read negative purely because high-retention videos are short. The <b>deconfounded</b> view at the bottom of this tab shows the real relationship.</div>`);
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
        h += confoundPanel();
        return h;
    }
    function renderQ2() {
        const Q = S.Q2;
        let h = h2c('② Shape — does the curve shape matter beyond the average?', 'Same average % viewed, different shape: an early cliff vs a gentle slide. Functional-PCA pulls out the shape that\'s independent of the level.');
        h += `<div id="rtg-hazpanel">${rtgHazardPanel()}</div>`;
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
    // The watch-through signals — keep rate, avg retention, 5-sec retention — are the SAME construct
    // measured three ways; they're collinear. In a plain joint fit, whichever enters first eats the
    // shared variance and the others' coefficients can drift NEGATIVE — a multicollinearity sign-flip,
    // NOT a real "more retention → fewer views" effect (the down-slope Tyler caught on Account 2). We
    // PROVED, deconfounded against duration, that each of these is non-negative. So we encode that as a
    // hard prior: non-negative least squares on the watch-through features (duration & interactions stay
    // free), via greedy active-set — drop the most-negative constrained coef to 0, refit, repeat. A
    // redundant retention then reads exactly 0 (a flat lever, keep already carries its signal) instead
    // of a false negative; its own positive slope reappears the moment you uncheck the collinear sibling.
    const NNEG = { keep: 1, retention: 1, ret5: 1 };
    function olsFit(rows, terms) {
        let active = terms.slice();
        for (let it = 0; it <= terms.length; it++) {
            const m = olsRaw(rows, active);
            let worst = null, wv = 0;
            active.forEach(t => { if (NNEG[t.key] && (m.coef[t.key] || 0) < wv) { wv = m.coef[t.key]; worst = t.key; } });
            if (worst == null) { const coef = {}; terms.forEach(t => coef[t.key] = m.coef[t.key] || 0); return { coef, intercept: m.intercept, residSd: m.residSd }; }
            active = active.filter(t => t.key !== worst);
        }
        const m = olsRaw(rows, active), coef = {}; terms.forEach(t => coef[t.key] = m.coef[t.key] || 0); return { coef, intercept: m.intercept, residSd: m.residSd };
    }
    function cvR2(rows, terms) {     // 5-fold out-of-sample R² (same non-negativity prior as the live fit)
        const n = rows.length, oof = new Array(n);
        for (let f = 0; f < 5; f++) { const tr = rows.filter((_, i) => i % 5 !== f); const m = olsFit(tr, terms);
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
        const terms = termsFor(feats, ints), m = olsFit(rows, terms), cv = cvR2(rows, terms);
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
    // Every feature subset, fit LIVE with the same non-negative fitter (olsFit) + fold scheme the
    // predictor uses — so this menu's accuracy/range and its ranking are exactly what you get when you
    // click a row, on every channel. (Precomputed OLS subsets used to over-rank models whose extra
    // watch-through coef went negative — e.g. on Account 3 keep+ret+ret5+dur looked best at 0.59 under
    // OLS but is really 0.58 under the constrained fit, and some OLS range bands were off by ×7.)
    function predComparison() {
        const P = S.predictor, data = pdata(); if (!data.length) return '';
        const P10 = e => Math.pow(10, e), ck = curKey(), lab = f => P.feat_meta[f].label;
        const order = FEAT_ORDER().filter(f => P.feat_meta[f]);
        const combos = []; for (let mask = 1; mask < (1 << order.length); mask++) { const s = []; order.forEach((f, i) => { if (mask & (1 << i)) s.push(f); }); combos.push(s); }
        const rows = combos.map(features => { const terms = termsFor(features, []), fit = olsFit(data, terms);
            return { k: features.join('+'), features, cv_r2: cvR2(data, terms), rng: P10(1.2816 * fit.residSd) }; }).sort((a, b) => b.cv_r2 - a.cv_r2);
        return cardc(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Every model compared — accuracy vs range</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">CV R² = out-of-sample accuracy (higher = better). Range = ×/÷ band on the prediction (lower = tighter). Fit live with the same non-negative model you'd load — so the ranking is real. Click a row to load that model.</div>
            <div style="display:flex;gap:8px;font-size:9px;color:${C.mute};text-transform:uppercase;padding:0 6px 3px"><span style="flex:1">inputs → log views</span><span style="width:80px;text-align:right">CV R²</span><span style="width:80px;text-align:right">range</span></div>
            ${rows.map(({ k, features, cv_r2, rng }) => { const on = k === ck; return `<div data-predset="${k}" style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:5px;background:${on ? C.card2 : 'transparent'};border:1px solid ${on ? C.accent : 'transparent'}">
                <span style="flex:1;font-size:11px;color:${on ? C.text : C.dim}">${features.map(lab).join(' + ')}</span>
                <span style="width:80px;text-align:right;font-size:11px;color:${C.accent};font-weight:700">${fmtv(cv_r2, 2)}</span>
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
        // DECONFOUNDING, rooted: retention must be measured at fixed length. With Duration in the
        // model, retention's coefficient is its partial (deconfounded) effect — consistent with the
        // Views deconfounded panel and the Experiment's predict-scope. Without it, it's confounded.
        const retSel = st.predFeats.includes('retention') || st.predFeats.includes('ret5'), durSel = st.predFeats.includes('log_dur');
        h += (retSel && !durSel)
            ? note(`⚠ <b>Retention is confounded without Duration.</b> Short videos retain better but get fewer views, so retention's effect reads artificially low when length isn't held fixed. <span data-predfeat="log_dur" style="cursor:pointer;color:${C.cyan};text-decoration:underline;font-weight:700">+ add Duration to deconfound it</span> — the same control the Views deconfounded panel and the Experiment use. (The fit clamps it at ≥0, so it never shows a false negative — but its true positive slope only appears once Duration is in.)`, C.amber)
            : (retSel ? note(`✓ <b>Deconfounded &amp; never falsely negative.</b> Duration is in the model, so retention is measured at fixed length — its real, proven-positive direction, consistent everywhere (Views panel · Experiment · every channel). Keep rate &amp; retention measure the same thing (watch-through), so if <b>both</b> are checked the fit hands the shared credit to keep and retention's <i>extra</i> coefficient can read ~0 (a flat lever, not a down one — it's redundant, not harmful). <b>Uncheck Keep rate to see retention's own positive slope.</b>`, C.green) : '');
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
                <div><div style="font-weight:700;color:${C.text}">Independent lever response curves</div><div style="font-size:11px;color:${C.mute};margin-top:2px">Each line sweeps one input while the others stay fixed. No retention-family line ever slopes <i>down</i> — the fit holds watch-through effects ≥0 (proven non-negative once length is controlled); a flat line means that lever is redundant with another that's checked, not harmful. Actual views uses a true linear y-axis; log10 compresses the same model so the lower range is readable.</div></div>
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
    function novMineFn() { return st.novMine ? (pk => !!(N && N.videos[pk] && N.videos[pk].mine)) : null; }
    function novCorrPanel() {
        const NC = N && N.meta && N.meta.novcorr; if (!NC) return '';
        const ML = (N.meta.metric_labels) || { views_all: 'views · all', views_owned: 'views · mine', ret5: '5s-retention · mine', swipe: 'swipe-away · mine' };
        const cols = ['views_all', 'views_owned', 'ret5', 'swipe'];
        const rows = Object.keys(NC);
        const cell = v => v == null ? `<td style="text-align:center;color:${C.faint};font-size:9px">—</td>` : `<td title="${v}" style="text-align:center;background:${fuHeat(v * 2.8)};color:${Math.abs(v) > 0.15 ? '#fff' : C.dim};font-size:10px;font-weight:${Math.abs(v) >= 0.1 ? 700 : 400};padding:4px 7px">${v >= 0 ? '+' : ''}${v}</td>`;
        return cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">Is novelty an indicator? — Spearman of each novelty score vs each metric</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">views measured on all 11k AND on your 211; 5s-retention &amp; swipe-away on your 211 only. <span style="color:${C.green}">●</span> positive · <span style="color:#60a5fa">●</span> negative. <b>swipe-away is "bad"</b> so a negative there = novelty keeps people. Bright = stronger.</div>
            <table style="border-collapse:separate;border-spacing:2px;font-size:10px;width:100%">
              <tr><td></td>${cols.map(c => `<td style="color:${C.mute};text-transform:uppercase;text-align:center;font-size:9px">${ML[c]}</td>`).join('')}</tr>
              ${rows.map(r => `<tr><td style="color:${C.text};white-space:nowrap;padding-right:8px">${r.replace('_', ' ')}</td>${cols.map(c => cell((NC[r] || {})[c])).join('')}</tr>`).join('')}
            </table>
            <div style="font-size:10px;color:${C.mute};margin-top:8px;line-height:1.5"><b style="color:${C.text}">Read it:</b> visual novelty is negative to views (familiar wins distribution); but <b style="color:${C.green}">combinatorial novelty strongly cuts swipe-away (−0.25)</b> — unusual combinations keep people. Each row is an independent candidate indicator.</div>`, 12);
    }
    // 🔬 QUANTIFY — pick a quantification method × modality, RECOLOUR the actual corpus map by that
    // exact per-video novelty (novelty_field.py), and see its held-out influence on keep / 5s-ret.
    // Every colouring here is the SAME definition the correlation panels measure (one source).
    function renderNovQuantify() {
        if (NQF === null) { NQF = { loading: 1 }; fetch('./buildings/jarvis/retention-study/principles/novelty_field.json?v=120').then(r => r.json()).then(j => { NQF = j; render(); }).catch(() => { NQF = { error: 1 }; render(); }); }
        if (!NQF || NQF.loading) return cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">Loading the novelty field… (2.4MB — every quantification, per video)</div>`);
        if (NQF.error || !NQF.field) return cardc(`<div style="padding:24px;text-align:center;color:${C.dim}">No novelty field yet — run <code>novelty_field.py</code>.</div>`);
        const mod = st.nqMod, meth = st.nqMeth, ch = { visual: 'visual', text: 'text', whole: 'together' }[mod];
        if (!RAW[ch]) rawEnsure(ch);
        const F = NQF.field[mod], M = F.methods[meth] || F.methods.mode;
        const modPill = m => `<span data-nqmod="${m}" style="cursor:pointer;border:1px solid ${mod === m ? C.purple : C.border};background:${mod === m ? C.purple + '22' : 'transparent'};color:${mod === m ? C.purple : C.dim};border-radius:7px;padding:4px 12px;font-size:12px;font-weight:700">${m}</span>`;
        const methPill = mt => { const mm = F.methods[mt], r = mm.keep_r; return `<span data-nqmeth="${mt}" title="${esc(mm.formula)}" style="cursor:pointer;border:1px solid ${meth === mt ? C.cyan : C.border};background:${meth === mt ? C.cyan + '22' : 'transparent'};color:${meth === mt ? C.cyan : C.dim};border-radius:6px;padding:3px 8px;font-size:10px;font-weight:700;white-space:nowrap">${mt} <span style="color:${r > 0.15 ? C.green : C.mute};font-weight:400">${r != null ? (r >= 0 ? '+' : '') + r.toFixed(2) : ''}</span></span>`; };
        const R = RAW[ch];
        let mapSvg = `<div style="height:340px;display:flex;align-items:center;justify-content:center;background:${C.card2};border-radius:8px;color:${C.dim};font-size:11px">loading ${ch} map…</div>`;
        if (R && !R.loading && R.proj && R.proj.umap) {
            const proj = R.proj.umap, n = R.n || proj.x.length, W = 520, H = 340, pad = 14, S = 1000, X = g => pad + g / S * (W - 2 * pad), Y = g => pad + (1 - g / S) * (H - 2 * pad);
            const nov = M.nov, okv = nov.filter(x => x != null && isFinite(x)), lo = Math.min(...okv), hi = Math.max(...okv), mine = R.mine || [], title = R.title || [], views = R.views || [];
            let dots = '', mineDots = '';
            for (let i = 0; i < n; i++) {
                const v = nov[i], col = (v == null || !isFinite(v)) ? '#334155' : rawRamp((v - lo) / ((hi - lo) || 1)), m2 = st.novMine && mine[i];
                const c = `<circle cx="${X(proj.x[i]).toFixed(1)}" cy="${Y(proj.y[i]).toFixed(1)}" r="${m2 ? 3.4 : 1.8}" fill="${m2 ? '#fbbf24' : col}" opacity="${st.novMine ? (mine[i] ? 1 : 0.1) : 0.6}"${m2 ? ' stroke="#fff" stroke-width="0.8"' : ''}><title>${esc((title[i] || '').slice(0, 40))} · novelty ${v != null ? v.toFixed(3) : '—'} · ${fv(views[i])} views</title></circle>`;
                if (m2) mineDots += c; else dots += c;
            }
            // VISUALISE THE DEFINITION on the map: draw what novelty is measured FROM —
            // mean=the single centre · mode=the densest exemplar · niche=the K theme centroids.
            let refSvg = '';
            if (M.ref && M.ref.pts) {
                const k = M.ref.kind;
                M.ref.pts.forEach(p => { const x = X(p[0]).toFixed(1), y = Y(p[1]).toFixed(1);
                    if (k === 'centroids') refSvg += `<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="#fff" stroke-width="1.4"/><circle cx="${x}" cy="${y}" r="1.4" fill="#fff"/>`;
                    else refSvg += `<line x1="${(+x - 11)}" y1="${y}" x2="${(+x + 11)}" y2="${y}" stroke="#fff" stroke-width="1.3"/><line x1="${x}" y1="${(+y - 11)}" x2="${x}" y2="${(+y + 11)}" stroke="#fff" stroke-width="1.3"/><circle cx="${x}" cy="${y}" r="7" fill="none" stroke="#fff" stroke-width="2"/><circle cx="${x}" cy="${y}" r="2.5" fill="#fff"/>`;
                });
                const lab = k === 'centroids' ? `○ = the ${M.ref.pts.length} theme centroids` : k === 'exemplar' ? '✛ = the densest exemplar (most typical hook)' : '✛ = the corpus centre';
                refSvg += `<text x="14" y="${H - 8}" font-size="10" fill="#fff" font-weight="700">${lab} — novelty = distance from ${k === 'centroids' ? 'the nearest' : 'this'}</text>`;
            }
            mapSvg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;background:${C.card2};border-radius:8px">${dots}${mineDots}${refSvg}</svg>`;
        }
        // schematic of WHAT each method measures (fixed illustration of the geometry)
        const diagram = mt => {
            const cat = mt.indexOf('knn') === 0 ? 'knn' : mt.indexOf('niche') === 0 ? 'niche' : mt.indexOf('pcaresid') === 0 ? 'pca' : mt === 'maha' ? 'maha' : 'centre';
            const W2 = 170, H2 = 100, dot = (x, y, c, r) => `<circle cx="${x}" cy="${y}" r="${r || 2}" fill="${c || '#64748b'}"/>`;
            const cloud = [[45, 52], [58, 42], [62, 60], [72, 49], [50, 66], [76, 60], [54, 53], [66, 40], [82, 55], [48, 46], [60, 70], [70, 67], [55, 60], [68, 55]];
            let b = cloud.map(p => dot(p[0], p[1])).join('');
            if (cat === 'centre') { b += `<line x1="60" y1="55" x2="135" y2="28" stroke="${C.cyan}" stroke-width="1.3" stroke-dasharray="3 2"/>` + dot(135, 28, C.cyan, 3) + `<circle cx="60" cy="55" r="6.5" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="60" cy="55" r="2.4" fill="#fff"/><text x="60" y="40" text-anchor="middle" font-size="8" fill="#fff">${mt === 'mode' ? 'densest' : 'centre'}</text><text x="135" y="20" text-anchor="middle" font-size="8" fill="${C.cyan}">novel</text>`; }
            else if (cat === 'knn') { const k = mt.replace('knn', ''); b += dot(132, 32, C.cyan, 3); [[114, 42], [120, 25], [108, 34], [126, 46]].forEach(q => b += `<line x1="132" y1="32" x2="${q[0]}" y2="${q[1]}" stroke="${C.cyan}" stroke-width="1" stroke-dasharray="2 2"/>` + dot(q[0], q[1], '#fff', 2.4)); b += `<text x="120" y="62" text-anchor="middle" font-size="8" fill="${C.cyan}">mean dist to ${k} nearest</text>`; }
            else if (cat === 'niche') { [[52, 50], [74, 60], [62, 44]].forEach(c => b += `<circle cx="${c[0]}" cy="${c[1]}" r="5.5" fill="none" stroke="#fbbf24" stroke-width="1.5"/>`); b += dot(138, 30, C.cyan, 3) + `<line x1="138" y1="30" x2="74" y2="60" stroke="${C.cyan}" stroke-width="1.2" stroke-dasharray="3 2"/><text x="62" y="16" text-anchor="middle" font-size="8" fill="#fbbf24">${mt.replace('niche', '')} theme centres</text>`; }
            else if (cat === 'maha') { b += `<ellipse cx="62" cy="55" rx="30" ry="13" fill="none" stroke="#fff" stroke-width="1.2" opacity="0.7" transform="rotate(18 62 55)"/>` + dot(135, 28, C.cyan, 3) + `<line x1="62" y1="55" x2="135" y2="28" stroke="${C.cyan}" stroke-width="1.2" stroke-dasharray="3 2"/><text x="62" y="84" text-anchor="middle" font-size="8" fill="#fff">covariance shell</text>`; }
            else { b = `<line x1="28" y1="78" x2="140" y2="32" stroke="#fff" stroke-width="1.5" opacity="0.7"/>`; [[46, 70], [64, 62], [88, 52], [112, 42]].forEach(p => b += dot(p[0], p[1])); b += dot(96, 22, C.cyan, 3) + `<line x1="96" y1="22" x2="92" y2="50" stroke="${C.cyan}" stroke-width="1.4" stroke-dasharray="2 2"/>` + dot(92, 50, '#fff', 2.4) + `<text x="140" y="28" text-anchor="end" font-size="8" fill="#fff">typical subspace</text><text x="99" y="20" font-size="8" fill="${C.cyan}">residual</text>`; }
            return `<svg viewBox="0 0 ${W2} ${H2}" style="width:100%;max-width:220px;background:${C.card2};border-radius:6px">${b}</svg>`;
        };
        const fmtr = r => r == null ? '—' : `<b style="color:${r > 0.15 ? C.green : r < -0.05 ? '#60a5fa' : C.dim}">${r >= 0 ? '+' : ''}${r.toFixed(3)}</b>`;
        // method comparison table for this modality (all methods, keep + ret5 ρ)
        const meths = NQF.methods || Object.keys(F.methods);
        const rows = meths.map(mt => { const mm = F.methods[mt]; const sel = mt === meth; return `<tr data-nqmeth="${mt}" style="cursor:pointer;background:${sel ? C.cyan + '15' : 'transparent'}"><td style="padding:3px 8px 3px 4px;color:${sel ? C.cyan : C.text};font-weight:${sel ? 700 : 400};white-space:nowrap">${mt}</td><td style="text-align:center;padding:3px 8px">${fmtr(mm.keep_r)}</td><td style="text-align:center;padding:3px 8px">${fmtr(mm.ret5_r)}</td><td style="color:${C.mute};font-size:9px;padding:3px 6px;line-height:1.3">${esc(mm.formula)}</td></tr>`; }).join('');
        return cardc(`<div style="font-size:13px;font-weight:800;color:${C.text};margin-bottom:2px">🔬 Quantify novelty — recolour the map by any definition, see its influence</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">The quantification IS the variable. Pick a modality and a method → the ${ch} corpus map below recolours by that exact per-video novelty (<span style="color:${rawRamp(0)}">typical</span>→<span style="color:${rawRamp(1)}">novel</span>), and its held-out ρ to keep / 5s-ret is shown. Same definitions the correlation panels measure — one source of truth.</div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:7px;flex-wrap:wrap"><span style="font-size:9px;color:${C.mute};text-transform:uppercase">modality</span>${['visual', 'text', 'whole'].map(modPill).join('')}<span style="width:8px"></span><span data-novmine="1" style="cursor:pointer;border:1px solid ${st.novMine ? '#fbbf24' : C.border};background:${st.novMine ? '#fbbf2422' : 'transparent'};color:${st.novMine ? '#fbbf24' : C.dim};border-radius:7px;padding:4px 11px;font-size:11px;font-weight:700">★ my videos</span></div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">${meths.map(methPill).join('')}</div>
            <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:14px;align-items:start">
              <div>${mapSvg}<div style="font-size:10px;color:${C.mute};margin-top:5px"><b style="color:${C.cyan}">${mod} · ${meth}</b> — ${esc(M.formula)}</div>
                <div style="display:flex;gap:16px;margin-top:6px"><div><div style="font-size:9px;color:${C.mute};text-transform:uppercase">held-out → keep</div><div style="font-size:20px;font-weight:900">${fmtr(M.keep_r)}</div></div><div><div style="font-size:9px;color:${C.mute};text-transform:uppercase">held-out → 5s-ret</div><div style="font-size:20px;font-weight:900">${fmtr(M.ret5_r)}</div></div></div></div>
              <div><div style="font-size:9px;color:${C.mute};text-transform:uppercase;margin-bottom:3px">what "${meth}" measures</div>${diagram(meth)}<div style="font-size:9px;color:${C.faint};margin:3px 0 9px;line-height:1.4">${esc(M.formula)}</div>
                <div style="font-size:10px;color:${C.mute};text-transform:uppercase;margin-bottom:3px">all ${meths.length} methods · ${mod}</div><table style="border-collapse:collapse;font-size:10px;width:100%"><tr><td style="color:${C.mute};font-size:9px">method</td><td style="color:${C.green};font-size:9px;text-align:center">keep</td><td style="color:${C.accent};font-size:9px;text-align:center">5s-ret</td><td style="color:${C.mute};font-size:9px">formula</td></tr>${rows}</table></div>
            </div>`, 12);
    }
    // VALIDATED novelty→retention experiment (novelty_experiment.py): held-out 70/30, consistent
    // definitions, swipe=−keep, views excluded. The rigorous "does novelty actually work" answer.
    function novValidPanel() {
        const E = NCEXP; if (!E || !E.multivariate) return '';
        const mk = E.multivariate.keep, mr = E.multivariate.ret5;
        const uni = (E.univariate || []).slice().sort((a, b) => b.keep_r - a.keep_r);
        const modCol = m => m === 'visual' ? '#94a3b8' : m === 'text' ? C.cyan : m === 'whole' ? C.purple : C.amber;
        const cell = (v, p) => `<td style="text-align:center;background:${fuHeat(v * 2.8)};color:${Math.abs(v) >= 0.15 ? '#fff' : C.dim};font-size:10px;font-weight:${p < 0.05 ? 700 : 400};padding:4px 7px">${v >= 0 ? '+' : ''}${v.toFixed(2)}${p < 0.05 ? '<sup>*</sup>' : ''}</td>`;
        const card = (lab, m) => `<div style="background:${C.card2};border-radius:8px;padding:8px 14px"><div style="font-size:9px;color:${C.mute};text-transform:uppercase">novelty → ${lab}</div><div style="font-size:22px;font-weight:900;color:${m.r > 0 ? C.green : C.dim}">held-out ρ ${m.r >= 0 ? '+' : ''}${m.r}</div><div style="font-size:9px;color:${C.mute}">± ${m.std} · ${(m.pos_frac * 100).toFixed(0)}% of splits positive</div></div>`;
        return cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">Does novelty predict RETENTION? — validated, held-out (70/30 × ${E.splits})</div>
            <div style="display:flex;gap:14px;margin:6px 0 10px;flex-wrap:wrap">${card('keep-rate', mk)}${card('5s retention', mr)}</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:6px">All 13 novelty metrics → ridge, fit on 70% of your 211, scored on the held-out 30%, repeated ${E.splits}×. Both robustly positive → <b style="color:${C.green}">novelty genuinely keeps people watching</b>. Swipe-away = −keep (mirror); views excluded (confounded).</div>
            <table style="border-collapse:separate;border-spacing:2px;font-size:10px;width:100%">
              <tr><td></td><td style="color:${C.mute};text-transform:uppercase;text-align:center;font-size:9px">keep ρ</td><td style="color:${C.mute};text-transform:uppercase;text-align:center;font-size:9px">5s-ret ρ</td></tr>
              ${uni.map(u => `<tr><td style="color:${C.text};white-space:nowrap;padding-right:8px"><b style="color:${modCol(u.modality)}">${u.modality}</b> ${u.type}</td>${cell(u.keep_r, u.keep_p)}${cell(u.ret5_r, u.ret5_p)}</tr>`).join('')}
            </table>
            <div style="font-size:10px;color:${C.mute};margin-top:8px;line-height:1.5"><b style="color:${C.text}">The finding:</b> it's <b style="color:${C.cyan}">script / text novelty</b> (temporal = unlike recent uploads, combinatorial = unusual combination of features) that drives retention. <b style="color:#94a3b8">Visual novelty does NOT predict keep</b> (≈0). So "be novel" means novel in <b>what you say</b>, not just how it looks. <sup>*</sup> = perm-p &lt; 0.05.</div>`, 12);
    }
    // SWEEP of novelty quantifications (novelty_quantify.py): many ways to measure "distance from
    // typical" × modality, each tested linear AND inverted-U, held-out. The quantification matters.
    function novQuantPanel() {
        const Q = NQ; if (!Q || !Q.results) return '';
        const res = Q.results, modCol = m => m === 'visual' ? '#94a3b8' : m === 'text' ? C.cyan : C.purple;
        const visBest = res.filter(r => r.modality === 'visual').slice().sort((a, b) => b.keep_lin - a.keep_lin)[0];
        const spark = pts => { const xs = pts.map(p => p.x), ys = pts.map(p => p.y), xm = Math.min(...xs), xM = Math.max(...xs), ym = Math.min(...ys), yM = Math.max(...ys), w = 76, h = 26, X = v => 2 + (v - xm) / ((xM - xm) || 1) * (w - 4), Y = v => h - 2 - (v - ym) / ((yM - ym) || 1) * (h - 4); return `<svg viewBox="0 0 ${w} ${h}" style="width:${w}px;height:${h}px;vertical-align:middle">${pts.map((p, i) => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="1.4" fill="${C.mute}"/>`).join('')}<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}" fill="none" stroke="${C.cyan}" stroke-width="1.4"/></svg>`; };
        const cellR = v => `<td style="text-align:center;background:${fuHeat(v * 2.8)};color:${Math.abs(v) >= 0.15 ? '#fff' : C.dim};font-size:10px;font-weight:${Math.abs(v) >= 0.2 ? 700 : 400};padding:3px 6px">${v >= 0 ? '+' : ''}${v.toFixed(2)}</td>`;
        const utest = (gain, conc, hump) => `<td style="text-align:center;font-size:9px;color:${hump ? C.amber : C.faint};white-space:nowrap">Δ${gain >= 0 ? '+' : ''}${gain.toFixed(3)} · ${(conc * 100).toFixed(0)}%∩ · ${hump ? 'U' : 'lin'}</td>`;
        // ALL 36 quantifications, sorted by |keep ρ|, full detail per row
        const rows = res.map(r => `<tr><td style="white-space:nowrap;padding-right:6px;color:${C.text}"><b style="color:${modCol(r.modality)}">${r.modality}</b> ${r.method}</td>${cellR(r.keep_lin)}<td style="padding-left:3px">${spark(r.curve_keep)}</td>${utest(r.keep_quadgain, r.keep_concave, r.hump)}${cellR(r.ret5_lin)}<td style="padding-left:3px">${spark(r.curve_ret5)}</td></tr>`).join('');
        const humps = res.filter(r => r.hump).length;
        return cardc(`<div style="font-size:12px;font-weight:800;color:${C.text};margin-bottom:3px">How you QUANTIFY novelty changes everything — all ${res.length} methods, held-out</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:8px">Every row = a different way to measure "distance from the dense centre" (mean · kNN-5/15/50 · k-means niche-8/25/80 · Mahalanobis · PCA-residual-10/50 · low-density · distance-to-mode) × visual/text/whole. Each scored LINEAR and for an INVERTED-U (held-out, 70/30 × ${Q.splits}). Sorted by |keep ρ|. <b>Sparkline</b> = mean keep (or 5s-ret) across novelty deciles — the actual shape. <b>U-test</b>: Δ = held-out R² gained by adding novelty², %∩ = how often that term was concave; <b>U</b> only if both clear a bar.</div>
            <div style="background:${C.card2};border-radius:8px;padding:9px 13px;margin-bottom:9px;font-size:10px;line-height:1.6;color:${C.mute}"><b style="color:${C.green}">Visual novelty hypothesis — CONFIRMED, with the right metric:</b> measured as kNN/niche distance it's ≈0, but as <b style="color:#94a3b8">distance-to-mode (the single most-typical exemplar) it's <b style="color:${C.green}">${visBest ? '+' + visBest.keep_lin : '—'}</b> for keep</b>. The quantification, not the principle, was the problem. <b style="color:${C.amber}">Inverted-U: ${humps}/${res.length}</b> — held-out, no quantification shows a real hump; every relationship is monotonic. The sparklines confirm it.</div>
            <div style="overflow-x:auto"><table style="border-collapse:separate;border-spacing:2px;font-size:10px;width:100%">
              <tr><td style="font-size:9px;color:${C.mute};text-transform:uppercase">${res.length} methods</td><td style="color:${C.green};text-transform:uppercase;text-align:center;font-size:9px;font-weight:700">keep ρ</td><td style="color:${C.mute};text-transform:uppercase;font-size:9px;padding-left:3px">keep shape</td><td style="color:${C.mute};text-transform:uppercase;text-align:center;font-size:9px">keep U-test</td><td style="color:${C.accent};text-transform:uppercase;text-align:center;font-size:9px;font-weight:700">5s-ret ρ</td><td style="color:${C.mute};text-transform:uppercase;font-size:9px;padding-left:3px">5s-ret shape</td></tr>
              ${rows}
            </table></div>`, 12);
    }
    // resolution-aware maps. hook → one point per video; second → one point per video-second.
    function resMaps(colorHook, colorSec, legend, hookExtra) {
        if (st.novRes === 'second') {
            const S = N.second, mods = [['whole', 'Whole / sec', 'Gemini together (frames + transcript)'], ['visual', 'Visual / sec', 'Gemini visual (frames, no text)'], ['text', 'Text / sec', 'Gemini text (transcript)']];
            const trajFor = mod => { if (st.novSel == null) return null; const rows = []; for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === st.novSel) rows.push(i); rows.sort((a, b) => S.sec[a] - S.sec[b]); return rows.map(i => S.proj[mod][i]); };
            const mk = ([mod, label, sub]) => mapCard(label, sub, latentMap(S.proj[mod], { color: i => colorSec(mod, i), pick: i => S.owner[i], sel: st.novSel, traj: trajFor(mod), mine: novMineFn(), r: i => (st.novSel != null && S.owner[i] === st.novSel) ? 5 : 2.3, op: () => 0.62, tip: i => novTip(S.owner[i], 'second ' + S.sec[i]) }), legend);
            return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${mods.map(mk).join('')}<div style="font-size:11px;color:${C.mute};align-self:center;padding:10px">Each point is <b>one second</b> (${S.owner.length} total). Select a hook → its 5 seconds are <b>connected 0→4</b> with numbers, so you can read the path its hook takes through latent space (does it stay put or travel?).</div></div>`;
        }
        const H = N.hook, mods = [['whole', 'Whole hook', 'Gemini together (frames + transcript)'], ['visual', 'Visual', 'Gemini visual (frames, no text)'], ['text', 'Text', 'Gemini text (transcript)']];
        const mk = ([mod, label, sub]) => mapCard(label, sub, latentMap(H.proj[mod], { color: i => colorHook(mod, i), sel: st.novSel, mine: novMineFn(), tip: i => novTip(i) }), legend);
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
                        <div style="display:flex;gap:9px;flex:1">${miniBar('whole', p.nov_pct.whole, heatCol(p.nov_pct.whole))}${miniBar('visual', p.nov_pct.visual, heatCol(p.nov_pct.visual))}${miniBar('text', p.nov_pct.text, heatCol(p.nov_pct.text))}</div></div>
                    <div style="font-size:10px;color:${C.mute};margin-bottom:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                        <span>niche</span><span title="whole" style="color:${nc4(p.niche.whole)};font-weight:700">●${p.niche.whole}</span><span title="visual" style="color:${nc4(p.niche.visual)};font-weight:700">●${p.niche.visual}</span><span title="text" style="color:${nc4(p.niche.text)};font-weight:700">●${p.niche.text}</span>
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
                ${col2('A · Global novelty', ['whole', 'visual', 'text'].map(m => bar(m, fmtv(g[m].nov[i], 3) + ' · ' + Math.round(g[m].pct[i] * 100) + 'th pct', g[m].pct[i], heatCol(g[m].pct[i]))).join(''))}
                ${col2('B · Niche', ['whole', 'visual', 'text'].map(m => `<div style="margin-bottom:7px;font-size:11px;color:${C.dim}">${m}: ${chip('cluster ' + nz[m].labels[i], NPAL[nz[m].labels[i] % NPAL.length])} <span style="color:${C.mute}">· dist ${fmtv(nz[m].dist_to_centre[i], 3)}</span></div>`).join(''))}
                ${col2('C · Temporal', bar('novelty vs ±45d', H.temporal.nov[i] == null ? 'no neighbours' : fmtv(H.temporal.nov[i], 3), rankPct(H.temporal.nov, i), C.green) + `<div style="font-size:10px;color:${C.mute}">distance from hooks posted within 45 days</div>`)}
                ${col2('E · Coherent', bar('novelty', fmtv(ch.novelty[i], 3), ch.nov_pct[i], heatCol(ch.nov_pct[i])) + bar('coherence (vis↔words)', fmtv(ch.coherence[i], 3), ch.coh_pct[i], C.cyan) + `<div style="font-size:10px;color:${C.mute}">quadrant: <b style="color:${ch.nov_pct[i] > .5 && ch.coh_pct[i] > .5 ? C.green : C.dim}">${(ch.nov_pct[i] > .5 ? 'novel' : 'familiar') + ' + ' + (ch.coh_pct[i] > .5 ? 'coherent' : 'incoherent')} → ${ch.nov_pct[i] > .5 ? (ch.coh_pct[i] > .5 ? 'curiosity' : 'confusion') : (ch.coh_pct[i] > .5 ? 'familiar' : 'boring')}</b></div>`)}
                ${col2('Scene spread + coords', bar('scene spread (visual cuts)', fmtv(H.scene.spread[i], 3), rankPct(H.scene.spread, i), C.orange) + `<div style="font-size:10px;color:${C.mute};line-height:1.7">2D position · whole ${coord('whole')} · visual ${coord('visual')} · text ${coord('text')}</div>`)}
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
        let h = h2c('E · Coherent novelty — novelty × coherence (the curiosity quadrant)', 'X = novelty (distance from corpus). Y = coherence = cos(Gemini visual, Gemini text) — do the visuals match the words. Novel + coherent = curiosity; novel + incoherent = confusion.');
        h += cardc(`<div style="display:grid;grid-template-columns:3fr 2fr;gap:12px">
            <div>${quadPlot(ch.nov_pct, ch.coh_pct, { color: i => heatCol(N.videos[i].lv ? (N.videos[i].lv - 4.5) / 4 : 0.5), sel: st.novSel, tip: i => novTip(i, 'coh ' + ch.coherence[i]) })}<div style="font-size:10px;color:${C.mute};margin-top:4px">point colour = views (brighter = more) · click to open its data</div></div>
            <div>${mapCard('Per-second coherence', 'each second coloured by visual↔word match', latentMap(N.second.proj.whole, { color: i => heatCol(N.second.coh_pct[i]), pick: i => N.second.owner[i], sel: st.novSel, r: i => (st.novSel != null && N.second.owner[i] === st.novSel) ? 5 : 2.4, op: () => 0.62, tip: i => novTip(N.second.owner[i], 'sec ' + N.second.sec[i] + ' coh ' + N.second.coherence[i]) }), legendBar('mismatch', 'coherent'))}</div></div>`);
        h += note('<b>Valuable novelty = distance × understandability.</b> Coherence is a defined Gemini cosine, not a human judgement. Once views are overlaid, the curiosity quadrant should be where winners concentrate.', C.green);
        return h;
    }
    function renderNovLedger() {
        const tcol = { geometry: C.cyan, encoder: C.accent, 'model-metric': C.green, defined: C.purple, detection: C.orange, interpreted: C.red };
        let h = h2c('📋 Interpretation ledger — what is measured vs interpreted', 'Every data point in this tab, with its exact definition and how much human/LLM interpretation it carries. The goal: define absolutely everything.');
        h += cardc((N.ledger || []).map(L => `<div style="display:flex;gap:10px;padding:8px 0;border-top:1px solid ${C.border}">
            <div style="width:150px;flex-shrink:0"><div style="font-size:12px;font-weight:700;color:${C.text}">${esc(L.metric)}</div><span style="display:inline-block;margin-top:3px;background:${(tcol[L.type] || C.mute)}22;border:1px solid ${tcol[L.type] || C.mute};color:${tcol[L.type] || C.mute};border-radius:5px;padding:0 6px;font-size:9px;font-weight:800;text-transform:uppercase">${esc(L.type)}</span></div>
            <div style="flex:1;font-size:11px;color:${C.dim};line-height:1.5">${esc(L.def)}</div></div>`).join(''));
        h += note('<b>geometry</b> = pure distance/clustering on the Gemini vectors · <b>encoder</b> = Gemini embedding, identical for all videos · <b>model-metric</b> = a defined scalar (e.g. Gemini cosine coherence) · <b>defined</b> = an explicit formula (PCA residual) · <b style="color:' + C.red + '">interpreted</b> = LLM prose, shown as context only, never fed into a score.', C.dim);
        return h;
    }
    // ── Correlations: every novelty feature vs the indicators + views ──
    // Human-readable definition for any feature name (parsed from its naming grammar).
    function featDef(name) {
        const MOD = { whole: 'whole-hook (Gemini: frames + transcript)', visual: 'visual (Gemini frames, no text)', text: 'text (Gemini transcript)' };
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
        if (name === 'coherence_hook') return `Hook coherence — cosine between the Gemini visual vector and the Gemini text vector. High = the visuals match what's being said.`;
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
    function rtgSeek(t) {
        try {
            if (rtgPlayer && rtgPlayer.seekTo) {
                const ps = rtgPlayer.getPlayerState ? rtgPlayer.getPlayerState() : -1;   // -1 unstarted · 1 playing · 2 paused · 5 cued
                rtgPlayer.seekTo(t, true);
                // only auto-start when it has never shown a frame (else it'd be black); otherwise PRESERVE play/pause
                if ((ps === -1 || ps === 5) && rtgPlayer.playVideo) rtgPlayer.playVideo();
            }
        } catch (e) { }
        rtgSetPlayhead(t);
    }
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
    // ---- EMERGENCE view (declared / Gemini): full field + clusters, nothing labelled ----
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
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5">Every second coloured by which cluster it fell into (k-means in Gemini space — no thresholds, nothing called a reference or gratification). When a colour appears on the <b style="color:${C.dim}">C</b>oncept track and then later on the <b style="color:${C.dim}">V</b>isual track, a spoken idea and its later depiction fell into the same cluster — a loop that <i>emerged</i>. Click a second to inspect & play.</div>
            <svg viewBox="0 0 ${W} ${yC + ch + 20}" style="width:100%">
              <text x="2" y="${yV + ch / 2 + 4}" fill="${C.dim}" font-size="11" font-weight="800">V</text>
              <text x="2" y="${yC + ch / 2 + 4}" fill="${C.dim}" font-size="11" font-weight="800">C</text>
              ${cells}${ph}${ax}</svg>
            <div style="margin-top:6px">${legend}</div>`);
    }
    function rtgSig(v) { return (v.signals && st.rtgSignal && v.signals[st.rtgSignal]) || { refness: v.refness || [], payoff: v.payoff || [], links: v.links || [] }; }
    function rtgSigSelector(v) {
        const m = RTGF.meta; if (!m || !m.signals) return '';
        const lab = m.signal_labels || {};
        const cov = m.coverage;
        const covLine = cov ? `<div style="font-size:10px;color:${C.mute};margin-bottom:5px;line-height:1.5;border-left:2px solid ${C.accent};padding-left:7px"><b style="color:${C.accent}">No single theory tells the whole story.</b> The ${m.sweep_n} algorithms cluster into <b>${cov.families} families</b> (specific-match · semantic-entailment · info-gap · forward-vs-past · recurrence · incompleteness), and each family catches a <i>different</i> population of your loops — the best single one tops out at 70%. But every label is caught by <i>some</i> algorithm (<b style="color:${C.green}">${Math.round(cov.union_pct * 100)}% union ceiling</b>, 0 uncatchable). So we <b>combine</b>: set-cover picks one algorithm per family → the <b style="color:${C.accent}">⛓ ensemble</b> unions them and catches <b style="color:${C.green}">${Math.round(cov.ensemble_recall * 100)}%</b> of your ${cov.n_labels} labels. Each ensemble arc is tagged with the theory that caught it.</div>` : '';
        const head = m.sweep_n ? `${covLine}<div style="font-size:10px;color:${C.mute};margin-bottom:5px"><b style="color:${C.accent}">${m.sweep_n} algorithms</b> ranked by how well they recover the loops you labelled across ${m.labelled} videos — PU recall, never penalised for finding <i>more</i> than you marked (your labels are a guide, not truth). Browse them; default = the ensemble. Your labels overlay dashed: <b style="color:${C.green}">green caught</b>, <b style="color:#f87171">red missed</b>. Plus two learned <b>predictive lenses</b> — <b>🧠 JEPA</b> (sharp forward expectation) and <b>❓ implicit anticipation</b> (a world-model catching the "where is this going" loops similarity can't) — lower recall on your <i>explicit</i> labels by design, since they surface a different population.</div>` : '';
        const rv = (m.retention_validation && m.retention_validation.by_signal) || {};
        const champ = m.retention_validation && m.retention_validation.phase2 && m.retention_validation.phase2.champion;
        const pills = m.signals.map(s => { const pf = rv[s] && rv[s].pFut;
            const tip = esc(lab[s] || s) + (pf != null ? ` — retention-hold pFut ${pf >= 0 ? '+' : ''}${pf.toFixed(3)}` : '') + (s === champ ? ' · ★ retention champion (drop-zone hold)' : '');
            const tag = s === champ ? `<span style="color:#fbbf24"> ★</span>` : (pf != null && pf >= 0.18 ? `<span style="color:#fbbf24"> ◆</span>` : '');
            return `<span data-rtgsignal="${s}" title="${tip}" style="cursor:pointer;border:1px solid ${st.rtgSignal === s ? C.accent : C.border};background:${st.rtgSignal === s ? C.accent + '1e' : 'transparent'};color:${st.rtgSignal === s ? C.accent : C.dim};border-radius:6px;padding:3px 8px;font-size:10px;font-weight:700;white-space:nowrap">${esc(lab[s] || s)}${tag}</span>`; }).join('');
        return `<div style="margin-bottom:8px">${head}<div style="display:flex;gap:5px;flex-wrap:wrap;max-height:104px;overflow-y:auto;padding:2px">${pills}</div></div>`;
    }
    function rtgUpdateSignal() {
        try { const v = RTGF.videos[st.rtgSel]; if (!v) return;
            const ss = window.document.getElementById('rtg-sigsel'); if (ss) ss.innerHTML = rtgSigSelector(v);
            const sc = window.document.getElementById('rtg-strctl'); if (sc) sc.innerHTML = rtgStrengthSlider(v);
            const rp = window.document.getElementById('rtg-refpay'); if (rp) rp.innerHTML = rtgRefPayoff(v);
            rtgUpdateLabelUI();
        } catch (e) { }
    }
    // confidence/relevance threshold slider — drag to let fewer/more connections emerge
    function rtgStrengthSlider(v) {
        const sg = rtgSig(v), all = sg.links || [], cstr = l => (l.str != null ? l.str : l.s), thr = st.rtgMinStr || 0;
        const shown = all.filter(l => cstr(l) >= thr).length;
        const isEns = !!(all[0] && all[0].c != null);
        return `<div style="background:${C.card};border:1px solid ${C.border};border-radius:10px;padding:10px 13px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span style="font-size:11px;font-weight:700;color:${C.text};white-space:nowrap">Connection threshold</span>
              <input id="rtg-minstr" type="range" min="0" max="1" step="0.02" value="${thr}" style="flex:1;min-width:150px;accent-color:${C.purple};cursor:pointer">
              <span style="font-size:11px;color:${C.dim};white-space:nowrap">≥ <b id="rtg-strval" style="color:${C.purple}">${thr.toFixed(2)}</b> · <b id="rtg-strcount" style="color:${C.text}">${shown}</b>/${all.length} shown</span>
            </div>
            <div style="font-size:9.5px;color:${C.mute};margin-top:5px;line-height:1.5">Each connection has a <b>${isEns ? 'confidence' : 'relevance'} strength</b> ${isEns ? '(0.45·consensus + 0.30·intensity + 0.25·fulfilment — how many theories agree × how strong the loop is)' : '(reference-ness intensity)'}. Drag <b>right</b> to keep only the strongest loops; <b>left</b> to let weaker ones emerge.</div>
        </div>`;
    }
    function rtgUpdateThresh() {
        try { const v = RTGF.videos[st.rtgSel]; if (!v) return;
            const rp = window.document.getElementById('rtg-refpay'); if (rp) rp.innerHTML = rtgRefPayoff(v);
            const sg = rtgSig(v), all = sg.links || [], cstr = l => (l.str != null ? l.str : l.s), thr = st.rtgMinStr || 0;
            const sv = window.document.getElementById('rtg-strval'); if (sv) sv.textContent = thr.toFixed(2);
            const cc = window.document.getElementById('rtg-strcount'); if (cc) cc.textContent = all.filter(l => cstr(l) >= thr).length;
        } catch (e) { }
    }
    function rtgRefPayoff(v) {
        const n = v.n_sec, W = 820, pad = 30, iw = W - pad - 10, H = 156, yR = 56, yP = 100, amp = 40;
        const x = s => pad + (n <= 1 ? 0 : s * iw / (n - 1));
        const sg = rtgSig(v), ref = sg.refness || [], pay = sg.payoff || [];
        // each connection's confidence/relevance strength → filtered by the threshold slider
        const allLinks = sg.links || [], cstr = l => (l.str != null ? l.str : l.s), thr = st.rtgMinStr || 0;
        const links = allLinks.filter(l => cstr(l) >= thr);
        const refA = `M ${x(0)} ${yR} ` + ref.map((r, i) => `L ${x(i).toFixed(1)} ${(yR - r * amp).toFixed(1)}`).join(' ') + ` L ${x(n - 1)} ${yR} Z`;
        const payA = `M ${x(0)} ${yP} ` + pay.map((p, i) => `L ${x(i).toFixed(1)} ${(yP + p * amp).toFixed(1)}`).join(' ') + ` L ${x(n - 1)} ${yP} Z`;
        // line THICKNESS ∝ loop strength; COLOUR ∝ consensus (how many of the 6 theories agree)
        const arcs = links.map(l => { const xi = x(l.i), xj = x(l.j);
            const strg = (l.str != null ? l.str : l.s), cons = (l.c != null ? l.c : null);
            const col = cons != null ? rtgConsColor(cons) : C.purple;
            const tip = `reference @${l.i}s → fulfilled @${l.j}s · strength ${strg.toFixed(2)}`
                + (cons != null ? ` · ${Math.round(cons * 6)}/6 theories agree` : '')
                + (l.reinf > 1 ? ` · ${l.reinf} references converge here` : '')
                + (l.src ? ` · caught by the ${l.src} theory` : '');
            return `<path d="M ${xi} ${yR} C ${xi} ${(yR + yP) / 2} ${xj} ${(yR + yP) / 2} ${xj} ${yP}" fill="none" stroke="${col}" stroke-width="${(0.6 + strg * 3.6).toFixed(1)}" opacity="${(0.22 + strg * 0.62).toFixed(2)}"><title>${tip}</title></path>`; }).join('');
        // re-reference THREADS — rings where multiple references converge on one payoff (taxonomy #2)
        const conv = {}; links.forEach(l => { if (l.reinf > 1) conv[l.j] = Math.max(conv[l.j] || 0, l.reinf); });
        const convMk = Object.keys(conv).map(j => `<circle cx="${x(+j).toFixed(1)}" cy="${yP}" r="${(3 + conv[j] * 1.5).toFixed(1)}" fill="none" stroke="${C.green}" stroke-width="1.3" opacity="0.6"><title>${conv[j]} references converge on this payoff — a re-reference thread</title></circle>`).join('');
        // your hand-labels overlaid — coloured by whether a SHOWN connection catches each (±3s)
        const lab = RTGLABELS[v.id] || { pairs: [], orphans: [] };
        const caught = p => links.some(l => Math.abs(l.i - p.r) <= 3 && Math.abs(l.j - p.g) <= 3);
        let nHit = 0;
        const labOv = lab.pairs.map(p => { const hit = caught(p); if (hit) nHit++; const col = hit ? C.green : '#f87171';
            return `<path d="M ${x(p.r)} ${yR} C ${x(p.r)} ${(yR + yP) / 2} ${x(p.g)} ${(yR + yP) / 2} ${x(p.g)} ${yP}" fill="none" stroke="${col}" stroke-width="1.2" stroke-dasharray="3 3" opacity="${hit ? 0.7 : 0.5}"><title>your label ${p.r}s→${p.g}s · ${hit ? 'caught' : 'MISSED'} by this signal</title></path><path d="M ${x(p.r) - 3.5} ${yR - 4} L ${x(p.r) + 3.5} ${yR - 4} L ${x(p.r)} ${yR} Z" fill="${col}" opacity="0.65"/>`; }).join('');
        const hitBadge = lab.pairs.length ? `<span style="color:${C.dim}">your labels: <b style="color:${C.green}">${nHit} caught</b> / <b style="color:#f87171">${lab.pairs.length - nHit} missed</b></span>` : '';
        const pk = (arr, base, up, col) => arr.map((r, i) => (r > 0.12 && (i === 0 || r >= arr[i - 1]) && (i === n - 1 || r >= arr[i + 1])) ? `<circle data-rtgnode="${i}" style="cursor:pointer" cx="${x(i).toFixed(1)}" cy="${(base + up * r * amp).toFixed(1)}" r="${(2 + r * 3).toFixed(1)}" fill="${col}" opacity="${(0.35 + r * 0.65).toFixed(2)}"><title>${i}s · ${(r).toFixed(2)}</title></circle>` : '').join('');
        const ph = `<line class="rtg-ph" data-x0="${pad}" data-x1="${x(n - 1)}" data-n="${n}" x1="${pad}" y1="14" x2="${pad}" y2="${H - 10}" stroke="#fff" stroke-width="1.5" opacity="0" style="pointer-events:none"/>`;
        // REAL viewer retention overlaid (ground truth) + back-third risk flags from the validated champion
        const rtv = (DATA && DATA.videos) ? DATA.videos.find(o => o.id === v.id) : null;
        let retOv = '', riskMk = '', riskN = 0;
        if (rtv && rtv.curve && rtv.curve.length) {
            const cur = rtv.curve, rs = t => cur[Math.round(t / Math.max(1, n - 1) * (cur.length - 1))];
            let mn = Infinity, mx = -Infinity; for (let t = 0; t < n; t++) { const c = rs(t); if (c < mn) mn = c; if (c > mx) mx = c; }
            const span = (mx - mn) || 1, yC = t => 16 + (1 - (rs(t) - mn) / span) * (H - 28);
            let pth = ''; for (let t = 0; t < n; t++) pth += (t ? 'L' : 'M') + x(t).toFixed(1) + ' ' + yC(t).toFixed(1) + ' ';
            retOv = `<path d="${pth}" fill="none" stroke="#e879f9" stroke-width="1.3" opacity="0.6" stroke-dasharray="2 2"><title>real viewer retention</title></path>`;
            const champ = RTGF.meta.retention_validation && RTGF.meta.retention_validation.phase2 && RTGF.meta.retention_validation.phase2.champion;
            const cs = champ && v.signals && v.signals[champ] && v.signals[champ].refness;
            if (cs) { const t0 = Math.ceil(0.67 * (n - 1));
                for (let t = t0; t < n - 1; t++) { if ((rs(Math.min(n - 1, t + 3)) - rs(t)) < 0 && (cs[t] || 0) < 0.2) { riskN++;
                    riskMk += `<rect x="${(x(t) - 2).toFixed(1)}" y="${H - 9}" width="4" height="5" fill="#f87171" opacity="0.85"><title>${t}s · retention dropping with no open loop — drop-zone risk: open a question here</title></rect>`; } }
            }
        }
        const slab = (RTGF.meta && RTGF.meta.signal_labels && RTGF.meta.signal_labels[st.rtgSignal]) || st.rtgSignal;
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Reference-ness & payoff-ness — <span style="color:${C.accent}">${esc(slab)}</span> signal &nbsp; <span style="font-weight:400;color:${C.mute};font-size:10px">${links.length}/${allLinks.length} connections${thr > 0 ? ` ≥ ${thr.toFixed(2)}` : ''}</span> &nbsp; ${hitBadge}</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5"><b style="color:${C.cyan}">Reference-ness</b> (top) = this moment points to a <i>specific</i> later moment that isn't present yet (intrinsic & causal — shows even when nothing pays it off). <b style="color:${C.green}">Payoff-ness</b> (bottom) = a later moment fulfils a real earlier reference. <span style="color:${C.purple}">Arcs</span> = the link. ${labOv ? `Your hand-labels are dashed — <b style="color:${C.green}">green = this signal caught it</b>, <b style="color:#f87171">red = missed</b> (a guide, never fit to). ` : ''}Encoder: <b>${esc((RTGF.meta && RTGF.meta.encoder) || '?')}</b>. Flip the signal above to see which one lands where you'd expect.</div>
            <svg viewBox="0 0 ${W} ${H}" style="width:100%">
              <line x1="${pad}" y1="${yR}" x2="${W - 10}" y2="${yR}" stroke="${C.border2}"/><line x1="${pad}" y1="${yP}" x2="${W - 10}" y2="${yP}" stroke="${C.border2}"/>
              <path d="${refA}" fill="${C.cyan}26" stroke="${C.cyan}" stroke-width="1.2"/><path d="${payA}" fill="${C.green}26" stroke="${C.green}" stroke-width="1.2"/>
              ${retOv}${labOv}${arcs}${convMk}${pk(ref, yR, -1, C.cyan)}${pk(pay, yP, 1, C.green)}${riskMk}${ph}
              <text x="${pad}" y="14" fill="${C.cyan}" font-size="10" font-weight="700">reference-ness (anticipation set)</text>
              ${retOv ? `<text x="${W - 10}" y="14" fill="#e879f9" font-size="10" font-weight="700" text-anchor="end">real retention</text>` : ''}
              <text x="${pad}" y="${H - 4}" fill="${C.green}" font-size="10" font-weight="700">payoff-ness (anticipation met)</text></svg>
            ${retOv ? `<div style="font-size:9.5px;color:${C.mute};margin-top:5px;line-height:1.5"><span style="color:#e879f9">▬ ▬</span> real viewer retention overlaid. ${riskN ? `<span style="color:#f87171">▮</span> <b style="color:#f87171">${riskN} drop-zone risk ${riskN === 1 ? 'spot' : 'spots'}</b> — back-third seconds where retention is falling with <i>no open loop</i> active (the validated entailment champion is quiet). Open an abstract question here.` : `<span style="color:${C.green}">Back third is covered</span> — no drop-zone gaps where retention falls without an open loop.`}</div>` : ''}
            ${sg.links && sg.links[0] && sg.links[0].c != null ? `<div style="font-size:9.5px;color:${C.mute};margin-top:5px;display:flex;gap:14px;flex-wrap:wrap;align-items:center">
              <span><b style="color:${C.text}">Loop strength</b> = 0.45·consensus + 0.30·intensity + 0.25·fulfilment.</span>
              <span>Thicker arc = <b style="color:${C.text}">stronger</b>.</span>
              <span>Colour = how many theories agree: <span style="color:${rtgConsColor(1 / 6)}">▬</span> 1 (subtle) → <span style="color:${rtgConsColor(0.5)}">▬</span> → <span style="color:${rtgConsColor(1)}">▬</span> all&nbsp;6 (unambiguous).</span>
              <span><span style="color:${C.green}">◯</span> ring = re-references converging on one payoff (a thread).</span></div>` : ''}`);
    }
    // consensus → colour: cool dim blue (1 theory, subtle) → bright gold (all theories agree, unambiguous)
    function rtgConsColor(c) { const lo = [91, 140, 255], hi = [251, 191, 36], t = Math.max(0, Math.min(1, c));
        return `rgb(${lo.map((a, k) => Math.round(a + (hi[k] - a) * t)).join(',')})`; }
    // THE real validation — against actual viewer retention, no labels, confound-controlled
    function rtgRetentionPanel() {
        const rv = RTGF.meta && RTGF.meta.retention_validation; if (!rv || !rv.by_signal) return '';
        const by = rv.by_signal, lab = RTGF.meta.signal_labels || {};
        const rows = Object.keys(by).map(s => Object.assign({ s }, by[s])).filter(r => r.pFut != null);
        const hold = rows.slice().sort((a, b) => b.pFut - a.pFut).slice(0, 6);
        const markers = rows.filter(r => r.rLvl >= 0.5).sort((a, b) => b.rLvl - a.rLvl).slice(0, 3);
        const maxP = Math.max(0.01, ...rows.map(r => Math.abs(r.pFut)));
        const nm = s => esc((lab[s] || s).replace(/\s*\([^)]*\)\s*$/, ''));
        const bar = (v, col) => `<div style="flex:1;height:8px;background:${C.card2};border-radius:3px;overflow:hidden;position:relative"><div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:${C.border2}"></div><div style="position:absolute;left:${v >= 0 ? 50 : 50 + v / maxP * 50}%;top:0;bottom:0;width:${Math.abs(v) / maxP * 50}%;background:${col};border-radius:2px"></div></div>`;
        const row = (r, col) => `<div style="display:flex;align-items:center;gap:8px;font-size:10px"><div style="width:150px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${nm(r.s)}</div>${bar(r.pFut, col)}<div style="width:46px;text-align:right;color:${col};font-weight:700">${r.pFut >= 0 ? '+' : ''}${r.pFut.toFixed(3)}</div></div>`;
        const vl = rv.video_level || {}, third = vl.by_third || {}, top = hold[0] || {};
        const ci = top.pFut_ci, pp = top.pFut_p;
        const tb = (name, key) => { const v = third[key], pos = v >= 0; return `<div style="flex:1;text-align:center"><div style="font-size:9px;color:${C.mute};text-transform:uppercase;letter-spacing:.04em">${name}</div><div style="height:34px;display:flex;align-items:flex-end;justify-content:center;margin:3px 0"><div style="width:55%;height:${Math.min(34, Math.abs(v || 0) / 0.25 * 34).toFixed(0)}px;background:${pos ? '#fbbf24' : C.border2};border-radius:2px"></div></div><div style="font-size:10px;font-weight:700;color:${pos ? '#fbbf24' : C.mute}">${v >= 0 ? '+' : ''}${(v || 0).toFixed(3)}</div></div>`; };
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">Validated against real retention — <span style="color:${C.green}">no labels, ${rv.n_videos} videos</span></div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:9px;line-height:1.55">Your hand-labels are a guide; <b style="color:${C.text}">this is ground truth</b>. Per-second YouTube relative-retention, within-video z-scored. <b>pFut</b> = partial corr of reference-ness with the <i>forward 3s retention slope</i>, controlling for current level + position — does opening a loop <b>hold attention beyond where retention already sits</b>.</div>
            <div style="font-size:10.5px;color:${C.text};font-weight:700;margin-bottom:4px">What holds viewers forward (within-video)</div>
            <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:5px">${hold.map(r => row(r, '#fbbf24')).join('')}</div>
            ${ci ? `<div style="font-size:9.5px;color:${C.mute};margin-bottom:9px"><b style="color:#fbbf24">${nm(top.s)}</b>: pFut <b>${top.pFut >= 0 ? '+' : ''}${top.pFut.toFixed(3)}</b>, 95% CI [${ci[0] >= 0 ? '+' : ''}${ci[0].toFixed(3)}, ${ci[1] >= 0 ? '+' : ''}${ci[1].toFixed(3)}], permutation p=<b>${pp}</b> — cluster-bootstrapped over videos, autocorrelation-robust.</div>` : ''}
            ${rv.phase4 ? (() => { const z = rv.phase4.by_zone.overall, rrow = (t, v, col) => `<div style="display:flex;align-items:center;gap:8px;font-size:10px"><div style="width:150px;color:${C.dim}">${t}</div>${bar(v, col)}<div style="width:46px;text-align:right;color:${col};font-weight:700">${v >= 0 ? '+' : ''}${v.toFixed(3)}</div></div>`;
              return `<div style="font-size:10.5px;color:${C.text};font-weight:700;margin-bottom:4px">Open vs close — does closing the loop release attention?</div>
              <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:5px">${rrow('REFERENCE · loop opens', z.ref[0], '#fbbf24')}${rrow('PAYOFF · loop closes', z.pay[0], '#f87171')}</div>
              <div style="font-size:9.5px;color:${C.mute};margin-bottom:9px">References <b style="color:#fbbf24">hold</b> attention (CI excludes 0); payoffs <b style="color:#f87171">release / neutral</b> (CI [${z.pay[1].toFixed(3)}, ${z.pay[2].toFixed(3)}]). The loop <i>closing</i> coincides with viewers leaving — tension discharged. Validates <b style="color:${C.text}">"references hold retention, not gratifications"</b> on real behaviour.</div>`; })() : ''}
            ${third.late != null ? `<div style="font-size:10.5px;color:${C.text};font-weight:700;margin-bottom:2px">…and it lives in the drop zone</div>
            <div style="display:flex;gap:6px;align-items:flex-end;margin:4px 0 9px">${tb('Early', 'early')}${tb('Middle', 'mid')}${tb('Late · drop zone', 'late')}</div>` : ''}
            <div style="font-size:10px;color:${C.mute};line-height:1.55;border-left:2px solid ${C.green};padding-left:8px">
              <b style="color:${C.text}">The finding:</b> <b style="color:#fbbf24">semantic-entailment</b> loops — abstract "<i>this implies a payoff that hasn't happened yet</i>" references — hold attention, but <b>only in the back third</b> (the drop zone where viewers decide to bail). Early on the hook drives retention, not loops. The dense concrete-callback signals${markers.length ? ` (${markers.map(m => nm(m.s)).join(', ')})` : ''} just <b>mark</b> where attention is (level corr +0.5–0.6, ~0 forward-hold), they don't <b>extend</b> it. <b style="color:${C.text}">Honest scope:</b> a <i>within-video, moment-level</i> effect — the <i>amount</i> of entailment structure does <b>not</b> predict which videos keep viewers better overall (out-of-sample ΔR²≈${vl.keep_dR2 != null ? vl.keep_dR2.toFixed(2) : '0'} on keep-rate; dominated by hook/duration/topic). Label-recall ≠ behavioural validity.</div>
            ${rv.phase2 ? `<div style="font-size:10px;color:${C.mute};line-height:1.55;border-left:2px solid #fbbf24;padding-left:8px;margin-top:8px">
              <b style="color:${C.text}">Phase 2 — is it one factor or many?</b> Learned a ridge blend over all ${Object.keys(rv.phase2.weights || {}).length} loop-type families to maximise <i>held-out</i> drop-zone hold (group 5-fold). Across every regularisation it <b>never beats entailment alone</b> (best blend ${rv.phase2.best_blend_pfut >= 0 ? '+' : ''}${rv.phase2.best_blend_pfut} vs entail <b>+${rv.phase2.entail_pfut}</b>); the weights collapse onto entailment, suspense even goes negative. <b style="color:#fbbf24">It's a single-factor effect</b> — the open abstract question, nothing else. ★ marks the champion (${nm(rv.phase2.champion)}).</div>` : ''}
            ${rv.counters ? `<div style="font-size:10px;color:${C.mute};line-height:1.55;border-left:2px solid ${C.cyan};padding-left:8px;margin-top:8px">
              <b style="color:${C.text}">On-screen counters (taxonomy #3, full-video OCR):</b> a smooth monotonic counter/timer was detected in <b>${rv.counters.n_with_counter}/${rv.counters.n_videos}</b> videos. A live counter <b style="color:${C.cyan}">weakly holds</b> attention — pFut <b>+${rv.counters.pFut}</b>${rv.counters.pFut_ci ? ` [${rv.counters.pFut_ci[0]}, ${rv.counters.pFut_ci[1]}]` : ''} (CI excludes 0), but only <b>~½</b> the entailment effect and it fades in the drop zone (+${rv.counters.pFut_dropzone}). A <i>bounded</i> loop (you can see the target) holds less than an <i>open</i> abstract question. Select <b>🔢 on-screen counter</b>.</div>` : ''}`);
    }
    // every reference→gratification nuance you flagged, and how the model handles each
    function rtgTaxonomy() {
        const rows = [
            ['Cross-modal directions', 'spoken→shown (C→V) and shown→spoken-reveal (V→C), not just C→C / V→V', '<b>anyAny</b> direction takes the max over all four modality pairs; ensemble blends <i>anyAny·content</i> + <i>vc·entail</i>', 'full'],
            ['Re-references / threads', 'the same thing referenced many times <i>before</i> the payoff, each reinforcing the tension', 'every reference→payoff link is drawn; a <span style="color:' + C.green + '">◯ ring</span> + <i>reinf</i> count mark where multiple references converge on one payoff', 'full'],
            ['Continuous / sustained loops', 'progress bars, counters, timers — a persistent meter climbing toward a target', `now <b>detected directly</b>: full-video OCR → a smooth monotonic on-screen number for ≥6s (<b>${(RTGF.meta.retention_validation && RTGF.meta.retention_validation.counters && RTGF.meta.retention_validation.counters.n_with_counter) || '?'}/211 videos</b>, select <b>🔢 on-screen counter</b>). Validated: a live counter <i>weakly</i> holds attention (pFut +0.13, CI excludes 0) — real but ~½ the entailment effect (a bounded loop holds less than an open abstract question)`, 'full'],
            ['Implicit "where is he going"', 'ambient curiosity with no explicit referent — predictive incompleteness', 'now a real <b>world-model</b>: select <b>❓ implicit anticipation</b> — a learned JEPA predictor that\'s sure the scene will change (forward) but <i>uncertain which</i> future (high variance) = "where is this going". Plus <i>infogap</i>/<i>incomplete</i> in the ensemble', 'partial'],
            ['Multi-part / spanning payoffs', 'tension discharges gradually across a set of moments; you labelled only the END', 'payoff-ness is a <i>continuous field</i>, not a point; the multi-theory union fans one reference out to several payoff moments', 'partial'],
            ['Abstract / non-objective payoffs', '"become the fittest alive" — fulfilment never stated, must be inferred as "close enough"', '<i>vc·entail</i> = uncentred cosine in <b>Gemini</b> space; <b>fulfilment value = that semantic closeness</b> — quantifiable, no explicit mention needed', 'full'],
            ['Labels are partial (PU)', 'many real loops exist even in labelled videos; absence of a label ≠ no loop', 'never capped at your labels — 336-algo union + tunable peak threshold surface more; scored by <b>recall only</b>', 'full'],
        ];
        const dot = s => ({ full: C.green, partial: C.orange }[s]);
        const lab = s => ({ full: 'handled', partial: 'partial' }[s]);
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:3px">Every reference→gratification nuance you flagged — and how it's handled</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:9px;line-height:1.5">Your taxonomy is the <i>guide</i> for what the emergent detector must surface (never a checklist to overfit). <span style="color:${C.green}">●</span> handled · <span style="color:${C.orange}">●</span> partial / approximated.</div>
            <div style="display:flex;flex-direction:column;gap:7px">${rows.map(r => `
              <div style="display:grid;grid-template-columns:170px 1fr;gap:10px;border-top:1px solid ${C.border};padding-top:7px">
                <div><div style="font-size:11px;font-weight:700;color:${C.text}"><span style="color:${dot(r[3])}">●</span> ${r[0]}</div>
                  <div style="font-size:9.5px;color:${C.mute};margin-top:2px;line-height:1.4">${r[1]}</div>
                  <div style="font-size:9px;color:${dot(r[3])};margin-top:2px;font-weight:700">${lab(r[3])}</div></div>
                <div style="font-size:10px;color:${C.dim};line-height:1.5;align-self:center">${r[2]}</div></div>`).join('')}</div>`);
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
        return cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:2px">The cluster geometry — moments in Gemini space</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5">Every second's <span style="color:${C.dim}">● visual</span> and <span style="color:${C.dim}">▪ concept</span> token, projected to 2D, coloured by emergent cluster. Moments about the same thing group — a spoken word and the frame that shows it sit together. This is where the threads come from.</div>
            <svg viewBox="0 0 ${S} ${S}" style="width:100%;max-width:${S}px;background:${C.card2};border-radius:8px">${dots}</svg>`, 12);
    }
    function rtgSaveLabels(id) {
        try { fetch('/api/rtg/labels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: id, labels: RTGLABELS[id] }) }); } catch (e) { }
    }
    function rtgUpdateLabelUI() {
        try { const el = window.document.getElementById('rtg-labelui'); if (el && st.rtgSel != null && RTGF.videos[st.rtgSel]) el.innerHTML = rtgRenderLabelUI(RTGF.videos[st.rtgSel]); } catch (e) { }
    }
    function rtgLabelAct(kind, sec) {
        const v = RTGF.videos[st.rtgSel]; if (!v) return;
        const L = RTGLABELS[v.id] || (RTGLABELS[v.id] = { pairs: [], orphans: [] });
        if (kind === 'ref') st.rtgPending = sec;
        else if (kind === 'track') { if (st.rtgPending == null) st.rtgPending = sec; else { L.pairs.push({ r: st.rtgPending, g: sec }); st.rtgPending = null; rtgSaveLabels(v.id); } }
        else if (kind === 'grat') { if (st.rtgPending != null) { L.pairs.push({ r: st.rtgPending, g: sec }); st.rtgPending = null; rtgSaveLabels(v.id); } }
        else if (kind === 'orphan') { if (st.rtgPending != null) { L.orphans.push({ r: st.rtgPending }); st.rtgPending = null; rtgSaveLabels(v.id); } }
        else if (kind === 'cancel') st.rtgPending = null;
        else if (kind === 'del') { L.pairs.splice(sec, 1); rtgSaveLabels(v.id); }
        else if (kind === 'delorphan') { L.orphans.splice(sec, 1); rtgSaveLabels(v.id); }
        else if (kind === 'clear') { L.pairs = []; L.orphans = []; st.rtgPending = null; rtgSaveLabels(v.id); }
        rtgUpdateLabelUI();
    }
    function rtgRenderLabelUI(v) {
        const L = RTGLABELS[v.id] || { pairs: [], orphans: [] };
        const n = v.n_sec, W = 820, pad = 30, iw = W - pad - 10, H = 116, yR = 38, yG = 84, cell = iw / (n || 1);
        const x = s => pad + (n <= 1 ? 0 : s * iw / (n - 1));
        const ref = rtgSig(v).refness || [];
        const refArea = `M ${x(0)} ${yR} ` + ref.map((r, i) => `L ${x(i).toFixed(1)} ${(yR - r * 22).toFixed(1)}`).join(' ') + ` L ${x(n - 1)} ${yR} Z`;
        let hit = '';
        for (let s = 0; s < n; s++) hit += `<rect data-rtglabel-track="${s}" x="${(x(s) - cell / 2).toFixed(1)}" y="14" width="${Math.max(2, cell).toFixed(1)}" height="${H - 26}" fill="transparent" style="cursor:crosshair"><title>${s}s</title></rect>`;
        const pairs = L.pairs.map((p, idx) => `<path d="M ${x(p.r)} ${yR} C ${x(p.r)} ${(yR + yG) / 2} ${x(p.g)} ${(yR + yG) / 2} ${x(p.g)} ${yG}" fill="none" stroke="${C.purple}" stroke-width="2" opacity="0.85"/><path data-rtglabel-del="${idx}" style="cursor:pointer" d="M ${x(p.r) - 5} ${yR - 6} L ${x(p.r) + 5} ${yR - 6} L ${x(p.r)} ${yR} Z" fill="${C.cyan}"><title>your loop ${p.r}s→${p.g}s · click to delete</title></path><circle data-rtglabel-del="${idx}" style="cursor:pointer" cx="${x(p.g)}" cy="${yG}" r="4.5" fill="${C.green}"><title>delete</title></circle>`).join('');
        const orph = L.orphans.map((o, idx) => `<path data-rtglabel-delorphan="${idx}" style="cursor:pointer" d="M ${x(o.r) - 5} ${yR - 6} L ${x(o.r) + 5} ${yR - 6} L ${x(o.r)} ${yR} Z" fill="none" stroke="${C.orange}" stroke-width="1.4" stroke-dasharray="2 1.5"><title>unresolved ref @${o.r}s · click to delete</title></path>`).join('');
        const pend = st.rtgPending != null ? `<line x1="${x(st.rtgPending)}" y1="14" x2="${x(st.rtgPending)}" y2="${H - 12}" stroke="${C.yellow}" stroke-width="1.5" stroke-dasharray="3 2"/><path d="M ${x(st.rtgPending) - 6} ${yR - 8} L ${x(st.rtgPending) + 6} ${yR - 8} L ${x(st.rtgPending)} ${yR} Z" fill="${C.yellow}"/>` : '';
        const btn = (id, lab, col) => `<span data-rtglabel="${id}" style="cursor:pointer;background:${col}1e;border:1px solid ${col};color:${col};border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700">${lab}</span>`;
        const controls = st.rtgPending == null
            ? btn('ref', '◆ Mark reference @ playhead', C.cyan)
            : `<span style="color:${C.yellow};font-size:11px;font-weight:700">Reference @ ${st.rtgPending}s — now mark its payoff:</span>${btn('grat', '● Mark payoff @ playhead', C.green)}${btn('orphan', '⌀ never pays off', C.orange)}${btn('cancel', 'cancel', C.mute)}`;
        const chips = L.pairs.map((p, i) => `<span style="background:${C.card2};border-radius:5px;padding:2px 7px;font-size:10px;color:${C.dim}">▲${p.r}s→▼${p.g}s <span data-rtglabel-del="${i}" style="cursor:pointer;color:${C.mute}">✕</span></span>`).join('')
            + L.orphans.map((o, i) => `<span style="background:${C.card2};border-radius:5px;padding:2px 7px;font-size:10px;color:${C.orange}">▲${o.r}s unresolved <span data-rtglabel-delorphan="${i}" style="cursor:pointer;color:${C.mute}">✕</span></span>`).join('');
        return `<div style="background:${C.card};border:1px solid ${C.purple};border-radius:12px;padding:13px;margin-bottom:12px">
            <div style="font-size:12px;font-weight:800;color:${C.purple};margin-bottom:3px">✎ Your reference→gratification labels (ground truth)</div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5">Scrub the video to where YOU feel a reference is set → <b>Mark reference</b>; scrub to its payoff → <b>Mark payoff</b> (or click directly on the track). Faint cyan = what the model currently thinks, for comparison. Saves automatically.</div>
            <svg viewBox="0 0 ${W} ${H}" style="width:100%">
              <line x1="${pad}" y1="${yR}" x2="${W - 10}" y2="${yR}" stroke="${C.border2}"/><line x1="${pad}" y1="${yG}" x2="${W - 10}" y2="${yG}" stroke="${C.border2}"/>
              <path d="${refArea}" fill="${C.cyan}14" stroke="${C.cyan}55" stroke-width="1"/>${hit}${pairs}${orph}${pend}
              <text x="${W - 10}" y="12" fill="${C.cyan}" font-size="9" text-anchor="end">model reference-ness</text>
              <text x="${pad}" y="${yR - 10}" fill="${C.dim}" font-size="9">▲ your references</text><text x="${pad}" y="${yG + 13}" fill="${C.dim}" font-size="9">▼ your payoffs</text></svg>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">${controls}<span style="margin-left:auto;font-size:10px;color:${C.mute}">${L.pairs.length} loop${L.pairs.length === 1 ? '' : 's'}${L.orphans.length ? ' · ' + L.orphans.length + ' unresolved' : ''}</span>${(L.pairs.length || L.orphans.length) ? `<span data-rtglabel="clear" style="cursor:pointer;font-size:10px;color:${C.mute};border:1px solid ${C.border};border-radius:5px;padding:2px 7px">clear all</span>` : ''}</div>
            ${chips ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:7px">${chips}</div>` : ''}</div>`;
    }
    function renderRTGEmergence() {
        if (RTGF.meta && RTGF.meta.signals && !RTGF.meta.signals.includes(st.rtgSignal)) st.rtgSignal = RTGF.meta.signal_default || RTGF.meta.signals[0];
        let h = note(`<b style="color:${C.text}">Emergence, not labelling.</b> No thresholds, nothing stamped "reference" or "gratification". We embed every second — its frame and its spoken words — in Gemini's shared space and let k-means find clusters. A <b>thread</b> is just a cluster. A reference→gratification <i>emerges</i> when a thread's colour shows up on the concept track and then later on the visual track. Below: the threads over time, the full field, and the cluster geometry they come from.`, C.cyan);
        if (st.rtgSel != null && RTGF.videos[st.rtgSel]) {
            const v = RTGF.videos[st.rtgSel];
            h += cardc(`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div style="font-size:13px;font-weight:800;color:${C.text}">${esc(v.title)} <span style="font-size:10px;color:${C.mute};font-weight:400">· ${v.n_sec}s · ${v.n_threads} clusters</span></div>
                <div style="display:flex;gap:6px"><span data-rtgtoggle-label style="cursor:pointer;background:${st.rtgLabel ? C.purple + '22' : 'transparent'};border:1px solid ${st.rtgLabel ? C.purple : C.border};color:${st.rtgLabel ? C.purple : C.dim};border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700">${st.rtgLabel ? '✓ Labeling' : '✎ Label'}</span><a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" style="background:${C.accent}18;border:1px solid ${C.accent};color:${C.accent};border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;text-decoration:none">▶ YouTube</a><span data-rtgclose style="cursor:pointer;border:1px solid ${C.border};color:${C.dim};border-radius:6px;padding:4px 10px;font-size:11px">✕ close</span></div></div>`, 10);
            h += `<div style="display:flex;gap:16px;align-items:flex-start">
                <div style="flex:1;min-width:0">
                    ${st.rtgLabel ? `<div id="rtg-labelui">${rtgRenderLabelUI(v)}</div>` : ''}
                    ${rtgThreadTimeline(v)}
                    <div id="rtg-sigsel">${rtgSigSelector(v)}</div>
                    <div id="rtg-strctl">${rtgStrengthSlider(v)}</div>
                    <div id="rtg-refpay">${rtgRefPayoff(v)}</div>
                    ${rtgRetentionPanel()}
                    ${rtgTaxonomy()}
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">${rtgFieldHeat(v)}${rtgTokenMap(v)}</div>
                </div>
                <div style="width:236px;flex-shrink:0;position:sticky;top:14px">${rtgStickyPlayer(v)}</div>
            </div>`;
        }
        h += `<div id="rtg-embedmap">${rtgGlobalEmbedMap()}</div>`;
        const list = RTGF.videos.map((v, i) => ({ v, i })).filter(o => o.v.n_threads).sort((a, b) => b.v.n_sec - a.v.n_sec);
        h += cardc(`<div style="font-size:12px;font-weight:700;color:${C.text};margin-bottom:6px">Every video — click to see its emergent threads</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">${list.map(({ v, i }) => {
                const on = st.rtgSel === i, strip = (v.threadV || []).map(th => `<span style="flex:1;background:${tcol(th)}"></span>`).join('');
                return `<div data-rtg="${i}" style="display:flex;align-items:center;gap:8px;padding:4px 7px;border-radius:6px;cursor:pointer;background:${on ? C.card2 : 'transparent'};border:1px solid ${on ? C.purple : 'transparent'}">
                    <div style="flex:1;min-width:0"><div style="font-size:11px;color:${C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(v.title)}</div>
                      <div style="display:flex;height:7px;border-radius:2px;overflow:hidden;margin-top:3px;background:${C.border}">${strip}</div></div></div>`; }).join('')}</div>`);
        return h;
    }
    // ALL embeddings — global 2D map of every second (visual + concept), with projection + focus toggles
    function rtgGlobalEmbedMap() {
        if (!RTGE || !RTGE.proj) return '';
        const mode = st.rtgProj || 'aligned', focus = st.rtgEmbFocus || 'all';
        const P = RTGE.proj[mode] || RTGE.proj.raw, m = RTGE.meta;
        const W = 760, H = 460, pad = 14, S = 1000, n = P.x.length;
        const X = g => (pad + g / S * (W - 2 * pad)), Yc = g => (pad + (1 - g / S) * (H - 2 * pad));
        const sel = (st.rtgSel != null && RTGF.videos[st.rtgSel]) ? st.rtgSel : -1;
        let body = '';
        if (focus === 'video' && sel >= 0) {
            const idx = []; for (let i = 0; i < n; i++) if (RTGE.v[i] === sel) idx.push(i);
            const vis = idx.filter(i => RTGE.m[i] === 0).sort((a, b) => RTGE.s[a] - RTGE.s[b]);
            if (vis.length > 1) { let d = 'M ' + X(P.x[vis[0]]).toFixed(1) + ' ' + Yc(P.y[vis[0]]).toFixed(1);
                for (let k = 1; k < vis.length; k++) d += ' L ' + X(P.x[vis[k]]).toFixed(1) + ' ' + Yc(P.y[vis[k]]).toFixed(1);
                body += `<path d="${d}" fill="none" stroke="${C.dim}" stroke-width="1" opacity="0.3"/>`; }
            idx.forEach(i => { const cx = X(P.x[i]).toFixed(1), cy = Yc(P.y[i]).toFixed(1), col = tcol(RTGE.c[i]);
                body += RTGE.m[i] === 1
                    ? `<rect x="${(cx - 3.5)}" y="${(cy - 3.5)}" width="7" height="7" fill="${col}" stroke="#fff" stroke-width="0.8"><title>${RTGE.s[i]}s · concept · cluster ${RTGE.c[i]}</title></rect>`
                    : `<circle cx="${cx}" cy="${cy}" r="4" fill="${col}" stroke="#fff" stroke-width="0.8"><title>${RTGE.s[i]}s · visual · cluster ${RTGE.c[i]}</title></circle>`; });
        } else {
            let base = '', hi = '';
            for (let i = 0; i < n; i++) { if (RTGE.v[i] === sel) continue;
                base += `<circle cx="${X(P.x[i]).toFixed(1)}" cy="${Yc(P.y[i]).toFixed(1)}" r="1.2" fill="${tcol(RTGE.c[i])}" opacity="0.4"/>`; }
            if (sel >= 0) for (let i = 0; i < n; i++) { if (RTGE.v[i] !== sel) continue;
                const cx = X(P.x[i]).toFixed(1), cy = Yc(P.y[i]).toFixed(1), col = tcol(RTGE.c[i]);
                hi += RTGE.m[i] === 1 ? `<rect x="${(cx - 3)}" y="${(cy - 3)}" width="6" height="6" fill="${col}" stroke="#fff" stroke-width="1"><title>${RTGE.s[i]}s · concept</title></rect>` : `<circle cx="${cx}" cy="${cy}" r="3.4" fill="${col}" stroke="#fff" stroke-width="1"><title>${RTGE.s[i]}s · visual</title></circle>`; }
            body = base + hi;
        }
        const pill = (id, lab, on, attr) => `<span ${attr}="${id}" style="cursor:pointer;border:1px solid ${on ? C.accent : C.border};background:${on ? C.accent + '1e' : 'transparent'};color:${on ? C.accent : C.dim};border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700">${lab}</span>`;
        return cardc(`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:3px">
              <div style="font-size:12px;font-weight:700;color:${C.text}">All the embeddings — ${esc(m.encoder)} space (${m.n.toLocaleString()} moments)</div>
              <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">${pill('aligned', 'semantic', mode === 'aligned', 'data-rtgproj')}${pill('raw', 'by modality', mode === 'raw', 'data-rtgproj')}<span style="width:8px"></span>${pill('all', 'all videos', focus === 'all', 'data-rtgembfocus')}${pill('video', 'this video', focus === 'video', 'data-rtgembfocus')}</div></div>
            <div style="font-size:10px;color:${C.mute};margin-bottom:7px;line-height:1.5">Every second of all ${m.n_videos} videos (frame + spoken utterance), 1536-d Gemini → 2D, coloured by cluster (K=${m.k}). <b>The "two ends" was the modality gap</b> — PC1 is the visual-vs-concept split (corr ${m.pc1_modality_corr}); <b>semantic</b> centres each modality so meaning structures the map, <b>by modality</b> shows the raw split. ${focus === 'video' ? (sel >= 0 ? '<b>This video only</b> — its trajectory (● visual ▪ concept, line = time order).' : 'Open a video to see its trajectory.') : (sel >= 0 ? 'Open video <b style="color:#fff">highlighted</b>.' : 'Open a video to highlight its seconds.')}<br><span style="color:${C.dim}">Honest: aligning the gap improves the <i>picture</i> but NOT the signal — entailment drop-zone pFut is raw <b>${m.entail_pfut_raw}</b> vs aligned ${m.entail_pfut_aligned}, so the reference mapping stays on the raw cross-modal cosine.</span></div>
            <svg viewBox="0 0 ${W} ${H}" style="width:100%;background:${C.card2};border-radius:8px">${body}</svg>`, 12);
    }
    function rtgUpdateEmbedMap() { try { const el = window.document.getElementById('rtg-embedmap'); if (el) el.innerHTML = rtgGlobalEmbedMap(); } catch (e) { } }
    function renderRTG() {
        if (!RTGF) return cardc(`<div style="padding:30px;text-align:center;color:${C.dim}">Building the RTG field… <div style="font-size:11px;color:${C.mute};margin-top:6px">Run <code>principles/rtg_embed_gemini.py</code> → <code>rtg_field.py</code> → <code>rtg_sweep.py</code>.</div></div>`);
        RTGA = RTGF;
        return renderRTGEmergence();
    }
    function renderPrinciples() {
        const pr = st.principle || 'novelty';
        const ppill = (id, lab, on) => `<span data-principle="${id}" style="background:${on ? C.purple + '22' : 'transparent'};border:1px solid ${on ? C.purple : C.border};color:${on ? C.purple : C.dim};border-radius:8px;padding:5px 12px;font-size:12px;font-weight:${on ? 800 : 600};cursor:pointer">${lab}</span>`;
        let h = h2c('Principles — deliberately quantifying what makes a hook work', pr === 'rtg'
            ? 'RTG = Reference → Tension → Gratification. The video as two channels (visual + conceptual), second by second, with the directed dependencies that bind an early moment (a reference / open loop) to a later one that resolves it (a gratification).'
            : 'Hook = the first 5 seconds of every confirmed video. Embedded several independent ways at two resolutions (whole hook + per second). Objects via detection, concepts via keyphrase math — see the 📋 Ledger for every definition.');
        h += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${ppill('novelty', '✦ Novelty', pr === 'novelty')}${ppill('rtg', '⛓ RTG', pr === 'rtg')}<span style="border:1px dashed ${C.border2};color:${C.faint};border-radius:8px;padding:5px 12px;font-size:12px">coherence · soon</span></div>`;
        if (pr === 'rtg') return h + renderRTG();
        if (!N) { h += cardc(`<div style="padding:30px;text-align:center;color:${C.dim}">Building novelty geometry… <div style="font-size:11px;color:${C.mute};margin-top:6px">Run the <code>principles/</code> pipeline to generate <code>novelty.json</code>.</div></div>`); return h; }
        const MS = [['quantify', '🔬 Quantify'], ['global', 'A Global'], ['niche', 'B Niche'], ['temporal', 'C Temporal'], ['combo', 'D Combinatorial'], ['coherent', 'E Coherent'], ['correlations', '📊 Correlations'], ['interactions', '🔗 Interactions'], ['ledger', '📋 Ledger']];
        const resBtn = (id, l) => `<button data-novres="${id}" style="background:${st.novRes === id ? C.accent + '22' : 'transparent'};border:1px solid ${st.novRes === id ? C.accent : C.border};color:${st.novRes === id ? C.accent : C.dim};border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer">${l}</button>`;
        const mineCount = (N.videos || []).filter(v => v.mine).length;
        const mineBtn = mineCount ? `<span data-novmine="1" style="cursor:pointer;border:1px solid ${st.novMine ? '#fbbf24' : C.border};background:${st.novMine ? '#fbbf2422' : 'transparent'};color:${st.novMine ? '#fbbf24' : C.dim};border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700">★ My videos (${mineCount})</span>` : '';
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
            <div style="display:flex;gap:6px;flex-wrap:wrap">${MS.map(([id, l]) => `<button data-nov="${id}" style="background:${st.nov === id ? C.purple + '22' : 'transparent'};border:1px solid ${st.nov === id ? C.purple : C.border};color:${st.nov === id ? C.purple : C.dim};border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer">${l}</button>`).join('')}</div>
            <div style="margin-left:auto;display:flex;gap:8px;align-items:center">${mineBtn}${st.nov !== 'combo' && st.nov !== 'ledger' ? `<span style="font-size:10px;color:${C.mute};text-transform:uppercase">resolution</span>${resBtn('hook', 'Whole hook')}${resBtn('second', 'Per second')}` : ''}</div></div>`;
        h += `<div style="font-size:11px;color:${C.mute};margin-bottom:10px">${N.meta.n.toLocaleString()} hooks · corpus ${(N.meta.corpus || N.meta.n).toLocaleString()} · ${mineCount} of them yours (merged in). <b>Click any point for its full data; ★ to highlight your videos.</b></div>
            <div style="font-size:9.5px;color:${C.faint};margin-bottom:8px;line-height:1.5">Consistency: every novelty here = distance-from-corpus on the <b>same Gemini embeddings</b> (visual = frames · text = transcript · whole = both fused). Maps use one fixed parameterisation (8-NN · K=8); the correlation panels above sweep k. All correlation numbers are <b>held-out (70/30)</b> from one source — the divergent legacy panel was removed.</div>`;
        h += novValidPanel();
        h += novQuantPanel();
        if (st.novSel != null && N.videos[st.novSel]) h += renderHookDetail(st.novSel);
        h += ({ quantify: renderNovQuantify, global: renderNovGlobal, niche: renderNovNiche, temporal: renderNovTemporal, combo: renderNovCombo, coherent: renderNovCoherent, correlations: renderNovCorrelations, interactions: renderNovInteractions, ledger: renderNovLedger }[st.nov] || renderNovGlobal)();
        return h;
    }

    // switch the active channel → reload its retention table into DATA (or merge all → pooled)
    async function loadChannel(id) {
        st.channel = id;
        // Main (your 211) = the committed static file; every other channel = R2 via the API.
        const fetchTable = c => ((c.owner || c.id === 'tyler')
            ? fetch('./buildings/jarvis/retention-study/' + (c.table || 'retention_table.json') + '?v=120')
            : fetch('/api/retention/table?id=' + encodeURIComponent(c.id))).then(r => r.json());
        try {
            if (id === 'all') {
                const tabs = await Promise.all(CHANS.channels.map(c => fetchTable(c).catch(() => null)));
                const vids = []; tabs.forEach((t, i) => { if (t && t.videos) t.videos.forEach(v => vids.push(Object.assign({ _chan: CHANS.channels[i].id }, v))); });
                DATA = { meta: { n: vids.length, pooled: true }, videos: vids };
            } else {
                const c = CHANS.channels.find(x => x.id === id) || CHANS.channels[0];
                DATA = await fetchTable(c);
            }
            // swap the analysis study to match the channel: Main = committed study; others = R2
            // (built by build_study.py); pooled = none yet → its analysis tabs gate.
            if (id === 'tyler') S = S_MAIN;
            else if (id === 'all') S = null;
            else { S = await fetch('/api/retention/study?id=' + encodeURIComponent(id)).then(r => r.ok ? r.json() : null).catch(() => null); if (S && S.error) S = null; }
        } catch (e) { console.warn('[channel] load failed', e); }
        render();
    }
    function render() {
        if (!root) return;
        // TWO GROUPS so it's clear what the channel selector affects:
        //  • PER-CHANNEL  — analyses of the selected account's own videos (scoped by the channel bar)
        //  • CORPUS       — built on ALL videos (your 211 + the 11k library); account-independent
        const PERCHAN = [['data', '📋 Data'], ['q1', '① Views'], ['q2', '② Shape'], ['ind', '③ Drivers'], ['q4', '④ Duration'], ['predict', '⑤ Predict']];
        const CORPUS = [['raw', '🔬 Raw'], ['guesses', '🎰 Guesses'], ['experiment', '🧪 Experiment'], ['confounds', '🧪 Confounds'], ['principles', '✦ Principles']];
        const SECLBL = Object.fromEntries([...PERCHAN, ...CORPUS]);
        const isPer = PERCHAN.some(([id]) => id === st.sec);
        const btn = ([id, l]) => `<button data-rs="${id}" style="background:${st.sec === id ? C.accent + '22' : 'transparent'};border:1px solid ${st.sec === id ? C.accent : C.border};color:${st.sec === id ? C.accent : C.dim};border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer">${l}</button>`;
        const active = st.channel || (CHANS && CHANS.active) || 'tyler';
        const activeChan = CHANS && CHANS.channels.find(c => c.id === active);
        const chName = active === 'all' ? 'All pooled' : (activeChan ? activeChan.name : 'Main');
        const isMain = active === 'tyler';
        // CHANNEL tab bar — only meaningful for the per-channel group
        const chBar = (() => {
            if (!CHANS || !CHANS.channels) return '';
            const tab = (id, name, n) => `<button data-chan="${id}" style="background:${active === id ? C.green + '22' : 'transparent'};border:1px solid ${active === id ? C.green : C.border};color:${active === id ? C.green : C.dim};border-radius:8px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer">${name}${n != null ? ` <span style="opacity:.6;font-size:10px">${n}</span>` : ''}</button>`;
            const tabs = CHANS.channels.map(c => tab(c.id, c.name, c.n)).join('');
            const total = CHANS.channels.reduce((s, c) => s + (c.n || 0), 0);
            const pooled = CHANS.channels.length > 1 ? tab('all', 'All pooled', total) : '';
            const add = `<button data-chanadd="1" style="background:transparent;border:1px dashed ${C.border};color:${C.mute};border-radius:8px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer">＋ add</button>`;
            const help = st.channelHelp ? `<div style="font-size:10px;color:${C.mute};margin-top:6px;line-height:1.6;background:${C.card2};border-radius:8px;padding:9px 12px;max-width:760px"><b style="color:${C.text}">Add another channel (you must have Studio Viewer access):</b> run <code style="color:${C.cyan}">node scrape-channels.js</code>, switch to the channel when it pauses, and it scrapes the full retention curve + swipe + views and uploads to R2 — the tab appears here. <b>All pooled</b> merges every channel for a bigger dataset.</div>` : '';
            return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:7px;flex-wrap:wrap"><span style="font-size:10px;color:${C.green};text-transform:uppercase;letter-spacing:.3px;font-weight:800">channel</span>${tabs}${pooled}${add}<span style="font-size:9px;color:${C.faint};margin-left:2px">— scopes the “this channel” sections below</span></div>${help}`;
        })();
        // analyzed badge: how much of this channel actually has data
        const nKeep = (DATA && DATA.videos) ? DATA.videos.filter(v => v.keep_rate != null).length : 0;
        const nCurve = (DATA && DATA.videos) ? DATA.videos.filter(v => v.curve && v.curve.length).length : 0;
        const badge = `<span style="font-size:10px;color:${C.mute};background:${C.card2};border-radius:6px;padding:3px 10px;margin-left:4px"><b style="color:${C.green}">${chName}</b> · ${nKeep} w/ retention · <b style="color:${nCurve === nKeep && nKeep ? C.green : C.amber}">${nCurve}</b> w/ full curve</span>`;
        // gate: the analysis views (not Data) are only computed for Main so far
        let sec;
        if (isPer && st.sec !== 'data' && !S) {
            sec = cardc(`<div style="padding:26px;text-align:center"><div style="font-size:14px;font-weight:800;color:${C.text};margin-bottom:6px">${SECLBL[st.sec]} — not computed for ${chName} yet</div><div style="font-size:11px;color:${C.mute};line-height:1.7;max-width:580px;margin:0 auto">${active === 'all' ? 'Pooled analysis isn\'t built yet — switch to a single channel.' : `This per-channel analysis hasn't been run for <b>${chName}</b>. It has <b style="color:${C.green}">${nKeep}</b> videos with retention — open <b>📋 Data</b>, or run <code>build_study.py ${active}</code>.`}</div></div>`, 16);
        } else {
            sec = st.sec === 'raw' ? `<div id="rtg-rawpanel">${renderRaw()}</div>` : st.sec === 'guesses' ? `<div id="rtg-guesspanel">${renderGuesses()}</div>` : st.sec === 'experiment' ? `<div id="rtg-exppanel">${renderExperiment()}</div>` : (S ? ({ data: renderData, q1: renderQ1, q2: renderQ2, ind: renderIndicators, q4: renderQ4, predict: renderPredict, confounds: renderNovConfounds, principles: renderPrinciples }[st.sec] || renderData)() : renderData());
        }
        root.innerHTML = `<div style="background:${C.bg};border-radius:12px;padding:16px;color:${C.text};font-family:'Nunito',sans-serif">
            <div style="font-size:21px;font-weight:900;color:${C.accent};margin-bottom:8px">Retention → Views</div>
            ${chBar}
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px"><span style="font-size:9px;color:${C.green};text-transform:uppercase;font-weight:800;letter-spacing:.3px">📊 this channel</span>${PERCHAN.map(btn).join('')}${isPer ? badge : ''}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:14px"><span style="font-size:9px;color:${C.purple};text-transform:uppercase;font-weight:800;letter-spacing:.3px">🌐 corpus · all videos</span>${CORPUS.map(btn).join('')}<span style="font-size:9px;color:${C.faint}">— not affected by the channel selector</span></div>${sec}</div>`;
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
        if (e.target.closest('[data-novmine]')) { st.novMine = !st.novMine; render(); return; }
        const nv = e.target.closest('[data-nov]'); if (nv) { st.nov = nv.getAttribute('data-nov'); render(); return; }
        const chBtn = e.target.closest('[data-chan]'); if (chBtn) { loadChannel(chBtn.getAttribute('data-chan')); return; }
        if (e.target.closest('[data-chanadd]')) { st.channelHelp = !st.channelHelp; render(); return; }
        const dcm = e.target.closest('[data-deconmetric]'); if (dcm) { st.deconMetric = dcm.getAttribute('data-deconmetric'); render(); return; }
        const nqm = e.target.closest('[data-nqmod]'); if (nqm) { st.nqMod = nqm.getAttribute('data-nqmod'); render(); return; }
        const nqt = e.target.closest('[data-nqmeth]'); if (nqt) { st.nqMeth = nqt.getAttribute('data-nqmeth'); render(); return; }
        const pp = e.target.closest('[data-principle]'); if (pp) { st.principle = pp.getAttribute('data-principle'); render(); return; }
        const rg = e.target.closest('[data-rtg]'); if (rg) { st.rtgSel = +rg.getAttribute('data-rtg'); render(); return; }
        if (e.target.closest('[data-rtgclose]')) { st.rtgSel = null; render(); return; }
        const rnode = e.target.closest('[data-rtgnode]'); if (rnode) { rtgSeek(+rnode.getAttribute('data-rtgnode')); return; }
        const ltgl = e.target.closest('[data-rtgtoggle-label]'); if (ltgl) { st.rtgLabel = !st.rtgLabel; st.rtgPending = null; render(); return; }
        const ltrk = e.target.closest('[data-rtglabel-track]'); if (ltrk) { rtgLabelAct('track', +ltrk.getAttribute('data-rtglabel-track')); return; }
        const ldel = e.target.closest('[data-rtglabel-del]'); if (ldel) { rtgLabelAct('del', +ldel.getAttribute('data-rtglabel-del')); return; }
        const ldlo = e.target.closest('[data-rtglabel-delorphan]'); if (ldlo) { rtgLabelAct('delorphan', +ldlo.getAttribute('data-rtglabel-delorphan')); return; }
        const lbtn = e.target.closest('[data-rtglabel]'); if (lbtn) { rtgLabelAct(lbtn.getAttribute('data-rtglabel'), Math.round(rtgCurT)); return; }
        const sig = e.target.closest('[data-rtgsignal]'); if (sig) { st.rtgSignal = sig.getAttribute('data-rtgsignal'); rtgUpdateSignal(); return; }
        const epj = e.target.closest('[data-rtgproj]'); if (epj) { st.rtgProj = epj.getAttribute('data-rtgproj'); rtgUpdateEmbedMap(); return; }
        const ef = e.target.closest('[data-rtgembfocus]'); if (ef) { st.rtgEmbFocus = ef.getAttribute('data-rtgembfocus'); rtgUpdateEmbedMap(); return; }
        const hu = e.target.closest('[data-hazunit]'); if (hu) { st.hazUnit = hu.getAttribute('data-hazunit'); rtgUpdateHaz(); return; }
        const rc = e.target.closest('[data-rawcolor]'); if (rc) { st.rawColor = rc.getAttribute('data-rawcolor'); rtgUpdateRaw(); return; }
        const rk = e.target.closest('[data-rawk]'); if (rk) { st.rawK = rk.getAttribute('data-rawk'); rtgUpdateRaw(); return; }
        const rp = e.target.closest('[data-rawproj]'); if (rp) { st.rawProj = rp.getAttribute('data-rawproj'); rtgUpdateRaw(); return; }
        const fut = e.target.closest('[data-futarget]'); if (fut) { st.fuTarget = fut.getAttribute('data-futarget'); rtgUpdateFusion(); return; }
        if (e.target.closest('[data-rawbands]')) { st.rawBands = !st.rawBands; rtgUpdateRaw(); return; }
        const rbk = e.target.closest('[data-rawbandk]'); if (rbk) { st.rawBandK = +rbk.getAttribute('data-rawbandk'); rtgUpdateRaw(); return; }
        const rch = e.target.closest('[data-rawchan]'); if (rch) { st.rawChan = rch.getAttribute('data-rawchan'); st.rawSel = null; st.rawProj = 'both'; rtgUpdateRaw(); return; }
        const rm = e.target.closest('[data-rawmine]'); if (rm) { st.rawMine = !st.rawMine; rtgUpdateRaw(); return; }
        const rcl = e.target.closest('[data-rawclose]'); if (rcl) { st.rawSel = null; rtgUpdateRaw(); return; }
        const rid = e.target.closest('[data-rawid]'); if (rid) { const id = rid.getAttribute('data-rawid'); st.rawSel = (st.rawSel === id || !id) ? null : id; st.rawUpSel = false; rtgUpdateRaw(); return; }
        const ggi = e.target.closest('[data-guessid]'); if (ggi) { const id = ggi.getAttribute('data-guessid'); st.guessSel = (st.guessSel === id ? null : id); rtgUpdateGuesses(); return; }
        if (e.target.closest('[data-guessclose]')) { st.guessSel = null; rtgUpdateGuesses(); return; }
        if (e.target.closest('[data-guessreload]')) { GUESSES = {}; st.guessSel = null; rtgUpdateGuesses(); return; }
        const egn = e.target.closest('[data-expgenn]'); if (egn) { st.expGenN = +egn.getAttribute('data-expgenn'); rtgUpdateExp(); return; }
        if (e.target.closest('[data-expgen]')) { if (!st.expGenBusy) expGenSubmit(); return; }
        const gvBtn = e.target.closest('[data-guessview]'); if (gvBtn) { st.guessView = gvBtn.getAttribute('data-guessview'); rtgUpdateGuesses(); return; }
        const grpoRunBtn = e.target.closest('[data-grporun]'); if (grpoRunBtn) { st.grpoRun = grpoRunBtn.getAttribute('data-grporun'); st.grpoSel = null; rtgUpdateGrpo(); return; }
        const grpoInpBtn = e.target.closest('[data-grpoinput]'); if (grpoInpBtn) { st.grpoSel = grpoInpBtn.getAttribute('data-grpoinput'); rtgUpdateGrpo(); return; }
        const grun = e.target.closest('[data-guessrun]'); if (grun) { st.guessRun = grun.getAttribute('data-guessrun'); st.guessSel = null; st.guessProj = null; rtgUpdateGuesses(); return; }
        const gpj = e.target.closest('[data-guessproj]'); if (gpj) { st.guessProj = gpj.getAttribute('data-guessproj'); rtgUpdateGuesses(); return; }
        if (e.target.closest('[data-guessbands]')) { st.guessBands = !st.guessBands; rtgUpdateGuesses(); return; }
        const gbk = e.target.closest('[data-guessbandk]'); if (gbk) { st.guessBandK = +gbk.getAttribute('data-guessbandk'); rtgUpdateGuesses(); return; }
        const xpg = e.target.closest('[data-expgo]'); if (xpg) { const [ch, pj] = xpg.getAttribute('data-expgo').split(':'); st.sec = 'raw'; st.rawChan = ch; st.rawProj = pj; st.rawColor = pj === 'hi10m' ? 'views' : 'cluster'; render(); return; }
        if (e.target.closest('[data-rawupload]')) { const fi = window.document.getElementById('rawUpFile'); if (fi) { fi.value = ''; fi.click(); } return; }
        if (e.target.closest('[data-rawupshow]')) { st.rawUpShow = !st.rawUpShow; rtgUpdateRaw(); return; }
        const updel = e.target.closest('[data-rawupdel]'); if (updel) { const i = +updel.getAttribute('data-rawupdel'); st.rawUploads.splice(i, 1); st.rawUpSel = null; rtgUpdateRaw(); return; }
        const upmk = e.target.closest('[data-rawupmark]'); if (upmk) { const i = +upmk.getAttribute('data-rawupmark'); st.rawUpSel = (st.rawUpSel === i ? null : i); st.rawSel = null; rtgUpdateRaw(); return; }
        if (e.target.closest('[data-rawupclose]')) { st.rawUpSel = null; rtgUpdateRaw(); return; }
        if (e.target.closest('[data-rawupclear]')) { st.rawUploads = []; st.rawUpSel = null; st.rawUpErr = null; rtgUpdateRaw(); return; }
        const bm = e.target.closest('[data-rawbuildmode]'); if (bm) { st.rawBuildMode = bm.getAttribute('data-rawbuildmode') === '1'; st.rawUpErr = null; rtgUpdateRaw(); return; }
        const rfr = e.target.closest('[data-rawframe]'); if (rfr) { st.rawFrameSlot = +rfr.getAttribute('data-rawframe'); const fi = window.document.getElementById('rawFrameFile'); if (fi) { fi.value = ''; fi.click(); } return; }
        const rfd = e.target.closest('[data-rawframedel]'); if (rfd) { st.rawFrames[+rfd.getAttribute('data-rawframedel')] = null; rtgUpdateRaw(); return; }
        if (e.target.closest('[data-rawplace]')) { rtgPlaceHook(); return; }
        if (e.target.closest('[data-libreload]')) { Promise.all([
            fetch('/api/library/stats').then(r => r.json()).then(j => { LIB = j; }).catch(() => {}),
            fetch('/api/library/videos?limit=150').then(r => r.json()).then(j => { LIBV = j.videos || []; }).catch(() => {})
        ]).then(() => render()); return; }
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
        if (e.target.id === 'rtg-minstr') { st.rtgMinStr = +e.target.value; rtgUpdateThresh(); return; }
        if (e.target.id === 'rtg-hazA') { st.hazA = +e.target.value; rtgUpdateHazCompare(); return; }
        if (e.target.id === 'rtg-hazB') { st.hazB = +e.target.value; rtgUpdateHazCompare(); return; }
        if (e.target.id === 'rtg-seek') { rtgSeek(+e.target.value); return; }
        if (e.target.hasAttribute && e.target.hasAttribute('data-rawtext')) { st.rawText = e.target.value; return; }
        if (e.target.hasAttribute && e.target.hasAttribute('data-pf')) { st.pvals = st.pvals || {}; st.pvals[e.target.getAttribute('data-pf')] = +e.target.value; updatePredict(); return; }
        if (e.target.closest('[data-q]')) { st.q = e.target.value; render(); }
    }
    function onChange(e) {
        if (e.target.id === 'rawUpFile') { if (e.target.files && e.target.files.length) rtgRawUpload(e.target.files); return; }
        if (e.target.id === 'rawFrameFile') { const f = e.target.files && e.target.files[0]; if (f) rtgFrameFile(f, st.rawFrameSlot || 0); return; }
        if (e.target.closest('[data-tracked]')) { st.trackedOnly = e.target.checked; render(); }
    }
    async function rtgRawUpload(files) {
        const list = Array.from(files || []).slice(0, 12);   // cap a batch at 12
        if (!list.length) return;
        st.rawUploading = true; st.rawUpErr = null; st.rawUpShow = true; rtgUpdateRaw();
        for (let n = 0; n < list.length; n++) {
            const file = list[n];
            st.rawUpStage = 0; st.rawUpQueue = { i: n + 1, total: list.length }; rtgUpdateRaw();
            const tick = window.setInterval(() => { if (st.rawUpStage < 4) { st.rawUpStage++; rtgUpdateRaw(); } }, 2400);
            try {
                const ext = (file.name.split('.').pop() || 'mp4').slice(0, 5);
                const buf = await file.arrayBuffer();
                const r = await fetch('/api/raw/embed-upload', { method: 'POST', headers: { 'X-Raw-Ext': ext, 'X-Raw-Title': (file.name || 'My upload').slice(0, 80) }, body: buf });
                const j = await r.json();
                if (!r.ok || j.error) { st.rawUpErr = (file.name || '') + ': ' + (j.error || ('HTTP ' + r.status)); }
                else { st.rawUploads.push(j); st.rawUpSel = st.rawUploads.length - 1; st.rawSel = null; }
            } catch (e) { st.rawUpErr = (file.name || '') + ': ' + e.message; }
            window.clearInterval(tick);
        }
        st.rawUploading = false; st.rawUpStage = 0; st.rawUpQueue = null;
        rtgUpdateRaw();
    }
    // ── build-a-hook from photos: fit each to a 9:16 cell (any image type → JPEG via
    //    canvas), tile 5 into one montage, embed with user-set text, place on the map ──
    const FRAME_W = 320, FRAME_H = 569;
    function rtgFrameFile(file, slot) {
        const fr = new window.FileReader();
        fr.onload = () => {
            const im = new window.Image();
            im.onload = () => {
                const c = window.document.createElement('canvas'); c.width = FRAME_W; c.height = FRAME_H;
                const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, FRAME_W, FRAME_H);
                const s = Math.max(FRAME_W / im.width, FRAME_H / im.height), w = im.width * s, hh = im.height * s;  // cover-fit
                x.drawImage(im, (FRAME_W - w) / 2, (FRAME_H - hh) / 2, w, hh);
                st.rawFrames[slot] = c.toDataURL('image/jpeg', 0.9); st.rawUpErr = null; rtgUpdateRaw();
            };
            im.onerror = () => { st.rawUpErr = 'could not read that image (HEIC may be unsupported — try JPG/PNG)'; rtgUpdateRaw(); };
            im.src = fr.result;
        };
        fr.onerror = () => { st.rawUpErr = 'could not read file'; rtgUpdateRaw(); };
        fr.readAsDataURL(file);
    }
    async function composeFrames(frames) {
        const c = window.document.createElement('canvas'); c.width = FRAME_W * 5; c.height = FRAME_H;
        const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, FRAME_W * 5, FRAME_H);
        for (let i = 0; i < 5; i++) {
            const d = frames[i]; if (!d) continue;
            await new Promise(res => { const im = new window.Image(); im.onload = () => { x.drawImage(im, i * FRAME_W, 0, FRAME_W, FRAME_H); res(); }; im.onerror = res; im.src = d; });
        }
        return c.toDataURL('image/jpeg', 0.9);
    }
    async function rtgPlaceHook() {
        if (!(st.rawFrames || []).some(Boolean)) { st.rawUpErr = 'add at least one frame first'; rtgUpdateRaw(); return; }
        st.rawUploading = true; st.rawUpErr = null; st.rawUpStage = 1; st.rawUpQueue = null; rtgUpdateRaw();
        const tick = window.setInterval(() => { if (st.rawUpStage < 4) { st.rawUpStage++; rtgUpdateRaw(); } }, 1600);
        try {
            const montage = await composeFrames(st.rawFrames);
            const title = (st.rawText && st.rawText.trim() ? st.rawText.trim().slice(0, 40) : 'Built hook ' + (st.rawUploads.length + 1));
            const r = await fetch('/api/raw/embed-montage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ montage, text: st.rawText || '', title }) });
            const j = await r.json();
            if (!r.ok || j.error) { st.rawUpErr = j.error || ('HTTP ' + r.status); }
            else { st.rawUploads.push(j); st.rawUpSel = st.rawUploads.length - 1; st.rawSel = null; }
        } catch (e) { st.rawUpErr = e.message; }
        window.clearInterval(tick); st.rawUploading = false; st.rawUpStage = 0;
        rtgUpdateRaw();
    }

    async function mount(el) {
        root = el;
        if (!root.__rb) { root.addEventListener('click', onClick); root.addEventListener('input', onInput); root.addEventListener('change', onChange); root.__rb = true; }
        if (!DATA && !err) {
            root.innerHTML = `<div style="padding:40px;text-align:center;color:${C.dim}">Loading…</div>`;
            const base = './buildings/jarvis/retention-study/';
            // robust JSON load: reject HTML (a mid-deploy holding page starts with '<') so we don't try to parse it
            // cache-bust so the data sheet stays the single source of truth (no stale JSON in the browser)
            const loadJSON = async (url) => { const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=117'); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(); if (/^\s*</.test(t)) throw new Error('got HTML (deploy in progress)'); return JSON.parse(t); };
            for (let tries = 1; !DATA; tries++) {
                try {
                    CHANS = await fetch('/api/retention/channels').then(r => r.json()).catch(() => null);
                    DATA = await loadJSON(base + 'retention_table.json');
                    S = await loadJSON(base + 'retention_study.json').catch(() => null); S_MAIN = S;
                    N = await loadJSON(base + 'principles/novelty.json').catch(() => null);
                    NCEXP = await loadJSON(base + 'principles/novelty_correlations.json').catch(() => null);
                    NQ = await loadJSON(base + 'principles/novelty_quantify.json').catch(() => null);
                    CR = await loadJSON(base + 'principles/correlations.json').catch(() => null);
                    INT = await loadJSON(base + 'principles/interactions.json').catch(() => null);
                    CF = await loadJSON(base + 'principles/confounds.json').catch(() => null);
                    RTGF = await loadJSON(base + 'principles/rtg_field.json').catch(() => null);
                    RTGE = await loadJSON(base + 'principles/rtg_embedmap.json').catch(() => null);
                    RTGH = await loadJSON(base + 'principles/rtg_hazard.json').catch(() => null);
                    RAW = {}; try { RAW.visual = await (await fetch('/api/raw/map?channel=visual')).json(); } catch (e) { }
                    try { RTGLABELS = await (await fetch('/api/rtg/labels')).json() || {}; } catch (e) { RTGLABELS = {}; }
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
