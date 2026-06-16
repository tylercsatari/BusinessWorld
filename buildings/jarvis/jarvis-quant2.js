/**
 * jarvis-quant2.js — "Quant 2": the bottom-up swipe-hazard architecture.
 *
 * Philosophy (faithful to the Quant-2 brief): DON'T quantify named mechanisms
 * ("stakes") top-down. Quantify the viewer's leave/stay behaviour as a discrete-
 * time HAZARD h(t), discover the latent directions that move it, and only NAME
 * them afterward. Self-supervised encoders learn the *structure* of content from
 * a huge unlabelled corpus; a small true-labelled set calibrates structure →
 * swipe; pseudo-labelling amplifies cautiously; experiments make it causal.
 *
 * This tab renders that architecture AND the part computable from data on hand
 * (quant2_model.py → quant2_model.json: a real discrete-time hazard scaffold on
 * the 213 reels' retention anchors). Everything is labelled LIVE vs ROADMAP —
 * nothing is faked. Primary target throughout: swipe / retention. Views are a
 * downstream check, never the training target.
 */
const JarvisQuant2 = (function () {
    'use strict';
    const C = {
        bg: '#0b1120', card: '#0f172a', card2: '#131c30', border: '#1e293b', border2: '#27364d',
        text: '#e2e8f0', dim: '#94a3b8', mute: '#64748b', faint: '#475569',
        cyan: '#22d3ee', green: '#34d399', orange: '#fb923c', red: '#f87171',
        purple: '#a78bfa', yellow: '#fbbf24', accent: '#38bdf8', pink: '#f472b6',
    };
    let root = null, DATA = null, loadError = null;
    const state = { section: 'architecture' };

    const SECTIONS = [
        { id: 'architecture', n: '①', label: 'Architecture' },
        { id: 'hazard', n: '②', label: 'Swipe Hazard' },
        { id: 'latent', n: '③', label: 'Latent Discovery' },
        { id: 'manifold', n: '③ᵇ', label: 'Content Manifold' },
        { id: 'pyramid', n: '④', label: 'Data Pyramid' },
        { id: 'teacher', n: '⑤', label: 'Teacher · Student' },
        { id: 'encoders', n: '⑥', label: 'Encoder Stack' },
        { id: 'roadmap', n: '⑦', label: 'MVP Roadmap' },
    ];

    // ── tiny helpers ──
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmt = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
    const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    function tag(t, col) { return `<span style="display:inline-block;background:${col}22;color:${col};border:1px solid ${col}55;border-radius:5px;padding:1px 7px;font-size:10px;font-weight:700;letter-spacing:.03em">${t}</span>`; }
    function h2(t, sub) { return `<div style="margin-bottom:14px"><div style="font-size:19px;font-weight:800;color:${C.text}">${t}</div>${sub ? `<div style="font-size:12.5px;color:${C.dim};margin-top:3px;line-height:1.5">${sub}</div>` : ''}</div>`; }
    function card(inner, pad = 14) { return `<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:${pad}px;margin-bottom:12px">${inner}</div>`; }
    function note(html, col) { col = col || C.cyan; return `<div style="background:${col}12;border-left:3px solid ${col};border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:12px;font-size:12px;color:${C.dim};line-height:1.55">${html}</div>`; }
    function stat(label, val, col) { return `<div style="background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:8px 12px"><div style="font-size:10px;color:${C.mute};text-transform:uppercase;letter-spacing:.05em">${label}</div><div style="font-size:16px;font-weight:800;color:${col || C.text}">${val}</div></div>`; }
    const LIVE = () => tag('LIVE · REAL DATA', C.green);
    const ROAD = () => tag('ROADMAP', C.orange);

    // ── viz: vertical architecture flow ──
    function vizFlow(steps) {
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:0">${steps.map((s, i) => `
            <div style="background:${s.col}14;border:1.5px solid ${s.col}66;border-radius:10px;padding:9px 16px;width:84%;max-width:520px;text-align:center">
                <div style="font-size:13px;font-weight:800;color:${s.col}">${esc(s.label)}</div>
                ${s.sub ? `<div style="font-size:11px;color:${C.dim};margin-top:2px">${esc(s.sub)}</div>` : ''}
            </div>
            ${i < steps.length - 1 ? `<div style="color:${C.faint};font-size:16px;line-height:1.1">↓</div>` : ''}`).join('')}</div>`;
    }

    // ── viz: hazard curve h(t) bars + survival R(t) line ──
    function vizHazard(h, S, mids) {
        const w = 560, ht = 230, pad = 40, n = h.length;
        const bw = (w - pad * 2) / n;
        const maxH = Math.max(...h, 0.2) * 1.15;
        const Yh = v => ht - pad - (v / maxH) * (ht - pad * 2);
        const Xs = f => pad + f * (w - pad * 2);          // survival x by fraction-of-duration
        const Ys = v => ht - pad - v * (ht - pad * 2);
        let svg = '';
        // hazard bars
        h.forEach((v, i) => { svg += `<rect x="${pad + i * bw + 4}" y="${Yh(v)}" width="${bw - 8}" height="${ht - pad - Yh(v)}" fill="${C.red}" opacity="0.5"/><text x="${pad + i * bw + bw / 2}" y="${Yh(v) - 5}" text-anchor="middle" fill="${C.red}" font-size="9">${fmt(v, 2)}</text>`; });
        // survival line over [0,.25,.5,.75,.9]
        const sf = [0, 0.25, 0.5, 0.75, 0.9];
        let path = '';
        S.forEach((v, i) => { path += (i ? 'L' : 'M') + Xs(sf[i] / 0.9) + ' ' + Ys(v) + ' '; });
        svg += `<path d="${path}" fill="none" stroke="${C.green}" stroke-width="2.5"/>`;
        S.forEach((v, i) => { svg += `<circle cx="${Xs(sf[i] / 0.9)}" cy="${Ys(v)}" r="3" fill="${C.green}"/>`; });
        svg += `<line x1="${pad}" y1="${ht - pad}" x2="${w - pad}" y2="${ht - pad}" stroke="${C.border2}"/>`;
        ['0%', '25%', '50%', '75%', '90% of duration'].forEach((l, i) => { svg += `<text x="${Xs(sf[i] / 0.9)}" y="${ht - pad + 14}" text-anchor="${i === 4 ? 'end' : 'middle'}" fill="${C.mute}" font-size="9">${l}</text>`; });
        svg += `<text x="${pad}" y="16" fill="${C.red}" font-size="10" font-weight="700">h(t) = leave-prob per interval (bars)</text>`;
        svg += `<text x="${w - pad}" y="16" text-anchor="end" fill="${C.green}" font-size="10" font-weight="700">R(t) = survival (line)</text>`;
        return `<svg viewBox="0 0 ${w} ${ht}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // ── viz: horizontal bars (signed) ──
    function vizBars(items, opts = {}) {
        const fmtV = opts.fmtV || (v => fmt(v, 2));
        const max = Math.max(...items.map(i => Math.abs(i.val)), 1e-9);
        const w = 520, rowH = 22, pad = 150, h = items.length * rowH + 8;
        const X0 = opts.signed ? pad + (w - pad - 20) / 2 : pad;
        let svg = '';
        items.forEach((it, i) => {
            const y = 4 + i * rowH;
            const len = (Math.abs(it.val) / max) * (opts.signed ? (w - pad - 20) / 2 : (w - pad - 20));
            const pos = it.val >= 0;
            const col = it.col || (opts.signed ? (pos ? C.green : C.red) : C.cyan);
            const bx = opts.signed ? (pos ? X0 : X0 - len) : X0;
            svg += `<text x="${pad - 8}" y="${y + rowH / 2 + 3}" text-anchor="end" fill="${C.dim}" font-size="11">${esc(it.label)}</text>`;
            svg += `<rect x="${bx}" y="${y + 3}" width="${Math.max(1, len)}" height="${rowH - 8}" rx="2" fill="${col}" opacity="0.8"/>`;
            svg += `<text x="${pos ? bx + len + 4 : bx - 4}" y="${y + rowH / 2 + 3}" text-anchor="${pos ? 'start' : 'end'}" fill="${C.mute}" font-size="10">${fmtV(it.val)}</text>`;
        });
        if (opts.signed) svg += `<line x1="${X0}" y1="0" x2="${X0}" y2="${h}" stroke="${C.border2}"/>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    function loadingHTML() { return `<div style="padding:40px;text-align:center;color:${C.dim}">Loading Quant 2…</div>`; }
    function errorHTML(e) { return `<div style="padding:24px;color:${C.red};font-size:13px">Failed to load Quant 2: ${esc(e && e.message || e)}<div style="color:${C.mute};font-size:11px;margin-top:8px">Run <code>python3 buildings/jarvis/qrd/quant2_model.py</code> to generate quant2_model.json.</div></div>`; }

    async function loadData() {
        const base = './buildings/jarvis/qrd/';
        DATA = await fetch(base + 'quant2_model.json').then(r => r.json());
        // the real embedding model (DINOv2 hazard + latent + manifold) — optional
        EMB = await fetch('./buildings/jarvis/quant2/quant2_emb_model.json').then(r => r.json()).catch(() => null);
        return DATA;
    }
    let EMB = null;
    function frameUrl(id, f) { return f ? `/api/video/frame/${encodeURIComponent(id)}/${encodeURIComponent(f)}` : null; }

    // ══════════════════════ SECTIONS ══════════════════════

    function renderArchitecture() {
        let h = h2('Bottom-up: sensory state → viewer state → outcome',
            'The mistake is letting human language ("stakes", "novelty") define the model before the raw structure is discovered. Quant 2 inverts that: quantify the latent sensory trajectory that changes viewer behaviour, then name the directions afterward.');
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${card(`<div style="font-weight:700;color:${C.cyan};margin-bottom:6px">World 1 — non-linguistic discovery</div>
                <div style="font-size:12px;color:${C.dim};line-height:1.6">pixels · motion · audio waveform · timing · object tracks · retention/swipe behaviour. No words. Just vectors and the leave/stay outcome.</div>`)}
            ${card(`<div style="font-weight:700;color:${C.purple};margin-bottom:6px">World 2 — human interpretation</div>
                <div style="font-size:12px;color:${C.dim};line-height:1.6">stakes · novelty · promise clarity · payoff · curiosity. These are <i>names</i> for latent directions — applied <b>after</b> discovery, never before.</div>`)}
        </div>`;
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:10px">The architecture</div>` + vizFlow([
            { label: 'Raw pixels + raw audio', sub: 'first 10s, 0.5s windows', col: C.faint },
            { label: 'Self-supervised encoders', sub: 'DINOv2 · VideoMAE · V-JEPA · AudioMAE (frozen)', col: C.cyan },
            { label: 'Latent sensory trajectory z(t)', sub: 'what is happening, not what it means', col: C.accent },
            { label: 'Swipe-hazard model h(t)', sub: 'P(leave at t | survived to t) ← the true target', col: C.red },
            { label: 'Retention R(t) = ∏(1 − h)', sub: 'swipe ratio = 1 − R(10s)', col: C.green },
            { label: 'Outcome-linked latent directions', sub: 'which z reliably move h(t)', col: C.purple },
            { label: 'Inspect → name → mechanism detectors', sub: 'a latent coordinate, not a 1–10 score', col: C.yellow },
            { label: 'Edit recommendation → A/B test', sub: 'correlation becomes causal', col: C.orange },
        ]));
        h += note(`<b>Why hazard, not "views"?</b> Raw views are dominated by account size, post time, topic timing and recommender state (the QRD doc's warning). The cleanest object closest to content is the swipe hazard over the first 10s. <b>Primary target = swipe / retention. Views are a downstream check, never the training target — and subscriber lift is explicitly out of scope.</b>`, C.cyan);
        return h;
    }

    function renderHazard() {
        const d = DATA;
        let h = h2('Swipe hazard h(t) — the true bottom-up target ' + LIVE(),
            'h(t) = P(viewer swipes at t | still watching at t). Retention is the product of survival across intervals. Different mechanisms operate at different times — a single "swipe ratio" hides all of it.');
        h += `<div style="background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:10px 14px;margin-bottom:12px;font-family:'SF Mono',monospace;font-size:12px;color:${C.text}">
            h(t) = P(swipe at t | survived to t) &nbsp;·&nbsp; R(t) = ∏<sub>τ≤t</sub> (1 − h(τ)) &nbsp;·&nbsp; swipe<sub>10s</sub> = 1 − R(10s)</div>`;
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
            ${stat('Reels (true survival)', d.n_reels, C.green)}
            ${stat('Pooled obs (reel×interval)', d.n_obs, C.cyan)}
            ${stat('3s hook hazard', fmt(d.hook_hazard_3s, 3), C.red)}
            ${stat('Date span', d.date_span ? d.date_span[0] + '→' + d.date_span[1] : '—', C.dim)}
        </div>`;
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Corpus hazard + survival curve</div>
            ${vizHazard(d.corpus_hazard, d.corpus_survival, d.interval_mid)}
            <div style="font-size:11px;color:${C.mute};margin-top:6px">Real, from ${d.n_reels} reels' retention anchors (ret_25/50/75/90). Most leaving happens in the 25–50%-of-duration interval. <b>Anchors are at %-of-duration, not absolute seconds</b> — the true 0.5s-resolution h(t) needs the per-second audience-retention export (see Data Pyramid).</div>`);

        const en = d.models.elasticnet_logit_hazard, gb = d.models.gbt_hazard;
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Discrete-time hazard model — honest out-of-fold</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
                ${stat('ElasticNet OOF R²', fmt(en.r2_mean, 2) + '±' + fmt(en.r2_std, 2), en.r2_mean > 0 ? C.green : C.orange)}
                ${stat('ElasticNet rank ρ', fmt(en.spearman, 2), C.cyan)}
                ${stat('GBT OOF R²', fmt(gb.r2_mean, 2) + '±' + fmt(gb.r2_std, 2), gb.r2_mean > 0 ? C.green : C.orange)}
                ${stat('GBT rank ρ', fmt(gb.spearman, 2), C.cyan)}
            </div>
            <div style="font-size:11px;color:${C.mute}">Logit-hazard predicted from content features + interval + duration + recency, scored by a <b>grouped, time-ordered split</b> (all intervals of a reel stay together; train on earlier reels by real publish date, validate on later).</div>`);
        h += note(`<b>The honest read:</b> at n=${d.n_reels}, out-of-fold R² is ~0 (often negative) — content features do <i>not</i> point-predict the hazard yet — but the rank correlation ρ≈${fmt(Math.max(en.spearman, gb.spearman), 2)} says there is a <b>real, weak ordering signal</b>. This is a scaffold, not a finished model: the leap comes from the encoder features + per-second curves + far more true-labelled data (Pyramid & Roadmap). No overfitting, no fabricated accuracy.`, C.orange);

        const coef = (d.hazard_coefficients || []).filter(c => !c.key.startsWith('interval_')).slice(0, 14);
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">What raises / lowers the hazard (linear read)</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">Signed effect on logit-hazard. <b style="color:${C.red}">Red raises</b> leave-probability (bad), <b style="color:${C.green}">green lowers</b> it (good). Read as direction, not gospel — the rank signal is weak at this n.</div>
            ${vizBars(coef.map(c => ({ label: c.key, val: c.coef })), { signed: true, fmtV: v => fmt(v, 2) })}`);

        // ── REAL DINOv2 embedding model: does it beat tabular out-of-fold? ──
        if (EMB && EMB.hazard) {
            const H = EMB.hazard;
            const rowM = (lbl, m, col) => `<tr><td style="padding:6px 10px;color:${C.text}">${lbl}</td><td style="padding:6px 10px;text-align:right;color:${col}">${fmt(m.r2, 3)}</td><td style="padding:6px 10px;text-align:right;color:${C.cyan}">${fmt(m.rho, 2)}</td></tr>`;
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('FROZEN DINOv2 · REAL', C.green)}<b style="color:${C.text}">Do self-supervised sensory features beat the cheap tabular ones?</b></div>
                <div style="font-size:11px;color:${C.mute};margin-bottom:8px">DINOv2-small CLS embeddings (mean⊕hook, ${EMB.emb_dim}-d) over each reel's frames, PCA-reduced <b>on the train fold only</b>, same grouped time-split CV. Identical protocol → the comparison is fair.</div>
                <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:${C.mute};font-size:10px;text-transform:uppercase">
                    <th style="text-align:left;padding:4px 10px">Model</th><th style="text-align:right;padding:4px 10px">OOF R²</th><th style="text-align:right;padding:4px 10px">rank ρ</th></tr></thead><tbody>
                    ${rowM('Tabular features (26)', H.tabular, H.tabular.r2 > 0 ? C.green : C.orange)}
                    ${rowM('DINOv2 embeddings', H.dinov2, H.dinov2.r2 > 0 ? C.green : C.orange)}
                    ${rowM('DINOv2 + tabular', H.dinov2_plus_tab, H.dinov2_plus_tab.r2 > 0 ? C.green : C.orange)}
                    ${rowM('DINOv2 (nonlinear GBT)', H.dinov2_gbt, H.dinov2_gbt.r2 > 0 ? C.green : C.orange)}
                </tbody></table>
                <div style="font-size:12px;color:${H.lift_rho >= 0 ? C.green : C.orange};font-weight:700;margin-top:8px">Embedding lift over tabular (rank ρ): ${H.lift_rho >= 0 ? '+' : ''}${fmt(H.lift_rho, 3)}</div>`);
            h += note(`<b>The honest finding:</b> at n=${EMB.n} true labels, the frozen DINOv2 features <b>${H.lift_rho >= 0.02 ? 'add' : 'do NOT add'}</b> predictive lift over the tabular features — and that's expected, exactly per the brief: <i>"300 videos is not the amount of data needed."</i> The embeddings' payoff is the <b>content manifold</b> (representation over the 2,362-video corpus) and the <b>teacher→student</b> loop, not point-prediction at this n. This is the non-overfit truth: real encoder, real CV, reported straight.`, C.orange);
        }
        return h;
    }

    function thumbRow(examples, col) {
        return `<div style="display:flex;gap:6px;flex-wrap:wrap">${examples.map(e => {
            const u = frameUrl(e.id, e.frame0);
            return `<div style="width:64px;text-align:center">
                ${u ? `<img src="${u}" loading="lazy" style="width:64px;height:96px;object-fit:cover;border-radius:5px;border:1.5px solid ${col}88" onerror="this.style.display='none'"/>` : `<div style="width:64px;height:96px;border-radius:5px;border:1px dashed ${C.border2};display:flex;align-items:center;justify-content:center;color:${C.faint};font-size:9px">no frame</div>`}
                <div style="font-size:8.5px;color:${C.mute};line-height:1.2;margin-top:2px;height:22px;overflow:hidden">${esc((e.name || e.id).slice(0, 24))}</div>
                <div style="font-size:8px;color:${col}">h=${fmt(e.mean_hazard, 2)}</div>
            </div>`;
        }).join('')}</div>`;
    }

    function renderLatent() {
        const useEmb = EMB && EMB.latent_directions;
        let h = h2('Latent-direction discovery — name AFTER, not before ' + (useEmb ? LIVE() : ''),
            useEmb
                ? 'PLS between the frozen DINOv2 sensory embeddings and each reel\'s hazard vector finds the directions that most change leave-probability. You inspect the actual frames at each extreme, THEN give the direction a human name. "Stakes" is a discovered latent here, never an input.'
                : 'PLS between content features and each reel\'s hazard vector. (Run train_quant2.py for the DINOv2 version with frame examples.)');
        const dirs = useEmb ? EMB.latent_directions : (DATA.latent_directions || []);
        dirs.forEach((L, i) => {
            const col = [C.cyan, C.purple, C.green, C.yellow, C.pink, C.orange][i % 6];
            const strong = Math.abs(L.effect_on_hazard_rho) > 0.2;
            const lowEx = useEmb ? L.low_hazard_examples : null;
            const highEx = useEmb ? L.high_hazard_examples : null;
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <div style="font-weight:800;color:${col};font-size:14px">Latent z${L.id}</div>
                    ${tag('effect on hazard ρ = ' + fmt(L.effect_on_hazard_rho, 2), strong ? C.green : C.mute)}
                    <div style="font-size:11px;color:${C.mute}">${strong ? 'a real direction that moves leave-probability — inspect & name it' : 'weak at this n — leave unnamed'}</div>
                </div>
                ${useEmb ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                    <div><div style="color:${C.green};font-weight:700;margin-bottom:5px;font-size:11px">Low-hazard end (keeps viewers)</div>${thumbRow(lowEx, C.green)}</div>
                    <div><div style="color:${C.red};font-weight:700;margin-bottom:5px;font-size:11px">High-hazard end (loses viewers)</div>${thumbRow(highEx, C.red)}</div>
                </div>` : `<div style="font-size:11px;color:${C.dim}"><b>Defined by:</b> ${(L.top_features || []).map(t => `${esc(t.key)} ${fmt(t.load, 2)}`).join(' · ')}</div>`}`);
        });
        h += note(`A mechanism score is <b>not</b> "8/10 on stakes". It is "this reel sits at the ${useEmb ? 'low-hazard' : 'high'} end of latent z${(dirs[0] || {}).id}, a direction discovered from the pixels (not named in advance) that lowers swipe hazard" — a position in a learned distribution, with uncertainty and a nonlinear effect curve. ${useEmb ? `These directions come from the <b>frozen DINOv2 frames above</b> — look at the thumbnails: the low-hazard and high-hazard ends look genuinely different. That difference, not a human word, is the mechanism.` : ''} With the full corpus manifold the directions get far richer.`, C.purple);
        return h;
    }

    function renderManifold() {
        if (!EMB || !EMB.manifold) return h2('Content Manifold', 'Run train_quant2.py / embed_corpus.py to build the manifold.') + note('The manifold needs the DINOv2 embeddings. Once <code>quant2_emb_model.json</code> exists it renders here.', C.orange);
        const M = EMB.manifold;
        const cols = [C.cyan, C.green, C.purple, C.yellow, C.pink, C.orange];
        let h = h2('Content manifold — the structure of short-form, from pixels ' + LIVE(),
            `Each reel is a point in DINOv2 space (PCA→2D). k-means finds ${M.k} archetypes; novelty = distance from nearest neighbours. This is World 1: the shape of content space, learned with no labels. The corpus (2,362 videos) lands in the same space as it finishes embedding from R2.`);
        // scatter
        const xs = M.videos.map(v => v.x), ys = M.videos.map(v => v.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = 560, ht = 380, pad = 20;
        const X = v => pad + ((v - minX) / (maxX - minX || 1)) * (w - pad * 2);
        const Y = v => ht - pad - ((v - minY) / (maxY - minY || 1)) * (ht - pad * 2);
        let svg = '';
        M.videos.forEach(v => { svg += `<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${4 + v.mean_hazard * 10}" fill="${cols[v.cluster % cols.length]}" opacity="0.6"><title>${esc(v.name)} · cluster ${v.cluster} · hazard ${fmt(v.mean_hazard, 2)} · novelty ${fmt(v.novelty, 2)}</title></circle>`; });
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:4px">Archetype map (${M.videos.length} reels · ${M.k} clusters · silhouette ${fmt(M.silhouette, 2)})</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">Colour = archetype · dot size = mean swipe hazard. Hover a dot for the title. Weak separation (silhouette ${fmt(M.silhouette, 2)}) is honest — short-form hooks overlap; the corpus will sharpen the clusters.</div>
            <svg viewBox="0 0 ${w} ${ht}" style="width:100%;height:auto;background:${C.card2};border-radius:8px">${svg}</svg>`);
        // most novel + least novel reels (by frame)
        const byNov = M.videos.slice().sort((a, b) => b.novelty - a.novelty);
        const mk = arr => `<div style="display:flex;gap:6px;flex-wrap:wrap">${arr.map(v => { const u = frameUrl(v.id, v.frame0); return `<div style="width:58px;text-align:center">${u ? `<img src="${u}" loading="lazy" style="width:58px;height:86px;object-fit:cover;border-radius:5px;border:1px solid ${C.border2}" onerror="this.style.display='none'"/>` : ''}<div style="font-size:8px;color:${C.mute};height:20px;overflow:hidden">${esc((v.name || '').slice(0, 20))}</div></div>`; }).join('')}</div>`;
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${card(`<div style="font-weight:700;color:${C.orange};margin-bottom:6px">Most novel (far from neighbours)</div>${mk(byNov.slice(0, 6))}`)}
            ${card(`<div style="font-weight:700;color:${C.cyan};margin-bottom:6px">Most typical (crowded region)</div>${mk(byNov.slice(-6).reverse())}`)}
        </div>`;
        h += note(`Novelty here is <b>market-relative distance in embedding space</b>, not a human guess — the best novelty is "far enough to be interesting, close enough to be understandable". Once the 2,362-video corpus is embedded, novelty becomes distance from the broader niche, and saturation = cluster density over time (which formats are crowded/decaying).`, C.green);
        return h;
    }

    function renderPyramid() {
        const p = DATA.pyramid;
        let h = h2('The data pyramid — true labels are the bottleneck',
            'A pseudo-labeler cannot create ground truth it has never seen. Use the huge unlabelled corpus to learn content STRUCTURE; use the small true-labelled set to learn how structure maps to swipe; pseudo-label only as a cautious amplifier, validated on real held-out retention.');
        const tiers = [
            { k: 'tier1_true_labels', label: 'Tier 1 · True labels', col: C.green, weight: 'highest weight' },
            { k: 'tier1_fine_curve', label: 'Tier 1+ · Fine per-second curve', col: C.cyan, weight: 'unlocks 0.5s hazard' },
            { k: 'tier3_weak_public', label: 'Tier 3 · Weak public signals', col: C.yellow, weight: 'auxiliary only' },
            { k: 'tier4_unlabeled_raw', label: 'Tier 4 · Unlabelled raw media', col: C.orange, weight: 'representation learning' },
            { k: 'tier5_human_pairwise', label: 'Tier 5 · Human pairwise', col: C.purple, weight: 'naming latents' },
        ];
        h += `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">${tiers.map((t, i) => {
            const v = p[t.k] || {};
            const width = 100 - i * 13;
            const have = v.have || 0;
            const need = v.need || (v.need_encoders ? 'encoders' : null);
            return `<div style="margin:0 auto;width:${width}%;background:${t.col}14;border:1.5px solid ${t.col}66;border-radius:8px;padding:9px 14px">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                    <div style="font-weight:800;color:${t.col};font-size:13px">${t.label}</div>
                    <div>${have ? tag('have ' + have, C.green) : ''}${need ? tag('need ' + need, C.orange) : ''}</div>
                </div>
                <div style="font-size:11px;color:${C.dim};margin-top:3px;line-height:1.45">${esc(v.what || '')} <span style="color:${C.mute}">— ${t.weight}</span></div>
            </div>`;
        }).join('')}</div>`;
        h += note(`<b>Your situation:</b> ${p.tier1_true_labels.have} reels with real retention anchors (gold, but small), ~2,000 downloaded videos with 100M+ views each (Tier 4 — great for the content manifold once encoded, useless as swipe labels), and the missing piece that unlocks the real h(t): the <b>per-second audience-retention export</b> from YouTube Studio for your own videos. That export is the single highest-leverage data-gathering step.`, C.green);
        return h;
    }

    function renderTeacher() {
        let h = h2('Teacher → student (the IDM→VPT move, done safely)',
            'If you train a small model on 300 videos and use it to "label" 2,000 public ones, you have NOT created true swipe labels — you have copied your first model\'s assumptions. Pseudo-labels are teacher opinions, not truth.');
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:10px">The four loops — all are required</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                ${[['Loop A · Representation', 'unlabelled videos → better latent space', '~2,000 videos teach content structure', C.cyan, 'ROADMAP'],
                   ['Loop B · True-label calibration', 'owned/collaborator videos → swipe/retention', 'maps latent structure → viewer behaviour', C.green, 'LIVE (coarse)'],
                   ['Loop C · Pseudo-label', 'teacher predicts unlabelled → student learns', 'expand coverage CAUTIOUSLY', C.orange, 'ROADMAP'],
                   ['Loop D · Experiment', 'model recommends edit → post → real retention', 'correlation → causation', C.purple, 'ROADMAP']
                ].map(([t, s, g, col, st]) => `<div style="background:${col}12;border:1px solid ${col}44;border-radius:8px;padding:10px">
                    <div style="display:flex;justify-content:space-between"><div style="font-weight:800;color:${col};font-size:12.5px">${t}</div>${tag(st, st.startsWith('LIVE') ? C.green : C.orange)}</div>
                    <div style="font-size:11px;color:${C.dim};margin-top:4px">${s}</div>
                    <div style="font-size:10.5px;color:${C.mute};margin-top:2px">Goal: ${g}</div>
                </div>`).join('')}
            </div>`);
        h += card(`<div style="font-weight:700;color:${C.red};margin-bottom:8px">Pseudo-label honesty rules (non-negotiable)</div>
            ${['Keep a pseudo-label ONLY if: teacher confidence high · stable under augmentation · nearest neighbours include true-labelled reels · multiple model types agree · in-distribution',
               'Weight: true labels = 1.0 · pseudo-labels = 0.1–0.3 · weak public views = auxiliary head only',
               'Every pseudo-label stores: predicted swipe · confidence · nearest true examples · teacher version · in/out-of-distribution flag',
               'Validate the student ONLY on real held-out retention. If it does not improve real-label performance → discard pseudo-labelling (it is just laundering guesses).'
            ].map(r => `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid ${C.border};font-size:11.5px;color:${C.dim};line-height:1.5"><span style="color:${C.red}">▸</span><span>${esc(r)}</span></div>`).join('')}`);
        h += note(`The analogy to language models: a massive text corpus teaches language structure; a small labelled set teaches the task. Here, ~2,000 videos teach <b>content structure</b>; ${DATA.n_reels} true-labelled reels teach the <b>swipe response</b>. You are not faking retention labels — you are making ${DATA.n_reels} real ones far more powerful.`, C.cyan);
        return h;
    }

    function renderEncoders() {
        let h = h2('Encoder stack — frozen, non-language-first ' + ROAD(),
            'Do not train a foundation model. Use pretrained self-supervised encoders as frozen feature extractors, then train small models on top. Start with the pure (non-language) lane; bring multimodal/language in as a second lane.');
        const lanes = [
            { lane: 'Vision (frames)', col: C.cyan, items: [['DINOv2', 'strong self-supervised image features → lightweight heads'], ['VideoMAE', 'masked video modelling, data-efficient'], ['V-JEPA / V-JEPA 2', 'prediction in representation space — closest to bottom-up']] },
            { lane: 'Audio (waveform)', col: C.green, items: [['AudioMAE', 'masked audio modelling'], ['wav2vec 2.0', 'speech representation'], ['BYOL-A', 'general audio, no labels']] },
            { lane: 'Objects / regions', col: C.orange, items: [['SAM 2', 'segment + track objects across frames (memory)']] },
            { lane: 'Multimodal (2nd lane)', col: C.purple, items: [['ImageBind / LanguageBind', 'shared spaces — but partially reintroduce language'], ['InternVideo2', 'video understanding']] },
        ];
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${lanes.map(L => card(`
            <div style="font-weight:800;color:${L.col};margin-bottom:8px">${L.lane}</div>
            ${L.items.map(([n, d]) => `<div style="padding:5px 0;border-bottom:1px solid ${C.border}"><span style="color:${C.text};font-weight:700;font-size:12px">${n}</span> <span style="color:${C.mute};font-size:11px">— ${esc(d)}</span></div>`).join('')}
        `)).join('')}</div>`;
        h += card(`<div style="font-weight:700;color:${C.text};margin-bottom:8px">Modelling & tooling on top</div>
            <div style="font-size:12px;color:${C.dim};line-height:1.7">
                <b>Prediction:</b> LightGBM / XGBoost / GAM / Gaussian Process / discrete-time logistic hazard / survival forests — models that learn <i>curves and interactions</i> (mechanisms are inverted-U and conditional, never linear).<br>
                <b>Discovery:</b> PLS / CCA, sparse autoencoders, supervised contrastive (high-hold vs low-hold), dictionary learning.<br>
                <b>Inspection:</b> FiftyOne (browse clips + embeddings + predictions). <b>Labels:</b> Label Studio (pairwise). <b>Weak supervision:</b> Snorkel. <b>Label cleanup:</b> cleanlab.
            </div>`);
        h += note(`Why these aren't wired yet: they need the <b>raw mp4s</b> (you have ~2,000 downloaded) run through GPU encoders — the flexible-RAM/GPU burst path we discussed. The hazard scaffold in §② runs on the cheap tabular features today; the encoder features are the upgrade that makes the latent directions real.`, C.orange);
        return h;
    }

    function renderRoadmap() {
        let h = h2('MVP roadmap — smallest serious build first',
            'Do not build the giant everything-model. Build the smallest version that proves each loop, on the data you have, and only scale what actually improves real held-out retention.');
        const mvps = [
            ['MVP 1 · True-label hazard', 'Your reels with real retention → predict 3s/10s hold + hazard from tabular + cheap features. Beat the channel-average / duration baseline on a held-out time split.', 'LIVE (this is §②, n=' + DATA.n_reels + ')', C.green],
            ['MVP 2 · Content manifold', 'Encode the ~2,000 downloaded videos → hook/visual/audio clusters, novelty = distance-from-recent, saturation maps. No fake labels.', 'ROADMAP (needs encoders)', C.orange],
            ['MVP 3 · Teacher→student test', 'Pseudo-label only high-confidence public videos; train student; test on real held-out reels. Keep ONLY if it improves real retention prediction.', 'ROADMAP', C.orange],
            ['MVP 4 · Mechanism discovery', 'Find latent directions that move predicted hazard; inspect top/bottom; name only stable factors → mechanism dashboard.', 'PARTIAL (§③ runs on tabular features now)', C.yellow],
            ['MVP 5 · Edit experiment', 'Pick one predicted failure mechanism; make two versions of a hook differing in one latent; measure real retention. First true causal loop.', 'ROADMAP (needs you posting)', C.purple],
        ];
        h += mvps.map(([t, d, st, col]) => card(`
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:4px">
                <div style="font-weight:800;color:${col};font-size:13.5px">${t}</div>${tag(st, st.startsWith('LIVE') ? C.green : st.startsWith('PARTIAL') ? C.yellow : C.orange)}
            </div>
            <div style="font-size:12px;color:${C.dim};line-height:1.55">${esc(d)}</div>`)).join('');
        h += note(`<b>The next concrete step</b> that moves this the most: export the <b>per-second audience-retention curves</b> from YouTube Studio for your reels (turns the coarse 4-anchor hazard into a true 0.5s h(t)), and stand up the <b>encoder pipeline</b> on the downloaded corpus (turns tabular features into the latent z(t) the whole architecture is built around). Both are data/infra steps, not modelling guesses.`, C.green);
        return h;
    }

    function sectionBody() {
        switch (state.section) {
            case 'architecture': return renderArchitecture();
            case 'hazard': return renderHazard();
            case 'latent': return renderLatent();
            case 'manifold': return renderManifold();
            case 'pyramid': return renderPyramid();
            case 'teacher': return renderTeacher();
            case 'encoders': return renderEncoders();
            case 'roadmap': return renderRoadmap();
        }
        return '';
    }

    function rerender() {
        if (!root) return;
        const nav = SECTIONS.map(s => `<button data-q2section="${s.id}" style="background:${state.section === s.id ? C.accent + '22' : 'transparent'};border:1px solid ${state.section === s.id ? C.accent : C.border};color:${state.section === s.id ? C.accent : C.dim};border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">${s.n} ${s.label}</button>`).join('');
        root.innerHTML = `<div style="background:${C.bg};border-radius:12px;padding:16px;color:${C.text};font-family:'Nunito',-apple-system,sans-serif">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
                <div style="font-size:22px;font-weight:900;background:linear-gradient(90deg,${C.cyan},${C.purple});-webkit-background-clip:text;-webkit-text-fill-color:transparent">Quant 2</div>
                <div style="font-size:12px;color:${C.mute}">bottom-up swipe-hazard · latent-first · teacher/student</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">${nav}</div>
            <div>${DATA ? sectionBody() : loadingHTML()}</div>
        </div>`;
    }

    function onClick(e) {
        const b = e.target.closest('[data-q2section]');
        if (b) { state.section = b.getAttribute('data-q2section'); rerender(); }
    }

    async function mount(el) {
        root = el;
        if (!root.__q2Bound) { root.addEventListener('click', onClick); root.__q2Bound = true; }
        if (!DATA && !loadError) {
            root.innerHTML = loadingHTML();
            try { await loadData(); }
            catch (e) { loadError = e; root.innerHTML = errorHTML(e); return; }
        }
        if (loadError) { root.innerHTML = errorHTML(loadError); return; }
        rerender();
    }

    return { mount };
})();

if (typeof window !== 'undefined') window.JarvisQuant2 = JarvisQuant2;
if (typeof module !== 'undefined' && module.exports) module.exports = JarvisQuant2;
