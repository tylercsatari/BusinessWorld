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
        const experiments = v2Indicators || [];
        const derived = v2DerivedExperiments || [];
        const atomicTools = tools.filter(t => t.category !== 'derived');
        const derivedTools = tools.filter(t => t.category === 'derived');
        const toolColors = {
            pearson_r: '#3b82f6', spearman_rho: '#06b6d4',
            partial_correlation: '#a78bfa', ols_r2_delta: '#10b981',
        };
        const toolIcons = {
            pearson_r: '\uD83D\uDCCF', spearman_rho: '\uD83D\uDCCA',
            partial_correlation: '\uD83E\uDDF9', ols_r2_delta: '\uD83D\uDCC8',
        };
        const derivedColors = {
            interaction_to_views: '#a78bfa', pair_correlation: '#f59e0b',
            conditional_delta_to_views: '#22d3ee', depth3_interaction_to_views: '#ef4444',
            rank_pair_correlation: '#f97316', bucketed_curve_to_views: '#ec4899',
            piecewise_to_views: '#14b8a6',
        };
        const derivedIcons = {
            interaction_to_views: '\u00d7', pair_correlation: '\u2194',
            conditional_delta_to_views: '\u25b8', depth3_interaction_to_views: '\u25b3',
            rank_pair_correlation: '\u2197', bucketed_curve_to_views: '\u223f',
            piecewise_to_views: '\u2310',
        };

        if (!tools.length) {
            return '<div style="color:#475569;padding:20px;text-align:center">Loading tools...</div>';
        }

        // Count totals for summary
        const atomicCount = experiments.length;
        const derivedCount = derived.length;
        const totalCount = atomicCount + derivedCount;

        const summaryHtml = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
            <div style="background:#1e293b;border-radius:6px;padding:6px 12px;font-size:11px">
                <span style="color:#64748b">Total:</span> <span style="color:#f1f5f9;font-weight:700">${totalCount}</span>
            </div>
            <div style="background:#3b82f622;border-radius:6px;padding:6px 12px;font-size:11px">
                <span style="color:#64748b">Atomic:</span> <span style="color:#3b82f6;font-weight:700">${atomicCount}</span>
            </div>
            <div style="background:#a78bfa22;border-radius:6px;padding:6px 12px;font-size:11px">
                <span style="color:#64748b">Derived:</span> <span style="color:#a78bfa;font-weight:700">${derivedCount}</span>
            </div>
            <div style="background:#10b98122;border-radius:6px;padding:6px 12px;font-size:11px">
                <span style="color:#64748b">Methods:</span> <span style="color:#10b981;font-weight:700">${tools.length}</span>
            </div>
        </div>`;

        const makeToolRow = (tool, color, icon, usageCount) => {
            const isExpanded = analyticalSelectedTool === tool.id;
            const detail = isExpanded ? `<div class="jarvis-tool-list-detail">${renderToolDefinitionCard(tool, color)}</div>` : '';
            return `<div class="jarvis-tool-list-item">
            <div class="jarvis-tool-list-row${isExpanded ? ' expanded' : ''}" data-tool-id="${tool.id}">
                <div class="jarvis-tool-list-accent" style="background:${color}"></div>
                <span class="jarvis-tool-list-icon">${icon}</span>
                <div style="flex:1;min-width:0;overflow:hidden">
                    <div class="jarvis-tool-list-name">${tool.name}</div>
                    <div class="jarvis-tool-list-desc">${tool.description}</div>
                </div>
                <span class="jarvis-tool-list-badge">${usageCount} exp</span>
                <span class="jarvis-tool-list-chevron">${isExpanded ? '\u25BE' : '\u25B8'}</span>
            </div>
            ${detail}
        </div>`;
        };

        const atomicRows = atomicTools.map(tool => {
            const color = toolColors[tool.id] || '#64748b';
            const icon = toolIcons[tool.id] || '\u2699\ufe0f';
            const usageCount = experiments.filter(i => i.experiment && i.experiment.tool_id === tool.id).length;
            return makeToolRow(tool, color, icon, usageCount);
        }).join('');

        const derivedRows = derivedTools.map(tool => {
            const color = derivedColors[tool.id] || '#64748b';
            const icon = derivedIcons[tool.id] || '\u2699\ufe0f';
            const usageCount = derived.filter(d => d.kind === tool.id).length;
            return makeToolRow(tool, color, icon, usageCount);
        }).join('');

        return `${summaryHtml}
    <div style="margin-bottom:14px">
        <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px">Atomic Tools \u2014 single indicator \u2192 target</div>
        <div class="jarvis-tool-list">${atomicRows}</div>
    </div>
    <div style="margin-bottom:12px">
        <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px">Derived Analysis Methods \u2014 multi-indicator relationships</div>
        <div class="jarvis-tool-list">${derivedRows}</div>
    </div>`;
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

    function renderDerivedExperimentCard(d) {
        const exp = d.experiment || {};
        const result = d.result || {};
        const cfg = getExpKindConfig(d.kind);
        const comps = d.component_keys || [];
        const sectionHdr = text => `<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px;margin-top:12px">${text}</div>`;

        const r = result.primary_r;
        const rho = result.rho;
        const p = result.p_value ?? (exp.outputs ? exp.outputs.p_value : null);
        const ciLow = result.ci_low ?? (exp.outputs ? exp.outputs.ci_low : null);
        const ciHigh = result.ci_high ?? (exp.outputs ? exp.outputs.ci_high : null);
        const rStr = r != null ? `<span style="font-weight:700;color:${r >= 0 ? '#22d3ee' : '#f87171'}">${r >= 0 ? '+' : ''}${r.toFixed(3)}</span>` : '—';

        const label = derivedExperimentLabel(d);

        const ds = d.dataset || [];
        const dataRows = ds.slice(0, 20).map((dp, i) =>
            `<tr style="background:${i % 2 === 0 ? '#0a1020' : '#0d1525'}">
                <td style="padding:3px 8px;font-family:monospace;font-size:10px;color:#64748b">${dp.ytId}</td>
                <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#cbd5e1;text-align:right">${typeof dp.value === 'number' ? dp.value.toFixed(4) : dp.value}</td>
                <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#94a3b8;text-align:right">${typeof dp.target_value === 'number' ? dp.target_value.toFixed(4) : dp.target_value}</td>
            </tr>`
        ).join('');

        return `
            <div style="background:#0a1628;border-left:3px solid ${cfg.color};border-radius:0 8px 8px 0;padding:14px;margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
                    <div>
                        <div style="font-size:15px;font-weight:700;color:#f1f5f9">${label}</div>
                        <code style="font-size:10px;color:#475569">${exp.id || d.key}</code>
                    </div>
                    <div style="display:flex;gap:5px;align-items:center;flex-shrink:0">
                        <span style="font-size:9px;padding:2px 8px;border-radius:4px;background:${cfg.color}22;color:${cfg.color};font-weight:700">${cfg.label}</span>
                        ${d.depth ? `<span style="font-size:9px;padding:2px 8px;border-radius:4px;background:${d.depth >= 3 ? '#ef444422' : '#a78bfa22'};color:${d.depth >= 3 ? '#ef4444' : '#a78bfa'};font-weight:700">Depth ${d.depth}</span>` : ''}
                    </div>
                </div>

                ${sectionHdr('Experiment Design')}
                <div style="background:#0f172a;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8;margin-bottom:4px">
                    <div><span style="color:#64748b">Kind: </span><span style="color:${cfg.color};font-weight:600">${cfg.label}</span></div>
                    <div style="margin-top:3px"><span style="color:#64748b">Components: </span>${comps.map(k => `<code style="color:#22d3ee">${k}</code>`).join(' × ')}</div>
                    <div style="margin-top:3px"><span style="color:#64748b">Target: </span><code style="color:#f59e0b">${d.target || 'views'}</code></div>
                    <div style="margin-top:3px"><span style="color:#64748b">Formula: </span><code style="color:#22d3ee">${d.derived_formula || (d.metric_definition ? d.metric_definition.formula : '') || '—'}</code></div>
                    ${d.metric_definition && d.metric_definition.description ? `<div style="margin-top:3px"><span style="color:#64748b">Description: </span>${d.metric_definition.description}</div>` : ''}
                    <div style="margin-top:3px"><span style="color:#64748b">Tool: </span>${exp.tool_id || '—'}${exp.tool_version ? ' (v' + exp.tool_version + ')' : ''}</div>
                    ${exp.parameters ? `<div style="margin-top:3px"><span style="color:#64748b">Transform: </span><code>${exp.parameters.transform_target || '—'}</code></div>` : ''}
                </div>

                ${sectionHdr('Results')}
                <div style="display:flex;gap:14px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #1e293b;margin-bottom:8px">
                    <div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">Pearson r</span><span style="font-size:13px">${rStr}</span></div>
                    ${rho != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">Spearman ρ</span><span style="font-size:13px;color:${rho >= 0 ? '#22d3ee' : '#f87171'}">${rho >= 0 ? '+' : ''}${rho.toFixed(3)}</span></div>` : ''}
                    ${p != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">p-value</span><span style="font-size:13px;color:${p < 0.05 ? '#22d3ee' : '#f87171'}">${p < 0.001 ? p.toExponential(2) : p.toFixed(4)}</span></div>` : ''}
                    ${ciLow != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">95% CI</span><span style="font-size:12px;color:#94a3b8">[${ciLow >= 0 ? '+' : ''}${ciLow.toFixed(3)}, ${ciHigh >= 0 ? '+' : ''}${ciHigh.toFixed(3)}]</span></div>` : ''}
                    <div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">n videos</span><span style="font-size:13px;color:#cbd5e1">${exp.n_videos || ds.length || '—'}</span></div>
                </div>

                ${result.conclusion ? `
                <div style="background:#0f2942;border-left:3px solid #22d3ee;padding:10px;border-radius:0 6px 6px 0;font-size:12px;color:#e2e8f0;line-height:1.6;margin-bottom:8px">${result.conclusion}</div>
                ${result.practical_insight ? `<div style="background:#0a1f0a;border-left:3px solid #22c55e;padding:8px;border-radius:0 6px 6px 0;font-size:11px;color:#86efac;line-height:1.5">${result.practical_insight}</div>` : ''}
                ` : ''}

                ${ds.length ? `
                ${sectionHdr('Data Points (' + ds.length + ' videos)')}
                <div style="max-height:300px;overflow-y:auto;border-radius:6px;border:1px solid #1e293b">
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="background:#1e293b;position:sticky;top:0">
                            <th style="padding:4px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Video ID</th>
                            <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">${d.key}</th>
                            <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">log10(views)</th>
                        </tr></thead>
                        <tbody>${dataRows}</tbody>
                    </table>
                    ${ds.length > 20 ? `<div style="padding:6px 8px;font-size:10px;color:#475569;text-align:center">… ${ds.length - 20} more rows</div>` : ''}
                </div>
                ` : ''}
            </div>`;
    }

    function bindAnalyticalEvents() {
        container?.querySelectorAll('[data-tool-id]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.jarvis-tool-list-detail')) return;
                const tid = row.dataset.toolId;
                analyticalSelectedTool = analyticalSelectedTool === tid ? null : tid;
                analyticalSelectedExpId = null;
                const p = container?.querySelector('#jarvis-analytical-content');
                if (p) { p.innerHTML = renderAnalyticalContent(); bindAnalyticalEvents(); }
            });
        });
        container?.querySelectorAll('[data-exp-id]').forEach(row => {
            row.addEventListener('click', () => {
                analyticalSelectedExpId = row.dataset.expId;
                analyticalSelectedTool = null;
                const p = container?.querySelector('#jarvis-analytical-content');
                if (p) { p.innerHTML = renderAnalyticalContent(); bindAnalyticalEvents(); }
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
    let v2Indicators = null;   // array from /api/jarvis/v2/indicators (atomic only)
    let v2DerivedExperiments = null; // array from /api/jarvis/v2/derived-experiments (interactions)
    let v2Graph = null;        // {nodes, edges, derived_edges} from /api/jarvis/v2/graph
    let v2Tools = null;        // array from /api/jarvis/v2/tools
    let v2Resolutions = null;  // array from /api/jarvis/v2/resolutions

    async function loadV2Data() {
        try {
            const [iRes, dRes, gRes, tRes, rRes] = await Promise.all([
                fetch('/api/jarvis/v2/indicators'),
                fetch('/api/jarvis/v2/derived-experiments'),
                fetch('/api/jarvis/v2/graph'),
                fetch('/api/jarvis/v2/tools'),
                fetch('/api/jarvis/v2/resolutions'),
            ]);
            v2Indicators = await iRes.json();
            v2DerivedExperiments = await dRes.json();
            v2Graph = await gRes.json();
            v2Tools = await tRes.json();
            v2Resolutions = await rRes.json();
            return true;
        } catch (e) {
            console.error('Jarvis v2 load failed:', e);
            return false;
        }
    }

    // Composite keys have kind:'interaction' set by the runner, or match _x_ pattern
    // but exclude hardcoded static keys like keep_x_non_sub_share
    const UI_STATIC_COMPOSITE_KEYS = new Set(['keep_x_non_sub_share']);
    function isCompositeKeyUI(key) {
        if (UI_STATIC_COMPOSITE_KEYS.has(key)) return false;
        return /^(.+)_x_(.+)$/.test(key);
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
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#06b6d4"></span>Pre-upload</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#a78bfa"></span>Post-upload</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#f59e0b"></span>Views</span>
                <span class="jarvis-legend-item"><span style="font-family:'SF Mono',monospace;font-size:10px;color:#22d3ee">r=+</span> positive &nbsp; <span style="font-family:'SF Mono',monospace;font-size:10px;color:#f87171">r=-</span> negative</span>
            </div>
            <div id="jarvis-edge-legend" class="jarvis-network-legend" style="margin-bottom:6px;flex-wrap:wrap;gap:4px 10px"></div>
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
            </div>
            ${renderInteractionsList()}`;
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
        // Normalize v2 schema to what the UI expects — exclude composites (they live in derived_experiments)
        return v2Indicators
            .filter(ind => !isCompositeKeyUI(ind.key))
            .map(ind => ({
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

    function renderInteractionsList() {
        const derived = v2DerivedExperiments || [];
        if (!derived.length) return '';

        // Sort by |r| descending
        const sorted = [...derived].sort((a, b) => Math.abs((b.result?.primary_r) || 0) - Math.abs((a.result?.primary_r) || 0));
        const top = sorted.slice(0, 50);

        const rows = top.map(d => {
            const r = d.result?.primary_r;
            const rSign = r != null ? (r >= 0 ? '+' : '') : '';
            const rDisplay = r != null ? `${rSign}${r.toFixed(3)}` : '';
            const rColor = r != null ? (r >= 0 ? '#22d3ee' : '#f87171') : 'var(--j-muted)';
            const strength = d.result?.strength_label || '';
            const components = d.component_keys || [];
            const compA = components[0] || '?';
            const compB = components[1] || '?';
            const labelA = humanizeKey(compA);
            const labelB = humanizeKey(compB);
            const strengthColor = strength === 'strong' ? '#22c55e' : strength === 'moderate' ? '#f59e0b' : strength === 'weak' ? '#94a3b8' : '#475569';
            return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px">
                <span style="color:#a78bfa;min-width:12px">&times;</span>
                <span style="flex:1;color:#cbd5e1" title="${d.key}">${labelA} <span style="color:#64748b">&times;</span> ${labelB}</span>
                <span style="font-family:'SF Mono',monospace;font-size:10px;color:${rColor};white-space:nowrap">r=${rDisplay}</span>
                <span style="font-size:9px;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,0.06);color:${strengthColor}">${strength}</span>
            </div>`;
        }).join('');

        return `<div style="margin-top:14px;border-top:1px solid #1e293b;padding-top:10px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                <span style="font-size:12px;font-weight:600;color:#a78bfa">Interaction Experiments</span>
                <span style="font-size:10px;color:#64748b">(${derived.length} total, top ${top.length} by |r|)</span>
            </div>
            <div style="font-size:10px;color:#64748b;margin-bottom:6px">Derived relationships between base indicators. These are not standalone signals.</div>
            <div style="max-height:300px;overflow-y:auto;border:1px solid #1e293b;border-radius:6px;background:rgba(15,23,42,0.5)">
                ${rows}
            </div>
        </div>`;
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

        // Real connection count from v2 graph edges + derived edges
        const directEdgeCount = v2Graph ? (v2Graph.edges || []).filter(e => e.from === d.key || e.to === d.key).length : connTargets.length;
        const derivedEdgeCount = v2Graph ? (v2Graph.derived_edges || []).filter(de => de.from === d.key || de.to === d.key).length : 0;
        const graphEdgeCount = directEdgeCount + derivedEdgeCount;

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

        // Derived Relationships — show all relationship experiments this node participates in
        let derivedHtml = '';
        if (v2Graph && v2Graph.derived_edges) {
            const related = (v2Graph.derived_edges || []).filter(de =>
                de.from === d.key || de.to === d.key ||
                (de.component_keys || []).includes(d.key));
            if (related.length) {
                derivedHtml = sectionHdr('Derived Relationships (' + related.length + ')');
                derivedHtml += '<div style="display:flex;flex-direction:column;gap:4px">';
                related.forEach(de => {
                    const partner = de.from === d.key ? de.to : de.from;
                    const kind = de.kind || 'interaction';
                    const depthStr = de.depth ? ' d' + de.depth : '';

                    // Kind-specific color and display
                    let borderColor = '#a78bfa'; // default purple
                    let kindLabel = kind;
                    let metricStr = '';
                    const fmtR = (val, prefix) => {
                        if (val == null) return '';
                        const rc = val >= 0 ? '#22d3ee' : '#f87171';
                        return ' <span style="color:' + rc + ';font-weight:700">' + prefix + '=' + (val >= 0 ? '+' : '') + Number(val).toFixed(3) + '</span>';
                    };
                    if (kind === 'pair_correlation') {
                        borderColor = '#60a5fa'; // blue
                        kindLabel = 'corr';
                        metricStr = fmtR(de.primary_r != null ? de.primary_r : de.interaction_r, 'r');
                    } else if (kind === 'rank_pair_correlation') {
                        borderColor = '#38bdf8'; // sky blue
                        kindLabel = 'rank';
                        metricStr = fmtR(de.primary_r, 'ρ');
                        if (de.nonlinearity_gap != null && Math.abs(de.nonlinearity_gap) >= 0.02) {
                            metricStr += ' <span style="color:#fbbf24;font-size:9px">gap=' + (de.nonlinearity_gap >= 0 ? '+' : '') + Number(de.nonlinearity_gap).toFixed(3) + '</span>';
                        }
                    } else if (kind === 'conditional_delta_to_views') {
                        borderColor = '#f59e0b'; // amber
                        kindLabel = 'cond Δ';
                        metricStr = fmtR(de.delta_r, 'Δr');
                    } else if (kind === 'bucketed_curve_to_views') {
                        borderColor = '#4ade80'; // green
                        kindLabel = 'curve';
                        metricStr = fmtR(de.primary_r, 'r');
                        if (de.monotonic_score != null) {
                            metricStr += ' <span style="color:#a3e635;font-size:9px">mono=' + Number(de.monotonic_score).toFixed(2) + '</span>';
                        }
                    } else if (kind === 'piecewise_to_views') {
                        borderColor = '#fb923c'; // orange
                        kindLabel = 'piece';
                        if (de.nonlinearity_delta != null) {
                            metricStr = fmtR(de.nonlinearity_delta, 'Δslope');
                            metricStr += ' <span style="color:#94a3b8;font-size:9px">lo=' + Number(de.r_lower_half || 0).toFixed(2) + ' hi=' + Number(de.r_upper_half || 0).toFixed(2) + '</span>';
                        }
                    } else if (kind === 'depth3_interaction_to_views') {
                        borderColor = '#ec4899'; // pink
                        kindLabel = '3-way';
                        metricStr = fmtR(de.primary_r || de.interaction_r, 'r');
                    } else {
                        // interaction_to_views or legacy
                        kindLabel = '×';
                        metricStr = fmtR(de.interaction_r, 'r');
                    }

                    const strength = de.strength_label || '';
                    const target = de.target ? ' → ' + de.target : '';
                    const bridgeTag = de.bridge ? ' <span style="color:#34d399;font-size:9px;font-weight:600">BRIDGE</span>' : '';

                    derivedHtml += '<div style="background:#1a1040;border-left:3px solid ' + borderColor + ';padding:6px 8px;border-radius:0 6px 6px 0;font-size:11px;color:#e2e8f0">'
                        + '<span style="color:' + borderColor + ';font-weight:600;font-size:9px;text-transform:uppercase">' + kindLabel + depthStr + '</span> '
                        + '<span style="color:#a78bfa;font-weight:600">' + humanizeKey(partner) + '</span>'
                        + target + metricStr
                        + (strength ? ' <span style="color:#94a3b8">(' + strength + ')</span>' : '')
                        + bridgeTag
                        + '</div>';
                });
                derivedHtml += '</div>';
            }
        }

        popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">'
            + '<div style="font-size:15px;font-weight:700;color:#f1f5f9;flex:1">' + label + layerBadge + '</div>'
            + '<button onclick="document.getElementById(\'jarvis-node-popup\').style.display=\'none\'" style="background:none;border:none;color:#64748b;font-size:18px;cursor:pointer;padding:0 0 0 8px;line-height:1">\u00d7</button>'
            + '</div>'
            + statsHtml + metricHtml + expHtml + dataHtml + findingHtml + connHtml + derivedHtml;

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

        // All graph nodes from v2Graph, normalized for D3 — exclude composites
        let allNodes = v2Graph.nodes
            .filter(n => !isCompositeKeyUI(n.key))
            .map(n => ({
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

        // Derived edges — show as styled edges between component nodes
        (v2Graph.derived_edges || []).forEach(de => {
            if (nodeKeySet.has(de.from) && nodeKeySet.has(de.to)) {
                const rVal = de.interaction_r || de.primary_r || de.delta_r || 0;
                links.push({
                    source: de.from, target: de.to,
                    r: Math.abs(rVal),
                    peer: false, interaction: true,
                    interaction_key: de.interaction_key || de.experiment_key,
                    kind: de.kind || 'interaction_to_views',
                    depth: de.depth || 2,
                });
            }
        });

        // Core chain: keep→views, retention→views (always add if both visible)
        const hasViews = nodeKeySet.has('views');
        if (hasViews && nodeKeySet.has('keep') && !links.find(l => l.source === 'keep' && l.target === 'views')) {
            links.push({ source: 'keep', target: 'views', r: 0.5, peer: false });
        }
        if (hasViews && nodeKeySet.has('retention') && !links.find(l => l.source === 'retention' && l.target === 'views')) {
            links.push({ source: 'retention', target: 'views', r: 0.5, peer: false });
        }

        // ── Node helpers ──
        // Unique-neighbor degree for a node across ALL visible edges (direct + derived/interaction)
        function getVisibleDegree(nodeKey) {
            const neighbors = new Set();
            links.forEach(l => {
                const sk = typeof l.source === 'object' ? l.source.key : l.source;
                const tk = typeof l.target === 'object' ? l.target.key : l.target;
                if (sk === nodeKey) neighbors.add(tk);
                else if (tk === nodeKey) neighbors.add(sk);
            });
            return neighbors.size;
        }
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
                const connCt = getVisibleDegree(d.key);
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
                if (d.interaction) {
                    if (d.kind === 'pair_correlation') return '#60a5fa';
                    if (d.kind === 'rank_pair_correlation') return '#38bdf8';
                    if (d.kind === 'conditional_delta_to_views') return '#f59e0b';
                    if (d.kind === 'bucketed_curve_to_views') return '#4ade80';
                    if (d.kind === 'piecewise_to_views') return '#fb923c';
                    if (d.kind === 'depth3_interaction_to_views') return '#ec4899';
                    return '#a78bfa';
                }
                if (d.peer) return 'rgba(255,255,255,0.15)';
                return nodeColor(d.source);
            })
            .attr('stroke-opacity', d => {
                if (d.interaction) { const absR = Math.abs(d.r || 0); return Math.min(0.25 + absR * 0.5, 0.7); }
                if (d.peer) return 0.04;
                const absR = Math.abs(d.r || 0);
                return Math.min(0.08 + absR * 0.4, 0.55);
            })
            .attr('stroke-width', d => {
                if (d.interaction) return Math.min(1.0 + Math.abs(d.r || 0) * 2.0, 3);
                if (d.peer) return 0.5;
                return Math.min(0.5 + Math.abs(d.r || 0) * 2.0, 3);
            })
            .attr('stroke-dasharray', d => {
                if (d.interaction) {
                    if (d.kind === 'pair_correlation') return '4,2';
                    if (d.kind === 'rank_pair_correlation') return '4,2';
                    if (d.kind === 'bucketed_curve_to_views') return '6,2';
                    if (d.kind === 'piecewise_to_views') return '5,3';
                    if (d.kind === 'depth3_interaction_to_views') return '2,2';
                    return '3,3';
                }
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
                const connCt = getVisibleDegree(d.key);
                const rText = d.r_partial != null ? `<br><span class="jarvis-tt-dim">Strength:</span> ${Math.abs(Number(d.r_partial)).toFixed(3)}` : '';
                tooltip.innerHTML = `<strong>${d.label || d.key}</strong>${rText}<br><span class="jarvis-tt-dim">Connections:</span> ${connCt}`;
            })
            .on('mouseout', () => {
                if (tooltip) tooltip.style.display = 'none';
                // Restore edge opacity
                linkGroup.selectAll('line').attr('stroke-opacity', d => {
                    if (d.interaction) { const absR = Math.abs(d.r || 0); return Math.min(0.25 + absR * 0.5, 0.7); }
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

        // ── Edge-type legend with counts ──
        const edgeLegendEl = container?.querySelector('#jarvis-edge-legend');
        if (edgeLegendEl) {
            const kindCounts = {};
            let directCount = 0;
            links.forEach(l => {
                if (l.interaction) kindCounts[l.kind] = (kindCounts[l.kind] || 0) + 1;
                else if (!l.peer) directCount++;
            });
            const edgeKindMeta = {
                interaction_to_views:        { label: 'Interaction', color: '#a78bfa', dash: '3,3' },
                pair_correlation:            { label: 'Pair Corr',  color: '#60a5fa', dash: '4,2' },
                rank_pair_correlation:       { label: 'Rank Pair',  color: '#38bdf8', dash: '4,2' },
                conditional_delta_to_views:  { label: 'Cond Delta', color: '#f59e0b', dash: '3,3' },
                bucketed_curve_to_views:     { label: 'Bucketed',   color: '#4ade80', dash: '6,2' },
                piecewise_to_views:          { label: 'Piecewise',  color: '#fb923c', dash: '5,3' },
                depth3_interaction_to_views: { label: 'Depth-3',    color: '#ec4899', dash: '2,2' },
            };
            let legendHtml = `<span class="jarvis-legend-item" style="font-size:10px;color:#64748b">Edges:</span>`;
            legendHtml += `<span class="jarvis-legend-item"><svg width="20" height="6" style="vertical-align:middle"><line x1="0" y1="3" x2="20" y2="3" stroke="#06b6d4" stroke-width="1.5"/></svg><span style="font-size:10px;color:#94a3b8"> Direct (${directCount})</span></span>`;
            Object.entries(edgeKindMeta).forEach(([kind, meta]) => {
                const count = kindCounts[kind] || 0;
                if (count === 0) return;
                legendHtml += `<span class="jarvis-legend-item"><svg width="20" height="6" style="vertical-align:middle"><line x1="0" y1="3" x2="20" y2="3" stroke="${meta.color}" stroke-width="1.5" stroke-dasharray="${meta.dash}"/></svg><span style="font-size:10px;color:${meta.color}"> ${meta.label} (${count})</span></span>`;
            });
            edgeLegendEl.innerHTML = legendHtml;
        }
    }

    // ══════════════════════════════════════════════════
    // TAB 3: EXPERIMENTS — Unified log from results.tsv
    // ══════════════════════════════════════════════════
    let expCollapsed = {};
    let expSort = 'newest'; // 'best_r2' | 'newest' | 'kept'
    let expExplainOpen = false;
    let expKindFilter = null; // null = all, string = filter to one kind

    // ── Experiment Kind Registry ──
    const EXP_KIND_CONFIG = {
        atomic:                       { label: 'Atomic → Views',          color: '#3b82f6', icon: '⚛', order: 0 },
        interaction_to_views:         { label: 'Interaction → Views',     color: '#a78bfa', icon: '×', order: 1 },
        pair_correlation:             { label: 'Pair Correlations',       color: '#f59e0b', icon: '↔', order: 2 },
        conditional_delta_to_views:   { label: 'Conditional Effects',     color: '#22d3ee', icon: '▸', order: 3 },
        rank_pair_correlation:        { label: 'Rank / Monotonic',        color: '#f97316', icon: '↗', order: 4 },
        bucketed_curve_to_views:      { label: 'Bucketed / Non-linear',   color: '#ec4899', icon: '∿', order: 5 },
        piecewise_to_views:           { label: 'Piecewise Relationships', color: '#14b8a6', icon: '⌐', order: 6 },
        depth3_interaction_to_views:  { label: 'Depth 3 Interactions',    color: '#ef4444', icon: '△', order: 7 },
    };

    function getExpKindConfig(kind) {
        return EXP_KIND_CONFIG[kind] || { label: kind || 'Unknown', color: '#64748b', icon: '?', order: 99 };
    }

    function derivedExperimentLabel(d) {
        const comps = d.component_keys || [];
        const labels = comps.map(k => humanizeKey(k));
        const target = d.target || 'views';
        switch (d.kind) {
            case 'interaction_to_views':       return `${labels[0]} × ${labels[1]} → ${target}`;
            case 'pair_correlation':            return `${labels[0]} ↔ ${labels[1]}`;
            case 'conditional_delta_to_views':  return `${labels[0]} | ${labels[1]} → ${target}`;
            case 'rank_pair_correlation':       return `${labels[0]} ↔ ${labels[1]} (rank)`;
            case 'bucketed_curve_to_views':     return `${labels[1] ? labels[0] + ' ∿ ' + labels[1] : labels[0]} → ${target}`;
            case 'piecewise_to_views':          return `${labels[1] ? labels[0] + ' ⌐ ' + labels[1] : labels[0]} → ${target}`;
            case 'depth3_interaction_to_views': return `${labels[0]} × ${labels[1]} × ${labels[2] || '?'} → ${target}`;
            default: return labels.join(' × ') + (target ? ` → ${target}` : '');
        }
    }

    function primaryStatLabel(d) {
        const r = d.result?.primary_r;
        const rho = d.result?.rho;
        if (d.kind === 'rank_pair_correlation' && rho != null) return { label: 'ρ', value: rho };
        if (r != null) return { label: 'r', value: r };
        if (rho != null) return { label: 'ρ', value: rho };
        return null;
    }

    function renderExperimentRow(e, kind, tools) {
        const exp = e.experiment;
        if (!exp) return '';
        const isSelected = experimentsSelectedExpId === exp.id;
        const cfg = getExpKindConfig(kind);
        const stat = primaryStatLabel(e);
        const statHtml = stat
            ? `<span style="font-family:'SF Mono',monospace;font-size:10px;color:${stat.value >= 0 ? '#22d3ee' : '#f87171'};white-space:nowrap">${stat.label}=${stat.value >= 0 ? '+' : ''}${stat.value.toFixed(3)}</span>`
            : '';
        const label = kind === 'atomic'
            ? (e.label || humanizeKey(e.key))
            : derivedExperimentLabel(e);
        const depthBadge = e.depth && e.depth > 1
            ? `<span style="font-size:8px;padding:1px 5px;border-radius:3px;background:${e.depth >= 3 ? '#ef444433' : '#a78bfa22'};color:${e.depth >= 3 ? '#ef4444' : '#a78bfa'};font-weight:600">D${e.depth}</span>`
            : '';
        const kindBadge = kind !== 'atomic'
            ? `<span style="font-size:8px;padding:1px 5px;border-radius:3px;background:${cfg.color}22;color:${cfg.color};font-weight:600">${cfg.icon}</span>`
            : '';
        return `<div class="jarvis-exp-v2-row" data-exp-v2-id="${exp.id}" style="display:flex;align-items:center;gap:6px;background:${isSelected ? '#1e293b' : '#0a1628'};padding:6px 10px;border-radius:6px;cursor:pointer;border-left:3px solid ${isSelected ? cfg.color : 'transparent'};transition:border-color 0.15s">
            ${kindBadge}${depthBadge}
            <span style="flex:1;font-size:11px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
            ${statHtml}
        </div>`;
    }

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
        const atomics = (v2Indicators || []).map(ind => ({ ...ind, kind: ind.kind || 'atomic' }));
        const derived = (v2DerivedExperiments || []).map(d => ({ ...d, kind: d.kind || 'interaction_to_views' }));
        const allExperiments = [...atomics, ...derived];
        const tools = v2Tools || [];

        // Count by kind
        const kindCounts = {};
        allExperiments.forEach(e => { kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1; });

        const totalCount = allExperiments.length;
        const atomicCount = atomics.length;
        const derivedCount = derived.length;

        // Summary card builder
        const summaryCard = (label, count, color, filterKind) => {
            const isActive = filterKind === null ? !expKindFilter : expKindFilter === filterKind;
            return `<div class="jarvis-exp-summary-card" data-kind-filter="${filterKind === null ? '' : filterKind}" style="
                display:inline-flex;flex-direction:column;align-items:center;padding:8px 12px;
                border-radius:8px;cursor:pointer;min-width:70px;
                background:${isActive ? color + '22' : 'rgba(15,23,42,0.6)'};
                border:1px solid ${isActive ? color : '#1e293b'};
                transition:all 0.15s ease">
                <span style="font-size:18px;font-weight:800;color:${color}">${count}</span>
                <span style="font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap">${label}</span>
            </div>`;
        };

        // Top-level summary
        let summaryHtml = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            ${summaryCard('Total', totalCount, '#f1f5f9', null)}
            ${summaryCard('Atomic', atomicCount, '#3b82f6', 'atomic')}
            ${summaryCard('Derived', derivedCount, '#a78bfa', '_derived')}
        </div>`;

        // Kind breakdown cards (derived kinds only)
        const kindOrder = Object.entries(EXP_KIND_CONFIG)
            .filter(([k]) => k !== 'atomic')
            .sort((a, b) => a[1].order - b[1].order);
        const kindCards = kindOrder
            .filter(([k]) => kindCounts[k])
            .map(([k, cfg]) => summaryCard(cfg.label, kindCounts[k] || 0, cfg.color, k));
        if (kindCards.length) {
            summaryHtml += `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:14px">${kindCards.join('')}</div>`;
        }

        // Selected experiment detail card
        let selectedCard = '';
        if (experimentsSelectedExpId) {
            const found = allExperiments.find(e => e.experiment && e.experiment.id === experimentsSelectedExpId);
            if (found) {
                const card = (found.kind === 'atomic' || !found.component_keys)
                    ? renderExperimentInstanceCard(found)
                    : renderDerivedExperimentCard(found);
                selectedCard = `<div style="margin-bottom:12px">
                    <button id="jarvis-exp-back-btn" style="background:none;border:1px solid #334155;color:#94a3b8;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-bottom:8px">&larr; Back</button>
                    ${card}
                </div>`;
            }
        }

        // Filter experiments by active kind filter
        let visible = allExperiments;
        if (expKindFilter === '_derived') {
            visible = derived;
        } else if (expKindFilter) {
            visible = allExperiments.filter(e => e.kind === expKindFilter);
        }

        // Group by kind
        const groups = {};
        visible.forEach(e => {
            const k = e.kind || 'atomic';
            if (!groups[k]) groups[k] = [];
            groups[k].push(e);
        });

        // Sort each group by |r| descending
        Object.values(groups).forEach(arr => {
            arr.sort((a, b) => Math.abs((b.result?.primary_r) || 0) - Math.abs((a.result?.primary_r) || 0));
        });

        // Render grouped sections
        const sortedKinds = Object.keys(groups).sort((a, b) =>
            (getExpKindConfig(a).order ?? 99) - (getExpKindConfig(b).order ?? 99)
        );

        const groupsHtml = sortedKinds.map(kind => {
            const cfg = getExpKindConfig(kind);
            const items = groups[kind];
            const rows = items.map(e => renderExperimentRow(e, kind, tools)).join('');
            return `<div style="margin-bottom:16px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid ${cfg.color}33">
                    <span style="font-size:12px;color:${cfg.color}">${cfg.icon}</span>
                    <span style="font-size:12px;font-weight:700;color:${cfg.color}">${cfg.label}</span>
                    <span style="font-size:10px;color:#64748b">(${items.length})</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:3px;max-height:350px;overflow-y:auto">${rows}</div>
            </div>`;
        }).join('');

        return `
            <div style="font-size:14px;font-weight:700;color:#f1f5f9;margin-bottom:10px">
                Experiments <span style="font-weight:400;color:#64748b;font-size:12px">(${totalCount} total &mdash; ${atomicCount} atomic + ${derivedCount} derived)</span>
            </div>
            ${summaryHtml}
            ${selectedCard}
            ${groupsHtml}
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
        container?.querySelectorAll('.jarvis-exp-summary-card').forEach(card => {
            card.addEventListener('click', () => {
                const kind = card.dataset.kindFilter;
                if (kind === '') {
                    expKindFilter = null;
                } else {
                    expKindFilter = expKindFilter === kind ? null : kind;
                }
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
    // TAB 4: AUTORESEARCH — Pipeline Coordinator
    // ══════════════════════════════════════════════════

    function renderAutoResearch() {
        if (!v2Indicators) {
            loadV2Data().then(() => {
                const el = container?.querySelector('.jarvis-ar-root');
                if (el) { el.innerHTML = renderAutoResearchV2(); bindAutoResearchV2Events(); }
            });
        }
        setTimeout(bindAutoResearchV2Events, 50);
        return `<div class="jarvis-ar-root">${renderAutoResearchV2()}</div>`;
    }

    function renderAutoResearchV2() {
        const indicators = v2Indicators || [];
        const resolutions = v2Resolutions || [];
        const tools = v2Tools || [];

        // Coverage (non-r0 shelves)
        const narrowShelves = resolutions.filter(s => s.start_pct != null && s.end_pct != null && !(s.start_pct === 0 && s.end_pct === 100));

        // Sorted indicators by |r|
        const sortedInds = [...indicators].sort((a, b) => Math.abs((b.result?.primary_r) || 0) - Math.abs((a.result?.primary_r) || 0));

        // Pipeline steps
        const steps = [
            { id: 'theorize', label: 'Theorize', desc: 'Propose a candidate indicator from the queue' },
            { id: 'qualify', label: 'Qualify', desc: 'Check if indicator already exists' },
            { id: 'quantify', label: 'Quantify', desc: 'Define the measurable metric + formula' },
            { id: 'resolve', label: 'Resolve', desc: 'Assign to a resolution shelf; create new shelf if needed' },
            { id: 'dataset', label: 'Dataset', desc: 'Extract per-video values from 370 videos; store all data points' },
            { id: 'experiment', label: 'Experiment', desc: 'Run tool from Analytical Brain with all parameters stored' },
            { id: 'result', label: 'Result', desc: 'Mathematical result + English conclusion on the indicator' },
            { id: 'graph', label: 'Graph', desc: 'Add node + edge to Tactical Brain; assign depth' },
            { id: 'expand', label: 'Expand', desc: 'As graph grows, shift targets from views → cross-indicator' },
        ];

        const pipelineHtml = `
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:4px">
                ${steps.map((s, i) => `
                    <span style="background:#1e293b;border:1px solid #334155;padding:5px 10px;border-radius:6px;font-size:11px">
                        <span style="font-weight:700;color:#22d3ee">${s.label}</span>
                        <span style="color:#475569;display:block;font-size:9px;margin-top:1px">${s.desc}</span>
                    </span>
                    ${i < steps.length - 1 ? '<span style="color:#334155;font-size:16px">→</span>' : ''}
                `).join('')}
            </div>`;

        // Completed table
        const completedRows = sortedInds.map(ind => {
            const r = ind.result?.primary_r;
            const rStr = r != null ? `<span style="font-family:'SF Mono',monospace;color:${r >= 0 ? '#22d3ee' : '#f87171'}">${r >= 0 ? '+' : ''}${r.toFixed(3)}</span>` : '—';
            const expId = ind.experiment?.id;
            const tool = tools.find(t => t.id === ind.experiment?.tool_id);
            return `<tr data-ar-exp-id="${expId || ''}" style="cursor:${expId ? 'pointer' : 'default'};border-bottom:1px solid #1e293b">
                <td style="padding:5px 8px;font-size:11px;color:#cbd5e1">${ind.label || ind.key}</td>
                <td style="padding:5px 8px;font-size:10px;color:#64748b">${ind.resolution_id || 'r0'}</td>
                <td style="padding:5px 8px;font-size:10px;color:#64748b">${tool ? tool.name : (ind.experiment?.tool_id || '—')}</td>
                <td style="padding:5px 8px">${rStr}</td>
                <td style="padding:5px 8px;font-size:10px"><span style="color:${ind.layer === 'pre' ? '#06b6d4' : '#a78bfa'}">${ind.layer || 'post'}</span></td>
            </tr>`;
        }).join('');

        return `
            <div style="margin-bottom:16px">
                <div style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:4px">AutoResearch — Hybrid Autonomous Discovery</div>
                <div style="font-size:12px;color:#64748b;line-height:1.5">Autonomous indicator discovery. Claude proposes novel candidates (upstream LLM), then every downstream step is deterministic: canonicalize, validate, extract, correlate, graph. Gracefully falls back to template-generated candidates if the LLM step fails.</div>
            </div>

            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
                <div style="background:#0a1628;border-radius:8px;padding:12px 16px;flex:1;min-width:100px;text-align:center">
                    <div style="font-size:24px;font-weight:700;color:#22d3ee">${indicators.length}</div>
                    <div style="font-size:11px;color:#64748b">Completed</div>
                </div>
                <div style="background:#0a1628;border-radius:8px;padding:12px 16px;flex:1;min-width:100px;text-align:center">
                    <div style="font-size:24px;font-weight:700;color:#a78bfa">100+</div>
                    <div style="font-size:11px;color:#64748b">Candidate Space</div>
                    <div style="font-size:9px;color:#475569;margin-top:2px">(LLM + templates)</div>
                </div>
                <div style="background:#0a1628;border-radius:8px;padding:12px 16px;flex:1;min-width:100px;text-align:center">
                    <div style="font-size:24px;font-weight:700;color:#06b6d4">${resolutions.length}</div>
                    <div style="font-size:11px;color:#64748b">Resolution Shelves</div>
                </div>
                <div style="background:#0a1628;border-radius:8px;padding:12px 16px;flex:1;min-width:100px;text-align:center">
                    <div style="font-size:24px;font-weight:700;color:#f59e0b">∞</div>
                    <div style="font-size:11px;color:#64748b">Open Resolution Space</div>
                    <div style="font-size:9px;color:#475569;margin-top:2px">(never complete)</div>
                </div>
            </div>

            <div style="margin-bottom:16px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px">Pipeline Steps</div>
                ${pipelineHtml}
            </div>

            <div style="background:#0a1628;border-radius:8px;padding:14px;margin-bottom:16px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:10px">Autonomous Run</div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
                    <label style="font-size:12px;color:#94a3b8">Iterations</label>
                    <input id="ar-run-count" type="number" value="10" min="1" max="200" style="width:55px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:13px" />
                    <label style="font-size:12px;color:#94a3b8">Max min</label>
                    <input id="ar-max-minutes" type="number" value="30" min="1" max="120" style="width:50px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:13px" />
                    <label style="font-size:12px;color:#94a3b8">Fail cutoff</label>
                    <input id="ar-max-failures" type="number" value="5" min="1" max="50" style="width:45px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:13px" />
                    <label style="font-size:12px;color:#94a3b8">No-signal cutoff</label>
                    <input id="ar-max-nosignal" type="number" value="10" min="1" max="50" style="width:45px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:13px" />
                </div>
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <label style="font-size:12px;color:#94a3b8">LLM proposals</label>
                    <input id="ar-llm-candidates" type="number" value="25" min="0" max="100" style="width:50px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:13px" />
                    <label style="font-size:12px;color:#94a3b8">Pre-upload ratio</label>
                    <input id="ar-preupload-ratio" type="number" value="0.8" min="0" max="1" step="0.1" style="width:50px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:13px" />
                    <button id="ar-auto-btn" style="background:#7c3aed;color:#fff;border:none;padding:6px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">▶ Start Autonomous Run</button>
                    <button id="ar-run-btn" style="background:#0e7490;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:11px;cursor:pointer">Queue-only (legacy)</button>
                </div>
                <div id="ar-run-status" style="margin-top:8px;font-size:11px;min-height:16px"></div>
                <div id="ar-server-status" style="margin-top:4px;font-size:10px;color:#64748b;min-height:14px"></div>
                <div style="margin-top:6px;font-size:10px;color:#475569">Hybrid: Claude proposes candidates → deterministic pipeline validates, extracts, correlates, graphs. Falls back to templates if LLM fails.</div>
            </div>

            <div id="ar-live-progress" style="background:#0a1628;border:1px solid #1e293b;border-radius:8px;padding:14px;margin-bottom:16px;display:none">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                    <span id="ar-live-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e"></span>
                    <span style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b">Live Autonomous Progress</span>
                    <span id="ar-live-status" style="font-size:11px;font-weight:600;color:#22c55e;margin-left:auto"></span>
                </div>
                <div id="ar-live-body" style="font-size:12px;color:#cbd5e1"></div>
                <div id="ar-live-events" style="margin-top:10px"></div>
            </div>

            <div id="ar-latest-run" style="background:#0a1628;border-radius:8px;padding:14px;margin-bottom:16px;display:none">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px">Latest Autonomous Run</div>
                <div id="ar-latest-run-body" style="font-size:12px;color:#cbd5e1"></div>
            </div>

            ${indicators.length > 0 ? `
            <div>
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px">Completed Experiments (${indicators.length}) — click to inspect</div>
                <div style="border-radius:8px;overflow:hidden;border:1px solid #1e293b">
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="background:#1e293b">
                            <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Indicator</th>
                            <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Resolution</th>
                            <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Tool</th>
                            <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">r</th>
                            <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Layer</th>
                        </tr></thead>
                        <tbody>${completedRows}</tbody>
                    </table>
                </div>
            </div>` : '<div style="color:#475569;font-size:12px;padding:20px;text-align:center">No experiments run yet. Use the Run Pipeline button above.</div>'}
        `;
    }

    function bindAutoResearchV2Events() {
        // Autonomous run button
        const autoBtn = container?.querySelector('#ar-auto-btn');
        if (autoBtn) {
            autoBtn.addEventListener('click', async () => {
                const n = parseInt(container.querySelector('#ar-run-count')?.value || '10');
                const maxMin = parseInt(container.querySelector('#ar-max-minutes')?.value || '30');
                const maxFail = parseInt(container.querySelector('#ar-max-failures')?.value || '5');
                const maxNs = parseInt(container.querySelector('#ar-max-nosignal')?.value || '10');
                const llmN = parseInt(container.querySelector('#ar-llm-candidates')?.value || '25');
                const preRatio = parseFloat(container.querySelector('#ar-preupload-ratio')?.value);
                const statusEl = container.querySelector('#ar-run-status');
                if (statusEl) statusEl.innerHTML = '<span style="color:#a78bfa">Starting autonomous run (LLM proposal + deterministic pipeline)…</span>';
                autoBtn.disabled = true;
                try {
                    const body = { n, maxMinutes: maxMin, maxFailures: maxFail, maxNoSignal: maxNs, llmCandidates: llmN };
                    if (!isNaN(preRatio)) body.preUploadRatio = preRatio;
                    const resp = await fetch('/api/jarvis/v2/auto-run', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(body)
                    });
                    const data = await resp.json();
                    if (statusEl) statusEl.innerHTML = `<span style="color:#22c55e">✓ Autonomous run started (PID ${data.pid}). Live progress updating below.</span>`;
                    pollProgress();
                } catch (e) {
                    if (statusEl) statusEl.innerHTML = `<span style="color:#f87171">Error: ${e.message}</span>`;
                }
                setTimeout(() => { if (autoBtn) autoBtn.disabled = false; }, 5000);
            });
        }

        // Legacy queue-only button
        const runBtn = container?.querySelector('#ar-run-btn');
        if (runBtn) {
            runBtn.addEventListener('click', async () => {
                const n = parseInt(container.querySelector('#ar-run-count')?.value || '5');
                const statusEl = container.querySelector('#ar-run-status');
                if (statusEl) statusEl.innerHTML = '<span style="color:#22d3ee">Starting queue pipeline…</span>';
                runBtn.disabled = true;
                try {
                    const resp = await fetch('/api/jarvis/v2/run-pipeline', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ n })
                    });
                    const data = await resp.json();
                    if (statusEl) statusEl.innerHTML = `<span style="color:#22c55e">✓ Pipeline started (PID ${data.pid}). Running ${n} from queue. Refresh in ~60s.</span>`;
                } catch (e) {
                    if (statusEl) statusEl.innerHTML = `<span style="color:#f87171">Error: ${e.message}</span>`;
                }
                setTimeout(() => { if (runBtn) runBtn.disabled = false; }, 5000);
            });
        }

        // Load latest autonomous run status
        (async () => {
            try {
                const resp = await fetch('/api/jarvis/v2/auto-run-status');
                const runs = await resp.json();
                if (runs && runs.length > 0) {
                    const latest = runs[runs.length - 1];
                    const card = container?.querySelector('#ar-latest-run');
                    const body = container?.querySelector('#ar-latest-run-body');
                    if (card && body) {
                        card.style.display = 'block';
                        const modeLabel = latest.mode === 'hybrid_auto' ? 'Hybrid (LLM + deterministic)' : latest.mode;
                        body.innerHTML = `
                            <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px">
                                <span><b style="color:#a78bfa">${latest.id}</b></span>
                                <span style="color:#64748b">Mode: ${modeLabel}</span>
                                <span style="color:#64748b">Stop: ${latest.stop_reason}</span>
                            </div>
                            <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px">
                                <span>Attempted: <b>${latest.attempted}</b></span>
                                <span>Completed: <b style="color:#22c55e">${latest.completed}</b></span>
                                <span>Failures: <b style="color:#f87171">${latest.failures}</b></span>
                                ${latest.llm_proposed != null ? `<span>LLM proposed: <b style="color:#a78bfa">${latest.llm_proposed}</b></span>` : ''}
                                ${latest.llm_completed != null ? `<span>LLM completed: <b style="color:#a78bfa">${latest.llm_completed}</b></span>` : ''}
                                <span>Top |r|: <b style="color:#22d3ee">${latest.top_new_r_abs?.toFixed(4) || '—'}</b></span>
                                <span>Elapsed: <b>${latest.elapsed_minutes?.toFixed(1) || '?'}m</b></span>
                                <span>Total indicators: <b>${latest.total_indicators_after}</b></span>
                            </div>
                            ${latest.pre_attempted != null ? `<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;margin-top:4px">
                                <span>Pre-upload: <b style="color:#06b6d4">${latest.pre_completed}</b>/${latest.pre_attempted}</span>
                                <span>Post-upload: <b style="color:#a78bfa">${latest.post_completed}</b>/${latest.post_attempted}</span>
                                ${latest.preupload_ratio_requested != null ? `<span>Requested ratio: <b>${latest.preupload_ratio_requested}</b></span>` : ''}
                            </div>` : ''}
                        `;
                    }
                }
            } catch {}
        })();

        container?.querySelectorAll('[data-ar-exp-id]').forEach(row => {
            if (row.dataset.arExpId) {
                row.addEventListener('click', () => JarvisUI.openExperimentInstance(row.dataset.arExpId));
                row.addEventListener('mouseenter', () => row.style.background = '#0f2942');
                row.addEventListener('mouseleave', () => row.style.background = '');
            }
        });

        // ── Live progress polling ────────────────────────────────────
        if (window._arProgressInterval) { clearInterval(window._arProgressInterval); window._arProgressInterval = null; }
        function renderLiveProgress(d) {
            const card = container?.querySelector('#ar-live-progress');
            if (!card) return;
            if (!d || !d.run_id) { card.style.display = 'none'; return; }
            card.style.display = 'block';

            const dot = container.querySelector('#ar-live-dot');
            const statusEl = container.querySelector('#ar-live-status');
            if (d.active) {
                card.style.borderColor = '#22c55e';
                if (dot) { dot.style.background = '#22c55e'; dot.style.animation = 'ar-pulse 1.5s ease-in-out infinite'; }
                if (statusEl) { statusEl.textContent = '● Running'; statusEl.style.color = '#22c55e'; }
            } else {
                card.style.borderColor = '#1e293b';
                if (dot) { dot.style.background = '#64748b'; dot.style.animation = 'none'; }
                if (statusEl) {
                    statusEl.textContent = d.stop_reason ? `Finished — ${d.stop_reason}` : 'Idle';
                    statusEl.style.color = '#94a3b8';
                }
            }

            const pct = d.requested_iterations ? Math.round((d.attempted / d.requested_iterations) * 100) : 0;
            const body = container.querySelector('#ar-live-body');
            if (body) body.innerHTML = `
                <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px">
                    <span style="color:#64748b;font-size:10px">Run: <b style="color:#a78bfa">${d.run_id}</b></span>
                    <span style="color:#64748b;font-size:10px">Started: <b style="color:#cbd5e1">${d.started_at ? new Date(d.started_at).toLocaleTimeString() : '—'}</b></span>
                    ${d.updated_at ? `<span style="color:#64748b;font-size:10px">Updated: <b style="color:#cbd5e1">${new Date(d.updated_at).toLocaleTimeString()}</b></span>` : ''}
                </div>
                <div style="background:#1e293b;border-radius:4px;height:6px;margin-bottom:8px;overflow:hidden">
                    <div style="background:${d.active ? '#7c3aed' : '#475569'};height:100%;width:${pct}%;transition:width 0.3s"></div>
                </div>
                <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px">
                    <span>Attempted: <b>${d.attempted || 0}</b> / ${d.requested_iterations || '?'}</span>
                    <span>Completed: <b style="color:#22c55e">${d.completed || 0}</b></span>
                    <span>Failures: <b style="color:#f87171">${d.failures || 0}</b></span>
                    <span>No-signal: <b style="color:#f59e0b">${d.no_signal_streak || 0}</b></span>
                </div>
                <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;margin-top:4px">
                    <span>LLM proposed: <b style="color:#a78bfa">${d.llm_proposed || 0}</b></span>
                    <span>LLM completed: <b style="color:#a78bfa">${d.llm_completed || 0}</b></span>
                    ${d.current_candidate ? `<span>Current: <b style="color:#22d3ee">${d.current_candidate}</b></span>` : ''}
                </div>
                <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;margin-top:4px">
                    <span>Pre-upload: <b style="color:#06b6d4">${d.pre_completed || 0}</b>/<b>${d.pre_attempted || 0}</b></span>
                    <span>Post-upload: <b style="color:#a78bfa">${d.post_completed || 0}</b>/<b>${d.post_attempted || 0}</b></span>
                </div>
                ${d.last_completed_candidate ? `<div style="font-size:11px;margin-top:4px;color:#64748b">Last completed: <b style="color:#cbd5e1">${d.last_completed_candidate}</b> r=<span style="color:${(d.last_completed_r||0) >= 0 ? '#22d3ee' : '#f87171'}">${d.last_completed_r != null ? d.last_completed_r.toFixed(4) : '—'}</span></div>` : ''}
            `;

            const eventsEl = container.querySelector('#ar-live-events');
            if (eventsEl && d.recent_events && d.recent_events.length > 0) {
                const last6 = d.recent_events.slice(-6).reverse();
                eventsEl.innerHTML = `
                    <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.06em;color:#475569;margin-bottom:4px">Recent Events</div>
                    ${last6.map(e => {
                        if (e.type === 'completed') {
                            const rColor = (e.r || 0) >= 0 ? '#22d3ee' : '#f87171';
                            return `<div style="font-size:11px;padding:2px 0;color:#cbd5e1"><span style="color:#22c55e">✓</span> ${e.key} <span style="color:${rColor};font-family:'SF Mono',monospace;font-size:10px">r=${e.r != null ? e.r.toFixed(4) : '?'}</span></div>`;
                        } else {
                            return `<div style="font-size:11px;padding:2px 0;color:#cbd5e1"><span style="color:#f87171">✗</span> ${e.key} <span style="color:#64748b;font-size:10px">${e.reason || 'failed'}</span></div>`;
                        }
                    }).join('')}
                `;
            } else if (eventsEl) {
                eventsEl.innerHTML = '';
            }
        }

        // Inject pulse animation if not already present
        if (!document.querySelector('#ar-pulse-style')) {
            const style = document.createElement('style');
            style.id = 'ar-pulse-style';
            style.textContent = '@keyframes ar-pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }';
            document.head.appendChild(style);
        }

        async function pollProgress() {
            try {
                const resp = await fetch('/api/jarvis/v2/auto-run-progress');
                const data = await resp.json();
                renderLiveProgress(data);
            } catch {}
        }
        pollProgress();
        window._arProgressInterval = setInterval(pollProgress, 3000);

        // Server runner debug status
        async function pollRunnerStatus() {
            const el = container?.querySelector('#ar-server-status');
            if (!el) return;
            try {
                const resp = await fetch('/api/jarvis/v2/runner-status');
                const d = await resp.json();
                if (d.active) {
                    el.innerHTML = `<span style="color:#22d3ee">⚙ Server runner active (PID ${d.pid}, ${d.mode}) since ${d.startedAt ? new Date(d.startedAt).toLocaleTimeString() : '?'}</span>`;
                } else if (d.pid) {
                    const parts = [`exit=${d.exitCode}`];
                    if (d.signal) parts.push(`signal=${d.signal}`);
                    if (d.error) parts.push(d.error);
                    const color = d.exitCode === 0 ? '#22c55e' : '#f87171';
                    el.innerHTML = `<span style="color:${color}">Last run: PID ${d.pid} (${d.mode}) — ${parts.join(', ')}</span>`;
                } else {
                    el.textContent = '';
                }
            } catch { if (el) el.textContent = ''; }
        }
        pollRunnerStatus();
        setInterval(pollRunnerStatus, 5000);
    }

    // ══════════════════════════════════════════════════
    // TAB 5: RESOLUTION — v2 data model
    // ══════════════════════════════════════════════════

    const SHELF_COLORS = {
        r0: '#64748b', r_hook: '#06b6d4', r_last5pct: '#22d3ee',
        r_early: '#a78bfa', r_week1: '#f59e0b', r_week1_2: '#f59e0b', default: '#3b82f6'
    };

    function renderResolution() {
        if (!v2Resolutions || !v2Indicators) {
            loadV2Data().then(() => {
                const el = container?.querySelector('.jarvis-resolution-root');
                if (el) { el.innerHTML = renderResolutionV2(); bindResolutionV2Events(); }
            });
            return '<div class="jarvis-resolution-root"><div class="jarvis-loading">Loading resolution data...</div></div>';
        }
        setTimeout(bindResolutionV2Events, 50);
        return `<div class="jarvis-resolution-root">${renderResolutionV2()}</div>`;
    }

    function groupResolutionsByDimension(shelves, indicators) {
        const groups = [];

        // Video percentage shelves (has start_pct and end_pct)
        const pctShelves = shelves.filter(s => s.start_pct != null && s.end_pct != null);
        if (pctShelves.length > 0) {
            groups.push({
                type: 'video_pct',
                label: 'Video Timeline (%)',
                description: 'Indicators measured at a percentage position or window of the video',
                icon: '\u{1F4F9}',
                shelves: pctShelves.sort((a, b) => a.start_pct - b.start_pct),
                unit: '%',
                min: 0,
                max: 100,
            });
        }

        // Second-based shelves (has start_s or end_s)
        const sShelves = shelves.filter(s => s.start_s != null || s.end_s != null);
        if (sShelves.length > 0) {
            groups.push({
                type: 'video_s',
                label: 'Video Timeline (seconds)',
                description: 'Indicators measured at an absolute second position in the video',
                icon: '\u{23F1}\uFE0F',
                shelves: sShelves.sort((a, b) => (a.start_s || 0) - (b.start_s || 0)),
                unit: 's',
                min: 0,
                max: Math.max(...sShelves.map(s => s.end_s || 60)),
            });
        }

        // Day-based shelves (has start_day or end_day)
        const dayShelves = shelves.filter(s => s.start_day != null || s.end_day != null);
        if (dayShelves.length > 0) {
            groups.push({
                type: 'time_day',
                label: 'Post-Upload Timeline (days)',
                description: 'Indicators measured over a window of days since upload',
                icon: '\u{1F4C5}',
                shelves: dayShelves.sort((a, b) => (a.start_day || 0) - (b.start_day || 0)),
                unit: 'days',
                min: 0,
                max: Math.max(...dayShelves.map(s => s.end_day || 30)),
            });
        }

        // Frame-level
        const frameShelves = shelves.filter(s => s.granularity === 'frame');
        if (frameShelves.length > 0) {
            groups.push({
                type: 'frame',
                label: 'Frame Level',
                description: 'Indicators measured at per-frame granularity',
                icon: '\u{1F5BC}\uFE0F',
                shelves: frameShelves,
                unit: 'frame',
                min: null,
                max: null,
            });
        }

        // Word-level
        const wordShelves = shelves.filter(s => s.granularity === 'word');
        if (wordShelves.length > 0) {
            groups.push({
                type: 'word',
                label: 'Word Level',
                description: 'Indicators measured at individual word granularity',
                icon: '\u{1F4AC}',
                shelves: wordShelves,
                unit: 'word',
                min: null,
                max: null,
            });
        }

        return groups;
    }

    function renderResolutionDimensionBlock(group, indicators) {
        let html = '';

        // ── Block header ──
        html += `
            <div style="margin-bottom:16px;padding:14px;background:#0a1628;border-radius:10px;border:1px solid #1e293b">
                <div style="font-size:14px;font-weight:700;color:#f1f5f9;margin-bottom:4px">
                    ${group.icon} ${group.label}
                </div>
                <div style="font-size:11px;color:#64748b;margin-bottom:10px">${group.description}</div>`;

        // ── Visual bar (only for types with continuous axis) ──
        if (group.min != null && group.max != null) {
            const barH = 40;
            const labelH = 20;
            const totalH = barH + labelH + 10;

            let rects = '';
            let barLabels = '';

            // Background
            rects += `<rect x="0" y="0" width="100%" height="${barH}" rx="4" fill="#1e293b"/>`;

            // Gaps (only for video_pct)
            if (group.type === 'video_pct') {
                const narrowShelves = group.shelves.filter(s => !(s.start_pct === 0 && s.end_pct === 100));
                const gaps = computeResGaps(narrowShelves);
                for (const g of gaps) {
                    const x = ((g.start - group.min) / (group.max - group.min) * 100);
                    const w = ((g.end - g.start) / (group.max - group.min) * 100);
                    rects += `<rect x="${x}%" y="0" width="${w}%" height="${barH}" fill="#374151" opacity="0.7"/>`;
                    const mid = x + w / 2;
                    if (w > 8) {
                        barLabels += `<text x="${mid}%" y="${barH + labelH - 4}" text-anchor="middle" fill="#f59e0b" font-size="10" font-family="system-ui">&#9888; ${Math.round(g.end - g.start)}${group.unit} gap</text>`;
                    }
                }
            }

            // Shelf rects
            for (const s of group.shelves) {
                const color = SHELF_COLORS[s.id] || SHELF_COLORS.default;
                let startVal, endVal;
                if (group.type === 'video_pct') {
                    startVal = s.start_pct; endVal = s.end_pct;
                } else if (group.type === 'video_s') {
                    startVal = s.start_s || 0; endVal = s.end_s || group.max;
                } else if (group.type === 'time_day') {
                    startVal = s.start_day || 0; endVal = s.end_day || group.max;
                } else {
                    startVal = 0; endVal = group.max;
                }
                const xPct = ((startVal - group.min) / (group.max - group.min) * 100);
                const wPct = ((endVal - startVal) / (group.max - group.min) * 100);
                const isFullRange = (startVal === group.min && endVal === group.max && group.type === 'video_pct');

                if (isFullRange) {
                    rects = `<rect x="0" y="0" width="100%" height="${barH}" rx="4" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4,3"/>` + rects;
                } else {
                    rects += `<rect x="${xPct}%" y="2" width="${wPct}%" height="${barH - 4}" rx="3" fill="${color}" opacity="0.7"/>`;
                    if (wPct >= 8) {
                        const mid = xPct + wPct / 2;
                        rects += `<text x="${mid}%" y="${barH / 2 + 4}" text-anchor="middle" fill="#fff" font-size="10" font-weight="bold" font-family="system-ui">${s.label}</text>`;
                    }
                }

                // Indicator dots at shelf midpoint
                const shelfInds = indicators.filter(ind => ind.resolution_id === s.id);
                const midPct = xPct + wPct / 2;
                shelfInds.forEach((ind, idx) => {
                    const r = ind.result?.primary_r;
                    if (r != null) {
                        const dotY = barH + 6 + idx * 10;
                        const dotColor = r >= 0 ? '#06b6d4' : '#f87171';
                        barLabels += `<circle cx="${midPct}%" cy="${dotY}" r="3" fill="${dotColor}"/>`;
                    }
                });
            }

            // Axis labels
            let axis = '';
            const steps = group.type === 'video_pct' ? [0, 25, 50, 75, 100] :
                (() => {
                    const range = group.max - group.min;
                    const step = range <= 10 ? 1 : range <= 60 ? 10 : range <= 200 ? 50 : Math.ceil(range / 5);
                    const ticks = [];
                    for (let v = group.min; v <= group.max; v += step) ticks.push(v);
                    if (ticks[ticks.length - 1] !== group.max) ticks.push(group.max);
                    return ticks;
                })();
            for (const v of steps) {
                const pct = ((v - group.min) / (group.max - group.min) * 100);
                axis += `<text x="${pct}%" y="${barH + labelH + 8}" text-anchor="middle" fill="#64748b" font-size="9" font-family="system-ui">${v}${group.unit}</text>`;
            }

            html += `
                <div class="jarvis-resv2-timeline" style="margin-bottom:12px">
                    <svg width="100%" height="${totalH + 10}" viewBox="0 0 100 ${totalH + 10}" preserveAspectRatio="none" style="overflow:visible">
                        ${rects}
                        ${barLabels}
                        ${axis}
                    </svg>
                </div>`;
        } else {
            // Frame/word: no continuous axis, just a granularity label
            html += `
                <div style="display:flex;align-items:center;gap:8px;padding:8px 0;margin-bottom:8px">
                    <span style="font-size:20px">${group.icon}</span>
                    <span style="font-size:12px;color:#94a3b8">Granularity: <strong style="color:#f1f5f9">${group.unit}-level</strong> — no continuous axis</span>
                </div>`;
        }

        // ── Shelf cards ──
        html += '<div class="jarvis-resv2-shelves">';
        for (let i = 0; i < group.shelves.length; i++) {
            const shelf = group.shelves[i];
            const shelfIndicators = indicators.filter(ind => ind.resolution_id === shelf.id);
            const color = SHELF_COLORS[shelf.id] || SHELF_COLORS.default;

            let rangeLabel = '';
            if (shelf.start_pct != null && shelf.end_pct != null) {
                rangeLabel = `${shelf.start_pct}% \u2013 ${shelf.end_pct}%`;
            } else if (shelf.start_s != null || shelf.end_s != null) {
                rangeLabel = `${shelf.start_s || 0}s \u2013 ${shelf.end_s || '?'}s`;
            } else if (shelf.start_day != null || shelf.end_day != null) {
                rangeLabel = `Day ${shelf.start_day || 0} \u2013 ${shelf.end_day || '?'}`;
            } else if (shelf.granularity) {
                rangeLabel = shelf.granularity;
            }

            html += `
                <div class="jarvis-resv2-shelf" style="border-left:3px solid ${color}">
                    <div class="jarvis-resv2-shelf-header">
                        <span class="jarvis-resv2-shelf-label" style="color:${color}">${shelf.label}</span>
                        <span class="jarvis-resv2-shelf-range">${rangeLabel}</span>
                        <span class="jarvis-resv2-shelf-count">${shelfIndicators.length} indicator${shelfIndicators.length !== 1 ? 's' : ''}</span>
                    </div>
                    ${shelf.description ? `<div class="jarvis-resv2-shelf-desc">${shelf.description}</div>` : ''}
                    ${shelfIndicators.length > 0 ? `<div class="jarvis-resv2-indicators">${shelfIndicators.map(ind => {
                        const r = ind.result?.primary_r;
                        const rVal = r != null ? (r >= 0 ? '+' : '') + r.toFixed(3) : '\u2014';
                        const rColor = r != null ? (r >= 0 ? '#06b6d4' : '#f87171') : '#64748b';
                        const layer = ind.layer || '';
                        return `<div class="jarvis-resv2-ind-card">
                            <span class="jarvis-resv2-ind-label">${ind.label}</span>
                            <span class="jarvis-resv2-ind-r" style="color:${rColor}">${rVal}</span>
                            ${layer ? `<span class="jarvis-resv2-ind-layer">${layer}</span>` : ''}
                        </div>`;
                    }).join('')}</div>` : '<div class="jarvis-resv2-no-indicators">No indicators yet</div>'}
                </div>`;

            // Gap warnings between consecutive shelves in this group
            if (group.min != null && i < group.shelves.length - 1) {
                const next = group.shelves[i + 1];
                let gapStart, gapEnd;
                if (group.type === 'video_pct') {
                    gapStart = shelf.end_pct; gapEnd = next.start_pct;
                } else if (group.type === 'video_s') {
                    gapStart = shelf.end_s; gapEnd = next.start_s;
                } else if (group.type === 'time_day') {
                    gapStart = shelf.end_day; gapEnd = next.start_day;
                }
                if (gapStart != null && gapEnd != null && gapEnd > gapStart) {
                    html += `<div class="jarvis-resv2-gap-warning">&#9888; Gap: ${gapStart}${group.unit} \u2013 ${gapEnd}${group.unit} not yet measured</div>`;
                }
            }
        }
        html += '</div>';

        html += '</div>';
        return html;
    }

    function renderResolutionV2() {
        const shelves = v2Resolutions || [];
        const indicators = v2Indicators || [];

        // Group shelves by their dimension type
        const dimensionGroups = groupResolutionsByDimension(shelves, indicators);

        // Build one visualization block per dimension type
        let html = '';
        for (const group of dimensionGroups) {
            html += renderResolutionDimensionBlock(group, indicators);
        }

        // Stats summary
        const totalShelves = shelves.length;
        const totalIndicators = indicators.length;
        const pctShelves = shelves.filter(s => s.start_pct != null && !(s.start_pct === 0 && s.end_pct === 100));
        const coveredPct = computeCoverage(pctShelves.filter(s => s.end_pct != null));
        const gaps = computeResGaps(pctShelves.filter(s => s.end_pct != null));

        const statsHtml = `
            <div class="jarvis-resv2-stats" style="margin-bottom:16px">
                <span class="jarvis-resv2-stat"><strong>${totalShelves}</strong> shelves discovered</span>
                <span class="jarvis-resv2-stat"><strong>${totalIndicators}</strong> indicators mapped</span>
                <span class="jarvis-resv2-stat"><strong>${dimensionGroups.length}</strong> dimension types</span>
                <span class="jarvis-resv2-stat">${gaps.filter(g => g.end - g.start > 0).length > 0 ? `<strong style="color:#f59e0b">${gaps.filter(g=>g.end-g.start>0).length}</strong> gaps in video %` : '<strong style="color:#10b981">0</strong> gaps'}</span>
            </div>`;

        return `
            <div class="jarvis-resv2-container">
                <div style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:4px">Resolution Shelves</div>
                <div style="font-size:12px;color:#64748b;line-height:1.5;margin-bottom:12px">
                    Resolutions are discovered, not predefined. Each experiment is measured at a specific resolution \u2014 the granularity at which the indicator observes the video. Different dimensions (video %, seconds, days, frame, word) generate separate visualization axes.
                </div>
                ${statsHtml}
                ${html || '<div style="color:#475569;padding:20px;text-align:center">No resolution shelves yet. Run experiments to discover them.</div>'}
            </div>`;
    }

    function renderResTimeline(pctShelves, narrowShelves, gaps) {
        const barH = 40;
        const labelH = 20;
        const totalH = barH + labelH + 10;

        let rects = '';
        let labels = '';

        // Background bar
        rects += `<rect x="0" y="0" width="100%" height="${barH}" rx="4" fill="#1e293b"/>`;

        // Gap regions
        for (const g of gaps) {
            const x = g.start + '%';
            const w = (g.end - g.start) + '%';
            rects += `<rect x="${x}" y="0" width="${w}" height="${barH}" fill="#374151" opacity="0.7"/>`;
            const mid = g.start + (g.end - g.start) / 2;
            if (g.end - g.start > 8) {
                labels += `<text x="${mid}%" y="${barH + labelH - 4}" text-anchor="middle" fill="#f59e0b" font-size="10" font-family="system-ui">&#9888; ${(g.end - g.start)}% gap</text>`;
            }
        }

        // Shelf segments
        for (const s of pctShelves) {
            const color = SHELF_COLORS[s.id] || SHELF_COLORS.default;
            const x = s.start_pct + '%';
            const w = (s.end_pct - s.start_pct) + '%';
            const isFullVideo = s.start_pct === 0 && s.end_pct === 100;
            if (isFullVideo) {
                // Draw as outline behind everything
                rects = `<rect x="0" y="0" width="100%" height="${barH}" rx="4" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4,3"/>` + rects;
            } else {
                rects += `<rect x="${x}" y="2" width="${w}" height="${barH - 4}" rx="3" fill="${color}" opacity="0.7"/>`;
                // Label inside if wide enough
                const span = s.end_pct - s.start_pct;
                if (span >= 8) {
                    const mid = s.start_pct + span / 2;
                    rects += `<text x="${mid}%" y="${barH / 2 + 4}" text-anchor="middle" fill="#fff" font-size="10" font-weight="bold" font-family="system-ui">${s.label}</text>`;
                }
            }
        }

        // Percentage axis labels
        let axis = '';
        for (let p = 0; p <= 100; p += 25) {
            axis += `<text x="${p}%" y="${barH + labelH + 8}" text-anchor="middle" fill="#64748b" font-size="9" font-family="system-ui">${p}%</text>`;
        }

        return `
            <div class="jarvis-resv2-timeline">
                <svg width="100%" height="${totalH + 10}" viewBox="0 0 100 ${totalH + 10}" preserveAspectRatio="none" style="overflow:visible">
                    ${rects}
                    ${labels}
                    ${axis}
                </svg>
            </div>
        `;
    }

    function computeResGaps(narrowShelves) {
        if (narrowShelves.length === 0) return [{ start: 0, end: 100 }];
        const sorted = [...narrowShelves].sort((a, b) => a.start_pct - b.start_pct);
        const gaps = [];
        let cursor = 0;
        for (const s of sorted) {
            if (s.start_pct > cursor) {
                gaps.push({ start: cursor, end: s.start_pct });
            }
            cursor = Math.max(cursor, s.end_pct);
        }
        if (cursor < 100) {
            gaps.push({ start: cursor, end: 100 });
        }
        return gaps;
    }

    function computeCoverage(narrowShelves) {
        if (narrowShelves.length === 0) return 0;
        const sorted = [...narrowShelves].sort((a, b) => a.start_pct - b.start_pct);
        let covered = 0;
        let cursor = 0;
        for (const s of sorted) {
            const start = Math.max(s.start_pct, cursor);
            if (s.end_pct > start) {
                covered += s.end_pct - start;
                cursor = s.end_pct;
            }
        }
        return Math.round(covered);
    }

    function bindResolutionV2Events() {
        // Minimal — no interactions needed yet
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
