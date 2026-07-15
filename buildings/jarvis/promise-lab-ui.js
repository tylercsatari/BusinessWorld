(function () {
    'use strict';

    window.createShortsPromiseLab = function createShortsPromiseLab(options) {
        const C = Object.assign({
            bg: '#0b1120', card: '#0f172a', card2: '#131c30', border: '#1e293b',
            border2: '#27364d', text: '#e2e8f0', dim: '#94a3b8', mute: '#64748b',
            faint: '#475569', cyan: '#22d3ee', green: '#34d399', amber: '#f59e0b',
            red: '#f87171', purple: '#a78bfa', accent: '#38bdf8',
        }, (options || {}).colors || {});
        const esc = (options || {}).escape || (value => String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;'));
        const api = name => `/api/shortsquant/promise-lab/${name}`;
        const getScope = typeof (options || {}).getScope === 'function'
            ? (options || {}).getScope : (() => 'tyler');
        const currentScope = () => String(getScope() || 'tyler').replace(/[^a-z0-9_-]/gi, '') || 'tyler';
        const clusterColors = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399'];
        const state = {
            view: 'scorer', data: {}, loading: {}, errors: {},
            scope: currentScope(),
            scoreText: '', scoreDuration: '', scoreResult: null, scoreLoading: false,
            scoreStatus: '', scoreError: '', scoreJobId: null,
            query: '', sort: 'predicted', libraryLimit: 60, selectedVideo: null,
            selectedPrediction: null, selectedLattice: null, detailLoading: false,
            detailError: '', selectedComponent: 0, selectedLatticeNode: null,
            curveMode: 'entryIndexed', showStages: true,
            savedMethod: 'maxmin', savedPoint: null, selectedAttributionStep: 0,
            latticeEdgeType: 'sequence', measurementMode: 'forward', outcomePoint: null,
            outcomeLag: 0,
        };
        const detailCache = new Map();
        let host = null;
        let scoreRequest = 0;
        let detailRequest = 0;
        let savedMapGeometry = null;

        const numeric = value => (
            value === null || value === undefined || value === ''
                ? null
                : (Number.isFinite(Number(value)) ? Number(value) : null)
        );
        const fmt = (value, digits = 1) => numeric(value) == null ? '—' : Number(value).toFixed(digits);
        const signed = (value, digits = 1) => numeric(value) == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(digits)}`;
        const pct = value => numeric(value) == null ? '—' : `${fmt(value, 1)}%`;
        const compact = value => {
            value = numeric(value);
            if (value == null) return '—';
            if (Math.abs(value) >= 1e9) return `${fmt(value / 1e9, 2)}B`;
            if (Math.abs(value) >= 1e6) return `${fmt(value / 1e6, 2)}M`;
            if (Math.abs(value) >= 1e3) return `${fmt(value / 1e3, 1)}K`;
            return fmt(value, 0);
        };
        const colorForCluster = value => clusterColors[Math.max(0, Number(value) || 0) % 4];
        const button = (label, attrs, active) => `<button ${attrs || ''} style="border:1px solid ${active ? C.cyan : C.border};background:${active ? C.cyan + '1f' : C.card2};color:${active ? C.cyan : C.dim};padding:6px 9px;font-size:9px;font-weight:800;cursor:pointer">${esc(label)}</button>`;
        const panel = (body, extra) => `<section style="border:1px solid ${C.border};background:${C.card};padding:10px;min-width:0;${extra || ''}">${body}</section>`;
        const stat = (label, value, color, sub) => `<div style="min-width:112px;border-left:3px solid ${color || C.cyan};padding:3px 7px"><div style="font-size:7px;color:${C.mute};font-weight:900;text-transform:uppercase">${esc(label)}</div><div style="font-size:18px;color:${color || C.text};font-weight:900;line-height:1.15">${esc(value)}</div>${sub ? `<div style="font-size:7px;color:${C.mute};line-height:1.35;margin-top:2px">${esc(sub)}</div>` : ''}</div>`;
        const errorPanel = message => panel(`<div style="font-size:9px;color:${C.red}">${esc(message)}</div>`);
        const loadingPanel = message => panel(`<div style="font-size:9px;color:${C.cyan}">${esc(message)}</div>`);

        const openingDataKey = scope => `openingPredictions:${scope || state.scope}`;
        const openingSummary = () => state.data[openingDataKey()];
        const openingSummaryError = () => state.errors[openingDataKey()];
        const openingSummaryPath = () => `${api('opening-predictions')}?scope=${encodeURIComponent(state.scope)}`;
        const contextStudy = () => ((openingSummary() || {}).contextStudy)
            || state.data.openingContextStudy || {};

        function syncScope() {
            const scope = currentScope();
            if (scope === state.scope) return false;
            state.scope = scope;
            state.query = ''; state.libraryLimit = 60; state.selectedVideo = null;
            state.selectedPrediction = null; state.selectedLattice = null;
            state.detailLoading = false; state.detailError = '';
            state.selectedComponent = 0; state.selectedLatticeNode = null;
            state.selectedAttributionStep = 0; state.outcomePoint = null;
            detailRequest += 1;
            return true;
        }

        function paint() {
            if (!host) return;
            host.outerHTML = renderBody();
            host = document.querySelector('#pl-root');
            window.requestAnimationFrame(drawAll);
        }

        async function load(name, path, force) {
            if (!force && (state.data[name] || state.loading[name])) return state.data[name];
            state.loading[name] = true; delete state.errors[name]; paint();
            try {
                const response = await fetch(path || api(name), { cache: force ? 'reload' : 'default' });
                const value = await response.json().catch(() => ({}));
                if (!response.ok || value.error) throw new Error(value.error || `${response.status} ${response.statusText}`);
                state.data[name] = value;
                return value;
            } catch (error) {
                state.errors[name] = String(error && error.message || error);
                return null;
            } finally {
                state.loading[name] = false; paint();
            }
        }

        function ensureViewData() {
            syncScope();
            if (state.view === 'library' || (state.view === 'scorer' && state.scoreResult)) {
                load(openingDataKey(), openingSummaryPath());
            }
            if (state.view === 'saved') {
                load('manualProjection', api('manual-projection'));
                load('canonicalPartitions', api('canonical-partitions'));
            }
        }

        async function jsonResponse(response, allowError) {
            const value = await response.json().catch(() => ({}));
            if (!response.ok || (!allowError && value.error)) {
                throw new Error(value.error || `${response.status} ${response.statusText}`);
            }
            return value;
        }

        async function pollScoreJob(jobId, request) {
            for (let attempt = 0; attempt < 180; attempt++) {
                if (attempt) await new Promise(resolve => window.setTimeout(resolve, attempt < 8 ? 2200 : 4500));
                if (request !== scoreRequest) throw new Error('score superseded');
                const job = await jsonResponse(await fetch(
                    `/api/shortsquant/jobs/${encodeURIComponent(jobId)}`,
                    { cache: 'no-store' },
                ), true);
                if (job.status === 'done') return job.result;
                if (job.status === 'error') throw new Error(job.error || 'opening score failed');
                state.scoreStatus = job.status === 'queued'
                    ? 'Queued in the interactive lane'
                    : 'Embedding the delivered sequence and applying the frozen risk-set models';
                paint();
            }
            throw new Error('The scorer is still running after 15 minutes.');
        }

        async function scoreOpening() {
            const text = String(state.scoreText || '').replace(/\s+/g, ' ').trim();
            const suppliedDuration = Number(state.scoreDuration);
            const durationSeconds = Number.isFinite(suppliedDuration) && suppliedDuration > 0
                ? suppliedDuration : null;
            if (!/[\p{L}\p{N}_]/u.test(text)) { state.scoreError = 'Type at least one word to score.'; paint(); return; }
            if (state.scoreLoading) return;
            const request = ++scoreRequest;
            state.scoreLoading = true; state.scoreError = ''; state.scoreResult = null;
            state.scoreStatus = 'Submitting the exact opening'; paint();
            try {
                const submitted = await jsonResponse(await fetch(api('hook-score'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, durationSeconds, async: true }), cache: 'no-store',
                }));
                state.scoreJobId = submitted.jobId || null;
                const result = submitted.jobId ? await pollScoreJob(submitted.jobId, request) : submitted;
                if (request === scoreRequest) {
                    state.scoreResult = result; state.selectedComponent = 0;
                    state.selectedLatticeNode = null; state.selectedAttributionStep = 0;
                    state.savedPoint = null; state.outcomePoint = null;
                    load(openingDataKey(), openingSummaryPath());
                    load('manualProjection', api('manual-projection'));
                }
            } catch (error) {
                if (request === scoreRequest) state.scoreError = String(error && error.message || error);
            } finally {
                if (request === scoreRequest) {
                    state.scoreLoading = false; state.scoreStatus = ''; state.scoreJobId = null; paint();
                }
            }
        }

        async function loadVideo(videoId) {
            const request = ++detailRequest;
            const scope = state.scope;
            state.selectedVideo = String(videoId); state.detailError = '';
            state.selectedComponent = 0; state.selectedLatticeNode = null;
            state.selectedAttributionStep = 0; state.savedPoint = null;
            state.outcomePoint = null;
            const generation = (openingSummary() || {}).generationId || 'legacy';
            const cacheKey = `${scope}:${generation}:${videoId}`;
            const cached = detailCache.get(cacheKey);
            if (cached) {
                state.selectedPrediction = cached.prediction; state.selectedLattice = cached.lattice; paint(); return;
            }
            state.selectedPrediction = null; state.selectedLattice = null; state.detailLoading = true; paint();
            load('manualProjection', api('manual-projection'));
            if (!(openingSummary() || {}).contextStudy) {
                load('openingContextStudy', api('opening-context-study'));
            }
            try {
                const generationQuery = generation !== 'legacy'
                    ? `&generation=${encodeURIComponent(generation)}` : '';
                const prediction = await jsonResponse(await fetch(
                    `${api('opening-prediction')}/${encodeURIComponent(videoId)}?scope=${encodeURIComponent(scope)}${generationQuery}`,
                ));
                const lattice = prediction.componentGraph || prediction.componentLattice || null;
                if (request !== detailRequest || scope !== state.scope) return;
                detailCache.set(cacheKey, { prediction, lattice });
                while (detailCache.size > 3) detailCache.delete(detailCache.keys().next().value);
                state.selectedPrediction = prediction; state.selectedLattice = lattice;
            } catch (error) {
                if (request === detailRequest) state.detailError = String(error && error.message || error);
            } finally {
                if (request === detailRequest) { state.detailLoading = false; paint(); }
            }
        }

        function activeAnalysis() {
            if (state.view === 'scorer') return {
                prediction: state.scoreResult,
                lattice: state.scoreResult && (
                    state.scoreResult.componentGraph || state.scoreResult.componentLattice
                ),
            };
            return { prediction: state.selectedPrediction, lattice: state.selectedLattice };
        }

        function validationSummary(analysis) {
            const family = ((analysis.validation || {}).entryIndexed || {});
            const selected = (((analysis.contributions || {}).at20Seconds || (analysis.contributions || {}).atAnalyzedEnd || {}).selectedStage)
                || (((analysis.curves || {}).entryIndexed || {}).selectedStage) || 'semanticPrefix';
            const random = family.randomFold || {};
            const summary = openingSummary() || {};
            const corpusFamily = ((summary.validation || {}).entryIndexed || {});
            const chronological = family.chronological || corpusFamily.chronological || {};
            return {
                selected, random, chronological,
                candidateRandom: family.candidateRandomFold || {},
                candidateChronological: family.candidateChronological || {},
                promotion: family.promotion || {},
            };
        }

        function lastFinite(values) {
            for (let index = (values || []).length - 1; index >= 0; index--) {
                if (numeric(values[index]) != null) return Number(values[index]);
            }
            return null;
        }

        function endpointChannels(analysis) {
            const family = ((analysis.curves || {}).entryIndexed || {});
            const stages = family.stages || {};
            const names = ['baseline', 'timing', 'semantic', 'components', 'relationships'];
            const values = Object.fromEntries(names.map(name => [name, lastFinite(stages[name] || [])]));
            const finalValue = lastFinite(family.predicted || []);
            const selectedStage = family.selectedStage || 'baseline';
            const stageOrder = ['baseline', 'timing', 'semantic', 'components', 'relationships'];
            const selectedIndex = Math.max(0, stageOrder.indexOf(selectedStage));
            const rawDeltas = {
                timing: values.timing == null || values.baseline == null ? null : values.timing - values.baseline,
                semantic: values.semantic == null || values.timing == null ? null : values.semantic - values.timing,
                components: values.components == null || values.semantic == null ? null : values.components - values.semantic,
                relationships: values.relationships == null || values.components == null ? null : values.relationships - values.components,
            };
            return {
                values,
                deltas: rawDeltas,
                appliedDeltas: Object.fromEntries(['timing', 'semantic', 'components', 'relationships'].map((name, index) => [
                    name, index + 1 <= selectedIndex ? rawDeltas[name] : 0,
                ])),
                finalValue,
                selectedStage,
                candidateStage: family.candidateStage || 'relationships',
                promotion: family.promotion || {},
            };
        }

        function headline(analysis) {
            const output = analysis.outputs || {};
            const actual = analysis.actual || null;
            const predictionError = analysis.predictionError || null;
            const views = output.viewsDiagnostic || null;
            const forecastEnd = numeric(output.forecastEndSeconds) == null
                ? numeric(analysis.forecastHorizonSeconds)
                : numeric(output.forecastEndSeconds);
            const prediction = numeric(output.retainedAtForecastEndPercent) == null
                ? output.retainedAtAnalyzedEndPercent
                : output.retainedAtForecastEndPercent;
            const lower = numeric(output.retainedAtForecastEndP10) == null
                ? output.retainedAtAnalyzedEndP10 : output.retainedAtForecastEndP10;
            const upper = numeric(output.retainedAtForecastEndP90) == null
                ? output.retainedAtAnalyzedEndP90 : output.retainedAtForecastEndP90;
            const viewsAvailable = !!(views && views.promoted);
            return `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;padding:10px 0;border-bottom:1px solid ${C.border}">
                ${stat(`predicted retained${forecastEnd == null ? '' : ` · ${fmt(forecastEnd, 1)}s`}`, pct(prediction), C.green, `OOF residual band ${pct(lower)}–${pct(upper)}`)}
                ${stat('predicted absolute R5', output.absoluteRetention5sPercent == null ? 'withheld' : pct(output.absoluteRetention5sPercent), C.cyan, output.absoluteRetention5sPercent == null ? 'supplied text ends before 5s' : 'same raw R5 definition used by Shorts Quant')}
                ${stat('normalized drop', pct(output.normalizedDropByAnalyzedEndPoints), C.amber, 'entry indexed: starts at 100%')}
                ${stat('views diagnostic', viewsAvailable ? compact(views.estimate) : 'withheld', viewsAvailable ? C.purple : C.amber, views ? `R5 scenario ${compact(views.lower80)}–${compact(views.upper80)} · ${views.status || 'withheld'}` : 'needs at least five seconds of supplied text')}
                ${actual ? stat('actual retained', pct(numeric(actual.retainedAtForecastEndPercent) == null ? actual.retainedAt20sPercent : actual.retainedAtForecastEndPercent), C.text, `actual R5 ${pct(actual.absoluteRetention5sPercent)} · ${compact(actual.views)} views`) : ''}
                ${predictionError ? stat('prediction error', `${signed(predictionError.retainedAtForecastEndPoints, 2)} pp`, Math.abs(Number(predictionError.retainedAtForecastEndPoints || 0)) > 7 ? C.red : C.dim, `whole-curve MAE ${fmt(predictionError.curveMAEPercentagePoints, 2)} pp`) : ''}
            </div>`;
        }

        function evidencePanel(analysis) {
            const validation = validationSummary(analysis);
            const support = analysis.support || {};
            const channels = endpointChannels(analysis);
            const selectedLabel = channels.selectedStage || validation.selected;
            const promotion = validation.promotion || channels.promotion || {};
            const randomGain = numeric(validation.random.sourceEqualMAEImprovementFraction) == null
                ? numeric(validation.random.maeImprovementFraction)
                : numeric(validation.random.sourceEqualMAEImprovementFraction);
            const forwardGain = numeric(validation.chronological.sourceEqualMAEImprovementFraction) == null
                ? numeric(validation.chronological.maeImprovementFraction)
                : numeric(validation.chronological.sourceEqualMAEImprovementFraction);
            const forwardPassed = forwardGain != null && forwardGain > 0;
            const equation = [
                `${fmt(channels.values.baseline, 2)}% baseline`,
                `${signed(channels.appliedDeltas.timing, 2)} pp timing`,
                `${signed(channels.appliedDeltas.semantic, 2)} pp prefix semantics`,
                `${signed(channels.appliedDeltas.components, 2)} pp components`,
                `${signed(channels.appliedDeltas.relationships, 2)} pp sequence context`,
                `= ${fmt(channels.finalValue, 2)}%`,
            ].join(' · ');
            const randomMae = numeric(validation.random.sourceEqualMAEPercentagePoints) == null
                ? validation.random.heldoutMAEPercentagePoints
                : validation.random.sourceEqualMAEPercentagePoints;
            const randomBaseline = numeric(validation.random.sourceEqualBaselineMAEPercentagePoints) == null
                ? validation.random.baselineMAEPercentagePoints
                : validation.random.sourceEqualBaselineMAEPercentagePoints;
            const chronologicalMae = numeric(validation.chronological.sourceEqualMAEPercentagePoints) == null
                ? validation.chronological.heldoutMAEPercentagePoints
                : validation.chronological.sourceEqualMAEPercentagePoints;
            const chronologicalBaseline = numeric(validation.chronological.sourceEqualBaselineMAEPercentagePoints) == null
                ? validation.chronological.baselineMAEPercentagePoints
                : validation.chronological.sourceEqualBaselineMAEPercentagePoints;
            return panel(`<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div style="max-width:800px"><div style="font-size:11px;color:${C.text};font-weight:900">Prediction evidence</div><div style="font-size:8px;color:${C.dim};line-height:1.55;margin-top:3px">Every point uses only words and completed boundary-evidence windows available by that second. The full timing → semantic → four-cluster → prior-sequence ladder remains visible as a candidate; only stages that pass the declared global gate enter the cyan headline.</div><div style="font-size:8px;color:${C.text};margin-top:6px"><b>Applied endpoint equation:</b><br><span style="color:${C.cyan}">${equation}</span></div><div style="font-size:7.5px;color:${C.amber};margin-top:5px">Candidate ${esc(channels.candidateStage)} · random gate ${promotion.randomGatePassed ? 'passed' : 'failed'} · chronological gate ${promotion.chronologicalGatePassed ? 'passed' : 'failed'} · stage shopping disabled</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('promotion status', promotion.promoted ? 'candidate promoted' : 'baseline retained', promotion.promoted ? C.green : C.amber, promotion.promoted ? 'both source-level gates passed' : 'full sequence candidate did not clear both gates')}${stat('applied stage', selectedLabel, promotion.promoted ? C.green : C.amber)}${stat('selected random MAE', `${fmt(randomMae, 2)} pp`, C.cyan, `baseline ${fmt(randomBaseline, 2)} pp · ${randomGain == null ? '—' : signed(randomGain * 100, 1) + '%'}`)}${stat('selected forward MAE', `${fmt(chronologicalMae, 2)} pp`, C.amber, `baseline ${fmt(chronologicalBaseline, 2)} pp`)}${stat('forecast support', `${fmt(support.servedForecastThroughSeconds || analysis.forecastHorizonSeconds, 0)}s`, C.purple, `${support.riskSetSourcesAtForecastEnd || 'typed'} at-risk sources at endpoint`)}</div></div>`, 'margin-top:10px');
        }

        function tokenStrip(analysis) {
            const components = analysis.components || [];
            return `<div style="display:flex;flex-wrap:wrap;gap:3px;align-items:stretch">${components.map((component, index) => `<button data-pl-component="${index}" title="cluster ${component.category}" style="border:1px solid ${state.selectedComponent === index ? colorForCluster(component.category) : C.border};background:${colorForCluster(component.category)}18;color:${C.text};padding:5px 7px;font-size:8px;line-height:1.35;cursor:pointer;max-width:260px;text-align:left"><b style="color:${colorForCluster(component.category)}">C${component.category}</b> ${esc(component.text)}</button>`).join('')}</div>`;
        }

        function activeComponent(analysis) {
            const components = analysis.components || [];
            return components[Math.min(state.selectedComponent, Math.max(0, components.length - 1))] || {};
        }

        function projectedComponentPoint(component, method) {
            const values = component.categoryCoordinates4D || [];
            const basis = (method || {}).basis4x2 || [];
            if (values.length === 4 && basis.length === 4) return [0, 1].map(column => values.reduce((sum, value, row) => sum + Number(value) * Number((basis[row] || [])[column] || 0), 0));
            return method && method.id === 'maxmin' && numeric(component.mapX) != null ? [Number(component.mapX), Number(component.mapY)] : null;
        }

        function categoryProbabilityBars(component) {
            const values = component.categoryDistribution || [];
            return `<div style="display:grid;gap:4px">${[0, 1, 2, 3].map(category => { const value = Math.max(0, Math.min(1, Number(values[category] || 0))); return `<div style="display:grid;grid-template-columns:22px minmax(80px,1fr) 48px;gap:5px;align-items:center;font-size:7px"><b style="color:${colorForCluster(category)}">C${category}</b><span style="height:8px;background:${C.border};position:relative"><i style="display:block;width:${value * 100}%;height:100%;background:${colorForCluster(category)}"></i></span><span style="color:${C.dim};text-align:right">${pct(value * 100)}</span></div>`; }).join('')}</div>`;
        }

        function componentLedgerTable(analysis) {
            const components = analysis.components || [];
            if (!components.length) return '';
            return `<div style="overflow:auto;max-height:430px;margin-top:7px"><table style="width:100%;min-width:1180px;border-collapse:collapse;font-size:7.5px"><thead><tr>${[
                'component and exact text', 'tokens / spoken time', 'cluster', 'all cluster probabilities',
                'saved map x / y', 'model movement', 'stage-channel movement', 'observed movement', 'viewer context / outcome plane',
            ].map(value => `<th style="position:sticky;top:0;background:${C.card};text-align:right;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${components.map((component, index) => {
                const timeline = component.timelineAttribution || {};
                const probabilities = component.categoryDistribution || [];
                const context = component.viewerContext || {};
                const plane = component.outcomePlane || {};
                const channel = timeline.channelDeltaPoints || {};
                const slope = numeric(plane.predictedRetentionSlopePercentagePointsPerSecond) == null
                    ? plane.oofPredictedSlopePercentagePointsPerSecond
                    : plane.predictedRetentionSlopePercentagePointsPerSecond;
                return `<tr data-pl-component="${index}" style="cursor:pointer;background:${state.selectedComponent === index ? C.cyan + '12' : 'transparent'}"><td style="text-align:left;padding:5px;border-bottom:1px solid ${C.border};max-width:360px"><b style="color:${colorForCluster(component.category)}">${index + 1} · C${component.category}</b><br><span style="color:${C.text};line-height:1.4">${esc(component.text)}</span></td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};white-space:nowrap">${component.startToken == null ? component.start : component.startToken}–${component.endToken == null ? component.end : component.endToken}<br>${fmt(component.spokenStartSeconds, 3)}–${fmt(component.spokenEndSeconds, 3)}s<br><span style="color:${C.mute}">evidence ${fmt(component.boundaryEvidenceAvailableSeconds, 3)}s</span></td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${colorForCluster(component.category)};font-weight:900">C${component.category}<br>${pct(Number(component.categoryProbability || probabilities[component.category] || 0) * 100)}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};white-space:nowrap">${[0, 1, 2, 3].map(category => `<span style="color:${colorForCluster(category)}">C${category} ${pct(Number(probabilities[category] || 0) * 100)}</span>`).join('<br>')}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};white-space:nowrap">${fmt(component.mapX, 5)}<br>${fmt(component.mapY, 5)}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};font-weight:900">${signed(timeline.predictedDeltaPoints, 2)} pp</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};white-space:nowrap"><span style="color:${C.amber}">time ${signed(channel.timing, 2)}</span><br><span style="color:${C.purple}">semantic ${signed(channel.semantic, 2)}</span><br><span style="color:${C.accent}">components ${signed(channel.components, 2)}</span><br><span style="color:${C.green}">relations ${signed(channel.relationships, 2)}</span></td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${C.green}">${timeline.observedDeltaPoints == null ? '—' : signed(timeline.observedDeltaPoints, 2) + ' pp'}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${C.amber}">${esc(context.transition || 'START')}<br>${slope == null ? 'plane unavailable' : `${signed(slope, 3)} pp/s`}<br><span style="color:${C.mute}">x ${fmt(plane.x, 3)} · ${fmt(plane.xPercentile, 1)}th</span></td></tr>`;
            }).join('')}</tbody></table></div>`;
        }

        function componentEmbeddingPanel(analysis) {
            const component = activeComponent(analysis);
            if (!component.text) return '';
            const projection = state.data.manualProjection;
            if (!projection) return loadingPanel('Loading the frozen four-cluster embedding for this component…');
            const method = selectedProjectionMethod();
            const point = projectedComponentPoint(component, method) || [];
            const coordinates = component.categoryCoordinates4D || [];
            const metrics = (method || {}).metrics || {};
            return `${panel(`<div style="display:flex;justify-content:space-between;gap:9px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Selected component inside the saved four-cluster embedding</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">All background points are the frozen outcome-blind span atlas. The large outlined point is this exact component, projected from its stored whitened 4D coordinates with the same saved plane.</div></div><div style="display:flex;gap:4px;flex-wrap:wrap">${(projection.methods || []).map(row => button(row.label || row.id, `data-pl-method="${esc(row.id)}"`, row.id === (method || {}).id)).join('')}</div></div><div style="display:grid;grid-template-columns:minmax(0,1.45fr) minmax(260px,.55fr);gap:10px;margin-top:7px"><div><canvas data-pl-canvas="component-map" style="display:block;width:100%;height:390px"></canvas><div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;font-size:8px;margin-top:4px">${[0, 1, 2, 3].map(category => `<span style="color:${colorForCluster(category)}">● cluster ${category}</span>`).join('')}<span style="color:${C.text}">◎ selected component</span></div></div><div style="border-left:1px solid ${C.border};padding-left:9px"><div style="font-size:8px;color:${colorForCluster(component.category)};font-weight:900">COMPONENT ${Number(component.index || 0) + 1} · ASSIGNED C${component.category}</div><div style="font-size:13px;color:${C.text};font-weight:900;line-height:1.4;margin:3px 0 7px">${esc(component.text)}</div>${categoryProbabilityBars(component)}<div style="font-size:8px;color:${C.dim};line-height:1.6;margin-top:8px"><b style="color:${C.text}">Saved plane:</b> ${esc((method || {}).label || (method || {}).id || '')}<br><b style="color:${C.text}">Point:</b> x ${fmt(point[0], 5)} · y ${fmt(point[1], 5)}<br><b style="color:${C.text}">Whitened 4D:</b> [${coordinates.map(value => fmt(value, 4)).join(', ')}]<br><b style="color:${C.text}">Worst-pair separation:</b> ${fmt(metrics.worstPairSeparation, 3)}<br><b style="color:${C.text}">Balanced centroid agreement:</b> ${pct(Number(metrics.balancedNearestCentroidAgreement || 0) * 100)}<br><b style="color:${C.text}">Silhouette:</b> ${fmt(metrics.silhouetteSampled, 3)}</div><div style="font-size:7px;color:${C.mute};line-height:1.5;margin-top:7px">Click any atlas point to compare its exact stored phrase without leaving this analysis.</div></div></div>`, 'margin-top:8px')}${state.savedPoint == null ? '' : savedPointDetail()}`;
        }

        function componentResponseRows(component) {
            const measurements = component.measurements || {};
            if (Array.isArray(measurements.forward)) return measurements.forward;
            return Object.entries(measurements).map(([lag, value]) => ({
                lagSeconds: Number(lag),
                windowStartSeconds: (value || {}).windowStartSeconds,
                windowEndSeconds: (value || {}).windowEndSeconds,
                measuredWithinRiskSet: !!value,
                entry_indexed: value ? {
                    slopePercentPerSecond: value.slopePercentagePointsPerSecond,
                    dropPercentagePoints: value.deltaPercentagePoints,
                } : {},
            })).sort((left, right) => left.lagSeconds - right.lagSeconds);
        }

        function componentMeasurementPanel(analysis) {
            const component = activeComponent(analysis);
            if (!component.text) return '';
            const timeline = component.timelineAttribution || {};
            const rows = componentResponseRows(component);
            const context = component.viewerContext || {};
            const plane = component.outcomePlane || {};
            const slope = numeric(plane.predictedRetentionSlopePercentagePointsPerSecond) == null
                ? plane.oofPredictedSlopePercentagePointsPerSecond
                : plane.predictedRetentionSlopePercentagePointsPerSecond;
            const observed = numeric(plane.observedSlopePercentagePointsPerSecond) == null
                ? (((rows.find(row => Number(row.lagSeconds) === 0) || {}).entry_indexed || {}).slopePercentPerSecond)
                : plane.observedSlopePercentagePointsPerSecond;
            return panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Component evidence, viewer context, and response timing</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">The context state contains only components delivered earlier. Saved rows expose measured forward offsets; typed rows apply the frozen category-specific context model.</div></div><div style="font-size:8px;color:${C.amber};max-width:430px;text-align:right">${esc(plane.claimBoundary || 'observational response association; not a randomized rewrite effect')}</div></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:7px">${stat('timeline movement', timeline.predictedDeltaPoints == null ? '—' : `${signed(timeline.predictedDeltaPoints, 2)} pp`, C.cyan, 'promoted full-stage curve')}${stat('context-model slope', slope == null ? '—' : `${signed(slope, 3)} pp/s`, C.purple, 'source-grouped category plane')}${stat('observed slope', observed == null ? 'unobserved' : `${signed(observed, 3)} pp/s`, C.green, 'saved source only')}${stat('cluster-plane x', plane.xPercentile == null ? fmt(plane.x, 3) : `${fmt(plane.xPercentile, 1)}th`, colorForCluster(component.category), 'higher predicts less drop')}</div><div style="display:grid;grid-template-columns:minmax(260px,.85fr) minmax(0,1.15fr);gap:9px;margin-top:8px"><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.65"><b style="color:${C.text}">Exact phrase:</b> ${esc(component.text)}<br><b style="color:${C.text}">Tokens:</b> ${component.startToken == null ? component.start : component.startToken}–${component.endToken == null ? component.end : component.endToken}<br><b style="color:${C.text}">Spoken interval:</b> ${fmt(component.spokenStartSeconds, 3)}–${fmt(component.spokenEndSeconds, 3)}s<br><b style="color:${C.text}">Boundary evidence complete:</b> ${fmt(component.boundaryEvidenceAvailableSeconds, 3)}s<br><b style="color:${C.text}">Prior transition:</b> ${esc(context.transition || `START→C${component.category}`)}<br><b style="color:${C.text}">Earlier components:</b> ${Number(context.componentsPreviouslyDelivered || 0)}<br><b style="color:${C.text}">Prior category mix:</b> ${(context.categoryDistributionBefore || [0, 0, 0, 0]).map((value, category) => `C${category} ${pct(Number(value) * 100)}`).join(' · ')}<br><b style="color:${C.text}">Predecessor similarity:</b> ${fmt(context.predecessorSemanticSimilarity, 4)}<br><b style="color:${C.text}">History similarity / change:</b> ${fmt(context.historySemanticSimilarity, 4)} / ${fmt(context.historySemanticChange, 4)}<br><b style="color:${C.text}">Outcome plane:</b> x ${fmt(plane.x, 4)} · y ${fmt(plane.y, 4)}</div><div>${rows.length ? `<canvas data-pl-canvas="component-response" style="display:block;width:100%;height:230px"></canvas>` : `<div style="min-height:180px;border:1px dashed ${C.border};display:flex;align-items:center;justify-content:center;padding:20px;color:${C.mute};font-size:8px;text-align:center">${esc(component.measurementStatus || 'Typed text has no observed audience-retention response; the frozen prediction remains shown above.')}</div>`}</div></div>${rows.length ? `<div style="overflow:auto;max-height:250px;margin-top:7px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['forward offset', 'response window', 'risk-set eligible', 'entry-indexed slope', 'entry-indexed delta'].map(value => `<th style="text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${rows.map(row => { const entry = row.entry_indexed || {}; const eligible = row.measuredWithinRiskSet !== false && numeric(entry.slopePercentPerSecond) != null; return `<tr><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.cyan}">+${fmt(row.lagSeconds, 0)}s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${fmt(row.windowStartSeconds, 2)}–${fmt(row.windowEndSeconds, 2)}s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${eligible ? C.green : C.red}">${eligible ? 'yes' : 'no'}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(entry.slopePercentPerSecond, 3)} pp/s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(entry.dropPercentagePoints, 3)} pp</td></tr>`; }).join('')}</tbody></table></div>` : ''}`, 'margin-top:8px');
        }

        function activeComponentNode(analysis, lattice) {
            const component = activeComponent(analysis);
            const nodes = (lattice || {}).nodes || [];
            const nodeId = component.nodeId || `span:${component.startToken}:${component.endToken}`;
            return nodes.find(row => row.id === nodeId) || {};
        }

        function evidenceValue(value) {
            if (typeof value === 'number') return fmt(value, 6);
            if (Array.isArray(value)) return `[${value.map(item => typeof item === 'number' ? fmt(item, 6) : String(item)).join(', ')}]`;
            if (value && typeof value === 'object') return JSON.stringify(value);
            return String(value == null ? '—' : value);
        }

        function componentRawEvidencePanel(analysis, lattice) {
            const component = activeComponent(analysis);
            if (!component.text) return '';
            const node = activeComponentNode(analysis, lattice);
            const representations = component.representations || node.representations || {};
            const relations = component.relations || node.relations || {};
            const coordinates = component.coordinates || node.coordinates || {};
            const measurements = component.measurements || {};
            return panel(`<details><summary style="cursor:pointer;font-size:9px;color:${C.cyan};font-weight:900">All stored component formulas, relations, coordinates, and evidence fields</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:7px;margin-top:8px"><div style="background:${C.card2};padding:8px"><div style="font-size:8px;color:${C.text};font-weight:900;margin-bottom:4px">Representation formulas and hashes</div>${Object.entries(representations).map(([name, value]) => `<div style="font-size:7.5px;color:${C.dim};line-height:1.5;border-bottom:1px solid ${C.border};padding:3px 0;overflow-wrap:anywhere"><b style="color:${C.text}">${esc(name)}</b><br>${esc((value || {}).formula || '')}${(value || {}).norm == null ? '' : ` · norm ${fmt(value.norm, 5)}`}${(value || {}).degenerate ? ' · degenerate' : ''}${(value || {}).vectorHash ? `<br>vector hash ${esc(value.vectorHash)}` : ''}</div>`).join('') || `<span style="font-size:8px;color:${C.mute}">No stored representation formulas.</span>`}</div><div style="background:${C.card2};padding:8px"><div style="font-size:8px;color:${C.text};font-weight:900;margin-bottom:4px">Semantic/context relations</div>${Object.entries(relations).map(([name, value]) => `<div style="display:flex;justify-content:space-between;gap:6px;font-size:7.5px;color:${C.dim};border-bottom:1px solid ${C.border};padding:3px 0"><span>${esc(name)}</span><b style="color:${C.text};text-align:right;overflow-wrap:anywhere">${esc(evidenceValue(value))}</b></div>`).join('') || `<span style="font-size:8px;color:${C.mute}">No stored component relations.</span>`}<div style="font-size:8px;color:${C.text};font-weight:900;margin:8px 0 4px">All stored 4D coordinates</div>${Object.entries(coordinates).map(([name, value]) => `<div style="display:flex;justify-content:space-between;gap:6px;font-size:7.5px;color:${C.dim};border-bottom:1px solid ${C.border};padding:3px 0"><span>${esc(name)}</span><b style="color:${C.text};text-align:right">${esc(evidenceValue(value))}</b></div>`).join('') || `<span style="font-size:8px;color:${C.mute}">Canonical raw coordinates are shown in the saved-map panel.</span>`}</div><div style="background:${C.card2};padding:8px;font-size:7.5px;color:${C.dim};line-height:1.55"><div style="font-size:8px;color:${C.text};font-weight:900;margin-bottom:4px">Measurement, category, and lattice contracts</div><b style="color:${C.text}">Node ID:</b> ${esc(component.nodeId || node.id || '—')}<br><b style="color:${C.text}">Candidate status:</b> ${esc(node.candidateStatus || 'selected exact-cover component')}<br><b style="color:${C.text}">Resolutions:</b> ${(node.resolutions || []).map(esc).join(', ') || 'canonical'}<br><b style="color:${C.text}">Rejection reasons:</b> ${(node.rejectionReasons || []).map(esc).join(', ') || 'none'}<br><b style="color:${C.text}">Timing source:</b> ${esc(node.timingSource || 'supplied typed duration')}<br><b style="color:${C.text}">Primary response family:</b> ${esc(measurements.primaryFamily || 'entry_indexed')}<br><b style="color:${C.text}">Selection policy:</b> ${esc(measurements.selectionPolicy || component.measurementStatus || 'No observed response measurement is available for typed text.')}<br><b style="color:${C.text}">Acoustic start boundary:</b> ${(node.spokenStartBoundaryAcoustic == null ? component.startBoundaryAcoustic : node.spokenStartBoundaryAcoustic) == null ? 'not supplied' : (node.spokenStartBoundaryAcoustic == null ? component.startBoundaryAcoustic : node.spokenStartBoundaryAcoustic) ? 'supported' : 'estimated'}<br><b style="color:${C.text}">Acoustic end boundary:</b> ${(node.spokenEndBoundaryAcoustic == null ? component.endBoundaryAcoustic : node.spokenEndBoundaryAcoustic) == null ? 'not supplied' : (node.spokenEndBoundaryAcoustic == null ? component.endBoundaryAcoustic : node.spokenEndBoundaryAcoustic) ? 'supported' : 'estimated'}</div></div></details>`, 'margin-top:8px');
        }

        function componentPanel(analysis, lattice) {
            const components = analysis.components || [];
            if (!components.length && ((analysis.support || {}).diagnosticComponentsAvailable === false)) {
                return panel(`<div style="font-size:11px;color:${C.amber};font-weight:900">Semantic component diagnostics unavailable</div><div style="font-size:8px;color:${C.mute};line-height:1.55;margin-top:3px">No public timestamped transcript was recoverable for this video. The graph above is still the exact frozen selected baseline, which is the production stage, but no words or four-cluster components are invented.</div>`, 'margin-top:10px');
            }
            const selected = activeComponent(analysis);
            return `${panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><div style="font-size:11px;color:${C.text};font-weight:900">${components.length} non-overlapping components · every phrase and value exposed</div><div style="font-size:8px;color:${C.mute};margin:2px 0 7px">Four is the category vocabulary, not the component count. Every analyzed token belongs to exactly one selected component; overlapping lattice spans below are candidates only.</div></div><div style="font-size:8px;color:${C.cyan};font-weight:900">SELECT A COMPONENT</div></div>${tokenStrip(analysis)}${componentLedgerTable(analysis)}`, 'margin-top:10px')}
            ${selected.text ? componentEmbeddingPanel(analysis) : ''}${selected.text ? componentMeasurementPanel(analysis) : ''}${selected.text ? componentRawEvidencePanel(analysis, lattice) : ''}`;
        }

        function outcomePlanesPanel(analysis) {
            const study = contextStudy();
            const categories = study.categories || [];
            if (!categories.length) return loadingPanel('Loading the four frozen category outcome planes…');
            const selected = activeComponent(analysis);
            const chosen = state.outcomePoint;
            const lags = study.testedForwardLagsSeconds || [0];
            return panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Four category-specific retention-response planes at every tested processing lag</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">Choose +0 through +5 seconds. Each view refits the category-conditional response direction to retention measured after that forward delay. X and Y are descriptive full-cohort coordinates, not OOF validation coordinates; point predictions are OOF and color is observed slope.</div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${lags.map(lag => button(`+${lag}s`, `data-pl-outcome-lag="${lag}"`, Number(state.outcomeLag) === Number(lag))).join('')}</div></div><div style="max-width:440px;text-align:right;font-size:7.5px;color:${C.amber};line-height:1.5">${esc(study.claimBoundary || '')}</div></div><div style="display:grid;grid-template-columns:repeat(2,minmax(300px,1fr));gap:8px;margin-top:8px">${categories.map(category => {
                const experiment = (category.lagExperiments || []).find(row => Number(row.lagSeconds) === Number(state.outcomeLag) && row.status === 'complete') || {};
                const plane = experiment.outcomePlane || ((category.outcomePlanesByLag || {})[String(state.outcomeLag)]) || {};
                const gain = ((experiment.nestedRandomFoldMAEGain || {}).semanticToViewerContext);
                const selectedHere = Number(selected.category) === Number(category.category);
                const selectedPlane = ((selected.outcomePlanesByLag || {})[String(state.outcomeLag)]) || (Number(state.outcomeLag) === Number(study.primaryLagSeconds || 0) ? selected.outcomePlane : {}) || {};
                return `<div style="background:${C.card2};border-top:3px solid ${colorForCluster(category.category)};padding:8px;min-width:0"><div style="display:flex;justify-content:space-between;gap:6px"><b style="font-size:9px;color:${colorForCluster(category.category)}">CLUSTER ${category.category} · RESPONSE +${state.outcomeLag}s</b><span style="font-size:7px;color:${C.mute}">${Number(experiment.rows || 0).toLocaleString()} windows / ${experiment.sourceVideos || '—'} sources · context MAE gain ${gain == null ? '—' : signed(gain, 3) + ' pp'}</span></div><canvas data-pl-canvas="outcome-plane" data-pl-category="${category.category}" data-pl-lag="${state.outcomeLag}" style="display:block;width:100%;height:270px;margin-top:4px"></canvas><div style="font-size:7px;color:${C.dim};line-height:1.45;margin-top:4px">x: ${esc(plane.xAxis || '')}<br>y: ${esc(plane.yAxis || '')}${selectedHere ? `<br><b style="color:${C.text}">selected component:</b> x ${fmt(selectedPlane.x, 4)} · y ${fmt(selectedPlane.y, 4)} · predicted ${signed(selectedPlane.predictedRetentionSlopePercentagePointsPerSecond, 3)} pp/s` : ''}</div></div>`;
            }).join('')}</div>${chosen ? `<div style="margin-top:8px;background:${C.card2};border-left:3px solid ${colorForCluster(chosen.category)};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${colorForCluster(chosen.category)}">CLUSTER ${chosen.category} · RESPONSE +${state.outcomeLag}s · ${esc(chosen.videoId || '')} · COMPONENT ${Number(chosen.componentIndex || 0) + 1}</b><br><span style="color:${C.text};font-size:10px;font-weight:900">${esc(chosen.text || '')}</span><br>x ${fmt(chosen.x, 4)} · y ${fmt(chosen.y, 4)} · observed ${signed(chosen.observedSlopePercentagePointsPerSecond, 3)} pp/s · OOF predicted ${signed(chosen.oofPredictedSlopePercentagePointsPerSecond, 3)} pp/s</div>` : ''}`, 'margin-top:10px');
        }

        function availableRiskRows(analysis) {
            const local = analysis.supportBySecond || ((analysis.support || {}).riskSetBySecond) || [];
            const global = (openingSummary() || {}).riskSetBySecond || [];
            return local.length ? local : global;
        }

        function riskSetPanel(analysis) {
            const rows = availableRiskRows(analysis).filter(row => numeric(row.second) != null);
            if (!rows.length) return '';
            const support = analysis.support || {};
            const input = analysis.input || {};
            const summarySupport = (openingSummary() || {}).support || {};
            const semanticMinimum = Number(summarySupport.minimumModelSources || 10);
            const chronologicalMinimum = Number(summarySupport.minimumChronologicalSources || 40);
            const forecastEnd = numeric(analysis.forecastHorizonSeconds) == null
                ? numeric((analysis.outputs || {}).forecastEndSeconds) : numeric(analysis.forecastHorizonSeconds);
            const endpoint = [...rows].reverse().find(row => forecastEnd == null || Number(row.second) <= forecastEnd + 1e-6) || {};
            const timingLabel = input.timingSource || ((support.timingContract || {}).contract) || 'source-media word intervals';
            const supportTier = support.supportTierAtForecastEnd || endpoint.supportTier || '—';
            return panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Duration-conditioned risk set and timing support</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">A source contributes at second t only while its measured video, transcript timing, and retention curve cover t. Missing future retention is never padded or imputed.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('forecast endpoint', `${fmt(forecastEnd, 1)}s`, C.cyan, `${endpoint.riskSetSources || support.riskSetSourcesAtForecastEnd || '—'} sources at risk`)}${stat('support tier', supportTier, C.purple, support.forecastStopReason || 'duration-conditioned model support')}${stat('individualized minimum', semanticMinimum, C.purple, 'below this: no text-specific candidate')}${stat('chronological minimum', chronologicalMinimum, C.amber, 'below this: no past-to-future claim')}${stat('timing source', input.timingEstimated ? 'estimated' : 'measured', input.timingEstimated ? C.amber : C.green, timingLabel)}</div></div><canvas data-pl-canvas="risk-set" style="display:block;width:100%;height:260px;margin-top:7px"></canvas><div style="font-size:7.5px;color:${C.dim};line-height:1.5;margin-top:5px">Purple line: individualized-model minimum (${semanticMinimum}). Amber line: chronological-validation minimum (${chronologicalMinimum}). The vertical marker is this opening's final supported forecast point; the structural component cover can continue beyond it.</div>`, 'margin-top:10px');
        }

        function sequenceContextPanel(analysis) {
            const study = contextStudy();
            const categories = study.categories || [];
            const swaps = ((analysis.orderSensitivity || {}).swaps || []);
            if (!categories.length && !swaps.length) return '';
            const rows = categories.flatMap(category => (category.lagExperiments || []).map(experiment => ({
                category: category.category,
                experiment,
            })));
            const order = analysis.orderSensitivity || {};
            return panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Viewer-held context, order, and processing-lag experiments</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">Context is the information already delivered inside this opening: predecessor, category history, semantic similarity, and semantic change. No external idea prompt is used.</div></div><div style="max-width:470px;text-align:right;font-size:7.5px;color:${C.amber};line-height:1.5">${esc(study.claimBoundary || order.claimBoundary || 'Observed ordering associations and synthetic model sensitivities are not randomized causal effects.')}</div></div>${rows.length ? `<div style="overflow:auto;max-height:330px;margin-top:8px"><table style="width:100%;min-width:1120px;border-collapse:collapse;font-size:8px"><thead><tr>${['cluster', 'forward lag', 'rows / sources', 'timing → semantic random gain', 'context random gain', 'context forward gain', 'within-source context shuffle', 'replication'].map(value => `<th style="position:sticky;top:0;background:${C.card};text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${rows.map(({ category, experiment }) => { const gain = experiment.nestedRandomFoldMAEGain || {}; const forwardGain = experiment.nestedChronologicalMAEGain || {}; const permutation = experiment.historyPermutationNull || {}; const replicated = Boolean(experiment.incrementalViewerContextReplicated); return `<tr><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${colorForCluster(category)};font-weight:900">C${category}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">+${fmt(experiment.lagSeconds, 0)}s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${experiment.rows || 0} / ${experiment.sourceVideos || '—'}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(gain.timingToSemantic, 3)} pp/s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${numeric(gain.semanticToViewerContext) > 0 ? C.green : C.red}">${signed(gain.semanticToViewerContext, 3)} pp/s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${numeric(forwardGain.semanticToViewerContext) > 0 ? C.green : C.red}">${signed(forwardGain.semanticToViewerContext, 3)} pp/s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${permutation.repeats ? `observed ${signed(permutation.observedMAEGainPercentagePointsPerSecond, 3)} · null p95 ${signed(permutation.nullP95MAEGainPercentagePointsPerSecond, 3)} · raw p ${fmt(permutation.oneSidedP, 3)}` : 'unavailable'}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${replicated ? C.green : C.amber};font-weight:900">${replicated ? 'random + forward positive' : 'not replicated'}</td></tr>`; }).join('')}</tbody></table></div>` : ''}${swaps.length ? `<div style="margin-top:9px"><div style="font-size:9px;color:${C.text};font-weight:900">Adjacent-order model sensitivity for this opening</div><div style="font-size:7.5px;color:${C.mute};margin-top:2px">Each row swaps two adjacent components, recomputes all prior-history features, and reports model movement. It does not claim the edited video would causally produce that movement.</div><div style="overflow:auto;max-height:250px;margin-top:5px"><table style="width:100%;min-width:760px;border-collapse:collapse;font-size:8px"><thead><tr>${['components', 'original order', 'swapped order', 'predicted retained change'].map(value => `<th style="text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${swaps.map(row => `<tr><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${row.leftComponentIndex + 1} ↔ ${row.rightComponentIndex + 1}</td><td style="text-align:left;padding:4px;border-bottom:1px solid ${C.border};max-width:360px">${esc((row.originalOrder || []).join(' → '))}</td><td style="text-align:left;padding:4px;border-bottom:1px solid ${C.border};max-width:360px">${esc((row.swappedOrder || []).join(' → '))}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${numeric(row.predictedRetentionDeltaChangePoints) >= 0 ? C.green : C.red};font-weight:900">${signed(row.predictedRetentionDeltaChangePoints, 3)} pp</td></tr>`).join('')}</tbody></table></div></div>` : `<div style="font-size:8px;color:${C.mute};margin-top:8px">No adjacent swap is available for this sequence.</div>`}`, 'margin-top:10px');
        }

        function relationshipPanel(analysis) {
            const rows = analysis.relationships || [];
            if (!rows.length) return '';
            const modern = rows.some(row => row.type === 'next' || row.source != null);
            if (modern) return panel(`<div style="font-size:11px;color:${C.text};font-weight:900;margin-bottom:5px">Sequence relationships supplied to the predeclared candidate</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-bottom:6px">These directed adjacent edges feed the relationship candidate. The candidate uses the transition matrix and accumulated prior context jointly; the global promotion gate decides whether it may affect the served curve, and no per-edge causal effect is invented.</div><div style="overflow:auto;max-height:280px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['edge', 'transition', 'predecessor semantic similarity', 'future used', 'model role'].map(value => `<th style="text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${esc(row.source || '')} → ${esc(row.target || '')}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${colorForCluster(Number(String(row.transition || '').split('->').pop()))}">${esc(row.transition || '')}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${fmt(row.semanticSimilarity, 4)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.green}">no</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.amber}">candidate jointly</td></tr>`).join('')}</tbody></table></div>`, 'margin-top:10px');
            return panel(`<div style="font-size:11px;color:${C.text};font-weight:900;margin-bottom:5px">Legacy relationship diagnostics</div><div style="overflow:auto;max-height:280px"><table style="width:100%;border-collapse:collapse;font-size:8px"><tbody>${rows.map(row => `<tr><td style="padding:4px;border-bottom:1px solid ${C.border}">${row.left + 1} → ${row.right + 1}</td><td style="padding:4px;border-bottom:1px solid ${C.border}">${row.leftCategory} → ${row.rightCategory}</td></tr>`).join('')}</tbody></table></div>`, 'margin-top:10px');
        }

        function latticeInspector(lattice) {
            if (!lattice) return '';
            const nodes = lattice.nodes || [];
            let node = state.selectedLatticeNode
                ? nodes.find(row => row.id === state.selectedLatticeNode) : null;
            if (!node) {
                const analysis = activeAnalysis().prediction || {};
                const component = (analysis.components || [])[state.selectedComponent];
                if (component) node = nodes.find(row => row.id === (component.nodeId || `span:${component.startToken}:${component.endToken}`));
            }
            const canonical = new Set(((lattice.partitionContract || {}).canonicalComponentNodeIds) || []);
            const edgeCounts = lattice.edgeCounts || {};
            const incident = node ? (lattice.edges || []).filter(edge => edge.source === node.id || edge.target === node.id) : [];
            return panel(`<div style="display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.55fr);gap:10px"><div><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Multi-resolution component lattice and edge graph</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">${Number(lattice.spanCount || nodes.length).toLocaleString()} contiguous candidate spans and ${Number((lattice.edges || []).length).toLocaleString()} stored edges. Filled rings are the ${canonical.size} selected exact-cover components; other points are candidates, never independent votes.</div></div><div style="font-size:8px;color:${C.cyan};font-weight:900">CLICK A POINT</div></div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${Object.keys(edgeCounts).map(type => button(`${type} · ${Number(edgeCounts[type]).toLocaleString()}`, `data-pl-lattice-edge="${esc(type)}"`, state.latticeEdgeType === type)).join('')}</div><canvas data-pl-canvas="lattice" style="display:block;width:100%;height:380px;margin-top:5px"></canvas><div style="font-size:7px;color:${C.mute};margin-top:3px">The selected edge family is drawn in full. Switch families to inspect every stored graph relation without collapsing them into one unreadable layer.</div></div><div style="border-left:1px solid ${C.border};padding-left:9px">${node ? `<div style="font-size:8px;color:${colorForCluster(node.category)};font-weight:900">${esc(node.id)} · CLUSTER ${node.category} · ${canonical.has(node.id) ? 'SELECTED COVER' : 'CANDIDATE'}</div><div style="font-size:13px;color:${C.text};font-weight:900;line-height:1.4;margin-top:4px">${esc(node.text)}</div>${categoryProbabilityBars(node)}<div style="font-size:8px;color:${C.dim};line-height:1.55;margin-top:6px"><b style="color:${C.text}">Tokens:</b> ${node.start}–${node.end} · ${fmt(node.spokenStartSeconds, 3)}–${fmt(node.spokenEndSeconds, 3)}s<br><b style="color:${C.text}">Resolutions:</b> ${(node.resolutions || []).map(esc).join(', ')}<br><b style="color:${C.text}">Raw map:</b> [${(((node.maps || {}).raw) || []).map(value => fmt(value, 4)).join(', ')}]<br><b style="color:${C.text}">Context map:</b> [${(((node.maps || {}).context) || []).map(value => fmt(value, 4)).join(', ')}]<br><b style="color:${C.text}">Influence map:</b> [${(((node.maps || {}).influence) || []).map(value => fmt(value, 4)).join(', ')}]<br><b style="color:${C.text}">Context change:</b> ${fmt(((node.descriptiveAttention || {}).contextChangePercentileWithinHook), 1)}th<br><b style="color:${C.text}">Semantic centrality:</b> ${fmt(((node.descriptiveAttention || {}).semanticCentralityPercentileWithinHook), 1)}th<br><b style="color:${C.text}">Incident edges:</b> ${incident.length}</div><div style="overflow:auto;max-height:190px;margin-top:6px;font-size:7px;color:${C.dim}">${incident.slice(0, 100).map(edge => `<div style="border-bottom:1px solid ${C.border};padding:3px 0"><b style="color:${C.text}">${esc(edge.type)}</b> ${esc(edge.source)} → ${esc(edge.target)}${edge.cosine == null ? '' : ` · cosine ${fmt(edge.cosine, 3)}`}</div>`).join('')}${incident.length > 100 ? `<div style="padding:4px;color:${C.amber}">${incident.length - 100} more incident edges remain visible on the graph.</div>` : ''}</div><div style="font-size:7px;color:${C.mute};line-height:1.5;margin-top:7px">Attention-like values and graph edges are descriptive unless separately promoted out of fold. They do not silently change the headline prediction.</div>` : `<div style="font-size:9px;color:${C.mute}">Select a lattice point.</div>`}</div></div>`, 'margin-top:10px');
        }

        function prefixTracePanel(analysis) {
            const endpoint = numeric(analysis.forecastHorizonSeconds) == null
                ? Number(analysis.analysisHorizonSeconds || Infinity) : Number(analysis.forecastHorizonSeconds);
            const rows = (analysis.causalPrefixTrace || []).filter(row => Number(row.second) <= endpoint + 1e-6);
            if (!rows.length) return '';
            const input = analysis.input || {};
            const timing = input.timingSource || ((rows[0] || {}).timingSource) || 'source-media acoustic word ends';
            return panel(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Causal transcript prefixes used by the curve</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">Point t sees only the words listed on row t. No later word can influence an earlier prediction.</div></div><div style="font-size:7px;color:${input.timingEstimated ? C.amber : C.green};max-width:360px;text-align:right">${esc(timing)}${input.timingEstimated ? ' · estimated timing' : ' · measured/provided timing'}</div></div><div style="overflow:auto;max-height:390px;margin-top:7px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr><th style="position:sticky;top:0;background:${C.card};text-align:right;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">point</th><th style="position:sticky;top:0;background:${C.card};text-align:right;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">tokens seen</th><th style="position:sticky;top:0;background:${C.card};text-align:left;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">exact semantic input</th></tr></thead><tbody>${rows.map(row => `<tr><td style="text-align:right;vertical-align:top;padding:5px;border-bottom:1px solid ${C.border};color:${C.cyan};font-weight:900">${fmt(row.second, 0)}s</td><td style="text-align:right;vertical-align:top;padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${row.tokenCount}</td><td style="text-align:left;vertical-align:top;padding:5px;border-bottom:1px solid ${C.border};color:${C.text};line-height:1.45">${esc(row.prefixText || '')}</td></tr>`).join('')}</tbody></table></div>`, 'margin-top:10px');
        }

        function temporalAttributionPanel(analysis) {
            const attribution = analysis.temporalAttribution || {};
            const steps = attribution.steps || [];
            if (!steps.length && ((analysis.support || {}).diagnosticComponentsAvailable === false)) {
                return panel(`<div style="font-size:11px;color:${C.text};font-weight:900">Selected-stage movement ledger</div><div style="font-size:8px;color:${C.mute};line-height:1.55;margin-top:3px">The served curve is the duration-conditioned baseline at every point. Transcript-dependent timing, semantics, components, and relationships remain unavailable rather than being imputed.</div>`, 'margin-top:10px');
            }
            if (!steps.length) return errorPanel('This analysis artifact predates the shared temporal attribution ledger. Rebuild it before treating the curve as explainable.');
            const summary = attribution.summary || {};
            const selectedIndex = Math.min(Math.max(0, state.selectedAttributionStep), steps.length - 1);
            const selected = steps[selectedIndex] || {};
            const allocations = selected.enteredComponents || [];
            const totals = summary.totalChannelDeltaPoints || {};
            const selectedChannels = selected.channelDeltaPoints || {};
            const channelText = channels => `time ${signed(channels.timing, 2)} · semantic ${signed(channels.semantic, 2)} · components ${signed(channels.components, 2)} · relationships ${signed(channels.relationships, 2)}`;
            return panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Where every served prediction movement comes from</div><div style="font-size:8px;color:${C.mute};line-height:1.55;margin-top:2px">The ledger reconstructs the cyan headline exactly through the selected ${esc(attribution.selectedStage || 'baseline')} stage. Later candidate channels remain visible in the stage graph and validation table, but contribute zero to the served curve until promoted.</div></div><div style="font-size:7px;color:${C.amber};max-width:470px;text-align:right;line-height:1.5">${esc(attribution.claimBoundary || '')}</div></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:7px">${stat('served stage', attribution.selectedStage || 'baseline', C.cyan)}${stat('total predicted drop', `${signed(summary.totalPredictedDropPoints, 2)} pp`, C.cyan)}${stat('baseline movement', `${signed(totals.baseline == null ? summary.totalBaselineDeltaPoints : totals.baseline, 2)} pp`, C.faint)}${stat('timing movement', `${signed(totals.timing, 2)} pp`, C.amber)}${stat('semantic movement', `${signed(totals.semantic == null ? summary.totalSemanticShapeDeltaPoints : totals.semantic, 2)} pp`, C.purple)}${stat('component movement', `${signed(totals.components, 2)} pp`, C.accent)}${stat('relationship movement', `${signed(totals.relationships, 2)} pp`, C.green)}</div><canvas data-pl-canvas="attribution" style="display:block;width:100%;height:300px;margin-top:7px"></canvas><div style="display:grid;grid-template-columns:minmax(220px,.55fr) minmax(0,1.45fr);gap:9px;margin-top:8px"><div style="background:${C.card2};padding:8px"><div style="font-size:8px;color:${C.cyan};font-weight:900">SELECTED ${fmt(selected.startSeconds, 1)}–${fmt(selected.endSeconds, 1)}s</div><div style="font-size:13px;color:${C.text};font-weight:900;line-height:1.4;margin:3px 0">${esc(selected.enteredText || 'No newly completed words')}</div><div style="font-size:8px;color:${C.dim};line-height:1.6">start ${pct(selected.startRetentionPercent)}<br>baseline ${signed(selectedChannels.baseline == null ? selected.baselineDeltaPoints : selectedChannels.baseline, 2)} pp<br><span style="color:${C.amber}">timing ${signed(selectedChannels.timing, 2)} pp</span><br><span style="color:${C.purple}">semantics ${signed(selectedChannels.semantic, 2)} pp</span><br><span style="color:${C.accent}">components ${signed(selectedChannels.components, 2)} pp</span><br><span style="color:${C.green}">relationships ${signed(selectedChannels.relationships, 2)} pp</span><br><b style="color:${C.text}">predicted movement ${signed(selected.predictedDeltaPoints, 2)} pp</b><br>end ${pct(selected.endRetentionPercent)}${selected.observedDeltaPoints == null ? '' : `<br>observed movement ${signed(selected.observedDeltaPoints, 2)} pp`}<br>driver: ${esc(selected.driver || '')}</div></div><div style="background:${C.card2};padding:8px"><div style="font-size:8px;color:${C.text};font-weight:900;margin-bottom:5px">Entered component allocation</div>${allocations.length ? allocations.map(row => `<button data-pl-component="${row.componentIndex}" style="display:grid;grid-template-columns:minmax(160px,1fr) minmax(80px,.35fr) minmax(180px,.65fr);gap:5px;width:100%;border:1px solid ${C.border};border-left:4px solid ${colorForCluster(row.category)};background:${C.card};color:${C.text};padding:6px;text-align:left;cursor:pointer;margin-bottom:4px;font-size:8px"><span><b style="color:${colorForCluster(row.category)}">C${row.category} · component ${row.componentIndex + 1}</b><br>${esc(row.text)}</span><span>${row.overlapTokens} tokens<br>${pct(Number(row.weight || 0) * 100)} weight<br>model ${signed(row.predictedDeltaPoints, 2)} pp</span><span style="color:${C.dim}">${esc(channelText(row.channelDeltaPoints || {}))}</span></button>`).join('') : `<div style="font-size:8px;color:${C.mute}">No component entered during this transition. The same prefix is evaluated under the next independently fitted time model.</div>`}</div></div><div style="overflow:auto;max-height:360px;margin-top:8px"><table style="width:100%;min-width:1050px;border-collapse:collapse;font-size:8px"><thead><tr>${['interval', 'exact entered words', 'components', 'predicted Δ', 'baseline Δ', 'timing Δ', 'semantic Δ', 'component Δ', 'relationship Δ', 'observed Δ'].map(value => `<th style="position:sticky;top:0;background:${C.card};text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${steps.map((row, index) => { const channel = row.channelDeltaPoints || {}; return `<tr data-pl-attribution-step="${index}" style="cursor:pointer;background:${index === selectedIndex ? C.cyan + '12' : 'transparent'}"><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.cyan}">${fmt(row.startSeconds, 1)}–${fmt(row.endSeconds, 1)}s</td><td style="text-align:left;padding:4px;border-bottom:1px solid ${C.border};max-width:440px;color:${C.text}">${esc(row.enteredText || '— unchanged prefix —')}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${(row.enteredComponents || []).map(item => `<span style="color:${colorForCluster(item.category)}">C${item.category}.${item.componentIndex + 1}</span>`).join(' + ') || 'time only'}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};font-weight:900">${signed(row.predictedDeltaPoints, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(channel.baseline == null ? row.baselineDeltaPoints : channel.baseline, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.amber}">${signed(channel.timing, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.purple}">${signed(channel.semantic == null ? row.semanticShapeDeltaPoints : channel.semantic, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.accent}">${signed(channel.components, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.green}">${signed(channel.relationships, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.green}">${row.observedDeltaPoints == null ? '—' : signed(row.observedDeltaPoints, 2)}</td></tr>`; }).join('')}</tbody></table></div>`, 'margin-top:10px');
        }

        function validationPanel(analysis) {
            const validation = ((analysis.validation || {}).entryIndexed || {});
            const random = validation.randomFold || {};
            const chronological = validation.chronological || {};
            const inference = random.pairedSourceImprovementInference || random.pairedImprovementInference || {};
            const stageOrder = ['timing', 'semantic', 'components', 'relationships'];
            const stages = validation.stages || {};
            const promotion = validation.promotion || {};
            const candidateRandom = validation.candidateRandomFold || {};
            const candidateChronological = validation.candidateChronological || {};
            const randomMae = numeric(random.sourceEqualMAEPercentagePoints) == null ? random.heldoutMAEPercentagePoints : random.sourceEqualMAEPercentagePoints;
            const randomBaseline = numeric(random.sourceEqualBaselineMAEPercentagePoints) == null ? random.baselineMAEPercentagePoints : random.sourceEqualBaselineMAEPercentagePoints;
            const chronologicalMae = numeric(chronological.sourceEqualMAEPercentagePoints) == null ? chronological.heldoutMAEPercentagePoints : chronological.sourceEqualMAEPercentagePoints;
            const chronologicalBaseline = numeric(chronological.sourceEqualBaselineMAEPercentagePoints) == null ? chronological.baselineMAEPercentagePoints : chronological.sourceEqualBaselineMAEPercentagePoints;
            const candidateRandomGain = numeric(candidateRandom.sourceEqualMAEImprovementFraction);
            const candidateChronologicalGain = numeric(candidateChronological.sourceEqualMAEImprovementFraction);
            return panel(`<div style="display:flex;justify-content:space-between;gap:9px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Duration-conditioned out-of-fold validation and promotion decision</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">Each point is evaluated only while that video remains observable. The relationship model was declared before fitting. It becomes the headline only if both random source folds and past-to-future folds beat the at-risk mean with positive source-bootstrap lower bounds.</div><div style="font-size:7.5px;color:${C.amber};margin-top:5px">${esc(promotion.policy || '')}</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('served stage', promotion.selectedStage || 'baseline', promotion.promoted ? C.green : C.amber, promotion.promoted ? 'full candidate passed' : 'candidate withheld')}${stat('candidate random gain', candidateRandomGain == null ? '—' : signed(candidateRandomGain * 100, 2) + '%', promotion.randomGatePassed ? C.green : C.red, `MAE ${fmt(candidateRandom.sourceEqualMAEPercentagePoints, 3)} pp`)}${stat('candidate forward gain', candidateChronologicalGain == null ? '—' : signed(candidateChronologicalGain * 100, 2) + '%', promotion.chronologicalGatePassed ? C.green : C.red, `MAE ${fmt(candidateChronological.sourceEqualMAEPercentagePoints, 3)} pp`)}${stat('last evaluated second', `${fmt(candidateRandom.lastEvaluatedSecond || random.lastEvaluatedSecond, 0)}s`, C.cyan, `${Number(candidateRandom.evaluatedObservationCells || random.evaluatedObservationCells || 0).toLocaleString()} held-out source-second cells`)}</div></div><canvas data-pl-canvas="validation" style="display:block;width:100%;height:270px;margin-top:7px"></canvas>${Object.keys(stages).length ? `<div style="overflow:auto;margin-top:7px"><table style="width:100%;min-width:760px;border-collapse:collapse;font-size:8px"><thead><tr>${['fixed candidate stage', 'source-equal OOF MAE', 'mean baseline MAE', 'OOF improvement', 'evaluated seconds', 'role'].map(value => `<th style="text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${stageOrder.filter(name => stages[name]).map(name => { const row = stages[name] || {}; const candidate = name === (promotion.candidateStage || 'relationships'); return `<tr><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${candidate ? C.green : C.dim};font-weight:900">${esc(name)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${fmt(row.sourceEqualMAEPercentagePoints, 3)} pp</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${fmt(row.sourceEqualBaselineMAEPercentagePoints, 3)} pp</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(Number(row.sourceEqualMAEImprovementFraction || 0) * 100, 2)}%</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${row.evaluatedSeconds || 0}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${candidate ? C.green : C.mute}">${candidate ? (promotion.promoted ? 'predeclared candidate · promoted' : 'predeclared candidate · failed gate') : 'ablation only'}</td></tr>`; }).join('')}</tbody></table></div>` : ''}`, 'margin-top:10px');
        }

        function chronologicalStagePanel(analysis) {
            const validation = ((analysis.validation || {}).entryIndexed || {});
            const random = validation.stages || {};
            const chronological = validation.chronologicalStages || {};
            const promotion = validation.promotion || {};
            const order = ['timing', 'semantic', 'components', 'relationships'];
            if (!order.some(name => random[name] || chronological[name])) return '';
            return panel(`<div style="font-size:11px;color:${C.text};font-weight:900">Every fixed stage in random and chronological validation</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">The same four predeclared feature sets are shown side by side. These are source-equal duration-conditioned curve errors, not endpoint-only scores.</div><div style="overflow:auto;margin-top:7px"><table style="width:100%;min-width:940px;border-collapse:collapse;font-size:8px"><thead><tr>${['stage', 'random MAE', 'random baseline', 'random gain', 'forward MAE', 'forward baseline', 'forward gain', 'promotion role'].map(value => `<th style="text-align:right;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${order.map(name => { const left = random[name] || {}; const right = chronological[name] || {}; const candidate = name === (promotion.candidateStage || 'relationships'); return `<tr><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${candidate ? C.green : C.dim};font-weight:900">${name}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border}">${fmt(left.sourceEqualMAEPercentagePoints, 3)} pp</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border}">${fmt(left.sourceEqualBaselineMAEPercentagePoints, 3)} pp</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border}">${signed(Number(left.sourceEqualMAEImprovementFraction || 0) * 100, 2)}%</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border}">${fmt(right.sourceEqualMAEPercentagePoints, 3)} pp</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border}">${fmt(right.sourceEqualBaselineMAEPercentagePoints, 3)} pp</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border}">${signed(Number(right.sourceEqualMAEImprovementFraction || 0) * 100, 2)}%</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${candidate ? C.amber : C.mute}">${candidate ? (promotion.promoted ? 'candidate promoted' : 'candidate failed') : 'ablation'}</td></tr>`; }).join('')}</tbody></table></div>`, 'margin-top:10px');
        }

        function dataCoveragePanel(analysis, lattice) {
            const provenance = analysis.provenance || {};
            const support = analysis.support || {};
            const input = analysis.input || {};
            const edgeCounts = (lattice || {}).edgeCounts || ((lattice || {}).edges || []).reduce((counts, edge) => {
                counts[edge.type || 'unknown'] = (counts[edge.type || 'unknown'] || 0) + 1;
                return counts;
            }, {});
            const rows = [
                ['curve points', (((analysis.curves || {}).entryIndexed || {}).timesSeconds || []).length],
                ['causal prefixes', (analysis.causalPrefixTrace || []).length],
                ['temporal transitions', ((analysis.temporalAttribution || {}).steps || []).length],
                ['selected components', (analysis.components || []).length],
                ['canonical relationships', (analysis.relationships || []).length],
                ['lattice nodes', ((lattice || {}).nodes || []).length],
                ['lattice edges', ((lattice || {}).edges || []).length],
            ];
            const structural = numeric(support.structuralDurationSeconds) == null ? (support.fullObservedDurationSeconds || analysis.analysisHorizonSeconds) : support.structuralDurationSeconds;
            const forecast = support.servedForecastThroughSeconds || analysis.forecastHorizonSeconds;
            const work = support.streamingWork || analysis.streamingWork || ((analysis.partition || {}).work) || {};
            return panel(`<div style="font-size:11px;color:${C.text};font-weight:900">Analysis data ledger</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">This inventory makes omissions visible. Counts come from the same analysis object rendered above, not a parallel summary.</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:6px;margin-top:7px">${rows.map(row => `<div style="background:${C.card2};padding:7px"><div style="font-size:7px;color:${C.mute};text-transform:uppercase;font-weight:900">${esc(row[0])}</div><div style="font-size:17px;color:${C.text};font-weight:900">${Number(row[1] || 0).toLocaleString()}</div></div>`).join('')}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:7px;margin-top:8px"><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Graph edge families</b><br>${Object.entries(edgeCounts).map(([key, value]) => `${esc(key)} ${Number(value).toLocaleString()}`).join(' · ') || 'graph not loaded'}</div><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Structural versus predictive support</b><br>${fmt(structural, 2)}s and ${analysis.tokenCount || 0} tokens fully componentized<br>served retention emitted through ${fmt(forecast, 2)}s only; sequence-specific channels enter only after promotion</div><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Timing</b><br>${numeric(input.wordsPerSecond) == null ? 'saved source-media timestamps' : `${fmt(input.wordsPerSecond, 3)} words/second · ${fmt(input.estimatedSpokenSeconds, 3)}s estimated`}<br>${esc(input.timingSource || ((support.timingContract || {}).contract || 'measured source-media word intervals'))}</div><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Bounded streaming work</b><br>${Number(work.embeddingInputRequests || 0).toLocaleString()} embedding inputs · peak batch ${Number(work.peakEmbeddingBatchInputs || 0).toLocaleString()}<br>${Number(work.totalCandidateSpanRows || 0).toLocaleString()} candidate rows · no global all-span materialization</div><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Serving provenance</b><br>${Object.entries(provenance).filter(([, value]) => typeof value === 'boolean').map(([key, value]) => `${esc(key)}: <b style="color:${value ? C.green : C.amber}">${value ? 'yes' : 'no'}</b>`).join(' · ') || 'saved row: source-level out-of-fold prediction'}</div></div>`, 'margin-top:10px');
        }

        function renderAnalysis(analysis, lattice) {
            if (!analysis) return '';
            const source = analysis.sourceKind || '';
            const input = analysis.input || {};
            const structural = Number(analysis.analysisHorizonSeconds || input.structuralDurationSeconds || 0);
            const forecast = Number(analysis.forecastHorizonSeconds || (analysis.outputs || {}).forecastEndSeconds || 0);
            const unsupportedSuffix = structural > forecast + 1e-6;
            const diagnosticComponentsAvailable = ((analysis.support || {}).diagnosticComponentsAvailable !== false);
            const activeFamily = ((analysis.curves || {})[state.curveMode]) || {};
            const hasActualCurve = (activeFamily.actual || []).some(value => numeric(value) != null);
            const countCopy = diagnosticComponentsAvailable
                ? `${analysis.tokenCount || 0} tokens · ${analysis.componentCount || (analysis.components || []).length} components<br>${fmt(structural, 2)}s structurally analyzed · ${fmt(forecast, 2)}s retention forecast`
                : `transcript unavailable · semantic diagnostics withheld<br>${fmt(structural, 2)}s media duration · ${fmt(forecast, 2)}s baseline forecast`;
            const header = panel(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:260px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">${esc(source)}</div><div style="font-size:16px;color:${C.text};font-weight:900;line-height:1.35;margin-top:3px">${esc(analysis.title || input.analyzedText || analysis.text || 'Opening analysis')}</div>${analysis.title && analysis.text ? `<div style="font-size:8px;color:${C.dim};line-height:1.5;margin-top:3px">${esc(analysis.text)}</div>` : ''}</div><div style="font-size:8px;color:${C.mute};text-align:right">${countCopy}</div></div>${unsupportedSuffix ? `<div style="margin-top:7px;font-size:8px;color:${C.amber}">${diagnosticComponentsAvailable ? `The entire ${fmt(structural, 2)}s input is componentized. Retention stops at ${fmt(forecast, 2)}s because ${esc(((analysis.support || {}).forecastStopReason) || 'the next duration-conditioned model point is unsupported')}; no suffix value is fabricated.` : `The selected baseline is served through ${fmt(forecast, 2)}s. The remaining media duration is outside frozen support, and transcript-dependent diagnostics are unavailable; neither is fabricated.`}</div>` : ''}${headline(analysis)}`);
            const comparison = panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Frozen prediction beside measured retention</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Both panes use the same seconds and percentage scale. Entry-indexed starts each video at 100%; raw retention preserves looping and rewatch elevation. The full-resolution measured curve is joined only after inference.</div></div><div style="display:flex;gap:4px">${button('Normalized survival', 'data-pl-curve="entryIndexed"', state.curveMode === 'entryIndexed')}${button('Raw retention', 'data-pl-curve="observedAbsolute"', state.curveMode === 'observedAbsolute')}${button(state.showStages ? 'Hide stage ladder' : 'Show stage ladder', 'data-pl-toggle-stages', state.showStages)}</div></div><div style="display:grid;grid-template-columns:repeat(2,minmax(300px,1fr));gap:8px;margin-top:7px"><div style="background:${C.card2};padding:7px"><div style="font-size:8px;color:${C.cyan};font-weight:900">PREDICTED · FROZEN MODEL</div><canvas data-pl-canvas="retention-predicted" style="display:block;width:100%;height:300px;margin-top:3px"></canvas></div><div style="background:${C.card2};padding:7px"><div style="font-size:8px;color:${hasActualCurve ? C.green : C.amber};font-weight:900">${hasActualCurve ? 'ACTUAL · YOUTUBE RETENTION' : 'ACTUAL · UNOBSERVED FOR TYPED TEXT'}</div>${hasActualCurve ? `<canvas data-pl-canvas="retention-actual" style="display:block;width:100%;height:300px;margin-top:3px"></canvas>` : `<div style="height:300px;display:flex;align-items:center;justify-content:center;color:${C.mute};font-size:8px;text-align:center">No outcome is attached to typed text.</div>`}</div></div>${hasActualCurve ? `<div style="font-size:8px;color:${C.text};font-weight:900;margin-top:9px">SAME-AXIS OVERLAY · ERROR IS THE VERTICAL GAP</div><canvas data-pl-canvas="retention-overlay" style="display:block;width:100%;height:340px;margin-top:3px"></canvas>` : ''}`, 'margin-top:10px');
            if (!diagnosticComponentsAvailable) {
                return `<div data-pl-analysis>${header}${panel(`<div style="font-size:11px;color:${C.amber};font-weight:900">Duration-conditioned baseline only</div><div style="font-size:8px;color:${C.mute};line-height:1.6;margin-top:3px">No public timestamped spoken transcript was recovered. This video therefore receives only the frozen selected baseline through its supported media duration. No words, embeddings, four-cluster components, semantic effects, or sequence relationships are inferred. The actual retention curve remains outcome-only comparison data.</div>`, 'margin-top:10px')}${riskSetPanel(analysis)}${comparison}</div>`;
            }
            return `<div data-pl-analysis>${header}
            ${evidencePanel(analysis)}
            ${riskSetPanel(analysis)}
            ${comparison}
            ${temporalAttributionPanel(analysis)}
            ${prefixTracePanel(analysis)}
            ${panel(`<div style="font-size:11px;color:${C.text};font-weight:900">Applied and candidate endpoint channels</div><div style="font-size:8px;color:${C.mute};margin-top:2px">The waterfall shows all predeclared nested candidate movements. The served-stage label marks where the cyan headline stops; later bars are diagnostics until the global promotion gate passes.</div><canvas data-pl-canvas="contributions" style="display:block;width:100%;height:275px;margin-top:5px"></canvas>`, 'margin-top:10px')}
            ${componentPanel(analysis, lattice)}
            ${outcomePlanesPanel(analysis)}
            ${sequenceContextPanel(analysis)}
            ${panel(`<div style="font-size:11px;color:${C.text};font-weight:900">Attention-like relational and drop graph</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Canonical components are nodes and directed edges are the actual predecessor transitions supplied to the relationship candidate. Node size follows served-curve accounting. If the candidate is withheld, these edges remain visible evidence without silently changing the headline.</div><canvas data-pl-canvas="relationships" style="display:block;width:100%;height:290px;margin-top:5px"></canvas>`, 'margin-top:10px')}
            ${relationshipPanel(analysis)}
            ${Number(analysis.version || 0) < 3 ? latticeInspector(lattice) : ''}
            ${validationPanel(analysis)}
            ${chronologicalStagePanel(analysis)}
            ${dataCoveragePanel(analysis, lattice)}</div>`;
        }

        function renderScorer() {
            const result = state.scoreResult;
            return `<div><div style="font-size:15px;color:${C.text};font-weight:900">Score an opening</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">The exact same frozen component, context, and retention feature builder used by every saved opening. Any text length is fully componentized; retention is emitted only through the duration-conditioned risk set supported by the 208-video cohort.</div>
            ${panel(`<label style="display:block"><span style="display:block;font-size:8px;color:${C.mute};font-weight:900;margin-bottom:4px">OPENING OR LONGER SPOKEN SEQUENCE</span><textarea data-pl-score-text rows="7" placeholder="Type any spoken opening…" style="width:100%;box-sizing:border-box;resize:vertical;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:9px;font:10px/1.5 inherit">${esc(state.scoreText)}</textarea></label><div data-pl-score-controls style="display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:7px;align-items:end;margin-top:7px"><label><span style="display:block;font-size:8px;color:${C.mute};font-weight:900;margin-bottom:4px">PLANNED SPOKEN DURATION · OPTIONAL SECONDS</span><input data-pl-score-duration type="number" min="0.01" step="0.01" value="${esc(state.scoreDuration)}" placeholder="blank = measured mean speaking rate" style="width:100%;box-sizing:border-box;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:8px;font-size:9px"></label>${button(state.scoreLoading ? 'Scoring…' : 'Score opening', 'data-pl-score', true)}</div>`, 'margin-top:8px')}
            ${state.scoreError ? `<div style="margin-top:8px">${errorPanel(state.scoreError)}</div>` : ''}
            ${state.scoreLoading ? `<div style="margin-top:8px">${loadingPanel(state.scoreStatus || 'Scoring opening')}</div>` : ''}
            ${result ? `<div style="margin-top:10px">${renderAnalysis(result, result.componentLattice)}</div>` : ''}</div>`;
        }

        function scopedLibraryRows(summary) {
            const rows = summary.rows || [];
            if (state.scope === 'all' || state.scope === 'tyler') return rows;
            return rows.filter(row => String(row.accountId || '') === state.scope);
        }

        function scopeEvaluation(summary) {
            const evaluation = summary.evaluation || {};
            const group = state.scope === 'all'
                ? (evaluation.strictBlindExternal || evaluation.externalAccounts || evaluation.allPooled || null)
                : ((((evaluation.strictBlindByAccount || {})[state.scope])
                    || ((evaluation.byAccount || {})[state.scope])) || null);
            return group && (group.families || {})[state.curveMode] || group;
        }

        function confidenceText(interval, digits = 2) {
            return interval && numeric(interval.lower) != null && numeric(interval.upper) != null
                ? `95% CI ${fmt(interval.lower, digits)}–${fmt(interval.upper, digits)}`
                : '95% CI unavailable';
        }

        function sealedBlindPanel(summary) {
            if (state.scope !== 'all' || !summary.blindValidation) return '';
            const blind = summary.blindValidation;
            const audit = ((summary.evaluation || {}).blindIsolationAudit) || blind;
            const checks = [
                ['prediction input', blind.predictionInputsExcludeOutcomeFields === true, 'outcome fields excluded'],
                ['prediction seal', blind.outcomeFieldsPresentInBlindManifest === false, 'sealed before outcomes'],
                ['ID split', blind.externalHoldoutIdsDisjoint === true, 'development and external IDs disjoint'],
                ['model state', (summary.provenance || {}).modelStageChanged === false, 'no refit, recalibration, or promotion'],
            ];
            return `<div style="border-left:3px solid ${C.green};background:${C.card2};padding:8px;margin-top:8px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:9px;color:${C.green};font-weight:900">SEALED BLIND VALIDATION</div><div style="font-size:8px;color:${C.dim};line-height:1.5;margin-top:2px">Frozen predictions were written and hashed before measured retention was opened. The primary report uses unique external content only.</div></div><div style="font-size:7px;color:${C.mute};text-align:right;line-height:1.5">prediction manifest ${esc(String(blind.predictionManifestFingerprint || '').slice(0, 12))}<br>outcome manifest ${esc(String(blind.outcomeManifestFingerprint || '').slice(0, 12))}<br>blind generation ${esc(String(blind.blindGenerationId || '').slice(0, 12))}</div></div><div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:7px">${stat('sealed predictions', Number(blind.sealedPredictionCount || 0).toLocaleString(), C.text, `${Number(blind.developmentCohortVideos || 0).toLocaleString()} development · ${Number(blind.nonDevelopmentVideos || 0).toLocaleString()} non-development · ${Number(blind.accountExternalVideos || 0).toLocaleString()} account-external`)}${stat('strict blind videos', Number(audit.strictBlindUniqueVideos || 0).toLocaleString(), C.green, 'primary unique external cohort')}${stat('training overlap', Number(audit.trainingContentOverlapExcluded || 0).toLocaleString(), C.red, 'exact spoken-content matches excluded')}${stat('external reposts', Number(audit.externalDuplicateVideosCollapsed || 0).toLocaleString(), C.amber, `${Number(audit.externalDuplicateGroupsCollapsed || 0).toLocaleString()} exact-content groups collapsed`)}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:5px;margin-top:7px">${checks.map(([label, pass, detail]) => `<div style="border-top:1px solid ${C.border};padding-top:4px;font-size:7.5px;color:${pass ? C.green : C.red}"><b>${pass ? 'PASS' : 'FAIL'} · ${esc(label)}</b><div style="color:${C.mute};margin-top:1px">${esc(detail)}</div></div>`).join('')}</div></div>`;
        }

        function accountValidationTable(summary) {
            if (state.scope !== 'all') return '';
            const evaluation = summary.evaluation || {};
            const balanced = ((evaluation.strictBlindAccountBalanced || {}).families || {})[state.curveMode] || {};
            const accounts = balanced.accounts || [];
            if (!accounts.length) return '';
            const names = Object.fromEntries((summary.accounts || []).map(account => [String(account.id), account.name || account.id]));
            return `<div style="background:${C.card2};padding:7px;margin-top:8px;overflow:auto"><div style="font-size:8px;color:${C.text};font-weight:900">ACCOUNT-BY-ACCOUNT BLIND TRANSPORT</div><div style="font-size:7px;color:${C.mute};line-height:1.45;margin-top:2px">Macro curve MAE ${fmt(balanced.macroSourceEqualCurveMAEPercentagePoints, 2)} pp · worst account ${fmt(balanced.worstAccountCurveMAEPercentagePoints, 2)} pp. Account rows are never pooled away.</div><table style="width:100%;border-collapse:collapse;font-size:7.5px;margin-top:5px;min-width:760px"><thead><tr>${['account', 'videos', 'curve MAE', '20s MAE', '20s bias', '20s band coverage', '20s discrimination'].map(label => `<th style="padding:4px;text-align:right;color:${C.mute};border-bottom:1px solid ${C.border}">${label}</th>`).join('')}</tr></thead><tbody>${accounts.map(row => { const fixed = row.fixed20Second || {}; const discrimination = fixed.discriminationStatus === 'unavailable-constant-prediction' ? 'none · constant forecast' : (fixed.discriminationStatus || 'unavailable'); return `<tr><td style="padding:5px;text-align:left;color:${C.text};border-bottom:1px solid ${C.border}">${esc(names[String(row.accountId)] || row.accountId)}</td><td style="padding:5px;text-align:right;border-bottom:1px solid ${C.border}">${Number(row.videos || 0).toLocaleString()}</td><td style="padding:5px;text-align:right;border-bottom:1px solid ${C.border}">${fmt(row.sourceEqualCurveMAEPercentagePoints, 2)} pp<br><span style="font-size:6.5px;color:${C.mute}">${esc(confidenceText(row.sourceEqualCurveMAEConfidence95, 2))}</span></td><td style="padding:5px;text-align:right;border-bottom:1px solid ${C.border}">${fmt(fixed.maePercentagePoints, 2)} pp</td><td style="padding:5px;text-align:right;border-bottom:1px solid ${C.border};color:${Math.abs(Number(fixed.biasPercentagePoints || 0)) > 4 ? C.red : C.dim}">${signed(fixed.biasPercentagePoints, 2)} pp</td><td style="padding:5px;text-align:right;border-bottom:1px solid ${C.border}">${pct(Number(fixed.predictionBandCoverageFraction || 0) * 100)}</td><td style="padding:5px;text-align:right;border-bottom:1px solid ${C.border};color:${discrimination.startsWith('none') ? C.red : C.green}">${esc(discrimination)}</td></tr>`; }).join('')}</tbody></table></div>`;
        }

        function candidateDiagnostic(summary) {
            if (state.scope !== 'all') return '';
            const result = ((((summary.evaluation || {}).strictBlindCandidateVsBaseline || {}).families || {})[state.curveMode]) || {};
            if (!result.videos) return '';
            const improvement = Number(result.pairedImprovementPercentagePoints || 0);
            const verdict = improvement > 0 ? 'candidate lower error in this audit only' : 'candidate did not beat the selected baseline';
            return `<div style="border-left:3px solid ${improvement > 0 ? C.amber : C.red};background:${C.card2};padding:7px;margin-top:8px"><div style="font-size:8px;color:${C.text};font-weight:900">FROZEN CANDIDATE VS SELECTED BASELINE · DIAGNOSTIC ONLY</div><div style="font-size:7.5px;color:${C.dim};line-height:1.5;margin-top:3px">${Number(result.videos || 0).toLocaleString()} transcript-backed blind videos · baseline MAE ${fmt(result.baselineCurveMAEPercentagePoints, 3)} pp · ${esc(result.candidateStage || 'candidate')} MAE ${fmt(result.candidateCurveMAEPercentagePoints, 3)} pp · paired improvement ${signed(improvement, 3)} pp (${esc(confidenceText(result.pairedImprovementConfidence95, 3))}) · candidate wins ${pct(Number(result.candidateWinFraction || 0) * 100)}.</div><div style="font-size:7.5px;color:${improvement > 0 ? C.amber : C.red};font-weight:900;margin-top:3px">${esc(verdict)}. The deployed model stage remains unchanged.</div></div>`;
        }

        function evaluationPanel(summary, rows) {
            const metrics = scopeEvaluation(summary);
            if (!metrics || !metrics.videos) return '';
            const pooled = (summary.evaluation || {}).allPooled || {};
            const fixed20 = metrics.fixed20Second || {};
            const primaryLabel = state.scope === 'all'
                ? 'strict unique external videos' : `${state.scope} frozen predictions`;
            const noDiscrimination = fixed20.discriminationStatus === 'unavailable-constant-prediction';
            const coverageCi = fixed20.predictionBandCoverageWilson95;
            const coverageSub = `${confidenceText(coverageCi && { lower: coverageCi.lower * 100, upper: coverageCi.upper * 100 }, 1)} · mean width ${fmt(fixed20.predictionBandMeanWidthPoints, 1)} pp`;
            const transcriptStatus = (summary.evaluation || {}).strictBlindByTranscriptStatus || {};
            const transcriptMetrics = (((transcriptStatus.timestampedTranscript || {}).families || {})[state.curveMode]) || {};
            const missingMetrics = (((transcriptStatus.missingTranscript || {}).families || {})[state.curveMode]) || {};
            return panel(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:12px;color:${C.text};font-weight:900">Frozen prediction accuracy against actual retention</div><div style="font-size:8px;color:${C.mute};line-height:1.55;margin-top:2px">Primary metrics use ${esc(primaryLabel)}. Time zero is excluded. Each source contributes equally to curve MAE, regardless of duration. The fixed 20-second readout compares like with like; cross-horizon endpoint correlation is withheld.</div><div style="display:flex;gap:4px;margin-top:6px">${button('Normalized survival', 'data-pl-curve="entryIndexed"', state.curveMode === 'entryIndexed')}${button('Raw retention', 'data-pl-curve="observedAbsolute"', state.curveMode === 'observedAbsolute')}</div></div><div style="font-size:7.5px;color:${C.amber};max-width:510px;text-align:right;line-height:1.5">${esc((summary.evaluation || {}).claimBoundary || '')}</div></div>${sealedBlindPanel(summary)}<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:8px">${stat('evaluated videos', Number(metrics.videos || 0).toLocaleString(), C.text, state.scope === 'all' ? `${Number(pooled.videos || 0).toLocaleString()} visible pooled rows; only strict blind rows score the headline` : `${rows.length.toLocaleString()} visible rows`)}${stat('whole-curve MAE', `${fmt(metrics.sourceEqualCurveMAEPercentagePoints, 2)} pp`, C.cyan, `${confidenceText(metrics.sourceEqualCurveMAEConfidence95, 2)} · one vote per video`)}${stat('20s MAE', `${fmt(fixed20.maePercentagePoints, 2)} pp`, C.amber, `${confidenceText(fixed20.maeConfidence95, 2)} · bias ${signed(fixed20.biasPercentagePoints, 2)} pp`)}${stat('20s discrimination', noDiscrimination ? 'none' : fmt(fixed20.pearson, 3), noDiscrimination ? C.red : C.purple, noDiscrimination ? `constant forecast · predicted SD ${fmt(fixed20.predictedStandardDeviationPercent, 2)} vs actual ${fmt(fixed20.actualStandardDeviationPercent, 2)} pp` : `Pearson ${fmt(fixed20.pearson, 3)} · Spearman ${fmt(fixed20.spearman, 3)}`)}${stat('20s band coverage', pct(Number(fixed20.predictionBandCoverageFraction || 0) * 100), C.green, coverageSub)}</div>${state.scope === 'all' ? `<div style="font-size:7.5px;color:${C.dim};margin-top:7px">Transcript-backed curve MAE ${fmt(transcriptMetrics.sourceEqualCurveMAEPercentagePoints, 2)} pp across ${Number(transcriptMetrics.videos || 0).toLocaleString()} videos · missing-transcript selected-baseline MAE ${fmt(missingMetrics.sourceEqualCurveMAEPercentagePoints, 2)} pp across ${Number(missingMetrics.videos || 0).toLocaleString()} videos.</div>` : ''}${accountValidationTable(summary)}${candidateDiagnostic(summary)}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:8px;margin-top:9px"><div style="background:${C.card2};padding:7px"><div style="font-size:8px;color:${C.text};font-weight:900">MEAN PREDICTED VS ACTUAL CURVE</div><canvas data-pl-canvas="pooled-mean" style="display:block;width:100%;height:300px;margin-top:3px"></canvas></div><div style="background:${C.card2};padding:7px"><div style="font-size:8px;color:${C.text};font-weight:900">ERROR BY SECOND</div><canvas data-pl-canvas="pooled-accuracy" style="display:block;width:100%;height:300px;margin-top:3px"></canvas></div></div><div style="background:${C.card2};padding:7px;margin-top:8px"><div style="font-size:8px;color:${C.text};font-weight:900">FIXED 20-SECOND RETENTION · PREDICTED VS ACTUAL</div><div style="font-size:7px;color:${noDiscrimination ? C.red : C.mute};margin-top:2px">${noDiscrimination ? 'Every source receives the same frozen baseline at 20 seconds. This plot measures calibration spread, not ranking ability.' : 'Each dot is a strict blind source at the same horizon.'}</div><canvas data-pl-canvas="pooled-scatter" style="display:block;width:100%;height:360px;margin-top:3px"></canvas></div>`, 'margin-top:9px');
        }

        function renderLibrary() {
            const summary = openingSummary();
            if (!summary) return openingSummaryError() ? errorPanel(openingSummaryError()) : loadingPanel(state.scope === 'tyler' ? 'Loading 208 measured openings and out-of-fold predictions…' : 'Loading pooled frozen predictions and measured retention…');
            const query = state.query.trim().toLowerCase();
            let rows = scopedLibraryRows(summary).filter(row => !query || `${row.title || ''} ${row.text || ''} ${row.videoId} ${row.accountName || ''}`.toLowerCase().includes(query));
            const predictedEndpoint = row => numeric((row.outputs || {}).retainedAtForecastEndPercent) == null
                ? Number((row.outputs || {}).retainedAtAnalyzedEndPercent || 0)
                : Number((row.outputs || {}).retainedAtForecastEndPercent);
            const actualEndpoint = row => numeric((row.actual || {}).retainedAtForecastEndPercent) == null
                ? Number((row.actual || {}).retainedAt20sPercent || 0)
                : Number((row.actual || {}).retainedAtForecastEndPercent);
            const endpointError = row => numeric((row.predictionError || {}).retainedAtForecastEndPoints) == null
                ? Number((row.predictionError || {}).retainedAt20sPoints || 0)
                : Number((row.predictionError || {}).retainedAtForecastEndPoints);
            rows = rows.slice().sort((a, b) => {
                if (state.sort === 'error') return Math.abs(endpointError(b)) - Math.abs(endpointError(a));
                if (state.sort === 'actual') return actualEndpoint(b) - actualEndpoint(a);
                return predictedEndpoint(b) - predictedEndpoint(a);
            });
            const visibleRows = state.scope === 'tyler'
                ? rows
                : rows.slice(0, Math.max(60, Number(state.libraryLimit || 60)));
            return `<div><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;flex-wrap:wrap"><div><div style="font-size:15px;color:${C.text};font-weight:900">${state.scope === 'all' ? 'Pooled opening library' : 'Opening library'}</div><div style="font-size:8px;color:${C.mute};margin-top:2px">${rows.length} visible source-aligned Shorts sequences · ${state.scope === 'tyler' ? 'source-level out-of-fold predictions' : 'unchanged frozen model, outcomes joined afterward'} · each row ends at its own supported endpoint</div></div><div style="display:flex;gap:5px">${button('Predicted', 'data-pl-sort="predicted"', state.sort === 'predicted')}${button('Actual', 'data-pl-sort="actual"', state.sort === 'actual')}${button('Largest error', 'data-pl-sort="error"', state.sort === 'error')}</div></div>
            ${evaluationPanel(summary, rows)}
            ${panel(`<input data-pl-query value="${esc(state.query)}" placeholder="Search title, opening, account, or video ID" style="width:100%;box-sizing:border-box;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:8px;font-size:9px"><div style="max-height:520px;overflow:auto;margin-top:7px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['opening', 'exact components and clusters', 'forecast endpoint', 'predicted retained', 'actual retained', 'error', 'actual views'].map(value => `<th style="position:sticky;top:0;background:${C.card};padding:5px;text-align:right;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${visibleRows.map(row => { const error = endpointError(row); const roleColor = row.strictBlindEligible ? C.green : (String(row.blindEvaluationRole || '').startsWith('excluded') ? C.red : C.mute); return `<tr data-pl-video="${esc(row.videoId)}" style="cursor:pointer;background:${String(row.videoId) === String(state.selectedVideo) ? C.cyan + '12' : 'transparent'}"><td style="padding:6px;text-align:left;border-bottom:1px solid ${C.border};max-width:420px"><b style="display:block;color:${C.text};font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.title || row.videoId)}</b><span style="display:block;color:${C.mute};line-height:1.4;max-height:34px;overflow:hidden">${esc(row.text || '')}</span><span style="display:block;color:${C.cyan};font-size:7px;margin-top:2px">${esc(row.accountName || '')}${row.evaluationKind ? ` · ${esc(row.evaluationKind)}` : ''}</span>${row.blindEvaluationRole ? `<span style="display:block;color:${roleColor};font-size:7px;margin-top:1px">${esc(row.blindEvaluationRole)}</span>` : ''}</td><td style="padding:6px;text-align:left;border-bottom:1px solid ${C.border};min-width:320px;max-width:620px"><div style="font-size:7px;color:${C.mute};margin-bottom:3px">${row.componentCount || 0} components across ${fmt(row.analysisHorizonSeconds, 1)}s</div><div style="display:flex;flex-wrap:wrap;gap:2px">${(row.components || []).map(component => `<span title="tokens ${component.startToken}–${component.endToken} · ${fmt(component.spokenStartSeconds, 2)}–${fmt(component.spokenEndSeconds, 2)}s" style="border-left:3px solid ${colorForCluster(component.category)};background:${colorForCluster(component.category)}12;color:${C.text};padding:2px 4px;font-size:7px;line-height:1.3"><b style="color:${colorForCluster(component.category)}">C${component.category}</b> ${esc(component.text)}</span>`).join('') || ((row.support || {}).timingEstimated ? `<span style="color:${C.amber}">duration-only selected baseline · transcript unavailable</span>` : (row.categorySequence || []).map((category, index) => `<span style="color:${colorForCluster(category)}">C${category}.${index + 1}</span>`).join(' · '))}</div></td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border};color:${C.cyan}">${fmt(row.forecastHorizonSeconds || (row.outputs || {}).forecastEndSeconds, 0)}s<br><span style="font-size:7px;color:${C.mute}">${(row.support || {}).riskSetSourcesAtForecastEnd || '—'} at risk</span></td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border};color:${C.green};font-weight:900">${pct(predictedEndpoint(row))}</td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border}">${pct(actualEndpoint(row))}</td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border};color:${Math.abs(error) > 7 ? C.red : C.dim}">${signed(error, 1)} pp</td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border}">${compact((row.actual || {}).views)}</td></tr>`; }).join('')}</tbody></table></div><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:7px;font-size:8px;color:${C.mute}"><span>showing ${visibleRows.length.toLocaleString()} of ${rows.length.toLocaleString()} matching videos</span>${visibleRows.length < rows.length ? button(`Load next ${Math.min(60, rows.length - visibleRows.length)}`, 'data-pl-more', false) : ''}</div>`, 'margin-top:8px')}
            ${state.detailError ? `<div style="margin-top:8px">${errorPanel(state.detailError)}</div>` : ''}
            ${state.detailLoading ? `<div style="margin-top:8px">${loadingPanel('Loading the saved prediction, measured curve, components, and full lattice…')}</div>` : ''}
            ${state.selectedPrediction ? `<div style="margin-top:10px">${renderAnalysis(state.selectedPrediction, state.selectedLattice)}</div>` : ''}</div>`;
        }

        function selectedProjectionMethod() {
            const projection = state.data.manualProjection || {};
            return (projection.methods || []).find(row => row.id === state.savedMethod)
                || (projection.methods || []).find(row => row.id === projection.selectedMethod)
                || (projection.methods || [])[0];
        }

        function savedPointDetail() {
            const projection = state.data.manualProjection || {};
            const method = selectedProjectionMethod();
            const index = state.savedPoint;
            if (!method || index == null) return '';
            const frozen = projection.frozenPointIndex || {};
            const point = (method.points || [])[index] || [];
            return panel(`<div style="display:grid;grid-template-columns:minmax(0,1fr) repeat(3,minmax(100px,.3fr));gap:8px;align-items:center"><div><div style="font-size:8px;color:${colorForCluster((frozen.labels || [])[index])};font-weight:900">SPAN ${index.toLocaleString()} · CLUSTER ${(frozen.labels || [])[index]}</div><div style="font-size:13px;color:${C.text};font-weight:900;line-height:1.4;margin-top:3px">${esc((frozen.texts || [])[index] || '')}</div><div style="font-size:7px;color:${C.mute};margin-top:3px">hook ${(frozen.hookIndices || [])[index]} · tokens ${(frozen.starts || [])[index]}–${(frozen.ends || [])[index]}</div></div>${stat('map X', fmt(point[0], 3), C.cyan)}${stat('map Y', fmt(point[1], 3), C.purple)}${stat('label', `cluster ${(frozen.labels || [])[index]}`, colorForCluster((frozen.labels || [])[index]))}</div>`, 'margin-top:8px');
        }

        function renderSaved() {
            const projection = state.data.manualProjection;
            if (!projection) return state.errors.manualProjection ? errorPanel(state.errors.manualProjection) : loadingPanel('Loading the saved four-cluster embedding…');
            const method = selectedProjectionMethod();
            const metrics = (method || {}).metrics || {};
            return `<div><div style="font-size:15px;color:${C.text};font-weight:900">Saved four-cluster embedding</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">The persistent outcome-blind component map used to validate the four semantic categories. Clicking a point keeps this view stable and opens its exact span below.</div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">${(projection.methods || []).map(row => button(row.label || row.id, `data-pl-method="${esc(row.id)}"`, row.id === (method || {}).id)).join('')}</div>
            ${panel(`<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px">${stat('points', Number(((projection.frozenPointIndex || {}).labels || []).length).toLocaleString(), C.text)}${stat('worst pair separation', fmt(metrics.worstPairSeparation, 3), C.cyan)}${stat('balanced agreement', pct(Number(metrics.balancedNearestCentroidAgreement || 0) * 100), C.green)}${stat('silhouette', fmt(metrics.silhouetteSampled, 3), C.purple)}</div><canvas data-pl-canvas="saved-map" style="display:block;width:100%;height:570px"></canvas><div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;font-size:8px;margin-top:4px">${[0, 1, 2, 3].map(category => `<span style="color:${colorForCluster(category)}">● cluster ${category}</span>`).join('')}</div>`, 'margin-top:8px')}
            ${savedPointDetail()}</div>`;
        }

        function renderBody() {
            const tabs = [['scorer', 'Score opening'], ['library', 'Opening library'], ['saved', 'Saved embedding']];
            const body = ({ scorer: renderScorer, library: renderLibrary, saved: renderSaved }[state.view] || renderScorer)();
            return `<div id="pl-root" style="color:${C.text};font-family:Nunito,sans-serif;max-width:100%;overflow-x:hidden"><style>#pl-root button:focus-visible,#pl-root input:focus-visible,#pl-root textarea:focus-visible{outline:2px solid ${C.cyan};outline-offset:1px}@media(max-width:760px){#pl-root [data-pl-analysis] section>div[style*='grid-template-columns'],#pl-root [data-pl-score-controls]{grid-template-columns:1fr!important}#pl-root canvas{max-height:330px}#pl-root table{min-width:620px}}</style><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:9px"><div><div style="font-size:19px;color:${C.cyan};font-weight:900">Promise Lab</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Shorts sequence semantics → duration-conditioned measured retention</div></div><div style="display:flex;gap:5px;flex-wrap:wrap">${tabs.map(([id, label]) => button(label, `data-pl-view="${id}"`, state.view === id)).join('')}</div></div>${body}</div>`;
        }

        function sizeCanvas(canvas) {
            const rect = canvas.getBoundingClientRect();
            const ratio = Math.min(2, window.devicePixelRatio || 1);
            const width = Math.max(320, Math.round(rect.width || 900));
            const height = Math.max(180, Math.round(parseFloat(canvas.style.height) || rect.height || 300));
            if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
                canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
            }
            const context = canvas.getContext('2d');
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            return { context, width, height };
        }

        function clearCanvas(canvas) {
            const sized = sizeCanvas(canvas);
            sized.context.clearRect(0, 0, sized.width, sized.height);
            sized.context.fillStyle = C.card2; sized.context.fillRect(0, 0, sized.width, sized.height);
            return sized;
        }

        function drawAxes(ctx, width, height, xLabel, yLabel, xMin, xMax, yMin, yMax) {
            const pad = { l: 48, r: 14, t: 14, b: 35 };
            ctx.strokeStyle = C.border2; ctx.lineWidth = 1; ctx.fillStyle = C.mute; ctx.font = '8px sans-serif';
            for (let i = 0; i <= 5; i++) {
                const y = pad.t + (height - pad.t - pad.b) * i / 5;
                ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
                ctx.fillText(fmt(yMax - (yMax - yMin) * i / 5, 0), 4, y + 3);
            }
            ctx.fillText(xLabel, Math.max(pad.l, width / 2 - 24), height - 7);
            ctx.save(); ctx.translate(11, height / 2 + 20); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore();
            return {
                X: value => pad.l + (value - xMin) / Math.max(1e-9, xMax - xMin) * (width - pad.l - pad.r),
                Y: value => height - pad.b - (value - yMin) / Math.max(1e-9, yMax - yMin) * (height - pad.t - pad.b),
                pad,
            };
        }

        function line(ctx, points, color, width, dash) {
            if (!points.length || !color) return;
            ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.setLineDash(dash || []);
            let open = false;
            ctx.beginPath();
            points.forEach(point => {
                if (!Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) {
                    open = false;
                    return;
                }
                if (open) ctx.lineTo(point[0], point[1]);
                else { ctx.moveTo(point[0], point[1]); open = true; }
            });
            ctx.stroke(); ctx.setLineDash([]);
        }

        function drawRetention(canvas, displayMode) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const mode = displayMode || 'overlay';
            const family = ((analysis.curves || {})[state.curveMode]) || {};
            const times = family.timesSeconds || analysis.predictionTimesSeconds || [];
            const predicted = family.predicted || [];
            const lower = family.predictionP10 || [];
            const upper = family.predictionP90 || [];
            const observed = ((analysis.observedCurves || {})[state.curveMode]) || {};
            const actualTimes = observed.timesSeconds || times;
            const actual = observed.actual || family.actual || [];
            if (!times.length || !predicted.length) return;
            const xMax = Math.max(...times);
            const actualSeries = actualTimes.map((time, index) => [Number(time), numeric(actual[index])])
                .filter(point => Number.isFinite(point[0]) && point[0] <= xMax + 1e-6 && point[1] != null);
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const values = [...predicted, ...lower, ...upper, ...actualSeries.map(point => point[1])].filter(value => numeric(value) != null);
            const yMin = Math.floor((Math.min(...values, 40) - 4) / 5) * 5;
            const yMax = Math.ceil((Math.max(...values, 100) + 4) / 5) * 5;
            const axes = drawAxes(ctx, sized.width, sized.height, 'seconds', '% retained', 0, xMax, yMin, yMax);
            if (mode !== 'actual') (analysis.components || []).forEach((component, index) => {
                const start = numeric(component.spokenStartSeconds);
                const end = numeric(component.spokenEndSeconds);
                if (start == null || end == null) return;
                const left = axes.X(Math.max(0, Math.min(Math.max(...times), start)));
                const right = axes.X(Math.max(0, Math.min(Math.max(...times), end)));
                ctx.fillStyle = colorForCluster(component.category);
                ctx.globalAlpha = index === state.selectedComponent ? .16 : .055;
                ctx.fillRect(left, axes.pad.t, Math.max(1, right - left), sized.height - axes.pad.t - axes.pad.b);
                ctx.globalAlpha = 1;
                ctx.fillRect(left, axes.pad.t, Math.max(2, right - left), 5);
                if (index === state.selectedComponent) {
                    ctx.fillStyle = C.text; ctx.font = '7px sans-serif';
                    ctx.fillText(`component ${index + 1} · C${component.category}`, left + 3, axes.pad.t + 15);
                }
            });
            const band = times.map((time, index) => ({ time, low: numeric(lower[index]), high: numeric(upper[index]) }))
                .filter(row => row.low != null && row.high != null);
            if (mode !== 'actual' && band.length > 1) {
                ctx.fillStyle = C.cyan + '20'; ctx.beginPath();
                band.forEach((row, index) => index ? ctx.lineTo(axes.X(row.time), axes.Y(row.high)) : ctx.moveTo(axes.X(row.time), axes.Y(row.high)));
                [...band].reverse().forEach(row => ctx.lineTo(axes.X(row.time), axes.Y(row.low)));
                ctx.closePath(); ctx.fill();
            }
            if (mode !== 'actual' && state.showStages && family.stages) {
                const stageColors = {
                    baseline: C.faint, timing: C.amber, semantic: C.purple,
                    semanticPrefix: C.purple, components: C.accent, relationships: C.green,
                };
                Object.entries(family.stages).forEach(([name, valuesRow]) => line(
                    ctx,
                    times.map((time, index) => [axes.X(time), numeric(valuesRow[index]) == null ? NaN : axes.Y(valuesRow[index])]),
                    stageColors[name], name === family.selectedStage ? 1.8 : 1, [4, 4],
                ));
            }
            if (mode !== 'actual') line(ctx, times.map((time, index) => [axes.X(time), numeric(predicted[index]) == null ? NaN : axes.Y(predicted[index])]), C.cyan, 3);
            if (mode !== 'predicted' && actualSeries.length) line(ctx, actualSeries.map(point => [axes.X(point[0]), axes.Y(point[1])]), C.green, 2.5);
            ctx.font = '8px sans-serif';
            if (mode !== 'actual') { ctx.fillStyle = C.cyan; ctx.fillText('predicted', sized.width - (mode === 'overlay' ? 140 : 78), 14); }
            if (mode !== 'predicted' && actual && actual.length) { ctx.fillStyle = C.green; ctx.fillText('actual', sized.width - 78, 14); }
        }

        function drawContributions(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const channels = endpointChannels(analysis);
            const order = ['baseline', 'timing', 'semantic', 'components', 'relationships'];
            const selectedIndex = Math.max(0, order.indexOf(channels.selectedStage));
            const bars = [
                { stage: 'baseline', label: 'at-risk mean baseline', value: channels.values.baseline, absolute: true, color: C.faint },
                { stage: 'timing', label: 'timing and cadence', value: channels.deltas.timing, color: C.amber },
                { stage: 'semantic', label: 'causal prefix semantics', value: channels.deltas.semantic, color: C.purple },
                { stage: 'components', label: 'four-cluster components', value: channels.deltas.components, color: C.accent },
                { stage: 'relationships', label: 'prior-sequence relationships', value: channels.deltas.relationships, color: C.green },
            ];
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const zero = Math.min(190, Math.max(145, sized.width * .28));
            const plot = Math.max(120, sized.width - zero - 24);
            const maxDelta = Math.max(1, ...bars.slice(1).map(bar => Math.abs(Number(bar.value || 0))));
            bars.forEach((bar, index) => {
                const applied = order.indexOf(bar.stage) <= selectedIndex;
                const y = 20 + index * 48; ctx.fillStyle = applied ? C.text : C.mute; ctx.font = '9px sans-serif'; ctx.fillText(`${bar.label} · ${applied ? 'applied' : 'candidate only'}`, 8, y + 12);
                if (bar.absolute) {
                    const width = Math.max(1, plot * Math.max(0, Math.min(100, Number(bar.value || 0))) / 100);
                    ctx.fillStyle = bar.color; ctx.globalAlpha = .7; ctx.fillRect(zero, y, width, 18); ctx.globalAlpha = 1;
                    ctx.fillText(`${fmt(bar.value, 1)}%`, zero + width + 5, y + 12);
                } else {
                    if (bar.value == null) {
                        ctx.fillStyle = C.mute; ctx.fillText('not estimated at this endpoint', zero + 6, y + 12);
                        return;
                    }
                    const center = zero + plot / 2; const width = Math.abs(bar.value) / maxDelta * (plot / 2 - 20);
                    ctx.strokeStyle = C.border2; ctx.beginPath(); ctx.moveTo(center, y - 3); ctx.lineTo(center, y + 23); ctx.stroke();
                    ctx.fillStyle = bar.color; ctx.globalAlpha = applied ? .85 : .25;
                    ctx.fillRect(bar.value >= 0 ? center : center - width, y, width, 18); ctx.globalAlpha = 1;
                    ctx.fillStyle = C.text;
                    ctx.fillText(`${signed(bar.value, 2)} pp · ${applied ? 'applied' : 'withheld'}`, bar.value >= 0 ? center + width + 5 : Math.max(4, center - width - 92), y + 12);
                }
            });
        }

        function drawAttribution(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const steps = ((analysis.temporalAttribution || {}).steps || []); if (!steps.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const pad = { l: 46, r: 14, t: 18, b: 36 };
            const channelNames = ['baseline', 'timing', 'semantic', 'components', 'relationships'];
            const colors = { baseline: C.faint, timing: C.amber, semantic: C.purple, components: C.accent, relationships: C.green };
            const channelsFor = row => ({
                baseline: numeric((row.channelDeltaPoints || {}).baseline) == null ? Number(row.baselineDeltaPoints || 0) : Number(row.channelDeltaPoints.baseline),
                timing: Number((row.channelDeltaPoints || {}).timing || 0),
                semantic: numeric((row.channelDeltaPoints || {}).semantic) == null ? Number(row.semanticShapeDeltaPoints || 0) : Number(row.channelDeltaPoints.semantic),
                components: Number((row.channelDeltaPoints || {}).components || 0),
                relationships: Number((row.channelDeltaPoints || {}).relationships || 0),
            });
            const values = steps.flatMap(row => [...Object.values(channelsFor(row)), Number(row.predictedDeltaPoints || 0)]);
            const limit = Math.max(1, ...values.map(value => Math.abs(value))) * 1.15;
            const X = index => pad.l + (index + .5) / steps.length * (sized.width - pad.l - pad.r);
            const Y = value => pad.t + (limit - value) / (2 * limit) * (sized.height - pad.t - pad.b);
            const zero = Y(0);
            ctx.strokeStyle = C.border2; ctx.beginPath(); ctx.moveTo(pad.l, zero); ctx.lineTo(sized.width - pad.r, zero); ctx.stroke();
            ctx.fillStyle = C.mute; ctx.font = '8px sans-serif'; ctx.fillText('+ retention', 3, pad.t + 5); ctx.fillText('− retention', 3, sized.height - pad.b); ctx.fillText('seconds', sized.width / 2 - 15, sized.height - 8);
            const barWidth = Math.max(1, Math.min(7, (sized.width - pad.l - pad.r) / steps.length / 6));
            const geometry = [];
            steps.forEach((row, index) => {
                const center = X(index); const channels = channelsFor(row);
                const drawBar = (value, x, color) => { ctx.fillStyle = color; ctx.globalAlpha = .82; const top = Math.min(zero, Y(value)); ctx.fillRect(x, top, barWidth, Math.max(1, Math.abs(Y(value) - zero))); ctx.globalAlpha = 1; };
                channelNames.forEach((name, offset) => drawBar(
                    channels[name], center + (offset - 2.5) * barWidth, colors[name],
                ));
                const allocations = row.enteredComponents || [];
                if (allocations.length) { ctx.fillStyle = colorForCluster(allocations[0].category); ctx.fillRect(center - barWidth * 2.5, pad.t - 5, barWidth * 5, 4); }
                if (index === Math.min(state.selectedAttributionStep, steps.length - 1)) { ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.5; ctx.strokeRect(center - barWidth * 3 - 3, pad.t - 8, barWidth * 6 + 6, sized.height - pad.t - pad.b + 12); }
                if (index % Math.max(1, Math.ceil(steps.length / 10)) === 0) { ctx.fillStyle = C.mute; ctx.font = '7px sans-serif'; ctx.fillText(fmt(row.endSeconds, 0), center - 4, sized.height - 22); }
                geometry.push({ x: center, y: zero, index });
            });
            channelNames.forEach((name, index) => { ctx.fillStyle = colors[name]; ctx.font = '7px sans-serif'; ctx.fillText(name, 50 + index * 70, 11); });
            canvas._plAttributionBars = geometry;
        }

        function drawComponentResponse(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const component = activeComponent(analysis);
            const rows = componentResponseRows(component);
            const valid = rows.filter(row => row.measuredWithinRiskSet !== false && numeric((row.entry_indexed || {}).slopePercentPerSecond) != null);
            if (!valid.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const xs = valid.map(row => Number(row.lagSeconds));
            const entry = valid.map(row => Number(row.entry_indexed.slopePercentPerSecond));
            const values = [...entry].filter(value => Number.isFinite(value));
            const min = Math.min(...values, -1); const max = Math.max(...values, 1);
            const axes = drawAxes(ctx, sized.width, sized.height, 'response lag (seconds)', 'retention slope pp/s', Math.min(...xs), Math.max(...xs), min, max);
            line(ctx, valid.map((row, index) => [axes.X(row.lagSeconds), axes.Y(entry[index])]), C.cyan, 2.5);
            valid.forEach((row, index) => { ctx.fillStyle = C.cyan; ctx.beginPath(); ctx.arc(axes.X(row.lagSeconds), axes.Y(entry[index]), 3, 0, Math.PI * 2); ctx.fill(); });
            ctx.fillStyle = C.cyan; ctx.font = '8px sans-serif'; ctx.fillText('entry-indexed observed response', sized.width - 176, 13);
        }

        function drawValidation(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const validation = ((analysis.validation || {}).entryIndexed || {});
            const randomRows = (validation.candidateRandomFold || validation.randomFold || {}).perSecond || [];
            const chronologicalRows = (validation.candidateChronological || validation.chronological || {}).perSecond || [];
            const legacyRandom = (validation.randomFold || {}).modelRMSEByTimePercentagePoints || [];
            const legacyChronological = (validation.chronological || {}).modelRMSEByTimePercentagePoints || [];
            const random = randomRows.length ? randomRows.map(row => [row.second, row.heldoutMAEPercentagePoints]) : legacyRandom.map((value, second) => [second, value]);
            const chronological = chronologicalRows.length ? chronologicalRows.map(row => [row.second, row.heldoutMAEPercentagePoints]) : legacyChronological.map((value, second) => [second, value]);
            const baseline = randomRows.map(row => [row.second, row.baselineMAEPercentagePoints]);
            if (!random.length && !chronological.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const values = [...random, ...chronological, ...baseline].map(row => numeric(row[1])).filter(value => value != null);
            const seconds = [...random, ...chronological].map(row => numeric(row[0])).filter(value => value != null);
            const max = Math.max(1, ...values) * 1.1; const last = Math.max(1, ...seconds);
            const axes = drawAxes(ctx, sized.width, sized.height, 'seconds', 'held-out MAE percentage points', 0, last, 0, max);
            if (random.length) line(ctx, random.map(row => [axes.X(row[0]), numeric(row[1]) == null ? NaN : axes.Y(row[1])]), C.cyan, 2.5);
            if (chronological.length) line(ctx, chronological.map(row => [axes.X(row[0]), numeric(row[1]) == null ? NaN : axes.Y(row[1])]), C.amber, 2.5);
            if (baseline.length) line(ctx, baseline.map(row => [axes.X(row[0]), numeric(row[1]) == null ? NaN : axes.Y(row[1])]), C.faint, 1.5, [4, 4]);
            ctx.fillStyle = C.faint; ctx.font = '7px sans-serif'; ctx.fillText('mean baseline', sized.width - 275, 13); ctx.fillStyle = C.cyan; ctx.fillText('candidate random', sized.width - 185, 13); ctx.fillStyle = C.amber; ctx.fillText('candidate forward', sized.width - 88, 13);
        }

        function drawComponentMap(canvas) {
            const analysis = activeAnalysis().prediction; const projection = state.data.manualProjection; const method = selectedProjectionMethod();
            if (!analysis || !projection || !method) return;
            const component = activeComponent(analysis); const selectedPoint = projectedComponentPoint(component, method);
            const points = method.points || []; const labels = (projection.frozenPointIndex || {}).labels || [];
            if (!points.length || !selectedPoint) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const xs = [...points.map(point => Number(point[0])), Number(selectedPoint[0])]; const ys = [...points.map(point => Number(point[1])), Number(selectedPoint[1])];
            const axes = drawAxes(ctx, sized.width, sized.height, 'saved semantic X', 'saved semantic Y', Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
            const geometry = [];
            points.forEach((point, index) => { const x = axes.X(point[0]), y = axes.Y(point[1]); ctx.fillStyle = colorForCluster(labels[index]); ctx.globalAlpha = index === state.savedPoint ? .95 : .13; ctx.beginPath(); ctx.arc(x, y, index === state.savedPoint ? 4.5 : 1.1, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; geometry.push({ x, y, index }); });
            const x = axes.X(selectedPoint[0]), y = axes.Y(selectedPoint[1]); ctx.fillStyle = colorForCluster(component.category); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = C.text; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = C.text; ctx.font = 'bold 8px sans-serif'; ctx.fillText(`component ${Number(component.index || 0) + 1}`, x + 12, y - 8);
            savedMapGeometry = geometry;
        }

        function drawRelationships(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const components = analysis.components || []; if (!components.length) return;
            const relationships = analysis.relationships || [];
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const margin = 42; const y = sized.height / 2;
            const x = index => components.length === 1 ? sized.width / 2 : margin + index / (components.length - 1) * (sized.width - 2 * margin);
            const maximumDrop = Math.max(1, ...components.map(component => Math.abs(Number((component.timelineAttribution || {}).predictedDropPoints || 0))));
            relationships.forEach(row => {
                const modern = row.source != null || row.type === 'next';
                const leftIndex = modern ? Number(String(row.source || '').split(':').pop()) : Number(row.left);
                const rightIndex = modern ? Number(String(row.target || '').split(':').pop()) : Number(row.right);
                if (!Number.isFinite(leftIndex) || !Number.isFinite(rightIndex)) return;
                const similarity = numeric(row.semanticSimilarity);
                const x1 = x(leftIndex), x2 = x(rightIndex);
                const lift = 42 + Math.min(70, Math.abs(Number(similarity || 0)) * 42);
                ctx.strokeStyle = modern ? C.green : C.amber; ctx.globalAlpha = modern ? .72 : .3; ctx.lineWidth = modern ? 2 : 1.5;
                ctx.beginPath(); ctx.moveTo(x1, y); ctx.quadraticCurveTo((x1 + x2) / 2, y - lift, x2, y); ctx.stroke(); ctx.globalAlpha = 1;
                ctx.fillStyle = modern ? C.green : C.amber; ctx.font = '7px sans-serif';
                ctx.fillText(modern ? `${String(row.transition || '')} · sim ${fmt(similarity, 2)}` : 'legacy diagnostic', (x1 + x2) / 2 - 25, y - lift + 9);
            });
            components.forEach((component, index) => {
                const drop = Number((component.timelineAttribution || {}).predictedDropPoints || 0);
                const radius = 7 + Math.abs(drop) / maximumDrop * 7 + (state.selectedComponent === index ? 3 : 0);
                ctx.fillStyle = colorForCluster(component.category); ctx.beginPath(); ctx.arc(x(index), y, radius, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = C.text; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(index + 1), x(index), y + 3); ctx.textAlign = 'left';
                const label = String(component.text || '').slice(0, 18); ctx.fillStyle = C.dim; ctx.font = '7px sans-serif'; ctx.save(); ctx.translate(x(index), y + 20); ctx.rotate(Math.PI / 5); ctx.fillText(label, 0, 0); ctx.restore();
                ctx.fillStyle = C.text; ctx.font = '7px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${signed(drop, 1)}pp`, x(index), y - radius - 5); ctx.textAlign = 'left';
            });
            canvas._plComponentX = components.map((_, index) => x(index)); canvas._plComponentY = y;
        }

        function drawOutcomePlane(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const category = Number(canvas.dataset.plCategory);
            const lag = Number(canvas.dataset.plLag == null ? state.outcomeLag : canvas.dataset.plLag);
            const study = contextStudy();
            const categoryStudy = (study.categories || []).find(row => Number(row.category) === category) || {};
            const experiment = (categoryStudy.lagExperiments || []).find(row => Number(row.lagSeconds) === lag && row.status === 'complete') || {};
            const plane = experiment.outcomePlane || ((categoryStudy.outcomePlanesByLag || {})[String(lag)]) || {};
            const points = (plane.points || []).filter(row => numeric(row.x) != null && numeric(row.y) != null);
            const selected = activeComponent(analysis);
            const selectedByLag = (selected.outcomePlanesByLag || {})[String(lag)] || (lag === Number(study.primaryLagSeconds || 0) ? selected.outcomePlane : null);
            const selectedPlane = Number(selected.category) === category ? (selectedByLag || {}) : null;
            if (!points.length && (!selectedPlane || numeric(selectedPlane.x) == null)) return;
            const allX = points.map(row => Number(row.x)); const allY = points.map(row => Number(row.y));
            if (selectedPlane && numeric(selectedPlane.x) != null) { allX.push(Number(selectedPlane.x)); allY.push(Number(selectedPlane.y)); }
            const slopes = points.map(row => numeric(row.observedSlopePercentagePointsPerSecond)).filter(value => value != null);
            const low = slopes.length ? Math.min(...slopes) : -1; const high = slopes.length ? Math.max(...slopes) : 1;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const axes = drawAxes(ctx, sized.width, sized.height, 'conditional semantic response X', 'orthogonal residual semantic Y', Math.min(...allX), Math.max(...allX), Math.min(...allY), Math.max(...allY));
            const geometry = [];
            points.forEach(row => {
                const x = axes.X(row.x), y = axes.Y(row.y);
                const value = numeric(row.observedSlopePercentagePointsPerSecond);
                const ratio = value == null ? .5 : Math.max(0, Math.min(1, (value - low) / Math.max(1e-9, high - low)));
                const red = Math.round(248 * (1 - ratio) + 52 * ratio);
                const green = Math.round(113 * (1 - ratio) + 211 * ratio);
                const blue = Math.round(113 * (1 - ratio) + 153 * ratio);
                ctx.fillStyle = `rgb(${red},${green},${blue})`; ctx.globalAlpha = .38;
                ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
                geometry.push({ x, y, ...row, category, lagSeconds: lag });
            });
            if (selectedPlane && numeric(selectedPlane.x) != null) {
                const x = axes.X(selectedPlane.x), y = axes.Y(selectedPlane.y);
                ctx.fillStyle = colorForCluster(category); ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = C.text; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
                ctx.fillStyle = C.text; ctx.font = '7px sans-serif'; ctx.fillText('selected component', x + 11, y - 7);
            }
            ctx.fillStyle = C.red; ctx.font = '7px sans-serif'; ctx.fillText(`faster loss ${signed(low, 2)} pp/s`, 52, 11);
            ctx.fillStyle = C.green; ctx.fillText(`better hold ${signed(high, 2)} pp/s`, Math.max(160, sized.width - 145), 11);
            canvas._plOutcomePoints = geometry;
        }

        function drawRiskSet(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const rows = availableRiskRows(analysis).filter(row => numeric(row.second) != null && numeric(row.riskSetSources) != null);
            if (!rows.length) return;
            const summarySupport = (openingSummary() || {}).support || {};
            const semanticMinimum = Number(summarySupport.minimumModelSources || 10);
            const chronologicalMinimum = Number(summarySupport.minimumChronologicalSources || 40);
            const forecast = Number(analysis.forecastHorizonSeconds || (analysis.outputs || {}).forecastEndSeconds || 0);
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const maximumSecond = Math.max(...rows.map(row => Number(row.second)));
            const maximumSources = Math.max(...rows.map(row => Number(row.riskSetSources)), chronologicalMinimum, semanticMinimum);
            const axes = drawAxes(ctx, sized.width, sized.height, 'seconds', 'source videos still at risk', 0, maximumSecond, 0, maximumSources);
            line(ctx, rows.map(row => [axes.X(row.second), axes.Y(row.riskSetSources)]), C.cyan, 2.8);
            [[semanticMinimum, C.purple], [chronologicalMinimum, C.amber]].forEach(([value, color]) => {
                ctx.strokeStyle = color; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(axes.pad.l, axes.Y(value)); ctx.lineTo(sized.width - axes.pad.r, axes.Y(value)); ctx.stroke(); ctx.setLineDash([]);
            });
            if (forecast > 0) {
                ctx.strokeStyle = C.green; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(axes.X(forecast), axes.pad.t); ctx.lineTo(axes.X(forecast), sized.height - axes.pad.b); ctx.stroke();
                ctx.fillStyle = C.green; ctx.font = '7px sans-serif'; ctx.fillText(`forecast ${fmt(forecast, 0)}s`, Math.min(sized.width - 78, axes.X(forecast) + 4), axes.pad.t + 10);
            }
            if (maximumSecond > 20) {
                ctx.strokeStyle = C.faint; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(axes.X(20), axes.pad.t); ctx.lineTo(axes.X(20), sized.height - axes.pad.b); ctx.stroke(); ctx.setLineDash([]);
                ctx.fillStyle = C.mute; ctx.font = '7px sans-serif'; ctx.fillText('acoustic → timestamp timing', Math.min(sized.width - 135, axes.X(20) + 4), sized.height - axes.pad.b - 5);
            }
        }

        function drawLattice(canvas) {
            const lattice = activeAnalysis().lattice; if (!lattice) return;
            const nodes = (lattice.nodes || []).filter(node => node.maps && Array.isArray(node.maps.raw));
            if (!nodes.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const xs = nodes.map(node => Number(node.maps.raw[0])); const ys = nodes.map(node => Number(node.maps.raw[1]));
            const axes = drawAxes(ctx, sized.width, sized.height, 'semantic X', 'semantic Y', Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
            const canonical = new Set(((lattice.partitionContract || {}).canonicalComponentNodeIds) || []);
            const nodeMap = new Map(nodes.map(node => [node.id, node]));
            ctx.strokeStyle = C.faint; ctx.globalAlpha = .055; ctx.lineWidth = .5;
            (lattice.edges || []).forEach(edge => {
                if (edge.type !== state.latticeEdgeType) return;
                const source = nodeMap.get(edge.source); const target = nodeMap.get(edge.target);
                if (!source || !target) return;
                ctx.beginPath(); ctx.moveTo(axes.X(source.maps.raw[0]), axes.Y(source.maps.raw[1]));
                ctx.lineTo(axes.X(target.maps.raw[0]), axes.Y(target.maps.raw[1])); ctx.stroke();
            });
            ctx.globalAlpha = 1;
            const points = [];
            nodes.forEach(node => {
                const x = axes.X(node.maps.raw[0]), y = axes.Y(node.maps.raw[1]); const selected = canonical.has(node.id);
                ctx.fillStyle = colorForCluster(node.category); ctx.globalAlpha = selected ? .95 : .18;
                ctx.beginPath(); ctx.arc(x, y, selected ? 4.2 : 1.6, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
                if (selected) { ctx.strokeStyle = C.text; ctx.lineWidth = .7; ctx.stroke(); }
                points.push({ x, y, id: node.id });
            });
            canvas._plPoints = points;
        }

        function drawSavedMap(canvas) {
            const projection = state.data.manualProjection; const method = selectedProjectionMethod();
            if (!projection || !method) return;
            const points = method.points || []; const labels = (projection.frozenPointIndex || {}).labels || [];
            if (!points.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const xs = points.map(point => Number(point[0])); const ys = points.map(point => Number(point[1]));
            const axes = drawAxes(ctx, sized.width, sized.height, 'saved map X', 'saved map Y', Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
            const geometry = [];
            points.forEach((point, index) => {
                const x = axes.X(point[0]), y = axes.Y(point[1]); const chosen = index === state.savedPoint;
                ctx.fillStyle = colorForCluster(labels[index]); ctx.globalAlpha = chosen ? 1 : .22;
                ctx.beginPath(); ctx.arc(x, y, chosen ? 5 : 1.25, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
                geometry.push({ x, y, index });
            });
            savedMapGeometry = geometry;
        }

        function drawPooledMean(canvas) {
            const metrics = scopeEvaluation(openingSummary() || {}) || {};
            const rows = metrics.accuracyBySecond || [];
            if (!rows.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const values = rows.flatMap(row => [row.predictedMeanPercent, row.actualMeanPercent]).filter(value => numeric(value) != null);
            const xMax = Math.max(...rows.map(row => Number(row.second || 0)), 1);
            const yMin = Math.floor((Math.min(...values, 40) - 3) / 5) * 5;
            const yMax = Math.ceil((Math.max(...values, 100) + 3) / 5) * 5;
            const axes = drawAxes(ctx, sized.width, sized.height, 'seconds', '% retained', 0, xMax, yMin, yMax);
            line(ctx, rows.map(row => [axes.X(row.second), axes.Y(row.predictedMeanPercent)]), C.cyan, 3);
            line(ctx, rows.map(row => [axes.X(row.second), axes.Y(row.actualMeanPercent)]), C.green, 3);
            ctx.font = '8px sans-serif'; ctx.fillStyle = C.cyan; ctx.fillText('predicted mean', sized.width - 170, 14);
            ctx.fillStyle = C.green; ctx.fillText('actual mean', sized.width - 88, 14);
        }

        function drawPooledAccuracy(canvas) {
            const metrics = scopeEvaluation(openingSummary() || {}) || {};
            const rows = metrics.accuracyBySecond || [];
            if (!rows.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const xMax = Math.max(...rows.map(row => Number(row.second || 0)), 1);
            const lower = Math.min(0, ...rows.map(row => Number(row.biasPercentagePoints || 0)));
            const upper = Math.max(1, ...rows.map(row => Number(row.rmsePercentagePoints || 0)), ...rows.map(row => Number(row.maePercentagePoints || 0)));
            const yMin = Math.floor((lower - 1) / 2) * 2;
            const yMax = Math.ceil((upper + 1) / 2) * 2;
            const axes = drawAxes(ctx, sized.width, sized.height, 'seconds', 'error · percentage points', 0, xMax, yMin, yMax);
            if (yMin <= 0 && yMax >= 0) line(ctx, [[axes.X(0), axes.Y(0)], [axes.X(xMax), axes.Y(0)]], C.faint, 1, [3, 3]);
            line(ctx, rows.map(row => [axes.X(row.second), axes.Y(row.maePercentagePoints)]), C.cyan, 3);
            line(ctx, rows.map(row => [axes.X(row.second), axes.Y(row.rmsePercentagePoints)]), C.amber, 2);
            line(ctx, rows.map(row => [axes.X(row.second), axes.Y(row.biasPercentagePoints)]), C.purple, 2);
            ctx.font = '8px sans-serif'; ctx.fillStyle = C.cyan; ctx.fillText('MAE', sized.width - 145, 14);
            ctx.fillStyle = C.amber; ctx.fillText('RMSE', sized.width - 108, 14);
            ctx.fillStyle = C.purple; ctx.fillText('bias', sized.width - 64, 14);
        }

        function drawPooledScatter(canvas) {
            const summary = openingSummary() || {};
            const rows = scopedLibraryRows(summary)
                .filter(row => state.scope !== 'all' || row.strictBlindEligible === true)
                .map(row => {
                const familyComparisons = (row.comparisonsByFamily || {})[state.curveMode]
                    || row.comparisons || {};
                const comparison = familyComparisons['20'] || {};
                const predicted = numeric(comparison.predictedPercent);
                const actual = numeric(comparison.actualPercent);
                return { predicted, actual, accountId: row.accountId || 'tyler' };
            }).filter(row => row.predicted != null && row.actual != null);
            if (!rows.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const values = rows.flatMap(row => [row.predicted, row.actual]);
            const minimum = Math.floor((Math.min(...values) - 3) / 5) * 5;
            const maximum = Math.ceil((Math.max(...values) + 3) / 5) * 5;
            const axes = drawAxes(ctx, sized.width, sized.height, 'actual 20-second retention %', 'predicted 20-second retention %', minimum, maximum, minimum, maximum);
            line(ctx, [[axes.X(minimum), axes.Y(minimum)], [axes.X(maximum), axes.Y(maximum)]], C.green, 1.5, [5, 4]);
            const accounts = [...new Set(rows.map(row => row.accountId))];
            rows.forEach(row => {
                const color = clusterColors[Math.max(0, accounts.indexOf(row.accountId)) % clusterColors.length];
                ctx.fillStyle = color; ctx.globalAlpha = .48;
                ctx.beginPath(); ctx.arc(axes.X(row.actual), axes.Y(row.predicted), 3, 0, Math.PI * 2); ctx.fill();
            });
            canvas._plPooledPointCount = rows.length;
            ctx.globalAlpha = 1; ctx.font = '8px sans-serif';
            ctx.fillStyle = C.green; ctx.fillText('perfect prediction', sized.width - 110, 14);
        }

        function drawAll() {
            if (!host) return;
            host.querySelectorAll('canvas[data-pl-canvas]').forEach(canvas => {
                const kind = canvas.dataset.plCanvas;
                if (kind === 'retention' || kind === 'retention-overlay') drawRetention(canvas, 'overlay');
                else if (kind === 'retention-predicted') drawRetention(canvas, 'predicted');
                else if (kind === 'retention-actual') drawRetention(canvas, 'actual');
                else if (kind === 'pooled-mean') drawPooledMean(canvas);
                else if (kind === 'pooled-accuracy') drawPooledAccuracy(canvas);
                else if (kind === 'pooled-scatter') drawPooledScatter(canvas);
                else if (kind === 'contributions') drawContributions(canvas);
                else if (kind === 'attribution') drawAttribution(canvas);
                else if (kind === 'component-response') drawComponentResponse(canvas);
                else if (kind === 'component-map') drawComponentMap(canvas);
                else if (kind === 'validation') drawValidation(canvas);
                else if (kind === 'relationships') drawRelationships(canvas);
                else if (kind === 'outcome-plane') drawOutcomePlane(canvas);
                else if (kind === 'risk-set') drawRiskSet(canvas);
                else if (kind === 'lattice') drawLattice(canvas);
                else if (kind === 'saved-map') drawSavedMap(canvas);
            });
        }

        function nearestPoint(points, x, y, maximum) {
            let best = null; let distance = maximum == null ? Infinity : maximum * maximum;
            (points || []).forEach(point => {
                const next = (point.x - x) ** 2 + (point.y - y) ** 2;
                if (next < distance) { distance = next; best = point; }
            });
            return best;
        }

        function canvasPoint(event, canvas) {
            const rect = canvas.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }

        function handleClick(event) {
            const target = event.target;
            const view = target.closest('[data-pl-view]');
            if (view) { state.view = view.dataset.plView; ensureViewData(); paint(); return true; }
            if (target.closest('[data-pl-score]')) { scoreOpening(); return true; }
            const sort = target.closest('[data-pl-sort]');
            if (sort) { state.sort = sort.dataset.plSort; state.libraryLimit = 60; paint(); return true; }
            if (target.closest('[data-pl-more]')) { state.libraryLimit = Number(state.libraryLimit || 60) + 60; paint(); return true; }
            const video = target.closest('[data-pl-video]');
            if (video) { loadVideo(video.dataset.plVideo); return true; }
            const component = target.closest('[data-pl-component]');
            if (component) { state.selectedComponent = Number(component.dataset.plComponent); state.selectedLatticeNode = null; state.savedPoint = null; state.outcomePoint = null; paint(); return true; }
            const attributionStep = target.closest('[data-pl-attribution-step]');
            if (attributionStep) { state.selectedAttributionStep = Number(attributionStep.dataset.plAttributionStep); paint(); return true; }
            const measurementMode = target.closest('[data-pl-measurement-mode]');
            if (measurementMode) { state.measurementMode = measurementMode.dataset.plMeasurementMode; paint(); return true; }
            const outcomeLag = target.closest('[data-pl-outcome-lag]');
            if (outcomeLag) { state.outcomeLag = Number(outcomeLag.dataset.plOutcomeLag); state.outcomePoint = null; paint(); return true; }
            const latticeEdge = target.closest('[data-pl-lattice-edge]');
            if (latticeEdge) { state.latticeEdgeType = latticeEdge.dataset.plLatticeEdge; paint(); return true; }
            const curve = target.closest('[data-pl-curve]');
            if (curve) { state.curveMode = curve.dataset.plCurve; paint(); return true; }
            if (target.closest('[data-pl-toggle-stages]')) { state.showStages = !state.showStages; paint(); return true; }
            const method = target.closest('[data-pl-method]');
            if (method) { state.savedMethod = method.dataset.plMethod; state.savedPoint = null; paint(); return true; }
            const canvas = target.closest('canvas[data-pl-canvas]');
            if (canvas) {
                const point = canvasPoint(event, canvas);
                if (canvas.dataset.plCanvas === 'saved-map' || canvas.dataset.plCanvas === 'component-map') {
                    const selected = nearestPoint(savedMapGeometry, point.x, point.y, 12);
                    if (selected) { state.savedPoint = selected.index; paint(); }
                } else if (canvas.dataset.plCanvas === 'attribution') {
                    const selected = (canvas._plAttributionBars || []).reduce((best, row) => (
                        !best || Math.abs(row.x - point.x) < Math.abs(best.x - point.x) ? row : best
                    ), null);
                    if (selected && Math.abs(selected.x - point.x) <= 28) { state.selectedAttributionStep = selected.index; paint(); }
                } else if (canvas.dataset.plCanvas === 'lattice') {
                    const selected = nearestPoint(canvas._plPoints, point.x, point.y, 14);
                    if (selected) { state.selectedLatticeNode = selected.id; paint(); }
                } else if (canvas.dataset.plCanvas === 'relationships') {
                    const xs = canvas._plComponentX || []; let best = -1; let distance = 18;
                    xs.forEach((value, index) => { const next = Math.abs(value - point.x); if (next < distance) { distance = next; best = index; } });
                    if (best >= 0) { state.selectedComponent = best; state.selectedLatticeNode = null; paint(); }
                } else if (canvas.dataset.plCanvas === 'outcome-plane') {
                    const selected = nearestPoint(canvas._plOutcomePoints, point.x, point.y, 12);
                    if (selected) { state.outcomePoint = selected; paint(); }
                }
                return true;
            }
            return false;
        }

        function handleInput(event) {
            if (event.target.matches('[data-pl-score-text]')) { state.scoreText = event.target.value; return true; }
            if (event.target.matches('[data-pl-score-duration]')) { state.scoreDuration = event.target.value; return true; }
            if (event.target.matches('[data-pl-query]')) { state.query = event.target.value; return true; }
            return false;
        }

        function handleChange(event) {
            if (event.target.matches('[data-pl-query]')) { state.query = event.target.value; state.libraryLimit = 60; paint(); return true; }
            return false;
        }

        function render() { syncScope(); window.requestAnimationFrame(() => { host = document.querySelector('#pl-root'); drawAll(); }); return renderBody(); }
        function afterRender() { host = document.querySelector('#pl-root'); syncScope(); ensureViewData(); drawAll(); }
        return { render, afterRender, handleClick, handleInput, handleChange, _state: state };
    };
}());
