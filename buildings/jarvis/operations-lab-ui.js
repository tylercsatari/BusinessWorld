(function () {
    'use strict';

    const STATUS_API = '/api/shortsquant/operations-lab/status';
    const ARTIFACT_API = '/api/shortsquant/operations-lab/artifact';
    const STYLE_ID = 'jarvis-operations-lab-styles';
    const ROOT_ID = 'operations-lab-root';
    const CLUSTER_COLORS = [
        '#35bdf5', '#f3b33d', '#9b8cff', '#36c98f', '#f06f7d',
        '#e779c1', '#62c5b7', '#a6c85e', '#f08a4b', '#7f9cff',
    ];
    const TARGET_ORDER = ['together_keep', 'visual_keep', 'text_keep'];
    const TARGET_SHORT = {
        together_keep: 'Combined',
        visual_keep: 'Visual',
        text_keep: 'Text',
    };

    function create(options) {
        options = options || {};
        const C = Object.assign({
            bg: '#0a0f18',
            card: '#101722',
            card2: '#151e2b',
            border: '#273244',
            border2: '#36445a',
            text: '#edf2f7',
            dim: '#a4afbd',
            mute: '#788597',
            faint: '#526074',
            cyan: '#34c5f4',
            accent: '#4cb9f2',
            green: '#39c991',
            amber: '#f2b84b',
            red: '#f17178',
            purple: '#a691f2',
        }, options.colors || {});
        const esc = typeof options.escapeHtml === 'function'
            ? options.escapeHtml
            : value => String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        const suppliedNumberFormatter = typeof options.formatNumber === 'function'
            ? options.formatNumber
            : null;
        const parentRender = typeof options.onRender === 'function' ? options.onRender : null;

        const state = {
            view: 'overview',
            target: 'together_keep',
            threshold: 80,
            status: null,
            artifact: null,
            statusError: '',
            artifactError: '',
            artifactPending: false,
            loading: false,
            loadedOnce: false,
            familyKey: '',
            familyQuery: '',
            clusterId: null,
            selectedHookId: '',
            selectedPointIndex: null,
            selectedInteractionKey: '',
            hookQuery: '',
            hookSort: 'target-desc',
            hookLimit: 36,
            interactionQuery: '',
            interactionSort: 'q-asc',
            interactionLimit: 100,
            pollTimer: null,
            inputTimer: null,
            requestToken: 0,
        };
        let host = null;
        let interactionCache = null;

        const numeric = value => (
            value === null || value === undefined || value === ''
                ? null
                : (Number.isFinite(Number(value)) ? Number(value) : null)
        );
        const fixed = (value, digits) => numeric(value) == null
            ? '--'
            : Number(value).toFixed(digits == null ? 1 : digits);
        const percent = (value, digits) => numeric(value) == null
            ? '--'
            : `${fixed(Number(value) * 100, digits == null ? 1 : digits)}%`;
        const percentValue = (value, digits) => numeric(value) == null
            ? '--'
            : `${fixed(value, digits == null ? 1 : digits)}%`;
        const signed = (value, digits) => numeric(value) == null
            ? '--'
            : `${Number(value) >= 0 ? '+' : ''}${fixed(value, digits == null ? 2 : digits)}`;
        const finiteArray = values => (values || []).map(numeric).filter(value => value != null);
        const median = values => {
            const sorted = finiteArray(values).sort((left, right) => left - right);
            if (!sorted.length) return null;
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2
                ? sorted[middle]
                : (sorted[middle - 1] + sorted[middle]) / 2;
        };
        const formatCount = value => {
            const number = numeric(value);
            if (number == null) return '--';
            if (suppliedNumberFormatter) {
                try {
                    const rendered = suppliedNumberFormatter(number);
                    if (rendered != null && rendered !== '') return String(rendered);
                } catch (_) {
                    // Fall through to the local formatter.
                }
            }
            return Math.round(number).toLocaleString();
        };
        const shortNumber = value => {
            const number = numeric(value);
            if (number == null) return '--';
            if (Math.abs(number) >= 1e9) return `${fixed(number / 1e9, 2)}B`;
            if (Math.abs(number) >= 1e6) return `${fixed(number / 1e6, 2)}M`;
            if (Math.abs(number) >= 1e3) return `${fixed(number / 1e3, 1)}K`;
            return fixed(number, Number.isInteger(number) ? 0 : 1);
        };
        const dateTime = value => {
            const number = numeric(value);
            if (number == null || number <= 0) return '--';
            try {
                return new Date(number).toLocaleString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                });
            } catch (_) {
                return '--';
            }
        };
        const summarizeRecord = (value, fallback) => {
            if (value === null || value === undefined || value === '') return fallback || '--';
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                return String(value);
            }
            if (Array.isArray(value)) {
                const parts = value.map(item => summarizeRecord(item, '')).filter(Boolean);
                return parts.length ? parts.join(' / ') : (fallback || '--');
            }
            if (typeof value === 'object') {
                const preferred = [
                    'summary', 'description', 'protocol', 'method', 'targetNature',
                    'targets', 'folds', 'selection', 'dataset', 'label', 'name', 'key',
                ];
                const parts = preferred
                    .filter(key => value[key] !== null && value[key] !== undefined && value[key] !== '')
                    .map(key => `${key}: ${summarizeRecord(value[key], '')}`)
                    .filter(part => !part.endsWith(': '));
                if (parts.length) return parts.join(' / ');
                const primitives = Object.entries(value)
                    .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
                    .slice(0, 8)
                    .map(([key, item]) => `${key}: ${item}`);
                return primitives.length ? primitives.join(' / ') : (fallback || '--');
            }
            return fallback || '--';
        };
        const sourceSummary = source => summarizeRecord(source, 'No source details declared.');
        const validationSummary = provenance => {
            const detail = summarizeRecord(
                (provenance || {}).validation,
                'Five-fold cross-fitted ridge by feature family.',
            );
            return `Surrogate reconstruction of existing keep estimates, not observed swipe: ${detail}`;
        };
        const visibleStage = stage => (
            String(stage || '').toLowerCase() === 'interactions'
                ? 'co-occurrence'
                : String(stage || '').replace(/_/g, ' ')
        );
        const colorForCluster = id => CLUSTER_COLORS[
            Math.abs(Number(id) || 0) % CLUSTER_COLORS.length
        ];
        const clampThreshold = value => Math.max(0, Math.min(100, Number(value) || 0));
        const artifact = () => state.artifact || {};
        const hooks = () => Array.isArray(artifact().hooks) ? artifact().hooks : [];
        const families = () => Array.isArray(artifact().families) ? artifact().families : [];
        const selectedFamily = () => (
            families().find(family => family.key === state.familyKey) || families()[0] || null
        );
        const hookIndex = id => hooks().findIndex(hook => String(hook.id) === String(id));
        const selectedHook = () => {
            const index = hookIndex(state.selectedHookId);
            return index >= 0 ? { hook: hooks()[index], index } : null;
        };
        const targetDefinition = () => (
            (artifact().targets || {})[state.target] || {
                label: TARGET_SHORT[state.target] || state.target,
                description: 'Existing keep-rate estimate.',
            }
        );
        const targetValue = hook => numeric((((hook || {}).targets || {})[state.target] || {}).estimate);
        const targetPercentile = hook => numeric((((hook || {}).targets || {})[state.target] || {}).percentile);
        const targetValues = () => hooks().map(targetValue);
        const baseStats = () => {
            const values = finiteArray(targetValues());
            const hits = values.filter(value => value >= state.threshold).length;
            return {
                n: values.length,
                mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
                median: median(values),
                min: values.length ? Math.min.apply(null, values) : null,
                max: values.length ? Math.max.apply(null, values) : null,
                hits,
                hitRate: values.length ? hits / values.length : null,
            };
        };
        const cssEscape = value => {
            const text = String(value == null ? '' : value);
            if (
                typeof CSS !== 'undefined'
                && CSS
                && typeof CSS.escape === 'function'
            ) {
                return CSS.escape(text);
            }
            return text.replace(/["\\]/g, '\\$&');
        };

        function ensureStylesheet() {
            if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
            const link = document.createElement('link');
            link.id = STYLE_ID;
            link.rel = 'stylesheet';
            link.href = '/buildings/jarvis/operations-lab.css?v=1';
            document.head.appendChild(link);
        }

        function rootStyle() {
            return [
                `--ops-bg:${C.bg}`,
                `--ops-card:${C.card}`,
                `--ops-card-2:${C.card2}`,
                `--ops-border:${C.border}`,
                `--ops-border-2:${C.border2}`,
                `--ops-text:${C.text}`,
                `--ops-dim:${C.dim}`,
                `--ops-mute:${C.mute}`,
                `--ops-faint:${C.faint}`,
                `--ops-cyan:${C.cyan || C.accent}`,
                `--ops-accent:${C.accent || C.cyan}`,
                `--ops-green:${C.green}`,
                `--ops-amber:${C.amber}`,
                `--ops-red:${C.red}`,
                `--ops-purple:${C.purple}`,
            ].join(';');
        }

        function captureViewport() {
            if (!host || !host.isConnected || typeof window === 'undefined') return null;
            const active = document.activeElement;
            const focus = active && host.contains(active) ? {
                marker: active.getAttribute('data-ops-focus'),
                start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
                end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
            } : null;
            const scrolls = {};
            host.querySelectorAll('[data-ops-scroll-key]').forEach(element => {
                scrolls[element.getAttribute('data-ops-scroll-key')] = {
                    top: element.scrollTop,
                    left: element.scrollLeft,
                };
            });
            return {
                x: window.scrollX,
                y: window.scrollY,
                focus,
                scrolls,
            };
        }

        function restoreViewport(snapshot) {
            if (!snapshot || !host || !host.isConnected || typeof window === 'undefined') return;
            Object.entries(snapshot.scrolls || {}).forEach(([key, position]) => {
                const element = host.querySelector(`[data-ops-scroll-key="${cssEscape(key)}"]`);
                if (element) {
                    element.scrollTop = position.top;
                    element.scrollLeft = position.left;
                }
            });
            window.scrollTo(snapshot.x, snapshot.y);
            if (snapshot.focus && snapshot.focus.marker) {
                const field = host.querySelector(
                    `[data-ops-focus="${cssEscape(snapshot.focus.marker)}"]`,
                );
                if (field) {
                    field.focus({ preventScroll: true });
                    if (
                        snapshot.focus.start != null
                        && typeof field.setSelectionRange === 'function'
                    ) {
                        field.setSelectionRange(snapshot.focus.start, snapshot.focus.end);
                    }
                }
            }
        }

        function paint() {
            if (!host || !host.isConnected) {
                if (parentRender) parentRender();
                return;
            }
            const viewport = captureViewport();
            host.outerHTML = renderBody();
            host = document.getElementById(ROOT_ID);
            window.requestAnimationFrame(() => restoreViewport(viewport));
        }

        function schedulePaint(delay) {
            window.clearTimeout(state.inputTimer);
            state.inputTimer = window.setTimeout(paint, delay == null ? 90 : delay);
        }

        async function readJson(url) {
            const response = await fetch(url, { cache: 'no-store' });
            const text = await response.text();
            let value = {};
            try {
                value = text ? JSON.parse(text) : {};
            } catch (_) {
                throw new Error(
                    text.trim().startsWith('<')
                        ? `Server returned HTML for ${url}`
                        : `Server returned invalid JSON for ${url}`,
                );
            }
            return { response, value };
        }

        function normalizeSelection() {
            if (!state.familyKey && families().length) state.familyKey = families()[0].key;
            if (state.familyKey && !families().some(family => family.key === state.familyKey)) {
                state.familyKey = families()[0] ? families()[0].key : '';
            }
            const family = selectedFamily();
            if (
                state.clusterId != null
                && family
                && !(family.clusters || []).some(cluster => Number(cluster.id) === Number(state.clusterId))
            ) {
                state.clusterId = null;
            }
            if (state.selectedHookId && hookIndex(state.selectedHookId) < 0) {
                state.selectedHookId = '';
                state.selectedPointIndex = null;
            }
        }

        async function loadStatus() {
            try {
                const result = await readJson(STATUS_API);
                if (!result.response.ok) {
                    throw new Error(result.value.error || `HTTP ${result.response.status}`);
                }
                state.status = result.value;
                state.statusError = '';
                return result.value;
            } catch (error) {
                state.statusError = String(error && error.message || error);
                return null;
            }
        }

        function artifactMatchesStatus() {
            const stage = String((state.status || {}).stage || '').toLowerCase();
            const expected = String((state.status || {}).artifactHash || '');
            if (!state.artifact) return false;
            if (stage !== 'complete' || !expected) return true;
            return String(state.artifact.artifactHash || '') === expected;
        }

        async function loadArtifact(expectedHash) {
            try {
                const expected = String(expectedHash || '');
                const url = expected
                    ? `${ARTIFACT_API}?artifactHash=${encodeURIComponent(expected)}&v=${Date.now()}`
                    : ARTIFACT_API;
                const result = await readJson(url);
                if (result.response.status === 202) {
                    state.artifactPending = true;
                    state.artifactError = String(result.value.error || '');
                    return null;
                }
                if (!result.response.ok || result.value.error) {
                    throw new Error(result.value.error || `HTTP ${result.response.status}`);
                }
                if (!Array.isArray(result.value.hooks) || !Array.isArray(result.value.families)) {
                    throw new Error('Operations artifact is missing hooks or feature families.');
                }
                if (expected && String(result.value.artifactHash || '') !== expected) {
                    state.artifactPending = true;
                    state.artifactError = 'The completed analysis is propagating; waiting for its verified artifact hash.';
                    return null;
                }
                state.artifact = result.value;
                state.artifactPending = false;
                state.artifactError = '';
                interactionCache = null;
                normalizeSelection();
                return result.value;
            } catch (error) {
                state.artifactError = String(error && error.message || error);
                return null;
            }
        }

        function terminalStage(stage) {
            return ['complete', 'test_complete', 'error', 'stopped']
                .includes(String(stage || '').toLowerCase());
        }

        function statusTone(stage) {
            const normalized = String(stage || '').toLowerCase();
            if (normalized === 'error' || normalized === 'stopped') return 'is-error';
            if (normalized === 'complete' || normalized === 'test_complete') return 'is-terminal';
            return '';
        }

        function schedulePoll() {
            window.clearTimeout(state.pollTimer);
            const stage = String(state.status && state.status.stage || '').toLowerCase();
            if (['error', 'stopped'].includes(stage)) return;
            if (terminalStage(stage) && artifactMatchesStatus()) return;
            state.pollTimer = window.setTimeout(async () => {
                await loadStatus();
                if (
                    !state.artifact
                    || ['complete', 'publishing', 'test_complete'].includes(
                        String((state.status || {}).stage || '').toLowerCase(),
                    )
                ) {
                    await loadArtifact((state.status || {}).artifactHash);
                }
                paint();
                schedulePoll();
            }, stage === 'blocked' ? 10000 : 5000);
        }

        async function loadAll(force) {
            if (state.loading) return;
            if (state.loadedOnce && !force) {
                schedulePoll();
                return;
            }
            const token = ++state.requestToken;
            state.loading = true;
            if (force) {
                state.statusError = '';
                state.artifactError = '';
            }
            paint();
            await loadStatus();
            await loadArtifact((state.status || {}).artifactHash);
            if (token !== state.requestToken) return;
            state.loading = false;
            state.loadedOnce = true;
            normalizeSelection();
            paint();
            schedulePoll();
        }

        function progressState() {
            const status = state.status || {};
            const stage = String(status.stage || (state.artifact ? 'complete' : 'idle'));
            let fraction = 0;
            let label = stage;
            if (stage === 'complete' || stage === 'test_complete') {
                fraction = 1;
            } else if (
                stage === 'describing'
                || ((stage === 'blocked' || stage === 'degraded') && !status.featureIndex)
            ) {
                const completed = Number(status.described || 0);
                const total = Math.max(completed, Number(status.total || 0), 1);
                fraction = 0.45 * completed / total;
                label = `${formatCount(completed)} / ${formatCount(total)} descriptions`;
            } else if (stage === 'embedding') {
                const completed = Number(status.embeddedFeatures || Math.max(0, Number(status.featureIndex || 1) - 1));
                const total = Math.max(completed, Number(status.featureTotal || 18), 1);
                fraction = 0.45 + 0.20 * completed / total;
                label = `${formatCount(completed)} / ${formatCount(total)} feature embeddings`;
            } else if ((stage === 'blocked' || stage === 'degraded') && status.featureIndex) {
                const completed = Number(status.embeddedFeatures || Math.max(0, Number(status.featureIndex || 1) - 1));
                const total = Math.max(completed, Number(status.featureTotal || 18), 1);
                fraction = 0.45 + 0.20 * completed / total;
                label = `${formatCount(completed)} / ${formatCount(total)} feature embeddings`;
            } else if (stage === 'clustering') {
                const completed = Number(status.familyIndex || 0);
                const total = Math.max(completed, Number(status.familyTotal || 18), 1);
                fraction = 0.65 + 0.25 * completed / total;
                label = `${formatCount(completed)} / ${formatCount(total)} families clustered`;
            } else {
                const stages = {
                    idle: 0, inventory: 0.01, descriptions_complete: 0.45,
                    interactions: 0.94, publishing: 0.98, error: 1, stopped: 1,
                };
                fraction = stages[stage] == null ? 0.01 : stages[stage];
            }
            return {
                stage,
                completed: Math.round(fraction * 100),
                total: 100,
                fraction: Math.max(0, Math.min(1, fraction)),
                label,
            };
        }

        function stat(label, value, note, tone) {
            return `
                <div class="ops-stat ops-tone-${esc(tone || 'default')}">
                    <div class="ops-stat-label">${esc(label)}</div>
                    <div class="ops-stat-value">${esc(value)}</div>
                    ${note ? `<div class="ops-stat-note">${esc(note)}</div>` : ''}
                </div>`;
        }

        function warningBanner() {
            const source = artifact().source || {};
            return `
                <div class="ops-warning" role="note">
                    <div class="ops-warning-label">Measurement boundary</div>
                    <div>
                        <b>Keep is an existing embedding estimate, not an observed YouTube swipe ratio.</b>
                        ${esc(summarizeRecord(source.warning, 'Associations describe the saved-hook bank and are not causal proof.'))}
                        Co-occurrence results are joint-cell enrichment patterns, not causal effects or statistical synergy.
                    </div>
                </div>`;
        }

        function renderProgress() {
            const progress = progressState();
            const status = state.status || {};
            const provider = status.providerError || {};
            const stale = numeric(status.updatedAt) != null
                && Date.now() - Number(status.updatedAt) > 180000
                && !terminalStage(progress.stage);
            return `
                <section class="ops-progress ${provider.message ? 'is-blocked' : ''}">
                    <div class="ops-progress-main">
                        <div class="ops-progress-heading">
                            <span class="ops-status-dot ${statusTone(progress.stage)}"></span>
                            <b>${esc(visibleStage(progress.stage))}</b>
                            <span>${esc(progress.label)}</span>
                            ${stale ? '<span class="ops-stale">worker heartbeat stale</span>' : ''}
                        </div>
                        <div class="ops-progress-track" aria-label="${esc(progress.label)}">
                            <span style="width:${fixed(progress.fraction * 100, 2)}%"></span>
                        </div>
                        <div class="ops-progress-message">${esc(
                            status.message
                            || (state.artifact
                                ? 'Persisted artifact loaded.'
                                : 'Waiting for the Operations worker.'),
                        )}</div>
                        ${provider.message ? `
                            <div class="ops-provider-error">
                                ${esc(provider.provider || 'Provider')} ${esc(provider.kind || 'error')}:
                                ${esc(provider.message)}
                                ${provider.retrySeconds ? ` Retrying in ${esc(provider.retrySeconds)} seconds.` : ''}
                            </div>` : ''}
                        ${status.error ? `<div class="ops-provider-error">${esc(status.error)}</div>` : ''}
                        ${stale ? '<div class="ops-provider-error">No progress heartbeat has arrived for three minutes. The worker may have stopped; refresh checks the persisted status without discarding the last complete artifact.</div>' : ''}
                    </div>
                    <div class="ops-progress-meta">
                        <span>updated ${esc(dateTime(status.updatedAt))}</span>
                        <button type="button" class="ops-icon-button" data-ops-refresh title="Refresh Operations status" aria-label="Refresh Operations status">&#8635;</button>
                    </div>
                </section>`;
        }

        function renderTabs() {
            const tabs = [
                ['overview', 'Overview'],
                ['families', 'Feature families'],
                ['interactions', 'Co-occurrence'],
                ['hooks', 'Hook library'],
            ];
            return `
                <nav class="ops-tabs" aria-label="Operations views">
                    ${tabs.map(([key, label]) => `
                        <button type="button" data-ops-view="${key}" class="${state.view === key ? 'is-active' : ''}">
                            ${esc(label)}
                        </button>`).join('')}
                </nav>`;
        }

        function renderControls() {
            return `
                <div class="ops-control-bar">
                    ${renderTabs()}
                    <div class="ops-control-group" aria-label="Keep estimate target">
                        <span class="ops-control-label">Target</span>
                        <div class="ops-segmented">
                            ${TARGET_ORDER.map(key => `
                                <button type="button" data-ops-target="${key}" class="${state.target === key ? 'is-active' : ''}">
                                    ${esc(TARGET_SHORT[key])}
                                </button>`).join('')}
                        </div>
                    </div>
                    <label class="ops-threshold-control">
                        <span class="ops-control-label">Hit threshold</span>
                        <input type="range" min="0" max="100" step="1" value="${esc(state.threshold)}"
                            data-ops-threshold data-ops-focus="threshold-range">
                        <input type="number" min="0" max="100" step="1" value="${esc(state.threshold)}"
                            data-ops-threshold-number data-ops-focus="threshold-number"
                            aria-label="Hit threshold percentage">
                        <span>%</span>
                    </label>
                </div>`;
        }

        function renderTargetSummary() {
            const stats = baseStats();
            return `
                <div class="ops-stat-grid">
                    ${stat('Eligible hooks', formatCount(stats.n), targetDefinition().label)}
                    ${stat('Mean estimate', percentValue(stats.mean), 'existing model output', 'cyan')}
                    ${stat('Median estimate', percentValue(stats.median), `range ${fixed(stats.min, 1)}-${fixed(stats.max, 1)}`, 'purple')}
                    ${stat(`At or above ${state.threshold}%`, formatCount(stats.hits), percent(stats.hitRate) + ' base hit rate', 'green')}
                </div>`;
        }

        function renderDistribution() {
            const values = finiteArray(targetValues());
            if (!values.length) return '<div class="ops-empty">No eligible estimates for this target.</div>';
            const bins = new Array(20).fill(0);
            values.forEach(value => {
                const index = Math.max(0, Math.min(19, Math.floor(value / 5)));
                bins[index] += 1;
            });
            const maximum = Math.max.apply(null, bins) || 1;
            const width = 800;
            const height = 190;
            const pad = { left: 35, right: 16, top: 16, bottom: 28 };
            const chartWidth = width - pad.left - pad.right;
            const chartHeight = height - pad.top - pad.bottom;
            const barWidth = chartWidth / bins.length;
            const thresholdX = pad.left + chartWidth * state.threshold / 100;
            return `
                <svg class="ops-chart" viewBox="0 0 ${width} ${height}" role="img"
                    aria-label="Distribution of ${esc(targetDefinition().label)}">
                    <line x1="${pad.left}" y1="${pad.top + chartHeight}" x2="${width - pad.right}"
                        y2="${pad.top + chartHeight}" class="ops-axis-line"></line>
                    ${bins.map((count, index) => {
                        const barHeight = chartHeight * count / maximum;
                        const x = pad.left + index * barWidth + 1;
                        const y = pad.top + chartHeight - barHeight;
                        return `<rect x="${fixed(x, 2)}" y="${fixed(y, 2)}"
                            width="${fixed(Math.max(1, barWidth - 2), 2)}" height="${fixed(barHeight, 2)}"
                            class="ops-histogram-bar"><title>${index * 5}-${(index + 1) * 5}%: ${count} hooks</title></rect>`;
                    }).join('')}
                    <line x1="${fixed(thresholdX, 2)}" y1="${pad.top}" x2="${fixed(thresholdX, 2)}"
                        y2="${pad.top + chartHeight}" class="ops-threshold-line"></line>
                    <text x="${Math.min(width - 92, thresholdX + 5)}" y="13" class="ops-chart-accent">
                        ${state.threshold}% threshold
                    </text>
                    <text x="${pad.left}" y="${height - 8}" class="ops-chart-label">0%</text>
                    <text x="${width - pad.right - 24}" y="${height - 8}" class="ops-chart-label">100%</text>
                </svg>`;
        }

        function validationFor(family) {
            return ((family || {}).validation || {})[state.target] || {};
        }

        function sortedFamilies() {
            return families().slice().sort((left, right) => {
                const leftMetric = numeric(validationFor(left).r2);
                const rightMetric = numeric(validationFor(right).r2);
                return (rightMetric == null ? -Infinity : rightMetric)
                    - (leftMetric == null ? -Infinity : leftMetric);
            });
        }

        function renderProcessDiagram() {
            const provenance = artifact().provenance || {};
            const steps = [
                ['1', 'Pixels only', 'Five-frame saved montage. No title, channel, keep estimate, views, or outcome is provided.'],
                ['2', 'Frozen description', `${provenance.visionModel || 'Vision model'}, temperature ${provenance.visionTemperature == null ? '--' : provenance.visionTemperature}, seed ${provenance.visionSeed || '--'}.`],
                ['3', 'Semantic vectors', `${provenance.embeddingModel || 'Embedding model'} at ${formatCount(provenance.embeddingDimensions)} dimensions for every feature family.`],
                ['4', 'Outcome-blind geometry', 'PCA retains at least 90% variance. K is the smallest candidate within one resampling SD of the best mean silhouette across repeated 80% subsamples.'],
                ['5', 'Outcome joins last', 'Only after clusters are frozen are existing keep estimates used for out-of-fold surrogate reconstruction, cluster diagnostics, and co-occurrence enrichment.'],
            ];
            return `
                <div class="ops-process" aria-label="Outcome-blind analysis process">
                    ${steps.map((step, index) => `
                        <div class="ops-process-step">
                            <span>${step[0]}</span>
                            <div><b>${esc(step[1])}</b><p>${esc(step[2])}</p></div>
                        </div>
                        ${index < steps.length - 1 ? '<div class="ops-process-arrow" aria-hidden="true">-&gt;</div>' : ''}
                    `).join('')}
                </div>`;
        }

        function clusterDynamic(family, clusterId) {
            const assignments = (family || {}).assignments || [];
            const allValues = targetValues();
            const inside = [];
            const outside = [];
            assignments.forEach((assignment, index) => {
                const value = numeric(allValues[index]);
                if (value == null) return;
                if (Number(assignment) === Number(clusterId)) inside.push(value);
                else outside.push(value);
            });
            const hits = inside.filter(value => value >= state.threshold).length;
            const all = inside.concat(outside);
            const baseHits = all.filter(value => value >= state.threshold).length;
            const hitRate = inside.length ? hits / inside.length : null;
            const baseRate = all.length ? baseHits / all.length : null;
            const meanInside = inside.length
                ? inside.reduce((sum, value) => sum + value, 0) / inside.length
                : null;
            const meanOutside = outside.length
                ? outside.reduce((sum, value) => sum + value, 0) / outside.length
                : null;
            return {
                n: inside.length,
                hits,
                hitRate,
                baseRate,
                lift: hitRate != null && baseRate ? hitRate / baseRate : null,
                mean: meanInside,
                median: median(inside),
                difference: meanInside != null && meanOutside != null
                    ? meanInside - meanOutside
                    : null,
            };
        }

        function topClusterRows() {
            const rows = [];
            families().forEach(family => {
                (family.clusters || []).forEach(cluster => {
                    const dynamic = clusterDynamic(family, cluster.id);
                    if (dynamic.n < 5) return;
                    const stored = (cluster.outcomes || {})[state.target] || {};
                    rows.push({ family, cluster, dynamic, stored });
                });
            });
            return rows.sort((left, right) => (
                (right.dynamic.lift == null ? -Infinity : right.dynamic.lift)
                - (left.dynamic.lift == null ? -Infinity : left.dynamic.lift)
            ));
        }

        function renderOverview() {
            const topFamilies = sortedFamilies();
            const topClusters = topClusterRows().slice(0, 12);
            const provenance = artifact().provenance || {};
            const source = artifact().source || {};
            return `
                <div class="ops-view-stack">
                    ${renderTargetSummary()}
                    <div class="ops-two-column ops-overview-grid">
                        <section class="ops-panel">
                            <div class="ops-section-heading">
                                <div>
                                    <div class="ops-eyebrow">Target distribution</div>
                                    <h3>${esc(targetDefinition().label)}</h3>
                                </div>
                                <span class="ops-chip">${formatCount(hooks().length)} saved hooks</span>
                            </div>
                            <p class="ops-section-copy">${esc(targetDefinition().description || '')}</p>
                            ${renderDistribution()}
                        </section>
                        <section class="ops-panel">
                            <div class="ops-section-heading">
                                <div>
                                    <div class="ops-eyebrow">Family diagnostics</div>
                                    <h3>Surrogate reconstruction against existing keep estimates</h3>
                                </div>
                                <span class="ops-chip">5 folds</span>
                            </div>
                            <div class="ops-compact-table-wrap" data-ops-scroll-key="overview-families">
                                <table class="ops-table">
                                    <thead><tr><th>Feature family</th><th>R2</th><th>Spearman</th><th>MAE</th><th>K</th></tr></thead>
                                    <tbody>
                                        ${topFamilies.map(family => {
                                            const validation = validationFor(family);
                                            return `<tr data-ops-family="${esc(family.key)}">
                                                <td><button type="button" class="ops-text-button" data-ops-family="${esc(family.key)}">${esc(family.label)}</button></td>
                                                <td>${fixed(validation.r2, 3)}</td>
                                                <td>${fixed(validation.spearman, 3)}</td>
                                                <td>${fixed(validation.mae, 2)}</td>
                                                <td>${esc((family.selection || {}).chosenK || '--')}</td>
                                            </tr>`;
                                        }).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </section>
                    </div>
                    <section class="ops-panel">
                        <div class="ops-section-heading">
                            <div>
                                <div class="ops-eyebrow">Process contract</div>
                                <h3>Outcome-blind until validation</h3>
                            </div>
                            <span class="ops-chip ops-chip-green">${provenance.outcomeBlindClustering ? 'verified in artifact' : 'not declared'}</span>
                        </div>
                        ${renderProcessDiagram()}
                    </section>
                    <div class="ops-two-column">
                        <section class="ops-panel">
                            <div class="ops-section-heading">
                                <div>
                                    <div class="ops-eyebrow">Threshold-sensitive operations</div>
                                    <h3>Highest cluster lift at ${state.threshold}%</h3>
                                </div>
                                <span class="ops-chip">dynamic</span>
                            </div>
                            <div class="ops-compact-table-wrap" data-ops-scroll-key="overview-clusters">
                                <table class="ops-table">
                                    <thead><tr><th>Family / cluster</th><th>N</th><th>Hit rate</th><th>Lift</th><th>Mean delta</th></tr></thead>
                                    <tbody>
                                        ${topClusters.map(row => `<tr>
                                            <td><button type="button" class="ops-text-button" data-ops-family="${esc(row.family.key)}" data-ops-cluster="${esc(row.cluster.id)}">${esc(row.family.label)} / ${esc(row.cluster.label)}</button></td>
                                            <td>${formatCount(row.dynamic.n)}</td>
                                            <td>${percent(row.dynamic.hitRate)}</td>
                                            <td>${fixed(row.dynamic.lift, 2)}x</td>
                                            <td class="${Number(row.dynamic.difference) >= 0 ? 'ops-positive' : 'ops-negative'}">${signed(row.dynamic.difference, 2)} pp</td>
                                        </tr>`).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </section>
                        <section class="ops-panel">
                            <div class="ops-section-heading">
                                <div>
                                    <div class="ops-eyebrow">Artifact provenance</div>
                                    <h3>Frozen inputs and reproducibility</h3>
                                </div>
                                <span class="ops-chip">${esc(artifact().productVersion || '--')}</span>
                            </div>
                            <dl class="ops-definition-list">
                                <div><dt>Generated</dt><dd>${esc(dateTime(artifact().generatedAt))}</dd></div>
                                <div><dt>Corpus</dt><dd>${formatCount(source.n)} hooks / ${esc(String(source.corpusHash || '').slice(0, 16) || '--')}</dd></div>
                                <div><dt>Source contract</dt><dd>${esc(sourceSummary(source))}</dd></div>
                                <div><dt>Vision</dt><dd>${esc(provenance.visionModel || '--')} / T=${esc(provenance.visionTemperature == null ? '--' : provenance.visionTemperature)}</dd></div>
                                <div><dt>Prompt hash</dt><dd class="ops-mono">${esc(String(provenance.promptHash || '--'))}</dd></div>
                                <div><dt>Embeddings</dt><dd>${esc(provenance.embeddingModel || '--')} / ${formatCount(provenance.embeddingDimensions)}D</dd></div>
                                <div><dt>Random seed</dt><dd>${esc(provenance.randomSeed || '--')}</dd></div>
                                <div><dt>Descriptor input</dt><dd>${esc(provenance.descriptorInput || '--')}</dd></div>
                                <div><dt>Validation</dt><dd>${esc(validationSummary(provenance))}</dd></div>
                            </dl>
                            <details class="ops-raw-details">
                                <summary>Inspect complete provenance record</summary>
                                <pre>${esc(JSON.stringify({ source, provenance }, null, 2))}</pre>
                            </details>
                        </section>
                    </div>
                </div>`;
        }

        function familySearchRows() {
            const query = state.familyQuery.trim().toLowerCase();
            return families().filter(family => !query || [
                family.key, family.label, family.definition,
            ].join(' ').toLowerCase().includes(query));
        }

        function renderFamilyRail() {
            return `
                <aside class="ops-family-rail">
                    <label class="ops-search-field">
                        <span class="ops-control-label">Find a feature family</span>
                        <input type="search" value="${esc(state.familyQuery)}" placeholder="Action, stakes, language..."
                            data-ops-family-search data-ops-focus="family-search">
                    </label>
                    <div class="ops-family-list" data-ops-scroll-key="family-list">
                        ${familySearchRows().map(family => {
                            const validation = validationFor(family);
                            return `<button type="button" data-ops-family="${esc(family.key)}"
                                class="${family.key === (selectedFamily() || {}).key ? 'is-active' : ''}">
                                <span><b>${esc(family.label)}</b><small>${esc(family.key)}</small></span>
                                <span><b>${fixed(validation.r2, 2)}</b><small>Reconstruction R2</small></span>
                            </button>`;
                        }).join('') || '<div class="ops-empty">No matching feature family.</div>'}
                    </div>
                </aside>`;
        }

        function renderClusterPlane(family) {
            const plane = family.plane || {};
            const xs = plane.x || [];
            const ys = plane.y || [];
            const assignments = family.assignments || [];
            const width = 1000;
            const height = 640;
            const pad = 42;
            const selectedIndex = state.selectedPointIndex;
            const selectedCluster = state.clusterId;
            return `
                <svg class="ops-plane" viewBox="0 0 ${width} ${height}" role="img"
                    aria-label="${esc(family.label)} two-dimensional PCA plane">
                    <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="ops-axis-line"></line>
                    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="ops-axis-line"></line>
                    <text x="${width - 86}" y="${height - 12}" class="ops-chart-label">PCA 1</text>
                    <text x="8" y="25" class="ops-chart-label">PCA 2</text>
                    ${xs.map((rawX, index) => {
                        const cluster = Number(assignments[index]) || 0;
                        const x = pad + (width - pad * 2) * Number(rawX || 0) / 1000;
                        const y = height - pad - (height - pad * 2) * Number(ys[index] || 0) / 1000;
                        const isSelected = Number(selectedIndex) === index;
                        const muted = selectedCluster != null && Number(selectedCluster) !== cluster;
                        const hook = hooks()[index] || {};
                        return `<circle cx="${fixed(x, 2)}" cy="${fixed(y, 2)}"
                            r="${isSelected ? 9 : 5.8}" fill="${colorForCluster(cluster)}"
                            class="ops-plane-point ${isSelected ? 'is-selected' : ''} ${muted ? 'is-muted' : ''}"
                            data-ops-plane-point="${index}" tabindex="0" role="button"
                            aria-label="${esc(hook.title || hook.text || hook.id || `point ${index + 1}`)}">
                            <title>${esc(hook.title || hook.text || hook.id || `Point ${index + 1}`)} / cluster ${cluster}</title>
                        </circle>`;
                    }).join('')}
                </svg>`;
        }

        function renderValidationScatter(family) {
            const validation = validationFor(family);
            const predicted = validation.oof || [];
            const actual = targetValues();
            const points = [];
            predicted.forEach((prediction, index) => {
                const x = numeric(actual[index]);
                const y = numeric(prediction);
                if (x != null && y != null) points.push({ x, y, index });
            });
            if (!points.length) return '<div class="ops-empty">No surrogate reconstruction points for this target.</div>';
            const values = points.flatMap(point => [point.x, point.y]);
            const minimum = Math.max(0, Math.floor(Math.min.apply(null, values) / 5) * 5);
            const maximum = Math.min(100, Math.max(minimum + 5, Math.ceil(Math.max.apply(null, values) / 5) * 5));
            const width = 760;
            const height = 310;
            const pad = { left: 46, right: 20, top: 18, bottom: 38 };
            const X = value => pad.left + (width - pad.left - pad.right) * (value - minimum) / (maximum - minimum);
            const Y = value => height - pad.bottom - (height - pad.top - pad.bottom) * (value - minimum) / (maximum - minimum);
            return `
                <svg class="ops-chart ops-scatter" viewBox="0 0 ${width} ${height}" role="img"
                    aria-label="Surrogate reconstruction versus existing keep estimate">
                    <line x1="${X(minimum)}" y1="${Y(minimum)}" x2="${X(maximum)}" y2="${Y(maximum)}"
                        class="ops-perfect-line"></line>
                    <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" class="ops-axis-line"></line>
                    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" class="ops-axis-line"></line>
                    ${points.map(point => {
                        const cluster = Number((family.assignments || [])[point.index]) || 0;
                        return `<circle cx="${fixed(X(point.x), 2)}" cy="${fixed(Y(point.y), 2)}" r="5.2"
                            fill="${colorForCluster(cluster)}" class="ops-plane-point"
                            data-ops-plane-point="${point.index}" tabindex="0" role="button">
                            <title>Existing estimate ${fixed(point.x, 2)} / surrogate reconstruction ${fixed(point.y, 2)}</title>
                        </circle>`;
                    }).join('')}
                    <text x="${width - 150}" y="${height - 9}" class="ops-chart-label">existing estimate %</text>
                    <text x="7" y="12" class="ops-chart-label">surrogate reconstruction %</text>
                </svg>`;
        }

        function renderClusterCard(family, cluster) {
            const dynamic = clusterDynamic(family, cluster.id);
            const stored = (cluster.outcomes || {})[state.target] || {};
            const active = Number(state.clusterId) === Number(cluster.id);
            return `
                <article class="ops-cluster-card ${active ? 'is-active' : ''}"
                    style="--cluster-color:${colorForCluster(cluster.id)}">
                    <button type="button" class="ops-cluster-card-button"
                        data-ops-cluster="${esc(cluster.id)}" data-ops-family="${esc(family.key)}">
                        <span class="ops-cluster-dot"></span>
                        <span><b>${esc(cluster.label)}</b><small>Cluster ${Number(cluster.id) + 1} / ${formatCount(cluster.n)} hooks</small></span>
                    </button>
                    <p>${esc(cluster.definition || 'No exemplar definition stored.')}</p>
                    <div class="ops-chip-row">
                        ${(cluster.terms || []).map(term => `<span class="ops-chip">${esc(term)}</span>`).join('')}
                    </div>
                    <div class="ops-cluster-metrics">
                        <div><span>Hit rate at ${state.threshold}%</span><b>${percent(dynamic.hitRate)}</b></div>
                        <div><span>Lift vs corpus</span><b>${fixed(dynamic.lift, 2)}x</b></div>
                        <div><span>Mean estimate</span><b>${percentValue(dynamic.mean)}</b></div>
                        <div><span>Mean delta</span><b class="${Number(dynamic.difference) >= 0 ? 'ops-positive' : 'ops-negative'}">${signed(dynamic.difference, 2)} pp</b></div>
                        <div><span>Effect size</span><b>${fixed(stored.effectSize, 3)}</b></div>
                        <div><span>Global BY q</span><b>${fixed(stored.q, 4)}</b></div>
                    </div>
                    <details class="ops-inline-details">
                        <summary>Stored evidence</summary>
                        <dl>
                            <div><dt>Cluster share</dt><dd>${percent(cluster.share)}</dd></div>
                            <div><dt>Median</dt><dd>${percentValue(stored.median)}</dd></div>
                            <div><dt>95% mean-delta interval</dt><dd>${(stored.ci95 || []).length ? `${signed(stored.ci95[0], 2)} to ${signed(stored.ci95[1], 2)} pp` : '--'}</dd></div>
                            <div><dt>Welch p</dt><dd>${fixed(stored.p, 5)}</dd></div>
                            <div><dt>Within-family BH q</dt><dd>${fixed(stored.qWithinFamily, 5)}</dd></div>
                            <div><dt>Global BY q</dt><dd>${fixed(stored.q, 5)}</dd></div>
                            <div><dt>Medoid IDs</dt><dd class="ops-mono">${esc((cluster.medoids || []).join(', ') || '--')}</dd></div>
                        </dl>
                    </details>
                </article>`;
        }

        function renderKDiagnostics(family) {
            const selection = family.selection || {};
            const candidates = selection.candidates || [];
            return `
                <div class="ops-three-column">
                    ${stat('Chosen K', String(selection.chosenK || '--'), selection.rule || '')}
                    ${stat('PCA dimensions', String(selection.retainedPcaDimensions || '--'), `${percent(selection.retainedVariance)} variance retained`, 'purple')}
                    ${stat('Best silhouette K', String(selection.bestK || '--'), `cutoff ${fixed(selection.cutoff, 4)}`, 'cyan')}
                </div>
                <div class="ops-compact-table-wrap" data-ops-scroll-key="k-diagnostics">
                    <table class="ops-table">
                        <thead><tr><th>K</th><th>Mean silhouette</th><th>Resample SD</th><th>Stability</th><th>Smallest cluster</th><th>Largest cluster</th><th>Status</th></tr></thead>
                        <tbody>
                            ${candidates.map(row => `<tr class="${Number(row.k) === Number(selection.chosenK) ? 'is-selected-row' : ''}">
                                <td>${esc(row.k)}</td>
                                <td>${fixed(row.silhouette, 4)}</td>
                                <td>${fixed(numeric(row.silhouetteSd) == null ? row.silhouetteSe : row.silhouetteSd, 4)}</td>
                                <td>${fixed(row.stability, 4)}</td>
                                <td>${formatCount(row.minCluster)}</td>
                                <td>${formatCount(row.maxCluster)}</td>
                                <td>${Number(row.k) === Number(selection.chosenK) ? '<span class="ops-chip ops-chip-green">chosen</span>' : ''}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
        }

        function renderHookPeek(record) {
            if (!record) return '';
            const hook = record.hook;
            const family = selectedFamily();
            const assignment = family ? (family.assignments || [])[record.index] : null;
            const cluster = family
                ? (family.clusters || []).find(row => Number(row.id) === Number(assignment))
                : null;
            return `
                <section class="ops-point-inspector">
                    <img src="${esc(hook.montage || '')}" alt="" loading="lazy" data-ops-montage>
                    <div>
                        <div class="ops-eyebrow">Selected plane point</div>
                        <h4>${esc(hook.title || hook.text || hook.id)}</h4>
                        <p>${esc(hook.text || '')}</p>
                        <div class="ops-chip-row">
                            <span class="ops-chip" style="--chip-color:${colorForCluster(assignment)}">${esc(cluster ? cluster.label : `Cluster ${Number(assignment) + 1}`)}</span>
                            <span class="ops-chip">${percentValue(targetValue(hook))} ${esc(TARGET_SHORT[state.target])}</span>
                            <span class="ops-chip">${targetPercentile(hook) == null ? '--' : `${fixed(targetPercentile(hook), 1)}th percentile`}</span>
                        </div>
                    </div>
                    <button type="button" data-ops-open-hook="${esc(hook.id)}" class="ops-command-button">Inspect hook</button>
                </section>`;
        }

        function renderFamiliesView() {
            const family = selectedFamily();
            if (!family) return '<div class="ops-empty">The artifact has no feature families.</div>';
            const validation = validationFor(family);
            const selected = selectedHook();
            return `
                <div class="ops-family-layout">
                    ${renderFamilyRail()}
                    <main class="ops-family-main">
                        <section class="ops-panel">
                            <div class="ops-section-heading">
                                <div>
                                    <div class="ops-eyebrow">${esc(family.key)}</div>
                                    <h3>${esc(family.label)}</h3>
                                </div>
                                <span class="ops-chip">${formatCount((family.clusters || []).length)} clusters</span>
                            </div>
                            <p class="ops-section-copy">${esc(family.definition || '')}</p>
                            <div class="ops-stat-grid ops-stat-grid-compact">
                                ${stat('Reconstruction R2', fixed(validation.r2, 3), `${summarizeRecord(validation.protocol, 'five-fold out-of-fold')} / existing keep estimate`, Number(validation.r2) > 0 ? 'green' : 'red')}
                                ${stat('Reconstruction Spearman', fixed(validation.spearman, 3), 'rank association against existing estimate', 'cyan')}
                                ${stat('Reconstruction MAE', `${fixed(validation.mae, 2)} pp`, 'absolute error against existing estimate', 'amber')}
                                ${stat('AUC at 80', fixed(validation.auc80, 3), 'surrogate reconstruction threshold discrimination', 'purple')}
                                ${stat('AUC at 85', fixed(validation.auc85, 3), 'surrogate reconstruction threshold discrimination', 'purple')}
                            </div>
                        </section>
                        <div class="ops-two-column ops-plane-grid">
                            <section class="ops-panel">
                                <div class="ops-section-heading">
                                    <div>
                                        <div class="ops-eyebrow">Semantic geometry</div>
                                        <h3>Outcome-blind PCA plane</h3>
                                    </div>
                                    <span class="ops-chip">coordinates scaled 0-1000</span>
                                </div>
                                ${renderClusterPlane(family)}
                                <div class="ops-cluster-legend">
                                    ${(family.clusters || []).map(cluster => `
                                        <button type="button" data-ops-cluster="${esc(cluster.id)}" data-ops-family="${esc(family.key)}"
                                            class="${Number(state.clusterId) === Number(cluster.id) ? 'is-active' : ''}">
                                            <span style="background:${colorForCluster(cluster.id)}"></span>
                                            ${esc(cluster.label)}
                                        </button>`).join('')}
                                </div>
                            </section>
                            <section class="ops-panel">
                                <div class="ops-section-heading">
                                    <div>
                                        <div class="ops-eyebrow">Validation geometry</div>
                                        <h3>Surrogate reconstruction vs existing estimate</h3>
                                    </div>
                                    <span class="ops-chip">each hook held out</span>
                                </div>
                                ${renderValidationScatter(family)}
                            </section>
                        </div>
                        ${renderHookPeek(selected)}
                        <section class="ops-panel">
                            <div class="ops-section-heading">
                                <div>
                                    <div class="ops-eyebrow">Cluster diagnostics</div>
                                    <h3>Operations inside ${esc(family.label)}</h3>
                                </div>
                                <span class="ops-chip">threshold ${state.threshold}%</span>
                            </div>
                            <div class="ops-cluster-grid">
                                ${(family.clusters || []).map(cluster => renderClusterCard(family, cluster)).join('')}
                            </div>
                        </section>
                        <section class="ops-panel">
                            <div class="ops-section-heading">
                                <div>
                                    <div class="ops-eyebrow">Model selection</div>
                                    <h3>K and retained dimensionality</h3>
                                </div>
                            </div>
                            ${renderKDiagnostics(family)}
                            <details class="ops-raw-details">
                                <summary>Inspect complete family record</summary>
                                <pre>${esc(JSON.stringify(family, null, 2))}</pre>
                            </details>
                        </section>
                    </main>
                </div>`;
        }

        function interactionKey(row) {
            return [
                row.leftFamily, row.leftCluster,
                row.rightFamily, row.rightCluster,
            ].join('|');
        }

        function dynamicInteraction(row) {
            const left = families().find(family => family.key === row.leftFamily);
            const right = families().find(family => family.key === row.rightFamily);
            if (!left || !right) return { indices: [], n: 0 };
            const values = targetValues();
            const indices = [];
            const outside = [];
            values.forEach((value, index) => {
                if (numeric(value) == null) return;
                if (
                    Number((left.assignments || [])[index]) === Number(row.leftCluster)
                    && Number((right.assignments || [])[index]) === Number(row.rightCluster)
                ) {
                    indices.push(index);
                } else {
                    outside.push(value);
                }
            });
            const inside = indices.map(index => values[index]);
            const all = inside.concat(outside);
            const hitRate = inside.length
                ? inside.filter(value => value >= state.threshold).length / inside.length
                : null;
            const baseRate = all.length
                ? all.filter(value => value >= state.threshold).length / all.length
                : null;
            const meanInside = inside.length
                ? inside.reduce((sum, value) => sum + value, 0) / inside.length
                : null;
            const meanOutside = outside.length
                ? outside.reduce((sum, value) => sum + value, 0) / outside.length
                : null;
            return {
                indices,
                n: inside.length,
                hitRate,
                baseRate,
                lift: hitRate != null && baseRate ? hitRate / baseRate : null,
                mean: meanInside,
                difference: meanInside != null && meanOutside != null
                    ? meanInside - meanOutside
                    : null,
            };
        }

        function interactionRows() {
            const cacheKey = `${artifact().generatedAt || 'none'}|${state.target}|${state.threshold}`;
            if (!interactionCache || interactionCache.key !== cacheKey) {
                const stored = ((artifact().interactions || {})[state.target] || []);
                interactionCache = {
                    key: cacheKey,
                    rows: stored.map(row => ({
                        ...row,
                        key: interactionKey(row),
                        dynamic: dynamicInteraction(row),
                    })),
                };
            }
            const query = state.interactionQuery.trim().toLowerCase();
            const rows = interactionCache.rows.filter(row => !query || [
                row.leftFamily, row.leftLabel, row.rightFamily, row.rightLabel,
            ].join(' ').toLowerCase().includes(query));
            const sorters = {
                'q-asc': (left, right) => {
                    const key = state.threshold >= 82.5 ? 'q85' : 'q80';
                    return (numeric(left[key]) == null ? Infinity : Number(left[key]))
                        - (numeric(right[key]) == null ? Infinity : Number(right[key]));
                },
                'lift-desc': (left, right) => (numeric(right.dynamic.lift) == null ? -Infinity : Number(right.dynamic.lift))
                    - (numeric(left.dynamic.lift) == null ? -Infinity : Number(left.dynamic.lift)),
                'difference-desc': (left, right) => (numeric(right.dynamic.difference) == null ? -Infinity : Number(right.dynamic.difference))
                    - (numeric(left.dynamic.difference) == null ? -Infinity : Number(left.dynamic.difference)),
                'hit-desc': (left, right) => (numeric(right.dynamic.hitRate) == null ? -Infinity : Number(right.dynamic.hitRate))
                    - (numeric(left.dynamic.hitRate) == null ? -Infinity : Number(left.dynamic.hitRate)),
                'n-desc': (left, right) => Number(right.dynamic.n || 0) - Number(left.dynamic.n || 0),
            };
            return rows.slice().sort(sorters[state.interactionSort] || sorters['q-asc']);
        }

        function renderMiniHook(index) {
            const hook = hooks()[index] || {};
            return `
                <button type="button" class="ops-mini-hook" data-ops-open-hook="${esc(hook.id)}">
                    <img src="${esc(hook.montage || '')}" alt="" loading="lazy" data-ops-montage>
                    <span><b>${esc(hook.title || hook.text || hook.id)}</b><small>${percentValue(targetValue(hook))} ${esc(TARGET_SHORT[state.target])}</small></span>
                </button>`;
        }

        function renderInteractionInspector(row) {
            if (!row) return '';
            const leftFamily = families().find(family => family.key === row.leftFamily) || {};
            const rightFamily = families().find(family => family.key === row.rightFamily) || {};
            const leftCluster = (leftFamily.clusters || []).find(cluster => Number(cluster.id) === Number(row.leftCluster)) || {};
            const rightCluster = (rightFamily.clusters || []).find(cluster => Number(cluster.id) === Number(row.rightCluster)) || {};
            return `
                <section class="ops-panel ops-interaction-inspector">
                    <div class="ops-section-heading">
                        <div>
                            <div class="ops-eyebrow">Selected co-occurrence joint cell</div>
                            <h3>${esc(row.leftLabel)} + ${esc(row.rightLabel)}</h3>
                        </div>
                        <button type="button" class="ops-icon-button" data-ops-close-interaction title="Close co-occurrence details" aria-label="Close co-occurrence details">x</button>
                    </div>
                    <div class="ops-interaction-equation">
                        <button type="button" data-ops-family="${esc(row.leftFamily)}" data-ops-cluster="${esc(row.leftCluster)}">
                            <small>${esc(leftFamily.label || row.leftFamily)}</small>
                            <b>${esc(row.leftLabel)}</b>
                        </button>
                        <span>+</span>
                        <button type="button" data-ops-family="${esc(row.rightFamily)}" data-ops-cluster="${esc(row.rightCluster)}">
                            <small>${esc(rightFamily.label || row.rightFamily)}</small>
                            <b>${esc(row.rightLabel)}</b>
                        </button>
                    </div>
                    <div class="ops-stat-grid ops-stat-grid-compact">
                        ${stat('Matched hooks', formatCount(row.dynamic.n), 'joint-cell support')}
                        ${stat(`Hit rate at ${state.threshold}%`, percent(row.dynamic.hitRate), `base ${percent(row.dynamic.baseRate)}`, 'green')}
                        ${stat('Dynamic lift', `${fixed(row.dynamic.lift, 2)}x`, 'vs selected-target corpus', 'cyan')}
                        ${stat('Mean delta', `${signed(row.dynamic.difference, 2)} pp`, 'inside pair vs outside', Number(row.dynamic.difference) >= 0 ? 'green' : 'red')}
                        ${stat('Global BY q80', fixed(row.q80, 5), 'one dependency-safe global family', 'purple')}
                        ${stat('Global BY q85', fixed(row.q85, 5), 'same dependency-safe global family', 'purple')}
                    </div>
                    <div class="ops-two-column">
                        <div class="ops-operation-definition">
                            <div class="ops-eyebrow">${esc(leftFamily.label || row.leftFamily)}</div>
                            <h4>${esc(leftCluster.label || row.leftLabel)}</h4>
                            <p>${esc(leftCluster.definition || leftFamily.definition || '')}</p>
                        </div>
                        <div class="ops-operation-definition">
                            <div class="ops-eyebrow">${esc(rightFamily.label || row.rightFamily)}</div>
                            <h4>${esc(rightCluster.label || row.rightLabel)}</h4>
                            <p>${esc(rightCluster.definition || rightFamily.definition || '')}</p>
                        </div>
                    </div>
                    <div class="ops-eyebrow ops-list-heading">Every matched hook in this stored joint cell</div>
                    <div class="ops-mini-hook-grid">
                        ${row.dynamic.indices.map(renderMiniHook).join('')}
                    </div>
                    <details class="ops-raw-details">
                        <summary>Inspect complete co-occurrence record</summary>
                        <pre>${esc(JSON.stringify(row, null, 2))}</pre>
                    </details>
                </section>`;
        }

        function renderInteractionsView() {
            const rows = interactionRows();
            const selected = rows.find(row => row.key === state.selectedInteractionKey)
                || (interactionCache && interactionCache.rows || []).find(row => row.key === state.selectedInteractionKey);
            return `
                <div class="ops-view-stack">
                    <section class="ops-panel">
                        <div class="ops-section-heading">
                            <div>
                                <div class="ops-eyebrow">Cross-family joint cells</div>
                                <h3>Co-occurrence across feature-family clusters</h3>
                            </div>
                            <span class="ops-chip">${formatCount(((artifact().interactions || {})[state.target] || []).length)} retained tests</span>
                        </div>
                        <p class="ops-section-copy">
                            Each row is a joint cell: hooks assigned to both listed clusters. Hit rate and lift
                            are descriptive enrichment patterns within this saved-hook bank, not causal effects
                            or statistical synergy. q80 and q85 are Benjamini-Yekutieli values from one
                            dependency-safe global family across all targets, feature-family pairs, joint cells,
                            and both thresholds.
                        </p>
                        <div class="ops-filter-row">
                            <label class="ops-search-field">
                                <span class="ops-control-label">Search co-occurrence</span>
                                <input type="search" value="${esc(state.interactionQuery)}"
                                    placeholder="Stakes + action, proof + language..."
                                    data-ops-interaction-search data-ops-focus="interaction-search">
                            </label>
                            <label class="ops-select-field">
                                <span class="ops-control-label">Sort</span>
                                <select data-ops-interaction-sort data-ops-focus="interaction-sort">
                                    <option value="q-asc" ${state.interactionSort === 'q-asc' ? 'selected' : ''}>Lowest global BY q</option>
                                    <option value="lift-desc" ${state.interactionSort === 'lift-desc' ? 'selected' : ''}>Highest dynamic lift</option>
                                    <option value="difference-desc" ${state.interactionSort === 'difference-desc' ? 'selected' : ''}>Highest mean delta</option>
                                    <option value="hit-desc" ${state.interactionSort === 'hit-desc' ? 'selected' : ''}>Highest hit rate</option>
                                    <option value="n-desc" ${state.interactionSort === 'n-desc' ? 'selected' : ''}>Largest support</option>
                                </select>
                            </label>
                        </div>
                    </section>
                    ${renderInteractionInspector(selected)}
                    <section class="ops-panel">
                        <div class="ops-compact-table-wrap ops-interaction-table-wrap" data-ops-scroll-key="interaction-table">
                            <table class="ops-table ops-interaction-table">
                                <thead>
                                    <tr><th>Left operation</th><th>Right operation</th><th>N</th><th>Hit ${state.threshold}%</th><th>Lift</th><th>Mean delta</th><th>BY q80</th><th>BY q85</th></tr>
                                </thead>
                                <tbody>
                                    ${rows.slice(0, state.interactionLimit).map(row => `
                                        <tr data-ops-interaction="${esc(row.key)}" tabindex="0" role="button"
                                            class="${row.key === state.selectedInteractionKey ? 'is-selected-row' : ''}">
                                            <td><b>${esc(row.leftLabel)}</b><small>${esc(row.leftFamily)} / c${esc(row.leftCluster)}</small></td>
                                            <td><b>${esc(row.rightLabel)}</b><small>${esc(row.rightFamily)} / c${esc(row.rightCluster)}</small></td>
                                            <td>${formatCount(row.dynamic.n)}</td>
                                            <td>${percent(row.dynamic.hitRate)}</td>
                                            <td>${fixed(row.dynamic.lift, 2)}x</td>
                                            <td class="${Number(row.dynamic.difference) >= 0 ? 'ops-positive' : 'ops-negative'}">${signed(row.dynamic.difference, 2)} pp</td>
                                            <td>${fixed(row.q80, 5)}</td>
                                            <td>${fixed(row.q85, 5)}</td>
                                        </tr>`).join('') || '<tr><td colspan="8"><div class="ops-empty">No matching co-occurrence cells.</div></td></tr>'}
                                </tbody>
                            </table>
                        </div>
                        ${rows.length > state.interactionLimit ? `
                            <button type="button" class="ops-load-more" data-ops-more-interactions>
                                Show ${Math.min(100, rows.length - state.interactionLimit)} more
                            </button>` : ''}
                    </section>
                </div>`;
        }

        function featureText(hook, key) {
            if (!hook) return '';
            if (key === 'full_visual') return hook.description || '';
            if (key === 'hook_language') return ((hook.features || {}).hook_language || hook.text || hook.title || '');
            if (key === 'combined_semantics') {
                return `Visible opening: ${hook.description || ''} Saved hook language: ${hook.text || hook.title || ''}`.trim();
            }
            return (hook.features || {})[key] || '';
        }

        function hookMemberships(index) {
            const hook = hooks()[index] || {};
            return families().map(family => {
                const clusterId = Number((family.assignments || [])[index]);
                const cluster = (family.clusters || []).find(row => Number(row.id) === clusterId) || {};
                const validation = validationFor(family);
                const oof = numeric((validation.oof || [])[index]);
                const actual = targetValue(hook);
                return {
                    family,
                    clusterId,
                    cluster,
                    x: numeric(((family.plane || {}).x || [])[index]),
                    y: numeric(((family.plane || {}).y || [])[index]),
                    oof,
                    actual,
                    error: oof != null && actual != null ? oof - actual : null,
                    text: featureText(hook, family.key),
                };
            });
        }

        function renderHookDetail(record) {
            if (!record) return '';
            const hook = record.hook;
            const memberships = hookMemberships(record.index);
            const rawMemberships = memberships.map(row => ({
                familyKey: row.family.key,
                familyLabel: row.family.label,
                clusterId: row.clusterId,
                clusterLabel: row.cluster.label || `Cluster ${row.clusterId + 1}`,
                featureText: row.text,
                plane: { x: row.x, y: row.y },
                oofPrediction: row.oof,
                actualEstimate: row.actual,
                oofError: row.error,
            }));
            return `
                <section class="ops-panel ops-hook-detail">
                    <div class="ops-section-heading">
                        <div>
                            <div class="ops-eyebrow">Saved hook ${esc(hook.id)}</div>
                            <h3>${esc(hook.title || hook.text || hook.id)}</h3>
                        </div>
                        <button type="button" class="ops-icon-button" data-ops-close-hook title="Close hook details" aria-label="Close hook details">x</button>
                    </div>
                    <div class="ops-hook-hero">
                        <img src="${esc(hook.montage || '')}" alt="Five-frame saved opening montage" loading="eager" data-ops-montage>
                        <div>
                            <div class="ops-hook-text">${esc(hook.text || '')}</div>
                            <dl class="ops-definition-list ops-definition-list-compact">
                                <div><dt>Source</dt><dd>${esc(hook.source || '--')}</dd></div>
                                <div><dt>Saved</dt><dd>${esc(dateTime(hook.savedAt))}</dd></div>
                                ${TARGET_ORDER.map(key => {
                                    const target = ((hook.targets || {})[key] || {});
                                    return `<div><dt>${esc(TARGET_SHORT[key])}</dt><dd>${percentValue(target.estimate)} / ${numeric(target.percentile) == null ? '--' : `${fixed(target.percentile, 1)}th`}</dd></div>`;
                                }).join('')}
                            </dl>
                        </div>
                    </div>
                    <div class="ops-two-column ops-hook-narrative">
                        <div>
                            <div class="ops-eyebrow">Full outcome-blind visual paragraph</div>
                            <p>${esc(hook.description || 'No visual paragraph stored.')}</p>
                        </div>
                        <div>
                            <div class="ops-eyebrow">Five-frame sequence</div>
                            <ol>
                                ${(hook.sequence || []).map(sentence => `<li>${esc(sentence)}</li>`).join('')}
                            </ol>
                        </div>
                    </div>
                    <div class="ops-section-heading ops-membership-heading">
                        <div>
                            <div class="ops-eyebrow">Complete feature ledger</div>
                            <h3>Every feature, cluster membership, coordinate, and surrogate reconstruction</h3>
                        </div>
                        <span class="ops-chip">${formatCount(memberships.length)} families</span>
                    </div>
                    <div class="ops-membership-grid">
                        ${memberships.map(row => `
                            <article class="ops-membership-card" style="--cluster-color:${colorForCluster(row.clusterId)}">
                                <button type="button" data-ops-family="${esc(row.family.key)}" data-ops-cluster="${esc(row.clusterId)}">
                                    <span class="ops-cluster-dot"></span>
                                    <span><b>${esc(row.family.label)}</b><small>${esc(row.family.key)}</small></span>
                                </button>
                                <div class="ops-membership-cluster">${esc(row.cluster.label || `Cluster ${row.clusterId + 1}`)}</div>
                                <p>${esc(row.text || 'Not supplied.')}</p>
                                <dl>
                                    <div><dt>Plane</dt><dd>${fixed(row.x, 0)}, ${fixed(row.y, 0)}</dd></div>
                                    <div><dt>Surrogate reconstruction</dt><dd>${percentValue(row.oof)}</dd></div>
                                    <div><dt>Actual estimate</dt><dd>${percentValue(row.actual)}</dd></div>
                                    <div><dt>Reconstruction error</dt><dd class="${Number(row.error) >= 0 ? 'ops-positive' : 'ops-negative'}">${signed(row.error, 2)} pp</dd></div>
                                </dl>
                            </article>`).join('')}
                    </div>
                    <details class="ops-raw-details">
                        <summary>Inspect complete hook record</summary>
                        <pre>${esc(JSON.stringify({ hook, memberships: rawMemberships }, null, 2))}</pre>
                    </details>
                </section>`;
        }

        function hookRows() {
            const query = state.hookQuery.trim().toLowerCase();
            const rows = hooks().map((hook, index) => ({ hook, index }))
                .filter(record => !query || [
                    record.hook.id,
                    record.hook.title,
                    record.hook.text,
                    record.hook.description,
                    ...Object.values(record.hook.features || {}),
                ].join(' ').toLowerCase().includes(query));
            const sorters = {
                'target-desc': (left, right) => (targetValue(right.hook) == null ? -Infinity : targetValue(right.hook))
                    - (targetValue(left.hook) == null ? -Infinity : targetValue(left.hook)),
                'target-asc': (left, right) => (targetValue(left.hook) == null ? Infinity : targetValue(left.hook))
                    - (targetValue(right.hook) == null ? Infinity : targetValue(right.hook)),
                'percentile-desc': (left, right) => (targetPercentile(right.hook) == null ? -Infinity : targetPercentile(right.hook))
                    - (targetPercentile(left.hook) == null ? -Infinity : targetPercentile(left.hook)),
                'recent': (left, right) => Number(right.hook.savedAt || 0) - Number(left.hook.savedAt || 0),
                'title': (left, right) => String(left.hook.title || left.hook.text || '').localeCompare(String(right.hook.title || right.hook.text || '')),
            };
            return rows.sort(sorters[state.hookSort] || sorters['target-desc']);
        }

        function renderHookCard(record) {
            const hook = record.hook;
            const memberships = hookMemberships(record.index).slice(0, 4);
            return `
                <button type="button" class="ops-hook-card ${String(state.selectedHookId) === String(hook.id) ? 'is-active' : ''}"
                    data-ops-open-hook="${esc(hook.id)}">
                    <img src="${esc(hook.montage || '')}" alt="" loading="lazy" data-ops-montage>
                    <span class="ops-hook-card-body">
                        <span class="ops-hook-card-title">${esc(hook.title || hook.text || hook.id)}</span>
                        <span class="ops-hook-card-text">${esc(hook.text || '')}</span>
                        <span class="ops-hook-card-score">
                            <b>${percentValue(targetValue(hook))}</b>
                            <small>${esc(TARGET_SHORT[state.target])} estimate / ${targetPercentile(hook) == null ? '--' : `${fixed(targetPercentile(hook), 1)}th`}</small>
                        </span>
                        <span class="ops-hook-memberships">
                            ${memberships.map(row => `<span style="--cluster-color:${colorForCluster(row.clusterId)}">${esc(row.family.label)}: c${row.clusterId}</span>`).join('')}
                        </span>
                    </span>
                </button>`;
        }

        function renderHooksView() {
            const rows = hookRows();
            const detail = selectedHook();
            return `
                <div class="ops-view-stack">
                    <section class="ops-panel">
                        <div class="ops-section-heading">
                            <div>
                                <div class="ops-eyebrow">Durable saved-hook bank</div>
                                <h3>Every analyzed opening</h3>
                            </div>
                            <span class="ops-chip">${formatCount(rows.length)} matching hooks</span>
                        </div>
                        <div class="ops-filter-row">
                            <label class="ops-search-field">
                                <span class="ops-control-label">Search full analysis</span>
                                <input type="search" value="${esc(state.hookQuery)}"
                                    placeholder="Title, hook, visual detail, object, action..."
                                    data-ops-hook-search data-ops-focus="hook-search">
                            </label>
                            <label class="ops-select-field">
                                <span class="ops-control-label">Sort</span>
                                <select data-ops-hook-sort data-ops-focus="hook-sort">
                                    <option value="target-desc" ${state.hookSort === 'target-desc' ? 'selected' : ''}>Highest selected estimate</option>
                                    <option value="target-asc" ${state.hookSort === 'target-asc' ? 'selected' : ''}>Lowest selected estimate</option>
                                    <option value="percentile-desc" ${state.hookSort === 'percentile-desc' ? 'selected' : ''}>Highest saved percentile</option>
                                    <option value="recent" ${state.hookSort === 'recent' ? 'selected' : ''}>Most recently saved</option>
                                    <option value="title" ${state.hookSort === 'title' ? 'selected' : ''}>Title A-Z</option>
                                </select>
                            </label>
                        </div>
                    </section>
                    ${renderHookDetail(detail)}
                    <div class="ops-hook-grid">
                        ${rows.slice(0, state.hookLimit).map(renderHookCard).join('') || '<div class="ops-empty">No hooks match the current search.</div>'}
                    </div>
                    ${rows.length > state.hookLimit ? `
                        <button type="button" class="ops-load-more" data-ops-more-hooks>
                            Show ${Math.min(36, rows.length - state.hookLimit)} more
                        </button>` : ''}
                </div>`;
        }

        function renderPending() {
            const progress = progressState();
            return `
                <section class="ops-panel ops-pending">
                    <div class="ops-pending-mark" aria-hidden="true"></div>
                    <div class="ops-eyebrow">Operations artifact pending</div>
                    <h3>${esc((state.status || {}).message || 'The complete outcome-blind corpus is still building.')}</h3>
                    <p>
                        Stage: ${esc(visibleStage(progress.stage))}.
                        Cached descriptions and embedding bundles survive worker restarts.
                    </p>
                    ${state.artifactError ? `<div class="ops-error-text">${esc(state.artifactError)}</div>` : ''}
                    <button type="button" class="ops-command-button" data-ops-refresh>Refresh status</button>
                </section>`;
        }

        function renderBody() {
            const status = state.status || {};
            const view = state.view;
            let content = '';
            if (!state.artifact) {
                content = renderPending();
            } else if (view === 'families') {
                content = renderFamiliesView();
            } else if (view === 'interactions') {
                content = renderInteractionsView();
            } else if (view === 'hooks') {
                content = renderHooksView();
            } else {
                content = renderOverview();
            }
            return `
                <div id="${ROOT_ID}" class="operations-lab" style="${rootStyle()}">
                    <header class="ops-header">
                        <div>
                            <div class="ops-eyebrow">Shorts Quant / Operations</div>
                            <h2>Opening Operations Atlas</h2>
                            <p>
                                Outcome-blind visual and language feature families, frozen semantic clusters,
                                and transparent surrogate reconstruction against existing keep estimates.
                            </p>
                        </div>
                        <div class="ops-header-meta">
                            <span>${esc(artifact().productVersion || status.productVersion || 'shorts-hook-operations-v1')}</span>
                            <b>${state.artifact ? `${formatCount(hooks().length)} hooks` : 'building'}</b>
                        </div>
                    </header>
                    ${warningBanner()}
                    ${renderProgress()}
                    ${state.statusError ? `<div class="ops-error-banner">Status unavailable: ${esc(state.statusError)}</div>` : ''}
                    ${state.artifactError && state.artifact ? `<div class="ops-error-banner">Latest artifact refresh failed: ${esc(state.artifactError)}</div>` : ''}
                    ${state.artifact ? renderControls() : ''}
                    <div class="ops-content">${content}</div>
                </div>`;
        }

        function openHook(id) {
            state.selectedHookId = String(id || '');
            state.selectedPointIndex = hookIndex(state.selectedHookId);
            state.view = 'hooks';
            paint();
        }

        function openFamily(key, clusterId) {
            state.familyKey = String(key || '');
            state.clusterId = clusterId == null ? null : Number(clusterId);
            state.view = 'families';
            normalizeSelection();
            paint();
        }

        function handleClick(event) {
            const target = event.target;
            const refresh = target.closest('[data-ops-refresh]');
            if (refresh) {
                state.loadedOnce = false;
                loadAll(true);
                return true;
            }
            const view = target.closest('[data-ops-view]');
            if (view) {
                state.view = view.dataset.opsView;
                paint();
                return true;
            }
            const targetButton = target.closest('[data-ops-target]');
            if (targetButton) {
                state.target = targetButton.dataset.opsTarget;
                interactionCache = null;
                paint();
                return true;
            }
            const point = target.closest('[data-ops-plane-point]');
            if (point) {
                const index = Number(point.dataset.opsPlanePoint);
                const hook = hooks()[index];
                state.selectedPointIndex = index;
                state.selectedHookId = hook ? String(hook.id) : '';
                paint();
                return true;
            }
            const family = target.closest('[data-ops-family]');
            if (family) {
                openFamily(family.dataset.opsFamily, family.dataset.opsCluster);
                return true;
            }
            const cluster = target.closest('[data-ops-cluster]');
            if (cluster) {
                state.clusterId = Number(cluster.dataset.opsCluster);
                paint();
                return true;
            }
            const hook = target.closest('[data-ops-open-hook]');
            if (hook) {
                openHook(hook.dataset.opsOpenHook);
                return true;
            }
            if (target.closest('[data-ops-close-hook]')) {
                state.selectedHookId = '';
                state.selectedPointIndex = null;
                paint();
                return true;
            }
            const interaction = target.closest('[data-ops-interaction]');
            if (interaction) {
                state.selectedInteractionKey = interaction.dataset.opsInteraction;
                paint();
                return true;
            }
            if (target.closest('[data-ops-close-interaction]')) {
                state.selectedInteractionKey = '';
                paint();
                return true;
            }
            if (target.closest('[data-ops-more-hooks]')) {
                state.hookLimit += 36;
                paint();
                return true;
            }
            if (target.closest('[data-ops-more-interactions]')) {
                state.interactionLimit += 100;
                paint();
                return true;
            }
            return false;
        }

        function handleInput(event) {
            const target = event.target;
            if (target.matches('[data-ops-threshold], [data-ops-threshold-number]')) {
                state.threshold = clampThreshold(target.value);
                interactionCache = null;
                schedulePaint(target.matches('[data-ops-threshold]') ? 45 : 90);
                return true;
            }
            if (target.matches('[data-ops-family-search]')) {
                state.familyQuery = target.value;
                schedulePaint();
                return true;
            }
            if (target.matches('[data-ops-interaction-search]')) {
                state.interactionQuery = target.value;
                state.interactionLimit = 100;
                schedulePaint();
                return true;
            }
            if (target.matches('[data-ops-hook-search]')) {
                state.hookQuery = target.value;
                state.hookLimit = 36;
                schedulePaint();
                return true;
            }
            return false;
        }

        function handleChange(event) {
            const target = event.target;
            if (target.matches('[data-ops-threshold], [data-ops-threshold-number]')) {
                state.threshold = clampThreshold(target.value);
                interactionCache = null;
                paint();
                return true;
            }
            if (target.matches('[data-ops-hook-sort]')) {
                state.hookSort = target.value;
                state.hookLimit = 36;
                paint();
                return true;
            }
            if (target.matches('[data-ops-interaction-sort]')) {
                state.interactionSort = target.value;
                state.interactionLimit = 100;
                paint();
                return true;
            }
            return false;
        }

        function handleKeyDown(event) {
            if (!['Enter', ' '].includes(event.key)) return false;
            const target = event.target.closest('[data-ops-plane-point], [data-ops-interaction]');
            if (!target) return false;
            event.preventDefault();
            target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return true;
        }

        function handleMediaError(event) {
            const image = event.target;
            if (!image || !image.matches || !image.matches('img[data-ops-montage]')) return;
            const attempts = Number(image.dataset.opsRetry || 0);
            if (attempts < 1) {
                image.dataset.opsRetry = String(attempts + 1);
                const source = String(image.currentSrc || image.src || '');
                const separator = source.includes('?') ? '&' : '?';
                window.setTimeout(() => {
                    if (image.isConnected) image.src = `${source}${separator}opsRetry=${Date.now()}`;
                }, 500);
                return;
            }
            const fallback = document.createElement('span');
            fallback.className = 'ops-image-failure';
            fallback.setAttribute('role', 'status');
            fallback.textContent = 'Image failed to load';
            image.replaceWith(fallback);
        }

        function render() {
            ensureStylesheet();
            return renderBody();
        }

        function afterRender() {
            ensureStylesheet();
            host = document.getElementById(ROOT_ID);
            normalizeSelection();
            loadAll(false);
        }

        if (typeof document !== 'undefined' && !document.__jarvisOperationsMediaErrorBound) {
            document.__jarvisOperationsMediaErrorBound = true;
            document.addEventListener('error', handleMediaError, true);
        }

        return {
            render,
            afterRender,
            handleClick,
            handleInput,
            handleChange,
            handleKeyDown,
        };
    }

    window.JarvisOperationsLab = Object.freeze({ create });
}());
