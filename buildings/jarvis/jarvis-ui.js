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
    // ── Analytical Brain: active selections ──
    let analyticalSelectedTool = null;   // tool id from v2Tools
    let analyticalSelectedExpId = null;  // experiment instance id
    let experimentsSelectedExpId = null; // experiment id for Experiments tab

    function renderAnalytical() {
        // Load v2 tools if not loaded yet
        if (!v2Tools) loadV2Data().then(() => {
            const panel = container?.querySelector('#jarvis-analytical-content');
            if (panel) panel.innerHTML = renderAnalyticalContent();
            bindAnalyticalEvents();
        });
        setTimeout(bindAnalyticalEvents, 50);
        return `<div id="jarvis-analytical-content">${renderAnalyticalContent()}</div>`;
    }

    function renderAnalyticalContent() {
        const tools = v2Tools || [];
        const experiments = v2Indicators || []; // each indicator has one experiment instance

        const toolColors = {
            pearson_r: '#3b82f6',
            spearman_rho: '#06b6d4',
            partial_correlation: '#a78bfa',
            ols_r2_delta: '#10b981',
        };
        const toolIcons = {
            pearson_r: '\uD83D\uDCCF',
            spearman_rho: '\uD83D\uDCC8',
            partial_correlation: '\uD83E\uDDF9',
            ols_r2_delta: '\uD83D\uDCC9',
        };

        // Tool cards
        const toolCards = tools.map(tool => {
            const color = toolColors[tool.id] || '#64748b';
            const icon = toolIcons[tool.id] || '⚙️';
            const isSelected = analyticalSelectedTool === tool.id;
            // Count how many experiments used this tool
            const usageCount = experiments.filter(i => i.experiment && i.experiment.tool_id === tool.id).length;
            return `<div class="jarvis-tool-card${isSelected ? ' selected' : ''}" data-tool-id="${tool.id}" style="border-left:3px solid ${color}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                    <div style="font-size:14px;font-weight:700;color:#f1f5f9">${icon} ${tool.name}</div>
                    <span style="font-size:10px;color:#64748b;background:#1e293b;padding:2px 6px;border-radius:8px">${usageCount} experiments</span>
                </div>
                <div style="font-size:12px;color:#94a3b8;margin:4px 0 6px">${tool.description}</div>
                <div style="font-size:10px;color:#64748b">v${tool.version || '1.0'} &middot; ${tool.analytical_brain_tab || 'correlation'} tab</div>
            </div>`;
        }).join('');

        // Selected tool detail panel
        let toolDetail = '';
        if (analyticalSelectedTool) {
            const tool = tools.find(t => t.id === analyticalSelectedTool);
            if (tool) toolDetail = renderToolDefinitionCard(tool, toolColors[tool.id] || '#64748b');
        }

        return `
            <div style="margin-bottom:12px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px">Experiment Tools &mdash; click to inspect</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="jarvis-tool-cards">
                    ${toolCards}
                </div>
            </div>
            ${toolDetail}
        `;
    }

    function renderToolDefinitionCard(tool, color) {
        const sectionHdr = text => `<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px;margin-top:12px">${text}</div>`;
        const paramRows = Object.entries(tool.parameters || {}).map(([k, v]) => {
            const desc = typeof v === 'object' ? v.description || '' : '';
            const type = typeof v === 'object' ? v.type || '' : typeof v;
            const def = typeof v === 'object' && v.default != null ? ` (default: ${v.default})` : '';
            return `<tr><td style="font-family:monospace;font-size:11px;color:#22d3ee;padding:3px 8px 3px 0">${k}</td><td style="font-size:11px;color:#94a3b8">${type}${def}</td><td style="font-size:11px;color:#64748b;padding-left:8px">${desc}</td></tr>`;
        }).join('');
        const outputRows = Object.entries(tool.outputs || {}).map(([k, v]) =>
            `<tr><td style="font-family:monospace;font-size:11px;color:#a78bfa;padding:3px 8px 3px 0">${k}</td><td style="font-size:11px;color:#94a3b8">${v}</td></tr>`
        ).join('');

        return `
            <div style="background:#0a1628;border-left:3px solid ${color};border-radius:0 8px 8px 0;padding:14px;margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                    <div style="font-size:15px;font-weight:700;color:#f1f5f9">${tool.name}</div>
                    <button onclick="JarvisUI.closeAnalyticalPanel()" style="background:none;border:none;color:#64748b;font-size:16px;cursor:pointer">×</button>
                </div>
                <div style="font-size:12px;color:#94a3b8;line-height:1.6;margin-bottom:8px">${tool.description}</div>

                ${sectionHdr('When to Use')}
                <div style="font-size:12px;color:#cbd5e1;line-height:1.6">${tool.when_to_use || '—'}</div>

                ${sectionHdr('Formula')}
                <div style="background:#0f172a;border-radius:6px;padding:10px;font-size:12px;font-family:monospace;color:#22d3ee;line-height:1.6">${tool.formula || '—'}</div>

                ${sectionHdr('Parameters')}
                <table style="width:100%;border-collapse:collapse">${paramRows || '<tr><td style="color:#64748b;font-size:11px">None</td></tr>'}</table>

                ${sectionHdr('Outputs')}
                <table style="width:100%;border-collapse:collapse">${outputRows || '<tr><td style="color:#64748b;font-size:11px">None</td></tr>'}</table>

                ${sectionHdr('Interpretation Guide')}
                <div style="font-size:12px;color:#94a3b8;line-height:1.6">${tool.interpretation || '—'}</div>
            </div>`;
    }

    function renderExperimentInstanceCard(ind) {
        const exp = ind.experiment;
        const result = ind.result;
        const tool = v2Tools ? v2Tools.find(t => t.id === exp.tool_id) : null;
        const dataset = ind.dataset || [];
        const metricDef = ind.metric_definition || {};
        const color = ind.layer === 'pre' ? '#06b6d4' : '#a78bfa';

        const sectionHdr = text => `<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px;margin-top:12px">${text}</div>`;

        // Stats
        const r = result ? result.primary_r : null;
        const rho = result ? result.rho : null;
        const p = exp.outputs ? exp.outputs.p_value : null;
        const ciLow = exp.outputs ? exp.outputs.ci_low : null;
        const ciHigh = exp.outputs ? exp.outputs.ci_high : null;
        const rStr = r != null ? `<span style="font-weight:700;color:${r >= 0 ? '#22d3ee' : '#f87171'}">${r >= 0 ? '+' : ''}${r.toFixed(3)}</span>` : '—';

        // Data points table (show first 20, with toggle hint)
        const dataRows = dataset.slice(0, 20).map((d, i) =>
            `<tr style="background:${i % 2 === 0 ? '#0a1020' : '#0d1525'}">
                <td style="padding:3px 8px;font-family:monospace;font-size:10px;color:#64748b">${d.ytId}</td>
                <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#cbd5e1;text-align:right">${typeof d.value === 'number' ? d.value.toFixed(4) : d.value}</td>
                <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#94a3b8;text-align:right">${typeof d.target_value === 'number' ? d.target_value.toFixed(4) : d.target_value}</td>
            </tr>`
        ).join('');

        return `
            <div style="background:#0a1628;border-left:3px solid ${color};border-radius:0 8px 8px 0;padding:14px;margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                    <div>
                        <div style="font-size:15px;font-weight:700;color:#f1f5f9">${ind.label || ind.key}</div>
                        <code style="font-size:10px;color:#475569">${exp.id}</code>
                    </div>
                    <button onclick="JarvisUI.closeAnalyticalPanel()" style="background:none;border:none;color:#64748b;font-size:16px;cursor:pointer">×</button>
                </div>

                ${sectionHdr('Instance: Method Applied to Indicator')}
                <div style="font-size:12px;color:#94a3b8;margin-bottom:8px">
                    Tool: <strong style="color:#cbd5e1">${tool ? tool.name : exp.tool_id}</strong> &mdash;
                    Indicator: <code style="color:${color}">${ind.key}</code> →
                    Target: <code style="color:#f59e0b">${exp.parameters ? exp.parameters.target : 'views'}</code>
                    (transform: <code>${exp.parameters ? exp.parameters.transform_target : 'log10'}</code>)
                </div>

                ${sectionHdr('What Was Measured')}
                <div style="background:#0f172a;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8;margin-bottom:4px">
                    <div><span style="color:#64748b">Description: </span>${metricDef.description || '—'}</div>
                    <div style="margin-top:3px"><span style="color:#64748b">Formula: </span><code style="color:#22d3ee">${metricDef.formula || '—'}</code></div>
                    <div style="margin-top:3px"><span style="color:#64748b">Extracted from: </span>${(metricDef.data_sources || []).join(', ')}</div>
                    <div style="margin-top:3px"><span style="color:#64748b">Resolution: </span>${ind.resolution_id || 'r0'}</div>
                </div>

                ${sectionHdr('Results')}
                <div style="display:flex;gap:14px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #1e293b;margin-bottom:8px">
                    <div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">Pearson r</span><span style="font-size:13px">${rStr}</span></div>
                    ${rho != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">Spearman ρ</span><span style="font-size:13px;color:${rho >= 0 ? '#22d3ee' : '#f87171'}">${rho >= 0 ? '+' : ''}${rho.toFixed(3)}</span></div>` : ''}
                    ${p != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">p-value</span><span style="font-size:13px;color:${p < 0.05 ? '#22d3ee' : '#f87171'}">${p.toFixed(4)}</span></div>` : ''}
                    ${ciLow != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">95% CI</span><span style="font-size:12px;color:#94a3b8">[${ciLow >= 0 ? '+' : ''}${ciLow.toFixed(3)}, ${ciHigh >= 0 ? '+' : ''}${ciHigh.toFixed(3)}]</span></div>` : ''}
                    <div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">n videos</span><span style="font-size:13px;color:#cbd5e1">${exp.n_videos}</span></div>
                </div>

                ${result && result.conclusion ? `
                <div style="background:#0f2942;border-left:3px solid #22d3ee;padding:10px;border-radius:0 6px 6px 0;font-size:12px;color:#e2e8f0;line-height:1.6;margin-bottom:8px">${result.conclusion}</div>
                ${result.practical_insight ? `<div style="background:#0a1f0a;border-left:3px solid #22c55e;padding:8px;border-radius:0 6px 6px 0;font-size:11px;color:#86efac;line-height:1.5">💡 ${result.practical_insight}</div>` : ''}
                ` : ''}

                ${sectionHdr(`Data Points (${dataset.length} videos)`)}
                <div style="max-height:300px;overflow-y:auto;border-radius:6px;border:1px solid #1e293b">
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="background:#1e293b;position:sticky;top:0">
                            <th style="padding:4px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Video ID</th>
                            <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">${ind.key}</th>
                            <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">log10(views)</th>
                        </tr></thead>
                        <tbody>${dataRows}</tbody>
                    </table>
                    ${dataset.length > 20 ? `<div style="padding:6px 8px;font-size:10px;color:#475569;text-align:center">… ${dataset.length - 20} more rows</div>` : ''}
                </div>
            </div>`;
    }

    function bindAnalyticalEvents() {
        container?.querySelectorAll('[data-tool-id]').forEach(card => {
            card.addEventListener('click', () => {
                const tid = card.dataset.toolId;
                analyticalSelectedTool = analyticalSelectedTool === tid ? null : tid;
                analyticalSelectedExpId = null;
                const p = container?.querySelector('#jarvis-analytical-content');
                if (p) p.innerHTML = renderAnalyticalContent();
                bindAnalyticalEvents();
            });
        });
    }

    // Global functions accessible from inline onclick handlers
    function openExperimentInstance(expId) {
        activeTab = 'experiments';
        experimentsSelectedExpId = expId;
        analyticalSelectedTool = null;
        analyticalSelectedExpId = null;
        render();
    }

    function closeAnalyticalPanel() {
        analyticalSelectedTool = null;
        analyticalSelectedExpId = null;
        const p = container?.querySelector('#jarvis-analytical-content');
        if (p) { p.innerHTML = renderAnalyticalContent(); bindAnalyticalEvents(); }
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
    let cachedIndicatorRegistry = null; // legacy, kept for compat
    let currentMergeThreshold = 0;
    let graphFilter = 'all';
    let graphSizeBy = 'r2';
    let selectedNodeKey = null;
    let nodeClickCount = {};

    // ── v2 data cache ──
    let v2Indicators = null;   // array from /api/jarvis/v2/indicators
    let v2Graph = null;        // {nodes, edges} from /api/jarvis/v2/graph
    let v2Tools = null;        // array from /api/jarvis/v2/tools
    let v2Resolutions = null;  // array from /api/jarvis/v2/resolutions

    async function loadV2Data() {
        try {
            const [iRes, gRes, tRes, rRes] = await Promise.all([
                fetch('/api/jarvis/v2/indicators'),
                fetch('/api/jarvis/v2/graph'),
                fetch('/api/jarvis/v2/tools'),
                fetch('/api/jarvis/v2/resolutions'),
            ]);
            v2Indicators = await iRes.json();
            v2Graph = await gRes.json();
            v2Tools = await tRes.json();
            v2Resolutions = await rRes.json();
            return true;
        } catch (e) {
            console.error('Jarvis v2 load failed:', e);
            return false;
        }
    }

    function isSignalKept(key) {
        if (!v2Indicators) return false;
        const ind = v2Indicators.find(i => i.key === key);
        return ind ? ind.status === 'keep' : false;
    }

    async function loadIndicatorRegistry() {
        // Legacy shim — load v2 data instead
        return loadV2Data();
    }

    function renderTactical() {
        loadV2Data().then(() => {
            setTimeout(() => {
                buildD3TacticalGraph();
                const list = container?.querySelector('#jarvis-signal-list');
                if (list) list.innerHTML = renderSignalList();
                bindTacticalEvents();
            }, 50);
        });
        const gfBtn = (val, label) => `<button data-gfilter="${val}" class="jarvis-graph-btn${graphFilter === val ? ' active' : ''}">${label}</button>`;
        const gsBtn = (val, label) => `<button data-sizeby="${val}" class="jarvis-graph-btn${graphSizeBy === val ? ' active' : ''}">${label}</button>`;
        return `
            <div class="jarvis-network-legend" style="margin-bottom:4px">
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#06b6d4"></span>Pre-upload (you control before filming)</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#a78bfa"></span>Post-upload (measured by YouTube)</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#f59e0b"></span>Views (target)</span>
                <span class="jarvis-legend-item"><span style="font-family:'SF Mono',monospace;font-size:10px;color:#22d3ee">r=+0.47</span> = positive &nbsp; <span style="font-family:'SF Mono',monospace;font-size:10px;color:#f87171">r=-0.40</span> = negative</span>
            </div>
            <div class="jarvis-graph-controls" id="jarvis-graph-controls">
                <div class="jarvis-graph-filters">
                    <span class="jarvis-graph-ctrl-label">Show:</span>
                    ${gfBtn('all','All')}${gfBtn('pre-upload','Pre-upload')}${gfBtn('post-upload','Post-upload')}
                </div>
                <div class="jarvis-graph-sizeBy">
                    <span class="jarvis-graph-ctrl-label">Size by:</span>
                    ${gsBtn('r2','R²')}${gsBtn('connections','Connections')}${gsBtn('depth','Depth')}
                </div>
            </div>
            <div class="jarvis-tactical-network" style="margin-bottom:12px;position:relative">
                <div id="jarvis-d3-graph" style="width:100%;height:520px;overflow:hidden"></div>
                <div id="jarvis-network-tooltip" class="jarvis-network-tooltip" style="display:none;"></div>
            </div>
            <div id="jarvis-node-label" style="display:none;position:fixed;background:#1e293b;color:#e2e8f0;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600;pointer-events:none;z-index:10000;border:1px solid #334155;"></div>
            <div id="jarvis-node-popup" style="display:none;position:fixed;background:#0f172a;color:#cbd5e1;padding:16px 18px;border-radius:10px;font-size:12px;z-index:10001;border:1px solid #1e293b;max-width:440px;max-height:75vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);"></div>
            <div style="display:flex;align-items:center;gap:10px;padding:4px 0 10px;font-size:11px;color:var(--j-muted)">
                <label for="jarvis-merge-slider">Merge threshold:</label>
                <input type="range" id="jarvis-merge-slider" min="0" max="100" value="${currentMergeThreshold}" style="width:140px" />
                <span id="jarvis-merge-value">${currentMergeThreshold}</span>
            </div>
            <div class="jarvis-signal-list-section">
                <input type="text" class="jarvis-signal-search" id="jarvis-signal-search" placeholder="Search signals..." value="${tacticalSearch}" />
                <div class="jarvis-signal-filters" id="jarvis-signal-filters">
                    ${['all','pre-upload','post-upload','kept','in-model'].map(f =>
                        `<button class="jarvis-signal-filter-btn${tacticalFilter === f ? ' active' : ''}" data-filter="${f}">${f === 'all' ? 'All' : f === 'in-model' ? 'In Model' : f === 'kept' ? 'Kept' : f === 'pre-upload' ? 'Pre-upload' : 'Post-upload'}</button>`
                    ).join('')}
                </div>
                <div style="font-size:10px;color:#64748b;padding:2px 0 6px;cursor:help" title="Strength = how strongly this indicator predicts the outcome. Range: 0 to 1. Higher = stronger prediction.">\u2139\ufe0f Strength = prediction power (hover for info)</div>
                <div class="jarvis-signal-list" id="jarvis-signal-list">
                    ${renderSignalList()}
                </div>
            </div>`;
    }

    // Pre-upload pattern matching (case-insensitive)
    const PRE_UPLOAD_PATTERNS = /word|language|script|text|title|concept|idea|hook|novelty|cognitive|zeigarnik|vz_|z_score|z_type|pat_|category|indestructible|making|face|visual_surprise|cut_|pivot|connector|action_word|bigram|starts_with_i|thumbnail|content_type|hook_clarity|text_overlay|net_novelty|idea_length|superhero|challenge|narrative_arc|has_callback|three_channel|action_intensity|phrase|total_word|speech_rate|duration_sweet|pacing/i;

    function classifySignalLayer(key) {
        if (key === 'views' || key === 'log_views') return 'views';
        if (PRE_UPLOAD_PATTERNS.test(key)) return 'pre';
        return 'post';
    }

    function getDiscoveredSignals() {
        if (!cachedResultsRows) return [];
        const byKey = {};
        cachedResultsRows
            .filter(r => (r.experiment_id || '').startsWith('loop_b'))
            .forEach(r => {
                const signalKey = (r.new_signal || '').replace(/^discovery:/, '').trim();
                if (!signalKey) return;
                const notes = r.notes || '';
                // Keep the one with longest notes for dedup
                if (!byKey[signalKey] || notes.length > (byKey[signalKey].notes || '').length) {
                    let rPartial = null;
                    const rpM = notes.match(/r_partial\s*=\s*([-+]?\d*\.?\d+)/i);
                    if (rpM) rPartial = parseFloat(rpM[1]);
                    else {
                        const rM = notes.match(/\br\s*=\s*([-+]?\d*\.?\d+)/i);
                        if (rM) rPartial = parseFloat(rM[1]);
                    }
                    const layer = classifySignalLayer(signalKey);
                    byKey[signalKey] = {
                        key: signalKey,
                        label: signalKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                        notes: notes,
                        r_partial: rPartial,
                        layer: layer,
                    };
                }
            });
        return Object.values(byKey);
    }

    function getSignalUploadPhase(ind) {
        const layer = classifySignalLayer(ind.key);
        if (layer === 'pre') return 'pre-upload';
        if (layer === 'post') return 'post-upload';
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
        if (ind.category === 'planned') return 'analytics';
        if (ind.source && ind.source.startsWith('Derived')) return 'derived';
        if (ind.source && (ind.source.startsWith('YouTube') || ind.source.includes('YouTube'))) return 'analytics';
        return 'llm-scored';
    }

    function isSignalInModel(key) {
        if (!arModel) return false;
        const preFeats = arModel.pre_upload_model?.features || [];
        const fullFeats = arModel.full_model?.features || [];
        return preFeats.includes(key) || fullFeats.includes(key);
    }

    function getRegistrySignals() {
        if (!v2Indicators || !v2Indicators.length) return [];
        // Normalize v2 schema to what the UI expects
        return v2Indicators.map(ind => ({
            ...ind,
            // UI compatibility shims
            r_partial: ind.result ? ind.result.primary_r : null,
            resolution: ind.resolution_id || 'r0',
            notes: ind.result ? ind.result.conclusion : (ind.metric_definition ? ind.metric_definition.description : ''),
        }));
    }

    function humanizeKey(key) {
        return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    function renderSignalList() {
        const signals = getRegistrySignals();
        const search = tacticalSearch.toLowerCase();

        const filtered = signals.filter(sig => {
            if (tacticalFilter === 'pre-upload' && sig.layer !== 'pre') return false;
            if (tacticalFilter === 'post-upload' && sig.layer !== 'post') return false;
            if (tacticalFilter === 'in-model' && !isSignalInModel(sig.key)) return false;
            if (tacticalFilter === 'kept' && !isSignalKept(sig.key)) return false;
            if (search && !(sig.label || '').toLowerCase().includes(search) && !sig.key.toLowerCase().includes(search)) return false;
            return true;
        });

        if (!filtered.length) return '<div style="color:var(--j-muted);padding:12px;font-size:12px;">No signals match your search.</div>';

        // Sort by |r_partial| descending, limit 200
        filtered.sort((a, b) => Math.abs(b.r_partial || 0) - Math.abs(a.r_partial || 0));
        const capped = filtered.slice(0, 200);

        // Apply merge threshold
        const merged = applyMergeThreshold(capped, currentMergeThreshold);

        return merged.map(sig => {
            const color = sig.layer === 'pre' ? '#06b6d4' : '#a78bfa';
            const layerLabel = sig.layer === 'pre' ? 'PRE' : 'POST';
            const layerBg = sig.layer === 'pre' ? 'rgba(6,182,212,0.15)' : 'rgba(167,139,250,0.15)';
            const resBg = { R0: 'rgba(100,116,139,0.15)', R1: 'rgba(59,130,246,0.15)', R2: 'rgba(168,85,247,0.15)', R3: 'rgba(236,72,153,0.15)' };
            const resColor = { R0: '#64748b', R1: '#3b82f6', R2: '#a855f7', R3: '#ec4899' };
            const isExpanded = tacticalExpandedSignal === sig.key;
            const label = sig.label || humanizeKey(sig.key);
            const rVal = sig.r_partial;
            const rSign = rVal != null ? (rVal >= 0 ? '+' : '') : '';
            const rDisplay = rVal != null ? `${rSign}${rVal.toFixed(3)}` : '';
            const rColor = rVal != null ? (rVal >= 0 ? '#22d3ee' : '#f87171') : 'var(--j-muted)';
            const rBar = rVal != null ? `<div class="jarvis-signal-rbar"><div class="jarvis-signal-rbar-fill" style="width:${Math.min(Math.abs(rVal) * 100, 100)}%;background:${color}"></div></div>` : '';
            const clusterBadge = sig._clusterCount > 1 ? `<span style="font-size:9px;background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:8px;color:var(--j-muted)">+${sig._clusterCount - 1}</span>` : '';

            return `<div class="jarvis-signal-row-wrapper">
                <div class="jarvis-signal-row${isExpanded ? ' expanded' : ''}" data-signal-key="${sig.key}">
                    <span class="jarvis-signal-dot" style="background:${color}"></span>
                    <span class="jarvis-signal-name">${label}</span>
                    <span class="jarvis-signal-type-badge" style="background:${layerBg};color:${color}">${layerLabel}</span>
                    ${clusterBadge}
                    ${rDisplay ? `<span style="font-family:'SF Mono',monospace;font-size:10px;color:${rColor};white-space:nowrap">r=${rDisplay}</span>` : ''}
                    ${rBar}
                </div>
                ${isExpanded ? renderSignalDetail(sig) : ''}
            </div>`;
        }).join('');
    }

    function applyMergeThreshold(signals, threshold) {
        if (threshold <= 0) return signals.map(s => ({ ...s, _clusterCount: 1 }));
        const thresh = threshold / 100;
        const used = new Set();
        const result = [];
        for (let i = 0; i < signals.length; i++) {
            if (used.has(i)) continue;
            const cluster = [i];
            const tokensA = signals[i].key.split('_');
            for (let j = i + 1; j < signals.length; j++) {
                if (used.has(j)) continue;
                const tokensB = signals[j].key.split('_');
                const shared = tokensA.filter(t => tokensB.includes(t)).length;
                const overlap = shared / Math.max(tokensA.length, tokensB.length);
                if (overlap >= thresh) { cluster.push(j); used.add(j); }
            }
            used.add(i);
            const rep = { ...signals[i], _clusterCount: cluster.length };
            if (cluster.length > 1) {
                // Find most common token for label
                const allTokens = cluster.flatMap(ci => signals[ci].key.split('_'));
                const freq = {};
                allTokens.forEach(t => freq[t] = (freq[t] || 0) + 1);
                const topToken = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
                rep.label = topToken.charAt(0).toUpperCase() + topToken.slice(1) + ' cluster';
            }
            result.push(rep);
        }
        return result;
    }

    function renderSignalDetail(sig) {
        const color = sig.layer === 'pre' ? '#06b6d4' : '#a78bfa';
        const layerLabel = sig.layer === 'pre' ? 'Pre-upload' : 'Post-upload';
        // v2 full data
        const ind = v2Indicators ? v2Indicators.find(i => i.key === sig.key) : null;
        const metricDef = ind ? ind.metric_definition : null;
        const exp = ind ? ind.experiment : null;
        const result = ind ? ind.result : null;
        const dataset = ind ? ind.dataset : null;
        const tool = (v2Tools && exp) ? v2Tools.find(t => t.id === exp.tool_id) : null;
        const resObj = (v2Resolutions && ind) ? v2Resolutions.find(r => r.id === ind.resolution_id) : null;
        const connTargets = (ind && ind.connections) ? ind.connections : [];

        const statPill = (label, val, valColor) => `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">${label}</span><span style="font-size:12px;color:${valColor || '#cbd5e1'}">${val}</span></div>`;

        // r value with sign and color
        const rVal = result ? result.primary_r : null;
        const rhoVal = result ? result.rho : null;
        const rStr = rVal != null ? `<span style="font-weight:700;color:${rVal >= 0 ? '#22d3ee' : '#f87171'}">${rVal >= 0 ? '+' : ''}${rVal.toFixed(3)}</span>` : '—';
        const rhoStr = rhoVal != null ? `<span style="color:${rhoVal >= 0 ? '#22d3ee' : '#f87171'}">${rhoVal >= 0 ? '+' : ''}${rhoVal.toFixed(3)}</span>` : '—';
        const pStr = (exp && exp.outputs && exp.outputs.p_value != null) ? exp.outputs.p_value.toFixed(4) : '—';
        const ciStr = (exp && exp.outputs && exp.outputs.ci_low != null) ? `[${exp.outputs.ci_low >= 0 ? '+' : ''}${exp.outputs.ci_low.toFixed(3)}, ${exp.outputs.ci_high >= 0 ? '+' : ''}${exp.outputs.ci_high.toFixed(3)}]` : '';

        return `<div class="jarvis-signal-detail" style="border-left: 3px solid ${color}">
            <div class="jarvis-signal-detail-name">${sig.label || sig.key}</div>

            <!-- Stats row -->
            <div style="display:flex;gap:14px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #1e293b;margin-bottom:10px">
                ${statPill('Pearson r', rStr)}
                ${rhoVal != null ? statPill('Spearman ρ', rhoStr) : ''}
                ${pStr !== '—' ? statPill('p-value', `<span style="color:${parseFloat(pStr) < 0.05 ? '#22d3ee' : '#f87171'}">${pStr}</span>`) : ''}
                ${ciStr ? statPill('95% CI', `<span style="font-size:10px">${ciStr}</span>`) : ''}
                ${statPill('n videos', exp ? exp.n_videos : '—')}
                ${result ? statPill('r', rStr) : ''}
                ${statPill('Layer', `<span class="jarvis-signal-type-badge" style="background:rgba(${sig.layer === 'pre' ? '6,182,212' : '167,139,250'},0.15);color:${color}">${sig.layer === 'pre' ? 'Pre-upload' : 'Post-upload'}</span>`)}
                ${statPill('Resolution', resObj ? resObj.label : (ind ? ind.resolution_id : 'r0'))}
                ${statPill('Target', connTargets.join(', ') || 'views')}
                ${statPill('Depth', sig.depth || 1)}
            </div>

            <!-- Metric Definition -->
            ${metricDef ? `
            <div style="margin-bottom:10px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">What This Measures</div>
                <div style="font-size:12px;color:#cbd5e1;line-height:1.6;margin-bottom:6px">${metricDef.description}</div>
                <div style="background:#0f172a;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8">
                    <div><span style="color:#64748b">Formula:</span> <code style="color:#22d3ee">${metricDef.formula}</code></div>
                    <div style="margin-top:3px"><span style="color:#64748b">Sources:</span> ${(metricDef.data_sources || []).join(', ')}</div>
                    <div style="margin-top:3px"><span style="color:#64748b">Expected range:</span> ${metricDef.expected_range || '—'}</div>
                </div>
            </div>` : ''}

            <!-- Experiment -->
            ${exp ? `
            <div style="margin-bottom:10px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Experiment</div>
                <div style="background:#0a1628;border-radius:6px;padding:10px;font-size:11px">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
                        <code style="color:#22d3ee;font-size:10px;cursor:pointer;text-decoration:underline" onclick="JarvisUI.openExperimentInstance('${exp.id}')" title="Open in Experiments">${exp.id} &#x2197;&#xfe0f;</code>
                        <span style="font-size:9px;font-weight:600;padding:2px 6px;border-radius:3px;background:rgba(14,116,144,0.2);color:#0e7490">${result ? result.status : 'discovery'}</span>
                    </div>
                    <div style="color:#94a3b8"><span style="color:#64748b">Tool:</span> <strong style="color:#cbd5e1">${tool ? tool.name : exp.tool_id}</strong> v${tool ? tool.version || '1.0' : '1.0'}</div>
                    ${tool ? `<div style="margin-top:3px;font-size:10px;color:#64748b">${tool.description}</div>` : ''}
                    <div style="margin-top:6px;color:#94a3b8">
                        <span style="color:#64748b">Parameters:</span>
                        target=<code style="color:#22d3ee">${exp.parameters ? exp.parameters.target : 'views'}</code>,
                        transform=<code style="color:#22d3ee">${exp.parameters ? exp.parameters.transform_target : 'log10'}</code>,
                        min_n=<code style="color:#22d3ee">${exp.parameters ? exp.parameters.min_n : 50}</code>
                    </div>
                    <div style="margin-top:4px;color:#94a3b8"><span style="color:#64748b">Ran:</span> ${exp.ran_at ? new Date(exp.ran_at).toLocaleString() : '—'}</div>
                </div>
            </div>` : ''}

            <!-- Dataset sample -->
            ${dataset && dataset.length ? `
            <div style="margin-bottom:10px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Dataset (${dataset.length} videos)</div>
                <div style="background:#0a1628;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8">
                    <div>Min: <span style="color:#cbd5e1">${Math.min(...dataset.map(d => d.value)).toFixed(3)}</span> &nbsp; Max: <span style="color:#cbd5e1">${Math.max(...dataset.map(d => d.value)).toFixed(3)}</span> &nbsp; Mean: <span style="color:#cbd5e1">${(dataset.reduce((s,d) => s+d.value, 0)/dataset.length).toFixed(3)}</span></div>
                    <div style="margin-top:4px;font-size:10px;color:#475569">Per-video values stored for all ${dataset.length} videos. Click to inspect individual data points.</div>
                </div>
            </div>` : ''}

            <!-- Conclusion -->
            ${result && result.conclusion ? `
            <div style="margin-bottom:6px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Finding</div>
                <div style="background:#0f2942;border-left:3px solid #22d3ee;padding:10px;border-radius:0 6px 6px 0;font-size:12px;color:#e2e8f0;line-height:1.6">${result.conclusion}</div>
                ${result.practical_insight ? `<div style="margin-top:6px;background:#0a1f0a;border-left:3px solid #22c55e;padding:8px;border-radius:0 6px 6px 0;font-size:11px;color:#86efac;line-height:1.5">💡 ${result.practical_insight}</div>` : ''}
            </div>` : ''}

            <!-- Connections -->
            ${connTargets.length ? `
            <div>
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Graph Connections</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap">${connTargets.map(t => `<span style="background:#1e293b;padding:3px 8px;border-radius:12px;font-size:11px;color:#94a3b8">→ ${t}</span>`).join('')}</div>
            </div>` : ''}
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
        const mergeSlider = container?.querySelector('#jarvis-merge-slider');
        const mergeValue = container?.querySelector('#jarvis-merge-value');
        if (mergeSlider) {
            mergeSlider.addEventListener('input', (e) => {
                currentMergeThreshold = parseInt(e.target.value);
                if (mergeValue) mergeValue.textContent = currentMergeThreshold;
                const list = container?.querySelector('#jarvis-signal-list');
                if (list) list.innerHTML = renderSignalList();
                bindSignalRowClicks();
                buildD3TacticalGraph();
            });
        }
        // Graph filter buttons
        container?.querySelectorAll('.jarvis-graph-btn[data-gfilter]').forEach(btn => {
            btn.addEventListener('click', () => {
                graphFilter = btn.dataset.gfilter;
                container.querySelectorAll('.jarvis-graph-btn[data-gfilter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                buildD3TacticalGraph();
            });
        });
        // Graph size-by buttons
        container?.querySelectorAll('.jarvis-graph-btn[data-sizeby]').forEach(btn => {
            btn.addEventListener('click', () => {
                graphSizeBy = btn.dataset.sizeby;
                container.querySelectorAll('.jarvis-graph-btn[data-sizeby]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                buildD3TacticalGraph();
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

    function showNodePopup(d, event) {
        const popup = document.getElementById('jarvis-node-popup');
        if (!popup) return;

        // Look up full v2 indicator record
        const ind = v2Indicators ? v2Indicators.find(i => i.key === d.key) : null;
        const result = ind ? ind.result : null;
        const exp = ind ? ind.experiment : null;
        const metricDef = ind ? ind.metric_definition : null;
        const tool = (v2Tools && exp) ? v2Tools.find(t => t.id === exp.tool_id) : null;
        const resObj = (v2Resolutions && ind) ? v2Resolutions.find(r => r.id === ind.resolution_id) : null;
        const dataset = ind ? ind.dataset : null;
        const connTargets = ind ? (ind.connections || []) : (d.connections || []);

        const label = d.label || humanizeKey(d.key);
        const layer = d.layer || (ind ? ind.layer : 'post');

        const layerBadge = layer === 'pre'
            ? '<span style="display:inline-block;background:#7c3aed;color:#fff;font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;margin-left:8px;vertical-align:middle">pre-upload</span>'
            : layer === 'post'
            ? '<span style="display:inline-block;background:#0284c7;color:#fff;font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;margin-left:8px;vertical-align:middle">post-upload</span>'
            : '<span style="display:inline-block;background:#d97706;color:#fff;font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;margin-left:8px;vertical-align:middle">target</span>';

        const statPill = (lbl, val) => '<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">' + lbl + '</span><span style="font-size:12px;color:#cbd5e1">' + val + '</span></div>';
        const sectionHdr = (text) => '<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px;margin-top:14px">' + text + '</div>';

        const rVal = result ? result.primary_r : (d.r_partial != null ? d.r_partial : null);
        const rhoVal = result ? result.rho : null;
        const rStr = rVal != null ? '<span style="font-weight:700;color:' + (rVal >= 0 ? '#22d3ee' : '#f87171') + '">' + (rVal >= 0 ? '+' : '') + Number(rVal).toFixed(3) + '</span>' : '<span style="color:#64748b">—</span>';
        const rhoStr = rhoVal != null ? '<span style="color:' + (rhoVal >= 0 ? '#22d3ee' : '#f87171') + '">' + (rhoVal >= 0 ? '+' : '') + Number(rhoVal).toFixed(3) + '</span>' : null;
        const pVal = exp && exp.outputs ? exp.outputs.p_value : null;
        const ciLow = exp && exp.outputs ? exp.outputs.ci_low : null;
        const ciHigh = exp && exp.outputs ? exp.outputs.ci_high : null;
        const nVid = exp ? exp.n_videos : (dataset ? dataset.length : null);

        // Real connection count from v2 graph edges
        const graphEdgeCount = v2Graph ? (v2Graph.edges || []).filter(e => e.from === d.key || e.to === d.key).length : connTargets.length;

        let statsHtml = '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px;padding:8px 0;border-bottom:1px solid #1e293b">';
        statsHtml += statPill('Pearson r', rStr);
        if (rhoStr) statsHtml += statPill('Spearman ρ', rhoStr);
        if (pVal != null) statsHtml += statPill('p-value', '<span style="color:' + (pVal < 0.05 ? '#22d3ee' : '#f87171') + '">' + pVal.toFixed(4) + '</span>');
        if (ciLow != null) statsHtml += statPill('95% CI', '<span style="font-size:10px">[' + (ciLow >= 0 ? '+' : '') + ciLow.toFixed(3) + ', ' + (ciHigh >= 0 ? '+' : '') + ciHigh.toFixed(3) + ']</span>');
        if (nVid) statsHtml += statPill('n videos', nVid);
        // strength shown via rStr above — no separate label needed
        statsHtml += statPill('Resolution', resObj ? resObj.label : (ind ? ind.resolution_id : 'r0'));
        statsHtml += statPill('Depth', d.depth || 1);
        statsHtml += statPill('Connections', graphEdgeCount);
        statsHtml += '</div>';

        // Metric definition
        let metricHtml = '';
        if (metricDef) {
            metricHtml = sectionHdr('What This Measures')
                + '<div style="font-size:11px;color:#94a3b8;line-height:1.6;margin-bottom:6px">' + metricDef.description + '</div>'
                + '<div style="background:#0f172a;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8">'
                + '<div><span style="color:#64748b">Formula: </span><code style="color:#22d3ee">' + (metricDef.formula || '—') + '</code></div>'
                + '<div style="margin-top:3px"><span style="color:#64748b">Data sources: </span>' + (metricDef.data_sources || []).join(', ') + '</div>'
                + '<div style="margin-top:3px"><span style="color:#64748b">Expected range: </span>' + (metricDef.expected_range || '—') + '</div>'
                + '</div>';
        }

        // Experiment
        let expHtml = '';
        if (exp) {
            expHtml = sectionHdr('Experiment')
                + '<div style="background:#0a1628;border-radius:6px;padding:10px;font-size:11px">'
                + '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">'
                + '<code style="color:#22d3ee;font-size:10px;cursor:pointer;text-decoration:underline" onclick="JarvisUI.openExperimentInstance(\'' + exp.id + '\')" title="Open in Experiments">' + exp.id + ' \u2197\ufe0f</code>'
                + '<span style="font-size:9px;font-weight:600;padding:2px 6px;border-radius:3px;background:rgba(14,116,144,0.2);color:#0e7490">' + (result ? result.status : 'discovery') + '</span>'
                + '</div>'
                + '<div><span style="color:#64748b">Tool: </span><strong style="color:#cbd5e1">' + (tool ? tool.name : exp.tool_id) + '</strong></div>'
                + (tool ? '<div style="margin-top:2px;font-size:10px;color:#475569">' + tool.description + '</div>' : '')
                + '<div style="margin-top:6px"><span style="color:#64748b">target=</span><code style="color:#22d3ee">' + (exp.parameters ? exp.parameters.target : 'views') + '</code>'
                + ' <span style="color:#64748b">transform=</span><code style="color:#22d3ee">' + (exp.parameters ? exp.parameters.transform_target : 'log10') + '</code>'
                + ' <span style="color:#64748b">min_n=</span><code style="color:#22d3ee">' + (exp.parameters ? exp.parameters.min_n : 50) + '</code></div>'
                + (exp.ran_at ? '<div style="margin-top:4px;color:#475569">Ran: ' + new Date(exp.ran_at).toLocaleString() + '</div>' : '')
                + '</div>';
        }

        // Dataset summary
        let dataHtml = '';
        if (dataset && dataset.length) {
            const vals = dataset.map(d => d.value);
            const mn = Math.min(...vals), mx = Math.max(...vals), mean = vals.reduce((s, v) => s + v, 0) / vals.length;
            dataHtml = sectionHdr('Dataset')
                + '<div style="background:#0a1628;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8">'
                + dataset.length + ' videos &nbsp;—&nbsp; min: <span style="color:#cbd5e1">' + mn.toFixed(3) + '</span>'
                + ' &nbsp; max: <span style="color:#cbd5e1">' + mx.toFixed(3) + '</span>'
                + ' &nbsp; mean: <span style="color:#cbd5e1">' + mean.toFixed(3) + '</span>'
                + '</div>';
        }

        // Conclusion
        let findingHtml = '';
        if (result && result.conclusion) {
            findingHtml = sectionHdr('Finding')
                + '<div style="background:#0f2942;border-left:3px solid #22d3ee;padding:10px;border-radius:0 6px 6px 0;font-size:11px;color:#e2e8f0;line-height:1.6">' + result.conclusion + '</div>'
                + (result.practical_insight ? '<div style="margin-top:6px;background:#0a1f0a;border-left:3px solid #22c55e;padding:8px;border-radius:0 6px 6px 0;font-size:11px;color:#86efac;line-height:1.5">💡 ' + result.practical_insight + '</div>' : '');
        }

        // Connections
        let connHtml = '';
        if (connTargets.length) {
            connHtml = sectionHdr('Graph Connections')
                + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
                + connTargets.map(t => '<span style="background:#1e293b;padding:3px 8px;border-radius:12px;font-size:11px;color:#94a3b8">→ ' + t + '</span>').join('')
                + '</div>';
        }

        popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">'
            + '<div style="font-size:15px;font-weight:700;color:#f1f5f9;flex:1">' + label + layerBadge + '</div>'
            + '<button onclick="document.getElementById(\'jarvis-node-popup\').style.display=\'none\'" style="background:none;border:none;color:#64748b;font-size:18px;cursor:pointer;padding:0 0 0 8px;line-height:1">\u00d7</button>'
            + '</div>'
            + statsHtml + metricHtml + expHtml + dataHtml + findingHtml + connHtml;

        popup.style.display = 'block';
        const x = Math.min(event.clientX + 10, window.innerWidth - 460);
        const y = Math.min(event.clientY + 10, window.innerHeight - 350);
        popup.style.left = x + 'px';
        popup.style.top = y + 'px';
    }

    function buildD3TacticalGraph() {
        const graphEl = container?.querySelector('#jarvis-d3-graph');
        if (!graphEl) { console.error('Jarvis: #jarvis-d3-graph not found'); return; }
        if (typeof d3 === 'undefined') { console.error('Jarvis: D3 not loaded'); return; }
        graphEl.innerHTML = '';

        const width = graphEl.getBoundingClientRect().width || graphEl.offsetWidth || graphEl.parentElement?.clientWidth || 360;
        const height = 520;
        graphEl.style.height = height + 'px';

        const svg = d3.select(graphEl).append('svg')
            .attr('width', width).attr('height', height)
            .style('background', 'transparent')
            .style('touch-action', 'none');

        // ── Zoom + pan ──
        const graphGroup = svg.append('g').attr('class', 'graph-group');
        const zoom = d3.zoom()
            .scaleExtent([0.2, 4])
            .on('zoom', (event) => {
                graphGroup.attr('transform', event.transform);
            });
        svg.call(zoom);

        // ── Data: nodes + edges from v2 graph ──
        if (!v2Graph || !v2Graph.nodes) {
            graphEl.innerHTML = '<div style="padding:24px;color:#64748b;text-align:center">No graph data yet. Run the pipeline to add indicators.</div>';
            return;
        }

        const coreKeys = new Set(['views', 'keep', 'retention']);

        // All graph nodes from v2Graph, normalized for D3
        let allNodes = v2Graph.nodes.map(n => ({
            ...n,
            r_partial: n.r_partial,
            _clusterCount: 1,
        }));

        // Apply graphFilter
        let candidates = allNodes.filter(n => !coreKeys.has(n.key));
        if (graphFilter === 'pre-upload') candidates = candidates.filter(n => n.layer === 'pre');
        else if (graphFilter === 'post-upload') candidates = candidates.filter(n => n.layer === 'post');
        else if (graphFilter === 'kept') candidates = candidates.filter(n => isSignalKept(n.key));
        // 'all' and 'in-model' → keep all

        const coreNodes = allNodes.filter(n => coreKeys.has(n.key));
        const nodes = [...coreNodes, ...candidates];
        const nodeKeySet = new Set(nodes.map(n => n.key));

        // Edges from v2Graph — only include edges where both endpoints are in the visible node set
        const links = (v2Graph.edges || []).filter(e => nodeKeySet.has(e.from) && nodeKeySet.has(e.to))
            .map(e => ({ source: e.from, target: e.to, r: Math.abs(e.r || 0), peer: false }));

        // Core chain: keep→views, retention→views (always add if both visible)
        const hasViews = nodeKeySet.has('views');
        if (hasViews && nodeKeySet.has('keep') && !links.find(l => l.source === 'keep' && l.target === 'views')) {
            links.push({ source: 'keep', target: 'views', r: 0.5, peer: false });
        }
        if (hasViews && nodeKeySet.has('retention') && !links.find(l => l.source === 'retention' && l.target === 'views')) {
            links.push({ source: 'retention', target: 'views', r: 0.5, peer: false });
        }

        // ── Node helpers ──
        function nodeColor(d) {
            if (d.key === 'views') return '#f59e0b';
            if (d.layer === 'pre') return '#06b6d4';
            return '#a78bfa';
        }
        function nodeRadius(d) {
            if (d.key === 'views') return 20;
            const base = 4;
            if (graphSizeBy === 'r2') return base + Math.abs(d.r_partial || 0) * 14;
            if (graphSizeBy === 'connections') {
                const connCt = links.filter(l => {
                    if (l.peer) return false;
                    const sk = typeof l.source === 'object' ? l.source.key : l.source;
                    const tk = typeof l.target === 'object' ? l.target.key : l.target;
                    return sk === d.key || tk === d.key;
                }).length;
                return base + Math.min(connCt * 1.5, 14);
            }
            if (graphSizeBy === 'depth') return base + Math.min((d.depth || 1) * 2, 14);
            return base + 4;
        }

        // ── Initial positions ──
        nodes.forEach(d => {
            if (d.key === 'views') { d.x = width * 0.85; d.y = height * 0.35; }
            else if (d.layer === 'pre') { d.x = width * 0.22 + (Math.random() - 0.5) * 80; d.y = height * 0.5 + (Math.random() - 0.5) * 200; }
            else { d.x = width * 0.55 + (Math.random() - 0.5) * 80; d.y = height * 0.5 + (Math.random() - 0.5) * 200; }
        });

        // ── D3 Force Simulation — Obsidian style ──
        const simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(links).id(d => d.key).distance(d => {
                const tk = typeof d.target === 'object' ? d.target.key : d.target;
                if (tk === 'views') return 180;
                if (tk === 'keep' || tk === 'retention') return 120;
                return 60; // peer edges
            }).strength(d => d.peer ? 0.05 : 0.3))
            .force('charge', d3.forceManyBody().strength(-200).distanceMax(300))
            .force('x', d3.forceX(d => {
                if (d.key === 'views') return width * 0.85;
                if (d.layer === 'pre') return width * 0.22;
                return width * 0.55;
            }).strength(0.06))
            .force('y', d3.forceY(height / 2).strength(0.02))
            .force('collide', d3.forceCollide(d => nodeRadius(d) + 3))
            .alphaDecay(0.015)
            .stop();

        // Run simulation synchronously
        for (let i = 0; i < 300; i++) simulation.tick();

        // ── Edge rendering ──
        const linkGroup = graphGroup.append('g').attr('class', 'links');
        linkGroup.selectAll('line')
            .data(links)
            .join('line')
            .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x).attr('y2', d => d.target.y)
            .attr('stroke', d => {
                if (d.peer) return 'rgba(255,255,255,0.15)';
                return nodeColor(d.source);
            })
            .attr('stroke-opacity', d => {
                if (d.peer) return 0.04;
                const absR = Math.abs(d.r || 0);
                return Math.min(0.08 + absR * 0.4, 0.55);
            })
            .attr('stroke-width', d => {
                if (d.peer) return 0.5;
                return Math.min(0.5 + Math.abs(d.r || 0) * 2.0, 3);
            })
            .attr('stroke-dasharray', d => {
                if (d.peer) return '2,4';
                const tk = typeof d.target === 'object' ? d.target.key : d.target;
                if (tk === 'keep' || tk === 'retention') return '4,3';
                return null;
            });

        // ── Node rendering ──
        const nodeGroup = graphGroup.append('g').attr('class', 'nodes');
        const nodeEls = nodeGroup.selectAll('g')
            .data(nodes)
            .join('g')
            .attr('transform', d => `translate(${d.x},${d.y})`)
            .style('cursor', 'pointer');

        // Circle
        nodeEls.append('circle')
            .attr('r', d => nodeRadius(d))
            .attr('fill', d => nodeColor(d))
            .attr('fill-opacity', d => coreKeys.has(d.key) ? 0.95 : 0.75)
            .attr('stroke', 'rgba(255,255,255,0.12)')
            .attr('stroke-width', 1);

        // Labels: only for core nodes or nodes with radius >= 10
        nodeEls.filter(d => coreKeys.has(d.key) || nodeRadius(d) >= 10)
            .append('text')
            .attr('y', d => nodeRadius(d) + 11)
            .attr('text-anchor', 'middle')
            .attr('fill', '#64748b')
            .attr('font-size', '9px')
            .attr('font-family', 'system-ui, sans-serif')
            .text(d => {
                const lbl = d.label || d.key;
                return lbl.length > 16 ? lbl.slice(0, 15) + '\u2026' : lbl;
            });

        // ── Tooltip ──
        const tooltip = container?.querySelector('#jarvis-network-tooltip');
        nodeEls
            .on('mouseover', (event, d) => {
                if (!tooltip) return;
                // Highlight connected edges
                linkGroup.selectAll('line').attr('stroke-opacity', l => {
                    const sk = typeof l.source === 'object' ? l.source.key : l.source;
                    const tk = typeof l.target === 'object' ? l.target.key : l.target;
                    if (sk === d.key || tk === d.key) return l.peer ? 0.2 : 0.7;
                    return l.peer ? 0.02 : 0.06;
                });
                tooltip.style.display = 'block';
                const svgRect = graphEl.getBoundingClientRect();
                tooltip.style.left = (event.clientX - svgRect.left + 12) + 'px';
                tooltip.style.top = (event.clientY - svgRect.top - 10) + 'px';
                const connCt = links.filter(l => {
                    if (l.peer) return false;
                    const sk = typeof l.source === 'object' ? l.source.key : l.source;
                    const tk = typeof l.target === 'object' ? l.target.key : l.target;
                    return sk === d.key || tk === d.key;
                }).length;
                const rText = d.r_partial != null ? `<br><span class="jarvis-tt-dim">Strength:</span> ${Math.abs(Number(d.r_partial)).toFixed(3)}` : '';
                tooltip.innerHTML = `<strong>${d.label || d.key}</strong>${rText}<br><span class="jarvis-tt-dim">Connections:</span> ${connCt}`;
            })
            .on('mouseout', () => {
                if (tooltip) tooltip.style.display = 'none';
                // Restore edge opacity
                linkGroup.selectAll('line').attr('stroke-opacity', d => {
                    if (d.peer) return 0.04;
                    return Math.min(0.08 + Math.abs(d.r || 0) * 0.4, 0.55);
                });
            })
            .on('click', (event, d) => {
                event.stopPropagation();
                nodeClickCount[d.key] = (nodeClickCount[d.key] || 0) + 1;
                if (nodeClickCount[d.key] === 1) {
                    selectedNodeKey = d.key;
                    const label = document.getElementById('jarvis-node-label');
                    if (label) {
                        label.textContent = d.label || humanizeKey(d.key);
                        label.style.display = 'block';
                        label.style.left = (event.clientX) + 'px';
                        label.style.top = (event.clientY - 30) + 'px';
                    }
                    setTimeout(() => { nodeClickCount[d.key] = 0; }, 1500);
                } else if (nodeClickCount[d.key] >= 2) {
                    nodeClickCount[d.key] = 0;
                    const label = document.getElementById('jarvis-node-label');
                    if (label) label.style.display = 'none';
                    showNodePopup(d, event);
                }
            });

        // Click on SVG background clears selection + popup
        svg.on('click', (event) => {
            if (event.target.tagName === 'svg' || event.target.tagName === 'rect') {
                selectedNodeKey = null;
                nodeClickCount = {};
                const nlabel = document.getElementById('jarvis-node-label');
                if (nlabel) nlabel.style.display = 'none';
                const npopup = document.getElementById('jarvis-node-popup');
                if (npopup) npopup.style.display = 'none';
                tacticalExpandedSignal = null;
                const list = container?.querySelector('#jarvis-signal-list');
                if (list) {
                    list.innerHTML = renderSignalList();
                    bindSignalRowClicks();
                }
            }
        });

        // ── Node count indicator ──
        graphGroup.append('text')
            .attr('x', width - 8).attr('y', height - 8)
            .attr('text-anchor', 'end')
            .attr('fill', '#334155').attr('font-size', '9px')
            .attr('font-family', 'system-ui, sans-serif')
            .text(nodes.length + ' nodes \u00b7 ' + links.length + ' edges');

        // ── Drag support (with touch) ──
        const drag = d3.drag()
            .subject((event, d) => d)
            .on('start', (event, d) => {
                if (!event.active) simulation.alphaTarget(0.3).restart();
                d.fx = d.x; d.fy = d.y;
            })
            .on('drag', (event, d) => {
                d.fx = event.x; d.fy = event.y;
            })
            .on('end', (event, d) => {
                if (!event.active) simulation.alphaTarget(0);
                d.fx = null; d.fy = null;
            });
        nodeEls.call(drag);

        simulation.on('tick', () => {
            linkGroup.selectAll('line')
                .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
            nodeEls.attr('transform', d => `translate(${d.x},${d.y})`);
        });

        // Re-bind control buttons so they work after each rebuild
        container?.querySelectorAll('.jarvis-graph-btn[data-gfilter]').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                graphFilter = newBtn.dataset.gfilter;
                container?.querySelectorAll('.jarvis-graph-btn[data-gfilter]').forEach(b => b.classList.toggle('active', b.dataset.gfilter === graphFilter));
                buildD3TacticalGraph();
            });
        });
        container?.querySelectorAll('.jarvis-graph-btn[data-sizeby]').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                graphSizeBy = newBtn.dataset.sizeby;
                container?.querySelectorAll('.jarvis-graph-btn[data-sizeby]').forEach(b => b.classList.toggle('active', b.dataset.sizeby === graphSizeBy));
                buildD3TacticalGraph();
            });
        });
    }

    // ══════════════════════════════════════════════════
    // TAB 3: EXPERIMENTS — Unified log from results.tsv
    // ══════════════════════════════════════════════════
    let expCollapsed = {};
    let expSort = 'newest'; // 'best_r2' | 'newest' | 'kept'
    let expExplainOpen = false;

    function renderExperiments() {
        if (!v2Indicators) {
            loadV2Data().then(() => {
                const el = container?.querySelector('.jarvis-exp-root');
                if (el) {
                    el.innerHTML = renderExperimentsV2Content();
                    bindExperimentsV2Events();
                }
            });
            return '<div class="jarvis-exp-root"><div class="jarvis-loading">Loading v2 experiments...</div></div>';
        }
        setTimeout(bindExperimentsV2Events, 50);
        return `<div class="jarvis-exp-root">${renderExperimentsV2Content()}</div>`;
    }

    function renderExperimentsV2Content() {
        const experiments = v2Indicators || [];
        const tools = v2Tools || [];

        // Selected experiment detail
        let selectedCard = '';
        if (experimentsSelectedExpId) {
            const ind = experiments.find(i => i.experiment && i.experiment.id === experimentsSelectedExpId);
            if (ind) {
                selectedCard = `
                    <div style="margin-bottom:12px">
                        <button id="jarvis-exp-back-btn" style="background:none;border:1px solid #334155;color:#94a3b8;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-bottom:8px">&larr; Back</button>
                        ${renderExperimentInstanceCard(ind)}
                    </div>`;
            }
        }

        // Experiment list rows
        const rows = experiments.map(ind => {
            const exp = ind.experiment;
            if (!exp) return '';
            const r = ind.result ? ind.result.primary_r : null;
            const rStr = r != null ? `<span style="font-family:'SF Mono',monospace;color:${r >= 0 ? '#22d3ee' : '#f87171'}">r=${r >= 0 ? '+' : ''}${r.toFixed(3)}</span>` : '';
            const tool = tools.find(t => t.id === exp.tool_id);
            const isSelected = experimentsSelectedExpId === exp.id;
            return `<div class="jarvis-exp-v2-row" data-exp-v2-id="${exp.id}" style="display:flex;align-items:center;gap:8px;background:${isSelected ? '#1e293b' : '#0a1628'};padding:8px 10px;border-radius:6px;cursor:pointer${isSelected ? ';border-left:3px solid #22d3ee' : ''}">
                <code style="font-size:10px;color:#94a3b8;flex:1">${exp.id}</code>
                <span style="font-size:10px;color:#64748b">${tool ? tool.name : exp.tool_id}</span>
                <span style="font-size:11px;color:#94a3b8">${ind.key}</span>
                ${rStr}
            </div>`;
        }).join('');

        return `
            <div style="font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:10px">Experiments (${experiments.length} run)</div>
            ${selectedCard}
            <div style="display:flex;flex-direction:column;gap:4px">
                ${rows}
            </div>
        `;
    }

    function bindExperimentsV2Events() {
        container?.querySelectorAll('[data-exp-v2-id]').forEach(row => {
            row.addEventListener('click', () => {
                experimentsSelectedExpId = row.dataset.expV2Id;
                const el = container?.querySelector('.jarvis-exp-root');
                if (el) {
                    el.innerHTML = renderExperimentsV2Content();
                    bindExperimentsV2Events();
                }
            });
        });
        const backBtn = container?.querySelector('#jarvis-exp-back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                experimentsSelectedExpId = null;
                const el = container?.querySelector('.jarvis-exp-root');
                if (el) {
                    el.innerHTML = renderExperimentsV2Content();
                    bindExperimentsV2Events();
                }
            });
        }
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
        Promise.all([loadAutoResearchData(), loadIndicatorRegistry()]).then(() => {
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

    function renderAutoResearchContent() {
        if (!arModel) return '<div style="color:#f87171;padding:20px;">Failed to load prediction model.</div>';
        const m = arModel;
        const regTotal = cachedIndicatorRegistry ? cachedIndicatorRegistry.total : '—';
        const preR2 = m.pre_upload_model?.cv_r2_mean || '?';
        const fullR2 = m.full_model?.cv_r2_mean || '?';
        const preCount = cachedIndicatorRegistry ? cachedIndicatorRegistry.indicators.filter(i => i.layer === 'pre').length : '?';
        const postCount = cachedIndicatorRegistry ? cachedIndicatorRegistry.indicators.filter(i => i.layer === 'post').length : '?';
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
            <!-- Model Status -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">Model Status</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
                    <div style="padding:12px;background:rgba(6,182,212,0.08);border-radius:8px;border-left:3px solid #06b6d4">
                        <div style="font-size:11px;color:var(--j-muted);margin-bottom:4px">Pre-upload model</div>
                        <div style="font-family:'SF Mono',monospace;font-size:18px;font-weight:700;color:#06b6d4">CV R\u00b2 = ${preR2}</div>
                        <div style="font-size:10px;color:var(--j-muted);margin-top:2px">${m.pre_upload_model?.features?.length || '?'} features</div>
                    </div>
                    <div style="padding:12px;background:rgba(167,139,250,0.08);border-radius:8px;border-left:3px solid #a78bfa">
                        <div style="font-size:11px;color:var(--j-muted);margin-bottom:4px">Full model</div>
                        <div style="font-family:'SF Mono',monospace;font-size:18px;font-weight:700;color:#a78bfa">CV R\u00b2 = ${fullR2}</div>
                        <div style="font-size:10px;color:var(--j-muted);margin-top:2px">${m.full_model?.features?.length || '?'} features</div>
                    </div>
                </div>
                <div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;margin-bottom:12px">
                    <div style="font-size:11px;color:var(--j-muted);margin-bottom:6px">Total indicators in registry: <strong style="color:var(--j-text)">${regTotal}</strong></div>
                    <div style="display:flex;align-items:center;justify-content:center;gap:0;padding:8px 0">
                        <div style="text-align:center;padding:10px 18px;background:rgba(6,182,212,0.12);border-radius:8px 0 0 8px">
                            <div style="font-size:10px;color:#06b6d4;text-transform:uppercase;font-weight:600">Pre-upload</div>
                            <div style="font-size:18px;font-weight:700;color:#06b6d4">${preCount}</div>
                        </div>
                        <div style="font-size:16px;color:var(--j-muted);padding:0 8px">\u2192</div>
                        <div style="text-align:center;padding:10px 18px;background:rgba(167,139,250,0.12)">
                            <div style="font-size:10px;color:#a78bfa;text-transform:uppercase;font-weight:600">Post-upload</div>
                            <div style="font-size:18px;font-weight:700;color:#a78bfa">${postCount}</div>
                        </div>
                        <div style="font-size:16px;color:var(--j-muted);padding:0 8px">\u2192</div>
                        <div style="text-align:center;padding:10px 18px;background:rgba(245,158,11,0.12);border-radius:0 8px 8px 0">
                            <div style="font-size:10px;color:#f59e0b;text-transform:uppercase;font-weight:600">Views</div>
                            <div style="font-size:18px;font-weight:700;color:#f59e0b">1</div>
                        </div>
                    </div>
                </div>
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

        // (arSummaryOpen toggle removed — replaced by Model Status section)
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
        graphFilter = 'all';
        graphSizeBy = 'r2';
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

    return { open, close, openExperimentInstance, closeAnalyticalPanel };
})();

BuildingRegistry.register('Jarvis', {
    open: function(bodyEl, opts) { JarvisUI.open(bodyEl, opts); },
    close: function() { JarvisUI.close(); }
});
