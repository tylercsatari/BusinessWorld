/* ── Jarvis Building ── Analytical Intelligence Hub ── */
const JarvisUI = (() => {
    let container = null;
    let activeTab = 'analytical';
    let dataset = null;

    // ── Hardcoded Data ──
    const EXPERIMENTS = [
        { id: 'exp1', name: 'In-Video Keep Rate vs Views (CORRECTED)', r: 0.44, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel (213 videos with swipeRatio data)', finding: 'r=0.44 with log(Views) — MODERATE POSITIVE. Tyler was right. In-video keep rate (% who stay watching past the hook) has real predictive power. Previous experiment used wrong metric (impression CTR, not in-video swipe). Corrected with swipeRatio.stayedToWatch from YouTube Analytics.' },
        { id: 'exp2', name: 'In-Video Swipe Sweet Spot: 20-25%', r: null, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Bucket analysis: 15-20% swipe-away → avg 11.1M views (n=50). 20-25% swipe → avg 13.2M views (n=58, max=285M). 25-30% swipe → avg 5.4M. Optimal range is 15-25% swipe-away (75-85% keep). Above 30% swipe drops sharply to sub-2M avg.' },
        { id: 'exp3', name: 'Retention % vs log(Views)', r: 0.32, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'r=0.32 with log(Views). Moderate signal. Avg retention by tier: 100M+=87.2%, 10-50M=87.0%, 5-10M=86.7%, 1-5M=82.7%, Sub-1M=79.4%. Clear progression — getting from 79% to 87% retention correlates with ~10x more views.' },
        { id: 'exp4', name: 'CTR (Impression→View Rate) vs Views', r: -0.01, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Near-zero correlation. CTR (viewedRate, the % of people who click from the feed) does NOT predict views. This is the metric previously mislabeled as swipe-away. It measures thumbnail/title performance — important for discoverability but not correlated with total scale.' },
        { id: 'exp5', name: 'Full Profile: Tyler 50M+ Videos', r: null, n: 5, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: '285M: keep=79.4%, ret=87.2% | 80M: keep=84.6%, ret=62.4% | 75M: keep=71.1%, ret=81.6% | 62M: keep=78.3%, ret=86.1% | 55M: keep=74.4%, ret=82.9%. Pattern: all 50M+ videos have in-video keep rates of 71-84% and retention mostly 80%+. The 80M Bulletproof Batman has only 62.4% retention but compensated with high keep (84.6%).' },
        { id: 'exp6', name: 'Keep Rate Distribution by View Tier (Corrected)', r: null, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'In-video keep rate by tier: 100M+=79.4%, 50-100M=77.1%, 10-50M=79.3%, 5-10M=76.9%, 1-5M=75.2%, Sub-1M=70.4%. Clear step up at 1M+ threshold. Previous analysis showed wrong data (keep=56% and 99% were impression CTRs, not in-video metrics).' },
        { id: 'exp7', name: 'Duration of 100M+ Videos (Confound Flagged)', r: null, n: 1961, type: 'quantified', status: 'complete', source: 'Research Center (1,961 videos)', finding: 'CONFOUND: 98% under 60s, but YouTube Shorts 60s limit was in effect when most were uploaded. Cannot conclude <60s outperforms without controlling for upload era. Experiment needs replication with 2024+ data.' },
        { id: 'exp8', name: 'Share Rate vs Views (Normalized)', r: null, n: 213, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Share rate per 1k views by tier: 10-50M=0.282, 5-10M=0.301, 1-5M=0.264, Sub-1M=0.311. Surprisingly similar across tiers. Raw share counts are misleading (50M views = more shares by definition). Rate normalization shows shares are not a strong tier separator.' },
        { id: 'exp_z1', name: 'Zeigarnik Effect Score vs Views', r: -0.08, n: 204, type: 'quantified', status: 'complete', source: 'Tyler Channel (LLM-scored)', finding: 'Pearson r=-0.08 — near zero linear correlation. BUT bucket analysis reveals a clear non-linear sweet spot: Z=6 → avg 10.2M views, Z=7 → avg 12.6M views. Z=8 drops to 5.9M, Z=9 to 4.9M, Z=10 to 4.6M. Extreme Zeigarnik (high danger/intensity) narrows audience. The sweet spot is moderate open loops — enough curiosity to hook, not so intense it filters the mass market.' },
        { id: 'exp_z2', name: 'Zeigarnik Effect vs Keep Rate', r: -0.06, n: 204, type: 'quantified', status: 'complete', source: 'Tyler Channel (LLM-scored)', finding: 'Near-zero correlation with in-video keep rate. Zeigarnik score does not directly predict hook retention. High Z-score videos (9-10) average 72-73% keep rate — slightly LOWER than mid-range (Z=6-7 at 77%). Implication: strong open loops alone don\'t prevent swipe-away; content quality and pacing are separate drivers.' },
        { id: 'exp_z3', name: 'Zeigarnik Type Breakdown', r: null, n: 204, type: 'quantified', status: 'complete', source: 'Tyler Channel (LLM-scored)', finding: 'Type B (Challenge/outcome uncertainty): n=88, avg 9.6M views — most common and highest performing. Type E (Social curiosity): n=10, avg 10.1M views — small sample but strong. Type A (Physical danger/threat): n=38, avg 7.4M views, avg Z-score 8.4 — high intensity but narrower. Type C (Mystery/reveal): n=42, avg 5.8M views. Best strategy: lean into B (can it work?) and E (social stakes), not maximum danger.' },
    ];

    const TOOLS = [
        { id: 'pearson', icon: '📐', name: 'Pearson Correlation', desc: 'Measures linear relationship between two signals. Outputs r value (-1 to +1).', use: 'Continuous numeric signals', limitation: 'Misses non-linear patterns' },
        { id: 'bucket', icon: '📊', name: 'Bucket/Quartile Analysis', desc: 'Groups videos into buckets by one signal, shows avg views per bucket.', use: 'Finding sweet spots, non-linear relationships', limitation: 'Requires enough data per bucket (n>10)' },
        { id: 'log10', icon: '📉', name: 'log10 Normalization', desc: 'Applies log10 to view counts to reduce outlier skew before correlation.', use: 'Any correlation involving raw view counts', limitation: 'Cannot be used on zero/negative values' },
        { id: 'llm', icon: '🧠', name: 'LLM Signal Scorer', desc: 'Uses GPT-4o-mini to score videos on qualitative signals (Zeigarnik, Novelty, Cognitive Load, etc.). Outputs numeric scores 1-10.', use: 'Qualitative-to-quantitative conversion', limitation: 'Subjective scoring, needs calibration' },
        { id: 'ratio', icon: '⚖️', name: 'Ratio Normalizer', desc: 'Converts raw counts to rates (per 1k views, per 1M views).', use: 'Shares, likes, subs — any metric that scales with view count', limitation: 'Low-view videos have noisy rates' },
        { id: 'net', icon: '➕➖', name: 'Net Signal Calculator', desc: 'Subtracts one signal from another to find optimal balance points. Example: Net Novelty = Novelty - Cognitive Load.', use: 'Signals with opposing effects', limitation: 'Assumes signals are on same scale' },
    ];

    const QUANTIFIED_SIGNALS = [
        { name: 'Keep Rate (in-video swipe)', tool: 'Pearson + log', r: '0.43', sweetSpot: '75-85% keep (15-25% swipe-away)', icon: '🎯' },
        { name: 'Retention %', tool: 'Pearson + log', r: '0.27', sweetSpot: '85-87%, diminishing returns above 90%', icon: '📈' },
        { name: 'Net Novelty (Novelty - Cognitive Load)', tool: 'Bucket', r: null, sweetSpot: '+2 (avg 10.3M views)', icon: '✨' },
        { name: 'Zeigarnik Score (Z type B)', tool: 'Bucket', r: null, sweetSpot: 'Z=6-7 (avg 10-12.6M views)', icon: '🔄' },
        { name: 'Share Rate (per 1k views)', tool: 'Ratio Norm', r: null, sweetSpot: 'Viral=0.66/1k vs avg=0.31/1k', icon: '🔗' },
        { name: 'Discovery Rate (non-sub %)', tool: 'Pearson', r: '0.31', sweetSpot: 'Higher = algorithm pushing to new audiences', icon: '🌍' },
    ];

    const UNQUANTIFIED_SIGNALS = [
        { name: 'Hook Clarity', desc: 'How immediately obvious is what the video is about?', icon: '💡' },
        { name: 'Visual Surprise', desc: 'Does the first frame make you do a double-take?', icon: '👀' },
        { name: 'Pacing', desc: 'Does it cut/move faster than expected?', icon: '⚡' },
        { name: 'Emotional Resonance', desc: 'Does it connect to a universal feeling?', icon: '❤️' },
    ];

    const TABS = [
        { id: 'analytical', label: 'Analytical Brain' },
        { id: 'tactical', label: 'Tactical Brain' },
        { id: 'experiments', label: 'Experiments' },
        { id: 'insights', label: 'Insights' },
        { id: 'resolution', label: 'Resolution' },
        { id: 'methodology', label: 'Methodology' },
    ];

    const INSIGHTS = [
        '<strong>Keep Rate (r=0.43) is the strongest quantified predictor</strong> — get swipe-away under 25%. In-video keep rate has real predictive power for total views.',
        '<strong>Net Novelty sweet spot = +2</strong> (Novelty exceeds Cognitive Load by exactly 2). Both too easy and too complex underperform. Average 10.3M views at the sweet spot.',
        '<strong>Zeigarnik Z=7 (not Z=10) peaks at 12.6M avg</strong> — moderate open loops beat maximum intensity. Z=10 averages only 4.6M. Enough curiosity to hook, not so intense it filters the mass market.',
        '<strong>Best Zeigarnik type is B (Challenge uncertainty)</strong>: 88 videos, avg 9.6M views. Frame as \'can this actually work?\' not \'watch this dangerous thing happen\'. Type E (social stakes) has the highest avg at 10.1M but only 10 videos.',
        '<strong>Zeigarnik does NOT directly predict keep rate</strong> — high Z-score videos have slightly lower keep rates (72%) than mid-range (77%). Open loops and hook retention are separate mechanisms. Need both.',
        '<strong>Retention 87%+ correlates with 10M+ avg views</strong> — progression from 79% (sub-1M) to 87% (100M+) is the clearest signal in the dataset.',
        '<strong>CTR (impression to view rate) has zero correlation with total views</strong> — it measures thumbnail appeal, not viral potential.',
        '<strong>The 20-25% swipe-away bucket is the highest performing</strong> (avg 13.2M, max 285M) — some swipe-away is fine and may indicate fast-moving content that not everyone finishes.',
        '<strong>Duration data is confounded</strong> — YouTube Shorts 60s limit existed during most of the 100M+ video era. Inconclusive.',
    ];

    const SIGNAL_KEYS = {
        'Keep Rate': 'keep',
        'Retention %': 'retention',
        'Zeigarnik Score': 'z_score',
        'Novelty': 'novelty',
        'Cognitive Load': 'cognitive_load',
        'Net Novelty': 'net_novelty',
        'Share Rate': 'share_rate',
        'Views': 'views',
    };

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

    function bucketAnalysis(signal, views, numBuckets) {
        if (!signal.length) return [];
        const min = Math.min(...signal);
        const max = Math.max(...signal);
        if (min === max) return [{ label: `${min}`, avgViews: views.reduce((a, b) => a + b, 0) / views.length, n: views.length }];
        const step = (max - min) / numBuckets;
        const buckets = [];
        for (let i = 0; i < numBuckets; i++) {
            const lo = min + i * step;
            const hi = i === numBuckets - 1 ? max + 0.01 : min + (i + 1) * step;
            const label = `${lo.toFixed(1)}-${hi.toFixed(1)}`;
            const indices = signal.map((v, idx) => v >= lo && v < hi ? idx : -1).filter(idx => idx >= 0);
            const bucketViews = indices.map(idx => views[idx]);
            const avg = bucketViews.length > 0 ? bucketViews.reduce((a, b) => a + b, 0) / bucketViews.length : 0;
            buckets.push({ label, avgViews: avg, n: bucketViews.length });
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
            case 'resolution': return renderResolution();
            case 'methodology': return renderMethodology();
            default: return '';
        }
    }

    // ── Analytical Brain ──
    function renderAnalytical() {
        return `<div class="jarvis-tools-grid">
            ${TOOLS.map(t => `
                <div class="jarvis-tool-card">
                    <div class="jarvis-tool-icon">${t.icon}</div>
                    <h4 class="jarvis-tool-name">${t.name}</h4>
                    <p class="jarvis-tool-desc">${t.desc}</p>
                    <div class="jarvis-tool-meta">
                        <span class="jarvis-tool-use"><strong>Use for:</strong> ${t.use}</span>
                        <span class="jarvis-tool-limit"><strong>Limitation:</strong> ${t.limitation}</span>
                    </div>
                </div>
            `).join('')}
        </div>`;
    }

    // ── Tactical Brain ──
    function renderTactical() {
        const leftCards = QUANTIFIED_SIGNALS.map(s => {
            const rLine = s.r ? `<div class="jarvis-sig-r">r = ${s.r}</div>` : '';
            return `<div class="jarvis-signal-card jarvis-signal-quantified">
                <div class="jarvis-sig-header">
                    <span class="jarvis-sig-icon">${s.icon}</span>
                    <h4>${s.name}</h4>
                </div>
                <div class="jarvis-sig-tool">Tool: ${s.tool}</div>
                ${rLine}
                <div class="jarvis-sig-sweet">Sweet spot: ${s.sweetSpot}</div>
            </div>`;
        }).join('');

        const rightCards = UNQUANTIFIED_SIGNALS.map(s =>
            `<div class="jarvis-signal-card jarvis-signal-unquantified">
                <div class="jarvis-sig-header">
                    <span class="jarvis-sig-icon">${s.icon}</span>
                    <h4>${s.name}</h4>
                </div>
                <div class="jarvis-sig-desc">${s.desc}</div>
                <button class="jarvis-llm-btn">Score with LLM</button>
            </div>`
        ).join('');

        return `<div class="jarvis-tactical">
            <div class="jarvis-tactical-col jarvis-col-quantified">
                <h3>Quantified Signals</h3>
                ${leftCards}
            </div>
            <div class="jarvis-tactical-col jarvis-col-unquantified">
                <h3>Unquantified Signals</h3>
                ${rightCards}
            </div>
        </div>`;
    }

    // ── Experiments ──
    function renderExperiments() {
        const signalOptions = Object.keys(SIGNAL_KEYS).map(k => `<option value="${k}">${k}</option>`).join('');
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
            <div class="jarvis-builder">
                <h3 class="jarvis-builder-title">Experiment Builder</h3>
                <p class="jarvis-builder-sub">Plug any signal × any tool and plot it</p>
                <div class="jarvis-builder-form">
                    <div class="jarvis-builder-field">
                        <label>X Axis Signal</label>
                        <select id="jarvis-x-axis">${signalOptions}</select>
                    </div>
                    <div class="jarvis-builder-field">
                        <label>Y Axis Signal</label>
                        <select id="jarvis-y-axis"><option value="Views">Views</option>${Object.keys(SIGNAL_KEYS).filter(k => k !== 'Views').map(k => `<option value="${k}">${k}</option>`).join('')}</select>
                    </div>
                    <div class="jarvis-builder-field">
                        <label>Measurement Tool</label>
                        <select id="jarvis-tool">
                            <option value="pearson">Pearson Correlation</option>
                            <option value="bucket">Bucket Analysis</option>
                            <option value="ratio">Ratio Normalizer</option>
                        </select>
                    </div>
                    <button class="jarvis-run-btn" id="jarvis-run-experiment">Run Experiment</button>
                </div>
                <div id="jarvis-builder-result" class="jarvis-builder-result"></div>
            </div>
        `;
    }

    // ── Run experiment ──
    async function runExperiment() {
        const xKey = document.getElementById('jarvis-x-axis').value;
        const yKey = document.getElementById('jarvis-y-axis').value;
        const tool = document.getElementById('jarvis-tool').value;
        const resultDiv = document.getElementById('jarvis-builder-result');

        resultDiv.innerHTML = '<div class="jarvis-loading">Loading dataset...</div>';

        const data = await loadDataset();
        if (!data) {
            resultDiv.innerHTML = '<div class="jarvis-error">Failed to load dataset</div>';
            return;
        }

        const xField = SIGNAL_KEYS[xKey];
        const yField = SIGNAL_KEYS[yKey];

        // Filter valid rows
        const valid = data.filter(d => d[xField] != null && d[yField] != null && d[xField] !== 0 && d[yField] !== 0);
        const xs = valid.map(d => d[xField]);
        const ys = valid.map(d => d[yField]);

        if (valid.length < 3) {
            resultDiv.innerHTML = '<div class="jarvis-error">Not enough valid data points (need at least 3)</div>';
            return;
        }

        if (tool === 'pearson') {
            // Apply log10 to views if views is one of the axes
            const logXs = xKey === 'Views' ? xs.map(v => Math.log10(Math.max(v, 1))) : xs;
            const logYs = yKey === 'Views' ? ys.map(v => Math.log10(Math.max(v, 1))) : ys;
            const r = pearsonCorrelation(logXs, logYs);
            const strength = interpretR(r);
            const absR = Math.abs(r);
            const color = absR >= 0.4 ? '#10b981' : absR >= 0.2 ? '#f59e0b' : '#ef4444';
            const logNote = (xKey === 'Views' || yKey === 'Views') ? ' (log10 applied to Views)' : '';
            resultDiv.innerHTML = `
                <div class="jarvis-result-card">
                    <div class="jarvis-result-label">Pearson Correlation${logNote}</div>
                    <div class="jarvis-result-r" style="color:${color}">r = ${r.toFixed(4)}</div>
                    <div class="jarvis-result-strength" style="color:${color}">${strength} ${r > 0 ? 'positive' : r < 0 ? 'negative' : ''} correlation</div>
                    <div class="jarvis-exp-bar-wrap"><div class="jarvis-exp-bar" style="width:${Math.max(absR / 0.5 * 100, 4)}%;background:${color}"></div></div>
                    <div class="jarvis-result-n">n = ${valid.length} videos</div>
                    <div class="jarvis-result-interp">${xKey} vs ${yKey}: ${absR < 0.1 ? 'Essentially no linear relationship.' : absR < 0.3 ? 'Weak relationship — other factors dominate.' : absR < 0.5 ? 'Moderate relationship — real signal here.' : 'Strong relationship — key predictor.'}</div>
                </div>
            `;
        } else if (tool === 'bucket') {
            const numBuckets = 6;
            const buckets = bucketAnalysis(xs, ys.map(v => yKey === 'Views' ? v : v), numBuckets);
            const maxAvg = Math.max(...buckets.map(b => b.avgViews), 1);
            const yLabel = yKey === 'Views' ? 'Avg Views' : `Avg ${yKey}`;
            resultDiv.innerHTML = `
                <div class="jarvis-result-card">
                    <div class="jarvis-result-label">Bucket Analysis: ${xKey} → ${yKey}</div>
                    <div class="jarvis-bucket-chart">
                        ${buckets.map(b => {
                            const pct = (b.avgViews / maxAvg * 100).toFixed(0);
                            const displayVal = yKey === 'Views' ? (b.avgViews >= 1000000 ? (b.avgViews / 1000000).toFixed(1) + 'M' : b.avgViews >= 1000 ? (b.avgViews / 1000).toFixed(0) + 'K' : b.avgViews.toFixed(0)) : b.avgViews.toFixed(1);
                            return `<div class="jarvis-bucket-row">
                                <span class="jarvis-bucket-label">${b.label}</span>
                                <div class="jarvis-bucket-bar-wrap">
                                    <div class="jarvis-bucket-bar" style="width:${pct}%"></div>
                                </div>
                                <span class="jarvis-bucket-val">${displayVal} <span class="jarvis-bucket-n">(n=${b.n})</span></span>
                            </div>`;
                        }).join('')}
                    </div>
                    <div class="jarvis-result-n">n = ${valid.length} videos | ${yLabel}</div>
                </div>
            `;
        } else if (tool === 'ratio') {
            // Ratio normalizer: compute signal per 1k views
            const views = valid.map(d => d.views);
            const ratios = xs.map((x, i) => views[i] > 0 ? (x / views[i]) * 1000 : 0);
            const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
            const maxRatio = Math.max(...ratios);
            const minRatio = Math.min(...ratios);
            // Bucket by view tier
            const tiers = [
                { label: 'Sub-1M', lo: 0, hi: 1000000 },
                { label: '1-5M', lo: 1000000, hi: 5000000 },
                { label: '5-10M', lo: 5000000, hi: 10000000 },
                { label: '10-50M', lo: 10000000, hi: 50000000 },
                { label: '50M+', lo: 50000000, hi: Infinity },
            ];
            const tierResults = tiers.map(t => {
                const tierVids = valid.filter(d => d.views >= t.lo && d.views < t.hi);
                const tierRatios = tierVids.map(d => d.views > 0 ? (d[xField] / d.views) * 1000 : 0);
                const avg = tierRatios.length > 0 ? tierRatios.reduce((a, b) => a + b, 0) / tierRatios.length : 0;
                return { label: t.label, avg, n: tierVids.length };
            });
            const maxTierAvg = Math.max(...tierResults.map(t => t.avg), 0.001);
            resultDiv.innerHTML = `
                <div class="jarvis-result-card">
                    <div class="jarvis-result-label">Ratio Normalizer: ${xKey} per 1k Views</div>
                    <div class="jarvis-result-n">Overall avg: ${avgRatio.toFixed(3)}/1k views | Range: ${minRatio.toFixed(3)} — ${maxRatio.toFixed(3)}</div>
                    <div class="jarvis-bucket-chart">
                        ${tierResults.map(t => {
                            const pct = (t.avg / maxTierAvg * 100).toFixed(0);
                            return `<div class="jarvis-bucket-row">
                                <span class="jarvis-bucket-label">${t.label}</span>
                                <div class="jarvis-bucket-bar-wrap">
                                    <div class="jarvis-bucket-bar" style="width:${pct}%"></div>
                                </div>
                                <span class="jarvis-bucket-val">${t.avg.toFixed(3)}/1k <span class="jarvis-bucket-n">(n=${t.n})</span></span>
                            </div>`;
                        }).join('')}
                    </div>
                    <div class="jarvis-result-n">n = ${valid.length} videos</div>
                </div>
            `;
        }
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
        // Kick off async load, render placeholder, then fill in
        loadResolutionRegistry().then(registry => {
            const el = container?.querySelector('.jarvis-resolution-root');
            if (!el || !registry) return;
            el.innerHTML = renderResolutionContent(registry);
            bindResolutionEvents();
        });

        return `<div class="jarvis-resolution-root"><div class="jarvis-loading">Loading resolution registry...</div></div>`;
    }

    function renderResolutionContent(registry) {
        const maxDepth = 10;
        const levels = registry.map(r => `R${r.level}`);

        // Build depth grid data
        const gridCells = [];
        for (let d = maxDepth; d >= 0; d--) {
            const row = registry.map(r => {
                const filled = r.signals.length > d ? true : false;
                return { level: r.level, depth: d, filled, status: r.status };
            });
            gridCells.push({ depth: d, cells: row });
        }

        return `
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
        // Check if this level already exists
        const exists = registry.some(r => r.level === mid);
        if (!exists) return mid;
        // Recurse: find a slot between lower and mid
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
    }

    function bindResolutionEvents() {
        // Submit observation
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

        // Auto-classify
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

                    // Bind action buttons
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

        container.querySelectorAll('.jarvis-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                render();
            });
        });

        const runBtn = container.querySelector('#jarvis-run-experiment');
        if (runBtn) {
            runBtn.addEventListener('click', runExperiment);
        }
    }

    // ── Public API ──
    function open(bodyEl) {
        container = bodyEl;
        activeTab = 'analytical';
        dataset = null;
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
