(function () {
    'use strict';

    window.createLongQuantPromiseLab = function createLongQuantPromiseLab(deps) {
        const C = deps.colors;
        const esc = deps.escape;
        const projectionMethodKey = 'promiseLab.savedProjectionMethod';
        const pendingHookScoreKey = 'promiseLab.pendingHookScore';
        let savedProjectionMethod = 'maxmin';
        try { savedProjectionMethod = window.localStorage.getItem(projectionMethodKey) || 'maxmin'; } catch (_) { /* Storage is optional. */ }
        const state = {
            view: 'overview', data: {}, loading: {}, errors: {},
            hookId: null, hook: null, componentId: null, representation: 'influence',
            mapIndex: 0, mapPage: 0, metric: 'ctrviews', sourceId: null, source: null,
            axisIndex: 0, pendingAxisTarget: null, registryPage: 0, hookQuery: '', registryQuery: '', registryStage: 'all',
            atlasScope: 'supported', focusedCluster: null, projectionMethod: savedProjectionMethod,
            savedPointIndex: null,
            clusterOutcomeCluster: 2, clusterOutcomeFamily: 'performance',
            clusterOutcomeTarget: null, clusterOutcomeDetail: null,
            clusterOutcomePointIndex: null, clusterOutcomeLoading: false,
            clusterOutcomeError: null,
            latencyCluster: 2, latencyWindow: 'phrase', latencySelectedLagIndex: null,
            latencyTrainLagIndex: 6, latencyResponseLagIndex: 8,
            latencyPointGlobalIndex: null, latencyDetail: null,
            latencyDetailLoading: false, latencyDetailError: null,
            hookScoreText: '', hookScoreResult: null, hookScoreLoading: false,
            hookScoreIdea: '',
            hookScoreError: null, hookScoreStatus: null, hookScoreJobId: null,
            hookQualityPointIndex: null, forwardResponseComponentIndex: null,
            hookLibraryQuery: '', hookLibraryMetric: 'market', hookLibrarySelectedId: null,
            outcomePointVideoId: null, outcomeComponentPointKey: null,
            retentionCurveMode: 'entry',
            forecastWordIndex: 0,
            latticeVideoId: null, latticeDetail: null, latticeLoading: false,
            latticeError: null, latticeNodeId: null, latticeRepresentation: 'raw',
            latticeResolution: 'all', latticeEdgeType: 'semantic', latticeQuery: '', latticeCorpusQuery: '',
        };
        let progressTimer = null;
        let resizeTimer = null;
        let resizeBound = false;
        let hookRequest = 0;
        let sourceRequest = 0;
        let clusterOutcomeRequest = 0;
        let latencyDetailRequest = 0;
        let hookScoreRequest = 0;
        let latticeRequest = 0;
        let hookScoreResumeChecked = false;

        const api = name => `/api/longquant/promise-lab/${name}`;
        const fmt = (value, digits = 2) => value == null || !isFinite(value) ? '-' : Number(value).toFixed(digits);
        const pct = value => value == null || !isFinite(value) ? '-' : `${Number(value).toFixed(1)}%`;
        const signed = (value, digits = 2) => value == null || !isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${Number(value).toFixed(digits)}`;
        const numeric = value => value == null || value === '' ? NaN : Number(value);
        const metricLabel = name => ({
            ctrviews: 'CTR + views', ctr: 'CTR', ret30: '30-second retention',
            views: 'views', scaled_views: 'scaled views', realviews: 'realistic views',
            gt10m: '10M-view class',
        })[name] || name;
        const outcomePalette = {
            low: 'rgb(56,189,248)', middle: 'rgb(152,151,181)', high: 'rgb(248,113,113)',
        };
        const outcomeFamilyDefinition = family => ({
            performance: {
                label: 'Video-level outcome',
                summary: 'One outcome belongs to the source video. Every span from that video inherits it; the axis tests whether wording inside this frozen cluster aligns with a higher outcome after surface, timing, and hook-context confounds are removed.',
                direction: 'Blue is a lower outcome and red is a higher outcome. This is a continuous metric color, not a cluster label.',
            },
            'raw-slope': {
                label: 'Raw retention slope',
                summary: 'A least-squares line is fitted to the observed audience-retention curve across the exact spoken phrase interval, shifted forward by the selected processing lag.',
                direction: 'Blue is a more negative slope, meaning faster viewer loss. Red is a higher slope, meaning flatter loss or a rise. Zero means flat retention.',
            },
            'normalized-slope': {
                label: 'Endpoint-conditioned retention slope',
                summary: 'A retrospective sensitivity view maps entry to 1 and full-video terminal retention to 0. It uses future information and is not the primary training target.',
                direction: 'Blue is a steeper endpoint-conditioned loss. Red is flatter or rising. Zero means flat after the retrospective transform.',
            },
            'residual-slope': {
                label: 'Unexpected retention slope',
                summary: 'The declared phrase slope minus a source-held-out text-free expectation. Legacy latency maps use endpoint-conditioned inputs; the current component axis uses entry-indexed retention and a category-blind past-only baseline.',
                direction: 'Blue is worse than the declared natural-drop baseline. Red is better than predicted. Zero means exactly the out-of-fold expectation.',
            },
        })[family] || { label: family || 'Outcome', summary: '', direction: 'Blue is the lower value and red is the higher value.' };
        const formatCompactNumber = value => {
            if (!Number.isFinite(Number(value))) return '-';
            const absolute = Math.abs(Number(value));
            if (absolute >= 1e9) return `${fmt(Number(value) / 1e9, 2)}B`;
            if (absolute >= 1e6) return `${fmt(Number(value) / 1e6, 2)}M`;
            if (absolute >= 1e3) return `${fmt(Number(value) / 1e3, 1)}K`;
            return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
        };
        const hookOutcomeOrder = ['viewed_percent', 'retention_5s', 'average_retention', 'log_views'];
        function formatHookOutcomeValue(value, target, compact = false) {
            value = numeric(value);
            if (!Number.isFinite(value)) return '-';
            if (target === 'log_views') return compact ? formatCompactNumber(10 ** value) : `${formatCompactNumber(10 ** value)} views`;
            return `${fmt(value, compact ? 1 : 2)}%`;
        }
        function formatHookOutcomeEffect(value, target) {
            value = numeric(value);
            if (!Number.isFinite(value)) return '-';
            if (target === 'log_views') {
                const factor = 10 ** Math.abs(value);
                return `${signed(value, 2)} log10 (${value >= 0 ? '×' : '÷'}${fmt(factor, 2)})`;
            }
            return `${signed(value, 2)} pp`;
        }
        function validationLabel(validation) {
            const status = String((validation || {}).status || 'diagnostic-not-validated');
            return status.startsWith('validated') ? 'VALIDATED' : 'DIAGNOSTIC';
        }
        function validationColor(validation) {
            return String((validation || {}).status || '').startsWith('validated') ? C.green : C.amber;
        }
        function supportedEvidence(validation) {
            const status = String((validation || {}).status || '');
            return status.startsWith('validated')
                || (status.includes('supported') && !status.includes('not-supported'));
        }
        function legacyAxisClaim(experiment) {
            if (!axisRandomFoldSupported(experiment)) return 'NOT SUPPORTED';
            return experiment.targetChannel === 'observed YouTube outcome'
                ? 'RANDOM-FOLD DIAGNOSTIC'
                : 'SOURCE-GROUPED SUPPORTED';
        }
        function axisRandomFoldSupported(experiment) {
            return [
                'validated',
                'multiplicity-controlled-random-fold-association',
                'source-grouped-observed-diagnostic',
                'source-grouped-model-transfer-supported',
                'source-grouped-supported',
            ].includes(String((experiment || {}).status || ''));
        }
        function selectedLibraryHook() {
            const hooks = ((state.data.hookOutcomes || {}).hooks || []);
            return hooks.find(row => String(row.videoId) === String(state.hookLibrarySelectedId)) || null;
        }
        function formatOutcomeValue(value, target, meta, compact = false) {
            value = numeric(value);
            if (!Number.isFinite(value)) return 'not measured';
            if (target === 'views_raw' || target === 'realistic_views') {
                return compact ? formatCompactNumber(value) : `${Math.round(value).toLocaleString()} ${meta.unit || 'views'}`;
            }
            if (target === 'views_log') {
                const raw = 10 ** value;
                return compact ? fmt(value, 2) : `${fmt(value, 3)} log10 views (about ${formatCompactNumber(raw)} views)`;
            }
            if (target === 'class_10m') return value >= .5 ? '1 (10M+ views)' : '0 (under 10M views)';
            if (target === 'swipe_ratio') return `${fmt(value, compact ? 1 : 2)}% viewed`;
            if (target === 'retention_5s') return compact ? `${fmt(value * 100, 1)}%` : `${fmt(value * 100, 2)}% retained (${fmt(value, 4)} ratio)`;
            if (meta.family === 'raw-slope') {
                return compact ? `${signed(value * 100, 2)} pp/s` : `${signed(value * 100, 3)} retention percentage points/second (${signed(value, 5)} ratio/second)`;
            }
            if (meta.family === 'normalized-slope' || meta.family === 'residual-slope') {
                return compact ? `${signed(value, 4)}/s` : `${signed(value, 5)} normalized retention units/second`;
            }
            return `${signed(value, compact ? 2 : 4)}${meta.unit ? ` ${meta.unit}` : ''}`;
        }
        function outcomeScale(detail) {
            const values = (((detail || {}).points || {}).target || []).map(numeric);
            const finite = values.filter(Number.isFinite);
            const [low, high] = bounds(finite);
            const middle = (low + high) / 2;
            return {
                values, low, middle, high,
                measured: finite.length,
                missing: values.length - finite.length,
                color(value) {
                    if (!Number.isFinite(Number(value))) return C.faint;
                    const t = Math.max(0, Math.min(1, (Number(value) - low) / ((high - low) || 1)));
                    return `rgb(${Math.round(56 + 192 * t)},${Math.round(189 - 76 * t)},${Math.round(248 - 135 * t)})`;
                },
            };
        }
        function outcomeMetricLegend(detail) {
            const meta = detail.targetMeta || {}, family = outcomeFamilyDefinition(meta.family);
            const scale = outcomeScale(detail), target = detail.target || '';
            const offset = Number(meta.offsetSeconds || 0);
            const window = meta.family === 'performance'
                ? 'Video-level value; no phrase-time window is used.'
                : `For every span spoken from start to end, measure start + ${offset}s through end + ${offset}s.`;
            const zeroPosition = scale.low < 0 && scale.high > 0
                ? Math.max(0, Math.min(100, (0 - scale.low) / ((scale.high - scale.low) || 1) * 100))
                : null;
            return `<div data-pl-outcome-metric-contract style="background:${C.card2};border:1px solid ${C.border2};padding:10px;margin:9px 0 10px">
                <div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap"><div style="min-width:260px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Selected point-color metric</div><div style="font-size:13px;color:${C.text};font-weight:900;margin-top:2px">Color = ${esc(meta.label || target)}</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:3px">${esc(family.summary)}</div></div><div style="min-width:230px;font-size:8.5px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Data source:</b> ${esc(meta.channel || 'not declared')}<br><b style="color:${C.text}">Unit:</b> ${esc(meta.unit || 'not declared')}<br><b style="color:${C.text}">Window:</b> ${esc(window)}<br><b style="color:${C.text}">Metric key:</b> <span style="font-family:monospace">${esc(target)}</span></div></div>
                <div style="margin-top:9px"><div role="img" aria-label="Blue is the low ${esc(meta.label || target)} value and red is the high value" style="height:10px;border:1px solid ${C.border};background:linear-gradient(90deg,${outcomePalette.low},${outcomePalette.middle},${outcomePalette.high});position:relative">${zeroPosition == null ? '' : `<span title="zero" style="position:absolute;left:${zeroPosition}%;top:-3px;width:1px;height:16px;background:${C.text}"></span>`}</div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:3px;font-size:8px"><div style="color:${outcomePalette.low}"><b>BLUE · LOW</b><br>${esc(formatOutcomeValue(scale.low, target, meta, true))}</div><div style="color:${C.dim};text-align:center"><b>COLOR MIDPOINT</b><br>${esc(formatOutcomeValue(scale.middle, target, meta, true))}</div><div style="color:${outcomePalette.high};text-align:right"><b>RED · HIGH</b><br>${esc(formatOutcomeValue(scale.high, target, meta, true))}</div></div></div>
                <div style="font-size:8.5px;color:${C.text};line-height:1.55;margin-top:7px"><b>${esc(family.direction)}</b> The color range uses the measured 1st-to-99th percentiles (${esc(formatOutcomeValue(scale.low, target, meta, true))} to ${esc(formatOutcomeValue(scale.high, target, meta, true))}); values beyond them saturate. ${scale.missing ? `${scale.missing.toLocaleString()} ${scale.missing === 1 ? 'span' : 'spans'} without this measurement ${scale.missing === 1 ? 'is' : 'are'} gray.` : 'Every displayed span has this measurement.'}</div>
                <div class="pl-metric-channels" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px;font-size:8.5px;line-height:1.5"><div style="border-left:2px solid ${outcomePalette.high};padding-left:7px"><b style="color:${C.text}">COLOR</b><br><span style="color:${C.dim}">Observed/model target before confound removal. It does not show cluster membership.</span></div><div style="border-left:2px solid ${C.cyan};padding-left:7px"><b style="color:${C.text}">LEFT → RIGHT</b><br><span style="color:${C.dim}">Learned semantic score. Moving right predicts a higher confound-adjusted target.</span></div><div style="border-left:2px solid ${C.faint};padding-left:7px"><b style="color:${C.text}">DOWN → UP</b><br><span style="color:${C.dim}">Orthogonal semantic background coordinate. It is not an outcome metric.</span></div></div>
                <div style="font-size:8px;color:${C.mute};margin-top:7px">Population shown: frozen cluster ${Number(detail.cluster)} only. Cluster identity is fixed before outcomes are joined; blue and red are values within that one cluster.</div>
            </div>`;
        }
        const representationLabel = name => ({
            raw: 'raw source span', influence: 'deletion influence',
            nonadditive: 'non-additive source span', context: 'retained hook context',
        })[name] || name;
        const clusterColor = label => `hsl(${(Number(label || 0) * 137.508) % 360} 72% 62%)`;
        const card = (body, extra = '') => `<section style="background:${C.card};border:1px solid ${C.border};border-radius:8px;padding:12px;${extra}">${body}</section>`;
        const stat = (label, value, color = C.text) => `<div style="min-width:112px;border-left:2px solid ${color};padding:3px 9px"><div style="font-size:9px;color:${C.mute};text-transform:uppercase">${esc(label)}</div><div style="font-size:17px;font-weight:900;color:${color}">${esc(String(value))}</div></div>`;
        const button = (label, attr, active = false) => `<button ${attr} style="border:1px solid ${active ? C.cyan : C.border};background:${active ? C.cyan + '1c' : C.card2};color:${active ? C.cyan : C.dim};border-radius:6px;padding:5px 9px;font-size:10px;font-weight:800;cursor:pointer">${esc(label)}</button>`;
        const statusColor = status => status === 'complete' || String(status || '').startsWith('validated') || status === 'supported' ? C.green : status === 'error' ? C.red : C.amber;
        const activeAtlas = () => state.atlasScope === 'all' ? state.data.allSpanAtlas : state.data.atlas;
        const atlasRows = atlas => (atlas && (atlas.spans || atlas.candidates)) || [];
        const atlasCount = atlas => Number((atlas && (atlas.spanInstances || atlas.candidateInstances)) || atlasRows(atlas).length || 0);

        async function load(name, url, force) {
            if (!force && (state.data[name] || state.loading[name])) return state.data[name];
            state.loading[name] = true;
            delete state.errors[name];
            paint();
            try {
                const response = await fetch(url || api(name), { cache: force ? 'reload' : 'default' });
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                state.data[name] = await response.json();
                return state.data[name];
            } catch (error) {
                state.errors[name] = String(error && error.message || error);
                return null;
            } finally {
                state.loading[name] = false;
                paint();
            }
        }

        function readPendingHookScore() {
            try {
                const value = JSON.parse(window.localStorage.getItem(pendingHookScoreKey) || 'null');
                const valid = value && /^j[a-z0-9]+$/.test(String(value.jobId || ''))
                    && String(value.text || '').length >= 8
                    && Date.now() - Number(value.submittedAt || 0) < 30 * 60 * 1000;
                if (valid) return value;
                window.localStorage.removeItem(pendingHookScoreKey);
            } catch (_) { /* Storage is optional. */ }
            return null;
        }

        function savePendingHookScore(jobId, text, idea) {
            try {
                window.localStorage.setItem(pendingHookScoreKey, JSON.stringify({
                    jobId, text, idea: idea || '', submittedAt: Date.now(),
                }));
            } catch (_) { /* Storage is optional. */ }
        }

        function clearPendingHookScore(jobId) {
            try {
                const current = JSON.parse(window.localStorage.getItem(pendingHookScoreKey) || 'null');
                if (!jobId || !current || current.jobId === jobId) {
                    window.localStorage.removeItem(pendingHookScoreKey);
                }
            } catch (_) { /* Storage is optional. */ }
        }

        async function settleHookScore(request, operation) {
            try {
                const value = await operation;
                if (request === hookScoreRequest) {
                    state.hookScoreResult = value;
                    state.forecastWordIndex = 0;
                }
            } catch (error) {
                if (request === hookScoreRequest) {
                    state.hookScoreResult = null;
                    state.hookScoreError = String(error && error.message || error);
                }
            } finally {
                if (request === hookScoreRequest) {
                    state.hookScoreLoading = false;
                    state.hookScoreStatus = null;
                    paint();
                }
            }
        }

        async function scoreHookText(text) {
            text = String(text == null ? state.hookScoreText : text).replace(/\s+/g, ' ').trim();
            const idea = String(state.hookScoreIdea || '').replace(/\s+/g, ' ').trim();
            if (state.hookScoreLoading) return;
            if (text.length < 8) {
                state.hookScoreResult = null;
                state.hookScoreError = 'Type a complete hook to score.';
                paint();
                return;
            }
            const pending = readPendingHookScore();
            if (pending && (pending.text !== text || String(pending.idea || '') !== idea)) clearPendingHookScore(pending.jobId);
            const request = ++hookScoreRequest;
            state.hookScoreText = text;
            state.hookScoreLoading = true;
            state.hookScoreError = null;
            state.hookScoreStatus = pending && pending.text === text && String(pending.idea || '') === idea
                ? 'Reattaching to the saved scoring job'
                : 'Submitting to the interactive scoring lane';
            state.hookScoreResult = null;
            paint();
            const operation = pending && pending.text === text && String(pending.idea || '') === idea
                ? pollHookScoreJob(pending.jobId, text, idea, request, 0)
                : submitHookScoreJob(text, idea, request, 0);
            if (pending && pending.text === text && String(pending.idea || '') === idea) state.hookScoreJobId = pending.jobId;
            await settleHookScore(request, operation);
        }

        async function jsonResponse(response, allowErrorRecord = false) {
            const value = await response.json().catch(() => ({}));
            if (!response.ok || (!allowErrorRecord && value.error)) {
                throw new Error(value.error || `${response.status} ${response.statusText}`);
            }
            return value;
        }

        async function submitHookScoreJob(text, idea, request, resubmits) {
            const submitted = await jsonResponse(await fetch(api('hook-score'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, idea, async: true }), cache: 'no-store',
            }));
            if (!submitted.jobId) return submitted;
            state.hookScoreJobId = submitted.jobId;
            savePendingHookScore(submitted.jobId, text, idea);
            if (request === hookScoreRequest) {
                state.hookScoreStatus = 'Queued with interactive priority';
                paint();
            }
            return pollHookScoreJob(submitted.jobId, text, idea, request, resubmits);
        }

        async function pollHookScoreJob(jobId, text, idea, request, resubmits) {
            for (let attempt = 0; attempt < 180; attempt++) {
                if (attempt) {
                    await new Promise(resolve => window.setTimeout(
                        resolve, attempt < 8 ? 2500 : 5000,
                    ));
                }
                if (request !== hookScoreRequest) throw new Error('score superseded');
                let job;
                try {
                    job = await jsonResponse(await fetch(
                        `/api/longquant/jobs/${encodeURIComponent(jobId)}`,
                        { cache: 'no-store' },
                    ), true);
                } catch (error) {
                    if (/job lost|resubmit/i.test(String(error && error.message || error)) && resubmits < 2) {
                        clearPendingHookScore(jobId);
                        state.hookScoreJobId = null;
                        state.hookScoreStatus = `Server restarted; resubmitting (${resubmits + 1}/2)`;
                        paint();
                        return submitHookScoreJob(text, idea, request, resubmits + 1);
                    }
                    throw error;
                }
                if (job.status === 'done') {
                    clearPendingHookScore(jobId);
                    state.hookScoreJobId = null;
                    return job.result;
                }
                if (job.status === 'error') {
                    clearPendingHookScore(jobId);
                    state.hookScoreJobId = null;
                    throw new Error(job.error || 'hook scoring failed');
                }
                if (request === hookScoreRequest) {
                    const next = job.status === 'queued'
                        ? 'Queued with interactive priority'
                        : 'Embedding every span, applying frozen boundaries, and scoring local deletions';
                    if (state.hookScoreStatus !== next) {
                        state.hookScoreStatus = next;
                        paint();
                    }
                }
            }
            throw new Error('Hook scoring is still running after 15 minutes. Retry to reattach.');
        }

        function resumePendingHookScore() {
            if (hookScoreResumeChecked) return;
            hookScoreResumeChecked = true;
            const pending = readPendingHookScore();
            if (!pending) return;
            const request = ++hookScoreRequest;
            state.hookScoreText = pending.text;
            state.hookScoreIdea = pending.idea || '';
            state.hookScoreJobId = pending.jobId;
            state.hookScoreLoading = true;
            state.hookScoreResult = null;
            state.hookScoreError = null;
            state.hookScoreStatus = 'Reattaching to the saved scoring job';
            paint();
            settleHookScore(
                request,
                pollHookScoreJob(pending.jobId, pending.text, pending.idea || '', request, 0),
            );
        }

        async function loadLatticeDetail(videoId) {
            const request = ++latticeRequest;
            state.latticeVideoId = videoId;
            state.latticeDetail = null;
            state.latticeError = null;
            state.latticeLoading = true;
            state.latticeNodeId = null;
            paint();
            try {
                const response = await fetch(`${api('component-lattice')}/${encodeURIComponent(videoId)}`, { cache: 'default' });
                const value = await jsonResponse(response);
                if (request === latticeRequest) state.latticeDetail = value;
            } catch (error) {
                if (request === latticeRequest) state.latticeError = String(error && error.message || error);
            } finally {
                if (request === latticeRequest) { state.latticeLoading = false; paint(); }
            }
        }

        async function loadHook(videoId) {
            const request = ++hookRequest;
            state.hookId = videoId;
            state.hook = null;
            paint();
            try {
                const response = await fetch(`${api('hook')}/${encodeURIComponent(videoId)}`, { cache: 'no-cache' });
                const value = response.ok ? await response.json() : { error: `${response.status} ${response.statusText}` };
                if (request === hookRequest) state.hook = value;
            } catch (error) {
                if (request === hookRequest) state.hook = { error: String(error && error.message || error) };
            }
            if (request === hookRequest) paint();
        }

        async function loadSource(sourceId) {
            const request = ++sourceRequest;
            state.sourceId = sourceId;
            state.source = null;
            paint();
            try {
                const response = await fetch(`${api('swap-source')}/${encodeURIComponent(sourceId)}`, { cache: 'no-cache' });
                const value = response.ok ? await response.json() : { error: `${response.status} ${response.statusText}` };
                if (request === sourceRequest) state.source = value;
            } catch (error) {
                if (request === sourceRequest) state.source = { error: String(error && error.message || error) };
            }
            if (request === sourceRequest) paint();
        }

        async function loadClusterOutcomeDetail(cluster, target) {
            const request = ++clusterOutcomeRequest;
            const key = `${cluster}/${target}`;
            const cache = state.data.clusterOutcomeDetails || (state.data.clusterOutcomeDetails = {});
            state.clusterOutcomeCluster = Number(cluster);
            state.clusterOutcomeTarget = target;
            state.clusterOutcomePointIndex = null;
            state.clusterOutcomeError = null;
            if (cache[key]) {
                state.clusterOutcomeDetail = cache[key];
                state.clusterOutcomeLoading = false;
                paint();
                return;
            }
            state.clusterOutcomeDetail = null;
            state.clusterOutcomeLoading = true;
            paint();
            try {
                const response = await fetch(
                    `${api('cluster-outcome')}/${encodeURIComponent(cluster)}/${encodeURIComponent(target)}`,
                    { cache: 'default' },
                );
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const value = await response.json();
                cache[key] = value;
                if (request === clusterOutcomeRequest) state.clusterOutcomeDetail = value;
            } catch (error) {
                if (request === clusterOutcomeRequest) state.clusterOutcomeError = String(error && error.message || error);
            } finally {
                if (request === clusterOutcomeRequest) {
                    state.clusterOutcomeLoading = false;
                    paint();
                }
            }
        }

        async function loadLatencyDetail(cluster) {
            const request = ++latencyDetailRequest;
            const key = String(cluster);
            const cache = state.data.latencyDetails || (state.data.latencyDetails = {});
            state.latencyCluster = Number(cluster);
            state.latencyDetailError = null;
            if (cache[key]) {
                state.latencyDetail = cache[key];
                state.latencyDetailLoading = false;
                paint();
                return;
            }
            state.latencyDetail = null;
            state.latencyDetailLoading = true;
            paint();
            try {
                const response = await fetch(`${api('latency-study')}/${encodeURIComponent(cluster)}`, { cache: 'default' });
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const value = await response.json();
                cache[key] = value;
                if (request === latencyDetailRequest) state.latencyDetail = value;
            } catch (error) {
                if (request === latencyDetailRequest) state.latencyDetailError = String(error && error.message || error);
            } finally {
                if (request === latencyDetailRequest) {
                    state.latencyDetailLoading = false;
                    paint();
                }
            }
        }

        function initializeClusterOutcome(summary) {
            if (!summary || state.clusterOutcomeTarget) return;
            const clusters = summary.clusters || [];
            const cluster = clusters.find(row => Number(row.label) === Number(state.clusterOutcomeCluster)) || clusters[0];
            if (!cluster) return;
            state.clusterOutcomeCluster = Number(cluster.label);
            const preferred = (summary.topIndicators || []).find(
                row => Number(row.cluster) === state.clusterOutcomeCluster
            );
            const selected = preferred || (cluster.targets || [])[0];
            if (!selected) return;
            state.clusterOutcomeTarget = selected.target;
            state.clusterOutcomeFamily = ((summary.targetDefinitions || {})[selected.target] || {}).family || 'performance';
            loadClusterOutcomeDetail(state.clusterOutcomeCluster, state.clusterOutcomeTarget);
        }

        async function pollProgress() {
            try {
                const response = await fetch(`${api('progress')}?t=${Date.now()}`, { cache: 'no-store' });
                if (!response.ok) return;
                state.data.progress = await response.json();
                const status = document.querySelector('#pl-root [data-pl-live-status]');
                if (status) {
                    status.textContent = state.data.progress.stage || state.data.progress.status || '';
                    status.style.color = statusColor(state.data.progress.status);
                }
                const host = document.querySelector('#pl-root [data-pl-progress-host]');
                if (host) host.innerHTML = progressStrip();
            } catch (_) {
                // Keep the last confirmed status visible; a transient poll must not disturb analysis.
            }
        }

        function ensureView() {
            load('manifest');
            load('progress');
            if (state.view === 'scorer') {
                load('hookQuality', api('hook-quality'));
                load('hookOutcomes', api('hook-outcomes'));
                load('marketReward', api('market-reward'));
                load('canonicalPartitions', api('canonical-partitions'));
                load('hookExamples', api('hook-example-results'));
                load('componentLattice', api('component-lattice'));
                resumePendingHookScore();
            }
            if (state.view === 'library') {
                load('hookQuality', api('hook-quality'));
                load('hookOutcomes', api('hook-outcomes'));
                load('marketReward', api('market-reward'));
                load('canonicalPartitions', api('canonical-partitions'));
                load('componentLattice', api('component-lattice'));
            }
            if (state.view === 'lattice') load('componentLattice', api('component-lattice'));
            if (state.view === 'contract') load('researchContract', api('research-contract'));
            if (state.view === 'overview') { load('findings'); load('manualProbe', api('manual-probe')); }
            if (state.view === 'saved') {
                load('manualProbe', api('manual-probe'));
                load('manualProjection', api('manual-projection'));
                load('clusterOutcomes', api('cluster-outcomes')).then(initializeClusterOutcome);
                load('latencyStudy', api('latency-study'));
            }
            if (state.view === 'hooks' || state.view === 'boundaries') load('discovery');
            if (state.view === 'components' || state.view === 'clusters') {
                if (state.atlasScope === 'all') load('allSpanAtlas', api('all-span-atlas'));
                else load('atlas');
                if (state.view === 'clusters') {
                    load('manualProbe', api('manual-probe'));
                    load('manualProjection', api('manual-projection'));
                }
            }
            if (state.view === 'swaps') load('swaps');
            if (state.view === 'axes') { load('axes'); load('findings'); }
            if (state.view === 'registry') load('registry');
        }

        function loading(name) {
            const label = ({ allSpanAtlas: 'all-span atlas' })[name] || name;
            if (state.errors[name]) return card(`<div style="color:${C.red};font-size:11px">${esc(state.errors[name])}</div>`);
            return card(`<div style="color:${C.cyan};font-size:11px">Loading real ${esc(label)} artifact...</div>`);
        }

        function header() {
            const manifest = state.data.manifest || {};
            const progress = state.data.progress || {};
            const views = [
                ['overview', 'Results'], ['scorer', 'Hook scorer'], ['library', 'Hook library'], ['lattice', 'Component lattice'], ['contract', 'Research contract'], ['hooks', 'Hooks'], ['boundaries', 'Boundaries'],
                ['components', 'Embeddings'], ['clusters', 'Cluster atlas'], ['saved', 'Saved embedding'], ['swaps', 'Swaps'],
                ['axes', 'Outcome axes'], ['registry', 'Registry'],
            ];
            return `<div style="display:flex;align-items:flex-start;gap:12px;justify-content:space-between;margin-bottom:11px;flex-wrap:wrap">
                <div><div style="font-size:17px;font-weight:900;color:${C.text}">Promise Lab</div>
                <div style="font-size:10px;color:${C.mute};line-height:1.5">First-principles semantic discovery in the exact Long Quant text space. Examples are never labels.</div></div>
                <div style="display:flex;gap:7px;align-items:center"><span data-pl-live-status style="font-size:10px;color:${statusColor(progress.status || manifest.status)};font-weight:800">${esc(progress.stage || manifest.status || 'loading')}</span>${button('Refresh', 'data-pl-refresh')}</div>
            </div><div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:12px">${views.map(([id, label]) => button(label, `data-pl-view="${id}"`, state.view === id)).join('')}</div>`;
        }

        function progressStrip() {
            const progress = state.data.progress || {};
            if (!progress.status || progress.status === 'complete') return '';
            let done = Number(progress.hooksComplete || 0), total = Number(progress.hooksTotal || 0), unit = 'hooks';
            if (progress.configurationsTotal) { done = Number(progress.configurationsComplete || 0); total = Number(progress.configurationsTotal); unit = 'atlas configurations'; }
            else if (progress.axisGroupsTotal) { done = Number(progress.axisGroupsComplete || 0); total = Number(progress.axisGroupsTotal); unit = 'axis groups'; }
            else if (progress.routingSourcesTotal) { done = Number(progress.routingSourcesComplete || 0); total = Number(progress.routingSourcesTotal); unit = 'routed source components'; }
            else if (progress.routingMapsTotal) { done = Number(progress.routingMapsComplete || 0); total = Number(progress.routingMapsTotal); unit = 'consensus maps'; }
            else if (progress.changedTextsTotal) { done = Number(progress.changedTextsScored || 0); total = Number(progress.changedTextsTotal); unit = 'corrected exact texts'; }
            else if (progress.uniqueTextsTotal) { done = Number(progress.uniqueTextsScored || 0); total = Number(progress.uniqueTextsTotal); unit = 'unique recomposed texts'; }
            else if (progress.sourceDetailsTotal) { done = Number(progress.sourceDetailsPublished || progress.sourceDetailsBuilt || 0); total = Number(progress.sourceDetailsTotal); unit = progress.sourceDetailsPublished != null ? 'source surfaces published' : 'source surfaces built'; }
            else if (progress.swapRows) { done = Number(progress.swapRowsScored || 0); total = Number(progress.swapRows); unit = 'swap rows'; }
            const width = total ? Math.min(100, done / total * 100) : 0;
            return `<div style="border:1px solid ${C.border};background:${C.card2};padding:8px 10px;border-radius:7px;margin-bottom:10px">
                <div style="display:flex;justify-content:space-between;font-size:9px;color:${C.dim};margin-bottom:5px"><span>${esc(progress.stage || 'building')}</span><span>${done.toLocaleString()}${total ? ` / ${total.toLocaleString()} ${unit}` : ''}</span></div>
                <div style="height:5px;background:${C.border};overflow:hidden"><div style="height:100%;width:${width}%;background:${C.cyan}"></div></div>
                <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:5px;font-size:9px;color:${C.mute}"><span>${Number(progress.embeddingCacheVectors || 0).toLocaleString()} transient vectors</span><span>${Number(progress.spansMaterialized || progress.spanInstances || progress.candidateInstances || 0).toLocaleString()} spans/candidates</span><span>${Number(progress.tokenPairsMaterialized || 0).toLocaleString()} token pairs</span><span>${Number(progress.experimentsComplete || 0).toLocaleString()} experiments complete</span></div>
            </div>`;
        }

        async function openManualProbe() {
            const probe = state.data.manualProbe || await load('manualProbe', api('manual-probe'));
            if (!probe || !probe.winner) return;
            const winner = probe.winner;
            state.view = 'clusters';
            state.atlasScope = winner.scope === 'all-contiguous-spans' ? 'all' : 'supported';
            state.componentId = null;
            const atlas = state.atlasScope === 'all'
                ? (state.data.allSpanAtlas || await load('allSpanAtlas', api('all-span-atlas')))
                : (state.data.atlas || await load('atlas'));
            if (!atlas) return;
            const found = (atlas.maps || []).findIndex(row => row.id === winner.mapId);
            state.mapIndex = found >= 0 ? found : Number(winner.mapIndex || 0);
            state.mapPage = Math.floor(state.mapIndex / 24);
            state.focusedCluster = Number(winner.cluster);
            state.representation = winner.representation || state.representation;
            load('manualProjection', api('manual-projection'));
            paint();
        }

        function manualProbeSummary() {
            const probe = state.data.manualProbe;
            if (!probe || !probe.winner) return '';
            const winner = probe.winner, counts = probe.counts || {}, bootstrap = winner.bootstrap || {};
            const active = state.view === 'clusters'
                && ((state.atlasScope === 'all') === (winner.scope === 'all-contiguous-spans'))
                && ((activeAtlas() || {}).maps || [])[state.mapIndex]?.id === winner.mapId
                && state.focusedCluster === Number(winner.cluster);
            return card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
                <div style="min-width:250px;flex:1"><div style="font-size:9px;color:${C.amber};font-weight:900;text-transform:uppercase">Manual post-hoc overfit probe</div><div style="font-size:14px;color:${C.text};font-weight:900;margin-top:3px">Closest existing category: cluster ${winner.cluster}</div><div style="font-size:9px;color:${C.dim};margin-top:3px">${esc(winner.representation)} · ${esc(winner.geometry)} · ${winner.pcaDimensions}D · k=${winner.clusterCount} · map ${esc(String(winner.mapId || '').slice(0, 10))}</div><div style="font-size:9px;color:${C.mute};line-height:1.5;margin-top:6px">Yes: this is the strongest of ${Number(counts.frozenMapsCompared || 0).toLocaleString()} frozen map/cluster comparisons under the declared information-contribution measure. It is a descriptive overfit, not a discovered semantic name or scientific validation.</div></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">${stat('selected recall', pct(Number(winner.manualRecall || 0) * 100), C.green)}${stat('atlas base rate', pct(Number(winner.atlasBaseRate || 0) * 100), C.dim)}${stat('concentration', `${fmt(winner.enrichment, 2)}x`, C.cyan)}${stat('information', `${fmt(winner.globalInformationContributionBits, 3)} bits`, C.purple)}</div>
                <div style="min-width:230px"><div style="font-size:9px;color:${C.text};line-height:1.5">${winner.manualPhrasesInCluster || 0}/${counts.manualPhrases || 0} selected phrases · ${winner.manualHooksInCluster || 0}/${counts.manualHooks || 0} source hooks<br>same cluster in ${pct(Number(bootstrap.sameClusterWithinWinningMapRate || 0) * 100)} of grouped bootstraps · exact map/cluster in ${pct(Number(bootstrap.exactMapAndClusterSelectionRate || 0) * 100)}<br>length NMI ${fmt(winner.lengthNMI, 3)} · position NMI ${fmt(winner.positionNMI, 3)}</div><div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:7px">${button(state.view === 'saved' ? 'Saved embedding open' : 'Open saved embedding', 'data-pl-view="saved"', state.view === 'saved')}${button(active ? 'Winning cluster isolated' : 'Isolate source cluster', 'data-pl-open-manual-probe', active)}</div></div>
            </div>`, 'margin-bottom:10px;border-color:' + C.amber + '55');
        }

        function manualProbeDetail(selectedMap) {
            const probe = state.data.manualProbe, detail = probe && probe.winnerDetail;
            if (!probe || !detail || !selectedMap || selectedMap.id !== probe.winner.mapId
                || state.focusedCluster !== Number(probe.winner.cluster)) return '';
            const matches = detail.matches || [], misses = detail.misses || [], neighbors = detail.nearestMembers || [];
            const rowButton = (row, label, suffix = '') => `<button data-pl-component="${esc(row.spanId || row.id || '')}" data-pl-open-components style="display:block;width:100%;text-align:left;border:0;border-bottom:1px solid ${C.border};background:transparent;color:${C.text};padding:5px 0;font-size:8.5px;cursor:pointer"><b>${esc(label)}</b>${suffix ? `<br><span style="color:${C.mute}">${esc(suffix)}</span>` : ''}</button>`;
            return card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px"><div><div style="font-size:11px;font-weight:900;color:${C.text}">Study the winning category</div><div style="font-size:8px;color:${C.mute}">Cyan points are your selected spans. Colored points are every member of cluster ${detail.cluster}; dim points are the other three categories. Click any row to inspect its exact embedding input.</div></div>${button('Show all clusters', 'data-pl-clear-cluster-focus')}</div>
                <div class="pl-split" style="display:grid;grid-template-columns:minmax(250px,1fr) minmax(230px,.7fr) minmax(280px,1.1fr);gap:12px">
                <div><div style="font-size:9px;font-weight:900;color:${C.green};margin-bottom:4px">Inside · ${matches.length} manual phrases</div><div style="max-height:390px;overflow:auto">${matches.map(row => rowButton(row, row.manualPhrase, row.observedSpanText === row.manualPhrase ? '' : `observed: ${row.observedSpanText}`)).join('')}</div></div>
                <div><div style="font-size:9px;font-weight:900;color:${C.amber};margin-bottom:4px">Outside · ${misses.length} manual phrases</div><div style="max-height:390px;overflow:auto">${misses.map(row => rowButton(row, row.manualPhrase, `observed: ${row.observedSpanText} · landed in cluster ${row.winningMapCluster}`)).join('')}</div></div>
                <div><div style="font-size:9px;font-weight:900;color:${C.cyan};margin-bottom:4px">Nearest unlabeled members · ${neighbors.length}</div><div style="font-size:8px;color:${C.mute};margin-bottom:4px">Nearest the displayed cluster median, one source hook each before repeats. Unlabeled means unreviewed, not negative.</div><div style="max-height:390px;overflow:auto">${neighbors.map(row => rowButton(row, row.text, `distance ${fmt(row.distanceToDisplayedCentroid, 4)}${(row.manualPhraseIndices || []).length ? ' · manually selected' : ''}`)).join('')}</div></div>
                </div>`, 'margin-bottom:10px;border-color:' + clusterColor(detail.cluster) + '66');
        }

        function manualMetricGlossary() {
            const probe = state.data.manualProbe;
            if (!probe || !probe.winner) return '';
            const winner = probe.winner;
            return card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">What the winning-map metrics mean</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;font-size:9px;line-height:1.5">
                <div><b style="color:${C.cyan}">k=4</b><br><span style="color:${C.dim}">MiniBatchKMeans divides the exact four-dimensional clustering input into four groups. These are the fixed labels 0, 1, 2, and 3; cluster 2 is the one matching your selections.</span></div>
                <div><b style="color:${C.purple}">whitened 4D</b><br><span style="color:${C.dim}">The 1536D span vector has its source-hook fixed effect removed, is reduced to the first four PCA coordinates, and each coordinate is divided by its global standard deviation. PCA made the axes uncorrelated; variance scaling gives each equal weight in k-means.</span></div>
                <div><b style="color:${C.green}">atlas base rate · ${pct(Number(winner.atlasBaseRate || 0) * 100)}</b><br><span style="color:${C.dim}">The ordinary share of all ${Number(winner.atlasPopulation || 0).toLocaleString()} spans assigned to cluster ${winner.cluster}: ${Number(winner.atlasClusterSize || 0).toLocaleString()} / ${Number(winner.atlasPopulation || 0).toLocaleString()}. It is the comparison rate, not an accuracy score.</span></div>
                <div><b style="color:${C.cyan}">enrichment · ${fmt(winner.enrichment, 2)}x</b><br><span style="color:${C.dim}">Your equal-hook-weighted cluster share divided by its atlas base rate: ${pct(Number(winner.manualRecall || 0) * 100)} / ${pct(Number(winner.atlasBaseRate || 0) * 100)}. Your selected concept lands here ${fmt(winner.enrichment, 2)} times as often as an arbitrary atlas span.</span></div>
                <div><b style="color:${C.purple}">information contribution · ${fmt(winner.informationContributionBits, 3)} bits</b><br><span style="color:${C.dim}">The cluster's KL contribution is p × log2(p / q), where p is your selected share and q is the atlas base rate. The raw log-lift is ${fmt(Math.log2(Number(winner.enrichment || 1)), 3)} bits; weighting it by p gives ${fmt(winner.informationContributionBits, 3)} bits.</span></div>
                </div>`, 'margin-bottom:10px');
        }

        function savedPointInspector(experiment, method) {
            const pointIndex = experiment.frozenPointIndex || {};
            const index = Number(state.savedPointIndex);
            if (state.savedPointIndex == null || !Number.isInteger(index) || index < 0 || index >= (pointIndex.spanIds || []).length) {
                return `<div style="height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:${C.mute};font-size:10px;line-height:1.55"><div><b style="color:${C.text};font-size:12px">Point inspector</b><br>Click any point in the saved embedding. Its exact text, source hook, offsets, frozen cluster, and displayed coordinates will appear here without leaving this view.</div></div>`;
            }
            const hookIndex = Number((pointIndex.hookIndices || [])[index]);
            const hook = (pointIndex.hooks || [])[hookIndex] || {};
            const hookText = String(hook.text || '');
            const charStart = Number((pointIndex.charStarts || [])[index]);
            const charEnd = Number((pointIndex.charEnds || [])[index]);
            const hasOffsets = Number.isFinite(charStart) && Number.isFinite(charEnd)
                && charStart >= 0 && charEnd >= charStart && charEnd <= hookText.length;
            const highlighted = hasOffsets
                ? `${esc(hookText.slice(0, charStart))}<mark style="background:${C.cyan}2a;color:${C.text};padding:1px 2px">${esc(hookText.slice(charStart, charEnd))}</mark>${esc(hookText.slice(charEnd))}`
                : esc(hookText);
            const coordinates = ((method || {}).points || [])[index] || [];
            const label = Number((pointIndex.labels || [])[index]);
            const manual = new Set((((state.data.manualProbe || {}).winnerDetail || {}).matches || [])
                .map(row => Number(row.allSpanIndex))).has(index);
            return `<div style="padding:12px;height:100%;overflow:auto"><div style="font-size:8px;color:${clusterColor(label)};font-weight:900;text-transform:uppercase">Frozen cluster ${label}${manual ? ' · manual selection' : ''}</div><div style="font-size:14px;color:${C.text};font-weight:900;line-height:1.35;margin:5px 0">${esc((pointIndex.texts || [])[index] || '')}</div><div style="font-size:8px;color:${C.mute};margin-bottom:3px">source video</div><div style="font-size:10px;color:${C.text};font-weight:800">${esc(hook.title || hook.videoId || '')}</div><div style="font-size:8px;color:${C.faint};margin-top:2px">${esc(hook.videoId || '')} · hook ${hookIndex} · tokens ${Number((pointIndex.starts || [])[index])}-${Number((pointIndex.ends || [])[index])} · characters ${charStart}-${charEnd}</div><div style="height:1px;background:${C.border};margin:10px 0"></div><div style="font-size:8px;color:${C.mute};margin-bottom:3px">exact source hook</div><div style="font-size:9px;color:${C.dim};line-height:1.55">${highlighted}</div><div style="height:1px;background:${C.border};margin:10px 0"></div><div style="font-size:8px;color:${C.mute};margin-bottom:3px">embedding input and current coordinates</div><div style="font-size:9px;color:${C.text};line-height:1.55"><b>Gemini text input:</b> ${esc((pointIndex.texts || [])[index] || '')}<br><b>representation:</b> source-hook fixed effect removed → unit normalized → first four PCA coordinates → variance normalized<br><b>${esc((method || {}).label || '')}:</b> x ${fmt(coordinates[0], 5)} · y ${fmt(coordinates[1], 5)}<br><b>point index:</b> ${index.toLocaleString()} · <b>span ID:</b> <span style="font-family:monospace">${esc((pointIndex.spanIds || [])[index] || '')}</span></div></div>`;
        }

        function manualProjectionPanel() {
            const experiment = state.data.manualProjection;
            if (!experiment) {
                if (state.errors.manualProjection) return card(`<div style="font-size:9px;color:${C.red}">${esc(state.errors.manualProjection)}</div>`, 'margin-bottom:10px');
                return '';
            }
            const methods = experiment.methods || [];
            const selected = methods.find(row => row.id === state.projectionMethod)
                || methods.find(row => row.id === experiment.selectedMethod) || methods[0];
            if (!selected) return '';
            const metrics = selected.metrics || {}, baseline = methods.find(row => row.id === 'pca12') || {};
            const baselineMetrics = baseline.metrics || {}, improvement = experiment.improvementOverPca || {};
            return card(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px"><div style="min-width:260px;flex:1"><div style="font-size:9px;color:${C.green};font-weight:900;text-transform:uppercase">Saved embedding · persistent artifact</div><div style="font-size:14px;font-weight:900;color:${C.text};margin-top:2px">${esc(experiment.savedName || 'Frozen k=4 projection')}</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:3px">All ${Number((experiment.reconstruction || {}).rows || 0).toLocaleString()} cluster assignments remain byte-for-byte frozen. Translation only recenters a picture and rotation inside an existing 2D plane preserves every distance; the useful operation is selecting a different two-dimensional subspace from the exact four-dimensional clustering input.</div></div><div style="font-size:8px;color:${C.green};font-weight:900;text-align:right">Saved to R2 · available on every load<br>0 labels changed · 0 clusters refit · 0 outcomes used</div></div>
                <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">${methods.map(row => button(row.label, `data-pl-projection-method="${row.id}"`, selected.id === row.id)).join('')}</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:7px">${stat('weakest pair', fmt(metrics.worstPairSeparation, 3), C.green)}${stat('2D label recovery', pct(Number(metrics.nearestCentroidAgreement || 0) * 100), C.cyan)}${stat('silhouette', fmt(metrics.silhouetteSampled, 3), C.purple)}${stat('DB overlap', fmt(metrics.daviesBouldin, 3), C.amber)}${stat('Fisher ratio', fmt(metrics.fisherTraceRatio, 3), C.dim)}</div>
                <div style="font-size:9px;color:${C.dim};line-height:1.5;margin-bottom:6px"><b style="color:${selected.id === experiment.selectedMethod ? C.green : C.text}">${esc(selected.label)}</b>: ${esc(selected.description)} ${selected.usesFrozenLabelsToChoosePlane ? 'The frozen labels choose this browse-only plane.' : 'The labels do not choose this plane; they only score it.'}</div>
                <div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.55fr) minmax(270px,.45fr);gap:10px;margin-bottom:9px"><div><canvas data-pl-canvas="manual-projection" style="width:100%;height:520px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:5px">Equal x/y unit scale. Cyan points are your manual selections; the four other colors are the unchanged k-means labels. Click points freely; the inspector updates without navigating away.</div></div><aside data-pl-saved-point-inspector data-pl-saved-point-index="${state.savedPointIndex == null ? '' : state.savedPointIndex}" style="min-height:520px;max-height:520px;background:${C.card2};border-left:2px solid ${C.cyan};overflow:hidden">${savedPointInspector(experiment, selected)}</aside></div>
                <div class="pl-split" style="display:grid;grid-template-columns:minmax(260px,.8fr) minmax(0,1.2fr);gap:12px">
                <div><div style="font-size:9px;font-weight:900;color:${C.text};margin-bottom:4px">Result against PCA axes 1-2</div><div style="font-size:9px;color:${C.dim};line-height:1.55">Weakest pair ${fmt(baselineMetrics.worstPairSeparation, 3)} → ${fmt((methods.find(row => row.id === experiment.selectedMethod) || selected).metrics.worstPairSeparation, 3)} (${signed(Number(improvement.worstPairSeparationRelative || 0) * 100, 1)}%)<br>2D label recovery ${pct(Number(baselineMetrics.nearestCentroidAgreement || 0) * 100)} → ${pct(Number((methods.find(row => row.id === experiment.selectedMethod) || selected).metrics.nearestCentroidAgreement || 0) * 100)}<br>Silhouette ${fmt(baselineMetrics.silhouetteSampled, 3)} → ${fmt((methods.find(row => row.id === experiment.selectedMethod) || selected).metrics.silhouetteSampled, 3)}<br>Davies-Bouldin ${fmt(baselineMetrics.daviesBouldin, 3)} → ${fmt((methods.find(row => row.id === experiment.selectedMethod) || selected).metrics.daviesBouldin, 3)} (${pct(Number(improvement.daviesBouldinRelativeReduction || 0) * 100)} less overlap)</div></div>
                <div><div style="font-size:9px;font-weight:900;color:${C.text};margin-bottom:4px">All six pairwise standardized separations</div><div style="display:grid;grid-template-columns:repeat(3,minmax(90px,1fr));gap:5px">${(metrics.pairwise || []).map(row => `<div style="border-left:2px solid ${clusterColor(row.left)};padding:3px 6px;font-size:8px;color:${C.dim}"><b style="color:${C.text}">${row.left} ↔ ${row.right}</b><br>${fmt(row.standardizedSeparation, 3)}</div>`).join('')}</div><div style="font-size:8px;color:${C.mute};margin-top:6px">Primary objective: maximize the smallest of these six values. Higher means cluster centroids are farther apart relative to their pooled within-cluster spread.</div></div>
                </div>`, 'margin-bottom:10px;border-color:' + C.cyan + '55');
        }

        function clusterOutcomePointInspector(detail) {
            const localIndex = Number(state.clusterOutcomePointIndex);
            const points = (detail || {}).points || {};
            const globalIndices = points.globalIndices || [];
            if (state.clusterOutcomePointIndex == null || !Number.isInteger(localIndex)
                || localIndex < 0 || localIndex >= globalIndices.length) {
                return `<div style="height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:${C.mute};font-size:10px;line-height:1.55"><div><b style="color:${C.text};font-size:12px">Axis point inspector</b><br>Click a point to see the exact span text embedded, its complete source hook, measured target, adjusted target, timing interval, and axis coordinates.</div></div>`;
            }
            const globalIndex = Number(globalIndices[localIndex]);
            const pointIndex = ((state.data.manualProjection || {}).frozenPointIndex || {});
            const hookIndex = Number((pointIndex.hookIndices || [])[globalIndex]);
            const hook = (pointIndex.hooks || [])[hookIndex] || {};
            const hookText = String(hook.text || '');
            const charStart = Number((pointIndex.charStarts || [])[globalIndex]);
            const charEnd = Number((pointIndex.charEnds || [])[globalIndex]);
            const highlighted = Number.isFinite(charStart) && Number.isFinite(charEnd)
                && charStart >= 0 && charEnd >= charStart && charEnd <= hookText.length
                ? `${esc(hookText.slice(0, charStart))}<mark style="background:${C.cyan}2a;color:${C.text};padding:1px 2px">${esc(hookText.slice(charStart, charEnd))}</mark>${esc(hookText.slice(charEnd))}`
                : esc(hookText);
            const meta = detail.targetMeta || {};
            const offset = Number(meta.offsetSeconds || 0);
            const spokenStart = numeric((points.spanStartSeconds || [])[localIndex]);
            const spokenEnd = numeric((points.spanEndSeconds || [])[localIndex]);
            const rawTarget = numeric((points.target || [])[localIndex]);
            const residualTarget = numeric((points.targetResidual || [])[localIndex]);
            const scale = outcomeScale(detail);
            const color = scale.color(rawTarget);
            return `<div style="padding:12px;height:100%;overflow:auto"><div style="font-size:8px;color:${clusterColor(detail.cluster)};font-weight:900;text-transform:uppercase">cluster ${detail.cluster} · ${esc(meta.label || detail.target || '')}</div><div style="font-size:14px;color:${C.text};font-weight:900;line-height:1.35;margin:5px 0">${esc((pointIndex.texts || [])[globalIndex] || '')}</div><div style="font-size:8px;color:${C.mute};margin-bottom:3px">source video</div><div style="font-size:10px;color:${C.text};font-weight:800">${esc(hook.title || hook.videoId || '')}</div><div style="font-size:8px;color:${C.faint};margin-top:2px">${esc(hook.videoId || '')} · global span ${globalIndex.toLocaleString()} · frozen cluster ${Number((pointIndex.labels || [])[globalIndex])}</div><div style="height:1px;background:${C.border};margin:10px 0"></div><div style="font-size:8px;color:${C.mute};margin-bottom:3px">exact source hook</div><div style="font-size:9px;color:${C.dim};line-height:1.55">${highlighted}</div><div style="height:1px;background:${C.border};margin:10px 0"></div><div style="font-size:8px;color:${C.mute};margin-bottom:3px">visible input → output trace</div><div style="font-size:9px;color:${C.text};line-height:1.6"><b>embedded text:</b> ${esc((pointIndex.texts || [])[globalIndex] || '')}<br><b>semantic representation:</b> ${esc((detail.selectedExperiment || {}).representation || '')} · ${(detail.selectedExperiment || {}).pcaDimensions || '-'}D · ridge alpha ${fmt((detail.selectedExperiment || {}).ridgeAlpha, 2)}<br><span style="display:inline-block;width:8px;height:8px;background:${color};border:1px solid ${C.border};margin-right:4px"></span><b>point color (${esc(meta.label || detail.target || '')}):</b> ${esc(formatOutcomeValue(rawTarget, detail.target, meta))}<br><b>axis-fitting target after fold-declared confounds:</b> ${esc(formatOutcomeValue(residualTarget, detail.target, meta))}<br><b>horizontal semantic score:</b> ${fmt((points.x || [])[localIndex], 5)} · <b>vertical background coordinate:</b> ${fmt((points.y || [])[localIndex], 5)}<br><b>spoken interval:</b> ${fmt(spokenStart, 3)}s → ${fmt(spokenEnd, 3)}s${meta.family === 'performance' ? '<br><b>measurement scope:</b> source-video value; no phrase window' : `<br><b>measured slope window:</b> ${fmt(spokenStart + offset, 3)}s → ${fmt(spokenEnd + offset, 3)}s · processing offset +${offset}s`}</div></div>`;
        }

        function clusterOutcomeMatrix(summary) {
            const definitions = summary.targetDefinitions || {};
            const familyTargets = Object.keys(definitions).filter(
                name => definitions[name].family === state.clusterOutcomeFamily
            );
            const family = outcomeFamilyDefinition(state.clusterOutcomeFamily);
            return card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-bottom:7px"><div><div style="font-size:11px;font-weight:900;color:${C.text}">Four-cluster conditional diagnostic matrix</div><div style="font-size:8px;color:${C.mute}">Every cell is a separate axis learned only within the post-hoc frozen category. rho is grouped-source random-fold Spearman; q corrects the 100-family selection. No cell has chronological validation.</div></div><div style="display:flex;gap:4px;flex-wrap:wrap">${[['performance', 'Video outcomes'], ['raw-slope', 'Raw retention slope'], ['normalized-slope', 'Normalized slope'], ['residual-slope', 'Unexpected slope']].map(([id, label]) => button(label, `data-pl-outcome-family="${id}"`, state.clusterOutcomeFamily === id)).join('')}</div></div><div style="border-left:2px solid ${C.cyan};padding:5px 8px;margin:6px 0 9px;font-size:8.5px;color:${C.dim};line-height:1.5"><b style="color:${C.text}">Viewing: ${esc(family.label)}.</b> ${esc(family.summary)} Amber cells pass the grouped-random searched null but remain conditional diagnostics. Click a cell to inspect it.</div><div style="overflow:auto"><div style="min-width:${Math.max(620, 104 + familyTargets.length * 122)}px">${(summary.clusters || []).map(cluster => { const byTarget = Object.fromEntries((cluster.targets || []).map(row => [row.target, row])); return `<div style="display:grid;grid-template-columns:96px repeat(${familyTargets.length},minmax(112px,1fr));gap:4px;margin-bottom:4px"><button data-pl-outcome-cluster="${cluster.label}" style="border:1px solid ${Number(cluster.label) === Number(state.clusterOutcomeCluster) ? clusterColor(cluster.label) : C.border};background:${C.card2};color:${clusterColor(cluster.label)};font-size:10px;font-weight:900;cursor:pointer;text-align:left;padding:7px;border-radius:5px;${Number(cluster.label) === Number(state.clusterOutcomeCluster) ? `box-shadow:inset 3px 0 ${clusterColor(cluster.label)}` : ''}">cluster ${cluster.label}<br><span style="font-size:8px;color:${C.mute}">${Number(cluster.spanInstances || 0).toLocaleString()} spans</span></button>${familyTargets.map(name => { const row = byTarget[name] || {}, definition = definitions[name] || {}, active = Number(cluster.label) === Number(state.clusterOutcomeCluster) && name === state.clusterOutcomeTarget, supported = Boolean(row.randomFoldSupported); return `<button title="${esc(definition.definition || '')}" data-pl-outcome-target="${esc(name)}" data-pl-outcome-cluster="${cluster.label}" style="min-width:0;border:1px solid ${active ? C.cyan : supported ? C.amber + '88' : C.border};background:${active ? C.cyan + '18' : C.card2};color:${C.text};padding:6px;border-radius:5px;text-align:left;cursor:pointer"><div style="font-size:8px;color:${supported ? C.amber : C.dim};font-weight:900;white-space:normal">${esc(definition.label || name)}</div><div style="font-size:7.5px;color:${C.faint};white-space:normal;margin-top:1px">${esc(definition.unit || '')}</div><div style="font-size:11px;font-weight:900;margin-top:2px">rho ${fmt(row.heldoutSpearman, 3)}</div><div style="font-size:8px;color:${C.mute}">q ${fmt(row.searchWideQ, 3)} · ${supported ? 'random-fold supported' : 'diagnostic'}</div></button>`; }).join('')}</div>`; }).join('')}</div></div>`, 'margin-bottom:10px');
        }

        function clusterOutcomeDetailPanel(summary) {
            const detail = state.clusterOutcomeDetail;
            if (state.clusterOutcomeLoading) return card(`<div style="font-size:10px;color:${C.cyan}">Loading the selected point-level embedding map...</div>`, 'margin-bottom:10px');
            if (state.clusterOutcomeError) return card(`<div style="font-size:10px;color:${C.red}">${esc(state.clusterOutcomeError)}</div>`, 'margin-bottom:10px');
            if (!detail) return '';
            const experiment = detail.selectedExperiment || {}, meta = detail.targetMeta || {};
            const offset = Number(meta.offsetSeconds || 0);
            const cluster = (summary.clusters || []).find(row => Number(row.label) === Number(detail.cluster)) || {};
            const baseline = (cluster.slopeBaselineAudits || {})[String(offset)] || detail.normalizationAudit || {};
            const extremes = detail.extremes || {};
            const family = outcomeFamilyDefinition(meta.family);
            const extremeColumn = (title, rows, color) => `<div><div style="font-size:9px;color:${color};font-weight:900;margin-bottom:4px">${esc(title)}</div>${(rows || []).map(row => `<button data-pl-outcome-global-index="${row.globalIndex}" style="display:block;width:100%;text-align:left;border:0;border-top:1px solid ${C.border};background:transparent;color:${C.text};padding:5px 0;font-size:8.5px;cursor:pointer"><b>${esc(row.text || '')}</b><br><span style="color:${C.mute}">semantic score ${fmt(row.axis, 3)} · color metric ${esc(formatOutcomeValue(row.target, detail.target, meta, true))}</span></button>`).join('')}</div>`;
            return `${card(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:7px"><div style="min-width:270px;flex:1"><div style="font-size:9px;color:${clusterColor(detail.cluster)};font-weight:900;text-transform:uppercase">conditional diagnostic · frozen cluster ${detail.cluster} · ${esc(family.label)}</div><div style="font-size:15px;color:${C.text};font-weight:900;margin-top:2px">${esc(meta.label || detail.target)}</div><div style="font-size:9px;color:${C.dim};line-height:1.5;margin-top:3px">${esc(meta.definition || '')}</div><div style="font-size:8px;color:${C.mute};margin-top:4px">embedded input: exact contiguous span text · representation: ${esc(experiment.representation || '')} · ${experiment.pcaDimensions || '-'} PCA dimensions · ridge alpha ${fmt(experiment.ridgeAlpha, 2)} · removed confound set: ${esc(experiment.confounds || '')}</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('held-out rho', fmt(experiment.heldoutSpearman, 3), C.amber)}${stat('search p', fmt(experiment.searchWideP, 4), C.cyan)}${stat('family q', fmt(experiment.searchWideQ, 4), C.amber)}${stat('audit rows', Number(experiment.n || 0).toLocaleString(), C.purple)}</div></div>${outcomeMetricLegend(detail)}<div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.3fr) minmax(290px,.7fr);gap:10px"><div><div style="display:flex;justify-content:space-between;gap:8px;font-size:8px;margin-bottom:3px"><span style="color:${C.cyan}">← lower predicted ${esc(meta.label || detail.target)}</span><b style="color:${C.text}">semantic outcome axis</b><span style="color:${outcomePalette.high}">higher predicted ${esc(meta.label || detail.target)} →</span></div><canvas data-pl-canvas="cluster-outcome-axis" aria-label="Semantic outcome axis colored from low blue to high red by ${esc(meta.label || detail.target)}" style="width:100%;height:430px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:4px">Click any point without leaving this view. Its inspector reports the exact embedded phrase, raw color metric, confound-adjusted axis target, spoken interval, and coordinates.</div></div><aside data-pl-outcome-inspector style="height:455px;background:${C.card2};border-left:2px solid ${clusterColor(detail.cluster)};overflow:hidden">${clusterOutcomePointInspector(detail)}</aside></div>`, 'margin-bottom:10px;border-color:' + clusterColor(detail.cluster))}
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-bottom:10px">${card(`<div style="font-size:10px;color:${C.green};font-weight:900;margin-bottom:3px">Held-out prediction check · ${esc(meta.label || detail.target)}</div><canvas data-pl-canvas="cluster-outcome-oof" aria-label="Out-of-fold predicted versus observed adjusted ${esc(meta.label || detail.target)}" style="width:100%;height:270px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:4px"><b style="color:${C.text}">X:</b> prediction from a fold that never saw the source video. <b style="color:${C.text}">Y:</b> observed ${esc(meta.label || detail.target)} after the declared confounds. <b style="color:${clusterColor(detail.cluster)}">Point color:</b> fixed cluster ${detail.cluster}, not a metric. Four deterministic audit spans per source are shown.</div>`)}${card(`<div style="font-size:10px;color:${C.purple};font-weight:900;margin-bottom:3px">Processing-lag comparison · cluster ${detail.cluster}</div><canvas data-pl-canvas="cluster-outcome-offsets" aria-label="Held-out Spearman correlation by processing offset" style="width:100%;height:270px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:4px"><b style="color:${C.text}">X:</b> phrase-window offset from +0 to +5 seconds. <b style="color:${C.text}">Y:</b> held-out Spearman rho between the learned semantic score and adjusted slope target, not the retention slope itself. Cyan = raw, purple = endpoint-normalized, green = unexpected slope.</div>`)}</div>
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,.75fr);gap:10px;margin-bottom:10px">${card(`<div style="font-size:10px;color:${C.cyan};font-weight:900;margin-bottom:3px">Entry / terminal normalization diagnostic</div><canvas data-pl-canvas="cluster-outcome-entry" aria-label="Predicted versus observed entry retention ratio" style="width:100%;height:260px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:4px"><b style="color:${C.text}">X:</b> out-of-fold predicted entry retention ratio from terminal retention and duration. <b style="color:${C.text}">Y:</b> observed entry retention ratio. Pearson ${fmt(((summary.normalization || {}).entryTerminalDiagnostic || {}).oofPearson, 3)} · Spearman ${fmt(((summary.normalization || {}).entryTerminalDiagnostic || {}).oofSpearman, 3)} · R2 ${fmt(((summary.normalization || {}).entryTerminalDiagnostic || {}).oofR2, 3)}. This measured relationship adjusts the rewatch-linked starting level.</div>`)}${card(`<div style="font-size:10px;color:${C.text};font-weight:900;margin-bottom:5px">What was adjusted</div><div style="font-size:9px;color:${C.dim};line-height:1.6">Endpoint normalization: <b style="color:${C.text}">(retention - terminal) / (entry - terminal)</b>.<br>Terminal is the mean of the final 5% of curve points, minimum three.<br>Natural-drop residual is grouped out of sample from exact span timing, phrase duration, video duration, entry, terminal, amplitude, and entry minus expected entry.<br>${meta.family === 'performance' ? 'This target is video-level, so no phrase-slope window is used.' : `Selected phrase window offset: <b style="color:${C.text}">+${offset}s</b>. Baseline OOF rho ${fmt(baseline.oofSpearman, 3)} · R2 ${fmt(baseline.oofR2, 3)}.`}</div>`)}</div>
            ${card(`<div style="font-size:8px;color:${C.mute};line-height:1.5;margin-bottom:5px">These lists rank the learned horizontal semantic score, not the raw color metric. “High” means wording the model associates with a higher confound-adjusted ${esc(meta.label || detail.target)}.</div><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">${extremeColumn('Highest semantic-score spans', extremes.high, C.green)}${extremeColumn('Lowest semantic-score spans', extremes.low, C.red)}</div>`, 'margin-bottom:10px')}`;
        }

        function clusterOutcomePanel() {
            const summary = state.data.clusterOutcomes;
            if (!summary) return state.errors.clusterOutcomes ? card(`<div style="font-size:10px;color:${C.red}">${esc(state.errors.clusterOutcomes)}</div>`) : loading('clusterOutcomes');
            const timing = summary.timingAudit || {};
            return `<div style="height:1px;background:${C.border};margin:16px 0"></div>${card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:280px;flex:1"><div style="font-size:9px;color:${C.purple};font-weight:900;text-transform:uppercase">Quantifying the four frozen categories</div><div style="font-size:15px;color:${C.text};font-weight:900;margin-top:2px">Cluster-conditioned outcome and phrase-slope embeddings</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:4px">The k=4 assignment above is unchanged. Each category now gets its own views, realistic views, outlier, 10M class, swipe, 5-second retention, and exact phrase-slope axes. Outcomes join only here, after clustering. Every result remains conditional on the post-hoc map and lacks chronological replication.</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('axis runs', Number(summary.experimentCount || 0).toLocaleString(), C.purple)}${stat('selected families', summary.selectedFamilyCount || 0, C.cyan)}${stat('random-fold supported', summary.randomFoldSupportedFamilyCount || 0, C.amber)}${stat('exact timing', `${timing.exactHooks || 0}/${timing.hooks || 0}`, C.amber)}</div></div><div style="font-size:8px;color:${C.mute};margin-top:7px">Five hooks with caption-text mismatches are excluded only from timed slope targets; all remain in video-level targets. ${Number(timing.spansWithExactPositiveDuration || 0).toLocaleString()} / ${Number(timing.spanInstances || 0).toLocaleString()} spans have exact positive-duration intervals. No timestamp is guessed.</div>`, 'margin-bottom:10px;border-color:' + C.purple + '55')}${clusterOutcomeMatrix(summary)}${clusterOutcomeDetailPanel(summary)}`;
        }

        const latencyLagLabel = value => `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(Number(value) % 1 ? 1 : 0)}s`;

        function activeLatencyRows(summary) {
            const cluster = (summary.clusters || []).find(row => Number(row.label) === Number(state.latencyCluster))
                || (summary.clusters || [])[0] || {};
            const window = (cluster.windows || []).find(row => row.id === state.latencyWindow)
                || (cluster.windows || [])[0] || {};
            return { cluster, window, lags: summary.lagsSeconds || [] };
        }

        function latencyPointPanel(summary, cluster) {
            if (state.latencyPointGlobalIndex == null) {
                return card(`<div style="font-size:11px;color:${C.text};font-weight:900">Exact phrase response trace</div><div style="font-size:9px;color:${C.mute};line-height:1.55;margin-top:5px">Click any point in the semantic map above, or choose a fixed-ruler extreme below. This panel will show the phrase's spoken interval and, for every lag, the observed raw slope, text-free expected slope, and excess slope on the same source video.</div>`, 'margin-bottom:10px;border-color:' + C.cyan + '44');
            }
            if (state.latencyDetailLoading) return card(`<div style="font-size:9px;color:${C.cyan}">Loading point-level latency traces for cluster ${state.latencyCluster}...</div>`, 'margin-bottom:10px');
            if (state.latencyDetailError) return card(`<div style="font-size:9px;color:${C.red}">${esc(state.latencyDetailError)}</div>`, 'margin-bottom:10px');
            const detail = state.latencyDetail;
            if (!detail || Number(detail.cluster) !== Number(state.latencyCluster)) return card(`<div style="font-size:9px;color:${C.mute}">Point trace is ready to load for cluster ${state.latencyCluster}.</div>`, 'margin-bottom:10px');
            const localIndex = (detail.globalIndices || []).indexOf(Number(state.latencyPointGlobalIndex));
            if (localIndex < 0) return card(`<div style="font-size:9px;color:${C.amber}">The selected phrase belongs to another frozen cluster. Select a cluster-${state.latencyCluster} point or change the latency cluster.</div>`, 'margin-bottom:10px');
            const pointIndex = ((state.data.manualProjection || {}).frozenPointIndex || {});
            const globalIndex = Number(state.latencyPointGlobalIndex);
            const hookIndex = Number((pointIndex.hookIndices || [])[globalIndex]);
            const hook = (pointIndex.hooks || [])[hookIndex] || {};
            const source = (summary.sourceCurves || []).find(row => Number(row.hookIndex) === hookIndex) || {};
            const lags = detail.lagsSeconds || [];
            const observed = (((detail.phrase || {}).observedRaw || [])[localIndex]) || [];
            const expected = (((detail.phrase || {}).expectedRawOOF || [])[localIndex]) || [];
            const excess = (((detail.phrase || {}).unexpectedRaw || [])[localIndex]) || [];
            const start = numeric((detail.spanStartSeconds || [])[localIndex]);
            const end = numeric((detail.spanEndSeconds || [])[localIndex]);
            const selectedLag = Number.isInteger(state.latencySelectedLagIndex)
                ? Math.max(0, Math.min(lags.length - 1, state.latencySelectedLagIndex))
                : Math.max(0, lags.indexOf(0));
            const table = lags.map((lag, index) => `<tr style="background:${index === selectedLag ? C.cyan + '14' : 'transparent'}"><td style="padding:4px;color:${lag < 0 ? C.amber : C.text};border-bottom:1px solid ${C.border}">${latencyLagLabel(lag)}</td><td style="padding:4px;color:${C.dim};border-bottom:1px solid ${C.border}">${fmt(start + Number(lag), 2)}s → ${fmt(end + Number(lag), 2)}s</td><td style="padding:4px;color:${C.text};border-bottom:1px solid ${C.border}">${Number.isFinite(numeric(observed[index])) ? signed(numeric(observed[index]) * 100, 3) : '-'}</td><td style="padding:4px;color:${C.purple};border-bottom:1px solid ${C.border}">${Number.isFinite(numeric(expected[index])) ? signed(numeric(expected[index]) * 100, 3) : '-'}</td><td style="padding:4px;color:${numeric(excess[index]) >= 0 ? C.green : C.red};border-bottom:1px solid ${C.border}">${Number.isFinite(numeric(excess[index])) ? signed(numeric(excess[index]) * 100, 3) : '-'}</td></tr>`).join('');
            return card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px"><div style="min-width:260px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Exact phrase response trace · global span ${globalIndex.toLocaleString()}</div><div style="font-size:15px;color:${C.text};font-weight:900;margin-top:3px">${esc((pointIndex.texts || [])[globalIndex] || '')}</div><div style="font-size:9px;color:${C.dim};margin-top:3px">${esc(hook.title || hook.videoId || '')}</div></div><div style="font-size:8.5px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Spoken:</b> ${fmt(start, 3)}s → ${fmt(end, 3)}s<br><b style="color:${C.text}">Curve sampling:</b> one native point every ${fmt(source.curveSampleSeconds, 3)}s<br><b style="color:${C.text}">Semantic score:</b> ${fmt((detail.sharedSemanticScoreOOF || [])[localIndex], 4)} (held-out fold)</div></div><div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(310px,.8fr);gap:10px"><div><canvas data-pl-canvas="latency-point" style="width:100%;height:300px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:4px">X is response lag relative to this exact spoken phrase. Y is raw retention percentage points per second. Cyan = observed, purple = text-free out-of-fold expectation, green/red = excess above/below expectation.</div></div><div style="max-height:300px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['lag', 'exact curve window', 'observed', 'expected', 'excess'].map(label => `<th style="position:sticky;top:0;background:${C.card2};padding:4px;text-align:left;color:${C.mute};border-bottom:1px solid ${C.border2}">${label}${['observed', 'expected', 'excess'].includes(label) ? ' pp/s' : ''}</th>`).join('')}</tr></thead><tbody>${table}</tbody></table></div></div>`, 'margin-bottom:10px;border-color:' + C.cyan + '66');
        }

        function latencyExtremes(cluster) {
            const axis = cluster.sharedAxis || {}, extremes = axis.extremes || {};
            const column = (label, rows, color) => `<div><div style="font-size:9px;color:${color};font-weight:900;margin-bottom:4px">${label}</div>${(rows || []).slice(0, 12).map(row => `<button data-pl-latency-point-global="${row.globalIndex}" style="display:block;width:100%;border:0;border-top:1px solid ${C.border};background:transparent;color:${C.text};padding:5px 0;text-align:left;font-size:8.5px;cursor:pointer"><b>${esc(row.text || '')}</b><br><span style="color:${C.mute}">held-out shared score ${fmt(row.score, 3)}</span></button>`).join('')}</div>`;
            const stable = axis.allFoldDirectionsAgree;
            return card(`<div style="font-size:8.5px;color:${stable ? C.dim : C.amber};line-height:1.5;margin-bottom:7px"><b style="color:${stable ? C.green : C.amber}">${stable ? 'All fold directions agree.' : 'Fold directions do not all agree.'}</b> These are cross-fitted shared-ruler extremes, not any one offset's independently fitted list. ${stable ? '' : 'Treat individual phrase rankings as exploratory; the lag-level held-out statistics remain the primary result.'}</div><div class="pl-split" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">${column('Higher shared semantic score', extremes.high, C.green)}${column('Lower shared semantic score', extremes.low, C.red)}</div>`, 'margin-bottom:10px');
        }

        function latencyPanel() {
            const summary = state.data.latencyStudy;
            if (!summary) return state.errors.latencyStudy ? card(`<div style="font-size:9px;color:${C.red}">${esc(state.errors.latencyStudy)}</div>`) : loading('latencyStudy');
            const { cluster, window, lags } = activeLatencyRows(summary);
            if (!cluster.label && cluster.label !== 0) return '';
            const peak = window.peak || {};
            const supported = (summary.clusters || []).flatMap(row => row.windows || []).filter(row => (row.peak || {}).latencySupported);
            const selectedLagIndex = Number.isInteger(state.latencySelectedLagIndex)
                ? Math.max(0, Math.min(lags.length - 1, state.latencySelectedLagIndex))
                : Math.max(0, lags.indexOf(Number(peak.lag)));
            const selectedRow = (window.rows || [])[selectedLagIndex] || {};
            const resolution = summary.curveResolution || {};
            const natural = summary.sourceEqualNaturalDrop || [];
            const naturalAt = second => natural.find(row => Number(row.second) === Number(second)) || {};
            const opening = [0, .5, 1, 2].map(second => ({ second, row: naturalAt(second) }));
            const transfer = cluster.axisTransfer || {}, diagnostic = transfer.rankDiagnostic0to1 || {};
            const trainIndex = Math.max(0, Math.min(lags.length - 1, Number(state.latencyTrainLagIndex || 0)));
            const responseIndex = Math.max(0, Math.min(lags.length - 1, Number(state.latencyResponseLagIndex || 0)));
            const transferValue = (((transfer.values || [])[trainIndex]) || [])[responseIndex];
            const stability = cluster.sharedAxis || {};
            return `<div style="height:1px;background:${C.border};margin:18px 0"></div>${card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:300px;flex:1"><div style="font-size:9px;color:${supported.length ? C.amber : C.red};font-weight:900;text-transform:uppercase">Latency hypothesis · held-out confirmation</div><div style="font-size:16px;color:${C.text};font-weight:900;margin-top:2px">${supported.length ? `${supported.length} window-cluster results pass the declared rule` : 'No tested cluster establishes a response latency'}</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:4px">This does not prove latency is zero. It means no positive lag survives source-video holdout, negative-lag falsification controls, its source-level confidence interval, and max-null correction across all 115 tested lag/alignment combinations. The old 0s, 1s, and 2s cards above are independently fitted rulers and their extreme lists must not be compared as though one ruler moved through time.</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('clusters', summary.clusterCount || 0, C.purple)}${stat('lags each', lags.length, C.cyan)}${stat('alignments', (summary.windows || []).length, C.green)}${stat('native median step', `${fmt(resolution.medianSampleSeconds, 3)}s`, C.amber)}</div></div>`, 'margin-bottom:10px;border-color:' + (supported.length ? C.amber : C.red) + '77')}
            ${card(`<div style="font-size:10px;color:${C.text};font-weight:900;margin-bottom:6px">Source-equal natural opening drop · before any phrase attribution</div><div class="pl-natural-stats" style="display:grid;grid-template-columns:repeat(4,minmax(110px,1fr));gap:7px">${opening.map(({ second, row }) => `<div style="border-left:2px solid ${C.red};padding:4px 8px"><div style="font-size:8px;color:${C.mute}">${second.toFixed(1)}s → ${(second + 1).toFixed(1)}s</div><div style="font-size:16px;color:${C.text};font-weight:900">${signed(Number(row.rawMean || 0) * 100, 1)} pp/s</div><div style="font-size:8px;color:${C.dim}">${row.videos || 0} videos equally weighted</div></div>`).join('')}</div><div style="font-size:8px;color:${C.mute};margin-top:7px">The opening curve is not a constant decline: its largest average drop is around 0.5–1.5s, then it rapidly settles. Phrase effects below are measured against a text-free out-of-fold baseline for this changing shape.</div>`, 'margin-bottom:10px')}
            ${card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-bottom:7px"><div><div style="font-size:11px;color:${C.text};font-weight:900">Choose one frozen cluster and one response-window definition</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Changing these controls changes the measured window, not the shared semantic score within the selected cluster.</div></div><div style="display:flex;gap:4px;flex-wrap:wrap">${(summary.clusters || []).map(row => button(`cluster ${row.label}`, `data-pl-latency-cluster="${row.label}"`, Number(row.label) === Number(cluster.label))).join('')}</div></div><div style="display:flex;gap:5px;flex-wrap:wrap">${(summary.windows || []).map(row => button(row.label, `data-pl-latency-window="${row.id}"`, row.id === window.id)).join('')}</div><div style="font-size:8.5px;color:${C.dim};line-height:1.5;margin-top:7px"><b style="color:${C.text}">${esc(window.label || '')}:</b> ${esc(window.definition || '')}. Negative lags are controls; they are never candidate response delays.</div>`, 'margin-bottom:10px')}
            ${card(`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${stat(peak.latencySupported ? 'latency status' : 'latency status', peak.latencySupported ? 'SUPPORTED' : 'NOT SUPPORTED', peak.latencySupported ? C.green : C.red)}${stat('descriptive peak', peak.lag == null ? '-' : latencyLagLabel(peak.lag), C.cyan)}${stat('effect / semantic SD', signed(peak.effect, 6) + '/s', C.purple)}${stat('95% effect CI', `${signed(peak.effectCiLow, 6)} to ${signed(peak.effectCiHigh, 6)}`, C.dim)}${stat('held-out rho', fmt(peak.rho, 3), C.text)}${stat('115-test p', fmt(peak.maxNullP, 3), C.amber)}</div><div style="font-size:8.5px;color:${C.dim};line-height:1.55">At the selected chart lag <b style="color:${C.text}">${latencyLagLabel(selectedRow.lag || 0)}</b>: effect ${signed(selectedRow.effect, 6)}/s · rho ${fmt(selectedRow.rho, 3)} · 95% CI ${signed(selectedRow.effectCiLow, 6)} to ${signed(selectedRow.effectCiHigh, 6)} · corrected p ${fmt(selectedRow.maxNullP, 3)}. Effect is endpoint-normalized retention-slope change per one standard deviation of the exact same held-out semantic score.</div>`, 'margin-bottom:10px;border-color:' + (peak.latencySupported ? C.green : C.red) + '55')}
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-bottom:10px">${card(`<div style="font-size:10px;color:${C.cyan};font-weight:900;margin-bottom:3px">One fixed semantic ruler across response lags</div><canvas data-pl-canvas="latency-effect" style="width:100%;height:300px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:4px"><b style="color:${C.text}">X:</b> response lag. <b style="color:${C.text}">Y:</b> unexpected normalized slope per semantic-score SD; whiskers are source bootstrap 95% intervals. Amber area is the negative-lag control region. Click a lag to inspect it.</div>`)}${card(`<div style="font-size:10px;color:${C.purple};font-weight:900;margin-bottom:3px">Observed drop versus text-free natural baseline</div><canvas data-pl-canvas="latency-baseline" style="width:100%;height:300px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:4px">For whole-phrase alignment, Y is raw retention percentage points/second. Cyan is observed; purple is expected from timing and curve endpoints only; green/red is the remaining excess. Other alignments use endpoint-normalized units.</div>`)}</div>
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:10px;margin-bottom:10px">${card(`<div style="font-size:10px;color:${C.text};font-weight:900;margin-bottom:3px">Train-lag → response-lag transfer · cluster ${cluster.label}</div><canvas data-pl-canvas="latency-transfer" style="width:100%;height:480px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:4px">Rows freeze the ruler trained at one lag; columns move only the response measurement. Red is positive held-out rho, blue is negative, white is zero. Selected: ruler ${latencyLagLabel(lags[trainIndex])} → response ${latencyLagLabel(lags[responseIndex])} = rho ${fmt(transferValue, 3)}.</div>`)}${card(`<div style="font-size:10px;color:${C.text};font-weight:900;margin-bottom:5px">What the 0s / 1s reversal means</div><div style="font-size:9px;color:${C.dim};line-height:1.6">Independent ruler rank correlation: <b style="color:${C.text}">${fmt(diagnostic.scoreSpearman, 3)}</b>.<br>Top-decile overlap: <b style="color:${C.text}">${pct(Number(diagnostic.topDecileJaccard || 0) * 100)}</b>.<br><br>A negative rank correlation means the two independently trained rulers reorder the same phrases. The off-diagonal heatmap cells answer the stronger question: when one ruler is frozen, does its association actually reverse as only the response window moves?<br><br>Shared-mode coefficient energy: <b style="color:${C.text}">${pct(Number(stability.firstModeEnergyMean || 0) * 100)}</b>.<br>Fold direction agreement: <b style="color:${stability.allFoldDirectionsAgree ? C.green : C.amber}">${stability.allFoldDirectionsAgree ? 'all 10 fold pairs agree' : `${pct(Number(stability.foldAxisPositivePairFraction || 0) * 100)} of fold pairs agree`}</b>.<br>Median fold-axis cosine: <b style="color:${C.text}">${fmt(stability.foldAxisMedianCosine, 3)}</b>.</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:8px">Low mode energy or fold agreement means there may be multiple semantic response patterns rather than one stable ruler. It is reported as uncertainty, not silently averaged away.</div>`)}</div>
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,.55fr);gap:10px;margin-bottom:10px">${card(`<div style="font-size:10px;color:${C.green};font-weight:900;margin-bottom:3px">Natural retention drop by actual video second</div><canvas data-pl-canvas="latency-natural" style="width:100%;height:300px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:4px">Every video has equal weight. The line is median raw slope across one-second windows; the band is the source-video interquartile range. This is descriptive curve geometry with no phrase text, cluster, or embedding.</div>`)}${card(`<div style="font-size:10px;color:${C.text};font-weight:900;margin-bottom:5px">Measurement limits</div><div style="font-size:9px;color:${C.dim};line-height:1.6">Retention curves contain <b style="color:${C.text}">${resolution.curvePointsPerVideo || 0} points/video</b>.<br>Native interval median: <b style="color:${C.text}">${fmt(resolution.medianSampleSeconds, 3)}s</b>.<br>90th percentile: <b style="color:${C.text}">${fmt(resolution.p90SampleSeconds, 3)}s</b>.<br>Half-second-or-finer sources: <b style="color:${C.text}">${resolution.videosAtOrFinerThanHalfSecond || 0}/${resolution.videos || 0}</b>.<br><br>The 0.5s lag grid is interpolated. Adjacent cells are not independent when native sampling is coarser, so the UI reports intervals and corrected tests rather than claiming sub-sample timing precision.</div>`)}</div>
            ${latencyPointPanel(summary, cluster)}${latencyExtremes(cluster)}`;
        }

        function hookQualityPointInspector(summary) {
            const rows = ((summary || {}).axis || {}).points || [];
            const index = Number(state.hookQualityPointIndex);
            if (state.hookQualityPointIndex == null || !rows[index]) {
                return `<div style="height:100%;min-height:190px;display:flex;align-items:center;justify-content:center;color:${C.mute};font-size:9px;text-align:center;padding:20px">Click a training point to inspect its exact hook, held-out score, target residual, and every evidence-selected stored component.</div>`;
            }
            const row = rows[index];
            const components = (summary.components || []).slice(
                Number(row.componentOffset || 0), Number(row.componentOffset || 0) + Number(row.componentCount || 0),
            );
            return `<div style="padding:10px;min-height:190px"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Held-out training hook ${index + 1}/${rows.length}</div><div style="font-size:12px;color:${C.text};font-weight:900;line-height:1.4;margin:4px 0">${esc(row.text || '')}</div><div style="font-size:8px;color:${C.mute}">${esc(row.title || row.videoId || '')}</div><div style="display:flex;gap:12px;flex-wrap:wrap;margin:8px 0;font-size:8.5px;color:${C.dim}"><span><b style="color:${C.text}">${fmt(row.oofAxisPercentile, 1)}th</b> held-out score</span><span><b style="color:${C.text}">${signed(row.oofTargetResidual, 3)}</b> observed residual</span><span>fold ${Number(row.fold) + 1}</span><span><b style="color:${C.text}">${components.length}</b> emergent components</span><span>partition gap ${fmt(row.partitionScoreGapPercentile, 1)}th</span></div><div style="display:flex;gap:4px;overflow-x:auto;padding-bottom:4px">${components.map(component => `<span style="flex:0 0 auto;border-bottom:3px solid ${clusterColor(component.category)};background:${C.card};padding:4px 5px;font-size:8.5px;color:${C.text}" title="full-context deletion effect ${signed(component.deletionEffect, 4)}">${esc(component.text)}</span>`).join('')}</div></div>`;
        }

        function forwardResponseInspector(summary) {
            const response = (summary || {}).forwardResponse || {};
            const rows = response.components || [];
            const index = Number(state.forwardResponseComponentIndex);
            if (state.forwardResponseComponentIndex == null || !rows[index]) {
                return `<div style="min-height:185px;display:flex;align-items:center;justify-content:center;color:${C.mute};font-size:9px;text-align:center;padding:18px">Select a stored component point to inspect its exact embedding input, spoken interval, measured response window, observed residual, and source-held-out prediction.</div>`;
            }
            const row = rows[index];
            const hook = (response.hooks || [])[Number(row.sourceIndex)] || {};
            const observed = numeric(row.unexpectedObservedSlope);
            const predicted = numeric(row.predictedUnexpectedSlopeOOF);
            return `<div style="padding:10px;min-height:185px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><div style="font-size:8px;color:${clusterColor(row.category)};font-weight:900;text-transform:uppercase">Cluster ${row.category} · component ${Number(row.component) + 1}</div><div style="font-size:13px;color:${C.text};font-weight:900;line-height:1.4;margin:4px 0">${esc(row.text || '')}</div><div style="font-size:8px;color:${C.mute}">${esc(hook.title || row.videoId || '')}</div></div><b style="font-size:18px;color:${C.green};white-space:nowrap">${fmt(row.axisPercentile, 1)}th</b></div><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:9px;font-size:8.5px"><div style="background:${C.card2};padding:6px;color:${C.dim}"><b style="color:${C.text}">spoken</b><br>${fmt(row.spokenStartSeconds, 3)}s → ${fmt(row.spokenEndSeconds, 3)}s</div><div style="background:${C.card2};padding:6px;color:${C.dim}"><b style="color:${C.text}">response window</b><br>${fmt(row.responseWindowStartSeconds, 3)}s → ${fmt(row.responseWindowEndSeconds, 3)}s</div><div style="background:${C.card2};padding:6px;color:${C.dim}"><b style="color:${C.text}">entry-indexed observed − expected</b><br><span style="color:${observed >= 0 ? C.green : C.red}">${signed(observed, 5)}/s</span></div><div style="background:${C.card2};padding:6px;color:${C.dim}"><b style="color:${C.text}">held-out semantic prediction</b><br><span style="color:${predicted >= 0 ? C.green : C.red}">${signed(predicted, 5)}/s</span></div></div><div style="font-size:8px;color:${C.mute};line-height:1.55;margin-top:7px">Raw ${signed(numeric(row.rawObservedSlope) * 100, 3)} pp/s · entry-indexed ${signed(row.entryIndexedObservedSlope, 5)}/s · category-blind natural expectation ${signed(row.naturalExpectedSlopeOOF, 5)}/s.<br>Retrospective sensitivities: terminal replay ${signed(row.terminalConditionedReplayObservedSlope, 5)}/s · endpoint-affine ${signed(row.endpointAffineObservedSlope, 5)}/s · fold ${Number(row.fold) + 1}. The model input is the exact component plus its full-hook deletion influence.</div></div>`;
        }

        function deconfoundingPanel(response) {
            const audit = (response || {}).deconfoundingAudit || {};
            if (audit.status !== 'complete') return '';
            const primary = audit.primarySpecification || {};
            const resolution = audit.nativeCurveResolution || {};
            const leakage = audit.leakageAudit || {};
            const exploratory = audit.exploratoryLagGate || {};
            return `<section data-pl-deconfounding-audit style="margin:0 0 10px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:7px"><div style="min-width:300px;flex:1"><div style="font-size:11px;color:${C.text};font-weight:900">Normalization, natural-drop, and processing-delay robustness</div><div style="font-size:8.5px;color:${C.dim};line-height:1.55;margin-top:3px">The same frozen source-held-out semantic score is rechecked across four curve normalizations, four category-blind natural baselines, three ridge strengths, and every −3s to +5s response lag. Every fit and displayed rho gives each source video equal total weight. Terminal-conditioned cells are sensitivities, not training targets. ${esc(audit.processingLagConclusion || '')}</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('primary', `${esc(primary.normalizationLabel || '')} · ${esc(primary.baselineLabel || '')} · α ${fmt(primary.baselineRidgeAlpha, 0)}`, C.cyan)}${stat('served lag', `${fmt(primary.lagSeconds, 1)}s`, C.green)}${stat('source-equal rho', fmt(primary.heldoutCategoryBalancedSpearman, 3), C.text)}${stat('family max-null p', fmt(primary.familyMaxNullP, 4), C.amber)}${stat('native median step', `${fmt(resolution.medianSampleSeconds, 3)}s`, C.purple)}</div></div>${exploratory.candidate ? card(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:9px;color:${exploratory.supported ? C.green : C.amber};font-weight:900">Exploratory ${fmt(exploratory.lagSeconds, 1)}s lag gate: ${exploratory.supported ? 'passed' : 'rejected'}</div><div style="font-size:8px;color:${C.dim};line-height:1.5;margin-top:3px">${esc(exploratory.decision || '')}. ${(exploratory.failedGates || []).map(esc).join(' · ') || 'Every declared gate passed.'}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap">${stat('exploratory rho', fmt(exploratory.heldoutCategoryBalancedSpearman, 3), C.text)}${stat('family p', fmt(exploratory.familyMaxNullP, 4), C.amber)}${stat('forward − |reverse|', fmt(((exploratory.matchedForwardReverse || {}).forwardMinusAbsReverse), 3), C.cyan)}${stat('paired 95% low', fmt(((exploratory.matchedForwardReverse || {}).differenceCiLow), 3), C.purple)}</div></div>`, 'margin-bottom:9px;border-color:' + (exploratory.supported ? C.green : C.amber) + '66') : ''}<div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px;margin-bottom:9px">${card(`<div style="font-size:10px;color:${C.cyan};font-weight:900">What each normalization does to the measured curves</div><canvas data-pl-canvas="deconfounding-curves" style="width:100%;height:280px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5">One source video contributes one curve. Lines are medians; shaded ranges are source p10–p90. Entry-indexed is primary. Terminal replay and endpoint-affine use full-video future information.</div>`)}${card(`<div style="font-size:10px;color:${C.purple};font-weight:900">All ${Number(audit.testedSpecificationCount || (audit.specificationRows || []).length).toLocaleString()} specification checks</div><canvas data-pl-canvas="deconfounding-heatmap" style="width:100%;height:480px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5">Rows = normalization × natural baseline × ridge α. Columns = response lag. Red is positive held-out source-equal rho, blue negative, white zero. Gray slash means a cluster lacked eight independent videos. The black outline is the served primary cell.</div>`)}</div><div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px">${card(`<div style="font-size:10px;color:${C.green};font-weight:900">Future-free consensus across lag</div><canvas data-pl-canvas="deconfounding-lag" style="width:100%;height:270px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5">Line = median rho across only future-free specifications and all tested ridge strengths; band = full specification range. Negative time is a falsification region, not a candidate delay.</div>`)}${card(`<div style="font-size:10px;color:${C.amber};font-weight:900">Matched forward versus reverse-time controls</div><canvas data-pl-canvas="deconfounding-reverse" style="width:100%;height:270px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5">Each pair uses exactly the same finite rows. A delay claim requires the paired source-bootstrap lower 95% bound for forward rho − |reverse rho| to exceed zero after the family-wide test.</div>`)}</div>${card(`<div style="font-size:10px;color:${C.cyan};font-weight:900">Can the text-free baseline predict ordinary drop out of fold?</div><canvas data-pl-canvas="deconfounding-baselines" style="width:100%;height:250px;display:block"></canvas><div style="font-size:8px;color:${C.mute};line-height:1.5">Bars use the served entry-indexed lag and show source-mean OOF rho for each category-blind baseline and ridge α. Labels report source-equal MAE. This is the nuisance model's own validation, before semantics are fitted to its residual.</div>`, 'margin-top:9px')}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:7px;margin-top:8px;font-size:8px;line-height:1.5"><div style="border-left:3px solid ${C.green};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">PRIMARY TARGET</b><br>R(t) / R(0), so no full-video endpoint enters the target. Higher residual slope means retention fell less than the source-held-out natural expectation.</div><div style="border-left:3px solid ${C.cyan};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">NATURAL DROP</b><br>One category-blind ridge with equal total weight per source. Every trajectory feature ends one source-native sample before the component begins: median ${fmt(leakage.primaryPastTrajectoryGuardSecondsMedian, 3)}s, p10–p90 ${fmt(leakage.primaryPastTrajectoryGuardSecondsP10, 3)}–${fmt(leakage.primaryPastTrajectoryGuardSecondsP90, 3)}s.</div><div style="border-left:3px solid ${C.amber};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">REWATCH BOUNDARY</b><br>${esc(audit.claimBoundary || '')}</div></div></section>`;
        }

        function forwardResponsePanel(summary) {
            const response = (summary || {}).forwardResponse;
            if (!response || response.status !== 'complete') return '';
            const contract = response.metricContract || {};
            const selection = response.selection || {};
            const inference = selection.sourceInference || {};
            const lag = contract.lagUncertainty || {};
            const component = response.componentModel || {};
            const temporal = component.chronologicalValidation || ((response.selection || {}).chronological || {});
            const temporalInference = temporal.sourceInference || {};
            const categories = [0, 1, 2, 3];
            const direct = ((((response || {}).wholeHookModel || {}).sourceInference) || {});
            const relation = (((response.relationshipModel || {}).standaloneObservedResidualAudit || {}).sourceInference) || {};
            return `<div style="height:1px;background:${C.border};margin:16px 0"></div>
            ${card(`<div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:300px;flex:1"><div style="font-size:9px;color:${response.validated ? C.green : C.amber};font-weight:900;text-transform:uppercase">Forward response metric · ${response.validated ? 'future-replicated' : 'deconfounded diagnostic'}</div><div style="font-size:17px;color:${C.text};font-weight:900;margin-top:3px">Operational response window: ${fmt(contract.selectedLagSeconds, 1)}s added delay</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:5px">For every exact component interval [start, end], the served ruler measures [start + ${fmt(contract.selectedLagSeconds, 1)}s, end + ${fmt(contract.selectedLagSeconds, 1)}s]. Outcome = future-free entry-indexed slope minus one category-blind, source-equal, past-only natural-drop expectation. ${esc(contract.servedLagReason || '')}</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('served lag', `${fmt(contract.selectedLagSeconds, 1)}s`, C.cyan)}${stat('exploratory winner', `${fmt(contract.exploratorySelectedLagSeconds, 1)}s`, C.amber)}${stat('random-fold rho', fmt(component.heldoutCategoryBalancedSpearman, 3), C.text)}${stat('future rho', fmt(temporal.heldoutCategoryBalancedSpearman, 3), response.validated ? C.green : C.amber)}${stat('future p', fmt(temporalInference.p, 4), C.purple)}${stat('timed components', `${((response.timingAudit || {}).componentsWithExactPositiveDuration || 0)}/${(response.audit || {}).components || 0}`, C.text)}</div></div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;margin-top:9px;font-size:8.5px;line-height:1.5"><div style="border-left:3px solid ${C.cyan};padding-left:8px;color:${C.dim}"><b style="color:${C.text}">Lag evidence</b><br>Exploratory bootstrap median ${fmt(lag.medianLagSeconds, 1)}s · 10–90% ${fmt(lag.p10LagSeconds, 1)}–${fmt(lag.p90LagSeconds, 1)}s. A noisy winner is not served unless the robustness audit below passes.</div><div style="border-left:3px solid ${C.amber};padding-left:8px;color:${C.dim}"><b style="color:${C.text}">Category estimates, not four replications</b><br>Random: ${Object.entries(component.heldoutSpearmanByCategory || {}).map(([key, value]) => `C${key} ${fmt(value, 3)}`).join(' · ')}<br>Future: ${Object.entries(temporal.heldoutSpearmanByCategory || {}).map(([key, value]) => `C${key} ${fmt(value, 3)}`).join(' · ') || 'pending rebuild'}</div><div style="border-left:3px solid ${C.amber};padding-left:8px;color:${C.dim}"><b style="color:${C.text}">Scope boundary</b><br>The deployable axis uses text embeddings only. Measured pre-response trajectory isolates the training residual but is unavailable for a new unpublished hook. Whole-hook averaging and relationship searches remain separate diagnostics.</div></div>`, 'margin-bottom:10px;border-color:' + (response.validated ? C.green : C.amber) + '66')}
            ${deconfoundingPanel(response)}
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:10px;margin-bottom:10px">${card(`<div style="font-size:11px;color:${C.text};font-weight:900;margin-bottom:3px">Forward-only lag selection</div><div style="font-size:8px;color:${C.mute};margin-bottom:5px">X = seconds after the words are spoken. Y = category-balanced source-held-out rank correlation. Negative lags are shown only as reverse-time controls.</div><canvas data-pl-canvas="forward-response-lag" style="width:100%;height:260px;display:block"></canvas>`)}${card(forwardResponseInspector(summary))}</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(285px,1fr));gap:10px;margin-bottom:10px">${categories.map(category => { const count = (response.components || []).filter(row => Number(row.category) === category).length; const rho = (component.heldoutSpearmanByCategory || {})[String(category)]; return card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:4px"><div><div style="font-size:10px;color:${clusterColor(category)};font-weight:900">Cluster ${category} forward-response embedding</div><div style="font-size:8px;color:${C.mute}">X = predicted entry-indexed response at +${fmt(contract.selectedLagSeconds, 1)}s · Y = outcome-blind orthogonal semantic direction</div></div><div style="text-align:right;font-size:8px;color:${C.dim}">${count} components<br>held-out rho ${fmt(rho, 3)}</div></div><canvas data-pl-canvas="forward-response-axis" data-pl-category="${category}" style="width:100%;height:285px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:4px">Blue = worse entry-indexed slope than the past-only natural expectation; red = better. Cyan ring = the currently scored hook when present.</div>`); }).join('')}</div>`;
        }

        function hookExamplePanel(examples) {
            const rows = examples.examples || [], result = examples.machineVariantResult || {};
            if (!rows.length) return '';
            const fractions = result.bootstrapWinnerFractions || {};
            return card(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px"><div><div style="font-size:11px;font-weight:900;color:${C.text}">Frozen evaluation-only example</div><div style="font-size:8.5px;color:${C.mute};margin-top:2px">These four sentences were withheld from every fit. Two identical replays produced SHA ${esc(String((examples.deterministicReplay || {}).sha256 || '').slice(0, 12))}.</div></div><div style="font-size:9px;color:${C.green};font-weight:900">Market Hold leader: ${esc(result.winner || '-')}</div></div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:8.5px"><thead><tr>${['hook', 'Market Hold · primary', 'Hook Hold · diagnostic', 'retained-info bootstrap', 'market support', 'retained-info wins'].map(label => `<th style="text-align:left;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row => { const value = row.summary || {}; return `<tr><td style="padding:6px;border-bottom:1px solid ${C.border};min-width:260px"><button data-pl-hook-example="${esc(row.id)}" ${state.hookScoreLoading ? 'disabled' : ''} style="border:0;background:transparent;color:${state.hookScoreLoading ? C.faint : C.text};font-size:8.5px;font-weight:800;text-align:left;cursor:${state.hookScoreLoading ? 'wait' : 'pointer'};padding:0">${esc(row.text)}</button></td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${C.text};white-space:nowrap"><b>${fmt(value.marketHoldPercentile, 1)}th</b><br><span style="color:${C.mute}">${signed(value.marketHoldZ, 2)}σ · reward ${value.marketHoldReward == null ? 'withheld' : fmt(value.marketHoldReward, 3)}</span></td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${C.dim};white-space:nowrap"><b>${signed(value.holdZ, 2)}σ</b><br>${fmt(value.percentile, 1)}th</td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${C.dim};white-space:nowrap">retained info ${fmt(value.retainedInformationPercentile, 1)}th<br>${fmt(value.bootstrapP10, 1)}th to ${fmt(value.bootstrapP90, 1)}th</td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${value.marketHoldEligibleForTraining ? C.green : C.red};white-space:nowrap">${value.marketHoldEligibleForTraining ? 'eligible' : 'withheld'}<br>nearest cosine ${fmt(value.marketHoldDomainNearestCosine, 3)}</td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${fractions[row.id] == null ? C.faint : C.green};white-space:nowrap">${fractions[row.id] == null ? '-' : pct(Number(fractions[row.id]) * 100)}</td></tr>`; }).join('')}</tbody></table></div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:7px">Market Hold ranking: ${esc((result.mainAxisRanking || []).join(' → '))}. Hook Hold diagnostic ranking: ${esc((result.hookHoldDiagnosticRanking || []).join(' → '))}. These exact variants still need a randomized same-topic audience test before any causal winner claim.</div>`, 'margin-bottom:10px');
        }

        function activeHookOutcomeFocus() {
            if (state.view === 'scorer' && state.hookScoreResult) {
                return { type: 'live', result: state.hookScoreResult };
            }
            const row = selectedLibraryHook();
            return row ? { type: 'stored', row } : null;
        }

        function marketRewardRow(videoId) {
            return ((state.data.marketReward || {}).hooks || []).find(
                row => String(row.videoId) === String(videoId)
            ) || null;
        }

        function hookOutcomeValidation(target) {
            const outcomes = state.data.hookOutcomes || {};
            if (target === 'market') {
                const market = state.data.marketReward || {};
                const transfer = (market.transferValidation || {}).retention_5s || {};
                return {
                    ...transfer,
                    status: market.status || 'not-ready-for-training',
                    chronologicalValidation: {
                        heldoutSpearman: transfer.recentHalfSpearman,
                        rankPermutationP: transfer.recentHalfSpearmanP,
                    },
                };
            }
            if (target === 'survival') return ((outcomes.survivalModel || {}).validation || {});
            if (target === 'quality') {
                const model = (state.data.hookQuality || {}).model || {};
                return {
                    status: model.validationStatus || 'diagnostic-not-validated',
                    heldoutSpearman: model.heldoutSpearman,
                    familyQ: model.rankPermutationP,
                    chronologicalValidation: {
                        heldoutSpearman: model.chronologicalHeldoutSpearman,
                        rankPermutationP: model.chronologicalRankPermutationP,
                    },
                };
            }
            return ((((outcomes.hookModels || {})[target] || {}).validation) || {});
        }

        function hookOutcomePayload(focus, target) {
            if (!focus) return null;
            if (target === 'market') {
                if (focus.type === 'live') return (focus.result || {}).trainingReward || null;
                return (marketRewardRow((focus.row || {}).videoId) || {}).score || null;
            }
            if (target === 'survival') {
                if (focus.type === 'live') return (focus.result || {}).score || null;
                return (focus.row || {}).survivalScore || null;
            }
            if (target === 'quality') {
                if (focus.type === 'live') {
                    const retained = (focus.result || {}).retainedInformation || {};
                    return {
                        percentile: (retained.score || {}).percentile,
                        prediction: (retained.score || {}).axisCoordinate,
                        mapX: (retained.map || {}).x,
                        mapY: (retained.map || {}).y,
                    };
                }
                return (focus.row || {}).overallScore || null;
            }
            if (focus.type === 'live') return ((((focus.result || {}).outcomes || {}).hook || {})[target] || null);
            return (((focus.row || {}).outcomes || {})[target] || null);
        }

        function continuousMetricLegend(values, formatter, label) {
            const finite = (values || []).map(numeric).filter(Number.isFinite);
            if (!finite.length) return `<div style="font-size:7px;color:${C.faint};margin-top:3px">${esc(label)} has no finite values.</div>`;
            const [low, high] = bounds(finite), middle = (low + high) / 2;
            return `<div data-pl-continuous-legend style="margin-top:4px"><div role="img" aria-label="Blue is low ${esc(label)} and red is high ${esc(label)}" style="height:6px;border:1px solid ${C.border};background:linear-gradient(90deg,${outcomePalette.low},${outcomePalette.middle},${outcomePalette.high})"></div><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px;font-size:6.8px;margin-top:2px"><span style="color:${outcomePalette.low}">LOW ${esc(formatter(low))}</span><span style="color:${C.mute};text-align:center">${esc(label)} ${esc(formatter(middle))}</span><span style="color:${outcomePalette.high};text-align:right">HIGH ${esc(formatter(high))}</span></div></div>`;
        }

        function hookOutcomeObservedSpec(target) {
            const outcomeRows = (state.data.hookOutcomes || {}).hooks || [];
            const marketRows = (state.data.marketReward || {}).hooks || [];
            if (target === 'market') return {
                label: 'measured 5s retention',
                values: marketRows.map(row => numeric((((row || {}).outcomes || {}).retention_5s || {}).actual)),
                format: value => `${fmt(value, 1)}%`,
            };
            if (target === 'survival') return {
                label: 'observed excess carry',
                values: outcomeRows.map(row => numeric((row.survivalScore || {}).actual)),
                format: value => `${signed(value, 3)} pp/s`,
            };
            if (target === 'quality') return {
                label: 'observed retained-info residual',
                values: outcomeRows.map(row => numeric((row.overallScore || {}).observedResidual)),
                format: value => signed(value, 3),
            };
            return {
                label: `measured ${(((state.data.hookOutcomes || {}).targets || {})[target] || {}).shortLabel || target}`,
                values: outcomeRows.map(row => numeric(((row.outcomes || {})[target] || {}).actual)),
                format: value => formatHookOutcomeValue(value, target, true),
            };
        }

        function canonicalPartitionFor(videoId) {
            return (((state.data.canonicalPartitions || {}).rows || []).find(
                row => String(row.videoId) === String(videoId)
            ) || null);
        }

        function partitionForFocus(focus) {
            if (!focus) return null;
            if (focus.type === 'live') return (focus.result || {}).partition || null;
            return canonicalPartitionFor((focus.row || {}).videoId);
        }

        function boundaryTracePanel(focus) {
            const partition = partitionForFocus(focus);
            if (!partition) return '';
            const tokens = partition.tokens || [], chunks = partition.chunks || [];
            const trace = partition.boundaryTrace || {};
            const probabilities = (trace.gapCutProbabilitiesOOF || partition.boundaryProbabilities || []).map(numeric);
            const serving = (trace.gapCutProbabilitiesServing || []).map(numeric);
            const targets = trace.gapAboveNullLabels || [];
            const selectedCuts = new Set((trace.selectedCutTokenOffsets || chunks.slice(0, -1).map(row => Number(row.end))).map(Number));
            const complete = tokens.length > 0 && probabilities.length === Math.max(0, tokens.length - 1);
            const sourceLabel = focus.type === 'stored' ? 'source-held-out gap probabilities' : 'frozen serving fold-ensemble probabilities';
            return `<section data-pl-boundary-trace style="border:1px solid ${complete ? C.cyan : C.amber}55;background:${C.card};padding:11px;margin:10px 0"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:280px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Every possible token boundary · ${esc(sourceLabel)}</div><div style="font-size:14px;color:${C.text};font-weight:900;margin-top:2px">${tokens.length} tokens · ${probabilities.length} candidate gaps · ${selectedCuts.size} selected cuts</div><div style="font-size:8.5px;color:${C.dim};line-height:1.55;margin-top:3px">Each bar is the learned probability of cutting at that exact adjacent-token gap. The decoder jointly compares every compatible cut/non-cut pattern and chooses one contiguous exact cover. The visible 0.5 line is the classifier audit point only; it does not choose cuts.</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('token coverage', partition.coverage == null || Number(partition.coverage) === 1 ? 'exactly once' : 'FAILED', partition.coverage == null || Number(partition.coverage) === 1 ? C.green : C.red)}${stat('overlap', Number(partition.overlapCount || 0), Number(partition.overlapCount || 0) === 0 ? C.green : C.red)}${stat('top-two gap', fmt(partition.scoreGap, 4), C.amber)}${stat('covers compared', Number(partition.partitionsCompared || 0).toLocaleString(), C.purple)}</div></div>${complete ? `<canvas data-pl-canvas="boundary-trace" style="width:100%;height:245px;display:block;margin-top:8px"></canvas>` : `<div style="border-left:3px solid ${C.amber};padding:8px;margin-top:8px;color:${C.amber};font-size:8.5px">This older stored partition has selected-edge evidence only. Rebuild the canonical artifact to expose every rejected gap.</div>`}<div style="overflow-x:auto;margin-top:8px"><div style="display:flex;align-items:stretch;min-width:max-content;padding-bottom:4px">${tokens.map((token, index) => { const owner = Number(token.owner), chunk = chunks[owner] || {}, semantic = token.semantic || {}, probability = probabilities[index], selected = selectedCuts.has(index + 1), target = Number(targets[index]); return `<div style="display:flex;align-items:stretch"><div style="width:92px;border-bottom:4px solid ${clusterColor(chunk.category)};border-left:3px solid ${clusterColor(semantic.category)};background:${C.card2};padding:5px;box-sizing:border-box"><div style="font-size:8.5px;color:${C.text};font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(token.text || '')}">${esc(token.text || '')}</div><div style="font-size:6.8px;color:${C.mute};margin-top:2px">token ${index} · owner ${owner + 1}/C${chunk.category}<br>alone C${semantic.category}</div></div>${index < tokens.length - 1 ? `<div title="gap ${index + 1}: p(cut) ${fmt(probability, 4)}${target === 1 ? ' · geometric target above null' : ''}" style="width:48px;background:${selected ? C.cyan + '22' : 'transparent'};border-left:2px solid ${selected ? C.cyan : C.border};border-right:2px solid ${selected ? C.cyan : C.border};display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:6.8px;color:${selected ? C.cyan : C.mute};font-weight:900"><span>${selected ? 'CUT' : 'KEEP'}</span><span>${fmt(probability, 3)}</span>${serving.length ? `<span style="color:${C.faint}">serve ${fmt(serving[index], 3)}</span>` : ''}</div>` : ''}</div>`; }).join('')}</div></div><div style="font-size:7.5px;color:${C.mute};line-height:1.5;margin-top:5px"><b style="color:${C.text}">Token card bottom:</b> owning non-overlapping component category. <b style="color:${C.text}">Token card left:</b> that token embedded alone. <b style="color:${C.text}">Gap:</b> exact p(cut), selected decision, and serving probability when both stored OOF and serving traces exist. Outcomes and supplied examples enter none of these probabilities.</div></section>`;
        }

        function marketTransferPanel(focus) {
            const market = state.data.marketReward || {}, transfer = market.transferValidation || {};
            const targets = (state.data.hookOutcomes || {}).targets || {};
            const rows = [
                ['viewed_percent', (targets.viewed_percent || {}).shortLabel || 'viewed %'],
                ['retention_5s', (targets.retention_5s || {}).shortLabel || '5s retention'],
                ['average_retention', (targets.average_retention || {}).shortLabel || 'average retention'],
                ['log_views', (targets.log_views || {}).shortLabel || 'views'],
            ];
            if (!(market.hooks || []).length) return '';
            return `<section data-pl-market-transfer style="margin:10px 0"><div style="font-size:11px;color:${C.text};font-weight:900">Market Hold transfer · all four untouched owned outcomes</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin:2px 0 7px">X is the frozen external-only Market Hold z-coordinate. Y is the measured owned-channel outcome. These are transfer plots, not training fit; the selected hook is ringed in cyan.</div><div class="pl-map-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:7px">${rows.map(([target, label]) => { const validation = transfer[target] || {}, supported = supportedEvidence(validation); return `<div style="background:${C.card};border:1px solid ${supported ? C.green + '55' : C.amber + '44'};padding:8px"><div style="display:flex;justify-content:space-between;gap:6px"><b style="font-size:8.5px;color:${C.text}">${esc(label)}</b><span style="font-size:7px;color:${supported ? C.green : C.amber};font-weight:900">${supported ? 'SUPPORTED TRANSFER' : 'UNSUPPORTED'}</span></div><canvas data-pl-canvas="market-transfer" data-pl-market-target="${target}" style="width:100%;height:180px;display:block;margin-top:4px"></canvas><div style="font-size:7px;color:${C.mute}">rho ${fmt(validation.heldoutSpearman, 3)} · q ${fmt(validation.familyQ, 5)} · recent-half rho ${fmt(validation.recentHalfSpearman, 3)}</div></div>`; }).join('')}</div></section>`;
        }

        function longTitleTransferPanel(focus) {
            const outcomes = state.data.hookOutcomes || {}, transfer = outcomes.longTitleTransfer || {};
            const prior = transfer.prior || {}, corpus = prior.corpus || {}, validation = prior.validation || {};
            const targets = outcomes.targets || {}, audits = transfer.shortsTransfer || {};
            const rows = [
                ['hookHold', 'Hook Hold target'],
                ['viewed_percent', (targets.viewed_percent || {}).shortLabel || 'viewed %'],
                ['retention_5s', (targets.retention_5s || {}).shortLabel || '5s retention'],
                ['average_retention', (targets.average_retention || {}).shortLabel || 'average retention'],
                ['log_views', (targets.log_views || {}).shortLabel || 'Shorts views'],
            ];
            if (!(outcomes.hooks || []).length) return '';
            return `<section data-pl-long-title-transfer style="background:${C.card};border:1px solid ${C.amber}55;padding:10px;margin-top:8px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:280px;flex:1"><div style="font-size:8px;color:${C.amber};font-weight:900;text-transform:uppercase">Long Quant title market prior · separate, never blended</div><div style="font-size:15px;color:${C.text};font-weight:900;margin-top:2px">${Number(corpus.embeddedTitleRecords || 0).toLocaleString()} embedded long-form titles → five visible Shorts transfer tests</div><div style="font-size:8px;color:${C.dim};line-height:1.55;margin-top:3px">X is predicted long-form log10 views from the unchanged Long Quant title direction applied to each complete Shorts hook. Y is the measured Shorts target. The direction predicts long-form titles (held-out rho ${fmt(validation.heldoutSpearman, 3)}) but does not transfer to Shorts hold, so it remains a contextual prior only.</div></div><span style="font-size:7.5px;color:${C.amber};font-weight:900;border:1px solid ${C.amber}66;padding:5px 7px">INDEPENDENT · NOT BLENDED</span></div><div class="pl-map-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:7px;margin-top:8px">${rows.map(([target, label]) => { const audit = audits[target] || {}; return `<div style="background:${C.card2};padding:7px"><div style="display:flex;justify-content:space-between;gap:6px"><b style="font-size:8px;color:${C.text}">${esc(label)}</b><span style="font-size:7px;color:${C.red}">rho ${fmt(audit.spearman, 3)}</span></div><canvas data-pl-canvas="long-title-transfer" data-pl-long-title-target="${target}" style="width:100%;height:175px;display:block;margin-top:3px"></canvas><div style="font-size:6.8px;color:${C.mute}">p ${fmt(audit.spearmanP, 4)} · n ${audit.rows || 0}</div></div>`; }).join('')}</div></section>`;
        }

        function legacyAxisValueFormatter(experiment) {
            const target = String((experiment || {}).target || '');
            return value => {
                value = numeric(value);
                if (!Number.isFinite(value)) return '-';
                if (target.startsWith('transfer_')) return `${signed(value, 2)} percentile points`;
                if (target === 'measured_log_views') return `${fmt(value, 2)} log10 (about ${formatCompactNumber(10 ** value)} views)`;
                if (target === 'measured_keep_rate' || target === 'measured_avg_retention') return `${fmt(value, 1)}%`;
                if (target.includes('_slope_')) return `${signed(value * 100, 2)} pp/s`;
                if (target.startsWith('measured_hold_after_hook_')) return `${signed(value * 100, 2)} pp`;
                if (target.startsWith('measured_')) return `${fmt(value * 100, 1)}%`;
                return fmt(value, 3);
            };
        }

        function axisLineageFor(map) {
            const target = String(((map || {}).experiment || {}).target || '');
            return (((state.data.findings || {}).axis || {}).targetLineage || {})[target]
                || (((state.data.findings || {}).visualizationContract || {}).axisTargetLineage || {})[target]
                || null;
        }

        function axisHorizonPanel(map) {
            const lineage = axisLineageFor(map);
            if (!lineage) return `<div data-pl-horizon-lineage style="border-left:3px solid ${C.amber};padding:8px;color:${C.amber};font-size:8.5px">Target lineage is missing from this artifact. This axis is not presented as fully traceable until the findings artifact is rebuilt.</div>`;
            const horizon = (((state.data.findings || {}).visualizationContract || {}).semanticInputHorizon) || {};
            const window = lineage.outcomeWindow || {};
            const sourceHooks = Number(lineage.sourceHooks || horizon.sourceHooks || 0);
            const before = lineage.sourceHooksWhoseSemanticInputEndsBeforeOutcomeWindow;
            const afterCopy = before == null
                ? 'This target has no single fixed viewer-time endpoint.'
                : `${Number(before).toLocaleString()} of ${sourceHooks.toLocaleString()} source hooks stop before the target window ends.`;
            return `<section data-pl-horizon-lineage style="background:${C.card2};border:1px solid ${C.border2};padding:10px;margin:9px 0"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:280px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Input horizon versus outcome horizon</div><div style="font-size:14px;color:${C.text};font-weight:900;margin-top:2px">Hook-derived semantics stop at each exact hook endpoint</div><div style="font-size:8.5px;color:${C.dim};line-height:1.55;margin-top:3px">Semantic input: ${esc(lineage.semanticInput || '')}. Outcome label: ${esc(window.label || lineage.targetDefinition || '')}. ${esc(afterCopy)} A later target is only a measured label used to test association; it is never represented as unseen words or a post-hook semantic forecast.</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('semantic hooks', sourceHooks, C.cyan)}${stat('hook endpoints', `${fmt(horizon.minimumResponseEndSeconds, 2)}–${fmt(horizon.maximumResponseEndSeconds, 2)}s`, C.green)}${stat('target kind', window.kind || 'declared', C.amber)}${stat('claim', lineage.status || 'diagnostic', axisRandomFoldSupported((map || {}).experiment || {}) ? C.green : C.red)}</div></div><canvas data-pl-canvas="axis-horizon" style="width:100%;height:230px;display:block;margin-top:8px"></canvas><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:5px;font-size:8px;line-height:1.5"><div style="border-left:3px solid ${C.cyan};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">CYAN DISTRIBUTION</b><br>Exact response endpoint of every analyzed hook. Median ${fmt(horizon.medianResponseEndSeconds, 2)}s; maximum ${fmt(horizon.maximumResponseEndSeconds, 2)}s.</div><div style="border-left:3px solid ${C.red};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">RED TARGET</b><br>${esc(window.label || 'No fixed viewer-time window')}. ${esc(afterCopy)}</div></div></section>`;
        }

        function visualizationContractPanel() {
            const contract = (state.data.findings || {}).visualizationContract;
            if (!contract) return '';
            const horizon = contract.semanticInputHorizon || {}, assertions = contract.assertions || {};
            return `<section data-pl-visualization-contract style="border:1px solid ${contract.status === 'complete' ? C.green : C.amber}66;background:${C.card};padding:11px;margin:0 0 10px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:300px;flex:1"><div style="font-size:8px;color:${C.green};font-weight:900;text-transform:uppercase">Visualization completeness contract</div><div style="font-size:17px;color:${C.text};font-weight:900;margin-top:2px">Every emitted analytical channel has a named visible graph</div><div style="font-size:8.5px;color:${C.dim};line-height:1.55;margin-top:4px">The contract is generated from the artifacts, not a hand-maintained UI promise. Semantic curves contain ${esc((horizon.outputPositionsPerHook || []).join(', '))} positions per hook, stop at ${fmt(horizon.minimumResponseEndSeconds, 2)}–${fmt(horizon.maximumResponseEndSeconds, 2)}s, and contain ${Number(assertions.postHookSemanticOutputs || 0)} post-hook semantic outputs.</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('channels', (contract.channels || []).length, C.cyan)}${stat('axis lineage', `${assertions.axisTargetsWithLineage || 0}/${assertions.axisTargetsWithMaps || 0}`, C.green)}${stat('boundary traces', `${assertions.boundaryHooksWithTraces || 0}/${assertions.boundaryHooks || 0}`, C.green)}${stat('post-hook outputs', assertions.postHookSemanticOutputs || 0, Number(assertions.postHookSemanticOutputs || 0) === 0 ? C.green : C.red)}</div></div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:7px;margin-top:9px">${(contract.channels || []).map(row => { const destination = ['multi-resolution-lattice', 'attention-relational-graph'].includes(row.id) ? 'lattice' : row.id === 'research-contract' ? 'contract' : row.view && row.view.startsWith('Outcome') ? 'axes' : row.view && row.view.includes('library') ? 'library' : 'scorer'; return `<button data-pl-contract-view="${destination}" style="text-align:left;background:${C.card2};border:1px solid ${C.border};padding:8px;cursor:pointer"><div style="display:flex;justify-content:space-between;gap:6px"><b style="font-size:8.5px;color:${C.text}">${esc(row.label || row.id || '')}</b><b style="font-size:8px;color:${C.cyan}">${Number(row.graphs || 0).toLocaleString()} graph${Number(row.graphs || 0) === 1 ? '' : 's'}</b></div><div style="font-size:7.5px;color:${C.dim};line-height:1.45;margin-top:3px">${Number(row.outputs || 0).toLocaleString()} outputs · ${esc(row.visibleAs || '')}<br><span style="color:${C.mute}">${esc(row.view || '')}</span></div></button>`; }).join('')}</div></section>`;
        }

        function outcomePredictionStrip(focus) {
            if (!focus) return '';
            const targets = (state.data.hookOutcomes || {}).targets || {};
            return `<div class="pl-outcome-strip" style="display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:8px;margin-bottom:10px">${hookOutcomeOrder.map(target => {
                const meta = targets[target] || {}, value = hookOutcomePayload(focus, target) || {};
                const prediction = focus.type === 'live' ? value.prediction : value.predictedOOF;
                const actual = focus.type === 'stored' ? value.actual : null;
                const validation = hookOutcomeValidation(target);
                return `<div style="background:${C.card};border:1px solid ${validationColor(validation)}55;padding:10px;min-width:0"><div style="display:flex;justify-content:space-between;gap:6px;align-items:center"><span style="font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase">${esc(meta.shortLabel || target)}</span><span style="font-size:7px;color:${validationColor(validation)};font-weight:900">${validationLabel(validation)}</span></div><div style="font-size:20px;color:${C.text};font-weight:900;margin-top:4px">${esc(formatHookOutcomeValue(prediction, target))}</div><div style="font-size:8px;color:${C.dim};line-height:1.5;margin-top:3px">${focus.type === 'stored' ? `OOF prediction · actual <b style="color:${C.text}">${esc(formatHookOutcomeValue(actual, target))}</b><br>error ${esc(signed(numeric(actual) - numeric(prediction), target === 'log_views' ? 3 : 1))}${target === 'log_views' ? ' log10' : ' pp'}` : `prediction interval ${esc(formatHookOutcomeValue(value.predictionP10, target, true))} to ${esc(formatHookOutcomeValue(value.predictionP90, target, true))}`}<br>held-out rho ${fmt(validation.heldoutSpearman, 3)} · q ${fmt(validation.familyQ, 4)}</div></div>`;
            }).join('')}</div>`;
        }

        function marketScoreCard(focus) {
            if (!focus) return '';
            const market = state.data.marketReward || {};
            const score = hookOutcomePayload(focus, 'market') || {};
            const transfer = (market.transferValidation || {}).retention_5s || {};
            const calibrated = score.calibratedOutcomes || {};
            const supportColor = score.eligibleForTraining ? (score.domainBelowCautionP10 ? C.amber : C.green) : C.red;
            return `<section style="border:1px solid ${supportColor}66;background:${C.card};padding:11px;margin:0 0 10px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:280px;flex:1"><div style="font-size:8px;color:${C.green};font-weight:900;text-transform:uppercase">Primary frozen training proxy · text only</div><div style="display:flex;gap:12px;align-items:baseline;margin-top:3px"><b style="font-size:28px;color:${C.text}">${fmt(score.percentile, 1)}th</b><span style="font-size:12px;color:${numeric(score.z) >= 0 ? C.green : C.red};font-weight:900">${signed(score.z, 2)}σ</span></div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:3px">One complete-hook Gemini text embedding → one frozen direction learned on ${Number((market.externalTraining || {}).nonOwnedTrainingRows || 0).toLocaleString()} non-owned first-five-second transcripts → percentile on that unchanged external ladder. Component and pair values are literal deletions on this same coordinate.</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('reward', score.reward == null ? 'withheld' : fmt(score.reward, 3), score.reward == null ? C.red : C.green)}${stat('5s transfer rho', fmt(transfer.heldoutSpearman, 3), C.green)}${stat('recent-half rho', fmt(transfer.recentHalfSpearman, 3), C.green)}${stat('family q', fmt(transfer.familyQ, 5), C.purple)}${stat('nearest cosine', fmt(score.domainNearestCosine, 3), supportColor)}</div></div><div style="height:1px;background:${C.border};margin:9px 0"></div><div style="font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${supportColor}">${score.eligibleForTraining ? (score.domainBelowCautionP10 ? 'ELIGIBLE · LOW SUPPORT CAUTION' : 'ELIGIBLE FOR TRAINING') : 'REWARD WITHHELD · OUTSIDE MEASURED SUPPORT'}</b> · hard floor ${fmt(score.domainFloor ?? (market.domainGate || {}).nearestCosineMinimum, 3)} · visible p10 caution ${fmt(score.domainCautionP10 ?? (market.domainGate || {}).nearestCosineP10, 3)}<br>Calibrated diagnostics: viewed ${formatHookOutcomeValue((calibrated.viewed_percent || {}).prediction, 'viewed_percent')} · 5s retention ${formatHookOutcomeValue((calibrated.retention_5s || {}).prediction, 'retention_5s')} · average retention ${formatHookOutcomeValue((calibrated.average_retention || {}).prediction, 'average_retention')}. Owned raw views did not transfer and are not presented as a supported prediction.</div></section>`;
        }

        function outcomePointInspector() {
            const row = ((state.data.hookOutcomes || {}).hooks || []).find(value =>
                String(value.videoId) === String(state.outcomePointVideoId));
            if (!row) return '';
            const market = (marketRewardRow(row.videoId) || {}).score || {};
            return `<div style="border:1px solid ${C.cyan}55;background:${C.card2};padding:9px;margin:0 0 10px"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Selected training point</div><div style="font-size:11px;color:${C.text};font-weight:900;margin-top:3px">${esc(row.title || row.videoId || '')}</div><div style="font-size:9px;color:${C.dim};line-height:1.5;margin-top:2px">${esc(row.text || '')}</div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:8px;color:${C.mute}"><span>Market Hold <b style="color:${C.green}">${fmt(market.percentile, 1)}th</b> · ${signed(market.z, 2)}σ</span><span>Hook Hold diagnostic <b style="color:${C.amber}">${signed((row.survivalScore || {}).holdZ, 2)}σ</b> predicted / ${signed((row.survivalScore || {}).actualHoldZ, 2)}σ measured</span>${hookOutcomeOrder.map(target => { const value = (row.outcomes || {})[target] || {}; return `<span>${esc(((state.data.hookOutcomes || {}).targets || {})[target]?.shortLabel || target)} <b style="color:${C.text}">${esc(formatHookOutcomeValue(value.predictedOOF, target, true))}</b> predicted / ${esc(formatHookOutcomeValue(value.actual, target, true))} actual</span>`; }).join('')}</div></div>`;
        }

        function hookOutcomeAxisGallery(focus) {
            const outcomes = state.data.hookOutcomes || {}, targets = outcomes.targets || {};
            const axes = [
                { id: 'market', label: 'Market Hold · training reward', definition: 'one external-only transcript-to-market direction; validated here against untouched five-second retention' },
                { id: 'survival', label: 'Hook Hold z-score', definition: 'unbounded standardized coordinate of future-free entry-indexed excess per-second carry; diagnostic until future and normalization gates pass' },
                { id: 'quality', label: 'Retained information diagnostic', definition: 'random-fold broad complete-hook coordinate that did not replicate forward in time' },
                ...hookOutcomeOrder.map(id => ({ id, label: (targets[id] || {}).shortLabel || id, definition: (targets[id] || {}).definition || '' }))];
            return `<div style="margin:14px 0 10px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:7px"><div><div style="font-size:12px;color:${C.text};font-weight:900">All seven complete-hook embedding planes</div><div style="font-size:8.5px;color:${C.mute};margin-top:2px">Every point is one of ${Number((outcomes.hooks || []).length).toLocaleString()} hooks. X is the named frozen score; Y is its orthogonal semantic direction. Market Hold is colored by measured five-second retention; other planes use their declared observed target. A cyan ring is the current hook.</div></div><div style="font-size:8px;color:${C.dim}">Click a training point to inspect predicted versus actual without leaving this view.</div></div><div class="pl-map-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:8px">${axes.map(axis => {
                const validation = hookOutcomeValidation(axis.id), value = hookOutcomePayload(focus, axis.id) || {};
                const observedSpec = hookOutcomeObservedSpec(axis.id);
                const prediction = axis.id === 'market' ? value.percentile : axis.id === 'survival' ? value.holdZ : axis.id === 'quality' ? value.percentile : (focus && focus.type === 'stored' ? value.predictedOOF : value.prediction);
                const display = ['market', 'quality', 'survival'].includes(axis.id)
                    ? (Number.isFinite(numeric(prediction)) ? (axis.id === 'survival' ? `${signed(prediction, 2)}σ` : `${fmt(prediction, 1)}th`) : '-')
                    : formatHookOutcomeValue(prediction, axis.id);
                return `<section style="background:${C.card};border:1px solid ${validationColor(validation)}44;padding:9px;min-width:0"><div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start"><div><div style="font-size:9px;color:${C.text};font-weight:900">${esc(axis.label)}</div><div style="font-size:7.5px;color:${C.mute};line-height:1.4;margin-top:2px">${esc(axis.definition)}</div></div><div style="text-align:right;white-space:nowrap"><b style="font-size:13px;color:${C.cyan}">${esc(display)}</b><div style="font-size:7px;color:${validationColor(validation)};font-weight:900">${validationLabel(validation)}</div></div></div><div style="display:flex;justify-content:space-between;gap:6px;font-size:6.8px;color:${C.mute};margin-top:5px"><span>← lower ${esc(axis.label)}</span><span>higher ${esc(axis.label)} →</span></div><canvas data-pl-canvas="hook-outcome-axis" data-pl-outcome-target="${axis.id}" style="width:100%;height:220px;display:block"></canvas><div style="font-size:6.8px;color:${C.faint};text-align:center">X = named score · Y = outcome-blind orthogonal semantic coordinate</div>${continuousMetricLegend(observedSpec.values, observedSpec.format, observedSpec.label)}<div style="font-size:7.5px;color:${C.mute};margin-top:3px">held-out rho ${fmt(validation.heldoutSpearman, 3)} · q ${fmt(validation.familyQ, 4)}</div></section>`;
            }).join('')}</div></div>${outcomePointInspector()}`;
        }

        function availableRetentionModes(forecast) {
            const declared = (forecast || {}).availableCurveModes;
            if (Array.isArray(declared) && declared.length) return declared;
            return (forecast || {}).normalizationAvailable === true
                ? ['entry', 'absolute', 'terminal'] : ['absolute'];
        }

        function retentionMode(forecast) {
            const available = availableRetentionModes(forecast);
            return available.includes(state.retentionCurveMode)
                ? state.retentionCurveMode : available[0];
        }

        function retentionWordTable(forecast) {
            const words = (forecast || {}).words || [];
            if (!words.length) return '';
            const mode = retentionMode(forecast);
            const selectedIndex = Math.max(0, Math.min(words.length - 1, Number(state.forecastWordIndex || 0)));
            const selected = words[selectedIndex] || {};
            const contribution = (mode === 'entry'
                ? selected.entryIndexedForecastDeletionContributionByTime
                : mode === 'terminal'
                    ? selected.rewatchAdjustedForecastDeletionContributionByTime
                    : selected.observedForecastDeletionContributionByTime) || [];
            const coordinates = selected.singletonCategoryCoordinates4D || [];
            const distribution = selected.singletonCategoryDistribution || [];
            const frozenWordLabel = selected.singletonFrozenAtlasCategory == null
                ? 'not available for new text'
                : `C${selected.singletonFrozenAtlasCategory}`;
            return `<div style="margin-top:10px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:5px"><div><div style="font-size:10px;color:${C.text};font-weight:900">Every word · exact singleton embedding and forecast trace</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Top border = owning component category. Left border = this word embedded alone. Cyan outline = selection, never another cluster.</div></div><div style="font-size:8px;color:${C.cyan};font-weight:900">${words.length} / ${words.length} WORDS EXPOSED</div></div><div style="overflow:auto"><div style="display:flex;gap:4px;min-width:max-content;padding-bottom:4px">${words.map((word, index) => {
                const actual = numeric(mode === 'entry' ? word.entryIndexedActualRetentionPercent : mode === 'terminal' ? word.terminalConditionedActualRetentionPercent : word.observedAbsoluteActualRetentionPercent);
                const predicted = numeric(mode === 'entry' ? word.entryIndexedPredictedRetentionPercent : mode === 'terminal' ? word.terminalConditionedPredictedRetentionPercent : word.observedAbsolutePredictedRetentionPercent);
                const active = index === selectedIndex;
                return `<button data-pl-forecast-word="${index}" style="width:118px;border:1px solid ${active ? C.cyan : C.border};border-top:4px solid ${clusterColor(word.componentCategory)};border-left:4px solid ${clusterColor(word.singletonCategory)};background:${active ? C.cyan + '12' : C.card2};padding:6px;box-sizing:border-box;text-align:left;cursor:pointer"><div style="font-size:9px;color:${C.text};font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(word.text || '')}">${esc(word.text || '')}</div><div style="font-size:7px;color:${C.dim};line-height:1.45;margin-top:3px">word C${word.singletonCategory} · component ${Number(word.component) + 1}/C${word.componentCategory}<br>x ${fmt(word.singletonEmbeddingX, 2)} · y ${fmt(word.singletonEmbeddingY, 2)}<br>response ${fmt(word.responseSeconds, 2)}s · pred ${pct(predicted)}${Number.isFinite(actual) ? `<br>actual ${pct(actual)} · <b style="color:${actual >= predicted ? C.green : C.red}">${signed(actual - predicted, 1)} pp</b>` : ''}</div></button>`;
            }).join('')}</div></div><div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px;margin-top:8px"><div style="border-left:3px solid ${clusterColor(selected.singletonCategory)};background:${C.card2};padding:9px"><div style="font-size:8px;color:${clusterColor(selected.singletonCategory)};font-weight:900;text-transform:uppercase">Selected word ${selectedIndex + 1}/${words.length} · singleton cluster ${selected.singletonCategory}</div><div style="font-size:15px;color:${C.text};font-weight:900;margin:3px 0">${esc(selected.singletonEmbeddingInput || selected.text || '')}</div><div style="font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Exact embedding input:</b> ${esc(selected.singletonEmbeddingInput || '')}<br><b style="color:${C.text}">Word-alone assignment:</b> C${selected.singletonCategory} at ${fmt(Number(selected.singletonCategoryProbability || 0) * 100, 2)}% · frozen atlas label ${esc(frozenWordLabel)}<br><b style="color:${C.text}">Four-category probabilities:</b> ${distribution.map((value, index) => `C${index} ${fmt(Number(value) * 100, 2)}%`).join(' · ')}<br><b style="color:${C.text}">Whitened 4D:</b> [${coordinates.map(value => fmt(value, 4)).join(', ')}]<br><b style="color:${C.text}">Saved 2D:</b> x ${fmt(selected.singletonEmbeddingX, 5)} · y ${fmt(selected.singletonEmbeddingY, 5)}<br><b style="color:${C.text}">Owner:</b> component ${Number(selected.component) + 1}, C${selected.componentCategory}: ${esc(selected.componentText || '')}<br><b style="color:${C.text}">Timing:</b> spoken ${fmt(selected.spokenStartSeconds, 3)}–${fmt(selected.spokenEndSeconds, 3)}s · response ${fmt(selected.responseSeconds, 3)}s</div><canvas data-pl-canvas="word-embedding-map" style="width:100%;height:260px;display:block;margin-top:7px"></canvas><div style="font-size:7.5px;color:${C.mute};margin-top:3px">All ${Number(((state.data.hookOutcomes || {}).wordEmbeddingAtlas || {}).points?.length || 0).toLocaleString()} stored lexical singleton embeddings. Colors are only C0–C3. Cyan ring is this selected word.</div></div><div style="background:${C.card2};padding:9px"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Selected word → all 41 within-hook outputs</div><div style="font-size:12px;color:${C.text};font-weight:900;margin:3px 0">Local deletion contribution from hook start to analyzed endpoint</div><canvas data-pl-canvas="word-forecast-contribution" style="width:100%;height:260px;display:block;margin-top:7px"></canvas><div style="font-size:8px;color:${C.dim};line-height:1.55;margin-top:4px"><b style="color:${C.text}">Formula:</b> forecast(complete hook) − forecast(the same hook with only “${esc(selected.singletonEmbeddingInput || '')}” deleted). Positive means the word raises predicted retention at that within-hook position; negative lowers it. ${contribution.length} stored values are shown. This is a local deletion diagnostic, not an additive or causal word score.</div></div></div></div>`;
        }

        function forecastArchitecturePanel(forecast) {
            const input = (forecast || {}).forecastInput || {};
            const projection = (state.data.hookOutcomes || {}).semanticProjection || {};
            const trace = (state.data.hookOutcomes || {}).semanticTraceValidation || {};
            if (!input.text) return '';
            const frozenInputLabel = input.frozenAtlasCategory == null
                ? 'not available for new text'
                : `C${input.frozenAtlasCategory}`;
            return `<div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.05fr) minmax(300px,.95fr);gap:9px;margin-top:9px"><div style="background:${C.card2};padding:10px;border-left:3px solid ${clusterColor(input.category)}"><div style="font-size:8px;color:${clusterColor(input.category)};font-weight:900;text-transform:uppercase">Complete-hook forecast input · semantic C${input.category}</div><div style="font-size:10px;color:${C.text};font-weight:800;line-height:1.45;margin:4px 0">${esc(input.text || '')}</div><div style="font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Exact model input:</b> complete hook text above<br><b style="color:${C.text}">Embedding:</b> ${esc(input.embeddingModel || '')}, ${Number(input.embeddingDimensions || 0).toLocaleString()} dimensions<br><b style="color:${C.text}">Input semantic assignment:</b> C${input.category}, ${fmt(Number(input.categoryProbability || 0) * 100, 2)}% · frozen atlas ${esc(frozenInputLabel)}<br><b style="color:${C.text}">Saved plane:</b> ${esc(projection.methodLabel || projection.methodId || '')} · x ${fmt(input.mapX, 5)} · y ${fmt(input.mapY, 5)}<br><b style="color:${C.text}">Forecast:</b> ${esc(input.formula || '')}</div><canvas data-pl-canvas="forecast-input-map" style="width:100%;height:250px;display:block;margin-top:7px"></canvas><div style="font-size:7.5px;color:${C.mute};margin-top:3px">All ${Number((((state.data.hookOutcomes || {}).hooks) || []).length).toLocaleString()} stored complete-hook inputs. Category colors are C0–C3; the cyan ring is the current input. Serving/frozen agreement: words ${pct(Number(trace.singletonCategoryAgreementWithFrozenAtlas || 0) * 100)}, complete hooks ${pct(Number(trace.fullHookCategoryAgreementWithFrozenAtlas || 0) * 100)}.</div></div><div style="background:${C.card2};padding:10px;border-left:3px solid ${C.cyan}"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Hook-only retention outputs</div><div style="font-size:16px;color:${C.text};font-weight:900;margin:4px 0">41 normalized hook positions</div><div style="font-size:9px;color:${C.dim};line-height:1.65">The same complete-hook embedding produces one retention value at 0%, 2.5%, …, 100% of the analyzed hook. Each source maps that normalized grid to its own exact hook seconds, ending at ${fmt(forecast.responseEndSeconds, 2)}s here.<br><br><b style="color:${C.text}">Scope:</b> every output is inside the analyzed word/component window. The model produces no value after the final hook response and does not infer unseen transcript.<br><br><b style="color:${C.text}">Cyan means:</b> predicted line or selected-point ring only.<br><b style="color:${C.text}">Cluster vocabulary:</b> exactly C0, C1, C2, C3.</div><div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:10px">${[0,1,2,3].map(category => `<span style="border-left:4px solid ${clusterColor(category)};padding:4px 6px;background:${C.card};font-size:8px;color:${C.text};font-weight:900">C${category}</span>`).join('')}<span style="border:1px solid ${C.cyan};padding:4px 6px;font-size:8px;color:${C.cyan};font-weight:900">CYAN RING/LINE = SELECTION/PREDICTION</span></div></div></div>`;
        }

        function retentionForecastPanel(forecast, stored = false) {
            if (!forecast) return '';
            const model = (state.data.hookOutcomes || {}).curveModel || {};
            const availableModes = availableRetentionModes(forecast);
            const mode = retentionMode(forecast);
            const validation = mode === 'entry'
                ? (forecast.entryIndexedValidation || model.entryIndexedValidation || {})
                : mode === 'terminal'
                    ? (forecast.terminalConditionedValidation || model.rewatchAdjustedValidation || {})
                    : (forecast.observedAbsoluteValidation || model.validation || {});
            const speaking = forecast.speakingRate || model.speakingRate || {};
            const responseEnd = numeric(forecast.responseEndSeconds);
            const titleBase = mode === 'entry'
                ? 'Future-free entry-indexed retention by second and by word'
                : mode === 'terminal'
                    ? 'Terminal-conditioned replay sensitivity by second and by word'
                    : (stored ? 'Observed absolute retention by second and by word' : 'Text-only observed-retention forecast');
            const title = `${validationLabel(validation)} · ${titleBase}`;
            const modeControls = `${availableModes.includes('entry') ? button('Entry-indexed · primary', 'data-pl-retention-mode="entry"', mode === 'entry') : ''}${availableModes.includes('absolute') ? button('Observed absolute', 'data-pl-retention-mode="absolute"', mode === 'absolute') : ''}${availableModes.includes('terminal') ? button('Terminal sensitivity', 'data-pl-retention-mode="terminal"', mode === 'terminal') : ''}`;
            const modeNote = mode === 'entry'
                ? 'R_entry(t) = 100 × R(t) / R(0); no full-video endpoint enters this curve.'
                : mode === 'terminal'
                    ? `C(t) = max(R(0) − 100, 0) × clip((R(t) − F) / (R(0) − F), 0, 1); R_terminal(t) = R(t) − C(t). F = ${pct(forecast.terminalRetentionPercent)} · correction at hook end ${pct((forecast.replayCorrectionPercent || []).slice(-1)[0])}; retrospective only.`
                    : (forecast.measuredCurveAvailable
                        ? 'R_absolute(t) = R(t); measured aggregate retention with entry inflation and replay left intact.'
                        : 'R_absolute(t) = predicted aggregate R(t); text-only forecast with no observed audience curve.');
            const unavailableNote = !availableModes.includes('terminal')
                ? `<span style="font-size:7.5px;color:${C.amber};border:1px solid ${C.amber}66;padding:5px 7px;font-weight:900">TERMINAL SENSITIVITY UNAVAILABLE · MEASURED CURVE REQUIRED</span>` : '';
            return `<section style="border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};padding:12px 0;margin:12px 0"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:280px;flex:1"><div style="font-size:12px;color:${C.text};font-weight:900">${title}</div><div style="font-size:8.5px;color:${C.dim};line-height:1.5;margin-top:3px">${stored ? 'Cyan is the source-held-out forecast; green is the measured curve.' : 'Cyan is a rough frozen-model forecast from text; it is not a measured retention curve.'} Word response points use ${esc(forecast.wordTimingPolicy || 'library-average speaking rate')} and the selected ${fmt(forecast.responseLagSeconds == null ? 0 : forecast.responseLagSeconds, 1)}s diagnostic lag.</div><div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:7px">${modeControls}${unavailableNote}<span style="font-size:7.5px;color:${C.mute}">${modeNote}</span></div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('curve MAE', `${fmt(validation.heldoutMAEPercentagePoints, 2)} pp`, C.cyan)}${stat('baseline MAE', `${fmt(validation.baselineMAEPercentagePoints, 2)} pp`, C.dim)}${stat('improvement', pct(Number(validation.maeImprovementFraction || 0) * 100), C.green)}${stat('timewise rho', fmt(validation.meanTimewiseSpearman, 3), C.purple)}${stat('average speech', `${fmt(speaking.meanWordsPerSecond, 2)} words/s`, C.amber)}</div></div>${forecastArchitecturePanel(forecast)}<canvas data-pl-canvas="retention-forecast" style="width:100%;height:360px;display:block;margin-top:9px"></canvas><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:6px;font-size:8px;line-height:1.5"><div style="border-left:2px solid ${C.green};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">WORDS AND COMPONENTS</b><br>0 → ${fmt(forecast.spokenHookEndSeconds, 2)}s. Every visible word belongs to exactly one non-overlapping component.</div><div style="border-left:2px solid ${C.cyan};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">${stored ? 'OBSERVED HOOK WINDOW' : 'MODELED HOOK WINDOW'}</b><br>Ends at ${fmt(responseEnd, 2)}s. The 41 normalized outputs stop here; the model emits nothing after this endpoint.</div></div><div style="font-size:8px;color:${C.mute};margin-top:6px">Band coverage ${pct(Number(validation.empiricalBandCoverage || 0) * 100)} · paired improvement p ${fmt((validation.pairedImprovementInference || {}).p, 4)} · 41 model positions from 0% to 100% of each source's analyzed hook. ${stored ? 'The measured source curve is interpolated only inside that hook window and the cyan line is source-held-out.' : 'This text-only line is a random-fold population forecast only inside the estimated hook window.'} It remains observational, not causal.</div>${retentionWordTable(forecast)}</section>`;
        }

        function survivalScoreCard(score, stored = false) {
            if (!score) return '';
            const validation = hookOutcomeValidation('survival');
            const promoted = String(validation.status || '').startsWith('validated');
            const residualStd = numeric(validation.residualStd);
            const p10z = (numeric(score.predictionP10) - numeric((score.scoreScale || {}).predictionMean)) / Math.max(numeric((score.scoreScale || {}).predictionStd), 1e-9);
            const p90z = (numeric(score.predictionP90) - numeric((score.scoreScale || {}).predictionMean)) / Math.max(numeric((score.scoreScale || {}).predictionStd), 1e-9);
            return card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:280px;flex:1"><div style="font-size:8px;color:${promoted ? C.green : C.amber};font-weight:900;text-transform:uppercase">${promoted ? 'Validated hook indicator' : 'Hook Hold diagnostic · not the training reward'}</div><div style="font-size:23px;color:${C.text};font-weight:900;margin-top:2px">Hook Hold ${signed(score.holdZ, 2)}σ</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:4px">Zero is the mean model prediction among the current measured-hook calibration set; +1σ is one standard deviation higher on the frozen hold direction. The target is entry-indexed retention through the exact analyzed hook, with no full-video terminal anchor. ${fmt(score.percentile, 1)}th is retained only as the current-library rank. ${stored ? `Measured target ${signed(score.actualHoldZ, 2)}σ · error ${signed(score.errorStandardDeviations, 2)} residual σ.` : 'A new text input has no measured outcome; the interval is empirical out-of-fold uncertainty.'}</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('hold lift', `${signed(score.predictedHoldLiftPercentagePoints, 2)} pp`, C.cyan)}${stat('predicted entry-indexed end', pct(score.predictedEntryIndexedRetentionAtResponseEnd), C.green)}${stat('duration baseline', pct(score.durationBaselineRetentionAtResponseEnd), C.dim)}${stat('80% empirical range', `${signed(p10z, 2)}σ to ${signed(p90z, 2)}σ`, C.purple)}${stat('response end', `${fmt(score.responseEndSeconds, 2)}s`, C.amber)}</div></div><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:9px;font-size:8.5px;line-height:1.5"><div style="border-left:2px solid ${C.cyan};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">RAW COORDINATE</b><br>Predicted excess entry-indexed geometric carry per second after subtracting the duration-only expectation.</div><div style="border-left:2px solid ${C.purple};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">STANDARDIZATION</b><br>(raw prediction − OOF mean) ÷ OOF prediction SD. Residual SD is ${fmt(residualStd, 3)} carry points/s.</div><div style="border-left:2px solid ${C.amber};padding-left:7px;color:${C.dim}"><b style="color:${C.text}">CLAIM BOUNDARY</b><br>Future-free with respect to terminal retention, but still observational and not a universal hook score until future-only and normalization gates pass.</div></div>`, 'margin-bottom:10px;border-color:' + (promoted ? C.green : C.amber) + '66');
        }

        function predictionAccuracyPanel(focus) {
            const outcomes = state.data.hookOutcomes || {}, targets = outcomes.targets || {};
            const axes = [
                { id: 'survival', label: 'Hook Hold', unit: 'carry pp/s' },
                ...hookOutcomeOrder.map(id => ({ id, label: (targets[id] || {}).shortLabel || id, unit: id === 'log_views' ? 'log10 views' : 'percentage points' })),
            ];
            const cards = axes.map(axis => {
                const validation = hookOutcomeValidation(axis.id), value = hookOutcomePayload(focus, axis.id) || {};
                const prediction = axis.id === 'survival'
                    ? numeric(value.predictedOOF ?? value.prediction)
                    : numeric(focus && focus.type === 'stored' ? value.predictedOOF : value.prediction);
                const actual = focus && focus.type === 'stored' ? numeric(value.actual) : NaN;
                const currentError = Number.isFinite(prediction) && Number.isFinite(actual) ? Math.abs(actual - prediction) : NaN;
                const factor = axis.id === 'log_views' ? `<br>median multiplicative error ×${fmt(validation.multiplicativeErrorP50, 2)} · 80% ×${fmt(validation.multiplicativeErrorP80, 2)}` : '';
                return `<section style="background:${C.card};border:1px solid ${validationColor(validation)}44;padding:9px;min-width:0"><div style="display:flex;justify-content:space-between;gap:6px"><div><div style="font-size:9px;color:${C.text};font-weight:900">${esc(axis.label)}</div><div style="font-size:7px;color:${C.mute}">X predicted · Y observed · OOF only</div></div><div style="text-align:right;font-size:7px;color:${validationColor(validation)};font-weight:900">${validationLabel(validation)}<br>n ${validation.rows || 0}</div></div><canvas data-pl-canvas="prediction-calibration" data-pl-calibration-target="${axis.id}" style="width:100%;height:190px;display:block;margin-top:5px"></canvas><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;margin-top:5px"><span style="font-size:7px;color:${C.dim}">rho <b style="color:${C.text}">${fmt(validation.heldoutSpearman, 3)}</b></span><span style="font-size:7px;color:${C.dim}">R² <b style="color:${C.text}">${fmt(validation.heldoutR2, 3)}</b></span><span style="font-size:7px;color:${C.dim}">RMSE <b style="color:${C.text}">${fmt(validation.heldoutRMSE, 2)}</b></span><span style="font-size:7px;color:${C.dim}">cal slope <b style="color:${C.text}">${fmt(validation.calibrationSlope, 2)}</b></span><span style="font-size:7px;color:${C.dim}">signal/error <b style="color:${C.text}">${fmt(validation.signalToErrorRatio, 2)}</b></span><span style="font-size:7px;color:${C.dim}">median |error| <b style="color:${C.text}">${fmt(validation.absoluteErrorP50, 2)}</b></span></div><div style="font-size:7.5px;color:${C.mute};line-height:1.45;margin-top:5px">Within residual SD: 0.5σ ${pct(Number(validation.coverageWithinHalfResidualSD || 0) * 100)} · 1σ ${pct(Number(validation.coverageWithinOneResidualSD || 0) * 100)} · 2σ ${pct(Number(validation.coverageWithinTwoResidualSD || 0) * 100)}${factor}${Number.isFinite(currentError) ? `<br><b style="color:${C.cyan}">Selected hook |error| ${fmt(currentError, 2)} ${axis.unit}</b>` : ''}</div></section>`;
            }).join('');
            const curve = (outcomes.curveModel || {}).rewatchAdjustedValidation || {};
            const prior = outcomes.longTitleTransfer || {}, priorTransfer = (prior.shortsTransfer || {}).hookHold || {}, corpus = ((prior.prior || {}).corpus || {}), priorValidation = ((prior.prior || {}).validation || {});
            return `<section style="margin:12px 0"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:7px"><div><div style="font-size:13px;color:${C.text};font-weight:900">Out-of-fold prediction accuracy and uncertainty</div><div style="font-size:8.5px;color:${C.mute};line-height:1.5;margin-top:2px">Every dot was predicted by a model that did not train on that hook. The diagonal is perfect calibration; large vertical spread is uncertainty. Signal/error is prediction SD ÷ residual RMSE, a forecast analogue for the requested Sharpe-style question, not a financial Sharpe ratio.</div></div><div style="font-size:8px;color:${C.dim}">Calibration slope ideal = 1 · R² ideal = 1 · coverage is empirical, not Gaussian</div></div><div class="pl-map-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">${cards}</div><div class="pl-split" style="display:grid;grid-template-columns:minmax(280px,1.2fr) minmax(280px,.8fr);gap:8px;margin-top:8px"><div style="background:${C.card};padding:9px"><div style="font-size:9px;color:${C.text};font-weight:900">Retention-curve error by normalized hook position</div><canvas data-pl-canvas="curve-accuracy" style="width:100%;height:220px;display:block;margin-top:4px"></canvas><div style="font-size:7.5px;color:${C.mute};line-height:1.45;margin-top:4px">Cyan = hook-text model MAE; gray = text-free baseline MAE. X is 0–100% of each source's own analyzed hook, not a shared number of seconds. Source curve MAE: median ${fmt(curve.sourceMAEP50PercentagePoints, 2)} pp · 80% ${fmt(curve.sourceMAEP80PercentagePoints, 2)} pp · 90% ${fmt(curve.sourceMAEP90PercentagePoints, 2)} pp.</div></div><div style="background:${C.card};padding:9px;border-left:3px solid ${C.amber}"><div style="font-size:8px;color:${C.amber};font-weight:900;text-transform:uppercase">Long Quant title market prior · separate channel</div><div style="font-size:17px;color:${C.text};font-weight:900;margin:3px 0">${Number(corpus.embeddedTitleRecords || 0).toLocaleString()} embedded / ${Number(corpus.storedLongFormRecords || 0).toLocaleString()} stored titles</div><div style="font-size:8px;color:${C.dim};line-height:1.6">The frozen 1536D Long Quant title direction predicts long-form log views with held-out rho <b style="color:${C.text}">${fmt(priorValidation.heldoutSpearman, 3)}</b> and RMSE ${fmt(priorValidation.heldoutRMSELog10Views, 3)} log10 views. Applied unchanged to these Shorts hooks, its hold correlation is only <b style="color:${C.red}">${fmt(priorTransfer.spearman, 3)}</b>. It is therefore visible as a market-context prior but <b style="color:${C.amber}">not blended into Hook Hold</b>. Stored records without an embedding are not silently counted as modeled titles.</div></div></div>${longTitleTransferPanel(focus)}</section>`;
        }

        function survivalMethodPanel() {
            const outcomes = state.data.hookOutcomes || {}, audit = outcomes.rewatchAudit || {};
            const survival = outcomes.survivalModel || {};
            const validation = survival.validation || {};
            const sensitivity = survival.normalizationSensitivity || {};
            const entryNormalized = sensitivity.entryNormalizedNoFutureAnchor || {};
            const terminalConditioned = sensitivity.terminalConditioned || {};
            const temporal = validation.chronologicalValidation || {};
            const scope = audit.scope || {}, entry = audit.entryInflationVsTerminal || {}, opening = audit.entryInflationVsOpeningThreeSecondSlope || {};
            const geometry = audit.geometryValidation || {}, terminalModel = audit.terminalToEntryModel || {};
            const promoted = String(validation.status || '').startsWith('validated');
            return card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px"><div style="min-width:300px;flex:1"><div style="font-size:9px;color:${promoted ? C.green : C.amber};font-weight:900;text-transform:uppercase">Hook Hold method audit · ${promoted ? 'robust' : 'diagnostic only'}</div><div style="font-size:16px;color:${C.text};font-weight:900;margin-top:2px">Entry-indexed hook survival → duration-neutral text axis</div><div style="font-size:9px;color:${C.dim};line-height:1.6;margin-top:4px">Primary target: <b style="color:${C.text}">R entry(t) = 100 × R(t) / R(0)</b>, then geometric carry per second through the exact hook endpoint minus the train-fold duration-only expectation. No full-video endpoint enters that score. The terminal-conditioned replay envelope below is retained only to test whether the conclusion survives a plausible retrospective correction; it is never the headline target.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('entry OOF rho', fmt(validation.heldoutSpearman, 3), C.text)}${stat('future-only rho', fmt(temporal.heldoutSpearman, 3), temporal.heldoutSpearman > 0 ? C.green : C.red)}${stat('terminal sensitivity rho', fmt(terminalConditioned.heldoutSpearman, 3), C.amber)}${stat('robust to target', sensitivity.robustAcrossNormalizationChoices ? 'yes' : 'no', sensitivity.robustAcrossNormalizationChoices ? C.green : C.red)}${stat('invented rises', geometry.correctionInducedIncreaseIntervals ?? '-', geometry.correctionInducedIncreaseIntervals === 0 ? C.green : C.red)}</div></div><div style="border-left:3px solid ${promoted ? C.green : C.amber};padding:8px 10px;background:${promoted ? C.green : C.amber}0d;color:${C.dim};font-size:9px;line-height:1.6;margin-bottom:9px"><b style="color:${promoted ? C.green : C.amber}">${promoted ? 'PROMOTED' : 'HOOK HOLD IS NOT THE TRAINING REWARD'}</b><br>Random folds alone are not enough. Promotion requires positive future-only transfer, robustness across chronological block counts, and survival of the declared normalization family. Market Hold remains the separately validated training proxy shown above.</div><div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:10px"><div><canvas data-pl-canvas="replay-correction" style="width:100%;height:260px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:4px">Retrospective sensitivity only. X = normalized analyzed-hook progress from 0% to 100%. Y = additive percentage points subtracted. Line = source-equal median across ${scope.videos || 208} measured hooks; band = 10th–90th percentile. Source endpoints range ${fmt(scope.minimumResponseEndSeconds, 2)}–${fmt(scope.maximumResponseEndSeconds, 2)}s.</div></div><div style="font-size:8.5px;color:${C.dim};line-height:1.65"><b style="color:${C.text}">Observed replay evidence</b><br>Terminal retention ↔ start inflation: rho <b style="color:${C.text}">${fmt(entry.spearman, 3)}</b>, p ${fmt(entry.spearmanP, 4)}. Association supports a replay hypothesis but cannot identify replay counts or a first-pass curve.<br><br><b style="color:${C.text}">Geometry checks</b><br>Start error ${fmt(geometry.maximumStartErrorPercentagePoints, 6)} pp · negative corrections ${geometry.negativeCorrectionValues ?? '-'} · correction-induced rises ${geometry.correctionInducedIncreaseIntervals ?? '-'} · endpoint correction ${fmt(geometry.maximumFullVideoEndpointCorrectionPercentagePoints, 4)} pp.<br><br><b style="color:${C.text}">Target sensitivity</b><br>Terminal-conditioned versus entry-indexed prediction rho ${fmt((sensitivity.terminalVsEntryPrediction || {}).spearman, 3)}. Target rho ${fmt((sensitivity.terminalVsEntryTarget || {}).spearman, 3)}. A stable semantic direction should not reverse under this declared retrospective alternative.</div></div>`, 'margin-bottom:10px;border-color:' + (promoted ? C.green : C.amber) + '55');
        }

        function partitionMethodPanel(summary) {
            const partition = (summary || {}).partition || {}, validation = partition.validation || {};
            const boundary = partition.boundaryModel || {};
            const categoryMapId = String(((state.data.canonicalPartitions || {}).mapId)
                || ((state.data.manualProjection || {}).mapId) || 'unavailable');
            const histogram = Object.entries(validation.componentCountHistogram || {})
                .map(([count, hooks]) => ({ count: Number(count), hooks: Number(hooks) }))
                .sort((left, right) => left.count - right.count);
            const largest = Math.max(1, ...histogram.map(row => row.hooks));
            return card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:300px;flex:1"><div style="font-size:9px;color:${C.cyan};font-weight:900;text-transform:uppercase">Category-blind partition contract</div><div style="font-size:16px;color:${C.text};font-weight:900;margin-top:2px">Variable non-overlapping components, then a conditional four-label overlay</div><div style="font-size:9px;color:${C.dim};line-height:1.6;margin-top:4px">Every token gap receives a source-held-out semantic cut probability from eight category-blind contrast features. The decoder chooses the maximum-posterior contiguous exact cover. It has no required count, maximum count, duration rule, supplied phrase feature, outcome, or tuned split penalty. After boundaries are fixed, categories are assigned from retained map <b style="color:${C.text};font-family:monospace">${esc(categoryMapId)}</b>, read from the saved canonical-partition artifact and selected post hoc using the manual probe. Those four labels are useful conditional coordinates, not an independently discovered taxonomy.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('observed range', `${validation.minimumComponents || '-'}–${validation.maximumComponents || '-'}`, C.cyan)}${stat('median', fmt(validation.medianComponents, 1), C.green)}${stat('mean', fmt(validation.meanComponents, 2), C.text)}${stat('boundary AUC', fmt(boundary.heldoutAuc ?? validation.boundaryHeldoutAuc, 3), C.purple)}${stat('boundary AP', fmt(boundary.heldoutAveragePrecision ?? validation.boundaryHeldoutAveragePrecision, 3), C.amber)}</div></div><div style="margin-top:10px"><div style="font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin-bottom:5px">Observed component counts across ${Number((summary.model || {}).trainingHooks || 0)} held-out hooks</div><div style="display:flex;align-items:flex-end;gap:4px;height:82px;overflow-x:auto;padding-bottom:3px">${histogram.map(row => `<div title="${row.hooks} hooks have ${row.count} components" style="flex:1 0 28px;min-width:28px;text-align:center"><div style="font-size:7px;color:${C.dim};margin-bottom:2px">${row.hooks}</div><div style="height:${Math.max(3, row.hooks / largest * 52)}px;background:${C.cyan};opacity:.78"></div><b style="font-size:8px;color:${C.text}">${row.count}</b></div>`).join('')}</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:5px">X = emergent components per hook; label above each bar = source hooks. ${validation.hooksUsingAllFourCategories || 0} hooks use all four labels; that is observed, not constrained. Serving averages fold-specific models whose regularization is selected inside training data; raw cut posteriors enter the decoder without thresholding or recentering.</div></div>`, 'margin-bottom:10px;border-color:' + C.cyan + '55');
        }

        function componentMetricValue(component, axis, focusType) {
            if (!component) return null;
            if (axis === 'market') {
                const row = component.marketHoldContribution || {};
                const validation = hookOutcomeValidation('market');
                return { percentile: row.percentile, coordinate: row.effectZ, status: validation.status, rho: validation.heldoutSpearman };
            }
            if (axis === 'hold') {
                const row = component.hookHoldContribution || {};
                const validation = ((state.data.hookOutcomes || {}).survivalModel || {}).validation || {};
                return { percentile: row.categoryPercentile, coordinate: row.effectHoldZ, status: validation.status, rho: validation.heldoutSpearman };
            }
            if (axis === 'broad') {
                const row = focusType === 'live' ? component : component.broadRetainedInformation || {};
                const qualityStatus = (((state.data.hookQuality || {}).model || {}).validationStatus) || 'diagnostic-attribution';
                return { percentile: focusType === 'live' ? row.categoryContributionPercentile : row.percentile, coordinate: focusType === 'live' ? row.retainedInformationDeletionEffect : row.deletionEffect, status: qualityStatus };
            }
            if (axis === 'forward') {
                const row = component.forwardResponse || {};
                const responseStatus = (state.data.forwardResponse || {}).validationStatus || 'conditional-diagnostic';
                return { percentile: focusType === 'live' ? row.percentile : row.axisPercentile, coordinate: row.axisCoordinate, status: responseStatus, rho: row.heldoutSpearmanForCategory };
            }
            const row = focusType === 'live' ? ((component.outcomePredictions || {})[axis] || {}) : ((component.outcomes || {})[axis] || {});
            return { ...row, coordinate: focusType === 'live' ? row.prediction : row.predictedOOF, status: (row.validation || {}).status || row.validationStatus, rho: (row.validation || {}).heldoutSpearman ?? row.heldoutSpearman };
        }

        function componentObservedSpec(category, axis) {
            const values = [];
            ((state.data.hookOutcomes || {}).hooks || []).forEach(source => (source.components || []).forEach(component => {
                if (Number(component.category) !== Number(category)) return;
                if (axis === 'market') values.push(numeric((((marketRewardRow(source.videoId) || {}).outcomes || {}).retention_5s || {}).actual));
                else if (axis === 'hold') values.push(numeric((source.survivalScore || {}).actual));
                else if (axis === 'broad') values.push(numeric((source.overallScore || {}).observedResidual));
                else if (axis === 'forward') values.push(numeric((component.forwardResponse || {}).unexpectedObservedSlope));
                else values.push(numeric(((component.outcomes || {})[axis] || {}).actual));
            }));
            const targets = (state.data.hookOutcomes || {}).targets || {};
            if (axis === 'market') return { values, label: 'measured 5s retention', format: value => `${fmt(value, 1)}%` };
            if (axis === 'hold') return { values, label: 'observed excess carry', format: value => `${signed(value, 3)} pp/s` };
            if (axis === 'broad') return { values, label: 'observed retained-info residual', format: value => signed(value, 3) };
            if (axis === 'forward') return { values, label: 'unexpected normalized slope', format: value => `${signed(value, 4)}/s` };
            return { values, label: `measured ${(targets[axis] || {}).shortLabel || axis}`, format: value => formatHookOutcomeValue(value, axis, true) };
        }

        function componentOutcomePointInspector() {
            if (!state.outcomeComponentPointKey) return '';
            const [videoId, componentIndex] = String(state.outcomeComponentPointKey).split(':');
            const row = ((state.data.hookOutcomes || {}).hooks || []).find(value => String(value.videoId) === videoId);
            const component = row && (row.components || [])[Number(componentIndex)];
            if (!row || !component) return '';
            const market = (((marketRewardRow(row.videoId) || {}).components || [])[Number(componentIndex)] || {});
            return `<div style="border:1px solid ${clusterColor(component.category)}88;background:${C.card2};padding:9px;margin-bottom:8px"><div style="font-size:8px;color:${clusterColor(component.category)};font-weight:900">SELECTED TRAINING COMPONENT · CLUSTER ${component.category}</div><div style="font-size:11px;color:${C.text};font-weight:900;margin-top:3px">${esc(component.text || '')}</div><div style="font-size:8px;color:${C.mute};margin-top:2px">${esc(row.title || row.videoId || '')} · tokens ${component.startToken}-${component.endToken}</div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:8px;color:${C.dim}"><span>Market effect <b style="color:${numeric(market.effectZ) >= 0 ? C.green : C.red}">${signed(market.effectZ, 2)}σ</b> · ${fmt(market.percentile, 1)}th</span><span>Hook Hold diagnostic <b style="color:${numeric((component.hookHoldContribution || {}).effectHoldZ) >= 0 ? C.green : C.red}">${signed((component.hookHoldContribution || {}).effectHoldZ, 2)}σ</b></span><span>broad <b style="color:${C.text}">${fmt((component.broadRetainedInformation || {}).percentile, 1)}th</b></span><span>component response <b style="color:${C.text}">${fmt((component.forwardResponse || {}).axisPercentile, 1)}th</b></span>${hookOutcomeOrder.map(target => `<span>${esc((((state.data.hookOutcomes || {}).targets || {})[target] || {}).shortLabel || target)} <b style="color:${C.text}">${fmt(((component.outcomes || {})[target] || {}).percentile, 1)}th</b></span>`).join('')}</div></div>`;
        }

        function componentScoreGallery(focus) {
            if (!focus) return '';
            const rawComponents = focus.type === 'live' ? ((focus.result || {}).components || []) : ((focus.row || {}).components || []);
            const storedMarket = focus.type === 'stored' ? marketRewardRow((focus.row || {}).videoId) : null;
            const components = rawComponents.map((component, index) => ({
                ...component,
                marketHoldContribution: component.marketHoldContribution || ((storedMarket || {}).components || [])[index],
            }));
            if (!components.length) return '';
            const targets = (state.data.hookOutcomes || {}).targets || {};
            const selectedLag = Number((
                ((state.data.forwardResponse || {}).metricContract || {}).selectedLagSeconds
            ) || 0);
            const axes = [
                { id: 'market', label: 'Market Hold component deletion effect · primary', note: 'X = frozen training score(full) minus frozen training score(without component), in Market Hold σ; Y = the standalone semantic background coordinate.' },
                { id: 'hold', label: 'Hook Hold component deletion effect · diagnostic', note: 'X = diagnostic Hook Hold(full) minus Hook Hold(without component), in Hook Hold σ; Y = the component semantic background coordinate.' },
                { id: 'broad', label: 'Broad retained-information deletion effect', note: 'X = attribution on the random-fold-only complete-hook diagnostic; Y = standalone semantic coordinate.' },
                { id: 'forward', label: `${selectedLag >= 0 ? '+' : ''}${fmt(selectedLag, 1)}s component-response diagnostic`, note: 'X = category-conditioned response coordinate; Y = orthogonal semantic direction. The lag and semantic response both failed promotion.' },
                ...hookOutcomeOrder.map(id => ({ id, label: `${(targets[id] || {}).shortLabel || id} component diagnostic`, note: 'X = category-specific predicted outcome; Y = orthogonal semantic direction.' })),
            ];
            return `<div style="margin:14px 0"><div style="font-size:12px;color:${C.text};font-weight:900">Every component score in its actual cluster plane</div><div style="font-size:8.5px;color:${C.mute};line-height:1.5;margin:3px 0 9px">Each row is one scoring channel and contains all ${components.length} naturally selected components. Scroll sideways when the hook has more components. Each map compares the selected component only with training components carrying the same frozen category label; categories may repeat or be absent.</div>${componentOutcomePointInspector()}${axes.map(axis => `<section style="border-top:1px solid ${C.border};padding-top:9px;margin-top:9px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:6px"><div><div style="font-size:10px;color:${C.text};font-weight:900">${esc(axis.label)}</div><div style="font-size:7.5px;color:${C.mute}">${esc(axis.note)}</div></div><div style="font-size:7.5px;color:${C.cyan};font-weight:900">${components.length} COMPONENT MAPS →</div></div><div class="pl-component-map-strip" style="display:flex;gap:7px;overflow-x:auto;overscroll-behavior-x:contain;padding-bottom:7px">${components.map((component, index) => {
                const value = componentMetricValue(component, axis.id, focus.type) || {};
                const status = String(value.status || 'diagnostic-not-validated');
                const color = status.startsWith('validated') ? C.green : C.amber;
                const display = ['market', 'hold'].includes(axis.id) ? `${signed(value.coordinate, 2)}σ` : ['broad', 'forward'].includes(axis.id) ? `${fmt(value.percentile, 1)}th` : formatHookOutcomeValue(value.coordinate, axis.id);
                const observedSpec = componentObservedSpec(component.category, axis.id);
                return `<div style="flex:0 0 290px;background:${C.card};border:1px solid ${color}44;padding:8px;min-width:0"><div style="display:flex;justify-content:space-between;gap:6px"><div style="min-width:0"><div style="font-size:8px;color:${clusterColor(component.category)};font-weight:900">COMPONENT ${index + 1} · CLUSTER ${component.category}</div><div title="${esc(component.text || '')}" style="font-size:8px;color:${C.text};font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">${esc(component.text || '')}</div></div><div style="text-align:right;white-space:nowrap"><b style="font-size:12px;color:${C.cyan}">${esc(display)}</b><div style="font-size:6.5px;color:${color};font-weight:900">${status.startsWith('validated') ? 'VALIDATED' : 'DIAGNOSTIC'}</div></div></div><div style="display:flex;justify-content:space-between;gap:4px;font-size:6.6px;color:${C.mute};margin-top:4px"><span>← lower named score</span><span>higher named score →</span></div><canvas data-pl-canvas="component-score-axis" data-pl-component-index="${index}" data-pl-component-category="${component.category}" data-pl-component-axis="${axis.id}" style="width:100%;height:190px;display:block"></canvas><div style="font-size:6.8px;color:${C.faint};text-align:center">X = named component score · Y = orthogonal semantic coordinate</div>${continuousMetricLegend(observedSpec.values, observedSpec.format, observedSpec.label)}<div style="font-size:7px;color:${C.mute};margin-top:2px">${axis.id === 'broad' ? `deletion effect ${signed(value.coordinate, 4)}` : axis.id === 'forward' ? `axis ${signed(value.coordinate, 4)} · rho ${fmt(value.rho, 3)}` : `percentile ${fmt(value.percentile, 1)}th · rho ${fmt(value.rho, 3)}`}</div></div>`;
            }).join('')}</div></section>`).join('')}</div>`;
        }

        function libraryRelationships(row) {
            const components = row.components || [], relationships = row.relationships || [];
            const lookup = Object.fromEntries(relationships.map(value => [`${value.left}-${value.right}`, value]));
            const marketLookup = Object.fromEntries((((marketRewardRow(row.videoId) || {}).relationships) || []).map(value => [`${value.left}-${value.right}`, value]));
            return `<div style="overflow:auto;max-height:520px"><table style="width:max-content;min-width:100%;border-collapse:collapse;font-size:8px"><thead><tr><th style="padding:4px;color:${C.mute};position:sticky;left:0;background:${C.card2};z-index:1">component</th>${components.map((component, index) => `<th style="min-width:52px;padding:4px;color:${clusterColor(component.category)}">${index + 1}</th>`).join('')}</tr></thead><tbody>${components.map((component, left) => `<tr><th style="padding:4px;color:${clusterColor(component.category)};position:sticky;left:0;background:${C.card2}">${left + 1}</th>${components.map((_, right) => { const key = `${Math.min(left, right)}-${Math.max(left, right)}`, value = left === right ? null : lookup[key], market = left === right ? null : marketLookup[key], response = value && value.forwardResponse || {}, hold = value && value.hookHoldInteraction || {}, marketValue = market && numeric(market.interactionZ); return `<td style="min-width:52px;padding:6px;text-align:center;border:1px solid ${C.border};background:${market ? (marketValue >= 0 ? C.green : C.red) + '12' : 'transparent'};color:${market ? C.text : C.faint}" title="${market ? esc(market.categorySequence || '') : ''}">${market ? `<b style="color:${marketValue >= 0 ? C.green : C.red}">${signed(marketValue, 2)}σ</b><br><span style="color:${C.mute}">${fmt(market.percentile, 0)}th · Hook diag ${signed(hold.interactionHoldZ, 1)}σ · response ${fmt(response.axisPercentile, 0)}th</span>` : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
        }

        function activeLatticeDetail() {
            if (state.view === 'scorer') return (state.hookScoreResult || {}).componentLattice || null;
            if (state.view === 'library') {
                return String(state.latticeVideoId || '') === String(state.hookLibrarySelectedId || '')
                    ? state.latticeDetail : null;
            }
            return state.latticeDetail;
        }

        function latticeResolutionMatch(node) {
            if (state.latticeResolution === 'all') return true;
            if (state.latticeResolution === 'timestamp') {
                return (node.resolutions || []).some(value => String(value).startsWith('timestamp-'));
            }
            return (node.resolutions || []).includes(state.latticeResolution);
        }

        function visibleLatticeNodes(detail) {
            const query = state.latticeQuery.trim().toLowerCase();
            return (detail.nodes || []).filter(node => latticeResolutionMatch(node)
                && (!query || String(node.text || '').toLowerCase().includes(query)));
        }

        function latticePoint(node) {
            const maps = node.maps || {};
            const key = state.latticeRepresentation;
            return Object.prototype.hasOwnProperty.call(maps, key) ? maps[key] : (maps.raw || null);
        }

        function latticeEdgeMeasurement(edge) {
            if (edge.type === 'semantic') return `z-scored 4D distance ${fmt(edge.distance, 4)}`;
            if (edge.type === 'context') return `full-hook change norm ${fmt(edge.changeNorm, 4)}`;
            if (edge.type === 'title') return `component/idea cosine ${fmt(edge.cosine, 4)}`;
            if (edge.type === 'sequence') return `token distance ${edge.tokenDistance == null ? '-' : edge.tokenDistance} · time ${fmt(edge.temporalDistanceSeconds, 3)}s`;
            if (edge.type === 'containment') return `parent/child token delta ${edge.tokenDelta == null ? '-' : edge.tokenDelta}`;
            if (edge.type === 'outcome') return `${edge.evaluationEligible === false ? 'inference only' : `held-out fold ${edge.fold}`} · predicted ${fmt(edge.prediction, 3)}${edge.actual == null ? '' : ` · actual ${fmt(edge.actual, 3)}`}`;
            return 'registered relation';
        }

        function latticeNodeInspector(detail) {
            const nodes = detail.nodes || [];
            const node = nodes.find(row => row.id === state.latticeNodeId)
                || nodes.find(row => (row.resolutions || []).includes('full-hook')) || nodes[0];
            if (!node) return `<div style="font-size:9px;color:${C.dim}">No component selected.</div>`;
            const source = String(detail.text || '');
            const highlighted = `${esc(source.slice(0, node.charStart))}<mark style="background:${clusterColor(node.category)}33;color:${C.text};padding:1px 2px">${esc(source.slice(node.charStart, node.charEnd))}</mark>${esc(source.slice(node.charEnd))}`;
            const representationRows = Object.entries(node.representations || {}).map(([name, row]) => `<tr><td style="padding:4px;border-bottom:1px solid ${C.border};color:${C.text};font-weight:800">${esc(name)}</td><td style="padding:4px;border-bottom:1px solid ${C.border};color:${C.dim};font-family:monospace">${esc(row.formula || '')}</td><td style="padding:4px;border-bottom:1px solid ${C.border};color:${row.degenerate ? C.amber : C.mute}">${row.degenerate ? 'exact zero' : row.norm == null ? esc(String(row.vectorHash || '').slice(0, 12)) : fmt(row.norm, 4)}</td></tr>`).join('');
            const relations = node.relations || {}, attention = node.descriptiveAttention || {};
            const incident = (detail.edges || []).filter(edge => edge.source === node.id || edge.target === node.id);
            return `<div data-pl-lattice-inspector style="height:100%;overflow:auto;padding:10px;background:${C.card2};border-left:2px solid ${clusterColor(node.category)}"><div style="font-size:8px;color:${clusterColor(node.category)};font-weight:900;text-transform:uppercase">${esc(node.id)} · cluster ${node.category} · ${esc(node.candidateStatus)}</div><div style="font-size:14px;color:${C.text};font-weight:900;line-height:1.4;margin-top:3px">${esc(node.text)}</div><div style="font-size:8px;color:${C.mute};margin-top:3px">tokens ${node.start}-${node.end} · ${fmt(node.spokenStartSeconds, 3)}s → ${fmt(node.spokenEndSeconds, 3)}s · ${esc(node.timingSource || '')}</div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${(node.resolutions || []).map(value => `<span style="font-size:7px;color:${C.cyan};border:1px solid ${C.cyan}55;padding:2px 4px">${esc(value)}</span>`).join('')}</div>${(node.rejectionReasons || []).length ? `<div style="font-size:8px;color:${C.red};margin-top:5px">retained rejection: ${(node.rejectionReasons || []).map(esc).join(', ')}</div>` : ''}<div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:8px">${highlighted}</div><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin-top:9px;font-size:8px;color:${C.dim}"><div>component/context cosine<br><b style="color:${C.text}">${fmt(relations.componentContextCosine, 4)}</b></div><div>context change norm<br><b style="color:${C.text}">${fmt(relations.contextChangeNorm, 4)}</b></div><div>component/idea cosine<br><b style="color:${C.text}">${fmt(relations.componentIdeaCosine, 4)}</b></div><div>category confidence<br><b style="color:${C.text}">${pct(Number(node.categoryProbability || 0) * 100)}</b></div></div><div style="font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin:10px 0 3px">Outcome-blind descriptive channels</div><div style="font-size:8px;color:${C.dim};line-height:1.5">context change ${fmt(attention.contextChangePercentileWithinHook, 1)}th · semantic centrality ${fmt(attention.semanticCentralityPercentileWithinHook, 1)}th · resolution support ${pct(Number(attention.resolutionSupportFraction || 0) * 100)} · aggregate: none</div><div style="font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin:10px 0 3px">All representation traces</div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:7.5px"><tbody>${representationRows}</tbody></table></div><div style="font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin:10px 0 3px">Incident graph edges · ${incident.length}</div><div style="max-height:220px;overflow:auto">${incident.slice(0, 80).map(edge => `<button data-pl-lattice-edge-node="${esc(edge.source === node.id ? edge.target : edge.source)}" style="display:block;width:100%;text-align:left;border:0;border-top:1px solid ${C.border};background:transparent;color:${C.dim};padding:5px 4px;font-size:7.5px;cursor:pointer"><b style="color:${C.text}">${esc(edge.type)}</b> · ${esc(edge.source === node.id ? edge.target : edge.source)}<br><span style="color:${C.cyan}">${esc(latticeEdgeMeasurement(edge))}</span><br><span style="color:${C.mute};font-family:monospace">${esc(edge.formula || edge.provenance || '')}</span></button>`).join('')}</div></div>`;
        }

        function renderLatticeSurface(detail, label) {
            if (!detail) {
                if (state.latticeError) return card(`<div style="font-size:9px;color:${C.red}">${esc(state.latticeError)}</div>`);
                return card(`<div style="font-size:9px;color:${C.cyan}">${state.latticeLoading ? 'Loading exact component lattice…' : 'Select a hook to load its component lattice.'}</div>`);
            }
            const resolutions = ['all', ...Object.keys(detail.resolutionDefinitions || {})];
            const edgeTypes = ['containment', 'sequence', 'semantic', 'context', 'title', 'outcome'];
            const nodes = visibleLatticeNodes(detail);
            const partition = detail.partitionContract || {};
            const canonicalIds = new Set(partition.canonicalComponentNodeIds || []);
            const canonicalNodes = (detail.nodes || []).filter(node => canonicalIds.has(node.id));
            const nodeById = Object.fromEntries((detail.nodes || []).map(node => [node.id, node]));
            const combinations = detail.selectedCombinations || [];
            const mapDefinitions = detail.mapDefinitions || { raw: { formula: 'E(S)', basis: 'frozen category plane' } };
            const selectedMapDefinition = mapDefinitions[state.latticeRepresentation] || {};
            return `<section data-pl-lattice-surface style="margin:12px 0"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px"><div style="min-width:300px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">${esc(label || detail.sourceKind || 'component lattice')} · shared scientific path</div><div style="font-size:15px;color:${C.text};font-weight:900;margin-top:2px">${Number(detail.spanCount || 0).toLocaleString()} components across every source-preserving resolution</div><div style="font-size:8.5px;color:${C.dim};line-height:1.55;margin-top:3px">The corpus and typed predictor call <b style="color:${C.text}">${esc((detail.parityContract || {}).sharedBuilder || '')}</b>. Only exact-versus-estimated timing, held-out evaluation-versus-live inference, and the optional idea anchor may differ.</div></div><div style="display:flex;gap:7px;flex-wrap:wrap">${stat('tokens', detail.tokenCount || 0, C.cyan)}${stat('nodes shown', `${nodes.length}/${detail.spanCount || 0}`, C.green)}${stat('graph edges', Number((detail.edges || []).length).toLocaleString(), C.purple)}${stat('timing', (detail.timingContract || {}).exact ? 'exact' : 'estimated', (detail.timingContract || {}).exact ? C.green : C.amber)}</div></div>
            ${card(`<div class="pl-lattice-controls" style="display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr);gap:8px"><label><span style="display:block;font-size:7.5px;color:${C.mute};font-weight:900;margin-bottom:3px">FILTER EXACT COMPONENT TEXT</span><input data-pl-query="lattice" value="${esc(state.latticeQuery)}" placeholder="filter without changing the graph" style="width:100%;box-sizing:border-box;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:6px 8px;font-size:9px"></label><div><div style="font-size:7.5px;color:${C.mute};font-weight:900;margin-bottom:3px">EMBEDDING PLANE · ${Object.keys(mapDefinitions).length} REGISTERED REPRESENTATIONS</div><div style="display:flex;gap:4px;flex-wrap:wrap">${Object.keys(mapDefinitions).map(value => button(value, `data-pl-lattice-representation="${value}"`, state.latticeRepresentation === value)).join('')}</div></div></div><div style="font-size:8px;color:${C.dim};line-height:1.5;margin-top:7px"><b style="color:${C.text}">${esc(state.latticeRepresentation)}</b> = ${esc(selectedMapDefinition.formula || '')} · plane basis: ${esc(selectedMapDefinition.basis || '')}</div><div style="font-size:7.5px;color:${C.mute};font-weight:900;margin:8px 0 3px">RESOLUTION</div><div style="display:flex;gap:4px;flex-wrap:wrap">${resolutions.map(value => button(value, `data-pl-lattice-resolution="${value}"`, state.latticeResolution === value)).join('')}</div><div style="font-size:7.5px;color:${C.mute};font-weight:900;margin:8px 0 3px">RELATIONAL EDGE FAMILY</div><div style="display:flex;gap:4px;flex-wrap:wrap">${edgeTypes.map(value => button(`${value} ${(detail.edgeCounts || {})[value] || 0}`, `data-pl-lattice-edge="${value}"`, state.latticeEdgeType === value)).join('')}</div>`, 'margin-bottom:9px')}
            ${card(`<div style="font-size:9px;color:${C.text};font-weight:900;margin-bottom:5px">Exact analyzed source and token timing</div><div style="display:flex;gap:3px;overflow-x:auto;padding-bottom:5px">${(detail.tokens || []).map(token => `<button data-pl-lattice-node="span:${token.index}:${token.index + 1}" title="${fmt(token.spokenStartSeconds, 3)}s to ${fmt(token.spokenEndSeconds, 3)}s" style="flex:0 0 auto;border:1px solid ${state.latticeNodeId === `span:${token.index}:${token.index + 1}` ? C.cyan : C.border};border-bottom:3px solid ${clusterColor((((detail.nodes || []).find(node => node.id === `span:${token.index}:${token.index + 1}`)) || {}).category)};background:${C.card2};color:${C.text};padding:5px 6px;font-size:8px;cursor:pointer">${esc(token.text)}</button>`).join('')}</div><div style="font-size:7.5px;color:${C.mute};margin-top:4px">${esc((detail.timingContract || {}).claimBoundary || '')}</div>`, 'margin-bottom:9px')}
            ${card(`<div style="display:grid;grid-template-columns:auto 1fr auto 1fr auto;gap:7px;align-items:center"><div style="font-size:8px;color:${C.cyan};font-weight:900">EXACT SOURCE<br><b style="font-size:15px;color:${C.text}">${detail.tokenCount || 0}</b> tokens</div><div style="height:1px;background:${C.border}"></div><div style="font-size:8px;color:${C.purple};font-weight:900">EXHAUSTIVE LATTICE<br><b style="font-size:15px;color:${C.text}">${Number(partition.candidateNodes || detail.spanCount || 0).toLocaleString()}</b> spans</div><div style="height:1px;background:${C.border}"></div><div style="font-size:8px;color:${C.green};font-weight:900">SCORED EXACT COVER<br><b style="font-size:15px;color:${C.text}">${partition.canonicalComponentCount || canonicalNodes.length}</b> components</div></div><div style="display:flex;gap:4px;overflow-x:auto;margin-top:8px;padding-bottom:4px">${canonicalNodes.map(node => `<button data-pl-lattice-node="${esc(node.id)}" style="flex:${Math.max(1, Number(node.tokenCount || 1))} 0 90px;min-width:90px;border:1px solid ${clusterColor(node.category)}88;border-left:4px solid ${clusterColor(node.category)};background:${C.card2};color:${C.text};padding:6px;text-align:left;cursor:pointer"><span style="font-size:7px;color:${clusterColor(node.category)};font-weight:900">C${node.category} · ${node.start}:${node.end}</span><br><span style="font-size:8px;font-weight:800;line-height:1.35">${esc(node.text)}</span></button>`).join('')}</div><div style="font-size:7.5px;color:${C.mute};line-height:1.5;margin-top:4px">${esc(partition.scoringRole || '')} Selection mode: ${esc(partition.selectionMode || '')}; outcomes used for boundaries: ${partition.selectionUsesOutcomes === false ? 'no' : 'unknown'}.</div>`, 'margin-bottom:9px')}
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.35fr) minmax(310px,.65fr);gap:9px;margin-bottom:9px"><div>${card(`<div style="display:flex;justify-content:space-between;gap:8px"><div><div style="font-size:10px;color:${C.text};font-weight:900">${esc(state.latticeRepresentation)} embedding plane</div><div style="font-size:7.5px;color:${C.mute}">Every point is an exact component with a nonzero vector in this plane; exact-zero vectors stay unplotted. Color is the frozen unlabeled category. Click a point.</div></div><div style="font-size:8px;color:${C.cyan}">${nodes.filter(node => Array.isArray(latticePoint(node))).length}/${nodes.length} points</div></div><canvas data-pl-canvas="lattice-embedding" style="width:100%;height:390px;display:block"></canvas>`, 'margin-bottom:9px')}${card(`<div style="font-size:10px;color:${C.text};font-weight:900">Multi-resolution span lattice</div><div style="font-size:7.5px;color:${C.mute};margin-bottom:4px">X = source token position. Y = token width. Every accepted and rejected non-empty span remains visible.</div><canvas data-pl-canvas="lattice-spans" style="width:100%;height:280px;display:block"></canvas>`)}</div><aside style="min-height:720px;max-height:720px;overflow:hidden">${latticeNodeInspector(detail)}</aside></div>
            ${card(`<div style="font-size:10px;color:${C.text};font-weight:900">Attention-like relational graph · ${esc(state.latticeEdgeType)}</div><div style="font-size:7.5px;color:${C.mute};line-height:1.5;margin:3px 0 6px">Nodes use the selected semantic plane. The selected edges are structural/descriptive unless an outcome edge explicitly reports a held-out fold. No descriptive attention channel is aggregated or used to score the hook.</div><canvas data-pl-canvas="lattice-graph" style="width:100%;height:460px;display:block"></canvas>`, 'margin-bottom:9px')}
            ${card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><div><div style="font-size:10px;color:${C.text};font-weight:900">Selected non-overlapping span combinations</div><div style="font-size:7.5px;color:${C.mute};margin-top:2px">All pairs and triples among accepted canonical, clause, and change-point spans; outcomes are never consulted.</div></div><b style="font-size:13px;color:${C.cyan}">${combinations.length.toLocaleString()}</b></div><div style="max-height:230px;overflow:auto;margin-top:6px">${combinations.map(row => `<div style="display:grid;grid-template-columns:38px 1fr;gap:6px;border-top:1px solid ${C.border};padding:5px 0"><b style="font-size:8px;color:${C.purple}">${row.size}-WAY</b><div style="display:flex;gap:4px;flex-wrap:wrap">${(row.nodeIds || []).map(id => { const node = nodeById[id] || {}; return `<button data-pl-lattice-node="${esc(id)}" style="border:1px solid ${clusterColor(node.category)}66;background:${C.card2};color:${C.text};padding:3px 5px;font-size:7.5px;cursor:pointer">${esc(node.text || id)}</button>`; }).join('')}</div></div>`).join('') || `<div style="font-size:8px;color:${C.mute};padding-top:6px">No accepted non-overlapping pair or triple exists for this hook.</div>`}</div>`, 'margin-bottom:9px')}
            ${card(`<div style="font-size:10px;color:${C.text};font-weight:900;margin-bottom:5px">Resolution and representation contract</div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr><th style="text-align:left;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">resolution</th><th style="text-align:left;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">nodes</th><th style="text-align:left;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">deterministic definition</th></tr></thead><tbody>${Object.entries(detail.resolutionDefinitions || {}).map(([name, definition]) => `<tr><td style="padding:4px;border-bottom:1px solid ${C.border};color:${C.cyan};font-weight:800">${esc(name)}</td><td style="padding:4px;border-bottom:1px solid ${C.border};color:${C.text}">${name === 'timestamp' ? Object.entries(detail.resolutionCounts || {}).filter(([key]) => key.startsWith('timestamp-')).reduce((sum, [, value]) => sum + Number(value || 0), 0) : (detail.resolutionCounts || {})[name] || 0}</td><td style="padding:4px;border-bottom:1px solid ${C.border};color:${C.dim}">${esc(definition)}</td></tr>`).join('')}</tbody></table></div><div style="font-size:8px;color:${C.mute};line-height:1.55;margin-top:7px">Rejected candidates retained: ${Number((detail.rejectedCandidates || {}).total || 0).toLocaleString()} · selected non-overlapping pairs/triples: ${Number((detail.selectedCombinations || []).length).toLocaleString()} · idea anchor: ${detail.ideaAnchor && detail.ideaAnchor.present ? esc(detail.ideaAnchor.text || 'present') : 'none'} · outcome-edge policy: ${esc((detail.graphContract || {}).outcomeEdgePolicy || '')}</div>`)}</section>`;
        }

        function renderStoredLattice(row) {
            if (String(state.latticeVideoId || '') !== String(row.videoId || '')) {
                return card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><div style="font-size:9px;color:${C.dim}">The saved hook has a precomputed multi-resolution lattice; it is loaded once from its stored artifact.</div>${button('Load lattice', `data-pl-lattice-video="${esc(row.videoId)}"`)}</div>`);
            }
            return renderLatticeSurface(state.latticeDetail, 'stored measured hook');
        }

        function hookLibraryDetail(row) {
            const focus = { type: 'stored', row };
            return `<section data-pl-library-detail style="border:1px solid ${C.cyan}66;background:${C.card2};padding:12px;margin:0 0 10px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Held-out source audit</div><div style="font-size:15px;color:${C.text};font-weight:900;margin-top:3px">${esc(row.title || row.videoId || '')}</div><div style="font-size:10px;color:${C.dim};line-height:1.5;margin-top:3px">${esc(row.text || '')}</div></div>${button('Close detail', 'data-pl-library-close')}</div>${marketScoreCard(focus)}${marketTransferPanel(focus)}${survivalScoreCard(row.survivalScore, true)}${outcomePredictionStrip(focus)}${predictionAccuracyPanel(focus)}${retentionForecastPanel(row.retentionForecast, true)}${hookOutcomeAxisGallery(focus)}${boundaryTracePanel(focus)}<div style="margin:12px 0"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px"><div style="font-size:11px;color:${C.text};font-weight:900">${(row.components || []).length} evidence-selected components</div><div style="font-size:8px;color:${C.cyan};font-weight:900">SCROLL ALL COMPONENTS →</div></div><div class="pl-component-summary-strip" style="display:flex;gap:7px;overflow-x:auto;overscroll-behavior-x:contain;padding-bottom:7px">${(row.components || []).map((component, index) => { const boundary = component.boundaryEvidence || {}, hold = component.hookHoldContribution || {}, market = ((marketRewardRow(row.videoId) || {}).components || [])[index] || {}, direct = component.wholeHookOutcomeContributions || {}, marketValue = numeric(market.effectZ); return `<div style="flex:0 0 295px;border-left:3px solid ${clusterColor(component.category)};background:${C.card};padding:8px;min-width:0"><div style="font-size:7.5px;color:${clusterColor(component.category)};font-weight:900">COMPONENT ${index + 1} · CLUSTER ${component.category} · TOKENS ${component.startToken}-${component.endToken}</div><div style="font-size:9px;color:${C.text};font-weight:800;line-height:1.4;margin:3px 0;overflow-wrap:anywhere">${esc(component.text || '')}</div><div style="font-size:7px;color:${C.mute};line-height:1.45;margin:4px 0">cut evidence L ${boundary.leftProbability == null ? 'hook edge' : fmt(boundary.leftProbability, 3)} · R ${boundary.rightProbability == null ? 'hook edge' : fmt(boundary.rightProbability, 3)} · category confidence ${fmt(Number(boundary.categoryProbability || 0) * 100, 1)}%</div><div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;margin:6px 0"><span style="font-size:7.5px;color:${C.mute}">Market Hold deletion effect</span><b style="font-size:16px;color:${marketValue >= 0 ? C.green : C.red}">${signed(marketValue, 2)}σ</b></div><div style="font-size:7.5px;color:${C.dim};line-height:1.5">${fmt(market.percentile, 1)}th same-cluster effect · Hook Hold diagnostic ${signed(hold.effectHoldZ, 2)}σ<br>${hookOutcomeOrder.map(target => `${esc((((state.data.hookOutcomes || {}).targets || {})[target] || {}).shortLabel || target)} ${formatHookOutcomeEffect((direct[target] || {}).effect, target)}`).join(' · ')}</div><div style="height:1px;background:${C.border};margin:6px 0"></div><div style="font-size:7.5px;color:${C.dim};line-height:1.5;overflow-wrap:anywhere">conditional response ${fmt((component.forwardResponse || {}).axisPercentile, 1)}th · broad deletion ${signed((component.broadRetainedInformation || {}).deletionEffect, 4)} / ${fmt((component.broadRetainedInformation || {}).percentile, 1)}th<br>${hookOutcomeOrder.map(target => `${esc((((state.data.hookOutcomes || {}).targets || {})[target] || {}).shortLabel || target)} component plane ${fmt(((component.outcomes || {})[target] || {}).percentile, 0)}th`).join(' · ')}</div></div>`; }).join('')}</div></div><div class="pl-split" style="display:grid;grid-template-columns:minmax(280px,.65fr) minmax(0,1.35fr);gap:10px"><div><div style="font-size:11px;color:${C.text};font-weight:900;margin-bottom:5px">${(row.relationships || []).length} component relationships</div>${libraryRelationships(row)}<div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:5px">Market Hold is the primary relationship metric; Hook Hold and conditional response remain separate diagnostics.</div></div><div style="font-size:8.5px;color:${C.dim};line-height:1.6"><b style="color:${C.text}">Traceability:</b> whole-hook predictions are stored source-held-out values. Headline component and pair explanations are frozen full-fit model counterfactuals so they use the same serving coordinate as new text; they are model explanations, not independent outcomes. Exact captions time ${((row.retentionForecast || {}).words || []).length} words; every token belongs to one and only one component. Terminal-sensitivity curve MAE for this source is ${fmt((row.retentionForecast || {}).rewatchAdjustedSourceMAEPercentagePoints, 2)} percentage points versus ${fmt((row.retentionForecast || {}).rewatchAdjustedBaselineMAEPercentagePoints, 2)} for the text-free baseline.</div></div>${componentScoreGallery(focus)}${renderStoredLattice(row)}</section>`;
        }

        function renderHookLibrary() {
            const outcomes = state.data.hookOutcomes;
            if (!outcomes) return loading('hookOutcomes');
            if (!state.data.marketReward) return loading('marketReward');
            if (!state.data.canonicalPartitions) return loading('canonicalPartitions');
            const query = state.hookLibraryQuery.trim().toLowerCase();
            let rows = (outcomes.hooks || []).filter(row => !query || `${row.title || ''} ${row.text || ''} ${row.videoId || ''}`.toLowerCase().includes(query));
            const metricValue = row => state.hookLibraryMetric === 'market'
                ? numeric(((marketRewardRow(row.videoId) || {}).score || {}).percentile)
                : state.hookLibraryMetric === 'overall'
                ? numeric((row.survivalScore || {}).holdZ)
                : numeric(((row.outcomes || {})[state.hookLibraryMetric] || {}).predictedOOF);
            rows = [...rows].sort((left, right) => metricValue(right) - metricValue(left) || String(left.videoId).localeCompare(String(right.videoId)));
            const targets = outcomes.targets || {};
            return `${partitionMethodPanel(state.data.hookQuality)}${card(`<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap"><label style="flex:1;min-width:260px"><span style="display:block;font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin-bottom:4px">Search all ${Number((outcomes.hooks || []).length).toLocaleString()} measured hooks</span><input data-pl-query="library" value="${esc(state.hookLibraryQuery)}" placeholder="title, hook text, or video ID" style="width:100%;box-sizing:border-box;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:7px 8px;border-radius:5px;font-size:10px"></label>${button('Apply', 'data-pl-library-apply')}</div><div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">${[['market', 'Market Hold · primary'], ['overall', 'Hook Hold · diagnostic'], ...hookOutcomeOrder.map(id => [id, (targets[id] || {}).shortLabel || id])].map(([id, label]) => button(label, `data-pl-library-metric="${id}"`, state.hookLibraryMetric === id)).join('')}</div><div style="font-size:8px;color:${C.mute};margin-top:6px">${rows.length} hooks sorted by ${esc(state.hookLibraryMetric === 'market' ? 'frozen Market Hold percentile' : state.hookLibraryMetric === 'overall' ? 'unbounded diagnostic Hook Hold z-score' : `${(targets[state.hookLibraryMetric] || {}).shortLabel || state.hookLibraryMetric} held-out prediction`)}. Every row shows prediction, actual, error, all emergent components, and its full curve.</div>`, 'margin-bottom:9px')}
            <div style="display:grid;grid-template-columns:minmax(0,1fr);gap:6px">${rows.map((row, index) => { const selected = String(row.videoId) === String(state.hookLibrarySelectedId), market = (marketRewardRow(row.videoId) || {}).score || {}; return `<div><div class="pl-library-row" data-pl-library-hook="${esc(row.videoId)}" role="button" tabindex="0" style="display:grid;grid-template-columns:minmax(280px,1.5fr) repeat(4,minmax(100px,.55fr)) minmax(180px,.75fr);gap:7px;align-items:center;border:1px solid ${selected ? C.cyan : C.border};background:${selected ? C.cyan + '0d' : C.card};padding:8px;cursor:pointer"><div style="min-width:0"><div style="display:flex;justify-content:space-between;gap:6px"><span style="font-size:7.5px;color:${C.mute}">#${index + 1} · ${esc(row.videoId || '')}</span><b style="font-size:9px;color:${C.green}">Market ${fmt(market.percentile, 1)}th</b></div><div style="font-size:10px;color:${C.text};font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">${esc(row.title || '')}</div><div style="font-size:8px;color:${C.dim};line-height:1.35;max-height:2.7em;overflow:hidden;margin-top:2px">${esc(row.text || '')}</div><div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:4px">${(row.components || []).map((component, componentIndex) => { const effect = (((marketRewardRow(row.videoId) || {}).components || [])[componentIndex] || {}); return `<span style="border-bottom:2px solid ${clusterColor(component.category)};font-size:7px;color:${C.mute};padding:2px 3px" title="Market Hold exact deletion effect">C${component.category} ${signed(effect.effectZ, 1)}σ</span>`; }).join('')}</div></div>${hookOutcomeOrder.map(target => { const value = (row.outcomes || {})[target] || {}; return `<div style="border-left:2px solid ${numeric(value.actual) >= numeric(value.predictedOOF) ? C.green : C.red};padding-left:6px;min-width:0"><div style="font-size:7px;color:${C.mute};text-transform:uppercase">${esc((targets[target] || {}).shortLabel || target)}</div><b style="display:block;font-size:11px;color:${C.text};white-space:nowrap">${esc(formatHookOutcomeValue(value.predictedOOF, target, true))}</b><div style="font-size:7px;color:${C.dim};white-space:nowrap">actual ${esc(formatHookOutcomeValue(value.actual, target, true))}<br>error ${signed(numeric(value.actual) - numeric(value.predictedOOF), target === 'log_views' ? 2 : 1)}</div></div>`; }).join('')}<canvas data-pl-canvas="library-retention-mini" data-pl-video-id="${esc(row.videoId)}" style="width:100%;height:62px;display:block"></canvas></div>${selected ? hookLibraryDetail(row) : ''}</div>`; }).join('')}</div>`;
        }

        function hookScoreResultPanel(result) {
            if (!result) return '';
            const score = result.score || {}, market = result.trainingReward || {}, confidence = result.confidence || {};
            const components = result.components || [], pairs = result.pairInteractions || [];
            const scorecard = result.scorecard || {}, trainingScorecard = result.trainingScorecard || {}, scoreCoverage = trainingScorecard.coverage || {};
            const forward = result.forwardResponse || {}, forwardMetric = forward.metric || {};
            const outcomes = result.outcomes || {}, focus = { type: 'live', result };
            const pairLookup = Object.fromEntries(pairs.map(row => [`${row.left}-${row.right}`, row]));
            const marketInteractionTable = `<div style="overflow:auto;max-height:520px"><table style="width:max-content;min-width:100%;border-collapse:collapse;font-size:8px"><thead><tr><th style="padding:4px;color:${C.mute}">component</th>${components.map((component, index) => `<th style="min-width:48px;padding:4px;color:${clusterColor(component.category)}">${index + 1}</th>`).join('')}</tr></thead><tbody>${components.map((component, left) => `<tr><th style="padding:4px;color:${clusterColor(component.category)}">${left + 1}</th>${components.map((__, right) => { const row = left < right ? pairLookup[`${left}-${right}`] : right < left ? pairLookup[`${right}-${left}`] : null, value = row && row.marketHoldInteraction, effect = value && numeric(value.interactionZ), rank = value && numeric(value.percentile), alpha = value ? Math.min(.42, .08 + Math.abs(effect) / 4) : 0, background = !value ? C.card2 : effect >= 0 ? `rgba(74,222,128,${alpha})` : `rgba(248,113,113,${alpha})`; return `<td title="${value ? `${fmt(rank, 1)}th among ${esc(value.categorySequence || '')} training pairs` : ''}" style="min-width:48px;padding:6px;text-align:center;background:${background};color:${value ? C.text : C.faint};border:1px solid ${C.border}">${value ? `${signed(effect, 2)}σ` : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
            const holdInteractionTable = `<div style="overflow:auto;max-height:520px"><table style="width:max-content;min-width:100%;border-collapse:collapse;font-size:8px"><thead><tr><th style="padding:4px;color:${C.mute}">component</th>${components.map((component, index) => `<th style="min-width:48px;padding:4px;color:${clusterColor(component.category)}">${index + 1}</th>`).join('')}</tr></thead><tbody>${components.map((component, left) => `<tr><th style="padding:4px;color:${clusterColor(component.category)}">${left + 1}</th>${components.map((__, right) => { const row = left < right ? pairLookup[`${left}-${right}`] : right < left ? pairLookup[`${right}-${left}`] : null; const hold = row && row.hookHoldInteraction; const value = hold && numeric(hold.interactionHoldZ); const rank = hold && numeric(hold.categorySequencePercentile); const alpha = hold ? Math.min(.42, .08 + Math.abs(value) / 4) : 0; const background = !hold ? C.card2 : value >= 0 ? `rgba(74,222,128,${alpha})` : `rgba(248,113,113,${alpha})`; return `<td title="${hold ? `${signed(hold.interactionRawCarryPointsPerSecond, 4)} carry pp/s · ${fmt(rank, 1)}th among C${components[Math.min(left, right)].category}→C${components[Math.max(left, right)].category} training pairs` : ''}" style="min-width:48px;padding:6px;text-align:center;background:${background};color:${hold ? C.text : C.faint};border:1px solid ${C.border}">${hold ? `${signed(value, 2)}σ` : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
            const interactionTable = `<div style="overflow:auto;max-height:520px"><table style="width:max-content;min-width:100%;border-collapse:collapse;font-size:8px"><thead><tr><th style="padding:4px;color:${C.mute}">component</th>${components.map((component, index) => `<th style="min-width:44px;padding:4px;color:${clusterColor(component.category)}">${index + 1}</th>`).join('')}</tr></thead><tbody>${components.map((component, left) => `<tr><th style="padding:4px;color:${clusterColor(component.category)}">${left + 1}</th>${components.map((__, right) => { const row = left < right ? pairLookup[`${left}-${right}`] : right < left ? pairLookup[`${right}-${left}`] : null; const value = row && numeric(row.interaction); const alpha = row ? Math.min(.38, .08 + Math.abs(value) * 7) : 0; const background = !row ? C.card2 : value >= 0 ? `rgba(74,222,128,${alpha})` : `rgba(248,113,113,${alpha})`; return `<td title="${row ? `80% interval ${signed(row.bootstrapP10, 4)} to ${signed(row.bootstrapP90, 4)}` : ''}" style="min-width:44px;padding:6px;text-align:center;background:${background};color:${row ? C.text : C.faint};border:1px solid ${C.border}">${row ? signed(value, 3) : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
            const forwardInteractionTable = `<div style="overflow:auto;max-height:520px"><table style="width:max-content;min-width:100%;border-collapse:collapse;font-size:8px"><thead><tr><th style="padding:4px;color:${C.mute}">component</th>${components.map((component, index) => `<th style="min-width:44px;padding:4px;color:${clusterColor(component.category)}">${index + 1}</th>`).join('')}</tr></thead><tbody>${components.map((component, left) => `<tr><th style="padding:4px;color:${clusterColor(component.category)}">${left + 1}</th>${components.map((__, right) => { const row = left < right ? pairLookup[`${left}-${right}`] : right < left ? pairLookup[`${right}-${left}`] : null; const response = row && row.forwardResponse; const value = response && numeric(response.interaction); const score = response && numeric(response.percentile); const alpha = response ? Math.min(.4, .08 + Math.abs(score - 50) / 120) : 0; const background = !response ? C.card2 : score >= 50 ? `rgba(74,222,128,${alpha})` : `rgba(248,113,113,${alpha})`; return `<td title="${response ? `${esc(response.categoryPair)} · coordinate ${signed(value, 4)}` : ''}" style="min-width:44px;padding:6px;text-align:center;background:${background};color:${response ? C.text : C.faint};border:1px solid ${C.border}">${response ? `${fmt(score, 0)}th` : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
            const retained = ((result.retainedInformation || {}).score || {}), local = result.localCounterfactuals || {};
            return `<div data-pl-hook-score-result><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${stat('Market Hold', `${fmt(market.percentile, 1)}th`, C.green)}${stat('Market z', `${signed(market.z, 2)}σ`, C.green)}${stat('training reward', market.reward == null ? 'withheld' : fmt(market.reward, 3), market.reward == null ? C.red : C.green)}${stat('market nearest cosine', fmt(market.domainNearestCosine, 3), market.eligibleForTraining ? C.green : C.red)}${stat('Hook Hold diagnostic', `${signed(score.holdZ, 2)}σ`, C.amber)}${stat('Hook future rho', fmt(confidence.chronologicalHeldoutSpearman, 3), C.red)}${stat('retained info diagnostic', `${fmt(retained.percentile, 1)}th`, C.amber)}${stat('partition certainty', `${fmt(confidence.partitionScoreGapPercentile, 1)}th`, C.amber)}</div>${card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:300px;flex:1"><div style="font-size:8px;color:${C.green};font-weight:900;text-transform:uppercase">Complete frozen training contract</div><div style="font-size:16px;color:${C.text};font-weight:900;margin-top:3px">One Market Hold score, ${components.length} component effects, ${pairs.length} relationship effects</div><div style="font-size:8.5px;color:${C.dim};line-height:1.55;margin-top:4px">Headline = percentile on one external-only frozen text direction. Component = MarketHold(full) − MarketHold(without that exact component), in score σ. Relationship = the second-order Market Hold interaction after deleting each component and both together. Categories choose neither the reward nor its threshold. Hook Hold, forward response, and direct outcomes remain separate diagnostics.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('token coverage', scoreCoverage.tokensOwnedExactlyOnce ? 'exactly once' : 'FAILED', scoreCoverage.tokensOwnedExactlyOnce ? C.green : C.red)}${stat('components', `${scoreCoverage.componentsScored || 0}/${scoreCoverage.componentsExpected || components.length}`, C.cyan)}${stat('relationships', `${scoreCoverage.relationshipsScored || 0}/${scoreCoverage.relationshipsExpected || pairs.length}`, C.purple)}${stat('reward status', market.eligibleForTraining ? 'eligible' : 'withheld', market.eligibleForTraining ? C.green : C.red)}</div></div>`, 'margin-bottom:10px;border-color:' + C.green + '66')}${survivalScoreCard(score, false)}${outcomePredictionStrip(focus)}${retentionForecastPanel(outcomes.retentionForecast, false)}${boundaryTracePanel(focus)}
            ${card(`<div style="font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin-bottom:4px">Exact complete-hook embedding input</div><div style="font-size:14px;color:${C.text};font-weight:900;line-height:1.45">${esc((result.input || {}).fullHookEmbeddingInput || '')}</div><div style="font-size:8px;color:${C.dim};margin-top:6px">${esc((result.input || {}).embeddingModel || '')} · ${(result.input || {}).embeddingDimensions || 0}D · ${(result.input || {}).spanEmbeddingInputs || 0} exact span/context inputs · ${(result.input || {}).tokenCount || 0} tokens (${fmt((result.input || {}).trainingTokenCountPercentile, 1)}th training-length percentile; observed training range ${(result.input || {}).trainingTokenCountMinimum || '-'}–${(result.input || {}).trainingTokenCountMaximum || '-'}) · generative LLM: no</div>${(result.input || {}).outsideTrainingLengthRange ? `<div style="font-size:8px;color:${C.red};font-weight:900;margin-top:5px">LENGTH EXTRAPOLATION: this opening is outside every measured training-hook length. The decomposition is still exact, but the predictive coordinates are out of measured length support.</div>` : ''}`, 'margin-bottom:10px;border-color:' + C.cyan + '55')}
            ${card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px"><div><div style="font-size:11px;color:${C.text};font-weight:900">Variable-count exact-cover decomposition · ${components.length} components</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Every token has one owner and zero overlap. Four is the category vocabulary, not the component count. Boundaries use no outcome and no supplied example labels. Component scores below use the exact same frozen Market Hold coordinate as the training reward.</div></div><div style="font-size:8px;color:${C.amber}">top-two gap ${fmt(confidence.partitionScoreGap, 5)} · ${fmt(confidence.partitionScoreGapPercentile, 1)}th training percentile</div></div><div style="display:flex;gap:4px;overflow-x:auto;margin-bottom:9px;padding-bottom:4px">${components.map(component => `<span style="flex:0 0 auto;border-bottom:4px solid ${clusterColor(component.category)};background:${C.card2};padding:6px 7px;font-size:10px;color:${C.text}">${esc(component.text)}</span>`).join('')}</div><div style="display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;padding-bottom:7px">${components.map(component => { const response = component.forwardResponse || {}, hold = component.hookHoldContribution || {}, marketEffect = component.marketHoldContribution || {}, direct = component.wholeHookOutcomeContributions || {}, marketValue = numeric(marketEffect.effectZ); return `<div style="flex:0 0 300px;border-left:3px solid ${clusterColor(component.category)};padding:8px 10px;background:${C.card2}"><div style="font-size:8px;color:${clusterColor(component.category)};font-weight:900">COMPONENT ${component.index + 1} · CLUSTER ${component.category}</div><div style="font-size:10px;color:${C.text};font-weight:800;line-height:1.4;margin:3px 0">${esc(component.text)}</div><div style="font-size:7px;color:${C.mute};line-height:1.45">cut evidence L ${component.leftBoundaryProbability == null ? 'hook edge' : fmt(component.leftBoundaryProbability, 3)} · R ${component.rightBoundaryProbability == null ? 'hook edge' : fmt(component.rightBoundaryProbability, 3)} · category confidence ${fmt(Number(component.categoryProbability || 0) * 100, 1)}%</div><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;margin:7px 0 5px"><span style="font-size:8px;color:${C.mute}">Market Hold deletion effect<br><span style="font-size:7px">higher = reward falls when removed</span></span><b style="font-size:20px;color:${marketValue >= 0 ? C.green : C.red}">${signed(marketValue, 2)}σ</b></div><div style="font-size:8px;color:${C.dim};line-height:1.55">${fmt(marketEffect.percentile, 1)}th among training C${component.category} Market effects · Hook Hold diagnostic ${signed(hold.effectHoldZ, 2)}σ · fixed-duration endpoint ${signed(hold.fixedDurationEndpointEffectPercentagePoints, 2)} pp</div><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px;margin-top:6px">${hookOutcomeOrder.map(target => `<span style="font-size:7px;color:${C.mute};border-left:2px solid ${C.border};padding-left:4px">${esc((((outcomes.targets || {})[target] || {}).shortLabel) || target)}<br><b style="color:${C.text}">${formatHookOutcomeEffect((direct[target] || {}).effect, target)}</b></span>`).join('')}</div><div style="height:1px;background:${C.border};margin:7px 0"></div><div style="font-size:7.8px;color:${C.dim};line-height:1.55">conditional response ${fmt(response.percentile, 1)}th · coordinate ${signed(response.axisCoordinate, 4)} · category rho ${fmt(response.heldoutSpearmanForCategory, 3)}<br>retained-information deletion ${signed(component.retainedInformationDeletionEffect, 4)} · ${fmt(component.categoryContributionPercentile, 1)}th · bootstrap ${signed(component.bootstrapP10, 4)} to ${signed(component.bootstrapP90, 4)}</div></div>`; }).join('')}</div>`, 'margin-bottom:10px')}
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(280px,.8fr) minmax(0,1.2fr);gap:10px;margin-bottom:10px">${card(`<div style="font-size:11px;color:${C.text};font-weight:900;margin-bottom:5px">${pairs.length} local relationship measurements</div><div style="font-size:8px;color:${C.green};font-weight:900;line-height:1.5;margin-bottom:5px">MARKET HOLD INTERACTION · SAME METRIC AS TRAINING REWARD</div>${marketInteractionTable}<div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:6px">Each cell is MarketHold(full) − MarketHold(without left) − MarketHold(without right) + MarketHold(without both), in frozen score σ. Positive means the pair contributes beyond its separate local deletions inside this model.</div><div style="height:1px;background:${C.border};margin:9px 0"></div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-bottom:5px">Hook Hold interaction · separate diagnostic</div>${holdInteractionTable}<div style="height:1px;background:${C.border};margin:9px 0"></div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-bottom:5px">Conditional forward-response interaction · separate diagnostic</div>${forwardInteractionTable}<div style="height:1px;background:${C.border};margin:9px 0"></div><div style="font-size:9px;color:${C.text};font-weight:900;margin-bottom:4px">Broad retained-information local interaction</div>${interactionTable}`)}${card(`<div style="font-size:11px;color:${C.text};font-weight:900;margin-bottom:5px">Exact local counterfactual embedding inputs</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-bottom:6px">One full-context deletion per component and one two-component deletion per pair. Source order and all retained source characters are preserved.</div><div style="max-height:460px;overflow:auto">${(local.componentDeletions || []).map(row => { const component = components[Number(row.removedComponent)] || {}, hold = component.hookHoldContribution || {}, marketEffect = row.marketHold || {}; return `<details style="border-top:1px solid ${C.border};padding:5px 0"><summary style="cursor:pointer;color:${C.dim};font-size:8.5px">remove component ${Number(row.removedComponent) + 1} · Market ${signed(marketEffect.effectZ, 2)}σ · Hook diagnostic ${signed(hold.effectHoldZ, 2)}σ</summary><div style="font-size:9px;color:${C.text};line-height:1.5;padding:5px 8px"><b>exact embedded text:</b> ${esc(row.embeddingInput || '(empty hook; fitted intercept)')}<br><b>Market Hold:</b> ${signed(marketEffect.fullCoordinate, 4)} full − ${signed(marketEffect.withoutCoordinate, 4)} without = ${signed(marketEffect.effectZ, 4)}σ<br><b>Hook Hold diagnostic:</b> ${signed(hold.effectRawCarryPointsPerSecond, 4)} carry pp/s</div></details>`; }).join('')}${(local.pairDeletions || []).map(row => { const marketEffect = row.marketHold || {}; return `<details style="border-top:1px solid ${C.border};padding:5px 0"><summary style="cursor:pointer;color:${C.dim};font-size:8.5px">remove components ${(row.removedComponents || []).map(value => value + 1).join(' + ')} · Market interaction ${signed(marketEffect.interactionZ, 2)}σ</summary><div style="font-size:9px;color:${C.text};line-height:1.5;padding:5px 8px"><b>without pair:</b> ${esc(row.embeddingInput || '(empty hook; fitted intercept)')}<br><b>pair retained alone:</b> ${esc(row.retainedPairEmbeddingInput || '(empty)')}<br><b>Market interaction:</b> ${signed(marketEffect.interactionZ, 4)}σ · ${fmt(marketEffect.percentile, 1)}th same-category-sequence percentile</div></details>`; }).join('')}</div>`)}</div>${componentScoreGallery(focus)}
            ${card(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:280px;flex:1"><div style="font-size:11px;color:${C.text};font-weight:900">Timing and scope decision</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:4px">Market Hold does not select or assume a response lag; it scores the complete text once. The dedicated component-response lag is <b style="color:${forward.validatedAtComponentLevel ? C.green : C.red}">+${fmt(forwardMetric.selectedLagSeconds, 1)}s ${forward.validatedAtComponentLevel ? 'validated' : 'not validated'}</b> and remains a separate timing diagnostic. Hook Hold uses future-free entry-indexed retention through the hook endpoint; terminal-conditioned replay appears only as a retrospective sensitivity and is never averaged into the training reward.</div></div><div style="font-size:8px;color:${C.mute};line-height:1.5">Boundary outcomes: none<br>Training target: frozen external market percentile<br>Component effect: exact Market Hold deletion<br>Relationship effect: exact second-order Market Hold deletion<br>Conditional timing target: source-balanced unexpected entry-indexed slope<br>Examples in training: no<br>Causal claim: no</div></div><div style="height:1px;background:${C.border};margin:9px 0"></div><div style="font-size:9px;color:${C.text};font-weight:900;margin-bottom:4px">Nearest measured hook support</div>${(result.nearestTrainingHooks || []).map(row => `<div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid ${C.border};padding:5px 0;font-size:8.5px"><span style="color:${C.dim}">${esc(row.text)}</span><b style="color:${C.text}">${fmt(row.cosine, 3)}</b></div>`).join('')}`)}</div>`;
        }

        function renderHookScorer() {
            const summary = state.data.hookQuality, examples = state.data.hookExamples, outcomes = state.data.hookOutcomes, market = state.data.marketReward;
            if (!summary) return loading('hookQuality');
            if (!outcomes) return loading('hookOutcomes');
            if (!market) return loading('marketReward');
            if (!state.data.canonicalPartitions) return loading('canonicalPartitions');
            if (!examples) return loading('hookExamples');
            const model = summary.model || {}, result = state.hookScoreResult;
            const survival = (outcomes.survivalModel || {}).validation || {};
            const marketExternal = market.externalTraining || {}, marketTransfer = (market.transferValidation || {}).retention_5s || {};
            return `${partitionMethodPanel(summary)}${card(`<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap"><label style="flex:1;min-width:280px"><span style="display:flex;justify-content:space-between;gap:8px;font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin-bottom:4px"><span>Complete hook or longer spoken opening</span><span data-pl-hook-score-count>${state.hookScoreText.length.toLocaleString()}/1,200 characters</span></span><textarea data-pl-hook-score-input maxlength="1200" rows="3" ${state.hookScoreLoading ? 'disabled' : ''} style="width:100%;box-sizing:border-box;resize:vertical;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:8px;font:10px/1.45 inherit;border-radius:6px;cursor:${state.hookScoreLoading ? 'wait' : 'text'}">${esc(state.hookScoreText)}</textarea><span style="display:block;font-size:7.5px;color:${C.mute};line-height:1.45;margin-top:3px">The exact scorer never truncates. Length support is reported against the measured 8–57-token training range; longer openings are computed but explicitly marked as extrapolations.</span></label><button data-pl-run-hook-score ${state.hookScoreLoading ? 'disabled' : ''} style="height:34px;border:1px solid ${C.cyan};background:${C.cyan}20;color:${C.cyan};padding:0 13px;border-radius:6px;font-size:10px;font-weight:900;cursor:${state.hookScoreLoading ? 'wait' : 'pointer'}">${state.hookScoreLoading ? 'Scoring…' : 'Score hook'}</button></div>${state.hookScoreError ? `<div data-pl-hook-score-error style="font-size:9px;color:${C.red};margin-top:7px">${esc(state.hookScoreError)}</div>` : ''}`, 'margin-bottom:10px')}
                ${card(`<label><span style="display:block;font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin-bottom:4px">Optional underlying idea anchor</span><input data-pl-hook-score-idea maxlength="1200" value="${esc(state.hookScoreIdea)}" ${state.hookScoreLoading ? 'disabled' : ''} placeholder="Leave blank for an outcome-blind hook graph; add the idea to expose title/context relations" style="width:100%;box-sizing:border-box;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:7px 8px;font:9px/1.4 inherit;border-radius:6px"><span style="display:block;font-size:7.5px;color:${C.mute};line-height:1.45;margin-top:3px">This anchor adds idea/title relation edges and orthogonal representations. It never changes the headline score or selects components.</span></label>`, 'margin-bottom:10px')}
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${stat('external training hooks', Number(marketExternal.nonOwnedTrainingRows || 0).toLocaleString(), C.cyan)}${stat('external nested OOF rho', fmt((marketExternal.selectedValidation || {}).heldoutSpearman, 3), C.text)}${stat('owned 5s transfer rho', fmt(marketTransfer.heldoutSpearman, 3), C.green)}${stat('recent-half 5s rho', fmt(marketTransfer.recentHalfSpearman, 3), C.green)}${stat('owned labels in reward fit', marketExternal.ownedOutcomeLabelsUsedToFitOrSelectAxis ? 'YES' : 'NO', marketExternal.ownedOutcomeLabelsUsedToFitOrSelectAxis ? C.red : C.green)}${stat('generative LLM', 'NO', C.green)}</div>${marketScoreCard(activeHookOutcomeFocus())}${marketTransferPanel(activeHookOutcomeFocus())}${survivalMethodPanel()}${predictionAccuracyPanel(activeHookOutcomeFocus())}
            ${card(`<div style="font-size:9px;color:${C.dim};line-height:1.55"><b style="color:${C.green}">Training contract:</b> Market Hold is the one frozen reward because it was selected outside your channel and transferred to untouched five-second retention. Hook Hold, direct viewed/retention/views forecasts, word forecasts, and category-response axes remain visible diagnostics. Market Hold still is not a causal promise truth: promotion beyond training proxy requires randomized same-topic variants.</div>`, 'margin-bottom:10px;border-color:' + C.green + '55')}
            ${hookOutcomeAxisGallery(activeHookOutcomeFocus())}${forwardResponsePanel(summary)}${hookExamplePanel(examples)}${state.hookScoreLoading ? card(`<div data-pl-hook-score-progress style="font-size:10px;color:${C.cyan}">${esc(state.hookScoreStatus || 'Scoring hook')}</div>`, 'margin-bottom:10px') : hookScoreResultPanel(result)}${result ? renderLatticeSurface(result.componentLattice, 'typed live predictor') : ''}`;
        }

        function renderSavedProjection() {
            if (!state.data.manualProbe) return loading('manualProbe');
            if (!state.data.manualProjection) return loading('manualProjection');
            return `${manualProjectionPanel()}${manualMetricGlossary()}${clusterOutcomePanel()}${latencyPanel()}`;
        }

        function renderOverview() {
            const manifest = state.data.manifest;
            const findings = state.data.findings;
            if (!manifest || !findings) return loading(!manifest ? 'manifest' : 'findings');
            const counts = manifest.counts || {};
            const boundary = findings.boundary || {}, cluster = findings.cluster || {}, swap = findings.swap || {}, axis = findings.axis || {};
            const canonical = findings.canonicalPartition || {}, canonicalValidation = canonical.validation || {};
            const outcomeAudit = findings.hookOutcomes || {}, survivalAudit = outcomeAudit.survivalValidation || {};
            const marketAudit = findings.marketReward || {}, marketExternal = marketAudit.externalTraining || {}, marketTransfer = (marketAudit.transferValidation || {}).retention_5s || {};
            const marketPromoted = marketAudit.status === 'validated-cross-source-local-retention-proxy';
            const promotionColor = marketPromoted ? C.green : C.red;
            const promotionHeadline = marketPromoted
                ? 'MARKET HOLD PROMOTED AS A TRAINING PROXY'
                : 'MARKET HOLD IS NOT READY FOR TRAINING';
            const promotionCopy = marketPromoted
                ? 'One direction selected on external hooks only transfers to untouched viewed percentage, five-second retention, and average retention. It is now the deterministic reward for model training. It does not predict owned raw views and does not establish a causal or universal promise-quality truth.'
                : 'The frozen external direction remains inspectable, but the current build did not pass every declared external, transfer, recent-half, and domain gate. No training reward is emitted until it does.';
            const temporalAudit = survivalAudit.chronologicalValidation || {};
            const normalizationAudit = outcomeAudit.normalizationSensitivity || {}, entryAudit = normalizationAudit.entryNormalizedNoFutureAnchor || {};
            const crossScope = cluster.crossScope || {}, consensusAgreement = crossScope.consensusAgreement || {};
            const supportedHooks = boundary.supportedHooks || [];
            const transferRows = ((swap.topTransferByMetric || {})[state.metric] || []).slice(0, 8);
            const axisRows = axis.selectedByTarget || [];
            const representationRows = cluster.allSpanRepresentationIndicators || [];
            return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
                ${stat('complete hooks', counts.hooks || 0, C.cyan)}${stat('embedding texts', Number(counts.embeddingTexts || 0).toLocaleString(), C.purple)}
                ${stat('boundary runs', Number(counts.boundaryExperiments || 0).toLocaleString(), C.amber)}${stat('cluster runs', Number(counts.clusterExperiments || 0).toLocaleString(), C.green)}
                ${stat('cluster maps', Number(counts.clusterMaps || 0) + Number(counts.allSpanClusterMaps || 0), C.orange)}${stat('all spans', Number(counts.allContiguousSpans || 0).toLocaleString(), C.purple)}${stat('swap rows', Number(counts.swapRows || 0).toLocaleString(), C.cyan)}${stat('axis runs', Number(counts.axisExperiments || 0).toLocaleString(), C.purple)}
            </div>${visualizationContractPanel()}${card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:300px;flex:1"><div style="font-size:9px;color:${promotionColor};font-weight:900;text-transform:uppercase">Current promotion decision</div><div style="font-size:18px;color:${C.text};font-weight:900;margin-top:2px">${promotionHeadline}</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:4px">${promotionCopy}</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('external nested OOF rho', fmt((marketExternal.selectedValidation || {}).heldoutSpearman, 3), C.text)}${stat('owned 5s rho', fmt(marketTransfer.heldoutSpearman, 3), marketPromoted ? C.green : C.red)}${stat('recent-half rho', fmt(marketTransfer.recentHalfSpearman, 3), marketPromoted ? C.green : C.red)}${stat('owned labels fit axis', marketExternal.ownedOutcomeLabelsUsedToFitOrSelectAxis ? 'yes' : 'no', marketExternal.ownedOutcomeLabelsUsedToFitOrSelectAxis ? C.red : C.green)}</div></div>`, 'margin-bottom:10px;border-color:' + promotionColor + '66')}${manualProbeSummary()}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:9px;margin-bottom:10px">
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.cyan};margin-bottom:5px">Canonical partition · current</div><div style="font-size:24px;font-weight:900;color:${C.text}">${canonical.components || 0}</div><div style="font-size:10px;color:${C.dim}">non-overlapping components across ${canonical.hooks || 0} hooks · observed range ${canonicalValidation.minimumComponents || '-'}–${canonicalValidation.maximumComponents || '-'}</div><div style="font-size:9px;color:${C.mute};margin-top:5px">${(canonicalValidation.componentCountHistogram || {})['1'] || 0} hooks stay whole · AUC ${fmt(canonicalValidation.boundaryHeldoutAuc, 3)} · AP ${fmt(canonicalValidation.boundaryHeldoutAveragePrecision, 3)} · category-blind boundaries.</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.amber};margin-bottom:5px">Legacy exhaustive boundary search · superseded</div><div style="font-size:24px;font-weight:900;color:${C.text}">${boundary.supportedMultiSegmentHooks || 0}</div><div style="font-size:10px;color:${C.dim}">search artifacts passed their original geometric null, but are not the current components</div><div style="font-size:9px;color:${C.mute};margin-top:5px">Some selected 31–37 near-token fragments, revealing a degenerate objective. They remain inspectable provenance only; scoring and libraries use the canonical exact cover above.</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.green};margin-bottom:5px">Two outcome-blind atlases</div><div style="font-size:24px;font-weight:900;color:${C.text}">${Number(cluster.experiments || 0).toLocaleString()} + ${Number(cluster.allContiguousExperiments || 0).toLocaleString()}</div><div style="font-size:10px;color:${C.dim}">evidence-supported candidates plus every contiguous span across 12 semantic and residual views</div><div style="font-size:9px;color:${C.mute};margin-top:5px">${Number(cluster.mapsVisible || 0) + Number(cluster.allContiguousMapsVisible || 0)} maps are inspectable · cross-scope consensus rho ${fmt(consensusAgreement.spearman, 3)}. Families remain unnamed.</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.cyan};margin-bottom:5px">Crossed transfer surface</div><div style="font-size:24px;font-weight:900;color:${C.text}">${Number(swap.rows || 0).toLocaleString()}</div><div style="font-size:10px;color:${C.dim}">source-component by target-hook recompositions</div><div style="font-size:9px;color:${C.mute};margin-top:5px">Model-predicted Long Quant evidence is kept separate from observed YouTube outcomes.</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.purple};margin-bottom:5px">Source-grouped semantic axes</div><div style="font-size:24px;font-weight:900;color:${C.text}">${axis.randomFoldSupported || 0}</div><div style="font-size:10px;color:${C.dim}">axes surviving grouped-source holdout and the searched null; this is not chronological validation</div><div style="font-size:9px;color:${C.mute};margin-top:5px">${axis.modelTransferValidated || 0}/${axis.modelTransferTargets || 0} model-transfer targets supported · ${axis.observedValidated || 0}/${axis.observedTargets || 0} observed targets remain random-fold diagnostics · ${axis.observedSourceSpanValidated || 0} observed source-span axes.</div>`)}
            </div>${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">What entered the calculation</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;font-size:10px;line-height:1.55">
                <div><b style="color:${C.green}">Discovery input</b><br><span style="color:${C.dim}">${esc(manifest.separation.discoveryInputs)}</span></div>
                <div><b style="color:${C.red}">Excluded from discovery</b><br><span style="color:${C.dim}">${esc(manifest.separation.discoveryExcludes)}</span></div>
                <div><b style="color:${C.cyan}">Exact embedding</b><br><span style="color:${C.dim}">${esc(manifest.embeddingModel)} at ${manifest.embeddingDimensions} dimensions, text channel only</span></div>
                <div><b style="color:${C.amber}">Outcome boundary</b><br><span style="color:${C.dim}">Outcomes join only after structures are frozen; observed and counterfactual evidence never share a label.</span></div>
                <div><b style="color:${C.purple}">Atlas scopes</b><br><span style="color:${C.dim}">${esc(manifest.separation.atlasScopes || '')}</span></div>
                <div><b style="color:${C.green}">All-span transforms</b><br><span style="color:${C.dim}">${esc(manifest.separation.allSpanTransforms || '')}</span></div></div>`)}
                ${axis.experiments ? card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">What emerged after correction</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:12px;font-size:9px;line-height:1.5"><div style="border-left:3px solid ${C.green};padding-left:8px"><b style="color:${C.green}">${axis.modelTransferValidated || 0}/${axis.modelTransferTargets || 0} model-transfer targets source-grouped supported</b><br><span style="color:${C.dim}">The trained Long Quant counterfactual surface is predictable from raw source-span semantics across held-out source videos.</span></div><div style="border-left:3px solid ${C.cyan};padding-left:8px"><b style="color:${C.cyan}">${axis.observedValidated || 0}/${axis.observedTargets || 0} observed targets random-fold supported</b><br><span style="color:${C.dim}">These signals concern early retention and retained hook context, but have no strict later-video replication and remain diagnostic.</span></div><div style="border-left:3px solid ${C.amber};padding-left:8px"><b style="color:${C.amber}">${axis.observedSourceSpanValidated || 0} observed source-span axes supported</b><br><span style="color:${C.dim}">No raw, influence, or non-additive span direction yet supports declaring a measured reference-to-gratification component. This is a negative result, not a missing label.</span></div></div>`, 'margin-top:10px') : ''}
                ${representationRows.length ? card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:2px">All-span view indicators</div><div style="font-size:8px;color:${C.mute};margin-bottom:7px">Medians across the retained maps for each outcome-blind representation. Fit-excluded margin uses hooks omitted from K-means fitting, but the PCA basis saw the full corpus, so it is descriptive rather than independent validation. Lower length/position NMI means less nuisance leakage.</div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['representation', 'maps', 'null lift', 'fit-excluded margin', 'seed ARI', 'length NMI', 'position NMI', 'cross-hook', 'cross-scope ARI', 'boundary enrichment'].map(label => `<th style="text-align:left;color:${C.mute};padding:4px;border-bottom:1px solid ${C.border};white-space:nowrap">${label}</th>`).join('')}</tr></thead><tbody>${representationRows.map(row => `<tr><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.text};font-weight:800">${esc(row.representation)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${row.maps || 0}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianMarginAboveNull, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianFitExcludedHookMargin, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianSeedStabilityARI, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianLengthNMI, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianPositionNMI, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianCrossHookGenerality, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianCrossScopeARI, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianBoundarySupportEnrichment, 3)}</td></tr>`).join('')}</tbody></table></div>`, 'margin-top:10px') : ''}
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:9px;margin-top:10px">
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.amber};margin-bottom:6px">Legacy exploratory partitions · provenance only</div><div style="font-size:8px;color:${C.mute};margin-bottom:6px">These rows beat the original searched geometric null, but token-level fragmentation exposed objective degeneracy. They do not feed the canonical partition, scorer, or component library.</div>${supportedHooks.length ? supportedHooks.map(row => { const seg = row.segmentation || {}; return `<button data-pl-hook="${esc(row.videoId)}" data-pl-open-hooks style="width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid ${C.border};padding:6px 0;cursor:pointer"><div style="font-size:9px;color:${C.text};font-weight:800;line-height:1.35">${esc(row.text)}</div><div style="font-size:8px;color:${C.mute}">${seg.segmentCount || '-'} legacy segments · searched p ${fmt(seg.searchWideP, 3)} · superseded</div></button>`; }).join('') : boundary.supportedMultiSegmentHooks ? `<div style="font-size:9px;color:${C.dim}">The legacy detail artifact is still building.</div>` : `<div style="font-size:9px;color:${C.dim}">No hook passed the searched null.</div>`}`)}
                ${card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:6px"><div><div style="font-size:11px;font-weight:900;color:${C.cyan}">Cross-context transfer indicators</div><div style="font-size:8px;color:${C.mute}">Long Quant model-predicted counterfactuals, never observed viewer outcomes.</div></div></div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">${(swap.metricNames || []).map(name => button(metricLabel(name), `data-pl-metric="${name}"`, state.metric === name)).join('')}</div>${transferRows.map(row => `<button data-pl-source="${esc(row.sourceId)}" data-pl-open-swaps style="width:100%;display:flex;justify-content:space-between;gap:8px;border:0;border-bottom:1px solid ${C.border};background:transparent;padding:5px 0;cursor:pointer;text-align:left"><div style="font-size:9px;color:${C.text};font-weight:800">${esc(row.text)}</div><div style="text-align:right;white-space:nowrap"><b style="font-size:9px;color:${Number(row.meanDeltaAcrossContexts) >= 0 ? C.green : C.red}">${signed(row.meanDeltaAcrossContexts, 2)}</b><div style="font-size:7.5px;color:${C.mute}">${pct(Number(row.positiveContextRate || 0) * 100)} positive</div></div></button>`).join('') || `<div style="font-size:9px;color:${C.dim}">Transfer surface is still building.</div>`}`)}
                </div>
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.purple};margin-bottom:3px">Selected required-confound outcome directions</div><div style="font-size:8px;color:${C.mute};margin-bottom:7px">One predeclared adjusted configuration per target. Every row opens the exact semantic plane, grouped-source check, color scale, and input-versus-outcome horizon. Highlighted rows survived the target-wide max-null and cross-target FDR in grouped random folds; none is called chronologically validated.</div><div style="overflow:auto;max-height:480px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['evidence channel', 'target and outcome window', 'input / confounds', 'grouped-random result'].map(label => `<th style="text-align:left;color:${C.mute};padding:4px;border-bottom:1px solid ${C.border}">${label}</th>`).join('')}</tr></thead><tbody>${axisRows.map(row => { const lineage = (axis.targetLineage || {})[row.target] || {}, window = lineage.outcomeWindow || {}; return `<tr><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${esc(row.targetChannel || '')}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.text}"><button data-pl-open-axis-target="${esc(row.target || '')}" style="border:0;background:transparent;color:${C.cyan};font:inherit;font-weight:900;padding:0;cursor:pointer;text-align:left">${esc(row.target || '')} →</button><br><span style="color:${C.mute}">${esc(row.targetDefinition || '')}</span>${window.label ? `<br><span style="color:${C.amber}">target window: ${esc(window.label)}</span>` : ''}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${esc(row.representation || '')} · ${esc(row.confounds || '')}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${axisRandomFoldSupported(row) ? C.green : C.dim};white-space:nowrap">rho ${fmt(row.heldoutSpearman, 3)}<br>p ${fmt(row.searchWideP, 3)} · q ${fmt(row.searchWideQ, 3)}<br>${esc(row.status || '')}</td></tr>`; }).join('') || `<tr><td colspan="4" style="padding:8px;color:${C.dim}">Outcome-axis search is still building.</td></tr>`}</tbody></table></div>`, 'margin-top:10px')} `;
        }

        function hookRows() {
            const discovery = state.data.discovery;
            if (!discovery) return loading('discovery');
            const query = state.hookQuery.toLowerCase();
            const rows = (discovery.rows || []).filter(row => !query || String(row.text || '').toLowerCase().includes(query));
            return `${card(`<div style="display:flex;gap:7px;align-items:center"><input data-pl-query="hook" value="${esc(state.hookQuery)}" placeholder="filter exact embedded hook text" style="flex:1;min-width:180px;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:6px 8px;border-radius:5px;font-size:10px"/>${button('Apply', 'data-pl-apply-query')}</div>`)}
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:7px">${rows.map(row => {
                const selected = state.hookId === row.videoId, seg = row.selectedSegmentation || {};
                return `<button data-pl-hook="${esc(row.videoId)}" style="text-align:left;background:${selected ? C.cyan + '12' : C.card};border:1px solid ${selected ? C.cyan : C.border};border-radius:7px;padding:8px;cursor:pointer"><div style="font-size:10px;line-height:1.4;color:${C.text};font-weight:700">${esc(row.text || '')}</div><div style="font-size:9px;color:${statusColor(seg.status)};margin-top:5px">${esc(seg.status || 'not built')} · ${seg.segmentCount || '-'} segment${seg.segmentCount === 1 ? '' : 's'} · search p ${fmt(seg.searchWideP, 3)}</div><div style="font-size:9px;color:${C.mute};margin-top:2px">${row.experimentCount || 0} registered partitions · ${(row.candidates || []).length} candidate spans</div></button>`;
            }).join('')}</div>`;
        }

        function segmentationText(hook, key, color) {
            const segmentation = hook[key] || {};
            const tokens = hook.tokens || [];
            const spans = segmentation.partition || [];
            return `<div style="font-size:9px;color:${C.mute};margin-bottom:4px">${esc(segmentation.selectionRule || '')}</div><div style="display:flex;gap:3px;flex-wrap:wrap">${spans.map((span, index) => `<span style="border-bottom:3px solid ${clusterColor(index)};padding:3px 4px;font-size:10px;color:${C.text};background:${C.card2}">${esc(tokens.slice(span[0], span[1]).map(token => token.text).join(' '))}</span>`).join('')}</div><div style="font-size:9px;color:${color};margin-top:5px">${esc(segmentation.status || '')} · k ${segmentation.segmentCount || '-'} · score ${fmt(segmentation.selectionScore, 3)} · search p ${fmt(segmentation.searchWideP, 3)}</div>`;
        }

        function renderHookDetail() {
            const hook = state.hook;
            if (!state.hookId) return card(`<div style="font-size:10px;color:${C.dim}">Select a hook to inspect every input, interaction, boundary and candidate embedding.</div>`);
            if (!hook) return loading('hook detail');
            if (hook.error) return card(`<div style="color:${C.red}">${esc(hook.error)}</div>`);
            const boundaries = (hook.boundaries || []).slice().sort((a, b) => b.calibratedZ - a.calibratedZ);
            return `<div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:9px;margin-top:10px">
                <div>${card(`<div style="font-size:12px;font-weight:900;color:${C.text};line-height:1.5">${esc(hook.text)}</div><div style="font-size:9px;color:${C.mute};margin-top:5px">This exact string is the embedding input. No title, visual, metric or example label enters discovery.</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">Null-calibrated selected partition</div>${segmentationText(hook, 'selectedSegmentation', statusColor((hook.selectedSegmentation || {}).status))}<div style="height:1px;background:${C.border};margin:10px 0"></div><div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">Best nontrivial sensitivity partition</div>${segmentationText(hook, 'exploratoryNontrivialSegmentation', C.amber)}`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">Token-to-token inclusion-exclusion matrix</div><canvas data-pl-canvas="interaction" style="width:100%;height:340px;display:block"></canvas><div style="font-size:9px;color:${C.mute};margin-top:5px">Each cell is ||E(H)-E(H-i)-E(H-j)+E(H-{i,j})|| normalized by both single-token effects. This is computed, not model-attention theater.</div>`)}</div>
                <div>${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">Boundary evidence above its matched null</div><div style="max-height:340px;overflow:auto">${boundaries.map(row => `<div style="display:grid;grid-template-columns:28px 1fr 48px;gap:5px;align-items:center;margin-bottom:5px"><b style="font-size:9px;color:${C.text}">${row.index}</b><div style="height:6px;background:${C.border}"><div style="height:100%;width:${Math.max(0, Math.min(100, 50 + row.aboveNullFrequency * 250))}%;background:${row.calibratedZ > 0 ? C.green : C.red}"></div></div><span style="font-size:8px;color:${C.dim}">z ${fmt(row.calibratedZ, 2)}</span></div>`).join('')}</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">This hook inside component space</div><canvas data-pl-canvas="hook-map" style="width:100%;height:260px;display:block"></canvas><div style="font-size:9px;color:${C.mute};margin-top:4px">Bright points are this hook's candidate spans; dim points are the full corpus atlas.</div>`)}</div>
            </div>`;
        }

        function renderHooks() {
            return `${hookRows()}${renderHookDetail()}`;
        }

        function renderBoundaries() {
            const discovery = state.data.discovery;
            if (!discovery) return loading('discovery');
            const rows = discovery.rows || [];
            const supported = rows.filter(row => (row.selectedSegmentation || {}).status === 'supported');
            const noEvidence = rows.filter(row => (row.selectedSegmentation || {}).status === 'no-separable-component-evidence');
            const all = rows.flatMap(row => (row.boundaries || []).map(boundary => ({ ...boundary, videoId: row.videoId, text: row.text })));
            all.sort((a, b) => b.calibratedZ - a.calibratedZ);
            return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${stat('hooks', rows.length, C.cyan)}${stat('supported partitions', supported.length, C.green)}${stat('no component evidence', noEvidence.length, C.amber)}${stat('boundary positions tested', all.length.toLocaleString(), C.purple)}</div>
            ${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:8px">Strongest above-null boundaries across the corpus</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:6px">${all.slice(0, 120).map(row => `<button data-pl-hook="${esc(row.videoId)}" data-pl-open-hooks style="text-align:left;background:${C.card2};border:1px solid ${C.border};padding:7px;border-radius:6px;cursor:pointer"><div style="font-size:9px;color:${C.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.text)}</div><div style="font-size:8px;color:${C.dim};margin-top:3px">boundary ${row.index} · observed ${pct(row.frequency * 100)} · null ${pct(row.nullFrequency * 100)} · z ${fmt(row.calibratedZ, 2)} · q ${fmt(row.calibratedQ, 3)}</div></button>`).join('')}</div>`)} `;
        }

        function atlasScopeControls(atlas) {
            const representations = (atlas && atlas.representations) || Object.keys((atlas && atlas.projections) || {});
            if (representations.length && !representations.includes(state.representation)) state.representation = representations[0];
            return `<div style="display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-bottom:8px"><div style="display:flex;gap:5px;flex-wrap:wrap">${button('Evidence-supported spans', 'data-pl-atlas-scope="supported"', state.atlasScope === 'supported')}${button('Every contiguous span', 'data-pl-atlas-scope="all"', state.atlasScope === 'all')}</div><div style="display:flex;gap:5px;flex-wrap:wrap">${representations.map(name => button(name, `data-pl-rep="${name}"`, state.representation === name)).join('')}</div></div>`;
        }

        function selectedComponent(atlas) {
            return atlasRows(atlas).find(row => row.id === state.componentId) || null;
        }

        function supportValue(row, name) {
            const evidence = row && (row.boundaryEvidence || row);
            return evidence && evidence[name];
        }

        function selectedInputDetail(atlas, selected) {
            if (!selected) return card(`<div style="font-size:10px;color:${C.dim}">No span selected.</div>`);
            const hook = selected.hookText || (((atlas.hooks || [])[selected.hookIndex] || {}).text) || '';
            const hasOffsets = Number.isFinite(selected.charStart) && Number.isFinite(selected.charEnd);
            const source = hasOffsets
                ? `${esc(hook.slice(0, selected.charStart))}<mark style="background:${C.cyan}2a;color:${C.text};padding:1px 2px">${esc(hook.slice(selected.charStart, selected.charEnd))}</mark>${esc(hook.slice(selected.charEnd))}`
                : esc(hook);
            const z = supportValue(selected, 'calibratedZ'), q = supportValue(selected, 'calibratedQ');
            const formula = ((atlas.representationFormulae || {})[state.representation]) || state.representation;
            return card(`<div style="font-size:12px;font-weight:900;color:${C.text};line-height:1.45">${esc(selected.text)}</div><div style="font-size:8px;color:${C.mute};margin:7px 0 2px">exact source hook and selected offsets</div><div style="font-size:10px;color:${C.dim};line-height:1.5">${source}</div><div style="font-size:8px;color:${C.faint};margin-top:6px">tokens ${selected.start}-${selected.end} · width ${selected.tokenCount} · position/length are browse-only</div><div style="height:1px;background:${C.border};margin:9px 0"></div><div style="font-size:8px;color:${C.mute};margin-bottom:2px">embedding view input</div><div style="font-size:9px;color:${C.text};line-height:1.45">${esc(formula)}</div><div style="height:1px;background:${C.border};margin:9px 0"></div><div style="font-size:9px;color:${C.dim}">${selected.contextText ? `retained context: ${esc(selected.contextText)}<br>` : ''}boundary-supported: ${selected.boundarySupported === false ? 'no' : z != null ? 'yes' : 'not recorded'}<br>calibrated z ${fmt(z, 3)} · q ${fmt(q, 3)}${selected.selectedPrimary != null ? `<br>selected evidence partition: ${selected.selectedPrimary ? 'yes' : 'no'}<br>selected sensitivity partition: ${selected.selectedExploratory ? 'yes' : 'no'}` : ''}</div>`);
        }

        function renderComponents() {
            const atlas = activeAtlas();
            if (!atlas) return loading(state.atlasScope === 'all' ? 'allSpanAtlas' : 'atlas');
            const selected = selectedComponent(atlas);
            const allRows = atlasRows(atlas);
            const supportedRows = allRows.filter(row => row.boundarySupported !== false && supportValue(row, 'calibratedZ') != null)
                .sort((a, b) => Number(supportValue(b, 'calibratedZ') || -Infinity) - Number(supportValue(a, 'calibratedZ') || -Infinity));
            const browserRows = supportedRows.length ? supportedRows.slice(0, 200) : allRows.slice(0, 200);
            return `${atlasScopeControls(atlas)}<div class="pl-split" style="display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,.5fr);gap:9px">
                ${card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:7px"><div><div style="font-size:11px;font-weight:900;color:${C.text}">${esc(state.representation)} embedding · ${state.atlasScope === 'all' ? 'every contiguous span' : 'evidence-supported candidates'}</div><div style="font-size:9px;color:${C.mute}">${atlasCount(atlas).toLocaleString()} exact spans. Click a point to see the literal substring, source hook, offsets, and vector formula.</div></div></div><canvas data-pl-canvas="components" style="width:100%;height:540px;display:block"></canvas>`)}
                <div>${selectedInputDetail(atlas, selected)}
                ${card(`<div style="font-size:10px;font-weight:900;color:${C.text};margin-bottom:6px">${supportedRows.length ? 'Strongest boundary-supported rows' : 'Enumerated rows'}</div><div style="max-height:390px;overflow:auto">${browserRows.map(row => `<button data-pl-component="${row.id}" style="width:100%;text-align:left;background:${state.componentId === row.id ? C.cyan + '12' : 'transparent'};border:0;border-bottom:1px solid ${C.border};padding:5px;color:${C.dim};font-size:9px;cursor:pointer"><b style="color:${C.text}">${esc(row.text)}</b><br>${supportValue(row, 'calibratedZ') != null ? `z ${fmt(supportValue(row, 'calibratedZ'), 2)} · q ${fmt(supportValue(row, 'calibratedQ'), 3)}` : `${row.tokenCount} tokens · exhaustive span`}</button>`).join('')}</div>`)}</div>
            </div>`;
        }

        function renderClusters() {
            const atlas = activeAtlas();
            if (!atlas) return loading(state.atlasScope === 'all' ? 'allSpanAtlas' : 'atlas');
            const maps = atlas.maps || [];
            const selected = maps[Math.max(0, Math.min(state.mapIndex, maps.length - 1))] || {};
            const pageSize = 24, start = state.mapPage * pageSize;
            const clusterSummaries = (selected.clusterSummaries || []).filter(summary =>
                state.focusedCluster == null || Number(summary.label) === Number(state.focusedCluster));
            const rows = atlasRows(atlas);
            const diagnostics = selected.lengthNMI == null ? '' : ` · length NMI ${fmt(selected.lengthNMI, 3)} · position NMI ${fmt(selected.positionNMI, 3)} · cross-hook generality ${fmt(selected.crossHookGenerality, 3)}`;
            const persistence = selected.crossScopeBestARI == null ? '' : ` · best supported-atlas ARI ${fmt(selected.crossScopeBestARI, 3)} (${esc(selected.crossScopeBestRepresentation || '')}) · boundary enrichment ${fmt(selected.boundarySupportWeightedEnrichment, 3)}`;
            return `${atlasScopeControls(atlas)}${manualProbeSummary()}${manualMetricGlossary()}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:9px">${stat('registered experiments', Number(atlas.experimentCount || 0).toLocaleString(), C.green)}${stat('maps retained', maps.length, C.cyan)}${stat(state.atlasScope === 'all' ? 'all spans' : 'candidates', atlasCount(atlas).toLocaleString(), C.purple)}${stat('outcomes used', '0', C.amber)}</div>
            ${card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:6px"><div><div style="font-size:11px;font-weight:900;color:${C.text}">${esc(selected.representation || '')} · ${esc(selected.geometry || '')} · ${selected.pcaDimensions || '-'}D · k=${selected.clusterCount || '-'}${state.focusedCluster == null ? '' : ` · isolated cluster ${state.focusedCluster}`}</div><div style="font-size:9px;color:${C.mute}">margin above null ${fmt(selected.marginAboveNull, 3)} · fit-excluded margin ${fmt(selected.heldoutHookMargin, 3)} (full-corpus PCA; descriptive) · seed ARI ${fmt(selected.seedStabilityARI, 3)} · entropy ${fmt(selected.entropy, 3)}${diagnostics}${persistence} · ${selected.pareto ? 'Pareto front' : 'ranked sensitivity map'}</div></div>${state.focusedCluster == null ? '' : button('Show all clusters', 'data-pl-clear-cluster-focus')}</div><canvas data-pl-canvas="cluster" style="width:100%;height:520px;display:block"></canvas>`)}
            ${manualProbeDetail(selected)}
            ${clusterSummaries.length ? card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:2px">Cluster composition and representative observed spans</div><div style="font-size:8px;color:${C.mute};margin-bottom:7px">Representatives are nearest the cluster centroid in this displayed 2D projection, with distinct source hooks selected first; they never enter fitting.</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:7px;max-height:620px;overflow:auto">${clusterSummaries.map(summary => `<div style="border-left:3px solid ${clusterColor(summary.label)};background:${C.card2};padding:7px"><div style="display:flex;justify-content:space-between;gap:6px;font-size:8px;color:${C.mute};margin-bottom:5px"><b style="color:${clusterColor(summary.label)}">cluster ${summary.label}</b><span>${Number(summary.size || 0).toLocaleString()} spans · ${summary.hookCount || 0} hooks · median ${fmt(summary.medianTokenCount, 1)} tokens${summary.boundarySupportedFraction == null ? '' : ` · ${pct(summary.boundarySupportedFraction * 100)} boundary-supported`}</span></div>${(summary.representativeIndices || []).map(index => { const row = rows[index] || {}; return `<button data-pl-component="${esc(row.id || '')}" data-pl-open-components style="display:block;width:100%;text-align:left;border:0;border-top:1px solid ${C.border};background:transparent;color:${C.text};font-size:8.5px;padding:4px 0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.text || '')}</button>`; }).join('')}</div>`).join('')}</div>`) : ''}
            ${card(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px"><div><div style="font-size:11px;font-weight:900;color:${C.text}">All retained clustering maps</div><div style="font-size:8px;color:${C.mute}">${maps.length ? `${start + 1}-${Math.min(maps.length, start + pageSize)} of ${maps.length}` : '0 maps'}</div></div><div style="display:flex;gap:5px">${button('Previous', 'data-pl-map-page="-1"')}${button('Next', 'data-pl-map-page="1"')}</div></div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:7px">${maps.slice(start, start + pageSize).map((row, offset) => { const index = start + offset; return `<button data-pl-map="${index}" style="text-align:left;background:${index === state.mapIndex ? C.cyan + '12' : C.card2};border:1px solid ${index === state.mapIndex ? C.cyan : C.border};border-radius:6px;padding:5px;cursor:pointer"><div style="font-size:8px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.representation)} · ${esc(row.geometry)} · ${row.pcaDimensions}D · k${row.clusterCount}</div><canvas data-pl-canvas="cluster-mini" data-pl-map-index="${index}" style="width:100%;height:88px;display:block"></canvas><div style="font-size:8px;color:${C.mute}">ARI ${fmt(row.seedStabilityARI, 2)} · null lift ${fmt(row.marginAboveNull, 2)}${row.lengthNMI == null ? '' : ` · length NMI ${fmt(row.lengthNMI, 2)}`}</div></button>`; }).join('')}</div>`)} `;
        }

        function renderSwaps() {
            const swaps = state.data.swaps;
            if (!swaps) return loading('swaps');
            const metric = state.metric;
            const sources = (swaps.sourceComponents || []).slice().sort((a, b) => ((b.metrics[metric] || {}).transferPercentile || 0) - ((a.metrics[metric] || {}).transferPercentile || 0));
            const detail = state.source;
            const projectionSource = detail && detail.targets && detail.targets[0]
                ? ((detail.targets[0].scores[metric] || {}).source || '') : '';
            return `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">${(swaps.metricNames || []).map(name => button(metricLabel(name), `data-pl-metric="${name}"`, metric === name)).join('')}</div>
            <div class="pl-split" style="display:grid;grid-template-columns:minmax(290px,.65fr) minmax(0,1.35fr);gap:9px">
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:6px">Source components ranked across every target context</div><div style="font-size:9px;color:${C.mute};margin-bottom:7px">${swaps.sourceComponentCount || 0} sources x ${swaps.targetHookCount || 0} hooks = ${Number(swaps.swapRows || 0).toLocaleString()} scored recompositions.</div><div style="max-height:650px;overflow:auto">${sources.map(row => { const score = row.metrics[metric] || {}; return `<button data-pl-source="${row.sourceId}" style="width:100%;text-align:left;background:${state.sourceId === row.sourceId ? C.cyan + '12' : 'transparent'};border:0;border-bottom:1px solid ${C.border};padding:7px;cursor:pointer"><div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:10px;color:${C.text}">${esc(row.text)}</b><b style="font-size:10px;color:${score.meanDeltaAcrossContexts >= 0 ? C.green : C.red}">${signed(score.meanDeltaAcrossContexts, 2)}</b></div><div style="font-size:8px;color:${C.mute}">${fmt(score.transferPercentile, 1)}th transfer · ${pct(score.positiveContextRate * 100)} positive · context SD ${fmt(score.contextSensitivity, 2)}</div></button>`; }).join('')}</div>`)}
                <div>${!state.sourceId ? card(`<div style="font-size:10px;color:${C.dim}">Select a source component to inspect all target hooks, exact recomposed text and every Long Quant score.</div>`) : !detail ? loading('source swap surface') : detail.error ? card(`<div style="color:${C.red}">${esc(detail.error)}</div>`) : `${card(`<div style="font-size:12px;font-weight:900;color:${C.text}">${esc(detail.source.text)}</div><div style="font-size:9px;color:${C.mute};margin-top:4px">Source retained context: ${esc(detail.source.contextText)}</div><div style="font-size:8px;color:${C.faint};margin-top:5px">${esc(metricLabel(metric))} projection input: complete recomposed hook text · scorer: ${esc(projectionSource)}</div>`)}${card(`<canvas data-pl-canvas="swap-bars" style="width:100%;height:220px;display:block"></canvas><div style="font-size:9px;color:${C.mute};margin-top:4px">Each bar is the ${esc(metricLabel(metric))} percentile delta from that target hook's own baseline. This exposes context dependence instead of hiding it in an average.</div>`)}${(detail.targets || []).slice().sort((a, b) => ((b.scores[metric] || {}).deltaFromBaseline || 0) - ((a.scores[metric] || {}).deltaFromBaseline || 0)).map(row => { const score = row.scores[metric] || {}; return card(`<div style="display:flex;justify-content:space-between;gap:8px"><div style="min-width:0"><div style="font-size:8px;color:${C.mute};margin-bottom:2px">exact recomposed embedding input</div><div style="font-size:10px;color:${C.text};font-weight:800">${esc(row.recomposedText)}</div></div><div style="text-align:right;white-space:nowrap"><div style="font-size:11px;color:${score.deltaFromBaseline >= 0 ? C.green : C.red};font-weight:900">${signed(score.deltaFromBaseline, 1)}</div><div style="font-size:8px;color:${C.mute}">${fmt(score.percentile, 1)}th vs ${fmt(score.baselinePercentile, 1)}th</div></div></div><div style="font-size:8px;color:${C.faint};margin-top:5px;line-height:1.45"><b>baseline hook:</b> ${esc(row.targetHookText)}<br><b>replaced span:</b> ${esc(row.targetText)} · combined consensus ${fmt(row.atlasCoassociation, 3)} · all-span ${fmt(row.allSpanAtlasCoassociation, 3)}${row.candidateAtlasCoassociation == null ? '' : ` · supported ${fmt(row.candidateAtlasCoassociation, 3)}`} · influence cosine ${fmt(row.influenceCosine, 3)}${row.identityControl ? ' · exact identity control' : ''}</div>`, 'margin-bottom:6px'); }).join('')}`}</div>
            </div>`;
        }

        function renderAxes() {
            const axes = state.data.axes;
            if (!axes) return loading('axes');
            if (!state.data.findings) return loading('findings');
            const maps = axes.maps || [];
            if (state.pendingAxisTarget) {
                const targetIndex = maps.findIndex(row => String((row.experiment || {}).target) === String(state.pendingAxisTarget));
                if (targetIndex >= 0) state.axisIndex = targetIndex;
                state.pendingAxisTarget = null;
            }
            const map = maps[Math.max(0, Math.min(state.axisIndex, maps.length - 1))] || {};
            const selectedExperiments = maps.map(row => row.experiment || {});
            const modelAxes = selectedExperiments.filter(row => row.targetChannel === 'Long Quant model-predicted counterfactual');
            const observedAxes = selectedExperiments.filter(row => row.targetChannel === 'observed YouTube outcome');
            const validatedModel = modelAxes.filter(axisRandomFoldSupported);
            const validatedObserved = observedAxes.filter(axisRandomFoldSupported);
            const validatedObservedSpan = validatedObserved.filter(row => ['raw', 'influence', 'nonadditive'].includes(row.representation));
            const selectedExperiment = map.experiment || {};
            const observedFormatter = legacyAxisValueFormatter(selectedExperiment);
            return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:9px">${stat('axis experiments', Number(axes.experimentCount || 0).toLocaleString(), C.purple)}${stat('model source-grouped', `${validatedModel.length}/${modelAxes.length}`, C.green)}${stat('observed random-fold', `${validatedObserved.length}/${observedAxes.length}`, C.amber)}${stat('observed span support', validatedObservedSpan.length, C.amber)}${stat('source videos', axes.sourceVideos || 0, C.cyan)}${stat('confound sets', (axes.confoundSets || []).length, C.orange)}</div>
                    ${card(`<div style="font-size:9px;color:${C.dim};line-height:1.5"><b style="color:${C.text}">Current result:</b> model-predicted transfer is source-grouped supported on raw source-span semantics. Observed-retention axes are random-fold diagnostics on retained hook context with no chronological replication. No observed raw, influence, or non-additive source-span axis passed. Outcome metrics measure candidate directions; they are not themselves semantic component names.</div>`, 'margin-bottom:9px')}
                    <div class="pl-split" style="display:grid;grid-template-columns:minmax(280px,.65fr) minmax(0,1.35fr);gap:9px">${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">Selected required-confound direction per target</div><div style="max-height:720px;overflow:auto">${maps.map((row, index) => { const exp = row.experiment || {}; const lineage = axisLineageFor(row) || {}, window = lineage.outcomeWindow || {}; const claimColor = axisRandomFoldSupported(exp) ? (exp.targetChannel === 'observed YouTube outcome' ? C.amber : C.green) : C.dim; return `<button data-pl-axis="${index}" style="width:100%;text-align:left;background:${index === state.axisIndex ? C.cyan + '12' : 'transparent'};border:0;border-bottom:1px solid ${C.border};padding:7px;cursor:pointer"><div style="display:flex;justify-content:space-between;gap:6px"><b style="font-size:9px;color:${C.text}">${esc(exp.target || '')}</b><b style="font-size:9px;color:${claimColor}">rho ${fmt(exp.heldoutSpearman, 3)}</b></div><div style="font-size:8px;color:${C.mute}">${esc(exp.representation || '')} · ${exp.pcaDimensions || '-'}D · ${esc(exp.confounds || '')} · search q ${fmt(exp.searchWideQ, 3)}</div><div style="font-size:7px;color:${C.amber};margin-top:2px">${esc(window.label || 'declared target without a fixed viewer-time window')}</div></button>`; }).join('')}</div>`)}
                    ${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:3px">${esc(selectedExperiment.target || 'No axis built')}</div><div style="font-size:9px;color:${C.mute};margin-bottom:4px">${esc(selectedExperiment.targetDefinition || '')}</div><div style="font-size:8px;color:${C.faint};margin-bottom:9px">channel: ${esc(selectedExperiment.targetChannel || '')} · semantic input: ${esc(representationLabel(selectedExperiment.representation || ''))} · target unit/source: ${esc(selectedExperiment.targetUnit || '')} · required confounds: ${esc(selectedExperiment.validationConfoundsRequired || 'none')} · claim: ${esc(legacyAxisClaim(selectedExperiment))}</div>${axisHorizonPanel(map)}<div style="font-size:9px;font-weight:900;color:${C.cyan};margin-bottom:3px">Semantic embedding plane</div><canvas data-pl-canvas="axis" style="width:100%;height:300px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin:4px 0">Horizontal position is the final fitted semantic direction; vertical position is an outcome-blind background component. Point color is the raw selected target below, before confound residualization.</div>${continuousMetricLegend(map.observed || [], observedFormatter, selectedExperiment.targetDefinition || selectedExperiment.target || 'target value')}<div style="font-size:9px;font-weight:900;color:${C.green};margin:11px 0 3px">Grouped-source prediction check</div><canvas data-pl-canvas="axis-oof" style="width:100%;height:300px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:4px">Horizontal is grouped out-of-fold prediction; vertical is the residualized target. Every fold keeps one source video's components together and residualizes both features and targets against the selected confounds. This is not a later-video test and does not extend the semantic input beyond the exact source hook.</div>`)}</div>`;
        }

        function renderRegistry() {
            const registry = state.data.registry;
            if (!registry) return loading('registry');
            const query = state.registryQuery.toLowerCase();
            let rows = registry.rows || [];
            if (state.registryStage !== 'all') rows = rows.filter(row => row.stage === state.registryStage);
            if (query) rows = rows.filter(row => JSON.stringify(row).toLowerCase().includes(query));
            const pageSize = 100, maxPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
            state.registryPage = Math.min(state.registryPage, maxPage);
            const page = rows.slice(state.registryPage * pageSize, (state.registryPage + 1) * pageSize);
            const stages = ['all', ...Object.keys(registry.stageCounts || {})];
            return `${card(`<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input data-pl-query="registry" value="${esc(state.registryQuery)}" placeholder="search method, target, representation, status" style="flex:1;min-width:220px;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:6px 8px;border-radius:5px;font-size:10px"/>${button('Apply', 'data-pl-apply-query')}${stages.map(stage => button(stage, `data-pl-registry-stage="${stage}"`, state.registryStage === stage)).join('')}</div>`)}
            ${card(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px"><div style="font-size:10px;color:${C.dim}">${rows.length.toLocaleString()} matching registered experiments · page ${state.registryPage + 1} / ${maxPage + 1}</div><div style="display:flex;gap:5px">${button('Previous', 'data-pl-registry-page="-1"')}${button('Next', 'data-pl-registry-page="1"')}</div></div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:8.5px"><thead><tr>${['stage', 'method / representation', 'configuration', 'held-out / null', 'status', 'id'].map(label => `<th style="text-align:left;color:${C.mute};padding:5px;border-bottom:1px solid ${C.border}">${label}</th>`).join('')}</tr></thead><tbody>${page.map(row => `<tr><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.text}">${esc(row.stage || '')}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${esc(row.method || row.representation || '')}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${row.segmentCount != null ? `k=${row.segmentCount}` : row.clusterCount != null ? `${row.pcaDimensions}D k=${row.clusterCount} ${esc(row.geometry || '')}` : `${row.pcaDimensions || '-'}D alpha ${row.ridgeAlpha || '-'} · ${esc(row.confounds || '')}`}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${row.heldoutSpearman != null ? `rho ${fmt(row.heldoutSpearman, 3)} · search p ${fmt(row.searchWideP, 3)}${row.searchWideQ != null ? ` · selected q ${fmt(row.searchWideQ, 3)}` : ''}` : row.crossScopeARI != null ? `cross-scope ARI ${fmt(row.crossScopeARI, 3)} · boundary enrichment ${fmt(row.boundarySupportWeightedEnrichment, 3)}` : row.marginAboveNull != null ? `margin ${fmt(row.marginAboveNull, 3)} · ARI ${fmt(row.seedStabilityARI, 3)}` : `z ${fmt(row.z, 3)} · q ${fmt(row.q, 3)}`}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${statusColor(row.status)}">${esc(row.status || (row.outcomesUsed === false ? 'outcome-blind' : ''))}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.faint};font-family:monospace">${esc(row.id || '')}</td></tr>`).join('')}</tbody></table></div>`)} `;
        }

        function renderLattice() {
            const summary = state.data.componentLattice;
            if (!summary) return loading('componentLattice');
            const query = state.latticeCorpusQuery.trim().toLowerCase();
            const allRows = summary.rows || [];
            const rows = allRows.filter(row => !query || `${row.title || ''} ${row.text || ''} ${row.videoId || ''}`.toLowerCase().includes(query));
            const parity = summary.parityContract || {}, graph = summary.graphContract || {};
            return `${card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:300px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Section 5 executable evidence</div><div style="font-size:18px;color:${C.text};font-weight:900;margin-top:2px">Multi-resolution component lattice + relational graph</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:4px">Every contiguous source span is represented once, then tagged with every deterministic resolution it belongs to. The frozen corpus and live predictor both call <b style="color:${C.text}">${esc(parity.builder || '')}</b>; the graph is not rebuilt by a second UI-only approximation.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('hooks built', `${Number(summary.hookCount || 0).toLocaleString()}/${allRows.length.toLocaleString()}`, Number(summary.hookCount || 0) === allRows.length ? C.green : C.amber)}${stat('span nodes', Number(summary.spanCount || 0).toLocaleString(), C.cyan)}${stat('graph edges', Number(summary.edgeCount || 0).toLocaleString(), C.purple)}${stat('Long Quant titles', Number((summary.titleManifold || {}).sourceRows || 0).toLocaleString(), C.green)}</div></div><div style="font-size:8px;color:${C.mute};line-height:1.55;margin-top:8px">Representation formula: <b style="color:${C.text}">${esc(summary.representationVersion || parity.representationVersion || '')}</b> · training storage: ${esc(parity.trainingVectorStorageDtype || '')} · predictor quantizes before derived views: <b style="color:${parity.predictorQuantizesBeforeDerivedRepresentations ? C.green : C.red}">${parity.predictorQuantizesBeforeDerivedRepresentations ? 'yes' : 'not verified'}</b><br>Structural edges use outcomes: <b style="color:${graph.structuralEdgeOutcomesUsed ? C.red : C.green}">${graph.structuralEdgeOutcomesUsed ? 'YES' : 'NO'}</b> · stored outcome edges: ${esc(graph.storedOutcomeEdges || '')} · live outcome edges: ${esc(graph.liveOutcomeEdges || '')}</div>`, 'margin-bottom:9px;border-color:' + C.cyan + '66')}
            ${card(`<div style="display:flex;gap:6px;align-items:flex-end"><label style="flex:1"><span style="display:block;font-size:8px;color:${C.mute};font-weight:900;text-transform:uppercase;margin-bottom:4px">Search ${allRows.length.toLocaleString()} stored hook lattices</span><input data-pl-query="lattice-corpus" value="${esc(state.latticeCorpusQuery)}" placeholder="title, hook text, or video ID" style="width:100%;box-sizing:border-box;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:7px 8px;font-size:9px"></label>${button('Apply', 'data-pl-lattice-apply')}</div><div style="max-height:310px;overflow:auto;margin-top:8px">${rows.map(row => `<button data-pl-lattice-video="${esc(row.videoId)}" style="width:100%;display:grid;grid-template-columns:minmax(250px,1fr) repeat(3,minmax(75px,.25fr));gap:7px;align-items:center;text-align:left;border:0;border-top:1px solid ${C.border};background:${String(row.videoId) === String(state.latticeVideoId) ? C.cyan + '12' : 'transparent'};padding:7px;cursor:pointer"><span style="min-width:0"><b style="display:block;color:${C.text};font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.title || row.videoId)}</b><span style="display:block;color:${C.mute};font-size:7.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.text || '')}</span></span><span style="color:${C.cyan};font-size:8px">${Number(row.spanCount || 0).toLocaleString()} spans</span><span style="color:${C.purple};font-size:8px">${Number(row.edgeCount || 0).toLocaleString()} edges</span><span style="color:${row.timingSource === 'exact-caption-alignment' ? C.green : C.amber};font-size:8px">${esc(row.timingSource || '')}</span></button>`).join('') || `<div style="font-size:9px;color:${C.mute}">No stored hooks match.</div>`}</div>`, 'margin-bottom:9px')}
            ${renderLatticeSurface(state.latticeDetail, 'stored measured hook')}`;
        }

        function renderResearchContract() {
            const audit = state.data.researchContract;
            if (!audit) return loading('researchContract');
            const counts = audit.implementationStatusCounts || {}, inventory = audit.currentInventory || {};
            const done = audit.definitionOfDone || {}, source = audit.contract || {};
            const section5 = audit.section5Audit || {};
            const statusColors = { implemented: C.green, active: C.cyan, partial: C.amber, 'blocked-data': C.purple, 'not-met': C.red };
            return `${card(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:300px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">Frozen research contract audit</div><div style="font-size:18px;color:${C.text};font-weight:900;margin-top:2px">${Number((audit.rows || []).length).toLocaleString()} document sections checked against executable artifacts</div><div style="font-size:9px;color:${C.dim};line-height:1.55;margin-top:4px">Source hash <span style="font-family:monospace;color:${C.text}">${esc(source.sha256 || '')}</span> · ${Number(source.lines || 0).toLocaleString()} lines. “Implemented” means an inspectable artifact exists; it does not silently promote an observational relationship into causal reference-to-gratification truth.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${Object.entries(counts).map(([name, value]) => stat(name, value, statusColors[name] || C.text)).join('')}</div></div><div style="font-size:10px;color:${done.met ? C.green : C.red};font-weight:900;margin-top:8px">Definition of done: ${done.met ? 'MET' : 'NOT MET'}</div><div style="font-size:8.5px;color:${C.dim};line-height:1.55;margin-top:3px">${esc(done.reason || '')} ${esc(done.languageRule || '')}</div>`, 'margin-bottom:9px;border-color:' + (done.met ? C.green : C.red) + '66')}
            ${card(`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:9px">${stat('measured hooks', inventory.measuredHooks || 0, C.cyan)}${stat('lattice hooks', inventory.componentLatticeHooks || 0, C.green)}${stat('lattice spans', Number(inventory.componentSpanNodes || 0).toLocaleString(), C.purple)}${stat('lattice edges', Number(inventory.componentGraphEdges || 0).toLocaleString(), C.purple)}${stat('current title vectors', Number(inventory.currentLongQuantTitleVectors || 0).toLocaleString(), C.green)}</div><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:8px 0"><div style="border-left:3px solid ${section5.sharedCorpusAndPredictorBuilder ? C.green : C.red};padding-left:7px;font-size:8px;color:${C.dim}">corpus/predictor builder<br><b style="color:${C.text}">${section5.sharedCorpusAndPredictorBuilder ? 'shared' : 'not verified'}</b></div><div style="border-left:3px solid ${C.cyan};padding-left:7px;font-size:8px;color:${C.dim}">representation formula<br><b style="color:${C.text};overflow-wrap:anywhere">${esc(section5.representationVersion || '')}</b></div><div style="border-left:3px solid ${section5.structuralEdgesUseOutcomes === false ? C.green : C.red};padding-left:7px;font-size:8px;color:${C.dim}">structural outcome leakage<br><b style="color:${C.text}">${section5.structuralEdgesUseOutcomes === false ? 'none' : 'not verified'}</b></div></div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-bottom:9px">${esc(section5.claimBoundary || '')}</div><div style="font-size:9px;color:${C.text};font-weight:900;margin-bottom:5px">Blocked evidence required before causal promotion</div>${(audit.blockedDataRequirements || []).map(value => `<div style="font-size:8.5px;color:${C.dim};border-top:1px solid ${C.border};padding:5px 0">${esc(value)}</div>`).join('')}`, 'margin-bottom:9px')}
            ${card(`<div style="overflow:auto;max-height:760px"><table data-pl-research-contract-table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['document section', 'status', 'executable interpretation', 'evidence', 'source lines'].map(value => `<th style="position:sticky;top:0;background:${C.card};text-align:left;padding:6px;color:${C.mute};border-bottom:1px solid ${C.border};z-index:1">${esc(value)}</th>`).join('')}</tr></thead><tbody>${(audit.rows || []).map(row => `<tr><td style="padding:6px;border-bottom:1px solid ${C.border};color:${C.text};font-weight:800">${esc(row.title || row.key || '')}</td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${statusColors[row.status] || C.text};font-weight:900">${esc(row.status || '')}</td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${C.dim};line-height:1.45">${esc(row.statement || '')}</td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${C.cyan};font-family:monospace">${(row.evidenceArtifacts || []).map(esc).join(', ')}</td><td style="padding:6px;border-bottom:1px solid ${C.border};color:${C.mute};white-space:nowrap">${row.lineStart || '-'}–${row.lineEnd || '-'}</td></tr>`).join('')}</tbody></table></div>`)}`;
        }

        function body() {
            return {
                overview: renderOverview, scorer: renderHookScorer, library: renderHookLibrary, lattice: renderLattice, contract: renderResearchContract, hooks: renderHooks, boundaries: renderBoundaries,
                components: renderComponents, clusters: renderClusters, saved: renderSavedProjection, swaps: renderSwaps,
                axes: renderAxes, registry: renderRegistry,
            }[state.view]();
        }

        function render() {
            return `<div id="pl-root" style="font-family:'Nunito',sans-serif;color:${C.text}">${responsiveStyles()}${header()}<div data-pl-progress-host>${progressStrip()}</div>${body()}</div>`;
        }

        function responsiveStyles() {
            return `<style>@media(max-width:1180px){#pl-root .pl-component-map-grid,#pl-root .pl-component-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}#pl-root .pl-library-row{grid-template-columns:minmax(250px,1.4fr) repeat(2,minmax(100px,.6fr))!important}#pl-root .pl-library-row>canvas{grid-column:1/-1}}@media(max-width:820px){#pl-root .pl-split,#pl-root .pl-metric-channels,#pl-root .pl-natural-stats,#pl-root .pl-outcome-strip,#pl-root .pl-component-map-grid,#pl-root .pl-component-summary-grid,#pl-root .pl-lattice-controls{grid-template-columns:minmax(0,1fr)!important}#pl-root .pl-library-row{grid-template-columns:repeat(2,minmax(0,1fr))!important;align-items:start!important}#pl-root .pl-library-row>div:first-child,#pl-root .pl-library-row>canvas{grid-column:1/-1}#pl-root canvas{max-width:100%}#pl-root [data-pl-outcome-inspector]{height:auto!important;min-height:280px}}</style>`;
        }

        function paint() {
            const root = document.getElementById('pl-root');
            if (!root) return;
            root.innerHTML = `${responsiveStyles()}${header()}<div data-pl-progress-host>${progressStrip()}</div>${body()}`;
            drawCanvases();
        }

        function canvasContext(canvas) {
            const ratio = window.devicePixelRatio || 1;
            const width = Math.max(120, canvas.clientWidth || 400), height = Math.max(80, canvas.clientHeight || 240);
            canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
            const context = canvas.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0);
            context.clearRect(0, 0, width, height); context.fillStyle = C.card2; context.fillRect(0, 0, width, height);
            return { context, width, height };
        }

        function bounds(values) {
            const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
            if (!sorted.length) return [0, 1];
            return [sorted[Math.floor(sorted.length * .01)], sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .99))]];
        }

        function scatter(canvas, points, colors, selectedIds, alphas, equalScale = false, focusedId = null) {
            if (!points || !points.length) return;
            let visible = points.map((point, index) => ({ point, index })).filter(row =>
                Array.isArray(row.point) && Number.isFinite(row.point[0]) && Number.isFinite(row.point[1]));
            const maximum = canvas.dataset.plCanvas === 'cluster-mini' ? 2400 : 30000;
            if (visible.length > maximum) {
                const selectedRows = selectedIds ? visible.filter(row => selectedIds.has(row.index)) : [];
                const selectedRowIds = new Set(selectedRows.map(row => row.index));
                const remaining = visible.filter(row => !selectedRowIds.has(row.index));
                const budget = Math.max(0, maximum - selectedRows.length);
                const stride = Math.max(1, Math.ceil(remaining.length / Math.max(1, budget)));
                visible = remaining.filter((_, index) => index % stride === 0).slice(0, budget)
                    .concat(selectedRows).sort((left, right) => left.index - right.index);
            }
            if (!visible.length) { canvasContext(canvas); return; }
            canvas.dataset.plPlottedPoints = String(visible.length);
            const { context, width, height } = canvasContext(canvas);
            let xb = bounds(visible.map(row => row.point[0])), yb = bounds(visible.map(row => row.point[1]));
            if (equalScale) {
                const centerX = (xb[0] + xb[1]) / 2, centerY = (yb[0] + yb[1]) / 2;
                const unitsPerPixel = Math.max(
                    (xb[1] - xb[0]) / Math.max(1, width - 16),
                    (yb[1] - yb[0]) / Math.max(1, height - 16),
                );
                const halfX = unitsPerPixel * Math.max(1, width - 16) / 2;
                const halfY = unitsPerPixel * Math.max(1, height - 16) / 2;
                xb = [centerX - halfX, centerX + halfX];
                yb = [centerY - halfY, centerY + halfY];
            }
            const project = point => [8 + (point[0] - xb[0]) / ((xb[1] - xb[0]) || 1) * (width - 16), height - 8 - (point[1] - yb[0]) / ((yb[1] - yb[0]) || 1) * (height - 16)];
            const projected = visible.map(row => project(row.point));
            projected.forEach((point, visibleIndex) => {
                const originalIndex = visible[visibleIndex].index;
                const selected = selectedIds && selectedIds.has(originalIndex);
                const focused = Number.isInteger(focusedId) && focusedId === originalIndex;
                context.globalAlpha = selected || focused ? 1 : alphas ? Number(alphas[originalIndex] ?? .42) : .42;
                context.fillStyle = colors ? colors[originalIndex] : C.cyan;
                const radius = focused ? 5 : selected ? 4 : alphas && Number(alphas[originalIndex]) > .5 ? 2.1 : 1.6;
                context.beginPath(); context.arc(point[0], point[1], radius, 0, Math.PI * 2); context.fill();
                if (selected) {
                    context.strokeStyle = C.cyan;
                    context.lineWidth = 2;
                    context.beginPath(); context.arc(point[0], point[1], radius + 2, 0, Math.PI * 2); context.stroke();
                }
                if (focused) {
                    context.strokeStyle = C.text;
                    context.lineWidth = 2;
                    context.beginPath(); context.arc(point[0], point[1], radius + 2, 0, Math.PI * 2); context.stroke();
                }
            });
            context.globalAlpha = 1;
            canvas.onclick = event => {
                const interactiveKinds = new Set(['components', 'hook-map', 'cluster', 'manual-projection', 'cluster-outcome-axis', 'hook-quality-axis', 'forward-response-axis', 'hook-outcome-axis', 'component-score-axis', 'lattice-embedding']);
                const kind = canvas.dataset.plCanvas;
                const atlas = kind === 'hook-map' ? state.data.atlas : activeAtlas();
                if (!interactiveKinds.has(kind)
                    || (!['manual-projection', 'cluster-outcome-axis', 'hook-quality-axis', 'forward-response-axis', 'hook-outcome-axis', 'component-score-axis', 'lattice-embedding'].includes(kind) && !atlas)) return;
                const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
                let best = -1, distance = Infinity;
                projected.forEach((point, index) => { const d = (point[0] - x) ** 2 + (point[1] - y) ** 2; if (d < distance) { distance = d; best = index; } });
                if (best < 0 || distance >= 225) return;
                const originalIndex = visible[best].index;
                if (kind === 'lattice-embedding') {
                    selectLatticeNode((canvas._plLatticeNodeIds || [])[originalIndex]);
                    return;
                }
                if (kind === 'hook-outcome-axis') {
                    const videoId = (canvas._plOutcomeVideoIds || [])[originalIndex];
                    if (!videoId) return;
                    const scrollX = window.scrollX, scrollY = window.scrollY;
                    state.outcomePointVideoId = String(videoId);
                    paint(); window.scrollTo(scrollX, scrollY); return;
                }
                if (kind === 'component-score-axis') {
                    const ref = (canvas._plComponentRefs || [])[originalIndex];
                    if (!ref) return;
                    const scrollX = window.scrollX, scrollY = window.scrollY;
                    state.outcomeComponentPointKey = `${ref.videoId}:${ref.component}`;
                    paint(); window.scrollTo(scrollX, scrollY); return;
                }
                if (kind === 'hook-quality-axis') {
                    const count = ((((state.data.hookQuality || {}).axis || {}).points || []).length);
                    if (originalIndex >= count) return;
                    const scrollX = window.scrollX, scrollY = window.scrollY;
                    state.hookQualityPointIndex = originalIndex;
                    paint();
                    window.scrollTo(scrollX, scrollY);
                    return;
                }
                if (kind === 'forward-response-axis') {
                    const indices = canvas._plGlobalIndices || [];
                    if (indices[originalIndex] == null) return;
                    const scrollX = window.scrollX, scrollY = window.scrollY;
                    state.forwardResponseComponentIndex = Number(indices[originalIndex]);
                    paint();
                    window.scrollTo(scrollX, scrollY);
                    return;
                }
                if (kind === 'manual-projection') {
                    const pointIndex = ((state.data.manualProjection || {}).frozenPointIndex || {});
                    const spanId = (pointIndex.spanIds || [])[originalIndex];
                    if (!spanId) return;
                    const scrollX = window.scrollX, scrollY = window.scrollY;
                    state.savedPointIndex = originalIndex;
                    paint();
                    window.scrollTo(scrollX, scrollY);
                    return;
                }
                if (kind === 'cluster-outcome-axis') {
                    const scrollX = window.scrollX, scrollY = window.scrollY;
                    state.clusterOutcomePointIndex = originalIndex;
                    const detail = state.clusterOutcomeDetail || {};
                    const globalIndex = (((detail.points || {}).globalIndices || [])[originalIndex]);
                    if (globalIndex != null) {
                        state.latencyPointGlobalIndex = Number(globalIndex);
                        state.latencyCluster = Number(detail.cluster);
                        loadLatencyDetail(detail.cluster);
                    }
                    paint();
                    window.scrollTo(scrollX, scrollY);
                    return;
                }
                const row = atlasRows(atlas)[originalIndex];
                if (!row) return;
                state.componentId = row.id;
                if (state.view !== 'components') state.view = 'components';
                paint();
            };
        }

        function drawInteraction(canvas) {
            const hook = state.hook, matrix = hook && hook.interactionMatrix;
            if (!matrix || !matrix.length) return;
            const { context, width, height } = canvasContext(canvas), n = matrix.length;
            const size = Math.min(width - 70, height - 45), cell = size / n, max = Math.max(...matrix.flat(), .001);
            matrix.forEach((row, y) => row.forEach((value, x) => {
                const t = Math.max(0, Math.min(1, value / max));
                context.fillStyle = `rgb(${Math.round(25 + 220 * t)},${Math.round(45 + 45 * (1 - t))},${Math.round(90 + 150 * (1 - t))})`;
                context.fillRect(55 + x * cell, 8 + y * cell, Math.ceil(cell), Math.ceil(cell));
            }));
            context.fillStyle = C.dim; context.font = '8px sans-serif';
            (hook.tokens || []).forEach((token, index) => { if (index % Math.max(1, Math.ceil(n / 12)) === 0) context.fillText(String(token.text).slice(0, 6), 2, 13 + index * cell); });
        }

        function drawClusterOutcomeOffsets(canvas) {
            const summary = state.data.clusterOutcomes;
            const cluster = summary && (summary.clusters || []).find(
                row => Number(row.label) === Number(state.clusterOutcomeCluster)
            );
            if (!cluster) return;
            const { context, width, height } = canvasContext(canvas);
            const rows = Object.fromEntries((cluster.targets || []).map(row => [row.target, row]));
            const series = [
                ['raw', 'slope_raw_o', C.cyan],
                ['normalized', 'slope_normalized_o', C.purple],
                ['unexpected', 'slope_residual_o', C.green],
            ].map(([label, prefix, color]) => ({
                label, color,
                values: [0, 1, 2, 3, 4, 5].map(offset => numeric((rows[`${prefix}${offset}`] || {}).heldoutSpearman)),
            }));
            const finite = series.flatMap(row => row.values).filter(Number.isFinite);
            const minimum = Math.min(0, ...finite), maximum = Math.max(.01, ...finite);
            const left = 34, right = 10, top = 24, bottom = 24;
            const x = offset => left + offset / 5 * (width - left - right);
            const y = value => height - bottom - (value - minimum) / ((maximum - minimum) || 1) * (height - top - bottom);
            context.strokeStyle = C.border2; context.lineWidth = 1;
            context.beginPath(); context.moveTo(left, y(0)); context.lineTo(width - right, y(0)); context.stroke();
            context.fillStyle = C.mute; context.font = '8px sans-serif';
            for (let offset = 0; offset <= 5; offset++) context.fillText(`+${offset}s`, x(offset) - 8, height - 7);
            context.fillText(fmt(maximum, 2), 3, top + 3); context.fillText(fmt(minimum, 2), 3, height - bottom);
            series.forEach((row, seriesIndex) => {
                context.strokeStyle = row.color; context.fillStyle = row.color; context.lineWidth = 2;
                context.beginPath();
                row.values.forEach((value, offset) => {
                    if (!Number.isFinite(value)) return;
                    if (offset === 0) context.moveTo(x(offset), y(value)); else context.lineTo(x(offset), y(value));
                });
                context.stroke();
                row.values.forEach((value, offset) => {
                    if (!Number.isFinite(value)) return;
                    context.beginPath(); context.arc(x(offset), y(value), 3, 0, Math.PI * 2); context.fill();
                });
                context.fillText(row.label, left + seriesIndex * 76, 11);
            });
        }

        function drawLatencyLines(canvas, xValues, series, options = {}) {
            const { context, width, height } = canvasContext(canvas);
            const finiteX = xValues.map(Number).filter(Number.isFinite);
            const finiteY = series.flatMap(row => [
                ...(row.values || []), ...(row.low || []), ...(row.high || []),
            ]).map(Number).filter(Number.isFinite);
            if (!finiteX.length || !finiteY.length) return;
            const left = 44, right = 12, top = 27, bottom = 27;
            const minX = Math.min(...finiteX), maxX = Math.max(...finiteX);
            let minY = Math.min(0, ...finiteY), maxY = Math.max(0, ...finiteY);
            if (Math.abs(maxY - minY) < 1e-9) { minY -= 1; maxY += 1; }
            const x = value => left + (Number(value) - minX) / ((maxX - minX) || 1) * (width - left - right);
            const y = value => height - bottom - (Number(value) - minY) / ((maxY - minY) || 1) * (height - top - bottom);
            if (options.negativeControl && minX < 0) {
                context.fillStyle = C.amber + '12';
                context.fillRect(left, top, Math.max(0, x(0) - left), height - top - bottom);
                context.fillStyle = C.amber; context.font = '8px sans-serif';
                context.fillText('negative-lag controls', left + 5, top + 10);
            }
            context.strokeStyle = C.border2; context.lineWidth = 1;
            context.beginPath(); context.moveTo(left, y(0)); context.lineTo(width - right, y(0)); context.stroke();
            if (minX <= 0 && maxX >= 0) {
                context.strokeStyle = C.dim; context.setLineDash([3, 3]);
                context.beginPath(); context.moveTo(x(0), top); context.lineTo(x(0), height - bottom); context.stroke();
                context.setLineDash([]);
            }
            context.fillStyle = C.mute; context.font = '8px sans-serif';
            context.fillText(options.yFormat ? options.yFormat(maxY) : fmt(maxY, 3), 2, top + 3);
            context.fillText(options.yFormat ? options.yFormat(minY) : fmt(minY, 3), 2, height - bottom);
            xValues.forEach((value, index) => {
                if (index % Math.max(1, Math.round(xValues.length / 6)) === 0 || index === xValues.length - 1) {
                    context.fillText(options.xFormat ? options.xFormat(value) : String(value), x(value) - 8, height - 8);
                }
            });
            series.forEach((row, seriesIndex) => {
                if (row.low && row.high) {
                    const upper = [], lower = [];
                    xValues.forEach((value, index) => {
                        if (Number.isFinite(numeric(row.low[index])) && Number.isFinite(numeric(row.high[index]))) {
                            upper.push([x(value), y(row.high[index])]);
                            lower.push([x(value), y(row.low[index])]);
                        }
                    });
                    if (upper.length) {
                        context.fillStyle = row.color + '20';
                        context.beginPath();
                        upper.forEach((point, index) => index ? context.lineTo(...point) : context.moveTo(...point));
                        lower.reverse().forEach(point => context.lineTo(...point));
                        context.closePath(); context.fill();
                    }
                }
                context.strokeStyle = row.color; context.fillStyle = row.color; context.lineWidth = row.width || 2;
                context.beginPath();
                let drawing = false;
                xValues.forEach((value, index) => {
                    const datum = numeric((row.values || [])[index]);
                    if (!Number.isFinite(datum)) { drawing = false; return; }
                    if (drawing) context.lineTo(x(value), y(datum)); else context.moveTo(x(value), y(datum));
                    drawing = true;
                });
                context.stroke();
                (row.values || []).forEach((datum, index) => {
                    datum = numeric(datum); if (!Number.isFinite(datum)) return;
                    context.beginPath(); context.arc(x(xValues[index]), y(datum), 2.2, 0, Math.PI * 2); context.fill();
                });
                context.fillText(row.label, left + seriesIndex * 112, 12);
            });
            if (Number.isInteger(options.selectedIndex) && options.selectedIndex >= 0 && options.selectedIndex < xValues.length) {
                context.strokeStyle = C.text; context.lineWidth = 1.5;
                context.beginPath(); context.moveTo(x(xValues[options.selectedIndex]), top); context.lineTo(x(xValues[options.selectedIndex]), height - bottom); context.stroke();
            }
            return { left, right, top, bottom, x, y };
        }

        function drawLatencyEffect(canvas) {
            const summary = state.data.latencyStudy; if (!summary) return;
            const { window: windowRow, lags } = activeLatencyRows(summary);
            const rows = windowRow.rows || [];
            const selected = Number.isInteger(state.latencySelectedLagIndex)
                ? state.latencySelectedLagIndex : Math.max(0, lags.indexOf(Number((windowRow.peak || {}).lag)));
            const geometry = drawLatencyLines(canvas, lags, [{
                label: 'effect / semantic SD', color: C.cyan,
                values: rows.map(row => row.effect),
                low: rows.map(row => row.effectCiLow), high: rows.map(row => row.effectCiHigh),
            }], { negativeControl: true, selectedIndex: selected, xFormat: latencyLagLabel, yFormat: value => signed(value, 4) });
            if (!geometry) return;
            canvas.onclick = event => {
                const rect = canvas.getBoundingClientRect();
                const localX = event.clientX - rect.left;
                let best = 0, distance = Infinity;
                lags.forEach((lag, index) => { const delta = Math.abs(geometry.x(lag) - localX); if (delta < distance) { distance = delta; best = index; } });
                const scrollX = globalThis.window.scrollX, scrollY = globalThis.window.scrollY;
                state.latencySelectedLagIndex = best; paint(); globalThis.window.scrollTo(scrollX, scrollY);
            };
        }

        function drawLatencyBaseline(canvas) {
            const summary = state.data.latencyStudy; if (!summary) return;
            const { window: windowRow, lags } = activeLatencyRows(summary);
            const rows = windowRow.rows || [];
            const raw = windowRow.id === 'phrase';
            const scale = raw ? 100 : 1;
            drawLatencyLines(canvas, lags, [
                { label: 'observed', color: C.cyan, values: rows.map(row => numeric(raw ? row.observedRawMean : row.observedNormalizedMean) * scale) },
                { label: 'text-free expected', color: C.purple, values: rows.map(row => numeric(raw ? row.expectedRawMean : row.expectedNormalizedMean) * scale) },
                { label: 'excess', color: C.green, values: rows.map(row => numeric(raw ? row.unexpectedRawMean : row.unexpectedNormalizedMean) * scale) },
            ], { negativeControl: true, selectedIndex: state.latencySelectedLagIndex, xFormat: latencyLagLabel, yFormat: value => signed(value, raw ? 1 : 3) });
        }

        function drawLatencyTransfer(canvas) {
            const summary = state.data.latencyStudy; if (!summary) return;
            const { cluster, lags } = activeLatencyRows(summary);
            const values = (cluster.axisTransfer || {}).values || [];
            if (!values.length) return;
            const { context, width, height } = canvasContext(canvas);
            const left = 43, right = 12, top = 28, bottom = 35;
            const cellWidth = (width - left - right) / lags.length;
            const cellHeight = (height - top - bottom) / lags.length;
            const finite = values.flat().map(Number).filter(Number.isFinite);
            const limit = Math.max(.01, ...finite.map(Math.abs));
            values.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
                value = numeric(value);
                const t = Number.isFinite(value) ? Math.max(-1, Math.min(1, value / limit)) : 0;
                context.fillStyle = t >= 0
                    ? `rgb(${Math.round(235 + 13 * t)},${Math.round(235 - 122 * t)},${Math.round(235 - 122 * t)})`
                    : `rgb(${Math.round(235 + 179 * t)},${Math.round(235 + 46 * t)},${Math.round(235 - 13 * t)})`;
                context.fillRect(left + columnIndex * cellWidth, top + rowIndex * cellHeight, Math.ceil(cellWidth), Math.ceil(cellHeight));
            }));
            const train = Math.max(0, Math.min(lags.length - 1, Number(state.latencyTrainLagIndex || 0)));
            const response = Math.max(0, Math.min(lags.length - 1, Number(state.latencyResponseLagIndex || 0)));
            context.strokeStyle = C.text; context.lineWidth = 2;
            context.strokeRect(left + response * cellWidth, top + train * cellHeight, cellWidth, cellHeight);
            const zeroIndex = lags.indexOf(0);
            if (zeroIndex >= 0) {
                context.strokeStyle = C.amber; context.lineWidth = 1;
                context.strokeRect(left, top + zeroIndex * cellHeight, width - left - right, cellHeight);
                context.strokeRect(left + zeroIndex * cellWidth, top, cellWidth, height - top - bottom);
            }
            context.fillStyle = C.mute; context.font = '8px sans-serif';
            lags.forEach((lag, index) => {
                if (index % 4 === 0 || index === lags.length - 1) {
                    context.fillText(latencyLagLabel(lag), left + index * cellWidth - 4, height - 10);
                    context.fillText(latencyLagLabel(lag), 3, top + index * cellHeight + 6);
                }
            });
            context.fillStyle = C.text; context.fillText('response measured at lag →', left, height - 1);
            context.save(); context.translate(9, height - bottom); context.rotate(-Math.PI / 2); context.fillText('ruler trained at lag →', 0, 0); context.restore();
            canvas.onclick = event => {
                const rect = canvas.getBoundingClientRect();
                const x = event.clientX - rect.left, y = event.clientY - rect.top;
                const column = Math.floor((x - left) / cellWidth), row = Math.floor((y - top) / cellHeight);
                if (column < 0 || column >= lags.length || row < 0 || row >= lags.length) return;
                const scrollX = window.scrollX, scrollY = window.scrollY;
                state.latencyTrainLagIndex = row; state.latencyResponseLagIndex = column;
                paint(); window.scrollTo(scrollX, scrollY);
            };
        }

        function drawLatencyNatural(canvas) {
            const summary = state.data.latencyStudy; if (!summary) return;
            const rows = summary.sourceEqualNaturalDrop || [];
            drawLatencyLines(canvas, rows.map(row => row.second), [{
                label: 'median natural drop', color: C.green,
                values: rows.map(row => numeric(row.rawMedian) * 100),
                low: rows.map(row => numeric(row.rawQ25) * 100),
                high: rows.map(row => numeric(row.rawQ75) * 100),
            }], { xFormat: value => `${Number(value).toFixed(0)}s`, yFormat: value => `${signed(value, 1)} pp/s` });
        }

        function drawReplayCorrection(canvas) {
            const audit = (state.data.hookOutcomes || {}).rewatchAudit || {};
            const normalization = audit.normalization || {};
            const progress = (normalization.progressFractions || []).map(numeric);
            if (!progress.length) return;
            drawLatencyLines(canvas, progress, [{
                label: 'median additive replay envelope', color: C.cyan,
                values: (audit.correctionMedianPercentagePoints || []).map(numeric),
                low: (audit.correctionP10PercentagePoints || []).map(numeric),
                high: (audit.correctionP90PercentagePoints || []).map(numeric),
            }], { xFormat: value => `${fmt(value * 100, 0)}%`, yFormat: value => `${fmt(value, 0)} pp` });
        }

        function drawLatencyPoint(canvas) {
            const detail = state.latencyDetail; if (!detail || state.latencyPointGlobalIndex == null) return;
            const localIndex = (detail.globalIndices || []).indexOf(Number(state.latencyPointGlobalIndex));
            if (localIndex < 0) return;
            const lags = detail.lagsSeconds || [], phrase = detail.phrase || {};
            const row = name => ((phrase[name] || [])[localIndex] || []).map(value => numeric(value) * 100);
            drawLatencyLines(canvas, lags, [
                { label: 'observed', color: C.cyan, values: row('observedRaw') },
                { label: 'text-free expected', color: C.purple, values: row('expectedRawOOF') },
                { label: 'excess', color: C.green, values: row('unexpectedRaw') },
            ], { negativeControl: true, selectedIndex: state.latencySelectedLagIndex, xFormat: latencyLagLabel, yFormat: value => `${signed(value, 1)} pp/s` });
        }

        function activeRetentionForecast(canvas) {
            if (canvas.dataset.plVideoId) {
                const row = ((state.data.hookOutcomes || {}).hooks || []).find(value =>
                    String(value.videoId) === String(canvas.dataset.plVideoId));
                return row && row.retentionForecast;
            }
            const focus = activeHookOutcomeFocus();
            if (!focus) return null;
            return focus.type === 'live'
                ? ((((focus.result || {}).outcomes || {}).retentionForecast) || null)
                : ((focus.row || {}).retentionForecast || null);
        }

        function drawSemanticTraceMap(canvas, atlas, selectedPoint, selectedIndex) {
            if (!atlas || !(atlas.points || []).length) return;
            const points = (atlas.points || []).map(point => [numeric(point[0]), numeric(point[1])]);
            const colors = (atlas.categories || []).map(clusterColor);
            const selected = new Set();
            if (selectedIndex != null && Number.isInteger(Number(selectedIndex)) && Number(selectedIndex) >= 0
                && Number(selectedIndex) < points.length) {
                selected.add(Number(selectedIndex));
            } else if (selectedPoint && selectedPoint.every(Number.isFinite)) {
                selected.add(points.length);
                points.push(selectedPoint);
                colors.push(clusterColor(canvas.dataset.plSelectedCategory));
            }
            canvas.dataset.plSourcePoints = String((atlas.points || []).length);
            return scatter(canvas, points, colors, selected, null, true);
        }

        function drawWordEmbeddingMap(canvas) {
            const forecast = activeRetentionForecast(canvas);
            const words = (forecast || {}).words || [];
            if (!words.length) return;
            const index = Math.max(0, Math.min(words.length - 1, Number(state.forecastWordIndex || 0)));
            const word = words[index] || {};
            canvas.dataset.plSelectedCategory = String(word.singletonCategory);
            return drawSemanticTraceMap(
                canvas, (state.data.hookOutcomes || {}).wordEmbeddingAtlas,
                [numeric(word.singletonEmbeddingX), numeric(word.singletonEmbeddingY)],
                word.singletonAtlasIndex,
            );
        }

        function drawForecastInputMap(canvas) {
            const forecast = activeRetentionForecast(canvas);
            const input = (forecast || {}).forecastInput || {};
            canvas.dataset.plSelectedCategory = String(input.category);
            return drawSemanticTraceMap(
                canvas, (state.data.hookOutcomes || {}).fullHookEmbeddingAtlas,
                [numeric(input.mapX), numeric(input.mapY)], input.atlasIndex,
            );
        }

        function deconfoundingAudit() {
            return ((((state.data.hookQuality || {}).forwardResponse || {}).deconfoundingAudit) || {});
        }

        function drawDeconfoundingCurves(canvas) {
            const audit = deconfoundingAudit(), bands = audit.normalizationCurveBands || {};
            const ids = ['observed_absolute', 'entry_indexed', 'terminal_replay', 'endpoint_affine'];
            const colors = { observed_absolute: C.green, entry_indexed: C.cyan, terminal_replay: C.amber, endpoint_affine: C.purple };
            const labels = { observed_absolute: 'observed', entry_indexed: 'entry-indexed', terminal_replay: 'terminal replay', endpoint_affine: 'endpoint-affine' };
            const rows = ids.map(id => ({ id, ...(bands[id] || {}) })).filter(row => (row.progressFractions || []).length);
            if (!rows.length) return;
            const { context, width, height } = canvasContext(canvas);
            const pad = { left: 40, right: 10, top: 28, bottom: 31 };
            const values = rows.flatMap(row => [...(row.p10Percent || []), ...(row.p90Percent || [])]).map(numeric).filter(Number.isFinite);
            let [low, high] = bounds(values); const extra = Math.max(2, (high - low) * .06); low -= extra; high += extra;
            const x = value => pad.left + value * (width - pad.left - pad.right);
            const y = value => height - pad.bottom - (value - low) / ((high - low) || 1) * (height - pad.top - pad.bottom);
            context.strokeStyle = C.border2; context.lineWidth = 1; context.font = '7px sans-serif';
            for (let index = 0; index <= 4; index++) { const value = low + index / 4 * (high - low); context.beginPath(); context.moveTo(pad.left, y(value)); context.lineTo(width - pad.right, y(value)); context.stroke(); context.fillStyle = C.mute; context.fillText(`${fmt(value, 0)}%`, 2, y(value) + 3); }
            rows.forEach((row, rowIndex) => {
                const progress = row.progressFractions || [], lower = row.p10Percent || [], upper = row.p90Percent || [], median = row.medianPercent || [];
                context.globalAlpha = .09; context.fillStyle = colors[row.id]; context.beginPath();
                progress.forEach((value, index) => index ? context.lineTo(x(value), y(upper[index])) : context.moveTo(x(value), y(upper[index])));
                [...progress].reverse().forEach((value, reverseIndex) => { const index = progress.length - 1 - reverseIndex; context.lineTo(x(value), y(lower[index])); });
                context.closePath(); context.fill(); context.globalAlpha = 1;
                context.strokeStyle = colors[row.id]; context.lineWidth = row.id === 'entry_indexed' ? 2.6 : 1.5; context.beginPath();
                progress.forEach((value, index) => index ? context.lineTo(x(value), y(median[index])) : context.moveTo(x(value), y(median[index]))); context.stroke();
                context.fillStyle = colors[row.id]; context.font = '7px sans-serif'; context.fillText(labels[row.id], pad.left + rowIndex * 72, 11);
            });
            [0, .25, .5, .75, 1].forEach(value => { context.fillStyle = C.mute; context.textAlign = value === 0 ? 'left' : value === 1 ? 'right' : 'center'; context.fillText(`${fmt(value * 100, 0)}% hook`, x(value), height - 8); }); context.textAlign = 'left';
            canvas.dataset.plSpecifications = String(rows.length);
        }

        function deconfoundingColor(value) {
            value = Math.max(-.5, Math.min(.5, numeric(value) || 0));
            const strength = Math.abs(value) / .5;
            return value >= 0
                ? `rgb(${Math.round(150 + 98 * strength)},${Math.round(150 - 37 * strength)},${Math.round(170 - 57 * strength)})`
                : `rgb(${Math.round(150 - 94 * strength)},${Math.round(150 + 39 * strength)},${Math.round(170 + 78 * strength)})`;
        }

        function drawDeconfoundingHeatmap(canvas) {
            const audit = deconfoundingAudit(), rows = audit.specificationRows || [];
            if (!rows.length) return;
            const lags = [...new Set(rows.map(row => numeric(row.lagSeconds)))].sort((a, b) => a - b);
            const specs = [...new Map(rows.map(row => [`${row.normalizationId}|${row.baselineId}|${numeric(row.baselineRidgeAlpha)}`, [row.normalizationId, row.baselineId, numeric(row.baselineRidgeAlpha)]])).values()];
            const lookup = new Map(rows.map(row => [`${row.normalizationId}|${row.baselineId}|${numeric(row.baselineRidgeAlpha)}|${numeric(row.lagSeconds)}`, row]));
            const primary = audit.primarySpecification || {};
            const { context, width, height } = canvasContext(canvas); const left = 118, top = 23, right = 8, bottom = 26;
            const cellW = (width - left - right) / lags.length, cellH = (height - top - bottom) / specs.length;
            const normShort = { observed_absolute: 'observed', entry_indexed: 'entry', terminal_replay: 'replay', endpoint_affine: 'endpoint' };
            const baseShort = { timing_only: 'time', entry_level: 'entry', past_trajectory: 'past', endpoint_conditioned: 'endpoint' };
            specs.forEach(([normalization, baseline, alpha], rowIndex) => {
                context.fillStyle = C.mute; context.font = '6.5px sans-serif'; context.textAlign = 'right'; context.fillText(`${normShort[normalization]} · ${baseShort[baseline]} · α${fmt(alpha, 0)}`, left - 4, top + (rowIndex + .68) * cellH);
                lags.forEach((lag, column) => {
                    const row = lookup.get(`${normalization}|${baseline}|${alpha}|${lag}`) || {};
                    const value = numeric(row.heldoutCategoryBalancedSpearman);
                    const cellX = left + column * cellW, cellY = top + rowIndex * cellH;
                    context.fillStyle = Number.isFinite(value) ? deconfoundingColor(value) : C.card2; context.fillRect(cellX, cellY, Math.max(1, cellW - .4), Math.max(1, cellH - .4));
                    if (!Number.isFinite(value)) { context.strokeStyle = C.faint; context.lineWidth = .6; context.beginPath(); context.moveTo(cellX + 1, cellY + cellH - 1); context.lineTo(cellX + cellW - 1, cellY + 1); context.stroke(); }
                    if (normalization === primary.normalizationId && baseline === primary.baselineId && alpha === numeric(primary.baselineRidgeAlpha) && lag === numeric(primary.lagSeconds)) { context.strokeStyle = '#05070d'; context.lineWidth = 2; context.strokeRect(left + column * cellW + 1, top + rowIndex * cellH + 1, Math.max(1, cellW - 2), Math.max(1, cellH - 2)); }
                });
            });
            lags.forEach((lag, index) => { if (index % 2 && index !== lags.length - 1) return; context.fillStyle = lag < 0 ? C.amber : C.mute; context.font = '6.5px sans-serif'; context.textAlign = 'center'; context.fillText(`${lag > 0 ? '+' : ''}${fmt(lag, 1)}s`, left + (index + .5) * cellW, height - 8); }); context.textAlign = 'left';
            context.fillStyle = C.cyan; context.font = '7px sans-serif'; context.fillText('held-out rho by specification', left, 10);
            canvas.dataset.plCells = String(rows.length);
            canvas.dataset.plUnsupportedCells = String(rows.filter(row => !Number.isFinite(numeric(row.heldoutCategoryBalancedSpearman))).length);
        }

        function drawDeconfoundingBaselines(canvas) {
            const audit = deconfoundingAudit(), primary = audit.primarySpecification || {};
            const rows = (audit.specificationRows || []).filter(row =>
                row.normalizationId === 'entry_indexed'
                && numeric(row.lagSeconds) === numeric(primary.lagSeconds));
            if (!rows.length) return;
            rows.sort((left, right) => String(left.baselineId).localeCompare(String(right.baselineId)) || numeric(left.baselineRidgeAlpha) - numeric(right.baselineRidgeAlpha));
            const values = rows.map(row => numeric((row.naturalBaselineAudit || {}).sourceMeanSpearman));
            const { context, width, height } = canvasContext(canvas); const left = 42, right = 8, top = 20, bottom = 58;
            const low = Math.min(-.05, ...values.filter(Number.isFinite)), high = Math.max(.05, ...values.filter(Number.isFinite));
            const xStep = (width - left - right) / rows.length, barWidth = Math.max(3, xStep * .66);
            const y = value => height - bottom - (value - low) / ((high - low) || 1) * (height - top - bottom);
            context.strokeStyle = C.border2; context.beginPath(); context.moveTo(left, y(0)); context.lineTo(width - right, y(0)); context.stroke();
            const colors = { timing_only: C.dim, entry_level: C.amber, past_trajectory: C.cyan, endpoint_conditioned: C.red };
            const names = { timing_only: 'time', entry_level: 'entry', past_trajectory: 'past', endpoint_conditioned: 'endpoint' };
            rows.forEach((row, index) => {
                const value = values[index], center = left + (index + .5) * xStep, zero = y(0), topY = y(value);
                context.fillStyle = colors[row.baselineId] || C.purple;
                context.fillRect(center - barWidth / 2, Math.min(zero, topY), barWidth, Math.max(1, Math.abs(topY - zero)));
                context.fillStyle = C.text; context.font = '7px sans-serif'; context.textAlign = 'center';
                context.fillText(signed(value, 2), center, Math.max(top + 7, topY - 4));
                context.fillStyle = C.mute; context.fillText(`${names[row.baselineId] || row.baselineId} α${fmt(row.baselineRidgeAlpha, 0)}`, center, height - 27);
                context.fillText(`MAE ${fmt((row.naturalBaselineAudit || {}).sourceEqualMAE, 3)}`, center, height - 14);
            });
            context.textAlign = 'left'; context.fillStyle = C.mute; context.font = '7px sans-serif';
            context.fillText('source-mean OOF rho', 2, top + 3); context.fillText(signed(low, 2), 2, y(low) + 3); context.fillText(signed(high, 2), 2, y(high) + 3);
            canvas.dataset.plBaselineBars = String(rows.length);
            canvas.dataset.plFinitePoints = String(values.filter(Number.isFinite).length);
        }

        function drawDeconfoundingLag(canvas) {
            const rows = deconfoundingAudit().futureFreeConsensusByLag || [];
            if (!rows.length) return;
            const { context, width, height } = canvasContext(canvas), pad = { left: 39, right: 9, top: 22, bottom: 29 };
            const lags = rows.map(row => numeric(row.lagSeconds)), lows = rows.map(row => numeric(row.minimumRho)), highs = rows.map(row => numeric(row.maximumRho)), medians = rows.map(row => numeric(row.medianRho));
            let [low, high] = bounds([...lows, ...highs, 0]); const extra = Math.max(.02, (high - low) * .08); low -= extra; high += extra;
            const x = value => pad.left + (value - lags[0]) / ((lags[lags.length - 1] - lags[0]) || 1) * (width - pad.left - pad.right); const y = value => height - pad.bottom - (value - low) / ((high - low) || 1) * (height - pad.top - pad.bottom);
            context.fillStyle = C.amber; context.globalAlpha = .08; context.fillRect(pad.left, pad.top, x(0) - pad.left, height - pad.top - pad.bottom); context.globalAlpha = 1;
            context.strokeStyle = C.border2; context.beginPath(); context.moveTo(pad.left, y(0)); context.lineTo(width - pad.right, y(0)); context.stroke();
            const finiteBand = lags.map((lag, index) => ({ lag, low: lows[index], high: highs[index] })).filter(row => Number.isFinite(row.low) && Number.isFinite(row.high));
            if (finiteBand.length) { context.fillStyle = C.cyan; context.globalAlpha = .13; context.beginPath(); finiteBand.forEach((row, index) => index ? context.lineTo(x(row.lag), y(row.high)) : context.moveTo(x(row.lag), y(row.high))); [...finiteBand].reverse().forEach(row => context.lineTo(x(row.lag), y(row.low))); context.closePath(); context.fill(); context.globalAlpha = 1; }
            context.strokeStyle = C.cyan; context.lineWidth = 2.5; context.beginPath(); let drawing = false; lags.forEach((lag, index) => { if (!Number.isFinite(medians[index])) { drawing = false; return; } if (drawing) context.lineTo(x(lag), y(medians[index])); else context.moveTo(x(lag), y(medians[index])); drawing = true; }); context.stroke();
            [-3, -1, 0, 1, 3, 5].forEach(lag => { context.fillStyle = lag < 0 ? C.amber : C.mute; context.font = '7px sans-serif'; context.textAlign = 'center'; context.fillText(`${lag > 0 ? '+' : ''}${lag}s`, x(lag), height - 8); }); context.textAlign = 'left';
            [low, 0, high].forEach(value => { context.fillStyle = C.mute; context.font = '7px sans-serif'; context.fillText(signed(value, 2), 2, y(value) + 3); });
            canvas.dataset.plLagCells = String(rows.length);
        }

        function drawDeconfoundingReverse(canvas) {
            const rows = deconfoundingAudit().matchedForwardReverse || [];
            if (!rows.length) return;
            return drawLatencyLines(canvas, rows.map(row => numeric(row.absoluteLagSeconds)), [
                { label: 'forward rho', color: C.green, width: 2.5, values: rows.map(row => numeric(row.forwardRho)) },
                { label: '|reverse rho|', color: C.red, width: 2.2, values: rows.map(row => Math.abs(numeric(row.reverseRho))) },
                { label: 'forward − |reverse|', color: C.cyan, width: 2.2, values: rows.map(row => numeric(row.forwardMinusAbsReverse)), low: rows.map(row => numeric(row.differenceCiLow)), high: rows.map(row => numeric(row.differenceCiHigh)) },
            ], { xFormat: value => `±${fmt(value, 1)}s`, yFormat: value => signed(value, 3) });
        }

        function drawWordForecastContribution(canvas) {
            const forecast = activeRetentionForecast(canvas);
            const words = (forecast || {}).words || [];
            if (!words.length) return;
            const index = Math.max(0, Math.min(words.length - 1, Number(state.forecastWordIndex || 0)));
            const word = words[index] || {};
            const mode = retentionMode(forecast);
            const values = ((mode === 'entry'
                ? word.entryIndexedForecastDeletionContributionByTime
                : mode === 'terminal'
                    ? word.rewatchAdjustedForecastDeletionContributionByTime
                    : word.observedForecastDeletionContributionByTime) || []).map(numeric);
            const times = (forecast.timesSeconds || []).map(numeric);
            const progress = (forecast.progressFractions || []).map(numeric);
            if (!times.length || values.length !== times.length) return;
            canvas.dataset.plSourcePoints = String(values.length);
            canvas.dataset.plFinitePoints = String(values.filter(Number.isFinite).length);
            const { context, width, height } = canvasContext(canvas);
            const left = 42, right = 10, top = 20, bottom = 40;
            let [low, high] = bounds([...values, 0]);
            const padding = Math.max(.05, (high - low) * .12);
            low -= padding; high += padding;
            const x = value => left + (value - times[0]) / ((times[times.length - 1] - times[0]) || 1) * (width - left - right);
            const y = value => height - bottom - (value - low) / ((high - low) || 1) * (height - top - bottom);
            context.globalAlpha = 1; context.strokeStyle = C.border2; context.lineWidth = 1;
            [low, 0, high].forEach(value => {
                context.beginPath(); context.moveTo(left, y(value)); context.lineTo(width - right, y(value)); context.stroke();
                context.fillStyle = C.mute; context.font = '8px sans-serif'; context.fillText(`${signed(value, 2)} pp`, 2, y(value) + 3);
            });
            context.strokeStyle = clusterColor(word.singletonCategory); context.lineWidth = 2.4; context.beginPath();
            times.forEach((time, pointIndex) => pointIndex
                ? context.lineTo(x(time), y(values[pointIndex]))
                : context.moveTo(x(time), y(values[pointIndex])));
            context.stroke();
            context.fillStyle = C.mute; context.font = '8px sans-serif';
            [0, .25, .5, .75, 1].forEach(fraction => {
                const pointIndex = Math.round(fraction * (times.length - 1));
                context.textAlign = fraction === 0 ? 'left' : fraction === 1 ? 'right' : 'center';
                context.fillText(`${fmt(times[pointIndex], 2)}s`, x(times[pointIndex]), height - 19);
                context.fillText(`${fmt((progress[pointIndex] ?? fraction) * 100, 0)}% hook`, x(times[pointIndex]), height - 7);
            });
            context.textAlign = 'right'; context.fillStyle = C.cyan;
            context.fillText(`analysis stops ${fmt(times[times.length - 1], 2)}s`, width - right, 10);
            context.textAlign = 'left';
            context.fillStyle = clusterColor(word.singletonCategory);
            context.fillText(`word C${word.singletonCategory} local deletion effect`, left, 10);
            canvas.dataset.plEndpointSeconds = String(times[times.length - 1]);
            canvas.dataset.plProgressEndpoint = String(progress[progress.length - 1]);
        }

        function drawRetentionForecast(canvas, mini = false) {
            const forecast = activeRetentionForecast(canvas);
            if (!forecast) return;
            const times = (forecast.timesSeconds || []).map(numeric);
            const progress = (forecast.progressFractions || []).map(numeric);
            const mode = retentionMode(forecast);
            const predicted = (mode === 'entry'
                ? (forecast.entryIndexedPredictedPercent || forecast.entryIndexedPredictedOOFPercent || [])
                : mode === 'terminal'
                    ? (forecast.terminalConditionedPredictedPercent || forecast.terminalConditionedPredictedOOFPercent || forecast.rewatchAdjustedPredictedOOFPercent || [])
                    : (forecast.observedAbsolutePredictedPercent || forecast.predictedOOFPercent || forecast.predictedPercent || [])).map(numeric);
            const actual = (mode === 'entry'
                ? (forecast.entryIndexedActualPercent || [])
                : mode === 'terminal'
                    ? (forecast.terminalConditionedActualPercent || forecast.rewatchAdjustedActualPercent || [])
                    : (forecast.actualPercent || [])).map(numeric);
            const low = (mode === 'entry'
                ? (forecast.entryIndexedPredictionP10 || [])
                : mode === 'terminal'
                    ? (forecast.terminalConditionedPredictionP10 || forecast.rewatchAdjustedPredictionP10 || [])
                    : (forecast.observedAbsolutePredictionP10 || forecast.predictionP10 || [])).map(numeric);
            const high = (mode === 'entry'
                ? (forecast.entryIndexedPredictionP90 || [])
                : mode === 'terminal'
                    ? (forecast.terminalConditionedPredictionP90 || forecast.rewatchAdjustedPredictionP90 || [])
                    : (forecast.observedAbsolutePredictionP90 || forecast.predictionP90 || [])).map(numeric);
            if (!times.length || !predicted.length) return;
            const { context, width, height } = canvasContext(canvas);
            const left = mini ? 3 : 42, right = mini ? 3 : 12, top = mini ? 4 : 24, bottom = mini ? 4 : 42;
            const values = [...predicted, ...actual, ...low, ...high].filter(Number.isFinite);
            let [minY, maxY] = bounds(values);
            const padding = Math.max(2, (maxY - minY) * .08);
            minY -= padding; maxY += padding;
            const minX = Math.min(...times), maxX = Math.max(...times);
            const x = value => left + (numeric(value) - minX) / ((maxX - minX) || 1) * (width - left - right);
            const y = value => height - bottom - (numeric(value) - minY) / ((maxY - minY) || 1) * (height - top - bottom);
            if (!mini) {
                (forecast.componentWindows || []).forEach(windowRow => {
                    const start = Math.max(minX, numeric(windowRow.responseWindowStartSeconds));
                    const end = Math.min(maxX, numeric(windowRow.responseWindowEndSeconds));
                    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
                    context.globalAlpha = .08; context.fillStyle = clusterColor(windowRow.category);
                    context.fillRect(x(start), top, Math.max(1, x(end) - x(start)), height - top - bottom);
                    context.globalAlpha = 1; context.fillStyle = clusterColor(windowRow.category); context.font = '7px sans-serif';
                    context.fillText(`C${windowRow.category}`, x(start) + 2, top + 8);
                });
                context.globalAlpha = 1; context.strokeStyle = C.border2; context.lineWidth = 1;
                for (let index = 0; index <= 4; index++) {
                    const value = minY + index / 4 * (maxY - minY);
                    context.beginPath(); context.moveTo(left, y(value)); context.lineTo(width - right, y(value)); context.stroke();
                    context.fillStyle = C.mute; context.font = '8px sans-serif'; context.fillText(`${fmt(value, 0)}%`, 2, y(value) + 3);
                }
                [0, .25, .5, .75, 1].forEach(fraction => {
                    const pointIndex = Math.round(fraction * (times.length - 1));
                    context.textAlign = fraction === 0 ? 'left' : fraction === 1 ? 'right' : 'center';
                    context.fillText(`${fmt(times[pointIndex], 2)}s`, x(times[pointIndex]), height - 20);
                    context.fillText(`${fmt((progress[pointIndex] ?? fraction) * 100, 0)}% hook`, x(times[pointIndex]), height - 7);
                });
                context.textAlign = 'left';
                context.strokeStyle = C.cyan; context.lineWidth = 1; context.setLineDash([4, 3]);
                context.beginPath(); context.moveTo(x(maxX) - 1, top); context.lineTo(x(maxX) - 1, height - bottom); context.stroke(); context.setLineDash([]);
            }
            const band = times.map((time, index) => [x(time), y(high[index]), y(low[index])])
                .filter(point => point.every(Number.isFinite));
            if (!mini && band.length) {
                context.fillStyle = C.cyan + '1f'; context.beginPath();
                band.forEach((point, index) => index ? context.lineTo(point[0], point[1]) : context.moveTo(point[0], point[1]));
                [...band].reverse().forEach(point => context.lineTo(point[0], point[2]));
                context.closePath(); context.fill();
            }
            const line = (valuesRow, color, lineWidth) => {
                context.strokeStyle = color; context.lineWidth = lineWidth; context.beginPath(); let drawing = false;
                times.forEach((time, index) => {
                    const value = valuesRow[index];
                    if (!Number.isFinite(value)) { drawing = false; return; }
                    if (drawing) context.lineTo(x(time), y(value)); else context.moveTo(x(time), y(value));
                    drawing = true;
                });
                context.stroke();
            };
            line(predicted, C.cyan, mini ? 1.5 : 2.4);
            if (actual.length) line(actual, C.green, mini ? 1.2 : 2);
            if (!mini) {
                (forecast.words || []).forEach(word => {
                    const value = numeric(mode === 'entry' ? word.entryIndexedPredictedRetentionPercent : mode === 'terminal' ? word.terminalConditionedPredictedRetentionPercent : word.observedAbsolutePredictedRetentionPercent), time = numeric(word.responseSeconds);
                    if (!Number.isFinite(value) || !Number.isFinite(time) || time < minX || time > maxX) return;
                    context.fillStyle = clusterColor(word.componentCategory); context.beginPath(); context.arc(x(time), y(value), 2.5, 0, Math.PI * 2); context.fill();
                });
                context.fillStyle = C.cyan; context.font = '8px sans-serif'; context.fillText(mode === 'entry' ? 'predicted entry-indexed' : mode === 'terminal' ? 'predicted terminal sensitivity' : 'predicted observed', left, 10);
                if (actual.length) { context.fillStyle = C.green; context.fillText('actual', left + 62, 10); }
                context.fillStyle = C.cyan; context.textAlign = 'right'; context.fillText(`analysis stops ${fmt(maxX, 2)}s`, width - right, 10); context.textAlign = 'left';
            }
            canvas.dataset.plForecastPositions = String(times.length);
            canvas.dataset.plForecastWords = String((forecast.words || []).length);
            canvas.dataset.plForecastComponents = String((forecast.componentWindows || []).length);
            canvas.dataset.plEndpointSeconds = String(maxX);
            canvas.dataset.plProgressEndpoint = String(progress[progress.length - 1]);
        }

        function continuousColors(values) {
            const range = bounds(values.map(numeric));
            return values.map(value => {
                value = numeric(value);
                if (!Number.isFinite(value)) return C.faint;
                const t = Math.max(0, Math.min(1, (value - range[0]) / ((range[1] - range[0]) || 1)));
                return `rgb(${Math.round(56 + 192 * t)},${Math.round(189 - 76 * t)},${Math.round(248 - 135 * t)})`;
            });
        }

        function drawHookOutcomeAxis(canvas) {
            const target = canvas.dataset.plOutcomeTarget;
            const rows = target === 'market'
                ? ((state.data.marketReward || {}).hooks || [])
                : ((state.data.hookOutcomes || {}).hooks || []);
            if (!rows.length) return;
            const points = rows.map(row => target === 'market'
                ? [numeric((row.score || {}).mapX), numeric((row.score || {}).mapY)]
                : target === 'survival'
                ? [numeric((row.survivalScore || {}).mapX), numeric((row.survivalScore || {}).mapY)]
                : target === 'quality'
                    ? [numeric((row.overallScore || {}).mapX), numeric((row.overallScore || {}).mapY)]
                    : [numeric(((row.outcomes || {})[target] || {}).mapX), numeric(((row.outcomes || {})[target] || {}).mapY)]);
            const observed = rows.map(row => target === 'market'
                ? numeric(((row.outcomes || {}).retention_5s || {}).actual)
                : target === 'survival'
                ? numeric((row.survivalScore || {}).actual)
                : target === 'quality'
                    ? numeric((row.overallScore || {}).observedResidual)
                    : numeric(((row.outcomes || {})[target] || {}).actual));
            const colors = continuousColors(observed), selected = new Set();
            canvas.dataset.plSourcePoints = String(rows.length);
            canvas.dataset.plFinitePoints = String(points.filter(point => point.every(Number.isFinite)).length);
            const focus = activeHookOutcomeFocus();
            if (focus && focus.type === 'stored') {
                const index = rows.findIndex(row => String(row.videoId) === String(focus.row.videoId));
                if (index >= 0) selected.add(index);
            } else if (focus && focus.type === 'live') {
                const value = hookOutcomePayload(focus, target) || {};
                const point = [numeric(value.mapX), numeric(value.mapY)];
                if (point.every(Number.isFinite)) { selected.add(points.length); points.push(point); colors.push(C.cyan); }
            }
            canvas._plOutcomeVideoIds = rows.map(row => row.videoId);
            return scatter(canvas, points, colors, selected);
        }

        function drawComponentScoreAxis(canvas) {
            const category = Number(canvas.dataset.plComponentCategory), axis = canvas.dataset.plComponentAxis;
            const sourceRows = ((state.data.hookOutcomes || {}).hooks || []), rows = [];
            sourceRows.forEach(source => (source.components || []).forEach(component => {
                if (Number(component.category) === category) rows.push({ source, component });
            }));
            if (!rows.length) return;
            const marketComponent = row => ((((marketRewardRow(row.source.videoId) || {}).components) || [])[Number(row.component.component)] || {});
            const pointFor = component => {
                if (axis === 'market') {
                    const source = rows.find(row => row.component === component);
                    const market = source ? marketComponent(source) : {};
                    const broad = component.broadRetainedInformation || {};
                    return [numeric(market.effectZ), numeric(broad.singletonAxisCoordinate)];
                }
                if (axis === 'hold') { const hold = component.hookHoldContribution || {}, broad = component.broadRetainedInformation || {}; return [numeric(hold.effectHoldZ), numeric(broad.singletonAxisCoordinate)]; }
                if (axis === 'broad') { const broad = component.broadRetainedInformation || {}; return [numeric(broad.deletionEffect), numeric(broad.singletonAxisCoordinate)]; }
                if (axis === 'forward') { const row = component.forwardResponse || {}; return [numeric(row.axisCoordinate), numeric(row.mapY)]; }
                const row = (component.outcomes || {})[axis] || {}; return [numeric(row.mapX), numeric(row.mapY)];
            };
            const observedFor = row => axis === 'market'
                ? numeric((((marketRewardRow(row.source.videoId) || {}).outcomes || {}).retention_5s || {}).actual)
                : axis === 'hold'
                ? numeric((row.source.survivalScore || {}).actual)
                : axis === 'broad'
                ? numeric((row.source.overallScore || {}).observedResidual)
                : axis === 'forward'
                    ? numeric((row.component.forwardResponse || {}).unexpectedObservedSlope)
                    : numeric(((row.component.outcomes || {})[axis] || {}).actual);
            const points = rows.map(row => pointFor(row.component));
            canvas.dataset.plSourcePoints = String(rows.length);
            canvas.dataset.plFinitePoints = String(points.filter(point => point.every(Number.isFinite)).length);
            const colors = continuousColors(rows.map(observedFor)), selected = new Set();
            const focus = activeHookOutcomeFocus(), componentIndex = Number(canvas.dataset.plComponentIndex);
            if (focus && focus.type === 'stored') {
                const index = rows.findIndex(row => String(row.source.videoId) === String(focus.row.videoId)
                    && Number(row.component.component) === componentIndex);
                if (index >= 0) selected.add(index);
            } else if (focus && focus.type === 'live') {
                const component = ((focus.result || {}).components || [])[componentIndex] || {};
                let point;
                if (axis === 'market') point = [numeric((component.marketHoldContribution || {}).effectZ), numeric(component.singletonAxisCoordinate)];
                else if (axis === 'hold') point = [numeric((component.hookHoldContribution || {}).effectHoldZ), numeric(component.singletonAxisCoordinate)];
                else if (axis === 'broad') point = [numeric(component.retainedInformationDeletionEffect), numeric(component.singletonAxisCoordinate)];
                else if (axis === 'forward') point = [numeric((component.forwardResponse || {}).axisCoordinate), numeric((component.forwardResponse || {}).mapY)];
                else { const value = (component.outcomePredictions || {})[axis] || {}; point = [numeric(value.mapX), numeric(value.mapY)]; }
                if (point && point.every(Number.isFinite)) { selected.add(points.length); points.push(point); colors.push(C.cyan); }
            }
            canvas._plComponentRefs = rows.map(row => ({ videoId: row.source.videoId, component: row.component.component }));
            return scatter(canvas, points, colors, selected);
        }

        function drawPredictionCalibration(canvas) {
            const target = canvas.dataset.plCalibrationTarget;
            const validation = hookOutcomeValidation(target);
            const predicted = (validation.predictionOOF || []).map(numeric);
            const observed = (validation.targetObserved || []).map(numeric);
            if (!predicted.length || predicted.length !== observed.length) return;
            const { context, width, height } = canvasContext(canvas);
            const pad = { left: 34, right: 10, top: 10, bottom: 24 };
            const range = bounds([...predicted, ...observed]);
            const margin = Math.max((range[1] - range[0]) * .07, 1e-6);
            const lo = range[0] - margin, hi = range[1] + margin;
            const x = value => pad.left + (value - lo) / (hi - lo) * (width - pad.left - pad.right);
            const y = value => height - pad.bottom - (value - lo) / (hi - lo) * (height - pad.top - pad.bottom);
            context.strokeStyle = C.border; context.lineWidth = 1;
            context.beginPath(); context.moveTo(x(lo), y(lo)); context.lineTo(x(hi), y(hi)); context.stroke();
            predicted.forEach((value, index) => {
                context.globalAlpha = .35; context.fillStyle = C.purple;
                context.beginPath(); context.arc(x(value), y(observed[index]), 1.8, 0, Math.PI * 2); context.fill();
            });
            context.globalAlpha = 1;
            (validation.reliabilityBins || []).forEach(bin => {
                context.fillStyle = C.amber; context.strokeStyle = C.card2; context.lineWidth = 1;
                context.beginPath(); context.rect(x(numeric(bin.predictionMean)) - 3, y(numeric(bin.observedMean)) - 3, 6, 6); context.fill(); context.stroke();
            });
            const focus = activeHookOutcomeFocus();
            if (focus && focus.type === 'stored') {
                const value = hookOutcomePayload(focus, target) || {};
                const px = numeric(value.predictedOOF), py = numeric(value.actual);
                if (Number.isFinite(px) && Number.isFinite(py)) {
                    context.strokeStyle = C.cyan; context.lineWidth = 2;
                    context.beginPath(); context.arc(x(px), y(py), 5, 0, Math.PI * 2); context.stroke();
                }
            }
            context.fillStyle = C.mute; context.font = '7px sans-serif';
            context.fillText('predicted →', Math.max(pad.left, width - 60), height - 7);
            context.save(); context.translate(9, pad.top + 48); context.rotate(-Math.PI / 2); context.fillText('observed →', 0, 0); context.restore();
            context.fillText(Number(lo).toPrecision(3), pad.left, height - 7);
            context.textAlign = 'right'; context.fillText(Number(hi).toPrecision(3), width - pad.right, height - 7); context.textAlign = 'left';
            canvas.dataset.plCalibrationRows = String(predicted.length);
            canvas.dataset.plCalibrationSlope = String(validation.calibrationSlope);
        }

        function drawCurveAccuracy(canvas) {
            const validation = ((state.data.hookOutcomes || {}).curveModel || {}).rewatchAdjustedValidation || {};
            const progress = (validation.progressFractions || []).map(numeric);
            const model = (validation.modelMAEByTimePercentagePoints || []).map(numeric);
            const baseline = (validation.baselineMAEByTimePercentagePoints || []).map(numeric);
            if (!progress.length || progress.length !== model.length || progress.length !== baseline.length) return;
            const { context, width, height } = canvasContext(canvas);
            const pad = { left: 31, right: 10, top: 12, bottom: 22 };
            const maxY = Math.max(1, ...model, ...baseline) * 1.08;
            const x = value => pad.left + value * (width - pad.left - pad.right);
            const y = value => height - pad.bottom - value / maxY * (height - pad.top - pad.bottom);
            context.strokeStyle = C.border; context.lineWidth = 1;
            context.beginPath(); context.moveTo(pad.left, y(0)); context.lineTo(width - pad.right, y(0)); context.stroke();
            const line = (values, color, lineWidth) => {
                context.strokeStyle = color; context.lineWidth = lineWidth; context.beginPath();
                values.forEach((value, index) => index ? context.lineTo(x(progress[index]), y(value)) : context.moveTo(x(progress[index]), y(value)));
                context.stroke();
            };
            line(baseline, C.mute, 1.2); line(model, C.cyan, 2.2);
            context.fillStyle = C.mute; context.font = '7px sans-serif';
            context.fillText('0% hook', pad.left, height - 7); context.textAlign = 'right'; context.fillText('100% hook', width - pad.right, height - 7); context.textAlign = 'left';
            context.fillStyle = C.cyan; context.fillText('model MAE', pad.left, 9); context.fillStyle = C.mute; context.fillText('baseline MAE', pad.left + 52, 9);
            canvas.dataset.plCurveAccuracyPoints = String(progress.length);
        }

        function drawBoundaryTrace(canvas) {
            const partition = partitionForFocus(activeHookOutcomeFocus());
            if (!partition) return;
            const trace = partition.boundaryTrace || {};
            const probabilities = (trace.gapCutProbabilitiesOOF || partition.boundaryProbabilities || []).map(numeric);
            const serving = (trace.gapCutProbabilitiesServing || []).map(numeric);
            const targets = (trace.gapAboveNullLabels || []).map(Number);
            const chunks = partition.chunks || [];
            const selectedCuts = new Set((trace.selectedCutTokenOffsets || chunks.slice(0, -1).map(row => Number(row.end))).map(Number));
            if (!probabilities.length) return;
            const { context, width, height } = canvasContext(canvas);
            const pad = { left: 34, right: 10, top: 26, bottom: 34 };
            const plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom;
            const y = value => pad.top + (1 - Math.max(0, Math.min(1, numeric(value)))) * plotHeight;
            const slot = plotWidth / probabilities.length;
            [0, .5, 1].forEach(value => {
                context.strokeStyle = value === .5 ? C.amber : C.border2;
                context.setLineDash(value === .5 ? [4, 3] : []);
                context.beginPath(); context.moveTo(pad.left, y(value)); context.lineTo(width - pad.right, y(value)); context.stroke();
                context.fillStyle = value === .5 ? C.amber : C.mute; context.font = '8px sans-serif';
                context.fillText(fmt(value, 1), 3, y(value) + 3);
            });
            context.setLineDash([]);
            probabilities.forEach((value, index) => {
                if (!Number.isFinite(value)) return;
                const selected = selectedCuts.has(index + 1), barWidth = Math.max(1, slot * .72);
                const left = pad.left + index * slot + (slot - barWidth) / 2;
                context.fillStyle = selected ? C.cyan : C.purple;
                context.globalAlpha = selected ? .9 : .48;
                context.fillRect(left, y(value), barWidth, Math.max(1, y(0) - y(value)));
                if (targets[index] === 1) {
                    context.globalAlpha = 1; context.fillStyle = C.red;
                    context.beginPath(); context.arc(left + barWidth / 2, Math.max(pad.top + 2, y(value) - 4), 2, 0, Math.PI * 2); context.fill();
                }
                if (selected) {
                    context.globalAlpha = 1; context.fillStyle = C.cyan; context.font = '7px sans-serif'; context.textAlign = 'center';
                    context.fillText(`CUT ${index + 1}`, left + barWidth / 2, height - 20);
                }
            });
            context.globalAlpha = 1;
            if (serving.length === probabilities.length) {
                context.strokeStyle = C.green; context.lineWidth = 1.4; context.beginPath(); let started = false;
                serving.forEach((value, index) => {
                    if (!Number.isFinite(value)) return;
                    const px = pad.left + (index + .5) * slot, py = y(value);
                    if (started) context.lineTo(px, py); else context.moveTo(px, py);
                    started = true;
                });
                context.stroke();
            }
            context.textAlign = 'left'; context.font = '8px sans-serif';
            context.fillStyle = C.purple; context.fillText('OOF p(cut)', pad.left, 10);
            context.fillStyle = C.green; context.fillText('serving ensemble', pad.left + 62, 10);
            context.fillStyle = C.red; context.fillText('red dot = geometric audit label', pad.left + 148, 10);
            context.fillStyle = C.mute; context.fillText('adjacent-token gap →', Math.max(pad.left, width - 112), height - 6);
            canvas.dataset.plBoundaryGaps = String(probabilities.length);
            canvas.dataset.plBoundarySelectedCuts = String(selectedCuts.size);
            canvas.dataset.plBoundaryProbabilitiesComplete = String(probabilities.every(Number.isFinite));
        }

        function drawTransferScatter(canvas, points, selectedIndex, liveX, xLabel, yLabel) {
            const visible = (points || []).map((point, index) => ({ point, index })).filter(row =>
                Array.isArray(row.point) && row.point.every(Number.isFinite));
            if (!visible.length) return;
            const { context, width, height } = canvasContext(canvas);
            const pad = { left: 38, right: 10, top: 14, bottom: 31 };
            let xb = bounds(visible.map(row => row.point[0])), yb = bounds(visible.map(row => row.point[1]));
            const xMargin = Math.max(1e-6, (xb[1] - xb[0]) * .06), yMargin = Math.max(1e-6, (yb[1] - yb[0]) * .06);
            xb = [xb[0] - xMargin, xb[1] + xMargin]; yb = [yb[0] - yMargin, yb[1] + yMargin];
            const x = value => pad.left + (value - xb[0]) / ((xb[1] - xb[0]) || 1) * (width - pad.left - pad.right);
            const y = value => height - pad.bottom - (value - yb[0]) / ((yb[1] - yb[0]) || 1) * (height - pad.top - pad.bottom);
            [0, .5, 1].forEach(fraction => {
                const xv = xb[0] + fraction * (xb[1] - xb[0]), yv = yb[0] + fraction * (yb[1] - yb[0]);
                context.strokeStyle = C.border2; context.lineWidth = 1;
                context.beginPath(); context.moveTo(x(xv), pad.top); context.lineTo(x(xv), height - pad.bottom); context.stroke();
                context.beginPath(); context.moveTo(pad.left, y(yv)); context.lineTo(width - pad.right, y(yv)); context.stroke();
                context.fillStyle = C.mute; context.font = '7px sans-serif'; context.textAlign = 'center';
                context.fillText(Number(xv).toPrecision(3), x(xv), height - 17);
                context.textAlign = 'right'; context.fillText(Number(yv).toPrecision(3), pad.left - 3, y(yv) + 2);
            });
            const colors = continuousColors(visible.map(row => row.point[1]));
            visible.forEach((row, index) => {
                context.globalAlpha = .55; context.fillStyle = colors[index];
                context.beginPath(); context.arc(x(row.point[0]), y(row.point[1]), 2, 0, Math.PI * 2); context.fill();
                if (row.index === selectedIndex) {
                    context.globalAlpha = 1; context.strokeStyle = C.cyan; context.lineWidth = 2;
                    context.beginPath(); context.arc(x(row.point[0]), y(row.point[1]), 5, 0, Math.PI * 2); context.stroke();
                }
            });
            if (Number.isFinite(liveX)) {
                context.globalAlpha = 1; context.strokeStyle = C.cyan; context.lineWidth = 1.5; context.setLineDash([4, 3]);
                context.beginPath(); context.moveTo(x(liveX), pad.top); context.lineTo(x(liveX), height - pad.bottom); context.stroke(); context.setLineDash([]);
                context.fillStyle = C.cyan; context.font = '7px sans-serif'; context.textAlign = 'center'; context.fillText('new text; Y unmeasured', x(liveX), pad.top + 8);
            }
            context.globalAlpha = 1; context.fillStyle = C.mute; context.font = '7px sans-serif'; context.textAlign = 'center';
            context.fillText(xLabel, pad.left + (width - pad.left - pad.right) / 2, height - 5);
            context.save(); context.translate(8, pad.top + (height - pad.top - pad.bottom) / 2); context.rotate(-Math.PI / 2); context.fillText(yLabel, 0, 0); context.restore();
            context.textAlign = 'left';
            canvas.dataset.plSourcePoints = String(visible.length);
            canvas.dataset.plSelectedPoint = selectedIndex == null ? '' : String(selectedIndex);
        }

        function drawMarketTransfer(canvas) {
            const target = canvas.dataset.plMarketTarget;
            const rows = (state.data.marketReward || {}).hooks || [];
            const points = rows.map(row => [
                numeric((row.score || {}).z), numeric((((row.outcomes || {})[target]) || {}).actual),
            ]);
            const focus = activeHookOutcomeFocus();
            const selected = focus && focus.type === 'stored'
                ? rows.findIndex(row => String(row.videoId) === String(focus.row.videoId)) : null;
            const liveX = focus && focus.type === 'live' ? numeric((focus.result.trainingReward || {}).z) : NaN;
            const label = (((state.data.hookOutcomes || {}).targets || {})[target] || {}).shortLabel || target;
            const yLabel = target === 'log_views' ? 'measured log10 Shorts views' : `measured ${label} (%)`;
            drawTransferScatter(canvas, points, selected >= 0 ? selected : null, liveX, 'Market Hold z', yLabel);
        }

        function drawLongTitleTransfer(canvas) {
            const target = canvas.dataset.plLongTitleTarget;
            const rows = (state.data.hookOutcomes || {}).hooks || [];
            const points = rows.map(row => [
                numeric((row.longTitleMarketPrior || {}).predictedLog10LongFormViews),
                target === 'hookHold' ? numeric((row.survivalScore || {}).actual) : numeric(((row.outcomes || {})[target] || {}).actual),
            ]);
            const focus = activeHookOutcomeFocus();
            const selected = focus && focus.type === 'stored'
                ? rows.findIndex(row => String(row.videoId) === String(focus.row.videoId)) : null;
            const label = target === 'hookHold'
                ? 'observed excess carry (pp/s)'
                : target === 'log_views'
                    ? 'measured log10 Shorts views'
                    : `measured ${((((state.data.hookOutcomes || {}).targets || {})[target] || {}).shortLabel || target)} (%)`;
            drawTransferScatter(canvas, points, selected >= 0 ? selected : null, NaN, 'predicted long-form log10 views', label);
        }

        function drawAxisHorizon(canvas) {
            const axes = state.data.axes || {}, map = (axes.maps || [])[state.axisIndex] || {};
            const lineage = axisLineageFor(map);
            const horizon = (((state.data.findings || {}).visualizationContract || {}).semanticInputHorizon) || {};
            const endpoints = (horizon.responseEndSecondsSorted || []).map(numeric).filter(Number.isFinite);
            if (!lineage || !endpoints.length) return;
            const window = lineage.outcomeWindow || {};
            const median = numeric(horizon.medianResponseEndSeconds);
            let targetStart = numeric(window.startSeconds), targetEnd = numeric(window.endSeconds);
            if (window.relativeToHookEnd) { targetStart = median; targetEnd = median + Math.max(0, targetEnd); }
            if (window.kind === 'hook-end-point') { targetStart = median; targetEnd = median; }
            if (window.kind === 'within-hook-window' && !Number.isFinite(targetEnd)) { targetStart = 0; targetEnd = median; }
            const fixedTarget = Number.isFinite(targetStart) || Number.isFinite(targetEnd);
            const maxX = Math.max(...endpoints, fixedTarget ? Math.max(targetStart || 0, targetEnd || 0) : 0) * 1.08 || 1;
            const { context, width, height } = canvasContext(canvas);
            const pad = { left: 34, right: 12, top: 28, bottom: 30 }, bins = 16;
            const counts = Array(bins).fill(0);
            endpoints.forEach(value => { counts[Math.min(bins - 1, Math.max(0, Math.floor(value / maxX * bins)))] += 1; });
            const peak = Math.max(1, ...counts), x = value => pad.left + value / maxX * (width - pad.left - pad.right);
            const y = value => height - pad.bottom - value / peak * (height - pad.top - pad.bottom);
            context.fillStyle = C.cyan; context.globalAlpha = .62;
            counts.forEach((count, index) => {
                const x0 = pad.left + index / bins * (width - pad.left - pad.right), x1 = pad.left + (index + 1) / bins * (width - pad.left - pad.right);
                context.fillRect(x0 + 1, y(count), Math.max(1, x1 - x0 - 2), height - pad.bottom - y(count));
            });
            context.globalAlpha = 1;
            if (fixedTarget) {
                const start = Number.isFinite(targetStart) ? targetStart : targetEnd;
                const end = Number.isFinite(targetEnd) ? targetEnd : targetStart;
                context.fillStyle = C.red; context.globalAlpha = start === end ? .95 : .2;
                if (start === end) context.fillRect(x(end) - 1.5, pad.top, 3, height - pad.top - pad.bottom);
                else context.fillRect(x(Math.min(start, end)), pad.top, Math.max(3, x(Math.max(start, end)) - x(Math.min(start, end))), height - pad.top - pad.bottom);
                context.globalAlpha = 1; context.fillStyle = C.red; context.font = '8px sans-serif'; context.textAlign = end > maxX * .8 ? 'right' : 'left';
                context.fillText(window.relativeToHookEnd ? `median hook end + ${fmt(numeric(window.endSeconds), 1)}s` : (start === end ? `target ${fmt(end, 1)}s` : `target ${fmt(start, 1)}–${fmt(end, 1)}s`), x(end) + (end > maxX * .8 ? -4 : 4), 12);
            } else {
                context.fillStyle = C.amber; context.font = '8px sans-serif'; context.textAlign = 'right'; context.fillText('target has no single fixed viewer-time coordinate', width - pad.right, 12);
            }
            context.strokeStyle = C.green; context.lineWidth = 1.5; context.setLineDash([4, 3]);
            context.beginPath(); context.moveTo(x(median), pad.top); context.lineTo(x(median), height - pad.bottom); context.stroke(); context.setLineDash([]);
            [0, .25, .5, .75, 1].forEach(fraction => {
                const value = fraction * maxX; context.fillStyle = C.mute; context.font = '7px sans-serif'; context.textAlign = 'center';
                context.fillText(`${fmt(value, 1)}s`, x(value), height - 9);
            });
            context.textAlign = 'left'; context.fillStyle = C.cyan; context.fillText('hook semantic endpoints', pad.left, 12);
            context.fillStyle = C.green; context.fillText(`median ${fmt(median, 2)}s`, Math.min(width - 65, x(median) + 4), pad.top + 9);
            canvas.dataset.plSemanticEndpoints = String(endpoints.length);
            canvas.dataset.plOutcomeKind = String(window.kind || '');
            canvas.dataset.plHooksBeforeOutcome = lineage.sourceHooksWhoseSemanticInputEndsBeforeOutcomeWindow == null ? '' : String(lineage.sourceHooksWhoseSemanticInputEndsBeforeOutcomeWindow);
        }

        function selectLatticeNode(nodeId) {
            if (!nodeId || !String(nodeId).startsWith('span:')) return;
            const scrollX = window.scrollX, scrollY = window.scrollY;
            state.latticeNodeId = String(nodeId);
            paint();
            window.scrollTo(scrollX, scrollY);
        }

        function drawLatticeEmbedding(canvas) {
            const detail = activeLatticeDetail();
            if (!detail) return canvasContext(canvas);
            const nodes = visibleLatticeNodes(detail).filter(node => {
                const point = latticePoint(node);
                return Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]));
            });
            canvas._plLatticeNodeIds = nodes.map(node => node.id);
            const selected = new Set();
            nodes.forEach((node, index) => { if (node.id === state.latticeNodeId) selected.add(index); });
            canvas.dataset.plLatticeNodes = String(nodes.length);
            return scatter(
                canvas,
                nodes.map(node => latticePoint(node).map(Number)),
                nodes.map(node => clusterColor(node.category)),
                selected,
                nodes.map(node => node.candidateStatus === 'accepted' ? .62 : .18),
            );
        }

        function drawLatticeSpans(canvas) {
            const detail = activeLatticeDetail();
            const { context, width, height } = canvasContext(canvas);
            if (!detail) return;
            const nodes = visibleLatticeNodes(detail);
            const tokenCount = Math.max(1, Number(detail.tokenCount || 1));
            const pad = { left: 34, right: 12, top: 16, bottom: 25 };
            const x = value => pad.left + Number(value) / tokenCount * (width - pad.left - pad.right);
            const y = value => height - pad.bottom - (Math.max(1, Number(value)) - 1) / Math.max(1, tokenCount - 1) * (height - pad.top - pad.bottom);
            const hitRows = [];
            context.font = '8px sans-serif';
            context.fillStyle = C.mute;
            context.fillText('span width ↑', 3, 10);
            for (let token = 0; token <= tokenCount; token += Math.max(1, Math.ceil(tokenCount / 10))) {
                const px = x(token);
                context.strokeStyle = C.border;
                context.globalAlpha = .45;
                context.beginPath(); context.moveTo(px, pad.top); context.lineTo(px, height - pad.bottom); context.stroke();
                context.globalAlpha = 1;
                context.fillStyle = C.mute;
                context.fillText(String(token), px - 2, height - 8);
            }
            nodes.forEach(node => {
                const py = y(node.tokenCount), x1 = x(node.start), x2 = x(node.end);
                const selected = node.id === state.latticeNodeId;
                context.strokeStyle = selected ? C.text : clusterColor(node.category);
                context.globalAlpha = selected ? 1 : node.candidateStatus === 'accepted' ? .38 : .11;
                context.lineWidth = selected ? 3 : Math.max(1, Math.min(2.2, 1 + node.tokenCount / tokenCount));
                context.beginPath(); context.moveTo(x1, py); context.lineTo(x2, py); context.stroke();
                hitRows.push({ id: node.id, x1, x2, y: py });
            });
            context.globalAlpha = 1;
            canvas.dataset.plLatticeSpans = String(nodes.length);
            canvas.onclick = event => {
                const rect = canvas.getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top;
                let best = null, distance = Infinity;
                hitRows.forEach(row => {
                    const dx = px < row.x1 ? row.x1 - px : px > row.x2 ? px - row.x2 : 0;
                    const delta = dx * dx + (py - row.y) ** 2;
                    if (delta < distance) { distance = delta; best = row; }
                });
                if (best && distance < 196) selectLatticeNode(best.id);
            };
        }

        function drawLatticeGraph(canvas) {
            const detail = activeLatticeDetail();
            const { context, width, height } = canvasContext(canvas);
            if (!detail) return;
            const nodes = visibleLatticeNodes(detail).filter(node => Array.isArray(latticePoint(node)));
            const pointRows = nodes.map(node => ({ node, point: latticePoint(node).map(Number) }))
                .filter(row => Number.isFinite(row.point[0]) && Number.isFinite(row.point[1]));
            const xb = bounds(pointRows.map(row => row.point[0])), yb = bounds(pointRows.map(row => row.point[1]));
            const plotRight = Math.max(120, width - 130);
            const project = point => [12 + (point[0] - xb[0]) / ((xb[1] - xb[0]) || 1) * (plotRight - 24), height - 12 - (point[1] - yb[0]) / ((yb[1] - yb[0]) || 1) * (height - 24)];
            const positions = new Map(pointRows.map(row => [row.node.id, project(row.point)]));
            const anchors = [...(detail.anchorNodes || []), ...(detail.outcomeNodes || [])];
            anchors.forEach((node, index) => positions.set(node.id, [width - 112, 28 + index * Math.min(54, (height - 48) / Math.max(1, anchors.length))]));
            const edges = (detail.edges || []).filter(edge => edge.type === state.latticeEdgeType
                && positions.has(edge.source) && positions.has(edge.target));
            edges.forEach(edge => {
                const source = positions.get(edge.source), target = positions.get(edge.target);
                const incident = edge.source === state.latticeNodeId || edge.target === state.latticeNodeId;
                context.strokeStyle = incident ? C.text : edge.type === 'outcome' ? C.amber : edge.type === 'title' ? C.green : C.cyan;
                context.globalAlpha = incident ? .9 : .075;
                context.lineWidth = incident ? 1.5 : .55;
                context.beginPath(); context.moveTo(source[0], source[1]); context.lineTo(target[0], target[1]); context.stroke();
            });
            pointRows.forEach(row => {
                const point = positions.get(row.node.id), selected = row.node.id === state.latticeNodeId;
                context.globalAlpha = selected ? 1 : .62;
                context.fillStyle = clusterColor(row.node.category);
                context.beginPath(); context.arc(point[0], point[1], selected ? 5 : 2.1, 0, Math.PI * 2); context.fill();
                if (selected) { context.strokeStyle = C.text; context.lineWidth = 2; context.stroke(); }
            });
            context.globalAlpha = 1;
            context.font = '7px sans-serif';
            anchors.forEach(node => {
                const point = positions.get(node.id);
                context.fillStyle = node.type === 'outcome' ? C.amber : C.green;
                context.fillRect(point[0] - 3, point[1] - 3, 6, 6);
                context.fillText(String(node.text || node.name || node.id).slice(0, 18), point[0] + 6, point[1] + 3);
            });
            canvas.dataset.plLatticeEdges = String(edges.length);
            canvas.dataset.plLatticeGraphNodes = String(pointRows.length + anchors.length);
            canvas.onclick = event => {
                const rect = canvas.getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top;
                let best = null, distance = Infinity;
                pointRows.forEach(row => {
                    const point = positions.get(row.node.id), delta = (point[0] - px) ** 2 + (point[1] - py) ** 2;
                    if (delta < distance) { distance = delta; best = row.node.id; }
                });
                if (best && distance < 225) selectLatticeNode(best);
            };
        }

        function drawCanvases() {
            document.querySelectorAll('#pl-root canvas[data-pl-canvas]').forEach(canvas => {
                const kind = canvas.dataset.plCanvas;
                if (kind === 'lattice-embedding') return drawLatticeEmbedding(canvas);
                if (kind === 'lattice-spans') return drawLatticeSpans(canvas);
                if (kind === 'lattice-graph') return drawLatticeGraph(canvas);
                if (kind === 'replay-correction') return drawReplayCorrection(canvas);
                if (kind === 'hook-outcome-axis') return drawHookOutcomeAxis(canvas);
                if (kind === 'component-score-axis') return drawComponentScoreAxis(canvas);
                if (kind === 'prediction-calibration') return drawPredictionCalibration(canvas);
                if (kind === 'curve-accuracy') return drawCurveAccuracy(canvas);
                if (kind === 'boundary-trace') return drawBoundaryTrace(canvas);
                if (kind === 'market-transfer') return drawMarketTransfer(canvas);
                if (kind === 'long-title-transfer') return drawLongTitleTransfer(canvas);
                if (kind === 'axis-horizon') return drawAxisHorizon(canvas);
                if (kind === 'retention-forecast') return drawRetentionForecast(canvas, false);
                if (kind === 'library-retention-mini') return drawRetentionForecast(canvas, true);
                if (kind === 'word-embedding-map') return drawWordEmbeddingMap(canvas);
                if (kind === 'forecast-input-map') return drawForecastInputMap(canvas);
                if (kind === 'word-forecast-contribution') return drawWordForecastContribution(canvas);
                if (kind === 'hook-quality-axis') {
                    const summary = state.data.hookQuality || {};
                    const rows = ((summary.axis || {}).points || []);
                    const points = rows.map(row => [numeric(row.axisCoordinate), numeric(row.mapY)]);
                    const targets = rows.map(row => numeric(row.oofTargetResidual));
                    const range = bounds(targets);
                    const colors = targets.map(value => {
                        const t = Math.max(0, Math.min(1, (value - range[0]) / ((range[1] - range[0]) || 1)));
                        return `rgb(${Math.round(56 + 192 * t)},${Math.round(189 - 76 * t)},${Math.round(248 - 135 * t)})`;
                    });
                    const selected = new Set();
                    if (state.hookScoreResult && (state.hookScoreResult.map || {}).x != null) {
                        selected.add(points.length);
                        points.push([numeric(state.hookScoreResult.map.x), numeric(state.hookScoreResult.map.y)]);
                        colors.push(C.cyan);
                    }
                    return scatter(canvas, points, colors, selected, null, false, state.hookQualityPointIndex);
                }
                if (kind === 'forward-response-lag') {
                    const response = ((state.data.hookQuality || {}).forwardResponse || {});
                    const rows = [...(response.reverseTimeControls || []), ...(response.forwardCandidates || [])]
                        .sort((left, right) => numeric(left.lagSeconds) - numeric(right.lagSeconds));
                    const lags = rows.map(row => numeric(row.lagSeconds));
                    const selectedLag = numeric((response.metricContract || {}).selectedLagSeconds);
                    const selectedIndex = lags.findIndex(value => value === selectedLag);
                    return drawLatencyLines(canvas, lags, [
                        { label: 'balanced', color: C.cyan, width: 2.5, values: rows.map(row => numeric(row.heldoutCategoryBalancedSpearman)) },
                        ...[0, 1, 2, 3].map(category => ({
                            label: `cluster ${category}`, color: clusterColor(category), width: 1,
                            values: rows.map(row => numeric((row.heldoutSpearmanByCategory || {})[String(category)])),
                        })),
                    ], { negativeControl: true, selectedIndex, xFormat: latencyLagLabel, yFormat: value => signed(value, 3) });
                }
                if (kind === 'deconfounding-curves') return drawDeconfoundingCurves(canvas);
                if (kind === 'deconfounding-heatmap') return drawDeconfoundingHeatmap(canvas);
                if (kind === 'deconfounding-lag') return drawDeconfoundingLag(canvas);
                if (kind === 'deconfounding-reverse') return drawDeconfoundingReverse(canvas);
                if (kind === 'deconfounding-baselines') return drawDeconfoundingBaselines(canvas);
                if (kind === 'forward-response-axis') {
                    const summary = state.data.hookQuality || {};
                    const response = summary.forwardResponse || {};
                    const category = Number(canvas.dataset.plCategory);
                    const allRows = response.components || [];
                    const globalIndices = [];
                    const rows = [];
                    allRows.forEach((row, index) => {
                        if (Number(row.category) !== category) return;
                        globalIndices.push(index); rows.push(row);
                    });
                    canvas._plGlobalIndices = globalIndices;
                    const points = rows.map(row => [numeric(row.axisCoordinate), numeric(row.mapY)]);
                    const observed = rows.map(row => numeric(row.unexpectedObservedSlope));
                    const range = bounds(observed);
                    const colors = observed.map(value => {
                        const t = Math.max(0, Math.min(1, (value - range[0]) / ((range[1] - range[0]) || 1)));
                        return `rgb(${Math.round(56 + 192 * t)},${Math.round(189 - 76 * t)},${Math.round(248 - 135 * t)})`;
                    });
                    const selected = new Set();
                    const live = (((state.hookScoreResult || {}).forwardResponse || {}).components || []);
                    live.filter(row => Number(row.category) === category).forEach(row => {
                        if (!Number.isFinite(numeric(row.axisCoordinate)) || !Number.isFinite(numeric(row.mapY))) return;
                        selected.add(points.length);
                        points.push([numeric(row.axisCoordinate), numeric(row.mapY)]);
                        colors.push(C.cyan);
                    });
                    const focusedGlobal = Number(state.forwardResponseComponentIndex);
                    const focused = state.forwardResponseComponentIndex == null ? null : globalIndices.indexOf(focusedGlobal);
                    return scatter(canvas, points, colors, selected, null, false, focused >= 0 ? focused : null);
                }
                if (kind === 'interaction') return drawInteraction(canvas);
                if (kind === 'cluster-outcome-axis') {
                    const detail = state.clusterOutcomeDetail, points = detail && detail.points;
                    if (!points) return;
                    const scale = outcomeScale(detail);
                    const colors = scale.values.map(value => scale.color(value));
                    const plot = (points.x || []).map((x, index) => [numeric(x), numeric((points.y || [])[index])]);
                    return scatter(canvas, plot, colors, null, null, false, state.clusterOutcomePointIndex);
                }
                if (kind === 'cluster-outcome-oof') {
                    const validation = (state.clusterOutcomeDetail || {}).validation || {};
                    const points = (validation.predictedOOF || []).map((value, index) => [
                        numeric(value), numeric((validation.observedResidualOOF || [])[index]),
                    ]);
                    return scatter(canvas, points, points.map(() => clusterColor(state.clusterOutcomeCluster)), null);
                }
                if (kind === 'cluster-outcome-entry') {
                    const diagnostic = ((state.data.clusterOutcomes || {}).normalization || {}).entryTerminalDiagnostic || {};
                    const points = (diagnostic.predictedEntryOOF || []).map((value, index) => [
                        numeric(value), numeric((diagnostic.entry || [])[index]),
                    ]);
                    return scatter(canvas, points, points.map(() => C.cyan), null);
                }
                if (kind === 'cluster-outcome-offsets') return drawClusterOutcomeOffsets(canvas);
                if (kind === 'latency-effect') return drawLatencyEffect(canvas);
                if (kind === 'latency-baseline') return drawLatencyBaseline(canvas);
                if (kind === 'latency-transfer') return drawLatencyTransfer(canvas);
                if (kind === 'latency-natural') return drawLatencyNatural(canvas);
                if (kind === 'latency-point') return drawLatencyPoint(canvas);
                if (kind === 'components' || kind === 'hook-map') {
                    const atlas = kind === 'hook-map' ? state.data.atlas : activeAtlas(); if (!atlas) return;
                    const projections = atlas.projections || {};
                    const points = projections[state.representation] || projections.influence || Object.values(projections)[0] || [];
                    const selected = new Set();
                    atlasRows(atlas).forEach((row, index) => {
                        if (row.id === state.componentId || (kind === 'hook-map' && row.videoId === state.hookId)) selected.add(index);
                    });
                    return scatter(canvas, points, null, selected);
                }
                if (kind === 'cluster' || kind === 'cluster-mini') {
                    const atlas = activeAtlas(); if (!atlas) return;
                    const index = kind === 'cluster' ? state.mapIndex : Number(canvas.dataset.plMapIndex || 0);
                    const map = (atlas.maps || [])[index]; if (!map) return;
                    const points = (atlas.projections || {})[map.representation] || [];
                    const labels = map.labels || [];
                    let colors = labels.map(clusterColor), selectedIds = null, alphas = null;
                    if (kind === 'cluster' && state.focusedCluster != null) {
                        colors = labels.map(label => Number(label) === Number(state.focusedCluster) ? clusterColor(label) : C.faint);
                        alphas = labels.map(label => Number(label) === Number(state.focusedCluster) ? .72 : .07);
                        const probe = state.data.manualProbe, winner = probe && probe.winner;
                        if (winner && winner.mapId === map.id) {
                            const field = winner.scope === 'all-contiguous-spans' ? 'allSpanIndex' : 'candidateIndex';
                            selectedIds = new Set(((probe.winnerDetail || {}).matches || []).map(row => Number(row[field])));
                        }
                    }
                    return scatter(canvas, points, colors, selectedIds, alphas);
                }
                if (kind === 'manual-projection') {
                    const experiment = state.data.manualProjection;
                    if (!experiment) return;
                    const method = (experiment.methods || []).find(row => row.id === state.projectionMethod)
                        || (experiment.methods || []).find(row => row.id === experiment.selectedMethod);
                    const pointIndex = experiment.frozenPointIndex || {};
                    let labels = pointIndex.labels || [];
                    if (!labels.length) {
                        const atlas = state.data.allSpanAtlas || activeAtlas();
                        const map = atlas && (atlas.maps || []).find(row => row.id === experiment.mapId);
                        labels = (map && map.labels) || [];
                    }
                    if (!method || !labels.length) return;
                    const colors = labels.map(clusterColor);
                    const alphas = labels.map(() => .58);
                    const selectedIds = new Set((((state.data.manualProbe || {}).winnerDetail || {}).matches || [])
                        .map(row => Number(row.allSpanIndex)));
                    return scatter(canvas, method.points || [], colors, selectedIds, alphas, true, state.savedPointIndex);
                }
                if (kind === 'axis' || kind === 'axis-oof') {
                    const axes = state.data.axes, map = axes && (axes.maps || [])[state.axisIndex]; if (!map) return;
                    const observed = map.observed || [], ob = bounds(observed), colors = observed.map(value => {
                        if (!Number.isFinite(value)) return C.faint;
                        const t = Math.max(0, Math.min(1, (value - ob[0]) / ((ob[1] - ob[0]) || 1)));
                        return `rgb(${Math.round(248 * t + 56 * (1 - t))},${Math.round(113 * (1 - t) + 211 * t)},${Math.round(113 + 100 * (1 - t))})`;
                    });
                    const points = kind === 'axis'
                        ? (map.x || []).map((x, index) => [x, (map.y || [])[index]])
                        : (map.predictedOOF || []).map((prediction, index) => [prediction, (map.observedResidualOOF || [])[index]]);
                    return scatter(canvas, points, colors, null);
                }
                if (kind === 'swap-bars') {
                    const detail = state.source; if (!detail) return;
                    const { context, width, height } = canvasContext(canvas);
                    const rows = detail.targets || [], metric = state.metric;
                    const values = rows.map(row => Number((row.scores[metric] || {}).deltaFromBaseline));
                    const min = Math.min(0, ...values), max = Math.max(0, ...values), range = (max - min) || 1;
                    const zeroY = height - 9 - (0 - min) / range * (height - 18), bar = width / Math.max(1, values.length);
                    context.strokeStyle = C.dim; context.globalAlpha = .55; context.beginPath(); context.moveTo(0, zeroY); context.lineTo(width, zeroY); context.stroke();
                    values.forEach((value, index) => { const y = height - 9 - (value - min) / range * (height - 18); context.fillStyle = value >= 0 ? C.green : C.red; context.globalAlpha = .72; context.fillRect(index * bar, Math.min(y, zeroY), Math.max(1, bar - .5), Math.max(1, Math.abs(zeroY - y))); });
                    context.globalAlpha = 1;
                }
            });
        }

        function handleClick(event) {
            const target = event.target;
            const view = target.closest('[data-pl-view]'); if (view) { state.view = view.dataset.plView; ensureView(); paint(); return true; }
            const contractView = target.closest('[data-pl-contract-view]');
            if (contractView) { state.view = contractView.dataset.plContractView; ensureView(); paint(); return true; }
            const openAxisTarget = target.closest('[data-pl-open-axis-target]');
            if (openAxisTarget) {
                state.pendingAxisTarget = openAxisTarget.dataset.plOpenAxisTarget;
                state.view = 'axes'; ensureView(); paint(); return true;
            }
            if (target.closest('[data-pl-refresh]')) { Object.keys(state.data).forEach(key => delete state.data[key]); state.hook = null; state.source = null; state.focusedCluster = null; state.clusterOutcomeTarget = null; state.clusterOutcomeDetail = null; state.clusterOutcomePointIndex = null; state.latencyDetail = null; state.latencyPointGlobalIndex = null; state.hookQualityPointIndex = null; state.forwardResponseComponentIndex = null; state.latticeDetail = null; state.latticeVideoId = null; state.latticeNodeId = null; state.latticeError = null; ensureView(); return true; }
            if (target.closest('[data-pl-run-hook-score]')) { scoreHookText(); return true; }
            const latticeVideo = target.closest('[data-pl-lattice-video]');
            if (latticeVideo) {
                const videoId = latticeVideo.dataset.plLatticeVideo;
                if (state.view === 'library') state.hookLibrarySelectedId = videoId;
                loadLatticeDetail(videoId);
                return true;
            }
            const latticeNode = target.closest('[data-pl-lattice-node]');
            if (latticeNode) { selectLatticeNode(latticeNode.dataset.plLatticeNode); return true; }
            const latticeEdgeNode = target.closest('[data-pl-lattice-edge-node]');
            if (latticeEdgeNode) { selectLatticeNode(latticeEdgeNode.dataset.plLatticeEdgeNode); return true; }
            const latticeRepresentation = target.closest('[data-pl-lattice-representation]');
            if (latticeRepresentation) { const scrollX = window.scrollX, scrollY = window.scrollY; state.latticeRepresentation = latticeRepresentation.dataset.plLatticeRepresentation; paint(); window.scrollTo(scrollX, scrollY); return true; }
            const latticeResolution = target.closest('[data-pl-lattice-resolution]');
            if (latticeResolution) { const scrollX = window.scrollX, scrollY = window.scrollY; state.latticeResolution = latticeResolution.dataset.plLatticeResolution; paint(); window.scrollTo(scrollX, scrollY); return true; }
            const latticeEdge = target.closest('[data-pl-lattice-edge]');
            if (latticeEdge) { const scrollX = window.scrollX, scrollY = window.scrollY; state.latticeEdgeType = latticeEdge.dataset.plLatticeEdge; paint(); window.scrollTo(scrollX, scrollY); return true; }
            if (target.closest('[data-pl-lattice-apply]')) { paint(); return true; }
            const forecastWord = target.closest('[data-pl-forecast-word]');
            if (forecastWord) {
                const scrollX = window.scrollX, scrollY = window.scrollY;
                state.forecastWordIndex = Number(forecastWord.dataset.plForecastWord || 0);
                paint(); window.scrollTo(scrollX, scrollY); return true;
            }
            const retentionMode = target.closest('[data-pl-retention-mode]');
            if (retentionMode) {
                const scrollX = window.scrollX, scrollY = window.scrollY;
                state.retentionCurveMode = retentionMode.dataset.plRetentionMode;
                paint(); window.scrollTo(scrollX, scrollY); return true;
            }
            const libraryMetric = target.closest('[data-pl-library-metric]');
            if (libraryMetric) { state.hookLibraryMetric = libraryMetric.dataset.plLibraryMetric; paint(); return true; }
            if (target.closest('[data-pl-library-apply]')) { paint(); return true; }
            if (target.closest('[data-pl-library-close]')) { state.hookLibrarySelectedId = null; state.latticeVideoId = null; state.latticeDetail = null; paint(); return true; }
            const libraryHook = target.closest('[data-pl-library-hook]');
            if (libraryHook) {
                const scrollX = window.scrollX, scrollY = window.scrollY;
                state.hookLibrarySelectedId = libraryHook.dataset.plLibraryHook;
                state.forecastWordIndex = 0;
                loadLatticeDetail(state.hookLibrarySelectedId); window.scrollTo(scrollX, scrollY); return true;
            }
            const example = target.closest('[data-pl-hook-example]');
            if (example) {
                if (state.hookScoreLoading) return true;
                const row = ((state.data.hookExamples || {}).examples || []).find(item => item.id === example.dataset.plHookExample);
                if (row) {
                    state.hookScoreText = row.text;
                    state.hookScoreResult = row.score;
                    state.hookScoreError = null;
                    state.hookQualityPointIndex = null;
                    state.forecastWordIndex = 0;
                    paint();
                }
                return true;
            }
            if (target.closest('[data-pl-open-manual-probe]')) { openManualProbe(); return true; }
            if (target.closest('[data-pl-clear-cluster-focus]')) { state.focusedCluster = null; paint(); return true; }
            if (target.closest('[data-pl-apply-query]')) { state.registryPage = 0; paint(); return true; }
            const hook = target.closest('[data-pl-hook]'); if (hook) { if (hook.hasAttribute('data-pl-open-hooks')) state.view = 'hooks'; load('atlas'); loadHook(hook.dataset.plHook); return true; }
            const atlasScope = target.closest('[data-pl-atlas-scope]'); if (atlasScope) { state.atlasScope = atlasScope.dataset.plAtlasScope; state.componentId = null; state.mapIndex = 0; state.mapPage = 0; state.focusedCluster = null; state.representation = 'influence'; if (state.atlasScope === 'all') load('allSpanAtlas', api('all-span-atlas')); else load('atlas'); paint(); return true; }
            const rep = target.closest('[data-pl-rep]'); if (rep) { state.representation = rep.dataset.plRep; paint(); return true; }
            const component = target.closest('[data-pl-component]'); if (component) { state.componentId = component.dataset.plComponent; if (component.hasAttribute('data-pl-open-components')) state.view = 'components'; paint(); return true; }
            const map = target.closest('[data-pl-map]'); if (map) { state.mapIndex = Number(map.dataset.plMap); state.focusedCluster = null; paint(); return true; }
            const mapPage = target.closest('[data-pl-map-page]'); if (mapPage) { const maps = ((activeAtlas() || {}).maps || []); const max = Math.max(0, Math.ceil(maps.length / 24) - 1); state.mapPage = Math.max(0, Math.min(max, state.mapPage + Number(mapPage.dataset.plMapPage))); state.mapIndex = Math.min(Math.max(0, maps.length - 1), state.mapPage * 24); state.focusedCluster = null; paint(); return true; }
            const projectionMethod = target.closest('[data-pl-projection-method]'); if (projectionMethod) { state.projectionMethod = projectionMethod.dataset.plProjectionMethod; try { window.localStorage.setItem(projectionMethodKey, state.projectionMethod); } catch (_) { /* Storage is optional. */ } paint(); return true; }
            const outcomeTarget = target.closest('[data-pl-outcome-target]'); if (outcomeTarget) { const summary = state.data.clusterOutcomes || {}, cluster = Number(outcomeTarget.dataset.plOutcomeCluster ?? state.clusterOutcomeCluster), name = outcomeTarget.dataset.plOutcomeTarget; state.clusterOutcomeFamily = ((summary.targetDefinitions || {})[name] || {}).family || state.clusterOutcomeFamily; loadClusterOutcomeDetail(cluster, name); return true; }
            const outcomeCluster = target.closest('[data-pl-outcome-cluster]'); if (outcomeCluster) { const summary = state.data.clusterOutcomes || {}, cluster = Number(outcomeCluster.dataset.plOutcomeCluster), clusterRow = (summary.clusters || []).find(row => Number(row.label) === cluster), available = new Set((clusterRow && clusterRow.targets || []).map(row => row.target)); const name = available.has(state.clusterOutcomeTarget) ? state.clusterOutcomeTarget : ((clusterRow && clusterRow.targets || [])[0] || {}).target; if (name) loadClusterOutcomeDetail(cluster, name); return true; }
            const outcomeFamily = target.closest('[data-pl-outcome-family]'); if (outcomeFamily) { const family = outcomeFamily.dataset.plOutcomeFamily, summary = state.data.clusterOutcomes || {}, cluster = (summary.clusters || []).find(row => Number(row.label) === Number(state.clusterOutcomeCluster)), row = (cluster && cluster.targets || []).find(item => ((summary.targetDefinitions || {})[item.target] || {}).family === family); state.clusterOutcomeFamily = family; if (row) loadClusterOutcomeDetail(state.clusterOutcomeCluster, row.target); else paint(); return true; }
            const outcomeGlobal = target.closest('[data-pl-outcome-global-index]'); if (outcomeGlobal) { const indices = ((state.clusterOutcomeDetail || {}).points || {}).globalIndices || [], local = indices.indexOf(Number(outcomeGlobal.dataset.plOutcomeGlobalIndex)); if (local >= 0) { state.clusterOutcomePointIndex = local; paint(); } return true; }
            const latencyCluster = target.closest('[data-pl-latency-cluster]'); if (latencyCluster) { state.latencyCluster = Number(latencyCluster.dataset.plLatencyCluster); state.latencySelectedLagIndex = null; state.latencyDetail = null; if (state.latencyPointGlobalIndex != null) loadLatencyDetail(state.latencyCluster); else paint(); return true; }
            const latencyWindow = target.closest('[data-pl-latency-window]'); if (latencyWindow) { state.latencyWindow = latencyWindow.dataset.plLatencyWindow; state.latencySelectedLagIndex = null; paint(); return true; }
            const latencyPoint = target.closest('[data-pl-latency-point-global]'); if (latencyPoint) { state.latencyPointGlobalIndex = Number(latencyPoint.dataset.plLatencyPointGlobal); loadLatencyDetail(state.latencyCluster); return true; }
            const metric = target.closest('[data-pl-metric]'); if (metric) { state.metric = metric.dataset.plMetric; paint(); return true; }
            const source = target.closest('[data-pl-source]'); if (source) { if (source.hasAttribute('data-pl-open-swaps')) { state.view = 'swaps'; load('swaps'); } loadSource(source.dataset.plSource); return true; }
            const axis = target.closest('[data-pl-axis]'); if (axis) { state.axisIndex = Number(axis.dataset.plAxis); paint(); return true; }
            const stage = target.closest('[data-pl-registry-stage]'); if (stage) { state.registryStage = stage.dataset.plRegistryStage; state.registryPage = 0; paint(); return true; }
            const registryPage = target.closest('[data-pl-registry-page]'); if (registryPage) { state.registryPage = Math.max(0, state.registryPage + Number(registryPage.dataset.plRegistryPage)); paint(); return true; }
            return false;
        }

        function handleInput(event) {
            if (event.target.matches('[data-pl-hook-score-input]')) {
                state.hookScoreText = event.target.value;
                const count = document.querySelector('[data-pl-hook-score-count]');
                if (count) count.textContent = `${state.hookScoreText.length.toLocaleString()}/1,200 characters`;
                return true;
            }
            if (event.target.matches('[data-pl-hook-score-idea]')) { state.hookScoreIdea = event.target.value; return true; }
            if (event.target.matches('[data-pl-query="lattice"]')) { state.latticeQuery = event.target.value; return true; }
            if (event.target.matches('[data-pl-query="lattice-corpus"]')) { state.latticeCorpusQuery = event.target.value; return true; }
            if (event.target.matches('[data-pl-query="library"]')) { state.hookLibraryQuery = event.target.value; return true; }
            if (event.target.matches('[data-pl-query="hook"]')) { state.hookQuery = event.target.value; return true; }
            if (event.target.matches('[data-pl-query="registry"]')) { state.registryQuery = event.target.value; return true; }
            return false;
        }

        function handleChange() { return false; }

        function afterRender() {
            ensureView();
            drawCanvases();
            if (!resizeBound) {
                window.addEventListener('resize', () => {
                    clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(drawCanvases, 80);
                });
                resizeBound = true;
            }
            if (!progressTimer) progressTimer = setInterval(() => {
                const progress = state.data.progress || {};
                if (progress.status !== 'complete') pollProgress();
            }, 15000);
        }

        return { render, afterRender, handleClick, handleInput, handleChange };
    };
})();
