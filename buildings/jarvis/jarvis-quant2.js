/**
 * jarvis-quant2.js — "Quant 2" (pure rebuild). 100% bottom-up, ZERO LLM ratings.
 *
 * Features come only from frozen encoders on raw pixels/audio (DINOv2 vision,
 * VideoMAE motion, wav2vec2 audio) + real measured DSP (cut rate, motion, RMS,
 * pitch). No novelty_1to10, no cognitive_load — those banned LLM gut-ratings are
 * gone. Target = swipe hazard h(t). Everything reported out-of-fold and honest.
 */
const JarvisQuant2 = (function () {
    'use strict';
    const C = { bg: '#0b1120', card: '#0f172a', card2: '#131c30', border: '#1e293b', border2: '#27364d',
        text: '#e2e8f0', dim: '#94a3b8', mute: '#64748b', faint: '#475569', cyan: '#22d3ee', green: '#34d399',
        orange: '#fb923c', red: '#f87171', purple: '#a78bfa', yellow: '#fbbf24', accent: '#38bdf8', pink: '#f472b6' };
    let root = null, P = null, DET = null, loadError = null, predicting = false, predResult = null, predErr = null;
    const state = { section: 'overview' };
    const SECTIONS = [
        { id: 'overview', n: '①', label: 'Pure Architecture' },
        { id: 'hazard', n: '②', label: 'Swipe Hazard' },
        { id: 'levers', n: '③', label: 'Measured Levers' },
        { id: 'latent', n: '④', label: 'Latent Directions' },
        { id: 'manifold', n: '⑤', label: 'Manifold' },
        { id: 'predict', n: '⑥', label: 'Score a Hook' },
    ];
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmt = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
    const tag = (t, c) => `<span style="display:inline-block;background:${c}22;color:${c};border:1px solid ${c}55;border-radius:5px;padding:1px 7px;font-size:10px;font-weight:700">${t}</span>`;
    const h2 = (t, s) => `<div style="margin-bottom:14px"><div style="font-size:19px;font-weight:800;color:${C.text}">${t}</div>${s ? `<div style="font-size:12.5px;color:${C.dim};margin-top:3px;line-height:1.5">${s}</div>` : ''}</div>`;
    const card = (i, p = 14) => `<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:${p}px;margin-bottom:12px">${i}</div>`;
    const note = (h, c) => `<div style="background:${(c || C.cyan)}12;border-left:3px solid ${c || C.cyan};border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:12px;font-size:12px;color:${C.dim};line-height:1.55">${h}</div>`;
    const stat = (l, v, c) => `<div style="background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:8px 12px"><div style="font-size:10px;color:${C.mute};text-transform:uppercase">${l}</div><div style="font-size:16px;font-weight:800;color:${c || C.text}">${v}</div></div>`;
    const frameUrl = (id, f) => f ? `/api/video/frame/${encodeURIComponent(id)}/${encodeURIComponent(f)}` : null;
    const NOLLM = () => tag('PIXELS/AUDIO ONLY · NO LLM', C.green);

    function vizHazard(h, S) {
        const w = 560, ht = 220, pad = 38, n = h.length, bw = (w - pad * 2) / n;
        const maxH = Math.max(...h, 0.15) * 1.2, Yh = v => ht - pad - (v / maxH) * (ht - pad * 2);
        const sf = [0, .25, .5, .75, .9], Xs = f => pad + (f / .9) * (w - pad * 2), Ys = v => ht - pad - v * (ht - pad * 2);
        let s = '';
        h.forEach((v, i) => { s += `<rect x="${pad + i * bw + 4}" y="${Yh(v)}" width="${bw - 8}" height="${ht - pad - Yh(v)}" fill="${C.red}" opacity="0.5"/><text x="${pad + i * bw + bw / 2}" y="${Yh(v) - 5}" text-anchor="middle" fill="${C.red}" font-size="9">${fmt(v, 2)}</text>`; });
        let p = ''; S.forEach((v, i) => p += (i ? 'L' : 'M') + Xs(sf[i]) + ' ' + Ys(v) + ' ');
        s += `<path d="${p}" fill="none" stroke="${C.green}" stroke-width="2.5"/>`;
        S.forEach((v, i) => s += `<circle cx="${Xs(sf[i])}" cy="${Ys(v)}" r="3" fill="${C.green}"/>`);
        s += `<line x1="${pad}" y1="${ht - pad}" x2="${w - pad}" y2="${ht - pad}" stroke="${C.border2}"/>`;
        ['0%', '25%', '50%', '75%', '90%'].forEach((l, i) => s += `<text x="${Xs(sf[i])}" y="${ht - pad + 13}" text-anchor="middle" fill="${C.mute}" font-size="9">${l}</text>`);
        s += `<text x="${pad}" y="14" fill="${C.red}" font-size="10" font-weight="700">h(t) leave-prob</text><text x="${w - pad}" y="14" text-anchor="end" fill="${C.green}" font-size="10" font-weight="700">R(t) survival</text>`;
        return `<svg viewBox="0 0 ${w} ${ht}" style="width:100%;height:auto">${s}</svg>`;
    }
    function thumbs(ex, col) {
        return `<div style="display:flex;gap:6px;flex-wrap:wrap">${ex.map(e => { const u = frameUrl(e.id, e.frame0); return `<div style="width:62px;text-align:center">${u ? `<img src="${u}" loading="lazy" style="width:62px;height:92px;object-fit:cover;border-radius:5px;border:1.5px solid ${col}88" onerror="this.style.display='none'"/>` : ''}<div style="font-size:8px;color:${C.mute};height:20px;overflow:hidden;line-height:1.1;margin-top:2px">${esc((e.name || e.id).slice(0, 22))}</div><div style="font-size:8px;color:${col}">h=${fmt(e.mean_hazard != null ? e.mean_hazard : e.hazard, 2)}</div></div>`; }).join('')}</div>`;
    }

    function renderOverview() {
        let h = h2('Pure bottom-up — discovered from pixels & audio, not words ' + NOLLM(),
            'Every feature is a frozen self-supervised encoder on raw media + a real measured signal. The LLM gut-ratings (novelty_1to10, cognitive_load, Zeigarnik…) that the old build leaned on are <b>banned</b> — they were a model\'s vibe, circular and non-reproducible.');
        const lanes = [['Vision', 'DINOv2', 'frame composition / what\'s on screen', C.cyan], ['Motion', 'VideoMAE', 'temporal dynamics across frames', C.purple],
            ['Audio', 'wav2vec2', 'sonic shape of the open (109 reels w/ audio)', C.green], ['DSP', 'librosa/opencv', 'cut rate, motion, RMS, pitch — measured', C.yellow]];
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${lanes.map(([n, m, d, c]) => card(`<div style="font-weight:800;color:${c};font-size:13px">${n} · ${m}</div><div style="font-size:11px;color:${C.dim};margin-top:3px">${d}</div>`)).join('')}</div>`;
        h += note(`<b>Banned features</b> (the old top-down vibes): novelty, cognitive_load, net_novelty, Zeigarnik (z_score), scale, contrast, expression, action — all of them were a Gemini/LLM "rate this 1-10" with the bare word as the only rubric. Quant 2 discovers latent directions from the pixels first, then lets you name them <i>after</i>.`, C.orange);
        return h;
    }

    function renderHazard() {
        const H = P.hazard;
        let h = h2('Swipe hazard on pure features ' + NOLLM(),
            `h(t)=P(swipe at t | survived). Discrete-time, pooled (reel×interval), grouped time-split CV by real publish date. ${P.n} reels.`);
        const row = (l, m, c) => `<tr><td style="padding:6px 10px;color:${C.text}">${l}</td><td style="padding:6px 10px;text-align:right;color:${m.r2 > 0 ? C.green : C.orange}">${fmt(m.r2, 3)}</td><td style="padding:6px 10px;text-align:right;color:${C.cyan}">${fmt(m.rho, 2)}</td></tr>`;
        h += card(`<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:${C.mute};font-size:10px;text-transform:uppercase"><th style="text-align:left;padding:4px 10px">Model (pure features)</th><th style="text-align:right;padding:4px 10px">OOF R²</th><th style="text-align:right;padding:4px 10px">rank ρ</th></tr></thead><tbody>
            ${row('Vision + Motion + visual-DSP', H.primary_en, C.green)}
            ${row('… same, nonlinear GBT', H.primary_gbt, C.green)}
            ${row('Cheap DSP only (cut rate/motion/loudness)', { r2: H.dsp_only.r2, rho: H.dsp_only.rho }, C.yellow)}
            </tbody></table>
            <div style="font-size:11px;color:${C.dim};margin-top:8px">Audio lift (n=${H.audio_lift.n}): without ${fmt(H.audio_lift.without_rho, 2)}ρ → with audio ${fmt(H.audio_lift.with_rho, 2)}ρ (Δ ${H.audio_lift.delta >= 0 ? '+' : ''}${fmt(H.audio_lift.delta, 3)})</div>`);
        h += note(`<b>The honest result:</b> the pure features rank swipe at <b>ρ≈${fmt(H.primary_en.rho, 2)}</b> — the same as the old LLM-vibe features, so those ratings were never adding value. Almost all the signal is in the <b>cheap measured DSP</b> (ρ ${fmt(H.dsp_only.rho, 2)}) — the deep encoders don't beat it at n=${P.n}, and audio adds ~nothing. R²≈0 means no precise point-prediction yet; the rank signal is real but weak. This is the non-overfit truth.`, C.orange);
        return h;
    }

    function renderLevers() {
        let h = h2('Measured levers — what actually separates keepers from swipers? ' + NOLLM(),
            'Each real measured signal vs the swipe hazard. ρ<0 means raising it lowers swipe; "keepers" = the value the low-hazard third of reels actually have. All from pixels/waveform.');
        const L = (DET && DET.levers) || [];
        const max = Math.max(...L.map(x => Math.abs(x.rho_with_hazard)), 0.01);
        h += card(`<div style="display:flex;flex-direction:column;gap:3px">${L.slice(0, 14).map(l => {
            const w = (Math.abs(l.rho_with_hazard) / max) * 180, pos = l.rho_with_hazard < 0;
            return `<div style="display:flex;align-items:center;gap:8px;font-size:11px"><div style="width:150px;text-align:right;color:${C.dim}">${esc(l.label)}</div>
                <div style="flex:1;position:relative;height:14px"><div style="position:absolute;left:50%;top:0;height:14px;width:1px;background:${C.border2}"></div>
                <div style="position:absolute;${pos ? 'right:50%' : 'left:50%'};top:2px;height:10px;width:${Math.max(1, w)}px;background:${pos ? C.green : C.red};opacity:.8;border-radius:2px"></div></div>
                <div style="width:42px;color:${C.mute};font-family:monospace">${l.rho_with_hazard >= 0 ? '+' : ''}${fmt(l.rho_with_hazard, 2)}</div></div>`;
        }).join('')}</div>
        <div style="font-size:10px;color:${C.mute};margin-top:8px"><span style="color:${C.green}">green</span> = raise to keep viewers · <span style="color:${C.red}">red</span> = lower to keep viewers</div>`);
        h += note(`<b>The deepest finding of the whole project:</b> <b>no single measured lever is strong</b> — every |ρ| is under 0.1, and the keepers' values are almost identical to everyone else's. So "increase cut rate / punch the loudness" advice is <b>not supported by your data</b>. The only real signal is the weak <i>multivariate</i> latent direction (next tab). Each lever here is a hypothesis to A/B test, never a rule. That's the rigorous truth at n=${P.n}.`, C.red);
        return h;
    }

    function renderLatent() {
        let h = h2('Latent directions — discovered from the embeddings, named after ' + NOLLM(),
            'PLS between the pure multi-modal embeddings and each reel\'s hazard. Look at the actual frames at each end — that visible difference IS the mechanism, no human word needed first.');
        (P.latent_directions || []).forEach((d, i) => {
            const col = [C.cyan, C.purple, C.green, C.yellow, C.pink, C.orange][i % 6], strong = Math.abs(d.effect_on_hazard_rho) > 0.2;
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><div style="font-weight:800;color:${col};font-size:14px">z${d.id}</div>${tag('hazard ρ=' + fmt(d.effect_on_hazard_rho, 2), strong ? C.green : C.mute)}<div style="font-size:11px;color:${C.mute}">${strong ? 'real direction — inspect & name' : 'weak'}</div></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px"><div><div style="color:${C.green};font-weight:700;font-size:11px;margin-bottom:5px">Low-hazard end (keeps)</div>${thumbs(d.low_hazard_examples, C.green)}</div>
            <div><div style="color:${C.red};font-weight:700;font-size:11px;margin-bottom:5px">High-hazard end (loses)</div>${thumbs(d.high_hazard_examples, C.red)}</div></div>`);
        });
        return h;
    }

    function renderManifold() {
        const M = P.manifold; if (!M) return h2('Manifold', 'no data');
        const xs = M.videos.map(v => v.x), ys = M.videos.map(v => v.y);
        const mnX = Math.min(...xs), mxX = Math.max(...xs), mnY = Math.min(...ys), mxY = Math.max(...ys);
        const w = 560, ht = 380, pad = 18, X = v => pad + ((v - mnX) / (mxX - mnX || 1)) * (w - pad * 2), Y = v => ht - pad - ((v - mnY) / (mxY - mnY || 1)) * (ht - pad * 2);
        const cols = [C.cyan, C.green, C.purple, C.yellow, C.pink, C.orange];
        let s = ''; M.videos.forEach(v => s += `<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${4 + v.mean_hazard * 10}" fill="${cols[v.cluster % cols.length]}" opacity="0.65"><title>${esc(v.name)} · h=${fmt(v.mean_hazard, 2)}${v.has_audio ? ' · audio' : ''}</title></circle>`);
        let h = h2('Content manifold — pure multi-modal space ' + NOLLM(), `${M.videos.length} reels in DINOv2+VideoMAE+wav2vec2 space (PCA→2D). ${M.k} archetypes, silhouette ${fmt(M.silhouette, 2)} — real structure (vs 0.10 on the old LLM features).`);
        h += card(`<svg viewBox="0 0 ${w} ${ht}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${s}</svg><div style="font-size:10px;color:${C.mute};margin-top:6px">colour = archetype · size = mean swipe hazard · hover for title</div>`);
        return h;
    }

    function renderPredict() {
        let h = h2('Score a new hook — raw pixels/audio in, hazard out ' + NOLLM(),
            'Upload a 10-second clip. It runs DINOv2 + VideoMAE + wav2vec2 + DSP → predicted swipe hazard + the nearest reels from your own catalog. No LLM at any step.');
        h += card(`<div style="display:flex;align-items:center;gap:12px">
            <label style="background:${C.accent}22;border:1px solid ${C.accent};color:${C.accent};border-radius:9px;padding:9px 16px;font-weight:800;font-size:13px;cursor:pointer">
                ${predicting ? 'Scoring… (30–60s)' : 'Upload a clip'}<input type="file" accept="video/mp4,video/*" data-q2upload style="display:none" ${predicting ? 'disabled' : ''}></label>
            <div style="font-size:11px;color:${C.mute}">first 10s · mp4 · runs the encoders on your machine/server</div></div>`);
        if (predErr) h += note('Prediction failed: ' + esc(predErr), C.red);
        if (predResult) {
            const r = predResult;
            h += card(`<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
                ${stat('Predicted swipe (10s)', fmt(r.swipe10s * 100, 0) + '%', r.swipe10s < 0.25 ? C.green : C.orange)}
                ${stat('Predicted keep (avg)', fmt(r.predicted_keep_overall * 100, 0) + '%', C.cyan)}
                ${stat('Confidence', r.confidence, C.orange)}</div>
                ${vizHazard(r.hazard, r.survival)}`);
            h += card(`<div style="font-weight:700;color:${C.green};margin-bottom:6px">Nearest reels in your catalog (DINOv2 similarity)</div>${thumbs(r.nearest_examples, C.green)}`);
            if (r.lever_gaps && r.lever_gaps.length) h += card(`<div style="font-weight:700;color:${C.yellow};margin-bottom:6px">Measured differences vs the keepers (weak — hypotheses)</div>
                ${r.lever_gaps.map(g => `<div style="font-size:11px;color:${C.dim};padding:3px 0">${esc(g.label)}: yours <b>${fmt(g.yours, 2)}</b> · keepers <b>${fmt(g.keepers, 2)}</b> → consider <b style="color:${C.cyan}">${g.suggest}</b> <span style="color:${C.mute}">(ρ${fmt(g.rho, 2)})</span></div>`).join('')}`);
            h += note(esc(r.caveat), C.orange);
        }
        return h;
    }

    function body() { return ({ overview: renderOverview, hazard: renderHazard, levers: renderLevers, latent: renderLatent, manifold: renderManifold, predict: renderPredict }[state.section] || renderOverview)(); }
    function rerender() {
        if (!root) return;
        const nav = SECTIONS.map(s => `<button data-q2s="${s.id}" style="background:${state.section === s.id ? C.accent + '22' : 'transparent'};border:1px solid ${state.section === s.id ? C.accent : C.border};color:${state.section === s.id ? C.accent : C.dim};border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer">${s.n} ${s.label}</button>`).join('');
        root.innerHTML = `<div style="background:${C.bg};border-radius:12px;padding:16px;color:${C.text};font-family:'Nunito',-apple-system,sans-serif">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><div style="font-size:22px;font-weight:900;background:linear-gradient(90deg,${C.cyan},${C.purple});-webkit-background-clip:text;-webkit-text-fill-color:transparent">Quant 2</div><div style="font-size:12px;color:${C.mute}">pure bottom-up · zero LLM · swipe-hazard</div></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">${nav}</div><div>${P ? body() : 'Loading…'}</div></div>`;
    }
    function onClick(e) { const b = e.target.closest('[data-q2s]'); if (b) { state.section = b.getAttribute('data-q2s'); rerender(); } }
    function onChange(e) {
        const inp = e.target.closest('[data-q2upload]'); if (!inp || !inp.files || !inp.files[0]) return;
        predicting = true; predErr = null; predResult = null; rerender();
        fetch('/api/quant2/predict', { method: 'POST', body: inp.files[0] }).then(r => r.json()).then(j => {
            predicting = false; if (j.error) predErr = j.error + (j.stderr ? ' · ' + j.stderr.slice(-200) : ''); else predResult = j; rerender();
        }).catch(err => { predicting = false; predErr = String(err); rerender(); });
    }
    async function mount(el) {
        root = el;
        if (!root.__q2b) { root.addEventListener('click', onClick); root.addEventListener('change', onChange); root.__q2b = true; }
        if (!P && !loadError) {
            root.innerHTML = `<div style="padding:40px;text-align:center;color:${C.dim}">Loading Quant 2…</div>`;
            try {
                P = await fetch('./buildings/jarvis/quant2/quant2_pure.json').then(r => r.json());
                DET = await fetch('./buildings/jarvis/quant2/quant2_detectors.json').then(r => r.json()).catch(() => null);
            } catch (e) { loadError = e; root.innerHTML = `<div style="padding:24px;color:${C.red}">Failed to load Quant 2: ${esc(e.message)}</div>`; return; }
        }
        rerender();
    }
    return { mount };
})();
if (typeof window !== 'undefined') window.JarvisQuant2 = JarvisQuant2;
if (typeof module !== 'undefined' && module.exports) module.exports = JarvisQuant2;
