/**
 * Employee Island UI — roster management panel.
 * List of all employees (physical + digital) with avatar, name, role.
 * Select an employee to open the character-card editor.
 * "Add Employee" creates digital-only roster entries (no 3D spawn).
 */
const EmployeeUI = (() => {
    let container = null;
    let selectedId = null;
    let search = '';

    const escHtml = HtmlUtils.escHtml;
    const escAttr = HtmlUtils.escAttr;

    function render() {
        container.innerHTML = `
            <div class="employee-panel show-list">
                <div class="employee-page employee-list-page">
                    <div class="employee-header">
                        <h2>Employee Island</h2>
                        <span class="employee-count" id="employee-count"></span>
                    </div>
                    <div class="employee-toolbar">
                        <input type="text" class="employee-search" id="employee-search" placeholder="Search accounts...">
                    </div>
                    <div class="employee-grid" id="employee-grid"></div>
                </div>
                <div class="employee-page employee-detail-page">
                    <div class="employee-detail" id="employee-detail"></div>
                </div>
            </div>
        `;
        document.getElementById('employee-search').addEventListener('input', (e) => {
            search = e.target.value.toLowerCase();
            renderGrid();
        });
        // "+ New Employee" removed — the roster IS the real accounts (name · profile · colour).
    }

    function avatarHtml(emp, size) {
        const sz = size || 56;
        return `<canvas class="employee-avatar-canvas" data-worker="${escAttr(emp.name)}" data-color="${escAttr(emp.colorHex || '')}" data-size="${sz}" width="${sz}" height="${sz}"></canvas>`;
    }

    function renderGrid() {
        const el = document.getElementById('employee-grid');
        const countEl = document.getElementById('employee-count');
        if (!el) return;
        const all = EmployeeService.getAll();
        const filtered = search
            ? all.filter(e =>
                e.name.toLowerCase().includes(search) ||
                (e.role || '').toLowerCase().includes(search) ||
                (e.specialty || '').toLowerCase().includes(search) ||
                (e.strengths || '').toLowerCase().includes(search))
            : all;
        if (countEl) countEl.textContent = `${all.length} on roster`;
        if (filtered.length === 0) {
            el.innerHTML = `<div class="employee-empty">No employees match "${escHtml(search)}"</div>`;
            return;
        }
        el.innerHTML = filtered.map(emp => {
            const physicalBadge = emp.physical ? '<span class="employee-chip physical-chip" title="Lives on the map">3D</span>' : '';
            return `
            <div class="employee-card" data-id="${escAttr(emp.id)}">
                <div class="employee-card-avatar">${avatarHtml(emp, 64)}</div>
                <div class="employee-card-info">
                    <div class="employee-card-name">${escHtml(emp.name)} ${physicalBadge}</div>
                    <div class="employee-card-role">${escHtml(emp.role || 'No role set')}</div>
                    ${emp.specialty ? `<div class="employee-card-specialty">${escHtml(emp.specialty)}</div>` : ''}
                </div>
            </div>`;
        }).join('');
        el.querySelectorAll('.employee-card').forEach(card => {
            card.addEventListener('click', () => openDetail(card.dataset.id));
        });
        requestAnimationFrame(renderAvatars);
    }

    function renderAvatars() {
        if (!window.EggRenderer || !container) return;
        container.querySelectorAll('.employee-avatar-canvas').forEach(canvas => {
            // Use data-size (immutable) — canvas.width gets mutated by the renderer
            // to a higher internal resolution, which would compound on each re-render.
            const size = parseInt(canvas.dataset.size, 10) || 48;
            window.EggRenderer.renderCharacterAvatar(canvas.dataset.worker, canvas, Math.round(size / 2), canvas.dataset.color || null);
        });
    }

    function openDetail(id) {
        selectedId = id;
        const panel = container.querySelector('.employee-panel');
        panel.classList.remove('show-list');
        panel.classList.add('show-detail');
        renderDetail();
    }

    function showList() {
        selectedId = null;
        const panel = container.querySelector('.employee-panel');
        panel.classList.remove('show-detail');
        panel.classList.add('show-list');
        renderGrid();
    }

    function addNew() {
        const emp = EmployeeService.add({ name: 'New Employee', role: '' });
        persist();
        openDetail(emp.id);
    }

    function renderDetail() {
        const el = document.getElementById('employee-detail');
        if (!el) return;
        const emp = EmployeeService.getById(selectedId);
        if (!emp) { showList(); return; }

        el.innerHTML = `
            <div class="employee-detail-toolbar">
                <button class="employee-back-btn" id="employee-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Back
                </button>
                ${emp.physical
                    ? '<span class="employee-physical-note">On the map — cannot be deleted</span>'
                    : '<button class="employee-delete-btn" id="employee-delete-btn">Delete</button>'}
            </div>
            <div class="employee-card-editor">
                <div class="employee-card-top">
                    <div class="employee-detail-avatar-wrap">
                        <canvas class="employee-detail-avatar employee-avatar-canvas" data-worker="${escAttr(emp.name)}" data-size="120" width="120" height="120"></canvas>
                        <div class="employee-color-row">
                            <label>Avatar color</label>
                            <input type="color" id="employee-color" value="${escAttr(emp.colorHex || '#888888')}">
                        </div>
                    </div>
                    <div class="employee-detail-basics">
                        <label>Name</label>
                        <input type="text" id="employee-name" value="${escAttr(emp.name)}">
                        <label>Role / Title</label>
                        <input type="text" id="employee-role" value="${escAttr(emp.role)}" placeholder="e.g. Editor, Producer, Designer">
                        <label>Specialty / Department</label>
                        <input type="text" id="employee-specialty" value="${escAttr(emp.specialty)}" placeholder="e.g. Post-production, Research">
                    </div>
                </div>

                <label>Short Summary</label>
                <textarea id="employee-summary" placeholder="A one-liner on this person">${escHtml(emp.summary)}</textarea>

                <label>Strengths / Skills <span class="employee-hint">comma separated</span></label>
                <input type="text" id="employee-strengths" value="${escAttr(emp.strengths)}" placeholder="e.g. Premiere, motion graphics, pacing">

                <label>Traits <span class="employee-hint">comma separated</span></label>
                <input type="text" id="employee-traits" value="${escAttr(emp.traits)}" placeholder="e.g. detail-oriented, fast, calm under pressure">

                <label>Notes</label>
                <textarea id="employee-notes" placeholder="Anything else worth remembering">${escHtml(emp.notes)}</textarea>

                <div class="employee-save-row">
                    <span class="employee-save-status" id="employee-save-status">Saved</span>
                </div>
            </div>
        `;

        document.getElementById('employee-back-btn').addEventListener('click', () => { saveDetail(); showList(); });
        const del = document.getElementById('employee-delete-btn');
        if (del) del.addEventListener('click', () => {
            if (!confirm('Delete ' + emp.name + '? Videos assigned to them will keep the name but become unassigned from the roster.')) return;
            EmployeeService.remove(emp.id);
            persist();
            showList();
        });

        // Auto-save debounced on any input change
        const watchIds = ['employee-name','employee-role','employee-specialty','employee-summary','employee-strengths','employee-traits','employee-notes','employee-color'];
        watchIds.forEach(id => {
            const inp = document.getElementById(id);
            if (inp) inp.addEventListener('input', scheduleSave);
        });

        requestAnimationFrame(renderAvatars);
    }

    let saveTimer = null;
    function scheduleSave() {
        const status = document.getElementById('employee-save-status');
        if (status) { status.textContent = 'Saving...'; status.classList.remove('saved'); }
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveDetail(); }, 400);
    }

    function readDetailFields() {
        const emp = EmployeeService.getById(selectedId);
        if (!emp) return null;
        const name = (document.getElementById('employee-name')?.value || '').trim() || emp.name;
        return {
            name,
            role: document.getElementById('employee-role')?.value || '',
            specialty: document.getElementById('employee-specialty')?.value || '',
            summary: document.getElementById('employee-summary')?.value || '',
            strengths: document.getElementById('employee-strengths')?.value || '',
            traits: document.getElementById('employee-traits')?.value || '',
            notes: document.getElementById('employee-notes')?.value || '',
            colorHex: document.getElementById('employee-color')?.value || emp.colorHex,
        };
    }

    function saveDetail() {
        if (!selectedId) return;
        const patch = readDetailFields();
        if (!patch) return;
        const prev = EmployeeService.getById(selectedId);
        const nameChanged = prev && prev.name !== patch.name;
        EmployeeService.update(selectedId, patch);
        persist();
        const status = document.getElementById('employee-save-status');
        if (status) { status.textContent = 'Saved'; status.classList.add('saved'); }
        if (nameChanged) {
            // Re-render avatar with new data-worker
            const avatar = container.querySelector('.employee-detail-avatar');
            if (avatar) avatar.dataset.worker = patch.name;
            requestAnimationFrame(renderAvatars);
        } else {
            // Color may have changed — re-render avatar only
            requestAnimationFrame(renderAvatars);
        }
    }

    function persist() {
        // Trigger layout save so roster is stored server-side
        if (typeof window.saveLayout === 'function') {
            try { window.saveLayout(); } catch (e) { /* ignore */ }
        }
    }

    let _unsub = null;
    return {
        async open(bodyEl) {
            container = bodyEl;
            render();
            renderGrid();
            // refresh live if the account roster updates while the panel is open
            if (_unsub) _unsub();
            _unsub = EmployeeService.subscribe(() => { if (container) renderGrid(); });
        },
        close() {
            if (selectedId) saveDetail();
            if (_unsub) { _unsub(); _unsub = null; }
            container = null;
            selectedId = null;
            search = '';
        }
    };
})();

BuildingRegistry.register('Employee Island', {
    open: (bodyEl) => EmployeeUI.open(bodyEl),
    close: () => EmployeeUI.close()
});
