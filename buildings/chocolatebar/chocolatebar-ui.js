/* ── Chocolate Bar UI ── BusinessWorld Dark Aesthetic ── */
const ChocolateBarUI = (() => {
    let container = null;
    let activeTab = 'overview';
    let editingTaskId = null;
    let notesSaveTimer = null;

    const STORAGE_KEY = 'chocolatebar-data';

    const CATEGORIES = ['fulfillment', 'distribution', 'marketing', 'retail', 'other'];
    const PRIORITIES = ['high', 'medium', 'low'];
    const STATUSES = ['todo', 'in-progress', 'done'];

    const CATEGORY_ICONS = {
        fulfillment: '\u{1F4E6}', distribution: '\u{1F6E3}', marketing: '\u{1F4E3}',
        retail: '\u{1F6D2}', other: '\u{2699}'
    };

    const TAB_ICONS = {
        overview: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        tasks:    '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>',
        distribution: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
        notes:    '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
    };

    const TABS = [
        { id: 'overview', label: 'Overview' },
        { id: 'tasks', label: 'Tasks' },
        { id: 'distribution', label: 'Channels' },
        { id: 'notes', label: 'Notes' }
    ];

    const DEFAULT_TASKS = [
        // ── FULFILLMENT: Research Complete ──
        { id: 't1', title: 'Research 3PL fulfillment centers', description: 'DONE: Researched ShipBob, ShipMonk, Pirate Ship, Amazon FBA. See chocolate_research_results.md', category: 'fulfillment', priority: 'high', status: 'done' },
        { id: 't2', title: 'Get quotes from ShipBob, Ware2Go, ShipMonk', description: 'DONE: ShipBob $7.40-$12.40/order (400+ min), ShipMonk $6.15-$7.15/order ($250/mo min)', category: 'fulfillment', priority: 'high', status: 'done' },
        { id: 't3', title: 'Test poly mailer vs box', description: 'Reduce dimensional weight billing. Poly bubble mailers $0.10-$0.15/ea vs box. Saves ~$5/order', category: 'fulfillment', priority: 'high', status: 'todo' },

        // ── FULFILLMENT: Pirate Ship Self-Fulfill (BEST OPTION - $3.70-$5.35/order) ──
        { id: 't18', title: 'Sign up for Pirate Ship (FREE)', description: 'pirateship.com - Free shipping platform. USPS Ground Advantage 8oz: ~$3.50-$4.50 (commercial rate). No monthly fees, no markup. Best path to $6 target.', category: 'fulfillment', priority: 'high', status: 'todo' },
        { id: 't19', title: 'Order poly bubble mailers in bulk', description: 'Buy 6x9 or 6x10 poly bubble mailers. ~$0.10-$0.15/ea in bulk (500+ qty). Amazon or Uline. Fits 6x4x1 chocolate bar perfectly.', category: 'fulfillment', priority: 'high', status: 'todo' },
        { id: 't20', title: 'Test Pirate Ship USPS Ground Advantage from TX 75001', description: 'Ship test orders via USPS Ground Advantage. Expected: $3.50-$4.25/label (zones 1-4), $4.50-$6.00 (zones 5-8). 2-5 day delivery.', category: 'fulfillment', priority: 'high', status: 'todo' },
        { id: 't21', title: 'Compare Pirate Ship UPS rates', description: 'Pirate Ship also offers up to 85% off UPS Daily Rates. For 0.5 lb: est ~$5.50-$8.00. USPS likely cheaper for this weight.', category: 'fulfillment', priority: 'medium', status: 'todo' },

        // ── FULFILLMENT: ShipBob (Backup - higher volume) ──
        { id: 't4', title: 'Contact ShipBob for quote (backup option)', description: 'shipbob.com - $975 setup, $275/mo min, 400 orders/mo min. Pick: $0.30/unit. Shipping markup 15-30%. Est $7.40-$12.40/order at low volume. Only viable at 400+/mo.', category: 'fulfillment', priority: 'low', status: 'todo' },

        // ── FULFILLMENT: ShipMonk (Scale option) ──
        { id: 't5', title: 'Contact ShipMonk when ready to scale', description: 'shipmonk.com - $2.50/order pick + $0.50/additional item. $250/mo min. Packaging $0.15-$2/order. Storage $1-$4/bin/mo. Est $6.15-$7.15/order. Volume discounts to $1.80/pick at 500+/mo.', category: 'fulfillment', priority: 'medium', status: 'todo' },

        // ── FULFILLMENT: Packaging ──
        { id: 't6', title: 'Switch from box to poly bubble mailer', description: 'KEY SAVINGS: Poly mailers $0.10-$0.15 vs boxes $0.50-$1.00+. Reduces dim weight. Combined with Pirate Ship = $3.70-$5.35/order total (down from $17).', category: 'fulfillment', priority: 'high', status: 'todo' },
        { id: 't7', title: 'Research Shopify Fulfillment Network', description: 'Free if on Shopify. Integrated. Good for <500 orders/month', category: 'fulfillment', priority: 'medium', status: 'todo' },

        // ── DISTRIBUTION: Amazon FBA ──
        { id: 't8', title: 'Apply to Amazon FBA Canada', description: 'amazon.ca seller central. FBA fulfillment ~$6 CAD/unit. Huge discovery traffic. Apply at sellercentral.amazon.ca', category: 'distribution', priority: 'high', status: 'todo' },
        { id: 't9', title: 'Apply to Amazon FBA US', description: 'Amazon.com FBA 2026 fees: $3.06 (up to 6oz), $3.15 (6-12oz). Total ~$3.47/unit w/ inbound. BUT 15% referral fee on sale price. Need FDA food facility registration.', category: 'distribution', priority: 'high', status: 'todo' },
        { id: 't10', title: 'Email 20 specialty grocery/health food retailers', description: 'Pitch wholesale partnerships', category: 'distribution', priority: 'medium', status: 'todo' },
        { id: 't11', title: 'Research Faire wholesale marketplace', description: 'faire.com - apply as maker. 15% commission but access to 500k+ retailers. Good for specialty food', category: 'distribution', priority: 'medium', status: 'todo' },
        { id: 't12', title: 'Setup subscription box partnerships', description: 'Candy Club, Cocoa Runners, Universal Yums, Love With Food. Email for wholesale inquiry', category: 'distribution', priority: 'medium', status: 'todo' },

        // ── MARKETING ──
        { id: 't13', title: 'Set up email marketing', description: 'Repeat customer retention campaigns', category: 'marketing', priority: 'medium', status: 'todo' },
        { id: 't14', title: 'Create sell sheet PDF for retail pitches', description: 'One-page: product photos, price points, margins, certifications, contact info', category: 'marketing', priority: 'high', status: 'todo' },

        // ── RETAIL ──
        { id: 't15', title: 'Email pitch to Whole Foods Market Canada', description: 'Local Producer Program. Email: wholefoods.ca/supplier. Attach sell sheet + ingredient list', category: 'retail', priority: 'medium', status: 'todo' },
        { id: 't16', title: 'Contact Organic Garage, local stores', description: 'In-store retail placement', category: 'retail', priority: 'medium', status: 'todo' },
        { id: 't17', title: 'Research specialty candy/chocolate subscription boxes', description: 'Candy Club, Cocoa Runners, etc.', category: 'retail', priority: 'low', status: 'todo' }
    ];

    const DEFAULT_CHANNELS = [
        { id: 'ch1', name: 'Shopify Store', icon: '\u{1F6D2}', status: 'active', note: 'Primary DTC channel' },
        { id: 'ch2', name: 'Amazon.ca', icon: '\u{1F4E6}', status: 'planned', note: 'FBA enrollment pending' },
        { id: 'ch3', name: 'Amazon.com', icon: '\u{1F4E6}', status: 'planned', note: 'FBA enrollment pending' },
        { id: 'ch4', name: 'Faire Wholesale', icon: '\u{1F3EA}', status: 'research', note: 'Marketplace for indie retailers' },
        { id: 'ch5', name: 'Retail / Grocery', icon: '\u{1F3EC}', status: 'research', note: 'Whole Foods, health food stores' },
        { id: 'ch6', name: 'Wholesale Direct', icon: '\u{1F4CB}', status: 'planned', note: 'Direct wholesale to specialty shops' }
    ];

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function genId() { return 't' + Date.now() + Math.random().toString(36).slice(2, 6); }

    function loadData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) { /* ignore */ }
        return null;
    }

    function saveData(data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    function getData() {
        let data = loadData();
        if (!data) {
            data = {
                tasks: DEFAULT_TASKS,
                channels: DEFAULT_CHANNELS,
                notes: '',
                stats: { monthlyRevenue: '--', avgOrderValue: '--', fulfillmentCost: '$17' }
            };
            saveData(data);
        }
        return data;
    }

    function showToast(msg) {
        const t = document.createElement('div');
        t.className = 'choc-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2200);
    }

    /* ── Render ── */
    function render() {
        const data = getData();
        return `
            <div class="choc-panel">
                <div class="choc-header">
                    <div>
                        <h2 class="choc-header-title">\u{1F36B} Chocolate Bar</h2>
                        <div class="choc-header-subtitle">Business Operations</div>
                    </div>
                </div>
                <div class="choc-tabs">
                    ${TABS.map(t => `
                        <button class="choc-tab${activeTab === t.id ? ' active' : ''}" data-tab="${t.id}">
                            ${TAB_ICONS[t.id]}
                            ${t.label}
                        </button>
                    `).join('')}
                </div>
                <div class="choc-tab-content" id="choc-content">
                    ${renderTab(data)}
                </div>
            </div>`;
    }

    function renderTab(data) {
        switch (activeTab) {
            case 'overview': return renderOverview(data);
            case 'tasks': return renderTasks(data);
            case 'distribution': return renderDistribution(data);
            case 'notes': return renderNotes(data);
            default: return '';
        }
    }

    /* ── Overview Tab ── */
    function renderOverview(data) {
        const tasks = data.tasks || [];
        const high = tasks.filter(t => t.priority === 'high' && t.status !== 'done').length;
        const medium = tasks.filter(t => t.priority === 'medium' && t.status !== 'done').length;
        const low = tasks.filter(t => t.priority === 'low' && t.status !== 'done').length;
        const done = tasks.filter(t => t.status === 'done').length;
        const total = tasks.length;

        const currentCost = parseFloat((data.stats.fulfillmentCost || '$17').replace('$', '')) || 17;
        const targetCost = 6;
        const maxCost = 17;
        const progress = Math.max(0, Math.min(100, ((maxCost - currentCost) / (maxCost - targetCost)) * 100));

        return `
            <div class="choc-card">
                <div class="choc-card-title">\u{1F3AF} Fulfillment Cost Target</div>
                <div class="choc-progress-wrap">
                    <div class="choc-progress-label">
                        <span>Current: ${esc(data.stats.fulfillmentCost)}</span>
                        <span>Target: $6 USD</span>
                    </div>
                    <div class="choc-progress-bar">
                        <div class="choc-progress-fill" style="width:${progress}%"></div>
                    </div>
                </div>
            </div>

            <div class="choc-metrics">
                <div class="choc-metric">
                    <div class="choc-metric-value editable" data-stat="monthlyRevenue">${esc(data.stats.monthlyRevenue)}</div>
                    <div class="choc-metric-label">Monthly Revenue</div>
                </div>
                <div class="choc-metric">
                    <div class="choc-metric-value editable" data-stat="avgOrderValue">${esc(data.stats.avgOrderValue)}</div>
                    <div class="choc-metric-label">Avg Order Value</div>
                </div>
                <div class="choc-metric">
                    <div class="choc-metric-value editable" data-stat="fulfillmentCost">${esc(data.stats.fulfillmentCost)}</div>
                    <div class="choc-metric-label">Fulfillment Cost</div>
                </div>
                <div class="choc-metric">
                    <div class="choc-metric-value">${done}/${total}</div>
                    <div class="choc-metric-label">Tasks Done</div>
                </div>
            </div>

            <div class="choc-card">
                <div class="choc-card-title">\u{1F4CB} Open Tasks by Priority</div>
                <div style="display:flex;gap:16px;margin-top:8px;">
                    <div><span class="choc-badge choc-badge-high">${high} high</span></div>
                    <div><span class="choc-badge choc-badge-medium">${medium} medium</span></div>
                    <div><span class="choc-badge choc-badge-low">${low} low</span></div>
                </div>
            </div>

            <div class="choc-card">
                <div class="choc-card-title">\u{1F6E3} Active Channels</div>
                <div style="margin-top:8px;font-size:13px;">
                    ${(data.channels || []).map(ch => `
                        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
                            <span>${ch.icon}</span>
                            <span style="color:var(--choc-text);flex:1">${esc(ch.name)}</span>
                            <span class="choc-channel-badge choc-channel-${ch.status}">${ch.status}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
    }

    /* ── Tasks Tab ── */
    function renderTasks(data) {
        const tasks = data.tasks || [];
        const grouped = {};
        CATEGORIES.forEach(c => { grouped[c] = tasks.filter(t => t.category === c); });

        let html = `<button class="choc-add-btn" id="choc-add-task">\u{2795} Add Task</button>`;

        CATEGORIES.forEach(cat => {
            const catTasks = grouped[cat];
            if (!catTasks || catTasks.length === 0) return;
            html += `
                <div class="choc-task-group">
                    <div class="choc-task-group-title">${CATEGORY_ICONS[cat] || ''} ${cat}</div>
                    ${catTasks.map(t => renderTask(t)).join('')}
                </div>`;
        });

        return html;
    }

    function renderTask(t) {
        return `
            <div class="choc-task${t.status === 'done' ? ' done' : ''}" data-id="${t.id}">
                <div class="choc-task-body">
                    <div class="choc-task-title">${esc(t.title)}</div>
                    ${t.description ? `<div class="choc-task-desc">${esc(t.description)}</div>` : ''}
                    <div class="choc-task-meta">
                        <span class="choc-badge choc-badge-${t.priority}">${t.priority}</span>
                        <span class="choc-badge choc-badge-status">${t.status}</span>
                    </div>
                </div>
                <div class="choc-task-actions">
                    <button class="choc-task-btn complete-btn" data-action="complete" data-id="${t.id}" title="${t.status === 'done' ? 'Reopen' : 'Complete'}">${t.status === 'done' ? '\u21A9' : '\u2713'}</button>
                    <button class="choc-task-btn" data-action="edit" data-id="${t.id}" title="Edit">\u270E</button>
                    <button class="choc-task-btn delete-btn" data-action="delete" data-id="${t.id}" title="Delete">\u2715</button>
                </div>
            </div>`;
    }

    /* ── Distribution Tab ── */
    function renderDistribution(data) {
        const channels = data.channels || [];
        return channels.map(ch => `
            <div class="choc-channel">
                <div class="choc-channel-icon" style="background:rgba(212,145,92,0.15);">${ch.icon}</div>
                <div class="choc-channel-info">
                    <div class="choc-channel-name">${esc(ch.name)}</div>
                    <div class="choc-channel-status">${esc(ch.note)}</div>
                </div>
                <span class="choc-channel-badge choc-channel-${ch.status}">${ch.status}</span>
            </div>
        `).join('');
    }

    /* ── Notes Tab ── */
    function renderNotes(data) {
        return `
            <textarea class="choc-notes-area" id="choc-notes" placeholder="Write notes about the chocolate bar business...">${esc(data.notes || '')}</textarea>
            <div class="choc-notes-saved" id="choc-notes-saved">Saved</div>`;
    }

    /* ── Task Modal ── */
    function showTaskModal(task) {
        const isEdit = !!task;
        const t = task || { title: '', description: '', category: 'fulfillment', priority: 'medium', status: 'todo' };

        const overlay = document.createElement('div');
        overlay.className = 'choc-modal-overlay';
        overlay.id = 'choc-task-modal';
        overlay.innerHTML = `
            <div class="choc-modal" onclick="event.stopPropagation()">
                <h3>${isEdit ? 'Edit Task' : 'New Task'}</h3>
                <div class="choc-form-group">
                    <label class="choc-form-label">Title</label>
                    <input class="choc-input" id="choc-f-title" value="${esc(t.title)}" placeholder="Task title...">
                </div>
                <div class="choc-form-group">
                    <label class="choc-form-label">Description</label>
                    <textarea class="choc-textarea" id="choc-f-desc" placeholder="Details...">${esc(t.description || '')}</textarea>
                </div>
                <div style="display:flex;gap:10px;">
                    <div class="choc-form-group" style="flex:1">
                        <label class="choc-form-label">Category</label>
                        <select class="choc-select" id="choc-f-cat">
                            ${CATEGORIES.map(c => `<option value="${c}"${t.category === c ? ' selected' : ''}>${c}</option>`).join('')}
                        </select>
                    </div>
                    <div class="choc-form-group" style="flex:1">
                        <label class="choc-form-label">Priority</label>
                        <select class="choc-select" id="choc-f-pri">
                            ${PRIORITIES.map(p => `<option value="${p}"${t.priority === p ? ' selected' : ''}>${p}</option>`).join('')}
                        </select>
                    </div>
                </div>
                ${isEdit ? `
                <div class="choc-form-group">
                    <label class="choc-form-label">Status</label>
                    <select class="choc-select" id="choc-f-status">
                        ${STATUSES.map(s => `<option value="${s}"${t.status === s ? ' selected' : ''}>${s}</option>`).join('')}
                    </select>
                </div>` : ''}
                <div class="choc-modal-actions">
                    <button class="choc-btn choc-btn-secondary" id="choc-modal-cancel">Cancel</button>
                    <button class="choc-btn choc-btn-primary" id="choc-modal-save">${isEdit ? 'Save' : 'Add Task'}</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        overlay.querySelector('#choc-modal-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#choc-modal-save').addEventListener('click', () => {
            const title = overlay.querySelector('#choc-f-title').value.trim();
            if (!title) { showToast('Title is required'); return; }

            const data = getData();
            const taskData = {
                title,
                description: overlay.querySelector('#choc-f-desc').value.trim(),
                category: overlay.querySelector('#choc-f-cat').value,
                priority: overlay.querySelector('#choc-f-pri').value,
                status: isEdit ? (overlay.querySelector('#choc-f-status')?.value || t.status) : 'todo'
            };

            if (isEdit) {
                const idx = data.tasks.findIndex(x => x.id === t.id);
                if (idx !== -1) Object.assign(data.tasks[idx], taskData);
            } else {
                data.tasks.push({ id: genId(), ...taskData });
            }

            saveData(data);
            overlay.remove();
            refresh();
            showToast(isEdit ? 'Task updated' : 'Task added');
        });

        setTimeout(() => overlay.querySelector('#choc-f-title').focus(), 100);
    }

    /* ── Event Binding ── */
    function bindEvents() {
        if (!container) return;

        // Tab switching
        container.addEventListener('click', (e) => {
            const tab = e.target.closest('.choc-tab');
            if (tab) {
                activeTab = tab.dataset.tab;
                refresh();
                return;
            }

            // Add task button
            if (e.target.closest('#choc-add-task')) {
                showTaskModal(null);
                return;
            }

            // Task actions
            const actionBtn = e.target.closest('[data-action]');
            if (actionBtn) {
                const action = actionBtn.dataset.action;
                const id = actionBtn.dataset.id;
                const data = getData();
                const idx = data.tasks.findIndex(t => t.id === id);
                if (idx === -1) return;

                if (action === 'complete') {
                    data.tasks[idx].status = data.tasks[idx].status === 'done' ? 'todo' : 'done';
                    saveData(data);
                    refresh();
                    showToast(data.tasks[idx].status === 'done' ? 'Task completed!' : 'Task reopened');
                } else if (action === 'edit') {
                    showTaskModal(data.tasks[idx]);
                } else if (action === 'delete') {
                    data.tasks.splice(idx, 1);
                    saveData(data);
                    refresh();
                    showToast('Task deleted');
                }
                return;
            }

            // Editable stats
            const editable = e.target.closest('.editable');
            if (editable) {
                const stat = editable.dataset.stat;
                const data = getData();
                const current = data.stats[stat] || '';
                const val = prompt('Enter new value:', current);
                if (val !== null) {
                    data.stats[stat] = val;
                    saveData(data);
                    refresh();
                }
                return;
            }
        });

        // Notes auto-save
        container.addEventListener('input', (e) => {
            if (e.target.id === 'choc-notes') {
                clearTimeout(notesSaveTimer);
                notesSaveTimer = setTimeout(() => {
                    const data = getData();
                    data.notes = e.target.value;
                    saveData(data);
                    const saved = container.querySelector('#choc-notes-saved');
                    if (saved) {
                        saved.classList.add('visible');
                        setTimeout(() => saved.classList.remove('visible'), 1500);
                    }
                }, 500);
            }
        });
    }

    function refresh() {
        if (!container) return;
        container.innerHTML = render();
        bindEvents();
    }

    /* ── Public API ── */
    return {
        open(bodyEl, opts) {
            container = bodyEl;
            container.innerHTML = render();
            bindEvents();
        },
        close() {
            clearTimeout(notesSaveTimer);
            const modal = document.getElementById('choc-task-modal');
            if (modal) modal.remove();
            container = null;
            activeTab = 'overview';
            editingTaskId = null;
        }
    };
})();

window.ChocolateBarUI = { open: (c, o) => ChocolateBarUI.open(c, o), close: () => ChocolateBarUI.close() };

BuildingRegistry.register('Chocolate Bar', {
    open: (bodyEl, opts) => ChocolateBarUI.open(bodyEl, opts),
    close: () => ChocolateBarUI.close()
});
