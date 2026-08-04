(function () {
    'use strict';

    const PANEL_COUNT = 5;
    const FRAME_WIDTH = 320;
    const FRAME_HEIGHT = 569;
    const MAX_CANDIDATES = 12;
    const MAX_REFERENCES = 8;
    const MODEL_OPTIONS = [
        ['flux-2-pro', 'FLUX.2 Pro'],
        ['seedream-4', 'Seedream 4'],
        ['nano-banana', 'Nano Banana'],
        ['nano-banana-pro', 'Nano Banana Pro'],
    ];
    const DRAW_COLORS = ['#ff3b30', '#ffd60a', '#34c759', '#00c7be', '#0a84ff', '#ffffff'];

    function uid(prefix) {
        try {
            if (window.crypto && window.crypto.randomUUID) {
                return `${prefix}${window.crypto.randomUUID().replace(/-/g, '')}`;
            }
        } catch (_) {}
        return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
    }

    function create(options) {
        options = options || {};
        const esc = typeof options.escapeHtml === 'function'
            ? options.escapeHtml
            : value => String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        const requestJson = options.requestJson;
        const runJob = options.runJob;
        const composeFrames = options.composeFrames;
        const scoreCandidate = options.scoreCandidate;
        const openScore = options.openScore;
        const saveScore = options.saveScore;
        const autoPersistScore = options.autoPersistScore === true;
        const reportError = typeof options.onError === 'function'
            ? options.onError
            : () => {};
        const creatorProfile = typeof options.getCreatorProfile === 'function'
            ? options.getCreatorProfile
            : () => null;

        function blankPanel(index) {
            return {
                id: uid(`p${index + 1}`),
                prompt: '',
                image: null,
                source: 'empty',
                relation: 'new',
                sourcePanels: [],
                contextPanels: Array.from(
                    { length: PANEL_COUNT },
                    (_, panelIndex) => panelIndex
                ).filter(panelIndex => panelIndex !== index),
                revisions: [],
                futureRevisions: [],
                strokes: [],
            };
        }

        function blankCandidate(name) {
            return {
                id: uid('candidate'),
                serverId: null,
                serverRevision: null,
                name: name || 'Untitled opening',
                brief: '',
                hookText: '',
                editPrompt: '',
                model: 'flux-2-pro',
                generationMode: 'composite',
                selectedPanel: 0,
                panels: Array.from({ length: PANEL_COUNT }, (_, index) => blankPanel(index)),
                references: [],
                composite: null,
                score: null,
                scoreError: '',
                scoreInputSha256: null,
                savedHookId: null,
                dirty: true,
                pristine: true,
                mutationVersion: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
        }

        const initial = blankCandidate('Opening 1');
        const state = {
            candidates: [initial],
            selectedCandidateId: initial.id,
            busy: false,
            busyCandidateId: null,
            status: '',
            error: '',
            drawEnabled: false,
            drawTool: 'pen',
            drawColor: DRAW_COLORS[0],
            drawSize: 7,
            saved: [],
            savedTotal: 0,
            savedLoaded: false,
            savedLoading: false,
            savedFilter: '',
            railScroll: 0,
        };
        let host = null;
        let activeStroke = null;
        let activePointerId = null;

        const candidate = () => (
            state.candidates.find(item => item.id === state.selectedCandidateId)
            || state.candidates[0]
        );
        const panel = () => {
            const current = candidate();
            return current && current.panels[current.selectedPanel];
        };
        const completeFrames = item => (
            item && item.panels.every(entry => !!entry.image)
        );
        const replaceableBlank = item => !!(
            item
            && !item.serverId
            && item.pristine === true
            && !item.brief
            && !item.hookText
            && !item.references.length
            && !item.composite
            && !item.panels.some(entry => entry.image || entry.prompt)
        );
        const scoreEntries = item => (
            item
            && item.score
            && item.score.score_ledger
            && Array.isArray(item.score.score_ledger.entries)
                ? item.score.score_ledger.entries
                : []
        );
        const scoreLedgerSha = item => (
            item
            && item.score
            && item.score.score_ledger
            && item.score.score_ledger.ledger_sha256
            || null
        );
        const exactSha256 = value => (
            typeof value === 'string'
            && /^[a-f0-9]{64}$/.test(value)
        );
        const scoreContract = item => {
            const score = item && item.score;
            const ledger = score && score.score_ledger;
            const manifest = score && score.input_manifest;
            const entries = scoreEntries(item);
            if (
                !ledger
                || !manifest
                || entries.length !== 21
                || !exactSha256(ledger.feature_contract_sha256)
                || !exactSha256(
                    ledger.feature_contract_document_sha256
                )
                || !exactSha256(
                    ledger.coordinate_governance_sha256
                )
                || !exactSha256(manifest.revision_fingerprint)
            ) return null;
            const payload = {
                featureContract: ledger.feature_contract_sha256,
                featureDocument:
                    ledger.feature_contract_document_sha256,
                governance:
                    ledger.coordinate_governance_sha256,
                scorerRevision: manifest.revision_fingerprint,
                embeddingModel: manifest.embedding_model || null,
                embeddingDimensions:
                    manifest.embedding_dimensions || null,
                coordinateIds: entries.map(
                    entry => entry.coordinate_id
                ),
            };
            return {
                key: JSON.stringify(payload),
                revision: manifest.revision_fingerprint,
            };
        };
        const needsScore = item => {
            if (!item || !completeFrames(item)) return false;
            return !item.score;
        };
        const touchCandidate = item => {
            if (!item) return;
            item.dirty = true;
            item.pristine = false;
            item.mutationVersion = (
                Number(item.mutationVersion) || 0
            ) + 1;
            item.updatedAt = Date.now();
        };
        const invalidateScore = item => {
            item.score = null;
            item.scoreError = '';
            item.scoreInputSha256 = null;
            item.savedHookId = null;
            touchCandidate(item);
        };

        function preserveUi() {
            if (!host) return {};
            const rail = host.querySelector('[data-sb-panel-rail]');
            const active = document.activeElement;
            return {
                rail: rail ? rail.scrollLeft : state.railScroll,
                focusKey: active && active.getAttribute && active.getAttribute('data-sb-focus'),
                start: active && typeof active.selectionStart === 'number' ? active.selectionStart : null,
                end: active && typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
            };
        }

        function restoreUi(snapshot) {
            if (!host) return;
            const rail = host.querySelector('[data-sb-panel-rail]');
            if (rail) rail.scrollLeft = Number(snapshot && snapshot.rail) || state.railScroll || 0;
            if (!snapshot || !snapshot.focusKey) return;
            const input = host.querySelector(`[data-sb-focus="${snapshot.focusKey}"]`);
            if (!input) return;
            input.focus();
            if (snapshot.start != null && input.setSelectionRange) {
                input.setSelectionRange(snapshot.start, snapshot.end);
            }
        }

        function paint() {
            if (!host || !host.isConnected) return;
            const snapshot = preserveUi();
            state.railScroll = snapshot.rail || 0;
            host.innerHTML = renderBody();
            afterRender();
            restoreUi(snapshot);
        }

        function imageSource(value) {
            return value ? esc(String(value)) : '';
        }

        function renderPanelRail(current) {
            return `<div class="sb-panel-rail" data-sb-panel-rail aria-label="Five storyboard frames">${
                current.panels.map((entry, index) => {
                    const selected = current.selectedPanel === index;
                    return `<button type="button" class="sb-panel-tile${selected ? ' is-selected' : ''}" data-sb-panel="${index}" aria-label="Select frame ${index + 1}">
                        <span class="sb-panel-number">${index + 1}</span>
                        ${entry.image
                            ? `<img src="${imageSource(entry.image)}" alt="Frame ${index + 1}">`
                            : `<span class="sb-panel-empty">+</span>`}
                        <span class="sb-panel-source">${esc(entry.source === 'empty' ? 'empty' : entry.source)}</span>
                    </button>`;
                }).join('')
            }</div>`;
        }

        function renderReferences(current) {
            const selected = current.selectedPanel;
            const rows = current.references.map(ref => {
                const scoped = Array.isArray(ref.panels) && ref.panels.includes(selected);
                const scopeLabel = ref.global ? 'All frames' : scoped ? `Frame ${selected + 1}` : 'Other frame';
                return `<div class="sb-reference">
                    <img src="${imageSource(ref.image)}" alt="${esc(ref.name || 'Reference')}">
                    <div class="sb-reference-copy">
                        <strong>${esc(ref.name || 'Reference')}</strong>
                        <button type="button" data-sb-ref-scope="${esc(ref.id)}">${scopeLabel}</button>
                    </div>
                    <button type="button" class="sb-icon-button" data-sb-ref-delete="${esc(ref.id)}" title="Remove reference" aria-label="Remove reference">&times;</button>
                </div>`;
            }).join('');
            return `<div class="sb-reference-section">
                <div class="sb-section-head">
                    <span>References</span>
                    <button type="button" data-sb-add-reference title="Upload reference images">+ Add</button>
                </div>
                <div class="sb-reference-list">${rows || '<span class="sb-muted">No references</span>'}</div>
            </div>`;
        }

        function renderDrawingControls(current) {
            const selected = current.selectedPanel;
            const selectedPanel = current.panels[selected];
            return `<div class="sb-draw-tools" aria-label="Drawing tools">
                <div class="sb-draw-mode" aria-label="Canvas interaction">
                    <button type="button" class="${!state.drawEnabled ? 'is-active' : ''}" data-sb-draw-mode="pan" title="Scroll the page">Pan</button>
                    <button type="button" class="${state.drawEnabled ? 'is-active' : ''}" data-sb-draw-mode="draw" title="Draw on this frame">Draw</button>
                </div>
                <button type="button" class="${state.drawEnabled && state.drawTool === 'pen' ? 'is-active' : ''}" data-sb-draw-tool="pen" title="Pen">Pen</button>
                <button type="button" class="${state.drawEnabled && state.drawTool === 'eraser' ? 'is-active' : ''}" data-sb-draw-tool="eraser" title="Eraser">Erase</button>
                <div class="sb-swatches">${DRAW_COLORS.map(color => (
                    `<button type="button" class="sb-swatch${state.drawColor === color ? ' is-active' : ''}" data-sb-draw-color="${color}" style="--swatch:${color}" title="${color}" aria-label="Use ${color}"></button>`
                )).join('')}</div>
                <label class="sb-size-control" title="Brush size"><span>Size</span><input type="range" min="2" max="28" value="${state.drawSize}" data-sb-draw-size></label>
                <button type="button" data-sb-draw-undo title="Undo last stroke" ${selectedPanel.strokes.length ? '' : 'disabled'}>Undo</button>
                <button type="button" data-sb-draw-clear title="Clear drawing" ${selectedPanel.strokes.length ? '' : 'disabled'}>Clear</button>
                <button type="button" data-sb-draw-apply title="Apply drawing to this frame" ${selectedPanel.strokes.length ? '' : 'disabled'}>Apply sketch</button>
            </div>`;
        }

        function renderFrameContext(current, panelIndex) {
            const selected = current.panels[panelIndex];
            const configured = new Set(
                contextPanelIndexes(current, panelIndex)
            );
            const exactInputs = uniqueReferences([
                selected.image,
                ...continuityReferences(current, panelIndex),
                ...activeReferences(current, panelIndex),
            ]);
            const overLimit = exactInputs.length > MAX_REFERENCES;
            return `<div class="sb-frame-context">
                <div class="sb-section-head">
                    <span>Frame context</span>
                    <small class="${overLimit ? 'is-error' : ''}">${exactInputs.length}/${MAX_REFERENCES} model images</small>
                </div>
                <div class="sb-context-grid" aria-label="Other storyboard frames sent to the image model">${current.panels.map((entry, index) => {
                    if (index === panelIndex) return '';
                    const active = configured.has(index);
                    return `<button type="button" class="sb-context-frame${active ? ' is-active' : ''}" data-sb-context-panel="${index}" aria-pressed="${active}" ${entry.image ? '' : 'disabled'} title="${active ? 'Remove' : 'Add'} frame ${index + 1} as image context">
                        ${entry.image
                            ? `<img src="${imageSource(entry.image)}" alt="Frame ${index + 1}">`
                            : '<span class="sb-context-empty"></span>'}
                        <span>Frame ${index + 1}</span>
                    </button>`;
                }).join('')}</div>
                <div class="sb-context-summary${overLimit ? ' is-error' : ''}">${overLimit
                    ? `Deselect ${exactInputs.length - MAX_REFERENCES} image${exactInputs.length - MAX_REFERENCES === 1 ? '' : 's'} before generating.`
                    : 'Selected frames and scoped references are sent with this edit.'}</div>
            </div>`;
        }

        function renderSelectedPanel(current) {
            const index = current.selectedPanel;
            const selected = current.panels[index];
            return `<div class="sb-editor">
                <div class="sb-stage-column">
                    <div class="sb-stage" data-sb-stage>
                        ${selected.image
                            ? `<img src="${imageSource(selected.image)}" alt="Selected frame ${index + 1}">`
                            : '<div class="sb-blank-stage"></div>'}
                        <canvas class="${state.drawEnabled ? 'is-drawing' : 'is-panning'}" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" data-sb-draw-canvas aria-label="${state.drawEnabled ? 'Draw over selected frame' : 'Frame preview; use Draw to annotate'}"></canvas>
                        <span class="sb-stage-label">Frame ${index + 1}</span>
                    </div>
                    ${renderDrawingControls(current)}
                    <div class="sb-stage-actions">
                        <button type="button" data-sb-upload-panel>Upload frame</button>
                        <button type="button" data-sb-clear-panel ${selected.image ? '' : 'disabled'}>Clear frame</button>
                    </div>
                </div>
                <div class="sb-inspector">
                    <label>
                        <span>Frame ${index + 1} prompt</span>
                        <textarea rows="3" data-sb-panel-prompt="${index}" data-sb-focus="panel-prompt">${esc(selected.prompt || '')}</textarea>
                    </label>
                    <label>
                        <span>Edit instruction</span>
                        <textarea rows="2" data-sb-edit-prompt data-sb-focus="edit-prompt" placeholder="Change only what should be different">${esc(current.editPrompt || '')}</textarea>
                    </label>
                    ${renderFrameContext(current, index)}
                    <div class="sb-inspector-actions">
                        <button type="button" class="is-primary" data-sb-generate-panel ${state.busy ? 'disabled' : ''}>${selected.image ? 'Edit selected' : 'Generate selected'}</button>
                        <button type="button" data-sb-restore-panel="previous" ${selected.revisions.length ? '' : 'disabled'}>Previous</button>
                        <button type="button" data-sb-restore-panel="next" ${selected.futureRevisions && selected.futureRevisions.length ? '' : 'disabled'}>Next</button>
                    </div>
                    <div class="sb-lineage">
                        <span>${esc(selected.relation || 'new')}</span>
                        <span>${selected.revisions.length} prior revision${selected.revisions.length === 1 ? '' : 's'}</span>
                    </div>
                    ${renderReferences(current)}
                </div>
            </div>`;
        }

        function renderBuildProgress(current) {
            const frameCount = current.panels.filter(
                entry => entry.image
            ).length;
            const hasBrief = !!(
                current.brief.trim()
                || current.hookText.trim()
                || current.panels.some(entry => entry.prompt.trim())
            );
            const refined = current.panels.some(entry => (
                entry.revisions.length
                || ['panel-edit', 'annotated-frame'].includes(entry.source)
            ));
            const steps = [
                ['Brief', hasBrief ? 'Ready' : 'Add direction', hasBrief],
                ['Generate', `${frameCount}/${PANEL_COUNT} frames`, frameCount === PANEL_COUNT],
                ['Refine', refined ? 'Edited' : 'Optional', refined],
            ];
            return `<div class="sb-workflow" aria-label="AI build path" data-sb-manual-progress>${steps.map((step, index) => (
                `<div class="sb-workflow-step${step[2] ? ' is-done' : ''}">
                    <span class="sb-workflow-number">${step[2] ? '&#10003;' : index + 1}</span>
                    <span class="sb-workflow-copy"><strong>${step[0]}</strong><small>${step[1]}</small></span>
                </div>`
            )).join('')}</div>`;
        }

        function renderWorkflowHeader(number, title, detail, status) {
            return `<header class="sb-workflow-section-head">
                <span class="sb-workflow-section-number">${number}</span>
                <span class="sb-workflow-section-copy"><strong>${title}</strong><small>${detail}</small></span>
                <span class="sb-workflow-section-status">${status}</span>
            </header>`;
        }

        function renderTranscriptReview(current) {
            const transcript = current.hookText.trim();
            const wordCount = transcript
                ? transcript.split(/\s+/).filter(Boolean).length
                : 0;
            return `<section class="sb-workflow-section sb-transcript-review" data-sb-section="transcript" data-sb-transcript-review>
                ${renderWorkflowHeader(
                    2,
                    'Transcript',
                    'Optional spoken words',
                    wordCount
                        ? `${wordCount} word${wordCount === 1 ? '' : 's'}`
                        : 'Visual only'
                )}
                <div class="sb-workflow-section-body sb-transcript-review-body">
                    <label class="sb-transcript-field">
                        <span>Spoken transcript (optional)</span>
                        <textarea rows="4" data-sb-hook-text data-sb-focus="hook-text" placeholder="Type exactly what is spoken, or leave blank for visual only.">${esc(current.hookText || '')}</textarea>
                    </label>
                </div>
            </section>`;
        }

        function renderScoreBar(current, placement) {
            const complete = completeFrames(current);
            const frameCount = current.panels.filter(
                entry => entry.image
            ).length;
            const transcript = current.hookText.trim();
            const transcriptWords = transcript
                ? transcript.split(/\s+/).filter(Boolean).length
                : 0;
            const primaryAttribute = placement === 'top'
                ? 'data-sb-score-current'
                : 'data-sb-score-bottom';
            if (placement === 'bottom') {
                return `<div class="sb-bottom-score">
                    <button type="button" class="is-primary" ${primaryAttribute} ${complete && !state.busy ? '' : 'disabled'}>${current.score ? 'Score this opening again' : complete ? 'Score this opening' : `Add ${PANEL_COUNT - frameCount} more frame${PANEL_COUNT - frameCount === 1 ? '' : 's'} to score`}</button>
                </div>`;
            }
            return `<div class="sb-score-dock" data-sb-score-dock="top">
                <div class="sb-score-summary">
                    <strong>${current.score ? 'Opening scored' : complete ? 'Ready to score' : `${frameCount}/${PANEL_COUNT} frames ready`}</strong>
                    <span>${scoreLedgerSha(current)
                        ? `Ledger ${esc(scoreLedgerSha(current).slice(0, 12))}...`
                        : complete
                            ? transcriptWords
                                ? `${transcriptWords} spoken word${transcriptWords === 1 ? '' : 's'} + five frames`
                                : 'Five frames · visual only'
                            : 'One canonical 21-coordinate score'}</span>
                </div>
                <button type="button" class="is-primary" ${primaryAttribute} ${complete && !state.busy ? '' : 'disabled'}>${current.score ? 'Score again' : 'Score opening'}</button>
                ${state.candidates.length > 1 ? `<button type="button" data-sb-batch-score ${state.busy || !state.candidates.some(needsScore) ? 'disabled' : ''}>Score all ready</button>` : ''}
                ${current.score ? '<button type="button" data-sb-open-score>Open embeddings</button>' : ''}
                <button type="button" data-sb-save ${complete && !state.busy ? '' : 'disabled'}>${current.serverId ? 'Save revision' : 'Save'}</button>
            </div>`;
        }

        function renderCandidatePreview(item) {
            return `<div class="sb-candidate-preview">${item.panels.map((entry, index) => (
                entry.image
                    ? `<img src="${imageSource(entry.image)}" alt="${esc(item.name)} frame ${index + 1}">`
                    : '<span></span>'
            )).join('')}</div>`;
        }

        function candidateMetricValue(entry) {
            const value = Number(entry && entry.value);
            if (!entry || entry.available !== true || !Number.isFinite(value)) {
                return '—';
            }
            if (entry.unit === 'views') {
                if (Math.abs(value) >= 1e6) {
                    return `${(value / 1e6).toFixed(value >= 1e7 ? 1 : 2)}M`;
                }
                if (Math.abs(value) >= 1e3) {
                    return `${Math.round(value / 1e3)}K`;
                }
                return Math.round(value).toLocaleString();
            }
            if (entry.unit === 'probability') {
                return `${(value * 100).toFixed(1)}%`;
            }
            if (
                entry.unit === 'percent'
                || entry.unit === 'retention_percent_rewatch_capable'
            ) return `${value.toFixed(1)}%`;
            return value.toFixed(2);
        }

        function renderCandidateMetrics(item) {
            const entries = scoreEntries(item);
            if (!entries.length) return '';
            const targets = [
                ['keep', 'Keep'],
                ['ret5', '5s'],
                ['views', 'Views'],
            ];
            return `<span class="sb-candidate-metrics">${targets.map(([target, label]) => {
                const entry = entries.find(candidateEntry => (
                    candidateEntry.target === target
                    && candidateEntry.group === 'together'
                    && candidateEntry.available === true
                )) || entries.find(candidateEntry => (
                    candidateEntry.target === target
                    && candidateEntry.group === 'visual'
                    && candidateEntry.available === true
                )) || entries.find(candidateEntry => (
                    candidateEntry.target === target
                    && candidateEntry.available === true
                ));
                return `<span title="${esc(entry && entry.coordinate_id || `${target} unavailable`)}"><small>${label}</small><strong>${candidateMetricValue(entry)}</strong></span>`;
            }).join('')}</span>`;
        }

        function renderCandidateQueue() {
            if (state.candidates.length < 2) return '';
            return `<section class="sb-candidate-queue" aria-label="Opening batch">
                <div class="sb-candidate-queue-head">
                    <div><strong>Openings</strong><span>${state.candidates.length} in this batch</span></div>
                    <div>
                        <button type="button" data-sb-upload-strips ${state.busy ? 'disabled' : ''}>Add strips</button>
                        <button type="button" class="is-primary" data-sb-batch-score ${state.busy || !state.candidates.some(needsScore) ? 'disabled' : ''}>Score all ready</button>
                    </div>
                </div>
                <div class="sb-candidate-grid">${state.candidates.map((item, index) => {
                    const selected = item.id === state.selectedCandidateId;
                    const status = state.busyCandidateId === item.id
                        ? 'Processing'
                        : item.score
                            ? 'Scored'
                            : item.scoreError
                                ? 'Error'
                                : completeFrames(item)
                                    ? 'Ready'
                                    : `${item.panels.filter(entry => entry.image).length}/${PANEL_COUNT} frames`;
                    return `<article class="sb-candidate-card${selected ? ' is-selected' : ''}">
                        <button type="button" class="sb-candidate-select" data-sb-select-candidate="${esc(item.id)}" aria-current="${selected ? 'true' : 'false'}">
                            ${renderCandidatePreview(item)}
                            <span class="sb-candidate-copy"><strong>${index + 1}. ${esc(item.name)}</strong><small class="${item.scoreError ? 'is-error' : item.score ? 'is-done' : ''}" title="${esc(item.scoreError || '')}">${esc(status)}</small></span>
                            ${renderCandidateMetrics(item)}
                        </button>
                        <div class="sb-row-actions">
                            ${item.score ? `<button type="button" data-sb-open-candidate-score="${esc(item.id)}">Embeddings</button>` : ''}
                            <button type="button" data-sb-duplicate="${esc(item.id)}">Duplicate</button>
                            <button type="button" data-sb-delete-candidate="${esc(item.id)}" ${state.candidates.length === 1 ? 'disabled' : ''}>Remove</button>
                        </div>
                    </article>`;
                }).join('')}</div>
            </section>`;
        }

        function renderComposer(current) {
            const frameCount = current.panels.filter(
                entry => entry.image
            ).length;
            const complete = completeFrames(current);
            return `<div class="sb-compose">
                ${renderCandidateQueue()}
                <div class="sb-start-grid">
                    <section class="sb-workflow-section sb-upload-route" data-sb-section="upload">
                        ${renderWorkflowHeader('A', 'Upload a finished strip', 'Use an opening you already made', `${frameCount}/${PANEL_COUNT} frames`)}
                        <div class="sb-workflow-section-body sb-upload-route-body">
                            <button type="button" class="is-primary" data-sb-upload-strips ${state.busy ? 'disabled' : ''}>Choose finished strip(s)</button>
                            <span>One or many five-frame images; each is split for review before scoring.</span>
                        </div>
                    </section>
                    <div class="sb-route-or" aria-hidden="true">or</div>
                    <section class="sb-workflow-section sb-ai-route" data-sb-section="build">
                        ${renderWorkflowHeader('B', 'Build with AI', 'One coherent sheet, split into five frames', current.brief.trim() || current.hookText.trim() ? 'Direction added' : 'Ready for a brief')}
                        <div class="sb-workflow-section-body sb-ai-route-body">
                            ${renderBuildProgress(current)}
                            <div class="sb-brief-grid${complete ? ' is-single' : ''}">
                                <label>
                                    <span>Visual brief</span>
                                    <textarea rows="3" data-sb-brief data-sb-focus="brief" placeholder="What happens across the opening?">${esc(current.brief || '')}</textarea>
                                </label>
                                ${complete ? '' : `<label>
                                    <span>Spoken opening</span>
                                    <textarea rows="3" data-sb-hook-text data-sb-focus="hook-text" placeholder="What is said in the opening?">${esc(current.hookText || '')}</textarea>
                                </label>`}
                            </div>
                            <div class="sb-generation-bar">
                                <label class="sb-model-picker"><span>Image model</span><select data-sb-model>${MODEL_OPTIONS.map(([value, label]) => `<option value="${value}" ${current.model === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
                                <button type="button" class="is-primary" data-sb-generate-all ${state.busy ? 'disabled' : ''}>Generate five frames</button>
                            </div>
                        </div>
                    </section>
                </div>
                ${complete ? renderTranscriptReview(current) : ''}
                ${renderScoreBar(current, 'top')}
                <section id="sb-workflow-refine" class="sb-workflow-section" data-sb-section="refine" tabindex="-1">
                    ${renderWorkflowHeader(complete ? 3 : 2, 'Preview and refine', 'Select a frame, edit it, or leave it as generated', `Frame ${current.selectedPanel + 1} of ${PANEL_COUNT}`)}
                    <div class="sb-workflow-section-body">
                        ${renderPanelRail(current)}
                        ${renderSelectedPanel(current)}
                    </div>
                </section>
                ${renderScoreBar(current, 'bottom')}
            </div>`;
        }

        function renderSavedPicker() {
            const query = state.savedFilter.trim().toLowerCase();
            const visible = query
                ? state.saved.filter(item => String(
                    item.name || ''
                ).toLowerCase().includes(query))
                : state.saved;
            return `<div class="sb-saved-picker">
                <label><span>Saved</span><input type="search" data-sb-saved-filter data-sb-focus="saved-filter" value="${esc(state.savedFilter)}" placeholder="Find ${state.saved.length}"></label>
                <label><span class="sb-visually-hidden">Open saved storyboard</span><select data-sb-load-saved ${state.savedLoading ? 'disabled' : ''}>
                    <option value="">${state.savedLoading ? 'Loading...' : `${visible.length} storyboard${visible.length === 1 ? '' : 's'}`}</option>
                    ${visible.map(item => `<option value="${esc(item.id)}">${esc(item.name || 'Untitled')} | ${new Date(item.updatedAt || item.createdAt || 0).toLocaleDateString()}</option>`).join('')}
                </select></label>
            </div>`;
        }

        function renderBody() {
            const current = candidate();
            if (!current) return '<div class="sb-error">Storyboard state unavailable.</div>';
            return `<div class="sb-shell">
                <div class="sb-topbar">
                    <div class="sb-title">
                        <strong>Storyboard workbench</strong>
                        <span>Build or upload a five-frame opening</span>
                    </div>
                    ${renderSavedPicker()}
                    <button type="button" data-sb-new title="New storyboard" ${state.candidates.length >= MAX_CANDIDATES ? 'disabled' : ''}>New</button>
                </div>
                <div class="sb-name-row">
                    <input type="text" data-sb-name data-sb-focus="name" value="${esc(current.name)}" aria-label="Storyboard name">
                    <span>${creatorProfile() ? `Profile: ${esc(creatorProfile())}` : 'Global scorer'}</span>
                </div>
                ${state.status ? `<div class="sb-status" role="status"><span></span>${esc(state.status)}</div>` : ''}
                ${state.error ? `<div class="sb-error" role="alert">${esc(state.error)}<button type="button" data-sb-dismiss-error aria-label="Dismiss error">&times;</button></div>` : ''}
                ${renderComposer(current)}
            </div>`;
        }

        function render() {
            return `<section id="shorts-storyboard-workbench" data-storyboard-workbench>${renderBody()}</section>`;
        }

        function blobDataUrl(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(
                    new Error('Could not read the stored image.')
                );
                reader.readAsDataURL(blob);
            });
        }

        async function portableImageSource(source) {
            const value = String(source || '');
            if (
                !value
                || /^data:image\//i.test(value)
                || /^blob:/i.test(value)
            ) return value;
            if (/^\/api\/storyboards\/media\//.test(value)) {
                let lastStatus = 0;
                let lastError = null;
                for (let attempt = 0; attempt < 2; attempt++) {
                    let response;
                    try {
                        response = await fetch(value, {
                            cache: attempt ? 'reload' : 'force-cache',
                            credentials: 'same-origin',
                        });
                    } catch (error) {
                        lastError = error;
                        if (attempt === 0) {
                            await new Promise(resolve => setTimeout(
                                resolve,
                                180
                            ));
                            continue;
                        }
                        break;
                    }
                    lastStatus = response.status;
                    if (response.ok) {
                        return blobDataUrl(await response.blob());
                    }
                    if (
                        attempt === 0
                        && (response.status >= 500 || response.status === 408)
                    ) {
                        await new Promise(resolve => setTimeout(
                            resolve,
                            180
                        ));
                        continue;
                    }
                    break;
                }
                throw new Error(
                    `Stored storyboard image failed to load (${
                        lastStatus
                        || lastError && lastError.message
                        || 'network'
                    }).`
                );
            }
            return value;
        }

        async function mapLimited(values, limit, mapper) {
            const items = Array.from(values || []);
            const output = new Array(items.length);
            let cursor = 0;
            const workers = Array.from({
                length: Math.min(limit, items.length),
            }, async () => {
                while (cursor < items.length) {
                    const index = cursor++;
                    output[index] = await mapper(items[index], index);
                }
            });
            await Promise.all(workers);
            return output;
        }

        async function loadImage(source) {
            const portable = await portableImageSource(source);
            return new Promise((resolve, reject) => {
                const image = new Image();
                image.crossOrigin = 'anonymous';
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('Could not read that image.'));
                image.src = portable;
            });
        }

        function fileDataUrl(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error(`Could not read ${file.name || 'file'}.`));
                reader.readAsDataURL(file);
            });
        }

        async function normalizeImage(source, width, height, mode) {
            const image = await loadImage(source);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            context.fillStyle = '#000';
            context.fillRect(0, 0, width, height);
            const scale = mode === 'contain'
                ? Math.min(width / image.width, height / image.height)
                : Math.max(width / image.width, height / image.height);
            const drawWidth = image.width * scale;
            const drawHeight = image.height * scale;
            context.drawImage(
                image,
                (width - drawWidth) / 2,
                (height - drawHeight) / 2,
                drawWidth,
                drawHeight
            );
            return canvas.toDataURL('image/jpeg', 0.88);
        }

        async function splitStrip(source) {
            const image = await loadImage(source);
            const horizontal = image.width >= image.height;
            const sourceWidth = horizontal ? image.width / PANEL_COUNT : image.width;
            const sourceHeight = horizontal ? image.height : image.height / PANEL_COUNT;
            const frames = [];
            for (let index = 0; index < PANEL_COUNT; index++) {
                const canvas = document.createElement('canvas');
                canvas.width = FRAME_WIDTH;
                canvas.height = FRAME_HEIGHT;
                const context = canvas.getContext('2d');
                context.fillStyle = '#000';
                context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
                const scale = Math.max(FRAME_WIDTH / sourceWidth, FRAME_HEIGHT / sourceHeight);
                const drawWidth = sourceWidth * scale;
                const drawHeight = sourceHeight * scale;
                context.drawImage(
                    image,
                    horizontal ? index * sourceWidth : 0,
                    horizontal ? 0 : index * sourceHeight,
                    sourceWidth,
                    sourceHeight,
                    (FRAME_WIDTH - drawWidth) / 2,
                    (FRAME_HEIGHT - drawHeight) / 2,
                    drawWidth,
                    drawHeight
                );
                frames.push(canvas.toDataURL('image/jpeg', 0.88));
            }
            return frames;
        }

        function panelRevision(target) {
            return {
                image: target.image,
                source: target.source,
                relation: target.relation,
                sourcePanels: Array.isArray(target.sourcePanels)
                    ? target.sourcePanels.slice()
                    : [],
                prompt: target.prompt,
                at: Date.now(),
            };
        }

        function setPanelImage(current, index, image, metadata) {
            const target = current.panels[index];
            if (target.image) {
                target.revisions.push(panelRevision(target));
                if (target.revisions.length > 12) target.revisions.shift();
            }
            target.futureRevisions = [];
            target.image = image;
            target.source = metadata && metadata.source || 'upload';
            target.relation = metadata && metadata.relation || 'new';
            target.sourcePanels = metadata && metadata.sourcePanels || [];
            if (metadata && metadata.prompt != null) target.prompt = metadata.prompt;
            target.strokes = [];
            current.composite = null;
            invalidateScore(current);
        }

        function pickFiles(config) {
            const uploader = window.JarvisUpload;
            if (uploader && typeof uploader.pickFiles === 'function') {
                uploader.pickFiles({
                    accept: config.accept,
                    multiple: !!config.multiple,
                    onSelect: config.onSelect,
                    onError: error => fail(error),
                });
                return;
            }
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = config.accept || '';
            input.multiple = !!config.multiple;
            input.style.display = 'none';
            input.addEventListener('change', () => {
                config.onSelect(Array.from(input.files || []));
                input.remove();
            }, { once: true });
            document.body.appendChild(input);
            input.click();
        }

        function fail(error) {
            state.error = String((error && error.message) || error || 'Something went wrong.').slice(0, 500);
            state.status = '';
            state.busy = false;
            state.busyCandidateId = null;
            reportError(state.error);
            paint();
        }

        function activeReferences(current, panelIndex) {
            return current.references
                .filter(ref => ref.global || (ref.panels || []).includes(panelIndex))
                .map(ref => ref.image)
                .filter(Boolean);
        }

        function compositeReferences(current) {
            const seen = new Set();
            return current.references
                .filter(reference => {
                    if (!reference.image || seen.has(reference.image)) {
                        return false;
                    }
                    seen.add(reference.image);
                    return true;
                })
                .slice(0, MAX_REFERENCES)
                .map(reference => ({
                    image: reference.image,
                    name: reference.name,
                    global: reference.global !== false,
                    panels: Array.isArray(reference.panels)
                        ? reference.panels.slice()
                        : [],
                }));
        }

        function contextPanelIndexes(current, panelIndex) {
            const selected = current.panels[panelIndex];
            const configured = Array.isArray(selected.contextPanels)
                ? selected.contextPanels
                : Array.from(
                    { length: PANEL_COUNT },
                    (_, index) => index
                ).filter(index => index !== panelIndex);
            return [...new Set(configured.map(Number))]
                .filter(index => (
                    Number.isInteger(index)
                    && index >= 0
                    && index < PANEL_COUNT
                    && index !== panelIndex
                ))
                .sort((left, right) => (
                    Math.abs(left - panelIndex)
                    - Math.abs(right - panelIndex)
                    || left - right
                ));
        }

        function continuityReferences(current, panelIndex) {
            return contextPanelIndexes(current, panelIndex)
                .map(index => current.panels[index].image)
                .filter(Boolean);
        }

        function uniqueReferences(values) {
            return [...new Set((values || []).filter(Boolean))];
        }

        async function generateComposite(current) {
            state.status = 'Generating one coherent five-panel sheet...';
            paint();
            const result = await runJob('/api/storyboards/generate', {
                async: true,
                model: current.model,
                brief: current.brief,
                hookText: current.hookText,
                panels: current.panels.map(entry => entry.prompt),
                refs: compositeReferences(current),
            });
            if (!result || !result.image) throw new Error('The image model returned no storyboard sheet.');
            const frames = await splitStrip(result.image);
            frames.forEach((image, index) => setPanelImage(current, index, image, {
                source: 'coherent-sheet',
                relation: 'composite',
                prompt: current.panels[index].prompt,
            }));
            current.composite = result.image;
        }

        async function generateAll() {
            const current = candidate();
            if (!current || state.busy) return;
            if (
                !current.brief.trim()
                && !current.hookText.trim()
                && !current.panels.some(entry => entry.prompt.trim())
            ) {
                fail(
                    'Add a visual brief, spoken opening, or at least one '
                        + 'frame prompt first.'
                );
                return;
            }
            state.busy = true;
            state.busyCandidateId = current.id;
            state.error = '';
            try {
                await generateComposite(current);
                state.status = 'Five frames are ready. Review the optional transcript, then score.';
            } catch (error) {
                fail(error);
                return;
            }
            state.busy = false;
            state.busyCandidateId = null;
            paint();
        }

        function drawStrokes(context, strokes) {
            context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
            (strokes || []).forEach(stroke => {
                if (!stroke.points || !stroke.points.length) return;
                context.save();
                context.lineCap = 'round';
                context.lineJoin = 'round';
                context.lineWidth = stroke.size;
                context.strokeStyle = stroke.color;
                context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
                context.beginPath();
                stroke.points.forEach((point, index) => {
                    if (index === 0) context.moveTo(point[0], point[1]);
                    else context.lineTo(point[0], point[1]);
                });
                if (stroke.points.length === 1) {
                    context.lineTo(stroke.points[0][0] + 0.01, stroke.points[0][1] + 0.01);
                }
                context.stroke();
                context.restore();
            });
        }

        async function annotatedFrame(current, index, includeBase) {
            const selected = current.panels[index];
            const canvas = document.createElement('canvas');
            canvas.width = FRAME_WIDTH;
            canvas.height = FRAME_HEIGHT;
            const context = canvas.getContext('2d');
            context.fillStyle = includeBase ? '#000' : '#fff';
            context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
            if (includeBase && selected.image) {
                const image = await loadImage(selected.image);
                context.drawImage(image, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
            }
            const overlay = document.createElement('canvas');
            overlay.width = FRAME_WIDTH;
            overlay.height = FRAME_HEIGHT;
            drawStrokes(overlay.getContext('2d'), selected.strokes);
            context.drawImage(overlay, 0, 0);
            return canvas.toDataURL('image/jpeg', 0.9);
        }

        async function generateSelected() {
            const current = candidate();
            if (!current || state.busy) return;
            const index = current.selectedPanel;
            const selected = current.panels[index];
            const prompt = String(
                current.editPrompt
                || selected.prompt
                || current.brief
            ).trim();
            if (!prompt) {
                fail('Add a frame prompt or edit instruction first.');
                return;
            }
            const contextIndexes = contextPanelIndexes(current, index)
                .filter(panelIndex => current.panels[panelIndex].image);
            const contextualImages = contextIndexes.map(
                panelIndex => current.panels[panelIndex].image
            );
            const externalImages = activeReferences(current, index);
            const selectedInputs = uniqueReferences([
                selected.image,
                ...contextualImages,
                ...externalImages,
            ]);
            if (selectedInputs.length > MAX_REFERENCES) {
                fail(
                    `This edit has ${selectedInputs.length} selected image inputs, `
                        + `but ${current.model} accepts ${MAX_REFERENCES}. `
                        + 'Deselect another frame or change an uploaded reference scope.'
                );
                return;
            }
            state.busy = true;
            state.busyCandidateId = current.id;
            state.error = '';
            state.status = selected.image
                ? `Editing frame ${index + 1}...`
                : `Generating frame ${index + 1}...`;
            paint();
            try {
                let refs = uniqueReferences([
                    ...contextualImages,
                    ...externalImages,
                ]);
                let relation = refs.length ? 'compose' : 'new';
                if (selected.image) {
                    const base = selected.strokes.length
                        ? await annotatedFrame(current, index, true)
                        : selected.image;
                    refs = uniqueReferences([base].concat(refs));
                    relation = 'edit';
                }
                const result = await runJob('/api/storyboards/panel', {
                    async: true,
                    model: current.model,
                    prompt: selected.image && selected.strokes.length
                        ? `${prompt}. Follow the drawn markup as an edit guide, then remove all markup from the finished image.`
                        : prompt,
                    refs,
                    relation,
                });
                if (!result || !result.image) throw new Error('The image model returned no frame.');
                const normalized = await normalizeImage(result.image, FRAME_WIDTH, FRAME_HEIGHT, 'cover');
                setPanelImage(current, index, normalized, {
                    source: selected.image ? 'panel-edit' : 'panel-generation',
                    relation,
                    sourcePanels: [
                        ...(selected.image ? [index] : []),
                        ...contextIndexes,
                    ],
                    prompt: selected.prompt,
                });
                current.editPrompt = '';
                state.status = `Frame ${index + 1} is ready.`;
            } catch (error) {
                fail(error);
                return;
            }
            state.busy = false;
            state.busyCandidateId = null;
            paint();
        }

        async function applySketch() {
            const current = candidate();
            const selected = panel();
            if (
                !current
                || !selected
                || !selected.strokes.length
                || state.busy
            ) return;
            try {
                const image = await annotatedFrame(current, current.selectedPanel, !!selected.image);
                setPanelImage(current, current.selectedPanel, image, {
                    source: selected.image ? 'annotated-frame' : 'uploaded-sketch',
                    relation: selected.image ? 'edit' : 'new',
                    sourcePanels: selected.image ? [current.selectedPanel] : [],
                });
                state.status = `Sketch applied to frame ${current.selectedPanel + 1}.`;
                paint();
            } catch (error) {
                fail(error);
            }
        }

        async function scoreOne(current) {
            if (!completeFrames(current)) throw new Error(`${current.name} needs all five frames before scoring.`);
            const scoringVersion = Number(current.mutationVersion) || 0;
            const scoringFrames = current.panels.map(
                entry => entry.image
            );
            const scoringText = current.hookText;
            state.status = `Scoring ${current.name} through the canonical Shorts ledger...`;
            paint();
            const assembled = await requestJson(
                '/api/storyboards/montage',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        panels: scoringFrames,
                    }),
                }
            );
            if (!assembled || !assembled.image || !assembled.media) {
                throw new Error(
                    `${current.name} could not assemble its canonical montage.`
                );
            }
            const montage = await portableImageSource(assembled.image);
            const result = await scoreCandidate({
                id: current.id,
                title: current.name,
                text: scoringText,
                frames: scoringFrames,
                montage,
                creatorProfile: creatorProfile(),
            });
            if (!result || !result.score_ledger || !result.score_ledger.ledger_sha256) {
                throw new Error(`${current.name} did not return a canonical score ledger.`);
            }
            if (
                current.mutationVersion !== scoringVersion
                || current.hookText !== scoringText
                || current.panels.some((
                    entry,
                    index
                ) => entry.image !== scoringFrames[index])
            ) {
                throw new Error(
                    `${current.name} changed while it was scoring; run the score again.`
                );
            }
            current.score = {
                ...result,
                storyboardCandidateId: current.id,
                storyboardFrames: scoringFrames,
                storyboardScoreMontage: assembled.media,
                montageDataUrl: montage,
                storyboardScoredAt: Date.now(),
            };
            if (!scoreContract(current)) {
                current.score = null;
                throw new Error(
                    `${current.name} did not return one complete, revision-pinned 21-coordinate score.`
                );
            }
            current.scoreError = '';
            current.scoreInputSha256 = result.input_manifest
                && (
                    result.input_manifest.score_input_fingerprint
                    || result.input_manifest.input_fingerprint
                )
                || null;
            current.dirty = true;
            return result;
        }

        async function scoreCurrent() {
            const current = candidate();
            if (!current || state.busy) return;
            state.busy = true;
            state.busyCandidateId = current.id;
            state.error = '';
            try {
                await scoreOne(current);
                state.status = `${current.name} scored on ${scoreEntries(current).length} ledger coordinates.`;
                if (autoPersistScore) {
                    state.status = `${current.name} scored. Saving its complete analysis...`;
                    paint();
                    try {
                        await persistCandidate(current);
                        state.status = `${current.name} scored and saved on ${scoreEntries(current).length} ledger coordinates.`;
                    } catch (saveError) {
                        state.error = `The score is complete and open below, but its saved copy failed: ${String((saveError && saveError.message) || saveError)}`.slice(0, 500);
                        reportError(state.error);
                    }
                }
            } catch (error) {
                fail(error);
                return;
            }
            state.busy = false;
            state.busyCandidateId = null;
            paint();
            if (current.score && openScore) {
                try {
                    await openScore(current.score);
                } catch (error) {
                    fail(error);
                }
            }
        }

        async function scoreBatch(candidateIds) {
            if (state.busy) return;
            const selectedIds = Array.isArray(candidateIds)
                ? new Set(candidateIds)
                : null;
            const queue = state.candidates.filter(
                item => (
                    needsScore(item)
                    && (!selectedIds || selectedIds.has(item.id))
                )
            );
            if (!queue.length) return;
            state.busy = true;
            state.error = '';
            let lastScored = null;
            for (let index = 0; index < queue.length; index++) {
                const current = queue[index];
                state.busyCandidateId = current.id;
                state.status = `Batch ${index + 1}/${queue.length}: ${current.name}`;
                paint();
                try {
                    current.scoreError = '';
                    await scoreOne(current);
                    lastScored = current;
                    if (autoPersistScore) {
                        state.status = `Batch ${index + 1}/${queue.length}: saving ${current.name}`;
                        paint();
                        await persistCandidate(current, {
                            refreshSaved: false,
                        });
                    }
                } catch (error) {
                    current.scoreError = String((error && error.message) || error);
                }
            }
            if (autoPersistScore) await loadSaved(true);
            state.busy = false;
            state.busyCandidateId = null;
            const scoredCount = queue.filter(item => item.score).length;
            const failedCount = queue.length - scoredCount;
            state.status = `Batch complete: ${scoredCount}/${queue.length} scored${failedCount ? ` · ${failedCount} failed` : ''}.`;
            if (lastScored) state.selectedCandidateId = lastScored.id;
            paint();
            if (lastScored && lastScored.score && openScore) {
                try {
                    await openScore(lastScored.score);
                } catch (error) {
                    fail(error);
                }
            }
        }

        function scoreSnapshot(current) {
            if (!current.score) return null;
            return {
                title: current.score.title || current.name,
                text:
                    current.score.transcript !== undefined
                        ? current.score.transcript
                        : current.hookText,
                duration_s:
                    current.score.dur_s !== undefined
                        ? current.score.dur_s
                        : current.score.duration_s,
                score_ledger: current.score.score_ledger,
                score_ledger_validation: current.score.score_ledger_validation || null,
                score_record_sha256: current.score.score_record_sha256 || null,
                input_manifest: current.score.input_manifest || null,
                score_montage:
                    current.score.storyboardScoreMontage || null,
                indicators: current.score.indicators || null,
                novelty_provenance:
                    current.score.novelty_provenance || null,
                channels: current.score.channels || null,
                emb_preview: current.score.emb_preview || null,
                visual_keep_forecast: current.score.visual_keep_forecast || null,
                creator_adaptive_keep_forecast: current.score.creator_adaptive_keep_forecast || null,
                creator_adaptive_keep_forecast_error:
                    current.score.creator_adaptive_keep_forecast_error || null,
            };
        }

        async function persistCandidate(current, persistOptions) {
            persistOptions = persistOptions || {};
            const saveVersion = Number(current.mutationVersion) || 0;
            if (current.score && !current.savedHookId && saveScore) {
                const saved = await saveScore(current.score, {
                    title: current.name,
                    text: current.hookText,
                    montage: current.score.montageDataUrl,
                });
                current.savedHookId = saved && saved.id || null;
                current.score.savedId = current.savedHookId;
                current.score._labAutoSaved = autoPersistScore;
            }
            const response = await requestJson('/api/storyboards/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: current.serverId,
                    expectedRevision: current.serverRevision,
                    name: current.name,
                    brief: current.brief,
                    hookText: current.hookText,
                    model: current.model,
                    generationMode: current.generationMode,
                    selectedPanel: current.selectedPanel,
                    composite: current.composite,
                    references: current.references,
                    panels: current.panels,
                    score: scoreSnapshot(current),
                    savedHookId: current.savedHookId,
                }),
            });
            current.serverId = response.id;
            current.serverRevision = response.revision;
            current.dirty = (
                Number(current.mutationVersion) || 0
            ) !== saveVersion;
            current.pristine = false;
            if (persistOptions.refreshSaved !== false) {
                await loadSaved(true);
            }
            return response;
        }

        async function saveCurrent() {
            const current = candidate();
            if (!current || state.busy || !completeFrames(current)) return;
            state.busy = true;
            state.busyCandidateId = current.id;
            state.error = '';
            state.status = `Saving ${current.name}...`;
            paint();
            try {
                const response = await persistCandidate(current);
                state.status = response.indexPending
                    ? `${current.name} saved; the library index is repairing in the background.`
                    : `${current.name} saved.`;
            } catch (error) {
                fail(error);
                return;
            }
            state.busy = false;
            state.busyCandidateId = null;
            paint();
        }

        async function hydrateStoredCandidate(record) {
            const current = blankCandidate(record.name || 'Saved storyboard');
            const warnings = [];
            current.serverId = record.id;
            current.serverRevision = record.revision;
            current.name = record.name || current.name;
            current.brief = record.brief || '';
            current.hookText = record.hookText || '';
            current.model = record.model || 'flux-2-pro';
            current.generationMode = record.generationMode || 'composite';
            current.selectedPanel = Math.max(0, Math.min(4, Number(record.selectedPanel) || 0));
            current.composite = record.composite || null;
            current.references = (await mapLimited(
                Array.isArray(record.references)
                    ? record.references
                    : [],
                4,
                async (reference, index) => {
                    try {
                        return {
                            ...reference,
                            image: await portableImageSource(
                                reference.image
                            ),
                        };
                    } catch (error) {
                        warnings.push(
                            `Reference ${index + 1}: ${
                                error.message || error
                            }`
                        );
                        return null;
                    }
                }
            )).filter(Boolean);
            current.panels = Array.from({ length: PANEL_COUNT }, (_, index) => {
                const stored = record.panels && record.panels[index] || {};
                const defaults = blankPanel(index);
                return {
                    ...defaults,
                    ...stored,
                    contextPanels: Array.isArray(stored.contextPanels)
                        ? stored.contextPanels
                            .map(Number)
                            .filter(panelIndex => (
                                Number.isInteger(panelIndex)
                                && panelIndex >= 0
                                && panelIndex < PANEL_COUNT
                                && panelIndex !== index
                            ))
                        : defaults.contextPanels,
                    strokes: Array.isArray(stored.strokes) ? stored.strokes : [],
                    revisions: Array.isArray(stored.revisions) ? stored.revisions : [],
                    futureRevisions: [],
                };
            });
            await mapLimited(current.panels, 4, async (
                storedPanel,
                index
            ) => {
                if (!storedPanel.image) return;
                try {
                    storedPanel.image = await portableImageSource(
                        storedPanel.image
                    );
                } catch (error) {
                    storedPanel.image = null;
                    warnings.push(
                        `Frame ${index + 1}: ${
                            error.message || error
                        }`
                    );
                }
            });
            if (record.score && record.score.score_ledger) {
                const scoreMontage =
                    record.score.score_montage || null;
                let montageDataUrl = null;
                if (scoreMontage && scoreMontage.url) {
                    try {
                        montageDataUrl = await portableImageSource(
                            scoreMontage.url
                        );
                    } catch (error) {
                        warnings.push(
                            `Scored montage: ${error.message || error}`
                        );
                    }
                }
                current.score = {
                    ...record.score,
                    title: current.name,
                    transcript: current.hookText,
                    dur_s: record.score.duration_s,
                    montageDataUrl,
                    storyboardScoreMontage: scoreMontage,
                    storyboardCandidateId: current.id,
                    storyboardFrames: current.panels.map(entry => entry.image),
                    source: 'storyboard-saved',
                };
            }
            current.savedHookId = record.savedHookId || null;
            current.dirty = false;
            current.pristine = false;
            current.mutationVersion = 0;
            current.hydrationWarnings = warnings;
            return current;
        }

        async function loadSaved(force) {
            if (state.savedLoading || (state.savedLoaded && !force)) return;
            state.savedLoading = true;
            try {
                const rows = [];
                let offset = 0;
                let total = 0;
                do {
                    const response = await requestJson(
                        `/api/storyboards?limit=100&offset=${offset}`,
                        { cache: 'no-store' }
                    );
                    const page = Array.isArray(response.storyboards)
                        ? response.storyboards
                        : [];
                    total = Math.max(
                        total,
                        Number(response.total) || 0
                    );
                    rows.push(...page);
                    offset += page.length;
                    if (!page.length) break;
                } while (offset < total);
                state.saved = [...new Map(
                    rows.map(row => [row.id, row])
                ).values()];
                state.savedTotal = total || state.saved.length;
                state.savedLoaded = true;
            } catch (error) {
                state.error = String((error && error.message) || error);
                state.savedLoaded = true;
            }
            state.savedLoading = false;
            paint();
        }

        async function loadStoryboard(id) {
            if (!id || state.busy) return;
            state.busy = true;
            state.status = 'Loading storyboard...';
            paint();
            try {
                const record = await requestJson(`/api/storyboards/${encodeURIComponent(id)}`, { cache: 'no-store' });
                const loaded = await hydrateStoredCandidate(record);
                const existing = state.candidates.findIndex(item => item.serverId === loaded.serverId);
                if (existing >= 0 && state.candidates[existing].dirty) {
                    throw new Error(
                        'This storyboard has unsaved edits in the workspace. '
                            + 'Save or remove that copy before reopening it.'
                    );
                }
                if (existing >= 0) state.candidates[existing] = loaded;
                else if (
                    state.candidates.length === 1
                    && replaceableBlank(state.candidates[0])
                ) state.candidates[0] = loaded;
                else if (state.candidates.length < MAX_CANDIDATES) {
                    state.candidates.push(loaded);
                } else {
                    throw new Error(
                        `Remove a storyboard before opening more than ${MAX_CANDIDATES}.`
                    );
                }
                state.selectedCandidateId = loaded.id;
                state.drawEnabled = false;
                state.status = `${loaded.name} loaded.`;
                if (loaded.hydrationWarnings.length) {
                    state.error = (
                        `${loaded.hydrationWarnings.length} saved image`
                        + `${loaded.hydrationWarnings.length === 1 ? '' : 's'} could not be restored: `
                        + loaded.hydrationWarnings.slice(0, 3).join(' | ')
                    );
                }
            } catch (error) {
                fail(error);
                return;
            }
            state.busy = false;
            paint();
        }

        async function uploadPanel(files) {
            const file = files && files[0];
            const current = candidate();
            if (!file || !current || state.busy) return;
            try {
                const source = await fileDataUrl(file);
                const normalized = await normalizeImage(source, FRAME_WIDTH, FRAME_HEIGHT, 'cover');
                setPanelImage(current, current.selectedPanel, normalized, {
                    source: 'upload',
                    relation: 'new',
                });
                state.status = `Frame ${current.selectedPanel + 1} uploaded.`;
                paint();
            } catch (error) {
                fail(error);
            }
        }

        async function uploadReferences(files) {
            const current = candidate();
            if (!current || state.busy) return;
            try {
                const incoming = Array.from(files || []);
                const available = Math.max(
                    0,
                    MAX_REFERENCES - current.references.length
                );
                const selected = incoming.slice(0, available);
                for (const file of selected) {
                    const source = await fileDataUrl(file);
                    const image = await normalizeImage(source, 1024, 1024, 'contain');
                    current.references.push({
                        id: uid('ref'),
                        name: String(file.name || 'Reference').slice(0, 80),
                        image,
                        global: true,
                        panels: [],
                    });
                }
                touchCandidate(current);
                state.status = `${selected.length} reference${selected.length === 1 ? '' : 's'} added; ${current.references.length}/${MAX_REFERENCES} ready.`;
                state.error = incoming.length > available
                    ? `${incoming.length - available} reference${incoming.length - available === 1 ? '' : 's'} did not fit. Remove one before adding more.`
                    : '';
                paint();
            } catch (error) {
                fail(error);
            }
        }

        async function uploadStrips(files) {
            const incoming = Array.from(files || []);
            if (!incoming.length || state.busy) return;
            const blankSlot = (
                state.candidates.length === 1
                && replaceableBlank(state.candidates[0])
            );
            const available = Math.max(
                0,
                MAX_CANDIDATES - state.candidates.length
                    + (blankSlot ? 1 : 0)
            );
            if (!available) {
                fail(
                    `This batch holds ${MAX_CANDIDATES} storyboards. Remove one before importing another.`
                );
                return;
            }
            state.busy = true;
            state.error = '';
            let importedCount = 0;
            let processedCount = 0;
            const failures = [];
            for (
                let index = 0;
                index < incoming.length && importedCount < available;
                index++
            ) {
                const file = incoming[index];
                processedCount++;
                state.status = `Importing file ${index + 1}/${incoming.length}...`;
                paint();
                try {
                    const source = await fileDataUrl(file);
                    const frames = await splitStrip(source);
                    const imported = blankCandidate(
                        String(file.name || `Storyboard ${state.candidates.length + 1}`)
                            .replace(/\.[^.]+$/, '')
                            .slice(0, 80)
                    );
                    frames.forEach((image, panelIndex) => setPanelImage(imported, panelIndex, image, {
                        source: 'strip-upload',
                        relation: 'composite',
                    }));
                    imported.dirty = true;
                    if (
                        state.candidates.length === 1
                        && replaceableBlank(state.candidates[0])
                    ) state.candidates[0] = imported;
                    else state.candidates.push(imported);
                    state.selectedCandidateId = imported.id;
                    importedCount++;
                } catch (error) {
                    failures.push(
                        `${file.name || 'Image'}: ${error.message || error}`
                    );
                }
            }
            state.busy = false;
            state.status = `${importedCount} storyboard${importedCount === 1 ? '' : 's'} imported. Review the optional transcript, then score.`;
            const overflow = incoming.length - processedCount;
            const importError = [
                ...failures,
                overflow
                    ? `${overflow} file${overflow === 1 ? '' : 's'} did not fit; the ${MAX_CANDIDATES}-candidate limit never evicts existing work.`
                    : '',
            ].filter(Boolean).join(' | ');
            state.error = importError;
            paint();
        }

        function cloneCandidate(source) {
            const copy = JSON.parse(JSON.stringify(source));
            copy.id = uid('candidate');
            copy.serverId = null;
            copy.serverRevision = null;
            copy.name = `${source.name} copy`.slice(0, 80);
            copy.score = null;
            copy.scoreError = '';
            copy.scoreInputSha256 = null;
            copy.savedHookId = null;
            copy.dirty = true;
            copy.createdAt = Date.now();
            copy.updatedAt = Date.now();
            copy.panels.forEach((entry, index) => {
                entry.id = uid(`p${index + 1}`);
            });
            return copy;
        }

        function pointForEvent(canvas, event) {
            const bounds = canvas.getBoundingClientRect();
            return [
                (event.clientX - bounds.left) / Math.max(1, bounds.width) * FRAME_WIDTH,
                (event.clientY - bounds.top) / Math.max(1, bounds.height) * FRAME_HEIGHT,
            ];
        }

        async function restorePanelRevision(direction) {
            const current = candidate();
            const selected = panel();
            const source = direction === 'next'
                ? selected && selected.futureRevisions
                : selected && selected.revisions;
            if (
                !current
                || !selected
                || !source
                || !source.length
                || state.busy
            ) return;
            state.busy = true;
            state.status = `${direction === 'next' ? 'Advancing' : 'Restoring'} frame ${current.selectedPanel + 1}...`;
            paint();
            try {
                const targetRevision = source[source.length - 1];
                const image = await portableImageSource(
                    targetRevision.image
                    || targetRevision.media
                        && targetRevision.media.url
                );
                source.pop();
                const destination = direction === 'next'
                    ? selected.revisions
                    : selected.futureRevisions;
                destination.push(panelRevision(selected));
                if (destination.length > 12) destination.shift();
                selected.image = image;
                selected.source = targetRevision.source;
                selected.relation = targetRevision.relation;
                selected.sourcePanels =
                    targetRevision.sourcePanels || [];
                selected.prompt =
                    targetRevision.prompt || selected.prompt;
                selected.strokes = [];
                current.composite = null;
                invalidateScore(current);
                state.status = `Frame ${current.selectedPanel + 1} ${direction === 'next' ? 'advanced' : 'restored'}.`;
            } catch (error) {
                fail(error);
                return;
            }
            state.busy = false;
            paint();
        }

        function hydrateCanvas() {
            if (!host) return;
            const canvas = host.querySelector('[data-sb-draw-canvas]');
            const currentPanel = panel();
            if (!canvas || !currentPanel) return;
            drawStrokes(canvas.getContext('2d'), currentPanel.strokes);
            if (canvas.dataset.sbBound === '1') return;
            canvas.dataset.sbBound = '1';
            canvas.addEventListener('pointerdown', event => {
                if (
                    state.busy
                    || !state.drawEnabled
                    || activePointerId !== null
                    || event.button !== 0
                    || event.isPrimary === false
                ) return;
                event.preventDefault();
                activePointerId = event.pointerId;
                canvas.setPointerCapture(event.pointerId);
                activeStroke = {
                    tool: state.drawTool,
                    color: state.drawColor,
                    size: state.drawSize,
                    points: [pointForEvent(canvas, event)],
                };
                currentPanel.strokes.push(activeStroke);
                drawStrokes(canvas.getContext('2d'), currentPanel.strokes);
            });
            canvas.addEventListener('pointermove', event => {
                if (
                    !activeStroke
                    || event.pointerId !== activePointerId
                ) return;
                event.preventDefault();
                activeStroke.points.push(pointForEvent(canvas, event));
                drawStrokes(canvas.getContext('2d'), currentPanel.strokes);
            });
            const finish = event => {
                if (
                    !activeStroke
                    || event.pointerId !== activePointerId
                ) return;
                if (event.type === 'pointerup') {
                    activeStroke.points.push(
                        pointForEvent(canvas, event)
                    );
                }
                if (event && canvas.hasPointerCapture(event.pointerId)) {
                    canvas.releasePointerCapture(event.pointerId);
                }
                activeStroke = null;
                activePointerId = null;
                touchCandidate(candidate());
                paint();
            };
            canvas.addEventListener('pointerup', finish);
            canvas.addEventListener('pointercancel', finish);
            canvas.addEventListener('lostpointercapture', event => {
                if (event.pointerId !== activePointerId) return;
                activeStroke = null;
                activePointerId = null;
            });
        }

        function afterRender() {
            const nextHost = document.getElementById(
                'shorts-storyboard-workbench'
            );
            if (host && host !== nextHost) {
                activeStroke = null;
                activePointerId = null;
            }
            host = nextHost;
            if (!host) return;
            const rail = host.querySelector('[data-sb-panel-rail]');
            if (rail) {
                rail.scrollLeft = state.railScroll || 0;
                rail.addEventListener('scroll', () => {
                    state.railScroll = rail.scrollLeft;
                }, { passive: true });
            }
            hydrateCanvas();
            if (state.busy) {
                host.querySelectorAll(
                    'button, input, textarea, select'
                ).forEach(control => {
                    control.disabled = true;
                });
            }
            if (!state.savedLoaded && !state.savedLoading) loadSaved(false);
        }

        function handleClick(event) {
            const target = event.target.closest('[data-storyboard-workbench]') && event.target;
            if (!target) return false;
            const button = target.closest('button, [data-sb-panel]');
            if (!button) return false;
            if (button.hasAttribute('data-sb-dismiss-error')) {
                state.error = '';
                paint();
                return true;
            }
            if (state.busy) return true;
            if (button.hasAttribute('data-sb-new')) {
                if (state.candidates.length >= MAX_CANDIDATES) {
                    fail(
                        `Remove a storyboard before adding more than ${MAX_CANDIDATES}.`
                    );
                    return true;
                }
                const created = blankCandidate(`Opening ${state.candidates.length + 1}`);
                state.candidates.push(created);
                state.selectedCandidateId = created.id;
                state.drawEnabled = false;
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-panel')) {
                candidate().selectedPanel = Number(button.getAttribute('data-sb-panel')) || 0;
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-context-panel')) {
                const current = candidate();
                const currentPanel = current.panels[current.selectedPanel];
                const contextIndex = Number(
                    button.getAttribute('data-sb-context-panel')
                );
                const selected = new Set(
                    contextPanelIndexes(current, current.selectedPanel)
                );
                if (selected.has(contextIndex)) selected.delete(contextIndex);
                else selected.add(contextIndex);
                currentPanel.contextPanels = [...selected].sort(
                    (left, right) => left - right
                );
                touchCandidate(current);
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-generate-all')) {
                generateAll();
                return true;
            }
            if (button.hasAttribute('data-sb-generate-panel')) {
                generateSelected();
                return true;
            }
            if (button.hasAttribute('data-sb-upload-panel')) {
                pickFiles({
                    accept: 'image/jpeg,image/png,image/webp',
                    multiple: false,
                    onSelect: uploadPanel,
                });
                return true;
            }
            if (button.hasAttribute('data-sb-upload-strips')) {
                pickFiles({
                    accept: 'image/jpeg,image/png,image/webp',
                    multiple: true,
                    onSelect: uploadStrips,
                });
                return true;
            }
            if (button.hasAttribute('data-sb-add-reference')) {
                pickFiles({
                    accept: 'image/jpeg,image/png,image/webp',
                    multiple: true,
                    onSelect: uploadReferences,
                });
                return true;
            }
            if (button.hasAttribute('data-sb-ref-delete')) {
                const id = button.getAttribute('data-sb-ref-delete');
                candidate().references = candidate().references.filter(ref => ref.id !== id);
                touchCandidate(candidate());
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-ref-scope')) {
                const current = candidate();
                const ref = current.references.find(item => item.id === button.getAttribute('data-sb-ref-scope'));
                if (ref) {
                    if (ref.global) {
                        ref.global = false;
                        ref.panels = [current.selectedPanel];
                    } else if ((ref.panels || []).includes(current.selectedPanel)) {
                        ref.global = true;
                        ref.panels = [];
                    } else {
                        ref.panels = [...new Set((ref.panels || []).concat(current.selectedPanel))];
                    }
                    touchCandidate(current);
                    paint();
                }
                return true;
            }
            if (button.hasAttribute('data-sb-clear-panel')) {
                const current = candidate();
                setPanelImage(current, current.selectedPanel, null, { source: 'empty', relation: 'new' });
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-restore-panel')) {
                restorePanelRevision(
                    button.getAttribute('data-sb-restore-panel')
                );
                return true;
            }
            if (button.hasAttribute('data-sb-draw-mode')) {
                state.drawEnabled = (
                    button.getAttribute('data-sb-draw-mode') === 'draw'
                );
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-draw-tool')) {
                state.drawEnabled = true;
                state.drawTool = button.getAttribute('data-sb-draw-tool');
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-draw-color')) {
                state.drawColor = button.getAttribute('data-sb-draw-color');
                state.drawEnabled = true;
                state.drawTool = 'pen';
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-draw-undo')) {
                panel().strokes.pop();
                touchCandidate(candidate());
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-draw-clear')) {
                panel().strokes = [];
                touchCandidate(candidate());
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-draw-apply')) {
                applySketch();
                return true;
            }
            if (button.hasAttribute('data-sb-score-current')) {
                scoreCurrent();
                return true;
            }
            if (button.hasAttribute('data-sb-score-bottom')) {
                scoreCurrent();
                return true;
            }
            if (button.hasAttribute('data-sb-batch-score')) {
                scoreBatch();
                return true;
            }
            if (button.hasAttribute('data-sb-open-score')) {
                if (candidate().score && openScore) {
                    Promise.resolve(openScore(candidate().score)).catch(fail);
                }
                return true;
            }
            if (button.hasAttribute('data-sb-save')) {
                saveCurrent();
                return true;
            }
            if (button.hasAttribute('data-sb-select-candidate')) {
                state.selectedCandidateId = button.getAttribute('data-sb-select-candidate');
                state.drawEnabled = false;
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-open-candidate-score')) {
                const item = state.candidates.find(entry => entry.id === button.getAttribute('data-sb-open-candidate-score'));
                if (item && item.score && openScore) {
                    Promise.resolve(openScore(item.score)).catch(fail);
                }
                return true;
            }
            if (button.hasAttribute('data-sb-duplicate')) {
                const source = state.candidates.find(item => item.id === button.getAttribute('data-sb-duplicate'));
                if (source) {
                    if (state.candidates.length >= MAX_CANDIDATES) {
                        fail(
                            `Remove a storyboard before adding more than ${MAX_CANDIDATES}.`
                        );
                        return true;
                    }
                    const copy = cloneCandidate(source);
                    state.candidates.push(copy);
                    state.selectedCandidateId = copy.id;
                    paint();
                }
                return true;
            }
            if (button.hasAttribute('data-sb-delete-candidate')) {
                const id = button.getAttribute('data-sb-delete-candidate');
                if (state.candidates.length > 1) {
                    state.candidates = state.candidates.filter(item => item.id !== id);
                    if (state.selectedCandidateId === id) state.selectedCandidateId = state.candidates[0].id;
                    paint();
                }
                return true;
            }
            return false;
        }

        function handleInput(event) {
            const target = event.target;
            if (!target.closest || !target.closest('[data-storyboard-workbench]')) return false;
            if (state.busy) return true;
            const current = candidate();
            if (target.hasAttribute('data-sb-name')) {
                current.name = String(target.value || '').slice(0, 80);
                current.savedHookId = null;
                touchCandidate(current);
                return true;
            }
            if (target.hasAttribute('data-sb-saved-filter')) {
                state.savedFilter = String(target.value || '').slice(0, 80);
                paint();
                return true;
            }
            if (target.hasAttribute('data-sb-brief')) {
                current.brief = String(target.value || '').slice(0, 3000);
                touchCandidate(current);
                return true;
            }
            if (target.hasAttribute('data-sb-hook-text')) {
                current.hookText = String(target.value || '').slice(0, 2000);
                invalidateScore(current);
                return true;
            }
            if (target.hasAttribute('data-sb-edit-prompt')) {
                current.editPrompt = String(target.value || '').slice(0, 1800);
                return true;
            }
            if (target.hasAttribute('data-sb-panel-prompt')) {
                const index = Number(target.getAttribute('data-sb-panel-prompt')) || 0;
                current.panels[index].prompt = String(target.value || '').slice(0, 1800);
                touchCandidate(current);
                return true;
            }
            if (target.hasAttribute('data-sb-draw-size')) {
                state.drawSize = Number(target.value) || 7;
                return true;
            }
            return false;
        }

        function handleChange(event) {
            const target = event.target;
            if (!target.closest || !target.closest('[data-storyboard-workbench]')) return false;
            if (state.busy) return true;
            if (target.hasAttribute('data-sb-model')) {
                candidate().model = target.value;
                touchCandidate(candidate());
                paint();
                return true;
            }
            if (target.hasAttribute('data-sb-load-saved')) {
                loadStoryboard(target.value);
                return true;
            }
            return false;
        }

        function handleKeyDown(event) {
            if (!event.target.closest || !event.target.closest('[data-storyboard-workbench]')) return false;
            const tag = String(event.target.tagName || '').toLowerCase();
            const nativeUndoTarget = (
                ['input', 'textarea', 'select'].includes(tag)
                || event.target.isContentEditable
            );
            if (
                !nativeUndoTarget
                && state.drawEnabled
                && panel()
                && panel().strokes.length
                && (event.metaKey || event.ctrlKey)
                && event.key.toLowerCase() === 'z'
            ) {
                event.preventDefault();
                panel().strokes.pop();
                touchCandidate(candidate());
                paint();
                return true;
            }
            return false;
        }

        return {
            render,
            afterRender,
            handleClick,
            handleInput,
            handleChange,
            handleKeyDown,
            getState: () => state,
        };
    }

    window.JarvisStoryboardWorkbench = Object.freeze({ create });
}());
