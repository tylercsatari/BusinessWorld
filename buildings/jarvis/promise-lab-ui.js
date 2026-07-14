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
        const clusterColors = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399'];
        const state = {
            view: 'scorer', data: {}, loading: {}, errors: {},
            scoreText: '', scoreIdea: '', scoreResult: null, scoreLoading: false,
            scoreStatus: '', scoreError: '', scoreJobId: null,
            query: '', sort: 'predicted', selectedVideo: null,
            selectedPrediction: null, selectedLattice: null, detailLoading: false,
            detailError: '', selectedComponent: 0, selectedLatticeNode: null,
            curveMode: 'entryIndexed', showStages: true,
            savedMethod: 'maxmin', savedPoint: null, selectedAttributionStep: 0,
            latticeEdgeType: 'sequence', measurementMode: 'forward',
        };
        const detailCache = new Map();
        let host = null;
        let scoreRequest = 0;
        let detailRequest = 0;
        let savedMapGeometry = null;

        const numeric = value => Number.isFinite(Number(value)) ? Number(value) : null;
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
            load('manualProjection', api('manual-projection'));
            if (state.view === 'library') load('openingPredictions', api('opening-predictions'));
            if (state.view === 'saved') {
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
                    : 'Embedding the opening and applying the frozen 20-second model';
                paint();
            }
            throw new Error('The scorer is still running after 15 minutes.');
        }

        async function scoreOpening() {
            const text = String(state.scoreText || '').replace(/\s+/g, ' ').trim();
            const idea = String(state.scoreIdea || '').replace(/\s+/g, ' ').trim();
            if (!/[\p{L}\p{N}_]/u.test(text)) { state.scoreError = 'Type at least one word to score.'; paint(); return; }
            if (state.scoreLoading) return;
            const request = ++scoreRequest;
            state.scoreLoading = true; state.scoreError = ''; state.scoreResult = null;
            state.scoreStatus = 'Submitting the exact opening'; paint();
            try {
                const submitted = await jsonResponse(await fetch(api('hook-score'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, idea, async: true }), cache: 'no-store',
                }));
                state.scoreJobId = submitted.jobId || null;
                const result = submitted.jobId ? await pollScoreJob(submitted.jobId, request) : submitted;
                if (request === scoreRequest) {
                    state.scoreResult = result; state.selectedComponent = 0;
                    state.selectedLatticeNode = null; state.selectedAttributionStep = 0;
                    state.savedPoint = null;
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
            state.selectedVideo = String(videoId); state.detailError = '';
            state.selectedComponent = 0; state.selectedLatticeNode = null;
            state.selectedAttributionStep = 0; state.savedPoint = null;
            const cached = detailCache.get(String(videoId));
            if (cached) {
                state.selectedPrediction = cached.prediction; state.selectedLattice = cached.lattice; paint(); return;
            }
            state.selectedPrediction = null; state.selectedLattice = null; state.detailLoading = true; paint();
            try {
                const [prediction, lattice] = await Promise.all([
                    jsonResponse(await fetch(`${api('opening-prediction')}/${encodeURIComponent(videoId)}`)),
                    jsonResponse(await fetch(`${api('opening-20s')}/${encodeURIComponent(videoId)}`)),
                ]);
                if (request !== detailRequest) return;
                detailCache.set(String(videoId), { prediction, lattice });
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
                lattice: state.scoreResult && state.scoreResult.componentLattice,
            };
            return { prediction: state.selectedPrediction, lattice: state.selectedLattice };
        }

        function validationSummary(analysis) {
            const family = ((analysis.validation || {}).entryIndexed || {});
            const selected = (((analysis.contributions || {}).at20Seconds || (analysis.contributions || {}).atAnalyzedEnd || {}).selectedStage)
                || (((analysis.curves || {}).entryIndexed || {}).selectedStage) || 'semanticPrefix';
            const random = family.randomFold || {};
            const summary = state.data.openingPredictions || {};
            const corpusFamily = ((summary.validation || {}).entryIndexed || {});
            const chronological = family.chronological || corpusFamily.chronological || {};
            return { selected, random, chronological };
        }

        function headline(analysis) {
            const output = analysis.outputs || {};
            const actual = analysis.actual || null;
            const views = output.viewsDiagnostic || null;
            const is20 = Number(analysis.analysisHorizonSeconds || 0) >= 19.99;
            const hookEnd = numeric(analysis.originalHookEndSeconds);
            const hookPrediction = numeric(output.retainedAtOriginalHookEndPercent);
            const viewsAvailable = !!(views && views.promoted);
            return `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;padding:10px 0;border-bottom:1px solid ${C.border}">
                ${stat(is20 ? 'predicted retained at 20s' : 'predicted retained at text end', pct(output.retainedAtAnalyzedEndPercent), C.green, `OOF residual band ${pct(output.retainedAtAnalyzedEndP10)}–${pct(output.retainedAtAnalyzedEndP90)}`)}
                ${hookPrediction == null ? '' : stat(`predicted at hook end${hookEnd == null ? '' : ` · ${fmt(hookEnd, 1)}s`}`, pct(hookPrediction), C.accent, 'same causal prefix curve at the measured hook boundary')}
                ${stat('predicted absolute R5', output.absoluteRetention5sPercent == null ? 'withheld' : pct(output.absoluteRetention5sPercent), C.cyan, output.absoluteRetention5sPercent == null ? 'supplied text ends before 5s' : 'same raw R5 definition used by Shorts Quant')}
                ${stat('normalized drop', pct(output.normalizedDropBy20sPoints == null ? output.normalizedDropByAnalyzedEndPoints : output.normalizedDropBy20sPoints), C.amber, 'entry indexed: starts at 100%')}
                ${stat('individualized views', viewsAvailable ? compact(views.estimate) : 'withheld', viewsAvailable ? C.purple : C.amber, views ? `R5 scenario ${compact(views.lower80)}–${compact(views.upper80)} · ${views.status || 'withheld'}` : 'needs at least five seconds of supplied text')}
                ${actual ? stat('actual retained', pct(actual.retainedAt20sPercent), C.text, `actual R5 ${pct(actual.absoluteRetention5sPercent)} · ${compact(actual.views)} views`) : ''}
            </div>`;
        }

        function evidencePanel(analysis) {
            const validation = validationSummary(analysis);
            const contribution = (analysis.contributions || {}).at20Seconds
                || (analysis.contributions || {}).atAnalyzedEnd || {};
            const support = analysis.support || {};
            const selectedLabel = validation.selected === 'semanticPrefix' ? 'causal prefix semantics' : validation.selected;
            const selectedColor = C.green;
            const randomGain = numeric(validation.random.maeImprovementFraction);
            const forwardGain = numeric(validation.chronological.maeImprovementFraction);
            const forwardPassed = forwardGain != null && forwardGain > 0;
            const equation = `${fmt(contribution.baselinePercent, 2)}% ${Number(contribution.semanticDeltaPoints || 0) >= 0 ? '+' : '−'} ${fmt(Math.abs(Number(contribution.semanticDeltaPoints || 0)), 2)} pp + 0.00 pp + 0.00 pp = ${fmt(contribution.finalPercent, 2)}%`;
            return panel(`<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div style="max-width:760px"><div style="font-size:11px;color:${C.text};font-weight:900">Prediction evidence</div><div style="font-size:8px;color:${C.dim};line-height:1.55;margin-top:3px">At every plotted second, the headline embeds only words completed by that second. Component and relationship endpoint candidates remain visible below, but add <b>zero</b> to the headline. Random-fold validation measures same-era association; the chronological result is the past-to-future deployment stress test.</div><div style="font-size:8px;color:${C.text};margin-top:6px"><b>Endpoint equation:</b> mean curve + prefix semantics + component channel + relationship channel<br><span style="color:${C.cyan}">${equation}</span></div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('model status', forwardPassed ? 'forward gate passed' : 'exploratory', forwardPassed ? C.green : C.amber, forwardPassed ? 'beats the past-to-future mean baseline' : `forward MAE change ${forwardGain == null ? '—' : signed(forwardGain * 100, 1) + '%'}`)}${stat('applied signal', selectedLabel, selectedColor)}${stat('random OOF curve MAE', `${fmt(validation.random.heldoutMAEPercentagePoints, 2)} pp`, C.cyan, `baseline ${fmt(validation.random.baselineMAEPercentagePoints, 2)} pp · ${randomGain == null ? '—' : signed(randomGain * 100, 1) + '%'}`)}${stat('past-to-future MAE', `${fmt(validation.chronological.heldoutMAEPercentagePoints, 2)} pp`, C.amber, `baseline ${fmt(validation.chronological.baselineMAEPercentagePoints, 2)} pp`)}${stat('length support', support.isExtrapolation ? 'extrapolation' : 'inside range', support.isExtrapolation ? C.red : C.green, `${support.trainingTokenCountMinimum || 20}–${support.trainingTokenCountMaximum || 115} training tokens`)}</div></div>`, 'margin-top:10px');
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
                'saved map x / y', 'model movement', 'semantic movement', 'observed movement', 'candidate R20 deletion',
            ].map(value => `<th style="position:sticky;top:0;background:${C.card};text-align:right;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${components.map((component, index) => {
                const timeline = component.timelineAttribution || {};
                const impactRoot = component.predictionImpact || {};
                const impact = impactRoot.entryIndexed || {};
                const probabilities = component.categoryDistribution || [];
                return `<tr data-pl-component="${index}" style="cursor:pointer;background:${state.selectedComponent === index ? C.cyan + '12' : 'transparent'}"><td style="text-align:left;padding:5px;border-bottom:1px solid ${C.border};max-width:360px"><b style="color:${colorForCluster(component.category)}">${index + 1} · C${component.category}</b><br><span style="color:${C.text};line-height:1.4">${esc(component.text)}</span></td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};white-space:nowrap">${component.startToken == null ? component.start : component.startToken}–${component.endToken == null ? component.end : component.endToken}<br>${fmt(component.spokenStartSeconds, 3)}–${fmt(component.spokenEndSeconds, 3)}s</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${colorForCluster(component.category)};font-weight:900">C${component.category}<br>${pct(Number(component.categoryProbability || probabilities[component.category] || 0) * 100)}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};white-space:nowrap">${[0, 1, 2, 3].map(category => `<span style="color:${colorForCluster(category)}">C${category} ${pct(Number(probabilities[category] || 0) * 100)}</span>`).join('<br>')}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};white-space:nowrap">${fmt(component.mapX, 5)}<br>${fmt(component.mapY, 5)}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};font-weight:900">${signed(timeline.predictedDeltaPoints, 2)} pp</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${C.purple}">${signed(timeline.semanticShapeDeltaPoints, 2)} pp</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${C.green}">${timeline.observedDeltaPoints == null ? '—' : signed(timeline.observedDeltaPoints, 2) + ' pp'}</td><td style="text-align:right;padding:5px;border-bottom:1px solid ${C.border};color:${C.amber}">${impactRoot.available === false || impact.retention20sPoints == null ? 'unavailable' : signed(impact.retention20sPoints, 2) + ' pp'}<br><span style="color:${C.mute}">headline 0.00 pp</span></td></tr>`;
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

        function componentMeasurementPanel(analysis) {
            const component = activeComponent(analysis);
            if (!component.text) return '';
            const timeline = component.timelineAttribution || {};
            const measurements = component.measurements || {};
            const rows = state.measurementMode === 'reverse' ? (measurements.reverseControls || []) : (measurements.forward || []);
            const impact = component.predictionImpact || {};
            const entryImpact = impact.entryIndexed || {};
            const attention = component.descriptiveAttention || {};
            const rawMap = ((component.maps || {}).raw || []);
            const contextMap = ((component.maps || {}).context || []);
            const influenceMap = ((component.maps || {}).influence || []);
            const controls = `<div style="display:flex;gap:4px">${button('Forward lags', 'data-pl-measurement-mode="forward"', state.measurementMode === 'forward')}${button('Reverse controls', 'data-pl-measurement-mode="reverse"', state.measurementMode === 'reverse')}</div>`;
            return panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Component evidence and response timing</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">Timeline accounting explains which model transition consumed these tokens. Saved rows additionally expose every measured forward lag and reverse-time falsification control.</div></div>${controls}</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:7px">${stat('timeline drop assigned', timeline.predictedDropPoints == null ? '—' : `${signed(timeline.predictedDropPoints, 2)} pp`, C.cyan, 'exact token-overlap accounting')}${stat('semantic shape share', timeline.semanticShapeDeltaPoints == null ? '—' : `${signed(timeline.semanticShapeDeltaPoints, 2)} pp`, C.purple, 'relative to the time baseline')}${stat('candidate R20 deletion', impact.available ? `${signed(entryImpact.retention20sPoints, 2)} pp` : 'unavailable', C.amber, impact.available ? 'withheld intervention candidate' : (impact.reason || component.measurementStatus || 'not estimated'))}${stat('headline contribution', '0.00 pp', C.green, 'component stage was not promoted')}</div><div style="display:grid;grid-template-columns:minmax(230px,.8fr) minmax(0,1.2fr);gap:9px;margin-top:8px"><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.6"><b style="color:${C.text}">Exact phrase:</b> ${esc(component.text)}<br><b style="color:${C.text}">Tokens:</b> ${component.startToken == null ? component.start : component.startToken}–${component.endToken == null ? component.end : component.endToken}<br><b style="color:${C.text}">Spoken interval:</b> ${fmt(component.spokenStartSeconds, 3)}–${fmt(component.spokenEndSeconds, 3)}s<br><b style="color:${C.text}">Context change:</b> ${fmt(attention.contextChangePercentileWithinHook, 1)}th percentile<br><b style="color:${C.text}">Semantic centrality:</b> ${fmt(attention.semanticCentralityPercentileWithinHook, 1)}th percentile<br><b style="color:${C.text}">Raw map:</b> [${rawMap.map(value => fmt(value, 4)).join(', ')}]<br><b style="color:${C.text}">Context map:</b> [${contextMap.map(value => fmt(value, 4)).join(', ')}]<br><b style="color:${C.text}">Influence map:</b> [${influenceMap.map(value => fmt(value, 4)).join(', ')}]</div><div>${rows.length ? `<canvas data-pl-canvas="component-response" style="display:block;width:100%;height:230px"></canvas>` : `<div style="min-height:180px;border:1px dashed ${C.border};display:flex;align-items:center;justify-content:center;padding:20px;color:${C.mute};font-size:8px;text-align:center">${esc(component.measurementStatus || 'No observed audience-retention curve is attached to this typed opening. The same panel remains present so saved and typed analyses do not diverge.')}</div>`}</div></div>${rows.length ? `<div style="overflow:auto;max-height:250px;margin-top:7px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['lag', 'response window', 'eligible', 'entry slope /s', 'entry Δ', 'raw slope /s', 'raw Δ'].map(value => `<th style="text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${rows.map(row => { const entry = row.entry_indexed || {}; const raw = row.observed_absolute || {}; return `<tr><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${row.lagSeconds < 0 ? C.amber : C.cyan}">${signed(row.lagSeconds, 1)}s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${fmt(row.windowStartSeconds, 2)}–${fmt(row.windowEndSeconds, 2)}s</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${row.measuredWithin20s ? C.green : C.red}">${row.measuredWithin20s ? 'yes' : 'no'}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(entry.slopePercentPerSecond, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(entry.dropPercentagePoints, 2)} pp</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(raw.slopePercentPerSecond, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(raw.dropPercentagePoints, 2)} pp</td></tr>`; }).join('')}</tbody></table></div>` : ''}`, 'margin-top:8px');
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
            const selected = activeComponent(analysis);
            return `${panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><div style="font-size:11px;color:${C.text};font-weight:900">${components.length} non-overlapping components · every phrase and value exposed</div><div style="font-size:8px;color:${C.mute};margin:2px 0 7px">Four is the category vocabulary, not the component count. Every analyzed token belongs to exactly one selected component; overlapping lattice spans below are candidates only.</div></div><div style="font-size:8px;color:${C.cyan};font-weight:900">SELECT A COMPONENT</div></div>${tokenStrip(analysis)}${componentLedgerTable(analysis)}`, 'margin-top:10px')}
            ${selected.text ? componentEmbeddingPanel(analysis) : ''}${selected.text ? componentMeasurementPanel(analysis) : ''}${selected.text ? componentRawEvidencePanel(analysis, lattice) : ''}`;
        }

        function relationshipPanel(analysis) {
            const rows = analysis.relationships || [];
            if (!rows.length) return '';
            return panel(`<div style="font-size:11px;color:${C.text};font-weight:900;margin-bottom:5px">Canonical sequence relationships</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-bottom:6px">Each row disables one adjacent relationship channel while preserving both component semantics. Only complete 20-second openings have a candidate endpoint delta; every row contributes zero to the headline.</div><div style="overflow:auto;max-height:280px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['edge', 'clusters', 'candidate R20 Δ', 'headline Δ', 'status'].map(value => `<th style="text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${rows.map(row => { const root = row.predictionImpact || {}; const impact = root.entryIndexed || {}; return `<tr><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${row.left + 1}→${row.right + 1}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${colorForCluster(row.rightCategory)}">${row.leftCategory}→${row.rightCategory}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${root.available === false ? 'unavailable' : signed(impact.retention20sPoints, 2) + ' pp'}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.green}">0.00 pp</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.amber}">withheld</td></tr>`; }).join('')}</tbody></table></div>`, 'margin-top:10px');
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
            const rows = (analysis.causalPrefixTrace || []).filter(row => Number(row.second) <= Number(analysis.analysisHorizonSeconds || 20) + 1e-6);
            if (!rows.length) return '';
            const input = analysis.input || {};
            const timing = input.timingSource || ((rows[0] || {}).timingSource) || 'source-media acoustic word ends';
            return panel(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Causal transcript prefixes used by the curve</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">Point t sees only the words listed on row t. No later word can influence an earlier prediction.</div></div><div style="font-size:7px;color:${input.timingEstimated ? C.amber : C.green};max-width:360px;text-align:right">${esc(timing)}${input.timingEstimated ? ' · estimated timing' : ' · measured/provided timing'}</div></div><div style="overflow:auto;max-height:390px;margin-top:7px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr><th style="position:sticky;top:0;background:${C.card};text-align:right;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">point</th><th style="position:sticky;top:0;background:${C.card};text-align:right;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">tokens seen</th><th style="position:sticky;top:0;background:${C.card};text-align:left;padding:5px;color:${C.mute};border-bottom:1px solid ${C.border}">exact semantic input</th></tr></thead><tbody>${rows.map(row => `<tr><td style="text-align:right;vertical-align:top;padding:5px;border-bottom:1px solid ${C.border};color:${C.cyan};font-weight:900">${fmt(row.second, 0)}s</td><td style="text-align:right;vertical-align:top;padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${row.tokenCount}</td><td style="text-align:left;vertical-align:top;padding:5px;border-bottom:1px solid ${C.border};color:${C.text};line-height:1.45">${esc(row.prefixText || '')}</td></tr>`).join('')}</tbody></table></div>`, 'margin-top:10px');
        }

        function temporalAttributionPanel(analysis) {
            const attribution = analysis.temporalAttribution || {};
            const steps = attribution.steps || [];
            if (!steps.length) return errorPanel('This analysis artifact predates the shared temporal attribution ledger. Rebuild it before treating the curve as explainable.');
            const summary = attribution.summary || {};
            const selectedIndex = Math.min(Math.max(0, state.selectedAttributionStep), steps.length - 1);
            const selected = steps[selectedIndex] || {};
            const allocations = selected.enteredComponents || [];
            return panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Where every predicted drop comes from</div><div style="font-size:8px;color:${C.mute};line-height:1.55;margin-top:2px">Each bar is one exact transition in the headline curve. Gray is the population time-baseline movement; purple is the semantic-prefix movement relative to that baseline. Component colors identify which exact-cover phrases supplied newly entered tokens.</div></div><div style="font-size:7px;color:${C.amber};max-width:470px;text-align:right;line-height:1.5">${esc(attribution.claimBoundary || '')}</div></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:7px">${stat('total predicted drop', `${signed(summary.totalPredictedDropPoints, 2)} pp`, C.cyan)}${stat('baseline movement', `${signed(summary.totalBaselineDeltaPoints, 2)} pp`, C.faint)}${stat('semantic shape movement', `${signed(summary.totalSemanticShapeDeltaPoints, 2)} pp`, C.purple)}${stat('unchanged-prefix movement', `${signed(summary.unassignedTimeModelDeltaPoints, 2)} pp`, C.amber, 'separate time model; no new component entered')}</div><canvas data-pl-canvas="attribution" style="display:block;width:100%;height:300px;margin-top:7px"></canvas><div style="display:grid;grid-template-columns:minmax(220px,.55fr) minmax(0,1.45fr);gap:9px;margin-top:8px"><div style="background:${C.card2};padding:8px"><div style="font-size:8px;color:${C.cyan};font-weight:900">SELECTED ${fmt(selected.startSeconds, 1)}–${fmt(selected.endSeconds, 1)}s</div><div style="font-size:13px;color:${C.text};font-weight:900;line-height:1.4;margin:3px 0">${esc(selected.enteredText || 'No newly completed words')}</div><div style="font-size:8px;color:${C.dim};line-height:1.6">start ${pct(selected.startRetentionPercent)}<br>baseline movement ${signed(selected.baselineDeltaPoints, 2)} pp<br>semantic-prefix movement ${signed(selected.semanticShapeDeltaPoints, 2)} pp<br><b style="color:${C.text}">predicted movement ${signed(selected.predictedDeltaPoints, 2)} pp</b><br>end ${pct(selected.endRetentionPercent)}${selected.observedDeltaPoints == null ? '' : `<br>observed movement ${signed(selected.observedDeltaPoints, 2)} pp`}<br>driver: ${esc(selected.driver || '')}</div></div><div style="background:${C.card2};padding:8px"><div style="font-size:8px;color:${C.text};font-weight:900;margin-bottom:5px">Entered component allocation</div>${allocations.length ? allocations.map(row => `<button data-pl-component="${row.componentIndex}" style="display:grid;grid-template-columns:minmax(160px,1fr) repeat(3,minmax(72px,.3fr));gap:5px;width:100%;border:1px solid ${C.border};border-left:4px solid ${colorForCluster(row.category)};background:${C.card};color:${C.text};padding:6px;text-align:left;cursor:pointer;margin-bottom:4px;font-size:8px"><span><b style="color:${colorForCluster(row.category)}">C${row.category} · component ${row.componentIndex + 1}</b><br>${esc(row.text)}</span><span>${row.overlapTokens} tokens<br>${pct(Number(row.weight || 0) * 100)} weight</span><span>model ${signed(row.predictedDeltaPoints, 2)} pp</span><span>semantic ${signed(row.semanticShapeDeltaPoints, 2)} pp</span></button>`).join('') : `<div style="font-size:8px;color:${C.mute}">No component entered during this transition. The movement comes from the independently fitted time baseline and the same unchanged semantic prefix under the next time model.</div>`}</div></div><div style="overflow:auto;max-height:360px;margin-top:8px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['interval', 'exact entered words', 'components', 'predicted Δ', 'baseline Δ', 'semantic Δ', 'observed Δ'].map(value => `<th style="position:sticky;top:0;background:${C.card};text-align:right;padding:4px;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${steps.map((row, index) => `<tr data-pl-attribution-step="${index}" style="cursor:pointer;background:${index === selectedIndex ? C.cyan + '12' : 'transparent'}"><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.cyan}">${fmt(row.startSeconds, 1)}–${fmt(row.endSeconds, 1)}s</td><td style="text-align:left;padding:4px;border-bottom:1px solid ${C.border};max-width:440px;color:${C.text}">${esc(row.enteredText || '— unchanged prefix —')}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${(row.enteredComponents || []).map(item => `<span style="color:${colorForCluster(item.category)}">C${item.category}.${item.componentIndex + 1}</span>`).join(' + ') || 'time only'}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};font-weight:900">${signed(row.predictedDeltaPoints, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border}">${signed(row.baselineDeltaPoints, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.purple}">${signed(row.semanticShapeDeltaPoints, 2)}</td><td style="text-align:right;padding:4px;border-bottom:1px solid ${C.border};color:${C.green}">${row.observedDeltaPoints == null ? '—' : signed(row.observedDeltaPoints, 2)}</td></tr>`).join('')}</tbody></table></div>`, 'margin-top:10px');
        }

        function validationPanel(analysis) {
            const validation = ((analysis.validation || {}).entryIndexed || {});
            const random = validation.randomFold || {};
            const chronological = validation.chronological || {};
            const inference = random.pairedImprovementInference || {};
            return panel(`<div style="display:flex;justify-content:space-between;gap:9px;align-items:flex-start;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Validation by second</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">Every stored timewise RMSE value is plotted. Random folds measure same-era association; chronological folds test past-to-future transfer.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap">${stat('random MAE', `${fmt(random.heldoutMAEPercentagePoints, 2)} pp`, C.cyan)}${stat('chronological MAE', `${fmt(chronological.heldoutMAEPercentagePoints, 2)} pp`, C.amber)}${stat('paired p', fmt(inference.p, 4), C.purple)}${stat('80% band coverage', pct(Number(random.empiricalBandCoverage || 0) * 100), C.green)}</div></div><canvas data-pl-canvas="validation" style="display:block;width:100%;height:270px;margin-top:7px"></canvas><div style="font-size:8px;color:${C.dim};line-height:1.55;margin-top:5px">Random source MAE p50 ${fmt(random.sourceMAEP50PercentagePoints, 2)} pp · p80 ${fmt(random.sourceMAEP80PercentagePoints, 2)} pp · p90 ${fmt(random.sourceMAEP90PercentagePoints, 2)} pp · mean timewise Spearman ${fmt(random.meanTimewiseSpearman, 3)}. Chronological source MAE p50 ${fmt(chronological.sourceMAEP50PercentagePoints, 2)} pp · p80 ${fmt(chronological.sourceMAEP80PercentagePoints, 2)} pp · p90 ${fmt(chronological.sourceMAEP90PercentagePoints, 2)} pp · mean timewise Spearman ${fmt(chronological.meanTimewiseSpearman, 3)}.</div>`, 'margin-top:10px');
        }

        function dataCoveragePanel(analysis, lattice) {
            const provenance = analysis.provenance || {};
            const support = analysis.support || {};
            const input = analysis.input || {};
            const edgeCounts = (lattice || {}).edgeCounts || {};
            const rows = [
                ['curve points', (((analysis.curves || {}).entryIndexed || {}).timesSeconds || []).length],
                ['causal prefixes', (analysis.causalPrefixTrace || []).length],
                ['temporal transitions', ((analysis.temporalAttribution || {}).steps || []).length],
                ['selected components', (analysis.components || []).length],
                ['canonical relationships', (analysis.relationships || []).length],
                ['lattice nodes', ((lattice || {}).nodes || []).length],
                ['lattice edges', ((lattice || {}).edges || []).length],
            ];
            return panel(`<div style="font-size:11px;color:${C.text};font-weight:900">Analysis data ledger</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">This inventory makes omissions visible. Counts come from the same analysis object rendered above, not a parallel summary.</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:6px;margin-top:7px">${rows.map(row => `<div style="background:${C.card2};padding:7px"><div style="font-size:7px;color:${C.mute};text-transform:uppercase;font-weight:900">${esc(row[0])}</div><div style="font-size:17px;color:${C.text};font-weight:900">${Number(row[1] || 0).toLocaleString()}</div></div>`).join('')}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:7px;margin-top:8px"><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Lattice edge families</b><br>${Object.entries(edgeCounts).map(([key, value]) => `${esc(key)} ${Number(value).toLocaleString()}`).join(' · ') || 'typed lattice not loaded'}</div><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Support</b><br>${support.trainingTokenCountMinimum || '—'}–${support.trainingTokenCountMaximum || '—'} training tokens · ${fmt(support.estimatedSpokenSeconds, 2)}s analyzed · ${support.isExtrapolation ? 'outside measured length support' : 'inside measured length support'}</div><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Automatic timing</b><br>${numeric(input.wordsPerSecond) == null ? 'saved source-media timestamps' : `${fmt(input.wordsPerSecond, 3)} words/second · ${fmt(input.estimatedSpokenSeconds, 3)}s estimated`}<br>${esc(input.timingSource || 'measured source-media word intervals')}</div><div style="background:${C.card2};padding:8px;font-size:8px;color:${C.dim};line-height:1.55"><b style="color:${C.text}">Serving provenance</b><br>${Object.entries(provenance).filter(([, value]) => typeof value === 'boolean').map(([key, value]) => `${esc(key)}: <b style="color:${value ? C.green : C.amber}">${value ? 'yes' : 'no'}</b>`).join(' · ') || 'saved row: source-level out-of-fold prediction'}</div></div>`, 'margin-top:10px');
        }

        function renderAnalysis(analysis, lattice) {
            if (!analysis) return '';
            const source = analysis.sourceKind || '';
            const input = analysis.input || {};
            return `<div data-pl-analysis>${panel(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div style="min-width:260px;flex:1"><div style="font-size:8px;color:${C.cyan};font-weight:900;text-transform:uppercase">${esc(source)}</div><div style="font-size:16px;color:${C.text};font-weight:900;line-height:1.35;margin-top:3px">${esc(analysis.title || input.analyzedText || analysis.text || 'Opening analysis')}</div>${analysis.title ? `<div style="font-size:8px;color:${C.dim};line-height:1.5;margin-top:3px">${esc(analysis.text || '')}</div>` : ''}</div><div style="font-size:8px;color:${C.mute};text-align:right">${analysis.tokenCount || 0} tokens · ${analysis.componentCount || (analysis.components || []).length} components<br>${fmt(analysis.analysisHorizonSeconds, 2)}s supplied/analyzed · model horizon ${fmt(analysis.modelHorizonSeconds || 20, 0)}s</div></div>${input.inputWasLongerThan20Seconds ? `<div style="margin-top:7px;font-size:8px;color:${C.amber}">Text after the estimated 20-second boundary was excluded from the predictor and is explicitly preserved in the input audit.</div>` : ''}${headline(analysis)}`)}
            ${evidencePanel(analysis)}
            ${panel(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;flex-wrap:wrap"><div><div style="font-size:11px;color:${C.text};font-weight:900">Retention prediction and measured comparison</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Entry-indexed starts every opening at 100%. The shaded band is the cross-fitted 10th–90th residual interval. Saved rows add the observed curve.</div></div><div style="display:flex;gap:4px">${button('Normalized survival', 'data-pl-curve="entryIndexed"', state.curveMode === 'entryIndexed')}${button('Raw retention', 'data-pl-curve="observedAbsolute"', state.curveMode === 'observedAbsolute')}${button(state.showStages ? 'Hide mean baseline' : 'Show mean baseline', 'data-pl-toggle-stages', state.showStages)}</div></div><canvas data-pl-canvas="retention" style="display:block;width:100%;height:370px;margin-top:5px"></canvas>`, 'margin-top:10px')}
            ${temporalAttributionPanel(analysis)}
            ${prefixTracePanel(analysis)}
            ${panel(`<div style="font-size:11px;color:${C.text};font-weight:900">What changed the endpoint prediction</div><div style="font-size:8px;color:${C.mute};margin-top:2px">The purple semantic-prefix delta is applied. Amber and red 20-second endpoint counterfactuals remain visible but contribute zero.</div><canvas data-pl-canvas="contributions" style="display:block;width:100%;height:230px;margin-top:5px"></canvas>`, 'margin-top:10px')}
            ${componentPanel(analysis, lattice)}
            ${panel(`<div style="font-size:11px;color:${C.text};font-weight:900">Attention-like relational and drop graph</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Canonical components are nodes; node size tracks the magnitude of timeline-accounted retention movement when that component's tokens enter. Sequence edges show the withheld adjacent-relation counterfactual. Click a node to open all of its evidence.</div><canvas data-pl-canvas="relationships" style="display:block;width:100%;height:290px;margin-top:5px"></canvas>`, 'margin-top:10px')}
            ${relationshipPanel(analysis)}
            ${latticeInspector(lattice)}
            ${validationPanel(analysis)}
            ${dataCoveragePanel(analysis, lattice)}</div>`;
        }

        function renderScorer() {
            const result = state.scoreResult;
            return `<div><div style="font-size:15px;color:${C.text};font-weight:900">Score an opening</div><div style="font-size:8px;color:${C.mute};line-height:1.5;margin-top:2px">The same frozen feature builder and renderer used for every measured library opening. Timing is derived automatically from lexical word count and the mean speaking rate measured across your source videos. Text beyond the estimated 20-second boundary is visibly scoped rather than silently forecast.</div>
            ${panel(`<label style="display:block"><span style="display:block;font-size:8px;color:${C.mute};font-weight:900;margin-bottom:4px">OPENING TEXT</span><textarea data-pl-score-text maxlength="2400" rows="6" placeholder="Type any opening text…" style="width:100%;box-sizing:border-box;resize:vertical;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:9px;font:10px/1.5 inherit">${esc(state.scoreText)}</textarea></label><div data-pl-score-controls style="display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:7px;align-items:end;margin-top:7px"><label><span style="display:block;font-size:8px;color:${C.mute};font-weight:900;margin-bottom:4px">OPTIONAL IDEA CONTEXT · GRAPH ONLY</span><input data-pl-score-idea value="${esc(state.scoreIdea)}" maxlength="1200" style="width:100%;box-sizing:border-box;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:8px;font-size:9px"></label>${button(state.scoreLoading ? 'Scoring…' : 'Score opening', 'data-pl-score', true)}</div>`, 'margin-top:8px')}
            ${state.scoreError ? `<div style="margin-top:8px">${errorPanel(state.scoreError)}</div>` : ''}
            ${state.scoreLoading ? `<div style="margin-top:8px">${loadingPanel(state.scoreStatus || 'Scoring opening')}</div>` : ''}
            ${result ? `<div style="margin-top:10px">${renderAnalysis(result, result.componentLattice)}</div>` : ''}</div>`;
        }

        function renderLibrary() {
            const summary = state.data.openingPredictions;
            if (!summary) return state.errors.openingPredictions ? errorPanel(state.errors.openingPredictions) : loadingPanel('Loading 208 measured openings and out-of-fold predictions…');
            const query = state.query.trim().toLowerCase();
            let rows = (summary.rows || []).filter(row => !query || `${row.title || ''} ${row.text || ''} ${row.videoId}`.toLowerCase().includes(query));
            rows = rows.slice().sort((a, b) => {
                if (state.sort === 'error') return Math.abs((b.predictionError || {}).retainedAt20sPoints || 0) - Math.abs((a.predictionError || {}).retainedAt20sPoints || 0);
                if (state.sort === 'actual') return ((b.actual || {}).retainedAt20sPercent || 0) - ((a.actual || {}).retainedAt20sPercent || 0);
                return ((b.outputs || {}).retainedAtAnalyzedEndPercent || 0) - ((a.outputs || {}).retainedAtAnalyzedEndPercent || 0);
            });
            return `<div><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;flex-wrap:wrap"><div><div style="font-size:15px;color:${C.text};font-weight:900">Opening library</div><div style="font-size:8px;color:${C.mute};margin-top:2px">${summary.sources || rows.length} source-aligned Shorts openings · saved values are out of fold · each row is measured through 20 seconds</div></div><div style="display:flex;gap:5px">${button('Predicted', 'data-pl-sort="predicted"', state.sort === 'predicted')}${button('Actual', 'data-pl-sort="actual"', state.sort === 'actual')}${button('Largest error', 'data-pl-sort="error"', state.sort === 'error')}</div></div>
            ${panel(`<input data-pl-query value="${esc(state.query)}" placeholder="Search title, opening, or video ID" style="width:100%;box-sizing:border-box;background:${C.card2};border:1px solid ${C.border};color:${C.text};padding:8px;font-size:9px"><div style="max-height:520px;overflow:auto;margin-top:7px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['opening', 'exact components and clusters', 'predicted R20', 'actual R20', 'error', 'actual views'].map(value => `<th style="position:sticky;top:0;background:${C.card};padding:5px;text-align:right;color:${C.mute};border-bottom:1px solid ${C.border}">${value}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr data-pl-video="${esc(row.videoId)}" style="cursor:pointer;background:${String(row.videoId) === String(state.selectedVideo) ? C.cyan + '12' : 'transparent'}"><td style="padding:6px;text-align:left;border-bottom:1px solid ${C.border};max-width:420px"><b style="display:block;color:${C.text};font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.title || row.videoId)}</b><span style="display:block;color:${C.mute};line-height:1.4;max-height:34px;overflow:hidden">${esc(row.text || '')}</span></td><td style="padding:6px;text-align:left;border-bottom:1px solid ${C.border};min-width:320px;max-width:620px"><div style="font-size:7px;color:${C.mute};margin-bottom:3px">${row.componentCount} components</div><div style="display:flex;flex-wrap:wrap;gap:2px">${(row.components || []).map(component => `<span title="tokens ${component.startToken}–${component.endToken}" style="border-left:3px solid ${colorForCluster(component.category)};background:${colorForCluster(component.category)}12;color:${C.text};padding:2px 4px;font-size:7px;line-height:1.3"><b style="color:${colorForCluster(component.category)}">C${component.category}</b> ${esc(component.text)}</span>`).join('') || (row.categorySequence || []).map((category, index) => `<span style="color:${colorForCluster(category)}">C${category}.${index + 1}</span>`).join(' · ')}</div></td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border};color:${C.green};font-weight:900">${pct((row.outputs || {}).retainedAtAnalyzedEndPercent)}</td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border}">${pct((row.actual || {}).retainedAt20sPercent)}</td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border};color:${Math.abs((row.predictionError || {}).retainedAt20sPoints || 0) > 7 ? C.red : C.dim}">${signed((row.predictionError || {}).retainedAt20sPoints, 1)} pp</td><td style="padding:6px;text-align:right;border-bottom:1px solid ${C.border}">${compact((row.actual || {}).views)}</td></tr>`).join('')}</tbody></table></div>`, 'margin-top:8px')}
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
            return `<div id="pl-root" style="color:${C.text};font-family:Nunito,sans-serif;max-width:100%;overflow-x:hidden"><style>#pl-root button:focus-visible,#pl-root input:focus-visible,#pl-root textarea:focus-visible{outline:2px solid ${C.cyan};outline-offset:1px}@media(max-width:760px){#pl-root [data-pl-analysis] section>div[style*='grid-template-columns'],#pl-root [data-pl-score-controls]{grid-template-columns:1fr!important}#pl-root canvas{max-height:330px}#pl-root table{min-width:620px}}</style><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:9px"><div><div style="font-size:19px;color:${C.cyan};font-weight:900">Promise Lab</div><div style="font-size:8px;color:${C.mute};margin-top:2px">Shorts opening semantics → measured retention through 20 seconds</div></div><div style="display:flex;gap:5px;flex-wrap:wrap">${tabs.map(([id, label]) => button(label, `data-pl-view="${id}"`, state.view === id)).join('')}</div></div>${body}</div>`;
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
            if (!points.length) return;
            ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.setLineDash(dash || []);
            ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1])); ctx.stroke(); ctx.setLineDash([]);
        }

        function drawRetention(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const family = ((analysis.curves || {})[state.curveMode]) || {};
            const times = family.timesSeconds || analysis.predictionTimesSeconds || [];
            const predicted = family.predicted || [];
            const lower = family.predictionP10 || [];
            const upper = family.predictionP90 || [];
            const actual = family.actual || [];
            if (!times.length || !predicted.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const values = [...predicted, ...lower, ...upper, ...actual].filter(value => numeric(value) != null);
            const yMin = Math.floor((Math.min(...values, 40) - 4) / 5) * 5;
            const yMax = Math.ceil((Math.max(...values, 100) + 4) / 5) * 5;
            const axes = drawAxes(ctx, sized.width, sized.height, 'seconds', '% retained', 0, Math.max(...times), yMin, yMax);
            (analysis.components || []).forEach((component, index) => {
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
            if (lower.length === times.length && upper.length === times.length) {
                ctx.fillStyle = C.cyan + '20'; ctx.beginPath();
                times.forEach((time, index) => index ? ctx.lineTo(axes.X(time), axes.Y(upper[index])) : ctx.moveTo(axes.X(time), axes.Y(upper[index])));
                [...times].reverse().forEach((time, reversed) => { const index = times.length - 1 - reversed; ctx.lineTo(axes.X(time), axes.Y(lower[index])); });
                ctx.closePath(); ctx.fill();
            }
            if (state.showStages && family.stages) {
                const stageColors = { baseline: C.faint, semanticPrefix: C.purple };
                Object.entries(family.stages).forEach(([name, valuesRow]) => line(ctx, times.map((time, index) => [axes.X(time), axes.Y(valuesRow[index])]), stageColors[name], 1, [4, 4]));
            }
            line(ctx, times.map((time, index) => [axes.X(time), axes.Y(predicted[index])]), C.cyan, 3);
            if (actual.length === times.length) line(ctx, times.map((time, index) => [axes.X(time), axes.Y(actual[index])]), C.green, 2.5);
            ctx.font = '8px sans-serif'; ctx.fillStyle = C.cyan; ctx.fillText('predicted', sized.width - 140, 14);
            if (actual.length) { ctx.fillStyle = C.green; ctx.fillText('actual', sized.width - 78, 14); }
        }

        function drawContributions(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const row = (analysis.contributions || {}).at20Seconds || (analysis.contributions || {}).atAnalyzedEnd || {};
            const bars = [
                { label: 'mean curve', value: numeric(row.baselinePercent) || 0, absolute: true, color: C.faint, applied: true },
                { label: 'causal prefix semantics', value: numeric(row.semanticDeltaPoints) || 0, color: C.purple, applied: true },
                { label: 'component candidate', value: numeric(row.componentStructureDeltaPoints), color: C.amber, applied: false },
                { label: 'relationship candidate', value: numeric(row.relationshipDeltaPoints), color: C.red, applied: false },
            ];
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const zero = 58; const plot = sized.width - 80;
            const maxDelta = Math.max(1, ...bars.slice(1).map(bar => Math.abs(bar.value)));
            bars.forEach((bar, index) => {
                const y = 24 + index * 47; ctx.fillStyle = C.text; ctx.font = '9px sans-serif'; ctx.fillText(bar.label, 8, y + 12);
                if (bar.absolute) {
                    const width = Math.max(1, plot * Math.max(0, Math.min(100, bar.value)) / 100);
                    ctx.fillStyle = bar.color; ctx.globalAlpha = .7; ctx.fillRect(zero, y, width, 18); ctx.globalAlpha = 1;
                    ctx.fillText(`${fmt(bar.value, 1)}%`, zero + width + 5, y + 12);
                } else {
                    if (bar.value == null) {
                        ctx.fillStyle = C.mute; ctx.fillText('not estimated at this endpoint', zero + 6, y + 12);
                        return;
                    }
                    const center = zero + plot / 2; const width = Math.abs(bar.value) / maxDelta * (plot / 2 - 20);
                    ctx.strokeStyle = C.border2; ctx.beginPath(); ctx.moveTo(center, y - 3); ctx.lineTo(center, y + 23); ctx.stroke();
                    ctx.fillStyle = bar.color; ctx.globalAlpha = bar.applied ? .85 : .28;
                    ctx.fillRect(bar.value >= 0 ? center : center - width, y, width, 18); ctx.globalAlpha = 1;
                    ctx.fillStyle = bar.applied ? C.text : C.amber;
                    ctx.fillText(`${signed(bar.value, 2)} pp · ${bar.applied ? 'applied' : 'withheld'}`, bar.value >= 0 ? center + width + 5 : Math.max(4, center - width - 92), y + 12);
                }
            });
        }

        function drawAttribution(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const steps = ((analysis.temporalAttribution || {}).steps || []); if (!steps.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const pad = { l: 46, r: 14, t: 18, b: 36 };
            const values = steps.flatMap(row => [Number(row.baselineDeltaPoints || 0), Number(row.semanticShapeDeltaPoints || 0), Number(row.predictedDeltaPoints || 0)]);
            const limit = Math.max(1, ...values.map(value => Math.abs(value))) * 1.15;
            const X = index => pad.l + (index + .5) / steps.length * (sized.width - pad.l - pad.r);
            const Y = value => pad.t + (limit - value) / (2 * limit) * (sized.height - pad.t - pad.b);
            const zero = Y(0);
            ctx.strokeStyle = C.border2; ctx.beginPath(); ctx.moveTo(pad.l, zero); ctx.lineTo(sized.width - pad.r, zero); ctx.stroke();
            ctx.fillStyle = C.mute; ctx.font = '8px sans-serif'; ctx.fillText('+ retention', 3, pad.t + 5); ctx.fillText('− retention', 3, sized.height - pad.b); ctx.fillText('seconds', sized.width / 2 - 15, sized.height - 8);
            const barWidth = Math.max(2, Math.min(12, (sized.width - pad.l - pad.r) / steps.length * .28));
            const geometry = [];
            steps.forEach((row, index) => {
                const center = X(index); const baseline = Number(row.baselineDeltaPoints || 0); const semantic = Number(row.semanticShapeDeltaPoints || 0);
                const drawBar = (value, x, color) => { ctx.fillStyle = color; ctx.globalAlpha = .82; const top = Math.min(zero, Y(value)); ctx.fillRect(x, top, barWidth, Math.max(1, Math.abs(Y(value) - zero))); ctx.globalAlpha = 1; };
                drawBar(baseline, center - barWidth - 1, C.faint); drawBar(semantic, center + 1, C.purple);
                const allocations = row.enteredComponents || [];
                if (allocations.length) { ctx.fillStyle = colorForCluster(allocations[0].category); ctx.fillRect(center - barWidth, pad.t - 5, barWidth * 2, 4); }
                if (index === Math.min(state.selectedAttributionStep, steps.length - 1)) { ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.5; ctx.strokeRect(center - barWidth - 4, pad.t - 8, barWidth * 2 + 8, sized.height - pad.t - pad.b + 12); }
                if (index % Math.max(1, Math.ceil(steps.length / 10)) === 0) { ctx.fillStyle = C.mute; ctx.font = '7px sans-serif'; ctx.fillText(fmt(row.endSeconds, 0), center - 4, sized.height - 22); }
                geometry.push({ x: center, y: zero, index });
            });
            canvas._plAttributionBars = geometry;
        }

        function drawComponentResponse(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const component = activeComponent(analysis); const measurements = component.measurements || {};
            const rows = state.measurementMode === 'reverse' ? (measurements.reverseControls || []) : (measurements.forward || []);
            const valid = rows.filter(row => row.measuredWithin20s && numeric((row.entry_indexed || {}).slopePercentPerSecond) != null);
            if (!valid.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const xs = valid.map(row => Number(row.lagSeconds));
            const entry = valid.map(row => Number(row.entry_indexed.slopePercentPerSecond));
            const raw = valid.map(row => Number((row.observed_absolute || {}).slopePercentPerSecond));
            const values = [...entry, ...raw].filter(value => Number.isFinite(value));
            const min = Math.min(...values, -1); const max = Math.max(...values, 1);
            const axes = drawAxes(ctx, sized.width, sized.height, 'response lag (seconds)', 'retention slope pp/s', Math.min(...xs), Math.max(...xs), min, max);
            line(ctx, valid.map((row, index) => [axes.X(row.lagSeconds), axes.Y(entry[index])]), C.cyan, 2.5);
            line(ctx, valid.map((row, index) => [axes.X(row.lagSeconds), axes.Y(raw[index])]), C.green, 2);
            valid.forEach((row, index) => { [[entry[index], C.cyan], [raw[index], C.green]].forEach(([value, color]) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(axes.X(row.lagSeconds), axes.Y(value), 3, 0, Math.PI * 2); ctx.fill(); }); });
            ctx.fillStyle = C.cyan; ctx.font = '8px sans-serif'; ctx.fillText('entry-indexed', sized.width - 150, 13); ctx.fillStyle = C.green; ctx.fillText('raw observed', sized.width - 78, 13);
        }

        function drawValidation(canvas) {
            const analysis = activeAnalysis().prediction; if (!analysis) return;
            const validation = ((analysis.validation || {}).entryIndexed || {});
            const random = (validation.randomFold || {}).modelRMSEByTimePercentagePoints || [];
            const chronological = (validation.chronological || {}).modelRMSEByTimePercentagePoints || [];
            if (!random.length && !chronological.length) return;
            const sized = clearCanvas(canvas); const ctx = sized.context;
            const values = [...random, ...chronological].filter(value => numeric(value) != null);
            const max = Math.max(1, ...values) * 1.1; const length = Math.max(random.length, chronological.length);
            const axes = drawAxes(ctx, sized.width, sized.height, 'seconds', 'RMSE percentage points', 0, Math.max(1, length - 1), 0, max);
            if (random.length) line(ctx, random.map((value, index) => [axes.X(index), axes.Y(value)]), C.cyan, 2.5);
            if (chronological.length) line(ctx, chronological.map((value, index) => [axes.X(index), axes.Y(value)]), C.amber, 2.5);
            ctx.fillStyle = C.cyan; ctx.font = '8px sans-serif'; ctx.fillText('random folds', sized.width - 150, 13); ctx.fillStyle = C.amber; ctx.fillText('chronological', sized.width - 76, 13);
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
                const impact = ((row.predictionImpact || {}).entryIndexed || {}).retention20sPoints;
                const applied = false;
                const x1 = x(row.left), x2 = x(row.right); const lift = 45 + Math.min(70, Math.abs(Number(impact || 0)) * 9);
                ctx.strokeStyle = applied ? C.green : C.amber; ctx.globalAlpha = applied ? .8 : .32; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(x1, y); ctx.quadraticCurveTo((x1 + x2) / 2, y - lift, x2, y); ctx.stroke(); ctx.globalAlpha = 1;
                ctx.fillStyle = applied ? C.green : C.amber; ctx.font = '7px sans-serif'; ctx.fillText(impact == null ? 'withheld' : `${signed(impact, 2)}pp`, (x1 + x2) / 2 - 16, y - lift + 9);
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

        function drawAll() {
            if (!host) return;
            host.querySelectorAll('canvas[data-pl-canvas]').forEach(canvas => {
                const kind = canvas.dataset.plCanvas;
                if (kind === 'retention') drawRetention(canvas);
                else if (kind === 'contributions') drawContributions(canvas);
                else if (kind === 'attribution') drawAttribution(canvas);
                else if (kind === 'component-response') drawComponentResponse(canvas);
                else if (kind === 'component-map') drawComponentMap(canvas);
                else if (kind === 'validation') drawValidation(canvas);
                else if (kind === 'relationships') drawRelationships(canvas);
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
            if (sort) { state.sort = sort.dataset.plSort; paint(); return true; }
            const video = target.closest('[data-pl-video]');
            if (video) { loadVideo(video.dataset.plVideo); return true; }
            const component = target.closest('[data-pl-component]');
            if (component) { state.selectedComponent = Number(component.dataset.plComponent); state.selectedLatticeNode = null; state.savedPoint = null; paint(); return true; }
            const attributionStep = target.closest('[data-pl-attribution-step]');
            if (attributionStep) { state.selectedAttributionStep = Number(attributionStep.dataset.plAttributionStep); paint(); return true; }
            const measurementMode = target.closest('[data-pl-measurement-mode]');
            if (measurementMode) { state.measurementMode = measurementMode.dataset.plMeasurementMode; paint(); return true; }
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
                }
                return true;
            }
            return false;
        }

        function handleInput(event) {
            if (event.target.matches('[data-pl-score-text]')) { state.scoreText = event.target.value; return true; }
            if (event.target.matches('[data-pl-score-idea]')) { state.scoreIdea = event.target.value; return true; }
            if (event.target.matches('[data-pl-query]')) { state.query = event.target.value; return true; }
            return false;
        }

        function handleChange(event) {
            if (event.target.matches('[data-pl-query]')) { state.query = event.target.value; paint(); return true; }
            return false;
        }

        function render() { window.requestAnimationFrame(() => { host = document.querySelector('#pl-root'); drawAll(); }); return renderBody(); }
        function afterRender() { host = document.querySelector('#pl-root'); ensureViewData(); drawAll(); }
        return { render, afterRender, handleClick, handleInput, handleChange, _state: state };
    };
}());
