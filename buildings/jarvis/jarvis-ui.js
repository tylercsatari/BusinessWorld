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

    // ── Tab structure ──
    const TABS = [
        { id: 'analytical', label: 'Analytical' },
        { id: 'tactical', label: 'Tactical' },
        { id: 'experiments', label: 'Experiments' },
        { id: 'variables', label: 'Variables' },
        { id: 'mechanisms', label: 'Mechanisms' },
        { id: 'ideaModel', label: 'Idea Model' },
        { id: 'hookModel', label: 'Hook Model' },
        { id: 'projectIdeas', label: 'Project Ideas' },
        { id: 'autoResearch', label: 'AutoResearch' },
        { id: 'knowledge', label: 'Knowledge' },
        { id: 'resolution', label: 'Resolution' },
        { id: 'metaArchitecture', label: 'Meta-Architecture' },
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
            case 'variables': return renderVariables();
            case 'mechanisms':
                // Top-level shortcut: jump straight into the Knowledge →
                // Mechanisms surface so the catalog of named mechanisms is
                // one click away from anywhere in Jarvis.
                knowledgeSubTab = 'mechanisms';
                return renderKnowledge();
            case 'ideaModel': return renderIdeaModel();
            case 'hookModel': return renderHookModel();
            case 'projectIdeas': return renderProjectIdeas();
            case 'autoResearch': return renderAutoResearch();
            case 'knowledge': return renderKnowledge();
            case 'resolution': return renderResolution();
            case 'metaArchitecture': return renderMetaArchitecture();
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

    // ── Variable-definition / provenance block ──
    // Renders a self-contained card describing one variable's provenance:
    // plain-English description, formula, source fields/modality, quantification
    // style, and (for phrase families) the sample phrase list.
    //
    // Accepts a definition object produced by jarvis-variable-catalog.js, or
    // synthesises one on the fly if the browser module is present and no def
    // was supplied. Never throws — missing fields collapse silently.
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function lookupVariableDefinition(key, supplied) {
        if (supplied) return supplied;
        if (typeof window !== 'undefined' && window.JarvisVariableCatalog && typeof window.JarvisVariableCatalog.describeVariable === 'function') {
            try { return window.JarvisVariableCatalog.describeVariable(key); } catch (e) { return null; }
        }
        return null;
    }

    function renderVariableDefinitionRow(def, opts = {}) {
        if (!def) return '';
        const accent = opts.accent || '#22d3ee';
        const title = def.label || def.key || 'Variable';
        const badge = def.source
            ? `<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:${accent}22;color:${accent};font-weight:600;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(def.source.replace(/_/g,' '))}</span>`
            : '';
        const quantBadge = def.quantification
            ? `<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:#334155;color:#cbd5e1;font-weight:500;margin-left:4px">${escapeHtml(def.quantification)}</span>`
            : '';
        const modalityBadge = def.modality
            ? `<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:#1e293b;color:#94a3b8;margin-left:4px">${escapeHtml(def.modality)}</span>`
            : '';

        // Provenance badge — shows whether metric is deterministic or LLM-scored
        const provType = (opts.provenance && opts.provenance.type) || 'deterministic';
        const provColor = provType === 'deterministic' ? '#22c55e' : '#f59e0b';
        const provLabel = provType === 'deterministic' ? 'deterministic' : 'llm-scored';
        const provenanceBadge = `<span style="font-size:8px;padding:1px 5px;border-radius:3px;background:${provColor}22;color:${provColor};font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-left:4px;border:1px solid ${provColor}44">${provLabel}</span>`;

        const sourceFieldsHtml = (def.source_fields && def.source_fields.length)
            ? `<div style="margin-top:3px"><span style="color:#64748b">Source fields: </span>${def.source_fields.map(s => `<code style="color:#93c5fd;font-size:10px">${escapeHtml(s)}</code>`).join(' &middot; ')}</div>`
            : '';

        let phraseHtml = '';
        if (def.phrase_family && def.phrase_family.examples && def.phrase_family.examples.length) {
            const examples = def.phrase_family.examples.slice(0, 8).map(p => `<code style="background:#1e293b;color:#fbbf24;padding:1px 5px;border-radius:3px;font-size:10px;margin:1px">${escapeHtml(p)}</code>`).join(' ');
            phraseHtml = `<div style="margin-top:4px;padding:5px 7px;background:#0a1628;border-radius:4px;border-left:2px solid ${accent}">
                <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px">Phrase family: <span style="color:#fbbf24">${escapeHtml(def.phrase_family.const_name || def.phrase_family.name)}</span> &mdash; ${escapeHtml(def.phrase_family.signal || '')}</div>
                <div style="font-size:11px;color:#94a3b8;line-height:1.5">${examples}</div>
            </div>`;
        }

        const componentsHtml = (def.component_definitions && def.component_definitions.length)
            ? `<div style="margin-top:6px;padding-left:8px;border-left:2px dashed #334155">
                <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px">Component variables (each defined below)</div>
                ${def.component_definitions.map(cd => renderVariableDefinitionRow(cd, { accent: '#a78bfa', nested: true })).join('')}
            </div>`
            : '';

        return `
            <div style="background:${opts.nested ? '#0a1020' : '#0f172a'};border-radius:6px;padding:8px 10px;font-size:11px;color:#cbd5e1;margin-bottom:6px;border-left:3px solid ${accent}">
                <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:4px">
                    <code style="font-size:11px;color:${accent};font-weight:700">${escapeHtml(def.key || '')}</code>
                    <span style="color:#cbd5e1;font-size:11px">${escapeHtml(title)}</span>
                    ${badge}${quantBadge}${modalityBadge}${provenanceBadge}
                </div>
                ${def.description ? `<div style="color:#94a3b8;line-height:1.5;margin-top:2px">${escapeHtml(def.description)}</div>` : ''}
                ${def.formula ? `<div style="margin-top:4px"><span style="color:#64748b;font-size:10px">Formula: </span><code style="color:#22d3ee;font-size:10px;white-space:pre-wrap">${escapeHtml(def.formula)}</code></div>` : ''}
                ${sourceFieldsHtml}
                ${def.expected_range ? `<div style="margin-top:3px"><span style="color:#64748b;font-size:10px">Expected range: </span><span style="color:#cbd5e1;font-size:10px">${escapeHtml(def.expected_range)}</span></div>` : ''}
                ${phraseHtml}
                ${componentsHtml}
            </div>`;
    }

    function renderVariableDefinitionsSection(defs, opts = {}) {
        const cleaned = (defs || []).filter(Boolean);
        if (!cleaned.length) return '';
        const sectionHdr = text => `<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px;margin-top:12px">${text}</div>`;
        const header = opts.header || 'Variables &amp; Measurement Provenance';
        const sub = opts.sub ? `<div style="font-size:10px;color:#64748b;margin-bottom:6px">${opts.sub}</div>` : '';
        return `${sectionHdr(header)}${sub}${cleaned.map(d => renderVariableDefinitionRow(d, { accent: opts.accent, provenance: opts.provenance })).join('')}`;
    }

    function renderExperimentInstanceCard(ind) {
        const exp = ind.experiment;
        const result = ind.result;
        const tool = v2Tools ? v2Tools.find(t => t.id === exp.tool_id) : null;
        const dataset = ind.dataset || [];
        const datasetSize = dataset.length || ind._datasetSize || 0;
        const metricDef = ind.metric_definition || {};
        const color = ind.layer === 'pre' ? '#06b6d4' : '#a78bfa';

        const sectionHdr = text => `<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px;margin-top:12px">${text}</div>`;

        const r = result ? result.primary_r : null;
        const rho = result ? result.rho : null;
        const p = exp.outputs ? exp.outputs.p_value : null;
        const ciLow = exp.outputs ? exp.outputs.ci_low : null;
        const ciHigh = exp.outputs ? exp.outputs.ci_high : null;
        const rStr = r != null ? `<span style="font-weight:700;color:${r >= 0 ? '#22d3ee' : '#f87171'}">${r >= 0 ? '+' : ''}${r.toFixed(3)}</span>` : '—';

        let dataTableHtml = '';
        if (dataset.length) {
            const dataRows = dataset.slice(0, 20).map((d, i) =>
                `<tr style="background:${i % 2 === 0 ? '#0a1020' : '#0d1525'}">
                    <td style="padding:3px 8px;font-family:monospace;font-size:10px;color:#64748b">${d.ytId}</td>
                    <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#cbd5e1;text-align:right">${typeof d.value === 'number' ? d.value.toFixed(4) : d.value}</td>
                    <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#94a3b8;text-align:right">${typeof d.target_value === 'number' ? d.target_value.toFixed(4) : d.target_value}</td>
                </tr>`
            ).join('');
            dataTableHtml = `${sectionHdr('Data Points (' + dataset.length + ' videos)')}
                <div style="max-height:300px;overflow-y:auto;border-radius:6px;border:1px solid #1e293b">
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="background:#1e293b;position:sticky;top:0">
                            <th style="padding:4px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Video ID</th>
                            <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">${ind.key}</th>
                            <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">log10(views)</th>
                        </tr></thead>
                        <tbody>${dataRows}</tbody>
                    </table>
                    ${dataset.length > 20 ? '<div style="padding:6px 8px;font-size:10px;color:#475569;text-align:center">… ' + (dataset.length - 20) + ' more rows</div>' : ''}
                </div>`;
        } else if (datasetSize > 0) {
            dataTableHtml = `${sectionHdr('Data Points (' + datasetSize + ' videos)')}
                <div id="jarvis-exp-dataset-${ind.key}" style="padding:8px">
                    <button onclick="JarvisUI.loadExpDataset('${ind.key}','indicator')" style="background:#1e293b;border:1px solid #334155;color:#22d3ee;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">Load data points</button>
                </div>`;
        }

        return `
            <div style="background:#0a1628;border-left:3px solid ${color};border-radius:0 8px 8px 0;padding:14px;margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                    <div>
                        <div style="font-size:15px;font-weight:700;color:#f1f5f9">${ind.label || ind.key}</div>
                        <code style="font-size:10px;color:#475569">${exp.id}</code>
                    </div>
                    <button onclick="JarvisUI.closeAnalyticalPanel()" style="background:none;border:none;color:#64748b;font-size:16px;cursor:pointer">&times;</button>
                </div>

                ${sectionHdr('Instance: Method Applied to Indicator')}
                <div style="font-size:12px;color:#94a3b8;margin-bottom:8px">
                    Tool: <strong style="color:#cbd5e1">${tool ? tool.name : exp.tool_id}</strong> &mdash;
                    Indicator: <code style="color:${color}">${ind.key}</code> &rarr;
                    Target: <code style="color:#f59e0b">${exp.parameters ? exp.parameters.target : 'views'}</code>
                    (transform: <code>${exp.parameters ? exp.parameters.transform_target : 'log10'}</code>)
                </div>

                ${sectionHdr('What Was Measured')}
                <div style="background:#0f172a;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8;margin-bottom:4px">
                    <div><span style="color:#64748b">Description: </span>${metricDef.description || '—'}</div>
                    <div style="margin-top:3px"><span style="color:#64748b">Formula: </span><code style="color:#22d3ee">${metricDef.formula || '—'}</code></div>
                    <div style="margin-top:3px"><span style="color:#64748b">Extracted from: </span>${(metricDef.data_sources || []).join(', ')}</div>
                    <div style="margin-top:3px"><span style="color:#64748b">Resolution: </span>${ind.resolution_id || 'r0'}</div>
                    <div style="margin-top:3px"><span style="color:#64748b">Provenance: </span><span style="color:${(ind.provenance && ind.provenance.type === 'llm_scored') ? '#f59e0b' : '#22c55e'};font-weight:600">${(ind.provenance && ind.provenance.type) || 'deterministic'}</span></div>
                </div>

                ${renderVariableDefinitionsSection(
                    [lookupVariableDefinition(ind.key, ind.variable_definition)],
                    { header: 'Variable Definition &amp; Provenance', sub: 'Exactly how <code style="color:#22d3ee">' + escapeHtml(ind.key) + '</code> is quantified from raw data.', accent: color, provenance: ind.provenance }
                )}

                ${renderVariableDefinitionsSection(
                    [lookupVariableDefinition(
                        ind.target_key || (ind.parameters && ind.parameters.target) || (exp && exp.parameters && exp.parameters.target) || 'views',
                        ind.target_variable_definition
                    )],
                    { header: 'Target Variable Definition', sub: 'The dependent variable the correlation is measured against.', accent: '#f59e0b' }
                )}

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
                ${result.practical_insight ? `<div style="background:#0a1f0a;border-left:3px solid #22c55e;padding:8px;border-radius:0 6px 6px 0;font-size:11px;color:#86efac;line-height:1.5">${result.practical_insight}</div>` : ''}
                ` : ''}

                ${dataTableHtml}
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
        const dsSize = ds.length || d._datasetSize || 0;

        let dataTableHtml = '';
        if (ds.length) {
            const dataRows = ds.slice(0, 20).map((dp, i) =>
                `<tr style="background:${i % 2 === 0 ? '#0a1020' : '#0d1525'}">
                    <td style="padding:3px 8px;font-family:monospace;font-size:10px;color:#64748b">${dp.ytId}</td>
                    <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#cbd5e1;text-align:right">${typeof dp.value === 'number' ? dp.value.toFixed(4) : dp.value}</td>
                    <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#94a3b8;text-align:right">${typeof dp.target_value === 'number' ? dp.target_value.toFixed(4) : dp.target_value}</td>
                </tr>`
            ).join('');
            dataTableHtml = `${sectionHdr('Data Points (' + ds.length + ' videos)')}
                <div style="max-height:300px;overflow-y:auto;border-radius:6px;border:1px solid #1e293b">
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="background:#1e293b;position:sticky;top:0">
                            <th style="padding:4px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Video ID</th>
                            <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">${d.key}</th>
                            <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">log10(views)</th>
                        </tr></thead>
                        <tbody>${dataRows}</tbody>
                    </table>
                    ${ds.length > 20 ? '<div style="padding:6px 8px;font-size:10px;color:#475569;text-align:center">… ' + (ds.length - 20) + ' more rows</div>' : ''}
                </div>`;
        } else if (dsSize > 0) {
            dataTableHtml = `${sectionHdr('Data Points (' + dsSize + ' videos)')}
                <div id="jarvis-exp-dataset-${d.key}" style="padding:8px">
                    <button onclick="JarvisUI.loadExpDataset('${d.key}','derived')" style="background:#1e293b;border:1px solid #334155;color:#22d3ee;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">Load data points</button>
                </div>`;
        }

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
                    <div style="margin-top:3px"><span style="color:#64748b">Components: </span>${comps.map(k => `<code style="color:#22d3ee">${k}</code>`).join(' &times; ')}</div>
                    <div style="margin-top:3px"><span style="color:#64748b">Target: </span><code style="color:#f59e0b">${d.target || 'views'}</code></div>
                    <div style="margin-top:3px"><span style="color:#64748b">Formula: </span><code style="color:#22d3ee">${d.derived_formula || (d.metric_definition ? d.metric_definition.formula : '') || '—'}</code></div>
                    ${d.metric_definition && d.metric_definition.description ? `<div style="margin-top:3px"><span style="color:#64748b">Description: </span>${d.metric_definition.description}</div>` : ''}
                    <div style="margin-top:3px"><span style="color:#64748b">Tool: </span>${exp.tool_id || '—'}${exp.tool_version ? ' (v' + exp.tool_version + ')' : ''}</div>
                    ${exp.parameters ? `<div style="margin-top:3px"><span style="color:#64748b">Transform: </span><code>${exp.parameters.transform_target || '—'}</code></div>` : ''}
                </div>

                ${renderVariableDefinitionsSection(
                    [lookupVariableDefinition(d.key, d.variable_definition)],
                    { header: 'Composite Variable Definition', sub: 'How the combined variable <code style="color:#22d3ee">' + escapeHtml(d.key) + '</code> is produced.', accent: cfg.color }
                )}

                ${renderVariableDefinitionsSection(
                    (d.component_variable_definitions && d.component_variable_definitions.length
                        ? d.component_variable_definitions
                        : comps.map(k => lookupVariableDefinition(k))),
                    { header: 'Component Variable Definitions', sub: 'Each ingredient of the composite &mdash; how it\'s tracked + quantified.', accent: '#a78bfa' }
                )}

                ${renderVariableDefinitionsSection(
                    [lookupVariableDefinition(
                        d.target_key || d.target || (d.parameters && d.parameters.target) || (exp && exp.parameters && exp.parameters.target) || 'views',
                        d.target_variable_definition
                    )],
                    { header: 'Target Variable Definition', sub: 'The dependent variable the correlation is measured against (defaults to <code>views</code>).', accent: '#f59e0b' }
                )}

                ${sectionHdr('Results')}
                <div style="display:flex;gap:14px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #1e293b;margin-bottom:8px">
                    <div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">Pearson r</span><span style="font-size:13px">${rStr}</span></div>
                    ${rho != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">Spearman ρ</span><span style="font-size:13px;color:${rho >= 0 ? '#22d3ee' : '#f87171'}">${rho >= 0 ? '+' : ''}${rho.toFixed(3)}</span></div>` : ''}
                    ${p != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">p-value</span><span style="font-size:13px;color:${p < 0.05 ? '#22d3ee' : '#f87171'}">${p < 0.001 ? p.toExponential(2) : p.toFixed(4)}</span></div>` : ''}
                    ${ciLow != null ? `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">95% CI</span><span style="font-size:12px;color:#94a3b8">[${ciLow >= 0 ? '+' : ''}${ciLow.toFixed(3)}, ${ciHigh >= 0 ? '+' : ''}${ciHigh.toFixed(3)}]</span></div>` : ''}
                    <div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase">n videos</span><span style="font-size:13px;color:#cbd5e1">${exp.n_videos || dsSize || '—'}</span></div>
                </div>

                ${result.conclusion ? `
                <div style="background:#0f2942;border-left:3px solid #22d3ee;padding:10px;border-radius:0 6px 6px 0;font-size:12px;color:#e2e8f0;line-height:1.6;margin-bottom:8px">${result.conclusion}</div>
                ${result.practical_insight ? `<div style="background:#0a1f0a;border-left:3px solid #22c55e;padding:8px;border-radius:0 6px 6px 0;font-size:11px;color:#86efac;line-height:1.5">${result.practical_insight}</div>` : ''}
                ` : ''}

                ${dataTableHtml}
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

    // ── v2 data cache (compact summaries — no dataset arrays) ──
    let v2Indicators = null;
    let v2DerivedExperiments = null;
    let v2Graph = null;
    let v2Tools = null;
    let v2Resolutions = null;

    // Detail cache: full records fetched on demand (keyed by indicator/derived key)
    const v2DetailCache = {};

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

    async function fetchIndicatorDetail(key) {
        if (v2DetailCache['ind:' + key]) return v2DetailCache['ind:' + key];
        try {
            const res = await fetch('/api/jarvis/v2/indicator/' + encodeURIComponent(key));
            if (!res.ok) return null;
            const data = await res.json();
            v2DetailCache['ind:' + key] = data;
            return data;
        } catch (e) { console.error('Detail fetch failed:', key, e); return null; }
    }

    async function fetchDerivedDetail(key) {
        if (v2DetailCache['der:' + key]) return v2DetailCache['der:' + key];
        try {
            const res = await fetch('/api/jarvis/v2/derived-experiment/' + encodeURIComponent(key));
            if (!res.ok) return null;
            const data = await res.json();
            v2DetailCache['der:' + key] = data;
            return data;
        } catch (e) { console.error('Detail fetch failed:', key, e); return null; }
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
        const ind = v2Indicators ? v2Indicators.find(i => i.key === sig.key) : null;
        const metricDef = ind ? ind.metric_definition : null;
        const exp = ind ? ind.experiment : null;
        const result = ind ? ind.result : null;
        const dataset = ind ? ind.dataset : null;
        const datasetSize = dataset ? dataset.length : (ind ? ind._datasetSize || 0 : 0);
        const tool = (v2Tools && exp) ? v2Tools.find(t => t.id === exp.tool_id) : null;
        const resObj = (v2Resolutions && ind) ? v2Resolutions.find(r => r.id === ind.resolution_id) : null;
        const connTargets = (ind && ind.connections) ? ind.connections : [];

        const statPill = (label, val, valColor) => `<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">${label}</span><span style="font-size:12px;color:${valColor || '#cbd5e1'}">${val}</span></div>`;

        const rVal = result ? result.primary_r : null;
        const rhoVal = result ? result.rho : null;
        const rStr = rVal != null ? `<span style="font-weight:700;color:${rVal >= 0 ? '#22d3ee' : '#f87171'}">${rVal >= 0 ? '+' : ''}${rVal.toFixed(3)}</span>` : '—';
        const rhoStr = rhoVal != null ? `<span style="color:${rhoVal >= 0 ? '#22d3ee' : '#f87171'}">${rhoVal >= 0 ? '+' : ''}${rhoVal.toFixed(3)}</span>` : '—';
        const pStr = (exp && exp.outputs && exp.outputs.p_value != null) ? exp.outputs.p_value.toFixed(4) : '—';
        const ciStr = (exp && exp.outputs && exp.outputs.ci_low != null) ? `[${exp.outputs.ci_low >= 0 ? '+' : ''}${exp.outputs.ci_low.toFixed(3)}, ${exp.outputs.ci_high >= 0 ? '+' : ''}${exp.outputs.ci_high.toFixed(3)}]` : '';

        let datasetHtml = '';
        if (dataset && dataset.length) {
            const vals = dataset.map(d => d.value);
            datasetHtml = `<div style="margin-bottom:10px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Dataset (${dataset.length} videos)</div>
                <div style="background:#0a1628;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8">
                    <div>Min: <span style="color:#cbd5e1">${Math.min(...vals).toFixed(3)}</span> &nbsp; Max: <span style="color:#cbd5e1">${Math.max(...vals).toFixed(3)}</span> &nbsp; Mean: <span style="color:#cbd5e1">${(vals.reduce((s,v) => s+v, 0)/vals.length).toFixed(3)}</span></div>
                </div>
            </div>`;
        } else if (datasetSize > 0) {
            datasetHtml = `<div style="margin-bottom:10px" id="jarvis-detail-ds-${sig.key}">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Dataset (${datasetSize} videos)</div>
                <div style="background:#0a1628;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8">
                    <button onclick="JarvisUI.loadSignalDataset('${sig.key}')" style="background:#1e293b;border:1px solid #334155;color:#22d3ee;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">Load data points</button>
                </div>
            </div>`;
        }

        return `<div class="jarvis-signal-detail" style="border-left: 3px solid ${color}">
            <div class="jarvis-signal-detail-name">${sig.label || sig.key}</div>
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

            ${datasetHtml}

            ${result && result.conclusion ? `
            <div style="margin-bottom:6px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Finding</div>
                <div style="background:#0f2942;border-left:3px solid #22d3ee;padding:10px;border-radius:0 6px 6px 0;font-size:12px;color:#e2e8f0;line-height:1.6">${result.conclusion}</div>
                ${result.practical_insight ? `<div style="margin-top:6px;background:#0a1f0a;border-left:3px solid #22c55e;padding:8px;border-radius:0 6px 6px 0;font-size:11px;color:#86efac;line-height:1.5">${result.practical_insight}</div>` : ''}
            </div>` : ''}

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
        const datasetSize = dataset ? dataset.length : (ind ? ind._datasetSize || 0 : 0);
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
        } else if (datasetSize > 0) {
            dataHtml = sectionHdr('Dataset')
                + '<div style="background:#0a1628;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8">'
                + datasetSize + ' videos'
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
            ${renderExperimentsVariablesPanel()}
        `;
    }

    // Embedded variables-catalog panel inside the Experiments tab. Collapsible,
    // searchable mini-version of the Variables tab — so users can look up the
    // definition of a metric key without leaving the experiment view.
    let expVarsPanelOpen = false;
    let expVarsSearch = '';
    let expVarsSelectedKey = null;

    function renderExperimentsVariablesPanel() {
        const sectionHdr = text => `<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px;margin-top:12px">${text}</div>`;

        // Lazy-load the catalog on first expansion; the panel itself is always
        // rendered so the toggle stays visible even before data is ready.
        if (expVarsPanelOpen && (!variablesCatalog || !variablesKnown)) {
            loadVariablesCatalog().then(() => {
                const el = container?.querySelector('.jarvis-exp-root');
                if (el) { el.innerHTML = renderExperimentsV2Content(); bindExperimentsV2Events(); }
            });
        }

        const toggleBtn = `<button id="jarvis-exp-vars-toggle" style="
            background:${expVarsPanelOpen ? '#22d3ee22' : 'rgba(15,23,42,0.6)'};
            color:${expVarsPanelOpen ? '#22d3ee' : '#94a3b8'};
            border:1px solid ${expVarsPanelOpen ? '#22d3ee' : '#1e293b'};
            padding:6px 12px;font-size:11px;border-radius:6px;cursor:pointer;
            display:inline-flex;align-items:center;gap:6px">
            <span>${expVarsPanelOpen ? '▾' : '▸'}</span>
            <span>Variables Catalog</span>
            <span style="color:#64748b;font-size:10px">${(variablesKnown && variablesKnown.total) ? '(' + variablesKnown.total + ')' : ''}</span>
        </button>`;

        if (!expVarsPanelOpen) {
            return `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #1e293b">${toggleBtn}
                <div style="margin-top:6px;font-size:10px;color:#64748b">Open to search phrase-family metrics, retention windows, composites — same directory as the Variables tab.</div>
            </div>`;
        }

        const allVars = (variablesKnown && variablesKnown.variables) || [];
        const search = (expVarsSearch || '').trim().toLowerCase();
        const filtered = search
            ? allVars.filter(v => {
                const hay = `${v.key || ''} ${v.label || ''} ${v.description || ''} ${v.quantification || ''} ${v.modality || ''} ${v.family || ''}`.toLowerCase();
                return hay.includes(search);
              })
            : allVars;
        const cap = 200;
        const overflow = Math.max(0, filtered.length - cap);
        const shown = filtered.slice(0, cap);

        const rows = shown.map(v => {
            const selected = expVarsSelectedKey === v.key;
            return `<div class="jarvis-exp-vars-row" data-exp-var-key="${escapeHtml(v.key)}" style="
                display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:5px;cursor:pointer;
                background:${selected ? '#1e293b' : 'transparent'};border-left:3px solid ${selected ? '#22d3ee' : 'transparent'}">
                <code style="font-size:10px;color:#22d3ee;flex:0 0 auto;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(v.key)}</code>
                <span style="flex:1;font-size:10px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(v.label || '')}</span>
                <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#1e293b;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;flex-shrink:0">${escapeHtml((v.source || 'unknown').replace(/_/g,' '))}</span>
            </div>`;
        }).join('');

        let selectedHtml = '';
        if (expVarsSelectedKey) {
            const def = allVars.find(v => v.key === expVarsSelectedKey) || lookupVariableDefinition(expVarsSelectedKey);
            if (def) {
                selectedHtml = `<div style="margin-bottom:8px">
                    <button id="jarvis-exp-vars-back-btn" style="background:none;border:1px solid #334155;color:#94a3b8;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;margin-bottom:6px">&larr; Close detail</button>
                    ${renderVariableDefinitionRow(def, { accent: '#22d3ee' })}
                </div>`;
            }
        }

        return `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #1e293b">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                ${toggleBtn}
                <a href="#" id="jarvis-exp-vars-open-tab" style="font-size:10px;color:#64748b;text-decoration:none;margin-left:4px">Open full Variables tab &rarr;</a>
            </div>
            <div style="margin-top:10px;background:#05080f;border:1px solid #1e293b;border-radius:8px;padding:10px">
                <input type="text" id="jarvis-exp-vars-search" placeholder="Search variables (proof_of_work, retention, interaction…)" value="${escapeHtml(expVarsSearch)}" style="
                    width:100%;background:#0a1628;border:1px solid #1e293b;color:#f1f5f9;
                    padding:6px 10px;border-radius:6px;font-size:11px;outline:none;margin-bottom:8px" />
                ${selectedHtml}
                ${sectionHdr(`Matching variables (${filtered.length}${overflow ? ' — ' + overflow + ' more hidden, narrow search' : ''})`)}
                <div style="display:flex;flex-direction:column;gap:2px;max-height:280px;overflow-y:auto;padding:2px">
                    ${rows || '<div style="padding:10px;color:#64748b;font-size:11px;text-align:center">No variables match.</div>'}
                </div>
            </div>
        </div>`;
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

        const rerender = () => {
            const el = container?.querySelector('.jarvis-exp-root');
            if (!el) return;
            el.innerHTML = renderExperimentsV2Content();
            bindExperimentsV2Events();
        };
        const toggleVars = container?.querySelector('#jarvis-exp-vars-toggle');
        if (toggleVars) {
            toggleVars.addEventListener('click', () => {
                expVarsPanelOpen = !expVarsPanelOpen;
                if (!expVarsPanelOpen) { expVarsSelectedKey = null; expVarsSearch = ''; }
                rerender();
            });
        }
        const varsSearch = container?.querySelector('#jarvis-exp-vars-search');
        if (varsSearch) {
            varsSearch.addEventListener('input', (e) => {
                expVarsSearch = e.target.value || '';
                rerender();
                const s2 = container?.querySelector('#jarvis-exp-vars-search');
                if (s2) { s2.focus(); s2.setSelectionRange(expVarsSearch.length, expVarsSearch.length); }
            });
        }
        container?.querySelectorAll('.jarvis-exp-vars-row').forEach(row => {
            row.addEventListener('click', () => {
                expVarsSelectedKey = row.dataset.expVarKey;
                rerender();
            });
        });
        const varsBack = container?.querySelector('#jarvis-exp-vars-back-btn');
        if (varsBack) {
            varsBack.addEventListener('click', () => { expVarsSelectedKey = null; rerender(); });
        }
        const openVarsTab = container?.querySelector('#jarvis-exp-vars-open-tab');
        if (openVarsTab) {
            openVarsTab.addEventListener('click', (e) => {
                e.preventDefault();
                activeTab = 'variables';
                if (expVarsSelectedKey) variablesSelectedKey = expVarsSelectedKey;
                if (expVarsSearch) variablesSearch = expVarsSearch;
                render();
            });
        }
    }

    // ══════════════════════════════════════════════════
    // TAB: VARIABLES — browsable, searchable catalog of every variable +
    //                  pattern + phrase family the system knows about.
    // ══════════════════════════════════════════════════
    let variablesCatalog = null;       // { static_variables, phrase_families, quantification_styles, non_phrase_rules }
    let variablesKnown = null;         // { total, variables: [ { key, ...def } ] }
    let variablesSearch = '';
    let variablesFilter = 'all';       // 'all' | 'static' | 'phrase_family' | 'retention_percentile' | ...
    let variablesSelectedKey = null;

    async function loadVariablesCatalog() {
        if (variablesCatalog && variablesKnown) return true;
        try {
            const [cRes, kRes] = await Promise.all([
                fetch('/api/jarvis/v2/variables/catalog'),
                fetch('/api/jarvis/v2/variables/known'),
            ]);
            variablesCatalog = await cRes.json();
            variablesKnown = await kRes.json();
            return true;
        } catch (e) {
            console.error('Variables catalog load failed:', e);
            variablesCatalog = variablesCatalog || { static_variables: [], phrase_families: [], quantification_styles: [], non_phrase_rules: [] };
            variablesKnown = variablesKnown || { total: 0, variables: [] };
            return false;
        }
    }

    function renderVariables() {
        if (!variablesCatalog || !variablesKnown) {
            loadVariablesCatalog().then(() => {
                const el = container?.querySelector('.jarvis-vars-root');
                if (el) { el.innerHTML = renderVariablesContent(); bindVariablesEvents(); }
            });
            return '<div class="jarvis-vars-root"><div class="jarvis-loading" style="padding:20px;color:#64748b">Loading variable catalog…</div></div>';
        }
        setTimeout(bindVariablesEvents, 50);
        return `<div class="jarvis-vars-root">${renderVariablesContent()}</div>`;
    }

    function renderVariablesContent() {
        const sectionHdr = text => `<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px;margin-top:12px">${text}</div>`;
        const allVars = (variablesKnown && variablesKnown.variables) || [];
        const search = (variablesSearch || '').trim().toLowerCase();
        const sourceCounts = {};
        for (const v of allVars) { const s = v.source || 'unknown'; sourceCounts[s] = (sourceCounts[s] || 0) + 1; }

        let filtered = allVars;
        if (variablesFilter && variablesFilter !== 'all') {
            filtered = filtered.filter(v => (v.source || 'unknown') === variablesFilter);
        }
        if (search) {
            filtered = filtered.filter(v => {
                const hay = `${v.key || ''} ${v.label || ''} ${v.description || ''} ${v.quantification || ''} ${v.modality || ''}`.toLowerCase();
                return hay.includes(search);
            });
        }
        // Cap displayed rows so the DOM stays snappy; user can search to narrow.
        const cap = 400;
        const overflow = Math.max(0, filtered.length - cap);
        filtered = filtered.slice(0, cap);

        const filterPills = ['all', ...Object.keys(sourceCounts).sort()].map(src => {
            const active = variablesFilter === src;
            const count = src === 'all' ? allVars.length : (sourceCounts[src] || 0);
            return `<button class="jarvis-vars-filter" data-src-filter="${src}" style="
                background:${active ? '#22d3ee22' : 'rgba(15,23,42,0.6)'};
                color:${active ? '#22d3ee' : '#94a3b8'};
                border:1px solid ${active ? '#22d3ee' : '#1e293b'};
                padding:3px 8px;font-size:10px;border-radius:999px;cursor:pointer;margin-right:4px;margin-bottom:4px;
                text-transform:uppercase;letter-spacing:0.05em">
                ${src.replace(/_/g,' ')} <span style="color:#64748b">${count}</span>
            </button>`;
        }).join('');

        const rows = filtered.map(v => {
            const selected = variablesSelectedKey === v.key;
            return `<div class="jarvis-vars-row" data-var-key="${escapeHtml(v.key)}" style="
                display:flex;gap:8px;align-items:center;padding:5px 10px;border-radius:6px;cursor:pointer;
                background:${selected ? '#1e293b' : '#0a1628'};border-left:3px solid ${selected ? '#22d3ee' : 'transparent'}">
                <code style="font-size:11px;color:#22d3ee;flex:0 0 auto;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(v.key)}</code>
                <span style="flex:1;font-size:11px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(v.label || '')}</span>
                <span style="font-size:9px;padding:1px 6px;border-radius:3px;background:#1e293b;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;flex-shrink:0">${escapeHtml((v.source || 'unknown').replace(/_/g,' '))}</span>
            </div>`;
        }).join('');

        // Selected detail
        let selectedHtml = '';
        if (variablesSelectedKey) {
            const def = (allVars.find(v => v.key === variablesSelectedKey))
                || lookupVariableDefinition(variablesSelectedKey);
            if (def) {
                selectedHtml = `<div style="margin-bottom:12px">
                    <button id="jarvis-vars-back-btn" style="background:none;border:1px solid #334155;color:#94a3b8;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-bottom:8px">&larr; Back to list</button>
                    ${renderVariableDefinitionRow(def, { accent: '#22d3ee' })}
                </div>`;
            }
        }

        // Phrase-family & pattern reference sections
        const families = (variablesCatalog && variablesCatalog.phrase_families) || [];
        const quants = (variablesCatalog && variablesCatalog.quantification_styles) || [];

        const familyHtml = families.map(f => {
            const examples = (f.examples || []).slice(0, 6).map(p => `<code style="background:#1e293b;color:#fbbf24;padding:1px 5px;border-radius:3px;font-size:10px;margin:1px">${escapeHtml(p)}</code>`).join(' ');
            return `<div style="background:#0a1628;border-radius:6px;padding:6px 10px;margin-bottom:4px;font-size:11px;border-left:3px solid #fbbf24">
                <div style="display:flex;gap:6px;align-items:baseline;flex-wrap:wrap">
                    <code style="color:#fbbf24;font-weight:700">${escapeHtml(f.const_name)}</code>
                    <span style="color:#94a3b8">&mdash; ${escapeHtml(f.signal || '')}</span>
                    <span style="color:#64748b;font-size:9px">key stem: <code>${escapeHtml(f.key_stem || f.family)}</code></span>
                </div>
                <div style="color:#cbd5e1;margin-top:2px;line-height:1.4">${escapeHtml(f.description || '')}</div>
                <div style="margin-top:4px">${examples}</div>
            </div>`;
        }).join('');

        const quantHtml = quants.map(q => `<div style="background:#0a1628;border-radius:6px;padding:6px 10px;margin-bottom:4px;font-size:11px;border-left:3px solid #a78bfa">
            <div><code style="color:#a78bfa;font-weight:700">${escapeHtml(q.style)}</code> <span style="color:#64748b">${escapeHtml(q.suffix_pattern)}</span></div>
            <div style="color:#cbd5e1;margin-top:2px">${escapeHtml(typeof q.description === 'string' ? q.description : '')}</div>
            ${q.formula ? `<div style="margin-top:2px;font-size:10px"><span style="color:#64748b">Formula: </span><code style="color:#22d3ee">${escapeHtml(q.formula)}</code></div>` : ''}
            ${q.modality ? `<div style="margin-top:2px;font-size:10px"><span style="color:#64748b">Modality: </span>${escapeHtml(q.modality)}</div>` : ''}
        </div>`).join('');

        return `
            <div style="font-size:14px;font-weight:700;color:#f1f5f9;margin-bottom:6px">
                Variables <span style="font-weight:400;color:#64748b;font-size:12px">(${allVars.length} tracked &mdash; ${families.length} phrase families &middot; ${quants.length} quantification styles)</span>
            </div>
            <div style="color:#64748b;font-size:11px;margin-bottom:10px;line-height:1.5">
                Every metric key Jarvis can cite, with a plain-English description and the exact measurement it maps to. Search by key, label, or modality.
            </div>

            ${selectedHtml}

            <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
                <input type="text" id="jarvis-vars-search" placeholder="Search variables (e.g. proof_of_work, retention, interaction…)" value="${escapeHtml(variablesSearch)}" style="
                    flex:1;min-width:240px;background:#0a1628;border:1px solid #1e293b;color:#f1f5f9;
                    padding:6px 10px;border-radius:6px;font-size:12px;outline:none" />
            </div>
            <div style="margin-bottom:8px">${filterPills}</div>

            ${sectionHdr(`Variables (${filtered.length}${overflow ? ' shown, ' + overflow + ' more hidden — narrow search' : ''})`)}
            <div style="display:flex;flex-direction:column;gap:3px;max-height:360px;overflow-y:auto;border-radius:6px;border:1px solid #1e293b;background:#05080f;padding:4px">
                ${rows || '<div style="padding:12px;color:#64748b;font-size:11px;text-align:center">No variables match.</div>'}
            </div>

            ${sectionHdr('Phrase Families')}
            <div style="color:#64748b;font-size:10px;margin-bottom:6px">Each family is a list of surface-form phrases; metric keys like <code>proof_of_work_count</code>, <code>proof_of_work_density_hook</code>, <code>proof_of_work_front_load_ratio</code> all reference the same underlying family.</div>
            ${familyHtml}

            ${sectionHdr('Quantification Styles')}
            <div style="color:#64748b;font-size:10px;margin-bottom:6px">Applied to a phrase family via a key suffix. Combine any family with any style to produce a metric key.</div>
            ${quantHtml}
        `;
    }

    function bindVariablesEvents() {
        const searchEl = container?.querySelector('#jarvis-vars-search');
        if (searchEl) {
            searchEl.addEventListener('input', (e) => {
                variablesSearch = e.target.value || '';
                const el = container?.querySelector('.jarvis-vars-root');
                if (el) {
                    el.innerHTML = renderVariablesContent();
                    bindVariablesEvents();
                    const s2 = container?.querySelector('#jarvis-vars-search');
                    if (s2) { s2.focus(); s2.setSelectionRange(variablesSearch.length, variablesSearch.length); }
                }
            });
        }
        container?.querySelectorAll('.jarvis-vars-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                variablesFilter = btn.dataset.srcFilter;
                const el = container?.querySelector('.jarvis-vars-root');
                if (el) { el.innerHTML = renderVariablesContent(); bindVariablesEvents(); }
            });
        });
        container?.querySelectorAll('.jarvis-vars-row').forEach(row => {
            row.addEventListener('click', () => {
                variablesSelectedKey = row.dataset.varKey;
                const el = container?.querySelector('.jarvis-vars-root');
                if (el) { el.innerHTML = renderVariablesContent(); bindVariablesEvents(); }
            });
        });
        const back = container?.querySelector('#jarvis-vars-back-btn');
        if (back) {
            back.addEventListener('click', () => {
                variablesSelectedKey = null;
                const el = container?.querySelector('.jarvis-vars-root');
                if (el) { el.innerHTML = renderVariablesContent(); bindVariablesEvents(); }
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

        // Group by experiment track
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

        // Experiment track explanation cards
        const explanationCards = [
            { cat: 'exp', color: '#3b82f6', title: 'Model Experiments', text: 'These are experiments that tested whether adding a new signal improves the prediction model. The model predicts how many views a video will get. Each experiment adds one new signal, trains the model, and measures the R\u00b2 improvement on a held-out test set. KEPT means it improved predictions. DISCARDED means it added noise or was circular.' },
            { cat: 'loop_b', color: '#f97316', title: 'Signal Discoveries', text: 'These are observations from the data \u2014 things that correlate with views or keep rate. They are NOT yet validated by the prediction model. Think of them as hypotheses: interesting patterns found by exploring the 203-video dataset. Many correlate individually but fail when added to the full model because they\'re already captured by something else.' },
            { cat: 'loop_c', color: '#06b6d4', title: 'Causal Tree', text: 'These measure what causes the intermediate metrics (keep rate, retention) rather than views directly. The goal: find what you can control BEFORE shooting that will cause good keep rate and retention. Measured against keep/retention as the target, not log(views).' },
            { cat: 'loop_d', color: '#a78bfa', title: 'Retention Mapping', text: 'These analyze the second-by-second retention curve aligned with what\'s being said and shown at each moment. What words cause retention gains? What visual types cause drops? The goal: find specific techniques that move the retention needle at specific timestamps.' },
        ];

        let html = '';

        // Collapsible explanation section
        html += `<div class="jarvis-exp-explain-toggle" id="jarvis-exp-explain-toggle">
            <span>${expExplainOpen ? '▼' : '▶'}</span> What do these experiment tracks mean?
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
                <div style="font-size:12px;color:#64748b;line-height:1.5">Autonomous indicator discovery. The candidate pool is generated deterministically, then every downstream step is deterministic: canonicalize, validate, extract, correlate, graph.</div>
            </div>

            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
                <div style="background:#0a1628;border-radius:8px;padding:12px 16px;flex:1;min-width:100px;text-align:center">
                    <div style="font-size:24px;font-weight:700;color:#22d3ee">${indicators.length}</div>
                    <div style="font-size:11px;color:#64748b">Completed</div>
                </div>
                <div style="background:#0a1628;border-radius:8px;padding:12px 16px;flex:1;min-width:100px;text-align:center">
                    <div style="font-size:24px;font-weight:700;color:#a78bfa">100+</div>
                    <div style="font-size:11px;color:#64748b">Candidate Space</div>
                    <div style="font-size:9px;color:#475569;margin-top:2px">(deterministic candidate generation)</div>
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
                <div style="margin-top:6px;font-size:10px;color:#475569">Deterministic candidate generation feeds a deterministic validation, extraction, correlation, and graph pipeline.</div>
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
    // TAB: META-ARCHITECTURE — Reference framework doc
    // ══════════════════════════════════════════════════
    let metaArchMarkdown = null;
    let metaArchError = null;

    function renderMetaArchitecture() {
        if (metaArchMarkdown == null && !metaArchError) {
            fetch('./buildings/jarvis/JARVIS_META_ARCHITECTURE.md', { cache: 'no-cache' })
                .then(r => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.text();
                })
                .then(txt => {
                    metaArchMarkdown = txt;
                    const root = container?.querySelector('.jarvis-meta-arch-root');
                    if (root) root.innerHTML = renderMetaArchitectureBody();
                })
                .catch(err => {
                    metaArchError = err.message || String(err);
                    const root = container?.querySelector('.jarvis-meta-arch-root');
                    if (root) root.innerHTML = renderMetaArchitectureBody();
                });
            return `<div class="jarvis-meta-arch-root"><div class="jarvis-loading" style="padding:24px;color:#64748b;font-size:12px">Loading meta-architecture…</div></div>`;
        }
        return `<div class="jarvis-meta-arch-root">${renderMetaArchitectureBody()}</div>`;
    }

    function renderMetaArchitectureBody() {
        if (metaArchError) {
            return `<div style="padding:24px;color:#f87171;font-size:12px">Failed to load meta-architecture document: ${escapeHtml(metaArchError)}</div>`;
        }
        if (!metaArchMarkdown) {
            return `<div class="jarvis-loading" style="padding:24px;color:#64748b;font-size:12px">Loading…</div>`;
        }
        return `
            <div class="jarvis-meta-arch-banner">
                <div class="jarvis-meta-arch-eyebrow">Reference</div>
                <div class="jarvis-meta-arch-banner-title">Jarvis Meta-Architecture</div>
                <div class="jarvis-meta-arch-banner-sub">The framework Jarvis is being built around. Layers, the discovery loop, and the rules that keep categorization emergent.</div>
            </div>
            <article class="jarvis-meta-arch-doc">${renderMarkdown(metaArchMarkdown)}</article>
        `;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Minimal markdown renderer — handles headings, lists, blockquotes,
    // fenced code, inline code, bold, italics, paragraphs, hr, links.
    // Intentionally small; the architecture doc is the primary consumer.
    function renderMarkdown(md) {
        const lines = md.replace(/\r\n/g, '\n').split('\n');
        const out = [];
        let i = 0;
        const flushPara = (buf) => {
            if (buf.length) {
                out.push('<p>' + renderInline(buf.join(' ').trim()) + '</p>');
                buf.length = 0;
            }
        };
        let para = [];
        while (i < lines.length) {
            const line = lines[i];

            // Fenced code block
            if (/^```/.test(line)) {
                flushPara(para);
                const code = [];
                i++;
                while (i < lines.length && !/^```/.test(lines[i])) {
                    code.push(lines[i]);
                    i++;
                }
                i++; // skip closing fence
                out.push('<pre class="jarvis-md-pre"><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
                continue;
            }

            // Horizontal rule
            if (/^---+\s*$/.test(line)) {
                flushPara(para);
                out.push('<hr class="jarvis-md-hr"/>');
                i++;
                continue;
            }

            // Heading
            const h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                flushPara(para);
                const level = h[1].length;
                out.push(`<h${level} class="jarvis-md-h${level}">${renderInline(h[2])}</h${level}>`);
                i++;
                continue;
            }

            // Blockquote
            if (/^>\s?/.test(line)) {
                flushPara(para);
                const block = [];
                while (i < lines.length && /^>\s?/.test(lines[i])) {
                    block.push(lines[i].replace(/^>\s?/, ''));
                    i++;
                }
                out.push('<blockquote class="jarvis-md-quote">' + renderInline(block.join(' ')) + '</blockquote>');
                continue;
            }

            // Unordered list
            if (/^[-*]\s+/.test(line)) {
                flushPara(para);
                const items = [];
                while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
                    let item = lines[i].replace(/^[-*]\s+/, '');
                    i++;
                    // Continuation lines (indented)
                    while (i < lines.length && /^ {2,}\S/.test(lines[i])) {
                        item += ' ' + lines[i].trim();
                        i++;
                    }
                    items.push('<li>' + renderInline(item) + '</li>');
                }
                out.push('<ul class="jarvis-md-ul">' + items.join('') + '</ul>');
                continue;
            }

            // Ordered list
            if (/^\d+\.\s+/.test(line)) {
                flushPara(para);
                const items = [];
                while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
                    let item = lines[i].replace(/^\d+\.\s+/, '');
                    i++;
                    while (i < lines.length && /^ {2,}\S/.test(lines[i])) {
                        item += ' ' + lines[i].trim();
                        i++;
                    }
                    items.push('<li>' + renderInline(item) + '</li>');
                }
                out.push('<ol class="jarvis-md-ol">' + items.join('') + '</ol>');
                continue;
            }

            // Blank line — paragraph break
            if (/^\s*$/.test(line)) {
                flushPara(para);
                i++;
                continue;
            }

            // Default: paragraph line
            para.push(line);
            i++;
        }
        flushPara(para);
        return out.join('\n');
    }

    function renderInline(text) {
        let s = escapeHtml(text);
        // Inline code first so its contents aren't further transformed
        s = s.replace(/`([^`]+)`/g, '<code class="jarvis-md-code">$1</code>');
        // Bold (** or __)
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        // Italics (* or _) — single, not adjacent to word boundary inside code already handled
        s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
        s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
        // Links [text](url)
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
        return s;
    }

    // ══════════════════════════════════════════════════
    // TAB: KNOWLEDGE — Mechanisms · Components · Principles · Bridges · Research
    // Reads overnight_build artifacts (mechanisms.json, components.json,
    // principles.json, bridge_validation.json, bridge_top_principles.json,
    // principle_gaps.json, research_questions.json, research_answers.json,
    // overnight_status.json) via /api/jarvis/knowledge/<name>.
    // ══════════════════════════════════════════════════
    let knowledgeSubTab = 'overview';
    let knowledgeData = {};      // key -> parsed payload
    let knowledgeLoading = {};   // key -> bool
    let knowledgeError = {};     // key -> message
    let knowledgeSearch = { mechanisms: '', principles: '', components: '', bridges: '', research: '' };
    let knowledgeSort = { mechanisms: 'n_videos_desc', principles: 'chain_strength_desc', components: 'n_mechanisms_desc', bridges: 'chain_strength_desc' };
    let knowledgeFilter = { mechanisms: 'all', principles: 'all', components: 'all', bridges: 'all', research: 'all' };
    let knowledgeExpanded = { mechanism: null, principle: null, component: null, bridge: null, question: null };
    let knowledgeListLimit = { mechanisms: 200, principles: 400, components: 100, bridges: 400 };
    let knowledgeGraphFocus = null; // { type: 'mechanism'|'principle'|'component', id }

    const KNOWLEDGE_SUB_TABS = [
        { id: 'overview', label: 'Overview' },
        { id: 'mechanisms', label: 'Mechanisms' },
        { id: 'components', label: 'Components' },
        { id: 'principles', label: 'Principles' },
        { id: 'bridges', label: 'Bridges' },
        { id: 'research', label: 'Research' },
        { id: 'graph', label: 'Graph' },
    ];

    // Keys mirror server.js KNOWLEDGE_FILES mapping
    const KNOWLEDGE_ENDPOINTS = {
        overview: 'overview',
        mechanisms: 'mechanisms',
        mechanism_components: 'mechanism-components',
        components: 'components',
        principles: 'principles',
        principle_gaps: 'principle-gaps',
        bridge_validation: 'bridge-validation',
        bridge_top: 'bridge-top-principles',
        research_questions: 'research-questions',
        research_answers: 'research-answers',
        overnight_status: 'overnight-status',
    };

    async function loadKnowledge(key, force = false) {
        if (!force && knowledgeData[key]) return knowledgeData[key];
        if (knowledgeLoading[key]) return null;
        const endpoint = KNOWLEDGE_ENDPOINTS[key];
        if (!endpoint) return null;
        knowledgeLoading[key] = true;
        knowledgeError[key] = null;
        try {
            const res = await fetch('/api/jarvis/knowledge/' + endpoint);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const json = await res.json();
            knowledgeData[key] = json;
            return json;
        } catch (e) {
            knowledgeError[key] = e.message || String(e);
            return null;
        } finally {
            knowledgeLoading[key] = false;
        }
    }

    function refreshKnowledgeRoot() {
        const root = container?.querySelector('.jarvis-knowledge-root');
        if (root) {
            root.innerHTML = renderKnowledgeBody();
            bindKnowledgeEvents();
        }
    }

    function renderKnowledge() {
        // Always fetch the data needed for the current sub-tab
        ensureKnowledgeDataForSubTab(knowledgeSubTab);
        setTimeout(bindKnowledgeEvents, 30);
        return `<div class="jarvis-knowledge-root">${renderKnowledgeBody()}</div>`;
    }

    function ensureKnowledgeDataForSubTab(sub) {
        const need = {
            overview: ['overview'],
            mechanisms: ['mechanisms', 'mechanism_components'],
            components: ['components'],
            principles: ['principles', 'bridge_validation'],
            bridges: ['bridge_validation', 'bridge_top', 'principles'],
            research: ['research_questions', 'research_answers', 'principle_gaps'],
            graph: ['mechanisms', 'components', 'principles', 'mechanism_components', 'bridge_validation'],
        }[sub] || [];
        let pending = 0;
        need.forEach(k => {
            if (!knowledgeData[k] && !knowledgeLoading[k]) {
                pending++;
                loadKnowledge(k).then(() => {
                    pending--;
                    if (pending === 0) refreshKnowledgeRoot();
                    else refreshKnowledgeRoot(); // partial refresh so spinners flip
                });
            }
        });
    }

    function fmtNum(n) {
        if (n == null || isNaN(n)) return '—';
        if (Math.abs(n) >= 1000) return n.toLocaleString();
        if (Math.abs(n) >= 1) return (+n).toFixed(2).replace(/\.?0+$/, '');
        return (+n).toFixed(4).replace(/\.?0+$/, '');
    }
    function fmtSigned(n) {
        if (n == null || isNaN(n)) return '—';
        const s = (+n).toFixed(4).replace(/\.?0+$/, '') || '0';
        return (n > 0 ? '+' : '') + s;
    }
    function fmtPct(n) {
        if (n == null || isNaN(n)) return '—';
        return (n * 100).toFixed(1) + '%';
    }
    function fmtDate(iso) {
        if (!iso) return '—';
        try {
            const d = new Date(iso);
            return d.toLocaleString();
        } catch { return iso; }
    }

    function rColor(r) {
        if (r == null || isNaN(r)) return '#64748b';
        if (r >= 0) return '#22d3ee';
        return '#f87171';
    }

    function renderKnowledgeBody() {
        const subTabs = KNOWLEDGE_SUB_TABS.map(t =>
            `<button class="jarvis-knowledge-subtab${knowledgeSubTab === t.id ? ' active' : ''}" data-sub="${t.id}">${t.label}</button>`
        ).join('');
        let body = '';
        switch (knowledgeSubTab) {
            case 'overview': body = renderKnowledgeOverview(); break;
            case 'mechanisms': body = renderKnowledgeMechanisms(); break;
            case 'components': body = renderKnowledgeComponents(); break;
            case 'principles': body = renderKnowledgePrinciples(); break;
            case 'bridges': body = renderKnowledgeBridges(); break;
            case 'research': body = renderKnowledgeResearch(); break;
            case 'graph': body = renderKnowledgeGraph(); break;
        }
        return `
            <div style="margin-bottom:10px">
                <div style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:3px">Knowledge — Overnight Build Artifacts</div>
                <div style="font-size:12px;color:#64748b;line-height:1.5">Mechanisms, components, principles, bridge validation and research questions that the overnight Jarvis pipeline produced from the video pool.</div>
            </div>
            <div class="jarvis-knowledge-subtabs" style="display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--j-border, rgba(59,130,246,0.15));margin-bottom:12px;padding-bottom:6px">
                ${subTabs}
            </div>
            <div class="jarvis-knowledge-panel">${body}</div>
        `;
    }

    // ── Overview ─────────────────────────────────────────
    function renderKnowledgeOverview() {
        const o = knowledgeData.overview;
        if (knowledgeError.overview) return loadingBox('Overview failed: ' + knowledgeError.overview, true);
        if (!o) return loadingBox('Loading overnight artifacts overview…');
        const c = o.counts || {};
        const on = o.overnight || {};
        const thresholds = o.thresholds || {};
        const gen = o.generated_at || {};
        const pillColor = (status) => status === 'completed' ? '#22c55e' : status === 'running' ? '#f59e0b' : status === 'failed' ? '#f87171' : '#64748b';
        const card = (label, value, sub, color) => `
            <div style="background:#0a1628;border-radius:8px;padding:12px 14px;flex:1;min-width:140px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">${label}</div>
                <div style="font-size:22px;font-weight:700;color:${color || '#f1f5f9'}">${value}</div>
                ${sub ? `<div style="font-size:10px;color:#64748b;margin-top:4px">${sub}</div>` : ''}
            </div>`;
        return `
            <div style="background:#0a1628;border-radius:10px;padding:14px;margin-bottom:16px;border:1px solid ${pillColor(on.overall_status)}33">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${pillColor(on.overall_status)}"></span>
                    <span style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b">Overnight Build Status</span>
                    <span style="font-size:13px;font-weight:700;color:${pillColor(on.overall_status)}">${(on.overall_status || 'unknown').toUpperCase()}</span>
                    ${on.current_phase ? `<span style="font-size:11px;color:#94a3b8">· phase ${escapeHtml(on.current_phase)}</span>` : ''}
                </div>
                <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:11px;color:#94a3b8">
                    <span>Started: <b style="color:#cbd5e1">${fmtDate(on.started_at)}</b></span>
                    <span>Finished: <b style="color:#cbd5e1">${fmtDate(on.finished_at)}</b></span>
                    <span>Updated: <b style="color:#cbd5e1">${fmtDate(on.updated_at)}</b></span>
                    ${on.failed_phase ? `<span>Failed: <b style="color:#f87171">${escapeHtml(on.failed_phase)}</b></span>` : ''}
                </div>
                ${Array.isArray(on.completed_phases) && on.completed_phases.length ? `
                    <div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">
                        ${on.completed_phases.map(p => `<span style="background:#1e293b;border-radius:4px;padding:2px 8px;font-size:10px;color:#22c55e">✓ ${escapeHtml(p)}</span>`).join('')}
                    </div>
                ` : ''}
                ${on.failure_reason ? `<div style="margin-top:8px;font-size:11px;color:#f87171">Failure: ${escapeHtml(on.failure_reason)}</div>` : ''}
                ${Array.isArray(on.notes) && on.notes.length ? `
                    <div style="margin-top:8px;font-size:10px;color:#64748b;line-height:1.5">
                        ${on.notes.map(n => `<div>• ${escapeHtml(String(n))}</div>`).join('')}
                    </div>
                ` : ''}
            </div>

            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
                ${card('Mechanisms', (c.mechanisms || 0).toLocaleString(), c.n_videos_pool ? `from ${c.n_videos_pool} videos` : '', '#22d3ee')}
                ${card('Components', (c.components || 0).toLocaleString(), 'recurring fragments', '#06b6d4')}
                ${card('Principles', (c.principles || 0).toLocaleString(), c.principles_dropped_tautological ? `${c.principles_dropped_tautological} dropped tautological` : '', '#a78bfa')}
                ${card('Bridge rows', (c.bridge_rows || 0).toLocaleString(), `${c.bridge_n_chains_both_legs_nonzero || 0} with both legs`, '#f59e0b')}
                ${card('Top principles', (c.bridge_top || 0).toLocaleString(), 'ranked by |chain|×IDF', '#facc15')}
                ${card('Principle gaps', (c.principle_gaps || 0).toLocaleString(), 'mechs under threshold', '#ef4444')}
                ${card('Research Q', (c.research_questions || 0).toLocaleString(), `${c.research_answers || 0} answered`, '#ec4899')}
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:16px">
                <div style="background:#0a1628;border-radius:8px;padding:12px 14px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Ranking · Thresholds</div>
                    <div style="font-size:11px;color:#cbd5e1;margin-bottom:4px"><b>Ranking:</b> ${escapeHtml(o.ranking || '—')}</div>
                    ${thresholds.min_mech_observations != null ? `<div style="font-size:11px;color:#cbd5e1;margin-bottom:2px">min mech observations: <b>${thresholds.min_mech_observations}</b></div>` : ''}
                    ${thresholds.min_abs_rho != null ? `<div style="font-size:11px;color:#cbd5e1;margin-bottom:2px">min |ρ|: <b>${thresholds.min_abs_rho}</b></div>` : ''}
                </div>
                <div style="background:#0a1628;border-radius:8px;padding:12px 14px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Artifacts Generated</div>
                    <div style="font-size:11px;color:#cbd5e1">mechanisms · ${fmtDate(gen.mechanisms)}</div>
                    <div style="font-size:11px;color:#cbd5e1">components · ${fmtDate(gen.components)}</div>
                    <div style="font-size:11px;color:#cbd5e1">principles · ${fmtDate(gen.principles)}</div>
                    <div style="font-size:11px;color:#cbd5e1">bridge · ${fmtDate(gen.bridge)}</div>
                    <div style="font-size:11px;color:#cbd5e1">bridge_top · ${fmtDate(gen.bridge_top)}</div>
                </div>
            </div>

            <div style="background:#0a1628;border-radius:8px;padding:12px 14px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Pipeline Phases</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                    ${['phase_1_init','phase_2_mechanisms','phase_3_components','phase_4_principles','phase_5_bridge','phase_6_persist'].map(p => {
                        const done = (on.completed_phases || []).includes(p);
                        const failed = on.failed_phase === p;
                        const color = done ? '#22c55e' : failed ? '#f87171' : '#64748b';
                        const icon = done ? '✓' : failed ? '✗' : '○';
                        return `<span style="background:#1e293b;border:1px solid ${color}44;border-radius:5px;padding:4px 10px;font-size:11px;color:${color}"><b>${icon}</b> ${escapeHtml(p.replace('phase_',''))}</span>`;
                    }).join('')}
                </div>
            </div>
        `;
    }

    function loadingBox(msg, isError = false) {
        return `<div style="padding:32px;text-align:center;color:${isError ? '#f87171' : '#64748b'};font-size:12px">${escapeHtml(msg)}</div>`;
    }

    // ── Mechanisms ───────────────────────────────────────
    function renderKnowledgeMechanisms() {
        const mData = knowledgeData.mechanisms;
        if (knowledgeError.mechanisms) return loadingBox('Failed to load mechanisms: ' + knowledgeError.mechanisms, true);
        if (!mData) return loadingBox('Loading mechanisms…');
        const mcData = knowledgeData.mechanism_components || { mechanism_components: {} };
        const allMechs = Array.isArray(mData.mechanisms) ? mData.mechanisms : [];

        const q = (knowledgeSearch.mechanisms || '').trim().toLowerCase();
        const filter = knowledgeFilter.mechanisms;
        let list = allMechs.filter(m => {
            if (q && !((m.id||'').toLowerCase().includes(q) || (m.label||'').toLowerCase().includes(q) || (m.rough_description||'').toLowerCase().includes(q))) return false;
            if (filter === 'compound' && m.source_family !== 'compound') return false;
            if (filter === 'single' && m.source_family === 'compound') return false;
            if (filter === 'high-prev' && (m.prevalence_ratio || 0) < 0.5) return false;
            if (filter === 'low-prev' && (m.prevalence_ratio || 0) > 0.1) return false;
            return true;
        });

        const sort = knowledgeSort.mechanisms;
        list.sort((a, b) => {
            switch (sort) {
                case 'n_videos_desc': return (b.n_videos||0) - (a.n_videos||0);
                case 'n_videos_asc': return (a.n_videos||0) - (b.n_videos||0);
                case 'n_obs_desc': return (b.n_observations||0) - (a.n_observations||0);
                case 'prev_desc': return (b.prevalence_ratio||0) - (a.prevalence_ratio||0);
                case 'specificity_desc': return (b.specificity_idf||0) - (a.specificity_idf||0);
                case 'label_asc': return (a.label||'').localeCompare(b.label||'');
                default: return 0;
            }
        });

        const limit = knowledgeListLimit.mechanisms;
        const shown = list.slice(0, limit);

        const positionBuckets = new Set();
        allMechs.forEach(m => m.position_bucket && positionBuckets.add(m.position_bucket));

        const sortOpts = [
            ['n_videos_desc','Videos ↓'],
            ['n_videos_asc','Videos ↑'],
            ['n_obs_desc','Observations ↓'],
            ['prev_desc','Prevalence ↓'],
            ['specificity_desc','Specificity (IDF) ↓'],
            ['label_asc','Label A→Z'],
        ];
        const filterOpts = [
            ['all','All'],
            ['compound','Compound only'],
            ['single','Single-kind only'],
            ['high-prev','Prevalence ≥ 0.5'],
            ['low-prev','Prevalence ≤ 0.1'],
        ];

        return `
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
                <input id="knowledge-mech-search" type="text" value="${escapeHtml(knowledgeSearch.mechanisms)}" placeholder="Search id, label, description…" style="flex:1;min-width:220px;background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 10px;font-size:12px;color:#e2e8f0" />
                <select id="knowledge-mech-sort" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    ${sortOpts.map(([v,l]) => `<option value="${v}"${sort===v?' selected':''}>${l}</option>`).join('')}
                </select>
                <select id="knowledge-mech-filter" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    ${filterOpts.map(([v,l]) => `<option value="${v}"${filter===v?' selected':''}>${l}</option>`).join('')}
                </select>
            </div>
            <div style="font-size:11px;color:#64748b;margin-bottom:8px">${list.length.toLocaleString()} match · showing first ${Math.min(shown.length, list.length).toLocaleString()}${list.length > limit ? ` · <button id="knowledge-mech-more" class="knowledge-more-btn" style="background:#1e293b;border:1px solid #334155;color:#cbd5e1;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:11px">Show 200 more</button>` : ''}</div>
            <div style="border-radius:8px;overflow:hidden;border:1px solid #1e293b">
                <table style="width:100%;border-collapse:collapse">
                    <thead><tr style="background:#1e293b">
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Mechanism</th>
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Family</th>
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Position</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Videos</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Obs</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Prev</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">IDF</th>
                    </tr></thead>
                    <tbody>
                        ${shown.map(m => renderMechanismRow(m, mcData.mechanism_components || {})).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderMechanismRow(m, mcMap) {
        const expanded = knowledgeExpanded.mechanism === m.id;
        const kinds = Array.isArray(m.source_kinds) ? m.source_kinds.join(',') : (m.source_kinds || '');
        let detailHtml = '';
        if (expanded) {
            const comps = mcMap[m.id] || [];
            const evs = Array.isArray(m.sample_evidence) ? m.sample_evidence.slice(0, 12) : [];
            detailHtml = `
                <tr data-mech-detail-row="${escapeHtml(m.id)}" style="background:#0a1628;border-bottom:1px solid #1e293b">
                    <td colspan="7" style="padding:10px 14px">
                        <div style="font-size:11px;color:#cbd5e1;margin-bottom:6px;line-height:1.5">${escapeHtml(m.rough_description || '')}</div>
                        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:#94a3b8">
                            <span>source_kinds: <b style="color:#cbd5e1">${escapeHtml(kinds)}</b></span>
                            <span>emergence: <b style="color:#cbd5e1">${escapeHtml(m.emergence_method || '—')}</b></span>
                            <span>components: <b style="color:#06b6d4">${comps.length}</b></span>
                        </div>
                        ${comps.length ? `<div style="margin-bottom:8px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:3px">Components</div>
                            <div style="display:flex;gap:4px;flex-wrap:wrap">${comps.map(c => `<span style="background:#1e293b;border-radius:4px;padding:2px 8px;font-size:10px;color:#06b6d4;font-family:'SF Mono',monospace">${escapeHtml(c)}</span>`).join('')}</div></div>` : ''}
                        ${evs.length ? `<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:3px">Sample Evidence (${Math.min(12, m.sample_evidence.length)}/${m.sample_evidence.length})</div>
                            <div style="max-height:240px;overflow:auto;border:1px solid #1e293b;border-radius:6px">
                                <table style="width:100%;border-collapse:collapse;font-size:10px">
                                    <thead><tr style="background:#1e293b"><th style="padding:3px 8px;text-align:left;color:#64748b">Video</th><th style="padding:3px 8px;text-align:left;color:#64748b">Kind</th><th style="padding:3px 8px;text-align:left;color:#64748b">Text</th><th style="padding:3px 8px;text-align:right;color:#64748b">t(s)</th><th style="padding:3px 8px;text-align:right;color:#64748b">%</th></tr></thead>
                                    <tbody>${evs.map(e => `<tr style="border-bottom:1px solid #1e293b"><td style="padding:3px 8px;font-family:'SF Mono',monospace;color:#94a3b8">${escapeHtml(e.video_id || '')}</td><td style="padding:3px 8px;color:#94a3b8">${escapeHtml(e.evidence_kind || '')}</td><td style="padding:3px 8px;color:#cbd5e1">${escapeHtml(e.evidence_text || '')}</td><td style="padding:3px 8px;text-align:right;color:#94a3b8">${e.position_s != null ? e.position_s.toFixed ? e.position_s.toFixed(1) : e.position_s : '—'}</td><td style="padding:3px 8px;text-align:right;color:#94a3b8">${e.position_pct != null ? e.position_pct.toFixed ? e.position_pct.toFixed(1) : e.position_pct : '—'}</td></tr>`).join('')}</tbody>
                                </table>
                            </div>
                        </div>` : '<div style="font-size:11px;color:#64748b;font-style:italic">No sample evidence.</div>'}
                        <div style="margin-top:8px"><button class="knowledge-graph-focus-btn" data-focus-type="mechanism" data-focus-id="${escapeHtml(m.id)}" style="background:#1e293b;border:1px solid #334155;color:#a78bfa;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">View in Graph →</button></div>
                    </td>
                </tr>`;
        }
        return `
            <tr data-mech-row="${escapeHtml(m.id)}" style="cursor:pointer;border-bottom:1px solid #1e293b">
                <td style="padding:5px 8px;font-size:11px;color:#cbd5e1">
                    <div style="font-weight:600;color:#e2e8f0">${escapeHtml(m.label || m.id)}</div>
                    <div style="font-size:10px;font-family:'SF Mono',monospace;color:#64748b">${escapeHtml(m.id)}</div>
                </td>
                <td style="padding:5px 8px;font-size:10px;color:${m.source_family === 'compound' ? '#a78bfa' : '#06b6d4'}">${escapeHtml(m.source_family || '—')}</td>
                <td style="padding:5px 8px;font-size:10px;color:#94a3b8">${escapeHtml(m.position_bucket || '—')}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#22d3ee;text-align:right">${m.n_videos || 0}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#94a3b8;text-align:right">${m.n_observations || 0}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#cbd5e1;text-align:right">${fmtNum(m.prevalence_ratio)}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#cbd5e1;text-align:right">${fmtNum(m.specificity_idf)}</td>
            </tr>
            ${detailHtml}
        `;
    }

    // ── Components ───────────────────────────────────────
    function renderKnowledgeComponents() {
        const cData = knowledgeData.components;
        if (knowledgeError.components) return loadingBox('Failed to load components: ' + knowledgeError.components, true);
        if (!cData) return loadingBox('Loading components…');
        const all = Array.isArray(cData.components) ? cData.components : [];
        const q = (knowledgeSearch.components || '').trim().toLowerCase();
        const filter = knowledgeFilter.components;
        let list = all.filter(c => {
            if (q && !((c.id||'').toLowerCase().includes(q) || (c.label||'').toLowerCase().includes(q) || (c.fragment_value||'').toLowerCase().includes(q))) return false;
            if (filter !== 'all' && c.fragment_kind !== filter) return false;
            return true;
        });
        const sort = knowledgeSort.components;
        list.sort((a, b) => {
            switch (sort) {
                case 'n_mechanisms_desc': return (b.n_mechanisms_using||0) - (a.n_mechanisms_using||0);
                case 'n_mechanisms_asc': return (a.n_mechanisms_using||0) - (b.n_mechanisms_using||0);
                case 'n_obs_desc': return (b.n_observations_total||0) - (a.n_observations_total||0);
                case 'label_asc': return (a.label||'').localeCompare(b.label||'');
                default: return 0;
            }
        });
        const kindCounts = {};
        all.forEach(c => { kindCounts[c.fragment_kind] = (kindCounts[c.fragment_kind] || 0) + 1; });
        const kinds = Object.keys(kindCounts).sort();
        const limit = knowledgeListLimit.components;
        const shown = list.slice(0, limit);

        return `
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Total components</div><div style="font-size:18px;font-weight:700;color:#06b6d4">${all.length.toLocaleString()}</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Coverage</div><div style="font-size:18px;font-weight:700;color:#22d3ee">${cData.coverage_pct || 0}%</div><div style="font-size:9px;color:#64748b">${cData.n_mechanisms_decomposed || 0} mechs decomposed</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Min recurrence</div><div style="font-size:18px;font-weight:700;color:#a78bfa">${cData.min_recurrence || 0}</div></div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
                <input id="knowledge-comp-search" type="text" value="${escapeHtml(knowledgeSearch.components)}" placeholder="Search id, label, fragment value…" style="flex:1;min-width:220px;background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 10px;font-size:12px;color:#e2e8f0" />
                <select id="knowledge-comp-sort" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    <option value="n_mechanisms_desc"${sort==='n_mechanisms_desc'?' selected':''}>Mechanisms ↓</option>
                    <option value="n_mechanisms_asc"${sort==='n_mechanisms_asc'?' selected':''}>Mechanisms ↑</option>
                    <option value="n_obs_desc"${sort==='n_obs_desc'?' selected':''}>Observations ↓</option>
                    <option value="label_asc"${sort==='label_asc'?' selected':''}>Label A→Z</option>
                </select>
                <select id="knowledge-comp-filter" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    <option value="all"${filter==='all'?' selected':''}>All kinds (${all.length})</option>
                    ${kinds.map(k => `<option value="${escapeHtml(k)}"${filter===k?' selected':''}>${escapeHtml(k)} (${kindCounts[k]})</option>`).join('')}
                </select>
            </div>
            <div style="font-size:11px;color:#64748b;margin-bottom:8px">${list.length} match · showing ${Math.min(shown.length, list.length)}</div>
            <div style="border-radius:8px;overflow:hidden;border:1px solid #1e293b">
                <table style="width:100%;border-collapse:collapse">
                    <thead><tr style="background:#1e293b">
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Component</th>
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Fragment Kind</th>
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Value</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Mechanisms</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Observations</th>
                    </tr></thead>
                    <tbody>
                        ${shown.map(c => renderComponentRow(c)).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderComponentRow(c) {
        const expanded = knowledgeExpanded.component === c.id;
        let detailHtml = '';
        if (expanded) {
            const mechs = Array.isArray(c.mechanism_ids) ? c.mechanism_ids.slice(0, 60) : [];
            detailHtml = `
                <tr data-comp-detail-row="${escapeHtml(c.id)}" style="background:#0a1628;border-bottom:1px solid #1e293b">
                    <td colspan="5" style="padding:10px 14px">
                        <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">First ${mechs.length} of ${(c.mechanism_ids || []).length} mechanisms using this component</div>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;max-height:220px;overflow:auto">
                            ${mechs.map(id => `<span class="knowledge-mech-jump" data-mech-id="${escapeHtml(id)}" style="background:#1e293b;border-radius:4px;padding:2px 8px;font-size:10px;color:#22d3ee;font-family:'SF Mono',monospace;cursor:pointer">${escapeHtml(id)}</span>`).join('')}
                        </div>
                        <div style="margin-top:8px"><button class="knowledge-graph-focus-btn" data-focus-type="component" data-focus-id="${escapeHtml(c.id)}" style="background:#1e293b;border:1px solid #334155;color:#a78bfa;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">View in Graph →</button></div>
                    </td>
                </tr>`;
        }
        return `
            <tr data-comp-row="${escapeHtml(c.id)}" style="cursor:pointer;border-bottom:1px solid #1e293b">
                <td style="padding:5px 8px;font-size:11px">
                    <div style="font-weight:600;color:#e2e8f0">${escapeHtml(c.label || c.id)}</div>
                    <div style="font-size:10px;font-family:'SF Mono',monospace;color:#64748b">${escapeHtml(c.id)}</div>
                </td>
                <td style="padding:5px 8px;font-size:10px;color:#06b6d4">${escapeHtml(c.fragment_kind || '—')}</td>
                <td style="padding:5px 8px;font-size:11px;color:#cbd5e1;font-family:'SF Mono',monospace">${escapeHtml(c.fragment_value || '—')}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#a78bfa;text-align:right">${c.n_mechanisms_using || 0}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#94a3b8;text-align:right">${c.n_observations_total || 0}</td>
            </tr>
            ${detailHtml}
        `;
    }

    // ── Principles ───────────────────────────────────────
    function renderKnowledgePrinciples() {
        const pData = knowledgeData.principles;
        if (knowledgeError.principles) return loadingBox('Failed to load principles: ' + knowledgeError.principles, true);
        if (!pData) return loadingBox('Loading principles…');
        const bv = knowledgeData.bridge_validation;
        const bvByPid = {};
        if (bv && Array.isArray(bv.rows)) bv.rows.forEach(r => { bvByPid[r.principle_id] = r; });
        const all = Array.isArray(pData.principles) ? pData.principles : [];

        const q = (knowledgeSearch.principles || '').trim().toLowerCase();
        const filter = knowledgeFilter.principles;
        let list = all.filter(p => {
            if (q && !JSON.stringify(p).toLowerCase().includes(q)) return false;
            if (filter === 'positive' && (p.chain_strength_signed || 0) <= 0) return false;
            if (filter === 'negative' && (p.chain_strength_signed || 0) >= 0) return false;
            if (filter === 'strong' && Math.abs(p.chain_strength_signed || 0) < 0.1) return false;
            return true;
        });

        const sort = knowledgeSort.principles;
        list.sort((a, b) => {
            switch (sort) {
                case 'chain_strength_desc': return Math.abs(b.chain_strength_signed || 0) - Math.abs(a.chain_strength_signed || 0);
                case 'weighted_desc': return Math.abs(b.chain_strength_specificity_weighted || 0) - Math.abs(a.chain_strength_specificity_weighted || 0);
                case 'rho_desc': return Math.abs(b.mechanism_indicator_rho || 0) - Math.abs(a.mechanism_indicator_rho || 0);
                case 'r_desc': return Math.abs(b.indicator_outcome_r || 0) - Math.abs(a.indicator_outcome_r || 0);
                case 'n_videos_desc': return (b.mechanism_n_videos || 0) - (a.mechanism_n_videos || 0);
                default: return 0;
            }
        });

        const limit = knowledgeListLimit.principles;
        const shown = list.slice(0, limit);

        return `
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Total</div><div style="font-size:18px;font-weight:700;color:#a78bfa">${(pData.n_principles || all.length).toLocaleString()}</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Dropped tautological</div><div style="font-size:18px;font-weight:700;color:#ef4444">${pData.n_dropped_tautological || 0}</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Dropped other</div><div style="font-size:18px;font-weight:700;color:#f87171">${pData.n_dropped || 0}</div></div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
                <input id="knowledge-prin-search" type="text" value="${escapeHtml(knowledgeSearch.principles)}" placeholder="Search mechanism, indicator, hypothesis…" style="flex:1;min-width:220px;background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 10px;font-size:12px;color:#e2e8f0" />
                <select id="knowledge-prin-sort" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    <option value="chain_strength_desc"${sort==='chain_strength_desc'?' selected':''}>|Chain strength| ↓</option>
                    <option value="weighted_desc"${sort==='weighted_desc'?' selected':''}>|Weighted (×IDF)| ↓</option>
                    <option value="rho_desc"${sort==='rho_desc'?' selected':''}>|ρ (mech→indicator)| ↓</option>
                    <option value="r_desc"${sort==='r_desc'?' selected':''}>|r (indicator→views)| ↓</option>
                    <option value="n_videos_desc"${sort==='n_videos_desc'?' selected':''}>Videos ↓</option>
                </select>
                <select id="knowledge-prin-filter" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    <option value="all"${filter==='all'?' selected':''}>All</option>
                    <option value="positive"${filter==='positive'?' selected':''}>Positive chain</option>
                    <option value="negative"${filter==='negative'?' selected':''}>Negative chain</option>
                    <option value="strong"${filter==='strong'?' selected':''}>|chain| ≥ 0.1</option>
                </select>
            </div>
            <div style="font-size:11px;color:#64748b;margin-bottom:8px">${list.length} match · showing ${Math.min(shown.length, list.length)}</div>
            <div style="border-radius:8px;overflow:hidden;border:1px solid #1e293b">
                <table style="width:100%;border-collapse:collapse">
                    <thead><tr style="background:#1e293b">
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">ID</th>
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Mechanism → Indicator → Outcome</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">ρ (mech→ind)</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">r (ind→views)</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Chain</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Weighted</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">N vids</th>
                    </tr></thead>
                    <tbody>
                        ${shown.map(p => renderPrincipleRow(p, bvByPid[p.id])).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderPrincipleRow(p, bv) {
        const expanded = knowledgeExpanded.principle === p.id;
        const edge = p.edge || {};
        let detailHtml = '';
        if (expanded) {
            detailHtml = `
                <tr data-prin-detail-row="${escapeHtml(p.id)}" style="background:#0a1628;border-bottom:1px solid #1e293b">
                    <td colspan="7" style="padding:10px 14px">
                        <div style="font-size:12px;color:#cbd5e1;line-height:1.6;margin-bottom:8px">${escapeHtml(p.hypothesis_text || '')}</div>
                        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#94a3b8;margin-bottom:8px">
                            <span>status: <b style="color:#cbd5e1">${escapeHtml(p.status || '—')}</b></span>
                            <span>supporting_n: <b style="color:#cbd5e1">${p.supporting_n || 0}</b></span>
                            <span>mechanism_n_videos: <b style="color:#22d3ee">${p.mechanism_n_videos || 0}</b></span>
                            <span>prevalence: <b style="color:#cbd5e1">${fmtNum(p.mechanism_prevalence_ratio)}</b></span>
                            <span>IDF: <b style="color:#cbd5e1">${fmtNum(p.mechanism_specificity_idf)}</b></span>
                            <span>generated: <b style="color:#cbd5e1">${fmtDate(p.generated_at)}</b></span>
                        </div>
                        ${bv ? `<div style="background:#050a14;border-radius:6px;padding:8px 12px;margin-bottom:6px;border-left:3px solid #f59e0b">
                            <div style="font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:#f59e0b;margin-bottom:4px">Bridge Validation</div>
                            <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#cbd5e1">
                                <span>pre→post ρ: <b style="color:${rColor(bv.pre_to_post_rho)}">${fmtSigned(bv.pre_to_post_rho)}</b></span>
                                <span>post→views r: <b style="color:${rColor(bv.post_to_views_r)}">${fmtSigned(bv.post_to_views_r)}</b></span>
                                <span>chain: <b style="color:${rColor(bv.chain_strength)}">${fmtSigned(bv.chain_strength)}</b></span>
                                <span>mech→views (direct) ρ: <b style="color:${rColor(bv.mech_to_views_rho_direct)}">${fmtSigned(bv.mech_to_views_rho_direct)}</b></span>
                                <span>first_10s: <b style="color:${rColor(bv.first_10s_signal)}">${bv.first_10s_signal != null ? fmtSigned(bv.first_10s_signal) : '—'}</b></span>
                                <span>swipe_away: <b style="color:${rColor(bv.swipe_away_signal)}">${bv.swipe_away_signal != null ? fmtSigned(bv.swipe_away_signal) : '—'}</b></span>
                                <span>n_videos_used: <b style="color:#22d3ee">${bv.n_videos_used || 0}</b></span>
                            </div>
                        </div>` : `<div style="font-size:11px;color:#64748b;font-style:italic;margin-bottom:6px">No bridge validation row for this principle.</div>`}
                        <div><button class="knowledge-graph-focus-btn" data-focus-type="principle" data-focus-id="${escapeHtml(p.id)}" style="background:#1e293b;border:1px solid #334155;color:#a78bfa;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">View in Graph →</button></div>
                    </td>
                </tr>`;
        }
        const chain = p.chain_strength_signed;
        const weighted = p.chain_strength_specificity_weighted;
        return `
            <tr data-prin-row="${escapeHtml(p.id)}" style="cursor:pointer;border-bottom:1px solid #1e293b">
                <td style="padding:5px 8px;font-size:10px;font-family:'SF Mono',monospace;color:#a78bfa">${escapeHtml(p.id)}</td>
                <td style="padding:5px 8px;font-size:11px;color:#cbd5e1">
                    <span style="color:#22d3ee">${escapeHtml(edge.from_mechanism || '—')}</span>
                    <span style="color:#475569;margin:0 4px">→</span>
                    <span style="color:#f59e0b">${escapeHtml(edge.via_indicator || '—')}</span>
                    <span style="color:#475569;margin:0 4px">→</span>
                    <span style="color:#a78bfa">${escapeHtml(edge.to_outcome || '—')}</span>
                </td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(p.mechanism_indicator_rho)};text-align:right">${fmtSigned(p.mechanism_indicator_rho)}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(p.indicator_outcome_r)};text-align:right">${fmtSigned(p.indicator_outcome_r)}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(chain)};text-align:right">${fmtSigned(chain)}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(weighted)};text-align:right">${fmtSigned(weighted)}</td>
                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#94a3b8;text-align:right">${p.mechanism_n_videos || 0}</td>
            </tr>
            ${detailHtml}
        `;
    }

    // ── Bridges ──────────────────────────────────────────
    function renderKnowledgeBridges() {
        const bv = knowledgeData.bridge_validation;
        const bt = knowledgeData.bridge_top;
        if (knowledgeError.bridge_validation) return loadingBox('Failed to load bridge validation: ' + knowledgeError.bridge_validation, true);
        if (!bv) return loadingBox('Loading bridge validation…');
        const topList = bt && Array.isArray(bt.top) ? bt.top : [];
        const rows = Array.isArray(bv.rows) ? bv.rows : [];
        const q = (knowledgeSearch.bridges || '').trim().toLowerCase();
        const filter = knowledgeFilter.bridges;
        let list = rows.filter(r => {
            if (q && !((r.principle_id||'').toLowerCase().includes(q) || (r.mechanism_id||'').toLowerCase().includes(q) || (r.via_indicator||'').toLowerCase().includes(q))) return false;
            if (filter === 'both_legs' && !(r.pre_to_post_rho && r.post_to_views_r)) return false;
            if (filter === 'positive_chain' && (r.chain_strength || 0) <= 0) return false;
            if (filter === 'negative_chain' && (r.chain_strength || 0) >= 0) return false;
            return true;
        });
        const sort = knowledgeSort.bridges;
        list.sort((a, b) => {
            switch (sort) {
                case 'chain_strength_desc': return Math.abs(b.chain_strength || 0) - Math.abs(a.chain_strength || 0);
                case 'weighted_desc': return Math.abs(b.chain_strength_specificity_weighted || 0) - Math.abs(a.chain_strength_specificity_weighted || 0);
                case 'mech_direct_desc': return Math.abs(b.mech_to_views_rho_direct || 0) - Math.abs(a.mech_to_views_rho_direct || 0);
                default: return 0;
            }
        });
        const limit = knowledgeListLimit.bridges;
        const shown = list.slice(0, limit);

        return `
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Validated rows</div><div style="font-size:18px;font-weight:700;color:#f59e0b">${(bv.n_principles_validated || rows.length).toLocaleString()}</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Both legs nonzero</div><div style="font-size:18px;font-weight:700;color:#22c55e">${bv.n_chains_with_both_legs_nonzero || 0}</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Video pool</div><div style="font-size:18px;font-weight:700;color:#06b6d4">${bv.n_videos_in_pool || 0}</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Top principles cached</div><div style="font-size:18px;font-weight:700;color:#facc15">${topList.length}</div></div>
            </div>

            ${topList.length ? `
            <div style="margin-bottom:16px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Top ${topList.length} Bridge Principles — ${escapeHtml(bt?.ranking || '')}</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px">
                    ${topList.map((t, i) => `
                        <div style="background:#0a1628;border:1px solid #1e293b;border-radius:8px;padding:10px 12px">
                            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px"><span style="font-size:10px;color:#64748b">#${i+1}</span><span style="font-family:'SF Mono',monospace;font-size:10px;color:#a78bfa">${escapeHtml(t.principle_id)}</span></div>
                            <div style="font-size:11px;color:#cbd5e1;margin-bottom:4px;line-height:1.4">
                                <span style="color:#22d3ee">${escapeHtml(t.mechanism_id)}</span><br/>
                                <span style="color:#475569">↳ via </span><span style="color:#f59e0b">${escapeHtml(t.via_indicator)}</span> <span style="color:#475569">→</span> <span style="color:#a78bfa">${escapeHtml(t.to_outcome)}</span>
                            </div>
                            <div style="display:flex;gap:8px;font-size:10px;font-family:'SF Mono',monospace">
                                <span style="color:${rColor(t.chain_strength)}">chain ${fmtSigned(t.chain_strength)}</span>
                                <span style="color:${rColor(t.chain_strength_specificity_weighted)}">w ${fmtSigned(t.chain_strength_specificity_weighted)}</span>
                                <span style="color:#94a3b8">n=${t.n_videos_used}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}

            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
                <input id="knowledge-bridge-search" type="text" value="${escapeHtml(knowledgeSearch.bridges)}" placeholder="Search principle, mechanism, indicator…" style="flex:1;min-width:220px;background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 10px;font-size:12px;color:#e2e8f0" />
                <select id="knowledge-bridge-sort" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    <option value="chain_strength_desc"${sort==='chain_strength_desc'?' selected':''}>|Chain| ↓</option>
                    <option value="weighted_desc"${sort==='weighted_desc'?' selected':''}>|Weighted| ↓</option>
                    <option value="mech_direct_desc"${sort==='mech_direct_desc'?' selected':''}>|Mech→views direct| ↓</option>
                </select>
                <select id="knowledge-bridge-filter" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    <option value="all"${filter==='all'?' selected':''}>All</option>
                    <option value="both_legs"${filter==='both_legs'?' selected':''}>Both legs nonzero</option>
                    <option value="positive_chain"${filter==='positive_chain'?' selected':''}>Positive chain</option>
                    <option value="negative_chain"${filter==='negative_chain'?' selected':''}>Negative chain</option>
                </select>
            </div>
            <div style="font-size:11px;color:#64748b;margin-bottom:8px">${list.length} match · showing ${Math.min(shown.length, list.length)}</div>
            <div style="border-radius:8px;overflow:hidden;border:1px solid #1e293b">
                <table style="width:100%;border-collapse:collapse">
                    <thead><tr style="background:#1e293b">
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Principle</th>
                        <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Mechanism → Indicator → Views</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">ρ leg1</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">r leg2</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Chain</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Weighted</th>
                        <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Direct</th>
                    </tr></thead>
                    <tbody>
                        ${shown.map(r => `
                            <tr style="border-bottom:1px solid #1e293b">
                                <td style="padding:5px 8px;font-size:10px;font-family:'SF Mono',monospace;color:#a78bfa">${escapeHtml(r.principle_id)}</td>
                                <td style="padding:5px 8px;font-size:11px;color:#cbd5e1">
                                    <span style="color:#22d3ee">${escapeHtml(r.mechanism_id)}</span>
                                    <span style="color:#475569;margin:0 4px">→</span>
                                    <span style="color:#f59e0b">${escapeHtml(r.via_indicator)}</span>
                                    <span style="color:#475569;margin:0 4px">→</span>
                                    <span style="color:#a78bfa">${escapeHtml(r.to_outcome)}</span>
                                </td>
                                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(r.pre_to_post_rho)};text-align:right">${fmtSigned(r.pre_to_post_rho)}</td>
                                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(r.post_to_views_r)};text-align:right">${fmtSigned(r.post_to_views_r)}</td>
                                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(r.chain_strength)};text-align:right">${fmtSigned(r.chain_strength)}</td>
                                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(r.chain_strength_specificity_weighted)};text-align:right">${fmtSigned(r.chain_strength_specificity_weighted)}</td>
                                <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:${rColor(r.mech_to_views_rho_direct)};text-align:right">${fmtSigned(r.mech_to_views_rho_direct)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ── Research ─────────────────────────────────────────
    function renderKnowledgeResearch() {
        const rq = knowledgeData.research_questions;
        const ra = knowledgeData.research_answers;
        const gaps = knowledgeData.principle_gaps;
        if (knowledgeError.research_questions) return loadingBox('Failed to load research questions: ' + knowledgeError.research_questions, true);
        if (!rq) return loadingBox('Loading research questions…');
        const questions = Array.isArray(rq.questions) ? rq.questions : [];
        const answers = ra && Array.isArray(ra.answers) ? ra.answers : [];
        const answerByQid = {};
        answers.forEach(a => { answerByQid[a.question_id] = a; });
        const gapList = gaps && Array.isArray(gaps.gaps) ? gaps.gaps : [];

        const q = (knowledgeSearch.research || '').trim().toLowerCase();
        const filter = knowledgeFilter.research;
        const filtered = questions.filter(qq => {
            if (q && !((qq.id||'').toLowerCase().includes(q) || (qq.question||'').toLowerCase().includes(q) || (qq.layer||'').toLowerCase().includes(q))) return false;
            if (filter === 'answered' && qq.status !== 'answered') return false;
            if (filter === 'open' && qq.status === 'answered') return false;
            return true;
        });
        const byLayer = {};
        questions.forEach(qq => { byLayer[qq.layer] = (byLayer[qq.layer] || 0) + 1; });
        const answeredCount = questions.filter(qq => qq.status === 'answered' || answerByQid[qq.id] || answerByQid[qq.id?.replace(/^q0*/, 'q')]).length;

        return `
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Questions</div><div style="font-size:18px;font-weight:700;color:#ec4899">${questions.length}</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Answered</div><div style="font-size:18px;font-weight:700;color:#22c55e">${answers.length}</div></div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:140px"><div style="font-size:10px;color:#64748b">Principle gaps</div><div style="font-size:18px;font-weight:700;color:#ef4444">${gapList.length}</div></div>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
                <input id="knowledge-research-search" type="text" value="${escapeHtml(knowledgeSearch.research)}" placeholder="Search questions…" style="flex:1;min-width:220px;background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 10px;font-size:12px;color:#e2e8f0" />
                <select id="knowledge-research-filter" style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-size:12px;color:#e2e8f0">
                    <option value="all"${filter==='all'?' selected':''}>All</option>
                    <option value="answered"${filter==='answered'?' selected':''}>Answered</option>
                    <option value="open"${filter==='open'?' selected':''}>Open</option>
                </select>
                <span style="font-size:11px;color:#64748b">Layers: ${Object.entries(byLayer).map(([l,n])=>`<b style="color:#cbd5e1">${escapeHtml(l)}</b>×${n}`).join(' · ')}</span>
            </div>

            <div style="margin-bottom:16px">
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Questions (${filtered.length})</div>
                <div style="display:flex;flex-direction:column;gap:6px">
                    ${filtered.map(qq => renderResearchQuestion(qq, answerByQid[qq.id])).join('')}
                </div>
            </div>

            ${gapList.length ? `
            <div>
                <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Principle Gaps (${gapList.length}) — mechanisms with no mechanism→indicator link above threshold</div>
                <div style="border-radius:8px;overflow:hidden;border:1px solid #1e293b">
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="background:#1e293b">
                            <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Mechanism</th>
                            <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Observations</th>
                            <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b">Videos</th>
                            <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b">Reason</th>
                        </tr></thead>
                        <tbody>
                            ${gapList.map(g => `
                                <tr style="border-bottom:1px solid #1e293b">
                                    <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#22d3ee">${escapeHtml(g.mechanism_id)}</td>
                                    <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#94a3b8;text-align:right">${g.n_observations || 0}</td>
                                    <td style="padding:5px 8px;font-size:11px;font-family:'SF Mono',monospace;color:#94a3b8;text-align:right">${g.n_videos || 0}</td>
                                    <td style="padding:5px 8px;font-size:11px;color:#cbd5e1">${escapeHtml(g.reason || '')}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>` : ''}
        `;
    }

    function renderResearchQuestion(q, answer) {
        const expanded = knowledgeExpanded.question === q.id;
        const isAnswered = q.status === 'answered' || !!answer;
        const color = isAnswered ? '#22c55e' : '#f59e0b';
        let detailHtml = '';
        if (expanded) {
            if (answer) {
                detailHtml = `<div style="background:#050a14;border-left:3px solid #22c55e;padding:10px 14px;margin-top:6px;border-radius:0 6px 6px 0">
                    <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#64748b;margin-bottom:6px">
                        <span>analysis: <b style="color:#cbd5e1">${escapeHtml(answer.analysis_id || '—')}</b></span>
                        <span>timestamp: <b style="color:#cbd5e1">${fmtDate(answer.timestamp)}</b></span>
                        <span>method: <b style="color:#cbd5e1">${escapeHtml(answer.method || '—')}</b></span>
                    </div>
                    ${answer.summary ? `<div style="font-size:12px;color:#cbd5e1;line-height:1.6;margin-bottom:6px;white-space:pre-wrap">${escapeHtml(typeof answer.summary === 'string' ? answer.summary : JSON.stringify(answer.summary, null, 2))}</div>` : ''}
                    ${answer.findings ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:10px;color:#64748b">Findings JSON</summary><pre style="margin-top:6px;padding:10px;background:#020510;color:#94a3b8;border-radius:6px;font-size:10px;max-height:320px;overflow:auto;font-family:'SF Mono',monospace">${escapeHtml(JSON.stringify(answer.findings, null, 2))}</pre></details>` : ''}
                </div>`;
            } else {
                detailHtml = `<div style="padding:8px 14px;margin-top:4px;background:#1a1005;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;font-size:11px;color:#fcd34d">Open question — no answer recorded.</div>`;
            }
        }
        return `
            <div data-question-id="${escapeHtml(q.id)}" style="background:#0a1628;border:1px solid #1e293b;border-radius:8px;padding:10px 14px;cursor:pointer">
                <div style="display:flex;align-items:baseline;gap:10px">
                    <span style="font-size:10px;font-family:'SF Mono',monospace;color:${color};font-weight:700">${escapeHtml(q.id)}</span>
                    <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:#1e293b;color:#94a3b8">${escapeHtml(q.layer || '—')}</span>
                    <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:#1e293b;color:#94a3b8">${escapeHtml(q.resolution || '—')}</span>
                    <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:${isAnswered?'#052e16':'#1a1005'};color:${color}">${isAnswered ? '✓ answered' : '○ open'}</span>
                    <span style="font-size:10px;color:#64748b;margin-left:auto">${fmtDate(q.generated_at)}</span>
                </div>
                <div style="font-size:12px;color:#cbd5e1;margin-top:4px;line-height:1.5">${escapeHtml(q.question || '')}</div>
                ${detailHtml}
            </div>
        `;
    }

    // ── Graph ────────────────────────────────────────────
    function renderKnowledgeGraph() {
        const mData = knowledgeData.mechanisms;
        const cData = knowledgeData.components;
        const pData = knowledgeData.principles;
        const mcData = knowledgeData.mechanism_components;
        const bvData = knowledgeData.bridge_validation;
        if (!mData || !cData || !pData || !mcData) return loadingBox('Loading knowledge graph data (mechanisms, components, principles, mapping)…');

        const mechs = mData.mechanisms || [];
        const comps = cData.components || [];
        const principles = pData.principles || [];
        const mcMap = mcData.mechanism_components || {};

        // Default focus: top principle (by |weighted|)
        let focus = knowledgeGraphFocus;
        if (!focus) {
            const top = [...principles].sort((a,b) => Math.abs(b.chain_strength_specificity_weighted||0) - Math.abs(a.chain_strength_specificity_weighted||0))[0];
            if (top) focus = { type: 'principle', id: top.id };
            else if (mechs[0]) focus = { type: 'mechanism', id: mechs[0].id };
            else return loadingBox('No data to graph.');
        }

        // Build a focused sub-graph
        let centerMech = null;
        let centerPrin = null;
        let centerComp = null;
        let relatedPrinciples = [];
        let relatedComponents = [];
        let relatedMechanisms = [];

        if (focus.type === 'principle') {
            centerPrin = principles.find(p => p.id === focus.id);
            if (centerPrin) {
                const fromMechId = centerPrin.edge?.from_mechanism;
                centerMech = mechs.find(m => m.id === fromMechId) || null;
                if (centerMech) {
                    const compIds = mcMap[centerMech.id] || [];
                    relatedComponents = compIds.map(id => comps.find(c => c.id === id || c.label === id) || { id, label: id }).filter(Boolean);
                }
                // other principles pointing at this mechanism
                relatedPrinciples = principles.filter(p => p.edge?.from_mechanism === fromMechId && p.id !== centerPrin.id).slice(0, 8);
            }
        } else if (focus.type === 'mechanism') {
            centerMech = mechs.find(m => m.id === focus.id);
            if (centerMech) {
                const compIds = mcMap[centerMech.id] || [];
                relatedComponents = compIds.map(id => comps.find(c => c.id === id || c.label === id) || { id, label: id }).filter(Boolean);
                relatedPrinciples = principles.filter(p => p.edge?.from_mechanism === centerMech.id).slice(0, 10);
            }
        } else if (focus.type === 'component') {
            centerComp = comps.find(c => c.id === focus.id);
            if (centerComp) {
                const mIds = (centerComp.mechanism_ids || []).slice(0, 12);
                relatedMechanisms = mIds.map(id => mechs.find(m => m.id === id) || { id, label: id }).filter(Boolean);
            }
        }

        const svg = renderGraphSvg({ centerMech, centerPrin, centerComp, relatedPrinciples, relatedComponents, relatedMechanisms, bvData });

        // Picker dropdowns
        const mechOpts = mechs.slice(0, 400).map(m => `<option value="${escapeHtml(m.id)}"${focus.type==='mechanism'&&focus.id===m.id?' selected':''}>${escapeHtml(m.label||m.id)}</option>`).join('');
        const prinOpts = principles.slice(0, 400).map(p => `<option value="${escapeHtml(p.id)}"${focus.type==='principle'&&focus.id===p.id?' selected':''}>${escapeHtml(p.id)} · ${escapeHtml(p.edge?.from_mechanism||'')}</option>`).join('');
        const compOpts = comps.map(c => `<option value="${escapeHtml(c.id)}"${focus.type==='component'&&focus.id===c.id?' selected':''}>${escapeHtml(c.label||c.id)}</option>`).join('');

        return `
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:260px">
                    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:4px">Focus principle</div>
                    <select id="knowledge-graph-principle" style="width:100%;background:#1e293b;border:1px solid #334155;border-radius:4px;padding:6px;font-size:11px;color:#e2e8f0"><option value="">— pick —</option>${prinOpts}</select>
                </div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:260px">
                    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:4px">Focus mechanism</div>
                    <select id="knowledge-graph-mechanism" style="width:100%;background:#1e293b;border:1px solid #334155;border-radius:4px;padding:6px;font-size:11px;color:#e2e8f0"><option value="">— pick —</option>${mechOpts}</select>
                </div>
                <div style="background:#0a1628;border-radius:8px;padding:8px 12px;flex:1;min-width:260px">
                    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:4px">Focus component</div>
                    <select id="knowledge-graph-component" style="width:100%;background:#1e293b;border:1px solid #334155;border-radius:4px;padding:6px;font-size:11px;color:#e2e8f0"><option value="">— pick —</option>${compOpts}</select>
                </div>
            </div>
            <div style="background:#050a14;border:1px solid #1e293b;border-radius:8px;padding:12px">
                <div style="font-size:10px;color:#64748b;margin-bottom:6px;display:flex;gap:12px;flex-wrap:wrap">
                    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#06b6d4;margin-right:4px;vertical-align:middle"></span>Component</span>
                    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22d3ee;margin-right:4px;vertical-align:middle"></span>Mechanism</span>
                    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#a78bfa;margin-right:4px;vertical-align:middle"></span>Principle / Outcome</span>
                </div>
                ${svg}
            </div>
        `;
    }

    function renderGraphSvg({ centerMech, centerPrin, centerComp, relatedPrinciples, relatedComponents, relatedMechanisms, bvData }) {
        const W = 900, H = 520;
        const cx = W / 2, cy = H / 2;
        const nodes = [];
        const edges = [];
        const truncate = (s, n=34) => {
            s = String(s || '');
            return s.length > n ? s.slice(0, n - 1) + '…' : s;
        };

        if (centerMech) {
            nodes.push({ id: 'M:' + centerMech.id, type: 'mechanism', label: centerMech.label || centerMech.id, sub: `n_videos=${centerMech.n_videos||0} · IDF=${fmtNum(centerMech.specificity_idf)}`, x: cx, y: cy, r: 26 });
            // components on the left
            const comps = relatedComponents.slice(0, 10);
            const spread = Math.min(comps.length, 10);
            comps.forEach((c, i) => {
                const y = cy - (spread-1)/2*46 + i*46;
                nodes.push({ id: 'C:' + c.id, type: 'component', label: c.label || c.id, sub: c.fragment_kind ? c.fragment_kind + ': ' + (c.fragment_value||'') : '', x: 120, y, r: 18 });
                edges.push({ from: 'C:' + c.id, to: 'M:' + centerMech.id, color: '#06b6d4', opacity: 0.5 });
            });
            // principles on the right
            let ps = relatedPrinciples.slice(0, 10);
            if (centerPrin && !ps.find(p => p.id === centerPrin.id)) ps = [centerPrin, ...ps].slice(0, 10);
            const pspread = Math.min(ps.length, 10);
            ps.forEach((p, i) => {
                const y = cy - (pspread-1)/2*46 + i*46;
                const isCenter = centerPrin && p.id === centerPrin.id;
                nodes.push({ id: 'P:' + p.id, type: 'principle', label: p.id, sub: truncate(`${p.edge?.via_indicator||''} → ${p.edge?.to_outcome||''}`, 30), x: W - 120, y, r: isCenter ? 22 : 16, highlight: isCenter });
                const cs = p.chain_strength_signed || 0;
                edges.push({ from: 'M:' + centerMech.id, to: 'P:' + p.id, color: cs >= 0 ? '#22d3ee' : '#f87171', opacity: Math.min(1, 0.25 + Math.abs(cs)*3), label: fmtSigned(cs) });
            });
        } else if (centerComp) {
            nodes.push({ id: 'C:' + centerComp.id, type: 'component', label: centerComp.label || centerComp.id, sub: (centerComp.fragment_kind||'')+': '+(centerComp.fragment_value||''), x: cx, y: cy, r: 26 });
            const ms = relatedMechanisms.slice(0, 12);
            const spread = Math.min(ms.length, 12);
            ms.forEach((m, i) => {
                const angle = (i / spread) * Math.PI * 2;
                const x = cx + Math.cos(angle) * 260;
                const y = cy + Math.sin(angle) * 180;
                nodes.push({ id: 'M:' + m.id, type: 'mechanism', label: m.label || m.id, sub: m.n_videos ? `n_videos=${m.n_videos}` : '', x, y, r: 18 });
                edges.push({ from: 'C:' + centerComp.id, to: 'M:' + m.id, color: '#06b6d4', opacity: 0.5 });
            });
        }

        const colorFor = (t) => t === 'component' ? '#06b6d4' : t === 'principle' ? '#a78bfa' : '#22d3ee';
        const strokeFor = (t) => t === 'component' ? '#0e7490' : t === 'principle' ? '#7c3aed' : '#0891b2';

        const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
        const edgeHtml = edges.map(e => {
            const a = nodeById[e.from], b = nodeById[e.to];
            if (!a || !b) return '';
            const midx = (a.x + b.x) / 2;
            const midy = (a.y + b.y) / 2;
            const labelEl = e.label ? `<text x="${midx}" y="${midy - 4}" fill="${e.color}" font-size="10" text-anchor="middle" font-family="SF Mono, monospace">${escapeHtml(e.label)}</text>` : '';
            return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${e.color}" stroke-opacity="${e.opacity}" stroke-width="1.5" />${labelEl}`;
        }).join('');

        const nodeHtml = nodes.map(n => `
            <g class="knowledge-graph-node" data-node-type="${n.type}" data-node-id="${escapeHtml(n.id.slice(2))}" style="cursor:pointer">
                <circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${colorFor(n.type)}" stroke="${n.highlight?'#f1f5f9':strokeFor(n.type)}" stroke-width="${n.highlight?3:1.5}" opacity="0.85" />
                <text x="${n.x}" y="${n.y + n.r + 12}" text-anchor="middle" fill="#e2e8f0" font-size="10" font-family="Inter, sans-serif">${escapeHtml(truncate(n.label, 26))}</text>
                ${n.sub ? `<text x="${n.x}" y="${n.y + n.r + 24}" text-anchor="middle" fill="#64748b" font-size="9">${escapeHtml(truncate(n.sub, 34))}</text>` : ''}
            </g>
        `).join('');

        // Legend / caption below
        let caption = '';
        if (centerPrin) {
            const e = centerPrin.edge || {};
            caption = `<div style="margin-top:8px;font-size:11px;color:#cbd5e1;line-height:1.5"><b style="color:#a78bfa">${escapeHtml(centerPrin.id)}</b> — <span style="color:#22d3ee">${escapeHtml(e.from_mechanism||'')}</span> → <span style="color:#f59e0b">${escapeHtml(e.via_indicator||'')}</span> → <span style="color:#a78bfa">${escapeHtml(e.to_outcome||'')}</span> · chain=<b style="color:${rColor(centerPrin.chain_strength_signed)}">${fmtSigned(centerPrin.chain_strength_signed)}</b> · weighted=<b style="color:${rColor(centerPrin.chain_strength_specificity_weighted)}">${fmtSigned(centerPrin.chain_strength_specificity_weighted)}</b></div>`;
        } else if (centerMech) {
            caption = `<div style="margin-top:8px;font-size:11px;color:#cbd5e1">Mechanism <b style="color:#22d3ee">${escapeHtml(centerMech.label||centerMech.id)}</b> — ${relatedComponents.length} components, ${relatedPrinciples.length} principles</div>`;
        } else if (centerComp) {
            caption = `<div style="margin-top:8px;font-size:11px;color:#cbd5e1">Component <b style="color:#06b6d4">${escapeHtml(centerComp.label||centerComp.id)}</b> — used by ${(centerComp.mechanism_ids||[]).length} mechanisms (showing ${relatedMechanisms.length})</div>`;
        }

        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:520px;display:block">${edgeHtml}${nodeHtml}</svg>${caption}`;
    }

    // ── Events ───────────────────────────────────────────
    function bindKnowledgeEvents() {
        const root = container?.querySelector('.jarvis-knowledge-root');
        if (!root) return;

        // Sub-tabs
        root.querySelectorAll('.jarvis-knowledge-subtab').forEach(btn => {
            btn.addEventListener('click', () => {
                knowledgeSubTab = btn.dataset.sub;
                refreshKnowledgeRoot();
                ensureKnowledgeDataForSubTab(knowledgeSubTab);
            });
        });

        // Mechanism rows
        root.querySelectorAll('[data-mech-row]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const id = row.getAttribute('data-mech-row');
                knowledgeExpanded.mechanism = knowledgeExpanded.mechanism === id ? null : id;
                refreshKnowledgeRoot();
            });
            row.addEventListener('mouseenter', () => row.style.background = '#0f2942');
            row.addEventListener('mouseleave', () => row.style.background = '');
        });

        // Mechanism search/sort/filter
        const mechSearch = root.querySelector('#knowledge-mech-search');
        if (mechSearch) mechSearch.addEventListener('input', () => {
            knowledgeSearch.mechanisms = mechSearch.value;
            const pos = mechSearch.selectionStart;
            refreshKnowledgeRoot();
            const el = container?.querySelector('#knowledge-mech-search');
            if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
        });
        const mechSort = root.querySelector('#knowledge-mech-sort');
        if (mechSort) mechSort.addEventListener('change', () => { knowledgeSort.mechanisms = mechSort.value; refreshKnowledgeRoot(); });
        const mechFilter = root.querySelector('#knowledge-mech-filter');
        if (mechFilter) mechFilter.addEventListener('change', () => { knowledgeFilter.mechanisms = mechFilter.value; refreshKnowledgeRoot(); });
        const mechMore = root.querySelector('#knowledge-mech-more');
        if (mechMore) mechMore.addEventListener('click', () => { knowledgeListLimit.mechanisms += 200; refreshKnowledgeRoot(); });

        // Component rows
        root.querySelectorAll('[data-comp-row]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button') || e.target.closest('.knowledge-mech-jump')) return;
                const id = row.getAttribute('data-comp-row');
                knowledgeExpanded.component = knowledgeExpanded.component === id ? null : id;
                refreshKnowledgeRoot();
            });
            row.addEventListener('mouseenter', () => row.style.background = '#0f2942');
            row.addEventListener('mouseleave', () => row.style.background = '');
        });

        // Component controls
        const compSearch = root.querySelector('#knowledge-comp-search');
        if (compSearch) compSearch.addEventListener('input', () => {
            knowledgeSearch.components = compSearch.value;
            const pos = compSearch.selectionStart;
            refreshKnowledgeRoot();
            const el = container?.querySelector('#knowledge-comp-search');
            if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
        });
        const compSort = root.querySelector('#knowledge-comp-sort');
        if (compSort) compSort.addEventListener('change', () => { knowledgeSort.components = compSort.value; refreshKnowledgeRoot(); });
        const compFilter = root.querySelector('#knowledge-comp-filter');
        if (compFilter) compFilter.addEventListener('change', () => { knowledgeFilter.components = compFilter.value; refreshKnowledgeRoot(); });

        // Principle rows
        root.querySelectorAll('[data-prin-row]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const id = row.getAttribute('data-prin-row');
                knowledgeExpanded.principle = knowledgeExpanded.principle === id ? null : id;
                refreshKnowledgeRoot();
            });
            row.addEventListener('mouseenter', () => row.style.background = '#0f2942');
            row.addEventListener('mouseleave', () => row.style.background = '');
        });

        // Principle controls
        const prinSearch = root.querySelector('#knowledge-prin-search');
        if (prinSearch) prinSearch.addEventListener('input', () => {
            knowledgeSearch.principles = prinSearch.value;
            const pos = prinSearch.selectionStart;
            refreshKnowledgeRoot();
            const el = container?.querySelector('#knowledge-prin-search');
            if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
        });
        const prinSort = root.querySelector('#knowledge-prin-sort');
        if (prinSort) prinSort.addEventListener('change', () => { knowledgeSort.principles = prinSort.value; refreshKnowledgeRoot(); });
        const prinFilter = root.querySelector('#knowledge-prin-filter');
        if (prinFilter) prinFilter.addEventListener('change', () => { knowledgeFilter.principles = prinFilter.value; refreshKnowledgeRoot(); });

        // Bridge controls
        const bridgeSearch = root.querySelector('#knowledge-bridge-search');
        if (bridgeSearch) bridgeSearch.addEventListener('input', () => {
            knowledgeSearch.bridges = bridgeSearch.value;
            const pos = bridgeSearch.selectionStart;
            refreshKnowledgeRoot();
            const el = container?.querySelector('#knowledge-bridge-search');
            if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
        });
        const bridgeSort = root.querySelector('#knowledge-bridge-sort');
        if (bridgeSort) bridgeSort.addEventListener('change', () => { knowledgeSort.bridges = bridgeSort.value; refreshKnowledgeRoot(); });
        const bridgeFilter = root.querySelector('#knowledge-bridge-filter');
        if (bridgeFilter) bridgeFilter.addEventListener('change', () => { knowledgeFilter.bridges = bridgeFilter.value; refreshKnowledgeRoot(); });

        // Research
        root.querySelectorAll('[data-question-id]').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.getAttribute('data-question-id');
                knowledgeExpanded.question = knowledgeExpanded.question === id ? null : id;
                refreshKnowledgeRoot();
            });
        });
        const researchSearch = root.querySelector('#knowledge-research-search');
        if (researchSearch) researchSearch.addEventListener('input', () => {
            knowledgeSearch.research = researchSearch.value;
            const pos = researchSearch.selectionStart;
            refreshKnowledgeRoot();
            const el = container?.querySelector('#knowledge-research-search');
            if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
        });
        const researchFilter = root.querySelector('#knowledge-research-filter');
        if (researchFilter) researchFilter.addEventListener('change', () => { knowledgeFilter.research = researchFilter.value; refreshKnowledgeRoot(); });

        // Graph pickers
        const gp = root.querySelector('#knowledge-graph-principle');
        if (gp) gp.addEventListener('change', () => { if (gp.value) { knowledgeGraphFocus = { type: 'principle', id: gp.value }; refreshKnowledgeRoot(); } });
        const gm = root.querySelector('#knowledge-graph-mechanism');
        if (gm) gm.addEventListener('change', () => { if (gm.value) { knowledgeGraphFocus = { type: 'mechanism', id: gm.value }; refreshKnowledgeRoot(); } });
        const gc = root.querySelector('#knowledge-graph-component');
        if (gc) gc.addEventListener('change', () => { if (gc.value) { knowledgeGraphFocus = { type: 'component', id: gc.value }; refreshKnowledgeRoot(); } });
        root.querySelectorAll('.knowledge-graph-node').forEach(node => {
            node.addEventListener('click', () => {
                const t = node.getAttribute('data-node-type');
                const id = node.getAttribute('data-node-id');
                if (t && id) { knowledgeGraphFocus = { type: t, id }; knowledgeSubTab = 'graph'; refreshKnowledgeRoot(); }
            });
        });

        // Cross-tab jumps
        root.querySelectorAll('.knowledge-graph-focus-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                knowledgeGraphFocus = { type: btn.getAttribute('data-focus-type'), id: btn.getAttribute('data-focus-id') };
                knowledgeSubTab = 'graph';
                refreshKnowledgeRoot();
                ensureKnowledgeDataForSubTab('graph');
            });
        });
        root.querySelectorAll('.knowledge-mech-jump').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-mech-id');
                knowledgeSubTab = 'mechanisms';
                knowledgeExpanded.mechanism = id;
                refreshKnowledgeRoot();
                ensureKnowledgeDataForSubTab('mechanisms');
            });
        });
    }

    // ══════════════════════════════════════════════════
    // TAB: IDEA MODEL — Viral Idea Engine brief + generated ideas
    // Reads the deterministic routes:
    //   GET /api/jarvis/viral-idea-model   — compressed structured brief
    //   GET /api/jarvis/viral-idea-ideas?count=5 — evidence-backed ideas
    // ══════════════════════════════════════════════════
    let ideaModelBrief = null;
    let ideaModelIdeas = null;
    let ideaModelLoading = false;
    let ideaModelError = null;
    let ideaIdeasCount = 5;

    async function loadIdeaModel(force = false) {
        if (ideaModelLoading) return;
        if (!force && ideaModelBrief && ideaModelIdeas) return;
        ideaModelLoading = true;
        ideaModelError = null;
        refreshIdeaModelRoot();
        const fetchJson = async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        };
        const [ideasResult, briefResult] = await Promise.allSettled([
            fetchJson('/api/jarvis/viral-idea-ideas?count=' + ideaIdeasCount),
            fetchJson('/api/jarvis/viral-idea-model'),
        ]);
        if (ideasResult.status === 'fulfilled') ideaModelIdeas = ideasResult.value;
        if (briefResult.status === 'fulfilled') ideaModelBrief = briefResult.value;
        const errs = [];
        if (ideasResult.status === 'rejected') errs.push('ideas: ' + (ideasResult.reason?.message || ideasResult.reason));
        if (briefResult.status === 'rejected') errs.push('brief: ' + (briefResult.reason?.message || briefResult.reason));
        ideaModelError = errs.length ? errs.join(' · ') : null;
        ideaModelLoading = false;
        refreshIdeaModelRoot();
    }

    function refreshIdeaModelRoot() {
        const root = container?.querySelector('.jarvis-idea-model-root');
        if (!root) return;
        root.innerHTML = renderIdeaModelBody();
        bindIdeaModelEvents();
    }

    function renderIdeaModel() {
        if (!ideaModelBrief && !ideaModelLoading && !ideaModelError) {
            loadIdeaModel();
        }
        setTimeout(bindIdeaModelEvents, 30);
        return `<div class="jarvis-idea-model-root">${renderIdeaModelBody()}</div>`;
    }

    function renderIdeaModelBody() {
        const header = `
            <div style="margin-bottom:14px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
                <div>
                    <div style="font-size:18px;font-weight:700;color:#e2e8f0;margin-bottom:3px">Idea Model — Specific Viral Ideas With Direct Validation</div>
                    <div style="font-size:12px;color:#64748b;line-height:1.5;max-width:720px">${ideaIdeasCount} concrete, shootable video premises, each grounded directly in specific validated source videos and checked against the underlying metrics, mechanisms, and retention evidence. No LLM calls, every claim is auditable.</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                    <select id="jarvis-idea-count" style="background:#060d1a;color:#cbd5e1;border:1px solid #1e293b;border-radius:6px;padding:6px 10px;font-size:11px">
                        ${[3,5,8,10].map(n => `<option value="${n}"${n === ideaIdeasCount ? ' selected' : ''}>${n} ideas</option>`).join('')}
                    </select>
                    <button id="jarvis-idea-refresh" style="background:#0d1424;color:#cbd5e1;border:1px solid #1e293b;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer">
                        ${ideaModelLoading ? 'Loading…' : '↻ Refresh'}
                    </button>
                </div>
            </div>
        `;

        const bothMissing = !ideaModelBrief && !ideaModelIdeas;
        if (ideaModelError && bothMissing) {
            return header + loadingBox('Failed to load idea model: ' + ideaModelError, true);
        }
        if (bothMissing) {
            return header + loadingBox('Loading idea model and generated ideas…');
        }

        let body = '';
        body += ideaModelIdeas
            ? renderIdeaGenerated()
            : loadingBox(ideaModelError ? ('Ideas failed: ' + ideaModelError) : 'Loading generated ideas…', !!ideaModelError);

        if (ideaModelBrief) {
            body += `<div style="margin:18px 0 10px;padding-top:12px;border-top:1px solid #1e293b;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b">Supporting Evidence · Model Brief</div>`;
            body += renderIdeaOverview()
                + renderIdeaPostUpload()
                + renderIdeaPreUpload()
                + renderIdeaBridges()
                + renderIdeaMechanismPrinciples()
                + renderIdeaHookMechanisms()
                + renderIdeaComponents();
        } else if (ideaModelError) {
            body += loadingBox('Model brief failed: ' + ideaModelError, true);
        } else {
            body += loadingBox('Loading model brief…');
        }

        return header + body;
    }

    function ideaSection(title, subtitle, bodyHtml) {
        return `
            <div style="margin-bottom:18px">
                <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;gap:12px;flex-wrap:wrap">
                    <div style="font-size:13px;font-weight:700;color:#f1f5f9;letter-spacing:0.02em">${escapeHtml(title)}</div>
                    ${subtitle ? `<div style="font-size:10px;color:#64748b">${escapeHtml(subtitle)}</div>` : ''}
                </div>
                <div style="background:#0a1628;border-radius:8px;padding:12px 14px;border:1px solid #1e293b">${bodyHtml}</div>
            </div>
        `;
    }

    function renderIdeaOverview() {
        const b = ideaModelBrief;
        const s = b.source_sizes || {};
        const h = b.headline_model_r2 || {};
        const card = (label, value, sub, color) => `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;flex:1;min-width:140px;border:1px solid #1e293b">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">${escapeHtml(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#e2e8f0'}">${value}</div>
                ${sub ? `<div style="font-size:10px;color:#64748b;margin-top:3px">${escapeHtml(sub)}</div>` : ''}
            </div>`;
        const body = `
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
                ${card('Headline CV R²', h.cv_r2 != null ? (+h.cv_r2).toFixed(3) : '—', h.model ? h.model : '', '#22d3ee')}
                ${card('Features', h.n_features != null ? h.n_features : '—', 'in headline model', '#06b6d4')}
                ${card('Videos', (s.videos_in_pool || 0).toLocaleString(), 'in pool', '#a78bfa')}
                ${card('Principles', (s.principles_total || 0).toLocaleString(), 'total', '#f59e0b')}
                ${card('Mechanisms', (s.mechanisms_total || 0).toLocaleString(), 'named', '#facc15')}
                ${card('Components', (s.components_total || 0).toLocaleString(), 'fragments', '#ec4899')}
            </div>
            <div style="font-size:10px;color:#64748b">Brief generated at <span style="color:#cbd5e1">${escapeHtml(b.generated_at || '—')}</span> · click Refresh to regenerate from the latest artifacts.</div>
        `;
        return ideaSection('Model Overview', 'compressed brief from Jarvis artifacts', body);
    }

    function renderIdeaPostUpload() {
        const rows = ideaModelBrief.top_post_upload_predictors || [];
        if (!rows.length) return ideaSection('Top Post-Upload Predictors', '— no rows —', '<div style="font-size:11px;color:#64748b">No predictors available.</div>');
        const table = `
            <table style="width:100%;border-collapse:collapse;font-size:11px">
                <thead><tr style="color:#64748b;font-size:10px;letter-spacing:0.05em;text-transform:uppercase">
                    <th style="text-align:left;padding:4px 8px">Signal</th>
                    <th style="text-align:left;padding:4px 8px">Key pattern</th>
                    <th style="text-align:right;padding:4px 8px">r → log10(views)</th>
                </tr></thead>
                <tbody>
                    ${rows.map((r, i) => `
                        <tr style="background:${i % 2 === 0 ? '#060d1a' : 'transparent'}">
                            <td style="padding:5px 8px;font-family:monospace;color:#cbd5e1">${escapeHtml(r.key || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#94a3b8">${escapeHtml(r.key_pattern || r.diversity_bucket || '')}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:${rColor(r.r_to_views)};font-weight:600">${r.r_to_views != null ? (+r.r_to_views).toFixed(3) : '—'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        return ideaSection('Top Post-Upload Predictors', 'deduped by key pattern · direct correlation with views', table);
    }

    function renderIdeaPreUpload() {
        const rows = ideaModelBrief.top_pre_upload_predictors || [];
        if (!rows.length) return ideaSection('Top Pre-Upload Predictors', '— no rows —', '<div style="font-size:11px;color:#64748b">No predictors available.</div>');
        const table = `
            <table style="width:100%;border-collapse:collapse;font-size:11px">
                <thead><tr style="color:#64748b;font-size:10px;letter-spacing:0.05em;text-transform:uppercase">
                    <th style="text-align:left;padding:4px 8px">Signal</th>
                    <th style="text-align:right;padding:4px 8px">r → views</th>
                    <th style="text-align:left;padding:4px 8px">Direction</th>
                </tr></thead>
                <tbody>
                    ${rows.map((r, i) => `
                        <tr style="background:${i % 2 === 0 ? '#060d1a' : 'transparent'}">
                            <td style="padding:5px 8px;font-family:monospace;color:#cbd5e1">${escapeHtml(r.key || '')}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:${rColor(r.r_to_views)};font-weight:600">${r.r_to_views != null ? (+r.r_to_views).toFixed(3) : '—'}</td>
                            <td style="padding:5px 8px;color:#94a3b8">${escapeHtml(r.direction || '')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        return ideaSection('Top Pre-Upload Predictors', 'levers controllable before shoot — ranked by |r|', table);
    }

    function renderIdeaBridges() {
        const rows = ideaModelBrief.top_bridges_pre_to_post_to_views || [];
        if (!rows.length) return ideaSection('Top Pre → Post → Views Bridges', '— no rows —', '<div style="font-size:11px;color:#64748b">No bridges available.</div>');
        const table = `
            <table style="width:100%;border-collapse:collapse;font-size:11px">
                <thead><tr style="color:#64748b;font-size:10px;letter-spacing:0.05em;text-transform:uppercase">
                    <th style="text-align:left;padding:4px 8px">Pre</th>
                    <th style="text-align:left;padding:4px 8px">Post</th>
                    <th style="text-align:right;padding:4px 8px">pre r</th>
                    <th style="text-align:right;padding:4px 8px">post r</th>
                    <th style="text-align:right;padding:4px 8px">Bridge</th>
                    <th style="text-align:right;padding:4px 8px">Score</th>
                    <th style="text-align:left;padding:4px 8px">Source</th>
                </tr></thead>
                <tbody>
                    ${rows.map((r, i) => `
                        <tr style="background:${i % 2 === 0 ? '#060d1a' : 'transparent'}">
                            <td style="padding:5px 8px;font-family:monospace;color:#cbd5e1">${escapeHtml(r.pre || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#cbd5e1">${escapeHtml(r.post || '')}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:${rColor(r.pre_r)}">${r.pre_r != null ? (+r.pre_r).toFixed(3) : '—'}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:${rColor(r.post_r)}">${r.post_r != null ? (+r.post_r).toFixed(3) : '—'}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#94a3b8">${r.bridge_strength != null ? (+r.bridge_strength).toFixed(3) : (r.path_strength != null ? (+r.path_strength).toFixed(3) : '—')}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#facc15;font-weight:600">${r.score != null ? (+r.score).toFixed(3) : '—'}</td>
                            <td style="padding:5px 8px;color:#64748b;font-size:10px">${escapeHtml(r.source || '')}${r.sign_consistent ? ' · ✓' : ''}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        return ideaSection('Top Pre → Post → Views Bridges', 'pre-upload signals that flow through post-upload behavior into views', table);
    }

    function renderIdeaMechanismPrinciples() {
        const rows = ideaModelBrief.top_mechanism_principles || [];
        if (!rows.length) return ideaSection('Top Mechanism Principles', '— no rows —', '<div style="font-size:11px;color:#64748b">No principles available.</div>');
        const table = `
            <table style="width:100%;border-collapse:collapse;font-size:11px">
                <thead><tr style="color:#64748b;font-size:10px;letter-spacing:0.05em;text-transform:uppercase">
                    <th style="text-align:left;padding:4px 8px">Principle</th>
                    <th style="text-align:left;padding:4px 8px">Mechanism</th>
                    <th style="text-align:left;padding:4px 8px">Via Indicator</th>
                    <th style="text-align:left;padding:4px 8px">Outcome</th>
                    <th style="text-align:right;padding:4px 8px">CSW</th>
                    <th style="text-align:right;padding:4px 8px">n</th>
                </tr></thead>
                <tbody>
                    ${rows.map((r, i) => {
                        const csw = r.chain_strength_specificity_weighted;
                        return `
                        <tr style="background:${i % 2 === 0 ? '#060d1a' : 'transparent'}">
                            <td style="padding:5px 8px;font-family:monospace;color:#94a3b8;font-size:10px">${escapeHtml(r.principle_id || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#cbd5e1;font-size:10px">${escapeHtml(r.mechanism_id || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#22d3ee">${escapeHtml(r.via_indicator || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#a78bfa">${escapeHtml(r.to_outcome || '')}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:${rColor(csw)};font-weight:600">${csw != null ? (+csw).toFixed(3) : '—'}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#94a3b8">${r.mechanism_n_videos != null ? r.mechanism_n_videos : '—'}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        `;
        return ideaSection('Top Mechanism Principles', 'mechanism → indicator → outcome chains ranked by |CSW|', table);
    }

    function renderIdeaHookMechanisms() {
        const rows = ideaModelBrief.hook_mechanisms || [];
        if (!rows.length) return ideaSection('Hook Mechanisms', '— no rows —', '<div style="font-size:11px;color:#64748b">No first-5s/10s mechanisms found.</div>');
        const table = `
            <table style="width:100%;border-collapse:collapse;font-size:11px">
                <thead><tr style="color:#64748b;font-size:10px;letter-spacing:0.05em;text-transform:uppercase">
                    <th style="text-align:left;padding:4px 8px">Bucket</th>
                    <th style="text-align:left;padding:4px 8px">Mechanism</th>
                    <th style="text-align:left;padding:4px 8px">Via Indicator</th>
                    <th style="text-align:right;padding:4px 8px">CSW</th>
                    <th style="text-align:right;padding:4px 8px">Sign</th>
                    <th style="text-align:right;padding:4px 8px">n</th>
                </tr></thead>
                <tbody>
                    ${rows.map((r, i) => `
                        <tr style="background:${i % 2 === 0 ? '#060d1a' : 'transparent'}">
                            <td style="padding:5px 8px;font-family:monospace;color:#facc15">${escapeHtml(r.bucket || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#cbd5e1;font-size:10px">${escapeHtml(r.mechanism_id || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#22d3ee">${escapeHtml(r.via_indicator || '')}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:${rColor(r.csw)};font-weight:600">${r.csw != null ? (+r.csw).toFixed(3) : '—'}</td>
                            <td style="padding:5px 8px;text-align:right;color:${r.sign === 'positive' ? '#22c55e' : '#f87171'}">${escapeHtml(r.sign || '')}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#94a3b8">${r.n_videos != null ? r.n_videos : '—'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        return ideaSection('Hook Mechanisms', 'first-5s / first-10s / hook-quarter principles driving retention', table);
    }

    function renderIdeaComponents() {
        const rows = ideaModelBrief.top_components || [];
        if (!rows.length) return ideaSection('Top Components', '— no rows —', '<div style="font-size:11px;color:#64748b">No components available.</div>');
        const table = `
            <table style="width:100%;border-collapse:collapse;font-size:11px">
                <thead><tr style="color:#64748b;font-size:10px;letter-spacing:0.05em;text-transform:uppercase">
                    <th style="text-align:left;padding:4px 8px">Component</th>
                    <th style="text-align:left;padding:4px 8px">Kind</th>
                    <th style="text-align:left;padding:4px 8px">Value</th>
                    <th style="text-align:right;padding:4px 8px">Mechanisms</th>
                    <th style="text-align:right;padding:4px 8px">Observations</th>
                </tr></thead>
                <tbody>
                    ${rows.map((r, i) => `
                        <tr style="background:${i % 2 === 0 ? '#060d1a' : 'transparent'}">
                            <td style="padding:5px 8px;color:#cbd5e1">${escapeHtml(r.label || r.id || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#a78bfa">${escapeHtml(r.fragment_kind || '')}</td>
                            <td style="padding:5px 8px;font-family:monospace;color:#22d3ee">${escapeHtml(String(r.fragment_value || ''))}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#facc15">${r.n_mechanisms_using != null ? r.n_mechanisms_using : '—'}</td>
                            <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#94a3b8">${r.n_observations_total != null ? r.n_observations_total : '—'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        return ideaSection('Top Components', 'recurring fragments shared across mechanisms', table);
    }

    function renderIdeaGenerated() {
        const ideas = (ideaModelIdeas && ideaModelIdeas.ideas) || [];
        if (!ideas.length) return ideaSection('Generated Ideas', '— none —', '<div style="font-size:11px;color:#64748b">No ideas generated.</div>');
        const cards = ideas.map(idea => renderBlueprintCard(idea)).join('');
        return `
            <div style="margin-bottom:18px">
                <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;gap:12px;flex-wrap:wrap">
                    <div style="display:flex;align-items:baseline;gap:10px">
                        <span style="font-size:16px;font-weight:700;color:#22d3ee;letter-spacing:0.03em">✦ Specific Ideas — Directly Validated</span>
                        <span style="font-size:11px;color:#94a3b8">${ideas.length} concrete premises · every field traced to evidence</span>
                    </div>
                    <span style="font-size:10px;color:#64748b;letter-spacing:0.05em">supporting evidence below ↓</span>
                </div>
                ${cards}
            </div>
        `;
    }

    function renderBlueprintCard(idea) {
        const score = idea.score_breakdown || {};
        const parts = score.parts || {};
        const partPill = (label, v, color) => `
            <span style="background:#1e293b;border-radius:4px;padding:2px 6px;font-size:9px;letter-spacing:0.05em;text-transform:uppercase;color:${color}">
                ${escapeHtml(label)} <b style="color:#f1f5f9">${v != null ? (+v).toFixed(3) : '0'}</b>
            </span>`;
        const narratives = (idea.narrative_structures || []).map(n =>
            `<code style="background:#1e293b;color:#a78bfa;padding:1px 6px;border-radius:3px;font-size:10px;margin-right:3px">${escapeHtml(n)}</code>`
        ).join('');
        const levers = (idea.pre_upload_levers || []).map(l =>
            `<code style="background:#1e293b;color:#fbbf24;padding:1px 6px;border-radius:3px;font-size:10px;margin-right:3px">${escapeHtml(l)}</code>`
        ).join('');
        const interactions = (idea.interactions_engineered || []).map(i =>
            `<code style="background:#1e293b;color:#ec4899;padding:1px 6px;border-radius:3px;font-size:10px;margin-right:3px">${escapeHtml(i)}</code>`
        ).join('');
        const hooks = (idea.hook_mechanisms || []).map(h =>
            `<div style="font-size:10px;color:#94a3b8;margin-bottom:2px"><span style="color:#facc15">[${escapeHtml(h.bucket || '')}]</span> <code style="color:#22d3ee">${escapeHtml(h.via_indicator || '')}</code> · csw <b style="color:${rColor(h.csw)}">${h.csw != null ? (+h.csw).toFixed(3) : '—'}</b> · n=${h.n_videos || '—'}</div>`
        ).join('');
        const evidence = (idea.evidence || []).map(e =>
            `<li style="margin-bottom:3px;color:#94a3b8">${escapeHtml(e)}</li>`
        ).join('');

        // Concept section
        const c = idea.concept || {};
        const conceptBox = `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #22d3ee">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Concept</div>
                ${c.logline ? `<div style="font-size:12px;color:#cbd5e1;line-height:1.5;margin-bottom:6px">${escapeHtml(c.logline)}</div>` : ''}
                ${c.promise ? `<div style="font-size:11px;color:#94a3b8;margin-bottom:4px"><b style="color:#facc15">Promise:</b> ${escapeHtml(c.promise)}</div>` : ''}
                ${c.payoff ? `<div style="font-size:11px;color:#94a3b8;margin-bottom:4px"><b style="color:#22c55e">Payoff:</b> ${escapeHtml(c.payoff)}</div>` : ''}
                ${c.over_delivery_note ? `<div style="font-size:10px;color:#64748b;font-style:italic">${escapeHtml(c.over_delivery_note)}</div>` : ''}
            </div>`;

        // Opening section
        const o = idea.opening || {};
        const openingBox = `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #facc15">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Opening (first 3-5s — engineered)</div>
                <div style="display:grid;grid-template-columns:120px 1fr;gap:4px 10px;font-size:11px">
                    ${o.first_frame ? `<div style="color:#64748b">First frame</div><div style="color:#cbd5e1">${escapeHtml(o.first_frame)}</div>` : ''}
                    ${o.first_line ? `<div style="color:#64748b">First line</div><div style="color:#e2e8f0;font-style:italic">"${escapeHtml(o.first_line)}"</div>` : ''}
                    ${o.opening_action ? `<div style="color:#64748b">Opening action</div><div style="color:#cbd5e1">${escapeHtml(o.opening_action)}</div>` : ''}
                    ${o.opening_speech_rate_wps_target != null ? `<div style="color:#64748b">Speech rate</div><div style="color:#22d3ee">${o.opening_speech_rate_wps_target} w/s target</div>` : ''}
                    ${o.hook_type ? `<div style="color:#64748b">Hook type</div><div style="color:#a78bfa">${escapeHtml(o.hook_type)}</div>` : ''}
                    ${o.best_first_word_used ? `<div style="color:#64748b">First word</div><div style="color:#22c55e"><code style="background:#1e293b;padding:1px 5px;border-radius:3px">${escapeHtml(o.best_first_word_used)}</code></div>` : ''}
                </div>
            </div>`;

        // Build phases
        const bp = idea.build_phases || [];
        const buildBox = bp.length ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #a78bfa">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Build Phases (narrative arc)</div>
                ${bp.map(p => `
                    <div style="display:grid;grid-template-columns:60px 1fr;gap:4px 10px;font-size:11px;margin-bottom:4px">
                        <div style="color:${p.visceral ? '#f87171' : '#64748b'};font-family:monospace;font-weight:600">${escapeHtml(p.zone_pct || '')}%</div>
                        <div>
                            <div style="color:#cbd5e1">${escapeHtml(p.beat || '')}${p.visceral ? ' <span style="color:#f87171;font-size:9px">✦ visceral</span>' : ''}</div>
                            ${p.note ? `<div style="color:#64748b;font-size:10px;margin-top:1px">${escapeHtml(p.note)}</div>` : ''}
                        </div>
                    </div>`).join('')}
            </div>` : '';

        // Climax & payoff
        const cp = idea.climax_and_payoff || {};
        const climaxBox = (cp.climax_hint || cp.closing_line_hint) ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #22c55e">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Climax &amp; Payoff</div>
                ${cp.climax_hint ? `<div style="font-size:11px;color:#cbd5e1;line-height:1.5;margin-bottom:4px"><b style="color:#22c55e">Climax (60-80%):</b> ${escapeHtml(cp.climax_hint)}</div>` : ''}
                ${cp.closing_line_hint ? `<div style="font-size:11px;color:#cbd5e1;line-height:1.5"><b style="color:#22c55e">Close:</b> ${escapeHtml(cp.closing_line_hint)}</div>` : ''}
            </div>` : '';

        // Visual prescription
        const vp = idea.visual_prescription || {};
        const vpZones = ['first_5s', 'hook_quarter', 'mid', 'late', 'avoid'];
        const vpBox = (Object.keys(vp).length) ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #ec4899">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Visual Prescription</div>
                ${vpZones.filter(z => Array.isArray(vp[z]) && vp[z].length).map(z => `
                    <div style="font-size:11px;margin-bottom:3px">
                        <span style="color:${z === 'avoid' ? '#f87171' : '#ec4899'};font-weight:600;display:inline-block;min-width:92px">${escapeHtml(z)}:</span>
                        <span style="color:#cbd5e1">${vp[z].map(s => escapeHtml(s)).join(', ')}</span>
                    </div>`).join('')}
            </div>` : '';

        // Vocabulary prescription
        const voc = idea.vocabulary_prescription || {};
        const vocBox = (voc.use_peak_words || voc.avoid_material_words || voc.closing_words) ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #fbbf24">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Vocabulary Prescription</div>
                ${voc.use_peak_words && voc.use_peak_words.length ? `<div style="font-size:11px;margin-bottom:4px"><span style="color:#22c55e;font-weight:600">USE:</span> ${voc.use_peak_words.map(w => `<code style="background:#14291e;color:#86efac;padding:1px 5px;border-radius:3px;margin-right:3px;font-size:10px">${escapeHtml(w)}</code>`).join('')}</div>` : ''}
                ${voc.avoid_material_words && voc.avoid_material_words.length ? `<div style="font-size:11px;margin-bottom:4px"><span style="color:#f87171;font-weight:600">AVOID:</span> ${voc.avoid_material_words.map(w => `<code style="background:#291414;color:#fca5a5;padding:1px 5px;border-radius:3px;margin-right:3px;font-size:10px">${escapeHtml(w)}</code>`).join('')}</div>` : ''}
                ${voc.closing_words && voc.closing_words.length ? `<div style="font-size:11px"><span style="color:#facc15;font-weight:600">CLOSE WITH:</span> ${voc.closing_words.map(w => `<code style="background:#292414;color:#fcd34d;padding:1px 5px;border-radius:3px;margin-right:3px;font-size:10px">${escapeHtml(w)}</code>`).join('')}</div>` : ''}
            </div>` : '';

        // Pacing
        const pac = idea.pacing || {};
        const pacBox = Object.keys(pac).length ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #06b6d4">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Pacing</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px">
                    ${pac.opening_wps_target != null ? `<div><span style="color:#64748b">open</span> <b style="color:#22d3ee">${pac.opening_wps_target} w/s</b></div>` : ''}
                    ${pac.peak_wps_target != null ? `<div><span style="color:#64748b">peaks</span> <b style="color:#22c55e">${pac.peak_wps_target} w/s</b></div>` : ''}
                    ${pac.closing_wps_target != null ? `<div><span style="color:#64748b">close</span> <b style="color:#facc15">${pac.closing_wps_target} w/s</b></div>` : ''}
                    ${pac.utterance_length_at_peaks_words_target != null ? `<div><span style="color:#64748b">peak utterance</span> <b style="color:#a78bfa">${pac.utterance_length_at_peaks_words_target} words</b></div>` : ''}
                    ${pac.no_long_pauses ? `<div style="color:#f87171">no pauses &gt;1s</div>` : ''}
                </div>
            </div>` : '';

        // Arc
        const arc = idea.arc || {};
        const arcBox = Object.keys(arc).length ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #818cf8">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Arc</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px">
                    ${arc.arc_shape ? `<div><span style="color:#64748b">shape</span> <b style="color:#818cf8">${escapeHtml(arc.arc_shape)}</b></div>` : ''}
                    ${arc.shape_encoding_target ? `<div><span style="color:#64748b">encoding</span> <b style="color:#22d3ee">${escapeHtml(arc.shape_encoding_target)}</b></div>` : ''}
                    ${arc.progression_target ? `<div><span style="color:#64748b">progression</span> <b style="color:#22c55e">${escapeHtml(arc.progression_target)}</b></div>` : ''}
                    ${arc.nadir_placement_pct != null ? `<div><span style="color:#64748b">nadir at</span> <b style="color:#f87171">${arc.nadir_placement_pct}%</b></div>` : ''}
                </div>
            </div>` : '';

        // Estimated metrics
        const em = idea.estimated_metrics || {};
        const metricCell = (label, m, color, fmt) => {
            if (!m) return '';
            const v = fmt ? fmt(m.modeled_value, m.band_label) : (m.modeled_value != null ? m.modeled_value : '—');
            const band = m.band || m.band_label || '';
            const conf = m.confidence || '';
            const drivers = (m.drivers || []).map(d => `${d.driver}${d.modeled_delta != null ? ` (${(d.modeled_delta >= 0 ? '+' : '')}${(+d.modeled_delta).toFixed(3)})` : ''}`).slice(0, 4).join(' · ');
            const val = m.validation || null;
            const valInline = val ? `
                <details style="margin-top:3px">
                    <summary style="font-size:9px;color:#22d3ee;cursor:pointer">validated against ${val.indicator_keys_count || 0} indicators (pool ${val.indicators_considered_count || 0})</summary>
                    <div style="font-size:9px;color:#94a3b8;margin-top:4px;line-height:1.5">
                        ${val.rationale ? `<div style="color:#cbd5e1;margin-bottom:3px">${escapeHtml(val.rationale)}</div>` : ''}
                        ${val.filter ? `<div style="color:#64748b;margin-bottom:3px"><b style="color:#94a3b8">filter:</b> <code style="color:#94a3b8">${escapeHtml(val.filter)}</code></div>` : ''}
                        ${(val.top_indicators || []).slice(0, 5).map(t => `
                            <div style="padding:3px 5px;background:#0a1628;border-left:2px solid #22d3ee;border-radius:3px;margin-bottom:2px">
                                <code style="color:#22d3ee;font-size:9px">${escapeHtml(t.key || '')}</code>
                                ${t.rho != null ? ` · <span style="color:${t.rho >= 0 ? '#22c55e' : '#f87171'}">ρ=${(+t.rho).toFixed(3)}</span>` : ''}
                                ${t.r_with_views != null ? ` · <span style="color:${t.r_with_views >= 0 ? '#22c55e' : '#f87171'}">r=${(+t.r_with_views).toFixed(3)}</span>` : ''}
                                ${t.r_partial != null ? ` · <span style="color:${t.r_partial >= 0 ? '#22c55e' : '#f87171'}">rₚ=${(+t.r_partial).toFixed(3)}</span>` : ''}
                                ${t.csw != null ? ` · <span style="color:#facc15">csw=${(+t.csw).toFixed(3)}</span>` : ''}
                                ${t.n != null ? ` · <span style="color:#64748b">n=${t.n}</span>` : ''}
                                ${t.evidence_type ? ` · <span style="color:#94a3b8;font-size:8px">[${escapeHtml(t.evidence_type)}]</span>` : ''}
                                ${t.quantification ? `<div style="color:#94a3b8;font-size:8.5px;margin-top:1px">⟹ ${escapeHtml(String(t.quantification).slice(0, 160))}</div>` : ''}
                                ${t.why && !t.quantification ? `<div style="color:#94a3b8;font-size:8.5px;margin-top:1px">⟹ ${escapeHtml(String(t.why).slice(0, 160))}</div>` : ''}
                            </div>`).join('')}
                        ${val.evidence_sources && val.evidence_sources.length ? `<div style="color:#64748b;font-size:8.5px;margin-top:3px">sources: ${val.evidence_sources.map(s => `<code style="color:#94a3b8">${escapeHtml(s)}</code>`).join(' · ')}</div>` : ''}
                    </div>
                </details>` : '';
            return `
                <div style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:8px 10px">
                    <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:3px">${escapeHtml(label)}</div>
                    <div style="font-size:15px;font-weight:700;color:${color}">${v}</div>
                    <div style="font-size:10px;color:#94a3b8;margin-top:2px">${escapeHtml(String(band))} · conf <b style="color:#cbd5e1">${escapeHtml(conf)}</b></div>
                    ${drivers ? `<div style="font-size:9px;color:#64748b;margin-top:2px;line-height:1.4">${escapeHtml(drivers)}</div>` : ''}
                    ${m.method ? `<details style="margin-top:3px"><summary style="font-size:9px;color:#64748b;cursor:pointer">method</summary><div style="font-size:9px;color:#94a3b8;margin-top:2px;line-height:1.4">${escapeHtml(m.method)}</div></details>` : ''}
                    ${valInline}
                </div>`;
        };
        const metricsBox = Object.keys(em).length ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #22d3ee">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Estimated Metrics — <span style="color:#f87171">MODELED, not predicted</span></div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px">
                    ${metricCell('Swipe-away', em.swipe_away_rate, '#22c55e', (v) => v != null ? (v * 100).toFixed(1) + '%' : '—')}
                    ${metricCell('Retention @ 20s', em.hook_retention_20s, '#22d3ee', (v) => v != null ? (v * 100).toFixed(1) + '%' : '—')}
                    ${metricCell('Share propensity', em.share_propensity, '#a78bfa', (v) => v != null ? (v * 100).toFixed(1) + '%' : '—')}
                    ${metricCell('Keep rate', em.keep_rate, '#facc15', (v) => v != null ? (v * 100).toFixed(1) + '%' : '—')}
                    ${em.view_band ? `
                        <div style="background:#0a1628;border:1px solid #1e293b;border-radius:6px;padding:8px 10px">
                            <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:3px">View band</div>
                            <div style="font-size:13px;font-weight:700;color:#fbbf24">${escapeHtml(em.view_band.band_label || '—')}</div>
                            <div style="font-size:10px;color:#94a3b8;margin-top:2px">conf <b style="color:#cbd5e1">${escapeHtml(em.view_band.confidence || '')}</b></div>
                            ${em.view_band.method ? `<details style="margin-top:3px"><summary style="font-size:9px;color:#64748b;cursor:pointer">method</summary><div style="font-size:9px;color:#94a3b8;margin-top:2px;line-height:1.4">${escapeHtml(em.view_band.method)}${em.view_band.note ? '<br><i>' + escapeHtml(em.view_band.note) + '</i>' : ''}</div></details>` : ''}
                        </div>` : ''}
                </div>
            </div>` : '';

        // Scorecard targets
        const sct = idea.scorecard_targets || {};
        const sctKeys = Object.keys(sct);
        const sctBox = sctKeys.length ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #f59e0b">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Scorecard Targets (design intent)</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:4px;font-size:11px">
                    ${sctKeys.map(k => {
                        const r = sct[k] || {};
                        const color = r.status === 'top-decile' ? '#22c55e' : r.status === 'top-quartile' ? '#22d3ee' : r.status === 'above-mean' ? '#fbbf24' : '#f87171';
                        return `<div style="background:#0a1628;border-radius:4px;padding:5px 8px;border:1px solid #1e293b">
                            <div style="color:#94a3b8;font-size:9px;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(k)}</div>
                            <div style="color:${color};font-weight:700;font-size:13px">${r.target != null ? r.target : '—'}</div>
                            <div style="color:#64748b;font-size:9px">${escapeHtml(r.status || '')}${r.corpus_mean != null ? ` · µ=${r.corpus_mean}` : ''}</div>
                        </div>`;
                    }).join('')}
                </div>
            </div>` : '';

        // Risk flags
        const rf = idea.risk_flags_detected || [];
        const rfBox = rf.length ? `
            <div style="background:#1a0a0a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #f87171">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#f87171;margin-bottom:6px">⚠ Risk Flags Detected</div>
                ${rf.map(r => `
                    <div style="font-size:11px;color:#fca5a5;margin-bottom:3px">
                        <b style="color:${r.severity === 'high' ? '#ef4444' : r.severity === 'medium' ? '#f97316' : '#fbbf24'}">[${escapeHtml(r.severity || '')}]</b>
                        <code style="color:#fca5a5">${escapeHtml(r.flag || '')}</code> — <span style="color:#94a3b8">${escapeHtml(r.rule || '')}</span>
                    </div>`).join('')}
            </div>` : '';

        // Why it works
        const wiw = idea.why_it_works || [];
        const wiwBox = wiw.length ? `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #14b8a6">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Why it works</div>
                <ul style="font-size:11px;color:#cbd5e1;margin:0;padding-left:16px;line-height:1.55">
                    ${wiw.map(w => `<li>${escapeHtml(w)}</li>`).join('')}
                </ul>
            </div>` : '';

        // Validated video anchors — specific grounding from signals-dataset
        const anchorLineage = idea.synthesis_trace && idea.synthesis_trace.source_video_lineage;
        const anchorSourceTitle = anchorLineage && anchorLineage.name;
        const anchorsBox = renderValidatedVideoAnchors(idea.validated_video_anchors || [], anchorSourceTitle);

        // Synthesis derivation — compact view of how this idea was selected
        const synthesisBox = renderSynthesisBox(idea);

        // Validation trace — per-section lineage of every blueprint field
        const validation = idea.validation || null;
        const validationBox = validation ? renderValidationBox(validation) : '';

        return `
            <div style="background:#0d1424;border-radius:8px;padding:14px 16px;border:1px solid rgba(59,130,246,0.25);border-left:3px solid #22d3ee;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,0.25)">
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px;flex-wrap:wrap">
                    <div style="display:flex;gap:8px;align-items:baseline">
                        <span style="font-size:16px;font-weight:700;color:#facc15">#${idea.rank}</span>
                        <span style="font-size:14px;font-weight:700;color:#e2e8f0">${escapeHtml(idea.title || '')}</span>
                    </div>
                    <div style="font-size:10px;color:#64748b">design score <b style="color:#22d3ee">${score.total != null ? (+score.total).toFixed(3) : '—'}</b></div>
                </div>

                ${conceptBox}
                ${anchorsBox}
                ${metricsBox}
                ${openingBox}
                ${buildBox}
                ${climaxBox}
                ${arcBox}
                ${pacBox}
                ${vpBox}
                ${vocBox}
                ${sctBox}
                ${rfBox}
                ${wiwBox}
                ${synthesisBox}
                ${validationBox}

                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
                    ${partPill('hook', parts.hook, '#facc15')}
                    ${partPill('narrative', parts.narrative, '#a78bfa')}
                    ${partPill('duration', parts.duration, '#f59e0b')}
                    ${partPill('bridge', parts.bridge, '#ec4899')}
                    ${partPill('vocab', parts.vocabulary, '#86efac')}
                    ${partPill('interactions', parts.interactions, '#fb7185')}
                </div>
                ${narratives ? `<div style="margin-bottom:4px"><span style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-right:6px">Narrative</span>${narratives}</div>` : ''}
                ${levers ? `<div style="margin-bottom:4px"><span style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-right:6px">Pre-upload levers</span>${levers}</div>` : ''}
                ${interactions ? `<div style="margin-bottom:4px"><span style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-right:6px">Interactions engineered</span>${interactions}</div>` : ''}
                ${hooks ? `<div style="margin-top:8px;padding-top:6px;border-top:1px dashed #1e293b"><div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Hook mechanisms</div>${hooks}</div>` : ''}
                ${evidence ? `<details style="margin-top:8px"><summary style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;cursor:pointer">Evidence (${(idea.evidence || []).length})</summary><ul style="font-size:10px;line-height:1.55;margin:6px 0 0 16px;padding:0">${evidence}</ul></details>` : ''}
            </div>
        `;
    }

    function renderValidatedVideoAnchors(anchors, sourceTitle) {
        if (!anchors || !anchors.length) return '';
        const tierColor = (t) => t === 1 ? '#22c55e' : t === 2 ? '#fbbf24' : t === 3 ? '#94a3b8' : '#64748b';
        const tierLabel = (t) => t === 1 ? 'strong match' : t === 2 ? 'moderate match' : t === 3 ? 'concept match' : 'metric anchor';
        const fmtViews = (v) => v == null ? '?' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1000) + 'K';
        const familyNote = sourceTitle
            ? `source-video concepts from ${escapeHtml(sourceTitle)}`
            : 'title and premise overlap';
        const cards = anchors.map(a => `
            <div style="background:#0a1628;border-radius:5px;padding:8px 10px;border-left:2px solid ${tierColor(a.match_tier || 4)}">
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:3px">
                    <div style="font-size:11px;font-weight:600;color:#e2e8f0;flex:1">${escapeHtml(a.name || '')}</div>
                    <span style="font-size:9px;color:${tierColor(a.match_tier || 4)};text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap">${tierLabel(a.match_tier || 4)}</span>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:10px;margin-bottom:3px">
                    ${a.views != null ? `<span style="color:#94a3b8">${fmtViews(a.views)} views</span>` : ''}
                    ${a.keep != null ? `<span style="color:#22c55e">keep <b>${a.keep}%</b></span>` : ''}
                    ${a.retention != null ? `<span style="color:#22d3ee">ret <b>${(+a.retention).toFixed(1)}%</b></span>` : ''}
                    ${a.z_score != null ? `<span style="color:#a78bfa">z <b>${a.z_score}</b></span>` : ''}
                    ${a.ytId ? `<a href="https://www.youtube.com/watch?v=${escapeHtml(a.ytId)}" target="_blank" rel="noopener" style="color:#60a5fa;font-size:9px;text-decoration:none">YT ↗</a>` : ''}
                </div>
                <div style="font-size:9px;color:#64748b;line-height:1.4">${escapeHtml(a.why_this_matches || '')}</div>
            </div>`).join('');
        return `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #22c55e">
                <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#22c55e;margin-bottom:4px;font-weight:700">✦ Validated Video Anchors — Specific Dataset Evidence</div>
                <div style="font-size:10px;color:#64748b;margin-bottom:7px">Specific analyzed videos that share this idea's structure. Matched on title/premise tokens + ${familyNote}, ranked by z_score × keep_rate.</div>
                <div style="display:flex;flex-direction:column;gap:5px">${cards}</div>
            </div>`;
    }

    function renderValidationTraceRow(t) {
        if (!t) return '';
        const tops = (t.top_indicators || []).slice(0, 6).map(ind => {
            const chips = [];
            if (ind.rho != null) chips.push(`<span style="color:${ind.rho >= 0 ? '#22c55e' : '#f87171'}">ρ=${(+ind.rho).toFixed(3)}</span>`);
            if (ind.r_with_views != null) chips.push(`<span style="color:${ind.r_with_views >= 0 ? '#22c55e' : '#f87171'}">r=${(+ind.r_with_views).toFixed(3)}</span>`);
            if (ind.r_partial != null) chips.push(`<span style="color:${ind.r_partial >= 0 ? '#22c55e' : '#f87171'}">rₚ=${(+ind.r_partial).toFixed(3)}</span>`);
            if (ind.r_direct != null) chips.push(`<span style="color:${ind.r_direct >= 0 ? '#22c55e' : '#f87171'}">r=${(+ind.r_direct).toFixed(3)}</span>`);
            if (ind.r_to_views != null) chips.push(`<span style="color:${ind.r_to_views >= 0 ? '#22c55e' : '#f87171'}">r=${(+ind.r_to_views).toFixed(3)}</span>`);
            if (ind.csw != null) chips.push(`<span style="color:#facc15">csw=${(+ind.csw).toFixed(3)}</span>`);
            if (ind.score != null) chips.push(`<span style="color:#a78bfa">s=${(+ind.score).toFixed(2)}</span>`);
            if (ind.delta != null) chips.push(`<span style="color:${ind.delta >= 0 ? '#22c55e' : '#f87171'}">Δ=${(+ind.delta).toFixed(3)}</span>`);
            if (ind.n != null) chips.push(`<span style="color:#64748b">n=${ind.n}</span>`);
            if (ind.outcome_indicator) chips.push(`<span style="color:#94a3b8">→ ${escapeHtml(ind.outcome_indicator)}</span>`);
            const metaBits = [];
            if (ind.quantification) metaBits.push(`<b style="color:#94a3b8">quant:</b> ${escapeHtml(String(ind.quantification).slice(0, 180))}`);
            if (ind.modality) metaBits.push(`<b style="color:#94a3b8">modality:</b> ${escapeHtml(String(ind.modality).slice(0, 140))}`);
            if (ind.layer) metaBits.push(`<b style="color:#94a3b8">layer:</b> ${escapeHtml(ind.layer)}`);
            if (ind.signal) metaBits.push(`<b style="color:#94a3b8">signal:</b> ${escapeHtml(String(ind.signal).slice(0, 120))}`);
            const why = ind.why && !ind.quantification ? `<div style="color:#94a3b8;font-size:9px;margin-top:2px">${escapeHtml(String(ind.why).slice(0, 220))}</div>` : '';
            const notes = ind.notes ? `<div style="color:#64748b;font-size:9px;margin-top:2px;font-style:italic">${escapeHtml(String(ind.notes).slice(0, 220))}</div>` : '';
            return `
                <div style="padding:5px 8px;background:#0a1628;border-left:2px solid #22d3ee;border-radius:3px;margin-bottom:3px">
                    <div style="display:flex;gap:6px;align-items:baseline;flex-wrap:wrap">
                        <code style="color:#22d3ee;font-size:10px">${escapeHtml(ind.key || '')}</code>
                        ${chips.length ? `<span style="font-size:9px;color:#94a3b8">${chips.join(' · ')}</span>` : ''}
                        ${ind.evidence_type ? `<span style="font-size:8.5px;color:#64748b">[${escapeHtml(ind.evidence_type)}]</span>` : ''}
                    </div>
                    ${metaBits.length ? `<div style="color:#94a3b8;font-size:9px;margin-top:2px;line-height:1.45">${metaBits.join(' · ')}</div>` : ''}
                    ${why}
                    ${notes}
                </div>`;
        }).join('');
        const moreKeys = (t.indicator_keys || []).length > 6
            ? `<div style="color:#64748b;font-size:9px;margin-top:3px">+ ${(t.indicator_keys.length - 6)} more indicator keys</div>` : '';
        const keysChips = (t.indicator_keys || []).slice(0, 18).map(k => `<code style="background:#0f1a2d;color:#94a3b8;padding:1px 5px;border-radius:3px;font-size:9px;margin:1px">${escapeHtml(String(k))}</code>`).join('');
        return `
            <details style="margin-bottom:4px;background:#060d1a;border:1px solid #1e293b;border-radius:5px;padding:6px 10px">
                <summary style="cursor:pointer;font-size:10.5px;color:#e2e8f0;font-weight:600;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
                    <span>${escapeHtml(t.field || '')}</span>
                    <span style="font-weight:400;color:#94a3b8;font-size:9.5px">${t.indicator_keys_count || 0} used · pool ${t.indicators_considered_count || 0}</span>
                </summary>
                <div style="margin-top:6px;font-size:10px;color:#cbd5e1;line-height:1.5">
                    ${t.rationale ? `<div style="color:#cbd5e1;margin-bottom:4px">${escapeHtml(t.rationale)}</div>` : ''}
                    ${t.filter ? `<div style="color:#94a3b8;margin-bottom:4px"><b style="color:#64748b">filter:</b> <code style="color:#94a3b8;font-size:9px">${escapeHtml(t.filter)}</code></div>` : ''}
                    ${tops ? `<div style="margin-top:4px"><div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">top indicators</div>${tops}</div>` : ''}
                    ${keysChips ? `<details style="margin-top:4px"><summary style="font-size:9px;color:#64748b;cursor:pointer">all indicator keys (${(t.indicator_keys || []).length})</summary><div style="margin-top:4px;line-height:1.9">${keysChips}${moreKeys}</div></details>` : ''}
                    ${t.evidence_sources && t.evidence_sources.length ? `<div style="color:#64748b;font-size:9px;margin-top:6px">sources: ${t.evidence_sources.map(s => `<code style="color:#94a3b8">${escapeHtml(s)}</code>`).join(' · ')}</div>` : ''}
                </div>
            </details>`;
    }

    function renderEvidenceSummaryStrip(summary) {
        if (!summary) return '';
        const n = (v) => typeof v === 'number' ? v.toLocaleString() : (v != null ? String(v) : '—');
        const pill = (label, val, color) => `
            <span style="background:#0f1a2d;border:1px solid ${color}33;border-radius:4px;padding:3px 8px;font-size:10px;color:#cbd5e1;white-space:nowrap">
                <span style="color:${color};text-transform:uppercase;letter-spacing:0.05em;font-size:9px;margin-right:5px">${escapeHtml(label)}</span>
                <b style="color:#f1f5f9">${escapeHtml(n(val))}</b>
            </span>`;
        const uniqDetail = [];
        if (summary.unique_indicator_keys_used_in_sections != null) uniqDetail.push(`${n(summary.unique_indicator_keys_used_in_sections)} sec`);
        if (summary.unique_indicator_keys_used_in_metrics != null) uniqDetail.push(`${n(summary.unique_indicator_keys_used_in_metrics)} metric`);
        const altsDetail = [];
        if (summary.nearby_alternates_seed_stage != null) altsDetail.push(`${n(summary.nearby_alternates_seed_stage)} seed`);
        if (summary.nearby_alternates_final_rank != null) altsDetail.push(`${n(summary.nearby_alternates_final_rank)} final`);
        const poolBits = [];
        if (summary.seed_pool_candidates_considered != null) poolBits.push(`seed pool <b style="color:#cbd5e1">${n(summary.seed_pool_candidates_considered)}</b>`);
        if (summary.final_rank_pool_ideas_considered != null) poolBits.push(`final pool <b style="color:#cbd5e1">${n(summary.final_rank_pool_ideas_considered)}</b>`);
        return `
            <div style="background:#0a1628;border:1px solid #1e293b;border-radius:5px;padding:8px 10px;margin-bottom:8px">
                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:5px">
                    <div style="font-size:9px;color:#22d3ee;text-transform:uppercase;letter-spacing:0.06em;font-weight:700">evidence lineage summary</div>
                    ${poolBits.length ? `<div style="font-size:9px;color:#94a3b8">${poolBits.join(' · ')}</div>` : ''}
                </div>
                <div style="display:flex;gap:4px;flex-wrap:wrap">
                    ${pill('section traces', summary.section_trace_count, '#22d3ee')}
                    ${pill('metric traces', summary.metric_trace_count, '#22d3ee')}
                    ${pill('indicators considered', summary.indicators_considered_total_raw, '#94a3b8')}
                    ${pill('indicator uses (raw)', summary.indicator_keys_used_total_raw, '#a78bfa')}
                    ${pill('unique indicators used', summary.unique_indicator_keys_used, '#22c55e')}
                    ${pill('nearby alternates', summary.nearby_alternates_total, '#f59e0b')}
                </div>
                <div style="font-size:9px;color:#64748b;margin-top:4px;line-height:1.5">
                    ${uniqDetail.length ? `unique split: ${uniqDetail.join(' · ')}` : ''}
                    ${uniqDetail.length && altsDetail.length ? ' · ' : ''}
                    ${altsDetail.length ? `alternates split: ${altsDetail.join(' · ')}` : ''}
                </div>
                ${summary.note ? `<div style="font-size:9px;color:#64748b;margin-top:2px;font-style:italic">${escapeHtml(summary.note)}</div>` : ''}
            </div>`;
    }

    function renderValidationBox(validation) {
        const corpus = validation.corpus || {};
        const sections = validation.section_traces || {};
        const metrics = validation.metric_traces || {};
        const summary = validation.summary || null;
        const corpusRow = (label, v) => v != null && v !== 0 ? `<div><span style="color:#64748b">${escapeHtml(label)}</span> <b style="color:#e2e8f0">${typeof v === 'number' ? v.toLocaleString() : escapeHtml(String(v).slice(0, 80))}</b></div>` : '';
        const blueprintOrder = [
            'first_frame', 'first_line', 'opening_action', 'opening_speech_rate', 'hook_type',
            'build_phases', 'climax_and_payoff', 'arc', 'pacing',
            'visual_prescription', 'vocabulary_prescription', 'duration_target',
            'hook_mechanisms', 'pre_upload_levers', 'risk_flags', 'scorecard_targets',
        ];
        const synthesisOrder = ['creator_fit', 'proof_clarity', 'visual_legibility'];
        const knownSections = new Set([...blueprintOrder, ...synthesisOrder]);
        const extraSectionKeys = Object.keys(sections).filter(k => !knownSections.has(k));
        const blueprintRows = blueprintOrder.filter(k => sections[k]).map(k => renderValidationTraceRow(sections[k])).join('');
        const synthesisRows = synthesisOrder.filter(k => sections[k]).map(k => renderValidationTraceRow(sections[k])).join('');
        const extraSectionRows = extraSectionKeys.map(k => renderValidationTraceRow(sections[k])).join('');
        const metricOrder = ['swipe_away_rate', 'hook_retention_20s', 'share_propensity', 'keep_rate', 'view_band'];
        const knownMetrics = new Set(metricOrder);
        const extraMetricKeys = Object.keys(metrics).filter(k => !knownMetrics.has(k));
        const metricRows = metricOrder.filter(k => metrics[k]).map(k => renderValidationTraceRow(metrics[k])).join('');
        const extraMetricRows = extraMetricKeys.map(k => renderValidationTraceRow(metrics[k])).join('');
        return `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #22d3ee">
                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px">
                    <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#22d3ee;font-weight:700">◆ Validation trace — front-to-back indicator lineage</div>
                    <div style="font-size:9px;color:#64748b">${Object.keys(sections).length} sections · ${Object.keys(metrics).length} metrics · ${validation.catalog_enrichment ? 'catalog enriched' : 'catalog unavailable'}</div>
                </div>
                ${renderEvidenceSummaryStrip(summary)}
                <div style="background:#0a1628;border:1px solid #1e293b;border-radius:5px;padding:8px 10px;margin-bottom:8px">
                    <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">indicator corpus (filter-before pool sizes)</div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 12px;font-size:10.5px;color:#cbd5e1">
                        ${corpusRow('Indicator registry', corpus.indicator_registry_total)}
                        ${corpusRow('Mechanism↔indicator links', corpus.mechanism_indicator_links_total)}
                        ${corpusRow('|ρ| threshold', corpus.mechanism_indicator_links_threshold_abs_rho)}
                        ${corpusRow('Min n', corpus.mechanism_indicator_links_min_n)}
                        ${corpusRow('Principles', corpus.principles_total)}
                        ${corpusRow('Mechanisms', corpus.mechanisms_total)}
                        ${corpusRow('Components', corpus.components_total)}
                        ${corpusRow('Video pool', corpus.video_pool_n)}
                        ${corpusRow('Video scorecards', corpus.video_scorecards_n)}
                        ${corpusRow('Word-retention scored', corpus.word_retention_scored)}
                        ${corpusRow('Candidate proposal groups', corpus.candidate_proposal_diversity_buckets)}
                    </div>
                    ${corpus.mechanism_indicator_link_outcomes && corpus.mechanism_indicator_link_outcomes.length ? `<div style="font-size:9.5px;color:#64748b;margin-top:4px">link outcome keys: ${corpus.mechanism_indicator_link_outcomes.map(o => `<code style="color:#94a3b8">${escapeHtml(o)}</code>`).join(' · ')}</div>` : ''}
                    ${corpus.note ? `<div style="font-size:9px;color:#64748b;margin-top:4px;font-style:italic">${escapeHtml(corpus.note)}</div>` : ''}
                </div>
                ${blueprintRows ? `
                    <details open style="margin-bottom:6px">
                        <summary style="cursor:pointer;font-size:10px;color:#e2e8f0;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Section traces (blueprint fields)</summary>
                        <div style="margin-top:6px">${blueprintRows}</div>
                    </details>` : ''}
                ${synthesisRows ? `
                    <details open style="margin-bottom:6px">
                        <summary style="cursor:pointer;font-size:10px;color:#a78bfa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Synthesis-derived section traces (fit / proof / legibility)</summary>
                        <div style="margin-top:6px">${synthesisRows}</div>
                    </details>` : ''}
                ${extraSectionRows ? `
                    <details open style="margin-bottom:6px">
                        <summary style="cursor:pointer;font-size:10px;color:#fbbf24;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Other section traces (${extraSectionKeys.length})</summary>
                        <div style="margin-top:6px">${extraSectionRows}</div>
                    </details>` : ''}
                ${metricRows ? `
                    <details open style="margin-bottom:2px">
                        <summary style="cursor:pointer;font-size:10px;color:#e2e8f0;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Metric traces (modeled estimates)</summary>
                        <div style="margin-top:6px">${metricRows}</div>
                    </details>` : ''}
                ${extraMetricRows ? `
                    <details open style="margin-bottom:2px">
                        <summary style="cursor:pointer;font-size:10px;color:#fbbf24;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Other metric traces (${extraMetricKeys.length})</summary>
                        <div style="margin-top:6px">${extraMetricRows}</div>
                    </details>` : ''}
            </div>`;
    }

    function renderSynthesisBox(idea) {
        const st = idea && idea.synthesis_trace;
        if (!st) return '';
        const scoreChip = (label, val, color) => {
            if (val == null || isNaN(+val)) return '';
            const v = (+val);
            return `<span style="background:#0f1a2d;border:1px solid ${color}44;border-radius:4px;padding:2px 7px;font-size:10px;color:#cbd5e1">
                <span style="color:${color};text-transform:uppercase;letter-spacing:0.05em;font-size:9px;margin-right:4px">${escapeHtml(label)}</span>
                <b style="color:#f1f5f9">${v.toFixed(3)}</b>
            </span>`;
        };
        const cf = st.creator_fit || null;
        const pc = st.proof_clarity || null;
        const vl = st.visual_legibility || null;
        const chips = [
            scoreChip('premise', st.premise_score, '#a78bfa'),
            scoreChip('fit', cf && cf.score, '#22d3ee'),
            scoreChip('proof', pc && pc.score, '#22c55e'),
            scoreChip('legibility', vl && vl.score, '#fbbf24'),
        ].filter(Boolean).join(' ');
        const driverList = (drivers) => (drivers || []).slice(0, 4).map(d => {
            const delta = d.delta;
            const deltaColor = typeof delta === 'number' ? (delta >= 0 ? '#22c55e' : '#f87171') : '#94a3b8';
            const deltaStr = typeof delta === 'number' ? `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}` : '';
            return `<div style="font-size:10px;color:#cbd5e1;line-height:1.5">
                <code style="color:#22d3ee;font-size:10px">${escapeHtml(d.driver || '')}</code>
                ${deltaStr ? `<span style="color:${deltaColor};font-size:10px;margin-left:4px">${deltaStr}</span>` : ''}
                ${d.source ? `<span style="color:#64748b;font-size:9px;margin-left:4px">[${escapeHtml(d.source)}]</span>` : ''}
            </div>`;
        }).join('');
        const signalBlock = (label, color, o) => {
            if (!o) return '';
            const dcount = (o.drivers || []).length;
            return `<div style="background:#0a1628;border-left:2px solid ${color};border-radius:3px;padding:6px 8px;margin-bottom:4px">
                <div style="font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:${color};margin-bottom:3px">
                    ${escapeHtml(label)} <b style="color:#f1f5f9;margin-left:6px">${o.score != null ? (+o.score).toFixed(3) : '—'}</b>
                    <span style="color:#64748b;font-weight:normal;margin-left:6px">${dcount} driver${dcount === 1 ? '' : 's'}</span>
                </div>
                ${driverList(o.drivers)}
            </div>`;
        };
        const diversity = st.diversity_selection || {};
        const finalRank = st.final_rank_diversity || {};
        const seedAlts = st.seed_alternates || null;
        const finalAlts = st.final_rank_alternates || null;
        const svp = st.source_video_lineage || null;
        const fmtDelta = (d) => {
            if (d == null || isNaN(+d)) return '';
            const v = +d;
            const c = v > 0 ? '#fbbf24' : (v < 0 ? '#f87171' : '#94a3b8');
            const s = v === 0 ? '0' : (v > 0 ? '+' : '') + v.toFixed(3);
            return `<span style="color:${c}">${s}</span>`;
        };
        const seedAltRows = seedAlts && Array.isArray(seedAlts.nearby_rejected) ? seedAlts.nearby_rejected.map(a => {
            const endp = a.endpoint_id || a.endpoint_kind || '';
            return `<div style="font-size:10px;color:#cbd5e1;line-height:1.5;padding:2px 0;border-top:1px dashed #1e293b">
                <code style="color:#f59e0b">${escapeHtml(a.premise_id || '')}</code>${endp ? `<span style="color:#64748b"> · </span><code style="color:#22c55e;font-size:10px">${escapeHtml(endp)}</code>` : ''}
                <span style="color:#64748b;margin-left:4px">raw</span> <b style="color:#f1f5f9">${a.raw_score != null ? (+a.raw_score).toFixed(3) : '—'}</b>
                <span style="color:#64748b;margin-left:4px">Δ</span> ${fmtDelta(a.score_delta)}
                ${a.mmr_score != null ? ` <span style="color:#64748b;margin-left:4px">mmr</span> <b style="color:#f1f5f9">${(+a.mmr_score).toFixed(3)}</b>` : ''}
                ${a.similarity != null ? ` <span style="color:#64748b;margin-left:4px">sim</span> <b style="color:#f1f5f9">${(+a.similarity).toFixed(2)}</b>` : ''}
                <div style="font-size:9px;color:#94a3b8;margin-top:1px">${escapeHtml(a.rejection_reason || '')}</div>
            </div>`;
        }).join('') : '';
        const finalAltRows = finalAlts && Array.isArray(finalAlts.nearby_displaced) ? finalAlts.nearby_displaced.map(a => {
            const altLane = a.diversity_bucket;
            return `<div style="font-size:10px;color:#cbd5e1;line-height:1.5;padding:2px 0;border-top:1px dashed #1e293b">
                <code style="color:#f59e0b">${escapeHtml(a.idea_id || '')}</code>
                ${altLane ? `<span style="color:#64748b"> · </span><code style="color:#a78bfa;font-size:10px" title="source-video lane">${escapeHtml(altLane)}</code>` : ''}
                ${a.endpoint_kind ? `<span style="color:#64748b"> · </span><code style="color:#22c55e;font-size:10px">${escapeHtml(a.endpoint_kind)}</code>` : ''}
                <div style="font-size:10px;color:#cbd5e1;margin-top:1px">
                    <span style="color:#64748b">total</span> <b style="color:#f1f5f9">${a.blueprint_total != null ? (+a.blueprint_total).toFixed(3) : '—'}</b>
                    <span style="color:#64748b;margin-left:4px">Δ</span> ${fmtDelta(a.total_delta)}
                    ${a.mmr_score != null ? ` <span style="color:#64748b;margin-left:4px">mmr</span> <b style="color:#f1f5f9">${(+a.mmr_score).toFixed(3)}</b>` : ''}
                    ${a.similarity != null ? ` <span style="color:#64748b;margin-left:4px">sim</span> <b style="color:#f1f5f9">${(+a.similarity).toFixed(2)}</b>` : ''}
                </div>
                ${a.title ? `<div style="font-size:9px;color:#cbd5e1;margin-top:1px;font-style:italic">${escapeHtml(a.title)}</div>` : ''}
                <div style="font-size:9px;color:#94a3b8;margin-top:1px">${escapeHtml(a.rejection_reason || '')}</div>
            </div>`;
        }).join('') : '';
        const lattice = (st.derived_from_lattice || []).map(s =>
            `<li style="font-size:10px;color:#cbd5e1;line-height:1.5"><code style="color:#94a3b8">${escapeHtml(s)}</code></li>`
        ).join('');
        const premiseSig = st.validated_premise_signature || null;
        const remainingStatic = st.remaining_static_inputs || st.still_hardcoded || [];
        const hardcoded = remainingStatic.map(s =>
            `<li style="font-size:10px;color:#fca5a5;line-height:1.5"><code style="color:#fca5a5">${escapeHtml(s)}</code></li>`
        ).join('');
        const perEnd = finalRank.per_endpoint_kind_in_topN ? Object.entries(finalRank.per_endpoint_kind_in_topN).map(([e, n]) => `<code style="color:#22d3ee">${escapeHtml(e)}=${n}</code>`).join(' · ') : '';
        const perSurface = finalRank.per_proof_surface_in_topN ? Object.entries(finalRank.per_proof_surface_in_topN).map(([s, n]) => `<code style="color:#fbbf24">${escapeHtml(s)}=${n}</code>`).join(' · ') : '';

        return `
            <div style="background:#060d1a;border-radius:6px;padding:10px 12px;margin-bottom:8px;border-left:2px solid #a78bfa">
                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px">
                    <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#a78bfa;font-weight:700">◇ Synthesis derivation — how this idea was selected</div>
                    <div style="font-size:10px;color:#94a3b8">
                        ${st.proof_surface ? `proof surface <b style="color:#fbbf24">${escapeHtml(st.proof_surface)}</b>` : ''}
                        ${st.object_atom_id ? ` · premise <code style="color:#22d3ee">${escapeHtml(st.object_atom_id)}</code>` : ''}
                        ${st.endpoint_atom_id ? ` · endpoint <code style="color:#22c55e">${escapeHtml(st.endpoint_atom_id)}</code>` : ''}
                        ${st.scale_kind ? ` · scale <code style="color:#fbbf24">${escapeHtml(st.scale_kind)}${st.scale_value != null ? '=' + escapeHtml(String(st.scale_value)) : ''}</code>` : ''}
                        ${st.diversity_bucket ? ` · source-video lane <code style="color:#a78bfa">${escapeHtml(st.diversity_bucket)}</code>` : ''}
                    </div>
                </div>
                ${chips ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">${chips}</div>` : ''}
                ${premiseSig ? `
                    <div style="background:#08111f;border-left:2px solid #22c55e;border-radius:4px;padding:7px 8px;margin-bottom:6px">
                        <div style="font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:#22c55e;margin-bottom:3px">Validated premise signature</div>
                        <div style="font-size:10px;color:#cbd5e1;line-height:1.55">
                            ${premiseSig.proof_surface ? `<span style="color:#94a3b8">proof surface:</span> <code style="color:#fbbf24">${escapeHtml(premiseSig.proof_surface)}</code>` : ''}
                            ${premiseSig.visible_body_anchor ? ` · <span style="color:#94a3b8">body anchor:</span> <code style="color:#22d3ee">${escapeHtml(premiseSig.visible_body_anchor)}</code>` : ''}
                            ${premiseSig.scale_kind ? ` · <span style="color:#94a3b8">scale:</span> <code style="color:#22c55e">${escapeHtml(premiseSig.scale_kind)}${premiseSig.scale_value != null ? '=' + escapeHtml(String(premiseSig.scale_value)) : ''}</code>` : ''}
                            ${premiseSig.title_premise_line ? `<div><span style="color:#94a3b8">premise line:</span> <code style="color:#e2e8f0">${escapeHtml(premiseSig.title_premise_line)}</code></div>` : ''}
                            ${premiseSig.setting_hint ? `<div><span style="color:#94a3b8">setting:</span> ${escapeHtml(premiseSig.setting_hint)}</div>` : ''}
                            ${premiseSig.action_line ? `<div><span style="color:#94a3b8">action:</span> ${escapeHtml(premiseSig.action_line)}</div>` : ''}
                            ${premiseSig.first_frame_action ? `<div><span style="color:#94a3b8">first frame:</span> ${escapeHtml(premiseSig.first_frame_action)}</div>` : ''}
                        </div>
                    </div>` : ''}
                ${signalBlock('Creator fit', '#22d3ee', cf)}
                ${signalBlock('Proof clarity', '#22c55e', pc)}
                ${signalBlock('Visual legibility', '#fbbf24', vl)}
                ${diversity.reason || diversity.phase ? `
                    <div style="background:#0a1628;border-left:2px solid #ec4899;border-radius:3px;padding:6px 8px;margin-bottom:4px">
                        <div style="font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:#ec4899;margin-bottom:3px">Slate balancing</div>
                        <div style="font-size:10px;color:#cbd5e1;line-height:1.5">
                            <span style="color:#94a3b8">phase:</span> <code style="color:#ec4899">${escapeHtml(diversity.phase || '—')}</code>
                            ${diversity.raw_score != null ? ` · <span style="color:#94a3b8">raw</span> <b style="color:#f1f5f9">${(+diversity.raw_score).toFixed(3)}</b>` : ''}
                            ${diversity.mmr_score != null ? ` · <span style="color:#94a3b8">mmr</span> <b style="color:#f1f5f9">${(+diversity.mmr_score).toFixed(3)}</b>` : ''}
                            ${diversity.max_similarity_to_earlier_slots != null ? ` · <span style="color:#94a3b8">sim</span> <b style="color:#f1f5f9">${(+diversity.max_similarity_to_earlier_slots).toFixed(2)}</b>` : ''}
                            ${diversity.lambda != null ? ` · <span style="color:#94a3b8">λ</span> <b style="color:#f1f5f9">${escapeHtml(String(diversity.lambda))}</b>` : ''}
                        </div>
                        ${diversity.reason ? `<div style="font-size:10px;color:#cbd5e1;margin-top:3px;line-height:1.5">${escapeHtml(diversity.reason)}</div>` : ''}
                    </div>` : ''}
                ${(perSurface || perEnd) ? `
                    <div style="font-size:10px;color:#94a3b8;margin-bottom:4px">
                        ${perSurface ? `<span style="color:#64748b">top-N proof surfaces:</span> ${perSurface}` : ''}
                        ${perEnd ? ` · <span style="color:#64748b">endpoints:</span> ${perEnd}` : ''}
                    </div>` : ''}
                ${(seedAlts || finalAlts) ? `
                    <div style="background:#0a1628;border-left:2px solid #f59e0b;border-radius:3px;padding:6px 8px;margin-bottom:4px">
                        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:3px">
                            <div style="font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:#f59e0b">▸ Candidate pressure — why this idea won vs nearby alternates</div>
                            <div style="font-size:9px;color:#64748b">
                                ${seedAlts && seedAlts.candidates_considered != null ? `<span>seed pool <b style="color:#cbd5e1">${seedAlts.candidates_considered}</b>${(seedAlts.diversity_buckets_considered != null || seedAlts.families_considered != null) ? ` / <b style="color:#cbd5e1">${seedAlts.diversity_buckets_considered != null ? seedAlts.diversity_buckets_considered : seedAlts.families_considered}</b> source-video lanes` : ''}</span>` : ''}
                                ${finalAlts && finalAlts.ideas_considered != null ? ` · <span>final pool <b style="color:#cbd5e1">${finalAlts.ideas_considered}</b></span>` : ''}
                            </div>
                        </div>
                        ${seedAltRows ? `
                            <div style="margin-top:3px">
                                <div style="font-size:9px;color:#f59e0b;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:2px">Seed-stage rejected neighbors (same lane / MMR-fill runners-up)</div>
                                ${seedAltRows}
                            </div>` : ''}
                        ${finalAltRows ? `
                            <div style="margin-top:5px">
                                <div style="font-size:9px;color:#f59e0b;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:2px">Final-rank displaced blueprints (top-N MMR)</div>
                                ${finalAltRows}
                            </div>` : ''}
                        ${(seedAlts && seedAlts.note) || (finalAlts && finalAlts.note) ? `
                            <details style="margin-top:4px">
                                <summary style="cursor:pointer;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em">how this was measured</summary>
                                ${seedAlts && seedAlts.note ? `<div style="font-size:9px;color:#94a3b8;margin-top:3px;line-height:1.5"><b style="color:#f59e0b">seed:</b> ${escapeHtml(seedAlts.note)}</div>` : ''}
                                ${finalAlts && finalAlts.note ? `<div style="font-size:9px;color:#94a3b8;margin-top:3px;line-height:1.5"><b style="color:#f59e0b">final:</b> ${escapeHtml(finalAlts.note)}</div>` : ''}
                            </details>` : ''}
                    </div>` : ''}
                ${svp ? `
                    <div style="background:#0a1a0a;border-left:2px solid #4ade80;border-radius:4px;padding:7px 8px;margin-bottom:4px">
                        <div style="font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:#4ade80;margin-bottom:3px">▶ ${escapeHtml(svp.source_video_role === 'secondary' ? 'Secondary validated source video' : 'Primary validated source video')}</div>
                        <div style="font-size:10px;color:#cbd5e1;line-height:1.6">
                            <b style="color:#f1f5f9">${escapeHtml(svp.name || '')}</b>
                            <span style="color:#64748b;font-size:9px;margin-left:6px">ytId: <code style="color:#94a3b8">${escapeHtml(svp.ytId || '')}</code></span>
                        </div>
                        <div style="font-size:9px;color:#94a3b8;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">
                            ${svp.z_score != null ? `<span>z_score <b style="color:#4ade80">${svp.z_score}</b></span>` : ''}
                            ${svp.retention != null ? `<span>retention <b style="color:#22d3ee">${(+svp.retention).toFixed(1)}%</b></span>` : ''}
                            ${svp.keep != null ? `<span>keep <b style="color:#fbbf24">${svp.keep}%</b></span>` : ''}
                            ${svp.views != null ? `<span>views <b style="color:#a78bfa">${(+svp.views).toLocaleString()}</b></span>` : ''}
                            ${svp.quality_score != null ? `<span>quality <b style="color:#4ade80">${svp.quality_score}</b></span>` : ''}
                        </div>
                    </div>` : ''}
                ${lattice ? `
                    <details style="margin-top:4px">
                        <summary style="cursor:pointer;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em">derived from lattice (${(st.derived_from_lattice || []).length})</summary>
                        <ul style="margin:4px 0 0 16px;padding:0">${lattice}</ul>
                    </details>` : ''}
                ${hardcoded ? `
                    <details style="margin-top:3px">
                        <summary style="cursor:pointer;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em">remaining static inputs (${remainingStatic.length})</summary>
                        <ul style="margin:4px 0 0 16px;padding:0">${hardcoded}</ul>
                    </details>` : ''}
            </div>`;
    }

    // ══════════════════════════════════════════════════
    // TAB: PROJECT IDEAS — IP-anchored video premises
    // ══════════════════════════════════════════════════
    let projectIdeasData = null;
    let projectIdeasLoading = false;
    let projectIdeasError = null;
    let projectIdeasShowAddForm = false;
    let projectIdeasShowMethodology = false;
    let projectIdeasShowGenerate = false;

    async function loadProjectIdeas(force = false) {
        if (projectIdeasLoading) return;
        if (!force && projectIdeasData) return;
        projectIdeasLoading = true;
        projectIdeasError = null;
        refreshProjectIdeasRoot();
        try {
            const res = await fetch('/api/jarvis/project-ideas');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            projectIdeasData = await res.json();
        } catch (e) {
            projectIdeasError = e.message || String(e);
        }
        projectIdeasLoading = false;
        refreshProjectIdeasRoot();
    }

    function refreshProjectIdeasRoot() {
        const root = container?.querySelector('.jarvis-project-ideas-root');
        if (!root) return;
        root.innerHTML = renderProjectIdeasBody();
        bindProjectIdeasEvents();
    }

    // ══════════════════════════════════════════════════
    // TAB: Hook Model — 3-layer linear network
    //   pre-upload (text features)  →  post-upload (YT metrics)  →  log10(views)
    // ══════════════════════════════════════════════════
    let hookModelText = 'I built a piano that fires a real flame on every key I press';
    let hookModelWps = 4.4;
    let hookModelWindow = 10;
    let hookModelScore = null;
    let hookModelData = null;        // /nodes-v2 response: pre_nodes, post_nodes, weights
    let hookModelLoading = false;
    let hookModelError = null;
    let hookModelSelectedNode = null; // { layer: 'pre'|'post', key, ...meta }

    async function loadHookModelNodes() {
        if (hookModelData) return;
        try {
            const resp = await fetch('/api/jarvis/hook-model/nodes-v2');
            const data = await resp.json();
            hookModelData = data;
            if (data.wps_default) hookModelWps = parseFloat(data.wps_default.toFixed(2));
        } catch (e) {
            hookModelError = e.message;
        }
    }

    async function scoreHookModel() {
        if (hookModelLoading) return;
        hookModelLoading = true;
        refreshHookModelRoot();
        try {
            const resp = await fetch('/api/jarvis/hook-model/score-v2', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hook: hookModelText, wps: hookModelWps }),
            });
            hookModelScore = await resp.json();
            hookModelError = null;
        } catch (e) {
            hookModelError = e.message;
        }
        hookModelLoading = false;
        refreshHookModelRoot();
    }

    function refreshHookModelRoot() {
        const root = container?.querySelector('.jarvis-hook-model-root');
        if (!root) return;
        root.innerHTML = renderHookModelBody();
        bindHookModelEvents();
    }

    function renderHookModel() {
        if (!hookModelData && !hookModelLoading) {
            loadHookModelNodes().then(() => {
                refreshHookModelRoot();
                if (!hookModelScore) scoreHookModel();
            });
        }
        setTimeout(bindHookModelEvents, 30);
        return `<div class="jarvis-hook-model-root">${renderHookModelBody()}</div>`;
    }

    function fmtViewCount(v) {
        if (!isFinite(v)) return '—';
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
        return Math.round(v).toString();
    }

    function humanizeFeatureKey(fkey) {
        const m = fkey.match(/^(.+)_w(\d+)$/);
        if (!m) return fkey;
        return m[1].replace(/_/g, ' ') + ' @' + m[2] + 's';
    }

    function colorForActivation(act, maxAbs) {
        if (!maxAbs) return '#475569';
        const t = Math.max(-1, Math.min(1, act / maxAbs));
        if (t > 0) {
            // green ramp
            const a = 0.25 + 0.75 * t;
            return `rgba(34, 211, 153, ${a.toFixed(3)})`;
        } else {
            const a = 0.25 + 0.75 * Math.abs(t);
            return `rgba(248, 113, 113, ${a.toFixed(3)})`;
        }
    }

    // ─── Tier colors (which time-window does each word/node belong to) ───
    const HM_TIER_COLOR = {
        1:  '#60a5fa',  // blue
        3:  '#fbbf24',  // yellow
        5:  '#fb923c',  // orange
        10: '#f87171',  // red
    };
    const HM_TIER_BG = {
        1:  'rgba(96, 165, 250, 0.18)',
        3:  'rgba(251, 191, 36, 0.18)',
        5:  'rgba(251, 146, 60, 0.18)',
        10: 'rgba(248, 113, 113, 0.18)',
    };

    function renderHookModelBody() {
        if (hookModelError && !hookModelData) {
            return `<div style="color:#f87171;padding:14px">Failed to load hook model: ${escapeHtml(hookModelError)}</div>`;
        }
        if (!hookModelData) {
            return `<div style="color:#64748b;padding:14px">Loading hook model nodes…</div>`;
        }

        const score = hookModelScore;
        const meta = hookModelData;
        const modeBadge = meta.mode === 'measured'
            ? `<span style="background:#22c55e22;color:#22c55e;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">MEASURED · n=${meta.training_n || 372}</span>`
            : `<span style="background:#fbbf2422;color:#fbbf24;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">${escapeHtml(meta.mode || 'r-prior')}</span>`;

        const headerHtml = `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;gap:14px;flex-wrap:wrap">
                <div>
                    <div style="font-size:18px;font-weight:700;color:#f1f5f9">Hook Model v2 — 3-Layer Network</div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:3px">
                        ${meta.pre_nodes.length} pre-upload features → ${meta.post_nodes.length} post-upload metrics → log10(views)
                    </div>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                    ${modeBadge}
                    <span style="background:#1e293b;color:#cbd5e1;padding:2px 8px;border-radius:4px;font-size:10px">bias=${(meta.bias||0).toFixed(3)}</span>
                    <span style="background:#1e293b;color:#cbd5e1;padding:2px 8px;border-radius:4px;font-size:10px">σ=${(meta.log10_views_std||0).toFixed(3)}</span>
                </div>
            </div>`;

        return `
            ${headerHtml}
            <div style="display:grid;grid-template-columns:1fr 360px;gap:14px;align-items:start">
                <div>
                    ${renderHookScorerPanel(score)}
                    ${renderHookModelGraph(score)}
                </div>
                <div>
                    ${renderHookNodePanel()}
                </div>
            </div>
        `;
    }

    // Build a colored, word-level rendering of the hook with phrase
    // matches highlighted via underline, and per-word colored backgrounds
    // showing which time window each word falls in at the current WPS.
    function renderHighlightedHook(text, wps, matched) {
        if (!text) return '<span style="color:#64748b">—</span>';
        const dt = 1 / Math.max(wps || 4.4, 0.1);
        const words = text.split(/(\s+)/);
        const tokens = [];
        let wordIdx = 0;
        for (const tok of words) {
            if (/^\s+$/.test(tok)) { tokens.push({ type: 'space', text: tok }); continue; }
            if (!tok) continue;
            const t = wordIdx * dt;
            let tier = null;
            if (t < 1) tier = 1;
            else if (t < 3) tier = 3;
            else if (t < 5) tier = 5;
            else if (t < 10) tier = 10;
            tokens.push({ type: 'word', text: tok, t, tier, idx: wordIdx });
            wordIdx++;
        }

        // Mark which words are in matched phrases (any window)
        const allMatches = new Set();
        if (matched) for (const arr of Object.values(matched)) for (const m of (arr || [])) allMatches.add(m.toLowerCase());

        const lower = text.toLowerCase();
        const hitMask = new Array(tokens.length).fill(false);
        // Find phrases
        for (const phrase of allMatches) {
            if (!phrase) continue;
            let from = 0;
            while (true) {
                const at = lower.indexOf(phrase, from);
                if (at < 0) break;
                // Mark every word whose source position overlaps the phrase
                let pos = 0;
                for (let i = 0; i < tokens.length; i++) {
                    const t = tokens[i];
                    const start = pos;
                    pos += t.text.length;
                    if (t.type !== 'word') continue;
                    if (start < at + phrase.length && pos > at) hitMask[i] = true;
                }
                from = at + Math.max(1, phrase.length);
            }
        }

        let html = '';
        let pos = 0;
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (tok.type === 'space') { html += escapeHtml(tok.text); continue; }
            const tier = tok.tier;
            const bg = tier ? HM_TIER_BG[tier] : 'transparent';
            const border = tier ? HM_TIER_COLOR[tier] : '#1e293b';
            const underline = hitMask[i] ? `border-bottom:2px solid #fbbf24;` : '';
            const fontWeight = hitMask[i] ? 600 : 400;
            html += `<span title="t=${tok.t.toFixed(2)}s · @${tier || '>10'}s window" style="background:${bg};color:#f1f5f9;padding:1px 3px;border-radius:3px;border-left:2px solid ${border};${underline}font-weight:${fontWeight}">${escapeHtml(tok.text)}</span>`;
        }
        return html;
    }

    function renderHookScorerPanel(score) {
        const text = hookModelText;
        const matched = score && score.matched ? score.matched : {};
        const highlighted = renderHighlightedHook(text, hookModelWps, matched);

        // Word counts per window at current WPS
        const wpsVal = hookModelWps;
        const totalWords = (text || '').split(/\s+/).filter(Boolean).length;
        const wordsAt = (sec) => Math.min(totalWords, Math.max(0, Math.round(sec * wpsVal)));

        const predBlock = score ? `
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;background:#0a1628;border-radius:6px;padding:10px 12px">
                <div>
                    <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">Predicted views</div>
                    <div style="font-size:22px;font-weight:700;color:#22d3ee">${fmtViewCount(score.predicted_views)}</div>
                </div>
                <div>
                    <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">95% CI</div>
                    <div style="font-size:13px;color:#cbd5e1">[${fmtViewCount(score.ci_low)} — ${fmtViewCount(score.ci_high)}]</div>
                </div>
                <div>
                    <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">log10(views)</div>
                    <div style="font-size:13px;color:#cbd5e1">${score.log10_views.toFixed(3)}</div>
                </div>
            </div>` : '<div style="color:#64748b;padding:10px">Type a hook above and click Score…</div>';

        const contrib = score ? renderContributionBars(score.pre_contributions, score.post_contributions) : '';

        const wpsLegend = `
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;color:#cbd5e1">
                ${[1, 3, 5, 10].map(w => `
                    <span style="display:inline-flex;align-items:center;gap:5px">
                        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${HM_TIER_BG[w]};border-left:3px solid ${HM_TIER_COLOR[w]}"></span>
                        <span style="color:#94a3b8">@${w}s</span>
                        <span style="font-family:monospace;color:#f1f5f9">${wordsAt(w)} ${wordsAt(w) === 1 ? 'word' : 'words'}</span>
                    </span>
                `).join('')}
            </div>`;

        return `
            <div style="background:#0f172a;border-radius:8px;padding:14px;margin-bottom:14px;border:1px solid #1e293b">
                <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Hook Script</div>
                <textarea id="jarvis-hm-text" style="width:100%;min-height:80px;background:#0a1628;color:#f1f5f9;border:1px solid #1e293b;border-radius:6px;padding:10px;font-family:inherit;font-size:13px;line-height:1.5;resize:vertical;box-sizing:border-box">${escapeHtml(text)}</textarea>

                <div style="background:#0a1628;border-radius:6px;padding:10px 12px;margin-top:10px;border:1px solid #1e293b">
                    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
                        <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">Speaking rate</label>
                        <input type="range" id="jarvis-hm-wps" min="1.5" max="6" step="0.1" value="${hookModelWps}" style="flex:1;min-width:160px;max-width:240px">
                        <span id="jarvis-hm-wps-val" style="font-size:13px;color:#22d3ee;font-family:monospace;font-weight:700">${hookModelWps.toFixed(1)} wps</span>
                        <button id="jarvis-hm-score-btn" style="padding:6px 14px;background:#22d3ee;color:#0f172a;border:none;border-radius:4px;font-weight:700;font-size:12px;cursor:pointer">${hookModelLoading ? 'Scoring…' : 'Score'}</button>
                    </div>
                    <div id="jarvis-hm-wps-legend">${wpsLegend}</div>
                </div>

                <div style="background:#0a1628;border-radius:6px;padding:10px 12px;margin-top:10px;font-size:14px;color:#cbd5e1;line-height:2">
                    <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Hook (colored by time window · underline = phrase match)</div>
                    ${highlighted}
                </div>

                <div style="display:flex;gap:4px;margin-top:10px;flex-wrap:wrap">
                    ${[1, 3, 5, 10].map(w => `<button data-window="${w}" class="jarvis-hm-window-btn" style="padding:4px 10px;border-radius:4px;background:${hookModelWindow === w ? HM_TIER_COLOR[w] : '#1e293b'};color:${hookModelWindow === w ? '#0f172a' : '#cbd5e1'};border:none;font-size:11px;font-weight:600;cursor:pointer">@${w}s</button>`).join('')}
                    <span style="font-size:10px;color:#64748b;align-self:center;margin-left:4px">selects active window for the graph</span>
                </div>

                <div style="margin-top:10px">${predBlock}</div>
                ${contrib}
            </div>`;
    }

    function renderContributionBars(preContribs, postContribs) {
        if (!preContribs || !preContribs.length) return '';
        const topPre = preContribs.slice(0, 10);
        const maxPre = Math.max(...topPre.map(c => Math.abs(c.contribution)), 0.001);
        const preRows = topPre.map(c => {
            const pct = (Math.abs(c.contribution) / maxPre) * 100;
            const color = c.contribution >= 0 ? '#22d3ee' : '#f87171';
            const tier = HM_TIER_COLOR[c.window] || '#94a3b8';
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;cursor:pointer" data-pre-key="${escapeHtml(c.key)}">
                <div style="flex:0 0 220px;font-size:11px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${tier};margin-right:6px"></span>${escapeHtml(humanizeFeatureKey(c.key))}
                </div>
                <div style="flex:1;background:#0a1628;border-radius:3px;height:11px;position:relative;overflow:hidden">
                    <div style="background:${color};height:100%;width:${pct.toFixed(1)}%"></div>
                </div>
                <div style="flex:0 0 80px;font-size:10px;font-family:monospace;color:${color};text-align:right">${c.contribution >= 0 ? '+' : ''}${c.contribution.toFixed(3)}</div>
            </div>`;
        }).join('');

        const maxPost = Math.max(...(postContribs || []).map(c => Math.abs(c.contribution)), 0.001);
        const postRows = (postContribs || []).map(c => {
            const pct = (Math.abs(c.contribution) / maxPost) * 100;
            const color = c.contribution >= 0 ? '#22d3ee' : '#f87171';
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;cursor:pointer" data-post-key="${escapeHtml(c.key)}">
                <div style="flex:0 0 220px;font-size:11px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.label || c.key)}</div>
                <div style="flex:1;background:#0a1628;border-radius:3px;height:11px;position:relative;overflow:hidden">
                    <div style="background:${color};height:100%;width:${pct.toFixed(1)}%"></div>
                </div>
                <div style="flex:0 0 80px;font-size:10px;font-family:monospace;color:${color};text-align:right">${c.contribution >= 0 ? '+' : ''}${c.contribution.toFixed(3)}</div>
            </div>`;
        }).join('');

        return `<div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div>
                <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Top pre-upload contributions</div>
                ${preRows}
            </div>
            <div>
                <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Post-upload → views</div>
                ${postRows}
            </div>
        </div>`;
    }

    function renderHookModelGraph(score) {
        if (!hookModelData) return '';
        const data = hookModelData;
        const preNodes = data.pre_nodes || [];
        const postNodes = data.post_nodes || [];

        const activeWin = hookModelWindow;
        const TIME_WINS = [1, 3, 5, 10];

        // Group the 4 per-window pre nodes into a single indicator group so we
        // can render each indicator as a vector bar [@1s|@3s|@5s|@10s].
        const indicatorKeys = [];
        const indicatorMeta = {};
        for (const n of preNodes) {
            if (!indicatorMeta[n.indicator_key]) {
                indicatorKeys.push(n.indicator_key);
                indicatorMeta[n.indicator_key] = {
                    label: n.label || n.indicator_key.replace(/_/g, ' '),
                    byWin: {},
                };
            }
            indicatorMeta[n.indicator_key].byWin[n.window] = n;
        }

        // Layout
        const labelW = 150, cellW = 22, cellH = 16, cellGap = 1;
        const vectorW = TIME_WINS.length * (cellW + cellGap) - cellGap;
        const rowH = 24;
        const W = 940;
        const xPre = 14;
        const vectorStartX = xPre + labelW;
        const vectorEndX = vectorStartX + vectorW;
        const xPost = 580, xView = W - 70;
        const headerY = 30;
        const yStartPre = 50;
        const H = Math.max(440, indicatorKeys.length * rowH + yStartPre + 30);
        const yStartPost = 60;
        const yStepPost = (H - 100) / Math.max(postNodes.length - 1, 1);
        const yForPre = (i) => yStartPre + i * rowH + cellH / 2;

        // Color scaling for cells: largest absolute z across all (indicator × window) cells.
        let maxPreZ = 0.5;
        if (score && score.pre_detail) {
            for (const fk in score.pre_detail) {
                maxPreZ = Math.max(maxPreZ, Math.abs(score.pre_detail[fk].zscore || 0));
            }
        }

        const maxPostAbs = Math.max(...postNodes.map(p => {
            const c = score && score.post_contributions ? score.post_contributions.find(x => x.key === p.key) : null;
            return Math.abs((c || {}).contribution || 0);
        }), 0.01);

        // Edges pre→post: anchor on the active window's cell so the visible
        // weight set matches the highlighted column.
        const preToPost = data.pre_to_post_weights || {};
        const maxEdgeW = Math.max(...postNodes.flatMap(p => Object.values(preToPost[p.key] || {}).map(Math.abs)), 0.01);
        const activeCellIdx = TIME_WINS.indexOf(activeWin);
        const activeCellRightX = vectorStartX + (activeCellIdx + 1) * (cellW + cellGap) - cellGap;
        const edgesPP = [];
        indicatorKeys.forEach((ik, i) => {
            const fk = `${ik}_w${activeWin}`;
            const py = yForPre(i);
            postNodes.forEach((post, j) => {
                const w = (preToPost[post.key] || {})[fk] || 0;
                if (Math.abs(w) < 0.05) return;
                const qy = yStartPost + j * yStepPost;
                const stroke = w >= 0 ? 'rgba(34, 211, 153,' : 'rgba(248, 113, 113,';
                const a = 0.15 + 0.55 * (Math.abs(w) / maxEdgeW);
                const sw = Math.max(0.4, Math.abs(w) / maxEdgeW * 2.8);
                edgesPP.push(`<path d="M ${activeCellRightX + 1} ${py} C ${(activeCellRightX + xPost) / 2} ${py}, ${(activeCellRightX + xPost) / 2} ${qy}, ${xPost - 22} ${qy}" stroke="${stroke}${a.toFixed(3)})" stroke-width="${sw.toFixed(2)}" fill="none"/>`);
            });
        });

        // Edges post→views
        const postToViews = data.post_to_views_weights || {};
        const maxPVAbs = Math.max(...Object.values(postToViews).map(Math.abs), 0.01);
        const edgesPV = postNodes.map((post, j) => {
            const qy = yStartPost + j * yStepPost;
            const w = postToViews[post.key] || 0;
            const stroke = w >= 0 ? 'rgba(34, 211, 153,' : 'rgba(248, 113, 113,';
            const a = 0.25 + 0.55 * (Math.abs(w) / maxPVAbs);
            const sw = Math.max(0.6, Math.abs(w) / maxPVAbs * 4);
            return `<path d="M ${xPost + 22} ${qy} C ${(xPost + xView) / 2} ${qy}, ${(xPost + xView) / 2} ${H/2}, ${xView - 28} ${H/2}" stroke="${stroke}${a.toFixed(3)})" stroke-width="${sw.toFixed(2)}" fill="none"/>`;
        }).join('');

        // Pre nodes — vector bars (label + 4 cells per indicator)
        const preGroups = indicatorKeys.map((ik, i) => {
            const py = yForPre(i);
            const meta = indicatorMeta[ik];
            const labelTxt = meta.label;

            // Per-window cells
            const cellsHtml = TIME_WINS.map((w, k) => {
                const fk = `${ik}_w${w}`;
                const detail = score && score.pre_detail ? score.pre_detail[fk] : null;
                const z = detail ? (detail.zscore || 0) : 0;
                const value = detail ? detail.value : null;
                const cellX = vectorStartX + k * (cellW + cellGap);
                const cellY = yStartPre + i * rowH;
                const fill = detail ? colorForActivation(z, maxPreZ) : '#0a1628';
                const border = HM_TIER_COLOR[w];
                const isActive = w === activeWin;
                const strokeW = isActive ? 2.2 : 0.7;
                let valTxt = '';
                if (value != null) {
                    if (Number.isInteger(value)) valTxt = String(value);
                    else if (Math.abs(value) < 1) valTxt = value.toFixed(2);
                    else valTxt = value.toFixed(1);
                }
                const textColor = (Math.abs(z) > 0.4 || (value != null && value !== 0)) ? '#0a1628' : '#475569';
                return `<g class="jarvis-hm-pre" data-pre-key="${escapeHtml(fk)}" style="cursor:pointer">
                    <title>${escapeHtml(labelTxt)} @${w}s · value=${valTxt || '0'} · z=${z.toFixed(2)}</title>
                    <rect x="${cellX}" y="${cellY}" width="${cellW}" height="${cellH}" fill="${fill}" stroke="${border}" stroke-width="${strokeW}" rx="2"/>
                    <text x="${cellX + cellW / 2}" y="${cellY + cellH / 2 + 3.2}" text-anchor="middle" fill="${textColor}" style="font-size:9px;font-family:monospace;font-weight:700;pointer-events:none">${escapeHtml(valTxt)}</text>
                </g>`;
            }).join('');

            // Label area is its own click target (selects active window node)
            const labelGroup = `<g class="jarvis-hm-pre" data-pre-key="${escapeHtml(`${ik}_w${activeWin}`)}" style="cursor:pointer">
                <rect x="${xPre}" y="${yStartPre + i * rowH}" width="${labelW - 4}" height="${cellH}" fill="transparent"/>
                <text x="${vectorStartX - 6}" y="${py + 3}" text-anchor="end" fill="#cbd5e1" style="font-size:10px;font-family:monospace">${escapeHtml(labelTxt)}</text>
            </g>`;

            return labelGroup + cellsHtml;
        }).join('');

        // Header row for the vector cells
        const headerCells = TIME_WINS.map((w, k) => {
            const cx = vectorStartX + k * (cellW + cellGap) + cellW / 2;
            const fill = HM_TIER_COLOR[w];
            const isActive = w === activeWin;
            return `<text x="${cx}" y="${headerY + 14}" text-anchor="middle" fill="${fill}" style="font-size:9px;font-family:monospace;font-weight:${isActive ? '800' : '600'}">@${w}s</text>`;
        }).join('');

        // Post nodes (unchanged shape)
        const postCircles = postNodes.map((post, j) => {
            const qy = yStartPost + j * yStepPost;
            const c = score && score.post_contributions ? score.post_contributions.find(x => x.key === post.key) : null;
            const z = c ? c.zscore : 0;
            const contrib = c ? c.contribution : 0;
            const r = 14 + Math.min(12, Math.abs(contrib) / maxPostAbs * 10);
            const fill = colorForActivation(contrib, maxPostAbs);
            const isHookDrop = post.key === 'hook_drop_rate';
            return `<g class="jarvis-hm-post" data-post-key="${escapeHtml(post.key)}" style="cursor:pointer">
                <circle cx="${xPost}" cy="${qy}" r="${r.toFixed(1)}" fill="${fill}" stroke="#22d3ee" stroke-width="${isHookDrop ? 2.5 : 1.5}"/>
                <text x="${xPost}" y="${qy + 3}" text-anchor="middle" fill="#0a1628" style="font-size:9px;font-weight:700;pointer-events:none">${escapeHtml(post.label || post.key)}</text>
                <text x="${xPost}" y="${qy + r + 12}" text-anchor="middle" fill="#94a3b8" style="font-size:9px;font-family:monospace;pointer-events:none">z=${z.toFixed(2)} · r→v=${(post.r_with_views ?? 0).toFixed(2)}</text>
            </g>`;
        }).join('');

        const outNode = `
            <circle cx="${xView}" cy="${H/2}" r="28" fill="#22d3ee" stroke="#0f172a" stroke-width="2"/>
            <text x="${xView}" y="${H/2 - 2}" text-anchor="middle" fill="#0f172a" style="font-size:11px;font-weight:700">log10(v)</text>
            ${score ? `<text x="${xView}" y="${H/2 + 12}" text-anchor="middle" fill="#0f172a" style="font-size:10px;font-family:monospace;font-weight:700">${score.log10_views.toFixed(2)}</text>` : ''}
            ${score ? `<text x="${xView}" y="${H/2 + 48}" text-anchor="middle" fill="#22d3ee" style="font-size:11px;font-family:monospace;font-weight:700">${fmtViewCount(score.predicted_views)}</text>` : ''}
            ${score ? `<text x="${xView}" y="${H/2 + 62}" text-anchor="middle" fill="#94a3b8" style="font-size:9px">predicted views</text>` : ''}
        `;

        const colHeaders = `
            <text x="${vectorStartX + vectorW / 2}" y="${headerY}" text-anchor="middle" fill="#64748b" style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em">Pre-upload (vector)</text>
            <text x="${xPost}" y="${headerY}" text-anchor="middle" fill="#64748b" style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em">Post-upload metrics</text>
            <text x="${xView}" y="${headerY}" text-anchor="middle" fill="#64748b" style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em">log10(views)</text>
        `;

        return `
            <div style="background:#0f172a;border-radius:8px;border:1px solid #1e293b;padding:12px;margin-bottom:14px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:14px;flex-wrap:wrap">
                    <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b">3-Layer Network · pre nodes are vectors [@1s|@3s|@5s|@10s] · edges drawn from active window @${activeWin}s</div>
                    <div style="font-size:10px;color:#64748b">click any cell or label for details</div>
                </div>
                <div style="overflow:auto;max-height:600px;background:#0a1628;border-radius:6px;border:1px solid #1e293b">
                    <svg id="jarvis-hm-graph" width="${W}" height="${H}" style="display:block">
                        ${colHeaders}
                        ${headerCells}
                        ${edgesPP.join('')}
                        ${edgesPV}
                        ${preGroups}
                        ${postCircles}
                        ${outNode}
                    </svg>
                </div>
                <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#64748b;margin-top:6px">
                    <span><span style="display:inline-block;width:10px;height:3px;background:rgba(34,211,153,0.6);vertical-align:middle"></span> positive correlation</span>
                    <span><span style="display:inline-block;width:10px;height:3px;background:rgba(248,113,113,0.6);vertical-align:middle"></span> negative correlation</span>
                    <span>Edge width = |r|</span>
                    <span>Cell color = z-score for that window</span>
                    <span>Cell number = raw value</span>
                </div>
            </div>`;
    }

    function renderHookNodePanel() {
        if (!hookModelSelectedNode) {
            return `<div style="background:#0f172a;border-radius:8px;border:1px solid #1e293b;padding:12px;color:#64748b;font-size:12px">
                <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:6px">Node Detail</div>
                Click any pre-upload (left) or post-upload (middle) node to see what it measures, the exact phrase list it matches, its r-value with views, and how it composes through the network for this hook.
            </div>`;
        }
        if (hookModelSelectedNode.layer === 'post') return renderPostNodePanel(hookModelSelectedNode);
        return renderPreNodePanel(hookModelSelectedNode);
    }

    // Human-readable description of the exact algorithm a given indicator uses
    // so the node-detail panel can show "what this node actually computes"
    // alongside the phrase list.
    function describeIndicatorAlgorithm(indicatorKey, wordList) {
        const ALGO = {
            pivot_word_count: 'Counts whole-word matches (case-insensitive, word-boundary regex).',
            sensory_count: 'Splits into words, counts those in the sensory word-set (after stripping punctuation).',
            open_loop_count: 'Counts substring occurrences of any open-loop phrase in the windowed text.',
            open_loop_count_first_half: 'Same as open_loop_count but only over the first half of the windowed text (by word count).',
            proof_of_work_count: 'Counts substring occurrences of any proof-of-work phrase.',
            contrast_count: 'Counts substring occurrences of any contrast phrase.',
            action_verb_count: 'Counts substring occurrences of any action verb / -ing form.',
            repeated_phrase_count: 'Walks all bigrams (2-word phrases). Counts those that appear 2+ times with ≥10 words between occurrences.',
            unique_word_ratio: 'unique_words ÷ total_words (Jaccard-style vocabulary diversity).',
            hapax_legomena_ratio: 'words_appearing_exactly_once ÷ total_words.',
            beat_count: 'Splits on .!? then counts sentences whose first word is one of: So, And then, Now, But then, Then, After, Before, When, Until, Because, Which means.',
            transcript_word_count: 'Total word count after whitespace split.',
            transcript_char_count: 'Total character count of the windowed text.',
            hook_word_ratio: 'count(words in {what, how, why, will, can, could, would, watch, see, look, check, wait, but, if}) ÷ total_words.',
            hook_phrase_diversity: 'Number of distinct families present (open_loop, contrast, action_verb, proof_of_work, sensory). 0–5.',
            anticipation_escalation_position_pct: 'Position (0–1) of the FIRST escalation phrase scanned with a 6-word rolling window. 0 = none found.',
        };
        const algoLine = ALGO[indicatorKey] || 'Computed from text statistics on the windowed hook (no fixed phrase list).';
        const wlLine = (wordList && wordList.length)
            ? ` Phrase list contains ${wordList.length} ${wordList.length === 1 ? 'entry' : 'entries'}.`
            : '';
        return algoLine + wlLine;
    }

    function renderPreNodePanel(n) {
        const data = hookModelData;
        const score = hookModelScore;
        const preDetail = score && score.pre_detail ? score.pre_detail[n.key] : null;
        const matched = preDetail ? preDetail.matched : (n.matched || []);
        const value = preDetail ? preDetail.value : null;
        const z = preDetail ? preDetail.zscore : null;
        const TIME_WINS = [1, 3, 5, 10];

        // Precompute per-window detail so multiple sections can share it
        const perWindow = TIME_WINS.map(win => {
            const fk = `${n.indicator_key}_w${win}`;
            const sd = score && score.pre_detail ? score.pre_detail[fk] : null;
            const sc = score && score.pre_contributions ? score.pre_contributions.find(c => c.key === fk) : null;
            return {
                win, fk,
                value: sd ? sd.value : null,
                zscore: sd ? sd.zscore : null,
                contribution: sc ? sc.contribution : null,
                matched: sd ? (sd.matched || []) : [],
            };
        });

        const allMatched = new Set();
        perWindow.forEach(pw => pw.matched.forEach(m => allMatched.add((m || '').toLowerCase())));

        // ── Algorithm section ──
        const algoText = describeIndicatorAlgorithm(n.indicator_key, n.wordList);
        const wordListBlock = (n.wordList && n.wordList.length)
            ? `<div style="display:flex;flex-wrap:wrap;gap:3px;max-height:180px;overflow:auto;margin-top:6px">${n.wordList.map(p => {
                const isMatched = allMatched.has(p.toLowerCase());
                return `<code style="background:${isMatched ? '#fbbf2444' : '#0a1628'};color:${isMatched ? '#fbbf24' : '#94a3b8'};padding:1px 5px;border-radius:3px;font-size:10px;border:1px solid ${isMatched ? '#fbbf24' : '#1e293b'};font-weight:${isMatched ? '700' : '400'}">${escapeHtml(p)}</code>`;
            }).join('')}</div>`
            : '';

        // ── Computed values vector (4 cells) ──
        let maxAbsZ = 0.5;
        perWindow.forEach(pw => { if (pw.zscore != null) maxAbsZ = Math.max(maxAbsZ, Math.abs(pw.zscore)); });
        const vectorCells = perWindow.map(pw => {
            const fill = pw.zscore != null ? colorForActivation(pw.zscore, maxAbsZ) : '#0a1628';
            const border = HM_TIER_COLOR[pw.win];
            const valTxt = pw.value == null ? '—'
                : (Number.isInteger(pw.value) ? String(pw.value)
                : (Math.abs(pw.value) < 1 ? pw.value.toFixed(3) : pw.value.toFixed(2)));
            const isActive = pw.win === n.window;
            return `<div style="flex:1;background:${fill};border:${isActive ? '2.5px' : '1px'} solid ${border};border-radius:4px;padding:8px 4px;text-align:center;min-width:0;cursor:pointer" data-pre-key="${escapeHtml(pw.fk)}" title="@${pw.win}s · click to inspect">
                <div style="font-size:9px;color:${border};text-transform:uppercase;letter-spacing:0.05em;font-weight:700">@${pw.win}s</div>
                <div style="font-size:18px;font-weight:800;color:#0a1628;font-family:monospace;line-height:1.1;margin-top:2px">${escapeHtml(valTxt)}</div>
                <div style="font-size:9px;color:#0f172a;font-family:monospace;margin-top:2px">z=${pw.zscore != null ? pw.zscore.toFixed(2) : '—'}</div>
            </div>`;
        }).join('');

        // Computed values numerical table (raw / z / contrib per window)
        const windowRows = perWindow.map(pw => {
            const isCurrent = pw.win === n.window;
            const tier = HM_TIER_COLOR[pw.win];
            const v = pw.value;
            const zz = pw.zscore;
            const cb = pw.contribution;
            return `<tr style="${isCurrent ? 'background:#0a1628' : ''};cursor:pointer" data-pre-key="${escapeHtml(pw.fk)}">
                <td style="padding:3px 8px;font-size:11px;color:${isCurrent ? tier : '#cbd5e1'};font-weight:${isCurrent ? '700' : '400'}">@${pw.win}s</td>
                <td style="padding:3px 8px;font-size:11px;color:#cbd5e1;font-family:monospace;text-align:right">${v != null ? (Number.isInteger(v) ? v : v.toFixed(3)) : '—'}</td>
                <td style="padding:3px 8px;font-size:11px;color:#94a3b8;font-family:monospace;text-align:right">${zz != null ? zz.toFixed(2) : '—'}</td>
                <td style="padding:3px 8px;font-size:11px;font-family:monospace;text-align:right;color:${cb != null && cb >= 0 ? '#22d3ee' : '#f87171'}">${cb != null ? (cb >= 0 ? '+' : '') + cb.toFixed(3) : '—'}</td>
            </tr>`;
        }).join('');

        // ── Matched phrases per window ──
        const matchedRows = perWindow.map(pw => {
            const tier = HM_TIER_COLOR[pw.win];
            return `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:5px">
                <span style="display:inline-block;background:${tier};color:#0f172a;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;flex:0 0 38px;text-align:center">@${pw.win}s</span>
                <div style="flex:1;display:flex;flex-wrap:wrap;gap:3px;min-width:0">
                    ${pw.matched.length
                        ? pw.matched.slice(0, 40).map(m => `<code style="background:#fbbf2433;color:#fbbf24;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600;border:1px solid #fbbf2466">${escapeHtml(m)}</code>`).join('')
                        : '<span style="color:#475569;font-size:10px;font-style:italic">(no matches in this window)</span>'}
                </div>
            </div>`;
        }).join('');

        const totalMatched = perWindow.reduce((acc, pw) => acc + pw.matched.length, 0);

        // ── Pre→post weights (which post metric does this node most affect?) ──
        const ptp = data && data.pre_to_post_weights ? data.pre_to_post_weights : {};
        const postRows = (data && data.post_nodes ? data.post_nodes : []).map(post => {
            const w = (ptp[post.key] || {})[n.key] || 0;
            const color = w >= 0 ? '#22d3ee' : '#f87171';
            const pct = Math.min(100, (Math.abs(w) / 0.5) * 100);
            return `<tr><td style="padding:3px 8px;font-size:11px;color:#cbd5e1">${escapeHtml(post.label || post.key)}</td>
                <td style="padding:3px 8px;font-size:10px;font-family:monospace;text-align:right;color:${color}">${w >= 0 ? '+' : ''}${w.toFixed(3)}</td>
                <td style="padding:3px 8px"><div style="background:#0a1628;height:6px;border-radius:2px;overflow:hidden"><div style="background:${color};height:100%;width:${pct.toFixed(1)}%"></div></div></td></tr>`;
        }).join('');

        const r = n.r_with_views;
        const tier = HM_TIER_COLOR[n.window] || '#22d3ee';

        return `
            <div style="background:#0f172a;border-radius:8px;border:1px solid #1e293b;padding:14px;position:sticky;top:8px;max-height:calc(100vh - 80px);overflow-y:auto">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px">
                    <div>
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
                            <span style="background:${tier};color:#0f172a;font-weight:700;padding:1px 7px;border-radius:3px;font-size:10px">@${n.window}s active</span>
                            <span style="background:#06b6d422;color:#22d3ee;padding:1px 7px;border-radius:3px;font-size:10px;font-weight:600">PRE-UPLOAD</span>
                        </div>
                        <div style="font-size:14px;font-weight:700;color:#f1f5f9">${escapeHtml(n.label || n.indicator_key)}</div>
                        <code style="font-size:10px;color:#64748b">${escapeHtml(n.indicator_key)}</code>
                    </div>
                    <button id="jarvis-hm-close-node" style="background:none;border:none;color:#64748b;font-size:16px;cursor:pointer">×</button>
                </div>

                ${n.description ? `<div style="font-size:12px;color:#94a3b8;line-height:1.6;margin-bottom:10px">${escapeHtml(n.description)}</div>` : ''}

                <div style="background:#0a1628;border-radius:6px;padding:8px;margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">
                    <div><span style="color:#64748b">r vs views:</span> <span style="color:${r >= 0 ? '#22d3ee' : '#f87171'};font-weight:700;font-family:monospace">${r != null ? (r >= 0 ? '+' : '') + r.toFixed(3) : '—'}</span></div>
                    <div><span style="color:#64748b">n videos:</span> <span style="color:#cbd5e1;font-family:monospace">${n.n_videos != null ? n.n_videos : '—'}</span></div>
                    <div><span style="color:#64748b">value @${n.window}s:</span> <span style="color:#f1f5f9;font-family:monospace">${value != null ? (Number.isInteger(value) ? value : value.toFixed(3)) : '—'}</span></div>
                    <div><span style="color:#64748b">z-score:</span> <span style="color:${(z||0) >= 0 ? '#22d3ee' : '#f87171'};font-family:monospace">${z != null ? z.toFixed(2) + 'σ' : '—'}</span></div>
                </div>

                <div style="background:#0a1628;border-radius:6px;padding:10px;margin-bottom:10px;border-left:3px solid #a78bfa">
                    <div style="font-size:10px;color:#a78bfa;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:5px">1. Algorithm</div>
                    <div style="font-size:12px;color:#cbd5e1;line-height:1.55">${escapeHtml(algoText)}</div>
                    ${wordListBlock}
                </div>

                <div style="background:#0a1628;border-radius:6px;padding:10px;margin-bottom:10px;border-left:3px solid #22d3ee">
                    <div style="font-size:10px;color:#22d3ee;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:5px">2. Computed values · vector [@1s | @3s | @5s | @10s]</div>
                    <div style="display:flex;gap:4px;margin-bottom:8px">${vectorCells}</div>
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr>
                            <th style="text-align:left;padding:3px 8px;font-size:9px;color:#64748b;font-weight:600">Window</th>
                            <th style="text-align:right;padding:3px 8px;font-size:9px;color:#64748b;font-weight:600">Raw value</th>
                            <th style="text-align:right;padding:3px 8px;font-size:9px;color:#64748b;font-weight:600">Z-score</th>
                            <th style="text-align:right;padding:3px 8px;font-size:9px;color:#64748b;font-weight:600">→ log10(v)</th>
                        </tr></thead>
                        <tbody>${windowRows}</tbody>
                    </table>
                </div>

                <div style="background:#0a1628;border-radius:6px;padding:10px;margin-bottom:10px;border-left:3px solid #fbbf24">
                    <div style="font-size:10px;color:#fbbf24;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px">3. Matched phrases (this hook · ${totalMatched} total)</div>
                    ${totalMatched ? matchedRows : '<div style="color:#64748b;font-size:11px;font-style:italic">No phrases from this indicator fired anywhere in the hook.</div>'}
                </div>

                <div style="background:#0a1628;border-radius:6px;padding:8px">
                    <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Connects to post-upload metrics (weight = pearson r over 372 videos)</div>
                    <table style="width:100%;border-collapse:collapse">${postRows}</table>
                </div>
            </div>`;
    }

    function renderPostNodePanel(post) {
        const data = hookModelData;
        const score = hookModelScore;
        const detail = score && score.post_detail ? score.post_detail[post.key] : null;
        const contribObj = score && score.post_contributions ? score.post_contributions.find(c => c.key === post.key) : null;

        const drivers = (detail && detail.drivers) ? detail.drivers : [];
        const driverRows = drivers.map(d => {
            const color = d.contrib >= 0 ? '#22d3ee' : '#f87171';
            const pct = Math.min(100, Math.abs(d.contrib) / Math.max(...drivers.map(x => Math.abs(x.contrib)), 0.01) * 100);
            return `<tr style="cursor:pointer" data-pre-key="${escapeHtml(d.pre_key)}">
                <td style="padding:3px 8px;font-size:11px;color:#cbd5e1">${escapeHtml(humanizeFeatureKey(d.pre_key))}</td>
                <td style="padding:3px 8px;font-size:10px;font-family:monospace;text-align:right;color:${color}">${d.weight >= 0 ? '+' : ''}${d.weight.toFixed(3)}</td>
                <td style="padding:3px 8px;font-size:10px;font-family:monospace;text-align:right;color:#94a3b8">z=${d.pre_z.toFixed(2)}</td>
                <td style="padding:3px 8px"><div style="background:#0a1628;height:6px;border-radius:2px;overflow:hidden"><div style="background:${color};height:100%;width:${pct.toFixed(1)}%"></div></div></td>
            </tr>`;
        }).join('');

        const r = post.r_with_views ?? (data.post_to_views_weights || {})[post.key];
        const z = detail ? detail.zscore : (contribObj ? contribObj.zscore : null);
        const contrib = contribObj ? contribObj.contribution : null;

        return `
            <div style="background:#0f172a;border-radius:8px;border:1px solid #1e293b;padding:14px;position:sticky;top:8px;max-height:calc(100vh - 80px);overflow-y:auto">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px">
                    <div>
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
                            <span style="background:#22d3ee22;color:#22d3ee;padding:1px 7px;border-radius:3px;font-size:10px;font-weight:600">POST-UPLOAD</span>
                        </div>
                        <div style="font-size:14px;font-weight:700;color:#f1f5f9">${escapeHtml(post.label || post.key)}</div>
                        <code style="font-size:10px;color:#64748b">${escapeHtml(post.key)}</code>
                    </div>
                    <button id="jarvis-hm-close-node" style="background:none;border:none;color:#64748b;font-size:16px;cursor:pointer">×</button>
                </div>

                ${post.description ? `<div style="font-size:12px;color:#94a3b8;line-height:1.6;margin-bottom:10px">${escapeHtml(post.description)}</div>` : ''}

                <div style="background:#0a1628;border-radius:6px;padding:8px;margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">
                    <div><span style="color:#64748b">r vs views:</span> <span style="color:${(r||0) >= 0 ? '#22d3ee' : '#f87171'};font-weight:700;font-family:monospace">${r != null ? (r >= 0 ? '+' : '') + r.toFixed(3) : '—'}</span></div>
                    <div><span style="color:#64748b">n videos:</span> <span style="color:#cbd5e1;font-family:monospace">${post.n_videos != null ? post.n_videos : '—'}</span></div>
                    <div><span style="color:#64748b">predicted z:</span> <span style="color:${(z||0) >= 0 ? '#22d3ee' : '#f87171'};font-family:monospace">${z != null ? z.toFixed(2) + 'σ' : '—'}</span></div>
                    <div><span style="color:#64748b">→ log10(v):</span> <span style="color:${(contrib||0) >= 0 ? '#22d3ee' : '#f87171'};font-weight:700;font-family:monospace">${contrib != null ? (contrib >= 0 ? '+' : '') + contrib.toFixed(3) : '—'}</span></div>
                </div>

                ${post.improve_hint ? `
                <div style="background:#16243a;border-left:3px solid #22d3ee;padding:8px 10px;margin-bottom:10px;border-radius:0 4px 4px 0">
                    <div style="font-size:9px;color:#22d3ee;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px;font-weight:700">To improve this metric</div>
                    <div style="font-size:11px;color:#cbd5e1;line-height:1.5">${escapeHtml(post.improve_hint)}</div>
                </div>` : ''}

                <div style="background:#0a1628;border-radius:6px;padding:8px">
                    <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Top pre-upload drivers (this hook)</div>
                    ${drivers.length ? `<table style="width:100%;border-collapse:collapse">${driverRows}</table>` : '<div style="color:#64748b;font-size:11px">Score the hook to populate.</div>'}
                </div>
            </div>`;
    }

    function selectHookPreNode(fkey) {
        const data = hookModelData;
        if (!data) return;
        const node = (data.pre_nodes || []).find(n => n.key === fkey);
        if (!node) return;
        hookModelSelectedNode = { ...node, layer: 'pre' };
        refreshHookModelRoot();
    }

    function selectHookPostNode(key) {
        const data = hookModelData;
        if (!data) return;
        const node = (data.post_nodes || []).find(n => n.key === key);
        if (!node) return;
        hookModelSelectedNode = { ...node, layer: 'post' };
        refreshHookModelRoot();
    }

    function bindHookModelEvents() {
        const root = container?.querySelector('.jarvis-hook-model-root');
        if (!root) return;

        const ta = root.querySelector('#jarvis-hm-text');
        if (ta) {
            ta.addEventListener('input', (e) => { hookModelText = e.target.value; });
            ta.addEventListener('blur', () => scoreHookModel());
        }
        const wps = root.querySelector('#jarvis-hm-wps');
        if (wps) {
            wps.addEventListener('input', (e) => {
                hookModelWps = parseFloat(e.target.value);
                const span = root.querySelector('#jarvis-hm-wps-val');
                if (span) span.textContent = hookModelWps.toFixed(1) + ' wps';
                // Live-update the legend + word coloring without full rerender
                const legend = root.querySelector('#jarvis-hm-wps-legend');
                if (legend) {
                    const total = (hookModelText || '').split(/\s+/).filter(Boolean).length;
                    const wordsAt = (sec) => Math.min(total, Math.max(0, Math.round(sec * hookModelWps)));
                    legend.innerHTML = `
                        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;color:#cbd5e1">
                            ${[1, 3, 5, 10].map(w => `
                                <span style="display:inline-flex;align-items:center;gap:5px">
                                    <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${HM_TIER_BG[w]};border-left:3px solid ${HM_TIER_COLOR[w]}"></span>
                                    <span style="color:#94a3b8">@${w}s</span>
                                    <span style="font-family:monospace;color:#f1f5f9">${wordsAt(w)} ${wordsAt(w) === 1 ? 'word' : 'words'}</span>
                                </span>
                            `).join('')}
                        </div>`;
                }
            });
            wps.addEventListener('change', () => scoreHookModel());
        }
        root.querySelectorAll('.jarvis-hm-window-btn').forEach(b => {
            b.addEventListener('click', () => {
                hookModelWindow = parseInt(b.dataset.window, 10);
                refreshHookModelRoot();
            });
        });
        const scoreBtn = root.querySelector('#jarvis-hm-score-btn');
        if (scoreBtn) scoreBtn.addEventListener('click', () => scoreHookModel());

        root.querySelectorAll('[data-pre-key]').forEach(el => {
            el.addEventListener('click', () => selectHookPreNode(el.dataset.preKey));
        });
        root.querySelectorAll('[data-post-key]').forEach(el => {
            el.addEventListener('click', () => selectHookPostNode(el.dataset.postKey));
        });
        const closeBtn = root.querySelector('#jarvis-hm-close-node');
        if (closeBtn) closeBtn.addEventListener('click', () => {
            hookModelSelectedNode = null;
            refreshHookModelRoot();
        });
    }

    function renderProjectIdeas() {
        if (!projectIdeasData && !projectIdeasLoading && !projectIdeasError) {
            loadProjectIdeas();
        }
        setTimeout(bindProjectIdeasEvents, 30);
        return `<div class="jarvis-project-ideas-root">${renderProjectIdeasBody()}</div>`;
    }

    function renderProjectIdeasBody() {
        if (projectIdeasError && !projectIdeasData) {
            return loadingBox('Failed to load project ideas: ' + projectIdeasError, true);
        }
        if (!projectIdeasData) {
            return loadingBox('Loading project ideas…');
        }
        const { ideas = [], methodology = {} } = projectIdeasData;
        const totalCount = ideas.length;
        const keepCount = ideas.filter(i => i.verdict === 'KEEP').length;
        const twistCount = ideas.filter(i => i.verdict === 'NEEDS_TWIST').length;
        const hookCount = ideas.filter(i => i.thumbnail_hook).length;

        const header = `
            <div style="margin-bottom:14px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
                <div>
                    <div style="font-size:18px;font-weight:700;color:#e2e8f0;margin-bottom:3px">Project Ideas — IP-Anchored Video Premises</div>
                    <div style="font-size:12px;color:#64748b;line-height:1.5;max-width:720px">${totalCount} ideas. Each twisted past prior maker work into a single visible proof moment. Click "Generation Methodology" to see exactly how these were generated, or run "Generate More Ideas" to extend the list.</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <button id="jarvis-pi-add-toggle" style="background:#0d1424;color:#22d3ee;border:1px solid #22d3ee;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer">＋ Add Idea</button>
                    <button id="jarvis-pi-generate-toggle" style="background:#0d1424;color:#fbbf24;border:1px solid #fbbf24;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer">🔄 Generate More Ideas</button>
                </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
                <div style="background:#1e293b;border-radius:6px;padding:6px 12px;font-size:11px"><span style="color:#64748b">Total:</span> <span style="color:#f1f5f9;font-weight:700">${totalCount}</span></div>
                <div style="background:#10b98122;border-radius:6px;padding:6px 12px;font-size:11px"><span style="color:#64748b">Keep:</span> <span style="color:#10b981;font-weight:700">${keepCount}</span></div>
                <div style="background:#fbbf2422;border-radius:6px;padding:6px 12px;font-size:11px"><span style="color:#64748b">Needs Twist:</span> <span style="color:#fbbf24;font-weight:700">${twistCount}</span></div>
                <div style="background:#a78bfa22;border-radius:6px;padding:6px 12px;font-size:11px"><span style="color:#64748b">Thumbnail Hooks:</span> <span style="color:#a78bfa;font-weight:700">${hookCount}</span></div>
            </div>
        `;

        return header
            + renderProjectIdeasAddForm()
            + renderProjectIdeasGenerateBox(methodology)
            + renderProjectIdeasHooks(ideas)
            + renderProjectIdeasAll(ideas)
            + renderProjectIdeasMethodology(methodology);
    }

    function renderProjectIdeasAddForm() {
        if (!projectIdeasShowAddForm) return '';
        return `
            <div style="background:#0a1628;border:1px solid #22d3ee;border-radius:8px;padding:14px;margin-bottom:14px">
                <div style="font-size:13px;font-weight:700;color:#22d3ee;margin-bottom:10px">＋ Add New Idea</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
                    <input id="jarvis-pi-f-title" placeholder="Original title" style="background:#060d1a;color:#cbd5e1;border:1px solid #1e293b;border-radius:4px;padding:6px 10px;font-size:11px"/>
                    <input id="jarvis-pi-f-improved" placeholder="Improved title (twisted version)" style="background:#060d1a;color:#cbd5e1;border:1px solid #1e293b;border-radius:4px;padding:6px 10px;font-size:11px"/>
                    <input id="jarvis-pi-f-ip" placeholder="IP anchor (e.g. Batman)" style="background:#060d1a;color:#cbd5e1;border:1px solid #1e293b;border-radius:4px;padding:6px 10px;font-size:11px"/>
                    <select id="jarvis-pi-f-cat" style="background:#060d1a;color:#cbd5e1;border:1px solid #1e293b;border-radius:4px;padding:6px 10px;font-size:11px">
                        <option value="armor">armor</option>
                        <option value="shoes">shoes</option>
                        <option value="weapon">weapon</option>
                        <option value="gadget" selected>gadget</option>
                        <option value="vehicle">vehicle</option>
                    </select>
                    <select id="jarvis-pi-f-novelty" style="background:#060d1a;color:#cbd5e1;border:1px solid #1e293b;border-radius:4px;padding:6px 10px;font-size:11px">
                        ${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}"${n===5?' selected':''}>Novelty ${n}/10</option>`).join('')}
                    </select>
                    <input id="jarvis-pi-f-hook" placeholder="Thumbnail hook (optional)" style="background:#060d1a;color:#cbd5e1;border:1px solid #1e293b;border-radius:4px;padding:6px 10px;font-size:11px"/>
                </div>
                <textarea id="jarvis-pi-f-why" placeholder="Why the improved version is novel" rows="2" style="width:100%;background:#060d1a;color:#cbd5e1;border:1px solid #1e293b;border-radius:4px;padding:6px 10px;font-size:11px;resize:vertical;box-sizing:border-box;margin-bottom:8px"></textarea>
                <div style="display:flex;gap:8px">
                    <button id="jarvis-pi-submit" style="background:#22d3ee;color:#060d1a;border:none;border-radius:4px;padding:6px 14px;font-size:11px;cursor:pointer;font-weight:700">Save Idea</button>
                    <button id="jarvis-pi-add-cancel" style="background:transparent;color:#64748b;border:1px solid #1e293b;border-radius:4px;padding:6px 14px;font-size:11px;cursor:pointer">Cancel</button>
                </div>
            </div>
        `;
    }

    function renderProjectIdeasGenerateBox(methodology) {
        if (!projectIdeasShowGenerate) return '';
        const cmd = methodology.generation_claude_command || 'env -u ANTHROPIC_API_KEY claude --permission-mode bypassPermissions --print';
        const fullCmd = `${cmd} < buildings/jarvis/project-ideas-generate-prompt.txt`;
        return `
            <div style="background:#0a1628;border:1px solid #fbbf24;border-radius:8px;padding:14px;margin-bottom:14px">
                <div style="font-size:13px;font-weight:700;color:#fbbf24;margin-bottom:8px">🔄 Generate More Ideas</div>
                <div style="font-size:11px;color:#94a3b8;line-height:1.6;margin-bottom:10px">Run this command in your terminal at the project root. It pipes the saved prompt template (which contains the full corpus indicators, IP formula, novelty check, and JSON schema) into Claude Code, then outputs new idea objects you can append to project-ideas.json.</div>
                <pre style="background:#060d1a;color:#22d3ee;padding:10px 12px;border-radius:4px;font-size:11px;font-family:monospace;overflow-x:auto;margin:0 0 10px;border:1px solid #1e293b">${escapeHtml(fullCmd)}</pre>
                <div style="font-size:10px;color:#64748b;line-height:1.6">
                    <div><b style="color:#94a3b8">Prompt template:</b> <code style="color:#22d3ee">buildings/jarvis/project-ideas-generate-prompt.txt</code></div>
                    <div><b style="color:#94a3b8">Append target:</b> <code style="color:#22d3ee">buildings/jarvis/project-ideas.json</code> &middot; <code>ideas[]</code></div>
                </div>
            </div>
        `;
    }

    function renderProjectIdeasHooks(ideas) {
        const hooked = ideas.filter(i => i.thumbnail_hook);
        if (!hooked.length) return '';
        const cards = hooked.map(idea => `
            <div style="background:#0a1628;border:2px solid #fbbf24;border-radius:8px;padding:14px">
                <div style="font-size:14px;font-weight:700;color:#f1f5f9;line-height:1.35;margin-bottom:8px">${escapeHtml(idea.improved_title)}</div>
                <div style="background:#1a1408;border-left:3px solid #fbbf24;padding:8px 10px;border-radius:0 4px 4px 0;margin-bottom:8px">
                    <div style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#fbbf24;margin-bottom:3px">Thumbnail Hook</div>
                    <div style="font-size:12px;color:#fde68a;line-height:1.4">${escapeHtml(idea.thumbnail_hook)}</div>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                    ${idea.ip_anchor ? `<span style="background:#06b6d422;color:#22d3ee;border-radius:10px;padding:2px 8px;font-size:10px">${escapeHtml(idea.ip_anchor)}</span>` : ''}
                    <span style="background:#1e293b;color:#94a3b8;border-radius:10px;padding:2px 8px;font-size:10px">${escapeHtml(idea.category)}</span>
                </div>
            </div>
        `).join('');
        return `
            <div style="margin-bottom:18px">
                <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#fbbf24;margin-bottom:8px;display:flex;align-items:center;gap:8px">
                    <span>★ Top Thumbnail Hooks</span>
                    <span style="color:#64748b">(${hooked.length})</span>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">
                    ${cards}
                </div>
            </div>
        `;
    }

    function noveltyColor(score) {
        if (score >= 7) return '#10b981';
        if (score >= 4) return '#fbbf24';
        return '#ef4444';
    }

    function renderProjectIdeasAll(ideas) {
        const cards = ideas.map(idea => {
            const nColor = noveltyColor(idea.novelty_score);
            const doneDot = idea.done_before
                ? '<span title="done before" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444"></span>'
                : '<span title="not done before" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981"></span>';
            const doneLabel = idea.done_before
                ? `<span style="font-size:9px;color:#94a3b8">done${idea.done_before_note ? ' · ' + escapeHtml(idea.done_before_note) : ''}</span>`
                : `<span style="font-size:9px;color:#94a3b8">not done before</span>`;
            return `
                <div style="background:#0a1628;border:1px solid #1e293b;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:6px">
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
                        <div style="font-size:13px;font-weight:700;color:#f1f5f9;line-height:1.35;flex:1">${escapeHtml(idea.improved_title)}</div>
                        <button data-pi-delete="${escapeHtml(idea.id)}" title="Delete idea" style="background:transparent;color:#64748b;border:none;cursor:pointer;font-size:14px;line-height:1;padding:0 4px">×</button>
                    </div>
                    <div style="font-size:10px;color:#64748b;font-style:italic">Original: <span style="color:#94a3b8">${escapeHtml(idea.title)}</span></div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                        <span style="background:${nColor}22;color:${nColor};border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700">Novelty ${idea.novelty_score}/10</span>
                        ${idea.ip_anchor ? `<span style="background:#06b6d422;color:#22d3ee;border-radius:10px;padding:2px 8px;font-size:10px">${escapeHtml(idea.ip_anchor)}</span>` : ''}
                        <span style="background:#1e293b;color:#94a3b8;border-radius:10px;padding:2px 8px;font-size:10px">${escapeHtml(idea.category)}</span>
                        <span style="background:${idea.verdict === 'KEEP' ? '#10b98122' : '#fbbf2422'};color:${idea.verdict === 'KEEP' ? '#10b981' : '#fbbf24'};border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700">${escapeHtml(idea.verdict)}</span>
                        <span style="display:flex;align-items:center;gap:4px;margin-left:auto">${doneDot}${doneLabel}</span>
                    </div>
                    ${idea.improved_why ? `<div style="font-size:11px;color:#cbd5e1;line-height:1.5">${escapeHtml(idea.improved_why)}</div>` : ''}
                    ${idea.thumbnail_hook ? `<div style="font-size:10px;color:#fbbf24;background:#1a1408;border-left:2px solid #fbbf24;padding:4px 8px;border-radius:0 4px 4px 0">★ ${escapeHtml(idea.thumbnail_hook)}</div>` : ''}
                    ${(idea.tags && idea.tags.length) ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${idea.tags.map(t => `<span style="font-size:9px;color:#64748b;background:#1e293b;padding:1px 6px;border-radius:8px">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                    <div style="font-size:9px;color:#475569;font-family:monospace">${escapeHtml(idea.id)}</div>
                </div>
            `;
        }).join('');

        return `
            <div style="margin-bottom:18px">
                <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px">All ${ideas.length} Ideas</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px">
                    ${cards}
                </div>
            </div>
        `;
    }

    function renderProjectIdeasMethodology(methodology) {
        const open = projectIdeasShowMethodology;
        const indicators = (methodology.corpus_indicators_used || []).map(ind => `
            <li style="margin-bottom:4px">
                <code style="color:#22d3ee">${escapeHtml(ind.key)}</code>
                ${ind.r != null ? `<span style="color:#a78bfa">· r=${ind.r}</span>` : ''}
                <span style="color:#94a3b8"> — ${escapeHtml(ind.meaning)}</span>
            </li>
        `).join('');
        const anchors = (methodology.top_ip_anchors || []).map(a =>
            `<span style="background:#06b6d422;color:#22d3ee;border-radius:10px;padding:2px 8px;font-size:10px;display:inline-block;margin:2px">${escapeHtml(a)}</span>`
        ).join('');
        const patterns = (methodology.project_patterns || []).map(p =>
            `<li style="margin-bottom:3px;color:#cbd5e1">${escapeHtml(p)}</li>`
        ).join('');
        const body = open ? `
            <div style="padding:14px;background:#0a1628;border:1px solid #1e293b;border-top:none;border-radius:0 0 8px 8px;font-size:11px;color:#94a3b8;line-height:1.6">
                <div style="margin-bottom:12px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Description</div>
                    <div style="color:#cbd5e1">${escapeHtml(methodology.description || '')}</div>
                </div>
                <div style="margin-bottom:12px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">IP Formula</div>
                    <div style="color:#cbd5e1;font-style:italic">${escapeHtml(methodology.ip_formula || '')}</div>
                </div>
                <div style="margin-bottom:12px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Thumbnail Formula</div>
                    <div style="color:#cbd5e1">${escapeHtml(methodology.thumbnail_formula || '')}</div>
                </div>
                <div style="margin-bottom:12px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Novelty Check Prompt</div>
                    <div style="background:#060d1a;border-radius:4px;padding:8px 10px;color:#cbd5e1;border-left:2px solid #22d3ee;white-space:pre-wrap">${escapeHtml(methodology.novelty_check_prompt || '')}</div>
                </div>
                <div style="margin-bottom:12px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Corpus Indicators Used</div>
                    <ul style="margin:0;padding-left:18px">${indicators}</ul>
                </div>
                <div style="margin-bottom:12px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Project Patterns</div>
                    <ul style="margin:0;padding-left:18px">${patterns}</ul>
                </div>
                <div style="margin-bottom:12px">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Top IP Anchors</div>
                    <div>${anchors}</div>
                </div>
                <div style="margin-bottom:0">
                    <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Generation Command</div>
                    <pre style="background:#060d1a;color:#22d3ee;padding:8px 10px;border-radius:4px;font-size:11px;font-family:monospace;overflow-x:auto;margin:0;border:1px solid #1e293b">${escapeHtml(methodology.generation_claude_command || '')}</pre>
                </div>
            </div>
        ` : '';
        return `
            <div style="margin-bottom:14px">
                <button id="jarvis-pi-methodology-toggle" style="width:100%;background:#0a1628;color:#cbd5e1;border:1px solid #1e293b;border-radius:${open ? '8px 8px 0 0' : '8px'};padding:10px 14px;font-size:11px;cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between">
                    <span style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8">Generation Methodology &middot; v${escapeHtml(methodology.version || '1.0')}</span>
                    <span style="color:#64748b">${open ? '▾' : '▸'}</span>
                </button>
                ${body}
            </div>
        `;
    }

    function bindProjectIdeasEvents() {
        if (!container) return;
        const addToggle = container.querySelector('#jarvis-pi-add-toggle');
        if (addToggle) addToggle.onclick = () => {
            projectIdeasShowAddForm = !projectIdeasShowAddForm;
            refreshProjectIdeasRoot();
        };
        const addCancel = container.querySelector('#jarvis-pi-add-cancel');
        if (addCancel) addCancel.onclick = () => {
            projectIdeasShowAddForm = false;
            refreshProjectIdeasRoot();
        };
        const generateToggle = container.querySelector('#jarvis-pi-generate-toggle');
        if (generateToggle) generateToggle.onclick = () => {
            projectIdeasShowGenerate = !projectIdeasShowGenerate;
            refreshProjectIdeasRoot();
        };
        const methToggle = container.querySelector('#jarvis-pi-methodology-toggle');
        if (methToggle) methToggle.onclick = () => {
            projectIdeasShowMethodology = !projectIdeasShowMethodology;
            refreshProjectIdeasRoot();
        };
        const submit = container.querySelector('#jarvis-pi-submit');
        if (submit) submit.onclick = submitNewProjectIdea;
        container.querySelectorAll('[data-pi-delete]').forEach(btn => {
            btn.onclick = () => deleteProjectIdea(btn.getAttribute('data-pi-delete'));
        });
    }

    async function submitNewProjectIdea() {
        if (!container) return;
        const get = id => (container.querySelector(id) || {}).value || '';
        const payload = {
            title: get('#jarvis-pi-f-title').trim(),
            improved_title: get('#jarvis-pi-f-improved').trim(),
            ip_anchor: get('#jarvis-pi-f-ip').trim() || null,
            category: get('#jarvis-pi-f-cat'),
            novelty_score: parseInt(get('#jarvis-pi-f-novelty'), 10) || 5,
            improved_why: get('#jarvis-pi-f-why').trim(),
            thumbnail_hook: get('#jarvis-pi-f-hook').trim() || null,
        };
        if (!payload.title && !payload.improved_title) {
            alert('Need at least a title or improved_title.');
            return;
        }
        try {
            const res = await fetch('/api/jarvis/project-ideas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            projectIdeasShowAddForm = false;
            await loadProjectIdeas(true);
        } catch (e) {
            alert('Failed to save idea: ' + e.message);
        }
    }

    async function deleteProjectIdea(id) {
        if (!id) return;
        if (!confirm('Delete idea ' + id + '?')) return;
        try {
            const res = await fetch('/api/jarvis/project-ideas/' + encodeURIComponent(id), {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            await loadProjectIdeas(true);
        } catch (e) {
            alert('Failed to delete idea: ' + e.message);
        }
    }

    function bindIdeaModelEvents() {
        const refreshBtn = container?.querySelector('#jarvis-idea-refresh');
        if (refreshBtn) {
            refreshBtn.onclick = () => {
                ideaModelBrief = null;
                ideaModelIdeas = null;
                loadIdeaModel(true);
            };
        }
        const countSel = container?.querySelector('#jarvis-idea-count');
        if (countSel) {
            countSel.onchange = () => {
                const n = parseInt(countSel.value, 10);
                if (!isNaN(n)) {
                    ideaIdeasCount = n;
                    ideaModelIdeas = null;
                    loadIdeaModel(true);
                }
            };
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
        metaArchMarkdown = null;
        metaArchError = null;
        knowledgeSubTab = 'overview';
        knowledgeData = {};
        knowledgeLoading = {};
        knowledgeError = {};
        knowledgeSearch = { mechanisms: '', principles: '', components: '', bridges: '', research: '' };
        knowledgeSort = { mechanisms: 'n_videos_desc', principles: 'chain_strength_desc', components: 'n_mechanisms_desc', bridges: 'chain_strength_desc' };
        knowledgeFilter = { mechanisms: 'all', principles: 'all', components: 'all', bridges: 'all', research: 'all' };
        knowledgeExpanded = { mechanism: null, principle: null, component: null, bridge: null, question: null };
        knowledgeListLimit = { mechanisms: 200, principles: 400, components: 100, bridges: 400 };
        knowledgeGraphFocus = null;
        ideaModelBrief = null;
        ideaModelIdeas = null;
        ideaModelLoading = false;
        ideaModelError = null;
        ideaIdeasCount = 5;
        projectIdeasData = null;
        projectIdeasLoading = false;
        projectIdeasError = null;
        projectIdeasShowAddForm = false;
        projectIdeasShowMethodology = false;
        projectIdeasShowGenerate = false;

        render();
    }

    function close() {
        container = null;
    }

    async function loadSignalDataset(key) {
        const el = document.getElementById('jarvis-detail-ds-' + key);
        if (el) el.innerHTML = '<div style="font-size:11px;color:#64748b;padding:4px 8px">Loading…</div>';
        const detail = await fetchIndicatorDetail(key);
        if (!detail || !detail.dataset) { if (el) el.innerHTML = '<div style="font-size:11px;color:#f87171;padding:4px 8px">Failed to load</div>'; return; }
        const ds = detail.dataset;
        const vals = ds.map(d => d.value);
        if (el) el.innerHTML = `
            <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px">Dataset (${ds.length} videos)</div>
            <div style="background:#0a1628;border-radius:6px;padding:8px;font-size:11px;color:#94a3b8">
                <div>Min: <span style="color:#cbd5e1">${Math.min(...vals).toFixed(3)}</span> &nbsp; Max: <span style="color:#cbd5e1">${Math.max(...vals).toFixed(3)}</span> &nbsp; Mean: <span style="color:#cbd5e1">${(vals.reduce((s,v) => s+v, 0)/vals.length).toFixed(3)}</span></div>
            </div>`;
    }

    async function loadExpDataset(key, type) {
        const el = document.getElementById('jarvis-exp-dataset-' + key);
        if (el) el.innerHTML = '<div style="font-size:11px;color:#64748b;padding:4px 8px">Loading…</div>';
        const detail = type === 'derived' ? await fetchDerivedDetail(key) : await fetchIndicatorDetail(key);
        if (!detail || !detail.dataset) { if (el) el.innerHTML = '<div style="font-size:11px;color:#f87171;padding:4px 8px">Failed to load</div>'; return; }
        const ds = detail.dataset;
        const dataRows = ds.slice(0, 20).map((dp, i) =>
            `<tr style="background:${i % 2 === 0 ? '#0a1020' : '#0d1525'}">
                <td style="padding:3px 8px;font-family:monospace;font-size:10px;color:#64748b">${dp.ytId}</td>
                <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#cbd5e1;text-align:right">${typeof dp.value === 'number' ? dp.value.toFixed(4) : dp.value}</td>
                <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:#94a3b8;text-align:right">${typeof dp.target_value === 'number' ? dp.target_value.toFixed(4) : dp.target_value}</td>
            </tr>`
        ).join('');
        if (el) el.innerHTML = `
            <div style="max-height:300px;overflow-y:auto;border-radius:6px;border:1px solid #1e293b">
                <table style="width:100%;border-collapse:collapse">
                    <thead><tr style="background:#1e293b;position:sticky;top:0">
                        <th style="padding:4px 8px;text-align:left;font-size:10px;color:#64748b;font-weight:600">Video ID</th>
                        <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">${key}</th>
                        <th style="padding:4px 8px;text-align:right;font-size:10px;color:#64748b;font-weight:600">log10(views)</th>
                    </tr></thead>
                    <tbody>${dataRows}</tbody>
                </table>
                ${ds.length > 20 ? '<div style="padding:6px 8px;font-size:10px;color:#475569;text-align:center">… ' + (ds.length - 20) + ' more rows</div>' : ''}
            </div>`;
    }

    return { open, close, openExperimentInstance, closeAnalyticalPanel, loadSignalDataset, loadExpDataset };
})();

BuildingRegistry.register('Jarvis', {
    open: function(bodyEl, opts) { JarvisUI.open(bodyEl, opts); },
    close: function() { JarvisUI.close(); }
});
