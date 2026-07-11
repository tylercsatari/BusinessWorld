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
                        ${isOwner() ? '<button class="employee-letter-btn" id="employee-letter-btn" title="Generate a signed employment verification letter (PDF)">📄 Employment Letter</button>' : ''}
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
        const letterBtn = document.getElementById('employee-letter-btn');
        if (letterBtn) letterBtn.addEventListener('click', openLetterModal);
        // "+ New Employee" removed — the roster IS the real accounts (name · profile · colour).
    }

    function isOwner() { return !!(window.__access && window.__access.all === true); }

    // ── Employment verification letter (owner-only) ──
    // Fill the details, draw your signature on the pad, Generate → the server
    // renders a Centrality LTD letterhead PDF (same pdfkit engine as invoices),
    // opens it for preview and downloads it.
    function openLetterModal() {
        document.getElementById('employee-letter-overlay')?.remove();
        const ov = document.createElement('div');
        ov.id = 'employee-letter-overlay';
        ov.className = 'employee-letter-overlay';
        ov.innerHTML = `
            <div class="employee-letter-card">
                <div class="employee-letter-head">
                    <div class="employee-letter-title">📄 Employment Verification Letter</div>
                    <button class="employee-letter-x" id="emp-letter-close" title="Close">✕</button>
                </div>
                <div class="employee-letter-grid">
                    <label>Employee name<input type="text" id="emp-l-name" value="Rita-Jeanne Smith"></label>
                    <label>Job title<input type="text" id="emp-l-title" value="Fabrication Assistant"></label>
                    <label>Start date<input type="date" id="emp-l-start" value="2026-05-12"></label>
                    <label>Position type<select id="emp-l-type">
                        <option value="permanent, full-time" selected>Permanent, full-time</option>
                        <option value="permanent, part-time">Permanent, part-time</option>
                        <option value="casual">Casual / as-needed</option>
                    </select></label>
                    <label>Hourly rate (CAD)<input type="number" id="emp-l-rate" value="20" min="0" step="0.25"></label>
                    <label>Avg hours / week<input type="number" id="emp-l-hours" value="40" min="0" step="1"></label>
                    <label>Pronoun<select id="emp-l-pronoun">
                        <option selected>She</option><option>He</option><option>They</option>
                    </select></label>
                    <label class="employee-letter-check"><input type="checkbox" id="emp-l-vouch" checked> Include "reliable and valued member of our team"</label>
                </div>
                <div class="employee-letter-sig-label">Signature — draw with your mouse or finger <button class="employee-letter-clear" id="emp-l-clear">Clear</button></div>
                <canvas id="emp-l-sig" class="employee-letter-sig" width="920" height="280"></canvas>
                <div class="employee-letter-actions">
                    <button class="employee-letter-generate" id="emp-l-generate">Generate signed PDF</button>
                    <span class="employee-letter-status" id="emp-l-status"></span>
                </div>
            </div>`;
        document.body.appendChild(ov);
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
        document.getElementById('emp-letter-close').addEventListener('click', () => ov.remove());

        // Signature pad — canvas is 2x its CSS size for crisp strokes
        const cv = document.getElementById('emp-l-sig');
        const ctx = cv.getContext('2d');
        ctx.lineWidth = 4.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1b2a52';
        let drawing = false, drawn = false;
        const pos = (e) => {
            const r = cv.getBoundingClientRect();
            return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
        };
        cv.addEventListener('pointerdown', (e) => { drawing = true; drawn = true; cv.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); });
        cv.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); });
        const stop = () => { drawing = false; };
        cv.addEventListener('pointerup', stop); cv.addEventListener('pointercancel', stop);
        document.getElementById('emp-l-clear').addEventListener('click', () => { ctx.clearRect(0, 0, cv.width, cv.height); drawn = false; });

        // Export just the drawn strokes (+padding), not the whole pad — a small
        // signature in one corner still comes out full-size in the PDF.
        const cropSignature = () => {
            const { width, height } = cv;
            const data = ctx.getImageData(0, 0, width, height).data;
            let minX = width, minY = height, maxX = -1, maxY = -1;
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                if (data[(y * width + x) * 4 + 3] > 10) {
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
            }
            if (maxX < 0) return null;
            const pad = 10;
            minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
            maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
            const out = document.createElement('canvas');
            out.width = maxX - minX + 1; out.height = maxY - minY + 1;
            out.getContext('2d').drawImage(cv, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
            return out.toDataURL('image/png');
        };

        document.getElementById('emp-l-generate').addEventListener('click', async () => {
            const btn = document.getElementById('emp-l-generate');
            const status = document.getElementById('emp-l-status');
            const nameV = document.getElementById('emp-l-name').value.trim();
            const startRaw = document.getElementById('emp-l-start').value;
            if (!nameV || !startRaw) { alert('Employee name and start date are required.'); return; }
            const startLong = new Date(startRaw + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
            btn.disabled = true; status.textContent = 'Generating…';
            try {
                const res = await fetch('/api/employee/letter', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        employeeName: nameV,
                        employeeTitle: document.getElementById('emp-l-title').value.trim(),
                        startDate: startLong,
                        positionType: document.getElementById('emp-l-type').value,
                        hourlyRate: parseFloat(document.getElementById('emp-l-rate').value) || 0,
                        hoursPerWeek: parseFloat(document.getElementById('emp-l-hours').value) || 0,
                        pronoun: document.getElementById('emp-l-pronoun').value,
                        includeVouch: document.getElementById('emp-l-vouch').checked,
                        signaturePng: drawn ? cropSignature() : null
                    })
                });
                if (!res.ok) { let j = null; try { j = await res.json(); } catch (e) {} throw new Error((j && j.error) || ('HTTP ' + res.status)); }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                window.open(url, '_blank');                       // preview in the browser's PDF viewer
                const a = document.createElement('a');
                a.href = url; a.download = `Employment Letter - ${nameV}.pdf`;
                document.body.appendChild(a); a.click(); a.remove();
                status.textContent = '✓ PDF ready — opened in a new tab and downloaded';
            } catch (e) {
                status.textContent = '';
                alert('Could not generate the letter: ' + e.message);
            }
            btn.disabled = false;
        });
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
