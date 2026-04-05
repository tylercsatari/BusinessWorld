/* ── Jarvis Building ── Analytical Intelligence Hub ── */
const JarvisUI = (() => {
    let container = null;
    let activeTab = 'analytical';
    let selectedNode = null;

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

    const BENCHMARKS = { n: 213, top10_threshold: 17242614, median_views: 1826162, top10_swipeaway: 11.89, top10_retention: 86.88, top10_shares_per_1k: 0.30, bot50_swipeaway: 6.70, bot50_retention: 80.56 };

    const ANALYTICAL_NODES = [
        { id: 'pearson', name: 'Pearson Correlation', color: '#3b82f6', desc: 'Measures linear relationship strength between two variables. Used across all 6 experiments.' },
        { id: 'percentile', name: 'Percentile Analysis', color: '#06b6d4', desc: 'Ranks videos by metric to identify top 10% and bottom 50% performance tiers.' },
        { id: 'regression', name: 'Linear Regression', color: '#8b5cf6', desc: 'Fits best-fit lines to predict views from individual metrics like shares and retention.' },
        { id: 'llm_score', name: 'LLM Scoring', color: '#f59e0b', desc: 'Uses large language models to score unquantified signals like novelty and emotional pull.' },
        { id: 'benchmark', name: 'Benchmark Comparison', color: '#10b981', desc: 'Compares individual video metrics against the n=372 dataset benchmarks.' },
    ];

    const TACTICAL_QUANTIFIED = [
        { id: 'views', name: 'Total Views', benchmark: 'median=1.83M, top10 threshold=17.2M' },
        { id: 'swipe_away', name: 'Swipe-Away Rate', benchmark: 'top10 avg=11.9%, bot50 avg=6.7%' },
        { id: 'retention', name: 'Avg Retention %', benchmark: 'top10 avg=86.9%, bot50 avg=80.6%' },
        { id: 'shares', name: 'Shares', benchmark: 'top10 avg=0.30 shares/1k views' },
        { id: 'discovery', name: 'Discovery Rate', benchmark: 'non-sub view %' },
    ];

    const TACTICAL_UNQUANTIFIED = [
        { id: 'novelty', name: 'Novelty Score', desc: 'How unique/surprising is the concept?' },
        { id: 'movement', name: 'Intro Movement', desc: 'Motion in first 3 seconds?' },
        { id: 'hook_clarity', name: 'Hook Clarity', desc: 'How clearly does hook communicate value?' },
        { id: 'emotional_pull', name: 'Emotional Pull', desc: 'Curiosity, excitement, or humor?' },
    ];

    const TABS = [
        { id: 'analytical', label: 'Analytical Brain' },
        { id: 'tactical', label: 'Tactical Brain' },
        { id: 'experiments', label: 'Experiments' },
        { id: 'insights', label: 'Insights' },
        { id: 'methodology', label: 'Methodology' },
    ];

    const INSIGHTS = [
        '<strong>Zeigarnik sweet spot is Z=6-7, NOT Z=10</strong> — videos scored 7 average 12.6M views. Z=10 (maximum danger/intensity) averages only 4.6M. Moderate open loops hook the mass market. Maximum intensity narrows it.',
        '<strong>Best Zeigarnik type is B (Challenge uncertainty)</strong>: 88 videos, avg 9.6M views. Frame as \'can this actually work?\' not \'watch this dangerous thing happen\'. Type E (social stakes) has the highest avg at 10.1M but only 10 videos.',
        '<strong>Zeigarnik does NOT directly predict keep rate</strong> — high Z-score videos have slightly lower keep rates (72%) than mid-range (77%). Open loops and hook retention are separate mechanisms. Need both.',
        '<strong>In-video keep rate (swipeRatio.stayedToWatch) has real predictive power</strong> — r=0.44 with log(Views). Tyler was right. Sweet spot: 75-85% keep rate (15-25% swipe-away). Above 30% swipe-away, avg views drop sharply.',
        '<strong>Retention 87%+ correlates with 10M+ avg views</strong> — progression from 79% (sub-1M) to 87% (100M+) is the clearest signal in the dataset.',
        '<strong>CTR (impression to view rate) has zero correlation with total views</strong> — it measures thumbnail appeal, not viral potential.',
        '<strong>The 20-25% swipe-away bucket is the highest performing</strong> (avg 13.2M, max 285M) — some swipe-away is fine and may indicate fast-moving content that not everyone finishes.',
        '<strong>Duration data is confounded</strong> — YouTube Shorts 60s limit existed during most of the 100M+ video era. Inconclusive.',
        '<strong>Next experiments:</strong> (1) keep rate in first 24h of posting (early signal), (2) LLM novelty scoring vs views, (3) filter Research Center to channels <1M subs at time of viral video.',
    ];

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
            case 'methodology': return renderMethodology();
            default: return '';
        }
    }

    // ── Analytical Brain ──
    function renderAnalytical() {
        const cx = 180, cy = 160, r = 120;
        const nodes = ANALYTICAL_NODES.map((n, i) => {
            const angle = (i * 2 * Math.PI / 5) - Math.PI / 2;
            return { ...n, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
        });

        // Edges: fully connected mesh
        let edges = '';
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                edges += `<line class="jarvis-edge" x1="${nodes[i].x}" y1="${nodes[i].y}" x2="${nodes[j].x}" y2="${nodes[j].y}"/>`;
            }
        }

        // Nodes
        let circles = nodes.map(n => {
            const isSelected = selectedNode === n.id;
            return `<g class="jarvis-node" data-node="${n.id}">
                <circle cx="${n.x}" cy="${n.y}" r="28" fill="${isSelected ? n.color : 'rgba(0,0,0,0.6)'}" stroke="${n.color}" opacity="${isSelected ? 1 : 0.9}"/>
                <text x="${n.x}" y="${n.y + 3}">${n.name.split(' ').slice(0, 2).join(' ')}</text>
            </g>`;
        }).join('');

        const detail = selectedNode
            ? (() => {
                const n = ANALYTICAL_NODES.find(n => n.id === selectedNode);
                return `<div class="jarvis-node-detail"><h4>${n.name}</h4><p>${n.desc}</p></div>`;
            })()
            : '<div class="jarvis-node-detail"><p style="color:var(--j-muted)">Click a node to see details</p></div>';

        return `<div class="jarvis-network">
            <svg viewBox="0 0 360 320">${edges}${circles}</svg>
            ${detail}
        </div>`;
    }

    // ── Tactical Brain ──
    function renderTactical() {
        const leftCards = TACTICAL_QUANTIFIED.map(s =>
            `<div class="jarvis-signal-card">
                <h4>${s.name}</h4>
                <div class="benchmark">${s.benchmark}</div>
            </div>`
        ).join('');

        const rightCards = TACTICAL_UNQUANTIFIED.map(s =>
            `<div class="jarvis-signal-card">
                <h4>${s.name}</h4>
                <div class="desc">${s.desc}</div>
                <button class="jarvis-llm-btn">Score with LLM</button>
            </div>`
        ).join('');

        return `<div class="jarvis-tactical">
            <div class="jarvis-tactical-col">
                <h3>Quantified Signals</h3>
                ${leftCards}
            </div>
            <div class="jarvis-tactical-col">
                <h3>Unquantified Signals</h3>
                ${rightCards}
            </div>
        </div>`;
    }

    // ── Experiments ──
    function renderExperiments() {
        return `<div class="jarvis-experiments">
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
        </div>`;
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
                selectedNode = null;
                render();
            });
        });

        container.querySelectorAll('.jarvis-node').forEach(g => {
            g.addEventListener('click', () => {
                selectedNode = selectedNode === g.dataset.node ? null : g.dataset.node;
                render();
            });
        });
    }

    // ── Public API ──
    function open(bodyEl) {
        container = bodyEl;
        activeTab = 'analytical';
        selectedNode = null;
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
