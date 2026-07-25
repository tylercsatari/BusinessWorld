(function () {
    'use strict';

    const ARTIFACT_URL = './buildings/jarvis/principles-lab/artifact.json?v=1';
    const VIEW_TABS = [
        ['map', 'Evidence map'],
        ['registry', 'Candidate registry'],
        ['survival', 'Transformation survival'],
        ['sources', 'Source audit'],
        ['method', 'Method'],
    ];

    const state = {
        root: null,
        data: null,
        error: '',
        loading: false,
        view: 'map',
        selectedId: null,
        search: '',
        family: 'all',
        level: 'all',
        status: 'all',
        gate: 'all',
        selectedTransformation: null,
    };

    const STATUS = {
        supported_regionally: { label: 'regionally supported', tone: 'green' },
        supported_locally: { label: 'locally supported', tone: 'cyan' },
        partial_signal: { label: 'partial signal', tone: 'amber' },
        exploratory: { label: 'exploratory', tone: 'muted' },
        falsified_currently: { label: 'failed current test', tone: 'red' },
    };

    const EVIDENCE = {
        pass: { label: 'pass', glyph: '●', tone: 'green' },
        fail: { label: 'fail', glyph: '×', tone: 'red' },
        diagnostic: { label: 'diagnostic', glyph: '◆', tone: 'amber' },
        tested: { label: 'tested', glyph: '○', tone: 'cyan' },
        not_tested: { label: 'not tested', glyph: '–', tone: 'muted' },
        not_applicable: { label: 'not applicable', glyph: '–', tone: 'muted' },
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

    function pct(value, digits = 0) {
        if (!Number.isFinite(Number(value))) return '—';
        return `${(Number(value) * 100).toFixed(digits)}%`;
    }

    function signed(value, digits = 2) {
        if (!Number.isFinite(Number(value))) return '—';
        const number = Number(value);
        return `${number > 0 ? '+' : ''}${number.toFixed(digits)}`;
    }

    function compactNumber(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '—';
        return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
    }

    function shortHash(value) {
        return value ? String(value).slice(0, 10) : '—';
    }

    function selectedCandidate() {
        if (!state.data) return null;
        return state.data.candidates.find(candidate => candidate.id === state.selectedId)
            || state.data.candidates[0]
            || null;
    }

    function levelLabel(levelId) {
        return state.data?.operationalContract?.hierarchy?.find(level => level.id === levelId)?.label
            || String(levelId || '').replaceAll('_', ' ');
    }

    function statusMeta(status) {
        return STATUS[status] || { label: String(status || 'unknown').replaceAll('_', ' '), tone: 'muted' };
    }

    function evidenceMeta(status) {
        return EVIDENCE[status] || EVIDENCE.not_tested;
    }

    function evidenceChip(status, extra = '') {
        const meta = evidenceMeta(status);
        return `<span class="pl-evidence-chip is-${meta.tone}"><span aria-hidden="true">${meta.glyph}</span>${esc(extra || meta.label)}</span>`;
    }

    function statusChip(status) {
        const meta = statusMeta(status);
        return `<span class="pl-status-chip is-${meta.tone}">${esc(meta.label)}</span>`;
    }

    function preserveScroll(renderFn) {
        const scroller = state.root?.closest('.jarvis-content');
        const top = scroller ? scroller.scrollTop : 0;
        renderFn();
        if (scroller) requestAnimationFrame(() => { scroller.scrollTop = top; });
    }

    async function load() {
        if (state.data || state.loading) return;
        state.loading = true;
        state.error = '';
        render();
        try {
            const response = await fetch(ARTIFACT_URL, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`artifact request failed (${response.status})`);
            const data = await response.json();
            if (data.schema !== 'predictive-abstraction-lab-v1') {
                throw new Error('unexpected predictive abstraction artifact');
            }
            state.data = data;
            state.selectedId = data.summary?.strongestSupported?.[0]
                || data.candidates?.[0]?.id
                || null;
        } catch (error) {
            state.error = error?.message || String(error);
        } finally {
            state.loading = false;
            render();
        }
    }

    function mount(root) {
        state.root = root;
        render();
        load();
    }

    function render() {
        if (!state.root) return;
        if (state.loading && !state.data) {
            state.root.innerHTML = `
                <div class="principles-lab pl-loading">
                    <span class="pl-loading-mark" aria-hidden="true"></span>
                    <div><b>Loading the evidence registry</b><span>Reading the compact, source-hashed snapshot.</span></div>
                </div>`;
            return;
        }
        if (state.error) {
            state.root.innerHTML = `
                <div class="principles-lab">
                    <div class="pl-error"><b>Principles artifact unavailable</b><span>${esc(state.error)}</span>
                    <button type="button" data-pl-retry>Retry</button></div>
                </div>`;
            state.root.querySelector('[data-pl-retry]')?.addEventListener('click', () => {
                state.data = null;
                load();
            });
            return;
        }
        if (!state.data) return;

        const data = state.data;
        const summary = data.summary;
        const generated = new Date(data.generatedAt);
        state.root.innerHTML = `
            <div class="principles-lab">
                <header class="pl-header">
                    <div class="pl-header-main">
                        <div class="pl-eyebrow">Predictive abstraction / current evidence</div>
                        <h2>When is an abstraction justified?</h2>
                        <p>${esc(data.thesis)}</p>
                    </div>
                    <div class="pl-snapshot">
                        <span>Evidence snapshot</span>
                        <b>${Number.isNaN(generated.getTime()) ? 'unknown' : generated.toLocaleDateString()}</b>
                        <code>${esc(shortHash(data.artifactHash))}</code>
                    </div>
                </header>

                <div class="pl-ceiling">
                    <div>
                        <span>Current ceiling</span>
                        <b>${esc(summary.headline)}</b>
                    </div>
                    <div class="pl-ceiling-counts">
                        <span><b>${summary.levelCounts.regional_invariant || 0}</b> regional</span>
                        <span><b>${summary.levelCounts.local_invariant || 0}</b> local</span>
                        <span><b>${summary.levelCounts.domain_invariant || 0}</b> domain</span>
                        <span><b>0</b> universal</span>
                    </div>
                </div>

                <nav class="pl-tabs" aria-label="Principles lab views">
                    ${VIEW_TABS.map(([id, label]) => `
                        <button type="button" class="${state.view === id ? 'active' : ''}" data-pl-view="${id}">${label}</button>
                    `).join('')}
                </nav>

                <main class="pl-view">${renderView()}</main>
            </div>`;
        bind();
    }

    function renderView() {
        if (state.view === 'registry') return renderRegistry();
        if (state.view === 'survival') return renderSurvival();
        if (state.view === 'sources') return renderSources();
        if (state.view === 'method') return renderMethod();
        return renderMap();
    }

    function renderMap() {
        const data = state.data;
        const summary = data.summary;
        const candidate = selectedCandidate();
        return `
            <section class="pl-stat-strip" aria-label="Evidence summary">
                ${stat('Evidence sources', summary.sourceCount, 'Canonical, current artifacts')}
                ${stat('Candidate abstractions', summary.candidateCount, 'Comparable only inside a target family')}
                ${stat('Failed current OOD tests', summary.statusCounts.falsified_currently || 0, 'Failures remain first-class evidence', 'red')}
                ${stat('Prospective passes', summary.transformationCounts.prospective.pass || 0, 'No future lockbox has passed', 'amber')}
            </section>

            <section class="pl-prerequisite-band">
                <div class="pl-section-heading">
                    <div><span>Justification gates</span><h3>All four are necessary</h3></div>
                    <p>A candidate is capped by its weakest failed or untested gate. Sample size cannot compensate for missing source diversity.</p>
                </div>
                <div class="pl-gate-grid">
                    ${data.operationalContract.prerequisites.map((gate, index) => {
                        const counts = prerequisiteCounts(gate.id);
                        return `
                            <button type="button" class="pl-gate ${state.gate === gate.id ? 'active' : ''}" data-pl-gate="${gate.id}">
                                <span class="pl-gate-number">0${index + 1}</span>
                                <b>${esc(gate.label)}</b>
                                <small>${esc(gate.question)}</small>
                                <em>${counts.pass} pass · ${counts.fail} fail · ${counts.unknown} unresolved</em>
                            </button>`;
                    }).join('')}
                </div>
            </section>

            <div class="pl-map-layout">
                <section class="pl-panel pl-map-panel">
                    <div class="pl-section-heading">
                        <div><span>Diversity × falsification distance</span><h3>How far each claim has actually traveled</h3></div>
                        <p>Horizontal position is independent-source diversity. Vertical position is the hardest test attempted, not evidence strength. Red points traveled far enough to fail.</p>
                    </div>
                    ${renderEvidenceMapSvg()}
                    <div class="pl-chart-legend">
                        <span><i class="is-green"></i>supported</span>
                        <span><i class="is-cyan"></i>local</span>
                        <span><i class="is-amber"></i>partial</span>
                        <span><i class="is-red"></i>failed</span>
                        <span><i class="is-muted"></i>exploratory</span>
                        <em>circle area = observations</em>
                    </div>
                </section>
                ${renderCandidateDetail(candidate, true)}
            </div>

            <section class="pl-panel pl-depth-panel">
                <div class="pl-section-heading">
                    <div><span>Recursive constraint hierarchy</span><h3>Depth is earned by transformation survival</h3></div>
                    <p>Mechanisms compose into stable interactions. Only invariants that keep predicting can constrain the next layer.</p>
                </div>
                ${renderDepthLadder()}
            </section>

            <section class="pl-panel">
                <div class="pl-section-heading">
                    <div><span>Prediction ledger</span><h3>The most informative results include the failures</h3></div>
                    <p>These are the current system-level claims. Click any row to inspect exactly what survived and what did not.</p>
                </div>
                ${renderPredictionLedger()}
            </section>`;
    }

    function stat(label, value, note, tone = '') {
        return `
            <div class="pl-stat ${tone ? `is-${tone}` : ''}">
                <span>${esc(label)}</span>
                <b>${esc(value)}</b>
                <small>${esc(note)}</small>
            </div>`;
    }

    function prerequisiteCounts(id) {
        const values = state.data.candidates.map(candidate => candidate.prerequisites?.[id]?.state || 'not_tested');
        return {
            pass: values.filter(value => value === 'pass').length,
            fail: values.filter(value => value === 'fail').length,
            unknown: values.filter(value => !['pass', 'fail'].includes(value)).length,
        };
    }

    function validationReach(candidate) {
        const get = id => candidate.transformations.find(row => row.id === id)?.state;
        if (!['not_tested', 'not_applicable', undefined].includes(get('prospective'))) return 5;
        if (!['not_tested', 'not_applicable', undefined].includes(get('format'))) return 4;
        if (!['not_tested', 'not_applicable', undefined].includes(get('source'))) return 3;
        if (!['not_tested', 'not_applicable', undefined].includes(get('time'))) return 2;
        if (!['not_tested', 'not_applicable', undefined].includes(get('resample'))) return 1;
        return 0;
    }

    function renderEvidenceMapSvg() {
        const width = 760;
        const height = 360;
        const left = 58;
        const right = 22;
        const top = 24;
        const bottom = 48;
        const plotW = width - left - right;
        const plotH = height - top - bottom;
        const maxSources = Math.max(1, ...state.data.candidates.map(candidate => candidate.sample?.independentSources || 0));
        const maxLogSources = Math.log10(maxSources + 1);
        const yLabels = ['internal', 'resampled', 'forward time', 'unseen source', 'cross-format', 'prospective'];
        const statusColor = {
            supported_regionally: '#42d392',
            supported_locally: '#35c7d8',
            partial_signal: '#e8b44f',
            exploratory: '#78869a',
            falsified_currently: '#f06a72',
        };
        const circles = state.data.candidates.map(candidate => {
            const independent = Math.max(0, candidate.sample?.independentSources || 0);
            const x = left + (Math.log10(independent + 1) / maxLogSources) * plotW;
            const reach = validationReach(candidate);
            const y = top + plotH - (reach / 5) * plotH;
            const radius = Math.max(5, Math.min(17, 4 + Math.sqrt(Math.max(1, candidate.sample?.observations || 1)) / 7));
            const selected = candidate.id === state.selectedId;
            const label = candidate.label.length > 28 ? `${candidate.label.slice(0, 27)}…` : candidate.label;
            return `
                <g class="pl-map-point ${selected ? 'is-selected' : ''}" data-principle-id="${esc(candidate.id)}" role="button" tabindex="0"
                    transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
                    <title>${esc(candidate.label)} · ${independent || 'unknown'} independent sources · ${yLabels[reach]}</title>
                    <circle r="${radius.toFixed(2)}" fill="${statusColor[candidate.status] || '#78869a'}"></circle>
                    ${selected ? `<circle class="pl-map-ring" r="${(radius + 5).toFixed(2)}"></circle>
                        <text x="${radius + 9}" y="4">${esc(label)}</text>` : ''}
                </g>`;
        }).join('');

        const yGrid = yLabels.map((label, index) => {
            const y = top + plotH - (index / 5) * plotH;
            return `<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"></line>
                <text class="pl-axis-label" x="${left - 10}" y="${y + 3}" text-anchor="end">${esc(label)}</text>`;
        }).join('');
        const sourceTicks = [0, 1, 3, 10, 30, 100].filter(value => value <= maxSources);
        if (!sourceTicks.includes(maxSources)) sourceTicks.push(maxSources);
        const xGrid = sourceTicks.map(value => {
            const x = left + (Math.log10(value + 1) / maxLogSources) * plotW;
            return `<line x1="${x}" x2="${x}" y1="${top}" y2="${top + plotH}"></line>
                <text class="pl-axis-label" x="${x}" y="${height - 19}" text-anchor="middle">${value}</text>`;
        }).join('');

        return `
            <div class="pl-svg-wrap">
                <svg class="pl-evidence-map" viewBox="0 0 ${width} ${height}" aria-label="Candidate evidence diversity and validation reach">
                    <g class="pl-grid">${yGrid}${xGrid}</g>
                    <text class="pl-axis-title" x="${left + plotW / 2}" y="${height - 2}" text-anchor="middle">independent source families (log scale)</text>
                    <text class="pl-axis-title" transform="translate(12 ${top + plotH / 2}) rotate(-90)" text-anchor="middle">hardest test attempted</text>
                    <g>${circles}</g>
                </svg>
            </div>`;
    }

    function renderCandidateDetail(candidate, compact = false) {
        if (!candidate) return '';
        const prereqs = Object.entries(candidate.prerequisites || {});
        const sources = candidate.sourceIds.map(id => state.data.sources.find(source => source.id === id)).filter(Boolean);
        const transformSummary = candidate.transformations.reduce((acc, row) => {
            acc[row.state] = (acc[row.state] || 0) + 1;
            return acc;
        }, {});
        return `
            <aside class="pl-detail ${compact ? 'is-compact' : ''}">
                <div class="pl-detail-head">
                    <div>
                        <span>${esc(candidate.familyLabel)}</span>
                        <h3>${esc(candidate.label)}</h3>
                    </div>
                    ${statusChip(candidate.status)}
                </div>
                <p class="pl-statement">${esc(candidate.statement)}</p>
                <div class="pl-level-row">
                    <span>Current depth <b>${esc(levelLabel(candidate.level))}</b></span>
                    <span>Claim ceiling <b>${esc(levelLabel(candidate.ceiling))}</b></span>
                    ${candidate.pareto?.front ? `<span>Pareto front <b>${candidate.pareto.front}</b></span>` : ''}
                </div>
                <div class="pl-prereq-list">
                    ${prereqs.map(([id, row]) => `
                        <div>
                            <span>${esc(id)}</span>
                            ${evidenceChip(row.state)}
                            <b>${esc(row.measure)}</b>
                            <small>${esc(row.detail)}</small>
                        </div>`).join('')}
                </div>
                <div class="pl-mini-metrics">
                    <span><b>${compactNumber(candidate.sample?.observations)}</b> observations</span>
                    <span><b>${candidate.sample?.independentSources == null ? 'unknown' : fmt(candidate.sample.independentSources, 0)}</b> independent sources</span>
                    <span><b>${transformSummary.pass || 0}</b> transformations passed</span>
                    <span><b>${transformSummary.fail || 0}</b> failed</span>
                </div>
                <div class="pl-boundary"><span>Claim boundary</span>${esc(candidate.claimBoundary)}</div>
                <div class="pl-next-test"><span>Next falsification test</span>${esc(candidate.nextTest)}</div>
                ${sources.length ? `
                    <div class="pl-source-chips">${sources.map(source => `
                        <button type="button" data-pl-source="${esc(source.id)}">${esc(source.label)}</button>
                    `).join('')}</div>` : ''}
                ${candidate.examples?.length ? `
                    <details class="pl-examples">
                        <summary>Representative observations (${candidate.examples.length})</summary>
                        ${candidate.examples.map(example => `<p>${esc(example)}</p>`).join('')}
                    </details>` : ''}
            </aside>`;
    }

    function renderDepthLadder() {
        const hierarchy = state.data.operationalContract.hierarchy;
        return `
            <div class="pl-depth-ladder">
                ${hierarchy.map((level, index) => {
                    const count = state.data.summary.levelCounts[level.id] || 0;
                    return `
                        <button type="button" data-pl-level="${esc(level.id)}" class="${state.level === level.id ? 'active' : ''}">
                            <span>${String(index + 1).padStart(2, '0')}</span>
                            <b>${esc(level.label)}</b>
                            <em>${count}</em>
                            <small>${esc(level.definition)}</small>
                        </button>`;
                }).join('')}
            </div>`;
    }

    function systemCandidates() {
        return state.data.candidates.filter(candidate => !candidate.id.startsWith('operations:'));
    }

    function metricSummary(candidate) {
        const prerequisites = candidate.prerequisites || {};
        const predictive = prerequisites.predictability;
        const persistent = prerequisites.persistence;
        return `${predictive?.measure || 'prediction unmeasured'} · ${persistent?.measure || 'persistence unmeasured'}`;
    }

    function renderPredictionLedger() {
        return `
            <div class="pl-ledger">
                ${systemCandidates().map(candidate => `
                    <button type="button" data-principle-id="${esc(candidate.id)}" class="${candidate.id === state.selectedId ? 'active' : ''}">
                        <span class="pl-ledger-name"><b>${esc(candidate.label)}</b><small>${esc(candidate.familyLabel)}</small></span>
                        <span>${statusChip(candidate.status)}</span>
                        <span class="pl-ledger-metric">${esc(metricSummary(candidate))}</span>
                        <span class="pl-ledger-level">${esc(levelLabel(candidate.level))}</span>
                    </button>
                `).join('')}
            </div>`;
    }

    function filteredCandidates() {
        const query = state.search.trim().toLowerCase();
        return state.data.candidates.filter(candidate => {
            if (state.family !== 'all' && candidate.family !== state.family) return false;
            if (state.level !== 'all' && candidate.level !== state.level) return false;
            if (state.status !== 'all' && candidate.status !== state.status) return false;
            if (state.gate !== 'all' && candidate.prerequisites?.[state.gate]?.state !== 'fail') return false;
            if (query && !`${candidate.label} ${candidate.statement} ${candidate.familyLabel}`.toLowerCase().includes(query)) return false;
            return true;
        });
    }

    function renderRegistry() {
        const candidates = filteredCandidates();
        const families = [...new Set(state.data.candidates.map(candidate => candidate.family))].sort();
        const statuses = [...new Set(state.data.candidates.map(candidate => candidate.status))].sort();
        return `
            <section class="pl-registry-controls">
                <label><span>Search</span><input type="search" value="${esc(state.search)}" placeholder="candidate, family, or claim" data-pl-search></label>
                <label><span>Family</span><select data-pl-family>
                    <option value="all">All families</option>
                    ${families.map(family => `<option value="${esc(family)}" ${state.family === family ? 'selected' : ''}>${esc(family.replaceAll('_', ' '))}</option>`).join('')}
                </select></label>
                <label><span>Depth</span><select data-pl-level-select>
                    <option value="all">All depths</option>
                    ${state.data.operationalContract.hierarchy.map(level => `<option value="${esc(level.id)}" ${state.level === level.id ? 'selected' : ''}>${esc(level.label)}</option>`).join('')}
                </select></label>
                <label><span>Status</span><select data-pl-status>
                    <option value="all">All statuses</option>
                    ${statuses.map(status => `<option value="${esc(status)}" ${state.status === status ? 'selected' : ''}>${esc(statusMeta(status).label)}</option>`).join('')}
                </select></label>
                <button type="button" data-pl-clear>Clear filters</button>
            </section>
            <div class="pl-registry-layout">
                <section class="pl-panel pl-table-panel">
                    <div class="pl-section-heading">
                        <div><span>Candidate registry</span><h3>${candidates.length} of ${state.data.candidates.length} abstractions</h3></div>
                        <p>Prerequisite states are kept separate. No weighted score can hide a failed OOD test.</p>
                    </div>
                    <div class="pl-table-scroll">
                        <table class="pl-registry-table">
                            <thead><tr>
                                <th>Candidate</th><th>Depth</th><th>D</th><th>S</th><th>P</th><th>Prediction</th>
                                <th>n</th><th>sources</th><th>hardest test</th>
                            </tr></thead>
                            <tbody>${candidates.map(candidate => `
                                <tr data-principle-id="${esc(candidate.id)}" class="${candidate.id === state.selectedId ? 'active' : ''}" tabindex="0">
                                    <td><b>${esc(candidate.label)}</b><small>${esc(candidate.familyLabel)}</small></td>
                                    <td>${statusChip(candidate.status)}<small>${esc(levelLabel(candidate.level))}</small></td>
                                    ${['distinguishability', 'similarity', 'persistence', 'predictability'].map(id => {
                                        const row = candidate.prerequisites[id];
                                        return `<td title="${esc(row?.detail)}">${evidenceChip(row?.state || 'not_tested', row?.measure || '')}</td>`;
                                    }).join('')}
                                    <td>${compactNumber(candidate.sample?.observations)}</td>
                                    <td>${candidate.sample?.independentSources == null ? 'unknown' : fmt(candidate.sample.independentSources, 0)}</td>
                                    <td>${esc(['internal', 'resampled', 'forward time', 'unseen source', 'cross-format', 'prospective'][validationReach(candidate)])}</td>
                                </tr>`).join('')}</tbody>
                        </table>
                    </div>
                </section>
                ${renderCandidateDetail(selectedCandidate(), true)}
            </div>`;
    }

    function renderSurvival() {
        const candidates = filteredCandidates();
        const transforms = state.data.transformations;
        const selectedTransform = transforms.find(row => row.id === state.selectedTransformation);
        return `
            <section class="pl-panel">
                <div class="pl-section-heading">
                    <div><span>Transformation matrix</span><h3>What survived, failed, or was never tested</h3></div>
                    <p>A principle-like claim needs breadth across columns. Click a cell for its exact evidence, or a header to isolate one transformation.</p>
                </div>
                <div class="pl-matrix-scroll">
                    <table class="pl-survival-matrix">
                        <thead><tr><th>Candidate</th>${transforms.map(row => `
                            <th><button type="button" data-pl-transform="${esc(row.id)}" class="${state.selectedTransformation === row.id ? 'active' : ''}">${esc(row.label)}</button></th>
                        `).join('')}</tr></thead>
                        <tbody>${candidates.map(candidate => `
                            <tr>
                                <th><button type="button" data-principle-id="${esc(candidate.id)}">${esc(candidate.label)}</button></th>
                                ${transforms.map(transformRow => {
                                    const result = candidate.transformations.find(row => row.id === transformRow.id)
                                        || { state: 'not_tested', detail: 'Not tested.' };
                                    const meta = evidenceMeta(result.state);
                                    return `<td><button type="button" class="pl-matrix-cell is-${meta.tone}" data-pl-cell="${esc(candidate.id)}|${esc(transformRow.id)}" title="${esc(result.detail)}"><span>${meta.glyph}</span></button></td>`;
                                }).join('')}
                            </tr>`).join('')}</tbody>
                    </table>
                </div>
                <div class="pl-chart-legend">
                    ${['pass', 'fail', 'diagnostic', 'tested', 'not_tested'].map(key => {
                        const meta = evidenceMeta(key);
                        return `<span><i class="is-${meta.tone}"></i>${esc(meta.label)}</span>`;
                    }).join('')}
                </div>
                ${selectedTransform ? `
                    <div class="pl-transform-note"><b>${esc(selectedTransform.label)}</b><span>${esc(selectedTransform.family)} transformation</span>
                    <p>${esc(transformationDefinition(selectedTransform.id))}</p></div>` : ''}
            </section>

            <div class="pl-two-column">
                <section class="pl-panel">
                    <div class="pl-section-heading">
                        <div><span>Like-for-like ranking</span><h3>Visual-operation Pareto fronts</h3></div>
                        <p>Only candidates sharing the same discovery corpus and outcome contract are compared.</p>
                    </div>
                    ${renderParetoFronts()}
                </section>
                ${renderCandidateDetail(selectedCandidate(), true)}
            </div>`;
    }

    function transformationDefinition(id) {
        const definitions = {
            outcome_blind: 'Could the outcome influence which pattern was discovered or selected?',
            algorithm: 'Does the candidate recur when the clustering or fitting mechanism changes?',
            resolution: 'Does it survive a coarser or finer representation?',
            resample: 'Does it recur when observations or grouped lineages are resampled?',
            threshold: 'Does the result depend on one hand-picked decision threshold?',
            topic: 'Does it survive removal or redistribution of topic, subject, object, and setting?',
            time: 'Does it predict observations that occurred after every training and selection decision?',
            source: 'Does it work in creators or accounts that could not shape the abstraction?',
            format: 'Does it survive a change such as long-form to Shorts?',
            observed: 'Was the claim tested against a measured human outcome rather than a model projection?',
            prospective: 'Was the abstraction and test policy sealed before future observations existed?',
        };
        return definitions[id] || '';
    }

    function renderParetoFronts() {
        const operations = state.data.candidates
            .filter(candidate => candidate.family === 'visual_operations')
            .sort((a, b) => (a.pareto?.front || 99) - (b.pareto?.front || 99));
        const fronts = [...new Set(operations.map(candidate => candidate.pareto?.front).filter(Boolean))];
        return `
            <div class="pl-pareto">
                ${fronts.map(front => `
                    <div>
                        <span>Front ${front}</span>
                        <div>${operations.filter(candidate => candidate.pareto?.front === front).map(candidate => `
                            <button type="button" data-principle-id="${esc(candidate.id)}" class="${candidate.id === state.selectedId ? 'active' : ''}">
                                <b>${esc(candidate.label)}</b>
                                <small>${candidate.geometry.algorithmSupport} alg · ${candidate.geometry.resolutionSupport} resolutions · stability ${fmt(candidate.geometry.stability?.median, 3)}</small>
                            </button>`).join('')}</div>
                    </div>`).join('')}
            </div>
            <p class="pl-footnote">${esc(operations[0]?.pareto?.boundary || '')}</p>`;
    }

    function renderSources() {
        const maxN = Math.max(...state.data.sources.map(source => source.observations || 0), 1);
        return `
            <section class="pl-panel">
                <div class="pl-section-heading">
                    <div><span>Canonical inputs</span><h3>Sample count and diversity are different variables</h3></div>
                    <p>Bars show rows on a log scale. The independent-source column controls how far a claim can travel.</p>
                </div>
                <div class="pl-source-list">
                    ${state.data.sources.map(source => {
                        const width = Math.log10((source.observations || 0) + 1) / Math.log10(maxN + 1) * 100;
                        return `
                            <button type="button" data-pl-source="${esc(source.id)}">
                                <span class="pl-source-name"><b>${esc(source.label)}</b><small>${esc(source.domain)} · ${esc(source.outcome)}</small></span>
                                <span class="pl-source-bar"><i style="width:${width.toFixed(1)}%"></i></span>
                                <span><b>${compactNumber(source.observations)}</b><small>rows</small></span>
                                <span><b>${source.independentSources == null ? 'unknown' : fmt(source.independentSources, 0)}</b><small>sources</small></span>
                                <span>${esc(source.validation)}</span>
                            </button>`;
                    }).join('')}
                </div>
            </section>

            <section class="pl-panel">
                <div class="pl-section-heading">
                    <div><span>Prediction cycle</span><h3>Compression earns depth only by leaving the training region</h3></div>
                    <p>The loop is recursive. New failures return to the observation layer instead of being hidden as model error.</p>
                </div>
                ${renderFlowGraph()}
            </section>

            <section class="pl-panel">
                <div class="pl-section-heading">
                    <div><span>Quarantine</span><h3>Retained for audit, excluded from promotion</h3></div>
                    <p>Older exploratory outputs remain inspectable but cannot vote as independent evidence for current candidates.</p>
                </div>
                <div class="pl-quarantine">
                    ${state.data.quarantinedSources.map(source => `
                        <div><span>${esc(source.label)}</span><code>${esc(shortHash(source.fingerprint?.sha256))}</code><p>${esc(source.reason)}</p></div>
                    `).join('')}
                </div>
            </section>`;
    }

    function renderFlowGraph() {
        const nodes = state.data.flow.nodes;
        const width = 930;
        const height = 190;
        const positions = Object.fromEntries(nodes.map((node, index) => [
            node.id,
            { x: 58 + index * ((width - 116) / (nodes.length - 1)), y: 84 + (index % 2 ? 26 : -18) },
        ]));
        const edges = state.data.flow.edges.map(([from, to]) => {
            const a = positions[from];
            const b = positions[to];
            if (!a || !b) return '';
            const bend = from === 'new_observations' && to === 'observations';
            return bend
                ? `<path d="M ${a.x} ${a.y + 22} C ${a.x} ${height - 4}, ${b.x} ${height - 4}, ${b.x} ${b.y + 22}"></path>`
                : `<path d="M ${a.x + 43} ${a.y} C ${(a.x + b.x) / 2} ${a.y}, ${(a.x + b.x) / 2} ${b.y}, ${b.x - 43} ${b.y}"></path>`;
        }).join('');
        return `
            <div class="pl-svg-wrap">
                <svg class="pl-flow" viewBox="0 0 ${width} ${height}" aria-label="Recursive predictive abstraction cycle">
                    <defs><marker id="pl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>
                    <g class="pl-flow-edges">${edges}</g>
                    ${nodes.map(node => {
                        const point = positions[node.id];
                        return `<g transform="translate(${point.x} ${point.y})"><rect x="-43" y="-22" width="86" height="44"></rect><text y="-3">${esc(node.label)}</text><text class="pl-flow-count" y="13">${compactNumber(node.count)}</text></g>`;
                    }).join('')}
                </svg>
            </div>`;
    }

    function renderMethod() {
        return `
            <section class="pl-panel">
                <div class="pl-section-heading">
                    <div><span>Operational definition</span><h3>Principle = predictive compression that survives transformation</h3></div>
                    <p>The tab deliberately refuses a universal weighted score. Evidence dimensions retain their units and promotion is conjunctive.</p>
                </div>
                <div class="pl-method-grid">
                    ${state.data.operationalContract.prerequisites.map((gate, index) => `
                        <div><span>0${index + 1}</span><b>${esc(gate.label)}</b><p>${esc(gate.gate)}</p></div>
                    `).join('')}
                </div>
            </section>

            <div class="pl-two-column">
                <section class="pl-panel">
                    <div class="pl-section-heading">
                        <div><span>Ranking contract</span><h3>No arbitrary total score</h3></div>
                    </div>
                    <dl class="pl-definition-list">
                        <div><dt>Method</dt><dd>${esc(state.data.operationalContract.ranking.method)}</dd></div>
                        <div><dt>Why</dt><dd>${esc(state.data.operationalContract.ranking.reason)}</dd></div>
                        <div><dt>Weakest link</dt><dd>${esc(state.data.operationalContract.ranking.weakestLinkRule)}</dd></div>
                        <div><dt>Diversity</dt><dd>${esc(state.data.operationalContract.diversityRule)}</dd></div>
                        <div><dt>MDL boundary</dt><dd>${esc(state.data.operationalContract.mdlBoundary)}</dd></div>
                    </dl>
                </section>
                <section class="pl-panel">
                    <div class="pl-section-heading">
                        <div><span>Depth ladder</span><h3>What each label permits</h3></div>
                    </div>
                    <div class="pl-level-definitions">
                        ${state.data.operationalContract.hierarchy.map((level, index) => `
                            <div><span>${index + 1}</span><b>${esc(level.label)}</b><p>${esc(level.definition)}</p></div>
                        `).join('')}
                    </div>
                </section>
            </div>

            <section class="pl-panel">
                <div class="pl-section-heading">
                    <div><span>Transformation definitions</span><h3>The tests that increase abstraction depth</h3></div>
                </div>
                <div class="pl-transform-definitions">
                    ${state.data.transformations.map(transform => `
                        <div><b>${esc(transform.label)}</b><span>${esc(transform.family)}</span><p>${esc(transformationDefinition(transform.id))}</p></div>
                    `).join('')}
                </div>
            </section>

            <section class="pl-panel">
                <div class="pl-section-heading">
                    <div><span>Artifact provenance</span><h3>Every current input is fingerprinted</h3></div>
                    <p>Rebuilding the snapshot changes the artifact hash whenever a source, claim, or promotion boundary changes.</p>
                </div>
                <div class="pl-provenance">
                    ${state.data.sources.map(source => `
                        <div><span>${esc(source.label)}</span><code>${esc(shortHash(source.fingerprint?.sha256))}</code><small>${esc(source.fingerprint?.path || '')}</small></div>
                    `).join('')}
                </div>
            </section>`;
    }

    function bind() {
        state.root.querySelectorAll('[data-pl-view]').forEach(button => {
            button.addEventListener('click', () => {
                state.view = button.dataset.plView;
                render();
            });
        });
        state.root.querySelectorAll('[data-principle-id]').forEach(element => {
            const activate = () => {
                state.selectedId = element.dataset.principleId;
                preserveScroll(render);
            };
            element.addEventListener('click', activate);
            element.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate();
                }
            });
        });
        state.root.querySelectorAll('[data-pl-gate]').forEach(button => {
            button.addEventListener('click', () => {
                state.gate = state.gate === button.dataset.plGate ? 'all' : button.dataset.plGate;
                if (state.gate !== 'all') {
                    state.view = 'registry';
                    state.family = 'all';
                    state.level = 'all';
                    state.status = 'all';
                }
                render();
            });
        });
        state.root.querySelectorAll('[data-pl-level]').forEach(button => {
            button.addEventListener('click', () => {
                state.level = button.dataset.plLevel;
                state.view = 'registry';
                render();
            });
        });
        state.root.querySelector('[data-pl-search]')?.addEventListener('input', event => {
            state.search = event.target.value;
            preserveScroll(render);
            requestAnimationFrame(() => {
                const input = state.root.querySelector('[data-pl-search]');
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            });
        });
        state.root.querySelector('[data-pl-family]')?.addEventListener('change', event => {
            state.family = event.target.value;
            preserveScroll(render);
        });
        state.root.querySelector('[data-pl-level-select]')?.addEventListener('change', event => {
            state.level = event.target.value;
            preserveScroll(render);
        });
        state.root.querySelector('[data-pl-status]')?.addEventListener('change', event => {
            state.status = event.target.value;
            preserveScroll(render);
        });
        state.root.querySelector('[data-pl-clear]')?.addEventListener('click', () => {
            state.search = '';
            state.family = 'all';
            state.level = 'all';
            state.status = 'all';
            state.gate = 'all';
            render();
        });
        state.root.querySelectorAll('[data-pl-transform]').forEach(button => {
            button.addEventListener('click', () => {
                state.selectedTransformation = state.selectedTransformation === button.dataset.plTransform
                    ? null
                    : button.dataset.plTransform;
                preserveScroll(render);
            });
        });
        state.root.querySelectorAll('[data-pl-cell]').forEach(button => {
            button.addEventListener('click', () => {
                const [candidateId, transformId] = button.dataset.plCell.split('|');
                state.selectedId = candidateId;
                state.selectedTransformation = transformId;
                preserveScroll(render);
            });
        });
        state.root.querySelectorAll('[data-pl-source]').forEach(button => {
            button.addEventListener('click', () => {
                const sourceId = button.dataset.plSource;
                state.view = 'sources';
                state.family = 'all';
                render();
                requestAnimationFrame(() => {
                    const source = state.root.querySelector(`[data-pl-source="${CSS.escape(sourceId)}"]`);
                    source?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    source?.classList.add('is-highlighted');
                });
            });
        });
    }

    window.JarvisPrinciplesLab = { mount };
})();
