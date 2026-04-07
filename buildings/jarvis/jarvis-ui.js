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
        { label: 'Keep Rate', key: 'keep', type: '% (0–100)', source: 'YouTube Analytics (swipeRatio.stayedToWatch)', category: 'active', numeric: true },
        { label: 'Retention %', key: 'retention', type: '% (0–100)', source: 'YouTube Analytics (avgPercentViewed)', category: 'active', numeric: true },
        { label: 'Zeigarnik Score (text)', key: 'z_score', type: '1–10', source: 'LLM-scored (title + first 180 chars transcript)', category: 'active', numeric: true },
        { label: 'Zeigarnik Type (text)', key: 'z_type', type: 'categorical (A/B/C/D/E)', source: 'LLM-scored (title + first 180 chars transcript)', category: 'active', numeric: false },
        { label: 'Visual Zeigarnik Score', key: 'vz_score', type: '1–10', source: 'LLM vision-scored (frames 1–3 + first 3s transcript)', category: 'active', numeric: true },
        { label: 'Visual Zeigarnik Type', key: 'vz_type', type: 'categorical (A/B/C/D/E)', source: 'LLM vision-scored', category: 'active', numeric: false },
        { label: 'Novelty', key: 'novelty', type: '1–10', source: 'LLM-scored (title + opening transcript)', category: 'active', numeric: true },
        { label: 'Cognitive Load', key: 'cognitive_load', type: '1–10', source: 'LLM-scored (title + opening transcript)', category: 'active', numeric: true },
        { label: 'Net Novelty', key: 'net_novelty', type: 'integer (Novelty − Cognitive Load)', source: 'Derived: novelty − cognitive_load', category: 'active', numeric: true },
        { label: 'Share Rate', key: 'share_rate', type: 'ratio (shares per 1k views)', source: 'Derived: shares ÷ (views/1000)', category: 'active', numeric: true },
        { label: 'Views', key: 'views', type: 'count (use log10 for correlation)', source: 'YouTube Analytics', category: 'active', numeric: true },
        { label: 'Hook Clarity', key: 'hook_clarity', type: '1–10 (not yet scored)', source: 'Planned: LLM vision (first frame)', category: 'planned', numeric: true },
        { label: 'Visual Surprise', key: 'visual_surprise', type: '1–10 (not yet scored)', source: 'Planned: LLM vision (first frame)', category: 'planned', numeric: true },
        { label: 'Pacing', key: 'pacing', type: 'cuts/sec (not yet measured)', source: 'Planned: frame diff analysis (first 3s)', category: 'planned', numeric: true },
        { label: 'Emotional Resonance', key: 'emotional_resonance', type: '1–10 (not yet scored)', source: 'Planned: LLM vision+text', category: 'planned', numeric: true },
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
        { id: 'pearson', icon: '📐', name: 'Pearson Correlation', desc: 'Linear relationship between two numeric signals. Outputs r (−1 to +1).' },
        { id: 'bucket', icon: '📊', name: 'Bucket Analysis', desc: 'Group videos by one signal, show average of another per bucket.' },
        { id: 'log10', icon: '📉', name: 'log10 Compare', desc: 'Compare raw Pearson r vs log10-normalized Pearson r.' },
        { id: 'ratio', icon: '⚖️', name: 'Ratio Normalizer', desc: 'Convert raw counts to rates (per 100/1k/1M) and correlate.' },
        { id: 'net', icon: '➕➖', name: 'Net Signal Calculator', desc: 'Subtract one signal from another to find optimal balance points.' },
        { id: 'proximity', icon: '🎯', name: 'Proximity / Clustering', desc: 'Multi-signal centroid distance analysis.' },
        { id: 'llm', icon: '🧠', name: 'LLM Signal Scorer', desc: 'Planned — server scoring pipeline next.', planned: true },
    ];

    const TOOL_FIRST_PARAM = {
        pearson: 'signalA', bucket: 'groupBy', log10: 'signalA',
        ratio: 'numerator', net: 'positive', proximity: 'signals',
    };

    // ── Hardcoded Data ──
    const EXPERIMENTS = [
        { id: 'exp1', name: 'In-Video Keep Rate vs Views (CORRECTED)', r: 0.44, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel (213 videos with swipeRatio data)', finding: 'r=0.44 with log(Views) — MODERATE POSITIVE. Tyler was right. In-video keep rate (% who stay watching past the hook) has real predictive power. Previous experiment used wrong metric (impression CTR, not in-video swipe). Corrected with swipeRatio.stayedToWatch from YouTube Analytics.' },
        { id: 'exp2', name: 'In-Video Swipe Bucket Analysis', r: null, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Bucket analysis: 15-20% swipe-away → avg 11.1M views (n=50). 20-25% → avg 13.2M (n=58, includes 285M video). Note: this is NOT a sweet spot — higher swipe-away does not improve performance. The 20-25% bucket peaks because most of Tyler\'s high-view videos have been pushed broadly by the algorithm to non-core audiences, increasing swipe-away as a side effect of scale, not as a cause of it. Better keep rate is always better.' },
        { id: 'exp3', name: 'Retention % vs log(Views)', r: 0.32, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'r=0.32 with log(Views). Moderate signal. Avg retention by tier: 100M+=87.2%, 10-50M=87.0%, 5-10M=86.7%, 1-5M=82.7%, Sub-1M=79.4%. Clear progression — getting from 79% to 87% retention correlates with ~10x more views.' },
        { id: 'exp4', name: 'CTR (Impression→View Rate) vs Views', r: -0.01, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Near-zero correlation. CTR (viewedRate, the % of people who click from the feed) does NOT predict views. This is the metric previously mislabeled as swipe-away. It measures thumbnail/title performance — important for discoverability but not correlated with total scale.' },
        { id: 'exp5', name: 'Full Profile: Tyler 50M+ Videos', r: null, n: 5, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: '285M: keep=79.4%, ret=87.2% | 80M: keep=84.6%, ret=62.4% | 75M: keep=71.1%, ret=81.6% | 62M: keep=78.3%, ret=86.1% | 55M: keep=74.4%, ret=82.9%. Pattern: all 50M+ videos have in-video keep rates of 71-84% and retention mostly 80%+. The 80M Bulletproof Batman has only 62.4% retention but compensated with high keep (84.6%).' },
        { id: 'exp6', name: 'Keep Rate Distribution by View Tier (Corrected)', r: null, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'In-video keep rate by tier: 100M+=79.4%, 50-100M=77.1%, 10-50M=79.3%, 5-10M=76.9%, 1-5M=75.2%, Sub-1M=70.4%. Clear step up at 1M+ threshold. Previous analysis showed wrong data (keep=56% and 99% were impression CTRs, not in-video metrics).' },
        { id: 'exp7', name: 'Duration of 100M+ Videos (Confound Flagged)', r: null, n: 1961, type: 'quantified', status: 'complete', source: 'Research Center (1,961 videos)', finding: 'CONFOUND: 98% under 60s, but YouTube Shorts 60s limit was in effect when most were uploaded. Cannot conclude <60s outperforms without controlling for upload era. Experiment needs replication with 2024+ data.' },
        { id: 'exp8', name: 'Share Rate vs Views (Normalized)', r: null, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Share rate per 1k views by tier: 10-50M=0.282, 5-10M=0.301, 1-5M=0.264, Sub-1M=0.311. Surprisingly similar across tiers. Raw share counts are misleading (50M views = more shares by definition). Rate normalization shows shares are not a strong tier separator.' },
        { id: 'exp_z1', name: 'Zeigarnik Effect Score vs Views', r: -0.08, n: 204, type: 'quantified', status: 'complete', source: 'Tyler Channel (LLM-scored)', finding: 'Pearson r=-0.08 — near zero linear correlation. BUT bucket analysis reveals a clear non-linear sweet spot: Z=6 → avg 10.2M views, Z=7 → avg 12.6M views. Z=8 drops to 5.9M, Z=9 to 4.9M, Z=10 to 4.6M. Extreme Zeigarnik (high danger/intensity) narrows audience. The sweet spot is moderate open loops — enough curiosity to hook, not so intense it filters the mass market.' },
        { id: 'exp_z2', name: 'Zeigarnik Effect vs Keep Rate', r: -0.06, n: 204, type: 'quantified', status: 'complete', source: 'Tyler Channel (LLM-scored)', finding: 'Near-zero correlation with in-video keep rate. Zeigarnik score does not directly predict hook retention. High Z-score videos (9-10) average 72-73% keep rate — slightly LOWER than mid-range (Z=6-7 at 77%). Implication: strong open loops alone don\'t prevent swipe-away; content quality and pacing are separate drivers.' },
        { id: 'exp_z3', name: 'Zeigarnik Type Breakdown', r: null, n: 204, type: 'quantified', status: 'complete', source: 'Tyler Channel (LLM-scored)', finding: 'Type B (Challenge/outcome uncertainty): n=88, avg 9.6M views — most common and highest performing. Type E (Social curiosity): n=10, avg 10.1M views — small sample but strong. Type A (Physical danger/threat): n=38, avg 7.4M views, avg Z-score 8.4 — high intensity but narrower. Type C (Mystery/reveal): n=42, avg 5.8M views. Best strategy: lean into B (can it work?) and E (social stakes), not maximum danger.' },
        { id: 'exp_vz1', name: 'Visual Zeigarnik (3s frames+text) vs Keep Rate', r: 0.22, n: 203, type: 'quantified', status: 'complete', source: 'Tyler Channel (LLM vision-scored)', finding: 'r=+0.22 using first 3 seconds of frames + spoken words. Text-only Zeigarnik was r=-0.06 (noise). Correct resolution (visual+text, 3s window) reveals a real signal. Visual scoring is more predictive of hook retention than text proxy.' },
        { id: 'exp_vz2', name: 'Visual Zeigarnik Bucket vs Keep Rate', r: null, n: 203, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'VZ=6: avg keep 73.1% (n=64). VZ=7: avg keep 74.9% (n=101). VZ=8: avg keep 77.6% (n=30), avg views 17.4M. Higher visual Zeigarnik directly predicts both higher keep rate AND more views. VZ=8 is the current sweet spot.' },
        { id: 'exp_vz3', name: 'Visual vs Text Zeigarnik: Type Reversal', r: null, n: 203, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Text scoring showed Type B (Challenge) dominant. Visual scoring shows Type C (Mystery/reveal) dominant: 119 videos, avg 9.3M views. 47 videos scored LOWER visually than text (visuals less compelling than description). Only 24 scored higher visually. Resolution matters: the same video reads differently at text vs visual resolution.' },
    ];

    const TABS = [
        { id: 'analytical', label: 'Analytical Brain' },
        { id: 'tactical', label: 'Tactical Brain' },
        { id: 'experiments', label: 'Experiments' },
        { id: 'insights', label: 'Insights' },
        { id: 'autoResearch', label: 'AutoResearch' },
        { id: 'resolution', label: 'Resolution' },
        { id: 'methodology', label: 'Methodology' },
    ];

    const INSIGHTS = [
        '<strong>Visual Zeigarnik (r=+0.22) vs text-only (r=-0.06)</strong> — scoring at correct resolution (first 3 seconds, frames + transcript) vs wrong resolution (first 180 chars) completely changes the signal. Visual Type C (Mystery/reveal) dominates at 9.3M avg views — the opposite of what text scoring suggested.',
        '<strong>Keep Rate (r=0.43) is the strongest quantified predictor</strong> — the data shows keep rate is monotonically positive: higher keep rate always correlates with more views. In-video keep rate has real predictive power for total views.',
        '<strong>Net Novelty sweet spot = +2</strong> (Novelty exceeds Cognitive Load by exactly 2). Both too easy and too complex underperform. Average 10.3M views at the sweet spot.',
        '<strong>Zeigarnik Z=7 (not Z=10) peaks at 12.6M avg</strong> — moderate open loops beat maximum intensity. Z=10 averages only 4.6M. Enough curiosity to hook, not so intense it filters the mass market.',
        '<strong>Best Zeigarnik type is B (Challenge uncertainty)</strong>: 88 videos, avg 9.6M views. Frame as \'can this actually work?\' not \'watch this dangerous thing happen\'. Type E (social stakes) has the highest avg at 10.1M but only 10 videos.',
        '<strong>Zeigarnik does NOT directly predict keep rate</strong> — high Z-score videos have slightly lower keep rates (72%) than mid-range (77%). Open loops and hook retention are separate mechanisms. Need both.',
        '<strong>Retention 87%+ correlates with 10M+ avg views</strong> — progression from 79% (sub-1M) to 87% (100M+) is the clearest signal in the dataset.',
        '<strong>CTR (impression to view rate) has zero correlation with total views</strong> — it measures thumbnail appeal, not viral potential.',
        '<strong>The 20-25% swipe-away bucket has the highest average</strong> (avg 13.2M, includes 285M video) — but this is NOT a sweet spot. The apparent mid-range cluster reflects that low-view videos also have lower keep rates, not that intermediate swipe-away is optimal. The 20-25% bucket peaks because Tyler\'s biggest videos were pushed broadly by the algorithm to non-core audiences, increasing swipe-away as a side effect of scale. Better keep rate is always better.',
        '<strong>Duration data is confounded</strong> — YouTube Shorts 60s limit existed during most of the 100M+ video era. Inconclusive.',
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
            case 'insights': return renderInsights();
            case 'autoResearch': return renderAutoResearch();
            case 'resolution': return renderResolution();
            case 'methodology': return renderMethodology();
            default: return '';
        }
    }

    // ── Analytical Brain — Runnable Tool Cards ──
    function renderAnalytical() {
        return `<div class="jarvis-tools-grid">
            ${TOOL_DEFS.map(t => {
                if (t.planned) {
                    return `<div class="jarvis-tool-card jarvis-tool-planned">
                        <div class="jarvis-tool-icon">${t.icon}</div>
                        <h4 class="jarvis-tool-name">${t.name}</h4>
                        <p class="jarvis-tool-desc">${t.desc}</p>
                    </div>`;
                }
                const isOpen = activeToolId === t.id;
                return `<div class="jarvis-tool-card${isOpen ? ' jarvis-tool-active' : ''}">
                    <div class="jarvis-tool-card-header">
                        <div class="jarvis-tool-icon">${t.icon}</div>
                        <h4 class="jarvis-tool-name">${t.name}</h4>
                        <p class="jarvis-tool-desc">${t.desc}</p>
                    </div>
                    <button class="jarvis-tool-run-btn" data-tool="${t.id}">${isOpen ? 'Close' : 'Run Tool →'}</button>
                    ${isOpen ? `<div class="jarvis-tool-panel">${renderToolPanel(t.id)}</div>` : ''}
                </div>`;
            }).join('')}
        </div>`;
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
        const panel = container.querySelector('.jarvis-tool-panel');
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
                <button class="jarvis-btn-disabled" disabled>Promote as Indicator</button>
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
                <div class="jarvis-result-interp" style="margin-top:10px">
                    <em>2D projection (t-SNE / PCA) is next. This shows which videos are closest to the average profile across selected signals.</em>
                </div>
            </div>`;
    }

    // ── Tactical Brain — Vector Network Graph ──
    function renderTactical() {
        setTimeout(() => drawTacticalGraph(), 100);
        return `
            <div class="jarvis-tactical-network">
                <canvas id="jarvis-network-canvas" width="400" height="350"></canvas>
                <div id="jarvis-network-tooltip" class="jarvis-network-tooltip" style="display:none;"></div>
            </div>
            <div class="jarvis-network-legend">
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#3b82f6"></span>Analytics</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#8b5cf6"></span>LLM-scored</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#14b8a6"></span>Derived</span>
                <span class="jarvis-legend-item"><span class="jarvis-legend-dot" style="background:#4b5563"></span>Planned</span>
            </div>`;
    }

    function getNodeColor(ind) {
        if (ind.category === 'planned') return '#4b5563';
        if (ind.source.startsWith('Derived')) return '#14b8a6';
        if (ind.source.startsWith('YouTube') || ind.source.includes('YouTube')) return '#3b82f6';
        return '#8b5cf6'; // LLM-scored
    }

    function getNodeRadius(key) {
        const large = ['keep', 'retention', 'z_score', 'views', 'vz_score'];
        const medium = ['novelty', 'cognitive_load', 'net_novelty', 'z_type', 'vz_type', 'share_rate'];
        if (large.includes(key)) return 18;
        if (medium.includes(key)) return 14;
        return 10;
    }

    function drawTacticalGraph() {
        const canvas = container?.querySelector('#jarvis-network-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.parentElement.clientWidth || 400;
        const H = 350;
        canvas.width = W;
        canvas.height = H;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        ctx.scale(dpr, dpr);

        // Static cluster positions
        const cx = W / 2, cy = H / 2;
        const positions = {
            // Top cluster: analytics outputs
            keep:       { x: cx - 60, y: 50 },
            retention:  { x: cx + 60, y: 50 },
            views:      { x: cx,      y: 90 },
            // Left cluster: Zeigarnik signals
            z_score:    { x: 70,       y: cy - 30 },
            z_type:     { x: 50,       y: cy + 30 },
            vz_score:   { x: 130,      y: cy - 50 },
            vz_type:    { x: 130,      y: cy + 20 },
            // Right cluster: novelty signals
            novelty:        { x: W - 70,  y: cy - 50 },
            cognitive_load: { x: W - 70,  y: cy + 10 },
            net_novelty:    { x: W - 130, y: cy - 20 },
            // Bottom: misc
            share_rate:          { x: cx - 80, y: H - 60 },
            hook_clarity:        { x: cx + 20, y: H - 40 },
            visual_surprise:     { x: cx + 100,y: H - 60 },
            pacing:              { x: cx - 30, y: H - 90 },
            emotional_resonance: { x: cx + 70, y: H - 90 },
        };

        const edges = [
            ['net_novelty', 'novelty'],
            ['net_novelty', 'cognitive_load'],
            ['share_rate', 'views'],
            ['vz_score', 'vz_type'],
            ['z_score', 'z_type'],
            ['vz_score', 'z_score'],
            ['keep', 'retention'],
        ];

        // Build node list
        const nodes = INDICATORS.map(ind => ({
            key: ind.key,
            label: ind.label,
            type: ind.type,
            source: ind.source,
            color: getNodeColor(ind),
            r: getNodeRadius(ind.key),
            x: positions[ind.key]?.x || cx,
            y: positions[ind.key]?.y || cy,
        }));

        const nodeMap = {};
        nodes.forEach(n => nodeMap[n.key] = n);

        // Draw edges
        ctx.lineWidth = 1.5;
        edges.forEach(([a, b]) => {
            const na = nodeMap[a], nb = nodeMap[b];
            if (!na || !nb) return;
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(100, 116, 139, 0.4)';
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

            // Label
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '10px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(n.label, n.x, n.y + n.r + 12);
        });

        // Hover/click interaction
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

        canvas.onclick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            for (const n of nodes) {
                const dx = mx - n.x, dy = my - n.y;
                if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) {
                    if (NUMERIC_KEYS.includes(n.key)) {
                        toolSelections.pearson.signalA = n.key;
                        activeToolId = 'pearson';
                        activeTab = 'analytical';
                        render();
                    }
                    break;
                }
            }
        };
    }

    // ── Experiments — Saved results only ──
    function renderExperiments() {
        return `
            <div class="jarvis-exp-header">
                <span class="jarvis-exp-count">n=203 videos | 5 signals scored</span>
            </div>
            <div class="jarvis-experiments">
                ${EXPERIMENTS.map(exp => {
                    const hasR = exp.r !== null;
                    const absR = hasR ? Math.abs(exp.r) : 0;
                    const barColor = hasR ? (absR >= 0.4 ? '#10b981' : absR >= 0.2 ? '#f59e0b' : '#ef4444') : '#3b82f6';
                    const barWidth = hasR ? Math.max(absR / 0.5 * 100, 4) : 0;
                    const rLine = hasR
                        ? `<div class="jarvis-exp-r" style="color:${barColor}">r = ${exp.r.toFixed(4)}</div>
                           <div class="jarvis-exp-bar-wrap"><div class="jarvis-exp-bar" style="width:${barWidth}%;background:${barColor}"></div></div>`
                        : `<div class="jarvis-exp-r" style="color:#3b82f6">comparative analysis</div>`;
                    return `<div class="jarvis-exp-card">
                        <h4>${exp.name}</h4>
                        ${rLine}
                        <div class="jarvis-exp-finding">${exp.finding}</div>
                        <div class="jarvis-exp-badges">
                            <span class="jarvis-badge n-badge">n=${exp.n.toLocaleString()}</span>
                            <span class="jarvis-badge status-badge">${exp.status}</span>
                            ${exp.source ? `<span class="jarvis-badge source-badge">${exp.source}</span>` : ''}
                        </div>
                    </div>`;
                }).join('')}
            </div>
            <div class="jarvis-exp-footer">
                Saved Experiments &mdash; results produced by Analytical Brain tools using Tactical Brain indicators. Promote stable derived ratios/signals back into Tactical Brain.
            </div>
        `;
    }

    // ── Resolution ──
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

        // axes
        ctx.strokeStyle = 'rgba(100,120,180,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top);
        ctx.lineTo(pad.left, pad.top + plotH);
        ctx.lineTo(pad.left + plotW, pad.top + plotH);
        ctx.stroke();

        // x-axis labels
        const levels = registry.map(r => r.level);
        const minL = Math.min(...levels), maxL = Math.max(...levels);
        const rangeL = maxL - minL || 1;
        ctx.font = '10px system-ui'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'center';
        for (let i = 0; i <= 5; i++) {
            const x = pad.left + (i / 5) * plotW;
            ctx.fillText('R' + i, x, pad.top + plotH + 14);
        }
        ctx.fillText('Resolution (coarse → fine)', pad.left + plotW / 2, pad.top + plotH + 30);

        // y-axis labels
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

        // research target depth line (dashed at depth=4)
        const targetY = pad.top + plotH - (4 / 10) * plotH;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(167,139,250,0.4)';
        ctx.beginPath();
        ctx.moveTo(pad.left, targetY);
        ctx.lineTo(pad.left + plotW, targetY);
        ctx.stroke();
        ctx.fillStyle = '#a78bfa'; ctx.textAlign = 'left'; ctx.font = '9px system-ui';
        ctx.fillText('Research target depth', pad.left + 4, targetY - 4);

        // current focus line (dashed at R3)
        const focusX = pad.left + (3 / rangeL) * plotW;
        ctx.strokeStyle = 'rgba(6,182,212,0.4)';
        ctx.beginPath();
        ctx.moveTo(focusX, pad.top);
        ctx.lineTo(focusX, pad.top + plotH);
        ctx.stroke();
        ctx.fillStyle = '#06b6d4'; ctx.textAlign = 'center';
        ctx.fillText('Current focus', focusX, pad.top - 6);
        ctx.setLineDash([]);

        // draw gaps as small dim red dots
        registry.forEach(r => {
            const cx = pad.left + ((r.level - minL) / rangeL) * plotW;
            (r.gaps || []).forEach((_, gi) => {
                const gapDepth = Math.max(0, r.signals.length - 1 - gi * 0.5);
                const cy = pad.top + plotH - (gapDepth / 10) * plotH;
                const offX = (Math.random() - 0.5) * 16;
                const offY = (Math.random() - 0.5) * 10 + 12;
                ctx.beginPath();
                ctx.arc(cx + offX, cy + offY, 3, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(248,113,113,0.35)';
                ctx.fill();
            });
        });

        // draw main circles
        registry.forEach(r => {
            const cx = pad.left + ((r.level - minL) / rangeL) * plotW;
            const cy = pad.top + plotH - (r.depth / 10) * plotH;
            const radius = Math.min(50, Math.max(20, 20 + (r.observationCount / 10)));
            const color = statusColor[r.status] || statusColor.planned;

            // glow
            ctx.beginPath();
            ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2);
            ctx.fillStyle = color.replace(')', ',0.1)').replace('rgb', 'rgba').replace('#', '');
            // manual hex to rgba glow
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 1;

            // main circle
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fillStyle = color + '33';
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();

            // label
            ctx.fillStyle = '#e2e8f0';
            ctx.font = 'bold 12px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('R' + r.level, cx, cy + 4);
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

        // Build research loop status text per level
        const loopStatusText = {
            0: `Running — ${registry.find(r=>r.level===0)?.signals.length||0} signals active, R²=0.147. Hypothesis queue: 6 experiments pending`,
            1: `Running — ${registry.find(r=>r.level===1)?.signals.length||0} signals active (Zeigarnik text, visual, type). Gap: body segment analysis`,
            3: `Partial — ${registry.find(r=>r.level===3)?.signals.length||0} signals scored (vz_score, z_score). Gaps: audio layer, first-frame visual`,
        };
        const defaultLoopStatus = (r) => `Planned — no signals scored yet. Priority: ${r.gaps[0] || 'TBD'} (R${r.level})`;

        // Research loop step for each status
        const loopStepByStatus = { active: 3, partial: 2, planned: 0 }; // 0-indexed: active=Experiment(3), partial=Score(2), planned=Observe(0)
        const loopSteps = ['Observe', 'Hypothesize', 'Score', 'Experiment', 'Update'];

        // Filter active/partial for research loop cards
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
                    const parentLabel = r.parent ? registry.find(p => p.id === r.parent) : null;
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
                            ${parentLabel ? `<div class="jarvis-res-parent">\u2192 finer than: R${parentLabel.level} ${parentLabel.name}</div>` : '<div class="jarvis-res-parent">\u2014 root resolution</div>'}
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

    // ── Insights ──
    // ── AutoResearch ──
    let arModel = null;
    let arHypotheses = null;
    let arResults = null;

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
        if (!arResults) {
            try {
                const r = await fetch('./buildings/jarvis/results.tsv');
                const text = await r.text();
                const lines = text.trim().split('\n');
                const headers = lines[0].split('\t');
                arResults = lines.slice(1).filter(l => l.trim()).map(line => {
                    const cols = line.split('\t');
                    const row = {};
                    headers.forEach((h, i) => row[h] = cols[i] || '');
                    return row;
                });
            } catch (e) { arResults = []; }
        }
    }

    function renderAutoResearch() {
        loadAutoResearchData().then(() => {
            const el = container?.querySelector('.jarvis-ar-root');
            if (el) el.innerHTML = renderAutoResearchContent();
            bindAutoResearchEvents();
        });
        return '<div class="jarvis-ar-root"><div style="color:var(--j-muted);padding:20px;">Loading AutoResearch data…</div></div>';
    }

    function renderAutoResearchContent() {
        if (!arModel) return '<div style="color:#f87171;padding:20px;">Failed to load prediction model.</div>';
        const m = arModel;
        const signals = [
            { key: 'keep', label: 'Keep Rate', placeholder: '0–100', def: 80 },
            { key: 'retention', label: 'Retention %', placeholder: '0–100', def: 87 },
            { key: 'vz_score', label: 'Visual Zeigarnik', placeholder: '1–10', def: 8 },
            { key: 'z_score', label: 'Zeigarnik Score', placeholder: '1–10', def: 7 },
            { key: 'novelty', label: 'Novelty', placeholder: '1–10', def: 7 },
            { key: 'cognitive_load', label: 'Cognitive Load', placeholder: '1–10', def: 3 },
            { key: 'net_novelty', label: 'Net Novelty', placeholder: '-3 to 8', def: 4 },
        ];

        const statusBadge = (s) => {
            if (s === 'complete') return '<span class="jarvis-ar-status jarvis-ar-status-complete">complete</span>';
            if (s === 'running') return '<span class="jarvis-ar-status jarvis-ar-status-running">running</span>';
            return '<span class="jarvis-ar-status jarvis-ar-status-queued">queued</span>';
        };

        const r2 = 0.147;
        const target = 0.50;
        const pct = Math.round((r2 / target) * 100);

        const resultsRows = (arResults || []).map(row => {
            const status = (row.status || '').trim().toLowerCase();
            let cls = 'jarvis-ar-tsv-discard';
            if (status === 'keep') cls = 'jarvis-ar-tsv-keep';
            else if (status === 'error') cls = 'jarvis-ar-tsv-error';
            return `<tr class="${cls}">
                <td>${row.experiment_id || ''}</td>
                <td>${row.new_signal || ''}</td>
                <td>${row.r2_before || ''}→${row.r2_after || ''}</td>
                <td>${row.delta_r2 || ''}</td>
                <td><span class="jarvis-ar-tsv-status jarvis-ar-tsv-status-${status}">${status}</span></td>
                <td>${row.notes || ''}</td>
            </tr>`;
        }).join('');

        return `
            <!-- Section 0: AutoResearch Framework -->
            <div class="jarvis-ar-section jarvis-ar-framework">
                <h3 class="jarvis-ar-title">AutoResearch — Karpathy-style Autonomous Research Loop</h3>
                <p class="jarvis-ar-subtitle">Autonomous agent improves the prediction model overnight. The agent scores new signals, runs experiments, keeps improvements, discards failures — loop forever until R² > 0.50.</p>

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
                            <div class="jarvis-ar-fstat"><span>Model version</span><strong>v1</strong></div>
                            <div class="jarvis-ar-fstat"><span>R²</span><strong>0.147 (14.7% of variance)</strong></div>
                            <div class="jarvis-ar-fstat"><span>Target R²</span><strong>0.50</strong></div>
                            <div class="jarvis-ar-fstat jarvis-ar-fstat-bar">
                                <span>Progress</span>
                                <div class="jarvis-ar-progress-track">
                                    <div class="jarvis-ar-progress-fill" style="width:${pct}%"></div>
                                    <div class="jarvis-ar-progress-label">${pct}%</div>
                                </div>
                            </div>
                            <div class="jarvis-ar-fstat"><span>Videos</span><strong>203</strong></div>
                            <div class="jarvis-ar-fstat"><span>Active signals</span><strong>7</strong></div>
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

            <!-- Experiment Log -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">Experiment Log</h3>
                <div class="jarvis-ar-tsv-wrap">
                    <table class="jarvis-ar-tsv-table">
                        <thead>
                            <tr>
                                <th>Experiment</th>
                                <th>Signal</th>
                                <th>R² before→after</th>
                                <th>Delta</th>
                                <th>Status</th>
                                <th>Notes</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${resultsRows || '<tr><td colspan="6" style="color:var(--j-muted);text-align:center;">No experiments logged yet.</td></tr>'}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Section 1: Prediction Model -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">Video Success Predictor</h3>
                <p class="jarvis-ar-subtitle">Multi-signal regression model. Input your signals, get a predicted view count.</p>

                <div class="jarvis-ar-stats-card">
                    <div class="jarvis-ar-stat">Training data: <strong>203 videos</strong></div>
                    <div class="jarvis-ar-stat">R² = <strong>0.147</strong> (14.7% of variance explained)</div>
                    <div class="jarvis-ar-stat">Cross-validation R² = <strong>0.287</strong></div>
                    <div class="jarvis-ar-stat">Prediction accuracy: <strong>±4.6x</strong></div>
                    <div class="jarvis-ar-stat jarvis-ar-note">Baseline v1 — model improves as we add depth (new signals from hypothesis queue)</div>
                </div>

                <div class="jarvis-ar-scorer">
                    <h4 class="jarvis-ar-scorer-title">Video Scorer</h4>
                    <div class="jarvis-ar-inputs">
                        ${signals.map(s => `
                            <div class="jarvis-ar-input-group">
                                <label>${s.label}</label>
                                <input type="number" id="ar-input-${s.key}" value="${s.def}" placeholder="${s.placeholder}" step="any" />
                            </div>
                        `).join('')}
                    </div>
                    <button class="jarvis-ar-predict-btn" id="ar-predict-btn">Predict Views →</button>
                    <div id="ar-prediction-result" class="jarvis-ar-result"></div>
                </div>
            </div>

            <!-- Section 2: Hypothesis Queue -->
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

            <!-- Section 3: Research Loop Diagram -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">AutoResearch Loop</h3>
                <div class="jarvis-ar-loop">
                    <div class="jarvis-ar-loop-step">
                        <div class="jarvis-ar-loop-pill">1. Observe</div>
                        <div class="jarvis-ar-loop-sub">Watch videos, note patterns</div>
                    </div>
                    <div class="jarvis-ar-loop-arrow"></div>
                    <div class="jarvis-ar-loop-step">
                        <div class="jarvis-ar-loop-pill">2. Hypothesize</div>
                        <div class="jarvis-ar-loop-sub">Propose what to measure</div>
                    </div>
                    <div class="jarvis-ar-loop-arrow"></div>
                    <div class="jarvis-ar-loop-step jarvis-ar-loop-active">
                        <div class="jarvis-ar-loop-pill">3. Score Signal</div>
                        <div class="jarvis-ar-loop-sub">Score 203 videos via LLM vision</div>
                    </div>
                    <div class="jarvis-ar-loop-arrow"></div>
                    <div class="jarvis-ar-loop-step">
                        <div class="jarvis-ar-loop-pill">4. Run Experiment</div>
                        <div class="jarvis-ar-loop-sub">Compute r value vs keep/views</div>
                    </div>
                    <div class="jarvis-ar-loop-arrow"></div>
                    <div class="jarvis-ar-loop-step">
                        <div class="jarvis-ar-loop-pill">5. Update Model</div>
                        <div class="jarvis-ar-loop-sub">Add signal to model, measure R² gain</div>
                    </div>
                </div>
            </div>

            <!-- Section 4: Model Accuracy History -->
            <div class="jarvis-ar-section">
                <h3 class="jarvis-ar-title">R² Improvement Over Time</h3>
                <div class="jarvis-ar-history">
                    <div class="jarvis-ar-history-row">
                        <div class="jarvis-ar-history-label">v0 <span class="jarvis-ar-history-tag">baseline</span></div>
                        <div class="jarvis-ar-history-bar-track">
                            <div class="jarvis-ar-history-bar" style="width:0%"></div>
                        </div>
                        <div class="jarvis-ar-history-val">R²=0.000</div>
                        <div class="jarvis-ar-history-desc">no signals</div>
                    </div>
                    <div class="jarvis-ar-history-row jarvis-ar-history-current">
                        <div class="jarvis-ar-history-label">v1 <span class="jarvis-ar-history-tag jarvis-ar-history-tag-current">current</span></div>
                        <div class="jarvis-ar-history-bar-track">
                            <div class="jarvis-ar-history-bar jarvis-ar-history-bar-current" style="width:14.7%"></div>
                        </div>
                        <div class="jarvis-ar-history-val">R²=0.147</div>
                        <div class="jarvis-ar-history-desc">keep + retention + z_score + vz_score + novelty + cognitive_load + net_novelty</div>
                    </div>
                    <div class="jarvis-ar-history-row">
                        <div class="jarvis-ar-history-label">v2 <span class="jarvis-ar-history-tag">next</span></div>
                        <div class="jarvis-ar-history-bar-track">
                            <div class="jarvis-ar-history-bar jarvis-ar-history-bar-pending" style="width:5%"></div>
                        </div>
                        <div class="jarvis-ar-history-val">R²=?</div>
                        <div class="jarvis-ar-history-desc">pending hypothesis queue results</div>
                    </div>
                </div>
            </div>
        `;
    }

    function runPrediction() {
        if (!arModel) return;
        const m = arModel;
        const inputs = {};
        m.features.forEach(f => {
            const el = container?.querySelector('#ar-input-' + f);
            inputs[f] = el ? parseFloat(el.value) : 0;
        });

        // Normalize and predict
        let predicted_log = m.bias;
        m.features.forEach(f => {
            const min = m.feature_mins[f];
            const max = m.feature_maxs[f];
            const norm = max !== min ? (inputs[f] - min) / (max - min) : 0;
            predicted_log += m.weights[f] * norm;
        });
        const predicted_views = Math.pow(10, predicted_log);
        const range_low = predicted_views / m.prediction_range_multiplier;
        const range_high = predicted_views * m.prediction_range_multiplier;

        let colorClass = 'jarvis-ar-result-red';
        if (predicted_views >= 10e6) colorClass = 'jarvis-ar-result-green';
        else if (predicted_views >= 1e6) colorClass = 'jarvis-ar-result-yellow';

        const resultEl = container?.querySelector('#ar-prediction-result');
        if (resultEl) {
            resultEl.innerHTML = `
                <div class="jarvis-ar-result-card ${colorClass}">
                    <div class="jarvis-ar-result-views">${fmtViews(predicted_views)} predicted views</div>
                    <div class="jarvis-ar-result-range">±4.6x → range: ${fmtViews(range_low)} — ${fmtViews(range_high)}</div>
                    <div class="jarvis-ar-result-badge">v1 model · R²=0.147 · improves with more signals</div>
                </div>
            `;
        }
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
    }

    function renderInsights() {
        return `<ol class="jarvis-insights">
            ${INSIGHTS.map(i => `<li>${i}</li>`).join('')}
        </ol>`;
    }

    // ── Methodology ──
    const METHODOLOGICAL_NOTES = [
        { title: 'Ratio Normalization', desc: 'All engagement metrics (shares, likes, comments) must be expressed as rates per view (e.g., shares per 1k views). Raw counts scale with views by definition — a 50M-view video will always have more raw shares than a 500k-view video. Comparing raw counts produces inflated differences (470x) that collapse to modest ones (2.1x) after normalization.' },
        { title: 'Log-Normalization for Views', desc: 'View counts follow a power-law distribution — a few videos have 50M+ views while most cluster under 2M. Pearson correlation on raw views is dominated by outliers. Log-transforming view counts before computing correlations gives each video proportional weight and reveals the true relationship strength.' },
        { title: 'Quartile Analysis > Pearson', desc: 'Pearson measures linear relationships, but video metrics often have non-linear thresholds (e.g., retention below 70% is a cliff, 82-86% is a sweet spot, above 86% has diminishing returns). Bucketing into quartiles captures these step-changes that a single r value averages away.' },
        { title: 'Confounder Documentation', desc: 'Each experiment must document known confounders. Examples: Duration analysis confounded by YouTube\'s 60s Shorts limit (platform constraint, not creator choice). Channel concentration confounded by subscriber base (large channels produce more content). Title length confounded by content quality (good creators may also write better titles). Unflagged confounders lead to false conclusions.' },
    ];

    function renderMethodology() {
        return `<div class="jarvis-methodology">
            <p class="jarvis-method-intro">Statistical methods and corrections applied across all experiments:</p>
            ${METHODOLOGICAL_NOTES.map(note => `
                <div class="jarvis-method-card">
                    <h4>${note.title}</h4>
                    <p>${note.desc}</p>
                </div>
            `).join('')}
        </div>`;
    }

    // ── Events ──
    function bindEvents() {
        if (!container) return;

        // Tab switching
        container.querySelectorAll('.jarvis-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                render();
            });
        });

        // Analytical: tool open/close
        container.querySelectorAll('.jarvis-tool-run-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.tool;
                activeToolId = activeToolId === id ? null : id;
                render();
            });
        });

        // Analytical: tool execute
        container.querySelectorAll('.jarvis-tool-execute').forEach(btn => {
            btn.addEventListener('click', () => executeTool(btn.dataset.tool));
        });

        // Tactical: use in tool toggle
        container.querySelectorAll('.jarvis-use-in-tool').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.key;
                chooserKey = chooserKey === key ? null : key;
                render();
            });
        });

        // Tactical: chooser tool button
        container.querySelectorAll('.jarvis-chooser-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const toolId = btn.dataset.tool;
                const key = btn.dataset.key;
                const param = TOOL_FIRST_PARAM[toolId];
                if (param === 'signals') {
                    if (!toolSelections.proximity.signals.includes(key)) {
                        toolSelections.proximity.signals.push(key);
                    }
                } else if (toolSelections[toolId]) {
                    toolSelections[toolId][param] = key;
                }
                activeToolId = toolId;
                activeTab = 'analytical';
                chooserKey = null;
                render();
            });
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
