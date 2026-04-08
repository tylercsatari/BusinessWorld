/* ── Jarvis Building ── Analytical Intelligence Hub ── */
const JarvisUI = (() => {
    let container = null;
    let activeTab = 'analytical';
    let dataset = null;
    let activeToolId = null;
    let toolResults = {};
    let chooserKey = null;
    let toolSelections = {
        pearson: { signalA: 'keep', signalB: 'views', logViews: true },
        bucket: { groupBy: 'keep', measure: 'views', bucketCount: '5' },
        log10: { signalA: 'keep', signalB: 'views' },
        ratio: { numerator: 'share_rate', basis: '1000', compare: 'views' },
        net: { positive: 'novelty', negative: 'cognitive_load', compare: 'views' },
        proximity: { signals: ['keep', 'retention', 'z_score'], method: 'euclidean' },
    };

    // ── Indicator Registry ──
    const INDICATORS = [
        { label: 'Keep Rate', key: 'keep', type: '% (0–100)', source: 'YouTube Analytics (swipeRatio.stayedToWatch)', category: 'active', numeric: true, resolution: 'R0' },
        { label: 'Retention %', key: 'retention', type: '% (0–100)', source: 'YouTube Analytics (avgPercentViewed)', category: 'active', numeric: true, resolution: 'R0' },
        { label: 'Zeigarnik Score (text)', key: 'z_score', type: '1–10', source: 'LLM-scored (title + first 180 chars transcript)', category: 'active', numeric: true, resolution: 'R1' },
        { label: 'Zeigarnik Type (text)', key: 'z_type', type: 'categorical (A/B/C/D/E)', source: 'LLM-scored (title + first 180 chars transcript)', category: 'active', numeric: false, resolution: 'R1' },
        { label: 'Visual Zeigarnik Score', key: 'vz_score', type: '1–10', source: 'LLM vision-scored (frames 1–3 + first 3s transcript)', category: 'active', numeric: true, resolution: 'R3' },
        { label: 'Visual Zeigarnik Type', key: 'vz_type', type: 'categorical (A/B/C/D/E)', source: 'LLM vision-scored', category: 'active', numeric: false, resolution: 'R3' },
        { label: 'Novelty', key: 'novelty', type: '1–10', source: 'LLM-scored (title + opening transcript)', category: 'active', numeric: true, resolution: 'R1' },
        { label: 'Cognitive Load', key: 'cognitive_load', type: '1–10', source: 'LLM-scored (title + opening transcript)', category: 'active', numeric: true, resolution: 'R1' },
        { label: 'Net Novelty', key: 'net_novelty', type: 'integer (Novelty − Cognitive Load)', source: 'Derived: novelty − cognitive_load', category: 'active', numeric: true, resolution: 'R1' },
        { label: 'Share Rate', key: 'share_rate', type: 'ratio (shares per 1k views)', source: 'Derived: shares ÷ (views/1000)', category: 'active', numeric: true, resolution: 'R0' },
        { label: 'Views', key: 'views', type: 'count (use log10 for correlation)', source: 'YouTube Analytics', category: 'active', numeric: true, resolution: 'R0' },
        { label: 'Hook Clarity', key: 'hook_clarity', type: '1–10 (not yet scored)', source: 'Planned: LLM vision (first frame)', category: 'planned', numeric: true, resolution: 'R4' },
        { label: 'Visual Surprise', key: 'visual_surprise', type: '1–10 (not yet scored)', source: 'Planned: LLM vision (first frame)', category: 'planned', numeric: true, resolution: 'R4' },
        { label: 'Pacing', key: 'pacing', type: 'cuts/sec (not yet measured)', source: 'Planned: frame diff analysis (first 3s)', category: 'planned', numeric: true, resolution: 'R2' },
        { label: 'Emotional Resonance', key: 'emotional_resonance', type: '1–10 (not yet scored)', source: 'Planned: LLM vision+text', category: 'planned', numeric: true, resolution: 'R1' },
    ];

    const NUMERIC_KEYS = INDICATORS.filter(i => i.category === 'active' && i.numeric).map(i => i.key);

    function indicatorLabel(key) {
        const ind = INDICATORS.find(i => i.key === key);
        return ind ? ind.label : key;
    }

    function numericOptions(selected) {
        return NUMERIC_KEYS.map(k =>
            `<option value="${k}"${k === selected ? ' selected' : ''}>${indicatorLabel(k)}</option>`
        ).join('');
    }

    function fmtViews(v) {
        if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
        return v.toFixed(0);
    }

    // ── Tool Definitions ──
    const TOOL_DEFS = [
        { id: 'pearson', icon: '📐', name: 'Pearson Correlation', desc: 'Linear relationship between two numeric signals. Outputs r (−1 to +1).', methodology: 'Pearson measures linear association. Log-transform view counts before computing to prevent outlier domination.' },
        { id: 'bucket', icon: '📊', name: 'Bucket Analysis', desc: 'Group videos by one signal, show average of another per bucket.', methodology: 'Quartile analysis captures non-linear thresholds (e.g., retention cliffs) that a single r value averages away.' },
        { id: 'log10', icon: '📉', name: 'log10 Compare', desc: 'Compare raw Pearson r vs log10-normalized Pearson r.', methodology: 'View counts follow a power-law distribution. Log-transforming gives each video proportional weight and reveals true relationship strength.' },
        { id: 'ratio', icon: '⚖️', name: 'Ratio Normalizer', desc: 'Convert raw counts to rates (per 100/1k/1M) and correlate.', methodology: 'All engagement metrics must be expressed as rates per view. Raw counts scale with views by definition — comparing them produces inflated differences.' },
        { id: 'net', icon: '➕➖', name: 'Net Signal Calculator', desc: 'Subtract one signal from another to find optimal balance points.', methodology: 'Net signals reveal sweet spots where the balance between two opposing forces maximizes outcome.' },
        { id: 'llm', icon: '🧠', name: 'LLM Signal Scorer', desc: 'Server scoring pipeline — scores videos via LLM vision.', methodology: 'Each experiment must document known confounders. Unflagged confounders lead to false conclusions.', planned: true },
        { id: 'ols', icon: '📈', name: 'Linear Regression (OLS)', desc: 'Ordinary Least Squares — multiple signals → log10(views). The core model.', methodology: 'Standard regression with holdout evaluation. Dominates at n<300 due to stability. Always log-transform target (views) to handle power-law distribution.' },
        { id: 'cv', icon: '🎯', name: 'Cross-Validated Regression', desc: '5-fold or 10-fold CV with 10-20 random seeds. More reliable than single holdout.', methodology: 'Multi-seed CV averages out holdout variance. 20-seed CV std ≈ 0.015 vs single-holdout std ≈ 0.08. Used for all model experiments. Report mean ± std.' },
        { id: 'feature_sel', icon: '🔍', name: 'Forward/Backward Selection', desc: 'Iteratively add or remove features based on CV improvement.', methodology: 'Forward: start empty, add feature with highest CV gain >0.01. Backward: start full, drop feature with lowest CV cost. Found optimal 12-feature set from 100+ candidates.' },
        { id: 'gbm', icon: '🌲', name: 'GBM (Gradient Boosted Machines)', desc: 'Non-linear ensemble — 200 sequential decision trees, each correcting the last.', methodology: 'Better than OLS for non-linear relationships but needs n>300 to avoid overfitting. At n=203: GBM CV=0.56 vs OLS CV=0.66. Useful in blends (0.8 OLS + 0.2 GBM).' },
        { id: 'rf', icon: '🌳', name: 'Random Forest', desc: 'Parallel ensemble of decision trees with random feature subsets.', methodology: 'More stable than GBM at small n but still underperformed OLS at n=203 (RF CV=0.53). Bagging reduces variance but can\'t recover from high-bias small-sample regime.' },
        { id: 'blend', icon: '⚗️', name: 'OLS+GBM Blend', desc: 'Weighted average of OLS (linear) and GBM (non-linear) predictions.', methodology: 'OLS captures linear patterns, GBM captures residual non-linearity. Best blend at n=203: 0.8 OLS + 0.2 GBM. At n=210: 0.55 OLS + 0.45 GBM. Blend improves as n grows.' },
    ];

    const TOOL_FIRST_PARAM = {
        pearson: 'signalA', bucket: 'groupBy', log10: 'signalA',
        ratio: 'numerator', net: 'positive', proximity: 'signals',
    };

    // ── Tool graph layout (initial hints, refined by force simulation) ──
    const ANALYTICAL_NODES = [
        { id: 'pearson', x: 60, y: 40 },
        { id: 'bucket', x: 200, y: 40 },
        { id: 'log10', x: 340, y: 40 },
        { id: 'ratio', x: 60, y: 130 },
        { id: 'net', x: 200, y: 130 },
        { id: 'llm', x: 340, y: 130 },
        { id: 'ols', x: 60, y: 220 },
        { id: 'cv', x: 140, y: 220 },
        { id: 'feature_sel', x: 220, y: 220 },
        { id: 'gbm', x: 300, y: 220 },
        { id: 'rf', x: 340, y: 175 },
        { id: 'blend', x: 380, y: 220 },
    ];
    const ANALYTICAL_EDGES = [
        ['log10', 'pearson'],
        ['ratio', 'pearson'],
        ['net', 'bucket'],
        ['llm', 'pearson'],
        ['llm', 'bucket'],
        ['cv', 'ols'],
        ['feature_sel', 'cv'],
        ['gbm', 'ols'],
        ['rf', 'ols'],
        ['blend', 'ols'],
        ['blend', 'gbm'],
    ];

    // ── Tab structure (5 tabs) ──
    const TABS = [
        { id: 'analytical', label: 'Analytical' },
        { id: 'tactical', label: 'Tactical' },
        { id: 'experiments', label: 'Experiments' },
        { id: 'autoResearch', label: 'AutoResearch' },
        { id: 'resolution', label: 'Resolution' },
    ];

    // ── Dataset loading ──
    async function loadDataset() {
        if (dataset) return dataset;
        try {
            const resp = await fetch('./buildings/jarvis/signals-dataset.json');
            dataset = await resp.json();
            return dataset;
        } catch (e) {
            console.error('Failed to load signals dataset:', e);
            return null;
        }
    }

    // ── Analysis functions ──
    function pearsonCorrelation(xs, ys) {
        const n = xs.length;
        if (n < 3) return null;
        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, denX = 0, denY = 0;
        for (let i = 0; i < n; i++) {
            const dx = xs[i] - meanX;
            const dy = ys[i] - meanY;
            num += dx * dy;
            denX += dx * dx;
            denY += dy * dy;
        }
        const den = Math.sqrt(denX * denY);
        return den === 0 ? 0 : num / den;
    }

    function bucketAnalysis(signal, measure, numBuckets) {
        if (!signal.length) return [];
        const min = Math.min(...signal);
        const max = Math.max(...signal);
        if (min === max) return [{ label: `${min}`, avgVal: measure.reduce((a, b) => a + b, 0) / measure.length, n: measure.length }];
        const step = (max - min) / numBuckets;
        const buckets = [];
        for (let i = 0; i < numBuckets; i++) {
            const lo = min + i * step;
            const hi = i === numBuckets - 1 ? max + 0.01 : min + (i + 1) * step;
            const label = `${lo.toFixed(1)}-${hi.toFixed(1)}`;
            const indices = signal.map((v, idx) => v >= lo && v < hi ? idx : -1).filter(idx => idx >= 0);
            const vals = indices.map(idx => measure[idx]);
            const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
            buckets.push({ label, avgVal: avg, n: vals.length });
        }
        return buckets;
    }

    function interpretR(r) {
        const abs = Math.abs(r);
        if (abs >= 0.7) return 'Strong';
        if (abs >= 0.4) return 'Moderate';
        if (abs >= 0.2) return 'Weak';
        return 'Negligible';
    }

    // ── Render ──
    function render() {
        if (!container) return;
        container.innerHTML = `
            <div class="jarvis-panel">
                <div class="jarvis-header">
                    <div>
                        <h2 class="jarvis-header-title">J.A.R.V.I.S.</h2>
                        <div class="jarvis-header-sub">Analytical Intelligence Hub &middot; 1,961 research + 213 channel = 2,174 videos</div>
                    </div>
                </div>
                <div class="jarvis-tabs">
                    ${TABS.map(t => `<button class="jarvis-tab${activeTab === t.id ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
                </div>
                <div class="jarvis-content">
                    ${renderTab()}
                </div>
            </div>
        `;
        bindEvents();
    }

    function renderTab() {
        switch (activeTab) {
            case 'analytical': return renderAnalytical();
            case 'tactical': return renderTactical();
            case 'experiments': return renderExperiments();
            case 'autoResearch': return renderAutoResearch();
            case 'resolution': return renderResolution();
            default: return '';
        }
    }

    // ══════════════════════════════════════════════════
    // TAB 1: ANALYTICAL BRAIN — Vector Network Graph
    // ══════════════════════════════════════════════════
    function renderAnalytical() {
        setTimeout(() => drawAnalyticalGraph(), 100);
        return `
            <div class="jarvis-analytical-network">
                <canvas id="jarvis-analytical-canvas" width="440" height="280"></canvas>
                <div id="jarvis-analytical-tooltip" class="jarvis-network-tooltip" style="display:none;"></div>
            </div>
            <div class="jarvis-network-legend">
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#3b82f6"></span>Measurement Tool</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#10b981"></span>Model Tool</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#a78bfa"></span>LLM Scorer</span>
                <span class="jarvis-legend-item jarvis-legend-hint">Click a node to run the tool</span>
            </div>
            ${activeToolId ? `<div class="jarvis-tool-panel-below">${renderToolPanel(activeToolId)}</div>` : ''}
        `;
    }

    function drawAnalyticalGraph() {
        const canvas = container?.querySelector('#jarvis-analytical-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.parentElement.clientWidth || 440;
        const H = 280;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        const dpr = window.devicePixelRatio || 1;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.scale(dpr, dpr);

        const PAD = 40;
        const scaleX = W / 440;
        const scaleY = H / 280;

        // Initialize nodes with slightly randomized positions from hints
        const nodes = ANALYTICAL_NODES.map(n => {
            const def = TOOL_DEFS.find(t => t.id === n.id);
            return {
                id: n.id,
                x: n.x * scaleX + (Math.random() - 0.5) * 20,
                y: n.y * scaleY + (Math.random() - 0.5) * 20,
                vx: 0, vy: 0,
                r: def?.planned ? 16 : 20,
                color: def?.planned ? '#a78bfa' : ['ols','cv','feature_sel','gbm','rf','blend'].includes(n.id) ? '#10b981' : '#3b82f6',
                label: def?.name || n.id,
                icon: def?.icon || '',
                desc: def?.desc || '',
                methodology: def?.methodology || '',
                planned: !!def?.planned,
            };
        });
        const nodeMap = {};
        nodes.forEach(n => nodeMap[n.id] = n);

        // Force-directed simulation: 100 iterations
        for (let iter = 0; iter < 100; iter++) {
            // Reset forces
            nodes.forEach(n => { n.vx = 0; n.vy = 0; });

            // Repulsion between all node pairs
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i], b = nodes[j];
                    let dx = b.x - a.x, dy = b.y - a.y;
                    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    if (dist < 80) {
                        const force = (1 / (dist * dist)) * 200;
                        const fx = (dx / dist) * force;
                        const fy = (dy / dist) * force;
                        a.vx -= fx; a.vy -= fy;
                        b.vx += fx; b.vy += fy;
                    }
                }
            }

            // Spring edges: attract connected nodes toward 100px distance
            ANALYTICAL_EDGES.forEach(([aId, bId]) => {
                const a = nodeMap[aId], b = nodeMap[bId];
                if (!a || !b) return;
                let dx = b.x - a.x, dy = b.y - a.y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const diff = dist - 100;
                const force = diff * 0.05;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx += fx; a.vy += fy;
                b.vx -= fx; b.vy -= fy;
            });

            // Apply velocities with damping, clamp to bounds
            nodes.forEach(n => {
                n.x += n.vx * 0.5;
                n.y += n.vy * 0.5;
                n.x = Math.max(PAD, Math.min(W - PAD, n.x));
                n.y = Math.max(PAD, Math.min(H - PAD, n.y));
            });
        }

        // Draw edges
        ctx.lineWidth = 1.5;
        ANALYTICAL_EDGES.forEach(([a, b]) => {
            const na = nodeMap[a], nb = nodeMap[b];
            if (!na || !nb) return;
            ctx.beginPath();
            ctx.strokeStyle = a === 'llm' || b === 'llm' ? 'rgba(167, 139, 250, 0.35)' : 'rgba(100, 116, 139, 0.4)';
            ctx.moveTo(na.x, na.y);
            ctx.lineTo(nb.x, nb.y);
            ctx.stroke();
        });

        // Draw nodes
        nodes.forEach(n => {
            const isActive = activeToolId === n.id;
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
            ctx.fillStyle = n.color;
            ctx.globalAlpha = isActive ? 1 : 0.8;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = isActive ? '#fff' : 'rgba(255,255,255,0.2)';
            ctx.lineWidth = isActive ? 2.5 : 1;
            ctx.stroke();

            // Icon
            ctx.font = `${n.r * 0.9}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(n.icon, n.x, n.y);

            // Label below
            ctx.fillStyle = isActive ? '#fff' : '#cbd5e1';
            ctx.font = '10px system-ui, sans-serif';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(n.label, n.x, n.y + n.r + 13);
        });

        // Tooltip on hover
        const tooltip = container?.querySelector('#jarvis-analytical-tooltip');
        canvas.onmousemove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            let hit = null;
            for (const n of nodes) {
                const dx = mx - n.x, dy = my - n.y;
                if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) { hit = n; break; }
            }
            if (hit && tooltip) {
                tooltip.style.display = 'block';
                tooltip.style.left = (hit.x + hit.r + 8) + 'px';
                tooltip.style.top = (hit.y - 10) + 'px';
                tooltip.innerHTML = `<strong>${hit.label}</strong><br><span class="jarvis-tt-dim">${hit.desc}</span><br><span class="jarvis-tt-dim" style="color:var(--j-cyan);font-style:italic">${hit.methodology}</span>`;
                canvas.style.cursor = 'pointer';
            } else if (tooltip) {
                tooltip.style.display = 'none';
                canvas.style.cursor = 'default';
            }
        };

        // Click opens tool panel
        canvas.onclick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            for (const n of nodes) {
                const dx = mx - n.x, dy = my - n.y;
                if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) {
                    if (n.planned) return;
                    activeToolId = activeToolId === n.id ? null : n.id;
                    render();
                    return;
                }
            }
        };
    }

    function renderToolPanel(toolId) {
        const sel = toolSelections[toolId] || {};
        const res = toolResults[toolId] || '';
        switch (toolId) {
            case 'pearson': return `
                <div class="jarvis-tool-inputs">
                    <div class="jarvis-tool-field">
                        <label>Signal A</label>
                        <select data-param="signalA">${numericOptions(sel.signalA)}</select>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Signal B</label>
                        <select data-param="signalB">${numericOptions(sel.signalB)}</select>
                    </div>
                    <label class="jarvis-tool-check-label">
                        <input type="checkbox" data-param="logViews" ${sel.logViews !== false ? 'checked' : ''} /> log10 normalize views if present
                    </label>
                    <button class="jarvis-tool-execute" data-tool="pearson">Execute</button>
                </div>
                <div class="jarvis-tool-result" data-tool-result="pearson">${res}</div>`;
            case 'bucket': return `
                <div class="jarvis-tool-inputs">
                    <div class="jarvis-tool-field">
                        <label>Group by</label>
                        <select data-param="groupBy">${numericOptions(sel.groupBy)}</select>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Measure</label>
                        <select data-param="measure">
                            ${['views','keep','retention','share_rate'].map(k =>
                                `<option value="${k}"${k === sel.measure ? ' selected' : ''}>${indicatorLabel(k)}</option>`
                            ).join('')}
                        </select>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Buckets</label>
                        <input type="number" data-param="bucketCount" value="${sel.bucketCount || 5}" min="2" max="20" />
                    </div>
                    <button class="jarvis-tool-execute" data-tool="bucket">Execute</button>
                </div>
                <div class="jarvis-tool-result" data-tool-result="bucket">${res}</div>`;
            case 'log10': return `
                <div class="jarvis-tool-inputs">
                    <div class="jarvis-tool-field">
                        <label>Signal A</label>
                        <select data-param="signalA">${numericOptions(sel.signalA)}</select>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Signal B</label>
                        <select data-param="signalB">${numericOptions(sel.signalB)}</select>
                    </div>
                    <button class="jarvis-tool-execute" data-tool="log10">Execute</button>
                </div>
                <div class="jarvis-tool-result" data-tool-result="log10">${res}</div>`;
            case 'ratio': return `
                <div class="jarvis-tool-inputs">
                    <div class="jarvis-tool-field">
                        <label>Numerator</label>
                        <select data-param="numerator">${numericOptions(sel.numerator)}</select>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Denominator basis</label>
                        <select data-param="basis">
                            <option value="100"${sel.basis === '100' ? ' selected' : ''}>per 100</option>
                            <option value="1000"${sel.basis !== '100' && sel.basis !== '1000000' ? ' selected' : ''}>per 1k</option>
                            <option value="1000000"${sel.basis === '1000000' ? ' selected' : ''}>per 1M</option>
                        </select>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Compare against</label>
                        <select data-param="compare">${numericOptions(sel.compare)}</select>
                    </div>
                    <button class="jarvis-tool-execute" data-tool="ratio">Execute</button>
                </div>
                <div class="jarvis-tool-result" data-tool-result="ratio">${res}</div>`;
            case 'net': return `
                <div class="jarvis-tool-inputs">
                    <div class="jarvis-tool-field">
                        <label>Positive signal</label>
                        <select data-param="positive">${numericOptions(sel.positive)}</select>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Negative signal</label>
                        <select data-param="negative">${numericOptions(sel.negative)}</select>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Compare against</label>
                        <select data-param="compare">${numericOptions(sel.compare)}</select>
                    </div>
                    <button class="jarvis-tool-execute" data-tool="net">Execute</button>
                </div>
                <div class="jarvis-tool-result" data-tool-result="net">${res}</div>`;
            case 'proximity': return `
                <div class="jarvis-tool-inputs">
                    <div class="jarvis-tool-field">
                        <label>Select Signals (2+)</label>
                        <div class="jarvis-proximity-checks">
                            ${NUMERIC_KEYS.map(k => `<label class="jarvis-tool-check-label">
                                <input type="checkbox" data-multi data-param="signals" value="${k}"
                                    ${(sel.signals || []).includes(k) ? 'checked' : ''} /> ${indicatorLabel(k)}
                            </label>`).join('')}
                        </div>
                    </div>
                    <div class="jarvis-tool-field">
                        <label>Distance method</label>
                        <select data-param="method">
                            <option value="euclidean"${sel.method === 'euclidean' ? ' selected' : ''}>Euclidean</option>
                            <option value="cosine"${sel.method === 'cosine' ? ' selected' : ''}>Cosine</option>
                        </select>
                    </div>
                    <button class="jarvis-tool-execute" data-tool="proximity">Execute</button>
                </div>
                <div class="jarvis-tool-result" data-tool-result="proximity">${res}</div>`;
            default: return '';
        }
    }

    // ── Read params from open tool panel ──
    function readParams(panel) {
        const p = {};
        panel.querySelectorAll('select[data-param], input[type="number"][data-param]').forEach(el => {
            p[el.dataset.param] = el.value;
        });
        panel.querySelectorAll('input[type="checkbox"][data-param]:not([data-multi])').forEach(el => {
            p[el.dataset.param] = el.checked;
        });
        const multiKeys = new Set();
        panel.querySelectorAll('input[type="checkbox"][data-multi][data-param]').forEach(el => {
            const key = el.dataset.param;
            if (!multiKeys.has(key)) { p[key] = []; multiKeys.add(key); }
            if (el.checked) p[key].push(el.value);
        });
        return p;
    }

    // ── Tool execution dispatch ──
    async function executeTool(toolId) {
        const panel = container.querySelector('.jarvis-tool-panel-below');
        if (!panel) return;
        const params = readParams(panel);
        const resultEl = panel.querySelector(`[data-tool-result="${toolId}"]`);
        if (!resultEl) return;
        resultEl.innerHTML = '<div class="jarvis-loading">Loading dataset...</div>';

        const data = await loadDataset();
        if (!data) {
            resultEl.innerHTML = '<div class="jarvis-error">Failed to load dataset</div>';
            return;
        }

        switch (toolId) {
            case 'pearson': executePearson(data, params, resultEl); break;
            case 'bucket': executeBucket(data, params, resultEl); break;
            case 'log10': executeLog10(data, params, resultEl); break;
            case 'ratio': executeRatio(data, params, resultEl); break;
            case 'net': executeNet(data, params, resultEl); break;
            case 'proximity': executeProximity(data, params, resultEl); break;
        }
        toolResults[toolId] = resultEl.innerHTML;
    }

    // ── Pearson ──
    function executePearson(data, p, el) {
        const aKey = p.signalA, bKey = p.signalB;
        const valid = data.filter(d => d[aKey] != null && d[bKey] != null);
        if (valid.length < 3) { el.innerHTML = '<div class="jarvis-error">Not enough data (need 3+)</div>'; return; }
        let xs = valid.map(d => d[aKey]);
        let ys = valid.map(d => d[bKey]);
        const doLog = p.logViews !== false;
        if (doLog && aKey === 'views') xs = xs.map(v => Math.log10(Math.max(v, 1)));
        if (doLog && bKey === 'views') ys = ys.map(v => Math.log10(Math.max(v, 1)));
        const r = pearsonCorrelation(xs, ys);
        const strength = interpretR(r);
        const absR = Math.abs(r);
        const color = absR >= 0.4 ? '#10b981' : absR >= 0.2 ? '#f59e0b' : '#ef4444';
        const logNote = (doLog && (aKey === 'views' || bKey === 'views')) ? ' (log10 on views)' : '';
        const barLeft = r >= 0 ? 50 : 50 - absR * 50;
        const barWidth = absR * 50;
        el.innerHTML = `
            <div class="jarvis-result-card">
                <div class="jarvis-result-label">Pearson${logNote}: ${indicatorLabel(aKey)} vs ${indicatorLabel(bKey)}</div>
                <div class="jarvis-result-r" style="color:${color}">r = ${r.toFixed(4)}</div>
                <div class="jarvis-result-strength" style="color:${color}">${strength} ${r > 0 ? 'positive' : r < 0 ? 'negative' : ''} correlation</div>
                <div class="jarvis-r-bar">
                    <div class="jarvis-r-bar-track">
                        <div class="jarvis-r-bar-center"></div>
                        <div class="jarvis-r-bar-fill" style="left:${barLeft}%;width:${barWidth}%;background:${color}"></div>
                    </div>
                    <div class="jarvis-r-bar-labels"><span>-1</span><span>0</span><span>+1</span></div>
                </div>
                <div class="jarvis-result-n">n = ${valid.length} videos</div>
                <div class="jarvis-result-interp">${absR < 0.1 ? 'Essentially no linear relationship.' : absR < 0.3 ? 'Weak relationship — other factors dominate.' : absR < 0.5 ? 'Moderate relationship — real signal here.' : 'Strong relationship — key predictor.'}</div>
            </div>`;
    }

    // ── Bucket ──
    function executeBucket(data, p, el) {
        const gKey = p.groupBy, mKey = p.measure;
        const nBuckets = parseInt(p.bucketCount) || 5;
        const valid = data.filter(d => d[gKey] != null && d[mKey] != null);
        if (valid.length < 3) { el.innerHTML = '<div class="jarvis-error">Not enough data</div>'; return; }
        const groups = valid.map(d => d[gKey]);
        const measures = valid.map(d => d[mKey]);
        const buckets = bucketAnalysis(groups, measures, nBuckets);
        const maxAvg = Math.max(...buckets.map(b => b.avgVal), 1);
        el.innerHTML = `
            <div class="jarvis-result-card">
                <div class="jarvis-result-label">Bucket: ${indicatorLabel(gKey)} → ${indicatorLabel(mKey)}</div>
                <div class="jarvis-bucket-chart">
                    ${buckets.map(b => {
                        const pct = (b.avgVal / maxAvg * 100).toFixed(0);
                        const display = mKey === 'views' ? fmtViews(b.avgVal) : b.avgVal.toFixed(2);
                        return `<div class="jarvis-bucket-row">
                            <span class="jarvis-bucket-label">${b.label}</span>
                            <div class="jarvis-bucket-bar-wrap"><div class="jarvis-bucket-bar" style="width:${pct}%"></div></div>
                            <span class="jarvis-bucket-val">${display} <span class="jarvis-bucket-n">(n=${b.n})</span></span>
                        </div>`;
                    }).join('')}
                </div>
                <div class="jarvis-result-n">n = ${valid.length} videos</div>
            </div>`;
    }

    // ── log10 Compare ──
    function executeLog10(data, p, el) {
        const aKey = p.signalA, bKey = p.signalB;
        const valid = data.filter(d => d[aKey] != null && d[bKey] != null && d[aKey] > 0 && d[bKey] > 0);
        if (valid.length < 3) { el.innerHTML = '<div class="jarvis-error">Not enough data</div>'; return; }
        const xs = valid.map(d => d[aKey]), ys = valid.map(d => d[bKey]);
        const rRaw = pearsonCorrelation(xs, ys);
        const rLog = pearsonCorrelation(xs.map(v => Math.log10(v)), ys.map(v => Math.log10(v)));
        const colorRaw = Math.abs(rRaw) >= 0.4 ? '#10b981' : Math.abs(rRaw) >= 0.2 ? '#f59e0b' : '#ef4444';
        const colorLog = Math.abs(rLog) >= 0.4 ? '#10b981' : Math.abs(rLog) >= 0.2 ? '#f59e0b' : '#ef4444';
        const better = Math.abs(rLog) > Math.abs(rRaw) ? 'log10' : 'raw';
        el.innerHTML = `
            <div class="jarvis-result-card">
                <div class="jarvis-result-label">log10 Compare: ${indicatorLabel(aKey)} vs ${indicatorLabel(bKey)}</div>
                <div style="display:flex;gap:20px;margin:10px 0">
                    <div style="flex:1">
                        <div style="font-size:11px;color:var(--j-muted);text-transform:uppercase;margin-bottom:4px">Raw</div>
                        <div style="font-size:22px;font-weight:800;font-family:'SF Mono',monospace;color:${colorRaw}">r = ${rRaw.toFixed(4)}</div>
                        <div style="font-size:11px;color:${colorRaw}">${interpretR(rRaw)}</div>
                    </div>
                    <div style="flex:1">
                        <div style="font-size:11px;color:var(--j-muted);text-transform:uppercase;margin-bottom:4px">log10</div>
                        <div style="font-size:22px;font-weight:800;font-family:'SF Mono',monospace;color:${colorLog}">r = ${rLog.toFixed(4)}</div>
                        <div style="font-size:11px;color:${colorLog}">${interpretR(rLog)}</div>
                    </div>
                </div>
                <div class="jarvis-result-interp">log10 normalization ${better === 'log10' ? 'improves' : 'does not improve'} the correlation. Use <strong>${better}</strong> for this signal pair.</div>
                <div class="jarvis-result-n">n = ${valid.length} videos</div>
            </div>`;
    }

    // ── Ratio Normalizer ──
    function executeRatio(data, p, el) {
        const numKey = p.numerator, basis = parseInt(p.basis) || 1000, cmpKey = p.compare;
        const valid = data.filter(d => d[numKey] != null && d.views > 0 && d[cmpKey] != null);
        if (valid.length < 3) { el.innerHTML = '<div class="jarvis-error">Not enough data</div>'; return; }
        const ratios = valid.map(d => (d[numKey] / d.views) * basis);
        const cmpVals = valid.map(d => d[cmpKey]);
        const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        const r = pearsonCorrelation(ratios, cmpVals);
        const color = Math.abs(r) >= 0.4 ? '#10b981' : Math.abs(r) >= 0.2 ? '#f59e0b' : '#ef4444';
        const basisLabel = basis === 100 ? '/100' : basis === 1000 ? '/1k' : '/1M';
        el.innerHTML = `
            <div class="jarvis-result-card">
                <div class="jarvis-result-label">Ratio: ${indicatorLabel(numKey)} ${basisLabel} views → ${indicatorLabel(cmpKey)}</div>
                <div style="font-size:13px;color:var(--j-text);margin:8px 0">Avg ratio: <strong>${avgRatio.toFixed(3)}${basisLabel}</strong> views (range: ${Math.min(...ratios).toFixed(3)} — ${Math.max(...ratios).toFixed(3)})</div>
                <div class="jarvis-result-r" style="color:${color}">r = ${r.toFixed(4)} vs ${indicatorLabel(cmpKey)}</div>
                <div class="jarvis-result-strength" style="color:${color}">${interpretR(r)}</div>
                <div class="jarvis-result-n">n = ${valid.length} videos</div>
            </div>`;
    }

    // ── Net Signal Calculator ──
    function executeNet(data, p, el) {
        const posKey = p.positive, negKey = p.negative, cmpKey = p.compare;
        const valid = data.filter(d => d[posKey] != null && d[negKey] != null && d[cmpKey] != null);
        if (valid.length < 3) { el.innerHTML = '<div class="jarvis-error">Not enough data</div>'; return; }
        const nets = valid.map(d => d[posKey] - d[negKey]);
        const cmpVals = valid.map(d => d[cmpKey]);
        const avgNet = nets.reduce((a, b) => a + b, 0) / nets.length;
        const r = pearsonCorrelation(nets, cmpVals);
        const color = Math.abs(r) >= 0.4 ? '#10b981' : Math.abs(r) >= 0.2 ? '#f59e0b' : '#ef4444';
        const buckets = bucketAnalysis(nets, cmpVals, 5);
        const peakBucket = buckets.reduce((best, b) => b.avgVal > best.avgVal ? b : best, buckets[0]);
        const maxAvg = Math.max(...buckets.map(b => b.avgVal), 1);
        el.innerHTML = `
            <div class="jarvis-result-card">
                <div class="jarvis-result-label">Net: ${indicatorLabel(posKey)} − ${indicatorLabel(negKey)} → ${indicatorLabel(cmpKey)}</div>
                <div style="font-size:13px;color:var(--j-text);margin:8px 0">Avg net value: <strong>${avgNet.toFixed(2)}</strong> (range: ${Math.min(...nets).toFixed(1)} to ${Math.max(...nets).toFixed(1)})</div>
                <div class="jarvis-result-r" style="color:${color}">r = ${r.toFixed(4)} vs ${indicatorLabel(cmpKey)}</div>
                <div class="jarvis-result-strength" style="color:${color}">${interpretR(r)}</div>
                <div class="jarvis-bucket-chart">
                    ${buckets.map(b => {
                        const pct = (b.avgVal / maxAvg * 100).toFixed(0);
                        const display = cmpKey === 'views' ? fmtViews(b.avgVal) : b.avgVal.toFixed(2);
                        return `<div class="jarvis-bucket-row">
                            <span class="jarvis-bucket-label">${b.label}</span>
                            <div class="jarvis-bucket-bar-wrap"><div class="jarvis-bucket-bar" style="width:${pct}%"></div></div>
                            <span class="jarvis-bucket-val">${display} <span class="jarvis-bucket-n">(n=${b.n})</span></span>
                        </div>`;
                    }).join('')}
                </div>
                <div class="jarvis-result-interp">Sweet spot: net value <strong>${peakBucket.label}</strong> (avg ${cmpKey === 'views' ? fmtViews(peakBucket.avgVal) : peakBucket.avgVal.toFixed(2)}, n=${peakBucket.n}). The optimal balance between ${indicatorLabel(posKey)} and ${indicatorLabel(negKey)} appears where the net value maximizes ${indicatorLabel(cmpKey)}.</div>
                <div class="jarvis-result-n">n = ${valid.length} videos</div>
            </div>`;
    }

    // ── Proximity / Clustering ──
    function executeProximity(data, p, el) {
        const signals = p.signals || [];
        if (signals.length < 2) { el.innerHTML = '<div class="jarvis-error">Select at least 2 signals</div>'; return; }
        const method = p.method || 'euclidean';
        const valid = data.filter(d => signals.every(s => d[s] != null));
        if (valid.length < 3) { el.innerHTML = '<div class="jarvis-error">Not enough data</div>'; return; }

        const stats = {};
        signals.forEach(s => {
            const vals = valid.map(d => d[s]);
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
            stats[s] = { mean, std: Math.sqrt(variance) || 1 };
        });

        const distances = valid.map(d => {
            let dist;
            if (method === 'euclidean') {
                const z = signals.map(s => (d[s] - stats[s].mean) / stats[s].std);
                dist = Math.sqrt(z.reduce((a, v) => a + v * v, 0));
            } else {
                const raw = signals.map(s => d[s]);
                const cent = signals.map(s => stats[s].mean);
                const dot = raw.reduce((a, v, j) => a + v * cent[j], 0);
                const magA = Math.sqrt(raw.reduce((a, v) => a + v * v, 0));
                const magB = Math.sqrt(cent.reduce((a, v) => a + v * v, 0));
                dist = (magA > 0 && magB > 0) ? 1 - dot / (magA * magB) : 1;
            }
            return { dist, video: d };
        });

        distances.sort((a, b) => a.dist - b.dist);
        const top5 = distances.slice(0, 5);

        el.innerHTML = `
            <div class="jarvis-result-card">
                <div class="jarvis-result-label">Proximity (${method})</div>
                <div class="jarvis-result-n">${signals.length} signals · n=${valid.length} videos</div>
                <div style="margin-top:10px;font-size:12px;color:var(--j-text);font-weight:600">Top 5 closest to centroid:</div>
                ${top5.map((t, i) => {
                    const vLabel = t.video.views ? fmtViews(t.video.views) + ' views' : '';
                    const sigVals = signals.map(s => `${indicatorLabel(s)}: ${typeof t.video[s] === 'number' ? t.video[s].toFixed(1) : t.video[s]}`).join(' · ');
                    return `<div style="font-size:12px;color:var(--j-muted);padding:6px 0;border-bottom:1px solid var(--j-border)">
                        <span style="color:var(--j-text)">${i + 1}. ${vLabel}</span> — dist: ${t.dist.toFixed(3)}<br>
                        <span style="font-size:10px">${sigVals}</span>
                    </div>`;
                }).join('')}
            </div>`;
    }

    // ══════════════════════════════════════════════════
    // TAB 2: TACTICAL BRAIN — Core Canvas + Signal List
    // ══════════════════════════════════════════════════
    let tacticalDiscoveredNodes = [];
    let tacticalFilter = 'all';
    let tacticalSearch = '';
    let tacticalExpandedSignal = null;

    function renderTactical() {
        loadAutoResearchData(); // load prediction model for signal detail panel
        loadResultsTSV().then(() => {
            drawTacticalFullGraph();
            bindTacticalEvents();
        });
        return `
            <div class="jarvis-tactical-network" style="margin-bottom:12px">
                <canvas id="jarvis-network-canvas" width="400" height="500"></canvas>
                <div id="jarvis-network-tooltip" class="jarvis-network-tooltip" style="display:none;"></div>
            </div>
            <div class="jarvis-network-legend">
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#3b82f6"></span>Analytics</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#8b5cf6"></span>LLM-scored</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#14b8a6"></span>Derived</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#4b5563"></span>Planned</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#f97316"></span>Discovered</span>
            </div>
            <div class="jarvis-signal-list-section">
                <input type="text" class="jarvis-signal-search" id="jarvis-signal-search" placeholder="Search signals..." value="${tacticalSearch}" />
                <div class="jarvis-signal-filters" id="jarvis-signal-filters">
                    ${['all','analytics','llm-scored','derived','discovered','pre-upload','post-upload'].map(f =>
                        `<button class="jarvis-signal-filter-btn${tacticalFilter === f ? ' active' : ''}" data-filter="${f}">${f === 'all' ? 'All' : f === 'llm-scored' ? 'LLM-scored' : f.charAt(0).toUpperCase() + f.slice(1)}</button>`
                    ).join('')}
                </div>
                <div class="jarvis-signal-list" id="jarvis-signal-list">
                    ${renderSignalList()}
                </div>
            </div>`;
    }

    function getNodeColor(ind) {
        if (ind.category === 'discovered') return '#f97316';
        if (ind.category === 'planned') return '#4b5563';
        if (ind.source.startsWith('Derived')) return '#14b8a6';
        if (ind.source.startsWith('YouTube') || ind.source.includes('YouTube')) return '#3b82f6';
        return '#8b5cf6'; // LLM-scored
    }

    function getNodeRadius(key, category) {
        if (category === 'discovered') return 14;
        const large = ['keep', 'retention', 'z_score', 'views', 'vz_score'];
        const medium = ['novelty', 'cognitive_load', 'net_novelty', 'z_type', 'vz_type', 'share_rate'];
        if (large.includes(key)) return 18;
        if (medium.includes(key)) return 14;
        return 10;
    }

    const PRE_UPLOAD_KEYS = new Set(['keep','retention','vz_score','vz_type','z_score','z_type','novelty','cognitive_load','net_novelty','idea_length','pat_making_v2','indestructible_x_prev_keep','hook_clarity','visual_surprise','cut_frequency_3s','face_presence','text_overlay_yn','duration','share_rate']);
    const POST_UPLOAD_KEYS = new Set(['view_accel_log','w2_w1_ratio','sub_gap','prev_views','prev_keep','views','like_ratio','svf_log','engage_ratio','rpv','sub_ret_gap','smoothed_slope','deriv_entropy','duration_x_retention','max_cliff','ret_mid_sq','ret_mid','retention_per_sec']);

    function getSignalUploadPhase(ind) {
        if (PRE_UPLOAD_KEYS.has(ind.key)) return 'pre-upload';
        if (POST_UPLOAD_KEYS.has(ind.key)) return 'post-upload';
        if (ind.category === 'discovered') return 'post-upload';
        return null;
    }

    // Parse discovered signals from results.tsv
    let cachedResultsRows = null;
    async function loadResultsTSV() {
        if (cachedResultsRows) return cachedResultsRows;
        try {
            const resp = await fetch('/api/jarvis/results-tsv');
            const text = await resp.text();
            const lines = text.trim().split('\n');
            const headers = lines[0].split('\t');
            cachedResultsRows = lines.slice(1).filter(l => l.trim()).map(line => {
                const cols = line.split('\t');
                const row = {};
                headers.forEach((h, i) => row[h.trim()] = (cols[i] || '').trim());
                return row;
            });

            // Extract discovered nodes from loop_b rows
            tacticalDiscoveredNodes = cachedResultsRows
                .filter(r => (r.experiment_id || '').startsWith('loop_b'))
                .map(r => {
                    const signalMatch = (r.new_signal || '').match(/^discovery:(.+)$/);
                    const signalKey = signalMatch ? signalMatch[1] : r.new_signal;
                    return {
                        key: signalKey,
                        label: signalKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                        type: 'discovered signal',
                        source: 'Loop B: ' + (r.notes || '').slice(0, 80),
                        category: 'discovered',
                        numeric: true,
                    };
                });

            return cachedResultsRows;
        } catch (e) {
            console.error('Failed to load results.tsv:', e);
            cachedResultsRows = [];
            return [];
        }
    }

    function getSignalFilterCategory(ind) {
        if (ind.category === 'discovered') return 'discovered';
        if (ind.category === 'planned') return 'analytics'; // group planned with analytics
        if (ind.source.startsWith('Derived')) return 'derived';
        if (ind.source.startsWith('YouTube') || ind.source.includes('YouTube')) return 'analytics';
        return 'llm-scored';
    }

    function getAllSignals() {
        const allIndicators = [...INDICATORS];
        tacticalDiscoveredNodes.forEach(d => {
            if (!allIndicators.find(i => i.key === d.key)) {
                allIndicators.push(d);
            }
        });
        return allIndicators;
    }

    function renderSignalList() {
        const allIndicators = getAllSignals();
        const search = tacticalSearch.toLowerCase();
        const filtered = allIndicators.filter(ind => {
            if (tacticalFilter === 'pre-upload' || tacticalFilter === 'post-upload') {
                if (getSignalUploadPhase(ind) !== tacticalFilter) return false;
            } else if (tacticalFilter !== 'all' && getSignalFilterCategory(ind) !== tacticalFilter) return false;
            if (search && !ind.label.toLowerCase().includes(search) && !ind.key.toLowerCase().includes(search)) return false;
            return true;
        });

        if (!filtered.length) return '<div style="color:var(--j-muted);padding:12px;font-size:12px;">No signals match your search.</div>';

        return filtered.map(ind => {
            const color = getNodeColor(ind);
            const filterCat = getSignalFilterCategory(ind);
            const isExpanded = tacticalExpandedSignal === ind.key;
            // Try to find r value from cachedResultsRows
            let rValue = null;
            if (cachedResultsRows) {
                const match = cachedResultsRows.find(r => {
                    const sig = (r.new_signal || '').replace(/^discovery:/, '');
                    return sig === ind.key;
                });
                if (match && match.notes) {
                    const rMatch = match.notes.match(/r[_=]\s*([-+]?[0-9]*\.?[0-9]+)/i);
                    if (rMatch) rValue = parseFloat(rMatch[1]);
                }
            }
            const rBar = rValue !== null ? `<div class="jarvis-signal-rbar"><div class="jarvis-signal-rbar-fill" style="width:${Math.min(Math.abs(rValue) * 100, 100)}%;background:${color}"></div></div>` : '';

            return `<div class="jarvis-signal-row-wrapper">
                <div class="jarvis-signal-row${isExpanded ? ' expanded' : ''}" data-signal-key="${ind.key}">
                    <span class="jarvis-signal-dot" style="background:${color}"></span>
                    <span class="jarvis-signal-name">${ind.label}</span>
                    <span class="jarvis-signal-type-badge">${ind.numeric ? 'numeric' : 'categorical'}</span>
                    <span class="jarvis-signal-source">${filterCat}</span>
                    ${rBar}
                </div>
                ${isExpanded ? renderSignalDetail(ind) : ''}
            </div>`;
        }).join('');
    }

    function renderSignalDetail(ind) {
        const color = getNodeColor(ind);
        // Find experiments that used this signal
        const relatedExps = (cachedResultsRows || []).filter(r => {
            const sig = (r.new_signal || '').replace(/^discovery:/, '');
            return sig === ind.key;
        });
        // Check if in prediction model
        let inModel = false;
        if (arModel) {
            const preFeats = arModel.pre_upload_model?.features || [];
            const fullFeats = arModel.full_model?.features || [];
            inModel = preFeats.includes(ind.key) || fullFeats.includes(ind.key);
        }
        // Determine status
        let status = 'planned';
        if (inModel) status = 'in model';
        else if (ind.category === 'discovered') status = 'discovery';
        else if (ind.category === 'active') status = 'active signal';
        else if (ind.category === 'planned') status = 'planned';
        // Check if discarded
        const discardedExp = relatedExps.find(r => (r.status || '').trim().toLowerCase() === 'discard');
        if (discardedExp && !inModel) status = 'discarded';

        const statusColors = { 'in model': '#10b981', 'discovery': '#f97316', 'active signal': '#3b82f6', 'planned': '#64748b', 'discarded': '#ef4444' };

        return `<div class="jarvis-signal-detail" style="border-left: 3px solid ${color}">
            <div class="jarvis-signal-detail-name">${ind.label}</div>
            <div class="jarvis-signal-detail-meta">
                <span>Type: <strong>${ind.type}</strong></span>
                <span>Source: <strong>${ind.source}</strong></span>
                ${ind.resolution ? `<span>Resolution: <strong>${ind.resolution}</strong></span>` : ''}
                <span>Category: <strong>${getSignalFilterCategory(ind)}</strong></span>
            </div>
            <div class="jarvis-signal-detail-status">
                Status: <span style="color:${statusColors[status] || '#64748b'};font-weight:700">${status.toUpperCase()}</span>
                ${inModel ? ' (in prediction model)' : ''}
            </div>
            ${relatedExps.length ? `
                <div class="jarvis-signal-detail-exps">
                    <div style="font-size:11px;font-weight:600;color:var(--j-muted);text-transform:uppercase;margin-bottom:6px">Experiments (${relatedExps.length})</div>
                    ${relatedExps.map(r => {
                        const st = (r.status || '').trim().toLowerCase();
                        const stColor = st === 'keep' ? '#10b981' : st === 'discard' ? '#ef4444' : '#64748b';
                        return `<div class="jarvis-signal-detail-exp">
                            <span style="color:var(--j-text);font-weight:600">${r.experiment_id}</span>
                            <span class="jarvis-badge" style="background:rgba(${st === 'keep' ? '16,185,129' : '100,100,100'},0.15);color:${stColor}">${st}</span>
                            ${r.delta_r2 && r.delta_r2 !== '—' ? `<span style="font-family:'SF Mono',monospace;font-size:11px;color:var(--j-cyan)">dR²=${r.delta_r2}</span>` : ''}
                            <div style="font-size:10px;color:var(--j-muted);margin-top:2px">${r.notes || ''}</div>
                        </div>`;
                    }).join('')}
                </div>` : '<div style="font-size:11px;color:var(--j-muted);margin-top:8px">No experiments found for this signal.</div>'}
        </div>`;
    }

    function bindTacticalEvents() {
        const searchInput = container?.querySelector('#jarvis-signal-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                tacticalSearch = e.target.value;
                const list = container?.querySelector('#jarvis-signal-list');
                if (list) list.innerHTML = renderSignalList();
                bindSignalRowClicks();
            });
        }
        container?.querySelectorAll('.jarvis-signal-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                tacticalFilter = btn.dataset.filter;
                container.querySelectorAll('.jarvis-signal-filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const list = container?.querySelector('#jarvis-signal-list');
                if (list) list.innerHTML = renderSignalList();
                bindSignalRowClicks();
            });
        });
        bindSignalRowClicks();
    }

    function bindSignalRowClicks() {
        container?.querySelectorAll('.jarvis-signal-row').forEach(row => {
            row.addEventListener('click', () => {
                const key = row.dataset.signalKey;
                tacticalExpandedSignal = tacticalExpandedSignal === key ? null : key;
                const list = container?.querySelector('#jarvis-signal-list');
                if (list) list.innerHTML = renderSignalList();
                bindSignalRowClicks();
            });
        });
    }

    function drawTacticalFullGraph() {
        const canvas = container?.querySelector('#jarvis-network-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.parentElement.clientWidth || 400;
        const H = 500;
        const PAD = 50;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        ctx.scale(dpr, dpr);

        const cx = W / 2, cy = H / 2;
        const allSignals = getAllSignals();

        // Determine node radius based on role
        const CORE_METRICS = new Set(['views', 'keep', 'retention']);
        const inModelKeys = new Set();
        if (arModel) {
            (arModel.pre_upload_model?.features || []).forEach(f => inModelKeys.add(f));
            (arModel.full_model?.features || []).forEach(f => inModelKeys.add(f));
        }

        function nodeRadius(ind) {
            if (CORE_METRICS.has(ind.key)) return 22;
            if (inModelKeys.has(ind.key)) return 18;
            if (ind.category === 'active') return 15;
            if (ind.category === 'discovered') return 12;
            return 10; // planned
        }

        // Build nodes with circular initial positions
        const nodes = allSignals.map((ind, i) => {
            const angle = (i / allSignals.length) * Math.PI * 2;
            const spread = Math.min(W, H) * 0.3;
            return {
                key: ind.key,
                label: ind.label,
                type: ind.type,
                source: ind.source,
                color: getNodeColor(ind),
                r: nodeRadius(ind),
                x: cx + Math.cos(angle) * spread + (Math.random() - 0.5) * 40,
                y: cy + Math.sin(angle) * spread + (Math.random() - 0.5) * 40,
                vx: 0,
                vy: 0,
                category: ind.category,
                ind: ind,
            };
        });
        const nodeMap = {};
        nodes.forEach(n => nodeMap[n.key] = n);

        // Build edges
        const edges = [];
        const edgeSet = new Set();

        function addEdge(a, b, weight, type) {
            const ek = a < b ? a + '|' + b : b + '|' + a;
            if (edgeSet.has(ek)) return;
            edgeSet.add(ek);
            edges.push({ a, b, weight: Math.abs(weight), type });
        }

        // Parse r-values from cachedResultsRows for edge weights
        const signalCorrelations = {};
        if (cachedResultsRows) {
            cachedResultsRows.forEach(row => {
                const sig = (row.new_signal || '').replace(/^discovery:/, '');
                if (!sig || !row.notes) return;
                const notes = row.notes;
                const rpM = notes.match(/r_partial\s*=\s*([-+]?\d*\.?\d+)/i);
                if (rpM) {
                    const rv = parseFloat(rpM[1]);
                    if (!signalCorrelations[sig] || Math.abs(rv) > Math.abs(signalCorrelations[sig].r)) {
                        signalCorrelations[sig] = { metric: 'views', r: rv };
                    }
                    return;
                }
                const rM = notes.match(/\br\s*=\s*([-+]?\d*\.?\d+)/i);
                if (rM) {
                    const rv = parseFloat(rM[1]);
                    const nl = notes.toLowerCase();
                    let metric = 'keep';
                    if (nl.includes('views')) metric = 'views';
                    else if (nl.includes('retention')) metric = 'retention';
                    if (!signalCorrelations[sig] || Math.abs(rv) > Math.abs(signalCorrelations[sig].r)) {
                        signalCorrelations[sig] = { metric, r: rv };
                    }
                }
            });
        }

        // Core metrics connected to everything with correlation data
        nodes.forEach(n => {
            if (CORE_METRICS.has(n.key)) return;
            if (signalCorrelations[n.key]) {
                addEdge(n.key, signalCorrelations[n.key].metric, signalCorrelations[n.key].r, 'correlation');
            }
        });

        // Core-to-core edges
        addEdge('keep', 'retention', 0.7, 'correlation');
        addEdge('keep', 'views', 0.5, 'correlation');
        addEdge('retention', 'views', 0.5, 'correlation');

        // Category edges (weak attraction — half strength, not drawn)
        const catGroups = {};
        nodes.forEach(n => {
            const cat = getSignalFilterCategory(n.ind);
            if (!catGroups[cat]) catGroups[cat] = [];
            catGroups[cat].push(n.key);
        });
        Object.values(catGroups).forEach(group => {
            for (let i = 0; i < group.length; i++) {
                for (let j = i + 1; j < group.length; j++) {
                    addEdge(group[i], group[j], 0.2, 'category');
                }
            }
        });

        // Force-directed simulation
        for (let iter = 0; iter < 200; iter++) {
            // Repulsion between all pairs
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i], b = nodes[j];
                    let dx = b.x - a.x, dy = b.y - a.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    if (dist < 120) {
                        const force = 800 / (dist * dist);
                        const fx = (dx / dist) * force;
                        const fy = (dy / dist) * force;
                        a.vx -= fx; a.vy -= fy;
                        b.vx += fx; b.vy += fy;
                    }
                }
            }

            // Spring attraction for edges
            edges.forEach(e => {
                const na = nodeMap[e.a], nb = nodeMap[e.b];
                if (!na || !nb) return;
                const dx = nb.x - na.x, dy = nb.y - na.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const strength = e.type === 'category' ? 0.02 : 0.04;
                const displacement = dist - 90;
                const fx = (dx / dist) * displacement * strength;
                const fy = (dy / dist) * displacement * strength;
                na.vx += fx; na.vy += fy;
                nb.vx -= fx; nb.vy -= fy;
            });

            // Center gravity
            nodes.forEach(n => {
                n.vx += (cx - n.x) * 0.002;
                n.vy += (cy - n.y) * 0.002;
            });

            // Apply velocities with damping + boundary
            nodes.forEach(n => {
                n.vx *= 0.85;
                n.vy *= 0.85;
                n.x += n.vx;
                n.y += n.vy;
                n.x = Math.max(PAD + n.r, Math.min(W - PAD - n.r, n.x));
                n.y = Math.max(PAD + n.r, Math.min(H - PAD - n.r, n.y));
            });
        }

        // Draw correlation edges (not category edges)
        edges.forEach(e => {
            const na = nodeMap[e.a], nb = nodeMap[e.b];
            if (!na || !nb || e.type === 'category') return;
            const thickness = Math.min(0.5 + e.weight * 3, 3);
            const opacity = Math.min(0.15 + e.weight * 0.4, 0.6);
            ctx.beginPath();
            ctx.strokeStyle = `rgba(100, 116, 139, ${opacity})`;
            ctx.lineWidth = thickness;
            ctx.moveTo(na.x, na.y);
            ctx.lineTo(nb.x, nb.y);
            ctx.stroke();
        });

        // Draw nodes
        nodes.forEach(n => {
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
            ctx.fillStyle = n.color;
            ctx.globalAlpha = 0.85;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // Draw labels with dark pill background
        nodes.forEach(n => {
            const fontSize = CORE_METRICS.has(n.key) ? 11 : 9;
            ctx.font = `${fontSize}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            const truncated = n.label.length > 14 ? n.label.slice(0, 13) + '\u2026' : n.label;
            const textW = ctx.measureText(truncated).width;
            const pillX = n.x - textW / 2 - 3;
            const pillY = n.y + n.r + 4;
            const pillW = textW + 6;
            const pillH = fontSize + 4;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(pillX, pillY, pillW, pillH, 3);
            } else {
                ctx.rect(pillX, pillY, pillW, pillH);
            }
            ctx.fill();
            ctx.fillStyle = '#cbd5e1';
            ctx.fillText(truncated, n.x, pillY + fontSize);
        });

        // Tooltip
        const tooltip = container?.querySelector('#jarvis-network-tooltip');
        canvas.onmousemove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            let hit = null;
            for (const n of nodes) {
                const dx = mx - n.x, dy = my - n.y;
                if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) { hit = n; break; }
            }
            if (hit && tooltip) {
                tooltip.style.display = 'block';
                tooltip.style.left = (hit.x + hit.r + 8) + 'px';
                tooltip.style.top = (hit.y - 10) + 'px';
                tooltip.innerHTML = `<strong>${hit.label}</strong><br><span class="jarvis-tt-dim">Type:</span> ${hit.type}<br><span class="jarvis-tt-dim">Source:</span> ${hit.source}`;
                canvas.style.cursor = 'pointer';
            } else if (tooltip) {
                tooltip.style.display = 'none';
                canvas.style.cursor = 'default';
            }
        };

        // Click node -> expand in signal list + scroll to entry
        canvas.onclick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            for (const n of nodes) {
                const dx = mx - n.x, dy = my - n.y;
                if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) {
                    tacticalExpandedSignal = tacticalExpandedSignal === n.key ? null : n.key;
                    const list = container?.querySelector('#jarvis-signal-list');
                    if (list) {
                        list.innerHTML = renderSignalList();
                        bindSignalRowClicks();
                        const row = list.querySelector(`[data-signal-key="${n.key}"]`);
                        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                    break;
                }
            }
        };
    }

    // ══════════════════════════════════════════════════
    // TAB 3: EXPERIMENTS — Unified log from results.tsv
    // ══════════════════════════════════════════════════
    let expCollapsed = {};
    let expSort = 'newest'; // 'best_r2' | 'newest' | 'kept'
    let expExplainOpen = false;

    function renderExperiments() {
        loadResultsTSV().then(rows => {
            const el = container?.querySelector('.jarvis-exp-root');
            if (!el) return;
            el.innerHTML = renderExperimentsContent(rows);
            bindExperimentEvents();
        });
        // Also load prediction model for R²
        loadAutoResearchData();
        return '<div class="jarvis-exp-root"><div class="jarvis-loading">Loading experiments from results.tsv...</div></div>';
    }

    function categorizeExperiment(expId) {
        if (expId.startsWith('loop_b')) return { cat: 'loop_b', label: 'Signal Discoveries', color: '#f97316' };
        if (expId.startsWith('loop_c')) return { cat: 'loop_c', label: 'Causal Tree', color: '#06b6d4' };
        if (expId.startsWith('loop_d')) return { cat: 'loop_d', label: 'Retention Mapping', color: '#a78bfa' };
        return { cat: 'exp', label: 'Model Experiments', color: '#3b82f6' };
    }

    function humanizeSignalName(raw) {
        if (!raw) return 'Unnamed result';
        const key = String(raw).replace(/^discovery:/, '').trim();
        const map = {
            keep_sq: 'Non-linear Keep Rate',
            ret_mid: 'Midpoint Retention',
            ret_end: 'End Retention',
            ret_var: 'Retention Curve Variance',
            ret_mid_sq: 'Non-linear Midpoint Retention',
            retention_per_sec_alongside: 'Retention + Duration Context',
            sub_ret_gap: 'Subscriber vs Non-Subscriber Retention Gap',
            max_cliff: 'Largest Retention Cliff',
            hook_word_density: 'Hook Word Density',
            pat_indestructible: 'Indestructible / Bulletproof Pattern',
            cat_superhero: 'Superhero Build Category',
            prev_views: 'Previous Video Views',
            prev_keep: 'Previous Video Keep Rate',
            prev_views_sq: 'Non-linear Previous Video Views',
            indestructible_x_prev_keep: 'Indestructible × Previous Keep Interaction',
            has_text_overlay: 'First-Frame Text Overlay',
            duration_x_retention: 'Duration × Retention',
            effective_watch_sec: 'Effective Watch Seconds',
            smoothed_slope: 'Smoothed Retention Slope',
            idea_length: 'Idea Length',
            stakes_x_duration: 'Stakes × Duration',
            stakes: 'Perceived Stakes',
            deriv_entropy: 'Pacing Entropy',
            hook_silence: 'Silent Visual Hook',
            view_acceleration: 'View Acceleration',
            day1_share: 'Day 1 Share of Total Views',
            w2_w1_ratio: 'Week 2 vs Week 1 Ratio',
            pre_upload_model_10feat: 'Pre-Upload Prediction Model',
            pre_upload_final_6feat: 'Final Pre-Upload Model',
            final_12feat: 'Final 12-Feature Model',
            final_13feat: 'Final 13-Feature Model',
            final_14feat: 'Final 14-Feature Model',
            final_15feat: 'Final 15-Feature Model',
            final_17feat: 'Final 17-Feature Model',
            feature_selection: 'Feature Selection Pass',
            backward_elimination: 'Backward Elimination',
            optimized_8feat: 'Optimized 8-Feature Model',
            forward_12feat: 'Forward Selection 12-Feature Model',
        };
        if (map[key]) return map[key];
        return key
            .replace(/^exp_/, '')
            .replace(/^loop_[a-z]_/, '')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    function sortExperimentRows(rows, sort) {
        const sorted = [...rows];
        if (sort === 'best_r2') {
            sorted.sort((a, b) => {
                let aR = parseFloat(a.delta_r2) || 0;
                let bR = parseFloat(b.delta_r2) || 0;
                // For discoveries, try to parse r from notes
                if (!aR && a.notes) { const m = a.notes.match(/r[_=]\s*([-+]?[0-9]*\.?[0-9]+)/i); if (m) aR = Math.abs(parseFloat(m[1])); }
                if (!bR && b.notes) { const m = b.notes.match(/r[_=]\s*([-+]?[0-9]*\.?[0-9]+)/i); if (m) bR = Math.abs(parseFloat(m[1])); }
                return bR - aR;
            });
        } else if (sort === 'kept') {
            sorted.sort((a, b) => {
                const aKept = (a.status || '').trim().toLowerCase() === 'keep' ? 1 : 0;
                const bKept = (b.status || '').trim().toLowerCase() === 'keep' ? 1 : 0;
                return bKept - aKept;
            });
        }
        // 'newest' = default order from file (already chronological)
        return sorted;
    }

    function boldRValues(text) {
        return text.replace(/(r[_=]\s*[-+]?[0-9]*\.?[0-9]+)/gi, '<strong style="color:var(--j-cyan)">$1</strong>');
    }

    function renderExperimentsContent(rows) {
        if (!rows || !rows.length) return '<div class="jarvis-error">No experiments found.</div>';

        // Group by category
        const groups = {};
        rows.forEach(row => {
            const { cat } = categorizeExperiment(row.experiment_id || '');
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(row);
        });

        const groupOrder = ['exp', 'loop_b', 'loop_c', 'loop_d'];
        const loopBCount = (groups.loop_b || []).length;
        const keepCount = rows.filter(r => (r.status || '').trim().toLowerCase() === 'keep').length;
        const currentR2 = arModel ? arModel.r2 || 0.147 : 0.147;

        // Category explanation cards
        const explanationCards = [
            { cat: 'exp', color: '#3b82f6', title: 'Model Experiments', text: 'These are experiments that tested whether adding a new signal improves the prediction model. The model predicts how many views a video will get. Each experiment adds one new signal, trains the model, and measures the R\u00b2 improvement on a held-out test set. KEPT means it improved predictions. DISCARDED means it added noise or was circular.' },
            { cat: 'loop_b', color: '#f97316', title: 'Signal Discoveries', text: 'These are observations from the data \u2014 things that correlate with views or keep rate. They are NOT yet validated by the prediction model. Think of them as hypotheses: interesting patterns found by exploring the 203-video dataset. Many correlate individually but fail when added to the full model because they\'re already captured by something else.' },
            { cat: 'loop_c', color: '#06b6d4', title: 'Causal Tree', text: 'These measure what causes the intermediate metrics (keep rate, retention) rather than views directly. The goal: find what you can control BEFORE shooting that will cause good keep rate and retention. Measured against keep/retention as the target, not log(views).' },
            { cat: 'loop_d', color: '#a78bfa', title: 'Retention Mapping', text: 'These analyze the second-by-second retention curve aligned with what\'s being said and shown at each moment. What words cause retention gains? What visual types cause drops? The goal: find specific techniques that move the retention needle at specific timestamps.' },
        ];

        let html = '';

        // Collapsible explanation section
        html += `<div class="jarvis-exp-explain-toggle" id="jarvis-exp-explain-toggle">
            <span>${expExplainOpen ? '▼' : '▶'}</span> What do these categories mean?
        </div>`;
        if (expExplainOpen) {
            html += `<div class="jarvis-exp-explain-cards">
                ${explanationCards.map(c => `<div class="jarvis-exp-explain-card" style="border-left:3px solid ${c.color}">
                    <div class="jarvis-exp-explain-card-title" style="color:${c.color}">${c.title}</div>
                    <div class="jarvis-exp-explain-card-text">${c.text}</div>
                </div>`).join('')}
            </div>`;
        }

        // Summary bar
        html += `<div class="jarvis-exp-summary">
            <span class="jarvis-exp-summary-item"><strong>${rows.length}</strong> experiments</span>
            <span class="jarvis-exp-summary-item" style="color:#f97316"><strong>${loopBCount}</strong> signals discovered</span>
            <span class="jarvis-exp-summary-item" style="color:#10b981"><strong>${keepCount}</strong> signals kept</span>
            <span class="jarvis-exp-summary-item" style="color:#3b82f6">R² = <strong>${currentR2.toFixed(3)}</strong></span>
        </div>`;

        // Sort controls
        html += `<div class="jarvis-exp-sort-bar">
            <span style="font-size:11px;color:var(--j-muted);font-weight:600">Sort by:</span>
            ${[{id:'newest',label:'Newest'},{id:'best_r2',label:'Best R\u00b2 \u2193'},{id:'kept',label:'Status: kept'}].map(s =>
                `<button class="jarvis-exp-sort-btn${expSort === s.id ? ' active' : ''}" data-sort="${s.id}">${s.label}</button>`
            ).join('')}
        </div>`;

        // Grouped sections
        groupOrder.forEach(cat => {
            const catRows = groups[cat];
            if (!catRows || !catRows.length) return;
            const sortedRows = sortExperimentRows(catRows, expSort);
            const info = categorizeExperiment(cat === 'exp' ? 'exp_x' : cat + '_x');
            const isCollapsed = expCollapsed[cat] === true;

            html += `<div class="jarvis-exp-group">
                <div class="jarvis-exp-group-header" data-group="${cat}">
                    <span class="jarvis-exp-group-toggle">${isCollapsed ? '▶' : '▼'}</span>
                    <span class="jarvis-exp-group-label" style="color:${info.color}">${info.label}</span>
                    <span class="jarvis-exp-group-count">${catRows.length}</span>
                </div>`;

            if (!isCollapsed) {
                html += '<div class="jarvis-experiments">';
                sortedRows.forEach(row => {
                    const isDiscovery = cat === 'loop_b';
                    const status = (row.status || '').trim().toLowerCase();
                    const signalMatch = (row.new_signal || '').match(/^discovery:(.+)$/);
                    const signalRaw = signalMatch ? signalMatch[1] : (row.new_signal || '');
                    const signalName = humanizeSignalName(signalRaw);
                    const notes = row.notes || '';

                    // Determine resolution badge for this experiment
                    const signalLower = (row.new_signal || '').toLowerCase();
                    const hasCurveFeature = /ret_mid|ret_end|retention_at_\d+s|ret_\d+pct|curve|per.?sec/i.test(notes + ' ' + signalName);
                    const hasWholeVideo = /\b(keep|retention|views|share_rate)\b/.test(signalLower) && !hasCurveFeature;
                    let expResBadge = '';
                    if (hasCurveFeature) {
                        expResBadge = `<span class="jarvis-res-pill" style="color:${info.color}">\u00b7 R2</span>`;
                    } else if (hasWholeVideo) {
                        expResBadge = `<span class="jarvis-res-pill" style="color:${info.color}">\u00b7 R0</span>`;
                    }

                    if (isDiscovery) {
                        html += `<div class="jarvis-exp-card jarvis-exp-discovery">
                            <h4>${signalName} ${expResBadge}</h4>
                            <div class="jarvis-exp-finding jarvis-exp-finding-full">${boldRValues(notes)}</div>
                            <div class="jarvis-exp-badges">
                                <span class="jarvis-badge" style="background:rgba(249,115,22,0.15);color:#f97316">DISCOVERY</span>
                                <span class="jarvis-badge n-badge">n=${row.n_videos || '\u2014'}</span>
                            </div>
                        </div>`;
                    } else {
                        const hasR2 = row.delta_r2 && row.delta_r2 !== '\u2014';
                        const barColor = status === 'keep' ? '#10b981' : status === 'error' ? '#ef4444' : '#64748b';
                        html += `<div class="jarvis-exp-card">
                            <h4>${row.experiment_id}: ${signalName} ${expResBadge}</h4>
                            ${hasR2 ? `<div class="jarvis-exp-r" style="color:${barColor}">\u0394R\u00b2 = ${row.delta_r2} (${row.r2_before}\u2192${row.r2_after})</div>` : ''}
                            <div class="jarvis-exp-finding jarvis-exp-finding-full">${notes}</div>
                            <div class="jarvis-exp-badges">
                                <span class="jarvis-badge status-badge" style="background:rgba(${status === 'keep' ? '16,185,129' : status === 'error' ? '248,113,113' : '100,100,100'},0.15);color:${barColor}">${status}</span>
                                <span class="jarvis-badge n-badge">n=${row.n_videos || '\u2014'}</span>
                            </div>
                        </div>`;
                    }
                });
                html += '</div>';
            }
            html += '</div>';
        });

        return html;
    }

    function reRenderExperiments() {
        loadResultsTSV().then(rows => {
            const el = container?.querySelector('.jarvis-exp-root');
            if (el) {
                el.innerHTML = renderExperimentsContent(rows);
                bindExperimentEvents();
            }
        });
    }

    function bindExperimentEvents() {
        container?.querySelectorAll('.jarvis-exp-group-header').forEach(header => {
            header.addEventListener('click', () => {
                const group = header.dataset.group;
                expCollapsed[group] = !expCollapsed[group];
                reRenderExperiments();
            });
        });
        container?.querySelectorAll('.jarvis-exp-sort-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                expSort = btn.dataset.sort;
                reRenderExperiments();
            });
        });
        const explainToggle = container?.querySelector('#jarvis-exp-explain-toggle');
        if (explainToggle) {
            explainToggle.addEventListener('click', () => {
                expExplainOpen = !expExplainOpen;
                reRenderExperiments();
            });
        }
    }

    // ══════════════════════════════════════════════════
    // TAB 4: AUTORESEARCH — Engine only
    // ══════════════════════════════════════════════════
    let arModel = null;
    let arHypotheses = null;

    async function loadAutoResearchData() {
        if (!arModel) {
            try {
                const r = await fetch('./buildings/jarvis/prediction-model.json');
                arModel = await r.json();
            } catch (e) { arModel = null; }
        }
        if (!arHypotheses) {
            try {
                const r = await fetch('./buildings/jarvis/hypothesis-queue.json');
                arHypotheses = await r.json();
            } catch (e) { arHypotheses = []; }
        }
    }

    function renderAutoResearch() {
        loadAutoResearchData().then(() => {
            const el = container?.querySelector('.jarvis-ar-root');
            if (el) {
                el.innerHTML = renderAutoResearchContent();
                bindAutoResearchEvents();
                loadLoopStatus();
            }
        });
        return '<div class="jarvis-ar-root"><div style="color:var(--j-muted);padding:20px;">Loading AutoResearch data…</div></div>';
    }

    async function loadLoopStatus() {
        const statusEl = container?.querySelector('.jarvis-loop-status-grid');
        if (!statusEl) return;
        try {
            const resp = await fetch('/api/jarvis/loop-status');
            const status = await resp.json();
            const loops = [
                { id: 'A', name: 'Non-Linear Architecture', purpose: 'Test non-linear model architectures and feature transforms' },
                { id: 'B', name: 'Signal Discovery', purpose: 'Discover new signals via partial correlation screening' },
                { id: 'C', name: 'Causal Tree', purpose: 'Map causal relationships between signals and outcomes' },
                { id: 'D', name: 'Retention Mapping', purpose: 'Channel×timestamp retention pattern analysis' },
            ];
            statusEl.innerHTML = loops.map(loop => {
                const s = status[loop.id] || {};
                const age = s.ageMinutes || Infinity;
                let statusLabel, statusColor;
                if (age < 120) { statusLabel = 'active'; statusColor = '#10b981'; }
                else if (age < 360) { statusLabel = 'stale'; statusColor = '#f59e0b'; }
                else { statusLabel = 'dead'; statusColor = '#ef4444'; }
                const lastMod = s.lastModified ? new Date(s.lastModified).toLocaleString() : 'never';
                return `<div class="jarvis-loop-card">
                    <div class="jarvis-loop-card-header">
                        <span class="jarvis-loop-card-id">Loop ${loop.id}</span>
                        <span class="jarvis-loop-card-status" style="background:${statusColor}20;color:${statusColor}">${statusLabel}</span>
                    </div>
                    <div class="jarvis-loop-card-purpose">${loop.purpose}</div>
                    <div class="jarvis-loop-card-time">Last: ${lastMod}</div>
                    <button class="jarvis-loop-card-log-btn" data-loop="${loop.id}">View Log</button>
                    <div class="jarvis-loop-card-log" id="jarvis-loop-log-${loop.id}" style="display:none;"></div>
                </div>`;
            }).join('');

            // Bind log buttons
            statusEl.querySelectorAll('.jarvis-loop-card-log-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const loopId = btn.dataset.loop;
                    const logEl = container?.querySelector(`#jarvis-loop-log-${loopId}`);
                    if (!logEl) return;
                    if (logEl.style.display === 'block') {
                        logEl.style.display = 'none';
                        btn.textContent = 'View Log';
                        return;
                    }
                    logEl.style.display = 'block';
                    logEl.textContent = 'Loading...';
                    btn.textContent = 'Hide Log';
                    try {
                        const resp = await fetch(`/api/jarvis/loop-log?loop=${loopId}`);
                        logEl.textContent = await resp.text();
                    } catch (e) {
                        logEl.textContent = 'Failed to load log.';
                    }
                });
            });
        } catch (e) {
            statusEl.innerHTML = '<div class="jarvis-error">Failed to load loop status</div>';
        }
    }

    let arSummaryOpen = true;

    function renderAutoResearchContent() {
        if (!arModel) return '<div style="color:#f87171;padding:20px;">Failed to load prediction model.</div>';
        const m = arModel;
        // Pre-upload model inputs (6 features, CV=0.350)
        const preUploadSignals = [
            { key: 'keep_sq', label: 'Keep Rate²', placeholder: 'e.g. 6400 (80²)', def: 6400, derive: (v) => v, note: 'keep² — enter raw or type keep below' },
            { key: 'max_cliff', label: 'Max Cliff', placeholder: '0–1', def: 0.20, note: 'Biggest single-point retention drop' },
            { key: 'keep_x_tension', label: 'Keep × Tension', placeholder: 'e.g. 240', def: 240, note: 'keep rate × narrative tension count' },
            { key: 'retention', label: 'Retention %', placeholder: '0–100', def: 60, note: 'Average percent viewed' },
            { key: 'visual_workshop', label: 'Visual Workshop', placeholder: '0 or 1', def: 1, note: '1 if build/workshop content' },
            { key: 'novelty', label: 'Novelty', placeholder: '1–10', def: 7, note: 'LLM-scored novelty' },
        ];
        // Full model additional inputs (6 more features for 12 total, CV=0.664)
        const fullModelSignals = [
            { key: 'indestructible_x_prev_keep', label: 'Indestructible × Prev Keep', placeholder: '0–84', def: 0, note: 'Indestructible concept × prev keep rate' },
            { key: 'deriv_entropy', label: 'Pacing Complexity', placeholder: '0–5', def: 2.5, note: 'Entropy of retention curve derivative' },
            { key: 'prev_views', label: 'Prev Video Views (log10)', placeholder: '5–9', def: 6.5, note: 'log10 of previous video views' },
            { key: 'prev_keep', label: 'Prev Video Keep %', placeholder: '0–100', def: 75, note: 'Previous video keep rate' },
            { key: 'smoothed_slope', label: 'Smoothed Slope', placeholder: '-1 to 0', def: -0.3, note: 'Slope of 5-pt moving avg retention' },
            { key: 'pat_making_v2', label: 'Making Content', placeholder: '0 or 1', def: 1, note: '1 if title has making/build/creat' },
            { key: 'duration_x_retention', label: 'Duration × Retention', placeholder: '10–120', def: 45, note: 'Duration(s) × retention(%)/100' },
            { key: 'ret_mid_sq', label: 'Mid Retention²', placeholder: '0–1', def: 0.36, note: 'Midpoint retention (0-1) squared' },
            { key: 'idea_length', label: 'Idea Length', placeholder: 'word count', def: 25, note: 'Word count of video concept' },
            { key: 'view_accel_log', label: 'View Acceleration (log)', placeholder: '-1 to 3', def: 0.5, note: 'log10(day3-7 avg / day1 views)' },
            { key: 'w2_w1_ratio', label: 'Week2/Week1 Ratio', placeholder: '0–25', def: 1.0, note: 'Week 2 views / Week 1 views' },
        ];

        const statusBadge = (s) => {
            if (s === 'complete') return '<span class="jarvis-ar-status jarvis-ar-status-complete">complete</span>';
            if (s === 'running') return '<span class="jarvis-ar-status jarvis-ar-status-running">running</span>';
            return '<span class="jarvis-ar-status jarvis-ar-status-queued">queued</span>';
        };

        const r2 = 0.664;
        const target = 0.80;
        const pct = Math.min(100, Math.round((r2 / target) * 100));

        return `
            <!-- Research Summary -->
            <div class="jarvis-ar-section">
                <div class="jarvis-ar-summary-toggle" id="jarvis-ar-summary-toggle">
                    <h3 class="jarvis-ar-title" style="display:inline;cursor:pointer">
                        <span>${arSummaryOpen ? '\u25BC' : '\u25B6'}</span> Research Summary
                    </h3>
                </div>
                ${arSummaryOpen ? `<div class="jarvis-ar-summary-cards">
                    <div class="jarvis-ar-summary-card" style="border-left:3px solid #3b82f6">
                        <div class="jarvis-ar-summary-card-title" style="color:#3b82f6">The Prediction Model</div>
                        <div class="jarvis-ar-summary-card-text">
                            <p>We analyzed 203 of Tyler's YouTube videos and ran 2,271 experiments to find what predicts viral success. The model currently explains 66% of view variance (R\u00b2=0.664). Prediction accuracy: \u00b12.5x. Two versions: Pre-upload model (35% variance, 6 signals you can control before shooting) and Full model (66% variance, includes early trajectory signals).</p>
                            <p style="margin-top:8px;font-weight:600">The most predictive signals are:</p>
                            <ul>
                                <li><strong>Keep Rate\u00b2</strong> \u2014 non-linear: above 75% keep rate, each percent doubles hit rate</li>
                                <li><strong>Max Cliff</strong> \u2014 bigger retention drops = more views (signals dramatic narrative moments)</li>
                                <li><strong>Previous Video Views</strong> \u2014 channel momentum: bigger hit \u2192 bigger push on next video</li>
                                <li><strong>View Acceleration</strong> \u2014 day3-7 vs day1 views. Sustained trajectory beats day-1 spike</li>
                                <li><strong>Making/Build content</strong> \u2014 avg 19.7M views vs 5.6M for other formats</li>
                            </ul>
                        </div>
                    </div>
                    <div class="jarvis-ar-summary-card" style="border-left:3px solid #06b6d4">
                        <div class="jarvis-ar-summary-card-title" style="color:#06b6d4">What Causes Keep Rate (pre-upload)</div>
                        <div class="jarvis-ar-summary-card-text">
                            <p>These signals were found to cause better keep rate \u2014 things you can control before shooting:</p>
                            <ul>
                                <li><strong>Pivot density:</strong> more but/wait/however transitions \u2192 higher keep rate (r=+0.26)</li>
                                <li><strong>Action word density in hook:</strong> physical/action hooks beat talking hooks (r=+0.15)</li>
                                <li><strong>Indestructible/bulletproof/superhero concept:</strong> avg 61M views vs 5.6M (7 videos \u2014 confirmed category)</li>
                                <li><strong>Making/Build content:</strong> avg 19.7M views (34 videos)</li>
                            </ul>
                            <p style="margin-top:8px;color:var(--j-muted);font-style:italic">NOT causal: Zeigarnik score, novelty, cognitive load \u2014 these correlate with keep rate but don't improve the prediction model.</p>
                        </div>
                    </div>
                    <div class="jarvis-ar-summary-card" style="border-left:3px solid #a78bfa">
                        <div class="jarvis-ar-summary-card-title" style="color:#a78bfa">What Retention Curves Reveal</div>
                        <div class="jarvis-ar-summary-card-text">
                            <p>Second-by-second retention analysis of 372 videos found:</p>
                            <ul>
                                <li><strong>Late narrative peak beats early:</strong> videos peaking at 60-80% of runtime get 10x more views than videos that peak early</li>
                                <li><strong>Visceral words retain:</strong> painful, difference, hurt cause retention gains. Transition words (so, however) cause drops (-11%)</li>
                                <li><strong>Final 5% is the mega-virality differentiator:</strong> top videos hold +8% above baseline in the last 5% of video</li>
                                <li><strong>Physical challenge visuals +12%</strong> at retention peaks. Product/food shots without human anchor cause drops</li>
                                <li><strong>Anticipation phrases retain:</strong> would it, what if, let's see create +6-8% bumps</li>
                            </ul>
                        </div>
                    </div>
                    <div class="jarvis-ar-summary-card" style="border-left:3px solid #10b981">
                        <div class="jarvis-ar-summary-card-title" style="color:#10b981">What Doesn't Matter (Yet)</div>
                        <div class="jarvis-ar-summary-card-text">
                            <p>Signals that were tested but did NOT improve the prediction model:</p>
                            <ul>
                                <li><strong>Zeigarnik score</strong> \u2014 correlates with keep rate (r=0.18) but already captured by keep\u00b2</li>
                                <li><strong>Cognitive load</strong> \u2014 weak negative correlation, dominated by other signals</li>
                                <li><strong>Net novelty (novelty - cognitive_load)</strong> \u2014 interesting concept, redundant in full model</li>
                                <li><strong>Text overlay presence</strong> \u2014 no significant effect on views or keep rate</li>
                                <li><strong>Silent visual hook</strong> \u2014 tested but inconclusive at n=203</li>
                            </ul>
                        </div>
                    </div>
                </div>` : ''}
            </div>

            <!-- Pipeline Architecture -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">Pipeline Architecture</h3>
                <p class="jarvis-ar-subtitle">Causal flow from raw data to prediction output.</p>
                <div class="jarvis-pipeline-flow">
                    <div class="jarvis-pipeline-stage" style="border-left-color:#6b7280">
                        <div class="jarvis-pipeline-stage-num">1</div>
                        <div class="jarvis-pipeline-stage-body">
                            <strong>RESOLUTION</strong>
                            <p>Defines the unit of analysis (whole video → per-second → per-frame). Determines what resolution level each indicator lives at.</p>
                        </div>
                    </div>
                    <div class="jarvis-pipeline-arrow">↓</div>
                    <div class="jarvis-pipeline-stage" style="border-left-color:#14b8a6">
                        <div class="jarvis-pipeline-stage-num">2</div>
                        <div class="jarvis-pipeline-stage-body">
                            <strong>TACTICAL BRAIN</strong>
                            <p>Stores all indicators and data points. Each indicator tagged with resolution level (R0–R5). Discovered nodes from AutoResearch loop automatically appear here.</p>
                        </div>
                    </div>
                    <div class="jarvis-pipeline-arrow">↓</div>
                    <div class="jarvis-pipeline-stage" style="border-left-color:#3b82f6">
                        <div class="jarvis-pipeline-stage-num">3</div>
                        <div class="jarvis-pipeline-stage-body">
                            <strong>ANALYTICAL BRAIN</strong>
                            <p>Measurement tools: Pearson, Bucket, log10, Ratio, Net Signal, LLM Scorer. Model tools: OLS, Cross-Validated Regression, Forward/Backward Selection, GBM, Random Forest, OLS+GBM Blend.</p>
                        </div>
                    </div>
                    <div class="jarvis-pipeline-arrow">↓</div>
                    <div class="jarvis-pipeline-stage" style="border-left-color:#10b981">
                        <div class="jarvis-pipeline-stage-num">4</div>
                        <div class="jarvis-pipeline-stage-body">
                            <strong>EXPERIMENTS</strong>
                            <p>Results of running measurement tools on indicator combinations. One unified log (results.tsv). Includes model experiments + signal discoveries. Tracks R² improvement over time.</p>
                        </div>
                    </div>
                    <div class="jarvis-pipeline-arrow">↓</div>
                    <div class="jarvis-pipeline-stage" style="border-left-color:#8b5cf6">
                        <div class="jarvis-pipeline-stage-num">5</div>
                        <div class="jarvis-pipeline-stage-body">
                            <strong>PREDICTION MODEL</strong>
                            <p>Output: which combination of indicators predicts views. Pre-upload: 6 features, CV R²=0.350. Full: 12 features, CV R²=0.664, ±2.5x. Target: R²>0.80.</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Loop Status -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">Loop Status</h3>
                <p class="jarvis-ar-subtitle">Real-time status of autonomous research loops.</p>
                <div class="jarvis-loop-status-grid"></div>
            </div>

            <!-- Framework -->
            <div class="jarvis-ar-section jarvis-ar-framework">
                <h3 class="jarvis-ar-title">AutoResearch — Karpathy-style Autonomous Research Loop</h3>
                <p class="jarvis-ar-subtitle">Autonomous agent improves the prediction model overnight. The agent scores new signals, runs experiments, keeps improvements, discards failures — loop forever until R² > 0.80.</p>

                <div class="jarvis-ar-framework-cols">
                    <div class="jarvis-ar-framework-col">
                        <h4 class="jarvis-ar-framework-heading">How it works</h4>
                        <ul class="jarvis-ar-framework-list">
                            <li>program.md defines the research rules and metric (R²)</li>
                            <li>Agent picks the next hypothesis from the queue</li>
                            <li>Scores new signal on 203 videos via LLM vision</li>
                            <li>Runs regression with new signal — keep if R² improves > 0.01</li>
                            <li>Logs result to results.tsv, updates model, repeats</li>
                            <li>Never stops until manually interrupted</li>
                        </ul>
                    </div>
                    <div class="jarvis-ar-framework-col">
                        <h4 class="jarvis-ar-framework-heading">Current stats</h4>
                        <div class="jarvis-ar-framework-stats">
                            <div class="jarvis-ar-fstat"><span>Model version</span><strong>v20 (clean)</strong></div>
                            <div class="jarvis-ar-fstat"><span>Pre-upload R²</span><strong>0.350 (6 features)</strong></div>
                            <div class="jarvis-ar-fstat"><span>Full model R²</span><strong>0.664 (12 features)</strong></div>
                            <div class="jarvis-ar-fstat jarvis-ar-fstat-bar">
                                <span>Progress</span>
                                <div class="jarvis-ar-progress-track">
                                    <div class="jarvis-ar-progress-fill" style="width:${pct}%"></div>
                                    <div class="jarvis-ar-progress-label">${pct}%</div>
                                </div>
                            </div>
                            <div class="jarvis-ar-fstat"><span>Videos</span><strong>203</strong></div>
                            <div class="jarvis-ar-fstat"><span>Active signals</span><strong>12 (full) / 6 (pre-upload)</strong></div>
                            <div class="jarvis-ar-fstat"><span>Hypotheses queued</span><strong>${(arHypotheses || []).filter(h => h.status === 'queued').length || 6}</strong></div>
                        </div>
                    </div>
                </div>

                <div class="jarvis-ar-framework-actions">
                    <a href="./buildings/jarvis/program.md" target="_blank" class="jarvis-ar-framework-btn">Read program.md →</a>
                    <a href="./buildings/jarvis/results.tsv" target="_blank" class="jarvis-ar-framework-btn jarvis-ar-framework-btn-alt">View results.tsv →</a>
                </div>
                <p class="jarvis-ar-framework-note">To run autonomously: point Claude Code or Codex at program.md in this directory with full file access. The agent will run the loop overnight.</p>
            </div>

            <!-- Video Scorer -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">Video Success Predictor</h3>
                <p class="jarvis-ar-subtitle">Two models: pre-upload (before shooting) and full (with early signals).</p>

                <div class="jarvis-ar-stats-card">
                    <div class="jarvis-ar-stat">Training data: <strong>203 videos</strong></div>
                    <div class="jarvis-ar-stat">Pre-upload: R² = <strong>0.350</strong> (6 features, ±4.6x accuracy)</div>
                    <div class="jarvis-ar-stat">Full model: R² = <strong>0.664</strong> (12 features, ±2.5x accuracy)</div>
                    <div class="jarvis-ar-stat jarvis-ar-note">v20 clean models — circular outcome features removed</div>
                </div>

                <div class="jarvis-ar-scorer">
                    <h4 class="jarvis-ar-scorer-title">Pre-Upload Prediction</h4>
                    <p style="color:var(--j-muted);font-size:11px;margin:0 0 8px">What you can know before shooting (CV R²=0.350)</p>
                    <div class="jarvis-ar-inputs">
                        ${preUploadSignals.map(s => `
                            <div class="jarvis-ar-input-group">
                                <label title="${s.note}">${s.label}</label>
                                <input type="number" id="ar-input-${s.key}" value="${s.def}" placeholder="${s.placeholder}" step="any" />
                            </div>
                        `).join('')}
                    </div>

                    <h4 class="jarvis-ar-scorer-title" style="margin-top:12px">With Early Signals</h4>
                    <p style="color:var(--j-muted);font-size:11px;margin:0 0 8px">Additional inputs after upload (CV R²=0.664)</p>
                    <div class="jarvis-ar-inputs">
                        ${fullModelSignals.map(s => `
                            <div class="jarvis-ar-input-group">
                                <label title="${s.note}">${s.label}</label>
                                <input type="number" id="ar-input-${s.key}" value="${s.def}" placeholder="${s.placeholder}" step="any" />
                            </div>
                        `).join('')}
                    </div>
                    <button class="jarvis-ar-predict-btn" id="ar-predict-btn">Predict Views →</button>
                    <div id="ar-prediction-result" class="jarvis-ar-result"></div>
                </div>
            </div>

            <!-- Hypothesis Queue -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">Research Hypotheses</h3>
                <p class="jarvis-ar-subtitle">Experiments queued to increase model accuracy. Run each to unlock a new signal.</p>

                <div class="jarvis-ar-hypotheses">
                    ${(arHypotheses || []).map(h => `
                        <div class="jarvis-ar-hyp-card">
                            <div class="jarvis-ar-hyp-top">
                                <span class="jarvis-ar-hyp-id">${h.id}</span>
                                ${statusBadge(h.status)}
                                <span class="jarvis-ar-res-badge">${h.resolution}</span>
                            </div>
                            <div class="jarvis-ar-hyp-signal">${h.signal}</div>
                            <div class="jarvis-ar-hyp-text">${h.hypothesis}</div>
                            <div class="jarvis-ar-hyp-expected">Expected: ${h.expected_signal}</div>
                            <div class="jarvis-ar-hyp-method">Method: ${h.method}</div>
                            <button class="jarvis-ar-run-hyp-btn" data-hyp="${h.id}">Run Hypothesis →</button>
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- R² History -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">R² Improvement Over Time</h3>
                <div class="jarvis-ar-history">
                    ${[
                        { v: 'v1', r2: 0.147, desc: 'Baseline: keep + retention + LLM scores', tag: '' },
                        { v: 'v6', r2: 0.361, desc: 'Backward elim + retention curve signals', tag: '' },
                        { v: 'v9', r2: 0.405, desc: 'Concept categories (indestructible, superhero)', tag: '' },
                        { v: 'v13', r2: 0.506, desc: 'Channel momentum + concept interactions', tag: '' },
                        { v: 'v17', r2: 0.500, desc: 'Rebased n=203. Pacing + hook signals', tag: '' },
                        { v: 'v20', r2: 0.664, desc: 'Forward selection. Trajectory signals', tag: 'current' },
                        { v: 'v22', r2: 0.700, desc: 'n=210, deriv_std replaces entropy+slope', tag: '' },
                        { v: '—', r2: 0.80, desc: 'Target: higher-resolution signals', tag: 'target' },
                    ].map(h => `
                        <div class="jarvis-ar-history-row${h.tag === 'current' ? ' jarvis-ar-history-current' : ''}">
                            <div class="jarvis-ar-history-label">${h.v} ${h.tag ? '<span class="jarvis-ar-history-tag' + (h.tag === 'current' ? ' jarvis-ar-history-tag-current' : '') + '">' + h.tag + '</span>' : ''}</div>
                            <div class="jarvis-ar-history-bar-track">
                                <div class="jarvis-ar-history-bar${h.tag === 'current' ? ' jarvis-ar-history-bar-current' : h.tag === 'target' ? ' jarvis-ar-history-bar-pending' : ''}" style="width:${(h.r2 * 100).toFixed(1)}%"></div>
                            </div>
                            <div class="jarvis-ar-history-val">R²=${h.r2.toFixed(3)}</div>
                            <div class="jarvis-ar-history-desc">${h.desc}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    function runPrediction() {
        if (!arModel) return;
        const m = arModel;
        const inputs = {};
        // Read all inputs (both pre-upload and full model)
        const allFeatures = [...(m.pre_upload_model?.features || []), ...(m.full_model?.features || [])];
        const uniqueFeatures = [...new Set(allFeatures)];
        uniqueFeatures.forEach(f => {
            const el = container?.querySelector('#ar-input-' + f);
            inputs[f] = el ? parseFloat(el.value) : 0;
        });

        const resultEl = container?.querySelector('#ar-prediction-result');
        if (!resultEl) return;

        // Show both model results as informational summaries (no weights — models need retraining)
        const preModel = m.pre_upload_model;
        const fullModel = m.full_model;

        const preFeatureList = (preModel?.features || []).map(f => {
            const val = inputs[f];
            const desc = preModel.feature_descriptions?.[f] || f;
            return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span style="color:var(--j-muted)">${f}</span><strong>${isNaN(val) ? '—' : val}</strong></div>`;
        }).join('');

        const fullFeatureList = (fullModel?.features || []).map(f => {
            const val = inputs[f];
            return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span style="color:var(--j-muted)">${f}</span><strong>${isNaN(val) ? '—' : val}</strong></div>`;
        }).join('');

        resultEl.innerHTML = `
            <div class="jarvis-ar-result-card jarvis-ar-result-yellow" style="margin-bottom:8px">
                <div class="jarvis-ar-result-views">Pre-Upload Model</div>
                <div class="jarvis-ar-result-range">CV R² = ${preModel?.cv_r2_mean || '?'} · ±${preModel?.prediction_range_multiplier || '?'}x · ${preModel?.features?.length || '?'} features</div>
                <div style="margin-top:6px">${preFeatureList}</div>
                <div class="jarvis-ar-result-badge">Weights not stored — run regression to get prediction</div>
            </div>
            <div class="jarvis-ar-result-card jarvis-ar-result-green">
                <div class="jarvis-ar-result-views">Full Model (with early signals)</div>
                <div class="jarvis-ar-result-range">CV R² = ${fullModel?.cv_r2_mean || '?'} · ±${fullModel?.prediction_range_multiplier || '?'}x · ${fullModel?.features?.length || '?'} features</div>
                <div style="margin-top:6px">${fullFeatureList}</div>
                <div class="jarvis-ar-result-badge">Weights not stored — run regression to get prediction</div>
            </div>
        `;
    }

    async function runHypothesis(hypId) {
        if (hypId === 'h5') {
            const btn = container?.querySelector(`.jarvis-ar-run-hyp-btn[data-hyp="${hypId}"]`);
            if (btn) { btn.textContent = 'Running…'; btn.disabled = true; }
            try {
                const resp = await fetch('/api/jarvis/run-hypothesis', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: 'h5' })
                });
                const data = await resp.json();
                if (btn) {
                    btn.textContent = data.correlation !== undefined
                        ? `Done! r=${data.correlation.toFixed(3)} (n=${data.n})`
                        : (data.message || 'Complete');
                }
            } catch (e) {
                if (btn) { btn.textContent = 'Error — retry'; btn.disabled = false; }
            }
        } else {
            alert('This hypothesis requires LLM scoring — feature in progress');
        }
    }

    function bindAutoResearchEvents() {
        const predictBtn = container?.querySelector('#ar-predict-btn');
        if (predictBtn) predictBtn.addEventListener('click', runPrediction);

        container?.querySelectorAll('.jarvis-ar-run-hyp-btn').forEach(btn => {
            btn.addEventListener('click', () => runHypothesis(btn.dataset.hyp));
        });

        const summaryToggle = container?.querySelector('#jarvis-ar-summary-toggle');
        if (summaryToggle) {
            summaryToggle.addEventListener('click', () => {
                arSummaryOpen = !arSummaryOpen;
                const el = container?.querySelector('.jarvis-ar-root');
                if (el) {
                    el.innerHTML = renderAutoResearchContent();
                    bindAutoResearchEvents();
                    loadLoopStatus();
                }
            });
        }
    }

    // ══════════════════════════════════════════════════
    // TAB 5: RESOLUTION — kept exactly as-is
    // ══════════════════════════════════════════════════
    let resolutionRegistry = null;

    async function loadResolutionRegistry() {
        if (resolutionRegistry) return resolutionRegistry;
        try {
            const resp = await fetch('./buildings/jarvis/resolution-registry.json');
            resolutionRegistry = await resp.json();
            return resolutionRegistry;
        } catch (e) {
            console.error('Failed to load resolution registry:', e);
            return null;
        }
    }

    function renderResolution() {
        loadResolutionRegistry().then(registry => {
            const el = container?.querySelector('.jarvis-resolution-root');
            if (!el || !registry) return;
            el.innerHTML = renderResolutionContent(registry);
            bindResolutionEvents();
            setTimeout(() => {
                const cvs = container?.querySelector('#jarvis-res-coverage-canvas');
                if (cvs) { cvs.width = cvs.offsetWidth * 2; cvs.height = 440; drawResolutionMap(cvs, registry); }
            }, 100);
        });
        return `<div class="jarvis-resolution-root"><div class="jarvis-loading">Loading resolution registry...</div></div>`;
    }

    function drawResolutionMap(canvas, registry) {
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        const pad = { top: 20, right: 30, bottom: 36, left: 50 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;

        const statusColor = { active: '#10b981', partial: '#f59e0b', planned: '#4b5563', observed: '#06b6d4' };

        ctx.strokeStyle = 'rgba(100,120,180,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top);
        ctx.lineTo(pad.left, pad.top + plotH);
        ctx.lineTo(pad.left + plotW, pad.top + plotH);
        ctx.stroke();

        const levels = registry.map(r => r.level);
        const minL = Math.min(...levels), maxL = Math.max(...levels);
        const rangeL = maxL - minL || 1;
        ctx.font = '10px system-ui'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'center';
        for (let i = 0; i <= 5; i++) {
            const x = pad.left + (i / 5) * plotW;
            ctx.fillText('R' + i, x, pad.top + plotH + 14);
        }
        ctx.fillText('Resolution (coarse → fine)', pad.left + plotW / 2, pad.top + plotH + 30);

        ctx.textAlign = 'right';
        for (let d = 0; d <= 10; d += 2) {
            const y = pad.top + plotH - (d / 10) * plotH;
            ctx.fillText(d, pad.left - 8, y + 3);
        }
        ctx.save();
        ctx.translate(12, pad.top + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('Depth (signals measured)', 0, 0);
        ctx.restore();

        const targetY = pad.top + plotH - (4 / 10) * plotH;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(167,139,250,0.4)';
        ctx.beginPath();
        ctx.moveTo(pad.left, targetY);
        ctx.lineTo(pad.left + plotW, targetY);
        ctx.stroke();
        ctx.fillStyle = '#a78bfa'; ctx.textAlign = 'left'; ctx.font = '9px system-ui';
        ctx.fillText('Research target depth', pad.left + 4, targetY - 4);

        const focusX = pad.left + (3 / rangeL) * plotW;
        ctx.strokeStyle = 'rgba(6,182,212,0.4)';
        ctx.beginPath();
        ctx.moveTo(focusX, pad.top);
        ctx.lineTo(focusX, pad.top + plotH);
        ctx.stroke();
        ctx.fillStyle = '#06b6d4'; ctx.textAlign = 'center';
        ctx.fillText('Current focus', focusX, pad.top - 6);
        ctx.setLineDash([]);

        registry.forEach(r => {
            const ccx = pad.left + ((r.level - minL) / rangeL) * plotW;
            (r.gaps || []).forEach((_, gi) => {
                const gapDepth = Math.max(0, r.signals.length - 1 - gi * 0.5);
                const ccy = pad.top + plotH - (gapDepth / 10) * plotH;
                const offX = (Math.random() - 0.5) * 16;
                const offY = (Math.random() - 0.5) * 10 + 12;
                ctx.beginPath();
                ctx.arc(ccx + offX, ccy + offY, 3, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(248,113,113,0.35)';
                ctx.fill();
            });
        });

        registry.forEach(r => {
            const ccx = pad.left + ((r.level - minL) / rangeL) * plotW;
            const ccy = pad.top + plotH - (r.depth / 10) * plotH;
            const radius = Math.min(50, Math.max(20, 20 + (r.observationCount / 10)));
            const color = statusColor[r.status] || statusColor.planned;

            ctx.beginPath();
            ctx.arc(ccx, ccy, radius + 6, 0, Math.PI * 2);
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 1;

            ctx.beginPath();
            ctx.arc(ccx, ccy, radius, 0, Math.PI * 2);
            ctx.fillStyle = color + '33';
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#e2e8f0';
            ctx.font = 'bold 12px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('R' + r.level, ccx, ccy + 4);
        });
    }

    function renderResolutionContent(registry) {
        const maxDepth = 10;

        const gridCells = [];
        for (let d = maxDepth; d >= 0; d--) {
            const row = registry.map(r => {
                const filled = r.signals.length > d ? true : false;
                return { level: r.level, depth: d, filled, status: r.status };
            });
            gridCells.push({ depth: d, cells: row });
        }

        const loopStatusText = {
            0: `Running — ${registry.find(r=>r.level===0)?.signals.length||0} signals active, R²=0.147. Hypothesis queue: 6 experiments pending`,
            1: `Running — ${registry.find(r=>r.level===1)?.signals.length||0} signals active (Zeigarnik text, visual, type). Gap: body segment analysis`,
            3: `Partial — ${registry.find(r=>r.level===3)?.signals.length||0} signals scored (vz_score, z_score). Gaps: audio layer, first-frame visual`,
        };
        const defaultLoopStatus = (r) => `Planned — no signals scored yet. Priority: ${r.gaps[0] || 'TBD'} (R${r.level})`;

        const loopStepByStatus = { active: 3, partial: 2, planned: 0 };
        const loopSteps = ['Observe', 'Hypothesize', 'Score', 'Experiment', 'Update'];

        const loopLevels = registry.filter(r => r.status === 'active' || r.status === 'partial');

        return `
            <div class="jarvis-res-map-section">
                <h3 class="jarvis-res-title">Resolution Coverage Map</h3>
                <p class="jarvis-res-subtitle">The resolution framework defines the complete picture. Filled cells = signals measured. Empty cells = known gaps. The research loop targets empty cells at priority resolution levels.</p>
                <canvas id="jarvis-res-coverage-canvas" width="800" height="220" style="width:100%;height:220px;border-radius:8px;background:rgba(30,30,50,0.5);border:1px solid rgba(100,100,200,0.15);"></canvas>
            </div>

            <div class="jarvis-res-header">
                <h3 class="jarvis-res-title">Analysis Resolution Registry</h3>
                <p class="jarvis-res-subtitle">Tracking the depth and granularity of what we know. Each row unlocks higher precision &mdash; but resolution is only defined relative to what came before.</p>
            </div>

            <div class="jarvis-res-tree">
                ${registry.map((r, i) => {
                    const statusClass = r.status === 'active' ? 'active' : r.status === 'partial' ? 'partial' : r.status === 'observed' ? 'observed' : 'planned';
                    return `<div class="jarvis-res-card-wrapper">
                        <div class="jarvis-res-timeline">
                            <div class="jarvis-res-badge-level">R${r.level}</div>
                            ${i < registry.length - 1 ? '<div class="jarvis-res-timeline-line"></div>' : ''}
                        </div>
                        <div class="jarvis-res-card jarvis-res-${statusClass}">
                            <div class="jarvis-res-card-top">
                                <h4 class="jarvis-res-card-title">${r.name}</h4>
                                <span class="jarvis-res-status-badge jarvis-res-status-${statusClass}">${r.status}</span>
                            </div>
                            <div class="jarvis-res-unit">Unit of analysis: <strong>${r.unit}</strong></div>
                            <span class="jarvis-res-depth-badge">Depth ${r.depth}</span>
                            ${r.signals.length > 0 ? `<div class="jarvis-res-signals">${r.signals.map(s => `<span class="jarvis-res-signal-chip">${s}</span>`).join('')}</div>` : ''}
                            <div class="jarvis-res-finding"><em>${r.finding}</em></div>
                            ${r.gaps.length > 0 ? `<div class="jarvis-res-gaps-section">
                                <div class="jarvis-res-gaps-label">Known gaps at this resolution:</div>
                                <div class="jarvis-res-gaps">${r.gaps.map(g => `<span class="jarvis-res-gap-chip">${g}</span>`).join('')}</div>
                            </div>` : ''}
                            <div class="jarvis-res-obs">n=${r.observationCount} observations</div>
                        </div>
                    </div>`;
                }).join('')}
            </div>

            <div class="jarvis-res-grid-section">
                <h3 class="jarvis-res-grid-title">Depth &times; Resolution Grid</h3>
                <div class="jarvis-res-grid">
                    <div class="jarvis-res-grid-row jarvis-res-grid-header-row">
                        <div class="jarvis-res-grid-label"></div>
                        ${registry.map(r => `<div class="jarvis-res-grid-col-label">R${r.level}</div>`).join('')}
                    </div>
                    ${gridCells.map(row => `<div class="jarvis-res-grid-row">
                        <div class="jarvis-res-grid-label">${row.depth}</div>
                        ${row.cells.map(c => {
                            const filled = c.filled;
                            const cls = filled ? `jarvis-res-grid-cell-filled jarvis-res-grid-${c.status}` : 'jarvis-res-grid-cell-empty';
                            return `<div class="jarvis-res-grid-cell ${cls}"></div>`;
                        }).join('')}
                    </div>`).join('')}
                    <div class="jarvis-res-grid-row jarvis-res-grid-footer-row">
                        <div class="jarvis-res-grid-label"></div>
                        ${registry.map(r => `<div class="jarvis-res-grid-col-label">${r.name}</div>`).join('')}
                    </div>
                </div>
            </div>

            <div class="jarvis-res-loops-section">
                <h3 class="jarvis-res-title">Research Loops by Resolution Level</h3>
                <p class="jarvis-res-subtitle">Each resolution level has its own autonomous research loop. Multiple loops can run in parallel &mdash; each improves depth at its level independently.</p>
                <div class="jarvis-res-loops-grid">
                    ${loopLevels.map(r => {
                        const sc = r.status === 'active' ? 'active' : r.status === 'partial' ? 'partial' : 'planned';
                        const statusCol = { active: '#10b981', partial: '#f59e0b', planned: '#4b5563' }[sc];
                        const activeStep = loopStepByStatus[r.status] ?? 0;
                        const statusTxt = loopStatusText[r.level] || defaultLoopStatus(r);
                        return `<div class="jarvis-res-loop-card" style="border-left-color:${statusCol}">
                            <div class="jarvis-res-loop-header">
                                <span class="jarvis-res-badge-level" style="width:28px;height:28px;font-size:10px;">R${r.level}</span>
                                <span class="jarvis-res-loop-name">${r.name}</span>
                                <span class="jarvis-res-loop-dot" style="background:${statusCol}"></span>
                            </div>
                            <div class="jarvis-res-loop-metrics">
                                <span>Depth: <strong>${r.depth}</strong> signals</span>
                                <span>Gaps: <strong>${r.gaps.length}</strong> known</span>
                                <span>Observations: <strong>${r.observationCount}</strong></span>
                            </div>
                            <div class="jarvis-res-mini-loop">
                                ${loopSteps.map((s, si) => `<span class="jarvis-res-mini-step${si === activeStep ? ' jarvis-res-mini-step-active' : ''}">${s}</span>${si < loopSteps.length - 1 ? '<span class="jarvis-res-mini-arrow">→</span>' : ''}`).join('')}
                            </div>
                            <div class="jarvis-res-loop-status">${statusTxt}</div>
                        </div>`;
                    }).join('')}
                </div>
            </div>

            <div class="jarvis-classify-section">
                <h3 class="jarvis-classify-title">Auto-Classify Observation</h3>
                <p class="jarvis-classify-sub">Describe what you noticed and AI will place it in the resolution tree.</p>
                <div class="jarvis-classify-form">
                    <div class="jarvis-res-log-field">
                        <label>Describe your observation</label>
                        <textarea id="jarvis-classify-text" rows="3" placeholder="e.g. I noticed videos with a surprising visual in the first frame get significantly higher keep rates"></textarea>
                    </div>
                    <button class="jarvis-classify-btn" id="jarvis-classify-submit">Classify &rarr;</button>
                </div>
                <div id="jarvis-classify-result" class="jarvis-classify-result" style="display:none;"></div>
            </div>

            <div class="jarvis-res-log-section">
                <h3 class="jarvis-res-log-title">Log New Observation</h3>
                <div class="jarvis-res-log-form">
                    <div class="jarvis-res-log-field">
                        <label>What did you notice?</label>
                        <textarea id="jarvis-res-obs-text" rows="3" placeholder="Describe the observation..."></textarea>
                    </div>
                    <div class="jarvis-res-log-row">
                        <div class="jarvis-res-log-field">
                            <label>Resolution Level</label>
                            <select id="jarvis-res-obs-level">
                                ${buildResolutionOptions(registry)}
                            </select>
                        </div>
                        <div class="jarvis-res-log-field">
                            <label>Tags</label>
                            <input type="text" id="jarvis-res-obs-tags" placeholder="comma-separated signal tags" />
                        </div>
                        <button class="jarvis-res-log-btn" id="jarvis-res-submit">Submit</button>
                    </div>
                    <div id="jarvis-res-confirm" class="jarvis-res-confirm" style="display:none;"></div>
                </div>
            </div>
        `;
    }

    function buildResolutionOptions(registry) {
        const sorted = [...registry].sort((a, b) => a.level - b.level);
        const opts = [];
        for (let i = 0; i < sorted.length; i++) {
            const r = sorted[i];
            opts.push(`<option value="R${r.level}">R${r.level} - ${r.name}</option>`);
            if (i < sorted.length - 1) {
                const next = sorted[i + 1];
                opts.push(`<option value="between:${r.id}:${next.id}">Between R${r.level} and R${next.level}</option>`);
            }
        }
        const last = sorted[sorted.length - 1];
        opts.push(`<option value="new_finer">New resolution (finer than R${last.level})</option>`);
        return opts.join('');
    }

    function computeFractionalLevel(lowerLevel, upperLevel, registry) {
        const mid = (lowerLevel + upperLevel) / 2;
        const exists = registry.some(r => r.level === mid);
        if (!exists) return mid;
        return computeFractionalLevel(lowerLevel, mid, registry);
    }

    function insertFractionalLevel(lowerId, upperId, obsText, tags, registry) {
        const lower = registry.find(r => r.id === lowerId);
        const upper = registry.find(r => r.id === upperId);
        if (!lower || !upper) return null;

        const newLevel = computeFractionalLevel(lower.level, upper.level, registry);
        const newId = `r${newLevel}`;
        const today = new Date().toISOString().split('T')[0];
        const tagArr = tags.length > 0 ? tags : [obsText.slice(0, 40)];

        const entry = {
            id: newId,
            level: newLevel,
            name: tagArr.join(', '),
            unit: 'observation',
            description: obsText,
            parent: lowerId,
            depth: tagArr.length,
            signals: tagArr,
            finding: 'Newly logged observation — run through Jarvis pipeline.',
            gaps: [],
            status: 'observed',
            unlockedAt: today,
            observationCount: 1
        };

        registry.push(entry);
        registry.sort((a, b) => a.level - b.level);
        return entry;
    }

    function reRenderResolution() {
        const el = container?.querySelector('.jarvis-resolution-root');
        if (!el || !resolutionRegistry) return;
        el.innerHTML = renderResolutionContent(resolutionRegistry);
        bindResolutionEvents();
        setTimeout(() => {
            const cvs = container?.querySelector('#jarvis-res-coverage-canvas');
            if (cvs) { cvs.width = cvs.offsetWidth * 2; cvs.height = 440; drawResolutionMap(cvs, resolutionRegistry); }
        }, 100);
    }

    function bindResolutionEvents() {
        const submitBtn = container?.querySelector('#jarvis-res-submit');
        if (submitBtn) {
            submitBtn.addEventListener('click', () => {
                const text = document.getElementById('jarvis-res-obs-text')?.value || '';
                const levelVal = document.getElementById('jarvis-res-obs-level')?.value || '';
                const tagsRaw = document.getElementById('jarvis-res-obs-tags')?.value || '';
                const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
                const confirmEl = document.getElementById('jarvis-res-confirm');

                if (levelVal.startsWith('between:')) {
                    const parts = levelVal.split(':');
                    const entry = insertFractionalLevel(parts[1], parts[2], text, tags, resolutionRegistry);
                    if (entry && confirmEl) {
                        confirmEl.style.display = 'block';
                        confirmEl.textContent = `Created R${entry.level} — "${entry.name}". Re-rendering tree...`;
                        setTimeout(() => reRenderResolution(), 600);
                    }
                } else {
                    console.log('Jarvis Observation:', { text, level: levelVal, tags });
                    if (confirmEl) {
                        confirmEl.style.display = 'block';
                        confirmEl.textContent = 'Observation logged. Run through Jarvis pipeline to extract experiments.';
                    }
                }
            });
        }

        const classifyBtn = container?.querySelector('#jarvis-classify-submit');
        if (classifyBtn) {
            classifyBtn.addEventListener('click', async () => {
                const text = document.getElementById('jarvis-classify-text')?.value || '';
                const resultDiv = document.getElementById('jarvis-classify-result');
                if (!text.trim() || !resultDiv) return;

                resultDiv.style.display = 'block';
                resultDiv.innerHTML = '<div class="jarvis-loading">Classifying observation...</div>';

                try {
                    const resp = await fetch('/api/jarvis/classify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ observation: text, registry: resolutionRegistry })
                    });
                    const data = await resp.json();
                    if (data.error) throw new Error(data.error);

                    const matched = resolutionRegistry.find(r => r.id === data.matchedLevel);
                    const matchLabel = matched ? `R${matched.level} - ${matched.name}` : data.matchedLevel;
                    const betweenHtml = data.isBetween
                        ? `<div class="jarvis-classify-between">Between <strong>${data.betweenLower}</strong> and <strong>${data.betweenUpper}</strong></div>`
                        : '';
                    const signalChips = (data.signals || []).map(s => `<span class="jarvis-res-signal-chip">${s}</span>`).join('');

                    resultDiv.innerHTML = `
                        <div class="jarvis-classify-match">
                            <span class="jarvis-classify-match-label">Matched:</span>
                            <strong>${matchLabel}</strong>
                        </div>
                        ${betweenHtml}
                        <div class="jarvis-classify-reasoning">${data.reasoning || ''}</div>
                        ${signalChips ? `<div class="jarvis-res-signals" style="margin-top:8px">${signalChips}</div>` : ''}
                        <div class="jarvis-classify-actions">
                            <button class="jarvis-res-log-btn jarvis-classify-log" data-level="${data.matchedLevel}">Log at this level</button>
                            ${data.isBetween ? `<button class="jarvis-res-log-btn jarvis-classify-fractional" data-lower="${data.betweenLower}" data-upper="${data.betweenUpper}">Create fractional level</button>` : ''}
                        </div>
                    `;

                    const logBtn = resultDiv.querySelector('.jarvis-classify-log');
                    if (logBtn) {
                        logBtn.addEventListener('click', () => {
                            console.log('Jarvis Classified Observation:', { text, level: data.matchedLevel, signals: data.signals });
                            resultDiv.innerHTML = '<div class="jarvis-res-confirm">Observation logged at ' + matchLabel + '.</div>';
                        });
                    }
                    const fracBtn = resultDiv.querySelector('.jarvis-classify-fractional');
                    if (fracBtn) {
                        fracBtn.addEventListener('click', () => {
                            const entry = insertFractionalLevel(data.betweenLower, data.betweenUpper, text, data.signals || [], resolutionRegistry);
                            if (entry) {
                                resultDiv.innerHTML = `<div class="jarvis-res-confirm">Created R${entry.level} — "${entry.name}". Re-rendering...</div>`;
                                setTimeout(() => reRenderResolution(), 600);
                            }
                        });
                    }
                } catch (e) {
                    resultDiv.innerHTML = `<div class="jarvis-error">Classification failed: ${e.message}</div>`;
                }
            });
        }
    }

    // ══════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════
    function bindEvents() {
        if (!container) return;

        // Tab switching
        container.querySelectorAll('.jarvis-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                render();
            });
        });

        // Analytical: tool execute
        container.querySelectorAll('.jarvis-tool-execute').forEach(btn => {
            btn.addEventListener('click', () => executeTool(btn.dataset.tool));
        });
    }

    // ── Public API ──
    function open(bodyEl) {
        container = bodyEl;
        activeTab = 'analytical';
        dataset = null;
        activeToolId = null;
        toolResults = {};
        chooserKey = null;
        cachedResultsRows = null;
        tacticalDiscoveredNodes = [];
        tacticalFilter = 'all';
        tacticalSearch = '';
        tacticalExpandedSignal = null;
        expSort = 'newest';
        expExplainOpen = false;
        arModel = null;
        arHypotheses = null;
        arSummaryOpen = true;
        render();
    }

    function close() {
        container = null;
    }

    return { open, close };
})();

BuildingRegistry.register('Jarvis', {
    open: function(bodyEl, opts) { JarvisUI.open(bodyEl, opts); },
    close: function() { JarvisUI.close(); }
});
