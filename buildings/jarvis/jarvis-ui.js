/* ── Jarvis Building ── Analytical Intelligence Hub ── */
const JarvisUI = (() => {
    let container = null;
    let activeTab = 'analytical';
    let selectedNode = null;

    // ── Hardcoded Data ──
    const EXPERIMENTS = [
        { id: 'exp1', name: 'Keep Rate vs Views (Corrected)', r: -0.037, n: 372, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Very weak after log-normalization. Swipe-away at 50M+ is HIGH because videos are shown to broad non-core audiences. Controlled by view tier: 5M+ videos have 93.9% keep rate vs 92.1% for <5M — higher quality actually shows at scale.' },
        { id: 'exp2', name: 'Retention % vs Views (Quartile Analysis)', r: null, n: 372, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Strong NON-LINEAR pattern. Q1 (≤70% retention) = 2.6M avg views. Q3 (82-86%) = 10.2M avg views — 4x more views. Q4 (86%+) = 9.0M. Getting from 70% to 86% retention is worth 4x views. This is the clearest signal in the dataset.' },
        { id: 'exp3', name: 'Share RATE vs Views (Normalized)', r: -0.077, n: 372, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'When normalized to shares per 1k views: 50M+ videos get 0.663 shares/1k vs 0.311 for sub-1M — a 2.1x difference (not 470x as raw count suggested). Share rate still a signal but not the dominant one.' },
        { id: 'exp4', name: 'Discovery Rate vs Views', r: 0.309, n: 372, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Moderate positive — non-subscriber view percentage predicts total view accumulation. Algorithm-driven distribution to non-subscribers is a meaningful signal.' },
        { id: 'exp5', name: 'Engagement Rate vs Subscribers Gained', r: -0.010, n: 372, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'No correlation. Subscriber growth driven by novelty and algorithm timing, not engagement rate.' },
        { id: 'exp6', name: 'Title Length vs Views (Variance Check)', r: 0.011, n: 372, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Near-zero correlation. Short titles have 29M stdev — massive variance. Title length is confounded by content quality. Inconclusive, needs content quality controls.' },
        { id: 'exp7', name: 'Duration of 100M+ Videos (Confound Flagged)', r: null, n: 1961, type: 'quantified', status: 'complete', source: 'Research Center', finding: 'CONFOUND: 98% under 60s, but YouTube Shorts 60s limit was in effect when most were uploaded. Cannot conclude <60s outperforms without controlling for era. Experiment needs replication with 2024+ data when >60s Shorts exist.' },
        { id: 'exp8', name: 'Share Rate 50M+ vs Sub-1M (Normalized)', r: null, n: 372, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: '2.1x share rate difference (per 1k views): 0.663 vs 0.311. Real but modest. Raw share count was 470x because 50M+ videos have 50x more views by definition — ratio normalization is required for all engagement metrics.' },
        { id: 'exp9', name: 'Keep Rate by View Tier (Controlled)', r: null, n: 372, type: 'quantified', status: 'complete', source: 'Tyler Channel', finding: 'Tyler is correct: 5M+ videos average 93.9% keep rate vs 92.1% for <5M. The 50M+ lifetime swipe-away looks higher because broad algorithmic distribution reaches non-ideal audiences AFTER the video has already gone viral.' },
        { id: 'exp10', name: 'Channel Concentration in 100M+ Set', r: null, n: 1961, type: 'quantified', status: 'complete', source: 'Research Center', finding: '10% of channels have 3+ viral hits, but subscriber base is a major confounder. MrBeast (400M+ subs) having 103 viral videos vs a small creator having 1 are not comparable. Next experiment: filter to channels under 1M subs at time of viral video.' },
    ];

    const BENCHMARKS = { n: 372, top10_threshold: 17242614, median_views: 1826162, top10_swipeaway: 11.89, top10_retention: 86.88, top10_shares_per_1k: 0.30, bot50_swipeaway: 6.70, bot50_retention: 80.56 };

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
        '<strong>Retention 82-86% is the sweet spot</strong> — Q3 averages 10.2M views, 4x more than Q1 (70%). Getting above 86% shows diminishing returns (Q4 = 9.0M). Target 82-86%+ retention.',
        '<strong>Share rate is a 2.1x signal</strong> — viral videos get twice as many shares per view. When measuring engagement, always use RATES (per view), never raw counts.',
        '<strong>Keep rate is actually HIGHER at scale</strong> — Tyler is right. 5M+ videos have 93.9% avg keep rate. Broad distribution dilutes lifetime swipe-away. Early keep rate (first 1M impressions) is the metric to track.',
        '<strong>Duration data is confounded</strong> — 98% of 100M+ videos are <60s but the 60s limit existed during this era. Cannot conclude shorter is better without controlling for upload date.',
        '<strong>All Pearson correlations are weak (r<0.2)</strong> — video performance is multi-dimensional. Retention quartile analysis (non-linear bucketing) reveals more than linear correlation.',
        '<strong>Next experiments needed:</strong> (1) filter Research Center to <1M sub channels, (2) early keep rate (first 24h), (3) novelty/hook scoring via LLM.',
    ];

    // ── Render ──
    function render() {
        if (!container) return;
        container.innerHTML = `
            <div class="jarvis-panel">
                <div class="jarvis-header">
                    <div>
                        <h2 class="jarvis-header-title">J.A.R.V.I.S.</h2>
                        <div class="jarvis-header-sub">Analytical Intelligence Hub &middot; 1,961 research + 372 channel = 2,333 videos</div>
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
