/**
 * ScriptLinker — shared script picker/link/unlink/create UI for any building.
 * Replaces ~60 lines of duplicated linker code in each building with ~5 lines.
 *
 * Usage in a building's renderDetail():
 *   ${ScriptLinker.renderLinker({ prefix: 'workshop', linkedScriptId: v.linkedScriptId })}
 *   ${ScriptLinker.renderPickerOverlay('workshop')}
 *
 * After DOM insert:
 *   ScriptLinker.bindEvents({
 *       prefix: 'workshop',
 *       getTarget: () => selectedVideo,
 *       isIdea: false,
 *       onRefresh: () => { selectedVideo = VideoService.getById(selectedVideo.id); renderDetail(); }
 *   });
 */
const ScriptLinker = (() => {
    const escHtml = NotionHelpers.escHtml;
    const escAttr = NotionHelpers.escAttr;

    return {
        /**
         * Render the script linker section HTML.
         * If linked, shows inline editor (via EggRenderer) or badge + unlink.
         * If not linked, shows Link + New buttons.
         */
        renderLinker({ prefix, linkedScriptId, useInlineEditor }) {
            if (linkedScriptId) {
                const scripts = ScriptService.getAll();
                const linked = scripts.find(s => s.id === linkedScriptId);
                const name = linked ? linked.title : 'Linked Script';
                if (useInlineEditor !== false && window.EggRenderer) {
                    return window.EggRenderer.inlineScriptEditorHtml(`${prefix}-inline-script`, name);
                }
                return `<div class="${prefix}-script-linked">
                    <span class="${prefix}-script-badge">${escHtml(name)}</span>
                    <button class="${prefix}-script-unlink" id="${prefix}-unlink-script">Unlink</button>
                </div>`;
            }
            return `<div class="${prefix}-script-actions">
                <button class="${prefix}-script-btn" id="${prefix}-link-script">Link Script</button>
                <button class="${prefix}-script-btn primary" id="${prefix}-new-script">New Script</button>
            </div>`;
        },

        /**
         * Render the picker overlay HTML.
         */
        renderPickerOverlay(prefix) {
            return `<div class="${prefix}-picker-overlay" id="${prefix}-script-picker-overlay" style="display:none;">
                <div class="${prefix}-picker">
                    <div class="${prefix}-picker-header">
                        <h3>Link a Script</h3>
                        <button class="${prefix}-picker-close" id="${prefix}-script-picker-close">&times;</button>
                    </div>
                    <div class="${prefix}-picker-list" id="${prefix}-script-picker-list"></div>
                </div>
            </div>`;
        },

        /**
         * Bind all script linker event handlers.
         * @param {string} prefix - CSS class/ID prefix (e.g. 'workshop', 'pen', 'incubator')
         * @param {Function} getTarget - Returns the current idea/video object
         * @param {boolean} isIdea - true for ideas, false for videos
         * @param {Function} onRefresh - Called after link/unlink/create to re-render
         * @param {boolean} isDraft - If true, block linking (save first)
         */
        bindEvents({ prefix, getTarget, isIdea, onRefresh, isDraft }) {
            const target = getTarget();
            if (!target) return;

            // Inline script editor (when linked)
            if (target.linkedScriptId && window.EggRenderer) {
                window.EggRenderer.initInlineScriptEditor(
                    `${prefix}-inline-script`,
                    target.linkedScriptId,
                    () => doUnlink()
                );
            } else {
                // Fallback unlink button
                const unlinkBtn = document.getElementById(`${prefix}-unlink-script`);
                if (unlinkBtn) unlinkBtn.addEventListener('click', () => doUnlink());
            }

            // Link button
            const linkBtn = document.getElementById(`${prefix}-link-script`);
            if (linkBtn) linkBtn.addEventListener('click', () => showPicker());

            // New script button
            const newBtn = document.getElementById(`${prefix}-new-script`);
            if (newBtn) newBtn.addEventListener('click', () => createNew());

            // Picker close
            const pickerClose = document.getElementById(`${prefix}-script-picker-close`);
            if (pickerClose) pickerClose.addEventListener('click', () => hidePicker());
            const pickerOverlay = document.getElementById(`${prefix}-script-picker-overlay`);
            if (pickerOverlay) pickerOverlay.addEventListener('click', (e) => {
                if (e.target === e.currentTarget) hidePicker();
            });

            function hidePicker() {
                const overlay = document.getElementById(`${prefix}-script-picker-overlay`);
                if (overlay) overlay.style.display = 'none';
            }

            async function showPicker() {
                const overlay = document.getElementById(`${prefix}-script-picker-overlay`);
                const listEl = document.getElementById(`${prefix}-script-picker-list`);
                if (!overlay || !listEl) return;

                await ScriptService.sync();
                const allScripts = ScriptService.getAll();
                const t = getTarget();
                const linkedIds = LinkService.getLinkedScriptIds(t ? t.linkedScriptId : '');
                const available = allScripts.filter(s => !linkedIds.has(s.id));

                if (available.length === 0) {
                    listEl.innerHTML = `<div class="${prefix}-picker-empty">No available scripts. Create one with "New Script".</div>`;
                } else {
                    listEl.innerHTML = available.map(s => `
                        <div class="${prefix}-picker-item" data-id="${s.id}">
                            <div class="${prefix}-picker-name">${escHtml(s.title)}</div>
                            <button class="${prefix}-picker-link-btn" data-id="${s.id}">Link</button>
                        </div>`).join('');
                    listEl.querySelectorAll(`.${prefix}-picker-link-btn`).forEach(btn => {
                        btn.addEventListener('click', (e) => { e.stopPropagation(); doLink(btn.dataset.id); });
                    });
                    listEl.querySelectorAll(`.${prefix}-picker-item`).forEach(item => {
                        item.addEventListener('click', () => doLink(item.dataset.id));
                    });
                }
                overlay.style.display = 'flex';
            }

            async function doLink(scriptId) {
                const t = getTarget();
                if (!t) return;
                const btn = document.querySelector(`.${prefix}-picker-link-btn[data-id="${scriptId}"]`);
                if (navigator.vibrate) navigator.vibrate(30);
                if (btn) { btn.textContent = 'Linking...'; btn.disabled = true; }
                try {
                    if (isIdea) {
                        await LinkService.linkScriptToIdea(scriptId, t.id);
                    } else {
                        await LinkService.linkScriptToVideo(scriptId, t.id);
                    }
                    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
                    hidePicker();
                    onRefresh();
                } catch (e) {
                    console.warn(`${prefix}: link script failed`, e);
                    alert('Failed to link script.');
                    if (btn) { btn.textContent = 'Link'; btn.disabled = false; }
                }
            }

            async function doUnlink() {
                const t = getTarget();
                if (!t) return;
                if (navigator.vibrate) navigator.vibrate(30);
                try {
                    if (isIdea) {
                        await LinkService.unlinkFromIdea(t.id);
                    } else {
                        await LinkService.unlinkFromVideo(t.id);
                    }
                    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
                    onRefresh();
                } catch (e) {
                    console.warn(`${prefix}: unlink script failed`, e);
                    alert('Failed to unlink script.');
                }
            }

            async function createNew() {
                if (isDraft) {
                    alert('Save the video first before creating a script.');
                    return;
                }
                const t = getTarget();
                if (!t) return;
                const btn = document.getElementById(`${prefix}-new-script`);
                if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }
                try {
                    const script = await ScriptService.create(t.name || 'Untitled', t.project || '');
                    if (isIdea) {
                        await LinkService.linkScriptToIdea(script.id, t.id);
                    } else {
                        await LinkService.linkScriptToVideo(script.id, t.id);
                    }
                    onRefresh();
                } catch (e) {
                    console.warn(`${prefix}: create script failed`, e);
                    alert('Failed to create script.');
                } finally {
                    if (btn) { btn.textContent = 'New Script'; btn.disabled = false; }
                }
            }
        }
    };
})();
