(function () {
    'use strict';

    window.createLongQuantPromiseLab = function createLongQuantPromiseLab(deps) {
        const C = deps.colors;
        const esc = deps.escape;
        const state = {
            view: 'overview', data: {}, loading: {}, errors: {},
            hookId: null, hook: null, componentId: null, representation: 'influence',
            mapIndex: 0, mapPage: 0, metric: 'ctrviews', sourceId: null, source: null,
            axisIndex: 0, registryPage: 0, hookQuery: '', registryQuery: '', registryStage: 'all',
            atlasScope: 'supported',
        };
        let progressTimer = null;
        let hookRequest = 0;
        let sourceRequest = 0;

        const api = name => `/api/longquant/promise-lab/${name}`;
        const fmt = (value, digits = 2) => value == null || !isFinite(value) ? '-' : Number(value).toFixed(digits);
        const pct = value => value == null || !isFinite(value) ? '-' : `${Number(value).toFixed(1)}%`;
        const signed = (value, digits = 2) => value == null || !isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${Number(value).toFixed(digits)}`;
        const metricLabel = name => ({
            ctrviews: 'CTR + views', ctr: 'CTR', ret30: '30-second retention',
            views: 'views', scaled_views: 'scaled views', realviews: 'realistic views',
            gt10m: '10M-view class',
        })[name] || name;
        const representationLabel = name => ({
            raw: 'raw source span', influence: 'deletion influence',
            nonadditive: 'non-additive source span', context: 'retained hook context',
        })[name] || name;
        const clusterColor = label => `hsl(${(Number(label || 0) * 137.508) % 360} 72% 62%)`;
        const card = (body, extra = '') => `<section style="background:${C.card};border:1px solid ${C.border};border-radius:8px;padding:12px;${extra}">${body}</section>`;
        const stat = (label, value, color = C.text) => `<div style="min-width:112px;border-left:2px solid ${color};padding:3px 9px"><div style="font-size:9px;color:${C.mute};text-transform:uppercase">${esc(label)}</div><div style="font-size:17px;font-weight:900;color:${color}">${esc(String(value))}</div></div>`;
        const button = (label, attr, active = false) => `<button ${attr} style="border:1px solid ${active ? C.cyan : C.border};background:${active ? C.cyan + '1c' : C.card2};color:${active ? C.cyan : C.dim};border-radius:6px;padding:5px 9px;font-size:10px;font-weight:800;cursor:pointer">${esc(label)}</button>`;
        const statusColor = status => status === 'complete' || status === 'validated' || status === 'supported' ? C.green : status === 'error' ? C.red : C.amber;
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
            if (state.view === 'overview') load('findings');
            if (state.view === 'hooks' || state.view === 'boundaries') load('discovery');
            if (state.view === 'components' || state.view === 'clusters') {
                if (state.atlasScope === 'all') load('allSpanAtlas', api('all-span-atlas'));
                else load('atlas');
            }
            if (state.view === 'swaps') load('swaps');
            if (state.view === 'axes') load('axes');
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
                ['overview', 'Results'], ['hooks', 'Hooks'], ['boundaries', 'Boundaries'],
                ['components', 'Embeddings'], ['clusters', 'Cluster atlas'], ['swaps', 'Swaps'],
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

        function renderOverview() {
            const manifest = state.data.manifest;
            const findings = state.data.findings;
            if (!manifest || !findings) return loading(!manifest ? 'manifest' : 'findings');
            const counts = manifest.counts || {};
            const boundary = findings.boundary || {}, cluster = findings.cluster || {}, swap = findings.swap || {}, axis = findings.axis || {};
            const crossScope = cluster.crossScope || {}, consensusAgreement = crossScope.consensusAgreement || {};
            const supportedHooks = boundary.supportedHooks || [];
            const transferRows = ((swap.topTransferByMetric || {})[state.metric] || []).slice(0, 8);
            const axisRows = axis.selectedByTarget || [];
            const representationRows = cluster.allSpanRepresentationIndicators || [];
            return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
                ${stat('complete hooks', counts.hooks || 0, C.cyan)}${stat('embedding texts', Number(counts.embeddingTexts || 0).toLocaleString(), C.purple)}
                ${stat('boundary runs', Number(counts.boundaryExperiments || 0).toLocaleString(), C.amber)}${stat('cluster runs', Number(counts.clusterExperiments || 0).toLocaleString(), C.green)}
                ${stat('cluster maps', Number(counts.clusterMaps || 0) + Number(counts.allSpanClusterMaps || 0), C.orange)}${stat('all spans', Number(counts.allContiguousSpans || 0).toLocaleString(), C.purple)}${stat('swap rows', Number(counts.swapRows || 0).toLocaleString(), C.cyan)}${stat('axis runs', Number(counts.axisExperiments || 0).toLocaleString(), C.purple)}
            </div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:9px;margin-bottom:10px">
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.amber};margin-bottom:5px">Boundary evidence</div><div style="font-size:24px;font-weight:900;color:${C.text}">${boundary.supportedMultiSegmentHooks || 0}</div><div style="font-size:10px;color:${C.dim}">hooks with search-wide support for more than one semantic unit</div><div style="font-size:9px;color:${C.mute};margin-top:5px">${boundary.noSeparableComponentEvidence || 0} returned no separable component evidence. Nothing is forced.</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.green};margin-bottom:5px">Two outcome-blind atlases</div><div style="font-size:24px;font-weight:900;color:${C.text}">${Number(cluster.experiments || 0).toLocaleString()} + ${Number(cluster.allContiguousExperiments || 0).toLocaleString()}</div><div style="font-size:10px;color:${C.dim}">evidence-supported candidates plus every contiguous span across 12 semantic and residual views</div><div style="font-size:9px;color:${C.mute};margin-top:5px">${Number(cluster.mapsVisible || 0) + Number(cluster.allContiguousMapsVisible || 0)} maps are inspectable · cross-scope consensus rho ${fmt(consensusAgreement.spearman, 3)}. Families remain unnamed.</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.cyan};margin-bottom:5px">Crossed transfer surface</div><div style="font-size:24px;font-weight:900;color:${C.text}">${Number(swap.rows || 0).toLocaleString()}</div><div style="font-size:10px;color:${C.dim}">source-component by target-hook recompositions</div><div style="font-size:9px;color:${C.mute};margin-top:5px">Model-predicted Long Quant evidence is kept separate from observed YouTube outcomes.</div>`)}
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.purple};margin-bottom:5px">Held-out semantic axes</div><div style="font-size:24px;font-weight:900;color:${axis.validated ? C.green : C.text}">${axis.validated || 0}</div><div style="font-size:10px;color:${C.dim}">axes surviving grouped holdout in their predeclared required-confound family and the search-wide null</div><div style="font-size:9px;color:${C.mute};margin-top:5px">${axis.modelTransferValidated || 0}/${axis.modelTransferTargets || 0} model-transfer targets · ${axis.observedValidated || 0}/${axis.observedTargets || 0} observed targets · ${axis.observedSourceSpanValidated || 0} observed source-span axes.</div>`)}
            </div>${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">What entered the calculation</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;font-size:10px;line-height:1.55">
                <div><b style="color:${C.green}">Discovery input</b><br><span style="color:${C.dim}">${esc(manifest.separation.discoveryInputs)}</span></div>
                <div><b style="color:${C.red}">Excluded from discovery</b><br><span style="color:${C.dim}">${esc(manifest.separation.discoveryExcludes)}</span></div>
                <div><b style="color:${C.cyan}">Exact embedding</b><br><span style="color:${C.dim}">${esc(manifest.embeddingModel)} at ${manifest.embeddingDimensions} dimensions, text channel only</span></div>
                <div><b style="color:${C.amber}">Outcome boundary</b><br><span style="color:${C.dim}">Outcomes join only after structures are frozen; observed and counterfactual evidence never share a label.</span></div>
                <div><b style="color:${C.purple}">Atlas scopes</b><br><span style="color:${C.dim}">${esc(manifest.separation.atlasScopes || '')}</span></div>
                <div><b style="color:${C.green}">All-span transforms</b><br><span style="color:${C.dim}">${esc(manifest.separation.allSpanTransforms || '')}</span></div></div>`)}
                ${axis.experiments ? card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">What emerged after correction</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:12px;font-size:9px;line-height:1.5"><div style="border-left:3px solid ${C.green};padding-left:8px"><b style="color:${C.green}">${axis.modelTransferValidated || 0}/${axis.modelTransferTargets || 0} model-transfer targets validated</b><br><span style="color:${C.dim}">The trained Long Quant counterfactual surface is predictable from raw source-span semantics across held-out videos.</span></div><div style="border-left:3px solid ${C.cyan};padding-left:8px"><b style="color:${C.cyan}">${axis.observedValidated || 0}/${axis.observedTargets || 0} observed targets validated</b><br><span style="color:${C.dim}">The surviving real-outcome signals concern early retention and all use the retained hook context view.</span></div><div style="border-left:3px solid ${C.amber};padding-left:8px"><b style="color:${C.amber}">${axis.observedSourceSpanValidated || 0} observed source-span axes validated</b><br><span style="color:${C.dim}">No raw, influence, or non-additive span direction yet supports declaring a measured reference-to-gratification component. This is a negative result, not a missing label.</span></div></div>`, 'margin-top:10px') : ''}
                ${representationRows.length ? card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:2px">All-span view indicators</div><div style="font-size:8px;color:${C.mute};margin-bottom:7px">Medians across the retained maps for each outcome-blind representation. Lower length/position NMI means less nuisance leakage; higher values are better for the other columns.</div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['representation', 'maps', 'null lift', 'held-out margin', 'seed ARI', 'length NMI', 'position NMI', 'cross-hook', 'cross-scope ARI', 'boundary enrichment'].map(label => `<th style="text-align:left;color:${C.mute};padding:4px;border-bottom:1px solid ${C.border};white-space:nowrap">${label}</th>`).join('')}</tr></thead><tbody>${representationRows.map(row => `<tr><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.text};font-weight:800">${esc(row.representation)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${row.maps || 0}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianMarginAboveNull, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianHeldoutHookMargin, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianSeedStabilityARI, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianLengthNMI, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianPositionNMI, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianCrossHookGenerality, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianCrossScopeARI, 3)}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${fmt(row.medianBoundarySupportEnrichment, 3)}</td></tr>`).join('')}</tbody></table></div>`, 'margin-top:10px') : ''}
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:9px;margin-top:10px">
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.amber};margin-bottom:6px">Supported sequence partitions</div><div style="font-size:8px;color:${C.mute};margin-bottom:6px">Only hooks beating the complete searched null appear here. These are geometric partitions, not named promise types.</div>${supportedHooks.length ? supportedHooks.map(row => { const seg = row.segmentation || {}; return `<button data-pl-hook="${esc(row.videoId)}" data-pl-open-hooks style="width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid ${C.border};padding:6px 0;cursor:pointer"><div style="font-size:9px;color:${C.text};font-weight:800;line-height:1.35">${esc(row.text)}</div><div style="font-size:8px;color:${C.mute}">${seg.segmentCount || '-'} segments · search p ${fmt(seg.searchWideP, 3)}</div></button>`; }).join('') : boundary.supportedMultiSegmentHooks ? `<div style="font-size:9px;color:${C.dim}">The final supported-hook detail artifact is still building.</div>` : `<div style="font-size:9px;color:${C.dim}">No hook passed the searched null.</div>`}`)}
                ${card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:6px"><div><div style="font-size:11px;font-weight:900;color:${C.cyan}">Cross-context transfer indicators</div><div style="font-size:8px;color:${C.mute}">Long Quant model-predicted counterfactuals, never observed viewer outcomes.</div></div></div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">${(swap.metricNames || []).map(name => button(metricLabel(name), `data-pl-metric="${name}"`, state.metric === name)).join('')}</div>${transferRows.map(row => `<button data-pl-source="${esc(row.sourceId)}" data-pl-open-swaps style="width:100%;display:flex;justify-content:space-between;gap:8px;border:0;border-bottom:1px solid ${C.border};background:transparent;padding:5px 0;cursor:pointer;text-align:left"><div style="font-size:9px;color:${C.text};font-weight:800">${esc(row.text)}</div><div style="text-align:right;white-space:nowrap"><b style="font-size:9px;color:${Number(row.meanDeltaAcrossContexts) >= 0 ? C.green : C.red}">${signed(row.meanDeltaAcrossContexts, 2)}</b><div style="font-size:7.5px;color:${C.mute}">${pct(Number(row.positiveContextRate || 0) * 100)} positive</div></div></button>`).join('') || `<div style="font-size:9px;color:${C.dim}">Transfer surface is still building.</div>`}`)}
                </div>
                ${card(`<div style="font-size:11px;font-weight:900;color:${C.purple};margin-bottom:3px">Selected required-confound outcome directions</div><div style="font-size:8px;color:${C.mute};margin-bottom:7px">One predeclared adjusted configuration per target. Green rows survived the target-wide max-null and cross-target FDR.</div><div style="overflow:auto;max-height:480px"><table style="width:100%;border-collapse:collapse;font-size:8px"><thead><tr>${['evidence channel', 'target', 'input / confounds', 'held-out result'].map(label => `<th style="text-align:left;color:${C.mute};padding:4px;border-bottom:1px solid ${C.border}">${label}</th>`).join('')}</tr></thead><tbody>${axisRows.map(row => `<tr><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${esc(row.targetChannel || '')}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.text}"><b>${esc(row.target || '')}</b><br><span style="color:${C.mute}">${esc(row.targetDefinition || '')}</span></td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${C.dim}">${esc(row.representation || '')} · ${esc(row.confounds || '')}</td><td style="padding:5px;border-bottom:1px solid ${C.border};color:${row.status === 'validated' ? C.green : C.dim};white-space:nowrap">rho ${fmt(row.heldoutSpearman, 3)}<br>p ${fmt(row.searchWideP, 3)} · q ${fmt(row.searchWideQ, 3)}<br>${esc(row.status || '')}</td></tr>`).join('') || `<tr><td colspan="4" style="padding:8px;color:${C.dim}">Outcome-axis search is still building.</td></tr>`}</tbody></table></div>`, 'margin-top:10px')} `;
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
            const clusterSummaries = selected.clusterSummaries || [], rows = atlasRows(atlas);
            const diagnostics = selected.lengthNMI == null ? '' : ` · length NMI ${fmt(selected.lengthNMI, 3)} · position NMI ${fmt(selected.positionNMI, 3)} · cross-hook generality ${fmt(selected.crossHookGenerality, 3)}`;
            const persistence = selected.crossScopeBestARI == null ? '' : ` · best supported-atlas ARI ${fmt(selected.crossScopeBestARI, 3)} (${esc(selected.crossScopeBestRepresentation || '')}) · boundary enrichment ${fmt(selected.boundarySupportWeightedEnrichment, 3)}`;
            return `${atlasScopeControls(atlas)}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:9px">${stat('registered experiments', Number(atlas.experimentCount || 0).toLocaleString(), C.green)}${stat('maps retained', maps.length, C.cyan)}${stat(state.atlasScope === 'all' ? 'all spans' : 'candidates', atlasCount(atlas).toLocaleString(), C.purple)}${stat('outcomes used', '0', C.amber)}</div>
            ${card(`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:6px"><div><div style="font-size:11px;font-weight:900;color:${C.text}">${esc(selected.representation || '')} · ${esc(selected.geometry || '')} · ${selected.pcaDimensions || '-'}D · k=${selected.clusterCount || '-'}</div><div style="font-size:9px;color:${C.mute}">margin above null ${fmt(selected.marginAboveNull, 3)} · held-out-hook margin ${fmt(selected.heldoutHookMargin, 3)} · seed ARI ${fmt(selected.seedStabilityARI, 3)} · entropy ${fmt(selected.entropy, 3)}${diagnostics}${persistence} · ${selected.pareto ? 'Pareto front' : 'ranked sensitivity map'}</div></div></div><canvas data-pl-canvas="cluster" style="width:100%;height:520px;display:block"></canvas>`)}
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
            const maps = axes.maps || [], map = maps[Math.max(0, Math.min(state.axisIndex, maps.length - 1))] || {};
            const selectedExperiments = maps.map(row => row.experiment || {});
            const modelAxes = selectedExperiments.filter(row => row.targetChannel === 'Long Quant model-predicted counterfactual');
            const observedAxes = selectedExperiments.filter(row => row.targetChannel === 'observed YouTube outcome');
            const validatedModel = modelAxes.filter(row => row.status === 'validated');
            const validatedObserved = observedAxes.filter(row => row.status === 'validated');
            const validatedObservedSpan = validatedObserved.filter(row => ['raw', 'influence', 'nonadditive'].includes(row.representation));
            return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:9px">${stat('axis experiments', Number(axes.experimentCount || 0).toLocaleString(), C.purple)}${stat('model transfer', `${validatedModel.length}/${modelAxes.length}`, C.green)}${stat('observed outcomes', `${validatedObserved.length}/${observedAxes.length}`, C.cyan)}${stat('observed span-level', validatedObservedSpan.length, C.amber)}${stat('source videos', axes.sourceVideos || 0, C.cyan)}${stat('confound sets', (axes.confoundSets || []).length, C.orange)}</div>
                    ${card(`<div style="font-size:9px;color:${C.dim};line-height:1.5"><b style="color:${C.text}">Current result:</b> model-predicted transfer validates on raw source-span semantics; corrected observed retention validates only on retained hook context. No observed raw, influence, or non-additive source-span axis passed. Outcome metrics measure candidate directions; they are not themselves semantic component names.</div>`, 'margin-bottom:9px')}
                    <div class="pl-split" style="display:grid;grid-template-columns:minmax(280px,.65fr) minmax(0,1.35fr);gap:9px">${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:7px">Best required-confound direction per target</div><div style="max-height:620px;overflow:auto">${maps.map((row, index) => { const exp = row.experiment || {}; return `<button data-pl-axis="${index}" style="width:100%;text-align:left;background:${index === state.axisIndex ? C.cyan + '12' : 'transparent'};border:0;border-bottom:1px solid ${C.border};padding:7px;cursor:pointer"><div style="display:flex;justify-content:space-between;gap:6px"><b style="font-size:9px;color:${C.text}">${esc(exp.target || '')}</b><b style="font-size:9px;color:${exp.status === 'validated' ? C.green : C.dim}">rho ${fmt(exp.heldoutSpearman, 3)}</b></div><div style="font-size:8px;color:${C.mute}">${esc(exp.representation || '')} · ${exp.pcaDimensions || '-'}D · ${esc(exp.confounds || '')} · search q ${fmt(exp.searchWideQ, 3)}</div></button>`; }).join('')}</div>`)}
                    ${card(`<div style="font-size:11px;font-weight:900;color:${C.text};margin-bottom:3px">${esc((map.experiment || {}).target || 'No axis built')}</div><div style="font-size:9px;color:${C.mute};margin-bottom:4px">${esc((map.experiment || {}).targetDefinition || '')}</div><div style="font-size:8px;color:${C.faint};margin-bottom:9px">channel: ${esc((map.experiment || {}).targetChannel || '')} · semantic input: ${esc(representationLabel((map.experiment || {}).representation || ''))} · unit: ${esc((map.experiment || {}).targetUnit || '')} · required confounds: ${esc((map.experiment || {}).validationConfoundsRequired || 'none')} · status: ${esc((map.experiment || {}).status || '')}</div><div style="font-size:9px;font-weight:900;color:${C.cyan};margin-bottom:3px">Semantic embedding plane</div><canvas data-pl-canvas="axis" style="width:100%;height:300px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin:4px 0 10px">Horizontal position is the final fitted semantic direction; vertical position is an outcome-blind background component. Color is the selected channel's target value.</div><div style="font-size:9px;font-weight:900;color:${C.green};margin-bottom:3px">Held-out prediction check</div><canvas data-pl-canvas="axis-oof" style="width:100%;height:300px;display:block"></canvas><div style="font-size:8px;color:${C.mute};margin-top:4px">Horizontal is grouped out-of-fold prediction; vertical is the residualized target. Every fold keeps one source video's components together and residualizes both features and targets against the selected confounds.</div>`)}</div>`;
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

        function body() {
            return {
                overview: renderOverview, hooks: renderHooks, boundaries: renderBoundaries,
                components: renderComponents, clusters: renderClusters, swaps: renderSwaps,
                axes: renderAxes, registry: renderRegistry,
            }[state.view]();
        }

        function render() {
            return `<div id="pl-root" style="font-family:'Nunito',sans-serif;color:${C.text}">${responsiveStyles()}${header()}<div data-pl-progress-host>${progressStrip()}</div>${body()}</div>`;
        }

        function responsiveStyles() {
            return `<style>@media(max-width:820px){#pl-root .pl-split{grid-template-columns:minmax(0,1fr)!important}#pl-root canvas{max-width:100%}}</style>`;
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

        function scatter(canvas, points, colors, selectedIds) {
            if (!points || !points.length) return;
            let visible = points.map((point, index) => ({ point, index })).filter(row =>
                Array.isArray(row.point) && Number.isFinite(row.point[0]) && Number.isFinite(row.point[1]));
            const maximum = canvas.dataset.plCanvas === 'cluster-mini' ? 2400 : 30000;
            if (visible.length > maximum) {
                const stride = Math.ceil(visible.length / maximum);
                const sampled = visible.filter((row, index) => index % stride === 0 || (selectedIds && selectedIds.has(row.index)));
                visible = sampled.slice(0, maximum);
            }
            if (!visible.length) { canvasContext(canvas); return; }
            const { context, width, height } = canvasContext(canvas);
            const xb = bounds(visible.map(row => row.point[0])), yb = bounds(visible.map(row => row.point[1]));
            const project = point => [8 + (point[0] - xb[0]) / ((xb[1] - xb[0]) || 1) * (width - 16), height - 8 - (point[1] - yb[0]) / ((yb[1] - yb[0]) || 1) * (height - 16)];
            const projected = visible.map(row => project(row.point));
            projected.forEach((point, visibleIndex) => {
                const originalIndex = visible[visibleIndex].index;
                const selected = selectedIds && selectedIds.has(originalIndex);
                context.globalAlpha = selected ? 1 : .42;
                context.fillStyle = colors ? colors[originalIndex] : C.cyan;
                context.beginPath(); context.arc(point[0], point[1], selected ? 4 : 1.8, 0, Math.PI * 2); context.fill();
            });
            context.globalAlpha = 1;
            canvas.onclick = event => {
                const interactiveKinds = new Set(['components', 'hook-map', 'cluster']);
                const kind = canvas.dataset.plCanvas;
                const atlas = kind === 'hook-map' ? state.data.atlas : activeAtlas();
                if (!atlas || !interactiveKinds.has(kind)) return;
                const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
                let best = -1, distance = Infinity;
                projected.forEach((point, index) => { const d = (point[0] - x) ** 2 + (point[1] - y) ** 2; if (d < distance) { distance = d; best = index; } });
                if (best >= 0 && distance < 225) { const originalIndex = visible[best].index; state.componentId = atlasRows(atlas)[originalIndex].id; if (state.view !== 'components') state.view = 'components'; paint(); }
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

        function drawCanvases() {
            document.querySelectorAll('#pl-root canvas[data-pl-canvas]').forEach(canvas => {
                const kind = canvas.dataset.plCanvas;
                if (kind === 'interaction') return drawInteraction(canvas);
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
                    const colors = (map.labels || []).map(clusterColor);
                    return scatter(canvas, points, colors, null);
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
            if (target.closest('[data-pl-refresh]')) { Object.keys(state.data).forEach(key => delete state.data[key]); state.hook = null; state.source = null; ensureView(); return true; }
            if (target.closest('[data-pl-apply-query]')) { state.registryPage = 0; paint(); return true; }
            const hook = target.closest('[data-pl-hook]'); if (hook) { if (hook.hasAttribute('data-pl-open-hooks')) state.view = 'hooks'; load('atlas'); loadHook(hook.dataset.plHook); return true; }
            const atlasScope = target.closest('[data-pl-atlas-scope]'); if (atlasScope) { state.atlasScope = atlasScope.dataset.plAtlasScope; state.componentId = null; state.mapIndex = 0; state.mapPage = 0; state.representation = 'influence'; if (state.atlasScope === 'all') load('allSpanAtlas', api('all-span-atlas')); else load('atlas'); paint(); return true; }
            const rep = target.closest('[data-pl-rep]'); if (rep) { state.representation = rep.dataset.plRep; paint(); return true; }
            const component = target.closest('[data-pl-component]'); if (component) { state.componentId = component.dataset.plComponent; if (component.hasAttribute('data-pl-open-components')) state.view = 'components'; paint(); return true; }
            const map = target.closest('[data-pl-map]'); if (map) { state.mapIndex = Number(map.dataset.plMap); paint(); return true; }
            const mapPage = target.closest('[data-pl-map-page]'); if (mapPage) { const maps = ((activeAtlas() || {}).maps || []); const max = Math.max(0, Math.ceil(maps.length / 24) - 1); state.mapPage = Math.max(0, Math.min(max, state.mapPage + Number(mapPage.dataset.plMapPage))); state.mapIndex = Math.min(Math.max(0, maps.length - 1), state.mapPage * 24); paint(); return true; }
            const metric = target.closest('[data-pl-metric]'); if (metric) { state.metric = metric.dataset.plMetric; paint(); return true; }
            const source = target.closest('[data-pl-source]'); if (source) { if (source.hasAttribute('data-pl-open-swaps')) { state.view = 'swaps'; load('swaps'); } loadSource(source.dataset.plSource); return true; }
            const axis = target.closest('[data-pl-axis]'); if (axis) { state.axisIndex = Number(axis.dataset.plAxis); paint(); return true; }
            const stage = target.closest('[data-pl-registry-stage]'); if (stage) { state.registryStage = stage.dataset.plRegistryStage; state.registryPage = 0; paint(); return true; }
            const registryPage = target.closest('[data-pl-registry-page]'); if (registryPage) { state.registryPage = Math.max(0, state.registryPage + Number(registryPage.dataset.plRegistryPage)); paint(); return true; }
            return false;
        }

        function handleInput(event) {
            if (event.target.matches('[data-pl-query="hook"]')) { state.hookQuery = event.target.value; return true; }
            if (event.target.matches('[data-pl-query="registry"]')) { state.registryQuery = event.target.value; return true; }
            return false;
        }

        function handleChange() { return false; }

        function afterRender() {
            ensureView();
            drawCanvases();
            if (!progressTimer) progressTimer = setInterval(() => {
                const progress = state.data.progress || {};
                if (progress.status !== 'complete') pollProgress();
            }, 15000);
        }

        return { render, afterRender, handleClick, handleInput, handleChange };
    };
})();
