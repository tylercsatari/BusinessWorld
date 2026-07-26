(function () {
    'use strict';

    const ARTIFACT_URL = './buildings/jarvis/principles-lab/artifact.json?v=2';
    const VIEWS = [
        ['discoveries', 'Discoveries'],
        ['system', 'Whole system'],
        ['atlas', 'Cluster atlas'],
        ['models', 'Prediction audit'],
        ['evidence', 'Evidence ledger'],
        ['method', 'Method'],
    ];
    const CLUSTER_COLORS = [
        '#56c9ff', '#ff775f', '#6ed69f', '#f0bd4e', '#b396ff', '#ef7eb6',
        '#43d5c3', '#ff9f43', '#82a7ff', '#d4d968', '#c88356', '#84d3ef',
        '#ff607d', '#62ba77', '#d09dff', '#ffd27a', '#66a8a1', '#d77f68',
        '#5f88cf', '#b8cd5d', '#b68973', '#7cddbc', '#ea88de', '#a8b9d8',
    ];
    const STATUS = {
        supported: ['supported', 'green'],
        supported_negative: ['supported negative', 'green'],
        methodological: ['method invariant', 'cyan'],
        mixed: ['mixed evidence', 'amber'],
        taxonomy_only: ['taxonomy only', 'amber'],
        synthesis_hypothesis: ['synthesis to test', 'purple'],
        falsified: ['falsified', 'red'],
        invalidated: ['invalidated', 'red'],
    };
    const TEST_STATUS = {
        pass: ['supports', 'green'],
        fail: ['fails', 'red'],
        mixed: ['mixed', 'amber'],
        invalid: ['invalid test', 'red'],
        unknown: ['not tested', 'muted'],
    };
    const CELL_STATUS = {
        survived: ['survived', 'green'],
        tested: ['tested', 'cyan'],
        partial: ['partial', 'amber'],
        failed: ['failed', 'red'],
        untested: ['untested', 'muted'],
    };

    const state = {
        root: null,
        data: null,
        error: '',
        loading: false,
        view: 'discoveries',
        invariantId: null,
        transformationId: null,
        mapId: 'shorts:visual',
        projection: 'pca',
        clusterCount: 6,
        colorBy: 'cluster',
        pointId: null,
        transportKey: null,
        modelId: null,
        surfaceId: null,
        graphNodeId: null,
        evidenceSearch: '',
        surfaceFilter: 'all',
    };

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function fmt(value, digits = 2) {
        if (!Number.isFinite(Number(value))) return '—';
        return Number(value).toLocaleString(undefined, {
            maximumFractionDigits: digits,
            minimumFractionDigits: 0,
        });
    }

    function compact(value) {
        if (!Number.isFinite(Number(value))) return '—';
        return Intl.NumberFormat('en', {
            notation: 'compact',
            maximumFractionDigits: 1,
        }).format(Number(value));
    }

    function pct(value, digits = 1) {
        if (!Number.isFinite(Number(value))) return '—';
        return `${(Number(value) * 100).toFixed(digits)}%`;
    }

    function signed(value, digits = 3) {
        if (!Number.isFinite(Number(value))) return '—';
        const number = Number(value);
        return `${number > 0 ? '+' : ''}${number.toFixed(digits)}`;
    }

    function words(value) {
        return String(value || '')
            .replaceAll('_', ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .toLowerCase();
    }

    function flattenMetricEntries(value, prefix = '', depth = 0) {
        if (!value || typeof value !== 'object' || depth > 2) return [];
        const rows = [];
        for (const [key, item] of Object.entries(value)) {
            const label = prefix ? `${prefix} · ${words(key)}` : words(key);
            if (item != null && ['string', 'number', 'boolean'].includes(typeof item)) {
                rows.push([label, item]);
            } else if (item && typeof item === 'object' && !Array.isArray(item)) {
                rows.push(...flattenMetricEntries(item, label, depth + 1));
            }
        }
        return rows;
    }

    function shortHash(value) {
        return value ? String(value).slice(0, 10) : '—';
    }

    function chip(label, tone = 'muted') {
        return `<span class="pla-chip is-${esc(tone)}">${esc(label)}</span>`;
    }

    function statusChip(status) {
        const meta = STATUS[status] || [words(status), 'muted'];
        return chip(meta[0], meta[1]);
    }

    function testChip(status) {
        const meta = TEST_STATUS[status] || [words(status), 'muted'];
        return chip(meta[0], meta[1]);
    }

    function cellChip(status) {
        const meta = CELL_STATUS[status] || [words(status), 'muted'];
        return `<span class="pla-cell-dot is-${meta[1]}" title="${esc(meta[0])}"></span>`;
    }

    function setUrl() {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('principles_view', state.view);
            if (state.view === 'atlas') {
                url.searchParams.set('principles_map', state.mapId);
                url.searchParams.set('principles_projection', state.projection);
                url.searchParams.set('principles_k', String(state.clusterCount));
                url.searchParams.set('principles_color', state.colorBy);
            } else {
                url.searchParams.delete('principles_map');
                url.searchParams.delete('principles_projection');
                url.searchParams.delete('principles_k');
                url.searchParams.delete('principles_color');
            }
            window.history.replaceState({}, '', url);
        } catch (_error) {
            // Embedded harnesses can expose an immutable location.
        }
    }

    function readUrl() {
        try {
            const params = new URL(window.location.href).searchParams;
            const view = params.get('principles_view');
            if (VIEWS.some(([id]) => id === view)) state.view = view;
            state.mapId = params.get('principles_map') || state.mapId;
            state.projection = params.get('principles_projection') || state.projection;
            state.clusterCount = Number(params.get('principles_k')) || state.clusterCount;
            state.colorBy = params.get('principles_color') || state.colorBy;
        } catch (_error) {
            // Defaults remain valid.
        }
    }

    function selectedInvariant() {
        return state.data?.invariants.find(row => row.id === state.invariantId)
            || state.data?.invariants[0]
            || null;
    }

    function selectedMap() {
        return state.data?.clusterAtlas.maps.find(row => row.id === state.mapId)
            || state.data?.clusterAtlas.maps[0]
            || null;
    }

    function selectedModel() {
        return state.data?.models.find(row => row.id === state.modelId)
            || state.data?.models[0]
            || null;
    }

    function selectedSurface() {
        return state.data?.surfaces.find(row => row.id === state.surfaceId)
            || state.data?.surfaces[0]
            || null;
    }

    function preserveScroll(callback) {
        const scroller = state.root?.closest('.jarvis-content');
        const top = scroller?.scrollTop || 0;
        callback();
        if (scroller) requestAnimationFrame(() => { scroller.scrollTop = top; });
    }

    async function load() {
        if (state.loading || state.data) return;
        state.loading = true;
        render();
        try {
            const response = await fetch(ARTIFACT_URL, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`artifact request failed (${response.status})`);
            const data = await response.json();
            if (data.schema !== 'business-world-principles-atlas-v2') {
                throw new Error('unexpected Principles Atlas artifact');
            }
            state.data = data;
            state.invariantId = data.invariants[0]?.id || null;
            state.modelId = data.models[0]?.id || null;
            state.surfaceId = data.surfaces[0]?.id || null;
            if (!data.clusterAtlas.maps.some(row => row.id === state.mapId)) {
                state.mapId = data.clusterAtlas.maps[0]?.id || '';
            }
        } catch (error) {
            state.error = error?.message || String(error);
        } finally {
            state.loading = false;
            render();
        }
    }

    function mount(root) {
        state.root = root;
        readUrl();
        render();
        load();
    }

    function render() {
        if (!state.root) return;
        if (state.loading && !state.data) {
            state.root.innerHTML = `
                <div class="principles-atlas pla-loading">
                    <span class="pla-loader" aria-hidden="true"></span>
                    <div><b>Assembling the whole-system atlas</b><span>Loading six maps, every quantitative surface, and the falsification ledger.</span></div>
                </div>`;
            return;
        }
        if (state.error) {
            state.root.innerHTML = `
                <div class="principles-atlas">
                    <div class="pla-error">
                        <b>Principles Atlas unavailable</b>
                        <span>${esc(state.error)}</span>
                        <button type="button" data-action="retry">Retry</button>
                    </div>
                </div>`;
            bind();
            return;
        }
        if (!state.data) return;

        const data = state.data;
        state.root.innerHTML = `
            <div class="principles-atlas">
                <header class="pla-header">
                    <div>
                        <span class="pla-kicker">BusinessWorld / complete evidence system</span>
                        <h2>${esc(data.title)}</h2>
                        <p>${esc(data.mission)}</p>
                    </div>
                    <div class="pla-snapshot">
                        <span>Snapshot</span>
                        <b>${esc(new Date(data.generatedAt).toLocaleDateString())}</b>
                        <code>${esc(shortHash(data.artifactHash))}</code>
                    </div>
                </header>
                <nav class="pla-tabs" aria-label="Principles Atlas views">
                    ${VIEWS.map(([id, label]) => `
                        <button type="button" class="${state.view === id ? 'active' : ''}" data-view="${id}">${esc(label)}</button>
                    `).join('')}
                </nav>
                <main class="pla-main">${renderView()}</main>
            </div>`;
        bind();
        if (state.view === 'atlas') requestAnimationFrame(setupAtlasCanvas);
    }

    function renderView() {
        if (state.view === 'system') return renderSystem();
        if (state.view === 'atlas') return renderAtlas();
        if (state.view === 'models') return renderModels();
        if (state.view === 'evidence') return renderEvidence();
        if (state.view === 'method') return renderMethod();
        return renderDiscoveries();
    }

    function stat(label, value, detail, tone = '') {
        return `
            <div class="pla-stat ${tone ? `is-${tone}` : ''}">
                <span>${esc(label)}</span>
                <b>${esc(value)}</b>
                <small>${esc(detail)}</small>
            </div>`;
    }

    function renderDiscoveries() {
        const data = state.data;
        const invariant = selectedInvariant();
        return `
            <section class="pla-verdict">
                <div>
                    <span class="pla-section-label">Whole-system verdict</span>
                    <h3>${esc(data.verdict.headline)}</h3>
                    <p>${esc(data.verdict.summary)}</p>
                </div>
                <div class="pla-verdict-counts">
                    ${stat('Surviving findings', data.verdict.promoted, 'Across independent transformations', 'green')}
                    ${stat('Mixed / provisional', data.verdict.mixed, 'Useful structure, incomplete outcome proof', 'amber')}
                    ${stat('Universal principles', data.verdict.universal, 'No universal claim is justified', 'red')}
                </div>
            </section>

            <section class="pla-section">
                <div class="pla-section-head">
                    <div>
                        <span class="pla-section-label">Breakthrough ledger</span>
                        <h3>What survives when every subsystem is forced to disagree</h3>
                    </div>
                    <span>${data.invariants.length} claims</span>
                </div>
                <div class="pla-discovery-layout">
                    <div class="pla-invariant-list">
                        ${data.invariants.map((row, index) => `
                            <button type="button" class="pla-invariant-row ${row.id === invariant.id ? 'active' : ''}" data-invariant="${esc(row.id)}">
                                <span class="pla-index">${String(index + 1).padStart(2, '0')}</span>
                                <span>
                                    <b>${esc(row.title)}</b>
                                    <small>${esc(row.headline)}</small>
                                </span>
                                <span class="pla-row-meta">${statusChip(row.status)}<em>${esc(words(row.level))}</em></span>
                            </button>
                        `).join('')}
                    </div>
                    ${renderInvariantInspector(invariant)}
                </div>
            </section>

            ${renderTransformationMatrix()}

            ${renderCurrentArchitecture()}

            <section class="pla-section">
                <div class="pla-section-head">
                    <div>
                        <span class="pla-section-label">Failure lab</span>
                        <h3>Attractive shortcuts the complete data rejects</h3>
                    </div>
                    <span>${data.failureLab.length} failed claims</span>
                </div>
                <div class="pla-failure-grid">
                    ${data.failureLab.map(row => `
                        <button type="button" class="pla-failure" data-surface="${esc(row.systems[0] || '')}">
                            <span>${statusChip(row.status)}</span>
                            <b>${esc(row.title)}</b>
                            <p>${esc(row.reason)}</p>
                            <small>${row.systems.map(words).join(' · ')}</small>
                        </button>
                    `).join('')}
                </div>
            </section>`;
    }

    function renderCurrentArchitecture() {
        const market = state.data.corpus.promise.marketHold;
        const factorization = state.data.invariants.find(row => row.id === 'views_factorization');
        const factors = [
            ['Opportunity', 'Source, format, publication time, audience scale, and distribution eligibility.', 'Observed source/time history', 'amber'],
            ['Packaging conversion', 'Whether the first exposed viewer chooses to watch.', 'Visual + text projections; observed keep where available', 'cyan'],
            ['Attention survival', 'How the opening and execution preserve viewers after entry.', 'Timed components, retention curve, duration', 'green'],
            ['Distribution amplification', 'How the platform expands a successful exposure event.', 'Impressions and age histories are still missing', 'red'],
        ];
        return `
            <section class="pla-section pla-architecture">
                <div class="pla-section-head">
                    <div>
                        <span class="pla-section-label">Revised predictive architecture</span>
                        <h3>One “virality score” is four interacting processes</h3>
                    </div>
                    ${statusChip(factorization?.status || 'synthesis_hypothesis')}
                </div>
                <p class="pla-equation">${esc(factorization?.claim || '')}</p>
                <div class="pla-factor-flow">
                    ${factors.map(([title, description, evidence, tone], index) => `
                        <article class="is-${tone}">
                            <span>${String(index + 1).padStart(2, '0')}</span>
                            <b>${esc(title)}</b>
                            <p>${esc(description)}</p>
                            <small>${esc(evidence)}</small>
                        </article>
                    `).join('')}
                </div>
                <div class="pla-transfer-proof">
                    <div>
                        <span class="pla-section-label">Strongest positive portable signal</span>
                        <b>Frozen external text semantics transfer into owned retention</b>
                        <p>The axis was fit on ${fmt(market.externalRows, 0)} non-owned Shorts across ${fmt(market.externalGroups, 0)} source/copy groups, then applied unchanged to all 208 owned openings.</p>
                    </div>
                    <dl>
                        <div><dt>Average retention rank ρ</dt><dd>${signed(market.transfer.averageRetention?.spearman, 3)}</dd></div>
                        <div><dt>Viewed percent rank ρ</dt><dd>${signed(market.transfer.viewedPercent?.spearman, 3)}</dd></div>
                        <div><dt>5-second retention rank ρ</dt><dd>${signed(market.transfer.retention5s?.spearman, 3)}</dd></div>
                        <div><dt>Log views rank ρ</dt><dd>${signed(market.transfer.logViews?.spearman, 3)}</dd></div>
                    </dl>
                </div>
                <p class="pla-boundary">${esc(factorization?.boundary || '')}</p>
            </section>`;
    }

    function renderInvariantInspector(row) {
        if (!row) return '';
        const matrix = state.data.transformationMatrix.find(item => item.invariantId === row.id);
        const selectedCell = state.transformationId
            ? matrix?.cells?.[state.transformationId]
            : null;
        const selectedTests = selectedCell?.testIds?.length
            ? row.tests.filter(testRow => selectedCell.testIds.includes(testRow.id))
            : row.tests;
        return `
            <article class="pla-inspector">
                <div class="pla-inspector-head">
                    <div>${statusChip(row.status)} ${chip(words(row.level), 'outline')}</div>
                    <h3>${esc(row.title)}</h3>
                    <p>${esc(row.claim)}</p>
                </div>
                <dl class="pla-definition-grid">
                    <div><dt>Scope</dt><dd>${esc(row.scope)}</dd></div>
                    <div><dt>Operational consequence</dt><dd>${esc(row.implication)}</dd></div>
                    <div><dt>Next falsifier</dt><dd>${esc(row.nextFalsifier)}</dd></div>
                    <div><dt>Claim boundary</dt><dd>${esc(row.boundary)}</dd></div>
                </dl>
                ${row.confounds?.length ? `
                    <div class="pla-note-list">
                        <b>Remaining confounds</b>
                        ${row.confounds.map(item => `<span>${esc(item)}</span>`).join('')}
                    </div>` : ''}
                <div class="pla-test-head">
                    <b>${state.transformationId ? `${words(state.transformationId)} evidence` : 'Exact tests'}</b>
                    <span>${selectedTests.length} shown</span>
                </div>
                <div class="pla-test-list">
                    ${selectedTests.length ? selectedTests.map(testRow => `
                        <div class="pla-test">
                            <div>${testChip(testRow.status)}<code>${esc(testRow.id)}</code></div>
                            <p>${esc(testRow.detail)}</p>
                            ${testRow.value != null ? `<pre>${esc(JSON.stringify(testRow.value, null, 2))}</pre>` : ''}
                            <small>${(testRow.sourceIds || []).map(source => esc(source.replace(/^local:|^r2:/, ''))).join(' · ') || 'No independent source yet'}</small>
                        </div>
                    `).join('') : '<div class="pla-empty">No direct test is attached to this transformation yet.</div>'}
                </div>
            </article>`;
    }

    function renderTransformationMatrix() {
        const data = state.data;
        return `
            <section class="pla-section">
                <div class="pla-section-head">
                    <div>
                        <span class="pla-section-label">Invariant survival</span>
                        <h3>The weakest transformation sets the ceiling</h3>
                    </div>
                    <div class="pla-cell-legend">
                        ${Object.entries(CELL_STATUS).map(([id, [label]]) => `${cellChip(id)}<span>${esc(label)}</span>`).join('')}
                    </div>
                </div>
                <div class="pla-table-scroll">
                    <table class="pla-matrix">
                        <thead><tr><th>Claim</th>${data.transformations.map(row => `<th title="${esc(row.family)}">${esc(row.label)}</th>`).join('')}</tr></thead>
                        <tbody>
                            ${data.transformationMatrix.map(matrixRow => {
                                const row = data.invariants.find(item => item.id === matrixRow.invariantId);
                                return `
                                    <tr>
                                        <th><button type="button" data-invariant="${esc(row.id)}">${esc(row.title)}</button></th>
                                        ${data.transformations.map(transformation => {
                                            const cell = matrixRow.cells[transformation.id];
                                            return `<td><button type="button" class="${state.invariantId === row.id && state.transformationId === transformation.id ? 'active' : ''}" data-matrix="${esc(row.id)}" data-transformation="${esc(transformation.id)}" title="${esc(`${row.title}: ${CELL_STATUS[cell.status]?.[0] || cell.status}`)}">${cellChip(cell.status)}</button></td>`;
                                        }).join('')}
                                    </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </section>`;
    }

    function renderSystem() {
        const data = state.data;
        const shorts = data.corpus.databases.find(row => row.format === 'shorts');
        const long = data.corpus.databases.find(row => row.format === 'long');
        const selected = selectedSurface();
        const filters = ['all', 'ingested', 'partial', 'hypothesis', 'candidate'];
        const visible = data.surfaces.filter(row => (
            state.surfaceFilter === 'all'
            || row.status.includes(state.surfaceFilter)
        ));
        return `
            <section class="pla-stat-grid">
                ${stat('Shorts observations', compact(shorts.records), `${compact(shorts.channels)} source labels`)}
                ${stat('Long observations', compact(long.records), `${compact(long.channels)} source labels`)}
                ${stat('Private retention', compact(data.corpus.privateKeep.videos), `${data.corpus.privateKeep.accounts.length} accounts`)}
                ${stat('Cluster partitions', data.clusterAtlas.partitionCount, '6 modality/format maps')}
                ${stat('Opening spans', compact(data.corpus.promise.allContiguousSpans), `${data.corpus.promise.hooks} owned openings`)}
                ${stat('20-second lattice', compact(data.corpus.promise.opening20s.spans), `${compact(data.corpus.promise.opening20s.edges)} typed edges`)}
                ${stat('Legacy search rows', compact(data.corpus.legacy.derivedExperimentRows), 'Hypothesis generation only')}
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div>
                        <span class="pla-section-label">Observation graph</span>
                        <h3>From raw reality to claims</h3>
                    </div>
                    <span>${data.systemGraph.nodes.length} nodes · ${data.systemGraph.edges.length} typed edges</span>
                </div>
                <div class="pla-graph-wrap">${renderSystemGraph()}</div>
                <p class="pla-boundary">${esc(data.systemGraph.boundary)}</p>
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div>
                        <span class="pla-section-label">Surface inventory</span>
                        <h3>Every Jarvis area has an explicit evidentiary role</h3>
                    </div>
                    <div class="pla-segmented">
                        ${filters.map(id => `<button type="button" class="${state.surfaceFilter === id ? 'active' : ''}" data-surface-filter="${id}">${esc(id)}</button>`).join('')}
                    </div>
                </div>
                <div class="pla-surface-layout">
                    <div class="pla-surface-list">
                        ${visible.map(row => `
                            <button type="button" class="pla-surface-row ${selected?.id === row.id ? 'active' : ''}" data-surface="${esc(row.id)}">
                                <span><b>${esc(row.area)}</b><small>${esc(row.section)}</small></span>
                                <span>${chip(words(row.status), row.status.includes('ingested') ? 'green' : row.status.includes('partial') ? 'amber' : 'muted')}<em>${row.observations == null ? '—' : compact(row.observations)}</em></span>
                            </button>
                        `).join('')}
                    </div>
                    ${selected ? `
                        <article class="pla-surface-inspector">
                            <span class="pla-section-label">${esc(selected.area)}</span>
                            <h3>${esc(selected.section)}</h3>
                            <p>${esc(selected.summary)}</p>
                            <div class="pla-kind-row">
                                ${(selected.evidenceKinds || []).map(id => {
                                    const kind = data.evidenceKinds.find(row => row.id === id);
                                    return kind ? `<span style="--kind:${esc(kind.color)}">${esc(kind.label)}</span>` : '';
                                }).join('') || '<span>No quantitative evidence exported</span>'}
                            </div>
                            <dl class="pla-definition-grid">
                                <div><dt>Rows</dt><dd>${selected.observations == null ? 'Not a row-level evidence store' : fmt(selected.observations, 0)}</dd></div>
                                <div><dt>Accounts / sources</dt><dd>${selected.accounts == null ? 'Not persisted here' : fmt(selected.accounts, 0)}</dd></div>
                                <div><dt>Status</dt><dd>${esc(words(selected.status))}</dd></div>
                                <div><dt>Canonical artifacts</dt><dd>${selected.sourceIds.length ? selected.sourceIds.map(id => esc(id.replace(/^local:|^r2:/, ''))).join('<br>') : 'No canonical statistical export'}</dd></div>
                            </dl>
                        </article>` : ''}
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head"><div><span class="pla-section-label">Evidence classes</span><h3>What may confirm what</h3></div></div>
                <div class="pla-evidence-kinds">
                    ${data.evidenceKinds.map(row => `
                        <div style="--kind:${esc(row.color)}"><b>${esc(row.label)}</b><p>${esc(row.definition)}</p></div>
                    `).join('')}
                </div>
            </section>`;
    }

    function renderSystemGraph() {
        const graph = state.data.systemGraph;
        const width = 1180;
        const height = 520;
        const groups = new Map();
        graph.nodes.forEach(node => {
            if (!groups.has(node.layer)) groups.set(node.layer, []);
            groups.get(node.layer).push(node);
        });
        const positions = {};
        [...groups.entries()].forEach(([layer, nodes]) => {
            const x = 72 + (layer * 172);
            nodes.forEach((node, index) => {
                const gap = height / (nodes.length + 1);
                positions[node.id] = { x, y: gap * (index + 1) };
            });
        });
        return `
            <svg class="pla-system-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Whole-system observation and inference graph">
                <defs><marker id="pla-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"></path></marker></defs>
                ${graph.edges.map(edge => {
                    const from = positions[edge.from];
                    const to = positions[edge.to];
                    if (!from || !to) return '';
                    const x1 = from.x + 61;
                    const x2 = to.x - 61;
                    const midpoint = (x1 + x2) / 2;
                    return `<path class="pla-graph-edge" d="M${x1},${from.y} C${midpoint},${from.y} ${midpoint},${to.y} ${x2},${to.y}" marker-end="url(#pla-arrow)"><title>${esc(edge.type)}</title></path>`;
                }).join('')}
                ${graph.nodes.map(node => {
                    const point = positions[node.id];
                    const active = state.graphNodeId === node.id ? 'active' : '';
                    return `
                        <g class="pla-graph-node is-${esc(node.kind)} ${active}" data-graph-node="${esc(node.id)}" tabindex="0" role="button">
                            <rect x="${point.x - 61}" y="${point.y - 25}" width="122" height="50" rx="5"></rect>
                            <text x="${point.x}" y="${point.y + 4}" text-anchor="middle">${esc(node.label)}</text>
                            <title>${esc(`${node.label} · ${node.kind}`)}</title>
                        </g>`;
                }).join('')}
            </svg>`;
    }

    function renderAtlas() {
        const data = state.data;
        const map = selectedMap();
        if (!map) return '<div class="pla-empty">No cluster maps are available.</div>';
        const projectionNames = Object.keys(map.projections);
        if (!projectionNames.includes(state.projection)) state.projection = projectionNames[0] || 'pca';
        const partition = map.partitions.find(row => row.clusterCount === state.clusterCount)
            || map.partitions[0];
        if (partition.clusterCount !== state.clusterCount) state.clusterCount = partition.clusterCount;
        const point = map.atlasSample.find(row => row.id === state.pointId) || null;
        const formatEdges = data.clusterAtlas.modalityEdges.filter(row => row.format === map.format);
        const transport = map.resolutionEdges.find(row => `${row.from}:${row.to}` === state.transportKey)
            || map.resolutionEdges[0]
            || null;
        return `
            <section class="pla-atlas-toolbar">
                <label>Map<select data-atlas-map>${data.clusterAtlas.maps.map(row => `<option value="${esc(row.id)}" ${row.id === map.id ? 'selected' : ''}>${esc(words(row.id))} · ${compact(row.mapRows)}</option>`).join('')}</select></label>
                <label>Plane<select data-atlas-projection>${projectionNames.map(name => `<option value="${esc(name)}" ${name === state.projection ? 'selected' : ''}>${esc(words(name))}${map.projections[name].supervised ? ' · supervised' : ''}</option>`).join('')}</select></label>
                <label>Resolution<select data-atlas-k>${map.partitions.map(row => `<option value="${row.clusterCount}" ${row.clusterCount === partition.clusterCount ? 'selected' : ''}>k = ${row.clusterCount}</option>`).join('')}</select></label>
                <label>Color<select data-atlas-color>
                    ${[['cluster', 'Cluster'], ['views', 'Log views'], ['outlier', 'Outlier'], ['owned', 'Owned'], ['silent', 'Speech availability']].map(([id, label]) => `<option value="${id}" ${id === state.colorBy ? 'selected' : ''}>${label}</option>`).join('')}
                </select></label>
            </section>
            <section class="pla-section pla-atlas-section">
                <div class="pla-section-head">
                    <div>
                        <span class="pla-section-label">${esc(map.format)} / ${esc(map.modality)} / ${esc(state.projection)}</span>
                        <h3>${compact(map.mapRows)} observations · ${map.atlasSample.length.toLocaleString()} deterministic overview points</h3>
                    </div>
                    <div>${chip(map.stale ? 'map stale' : 'map current', map.stale ? 'red' : 'green')} ${chip(map.projections[state.projection].supervised ? 'outcome-directed plane' : 'outcome-blind plane', map.projections[state.projection].supervised ? 'amber' : 'cyan')}</div>
                </div>
                <div class="pla-atlas-layout">
                    <div class="pla-canvas-shell">
                        <canvas id="pla-atlas-canvas" aria-label="${esc(`${map.id} ${state.projection} embedding sample`)}"></canvas>
                        <div class="pla-canvas-tooltip" id="pla-canvas-tooltip" hidden></div>
                        <div class="pla-canvas-legend">${renderAtlasLegend(partition)}</div>
                    </div>
                    <aside class="pla-point-inspector">
                        ${point ? renderPoint(map, point) : `
                            <span class="pla-section-label">Observation inspector</span>
                            <h3>Select a point</h3>
                            <p>Every plotted point carries its video ID, source, actual views, modality availability, coordinates, and membership at all four resolutions.</p>
                            <dl class="pla-definition-grid">
                                <div><dt>Sampling</dt><dd>${esc(map.atlasSampling.method)}</dd></div>
                                <div><dt>Full map</dt><dd>${compact(map.mapRows)} rows at ${esc(map.endpoint)}</dd></div>
                                <div><dt>Heldout AUC 10M</dt><dd>${fmt(map.heldout.auc10m, 3)}</dd></div>
                                <div><dt>Heldout r views</dt><dd>${fmt(map.heldout.viewsCorrelation, 3)}</dd></div>
                            </dl>`}
                    </aside>
                </div>
                <p class="pla-boundary">${esc(data.clusterAtlas.mappingRule)}</p>
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div><span class="pla-section-label">Pooled fit versus portable lift</span><h3>Cluster outcome separation by resolution</h3></div>
                    <span>Eta² and creator-fold R²</span>
                </div>
                ${renderPartitionChart(map)}
                <div class="pla-table-scroll">
                    <table class="pla-data-table">
                        <thead><tr><th>k</th><th>Global views η²</th><th>Within-source η²</th><th>Unseen-creator R²</th><th>Maximum 10M lift</th><th>Rows</th></tr></thead>
                        <tbody>${map.partitions.map(row => `
                            <tr class="${row.clusterCount === partition.clusterCount ? 'active' : ''}">
                                <td>${row.clusterCount}</td>
                                <td>${pct(row.global.viewsEtaSquared)}</td>
                                <td>${pct(row.sourceTransfer.sourceCenteredClusterEtaSquared, 2)}</td>
                                <td>${signed(row.sourceTransfer.creatorFoldR2, 4)}</td>
                                <td>${fmt(row.global.maximumLift10m)}×</td>
                                <td>${compact(row.observations)}</td>
                            </tr>`).join('')}</tbody>
                    </table>
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div><span class="pla-section-label">Cluster membership</span><h3>What each cluster contains at k=${partition.clusterCount}</h3></div>
                    <span>${partition.global.clusters.length} clusters</span>
                </div>
                <div class="pla-cluster-strip">
                    ${partition.global.clusters.map(row => `
                        <div style="--cluster:${CLUSTER_COLORS[row.cluster % CLUSTER_COLORS.length]}">
                            <span>Cluster ${row.cluster}</span>
                            <b>${compact(row.n)}</b>
                            <small>${fmt(10 ** row.meanLogViews, 0)} mean views · ${pct(row.hitRate10m)} hit 10M · ${fmt(row.lift10m)}× lift</small>
                        </div>
                    `).join('')}
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div><span class="pla-section-label">Resolution lineage</span><h3>Splits and merges across k</h3></div>
                    <span>Shared-observation transport</span>
                </div>
                <div class="pla-transport-layout">
                    <div class="pla-transport-list">
                        ${map.resolutionEdges.map(row => `
                            <button type="button" class="${transport && row.from === transport.from && row.to === transport.to ? 'active' : ''}" data-transport="${row.from}:${row.to}">
                                <span>k${row.from} → k${row.to}</span><b>NMI ${fmt(row.nmi, 3)}</b><small>VI ${fmt(row.variationOfInformationBits, 3)} bits</small>
                            </button>
                        `).join('')}
                    </div>
                    ${transport ? `
                        <div class="pla-link-table">
                            <div><b>Top overlap paths</b><span>${transport.observations.toLocaleString()} shared observations</span></div>
                            <div class="pla-table-scroll"><table class="pla-data-table">
                                <thead><tr><th>From</th><th>To</th><th>Overlap</th><th>From share</th><th>To share</th><th>Jaccard</th></tr></thead>
                                <tbody>${transport.links.slice(0, 36).map(link => `<tr><td>C${link.from}</td><td>C${link.to}</td><td>${compact(link.overlap)}</td><td>${pct(link.fromShare)}</td><td>${pct(link.toShare)}</td><td>${fmt(link.jaccard, 3)}</td></tr>`).join('')}</tbody>
                            </table></div>
                        </div>` : ''}
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head"><div><span class="pla-section-label">Cross-modality mapping</span><h3>The same observations partition differently</h3></div></div>
                <div class="pla-modality-grid">
                    ${formatEdges.map(edge => `
                        <div>
                            <b>${esc(edge.left)} ↔ ${esc(edge.right)}</b>
                            <span>${compact(edge.commonObservations)} paired rows</span>
                            ${edge.byResolution.map(row => `<p><em>k${row.clusterCount}</em><span style="--nmi:${Math.max(0, Math.min(1, row.nmi))}"></span><strong>${fmt(row.nmi, 3)}</strong></p>`).join('')}
                            ${edge.silent ? `<small>silent mean NMI ${fmt(edge.silent.byResolution.reduce((sum, row) => sum + row.nmi, 0) / edge.silent.byResolution.length, 3)} · voiced ${fmt(edge.voiced.byResolution.reduce((sum, row) => sum + row.nmi, 0) / edge.voiced.byResolution.length, 3)}</small>` : ''}
                        </div>
                    `).join('')}
                </div>
            </section>`;
    }

    function renderAtlasLegend(partition) {
        if (state.colorBy === 'cluster') {
            return partition.global.clusters.map(row => `<span><i style="--color:${CLUSTER_COLORS[row.cluster % CLUSTER_COLORS.length]}"></i>C${row.cluster}</span>`).join('');
        }
        if (state.colorBy === 'owned') return '<span><i style="--color:#57d6a2"></i>Owned</span><span><i style="--color:#596779"></i>Public corpus</span>';
        if (state.colorBy === 'silent') return '<span><i style="--color:#f4bf59"></i>No speech</span><span><i style="--color:#5fc9ff"></i>Speech present</span>';
        return '<span><i class="pla-ramp"></i>low → high</span>';
    }

    function renderPoint(map, point) {
        const href = map.format === 'shorts'
            ? `https://www.youtube.com/shorts/${encodeURIComponent(point.id)}`
            : `https://www.youtube.com/watch?v=${encodeURIComponent(point.id)}`;
        return `
            <span class="pla-section-label">${esc(point.source)}</span>
            <h3>${esc(point.title || point.id)}</h3>
            ${point.transcript ? `<p class="pla-transcript">${esc(point.transcript)}</p>` : '<p class="pla-transcript is-empty">No transcript stored in this modality row.</p>'}
            <div class="pla-point-metrics">
                <span><b>${compact(point.views)}</b>views</span>
                <span><b>${fmt(point.outlier, 2)}×</b>outlier</span>
                <span><b>${compact(point.subscribers)}</b>subscribers</span>
                <span><b>${point.silent ? 'no' : 'yes'}</b>speech</span>
            </div>
            <div class="pla-memberships">
                ${Object.entries(point.clusters).map(([k, cluster]) => `<span style="--cluster:${CLUSTER_COLORS[Number(cluster) % CLUSTER_COLORS.length]}"><b>k${k}</b>C${cluster}</span>`).join('')}
            </div>
            <dl class="pla-definition-grid">
                <div><dt>Video ID</dt><dd><code>${esc(point.id)}</code></dd></div>
                <div><dt>Owned</dt><dd>${point.owned ? 'Yes' : 'No'}</dd></div>
                <div><dt>${esc(state.projection)} x</dt><dd>${fmt(point.projections[state.projection]?.x, 3)}</dd></div>
                <div><dt>${esc(state.projection)} y</dt><dd>${fmt(point.projections[state.projection]?.y, 3)}</dd></div>
            </dl>
            <a class="pla-link" href="${href}" target="_blank" rel="noopener">Open source video</a>`;
    }

    function renderPartitionChart(map) {
        const width = 920;
        const height = 230;
        const rows = map.partitions;
        const max = Math.max(...rows.flatMap(row => [
            row.global.viewsEtaSquared,
            row.sourceTransfer.sourceCenteredClusterEtaSquared,
            Math.max(0, row.sourceTransfer.creatorFoldR2),
        ]), 0.001);
        const chartTop = 24;
        const chartBottom = 186;
        const chartHeight = chartBottom - chartTop;
        const groupWidth = 180;
        const startX = 88;
        const barWidth = 28;
        return `
            <div class="pla-chart-scroll"><svg class="pla-partition-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Pooled and creator-relative cluster performance by resolution">
                ${[0, .25, .5, .75, 1].map(part => {
                    const y = chartBottom - (part * chartHeight);
                    return `<line x1="68" x2="${width - 30}" y1="${y}" y2="${y}"></line><text x="58" y="${y + 4}" text-anchor="end">${pct(max * part, 1)}</text>`;
                }).join('')}
                ${rows.map((row, index) => {
                    const center = startX + (index * groupWidth);
                    const series = [
                        ['global', row.global.viewsEtaSquared, '#58c9ff'],
                        ['centered', row.sourceTransfer.sourceCenteredClusterEtaSquared, '#60d59d'],
                        ['creator', Math.max(0, row.sourceTransfer.creatorFoldR2), '#f2bd57'],
                    ];
                    return `${series.map(([label, value, color], seriesIndex) => {
                        const barHeight = (value / max) * chartHeight;
                        const x = center + ((seriesIndex - 1) * (barWidth + 5));
                        return `<rect x="${x}" y="${chartBottom - barHeight}" width="${barWidth}" height="${Math.max(1, barHeight)}" fill="${color}"><title>${label}: ${fmt(value, 5)}</title></rect>`;
                    }).join('')}<text x="${center + 14}" y="211" text-anchor="middle">k${row.clusterCount}</text>`;
                }).join('')}
                <g class="pla-chart-legend">
                    <rect x="470" y="5" width="10" height="10" fill="#58c9ff"></rect><text x="485" y="14">pooled η²</text>
                    <rect x="575" y="5" width="10" height="10" fill="#60d59d"></rect><text x="590" y="14">within-source η²</text>
                    <rect x="720" y="5" width="10" height="10" fill="#f2bd57"></rect><text x="735" y="14">creator-fold R²</text>
                </g>
            </svg></div>`;
    }

    function renderModels() {
        const data = state.data;
        const model = selectedModel();
        const market = data.corpus.promise.marketHold;
        return `
            <section class="pla-stat-grid">
                ${stat('Audited models', data.models.length, 'Raw, Predictor, Promise, Operations, Retention')}
                ${stat('Private accounts', data.corpus.privateKeep.accounts.length, `${data.corpus.privateKeep.videos} keep labels`)}
                ${stat('Saved channels', data.corpus.savedChannels.channels, `${data.corpus.savedChannels.videos} view rows`)}
                ${stat('Best external retention ρ', signed(market.transfer.averageRetention?.spearman, 3), 'Frozen axis → 208 owned hooks', 'green')}
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div><span class="pla-section-label">Validation ladder</span><h3>Performance contracts as the test gets harder</h3></div>
                    <span>R² · rank · error · calibration</span>
                </div>
                <div class="pla-model-layout">
                    <div class="pla-model-list">
                        ${data.models.map(row => `
                            <button type="button" class="${row.id === model.id ? 'active' : ''}" data-model="${esc(row.id)}">
                                <span><b>${esc(row.target)}</b><small>${esc(row.role)}</small></span>
                                ${chip(words(row.status), /failed|not prospectively|not_portable/.test(row.status) ? 'red' : /supported|local|observational/.test(row.status) ? 'green' : 'amber')}
                            </button>
                        `).join('')}
                    </div>
                    ${renderModelInspector(model)}
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head"><div><span class="pla-section-label">Deployment gap</span><h3>Random folds are the beginning, not the result</h3></div></div>
                ${renderModelComparisonChart()}
            </section>`;
    }

    function renderModelInspector(model) {
        const sections = [
            ['Development / pooled', model.development],
            ['Content only', model.contentOnly],
            ['Within source', model.withinSource],
            ['Forward time', model.forwardTime],
            ['Unseen source', model.unseenSource],
            ['Fixed 20 seconds', model.fixed20Second],
            ['Validation', model.validation],
        ].filter(([, value]) => value && typeof value === 'object');
        return `
            <article class="pla-model-inspector">
                <span class="pla-section-label">${esc(model.role)}</span>
                <h3>${esc(model.target)}</h3>
                <p>${esc(model.boundary || '')}</p>
                <div class="pla-metric-sections">
                    ${sections.map(([label, metrics]) => `
                        <div>
                            <b>${esc(label)}</b>
                            <dl>${flattenMetricEntries(metrics).slice(0, 24).map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${typeof value === 'number' ? fmt(value, 4) : esc(value)}</dd></div>`).join('')}</dl>
                        </div>
                    `).join('')}
                </div>
                ${model.modalities ? `
                    <div class="pla-modality-metrics">
                        ${Object.entries(model.modalities).map(([name, metrics]) => `<span><b>${esc(name)}</b><em>R² ${signed(metrics.r2, 3)}</em><small>ρ ${signed(metrics.spearman, 3)} · ${fmt(metrics.medianFactorError, 1)}× median error</small></span>`).join('')}
                    </div>` : ''}
            </article>`;
    }

    function renderModelComparisonChart() {
        const models = state.data.models.filter(row => (
            row.development?.r2 != null
            || row.withinSource?.r2 != null
            || row.forwardTime?.r2 != null
            || row.unseenSource?.r2 != null
        ));
        const series = [
            ['development', '#58c9ff'],
            ['withinSource', '#60d59d'],
            ['forwardTime', '#f2bd57'],
            ['unseenSource', '#ff6f80'],
        ];
        return `
            <div class="pla-r2-grid">
                ${models.map(model => `
                    <div>
                        <b>${esc(model.target)}</b>
                        ${series.map(([key, color]) => {
                            const value = finiteUi(model[key]?.r2);
                            if (value == null) return '';
                            const clamped = Math.max(-1, Math.min(.6, value));
                            const zero = 62.5;
                            const width = Math.abs(clamped) / 1.6 * 100;
                            const left = clamped >= 0 ? zero : zero - width;
                            return `<p><span>${esc(words(key))}</span><i><em style="--left:${left}%;--width:${width}%;--color:${color}"></em></i><strong>${signed(value, 3)}</strong></p>`;
                        }).join('')}
                    </div>
                `).join('')}
            </div>`;
    }

    function finiteUi(value) {
        return Number.isFinite(Number(value)) ? Number(value) : null;
    }

    function renderEvidence() {
        const data = state.data;
        const query = state.evidenceSearch.trim().toLowerCase();
        const provenance = data.provenance.filter(row => !query || JSON.stringify(row).toLowerCase().includes(query));
        const opening = data.corpus.promise.opening20s;
        const market = data.corpus.promise.marketHold;
        return `
            <section class="pla-section">
                <div class="pla-section-head">
                    <div><span class="pla-section-label">Observation coverage</span><h3>What the current claims can actually see</h3></div>
                </div>
                <div class="pla-corpus-bands">
                    ${data.corpus.databases.map(row => `
                        <div>
                            <span>${esc(row.format)}</span>
                            <b>${fmt(row.records, 0)}</b>
                            <p><i style="--coverage:${row.records ? row.stored / row.records : 0}"></i></p>
                            <small>${fmt(row.stored, 0)} stored · ${fmt(row.channels, 0)} source labels · ${fmt(row.withPublishedTime, 0)} dated</small>
                        </div>
                    `).join('')}
                    <div><span>private keep</span><b>${fmt(data.corpus.privateKeep.videos, 0)}</b><p><i style="--coverage:1"></i></p><small>${data.corpus.privateKeep.accounts.map(row => `${esc(row.id)} ${row.n}`).join(' · ')}</small></div>
                    <div><span>promise lattice</span><b>${fmt(data.corpus.promise.allContiguousSpans, 0)}</b><p><i style="--coverage:1"></i></p><small>${data.corpus.promise.hooks} hooks · ${fmt(data.corpus.promise.selectedComponents, 0)} selected components</small></div>
                    <div><span>operations</span><b>${fmt(data.corpus.operations.partitionsTested, 0)}</b><p><i style="--coverage:${data.corpus.operations.acceptedRegions / data.corpus.operations.partitionsTested}"></i></p><small>${data.corpus.operations.savedHooks} hooks · ${data.corpus.operations.acceptedRegions} accepted regions</small></div>
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div><span class="pla-section-label">Opening evidence path</span><h3>The 20-second analysis is measured, timed, and outcome-separated</h3></div>
                    <span>${opening.videos} source videos</span>
                </div>
                <div class="pla-opening-audit">
                    ${stat('Timed tokens', fmt(opening.tokens, 0), 'Aligned to local/public media')}
                    ${stat('Contiguous spans', fmt(opening.spans, 0), 'Every start/end combination')}
                    ${stat('Exact-cover components', fmt(opening.components, 0), 'Variable count, no overlap')}
                    ${stat('Relational edges', compact(opening.edges), 'Containment, sequence, semantic, context')}
                    ${stat('Median timing error', `${fmt(opening.medianTimingErrorSeconds, 3)}s`, 'Independent free-decode audit', 'green')}
                    ${stat('P95 timing error', `${fmt(opening.p95TimingErrorSeconds, 3)}s`, 'Independent free-decode audit')}
                </div>
                <div class="pla-evidence-flow">
                    <span>media</span><i></i><span>word times</span><i></i><span>all spans</span><i></i><span>exact cover</span><i></i><span>4 frozen categories</span><i></i><span>out-of-fold outcome test</span>
                </div>
                <p class="pla-boundary">The structural lattice is outcome-blind. Outcomes enter only inside training folds. Four categories are a fixed current representation, not proof that reality contains exactly four semantic kinds.</p>
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div><span class="pla-section-label">Cross-source transfer</span><h3>The positive result and its exact boundary</h3></div>
                    ${chip('regional invariant', 'green')}
                </div>
                <div class="pla-transfer-table">
                    ${Object.entries(market.transfer).map(([target, metrics]) => `
                        <div>
                            <b>${esc(words(target))}</b>
                            <span>Spearman ${signed(metrics.spearman, 3)}</span>
                            <small>Pearson ${signed(metrics.pearson, 3)} · n=${fmt(metrics.n, 0)}</small>
                        </div>
                    `).join('')}
                </div>
                <p class="pla-boundary">This is a frozen cross-source retention proxy. It is not yet a causal promise-quality score, and its weak log-views transfer is exactly why retention and distribution must remain separate factors.</p>
            </section>
            <section class="pla-section">
                <div class="pla-section-head">
                    <div><span class="pla-section-label">Provenance ledger</span><h3>Every source is hashed</h3></div>
                    <label class="pla-search"><span>Search</span><input type="search" value="${esc(state.evidenceSearch)}" placeholder="artifact, R2 key, hash…" data-evidence-search></label>
                </div>
                <div class="pla-table-scroll">
                    <table class="pla-data-table pla-provenance-table">
                        <thead><tr><th>Location</th><th>Artifact</th><th>Bytes</th><th>SHA-256</th><th>Modified</th></tr></thead>
                        <tbody>${provenance.map(row => `
                            <tr>
                                <td>${chip(row.location, row.location === 'r2' ? 'cyan' : 'outline')}</td>
                                <td><code>${esc(row.key || row.path || row.id)}</code></td>
                                <td>${compact(row.bytes)}</td>
                                <td><code>${esc(shortHash(row.sha256))}</code></td>
                                <td>${row.modifiedAt ? esc(new Date(row.modifiedAt).toLocaleString()) : 'R2 snapshot'}</td>
                            </tr>
                        `).join('')}</tbody>
                    </table>
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head"><div><span class="pla-section-label">Missing identity</span><h3>What must be added before stronger claims</h3></div></div>
                <div class="pla-identity-grid">
                    ${data.clusterAtlas.observationIdentity.required.map((item, index) => `<div><span>${String(index + 1).padStart(2, '0')}</span><b>${esc(words(item))}</b></div>`).join('')}
                </div>
                <p class="pla-boundary">Current identity: ${esc(data.clusterAtlas.observationIdentity.current)}</p>
            </section>`;
    }

    function renderMethod() {
        const data = state.data;
        const contract = data.implementationContract;
        return `
            <section class="pla-method-hero">
                <span class="pla-section-label">Operational definition</span>
                <h3>${esc(data.researchQuestion.question)}</h3>
                <p>${esc(data.researchQuestion.operationalAnswer)}</p>
            </section>
            <section class="pla-section">
                <div class="pla-section-head"><div><span class="pla-section-label">Discovery order</span><h3>Compression earns status through prediction</h3></div></div>
                <div class="pla-pipeline">
                    ${data.researchQuestion.discoveryOrder.map((label, index) => `
                        <div><span>${String(index + 1).padStart(2, '0')}</span><b>${esc(label)}</b></div>
                    `).join('')}
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-method-grid">
                    <article>
                        <span class="pla-section-label">Observation identity</span>
                        <h3>One immutable lineage</h3>
                        ${contract.evidenceIdentity.map(item => `<code>${esc(item)}</code>`).join('')}
                    </article>
                    <article>
                        <span class="pla-section-label">Causal availability</span>
                        <h3>No future information</h3>
                        ${contract.causalAvailability.map(item => `<p>${esc(item)}</p>`).join('')}
                    </article>
                    <article>
                        <span class="pla-section-label">Predictive compression</span>
                        <h3>Pay for the abstraction</h3>
                        <pre>${esc(contract.predictiveCompression)}</pre>
                        <p>Description length includes representation, algorithm, k, parameters, feature selection, and search policy. English label length does not count.</p>
                    </article>
                    <article>
                        <span class="pla-section-label">Promotion</span>
                        <h3>Weakest gate wins</h3>
                        <p>${esc(contract.promotionRule)}</p>
                        ${data.levels.map(row => `<div><b>${esc(row.label)}</b><span>${esc(row.definition)}</span></div>`).join('')}
                    </article>
                </div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head"><div><span class="pla-section-label">Lockboxes</span><h3>Data can be opened once</h3></div></div>
                <div class="pla-lockboxes">${contract.lockboxes.map((item, index) => `<span><b>${index + 1}</b>${esc(item)}</span>`).join('')}</div>
            </section>
            <section class="pla-section">
                <div class="pla-section-head"><div><span class="pla-section-label">Forbidden shortcuts</span><h3>What the program will not call a principle</h3></div></div>
                <div class="pla-nongoals">${data.researchQuestion.nonGoals.map(item => `<p>${esc(item)}</p>`).join('')}</div>
            </section>`;
    }

    function atlasColor(point, partition) {
        if (state.colorBy === 'cluster') {
            const cluster = Number(point.clusters[String(partition.clusterCount)] || 0);
            return CLUSTER_COLORS[cluster % CLUSTER_COLORS.length];
        }
        if (state.colorBy === 'owned') return point.owned ? '#57d6a2' : '#596779';
        if (state.colorBy === 'silent') return point.silent ? '#f4bf59' : '#5fc9ff';
        const value = state.colorBy === 'outlier'
            ? Math.log10(Math.max(0, Number(point.outlier) || 0) + 1)
            : Math.log10(Math.max(0, Number(point.views) || 0) + 1);
        const max = state.colorBy === 'outlier' ? 2 : 9;
        const min = state.colorBy === 'outlier' ? 0 : 3;
        const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
        const hue = 215 - (195 * t);
        return `hsl(${hue} 78% ${48 + (t * 12)}%)`;
    }

    function setupAtlasCanvas() {
        const canvas = state.root?.querySelector('#pla-atlas-canvas');
        const tooltip = state.root?.querySelector('#pla-canvas-tooltip');
        const map = selectedMap();
        if (!canvas || !map || !tooltip) return;
        const partition = map.partitions.find(row => row.clusterCount === state.clusterCount) || map.partitions[0];
        const points = map.atlasSample.filter(point => {
            const projection = point.projections[state.projection];
            return Number.isFinite(Number(projection?.x)) && Number.isFinite(Number(projection?.y));
        });
        const ratio = window.devicePixelRatio || 1;
        const bounds = canvas.getBoundingClientRect();
        const width = Math.max(320, Math.floor(bounds.width));
        const height = Math.max(300, Math.floor(bounds.height));
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
        const context = canvas.getContext('2d');
        context.scale(ratio, ratio);
        context.fillStyle = '#09111d';
        context.fillRect(0, 0, width, height);
        const xs = points.map(point => Number(point.projections[state.projection].x));
        const ys = points.map(point => Number(point.projections[state.projection].y));
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const pad = 24;
        const sx = value => pad + (((value - minX) / Math.max(1e-9, maxX - minX)) * (width - (pad * 2)));
        const sy = value => height - pad - (((value - minY) / Math.max(1e-9, maxY - minY)) * (height - (pad * 2)));
        const plotted = points.map(point => ({
            point,
            x: sx(Number(point.projections[state.projection].x)),
            y: sy(Number(point.projections[state.projection].y)),
        }));
        context.globalAlpha = .78;
        plotted.forEach(row => {
            context.beginPath();
            context.arc(row.x, row.y, row.point.owned ? 3.2 : 2.2, 0, Math.PI * 2);
            context.fillStyle = atlasColor(row.point, partition);
            context.fill();
            if (row.point.id === state.pointId) {
                context.globalAlpha = 1;
                context.lineWidth = 2;
                context.strokeStyle = '#ffffff';
                context.stroke();
                context.globalAlpha = .78;
            }
        });
        context.globalAlpha = 1;

        function nearest(event) {
            const rect = canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            let best = null;
            let distance = 100;
            for (const row of plotted) {
                const current = ((row.x - x) ** 2) + ((row.y - y) ** 2);
                if (current < distance) {
                    distance = current;
                    best = row;
                }
            }
            return distance <= 100 ? best : null;
        }
        canvas.addEventListener('mousemove', event => {
            const row = nearest(event);
            if (!row) {
                tooltip.hidden = true;
                return;
            }
            tooltip.hidden = false;
            tooltip.style.left = `${Math.min(width - 230, row.x + 12)}px`;
            tooltip.style.top = `${Math.max(8, row.y - 54)}px`;
            tooltip.innerHTML = `<b>${esc(row.point.title || row.point.id)}</b><span>${esc(row.point.source)} · ${compact(row.point.views)} views · C${row.point.clusters[String(partition.clusterCount)]}</span>`;
        });
        canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
        canvas.addEventListener('click', event => {
            const row = nearest(event);
            if (!row) return;
            state.pointId = row.point.id;
            preserveScroll(render);
        });
    }

    function bind() {
        if (!state.root) return;
        state.root.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
            state.error = '';
            state.data = null;
            load();
        });
        state.root.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
            state.view = button.dataset.view;
            state.transformationId = null;
            setUrl();
            render();
        }));
        state.root.querySelectorAll('[data-invariant]').forEach(button => button.addEventListener('click', () => {
            state.invariantId = button.dataset.invariant;
            state.transformationId = null;
            preserveScroll(render);
        }));
        state.root.querySelectorAll('[data-matrix]').forEach(button => button.addEventListener('click', () => {
            state.invariantId = button.dataset.matrix;
            state.transformationId = button.dataset.transformation;
            preserveScroll(render);
        }));
        state.root.querySelectorAll('[data-surface]').forEach(button => button.addEventListener('click', () => {
            const id = button.dataset.surface;
            if (!id) return;
            state.surfaceId = id;
            if (state.view === 'discoveries') state.view = 'system';
            setUrl();
            preserveScroll(render);
        }));
        state.root.querySelectorAll('[data-surface-filter]').forEach(button => button.addEventListener('click', () => {
            state.surfaceFilter = button.dataset.surfaceFilter;
            preserveScroll(render);
        }));
        state.root.querySelectorAll('[data-graph-node]').forEach(node => {
            const select = () => {
                state.graphNodeId = node.dataset.graphNode;
                preserveScroll(render);
            };
            node.addEventListener('click', select);
            node.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') select();
            });
        });
        state.root.querySelector('[data-atlas-map]')?.addEventListener('change', event => {
            state.mapId = event.target.value;
            const map = selectedMap();
            state.projection = Object.keys(map.projections)[0] || 'pca';
            state.clusterCount = map.partitions[0]?.clusterCount || 6;
            state.pointId = null;
            state.transportKey = null;
            setUrl();
            render();
        });
        state.root.querySelector('[data-atlas-projection]')?.addEventListener('change', event => {
            state.projection = event.target.value;
            state.pointId = null;
            setUrl();
            render();
        });
        state.root.querySelector('[data-atlas-k]')?.addEventListener('change', event => {
            state.clusterCount = Number(event.target.value);
            setUrl();
            render();
        });
        state.root.querySelector('[data-atlas-color]')?.addEventListener('change', event => {
            state.colorBy = event.target.value;
            setUrl();
            render();
        });
        state.root.querySelectorAll('[data-transport]').forEach(button => button.addEventListener('click', () => {
            state.transportKey = button.dataset.transport;
            preserveScroll(render);
        }));
        state.root.querySelectorAll('[data-model]').forEach(button => button.addEventListener('click', () => {
            state.modelId = button.dataset.model;
            preserveScroll(render);
        }));
        state.root.querySelector('[data-evidence-search]')?.addEventListener('input', event => {
            state.evidenceSearch = event.target.value;
            const selectionStart = event.target.selectionStart;
            preserveScroll(render);
            const input = state.root.querySelector('[data-evidence-search]');
            input?.focus();
            input?.setSelectionRange(selectionStart, selectionStart);
        });
    }

    window.JarvisPrinciplesLab = { mount };
}());
