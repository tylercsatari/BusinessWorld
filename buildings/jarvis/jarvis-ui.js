/* ── Jarvis Building ── Analytical Intelligence Hub ── */
const JarvisUI = (() => {
    let container = null;
    let activeTab = 'analytical';
    let selectedNode = null;

    // ── Hardcoded Data ──
    const EXPERIMENTS = [
        { id: 'exp1', name: 'Swipe-Away Rate vs Views', r: 0.1422, n: 372, type: 'quantified', status: 'complete', finding: 'Weak positive — viral algorithm pushes override poor hooks. Not the primary driver.' },
        { id: 'exp2', name: 'Avg Retention vs Views', r: 0.0716, n: 372, type: 'quantified', status: 'complete', finding: 'Very weak — retention alone does not predict virality. Necessary but not sufficient.' },
        { id: 'exp3', name: 'Shares vs Views', r: 0.4505, n: 372, type: 'quantified', status: 'complete', finding: 'Moderate positive (r=0.45) — strongest predictor. Shareable content drives discovery.' },
        { id: 'exp4', name: 'Discovery Rate vs Views', r: 0.3093, n: 372, type: 'quantified', status: 'complete', finding: 'Moderate — non-subscriber views predict total view accumulation.' },
        { id: 'exp5', name: 'Engagement Rate vs Subs Gained', r: -0.0097, n: 372, type: 'quantified', status: 'complete', finding: 'No correlation. Subscriber growth driven by novelty and algorithm, not engagement rate.' },
        { id: 'exp6', name: 'Like Rate vs Share Rate', r: 0.1893, n: 372, type: 'quantified', status: 'complete', finding: 'Weak — likes and shares are independent signals.' },
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
    ];

    const INSIGHTS = [
        '<strong>Shares are the #1 growth lever</strong> (r=0.45, strongest correlation). Optimize every video for shareability — ask "would someone send this to a friend?" before publishing.',
        '<strong>Swipe-away rate is overrated</strong> (r=0.14). The algorithm compensates for mediocre hooks on high-share content. Focus hooks on curiosity, not retention tricks.',
        '<strong>Retention is necessary but not sufficient</strong> (r=0.07). High retention keeps viewers watching but doesn\'t drive discovery. Pair strong retention with a shareable concept.',
        '<strong>Engagement rate doesn\'t predict subscriber growth</strong> (r≈0). Likes and comments signal satisfaction, not conversion. Growth comes from novelty and algorithmic reach, not community metrics.',
        '<strong>Discovery rate is moderately predictive</strong> (r=0.31). Non-subscriber reach is a leading indicator — if the algorithm is pushing to new audiences, the content has breakout potential.',
    ];

    // ── Render ──
    function render() {
        if (!container) return;
        container.innerHTML = `
            <div class="jarvis-panel">
                <div class="jarvis-header">
                    <div>
                        <h2 class="jarvis-header-title">J.A.R.V.I.S.</h2>
                        <div class="jarvis-header-sub">Analytical Intelligence Hub &middot; n=${BENCHMARKS.n} videos</div>
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
                const absR = Math.abs(exp.r);
                const barColor = absR >= 0.4 ? '#10b981' : absR >= 0.2 ? '#f59e0b' : '#ef4444';
                const barWidth = Math.max(absR / 0.5 * 100, 4);
                return `<div class="jarvis-exp-card">
                    <h4>${exp.name}</h4>
                    <div class="jarvis-exp-r" style="color:${barColor}">r = ${exp.r.toFixed(4)}</div>
                    <div class="jarvis-exp-bar-wrap">
                        <div class="jarvis-exp-bar" style="width:${barWidth}%;background:${barColor}"></div>
                    </div>
                    <div class="jarvis-exp-finding">${exp.finding}</div>
                    <div class="jarvis-exp-badges">
                        <span class="jarvis-badge n-badge">n=${exp.n}</span>
                        <span class="jarvis-badge status-badge">${exp.status}</span>
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
