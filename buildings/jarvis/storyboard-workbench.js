(function () {
    'use strict';

    const PANEL_COUNT = 5;
    const FRAME_WIDTH = 320;
    const FRAME_HEIGHT = 569;
    const SHEET_WIDTH = 1440;
    const SHEET_HEIGHT = 512;
    const MAX_CANDIDATES = 12;
    const MAX_REFERENCES = 8;
    const DEFAULT_MODEL = 'gpt-image-2';
    const STYLE_PRESETS = window.JarvisStoryboardStylePresets || {};
    const DEFAULT_STYLE_ID =
        STYLE_PRESETS.DEFAULT_STYLE_ID || 'photographic';
    const ANIMATION_STYLE_ID =
        STYLE_PRESETS.ANIMATION_STYLE_ID || 'stylized-3d-explainer-v1';
    const MODEL_REFERENCE_LIMITS = {
        'gpt-image-2': 8,
        'flux-2-pro': 8,
        'seedream-4': 8,
        'nano-banana': 6,
        'nano-banana-pro': 8,
    };
    const MODEL_OPTIONS = [
        ['gpt-image-2', 'GPT Image 2 (OpenAI)'],
        ['flux-2-pro', 'FLUX.2 Pro'],
        ['seedream-4', 'Seedream 4'],
        ['nano-banana', 'Nano Banana'],
        ['nano-banana-pro', 'Nano Banana Pro'],
    ];
    const SHEET_MODEL_VALUES = new Set([
        'gpt-image-2',
        'flux-2-pro',
        'seedream-4',
    ]);
    const PUBLIC_IMAGE_MODELS = Object.freeze(
        MODEL_OPTIONS.map(([value, label]) => Object.freeze({
            value,
            label,
        }))
    );
    const PUBLIC_SHEET_IMAGE_MODELS = Object.freeze(
        MODEL_OPTIONS.filter(([value]) => (
            SHEET_MODEL_VALUES.has(value)
        )).map(([value, label]) => Object.freeze({
            value,
            label,
        }))
    );
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
        const autoPersistDrafts = options.autoPersistDrafts === true;
        const enableFolders = options.enableFolders === true;
        const resumeLatestSaved = options.resumeLatestSaved === true;
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
                transcriptBeatAlignment: [],
                transcriptProvenance: null,
                openingContract: null,
                generationIntent: null,
                planningProviderCallCount: null,
                editPrompt: '',
                model: DEFAULT_MODEL,
                stylePreset: DEFAULT_STYLE_ID,
                generationMode: 'composite',
                selectedPanel: 0,
                panels: Array.from({ length: PANEL_COUNT }, (_, index) => blankPanel(index)),
                references: [],
                composite: null,
                score: null,
                scoreError: '',
                scoreInputSha256: null,
                savedHookId: null,
                mediaState: null,
                mediaError: '',
                folderId: null,
                saveState: 'idle',
                saveError: '',
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
            savedFolder: 'all',
            savedFolders: [],
            folderEditorOpen: false,
            folderName: '',
            resumeAttempted: false,
            railScroll: 0,
        };
        let host = null;
        let activeStroke = null;
        let activePointerId = null;
        let draggedPanelIndex = null;
        const saveQueues = new Map();
        const saveTimers = new Map();
        const savedHookHydrations = new Map();
        const storyboardHydrations = new Map();
        const storyboardRecordCache = new Map();

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
        const hasPersistableContent = item => !!(
            item
            && (
                item.serverId
                || item.name !== 'Untitled opening'
                || item.brief.trim()
                || item.hookText.trim()
                || item.references.length
                || item.stylePreset !== DEFAULT_STYLE_ID
                || item.composite
                || item.panels.some(entry => entry.image || entry.prompt)
            )
        );
        const replaceableBlank = item => !!(
            item
            && !item.serverId
            && item.pristine === true
            && !item.brief
            && !item.hookText
            && !item.references.length
            && item.stylePreset === DEFAULT_STYLE_ID
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
            if (item.saveState === 'saved') item.saveState = 'idle';
            item.mutationVersion = (
                Number(item.mutationVersion) || 0
            ) + 1;
            item.updatedAt = Date.now();
            scheduleAutoPersist(item);
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
            const workspace = host.closest('.experiment-lab-workspace');
            return {
                rail: rail ? rail.scrollLeft : state.railScroll,
                focusKey: active && active.getAttribute && active.getAttribute('data-sb-focus'),
                start: active && typeof active.selectionStart === 'number' ? active.selectionStart : null,
                end: active && typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
                workspaceLeft: workspace ? workspace.scrollLeft : null,
                workspaceTop: workspace ? workspace.scrollTop : null,
                pageX: window.scrollX,
                pageY: window.scrollY,
            };
        }

        function restoreUi(snapshot) {
            if (!host) return;
            const rail = host.querySelector('[data-sb-panel-rail]');
            const workspace = host.closest('.experiment-lab-workspace');
            if (rail) rail.scrollLeft = Number(snapshot && snapshot.rail) || state.railScroll || 0;
            if (snapshot && snapshot.focusKey) {
                const input = host.querySelector(
                    `[data-sb-focus="${snapshot.focusKey}"]`
                );
                if (input) {
                    try { input.focus({ preventScroll: true }); }
                    catch (error) { input.focus(); }
                    if (snapshot.start != null && input.setSelectionRange) {
                        input.setSelectionRange(snapshot.start, snapshot.end);
                    }
                }
            }
            if (workspace && snapshot.workspaceLeft != null) {
                workspace.scrollLeft = snapshot.workspaceLeft;
                workspace.scrollTop = snapshot.workspaceTop;
            }
            if (snapshot && snapshot.pageX != null) {
                window.scrollTo(snapshot.pageX, snapshot.pageY);
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

        function saveButtonLabel(current) {
            if (current.saveState === 'saving') return 'Saving...';
            if (current.saveState === 'saved' && !current.dirty) {
                return 'Saved';
            }
            return current.serverId ? 'Save revision' : 'Save';
        }

        function saveStateLabel(current) {
            if (current.saveState === 'saving') {
                return 'Saving quietly in the background';
            }
            if (current.saveState === 'error') {
                return current.saveError || 'Background save failed';
            }
            if (current.serverId && !current.dirty) {
                return `Saved in ${folderName(current.folderId)}`;
            }
            return 'Changes save automatically';
        }

        function syncPersistenceUi(current) {
            if (!host || !host.isConnected || candidate() !== current) {
                return;
            }
            const saveButton = host.querySelector('[data-sb-save]');
            if (saveButton) {
                saveButton.textContent = saveButtonLabel(current);
                saveButton.disabled = (
                    !hasPersistableContent(current)
                    || state.busy
                    || current.saveState === 'saving'
                );
            }
            const saveState = host.querySelector('[data-sb-save-state]');
            if (saveState) {
                saveState.textContent = saveStateLabel(current);
                saveState.classList.toggle(
                    'is-error',
                    current.saveState === 'error'
                );
                if (current.saveState === 'error') {
                    saveState.setAttribute('role', 'alert');
                } else {
                    saveState.removeAttribute('role');
                }
            }
        }

        function syncSavedPicker() {
            if (!host || !host.isConnected) return;
            const currentPicker = host.querySelector('.sb-saved-picker');
            if (
                !currentPicker
                || currentPicker.contains(document.activeElement)
            ) return;
            const wrapper = document.createElement('div');
            wrapper.innerHTML = renderSavedPicker();
            const nextPicker = wrapper.firstElementChild;
            if (nextPicker) currentPicker.replaceWith(nextPicker);
        }

        function imageSource(value) {
            return value ? esc(String(value)) : '';
        }

        function renderPanelRail(current) {
            return `<div class="sb-panel-rail" data-sb-panel-rail aria-label="Five storyboard frames">${
                current.panels.map((entry, index) => {
                    const selected = current.selectedPanel === index;
                    return `<div class="sb-panel-slot" data-sb-panel-slot="${index}">
                        <button type="button" class="sb-panel-tile${selected ? ' is-selected' : ''}" data-sb-panel="${index}" data-sb-panel-drag="${index}" draggable="true" aria-label="Select or drag frame ${index + 1}" title="Drag to reorder frame ${index + 1}">
                            <span class="sb-panel-number">${index + 1}</span>
                            ${entry.image
                                ? `<img src="${imageSource(entry.image)}" alt="Frame ${index + 1}">`
                                : `<span class="sb-panel-empty">+</span>`}
                            <span class="sb-panel-source">${esc(entry.source === 'empty' ? 'empty' : entry.source)}</span>
                        </button>
                        <div class="sb-panel-order-controls" aria-label="Move frame ${index + 1}">
                            <button type="button" data-sb-panel-move="-1" data-sb-panel-index="${index}" aria-label="Move frame ${index + 1} left" title="Move left" ${index === 0 ? 'disabled' : ''}>&#8592;</button>
                            <button type="button" data-sb-panel-move="1" data-sb-panel-index="${index}" aria-label="Move frame ${index + 1} right" title="Move right" ${index === current.panels.length - 1 ? 'disabled' : ''}>&#8594;</button>
                        </div>
                    </div>`;
                }).join('')
            }</div>`;
        }

        function renderWholePanel(current) {
            if (!current.composite) return '';
            return `<figure class="sb-whole-panel" data-sb-whole-panel>
                <div class="sb-whole-panel-image">
                    <img src="${imageSource(current.composite)}" alt="Five-frame storyboard panel">
                    <div class="sb-whole-panel-grid">${current.panels.map((entry, index) => (
                        `<button type="button" data-sb-panel="${index}" aria-label="Open frame ${index + 1}" title="Open frame ${index + 1}"><span>${index + 1}</span></button>`
                    )).join('')}</div>
                </div>
                <figcaption><strong>Whole panel</strong><span>5 equal 9:16 frames · 45:16 source sheet</span></figcaption>
            </figure>`;
        }

        function renderReferences(current) {
            const rows = current.references.map(ref => {
                return `<div class="sb-reference">
                    <img src="${imageSource(ref.image)}" alt="${esc(ref.name || 'Reference')}">
                    <div class="sb-reference-copy">
                        <strong>${esc(ref.name || 'Reference')}</strong>
                        <span>Used automatically for the whole panel and future edits</span>
                    </div>
                    <button type="button" class="sb-icon-button" data-sb-ref-delete="${esc(ref.id)}" title="Remove reference" aria-label="Remove reference" ${state.busy ? 'disabled' : ''}>&times;</button>
                </div>`;
            }).join('');
            return rows
                ? `<div class="sb-reference-section" data-sb-generation-references>
                    <div class="sb-reference-list">${rows}</div>
                </div>`
                : '';
        }

        function renderReferencePicker(current) {
            const count = current.references.length;
            const full = count >= MAX_REFERENCES;
            return `<div class="sb-reference-picker" data-sb-reference-picker>
                <span class="sb-reference-picker-copy">
                    <span>Reference photos</span>
                    <small>${count ? `${count}/${MAX_REFERENCES} attached` : 'Optional'}</small>
                </span>
                <button type="button" data-sb-add-reference data-sb-generation-reference-upload title="Upload a person, object, place, product, or visual-style reference" ${state.busy || full ? 'disabled' : ''}>${full ? 'Limit reached' : count ? 'Add another' : 'Upload reference'}</button>
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

        function renderAutomaticContext(current, panelIndex) {
            const selected = current.panels[panelIndex];
            const plan = automaticContextPlan(current, panelIndex, {
                baseImage: selected.image,
                sequenceImage: completeFrames(current)
                    ? '__automatic_live_five_frame_panel__'
                    : current.composite,
            });
            return `<div class="sb-frame-context">
                <div class="sb-section-head">
                    <span>Continuity</span>
                    <small>Automatic</small>
                </div>
                <div class="sb-context-summary" data-sb-auto-continuity>
                    ${plan.entries.length
                        ? `Frame ${panelIndex + 1} automatically sees the current frame, the complete five-frame sequence, and every established subject and object.`
                        : 'As frames are created, the full sequence is carried forward automatically.'}
                    No reference selection is required.
                </div>
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
                        <textarea rows="3" data-sb-panel-prompt="${index}" data-sb-focus="panel-prompt-${index}">${esc(selected.prompt || '')}</textarea>
                    </label>
                    <label>
                        <span>Edit instruction</span>
                        <textarea rows="2" data-sb-edit-prompt data-sb-focus="edit-prompt" placeholder="Change only what should be different">${esc(current.editPrompt || '')}</textarea>
                    </label>
                    ${renderAutomaticContext(current, index)}
                    <div class="sb-inspector-actions">
                        <button type="button" class="is-primary" data-sb-generate-panel ${state.busy ? 'disabled' : ''}>${selected.image ? 'Edit selected' : 'Generate selected'}</button>
                        <button type="button" data-sb-restore-panel="previous" ${selected.revisions.length ? '' : 'disabled'}>Previous</button>
                        <button type="button" data-sb-restore-panel="next" ${selected.futureRevisions && selected.futureRevisions.length ? '' : 'disabled'}>Next</button>
                    </div>
                    <div class="sb-lineage">
                        <span>${esc(selected.relation || 'new')}</span>
                        <span>${selected.revisions.length} prior revision${selected.revisions.length === 1 ? '' : 's'}</span>
                    </div>
                </div>
            </div>`;
        }

        function renderBuildProgress(current) {
            const frameCount = current.panels.filter(
                entry => entry.image
            ).length;
            const hasBrief = !!(
                current.brief.trim()
                || current.panels.some(entry => entry.prompt.trim())
            );
            const refined = current.panels.some(entry => (
                entry.revisions.length
                || ['panel-edit', 'annotated-frame'].includes(entry.source)
            ));
            const steps = [
                ['Scene', hasBrief ? 'Ready' : 'Describe it', hasBrief],
                ['Whole panel', `${frameCount}/${PANEL_COUNT} frames`, frameCount === PANEL_COUNT],
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
            const provenance = current.transcriptProvenance;
            const generated = !!(
                provenance
                && provenance.provider
                && provenance.provider !== 'user'
            );
            const evidence = generated
                ? `<details class="sb-transcript-evidence">
                    <summary>Transcript evidence</summary>
                    <p>Written separately by ${esc(provenance.model || provenance.provider)} from ${Number(provenance.example_count) || 0} measured high-keep openings selected from ${Number(provenance.source_population_count) || 0} joined Tyler videos. These examples supply structure only; this transcript is the exact text sent to scoring.</p>
                    <p>${esc(provenance.source_window || '')}</p>
                </details>`
                : '';
            return `<section class="sb-workflow-section sb-transcript-review" data-sb-section="transcript" data-sb-transcript-review>
                ${renderWorkflowHeader(
                    3,
                    generated ? 'Generated spoken opening' : 'Add spoken text',
                    generated
                        ? 'Separate transcript call, grounded in measured openings'
                        : 'Optional: exact user-supplied words; Score never rewrites them',
                    wordCount
                        ? `${wordCount} word${wordCount === 1 ? '' : 's'}`
                        : 'Visual only'
                )}
                <div class="sb-workflow-section-body sb-transcript-review-body">
                    <label class="sb-transcript-field">
                        <span>Spoken transcript (optional)</span>
                        <textarea rows="4" data-sb-hook-text data-sb-focus="hook-text" placeholder="Type exact spoken words, or leave blank for visual-only scoring.">${esc(current.hookText || '')}</textarea>
                    </label>
                    ${evidence}
                </div>
            </section>`;
        }

        function renderScoreBar(current, placement) {
            const complete = completeFrames(current);
            const loadingMedia = current.mediaState === 'loading';
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
                    <button type="button" class="is-primary" ${primaryAttribute} ${complete && !state.busy && !loadingMedia ? '' : 'disabled'}>${loadingMedia ? 'Loading saved frames' : current.score ? 'Score this opening again' : complete ? 'Score this opening' : `Add ${PANEL_COUNT - frameCount} more frame${PANEL_COUNT - frameCount === 1 ? '' : 's'} to score`}</button>
                </div>`;
            }
            return `<div class="sb-score-dock" data-sb-score-dock="top">
                <div class="sb-score-summary">
                    <strong>${loadingMedia ? 'Loading saved frames' : current.score ? 'Opening scored' : complete ? 'Ready to score' : `${frameCount}/${PANEL_COUNT} frames ready`}</strong>
                    <span>${scoreLedgerSha(current)
                        ? `Ledger ${esc(scoreLedgerSha(current).slice(0, 12))}...`
                        : complete
                            ? transcriptWords
                                ? `${transcriptWords} spoken word${transcriptWords === 1 ? '' : 's'} + five frames`
                                : 'Five frames · visual only'
                            : 'One canonical 21-coordinate score'}</span>
                </div>
                <button type="button" class="is-primary" ${primaryAttribute} ${complete && !state.busy && !loadingMedia ? '' : 'disabled'}>${loadingMedia ? 'Loading frames' : current.score ? 'Score again' : 'Score opening'}</button>
                ${state.candidates.length > 1 ? `<button type="button" data-sb-batch-score ${state.busy || !state.candidates.some(needsScore) ? 'disabled' : ''}>Score all ready</button>` : ''}
                ${current.score ? '<button type="button" data-sb-open-score>Open embeddings</button>' : ''}
                <button type="button" data-sb-save ${hasPersistableContent(current) && !state.busy && !loadingMedia && current.saveState !== 'saving' ? '' : 'disabled'}>${saveButtonLabel(current)}</button>
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
                    const status = item.mediaState === 'loading'
                        ? 'Loading saved frames'
                        : item.mediaState === 'error'
                            ? 'Frames failed'
                        : state.busyCandidateId === item.id
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
                            ${item.mediaState === 'error' && item.serverId ? `<button type="button" data-sb-retry-storyboard="${esc(item.serverId)}">Retry frames</button>` : ''}
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
                        ${renderWorkflowHeader('B', 'Generate a whole panel', 'Your exact scene goes directly to the image model', current.brief.trim() ? 'Scene ready' : 'Ready for a scene')}
                        <div class="sb-workflow-section-body sb-ai-route-body">
                            ${renderBuildProgress(current)}
                            <div class="sb-brief-grid is-single">
                                <label>
                                    <span>Describe the scene</span>
                                    <textarea rows="3" data-sb-brief data-sb-focus="brief" placeholder="What should happen from frame 1 through frame 5?">${esc(current.brief || '')}</textarea>
                                </label>
                            </div>
                            <div class="sb-generation-bar">
                                <label class="sb-model-picker"><span>Image model</span><select data-sb-model>${MODEL_OPTIONS.map(([value, label]) => `<option value="${value}" ${current.model === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
                                <label class="sb-style-toggle" title="Render all five frames with the consistent 3D animation preset">
                                    <input type="checkbox" role="switch" data-sb-animation-style ${current.stylePreset === ANIMATION_STYLE_ID ? 'checked' : ''}>
                                    <span class="sb-style-toggle-track" aria-hidden="true"><span></span></span>
                                    <strong>Animation</strong>
                                </label>
                                ${renderReferencePicker(current)}
                                <span class="sb-geometry-lock" title="Five contiguous equal-width columns">5 × 9:16 · 45:16</span>
                                <button type="button" class="is-primary" data-sb-generate-all ${state.busy ? 'disabled' : ''}>Generate 5-frame panel</button>
                            </div>
                            ${renderReferences(current)}
                        </div>
                    </section>
                </div>
                <section id="sb-workflow-refine" class="sb-workflow-section" data-sb-section="refine" tabindex="-1">
                    ${renderWorkflowHeader(2, 'Review and refine', 'The whole panel is already split; edits keep continuity automatically', `Frame ${current.selectedPanel + 1} of ${PANEL_COUNT}`)}
                    <div class="sb-workflow-section-body">
                        ${renderWholePanel(current)}
                        ${renderPanelRail(current)}
                        ${renderSelectedPanel(current)}
                    </div>
                </section>
                ${complete ? renderTranscriptReview(current) : ''}
                ${renderScoreBar(current, 'top')}
            </div>`;
        }

        function folderName(id) {
            if (!id) return 'Unfiled';
            const folder = state.savedFolders.find(
                item => item.id === id
            );
            return folder ? folder.name : 'Unfiled';
        }

        function folderOptions(selectedId, includeAll) {
            const options = [];
            if (includeAll) options.push(
                `<option value="all" ${selectedId === 'all' ? 'selected' : ''}>All folders</option>`
            );
            options.push(
                `<option value="" ${!selectedId ? 'selected' : ''}>Unfiled</option>`
            );
            state.savedFolders.forEach(folder => {
                options.push(
                    `<option value="${esc(folder.id)}" ${selectedId === folder.id ? 'selected' : ''}>${esc(folder.name)}</option>`
                );
            });
            return options.join('');
        }

        function renderSavedPicker() {
            const query = state.savedFilter.trim().toLowerCase();
            const visible = state.saved.filter(item => (
                (state.savedFolder === 'all'
                    || (item.folderId || '') === state.savedFolder)
                && (!query || String(
                    item.name || ''
                ).toLowerCase().includes(query))
            ));
            return `<div class="sb-saved-picker">
                <label><span>Saved</span><input type="search" data-sb-saved-filter data-sb-focus="saved-filter" value="${esc(state.savedFilter)}" placeholder="Find ${state.saved.length}"></label>
                ${enableFolders ? `<label><span>Folder</span><select data-sb-saved-folder>${folderOptions(state.savedFolder, true)}</select></label>` : ''}
                <label><span class="sb-visually-hidden">Open saved storyboard</span><select data-sb-load-saved ${state.savedLoading ? 'disabled' : ''}>
                    <option value="">${state.savedLoading ? 'Loading...' : `${visible.length} storyboard${visible.length === 1 ? '' : 's'}`}</option>
                    ${visible.map(item => `<option value="${esc(item.id)}">${enableFolders ? `${esc(folderName(item.folderId))} | ` : ''}${esc(item.name || 'Untitled')} | ${new Date(item.updatedAt || item.createdAt || 0).toLocaleDateString()}</option>`).join('')}
                </select></label>
            </div>`;
        }

        function renderFolderOrganizer(current) {
            if (!enableFolders) return '';
            const selectedFolder = current.folderId || '';
            return `<div class="sb-folder-organizer">
                <label><span>Save to folder</span><select data-sb-current-folder>${folderOptions(selectedFolder, false)}</select></label>
                <button type="button" data-sb-folder-new>${state.folderEditorOpen ? 'Cancel' : 'New folder'}</button>
                ${selectedFolder ? `<button type="button" data-sb-folder-delete title="Delete ${esc(folderName(selectedFolder))}">Delete folder</button>` : ''}
                ${state.folderEditorOpen ? `<div class="sb-folder-create"><input type="text" data-sb-folder-name data-sb-focus="folder-name" value="${esc(state.folderName)}" maxlength="120" placeholder="Folder name" aria-label="New folder name"><button type="button" class="is-primary" data-sb-folder-create>Create</button></div>` : ''}
                <span class="sb-save-state ${current.saveState === 'error' ? 'is-error' : ''}" data-sb-save-state>${esc(saveStateLabel(current))}</span>
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
                ${renderFolderOrganizer(current)}
                ${state.status ? `<div class="sb-status" role="status"><span></span>${esc(state.status)}</div>` : ''}
                ${state.error ? `<div class="sb-error" role="alert">${esc(state.error)}${current.mediaState === 'error' && current.serverId ? `<button type="button" data-sb-retry-storyboard="${esc(current.serverId)}">Retry saved frames</button>` : ''}<button type="button" data-sb-dismiss-error aria-label="Dismiss error">&times;</button></div>` : ''}
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
            if (/^\/api\/(?:storyboards\/media|raw\/saved-montage|hooks\/grpo\/montage)\//.test(value)) {
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

        async function normalizeStoryboardSheet(source, strict) {
            const image = await loadImage(source);
            const ratio = image.width / Math.max(1, image.height);
            if (strict && ratio < 2.1) {
                throw new Error(
                    'The image model did not return a horizontal five-frame '
                        + 'panel. Generate the whole panel again.'
                );
            }
            const canvas = document.createElement('canvas');
            canvas.width = SHEET_WIDTH;
            canvas.height = SHEET_HEIGHT;
            const context = canvas.getContext('2d');
            const scale = Math.max(
                SHEET_WIDTH / image.width,
                SHEET_HEIGHT / image.height
            );
            const width = image.width * scale;
            const height = image.height * scale;
            context.drawImage(
                image,
                (SHEET_WIDTH - width) / 2,
                (SHEET_HEIGHT - height) / 2,
                width,
                height
            );
            return canvas.toDataURL('image/jpeg', 0.9);
        }

        async function splitStrip(source) {
            const image = await loadImage(source);
            const horizontal = image.width >= image.height;
            let splitImage = image;
            if (horizontal) {
                const normalized = await normalizeStoryboardSheet(source);
                splitImage = await loadImage(normalized);
            }
            const sourceWidth = horizontal
                ? SHEET_WIDTH / PANEL_COUNT
                : splitImage.width;
            const sourceHeight = horizontal
                ? SHEET_HEIGHT
                : splitImage.height / PANEL_COUNT;
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
                    splitImage,
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

        async function rebuildComposite(current) {
            if (
                !completeFrames(current)
                || typeof composeFrames !== 'function'
            ) {
                current.composite = null;
                return;
            }
            const combined = await composeFrames(
                current.panels.map(entry => entry.image)
            );
            current.composite = await normalizeStoryboardSheet(combined);
        }

        async function reorderPanels(fromIndex, toIndex) {
            const current = candidate();
            const from = Number(fromIndex);
            const to = Number(toIndex);
            if (
                !current
                || state.busy
                || !Number.isInteger(from)
                || !Number.isInteger(to)
                || from < 0
                || to < 0
                || from >= current.panels.length
                || to >= current.panels.length
                || from === to
            ) return;
            const snapshot = {
                panels: current.panels.slice(),
                selectedPanel: current.selectedPanel,
                composite: current.composite,
                score: current.score,
                scoreError: current.scoreError,
                scoreInputSha256: current.scoreInputSha256,
                savedHookId: current.savedHookId,
            };
            const selectedId = current.panels[current.selectedPanel]
                && current.panels[current.selectedPanel].id;
            const moved = current.panels.splice(from, 1)[0];
            current.panels.splice(to, 0, moved);
            current.selectedPanel = Math.max(
                0,
                current.panels.findIndex(entry => entry.id === selectedId)
            );
            current.composite = null;
            current.score = null;
            current.scoreError = '';
            current.scoreInputSha256 = null;
            current.savedHookId = null;
            state.busy = true;
            state.busyCandidateId = current.id;
            state.error = '';
            state.status = `Moving frame ${from + 1} to position ${to + 1}...`;
            paint();
            try {
                await rebuildComposite(current);
                touchCandidate(current);
                state.busy = false;
                state.busyCandidateId = null;
                state.status = `Frame ${from + 1} moved to position ${to + 1}. Re-score this opening to measure the new sequence.`;
                paint();
            } catch (error) {
                current.panels = snapshot.panels;
                current.selectedPanel = snapshot.selectedPanel;
                current.composite = snapshot.composite;
                current.score = snapshot.score;
                current.scoreError = snapshot.scoreError;
                current.scoreInputSha256 = snapshot.scoreInputSha256;
                current.savedHookId = snapshot.savedHookId;
                fail(error);
            }
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
                    global: true,
                    panels: [],
                }));
        }

        function modelReferenceLimit(current) {
            return Math.min(
                MAX_REFERENCES,
                MODEL_REFERENCE_LIMITS[current.model]
                    || MAX_REFERENCES
            );
        }

        function automaticContextPlan(current, panelIndex, options) {
            options = options || {};
            const limit = modelReferenceLimit(current);
            const entries = [];
            const seen = new Set();
            const add = (image, name, role, sourcePanels) => {
                if (!image || seen.has(image) || entries.length >= limit) {
                    return;
                }
                seen.add(image);
                entries.push({
                    image,
                    name,
                    role,
                    sourcePanels: (sourcePanels || []).filter(index => (
                        Number.isInteger(index)
                        && index >= 0
                        && index < PANEL_COUNT
                    )),
                    global: false,
                    panels: [panelIndex],
                });
            };
            add(
                options.baseImage,
                `Current frame ${panelIndex + 1} - edit target`,
                'target-frame',
                [panelIndex]
            );
            add(
                options.sequenceImage,
                'Canonical five-frame sequence, left to right',
                'sequence-sheet',
                Array.from({ length: PANEL_COUNT }, (_, index) => index)
            );
            const byDistance = Array.from(
                { length: PANEL_COUNT },
                (_, index) => index
            ).filter(index => index !== panelIndex).sort((left, right) => (
                Math.abs(left - panelIndex)
                - Math.abs(right - panelIndex)
                || left - right
            ));
            byDistance.filter(index => (
                Math.abs(index - panelIndex) === 1
            )).forEach(index => add(
                current.panels[index].image,
                `Chronological neighbor - frame ${index + 1}`,
                'storyboard-frame',
                [index]
            ));
            current.references.forEach((reference, index) => add(
                reference.image,
                reference.name || `Optional source image ${index + 1}`,
                'external-source',
                []
            ));
            byDistance.filter(index => (
                Math.abs(index - panelIndex) !== 1
            )).forEach(index => add(
                current.panels[index].image,
                `Established frame ${index + 1}`,
                'storyboard-frame',
                [index]
            ));
            return {
                entries,
                refs: entries,
                sourcePanels: [...new Set(entries.flatMap(
                    entry => entry.sourcePanels
                ))].sort((left, right) => left - right),
                limit,
            };
        }

        async function generateComposite(current) {
            if (!SHEET_MODEL_VALUES.has(current.model)) {
                throw new Error(
                    'Complete hooks require a model that returns one exact '
                        + '45:16 sheet. Choose GPT Image 2, FLUX.2 Pro, or '
                        + 'Seedream 4. Nano Banana remains available for '
                        + 'explicit single-frame edits.'
                );
            }
            state.status = 'Generating one coherent five-panel sheet...';
            paint();
            const result = await runJob('/api/storyboards/generate', {
                async: true,
                intent: 'score-raw-user-input-v1',
                model: current.model,
                stylePreset: current.stylePreset,
                brief: current.brief,
                hookText: current.hookText,
                writeTranscript: false,
                panels: current.panels.map(entry => entry.prompt),
                refs: compositeReferences(current),
                layout: {
                    panelCount: PANEL_COUNT,
                    panelAspectRatio: '9:16',
                    sheetAspectRatio: '45:16',
                    direction: 'left-to-right',
                },
            });
            if (!result || !result.image) throw new Error('The image model returned no storyboard sheet.');
            const canonicalPanels = Array.isArray(result.panels)
                ? result.panels.filter(Boolean).slice(0, PANEL_COUNT)
                : [];
            const sheet = await normalizeStoryboardSheet(
                result.image,
                true
            );
            const frames = canonicalPanels.length === PANEL_COUNT
                ? canonicalPanels
                : await splitStrip(sheet);
            frames.forEach((image, index) => setPanelImage(current, index, image, {
                source: 'coherent-sheet',
                relation: 'composite',
                prompt: current.panels[index].prompt,
            }));
            current.composite = sheet;
            current.hookText = String(
                result.transcript || current.hookText || ''
            ).slice(0, 2000);
            current.transcriptBeatAlignment = Array.isArray(
                result.transcriptBeatAlignment
            ) ? result.transcriptBeatAlignment.slice(0, PANEL_COUNT) : [];
            current.transcriptProvenance =
                result.transcriptProvenance || null;
            current.openingContract = String(
                result.renderContract || 'canonical-score-raw-opening-v1'
            );
            current.generationIntent = String(
                result.generationIntent || 'score-raw-user-input-v1'
            );
            current.planningProviderCallCount = Number.isFinite(Number(
                result.planningProviderCallCount
            )) ? Number(result.planningProviderCallCount) : 0;
        }

        async function generateAll() {
            const current = candidate();
            if (!current || state.busy) return;
            if (
                !current.brief.trim()
                && !current.panels.some(entry => entry.prompt.trim())
            ) {
                fail(
                    'Describe the scene or add at least one '
                        + 'frame prompt first.'
                );
                return;
            }
            state.busy = true;
            state.busyCandidateId = current.id;
            state.error = '';
            try {
                await generateComposite(current);
                state.status = 'The five-frame panel is ready. Refine any frame, add optional spoken text, then score.';
            } catch (error) {
                fail(error);
                return;
            }
            state.busy = false;
            state.busyCandidateId = null;
            paint();
            autoPersistCandidate(current);
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
            state.busy = true;
            state.busyCandidateId = current.id;
            state.error = '';
            state.status = selected.image
                ? `Editing frame ${index + 1}...`
                : `Generating frame ${index + 1}...`;
            paint();
            try {
                const sequenceImage = completeFrames(current)
                    && typeof composeFrames === 'function'
                    ? await normalizeStoryboardSheet(
                        await composeFrames(
                            current.panels.map(entry => entry.image)
                        )
                    )
                    : current.composite;
                let baseImage = null;
                if (selected.image) {
                    baseImage = selected.strokes.length
                        ? await annotatedFrame(current, index, true)
                        : selected.image;
                }
                const context = automaticContextPlan(current, index, {
                    baseImage,
                    sequenceImage,
                });
                const relation = selected.image
                    ? 'edit'
                    : context.refs.length
                        ? 'compose'
                        : 'new';
                const result = await runJob('/api/storyboards/panel', {
                    async: true,
                    intent: 'manual-panel-edit',
                    model: current.model,
                    stylePreset: current.stylePreset,
                    prompt: selected.image && selected.strokes.length
                        ? `${prompt}. Follow the drawn markup as an edit guide, then remove all markup from the finished image.`
                        : prompt,
                    refs: context.refs,
                    relation,
                    targetPanel: index,
                    brief: current.brief,
                    panels: current.panels.map(entry => entry.prompt),
                    context: {
                        policy: 'automatic-continuity-v2',
                        sourcePanels: context.sourcePanels,
                        includesSequence: context.entries.some(
                            entry => entry.role === 'sequence-sheet'
                        ),
                    },
                });
                if (!result || !result.image) throw new Error('The image model returned no frame.');
                const normalized = await normalizeImage(result.image, FRAME_WIDTH, FRAME_HEIGHT, 'cover');
                setPanelImage(current, index, normalized, {
                    source: selected.image ? 'panel-edit' : 'panel-generation',
                    relation,
                    sourcePanels: context.sourcePanels,
                    prompt: selected.prompt,
                });
                await rebuildComposite(current);
                current.editPrompt = '';
                state.status = `Frame ${index + 1} is ready.`;
            } catch (error) {
                fail(error);
                return;
            }
            state.busy = false;
            state.busyCandidateId = null;
            paint();
            autoPersistCandidate(current);
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
                await rebuildComposite(current);
                state.status = `Sketch applied to frame ${current.selectedPanel + 1}.`;
                paint();
                autoPersistCandidate(current);
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
                transcriptBeatAlignment:
                    current.transcriptBeatAlignment,
                transcriptProvenance:
                    current.transcriptProvenance,
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
                storyboardPanelMediaSha256s:
                    assembled.panelMediaSha256s || null,
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
                    persistScoredCandidate(current, {
                        score: current.score,
                        title: current.name,
                        text: current.hookText,
                        montage: current.score.montageDataUrl,
                        folder: current.folderId,
                    });
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
                        persistScoredCandidate(current, {
                            score: current.score,
                            title: current.name,
                            text: current.hookText,
                            montage: current.score.montageDataUrl,
                            folder: current.folderId,
                        });
                    }
                } catch (error) {
                    current.scoreError = String((error && error.message) || error);
                }
            }
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
                score_panel_media_sha256s:
                    current.score.storyboardPanelMediaSha256s
                    || current.score.score_input
                        && current.score.score_input.panel_media_sha256s
                    || null,
                score_input: current.score.score_input || null,
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

        function updateSavedSummary(current, response, savedSnapshot) {
            const snapshot = savedSnapshot || current;
            const summary = {
                id: response.id,
                revision: response.revision,
                name: snapshot.name,
                model: snapshot.model,
                generationMode: snapshot.generationMode,
                complete: Array.isArray(snapshot.panels)
                    && snapshot.panels.every(panel => !!panel.image),
                scored: !!snapshot.score,
                folderId: snapshot.folderId || null,
                folder: snapshot.folderId || null,
                createdAt: current.createdAt,
                updatedAt: Date.now(),
            };
            state.saved = [
                summary,
                ...state.saved.filter(item => item.id !== summary.id),
            ];
            state.savedTotal = Math.max(
                state.savedTotal,
                state.saved.length
            );
        }

        async function persistCandidateOnce(current) {
            const saveVersion = Number(current.mutationVersion) || 0;
            const previousServerId = current.serverId;
            const savedSnapshot = {
                id: current.serverId,
                expectedRevision: current.serverRevision,
                name: current.name,
                brief: current.brief,
                hookText: current.hookText,
                transcriptBeatAlignment:
                    current.transcriptBeatAlignment,
                transcriptProvenance:
                    current.transcriptProvenance,
                openingContract:
                    current.openingContract,
                generationIntent:
                    current.generationIntent,
                planningProviderCallCount:
                    current.planningProviderCallCount,
                model: current.model,
                stylePreset: current.stylePreset,
                generationMode: current.generationMode,
                selectedPanel: current.selectedPanel,
                composite: current.composite,
                references: current.references,
                panels: current.panels,
                score: scoreSnapshot(current),
                savedHookId: current.savedHookId,
                folderId: current.folderId,
            };
            current.saveState = 'saving';
            current.saveError = '';
            syncPersistenceUi(current);
            const response = await requestJson('/api/storyboards/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(savedSnapshot),
            });
            current.serverId = response.id;
            current.serverRevision = response.revision;
            if (previousServerId) {
                storyboardRecordCache.delete(previousServerId);
            }
            storyboardRecordCache.delete(response.id);
            current.dirty = (
                Number(current.mutationVersion) || 0
            ) !== saveVersion;
            current.pristine = false;
            current.saveState = current.dirty ? 'idle' : 'saved';
            current.saveError = '';
            updateSavedSummary(current, response, savedSnapshot);
            syncPersistenceUi(current);
            return response;
        }

        function cancelScheduledSave(current) {
            if (!current) return;
            const timer = saveTimers.get(current.id);
            if (timer) window.clearTimeout(timer);
            saveTimers.delete(current.id);
        }

        function persistCandidate(current) {
            cancelScheduledSave(current);
            const previous = saveQueues.get(current.id)
                || Promise.resolve();
            const queued = previous.catch(() => {}).then(() => (
                persistCandidateOnce(current)
            ));
            saveQueues.set(current.id, queued);
            queued.finally(() => {
                if (saveQueues.get(current.id) === queued) {
                    saveQueues.delete(current.id);
                }
            }).catch(() => {});
            return queued.catch(error => {
                current.saveState = 'error';
                current.saveError = String(
                    error && error.message || error
                ).slice(0, 300);
                syncPersistenceUi(current);
                throw error;
            });
        }

        function scheduleAutoPersist(current) {
            if (
                !autoPersistDrafts
                || !current
                || current.mediaState === 'loading'
            ) return;
            cancelScheduledSave(current);
            const timer = window.setTimeout(() => {
                saveTimers.delete(current.id);
                autoPersistCandidate(current);
            }, 650);
            saveTimers.set(current.id, timer);
        }

        async function persistScoreArtifact(current, artifact) {
            const score = artifact && artifact.score || current && current.score;
            if (
                !current
                || !score
                || score.savedId
                || current.score === score && current.savedHookId
                || !saveScore
            ) return score && score.savedId || current && current.savedHookId || null;
            const saved = await saveScore(score, {
                title: artifact && artifact.title || current.name,
                text: artifact && artifact.text !== undefined
                    ? artifact.text
                    : current.hookText,
                montage: artifact && artifact.montage
                    || score.montageDataUrl,
                folder: artifact && artifact.folder !== undefined
                    ? artifact.folder
                    : current.folderId,
                transcript_beat_alignment:
                    current.transcriptBeatAlignment,
                transcript_provenance:
                    current.transcriptProvenance,
                opening_contract:
                    current.openingContract
                    || 'user-assembled-opening-v1',
                generation_intent:
                    current.generationIntent || null,
                planning_provider_call_count:
                    current.planningProviderCallCount,
                style_preset: current.stylePreset,
            });
            const savedHookId = saved && saved.id || null;
            score.savedId = savedHookId;
            score._labAutoSaved = autoPersistScore;
            if (current.score === score) {
                current.savedHookId = savedHookId;
            }
            if (savedHookId && current.score === score) {
                await persistCandidate(current);
            }
            return savedHookId;
        }

        function persistScoredCandidate(current, artifact) {
            persistCandidate(current).then(() => (
                persistScoreArtifact(current, artifact)
            )).catch(error => {
                current.saveState = 'error';
                current.saveError = `Background save failed: ${String(
                    error && error.message || error
                )}`.slice(0, 300);
                syncPersistenceUi(current);
                reportError(current.saveError);
            });
        }

        async function autoPersistCandidate(current) {
            if (
                !autoPersistDrafts
                || current && current.mediaState === 'loading'
                || !hasPersistableContent(current)
            ) {
                return null;
            }
            try {
                return await persistCandidate(current);
            } catch (error) {
                reportError(error);
                return null;
            }
        }

        async function saveCurrent() {
            const current = candidate();
            if (
                !current
                || state.busy
                || current.mediaState === 'loading'
                || current.saveState === 'saving'
                || !hasPersistableContent(current)
            ) return;
            if (current.serverId && !current.dirty) {
                syncPersistenceUi(current);
                return;
            }
            try {
                await persistCandidate(current);
            } catch (error) {
                reportError(error);
                return;
            }
            if (current.score && !current.savedHookId) {
                persistScoreArtifact(current).catch(error => {
                    current.saveState = 'error';
                    current.saveError = `Saved Hooks link failed: ${String(error && error.message || error)}`.slice(0, 300);
                    syncPersistenceUi(current);
                    reportError(current.saveError);
                });
            }
        }

        function prepareStoredCandidate(record, current) {
            const target = current || blankCandidate(
                record.name || 'Saved storyboard'
            );
            target.serverId = record.id;
            target.serverRevision = record.revision;
            target.name = record.name || target.name;
            target.brief = record.brief || '';
            target.hookText = record.hookText || '';
            target.transcriptBeatAlignment = Array.isArray(
                record.transcriptBeatAlignment
            ) ? record.transcriptBeatAlignment.slice(0, PANEL_COUNT) : [];
            target.transcriptProvenance =
                record.transcriptProvenance || null;
            target.openingContract = record.openingContract || null;
            target.generationIntent = record.generationIntent || null;
            target.planningProviderCallCount = Number.isFinite(Number(
                record.planningProviderCallCount
            )) ? Number(record.planningProviderCallCount) : null;
            target.model = MODEL_OPTIONS.some(
                ([value]) => value === record.model
            ) ? record.model : DEFAULT_MODEL;
            target.stylePreset = (
                record.stylePreset === ANIMATION_STYLE_ID
                    ? ANIMATION_STYLE_ID
                    : DEFAULT_STYLE_ID
            );
            target.generationMode = record.generationMode || 'composite';
            target.selectedPanel = Math.max(
                0,
                Math.min(4, Number(record.selectedPanel) || 0)
            );
            target.composite = null;
            target.references = [];
            target.panels = Array.from(
                { length: PANEL_COUNT },
                (_, index) => {
                    const stored = record.panels
                        && record.panels[index] || {};
                    return {
                        ...blankPanel(index),
                        ...stored,
                        image: null,
                        strokes: Array.isArray(stored.strokes)
                            ? stored.strokes
                            : [],
                        revisions: Array.isArray(stored.revisions)
                            ? stored.revisions
                            : [],
                        futureRevisions: [],
                    };
                }
            );
            target.score = null;
            target.savedHookId = record.savedHookId || null;
            target.folderId = record.folderId
                || record.folder
                || (state.saved.find(
                    item => item.id === record.id
                ) || {}).folderId
                || null;
            target.saveState = 'saved';
            target.saveError = '';
            target.dirty = false;
            target.pristine = false;
            target.mutationVersion = 0;
            target.mediaState = 'loading';
            target.mediaError = '';
            target.hydrationWarnings = [];
            return target;
        }

        async function hydrateStoredCandidate(record, current, loadToken) {
            const warnings = [];
            const mutationVersion = Number(current.mutationVersion) || 0;
            const scoreMontage = record.score
                && record.score.score_montage || null;
            const referenceRows = Array.isArray(record.references)
                ? record.references
                : [];
            const panelRows = Array.from(
                { length: PANEL_COUNT },
                (_, index) => record.panels
                    && record.panels[index] || {}
            );
            const mediaJobs = [
                ...referenceRows.map((reference, index) => ({
                    type: 'reference',
                    index,
                    source: reference.image,
                    label: `Reference ${index + 1}`,
                })),
                ...panelRows.map((storedPanel, index) => ({
                    type: 'panel',
                    index,
                    source: storedPanel.image,
                    label: `Frame ${index + 1}`,
                })),
                ...(scoreMontage && scoreMontage.url ? [{
                    type: 'score-montage',
                    index: 0,
                    source: scoreMontage.url,
                    label: 'Scored montage',
                }] : []),
            ];
            const loadedMedia = await mapLimited(
                mediaJobs,
                4,
                async job => {
                    if (!job.source) return { ...job, image: null };
                    try {
                        return {
                            ...job,
                            image: await portableImageSource(
                                job.source
                            ),
                        };
                    } catch (error) {
                        warnings.push(
                            `${job.label}: ${error.message || error}`
                        );
                        return { ...job, image: null };
                    }
                }
            );
            const referenceImages = new Map();
            const panelImages = Array(PANEL_COUNT).fill(null);
            let montageDataUrl = null;
            loadedMedia.forEach(media => {
                if (media.type === 'reference') {
                    referenceImages.set(media.index, media.image);
                } else if (media.type === 'panel') {
                    panelImages[media.index] = media.image;
                } else if (media.type === 'score-montage') {
                    montageDataUrl = media.image;
                }
            });
            if (
                !state.candidates.includes(current)
                || current.mediaLoadToken !== loadToken
            ) return current;
            current.references = referenceRows.map(
                (reference, index) => ({
                    ...reference,
                    image: referenceImages.get(index) || null,
                })
            ).filter(reference => !!reference.image);
            current.panels.forEach((storedPanel, index) => {
                storedPanel.image = panelImages[index] || null;
            });
            if (completeFrames(current)) {
                try {
                    await rebuildComposite(current);
                } catch (error) {
                    warnings.push(
                        `Whole panel: ${error.message || error}`
                    );
                    if (record.composite) {
                        try {
                            current.composite = await portableImageSource(
                                record.composite
                            );
                        } catch (compositeError) {
                            warnings.push(
                                `Stored whole panel: ${
                                    compositeError.message
                                    || compositeError
                                }`
                            );
                        }
                    }
                }
            }
            if (
                record.score
                && record.score.score_ledger
                && (Number(current.mutationVersion) || 0)
                    === mutationVersion
            ) {
                current.score = {
                    ...record.score,
                    title: current.name,
                    transcript: current.hookText,
                    dur_s: record.score.duration_s,
                    montageDataUrl,
                    storyboardScoreMontage: scoreMontage,
                    storyboardCandidateId: current.id,
                    storyboardFrames: current.panels.map(
                        entry => entry.image
                    ),
                    source: 'storyboard-saved',
                };
            }
            current.mediaState = completeFrames(current)
                ? 'ready'
                : 'error';
            current.mediaError = current.mediaState === 'error'
                ? 'One or more saved frames could not be restored.'
                : '';
            current.hydrationWarnings = warnings;
            current.saveState = current.dirty ? 'idle' : 'saved';
            return current;
        }

        async function loadSaved(force) {
            if (state.savedLoading || (state.savedLoaded && !force)) return;
            state.savedLoading = true;
            let resumeId = null;
            try {
                const rows = [];
                let folders = [];
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
                    if (Array.isArray(response.folders)) {
                        folders = response.folders;
                    }
                    total = Math.max(
                        total,
                        Number(response.total) || 0
                    );
                    rows.push(...page);
                    offset += page.length;
                    if (!page.length) break;
                } while (offset < total);
                state.saved = [...new Map(rows.map(row => [
                    row.id,
                    {
                        ...row,
                        folderId: row.folderId || row.folder || null,
                    },
                ])).values()].sort((left, right) => (
                    Number(right.updatedAt || right.createdAt || 0)
                    - Number(left.updatedAt || left.createdAt || 0)
                ));
                state.savedFolders = folders;
                state.savedTotal = total || state.saved.length;
                state.savedLoaded = true;
                if (
                    resumeLatestSaved
                    && !state.resumeAttempted
                    && state.saved.length
                    && state.candidates.length === 1
                    && replaceableBlank(state.candidates[0])
                ) {
                    state.resumeAttempted = true;
                    resumeId = state.saved[0].id;
                }
            } catch (error) {
                state.error = String((error && error.message) || error);
                state.savedLoaded = true;
                reportError(error);
            }
            state.savedLoading = false;
            if (resumeId) {
                window.setTimeout(() => loadStoryboard(resumeId), 0);
            } else {
                syncSavedPicker();
            }
        }

        async function moveCurrentFolder(folderId) {
            const current = candidate();
            if (!current || !enableFolders) return;
            const nextFolder = folderId || null;
            const previousFolder = current.folderId || null;
            current.folderId = nextFolder;
            if (!current.serverId) {
                touchCandidate(current);
                syncPersistenceUi(current);
                return;
            }
            current.saveState = 'saving';
            syncPersistenceUi(current);
            try {
                await requestJson('/api/experimentlab/item/move', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        kind: 'storyboards',
                        id: current.serverId,
                        folderId: nextFolder,
                    }),
                });
                current.saveState = 'saved';
                const summary = state.saved.find(
                    item => item.id === current.serverId
                );
                if (summary) {
                    summary.folderId = nextFolder;
                    summary.folder = nextFolder;
                }
            } catch (error) {
                current.folderId = previousFolder;
                current.saveState = 'error';
                current.saveError = String(error && error.message || error);
                const folderSelect = host && host.querySelector(
                    '[data-sb-current-folder]'
                );
                if (folderSelect) folderSelect.value = previousFolder || '';
                reportError(current.saveError);
            }
            syncPersistenceUi(current);
        }

        async function createStoryboardFolder() {
            const name = state.folderName.trim();
            if (!name || !enableFolders) return;
            try {
                const response = await requestJson(
                    '/api/experimentlab/folder',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            kind: 'storyboards',
                            name,
                        }),
                    }
                );
                if (!response || !response.folder) {
                    throw new Error('Folder creation returned no folder.');
                }
                state.savedFolders = [
                    ...state.savedFolders.filter(
                        item => item.id !== response.folder.id
                    ),
                    response.folder,
                ];
                state.folderEditorOpen = false;
                state.folderName = '';
                await moveCurrentFolder(response.folder.id);
            } catch (error) {
                state.error = String(error && error.message || error);
                paint();
            }
        }

        async function deleteCurrentFolder() {
            const current = candidate();
            const folderId = current && current.folderId;
            if (!folderId || !enableFolders) return;
            if (!window.confirm(
                `Delete ${folderName(folderId)}? Its storyboards will become Unfiled.`
            )) return;
            try {
                await requestJson('/api/experimentlab/folder/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        kind: 'storyboards',
                        id: folderId,
                    }),
                });
                state.savedFolders = state.savedFolders.filter(
                    item => item.id !== folderId
                );
                state.saved.forEach(item => {
                    if (item.folderId === folderId) {
                        item.folderId = null;
                        item.folder = null;
                    }
                });
                state.candidates.forEach(item => {
                    if (item.folderId === folderId) item.folderId = null;
                });
                if (state.savedFolder === folderId) {
                    state.savedFolder = 'all';
                }
                state.status = 'Folder deleted. Its storyboards are now Unfiled.';
            } catch (error) {
                state.error = String(error && error.message || error);
            }
            paint();
        }

        function loadStoryboardRecord(id) {
            const cached = storyboardRecordCache.get(id);
            if (cached && cached.record) {
                return Promise.resolve(cached.record);
            }
            if (cached && cached.promise) return cached.promise;
            const request = requestJson(
                `/api/storyboards/${encodeURIComponent(id)}`,
                {
                    cache: 'force-cache',
                    _timeoutMs: 12000,
                    _retryDelays: [500],
                }
            ).then(record => {
                storyboardRecordCache.set(id, {
                    record,
                    touchedAt: Date.now(),
                });
                const cachedIds = [...storyboardRecordCache.entries()]
                    .filter(([, value]) => value && value.record)
                    .sort((left, right) => (
                        Number(left[1].touchedAt || 0)
                        - Number(right[1].touchedAt || 0)
                    ));
                while (cachedIds.length > 24) {
                    storyboardRecordCache.delete(cachedIds.shift()[0]);
                }
                return record;
            }).catch(error => {
                storyboardRecordCache.delete(id);
                throw error;
            });
            storyboardRecordCache.set(id, {
                promise: request,
                touchedAt: Date.now(),
            });
            return request;
        }

        async function loadStoryboard(id) {
            const key = String(id || '');
            if (!key) return null;
            let current = state.candidates.find(
                item => String(item.serverId || '') === key
            );
            if (current && current.dirty) {
                state.selectedCandidateId = current.id;
                state.status = '';
                state.error = 'This storyboard has unsaved edits in the workspace. Save or remove that copy before reopening it.';
                paint();
                return null;
            }
            if (current && current.mediaState !== 'error') {
                state.selectedCandidateId = current.id;
                state.drawEnabled = false;
                state.error = current.mediaError || '';
                state.status = current.mediaState === 'loading'
                    ? `${current.name} is already open. Its saved frames are still loading.`
                    : `${current.name} is open in the editor.`;
                paint();
                return storyboardHydrations.get(key)
                    || Promise.resolve(current.id);
            }
            if (!current) {
                if (
                    state.candidates.length >= MAX_CANDIDATES
                    && !(
                        state.candidates.length === 1
                        && replaceableBlank(state.candidates[0])
                    )
                ) {
                    state.error = `Remove a storyboard before opening more than ${MAX_CANDIDATES}.`;
                    paint();
                    return null;
                }
                const summary = state.saved.find(item => item.id === key);
                current = blankCandidate(
                    summary && summary.name || 'Saved storyboard'
                );
                current.serverId = key;
                current.serverRevision = summary && summary.revision || null;
                current.folderId = summary && (
                    summary.folderId || summary.folder
                ) || null;
                current.pristine = false;
                current.dirty = false;
                current.saveState = 'saved';
                current.mediaState = 'loading';
                if (
                    state.candidates.length === 1
                    && replaceableBlank(state.candidates[0])
                ) state.candidates[0] = current;
                else state.candidates.push(current);
            } else {
                current.mediaState = 'loading';
                current.mediaError = '';
            }
            state.selectedCandidateId = current.id;
            state.drawEnabled = false;
            state.error = '';
            state.status = `${current.name} is open. Loading its saved frames...`;
            paint();
            const loadToken = uid('storyboard-load');
            current.mediaLoadToken = loadToken;
            const hydration = Promise.resolve().then(async () => {
                const record = await loadStoryboardRecord(key);
                if (
                    !state.candidates.includes(current)
                    || current.mediaLoadToken !== loadToken
                ) return current.id;
                prepareStoredCandidate(record, current);
                current.mediaLoadToken = loadToken;
                if (candidate() === current) {
                    state.status = `${current.name} is open. Loading its five saved frames...`;
                    state.error = '';
                    paint();
                }
                await hydrateStoredCandidate(
                    record,
                    current,
                    loadToken
                );
                if (
                    !state.candidates.includes(current)
                    || current.mediaLoadToken !== loadToken
                ) return current.id;
                if (candidate() === current) {
                    state.status = current.mediaState === 'ready'
                        ? `${current.name} is ready in the editor.`
                        : `${current.name} opened with incomplete saved media.`;
                    state.error = current.hydrationWarnings.length
                        ? (
                            `${current.hydrationWarnings.length} saved image`
                            + `${current.hydrationWarnings.length === 1 ? '' : 's'} could not be restored: `
                            + current.hydrationWarnings.slice(0, 3).join(' | ')
                        )
                        : current.mediaError || '';
                    paint();
                }
                return current.id;
            }).catch(error => {
                if (
                    state.candidates.includes(current)
                    && current.mediaLoadToken === loadToken
                ) {
                    current.mediaState = 'error';
                    current.mediaError = `Saved storyboard failed to load: ${String(
                        error && error.message || error
                    )}`.slice(0, 500);
                    if (candidate() === current) {
                        state.status = `${current.name} is open, but loading failed.`;
                        state.error = `${current.mediaError} Select it again to retry.`;
                        paint();
                    }
                    reportError(current.mediaError);
                }
                return null;
            }).finally(() => {
                if (storyboardHydrations.get(key) === hydration) {
                    storyboardHydrations.delete(key);
                }
            });
            storyboardHydrations.set(key, hydration);
            return hydration;
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
                await rebuildComposite(current);
                state.status = `Frame ${current.selectedPanel + 1} uploaded.`;
                paint();
                autoPersistCandidate(current);
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
            const importedCandidates = [];
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
                    await rebuildComposite(imported);
                    imported.dirty = true;
                    if (
                        state.candidates.length === 1
                        && replaceableBlank(state.candidates[0])
                    ) state.candidates[0] = imported;
                    else state.candidates.push(imported);
                    state.selectedCandidateId = imported.id;
                    importedCandidates.push(imported);
                    importedCount++;
                } catch (error) {
                    failures.push(
                        `${file.name || 'Image'}: ${error.message || error}`
                    );
                }
            }
            state.status = `${importedCount} storyboard${importedCount === 1 ? '' : 's'} imported. Saving to your workspace...`;
            const overflow = incoming.length - processedCount;
            const importError = [
                ...failures,
                overflow
                    ? `${overflow} file${overflow === 1 ? '' : 's'} did not fit; the ${MAX_CANDIDATES}-candidate limit never evicts existing work.`
                    : '',
            ].filter(Boolean).join(' | ');
            state.error = importError;
            paint();
            for (const imported of importedCandidates) {
                autoPersistCandidate(imported);
            }
            state.busy = false;
            state.status = `${importedCount} storyboard${importedCount === 1 ? '' : 's'} imported. Review the optional transcript, then score.`;
            paint();
        }

        async function importOpening(input) {
            const source = input || {};
            const openingLabel = source.savedHook === true
                ? 'Saved opening'
                : 'Opening';
            const sourceId = String(source.id || source.candidateId || '');
            const sourceCandidateId = String(source.candidateId || '');
            const alreadyOpen = state.candidates.find(item => (
                sourceCandidateId && String(item.id) === sourceCandidateId
            ) || (
                sourceId && (
                    String(item.sourceOpeningId || '') === sourceId
                    || String(item.sourceSavedHookId || '') === sourceId
                )
            ));
            if (alreadyOpen && alreadyOpen.mediaState === 'error') {
                state.candidates = state.candidates.filter(
                    item => item !== alreadyOpen
                );
                savedHookHydrations.delete(alreadyOpen.id);
            } else if (alreadyOpen) {
                state.selectedCandidateId = alreadyOpen.id;
                state.status = alreadyOpen.mediaState === 'loading'
                    ? `${alreadyOpen.name} is already open; its saved frames are still loading.`
                    : `${alreadyOpen.name} is already open in the editor.`;
                state.error = alreadyOpen.mediaError || '';
                paint();
                return {
                    candidateId: alreadyOpen.id,
                    mediaReady: savedHookHydrations.get(alreadyOpen.id)
                        || Promise.resolve(alreadyOpen.id),
                };
            }
            const blankSlot = (
                state.candidates.length === 1
                && replaceableBlank(state.candidates[0])
            );
            if (!blankSlot && state.candidates.length >= MAX_CANDIDATES) {
                throw new Error(
                    `This workbench holds ${MAX_CANDIDATES} storyboards. Remove one before editing another saved opening.`
                );
            }
            state.error = '';
            const draft = blankCandidate(
                String(source.title || 'Opening').slice(0, 80)
            );
            const promptRows = Array.isArray(source.frames)
                ? source.frames
                : [];
            const frameImages = Array.isArray(source.frameImages)
                ? source.frameImages.filter(Boolean).slice(0, PANEL_COUNT)
                : [];
            draft.brief = String(
                source.idea || source.title || ''
            ).slice(0, 3000);
            draft.hookText = String(source.text || '').slice(0, 2000);
            draft.openingContract = source.openingContract
                || source.opening_contract
                || null;
            draft.generationIntent = source.generationIntent
                || source.generation_intent
                || null;
            const planningProviderCallCount = Number(
                source.planningProviderCallCount
                ?? source.planning_provider_call_count
            );
            draft.planningProviderCallCount = Number.isFinite(
                planningProviderCallCount
            ) ? planningProviderCallCount : null;
            draft.sourceOpeningId = sourceId || null;
            draft.sourceSavedHookId = source.id || null;
            draft.folderId = (
                enableFolders
                && state.savedFolders.some(folder => (
                    String(folder.id) === String(source.folderId || '')
                ))
            ) ? source.folderId : null;
            draft.panels.forEach((frame, index) => {
                const promptRow = promptRows[index];
                frame.prompt = String(
                    typeof promptRow === 'string'
                        ? promptRow
                        : promptRow && (
                            promptRow.prompt
                            || promptRow.caption
                            || promptRow.text
                        ) || ''
                ).slice(0, 1800);
            });
            draft.pristine = false;
            draft.mediaState = source.montage || frameImages.length
                ? 'loading'
                : 'empty';
            if (blankSlot) state.candidates[0] = draft;
            else state.candidates.push(draft);
            state.selectedCandidateId = draft.id;
            state.drawEnabled = false;
            state.status = draft.mediaState === 'loading'
                ? `${draft.name} is open. Loading its five frames...`
                : `${openingLabel} text is ready. Add or generate frames, then score the revision.`;
            paint();
            if (draft.mediaState !== 'loading') {
                autoPersistCandidate(draft);
                return {
                    candidateId: draft.id,
                    mediaReady: Promise.resolve(draft.id),
                };
            }
            const mediaReady = Promise.resolve().then(async () => {
                let images;
                if (source.montage) {
                    images = await splitStrip(source.montage);
                } else {
                    images = await Promise.all(frameImages.map(image => (
                        normalizeImage(
                            image,
                            FRAME_WIDTH,
                            FRAME_HEIGHT,
                            'cover'
                        )
                    )));
                }
                if (!state.candidates.includes(draft)) return;
                draft.panels = Array.from(
                    { length: PANEL_COUNT },
                    (_, index) => ({
                        ...blankPanel(index),
                        image: images[index] || null,
                        prompt: draft.panels[index]
                            && draft.panels[index].prompt || '',
                        source: images[index]
                            ? 'saved-opening'
                            : 'empty',
                        relation: images[index]
                            ? 'editable-revision'
                            : 'new',
                        sourcePanels: images[index] ? [index] : [],
                    })
                );
                if (!completeFrames(draft)) {
                    throw new Error(
                        `Only ${draft.panels.filter(
                            frame => !!frame.image
                        ).length} of ${PANEL_COUNT} saved frames loaded.`
                    );
                }
                if (!draft.composite) {
                    await rebuildComposite(draft);
                }
                draft.mediaState = 'ready';
                draft.mediaError = '';
                draft.dirty = true;
                draft.updatedAt = Date.now();
                if (candidate() === draft) {
                    state.status = `${openingLabel} is ready in the editor as an editable revision. Change its text, visuals, or frame order, then re-score it.`;
                    state.error = '';
                }
                paint();
                autoPersistCandidate(draft);
                return draft.id;
            }).catch(error => {
                if (!state.candidates.includes(draft)) return;
                draft.mediaState = 'error';
                draft.mediaError = `Saved frames failed to load: ${String(
                    error && error.message || error
                )}`.slice(0, 500);
                if (candidate() === draft) {
                    state.status = `${draft.name} is open, but its frames did not load.`;
                    state.error = `${draft.mediaError} Retry by opening this opening again.`;
                }
                reportError(draft.mediaError);
                paint();
                throw error;
            }).finally(() => {
                savedHookHydrations.delete(draft.id);
            });
            savedHookHydrations.set(draft.id, mediaReady);
            return { candidateId: draft.id, mediaReady };
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
            copy.saveState = 'idle';
            copy.saveError = '';
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
                await rebuildComposite(current);
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
                draggedPanelIndex = null;
            }
            host = nextHost;
            if (!host) return;
            const rail = host.querySelector('[data-sb-panel-rail]');
            if (rail) {
                rail.scrollLeft = state.railScroll || 0;
                rail.addEventListener('scroll', () => {
                    state.railScroll = rail.scrollLeft;
                }, { passive: true });
                rail.addEventListener('dragstart', event => {
                    const tile = event.target.closest(
                        '[data-sb-panel-drag]'
                    );
                    if (!tile || state.busy) {
                        event.preventDefault();
                        return;
                    }
                    draggedPanelIndex = Number(
                        tile.getAttribute('data-sb-panel-drag')
                    );
                    tile.classList.add('is-dragging');
                    if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData(
                            'text/plain',
                            String(draggedPanelIndex)
                        );
                    }
                });
                rail.addEventListener('dragover', event => {
                    const slot = event.target.closest(
                        '[data-sb-panel-slot]'
                    );
                    if (!slot || draggedPanelIndex == null) return;
                    event.preventDefault();
                    if (event.dataTransfer) {
                        event.dataTransfer.dropEffect = 'move';
                    }
                    rail.querySelectorAll('.is-drop-target').forEach(
                        element => element.classList.remove(
                            'is-drop-target'
                        )
                    );
                    slot.classList.add('is-drop-target');
                });
                rail.addEventListener('drop', event => {
                    const slot = event.target.closest(
                        '[data-sb-panel-slot]'
                    );
                    if (!slot || draggedPanelIndex == null) return;
                    event.preventDefault();
                    const from = draggedPanelIndex;
                    const to = Number(
                        slot.getAttribute('data-sb-panel-slot')
                    );
                    draggedPanelIndex = null;
                    reorderPanels(from, to);
                });
                rail.addEventListener('dragend', () => {
                    draggedPanelIndex = null;
                    rail.querySelectorAll(
                        '.is-dragging, .is-drop-target'
                    ).forEach(element => {
                        element.classList.remove(
                            'is-dragging',
                            'is-drop-target'
                        );
                    });
                });
            }
            hydrateCanvas();
            if (state.busy) {
                host.querySelectorAll(
                    'button, input, textarea, select'
                ).forEach(control => {
                    control.disabled = true;
                });
            } else if (
                candidate()
                && candidate().mediaState === 'loading'
            ) {
                host.querySelectorAll(
                    'button, input, textarea, select'
                ).forEach(control => {
                    const navigationControl = control.matches([
                        '[data-sb-new]',
                        '[data-sb-saved-filter]',
                        '[data-sb-saved-folder]',
                        '[data-sb-load-saved]',
                        '[data-sb-select-candidate]',
                        '[data-sb-delete-candidate]',
                    ].join(','));
                    if (!navigationControl) control.disabled = true;
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
            if (button.hasAttribute('data-sb-folder-new')) {
                state.folderEditorOpen = !state.folderEditorOpen;
                state.folderName = '';
                paint();
                return true;
            }
            if (button.hasAttribute('data-sb-folder-create')) {
                createStoryboardFolder();
                return true;
            }
            if (button.hasAttribute('data-sb-folder-delete')) {
                deleteCurrentFolder();
                return true;
            }
            if (button.hasAttribute('data-sb-panel-move')) {
                const from = Number(
                    button.getAttribute('data-sb-panel-index')
                );
                const delta = Number(
                    button.getAttribute('data-sb-panel-move')
                );
                reorderPanels(from, from + delta);
                return true;
            }
            if (button.hasAttribute('data-sb-panel')) {
                candidate().selectedPanel = Number(button.getAttribute('data-sb-panel')) || 0;
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
                if (state.busy) return true;
                const id = button.getAttribute('data-sb-ref-delete');
                candidate().references = candidate().references.filter(ref => ref.id !== id);
                touchCandidate(candidate());
                paint();
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
            if (button.hasAttribute('data-sb-retry-storyboard')) {
                loadStoryboard(
                    button.getAttribute('data-sb-retry-storyboard')
                );
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
            if (target.hasAttribute('data-sb-folder-name')) {
                state.folderName = String(target.value || '').slice(0, 120);
                return true;
            }
            if (target.hasAttribute('data-sb-brief')) {
                current.brief = String(target.value || '').slice(0, 3000);
                touchCandidate(current);
                return true;
            }
            if (target.hasAttribute('data-sb-hook-text')) {
                current.hookText = String(target.value || '').slice(0, 2000);
                current.transcriptBeatAlignment = [];
                current.transcriptProvenance = null;
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
            if (target.hasAttribute('data-sb-animation-style')) {
                candidate().stylePreset = target.checked
                    ? ANIMATION_STYLE_ID
                    : DEFAULT_STYLE_ID;
                touchCandidate(candidate());
                paint();
                return true;
            }
            if (target.hasAttribute('data-sb-load-saved')) {
                loadStoryboard(target.value);
                return true;
            }
            if (target.hasAttribute('data-sb-saved-folder')) {
                state.savedFolder = target.value || '';
                paint();
                return true;
            }
            if (target.hasAttribute('data-sb-current-folder')) {
                moveCurrentFolder(target.value || null);
                return true;
            }
            return false;
        }

        function handleKeyDown(event) {
            if (!event.target.closest || !event.target.closest('[data-storyboard-workbench]')) return false;
            if (
                event.target.hasAttribute('data-sb-folder-name')
                && event.key === 'Enter'
            ) {
                event.preventDefault();
                createStoryboardFolder();
                return true;
            }
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
            importOpening,
            importSavedHook: importOpening,
            reorderPanels,
            getState: () => state,
        };
    }

    window.JarvisStoryboardWorkbench = Object.freeze({
        create,
        DEFAULT_IMAGE_MODEL: DEFAULT_MODEL,
        IMAGE_MODELS: PUBLIC_IMAGE_MODELS,
        SHEET_IMAGE_MODELS: PUBLIC_SHEET_IMAGE_MODELS,
    });
}());
